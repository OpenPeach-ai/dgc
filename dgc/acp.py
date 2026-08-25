"""ACP (Agent Client Protocol) adapter — `dgc acp`.

A dependency-free JSON-RPC-2.0-over-stdio server implementing the agent side of Zed's
Agent Client Protocol, so DGC is drivable from any ACP client (Zed, JetBrains/Junie,
Neovim, Emacs, marimo…). It is a third AgentUI implementation (see ui.py): it reframes the
same agent callbacks as ACP `session/update` notifications and `session/request_permission`
requests. No new dependencies — plain threads + json, like the headless backend.

Docs: https://agentclientprotocol.com
"""
from __future__ import annotations

import itertools
import json
import sys
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from . import __version__
from . import sessions
from .agent import Agent
from .commands import discover_commands
from .config import Config
from .permissions import MODE_DESCRIPTIONS, MODES, rule_for
from .ui import arg_summary, split_diff, tool_output_is_error

_KIND = {  # DGC tool -> ACP tool-call kind
    "read_file": "read", "repo_map": "read", "glob": "read", "grep": "read",
    "write_file": "edit", "edit_file": "edit", "multi_edit": "edit", "apply_patch": "edit",
    "bash": "execute", "bash_output": "execute", "bash_kill": "execute",
    "web_fetch": "fetch", "web_search": "fetch",
    "todo": "think", "task": "think", "skill": "other", "save_memory": "other",
}
_TODO_STATUS = {"pending": "pending", "in_progress": "in_progress", "done": "completed"}


def _mode_state(agent: Agent) -> dict:
    return {"currentModeId": agent.mode, "availableModes": [
        {"id": mode, "name": mode, "description": MODE_DESCRIPTIONS[mode]} for mode in MODES]}


@dataclass
class _ACPState:
    sid: str
    cwd: Path
    config: Config
    agent: Agent
    ui: "_ACPUi"
    worker: threading.Thread | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def busy(self) -> bool:
        return bool(self.worker and self.worker.is_alive())


class ACPServer:
    def __init__(self):
        self._lock = threading.Lock()
        self._rid = itertools.count(1)
        self._pending_lock = threading.Lock()
        self._pending: dict[int, dict] = {}
        self._sessions_lock = threading.RLock()
        self._sessions: dict[str, _ACPState] = {}
        self._session_roots: dict[str, Path] = {}
        self._initialized = False

    # -- json-rpc i/o ----------------------------------------------------------
    def _write(self, obj: dict) -> None:
        line = json.dumps(obj, ensure_ascii=False)
        with self._lock:
            try:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            except (BrokenPipeError, ValueError):
                pass

    def notify(self, method: str, params: dict) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def respond(self, rid, result=None, error=None) -> None:
        msg = {"jsonrpc": "2.0", "id": rid}
        if error is not None:
            msg["error"] = error
        else:
            msg["result"] = result if result is not None else {}
        self._write(msg)

    def request(self, method: str, params: dict, timeout: float = 3600.0):
        """Server-initiated request (e.g. session/request_permission). Blocks for the reply."""
        rid = next(self._rid)
        ev = threading.Event()
        holder: list = [None]
        slot = {"event": ev, "holder": holder, "session_id": params.get("sessionId")}
        with self._pending_lock:
            self._pending[rid] = slot
        self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        if not ev.wait(timeout):
            with self._pending_lock:
                self._pending.pop(rid, None)
            return None
        return holder[0]

    def _cancel_requests(self, sid: str) -> None:
        with self._pending_lock:
            slots = [slot for slot in self._pending.values() if slot.get("session_id") == sid]
            for slot in slots:
                slot["holder"][0] = {"outcome": {"outcome": "cancelled"}}
                slot["event"].set()

    def _state(self, sid) -> _ACPState | None:
        with self._sessions_lock:
            return self._sessions.get(str(sid or ""))

    def _install_state(self, cwd: Path, agent: Agent, ui: "_ACPUi") -> _ACPState:
        sid = ui.sid
        state = _ACPState(sid, cwd, agent.config, agent, ui)
        ui._rule_hook = lambda text, cfg=agent.config: self._add_rule(cfg, text)
        with self._sessions_lock:
            self._sessions[sid] = state
            self._session_roots[sid] = cwd
        return state

    @staticmethod
    def _add_rule(config: Config, rule_text: str) -> None:
        if rule_text not in config.permissions.setdefault("allow", []):
            config.permissions["allow"].append(rule_text)
            config.save()

    @staticmethod
    def _session_inputs(config: Config, params: dict) -> dict:
        """Validate ACP-declared additional roots and mandatory stdio MCP configurations.

        Additional directories are session-scoped permission rules; they are not written into the
        user's global config. HTTP/SSE are rejected because DGC does not advertise those transports.
        """
        allow: list[str] = []
        for raw in params.get("additionalDirectories") or []:
            path = Path(str(raw)).expanduser()
            if not path.is_absolute() or not path.is_dir():
                raise ValueError(f"additional directory must be an existing absolute path: {raw}")
            allow.append(f"ExternalDirectory({path.resolve()})")
        config.session_permissions = {"allow": allow, "ask": [], "deny": []}

        specs: dict[str, dict] = {}
        for i, spec in enumerate(params.get("mcpServers") or []):
            if not isinstance(spec, dict):
                raise ValueError(f"mcpServers[{i}] must be an object")
            if spec.get("type") in ("http", "sse"):
                raise ValueError(f"MCP transport {spec.get('type')!r} is not supported")
            name, command = str(spec.get("name", "")).strip(), str(spec.get("command", "")).strip()
            if not name or not command or not Path(command).is_absolute():
                raise ValueError(f"mcpServers[{i}] requires a name and absolute stdio command")
            args = spec.get("args") or []
            env_rows = spec.get("env") or []
            if not isinstance(args, list) or not isinstance(env_rows, list):
                raise ValueError(f"mcpServers[{i}] args/env must be arrays")
            env: dict[str, str] = {}
            for row in env_rows:
                if not isinstance(row, dict) or "name" not in row or "value" not in row:
                    raise ValueError(f"mcpServers[{i}] contains an invalid environment entry")
                env[str(row["name"])] = str(row["value"])
            specs[name] = {"command": command, "args": [str(a) for a in args], "env": env}
        return specs

    # -- main loop -------------------------------------------------------------
    def serve(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                self.respond(None, error={"code": -32700, "message": "parse error"})
                continue
            if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
                self.respond(msg.get("id") if isinstance(msg, dict) else None,
                             error={"code": -32600, "message": "invalid JSON-RPC request"})
                continue
            if "method" in msg:                          # a request or notification from the client
                try:
                    self._dispatch(msg)
                except Exception as e:
                    if msg.get("id") is not None:
                        self.respond(msg.get("id"), error={"code": -32603, "message": str(e)})
            elif "id" in msg:                            # a reply to one of our server requests
                with self._pending_lock:
                    slot = self._pending.pop(msg["id"], None)
                if slot:
                    slot["holder"][0] = msg.get("result")
                    slot["event"].set()

    def _dispatch(self, msg: dict) -> None:
        method = msg.get("method")
        rid = msg.get("id")
        params = msg.get("params") or {}

        if method == "initialize":
            self._initialized = True
            self.respond(rid, {
                "protocolVersion": 1,
                "agentCapabilities": {"loadSession": True,
                                      "promptCapabilities": {"image": True, "audio": False,
                                                             "embeddedContext": True},
                                      "sessionCapabilities": {"list": {}, "delete": {}}},
                "authMethods": [],
                "agentInfo": {"name": "dgc", "version": __version__}})

        elif not self._initialized:
            if rid is not None:
                self.respond(rid, error={"code": -32002, "message": "call initialize first"})

        elif method == "session/new":
            cwd = Path(str(params.get("cwd", ""))).expanduser()
            if not cwd.is_absolute() or not cwd.is_dir():
                self.respond(rid, error={"code": -32602, "message": "cwd must be an existing absolute directory"})
                return
            config = Config(project_root=cwd.resolve())
            try:
                acp_mcp = self._session_inputs(config, params)
            except ValueError as e:
                self.respond(rid, error={"code": -32602, "message": str(e)})
                return
            from .trust import is_trusted
            if not is_trusted(config, config.project_root) and config.mode in ("acceptEdits", "auto"):
                config.data["mode"] = "default"
            session_file = sessions.new_path(config.project_root)
            ui = _ACPUi(self, session_file.stem, config.project_root,
                        approval_timeout_s=float(config.get("approval_timeout_s", 300) or 300))
            agent = Agent(config, ui)
            agent.mcp.connect_all(acp_mcp)
            agent.session_file = session_file
            self._install_state(config.project_root, agent, ui)
            self.respond(rid, {"sessionId": ui.sid, "modes": _mode_state(agent),
                               "goal": {"text": agent.goal, "status": agent.goal_status}})
            ui.available_commands(discover_commands(config.project_root))

        elif method == "session/load":
            cwd = Path(str(params.get("cwd", ""))).expanduser()
            sid = str(params.get("sessionId", ""))
            if not cwd.is_absolute() or not cwd.is_dir():
                self.respond(rid, error={"code": -32602, "message": "cwd must be an existing absolute directory"})
                return
            config = Config(project_root=cwd.resolve())
            try:
                acp_mcp = self._session_inputs(config, params)
            except ValueError as e:
                self.respond(rid, error={"code": -32602, "message": str(e)})
                return
            from .trust import is_trusted
            if not is_trusted(config, config.project_root) and config.mode in ("acceptEdits", "auto"):
                config.data["mode"] = "default"
            path = sessions.by_id(config.project_root, sid)
            if not path:
                self.respond(rid, error={"code": -32001, "message": "session not found in this workspace"})
                return
            ui = _ACPUi(self, path.stem, config.project_root,
                        approval_timeout_s=float(config.get("approval_timeout_s", 300) or 300))
            agent = Agent(config, ui)
            agent.mcp.connect_all(acp_mcp)
            agent.session_file = path
            agent.load_session(path)
            self._install_state(config.project_root, agent, ui)
            ui.replay(agent.messages)
            ui.available_commands(discover_commands(config.project_root))
            self.respond(rid, {"modes": _mode_state(agent),
                               "goal": {"text": agent.goal, "status": agent.goal_status}})

        elif method == "session/list":
            cwd_value = params.get("cwd")
            if cwd_value:
                root = Path(str(cwd_value)).expanduser().resolve()
                rows = [(p, root, ts, preview, count, name)
                        for p, ts, preview, count, name in sessions.listing(root)]
            else:
                rows = sessions.listing_all()
            result = []
            for path, root, updated, _preview, _count, name in rows:
                self._session_roots[path.stem] = root
                result.append({"sessionId": path.stem, "cwd": str(root),
                               "title": name or None,
                               "updatedAt": datetime.fromtimestamp(updated).astimezone().isoformat()})
            self.respond(rid, {"sessions": result})

        elif method == "session/delete":
            sid = str(params.get("sessionId", ""))
            state = self._state(sid)
            if state and state.busy():
                self.respond(rid, error={"code": -32003, "message": "session has an active turn"})
                return
            root = self._session_roots.get(sid)
            path = sessions.by_id(root, sid) if root else None
            if not path:
                found = sessions.find_global(sid)
                if found:
                    path, root = found
            if not path or not root or not sessions.delete(path, root):
                self.respond(rid, error={"code": -32001, "message": "session not found"})
                return
            with self._sessions_lock:
                self._sessions.pop(sid, None); self._session_roots.pop(sid, None)
            self.respond(rid, {})

        elif method == "session/prompt":
            state = self._state(params.get("sessionId"))
            if not state:
                self.respond(rid, error={"code": -32002, "message": "unknown session"})
                return
            if state.busy():
                self.respond(rid, error={"code": -32003, "message": "session already has an active turn"})
                return
            text = _prompt_text(params.get("prompt", []))
            images = _prompt_images(params.get("prompt", []))

            def run():
                try:
                    state.agent._pending_images = images or None
                    state.agent.run_turn(text)
                    reason = "cancelled" if state.agent.cancelled.is_set() else "end_turn"
                    state.ui.usage(state.agent.estimate_tokens(),
                                   int(state.config.get("context_size", 32768)))
                    self.respond(rid, {"stopReason": reason})
                except Exception as e:
                    if state.agent.cancelled.is_set():
                        self.respond(rid, {"stopReason": "cancelled"})
                    else:
                        self.respond(rid, error={"code": -32603, "message": str(e)})

            state.worker = threading.Thread(target=run, daemon=True,
                                            name=f"dgc-acp-{state.sid[:12]}")
            state.worker.start()

        elif method == "session/cancel":
            state = self._state(params.get("sessionId"))
            if state:
                state.agent.cancelled.set()
                self._cancel_requests(state.sid)
            # notification — no response

        elif method == "session/set_mode":
            state = self._state(params.get("sessionId"))
            mode = str(params.get("modeId", ""))
            if not state or mode not in MODES:
                self.respond(rid, error={"code": -32602, "message": "unknown session or mode"})
                return
            if state.busy():
                self.respond(rid, error={"code": -32003, "message": "cannot change mode during a turn"})
                return
            if mode in ("acceptEdits", "auto"):
                from .trust import is_trusted, mark_trusted
                if not is_trusted(state.config, state.cwd):
                    mark_trusted(state.config, state.cwd)
            state.agent.set_mode(mode)
            state.ui.current_mode(mode)
            self.respond(rid, {})

        # DGC protocol extension: typed standing-goal state without feeding slash text to the model.
        elif method == "session/set_goal":
            state = self._state(params.get("sessionId"))
            if not state:
                self.respond(rid, error={"code": -32002, "message": "unknown session"})
                return
            if state.busy():
                self.respond(rid, error={"code": -32003, "message": "cannot change goal during a turn"})
                return
            text = str(params.get("text") or "")
            status = str(params.get("status") or "active")
            if not text and status in ("active", "completed", "blocked"):
                if not state.agent.update_goal(status):
                    self.respond(rid, error={"code": -32602, "message": "no standing goal to update"})
                    return
            else:
                state.agent.set_goal(text, status)
            self.respond(rid, {"goal": {"text": state.agent.goal,
                                        "status": state.agent.goal_status}})

        elif method == "session/get_goal":
            state = self._state(params.get("sessionId"))
            if not state:
                self.respond(rid, error={"code": -32002, "message": "unknown session"})
                return
            self.respond(rid, {"goal": {"text": state.agent.goal,
                                        "status": state.agent.goal_status}})

        elif rid is not None:
            self.respond(rid, error={"code": -32601, "message": f"method not found: {method}"})


def _prompt_text(blocks) -> str:
    parts: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text":
            parts.append(str(block.get("text", "")))
        elif kind == "resource":
            resource = block.get("resource") or {}
            text = resource.get("text")
            if text is not None:
                uri = resource.get("uri") or block.get("uri") or "embedded"
                parts.append(f"<embedded-resource uri={uri!r}>\n{text}\n</embedded-resource>")
        elif kind == "resource_link":
            uri = block.get("uri", "")
            parts.append(f"<resource-link uri={uri!r}>{block.get('name') or uri}</resource-link>")
    return "\n".join(parts).strip()


def _prompt_images(blocks) -> list:
    out = []
    for b in blocks:
        if isinstance(b, dict) and b.get("type") == "image":
            data, mime = b.get("data"), b.get("mimeType", "image/png")
            if data:
                out.append(f"data:{mime};base64,{data}")
    return out


class _ACPUi:
    """AgentUI → ACP session/update notifications + session/request_permission."""

    def __init__(self, server: ACPServer, sid: str, cwd: Path,
                 approval_timeout_s: float = 300.0):
        self.s = server
        self.sid = sid
        self.cwd = cwd
        self.approval_timeout_s = max(0.01, float(approval_timeout_s))
        self._tc = itertools.count(1)
        self._last_tool = None
        self._announced: set[str] = set()
        self._tool_paths: dict[str, str] = {}
        self._rule_hook = None
        self.plan_feedback = ""

    def _path(self, args) -> str:
        raw = str(args.get("path") or "")
        if not raw:
            return ""
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = self.cwd / path
        return str(path.resolve(strict=False))

    def _update(self, upd: dict) -> None:
        self.s.notify("session/update", {"sessionId": self.sid, "update": upd})

    # streaming
    def on_text(self, chunk):
        self._update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": chunk}})

    def on_thinking(self, chunk):
        self._update({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": chunk}})

    def end_stream(self):
        pass

    # tools
    def tool_call(self, name, args, call_id=None):
        tcid = call_id or f"tc{next(self._tc)}"
        self._last_tool = tcid
        self._tool_paths[tcid] = self._path(args)
        if tcid in self._announced:
            self._update({"sessionUpdate": "tool_call_update", "toolCallId": tcid,
                          "status": "in_progress", "rawInput": args})
            return
        self._announced.add(tcid)
        self._update({"sessionUpdate": "tool_call", "toolCallId": tcid, "title": name,
                      "kind": _KIND.get(name, "other"), "status": "in_progress",
                      "rawInput": args, "content": [{"type": "content",
                      "content": {"type": "text", "text": arg_summary(name, args)}}]})

    def tool_result(self, name, out, call_id=None):
        is_diff, diff = split_diff(out)
        content = [{"type": "content", "content": {"type": "text", "text": out[:8000]}}]
        if is_diff:
            path = self._tool_paths.get(call_id or "", "")
            try:
                new_text = Path(path).read_text(errors="replace") if path else ""
            except OSError:
                new_text = ""
            if path and len(new_text) <= 1_000_000:
                content = [{"type": "diff", "path": path, "newText": new_text}]
        self._update({"sessionUpdate": "tool_call_update",
                      "toolCallId": call_id or self._last_tool or "tc0",
                      "status": "failed" if tool_output_is_error(out) else "completed",
                      "content": content})

    def tool_denied(self, name, args, reason, call_id=None):
        self._update({"sessionUpdate": "tool_call_update",
                      "toolCallId": call_id or self._last_tool or "tc0",
                      "status": "failed", "content": [{"type": "content",
                      "content": {"type": "text", "text": reason}}]})

    def on_todo(self, todos):
        self._update({"sessionUpdate": "plan", "entries": [
            {"content": t.get("content", ""), "priority": "medium",
             "status": _TODO_STATUS.get(t.get("status"), "pending")} for t in todos]})

    # decisions
    def approve(self, name, args, call_id=None):
        tcid = call_id or self._last_tool or f"tc{next(self._tc)}"
        self._last_tool = tcid
        self._announced.add(tcid)
        self._tool_paths[tcid] = self._path(args)
        self._update({"sessionUpdate": "tool_call", "toolCallId": tcid, "title": name,
                      "kind": _KIND.get(name, "other"), "status": "pending",
                      "rawInput": args, "content": [{"type": "content",
                      "content": {"type": "text", "text": arg_summary(name, args)}}]})
        res = self.s.request("session/request_permission", {
            "sessionId": self.sid,
            "toolCall": {"toolCallId": tcid, "title": name, "rawInput": args},
            "options": [
                {"optionId": "once", "name": "Allow once", "kind": "allow_once"},
                {"optionId": "always", "name": "Always allow", "kind": "allow_always"},
                {"optionId": "deny", "name": "Deny", "kind": "reject_once"}]},
            timeout=self.approval_timeout_s)
        outcome = (res or {}).get("outcome", {})
        if outcome.get("outcome") == "selected":
            return {"once": "once", "always": "always", "deny": "no"}.get(outcome.get("optionId"), "no")
        return "no"

    def add_permission_rule(self, name, args):
        rule = str(rule_for(name, args))
        if self._rule_hook:
            self._rule_hook(rule)

    def present_plan(self, plan):
        tcid = f"plan{next(self._tc)}"
        self._update({"sessionUpdate": "tool_call", "toolCallId": tcid,
                      "title": "Approve implementation plan", "kind": "think", "status": "pending",
                      "rawInput": {"plan": plan}, "content": [{"type": "content",
                      "content": {"type": "text", "text": plan}}]})
        res = self.s.request("session/request_permission", {
            "sessionId": self.sid,
            "toolCall": {"toolCallId": tcid, "title": "Approve implementation plan",
                         "kind": "think", "rawInput": {"plan": plan}},
            "options": [
                {"optionId": "acceptEdits", "name": "Approve (accept edits)", "kind": "allow_once"},
                {"optionId": "default", "name": "Approve (ask for changes)", "kind": "allow_once"},
                {"optionId": "auto", "name": "Approve (full auto)", "kind": "allow_once"},
                {"optionId": "reject", "name": "Keep planning", "kind": "reject_once"}]},
            timeout=self.approval_timeout_s)
        outcome = (res or {}).get("outcome", {})
        choice = outcome.get("optionId") if outcome.get("outcome") == "selected" else "reject"
        accepted = choice in ("acceptEdits", "default", "auto")
        self.plan_feedback = "" if accepted else str(
            outcome.get("reason") or (res or {}).get("feedback") or "").strip()
        self._update({"sessionUpdate": "tool_call_update", "toolCallId": tcid,
                      "status": "completed" if accepted else "failed"})
        return choice if accepted else None

    def propose_options(self, question, options):
        res = self.s.request("session/request_permission", {
            "sessionId": self.sid,
            "toolCall": {"toolCallId": f"opt{next(self._tc)}", "title": question},
            "options": [{"optionId": str(i), "name": o, "kind": "allow_once"}
                        for i, o in enumerate(options)]}, timeout=self.approval_timeout_s)
        outcome = (res or {}).get("outcome", {})
        if outcome.get("outcome") == "selected":
            try:
                return options[int(outcome.get("optionId"))]
            except (ValueError, IndexError):
                pass
        return options[0] if options else ""

    def info(self, msg):
        self.on_text(f"\n[{msg}]\n")

    def error(self, msg):
        self.on_text(f"\n[error: {msg}]\n")

    def current_mode(self, mode: str) -> None:
        self._update({"sessionUpdate": "current_mode_update", "currentModeId": mode})

    def usage(self, used: int, size: int) -> None:
        self._update({"sessionUpdate": "usage_update", "used": max(0, int(used)),
                      "size": max(0, int(size))})

    def available_commands(self, commands: dict) -> None:
        values = [{"name": name, "description": f"Run the /{name} DGC command",
                   "input": {"hint": "optional arguments"}} for name in sorted(commands)]
        self._update({"sessionUpdate": "available_commands_update", "availableCommands": values})

    def replay(self, messages: list[dict]) -> None:
        for message in messages:
            role = message.get("role")
            content = message.get("content")
            if role not in ("user", "assistant"):
                continue
            if isinstance(content, list):
                text = "\n".join(str(p.get("text", "")) for p in content
                                 if isinstance(p, dict) and p.get("type") == "text")
            else:
                text = str(content or "")
            if text:
                update = "user_message_chunk" if role == "user" else "agent_message_chunk"
                self._update({"sessionUpdate": update, "content": {"type": "text", "text": text}})


def serve() -> None:
    ACPServer().serve()
