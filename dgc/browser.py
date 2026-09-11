"""Drive a real browser over the Chrome DevTools Protocol, with no new dependency.

DGC ships three runtime dependencies.  Playwright would add Node, npx and a few hundred megabytes
of browser download, so this speaks CDP directly to a Chrome the user already has: a minimal
RFC 6455 client over a plain socket, a temporary profile that never touches the real one, and a
page snapshot the model can read and act on.

Two findings shape the design, both measured rather than assumed:

* ``Accessibility.getFullAXTree`` is not the page.  ``content-visibility: auto`` drops off-screen
  sections from rendering, from ``innerText`` **and** from the CDP accessibility tree, so a
  snapshot built from it silently under-reports content -- on vibedgc.com's own changelog, text
  present twice in ``textContent`` appeared zero times in either.  The snapshot is therefore built
  from the DOM by a fixed first-party script.  That script is ours and never model-supplied; the
  tool deliberately exposes no arbitrary-JavaScript operation.
* Navigate-then-sleep reads half-built pages.  Readiness waits on the load event plus a quiet
  period, and the result says which signal it got.
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

# Bounds.  Every one of these is a ceiling the model cannot argue with.
CONNECT_TIMEOUT = 20.0
COMMAND_TIMEOUT = 30.0
LAUNCH_TIMEOUT = 25.0
LOAD_TIMEOUT = 30.0
QUIET_AFTER_LOAD = 0.6
MAX_FRAME_BYTES = 24 * 1024 * 1024
MAX_SNAPSHOT_NODES = 1200
MAX_SNAPSHOT_CHARS = 12000
MAX_NAME_CHARS = 160
MAX_CONSOLE_MESSAGES = 60
MAX_NETWORK_REQUESTS = 120
DEFAULT_VIEWPORT = (1280, 900)


class BrowserError(Exception):
    """Anything the caller should turn into ``error: ...`` rather than a traceback."""


# --------------------------------------------------------------------------- discovery

_PATH_CANDIDATES = ("chromium", "chromium-browser", "chrome", "google-chrome",
                    "google-chrome-stable", "microsoft-edge", "microsoft-edge-stable")

_MAC_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
)

_WINDOWS_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
)

INSTALL_HINT = (
    "No Chrome or Chromium found. Install one from your package manager or google.com/chrome, "
    "or point DGC at an existing binary with `browser_path` in ~/.dgc/config.json. "
    "DGC never downloads a browser for you.")


def _playwright_browsers() -> list[Path]:
    """Playwright's cache, newest build first.  Many developers already have one here."""
    roots = [Path.home() / ".cache" / "ms-playwright",
             Path.home() / "Library" / "Caches" / "ms-playwright"]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        roots.append(Path(local) / "ms-playwright")
    found: list[tuple[int, Path]] = []
    for root in roots:
        try:
            entries = list(root.glob("chromium-*"))
        except OSError:
            continue
        for entry in entries:
            digits = re.sub(r"\D", "", entry.name)
            build = int(digits) if digits else 0
            for relative in ("chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
                             "chrome-win/chrome.exe"):
                candidate = entry / relative
                if candidate.exists():
                    found.append((build, candidate))
    found.sort(key=lambda item: item[0], reverse=True)
    return [path for _, path in found]


def discover_browser(configured: str = "") -> Path:
    """First hit wins: explicit config, CHROME_PATH, Playwright's cache, PATH, OS locations."""
    if configured:
        path = Path(configured).expanduser()
        if not path.exists():
            raise BrowserError(f"browser_path points at {path}, which does not exist")
        return path
    env = os.environ.get("CHROME_PATH", "").strip()
    if env:
        path = Path(env).expanduser()
        if path.exists():
            return path
    for candidate in _playwright_browsers():
        return candidate
    for name in _PATH_CANDIDATES:
        found = shutil.which(name)
        if found:
            return Path(found)
    for literal in _MAC_CANDIDATES + _WINDOWS_CANDIDATES:
        path = Path(literal)
        if path.exists():
            return path
    raise BrowserError(INSTALL_HINT)


# --------------------------------------------------------------------------- websocket

class _WebSocket:
    """Client-side RFC 6455 over a plain socket.

    The endpoint is always loopback, so there is no TLS to negotiate, no proxy to honour and no
    permessage-deflate to unpack.  What does have to be right is the part a naive client gets
    wrong: every client frame is masked, and a large CDP payload arrives fragmented.
    """

    def __init__(self, url: str, timeout: float = CONNECT_TIMEOUT):
        if not url.startswith("ws://"):
            raise BrowserError(f"unsupported devtools endpoint {url!r}")
        authority, _, path = url[len("ws://"):].partition("/")
        host, _, port = authority.partition(":")
        self._sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        self._sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            "GET /" + path + " HTTP/1.1\r\n"
            "Host: " + authority + "\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: " + key + "\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n")
        self._sock.sendall(request.encode("ascii"))
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise BrowserError("devtools closed the connection during the handshake")
            header += chunk
            if len(header) > 64 * 1024:
                raise BrowserError("devtools handshake response was implausibly large")
        status = header.split(b"\r\n", 1)[0].decode("latin-1")
        if " 101 " not in status:
            raise BrowserError(f"devtools refused the websocket upgrade: {status}")

    def settimeout(self, timeout: float) -> None:
        self._sock.settimeout(timeout)

    def send(self, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        mask = os.urandom(4)
        length = len(data)
        frame = bytearray(b"\x81")
        if length < 126:
            frame.append(0x80 | length)
        elif length < 65536:
            frame.append(0x80 | 126)
            frame += struct.pack(">H", length)
        else:
            frame.append(0x80 | 127)
            frame += struct.pack(">Q", length)
        frame += mask
        frame += bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
        self._sock.sendall(bytes(frame))

    def _exact(self, count: int) -> bytes:
        out = bytearray()
        while len(out) < count:
            chunk = self._sock.recv(min(65536, count - len(out)))
            if not chunk:
                raise BrowserError("devtools connection closed")
            out += chunk
        return bytes(out)

    def recv(self) -> dict:
        buffer = bytearray()
        while True:
            first, second = self._exact(2)
            final, opcode, length = first & 0x80, first & 0x0F, second & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._exact(8))[0]
            if length > MAX_FRAME_BYTES or len(buffer) + length > MAX_FRAME_BYTES:
                raise BrowserError("devtools frame exceeded the size ceiling")
            data = self._exact(length) if length else b""
            if opcode == 0x9:                                    # ping -> pong, same payload
                mask = os.urandom(4)
                pong = bytearray(b"\x8a")
                pong.append(0x80 | len(data))
                pong += mask
                pong += bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
                self._sock.sendall(bytes(pong))
                continue
            if opcode == 0xA:                                    # pong, nothing to do
                continue
            if opcode == 0x8:
                raise BrowserError("devtools closed the connection")
            if opcode in (0x0, 0x1, 0x2):
                buffer += data
                if final:
                    try:
                        return json.loads(bytes(buffer).decode("utf-8", "replace"))
                    except ValueError as error:
                        raise BrowserError(f"devtools sent unreadable JSON: {error}") from error
                continue
            raise BrowserError(f"devtools sent an unexpected frame opcode {opcode}")

    def close(self) -> None:
        try:
            self._sock.close()
        except OSError:
            pass


# --------------------------------------------------------------------------- the in-page snapshot

# Fixed, first-party, and never model-supplied.  Reading the DOM rather than the accessibility
# tree is what keeps content-visibility sections in the snapshot.
_SNAPSHOT_JS = r"""
(() => {
  const MAX_NODES = %d, MAX_NAME = %d;
  const ROLES = {
    a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'image', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    form: 'form', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', ul: 'list',
    ol: 'list', li: 'listitem', article: 'article', section: 'region', dialog: 'dialog',
    summary: 'summary', details: 'group', label: 'label', option: 'option', video: 'video',
    audio: 'audio', iframe: 'iframe', code: 'code', pre: 'code', time: 'time',
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
  const refs = {};
  let counter = 0, truncated = false;
  const clean = (value) => {
    const text = (value || '').replace(/\s+/g, ' ').trim();
    return text.length > MAX_NAME ? text.slice(0, MAX_NAME) + '…' : text;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const kind = (el.getAttribute('type') || 'text').toLowerCase();
      if (kind === 'checkbox' || kind === 'radio') return kind;
      if (kind === 'submit' || kind === 'button' || kind === 'reset') return 'button';
      return 'textbox';
    }
    return ROLES[tag] || '';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const parts = labelled.split(/\s+/)
        .map((id) => (document.getElementById(id) || {}).textContent || '');
      const joined = clean(parts.join(' '));
      if (joined) return joined;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') return clean(el.getAttribute('alt') || '');
    if (tag === 'input' || tag === 'textarea') {
      return clean(el.getAttribute('placeholder') || el.getAttribute('name')
                   || el.getAttribute('aria-placeholder') || '');
    }
    // Own text only, so a wrapper does not inherit the whole subtree as its name.
    let own = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) own += child.nodeValue;
    }
    own = clean(own);
    if (own) return own;
    return clean(el.getAttribute('title') || '');
  };
  const hidden = (el) => {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('hidden')) return true;
    const style = getComputedStyle(el);
    // display:none and visibility:hidden really are hidden. content-visibility is NOT: the
    // content exists and a sighted reader reaches it by scrolling, so it belongs in the snapshot.
    return style.display === 'none' || style.visibility === 'hidden';
  };
  const lines = [];
  const walk = (el, depth) => {
    if (counter >= MAX_NODES) { truncated = true; return; }
    if (SKIP.has(el.tagName) || hidden(el)) return;
    const role = roleOf(el);
    const name = nameOf(el);
    let childDepth = depth;
    if (role || name) {
      counter += 1;
      const ref = 'e' + counter;
      refs[ref] = el;
      el.setAttribute('data-dgc-ref', ref);
      const bits = [];
      if (el.tagName === 'A' && el.getAttribute('href')) bits.push('href=' + el.getAttribute('href'));
      if (el.hasAttribute('disabled')) bits.push('disabled');
      if (el.checked === true) bits.push('checked');
      if (el.value && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        bits.push('value=' + clean(String(el.value)));
      }
      const level = el.tagName.match(/^H([1-6])$/) ? ' level=' + el.tagName[1] : '';
      lines.push('  '.repeat(Math.min(depth, 12)) + '- ' + (role || 'generic') + level +
                 (name ? ' "' + name + '"' : '') + ' [' + ref + ']' +
                 (bits.length ? ' (' + bits.join(', ') + ')' : ''));
      childDepth = depth + 1;
    }
    for (const child of el.children) walk(child, childDepth);
  };
  walk(document.body || document.documentElement, 0);
  window.__dgcRefs = refs;
  return JSON.stringify({
    url: location.href, title: document.title,
    lines: lines, count: counter, truncated: truncated,
  });
})()
""" % (MAX_SNAPSHOT_NODES, MAX_NAME_CHARS)


# --------------------------------------------------------------------------- session

@dataclass
class _Page:
    console: list[str] = field(default_factory=list)
    requests: list[dict] = field(default_factory=list)
    last_activity: float = 0.0


class BrowserSession:
    """One browser process, launched on first use and reused until the DGC session ends."""

    def __init__(self, binary: Path, *, allow_unsandboxed: bool = False,
                 viewport: tuple[int, int] = DEFAULT_VIEWPORT):
        self.binary = binary
        self.allow_unsandboxed = allow_unsandboxed
        self.viewport = viewport
        self._proc: subprocess.Popen | None = None
        self._profile: str = ""
        self._ws: _WebSocket | None = None
        self._next_id = 0
        self._page = _Page()
        self.current_url = ""

    # -- lifecycle ---------------------------------------------------------

    def _flags(self, sandbox: bool) -> list[str]:
        flags = [
            str(self.binary), "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--disable-extensions", "--disable-sync",
            "--disable-background-networking", "--metrics-recording-only", "--mute-audio",
            f"--window-size={self.viewport[0]},{self.viewport[1]}",
            "--remote-debugging-port=0", f"--user-data-dir={self._profile}",
        ]
        if not sandbox:
            flags.append("--no-sandbox")
        flags.append("about:blank")
        return flags

    def _spawn(self, sandbox: bool) -> tuple[subprocess.Popen, str, str]:
        log_path = os.path.join(self._profile, "launch.log")
        handle = open(log_path, "wb")
        try:
            proc = subprocess.Popen(self._flags(sandbox), stdout=handle, stderr=handle,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
        finally:
            handle.close()
        port_file = os.path.join(self._profile, "DevToolsActivePort")
        deadline = time.monotonic() + LAUNCH_TIMEOUT
        while time.monotonic() < deadline:
            if os.path.exists(port_file) and os.path.getsize(port_file) > 0:
                with open(port_file, encoding="utf-8", errors="replace") as handle:
                    port = handle.read().split("\n")[0].strip()
                if port:
                    return proc, port, ""
            if proc.poll() is not None:
                break
            time.sleep(0.1)
        try:
            proc.kill()
        except OSError:
            pass
        try:
            with open(log_path, encoding="utf-8", errors="replace") as handle:
                log = handle.read()[-4000:]
        except OSError:
            log = ""
        return proc, "", log

    def start(self) -> None:
        if self._ws is not None:
            return
        self._profile = tempfile.mkdtemp(prefix="dgc-browser-")
        proc, port, log = self._spawn(sandbox=not self.allow_unsandboxed)
        if not port and "No usable sandbox" in log:
            # The distro blocks unprivileged user namespaces.  Say so, and say what it costs,
            # rather than quietly dropping the renderer sandbox on the user's behalf.
            if not self.allow_unsandboxed:
                self._cleanup()
                raise BrowserError(
                    "Chromium cannot start its sandbox on this system (unprivileged user "
                    "namespaces are restricted, which is the default on Ubuntu 23.10+). "
                    "Either install an AppArmor profile for the browser, or set "
                    "`browser_allow_unsandboxed: true` in ~/.dgc/config.json to run without the "
                    "renderer sandbox -- which means a page exploit is no longer contained.")
            proc, port, log = self._spawn(sandbox=False)
        if not port:
            self._cleanup()
            detail = log.strip().splitlines()[-1] if log.strip() else "no devtools port was written"
            raise BrowserError(f"the browser did not start: {detail}")
        self._proc = proc
        try:
            targets = self._targets(port)
        except OSError as error:
            self._cleanup()
            raise BrowserError(f"could not reach devtools on port {port}: {error}") from error
        page = next((t for t in targets if t.get("type") == "page"), None)
        if not page or not page.get("webSocketDebuggerUrl"):
            self._cleanup()
            raise BrowserError("the browser started but exposed no page target")
        self._ws = _WebSocket(str(page["webSocketDebuggerUrl"]))
        for domain in ("Page", "Runtime", "Log", "Network"):
            self.command(f"{domain}.enable")

    @staticmethod
    def _targets(port: str) -> list[dict]:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=10) as response:
            return json.loads(response.read().decode("utf-8", "replace"))

    def _cleanup(self) -> None:
        if self._ws is not None:
            self._ws.close()
            self._ws = None
        if self._proc is not None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=5)
            except Exception:
                try:
                    self._proc.kill()
                except OSError:
                    pass
            self._proc = None
        if self._profile:
            shutil.rmtree(self._profile, ignore_errors=True)
            self._profile = ""

    def close(self) -> None:
        self._cleanup()
        self._page = _Page()
        self.current_url = ""

    # -- protocol ----------------------------------------------------------

    def command(self, method: str, params: dict | None = None, *,
                timeout: float = COMMAND_TIMEOUT) -> dict:
        if self._ws is None:
            raise BrowserError("the browser session is not running")
        self._next_id += 1
        message_id = self._next_id
        self._ws.settimeout(timeout)
        self._ws.send({"id": message_id, "method": method, "params": params or {}})
        deadline = time.monotonic() + timeout
        while True:
            if time.monotonic() > deadline:
                raise BrowserError(f"{method} timed out after {timeout:.0f}s")
            message = self._ws.recv()
            if message.get("id") == message_id:
                if "error" in message:
                    detail = message["error"].get("message", "unknown devtools error")
                    raise BrowserError(f"{method}: {detail}")
                return message.get("result", {}) or {}
            self._observe(message)

    def _observe(self, message: dict) -> None:
        """Keep the events worth reporting; drop the rest without buffering them forever."""
        method = message.get("method", "")
        params = message.get("params", {}) or {}
        if method in ("Network.requestWillBeSent", "Network.responseReceived",
                      "Network.loadingFinished", "Network.loadingFailed"):
            self._page.last_activity = time.monotonic()
        if method == "Network.responseReceived":
            response = params.get("response", {}) or {}
            if len(self._page.requests) < MAX_NETWORK_REQUESTS:
                self._page.requests.append({
                    "url": str(response.get("url", ""))[:300],
                    "status": response.get("status"),
                    "type": params.get("type", ""),
                })
        elif method == "Network.loadingFailed":
            if len(self._page.requests) < MAX_NETWORK_REQUESTS:
                self._page.requests.append({
                    "url": "", "status": "failed",
                    "type": params.get("type", ""),
                    "error": str(params.get("errorText", ""))[:160],
                })
        elif method == "Log.entryAdded":
            entry = params.get("entry", {}) or {}
            if len(self._page.console) < MAX_CONSOLE_MESSAGES:
                level = str(entry.get("level", "info"))
                text = str(entry.get("text", ""))[:300]
                self._page.console.append(f"{level}: {text}")
        elif method == "Runtime.consoleAPICalled":
            if len(self._page.console) < MAX_CONSOLE_MESSAGES:
                args = params.get("args", []) or []
                rendered = " ".join(str(a.get("value", a.get("description", "")))
                                    for a in args)[:300]
                self._page.console.append(f"{params.get('type', 'log')}: {rendered}")

    def _pump(self, seconds: float) -> None:
        """Drain events for a while so console, network and readiness stay current."""
        if self._ws is None:
            return
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            remaining = max(0.05, deadline - time.monotonic())
            self._ws.settimeout(remaining)
            try:
                self._observe(self._ws.recv())
            except BrowserError:
                return
            except socket.timeout:
                return
            except OSError:
                return

    # -- operations --------------------------------------------------------

    def navigate(self, url: str) -> str:
        self.start()
        self._page = _Page()
        self.command("Page.navigate", {"url": url})
        loaded = self._await_load()
        self.current_url = self.evaluate_json("location.href") or url
        return loaded

    def _await_load(self) -> str:
        """Wait for the load event, then for the network to go quiet.  Report which we got."""
        if self._ws is None:
            raise BrowserError("the browser session is not running")
        deadline = time.monotonic() + LOAD_TIMEOUT
        loaded = False
        while time.monotonic() < deadline:
            remaining = max(0.05, deadline - time.monotonic())
            self._ws.settimeout(remaining)
            try:
                message = self._ws.recv()
            except (BrowserError, socket.timeout, OSError):
                break
            self._observe(message)
            if message.get("method") == "Page.loadEventFired":
                loaded = True
                break
        if not loaded:
            return "timed out waiting for the load event"
        quiet_deadline = time.monotonic() + 3.0
        while time.monotonic() < quiet_deadline:
            self._pump(QUIET_AFTER_LOAD)
            if time.monotonic() - self._page.last_activity >= QUIET_AFTER_LOAD:
                return "loaded"
        return "loaded (network still busy)"

    def evaluate_json(self, expression: str):
        """Run a FIXED first-party expression.  Never reachable with model-supplied source."""
        result = self.command("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": True})
        if result.get("exceptionDetails"):
            detail = result["exceptionDetails"].get("text", "evaluation failed")
            raise BrowserError(f"page evaluation failed: {detail}")
        return (result.get("result", {}) or {}).get("value")

    def snapshot(self) -> dict:
        self.start()
        raw = self.evaluate_json(_SNAPSHOT_JS)
        try:
            data = json.loads(raw) if isinstance(raw, str) else {}
        except ValueError as error:
            raise BrowserError(f"could not read the page snapshot: {error}") from error
        if not isinstance(data, dict):
            raise BrowserError("the page snapshot came back in an unexpected shape")
        return data

    def console_messages(self) -> list[str]:
        self._pump(0.2)
        return list(self._page.console)

    def network_requests(self) -> list[dict]:
        self._pump(0.2)
        return list(self._page.requests)

    # -- interaction -------------------------------------------------------

    @staticmethod
    def _locator(ref: str) -> str:
        """A ref is ours (``e12``), so it is safe to inline -- but validate before trusting it."""
        if not re.fullmatch(r"e[0-9]{1,6}", ref or ""):
            raise BrowserError(f"{ref!r} is not an element ref; take one from a snapshot, like e12")
        return "document.querySelector('[data-dgc-ref=\"" + ref + "\"]')"

    def _centre_of(self, ref: str) -> tuple[float, float, str]:
        """Scroll the element into view and return its centre, so the click lands where a user's would."""
        element = self._locator(ref)
        raw = self.evaluate_json(
            "(() => { const el = " + element + ";"
            " if (!el) return JSON.stringify({ok: false});"
            " el.scrollIntoView({block: 'center', inline: 'center'});"
            " const r = el.getBoundingClientRect();"
            " const label = (el.innerText || el.value || el.getAttribute('aria-label') || '')"
            "   .replace(/\\s+/g, ' ').trim().slice(0, 80);"
            " return JSON.stringify({ok: r.width > 0 && r.height > 0,"
            "   x: r.left + r.width / 2, y: r.top + r.height / 2, label: label,"
            "   disabled: !!el.disabled}); })()")
        try:
            box = json.loads(raw) if isinstance(raw, str) else {}
        except ValueError:
            box = {}
        if not box.get("ok"):
            raise BrowserError(
                f"{ref} is not on the page, or has no size. Take a fresh snapshot: refs change "
                "whenever the page does.")
        if box.get("disabled"):
            raise BrowserError(f"{ref} is disabled")
        return float(box["x"]), float(box["y"]), str(box.get("label", ""))

    def click(self, ref: str) -> str:
        self.start()
        x, y, label = self._centre_of(ref)
        for event in ("mousePressed", "mouseReleased"):
            self.command("Input.dispatchMouseEvent", {
                "type": event, "x": x, "y": y, "button": "left", "clickCount": 1,
                "buttons": 1 if event == "mousePressed" else 0})
        self._pump(0.8)
        return label

    def type_text(self, ref: str, text: str, *, replace: bool = True) -> str:
        self.start()
        x, y, label = self._centre_of(ref)
        for event in ("mousePressed", "mouseReleased"):
            self.command("Input.dispatchMouseEvent", {
                "type": event, "x": x, "y": y, "button": "left", "clickCount": 1,
                "buttons": 1 if event == "mousePressed" else 0})
        if replace:
            element = self._locator(ref)
            self.evaluate_json(
                "(() => { const el = " + element + ";"
                " if (el && 'value' in el) { el.value = '';"
                "   el.dispatchEvent(new Event('input', {bubbles: true})); } return 1; })()")
        self.command("Input.insertText", {"text": text})
        self._pump(0.4)
        return label

    def press(self, key: str) -> str:
        self.start()
        named = {"enter": ("Enter", "Enter", 13), "tab": ("Tab", "Tab", 9),
                 "escape": ("Escape", "Escape", 27), "esc": ("Escape", "Escape", 27),
                 "backspace": ("Backspace", "Backspace", 8),
                 "arrowdown": ("ArrowDown", "ArrowDown", 40), "arrowup": ("ArrowUp", "ArrowUp", 38),
                 "arrowleft": ("ArrowLeft", "ArrowLeft", 37),
                 "arrowright": ("ArrowRight", "ArrowRight", 39),
                 "pagedown": ("PageDown", "PageDown", 34), "pageup": ("PageUp", "PageUp", 33),
                 "home": ("Home", "Home", 36), "end": ("End", "End", 35)}
        entry = named.get(str(key).strip().lower())
        if entry is None:
            raise BrowserError(
                f"{key!r} is not a supported key; use one of {', '.join(sorted(named))}")
        name, code, keycode = entry
        for event in ("keyDown", "keyUp"):
            self.command("Input.dispatchKeyEvent", {
                "type": event, "key": name, "code": code,
                "windowsVirtualKeyCode": keycode, "nativeVirtualKeyCode": keycode})
        self._pump(0.8)
        return name

    def select_option(self, ref: str, value: str) -> str:
        self.start()
        element = self._locator(ref)
        payload = json.dumps(value)
        raw = self.evaluate_json(
            "(() => { const el = " + element + "; const want = " + payload + ";"
            " if (!el || el.tagName !== 'SELECT') return JSON.stringify({ok: false, why: 'not a dropdown'});"
            " const options = Array.from(el.options);"
            " const hit = options.find(o => o.value === want)"
            "   || options.find(o => (o.textContent || '').trim() === want);"
            " if (!hit) return JSON.stringify({ok: false,"
            "   why: 'options are: ' + options.map(o => (o.textContent || '').trim()).join(', ')});"
            " el.value = hit.value;"
            " el.dispatchEvent(new Event('input', {bubbles: true}));"
            " el.dispatchEvent(new Event('change', {bubbles: true}));"
            " return JSON.stringify({ok: true, label: (hit.textContent || hit.value).trim()}); })()")
        try:
            result = json.loads(raw) if isinstance(raw, str) else {}
        except ValueError:
            result = {}
        if not result.get("ok"):
            raise BrowserError(f"could not select {value!r}: {result.get('why', 'unknown reason')}")
        self._pump(0.4)
        return str(result.get("label", value))

    def screenshot_png(self) -> bytes:
        self.start()
        result = self.command("Page.captureScreenshot", {"format": "png"}, timeout=60.0)
        data = result.get("data", "")
        if not data:
            raise BrowserError("the browser returned an empty screenshot")
        try:
            return base64.b64decode(data)
        except (ValueError, binascii.Error) as error:  # pragma: no cover - defensive
            raise BrowserError(f"the screenshot was not valid base64: {error}") from error
