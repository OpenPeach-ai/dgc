"""Borrowing the user's own signed-in Chrome, with their consent each time (pip_borrow, Pips API 59).

A stand-in Chrome (tests/fake_chrome.py) plays the user's: its DevTools endpoint, its own tab, Chrome's "Allow remote
debugging?" (held, Cancel is 403), and its Fetch gate, each redirect hop separately. The real Chrome of this machine's
user is never touched. LiveBorrowTests runs the same rules on a real Chromium with its own scratch profile when
PLAYWRIGHT_BROWSERS_PATH names one."""
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import browser_user, pip_borrow, pip_careful, pip_chat, pip_levels, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests.fake_chrome import USERS_TAB, USERS_URL, FakeChrome, Page
from tests.test_pip_levels import Store

REAL_REACH = pip_borrow.reach_reason
SHOP = "https://shop.example"
ELSEWHERE = "https://evil.example"
CARD = "4111 1111 1111 1111"


def shop_pages():
    return {
        SHOP + "/orders": Page("Your orders", ['- heading "Your orders" [e1]', '- link "Order 1001" [e2]',
                                               '- link "Help (another site)" [e3]', '- button "Search" [e4]',
                                               '- button "Place order" [e5]', '- link "Receipt" [e6]', '- button "Delete" [e7]',
                                               '- textbox "Password" [e8]', '- textbox "Search orders" [e9]',
                                               '- text "Saved card ' + CARD + '" [e10]', '- button "Track" [e11]'],
                               refs={"e2": ("link", SHOP + "/orders/1001"), "e3": ("link", ELSEWHERE + "/help"),
                                     "e4": ("form", SHOP + "/search", "q=mugs"),
                                     "e5": ("form", SHOP + "/checkout", "item=mug&qty=2"),
                                     "e6": ("popup", SHOP + "/receipt/1001"),
                                     "e7": ("form", SHOP + "/orders/1001/remove", "id=1001"),
                                     "e11": ("fetch", ELSEWHERE + "/collect", "order=1001")},
                               secret={"e8"}),
        SHOP + "/orders/1001": Page("Order 1001", ['- heading "Order 1001: 2 mugs, 18.00" [e1]']),
        SHOP + "/bounce": Page("Bouncing", [], redirect=ELSEWHERE + "/steal"),
        SHOP + "/search": Page("Results", ['- heading "2 orders with mugs" [e1]']),
        SHOP + "/checkout": Page("Thanks", ['- heading "Order placed" [e1]']),
        SHOP + "/orders/1001/remove": Page("Removed", ['- heading "Order removed" [e1]']),
        ELSEWHERE + "/help": Page("Help", ['- heading "SECRET-ELSEWHERE" [e1]']),
        ELSEWHERE + "/steal": Page("Steal", ['- heading "SECRET-ELSEWHERE" [e1]']),
    }


class Borrow(Store):
    """A Personal Pip, a card, the user's Allow once, and the turn it started, claimed by its run."""

    def setUp(self):
        super().setUp()
        self.pip = self.personal()
        reach = patch.object(pip_borrow, "reach_reason", lambda folders=None: "")
        reach.start()
        self.addCleanup(reach.stop)

    def card(self, sites=("shop.example",), why="read your order history", **kw):
        return pip_borrow.request(self.registry, self.cfg, self.pip["id"], self.pip["workspace_id"], None, list(sites), why,
                                  reach=lambda: "", **kw)

    def allowed_run(self, card=None):
        card = card or self.card()
        self.control("allow_pip_borrow", pip_id=self.pip["id"], borrow_id=card["id"])
        run = dict(self.registry.db.execute(
            "SELECT r.* FROM pip_runs r JOIN pip_chat_messages m ON m.run_id=r.id WHERE m.request_key=?",
            (pip_chat.BORROW_KEY + card["id"],)).fetchone())
        self.registry.db.execute("UPDATE pip_runs SET status='running' WHERE id=?", (run["id"],))
        return card, run

    def lent(self, fake=None, *, level="ask", taint=None, said="", careful=True, card=None):
        fake = fake or FakeChrome(shop_pages())
        self.addCleanup(fake.close)
        # A turn before this one has ended (a test may lend it more than once).
        self.registry.db.execute("UPDATE pip_runs SET status='failed' WHERE pip_id=? AND status IN ('queued','running')",
                                 (self.pip["id"],))
        card, run = self.allowed_run(card)
        grant = pip_borrow.claim(self.registry, run)
        session = pip_borrow.Session(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], run["id"],
                                     grant=grant, folders=fake.folders(), level=level, taint=taint, said=said, careful=careful)
        self.addCleanup(session.close)
        return fake, session, card, run

    def status(self, card):
        return next(b for b in self.control("list_pip_borrows", pip_id=self.pip["id"])["borrows"] if b["id"] == card["id"])

    def wait_for(self, check, seconds=10):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if check():
                return True
            time.sleep(0.05)
        return False


class ConsentEachTimeTests(Borrow):
    def test_api_59_names_the_four_requests_and_nothing_remembers_an_allow(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 59)
        names = {"list_pip_borrows", "allow_pip_borrow", "decline_pip_borrow", "stop_pip_borrow"}
        self.assertLessEqual(names, pips.CONTROL_COMMANDS)
        self.assertEqual({n: pips._COMMAND_ARGS[n] for n in names}, {"list_pip_borrows": {"pip_id"},
                         **{n: {"pip_id", "borrow_id"} for n in names - {"list_pip_borrows"}}})
        self.assertFalse([c for c in pips.CONTROL_COMMANDS if "borrow" in c and "always" in c], "no Always allow for borrowing")

    def test_the_card_is_needed_every_time_and_a_past_allow_is_never_used_again(self):
        card, run = self.allowed_run()
        grant = pip_borrow.claim(self.registry, run)
        self.assertEqual((grant["id"], grant["status"], grant["use_run_id"]), (card["id"], "in_use", run["id"]))
        self.assertEqual(pip_borrow.claim(self.registry, run), {"missed": "used"}, "the same Allow is never claimed twice")
        with self.assertRaises(RegistryError) as again:
            self.control("allow_pip_borrow", pip_id=self.pip["id"], borrow_id=card["id"])
        self.assertIn("already allowed", str(again.exception))
        # Any other turn of the same Pip, its next reply included, has nothing.
        self.registry.db.execute("UPDATE pip_runs SET status='failed' WHERE id=?", (run["id"],))
        other = self.store.enqueue(self.pip["id"], "chat_next", "editor-user", self.cfg,
                                   conversation_request=pip_chat.request("and the next one?", "next-1"))
        self.assertIsNone(pip_borrow.claim(self.registry, other))
        # The next time it needs the user's Chrome, that is a new card, asked anew.
        second = self.card()
        self.assertNotEqual(second["id"], card["id"])
        self.assertEqual(self.status(second)["status"], "requested")

    def test_only_a_turn_dgc_started_can_take_an_allow(self):
        card = self.card()
        with self.assertRaises(RegistryError) as forged:
            pip_chat.send(self.store, self.pip["id"], "use it", pip_chat.BORROW_KEY + card["id"], "editor-user", self.cfg)
        self.assertIn("reserved for messages DGC writes", str(forged.exception))
        with self.assertRaises(RegistryError) as remote:
            self.control("allow_pip_borrow", actor="device_1", pip_id=self.pip["id"], borrow_id=card["id"])
        self.assertIn(remote.exception.code, ("local_only",))

    def test_an_allow_waits_for_a_chrome_this_computer_can_reach_and_says_why_plainly(self):
        nowhere = Path(tempfile.mkdtemp(prefix="dgc-no-chrome-"))
        self.addCleanup(shutil.rmtree, nowhere, True)
        said = REAL_REACH([("Google Chrome", nowhere)])
        self.assertTrue(said.startswith("DGC can't reach your Chrome yet. Turn on remote debugging in the Chrome you use"), said)
        self.assertIn("chrome://inspect/#remote-debugging", said)
        self.assertNotIn("the user", said, "the card speaks to the user")
        card = self.card()
        with patch.object(pip_borrow, "reach_reason", lambda folders=None: said):
            with self.assertRaises(RegistryError) as raised:
                self.control("allow_pip_borrow", pip_id=self.pip["id"], borrow_id=card["id"])
        self.assertEqual((raised.exception.code, str(raised.exception)), ("chrome_unreachable", said))
        self.assertEqual(self.status(card)["status"], "requested", "the card still waits; Allow once can be tried again")
        unreachable = pip_borrow.request(self.registry, self.cfg, self.pip["id"], self.pip["workspace_id"], None, ["shop.example"],
                                         "read your orders", reach=lambda: said)
        self.assertEqual((self.status(unreachable)["reachable"], self.status(unreachable)["unreachable"]), (False, said))

    def test_a_newer_ask_replaces_the_waiting_card_and_an_old_one_cannot_be_allowed(self):
        first = self.card()
        second = self.card(sites=["portal.example.org"], why="read your lab results")
        self.assertEqual(self.status(first)["status"], "replaced")
        with self.assertRaises(RegistryError) as raised:
            self.control("allow_pip_borrow", pip_id=self.pip["id"], borrow_id=first["id"])
        self.assertEqual(raised.exception.code, "borrow_replaced")
        self.assertEqual(self.status(second)["sites"], ["portal.example.org"])

    def test_not_now_tells_the_pip_and_starts_no_borrow(self):
        card = self.card()
        told = []
        with patch.object(pip_chat, "send", lambda store, pip_id, text, key, *a, **k: told.append((text, key)) or {}):
            result = self.control("decline_pip_borrow", pip_id=self.pip["id"], borrow_id=card["id"])
        self.assertEqual(result["borrow"]["status"], "declined")
        [(text, key)] = told
        self.assertTrue(key.startswith(pip_chat.BORROW_NO_KEY))
        self.assertIn("chose Not now", text)
        self.assertIn("must not use it", text)
        self.assertIn("A Not now is about that one card only", text, "the next thing that needs their Chrome asks anew")
        self.assertIsNone(pip_borrow.claim(self.registry, {"id": "run_none", "pip_id": self.pip["id"]}))

    def test_a_routine_asks_and_its_card_waits_for_a_person(self):
        session = pip_borrow.Session(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], "run_routine",
                                     unattended=True)
        told = session.ask({"sites": ["shop.example"], "why": "check last month's orders"})
        self.assertIn("waiting below your reply for their Allow", told)
        self.assertIn("Nobody is here now", told)
        [card] = self.control("list_pip_borrows", pip_id=self.pip["id"])["borrows"]
        self.assertEqual((card["status"], card["unattended"]), ("requested", True))
        self.assertIn("hasn't lent you their Chrome", session.use({"op": "open", "url": SHOP + "/orders"}),
                      "nothing borrows the browser while nobody is there")

    def test_sites_are_origins_as_chrome_spells_them_and_odd_addresses_are_none(self):
        self.assertEqual(pip_borrow.site_origin("shop.example"), "https://shop.example")
        self.assertEqual(pip_borrow.site_origin("HTTP://Shop.Example.:80/orders"), "http://shop.example")
        self.assertEqual(pip_borrow.site_origin("https://bücher.test/x"), "https://xn--bcher-kva.test")
        self.assertEqual(pip_borrow.site_origin("127.0.0.1:8123"), "https://127.0.0.1:8123")
        for odd in ("https://bank.example\\@shop.example/", "https://me@shop.example/", "https://shop.ex%61mple/",
                    "javascript:alert(1)", "file:///etc/passwd", "shop example", ""):
            self.assertEqual(pip_borrow.site_origin(odd), "", odd)
        self.assertEqual(pip_borrow.shown("https://shop.example"), "shop.example")
        self.assertEqual(pip_borrow.shown("http://127.0.0.1:8123"), "http://127.0.0.1:8123", "not https: the whole origin")
        with self.assertRaises(RegistryError):
            self.card(sites=["https://me@shop.example/"])

    def test_a_bare_host_is_https_unless_the_user_wrote_it_with_http(self):
        self.assertEqual(self.card(sites=["127.0.0.1:8123"])["sites"], ["https://127.0.0.1:8123"])
        pip_chat.send(self.store, self.pip["id"], "My orders are on http://127.0.0.1:8123/orders, I'm signed in there.",
                      "orders-1", "editor-user", self.cfg)
        self.assertEqual(self.card(sites=["127.0.0.1:8123"])["sites"], ["http://127.0.0.1:8123"], "the address as they wrote it")
        self.assertEqual(self.card(sites=["https://127.0.0.1:8123"])["sites"], ["https://127.0.0.1:8123"], "a scheme given is kept")
        self.assertEqual(self.card(sites=["127.0.0.1:9999"])["sites"], ["https://127.0.0.1:9999"], "another port is another site")

    def test_the_users_own_browser_rules_hold_for_a_pip(self):
        self.cfg.permissions = {"allow": [], "ask": [], "deny": ["Browser(signed-in:https://bank.example)"]}
        with self.assertRaises(RegistryError) as raised:
            self.card(sites=["bank.example"])
        self.assertEqual(raised.exception.code, "borrow_denied")
        card = self.card(sites=["bank.example", "shop.example"])
        self.assertEqual(card["sites"], ["https://shop.example"], "a denied site never reaches the card")
        self.cfg.permissions = {"allow": [], "ask": [], "deny": ["Browser(signed-in:*)"]}
        with self.assertRaises(RegistryError):
            self.card(sites=["shop.example"])

    def test_a_card_never_carries_a_card_number_or_a_saved_secret(self):
        with self.assertRaises(RegistryError):
            self.card(why=f"pay with {CARD}")


class LentChromeTests(Borrow):
    def test_chrome_asks_too_and_the_pip_reads_in_a_new_tab_of_its_own(self):
        fake, session, card, _ = self.lent()
        said = session.use({"op": "open", "url": SHOP + "/orders"})
        self.assertIn('heading "Your orders"', said)
        self.assertEqual(fake.asked, 1, "Chrome's own Allow remote debugging? came once, for this borrow")
        created = [p for m, p, _ in fake.commands if m == "Target.createTarget"]
        self.assertEqual(created, [{"url": "about:blank", "newWindow": True}], "a window of DGC's own")
        gated = fake.methods()
        self.assertLess(gated.index("Fetch.enable"), gated.index("Page.navigate"), "gated before anything loads")
        self.assertLess(gated.index("Page.addScriptToEvaluateOnNewDocument"), gated.index("Page.navigate"),
                        "WebSockets, WebTransport and WebRTC are off before any page of the tab runs")
        self.assertEqual(self.status(card)["status"], "in_use")
        self.assertTrue(self.wait_for(lambda: self.status(card)["chrome"] == "Google Chrome"))

    def test_only_the_cards_sites_open_and_a_redirect_or_a_link_off_it_is_stopped_before_it_is_sent(self):
        fake, session, _, _ = self.lent()
        refused = session.use({"op": "open", "url": ELSEWHERE + "/"})
        self.assertIn("isn't on the card", refused)
        self.assertEqual([m for m, _, _ in fake.commands if m == "Page.navigate"], [], "nothing was asked of Chrome for it")
        bounced = session.use({"op": "open", "url": SHOP + "/bounce"})
        self.assertIn("DGC stopped the tab going there: evil.example isn't on the card", bounced)
        self.assertIn(("GET", ELSEWHERE + "/steal", "Aborted"), fake.refused_requests)
        self.assertNotIn(ELSEWHERE + "/steal", [u for _, u, _ in fake.sent_requests], "the redirect hop never left Chrome")
        self.assertNotIn("SECRET-ELSEWHERE", bounced)
        session.use({"op": "open", "url": SHOP + "/orders"})
        clicked = session.use({"op": "click", "ref": "e3"})
        self.assertIn("isn't on the card", clicked)
        self.assertNotIn("SECRET-ELSEWHERE", clicked)
        self.assertNotIn(ELSEWHERE + "/help", [u for _, u, _ in fake.sent_requests])
        # Any case or spacing of an op is the same op, and no op but open carries an address.
        self.assertIn("isn't on the card", session.use({"op": " OPEN ", "url": ELSEWHERE + "/x"}))
        self.assertIn("takes no url", session.use({"op": "read", "url": ELSEWHERE + "/x"}))
        for odd in ("https://evil.example\\@shop.example/", "https://me@shop.example/orders"):
            self.assertTrue(session.use({"op": "open", "url": odd}).startswith("error"), odd)

    def test_what_it_would_send_goes_only_as_its_level_allows_and_a_payment_never(self):
        sent = lambda fake: [u for m, u, _ in fake.sent_requests if m == "POST"]
        fake, session, _, _ = self.lent(level=pip_levels.ASK)
        session.use({"op": "open", "url": SHOP + "/orders"})
        told = session.use({"op": "click", "ref": "e4"})
        self.assertEqual(sent(fake), [], "at Ask nothing is sent from the user's Chrome")
        self.assertIn("Not sent: Searched on shop.example. At Ask, DGC doesn't send that", told)
        session.close()
        for level, ref, goes in ((pip_levels.APPROVE, "e4", True), (pip_levels.APPROVE, "e7", False),
                                 (pip_levels.FULL, "e7", True), (pip_levels.FULL, "e5", False)):
            with self.subTest(level=level, ref=ref):
                fake, session, _, _ = self.lent(level=level)
                session.use({"op": "open", "url": SHOP + "/orders"})
                told = session.use({"op": "click", "ref": ref})
                self.assertEqual(bool(sent(fake)), goes, told)
                if not goes and ref == "e5":
                    self.assertIn("A payment never goes from the user's own Chrome", told)
                if goes:
                    self.assertIn(f"Sent at its level ({pip_levels.name(level)})", told)
                session.close()
        # A send to a site that isn't on the card never goes, whatever its level.
        fake, session, _, _ = self.lent(level=pip_levels.FULL)
        session.use({"op": "open", "url": SHOP + "/orders"})
        told = session.use({"op": "click", "ref": "e11"})
        self.assertEqual(sent(fake), [])
        self.assertIn("Not sent: Sending to evil.example, which isn't on the card", told)

    def test_passwords_codes_and_cards_are_never_typed_and_a_card_number_is_never_shown(self):
        fake, session, _, _ = self.lent()
        page = session.use({"op": "open", "url": SHOP + "/orders"})
        self.assertNotIn(CARD, page)
        self.assertIn("•••• (a card number, hidden)", page)
        self.assertIn("never type", session.use({"op": "type", "ref": "e8", "text": "hunter2"}))
        self.assertIn("card number", session.use({"op": "type", "ref": "e9", "text": "5555-5555-5555-4444"}))
        self.assertEqual(fake.typed, [], "nothing reached the page")
        self.assertNotIn("error", session.use({"op": "type", "ref": "e9", "text": "mugs"})[:6])
        self.assertEqual(fake.typed, ["mugs"])

    def test_careful_mode_keeps_what_it_read_in_your_apps_off_your_sites(self):
        taint = pip_careful.Taint()
        taint.add("Your parcel AWB 7788990011 from Rohan Mehta arrives Friday")
        fake, session, _, _ = self.lent(taint=taint, said="find my mug order")
        session.use({"op": "open", "url": SHOP + "/orders"})
        self.assertIn("careful mode", session.use({"op": "type", "ref": "e9", "text": "AWB 7788990011"}))
        self.assertNotIn("error", session.use({"op": "type", "ref": "e9", "text": "Order 1001"})[:6],
                         "what it read on the user's own site may go back there")
        session.use({"op": "click", "ref": "e2"})
        self.assertTrue(taint.carried("Order 1001: 2 mugs, 18.00 is what I found", ""),
                        "what it read in their Chrome counts as what it read in their apps, for careful mode")

    def test_a_page_the_users_rules_ask_about_is_not_acted_on(self):
        self.cfg.permissions = {"allow": [], "ask": ["Browser(signed-in:https://shop.example/orders*)"], "deny": []}
        fake, session, _, _ = self.lent()
        self.assertIn("Your orders", session.use({"op": "open", "url": SHOP + "/orders"}), "reading there is fine")
        told = session.use({"op": "click", "ref": "e2"})
        self.assertIn("the user's own rules ask before DGC acts on this page", told)
        self.assertFalse([m for m, p, _ in fake.commands if m == "Input.dispatchMouseEvent"])
        self.cfg.permissions = {"allow": [], "ask": [], "deny": ["Browser(signed-in:https://shop.example/orders/1001*)"]}
        self.assertTrue(session.use({"op": "open", "url": SHOP + "/orders/1001"}).startswith("PERMISSION DENIED"))

    def test_other_tabs_are_never_listed_read_or_touched_and_a_tab_its_page_opens_is_closed(self):
        fake, session, _, _ = self.lent()
        for step in ({"op": "open", "url": SHOP + "/orders"}, {"op": "read"}, {"op": "find", "text": "Order"},
                     {"op": "click", "ref": "e2"}, {"op": "back"}):
            said = session.use(step)
            self.assertNotIn("My bank", said)
            self.assertNotIn(USERS_URL, said)
        self.assertNotIn("Target.getTargets", fake.methods(), "no list of the user's tabs, ever, while its page opened none")
        popped = session.use({"op": "click", "ref": "e6"})
        self.assertIn("The page opened a new tab", popped)
        self.assertEqual([t for t in fake.dgc_tabs() if t.startswith("popup-")], [], "the tab its page opened is closed")
        session.use({"op": "done"})
        self.assertEqual(fake.touched_users_tab(), [], "the user's own tab: never read, closed or attached to")
        self.assertIn(USERS_TAB, fake.targets)
        self.assertEqual(fake.dgc_tabs(), [])

    def test_another_scheme_or_port_of_the_cards_host_is_another_site(self):
        fake, session, _, _ = self.lent()
        for other in ("http://shop.example/orders", "https://shop.example:8443/orders"):
            self.assertIn("isn't on the card", session.use({"op": "open", "url": other}), other)
        self.assertEqual([m for m, _, _ in fake.commands if m == "Page.navigate"], [], "nothing was asked of Chrome for them")
        self.assertNotIn("isn't on the card", session.use({"op": "open", "url": "https://SHOP.example.:443/orders"}),
                         "the card's site however its address is written")
        self.assertEqual(len([m for m, _, _ in fake.commands if m == "Page.navigate"]), 1)

    def test_a_read_is_judged_by_the_page_it_read(self):
        fake, session, _, _ = self.lent()
        session.use({"op": "open", "url": SHOP + "/orders"})
        # The page moved by itself between DGC's look at the address and its read: what was read is what counts.
        real = fake._evaluate
        fake._evaluate = lambda target, expression: (json.dumps({"url": ELSEWHERE + "/steal", "title": "x",
                                                                "lines": ['- heading "SECRET-ELSEWHERE" [e1]'], "truncated": False})
                                                    if "MAX_NODES" in expression else real(target, expression))
        for step in ({"op": "read"}, {"op": "find", "text": "SECRET"}, {"op": "wait", "text": "SECRET", "seconds": 1}):
            said = session.use(step)
            self.assertNotIn("SECRET-ELSEWHERE", said, step)
            self.assertIn("isn't on the card", said, step)

    def test_a_lost_connection_ends_the_borrow_and_nothing_reconnects(self):
        fake, session, card, _ = self.lent()
        session.use({"op": "open", "url": SHOP + "/orders"})
        fake._conn.shutdown(__import__("socket").SHUT_RDWR)  # Chrome quit, or someone closed DGC's window
        self.assertTrue(self.wait_for(lambda: session.ended == pip_borrow.LOST))
        self.assertIn("Your tab in the user's Chrome closed", session.use({"op": "read"}))
        self.assertTrue(self.wait_for(lambda: self.status(card)["ended"] == pip_borrow.LOST))
        self.assertEqual(fake.asked, 1, "no second connection: the next time is a new card")

    def test_an_ordinary_error_keeps_the_tab(self):
        fake, session, _, _ = self.lent()
        session.use({"op": "open", "url": SHOP + "/orders"})
        self.assertTrue(session.use({"op": "click", "ref": "e99"}).startswith("error:"))
        self.assertIn("Your orders", session.use({"op": "read"}))
        self.assertEqual(fake.connections, 1, "Chrome wasn't asked again")


class GivingItBackTests(Borrow):
    def ended(self, fake, card, how):
        self.assertTrue(self.wait_for(lambda: fake.open_connections == 0), "the connection drops")
        self.assertEqual(fake.dgc_tabs(), [], "DGC's tab is closed")
        self.assertIn("Target.closeTarget", fake.methods())
        self.assertIn(USERS_TAB, fake.targets, "the user's own tab stays")
        self.assertTrue(self.wait_for(lambda: self.status(card)["status"] == "returned"))
        self.assertEqual(self.status(card)["ended"], how)

    def test_done_gives_it_back(self):
        fake, session, card, _ = self.lent()
        session.use({"op": "open", "url": SHOP + "/orders"})
        self.assertIn("You gave the user's Chrome back", session.use({"op": "done"}))
        self.ended(fake, card, pip_borrow.DONE)
        self.assertIn("already gave", session.use({"op": "read"}))

    def test_the_end_of_its_reply_gives_it_back(self):
        fake, session, card, run = self.lent()
        session.use({"op": "open", "url": SHOP + "/orders"})
        session.close()
        self.ended(fake, card, pip_borrow.RUN_END)

    def test_stop_takes_it_back_within_a_second_even_mid_step(self):
        fake, session, card, _ = self.lent()
        session.use({"op": "open", "url": SHOP + "/orders"})
        result = self.control("stop_pip_borrow", pip_id=self.pip["id"], borrow_id=card["id"])
        self.assertEqual((result["borrow"]["status"], result["borrow"]["ended"]), ("returned", pip_borrow.STOPPED))
        self.ended(fake, card, pip_borrow.STOPPED)
        self.assertIn("they chose Stop", session.use({"op": "read"}))

    def test_the_time_limit_gives_it_back(self):
        fake, session, card, _ = self.lent()
        session.use({"op": "open", "url": SHOP + "/orders"})
        session.deadline = time.monotonic()
        self.ended(fake, card, pip_borrow.TIMEOUT)
        self.assertIn("minutes for the user's Chrome ran out", session.use({"op": "read"}))

    def test_a_run_that_stops_any_other_way_gives_it_back(self):
        fake, session, card, run = self.lent()
        session.use({"op": "open", "url": SHOP + "/orders"})
        self.registry.db.execute("UPDATE pip_runs SET status='failed' WHERE id=?", (run["id"],))
        self.ended(fake, card, pip_borrow.RUN_END)

    def test_cancel_in_chromes_own_dialog_is_reported_and_the_pip_carries_on(self):
        fake, session, card, _ = self.lent(FakeChrome(shop_pages(), consent="cancel"))
        told = session.use({"op": "open", "url": SHOP + "/orders"})
        self.assertIn("chose Cancel when their Chrome asked", told)
        self.assertIn("Carry on without it", told)
        self.assertEqual(fake.dgc_tabs(), [])
        self.assertTrue(self.wait_for(lambda: self.status(card)["ended"] == pip_borrow.CHROME_NO))

    def test_stop_while_chrome_is_still_asking_opens_nothing(self):
        fake, session, card, _ = self.lent(FakeChrome(shop_pages(), answer_after=1.5))
        self.control("stop_pip_borrow", pip_id=self.pip["id"], borrow_id=card["id"])
        self.assertIn("they chose Stop", session.use({"op": "open", "url": SHOP + "/orders"}))
        time.sleep(2.0)
        self.assertNotIn("Target.createTarget", fake.methods(), "no tab was opened after the user took it back")
        self.assertTrue(self.wait_for(lambda: fake.open_connections == 0))


# The Pip's model in a real worker: asked in its chat, it asks for the user's Chrome; in the reply the user's Allow once
# starts, it reads the order page in its own tab and gives the Chrome back.
CHAT_WORKER = r'''
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult, ToolCall
from dgc.pips import _worker_main
def chat(self, messages, tools=None, on_text=None, **kwargs):
    names = [t["function"]["name"] for t in (tools or [])]
    results = [m for m in messages if m.get("role") == "tool"]
    system = messages[0]["content"] if messages and messages[0].get("role") == "system" else ""
    assert "borrow_chrome" in names and "call borrow_chrome" in system, (names, system[-400:])
    if "borrowed_chrome" not in names:
        assert "lent you their own" not in system
        if not results:
            return ChatResult(tool_calls=[ToolCall("a1", "borrow_chrome", {"sites": ["shop.example"], "why": "Read your order history"})])
        assert "A card is now below your reply" in str(results[-1]["content"]), results[-1]
        return ChatResult(content="I need your own Chrome for shop.example: allow it once on the card below.")
    assert "lent you their own signed-in Chrome for this reply only, on shop.example" in system, system[-600:]
    if not results:
        return ChatResult(tool_calls=[ToolCall("b1", "borrowed_chrome", {"op": "open", "url": "https://shop.example/orders/1001"})])
    if len(results) == 1:
        assert "Order 1001: 2 mugs, 18.00" in str(results[-1]["content"]), results[-1]
        return ChatResult(tool_calls=[ToolCall("b2", "borrowed_chrome", {"op": "done"})])
    assert "gave the user's Chrome back" in str(results[-1]["content"]), results[-1]
    return ChatResult(content="Your order 1001 was 2 mugs, 18.00.")
with patch.object(LLMClient, "chat", chat):
    raise SystemExit(_worker_main())
'''


class RunTests(Borrow):
    """A real run and its worker: the ask, the card, Allow once, the turn it starts, the tab, done."""

    def turn(self, key=None):
        import subprocess
        import sys
        row = self.store.claim_next()
        popen = subprocess.Popen

        def process(argv, *a, **kw):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", CHAT_WORKER]
            return popen(argv, *a, **kw)
        with patch.object(pips.subprocess, "Popen", side_effect=process):
            result = pips._execute_run(self.registry, row, self.cfg)
        return self.store.finish(row["id"], result=result)

    def test_asked_allowed_once_used_in_its_own_tab_and_given_back(self):
        home = Path(os.environ["HOME"])
        # Where Chrome keeps its profile on this platform (browser_user.profile_folders), so the run finds it.
        folder = (home / "Library" / "Application Support" / "Google" / "Chrome" if sys.platform == "darwin"
                  else home / ".config" / "google-chrome")
        fake = FakeChrome(shop_pages(), folder=folder)
        self.addCleanup(fake.close)
        pip_chat.send(self.store, self.pip["id"], "Find my mug order on shop.example", "mugs-1", "editor-user", self.cfg)
        asked = self.turn()
        self.assertEqual(asked["status"], "succeeded", asked.get("error"))
        self.assertIn("allow it once on the card below", asked["result"]["text"])
        [card] = self.control("list_pip_borrows", pip_id=self.pip["id"])["borrows"]
        self.assertEqual((card["status"], card["sites"], card["why"]), ("requested", ["shop.example"], "Read your order history"))
        self.assertEqual(fake.connections, 0, "asking connects to nothing")
        self.control("allow_pip_borrow", pip_id=self.pip["id"], borrow_id=card["id"])
        lent = self.turn()
        self.assertEqual(lent["status"], "succeeded", lent.get("error"))
        self.assertEqual(lent["result"]["text"], "Your order 1001 was 2 mugs, 18.00.")
        self.assertEqual(fake.asked, 1)
        self.assertEqual(fake.dgc_tabs(), [], "its tab closed")
        self.assertTrue(self.wait_for(lambda: fake.open_connections == 0), "and the connection dropped")
        self.assertEqual(fake.touched_users_tab(), [])
        done = self.status(card)
        self.assertEqual((done["status"], done["ended"]), ("returned", pip_borrow.DONE))
        messages = pip_chat.list_messages(self.store, self.pip["id"])["messages"]
        borrow_turn = [m for m in messages if m["role"] == "user" and m.get("intro")]
        self.assertEqual(len(borrow_turn), 1, "the turn DGC wrote after Allow once is not shown as the user's")
        self.assertIn("chose Allow once", borrow_turn[0]["text"])


class WorkerToolsTests(Borrow):
    def test_the_run_socket_carries_both_tools_and_the_reply_it_was_lent_to_is_told(self):
        from dgc import pip_app_links
        fake, session, card, run = self.lent()
        socket_ = pip_app_links.RunSocket(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], run["id"])
        self.addCleanup(socket_.close)
        socket_.borrow = session
        pin = socket_.pin()
        self.assertEqual(pin["borrow"], {"id": card["id"], "sites": ["shop.example"], "minutes": pip_borrow.MINUTES})
        said = pip_app_links.worker_call(pin, "borrowed_chrome", {"op": "open", "url": SHOP + "/orders"}, timeout=60)
        self.assertIn("Your orders", said)
        asked = pip_app_links.worker_call(pin, "borrow_chrome", {"sites": ["portal.example.org"], "why": "read your lab results"})
        self.assertIn("A card is now below your reply", asked)
        socket_.close()
        self.assertTrue(self.wait_for(lambda: self.status(card)["status"] == "returned"), "a run's end gives it back")
        self.assertIn("use_notice", dir(pip_borrow))
        self.assertIn("shop.example", pip_borrow.use_notice(pin["borrow"]))
        self.assertIn("borrowed_chrome", pip_borrow.USE_SCHEMA["function"]["name"])


def _chromium():
    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    builds = sorted(Path(root).glob("chromium-*/chrome-*/chrome"), reverse=True) if root else []
    return builds[0] if builds else None


class LiveBorrowTests(Borrow):
    """A real Chromium standing in for the user's Chrome, with its own scratch profile and a debugging port, so it
    writes DevToolsActivePort as theirs does: the gate, the masking and the closing, measured in a real browser."""

    def test_a_real_chrome_lent_once(self):
        binary = _chromium()
        if binary is None:
            self.skipTest("no Chromium here (set PLAYWRIGHT_BROWSERS_PATH)")
        site = Path(tempfile.mkdtemp(prefix="dgc-borrow-site-"))
        self.addCleanup(shutil.rmtree, site, True)
        hits = []

        class Shop(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                hits.append(("GET", self.path))
                if self.path.startswith("/bounce"):
                    self.send_response(302)
                    self.send_header("Location", f"http://localhost:{port}/stolen")
                    self.end_headers()
                    return
                super().do_GET()

            def do_POST(self):
                hits.append(("POST", self.path, self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"<h1>posted</h1>")
        listener = __import__("socket").socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(4)
        listener.settimeout(0.2)
        self.addCleanup(listener.close)
        sockets = []

        def accept():
            while True:
                try:
                    sockets.append(listener.accept()[0])
                except OSError as error:
                    if not isinstance(error, TimeoutError) and "timed out" not in str(error):
                        return
        threading.Thread(target=accept, daemon=True).start()
        (site / "orders.html").write_text(
            "<title>Your orders</title><h1>Order 1001: 2 mugs</h1>"
            f"<script>try {{ new WebSocket('ws://127.0.0.1:{listener.getsockname()[1]}/feed'); }} catch (e) {{}}</script>"
            "<input type=password value=hunter2-saved><input autocomplete='billing cc-number' value=4111111111111111>"
            "<input type=text name=password value=SHOWN-PASSWORD><p>Card on file " + CARD + "</p>"
            "<a href='/receipt.html' target='_blank'>Receipt</a>"
            "<form method=post action='/search'><input name=q value=mugs><button>Search</button></form>"
            "<a href='/bounce'>Away</a>")
        (site / "receipt.html").write_text("<title>Receipt</title><p>receipt</p>")
        (site / "worker.html").write_text("<title>Worker</title><h1>worker page</h1><script>new Worker('/worker.js')</script>")
        (site / "worker.js").write_text(f"try {{ new WebSocket('ws://127.0.0.1:{listener.getsockname()[1]}/w'); }} catch (e) {{}}")
        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), lambda *a, **k: Shop(*a, directory=str(site), **k))
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        shop = f"http://127.0.0.1:{port}"
        profile = Path(tempfile.mkdtemp(prefix="dgc-standin-chrome-"))
        users_page = f"{shop}/receipt.html?the-users-own-tab"
        chrome = subprocess.Popen([str(binary), "--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu",
                                   "--disable-background-networking", "--no-proxy-server", "--remote-debugging-port=0",
                                   f"--user-data-dir={profile}", users_page], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (chrome.kill(), chrome.wait(), shutil.rmtree(profile, True)))
        deadline = time.monotonic() + 30
        while browser_user.active_port(profile) is None and time.monotonic() < deadline:
            time.sleep(0.2)
        folders = [("Test Chrome", profile)]
        card = pip_borrow.request(self.registry, self.cfg, self.pip["id"], self.pip["workspace_id"], None, [shop], "read your orders",
                                  reach=lambda: "")
        _, run = self.allowed_run(card)
        session = pip_borrow.Session(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], run["id"],
                                     grant=pip_borrow.claim(self.registry, run), folders=folders, level=pip_levels.ASK)
        self.addCleanup(session.close)
        page = session.use({"op": "open", "url": f"{shop}/orders.html"})
        self.assertIn("Order 1001: 2 mugs", page)
        for secret in ("hunter2-saved", "4111111111111111", "SHOWN-PASSWORD", CARD):
            self.assertNotIn(secret, page)
        time.sleep(0.5)
        self.assertEqual(sockets, [], "a WebSocket from DGC's tab never connects: the gate can't see what it carries")
        worker = session.use({"op": "open", "url": f"{shop}/worker.html"})
        self.assertIn("worker page", worker)
        time.sleep(1.0)
        self.assertEqual(sockets, [], "nor from a worker of the tab")
        bounced = session.use({"op": "open", "url": f"{shop}/bounce"})
        self.assertIn("isn't on the card", bounced)
        self.assertNotIn(("GET", "/stolen"), hits, "the redirect's hop to another origin never left Chrome")
        session.use({"op": "open", "url": f"{shop}/orders.html"})
        ref = lambda label: next(l.split("[")[-1].split("]")[0] for l in session.use({"op": "read"}).splitlines() if label in l)
        told = session.use({"op": "click", "ref": ref('"Search"')})
        self.assertFalse([h for h in hits if h[0] == "POST"], "at Ask the search form is not sent")
        self.assertIn("Not sent", told)
        session.use({"op": "click", "ref": ref('"Receipt"')})          # target=_blank: opens in DGC's own tab instead
        session.use({"op": "done"})
        time.sleep(0.5)
        with __import__("urllib.request").request.urlopen(
                f"http://127.0.0.1:{browser_user.active_port(profile)[0]}/json/list", timeout=10) as r:
            left = [t["url"] for t in json.load(r) if t.get("type") == "page"]
        self.assertEqual(left, [users_page], "only the user's own tab is left, as it was")
        self.assertIsNone(chrome.poll(), "the user's Chrome keeps running")


if __name__ == "__main__":
    unittest.main()
