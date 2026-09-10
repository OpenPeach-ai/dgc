"""Headless JSON backend — `dgc serve`.

A second AgentUI (see ui.py): it serializes the agent's callbacks to NDJSON on stdout and
drives the agent from JSON commands on stdin. stdout carries protocol lines ONLY; anything
human goes to stderr. This is the layer the VS Code / Cursor extension talks to, and the
substrate the ACP adapter will reframe (Phase 4).
"""
from __future__ import annotations

import copy
import json
import math
import re
import sys
import threading
import time
from pathlib import Path

from . import __version__
from . import sessions as sessions_mod
from .agent import Agent
from .attachments import MAX_EDITOR_IMAGE_TOTAL_BYTES, validate_image_data_uris
from .editor_context import _editor_context_json, _format_editor_context, _strip_editor_context
from .commands import (
    custom_command_names, discover_commands, editor_command_metadata, render_command,
)
from .config import Config, mcp_url_has_credentials
from .editor_protocol import (MAX_COMMAND_BYTES, MAX_SAFE_INTEGER, PROTOCOL_VERSION,
                              command_error, event_error)
from .permissions import Rule, rule_for
from .mcp_config import validate_mcp_spec as _mcp_spec, public_mcp_spec
from .protocol import Emitter, PendingRequests, strict_json_loads
from .redaction import redact_value, secret_values
from .hooks import hook_catalog
from .skills import discover_skills, normalize_skill_name, skill_catalog
from .tools import TOOL_SCHEMAS
from .ui import arg_summary, edit_preview, split_diff, tool_output_is_error

_PLAN_MODES = ("auto", "acceptEdits", "default")
_MAX_QUEUED_TURNS = 32
_MAX_QUEUED_TURN_BYTES = 16 * 1024 * 1024
_MAX_PROMPT_CHARS = 1_000_000
_MAX_MCP_ARGUMENT_BYTES = 1024 * 1024
_MAX_MCP_LIST_BYTES = 1024 * 1024
_MAX_MCP_LIST_LIMIT = 100
_MAX_MCP_SERVERS = 64
_MCP_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
_BUSY_MUTATIONS = {
    "set_model", "set_think", "new_session", "clear_session", "resume_session",
    "delete_session", "rewind", "compact", "set_config", "set_workspace_roots", "set_goal", "start_goal",
    "resolve_retained_task", "reload_skills", "set_skill_enabled", "create_skill", "install_skill", "generate_handoff", "name_session",
    "upsert_mcp_server", "remove_mcp_server", "reload_mcp_servers", "set_mcp_enabled", "reconnect_mcp_server", "mcp_command",
    "add_permission_rule", "remove_permission_rule", "add_memory",
}
_OPTIONALLY_CORRELATED_COMMANDS = frozenset({
    "prompt", "start_goal",
    "get_workspace_changes", "get_workspace_change", "get_chat_changes", "get_chat_change",
    "set_workspace_roots", "set_mode", "set_model", "set_think", "set_goal", "get_goal",
    "get_plan", "new_session", "clear_session", "resume_session", "list_sessions",
    "delete_session", "list_checkpoints", "rewind", "list_retained_tasks",
    "resolve_retained_task", "compact", "list_artifacts", "stop_artifact", "set_config",
    "get_config", "status", "name_session", "reload_skills", "set_skill_enabled", "create_skill", "install_skill", "get_skill", "list_docs", "get_doc",
    "list_mcp_servers", "upsert_mcp_server", "remove_mcp_server", "reload_mcp_servers",
    "list_mcp_context", "get_mcp_context", "set_mcp_enabled", "reconnect_mcp_server", "mcp_command", "get_history",
    "list_permissions", "add_permission_rule", "remove_permission_rule",
    "get_memory", "add_memory",
})
_EDITOR_CONTEXT_LIMIT = 64_000
_CONFIG_BOOLEAN_KEYS = frozenset({
    "prompt_cache", "sandbox", "sandbox_network", "show_reasoning", "preserve_thinking",
    "code_action", "suggest", "plan_artifact", "artifact_autostart", "artifact_in_plan",
    "ultra_mode",
})
_CONFIG_STRING_LIMITS = {
    "subagent_model": 512,
    "subagent_base_url": 4096,
    "subagent_api_key": 16_384,
    "prompt_cache_key": 64,
    "fallback_model": 512,
    "fallback_base_url": 4096,
    "fallback_api_key": 16_384,
    "autonomous_gate": 512,
    "subscription_model": 256,
}
_CONFIG_ENUMS = {
    "api_mode": frozenset({"auto", "ollama", "anthropic", "chat_completions", "responses"}),
    "subagent_api_mode": frozenset({"", "auto", "ollama", "anthropic",
                                     "chat_completions", "responses"}),
    "fallback_api_mode": frozenset({"", "auto", "ollama", "anthropic",
                                     "chat_completions", "responses"}),
    "provider_state": frozenset({"stateless", "server"}),
    "search_provider": frozenset({"duckduckgo", "brave", "tavily", "searxng"}),
    "tool_profile": frozenset({"adaptive", "full"}),
    "thinking": frozenset({"off", "low", "medium", "high", "xhigh"}),
    "subscription_effort": frozenset({"", "low", "medium", "high", "xhigh", "max"}),
}
_CONFIG_INTEGER_RANGES = {
    "capability_cache_ttl_s": (1, MAX_SAFE_INTEGER),
    "context_size": (2_048, MAX_SAFE_INTEGER),
    "max_parallel_tasks": (1, 8),
    "autonomous_max_turns": (1, 1_000),
}


def _validated_config_values(raw_values, subscription_keys) -> tuple[dict | None, str | None]:
    """Validate the generic set_config object completely before any state is changed."""
    if not isinstance(raw_values, dict):
        return None, "settings values must be an object"
    allowed = {*_CONFIG_BOOLEAN_KEYS, *_CONFIG_STRING_LIMITS, *_CONFIG_ENUMS,
               *_CONFIG_INTEGER_RANGES, "provider_capabilities", "subscription_engine"}
    unknown = [key for key in raw_values if key not in allowed]
    if unknown:
        return None, f"unsupported settings key: {str(unknown[0])[:80]}"
    values = dict(raw_values)
    for key in _CONFIG_BOOLEAN_KEYS:
        if key in values and not isinstance(values[key], bool):
            return None, f"{key} must be true or false"
    for key, limit in _CONFIG_STRING_LIMITS.items():
        if key not in values:
            continue
        value = values[key]
        if (not isinstance(value, str) or len(value) > limit
                or any(ord(char) < 32 and not (key == "autonomous_gate" and char == "\t")
                       for char in value)):
            return None, f"{key} must be a bounded plain string"
    for key in ("subagent_base_url", "fallback_base_url"):
        value = values.get(key)
        if value and (any(char.isspace() for char in value) or mcp_url_has_credentials(value)):
            return None, f"{key} cannot contain whitespace or URL credentials"
    # Tabs are useful in a shell gate and were accepted by the prior contract; other controls are
    # neither executable text nor safe durable configuration.
    gate = values.get("autonomous_gate")
    if isinstance(gate, str) and any(ord(char) < 32 and char != "\t" for char in gate):
        return None, "autonomous_gate must be a single-line command string (\u2264512 chars)"
    for key, choices in _CONFIG_ENUMS.items():
        if key in values and (not isinstance(values[key], str) or values[key] not in choices):
            return None, f"{key} has an unsupported value"
    if "subscription_engine" in values:
        engine = values["subscription_engine"]
        if (not isinstance(engine, str) or (engine and engine not in subscription_keys)):
            return None, ("subscription_engine must be empty or one of: "
                          + ", ".join(subscription_keys))
    for key, (minimum, maximum) in _CONFIG_INTEGER_RANGES.items():
        if key not in values:
            continue
        value = values[key]
        if (isinstance(value, bool) or not isinstance(value, int)
                or not minimum <= value <= maximum):
            return None, f"{key} must be an integer from {minimum} to {maximum}"
    if "provider_capabilities" in values:
        capabilities = values["provider_capabilities"]
        from .llm import ProviderCapabilities
        known = frozenset(ProviderCapabilities.__dataclass_fields__)
        if (not isinstance(capabilities, dict) or len(capabilities) > len(known)
                or set(capabilities) - known
                or any(not isinstance(value, bool) for value in capabilities.values())):
            return None, "provider_capabilities must contain only known boolean feature overrides"
    return values, None


def _turn_payload_bytes(text, images, context) -> int:
    """Approximate the retained decoded queue payload with exact UTF-8 JSON bytes."""
    try:
        return len(json.dumps([text, images, context], ensure_ascii=False,
                              separators=(",", ":")).encode("utf-8"))
    except (TypeError, ValueError, UnicodeError):
        return _MAX_QUEUED_TURN_BYTES + 1


def _json_payload_bytes(value) -> int:
    try:
        return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                              allow_nan=False).encode("utf-8"))
    except (RecursionError, TypeError, ValueError, UnicodeError):
        return _MAX_MCP_ARGUMENT_BYTES + 1


def _mcp_url_has_credentials(value: str) -> bool:
    return mcp_url_has_credentials(value)


def _request_fields(request_id: str | None) -> dict[str, str]:
    """Attach a correlation ID only when the optional command field was present and valid."""
    return {"request_id": request_id} if request_id else {}


def _prompt_thread_title(text: str) -> str:
    """Create an immediate, stable editor thread label without another model request."""
    clean = re.sub(r"\s+", " ", _strip_editor_context(str(text or ""))).strip()
    clean = re.sub(r"^[#>*`\-\s]+", "", clean).strip()
    if not clean:
        return ""
    if len(clean) <= 60:
        return clean
    return clean[:57].rstrip(" ,.;:-") + "…"


class _Shutdown(Exception):
    pass


def _command_lines(stream):
    """Yield bounded UTF-8 command lines and recover after an oversized/malformed frame."""
    binary = getattr(stream, "buffer", None)
    if binary is None:  # StringIO and other test/embedded text streams
        for line in stream:
            if len(line.encode("utf-8")) > MAX_COMMAND_BYTES:
                yield None, f"command frame exceeded {MAX_COMMAND_BYTES} bytes"
            else:
                yield line, None
        return
    while True:
        raw = binary.readline(MAX_COMMAND_BYTES + 1)
        if not raw:
            return
        if len(raw) > MAX_COMMAND_BYTES:
            while raw and not raw.endswith(b"\n"):
                raw = binary.readline(MAX_COMMAND_BYTES + 1)
            yield None, f"command frame exceeded {MAX_COMMAND_BYTES} bytes"
            continue
        try:
            yield raw.decode("utf-8"), None
        except UnicodeDecodeError:
            yield None, "command frame was not valid UTF-8"


class HeadlessUI:
    """The AgentUI seam, realized as NDJSON events + blocking request round-trips."""

    def __init__(self, emitter: Emitter, pending: PendingRequests,
                 approval_timeout_s: float = 300.0):
        self.em = emitter
        self.pending = pending
        self.approval_timeout_s = max(0.01, float(approval_timeout_s))
        self.question_forms = False  # opted in by the editor handshake; strict older v6 clients remain valid
        self.cancelled = None
        self._rule_hook = None          # set by Backend to persist an allow rule
        self._rule_override: dict = {}   # tool -> explicit rule string the IDE dictated
        self.plan_feedback = ""         # one-shot feedback consumed by Agent after rejection
        self.deny_reason = ""           # the editor's note on a denial, consumed by Agent
        self.preview_root = None        # project root for edit previews on approval cards

    # streaming ----------------------------------------------------------------
    def on_text(self, chunk: str) -> None:
        self.em.emit("text_delta", text=chunk)

    def on_thinking(self, chunk: str) -> None:
        self.em.emit("thinking_delta", text=chunk)

    def end_stream(self) -> None:
        self.em.emit("stream_end")

    def steering_applied(self, request_id: str) -> None:
        hook = getattr(self, "_steering_hook", None)
        if hook:
            hook(request_id)

    # tools --------------------------------------------------------------------
    def tool_call(self, name: str, args: dict, call_id: str | None = None) -> None:
        self.em.emit("tool_call", call_id=call_id, name=name, args=args,
                     summary=arg_summary(name, args))

    def tool_progress(self, name: str, message: str, *, progress=None, total=None,
                      level: str = "", call_id: str | None = None) -> None:
        fields = {"call_id": call_id, "name": name, "message": str(message)[:500]}
        if isinstance(progress, (int, float)) and not isinstance(progress, bool):
            fields["progress"] = progress
        if isinstance(total, (int, float)) and not isinstance(total, bool):
            fields["total"] = total
        if level:
            fields["level"] = level
        self.em.emit("tool_progress", **fields)

    def tool_result(self, name: str, out: str, call_id: str | None = None) -> None:
        is_diff, diff = split_diff(out)
        self.em.emit("tool_result", call_id=call_id, name=name, output=out,
                     is_error=tool_output_is_error(out), is_diff=is_diff, diff=diff)

    def tool_denied(self, name: str, args: dict, reason: str,
                    call_id: str | None = None) -> None:
        self.em.emit("tool_denied", call_id=call_id, name=name, args=args, reason=reason)

    def on_todo(self, todos: list) -> None:
        self.em.emit("todos", todos=todos)

    def hook_activity(self, event: str, status: str, *, configured: int = 0,
                      duration_ms: int = 0, message: str = "") -> None:
        self.em.emit("hook_activity", event=event, status=status,
                     configured=max(0, int(configured)),
                     duration_ms=max(0, int(duration_ms)), message=message or None)

    def artifact_ready(self, art) -> None:
        self.em.emit("artifact_ready", id=art.id, name=art.name, url=art.url, rel=art.rel)

    def goal_changed(self, goal: str, status: str) -> None:
        hook = getattr(self, "_goal_hook", None)
        if callable(hook):
            hook()
        else:
            self.em.emit("goal_changed", goal=goal, status=status)

    # notices ------------------------------------------------------------------
    def info(self, message: str) -> None:
        self.em.emit("info", message=message)

    def context_compacted(self, result: dict) -> None:
        """Carry the exact post-save compaction outcome instead of parsing a status sentence."""
        self.em.emit("compacted", **result)

    def error(self, message: str) -> None:
        self.em.emit("error", message=message)

    # blocking decisions -------------------------------------------------------
    def _await(self, rid: str, ev: threading.Event, cancel=None, recheck=None, *, human=False):
        # Reviewing a plan or deciding between options is not an abandoned network request.
        # Only an explicit reply, Stop, or disconnection ends a native human decision.
        deadline = None if human else time.monotonic() + self.approval_timeout_s
        cancel = cancel if cancel is not None else self.cancelled
        while not ev.wait(0.1 if deadline is None else min(0.1, max(0.0, deadline - time.monotonic()))):
            if cancel is not None and cancel.is_set():
                self.pending.value(rid)
                self.em.emit("request_expired", id=rid)
                return None
            if recheck is not None:
                decision = recheck()
                if decision in ("once", "no") and self.pending.resolve(rid, {"decision": decision}):
                    self.em.emit("permission_resolved", id=rid, decision=decision,
                                 message="Approved by the current permission mode" if decision == "once"
                                 else "Blocked by the current permission mode")
                    continue
            if deadline is not None and time.monotonic() >= deadline:
                self.pending.value(rid)  # discard it so a late response cannot affect another request
                self.em.emit("request_expired", id=rid)
                return None
        return self.pending.value(rid)

    def approve(self, name: str, args: dict, call_id: str | None = None) -> str:
        return self.approve_live(name, args, call_id)

    def approve_live(self, name: str, args: dict, call_id: str | None = None, *, recheck=None) -> str:
        rid, ev = self.pending.register()
        preview = edit_preview(name, args, self.preview_root) if self.preview_root else ""
        self.em.emit("permission_request", id=rid, call_id=call_id, name=name, args=args,
                     command=(args.get("command") if name == "bash" else None),
                     summary=arg_summary(name, args), diff=preview or None,
                     suggested_rule=str(rule_for(name, args)),
                     choices=["once", "always", "deny"])
        payload = self._await(rid, ev, recheck=recheck, human=True) or {}
        if payload.get("rule"):
            self._rule_override[name] = payload["rule"]
        decision = {"once": "once", "always": "always",
                    "deny": "no", "no": "no"}.get(payload.get("decision"), "no")
        # A denial can carry the user's note; the agent hands it to the model as the reason.
        self.deny_reason = str(payload.get("reason") or "")[:2000] if decision == "no" else ""
        return decision

    def add_permission_rule(self, name: str, args: dict) -> None:
        rule = self._rule_override.pop(name, None) or str(rule_for(name, args))
        if self._rule_hook:
            self._rule_hook(rule)
        self.em.emit("rule_added", rule=rule)

    def present_plan(self, plan: str):
        rid, ev = self.pending.register()
        self.em.emit("plan_proposal", id=rid, plan=plan,
                     choices=["auto", "acceptEdits", "default", "reject"])
        payload = self._await(rid, ev, human=True) or {}
        self.plan_feedback = str(payload.get("feedback") or "").strip()
        decision = payload.get("decision")
        if decision in _PLAN_MODES:
            self.plan_feedback = ""
        return decision if decision in _PLAN_MODES else None

    def propose_options(self, question: str, options: list) -> str:
        def valid(payload):
            choice = payload.get("choice") if isinstance(payload, dict) else None
            return ((type(choice) is int and 1 <= choice <= len(options))
                    or (isinstance(choice, str) and bool(choice.strip()) and len(choice) <= 4096))
        rid, ev = self.pending.register(validator=valid)
        self.em.emit("options_request", id=rid, question=question, options=options)
        payload = self._await(rid, ev, human=True) or {}
        choice = payload.get("choice")
        if type(choice) is int and 1 <= choice <= len(options):
            return options[choice - 1]
        if isinstance(choice, str) and choice.strip() and len(choice) <= 4096:
            return choice.strip()
        return ""

    def propose_questions(self, questions: list[dict]) -> dict | None:
        from .questions import valid_answers
        if not self.question_forms:
            answers = {}
            for q in questions:
                answer = self.propose_options(q["question"], q["options"])
                if not answer:
                    return None
                answers[q["id"]] = answer
            return answers
        rid, ev = self.pending.register(validator=lambda p: isinstance(p, dict)
                                         and valid_answers(questions, p.get("answers")))
        self.em.emit("options_request", id=rid, question=questions[0]["question"],
                     options=questions[0]["options"], questions=questions)
        payload = self._await(rid, ev, human=True) or {}
        answers = payload.get("answers")
        return answers if valid_answers(questions, answers) else None

    def mcp_capabilities(self) -> dict:
        return {"sampling": {}, "elicitation": {"form": {}, "url": {}}}

    def mcp_input(self, server: str, kind: str, payload: dict, *, cancel=None) -> dict:
        rid, ev = self.pending.register()
        self.em.emit("mcp_input_request", id=rid, server=str(server)[:120], kind=kind,
                     payload=payload)
        response = self._await(rid, ev, cancel=cancel)
        if not isinstance(response, dict):
            return {"action": "cancel"}
        return {"action": response.get("action", "cancel"),
                **({"content": response.get("content")}
                   if isinstance(response.get("content"), dict) else {})}


class Backend:
    def __init__(self, config: Config):
        from .trust import is_trusted
        self.workspace_trusted = is_trusted(config, config.project_root)
        if not self.workspace_trusted and config.mode in ("acceptEdits", "auto"):
            config.data["mode"] = "default"  # do not persist a downgrade of the user's global preference
        self.config = config
        self.em = Emitter(
            sys.stdout, validator=event_error,
            sanitizer=lambda event: redact_value(event, secret_values(self.config)))
        self.pending = PendingRequests()
        self.ui = HeadlessUI(self.em, self.pending,
                             float(config.get("approval_timeout_s", 300) or 300))
        self.ui.preview_root = config.project_root   # edit previews on approval cards
        self.agent = Agent(config, self.ui)
        self.ui.cancelled = self.agent.cancelled
        self.ui._goal_hook = self._emit_goal
        self.ui._rule_hook = self._add_rule
        self.ui._steering_hook = self._steering_applied
        self.agent.session_file = sessions_mod.new_path(config.project_root)
        self._worker: threading.Thread | None = None
        self._foreground_worker: threading.Thread | None = None
        self._turn_lock = threading.RLock()
        self._turn_n = 0
        self._queue: list[tuple[str, object, object]] = []  # ordered (prompt, images, typed context)
        self._steer_payloads: dict[str, tuple] = {}
        self._model_list_lock = threading.Lock()

    def _add_rule(self, rule_text: str) -> None:
        try:
            Rule.parse(rule_text, "allow")  # validate before persisting
            self.config.permissions.setdefault("allow", []).append(rule_text)
            self.config.save()
        except Exception:
            pass

    def start(self) -> None:
        self.em.emit(
            "ready", version=__version__, protocol_version=PROTOCOL_VERSION,
            capabilities={"typed_editor_context": True, "multi_root": True, "usage": True,
                          "goal_state": True, "goal_runner": True, "saved_plan": True, "command_registry": True,
                          "provider_model_discovery": True, "headless_mcp_catalog": True,
                          "headless_mcp_call": True, "headless_skill_catalog": True,
                          "headless_feature_management": True,
                          "headless_handoff": True, "headless_hook_catalog": True,
                          "hook_activity": True, "correlated_state_requests": True,
                          "ultra_profile": True, "composer_selections": True, "skill_management": True,
                          "mcp_context": True, "mcp_management": True, "history_snapshot": True,
                          "goal_inputs": True, "workflows": True, "workspace_inspection": True, "chat_inspection": True,
                          "live_steering": True, "live_modes": True, "question_forms": True,
                          "steering_native": not bool(self.config.get("subscription_engine", ""))},
            model=self.config.model, mode=self.agent.mode,
            think=self.config.get("thinking", "off"), base_url=self.config.base_url,
            ultra_mode=bool(self.config.get("ultra_mode", False)),
            subagent_base_url=self.config.get("subagent_base_url", ""),
            fallback_base_url=self.config.get("fallback_base_url", ""),
            project_root=str(self.config.project_root),
            workspace_trusted=self.workspace_trusted,
            session_id=self.agent.session_file.stem if self.agent.session_file else None,
            tools_supported=self.agent.client.tools_supported,
            provider=self.agent.client.family,
            provider_capabilities=self.agent.client.capability_snapshot(),
            tools=[t["function"]["name"] for t in TOOL_SCHEMAS],
            skills=[s.name for s in self.agent.skills.values()],
            commands=editor_command_metadata(),
            custom_commands=custom_command_names(self.config.project_root),
            goal=self._goal_snapshot(),
            session_name=str(self.agent.session_name or ""),
            context_size=self._context_window_size())
        for warning in getattr(self.config, "credential_warnings", ()):
            self.em.emit("info", message=str(warning)[:1000])
        self._emit_context()
        # Publish the complete route state immediately after the ready handshake. ``config``
        # carries both native and delegated settings so editors render the route that will run.
        self._emit_config()

    def _context_window_size(self) -> int:
        effective = getattr(self.agent, "context_size", None)
        if callable(effective):
            return int(effective())
        config_get = getattr(self.config, "get", None)
        if callable(config_get):
            return int(config_get("context_size", 32768))
        return int(getattr(self.config, "data", {}).get("context_size", 32768))

    def _busy(self) -> bool:
        lock = self._turn_state_lock()
        with lock:
            # The queue worker clears this reference atomically only after it has observed an
            # empty FIFO.  Do not use Thread.is_alive(): a prompt can otherwise arrive after the
            # worker's final queue check but before the thread has technically exited and become
            # stranded forever.
            return (getattr(self, "_worker", None) is not None
                    or getattr(self, "_foreground_worker", None) is not None)

    def _turn_state_lock(self) -> threading.RLock:
        """Return the queue lock (lazy only for small object.__new__ protocol fixtures)."""
        lock = getattr(self, "_turn_lock", None)
        if lock is None:
            lock = self._turn_lock = threading.RLock()
        return lock

    def _start_turn(self, text: str, images=None, context=None, *, delivery="queue", request_id="") -> tuple[str, int]:
        """Start or queue one turn atomically; return (started|queued|full, pending count)."""
        lock = self._turn_state_lock()
        with lock:
            if getattr(self, "_foreground_worker", None) is not None:
                return "busy", 0
            if getattr(self, "_worker", None) is not None:
                steers = getattr(self, "_steer_payloads", {})
                pending_bytes = sum(_turn_payload_bytes(*item) for item in [*self._queue, *steers.values()])
                if (len(self._queue) + len(steers) >= _MAX_QUEUED_TURNS
                        or pending_bytes + _turn_payload_bytes(text, images, context)
                        > _MAX_QUEUED_TURN_BYTES):
                    return "full", len(self._queue)
                config = getattr(self, "config", getattr(self.agent, "config", None))
                config_get = getattr(config, "get", None)
                engine = config_get("subscription_engine", "") if callable(config_get) else ""
                if delivery == "steer" and not engine and not self.agent.cancelled.is_set():
                    import uuid
                    identity = request_id or str(uuid.uuid4())
                    if identity in steers:
                        return "duplicate", len(self._queue)
                    model_text = _format_editor_context(redact_value(context, secret_values(config))) + text
                    steers[identity] = (text, images, context)
                    self._steer_payloads = steers
                    if self.agent.steer(model_text, images=images, request_id=identity):
                        # Publish acceptance before the worker can acknowledge consumption.
                        self.em.emit("prompt_accepted", request_id=identity, state="steered")
                        return "steered", len(self._queue)
                    steers.pop(identity, None)
                self._queue.append((text, images, context))
                return "queued", len(self._queue)
            self._queue.append((text, images, context))
            worker = threading.Thread(target=self._run_turn_queue, daemon=True,
                                      name="dgc-headless-turns")
            self._worker = worker
            worker.start()
            return "started", 0

    def _steering_applied(self, request_id: str) -> None:
        with self._turn_state_lock():
            if getattr(self, "_steer_payloads", {}).pop(request_id, None) is not None:
                self.em.emit("steering_update", request_id=request_id, state="applied")

    def _finish_steering(self, cancelled: bool, failed: bool) -> None:
        take = getattr(self.agent, "take_deferred_inputs", None)
        if callable(take):
            take()
        retained = []
        with self._turn_state_lock():
            # The consumption acknowledgement removes applied inputs synchronously. Everything
            # left here is owned but unconsumed, including a failed context/skill preparation.
            pending = getattr(self, "_steer_payloads", {})
            for identity, payload in list(pending.items()):
                pending.pop(identity, None)
                if cancelled or failed:
                    self.em.emit("steering_update", request_id=identity, state="returned",
                                 message="This follow-up was not applied. Your message has been preserved.")
                else:
                    retained.append(payload)
                    self.em.emit("steering_update", request_id=identity, state="queued")
            self._queue[:0] = retained
            if retained:
                self.em.emit("queued", count=len(self._queue), text="")

    def _run_subscription_turn(self, engine_key: str, prompt: str) -> bool:
        """Delegate one editor turn while preserving the native headless event contract."""
        from . import subscriptions as subs
        engine = subs.get_engine(engine_key)
        if engine is None:
            self.ui.error(f"unknown subscription engine '{engine_key}'")
            return False
        try:
            result = subs.delegate_turn(self.config, self.agent, self.ui, engine, prompt)
        except subs.EngineError as exc:
            self.ui.error(str(exc))
            return False
        if result.get("timeout"):
            self.ui.error("the delegated turn hit the time budget and was stopped")
        elif result.get("error") and result.get("persisted", True):
            self.ui.error(str(result["error"]))
        elif result.get("rc") not in (0, None):
            self.ui.error(f"{engine.short_label} exited with status {result['rc']}")
        return bool(result.get("ok"))

    def _run_turn_queue(self) -> None:
        """Drain the prompt FIFO in one worker so completion and enqueue cannot race."""
        current = threading.current_thread()
        try:
            while True:
                lock = self._turn_state_lock()
                with lock:
                    if not self._queue:
                        self._worker = None
                        return
                    text, images, context = self._queue.pop(0)
                    self._turn_n += 1
                    tid = f"t{self._turn_n}"
                    # Clear only stale cancellation while dequeue is serialized. A concurrent
                    # cancel that wins this lock either removes this item first, or sets the Event
                    # after this clear; Agent must not clear it again at entry.
                    self.agent.cancelled.clear()

                self.agent._pending_images = images
                active_config = getattr(
                    self, "config", getattr(getattr(self, "agent", None), "config", None))
                safe_context = redact_value(context, secret_values(active_config))
                model_text = _format_editor_context(safe_context) + text
                from .workflows import display_prompt
                shown_prompt = display_prompt(text)
                name_session = getattr(self.agent, "name_session", None)
                if not getattr(self.agent, "session_name", None) and callable(name_session):
                    title = _prompt_thread_title(shown_prompt)
                    if title and name_session(title):
                        self.em.emit("session_named", name=title)
                self.em.emit("turn_start", turn_id=tid, prompt=shown_prompt)
                eta_stop = self._start_eta_ticker(tid)
                failed = False
                try:
                    config_get = getattr(active_config, "get", None)
                    engine_key = str(
                        config_get("subscription_engine", "") if callable(config_get)
                        else getattr(active_config, "data", {}).get("subscription_engine", "")
                    ).strip().lower()
                    if engine_key and images:
                        self.agent._pending_images = None
                        self.ui.error(
                            "subscription CLI delegation does not yet support DGC image attachments")
                        outcome = False
                    else:
                        outcome = (self._run_subscription_turn(engine_key, model_text)
                                   if engine_key else
                                   self.agent.run_turn(model_text, reset_cancel=False))
                    failed = outcome is False
                except Exception as e:             # a model/endpoint failure must NOT kill the turn silently
                    failed = True                  # (unreachable base_url, model not pulled, HTTP error, …)
                    import traceback
                    detail = str(e).strip() or e.__class__.__name__
                    self.em.emit("error", message=f"Turn failed — {detail}")
                    active_config = getattr(
                        self, "config", getattr(getattr(self, "agent", None), "config", None))
                    sys.stderr.write(redact_value(
                        {"traceback": traceback.format_exc()},
                        secret_values(active_config))["traceback"])
                cancelled = self.agent.cancelled.is_set()
                eta_stop.set()
                self._finish_steering(cancelled, failed)
                try:
                    est = self.agent.estimate_tokens()
                except Exception:
                    est = 0
                with self._turn_state_lock():
                    idle = not self._queue
                    if idle and self._worker is current:
                        self._worker = None
                    # Release an idle worker before publishing its terminal event. Goal pause,
                    # delete, model changes and workspace updates may arrive immediately on that
                    # acknowledgement. Serialize publication with enqueue so a newer turn_start
                    # cannot overtake this turn_end or be consumed by the retiring worker.
                    self.em.emit("turn_end", turn_id=tid,
                                 reason="cancelled" if cancelled else ("error" if failed else "completed"),
                                 token_estimate=est)
                    self._emit_context()
                if idle:
                    return
        finally:
            # A broken output stream or unexpected fixture/runtime exception must not leave the
            # backend permanently busy.  Retain any unstarted FIFO entries for the next submission.
            with self._turn_state_lock():
                if self._worker is current:
                    self._worker = None

    def _start_foreground_worker(self, operation, *, label: str = "operation") -> bool:
        """Reserve a non-prompt foreground slot while stdin decisions/cancellation stay live."""
        lock = self._turn_state_lock()
        with lock:
            if (getattr(self, "_worker", None) is not None
                    or getattr(self, "_foreground_worker", None) is not None):
                return False
            self.agent.cancelled.clear()

            def run():
                current = threading.current_thread()
                terminal = None
                try:
                    terminal = operation()
                finally:
                    with self._turn_state_lock():
                        if self._foreground_worker is current:
                            self._foreground_worker = None
                # A terminal event means the next foreground command is admissible. Emit it only
                # after releasing the slot, otherwise a fast controller can receive completion and
                # have its immediately following prompt rejected against a worker that is unwinding.
                if callable(terminal):
                    terminal()

            worker = threading.Thread(target=run, daemon=True,
                                      name=f"dgc-headless-{label[:32]}")
            self._foreground_worker = worker
            worker.start()
            return True

    def _list_mcp_tools(self, request_id: str, offset: int, limit: int):
        try:
            schemas = self.agent.mcp.tool_schemas()
            rows = []
            used = 2
            for schema in schemas[offset:offset + limit]:
                fn = schema.get("function") if isinstance(schema, dict) else {}
                fn = fn if isinstance(fn, dict) else {}
                parameters = Agent._mcp_parameter_summary(fn.get("parameters"))
                row = {"name": str(fn.get("name") or "")[:512],
                       "description": str(fn.get("description") or "")[:1000],
                       "parameters": parameters}
                encoded = json.dumps(row, ensure_ascii=False, separators=(",", ":"),
                                     allow_nan=False).encode("utf-8")
                if len(encoded) > 16 * 1024:
                    row["parameters"] = {
                        "type": parameters.get("type", "object"),
                        "required": parameters.get("required", []),
                        "property_names": list(parameters.get("properties", {})),
                    }
                    encoded = json.dumps(row, ensure_ascii=False, separators=(",", ":"),
                                         allow_nan=False).encode("utf-8")
                if rows and used + len(encoded) + 1 > _MAX_MCP_LIST_BYTES:
                    break
                rows.append(row)
                used += len(encoded) + 1
            statuses = getattr(self.agent.mcp, "status", lambda: [])()
            next_offset = offset + len(rows)
            payload = dict(request_id=request_id, servers=list(statuses)[:100], tools=rows,
                           total=len(schemas), offset=offset,
                           next_offset=(next_offset if next_offset < len(schemas) else None))
        except Exception as exc:
            payload = dict(request_id=request_id, servers=[], tools=[], total=0,
                           offset=offset, next_offset=None,
                           error=f"MCP catalog listing failed ({type(exc).__name__})")
        return lambda: self.em.emit("mcp_tools", **payload)

    def _call_mcp_tool(self, request_id: str, call_id: str,
                       name: str, arguments: dict):
        status = "completed"
        try:
            output = self.agent.execute_mcp_tool(name, arguments, call_id)
            low = str(output or "").lstrip().lower()
            if self.agent.cancelled.is_set():
                status = "cancelled"
            elif low.startswith(("permission denied", "the user denied", "blocked by")):
                status = "denied"
            elif tool_output_is_error(output):
                status = "error"
        except Exception as exc:
            output = f"error: MCP tool call failed ({type(exc).__name__})"
            status = "error"
        return lambda: self.em.emit(
            "mcp_call_complete", request_id=request_id, call_id=call_id,
            name=name, status=status, output=str(output))

    def _mcp_context_operation(self, command: dict):
        from .mcp_context import list_catalog
        server_name, kind = command["server"], command["kind"]
        fields = {"request_id": command["request_id"], "server": server_name, "kind": kind}
        listing = command["type"] == "list_mcp_context"
        event = "mcp_context_catalog" if listing else "mcp_context"
        fields.update({"items": []} if listing else {"identifier": command["identifier"], "text": "", "omitted": []})
        try:
            server = self.agent.mcp.servers.get(server_name)
            if server is None:
                raise ValueError("This MCP server is disconnected. Reconnect it before selecting context.")
            if listing:
                fields["items"] = list_catalog(server, kind, cancel=self.agent.cancelled)
            else:
                fields.update(self.agent.execute_mcp_context(server_name, kind, command["identifier"],
                    command.get("arguments", {}), "context-" + command["request_id"]))
        except (OSError, ValueError) as exc:
            fields["error"] = str(exc)
        except Exception as exc:
            fields["error"] = f"MCP context operation failed ({type(exc).__name__})"
        return lambda: self.em.emit(event, **fields)

    def _emit_skill_catalog(self, request_id: str) -> None:
        rows = skill_catalog(dict(self.agent.skills), self.config.project_root)
        self.em.emit("skill_catalog", request_id=request_id, items=rows, total=len(rows))

    def _emit_skill_detail(self, request_id: str, name: str) -> None:
        normalized = normalize_skill_name(name)
        skills = dict(self.agent.skills)
        skill = skills.get(normalized)
        metadata = {row["name"]: row
                    for row in skill_catalog(skills, self.config.project_root)}
        row = metadata.get(normalized, {})
        self.em.emit(
            "skill_detail", request_id=request_id, found=skill is not None,
            name=normalized, description=str(row.get("description") or ""),
            source=str(row.get("source") or "unknown"),
            markdown=(skill.render("") if skill is not None else ""))

    def _emit_docs(self, request_id: str) -> None:
        from .docs import catalog
        items = catalog()
        self.em.emit("docs_catalog", request_id=request_id, items=items, total=len(items))

    def _emit_doc(self, request_id: str, identifier: str) -> None:
        from .docs import find_id, slug
        entry = find_id(identifier)
        self.em.emit(
            "doc", request_id=request_id, found=entry is not None,
            id=slug(entry[0]) if entry else str(identifier)[:80],
            title=entry[0] if entry else "", description=entry[1] if entry else "",
            markdown=entry[2][:120_000] if entry else "")

    @staticmethod
    def _public_mcp_spec(spec) -> dict:
        return public_mcp_spec(spec)

    def _emit_mcp_servers(self, request_id: str, error: str | None = None) -> None:
        configured = self.config.get("mcp_servers", {}) or {}
        configured = configured if isinstance(configured, dict) else {}
        statuses = {str(row.get("name")): row for row in self.agent.mcp.status()
                    if isinstance(row, dict)}
        items = []
        disabled = self.config.get("disabled_mcp_servers", [])
        disabled = disabled if isinstance(disabled, list) else []
        for index, (raw_name, raw_spec) in enumerate(configured.items()):
            if index >= _MAX_MCP_SERVERS:
                break
            name = str(raw_name)[:128]
            status = statuses.pop(name, {})
            items.append({"name": name, **self._public_mcp_spec(raw_spec),
                          "enabled": name not in disabled,
                          "state": "disabled" if name in disabled else str(status.get("state") or "configured")[:32],
                          "tool_count": int(status.get("tool_count") or 0),
                          "protocol_version": str(status.get("protocol_version") or "")[:64],
                          "protocol_era": str(status.get("protocol_era") or "")[:32],
                          "error": str(status.get("error") or "")[:500]})
        for name, status in list(statuses.items())[:_MAX_MCP_SERVERS - len(items)]:
            items.append({"name": name[:128], **self._public_mcp_spec({}),
                          "state": str(status.get("state") or "failed")[:32],
                          "tool_count": int(status.get("tool_count") or 0),
                          "protocol_version": str(status.get("protocol_version") or "")[:64],
                          "protocol_era": str(status.get("protocol_era") or "")[:32],
                          "error": str(status.get("error") or "")[:500]})
        fields = {"error": str(error)[:500]} if error else {}
        self.em.emit("mcp_servers", request_id=request_id, items=items,
                     total=len(items), **fields)

    def _mcp_control(self, command: dict):
        from .mcp_management import set_server_enabled
        error = None
        try:
            name = command["name"]
            if not _MCP_NAME_RE.fullmatch(name) or name not in self.config.get("mcp_servers", {}):
                raise ValueError("Choose an existing MCP server")
            if command["type"] == "set_mcp_enabled":
                set_server_enabled(self.config, self.agent.mcp, name, command["enabled"], cancel=self.agent.cancelled,
                                   input_handler=self.agent._handle_mcp_input)
            else:
                runtime = self.config.mcp_runtime_servers()
                self.agent.mcp.reconnect(name, runtime[name], cancel=self.agent.cancelled,
                                         input_handler=self.agent._handle_mcp_input)
        except (OSError, ValueError) as exc:
            error = str(exc)
        except Exception as exc:
            error = f"MCP connection operation failed ({type(exc).__name__})"
        return lambda: self._emit_mcp_servers(command["request_id"], error)

    def _mcp_command(self, command: dict):
        import shlex
        from .mcp_management import manage_mcp
        fields = {"request_id": command["request_id"], "output": ""}
        try:
            arguments = command["arguments"]
            if len(arguments) > 32_000:
                raise ValueError("MCP command exceeds 32,000 characters")
            parts = shlex.split(arguments)
            result = manage_mcp(self.config, self.agent.mcp, arguments, agent=self.agent)
            if isinstance(result, dict):
                fields["context"] = result
            elif parts and parts[0] in ("resources", "templates", "prompts"):
                fields["catalog"] = {"server": parts[1], "kind": parts[0], "items": json.loads(result)}
            else:
                fields["output"] = result
        except (OSError, ValueError) as exc:
            fields["error"] = str(exc)
        except Exception as exc:
            fields["error"] = f"MCP command failed ({type(exc).__name__})"
        def terminal():
            self._emit_mcp_servers(command["request_id"])
            self.em.emit("mcp_command_result", **fields)
        return terminal

    def _upsert_mcp_server(self, request_id: str, name: str,
                           runtime_value, persisted_value, *, interactive: bool = False):
        def finish(error=None):
            terminal = lambda: self._emit_mcp_servers(request_id, error)
            return terminal if interactive else terminal()

        if not _MCP_NAME_RE.fullmatch(name):
            return finish("server name must use 1-64 letters, digits, ., _, or -")
        runtime, runtime_error = _mcp_spec(runtime_value, persisted=False)
        persisted, persisted_error = _mcp_spec(persisted_value, persisted=True)
        problem = runtime_error or persisted_error
        if not problem and runtime and persisted:
            if (any(runtime.get(key) != persisted.get(key)
                    for key in ("transport", "command", "env_names", "auth_env", "url", "log_level"))
                    or bool(runtime.get("defer_until_setup"))
                    != bool(persisted.get("defer_until_setup"))):
                problem = "runtime and persisted server identity do not match"
            runtime_args, persisted_args = runtime.get("args", []), persisted.get("args", [])
            extra = runtime_args[len(persisted_args):] if runtime_args[:len(persisted_args)] == persisted_args else None
            if extra not in ([], None):
                header_env = (re.fullmatch(
                    r"Authorization:\s*Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}",
                    extra[1], re.IGNORECASE) if len(extra) == 2 else None)
                if (persisted.get("transport") != "remote" or len(extra) != 2
                        or extra[0] != "--header" or header_env is None
                        or header_env.group(1) not in runtime.get("env", {})
                        or header_env.group(1) not in persisted.get("env_names", [])
                        or header_env.group(1) != persisted.get("auth_env")):
                    problem = "runtime arguments may only add one bounded remote Authorization header"
            elif extra is None:
                problem = "runtime arguments must preserve the persisted argument prefix"
        if problem or runtime is None or persisted is None:
            return finish(problem or "invalid MCP server specification")
        servers = dict(self.config.get("mcp_servers", {}) or {})
        if name not in servers and len(servers) >= _MAX_MCP_SERVERS:
            return finish(f"at most {_MAX_MCP_SERVERS} MCP servers are supported")
        if hasattr(self.config, "drop_mcp_secrets"):
            # An editor upsert may replace a SecretStorage value without changing the public
            # server identity.  Never let an older CLI-migrated value win on the next launch.
            self.config.drop_mcp_secrets(name)
        servers[name] = persisted
        self.config.set("mcp_servers", servers)
        secret_candidates = list(runtime.get("env", {}).values())
        existing = list(getattr(self.config, "_session_secret_values", ()))
        self.config._session_secret_values = tuple((existing + secret_candidates)[-256:])
        try:
            self.agent.mcp.connect_all({name: runtime},
                                      cancel=self.agent.cancelled if interactive else None,
                                      input_handler=self.agent._handle_mcp_input if interactive else None)
        except Exception as exc:
            return finish(f"MCP connection failed ({type(exc).__name__})")
        return finish()

    def _emit_permissions(self, request_id: str) -> None:
        items = [{"action": action, "rule": str(rule)[:1000]}
                 for action in ("deny", "ask", "allow")
                 for rule in list(self.config.permissions.get(action, []))[:256]]
        self.em.emit("permissions", request_id=request_id, items=items, total=len(items))

    def _emit_memory(self, request_id: str, message: str | None = None) -> None:
        from .memory import load_memories
        project, user = load_memories(
            self.config.project_root,
            sanitizer=lambda value: redact_value(value, secret_values(self.config)))
        fields = {"message": str(message)[:500]} if message else {}
        self.em.emit("memory", request_id=request_id, project=project, user=user, **fields)

    def _emit_hook_catalog(self, request_id: str) -> None:
        catalog = hook_catalog(self.config)
        self.em.emit("hook_catalog", request_id=request_id, **catalog)

    def _generate_handoff(self, request_id: str, save: bool):
        self.em.emit("handoff_started", request_id=request_id)
        try:
            markdown = self.agent.generate_handoff(save=save)
            error = str(getattr(self.agent, "_last_handoff_error", "") or "")[:500]
        except Exception as exc:
            error = f"handoff generation failed ({type(exc).__name__})"
            markdown = f"# Handoff\n\n({error})"
        path = None
        if error:
            status = "cancelled" if self.agent.cancelled.is_set() else "error"
        else:
            status = "completed"
            if save:
                saved = getattr(self.agent, "_last_handoff_path", None)
                if saved is None:
                    status = "error"
                    error = str(getattr(self.agent, "_last_handoff_error", "")
                                or "could not save the handoff")[:500]
                else:
                    try:
                        path = str(saved.relative_to(self.config.project_root))
                    except ValueError:
                        status = "error"
                        error = "the saved handoff escaped the project boundary"
                        path = None
        def terminal():
            self.em.emit("handoff", request_id=request_id, status=status,
                         markdown=str(markdown)[:64_000], path=path, error=error or None)
            self._emit_context()
        return terminal

    def close(self) -> None:
        """Cancel foreground work and release pending controller decisions on backend exit."""
        inspection = getattr(self, "_editor_inspection", None)
        if inspection is not None:
            inspection.close()
        with self._turn_state_lock():
            self.agent.cancelled.set()
            self._queue.clear()
            workers = [getattr(self, "_worker", None),
                       getattr(self, "_foreground_worker", None)]
        self.pending.cancel_all({"decision": "no", "choice": None, "action": "cancel"})
        for worker in workers:
            if isinstance(worker, threading.Thread) and worker is not threading.current_thread():
                worker.join(timeout=2)
        manager = getattr(self.agent, "mcp", None)
        if manager is not None:
            manager.stop_all()

    def _start_eta_ticker(self, turn_id: str) -> threading.Event:
        """Publish `turn_eta` while the estimate changes; a stopped event ends it before turn_end."""
        stop = threading.Event()
        agent = self.agent

        def tick() -> None:
            last_label, last_emit = "", 0.0
            while not stop.wait(1.5):
                try:
                    snapshot = agent.eta_snapshot()
                except Exception:
                    snapshot = None
                if snapshot is None or not snapshot.visible:
                    continue
                now = time.monotonic()
                if snapshot.label == last_label and now - last_emit < 15.0:
                    continue
                last_label, last_emit = snapshot.label, now
                try:
                    self.em.emit("turn_eta", turn_id=turn_id,
                                 elapsed_seconds=round(float(snapshot.elapsed), 1),
                                 remaining_low_seconds=round(float(snapshot.low), 1),
                                 remaining_high_seconds=round(float(snapshot.high), 1),
                                 confidence=round(float(snapshot.confidence), 3),
                                 label=snapshot.label, tasks_done=int(snapshot.tasks_done),
                                 tasks_total=int(snapshot.tasks_total))
                except Exception:
                    return
        threading.Thread(target=tick, name="dgc-eta", daemon=True).start()
        return stop

    def _emit_context(self, request_id: str | None = None) -> None:
        try:
            used = self.agent.estimate_tokens()
        except Exception:
            used = 0
        totals = getattr(self.agent, "usage_totals", {})
        size = self._context_window_size()
        try:
            threshold = float(self.config.get("compact_threshold", 0.85))
        except (AttributeError, TypeError, ValueError):
            threshold = 0.85
        if not math.isfinite(threshold) or threshold <= 0:
            threshold = 0.85
        self.em.emit("context", used=used, size=size,
                     compact_threshold=threshold, compact_at=max(0, int(size * threshold)),
                     input_tokens=int(totals.get("input_tokens", 0)),
                     output_tokens=int(totals.get("output_tokens", 0)),
                     cached_input_tokens=int(totals.get("cached_input_tokens", 0)),
                     reasoning_tokens=int(totals.get("reasoning_tokens", 0)),
                     requests=int(totals.get("requests", 0)), **_request_fields(request_id))

    def _emit_artifacts(self, request_id: str | None = None) -> None:
        from . import artifacts
        self.em.emit("artifacts", items=[{"id": a.id, "name": a.name, "url": a.url,
                                          "rel": a.rel, "uptime": a.uptime}
                                         for a in artifacts.registry()],
                     **_request_fields(request_id))

    def _emit_retained_tasks(self, request_id: str | None = None) -> None:
        tasks, errors = self.agent.retained_tasks()
        self.em.emit("retained_tasks", items=[task.as_dict() for task in tasks[:100]],
                     errors=errors, total=len(tasks), **_request_fields(request_id))

    def _emit_config(self, request_id: str | None = None) -> None:
        c = self.config
        from . import subscriptions as _subs
        self.em.emit("config", model=c.model, mode=self.agent.mode,
                     subscription_engine=str(c.get("subscription_engine", "")),
                     subscription_model=str(c.get("subscription_model", "")),
                     subscription_effort=str(c.get("subscription_effort", "")),
                     subscription_engines=_subs.status(),
                     think=c.get("thinking", "off"), base_url=c.base_url,
                     api_mode=c.get("api_mode", "auto"),
                     provider_state=c.get("provider_state", "stateless"),
                     prompt_cache=bool(c.get("prompt_cache", True)),
                     capability_cache_ttl_s=int(c.get("capability_cache_ttl_s", 300)),
                     provider_capabilities=(self.agent.client.capability_snapshot()
                                            if hasattr(getattr(self.agent, "client", None),
                                                       "capability_snapshot") else {}),
                     project_root=str(c.project_root), search=c.get("search_provider"),
                     subagent_model=c.get("subagent_model", ""),
                     subagent_base_url=c.get("subagent_base_url", ""),
                     subagent_api_mode=c.get("subagent_api_mode", ""),
                     subagent_api_key_set=bool(c.get("subagent_api_key", "")),
                     fallback_model=c.get("fallback_model", ""),
                     fallback_base_url=c.get("fallback_base_url", ""),
                     fallback_api_key_set=bool(c.get("fallback_api_key", "")),
                     fallback_api_mode=c.get("fallback_api_mode", ""),
                     context_size=c.get("context_size", 32768),
                     sandbox=bool(c.get("sandbox", False)),
                     sandbox_network=bool(c.get("sandbox_network", False)),
                     show_reasoning=bool(c.get("show_reasoning", True)),
                     preserve_thinking=bool(c.get("preserve_thinking", False)),
                     ultra_mode=bool(c.get("ultra_mode", False)),
                     code_action=bool(c.get("code_action", False)),
                     suggest=bool(c.get("suggest", True)),
                     plan_artifact=bool(c.get("plan_artifact", True)),
                     artifact_autostart=bool(c.get("artifact_autostart", True)),
                     artifact_in_plan=bool(c.get("artifact_in_plan", False)),
                     tool_profile=str(c.get("tool_profile", "adaptive")),
                     max_parallel_tasks=int(c.get("max_parallel_tasks", 4)),
                     goal=self._goal_snapshot(),
                     **_request_fields(request_id))

    def _goal_elapsed_seconds(self) -> int:
        clock = getattr(self.agent, "goal_elapsed_seconds", None)
        if not callable(clock):
            return 0
        try:
            return max(0, int(clock()))
        except (TypeError, ValueError, OverflowError):
            return 0

    def _emit_goal(self, request_id: str | None = None) -> None:
        self.em.emit("goal_changed", goal=getattr(self.agent, "goal", ""),
                     status=getattr(self.agent, "goal_status", "none"),
                     elapsed_seconds=self._goal_elapsed_seconds(),
                     details=self._goal_snapshot(),
                     **_request_fields(request_id))

    def _goal_snapshot(self) -> dict:
        snapshot = getattr(self.agent, "goal_snapshot", None)
        return snapshot() if callable(snapshot) else {
            "text": getattr(self.agent, "goal", ""), "status": getattr(self.agent, "goal_status", "none"),
            "elapsed_seconds": self._goal_elapsed_seconds()}

    def _history(self) -> list:
        """A display transcript of the current conversation (for resuming in a UI)."""
        items = []
        calls = {}
        for m in self.agent.messages:
            role = m.get("role")
            content = m.get("content")
            if role == "system":
                continue
            if role == "user":
                from .workflows import display_prompt
                if isinstance(content, list):
                    text = display_prompt(_strip_editor_context(" ".join(p.get("text", "") for p in content
                                    if isinstance(p, dict) and p.get("type") == "text"))) + " 📷"
                else:
                    text = display_prompt(_strip_editor_context(str(content)))
                if text.startswith("<tool_results>"):
                    continue
                items.append({"role": "user", "text": text})
            elif role == "assistant":
                tools = [str((tc.get("function") or {}).get("name", ""))[:128] for tc in (m.get("tool_calls") or [])[:16]]
                details = []
                for tc in (m.get("tool_calls") or [])[:16]:
                    function = tc.get("function") or {}
                    arguments = function.get("arguments") or ""
                    detail = {"name": str(function.get("name") or "tool")[:128],
                              "arguments": (arguments if isinstance(arguments, str) else
                                            json.dumps(arguments, ensure_ascii=False))[:1000],
                              "output": "", "status": "unknown"}
                    if tc.get("id"):
                        calls[str(tc["id"])] = detail
                    details.append(detail)
                items.append({"role": "assistant", "text": str(content or ""), "tools": tools,
                              "tool_details": details, "commentary": bool(tools)})
            elif role == "tool":
                detail = calls.pop(str(m.get("tool_call_id") or ""), None)
                if detail is not None:
                    output = str(content or "")
                    detail["output"] = output[:4000] + ("\n[Earlier tool output truncated]" if len(output) > 4000 else "")
                    # The saved protocol lacks a reliable success flag. Preserve the result without
                    # inventing a green success state for failed commands or denials.
                    detail["status"] = "returned"
        # A display projection must not break the editor's bounded NDJSON transport. Session/model
        # history remains intact; this limit applies only to the restored webview payload.
        retained, size = [], 0
        for item in reversed(items):
            text = str(item.get("text") or "")
            if len(text) > 50000:
                item["text"] = text[:50000] + "\n[Long saved message truncated for display]"
            cost = len(json.dumps(item, ensure_ascii=True))
            if retained and size + cost > 1_000_000:
                break
            retained.append(item)
            size += cost
        retained.reverse()
        if len(retained) < len(items):
            retained.insert(0, {"role": "notice", "text": "Showing the most recent saved context. Earlier messages remain in the session file."})
        return retained

    def dispatch(self, cmd: dict) -> None:
        problem = command_error(cmd)
        if problem:
            safe_command = redact_value(
                str(cmd.get("type") or ""), secret_values(getattr(self, "config", None)))
            self.em.emit("command_rejected", command=safe_command[:128],
                         reason="invalid_command", message=f"invalid command: {problem}")
            return
        t = cmd.get("type")
        request_id = None
        if t in _OPTIONALLY_CORRELATED_COMMANDS and "request_id" in cmd:
            request_id = str(cmd.get("request_id") or "")
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return

        if self._busy() and t in _BUSY_MUTATIONS:
            self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                         message=f"'{t}' is unavailable while a turn is running; cancel or wait",
                         **_request_fields(request_id))
            return

        if t == "start_goal":
            # Validate and persist the whole prepared request while no other foreground work can
            # take the turn slot. A rejected selection must not replace the standing goal.
            with self._turn_state_lock():
                if self._busy():
                    self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                 message="Finish or stop the current turn before starting a goal.",
                                 **_request_fields(request_id))
                    return
                text = cmd["text"].strip()
                inputs = {key: cmd[key] for key in ("skills", "templates", "images", "context") if key in cmd}
                if not text or not self.agent.set_goal(text, replace=True, token_budget=cmd.get("token_budget"), inputs=inputs):
                    self.em.emit("command_rejected", command=t, reason="invalid_goal",
                                 message=self.agent._last_persist_error or "Enter a goal objective.",
                                 **_request_fields(request_id))
                    return
                state, _ = self._start_turn(text)
                if state != "started":
                    self.agent.update_goal("paused", reason="The first turn could not start")
                    self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                 message="The goal was saved as paused because its first turn could not start.",
                                 **_request_fields(request_id))
                    return
                self.em.emit("prompt_accepted", request_id=request_id, state=state)

        elif t in ("get_workspace_changes", "get_workspace_change", "get_chat_changes", "get_chat_change"):
            from .editor_changes import EditorChanges
            if getattr(self, "_editor_inspection", None) is None:
                self._editor_inspection = EditorChanges(self.config.project_root, self.em.emit)
                if hasattr(self, "_editor_inspection_roots"):
                    self._editor_inspection.set_roots(self._editor_inspection_roots)
            if t in ("get_chat_changes", "get_chat_change"):
                self._editor_inspection.request(dict(cmd), journal=self.agent.chat_changes,
                    session_id=self.agent.session_file.stem if self.agent.session_file else "")
            else:
                self._editor_inspection.request(dict(cmd))

        elif t == "prompt":
            text = str(cmd.get("text", ""))
            if len(text) > _MAX_PROMPT_CHARS:
                self.em.emit("command_rejected", command=t, reason="prompt_too_large",
                             message=f"prompt exceeds the {_MAX_PROMPT_CHARS}-character limit",
                             **_request_fields(request_id))
                return
            workflow = None
            if "workflow" in cmd:
                from .workflows import prepare_workflow
                try:
                    workflow = prepare_workflow(cmd["workflow"], text, self.agent)
                    if not workflow.prompt:
                        raise ValueError("Enter a task to plan, or use /plan to enter plan mode without sending a prompt.")
                    text = workflow.prompt
                    if len(text) > _MAX_PROMPT_CHARS:
                        raise ValueError("The prepared workflow exceeds the prompt size limit; shorten the request.")
                except ValueError as exc:
                    self.em.emit("command_rejected", command=t, reason="invalid_workflow",
                                 message=str(exc), **_request_fields(request_id))
                    return
            if "skills" in cmd or "templates" in cmd:
                from .composer import compose_prompt
                from .skills import discover_skills, explicit_skill_instructions, format_skill_instructions
                try:
                    # Discovery is a separate snapshot: do not mutate the active turn's catalog
                    # while preflighting a queued prompt. A deleted/disabled selection must be
                    # rejected before acknowledging the draft or changing workflow permissions.
                    catalog = discover_skills(self.config.project_root,
                                              disabled_names=self.config.get("disabled_skills", []))
                    text = compose_prompt(text, skills=cmd.get("skills"),
                                          templates=cmd.get("templates"), catalog=catalog,
                                          project_root=self.config.project_root)
                    context_size = getattr(self.agent, "context_size", None)
                    allowance = min(96_000, max(4_000, context_size() * 2)) if callable(context_size) else 96_000
                    format_skill_instructions(explicit_skill_instructions(catalog, text), allowance)
                except ValueError as exc:
                    self.em.emit("command_rejected", command=t, reason="invalid_selection",
                                 message=str(exc), **_request_fields(request_id))
                    return
            try:
                images = validate_image_data_uris(
                    cmd.get("images"), maximum_file_bytes=MAX_EDITOR_IMAGE_TOTAL_BYTES,
                    maximum_total_bytes=MAX_EDITOR_IMAGE_TOTAL_BYTES)
            except ValueError as exc:
                self.em.emit("command_rejected", command=t, reason="invalid_images",
                             message=f"prompt images rejected: {exc}", **_request_fields(request_id))
                return
            if images and self.config.get("subscription_engine", ""):
                self.em.emit("command_rejected", command=t, reason="unsupported_images",
                             message="Subscription CLI delegation does not support DGC image attachments. Use a native vision model.",
                             **_request_fields(request_id))
                return
            context = cmd.get("context")            # typed editor resources; bounded in _start_turn
            if isinstance(context, list) and any(isinstance(item, dict) and item.get("type") == "mcp_context" for item in context):
                safe = redact_value(context, secret_values(self.config))
                formatted = _format_editor_context(safe)
                retained = json.loads(formatted.split("\n", 2)[1]) if formatted else []
                if any(not any(row.get("type") == "mcp_context" and row.get("server") == item.get("server")
                               and row.get("uri") == item.get("uri") and row.get("text") == item.get("text")
                               for row in retained) for item in safe
                       if isinstance(item, dict) and item.get("type") == "mcp_context"):
                    self.em.emit("command_rejected", command=t, reason="invalid_selection",
                                 message="The selected MCP context exceeds the attachment limit. Remove an attachment or choose a smaller resource.",
                                 **_request_fields(request_id))
                    return
            if text.startswith("/"):               # render a custom slash-command template
                parts = text[1:].split(None, 1)
                custom = discover_commands(self.config.project_root)
                if parts and parts[0] in custom:
                    text = render_command(custom[parts[0]], parts[1] if len(parts) > 1 else "",
                                          self.config.project_root) or text
            if workflow:
                from .workflows import activate_workflow
                with self._turn_state_lock():
                    if getattr(self, "_worker", None) or getattr(self, "_foreground_worker", None):
                        self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                     message="Wait for the current turn to finish before starting a plan, review, or project guide.",
                                     **_request_fields(request_id))
                        return
                    activate_workflow(workflow, self.agent)
                    self.em.emit("mode_changed", mode=self.agent.mode,
                                 workspace_trusted=self.workspace_trusted)
                    state, count = self._start_turn(text, images, context)
            else:
                state, count = self._start_turn(text, images, context,
                    **({"delivery": cmd["delivery"], "request_id": request_id} if "delivery" in cmd else {}))
            if request_id and state in ("started", "queued"):
                self.em.emit("prompt_accepted", request_id=request_id, state=state,
                             **({"message": "Queued for the next turn; this operation cannot accept live steering."}
                                if state == "queued" and cmd.get("delivery") == "steer" else {}))
            if state == "queued":
                self.em.emit("queued", count=count, text=text)
            elif state == "full":
                self.em.emit("command_rejected", command=t, reason="queue_full", count=count,
                             message=("follow-up queue reached its count or aggregate byte limit "
                                      f"({count} queued); cancel it or wait for a turn to finish"),
                             **_request_fields(request_id))
            elif state == "busy":
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="a foreground operation is running; cancel or wait for it to finish",
                             **_request_fields(request_id))
            elif state == "duplicate":
                self.em.emit("command_rejected", command=t, reason="duplicate_request",
                             message="This follow-up is already awaiting delivery.", **_request_fields(request_id))

        elif t == "slash_command":
            text = str(cmd.get("text") or "").strip()
            parts = text[1:].split(None, 1) if text.startswith("/") else []
            custom = discover_commands(self.config.project_root)
            if not parts or parts[0] not in custom:
                self.em.emit("error", message=f"unknown command: {text or '/'}")
                return
            rendered = render_command(custom[parts[0]], parts[1] if len(parts) > 1 else "",
                                      self.config.project_root)
            if not rendered:
                self.em.emit("error", message=f"custom command /{parts[0]} is empty")
            else:
                state, count = self._start_turn(rendered)
                if state == "queued":
                    self.em.emit("queued", count=count, text=text)
                elif state == "full":
                    self.em.emit("command_rejected", command=t, reason="queue_full", count=count,
                                 message=(f"follow-up queue is full ({_MAX_QUEUED_TURNS}); "
                                          "cancel it or wait for a turn to finish"))
                elif state == "busy":
                    self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                 message="a foreground operation is running; cancel or wait for it to finish")

        elif t == "list_mcp_tools":
            request_id = str(cmd.get("request_id") or "")
            offset = cmd.get("offset", 0)
            limit = cmd.get("limit", 50)
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return
            if offset < 0 or offset > 1_000_000 or limit < 1 or limit > _MAX_MCP_LIST_LIMIT:
                self.em.emit("command_rejected", command=t, reason="invalid_page",
                             message=(f"offset must be 0-1000000 and limit 1-"
                                      f"{_MAX_MCP_LIST_LIMIT}"))
                return
            if not self._start_foreground_worker(
                    lambda: self._list_mcp_tools(request_id, offset, limit), label="mcp-list"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="a prompt or MCP operation is already running; cancel or wait")

        elif t == "call_mcp_tool":
            request_id = str(cmd.get("request_id") or "")
            name = str(cmd.get("name") or "")
            call_id = str(cmd.get("call_id") or f"mcp:{request_id}")
            arguments = cmd.get("arguments")
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return
            if not call_id or len(call_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_call_id",
                             message="call_id must contain 1-128 characters")
                return
            if not name.startswith("mcp__") or len(name) > 512:
                self.em.emit("command_rejected", command=t, reason="invalid_mcp_route",
                             message="name must be an exact bounded mcp__server__tool route")
                return
            route_check = getattr(self.agent.mcp, "has_route", None)
            if not callable(route_check) or not route_check(name):
                self.em.emit("mcp_call_complete", request_id=request_id, call_id=call_id,
                             name=name, status="error",
                             output="error: route is not in the connected MCP tool catalog")
                return
            if _json_payload_bytes(arguments) > _MAX_MCP_ARGUMENT_BYTES:
                self.em.emit("command_rejected", command=t, reason="arguments_too_large",
                             message=("MCP arguments must be valid JSON within the "
                                      f"{_MAX_MCP_ARGUMENT_BYTES}-byte limit"))
                return
            if not self._start_foreground_worker(
                    lambda: self._call_mcp_tool(request_id, call_id, name, arguments),
                    label="mcp-call"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="a prompt or MCP operation is already running; cancel or wait")

        elif t in ("list_mcp_context", "get_mcp_context"):
            if (len(cmd["server"]) > 128 or len(cmd["kind"]) > 32
                    or len(str(cmd.get("identifier", ""))) > 4096
                    or len(json.dumps(cmd.get("arguments", {}))) > 32_000):
                self.em.emit("command_rejected", command=t, reason="invalid_mcp_context",
                             message="MCP context selection exceeds its input limit", request_id=cmd["request_id"])
                return
            if not self._start_foreground_worker(lambda: self._mcp_context_operation(cmd), label="mcp-context"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="A turn or MCP operation is already running; cancel or wait", request_id=cmd["request_id"])

        elif t == "list_skills":
            request_id = str(cmd.get("request_id") or "")
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return
            self._emit_skill_catalog(request_id)

        elif t == "get_skill":
            request_id = str(cmd.get("request_id") or "")
            self._emit_skill_detail(request_id, str(cmd.get("name") or ""))

        elif t == "reload_skills":
            request_id = str(cmd.get("request_id") or "")
            self.agent.skills = discover_skills(self.config.project_root,
                                                disabled_names=self.config.get("disabled_skills", []))
            if hasattr(getattr(self.agent, "ctx", None), "skills"):
                self.agent.ctx.skills = self.agent.skills
            self._emit_skill_catalog(request_id)

        elif t in ("create_skill", "install_skill"):
            from .skill_packages import create_skill, install_skill
            request_id = str(cmd.get("request_id") or "")
            try:
                scope = cmd.get("scope", "project")
                if t == "create_skill":
                    result = create_skill(self.config, cmd["name"], cmd.get("description", ""), scope)
                else:
                    result = install_skill(self.config, cmd["source"], scope,
                                           allow_external=cmd.get("allow_external", False))
                self.agent.reload_skills()
                self._emit_skill_catalog(request_id)
                self.em.emit("skill_package", request_id=request_id, name=result["name"],
                             path=result["path"], operation=t, files=result["files"])
            except (OSError, ValueError) as exc:
                self.em.emit("command_rejected", command=t, reason="invalid_skill", request_id=request_id,
                             message=str(exc))

        elif t == "set_skill_enabled":
            from .skills import set_skill_enabled
            request_id = str(cmd.get("request_id") or "")
            try:
                updated = set_skill_enabled(self.config, str(cmd.get("name") or ""), cmd.get("enabled"))
                self.agent.skills.clear()
                self.agent.skills.update(updated)
                self._emit_skill_catalog(request_id)
            except ValueError as exc:
                self.em.emit("command_rejected", command=t, reason="invalid_skill", request_id=request_id,
                             message=str(exc))

        elif t == "list_docs":
            self._emit_docs(str(cmd.get("request_id") or ""))

        elif t == "get_doc":
            self._emit_doc(str(cmd.get("request_id") or ""), str(cmd.get("id") or ""))

        elif t == "list_mcp_servers":
            self._emit_mcp_servers(str(cmd.get("request_id") or ""))

        elif t == "mcp_command":
            if not self._start_foreground_worker(lambda: self._mcp_command(cmd), label="mcp-command"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress", request_id=cmd["request_id"],
                             message="A turn or MCP operation is already running; cancel or wait")

        elif t in ("set_mcp_enabled", "reconnect_mcp_server"):
            if not self._start_foreground_worker(lambda: self._mcp_control(cmd), label="mcp-connection"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress", request_id=cmd["request_id"],
                             message="A turn or MCP operation is already running; cancel or wait")

        elif t == "upsert_mcp_server":
            if cmd.get("interactive"):
                if not self._start_foreground_worker(lambda: self._upsert_mcp_server(
                        cmd["request_id"], cmd["name"], cmd["runtime"], cmd["persisted"],
                        interactive=True), label="mcp-connection"):
                    self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                 request_id=cmd["request_id"], message="A turn or MCP operation is already running")
            else:
                self._upsert_mcp_server(
                    str(cmd.get("request_id") or ""), str(cmd.get("name") or ""),
                    cmd.get("runtime"), cmd.get("persisted"))

        elif t == "remove_mcp_server":
            request_id = str(cmd.get("request_id") or "")
            name = str(cmd.get("name") or "")
            if not _MCP_NAME_RE.fullmatch(name):
                self._emit_mcp_servers(
                    request_id, "server name must use 1-64 letters, digits, ., _, or -")
                return
            servers = dict(self.config.get("mcp_servers", {}) or {})
            servers.pop(name, None)
            self.config.set("mcp_servers", servers)
            if hasattr(self.config, "drop_mcp_secrets"):
                self.config.drop_mcp_secrets(name)
            live = self.agent.mcp.servers.pop(name, None)
            self.agent.mcp.failures.pop(name, None)
            if live is not None:
                live.stop()
            self.agent.mcp._rebuild_routes()
            getattr(self.agent.mcp, "_runtime_specs", {}).pop(name, None)
            disabled = self.config.get("disabled_mcp_servers", [])
            if isinstance(disabled, list) and name in disabled:
                self.config.set("disabled_mcp_servers", [value for value in disabled if value != name])
            getattr(self.agent.mcp, "disabled_names", set()).discard(name)
            self._emit_mcp_servers(request_id)

        elif t == "reload_mcp_servers":
            request_id = str(cmd.get("request_id") or "")
            self.agent.mcp.stop_all()
            servers = (self.config.mcp_runtime_servers()
                       if hasattr(self.config, "mcp_runtime_servers")
                       else self.config.get("mcp_servers", {}))
            self.agent.mcp.connect_all(servers, startup=True)
            self._emit_mcp_servers(request_id)

        elif t == "list_permissions":
            self._emit_permissions(str(cmd.get("request_id") or ""))

        elif t in ("add_permission_rule", "remove_permission_rule"):
            request_id = str(cmd.get("request_id") or "")
            action, rule = str(cmd.get("action") or ""), str(cmd.get("rule") or "").strip()
            try:
                rendered = Rule.parse(rule, action).render()
            except ValueError as exc:
                self.em.emit("command_rejected", command=t, reason="invalid_rule",
                             message=str(exc)[:500], request_id=request_id)
                return
            rules = self.config.permissions.setdefault(action, [])
            if t == "add_permission_rule" and rendered not in rules:
                rules.append(rendered)
            elif t == "remove_permission_rule":
                self.config.permissions[action] = [item for item in rules if item != rendered]
            self.config.save()
            self._emit_permissions(request_id)

        elif t == "get_memory":
            self._emit_memory(str(cmd.get("request_id") or ""))

        elif t == "add_memory":
            from .memory import add_memory
            request_id = str(cmd.get("request_id") or "")
            try:
                add_memory(str(cmd.get("text") or ""), self.config.project_root,
                           str(cmd.get("scope") or "project"), cancelled=self.agent.cancelled)
            except Exception as exc:
                self.em.emit("command_rejected", command=t, reason="memory_save_failed",
                             message=f"memory save failed ({type(exc).__name__}): {str(exc)[:300]}",
                             request_id=request_id)
                return
            self._emit_memory(request_id, f"Saved {cmd.get('scope')} memory")

        elif t == "list_hooks":
            request_id = str(cmd.get("request_id") or "")
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return
            self._emit_hook_catalog(request_id)

        elif t == "generate_handoff":
            request_id = str(cmd.get("request_id") or "")
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return
            if not self._start_foreground_worker(
                    lambda: self._generate_handoff(request_id, bool(cmd.get("save", False))),
                    label="handoff"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="a prompt or foreground operation is already running; cancel or wait")

        elif t == "set_workspace_roots":
            from .workspace import is_within
            if "question_forms" in cmd:
                self.ui.question_forms = cmd["question_forms"]
            roots, visible = [], []
            for raw in cmd.get("roots", []) if isinstance(cmd.get("roots"), list) else []:
                try:
                    path = Path(str(raw)).resolve(strict=True)
                except (OSError, RuntimeError):
                    continue
                if path.is_dir():
                    if path not in visible:
                        visible.append(path)
                    if not is_within(path, self.config.project_root) and path not in roots:
                        roots.append(path)
            self.config.session_permissions = {
                "allow": [f"ExternalDirectory({path})" for path in roots[:32]], "ask": [], "deny": []}
            self._editor_inspection_roots = visible[:16]
            if getattr(self, "_editor_inspection", None) is not None:
                self._editor_inspection.set_roots(self._editor_inspection_roots)
            self.em.emit("workspace_roots", roots=[str(self.config.project_root), *map(str, roots[:32])],
                         **_request_fields(request_id))

        elif t == "permission_response":
            self.pending.resolve(cmd.get("id"), {"decision": cmd.get("decision"), "rule": cmd.get("rule"),
                                                 "reason": cmd.get("reason")})
        elif t == "plan_response":
            self.pending.resolve(cmd.get("id"), {"decision": cmd.get("decision"), "feedback": cmd.get("feedback")})
        elif t == "options_response":
            self.pending.resolve(cmd.get("id"), {"choice": cmd.get("choice"), "answers": cmd.get("answers")})
        elif t == "mcp_input_response":
            self.pending.resolve(cmd.get("id"), {"action": cmd.get("action"),
                                                  "content": cmd.get("content")})

        elif t in ("cancel", "interrupt"):
            with self._turn_state_lock():
                self.agent.cancelled.set()
                self._queue.clear()
            expired = self.pending.cancel_all(
                {"decision": "no", "choice": None, "action": "cancel"})
            for rid in expired:
                self.em.emit("request_expired", id=rid)

        elif t == "set_mode":
            if self._busy() and cmd.get("live") is not True:
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="Update the extension to change modes during a turn.",
                             **_request_fields(request_id))
                return
            mode = cmd.get("mode", "default")
            config_get = getattr(self.config, "get", None)
            active_engine = str(
                config_get("subscription_engine", "") if callable(config_get)
                else getattr(self.config, "data", {}).get("subscription_engine", "")
            ).strip().lower()
            from . import subscriptions as _subscriptions
            try:
                _subscriptions.validate_engine_mode(active_engine, mode)
            except _subscriptions.EngineModeUnsupported as exc:
                self.em.emit("command_rejected", command=t, reason="unsupported_subscription_mode",
                             message=str(exc),
                             **_request_fields(request_id))
                return
            if mode in ("acceptEdits", "auto") and not self.workspace_trusted:
                if cmd.get("acknowledge_workspace_trust") is not True:
                    self.em.emit("command_rejected", command=t, reason="workspace_untrusted",
                                 message="review this workspace and explicitly acknowledge trust before enabling mutations",
                                 **_request_fields(request_id))
                    return
                from .trust import mark_trusted
                mark_trusted(self.config, self.config.project_root)
                self.workspace_trusted = True
            self.agent.set_mode(mode)
            self.em.emit("mode_changed", mode=self.agent.mode,
                         workspace_trusted=self.workspace_trusted,
                         **({"message": "The new mode applies when the next subscription turn starts; the running external CLI keeps its launch permissions."}
                            if active_engine and self._busy() else {}),
                         **_request_fields(request_id))
        elif t == "set_model":
            config_get = getattr(self.config, "get", None)
            active_engine = str(
                config_get("subscription_engine", "") if callable(config_get)
                else getattr(self.config, "data", {}).get("subscription_engine", "")
            ).strip().lower()
            route = str(cmd.get("route") or "").strip().lower()
            if route not in ("", "native", "subscription"):
                self.em.emit("command_rejected", command=t, reason="invalid_route",
                             message="model route must be native or subscription",
                             **_request_fields(request_id))
                return
            # A model-only command means "the active chat route".  Meaningful connection fields
            # are an unambiguous native-provider operation (settings hydration and /connect).
            # Ignore old protocol clients' serialized no-op defaults (`base_url: ""` and
            # `clear_stored_api_key: false`) so they cannot silently retarget a delegated model.
            # Merely supplying api_key remains deliberate, including the empty string used to
            # clear a process-local editor credential.
            native_connection = (route == "native" or bool(cmd.get("base_url"))
                                 or "api_key" in cmd or cmd.get("clear_stored_api_key") is True)
            if route == "subscription" and not active_engine:
                self.em.emit("command_rejected", command=t, reason="route_unavailable",
                             message="no subscription engine is active",
                             **_request_fields(request_id))
                return
            if route == "subscription" and native_connection:
                self.em.emit("command_rejected", command=t, reason="route_conflict",
                             message="subscription model changes cannot include native connection fields",
                             **_request_fields(request_id))
                return
            if active_engine and "model" in cmd and not native_connection:
                model = str(cmd.get("model") or "").strip()
                if len(model) > 256 or any(ord(char) < 32 for char in model):
                    self.em.emit("command_rejected", command=t, reason="invalid_config_value",
                                 message="subscription model must be a bounded plain string",
                                 **_request_fields(request_id))
                    return
                self.config.set("subscription_model", model)
                self.em.emit("model_changed", model=model, base_url=self.config.base_url,
                             **_request_fields(request_id))
                return
            if cmd.get("clear_stored_api_key"):
                # The editor owns its active credential in SecretStorage. When it explicitly
                # switches provider, erase any older CLI secret so a later CLI launch cannot
                # attach that credential to the newly persisted endpoint.
                self.config.data["api_key"] = ""
                if hasattr(self.config, "_stored_secrets"):
                    self.config._stored_secrets["api_key"] = ""
                if hasattr(self.config, "_stored_provider_identity"):
                    self.config._stored_provider_identity.pop("api_key", None)
                runtime_secret = getattr(self.config, "set_runtime_secret", None)
                if callable(runtime_secret):
                    runtime_secret("api_key", "")
                else:
                    self.config._env_secret_keys.add("api_key")
            if cmd.get("base_url"):
                self.config.set("base_url", cmd["base_url"])
            if "api_key" in cmd:
                # Editor credentials are owned by VS Code SecretStorage. Keep this process-local;
                # a later non-secret config save preserves any existing CLI secret instead of
                # duplicating the editor key into ~/.dgc/secrets.json.
                runtime_secret = getattr(self.config, "set_runtime_secret", None)
                if callable(runtime_secret):
                    runtime_secret("api_key", str(cmd.get("api_key") or ""))
                else:
                    self.config.data["api_key"] = str(cmd.get("api_key") or "")
                    self.config._env_secret_keys.add("api_key")
            if cmd.get("model"):
                self.config.set("model", cmd["model"])
            self.agent.refresh_client()
            recommend = getattr(self.agent, "recommended_context_size", None)
            ctx = (recommend() if cmd.get("model") and callable(recommend) else None)
            context_changed = False
            if ctx and ctx != int(self.config.get("context_size", 32768)):
                self.config.set("context_size", ctx)
                context_changed = True
            # While delegation is active, keep the public model control aligned with the route a
            # prompt will use even when a settings operation updates the native fallback.
            shown_model = (str(config_get("subscription_model", "")).strip()
                           if active_engine and callable(config_get) else self.config.model)
            self.em.emit("model_changed", model=shown_model, base_url=self.config.base_url,
                         **_request_fields(request_id))
            # A model refresh can change the provider-advertised effective limit even when the
            # configured recommendation happens to be identical. Never leave the editor meter on
            # the prior model's window.
            self._emit_context(request_id if context_changed else None)
        elif t == "list_models":
            request_id = redact_value(
                str(cmd.get("request_id") or ""), secret_values(self.config))[:128]
            lock = self._model_list_lock
            if not lock.acquire(blocking=False):
                self.em.emit("models", request_id=request_id, ids=[],
                             base_url=self.config.base_url,
                             error="model discovery is already in progress")
                return

            def discover_models():
                try:
                    # Use a separate adapter instance so discovery cannot mutate an active turn's
                    # transport state. It still shares bounded endpoint+model capability evidence.
                    client = self.agent._new_client(
                        self.config.base_url, self.config.api_key, self.config.model)
                    ids = [redact_value(item, secret_values(self.config))[:512]
                           for item in client.list_models()[:4096]
                           if isinstance(item, str)]
                    self.em.emit("models", request_id=request_id, ids=ids,
                                 base_url=self.config.base_url, api_mode=client.api_mode)
                except Exception as exc:
                    self.em.emit("models", request_id=request_id, ids=[],
                                 base_url=self.config.base_url,
                                 error=f"model discovery failed ({type(exc).__name__[:80]})")
                finally:
                    lock.release()
            threading.Thread(target=discover_models, daemon=True).start()
        elif t == "set_think":
            level = str(cmd.get("level", "off"))
            config_get = getattr(self.config, "get", None)
            active_engine = str(
                config_get("subscription_engine", "") if callable(config_get)
                else getattr(self.config, "data", {}).get("subscription_engine", "")
            ).strip().lower()
            if active_engine:
                from . import subscriptions as _subs
                engine = _subs.get_engine(active_engine)
                effort = "" if level == "off" else level
                if engine is None:
                    self.em.emit("command_rejected", command=t, reason="invalid_config_value",
                                 message=f"unknown subscription engine '{active_engine}'",
                                 **_request_fields(request_id))
                    return
                if effort and not engine.supports_effort():
                    self.em.emit(
                        "command_rejected", command=t, reason="invalid_config_value",
                        message=f"{engine.short_label} does not expose a reasoning-effort flag; "
                                "choose its reasoning model with /model instead",
                        **_request_fields(request_id))
                    return
                self.config.set("subscription_effort", effort)
                self.em.emit("think_changed", think=effort or "off",
                             **_request_fields(request_id))
            else:
                if level == "max":
                    self.em.emit(
                        "command_rejected", command=t, reason="invalid_config_value",
                        message="max reasoning effort is available only on a supported subscription route",
                        **_request_fields(request_id))
                    return
                self.config.set("thinking", level)   # persisted native route
                self.em.emit("think_changed", think=self.config.get("thinking", "off"),
                             **_request_fields(request_id))
        elif t == "set_goal":
            status = str(cmd.get("status") or "active")
            text = str(cmd.get("text") or "")
            if status == "none":
                ok = self.agent.set_goal("")
            elif text:
                ok = self.agent.set_goal(
                    text, status, token_budget=cmd.get("token_budget"), replace=bool(cmd.get("replace")))
            else:
                ok = self.agent.update_goal(status)
            if not ok:
                message = getattr(self.agent, "_last_persist_error", "")
                self.em.emit("error", message=message or "no standing goal to update",
                             **_request_fields(request_id))
                return
            self._emit_goal(request_id)
        elif t == "get_goal":
            self._emit_goal(request_id)
        elif t == "get_plan":
            plan = (sessions_mod.load_plan(self.agent.session_file, self.config.project_root)
                    if self.agent.session_file else None)
            self.em.emit("saved_plan", plan=plan or "", exists=bool(plan),
                         **_request_fields(request_id))

        elif t == "new_session":
            self.agent.reset()
            self.agent.session_file = sessions_mod.new_path(self.config.project_root)
            self.em.emit("session", kind="new", message_count=0,
                         session_id=self.agent.session_file.stem, name="",
                         **_request_fields(request_id))
            self._emit_context(request_id)
            self._emit_goal()
        elif t == "name_session":
            name = str(cmd.get("name") or "").strip()[:200]
            if not name or not self.agent.name_session(name):
                self.em.emit("command_rejected", command=t, reason="session_name_failed",
                             message=getattr(self.agent, "_last_persist_error", "")
                             or "session name must not be empty",
                             **_request_fields(request_id))
                return
            self.em.emit("session_named", name=str(self.agent.session_name or ""),
                         **_request_fields(request_id))
        elif t == "clear_session":
            # Archive the prior persisted transcript and start an actually empty model context.
            # The old webview implementation only removed DOM nodes while the model retained every
            # prior turn, which made `/clear` misleading and potentially leaked stale context.
            self.agent.reset()
            self.agent.session_file = sessions_mod.new_path(self.config.project_root)
            self.em.emit("session", kind="cleared", message_count=0,
                         session_id=self.agent.session_file.stem, name="",
                         **_request_fields(request_id))
            self.em.emit("history", items=[])
            self._emit_context()
            self._emit_goal()
        elif t == "resume_session":
            path = cmd.get("path")
            if not path and cmd.get("latest"):
                p = sessions_mod.latest(self.config.project_root)
                path = str(p) if p else None
            if path:
                try:
                    n = self.agent.load_session(path)
                except (OSError, ValueError) as exc:
                    self.em.emit("command_rejected", command=t, reason="session_unavailable",
                                 message=redact_value(str(exc), secret_values(self.config)),
                                 **_request_fields(request_id))
                    return
                self.em.emit("session", kind="resumed", message_count=n, path=str(path),
                             session_id=Path(path).stem,
                             name=str(self.agent.session_name or ""),
                             **_request_fields(request_id))
                self.em.emit("history", items=self._history())
                self._emit_context()
                self._emit_goal()
            else:
                self.em.emit("error", message="no session to resume",
                             **_request_fields(request_id))
        elif t == "get_history":
            self.em.emit("history", items=self._history(), request_id=cmd["request_id"])

        elif t == "list_sessions":
            items = [{"path": str(p), "when": sessions_mod.when(ts), "preview": pv, "count": c,
                      "name": nm}
                     for (p, ts, pv, c, nm) in sessions_mod.listing(self.config.project_root)]
            self.em.emit("sessions", items=items, **_request_fields(request_id))
        elif t == "delete_session":
            path = cmd.get("path")
            ok = bool(path) and sessions_mod.delete(path, self.config.project_root)
            items = [{"path": str(p), "when": sessions_mod.when(ts), "preview": pv, "count": c,
                      "name": nm}
                     for (p, ts, pv, c, nm) in sessions_mod.listing(self.config.project_root)]
            self.em.emit("sessions", items=items, deleted=ok, **_request_fields(request_id))

        elif t == "list_checkpoints":
            items = [{"index": i, "preview": p, "files": nf}
                     for (i, p, nf) in self.agent.checkpoints.listing()]
            self.em.emit("checkpoints", items=items, **_request_fields(request_id))
        elif t == "rewind":
            msgs, nfiles = self.agent.rewind(int(cmd.get("index", -1)))
            ok = msgs >= 0
            self.em.emit("rewound", ok=ok, files_restored=nfiles,
                         **_request_fields(request_id))
            if ok:
                self.em.emit("history", items=self._history())
                self._emit_context()
        elif t == "list_retained_tasks":
            self._emit_retained_tasks(request_id)
        elif t == "resolve_retained_task":
            task_id = str(cmd.get("id", ""))
            action = str(cmd.get("action", ""))
            if action == "drop" and cmd.get("confirm") is not True:
                self.em.emit("error", message="dropping retained work requires explicit confirmation",
                             **_request_fields(request_id))
                self._emit_retained_tasks(request_id)
                return
            result = self.agent.resolve_retained_task(task_id, action)
            if result.status == "applied":
                warning = f" Cleanup warning: {result.cleanup_error}." if result.cleanup_error else ""
                self.em.emit("info", message=f"Applied retained task {task_id}: "
                             f"{len(result.paths)} path(s). Use rewind to undo.{warning}")
            elif result.status == "clean":
                warning = f" Cleanup warning: {result.cleanup_error}." if result.cleanup_error else ""
                self.em.emit("info", message=f"Retained task {task_id} had no remaining changes.{warning}")
            elif result.status == "dropped":
                self.em.emit("info", message=f"Dropped retained task {task_id}.")
            else:
                conflicts = (f" Conflicts: {', '.join(result.conflicts[:12])}."
                             if result.conflicts else "")
                self.em.emit("error", message=f"Could not {action} retained task {task_id}: "
                             f"{result.error or result.status}.{conflicts}")
            self._emit_retained_tasks(request_id)
        elif t == "compact":
            if not self.agent.maybe_compact(force=True, trigger="manual", notify=False):
                self.em.emit("command_rejected", command=t, reason="compaction_failed",
                             message=self.agent._last_persist_error
                             or "context compaction failed", **_request_fields(request_id))
                return
            self.em.emit("compacted", **self.agent.compaction_status(),
                         **_request_fields(request_id))
            self._emit_context(request_id)
        elif t == "list_artifacts":
            self._emit_artifacts(request_id)
        elif t == "stop_artifact":
            from . import artifacts
            artifacts.stop(str(cmd.get("id", "")))
            self._emit_artifacts(request_id)
        elif t == "set_config":
            from .subscriptions import ENGINE_KEYS as _sub_keys
            values, problem = _validated_config_values(cmd.get("values"), _sub_keys)
            if problem or values is None:
                self.em.emit("command_rejected", command=t, reason="invalid_config_value",
                             message=problem or "invalid settings values",
                             **_request_fields(request_id))
                return
            config_get = getattr(self.config, "get", None)
            current_engine = (config_get("subscription_engine", "") if callable(config_get) else
                              getattr(self.config, "data", {}).get("subscription_engine", ""))
            selected_engine = str(values.get("subscription_engine", current_engine))
            from . import subscriptions as _subscriptions
            try:
                _subscriptions.validate_engine_mode(
                    selected_engine,
                    str(getattr(self.agent, "mode", None)
                        or (config_get("mode", "default") if callable(config_get) else "default")),
                )
            except _subscriptions.EngineModeUnsupported as exc:
                self.em.emit("command_rejected", command=t, reason="invalid_config_value",
                             message=str(exc),
                             **_request_fields(request_id))
                return
            if selected_engine in ("qwen", "kimi") and values.get("subscription_effort"):
                self.em.emit("command_rejected", command=t, reason="invalid_config_value",
                             message=f"{selected_engine} does not expose a subscription effort flag",
                             **_request_fields(request_id))
                return
            previous_engine = str(current_engine)
            if "subscription_engine" in values and selected_engine != previous_engine:
                values.setdefault("subscription_model", "")
                values.setdefault("subscription_effort", "")
            if "subscription_engine" in values and not selected_engine:
                values["subscription_model"] = ""
                values["subscription_effort"] = ""
            if values.get("sandbox") is True:
                from . import sandbox
                if not sandbox.available():
                    self.em.emit(
                        "command_rejected", command=t, reason="sandbox_unavailable",
                        message="sandbox remains off because no supported confinement backend was found",
                        **_request_fields(request_id))
                    return
            secret_keys = ("subagent_api_key", "fallback_api_key")
            refresh = bool(set(values) & {
                "api_mode", "provider_state", "prompt_cache", "prompt_cache_key",
                "provider_capabilities", "capability_cache_ttl_s", "context_size",
            })
            # Config.set normally persists each key. Suspend that behavior while staging so another
            # process cannot observe half of a route change, then commit the complete validated
            # snapshot once. Endpoint invalidation still runs before process-local replacement keys.
            data_before = copy.deepcopy(self.config.data)
            attr_before = {
                attr: copy.deepcopy(getattr(self.config, attr))
                for attr in ("_stored_secrets", "_stored_provider_identity",
                             "_provider_secret_identity", "_env_secret_keys", "_explicit_keys")
                if hasattr(self.config, attr)
            }
            missing = object()
            client_before = getattr(self.agent, "client", missing)
            gate_before = getattr(self.agent, "autonomous_gate", missing)
            gate_max_before = getattr(self.agent, "autonomous_max_turns", missing)
            has_persist_flag = hasattr(self.config, "_persist")
            persist_before = getattr(self.config, "_persist", None)
            try:
                if has_persist_flag:
                    self.config._persist = False
                for key, value in values.items():
                    if key not in secret_keys:
                        self.config.set(key, value)
                if has_persist_flag:
                    self.config._persist = persist_before
                for key in secret_keys:
                    if key in values:
                        runtime_secret = getattr(self.config, "set_runtime_secret", None)
                        if callable(runtime_secret):
                            runtime_secret(key, values[key])
                        else:
                            self.config.data[key] = values[key]
                            self.config._env_secret_keys.add(key)
                save = getattr(self.config, "save", None)
                if callable(save):
                    save()
                if refresh:
                    self.agent.refresh_client()
                elif "ultra_mode" in values:
                    # Ultra changes the trusted system policy/tool exposure immediately without
                    # rebuilding the provider transport.
                    self.agent._refresh_system()
                # These settings are cached on the agent at construction; publish them only after
                # both the durable commit and any client rebuild have succeeded.
                if "autonomous_gate" in values:
                    self.agent.autonomous_gate = values["autonomous_gate"]
                if "autonomous_max_turns" in values:
                    self.agent.autonomous_max_turns = values["autonomous_max_turns"]
            except Exception as exc:
                if has_persist_flag:
                    self.config._persist = persist_before
                self.config.data = data_before
                for attr, snapshot in attr_before.items():
                    setattr(self.config, attr, snapshot)
                if client_before is not missing:
                    self.agent.client = client_before
                if gate_before is not missing:
                    self.agent.autonomous_gate = gate_before
                if gate_max_before is not missing:
                    self.agent.autonomous_max_turns = gate_max_before
                try:
                    save = getattr(self.config, "save", None)
                    if callable(save):
                        save()
                except Exception:
                    pass
                self.em.emit(
                    "command_rejected", command=t, reason="config_apply_failed",
                    message=f"settings were not applied ({type(exc).__name__})",
                    **_request_fields(request_id))
                return
            finally:
                if has_persist_flag:
                    self.config._persist = persist_before
            self._emit_config(request_id)
            if "context_size" in values:
                self._emit_context(request_id)
        elif t == "get_config":
            self._emit_config(request_id)
        elif t == "status":
            active_engine = str(self.config.get("subscription_engine", "") or "").strip()
            active_model = (str(self.config.get("subscription_model", "") or "").strip()
                            or f"{active_engine} default") if active_engine else self.config.model
            active_think = (str(self.config.get("subscription_effort", "") or "").strip()
                            or "off") if active_engine else self.config.get("thinking", "off")
            self.em.emit("status", model=active_model, mode=self.agent.mode,
                         think=active_think, base_url=self.config.base_url,
                         subscription_engine=active_engine,
                         ultra_mode=bool(self.config.get("ultra_mode", False)),
                         goal=self._goal_snapshot(),
                         context_used=self.agent.estimate_tokens(),
                         context_size=self._context_window_size(), **_request_fields(request_id))
        elif t == "shutdown":
            raise _Shutdown()
        else:
            self.em.emit("error", message=f"unknown command: {t!r}")


def serve(config: Config) -> None:
    """Run the headless backend: emit `ready`, then loop over stdin commands until EOF/shutdown."""
    backend = Backend(config)
    backend.start()
    try:
        for line, frame_problem in _command_lines(sys.stdin):
            if frame_problem:
                backend.em.emit("error", message=frame_problem)
                continue
            line = line.strip()
            if not line:
                continue
            try:
                cmd = strict_json_loads(line)
            except (json.JSONDecodeError, ValueError):
                backend.em.emit("error", message="invalid JSON command line")
                continue
            if not isinstance(cmd, dict):
                backend.em.emit("error", message="command must be a JSON object")
                continue
            try:
                backend.dispatch(cmd)
            except _Shutdown:
                break
            except Exception as e:             # one bad command must NOT kill the whole backend
                import traceback
                detail = str(e).strip() or e.__class__.__name__
                backend.em.emit("error", message=f"Command '{cmd.get('type', '?')}' failed — {detail}")
                sys.stderr.write(traceback.format_exc())    # full trace → the extension's stderr channel
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    backend.close()
