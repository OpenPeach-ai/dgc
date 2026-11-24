"""Your Browser's own tab as fast as a Pip's computer (0.52, Pips API 112).

Where the computer DGC runs on has no screen (Remote-SSH, a server), Your Browser's Chrome runs as a real window on a
screen of its own. That screen is now the program a Pip's computer draws on (TigerVNC's Xtigervnc), and the editor's tab
shows it with the same viewer and the same stream a Pip's computer uses: pictures as they change, the person's own
mouse and keys straight to the screen, with no per-picture round trip. It is Chrome's real window: its tabs, address
bar, menus, dropdowns and password manager.

- The screen listens on ONE Unix socket in this user's private socket folder (mode 0600), never a port; the supervisor's
  view socket (token-checked) joins the editor's stream to it, as a Pip computer's is.
- Only the person's own window is on it: a Pip's lane (phase 2) opens in a window of its own, off the screen, and so does
  a page a lane opens. The person's own hand never reaches a lane from this tab.
- Where there is no VNC program it is as before (a plain virtual screen and pictures); where there IS a screen, the
  window beside the editor is the way, never this stream.

Unit tests drive the supervisor's host over the scripted DevTools pipe; the real test starts Chrome on a real Xtigervnc
and talks RFB to it through the view socket."""
from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import struct
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import your_browser
from tests.test_your_browser_own_tab import OwnHost, _installed_chrome, _OwnSite
from tests.test_your_browser_window import A

REPO = Path(__file__).resolve().parents[1]


class FakeScreen:
    def __init__(self):
        self.stopped = False

    def poll(self):
        return None if not self.stopped else 0

    def terminate(self):
        self.stopped = True

    def wait(self, timeout=None):
        return 0


class VncServer:
    """A stand-in for the screen's own socket: says the RFB greeting, then answers every byte it gets with "seen:"."""

    def __init__(self, path: Path):
        self.path = path
        self.got = []
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(str(path))
        self.server.listen(4)
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._one, args=(client,), daemon=True).start()

    def _one(self, client):
        with client:
            client.sendall(b"RFB 003.008\n")
            while True:
                try:
                    data = client.recv(4096)
                except OSError:
                    return
                if not data:
                    return
                self.got.append(data)
                client.sendall(b"seen:" + data)

    def close(self):
        self.server.close()


class ScreenProgram(unittest.TestCase):
    def test_the_screen_listens_on_one_private_unix_socket_and_never_a_port(self):
        temp = Path(tempfile.mkdtemp(prefix="yb-vnc-", dir="/tmp"))
        self.addCleanup(shutil.rmtree, temp, True)
        x11 = temp / "x11"
        x11.mkdir()
        started = []

        def popen(argv, **kw):
            started.append((argv, kw))
            number = argv[1].lstrip(":")
            (x11 / f"X{number}").touch()
            Path(argv[argv.index("-rfbunixpath") + 1]).touch()
            return FakeScreen()

        made = your_browser.start_vnc_screen((1000, 600), program=Path("/opt/desk/usr/bin/Xtigervnc"), popen=popen,
                                             folder=temp, x11=x11)
        self.assertIsNotNone(made)
        display, proc, sock = made
        argv, kw = started[-1]
        self.assertEqual(argv[0], "/opt/desk/usr/bin/Xtigervnc")
        self.assertEqual(argv[1], display)
        self.assertEqual(argv[argv.index("-rfbunixpath") + 1], str(sock))
        self.assertEqual(argv[argv.index("-rfbunixmode") + 1], "0600")
        self.assertEqual(argv[argv.index("-rfbport") + 1], "-1", "no TCP port at all")
        self.assertIn("tcp", argv[argv.index("-nolisten") + 1])
        self.assertEqual(argv[argv.index("-SecurityTypes") + 1], "None", "the socket itself is the door: this user's only")
        self.assertEqual(argv[argv.index("-geometry") + 1], f"{1000 * your_browser.VNC_SCALE}x{600 * your_browser.VNC_SCALE}")
        self.assertTrue(str(sock).startswith(str(temp)), "in the private socket folder")
        self.assertLess(len(str(sock)), 100, "a Unix socket path stays short")
        self.assertTrue(kw.get("start_new_session"))
        self.assertIn("-terminate", argv, "it ends with Chrome, even when nobody closes it")
        self.assertNotIn("OPENAI_API_KEY", kw.get("env", {}))

    def test_no_vnc_program_no_vnc_screen(self):
        with patch.object(your_browser, "vnc_program", return_value=None):
            self.assertIsNone(your_browser.start_vnc_screen((800, 600)))

    def test_the_program_is_the_pip_computers_own(self):
        with patch("dgc.pip_screen.components", return_value={"found": {"vnc": Path("/opt/x/Xtigervnc")}, "missing": []}):
            self.assertEqual(your_browser.vnc_program(), Path("/opt/x/Xtigervnc"))
        with patch("dgc.pip_screen.components", return_value={"found": {}, "missing": ["Xtigervnc"]}):
            self.assertIsNone(your_browser.vnc_program())


class OnTheScreen(OwnHost):
    """No screen here, a VNC program: Chrome's real window on a VNC screen of its own."""

    def setUp(self):
        super().setUp()
        self.sockets = Path(tempfile.mkdtemp(prefix="yb-s-", dir="/tmp"))
        self.addCleanup(shutil.rmtree, self.sockets, True)
        self.sock = self.sockets / "screen.vnc"
        self.screen = FakeScreen()
        self.host.which = lambda name: "/usr/bin/Xvfb" if name == "Xvfb" else None
        self.envs = []
        launch = self.host.launch
        self.host.launch = lambda argv, env, log: (self.envs.append(env), launch(argv, env, log))[1]
        self.vnc = patch.object(your_browser, "start_vnc_screen", side_effect=lambda size, **kw: (":151", self.screen, self.sock))
        self.vnc.start()
        self.addCleanup(self.vnc.stop)
        self.program = patch.object(your_browser, "vnc_program", return_value=Path("/opt/x/Xtigervnc"))
        self.program.start()
        self.addCleanup(self.program.stop)

    def test_chrome_draws_on_the_vnc_screen_and_the_host_knows_its_socket(self):
        self.host.open("https://example.com/", None, headless=True)
        argv = self.launched[-1]
        self.assertNotIn("--headless=new", argv)
        self.assertIn(f"--force-device-scale-factor={your_browser.VNC_SCALE}", argv, "a Pip computer's pixels: one each")
        self.assertEqual(self.envs[-1].get("DISPLAY"), ":151")
        self.assertEqual(self.host.screen_socket(), self.sock)
        self.host.close()
        self.assertTrue(self.screen.stopped, "its screen goes with it")
        self.assertIsNone(self.host.screen_socket())

    def test_without_the_vnc_program_it_is_the_plain_screen_and_pictures_as_before(self):
        self.program.stop()
        self.vnc.stop()
        with patch.object(your_browser, "vnc_program", return_value=None), \
                patch.object(your_browser, "start_vnc_screen", return_value=None), \
                patch.object(your_browser, "start_virtual_screen", lambda which: (":147", FakeScreen())):
            self.host.open("https://example.com/", None, headless=True)
        self.assertEqual(self.envs[-1].get("DISPLAY"), ":147")
        self.assertIsNone(self.host.screen_socket(), "pictures, as before")
        self.program.start()
        self.vnc.start()

    def test_without_the_vnc_program_it_fetches_the_pip_computers_and_is_its_screen_next_time(self):
        """The same screen as a Pip's computer everywhere: where its program isn't here yet, Your Browser starts the
        same download a Pip's computer does (no password, DGC's own folder) and shows pictures until it is there."""
        from dgc import pip_screen_setup
        self.program.stop()
        self.vnc.stop()
        started, back_on = [], False
        try:
            with patch.object(your_browser, "vnc_program", return_value=None), \
                    patch.object(your_browser, "start_vnc_screen", return_value=None), \
                    patch.object(your_browser, "start_virtual_screen", lambda which: (":147", FakeScreen())), \
                    patch.object(pip_screen_setup, "supported", return_value=(True, "")), \
                    patch.object(pip_screen_setup, "wanted", return_value=["tigervnc-standalone-server", "openbox"]), \
                    patch.object(pip_screen_setup, "start", side_effect=lambda needs: started.append(list(needs)) or True):
                self.host.open("https://example.com/", None, headless=True)
                self.assertEqual(started, [["tigervnc-standalone-server", "openbox"]], "the whole set a Pip's computer fetches")
                self.assertIsNone(self.host.screen_socket(), "pictures until it is there")
                self.host.close()
            with patch.object(pip_screen_setup, "supported", return_value=(True, "")), \
                    patch.object(pip_screen_setup, "wanted", return_value=[]), \
                    patch.object(pip_screen_setup, "start", side_effect=lambda needs: started.append(list(needs)) or True):
                self.program.start()
                self.vnc.start()
                back_on = True
                self.host.open("https://example.com/", None, headless=True)
                self.assertEqual(self.host.screen_socket(), self.sock, "next time, the Pip computer's screen")
                self.assertEqual(len(started), 1, "nothing fetched when it is here")
        finally:
            self.host.close()
            if not back_on:                         # (setUp's cleanups stop them once: started once, never twice)
                self.program.start()
                self.vnc.start()

    def test_where_the_download_cant_run_it_is_pictures_and_nothing_is_fetched(self):
        from dgc import pip_screen_setup
        self.program.stop()
        self.vnc.stop()
        try:
            with patch.object(your_browser, "vnc_program", return_value=None), \
                    patch.object(your_browser, "start_vnc_screen", return_value=None), \
                    patch.object(your_browser, "start_virtual_screen", lambda which: (":147", FakeScreen())), \
                    patch.object(pip_screen_setup, "supported", return_value=(False, "This Linux has no apt-get")), \
                    patch.object(pip_screen_setup, "start", side_effect=AssertionError("never")):
                self.host.open("https://example.com/", None, headless=True)
            self.assertIsNone(self.host.screen_socket())
        finally:
            self.host.close()
            self.program.start()
            self.vnc.start()

    def test_the_editor_tabs_size_fills_the_screen_with_chromes_window_and_casts_nothing(self):
        self.host.open("", None, headless=True)
        said = self.host.view_own("size", {"width": 1200, "height": 700})
        self.assertEqual(said["scale"], your_browser.VNC_SCALE, "the tab asks the screen for its size times this")
        bounds = [c["params"]["bounds"] for c in self.pipe.calls("Browser.setWindowBounds")]
        self.assertIn({"left": 0, "top": 0, "width": 1200, "height": 700}, bounds)
        self.assertEqual(self.pipe.calls("Page.startScreencast"), [], "the screen streams itself: no pictures to make")

    def test_the_screen_is_as_large_as_the_tab_and_chromes_whole_window_never_a_window_cut_off(self):
        """Chrome's window follows the tab where it can; it is never narrower than Chrome's own minimum, so in a tab
        narrower than that the screen stays as wide as the window (the tab scrolls to the rest, one to one), never the
        tab's width with Chrome's window running off its edge (24 Nov: "I can't scroll Your Browser horizontally")."""
        self.host.open("", None, headless=True)
        s = your_browser.VNC_SCALE
        said = self.host.view_own("size", {"width": 300, "height": 640})
        self.assertEqual(self.pipe.calls("Browser.setWindowBounds")[-1]["params"]["bounds"], {"left": 0, "top": 0, "width": 320, "height": 640},
                         "Chrome's window asked for the tab's size (as narrow as DGC takes)")
        self.assertEqual(said["screen"], {"width": self.pipe.MIN_WIDTH * s, "height": 640 * s}, "the whole window is on the screen")
        said = self.host.view_own("size", {"width": 1200, "height": 700})
        self.assertEqual(said["screen"], {"width": 1200 * s, "height": 700 * s}, "a wide tab: the screen is the tab's size")
        self.assertEqual(said["scale"], s)
        said = self.host.view_own("size", {"width": 700, "height": 100})
        self.assertEqual(said["screen"], {"width": 700 * s, "height": 240 * s}, "never shorter than DGC's least height")

    def test_where_chrome_doesnt_say_its_window_the_screen_is_the_tabs_size(self):
        self.host.open("", None, headless=True)
        send = self.pipe.send
        self.pipe.send = lambda payload: send({**payload, "method": "Browser.nothing"}) if payload.get("method") == "Browser.getWindowBounds" else send(payload)
        said = self.host.view_own("size", {"width": 900, "height": 600})
        self.assertEqual(said["screen"], {"width": 900 * your_browser.VNC_SCALE, "height": 600 * your_browser.VNC_SCALE})

    def test_without_its_screen_the_size_says_no_screen(self):
        self.host.open("", None, headless=True)
        self.host.screen_socket = lambda: None
        said = self.host.view_own("size", {"width": 900, "height": 600})
        self.assertNotIn("screen", said)
        self.assertNotIn("scale", said)

    def test_a_pips_lane_opens_in_a_window_of_its_own_off_the_screen(self):
        self.host.open("", None, headless=True)
        self.host.open_lane(A, "https://shop.example.com/", your_browser.Grants(["example.com"]))
        made = self.pipe.calls("Target.createTarget")[-1]["params"]
        self.assertTrue(made.get("newWindow"), "never a tab in the person's window, which this tab shows")
        self.assertTrue(made.get("background"))
        self.assertLess(made["left"] + made["width"], 0, "off the screen: nobody sees or drives it from this tab")

    def test_a_page_a_lane_opens_is_moved_off_the_screen(self):
        self.host.open("", None, headless=True)
        lane = self.host.open_lane(A, "https://shop.example.com/", your_browser.Grants(["example.com"]))
        self.pipe.attach("POP", "https://shop.example.com/popup", opener=lane)
        self.pump()
        self.pump()
        moves = [c["params"] for c in self.pipe.calls("Browser.setWindowBounds") if c["params"].get("bounds", {}).get("left", 0) < 0]
        self.assertTrue(moves, "the lane's popup window leaves the person's screen")
        # The person's own popup stays where they are.
        before = len(self.pipe.calls("Browser.setWindowBounds"))
        self.pipe.attach("MINE", "https://news.example.org/x", opener="P1")
        self.pump()
        self.pump()
        self.assertEqual(len(self.pipe.calls("Browser.setWindowBounds")), before)

    def test_a_lane_where_there_is_no_vnc_screen_is_a_window_of_its_own_off_chromes_screen_too(self):
        # (Phase 4: a tab in the background draws no new picture of itself after its first, Chrome 158: neither the
        # Watch nor the Pip's own steps could show it, so on any screen of Chrome's own a lane is a window of its own.)
        self.program.stop()
        self.vnc.stop()
        with patch.object(your_browser, "vnc_program", return_value=None), \
                patch.object(your_browser, "start_vnc_screen", return_value=None), \
                patch.object(your_browser, "start_virtual_screen", lambda which: (":147", FakeScreen())):
            self.host.open("", None, headless=True)
            self.host.open_lane(A, "https://shop.example.com/", your_browser.Grants(["example.com"]))
        made = self.pipe.calls("Target.createTarget")[-1]["params"]
        self.assertTrue(made.get("newWindow"))
        self.assertTrue(made.get("background"))
        self.assertLess(made["left"] + made["width"], 0)
        self.program.start()
        self.vnc.start()

    def test_only_on_a_screen_of_chromes_own_does_an_off_screen_window_count_as_shown(self):
        # Off its screen, Chrome counts a window as hidden: no pictures and no clicks for a Pip's lane there (checked
        # with Chrome 158 on Xvfb). Where Chrome is the person's own window on their desktop, nothing changes.
        own = your_browser.chrome_argv("/c", Path("/p"), headless=True, virtual=True)
        self.assertIn("--disable-backgrounding-occluded-windows", own)
        for kind in ({}, {"place": {"left": 0, "top": 0, "width": 900, "height": 800}}, {"headless": True}):
            with self.subTest(**kind):
                self.assertNotIn("--disable-backgrounding-occluded-windows", your_browser.chrome_argv("/c", Path("/p"), **kind))

    def test_while_the_tab_shows_the_screen_it_never_closes_for_being_idle(self):
        self.host.open("", None, headless=True)
        self.host.screen_opened()
        self.now[0] += your_browser.IDLE_SECONDS + 60
        self.host.tick(None)
        self.assertTrue(self.host.running(), "someone is looking at it")
        self.host.screen_closed()
        self.now[0] += your_browser.IDLE_SECONDS + 60
        self.host.tick(None)
        self.assertFalse(self.host.running())


class ViewSocketScreen(unittest.TestCase):
    """The supervisor's view socket joins the editor's stream to the screen's own socket: token, own, then RFB."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="yb-vs-", dir="/tmp"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.vnc = VncServer(self.dir / "screen.vnc")
        self.addCleanup(self.vnc.close)
        self.inputs = []
        self.host = types.SimpleNamespace(screen_socket=lambda: self.dir / "screen.vnc", opened=[0],
                                          screen_opened=lambda: self.host.opened.__setitem__(0, self.host.opened[0] + 1),
                                          screen_closed=lambda: self.host.opened.__setitem__(0, self.host.opened[0] - 1),
                                          person_input=lambda: self.inputs.append(1))
        with patch("dgc.pip_computer.socket_dir", return_value=self.dir):
            self.server = your_browser.ViewServer(self.host)
        self.addCleanup(self.server.close)

    def connect(self, request):
        client = socket.socket(socket.AF_UNIX)
        client.settimeout(5)
        client.connect(str(self.server.path))
        client.sendall(json.dumps(request).encode() + b"\n")
        line = b""
        while not line.endswith(b"\n"):
            chunk = client.recv(1)
            if not chunk:
                break
            line += chunk
        return client, json.loads(line or b"{}")

    def test_with_the_token_and_own_the_stream_is_the_screens(self):
        client, reply = self.connect({"token": self.server.token, "own": True, "op": "screen"})
        self.addCleanup(client.close)
        self.assertEqual(reply, {"ok": True})
        self.assertEqual(client.recv(12), b"RFB 003.008\n")
        client.sendall(b"RFB 003.008\n")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not self.vnc.got:
            time.sleep(0.02)
        self.assertEqual(b"".join(self.vnc.got), b"RFB 003.008\n")
        self.assertEqual(self.host.opened[0], 1, "the host knows someone is looking")

    def test_no_token_or_no_own_is_refused_and_never_reaches_the_screen(self):
        for request in ({"token": "nope", "own": True, "op": "screen"}, {"token": self.server.token, "op": "screen"},
                        {"token": self.server.token, "own": True, "op": "screen", "pip_id": A}):
            with self.subTest(request=request):
                client, reply = self.connect(request)
                client.close()
                self.assertFalse(reply.get("ok"))
        self.assertEqual(self.vnc.got, [])

    def test_with_no_vnc_screen_it_says_pictures(self):
        self.host.screen_socket = lambda: None
        client, reply = self.connect({"token": self.server.token, "own": True, "op": "screen"})
        client.close()
        self.assertEqual((reply["ok"], reply.get("pictures")), (False, True))

    def test_screen_is_never_an_op_the_editor_can_ask_by_command(self):
        self.assertNotIn("screen", your_browser.OWN_OPS)
        self.assertNotIn("screen", your_browser.VIEW_OPS)
        with self.assertRaises(your_browser.RegistryError):
            your_browser._check_view({"own": True, "op": "screen"})


class ServeStream(unittest.TestCase):
    """`dgc serve` joins Your Browser's tab to the supervisor's view socket: your_browser_screen in, its events out."""

    def setUp(self):
        from dgc import pip_screen_stream
        self.dir = Path(tempfile.mkdtemp(prefix="yb-ss-", dir="/tmp"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = self.dir / "view.sock"
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(str(self.path))
        self.server.listen(2)
        self.addCleanup(self.server.close)
        self.received, self.requests, self.answer = [], [], {"ok": True}

        def serve():
            while True:
                try:
                    client, _ = self.server.accept()
                except OSError:
                    return
                line = b""
                while not line.endswith(b"\n"):
                    line += client.recv(1)
                self.requests.append(json.loads(line))
                client.sendall(json.dumps(self.answer).encode() + b"\n")
                if not self.answer.get("ok"):
                    client.close()
                    continue
                client.sendall(b"RFB 003.008\n")
                while True:
                    data = client.recv(1024)
                    if not data:
                        break
                    self.received.append(data)
                client.close()
        threading.Thread(target=serve, daemon=True).start()
        self.events = []
        self.streams = pip_screen_stream.YourBrowserScreen(lambda kind, **fields: self.events.append((kind, fields)), {})
        self.addCleanup(self.streams.close_all)

    def wait(self, check, seconds=5):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not check():
            time.sleep(0.02)
        self.assertTrue(check())

    def test_the_tab_and_the_screen_talk_through_serve_events_and_the_token_stays_in_the_backend(self):
        with patch("dgc.pip_screen_stream.WorkspaceRegistry"), \
                patch.object(your_browser, "view_endpoint", return_value={"socket": str(self.path), "token": "t0k"}):
            self.streams.handle({"op": "open"})
            self.wait(lambda: any(k == "your_browser_screen_data" for k, _ in self.events))
        self.assertEqual(self.requests[0], {"token": "t0k", "own": True, "op": "screen"})
        first = [f for k, f in self.events if k == "your_browser_screen_data"][0]
        self.assertEqual(set(first), {"data"}, "no Pip, no path, no token in what the editor gets")
        self.assertEqual(base64.b64decode(first["data"]), b"RFB 003.008\n")
        self.streams.handle({"op": "send", "data": base64.b64encode(b"hello").decode()})
        self.wait(lambda: self.received == [b"hello"])
        self.streams.handle({"op": "send", "data": "not base64!!"})
        self.streams.handle({"op": "close"})
        self.wait(lambda: ("your_browser_screen_closed", {"reason": "closed", "pictures": False}) in self.events)
        self.assertEqual(self.received, [b"hello"])

    def test_where_it_shows_pictures_the_tab_is_told_so(self):
        self.answer = {"ok": False, "pictures": True, "error": "Your Browser shows pictures here."}
        with patch("dgc.pip_screen_stream.WorkspaceRegistry"), \
                patch.object(your_browser, "view_endpoint", return_value={"socket": str(self.path), "token": "t0k"}):
            self.streams.handle({"op": "open"})
            self.wait(lambda: self.events)
        kind, fields = self.events[0]
        self.assertEqual((kind, fields["pictures"]), ("your_browser_screen_closed", True))

    def test_closed_says_so_and_waits_for_it_to_open(self):
        from dgc import pip_screen_stream
        with patch("dgc.pip_screen_stream.WorkspaceRegistry"), patch.object(pip_screen_stream, "OPEN_SECONDS", 0.3), \
                patch.object(your_browser, "view_endpoint", return_value=None):
            self.streams.handle({"op": "open"})
            self.wait(lambda: self.events)
        kind, fields = self.events[0]
        self.assertEqual((kind, fields["pictures"]), ("your_browser_screen_closed", False))
        self.assertIn("Your Browser", fields["reason"])

    def test_the_protocol_has_the_command_and_its_events(self):
        from dgc import editor_protocol as ep
        self.assertIsNone(ep.command_error({"type": "your_browser_screen", "op": "open"}))
        self.assertIsNone(ep.command_error({"type": "your_browser_screen", "op": "send", "data": "AAAA"}))
        self.assertIsNotNone(ep.command_error({"type": "your_browser_screen", "op": "open", "pip_id": A}))
        self.assertIsNotNone(ep.command_error({"type": "your_browser_screen", "op": "peek"}))
        for kind in ("your_browser_screen_data", "your_browser_screen_closed"):
            self.assertIn(kind, ep.EVENT_FIELDS)

    def test_its_bytes_are_never_redacted_into_a_broken_screen(self):
        from dgc.headless import sanitize_event
        data = "A" * 100 + "AKIAABCDEFGHIJKLMNOP" + "B" * 100
        self.assertEqual(sanitize_event({"type": "your_browser_screen_data", "data": data}, [])["data"], data)


def _crowd_files(test, past=1100):
    """Open files until the next descriptor is numbered past ``past`` (a long-running process's are): select() refuses
    those, and the screen closed at once (found by the full suite)."""
    import resource
    soft, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft != resource.RLIM_INFINITY and soft < past + 64:
        test.skipTest(f"this process may open only {soft} files")
    held = []
    while True:
        fd = os.open(os.devnull, os.O_RDONLY)
        held.append(fd)
        if fd > past:
            break
    test.addCleanup(lambda: [os.close(fd) for fd in held])


class ViewSocketScreenManyFiles(ViewSocketScreen):
    def setUp(self):
        _crowd_files(self)
        super().setUp()


class ServeStreamManyFiles(ServeStream):
    def setUp(self):
        _crowd_files(self)
        super().setUp()


class ServeRefusals(unittest.TestCase):
    """`dgc serve` refuses the screen where it refuses Pips controls, and where the computer has a screen of its own
    (the window beside the editor is the way)."""

    def owner(self):
        from dgc import headless
        return next(c for c in (headless.Chat, headless.Backend) if hasattr(c, "_your_browser_screen"))

    def test_refused_places(self):
        owner = self.owner()
        for name, config, env, screen in (("pips off", {"pips_enabled": False}, {}, False),
                                          ("a model's own shell", {"pips_enabled": True}, {"DGC_AGENT_SHELL": "1"}, False),
                                          ("a screen here", {"pips_enabled": True}, {}, True)):
            with self.subTest(name), patch.dict(os.environ, env), patch.object(your_browser, "has_screen", return_value=screen):
                events = []
                fake = types.SimpleNamespace(em=types.SimpleNamespace(emit=lambda kind, **f: events.append((kind, f))),
                                             config=config)
                with patch("dgc.pip_screen_stream.YourBrowserScreen") as streams:
                    owner._your_browser_screen(fake, {"type": "your_browser_screen", "op": "open"})
                self.assertEqual(events[0][0], "your_browser_screen_closed")
                streams.assert_not_called()

    def test_allowed(self):
        owner = self.owner()
        events = []
        fake = types.SimpleNamespace(em=types.SimpleNamespace(emit=lambda kind, **f: events.append((kind, f))),
                                     config={"pips_enabled": True})
        with patch.object(your_browser, "has_screen", return_value=False), \
                patch("dgc.pip_screen_stream.YourBrowserScreen") as streams:
            owner._your_browser_screen(fake, {"type": "your_browser_screen", "op": "open"})
        streams.return_value.handle.assert_called_once()
        self.assertEqual(events, [])

    def test_the_editor_is_told_it_can(self):
        source = (REPO / "dgc" / "headless.py").read_text(encoding="utf-8")
        self.assertIn('"your_browser_screen": 1', source)


# --------------------------------------------------------------------------- the real thing

def _vnc():
    """The VNC program a Pip's computer uses: this home's, or (a suite run gives each test a fresh HOME) the user's own
    downloaded copy, read only."""
    try:
        found = your_browser.vnc_program()
    except Exception:                                       # noqa: BLE001
        found = None
    if found is not None:
        return found
    import pwd
    copies = sorted(Path(pwd.getpwuid(os.getuid()).pw_dir).glob(".dgc/desktop/*/current/root/usr/bin/Xtigervnc"))
    return copies[0] if copies else None


def _rfb_handshake(sock):
    def exact(n):
        data = b""
        while len(data) < n:
            chunk = sock.recv(n - len(data))
            if not chunk:
                raise OSError("closed")
            data += chunk
        return data
    assert exact(12).startswith(b"RFB 003.")
    sock.sendall(b"RFB 003.008\n")
    count = exact(1)[0]
    types_ = exact(count)
    assert 1 in types_, types_
    sock.sendall(b"\x01")
    assert struct.unpack(">I", exact(4))[0] == 0
    sock.sendall(b"\x01")                                    # shared
    width, height = struct.unpack(">HH", exact(4))
    exact(16)
    name = exact(struct.unpack(">I", exact(4))[0])
    return exact, width, height, name


@unittest.skipUnless(_installed_chrome() and _vnc(), "needs Google Chrome installed from its package and TigerVNC's Xtigervnc")
class RealScreen(unittest.TestCase):
    """The installed Google Chrome (its sandbox on) on a real Xtigervnc, no display of the computer's own: through the
    supervisor's view socket, an RFB viewer gets the screen and its click reaches the page."""

    def test_the_screen_streams_and_a_click_reaches_the_page(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-real-screen-")
        self.addCleanup(temp.cleanup)
        site = _OwnSite()
        self.addCleanup(site.stop)
        env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
        with patch.dict(os.environ, env, clear=True), patch.object(your_browser, "vnc_program", return_value=_vnc()):
            host = your_browser.YourBrowserHost(Path(temp.name), chrome=_installed_chrome(), test_flags=("--password-store=basic",))
            self.addCleanup(host.close)
            host.open(site.url("/form"), None, headless=True)
            self.assertIsNotNone(host.screen_socket(), "a VNC screen of its own")
            said = host.view_own("size", {"width": 900, "height": 600})
            self.assertEqual(said["screen"], {"width": 900 * your_browser.VNC_SCALE, "height": 600 * your_browser.VNC_SCALE},
                             "the screen is the tab's size where Chrome's window can be")
            # A tab narrower than Chrome's window can be: Chrome keeps its own least width, and the screen is as wide.
            narrow = host.view_own("size", {"width": 300, "height": 600})
            with host.lock:
                window = host.browser._browser_call("Browser.getWindowForTarget", {"targetId": host.own_tab()}, timeout=10)["bounds"]
            self.assertGreater(window["width"], 320, f"Chrome keeps a least width of its own: {window}")
            self.assertEqual(narrow["screen"]["width"], window["width"] * your_browser.VNC_SCALE, "Chrome's whole window is on the screen")
            host.view_own("size", {"width": 900, "height": 600})
            server = your_browser.ViewServer(host)
            self.addCleanup(server.close)
            client = socket.socket(socket.AF_UNIX)
            client.settimeout(10)
            client.connect(str(server.path))
            self.addCleanup(client.close)
            client.sendall(json.dumps({"token": server.token, "own": True, "op": "screen"}).encode() + b"\n")
            line = b""
            while not line.endswith(b"\n"):
                line += client.recv(1)
            self.assertEqual(json.loads(line), {"ok": True})
            exact, width, height, name = _rfb_handshake(client)
            self.assertEqual(name, b"Your Browser")
            self.assertGreaterEqual(width, 900)
            # Raw pictures only (easy to read here), then the whole screen, until Chrome has drawn its window on it.
            client.sendall(struct.pack(">BxH i", 2, 1, 0))

            def whole():
                client.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, width, height))
                kind = exact(1)[0]
                while kind != 0:                              # (a bell or a clipboard first: skip)
                    if kind == 3:
                        exact(3)
                        exact(struct.unpack(">I", exact(4))[0])
                    kind = exact(1)[0]
                exact(1)
                pixels = b""
                for _ in range(struct.unpack(">H", exact(2))[0]):
                    x, y, w, h, encoding = struct.unpack(">HHHHi", exact(12))
                    if encoding == 0:
                        pixels += exact(w * h * 4)
                return pixels
            colours, deadline = 0, time.monotonic() + 15
            while colours <= 8 and time.monotonic() < deadline:
                pixels = whole()
                colours = len({pixels[i:i + 3] for i in range(0, len(pixels), 4 * 97)})
                time.sleep(0.3)
            self.assertGreater(colours, 8, "a real picture: Chrome's window with its page")
            # A click in the page's field and typing: the page's title says it got them. The field is at (10..310,
            # 10..50) CSS pixels inside the page; the page sits under Chrome's own bar in the window.
            with host.lock:
                bar = host.browser._session_call(host.browser._attached[host.own_tab()], "Runtime.evaluate",
                                                 {"expression": "[window.outerHeight - window.innerHeight, devicePixelRatio]",
                                                  "returnByValue": True}, timeout=10)["result"]["value"]
            top, scale = bar
            px, py = int(60 * scale), int((top + 30) * scale)
            client.sendall(struct.pack(">BBHH", 5, 1, px, py) + struct.pack(">BBHH", 5, 0, px, py))
            for ch in b"hi":
                client.sendall(struct.pack(">BBxxI", 4, 1, ch) + struct.pack(">BBxxI", 4, 0, ch))
            client.sendall(struct.pack(">BBxxI", 4, 1, 0xFF0D) + struct.pack(">BBxxI", 4, 0, 0xFF0D))
            reader = threading.Thread(target=lambda: _drain(client), daemon=True)
            reader.start()
            deadline = time.monotonic() + 10
            title = ""
            while time.monotonic() < deadline and title != "Got: hi":
                time.sleep(0.2)
                with host.lock:
                    title = host.browser.infos.get(host.own_tab(), {}).get("title", "")
                    host.refreshed = -1e9
                    host.refresh()
            self.assertEqual(title, "Got: hi")
            # A Pip's lane: a window of its own, left of the screen, so the person's screen shows only their own window.
            lane = host.open_lane(A, "", your_browser.Grants(["example.com"]))
            with host.lock:
                bounds = host.browser._browser_call("Browser.getWindowForTarget", {"targetId": lane}, timeout=10)["bounds"]
                mine = host.browser._browser_call("Browser.getWindowForTarget", {"targetId": host.own_tab()}, timeout=10)["windowId"]
                theirs = host.browser._browser_call("Browser.getWindowForTarget", {"targetId": lane}, timeout=10)["windowId"]
            self.assertNotEqual(mine, theirs)
            self.assertLessEqual(bounds["left"] + bounds["width"], 0, bounds)
            screen = host.browser._box.screen
            host.close()
            self.assertIsNotNone(screen.poll(), "its screen stopped with it")


@unittest.skipUnless(_installed_chrome() and _vnc(), "needs Google Chrome installed from its package and TigerVNC's Xtigervnc")
class RealScreenEndsWithChrome(unittest.TestCase):
    def test_a_chrome_that_ends_without_anyone_closing_it_takes_its_screen_with_it(self):
        import signal
        temp = tempfile.TemporaryDirectory(prefix="yb-real-end-")
        self.addCleanup(temp.cleanup)
        env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
        with patch.dict(os.environ, env, clear=True), patch.object(your_browser, "vnc_program", return_value=_vnc()):
            host = your_browser.YourBrowserHost(Path(temp.name), chrome=_installed_chrome(), test_flags=("--password-store=basic",))
            self.addCleanup(host.close)
            host.open("about:blank", None, headless=True)
            screen, chrome = host.browser._box.screen, host.browser._box.proc
            self.assertIsNone(screen.poll())
            os.killpg(chrome.pid, signal.SIGKILL)          # (as if the supervisor that held it was stopped)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and screen.poll() is None:
                time.sleep(0.1)
            self.assertIsNotNone(screen.poll(), "no screen is left running with nothing on it")


def _drain(sock):
    try:
        while sock.recv(65536):
            pass
    except OSError:
        pass


if __name__ == "__main__":
    unittest.main()
