"""Your Browser (0.52): the sites Pips may use there, noticed from the person's own sign-ins and changed in one
panel; and a Pip's tab that works on a computer with a screen.

- A site the person signs in to in Your Browser joins the list by itself: a bank or a payment site
  starts at "Ask me which Pips" (no Pip until chosen), every other site at All Pips. Only the person's own sign-in counts:
  a password they typed themselves and sent from their own tab (a page can't fake that: DGC's watcher lives in its own world
  of their pages and counts only their own key presses and clicks). Never a Pip's lane, never a site on this computer or the
  local network. A sign-in through another site's sign-in host (accounts.example-idp.com) adds that exact host to the site.
- A noticed site says "new" until the person opens the panel (seen_your_browser_sites, Pips API 113, local only).
- get_your_browser lists the Pips the person can choose; get_your_browser_recent says how many sites are new.
- On a computer with a screen a Pip's lane is a tab in the background of the person's window, which Chrome neither draws
  nor hands input to: its steps act inside the page instead (a click, typing, a key, a scroll), each as quick as a step
  in the front, and what they send is held exactly as before. Its Watch says where to watch it instead of a stale picture.

Stand-in Chrome for most; the installed Google Chrome for a real sign-in in the person's own tab and for a lane in the
background of a real window (skipped where it isn't installed)."""
from __future__ import annotations

import http.server
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_computer, pips, your_browser
from dgc.pip_computer_box import PERSON
from tests import test_pips_local as fixtures
from tests.test_your_browser_runs import FakeProcess, LaneBase, SHOP, StandIn


class Sites(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        personal = self.registry.personal()["id"]
        self.ava = self.store.create(personal, "Ava", None, "editor-user", pip_type="lens", computer_plan={"schema_version": 1})
        self.ben = self.store.create(personal, "Ben", None, "editor-user", pip_type="lens", computer_plan={"schema_version": 1})

    def control(self, command, actor="editor-user", **fields):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"type": command, "request_id": "r", **fields}, actor, start_worker=False)

    def ok(self, command, **fields):
        out = self.control(command, **fields)
        self.assertTrue(out["ok"], out)
        return out["result"]


class NewSites(Sites):
    def test_a_noticed_site_is_new_until_the_person_opens_the_panel(self):
        your_browser.notice_site(self.registry, "mail.example-mail.com")
        your_browser.allow_pip_site(self.registry, "shop.lanestore.com", self.ava["id"], "editor-user")
        got = {s["site"]: s for s in self.ok("get_your_browser")["sites"]}
        self.assertTrue(got["example-mail.com"]["new"], "noticed from a sign-in: new")
        self.assertFalse(got["lanestore.com"]["new"], "added by the person's own Allow: not new")
        self.assertEqual(self.ok("get_your_browser_recent")["new_sites"], 1)
        self.assertEqual(self.ok("seen_your_browser_sites"), {"ok": True})
        got = {s["site"]: s for s in self.ok("get_your_browser")["sites"]}
        self.assertFalse(got["example-mail.com"]["new"])
        self.assertEqual(self.ok("get_your_browser_recent")["new_sites"], 0)
        with patch.object(self.registry, "clock", return_value="2026-10-02T10:00:00.000Z"):
            your_browser.notice_site(self.registry, "app.example-notes.com")
        got = {s["site"]: s for s in self.ok("get_your_browser")["sites"]}
        self.assertTrue(got["example-notes.com"]["new"], "a site noticed after the panel was open is new again")
        self.assertFalse(got["example-mail.com"]["new"])

    def test_seen_is_the_persons_own_and_takes_nothing(self):
        for actor in ("local-computer", "device_1"):
            out = self.control("seen_your_browser_sites", actor=actor)
            self.assertFalse(out["ok"])
            self.assertEqual(out["error"]["code"], "local_only")
        out = self.control("seen_your_browser_sites", site="example.com")
        self.assertFalse(out["ok"], "it takes nothing")

    def test_get_lists_the_pips_to_choose_from_never_an_archived_one(self):
        archived = self.store.create(self.registry.personal()["id"], "Old", None, "editor-user", pip_type="lens")
        with self.registry.transaction():
            self.registry.db.execute("UPDATE pips SET status='archived' WHERE id=?", (archived["id"],))
        pips_listed = self.ok("get_your_browser")["pips"]
        self.assertEqual([p["name"] for p in pips_listed], ["Ava", "Ben"])
        self.assertEqual(set(pips_listed[0]), {"pip_id", "name"})

    def test_the_api_is_113_and_the_sdks_know_seen(self):
        from dgc import headless
        self.assertEqual(headless.PIPS_API_VERSION, 113)
        self.assertIn("seen_your_browser_sites", your_browser.COMMANDS)
        repo = Path(__file__).resolve().parents[1]
        self.assertRegex((repo / "sdk" / "PIPS.md").read_text(), r"\| 113 \|[^\n]*seen_your_browser_sites")
        self.assertIn("API113_MUTATIONS = frozenset({'seen_your_browser_sites'})", (repo / "sdk/python/dgc_sdk/pips.py").read_text())
        self.assertIn('API113_MUTATIONS = new Set(["seen_your_browser_sites"])', (repo / "sdk/typescript/src/pips.ts").read_text())
        self.assertIn("Pips API 113", (repo / "sdk" / "CHANGELOG.md").read_text())
        # (And the dock's quick look at the Pips working there: a read, from 113.)
        self.assertIn("get_your_browser_lanes", your_browser.COMMANDS)
        self.assertRegex((repo / "sdk" / "PIPS.md").read_text(), r"\| 113 \|[^\n]*get_your_browser_lanes")
        self.assertIn("API113_READS = frozenset({'get_your_browser_lanes'})", (repo / "sdk/python/dgc_sdk/pips.py").read_text())
        self.assertIn('API113_READS = new Set(["get_your_browser_lanes"])', (repo / "sdk/typescript/src/pips.ts").read_text())


# --------------------------------------------------------------------------- a Pip at work there, seen without hunting
class AtWork(Sites):
    """get_your_browser_lanes (Pips API 113): the Pips with a tab in Your Browser, each saying whether its run is working
    in it now, and whether any Pip's run is live on this computer (the dock asks again sooner while one is). Cheap: what
    the supervisor last said, and one look at the runs."""

    def said(self, lanes):
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (your_browser.STATE_KEY, json.dumps(
                {"open": True, "tabs": [{"title": "Inbox", "url": "https://mail.example.com/"}], "lanes": lanes, "error": ""})))

    def test_which_pips_work_there_now_and_whether_any_run_is_live(self):
        self.assertEqual(self.ok("get_your_browser_lanes"), {"lanes": [], "runs_live": False})
        self.store.enqueue(self.ava["id"], "at-work-1", "local-console", self.cfg)
        self.assertTrue(self.ok("get_your_browser_lanes")["runs_live"], "a run waiting or running: the dock asks again sooner")
        self.said([{"pip_id": self.ava["id"], "name": "", "title": "Ava · Cart", "url": "https://shop.lanestore.com/cart", "working": True},
                   {"pip_id": self.ben["id"], "name": "", "title": "Ben · Notes", "url": "https://notes.example.com/", "working": False},
                   {"pip_id": "pip_" + "9" * 32, "title": "Gone", "url": "", "working": True}])
        live = patch.object(your_browser, "_runner_live", return_value=True)
        live.start()
        self.addCleanup(live.stop)
        lanes = self.ok("get_your_browser_lanes")["lanes"]
        self.assertEqual([(l["pip_id"], l["name"], l["working"]) for l in lanes], [(self.ava["id"], "Ava", True), (self.ben["id"], "Ben", False)],
                         "named from this computer's Pips (a Pip no longer here is left out)")
        self.assertEqual(set(lanes[0]), {"pip_id", "name", "title", "url", "working"}, "never the person's own tabs")
        self.assertEqual([l["working"] for l in self.ok("get_your_browser_recent")["lanes"]], [True, False], "the minute's look says so too")
        self.assertEqual([l["working"] for l in self.ok("get_your_browser")["lanes"]], [True, False])

    def test_nothing_a_gone_runner_said_is_offered(self):
        """The supervisor writes what it last said; if it ended without a word (killed, a crash), none of it is offered:
        no window "open", none of the person's tabs, no Pip's tab to watch (the dock's "Watch Ava's tab", her chat's
        Watch), and no Pip "working" there. What went wrong (its error) is still said."""
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (your_browser.STATE_KEY, json.dumps(
                {"open": True, "tabs": [{"title": "Inbox", "url": "https://mail.example.com/"}], "error": "It closed.",
                 "lanes": [{"pip_id": self.ava["id"], "title": "Ava · Cart", "url": "https://shop.lanestore.com/cart", "working": True}]})))
        with patch.object(your_browser, "_runner_live", return_value=False):
            got = self.ok("get_your_browser")
            self.assertEqual((got["yours"], got["lanes"]), ({"open": False, "tabs": [], "error": "It closed."}, []))
            recent = self.ok("get_your_browser_recent")
            self.assertEqual((recent["open"], recent["lanes"]), (False, []), "the dock: no Open, in a tab here; no Watch")
            self.assertEqual(self.ok("get_your_browser_lanes")["lanes"], [], "nor a Watch in her chat")
        with patch.object(your_browser, "_runner_live", return_value=True):
            self.assertEqual([(l["name"], l["working"]) for l in self.ok("get_your_browser_lanes")["lanes"]], [("Ava", True)])
            self.assertTrue(self.ok("get_your_browser_recent")["open"])

    def test_the_persons_own_and_takes_nothing(self):
        for actor in ("local-computer", "device_1"):
            out = self.control("get_your_browser_lanes", actor=actor)
            self.assertFalse(out["ok"])
            self.assertEqual(out["error"]["code"], "local_only")
        self.assertFalse(self.control("get_your_browser_lanes", pip_id=self.ava["id"])["ok"], "it takes nothing")

    def test_a_watched_tab_names_every_pip_working_there(self):
        """The streamed tab's row of Pips (use_your_browser_view's lanes) names each Pip from this computer's Pips: the
        supervisor's own list knows a Pip's id, and its name only from the run that opened its tab."""
        frame = {"ok": True, "pip_id": self.ava["id"], "url": "https://shop.lanestore.com/", "title": "Mystery", "width": 10, "height": 10,
                 "image": "data:image/jpeg;base64,AA==", "lanes": [{"pip_id": self.ava["id"], "title": "Mystery | Books", "url": "https://shop.lanestore.com/"},
                                                                {"pip_id": self.ben["id"], "name": "", "title": "Notes", "url": "https://notes.example.com/"},
                                                                {"pip_id": "pip_" + "9" * 32, "title": "Gone", "url": ""}]}
        with patch.object(your_browser, "_view_socket", return_value=frame):
            got = self.ok("use_your_browser_view", pip_id=self.ava["id"], op="frame")
        self.assertEqual([(l["pip_id"], l["name"]) for l in got["lanes"]], [(self.ava["id"], "Ava"), (self.ben["id"], "Ben")])


class AtWorkInTheSupervisor(LaneBase):
    def test_a_lane_says_working_while_its_run_drives_and_its_pips_name(self):
        lane, run = self.lane(self.ava)
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        said = {l["pip_id"]: l for l in self.yb.lanes()}
        self.assertTrue(said[self.ava["id"]]["working"], "its run is on it")
        self.assertEqual(said[self.ava["id"]]["name"], "Ava")
        lane.end(run)
        self.assertFalse({l["pip_id"]: l for l in self.yb.lanes()}[self.ava["id"]]["working"], "its run ended: its tab idles")

    def test_the_dock_hears_at_once_when_a_run_begins_and_ends_in_its_tab(self):
        """What get_your_browser_lanes reads is written when a lane's run begins and when it ends, not a tick later: a
        Pip's quick look-up (ten seconds) is seen on the dock and in its chat while it works."""
        def said():
            row = self.registry.db.execute("SELECT value FROM metadata WHERE key=?", (your_browser.STATE_KEY,)).fetchone()
            return {l["pip_id"]: l.get("working") for l in (json.loads(row[0]).get("lanes", []) if row else [])}
        lane, run = self.lane(self.ava)
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        self.assertEqual(said().get(self.ava["id"]), True, "written as its first step ends, with no tick")
        lane.end(run)
        self.assertEqual(said().get(self.ava["id"]), False, "and as its run ends")


# --------------------------------------------------------------------------- noticed from the person's own sign-ins

class Noticing(LaneBase):
    def signed_in(self, target, **payload):
        session = self.chrome.session_of(target)
        body = {"host": "", "path": "/", "title": "", "card": False, "trusted": True, **payload}
        self.chrome.event(session, "Runtime.bindingCalled", {"name": your_browser.NOTICE_BINDING, "payload": json.dumps(body),
                                                            "executionContextId": 7})
        with self.yb.lock:
            self.yb.browser._pump(0.01)
            self.yb.after_pump()
        self.yb.tick(self.registry)

    def site(self, name):
        return next((s for s in your_browser.sites(self.registry) if s["site"] == name), None)

    def test_the_watcher_is_in_the_persons_own_tabs_only_in_its_own_world(self):
        session = self.chrome.session_of(self.person)
        scripts = [m["params"] for m in self.chrome.calls("Page.addScriptToEvaluateOnNewDocument", session)]
        self.assertTrue(any(p.get("worldName") == your_browser.NOTICE_WORLD for p in scripts), "in DGC's own world of their page")
        bound = [m["params"] for m in self.chrome.calls("Runtime.addBinding", session)]
        self.assertEqual([(b["name"], b.get("executionContextName")) for b in bound],
                         [(your_browser.NOTICE_BINDING, your_browser.NOTICE_WORLD)], "the page's own scripts can't call it")
        lane, run = self.lane(self.ava)
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        own = self.chrome.session_of(self.yb.lane_of(self.ava["id"]))
        self.assertEqual(self.chrome.calls("Runtime.addBinding", own), [], "never a Pip's lane")

    def test_a_site_the_person_signs_in_to_joins_all_pips_and_a_bank_asks_which_pips(self):
        self.signed_in(self.person, host="app.notes-keeper.com", title="Notes Keeper")
        self.signed_in(self.person, host="login.northwind-bank.com", title="Northwind Bank")
        notes, bank = self.site("notes-keeper.com"), self.site("northwind-bank.com")
        self.assertEqual((notes["mode"], notes["added_by"], notes["new"]), ("all", "noticed", True))
        self.assertEqual((bank["mode"], bank["pips"], bank["money"]), ("chosen", [], True), "Ask me which Pips")
        self.signed_in(self.person, host="shop.cardstore-online.com", card=True, path="/account")
        self.assertEqual(self.site("cardstore-online.com")["mode"], "chosen", "a card field in the sign-in: a payment site")

    def test_a_site_let_from_a_pips_card_says_you_until_the_person_signs_in_there(self):
        granted = your_browser.allow_pip_site(self.registry, "tide-tables.org", self.ava["id"], "editor-user")
        self.assertEqual((granted["added_by"], granted["new"]), ("you", False), "allowed from a card: no sign-in is known")
        self.signed_in(self.person, host="www.tide-tables.org", title="Tide tables")
        site = self.site("tide-tables.org")
        self.assertEqual(site["added_by"], "noticed", "signed in there since: the list says so")
        self.assertEqual((site["mode"], [p["pip_id"] for p in site["pips"]]), ("chosen", [self.ava["id"]]), "their choice stays")

    def test_nothing_on_this_computer_or_the_network_and_nothing_a_page_did_by_itself(self):
        for host in ("127.0.0.1", "router.lan", "localhost", "nas.local"):
            self.signed_in(self.person, host=host)
        self.signed_in(self.person, host="sneaky-page.com", trusted=False)
        self.assertEqual({s["site"] for s in your_browser.sites(self.registry)}, {"lanestore.com", "lanenotes.com"},
                         "only the grants the test made: nothing noticed")
        lane, run = self.lane(self.ava)
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        self.signed_in(self.yb.lane_of(self.ava["id"]), host="pip-made-this.com")
        self.assertIsNone(self.site("pip-made-this.com"), "a Pip's lane never adds a site")

    def test_a_sign_in_through_another_sites_sign_in_host_adds_that_exact_host(self):
        self.signed_in(self.person, host="accounts.idp-example.com", title="Sign in")
        self.chrome.tabs[self.person]["url"] = "https://app.notes-keeper.com/home"
        self.chrome.event("", "Target.targetInfoChanged", {"targetInfo": {"targetId": self.person, "type": "page",
                                                                          "url": "https://app.notes-keeper.com/home", "title": "Home"}})
        with self.yb.lock:
            self.yb.browser._pump(0.01)
        self.yb.tick(self.registry)
        notes = self.site("notes-keeper.com")
        self.assertIsNotNone(notes, "the site the sign-in went back to")
        self.assertEqual(notes["sso_hosts"], ["accounts.idp-example.com"])
        self.assertTrue(your_browser.grants_for(self.registry, self.ava["id"]).admits("accounts.idp-example.com"),
                        "its lane may follow that site's own sign-in host")


# --------------------------------------------------------------------------- a computer with a screen: its lane in the background

class Windowed(LaneBase):
    def setUp(self):
        super().setUp()
        self.chrome.hidden = True                      # (each Chrome started from here on is the same stand-in)

    def test_its_steps_act_inside_the_page_when_its_tab_is_in_the_background(self):
        lane, run = self.lane(self.ava)
        self.chrome.hidden = True
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        session = self.chrome.session_of(self.yb.lane_of(self.ava["id"]))
        before = len(self.chrome.calls("Input.dispatchMouseEvent", session))
        said = self.step(lane, run, "click", ref="e4")
        self.assertIn("Held", said, "its click went through inside the page, and its submit waits for the person")
        self.assertEqual(len(self.chrome.calls("Input.dispatchMouseEvent", session)), before,
                         "no input event: Chrome gives a tab in the background none")
        self.assertIn(("click", "e4", ""), self.chrome.in_page)
        self.assertNotIn(("POST", SHOP, "/cart", "item=kettle&qty=1"), self.chrome.received)

    def test_typing_and_scrolling_inside_a_background_page_and_a_password_still_refused(self):
        lane, run = self.lane(self.ava)
        self.chrome.hidden = True
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        self.step(lane, run, "type", ref="e2", text="kettle")
        self.assertIn(("type", "e2", "kettle"), self.chrome.in_page)
        self.assertIn("Scrolled", self.step(lane, run, "scroll", dy=400))
        self.assertTrue(any(op == "scroll" for op, _, _ in self.chrome.in_page))
        self.assertIn("never type", self.step(lane, run, "type", ref="e7", text="x"))
        session = self.chrome.session_of(self.yb.lane_of(self.ava["id"]))
        self.assertEqual(self.chrome.calls("Input.insertText", session), [])

    def test_a_tab_in_front_is_driven_as_before(self):
        lane, run = self.lane(self.ava)
        self.chrome.hidden = False
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        session = self.chrome.session_of(self.yb.lane_of(self.ava["id"]))
        self.step(lane, run, "click", ref="e4")
        self.assertTrue(self.chrome.calls("Input.dispatchMouseEvent", session), "real input where Chrome draws the tab")
        self.assertEqual(self.chrome.in_page, [])
        self.assertIsNone(self.yb.browser.driving)
        self.assertFalse(self.yb.browser.in_page, "between steps the browser drives nothing inside a page")

    def test_its_watch_says_where_to_watch_it_instead_of_a_stale_picture(self):
        lane, run = self.lane(self.ava)
        self.chrome.hidden = True
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        said = self.yb.view(self.ava["id"], "frame", {})
        self.assertFalse(said["ok"])
        self.assertTrue(said.get("hidden"))
        self.assertIn("click its tab", said["error"])
        self.assertIn("Ava", said["error"])


# --------------------------------------------------------------------------- the installed Google Chrome

def _installed_chrome():
    from dgc.pip_computer_box import _real_binary
    path = Path("/opt/google/chrome/chrome")
    return path if _real_binary(path) and your_browser.sandbox_ok(path) else None


SIGN_IN_PAGE = b"""<!doctype html><title>Notes Keeper - Sign in</title>
<form method="post" action="/session" style="position:absolute;left:10px;top:10px">
<input id="u" name="email" style="width:300px;height:40px"><br>
<input id="p" name="password" type="password" style="width:300px;height:40px"><br>
<button id="go" style="width:300px;height:40px">Sign in</button></form>"""


def _sign_in_site():
    hits = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, body):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            hits.append(("GET", self.path))
            self.reply(SIGN_IN_PAGE if self.path.startswith("/login") else b"<!doctype html><title>Home</title>home")

        def do_POST(self):
            hits.append(("POST", self.path))
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self.reply(b"<!doctype html><title>Signed in</title>welcome")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, hits


@unittest.skipUnless(_installed_chrome(), "needs Google Chrome installed from its package")
class RealSignIn(unittest.TestCase):
    """The person signs in on a site in their own tab (their own clicks and keys, as the editor's streamed tab sends them):
    the site joins the list as new; a page that submits a password form by itself adds nothing."""

    def test_a_real_sign_in_in_the_persons_own_tab_is_noticed(self):
        fixtures.LocalPipsTests.setUp(self)
        server, hits = _sign_in_site()
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
        flags = ("--password-store=basic", f"--host-resolver-rules=MAP *.notes-keeper.com 127.0.0.1:{port}, "
                                           f"MAP *.auto-signin-page.com 127.0.0.1:{port}")
        with patch.dict(os.environ, env, clear=True):
            yb = your_browser.YourBrowserHost(self.registry.directory, chrome=_installed_chrome(), test_flags=flags)
            self.addCleanup(yb.close)
            yb.open(f"http://app.notes-keeper.com:{port}/login", None, headless=True)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not any(h == ("GET", "/login") for h in hits):
                time.sleep(0.2)
            time.sleep(1.5)
            yb.view_own("size", {"width": 800, "height": 500})
            click = lambda x, y: yb.view_own("input", {"events": [{"t": "down", "x": x, "y": y, "button": "left", "clicks": 1},   # noqa: E731
                                                                   {"t": "up", "x": x, "y": y, "button": "left", "clicks": 1}]})
            click(60, 30)
            yb.view_own("input", {"events": [{"t": "text", "text": "me@example.org"}]})
            click(60, 72)
            yb.view_own("input", {"events": [{"t": "text", "text": "hunter2"}]})
            yb.view_own("input", {"events": [{"t": "key", "key": "Enter", "code": "Enter"}]})
            deadline = time.monotonic() + 15
            site = None
            while time.monotonic() < deadline and site is None:
                time.sleep(0.5)
                yb.tick(self.registry)
                site = next((s for s in your_browser.sites(self.registry) if s["site"] == "notes-keeper.com"), None)
            self.assertIn(("POST", "/session"), hits, "the person's own sign-in went out, never held")
            self.assertIsNotNone(site, "a site they signed in to joins the list")
            self.assertEqual((site["mode"], site["new"], site["added_by"]), ("all", True, "noticed"))
            self.assertNotIn("hunter2", json.dumps(your_browser.get(self.registry)), "nothing of what they typed is kept")
            # A page that sends a password form by itself (no key or click of the person's) adds nothing.
            with yb.lock:
                target = yb.own_tab()
                yb.browser.person_call(target, "Page.navigate", {"url": f"http://www.auto-signin-page.com:{port}/login"})
            time.sleep(2)
            with yb.lock:
                session = yb.browser._attached[target]
                yb.browser._session_call(session, "Runtime.evaluate", {"expression":
                    "document.getElementById('p').value='x'; document.querySelector('form').requestSubmit(); 1"}, timeout=5)
            time.sleep(2)
            yb.tick(self.registry)
            self.assertEqual([s["site"] for s in your_browser.sites(self.registry)], ["notes-keeper.com"],
                             "a page that sent a password form by itself (no key or click of the person's) adds nothing")
            yb.close()


def _free_display() -> str:
    for n in range(88, 140):
        if not Path(f"/tmp/.X11-unix/X{n}").exists() and not Path(f"/tmp/.X{n}-lock").exists():
            return f":{n}"
    return ""


@unittest.skipUnless(_installed_chrome() and shutil.which("Xvfb"), "needs Google Chrome installed from its package and Xvfb")
class RealWindowedLane(unittest.TestCase):
    """Your Browser as the person's real Chrome window on a screen: a Pip's lane in the background of it works as quickly as
    a step in the front, and its submit is still held."""

    def test_a_lane_in_the_background_of_a_real_window_is_quick_and_held(self):
        from tests import test_your_browser_runs as runs
        from dgc import your_browser_lane
        fixtures.LocalPipsTests.setUp(self)
        self.addCleanup(your_browser_lane.forget_all)
        display = _free_display()
        xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (xvfb.terminate(), xvfb.wait(5)))
        time.sleep(1.5)
        server, received = runs._real_site()
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        ava = self.store.create(self.registry.personal()["id"], "Ava", None, "editor-user", pip_type="lens",
                                computer_plan={"schema_version": 1})
        your_browser.allow_pip_site(self.registry, runs.REAL_SHOP, ava["id"], "editor-user")
        flags = ("--password-store=basic", f"--host-resolver-rules=MAP *.lanestore.com 127.0.0.1:{port}")
        with patch.dict(os.environ, {"DISPLAY": display}), patch.object(your_browser, "has_screen", return_value=True):
            yb = your_browser.YourBrowserHost(self.registry.directory, chrome=_installed_chrome(), test_flags=flags)
            self.addCleanup(yb.close)
            yb.open(f"http://{runs.REAL_SHOP}:{port}/", {"left": 0, "top": 0, "width": 1200, "height": 900})
            self.assertFalse(yb.headless, "the person's real window")
            lane = your_browser_lane.LaneHost(self.registry.directory, ava["id"], ava["workspace_id"], yb=yb)
            run = self.store.enqueue(ava["id"], "w-real", "local-console", self.cfg)["id"]
            lane.add_run(run, self.base / "frames")
            took = {}

            def step(op, **a):
                started = time.monotonic()
                said = lane.act_for(run, op, a)["text"]
                took[op] = max(took.get(op, 0.0), time.monotonic() - started)
                return said
            read = step("open", url=f"http://{runs.REAL_SHOP}:{port}/")
            self.assertTrue(yb.lane_of(ava["id"]) not in yb.person_tabs())
            boxes = {m.group(1): m.group(2) for m in re.finditer(r'textbox "([^"]+)" \[(e\d+)\]', read)}
            buttons = {m.group(1): m.group(2) for m in re.finditer(r'button "([^"]+)" \[(e\d+)\]', read)}
            step("type", ref=boxes["item"], text="teapot")
            self.assertIn("Scrolled", step("scroll", dy=300))
            said = step("click", ref=buttons["Add to cart"])
            self.assertIn("Held", said, "its click worked in a tab Chrome doesn't draw, and its submit waits for the person")
            self.assertNotIn("/cart", [r[2] for r in received if r[0] == "POST"])
            self.assertLess(max(took.values()), 10.0, f"no step waits on a picture or an input Chrome won't take: {took}")
            print("windowed steps:", {k: round(v, 1) for k, v in took.items()})
            yb.close()


if __name__ == "__main__":
    unittest.main()
