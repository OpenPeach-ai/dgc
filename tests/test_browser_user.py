"""The user's own Chrome for a Work session (the founder, 2026-10-13): found through the DevToolsActivePort a Chrome that
allows remote debugging writes; one tab of DGC's in a window of its own; only on sites the user allowed, every mode."""
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import browser, browser_user, tools
from dgc.permissions import PermissionEngine, rule_for


class FindTests(unittest.TestCase):
    def folder(self, text=None):
        folder = Path(tempfile.mkdtemp(prefix="dgc-chrome-profile-"))
        self.addCleanup(shutil.rmtree, folder, True)
        if text is not None:
            (folder / "DevToolsActivePort").write_text(text)
        return folder

    def test_no_chrome_allowing_it_says_what_to_ask_the_user(self):
        with self.assertRaises(browser.BrowserError) as raised:
            browser_user.find([("Google Chrome", self.folder())])
        self.assertIn("chrome://inspect/#remote-debugging", str(raised.exception))
        self.assertIn("Chrome then asks them, each time DGC connects", str(raised.exception))

    def test_a_file_left_by_a_chrome_that_quit_is_not_a_chrome(self):
        with socketserver.TCPServer(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler) as free:
            port = free.server_address[1]
        with self.assertRaises(browser.BrowserError) as raised:
            browser_user.find([("Google Chrome", self.folder(f"{port}\n/devtools/browser/abc\n"))])
        self.assertIn("isn't running", str(raised.exception))

    def test_only_a_well_formed_port_file_counts(self):
        for text in ("", "9222\n", "abc\n/devtools/browser/x\n", "70000\n/devtools/browser/x\n", "9222\n/json/list\n"):
            with self.subTest(text=text):
                self.assertIsNone(browser_user.active_port(self.folder(text)))
        self.assertEqual(browser_user.active_port(self.folder("9222\n/devtools/browser/abc-1\n")), (9222, "/devtools/browser/abc-1"))

    def test_each_platform_looks_in_its_own_folders(self):
        for platform, expected in (("darwin", "Library/Application Support/Google/Chrome"), ("linux", ".config/google-chrome"),
                                   ("win32", "Google/Chrome/User Data")):
            with patch.object(browser_user.sys, "platform", platform), patch.dict(os.environ, {"XDG_CONFIG_HOME": ""}):
                first = browser_user.profile_folders()[0]
            self.assertEqual(first[0], "Google Chrome")
            self.assertIn(expected, first[1].as_posix(), platform)


class PermissionTests(unittest.TestCase):
    """Opening a site in the user's Chrome asks them in every mode; a rule for the throwaway browser never covers it."""

    def test_every_mode_asks_before_a_new_site_and_plan_mode_refuses(self):
        call = {"operation": "open", "url": "https://mail.google.com/mail/u/0/", "signed_in": True}
        for mode, expected in (("auto", "ask"), ("acceptEdits", "ask"), ("default", "ask"), ("plan", "deny")):
            engine = PermissionEngine(mode, {"allow": ["Browser(*)", "Browser"], "ask": [], "deny": []})
            self.assertEqual(engine.decide("browser", call)[0], expected, mode)
        self.assertEqual(PermissionEngine("auto", {"allow": [], "ask": [], "deny": []}).decide(
            "browser", {"operation": "open", "url": "https://mail.google.com/"})[0], "allow", "the throwaway browser as before")

    def test_a_site_the_user_saved_is_that_site_alone(self):
        rule = rule_for("browser", {"operation": "open", "url": "https://mail.google.com/mail/u/0/#inbox", "signed_in": True})
        self.assertEqual(rule, "Browser(signed-in:https://mail.google.com)")
        engine = PermissionEngine("default", {"allow": [rule], "ask": [], "deny": []})
        self.assertEqual(engine.decide("browser", {"operation": "open", "url": "https://mail.google.com/x", "signed_in": True})[0], "allow")
        self.assertEqual(engine.decide("browser", {"operation": "open", "url": "https://drive.google.com/", "signed_in": True})[0], "ask")
        self.assertEqual(engine.decide("browser", {"operation": "open", "url": "https://mail.google.com.evil.example/", "signed_in": True})[0], "ask")

    def test_a_site_denied_for_the_browser_is_denied_signed_in_too(self):
        engine = PermissionEngine("auto", {"allow": [], "ask": [], "deny": ["Browser(https://bank.example/*)"]})
        self.assertEqual(engine.decide("browser", {"operation": "open", "url": "https://bank.example/login", "signed_in": True})[0], "deny")
        engine = PermissionEngine("auto", {"allow": [], "ask": [], "deny": ["Browser(signed-in:*)"]})
        self.assertEqual(engine.decide("browser", {"operation": "open", "url": "https://a.example/", "signed_in": True})[0], "deny",
                         "Browser(signed-in:*) turns it off")

    def test_however_the_call_is_spelled_an_address_asks(self):
        engine = PermissionEngine("auto", {"allow": ["Browser(*)", "Browser(signed-in:https://mail.example)"], "ask": [], "deny": []})
        for op in ("Open", " open", "OPEN", "Screenshot", "snapshot", "click", "wait"):
            with self.subTest(op=op):
                self.assertEqual(engine.decide("browser", {"operation": op, "url": "https://bank.example/", "signed_in": True})[0], "ask")
        for url in ("https://bank.example\\@mail.example/", "https://x@mail.example/"):
            self.assertEqual(engine.decide("browser", {"operation": "open", "url": url, "signed_in": True})[0], "ask",
                             "a saved site can't be borrowed by an address Chrome reads differently")

    def test_an_ask_rule_makes_clicks_in_the_users_accounts_ask(self):
        engine = PermissionEngine("auto", {"allow": [], "ask": ["Browser(signed-in:*)"], "deny": []})
        self.assertEqual(engine.decide("browser", {"operation": "click", "ref": "e2", "signed_in": True})[0], "ask")

    def test_one_site_however_its_address_is_written(self):
        engine = PermissionEngine("auto", {"allow": [], "ask": [], "deny": ["Browser(signed-in:http://bank.test)"]})
        for url in ("http://bank.test:80/", "http://BANK.test./x", "http://bank.test/"):
            with self.subTest(url=url):
                self.assertEqual(engine.decide("browser", {"operation": "open", "url": url, "signed_in": True})[0], "deny")
        self.assertEqual(rule_for("browser", {"operation": "open", "url": "http://bücher.test/a", "signed_in": True}),
                         "Browser(signed-in:http://xn--bcher-kva.test)", "as Chrome spells it, so the saved rule is used")

    def test_rules_see_the_page_an_action_is_on(self):
        engine = PermissionEngine("auto", {"allow": [], "ask": ["Browser(signed-in:http://localhost:8000)"],
                                           "deny": ["Browser(signed-in:http://ok.test/private*)"]})
        click = {"operation": "click", "ref": "e1", "signed_in": True}
        self.assertEqual(engine.decide("browser", {**click, "_page": "http://localhost:8000/x"})[0], "ask")
        self.assertEqual(engine.decide("browser", {**click, "_page": "http://ok.test/private/settings"})[0], "deny")
        self.assertEqual(engine.decide("browser", {**click, "_page": "http://ok.test/public"})[0], "allow")

    def test_always_allow_never_becomes_a_bare_browser_rule(self):
        long_site = ".".join(["a" * 60, "b" * 60, "example"])         # over 80 characters, a real name
        rule = rule_for("browser", {"operation": "open", "url": f"https://{long_site}/x", "signed_in": True})
        self.assertEqual(rule, f"Browser(signed-in:https://{long_site})")

    def test_a_screenshot_with_an_address_is_an_open(self):
        engine = PermissionEngine("auto", {"allow": [], "ask": [], "deny": []})
        self.assertEqual(engine.decide("browser", {"operation": "screenshot", "url": "https://a.example/", "signed_in": True})[0], "ask")
        self.assertEqual(engine.decide("browser", {"operation": "click", "ref": "e3", "signed_in": True})[0], "allow",
                         "acting is kept to allowed sites by the tool")


class ConsentTests(unittest.TestCase):
    """Chrome asks the user each time DGC connects (measured with Chrome 155: it holds the connection until they answer;
    Cancel is 403 Forbidden). What the model is told says which happened."""

    def said(self, error):
        session = browser_user.UserChromeSession(folders=[])
        with patch.object(browser_user, "find", return_value=("Google Chrome", 9222, "/devtools/browser/x")), \
                patch.object(browser_user, "_WebSocket", side_effect=error):
            with self.assertRaises(browser.BrowserError) as raised:
                session.start()
        self.assertIsNone(session._ws)
        return str(raised.exception)

    def test_cancel_is_a_no_and_the_model_carries_on_without_it(self):
        said = self.said(browser.BrowserError("devtools refused the websocket upgrade: HTTP/1.1 403 Forbidden"))
        self.assertTrue(said.startswith("The user said no in Google Chrome"), said)
        self.assertNotIn("chrome://inspect", said, "no instructions to turn on what they just declined")

    def test_no_answer_and_not_running_are_said_as_such(self):
        self.assertIn("Nobody answered Google Chrome's \"Allow remote debugging?\"", self.said(TimeoutError("timed out")))
        said = self.said(ConnectionRefusedError(111, "Connection refused"))
        self.assertIn("isn't running, or remote debugging was turned off", said)
        self.assertIn("chrome://inspect/#remote-debugging", said)


class PageLogTests(unittest.TestCase):
    """The console and network log are the page's own: a new page in the tab starts them again, so a site the tab
    passed through (a sign-in bounce) leaves nothing behind; an alert never blocks the tab."""

    def test_a_new_page_clears_what_the_last_one_logged(self):
        session = browser.BrowserSession(Path("/x/chrome"))
        session._observe({"method": "Log.entryAdded", "params": {"entry": {"level": "info", "text": "SECRET-CONSOLE"}}})
        session._observe({"method": "Network.responseReceived", "params": {"response": {"url": "https://evil.example/api?token=S", "status": 200}}})
        session._observe({"method": "Network.responseReceived", "params": {"response": {"url": "https://mail.example/", "status": 200}, "type": "Document"}})
        session._observe({"method": "Page.frameNavigated", "params": {"frame": {"id": "sub", "parentId": "main", "url": "https://ads.example/"}}})
        self.assertEqual(len(session.console_messages()), 1, "an iframe's navigation is not a new page")
        session._observe({"method": "Page.frameNavigated", "params": {"frame": {"id": "main", "url": "https://mail.example/"}}})
        self.assertEqual(session.console_messages(), [])
        self.assertEqual([r["url"] for r in session.network_requests()], ["https://mail.example/"], "its own document stays")

    def test_an_alert_is_answered_at_once_and_said(self):
        session = browser.BrowserSession(Path("/x/chrome"))
        sent = []
        session._ws = SimpleNamespace(send=sent.append)
        session._session_id = "mine"
        session._observe({"method": "Page.javascriptDialogOpening", "sessionId": "mine", "params": {"type": "alert", "message": "Hi"}})
        self.assertEqual([(m["method"], m["params"], m["sessionId"]) for m in sent], [("Page.handleJavaScriptDialog", {"accept": False}, "mine")])
        self.assertEqual(session._page.console, ["dialog (alert, dismissed): Hi"])
        session._observe({"method": "Page.javascriptDialogOpening", "sessionId": "mine", "params": {"type": "beforeunload"}})
        self.assertEqual(sent[-1]["params"], {"accept": True}, "leaving the page is let through")


class PopupTests(unittest.TestCase):
    def test_every_tab_its_page_opened_closes_with_it_however_deep_and_no_other(self):
        session = browser_user.UserChromeSession(folders=[])
        session._target_id, session._ws = "dgc", SimpleNamespace(close=lambda: None)
        targets = [{"targetId": "dgc", "type": "page"}, {"targetId": "users", "type": "page"},
                   {"targetId": "pop", "type": "page", "openerId": "dgc"}, {"targetId": "grandpop", "type": "page", "openerId": "pop"},
                   {"targetId": "theirs", "type": "page", "openerId": "users"}]
        closed = []

        def command(method, params=None, timeout=0):
            if method == "Target.getTargets":
                return {"targetInfos": targets}
            closed.append(params["targetId"])
            return {}
        session.command = command
        session._cleanup()
        self.assertEqual(sorted(closed), ["dgc", "grandpop", "pop"])


class SharedBrowserTests(unittest.TestCase):
    """In a browser DGC shares, only its own tab's messages are its: another tab's load or console never counts."""

    def test_another_tabs_load_does_not_end_the_wait_and_its_console_is_not_read(self):
        session = browser_user.UserChromeSession(folders=[])
        session._session_id = "mine"
        stream = [{"method": "Log.entryAdded", "sessionId": "theirs", "params": {"entry": {"level": "info", "text": "their secret"}}},
                  {"method": "Page.loadEventFired", "sessionId": "theirs", "params": {}},
                  {"method": "Log.entryAdded", "sessionId": "mine", "params": {"entry": {"level": "info", "text": "mine"}}},
                  {"method": "Page.loadEventFired", "sessionId": "mine", "params": {}}]
        session._ws = SimpleNamespace(settimeout=lambda t: None, recv=lambda: stream.pop(0) if stream else (_ for _ in ()).throw(OSError("done")))
        self.assertEqual(session._await_load(), "loaded")
        self.assertEqual(stream, [], "it waited past their load for its own")
        self.assertEqual(session.console_messages(), ["info: mine"])


class FakeTab:
    """DGC's tab in the user's Chrome, as the tool sees it: where it is, what it shows, where a link or the site sends it."""

    def __init__(self, pages, redirects=None, links=None):
        self.pages, self.redirects, self.links = pages, redirects or {}, links or {}
        self.href, self.allowed_hosts, self.note, self.current_url, self.closed, self.started = "about:blank", set(), "", "", 0, 0
        self.snap_url = None            # a snapshot that read another page than location.href said a moment before

    def start(self):
        self.started += 1

    def evaluate_json(self, expression):
        return self.href

    def navigate(self, url):
        self.href = self.current_url = self.redirects.get(url, url)
        return "loaded"

    def snapshot(self):
        here = self.snap_url or self.href
        return {"url": here, "title": "", "lines": [self.pages.get(here, "(blank)")]}

    def click(self, ref):
        if ref in self.links:
            self.href = self.current_url = self.links[ref]
        return "a link"

    def close(self):
        self.closed += 1


class ToolTests(unittest.TestCase):
    """The tool keeps to the sites the user allowed, wherever the tab goes by itself, and reads nothing of anywhere else."""

    ALLOWED, ELSEWHERE = "https://mail.example/inbox", "https://evil.example/phish"

    def setUp(self):
        self.ctx = SimpleNamespace(config={}, cancelled=threading.Event(), tool_owner=f"user-chrome-{id(self)}", project_root=".")
        self.addCleanup(tools.shutdown_browsers, self.ctx.tool_owner)

    def tab(self, **kw):
        tab = FakeTab({self.ALLOWED: "- heading \"3 unread\"", self.ELSEWHERE: "- heading \"SECRET 42 unread\""}, **kw)
        patcher = patch.object(tools, "_browser_session", side_effect=lambda ctx, signed_in=False: tools._BROWSERS.setdefault(
            ctx.tool_owner + tools.SIGNED_IN, tab))
        patcher.start()
        self.addCleanup(patcher.stop)
        return tab

    def use(self, **args):
        return tools.browser_tool({**args, "signed_in": True}, self.ctx)

    def test_open_allows_that_site_and_reading_there_works(self):
        tab = self.tab()
        self.assertIn("3 unread", self.use(operation="open", url=self.ALLOWED))
        self.assertEqual(tab.allowed_hosts, {"https://mail.example"}, "a site is its origin: scheme, host and port")
        self.assertIn("3 unread", self.use(operation="snapshot"))

    def test_a_redirect_to_another_site_stops_before_reading_it(self):
        tab = self.tab(redirects={self.ALLOWED: self.ELSEWHERE})
        said = self.use(operation="open", url=self.ALLOWED)
        self.assertIn("now on https://evil.example, which the user hasn't allowed. Nothing from there was read", said)
        self.assertNotIn("SECRET", said)
        self.assertEqual(tab.allowed_hosts, {"https://mail.example"}, "where it was sent is not allowed by itself")

    def test_a_click_that_leaves_the_site_reads_nothing_of_where_it_went(self):
        tab = self.tab(links={"e2": self.ELSEWHERE})
        self.use(operation="open", url=self.ALLOWED)
        said = self.use(operation="click", ref="e2")
        self.assertTrue(said.startswith("clicked e2 (a link). The tab in the user's Chrome is now on https://evil.example"), said)
        self.assertNotIn("SECRET", said)
        for op in ({"operation": "snapshot"}, {"operation": "type", "ref": "e3", "text": "hunter2"}, {"operation": "find", "text": "x"}):
            with self.subTest(op=op["operation"]):
                said = self.use(**op)
                self.assertIn("which the user hasn't allowed", said)
                self.assertNotIn("SECRET", said)

    def test_an_action_never_carries_an_address(self):
        tab = self.tab()
        self.use(operation="open", url=self.ALLOWED)
        for op in ({"operation": "click", "ref": "e2"}, {"operation": "press", "key": "Enter"}, {"operation": "type", "ref": "e2", "text": "x"}):
            with self.subTest(op=op["operation"]):
                said = self.use(**op, url=self.ALLOWED)
                self.assertIn("takes no url in the user's Chrome", said)

    def test_a_snapshot_is_judged_by_the_page_it_read(self):
        # The page moved on its own between the check and the read: what was read is what counts.
        tab = self.tab()
        self.use(operation="open", url=self.ALLOWED)
        tab.snap_url = self.ELSEWHERE
        for op in ({"operation": "snapshot"}, {"operation": "find", "text": "unread"}, {"operation": "wait", "text": "unread", "seconds": 1}):
            with self.subTest(op=op["operation"]):
                said = self.use(**op)
                self.assertNotIn("SECRET", said)
                self.assertIn("which the user hasn't allowed", said)

    def test_another_port_or_scheme_of_the_same_host_is_another_site(self):
        tab = self.tab(links={"e2": "http://mail.example:8443/admin"})
        tab.pages["http://mail.example:8443/admin"] = "- heading \"ADMIN\""
        self.use(operation="open", url=self.ALLOWED)
        said = self.use(operation="click", ref="e2")
        self.assertIn("now on http://mail.example:8443, which the user hasn't allowed", said)
        self.assertNotIn("ADMIN", said)

    def test_an_ordinary_error_keeps_the_tab_and_a_dropped_connection_does_not(self):
        tab = self.tab()
        self.use(operation="open", url=self.ALLOWED)
        tab.click = lambda ref: (_ for _ in ()).throw(browser.BrowserError(f"element {ref} is not on the page"))
        self.assertEqual(self.use(operation="click", ref="e99"), "error: element e99 is not on the page")
        self.assertIn(self.ctx.tool_owner + tools.SIGNED_IN, tools._BROWSERS, "still connected: Chrome isn't asked again")
        self.assertEqual(tab.closed, 0)

    def test_a_deny_rule_holds_where_the_tab_is(self):
        tab = self.tab()
        self.ctx.config = {"permissions": {"allow": [], "ask": [], "deny": ["Browser(https://mail.example/inbox*)"]}}
        tab.allowed_hosts.add("https://mail.example")
        tab.href = self.ALLOWED
        with tools._BROWSERS_LOCK:
            tools._BROWSERS[self.ctx.tool_owner + tools.SIGNED_IN] = tab
        said = self.use(operation="snapshot")
        self.assertIn("which their rules deny", said)
        self.assertNotIn("3 unread", said)
        self.assertTrue(self.use(operation="open", url=self.ALLOWED).startswith("PERMISSION DENIED"))

    def test_addresses_two_parsers_read_differently_are_refused(self):
        self.tab()
        for url in ("https://evil.example\\@mail.example/", "https://user@mail.example/", "https://mail.example /x", "javascript:alert(1)"):
            with self.subTest(url=url):
                self.assertTrue(self.use(operation="open", url=url).startswith("error:"), url)

    def test_nothing_reaches_the_users_chrome_for_a_call_that_cannot_run(self):
        with patch.object(tools, "_browser_session") as session:
            self.assertEqual(self.use(operation="click"), "error: click needs a ref from a snapshot, such as e12")
            self.assertIn("open a site in the user's Chrome first", self.use(operation="snapshot"))
            self.assertIn("unknown operation", self.use(operation="evaluate"))
        session.assert_not_called()

    def test_a_dropped_connection_is_forgotten_so_the_next_call_reconnects(self):
        tab = self.tab()
        self.use(operation="open", url=self.ALLOWED)
        tab.snapshot = lambda: (_ for _ in ()).throw(browser.BrowserError("devtools connection closed"))
        said = self.use(operation="snapshot")
        self.assertEqual(said, "error: devtools connection closed")
        self.assertNotIn(self.ctx.tool_owner + tools.SIGNED_IN, tools._BROWSERS)
        self.assertEqual(tab.closed, 1)

    def test_close_closes_dgcs_tab_and_not_the_throwaway_browser(self):
        tab = self.tab()
        self.use(operation="open", url=self.ALLOWED)
        throwaway = SimpleNamespace(close=lambda: None)
        with tools._BROWSERS_LOCK:
            tools._BROWSERS[self.ctx.tool_owner] = throwaway
        self.assertIn("the rest of their browser is as it was", tools.browser_tool({"operation": "close", "signed_in": True}, self.ctx))
        self.assertEqual(tab.closed, 1)
        self.assertIs(tools._BROWSERS.get(self.ctx.tool_owner), throwaway)


def _chromium():
    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    builds = sorted(Path(root).glob("chromium-*/chrome-*/chrome"), reverse=True) if root else []
    return builds[0] if builds else None


class LiveUserChromeTests(unittest.TestCase):
    """A real Chrome standing in for the user's: started with its own test profile and a debugging port, so it writes
    DevToolsActivePort as the user's Chrome does once they allow remote debugging (upstream DevTools MCP's own test)."""

    def test_dgc_opens_its_own_tab_reads_a_page_and_leaves_the_users_alone(self):
        binary = _chromium()
        if binary is None:
            self.skipTest("no Chromium here (set PLAYWRIGHT_BROWSERS_PATH)")
        profile = Path(tempfile.mkdtemp(prefix="dgc-users-chrome-"))
        site = Path(tempfile.mkdtemp(prefix="dgc-site-"))
        (site / "index.html").write_text("<title>Inbox</title><h1>3 unread</h1><button>Compose</button>"
                                         "<input type=password value=hunter2-saved><a href='/popup.html' target='_blank'>Open</a>"
                                         "<input autocomplete='billing cc-number' value=4111-CARD>"
                                         "<input type=text name=password value=SHOWN-PASSWORD>")
        (site / "popup.html").write_text("<title>Popup</title><p>a tab the page opened</p>")
        quiet = type("Quiet", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None})
        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), lambda *a, **k: quiet(*a, directory=str(site), **k))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        users_page = f"http://127.0.0.1:{server.server_address[1]}/?the-users-own-tab"
        chrome = subprocess.Popen([str(binary), "--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu",
                                   "--disable-background-networking", "--no-proxy-server",   # a fresh profile's first load
                                   "--remote-debugging-port=0", f"--user-data-dir={profile}", users_page],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (chrome.kill(), chrome.wait(), shutil.rmtree(profile, True), shutil.rmtree(site, True),
                                 server.shutdown(), server.server_close()))
        deadline = time.monotonic() + 30
        while browser_user.active_port(profile) is None and time.monotonic() < deadline:
            time.sleep(0.2)
        port, _ = browser_user.active_port(profile)

        def pages():
            with __import__("urllib.request").request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=10) as r:
                return [t for t in json.load(r) if t.get("type") == "page"]
        time.sleep(1.0)
        before = pages()
        session = browser_user.UserChromeSession(folders=[("Test Chrome", profile)])
        session.navigate(f"http://127.0.0.1:{server.server_address[1]}/")
        lines = session.snapshot()["lines"]
        self.assertIn('- heading level=1 "3 unread" [e1]', lines)
        for secret in ("hunter2-saved", "4111-CARD", "SHOWN-PASSWORD"):
            self.assertNotIn(secret, "\n".join(lines), "a saved password or card is never read out")
        self.assertTrue(any("value=(hidden)" in line for line in lines), lines)
        during = pages()
        self.assertEqual(len(during), len(before) + 1, "one tab of DGC's")
        self.assertTrue(any(p["url"] == users_page for p in during), "the user's tab is as it was")
        link = next(line.split("[")[-1].split("]")[0] for line in lines if "link" in line and "Open" in line)
        session.click(link)                                   # the page opens a tab of its own
        deadline = time.monotonic() + 10
        while not any(p["url"].endswith("/popup.html") for p in pages()) and time.monotonic() < deadline:
            time.sleep(0.2)
        self.assertTrue(any(p["url"].endswith("/popup.html") for p in pages()))
        session.close()
        time.sleep(0.5)
        after = pages()
        self.assertEqual([p["url"] for p in after], [p["url"] for p in before], "DGC's tab and the one it opened are gone, the user's stays")
        self.assertIsNone(chrome.poll(), "the user's Chrome keeps running")

        # Someone closes DGC's window: the next call fails at once (not after 30 s), and a new session works.
        again = browser_user.UserChromeSession(folders=[("Test Chrome", profile)])
        again.navigate(f"http://127.0.0.1:{server.server_address[1]}/")
        closer = browser._WebSocket(f"ws://127.0.0.1:{port}{browser_user.active_port(profile)[1]}")
        closer.send({"id": 1, "method": "Target.closeTarget", "params": {"targetId": again._target_id}})
        time.sleep(1.0)
        started = time.monotonic()
        with self.assertRaises((browser.BrowserError, OSError)):
            again.snapshot()
        self.assertLess(time.monotonic() - started, 10, "said at once")
        closer.close()
        again.close()


if __name__ == "__main__":
    unittest.main()
