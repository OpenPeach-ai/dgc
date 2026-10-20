"""The windows on a Pip computer's desktop: a small X11 client of the desktop's own X server.

What the Pip lists, focuses and raises, and where the browser's window is when DGC blacks out its password
and card fields in a picture of the whole screen. It speaks the X protocol over the one socket a Pip desktop's
X server makes in the computer's private runtime folder (``<runtime>/x11/X1``, which the desktop box sees as
/tmp/.X11-unix): never ``$DISPLAY``, never /tmp/.X11-unix itself, so it cannot reach the computer's own screen.
Requests are only the ones read here plus one: asking the window manager to activate a window.
"""
from __future__ import annotations

import socket
import struct
from pathlib import Path

READ_SECONDS = 5.0
MAX_WINDOWS = 64
MAX_REPLY = 64 << 20


class X11Error(OSError):
    """The desktop's X server could not be reached, or answered with an error."""


def socket_path(x11_dir: Path, display: str = ":1") -> Path:
    """The X server's socket for a Pip desktop: inside its own runtime folder, never the system's."""
    x11_dir = Path(x11_dir)
    if x11_dir.resolve() == Path("/tmp/.X11-unix").resolve() or str(x11_dir).rstrip("/") == "/tmp/.X11-unix":
        raise X11Error("only a Pip desktop's own X socket is used, never this computer's screen")
    number = str(display).lstrip(":").split(".", 1)[0]
    if not number.isdigit():
        raise X11Error("not a display")
    return x11_dir / f"X{number}"


def _pad(n: int) -> int:
    return (4 - n % 4) % 4


class Display:
    """One connection to a Pip desktop's X server."""

    def __init__(self, path: Path, *, timeout: float = READ_SECONDS):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        self.sequence = 0
        self._atoms: dict[str, int] = {}
        try:
            self.sock.connect(str(path))
            self._setup()
        except (OSError, struct.error) as error:
            self.close()
            raise X11Error(f"the computer's desktop did not answer ({error})") from error

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # -- the wire ----------------------------------------------------------------------------------

    def _exact(self, size: int) -> bytes:
        data = bytearray()
        while len(data) < size:
            chunk = self.sock.recv(min(1 << 20, size - len(data)))
            if not chunk:
                raise X11Error("the computer's desktop closed the connection")
            data += chunk
        return bytes(data)

    def _setup(self) -> None:
        self.sock.sendall(struct.pack("<BxHHHH2x", 0x6C, 11, 0, 0, 0))
        head = self._exact(8)
        extra = self._exact(struct.unpack("<H", head[6:8])[0] * 4)
        if head[0] != 1:
            reason = extra[:head[1]].decode("latin-1", "replace") if head[0] == 0 else "it asks for a sign-in"
            raise X11Error(f"the computer's desktop refused DGC ({reason.strip()})")
        vendor_length = struct.unpack("<H", extra[16:18])[0]
        screens, formats = extra[20], extra[21]
        offset = 32 + vendor_length + _pad(vendor_length) + 8 * formats
        if screens < 1:
            raise X11Error("the computer's desktop has no screen")
        self.root = struct.unpack("<I", extra[offset:offset + 4])[0]
        self.width, self.height = struct.unpack("<HH", extra[offset + 20:offset + 24])

    def _send(self, opcode: int, data: int, body: bytes) -> int:
        body += b"\0" * _pad(len(body))
        self.sock.sendall(struct.pack("<BBH", opcode, data, 1 + len(body) // 4) + body)
        self.sequence = (self.sequence + 1) & 0xFFFF
        return self.sequence

    def _reply(self, sequence: int) -> bytes:
        """The reply to one request; events on the way are skipped, an error for it is raised."""
        while True:
            head = self._exact(32)
            kind = head[0]
            seq = struct.unpack("<H", head[2:4])[0]
            if kind == 0:
                if seq == sequence:
                    raise X11Error(f"the computer's desktop refused a request (X error {head[1]})")
                continue
            if kind == 1:
                length = struct.unpack("<I", head[4:8])[0] * 4
                if length > MAX_REPLY:
                    raise X11Error("the computer's desktop sent too much")
                body = self._exact(length) if length else b""
                if seq == sequence:
                    return head + body
                continue
            # An event: nothing here asked for any, but MappingNotify and the like reach every client.

    def _call(self, opcode: int, data: int, body: bytes) -> bytes:
        return self._reply(self._send(opcode, data, body))

    # -- requests ----------------------------------------------------------------------------------

    def atom(self, name: str, *, create: bool = False) -> int:
        if name not in self._atoms:
            raw = name.encode("latin-1")
            reply = self._call(16, 0 if create else 1, struct.pack("<H2x", len(raw)) + raw)
            self._atoms[name] = struct.unpack("<I", reply[8:12])[0]
        return self._atoms[name]

    def property(self, window: int, name: str, *, limit: int = 4096) -> tuple[int, int, bytes]:
        """(type, format, value) of a window's property; (0, 0, b"") when it has none."""
        prop = self.atom(name)
        if not prop:
            return 0, 0, b""
        reply = self._call(20, 0, struct.pack("<IIIII", window, prop, 0, 0, max(1, limit // 4)))
        fmt = reply[1]
        kind, _, length = struct.unpack("<III", reply[8:20])
        size = length * (fmt // 8) if fmt in (8, 16, 32) else 0
        return kind, fmt, reply[32:32 + size]

    def windows_property(self, window: int, name: str) -> list[int]:
        _, fmt, value = self.property(window, name, limit=4 * 1024)
        if fmt != 32:
            return []
        return list(struct.unpack(f"<{len(value) // 4}I", value[:len(value) // 4 * 4]))

    def text_property(self, window: int, *names: str) -> str:
        for name in names:
            _, fmt, value = self.property(window, name, limit=1024)
            if fmt == 8 and value:
                return value.decode("utf-8", "replace").replace("\0", " ").strip()
        return ""

    def geometry(self, window: int) -> tuple[int, int, int, int]:
        """(x, y, width, height) of a window on the screen."""
        reply = self._call(14, 0, struct.pack("<I", window))
        width, height = struct.unpack("<HH", reply[16:20])
        reply = self._call(40, 0, struct.pack("<IIhh", window, self.root, 0, 0))
        x, y = struct.unpack("<hh", reply[12:16])
        return x, y, width, height

    def viewable(self, window: int) -> bool:
        reply = self._call(3, 0, struct.pack("<I", window))
        return reply[26] == 2

    def activate(self, window: int) -> None:
        """Ask the window manager to show, raise and focus a window (as a taskbar does)."""
        event = struct.pack("<BBHII", 33, 32, 0, window, self.atom("_NET_ACTIVE_WINDOW", create=True))
        event += struct.pack("<IIIII", 2, 0, 0, 0, 0)
        mask = (1 << 19) | (1 << 20)                       # SubstructureNotify | SubstructureRedirect
        self._send(25, 0, struct.pack("<II", self.root, mask) + event)
        self.sync()

    def sync(self) -> None:
        """A round trip, so a request with no reply has been handled (or refused) before going on."""
        self._call(43, 0, b"")                            # GetInputFocus

    # -- the desktop -------------------------------------------------------------------------------

    def windows(self) -> list[dict]:
        """The app windows on the screen, bottom to top: id, title, app, x, y, width, height, shown, active."""
        stack = self.windows_property(self.root, "_NET_CLIENT_LIST_STACKING") or self.windows_property(
            self.root, "_NET_CLIENT_LIST")
        active = (self.windows_property(self.root, "_NET_ACTIVE_WINDOW") or [0])[0]
        skip = {self.atom(name) for name in ("_NET_WM_WINDOW_TYPE_DOCK", "_NET_WM_WINDOW_TYPE_DESKTOP")} - {0}
        hidden = self.atom("_NET_WM_STATE_HIDDEN")
        out = []
        for window in stack[-MAX_WINDOWS:]:
            try:
                if set(self.windows_property(window, "_NET_WM_WINDOW_TYPE")) & skip:
                    continue
                _, fmt, raw_class = self.property(window, "WM_CLASS", limit=512)
                parts = [p for p in raw_class.decode("latin-1", "replace").split("\0") if p] if fmt == 8 else []
                x, y, width, height = self.geometry(window)
                states = set(self.windows_property(window, "_NET_WM_STATE"))
                shown = self.viewable(window) and (not hidden or hidden not in states)
                # The window manager's frame around it (title bar, borders): left, right, top, bottom.
                frame = (self.windows_property(window, "_NET_FRAME_EXTENTS") + [0, 0, 0, 0])[:4]
                out.append({"id": f"0x{window:x}", "title": self.text_property(window, "_NET_WM_NAME", "WM_NAME")[:200],
                            "app": (parts[-1] if parts else "")[:80], "instance": (parts[0] if parts else "")[:80],
                            "x": x, "y": y, "width": width, "height": height, "shown": bool(shown),
                            "active": window == active, "frame": [min(int(v), 200) for v in frame]})
            except X11Error:
                continue                               # a window that closed while it was being read
        return out


def window_id(value) -> int:
    """A window id the Pip names ("0x1a00004"), as a number."""
    text = str(value or "").strip().lower()
    try:
        number = int(text, 16) if text.startswith("0x") else int(text)
    except ValueError:
        raise ValueError("name a window by its id from windows, such as 0x1a00004") from None
    if not 0 < number < 1 << 29:
        raise ValueError("name a window by its id from windows, such as 0x1a00004")
    return number
