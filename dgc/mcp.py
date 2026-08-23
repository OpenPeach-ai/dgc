"""Minimal MCP (Model Context Protocol) client — connect to stdio tool servers,
discover their tools, and call them. JSON-RPC 2.0 over each server's stdin/stdout.

Config (~/.dgc/config.json or project .dgc/config.json):
    "mcp_servers": {
      "fetch":  {"command": "uvx", "args": ["mcp-server-fetch"]},
      "git":    {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-git"]}
    }
Tools are exposed to the model as `mcp__<server>__<tool>` and routed back here.
"""
from __future__ import annotations

import itertools
import json
import os
import subprocess
import threading


class MCPServer:
    def __init__(self, name: str, command: str, args=None, env=None):
        self.name = name
        self.command = command
        self.args = list(args or [])
        from . import guards
        self.env, self._env_dropped = guards.screen_mcp_env(env)   # strip process-hijacking vars
        self.proc: subprocess.Popen | None = None
        self.tools: list[dict] = []
        self.error: str | None = None
        self._id = itertools.count(1)
        self._pending: dict[int, tuple] = {}
        self._lock = threading.Lock()

    # -- lifecycle -------------------------------------------------------------
    def start(self, timeout: float = 10.0) -> bool:
        try:
            self.proc = subprocess.Popen(
                [self.command, *self.args],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                env={**os.environ, **self.env}, text=True, bufsize=1)
        except Exception as e:
            self.error = f"could not launch: {e}"
            return False
        threading.Thread(target=self._reader, daemon=True).start()
        init = self._request("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "dgc", "version": "0"}}, timeout)
        if init is None:
            self.error = "no initialize response"
            self.stop()
            return False
        self._notify("notifications/initialized", {})
        res = self._request("tools/list", {}, timeout) or {}
        self.tools = res.get("tools", []) or []
        return True

    def stop(self) -> None:
        try:
            if self.proc:
                self.proc.terminate()
        except Exception:
            pass

    # -- json-rpc plumbing -----------------------------------------------------
    def _reader(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            mid = msg.get("id")
            with self._lock:
                slot = self._pending.pop(mid, None) if mid is not None else None
            if slot:
                ev, holder = slot
                holder["result"] = msg.get("result")
                holder["error"] = msg.get("error")
                ev.set()

    def _send(self, obj: dict) -> None:
        try:
            assert self.proc and self.proc.stdin
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()
        except Exception:
            pass

    def _request(self, method: str, params: dict, timeout: float):
        mid = next(self._id)
        ev = threading.Event()
        holder: dict = {}
        with self._lock:
            self._pending[mid] = (ev, holder)
        self._send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
        if not ev.wait(timeout):
            with self._lock:
                self._pending.pop(mid, None)
            return None
        if holder.get("error"):
            return None
        return holder.get("result")

    def _notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def call_tool(self, tool: str, arguments: dict, timeout: float = 120.0) -> str:
        res = self._request("tools/call", {"name": tool, "arguments": arguments}, timeout)
        if res is None:
            return f"MCP tool '{tool}' failed or timed out"
        content = res.get("content", []) or []
        parts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
        out = "\n".join(p for p in parts if p) or json.dumps(res)[:2000]
        return ("ERROR: " + out) if res.get("isError") else out


class MCPManager:
    def __init__(self):
        self.servers: dict[str, MCPServer] = {}

    def connect_all(self, config_servers: dict | None) -> None:
        if not isinstance(config_servers, dict):        # a corrupted mcp_servers value must not crash launch
            return
        for name, spec in config_servers.items():
            cmd = (spec or {}).get("command")
            if not cmd:
                continue
            s = MCPServer(name, cmd, spec.get("args"), spec.get("env"))
            if s.start():
                self.servers[name] = s

    def tool_schemas(self) -> list[dict]:
        schemas = []
        for name, s in self.servers.items():
            for t in s.tools:
                schemas.append({"type": "function", "function": {
                    "name": f"mcp__{name}__{t.get('name')}",
                    "description": (f"[MCP:{name}] {t.get('description', '')}")[:1000],
                    "parameters": t.get("inputSchema") or {"type": "object", "properties": {}}}})
        return schemas

    def call(self, full_name: str, arguments: dict) -> str:
        try:
            _, server, tool = full_name.split("__", 2)
        except ValueError:
            return f"malformed MCP tool name: {full_name}"
        s = self.servers.get(server)
        if not s:
            return f"MCP server '{server}' is not connected"
        return s.call_tool(tool, arguments)

    def summary(self) -> str:
        if not self.servers:
            return "no MCP servers connected"
        return "\n".join(f"  {n}: {len(s.tools)} tool(s) — {', '.join(t.get('name','') for t in s.tools)}"
                         for n, s in self.servers.items())

    def stop_all(self) -> None:
        for s in self.servers.values():
            s.stop()
