"""Your Browser, phase 3 (0.52, Pips API 107; his calls 17 Nov): its window, the streamed tab's frames and Home's last
visited links.

- "Open Your Browser" opens (or brings forward) the installed Google Chrome with DGC's OWN profile, a real window placed
  to the RIGHT of the editor: from the editor's bounds, which the editor sends (Chrome's own window controls over its
  DevTools pipe, X11's window tools when present, AppleScript on a Mac, and --window-position/--window-size at start).
  What the person types is an address or a Google search. It answers {ok, kind, weaker}.
- The supervisor owns the one window (one Chrome per profile): the editor's command asks it, as a Pip's computer is
  opened. With no Pip lane and no window for 15 minutes it closes (the profile stays).
- use_your_browser_view streams ONE Pip's lane (its own tab): screencast frames, throttled, or a capture where the lane
  is a tab in the background. The person's own tabs are never streamed.
- get_your_browser_recent (R, API 106): the newest three links from the person's OWN tabs, titles and addresses only,
  never a Pip's lane.
- A site the person signed out of is cleared (its cookies and its sign-in hosts') as soon as Your Browser runs.
- On Linux, Your Browser runs only where Chrome's own sandbox can run: where it can't (Ubuntu's user-namespace rule over
  DGC's downloaded copy), it never starts Chrome without its sandbox, and (phase 3b, his call 18 Nov) the answer is the
  one Install Google Chrome button, never a command to paste (tests/test_your_browser_install.py).

Unit tests drive the supervisor's host over a scripted DevTools pipe; the real test opens DGC's downloaded Google
Chrome on a private X display (skipped where there is no such Chrome or no Xvfb)."""
from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pips, your_browser
from dgc.pip_computer_box import PERSON
from tests import test_pips_local as fixtures

REPO = Path(__file__).resolve().parents[1]
TINY_JPEG = ("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQ"
             "kKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABLAAEBAAAAAAAAAAAAAAAAAAAABQEBAAAAAAAAAAAAAAAAAAAABhABAAAAAAAAAAAAAAAAAAAA"
             "ABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAYACAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIIB2Ov/2Q==")
A = "pip_" + "a" * 32


# --------------------------------------------------------------------------- what the person typed, where it opens

class Address(unittest.TestCase):
    def test_an_address_opens_as_itself_and_anything_else_is_a_google_search(self):
        cases = {
            "example.com": "https://example.com",
            "docs.python.org/3/library/": "https://docs.python.org/3/library/",
            "https://news.example.org/a?b=1#c": "https://news.example.org/a?b=1#c",
            "http://plain.example.net/": "http://plain.example.net/",
            "localhost:3000": "http://localhost:3000",
            "192.168.1.20/admin": "http://192.168.1.20/admin",
            "how to cook rice": "https://www.google.com/search?q=how+to+cook+rice",
            "rice": "https://www.google.com/search?q=rice",
            "javascript:alert(1)": "https://www.google.com/search?q=javascript%3Aalert%281%29",
            "file:///etc/passwd": "https://www.google.com/search?q=file%3A%2F%2F%2Fetc%2Fpasswd",
            "https://user:secret@example.com/": "https://www.google.com/search?q=https%3A%2F%2Fuser%3Asecret%40example.com%2F",
            "  example.org  ": "https://example.org",
            "": "",
        }
        for typed, url in cases.items():
            with self.subTest(typed=typed):
                self.assertEqual(your_browser.address(typed), url)


class Placement(unittest.TestCase):
    SCREEN = {"x": 0, "y": 0, "width": 2560, "height": 1440}

    def test_with_room_beside_the_editor_the_window_takes_the_room_on_its_right(self):
        place = your_browser.place_window({"x": 0, "y": 30, "width": 1600, "height": 1400, "screen": self.SCREEN})
        self.assertEqual(place, {"left": 1600, "top": 30, "width": 960, "height": 1400})

    def test_a_full_screen_editor_has_the_window_over_its_right_part(self):
        place = your_browser.place_window({"x": 0, "y": 0, "width": 2560, "height": 1440, "screen": self.SCREEN})
        self.assertEqual(place, {"left": 1408, "top": 0, "width": 1152, "height": 1440})
        self.assertGreaterEqual(place["left"], 0)
        self.assertLessEqual(place["left"] + place["width"], 2560)

    def test_a_second_screen_on_the_left_is_measured_from_its_own_edge(self):
        place = your_browser.place_window({"x": -1920, "y": 0, "width": 1000, "height": 1080,
                                           "screen": {"x": -1920, "y": 0, "width": 1920, "height": 1080}})
        self.assertEqual(place, {"left": -920, "top": 0, "width": 920, "height": 1080})

    def test_without_the_screen_it_stays_inside_the_editor(self):
        place = your_browser.place_window({"x": 100, "y": 50, "width": 1400, "height": 900})
        self.assertEqual((place["left"] + place["width"], place["top"], place["height"]), (1500, 50, 900))

    def test_no_bounds_lets_chrome_place_itself(self):
        self.assertIsNone(your_browser.place_window(None))

    def test_chrome_shows_no_unsupported_flag_bar_and_is_not_marked_as_automated(self):
        # Its window (and the editor's tab, which streams that window) had "You are using an unsupported command-line
        # flag: --disable-blink-features=AutomationControlled. Stability and security will suffer." across the top of
        # every start. The flag stays (Google's sign-in refuses a browser marked as automated); --test-type keeps
        # Chrome's start-up bars away. Checked with the installed Chrome: no bar, navigator.webdriver still false.
        for kind in ({}, {"headless": True}, {"headless": True, "virtual": True}):
            with self.subTest(**kind):
                argv = your_browser.chrome_argv("/usr/bin/google-chrome", Path("/p"), "https://example.com/", **kind)
                self.assertIn("--disable-blink-features=AutomationControlled", argv)
                self.assertIn("--test-type", argv)
                self.assertNotIn("--enable-automation", argv)

    def test_bounds_are_checked(self):
        for bad in ("left", [1, 2], {"x": 0}, {"x": 0, "y": 0, "width": 0, "height": 10},
                    {"x": 0, "y": 0, "width": 10, "height": 10, "screen": "big"},
                    {"x": float("nan"), "y": 0, "width": 10, "height": 10},
                    {"x": 0, "y": 0, "width": 10**7, "height": 10}, {"x": True, "y": 0, "width": 10, "height": 10},
                    {"x": 0, "y": 0, "width": 10, "height": 10, "path": "/etc"}):
            with self.subTest(bad=bad):
                with self.assertRaises(your_browser.RegistryError):
                    your_browser.editor_bounds(bad)
        self.assertEqual(your_browser.editor_bounds({"x": 1.6, "y": 2, "width": 30.2, "height": 40})["x"], 2)


# --------------------------------------------------------------------------- the editor's side

class Base(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        personal = self.registry.personal()["id"]
        self.ava = self.store.create(personal, "Ava", None, "editor-user", pip_type="lens", computer_plan={"schema_version": 1})
        patcher = patch.object(your_browser, "_availability", return_value=(True, "", "installed"))
        patcher.start()
        self.addCleanup(patcher.stop)
        live = patch.object(your_browser, "_runner_live", return_value=True)
        live.start()
        self.addCleanup(live.stop)
        # (A computer with a screen: its window, as phase 3 built it. With none: tests/test_your_browser_own_tab.py.)
        screen = patch.object(your_browser, "has_screen", return_value=True)
        screen.start()
        self.addCleanup(screen.stop)

    def control(self, command, actor="editor-user", **fields):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"type": command, "request_id": "r", **fields}, actor, start_worker=False)

    def ok(self, command, **fields):
        out = self.control(command, **fields)
        self.assertTrue(out["ok"], out)
        return out["result"]

    def waiting(self):
        row = self.registry.db.execute("SELECT value FROM metadata WHERE key=?", (your_browser.OPEN_KEY,)).fetchone()
        return json.loads(row[0]) if row else []


class OpenCommand(Base):
    def test_open_asks_the_supervisor_for_the_window_with_the_address_and_the_editors_bounds(self):
        bounds = {"x": 0, "y": 0, "width": 1600, "height": 1000, "screen": {"x": 0, "y": 0, "width": 2560, "height": 1440}}
        out = self.ok("open_your_browser", url="weather in pune", editor_bounds=bounds)
        self.assertEqual((out["ok"], out["kind"], out["weaker"]), (True, "host_profile", True))
        self.assertEqual(out["url"], "https://www.google.com/search?q=weather+in+pune")
        [asked] = self.waiting()
        self.assertEqual(asked["url"], out["url"])
        self.assertEqual(asked["place"], {"left": 1600, "top": 0, "width": 960, "height": 1000})
        self.assertNotIn("pip_id", asked)

    def test_open_with_nothing_typed_brings_the_window_forward(self):
        out = self.ok("open_your_browser")
        self.assertEqual(out["url"], "")
        self.assertEqual(self.waiting()[0]["url"], "")

    def test_a_pips_tab_is_brought_forward_by_its_id_and_an_unknown_pip_is_refused(self):
        self.ok("open_your_browser", pip_id=self.ava["id"])
        self.assertEqual(self.waiting()[0]["pip_id"], self.ava["id"])
        self.assertEqual(self.control("open_your_browser", pip_id="pip_" + "f" * 32)["error"]["code"], "not_found")

    def test_open_says_why_when_it_cant_run_here(self):
        with patch.object(your_browser, "_availability", return_value=(False, "Install Google Chrome to use Your Browser.", "")):
            out = self.control("open_your_browser", url="example.com")
        self.assertEqual(out["error"]["code"], "unavailable")
        self.assertIn("Install Google Chrome", out["error"]["message"])
        self.assertEqual(self.waiting(), [])

    def test_opening_it_starts_the_pips_runner_when_it_isnt_running(self):
        # Opening it is the person's own ask (as a job a chat hands a Pip is): the runner it opens with starts by itself.
        live = {"on": False}
        with patch.object(your_browser, "_runner_live", side_effect=lambda registry: live["on"]), \
             patch("dgc.pip_jobs.ensure_runner", side_effect=lambda config: live.update(on=True)) as started:
            self.ok("open_your_browser", url="example.com")
        started.assert_called_once()
        self.assertEqual(self.waiting()[0]["url"], "https://example.com")

    def test_an_emergency_stop_is_never_cleared_by_opening_it(self):
        with patch.object(your_browser, "_runner_live", return_value=False), \
             patch("dgc.pip_jobs.ensure_runner", side_effect=pips.RegistryError(
                 "runtime_paused", "Global stop is set. Review and explicitly resume the runner locally.")):
            out = self.control("open_your_browser", url="example.com")
        self.assertEqual(out["error"]["code"], "runtime_paused")
        self.assertEqual(self.waiting(), [])

    def test_a_runner_that_still_isnt_there_is_said_plainly(self):
        with patch.object(your_browser, "_runner_live", return_value=False), patch("dgc.pip_jobs.ensure_runner"):
            out = self.control("open_your_browser", url="example.com")
        self.assertEqual(out["error"]["code"], "runner_required")
        self.assertIn("runner", out["error"]["message"])
        self.assertEqual(self.waiting(), [])

    def test_open_keeps_at_most_a_few_asks_and_refuses_bad_bounds(self):
        for n in range(9):
            self.ok("open_your_browser", url=f"example{n}.com")
        self.assertEqual([a["url"] for a in self.waiting()], [f"https://example{n}.com" for n in range(4, 9)])
        self.assertEqual(self.control("open_your_browser", editor_bounds={"x": "a"})["error"]["code"], "invalid_request")

    def test_open_and_the_recent_links_are_local_only(self):
        for command in ("open_your_browser", "get_your_browser_recent"):
            with self.subTest(command=command):
                self.assertEqual(self.control(command, actor="device_paired_phone")["error"]["code"], "local_only")


class SupervisorTick(Base):
    """The supervisor's heartbeat opens what was asked, once, and tells get_your_browser how it went."""

    def test_the_tick_opens_each_ask_once_and_a_failure_is_shown(self):
        opened = []

        class FakeHost:
            error = ""

            def open(self, url, place, pip_id=None, *, headless=False):
                opened.append((url, place, pip_id))
                if url.endswith("broken.example"):
                    raise your_browser.BoxError("Your Browser didn't start: its window never opened")

            def tick(self, registry):
                with registry.transaction():
                    registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (your_browser.STATE_KEY, json.dumps(
                        {"open": False, "tabs": [], "lanes": [], "error": self.error})))

        host = FakeHost()
        bounds = {"x": 0, "y": 0, "width": 1600, "height": 1000, "screen": {"x": 0, "y": 0, "width": 2560, "height": 1440}}
        self.ok("open_your_browser", url="example.com", editor_bounds=bounds)
        self.ok("open_your_browser", url="https://broken.example")
        with patch.object(your_browser, "host_for", return_value=host), patch.dict(your_browser.HOSTS, {}, clear=True):
            your_browser.tick(self.registry)
            your_browser.tick(self.registry)
        self.assertEqual(opened, [("https://example.com", {"left": 1600, "top": 0, "width": 960, "height": 1000}, None),
                                  ("https://broken.example", None, None)])
        self.assertEqual(self.waiting(), [])
        self.assertIn("never opened", self.ok("get_your_browser")["yours"]["error"])

    def test_with_nothing_asked_and_no_window_the_tick_starts_nothing(self):
        with patch.object(your_browser, "host_for") as made, patch.dict(your_browser.HOSTS, {}, clear=True):
            your_browser.tick(self.registry)
        made.assert_not_called()

    def test_the_supervisor_heartbeat_calls_it(self):
        source = (REPO / "dgc" / "pip_daemon.py").read_text(encoding="utf-8")
        self.assertIn("_your_browser_tick(registry)", source)
        from dgc import pip_daemon
        with patch.object(your_browser, "tick", side_effect=RuntimeError("boom")):
            pip_daemon._your_browser_tick(self.registry)          # never stops the supervisor


class RecentLinks(Base):
    def write(self, links):
        path = your_browser.folder(self.registry.directory) / your_browser.RECENT_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"links": links}))

    def test_the_newest_three_links_titles_and_addresses_only(self):
        self.write([{"url": f"https://site{n}.example.com/p", "title": f"Page {n}", "at": f"2026-11-18T0{n}:00:00Z"}
                    for n in range(5)])
        got = self.ok("get_your_browser_recent")
        self.assertEqual([l["url"] for l in got["links"]], [f"https://site{n}.example.com/p" for n in range(3)])
        self.assertEqual(set(got["links"][0]), {"url", "title", "host", "at"})
        self.assertEqual(got["lanes"], [], "no Pip works there yet")
        self.assertEqual(got["links"][0]["host"], "site0.example.com")
        self.assertEqual((got["available"], got["reason"], got["open"]), (True, "", False))

    def test_a_file_that_isnt_right_gives_nothing_and_a_bad_row_is_left_out(self):
        self.assertEqual(self.ok("get_your_browser_recent")["links"], [])
        self.write([{"url": "javascript:alert(1)", "title": "x"}, {"url": "https://ok.example.com/", "title": 5},
                    "nope", {"url": "https://fine.example.com/", "title": "Fine", "at": "2026-11-18T01:00:00Z"}])
        self.assertEqual([l["url"] for l in self.ok("get_your_browser_recent")["links"]], ["https://fine.example.com/"])
        path = your_browser.folder(self.registry.directory) / your_browser.RECENT_FILE
        path.write_text("{not json")
        self.assertEqual(self.ok("get_your_browser_recent")["links"], [])

    def test_a_link_carries_its_sites_icon_only_as_a_small_picture(self):
        # (His 22 Nov ask: Home's Browser card shows each visited site's own icon, not a globe.)
        png = "data:image/png;base64," + "iVBORw0KGgo" + "A" * 40
        self.write([{"url": "https://a.example.com/", "title": "A", "icon": png},
                    {"url": "https://b.example.com/", "title": "B", "icon": "javascript:alert(1)"},
                    {"url": "https://c.example.com/", "title": "C", "icon": "https://c.example.com/fav.png"},
                    {"url": "https://d.example.com/", "title": "D", "icon": "data:text/html;base64,PHNjcmlwdD4="},
                    {"url": "https://e.example.com/", "title": "E",
                     "icon": "data:image/png;base64," + "A" * (your_browser.RECENT_ICON_CHARS + 1)}])
        links = your_browser.recent_links(self.registry.directory, 5)
        self.assertEqual([l.get("icon") for l in links], [png, None, None, None, None])
        self.assertNotIn("icon", links[1], "no icon: no field (Home draws the globe)")


class ItSaysWhatItIs(Base):
    def test_get_your_browser_shows_the_window_the_persons_tabs_and_the_lanes_from_the_supervisor(self):
        state = {"open": True, "error": "", "tabs": [{"title": "News", "url": "https://news.example.org/"}],
                 "lanes": [{"pip_id": self.ava["id"], "title": "Shop", "url": "https://shop.example.com/"}]}
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (your_browser.STATE_KEY, json.dumps(state)))
        live = patch.object(your_browser, "_runner_live", return_value=True)      # (the supervisor that said it runs)
        live.start()
        self.addCleanup(live.stop)
        got = self.ok("get_your_browser")
        self.assertEqual(got["yours"], {"open": True, "tabs": state["tabs"], "error": ""})
        self.assertEqual(got["lanes"], [{"pip_id": self.ava["id"], "name": "Ava", "title": "Shop",
                                         "url": "https://shop.example.com/", "working": False}],
                         "(working: whether its run is on its tab now; an older supervisor's word says nothing: not working)")
        self.assertEqual(self.ok("get_your_browser_recent")["lanes"], got["lanes"], "the dock's menu offers to watch it")


class ViewCommand(Base):
    def test_the_view_is_one_pips_lane_never_your_own_tabs(self):
        out = self.control("use_your_browser_view", op="frame")
        self.assertEqual(out["error"]["code"], "invalid_request")
        self.assertIn("Pip", out["error"]["message"])

    def test_with_your_browser_closed_the_view_says_so(self):
        got = self.ok("use_your_browser_view", op="frame", pip_id=self.ava["id"])
        self.assertEqual((got["ok"], got.get("closed")), (False, True))


# --------------------------------------------------------------------------- the supervisor's host, over a scripted pipe

class ChromePipe:
    """Google Chrome's DevTools pipe, scripted: the person's window with one tab, new tabs, windows and pictures."""

    def __init__(self, person_url="https://news.example.org/"):
        self.sent, self.inbox, self.targets, self.n = [], [], {}, 0
        self.person_url = person_url
        self.closed = False

    def settimeout(self, timeout):
        pass

    def attach(self, target, url, *, kind="page", opener=""):
        self.n += 1
        session = f"S{self.n}"
        self.targets[target] = session
        info = {"targetId": target, "type": kind, "url": url, "title": "", **({"openerId": opener} if opener else {})}
        self.inbox.append({"method": "Target.attachedToTarget", "params": {"sessionId": session, "targetInfo": info,
                                                                            "waitingForDebugger": False}})
        return session

    def info(self, target, url, title, kind="page", opener=""):
        info = {"targetId": target, "type": kind, "url": url, "title": title, **({"openerId": opener} if opener else {})}
        self.inbox.append({"method": "Target.targetInfoChanged", "params": {"targetInfo": info}})

    def send(self, payload):
        self.sent.append(payload)
        method, params, result = payload.get("method"), payload.get("params") or {}, {}
        if method == "Target.setAutoAttach" and not payload.get("sessionId") and "P1" not in self.targets:
            self.attach("P1", self.person_url)
        elif method == "Target.createTarget":
            self.n += 1
            target = f"T{self.n}"
            result = {"targetId": target}
            self.attach(target, params.get("url", "about:blank"))
        elif method == "Browser.getWindowForTarget":
            result = {"windowId": 7, "bounds": {"left": 0, "top": 0, "width": 800, "height": 600, "windowState": "normal"}}
        elif method == "Page.captureScreenshot":
            result = {"data": TINY_JPEG}
        elif method == "Storage.getCookies":
            result = {"cookies": [{"name": "sid", "domain": ".example-notes.com", "path": "/"},
                                  {"name": "sso", "domain": "accounts.example-idp.com", "path": "/"},
                                  {"name": "keep", "domain": ".other.example.com", "path": "/"}]}
        elif method == "Page.getNavigationHistory":
            result = {"currentIndex": 1, "entries": [{"id": 1, "url": "https://shop.example.com/a"},
                                                      {"id": 2, "url": "https://shop.example.com/b"}]}
        if "id" in payload:
            reply = {"id": payload["id"], "result": result}
            if payload.get("sessionId"):
                reply["sessionId"] = payload["sessionId"]
            self.inbox.append(reply)

    def recv(self):
        if self.inbox:
            return self.inbox.pop(0)
        raise socket.timeout("quiet")

    def close(self):
        self.closed = True

    def calls(self, method, session=None):
        return [m for m in self.sent if m.get("method") == method and (session is None or m.get("sessionId") == session)]


class FakeProcess:
    pid = 4242

    def __init__(self):
        self.code = None

    def poll(self):
        return self.code


class Host(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-host-")
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.pipe = ChromePipe()
        self.launched = []
        self.commands = []
        self.now = [1000.0]

        def launch(argv, env, log_path):
            self.launched.append((argv, env))
            self.process = FakeProcess()
            return self.process, self.pipe

        # (A computer with a screen: its window. With none, Chrome runs headless: tests/test_your_browser_own_tab.py.)
        screen = patch.object(your_browser, "has_screen", return_value=True)
        screen.start()
        self.addCleanup(screen.stop)
        self.host = your_browser.YourBrowserHost(self.directory, chrome=Path("/opt/google/chrome/chrome"), launch=launch,
                                                 run=lambda argv, **kw: self.commands.append(argv),
                                                 which=lambda name: None, platform="linux",
                                                 clock=lambda: self.now[0], pump_thread=False)
        self.addCleanup(self.host.close)

    def flags(self):
        return self.launched[-1][0]

    def pump(self):
        with self.host.lock:
            self.host.browser._pump(0.01)
            self.host.after_pump()


class Launch(Host):
    def test_it_opens_googles_chrome_with_dgcs_own_profile_as_a_real_window(self):
        place = {"left": 1600, "top": 0, "width": 960, "height": 1000}
        out = self.host.open("https://example.com/", place)
        self.assertTrue(out["opened"])
        argv = self.flags()
        self.assertEqual(argv[0], "/opt/google/chrome/chrome")
        self.assertIn("--remote-debugging-pipe", argv)
        self.assertIn(f"--user-data-dir={self.directory / 'your-browser' / 'profile'}", argv)
        self.assertIn("--window-position=1600,0", argv)
        self.assertIn("--window-size=960,1000", argv)
        self.assertEqual(argv[-1], "https://example.com/")
        for never in ("--no-sandbox", "--headless=new", "--disable-sync", "--disable-extensions", "--enable-automation",
                      "--remote-debugging-port=0", "--password-store=basic"):
            with self.subTest(never=never):
                self.assertNotIn(never, argv, "full Chrome: its sandbox, sync, extensions and password store stay on")
        prefs = json.loads((self.directory / "your-browser" / "profile" / "Default" / "Preferences").read_text())
        self.assertEqual(prefs["profile"]["cookie_controls_mode"], 1, "third-party cookies off before it starts")
        self.assertEqual(self.pipe.calls("Browser.setWindowBounds")[-1]["params"]["bounds"],
                         {"left": 1600, "top": 0, "width": 960, "height": 1000})

    def test_its_environment_carries_the_screen_and_the_session_bus_but_not_your_keys(self):
        with patch.dict(os.environ, {"DISPLAY": ":5", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/bus", "XAUTHORITY": "/x",
                                     "OPENAI_API_KEY": "sk-secret", "DGC_TOKEN": "t"}):
            self.host.open("", None)
        env = self.launched[-1][1]
        self.assertEqual((env["DISPLAY"], env["DBUS_SESSION_BUS_ADDRESS"], env["XAUTHORITY"]), (":5", "unix:path=/run/bus", "/x"))
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("DGC_TOKEN", env)

    def test_open_again_adds_a_tab_of_yours_in_front_and_places_the_window_once_more(self):
        self.host.open("", None)
        self.host.open("https://docs.example.org/", {"left": 10, "top": 20, "width": 900, "height": 800})
        self.assertEqual(len(self.launched), 1, "one Chrome per profile")
        made = self.pipe.calls("Target.createTarget")[-1]["params"]
        self.assertEqual(made["url"], "https://docs.example.org/")
        self.assertNotIn("background", made, "the person's own tab comes to the front")
        bounds = self.pipe.calls("Browser.setWindowBounds")
        self.assertEqual(bounds[-1]["params"]["bounds"], {"left": 10, "top": 20, "width": 900, "height": 800})
        self.assertEqual(bounds[-2]["params"]["bounds"], {"windowState": "normal"}, "a minimised window comes back first")

    def test_open_with_nothing_typed_brings_your_window_forward(self):
        self.host.open("", None)
        self.host.open("", None)
        self.assertEqual(self.pipe.calls("Target.activateTarget")[-1]["params"], {"targetId": "P1"})
        self.assertEqual(self.pipe.calls("Target.createTarget"), [], "no new tab when nothing was typed")

    def test_a_pips_tab_is_brought_forward_only_when_it_has_one(self):
        self.host.open("", None)
        lane = self.host.open_lane(A, "https://shop.example.com/", your_browser.Grants(["example.com"]))
        self.host.open("", None, pip_id=A)
        self.assertEqual(self.pipe.calls("Target.activateTarget")[-1]["params"], {"targetId": lane})
        with self.assertRaises(your_browser.RegistryError):
            self.host.open("", None, pip_id="pip_" + "e" * 32)

    def test_dgc_never_drives_your_own_tab(self):
        self.host.open("", None)
        with self.assertRaises(your_browser.BrowserError):
            self.host.browser.navigate("https://elsewhere.example/")
        self.assertEqual(self.pipe.calls("Page.navigate"), [])

    def test_on_x11_the_window_is_raised_by_its_process_and_on_a_mac_by_applescript(self):
        self.host.which = lambda name: "/usr/bin/xdotool" if name == "xdotool" else None
        with patch.dict(os.environ, {"DISPLAY": ":5"}):
            self.host.open("", {"left": 1, "top": 2, "width": 800, "height": 600})
        self.assertIn(["xdotool", "search", "--onlyvisible", "--pid", "4242", "windowactivate"], self.commands)
        self.commands.clear()
        self.host.platform = "darwin"
        self.host.which = lambda name: "/usr/bin/osascript" if name == "osascript" else None
        self.host.open("", {"left": 1, "top": 2, "width": 800, "height": 600})
        [script] = [c for c in self.commands if c[0] == "osascript"]
        said = " ".join(script)
        self.assertIn("unix id is 4242", said)
        self.assertIn("set frontmost", said)
        self.assertIn("{1, 2}", said)
        self.assertIn("{800, 600}", said)


class Recent(Host):
    def test_your_own_tabs_are_noted_newest_first_and_a_pips_lane_never_is(self):
        self.host.open("", None)
        self.pump()
        self.pipe.info("P1", "https://news.example.org/today", "Today's news")
        self.pump()
        self.host.open_lane(A, "https://shop.example.com/cart", your_browser.Grants(["example.com"]))
        lane = next(t for t, s in self.pipe.targets.items() if t != "P1")
        self.pipe.info(lane, "https://shop.example.com/cart", "Your cart")
        self.pipe.info("P1", "https://mail.example.net/inbox", "Inbox (3)")
        self.pipe.info("P1", "chrome://settings/", "Settings")
        self.pipe.info("P1", "https://news.example.org/today", "Today's news, updated")
        self.pump()
        self.now[0] += 5
        self.pump()
        links = your_browser.recent_links(self.directory, 3)
        self.assertEqual([(l["url"], l["title"]) for l in links],
                         [("https://news.example.org/today", "Today's news, updated"),
                          ("https://mail.example.net/inbox", "Inbox (3)"), ("https://news.example.org/", "")])
        self.assertNotIn("shop.example.com", json.dumps(links))

    def test_a_visit_in_the_window_brings_its_sites_icon_to_homes_card(self):
        # (22 Nov: the streamed tab looked the icons up while it drew; the window beside the editor never did, and
        # Home's card showed globes.) Asked off Chrome's own message loop; the site's page says where its icon is.
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
        self.host.fetch_icon = lambda url: (fetched.append(url) or (b"\x89PNG\r\n\x1a\n" + b"0" * 40, "image/png"))
        self.host.icon_wait = True                    # (the lookup and the download at once here, not in threads)
        self.host.open("", None)
        self.pump()
        self.pipe.info("P1", "https://news.example.org/today", "Today's news")
        self.pump()
        for _ in range(100):                          # (the lookup runs in its own thread: pumped until it lands)
            if fetched and self.host.recent.links and self.host.recent.links[0].get("icon"):
                break
            time.sleep(0.02)
            self.pump()
        self.assertEqual(fetched, ["https://news.example.org/fav.png"])
        link = next(l for l in self.host.recent.links if l["url"] == "https://news.example.org/today")
        self.assertTrue(link.get("icon", "").startswith("data:image/png;base64,"), link)
        self.pipe.info("P1", "https://news.example.org/sport", "Sport")
        for _ in range(20):
            time.sleep(0.02)
            self.pump()
        self.assertEqual(len(fetched), 1, "the site's other pages wear the icon it has")
        self.assertTrue(self.host.recent.links[0].get("icon"), self.host.recent.links[0])

    def test_a_popup_from_a_lane_is_the_lanes_and_never_noted(self):
        self.host.open("", None)
        lane = self.host.open_lane(A, "https://shop.example.com/", your_browser.Grants(["example.com"]))
        self.pipe.info("POP", "https://pay.example.com/checkout", "Pay", opener=lane)
        self.pipe.attach("POP", "https://pay.example.com/checkout", opener=lane)
        self.pump()
        self.now[0] += 5
        self.pump()
        self.assertNotIn("pay.example.com", json.dumps(your_browser.recent_links(self.directory, 10)))


class Idle(Host):
    def test_with_no_window_and_no_lane_it_closes_after_fifteen_minutes(self):
        self.host.open("", None)
        self.pipe.inbox.append({"method": "Target.detachedFromTarget", "params": {"sessionId": "S1", "targetId": "P1"}})
        self.pump()
        self.host.tick(None)
        self.now[0] += your_browser.IDLE_SECONDS - 1
        self.host.tick(None)
        self.assertEqual(self.pipe.calls("Browser.close"), [])
        self.now[0] += 2
        self.host.tick(None)
        self.assertEqual(len(self.pipe.calls("Browser.close")), 1)
        self.assertFalse(self.host.running())

    def test_a_window_or_a_lane_keeps_it_open(self):
        self.host.open("", None)
        for _ in range(3):
            self.now[0] += your_browser.IDLE_SECONDS
            self.host.tick(None)
        self.assertEqual(self.pipe.calls("Browser.close"), [], "your window is open")


class View(Host):
    def setUp(self):
        super().setUp()
        self.host.open("", None)
        self.lane = self.host.open_lane(A, "https://shop.example.com/", your_browser.Grants(["example.com"]))
        self.session = self.pipe.targets[self.lane]

    def test_a_frame_is_the_lanes_own_picture_with_its_address_and_title(self):
        self.pipe.info(self.lane, "https://shop.example.com/cart", "Your cart")
        self.pump()
        got = self.host.view(A, "frame", {})
        self.assertTrue(got["ok"], got)
        self.assertEqual((got["url"], got["title"], got["width"], got["height"]), ("https://shop.example.com/cart", "Your cart", 8, 6))
        self.assertTrue(got["image"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(self.pipe.calls("Page.startScreencast", self.session)[0]["params"]["format"], "jpeg")
        captured = self.pipe.calls("Page.captureScreenshot")
        self.assertTrue(captured and all(c["sessionId"] == self.session for c in captured), "only the lane is pictured")

    def test_frames_are_throttled_and_a_screencast_frame_is_used_while_it_is_fresh(self):
        self.host.view(A, "frame", {})
        self.host.view(A, "frame", {})
        self.assertEqual(len(self.pipe.calls("Page.captureScreenshot")), 1, "at most four frames a second")
        self.pipe.inbox.append({"method": "Page.screencastFrame", "sessionId": self.session,
                                "params": {"data": TINY_JPEG, "sessionId": 3, "metadata": {"deviceWidth": 8, "deviceHeight": 6}}})
        self.pump()
        self.now[0] += 1
        self.host.view(A, "frame", {})
        self.assertEqual(len(self.pipe.calls("Page.captureScreenshot")), 1)
        self.assertEqual(self.pipe.calls("Page.screencastFrameAck", self.session)[-1]["params"], {"sessionId": 3})

    def test_your_own_tabs_and_a_pip_without_a_lane_are_never_streamed(self):
        got = self.host.view("pip_" + "e" * 32, "frame", {})
        self.assertFalse(got["ok"])
        self.assertIn("no tab", got["error"])
        self.assertNotIn("S1", [c.get("sessionId") for c in self.pipe.calls("Page.captureScreenshot")])

    def test_go_stays_on_the_pips_sites_and_back_uses_the_lanes_history(self):
        before = len(self.pipe.calls("Page.navigate", self.session))
        refused = self.host.view(A, "go", {"url": "https://elsewhere.org/"})
        self.assertFalse(refused["ok"])
        self.assertIn("example.com", refused["error"])
        self.assertEqual(len(self.pipe.calls("Page.navigate", self.session)), before)
        self.host.view(A, "go", {"url": "shop.example.com/b"})
        self.assertEqual(self.pipe.calls("Page.navigate", self.session)[-1]["params"]["url"], "https://shop.example.com/b")
        self.host.view(A, "back", {})
        self.assertEqual(self.pipe.calls("Page.navigateToHistoryEntry", self.session)[-1]["params"], {"entryId": 1})

    def test_your_own_click_in_a_pips_tab_sends_what_it_caused_and_nothing_else_is_sent(self):
        self.host.view(A, "click", {"x": 10, "y": 20})
        clicks = self.pipe.calls("Input.dispatchMouseEvent", self.session)
        self.assertTrue(clicks, "the click goes to the lane, never your tab")
        held = your_browser.HeldWrite("r1", self.session, "POST", "https://shop.example.com/cart", [], 0, time.time(), owner=A)
        self.host.browser.held["r1"] = held
        self.host.write_held(held)
        self.assertEqual(self.pipe.calls("Fetch.continueRequest", self.session)[-1]["params"], {"requestId": "r1"})
        self.now[0] += 60
        later = your_browser.HeldWrite("r2", self.session, "POST", "https://shop.example.com/cart", [], 0, time.time(), owner=A)
        self.host.browser.held["r2"] = later
        self.host.write_held(later)
        self.assertEqual(self.pipe.calls("Fetch.failRequest", self.session)[-1]["params"]["requestId"], "r2",
                         "no Pip's run reaches its lane yet: a write it causes alone is never sent")


class SignOut(Host):
    def test_a_site_signed_out_of_is_cleared_when_your_browser_runs_and_other_sites_stay(self):
        fixtures.LocalPipsTests.setUp(self)
        registry = self.registry
        your_browser.notice_site(registry, "app.example-notes.com", sso_hosts=["accounts.example-idp.com"])
        your_browser.sign_out_site(registry, "example-notes.com", "editor-user")
        self.host.open("", None)
        self.host.tick(registry)
        deleted = [c["params"] for c in self.pipe.calls("Network.deleteCookies") + self.pipe.calls("Storage.deleteCookies")]
        names = {(d.get("name"), d.get("domain")) for d in deleted}
        self.assertIn(("sid", ".example-notes.com"), names)
        self.assertIn(("sso", "accounts.example-idp.com"), names)
        self.assertNotIn(("keep", ".other.example.com"), names)
        self.assertEqual(your_browser.signing_out(registry), [], "cleared: nothing waits any more")


# --------------------------------------------------------------------------- the sandbox rule on Linux

class Sandbox(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-sandbox-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.chrome = self.root / "desktop" / "arm64" / "v-1" / "root" / "opt" / "google" / "chrome" / "chrome"
        self.chrome.parent.mkdir(parents=True)
        self.chrome.write_bytes(b"\x7fELF")
        (self.chrome.parent / "chrome-sandbox").write_bytes(b"\x7fELF")
        self.apparmor = self.root / "apparmor.d"
        self.apparmor.mkdir()

    def check(self, restrict="1"):
        knobs = {"/proc/sys/kernel/apparmor_restrict_unprivileged_userns": restrict, "/proc/sys/kernel/unprivileged_userns_clone": "1"}
        return your_browser.sandbox_ok(self.chrome, knobs=knobs, apparmor=self.apparmor, platform="linux")

    def test_where_user_namespaces_are_open_chromes_sandbox_runs(self):
        self.assertIs(self.check("0"), True)

    def test_where_ubuntu_restricts_them_and_nothing_lets_dgcs_copy_it_cant_run(self):
        self.assertIs(self.check(), False)

    def test_a_profile_naming_the_program_lets_it_run(self):
        (self.apparmor / "chrome").write_text(
            f'abi <abi/4.0>,\nprofile chrome "{self.chrome}" flags=(unconfined) {{\n  userns,\n}}\n')
        self.assertIs(self.check(), True)

    def test_the_availability_never_says_a_command_and_never_starts_chrome_without_its_sandbox(self):
        with patch.object(your_browser, "find_chrome", return_value=(self.chrome, "dgc_copy")), \
                patch.object(your_browser, "sandbox_ok", return_value=False), \
                patch.object(your_browser.sys, "platform", "linux"):
            available, reason, _ = your_browser._availability()
        self.assertFalse(available)
        self.assertIn(reason, (your_browser.NEEDS_CHROME, your_browser.GET_CHROME))
        self.assertNotIn("sudo", reason)
        source = (REPO / "dgc" / "your_browser.py").read_text(encoding="utf-8")
        self.assertNotIn('"--no-sandbox"', source)

    def test_with_no_screen_it_runs_headless_now(self):
        with patch.object(your_browser, "find_chrome", return_value=(self.chrome, "installed")), \
                patch.object(your_browser, "sandbox_ok", return_value=True), \
                patch.object(your_browser, "has_screen", return_value=False), \
                patch.object(your_browser.sys, "platform", "linux"):
            available, reason, _ = your_browser._availability()
        self.assertEqual((available, reason), (True, ""), "over Remote-SSH: your own tab, streamed (his call, 18 Nov)")


# --------------------------------------------------------------------------- API 107

class Api107(unittest.TestCase):
    def test_the_api_is_107_and_the_new_command_and_field_are_known(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 107)
        self.assertIn("get_your_browser_recent", pips.CONTROL_COMMANDS)
        self.assertEqual(pips._COMMAND_ARGS["get_your_browser_recent"], set())
        self.assertIn("editor_bounds", pips._COMMAND_ARGS["open_your_browser"])
        for command in your_browser.COMMANDS:
            with self.subTest(command=command):
                self.assertEqual(pips._COMMAND_ARGS[command], your_browser.COMMAND_ARGS[command])
        self.assertIn("frame", your_browser.VIEW_OPS)

    def test_pips_md_row_107_names_the_command_and_the_field(self):
        text = (REPO / "sdk" / "PIPS.md").read_text(encoding="utf-8")
        row = next((line for line in text.splitlines() if line.startswith("| 107 |")), "")
        for word in ("get_your_browser_recent", "editor_bounds", "open_your_browser", "use_your_browser_view", "frame"):
            with self.subTest(word=word):
                self.assertIn(word, row)


# --------------------------------------------------------------------------- real Google Chrome on a private screen

def _real_chrome():
    """DGC's downloaded Google Chrome: this home's, or (a suite run gives each test a fresh HOME) the user's own, read
    only."""
    try:
        from dgc import pip_screen_setup
        path = pip_screen_setup.chrome_path()
    except Exception:                                       # noqa: BLE001
        path = None
    if path is not None and Path(path).is_file():
        return Path(path)
    import pwd
    found = sorted(Path(pwd.getpwuid(os.getuid()).pw_dir).glob(".dgc/desktop/*/current/root/opt/google/chrome/chrome"))
    return found[0] if found else None


@unittest.skipUnless(_real_chrome() and shutil.which("Xvfb"), "needs DGC's downloaded Google Chrome and Xvfb")
class RealWindow(unittest.TestCase):
    """Real Google Chrome on a private X display. This machine's Ubuntu keeps DGC's copy from its own sandbox until the
    person runs the one command, and a private display has no unlocked password store (Chrome waits for one before it
    loads a page), so the test (only the test) starts it with the sandbox off and Chrome's own basic store: what is
    checked here is the window, the pipe and the lane's frames, never the sandbox or the store."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-real-")
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        display = None
        for n in range(240, 260):
            if not Path(f"/tmp/.X11-unix/X{n}").exists():
                display = n
                break
        if display is None:
            self.skipTest("no free X display")
        self.xvfb = subprocess.Popen(["Xvfb", f":{display}", "-screen", "0", "1600x1000x24", "-nolisten", "tcp"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self._stop_xvfb)
        for _ in range(50):
            if Path(f"/tmp/.X11-unix/X{display}").exists():
                break
            time.sleep(0.1)
        self.env = patch.dict(os.environ, {"DISPLAY": f":{display}"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def _stop_xvfb(self):
        self.xvfb.terminate()
        try:
            self.xvfb.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.xvfb.kill()

    def test_the_window_opens_on_the_right_your_tab_is_noted_and_a_lanes_frames_stream(self):
        site = _Site()
        self.addCleanup(site.stop)
        host = your_browser.YourBrowserHost(self.directory, chrome=_real_chrome(), test_flags=("--no-sandbox", "--password-store=basic"))
        self.addCleanup(host.close)
        place = your_browser.place_window({"x": 0, "y": 0, "width": 900, "height": 1000,
                                           "screen": {"x": 0, "y": 0, "width": 1600, "height": 1000}})
        host.open(site.url("/mine"), place)
        with host.lock:
            window = host.browser._browser_call("Browser.getWindowForTarget", {"targetId": host.person_tabs()[0]})
        self.assertEqual((window["bounds"]["left"], window["bounds"]["width"]), (900, 700))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and [l["title"] for l in your_browser.recent_links(self.directory, 1)] != ["Mine"]:
            time.sleep(0.3)                  # (its title comes a moment after its address)
        links = your_browser.recent_links(self.directory, 3)
        self.assertTrue(links and links[0]["url"].endswith("/mine"), links)
        self.assertEqual(links[0]["title"], "Mine")
        # (A lane never opens a page on this computer: its grants admit only public sites. Here, with no grants, it is
        # not confined, so the local page loads; what is checked is its frames.)
        lane = host.open_lane(A, site.url("/lane"), None)
        self.assertTrue(lane)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and [l["title"] for l in host.lanes()] != ["Lane"]:
            time.sleep(0.2)                  # (the streamed tab asks again until its page is there)
        first = host.view(A, "frame", {})
        self.assertTrue(first["ok"], first)
        self.assertGreater(first["width"], 100)
        time.sleep(1.2)
        second = host.view(A, "frame", {})
        self.assertNotEqual(first["image"], second["image"], "the lane's picture moves with its page")
        self.assertNotIn("/lane", json.dumps(your_browser.recent_links(self.directory, 10)), "a lane is never noted")
        host.close()
        self.assertFalse(host.running())


class _Site:
    """A local site: /mine (the person's page) and /lane (a page whose clock ticks)."""

    def __init__(self):
        import http.server

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = (b"<title>Mine</title><h1>Your page</h1>" if self.path.startswith("/mine") else
                        b"<title>Lane</title><h1 id=t>0</h1><script>setInterval(()=>t.textContent=Date.now(),40)</script>")
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
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
