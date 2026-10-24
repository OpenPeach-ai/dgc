"""Pips use the whole desktop (Pips API 54): eyes and hands on every window, the desktop's apps in boxes of their own
that reach public websites only through the computer's egress proxy, and secrets blacked out of a picture of the
whole screen."""
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_computer
from dgc import pip_computer_box as box
from dgc.workspace_registry import RegistryError

try:                                     # the modules this change adds: absent before it, so every test here fails
    from dgc import pip_apps, pip_desktop_eyes as eyes, pip_rfb, pip_x11
except ImportError:                      # pragma: no cover - the base commit
    pip_apps = eyes = pip_rfb = pip_x11 = None


# --------------------------------------------------------------------------- a fake VNC display

class FakeVNC:
    """A VNC server on a Unix socket: RFB 3.8, no security, one Raw frame, and a record of the client's input."""

    def __init__(self, folder: Path, width=64, height=40):
        self.path = Path(folder) / "vnc.sock"
        self.width, self.height = width, height
        self.events: list[tuple] = []
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(str(self.path))
        self.server.listen(8)
        threading.Thread(target=self._serve, daemon=True).start()

    def close(self):
        self.server.close()

    def _serve(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._one, args=(client,), daemon=True).start()

    def _one(self, client):
        def exact(n):
            data = b""
            while len(data) < n:
                chunk = client.recv(n - len(data))
                if not chunk:
                    raise EOFError
                data += chunk
            return data
        try:
            client.sendall(b"RFB 003.008\n")
            exact(12)
            client.sendall(b"\x01\x01")
            assert exact(1) == b"\x01"
            client.sendall(struct.pack(">I", 0))
            exact(1)
            name = b"fake"
            client.sendall(struct.pack(">HH", self.width, self.height) + bytes(16) + struct.pack(">I", len(name)) + name)
            while True:
                kind = exact(1)[0]
                if kind == 0:
                    self.events.append(("format", struct.unpack(">3xBBBBHHHBBB3x", exact(19))))
                elif kind == 2:
                    count = struct.unpack(">xH", exact(3))[0]
                    self.events.append(("encodings", struct.unpack(f">{count}i", exact(4 * count))))
                elif kind == 3:
                    exact(9)
                    # Two rectangles (top and bottom halves), and a Bell first, which the client reads past.
                    half = self.height // 2
                    client.sendall(b"\x02")
                    body = struct.pack(">BxH", 0, 2)
                    for top, h, colour in ((0, half, b"\x10\x20\x30\x00"), (half, self.height - half, b"\x40\x50\x60\x00")):
                        body += struct.pack(">HHHHi", 0, top, self.width, h, 0) + colour * (self.width * h)
                    client.sendall(body)
                elif kind == 4:
                    down, sym = struct.unpack(">BxxI", exact(7))
                    self.events.append(("key", down, sym))
                elif kind == 5:
                    buttons, x, y = struct.unpack(">BHH", exact(5))
                    self.events.append(("pointer", buttons, x, y))
                else:
                    return
        except (EOFError, OSError, AssertionError):
            pass
        finally:
            client.close()

    def of(self, kind):
        return [e for e in self.events if e[0] == kind]


class FakeX:
    """An X server on a Unix socket, just enough for pip_x11: setup, atoms, properties, geometry, a SendEvent."""

    def __init__(self, folder: Path, windows):
        self.dir = Path(folder) / "x11"
        self.dir.mkdir()
        self.path = self.dir / "X1"
        self.atoms = {}
        self.windows = windows                 # id -> dict(title, cls, x, y, w, h, viewable, type)
        self.sent = []
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(str(self.path))
        self.server.listen(4)
        threading.Thread(target=self._serve, daemon=True).start()

    def close(self):
        self.server.close()

    def atom(self, name):
        return self.atoms.setdefault(name, 100 + len(self.atoms))

    def _serve(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._one, args=(client,), daemon=True).start()

    def _one(self, client):
        def exact(n):
            data = b""
            while len(data) < n:
                chunk = client.recv(n - len(data))
                if not chunk:
                    raise EOFError
                data += chunk
            return data
        try:
            exact(12)
            vendor = b"fake"
            extra = struct.pack("<IIIIHHBBBBBBBB4x", 1, 0, 0, 0, len(vendor), 65535, 1, 0, 0, 0, 32, 32, 8, 255) + vendor
            screen = struct.pack("<IIIIIHHHHHHIBBBB", 1, 0, 0, 0, 0, 1280, 800, 300, 200, 1, 1, 0, 0, 0, 24, 0)
            extra += screen
            extra += b"\0" * ((4 - len(extra) % 4) % 4)
            client.sendall(struct.pack("<BxHHH", 1, 11, 0, len(extra) // 4) + extra)
            seq = 0
            while True:
                head = exact(4)
                opcode, data, length = struct.unpack("<BBH", head)
                body = exact(length * 4 - 4)
                seq = (seq + 1) & 0xFFFF
                reply = self._answer(opcode, data, body)
                if reply is not None:
                    extra_body = reply[1]
                    client.sendall(struct.pack("<BBHI", 1, reply[0], seq, len(extra_body) // 4 - 6 if len(extra_body) > 24 else 0)
                                   + extra_body[:24].ljust(24, b"\0") + extra_body[24:])
        except (EOFError, OSError):
            pass
        finally:
            client.close()

    def _answer(self, opcode, data, body):
        if opcode == 16:                                   # InternAtom
            size = struct.unpack("<H", body[:2])[0]
            return 0, struct.pack("<I", self.atom(body[4:4 + size].decode()))
        if opcode == 20:                                   # GetProperty
            window, prop = struct.unpack("<II", body[:8])
            name = next((k for k, v in self.atoms.items() if v == prop), "")
            value, fmt = self._property(window, name)
            unit = fmt // 8 if fmt else 1
            payload = struct.pack("<IIi", 0, 0, len(value) // unit) + bytes(12) + value
            payload += b"\0" * ((4 - len(payload) % 4) % 4)
            return fmt, payload
        if opcode == 14:                                   # GetGeometry
            w = self.windows[struct.unpack("<I", body[:4])[0]]
            return 24, struct.pack("<IhhHHH", 1, 0, 0, w["w"], w["h"], 0)
        if opcode == 40:                                   # TranslateCoordinates
            w = self.windows[struct.unpack("<I", body[:4])[0]]
            return 1, struct.pack("<Ihh", 0, w["x"], w["y"])
        if opcode == 3:                                    # GetWindowAttributes
            w = self.windows[struct.unpack("<I", body[:4])[0]]
            return 0, bytes(18) + bytes([2 if w.get("viewable", True) else 0]) + bytes(17)
        if opcode == 25:                                   # SendEvent: no reply
            self.sent.append(body)
            return None
        if opcode == 43:                                   # GetInputFocus
            return 0, struct.pack("<I", 1)
        raise EOFError

    def _property(self, window, name):
        if window == 1 and name in ("_NET_CLIENT_LIST_STACKING", "_NET_CLIENT_LIST"):
            ids = list(self.windows)
            return struct.pack(f"<{len(ids)}I", *ids), 32
        if window == 1 and name == "_NET_ACTIVE_WINDOW":
            active = next((i for i, w in self.windows.items() if w.get("active")), 0)
            return struct.pack("<I", active), 32
        w = self.windows.get(window)
        if w is None:
            return b"", 0
        if name == "_NET_WM_NAME":
            return w["title"].encode(), 8
        if name == "WM_CLASS":
            return w["cls"].encode() + b"\0", 8
        if name == "_NET_WM_WINDOW_TYPE" and w.get("type"):
            return struct.pack("<I", self.atom(w["type"])), 32
        if name == "_NET_FRAME_EXTENTS" and w.get("frame"):
            return struct.pack("<4I", *w["frame"]), 32
        return b"", 0


def window(id_, title, app, x, y, w, h, shown=True, active=False, frame=(0, 0, 0, 0)):
    return {"id": id_, "title": title, "app": app, "instance": app.lower(), "x": x, "y": y, "width": w, "height": h,
            "shown": shown, "active": active, "frame": list(frame)}


class Temp(unittest.TestCase):
    def setUp(self):
        if eyes is None:
            self.fail("Pips use the whole desktop: dgc.pip_desktop_eyes, pip_rfb, pip_x11 and pip_apps are missing")
        temp = tempfile.TemporaryDirectory(prefix="pwd-")
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)


# --------------------------------------------------------------------------- the hands (VNC)

class HandsTests(Temp):
    def test_the_pip_grabs_the_screen_and_its_clicks_drags_and_keys_reach_it(self):
        vnc = FakeVNC(self.dir)
        self.addCleanup(vnc.close)
        with pip_rfb.Screen(vnc.path) as screen:
            width, height, pixels = screen.grab()
            self.assertEqual((width, height, len(pixels)), (64, 40, 64 * 40 * 4))
            self.assertEqual(pixels[:4], b"\x10\x20\x30\x00")
            self.assertEqual(pixels[-4:], b"\x40\x50\x60\x00")
            screen.click(10, 12, count=2)
            screen.drag(1, 1, 30, 20, steps=10)
            screen.click(5, 5, button="right")
            screen.scroll(5, 5, -2)
            screen.press("ctrl+shift+t")
            screen.type_text("Hi ₹\n")
        time.sleep(0.3)
        fmt = vnc.of("format")[0][1]
        self.assertEqual(fmt[:4], (32, 24, 0, 1), "32 bits a pixel, true colour")
        self.assertEqual(vnc.of("encodings")[0][1], (0,), "raw pixels only")
        pointer = vnc.of("pointer")
        presses = [e for e in pointer if e[1] == 1 and (e[2], e[3]) == (10, 12)]
        self.assertEqual(len(presses), 2, "a double click is two presses at the point")
        dragged = [e for e in pointer if e[1] == 1 and (e[2], e[3]) not in ((10, 12),)]
        self.assertGreaterEqual(len(dragged), 10, "a drag moves in real steps while the button is held")
        self.assertEqual((dragged[-1][2], dragged[-1][3]), (30, 20))
        self.assertIn(("pointer", 4, 5, 5), pointer, "a right click is button 3")
        self.assertEqual([e[1] for e in pointer if e[1] in (8, 16)], [8, 8], "two notches of the wheel, up")
        keys = vnc.of("key")
        self.assertEqual(keys[:6], [("key", 1, 0xFFE3), ("key", 1, 0xFFE1), ("key", 1, ord("T")),
                                    ("key", 0, ord("T")), ("key", 0, 0xFFE1), ("key", 0, 0xFFE3)],
                         "a shortcut holds its modifiers, then lets go in reverse; with shift, the capital")
        typed = [e[2] for e in keys[6:] if e[1] == 1]
        self.assertEqual(typed, [ord("H"), ord("i"), 0x20, 0x010020B9, 0xFF0D], "Unicode types as its own key symbol")

    def test_a_key_the_pip_names_wrongly_is_refused_in_words(self):
        self.assertEqual(pip_rfb.parse_keys("Enter"), [0xFF0D])
        self.assertEqual(pip_rfb.parse_keys("alt+tab"), [0xFFE9, 0xFF09])
        self.assertEqual(pip_rfb.parse_keys("ctrl+s"), [0xFFE3, ord("s")])
        self.assertEqual(pip_rfb.parse_keys("F5"), [0xFFC2])
        for bad in ("", "hyper+x", "ctrl+", "ctrl+nonsense", "x" * 70):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                pip_rfb.parse_keys(bad)


# --------------------------------------------------------------------------- the windows (X11)

class WindowsTests(Temp):
    def test_the_open_windows_are_listed_and_one_is_brought_to_the_front(self):
        fake = FakeX(self.dir, {
            0x200001: {"title": "Untitled 1 — LibreOffice Draw", "cls": "libreoffice\0libreoffice-draw", "x": 0, "y": 25,
                       "w": 1280, "h": 701, "active": True, "frame": (1, 1, 24, 1)},
            0x300002: {"title": "dock", "cls": "tint2\0Tint2", "x": 0, "y": 728, "w": 1280, "h": 72,
                       "type": "_NET_WM_WINDOW_TYPE_DOCK"},
            0x400003: {"title": "bill.pdf", "cls": "evince\0Evince", "x": 10, "y": 20, "w": 600, "h": 600, "viewable": False},
        })
        self.addCleanup(fake.close)
        with pip_x11.Display(pip_x11.socket_path(fake.dir)) as display:
            self.assertEqual((display.width, display.height), (1280, 800))
            found = display.windows()
            display.activate(0x400003)
        self.assertEqual([w["id"] for w in found], ["0x200001", "0x400003"], "the dock is not a window to use")
        draw, pdf = found
        self.assertEqual((draw["title"], draw["app"], draw["x"], draw["y"], draw["width"], draw["height"], draw["active"]),
                         ("Untitled 1 — LibreOffice Draw", "libreoffice-draw", 0, 25, 1280, 701, True))
        self.assertEqual(draw["frame"], [1, 1, 24, 1])
        self.assertFalse(pdf["shown"], "a minimised window is listed, not shown")
        [sent] = fake.sent
        self.assertEqual(struct.unpack("<I", sent[:4])[0], 1, "sent to the root window, for the window manager")
        self.assertEqual(sent[8], 33, "a ClientMessage")
        self.assertEqual(struct.unpack("<I", sent[12:16])[0], 0x400003)
        listing = eyes.shown_windows(found)
        self.assertIn("0x200001 libreoffice-draw: Untitled 1 — LibreOffice Draw at 0,25 size 1280x701 (in front)", listing)
        self.assertIn("minimised: 0x400003 bill.pdf", listing)

    def test_only_a_pip_desktops_own_x_socket_is_ever_used(self):
        with self.assertRaises(pip_x11.X11Error):
            pip_x11.socket_path(Path("/tmp/.X11-unix"))
        self.assertEqual(pip_x11.socket_path(self.dir / "x11"), self.dir / "x11" / "X1")
        with patch.dict(os.environ, {"DISPLAY": ":0"}), self.assertRaises(pip_x11.X11Error):
            pip_x11.Display(self.dir / "x11" / "X1")        # nothing there: never falls back to $DISPLAY
        for bad in ("", "window", "0x0", "-1", "0x" + "f" * 12):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                pip_x11.window_id(bad)
        self.assertEqual(pip_x11.window_id("0x1a00004"), 0x1A00004)


# --------------------------------------------------------------------------- what is never shown

class FakeBrowser:
    def __init__(self, said, alive=True):
        self.said, self._alive, self.display_dir = said, alive, Path("/x")

    def alive(self):
        return self._alive

    def desktop_secrets(self):
        if isinstance(self.said, Exception):
            raise self.said
        return self.said


def chrome_said(**over):
    said = {"windows": [{"id": 7, "left": 0.0, "top": 0.0, "width": 1280.0, "height": 724.0, "state": "normal", "own": True}],
            "visible": True, "inner": [1272.0, 633.0], "ratio": 1.0, "boxes": [[124.0, 153.0, 308.0, 29.0]]}
    said.update(over)
    return said


class SecretsTests(Temp):
    CHROME = window("0x800003", "login.example - Chromium", "Chromium-browser", 0, 0, 1280, 724, active=True)

    def test_the_browsers_password_and_card_fields_are_placed_through_its_window(self):
        regions = eyes.secret_regions(FakeBrowser(chrome_said()), [self.CHROME])
        # The page starts below the toolbar (724 - 633 = 91) and inside the frame ((1280 - 1272) / 2 = 4).
        self.assertEqual(regions, {"0x800003": [(4 + 124 - 4, 91 + 153 - 4, 308 + 8, 29 + 8)]})

    def test_a_browser_window_dgc_cant_see_into_is_blacked_out_whole(self):
        other = window("0x900001", "Other window - Chromium", "Chromium-browser", 300, 100, 600, 500)
        regions = eyes.secret_regions(FakeBrowser(chrome_said()), [self.CHROME, other])
        self.assertEqual(regions["0x900001"], [(296, 96, 608, 508)], "another browser window: all of it")
        hidden = eyes.secret_regions(FakeBrowser(chrome_said(visible=False)), [self.CHROME])
        self.assertEqual(hidden["0x800003"], [(-4, -4, 1288, 732)], "another tab showing in its window: all of it")
        gone = eyes.secret_regions(FakeBrowser(None, alive=False), [self.CHROME])
        self.assertEqual(gone["0x800003"], [(-4, -4, 1288, 732)])
        broken = eyes.secret_regions(FakeBrowser(None), [])
        self.assertEqual(broken, {})

    def test_a_screen_whose_browser_window_cant_be_placed_is_never_sent(self):
        moved = window("0x800003", "x - Chromium", "Chromium-browser", 200, 0, 1000, 724)
        with self.assertRaises(eyes.DesktopError):
            eyes.secret_regions(FakeBrowser(chrome_said()), [moved])
        with self.assertRaises(eyes.DesktopError):
            eyes.secret_regions(FakeBrowser(RuntimeError("devtools gone")), [self.CHROME])

    def test_a_desktop_apps_password_dialog_is_blacked_out_but_a_page_called_login_is_not(self):
        dialog = window("0x500001", "Enter Password", "Soffice", 400, 300, 380, 160)
        doc = window("0x500002", "login-notes.odt — LibreOffice Writer", "libreoffice-writer", 0, 25, 1280, 700)
        regions = eyes.secret_regions(FakeBrowser(None, alive=False), [doc, dialog])
        self.assertEqual(list(regions), ["0x500001"])
        for title in ("Unlock Keyring", "Authentication required", "Set Password", "Enter your PIN"):
            self.assertTrue(eyes.SECRET_TITLE.search(title), title)
        for title in ("login.example - Chromium", "Pin the tab", "Birthday shirt.odg"):
            self.assertFalse(eyes.SECRET_TITLE.search(title), title)

    def test_a_window_in_front_of_a_blacked_out_one_is_shown_as_it_is(self):
        width, height = 40, 30
        pixels = bytearray(b"\x80\x80\x80\x00" * width * height)
        back = window("0xb", "x - Chromium", "Chromium-browser", 0, 0, 40, 30)
        front = window("0xf", "Draw", "libreoffice-draw", 10, 12, 20, 10, frame=(0, 0, 2, 0))
        count = eyes.black_out(pixels, width, height, {"0xb": [(0, 0, 40, 30)]}, [back, front])
        self.assertEqual(count, 1)
        at = lambda x, y: pixels[(y * width + x) * 4:(y * width + x) * 4 + 3]
        self.assertEqual(at(2, 2), b"\0\0\0", "the browser behind is black")
        self.assertEqual(at(15, 15), b"\x80\x80\x80", "the editor in front is untouched")
        self.assertEqual(at(15, 10), b"\x80\x80\x80", "and so is its title bar")
        lone = bytearray(b"\xff\xff\xff\x00" * 16)
        eyes.black_out(lone, 4, 4, [(1, 1, 2, 2)])
        self.assertEqual(lone[(1 * 4 + 1) * 4:(1 * 4 + 1) * 4 + 3], b"\0\0\0")

    def test_the_picture_is_a_real_png_and_the_ring_is_drawn(self):
        from dgc import image_views
        width, height = 50, 30
        pixels = bytearray(b"\x00\x00\x00\x00" * width * height)
        eyes.mark(pixels, width, height, (25, 15), (5, 5))
        made = eyes.png(width, height, pixels)
        self.assertEqual(image_views.parse_dimensions(made), (50, 30))
        ring = pixels[(15 * width + 34) * 4:(15 * width + 34) * 4 + 3]
        self.assertEqual(ring, bytes((30, 30, 230)), "red, as blue-green-red")


# --------------------------------------------------------------------------- the desktop's apps

class AppsTests(Temp):
    def system(self):
        return patch.object(pip_apps, "find", lambda key: {"source": "system"})

    def test_each_app_runs_in_its_own_box_online_only_through_the_egress_proxy_and_only_files(self):
        x11, folder, config = self.dir / "x11", self.dir / "Files", self.dir / ".apps"
        for path in (x11, folder, config):
            path.mkdir()
        egress, forwarder = self.dir / "egress.sock", self.dir / "forward.py"
        with self.system():
            for key in ("images", "documents", "pdf"):
                with self.subTest(app=key):
                    argv = pip_apps.box_argv(key, x11_dir=x11, files=folder, config=config, file="/home/pip/Files/a.pdf",
                                             egress=egress, forwarder=forwarder)
                    self.assertEqual(argv[:2], ["bwrap", "--unshare-all"])
                    self.assertNotIn("--share-net", argv, "no network of its own")
                    joined = " ".join(argv)
                    self.assertIn(f"--bind {egress} /run/dgc/egress.sock", joined, "its one way out: the egress proxy")
                    self.assertIn(f"--ro-bind {forwarder} /run/dgc/forward.py", joined)
                    self.assertIn("--setenv https_proxy http://127.0.0.1:8899", joined)
                    self.assertIn(f"--bind {x11} /tmp/.X11-unix", joined)
                    self.assertIn(f"--bind {folder} /home/pip/Files", joined)
                    self.assertIn(f"--bind {config} /home/pip/.config", joined)
                    self.assertNotIn(str(Path.home()), joined.replace(str(self.dir), ""))
                    self.assertTrue(any(a.startswith("/opt/apps/") for a in argv[argv.index("app"):]),
                                    "run from its own mount, not /usr's path")
                    self.assertEqual(argv[-1], "/home/pip/Files/a.pdf")
                    offline = pip_apps.box_argv(key, x11_dir=x11, files=folder, config=config)
                    self.assertFalse(any("egress" in a or "proxy" in a.lower() for a in offline), "no socket: no network")
        if pip_apps.find("images"):
            draw = " ".join(pip_apps.box_argv("images", x11_dir=x11, files=folder, config=config))
            self.assertIn("--draw", draw)
            self.assertIn("-env:UserInstallation=file:///home/pip/.config/libreoffice", draw)

    @unittest.skipUnless(box.box_runs()[0] if sys.platform.startswith("linux") else False, "needs bubblewrap")
    def test_an_app_reaches_the_web_only_through_the_egress_proxy(self):
        x11, folder, config = self.dir / "x11", self.dir / "Files", self.dir / ".apps"
        for path in (x11, folder, config):
            path.mkdir()
        # A stand-in for the computer's egress proxy: it records what reaches it and answers.
        egress = Path(tempfile.mkdtemp(prefix="pe-", dir="/tmp")) / "e.sock"
        self.addCleanup(lambda: egress.unlink(missing_ok=True))
        reached = []
        server = socket.socket(socket.AF_UNIX)
        server.bind(str(egress))
        server.listen(4)
        self.addCleanup(server.close)

        def serve():
            while True:
                try:
                    client, _ = server.accept()
                except OSError:
                    return
                with client:
                    reached.append(client.recv(4096).split(b"\r\n")[0].decode())
                    client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
        threading.Thread(target=serve, daemon=True).start()
        forwarder = self.dir / "forward.py"
        forwarder.write_text(box.FORWARDER)
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        with self.system(), patch.object(pip_apps, "EVINCE", Path("/usr/bin/env")):
            argv = pip_apps.box_argv("pdf", x11_dir=x11, files=folder, config=config, egress=egress, forwarder=forwarder)
        cut = len(argv) - 1 - argv[::-1].index("/opt/apps/evince")
        probe = ("import os, socket, urllib.request\n"
                 "for host, port in (('1.1.1.1', 443), ('127.0.0.1', %d)):\n"
                 "    try:\n        socket.create_connection((host, port), timeout=3); print('reached', host)\n"
                 "    except OSError:\n        print('refused', host)\n"
                 "try:\n    urllib.request.urlopen('https://example.com/', timeout=10)\nexcept Exception as e:\n"
                 "    print('proxy', type(e).__name__)\n" % port)
        # The probe runs in the same box, in the app's place, after the in-box relay starts.
        result = subprocess.run(argv[:cut] + ["/usr/bin/python3", "-c", probe], capture_output=True, text=True, timeout=60)
        out = result.stdout.split("\n")
        self.assertEqual(out[:2], ["refused 1.1.1.1", "refused 127.0.0.1"], "no direct way out, not even to this computer")
        self.assertEqual(reached, ["CONNECT example.com:443 HTTP/1.1"], "https goes to the egress proxy, which decides")

    def test_a_file_opens_only_from_files_and_never_through_a_link(self):
        folder = self.dir / "Files"
        (folder / "Downloads").mkdir(parents=True)
        (folder / "Downloads" / "bill.pdf").write_bytes(b"%PDF-1.4")
        (self.dir / "secret.txt").write_text("no")
        os.symlink(self.dir / "secret.txt", folder / "link.pdf")
        self.assertEqual(pip_apps.inside_path(folder, "Downloads/bill.pdf"), "/home/pip/Files/Downloads/bill.pdf")
        for bad in ("link.pdf", "../secret.txt", "Downloads", "nothing.pdf", ""):
            with self.subTest(bad=bad), self.assertRaises((ValueError, RegistryError)):
                pip_apps.inside_path(folder, bad)
        self.assertEqual(pip_apps.app_for("Downloads/bill.PDF"), "pdf")
        self.assertEqual(pip_apps.app_for("shirt.odg"), "images")
        self.assertEqual(pip_apps.app_for("letter.docx"), "documents")

    def test_libreoffice_opens_without_its_first_run_screens_and_never_follows_a_link(self):
        config = self.dir / ".apps"
        pip_apps.seed_settings(config)
        settings = (config / "libreoffice" / "user" / "registrymodifications.xcu").read_text()
        for name in ("ShowTipOfTheDay", "ooSetupLastVersion", "LastTimeDonateShown", "DisableMacrosExecution"):
            self.assertIn(name, settings)
        other = self.dir / "other"
        other.mkdir()
        (other / "libreoffice" / "user").mkdir(parents=True)
        target = self.dir / "elsewhere.xcu"
        os.symlink(target, other / "libreoffice" / "user" / "registrymodifications.xcu")
        pip_apps.seed_settings(other)
        self.assertFalse(target.exists(), "a link in its place is never written through")

    def test_the_one_offer_says_what_is_downloaded_and_how_big(self):
        state = {}
        missing = {"images", "documents", "pdf"}
        with patch.object(pip_apps, "find", lambda key: None if key in missing else {"source": "system"}), \
                patch.object(pip_apps, "LIBREOFFICE", self.dir / "no-libreoffice"), \
                patch.object(pip_apps, "_read_offer", lambda: dict(state)), \
                patch.object(pip_apps, "_write_offer", lambda **f: state.update(f)), \
                patch("dgc.pip_screen_setup.supported", lambda: (True, "")), \
                patch("dgc.pip_screen_setup.status", lambda: {"state": "ready", "error": ""}), \
                patch("dgc.pip_screen_setup.start", lambda needs: state.update(started=list(needs))), \
                patch("dgc.pip_screen_setup.wanted", lambda: ["libreoffice-draw", "evince"]):
            self.assertEqual(pip_apps.offer()["state"], "measuring", "nothing is asked before its size is known")
            self.assertTrue(pip_apps.needs_measure())
            pip_apps.record_measure({"libreoffice-draw": "1", "evince": "2"}, 83_456_789)
            offer = pip_apps.offer()
            self.assertEqual(offer["state"], "offer")
            self.assertEqual(offer["bytes"], 83_456_789)
            self.assertEqual(offer["line"], "Add an image editor, a document editor and a PDF viewer to this computer? DGC "
                                            "downloads Evince and LibreOffice from your system's own package servers into "
                                            "its own folder: 83 MB, once.")
            with self.assertRaises(RegistryError):
                pip_apps.answer("download", "device_" + "1" * 32)
            with self.assertRaises(RegistryError):
                pip_apps.answer("maybe", "editor-user")
            self.assertEqual(pip_apps.answer("download", "editor-user")["state"], "downloading")
            self.assertEqual(state["started"], ["libreoffice-draw", "evince"])
            state["answer"] = None
            self.assertEqual(pip_apps.answer("not_now", "editor-user")["state"], "declined", "it asks once")
        with patch.object(pip_apps, "find", lambda key: None if key == "images" else {"source": "system"}), \
                patch.object(pip_apps, "LIBREOFFICE", self.dir), \
                patch("dgc.pip_screen_setup.supported", lambda: (True, "")):
            (self.dir / "program").mkdir()
            (self.dir / "program" / "soffice").write_text("")
            offer = pip_apps.offer()
            self.assertEqual(offer["state"], "unavailable", "the system's own LibreOffice is never mixed with a download")
            self.assertIn("libreoffice-draw", offer["line"])

    @unittest.skipUnless(sys.platform.startswith("linux"), "the apps come with DGC's own desktop download, Linux with apt; "
                         "a Mac's computer is not offered them (docs/PIPS.md)")
    def test_the_setup_measures_the_apps_and_downloads_them_once_the_user_said_yes(self):
        from dgc import pip_screen_setup
        recorded = {}
        plan = "Inst libreoffice-draw (1:24.2 Ubuntu) []\nInst evince (46.3 Ubuntu) []\n"

        def fake_run(argv, **kwargs):
            if "-s" in argv:
                return subprocess.CompletedProcess(argv, 0, plan, "")
            return subprocess.CompletedProcess(argv, 0, "Size: 1000000\n", "")
        with patch.object(pip_apps, "wanted_packages", lambda keys=None: ["libreoffice-draw", "evince"]), \
                patch.object(pip_apps, "consented", lambda: False), \
                patch.object(pip_apps, "note_measuring", lambda: None), \
                patch.object(pip_apps, "record_measure", lambda packages, size: recorded.update(packages=packages, size=size)), \
                patch("dgc.pip_screen_setup.subprocess.run", fake_run):
            pip_screen_setup._measure_apps(["-o", "x=y"], [])
        self.assertEqual(recorded, {"packages": {"libreoffice-draw": "1:24.2", "evince": "46.3"}, "size": 2_000_000})
        with patch.object(pip_apps, "consented", lambda: True), \
                patch.object(pip_apps, "wanted_packages", lambda keys=None: ["evince"]), \
                patch("dgc.pip_screen.PROGRAMS", {}), patch("dgc.pip_computer_box._real_binary", lambda p: True):
            self.assertEqual(pip_screen_setup.wanted(), ["evince"])


# --------------------------------------------------------------------------- a run's steps on the desktop

JPEG = base64.b64decode("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////"
                        "////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=")


class FakeDesktop:
    def __init__(self, vnc, x11_dir):
        self.vnc_socket, self.x11_dir, self.opened = vnc.path, x11_dir, []

    def running(self):
        return True

    def open_in_desktop(self, what):
        self.opened.append(what)


class StepBrowser:
    def __init__(self):
        self.acted_at, self.current_url, self.display_dir = 0.0, "https://shop.example/", Path("/x")

    def alive(self):
        return False


def desktop_host(test, *, run_id="run_" + "a" * 32):
    folder = Path(tempfile.mkdtemp(dir=test.dir))
    vnc = FakeVNC(folder, 320, 200)
    test.addCleanup(vnc.close)
    x = FakeX(folder, {0x10: {"title": "shop - Chromium", "cls": "chromium-browser\0Chromium-browser", "x": 0, "y": 0, "w": 160, "h": 200},
                         0x20: {"title": "Untitled 1 — LibreOffice Draw", "cls": "libreoffice\0libreoffice-draw", "x": 160,
                                "y": 0, "w": 160, "h": 200, "active": True}})
    test.addCleanup(x.close)
    host = types.SimpleNamespace(desktop=FakeDesktop(vnc, x.dir), browser=StepBrowser(), desk_shot=(0.5, (320, 200)),
                                 frames_dir=test.dir, frames=0, pointer=None, _pointer_seq=0, waiting=[], run_id=run_id,
                                 lock=threading.RLock(), holds=[], card_note=None, root=test.dir)
    for name in ("_desktop", "_desk_look", "_desk_frame", "_show_desktop_pointer", "_held_text", "open_app"):
        setattr(host, name, getattr(pip_computer.Host, name).__get__(host))
    host._record_held = lambda: []
    return host, vnc


LINUX_DESKTOP = unittest.skipUnless(sys.platform.startswith("linux"), "the whole desktop is Linux only for now: on a Mac "
                                    "the screen is in the computer's VM, whose X server DGC can't reach (pip_desktop_eyes)")


class StepTests(Temp):
    def setUp(self):
        super().setUp()
        for target, value in (("jpeg", lambda picture, width, height, **kw: (JPEG, width // 2, height // 2)),
                              ("frame", lambda desktop, browser, pointer=None: (JPEG, 0.5))):
            started = patch.object(eyes, target, value)
            started.start()
            self.addCleanup(started.stop)

    @LINUX_DESKTOP
    def test_a_click_lands_where_the_pip_pointed_and_the_user_and_the_timeline_see_it(self):
        host, vnc = desktop_host(self)
        said = host._desktop("desktop_click", {"x": 100, "y": 50})
        time.sleep(0.2)
        # The picture was half the screen's size: (100, 50) there is (200, 100) on the screen, on the image editor.
        self.assertIn(("pointer", 1, 200, 100), vnc.of("pointer"))
        self.assertIn("Clicked at 100, 50 (Untitled 1 — LibreOffice Draw).", said["text"])
        self.assertEqual(base64.b64decode(said["image"]), JPEG)
        self.assertEqual((said["width"], said["height"]), (160, 100), "the new screen comes back, its size stated")
        self.assertIn("Your whole screen now (160x100 pixels)", said["text"])
        self.assertEqual((host.pointer["kind"], host.pointer["screen_x"], host.pointer["screen_y"], host.pointer["screen_width"]),
                         ("click_at", 200.0, 100.0, 320), "the live view draws the Pip's cursor on its screen")
        row = json.loads((self.dir / "index.jsonl").read_text().splitlines()[-1])
        self.assertEqual(sorted(row), ["at", "frame", "label", "pointer", "url"], "a timeline row an older editor reads")
        self.assertEqual(row["pointer"], {"kind": "click_at", "x": 100.0, "y": 50.0})
        self.assertEqual(host.browser.acted_at, 0.0, "a click on the image editor is not an action on the web page")
        host._desktop("desktop_click", {"x": 20, "y": 20})
        self.assertGreater(host.browser.acted_at, 0.0, "a click on the browser's window is: a submit it causes is held")

    @LINUX_DESKTOP
    def test_typing_keys_windows_focus_and_apps(self):
        host, vnc = desktop_host(self)
        typed = host._desktop("desktop_type", {"text": "Happy 30th, Arjun!"})
        self.assertIn("Typed 18 characters into the window in front.", typed["text"])
        self.assertIn("Pressed ctrl+s.", host._desktop("desktop_key", {"key": "ctrl+s"})["text"])
        self.assertTrue(host._desktop("desktop_key", {"key": "hyper+q"})["text"].startswith("error: "))
        self.assertIn("0x20 libreoffice-draw: Untitled 1 — LibreOffice Draw", host._desktop("windows", {})["text"])
        with patch.object(eyes, "activate", lambda desktop, window: setattr(host, "activated", window)):
            focused = host._desktop("focus_window", {"window": "0x10"})
        self.assertEqual(host.activated, 0x10)
        self.assertIn("Brought shop - Chromium to the front.", focused["text"])
        self.assertTrue(host._desktop("focus_window", {"window": "0x99"})["text"].startswith("error: no window 0x99"))
        opened = []
        host.open_app = lambda key, path=None: opened.append((key, path)) or "LibreOffice Draw"
        with patch.object(eyes, "windows", lambda desktop: []), patch.object(eyes, "wait_for_window", lambda d, before: True):
            said = host._desktop("launch_app", {"path": "Designs/shirt.odg"})
        self.assertEqual(opened, [("images", "Designs/shirt.odg")], "a file opens in the app that opens its kind")
        self.assertIn("Opened LibreOffice Draw.", said["text"])
        self.assertTrue(host._desktop("launch_app", {"app": "games"})["text"].startswith("error: say which app"))
        self.assertTrue(host._desktop("launch_app", {"app": "terminal", "path": "a.txt"})["text"].startswith("error: "))
        for bad in ({"x": 400, "y": 10}, {"x": "1", "y": 2}, {"x": True, "y": 1}):
            with self.subTest(bad=bad):
                self.assertTrue(host._desktop("desktop_click", bad)["text"].startswith("error: "))

    def test_typing_on_the_desktop_is_checked_like_typing_into_the_page_in_careful_mode(self):
        held = []
        host = types.SimpleNamespace(browser=types.SimpleNamespace(current_url="https://shop.example/cart"),
                                     taint=types.SimpleNamespace(carried=lambda text, said: ["from mail"] if "4417" in text else []),
                                     said="", sites=set())
        host._careful_hold = lambda kind, summary, text=None, carried=(): held.append((kind, summary["method"], text)) or "Held"
        self.assertEqual(pip_computer.Host._careful(host, "desktop_type", {"text": "order 4417"}), "Held")
        self.assertEqual(held, [("text", "TYPE", "order 4417")])
        self.assertIsNone(pip_computer.Host._careful(host, "desktop_type", {"text": "Happy birthday"}))


class SchemaTests(Temp):
    def test_the_desktop_steps_come_with_the_eyes_on_a_computer_that_shows_a_desktop(self):
        whole = pip_computer.schema("own", "pixels", desktop=True)["function"]
        ops = whole["parameters"]["properties"]["op"]["enum"]
        for op in eyes.DESKTOP_OPS:
            self.assertIn(op, ops)
        self.assertEqual(whole["parameters"]["properties"]["app"]["enum"], list(pip_computer.APP_KEYS))
        self.assertIn("launch_app opens app: images (an image editor, LibreOffice Draw)", whole["description"])
        for eyes_mode, desktop in (("own", False), (None, True), ("relay", False)):
            with self.subTest(eyes=eyes_mode, desktop=desktop):
                ops = pip_computer.schema(eyes_mode, "pixels", desktop=desktop)["function"]["parameters"]["properties"]["op"]["enum"]
                self.assertFalse(set(eyes.DESKTOP_OPS) & set(ops))
        relay = pip_computer.schema("relay", "thousandths", desktop=True)["function"]
        self.assertIn("desktop_look", relay["parameters"]["properties"]["op"]["enum"])
        self.assertIn("0-1000 across it", relay["description"])


# --------------------------------------------------------------------------- the worker

from tests import test_pip_eyes as eyes_tests          # noqa: E402
from tests import test_pips_local as fixtures            # noqa: E402


class WorkerTests(unittest.TestCase):
    setUp = eyes_tests.catalog_setup

    def run_turn(self, model, replies, *, sees=True, desktop=True, convention="pixels"):
        from dgc import pip_chat, pips
        from dgc.llm import ChatResult, LLMClient, ToolCall
        if eyes is None:
            self.fail("the desktop steps are missing")
        pip = self.store.create(self.registry.personal()["id"], "Tees", None, "editor-user", pip_type="lens",
                                model_choice={"mode": "model", "model": model}, computer_plan={"schema_version": 1})
        run = pip_chat.send(self.store, pip["id"], "Design my birthday shirt", "k1", "editor-user", self.cfg)["run"]
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        asked = []

        def act(op, args):
            asked.append((op, dict(args)))
            if op in ("desktop_look",) + eyes.DESKTOP_POINT_OPS:
                return {"text": f"Your whole screen now (1280x800 pixels) after {op}.", "image": base64.b64encode(JPEG).decode(),
                        "width": 1280, "height": 800}
            return {"text": "done"}
        socket_ = pip_computer.RunSocket(types.SimpleNamespace(act=act), "run_" + "c" * 32)
        self.addCleanup(socket_.close)
        manifest = {**raw, "computer_socket": {**socket_.pin(), **({"desktop": True} if desktop else {})},
                    "computer_eyes": {"choice": "ask", "vision_model": None, "convention": convention}}
        seen, queue = [], list(replies)

        def chat(client, messages, tools=None, **kwargs):
            seen.append({"messages": json.loads(json.dumps(messages, default=str)), "tools": tools})
            step = queue.pop(0)
            if isinstance(step, dict):
                return ChatResult(content="", tool_calls=[ToolCall(id=f"call_{len(seen)}", name="computer", arguments=step)])
            return ChatResult(content=step)
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.vision.has_vision", return_value=sees), \
                patch.object(LLMClient, "vision_supported", new=property(lambda self: sees)), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda e: None)
        return result, seen, asked

    def test_a_pip_that_sees_uses_the_whole_desktop(self):
        result, seen, asked = self.run_turn("qwen3-vl:8b", [
            {"op": "launch_app", "app": "images"}, {"op": "desktop_look"},
            {"op": "desktop_click", "x": 500, "y": 250}, "Done: your shirt design is in Files."], convention="thousandths")
        self.assertEqual(result["text"], "Done: your shirt design is in Files.")
        tool = next(t for t in seen[0]["tools"] if t["function"]["name"] == "computer")
        self.assertIn("desktop_click", tool["function"]["parameters"]["properties"]["op"]["enum"])
        system = json.dumps(seen[0]["messages"][0])
        self.assertIn("Your computer is a whole desktop", system)
        after_look = json.dumps(seen[2]["messages"])
        self.assertIn("your computer's screen (the whole desktop) after desktop_look (points are 0-1000 across it", after_look)
        self.assertEqual(asked[0], ("launch_app", {"app": "images"}))
        self.assertEqual(asked[2], ("desktop_click", {"x": 640.0, "y": 200.0}), "0-1000 across the desktop picture")

    def test_no_desktop_steps_without_a_desktop_or_without_eyes(self):
        _, seen, asked = self.run_turn("qwen3-vl:8b", [{"op": "desktop_look"}, "ok"], desktop=False)
        tool = next(t for t in seen[0]["tools"] if t["function"]["name"] == "computer")
        self.assertNotIn("desktop_look", tool["function"]["parameters"]["properties"]["op"]["enum"])
        self.assertNotIn("Your computer is a whole desktop", json.dumps(seen[0]["messages"][0]))
        self.assertEqual(asked, [], "a desktop step on a computer without one never reaches it")
        self.assertIn("shows no desktop here", json.dumps(seen[1]["messages"]))


# --------------------------------------------------------------------------- the real thing

def _desktop_ready():
    try:
        from dgc import pip_screen
        return (sys.platform.startswith("linux") and eyes is not None and pip_screen.availability()["available"]
                and box.capability().get("available"))
    except Exception:                     # noqa: BLE001
        return False


@unittest.skipUnless(_desktop_ready(), "needs Linux, bubblewrap, a Chromium and the desktop programs (or DGC_DESKTOP_PREFIX)")
class RealDesktopTests(unittest.TestCase):
    """End to end on a real Pip computer: its screen, its browser's secrets blacked out in a picture of all of it, an
    app in its own box, and the desktop's Terminal held to package sites."""

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.addCleanup(pip_computer.stop_all)
        self.server, _ = eyes_tests._serve()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        port = self.server.server_address[1]
        self.base = f"http://{eyes_tests.SHOP}:{port}"
        real = box.public_addresses
        policy = lambda host, p, **kw: ["127.0.0.1"] if host in (eyes_tests.SHOP, eyes_tests.PAY) and p == port else real(host, p, **kw)
        started = patch.object(box, "public_addresses", policy)
        started.start()
        self.addCleanup(started.stop)

    def brightness(self, host, jpeg, points):
        return host.browser.evaluate_json("""(async () => {
          const bin = atob(%s), bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const pic = await createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}));
          const c = new OffscreenCanvas(pic.width, pic.height), g = c.getContext('2d'); g.drawImage(pic, 0, 0);
          return %s.map(([x, y]) => { const d = g.getImageData(x, y, 1, 1).data; return Math.round((d[0] + d[1] + d[2]) / 3); });
        })()""" % (json.dumps(base64.b64encode(jpeg).decode()), json.dumps(points)))

    def test_a_real_desktop_its_secrets_an_app_and_the_terminal(self):
        pip = self.store.create(self.registry.personal()["id"], "Shirty", "Shirts", "local-console")
        proposal = self.store.propose(pip["id"], 1, {"computer_plan": {"schema_version": 1}}, "local-console")
        self.store.accept(pip["id"], proposal["id"], 1, "local-console")
        host = pip_computer.host_for(self.registry.directory, pip["id"], pip["workspace_id"])
        run = self.store.enqueue(pip["id"], "desk-" + str(time.monotonic_ns()), "local-console", self.cfg)
        host.begin(run["id"], self.base_dir() / "frames")
        self.assertTrue(host.ensure_desktop())
        self.assertFalse(host.act("open", {"url": self.base + "/"})["text"].startswith("error"))
        look = host.act("desktop_look", {})
        self.assertIn("Your whole screen now (1280x800 pixels)", look["text"], look["text"])
        picture = base64.b64decode(look["image"])
        offset = host.browser.screen_offset()
        centres = json.loads(host.browser.evaluate_json("JSON.stringify(['email','pw','cc'].map(id => {"
                                                         " const r = document.getElementById(id).getBoundingClientRect();"
                                                         " return [r.left + Math.min(r.width / 2, 60), r.top + r.height / 2]; }))"))
        light = self.brightness(host, picture, [[round(offset[0] + x), round(offset[1] + y)] for x, y in centres])
        self.assertGreater(light[0], 150, "the email field is shown")
        self.assertLess(light[1], 40, "the password is blacked out on the whole screen")
        self.assertLess(light[2], 40, "and the card number")
        from dgc import pip_apps
        if pip_apps.find("images") is not None:
            opened = host.act("launch_app", {"app": "images"})
            self.assertIn("Opened LibreOffice Draw.", opened["text"])
            listed = host.act("windows", {})["text"]
            self.assertIn("LibreOffice Draw", listed)
            if os.environ.get("DGC_TEST_DUMP"):
                Path(os.environ["DGC_TEST_DUMP"]).write_bytes(base64.b64decode(opened["image"]))
            draw = self.brightness(host, base64.b64decode(opened["image"]), [[500, 300], [1100, 450]])
            self.assertGreater(min(draw), 150, "the editor in front of the browser is not blacked out")
        said = host.act("launch_app", {"app": "terminal"})
        self.assertIn("Opened the Terminal.", said["text"])
        said = host.act("desktop_type", {"text": "curl -s -o page.html %s/ ; echo fetched\n" % self.base})
        self.assertIn("Typed", said["text"])
        page = Path(host.root) / "home" / "Files" / "page.html"
        deadline = time.monotonic() + 15
        while not (page.exists() and page.stat().st_size) and time.monotonic() < deadline:
            time.sleep(0.5)
        self.assertIn("pw", page.read_text(), "the desktop's Terminal is online through the computer's egress proxy")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_computer_actions WHERE pip_id=?",
                                                  (pip["id"],)).fetchone()[0], 0, "it sends without a card: only the browser holds")
        host.end()

    def base_dir(self):
        return Path(self.temp.name)
