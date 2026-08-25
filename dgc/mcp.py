"""MCP stdio client with bounded process, request, content, and credential lifecycles."""
from __future__ import annotations

import atexit
import itertools
import json
import math
import os
import re
import signal
import subprocess
import threading
import time
from pathlib import Path

from . import __version__

MCP_PROTOCOL_VERSION = "2026-07-28"
MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25"
_MAX_DIAGNOSTIC = 32_000
_MAX_CONTENT = 120_000
_MAX_FRAME = 4 * 1024 * 1024
_MAX_MRTR_ROUNDS = 4
_CLIENT_INFO = {"name": "dgc", "version": __version__}
_LOG_LEVELS = ("debug", "info", "notice", "warning", "error", "critical", "alert", "emergency")


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(value)).strip("_") or "unnamed"


def _bounded_lines(stream, limit: int = _MAX_FRAME):
    """Yield `(line, oversized)` without ever buffering an unbounded stdio frame."""
    cap = max(1, int(limit))
    while True:
        line = stream.readline(cap + 1)
        if not line:
            return
        oversized = len(line) > cap
        if oversized and not line.endswith("\n"):
            while True:
                tail = stream.readline(cap + 1)
                if not tail or tail.endswith("\n"):
                    break
        yield ("" if oversized else line), oversized


class MCPServer:
    def __init__(self, name: str, command: str, args=None, env=None, root: Path | None = None,
                 log_level: str = "warning"):
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
        self.protocol_era: str | None = None
        self.server_capabilities: dict = {}
        self.server_info: dict = {}
        self.instructions = ""
        self.negotiation_note = ""
        level = str(log_level or "warning").lower()
        self.log_level = level if level in (*_LOG_LEVELS, "off") else "warning"
        self.diagnostics = ""
        self._id = itertools.count(1)
        self._pending: dict[int, tuple[threading.Event, dict, int]] = {}
        self._lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._generation = 0

    # lifecycle ----------------------------------------------------------------
    def start(self, timeout: float = 10.0) -> bool:
        self.error = None
        if not self._launch():
            return False

        # 2026-07-28 removed initialize/initialized. Probe it on a disposable stdio process, as the
        # official SDKs do: a handshake-era server may reject or corrupt its state on an unknown
        # first request, so legacy fallback always receives a fresh process.
        probe_timeout = min(max(0.25, float(timeout)), 3.0)
        discovered, discover_error = self._request(
            "server/discover", {}, probe_timeout, modern=True)
        supported = (discovered or {}).get("supportedVersions")
        modern = (isinstance(discovered, dict)
                  and discovered.get("resultType") == "complete"
                  and isinstance(supported, list)
                  and MCP_PROTOCOL_VERSION in supported
                  and isinstance(discovered.get("capabilities"), dict))
        if modern:
            self.protocol_version = MCP_PROTOCOL_VERSION
            self.protocol_era = "modern"
            self.server_capabilities = dict(discovered.get("capabilities") or {})
            self.instructions = str(discovered.get("instructions") or "")[:8000]
            meta = discovered.get("_meta") if isinstance(discovered.get("_meta"), dict) else {}
            info = meta.get("io.modelcontextprotocol/serverInfo")
            self.server_info = dict(info) if isinstance(info, dict) else {}
        else:
            note = discover_error or "invalid server/discover response"
            self.negotiation_note = f"modern probe unavailable; used legacy handshake ({note[:240]})"
            self._stop_process(self.proc, self._generation)
            if not self._launch():
                return False
            init, err = self._request("initialize", {
                "protocolVersion": MCP_LEGACY_PROTOCOL_VERSION,
                "capabilities": {"roots": {"listChanged": False}},
                "clientInfo": _CLIENT_INFO,
            }, timeout, modern=False)
            if init is None:
                self.error = f"initialize failed: {err or self._diagnostic_tail() or 'no response'}"
                self.stop()
                return False
            selected = str(init.get("protocolVersion") or MCP_LEGACY_PROTOCOL_VERSION)
            if selected == MCP_PROTOCOL_VERSION:
                self.error = ("initialize returned MCP 2026-07-28, but that revision removed the "
                              "initialize handshake")
                self.stop()
                return False
            self.protocol_version = selected
            self.protocol_era = "legacy"
            self.server_capabilities = (dict(init.get("capabilities") or {})
                                        if isinstance(init.get("capabilities"), dict) else {})
            self.server_info = (dict(init.get("serverInfo") or {})
                                if isinstance(init.get("serverInfo"), dict) else {})
            self.instructions = str(init.get("instructions") or "")[:8000]
            self._notify("notifications/initialized", {})
            if self.log_level != "off" and "logging" in self.server_capabilities:
                _, log_error = self._request(
                    "logging/setLevel", {"level": self.log_level}, timeout, modern=False)
                if log_error:
                    self._append_diagnostic(f"logging/setLevel failed: {log_error}")

        if "tools" not in self.server_capabilities:
            self.tools = []
            return True

        if not self._load_tools(timeout):
            self.stop()
            return False
        return True

    def _launch(self) -> bool:
        try:
            proc = subprocess.Popen(
                [self.command, *self.args],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=self.env, cwd=str(self.root), text=True, bufsize=1, start_new_session=True,
            )
        except Exception as e:
            self.error = f"could not launch: {e}"
            return False
        self._generation += 1
        generation = self._generation
        self.proc = proc
        threading.Thread(target=self._reader, args=(proc, generation), daemon=True,
                         name=f"dgc-mcp-{self.name}-stdout").start()
        threading.Thread(target=self._stderr_reader, args=(proc,), daemon=True,
                         name=f"dgc-mcp-{self.name}-stderr").start()
        return True

    def _load_tools(self, timeout: float) -> bool:
        cursor = None
        tools: list[dict] = []
        for _ in range(100):
            params = {"cursor": cursor} if cursor else {}
            page, err = self._request("tools/list", params, timeout)
            if page is None:
                self.error = f"tools/list failed: {err or self._diagnostic_tail() or 'no response'}"
                return False
            if self.protocol_era == "modern" and page.get("resultType") != "complete":
                self.error = "tools/list returned an invalid modern resultType"
                return False
            tools.extend(t for t in (page.get("tools") or []) if isinstance(t, dict))
            cursor = page.get("nextCursor")
            if not cursor:
                break
        else:
            self.error = "tools/list exceeded 100 pagination pages"
            return False
        self.tools = tools
        return True

    def stop(self) -> None:
        self._stop_process(self.proc, self._generation)

    def _stop_process(self, proc: subprocess.Popen | None, generation: int) -> None:
        if not proc:
            return
        if self.proc is proc:
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
        self._fail_pending("server stopped", generation)

    # JSON-RPC -----------------------------------------------------------------
    def _diagnostic_tail(self) -> str:
        return self.diagnostics[-2000:].strip()

    def _append_diagnostic(self, value: str) -> None:
        text = str(value or "").strip()
        if text:
            self.diagnostics = (self.diagnostics + "\n" + text)[-_MAX_DIAGNOSTIC:]

    def _stderr_reader(self, proc: subprocess.Popen) -> None:
        if not proc.stderr:
            return
        try:
            for line, oversized in _bounded_lines(proc.stderr, 8192):
                self._append_diagnostic(
                    "oversized stderr frame discarded" if oversized else line)
        except Exception:
            pass

    def _fail_pending(self, message: str, generation: int) -> None:
        with self._lock:
            pending = []
            for mid, slot in list(self._pending.items()):
                if slot[2] == generation:
                    pending.append(slot)
                    self._pending.pop(mid, None)
        for ev, holder, _ in pending:
            holder["error"] = {"code": -32000, "message": message}
            ev.set()

    def _reader(self, proc: subprocess.Popen, generation: int) -> None:
        if not proc.stdout:
            return
        try:
            for line, oversized in _bounded_lines(proc.stdout):
                if oversized:
                    self._append_diagnostic("oversized stdout frame discarded")
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    self._append_diagnostic("invalid stdout: " + line[:2000])
                    continue
                if not isinstance(msg, dict):
                    continue
                mid = msg.get("id")
                if mid is not None and ("result" in msg or "error" in msg):
                    with self._lock:
                        slot = self._pending.get(mid)
                        if slot and slot[2] == generation:
                            self._pending.pop(mid, None)
                        else:
                            slot = None
                    if slot:
                        ev, holder, _ = slot
                        holder["result"] = msg.get("result")
                        holder["error"] = msg.get("error")
                        ev.set()
                    continue
                if mid is not None and msg.get("method"):
                    self._handle_server_request(
                        proc, mid, str(msg["method"]), msg.get("params") or {})
                elif msg.get("method") == "notifications/progress":
                    self._handle_progress(msg.get("params") or {}, generation)
                elif msg.get("method") == "notifications/message":
                    self._handle_log(msg.get("params") or {}, generation)
        finally:
            self._fail_pending("server exited", generation)

    def _handle_server_request(self, proc: subprocess.Popen, mid, method: str, params: dict) -> None:
        if self.protocol_era == "modern":
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32601,
                "message": "server-initiated requests are not valid in MCP 2026-07-28; use MRTR",
            }})
            return
        if method == "roots/list":
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "result": {
                "roots": [{"uri": self.root.as_uri(), "name": self.root.name or str(self.root)}]
            }})
        elif method == "ping":
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "result": {}})
        else:
            # Sampling and elicitation require their own user-consent/UI boundaries. DGC does not
            # advertise them and fails closed if a server requests them anyway.
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32601, "message": f"client method not supported: {method}"
            }})

    def _send(self, obj: dict) -> bool:
        proc = self.proc
        return self._send_to(proc, obj) if proc else False

    def _send_to(self, proc: subprocess.Popen | None, obj: dict) -> bool:
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

    @staticmethod
    def _client_capabilities() -> dict:
        # DGC can answer roots/list in both the legacy callback channel and modern MRTR. Sampling
        # and elicitation are deliberately absent until their user-consent boundaries are complete.
        return {"roots": {}}

    def _request_meta(self, progress_token=None) -> dict:
        meta = {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": _CLIENT_INFO,
            "io.modelcontextprotocol/clientCapabilities": self._client_capabilities(),
        }
        if progress_token is not None:
            meta["progressToken"] = progress_token
        if (self.log_level != "off" and self.protocol_era == "modern"
                and "logging" in self.server_capabilities):
            meta["io.modelcontextprotocol/logLevel"] = self.log_level
        return meta

    def _request(self, method: str, params: dict, timeout: float,
                 cancel: threading.Event | None = None, *, modern: bool | None = None,
                 on_progress=None, on_log=None) -> tuple[dict | None, str | None]:
        mid = next(self._id)
        proc, generation = self.proc, self._generation
        if proc is None:
            return None, "server process is unavailable"
        ev = threading.Event()
        use_modern = (self.protocol_era == "modern") if modern is None else bool(modern)
        wire_params = dict(params or {})
        progress_token = f"dgc:{self.name}:{mid}" if on_progress is not None else None
        if use_modern:
            existing = wire_params.get("_meta")
            meta = dict(existing) if isinstance(existing, dict) else {}
            meta.update(self._request_meta(progress_token))
            wire_params["_meta"] = meta
        elif progress_token is not None:
            existing = wire_params.get("_meta")
            meta = dict(existing) if isinstance(existing, dict) else {}
            meta["progressToken"] = progress_token
            wire_params["_meta"] = meta
        holder: dict = {
            "progress_token": progress_token, "on_progress": on_progress, "on_log": on_log,
            "last_progress": -math.inf, "last_progress_emit": 0.0, "last_log_emit": 0.0,
        }
        with self._lock:
            self._pending[mid] = (ev, holder, generation)
        if not self._send_to(proc, {
                "jsonrpc": "2.0", "id": mid, "method": method, "params": wire_params}):
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
                # Address the process that owns this request. A reconnect may already have
                # installed a replacement in ``self.proc``; cancellation must never leak across
                # generations and terminate an unrelated request with the same server name.
                self._send_to(proc, {"jsonrpc": "2.0", "method": "notifications/cancelled",
                                     "params": {"requestId": mid, "reason": reason}})
                return None, reason
        err = holder.get("error")
        if err:
            return None, str(err.get("message", err) if isinstance(err, dict) else err)
        result = holder.get("result")
        return (result if isinstance(result, dict) else {}), None

    def _handle_progress(self, params: dict, generation: int) -> None:
        if not isinstance(params, dict):
            return
        token, progress = params.get("progressToken"), params.get("progress")
        if isinstance(progress, bool) or not isinstance(progress, (int, float)) or not math.isfinite(progress):
            return
        callback = None
        payload = None
        now = time.monotonic()
        with self._lock:
            for _mid, (_ev, holder, gen) in self._pending.items():
                if gen != generation or token != holder.get("progress_token"):
                    continue
                if progress <= holder.get("last_progress", -math.inf):
                    return
                holder["last_progress"] = progress
                total = params.get("total")
                total_ok = (not isinstance(total, bool) and isinstance(total, (int, float))
                            and math.isfinite(total))
                complete = total_ok and progress >= total
                if now - holder.get("last_progress_emit", 0.0) < 0.1 and not complete:
                    return
                holder["last_progress_emit"] = now
                callback = holder.get("on_progress")
                payload = {"progress": progress,
                           "total": total if total_ok else None,
                           "message": str(params.get("message") or "")[:500]}
                break
        if callback and payload:
            try:
                callback(payload)
            except Exception:
                pass

    def _handle_log(self, params: dict, generation: int) -> None:
        if not isinstance(params, dict):
            return
        level = str(params.get("level") or "info").lower()
        if level not in _LOG_LEVELS:
            return
        if self.log_level == "off" or _LOG_LEVELS.index(level) < _LOG_LEVELS.index(self.log_level):
            return
        logger = str(params.get("logger") or "")[:120]
        data = params.get("data")
        if isinstance(data, str):
            message = data
        else:
            try:
                message = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
            except (TypeError, ValueError):
                message = str(data)
        message = message[:1000]
        self._append_diagnostic(f"{level}{f' [{logger}]' if logger else ''}: {message}")
        callbacks = []
        now = time.monotonic()
        with self._lock:
            for _mid, (_ev, holder, gen) in self._pending.items():
                if gen == generation and holder.get("on_log") is not None:
                    if now - holder.get("last_log_emit", 0.0) >= 0.1:
                        holder["last_log_emit"] = now
                        callbacks.append(holder["on_log"])
        for callback in callbacks[:1]:
            try:
                callback({"level": level, "logger": logger, "message": message})
            except Exception:
                pass

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
                  cancel: threading.Event | None = None, *, on_progress=None, on_log=None) -> str:
        params = {"name": tool, "arguments": arguments}
        res = None
        for _round in range(_MAX_MRTR_ROUNDS):
            res, err = self._request("tools/call", params, timeout, cancel,
                                     on_progress=on_progress, on_log=on_log)
            if res is None:
                detail = f" · {self._diagnostic_tail()}" if self._diagnostic_tail() else ""
                return f"ERROR: MCP tool '{tool}' failed: {err or 'no response'}{detail}"
            if self.protocol_era != "modern" or res.get("resultType") == "complete":
                break
            if res.get("resultType") != "input_required":
                return f"ERROR: MCP tool '{tool}' returned an invalid modern resultType"
            requests = res.get("inputRequests") or {}
            if not isinstance(requests, dict):
                return f"ERROR: MCP tool '{tool}' returned malformed inputRequests"
            responses = {}
            unsupported = []
            for key, request in requests.items():
                method = request.get("method") if isinstance(request, dict) else None
                if method == "roots/list":
                    responses[str(key)] = {"resultType": "complete", "roots": [{
                        "uri": self.root.as_uri(), "name": self.root.name or str(self.root)}]}
                else:
                    unsupported.append(str(method or "malformed request"))
            if unsupported:
                return (f"ERROR: MCP tool '{tool}' requires unsupported client input: "
                        + ", ".join(unsupported[:8]))
            request_state = res.get("requestState")
            if not requests and not isinstance(request_state, str):
                return f"ERROR: MCP tool '{tool}' returned an empty input_required result"
            params = {"name": tool, "arguments": arguments}
            if responses:
                params["inputResponses"] = responses
            if isinstance(request_state, str):
                params["requestState"] = request_state
        else:
            return f"ERROR: MCP tool '{tool}' exceeded {_MAX_MRTR_ROUNDS} input rounds"
        if self.protocol_era == "modern" and res.get("resultType") != "complete":
            return f"ERROR: MCP tool '{tool}' did not complete"
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
        self.failures: dict[str, str] = {}
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
            self.failures.pop(name, None)
            old = self.servers.pop(name, None)
            if old is not None:
                old.stop()
            server = MCPServer(name, cmd, raw_spec.get("args"), raw_spec.get("env"), self.root,
                               str(raw_spec.get("log_level") or "warning"))
            if server.start():
                self.servers[name] = server
            else:
                self.failures[name] = server.error or "connection failed"
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
             cancel: threading.Event | None = None, *, on_progress=None, on_log=None) -> str:
        route = self._routes.get(full_name)
        if not route:
            return f"ERROR: unknown MCP tool route: {full_name}"
        server_name, tool = route
        server = self.servers.get(server_name)
        if not server:
            return f"ERROR: MCP server '{server_name}' is not connected"
        return server.call_tool(tool, arguments, cancel=cancel,
                                on_progress=on_progress, on_log=on_log)

    def summary(self) -> str:
        if not self.servers and not self.failures:
            return "no MCP servers connected"
        rows = []
        for name, server in self.servers.items():
            dropped = f" · dropped env: {', '.join(server._env_dropped)}" if server._env_dropped else ""
            rows.append(f"  {name}: {len(server.tools)} tool(s) · MCP {server.protocol_version or '?'} "
                        f"({server.protocol_era or '?'}){dropped}")
        for name, error in self.failures.items():
            rows.append(f"  {name}: failed · {error[:500]}")
        return "\n".join(rows)

    def stop_all(self) -> None:
        for server in list(self.servers.values()):
            server.stop()
        self.servers.clear()
        self._routes.clear()
        self.failures.clear()
