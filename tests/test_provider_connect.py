"""Connect OpenRouter by signing in (dgc.provider_connect, 17 Nov): the PKCE values, the address the browser opens, the
one-time address the browser comes back to, trading the code for a key, the key's state, and the no-browser path.

A stand-in OpenRouter runs on this computer: nothing here reaches the network.
"""
from __future__ import annotations

import http.client
import http.server
import json
import threading
import unittest
from urllib.parse import parse_qs, urlsplit

from dgc import provider_connect as pc

# RFC 7636, appendix B: the verifier and the S256 challenge it gives. The editor's tests use the same pair.
RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


class StandIn:
    """A stand-in OpenRouter: POST /api/v1/auth/keys and GET /api/v1/key, answering what each test sets."""

    def __init__(self):
        self.exchange = (200, {"key": "sk-or-v1-made-for-dgc"})
        self.key_info = (200, {"data": {"label": "DGC", "usage": 1.5, "limit": 10, "limit_remaining": 8.5}})
        self.seen = []
        stand = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _answer(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                stand.seen.append(("POST", self.path, body, self.headers.get("Authorization")))
                self._answer(*stand.exchange)

            def do_GET(self):
                stand.seen.append(("GET", self.path, None, self.headers.get("Authorization")))
                self._answer(*stand.key_info)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def get(port: int, path: str, host: str | None = None) -> tuple[int, str]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", path, headers={"Host": host or f"localhost:{port}"})
        response = conn.getresponse()
        return response.status, response.read().decode("utf-8", "replace")
    finally:
        conn.close()


class PkceTest(unittest.TestCase):
    def test_the_rfc_pair(self):
        self.assertEqual(pc.challenge_of(RFC_VERIFIER), RFC_CHALLENGE)

    def test_a_fresh_pair_is_unreserved_text_and_matches(self):
        verifier, challenge = pc.pkce_pair()
        self.assertGreaterEqual(len(verifier), 43)
        self.assertLessEqual(len(verifier), 128)
        self.assertRegex(verifier, r"^[A-Za-z0-9._~-]+$")
        self.assertEqual(challenge, pc.challenge_of(verifier))
        self.assertNotEqual(pc.pkce_pair()[0], verifier)


class AuthUrlTest(unittest.TestCase):
    def test_with_a_callback(self):
        url = pc.auth_url(RFC_CHALLENGE, callback_url="http://localhost:51423/callback", state="s1")
        parts = urlsplit(url)
        self.assertEqual(f"{parts.scheme}://{parts.netloc}{parts.path}", "https://openrouter.ai/auth")
        query = parse_qs(parts.query)
        self.assertEqual(query["callback_url"], ["http://localhost:51423/callback"])
        self.assertEqual(query["code_challenge"], [RFC_CHALLENGE])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(query["key_label"], ["DGC"])
        self.assertEqual(query["state"], ["s1"])

    def test_without_a_callback_openrouter_shows_the_code(self):
        query = parse_qs(urlsplit(pc.auth_url(RFC_CHALLENGE)).query)
        self.assertNotIn("callback_url", query)
        self.assertNotIn("state", query)
        self.assertEqual(query["code_challenge_method"], ["S256"])


class OneTimeCallbackTest(unittest.TestCase):
    def setUp(self):
        self.callback = pc.OneTimeCallback(state="right-state")
        self.port = self.callback.start()
        self.addCleanup(self.callback.close)

    def test_its_address_is_localhost_on_its_port(self):
        self.assertEqual(self.callback.url, f"http://localhost:{self.port}/callback")

    def test_the_right_state_hands_over_the_code_and_says_so(self):
        status, page = get(self.port, "/callback?code=abc123&state=right-state")
        self.assertEqual(status, 200)
        self.assertIn("connected", page.lower())
        self.assertEqual(self.callback.wait(5), "abc123")

    def test_a_wrong_state_is_refused_and_keeps_waiting(self):
        status, _ = get(self.port, "/callback?code=evil&state=other")
        self.assertEqual(status, 400)
        status, _ = get(self.port, "/callback?code=good&state=right-state")
        self.assertEqual(status, 200)
        self.assertEqual(self.callback.wait(5), "good")

    def test_another_host_name_is_refused(self):
        status, _ = get(self.port, "/callback?code=abc&state=right-state", host="evil.example")
        self.assertEqual(status, 421)
        with self.assertRaises(pc.ConnectError):
            self.callback.wait(0.3)

    def test_another_path_is_not_found(self):
        status, _ = get(self.port, "/other?code=abc&state=right-state")
        self.assertEqual(status, 404)

    def test_a_refusal_on_openrouter_ends_the_wait_with_a_reason(self):
        status, page = get(self.port, "/callback?error=access_denied&state=right-state")
        self.assertEqual(status, 200)
        with self.assertRaises(pc.ConnectError) as caught:
            self.callback.wait(5)
        self.assertIn("didn't", str(caught.exception))

    def test_no_answer_in_time_says_so(self):
        with self.assertRaises(pc.ConnectError) as caught:
            self.callback.wait(0.2)
        self.assertIn("in time", str(caught.exception))

    def test_it_takes_one_code_then_closes(self):
        get(self.port, "/callback?code=one&state=right-state")
        self.assertEqual(self.callback.wait(5), "one")
        self.callback.close()
        with self.assertRaises(OSError):
            get(self.port, "/callback?code=two&state=right-state")


class ExchangeAndStateTest(unittest.TestCase):
    def setUp(self):
        self.stand = StandIn()
        self.addCleanup(self.stand.close)

    def test_a_code_and_its_verifier_become_the_key(self):
        key = pc.exchange("abc123", RFC_VERIFIER, url=self.stand.base + "/api/v1/auth/keys")
        self.assertEqual(key, "sk-or-v1-made-for-dgc")
        method, path, body, _ = self.stand.seen[-1]
        self.assertEqual((method, path), ("POST", "/api/v1/auth/keys"))
        self.assertEqual(body, {"code": "abc123", "code_verifier": RFC_VERIFIER, "code_challenge_method": "S256"})

    def test_a_refused_code_says_why_in_words(self):
        self.stand.exchange = (403, {"error": {"message": "Invalid code or code_verifier"}})
        with self.assertRaises(pc.ConnectError) as caught:
            pc.exchange("bad", RFC_VERIFIER, url=self.stand.base + "/api/v1/auth/keys")
        self.assertIn("Connect again", str(caught.exception))
        self.assertNotIn(RFC_VERIFIER, str(caught.exception))

    def test_an_answer_with_no_key_is_an_error(self):
        self.stand.exchange = (200, {"nothing": True})
        with self.assertRaises(pc.ConnectError):
            pc.exchange("abc", RFC_VERIFIER, url=self.stand.base + "/api/v1/auth/keys")

    def test_a_working_key_and_its_credit(self):
        state = pc.key_state("sk-or-v1-x", url=self.stand.base + "/api/v1/key")
        self.assertEqual(state["state"], "ok")
        self.assertEqual(state["limit_remaining"], 8.5)
        self.assertEqual(self.stand.seen[-1][3], "Bearer sk-or-v1-x")

    def test_a_deleted_key_is_signed_out(self):
        self.stand.key_info = (401, {"error": {"message": "No auth credentials found"}})
        self.assertEqual(pc.key_state("sk-or-v1-x", url=self.stand.base + "/api/v1/key")["state"], "signed_out")

    def test_no_credit_left(self):
        self.stand.key_info = (402, {"error": {"message": "Insufficient credits"}})
        self.assertEqual(pc.key_state("sk-or-v1-x", url=self.stand.base + "/api/v1/key")["state"], "no_credit")
        self.stand.key_info = (200, {"data": {"usage": 10, "limit": 10, "limit_remaining": 0}})
        self.assertEqual(pc.key_state("sk-or-v1-x", url=self.stand.base + "/api/v1/key")["state"], "no_credit")

    def test_no_limit_is_ok(self):
        self.stand.key_info = (200, {"data": {"usage": 12.4, "limit": None, "limit_remaining": None}})
        self.assertEqual(pc.key_state("sk-or-v1-x", url=self.stand.base + "/api/v1/key")["state"], "ok")

    def test_unreachable(self):
        self.assertEqual(pc.key_state("sk-or-v1-x", url="http://127.0.0.1:9/api/v1/key")["state"], "unreachable")


class ConnectTest(unittest.TestCase):
    def setUp(self):
        self.stand = StandIn()
        self.addCleanup(self.stand.close)
        self.sites = {"exchange_url": self.stand.base + "/api/v1/auth/keys"}

    def test_through_the_browser(self):
        opened = []

        def browser(url):
            opened.append(url)
            query = parse_qs(urlsplit(url).query)
            back = urlsplit(query["callback_url"][0])
            threading.Thread(target=get, args=(back.port, f"{back.path}?code=c1&state={query['state'][0]}"), daemon=True).start()
            return True

        key = pc.connect(open_browser=browser, ask_code=None, say=lambda _: None, timeout=10, **self.sites)
        self.assertEqual(key, "sk-or-v1-made-for-dgc")
        self.assertEqual(len(opened), 1)
        self.assertEqual(self.stand.seen[-1][2]["code"], "c1")

    def test_no_browser_asks_for_the_code_openrouter_shows(self):
        said, asked = [], []

        def ask(url):
            asked.append(url)
            return "  pasted-code \n"

        key = pc.connect(open_browser=lambda url: False, ask_code=ask, say=said.append, timeout=10, **self.sites)
        self.assertEqual(key, "sk-or-v1-made-for-dgc")
        self.assertNotIn("callback_url", parse_qs(urlsplit(asked[0]).query))
        self.assertEqual(self.stand.seen[-1][2]["code"], "pasted-code")

    def test_no_browser_and_no_way_to_ask_is_an_error(self):
        with self.assertRaises(pc.ConnectError):
            pc.connect(open_browser=lambda url: False, ask_code=None, say=lambda _: None, timeout=1, **self.sites)

    def test_a_blank_code_cancels(self):
        with self.assertRaises(pc.ConnectError) as caught:
            pc.connect(open_browser=lambda url: False, ask_code=lambda url: "", say=lambda _: None, timeout=1, **self.sites)
        self.assertIn("cancel", str(caught.exception).lower())


class TerminalEntriesTest(unittest.TestCase):
    """dgc setup and /connect (cli._provider_key) and the full-screen terminal's picker (TUI._connect_openrouter)."""

    def test_setup_offers_the_sign_in_for_openrouter_first(self):
        from unittest import mock
        from dgc import cli
        prov = {"label": "OpenRouter"}
        with mock.patch("builtins.input", return_value=""), \
             mock.patch.object(pc, "connect", return_value="sk-or-v1-signed-in") as connect, \
             mock.patch("getpass.getpass", side_effect=AssertionError("no paste when signed in")):
            self.assertEqual(cli._provider_key("openrouter", prov), "sk-or-v1-signed-in")
        connect.assert_called_once()

    def test_no_means_paste_a_key(self):
        from unittest import mock
        from dgc import cli
        with mock.patch("builtins.input", return_value="n"), mock.patch("getpass.getpass", return_value=" sk-pasted "), \
             mock.patch.object(pc, "connect", side_effect=AssertionError("not asked")):
            self.assertEqual(cli._provider_key("openrouter", {"label": "OpenRouter"}), "sk-pasted")

    def test_a_failed_sign_in_falls_back_to_pasting(self):
        from unittest import mock
        from dgc import cli
        with mock.patch("builtins.input", return_value="y"), mock.patch("getpass.getpass", return_value="sk-pasted"), \
             mock.patch.object(pc, "connect", side_effect=pc.ConnectError("no")), mock.patch("builtins.print"):
            self.assertEqual(cli._provider_key("openrouter", {"label": "OpenRouter"}), "sk-pasted")

    def test_other_presets_only_paste(self):
        from unittest import mock
        from dgc import cli
        with mock.patch("builtins.input", side_effect=AssertionError("no question")), \
             mock.patch("getpass.getpass", return_value="gsk-1"):
            self.assertEqual(cli._provider_key("groq", {"label": "Groq"}), "gsk-1")

    def test_the_full_screen_terminal_connects_off_its_thread(self):
        from unittest import mock
        from dgc.tui import TUI
        flashes, done = [], threading.Event()
        got = {}

        class Screen:
            def _flash(self, text, *args, **kwargs):
                flashes.append(text)

            def _append_md(self, text):
                flashes.append(text)

            def _ask_input(self, prompt, cb, secret=False):
                cb("typed-code")

        def finish(key):
            got["key"] = key
            done.set()

        with mock.patch.object(pc, "connect", side_effect=lambda say, ask_code: ask_code("u") and "sk-or-v1-tui"):
            TUI._connect_openrouter(Screen(), finish)
            self.assertTrue(done.wait(5))
        self.assertEqual(got["key"], "sk-or-v1-tui")
        self.assertTrue(any("OpenRouter" in line for line in flashes))

    def test_the_full_screen_terminal_says_why_it_did_not_connect(self):
        from unittest import mock
        from dgc.tui import TUI
        flashes = []

        class Screen:
            def _flash(self, text, *args, **kwargs):
                flashes.append(text)

        with mock.patch.object(pc, "connect", side_effect=pc.ConnectError("OpenRouter didn't accept that sign-in.")):
            TUI._connect_openrouter(Screen(), lambda key: self.fail("not connected"))
            for _ in range(50):
                if any("didn't accept" in line for line in flashes):
                    break
                threading.Event().wait(0.05)
        self.assertTrue(any("didn't accept" in line for line in flashes))


if __name__ == "__main__":
    unittest.main()
