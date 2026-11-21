"""Your Browser, phase 3b (0.52, Pips API 107; his call 18 Nov): over Remote-SSH, the streamed tab of YOUR OWN tabs.

- Where the machine DGC runs on has no screen (Remote-SSH, a server), Google Chrome runs headless (--headless=new, full
  Chrome) with DGC's own profile, its sandbox on, and "Open Your Browser" answers `view: "tab"`: the editor opens a tab
  streaming the person's own current tab. Where there IS a screen it stays the real window (phase 3), unchanged.
- The streamed tab is usable: clicks, typing (passwords included), keys, scrolling and paste of text go to the tab; our
  own address bar (an address, else a Google search), Back, Forward, Reload, and the person's own tabs with New tab and
  Close. Every frame of a screencast (JPEG, sized to the editor tab), up to 30 a second; none once it isn't asked for.
- Only the person drives it, through that editor tab (the editor's local actor, `editor-user`): never a Pip, a model, a
  tool or the command line, and never where the computer has a screen (its window is the way). The person's frames go
  only to that editor tab: never written, kept, logged or put in a run, and never redacted into a broken picture.

Unit tests drive the supervisor's host over the scripted DevTools pipe of test_your_browser_window; the real test runs
DGC's downloaded Google Chrome headless with no display at all."""
from __future__ import annotations

import base64
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pips, your_browser
from tests import test_pips_local as fixtures
from tests.test_your_browser_window import TINY_JPEG, A, ChromePipe, FakeProcess, _real_chrome

REPO = Path(__file__).resolve().parents[1]


class OwnHost(unittest.TestCase):
    """The supervisor's host with no screen: Chrome headless, the person's own tab streamed."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-own-")
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.pipe = ChromePipe()
        self.launched = []
        self.now = [1000.0]

        def launch(argv, env, log_path):
            self.launched.append(argv)
            self.process = FakeProcess()
            if len(self.launched) > 1:
                self.pipe = ChromePipe()           # (each start is a new Chrome)
            return self.process, self.pipe

        screen = patch.object(your_browser, "has_screen", return_value=False)
        screen.start()
        self.addCleanup(screen.stop)
        self.host = your_browser.YourBrowserHost(self.directory, chrome=Path("/opt/google/chrome/chrome"), launch=launch,
                                                 run=lambda argv, **kw: None, which=lambda name: None, platform="linux",
                                                 clock=lambda: self.now[0], pump_thread=False)
        self.host.own_wait = 0.0
        self.addCleanup(self.host.close)

    def pump(self):
        with self.host.lock:
            self.host.browser._pump(0.01)
            self.host.after_pump()

    def frame_from_chrome(self, session, n, data=TINY_JPEG):
        self.pipe.inbox.append({"method": "Page.screencastFrame", "sessionId": session,
                                "params": {"data": data, "sessionId": n, "metadata": {"deviceWidth": 900, "deviceHeight": 600}}})
        self.pump()


class Headless(OwnHost):
    def setUp(self):
        super().setUp()
        self.unlocked = [True]
        store = patch.object(your_browser, "store_unlocked", side_effect=lambda env: self.unlocked[0])
        store.start()
        self.addCleanup(store.stop)

    def test_your_tabs_wear_their_sites_icons(self):
        # (His 20 Nov ask: tabs like Chrome's, with each site's icon.)
        self.host.open("https://example.com/", None, headless=True)
        original = self.pipe.send

        def send(payload):
            if payload.get("method") == "Runtime.evaluate" and "icon" in payload["params"]["expression"]:
                self.pipe.sent.append(payload)
                self.pipe.inbox.append({"id": payload["id"], "sessionId": payload.get("sessionId"),
                                        "result": {"result": {"type": "string", "value": "https://news.example.org/fav.png"}}})
                return
            original(payload)
        self.pipe.send = send
        fetched = []
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 40

        def fetch(url):
            fetched.append(url)
            return png, "image/png"
        self.host.fetch_icon = fetch
        self.host.icon_wait = True                    # (the download runs at once here, not in a thread)
        reply = self.host.view_own("frame", {"op": "frame", "seq": 0})
        current = [t for t in reply["tabs"] if t["current"]]
        self.assertEqual(fetched, ["https://news.example.org/fav.png"])
        self.assertTrue(current and current[0].get("icon", "").startswith("data:image/png;base64,"), reply["tabs"])
        self.host.view_own("frame", {"op": "frame", "seq": 0})
        self.assertEqual(len(fetched), 1, "fetched once, kept by its address")

    def test_an_icon_that_isnt_a_small_picture_is_never_kept(self):
        for body, kind in ((b"<html>", "text/html"), (b"x" * 300_000, "image/png"), (b"", "image/png")):
            with self.subTest(kind=kind, size=len(body)):
                self.assertIsNone(your_browser.icon_data(body, kind))
        self.assertTrue(your_browser.icon_data(b"\x00\x00\x01\x00" + b"0" * 30, "image/x-icon").startswith("data:image/x-icon"))

    def test_copy_in_your_tab_lands_on_the_editors_clipboard(self):
        # (His 20 Nov test: Ctrl+C in the streamed tab copied into Chrome's clipboard on the other computer.)
        self.host.open("https://example.com/", None, headless=True)
        original = self.pipe.send

        def send(payload):
            if payload.get("method") == "Runtime.evaluate":
                self.pipe.sent.append(payload)
                expression = payload["params"]["expression"]
                self.assertIn("(text|search|url|email|tel|number)", expression, "only plain text fields")
                self.assertNotIn("password", expression, "a password field is never read")
                self.pipe.inbox.append({"id": payload["id"], "sessionId": payload.get("sessionId"),
                                        "result": {"result": {"type": "string", "value": "the selected words"}}})
                return
            original(payload)
        self.pipe.send = send
        reply = self.host.view_own("selection", {"op": "selection"})
        self.assertEqual((reply["ok"], reply["text"]), (True, "the selected words"))
        self.assertIn("selection", your_browser.OWN_OPS)

    def test_with_no_screen_but_xvfb_it_is_real_chrome_on_a_screen_of_its_own(self):
        # (His 20 Nov test over Remote-SSH: headless Chrome says "HeadlessChrome", and Google's sign-in and reCAPTCHA
        # turned it away; its pictures were soft on a Retina screen.) A Pip's computer runs Chrome on a display of its
        # own: so does Your Browser where the computer has no screen, at twice the pixels.
        screens = []

        class Screen:
            def poll(self):
                return None

            def terminate(self):
                screens.append("stopped")

            def wait(self, timeout=None):
                return 0
        self.host.which = lambda name: "/usr/bin/Xvfb" if name == "Xvfb" else None
        envs = []
        launch = self.host.launch
        self.host.launch = lambda argv, env, log: (envs.append(env), launch(argv, env, log))[1]
        with patch.object(your_browser, "start_virtual_screen", lambda which: (":147", Screen())):
            self.host.open("https://example.com/", None, headless=True)
        argv = self.launched[-1]
        self.assertNotIn("--headless=new", argv, "never headless Chrome where a screen of its own can be made")
        self.assertIn(f"--force-device-scale-factor={your_browser.SCREEN_SCALE}", argv)
        self.assertTrue(any(a.startswith("--window-size=") for a in argv))
        self.assertEqual(envs[-1].get("DISPLAY"), ":147")
        self.assertTrue(self.host.headless, "still streamed to the editor's tab")
        self.host.close()
        self.assertEqual(screens, ["stopped"], "its screen goes with it")

    def test_with_no_screen_chrome_runs_headless_with_its_sandbox_and_dgcs_profile(self):
        self.host.open("https://example.com/", None, headless=True)
        argv = self.launched[-1]
        self.assertIn("--headless=new", argv)
        self.assertIn("--remote-debugging-pipe", argv)
        self.assertIn(f"--user-data-dir={self.directory / 'your-browser' / 'profile'}", argv)
        for never in ("--no-sandbox", "--disable-sync", "--disable-extensions", "--enable-automation",
                      "--password-store=basic", "--remote-debugging-port=0"):
            with self.subTest(never=never):
                self.assertNotIn(never, argv)
        self.assertTrue(self.host.headless)

    def test_where_there_is_a_screen_it_stays_a_window_and_a_headless_one_comes_back_as_one(self):
        with patch.object(your_browser, "has_screen", return_value=True):
            self.host.open("", None)
            self.assertNotIn("--headless=new", self.launched[-1], "phase 3's window, unchanged")
            self.host.open("", None, headless=True)
            self.assertEqual(len(self.launched), 1, "an editor with no screen while the window is open: it streams")
            self.host.close()
            self.host.open("", None, headless=True)
            self.assertIn("--headless=new", self.launched[-1], "the editor that asked has no screen (Remote-SSH)")
            self.host.open("https://example.com/", {"left": 1, "top": 2, "width": 900, "height": 800})
            self.assertNotIn("--headless=new", self.launched[-1], "back at the screen, its window opens")
            self.assertIn("--window-position=1,2", self.launched[-1])
        self.host.close()
        self.host.open("", None)
        self.assertIn("--headless=new", self.launched[-1], "no screen here at all: headless whatever was asked")
        self.assertEqual(len(self.launched), 4)

    def test_its_own_tab_is_the_one_opened_and_a_tab_it_opens_is_followed(self):
        self.host.open("", None, headless=True)
        self.assertEqual(self.host.own_tab(), "P1")
        self.host.open("https://docs.example.org/", None, headless=True)
        made = self.pipe.calls("Target.createTarget")[-1]
        self.assertEqual(made["params"]["url"], "https://docs.example.org/")
        new = made and [t for t in self.pipe.targets if t not in ("P1",)][-1]
        self.assertEqual(self.host.own_tab(), new)
        # A link that opens a new tab, from the person's own tab: the stream follows it.
        self.pipe.info("POP", "https://pay.example.net/", "Pay", opener=new)
        self.pipe.attach("POP", "https://pay.example.net/", opener=new)
        self.pump()
        self.assertEqual(self.host.own_tab(), "POP")

    def test_with_nobody_watching_and_no_pip_tab_it_closes_after_fifteen_minutes(self):
        self.host.open("", None, headless=True)
        self.host.view_own("frame", {"seq": 0})
        self.host.tick(None)
        self.now[0] += your_browser.IDLE_SECONDS - 1
        self.host.tick(None)
        self.assertTrue(self.host.running())
        self.now[0] += 2
        self.host.tick(None)
        self.assertFalse(self.host.running(), "its tabs are always there headless: watching is what keeps it open")


class LockedPasswordStore(Headless):
    """Over Remote-SSH the computer's password store is often locked (nobody signed in at its desktop since it started):
    Chrome asks it to unlock, nobody can answer, and every start waited ~21-25 s (measured 18 Nov, Chrome 158) before it
    went on with its own built-in key. Where there's no screen and the store isn't known to be open, Chrome is told to
    use its own store from the start (0.65 s, the same sign-ins). Where there's a screen, Chrome's own prompt can be
    answered: its default, unchanged."""

    def test_locked_with_no_screen_chrome_uses_its_own_store_from_the_start(self):
        self.unlocked[0] = False
        self.host.open("", None, headless=True)
        self.assertIn("--password-store=basic", self.launched[-1])

    def test_not_known_with_no_screen_is_the_same(self):
        self.unlocked[0] = None
        self.host.open("", None, headless=True)
        self.assertIn("--password-store=basic", self.launched[-1])

    def test_open_with_no_screen_chrome_uses_the_computers_store(self):
        self.unlocked[0] = True
        self.host.open("", None, headless=True)
        self.assertNotIn("--password-store=basic", self.launched[-1])

    def test_with_a_screen_chrome_keeps_its_default_even_when_locked(self):
        self.unlocked[0] = False
        with patch.object(your_browser, "has_screen", return_value=True):
            self.host.open("", None)
        self.assertNotIn("--headless=new", self.launched[-1])
        self.assertNotIn("--password-store=basic", self.launched[-1])


class PasswordStoreUnlocked(unittest.TestCase):
    """store_unlocked(env): the default collection's Locked property, read over the session bus (busctl, else gdbus)
    in at most a few seconds; None when it can't be told (no bus, no tool, no store, an error)."""

    def check(self, outputs, env=None):
        calls = []

        def run(argv, **kw):
            calls.append((argv, kw))
            out = outputs.get(argv[0])
            if out is None:
                raise FileNotFoundError(argv[0])
            code, text = out
            return type("R", (), {"returncode": code, "stdout": text})()
        env = {"DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus"} if env is None else env
        return your_browser.store_unlocked(env, run=run, which=lambda name: f"/usr/bin/{name}" if name in outputs else None), calls

    def test_busctl_says_locked_or_open(self):
        self.assertEqual(self.check({"busctl": (0, "b true\n")})[0], False)
        self.assertEqual(self.check({"busctl": (0, "b false\n")})[0], True)

    def test_gdbus_when_there_is_no_busctl(self):
        self.assertEqual(self.check({"gdbus": (0, "(<true>,)\n")})[0], False)
        self.assertEqual(self.check({"gdbus": (0, "(<false>,)\n")})[0], True)

    def test_cant_tell(self):
        self.assertIsNone(self.check({"busctl": (0, "b true\n")}, env={})[0], "no session bus")
        self.assertIsNone(self.check({})[0], "no tool")
        self.assertIsNone(self.check({"busctl": (1, "")})[0], "no password store answering")
        self.assertIsNone(self.check({"busctl": (0, "s nonsense\n")})[0])

    def test_it_asks_on_the_given_bus_with_a_short_timeout_and_no_prompt(self):
        _, calls = self.check({"busctl": (0, "b true\n")})
        argv, kw = calls[0]
        self.assertEqual(argv[:3], ["busctl", "--user", "get-property"])
        self.assertIn("Locked", argv)
        self.assertLessEqual(kw.get("timeout"), 5)
        self.assertEqual(kw["env"]["DBUS_SESSION_BUS_ADDRESS"], "unix:path=/run/user/1000/bus")


class OwnFrames(OwnHost):
    def setUp(self):
        super().setUp()
        self.host.open("", None, headless=True)
        self.session = self.pipe.targets["P1"]

    def test_the_stream_is_every_screencast_frame_of_your_own_tab_sized_to_the_editor_tab(self):
        self.host.view_own("size", {"width": 900, "height": 600})
        got = self.host.view_own("frame", {"seq": 0})
        cast = self.pipe.calls("Page.startScreencast", self.session)[-1]["params"]
        self.assertEqual((cast["format"], cast["everyNthFrame"], cast["maxWidth"], cast["maxHeight"]), ("jpeg", 1, 900, 600))
        size = self.pipe.calls("Browser.setContentsSize")[-1]["params"]
        self.assertEqual((size["width"], size["height"]), (900, 600), "the page is laid out at the editor tab's size")
        self.assertTrue(got["ok"])
        self.frame_from_chrome(self.session, 1)
        got = self.host.view_own("frame", {"seq": got["seq"]})
        self.assertTrue(got["image"].startswith("data:image/jpeg;base64,"))
        self.assertEqual((got["width"], got["height"]), (900, 600))
        self.assertEqual(self.pipe.calls("Page.screencastFrameAck", self.session)[-1]["params"], {"sessionId": 1})

    def test_frames_come_up_to_thirty_a_second_and_a_frame_already_seen_isnt_sent_again(self):
        self.assertEqual(self.host._wait(), 0.05, "nothing held: it waits for Chrome, at most 50 ms")
        self.host.view_own("frame", {"seq": 0})
        self.frame_from_chrome(self.session, 1)
        first = self.host.view_own("frame", {"seq": 0})
        again = self.host.view_own("frame", {"seq": first["seq"]})
        self.assertNotIn("image", again, "nothing new: no picture sent")
        self.now[0] += 1 / 30
        self.frame_from_chrome(self.session, 2)
        newer = self.host.view_own("frame", {"seq": first["seq"]})
        self.assertGreater(newer["seq"], first["seq"])
        self.assertIn("image", newer)
        acks = [c["params"]["sessionId"] for c in self.pipe.calls("Page.screencastFrameAck", self.session)]
        self.assertEqual(acks, [1, 2], "every frame acked as it comes, at most thirty a second")
        self.frame_from_chrome(self.session, 3)
        self.assertEqual(len(self.pipe.calls("Page.screencastFrameAck", self.session)), 2, "a frame within 1/30 s waits")
        self.assertAlmostEqual(self.host._wait(), 1 / 30, places=6, msg="the pump wakes when its ack falls due")
        self.now[0] += 1 / 30
        self.pump()
        self.assertEqual(len(self.pipe.calls("Page.screencastFrameAck", self.session)), 3)

    def test_your_own_tabs_are_listed_and_never_a_pips(self):
        self.host.open_lane(A, "https://shop.example.com/", your_browser.Grants(["example.com"]))
        self.pipe.info("P1", "https://news.example.org/today", "Today")
        self.pump()
        got = self.host.view_own("frame", {"seq": 0})
        self.assertEqual([(t["title"], t["current"]) for t in got["tabs"]], [("Today", True)])
        self.assertEqual(got["url"], "https://news.example.org/today")
        self.assertNotIn("shop.example.com", json.dumps(got))

    def test_nobody_asking_stops_the_screencast_and_forgets_the_picture(self):
        self.host.view_own("frame", {"seq": 0})
        self.frame_from_chrome(self.session, 1)
        self.now[0] += your_browser.CAST_SECONDS + 1
        self.pump()
        self.assertTrue(self.pipe.calls("Page.stopScreencast", self.session))
        self.assertIsNone(self.host.own_frame)
        self.host.view_own("close", {})
        self.assertIsNone(self.host.own_frame)

    def test_frames_are_never_written_anywhere(self):
        self.host.view_own("frame", {"seq": 0})
        self.frame_from_chrome(self.session, 1, base64.b64encode(b"PERSON-FRAME-" + b"x" * 64).decode())
        self.host.view_own("frame", {"seq": 0})
        self.host.close()
        for path in self.directory.rglob("*"):
            if path.is_file():
                self.assertNotIn(b"PERSON-FRAME", path.read_bytes(), path)
                self.assertNotIn(base64.b64encode(b"PERSON-FRAME-")[:16], path.read_bytes(), path)


class OwnInput(OwnHost):
    def setUp(self):
        super().setUp()
        self.host.open("", None, headless=True)
        self.session = self.pipe.targets["P1"]

    def sent(self, method):
        return [c["params"] for c in self.pipe.calls(method, self.session)]

    def test_clicks_moves_and_the_wheel_go_to_your_own_tab_where_they_were_made(self):
        self.host.view_own("input", {"events": [
            {"t": "move", "x": 10, "y": 20, "buttons": 0},
            {"t": "down", "x": 10, "y": 20, "button": "left", "clicks": 1},
            {"t": "up", "x": 10, "y": 20, "button": "left", "clicks": 1},
            {"t": "wheel", "x": 30, "y": 40, "dx": 0, "dy": 120}]})
        mouse = self.sent("Input.dispatchMouseEvent")
        self.assertEqual([m["type"] for m in mouse], ["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"])
        self.assertEqual((mouse[1]["x"], mouse[1]["y"], mouse[1]["button"], mouse[1]["clickCount"]), (10, 20, "left", 1))
        self.assertEqual((mouse[3]["deltaY"], mouse[3]["x"]), (120, 30))

    def test_typing_keys_and_paste_reach_the_tab_in_order(self):
        self.host.view_own("input", {"events": [
            {"t": "key", "key": "s", "code": "KeyS", "text": "s"},
            {"t": "key", "key": "3", "code": "Digit3", "text": "3", "mods": 8},
            {"t": "text", "text": "pässwörd!"},
            {"t": "key", "key": "Enter", "code": "Enter"},
            {"t": "key", "key": "a", "code": "KeyA", "mods": 2}]})
        keys = self.sent("Input.dispatchKeyEvent")
        downs = [k for k in keys if k["type"] in ("keyDown", "rawKeyDown")]
        self.assertEqual([(k["key"], k.get("text")) for k in downs], [("s", "s"), ("3", "3"), ("Enter", "\r"), ("a", None)])
        self.assertEqual(downs[2]["windowsVirtualKeyCode"], 13)
        self.assertEqual((downs[3]["modifiers"], downs[3]["type"], downs[3].get("commands")), (2, "rawKeyDown", ["selectAll"]))
        self.assertEqual(len([k for k in keys if k["type"] == "keyUp"]), 4)
        self.assertEqual(self.sent("Input.insertText"), [{"text": "pässwörd!"}])
        order = [c["method"] for c in self.pipe.sent if c.get("sessionId") == self.session and c["method"].startswith("Input.")]
        self.assertEqual(order.index("Input.insertText"), 4, "in the order they were made")

    def test_the_address_bar_back_forward_and_reload(self):
        self.host.view_own("go", {"url": "weather in pune"})
        self.assertEqual(self.sent("Page.navigate")[-1]["url"], "https://www.google.com/search?q=weather+in+pune")
        self.host.view_own("go", {"url": "docs.python.org/3/"})
        self.assertEqual(self.sent("Page.navigate")[-1]["url"], "https://docs.python.org/3/")
        self.host.view_own("back", {})
        self.assertEqual(self.sent("Page.navigateToHistoryEntry")[-1], {"entryId": 1})
        self.host.view_own("reload", {})
        self.assertTrue(self.sent("Page.reload"))

    def test_new_tab_switching_and_close(self):
        got = self.host.view_own("new_tab", {})
        made = self.pipe.calls("Target.createTarget")[-1]["params"]
        self.assertNotIn("background", made)
        new = got["current"]
        self.assertNotEqual(new, "P1")
        self.assertEqual(self.host.own_tab(), new)
        for n in range(6):
            self.host.view_own("new_tab", {})
        ids = [t["id"] for t in self.host.view_own("tab", {"tab": "P1"})["tabs"]]
        self.assertEqual(ids[:2], ["P1", new], "your tabs in the order you opened them, the newest last")
        self.assertEqual(len(ids), 8)
        self.assertEqual(ids, sorted(ids, key=lambda t: self.host.browser.born[t]))
        self.assertEqual(self.host.view_own("tab", {"tab": "P1"})["current"], "P1")
        self.host.view_own("close_tab", {"tab": new})
        self.assertEqual(self.pipe.calls("Target.closeTarget")[-1]["params"], {"targetId": new})
        # A Pip's tab is never one of yours to switch to or close.
        lane = self.host.open_lane(A, "https://shop.example.com/", your_browser.Grants(["example.com"]))
        refused = self.host.view_own("tab", {"tab": lane})
        self.assertFalse(refused["ok"])
        refused = self.host.view_own("close_tab", {"tab": lane})
        self.assertFalse(refused["ok"])
        self.assertNotIn({"targetId": lane}, [c["params"] for c in self.pipe.calls("Target.closeTarget")])

    def test_closing_your_last_tab_leaves_a_new_one(self):
        self.host.view_own("close_tab", {"tab": "P1"})
        self.pipe.inbox.append({"method": "Target.detachedFromTarget", "params": {"sessionId": self.session, "targetId": "P1"}})
        self.pipe.inbox.append({"method": "Target.targetDestroyed", "params": {"targetId": "P1"}})
        self.pump()
        got = self.host.view_own("frame", {"seq": 0})
        self.assertTrue(got["tabs"], "a new tab is there to show")
        self.assertNotEqual(got["current"], "P1")

    def test_dgc_itself_still_never_drives_your_tab(self):
        with self.assertRaises(your_browser.BrowserError):
            self.host.browser.navigate("https://elsewhere.example/")
        with self.assertRaises(your_browser.BrowserError):
            self.host.browser.command("Input.insertText", {"text": "x"})


# --------------------------------------------------------------------------- who may use it

class Who(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        for p in (patch.object(your_browser, "_availability", return_value=(True, "", "installed")),
                  patch.object(your_browser, "_runner_live", return_value=True)):
            p.start()
            self.addCleanup(p.stop)
        self.sent = []

        def view(registry, request):
            self.sent.append(request)
            return {"ok": True, "own": True, "seq": 1}

        p = patch.object(your_browser, "_view_socket", side_effect=view)
        p.start()
        self.addCleanup(p.stop)

    def control(self, command, actor="editor-user", **fields):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"type": command, "request_id": "r", **fields}, actor, start_worker=False)

    def test_with_no_screen_open_answers_the_tab_and_asks_for_chrome_headless(self):
        with patch.object(your_browser, "has_screen", return_value=False):
            out = self.control("open_your_browser", url="example.com", editor_bounds={"x": 0, "y": 0, "width": 800, "height": 600})
            recent = self.control("get_your_browser_recent")["result"]
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["result"]["view"], "tab")
        self.assertEqual(recent["view"], "tab")
        row = self.registry.db.execute("SELECT value FROM metadata WHERE key=?", (your_browser.OPEN_KEY,)).fetchone()
        [asked] = json.loads(row[0])
        self.assertEqual((asked["headless"], asked["place"]), (True, None))
        with patch.object(your_browser, "has_screen", return_value=True):
            out = self.control("open_your_browser", url="example.com")
        self.assertEqual(out["result"]["view"], "window", "a screen: the real window, as in phase 3")

    def test_your_own_tab_is_used_only_by_you_through_the_editor(self):
        with patch.object(your_browser, "has_screen", return_value=False):
            ok = self.control("use_your_browser_view", own=True, op="frame", seq=0)
            self.assertTrue(ok["ok"], ok)
            self.assertEqual(self.sent[-1]["own"], True)
            for actor in ("local-console", "device_paired_phone", "pip:" + "a" * 32):
                with self.subTest(actor=actor):
                    out = self.control("use_your_browser_view", actor=actor, own=True, op="input",
                                       events=[{"t": "text", "text": "x"}])
                    self.assertFalse(out["ok"])
                    self.assertIn(out["error"]["code"], ("local_only", "forbidden"))
            both = self.control("use_your_browser_view", own=True, op="frame", pip_id="pip_" + "a" * 32)
            self.assertEqual(both["error"]["code"], "invalid_request")
        with patch.object(your_browser, "has_screen", return_value=True):
            out = self.control("use_your_browser_view", own=True, op="frame", seq=0)
        self.assertEqual(out["error"]["code"], "invalid_request", "with a screen, your tabs are in its window")
        self.assertEqual(len(self.sent), 1)

    def test_a_view_without_own_or_a_pip_is_still_refused(self):
        out = self.control("use_your_browser_view", op="frame")
        self.assertEqual(out["error"]["code"], "invalid_request")

    def test_the_input_is_checked(self):
        with patch.object(your_browser, "has_screen", return_value=False):
            for bad in ([{"t": "explode"}], [{"t": "key", "key": 5}], [{"t": "down", "x": "a", "y": 1}],
                        [{"t": "text", "text": "x" * 9000}], [{"t": "key", "key": "a"}] * 40, "keys",
                        [{"t": "move", "x": 1, "y": 1, "path": "/etc"}]):
                with self.subTest(bad=str(bad)[:40]):
                    out = self.control("use_your_browser_view", own=True, op="input", events=bad)
                    self.assertEqual(out["error"]["code"], "invalid_request", out)
        self.assertEqual(self.sent, [])

    def test_a_model_started_dgc_may_not_use_it(self):
        from dgc import headless
        self.assertFalse(headless._agent_shell_pips_read({"type": "pips_control", "request": {"type": "use_your_browser_view"}}))
        self.assertFalse(headless._agent_shell_pips_read({"type": "pips_control", "request": {"type": "install_google_chrome"}}))


class FramesAreNotRedacted(unittest.TestCase):
    def test_a_frame_of_your_tab_reaches_the_editor_whole(self):
        from dgc.headless import sanitize_event
        # A run like this, inside a megabyte of base64, matches a key pattern: redacted as text it would break the picture.
        image = "data:image/jpeg;base64," + "A" * 100 + "/AKIAABCDEFGHIJKLMNOP/" + "B" * 100
        event = {"type": "pips_result", "request_id": "r", "command": "use_your_browser_view", "ok": True,
                 "result": {"ok": True, "image": image, "title": "sk-ant-api03-" + "x" * 90}}
        out = sanitize_event(event, [])
        self.assertEqual(out["result"]["image"], image)
        self.assertNotIn("sk-ant-api03-" + "x" * 90, json.dumps(out), "every other field is redacted as ever")
        other = sanitize_event({**event, "command": "get_pip"}, [])
        self.assertNotEqual(other["result"]["image"], image, "only the streamed tab's own picture")


class FastPath(unittest.TestCase):
    def test_the_streamed_tab_never_waits_behind_the_other_pip_controls(self):
        source = (REPO / "dgc" / "headless.py").read_text(encoding="utf-8")
        self.assertIn("def _your_browser_view(self, cmd)", source)
        from dgc import headless
        backend = object.__new__(headless.Backend)
        backend.__dict__["_pips_commands"] = []
        ran, release = [], threading.Event()

        def perform(cmd):
            ran.append(cmd["request"]["type"])
            if cmd["request"]["type"] == "list_pip_runs":
                release.wait(5)

        failures = []
        with patch.object(headless.Backend, "_pips_policy_refusal", return_value=False), \
                patch.object(headless.Backend, "_perform_pips_command", side_effect=perform, autospec=False), \
                patch.object(headless.Backend, "_pips_failure", side_effect=lambda *a: failures.append(a)):
            backend._queue_pips_command({"type": "pips_control", "request": {"type": "list_pip_runs", "request_id": "slow"}})
            backend._queue_pips_command({"type": "pips_control", "request": {"type": "use_your_browser_view", "request_id": "f",
                                                                             "own": True, "op": "frame", "seq": 0}})
            deadline = time.monotonic() + 5
            while "use_your_browser_view" not in ran and time.monotonic() < deadline:
                time.sleep(0.01)
            release.set()
        self.assertIn("use_your_browser_view", ran, "a frame went while a slow control was still running")
        self.assertEqual(failures, [])


# --------------------------------------------------------------------------- real Google Chrome, headless, no display at all

def _installed_chrome():
    """Google Chrome installed from Google's own package (a root-owned sandbox helper): it runs with its sandbox ON."""
    from dgc.pip_computer_box import _real_binary
    path = Path("/opt/google/chrome/chrome")
    return path if _real_binary(path) and your_browser.sandbox_ok(path) else None


class _RealStream:
    chrome = None
    flags = ()

    def test_your_own_tab_streams_and_takes_clicks_typing_paste_and_tabs(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-real-own-")
        self.addCleanup(temp.cleanup)
        site = _OwnSite()
        self.addCleanup(site.stop)
        env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
        with patch.dict(os.environ, env, clear=True):
            host = your_browser.YourBrowserHost(Path(temp.name), chrome=self.chrome(), test_flags=self.flags)
            self.addCleanup(host.close)
            host.open(site.url("/form"), None, headless=True)
            self.assertTrue(host.headless)
            host.view_own("size", {"width": 800, "height": 500})
            seq, frames, started = 0, 0, time.monotonic()
            while time.monotonic() - started < 2.0:
                got = host.view_own("frame", {"seq": seq})
                if got.get("image"):
                    frames += 1
                    seq = got["seq"]
            self.assertGreaterEqual(frames / 2.0, 20, f"{frames} frames in 2 s of a page that moves every 30 ms")
            self.assertEqual((got["width"], got["height"]), (800, 500))
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and got.get("title") != "Form":
                got = host.view_own("frame", {"seq": seq})
            self.assertEqual(got["title"], "Form")
            # A click in the field, then typing, a paste and Enter: the page says what it got.
            host.view_own("input", {"events": [{"t": "down", "x": 60, "y": 30, "button": "left", "clicks": 1},
                                               {"t": "up", "x": 60, "y": 30, "button": "left", "clicks": 1}]})
            host.view_own("input", {"events": [{"t": "key", "key": c, "code": f"Key{c.upper()}", "text": c} for c in "hi"]
                                    + [{"t": "text", "text": " pässwörd"}, {"t": "key", "key": "Enter", "code": "Enter"}]})
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and host.view_own("frame", {"seq": 0}).get("title") != "Got: hi pässwörd":
                time.sleep(0.1)
            self.assertEqual(host.view_own("frame", {"seq": 0})["title"], "Got: hi pässwörd")
            first = host.view_own("frame", {"seq": 0})["current"]
            made = host.view_own("new_tab", {})
            self.assertNotEqual(made["current"], first)
            self.assertEqual(len(made["tabs"]), 2)
            host.view_own("close_tab", {"tab": made["current"]})
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and len(host.view_own("frame", {"seq": 0})["tabs"]) != 1:
                time.sleep(0.1)
            self.assertEqual(host.view_own("frame", {"seq": 0})["current"], first)
            self.sandboxed(host)
            host.close()

    def sandboxed(self, host):
        pass


@unittest.skipUnless(_real_chrome(), "needs DGC's downloaded Google Chrome")
class RealHeadless(_RealStream, unittest.TestCase):
    """DGC's downloaded Google Chrome, headless with no display (as over Remote-SSH). This machine's Ubuntu keeps DGC's
    copy from its own sandbox, and there is no password store to unlock here, so the test (only the test) adds
    --no-sandbox and Chrome's own basic store: what is checked is the stream and the person's own hand in it."""
    chrome = staticmethod(_real_chrome)
    flags = ("--no-sandbox", "--password-store=basic")


@unittest.skipUnless(_installed_chrome(), "needs Google Chrome installed from its package")
class RealHeadlessSandboxed(_RealStream, unittest.TestCase):
    """The installed Google Chrome, headless with no display, its sandbox ON (only Chrome's own basic store is the test's:
    there is no password store to unlock here). Chrome's own sandbox page says it is sandboxed."""
    chrome = staticmethod(_installed_chrome)
    flags = ("--password-store=basic",)

    def sandboxed(self, host):
        with host.lock:
            target = host.own_tab()
            session = host.browser._attached[target]
            host.browser._session_call(session, "Page.navigate", {"url": "chrome://sandbox"}, timeout=10)
            text = ""
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and "sandboxed" not in text:
                time.sleep(0.2)
                text = str(host.browser._session_call(session, "Runtime.evaluate", {"expression": "document.body.innerText",
                                                                                      "returnByValue": True}, timeout=10)
                           .get("result", {}).get("value", ""))
        self.assertIn("You are adequately sandboxed", text)


class _OwnSite:
    """/form: a field that puts what was typed into the page's title on Enter, and a clock that moves the page."""

    def __init__(self):
        import http.server

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = ("<title>Form</title><form onsubmit=\"document.title='Got: '+q.value;return false\">"
                        "<input id=q style='position:absolute;left:10px;top:10px;width:300px;height:40px'></form>"
                        "<h1 id=t style='position:absolute;top:80px'>0</h1>"
                        "<script>setInterval(()=>t.textContent=Date.now(),30)</script>").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, path):
        return f"http://127.0.0.1:{self.server.server_address[1]}{path}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


if __name__ == "__main__":
    unittest.main()
