"""Pip computers: a Personal Pip's own sandboxed browser and files (Linux, bubblewrap).

A Pip computer is a folder (``state/computers/<pip_id>/home``) plus a Chromium that runs inside
a bubblewrap box with that folder as its only writable home. The box has no network of its own:
its one way out is a forwarder inside the box that relays to a Unix socket owned by DGC, where
an egress proxy lets the browser reach public web servers and nothing on this computer or the
local network. Chromium is driven over ``--remote-debugging-pipe``, so the box listens on
nothing.

Reading is free. Anything that would change something on a website -- a form submit, a POST,
PUT, PATCH or DELETE from any frame, popup or worker -- is caught inside the browser before it
is sent and HELD: the request waits, unsent, until the user approves it, and approval releases
that exact request rather than a re-typed copy. WebSockets are blocked, because the write gate
cannot see what they carry, and there is no UDP at all, so WebRTC and QUIC cannot leave the box.
A payment is a change like any other: held for the user, its review saying it carries payment card details.

This module is the mechanism only. Who may start a computer, how held requests become reviews
and how runs use it live in ``pip_computer``.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import select
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from .browser import MAX_FRAME_BYTES, BrowserError, BrowserSession, DEFAULT_VIEWPORT

BOX_PROXY_PORT = 8899                 # the in-box forwarder; only the browser inside sees it
MAX_CONNECTIONS = 64
IDLE_SECONDS = 120
READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
MAX_HELD = 8                          # held writes per browser; more are dropped, not queued
MAX_SUMMARY_FIELDS = 24
SECRET_FIELD = re.compile(r"pass|pwd|secret|token|otp|cvv|cvc|pin\b|card|iban|ssn", re.I)

# Inside the box: a TCP listener for Chromium's --proxy-server, relaying each connection to the
# Unix socket DGC bound into the box. Plain stdlib Python; it is the only process besides Chrome.
FORWARDER = r'''
import select, socket, threading
def pump(a, b):
    try:
        while True:
            ready, _, _ = select.select([a, b], [], [], 300)
            if not ready:
                return
            for s in ready:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass
    finally:
        a.close(); b.close()
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", %d))
server.listen(64)
while True:
    client, _ = server.accept()
    upstream = socket.socket(socket.AF_UNIX)
    try:
        upstream.connect("/run/dgc/egress.sock")
    except OSError:
        client.close(); upstream.close(); continue
    threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
''' % BOX_PROXY_PORT

# The exec shim: put the two pipe ends on fds 3 and 4 (Chromium's devtools pipe), then become
# bubblewrap. No preexec_fn in a threaded controller.
_PIPE_EXEC = ("import os,sys; r,w=int(sys.argv[1]),int(sys.argv[2]); os.dup2(r,3); os.dup2(w,4); "
              "os.execvp(sys.argv[3], sys.argv[3:])")

_CHROME_FLAGS = (
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-default-apps",
    "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability",
    "--disable-client-side-phishing-detection", "--metrics-recording-only", "--mute-audio",
    "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    f"--proxy-server=http://127.0.0.1:{BOX_PROXY_PORT}", "--proxy-bypass-list=<-loopback>",
    "--remote-debugging-pipe", "--user-data-dir=/home/pip/.browser",
)


class BoxError(BrowserError):
    """The computer cannot start or was refused; the message is for the user."""


# --------------------------------------------------------------------------- egress policy

def public_addresses(host: str, port: int, *, resolve=socket.getaddrinfo) -> list[str]:
    """The addresses a box may connect to for ``host``: all of them public, or none at all.

    Resolved here, once, and the proxy connects to the address it checked, so a name that
    resolves differently the second time cannot reach a private address.
    """
    name = str(host or "").strip().strip("[]").rstrip(".").lower()
    if not name or name == "localhost" or name.endswith(".localhost") or port not in (80, 443):
        return []
    try:
        infos = resolve(name, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        return []
    addresses = []
    for info in infos:
        raw = str(info[4][0]).split("%", 1)[0]
        try:
            address = ipaddress.ip_address(raw)
        except ValueError:
            return []
        if not address.is_global:
            return []
        if raw not in addresses:
            addresses.append(raw)
    return addresses


class EgressProxy:
    """The only way out of a box: CONNECT to public :443, or plain HTTP to public :80."""

    def __init__(self, path: Path, *, policy=None):
        self.path = Path(path)
        self.policy = policy or public_addresses
        self.log: list[tuple[str, str]] = []           # (outcome, host) -- bounded, no URLs
        self.connections = 0
        self._server: socket.socket | None = None
        self._lock = threading.Lock()
        self._stopped = threading.Event()

    def start(self) -> None:
        if self.path.exists() or self.path.is_symlink():
            self.path.unlink()
        server = socket.socket(socket.AF_UNIX)
        server.bind(str(self.path))
        os.chmod(self.path, 0o600)
        server.listen(MAX_CONNECTIONS)
        self._server = server
        threading.Thread(target=self._serve, name="pip-computer-egress", daemon=True).start()

    def stop(self) -> None:
        self._stopped.set()
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
        try:
            self.path.unlink()
        except OSError:
            pass

    def _note(self, outcome: str, host: str) -> None:
        with self._lock:
            self.log.append((outcome, host[:255]))
            del self.log[:-200]

    def _serve(self) -> None:
        while not self._stopped.is_set():
            try:
                client, _ = self._server.accept()
            except OSError:
                return
            with self._lock:
                busy = self.connections >= MAX_CONNECTIONS
                if not busy:
                    self.connections += 1
            if busy:
                client.close()
                continue
            threading.Thread(target=self._handle, args=(client,), daemon=True).start()

    def _handle(self, client: socket.socket) -> None:
        upstream = None
        try:
            client.settimeout(30)
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = client.recv(8192)
                if not chunk or len(head) > 65536:
                    return
                head += chunk
            line = head.split(b"\r\n", 1)[0].decode("latin-1")
            parts = line.split(" ")
            if len(parts) != 3:
                return self._refuse(client, "?")
            method, target, version = parts
            if method == "CONNECT":
                host, _, port = target.rpartition(":")
                if port != "443":
                    return self._refuse(client, host)
                upstream = self._open(host, 443)
                if upstream is None:
                    return self._refuse(client, host)
                client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                rest = head.split(b"\r\n\r\n", 1)[1]
                if rest:
                    upstream.sendall(rest)
                self._note("tunnel", host)
            else:
                parsed = urlsplit(target)
                if parsed.scheme != "http" or not parsed.hostname:
                    return self._refuse(client, parsed.hostname or "?")
                upstream = self._open(parsed.hostname, parsed.port or 80)
                if upstream is None:
                    return self._refuse(client, parsed.hostname)
                origin_form = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
                upstream.sendall(f"{method} {origin_form} {version}".encode("latin-1")
                                 + b"\r\n" + head.split(b"\r\n", 1)[1])
                self._note("http", parsed.hostname)
            self._pump(client, upstream)
        except OSError:
            pass
        finally:
            for s in (client, upstream):
                if s is not None:
                    try:
                        s.close()
                    except OSError:
                        pass
            with self._lock:
                self.connections -= 1

    def _open(self, host: str, port: int) -> socket.socket | None:
        for address in self.policy(host, port):
            try:
                return socket.create_connection((address, port), timeout=15)
            except OSError:
                continue
        return None

    def _refuse(self, client: socket.socket, host: str) -> None:
        self._note("refused", host)
        try:
            client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        except OSError:
            pass

    @staticmethod
    def _pump(a: socket.socket, b: socket.socket) -> None:
        a.settimeout(None); b.settimeout(None)
        while True:
            ready, _, _ = select.select([a, b], [], [], IDLE_SECONDS)
            if not ready:
                return
            for s in ready:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)


# --------------------------------------------------------------------------- the box

GOOGLE_CHROME = ("/opt/google/chrome/chrome",)
OTHER_CHROMIUM = ("/opt/chromium/chrome", "/usr/lib/chromium/chromium")


def _real_binary(path) -> bool:
    """An executable program, not a launcher script and not a snap: only that runs inside a box."""
    try:
        with open(path, "rb") as handle:
            magic = handle.read(4)
    except OSError:
        return False
    return magic == b"\x7fELF" and os.access(path, os.X_OK) and "/snap/" not in os.path.realpath(path)


def find_chrome(home: Path | None = None) -> Path | None:
    """The browser a Pip's computer runs: Google Chrome when it is installed, as on Grok's bots;
    otherwise a Playwright Chromium build, or a system Chromium.

    Snap-packaged Chromium cannot run inside another sandbox, so it is never chosen, and neither is
    a launcher script standing in for Chrome.
    """
    for path in GOOGLE_CHROME:
        if _real_binary(path):
            return Path(path)
    home = home or Path.home()
    roots = [Path(os.environ["PLAYWRIGHT_BROWSERS_PATH"])] if os.environ.get("PLAYWRIGHT_BROWSERS_PATH") else []
    roots.append(home / ".cache" / "ms-playwright")
    builds = [b for root in roots for b in root.glob("chromium-*/chrome-linux*/chrome")]
    for build in sorted(builds, key=lambda b: b.parent.parent.name, reverse=True):
        if os.access(build, os.X_OK):
            return build
    for path in OTHER_CHROMIUM:
        if _real_binary(path):
            return Path(path)
    return None


def browser_name(path) -> str:
    return "Google Chrome" if str(path) in GOOGLE_CHROME else "Chromium"


def capability(home: Path | None = None) -> dict:
    """Whether this computer can host Pip computers, and in one sentence why not."""
    if not sys.platform.startswith("linux"):
        return {"available": False, "reason": "Pip computers run on Linux for now; macOS and Windows are coming."}
    if not shutil.which("bwrap"):
        return {"available": False, "reason": "Install bubblewrap (sudo apt install bubblewrap) to give Pips a computer."}
    chrome = find_chrome(home)
    if chrome is None:
        return {"available": False, "reason": "No usable Chromium was found. Run: npx playwright install chromium"}
    return {"available": True, "reason": "", "chrome": str(chrome)}


@dataclass
class Box:
    """One running box: bubblewrap around Chromium, with its devtools pipe."""
    home: Path
    egress_socket: Path
    chrome: Path
    viewport: tuple[int, int] = DEFAULT_VIEWPORT
    proc: subprocess.Popen | None = None
    read_fd: int = -1
    write_fd: int = -1

    def argv(self, forwarder: Path) -> list[str]:
        chrome_dir = self.chrome.parent
        chrome = ["/opt/chrome/" + self.chrome.name, *_CHROME_FLAGS,
                  f"--window-size={self.viewport[0]},{self.viewport[1]}", "about:blank"]
        inner = "python3 /run/dgc/forward.py & sleep 0.3; exec " + shlex.join(chrome)
        return ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
                "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/bin", "/bin",
                "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/sbin", "/sbin",
                "--ro-bind", "/etc/fonts", "/etc/fonts", "--ro-bind-try", "/etc/ssl", "/etc/ssl",
                "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
                "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
                "--dev", "/dev", "--proc", "/proc", "--size", str(512 * 1024 * 1024), "--tmpfs", "/tmp",
                "--bind", str(self.home), "/home/pip", "--setenv", "HOME", "/home/pip",
                "--setenv", "TMPDIR", "/tmp", "--unsetenv", "DBUS_SESSION_BUS_ADDRESS",
                "--ro-bind", str(chrome_dir), "/opt/chrome",
                "--dir", "/run/dgc", "--bind", str(self.egress_socket), "/run/dgc/egress.sock",
                "--ro-bind", str(forwarder), "/run/dgc/forward.py",
                "sh", "-c", inner]

    def start(self, log_path: Path) -> None:
        forwarder = self.home.parent / "forward.py"
        forwarder.write_text(FORWARDER)
        command_read, command_write = os.pipe()          # browser reads commands on fd 3
        reply_read, reply_write = os.pipe()              # browser writes replies on fd 4
        env = {k: os.environ[k] for k in ("PATH", "LANG") if k in os.environ}
        with open(log_path, "ab") as log:
            self.proc = subprocess.Popen(
                [sys.executable, "-c", _PIPE_EXEC, str(command_read), str(reply_write), *self.argv(forwarder)],
                pass_fds=(command_read, reply_write), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                env=env, start_new_session=True)
        os.close(command_read); os.close(reply_write)
        self.write_fd, self.read_fd = command_write, reply_read

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, 9)
            except OSError:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        for fd in (self.read_fd, self.write_fd):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        self.read_fd = self.write_fd = -1


# --------------------------------------------------------------------------- devtools over the pipe

class _Pipe:
    """NUL-delimited JSON over Chromium's devtools pipe, with the WebSocket client's interface."""

    def __init__(self, read_fd: int, write_fd: int):
        self.read_fd, self.write_fd = read_fd, write_fd
        self._buffer = b""
        self._timeout = 30.0
        self._write_lock = threading.Lock()

    def settimeout(self, timeout: float) -> None:
        self._timeout = timeout

    def send(self, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8") + b"\0"
        with self._write_lock:
            view = memoryview(data)
            while view:
                written = os.write(self.write_fd, view)
                view = view[written:]

    def recv(self) -> dict:
        deadline = time.monotonic() + self._timeout
        while b"\0" not in self._buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise socket.timeout("devtools pipe read timed out")
            ready, _, _ = select.select([self.read_fd], [], [], remaining)
            if not ready:
                raise socket.timeout("devtools pipe read timed out")
            chunk = os.read(self.read_fd, 1 << 20)
            if not chunk:
                raise BrowserError("the computer's browser closed its devtools pipe")
            self._buffer += chunk
            if len(self._buffer) > MAX_FRAME_BYTES:
                raise BrowserError("devtools message exceeded the size ceiling")
        raw, self._buffer = self._buffer.split(b"\0", 1)
        try:
            return json.loads(raw.decode("utf-8", "replace"))
        except ValueError as error:
            raise BrowserError(f"devtools sent unreadable JSON: {error}") from error

    def close(self) -> None:
        pass                                              # the Box owns the descriptors


class _PageChannel:
    """The page session's view of the pipe: every command carries the session id."""

    def __init__(self, pipe: _Pipe, session_id: str):
        self.pipe, self.session_id = pipe, session_id

    def settimeout(self, timeout: float) -> None:
        self.pipe.settimeout(timeout)

    def send(self, payload: dict) -> None:
        self.pipe.send({**payload, "sessionId": self.session_id})

    def recv(self) -> dict:
        return self.pipe.recv()

    def close(self) -> None:
        pass


@dataclass
class HeldWrite:
    """A request the browser wanted to send that changes something; it waits, unsent."""
    request_id: str
    session_id: str
    method: str
    url: str
    fields: list[tuple[str, str]] = field(default_factory=list)
    body_bytes: int = 0
    held_at: float = 0.0
    payment: bool = False           # carries a payment card number: the review says so

    def summary(self) -> dict:
        parts = urlsplit(self.url)
        value = {"method": self.method, "host": parts.hostname or "", "path": (parts.path or "/")[:300],
                 "fields": [{"name": name[:80], "value": value[:200]} for name, value in self.fields[:MAX_SUMMARY_FIELDS]],
                 "more_fields": max(0, len(self.fields) - MAX_SUMMARY_FIELDS), "body_bytes": self.body_bytes}
        if self.payment:
            value["payment"] = True
        return value


def _luhn(digits: str) -> bool:
    total, double = 0, False
    for ch in reversed(digits):
        n = int(ch) * (2 if double else 1)
        total += n - 9 if n > 9 else n
        double = not double
    return total % 10 == 0


def _fields(post_data: str, content_type: str) -> list[tuple[str, str]]:
    """What a person reviewing the write should see: field names, values masked where secret."""
    pairs: list[tuple[str, str]] = []
    text = post_data or ""
    if "json" in content_type:
        try:
            value = json.loads(text)
        except ValueError:
            value = None
        if isinstance(value, dict):
            pairs = [(str(k), v if isinstance(v, str) else json.dumps(v)[:200]) for k, v in value.items()]
    elif "x-www-form-urlencoded" in content_type or (text and "=" in text and "\n" not in text[:2000]):
        pairs = parse_qsl(text, keep_blank_values=True)
    return [(name, "•••" if SECRET_FIELD.search(name) else value) for name, value in pairs]


def carries_card_number(post_data: str) -> bool:
    # A browser form sends "4242 4242 …" as 4242+4242 or 4242%204242: decode before looking.
    from urllib.parse import unquote_plus
    text = post_data or ""
    for run in re.findall(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)", text + "\n" + unquote_plus(text)):
        digits = re.sub(r"\D", "", run)
        if 13 <= len(digits) <= 19 and _luhn(digits):
            return True
    return False


class BoxedBrowser(BrowserSession):
    """A BrowserSession that runs in a box and holds every write for the user's approval."""

    def __init__(self, home: Path, egress_socket: Path, *, chrome: Path, log_path: Path,
                 viewport: tuple[int, int] = DEFAULT_VIEWPORT, on_write=None):
        super().__init__(chrome, allow_unsandboxed=True, viewport=viewport)
        self.home = Path(home)
        self.egress_socket = Path(egress_socket)
        self.log_path = Path(log_path)
        self.on_write = on_write            # called with a HeldWrite after it is held
        # Starts the box process. bwrap --die-with-parent follows the THREAD that started it, so
        # the owner passes a launcher that runs on a thread living as long as the computer.
        self.launch = lambda start: start()
        self.held: dict[str, HeldWrite] = {}
        self._box: Box | None = None
        self._pipe: _Pipe | None = None
        self._attached: dict[str, str] = {}      # targetId -> its first (gated) session

    # -- lifecycle -------------------------------------------------------------------------

    def start(self) -> None:
        if self._ws is not None:
            return
        self._box = Box(self.home, self.egress_socket, self.binary, self.viewport)
        self.launch(lambda: self._box.start(self.log_path))
        self._pipe = _Pipe(self._box.read_fd, self._box.write_fd)
        try:
            self._browser_call("Browser.getVersion", timeout=25)
            # Every page -- this one and any popup a site opens -- is attached paused, gated, and
            # only then allowed to run. Set before the first page exists, so none is missed.
            self._browser_call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True})
            target = self._browser_call("Target.createTarget", {"url": "about:blank"})["targetId"]
            deadline = time.monotonic() + 10
            while target not in self._attached and time.monotonic() < deadline:
                self._observe(self._pipe.recv())
            session = self._attached.get(target)
            if not session:
                raise BrowserError("the page never attached")
        except (BrowserError, socket.timeout, OSError) as error:
            self._cleanup()
            raise BoxError(f"The Pip's computer did not start: {error}") from error
        self._ws = _PageChannel(self._pipe, session)
        for domain in ("Page", "Runtime", "Log", "Network"):
            self.command(f"{domain}.enable")
        # Downloads land in the computer's Files, which the Files app and the Terminal see.
        try:
            self._browser_call("Browser.setDownloadBehavior", {"behavior": "allow", "downloadPath": "/home/pip/Files/Downloads"})
        except (BrowserError, socket.timeout, OSError):
            pass

    def _browser_call(self, method: str, params: dict | None = None, *, timeout: float = 20) -> dict:
        self._next_id += 1
        want = self._next_id
        self._pipe.settimeout(timeout)
        self._pipe.send({"id": want, "method": method, "params": params or {}})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self._pipe.recv()
            if message.get("id") == want:
                if "error" in message:
                    raise BrowserError(f"{method}: {message['error'].get('message', 'devtools error')}")
                return message.get("result", {}) or {}
            self._observe(message)
        raise socket.timeout(f"{method} timed out")

    def _fire(self, method: str, params: dict | None = None, session: str | None = None) -> None:
        """Send without waiting; the reply is observed and ignored."""
        self._next_id += 1
        message = {"id": self._next_id, "method": method, "params": params or {}}
        if session:
            message["sessionId"] = session
        self._pipe.send(message)

    def _guard(self, session: str) -> None:
        """Gate one target: intercept every request, block WebSockets."""
        self._fire("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]}, session)
        self._fire("Network.enable", {}, session)
        self._fire("Network.setBlockedURLs", {"urls": ["ws://*", "wss://*"]}, session)

    def _cleanup(self) -> None:
        self._ws = None
        if self._box is not None:
            self._box.stop()
            self._box = None
        self._pipe = None
        self._proc = None
        self._profile = ""           # the profile lives in the Pip's home; never removed here

    # -- the write gate --------------------------------------------------------------------

    def _observe(self, message: dict) -> None:
        method = message.get("method", "")
        params = message.get("params", {}) or {}
        if method == "Target.attachedToTarget":
            child = params.get("sessionId", "")
            info = params.get("targetInfo", {}) or {}
            if child:
                self._attached.setdefault(str(info.get("targetId", "")), child)
                self._guard(child)
                self._fire("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}, child)
                self._fire("Runtime.runIfWaitingForDebugger", {}, child)
        elif method == "Fetch.requestPaused":
            self._gate(params, message.get("sessionId", ""))
        super()._observe(message)

    def _gate(self, params: dict, session: str) -> None:
        request = params.get("request", {}) or {}
        request_id = str(params.get("requestId", ""))
        verb = str(request.get("method", "GET")).upper()
        if verb in READ_METHODS:
            self._fire("Fetch.continueRequest", {"requestId": request_id}, session)
            return
        post = str(request.get("postData", "") or "")
        if len(self.held) >= MAX_HELD:
            self._fire("Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"}, session)
            return
        headers = {str(k).lower(): str(v) for k, v in (request.get("headers") or {}).items()}
        held = HeldWrite(request_id, session, verb, str(request.get("url", ""))[:2000],
                         _fields(post, headers.get("content-type", "")), len(post.encode("utf-8")), time.time(),
                         payment=carries_card_number(post))
        self.held[request_id] = held
        if self.on_write is not None:
            self.on_write(held)

    def release(self, request_id: str) -> None:
        """Send one held request, exactly as the page made it."""
        held = self.held.pop(request_id)
        self._fire("Fetch.continueRequest", {"requestId": held.request_id}, held.session_id)

    def drop(self, request_id: str) -> None:
        held = self.held.pop(request_id, None)
        if held is not None:
            self._fire("Fetch.failRequest", {"requestId": held.request_id, "errorReason": "BlockedByClient"}, held.session_id)

    # -- the user's own hands (live view); the model never uses these ----------------------

    def click_at(self, x: float, y: float) -> None:
        for kind in ("mousePressed", "mouseReleased"):
            self.command("Input.dispatchMouseEvent", {"type": kind, "x": float(x), "y": float(y),
                                                      "button": "left", "clickCount": 1})

    def insert_text(self, text: str) -> None:
        self.command("Input.insertText", {"text": str(text)[:2000]})

    def scroll_by(self, dy: float) -> None:
        self.command("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": self.viewport[0] / 2,
                                                  "y": self.viewport[1] / 2, "deltaX": 0, "deltaY": float(dy)})

    def screenshot_jpeg(self, quality: int = 60) -> bytes:
        """A review frame small enough to travel in one Pips reply (about 60 KB)."""
        import base64
        result = self.command("Page.captureScreenshot", {"format": "jpeg", "quality": quality}, timeout=30)
        return base64.b64decode(result.get("data", ""))

    def pump(self, seconds: float) -> None:
        """Let the page run (and the gate see its requests) for a while."""
        self._pump(seconds)
