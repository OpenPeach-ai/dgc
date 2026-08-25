"""MCP stdio client with bounded process, request, content, and credential lifecycles."""
from __future__ import annotations

import atexit
import itertools
import json
import os
import re
import signal
import subprocess
import threading
import time
from pathlib import Path

MCP_PROTOCOL_VERSION = "2026-07-28"
_MAX_DIAGNOSTIC = 32_000
_MAX_CONTENT = 120_000


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(value)).strip("_") or "unnamed"


class MCPServer:
    def __init__(self, name: str, command: str, args=None, env=None, root: Path | None = None):
        self.name = str(name)
        self.command = str(command)
        self.args = [str(a) for a in (args or [])]
        self.root = Path(root).resolve(strict=False) if root else Path.cwd().resolve()
        from .guards import mcp_process_env
        self.env, self._env_dropped = mcp_process_env(env)
        self.proc: subprocess.Popen | None = None
        self.tools: list[dict] = []
        self.error: str | None = None
        self.protocol_version: str | None = None
        self.diagnostics = ""
        self._id = itertools.count(1)
        self._pending: dict[int, tuple[threading.Event, dict]] = {}
        self._lock = threading.Lock()
        self._send_lock = threading.Lock()

    # lifecycle ----------------------------------------------------------------
    def start(self, timeout: float = 10.0) -> bool:
        try:
            self.proc = subprocess.Popen(
                [self.command, *self.args],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=self.env, cwd=str(self.root), text=True, bufsize=1, start_new_session=True,
            )
        except Exception as e:
            self.error = f"could not launch: {e}"
            return False
        threading.Thread(target=self._reader, daemon=True, name=f"dgc-mcp-{self.name}-stdout").start()
        threading.Thread(target=self._stderr_reader, daemon=True, name=f"dgc-mcp-{self.name}-stderr").start()
        init, err = self._request("initialize", {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {"roots": {"listChanged": False}},
            "clientInfo": {"name": "dgc", "version": "0.20"},
        }, timeout)
        if init is None:
            self.error = f"initialize failed: {err or self._diagnostic_tail() or 'no response'}"
            self.stop()
            return False
        self.protocol_version = str(init.get("protocolVersion") or "")
        self._notify("notifications/initialized", {})
        cursor = None
        tools: list[dict] = []
        for _ in range(100):
            params = {"cursor": cursor} if cursor else {}
            page, err = self._request("tools/list", params, timeout)
            if page is None:
                self.error = f"tools/list failed: {err or self._diagnostic_tail() or 'no response'}"
                self.stop()
                return False
            tools.extend(t for t in (page.get("tools") or []) if isinstance(t, dict))
            cursor = page.get("nextCursor")
            if not cursor:
                break
        self.tools = tools
        return True

    def stop(self) -> None:
        proc = self.proc
        if not proc:
            return
        self.proc = None
        if proc.poll() is None:
            try:
                if os.name == "posix":
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                else:
                    proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                try:
                    if os.name == "posix":
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    else:
                        proc.kill()
                except Exception:
                    pass
                try:
                    proc.wait(timeout=2)
                except Exception:
                    pass
        self._fail_pending("server stopped")

    # JSON-RPC -----------------------------------------------------------------
    def _diagnostic_tail(self) -> str:
        return self.diagnostics[-2000:].strip()

    def _stderr_reader(self) -> None:
        proc = self.proc
        if not proc or not proc.stderr:
            return
        try:
            for line in proc.stderr:
                self.diagnostics = (self.diagnostics + line)[-_MAX_DIAGNOSTIC:]
        except Exception:
            pass

    def _fail_pending(self, message: str) -> None:
        with self._lock:
            pending, self._pending = list(self._pending.values()), {}
        for ev, holder in pending:
            holder["error"] = {"code": -32000, "message": message}
            ev.set()

    def _reader(self) -> None:
        proc = self.proc
        if not proc or not proc.stdout:
            return
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    self.diagnostics = (self.diagnostics + "\ninvalid stdout: " + line)[-_MAX_DIAGNOSTIC:]
                    continue
                if not isinstance(msg, dict):
                    continue
                mid = msg.get("id")
                if mid is not None and ("result" in msg or "error" in msg):
                    with self._lock:
                        slot = self._pending.pop(mid, None)
                    if slot:
                        ev, holder = slot
                        holder["result"] = msg.get("result")
                        holder["error"] = msg.get("error")
                        ev.set()
                    continue
                if mid is not None and msg.get("method"):
                    self._handle_server_request(mid, str(msg["method"]), msg.get("params") or {})
                elif msg.get("method") == "notifications/message":
                    data = msg.get("params") or {}
                    self.diagnostics = (self.diagnostics + "\n" + str(data.get("data", "")))[-_MAX_DIAGNOSTIC:]
        finally:
            self._fail_pending("server exited")

    def _handle_server_request(self, mid, method: str, params: dict) -> None:
        if method == "roots/list":
            self._send({"jsonrpc": "2.0", "id": mid, "result": {
                "roots": [{"uri": self.root.as_uri(), "name": self.root.name or str(self.root)}]
            }})
        elif method == "ping":
            self._send({"jsonrpc": "2.0", "id": mid, "result": {}})
        else:
            # Sampling and elicitation require their own user-consent/UI boundaries. DGC does not
            # advertise them and fails closed if a server requests them anyway.
            self._send({"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32601, "message": f"client method not supported: {method}"
            }})

    def _send(self, obj: dict) -> bool:
        proc = self.proc
        if not proc or not proc.stdin:
            return False
        try:
            wire = json.dumps(obj, separators=(",", ":")) + "\n"
            with self._send_lock:
                proc.stdin.write(wire)
                proc.stdin.flush()
            return True
        except Exception:
            return False

    def _request(self, method: str, params: dict, timeout: float,
                 cancel: threading.Event | None = None) -> tuple[dict | None, str | None]:
        mid = next(self._id)
        ev = threading.Event()
        holder: dict = {}
        with self._lock:
            self._pending[mid] = (ev, holder)
        if not self._send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}):
            with self._lock:
                self._pending.pop(mid, None)
            return None, "server stdin is unavailable"
        deadline = time.monotonic() + max(0.01, float(timeout))
        while not ev.wait(min(0.1, max(0.0, deadline - time.monotonic()))):
            reason = None
            if cancel is not None and cancel.is_set():
                reason = "cancelled by user"
            elif time.monotonic() >= deadline:
                reason = "request timed out"
            if reason:
                with self._lock:
                    self._pending.pop(mid, None)
                self._notify("notifications/cancelled", {"requestId": mid, "reason": reason})
                return None, reason
        err = holder.get("error")
        if err:
            return None, str(err.get("message", err) if isinstance(err, dict) else err)
        result = holder.get("result")
        return (result if isinstance(result, dict) else {}), None

    def _notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    # tools --------------------------------------------------------------------
    @staticmethod
    def _render_content(block: dict) -> str:
        kind = block.get("type")
        if kind == "text":
            return str(block.get("text", ""))
        if kind in ("image", "audio"):
            data = str(block.get("data", ""))
            return f"[MCP {kind}: {block.get('mimeType', 'unknown')} · {len(data)} base64 chars]"
        if kind == "resource_link":
            return f"[MCP resource link: {block.get('name') or block.get('uri')} · {block.get('uri', '')}]"
        if kind == "resource":
            resource = block.get("resource") or {}
            uri = resource.get("uri", "")
            if "text" in resource:
                return f"[MCP resource: {uri}]\n{resource.get('text', '')}"
            blob = str(resource.get("blob", ""))
            return f"[MCP resource: {uri} · {len(blob)} base64 chars]"
        return json.dumps(block, ensure_ascii=False)

    def call_tool(self, tool: str, arguments: dict, timeout: float = 120.0,
                  cancel: threading.Event | None = None) -> str:
        res, err = self._request("tools/call", {"name": tool, "arguments": arguments}, timeout, cancel)
        if res is None:
            detail = f" · {self._diagnostic_tail()}" if self._diagnostic_tail() else ""
            return f"ERROR: MCP tool '{tool}' failed: {err or 'no response'}{detail}"
        parts = [self._render_content(c) for c in (res.get("content") or []) if isinstance(c, dict)]
        if res.get("structuredContent") is not None:
            parts.append("[structured content]\n" + json.dumps(res["structuredContent"], ensure_ascii=False))
        out = "\n".join(p for p in parts if p) or "(MCP tool returned no content)"
        if len(out) > _MAX_CONTENT:
            out = out[:_MAX_CONTENT] + f"\n… MCP content truncated ({len(out) - _MAX_CONTENT} chars)"
        return ("ERROR: " + out) if res.get("isError") else out


class MCPManager:
    def __init__(self, root: Path | None = None):
        self.root = Path(root).resolve(strict=False) if root else Path.cwd().resolve()
        self.servers: dict[str, MCPServer] = {}
        self._routes: dict[str, tuple[str, str]] = {}
        atexit.register(self.stop_all)

    def connect_all(self, config_servers: dict | None) -> None:
        if not isinstance(config_servers, dict):
            return
        for raw_name, raw_spec in config_servers.items():
            if not isinstance(raw_spec, dict):
                continue
            cmd = raw_spec.get("command")
            if not isinstance(cmd, str) or not cmd.strip():
                continue
            name = str(raw_name)
            if name in self.servers:
                self.servers[name].stop()
            server = MCPServer(name, cmd, raw_spec.get("args"), raw_spec.get("env"), self.root)
            if server.start():
                self.servers[name] = server
        self._rebuild_routes()

    def _rebuild_routes(self) -> None:
        self._routes = {}
        for server_name, server in self.servers.items():
            for tool in server.tools:
                original = str(tool.get("name", ""))
                base = f"mcp__{_safe_name(server_name)}__{_safe_name(original)}"
                exposed = base
                n = 2
                while exposed in self._routes:
                    exposed, n = f"{base}_{n}", n + 1
                self._routes[exposed] = (server_name, original)

    def tool_schemas(self) -> list[dict]:
        schemas = []
        by_route = {route: pair for route, pair in self._routes.items()}
        for exposed, (server_name, original) in by_route.items():
            server = self.servers[server_name]
            tool = next((t for t in server.tools if str(t.get("name", "")) == original), {})
            schema = tool.get("inputSchema")
            if not isinstance(schema, dict):
                schema = {"type": "object", "properties": {}}
            schemas.append({"type": "function", "function": {
                "name": exposed,
                "description": (f"[MCP:{server_name}] {tool.get('description', '')}")[:1000],
                "parameters": schema,
            }})
        return schemas

    def call(self, full_name: str, arguments: dict,
             cancel: threading.Event | None = None) -> str:
        route = self._routes.get(full_name)
        if not route:
            return f"ERROR: unknown MCP tool route: {full_name}"
        server_name, tool = route
        server = self.servers.get(server_name)
        if not server:
            return f"ERROR: MCP server '{server_name}' is not connected"
        return server.call_tool(tool, arguments, cancel=cancel)

    def summary(self) -> str:
        if not self.servers:
            return "no MCP servers connected"
        rows = []
        for name, server in self.servers.items():
            dropped = f" · dropped env: {', '.join(server._env_dropped)}" if server._env_dropped else ""
            rows.append(f"  {name}: {len(server.tools)} tool(s) · MCP {server.protocol_version or '?'}{dropped}")
        return "\n".join(rows)

    def stop_all(self) -> None:
        for server in list(self.servers.values()):
            server.stop()
        self.servers.clear()
        self._routes.clear()
