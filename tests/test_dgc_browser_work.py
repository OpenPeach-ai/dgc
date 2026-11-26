"""DGC Browser for a Work session (dgc_browser_work, decided 26 Nov: "we need work sessions to get access to it").

A Work session's tab is a Pip's lane with the session's own sites: it opens nothing else (the lane gate), it never types
a password and never sends a form that would, and what a Pip's chat would show as a card is said in the step instead.
A write on a site the session allowed goes; a payment, and anything sent on a bank or payment site, is never sent by a
Work session. The supervisor gives each session that asks a tab and a private socket (tick), and takes it back when
the session stops asking; the session's side (step) says so plainly when Pips aren't running.

Stand-in Chrome (tests/test_dgc_browser_runs.py), as for a Pip's lane."""
from __future__ import annotations

import json
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import dgc_browser, dgc_browser_work, pip_computer, tools
from tests import test_pips_local as fixtures
from tests.test_dgc_browser_runs import FakeProcess, IDP, NOTES, SHOP, StandIn


class WorkBase(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        screen = patch.object(dgc_browser, "has_screen", return_value=True)
        screen.start()
        self.addCleanup(screen.stop)
        self.chrome = StandIn()

        def launch(argv, env, log_path):
            self.chrome = StandIn()
            return FakeProcess(), self.chrome

        self.yb = dgc_browser.DgcBrowserHost(self.registry.directory, chrome=Path("/opt/google/chrome/chrome"), launch=launch,
                                               run=lambda argv, **kw: None, which=lambda name: None, platform="linux",
                                               pump_thread=False)
        self.addCleanup(self.yb.close)
        self.yb.open("", None)                                          # the person's own window
        project = self.base / "lime_tiles"
        project.mkdir(exist_ok=True)
        self.workspace = self.registry.resolve(project)["id"]
        self.frames = self.base / "frames"
        from dgc import dgc_browser_lane
        self.addCleanup(dgc_browser_lane.forget_all)
        self.addCleanup(dgc_browser_work.forget_all)

    def lane(self, sites=("lanestore.com",), session="sess-one"):
        lane = dgc_browser_work.WorkLane(self.registry.directory, session, self.workspace, "lime_tiles", yb=self.yb)
        lane.work_sites = tuple(sites)
        run = "work-" + session
        lane.add_run(run, self.frames / session, label="a Work session", level="full", user_turn=True)
        return lane, run

    def step(self, lane, run, op, **args):
        return lane.act_for(run, op, args)["text"]

    def posts(self):
        return [r[2] for r in self.chrome.received if r[0] == "POST"]

    def cards(self):
        return self.registry.db.execute("SELECT COUNT(*) FROM pip_computer_actions").fetchone()[0]


class Confinement(WorkBase):
    def test_its_tab_opens_the_sessions_sites_and_nothing_else_and_shows_no_card(self):
        lane, run = self.lane()
        page = self.step(lane, run, "open", url=f"https://{SHOP}/")
        self.assertIn("Kettle", page)
        said = self.step(lane, run, "open", url=f"https://{NOTES}/")
        self.assertIn("isn't one of the sites the user let this session use", said)
        self.assertIn("op open", said, "it says how: open asks the user")
        self.assertEqual(self.chrome.got(NOTES), [], "nothing of the other site was asked for")
        self.assertEqual(self.cards(), 0, "a Work session's tab never makes a Pip's card")

    def test_its_tab_says_whose_it_is(self):
        lane, run = self.lane()
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        self.assertEqual(lane.pip_id, "work:sess-one")
        self.assertEqual(self.yb.browser.lane_names.get("work:sess-one"), "Work · lime_tiles")
        self.assertIn("work:sess-one", [l["pip_id"] for l in self.yb.lanes()], "the dock's Watch lists it")

    def test_nothing_on_this_computer_is_a_site(self):
        lane, run = self.lane(sites=("lanestore.com", "localhost"))
        said = self.step(lane, run, "open", url="http://localhost:8080/admin")
        self.assertIn("isn't a site on the web", said)


class Writes(WorkBase):
    def test_a_write_on_a_site_the_session_allowed_goes(self):
        lane, run = self.lane()
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        self.step(lane, run, "click", ref="e4")                         # Add to cart: a form post on its site
        self.assertIn("/cart", self.posts())

    def test_a_payment_is_never_sent_and_the_step_says_what_wasnt(self):
        lane, run = self.lane()
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        said = self.step(lane, run, "click", ref="e6")                  # Pay now
        self.assertNotIn("/checkout/pay", self.posts())
        self.assertIn("Not sent", said)
        self.assertIn("themselves in DGC Browser", said)
        self.assertEqual(self.cards(), 0)

    def test_on_a_bank_site_no_write_is_sent(self):
        self.chrome.site["https://www.northwind-bank.com/"] = {"title": "Northwind Bank", "lines": ['- button "Save" [e1]'],
                                                                "refs": {"e1": ("post", "https://www.northwind-bank.com/prefs", "theme=dark")}}
        lane, run = self.lane(sites=("northwind-bank.com",))
        self.step(lane, run, "open", url="https://www.northwind-bank.com/")
        said = self.step(lane, run, "click", ref="e1")
        self.assertNotIn("/prefs", self.posts())
        self.assertIn("Not sent", said)


class Passwords(WorkBase):
    def test_it_never_types_into_a_password_field(self):
        lane, run = self.lane()
        self.step(lane, run, "open", url=f"https://{SHOP}/signin")
        said = self.step(lane, run, "type", ref="e2", text="guess")
        self.assertIn("never type", said)
        self.assertEqual(self.chrome.typed, {})

    def test_a_form_that_would_send_a_password_is_never_sent_and_the_user_is_told_to_sign_in_there(self):
        lane, run = self.lane()
        self.step(lane, run, "open", url=f"https://{SHOP}/signin")
        said = self.step(lane, run, "click", ref="e3")
        self.assertEqual(self.posts(), [], "a password Chrome filled in is never sent")
        self.assertIn("sign in to lanestore.com themselves in DGC Browser", said)
        self.assertEqual(self.cards(), 0)

    def test_sign_in_tells_the_model_to_ask_the_user_with_no_card(self):
        lane, run = self.lane()
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        said = self.step(lane, run, "sign_in")
        self.assertIn("signs in to lanestore.com themselves, in DGC Browser", said)
        self.assertEqual(self.cards(), 0)


class Supervisor(WorkBase):
    def setUp(self):
        super().setUp()
        hosted = patch.object(dgc_browser, "host_for", return_value=self.yb)
        hosted.start()
        self.addCleanup(hosted.stop)

    def ask(self, session="sess-two", sites=("lanestore.com",), at=None):
        body = {"session": session, "name": "lime_tiles", "workspace_id": self.workspace, "sites": list(sites),
                "at": time.time() if at is None else at}
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (dgc_browser_work.ASK + session, json.dumps(body)))

    def pin(self, session="sess-two"):
        row = self.registry.db.execute("SELECT value FROM metadata WHERE key=?", (dgc_browser_work.PIN + session,)).fetchone()
        return json.loads(row[0]) if row else None

    def test_a_session_that_asks_gets_its_tab_and_a_private_socket_its_steps_go_through(self):
        self.ask()
        dgc_browser_work.tick(self.registry)
        pin = self.pin()
        self.assertTrue(pin and Path(pin["socket"]).exists())
        self.assertEqual(oct(Path(pin["socket"]).stat().st_mode & 0o777), "0o600", "this user's only")
        reply = pip_computer.worker_reply(pin, "open", {"url": f"https://{SHOP}/"})
        self.assertIn("Kettle", reply["text"])
        refused = pip_computer.worker_reply({**pin, "token": "wrong"}, "read", {})
        self.assertNotIn("Kettle", refused.get("text", ""), "a wrong token reads nothing")

    def test_its_sites_follow_the_newest_ask(self):
        self.ask(sites=())
        dgc_browser_work.tick(self.registry)
        pin = self.pin()
        said = pip_computer.worker_reply(pin, "open", {"url": f"https://{SHOP}/"})["text"]
        self.assertIn("isn't one of the sites", said)
        self.ask(sites=("lanestore.com",))
        dgc_browser_work.tick(self.registry)
        self.assertEqual(self.pin()["socket"], pin["socket"], "the same tab and socket")
        self.assertIn("Kettle", pip_computer.worker_reply(pin, "open", {"url": f"https://{SHOP}/"})["text"])

    def test_a_session_that_stopped_asking_gives_its_tab_back(self):
        self.ask()
        dgc_browser_work.tick(self.registry)
        pin = self.pin()
        pip_computer.worker_reply(pin, "open", {"url": f"https://{SHOP}/"})
        self.ask(at=time.time() - dgc_browser_work.IDLE_SECONDS - 5)
        dgc_browser_work.tick(self.registry)
        self.assertIsNone(self.pin())
        self.assertFalse(Path(pin["socket"]).exists())
        self.assertNotIn("work:sess-two", [l["pip_id"] for l in self.yb.lanes()], "its tab is closed")

    def test_the_docks_list_names_its_tab_and_says_it_is_at_work_only_while_its_steps_come(self):
        self.ask()
        dgc_browser_work.tick(self.registry)
        pip_computer.worker_reply(self.pin(), "open", {"url": f"https://{SHOP}/"})
        [mine] = [l for l in self.yb.lanes() if l["pip_id"] == "work:sess-two"]
        self.assertEqual((mine["name"], mine["working"]), ("Work · lime_tiles", True), "at work just after a step")
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (dgc_browser.STATE_KEY, json.dumps(
                {"open": True, "tabs": [], "lanes": self.yb.lanes(), "error": ""})))
        with patch.object(dgc_browser, "_runner_live", return_value=True):
            lanes = dgc_browser.lanes_now(self.registry)["lanes"]
        self.assertIn(("work:sess-two", "Work · lime_tiles", True), [(l["pip_id"], l["name"], l["working"]) for l in lanes],
                      "the dock's list has it, named as its tab is (it is no Pip)")
        with patch.object(dgc_browser.time, "monotonic", return_value=time.monotonic() + dgc_browser.WORK_ACTIVE_SECONDS + 1):
            [later] = [l for l in self.yb.lanes() if l["pip_id"] == "work:sess-two"]
        self.assertFalse(later["working"], "a minute after its last step it is not said to be at work any more")

    def test_the_watched_tabs_row_names_a_work_tab_and_its_title_is_the_pages_own(self):
        # The streamed tab's row of tabs (the view's own reply): a Work session's tab named as its tab is, never dropped
        # for being no Pip; a well-formed name only.
        picture = {"ok": True, "title": "Example Domain", "lanes": [
            {"pip_id": "work:sess-two", "name": "Work · lime_tiles", "title": "Example Domain"},
            {"pip_id": "work:../x", "name": "Work", "title": ""}]}
        with patch.object(dgc_browser, "_view_socket", return_value=picture):
            said = dgc_browser.view_call(self.registry, {"type": "use_dgc_browser_view", "pip_id": "work:sess-two", "op": "frame"})
        self.assertEqual([(l["pip_id"], l["name"]) for l in said["lanes"]], [("work:sess-two", "Work · lime_tiles")])
        self.assertEqual(dgc_browser.lane_title("Work · lime_tiles · Example Domain", "Work · lime_tiles"), "Example Domain")

    def test_a_session_whose_project_the_registry_doesnt_know_gets_nothing(self):
        body = {"session": "sess-x", "name": "x", "workspace_id": "ws_nope", "sites": [], "at": time.time()}
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (dgc_browser_work.ASK + "sess-x", json.dumps(body)))
        dgc_browser_work.tick(self.registry)
        self.assertIsNone(self.pin("sess-x"))


class SessionSide(unittest.TestCase):
    def setUp(self):
        self.calls = []
        avail = patch.object(dgc_browser, "_availability", return_value=(True, "", ""))
        avail.start()
        self.addCleanup(avail.stop)

    def test_pips_off_says_how_to_start_them(self):
        with patch.object(dgc_browser_work, "ask"), patch.object(dgc_browser_work, "WorkspaceRegistry", create=True), \
                patch("dgc.dgc_browser_work._runner_online", return_value=False), \
                patch("dgc.workspace_registry.WorkspaceRegistry") as registry:
            registry.return_value.__enter__.return_value = SimpleNamespace()
            said = dgc_browser_work.step("/nowhere", "s1", "read", {}, name="p", workspace_id="w", sites=())
        self.assertEqual(said["text"], dgc_browser_work.PIPS_OFF)

    def test_no_answer_from_the_supervisor_says_pips_arent_running(self):
        now = [0.0]
        with patch.object(dgc_browser_work, "ask"), patch("dgc.dgc_browser_work._runner_online", return_value=True), \
                patch("dgc.workspace_registry.WorkspaceRegistry") as registry, patch.object(dgc_browser_work, "_pin", return_value=None):
            registry.return_value.__enter__.return_value = SimpleNamespace()
            said = dgc_browser_work.step("/nowhere", "s1", "read", {}, name="p", workspace_id="w", sites=(),
                                         wait=2.0, clock=lambda: now[0], sleep=lambda s: now.__setitem__(0, now[0] + s))
        self.assertEqual(said["text"], dgc_browser_work.PIPS_OFF)

    def test_where_dgc_browser_cant_run_it_says_why(self):
        with patch.object(dgc_browser, "_availability", return_value=(False, "Google Chrome isn't installed", "")):
            said = dgc_browser_work.step("/nowhere", "s1", "read", {}, name="p", workspace_id="w", sites=())
        self.assertIn("can't run on this computer", said["text"])
        self.assertIn("Google Chrome isn't installed", said["text"])


class TheTool(unittest.TestCase):
    """tools.dgc_browser_tool: a site it opens joins the session's sites (the permission check already asked), which go
    to the supervisor with every step; a picture of its tab is shown in the chat."""

    def setUp(self):
        self.ctx = SimpleNamespace(project_root=Path("/home/me/lime_tiles"), tool_owner="owner-" + str(time.monotonic_ns()),
                                   config=None, vision=False)
        self.sent = []
        reg = patch("dgc.workspace_registry.WorkspaceRegistry")
        self.registry = reg.start()
        self.addCleanup(reg.stop)
        self.registry.return_value.__enter__.return_value = SimpleNamespace(resolve=lambda root: {"id": "ws_lime"})

        def step(state, session, op, args, **kw):
            self.sent.append((session, op, args, kw))
            return {"text": "URL: https://shop.lanestore.com/\nTitle: Lane Store"}

        stepped = patch.object(dgc_browser_work, "step", side_effect=step)
        stepped.start()
        self.addCleanup(stepped.stop)

    def test_a_site_it_opens_joins_the_sessions_sites_and_goes_with_every_step(self):
        tools.dgc_browser_tool({"op": "open", "url": f"https://{SHOP}/orders"}, self.ctx)
        tools.dgc_browser_tool({"op": "read"}, self.ctx)
        self.assertEqual(tools.dgc_browser_sites(self.ctx), {"lanestore.com"})
        (session, op, args, kw) = self.sent[-1]
        self.assertEqual((session, op, kw["sites"], kw["workspace_id"], kw["name"]), (self.ctx.tool_owner, "read", {"lanestore.com"}, "ws_lime", "lime_tiles"))

    def test_an_address_that_isnt_a_site_is_never_sent(self):
        said = tools.dgc_browser_tool({"op": "open", "url": "file:///etc/passwd"}, self.ctx)
        self.assertIn("isn't a site on the web", said)
        self.assertEqual(self.sent, [])

    def test_an_unknown_step_says_which_there_are(self):
        self.assertIn("unknown op", tools.dgc_browser_tool({"op": "eval"}, self.ctx))

    def test_dgc_browser_is_in_works_tools(self):
        names = [t["function"]["name"] for t in tools.TOOL_SCHEMAS]
        self.assertIn("dgc_browser", names)
        schema = next(t for t in tools.TOOL_SCHEMAS if t["function"]["name"] == "dgc_browser")["function"]
        self.assertIn('when the user says "the DGC browser", this is it', schema["description"])
        self.assertIn("Opening a site asks the user first", schema["description"])
        self.assertNotIn("confirm", schema["parameters"]["properties"], "nothing waits on a card in Work")


class WhichBrowser(unittest.TestCase):
    """Decided 26 Nov: Work's own browser stays the default for any page; DGC Browser when the user names it, or when
    they say "my browser" and their everyday Chrome can't be reached or doesn't have what they mean."""

    def schema(self, name):
        return next(t for t in tools.TOOL_SCHEMAS if t["function"]["name"] == name)["function"]

    def test_dgc_browser_is_only_when_asked_and_any_other_page_is_the_browser_tool(self):
        said = self.schema("dgc_browser")["description"]
        self.assertIn("Use it only when the user asks for DGC Browser", said)
        self.assertIn("for any other page use the browser tool", said)

    def test_the_browser_tool_first_then_dgc_browser_when_it_cant_show_what_they_mean(self):
        said = self.schema("browser")["description"]
        self.assertIn('it is the one for any page, the user\'s "browser" included', said)
        self.assertIn("When it can't show what the user means (their account's page shows a sign-in instead), try DGC "
                      "Browser (the dgc_browser tool)", said)
        self.assertIn("say which browser you used", said)
        self.assertIn("when they name their own Chrome", self.schema("browser")["parameters"]["properties"]["signed_in"]["description"])
        self.assertIn("when the browser tool couldn't show what they mean because the page needs their sign-in",
                      self.schema("dgc_browser")["description"])
        # Decided 26 Nov: "check my browser" tries the browser tool first, even for a page that plainly needs a sign-in
        # (a packaged-build check went straight to DGC Browser for github.com/notifications).
        self.assertIn("Even for \"my browser\" or a page that needs a sign-in, open it with the browser tool first",
                      self.schema("dgc_browser")["description"])

    def test_their_chrome_out_of_reach_points_to_dgc_browser_but_never_after_they_said_no(self):
        from dgc.browser_user import NOT_RUNNING, SAID_NO
        gone = dgc_browser.BrowserError("Chrome isn't running, or remote debugging was turned off.")
        gone.kind = NOT_RUNNING
        no = dgc_browser.BrowserError("The user said no in Chrome (they chose Cancel when Chrome asked).")
        no.kind = SAID_NO
        with patch.object(dgc_browser, "_availability", return_value=(True, "", "")):
            self.assertIn("try it there with the dgc_browser tool", tools._dgc_browser_instead(gone))
            self.assertEqual(tools._dgc_browser_instead(no), "", "their Cancel in Chrome is their answer")
        with patch.object(dgc_browser, "_availability", return_value=(False, "no Chrome", "")):
            self.assertEqual(tools._dgc_browser_instead(gone), "", "nothing of a DGC Browser that can't run here")

    def test_only_a_failed_connection_to_their_chrome_points_to_dgc_browser(self):
        """Their Chrome reached and a step failed (a link gone from the page), or the connection dropped mid-task: that
        step's own error, nothing more (the next call reconnects)."""
        from dgc.browser_user import FAILED, UNANSWERED
        with patch.object(dgc_browser, "_availability", return_value=(True, "", "")):
            for kind in (UNANSWERED, FAILED):
                error = dgc_browser.BrowserError("DGC couldn't use the user's Chrome")
                error.kind = kind
                self.assertIn("dgc_browser tool", tools._dgc_browser_instead(error), kind)
            self.assertEqual(tools._dgc_browser_instead(dgc_browser.BrowserError("element e99 is not on the page")), "")
            self.assertEqual(tools._dgc_browser_instead(dgc_browser.BrowserError("devtools connection closed")), "")
            self.assertEqual(tools._dgc_browser_instead(OSError("Broken pipe")), "")


if __name__ == "__main__":
    unittest.main()
