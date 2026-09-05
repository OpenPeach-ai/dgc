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
from .commands import (
    custom_command_names, discover_commands, editor_command_metadata, render_command,
)
from .config import Config, mcp_url_has_credentials, persisted_mcp_args_safe, valid_remote_mcp_url
from .editor_protocol import (MAX_COMMAND_BYTES, MAX_SAFE_INTEGER, PROTOCOL_VERSION,
                              command_error, event_error)
from .permissions import Rule, rule_for
from .protocol import Emitter, PendingRequests, strict_json_loads
from .redaction import redact_value, secret_values
from .hooks import hook_catalog
from .skills import discover_skills, normalize_skill_name, skill_catalog
from .tools import TOOL_SCHEMAS
from .ui import arg_summary, split_diff, tool_output_is_error

_PLAN_MODES = ("auto", "acceptEdits", "default")
_MAX_QUEUED_TURNS = 32
_MAX_QUEUED_TURN_BYTES = 16 * 1024 * 1024
_MAX_PROMPT_CHARS = 1_000_000
_MAX_MCP_ARGUMENT_BYTES = 1024 * 1024
_MAX_MCP_LIST_BYTES = 1024 * 1024
_MAX_MCP_LIST_LIMIT = 100
_MAX_MCP_SERVERS = 64
_MCP_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
_MCP_ENV_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}\Z")
_MCP_LOG_LEVELS = frozenset({
    "debug", "info", "notice", "warning", "error", "critical", "alert", "emergency", "off",
})
_BUSY_MUTATIONS = {
    "set_mode", "set_model", "set_think", "new_session", "clear_session", "resume_session",
    "delete_session", "rewind", "compact", "set_config", "set_workspace_roots", "set_goal",
    "resolve_retained_task", "list_skills", "reload_skills", "generate_handoff", "name_session",
    "upsert_mcp_server", "remove_mcp_server", "reload_mcp_servers",
    "add_permission_rule", "remove_permission_rule", "add_memory",
}
_OPTIONALLY_CORRELATED_COMMANDS = frozenset({
    "set_workspace_roots", "set_mode", "set_model", "set_think", "set_goal", "get_goal",
    "get_plan", "new_session", "clear_session", "resume_session", "list_sessions",
    "delete_session", "list_checkpoints", "rewind", "list_retained_tasks",
    "resolve_retained_task", "compact", "list_artifacts", "stop_artifact", "set_config",
    "get_config", "status", "name_session", "reload_skills", "get_skill", "list_docs", "get_doc",
    "list_mcp_servers", "upsert_mcp_server", "remove_mcp_server", "reload_mcp_servers",
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


def _mcp_spec(value, *, persisted: bool) -> tuple[dict | None, str | None]:
    """Validate one bounded editor MCP spec; persisted specs can never carry secret values."""
    if not isinstance(value, dict):
        return None, "server specification must be an object"
    allowed = {"transport", "command", "args", "env", "env_names", "auth_env", "url", "log_level",
               "defer_until_setup"}
    if set(value) - allowed:
        return None, "server specification contains unsupported fields"
    command = value.get("command")
    if not isinstance(command, str) or not command.strip() or len(command) > 4096 or "\x00" in command:
        return None, "server command must contain 1-4096 safe characters"
    args = value.get("args", [])
    if (not isinstance(args, list) or len(args) > 128
            or any(not isinstance(arg, str) or len(arg) > 8192 or "\x00" in arg for arg in args)):
        return None, "server arguments must be an array of at most 128 bounded strings"
    transport = str(value.get("transport") or "stdio")
    if transport not in ("stdio", "remote"):
        return None, "server transport must be stdio or remote"
    url = str(value.get("url") or "")
    if transport == "remote":
        if not valid_remote_mcp_url(url):
            return None, "remote MCP servers require HTTPS (or loopback HTTP) without URL credentials"
    log_level = str(value.get("log_level") or "warning").lower()
    if log_level not in _MCP_LOG_LEVELS:
        return None, "server log level is unsupported"
    env_names = value.get("env_names", [])
    if (not isinstance(env_names, list) or len(env_names) > 64
            or any(not isinstance(name, str) or not _MCP_ENV_RE.fullmatch(name)
                   for name in env_names)):
        return None, "env_names must contain at most 64 environment variable names"
    auth_env = value.get("auth_env", "")
    if not isinstance(auth_env, str) or (auth_env and not _MCP_ENV_RE.fullmatch(auth_env)):
        return None, "auth_env must be a valid environment variable name"
    if auth_env and auth_env not in env_names:
        return None, "auth_env must also be declared in env_names"
    remote_bridge = (transport == "remote" and command.strip() == "npx"
                     and len(args) >= 3 and args[:2] == ["-y", "mcp-remote"]
                     and args[2] == url)
    if transport == "remote" and not remote_bridge:
        return None, ("remote MCP servers must use the standard npx -y mcp-remote bridge "
                      "with the same validated URL")
    if auth_env and not remote_bridge:
        return None, "auth_env is supported only by the standard remote MCP bridge"
    env = value.get("env", {})
    if not isinstance(env, dict) or len(env) > 64:
        return None, "server env must be an object with at most 64 entries"
    if persisted and env:
        return None, "persisted MCP specifications cannot contain environment values"
    if persisted and not persisted_mcp_args_safe(args):
        return None, ("persisted MCP specifications cannot contain inline secrets; "
                      "declare tokens, headers, or credentials via env_names")
    if any(not isinstance(name, str) or not _MCP_ENV_RE.fullmatch(name)
           or not isinstance(item, str) or len(item) > 16_384 or "\x00" in item
           for name, item in env.items()):
        return None, "server env contains an invalid name or value"
    if set(env) - set(env_names):
        return None, "runtime env keys must be declared in env_names"
    defer_until_setup = value.get("defer_until_setup", False)
    if not isinstance(defer_until_setup, bool):
        return None, "defer_until_setup must be true or false"
    clean = {"transport": transport, "command": command.strip(), "args": list(args),
             "env_names": list(dict.fromkeys(env_names)), "log_level": log_level}
    if auth_env:
        clean["auth_env"] = auth_env
    if defer_until_setup:
        clean["defer_until_setup"] = True
    if url:
        clean["url"] = url
    if env:
        clean["env"] = dict(env)
    return clean, None


def _request_fields(request_id: str | None) -> dict[str, str]:
    """Attach a correlation ID only when the optional command field was present and valid."""
    return {"request_id": request_id} if request_id else {}


def _editor_context_json(value) -> str:
    """Encode JSON without allowing source text to synthesize our framing delimiter."""
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            .replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e"))


def _format_editor_context(resources) -> str:
    """Bound and frame typed editor resources as untrusted reference data for the model."""
    if not isinstance(resources, list):
        return ""
    allowed = {"type", "uri", "path", "relative_path", "workspace", "language", "range",
               "text", "diagnostics"}
    encoded_items: list[str] = []
    def bounded(value, depth=0):
        if depth > 4:
            return None
        if isinstance(value, str):
            return value[:2_000]
        if isinstance(value, (int, float, bool)) or value is None:
            return value
        if isinstance(value, list):
            return [bounded(part, depth + 1) for part in value[:50]]
        if isinstance(value, dict):
            return {str(k)[:80]: bounded(v, depth + 1) for k, v in list(value.items())[:50]}
        return None
    for item in resources[:64]:
        if not isinstance(item, dict):
            continue
        resource = {}
        for key in allowed:
            value = item.get(key)
            if value is None:
                continue
            if key == "diagnostics" and isinstance(value, list):
                value = bounded(value)
            elif isinstance(value, str):
                value = value[:16_000]
            elif isinstance(value, (dict, list, int, float, bool)):
                value = bounded(value)
            else:
                continue
            resource[key] = value
        encoded = _editor_context_json(resource)
        # Include the list brackets and separators in the actual wire-size bound.
        candidate_size = 2 + sum(len(part.encode("utf-8")) for part in encoded_items) \
            + len(encoded_items) + len(encoded.encode("utf-8"))
        if candidate_size > _EDITOR_CONTEXT_LIMIT:
            break
        encoded_items.append(encoded)
    if not encoded_items:
        return ""
    payload = "[" + ",".join(encoded_items) + "]"
    return ("<editor-context-json trust=\"untrusted-reference-data\">\n" + payload
            + "\n</editor-context-json>\n\n")


def _strip_editor_context(text: str) -> str:
    if text.startswith("<editor-context-json ") and "</editor-context-json>\n\n" in text:
        return text.split("</editor-context-json>\n\n", 1)[1]
    return text


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
        self._rule_hook = None          # set by Backend to persist an allow rule
        self._rule_override: dict = {}   # tool -> explicit rule string the IDE dictated
        self.plan_feedback = ""         # one-shot feedback consumed by Agent after rejection

    # streaming ----------------------------------------------------------------
    def on_text(self, chunk: str) -> None:
        self.em.emit("text_delta", text=chunk)

    def on_thinking(self, chunk: str) -> None:
        self.em.emit("thinking_delta", text=chunk)

    def end_stream(self) -> None:
        self.em.emit("stream_end")

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
    def _await(self, rid: str, ev: threading.Event, cancel=None):
        deadline = time.monotonic() + self.approval_timeout_s
        while not ev.wait(min(0.1, max(0.0, deadline - time.monotonic()))):
            if cancel is not None and cancel.is_set():
                self.pending.value(rid)
                self.em.emit("request_expired", id=rid)
                return None
            if time.monotonic() >= deadline:
                self.pending.value(rid)  # discard it so a late response cannot affect another request
                self.em.emit("request_expired", id=rid)
                return None
        return self.pending.value(rid)

    def approve(self, name: str, args: dict, call_id: str | None = None) -> str:
        rid, ev = self.pending.register()
        self.em.emit("permission_request", id=rid, call_id=call_id, name=name, args=args,
                     command=(args.get("command") if name == "bash" else None),
                     suggested_rule=str(rule_for(name, args)),
                     choices=["once", "always", "deny"])
        payload = self._await(rid, ev) or {}
        if payload.get("rule"):
            self._rule_override[name] = payload["rule"]
        return {"once": "once", "always": "always",
                "deny": "no", "no": "no"}.get(payload.get("decision"), "no")

    def add_permission_rule(self, name: str, args: dict) -> None:
        rule = self._rule_override.pop(name, None) or str(rule_for(name, args))
        if self._rule_hook:
            self._rule_hook(rule)
        self.em.emit("rule_added", rule=rule)

    def present_plan(self, plan: str):
        rid, ev = self.pending.register()
        self.em.emit("plan_proposal", id=rid, plan=plan,
                     choices=["auto", "acceptEdits", "default", "reject"])
        payload = self._await(rid, ev) or {}
        self.plan_feedback = str(payload.get("feedback") or "").strip()
        decision = payload.get("decision")
        if decision in _PLAN_MODES:
            self.plan_feedback = ""
        return decision if decision in _PLAN_MODES else None

    def propose_options(self, question: str, options: list) -> str:
        rid, ev = self.pending.register()
        self.em.emit("options_request", id=rid, question=question, options=options)
        payload = self._await(rid, ev) or {}
        choice = payload.get("choice")
        if isinstance(choice, int) and 1 <= choice <= len(options):
            return options[choice - 1]
        if isinstance(choice, str) and choice:
            return choice
        return options[0] if options else ""

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
        self.agent = Agent(config, self.ui)
        self.ui._rule_hook = self._add_rule
        self.agent.session_file = sessions_mod.new_path(config.project_root)
        self._worker: threading.Thread | None = None
        self._foreground_worker: threading.Thread | None = None
        self._turn_lock = threading.RLock()
        self._turn_n = 0
        self._queue: list[tuple[str, object, object]] = []  # ordered (prompt, images, typed context)
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
                          "goal_state": True, "saved_plan": True, "command_registry": True,
                          "provider_model_discovery": True, "headless_mcp_catalog": True,
                          "headless_mcp_call": True, "headless_skill_catalog": True,
                          "headless_feature_management": True,
                          "headless_handoff": True, "headless_hook_catalog": True,
                          "hook_activity": True, "correlated_state_requests": True,
                          "ultra_profile": True},
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
            goal={"text": self.agent.goal, "status": self.agent.goal_status,
                  "elapsed_seconds": self._goal_elapsed_seconds()},
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

    def _start_turn(self, text: str, images=None, context=None) -> tuple[str, int]:
        """Start or queue one turn atomically; return (started|queued|full, pending count)."""
        lock = self._turn_state_lock()
        with lock:
            if getattr(self, "_foreground_worker", None) is not None:
                return "busy", 0
            if getattr(self, "_worker", None) is not None:
                pending_bytes = sum(_turn_payload_bytes(*item) for item in self._queue)
                if (len(self._queue) >= _MAX_QUEUED_TURNS
                        or pending_bytes + _turn_payload_bytes(text, images, context)
                        > _MAX_QUEUED_TURN_BYTES):
                    return "full", len(self._queue)
                self._queue.append((text, images, context))
                return "queued", len(self._queue)
            self._queue.append((text, images, context))
            worker = threading.Thread(target=self._run_turn_queue, daemon=True,
                                      name="dgc-headless-turns")
            self._worker = worker
            worker.start()
            return "started", 0

    def _run_subscription_turn(self, engine_key: str, prompt: str) -> bool:
        """Delegate one editor turn while preserving the native headless event contract."""
        from . import subscriptions as subs
        engine = subs.get_engine(engine_key)
        if engine is None:
            self.ui.error(f"unknown subscription engine '{engine_key}'")
            return False
        mode = str(self.config.data.get("mode", "default"))
        model = str(self.config.get("subscription_model", "")).strip()
        configured_effort = str(self.config.get("subscription_effort", "")).strip()
        from .ultra import delegated_effort, delegated_prompt
        effort = delegated_effort(
            self.config, engine.key, configured_effort, engine.supports_effort())
        session_id = self.agent.subscription_session_id(engine.key, mode, model, effort)
        names: dict[str, str] = {}
        diffs: dict[str, str] = {}
        shown = {"text": False}

        def on_event(event: dict) -> None:
            kind = event.get("kind")
            if kind == "text" and event.get("text"):
                shown["text"] = True
                self.ui.on_text(event["text"])
            elif kind == "thinking" and event.get("text"):
                self.ui.on_thinking(event["text"])
            elif kind == "tool_call":
                name = str(event.get("name") or "tool")
                call_id = str(event.get("id") or "") or None
                args = event.get("args") if isinstance(event.get("args"), dict) else {}
                if call_id:
                    names[call_id] = name
                    diff = subs.edit_diff(name, args)
                    if diff:
                        diffs[call_id] = diff
                self.ui.tool_call(name, args, call_id)
            elif kind == "tool_result":
                call_id = str(event.get("id") or "") or None
                output = diffs.get(call_id or "") or str(event.get("output") or "")
                self.ui.tool_result(names.get(call_id or "", ""), output, call_id)
            elif kind == "status" and event.get("text"):
                self.ui.info(str(event["text"]))
            elif kind == "result" and not shown["text"] and event.get("text"):
                shown["text"] = True
                self.ui.on_text(str(event["text"]))

        budget = int(self.config.get("turn_budget_s") or 0) or 1800

        def delegate(safe_prompt: str) -> dict:
            result = subs.run_turn(
                engine, delegated_prompt(self.config, safe_prompt, mode), self.config.project_root,
                cont=bool(session_id), session_id=session_id, mode=mode,
                timeout=budget, on_event=on_event, cancel=self.agent.cancelled.is_set,
                model=model, effort=effort)
            if result.get("session_id") and not result.get("cancelled") and not result.get("timeout"):
                self.agent.remember_subscription_session(
                    engine.key, result["session_id"], mode, model, effort)
            return result

        try:
            result = self.agent.run_external_turn(prompt, delegate, reset_cancel=False)
        except subs.EngineError as exc:
            self.ui.error(str(exc))
            return False
        finally:
            self.ui.end_stream()
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
                name_session = getattr(self.agent, "name_session", None)
                if not getattr(self.agent, "session_name", None) and callable(name_session):
                    title = _prompt_thread_title(text)
                    if title and name_session(title):
                        self.em.emit("session_named", name=title)
                self.em.emit("turn_start", turn_id=tid, prompt=text)
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
                try:
                    est = self.agent.estimate_tokens()
                except Exception:
                    est = 0
                self.em.emit("turn_end", turn_id=tid,
                             reason="cancelled" if cancelled else ("error" if failed else "completed"),
                             token_estimate=est)
                self._emit_context()
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

    def _emit_skill_catalog(self, request_id: str) -> None:
        rows = skill_catalog(self.agent.skills, self.config.project_root)
        self.em.emit("skill_catalog", request_id=request_id, items=rows, total=len(rows))

    def _emit_skill_detail(self, request_id: str, name: str) -> None:
        normalized = normalize_skill_name(name)
        skill = self.agent.skills.get(normalized)
        metadata = {row["name"]: row
                    for row in skill_catalog(self.agent.skills, self.config.project_root)}
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
    def _public_mcp_spec(raw) -> dict:
        spec = raw if isinstance(raw, dict) else {}
        raw_args = spec.get("args") if isinstance(spec.get("args"), list) else []
        auth_env = (spec.get("auth_env") if isinstance(spec.get("auth_env"), str)
                    and _MCP_ENV_RE.fullmatch(spec.get("auth_env")) else "")
        legacy_auth_env = ""
        for index, raw_arg in enumerate(raw_args[:-1]):
            if raw_arg != "--header" or not isinstance(raw_args[index + 1], str):
                continue
            match = re.fullmatch(
                r"Authorization:\s*Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}",
                raw_args[index + 1], re.IGNORECASE)
            if match:
                legacy_auth_env = match.group(1)
        args, skip = [], False
        for arg in raw_args[:128]:
            text = str(arg)[:8192]
            if skip:
                skip = False
                continue
            if text == "--header":
                skip = True
                continue
            if text.lower().startswith("authorization:"):
                continue
            if text.lower().startswith(("http://", "https://")) and _mcp_url_has_credentials(text):
                text = "<credential-bearing URL hidden>"
            args.append(text)
        env = spec.get("env") if isinstance(spec.get("env"), dict) else {}
        declared = spec.get("env_names") if isinstance(spec.get("env_names"), list) else []
        env_names = [name for name in [*declared, *env, *([legacy_auth_env] if legacy_auth_env else [])]
                     if isinstance(name, str) and _MCP_ENV_RE.fullmatch(name)][:64]
        transport = str(spec.get("transport") or "")
        url = str(spec.get("url") or "")
        if not transport:
            transport = ("remote" if len(raw_args) >= 3 and raw_args[:2] == ["-y", "mcp-remote"]
                         else "stdio")
        if transport == "remote" and not url and len(raw_args) >= 3:
            url = str(raw_args[2])[:4096]
        if url and _mcp_url_has_credentials(url):
            url = ""
        exact_bridge = (transport == "remote" and spec.get("command") == "npx"
                        and len(args) >= 3 and args[:2] == ["-y", "mcp-remote"]
                        and args[2] == url)
        if not auth_env and legacy_auth_env:
            auth_env = legacy_auth_env
        if not exact_bridge or auth_env not in env_names:
            auth_env = ""
        public = {
            "transport": transport if transport in ("stdio", "remote") else "stdio",
            "command": str(spec.get("command") or "")[:4096], "args": args,
            "env_names": list(dict.fromkeys(env_names)), "url": url[:4096],
            "log_level": str(spec.get("log_level") or "warning")[:16],
        }
        if auth_env:
            public["auth_env"] = auth_env
        return public

    def _emit_mcp_servers(self, request_id: str, error: str | None = None) -> None:
        configured = self.config.get("mcp_servers", {}) or {}
        configured = configured if isinstance(configured, dict) else {}
        statuses = {str(row.get("name")): row for row in self.agent.mcp.status()
                    if isinstance(row, dict)}
        items = []
        for index, (raw_name, raw_spec) in enumerate(configured.items()):
            if index >= _MAX_MCP_SERVERS:
                break
            name = str(raw_name)[:128]
            status = statuses.pop(name, {})
            items.append({"name": name, **self._public_mcp_spec(raw_spec),
                          "state": str(status.get("state") or "configured")[:32],
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

    def _upsert_mcp_server(self, request_id: str, name: str,
                           runtime_value, persisted_value) -> None:
        if not _MCP_NAME_RE.fullmatch(name):
            self._emit_mcp_servers(request_id, "server name must use 1-64 letters, digits, ., _, or -")
            return
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
            self._emit_mcp_servers(request_id, problem or "invalid MCP server specification")
            return
        servers = dict(self.config.get("mcp_servers", {}) or {})
        if name not in servers and len(servers) >= _MAX_MCP_SERVERS:
            self._emit_mcp_servers(request_id, f"at most {_MAX_MCP_SERVERS} MCP servers are supported")
            return
        if hasattr(self.config, "drop_mcp_secrets"):
            # An editor upsert may replace a SecretStorage value without changing the public
            # server identity.  Never let an older CLI-migrated value win on the next launch.
            self.config.drop_mcp_secrets(name)
        servers[name] = persisted
        self.config.set("mcp_servers", servers)
        secret_candidates = list(runtime.get("env", {}).values())
        existing = list(getattr(self.config, "_session_secret_values", ()))
        self.config._session_secret_values = tuple((existing + secret_candidates)[-256:])
        self.agent.mcp.connect_all({name: runtime})
        self._emit_mcp_servers(request_id)

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
                     goal={"text": getattr(self.agent, "goal", ""),
                           "status": getattr(self.agent, "goal_status", "none"),
                           "elapsed_seconds": self._goal_elapsed_seconds()},
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
                     **_request_fields(request_id))

    def _history(self) -> list:
        """A display transcript of the current conversation (for resuming in a UI)."""
        items = []
        for m in self.agent.messages:
            role = m.get("role")
            content = m.get("content")
            if role == "system":
                continue
            if role == "user":
                if isinstance(content, list):
                    text = " ".join(p.get("text", "") for p in content
                                    if isinstance(p, dict) and p.get("type") == "text") + " 📷"
                else:
                    text = _strip_editor_context(str(content))
                if text.startswith("<tool_results>"):
                    continue
                items.append({"role": "user", "text": text})
            elif role == "assistant":
                tools = [(tc.get("function") or {}).get("name", "") for tc in (m.get("tool_calls") or [])]
                items.append({"role": "assistant", "text": str(content or ""), "tools": tools})
        return items

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

        if t == "prompt":
            text = str(cmd.get("text", ""))
            if len(text) > _MAX_PROMPT_CHARS:
                self.em.emit("command_rejected", command=t, reason="prompt_too_large",
                             message=f"prompt exceeds the {_MAX_PROMPT_CHARS}-character limit")
                return
            try:
                images = validate_image_data_uris(
                    cmd.get("images"), maximum_file_bytes=MAX_EDITOR_IMAGE_TOTAL_BYTES,
                    maximum_total_bytes=MAX_EDITOR_IMAGE_TOTAL_BYTES)
            except ValueError as exc:
                self.em.emit("command_rejected", command=t, reason="invalid_images",
                             message=f"prompt images rejected: {exc}")
                return
            context = cmd.get("context")            # typed editor resources; bounded in _start_turn
            if text.startswith("/"):               # render a custom slash-command template
                parts = text[1:].split(None, 1)
                custom = discover_commands(self.config.project_root)
                if parts and parts[0] in custom:
                    text = render_command(custom[parts[0]], parts[1] if len(parts) > 1 else "",
                                          self.config.project_root) or text
            state, count = self._start_turn(text, images, context)
            if state == "queued":
                self.em.emit("queued", count=count, text=text)
            elif state == "full":
                self.em.emit("command_rejected", command=t, reason="queue_full", count=count,
                             message=("follow-up queue reached its count or aggregate byte limit "
                                      f"({count} queued); cancel it or wait for a turn to finish"))
            elif state == "busy":
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="a foreground operation is running; cancel or wait for it to finish")

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
            self.agent.skills = discover_skills(self.config.project_root)
            if hasattr(getattr(self.agent, "ctx", None), "skills"):
                self.agent.ctx.skills = self.agent.skills
            self._emit_skill_catalog(request_id)

        elif t == "list_docs":
            self._emit_docs(str(cmd.get("request_id") or ""))

        elif t == "get_doc":
            self._emit_doc(str(cmd.get("request_id") or ""), str(cmd.get("id") or ""))

        elif t == "list_mcp_servers":
            self._emit_mcp_servers(str(cmd.get("request_id") or ""))

        elif t == "upsert_mcp_server":
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
            roots = []
            for raw in cmd.get("roots", []) if isinstance(cmd.get("roots"), list) else []:
                try:
                    path = Path(str(raw)).resolve(strict=True)
                except (OSError, RuntimeError):
                    continue
                if path.is_dir() and not is_within(path, self.config.project_root) and path not in roots:
                    roots.append(path)
            self.config.session_permissions = {
                "allow": [f"ExternalDirectory({path})" for path in roots[:32]], "ask": [], "deny": []}
            self.em.emit("workspace_roots", roots=[str(self.config.project_root), *map(str, roots[:32])],
                         **_request_fields(request_id))

        elif t == "permission_response":
            self.pending.resolve(cmd.get("id"), {"decision": cmd.get("decision"), "rule": cmd.get("rule")})
        elif t == "plan_response":
            self.pending.resolve(cmd.get("id"), {"decision": cmd.get("decision"), "feedback": cmd.get("feedback")})
        elif t == "options_response":
            self.pending.resolve(cmd.get("id"), {"choice": cmd.get("choice")})
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
                    text, status if status in ("active", "completed", "blocked") else "active")
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
                n = self.agent.load_session(path)
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
                         goal={"text": getattr(self.agent, "goal", ""),
                               "status": getattr(self.agent, "goal_status", "none"),
                               "elapsed_seconds": self._goal_elapsed_seconds()},
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
