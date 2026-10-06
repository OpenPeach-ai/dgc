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
MAX_SEND = 1024 * 1024             # what the viewer may send in one command, decoded


class DesktopStreams:
    """At most one stream per Pip in this `dgc serve`."""

    def __init__(self, emit, config):
        self.emit, self.config = emit, config
        self.lock = threading.Lock()
        self.streams: dict[str, socket.socket] = {}

    def handle(self, command: dict) -> None:
        pip_id, op = command.get("pip_id"), command.get("op")
        if not isinstance(pip_id, str) or not re.fullmatch(r"pip_[A-Za-z0-9]{1,64}", pip_id):
            return
        if op == "open":
            threading.Thread(target=self._open, args=(pip_id,), name="pip-desktop-open", daemon=True).start()
        elif op == "send":
            self._send(pip_id, command.get("data"))
        elif op == "close":
            self.close(pip_id, "closed")

    def _closed(self, pip_id: str, reason: str) -> None:
        self.emit("pip_desktop_closed", pip_id=pip_id, reason=reason[:300])

    def _open(self, pip_id: str) -> None:
        from . import pip_computer
        self.close(pip_id, "reopened", announce=False)
        try:
            with WorkspaceRegistry() as registry:
                pip_computer.request_open(registry, pip_id, "editor-user")
                deadline = time.monotonic() + OPEN_SECONDS
                endpoint = None
                while time.monotonic() < deadline:
                    endpoint = pip_computer.view_endpoint(registry, pip_id)
                    if endpoint is not None:
                        break
                    time.sleep(0.25)
            if endpoint is None:
                self._closed(pip_id, "The computer's screen did not open. Is the Pips runner on?")
                return
            stream = socket.socket(socket.AF_UNIX)
            stream.settimeout(30)
            stream.connect(endpoint["socket"])
            stream.sendall(json.dumps({"token": endpoint["token"], "op": "desktop"}).encode("utf-8") + b"\n")
            line = b""
            while not line.endswith(b"\n") and len(line) < 4096:
                chunk = stream.recv(1)
                if not chunk:
                    break
                line += chunk
            reply = json.loads(line.decode("utf-8") or "{}")
            if reply.get("ok") is not True:
                stream.close()
                self._closed(pip_id, str(reply.get("error") or "The computer's screen is not available."))
                return
        except (RegistryError, OSError, ValueError) as error:
            self._closed(pip_id, str(error) or "The computer's screen did not open.")
            return
        stream.settimeout(None)
        with self.lock:
            self.streams[pip_id] = stream
        threading.Thread(target=self._read, args=(pip_id, stream), name="pip-desktop-read", daemon=True).start()

    def _read(self, pip_id: str, stream: socket.socket) -> None:
        reason = "The computer's screen closed."
        try:
            while True:
                data = stream.recv(CHUNK)
                if not data:
                    break
                self.emit("pip_desktop_data", pip_id=pip_id, data=base64.b64encode(data).decode("ascii"))
        except OSError:
            pass
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
        with self.lock:
            stream = self.streams.get(pip_id)
        if stream is None:
            return
        try:
            stream.sendall(raw)
        except OSError:
            self.close(pip_id, "The computer's screen closed.")

    def close(self, pip_id: str, reason: str, *, announce: bool = True) -> None:
        with self.lock:
            stream = self.streams.pop(pip_id, None)
        if stream is None:
            return
        try:
            stream.close()
        except OSError:
            pass
        if announce:
            self._closed(pip_id, reason)

    def close_all(self) -> None:
        for pip_id in list(self.streams):
            self.close(pip_id, "closed", announce=False)
