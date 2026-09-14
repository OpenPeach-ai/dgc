"""Watch one model HTTP request for silence that is not an error.

A model request can hang without failing: the server accepts the connection and never answers,
opens a stream and goes quiet, or sends keep-alive frames that carry no tokens. The only bound
used to be one socket read timeout, which every keep-alive byte resets and which Esc could not
interrupt before response headers arrived.

One :class:`RequestWatch` covers one HTTP attempt. It moves through phases

    headers      request sent, no response yet
    loading      an Ollama endpoint reports the model is not loaded yet (pauses the clock)
    first_token  headers arrived, nothing useful streamed yet
    streaming    real work was seen; silence is now measured from the last progress

and, on a watcher thread, applies the deadlines: cancellation always wins, a first-token window
covers everything before the first real delta, an idle window covers silence mid-stream. A stall
shuts the socket down (before headers it is reached through a thread-local hook on urllib3's
``_make_request``) and records a :class:`StallInfo` the client turns into a retry, a precise error,
or a continuation.

Consumers call :meth:`RequestWatch.progress` only for real work (text, reasoning, tool-call
deltas, a finish) and :meth:`RequestWatch.noise` for bytes that are not tokens; noise never resets
a timer. Wait notices go through a :class:`WaitChannel` that the client closes before ``chat()``
returns, so no notice can arrive after the call that caused it.
"""
from __future__ import annotations

import ipaddress
import math
import socket
import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from urllib.parse import urlsplit

_local = threading.local()
_hook_lock = threading.Lock()
_hook_installed = False

_LOCAL_FAMILIES = frozenset(("ollama", "llamacpp", "lmstudio", "vllm"))
_LOCAL_SUFFIXES = (".local", ".localhost", ".lan", ".home.arpa", ".internal", ".ts.net")
_CGNAT = ipaddress.ip_network("100.64.0.0/10")

AUTO_FIRST_TOKEN_LOCAL_S = 900.0
AUTO_FIRST_TOKEN_REMOTE_S = 300.0
LOAD_NOTICE_S = 3.0
MAX_WINDOW_S = 86_400.0


@dataclass(frozen=True)
class StallInfo:
    """What a stalled attempt looked like when the watcher gave up on it."""
    phase: str                  # headers | loading | first_token | streaming
    silent_s: float             # how long nothing useful arrived
    headers_seen: bool
    noise_frames: int           # keep-alives / lifecycle frames that carried no tokens
    progressed: bool            # real work streamed before the silence
    window_s: float = 0.0       # the deadline that expired
    model: str = ""
    endpoint: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class WaitEvent:
    """A transient fact about a model request for the front end: waiting, retrying, or resumed."""
    kind: str                   # notice | retry | cleared
    phase: str = ""
    since: float = 0.0          # time.monotonic() when the silence began
    silent_s: float = 0.0
    threshold_s: float = 0.0    # the notice threshold, so wording can say "45s+"
    noise_frames: int = 0
    model: str = ""
    endpoint: str = ""
    attempt: int = 0            # retry: which retry this is (1-based)
    retries: int = 0            # retry: how many retries are allowed


class WaitChannel:
    """Delivers :class:`WaitEvent` s for one ``chat()`` call, and nothing after it closes.

    Every delivery runs under one lock and inside ``route(fn)`` -- a runner the caller captured on
    its own thread -- so a TUI fleet session's notice lands on that session, not the one on screen.
    """

    def __init__(self, listener=None, route=None):
        self._listener = listener if callable(listener) else None
        self._route = route if callable(route) else None
        self._lock = threading.Lock()
        self._closed = False
        self.shown = False          # a notice/retry is on screen and no progress has cleared it

    @property
    def active(self) -> bool:
        return self._listener is not None

    def emit(self, event: WaitEvent, guard=None) -> bool:
        if self._listener is None:
            return False
        with self._lock:
            if self._closed or (guard is not None and not guard()):
                return False
            if event.kind == "cleared":
                if not self.shown:
                    return False
                self.shown = False
            else:
                self.shown = True
            listener = self._listener

            def deliver():
                return listener(event)

            try:
                if self._route is not None:
                    self._route(deliver)
                else:
                    deliver()
            except Exception:
                pass                # a front-end failure must never break the model request
            return True

    def barrier(self) -> None:
        """Wait for any delivery in progress to finish."""
        with self._lock:
            pass

    def close(self) -> None:
        with self._lock:
            self._closed = True


def _number(value, default: float) -> float:
    if isinstance(value, bool):
        return default
    try:
        parsed = float(str(value).strip()) if isinstance(value, str) else float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    if not math.isfinite(parsed):
        return default
    return min(max(0.0, parsed), MAX_WINDOW_S)


def bounded_seconds(value, default: float) -> float:
    """A non-negative, finite, capped number of seconds; anything unparseable is the default."""
    return _number(value, default)


def bounded_retries(value, default: int = 2) -> int:
    if isinstance(value, bool):
        return default
    try:
        parsed = int(float(str(value).strip())) if isinstance(value, str) else int(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return min(max(0, parsed), 10)


def is_local_endpoint(base_url: str, family: str = "") -> bool:
    """Loopback, private, link-local, CGNAT/Tailscale, *.local-style hosts, or a local server family."""
    try:
        host = (urlsplit(str(base_url or "")).hostname or "").strip().lower().rstrip(".")
    except ValueError:
        host = ""
    if host:
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None:
            return bool(address.is_loopback or address.is_private or address.is_link_local
                        or (address.version == 4 and address in _CGNAT))
        if host == "localhost" or host.endswith(_LOCAL_SUFFIXES) or "." not in host:
            return True
        if is_hosted_ollama(base_url):
            return False            # Ollama's cloud shares the family, not the hardware
    return str(family or "").lower() in _LOCAL_FAMILIES


def is_hosted_ollama(base_url: str) -> bool:
    """Ollama's own cloud service (ollama.com), as opposed to an Ollama someone runs themselves."""
    try:
        host = (urlsplit(str(base_url or "")).hostname or "").strip().lower().rstrip(".")
    except ValueError:
        return False
    return host == "ollama.com" or host.endswith(".ollama.com")


def resolve_first_token_timeout(value, base_url: str, family: str = "") -> float:
    """``"auto"`` is 900 s for a local endpoint (model load plus a large prefill), 300 s otherwise."""
    if value is None or str(value).strip().lower() in ("", "auto", "default"):
        return (AUTO_FIRST_TOKEN_LOCAL_S if is_local_endpoint(base_url, family)
                else AUTO_FIRST_TOKEN_REMOTE_S)
    return _number(value, AUTO_FIRST_TOKEN_REMOTE_S)


def safe_endpoint(url: str) -> str:
    """scheme://host:port/path with no credentials, query or fragment."""
    try:
        parts = urlsplit(str(url or ""))
        host = parts.hostname or ""
        port = parts.port
    except ValueError:
        return ""
    if ":" in host:
        host = f"[{host}]"
    scheme = parts.scheme or "http"
    return f"{scheme}://{host}{f':{port}' if port else ''}{parts.path}"


def endpoint_host(url: str) -> str:
    """host:port for a short label."""
    try:
        parts = urlsplit(str(url or ""))
        host = parts.hostname or ""
        port = parts.port
    except ValueError:
        return ""
    if ":" in host:
        host = f"[{host}]"
    return f"{host}:{port}" if port else host


def format_seconds(value: float) -> str:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return "0s"
    if not math.isfinite(seconds) or seconds < 0:
        seconds = 0.0
    if seconds < 10 and abs(seconds - round(seconds)) > 0.05:
        return f"{seconds:.1f}s"
    return f"{int(round(seconds))}s"


def ollama_model_listed(payload, model: str) -> bool | None:
    """Does an ``/api/ps`` body list ``model``? None when the body is not that shape."""
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        return None
    wanted = str(model or "").strip()
    if not wanted:
        return None

    def normal(name: str) -> str:
        name = str(name or "").strip()
        return name[:-len(":latest")] if name.endswith(":latest") else name

    target = normal(wanted)
    for entry in payload["models"][:256]:
        if not isinstance(entry, dict):
            continue
        for key in ("name", "model"):
            if normal(entry.get(key)) == target:
                return True
    return False


def _shutdown_socket(sock) -> None:
    if sock is None or not hasattr(sock, "shutdown"):
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except Exception:
        pass


def _response_socket(response):
    raw = getattr(response, "raw", None)
    for path in (("_connection", "sock"), ("_fp", "fp", "raw", "_sock"), ("_fp", "fp", "_sock")):
        obj = raw
        for attr in path:
            obj = getattr(obj, attr, None)
            if obj is None:
                break
        if obj is not None and hasattr(obj, "shutdown"):
            return obj
    return None


def is_read_timeout(exc: BaseException | None) -> bool:
    """True for a socket read timeout, however requests wrapped it."""
    seen = 0
    while exc is not None and seen < 8:
        seen += 1
        name = type(exc).__name__
        if name in ("ReadTimeout", "ReadTimeoutError"):
            return True
        if isinstance(exc, (TimeoutError, socket.timeout)):
            return True
        inner = exc.args[0] if getattr(exc, "args", None) else None
        if isinstance(inner, BaseException):
            exc = inner
            continue
        exc = exc.__cause__ or exc.__context__
    return False


def install_urllib3_hook() -> bool:
    """Wrap ``HTTPConnectionPool._make_request`` once so a registered watch can reach the socket
    before response headers arrive. Inert on every thread with no registered watch."""
    global _hook_installed
    if _hook_installed:
        return True
    with _hook_lock:
        if _hook_installed:
            return True
        try:
            from urllib3 import connectionpool
            pool = connectionpool.HTTPConnectionPool
            original = pool._make_request
        except Exception:
            return False
        if getattr(original, "_dgc_request_watch", False):
            _hook_installed = True
            return True

        def _make_request(self, conn, *args, **kwargs):
            watch = getattr(_local, "watch", None)
            if watch is not None:
                try:
                    watch._bind_connection(conn)
                except Exception:
                    pass
            return original(self, conn, *args, **kwargs)

        _make_request._dgc_request_watch = True     # type: ignore[attr-defined]
        _make_request.__wrapped__ = original        # type: ignore[attr-defined]
        pool._make_request = _make_request
        _hook_installed = True
        return True


class RequestWatch:
    """Cancel, first-token and idle deadlines for one HTTP attempt (see the module docstring)."""

    def __init__(self, cancel=None, *, first_token_s: float = 0.0, idle_s: float = 0.0,
                 notice_s: float = 0.0, load_probe=None, load_timeout_s: float = 0.0,
                 load_poll_s: float = 5.0, channel: WaitChannel | None = None,
                 headers_deadline: bool = True, model: str = "", endpoint: str = "",
                 poll_s: float = 0.15, clock=time.monotonic):
        self.cancel = cancel
        self.first_token_s = _number(first_token_s, 0.0)
        self.idle_s = _number(idle_s, 0.0)
        self.notice_s = _number(notice_s, 0.0)
        self.load_timeout_s = _number(load_timeout_s, 0.0)
        self.load_poll_s = max(0.01, _number(load_poll_s, 5.0))
        self.headers_deadline = bool(headers_deadline)
        self.channel = channel
        self.model = str(model or "")
        self.endpoint = str(endpoint or "")
        self.poll_s = max(0.01, float(poll_s))
        self._clock = clock
        self._load_probe = load_probe if callable(load_probe) else None

        self.t_start = clock()
        self.last_progress: float | None = None
        self.headers_seen = False
        self.progressed = False
        self.noise_frames = 0
        self.stall: StallInfo | None = None
        self.aborted = ""               # "", "cancelled" or "stalled"
        self._state_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._conn = None
        self._response = None
        self._loading: bool | None = None
        self._load_t0: float | None = None
        self._paused_s = 0.0
        self._noticed: str | None = None    # phase of the notice outstanding in this silence

    # ---- lifecycle ----------------------------------------------------------------------------
    def start(self) -> "RequestWatch":
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="dgc-request-watch", daemon=True)
            self._thread.start()
            if self._load_probe is not None:
                threading.Thread(target=self._probe_loop, name="dgc-load-probe",
                                 daemon=True).start()
        return self

    def stop(self) -> None:
        """End this attempt's watch. Any notice already being delivered finishes first."""
        self._stop.set()
        if self.channel is not None:
            self.channel.barrier()

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()

    def disarm(self) -> None:
        """Keep honouring cancellation but apply no stall deadlines (an error body is being read)."""
        self.first_token_s = 0.0
        self.idle_s = 0.0
        self.notice_s = 0.0
        self.load_timeout_s = 0.0

    @contextmanager
    def registered(self):
        """Let the urllib3 hook hand this watch the connection a request on this thread uses."""
        install_urllib3_hook()
        previous = getattr(_local, "watch", None)
        _local.watch = self
        try:
            yield self
        finally:
            _local.watch = previous

    def _bind_connection(self, conn) -> None:
        self._conn = conn
        if self.aborted:
            _shutdown_socket(getattr(conn, "sock", None))

    def attach_response(self, response) -> None:
        self._response = response
        self.headers_seen = True
        if self.aborted:
            self._shutdown()

    # ---- consumer signals ---------------------------------------------------------------------
    def progress(self) -> None:
        """Real work arrived: text, reasoning, a tool-call delta, or a finish."""
        self.last_progress = self._clock()
        self.progressed = True
        self._noticed = None
        channel = self.channel
        if channel is not None and channel.shown and not self._stop.is_set():
            channel.emit(self._event("cleared"))

    def noise(self) -> None:
        """Bytes that are not tokens (keep-alives, lifecycle frames). Never resets a timer."""
        self.noise_frames += 1

    def observe_error(self, exc: BaseException | None) -> None:
        """A socket read timeout that fired before the watcher did is still a stall."""
        if self.stall is None and not self.aborted and is_read_timeout(exc):
            now = self._clock()
            phase = self.phase
            silent = now - (self.last_progress if self.progressed else self.t_start)
            with self._state_lock:
                if self.stall is None and not self.aborted:
                    self.stall = self._stall_info(phase, silent, 0.0)

    def stall_from_timeout(self) -> StallInfo:
        """The stall a raised socket timeout represents when the watcher had not fired yet."""
        if self.stall is None:
            self.observe_error(TimeoutError("read timed out"))
        if self.stall is None:      # aborted for another reason; still describe the silence
            now = self._clock()
            return self._stall_info(self.phase, now - self.t_start, 0.0)
        return self.stall

    # ---- state --------------------------------------------------------------------------------
    @property
    def phase(self) -> str:
        if self.progressed:
            return "streaming"
        if self._loading is True:
            return "loading"
        return "first_token" if self.headers_seen else "headers"

    def _stall_info(self, phase: str, silent: float, window: float) -> StallInfo:
        return StallInfo(phase=phase, silent_s=round(max(0.0, silent), 3),
                         headers_seen=self.headers_seen, noise_frames=self.noise_frames,
                         progressed=self.progressed, window_s=window, model=self.model,
                         endpoint=self.endpoint)

    def _event(self, kind: str, *, phase: str = "", since: float = 0.0, silent: float = 0.0,
               threshold: float = 0.0) -> WaitEvent:
        return WaitEvent(kind=kind, phase=phase or self.phase, since=since, silent_s=silent,
                         threshold_s=threshold, noise_frames=self.noise_frames,
                         model=self.model, endpoint=self.endpoint)

    def _cancel_set(self) -> bool:
        try:
            return bool(self.cancel is not None and self.cancel.is_set())
        except Exception:
            return False

    # ---- the watcher thread -------------------------------------------------------------------
    def _run(self) -> None:
        while not self._stop.wait(self.poll_s):
            try:
                self._tick()
            except Exception:
                pass

    def _tick(self) -> None:
        if self.aborted:
            self._shutdown()        # a socket that appeared after the abort (still connecting)
            return
        if getattr(self._response, "_dgc_closed", False):
            return
        now = self._clock()
        if self._cancel_set():
            self._abort("cancelled")
            return
        if self.progressed and self.last_progress is not None:
            silent = now - self.last_progress
            if self.idle_s > 0 and silent >= self.idle_s:
                self._abort("stalled", self._stall_info("streaming", silent, self.idle_s))
                return
            self._maybe_notice("streaming", self.last_progress, silent, self.notice_s)
            return
        if self._loading is True:
            if self._load_t0 is None:
                self._load_t0 = now
            loading_for = now - self._load_t0
            if self.load_timeout_s > 0 and loading_for >= self.load_timeout_s:
                self._abort("stalled", self._stall_info("loading", loading_for,
                                                        self.load_timeout_s))
                return
            threshold = min(self.notice_s, LOAD_NOTICE_S) if self.notice_s > 0 else 0.0
            self._maybe_notice("loading", self.t_start, loading_for, threshold)
            return
        if self._load_t0 is not None:
            self._paused_s += now - self._load_t0
            self._load_t0 = None
        silent = now - self.t_start
        waited = silent - self._paused_s
        phase = "first_token" if self.headers_seen else "headers"
        applies = self.first_token_s > 0 and (self.headers_seen or self.headers_deadline)
        if applies and waited >= self.first_token_s:
            self._abort("stalled", self._stall_info(phase, silent, self.first_token_s))
            return
        self._maybe_notice(phase, self.t_start, silent, self.notice_s)

    def _maybe_notice(self, phase: str, since: float, silent: float, threshold: float) -> None:
        channel = self.channel
        if channel is None or not channel.active or threshold <= 0 or silent < threshold:
            return
        if self._noticed == phase:
            return
        self._noticed = phase
        channel.emit(self._event("notice", phase=phase, since=since, silent=silent,
                                 threshold=threshold),
                     guard=lambda: not self._stop.is_set() and not self.aborted)

    def _abort(self, reason: str, info: StallInfo | None = None) -> None:
        with self._state_lock:
            if self.aborted or self._stop.is_set():
                return
            self.aborted = reason
            if info is not None:
                self.stall = info
        self._shutdown()

    def _shutdown(self) -> None:
        _shutdown_socket(getattr(self._conn, "sock", None))
        response = self._response
        if response is None:
            return
        _shutdown_socket(_response_socket(response))
        try:
            setattr(response, "_dgc_closed", True)
        except Exception:
            pass
        try:
            response.close()
        except Exception:
            pass

    def _probe_loop(self) -> None:
        probe = self._load_probe
        while not self._stop.is_set() and not self.progressed and not self.aborted:
            try:
                listed = probe()
            except Exception:
                listed = None
            if self._stop.is_set():
                return
            if listed is None or listed is True:
                self._loading = False if listed else None
                return
            self._loading = True
            if self._stop.wait(self.load_poll_s):
                return
        self._loading = None
