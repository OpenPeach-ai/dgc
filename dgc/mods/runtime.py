"""One mod, one small process: JSON-RPC 2.0 over stdio, a JSON object a line, in a sandbox of its own.

The sandbox (Linux: bubblewrap; macOS: Seatbelt) gives a mod its own folder, DGC's authoring library and the
interpreter's install, all read-only, a private scratch folder, and nothing else: no home folder, no network, no other
process. Everything else it gets, it asks DGC for over the pipe (http.fetch to the hosts it declared, files.read in the
project when it declared it, ...), and the host (host.py) checks every request against the manifest.

A process that dies, hangs past its answer's deadline or writes garbage is stopped and said to be stopped, with its
error; DGC carries on. Nothing here can approve anything: the host merges a mod's answers so they can only stop a
step or ask the user first.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .manifest import Manifest

LIB = Path(__file__).resolve().parent / "py"          # dgc_mod.py: the authoring library, put on a mod's path
MAX_LINE = 1024 * 1024
STDERR_KEEP = 4096
MAX_REQUESTS = 16
WRITE_SECONDS = 2.0


class ModError(RuntimeError):
    """A mod didn't answer, or answered with an error; the text says which."""


def _terminate(proc) -> None:
    """End the session's process group too, so children cannot keep its pipes open."""
    if os.name == "posix":
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    elif proc.poll() is None:
        proc.kill()


def _interpreter(m: Manifest) -> list[str] | None:
    if m.runtime == "python":
        boot = ("import sys,runpy;sys.path[:0]=[sys.argv[1],sys.argv[2]];sys.argv=sys.argv[3:];"
                "runpy.run_path(sys.argv[0],run_name='__main__')")
        return [sys.executable, "-I", "-u", "-c", boot, str(LIB), str(m.folder), str(m.entry_path)]
    node = shutil.which("node")
    return [node, str(m.entry_path)] if node else None


def _install_roots(argv0: str) -> list[Path]:
    """The folders an interpreter needs to start (its prefix, and Python's base prefix), so a sandbox can show them."""
    from .. import sandbox
    roots = []
    account = sandbox._account_home()
    exe = Path(argv0).resolve()
    if "python" in exe.name:
        candidates = [Path(sys.prefix), Path(sys.base_prefix), Path(sys.exec_prefix), exe.parent.parent]
    else:
        candidates = [exe.parent.parent]
    for c in candidates:
        try:
            c = c.resolve()
        except OSError:
            continue
        if account is not None and (c == account or c in account.parents):
            continue  # e.g. ~/bin/node must not expose the account's entire home
        if c != Path("/") and c not in roots:
            roots.append(c)
    return roots


def sandboxed_argv(m: Manifest, argv: list[str], scratch: Path) -> list[str] | None:
    """argv inside the OS sandbox, or None where there's none."""
    from .. import sandbox
    backend = sandbox._backend()
    if backend is None:
        return None
    kind, executable = backend
    shown = [m.folder, LIB, *_install_roots(argv[0])]
    if kind == "bwrap":
        # No --die-with-parent: Linux ties it to the parent THREAD, and a screen starts mods on a thread that ends
        # (the terminal's), which killed every mod as it finished. A mod ends when DGC does anyway: its stdin closes
        # and the authoring library (py/dgc_mod.py) stops at the end of its input.
        out = [str(executable), "--unshare-all", "--unshare-user", "--new-session",
               "--disable-userns", "--tmpfs", "/", "--tmpfs", "/tmp"]
        # Start with an empty filesystem. Masking only home and /tmp over a host-root
        # bind left projects and data in /var, /srv and mounted volumes readable.
        system = [Path(p) for p in ("/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache")]
        for path in dict.fromkeys([*system, *shown]):
            if path.exists():
                out += ["--ro-bind", str(path), str(path)]
        out += ["--bind", str(scratch), str(scratch), "--proc", "/proc", "--dev", "/dev", "--chdir", str(m.folder)]
        return out + argv
    if kind == "sandbox-exec":
        from .. import seatbelt
        system = [Path(p) for p in ("/System", "/usr/lib", "/usr/share", "/bin", "/sbin", "/dev")]
        readable = [p for p in [*system, *shown, scratch] if p.exists()]
        profile = seatbelt.profile(writable=[scratch], hidden=[Path("/")], readable=readable,
                                   reachable=readable, network=False)
        return [str(executable), "-p", profile] + argv
    return None


class ModProcess:
    """A running mod. ``on_request(method, params) -> result`` answers what the mod asks (it raises ModError to
    refuse); ``on_exit(proc)`` hears that it stopped."""

    def __init__(self, manifest: Manifest, *, on_request, on_exit=None, sandboxed: bool = True):
        self.manifest = manifest
        self.on_request = on_request
        self.on_exit = on_exit
        self.sandboxed = sandboxed
        self.state = "stopped"            # starting, running, stopped, crashed
        self.error = ""
        self.stderr = deque(maxlen=64)
        self._proc: subprocess.Popen | None = None
        self._pending: dict[int, dict] = {}
        self._next = 0
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix=f"mod-{manifest.name}")
        self._request_slots = threading.BoundedSemaphore(MAX_REQUESTS)
        self._scratch: Path | None = None

    # -- life ---------------------------------------------------------------------------------------------------
    def start(self) -> None:
        argv = _interpreter(self.manifest)
        if argv is None:
            self._fail("Node.js isn't installed, and this mod is JavaScript.")
            return
        self._scratch = Path(tempfile.mkdtemp(prefix=f"dgc-mod-{self.manifest.name}-"))
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": os.environ.get("LANG", "C.UTF-8"),
               "HOME": str(self._scratch), "TMPDIR": str(self._scratch), "DGC_MOD": self.manifest.name,
               "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
        if self.sandboxed:
            confined = sandboxed_argv(self.manifest, argv, self._scratch)
            if confined is None:
                self._fail("There's no sandbox on this computer to run it in.")
                return
            argv = confined
        self.state = "starting"
        try:
            self._proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                          cwd=str(self.manifest.folder), env=env, start_new_session=True)
        except OSError as error:
            self._fail(f"It couldn't start: {error.strerror or error}.")
            return
        self.state = "running"
        threading.Thread(target=self._read, daemon=True, name=f"mod-{self.manifest.name}-out").start()
        threading.Thread(target=self._read_err, daemon=True, name=f"mod-{self.manifest.name}-err").start()

    def stop(self, timeout: float = 2.0) -> None:
        proc = self._proc
        if proc is None:
            return
        if proc.poll() is None:
            try:
                self.notify("shutdown", {})
            except ModError:
                pass
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                _terminate(proc)
                proc.wait(timeout=2)
        self._finish("stopped", "")

    def _fail(self, why: str) -> None:
        self.state, self.error = "crashed", why

    def _finish(self, state: str, error: str) -> None:
        with self._lock:
            if self.state in ("stopped", "crashed") and self._proc is None:
                return
            self.state = state if self.state != "crashed" else self.state
            if error and not self.error:
                self.error = error
            pending, self._pending = self._pending, {}
            proc, self._proc = self._proc, None
        for waiting in pending.values():
            waiting["error"] = self.error or "The mod stopped."
            waiting["done"].set()
        if proc is not None:
            _terminate(proc)
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        self._pool.shutdown(wait=False, cancel_futures=True)
        for stream in ((proc.stdin, proc.stdout, proc.stderr) if proc else ()):
            try:
                stream.close()
            except OSError:
                pass
        if self._scratch is not None:
            shutil.rmtree(self._scratch, ignore_errors=True)
            self._scratch = None
        if self.on_exit is not None:
            try:
                self.on_exit(self)
            except Exception:                              # noqa: BLE001
                pass

    # -- the pipe -----------------------------------------------------------------------------------------------
    def _send(self, message: dict, timeout: float = WRITE_SECONDS) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            raise ModError("The mod isn't running.")
        data = (json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        if len(data) > MAX_LINE:
            raise ModError("The message to the mod is larger than 1 MB.")
        timeout = max(.01, min(timeout, WRITE_SECONDS))
        complete, expired = threading.Event(), threading.Event()
        def expire():
            if complete.is_set():
                return
            expired.set()
            self._fail("The mod stopped reading its input.")
            _terminate(proc)
        watchdog = threading.Timer(timeout, expire)
        watchdog.daemon = True
        watchdog.start()
        locked = False
        try:
            locked = self._write_lock.acquire(timeout=timeout)
            if not locked:
                expire()
                raise ModError("The mod stopped reading its input.")
            try:
                proc.stdin.write(data)
                proc.stdin.flush()
            except (OSError, ValueError):
                raise ModError("The mod isn't running.") from None
            if expired.is_set():
                raise ModError("The mod stopped reading its input.")
        finally:
            complete.set()
            watchdog.cancel()
            if locked:
                self._write_lock.release()

    def notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method: str, params: dict, timeout: float = 2.0):
        deadline = time.monotonic() + timeout
        with self._lock:
            self._next += 1
            ident = self._next
            waiting = {"done": threading.Event(), "result": None, "error": None}
            self._pending[ident] = waiting
        try:
            self._send({"jsonrpc": "2.0", "id": ident, "method": method, "params": params}, timeout=timeout)
            if not waiting["done"].wait(max(0, deadline - time.monotonic())):
                raise ModError(f"It didn't answer {method} within {timeout:g} s.")
        finally:
            with self._lock:
                self._pending.pop(ident, None)
        if waiting["error"] is not None:
            raise ModError(str(waiting["error"])[:500])
        return waiting["result"]

    def _read(self) -> None:
        proc = self._proc
        stream = proc.stdout if proc else None
        try:
            while stream is not None:
                line = stream.readline(MAX_LINE + 1)
                if not line:
                    break
                if len(line) > MAX_LINE:
                    self._fail("It wrote a line longer than 1 MB.")
                    break
                try:
                    message = json.loads(line)
                except ValueError:
                    self._fail("It wrote something that isn't JSON on its output (print to stderr instead).")
                    break
                if not isinstance(message, dict):
                    continue
                ident = message.get("id")
                if ident is not None and (isinstance(ident, bool) or not isinstance(ident, (str, int))):
                    self._fail("It sent an invalid JSON-RPC id.")
                    break
                if "method" in message:
                    if not self._request_slots.acquire(blocking=False):
                        self._fail("It sent too many requests before earlier ones finished.")
                        break
                    try:
                        self._pool.submit(self._answer_limited, message)
                    except RuntimeError:
                        self._request_slots.release()
                        break
                elif "id" in message:
                    with self._lock:
                        waiting = self._pending.get(message.get("id"))
                    if waiting is not None:
                        if "error" in message:
                            err = message["error"]
                            waiting["error"] = err.get("message") if isinstance(err, dict) else str(err)
                        else:
                            waiting["result"] = message.get("result")
                        waiting["done"].set()
        except (OSError, ValueError):
            pass
        code = proc.poll() if proc else None
        if code is None and proc is not None:
            try:
                code = proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                code = None
        tail = " ".join(list(self.stderr)[-3:]).strip()
        if self.state == "crashed":
            self._finish("crashed", self.error)
        elif code not in (0, None):
            self._fail(f"It stopped (exit {code})" + (f": {tail[-300:]}" if tail else "."))
            self._finish("crashed", self.error)
        else:
            self._finish("stopped", "")

    def _read_err(self) -> None:
        proc = self._proc
        stream = proc.stderr if proc else None
        try:
            for raw in iter(lambda: stream.readline(4096), b""):
                self.stderr.append(raw.decode("utf-8", "replace").rstrip()[:500])
        except (OSError, ValueError, AttributeError):
            pass

    def _answer(self, message: dict) -> None:
        method, params, ident = message.get("method"), message.get("params") or {}, message.get("id")
        try:
            result = self.on_request(str(method), params if isinstance(params, dict) else {})
            reply = {"jsonrpc": "2.0", "id": ident, "result": result}
        except ModError as error:
            reply = {"jsonrpc": "2.0", "id": ident, "error": {"code": -32000, "message": str(error)[:500]}}
        except Exception as error:                            # noqa: BLE001 -- the mod hears it failed; DGC goes on
            reply = {"jsonrpc": "2.0", "id": ident, "error": {"code": -32603,
                                                              "message": f"{type(error).__name__}: {error}"[:500]}}
        if ident is None:
            return
        try:
            self._send(reply)
        except ModError:
            pass

    def _answer_limited(self, message: dict) -> None:
        try:
            if self.state == "running":
                self._answer(message)
        finally:
            self._request_slots.release()

    @property
    def log(self) -> str:
        return "\n".join(self.stderr)
