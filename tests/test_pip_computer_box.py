"""Pip computers: the box, its egress proxy and the write gate, against a real Chromium in bwrap."""
import http.server
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

from dgc import pip_computer_box as box

TEST_HOST = "dgc-box-test.example"
FORM = b"""<!doctype html><title>Order desk</title>
<form method="post" action="/submit"><input name="name" value="Ada"><input name="password" value="hunter2">
<button id="go" type="submit">Send</button></form>
<button id="popup" onclick="window.open('/popup')">Open</button>"""
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
            body = POPUP if self.path == "/popup" else FORM
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


if __name__ == "__main__":
    unittest.main()
