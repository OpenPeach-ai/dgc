"""Pip computers: the box, its egress proxy and the write gate, against a real Chromium in bwrap."""
import http.server
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_computer_box as box, pip_container

TEST_HOST = "dgc-box-test.example"
FORM = b"""<!doctype html><title>Order desk</title>
<form method="post" action="/submit"><input name="name" value="Ada"><input name="password" value="hunter2">
<button id="go" type="submit">Send</button></form>
<button id="popup" onclick="window.open('/popup')">Open</button>"""
# A page that sends its own telemetry and background data as it loads, as most sites do.
BUSY = b"""<!doctype html><title>Shop</title><script>
navigator.sendBeacon('/beacon', 'seen=1'); fetch('/background', {method: 'POST', body: 'load=1'});
</script><button id="add" onclick="fetch('/cart/add', {method: 'POST', body: 'item=7'})">Add to cart</button>
<a id="next" href="/busy">Next</a>"""
# A shop's ad pixel posting a large event the way Facebook's does: a hidden form into a hidden frame, by itself.
PIXEL = b"""<!doctype html><title>Vinyl shop</title><iframe name="px" style="display:none"></iframe>
<form id="px" method="post" action="/tr/" target="px" style="display:none"><input name="ev" value="PageView"></form>
<script>document.getElementById('px').submit()</script><p>Records</p>
<iframe name="sub" style="display:none"></iframe><form id="join" method="post" action="/subscribe" target="sub">
<input name="email" value="ada@example.com"><button id="signup" type="submit">Join</button></form>"""
POPUP = b"""<!doctype html><form id="f" method="post" action="/from-popup"><input name="x" value="1"></form>
<script>document.getElementById('f').submit()</script>"""


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


def serve():
    received = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path == "/report.txt":          # a download, saved to the computer's Files
                body = b"quarterly numbers\n"
                self.send_response(200); self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Disposition", 'attachment; filename="report.txt"')
                self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
                return
            body = POPUP if self.path == "/popup" else BUSY if self.path == "/busy" else PIXEL if self.path == "/pixel" else FORM
            self.send_response(200); self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        def do_POST(self):
            data = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
            received.append((self.path, data))
            self.send_response(200); self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"ok")
    server = _Server(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, received


class BrowserChoiceTests(unittest.TestCase):
    """Google Chrome by default, as on Grok's bots; Chromium only when Chrome is not installed."""

    def setUp(self):
        import tempfile
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(__import__("shutil").rmtree, self.base, True)
        self.home = self.base / "home"
        build = self.home / ".cache" / "ms-playwright" / "chromium-1234" / "chrome-linux"
        build.mkdir(parents=True)
        self.chromium = build / "chrome"
        self.chromium.write_bytes(b"\x7fELF fake"); self.chromium.chmod(0o755)

    def program(self, name, content):
        path = self.base / name
        path.write_bytes(content); path.chmod(0o755)
        return str(path)

    @unittest.skipUnless(sys.platform.startswith("linux"), "how Linux finds the Chrome its box runs; on a Mac Chrome "
                         "is in the computer's VM (pip_container, test_pip_container)")
    def test_google_chrome_wins_when_it_is_installed(self):
        chrome = self.program("chrome", b"\x7fELF real chrome")
        with patch.object(box, "GOOGLE_CHROME", (chrome,)), patch.dict(os.environ, {"PLAYWRIGHT_BROWSERS_PATH": ""}):
            self.assertEqual(str(box.find_chrome(self.home)), chrome)
            self.assertEqual(box.browser_name(box.find_chrome(self.home)), "Google Chrome")

    @unittest.skipUnless(sys.platform.startswith("linux"), "how Linux finds the Chrome its box runs; on a Mac Chrome "
                         "is in the computer's VM (pip_container, test_pip_container)")
    def test_a_script_standing_in_for_chrome_is_not_chrome(self):
        shim = self.program("chrome", b"#!/usr/bin/env bash\nexec chromium \"$@\"\n")
        with patch.object(box, "GOOGLE_CHROME", (shim,)), patch.object(box, "OTHER_CHROMIUM", ()), \
                patch.dict(os.environ, {"PLAYWRIGHT_BROWSERS_PATH": ""}):
            self.assertEqual(box.find_chrome(self.home), self.chromium)
            self.assertEqual(box.browser_name(box.find_chrome(self.home)), "Chromium")
        with patch.object(box, "GOOGLE_CHROME", (str(self.base / "missing"),)), patch.object(box, "OTHER_CHROMIUM", ()), \
                patch.dict(os.environ, {"PLAYWRIGHT_BROWSERS_PATH": ""}):
            self.chromium.unlink()
            self.assertIsNone(box.find_chrome(self.home))

    def test_a_computer_made_before_chrome_arrived_finds_it_when_it_starts(self):
        # Battle test: the computer was given 15 s before DGC's own Chrome finished downloading. The
        # box kept "no Chrome" from then, so every browser start failed until DGC restarted.
        browser = box.BoxedBrowser(self.base / "pip", self.base / "egress.sock", chrome=None,
                                   log_path=self.base / "browser.log")
        reason = {"available": False, "reason": "Setting up its computer. This happens once."}
        with patch.object(box, "find_chrome", return_value=None), patch.object(box, "capability", return_value=reason):
            with self.assertRaisesRegex(box.BoxError, "Setting up its computer"):
                browser.start()
        built = []

        class Built(Exception):
            pass

        def fake_box(*args, **kwargs):
            built.append(args)
            raise Built()
        chrome = Path(self.program("chrome", b"\x7fELF real chrome"))
        # Both kinds of box: Linux's (bubblewrap) and a Mac's (Chrome in the computer's VM). Patching only Linux's
        # let this test start a real VM on a Mac and leave it running.
        with patch.object(box, "find_chrome", return_value=chrome), patch.object(box, "Box", fake_box), \
                patch.object(pip_container, "ContainerBox", fake_box):
            with self.assertRaises(Built):
                browser.start()
        self.assertEqual(len(built), 1)
        if sys.platform != "darwin":
            self.assertEqual(built[0][2], chrome, "the box runs the Chrome found now")
        self.assertEqual(browser.binary, chrome)


class EgressPolicyTests(unittest.TestCase):
    def resolver(self, *addresses):
        return lambda host, port, type=None: [(None, None, None, "", (a, port)) for a in addresses]

    def test_only_public_web_servers_are_reachable(self):
        self.assertEqual(box.public_addresses("example.com", 443, resolve=self.resolver("93.184.215.14")), ["93.184.215.14"])
        for host, port, addresses in (("router.lan", 80, ["192.168.1.1"]), ("x.example", 443, ["10.0.0.5"]),
                                      ("x.example", 443, ["127.0.0.1"]), ("x.example", 443, ["169.254.169.254"]),
                                      ("x.example", 443, ["93.184.215.14", "10.0.0.5"]),   # one private answer poisons all
                                      ("localhost", 443, ["93.184.215.14"]), ("x.example", 22, ["93.184.215.14"]),
                                      ("x.example", 443, ["::1"]), ("x.example", 443, ["fd00::1"])):
            with self.subTest(host=host, port=port, addresses=addresses):
                self.assertEqual(box.public_addresses(host, port, resolve=self.resolver(*addresses)), [])

    def test_payments_are_recognised_and_secret_fields_masked(self):
        self.assertTrue(box.carries_card_number("number=4242 4242 4242 4242&exp=12%2F30"))
        self.assertFalse(box.carries_card_number("order=1234567890123&qty=2"))      # not a Luhn number
        for encoded in ("number=4242+4242+4242+4242", "number=4242%204242%204242%204242", "number=4242-4242-4242-4242"):
            self.assertTrue(box.carries_card_number(encoded), encoded)            # how a form sends one typed with spaces
        fields = box._fields("user=ada&password=hunter2&otp=123456&note=hi", "application/x-www-form-urlencoded")
        self.assertEqual(fields, [("user", "ada"), ("password", "•••"), ("otp", "•••"), ("note", "hi")])
        self.assertEqual(box._fields('{"email":"a@b.c","card":"4242"}', "application/json"),
                         [("email", "a@b.c"), ("card", "•••")])


@unittest.skipUnless(box.capability().get("available") or os.environ.get("DGC_REQUIRE_CHROMIUM"),
                     "needs Linux, bubblewrap and a Chromium build")
class RealBoxTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="pc-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "home").mkdir()
        self.server, self.received = serve()
        self.addCleanup(self.server.shutdown)
        port = self.server.server_address[1]
        self.base = f"http://{TEST_HOST}:{port}"
        # The real policy refuses every private address; the test reaches its loopback server
        # through one named host and nothing else.
        policy = lambda host, p: ["127.0.0.1"] if host == TEST_HOST and p == port else []
        self.proxy = box.EgressProxy(Path(f"/tmp/pc-{os.getpid()}-{id(self)}.sock"), policy=policy)
        self.proxy.start()
        self.addCleanup(self.proxy.stop)
        self.held = []
        self.browser = box.BoxedBrowser(self.root / "home", self.proxy.path, chrome=box.find_chrome(),
                                        log_path=self.root / "box.log", on_write=self.held.append)
        self.addCleanup(self.browser.close)

    def wait_for(self, condition, seconds=10):
        end = time.monotonic() + seconds
        while time.monotonic() < end and not condition():
            self.browser.pump(0.3)
        return condition()

    def test_reading_is_free_and_a_submit_waits_unsent_until_released(self):
        self.assertEqual(self.browser.navigate(self.base + "/"), "loaded")
        self.assertIn("Order desk", self.browser.snapshot()["title"])
        self.browser.click(self.browser.evaluate_json("(() => { const b=document.getElementById('go'); b.setAttribute('data-dgc-ref','e900'); return 'e900'; })()"))
        self.assertTrue(self.wait_for(lambda: self.held), "the submit was held")
        held = self.held[0]
        self.assertEqual((held.method, held.summary()["path"]), ("POST", "/submit"))
        self.assertEqual(held.fields, [("name", "Ada"), ("password", "•••")])
        time.sleep(1.5)
        self.browser.pump(0.5)
        self.assertEqual(self.received, [], "nothing reached the server while held")
        self.browser.release(held.request_id)
        self.assertTrue(self.wait_for(lambda: self.received), "released")
        self.assertEqual(self.received, [("/submit", "name=Ada&password=hunter2")], "the exact request, once")

    def test_enter_in_a_field_submits_its_form_and_the_submit_waits(self):
        # Enter carried no "\r", so no keypress followed and a field never submitted its form (a Pip's search box stayed
        # where it was, 2026-10-21). Now it submits, and that submit is held like a click's.
        self.assertEqual(self.browser.navigate(self.base + "/"), "loaded")
        field = self.browser.evaluate_json("(() => { document.querySelector('[name=name]').setAttribute('data-dgc-ref','e904'); return 'e904'; })()")
        self.browser.type_text(field, "Ada")
        self.browser.press("Enter")
        self.assertTrue(self.wait_for(lambda: self.held), "Enter submitted the form, and the submit waits")
        self.assertEqual((self.held[0].method, self.held[0].summary()["path"]), ("POST", "/submit"))
        self.assertEqual(self.received, [])

    def test_a_pages_own_traffic_goes_out_and_a_write_the_pip_causes_waits(self):
        # Every held POST became an approval with a screenshot: Google's results page alone made 18
        # ("Send a form to www.google.com"), from telemetry nobody clicked.
        posted = lambda: sorted(path for path, _ in self.received)
        self.assertEqual(self.browser.navigate(self.base + "/busy"), "loaded")
        self.assertTrue(self.wait_for(lambda: posted() == ["/background", "/beacon"]), posted())
        self.assertEqual(self.held, [], "nothing the page sent by itself waits for approval")
        self.browser.click(self.browser.evaluate_json("(() => { document.getElementById('add').setAttribute('data-dgc-ref','e901'); return 'e901'; })()"))
        self.assertTrue(self.wait_for(lambda: self.held), "the Pip's click made a write: it waits")
        self.assertEqual((self.held[0].method, self.held[0].summary()["path"]), ("POST", "/cart/add"))
        self.assertNotIn("/cart/add", posted())
        # A link the Pip clicks opens a new page: that page's own traffic is not the click's write.
        self.received.clear()
        self.browser.click(self.browser.evaluate_json("(() => { document.getElementById('next').setAttribute('data-dgc-ref','e902'); return 'e902'; })()"))
        self.assertTrue(self.wait_for(lambda: posted() == ["/background", "/beacon"]), posted())
        self.assertEqual(len(self.held), 1)

    def test_a_pages_own_hidden_form_post_goes_out_without_asking(self):
        # Battle test (2026-10-09): opening a record shop held Facebook's pixel ("Let Gift Ideas send to
        # facebook.com?") and paused the Pip mid-search. Nothing the Pip did; the page's own traffic.
        self.assertEqual(self.browser.navigate(self.base + "/pixel"), "loaded")
        self.assertTrue(self.wait_for(lambda: any(path == "/tr/" for path, _ in self.received)), self.received)
        self.assertEqual(self.held, [], "the page's own pixel waits for no one")
        # The same kind of request the Pip causes, a form it submits into a frame, still waits.
        self.browser.click(self.browser.evaluate_json("(() => { document.getElementById('signup').setAttribute('data-dgc-ref','e903'); return 'e903'; })()"))
        self.assertTrue(self.wait_for(lambda: self.held), "the Pip's submit waits")
        self.assertEqual((self.held[0].method, self.held[0].summary()["path"]), ("POST", "/subscribe"))
        self.assertNotIn("/subscribe", [path for path, _ in self.received])

    def test_pages_do_not_see_an_automated_browser(self):
        # Like Chrome on Grok's bots (founder, 2026-10-07): with navigator.webdriver true, Google's
        # search answered every Pip with "are you a robot".
        self.assertEqual(self.browser.navigate(self.base + "/"), "loaded")
        self.assertIs(self.browser.evaluate_json("navigator.webdriver"), False)

    def test_a_payment_is_held_like_any_change_and_says_so(self):
        self.assertEqual(self.browser.navigate(self.base + "/"), "loaded")
        self.browser.evaluate_json("(() => { document.querySelector('[name=name]').value = '4242 4242 4242 4242'; return true; })()")
        self.browser.click(self.browser.evaluate_json("(() => { const b=document.getElementById('go'); b.setAttribute('data-dgc-ref','e901'); return 'e901'; })()"))
        self.assertTrue(self.wait_for(lambda: self.held), "held for the user, never dropped")
        self.assertIs(self.held[0].summary().get("payment"), True, "its review says it carries card details")
        self.assertEqual(self.received, [])
        self.browser.release(self.held[0].request_id)
        self.assertTrue(self.wait_for(lambda: self.received), "sent once released")

    def test_a_popup_is_gated_too_and_the_profile_persists(self):
        self.browser.navigate(self.base + "/")
        # A real click (a user gesture), so Chrome's popup blocker lets the window open.
        self.browser.click(self.browser.evaluate_json("(() => { const b=document.getElementById('popup'); b.setAttribute('data-dgc-ref','e901'); return 'e901'; })()"))
        self.assertTrue(self.wait_for(lambda: any(h.summary()["path"] == "/from-popup" for h in self.held) or self.received),
                        "the popup opened and tried to submit")
        self.assertEqual(self.received, [], "a popup's auto-submit is held, never sent")
        self.assertTrue(any(h.summary()["path"] == "/from-popup" for h in self.held))
        self.browser.close()
        self.assertTrue((self.root / "home" / ".browser" / "Default").is_dir(), "the profile stays in the Pip's home")

    def test_the_box_has_no_network_but_the_proxy(self):
        self.browser.navigate(self.base + "/")
        # A host the proxy refuses: the page fails, and the refusal is logged.
        self.browser.navigate("http://192.168.1.1/")
        self.assertIn(("refused", "192.168.1.1"), self.proxy.log)
        self.assertEqual(self.browser.evaluate_json("location.href"), "chrome-error://chromewebdata/")


class QuietProfileTests(unittest.TestCase):
    """Chrome's "Save card?" covered a Pip's screen after a checkout: card and address saving are off in its profile."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.profile = Path(self.tmp.name) / ".browser"
        self.prefs = self.profile / "Default" / "Preferences"

    def tearDown(self):
        self.tmp.cleanup()

    def read(self):
        import json
        return json.loads(self.prefs.read_text(encoding="utf-8"))

    def test_a_new_profile_starts_with_card_and_address_saving_off(self):
        box.quiet_profile(self.profile)
        self.assertEqual(self.read()["autofill"], {"credit_card_enabled": False, "profile_enabled": False})

    def test_a_kept_profile_keeps_everything_else(self):
        import json
        self.prefs.parent.mkdir(parents=True)
        self.prefs.write_text(json.dumps({"autofill": {"credit_card_enabled": True, "last_version_deduped": 9},
                                          "browser": {"window_placement": {"left": 3}}}), encoding="utf-8")
        box.quiet_profile(self.profile)
        prefs = self.read()
        self.assertEqual(prefs["autofill"], {"credit_card_enabled": False, "profile_enabled": False,
                                             "last_version_deduped": 9})
        self.assertEqual(prefs["browser"], {"window_placement": {"left": 3}})

    def test_a_preferences_file_it_cannot_read_is_left_alone(self):
        self.prefs.parent.mkdir(parents=True)
        self.prefs.write_text("{not json", encoding="utf-8")
        box.quiet_profile(self.profile)
        self.assertEqual(self.prefs.read_text(encoding="utf-8"), "{not json")

    def test_a_link_in_place_of_the_file_is_never_followed(self):
        outside = Path(self.tmp.name) / "outside.json"
        outside.write_text("{}", encoding="utf-8")
        self.prefs.parent.mkdir(parents=True)
        self.prefs.symlink_to(outside)
        box.quiet_profile(self.profile)
        self.assertEqual(outside.read_text(encoding="utf-8"), "{}")

    def test_every_start_quiets_the_profile(self):
        import inspect
        self.assertIn('quiet_profile(self.home / ".browser")', inspect.getsource(box.Box.start))


if __name__ == "__main__":
    unittest.main()
