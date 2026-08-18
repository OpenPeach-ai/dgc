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

from . import __version__
from . import sessions as sessions_mod
from .agent import Agent
from .commands import discover_commands, render_command
from .config import Config
from .permissions import Rule, rule_for
from .protocol import Emitter, PendingRequests
from .tools import TOOL_SCHEMAS
from .ui import arg_summary, split_diff

_PLAN_MODES = ("auto", "acceptEdits", "default")


class _Shutdown(Exception):
    pass


class HeadlessUI:
    """The AgentUI seam, realized as NDJSON events + blocking request round-trips."""

    def __init__(self, emitter: Emitter, pending: PendingRequests):
        self.em = emitter
        self.pending = pending
        self._rule_hook = None          # set by Backend to persist an allow rule
        self._rule_override: dict = {}   # tool -> explicit rule string the IDE dictated

    # streaming ----------------------------------------------------------------
    def on_text(self, chunk: str) -> None:
        self.em.emit("text_delta", text=chunk)

    def on_thinking(self, chunk: str) -> None:
        self.em.emit("thinking_delta", text=chunk)

    def end_stream(self) -> None:
        self.em.emit("stream_end")

    # tools --------------------------------------------------------------------
    def tool_call(self, name: str, args: dict) -> None:
        self.em.emit("tool_call", name=name, args=args, summary=arg_summary(name, args))

    def tool_result(self, name: str, out: str) -> None:
        is_diff, diff = split_diff(out)
        self.em.emit("tool_result", name=name, output=out, is_diff=is_diff, diff=diff)

    def tool_denied(self, name: str, args: dict, reason: str) -> None:
        self.em.emit("tool_denied", name=name, args=args, reason=reason)

    def on_todo(self, todos: list) -> None:
        self.em.emit("todos", todos=todos)

    # notices ------------------------------------------------------------------
    def info(self, message: str) -> None:
        self.em.emit("info", message=message)

    def error(self, message: str) -> None:
        self.em.emit("error", message=message)

    # blocking decisions -------------------------------------------------------
    def approve(self, name: str, args: dict) -> str:
        rid, ev = self.pending.register()
        self.em.emit("permission_request", id=rid, name=name, args=args,
                     command=(args.get("command") if name == "bash" else None),
                     suggested_rule=str(rule_for(name, args)),
                     choices=["once", "always", "deny"])
        ev.wait()
        payload = self.pending.value(rid) or {}
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
        ev.wait()
        payload = self.pending.value(rid) or {}
        if payload.get("feedback"):
            self.em.emit("info", message=str(payload["feedback"]))
        decision = payload.get("decision")
        return decision if decision in _PLAN_MODES else None

    def propose_options(self, question: str, options: list) -> str:
        rid, ev = self.pending.register()
        self.em.emit("options_request", id=rid, question=question, options=options)
        ev.wait()
        payload = self.pending.value(rid) or {}
        choice = payload.get("choice")
        if isinstance(choice, int) and 1 <= choice <= len(options):
            return options[choice - 1]
        if isinstance(choice, str) and choice:
            return choice
        return options[0] if options else ""


class Backend:
    def __init__(self, config: Config):
        self.config = config
        self.em = Emitter(sys.stdout)
        self.pending = PendingRequests()
        self.ui = HeadlessUI(self.em, self.pending)
        self.agent = Agent(config, self.ui)
        self.ui._rule_hook = self._add_rule
        self.agent.session_file = sessions_mod.new_path(config.project_root)
        self._worker: threading.Thread | None = None
        self._turn_n = 0
        self._queue: list[str] = []   # prompts queued while a turn is running

    def _add_rule(self, rule_text: str) -> None:
        try:
            Rule.parse(rule_text, "allow")  # validate before persisting
            self.config.permissions.setdefault("allow", []).append(rule_text)
            self.config.save()
        except Exception:
            pass

    def start(self) -> None:
        self.em.emit(
            "ready", version=__version__, model=self.config.model, mode=self.agent.mode,
            think=self.config.get("thinking", "off"), base_url=self.config.base_url,
            project_root=str(self.config.project_root),
            session_id=self.agent.session_file.stem if self.agent.session_file else None,
            tools_supported=self.agent.client.tools_supported,
            tools=[t["function"]["name"] for t in TOOL_SCHEMAS],
            skills=[s.name for s in self.agent.skills.values()],
            commands=list(discover_commands(self.config.project_root)),
            context_size=int(self.config.get("context_size", 32768)))
        self._emit_context()

    def _busy(self) -> bool:
        return bool(self._worker and self._worker.is_alive())

    def _start_turn(self, text: str, images=None) -> None:
        self._turn_n += 1
        tid = f"t{self._turn_n}"
        self.agent._pending_images = images

        def run():
            self.em.emit("turn_start", turn_id=tid, prompt=text)
            self.agent.run_turn(text)
            cancelled = self.agent.cancelled.is_set()
            self.em.emit("turn_end", turn_id=tid,
                         reason="cancelled" if cancelled else "completed",
                         token_estimate=self.agent.estimate_tokens())
            self._emit_context()
            if self._queue and not cancelled:      # drain a queued follow-up
                nxt = self._queue.pop(0)
                self._start_turn(nxt[0], nxt[1])

        self._worker = threading.Thread(target=run, daemon=True)
        self._worker.start()

    def _emit_context(self) -> None:
        try:
            used = self.agent.estimate_tokens()
        except Exception:
            used = 0
        self.em.emit("context", used=used, size=int(self.config.get("context_size", 32768)))

    def _emit_config(self) -> None:
        c = self.config
        self.em.emit("config", model=c.model, mode=self.agent.mode,
                     think=c.get("thinking", "off"), base_url=c.base_url,
                     project_root=str(c.project_root), search=c.get("search_provider"),
                     subagent_model=c.get("subagent_model", ""),
                     subagent_base_url=c.get("subagent_base_url", ""),
                     subagent_api_key=c.get("subagent_api_key", ""),
                     fallback_model=c.get("fallback_model", ""),
                     fallback_base_url=c.get("fallback_base_url", ""),
                     context_size=c.get("context_size", 32768))

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
                    text = str(content)
                if text.startswith("<tool_results>"):
                    continue
                items.append({"role": "user", "text": text})
            elif role == "assistant":
                tools = [(tc.get("function") or {}).get("name", "") for tc in (m.get("tool_calls") or [])]
                items.append({"role": "assistant", "text": str(content or ""), "tools": tools})
        return items

    def dispatch(self, cmd: dict) -> None:
        t = cmd.get("type")

        if t == "prompt":
            text = str(cmd.get("text", ""))
            images = cmd.get("images")             # list of data: URIs (vision models)
            if text.startswith("/"):               # render a custom slash-command template
                parts = text[1:].split(None, 1)
                custom = discover_commands(self.config.project_root)
                if parts and parts[0] in custom:
                    text = render_command(custom[parts[0]], parts[1] if len(parts) > 1 else "") or text
            if self._busy():                       # queue follow-ups sent mid-turn
                self._queue.append((text, images))
                self.em.emit("queued", count=len(self._queue), text=text)
                return
            self._start_turn(text, images)

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
            self.agent.set_mode(cmd.get("mode", "default"))
            self.em.emit("mode_changed", mode=self.agent.mode)
        elif t == "set_model":
            if cmd.get("base_url"):
                self.config.set("base_url", cmd["base_url"])
            if cmd.get("api_key"):
                self.config.set("api_key", cmd["api_key"])
            if cmd.get("model"):
                self.config.set("model", cmd["model"])
            self.agent.refresh_client()
            self.em.emit("model_changed", model=self.config.model, base_url=self.config.base_url)
        elif t == "set_think":
            self.config.set("thinking", cmd.get("level", "off"))   # persisted
            self.em.emit("think_changed", think=self.config.get("thinking", "off"))

        elif t == "new_session":
            self.agent.reset()
            self.agent.session_file = sessions_mod.new_path(self.config.project_root)
            self.em.emit("session", kind="new", message_count=0,
                         session_id=self.agent.session_file.stem)
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
            else:
                self.em.emit("error", message="no session to resume")
        elif t == "list_sessions":
            items = [{"path": str(p), "when": sessions_mod.when(ts), "preview": pv, "count": c,
                      "name": nm}
                     for (p, ts, pv, c, nm) in sessions_mod.listing(self.config.project_root)]
            self.em.emit("sessions", items=items)
        elif t == "delete_session":
            path = cmd.get("path")
            ok = bool(path) and sessions_mod.delete(path)
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
        elif t == "set_config":
            allowed = ("subagent_model", "subagent_base_url", "subagent_api_key",
                       "fallback_model", "fallback_base_url", "context_size", "search_provider")
            for k, v in (cmd.get("values") or {}).items():
                if k in allowed:
                    self.config.set(k, v)
            self._emit_config()
        elif t in ("get_config", "status"):
            self._emit_config()
        elif t == "shutdown":
            raise _Shutdown()
        else:
            self.em.emit("error", message=f"unknown command: {t!r}")


def serve(config: Config) -> None:
    """Run the headless backend: emit `ready`, then loop over stdin commands until EOF/shutdown."""
    backend = Backend(config)
    backend.start()
    try:
        for line in sys.stdin:
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
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    backend.agent.cancelled.set()  # release any in-flight turn on the way out
