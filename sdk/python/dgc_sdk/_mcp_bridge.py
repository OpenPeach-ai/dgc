"""stdio ↔ Unix-socket relay so DGC can spawn an MCP server that lives in the SDK process.

DGC runs ``python -I .../_mcp_bridge.py SOCKET`` with the session's secret in
``DGC_SDK_TOOL_TOKEN``. The relay proves it knows the secret, then copies NDJSON in both
directions; the SDK host speaks MCP on the accepted socket (initialize, tools/list, tools/call).

``-I`` keeps this file's own directory off ``sys.path``: run as a script from inside the
package, ``dgc_sdk/types.py`` would otherwise stand in for the standard ``types`` module and
the relay would die on its first import. The relay itself needs only the standard library.
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
import shutil
import socket
import struct
import sys
import tempfile
import threading
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

TOKEN_ENV = "DGC_SDK_TOOL_TOKEN"
SERVER_NAME = "app"
_HELLO_KEY = "dgc_sdk_bridge"
_HELLO_TIMEOUT_S = 10.0
_HELLO_MAX = 4096
# sun_path holds 104 bytes on macOS and 108 on Linux, terminator included.
_SOCKET_PATH_MAX = 100


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


def _hide_environment() -> None:
    """Keep the secret this relay was started with away from other processes of the same user.

    Linux shows every process's starting environment in ``/proc/<pid>/environ`` to the same
    user; a non-dumpable process's is readable only with ``CAP_SYS_PTRACE``. So an agent's shell
    running as this user cannot lift the token from the relay and call the tools directly.
    """
    if not sys.platform.startswith("linux"):
        return
    try:
        import ctypes
        ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0)   # PR_SET_DUMPABLE, 0
    except (AttributeError, ImportError, OSError, TypeError):
        pass


def relay(socket_path: str) -> int:
    _hide_environment()
    token = os.environ.pop(TOKEN_ENV, "")
    if not token:
        sys.stderr.write(f"dgc-sdk tool bridge: {TOKEN_ENV} is not set\n")
        return 2
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(socket_path)
        sock.sendall((json.dumps({_HELLO_KEY: 1, "token": token}) + "\n").encode("utf-8"))
    except OSError as exc:
        sys.stderr.write(f"dgc-sdk tool bridge: cannot reach the application: {exc}\n")
        return 1

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


def _private_socket_path() -> tuple[str, str]:
    """A fresh 0700 directory with a random socket name, short enough for ``sun_path``.

    The directory's mode keeps other users out; its random name means nothing can be planted or
    squatted at a predictable path ahead of time.
    """
    from .errors import DGCConfigError
    bases: list[str] = []
    for base in (os.environ.get("XDG_RUNTIME_DIR") or "", tempfile.gettempdir(), "/tmp"):
        if base and base not in bases and os.path.isdir(base):
            bases.append(base)
    for base in bases:
        try:
            directory = tempfile.mkdtemp(prefix="dgc-", dir=base)
        except OSError:
            continue
        path = os.path.join(directory, secrets.token_hex(4) + ".sock")
        if len(os.fsencode(path)) <= _SOCKET_PATH_MAX:
            return directory, path
        shutil.rmtree(directory, ignore_errors=True)
    raise DGCConfigError(
        "custom tools need a Unix socket path under 100 bytes; none of "
        f"{', '.join(bases) or 'the temporary directories'} is short enough (set TMPDIR to a "
        "short directory)")


def _peer_uid(conn: socket.socket) -> int | None:
    option = getattr(socket, "SO_PEERCRED", None)
    if option is None:
        return None
    try:
        raw = conn.getsockopt(socket.SOL_SOCKET, option, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", raw)
    except OSError:
        return None
    return uid


class ToolHub:
    """Serve host tool handlers to the authenticated MCP stdio relay DGC starts.

    The socket lives in a private 0700 directory under a random name, and a connection is served
    only after its first line carries this session's secret (and, on Linux, only from this
    user), so other users and processes that do not hold the secret cannot call the tools. DGC
    hands the secret to the relay in its environment, which is never persisted; on Linux the
    relay makes itself non-dumpable at once, so other processes of the same user cannot read it
    from ``/proc``. On macOS a process of the same user could still inspect the relay; the OS
    sandbox keeps the agent's shell from seeing the relay process or this socket.
    """

    def __init__(self, tools: SequenceToolMap, socket_path: str | None = None):
        self.tools = {item.name: item for item in tools}
        self.token = secrets.token_urlsafe(32)
        self._directory: str | None = None
        self.socket_path = socket_path or ""
        self._server: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self.authenticated = threading.Event()
        self.rejected = 0

    def start(self) -> None:
        from .errors import DGCConfigError, DGCUnsupportedError
        if not hasattr(socket, "AF_UNIX"):
            raise DGCUnsupportedError(
                f"custom tools need Unix domain sockets, which Python does not offer on {sys.platform}")
        if not self.socket_path:
            self._directory, self.socket_path = _private_socket_path()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server.bind(self.socket_path)
            os.chmod(self.socket_path, 0o600)
            server.listen(4)
        except OSError as exc:
            server.close()
            self._remove_files()
            raise DGCConfigError(f"custom tools could not open their socket: {exc}") from exc
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
        self._remove_files()

    def _remove_files(self) -> None:
        if self.socket_path and os.path.exists(self.socket_path):
            try:
                os.unlink(self.socket_path)
            except OSError:
                pass
        if self._directory:
            shutil.rmtree(self._directory, ignore_errors=True)
            self._directory = None

    def server_spec(self, python: str) -> tuple[dict[str, Any], dict[str, Any]]:
        """(runtime, persisted) MCP server specs for ``upsert_mcp_server``.

        The secret rides only in the runtime spec's env; the persisted spec names the variable.
        """
        bridge = str(Path(__file__).resolve())
        args = ["-I", bridge, self.socket_path]
        persisted = {"transport": "stdio", "command": python, "args": args,
                     "env_names": [TOKEN_ENV], "log_level": "warning"}
        return {**persisted, "env": {TOKEN_ENV: self.token}}, persisted

    def _authenticate(self, conn: socket.socket) -> bytes | None:
        """Read the relay's hello line; return any bytes after it, or None to drop the peer."""
        uid = _peer_uid(conn)
        if uid is not None and hasattr(os, "getuid") and uid != os.getuid():
            return None
        conn.settimeout(_HELLO_TIMEOUT_S)
        buf = b""
        try:
            while b"\n" not in buf:
                chunk = conn.recv(_HELLO_MAX)
                if not chunk:
                    return None
                buf += chunk
                if len(buf) > _HELLO_MAX:
                    return None
        except OSError:
            return None
        line, rest = buf.split(b"\n", 1)
        try:
            hello = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        token = hello.get("token") if isinstance(hello, dict) else None
        if not isinstance(token, str) or not hmac.compare_digest(
                token.encode("utf-8"), self.token.encode("utf-8")):
            return None
        conn.settimeout(None)
        return rest

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
        rest = self._authenticate(conn)
        if rest is None:
            self.rejected += 1
            try:
                conn.close()
            except OSError:
                pass
            return
        self.authenticated.set()
        buf = rest
        try:
            while True:
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
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buf += chunk
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


# The relay runs this file as a standalone script (no package), where the relative import fails.
# Type checkers always take the package branch, so define_tool() is typed for callers.
if TYPE_CHECKING:
    from .types import ToolSpec
    SequenceToolMap = list[ToolSpec]
else:
    try:
        from .types import ToolSpec
        SequenceToolMap = list[ToolSpec]
    except Exception:  # pragma: no cover - running as a frozen proxy
        ToolSpec = Any
        SequenceToolMap = list


def define_tool(name: str, description: str, input_schema: Mapping[str, Any],
                handler: Callable[[Mapping[str, Any]], Any],
                timeout: float | None = 30.0) -> "ToolSpec":
    """Describe a tool the agent can call and this process runs (``mcp__app__<name>``).

    ``handler`` receives the call's arguments and returns a string or JSON-able value. When it
    runs past ``timeout`` seconds the agent is told the call failed, but the handler's thread is
    not stopped: make handlers idempotent or bound their own work. Refuse or allow the tool with
    ``RuntimePolicy(deny_tools=("mcp__app__<name>",))`` or ``allow_tools``.
    """
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


def bridge_python(runtime: Sequence[str] | None = None) -> str:
    """The interpreter DGC runs the relay with. The relay is standard-library only, so this
    host's own Python serves; a ``python -m dgc`` runtime's interpreter is the fallback. A
    runtime launcher such as ``dgc`` is never mistaken for a Python."""
    from .errors import DGCConfigError
    candidates = [sys.executable or ""]
    argv = list(runtime or ())
    # ``python -m dgc serve``, or ``python -P -m dgc serve`` as runtime discovery starts it.
    if any(argv[index:index + 2] == ["-m", "dgc"] for index in (1, 2)):
        candidates.append(argv[0])
    candidates += [shutil.which("python3") or "", shutil.which("python") or ""]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return os.path.abspath(candidate)
    raise DGCConfigError("custom tools need a Python interpreter to run their bridge; none found")


def _catalog_problem(catalog: Mapping[str, Any], expected: int) -> str:
    if catalog.get("error"):
        return str(catalog.get("error"))
    items = catalog.get("items") if isinstance(catalog.get("items"), list) else []
    entry = next((item for item in items
                  if isinstance(item, Mapping) and item.get("name") == SERVER_NAME), None)
    if entry is None:
        return "the runtime did not register the tool server"
    state = str(entry.get("state") or "")
    if entry.get("error") or state != "connected":
        return str(entry.get("error") or f"the tool server is {state or 'not connected'}")
    count = int(entry.get("tool_count") or 0)
    if count < expected:
        return f"the tool server offered {count} of {expected} tools"
    return ""


def install_tools(transport: Any, tools: Sequence[Any], *, runtime: Sequence[str] | None,
                  request_id: str, timeout: float = 20.0) -> ToolHub:
    """Start the host tool server, register it with DGC as MCP server ``app``, and confirm it.

    Raises :class:`~dgc_sdk.DGCRuntimeError` when DGC could not start or reach the tools, rather
    than leaving a session whose model silently lacks them.
    """
    from .errors import DGCRuntimeError
    hub = ToolHub(list(tools))
    hub.start()
    try:
        runtime_spec, persisted = hub.server_spec(bridge_python(runtime))
        catalog = transport.request(
            {"type": "upsert_mcp_server", "request_id": request_id, "name": SERVER_NAME,
             "runtime": runtime_spec, "persisted": persisted},
            "mcp_servers", timeout=timeout)
        problem = _catalog_problem(catalog, len(hub.tools))
        if not problem and not hub.authenticated.is_set():
            problem = "the tool bridge never authenticated to the application"
        if problem:
            raise DGCRuntimeError(f"custom tools failed to start: {problem}")
    except BaseException:
        hub.close()
        raise
    return hub


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args:
        sys.stderr.write("usage: python -I _mcp_bridge.py SOCKET  (with DGC_SDK_TOOL_TOKEN set)\n")
        return 2
    return relay(args[0])


if __name__ == "__main__":
    raise SystemExit(main())
