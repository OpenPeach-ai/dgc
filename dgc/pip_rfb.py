"""The Pip's own hands and eyes on its whole desktop: a small VNC (RFB 3.8) client of the desktop's own screen.

A Pip computer's desktop is a VNC display (Xtigervnc) that listens on one Unix socket in the computer's
private runtime folder (pip_screen.Desktop.vnc_socket); on a Mac, the socket its VM publishes. The user's live
view reaches it through DGC's filter (pip_screen.splice), which marks the user's own input. The Pip's input
arrives here instead, on a connection of its own: the server types and moves the pointer for it exactly as
for a viewer (Xvnc turns each key symbol into a key press, adding one to its keymap when it has none, so any
character types), and its input is never the user's.

Only the socket a Desktop names is ever opened: never ``$DISPLAY``, never the computer's own screen.
"""
from __future__ import annotations

import socket
import struct
import time
from pathlib import Path

MAX_SIDE = 8192
READ_SECONDS = 10.0

# X key symbols for the names a model uses ("ctrl+s", "alt+tab", "Enter").
KEYSYMS = {
    "enter": 0xFF0D, "return": 0xFF0D, "tab": 0xFF09, "escape": 0xFF1B, "esc": 0xFF1B, "backspace": 0xFF08,
    "delete": 0xFFFF, "del": 0xFFFF, "insert": 0xFF63, "home": 0xFF50, "end": 0xFF57, "pageup": 0xFF55,
    "page_up": 0xFF55, "pgup": 0xFF55, "pagedown": 0xFF56, "page_down": 0xFF56, "pgdn": 0xFF56,
    "left": 0xFF51, "up": 0xFF52, "right": 0xFF53, "down": 0xFF54, "arrowleft": 0xFF51, "arrowup": 0xFF52,
    "arrowright": 0xFF53, "arrowdown": 0xFF54, "space": 0x0020, "menu": 0xFF67, "printscreen": 0xFF61,
    "print": 0xFF61, "capslock": 0xFFE5,
    **{f"f{n}": 0xFFBD + n for n in range(1, 13)},
}
MODIFIERS = {"ctrl": 0xFFE3, "control": 0xFFE3, "shift": 0xFFE1, "alt": 0xFFE9, "option": 0xFFE9,
             "super": 0xFFEB, "win": 0xFFEB, "meta": 0xFFEB, "cmd": 0xFFEB, "command": 0xFFEB}
BUTTONS = {"left": 1, "middle": 2, "right": 4}
WHEEL = {"up": 8, "down": 16, "left": 32, "right": 64}


class RFBError(OSError):
    """The desktop's screen could not be reached or answered something DGC can't follow."""


def keysym_for(ch: str) -> int:
    """The X key symbol that types one character: Latin-1 as itself, anything else as its Unicode symbol."""
    code = ord(ch)
    if ch == "\n":
        return 0xFF0D
    if ch == "\t":
        return 0xFF09
    if 0x20 <= code <= 0x7E or 0xA0 <= code <= 0xFF:
        return code
    return 0x01000000 | code


def parse_keys(combo: str) -> list[int]:
    """"ctrl+shift+t" -> the symbols to hold, in order, the last one the key itself. A letter with shift held is
    sent as the capital, the way a keyboard makes it (and the way apps' shortcuts name it)."""
    text = str(combo or "").strip()
    if not text or len(text) > 64:
        raise ValueError("name a key, such as Enter, ctrl+s or alt+tab")
    if len(text) == 1:
        return [keysym_for(text)]
    parts = [p.strip() for p in text.replace(" ", "").split("+")]
    if text.endswith("++"):
        parts = parts[:-2] + ["+"]
    if not parts or any(not p for p in parts):
        raise ValueError(f"{combo!r} is not a key: use names like ctrl+s, alt+tab, Enter or F5")
    *mods, key = parts
    out = []
    for mod in mods:
        sym = MODIFIERS.get(mod.lower())
        if sym is None:
            raise ValueError(f"{mod!r} is not a modifier: use ctrl, shift, alt or super")
        if sym not in out:
            out.append(sym)
    lower = key.lower()
    if lower in MODIFIERS and not mods:
        return [MODIFIERS[lower]]
    if lower in KEYSYMS:
        out.append(KEYSYMS[lower])
    elif len(key) == 1:
        ch = key.upper() if MODIFIERS["shift"] in out and key.isalpha() else (key.lower() if mods else key)
        out.append(keysym_for(ch))
    else:
        raise ValueError(f"{key!r} is not a key: use names like Enter, Tab, Escape, F5 or a single character")
    return out


class Screen:
    """One connection to a desktop's VNC socket: its framebuffer, and the Pip's pointer and keys."""

    def __init__(self, path: Path, *, timeout: float = READ_SECONDS):
        self.path = Path(path)
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        try:
            self.sock.connect(str(self.path))
            self._handshake()
        except (OSError, struct.error, ValueError) as error:
            self.close()
            raise RFBError(f"the computer's screen did not answer ({error})") from error
        self.buttons = 0
        self.x = self.y = 0

    # -- the protocol ----------------------------------------------------------------------------

    def _exact(self, size: int) -> bytes:
        data = bytearray()
        while len(data) < size:
            chunk = self.sock.recv(min(1 << 20, size - len(data)))
            if not chunk:
                raise RFBError("the computer's screen closed the connection")
            data += chunk
        return bytes(data)

    def _handshake(self) -> None:
        version = self._exact(12)
        if not version.startswith(b"RFB 003."):
            raise RFBError("the computer's screen is not a VNC display")
        self.sock.sendall(b"RFB 003.008\n")
        count = self._exact(1)[0]
        if count == 0:
            size = struct.unpack(">I", self._exact(4))[0]
            raise RFBError("the computer's screen refused: " + self._exact(min(size, 400)).decode("latin-1"))
        types = self._exact(count)
        if 1 not in types:
            raise RFBError("the computer's screen asks for a password DGC does not have")
        self.sock.sendall(b"\x01")
        if struct.unpack(">I", self._exact(4))[0] != 0:
            raise RFBError("the computer's screen refused the connection")
        self.sock.sendall(b"\x01")                      # shared: the user's live view stays connected
        head = self._exact(24)
        self.width, self.height = struct.unpack(">HH", head[:4])
        name_length = struct.unpack(">I", head[20:24])[0]
        self.name = self._exact(min(name_length, 4096)).decode("utf-8", "replace")
        if not (0 < self.width <= MAX_SIDE and 0 < self.height <= MAX_SIDE):
            raise RFBError("the computer's screen has an impossible size")
        # 32 bits a pixel, little-endian, so each pixel arrives as blue, green, red, unused.
        self.sock.sendall(struct.pack(">B3xBBBBHHHBBB3x", 0, 32, 24, 0, 1, 255, 255, 255, 16, 8, 0))
        self.sock.sendall(struct.pack(">BxHi", 2, 1, 0))  # raw pixels only

    def _skip_message(self, kind: int) -> None:
        """A server message other than a screen update: read past it."""
        if kind == 1:                                   # SetColourMapEntries
            _, _, count = struct.unpack(">BHH", self._exact(5))
            self._exact(6 * count)
        elif kind == 2:                                 # Bell
            pass
        elif kind == 3:                                 # ServerCutText (its length is negative when extended)
            size = struct.unpack(">3xi", self._exact(7))[0]
            remaining = abs(size)
            while remaining:
                remaining -= len(self._exact(min(remaining, 1 << 20)))
        else:
            raise RFBError(f"the computer's screen sent a message DGC can't read ({kind})")

    def grab(self) -> tuple[int, int, bytes]:
        """The whole screen now: (width, height, pixels as blue-green-red-unused bytes, row by row)."""
        frame = bytearray(self.width * self.height * 4)
        self.sock.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, self.width, self.height))
        deadline = time.monotonic() + READ_SECONDS
        while time.monotonic() < deadline:
            kind = self._exact(1)[0]
            if kind != 0:
                self._skip_message(kind)
                continue
            count = struct.unpack(">xH", self._exact(3))[0]
            for _ in range(count):
                x, y, w, h, encoding = struct.unpack(">HHHHi", self._exact(12))
                if encoding != 0:
                    raise RFBError(f"the computer's screen sent pixels DGC did not ask for ({encoding})")
                if x + w > self.width or y + h > self.height:
                    raise RFBError("the computer's screen sent pixels outside it")
                row = w * 4
                data = self._exact(row * h)
                for line in range(h):
                    start = ((y + line) * self.width + x) * 4
                    frame[start:start + row] = data[line * row:(line + 1) * row]
            return self.width, self.height, bytes(frame)
        raise RFBError("the computer's screen did not send a picture in time")

    # -- the Pip's hands ---------------------------------------------------------------------------

    def _clamp(self, x: float, y: float) -> tuple[int, int]:
        return max(0, min(self.width - 1, int(round(x)))), max(0, min(self.height - 1, int(round(y))))

    def _pointer(self, buttons: int, x: float, y: float) -> None:
        self.x, self.y = self._clamp(x, y)
        self.buttons = buttons & 0xFF
        self.sock.sendall(struct.pack(">BBHH", 5, self.buttons, self.x, self.y))

    def move(self, x: float, y: float) -> None:
        self._pointer(self.buttons, x, y)

    def click(self, x: float, y: float, *, button: str = "left", count: int = 1) -> None:
        mask = BUTTONS.get(button, 1)
        self.move(x, y)
        time.sleep(0.03)
        for _ in range(max(1, min(int(count), 3))):
            self._pointer(mask, x, y)
            time.sleep(0.03)
            self._pointer(0, x, y)
            time.sleep(0.06)

    def drag(self, x1: float, y1: float, x2: float, y2: float, *, steps: int = 16, button: str = "left") -> None:
        """Press at one point, move there in real steps, let go at the other."""
        mask = BUTTONS.get(button, 1)
        steps = max(2, min(int(steps), 60))
        self.move(x1, y1)
        time.sleep(0.05)
        self._pointer(mask, x1, y1)
        time.sleep(0.08)
        for step in range(1, steps + 1):
            self._pointer(mask, x1 + (x2 - x1) * step / steps, y1 + (y2 - y1) * step / steps)
            time.sleep(0.02)
        time.sleep(0.06)
        self._pointer(0, x2, y2)

    def scroll(self, x: float, y: float, notches: int, *, sideways: bool = False) -> None:
        """Turn the wheel at a point: positive is down (or right), negative up (or left)."""
        if not notches:
            return
        wheel = WHEEL[("right" if notches > 0 else "left") if sideways else ("down" if notches > 0 else "up")]
        self.move(x, y)
        for _ in range(min(abs(int(notches)), 30)):
            self._pointer(wheel, x, y)
            self._pointer(0, x, y)
            time.sleep(0.02)

    def key(self, sym: int, down: bool) -> None:
        self.sock.sendall(struct.pack(">BBxxI", 4, 1 if down else 0, sym & 0xFFFFFFFF))

    def press(self, combo: str) -> None:
        """A key or a shortcut: every key held in order, then let go in reverse."""
        syms = parse_keys(combo)
        try:
            for sym in syms:
                self.key(sym, True)
                time.sleep(0.02)
        finally:
            for sym in reversed(syms):
                self.key(sym, False)
                time.sleep(0.01)

    def type_text(self, text: str) -> None:
        """Type into whatever has focus, a character at a time (Unicode too)."""
        for index, ch in enumerate(str(text)):
            sym = keysym_for(ch)
            self.key(sym, True)
            self.key(sym, False)
            if index % 8 == 7:
                time.sleep(0.01)

    def close(self) -> None:
        try:
            if getattr(self, "buttons", 0):
                self.sock.sendall(struct.pack(">BBHH", 5, 0, self.x, self.y))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
