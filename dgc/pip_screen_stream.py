"""The editor's stream of a Pip computer's screen, carried by `dgc serve`.

The computer tab runs a VNC viewer; its bytes travel as base64 in `pip_desktop` commands and
`pip_desktop_data` events, so the editor never holds a socket, a path or the view's token. Here
they are joined to the supervisor's view socket (token-checked, op "desktop"), which joins them to
the desktop's own VNC socket through a filter that drops the user's input while a Pip run is at
the keyboard. Local only: the actor is always the editor on this computer.
"""
from __future__ import annotations

import base64
import json
import re
import socket
import threading
import time

from .workspace_registry import RegistryError, WorkspaceRegistry

OPEN_SECONDS = 20
CHUNK = 192 * 1024                 # one event carries at most this much of the screen (256 KiB base64)
GATHER_SECONDS = 0.004             # what comes this soon after goes in the same event
MAX_SEND = 1024 * 1024             # what the viewer may send in one command, decoded
MAX_OPENING = 8
MAX_STREAMS = 8


class DesktopStreams:
    """At most one stream per Pip in this `dgc serve`."""

    def __init__(self, emit, config):
        self.emit, self.config = emit, config
        self.lock = threading.Lock()
        self.streams: dict[str, socket.socket] = {}
        self._generation: dict[str, int] = {}
        self._opening = 0
        self._closed_all = False

    NOT_OPEN = "The computer's screen did not open. Is the Pips runner on?"
    ENDED = "The computer's screen closed."

    @staticmethod
    def _key_ok(key) -> bool:
        return isinstance(key, str) and re.fullmatch(r"pip_[A-Za-z0-9]{1,64}", key) is not None

    def handle(self, command: dict) -> None:
        pip_id, op = command.get("pip_id"), command.get("op")
        if not self._key_ok(pip_id):
            return
        if op == "open":
            # Which of its computers (capability pips_desktop_numbers; 1 for the first; none: the one at work, else
            # the first). One stream a Pip: opening another of its computers moves that Pip's stream to it.
            number = command.get("number")
            if number is not None and (type(number) is not int or not 1 <= number <= 1000):
                self._closed(pip_id, "That Pip has no such computer.")
                return
            with self.lock:
                if self._closed_all:
                    return
                if self._opening >= MAX_OPENING:
                    busy = True
                    old = None
                else:
                    busy = False
                    self._opening += 1
                    generation = self._generation.get(pip_id, 0) + 1
                    self._generation[pip_id] = generation
                    old = self.streams.pop(pip_id, None)
            if busy:
                self._closed(pip_id, "Too many computer screens are opening. Try again shortly.")
                return
            if old is not None:
                self._close_socket(old)
            def open_and_finish():
                try:
                    self._open(pip_id, generation, number)
                finally:
                    with self.lock:
                        self._opening -= 1
            try:
                threading.Thread(target=open_and_finish, name="pip-desktop-open", daemon=True).start()
            except RuntimeError:
                with self.lock:
                    self._opening -= 1
                self._closed(pip_id, "The computer's screen could not start.")
        elif op == "send":
            self._send(pip_id, command.get("data"))
        elif op == "close":
            self.close(pip_id, "closed")

    def _closed(self, pip_id: str, reason: str) -> None:
        self.emit("pip_desktop_closed", pip_id=pip_id, reason=reason[:300])

    def _refused(self, pip_id: str, reply: dict) -> None:
        self._closed(pip_id, str(reply.get("error") or "The computer's screen is not available."))

    def _data(self, pip_id: str, data: bytes) -> None:
        self.emit("pip_desktop_data", pip_id=pip_id, data=base64.b64encode(data).decode("ascii"))

    def _ask(self) -> dict:
        """What the view socket is asked, beside its token: a Pip computer's whole screen."""
        return {"op": "desktop"}

    def _endpoint(self, pip_id: str, generation: int, number: int | None):
        """The Pip computer's view socket ({socket, token}) once its screen is asked open; None if it never came (or
        the stream was closed meanwhile)."""
        from . import pip_computer
        with WorkspaceRegistry() as registry:
            pip_computer.request_open(registry, pip_id, "editor-user", number)
            deadline = time.monotonic() + OPEN_SECONDS
            while time.monotonic() < deadline:
                if not self._current(pip_id, generation):
                    return None
                endpoint = pip_computer.view_endpoint(registry, pip_id, number)
                if endpoint is not None:
                    return endpoint
                time.sleep(0.25)
        return None

    def _current(self, pip_id: str, generation: int) -> bool:
        with self.lock:
            return not self._closed_all and self._generation.get(pip_id) == generation

    @staticmethod
    def _close_socket(stream: socket.socket) -> None:
        try:
            stream.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            stream.close()
        except OSError:
            pass

    def _open(self, pip_id: str, generation: int, number: int | None = None) -> None:
        stream = None
        try:
            endpoint = self._endpoint(pip_id, generation, number)
            if endpoint is None:
                if self._current(pip_id, generation):
                    self._closed(pip_id, self.NOT_OPEN)
                return
            stream = socket.socket(socket.AF_UNIX)
            stream.settimeout(30)
            stream.connect(endpoint["socket"])
            stream.sendall(json.dumps({"token": endpoint["token"], **self._ask()}).encode("utf-8") + b"\n")
            line = b""
            while not line.endswith(b"\n") and len(line) < 4096:
                chunk = stream.recv(1)
                if not chunk:
                    break
                line += chunk
            reply = json.loads(line.decode("utf-8") or "{}")
            if reply.get("ok") is not True:
                self._close_socket(stream)
                stream = None
                if self._current(pip_id, generation):
                    self._refused(pip_id, reply)
                return
        except (RegistryError, OSError, ValueError, TypeError, KeyError) as error:
            if stream is not None:
                self._close_socket(stream)
            if self._current(pip_id, generation):
                self._closed(pip_id, str(error) or "The computer's screen did not open.")
            return
        stream.settimeout(None)
        with self.lock:
            if self._closed_all or self._generation.get(pip_id) != generation:
                stale = True
                crowded = False
            elif len(self.streams) >= MAX_STREAMS:
                stale = True
                crowded = True
            else:
                stale = False
                crowded = False
                self.streams[pip_id] = stream
        if stale:
            self._close_socket(stream)
            if crowded:
                self._closed(pip_id, "Too many computer screens are open. Close one and try again.")
            return
        threading.Thread(target=self._read, args=(pip_id, stream), name="pip-desktop-read", daemon=True).start()

    def _read(self, pip_id: str, stream: socket.socket) -> None:
        import select
        reason = self.ENDED
        try:
            ended = False
            waiting = select.poll()                # (never select: past 1024 open files it refuses a socket)
            waiting.register(stream.fileno(), select.POLLIN | select.POLLHUP | select.POLLERR)
            while not ended:
                data = stream.recv(CHUNK)
                if not data:
                    break
                # A screen's picture comes in many small writes: what follows within a few milliseconds goes in the same
                # event, so the editor gets fewer, larger messages (each one costs its own trip through the editor).
                while len(data) < CHUNK:
                    if not waiting.poll(GATHER_SECONDS * 1000):
                        break
                    more = stream.recv(CHUNK - len(data))
                    if not more:
                        ended = True
                        break
                    data += more
                self._data(pip_id, data)
        except (OSError, ValueError):
            pass
        finally:
            self._close_socket(stream)
        with self.lock:
            current = self.streams.get(pip_id)
            if current is stream:
                del self.streams[pip_id]
            else:
                return                     # replaced or closed on purpose: already announced
        self._closed(pip_id, reason)

    def _send(self, pip_id: str, data) -> None:
        if not isinstance(data, str) or len(data) > MAX_SEND * 4 // 3 + 4:
            return
        try:
            raw = base64.b64decode(data, validate=True)
        except ValueError:
            return
        if len(raw) > MAX_SEND:
            return
        with self.lock:
            stream = self.streams.get(pip_id)
        if stream is None:
            return
        try:
            stream.sendall(raw)
        except OSError:
            self.close(pip_id, self.ENDED)

    def close(self, pip_id: str, reason: str, *, announce: bool = True) -> None:
        with self.lock:
            self._generation[pip_id] = self._generation.get(pip_id, 0) + 1
            stream = self.streams.pop(pip_id, None)
        if stream is None:
            return
        self._close_socket(stream)
        if announce:
            self._closed(pip_id, reason)

    def close_all(self) -> None:
        with self.lock:
            self._closed_all = True
            streams = list(self.streams.values())
            self.streams.clear()
        for stream in streams:
            self._close_socket(stream)


class YourBrowserScreen(DesktopStreams):
    """Your Browser's own tab where this computer has no screen: ONE stream of Chrome's real window on its VNC screen,
    carried as a Pip computer's screen is (the same stream, the same viewer in the editor). Its bytes travel as base64
    in `your_browser_screen` commands and `your_browser_screen_data` events; here they are joined to the supervisor's view
    socket for Your Browser (token-checked, op "screen", own), which joins them to that screen's own socket. The editor
    never gets a socket, a path or the token, and only the person's own window is ever on that screen."""

    KEY = "your-browser"
    NOT_OPEN = "Your Browser isn't open yet. Open it from the dock."
    ENDED = "Your Browser's screen closed."

    @staticmethod
    def _key_ok(key) -> bool:
        return key == YourBrowserScreen.KEY

    def handle(self, command: dict) -> None:
        op = command.get("op")
        if op not in ("open", "send", "close"):
            return
        super().handle({"pip_id": self.KEY, "op": op, **({"data": command.get("data")} if op == "send" else {})})

    def _closed(self, key: str, reason: str, pictures: bool = False) -> None:
        self.emit("your_browser_screen_closed", reason=str(reason)[:300], pictures=bool(pictures))

    def _refused(self, key: str, reply: dict) -> None:
        self._closed(key, str(reply.get("error") or "Your Browser's screen is not available."), reply.get("pictures") is True)

    def _data(self, key: str, data: bytes) -> None:
        self.emit("your_browser_screen_data", data=base64.b64encode(data).decode("ascii"))

    def _ask(self) -> dict:
        return {"own": True, "op": "screen"}

    def _endpoint(self, key: str, generation: int, number: int | None):
        from . import your_browser
        with WorkspaceRegistry() as registry:
            deadline = time.monotonic() + OPEN_SECONDS
            while time.monotonic() < deadline:
                if not self._current(key, generation):
                    return None
                endpoint = your_browser.view_endpoint(registry)
                if endpoint is not None:
                    return endpoint
                time.sleep(0.25)
        return None
