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
# Telemetry a page sends by itself (sendBeacon, <a ping>, CSP reports): never a change the user approves.
TELEMETRY_KINDS = frozenset({"Ping", "CSPViolationReport"})
# A page's own background requests (XHR, fetch). A write is the Pip's (or the user's) when it follows
# their click, typing, key or choice within ACTION_SECONDS, on the same page; then it waits for Allow.
BACKGROUND_KINDS = frozenset({"XHR", "Fetch", "EventSource"})
ACTION_SECONDS = 5.0
MAX_HELD = 8                          # held writes per browser; more are dropped, not queued
MAX_SUMMARY_FIELDS = 24
SECRET_FIELD = re.compile(r"pass|pwd|secret|token|otp|cvv|cvc|pin\b|card|iban|ssn", re.I)

# What a Pip that can see is never shown (BoxedBrowser.screenshot_for_model): these run in DGC's own isolated
# world, so the page's scripts can neither see them nor change the built-ins they use.
# A password, card number, expiry, security code or one-time code: by its type, its autocomplete token, its
# name, label or placeholder, or a value that looks like a card number. A frame a payment provider puts on the
# page (Stripe, Braintree, Adyen...) is covered whole.
_SECRET_BOXES_JS = r"""function () {
  const NAME = /pass(word|wd|code)?|pwd|otp|one.?time|cvv|cvc|csc|card.?(num|no|number)|cc.?(num|no|number)|security.?code|expir|exp.?(date|month|year|mm|yy)|iban|ssn|\bpin\b/i;
  const FRAME = /stripe|braintree|adyen|checkout\.com|paypal|squareup|razorpay|recurly|spreedly|worldpay|cybersource|authorize\.net|klarna|verygoodsecurity|basistheory|payment|card|cvc|secure.?field|pci/i;
  const secret = (el) => {
    const type = (el.getAttribute('type') || el.type || '').toLowerCase();
    if (type === 'password') return true;
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    if (auto.some((t) => /^(cc-|current-password$|new-password$|one-time-code$)/.test(t))) return true;
    const words = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'),
                   el.getAttribute('data-elements-stable-field-name')].join(' ');
    if (NAME.test(words)) return true;
    if (/\d{4}\s?\d{4}\s?\d{4}/.test(el.getAttribute('placeholder') || '')) return true;
    const digits = String(el.value || '').replace(/[\s-]/g, '');
    return /^\d{13,19}$/.test(digits);
  };
  const shown = (r) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0;
  const boxes = [];
  const visit = (doc, ox, oy, depth) => {
    for (const el of doc.querySelectorAll('input, textarea, select')) {
      if (!secret(el)) continue;
      const r = el.getBoundingClientRect();
      if (shown(r)) boxes.push([ox + r.left, oy + r.top, r.width, r.height]);
    }
    // Frames are asked one by one (screenshot_for_model): only a payment provider's is covered whole here.
    for (const f of doc.querySelectorAll('iframe, frame')) {
      const r = f.getBoundingClientRect();
      if (shown(r) && FRAME.test([f.src, f.name, f.title, f.id].join(' '))) boxes.push([ox + r.left, oy + r.top, r.width, r.height]);
    }
  };
  visit(document, 0, 0, 0);
  return {boxes: boxes.slice(0, 200), width: window.innerWidth, height: window.innerHeight,
          ratio: window.devicePixelRatio || 1};
}"""
# The screenshot redrawn in an OffscreenCanvas (never on the page): fitted to its size, the boxes blacked out.
_COMPOSE_JS = r"""async function (b64, boxes, width, height, perCss, quality, mark) {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const picture = await createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}));
  const canvas = new OffscreenCanvas(width, height), g = canvas.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(picture, 0, 0, width, height);
  g.fillStyle = '#000';
  for (const b of boxes) g.fillRect(b[0] * perCss - 3, b[1] * perCss - 3, b[2] * perCss + 6, b[3] * perCss + 6);
  if (mark) {
    // Where the mouse is after the Pip's last step (and the path of a drag): a red ring it can see.
    const x = mark[0] * perCss, y = mark[1] * perCss;
    if (mark.length > 3 && mark[2] !== null) {
      g.setLineDash([5, 4]); g.lineWidth = 2; g.strokeStyle = 'rgba(230, 30, 30, 0.75)';
      g.beginPath(); g.moveTo(mark[2] * perCss, mark[3] * perCss); g.lineTo(x, y); g.stroke(); g.setLineDash([]);
    }
    g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.lineWidth = 4; g.strokeStyle = 'rgba(255, 255, 255, 0.9)'; g.stroke();
    g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.lineWidth = 2; g.strokeStyle = 'rgba(230, 30, 30, 0.95)'; g.stroke();
  }
  const blob = await canvas.convertToBlob({type: 'image/jpeg', quality: quality});
  const out = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return {data: btoa(text), width: width, height: height};
}"""
# What is at a point, in a few words: its role and its name, never what a field holds.
_ELEMENT_AT_JS = r"""function (x, y) {
  let doc = document, el = document.elementFromPoint(x, y), ox = 0, oy = 0;
  for (let depth = 0; el && /^(IFRAME|FRAME)$/.test(el.tagName) && depth < 4; depth++) {
    let inner = null;
    try { inner = el.contentDocument; } catch (e) { inner = null; }
    if (!inner) return 'a frame from another site';
    const r = el.getBoundingClientRect(); ox += r.left; oy += r.top;
    doc = inner; el = inner.elementFromPoint(x - ox, y - oy);
  }
  if (!el) return 'nothing (outside the page)';
  const target = el.closest('a, button, input, textarea, select, label, summary, [role], [onclick], [contenteditable], canvas, video, img, svg') || el;
  const tag = target.tagName.toLowerCase();
  const type = (target.getAttribute('type') || '').toLowerCase();
  const role = target.getAttribute('role') || ({a: 'link', button: 'button', textarea: 'text box', select: 'dropdown',
    canvas: 'canvas', img: 'image', svg: 'icon', label: 'label', video: 'video', summary: 'summary'})[tag]
    || (tag === 'input' ? (['checkbox', 'radio', 'file', 'range', 'color'].includes(type) ? type : ['submit', 'button', 'reset'].includes(type) ? 'button' : 'text field') : tag);
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const name = clean(target.getAttribute('aria-label') || target.getAttribute('alt') || target.getAttribute('title')
    || (tag === 'input' || tag === 'textarea' ? target.getAttribute('placeholder') || target.getAttribute('name') : target.innerText));
  return role + (name ? ' "' + name + '"' : '');
}"""

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
    # Like Chrome on Grok's bots: not marked as automated (navigator.webdriver), so Google's search
    # answers instead of asking "are you a robot" every time (founder, 2026-10-07). A check that
    # still appears stops the Pip and asks the user (pip_computer.human_check); it never solves one.
    "--disable-blink-features=AutomationControlled",
)
# What pages are told about the network: online, an ordinary connection (see BoxedBrowser._guard).
ONLINE = {"offline": False, "latency": 40, "downloadThroughput": 12_500_000, "uploadThroughput": 2_500_000,
          "connectionType": "ethernet"}
# A new window on the computer's screen opens here, as on Grok's bots.
HOME_PAGE = "https://www.google.com/"


def host_timezone() -> str | None:
    """This computer's IANA time zone, for every box of a Pip's computer: pages see the user's own
    clock. A box without one ran in UTC, and a UTC clock on an Indian address was the one difference
    between the Pip's Chrome and a plain Chrome when Google answered the Pip with "are you a robot"."""
    names = [os.environ.get("TZ", "").lstrip(":")]
    try:
        target = os.readlink("/etc/localtime")          # Linux and macOS: .../zoneinfo/Area/City
        names.append(target.split("zoneinfo/", 1)[1] if "zoneinfo/" in target else "")
    except OSError:
        pass
    try:
        names.append(Path("/etc/timezone").read_text(encoding="utf-8").strip())
    except OSError:
        pass
    for name in names:
        if (name and re.fullmatch(r"[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){0,2}", name)
                and ".." not in name and (Path("/usr/share/zoneinfo") / name).is_file()):
            return name
    return None


def timezone_args() -> list[str]:
    """bwrap's --setenv TZ for the host's zone, or nothing when it cannot be told."""
    zone = host_timezone()
    return ["--setenv", "TZ", zone] if zone else []


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
    if sys.platform == "darwin":
        # On a Mac, Chrome is inside the computer's VM (pip_container), once its image is built.
        from . import pip_container
        return Path(pip_container.CHROME) if pip_container.status()["state"] == "ready" else None
    for path in GOOGLE_CHROME:
        if _real_binary(path):
            return Path(path)
    # The Google Chrome DGC downloaded itself (pip_screen_setup): no admin password needed.
    from . import pip_screen_setup
    own = pip_screen_setup.chrome_path()
    if own is not None and _real_binary(own):
        return own
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
    return "Google Chrome" if str(path) in GOOGLE_CHROME or str(path).endswith("/opt/google/chrome/chrome") else "Chromium"


def _own_libraries(chrome: Path) -> list[str]:
    """Libraries the downloaded Chrome brought (DGC's copy, mounted at /opt/desk): bwrap arguments.
    The system's Chrome and Chromium need none."""
    from . import pip_screen_setup
    root = pip_screen_setup.current_root()
    if root is None or not chrome.is_relative_to(root) or not (root / "usr" / "lib").is_dir():
        return []
    libs = ":".join(f"/opt/desk/usr/lib/{triplet}" for triplet in ("aarch64-linux-gnu", "x86_64-linux-gnu")) + ":/opt/desk/usr/lib"
    return ["--ro-bind", str(root / "usr"), "/opt/desk/usr", "--setenv", "LD_LIBRARY_PATH", libs]


# Ubuntu's own profile for bubblewrap (shipped, off by default): bwrap may make namespaces, and what runs inside gets
# no capabilities -- enough for a Pip's box, whose browser is held by the box and its proxy, not its own sandbox.
UBUNTU_BWRAP_PROFILE = ("sudo apt update && sudo apt install apparmor-profiles && sudo install -m 0644 "
                        "/usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/ && "
                        "sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict")
_BOX_PROBE: dict = {}


def box_runs() -> tuple[bool, str]:
    """Whether bubblewrap can build a Pip's box here, and if not why, in its own words. Installed is not enough: a
    stock Ubuntu 24.04 has bwrap but lets no program without an AppArmor profile make user namespaces. A box with the
    computer's own isolation is tried once (cached per bwrap binary)."""
    bwrap = shutil.which("bwrap")
    if not bwrap:
        return False, ""
    try:
        info = os.stat(bwrap)
    except OSError:
        return False, ""
    key = (bwrap, info.st_size, info.st_mtime)
    if key not in _BOX_PROBE:
        try:
            probe = subprocess.run([bwrap, "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
                                    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"],
                                   capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL,
                                   env={k: os.environ[k] for k in ("PATH", "LANG") if k in os.environ})
            said = (probe.stderr or "").strip().splitlines()
            result = (probe.returncode == 0, said[-1][:200] if said else "")
        except (OSError, subprocess.SubprocessError) as error:
            result = (False, str(error)[:200])
        if not result[0]:
            return result             # tried again next time: the user may have just turned the profile on
        _BOX_PROBE[key] = result
    return _BOX_PROBE[key]


def box_refused_reason(said: str) -> str:
    """What to tell the user when bubblewrap is here but can't build a box."""
    from .browser_setup import userns_restricted
    if userns_restricted():
        return ("Ubuntu lets only programs with an AppArmor profile make the namespaces a Pip's computer needs, and "
                "bubblewrap has none here. Turn on Ubuntu's own profile for it, once, in a terminal: "
                + UBUNTU_BWRAP_PROFILE)
    return "bubblewrap can't build a Pip's computer on this machine" + (f" ({said})" if said else "") + "."


def capability(home: Path | None = None) -> dict:
    """Whether this computer can host Pip computers, and in one sentence why not."""
    if sys.platform == "darwin":
        from . import pip_container
        ok, why = pip_container.supported()
        if not ok:
            return {"available": False, "reason": why}
        setup = pip_container.status()
        if setup["state"] == "ready":
            return {"available": True, "reason": "", "chrome": pip_container.CHROME}
        if setup["state"] == "failed" and setup["error"]:
            return {"available": False, "reason": f"DGC could not set up its computer: {setup['error']}"[:400]}
        return {"available": False, "reason": "Setting up its computer. This happens once."}
    if not sys.platform.startswith("linux"):
        return {"available": False, "reason": "On Windows, Pips and their computers run in DGC inside WSL 2."}
    from . import wsl
    if wsl.version() == 1:
        return {"available": False, "reason": "This distro runs on WSL 1, which has no Linux kernel of its own, so a "
                "Pip can't have a computer. Switch it to WSL 2 in Windows: "
                f"`wsl --set-version {wsl.distro() or '<distro>'} 2`."}
    if not shutil.which("bwrap"):
        return {"available": False, "reason": "Install bubblewrap (sudo apt install bubblewrap) to give Pips a computer."}
    works, said = box_runs()
    if not works:
        return {"available": False, "reason": box_refused_reason(said)}
    chrome = find_chrome(home)
    if chrome is None:
        # DGC fetches Chrome itself (pip_screen_setup): say that, not an install command, while it can.
        from . import pip_screen_setup
        setup = pip_screen_setup.status()
        if pip_screen_setup.supported()[0] and setup.get("state") in ("none", "running"):
            return {"available": False, "reason": "Setting up its computer. This happens once."}
        if setup.get("state") == "failed" and setup.get("error"):
            return {"available": False, "reason": f"DGC could not set up its computer: {setup['error']}"[:400]}
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
    display_dir: Path | None = None       # a desktop's X socket directory: the browser draws there

    def argv(self, forwarder: Path) -> list[str]:
        chrome_dir = self.chrome.parent
        flags = list(_CHROME_FLAGS)
        if self.display_dir is not None:
            # A window on the Pip's desktop, like Chrome on Grok's bots; still driven and gated here.
            # Sized to leave the dock's strip at the bottom of the screen free, whenever the dock appears.
            flags = [f for f in flags if f != "--headless=new"] + ["--window-position=0,0", "--password-store=basic",
                                                                  "--disable-session-crashed-bubble"]
        # On a desktop the browser opens no window of its own: DGC's first page is its only tab.
        size = f"--window-size={self.viewport[0]},{self.viewport[1]}" if self.display_dir is None else "--window-size=1280,724"
        chrome = ["/opt/chrome/" + self.chrome.name, *flags, size,
                  *(["--no-startup-window"] if self.display_dir is not None else ["about:blank"])]
        display = ([] if self.display_dir is None else
                   ["--bind", str(self.display_dir), "/tmp/.X11-unix", "--setenv", "DISPLAY", ":1"])
        inner = "python3 /run/dgc/forward.py & sleep 0.3; exec " + shlex.join(chrome)
        return ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
                "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/bin", "/bin",
                "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/sbin", "/sbin",
                "--ro-bind", "/etc/fonts", "/etc/fonts", "--ro-bind-try", "/etc/ssl", "/etc/ssl",
                "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
                "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
                "--dev", "/dev", "--proc", "/proc", "--size", str(512 * 1024 * 1024), "--tmpfs", "/tmp", *display,
                "--bind", str(self.home), "/home/pip", "--setenv", "HOME", "/home/pip",
                "--setenv", "TMPDIR", "/tmp", "--unsetenv", "DBUS_SESSION_BUS_ADDRESS", *timezone_args(),
                "--ro-bind", str(chrome_dir), "/opt/chrome", *_own_libraries(self.chrome),
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
        # A read never blocks: if anything else ever reads this pipe, it can take the data select()
        # announced, and a blocking read would then hold the computer's lock forever (a test that drove
        # the browser without the lock did exactly that on a Mac). Only lock holders read it.
        os.set_blocking(read_fd, False)
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
            try:
                chunk = os.read(self.read_fd, 1 << 20)
            except BlockingIOError:
                continue
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
    site: bool = False              # careful mode: a page on a site this Pip hasn't visited (pip_careful)

    def summary(self) -> dict:
        parts = urlsplit(self.url)
        value = {"method": self.method, "host": parts.hostname or "", "path": (parts.path or "/")[:300],
                 "fields": [{"name": name[:80], "value": value[:200]} for name, value in self.fields[:MAX_SUMMARY_FIELDS]],
                 "more_fields": max(0, len(self.fields) - MAX_SUMMARY_FIELDS), "body_bytes": self.body_bytes}
        if self.payment:
            value["payment"] = True
        if self.site:
            from .pip_careful import shown_host, site_of
            value.update(kind="site", site=site_of(parts.hostname or ""), shown=shown_host(parts.hostname or ""))
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

    def __init__(self, home: Path, egress_socket: Path, *, chrome: Path | None, log_path: Path,
                 viewport: tuple[int, int] = DEFAULT_VIEWPORT, on_write=None):
        super().__init__(chrome, allow_unsandboxed=True, viewport=viewport)
        self.home = Path(home)
        self.display_dir: Path | None = None      # set by the Host when the computer has a desktop
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
        self._pages: set[str] = set()             # the targets that are tabs (their main frame's id)
        self._kinds: dict[str, str] = {}          # targetId -> page, iframe, worker...
        self._parents: dict[str, str] = {}        # targetId -> the session it was attached from ("" the browser)
        self._drag_data = None                    # an HTML drag Chrome caught during drag() (Input.dragIntercepted)
        self._chooser = None                      # a file chooser the page opened while DGC answers it (set_files)
        # Careful mode (pip_careful), during a run: url -> True when its site may load. A page on any
        # other site waits, like a submit, until the user allows the site.
        self.site_gate = None
        self.acted_at = 0.0                       # the last click, typing, key or choice (see acting())

    # -- lifecycle -------------------------------------------------------------------------

    def start(self) -> None:
        if self._ws is not None:
            return
        if self.binary is None:
            # The computer was made while DGC was still fetching Chrome (pip_screen_setup): look
            # again now instead of keeping the answer from then.
            self.binary = find_chrome()
            if self.binary is None:
                raise BoxError(capability().get("reason") or "No browser is available for this computer yet.")
        if sys.platform == "darwin":
            from .pip_container import ContainerBox     # Chrome in the computer's VM, the same pipe
            self._box = ContainerBox(self.home, self.egress_socket, self.viewport, on_screen=self.display_dir is not None)
        else:
            self._box = Box(self.home, self.egress_socket, self.binary, self.viewport, display_dir=self.display_dir)
        self.launch(lambda: self._box.start(self.log_path))
        self._pipe = _Pipe(self._box.read_fd, self._box.write_fd)
        try:
            self._browser_call("Browser.getVersion", timeout=25)
            # Every page -- this one and any popup a site opens -- is attached paused, gated, and
            # only then allowed to run. Set before the first page exists, so none is missed.
            self._browser_call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True})
            target = self._browser_call("Target.createTarget", {"url": HOME_PAGE if self.display_dir is not None else "about:blank"})["targetId"]
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
        if self.display_dir is not None:
            # On a desktop, a profile that kept its sign-ins also remembers its last tabs; DGC's page is
            # the one the Pip and the user share, so the browser starts with that tab alone.
            try:
                for info in self._browser_call("Target.getTargets").get("targetInfos", []):
                    if info.get("type") == "page" and info.get("targetId") != target:
                        self._browser_call("Target.closeTarget", {"targetId": info["targetId"]})
            except (BrowserError, socket.timeout, OSError):
                pass
        # Downloads land in the computer's Files, which the Files app and the Terminal see.
        try:
            self._browser_call("Browser.setDownloadBehavior", {"behavior": "allow", "downloadPath": "/home/pip/Files/Downloads"})
        except (BrowserError, socket.timeout, OSError):
            pass

    def alive(self) -> bool:
        """Started, and its process still running (a window the user closed may have ended it)."""
        return (self._ws is not None and self._box is not None and self._box.proc is not None
                and self._box.proc.poll() is None)

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
        # Every request, by URL alone: patterns by resource type missed form POSTs (Document) in Chrome 155.
        self._fire("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]}, session)
        self._fire("Network.enable", {}, session)
        self._fire("Network.setBlockedURLs", {"urls": ["ws://*", "wss://*"]}, session)
        # The box's only way out is DGC's proxy, so Chrome sees no network of its own and tells pages it
        # is offline (navigator.onLine false) while it loads them: the box-only signal that made Google
        # ask the Pip "are you a robot" when a plain Chrome on the same machine got results. Pages see
        # the connection they really have. (Reported state only; replies to unsupported targets ignored.)
        self._fire("Network.overrideNetworkState", ONLINE, session)

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
                self._kinds.setdefault(str(info.get("targetId", "")), str(info.get("type", "")))
                self._parents.setdefault(str(info.get("targetId", "")), str(message.get("sessionId", "")))
                if info.get("type") == "page":
                    self._pages.add(str(info.get("targetId", "")))
                self._guard(child)
                self._fire("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}, child)
                self._fire("Runtime.runIfWaitingForDebugger", {}, child)
        elif method == "Fetch.requestPaused":
            self._gate(params, message.get("sessionId", ""))
        elif method == "Input.dragIntercepted":
            self._drag_data = params.get("data")
        elif method == "Page.fileChooserOpened" and isinstance(params.get("backendNodeId"), int):
            self._chooser = params
        elif method == "Page.frameNavigated" and not (params.get("frame") or {}).get("parentId"):
            self.acted_at = 0.0          # a new page: its own requests are not the last action's effect
        super()._observe(message)

    def acting(self) -> bool:
        """Whether the Pip or the user acted on this page in the last ACTION_SECONDS."""
        return time.monotonic() - self.acted_at <= ACTION_SECONDS

    # The Pip's actions (and the user's own hands below) start the window in which a write is theirs.
    def click(self, ref: str) -> str:
        self.acted_at = time.monotonic()
        return super().click(ref)

    def type_text(self, ref: str, text: str, *, replace: bool = True) -> str:
        self.acted_at = time.monotonic()
        return super().type_text(ref, text, replace=replace)

    def press(self, key: str) -> str:
        self.acted_at = time.monotonic()
        return super().press(key)

    def select_option(self, ref: str, value: str) -> str:
        self.acted_at = time.monotonic()
        return super().select_option(ref, value)

    def _gate(self, params: dict, session: str) -> None:
        request = params.get("request", {}) or {}
        request_id = str(params.get("requestId", ""))
        verb = str(request.get("method", "GET")).upper()
        kind = str(params.get("resourceType", ""))
        gate = self.site_gate
        if (gate is not None and kind == "Document" and verb in READ_METHODS
                and str(params.get("frameId", "")) in self._attached and not gate(str(request.get("url", "")))):
            # A tab's own page (never a frame inside one) on a site the Pip hasn't visited for this user. A
            # write to such a site is held below like any submit, with its fields; never as a "visit".
            if len(self.held) >= MAX_HELD:
                self._fire("Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"}, session)
                return
            held = HeldWrite(request_id, session, verb, str(request.get("url", ""))[:2000], [], 0, time.time(), site=True)
            self.held[request_id] = held
            if self.on_write is not None:
                self.on_write(held)
            return
        inner_form = kind == "Document" and str(params.get("frameId", "")) not in self._pages
        if (verb in READ_METHODS or kind in TELEMETRY_KINDS
                or (kind in BACKGROUND_KINDS or inner_form) and not self.acting()):
            # A read, telemetry, or the page's own background traffic: nothing the Pip did. Holding it
            # made every page with analytics ask for approval (and kept Google's own checks from running).
            # That includes a form a page posts into a hidden frame by itself, as Facebook's pixel does with a
            # large event: held, it stopped the page loading and paused the Pip (battle test, 2026-10-09).
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

    # -- hands by position: the user's live view, and a Pip that can see --------------------
    # Every one of these starts the window in which a write is the Pip's (or the user's), so a
    # submit a click by position causes is held exactly as one a click on a ref causes.

    def click_at(self, x: float, y: float, *, button: str = "left", count: int = 1) -> None:
        self.acted_at = time.monotonic()
        x, y = float(x), float(y)
        self.command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0})
        mask = {"left": 1, "right": 2, "middle": 4}.get(button, 1)
        # A right click is for the page's own menu. The browser's menu would open on the computer's screen, where
        # the Pip can neither see nor use it and it stays until someone closes it: DGC's own isolated world cancels
        # it for this one click (the page's handlers still run).
        world = self._quiet_menu() if button == "right" else None
        try:
            for click in range(1, max(1, int(count)) + 1):
                for kind in ("mousePressed", "mouseReleased"):
                    self.command("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": button,
                                                              "buttons": mask if kind == "mousePressed" else 0,
                                                              "clickCount": click})
        finally:
            if world is not None:
                try:
                    self._in_world(world, "function () { window.removeEventListener('contextmenu', window.__dgcQuiet, true); return true; }")
                except (BrowserError, socket.timeout, OSError):
                    pass

    def _quiet_menu(self):
        try:
            world = self._isolated()
            self._in_world(world, "function () { window.__dgcQuiet = (e) => e.preventDefault();"
                                  " window.addEventListener('contextmenu', window.__dgcQuiet, true); return true; }")
            return world
        except (BrowserError, socket.timeout, OSError, KeyError, TypeError, ValueError):
            return None

    def hover_at(self, x: float, y: float) -> None:
        self.acted_at = time.monotonic()
        self.command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": float(x), "y": float(y),
                                                  "button": "none", "buttons": 0})

    def drag(self, x1: float, y1: float, x2: float, y2: float, *, steps: int = 12) -> None:
        """Press at one point, move there in real steps, release at the other: canvas editors (a T-shirt
        designer, a drawing app) only see a drag that moves. An HTML drag-and-drop the page starts is
        caught by Chrome and finished with drag events at the same points."""
        self.acted_at = time.monotonic()
        x1, y1, x2, y2 = float(x1), float(y1), float(x2), float(y2)
        steps = max(2, min(int(steps), 40))
        self._drag_data = None
        intercept = True
        try:
            self.command("Input.setInterceptDrags", {"enabled": True})
        except BrowserError:
            intercept = False                   # an older Chrome: mouse moves only
        try:
            self.command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x1, "y": y1, "button": "none", "buttons": 0})
            self.command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x1, "y": y1, "button": "left",
                                                      "buttons": 1, "clickCount": 1})
            dragging = False
            for step in range(1, steps + 1):
                x = x1 + (x2 - x1) * step / steps
                y = y1 + (y2 - y1) * step / steps
                if self._drag_data is not None:
                    self.command("Input.dispatchDragEvent", {"type": "dragOver" if dragging else "dragEnter",
                                                             "x": x, "y": y, "data": self._drag_data})
                    dragging = True
                else:
                    self.command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "left",
                                                              "buttons": 1})
                self._pump(0.02)
            if self._drag_data is not None:
                self.command("Input.dispatchDragEvent", {"type": "drop", "x": x2, "y": y2, "data": self._drag_data})
            self.command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x2, "y": y2, "button": "left",
                                                      "buttons": 0, "clickCount": 1})
        finally:
            self._drag_data = None
            if intercept:
                try:
                    self.command("Input.setInterceptDrags", {"enabled": False})
                except BrowserError:
                    pass
        self.acted_at = time.monotonic()

    def scroll_at(self, x: float, y: float, dy: float, dx: float = 0.0) -> None:
        self.acted_at = time.monotonic()
        self.command("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": float(x), "y": float(y),
                                                  "deltaX": float(dx), "deltaY": float(dy)})

    def insert_text(self, text: str) -> None:
        self.acted_at = time.monotonic()
        self.command("Input.insertText", {"text": str(text)[:2000]})

    def type_into_focus(self, text: str) -> None:
        """Type into whatever has focus, a key at a time (an editor's canvas text box listens for keys)."""
        self.acted_at = time.monotonic()
        text = str(text)[:2000]
        if len(text) > 400:
            self.command("Input.insertText", {"text": text})
            return
        for ch in text:
            if ch == "\n":
                self.press("enter")
                continue
            self.command("Input.dispatchKeyEvent", {"type": "keyDown", "text": ch, "unmodifiedText": ch, "key": ch})
            self.command("Input.dispatchKeyEvent", {"type": "keyUp", "key": ch})
        self.acted_at = time.monotonic()

    def scroll_by(self, dy: float) -> None:
        self.command("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": self.viewport[0] / 2,
                                                  "y": self.viewport[1] / 2, "deltaX": 0, "deltaY": float(dy)})

    def screenshot_jpeg(self, quality: int = 60) -> bytes:
        """A review frame small enough to travel in one Pips reply (about 60 KB)."""
        import base64
        result = self.command("Page.captureScreenshot", {"format": "jpeg", "quality": quality}, timeout=30)
        return base64.b64decode(result.get("data", ""))

    # -- the Pip's eyes ------------------------------------------------------------------------

    def css_viewport(self) -> tuple[float, float]:
        """The page's visible area in CSS pixels: what a click at (x, y) is measured against."""
        metrics = self.command("Page.getLayoutMetrics")
        view = metrics.get("cssLayoutViewport") or metrics.get("layoutViewport") or {}
        width, height = float(view.get("clientWidth") or 0), float(view.get("clientHeight") or 0)
        if width <= 0 or height <= 0:
            width, height = float(self.viewport[0]), float(self.viewport[1])
        return width, height

    def _isolated(self) -> int:
        """A fresh isolated world in the page: DGC's own scripts there see the page's DOM with the browser's
        own built-ins, never the page's scripts, and the page sees nothing of them."""
        tree = self.command("Page.getFrameTree")
        frame_id = ((tree.get("frameTree") or {}).get("frame") or {}).get("id")
        if not frame_id:
            raise BrowserError("the page has no frame to look at")
        made = self.command("Page.createIsolatedWorld", {"frameId": frame_id, "worldName": "dgc-eyes",
                                                         "grantUniveralAccess": False})
        return int(made["executionContextId"])

    def _in_world(self, context: int, function: str, *args, timeout: float = 20) -> object:
        result = self.command("Runtime.callFunctionOn", {
            "functionDeclaration": function, "executionContextId": context, "awaitPromise": True,
            "returnByValue": True, "arguments": [{"value": arg} for arg in args]}, timeout=timeout)
        if result.get("exceptionDetails"):
            raise BrowserError("the screen could not be prepared")
        return (result.get("result") or {}).get("value")

    def secret_boxes(self) -> dict:
        """Where passwords, card numbers, security codes and one-time codes are on the screen, in CSS
        pixels ({boxes: [[x, y, width, height]...], width, height, ratio}): fields in the page and in each
        of its frames (same site or not, in this process or another), and the whole of every frame a
        payment provider puts on the page. ``width``/``height`` are the window's CSS size, ``ratio`` its
        device pixels per CSS pixel. A frame DGC can't ask is covered whole."""
        found = self._in_world(self._isolated(), _SECRET_BOXES_JS)
        if not isinstance(found, dict):
            raise BrowserError("the screen could not be checked for passwords")
        boxes = list(found.get("boxes") or [])
        # Frames in this tab's own process (same site, or another site Chrome keeps here): each asked in
        # its own isolated world, its fields placed by the box of the frame that holds them.
        tree = self.command("Page.getFrameTree").get("frameTree") or {}
        pending = list(tree.get("childFrames") or [])
        while pending:
            node = pending.pop()
            pending.extend(node.get("childFrames") or [])
            frame_id = str((node.get("frame") or {}).get("id", ""))
            if not frame_id or frame_id in self._attached:
                continue                       # a frame from another site in its own process: below
            origin = self._frame_origin(frame_id)
            if origin is None:
                continue                       # not on the screen
            try:
                made = self.command("Page.createIsolatedWorld", {"frameId": frame_id, "worldName": "dgc-eyes",
                                                                 "grantUniveralAccess": False})
                inner = self._in_world(int(made["executionContextId"]), _SECRET_BOXES_JS)
            except (BrowserError, KeyError, TypeError, ValueError, socket.timeout):
                inner = None
            if not isinstance(inner, dict):
                boxes.append(origin[2])        # couldn't ask it: all of it
                continue
            boxes.extend([origin[0] + float(b[0]), origin[1] + float(b[1]), float(b[2]), float(b[3])]
                         for b in (inner.get("boxes") or [])[:50])
        # A frame from another site in its own process: asked through its own session, placed by the box of
        # the frame on this tab that holds it (the frame itself, or the one it is nested in).
        page_session = getattr(self._ws, "session_id", "")
        for target, session in list(self._attached.items()):
            if self._kinds.get(target) != "iframe":
                continue
            top, hops = target, 0
            while self._parents.get(top) not in (page_session, None) and hops < 8:
                parent = self._session_target(self._parents.get(top))
                if parent is None:
                    break
                top, hops = parent, hops + 1
            if self._parents.get(top) != page_session:
                continue                      # a frame of another tab
            try:
                inner = self._session_eval(session, "(" + _SECRET_BOXES_JS + ")()")
            except (BrowserError, socket.timeout, OSError):
                inner = None
            if isinstance(inner, dict) and not inner.get("boxes"):
                continue
            origin = self._frame_origin(top)
            if origin is None:
                continue
            if top == target and isinstance(inner, dict):
                boxes.extend([origin[0] + float(b[0]), origin[1] + float(b[1]), float(b[2]), float(b[3])]
                             for b in inner["boxes"][:50])
            else:
                boxes.append(origin[2])       # nested deeper, or it would not answer: all of it
        found["boxes"] = [[float(v) for v in b[:4]] for b in boxes if isinstance(b, (list, tuple)) and len(b) >= 4][:200]
        return found

    def _frame_origin(self, frame_id: str):
        """Where a frame's content starts on the screen, and its whole box: (left, top, [x, y, w, h]), or
        None when it isn't shown. A frame DGC can't place covers the whole screen."""
        try:
            owner = self.command("DOM.getFrameOwner", {"frameId": frame_id})
            model = self.command("DOM.getBoxModel", {"backendNodeId": owner["backendNodeId"]}).get("model") or {}
        except BrowserError as error:
            if "box model" in str(error).lower() or "could not compute" in str(error).lower():
                return None                    # not rendered (display: none)
            return 0.0, 0.0, [0.0, 0.0, 1e5, 1e5]
        except (KeyError, TypeError):
            return 0.0, 0.0, [0.0, 0.0, 1e5, 1e5]
        try:
            content = [float(v) for v in model.get("content") or []]
            border = [float(v) for v in model.get("border") or []]
            left, top = min(content[0::2]), min(content[1::2])
            bx, by = min(border[0::2]), min(border[1::2])
            return left, top, [bx, by, max(border[0::2]) - bx, max(border[1::2]) - by]
        except (ValueError, IndexError):
            return 0.0, 0.0, [0.0, 0.0, 1e5, 1e5]

    def _session_target(self, session):
        for target, known in self._attached.items():
            if known == session:
                return target
        return None

    def _session_eval(self, session: str, expression: str):
        """Evaluate in another target's session (a frame from another site); its reply comes back by id."""
        self._next_id += 1
        want = self._next_id
        self._pipe.send({"id": want, "method": "Runtime.evaluate", "sessionId": session,
                         "params": {"expression": expression, "returnByValue": True, "awaitPromise": True}})
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            self._pipe.settimeout(max(0.05, deadline - time.monotonic()))
            message = self._pipe.recv()
            if message.get("id") == want:
                if "error" in message or (message.get("result") or {}).get("exceptionDetails"):
                    raise BrowserError("frame evaluation failed")
                return ((message.get("result") or {}).get("result") or {}).get("value")
            self._observe(message)
        raise socket.timeout("frame evaluation timed out")

    def screenshot_for_model(self, *, max_width: int = 1280, max_height: int = 800, quality: int = 70,
                             mark: dict | None = None) -> dict:
        """What a Pip that can see is shown: the browser's visible page as a JPEG of at most
        max_width x max_height, with every password and payment-card field blacked out first.

        Returns {data, width, height, scale, masked}: ``scale`` is image pixels per CSS pixel, so a point
        the model names in the image is (x / scale, y / scale) on the page. A screen whose secret fields
        can't be blacked out is never returned: BrowserError instead."""
        import base64
        from . import image_views
        self.start()
        found = self.secret_boxes()
        boxes = found["boxes"]
        shot = self.command("Page.captureScreenshot", {"format": "jpeg", "quality": 88}, timeout=30)
        data = str(shot.get("data", ""))
        raw = base64.b64decode(data) if data else b""
        size = image_views.dimensions(raw) if raw else None
        if not size or not size[0] or not size[1]:
            raise BrowserError("the browser returned an empty screenshot")
        shot_width, shot_height = int(size[0]), int(size[1])
        fit = min(1.0, max_width / shot_width, max_height / shot_height)
        width, height = max(1, round(shot_width * fit)), max(1, round(shot_height * fit))
        css_width = float(found.get("width") or 0) or float(shot_width)
        per_css = shot_width / css_width * fit             # image pixels per CSS pixel
        # Always re-encoded in DGC's own isolated world: the boxes blacked out, the size fitted, one quality.
        context = self._isolated()
        ring = ([float(mark["x"]), float(mark["y"]), mark.get("from_x"), mark.get("from_y")]
                if isinstance(mark, dict) and "x" in mark and "y" in mark else None)
        done = self._in_world(context, _COMPOSE_JS, data, boxes, width, height, per_css, quality / 100, ring, timeout=30)
        if not isinstance(done, dict) or not isinstance(done.get("data"), str) or not done["data"]:
            raise BrowserError("the screen has a password or card field DGC could not hide")
        out = base64.b64decode(done["data"])
        measured = image_views.dimensions(out)
        if not measured or (int(measured[0]), int(measured[1])) != (width, height):
            raise BrowserError("the screen could not be prepared")
        return {"data": out, "width": width, "height": height, "scale": per_css, "masked": len(boxes)}

    def element_at(self, x: float, y: float) -> str:
        """What is at a point, in a few words (its role and name; never what a field holds)."""
        try:
            context = self._isolated()
            said = self._in_world(context, _ELEMENT_AT_JS, float(x), float(y))
        except (BrowserError, socket.timeout, OSError):
            return ""
        return str(said or "")[:120]

    def screen_offset(self) -> tuple[float, float] | None:
        """Where the page's top-left corner is on the computer's screen (a window on its desktop)."""
        if self.display_dir is None:
            return None
        try:
            context = self._isolated()
            spot = self._in_world(context, "function(){return [window.screenX, window.screenY, window.outerWidth,"
                                           " window.innerWidth, window.outerHeight, window.innerHeight];}")
            sx, sy, ow, iw, oh, ih = (float(v) for v in spot)
        except (BrowserError, socket.timeout, OSError, TypeError, ValueError):
            return None
        return sx + max(0.0, (ow - iw) / 2), sy + max(0.0, oh - ih)

    def set_files(self, paths: list[str], *, ref: str = "", point: tuple[float, float] | None = None) -> str:
        """Put files (paths inside the box) into a page's file input: a ref to an <input type=file>, or
        the button (by ref or by point) that opens the page's file chooser, which DGC answers itself.
        Choosing a file sends nothing: the page's own upload, when it makes one, is held like any write."""
        self.start()
        if ref and point is None:
            element = self._locator(ref)
            kind = self.evaluate_json("(() => { const el = " + element + "; return el ? (el.tagName === 'INPUT'"
                                      " && (el.type || '').toLowerCase() === 'file' ? 'input' : 'other') : 'missing'; })()")
            if kind == "missing":
                raise BrowserError(f"{ref} is not on the page. Take a fresh read: refs change whenever the page does.")
            if kind == "input":
                node = self.command("Runtime.evaluate", {"expression": element})
                object_id = (node.get("result") or {}).get("objectId")
                if not object_id:
                    raise BrowserError(f"{ref} could not be used")
                self.command("DOM.setFileInputFiles", {"files": list(paths), "objectId": object_id})
                self.acted_at = time.monotonic()
                return "input"
        self._chooser = None
        self.command("Page.setInterceptFileChooserDialog", {"enabled": True})
        try:
            if point is not None:
                self.click_at(point[0], point[1])
            else:
                self.click(ref)
            deadline = time.monotonic() + 5
            while self._chooser is None and time.monotonic() < deadline:
                self._pump(0.2)
            chooser = self._chooser
        finally:
            self._chooser = None
            try:
                self.command("Page.setInterceptFileChooserDialog", {"enabled": False})
            except BrowserError:
                pass
        if chooser is None:
            raise BrowserError("that did not open a file chooser. Use the page's file field or its upload button.")
        if chooser.get("mode") == "selectSingle":
            paths = list(paths)[:1]
        self.command("DOM.setFileInputFiles", {"files": list(paths), "backendNodeId": chooser["backendNodeId"]})
        self.acted_at = time.monotonic()
        return "chooser"

    def pump(self, seconds: float) -> None:
        """Let the page run (and the gate see its requests) for a while."""
        self._pump(seconds)
