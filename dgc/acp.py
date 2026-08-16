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
from pathlib import Path

from . import __version__
from .agent import Agent
from .config import Config
from .permissions import rule_for
from .ui import arg_summary, split_diff

_KIND = {  # DGC tool -> ACP tool-call kind
    "read_file": "read", "glob": "read", "grep": "read",
    "write_file": "edit", "edit_file": "edit",
    "bash": "execute", "bash_output": "execute", "bash_kill": "execute",
    "web_fetch": "fetch", "web_search": "fetch",
    "todo": "think", "task": "think", "skill": "other", "save_memory": "other",
}
_TODO_STATUS = {"pending": "pending", "in_progress": "in_progress", "done": "completed"}


class ACPServer:
    def __init__(self):
        self._lock = threading.Lock()
        self._rid = itertools.count(1)
        self._pending: dict[int, list] = {}     # server-initiated request id -> [Event, holder]
        self.agent: Agent | None = None
        self.ui: "_ACPUi | None" = None
        self.session_id = "dgc-1"

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
        self._pending[rid] = [ev, holder]
        self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        if not ev.wait(timeout):
            self._pending.pop(rid, None)
            return None
        return holder[0]

    # -- main loop -------------------------------------------------------------
    def serve(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "method" in msg:                          # a request or notification from the client
                self._dispatch(msg)
            elif "id" in msg:                            # a reply to one of our server requests
                slot = self._pending.pop(msg["id"], None)
                if slot:
                    slot[1][0] = msg.get("result")
                    slot[0].set()

    def _dispatch(self, msg: dict) -> None:
        method = msg.get("method")
        rid = msg.get("id")
        params = msg.get("params") or {}

        if method == "initialize":
            self.respond(rid, {
                "protocolVersion": params.get("protocolVersion", 1),
                "agentCapabilities": {"loadSession": False,
                                      "promptCapabilities": {"image": True, "embeddedContext": True}},
                "authMethods": [],
                "serverInfo": {"name": "dgc", "version": __version__}})

        elif method == "session/new":
            cwd = params.get("cwd")
            config = Config(project_root=Path(cwd)) if cwd else Config()
            self.ui = _ACPUi(self, self.session_id)
            self.agent = Agent(config, self.ui)
            self.respond(rid, {"sessionId": self.session_id})

        elif method == "session/prompt":
            if not self.agent:
                self.respond(rid, error={"code": -32002, "message": "no session — call session/new first"})
                return
            text = _prompt_text(params.get("prompt", []))
            images = _prompt_images(params.get("prompt", []))

            def run():
                self.agent._pending_images = images or None
                self.agent.run_turn(text)
                reason = "cancelled" if self.agent.cancelled.is_set() else "end_turn"
                self.respond(rid, {"stopReason": reason})

            threading.Thread(target=run, daemon=True).start()

        elif method == "session/cancel":
            if self.agent:
                self.agent.cancelled.set()
            # notification — no response

        elif rid is not None:
            self.respond(rid, error={"code": -32601, "message": f"method not found: {method}"})


def _prompt_text(blocks) -> str:
    return "\n".join(b.get("text", "") for b in blocks
                     if isinstance(b, dict) and b.get("type") == "text").strip()


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

    def __init__(self, server: ACPServer, sid: str):
        self.s = server
        self.sid = sid
        self._tc = itertools.count(1)
        self._last_tool = None

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
    def tool_call(self, name, args):
        tcid = f"tc{next(self._tc)}"
        self._last_tool = tcid
        self._update({"sessionUpdate": "tool_call", "toolCallId": tcid, "title": name,
                      "kind": _KIND.get(name, "other"), "status": "in_progress",
                      "rawInput": args, "content": [{"type": "content",
                      "content": {"type": "text", "text": arg_summary(name, args)}}]})

    def tool_result(self, name, out):
        is_diff, diff = split_diff(out)
        content = [{"type": "content", "content": {"type": "text", "text": out[:8000]}}]
        if is_diff:
            content = [{"type": "diff", "path": name, "newText": diff}]
        self._update({"sessionUpdate": "tool_call_update", "toolCallId": self._last_tool or "tc0",
                      "status": "completed", "content": content})

    def tool_denied(self, name, args, reason):
        self._update({"sessionUpdate": "tool_call_update", "toolCallId": self._last_tool or "tc0",
                      "status": "failed", "content": [{"type": "content",
                      "content": {"type": "text", "text": reason}}]})

    def on_todo(self, todos):
        self._update({"sessionUpdate": "plan", "entries": [
            {"content": t.get("content", ""), "priority": "medium",
             "status": _TODO_STATUS.get(t.get("status"), "pending")} for t in todos]})

    # decisions
    def approve(self, name, args):
        res = self.s.request("session/request_permission", {
            "sessionId": self.sid,
            "toolCall": {"toolCallId": self._last_tool or f"tc{next(self._tc)}", "title": name, "rawInput": args},
            "options": [
                {"optionId": "once", "name": "Allow once", "kind": "allow_once"},
                {"optionId": "always", "name": "Always allow", "kind": "allow_always"},
                {"optionId": "deny", "name": "Deny", "kind": "reject_once"}]})
        outcome = (res or {}).get("outcome", {})
        if outcome.get("outcome") == "selected":
            return {"once": "once", "always": "always", "deny": "no"}.get(outcome.get("optionId"), "no")
        return "no"

    def add_permission_rule(self, name, args):
        pass  # ACP clients persist their own permission state

    def present_plan(self, plan):
        # surface the plan, then approve into acceptEdits so the turn proceeds (ACP has no
        # plan-gate primitive beyond permissions; keep it moving)
        self.on_text("\n📋 Plan:\n" + plan + "\n")
        return "acceptEdits"

    def propose_options(self, question, options):
        res = self.s.request("session/request_permission", {
            "sessionId": self.sid,
            "toolCall": {"toolCallId": f"opt{next(self._tc)}", "title": question},
            "options": [{"optionId": str(i), "name": o, "kind": "allow_once"} for i, o in enumerate(options)]})
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


def serve() -> None:
    ACPServer().serve()
