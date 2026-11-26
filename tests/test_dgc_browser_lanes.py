"""DGC Browser, phase 2 (0.52; decided 17 Nov): each Pip's own lane in the one shared browser.

The browser's write gate kept one state for the whole browser (the last action, a sign-in's one pass, careful mode's
site gate, an open dialog), so two Pips in one browser would bleed into each other. Now it is per tab: owner_of(tab) is
a Pip or the person; each tab has its own last action, sign-in pass and dialog, and each owner its own site gate; a
Pip's step can drive its tab without bringing it to the front (switch_tab activate=False).

In DGC Browser (shared) the person's own tabs are theirs: DGC never gates them. A Pip's lane is gated through Chrome's
own DevTools controls on that tab (Fetch and Network): its pages open only on its sites and their exact sign-in hosts, a
write elsewhere is refused with a plain reason, writes inside follow the Pip's level as on its own computer, third-party
cookies are off, service workers can't serve it around the gate, and what it sent is logged per Pip and site.

The unit tests drive BoxedBrowser's gate over a fake DevTools pipe; the real-browser tests run a real Chromium in DGC's
box against a local site (skipped where no box browser is available)."""
from __future__ import annotations

import http.server
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_computer_box as box, dgc_browser

A, B = "pip_" + "a" * 32, "pip_" + "b" * 32


class FakePipe:
    """DevTools over a pipe, played back: every command gets an empty answer; events are fed by the test."""

    def __init__(self):
        self.sent, self.inbox = [], []

    def settimeout(self, timeout):
        pass

    def send(self, payload):
        self.sent.append(payload)
        if "id" in payload:
            self.inbox.append({"id": payload["id"], "result": {}})

    def recv(self):
        if self.inbox:
            return self.inbox.pop(0)
        raise socket.timeout("quiet")

    def close(self):
        pass


class Lanes(unittest.TestCase):
    shared = True

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-lanes-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.held = []
        self.browser = box.BoxedBrowser(self.root / "home", self.root / "egress.sock", chrome=None,
                                        log_path=self.root / "box.log", on_write=self.held.append, shared=self.shared)
        self.pipe = self.browser._pipe = FakePipe()
        self.browser.lane_sent = dgc_browser.LaneSent(self.root / "dgc-browser" / "sent.jsonl")
        self.grants = dgc_browser.Grants(["example-shop.com"], ["accounts.example-idp.com"])
        self.attach("T1", "S1")                                  # the person's own tab
        self.lane("T2", "S2", A, self.grants)                    # Ava's lane
        self.lane("T3", "S3", B, dgc_browser.Grants(["example-notes.com"]))     # Ben's lane
        self.front("S2")

    def lane(self, target, session, pip_id, grants):
        """As open_lane does: DGC opens a blank tab (marked as its own), then makes it the Pip's lane."""
        self.attach(target, session)
        self.browser._opened.add(target)
        self.browser._make_lane(target, pip_id, grants)

    def attach(self, target, session, *, kind="page", parent="", opener=""):
        info = {"targetId": target, "type": kind, **({"openerId": opener} if opener else {})}
        message = {"method": "Target.attachedToTarget", "params": {"sessionId": session, "targetInfo": info}}
        if parent:
            message["sessionId"] = parent
        self.browser._observe(message)

    def front(self, session):
        self.browser._ws = box._PageChannel(self.pipe, session)

    def request(self, session, rid, url, *, method="GET", kind="Document", frame=None, post=""):
        target = self.browser._session_target(session)
        self.browser._observe({"method": "Fetch.requestPaused", "sessionId": session, "params": {
            "requestId": rid, "resourceType": kind, "frameId": frame if frame is not None else target,
            "request": {"url": url, "method": method, "headers": {"Content-Type": "application/x-www-form-urlencoded"},
                        **({"postData": post} if post else {})}}})

    def answered(self, rid):
        """How the gate answered a paused request: continue, fail (refused), or None (held)."""
        for message in self.pipe.sent:
            if (message.get("params") or {}).get("requestId") == rid:
                return {"Fetch.continueRequest": "continue", "Fetch.failRequest": "fail"}.get(message["method"])
        return None

    def sent_to(self, session):
        return [m["method"] for m in self.pipe.sent if m.get("sessionId") == session]

    def lines(self):
        path = self.root / "dgc-browser" / "sent.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


class Owners(Lanes):
    def test_each_tab_has_an_owner_and_what_it_opens_is_its_owners(self):
        self.assertEqual([self.browser.owner_of(t) for t in ("T1", "T2", "T3")], [box.PERSON, A, B])
        self.attach("T4", "S4", opener="T2")                    # a popup Ava's page opened
        self.attach("T5", "S5", kind="iframe", parent="S3")     # a frame from another site in Ben's page
        self.attach("T6", "S6", opener="T1")                    # a link the person opened in a new tab
        self.assertEqual([self.browser.owner_of(t) for t in ("T4", "T5", "T6")], [A, B, box.PERSON])
        self.assertEqual(self.browser.owner_of("T-unknown"), box.PERSON)

    def test_the_persons_own_tabs_are_never_gated_and_a_lane_is_gated_on_its_own_tab(self):
        self.assertEqual(self.sent_to("S1"), ["Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"],
                         "the person's tab is theirs: no Fetch, no Network, nothing blocked")
        lane = self.sent_to("S2")
        for method in ("Fetch.enable", "Network.enable", "Network.setBlockedURLs", "Network.setBypassServiceWorker",
                       "Network.setCookieControls"):
            self.assertIn(method, lane)
        script = next(m for m in self.pipe.sent if m.get("sessionId") == "S2"
                      and m["method"] == "Page.addScriptToEvaluateOnNewDocument")
        self.assertIn("RTCPeerConnection", script["params"]["source"], "what the gate can't see is off in a lane")
        self.assertIs(script["params"]["runImmediately"], True)
        cookies = next(m for m in self.pipe.sent if m.get("sessionId") == "S2" and m["method"] == "Network.setCookieControls")
        self.assertIs(cookies["params"]["enableThirdPartyCookieRestriction"], True, "third-party cookies off in a lane")
        self.attach("T4", "S4", opener="T2")
        self.assertIn("Fetch.enable", self.sent_to("S4"), "a popup a lane opens is gated before it runs")

    def test_only_a_tab_dgc_opened_for_the_pip_becomes_its_lane(self):
        with self.assertRaises(box.BrowserError):
            self.browser._make_lane("T3", A, self.grants)       # Ben's lane
        with self.assertRaises(box.BrowserError):
            self.browser._make_lane("T1", A, self.grants)       # the person's own tab
        self.assertEqual((self.browser.owner_of("T1"), self.browser.owner_of("T3")), (box.PERSON, B))


class PerTabState(Lanes):
    def test_one_pips_action_never_makes_another_lanes_traffic_its_own(self):
        self.browser.acted_at = time.monotonic()                # Ava clicks in her lane (in front)
        self.request("S3", "r-ben", "https://app.example-notes.com/api/save", method="POST", kind="XHR", post="x=1")
        self.request("S2", "r-ava", "https://www.example-shop.com/api/cart", method="POST", kind="XHR", post="x=1")
        self.assertEqual(self.answered("r-ben"), "continue", "Ben's page's own background save is nothing Ava did")
        self.assertIsNone(self.answered("r-ava"), "the write Ava's click caused waits")
        self.assertEqual([(h.request_id, h.owner) for h in self.held], [("r-ava", A)])
        self.front("S3")
        self.assertFalse(self.browser.acting(), "Ben hasn't acted")
        self.browser._tabs["T2"].acted_at = time.monotonic() - 60
        self.front("S2")
        self.assertFalse(self.browser.acting())

    def test_a_sign_in_pass_is_spent_only_by_the_lane_it_was_given_to(self):
        class Pass:
            def admits(self, url, post, content_type):
                return True
        self.browser.login_pass = Pass()                        # DGC signs Ava in on her lane
        self.request("S3", "r-ben", "https://app.example-notes.com/session", method="POST", post="u=ben")
        self.assertIsNone(self.answered("r-ben"), "Ben's submit is held, never let through by Ava's sign-in")
        self.request("S2", "r-ava", "https://www.example-shop.com/session", method="POST", post="u=ava")
        self.assertEqual(self.answered("r-ava"), "continue")
        self.assertIsNone(self.browser.login_pass, "spent")
        self.assertEqual(self.browser.login_sent, ["POST www.example-shop.com/session"])

    def test_careful_mode_gates_only_its_own_pips_pages(self):
        self.browser.site_gate = lambda url: "example-shop.com" in url      # Ava's run, careful mode on
        self.request("S2", "r-ava", "https://www.example-shop.com/deals?also=other", method="GET")
        self.request("S2", "r-ava-new", "https://help.example-shop.com/", method="GET")
        self.front("S3")
        self.assertIsNone(self.browser.site_gate, "Ben's run has no gate of Ava's")
        self.request("S3", "r-ben", "https://app.example-notes.com/", method="GET")
        self.assertEqual((self.answered("r-ava"), self.answered("r-ava-new"), self.answered("r-ben")),
                         ("continue", "continue", "continue"))

    def test_a_dialog_is_held_for_the_lane_whose_run_holds_dialogs_and_blocks_only_that_tab(self):
        self.browser.hold_dialogs = True                        # Ava's run
        self.browser._observe({"method": "Page.javascriptDialogOpening", "sessionId": "S2",
                               "params": {"type": "confirm", "message": "Empty the cart?"}})
        self.browser._observe({"method": "Page.javascriptDialogOpening", "sessionId": "S3",
                               "params": {"type": "confirm", "message": "Leave without saving?"}})
        self.assertEqual(self.browser.dialog["message"], "Empty the cart?")
        self.assertTrue(self.browser._blocked_by_dialog("Runtime.evaluate"))
        answered = [m for m in self.pipe.sent if m["method"] == "Page.handleJavaScriptDialog"]
        self.assertEqual([m.get("sessionId") for m in answered], ["S3"], "Ben's run holds none: answered at once")
        self.front("S3")
        self.assertIsNone(self.browser.dialog)
        self.assertFalse(self.browser._blocked_by_dialog("Runtime.evaluate"))
        self.front("S2")
        self.browser.answer_dialog(False)
        self.assertIsNone(self.browser.dialog)

    def test_a_pips_step_can_drive_its_tab_without_bringing_it_to_the_front(self):
        self.browser.switch_tab("T3", settle=0, activate=False)
        self.assertNotIn("Target.activateTarget", [m["method"] for m in self.pipe.sent])
        self.assertEqual(self.browser.page_target(), "T3")
        self.browser.switch_tab("T2", settle=0)
        self.assertIn("Target.activateTarget", [m["method"] for m in self.pipe.sent], "the default is unchanged")


class Confinement(Lanes):
    def test_a_lanes_pages_open_only_on_its_sites_and_their_exact_sign_in_hosts(self):
        for rid, url in (("shop", "https://www.example-shop.com/"), ("sub", "https://help.example-shop.com/faq"),
                         ("idp", "https://accounts.example-idp.com/signin")):
            self.request("S2", rid, url)
            self.assertEqual(self.answered(rid), "continue", url)
        for rid, url in (("other", "https://evil.example.net/"), ("idp-domain", "https://mail.example-idp.com/"),
                         ("lan", "http://192.168.1.1/"), ("here", "http://localhost:8080/")):
            self.request("S2", rid, url)
            self.assertEqual(self.answered(rid), "fail", url)
        refusal = self.browser.lane(A).refused[-1]
        self.assertIn("localhost", refusal)
        self.assertIn("example-shop.com", refusal, "a plain reason that names the lane's sites")
        self.assertEqual(self.held, [])

    def test_reads_from_frames_and_other_hosts_load_but_a_write_elsewhere_is_refused(self):
        self.request("S2", "frame", "https://widgets.example-cdn.com/embed", frame="F1")
        self.request("S2", "script", "https://static.example-cdn.com/app.js", kind="Script")
        self.request("S2", "form", "https://evil.example.net/collect", method="POST", frame="F1", post="secret=1")
        self.request("S2", "top-form", "https://evil.example.net/collect", method="POST", post="secret=1")
        self.assertEqual([self.answered(r) for r in ("frame", "script", "form", "top-form")],
                         ["continue", "continue", "fail", "fail"])
        self.assertIn("evil.example.net", self.browser.lane(A).refused[-1])

    def test_a_background_write_elsewhere_is_refused_when_the_pip_caused_it(self):
        self.request("S2", "pixel", "https://stats.example-metrics.com/collect", method="POST", kind="XHR", post="e=view")
        self.assertEqual(self.answered("pixel"), "continue", "the page's own traffic, nothing the Pip did")
        self.browser.acted_at = time.monotonic()
        self.request("S2", "leak", "https://stats.example-metrics.com/collect", method="POST", kind="XHR", post="q=card")
        self.assertEqual(self.answered("leak"), "fail")

    def test_a_write_inside_its_sites_is_held_as_on_its_own_computer(self):
        self.browser.acted_at = time.monotonic()
        self.request("S2", "cart", "https://www.example-shop.com/cart", method="POST", post="item=mug")
        self.assertIsNone(self.answered("cart"), "held; its level decides, as today (Do it all never asks)")
        [held] = self.held
        self.assertEqual((held.owner, held.method, held.site, held.summary()["path"]), (A, "POST", False, "/cart"))

    def test_a_popup_from_a_lane_is_confined_too(self):
        self.attach("T4", "S4", opener="T2")
        self.request("S4", "pop", "https://evil.example.net/landing")
        self.assertEqual(self.answered("pop"), "fail")

    def test_refused_pages_and_what_the_lane_sent_are_logged_per_pip_and_site(self):
        self.request("S2", "other", "https://evil.example.net/")
        for session, rid, url, post in (("S2", "n1", "https://www.example-shop.com/api/cart", "item=mug"),
                                        ("S3", "n2", "https://app.example-notes.com/api", ""),
                                        ("S1", "n3", "https://bank.example-person.com/", "")):
            self.browser._observe({"method": "Network.requestWillBeSent", "sessionId": session, "params": {
                "requestId": rid, "type": "XHR", "request": {"url": url, "method": "POST" if post else "GET",
                                                             **({"postData": post} if post else {})}}})
            self.browser._observe({"method": "Network.loadingFinished", "sessionId": session,
                                   "params": {"requestId": rid, "encodedDataLength": 1200}})
        self.browser.lane_sent.flush()
        lines = {(l["pip_id"], l["host"], l["kind"]): l for l in self.lines()}
        self.assertEqual(set(lines), {(A, "evil.example.net", "refused"), (A, "www.example-shop.com", "request"),
                                      (B, "app.example-notes.com", "request")}, "never the person's own tabs")
        cart = lines[(A, "www.example-shop.com", "request")]
        self.assertEqual((cart["site"], cart["up"], cart["down"], cart["requests"]), ("example-shop.com", 8, 1200, 1))


class OneOwnerComputer(Lanes):
    """A Pip's own computer is one owner's: everything works exactly as before, every tab gated."""
    shared = False

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-own-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.held = []
        self.browser = box.BoxedBrowser(self.root / "home", self.root / "egress.sock", chrome=None,
                                        log_path=self.root / "box.log", on_write=self.held.append)
        self.pipe = self.browser._pipe = FakePipe()
        self.attach("T1", "S1")
        self.attach("T2", "S2", opener="T1")
        self.front("S1")

    def test_every_tab_is_gated_and_one_action_covers_the_computers_tabs(self):
        self.assertIn("Fetch.enable", self.sent_to("S1"))
        self.assertIn("Fetch.enable", self.sent_to("S2"))
        self.assertNotIn("Network.setCookieControls", self.sent_to("S1"))
        self.browser.acted_at = time.monotonic()
        self.request("S2", "pop-write", "https://shop.example-store.com/api", method="POST", kind="XHR", post="a=1")
        self.assertIsNone(self.answered("pop-write"), "a write in the popup the Pip's click opened waits, as before")
        self.assertEqual(self.held[0].owner, box.PERSON)
        self.request("S1", "anywhere", "https://anything.example-store.com/")
        self.assertEqual(self.answered("anywhere"), "continue", "no lane, no confinement")


class LaneSentLines(unittest.TestCase):
    def test_requests_to_one_host_are_added_up_and_written_as_one_line_once_they_have_waited(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-sent-")
        self.addCleanup(temp.cleanup)
        now = [100.0]
        sent = dgc_browser.LaneSent(Path(temp.name) / "sent.jsonl", clock=lambda: now[0])
        for _ in range(3):
            sent.add(A, "www.example-shop.com", up=10, down=100)
        now[0] += 10
        sent.flush_due()
        self.assertFalse(sent.path.exists(), "nothing yet: it waits to add up a page's requests")
        now[0] += dgc_browser.LaneSent.FLUSH_SECONDS
        sent.flush_due()
        [line] = [json.loads(l) for l in sent.path.read_text().splitlines()]
        self.assertEqual({k: line[k] for k in ("host", "kind", "up", "down", "requests", "pip_id", "site")},
                         {"host": "www.example-shop.com", "kind": "request", "up": 30, "down": 300, "requests": 3,
                          "pip_id": A, "site": "example-shop.com"})


class SentLog(unittest.TestCase):
    """The "Sent to the web" log (list_pip_sent) gains each Pip's lane in DGC Browser, per site."""

    def setUp(self):
        from tests import test_pips_local as fixtures
        fixtures.LocalPipsTests.setUp(self)
        personal = self.registry.personal()["id"]
        self.ava = self.store.create(personal, "Ava", None, "editor-user", pip_type="lens", computer_plan={"schema_version": 1})
        self.ben = self.store.create(personal, "Ben", None, "editor-user", pip_type="lens", computer_plan={"schema_version": 1})

    def test_a_pips_lane_shows_in_its_own_sent_log_and_never_in_another_pips(self):
        from dgc import pips
        sent = dgc_browser.LaneSent(dgc_browser.folder(self.registry.directory) / "sent.jsonl")
        sent.add(self.ava["id"], "www.example-shop.com", up=10, down=2000)
        sent.add(self.ben["id"], "app.example-notes.com", up=5, down=300)
        sent.refused(self.ava["id"], "evil.example.net")
        sent.flush()
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            out = pips.handle_control(self.cfg, {"type": "list_pip_sent", "request_id": "r", "pip_id": self.ava["id"]},
                                      "editor-user", start_worker=False)
        self.assertTrue(out["ok"], out)
        rows = {r["host"]: r for r in out["result"]["sites"]}
        self.assertEqual(set(rows), {"www.example-shop.com", "evil.example.net"})
        self.assertEqual((rows["www.example-shop.com"]["times"], rows["www.example-shop.com"]["sent_bytes"],
                          rows["www.example-shop.com"]["dgc_browser"]), (1, 10, 1))
        self.assertEqual((rows["evil.example.net"]["not_allowed"], rows["evil.example.net"]["blocked"],
                          rows["evil.example.net"]["dgc_browser"]), (1, 0, 1),
                         "refused as not one of its sites, never shown as a secret stopped")


# --------------------------------------------------------------------------- a real Chromium, in DGC's box

SHOP, NOTES, OTHER = "shop.dgc-lanes.net", "notes.dgc-lanes-two.net", "evil.dgc-lanes-other.net"
PAGE = b"""<!doctype html><title>Shop</title><h1>Shop</h1>
<form id="f" method="post" action="/cart"><input name="item" value="mug"><button id="go">Add</button></form>
<form id="away" method="post" action="http://evil.dgc-lanes-other.net:PORT/collect"><input name="secret" value="s3"><button id="leak">Send</button></form>"""


def serve():
    received = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, body=b"<!doctype html><title>ok</title>ok"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            received.append(("GET", self.headers.get("Host", "").split(":")[0], self.path))
            port = str(self.server.server_address[1]).encode()
            self.reply(PAGE.replace(b"PORT", port) if self.path == "/" else b"<!doctype html><title>Other</title>other")

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            received.append(("POST", self.headers.get("Host", "").split(":")[0], self.path, self.rfile.read(length).decode()))
            self.reply()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, received


@unittest.skipUnless(box.capability().get("available") or os.environ.get("DGC_REQUIRE_CHROMIUM"),
                     "needs Linux, bubblewrap and a Chromium build")
class RealLanes(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-real-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "home").mkdir()
        self.server, self.received = serve()
        self.addCleanup(self.server.shutdown)
        self.port = port = self.server.server_address[1]
        hosts = {SHOP, NOTES, OTHER}
        policy = lambda host, p: ["127.0.0.1"] if host in hosts and p == port else []
        self.proxy = box.EgressProxy(Path(f"/tmp/yb-{os.getpid()}-{id(self)}.sock"), policy=policy)
        self.proxy.start()
        self.addCleanup(self.proxy.stop)
        self.held = []
        self.browser = box.BoxedBrowser(self.root / "home", self.proxy.path, chrome=box.find_chrome(),
                                        log_path=self.root / "box.log", on_write=self.held.append, shared=True)
        self.browser.lane_sent = dgc_browser.LaneSent(self.root / "dgc-browser" / "sent.jsonl")
        self.addCleanup(self.browser.close)
        self.base = f"http://{SHOP}:{port}"

    def wait_for(self, condition, seconds=10):
        end = time.monotonic() + seconds
        while time.monotonic() < end and not condition():
            self.browser.pump(0.3)
        return condition()

    def click(self, element):
        ref = self.browser.evaluate_json(
            f"(() => {{ document.getElementById('{element}').setAttribute('data-dgc-ref','e9{len(element)}'); return 'e9{len(element)}'; }})()")
        self.browser.click(ref)

    def test_the_person_is_free_and_a_lane_is_confined_and_held(self):
        self.browser.start()
        person = self.browser.page_target()
        self.assertEqual(self.browser.navigate(self.base + "/"), "loaded")
        self.click("go")
        self.assertTrue(self.wait_for(lambda: any(r[0] == "POST" for r in self.received)),
                        "the person's own submit goes straight out: DGC Browser never holds the person")
        self.assertEqual(self.held, [])
        lane = self.browser.open_lane(A, self.base + "/", dgc_browser.Grants(["dgc-lanes.net"]))
        self.assertEqual(self.browser.owner_of(lane), A)
        self.assertEqual(self.browser.owner_of(person), box.PERSON)
        self.assertEqual(self.browser.page_target(), lane, "DGC drives the lane, without bringing it to the front")
        self.received.clear()
        self.click("go")
        self.assertTrue(self.wait_for(lambda: self.held), "the Pip's submit inside its sites waits for its level")
        self.assertEqual((self.held[0].owner, self.held[0].summary()["path"]), (A, "/cart"))
        self.assertEqual([r for r in self.received if r[0] == "POST"], [])
        self.browser.drop(self.held[0].request_id)
        self.received.clear()
        self.browser.navigate(f"http://{OTHER}:{self.port}/")
        self.assertNotIn(OTHER, [r[1] for r in self.received], "a page outside its sites never loads")
        self.assertIn(OTHER, self.browser.lane(A).refused[-1])
        self.browser.navigate(self.base + "/")
        self.click("leak")
        self.browser.pump(1.5)
        self.assertNotIn(OTHER, [r[1] for r in self.received], "a write to another site is refused, never sent")
        off = "(() => { try { new RTCPeerConnection(); return 'on'; } catch (e) { return 'off'; } })()"
        self.assertEqual(self.browser.evaluate_json(off), "off", "no WebRTC in a lane: the gate can't see it")
        self.browser.switch_tab(person, settle=1.0)
        self.assertEqual(self.browser.evaluate_json(off), "on", "the person's own tab is untouched")
        self.browser.lane_sent.flush()
        lines = [json.loads(l) for l in (self.root / "dgc-browser" / "sent.jsonl").read_text().splitlines()]
        self.assertTrue(any(l["pip_id"] == A and l["host"] == SHOP and l["kind"] == "request" for l in lines), lines)
        self.assertTrue(any(l["pip_id"] == A and l["host"] == OTHER and l["kind"] == "refused" for l in lines), lines)
        self.assertFalse(any(l.get("pip_id") not in (A,) for l in lines), "only the lane's traffic, never the person's")


TOP, THIRD = "shop.dgc-lanes.net", "widget.dgc-cookies-third.net"


def serve_https(folder: Path):
    """A local HTTPS site under two names: THIRD sets a cookie (SameSite=None; Secure) when visited itself; TOP embeds
    THIRD in a frame. Each frame load records whether that cookie came with it."""
    import ssl
    import subprocess
    key, cert = folder / "key.pem", folder / "cert.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert),
                    "-days", "1", "-subj", "/CN=dgc-lanes-test", "-addext", f"subjectAltName=DNS:{TOP},DNS:{THIRD}"],
                   check=True, capture_output=True)
    frames = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            host = self.headers.get("Host", "").split(":")[0]
            extra = []
            if host == THIRD and self.path == "/set":
                body, extra = b"<!doctype html><title>set</title>set", [("Set-Cookie", "tp=1; SameSite=None; Secure; Path=/")]
            elif host == THIRD and self.path.startswith("/frame"):
                frames.append("tp=1" in (self.headers.get("Cookie") or ""))
                body = b"<!doctype html><title>frame</title>frame"
            else:
                body = f'<!doctype html><title>Top</title><iframe src="https://{THIRD}/frame"></iframe>'.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            for name, value in extra:
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(cert), str(key))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, frames


@unittest.skipUnless((box.capability().get("available") or os.environ.get("DGC_REQUIRE_CHROMIUM"))
                     and __import__("shutil").which("openssl"), "needs Linux, bubblewrap, a Chromium build and openssl")
class RealThirdPartyCookies(unittest.TestCase):
    """Decision 2, in a real Chromium over HTTPS: a cookie a site set when visited itself never goes with its frame in
    another site's page, in a Pip's lane (Chrome's own control on that tab) and with DGC Browser's profile setting."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-3p-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.server, self.frames = serve_https(self.root)
        self.addCleanup(self.server.shutdown)
        port = self.server.server_address[1]

        class Proxy(box.EgressProxy):
            def _open(self, host, _port):      # every secure connection to the two test names reaches the local site
                return socket.create_connection(("127.0.0.1", port), timeout=15) if host in (TOP, THIRD) else None

        self.proxy = Proxy(Path(f"/tmp/yb3p-{os.getpid()}-{id(self)}.sock"))
        self.proxy.start()
        self.addCleanup(self.proxy.stop)

    def browser(self, name, *, prefs=False):
        (self.root / name).mkdir()
        if prefs:
            dgc_browser.profile_prefs(self.root / name / ".browser")
        browser = box.BoxedBrowser(self.root / name, self.proxy.path, chrome=box.find_chrome(),
                                   log_path=self.root / f"{name}.log", shared=True)
        self.addCleanup(browser.close)
        browser.start()
        browser._browser_call("Security.setIgnoreCertificateErrors", {"ignore": True})
        return browser

    def frame_had_cookie(self, browser, *, lane=None):
        before = len(self.frames)
        if lane is None:
            browser.navigate(f"https://{TOP}/")
        else:
            browser.open_lane(lane, f"https://{TOP}/", dgc_browser.Grants(["dgc-lanes.net"]))
        end = time.monotonic() + 10
        while len(self.frames) == before and time.monotonic() < end:
            browser.pump(0.3)
        self.assertGreater(len(self.frames), before, "the frame loaded")
        return self.frames[-1]

    def test_a_lane_and_dgc_browsers_profile_keep_third_party_cookies_off(self):
        plain = self.browser("plain")
        plain.navigate(f"https://{THIRD}/set")
        self.assertTrue(self.frame_had_cookie(plain), "the control: an everyday profile sends it")
        self.assertFalse(self.frame_had_cookie(plain, lane=A), "a Pip's lane never sends it")
        mine = self.browser("yours", prefs=True)
        mine.navigate(f"https://{THIRD}/set")
        self.assertFalse(self.frame_had_cookie(mine), "DGC Browser's profile never sends it, in the person's tabs too")


if __name__ == "__main__":
    unittest.main()
