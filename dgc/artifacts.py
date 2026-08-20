"""Localhost artifact previews.

When the agent builds something visual — a web page, a small app, a chart — it
can serve it on a local URL and DGC proposes opening it in the browser. Each
artifact is a tiny static file server bound to 127.0.0.1 on a free high port,
tracked in a per-process registry so `/artifact` can list, open, and stop them
(freeing the port). Nothing is ever exposed off the machine.
"""
from __future__ import annotations

import atexit
import socket
import threading
import time
from dataclasses import dataclass, field
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT_BASE = 45000          # 5-digit ports, well clear of the usual dev ports (3000/5173/8080…)
PORT_SPAN = 1000


@dataclass
class Artifact:
    id: str
    name: str
    port: int
    directory: str          # served root (absolute)
    entry: str              # "" for a directory index, else the file name to open
    rel: str                # human label: what was served, relative to the project
    started: float = field(default_factory=time.time)
    _httpd: object = None
    _thread: object = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/{self.entry}"

    @property
    def uptime(self) -> str:
        s = int(time.time() - self.started)
        if s < 60:
            return f"{s}s"
        if s < 3600:
            return f"{s // 60}m"
        return f"{s // 3600}h{(s % 3600) // 60:02d}"


_REGISTRY: dict[str, Artifact] = {}
_LOCK = threading.Lock()
_COUNTER = 0


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def free_port() -> int:
    """A free 5-digit localhost port, scanning up from PORT_BASE; OS-assigned as a last resort."""
    used = {a.port for a in _REGISTRY.values()}
    for port in range(PORT_BASE, PORT_BASE + PORT_SPAN):
        if port not in used and _port_is_free(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:   # let the OS pick any free one
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *a):          # never spew request logs into the TUI
        pass


def serve(path: str, project_root, name: str = "") -> Artifact:
    """Start a static preview for `path` (a directory or an .html file) and register it."""
    global _COUNTER
    root = Path(project_root)
    target = (root / path).resolve() if not Path(path).is_absolute() else Path(path).resolve()
    if not target.exists():
        raise FileNotFoundError(f"{path} does not exist")
    if target.is_dir():
        directory, entry = target, ""
        if not (target / "index.html").exists():
            htmls = sorted(target.glob("*.html"))
            if htmls:
                entry = htmls[0].name
    else:
        directory, entry = target.parent, target.name

    port = free_port()
    handler = partial(_QuietHandler, directory=str(directory))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, name=f"artifact-{port}", daemon=True)
    thread.start()

    _COUNTER += 1
    aid = f"a{_COUNTER}"
    try:
        rel = str(target.relative_to(root))
    except ValueError:
        rel = str(target)
    art = Artifact(id=aid, name=(name.strip() or target.stem or f"artifact {_COUNTER}"),
                   port=port, directory=str(directory), entry=entry, rel=rel,
                   _httpd=httpd, _thread=thread)
    with _LOCK:
        _REGISTRY[aid] = art
    return art


def registry() -> list[Artifact]:
    """Running artifacts, newest first."""
    with _LOCK:
        return sorted(_REGISTRY.values(), key=lambda a: a.started, reverse=True)


def get(aid: str) -> Artifact | None:
    return _REGISTRY.get(aid)


def stop(aid: str) -> bool:
    """Stop one artifact and free its port."""
    with _LOCK:
        art = _REGISTRY.pop(aid, None)
    if not art:
        return False
    try:
        art._httpd.shutdown()
        art._httpd.server_close()
    except Exception:
        pass
    return True


def stop_all() -> None:
    for aid in list(_REGISTRY):
        stop(aid)


atexit.register(stop_all)
