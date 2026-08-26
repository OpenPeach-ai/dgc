"""Safe synchronous client for DGC's protocol-v3 ``serve`` backend.

The client owns one child process and is intentionally one-shot.  It validates both sides of the
NDJSON contract, preserves unrelated events while waiting for correlated replies, bounds every
buffer, and reaps the child plus its POSIX process group on failure or shutdown.
"""
from __future__ import annotations

import copy
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from .editor_protocol import (
    MAX_COMMAND_BYTES,
    MAX_EVENT_BYTES,
    MAX_PENDING_BYTES,
    PROTOCOL_VERSION,
    command_error,
    event_error,
)
from .protocol import strict_json_loads

__all__ = [
    "DGCClient",
    "DGCClientError",
    "DGCCommandError",
    "DGCEventTimeout",
    "DGCProcessError",
    "DGCProtocolError",
    "DGCStartError",
]


class DGCClientError(RuntimeError):
    """Base error for the synchronous DGC client."""


class DGCStartError(DGCClientError):
    """The backend could not be launched or did not become ready in time."""


class DGCProtocolError(DGCClientError):
    """The backend violated the installed protocol contract."""


class DGCProcessError(DGCClientError):
    """The backend transport closed or stalled unexpectedly."""


class DGCCommandError(DGCClientError, ValueError):
    """An outbound command is invalid or unsafe to serialize."""


class DGCEventTimeout(DGCClientError, TimeoutError):
    """No matching event arrived within the requested timeout."""


_REQUEST_RESPONSES = {
    "permission_request": "permission_response",
    "plan_proposal": "plan_response",
    "options_request": "options_response",
    "mcp_input_request": "mcp_input_response",
}
_RESPONSE_COMMANDS = frozenset(_REQUEST_RESPONSES.values())
_DEFAULT_PENDING_EVENTS = 4096
_MAX_PENDING_EVENTS = 65536
_DEFAULT_STDERR_BYTES = 64 * 1024
_MAX_STDERR_BYTES = 1024 * 1024
_MAX_ARGV = 128
_MAX_ARG_BYTES = 128 * 1024
_MAX_TIMEOUT_S = 3600.0


def _timeout(value: float, name: str, *, allow_zero: bool = False) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    lower_ok = number >= 0 if allow_zero else number > 0
    if not lower_ok or not math.isfinite(number) or number > _MAX_TIMEOUT_S:
        relation = "non-negative" if allow_zero else "positive"
        raise ValueError(
            f"{name} must be a finite {relation} number no greater than {_MAX_TIMEOUT_S:g}")
    return number


def _positive_int(value: int, name: str, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= maximum:
        raise ValueError(f"{name} must be an integer from 1 to {maximum}")
    return value


def _safe_protocol_problem(problem: str) -> str:
    """Keep schema diagnostics useful without reflecting hostile wire values."""
    if problem.startswith("unknown message type"):
        return "unknown message type"
    if " has undeclared field " in problem:
        return problem.split(" has undeclared field ", 1)[0] + " has an undeclared field"
    return problem[:256]


class DGCClient:
    """Own and communicate with one ``dgc serve`` process.

    ``command`` is a complete argv sequence and is never interpreted by a shell.  By default the
    currently running Python launches the installed ``dgc`` module.  Call :meth:`start` explicitly
    or use the client as a context manager.
    """

    def __init__(
        self,
        command: Sequence[str] | None = None,
        *,
        cwd: str | os.PathLike[str] = ".",
        env: Mapping[str, str] | None = None,
        start_timeout: float = 10.0,
        event_timeout: float = 30.0,
        write_timeout: float = 5.0,
        shutdown_timeout: float = 5.0,
        max_pending_events: int = _DEFAULT_PENDING_EVENTS,
        max_pending_bytes: int = MAX_PENDING_BYTES,
        stderr_bytes: int = _DEFAULT_STDERR_BYTES,
    ):
        argv = [sys.executable, "-m", "dgc", "serve"] if command is None else command
        if isinstance(argv, (str, bytes)) or not isinstance(argv, Sequence):
            raise ValueError("command must be a complete argv sequence, not a shell string")
        self._argv = tuple(argv)
        if (not self._argv or len(self._argv) > _MAX_ARGV
                or any(not isinstance(arg, str) or not arg or "\0" in arg for arg in self._argv)):
            raise ValueError(f"command must contain 1 to {_MAX_ARGV} non-empty string arguments")
        try:
            argv_bytes = sum(len(arg.encode("utf-8")) for arg in self._argv)
        except UnicodeEncodeError as exc:
            raise ValueError("command argv must be valid Unicode") from exc
        if argv_bytes > _MAX_ARG_BYTES:
            raise ValueError("command argv is too large")

        root = Path(cwd).expanduser().resolve()
        if not root.is_dir():
            raise ValueError("cwd must resolve to an existing directory")
        self._cwd = root
        if env is not None:
            if (not isinstance(env, Mapping)
                    or any(not isinstance(key, str) or not isinstance(value, str)
                           or "\0" in key or "\0" in value for key, value in env.items())):
                raise ValueError("env must map strings to strings")
            self._env = dict(env)
        else:
            self._env = None

        self._start_timeout = _timeout(start_timeout, "start_timeout")
        self._event_timeout = _timeout(event_timeout, "event_timeout")
        self._write_timeout = _timeout(write_timeout, "write_timeout")
        self._shutdown_timeout = _timeout(shutdown_timeout, "shutdown_timeout", allow_zero=True)
        self._max_pending_events = _positive_int(
            max_pending_events, "max_pending_events", _MAX_PENDING_EVENTS)
        self._max_pending_bytes = _positive_int(
            max_pending_bytes, "max_pending_bytes", MAX_PENDING_BYTES)
        self._stderr_limit = _positive_int(stderr_bytes, "stderr_bytes", _MAX_STDERR_BYTES)

        self._condition = threading.Condition()
        self._write_lock = threading.Lock()
        self._events: deque[tuple[dict[str, Any], int]] = deque()
        self._pending_bytes = 0
        self._stderr = bytearray()
        self._active_requests: dict[str, str] = {}
        self._responded_requests: set[str] = set()
        self._proc: subprocess.Popen[bytes] | None = None
        self._threads: list[threading.Thread] = []
        self._ready: dict[str, Any] | None = None
        self._last_seq = -1
        self._failure: DGCClientError | None = None
        self._started = False
        self._closing = False
        self._closed = False

    def __enter__(self) -> DGCClient:
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    @property
    def ready(self) -> dict[str, Any] | None:
        """A defensive copy of the accepted handshake event, or ``None`` before startup."""
        with self._condition:
            return copy.deepcopy(self._ready)

    @property
    def pid(self) -> int | None:
        with self._condition:
            return self._proc.pid if self._proc is not None else None

    @property
    def returncode(self) -> int | None:
        with self._condition:
            return self._proc.poll() if self._proc is not None else None

    @property
    def stderr_tail(self) -> str:
        """A bounded diagnostic tail. It is never printed automatically."""
        with self._condition:
            return bytes(self._stderr).decode("utf-8", errors="replace")

    @property
    def protocol_error(self) -> DGCProtocolError | None:
        with self._condition:
            return self._failure if isinstance(self._failure, DGCProtocolError) else None

    @property
    def closed(self) -> bool:
        with self._condition:
            return self._closed

    def start(self) -> dict[str, Any]:
        """Launch the backend and wait for a valid protocol-v3 ``ready`` handshake."""
        with self._condition:
            if self._closed:
                raise DGCStartError("this one-shot client has already been closed")
            if self._started:
                if self._ready is not None:
                    return copy.deepcopy(self._ready)
                raise DGCStartError("backend startup is already in progress")
            self._started = True

        kwargs: dict[str, Any] = {
            "cwd": str(self._cwd),
            "env": self._env,
            "stdin": subprocess.PIPE,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "bufsize": 0,
        }
        if os.name == "posix":
            kwargs["start_new_session"] = True
        elif hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        try:
            proc = subprocess.Popen(self._argv, **kwargs)
        except (OSError, ValueError) as exc:
            error = DGCStartError("could not launch the DGC backend")
            with self._condition:
                self._failure = error
                self._closed = True
                self._condition.notify_all()
            raise error from exc

        with self._condition:
            self._proc = proc
        self._threads = [
            threading.Thread(target=self._read_stdout, name="dgc-client-stdout", daemon=True),
            threading.Thread(target=self._read_stderr, name="dgc-client-stderr", daemon=True),
            threading.Thread(target=self._wait_process, name="dgc-client-wait", daemon=True),
        ]
        for thread in self._threads:
            thread.start()

        deadline = time.monotonic() + self._start_timeout
        with self._condition:
            while self._ready is None and self._failure is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._failure = DGCStartError("timed out waiting for the DGC ready handshake")
                    self._condition.notify_all()
                    break
                self._condition.wait(remaining)
            ready = copy.deepcopy(self._ready)
            failure = self._failure
        if failure is not None or ready is None:
            self._force_reap()
            raise failure or DGCStartError("the DGC backend did not become ready")
        return ready

    def send(self, command: Mapping[str, Any]) -> None:
        """Validate and send one command, enforcing correlated decision lifecycles."""
        wire, frame = self._serialize_command(command)
        command_type = wire["type"]
        request_id = wire.get("id") if isinstance(wire.get("id"), str) else None

        with self._condition:
            self._require_live_locked()
            if command_type in _RESPONSE_COMMANDS:
                expected = self._active_requests.get(request_id or "")
                if expected != command_type or request_id in self._responded_requests:
                    raise DGCCommandError(
                        "stale, duplicate, or mismatched approval response")
                self._responded_requests.add(request_id)
            elif command_type in ("cancel", "interrupt"):
                self._active_requests.clear()
                self._responded_requests.clear()

        try:
            self._write_frame(frame)
        except DGCClientError:
            self._force_reap()
            raise

    def next_event(self, timeout: float | None = None) -> dict[str, Any]:
        """Return and remove the oldest retained event."""
        wait = self._event_timeout if timeout is None else _timeout(timeout, "timeout")
        deadline = time.monotonic() + wait
        with self._condition:
            while True:
                if self._events:
                    event, size = self._events.popleft()
                    self._pending_bytes -= size
                    return copy.deepcopy(event)
                if self._failure is not None:
                    raise self._failure
                if self._closed:
                    raise DGCProcessError("the DGC client is closed")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DGCEventTimeout("timed out waiting for the next DGC event")
                self._condition.wait(remaining)

    def wait_for(
        self,
        event_type: str | None = None,
        *,
        request_id: str | None = None,
        predicate: Callable[[Mapping[str, Any]], bool] | None = None,
        timeout: float | None = None,
        after_seq: int = -1,
    ) -> dict[str, Any]:
        """Remove the first matching event while retaining every unrelated event in order."""
        if event_type is not None and (not isinstance(event_type, str) or not event_type):
            raise ValueError("event_type must be a non-empty string or None")
        if request_id is not None and not isinstance(request_id, str):
            raise ValueError("request_id must be a string or None")
        if predicate is not None and not callable(predicate):
            raise ValueError("predicate must be callable or None")
        if not isinstance(after_seq, int) or isinstance(after_seq, bool) or after_seq < -1:
            raise ValueError("after_seq must be an integer of at least -1")
        wait = self._event_timeout if timeout is None else _timeout(timeout, "timeout")
        deadline = time.monotonic() + wait
        with self._condition:
            while True:
                for index, (event, size) in enumerate(self._events):
                    if event["seq"] <= after_seq:
                        continue
                    if event_type is not None and event["type"] != event_type:
                        continue
                    if request_id is not None and event.get("request_id") != request_id:
                        continue
                    if predicate is not None and not predicate(copy.deepcopy(event)):
                        continue
                    del self._events[index]
                    self._pending_bytes -= size
                    return copy.deepcopy(event)
                if self._failure is not None:
                    raise self._failure
                if self._closed:
                    raise DGCProcessError("the DGC client is closed")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    label = event_type or "matching"
                    raise DGCEventTimeout(f"timed out waiting for {label} DGC event")
                self._condition.wait(remaining)

    def request(
        self,
        command: Mapping[str, Any],
        response_type: str,
        *,
        request_id: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Send a command and wait for its new response without consuming unrelated events."""
        if not isinstance(command, Mapping):
            raise DGCCommandError("command must be an object")
        inferred = command.get("request_id")
        if request_id is None and isinstance(inferred, str):
            request_id = inferred
        with self._condition:
            self._require_live_locked()
            barrier = self._last_seq
        self.send(command)
        return self.wait_for(
            response_type, request_id=request_id, timeout=timeout, after_seq=barrier)

    def close(self) -> None:
        """Request graceful shutdown, then terminate and reap the owned process if needed."""
        with self._condition:
            if self._closed:
                return
            self._closing = True
            proc = self._proc
            healthy = proc is not None and proc.poll() is None and self._ready is not None

        if healthy:
            try:
                _wire, shutdown = self._serialize_command({"type": "shutdown"})
                self._write_frame(shutdown, allow_closing=True)
            except DGCClientError:
                pass
        if proc is not None:
            try:
                proc.wait(timeout=self._shutdown_timeout)
            except subprocess.TimeoutExpired:
                self._signal_process(force=False)
                try:
                    proc.wait(timeout=min(1.0, max(0.1, self._shutdown_timeout)))
                except subprocess.TimeoutExpired:
                    self._signal_process(force=True)
                    try:
                        proc.wait(timeout=1.0)
                    except subprocess.TimeoutExpired:
                        pass
            # A clean direct-child exit can still leave a descendant holding inherited pipes.
            # Sweep only the process group created exclusively for this client.
            if os.name == "posix":
                self._signal_process(force=True)
        self._close_pipes()
        for thread in self._threads:
            if thread is not threading.current_thread():
                thread.join(timeout=1.0)
        with self._condition:
            self._closed = True
            self._condition.notify_all()

    def _serialize_command(self, command: Mapping[str, Any]) -> tuple[dict[str, Any], bytes]:
        if not isinstance(command, Mapping):
            raise DGCCommandError("command must be an object")
        try:
            encoded = json.dumps(
                dict(command), ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            wire = strict_json_loads(encoded)
        except (RecursionError, TypeError, ValueError) as exc:
            raise DGCCommandError("command is not finite JSON data") from exc
        problem = command_error(wire)
        if problem:
            raise DGCCommandError(f"command violated protocol v{PROTOCOL_VERSION}: {problem}")
        try:
            frame = encoded.encode("utf-8") + b"\n"
        except UnicodeEncodeError as exc:
            raise DGCCommandError("command is not valid Unicode JSON data") from exc
        if len(frame) > MAX_COMMAND_BYTES:
            raise DGCCommandError(f"command exceeded {MAX_COMMAND_BYTES} bytes")
        return wire, frame

    def _require_live_locked(self) -> None:
        if not self._started or self._ready is None:
            raise DGCStartError("the DGC client has not completed its ready handshake")
        if self._closing or self._closed:
            raise DGCProcessError("the DGC client is closing or closed")
        if self._failure is not None:
            raise self._failure
        if self._proc is None or self._proc.poll() is not None:
            raise DGCProcessError("the DGC backend is not running")

    def _write_frame(self, frame: bytes, *, allow_closing: bool = False) -> None:
        with self._write_lock:
            with self._condition:
                proc = self._proc
                if (proc is None or proc.poll() is not None or proc.stdin is None
                        or (self._closing and not allow_closing)):
                    raise DGCProcessError("the DGC backend command stream is unavailable")
            done = threading.Event()
            result: list[BaseException] = []

            def write() -> None:
                try:
                    assert proc.stdin is not None
                    remaining = memoryview(frame)
                    while remaining:
                        written = proc.stdin.write(remaining)
                        if not written:
                            raise BrokenPipeError(
                                "the backend command stream stopped accepting data")
                        remaining = remaining[written:]
                    proc.stdin.flush()
                except BaseException as exc:  # transported back to the owning thread
                    result.append(exc)
                finally:
                    done.set()

            writer = threading.Thread(target=write, name="dgc-client-write", daemon=True)
            writer.start()
            if not done.wait(self._write_timeout):
                error = DGCProcessError("timed out writing a DGC command frame")
                self._record_failure(error)
                self._signal_process(force=True)
                raise error
            if result:
                error = DGCProcessError("the DGC backend command stream failed")
                self._record_failure(error)
                self._signal_process(force=True)
                raise error from result[0]

    def _read_stdout(self) -> None:
        with self._condition:
            proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            pending = bytearray()
            while True:
                chunk = proc.stdout.read(64 * 1024)
                if not chunk:
                    if pending:
                        raise DGCProtocolError("backend emitted an unterminated NDJSON frame")
                    break
                pending.extend(chunk)
                while True:
                    newline = pending.find(b"\n")
                    if newline < 0:
                        if len(pending) > MAX_EVENT_BYTES:
                            raise DGCProtocolError(
                                f"backend event frame exceeded {MAX_EVENT_BYTES} bytes")
                        break
                    payload = bytes(pending[:newline])
                    del pending[:newline + 1]
                    self._decode_event(payload)
        except DGCClientError as exc:
            self._record_failure(exc)
            self._signal_process(force=True)
        except (OSError, ValueError):
            with self._condition:
                expected = self._closing
            if not expected:
                error = DGCProcessError("the DGC backend event stream failed")
                self._record_failure(error)
                self._signal_process(force=True)
        finally:
            with self._condition:
                expected = self._closing or self._failure is not None
            if not expected:
                self._record_failure(DGCProcessError("the DGC backend event stream closed"))
                self._signal_process(force=True)

    def _decode_event(self, payload: bytes) -> None:
        wire_size = len(payload) + 1
        if len(payload) > MAX_EVENT_BYTES:
            raise DGCProtocolError(
                f"backend event frame exceeded {MAX_EVENT_BYTES} bytes")
        if payload.endswith(b"\r"):
            payload = payload[:-1]
        try:
            text = payload.decode("utf-8", errors="strict").strip()
        except UnicodeDecodeError as exc:
            raise DGCProtocolError("backend emitted non-UTF-8 NDJSON") from exc
        if not text:
            return
        try:
            event = strict_json_loads(text)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise DGCProtocolError("backend emitted malformed NDJSON") from exc
        problem = event_error(event)
        if problem:
            safe = _safe_protocol_problem(problem)
            raise DGCProtocolError(
                f"backend violated protocol v{PROTOCOL_VERSION}: {safe}")
        self._accept_event(event, wire_size)

    def _accept_event(self, event: dict[str, Any], size: int) -> None:
        with self._condition:
            seq = event["seq"]
            if seq <= self._last_seq:
                raise DGCProtocolError(
                    "backend emitted a duplicate or out-of-order event sequence")
            self._last_seq = seq
            event_type = event["type"]
            if self._ready is None and event_type != "ready":
                raise DGCProtocolError("backend emitted an event before the ready handshake")
            if event_type == "ready":
                if self._ready is not None:
                    raise DGCProtocolError("backend emitted more than one ready event")
                if event["protocol_version"] != PROTOCOL_VERSION:
                    raise DGCProtocolError(
                        "backend offered an incompatible protocol; "
                        f"client requires v{PROTOCOL_VERSION}")
                self._ready = copy.deepcopy(event)

            expected = _REQUEST_RESPONSES.get(event_type)
            request_id = event.get("id") if isinstance(event.get("id"), str) else ""
            if expected:
                if not request_id or request_id in self._active_requests:
                    raise DGCProtocolError("backend reused an active approval request ID")
                self._active_requests[request_id] = expected
            elif event_type == "request_expired":
                self._active_requests.pop(request_id, None)
                self._responded_requests.discard(request_id)
            elif event_type == "turn_end":
                self._active_requests.clear()
                self._responded_requests.clear()

            if (len(self._events) >= self._max_pending_events
                    or self._pending_bytes + size > self._max_pending_bytes):
                raise DGCProtocolError("backend event retention limit was exceeded")
            self._events.append((copy.deepcopy(event), size))
            self._pending_bytes += size
            self._condition.notify_all()

    def _read_stderr(self) -> None:
        with self._condition:
            proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            while True:
                chunk = proc.stderr.read(8192)
                if not chunk:
                    return
                with self._condition:
                    self._stderr.extend(chunk)
                    excess = len(self._stderr) - self._stderr_limit
                    if excess > 0:
                        del self._stderr[:excess]
        except (OSError, ValueError):
            return

    def _wait_process(self) -> None:
        with self._condition:
            proc = self._proc
        if proc is None:
            return
        proc.wait()
        with self._condition:
            expected = self._closing or self._failure is not None
        if not expected:
            self._record_failure(DGCProcessError("the DGC backend exited unexpectedly"))
            self._signal_process(force=True)
        with self._condition:
            self._condition.notify_all()

    def _record_failure(self, error: DGCClientError) -> None:
        with self._condition:
            if self._failure is None:
                self._failure = error
            self._condition.notify_all()

    def _signal_process(self, *, force: bool) -> None:
        with self._condition:
            proc = self._proc
        if proc is None:
            return
        try:
            if os.name == "posix":
                os.killpg(proc.pid, signal.SIGKILL if force else signal.SIGTERM)
            elif proc.poll() is not None:
                return
            elif force:
                proc.kill()
            else:
                proc.terminate()
        except (OSError, ProcessLookupError):
            pass

    def _force_reap(self) -> None:
        with self._condition:
            proc = self._proc
            self._closing = True
        if proc is not None:
            self._signal_process(force=True)
        if proc is not None and proc.poll() is None:
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                pass
        self._close_pipes()
        with self._condition:
            self._closed = True
            self._condition.notify_all()

    def _close_pipes(self) -> None:
        with self._condition:
            proc = self._proc
        if proc is None:
            return
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass
