"""`dgc serve` started to reopen a session that is still running: relay to it instead.

The editor starts the same `dgc serve` it always starts, the same way (the WSL route, the stderr
channel, the exit bookkeeping and the backend log are all unchanged), and sets two variables:

    DGC_ATTACH_SESSION   the session it wants back (the window's remembered chat, a tab's own)
    DGC_ATTACH           restore (a reload), auto (a session opened from a list), or steal (the
                         user pressed "Open here")

Before anything else of DGC's loads, this looks in the peer notes for a live `dgc serve` holding
that session with an attach socket. Found, with the same version: this process becomes a byte
relay -- it connects, sends one ``attach`` line, and pumps bytes both ways until either side
closes. The windowless process answers with a fresh ``ready``. Not found, refused, or unreachable:
this becomes a normal `dgc serve`, and the editor reopens the session from disk as it always did.

An older CLI ignores both variables. Both are removed from the environment here, so nothing a
normal serve starts -- above all a `dgc serve` a command runs -- inherits them.

The update rule (founder, 19 Oct 2026): a session still running in a different DGC version is
stopped (it saves first) and opened in this one, never attached to across versions. A window
showing it on screen is the exception: that window is never taken from.
"""
from __future__ import annotations

import os
import re
import selectors
import socket
import sys
import time

ATTACH_SESSION_ENV = "DGC_ATTACH_SESSION"
ATTACH_MODE_ENV = "DGC_ATTACH"
MODES = ("auto", "restore", "steal")
# A reload: the old window's panel may have spoken a moment ago (an extension host that was left
# running, Cursor's orphan), so an automatic attach waits this long for it to fall silent before
# showing the session read-only. Its renderer's silence is judged on 2 x 20s heartbeats.
RESTORE_WAIT_S = 45.0
_SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_refused: dict | None = None


def refused() -> dict | None:
    """Set when this process meant to reattach and was refused because a window shows the session:
    what ready.capabilities.detach.elsewhere tells the editor."""
    return dict(_refused) if _refused else None


def _note(text: str) -> None:
    try:
        sys.stderr.write(f"[dgc serve] {text}\n")
        sys.stderr.flush()
    except Exception:
        pass


def take_request(env=None) -> tuple[str, str] | None:
    env = os.environ if env is None else env
    session = str(env.pop(ATTACH_SESSION_ENV, "") or "").strip()
    mode = str(env.pop(ATTACH_MODE_ENV, "") or "").strip()
    if not _SESSION_ID.match(session):
        return None
    return session, (mode if mode in MODES else "auto")


def _stem(path) -> str:
    return os.path.splitext(os.path.basename(str(path or "")))[0]


def find_holder(session_id: str) -> dict | None:
    """The live `dgc serve` note holding ``session_id`` with an attach socket, or None."""
    from . import peers
    for record in peers.others(here=False):
        if record.get("kind") != "serve" or record.get("liveness") == "gone":
            continue
        if not record.get("socket") or not record.get("instance"):
            continue
        if any(place.get("session") and _stem(place["session"]) == session_id
               for place in peers._places(record)):
            return record
    return None


def run() -> int | None:
    """For `dgc serve`, before the CLI loads. An exit code when this process relayed, else None."""
    global _refused
    request = take_request()
    if request is None:
        return None
    from . import session_socket
    if not session_socket.supported():
        return None
    session_id, mode = request
    try:
        return _attach(session_id, mode)
    except Exception as exc:                 # a relay that cannot start is a normal serve
        _note(f"reattach skipped: {exc}")
        return None


def _attach(session_id: str, mode: str) -> int | None:
    global _refused
    from . import __version__, session_socket
    from .editor_protocol import PROTOCOL_VERSION
    deadline = time.monotonic() + (RESTORE_WAIT_S if mode == "restore" else 0.0)
    told_waiting = False
    while True:
        holder = find_holder(session_id)
        if holder is None:
            return None
        pid = holder.get("pid")
        if holder.get("version") != __version__ or holder.get("protocol_version") != PROTOCOL_VERSION:
            return _stop_older(holder, session_id, __version__)
        try:
            sock = session_socket.connect(str(holder["socket"]), expect_pid=pid, timeout=10.0)
        except OSError as exc:
            _note(f"reattach skipped: pid {pid}'s socket did not answer ({exc})")
            return None
        try:
            session_socket.send_line(sock, {
                "type": "attach", "instance": holder.get("instance"), "session": session_id,
                "mode": mode, "client": f"relay pid {os.getpid()}", "version": __version__,
                "protocol_version": PROTOCOL_VERSION})
            answer = session_socket.read_line(sock) or {}
        except OSError as exc:
            sock.close()
            _note(f"reattach skipped: pid {pid} did not answer ({exc})")
            return None
        if answer.get("type") == "attached":
            sock.settimeout(None)
            _note(f"reattached to dgc serve pid {pid}, which kept the session running")
            return pump(sock)
        sock.close()
        reason = str(answer.get("reason") or "")
        if reason == "on_screen" and time.monotonic() < deadline:
            if not told_waiting:
                _note(f"pid {pid} still shows this session in a window; waiting for it to go quiet")
                told_waiting = True
            time.sleep(2.0)
            continue
        if reason == "on_screen":
            _refused = {"session_id": session_id, "pid": pid, "reason": "on_screen"}
            _note(f"this session is open in another window (pid {pid}); showing it read-only here")
        else:
            _note(f"reattach skipped: pid {pid} said {reason or 'no'}")
        return None


def _stop_older(holder: dict, session_id: str, version: str) -> int | None:
    """Q7: a different DGC version still runs the session. Save and stop it, then this process opens
    the session as a normal serve. Never from a window that shows it."""
    global _refused
    from .serve_detach import stop_process
    pid = holder.get("pid")
    other = holder.get("version") or "an older DGC"
    stopped, what = stop_process(holder, reason=f"DGC {version} opening this session", wait_s=30.0,
                                 unless_on_screen=True)
    if stopped:
        _note(f"DGC {other} (pid {pid}) was still running this session; {what}. Opening it in DGC {version}.")
    elif "on screen" in what:
        _refused = {"session_id": session_id, "pid": pid, "reason": "on_screen", "version": str(other)}
        _note(f"DGC {other} (pid {pid}) shows this session in another window; showing it read-only here")
    else:
        _note(f"DGC {other} (pid {pid}) is still running this session and did not stop: {what}")
    return None


def pump(sock: socket.socket, stdin_fd: int = 0, stdout_fd: int = 1) -> int:
    """Bytes both ways until either side closes. The editor's end closing makes the backend
    windowless (it sees end of input on the socket); the backend's end closing ends this relay."""
    selector = selectors.DefaultSelector()
    selector.register(stdin_fd, selectors.EVENT_READ, "editor")
    selector.register(sock, selectors.EVENT_READ, "backend")
    try:
        while True:
            for key, _events in selector.select():
                if key.data == "editor":
                    try:
                        data = os.read(stdin_fd, 65536)
                    except InterruptedError:
                        continue
                    except OSError:
                        data = b""
                    if not data:
                        return 0
                    try:
                        sock.sendall(data)
                    except OSError:
                        return 0
                else:
                    try:
                        data = sock.recv(65536)
                    except InterruptedError:
                        continue
                    except OSError:
                        data = b""
                    if not data:
                        return 0
                    view = memoryview(data)
                    while view:
                        try:
                            written = os.write(stdout_fd, view)
                        except InterruptedError:
                            continue
                        except OSError:
                            return 0             # the editor has gone; closing tells the backend
                        view = view[written:]
    finally:
        selector.close()
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        sock.close()
