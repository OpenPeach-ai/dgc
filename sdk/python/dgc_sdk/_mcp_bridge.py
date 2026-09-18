"""stdio ↔ Unix-socket relay so DGC can spawn an MCP server that lives in the SDK process.

``python -m dgc_sdk._mcp_bridge SOCKET`` copies NDJSON in both directions. The SDK host speaks
MCP on the accepted socket (initialize, tools/list, tools/call).
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any


def _sdk_version() -> str:
    try:
        from ._version import __version__
        return __version__
    except ImportError:
        text = Path(__file__).with_name("_version.py").read_text(encoding="utf-8")
        for line in text.splitlines():
            if line.startswith("__version__"):
                return line.split('"', 2)[1]
        return "0.0.0"


def relay(socket_path: str) -> int:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(socket_path)

    def stdin_to_sock() -> None:
        try:
            while True:
                line = sys.stdin.buffer.readline()
                if not line:
                    break
                sock.sendall(line)
        except OSError:
            pass
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    threading.Thread(target=stdin_to_sock, daemon=True).start()
    try:
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
    except OSError:
        pass
    return 0


class ToolHub:
    """Accept one MCP stdio proxy and dispatch ``tools/call`` to host handlers."""

    def __init__(self, socket_path: str, tools: SequenceToolMap):
        self.socket_path = socket_path
        self.tools = {item.name: item for item in tools}
        self._server: socket.socket | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.socket_path)
        server.listen(4)
        server.settimeout(1.0)
        self._server = server
        self._thread = threading.Thread(target=self._accept, name="dgc-sdk-mcp", daemon=True)
        self._thread.start()

    def close(self) -> None:
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
        if os.path.exists(self.socket_path):
            try:
                os.unlink(self.socket_path)
            except OSError:
                pass

    def _accept(self) -> None:
        assert self._server is not None
        while True:
            try:
                conn, _addr = self._server.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn: socket.socket) -> None:
        buf = b""
        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        message = json.loads(line.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    reply = self._handle(message)
                    if reply is not None:
                        conn.sendall((json.dumps(reply, separators=(",", ":")) + "\n").encode())
        except OSError:
            return
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _handle(self, message: Mapping[str, Any]) -> dict[str, Any] | None:
        method = str(message.get("method") or "")
        mid = message.get("id")
        if method == "initialize":
            return {
                "jsonrpc": "2.0", "id": mid,
                "result": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "dgc-sdk", "version": _sdk_version()},
                },
            }
        if method in ("notifications/initialized", "notifications/cancelled"):
            return None
        if method == "ping":
            return {"jsonrpc": "2.0", "id": mid, "result": {}}
        if method == "tools/list":
            tools = []
            for spec in self.tools.values():
                tools.append({
                    "name": spec.name,
                    "description": spec.description,
                    "inputSchema": dict(spec.input_schema) or {"type": "object", "properties": {}},
                })
            return {"jsonrpc": "2.0", "id": mid, "result": {"tools": tools}}
        if method == "tools/call":
            params = message.get("params") if isinstance(message.get("params"), dict) else {}
            name = str(params.get("name") or "")
            arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
            spec = self.tools.get(name)
            if spec is None:
                return {"jsonrpc": "2.0", "id": mid, "error": {
                    "code": -32601, "message": f"unknown tool {name}"}}
            try:
                result = self._call_handler(spec, arguments)
            except TimeoutError:
                return {"jsonrpc": "2.0", "id": mid, "result": {
                    "content": [{"type": "text", "text": "tool error: TimeoutError: handler exceeded timeout"}],
                    "isError": True,
                }}
            except Exception as exc:
                return {"jsonrpc": "2.0", "id": mid, "result": {
                    "content": [{"type": "text", "text": f"tool error: {type(exc).__name__}: {exc}"}],
                    "isError": True,
                }}
            text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": text[:120_000]}],
                "isError": False,
            }}
        if mid is not None:
            return {"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32601, "message": f"unsupported method {method}"}}
        return None

    def _call_handler(self, spec, arguments):
        timeout = getattr(spec, "timeout", None)
        if timeout is None:
            return spec.handler(arguments)
        box: list = []
        error: list = []

        def worker() -> None:
            try:
                box.append(spec.handler(arguments))
            except Exception as exc:
                error.append(exc)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        thread.join(float(timeout))
        if thread.is_alive():
            raise TimeoutError("handler exceeded timeout")
        if error:
            raise error[0]
        return box[0] if box else None


# Imported after types to keep this module usable as ``python -m``.
try:
    from .types import ToolSpec
    SequenceToolMap = list[ToolSpec]
except Exception:  # pragma: no cover - running as a frozen proxy
    ToolSpec = Any  # type: ignore[misc,assignment]
    SequenceToolMap = list


def define_tool(name: str, description: str, input_schema: Mapping[str, Any],
                handler: Callable[[Mapping[str, Any]], Any],
                timeout: float | None = 30.0) -> "ToolSpec":
    from .errors import DGCConfigError
    from .types import ToolSpec as Spec
    if not name or not isinstance(name, str) or not name.replace("_", "").replace("-", "").isalnum():
        raise DGCConfigError("tool name must be a non-empty identifier")
    if not description or not isinstance(description, str):
        raise DGCConfigError("tool description is required")
    if not isinstance(input_schema, Mapping):
        raise DGCConfigError("tool input_schema must be an object")
    if not callable(handler):
        raise DGCConfigError("tool handler must be callable")
    if timeout is not None and (not isinstance(timeout, (int, float)) or timeout <= 0):
        raise DGCConfigError("tool timeout must be a positive number of seconds")
    return Spec(name=name, description=description, input_schema=dict(input_schema),
                handler=handler, timeout=None if timeout is None else float(timeout))


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args:
        sys.stderr.write("usage: python -m dgc_sdk._mcp_bridge SOCKET\n")
        return 2
    return relay(args[0])


if __name__ == "__main__":
    raise SystemExit(main())
