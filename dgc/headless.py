"""Headless JSON backend — `dgc serve`.

A second AgentUI (see ui.py): it serializes the agent's callbacks to NDJSON on stdout and
drives the agent from JSON commands on stdin. stdout carries protocol lines ONLY; anything
human goes to stderr. This is the layer the VS Code / Cursor extension talks to, and the
substrate the ACP adapter will reframe (Phase 4).
"""
from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

from . import __version__
from . import sessions as sessions_mod
from .agent import Agent
from .commands import discover_commands, editor_command_metadata, render_command
from .config import Config
from .editor_protocol import MAX_COMMAND_BYTES, PROTOCOL_VERSION, command_error, event_error
from .permissions import Rule, rule_for
from .protocol import Emitter, PendingRequests
from .tools import TOOL_SCHEMAS
from .ui import arg_summary, split_diff, tool_output_is_error

_PLAN_MODES = ("auto", "acceptEdits", "default")
_BUSY_MUTATIONS = {
    "set_mode", "set_model", "set_think", "new_session", "clear_session", "resume_session",
    "delete_session", "rewind", "compact", "set_config", "set_workspace_roots", "set_goal",
}
_EDITOR_CONTEXT_LIMIT = 64_000


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

    def tool_result(self, name: str, out: str, call_id: str | None = None) -> None:
        is_diff, diff = split_diff(out)
        self.em.emit("tool_result", call_id=call_id, name=name, output=out,
                     is_error=tool_output_is_error(out), is_diff=is_diff, diff=diff)

    def tool_denied(self, name: str, args: dict, reason: str,
                    call_id: str | None = None) -> None:
        self.em.emit("tool_denied", call_id=call_id, name=name, args=args, reason=reason)

    def on_todo(self, todos: list) -> None:
        self.em.emit("todos", todos=todos)

    def artifact_ready(self, art) -> None:
        self.em.emit("artifact_ready", id=art.id, name=art.name, url=art.url, rel=art.rel)

    def goal_changed(self, goal: str, status: str) -> None:
        self.em.emit("goal_changed", goal=goal, status=status)

    # notices ------------------------------------------------------------------
    def info(self, message: str) -> None:
        self.em.emit("info", message=message)

    def error(self, message: str) -> None:
        self.em.emit("error", message=message)

    # blocking decisions -------------------------------------------------------
    def _await(self, rid: str, ev: threading.Event):
        if not ev.wait(self.approval_timeout_s):
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


class Backend:
    def __init__(self, config: Config):
        from .trust import is_trusted
        self.workspace_trusted = is_trusted(config, config.project_root)
        if not self.workspace_trusted and config.mode in ("acceptEdits", "auto"):
            config.data["mode"] = "default"  # do not persist a downgrade of the user's global preference
        self.config = config
        self.em = Emitter(sys.stdout, validator=event_error)
        self.pending = PendingRequests()
        self.ui = HeadlessUI(self.em, self.pending,
                             float(config.get("approval_timeout_s", 300) or 300))
        self.agent = Agent(config, self.ui)
        self.ui._rule_hook = self._add_rule
        self.agent.session_file = sessions_mod.new_path(config.project_root)
        self._worker: threading.Thread | None = None
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
                          "provider_model_discovery": True},
            model=self.config.model, mode=self.agent.mode,
            think=self.config.get("thinking", "off"), base_url=self.config.base_url,
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
            custom_commands=list(discover_commands(self.config.project_root)),
            goal={"text": self.agent.goal, "status": self.agent.goal_status},
            context_size=int(self.config.get("context_size", 32768)))
        self._emit_context()

    def _busy(self) -> bool:
        return bool(self._worker and self._worker.is_alive())

    def _start_turn(self, text: str, images=None, context=None) -> None:
        self._turn_n += 1
        tid = f"t{self._turn_n}"
        self.agent._pending_images = images
        model_text = _format_editor_context(context) + text

        def run():
            self.em.emit("turn_start", turn_id=tid, prompt=text)
            failed = False
            try:
                self.agent.run_turn(model_text)
            except Exception as e:                 # a model/endpoint failure must NOT kill the turn silently
                failed = True                      # (unreachable base_url, model not pulled, HTTP error, …)
                import traceback
                detail = str(e).strip() or e.__class__.__name__
                self.em.emit("error", message=f"Turn failed — {detail}")
                sys.stderr.write(traceback.format_exc())    # full trace → the extension's stderr channel
            cancelled = self.agent.cancelled.is_set()
            try:
                est = self.agent.estimate_tokens()
            except Exception:
                est = 0
            self.em.emit("turn_end", turn_id=tid,
                         reason="cancelled" if cancelled else ("error" if failed else "completed"),
                         token_estimate=est)
            self._emit_context()
            if self._queue and not cancelled:   # preserve prompt order even if the prior turn failed
                nxt = self._queue.pop(0)
                self._start_turn(nxt[0], nxt[1], nxt[2])

        self._worker = threading.Thread(target=run, daemon=True)
        self._worker.start()

    def _emit_context(self) -> None:
        try:
            used = self.agent.estimate_tokens()
        except Exception:
            used = 0
        totals = getattr(self.agent, "usage_totals", {})
        self.em.emit("context", used=used, size=int(self.config.get("context_size", 32768)),
                     input_tokens=int(totals.get("input_tokens", 0)),
                     output_tokens=int(totals.get("output_tokens", 0)),
                     cached_input_tokens=int(totals.get("cached_input_tokens", 0)),
                     reasoning_tokens=int(totals.get("reasoning_tokens", 0)),
                     requests=int(totals.get("requests", 0)))

    def _emit_artifacts(self) -> None:
        from . import artifacts
        self.em.emit("artifacts", items=[{"id": a.id, "name": a.name, "url": a.url,
                                          "rel": a.rel, "uptime": a.uptime}
                                         for a in artifacts.registry()])

    def _emit_config(self) -> None:
        c = self.config
        self.em.emit("config", model=c.model, mode=self.agent.mode,
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
                     goal={"text": getattr(self.agent, "goal", ""),
                           "status": getattr(self.agent, "goal_status", "none")})

    def _emit_goal(self) -> None:
        self.em.emit("goal_changed", goal=getattr(self.agent, "goal", ""),
                     status=getattr(self.agent, "goal_status", "none"))

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
            self.em.emit("command_rejected", command=str(cmd.get("type") or "")[:128],
                         reason="invalid_command", message=f"invalid command: {problem}")
            return
        t = cmd.get("type")

        if self._busy() and t in _BUSY_MUTATIONS:
            self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                         message=f"'{t}' is unavailable while a turn is running; cancel or wait")
            return

        if t == "prompt":
            text = str(cmd.get("text", ""))
            images = cmd.get("images")             # list of data: URIs (vision models)
            context = cmd.get("context")            # typed editor resources; bounded in _start_turn
            if text.startswith("/"):               # render a custom slash-command template
                parts = text[1:].split(None, 1)
                custom = discover_commands(self.config.project_root)
                if parts and parts[0] in custom:
                    text = render_command(custom[parts[0]], parts[1] if len(parts) > 1 else "") or text
            if self._busy():                       # queue follow-ups sent mid-turn
                self._queue.append((text, images, context))
                self.em.emit("queued", count=len(self._queue), text=text)
                return
            self._start_turn(text, images, context)

        elif t == "slash_command":
            text = str(cmd.get("text") or "").strip()
            parts = text[1:].split(None, 1) if text.startswith("/") else []
            custom = discover_commands(self.config.project_root)
            if not parts or parts[0] not in custom:
                self.em.emit("error", message=f"unknown command: {text or '/'}")
                return
            rendered = render_command(custom[parts[0]], parts[1] if len(parts) > 1 else "")
            if not rendered:
                self.em.emit("error", message=f"custom command /{parts[0]} is empty")
            elif self._busy():
                self._queue.append((rendered, None, None))
                self.em.emit("queued", count=len(self._queue), text=text)
            else:
                self._start_turn(rendered)

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
            self.em.emit("workspace_roots", roots=[str(self.config.project_root), *map(str, roots[:32])])

        elif t == "permission_response":
            self.pending.resolve(cmd.get("id"), {"decision": cmd.get("decision"), "rule": cmd.get("rule")})
        elif t == "plan_response":
            self.pending.resolve(cmd.get("id"), {"decision": cmd.get("decision"), "feedback": cmd.get("feedback")})
        elif t == "options_response":
            self.pending.resolve(cmd.get("id"), {"choice": cmd.get("choice")})

        elif t in ("cancel", "interrupt"):
            self.agent.cancelled.set()
            self.pending.cancel_all({"decision": "no", "choice": None})
            self._queue.clear()

        elif t == "set_mode":
            mode = cmd.get("mode", "default")
            if mode in ("acceptEdits", "auto") and not self.workspace_trusted:
                if cmd.get("acknowledge_workspace_trust") is not True:
                    self.em.emit("command_rejected", command=t, reason="workspace_untrusted",
                                 message="review this workspace and explicitly acknowledge trust before enabling mutations")
                    return
                from .trust import mark_trusted
                mark_trusted(self.config, self.config.project_root)
                self.workspace_trusted = True
            self.agent.set_mode(mode)
            self.em.emit("mode_changed", mode=self.agent.mode,
                         workspace_trusted=self.workspace_trusted)
        elif t == "set_model":
            if cmd.get("clear_stored_api_key"):
                # The editor owns its active credential in SecretStorage. When it explicitly
                # switches provider, erase any older CLI secret so a later CLI launch cannot
                # attach that credential to the newly persisted endpoint.
                self.config.data["api_key"] = ""
                if hasattr(self.config, "_stored_secrets"):
                    self.config._stored_secrets["api_key"] = ""
                self.config._env_secret_keys.add("api_key")
            if cmd.get("base_url"):
                self.config.set("base_url", cmd["base_url"])
            if "api_key" in cmd:
                # Editor credentials are owned by VS Code SecretStorage. Keep this process-local;
                # a later non-secret config save preserves any existing CLI secret instead of
                # duplicating the editor key into ~/.dgc/secrets.json.
                self.config.data["api_key"] = str(cmd.get("api_key") or "")
                self.config._env_secret_keys.add("api_key")
            if cmd.get("model"):
                self.config.set("model", cmd["model"])
            self.agent.refresh_client()
            self.em.emit("model_changed", model=self.config.model, base_url=self.config.base_url)
        elif t == "list_models":
            request_id = str(cmd.get("request_id") or "")[:128]
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
                    ids = [item[:512] for item in client.list_models()[:4096]
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
            self.config.set("thinking", cmd.get("level", "off"))   # persisted
            self.em.emit("think_changed", think=self.config.get("thinking", "off"))
        elif t == "set_goal":
            status = str(cmd.get("status") or "active")
            text = str(cmd.get("text") or "")
            if status == "none" or (not text and status == "active"):
                self.agent.set_goal("")
            elif text:
                self.agent.set_goal(text, status if status in ("active", "completed", "blocked") else "active")
            elif not self.agent.update_goal(status):
                self.em.emit("error", message="no standing goal to update")
                return
            self._emit_goal()
        elif t == "get_goal":
            self._emit_goal()
        elif t == "get_plan":
            plan = (sessions_mod.load_plan(self.agent.session_file, self.config.project_root)
                    if self.agent.session_file else None)
            self.em.emit("saved_plan", plan=plan or "", exists=bool(plan))

        elif t == "new_session":
            self.agent.reset()
            self.agent.session_file = sessions_mod.new_path(self.config.project_root)
            self.em.emit("session", kind="new", message_count=0,
                         session_id=self.agent.session_file.stem)
            self._emit_goal()
        elif t == "clear_session":
            # Archive the prior persisted transcript and start an actually empty model context.
            # The old webview implementation only removed DOM nodes while the model retained every
            # prior turn, which made `/clear` misleading and potentially leaked stale context.
            self.agent.reset()
            self.agent.session_file = sessions_mod.new_path(self.config.project_root)
            self.em.emit("session", kind="cleared", message_count=0,
                         session_id=self.agent.session_file.stem)
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
                self.em.emit("session", kind="resumed", message_count=n, path=str(path))
                self.em.emit("history", items=self._history())
                self._emit_context()
                self._emit_goal()
            else:
                self.em.emit("error", message="no session to resume")
        elif t == "list_sessions":
            items = [{"path": str(p), "when": sessions_mod.when(ts), "preview": pv, "count": c,
                      "name": nm}
                     for (p, ts, pv, c, nm) in sessions_mod.listing(self.config.project_root)]
            self.em.emit("sessions", items=items)
        elif t == "delete_session":
            path = cmd.get("path")
            ok = bool(path) and sessions_mod.delete(path, self.config.project_root)
            items = [{"path": str(p), "when": sessions_mod.when(ts), "preview": pv, "count": c,
                      "name": nm}
                     for (p, ts, pv, c, nm) in sessions_mod.listing(self.config.project_root)]
            self.em.emit("sessions", items=items, deleted=ok)

        elif t == "list_checkpoints":
            items = [{"index": i, "preview": p, "files": nf}
                     for (i, p, nf) in self.agent.checkpoints.listing()]
            self.em.emit("checkpoints", items=items)
        elif t == "rewind":
            msgs, nfiles = self.agent.rewind(int(cmd.get("index", -1)))
            self.em.emit("rewound", ok=(msgs >= 0), files_restored=nfiles)
        elif t == "compact":
            self.agent.maybe_compact(force=True)
            self._emit_context()
        elif t == "list_artifacts":
            self._emit_artifacts()
        elif t == "stop_artifact":
            from . import artifacts
            artifacts.stop(str(cmd.get("id", "")))
            self._emit_artifacts()
        elif t == "set_config":
            allowed = ("subagent_model", "subagent_base_url", "subagent_api_key",
                       "subagent_api_mode", "api_mode",
                       "provider_state", "prompt_cache", "prompt_cache_key",
                       "provider_capabilities", "capability_cache_ttl_s",
                       "fallback_model", "fallback_base_url", "fallback_api_key",
                       "fallback_api_mode",
                       "context_size", "search_provider")
            refresh = False
            values = {k: v for k, v in (cmd.get("values") or {}).items() if k in allowed}
            secret_keys = ("subagent_api_key", "fallback_api_key")
            # Apply endpoints first: Config.set invalidates the old endpoint-bound secret. Then
            # install any replacement credential process-locally, regardless of JSON key order.
            for k, v in values.items():
                if k not in secret_keys:
                    self.config.set(k, v)
                refresh = refresh or k in {"api_mode", "provider_state", "prompt_cache",
                                           "prompt_cache_key", "provider_capabilities",
                                           "capability_cache_ttl_s"}
            for k in secret_keys:
                if k in values:
                    self.config.data[k] = str(values[k] or "")
                    self.config._env_secret_keys.add(k)
            if refresh:
                self.agent.refresh_client()
            self._emit_config()
        elif t == "get_config":
            self._emit_config()
        elif t == "status":
            self.em.emit("status", model=self.config.model, mode=self.agent.mode,
                         think=self.config.get("thinking", "off"), base_url=self.config.base_url,
                         goal={"text": getattr(self.agent, "goal", ""),
                               "status": getattr(self.agent, "goal_status", "none")},
                         context_used=self.agent.estimate_tokens(),
                         context_size=int(self.config.get("context_size", 32768)))
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
                cmd = json.loads(line)
            except json.JSONDecodeError:
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
    backend.agent.cancelled.set()  # release any in-flight turn on the way out
