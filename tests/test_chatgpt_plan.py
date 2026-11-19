"""ChatGPT · your plan (dgc.chatgpt_plan, 17 Nov): Sign in with ChatGPT's plan usage for DGC's own agent.

The sign-in (discovery, registration with a stable host id, PKCE, a one-time 127.0.0.1 address, the code exchange and
the identity it returns), the plan permission that can be declined, refresh with rotating tokens (one at a time, the
same account), sign-out that keeps the registration, the model list, and the words for each trouble. A stand-in issuer
and API run on this computer: nothing here reaches the network. Each test has a DGC home of its own and keeps sign-ins
in files there (plugin_credentials "file").
"""
from __future__ import annotations

import base64
import http.client
import http.server
import json
import os
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlencode, urlsplit

from dgc import chatgpt_plan as plan
from dgc import plugin_credentials


def jwt(claims: dict) -> str:
    part = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()  # noqa: E731
    return f"{part({'alg': 'RS256', 'kid': 'k1'})}.{part(claims)}.c2lnbmF0dXJl"


class StandIn:
    """auth.openai.com and api.openai.com, as far as DGC uses them."""

    def __init__(self):
        self.seen = []
        self.issued_client = "app_dgc_issued_1"
        self.grant_scope = plan.SCOPES
        self.refresh_answer = None          # (status, body) to force a refresh outcome
        self.subject = "user-1"
        self.counter = 0
        self.nonce = ""
        stand = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _json(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                stand.seen.append(("GET", self.path, self.headers.get("Authorization")))
                if self.path == "/.well-known/openid-configuration":
                    return self._json(200, {"issuer": stand.base, "authorization_endpoint": stand.base + "/oauth/authorize",
                                            "token_endpoint": stand.base + "/oauth/token", "revocation_endpoint": stand.base + "/oauth/revoke",
                                            "jwks_uri": stand.base + "/.well-known/jwks.json"})
                if self.path == "/v1/models":
                    if self.headers.get("Authorization") != f"Bearer access-{stand.counter}":
                        return self._json(401, {"error": {"code": "invalid_token"}})
                    return self._json(200, {"models": [{"slug": "gpt-6.1-sol", "display_name": "GPT-6.1 Sol", "visibility": "list"},
                                                       {"slug": "hidden", "display_name": "Hidden", "visibility": "hide"},
                                                       {"slug": "gpt-6-astra", "display_name": "GPT-6 Astra", "visibility": "list"}]})
                return self._json(404, {})

            def do_POST(self):
                body = parse_qs(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode())
                form = {key: values[0] for key, values in body.items()}
                stand.seen.append(("POST", self.path, form))
                if self.path == "/oauth/revoke":
                    return self._json(200, {})
                if self.path != "/oauth/token":
                    return self._json(404, {})
                if form.get("grant_type") == "refresh_token" and stand.refresh_answer:
                    return self._json(*stand.refresh_answer)
                stand.counter += 1
                return self._json(200, {
                    "access_token": f"access-{stand.counter}", "refresh_token": f"refresh-{stand.counter}", "expires_in": 3600,
                    "scope": stand.grant_scope, "token_type": "Bearer",
                    "id_token": jwt({"iss": stand.base, "aud": form.get("client_id"), "sub": stand.subject, "email": "person@example.com",
                                     "name": "Tile Maker", "nonce": stand.nonce, "exp": time.time() + 3600, "iat": time.time()})})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def browser(self, decline=False):
        """The person's browser: reads the sign-in page's address, 'signs in', and comes back to DGC's address."""
        def open_browser(url):
            query = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
            self.authorized = query
            self.nonce = query.get("nonce", "")
            back = urlsplit(query["redirect_uri"])
            fields = {"code": "the-code", "state": query["state"], "client_id": self.issued_client}
            if decline:
                fields = {"error": "access_denied", "state": query["state"]}

            def come_back():
                conn = http.client.HTTPConnection("127.0.0.1", back.port, timeout=5)
                conn.request("GET", f"{back.path}?{urlencode(fields)}", headers={"Host": back.netloc})
                conn.getresponse().read()
                conn.close()
            threading.Thread(target=come_back, daemon=True).start()
            return True
        return open_browser

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class _Base(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="dgc-plan-")
        patcher = mock.patch("dgc.config.dgc_home", return_value=__import__("pathlib").Path(self.home))
        patcher.start()
        self.addCleanup(patcher.stop)
        plugin_credentials.configure("file")
        self.addCleanup(plugin_credentials.configure, "auto")
        self.stand = StandIn()
        self.addCleanup(self.stand.close)
        self.kw = {"issuer": self.stand.base, "api": self.stand.base + "/v1"}

    def sign_in(self, **extra):
        return plan.sign_in(open_browser=self.stand.browser(**extra), say=lambda _: None, timeout=10, **self.kw)


class PlanTest(_Base):
    def test_sign_in_registers_once_keeps_the_host_and_connects(self):
        account = self.sign_in()
        self.assertEqual((account["name"], account["email"]), ("Tile Maker", "person@example.com"))
        asked = self.stand.authorized
        self.assertEqual(asked["client_id"], "dynamic_agent_client")
        self.assertEqual(asked["agent_name_hint"], "DGC")
        self.assertTrue(asked["ext_agent_host_id"].startswith("urn:uuid:"))
        self.assertEqual(asked["scope"], plan.SCOPES)
        self.assertEqual(asked["resource"], "https://api.openai.com/v1")
        self.assertEqual(asked["code_challenge_method"], "S256")
        self.assertRegex(asked["redirect_uri"], r"^http://127\.0\.0\.1:\d+/auth/callback$")
        exchange = [form for method, path, form in self.stand.seen if method == "POST" and path == "/oauth/token"][-1]
        self.assertEqual(exchange["grant_type"], "authorization_code")
        self.assertEqual(exchange["client_id"], "app_dgc_issued_1", "the issued client id, not the placeholder")
        self.assertEqual(exchange["redirect_uri"], asked["redirect_uri"])
        self.assertEqual(exchange["resource"], "https://api.openai.com/v1")
        self.assertEqual(plan.status(**self.kw)["state"], "connected")
        host = asked["ext_agent_host_id"]
        plan.sign_out(**self.kw)
        self.sign_in()
        self.assertEqual(self.stand.authorized["client_id"], "app_dgc_issued_1", "a second sign-in reuses the registration")
        self.assertNotIn("agent_name_hint", self.stand.authorized)
        self.assertEqual(self.stand.authorized["ext_agent_host_id"], host, "the host id is stable")

    def test_nothing_secret_is_in_the_config_or_the_answer(self):
        account = self.sign_in()
        self.assertNotIn("refresh", json.dumps(account))
        self.assertNotIn("access-", json.dumps(account))
        for root, _dirs, files in os.walk(self.home):
            for name in files:
                path = os.path.join(root, name)
                if "plugin-auth" in path:
                    self.assertEqual(os.stat(path).st_mode & 0o077, 0, f"{path} is readable only by its owner")

    def test_declining_plan_use_signs_in_but_does_not_connect(self):
        self.stand.grant_scope = "openid profile email offline_access"
        with self.assertRaises(plan.PlanError) as caught:
            self.sign_in()
        self.assertEqual(caught.exception.code, "plan_use_declined")
        self.assertIn("plan", str(caught.exception))
        self.assertEqual(plan.status(**self.kw)["state"], "none")

    def test_a_refusal_in_the_browser_says_so(self):
        with self.assertRaises(plan.PlanError) as caught:
            self.sign_in(decline=True)
        self.assertIn("didn't", str(caught.exception))

    def test_a_fresh_token_is_used_and_an_old_one_refreshed_with_rotation(self):
        self.sign_in()
        self.assertEqual(plan.access_token(**self.kw), "access-1")
        with mock.patch("time.time", return_value=time.time() + 3700):
            self.assertEqual(plan.access_token(**self.kw), "access-2")
        refresh = [form for method, path, form in self.stand.seen if method == "POST" and form.get("grant_type") == "refresh_token"]
        self.assertEqual([r["refresh_token"] for r in refresh], ["refresh-1"])
        self.assertEqual(refresh[0]["client_id"], "app_dgc_issued_1")
        self.assertEqual(plan.access_token(**self.kw), "access-2", "the rotated token was kept")

    def test_a_refused_refresh_is_signed_out_with_connect_again(self):
        self.sign_in()
        self.stand.refresh_answer = (400, {"error": "invalid_grant"})
        with mock.patch("time.time", return_value=time.time() + 3700):
            with self.assertRaises(plan.PlanError) as caught:
                plan.access_token(**self.kw)
        self.assertEqual(caught.exception.code, "signed_out")
        self.assertIn("Connect again", str(caught.exception))
        self.assertEqual(plan.status(**self.kw)["state"], "signed_out")

    def test_another_account_on_refresh_is_refused(self):
        self.sign_in()
        self.stand.subject = "someone-else"
        with mock.patch("time.time", return_value=time.time() + 3700):
            with self.assertRaises(plan.PlanError) as caught:
                plan.access_token(**self.kw)
        self.assertEqual(caught.exception.code, "account_mismatch")

    def test_the_model_list_is_the_plans_listed_models_in_order(self):
        self.sign_in()
        self.assertEqual(plan.models(**self.kw), [{"slug": "gpt-6.1-sol", "name": "GPT-6.1 Sol"}, {"slug": "gpt-6-astra", "name": "GPT-6 Astra"}])

    def test_sign_out_revokes_and_forgets_the_tokens(self):
        self.sign_in()
        plan.sign_out(**self.kw)
        revoked = [form for method, path, form in self.stand.seen if path == "/oauth/revoke"]
        self.assertEqual(revoked[-1]["token"], "refresh-1")
        self.assertEqual(revoked[-1]["token_type_hint"], "refresh_token")
        self.assertEqual(plan.status(**self.kw)["state"], "none")
        with self.assertRaises(plan.PlanError):
            plan.access_token(**self.kw)

    def test_discovery_must_stay_on_the_issuer(self):
        with mock.patch.object(plan, "_get_json", return_value={"issuer": self.stand.base, "authorization_endpoint": "https://evil.example/a",
                                                                "token_endpoint": self.stand.base + "/t", "jwks_uri": self.stand.base + "/j"}):
            with self.assertRaises(plan.PlanError):
                plan.discover(self.stand.base)

    def test_an_identity_for_another_app_or_a_replayed_nonce_is_refused(self):
        claims = {"iss": self.stand.base, "aud": "app_x", "sub": "u", "nonce": "n1", "exp": time.time() + 60}
        self.assertEqual(plan.identity(jwt(claims), issuer=self.stand.base, client_id="app_x", nonce="n1")["sub"], "u")
        for bad in ({"aud": "app_other"}, {"nonce": "n2"}, {"iss": "https://evil.example"}, {"exp": time.time() - 300}):
            with self.assertRaises(plan.PlanError):
                plan.identity(jwt({**claims, **bad}), issuer=self.stand.base, client_id="app_x", nonce="n1")

    def test_the_words_for_the_plans_errors(self):
        self.assertIn("chatgpt.com/settings/usage", plan.error_words("subscription_sharing_usage_limit_exceeded"))
        self.assertIn("Plus or Pro", plan.error_words("subscription_sharing_user_not_eligible"))
        self.assertIn("Plus or Pro", plan.error_words("subscription_sharing_v2_user_not_eligible"))


class MarkerTest(unittest.TestCase):
    def test_the_editor_and_the_cli_use_one_marker(self):
        source = (__import__("pathlib").Path(__file__).resolve().parents[1] / "editors/vscode/src/panel.ts").read_text()
        self.assertIn(f'const PLAN_KEY = "{plan.PLAN_KEY}";', source)


if __name__ == "__main__":
    unittest.main()


class CommandTest(_Base):
    """dgc chatgpt-plan connect|status|sign-out, and the editor's --json conversation with connect."""

    def run_cli(self, argv, stdin_lines=(), browser=None):
        import io
        out = io.StringIO()
        lines = iter(stdin_lines)
        code = plan.cli(argv, out=out, read_line=lambda: next(lines, ""), open_browser=browser or self.stand.browser(),
                        timeout=10, **self.kw)
        return code, out.getvalue()

    def test_the_editor_connects_through_json_lines(self):
        code, out = self.run_cli(["connect", "--json"], stdin_lines=["{}"])
        events = [json.loads(line) for line in out.splitlines() if line.strip()]
        self.assertEqual(code, 0)
        self.assertEqual([e["event"] for e in events], ["listening", "open", "connected"])
        self.assertIsInstance(events[0]["port"], int)
        self.assertTrue(events[1]["url"].startswith(self.stand.base + "/oauth/authorize?"))
        self.assertEqual(events[2]["name"], "Tile Maker")
        self.assertNotIn("access-", out)
        self.assertNotIn("refresh-", out)

    def test_the_editor_can_say_the_forwarded_port(self):
        # Only the address matters here: the browser doesn't open, so nothing waits on port 41234.
        code, out = self.run_cli(["connect", "--json"], stdin_lines=['{"redirect_port": 41234}'], browser=lambda url: False)
        events = [json.loads(line) for line in out.splitlines() if line.strip()]
        self.assertEqual(events[-1]["code"], "no_browser")
        opened = parse_qs(urlsplit(events[1]["url"]).query)
        self.assertEqual(opened["redirect_uri"], ["http://127.0.0.1:41234/auth/callback"])

    def test_status_and_sign_out(self):
        self.run_cli(["connect", "--json"], stdin_lines=["{}"])
        code, out = self.run_cli(["status", "--json"])
        self.assertEqual(json.loads(out)["state"], "connected")
        code, out = self.run_cli(["sign-out", "--json"])
        self.assertEqual(json.loads(out)["state"], "none")

    def test_a_declined_plan_is_an_error_event(self):
        self.stand.grant_scope = "openid profile email"
        code, out = self.run_cli(["connect", "--json"], stdin_lines=["{}"])
        events = [json.loads(line) for line in out.splitlines() if line.strip()]
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["event"], "error")
        self.assertEqual(events[-1]["code"], "plan_use_declined")


class SetupTest(unittest.TestCase):
    """dgc setup offers ChatGPT · your plan after the subscription apps; choosing it signs in (when not yet) and
    points DGC at the plan: the public API, the marker for a key, the Responses API, a model from the plan's list."""

    def test_choosing_the_plan_in_setup(self):
        import io
        from contextlib import redirect_stdout
        from dgc import cli
        from dgc.config import Config
        import pathlib
        from dgc import config as config_module
        with tempfile.TemporaryDirectory() as home:
            user = pathlib.Path(home) / "user-dgc"
            user.mkdir()
            (pathlib.Path(home) / "project" / ".git").mkdir(parents=True)
            stack = [mock.patch.object(config_module, name, value) for name, value in
                     (("USER_HOME", user), ("USER_CONFIG", user / "config.json"), ("USER_SECRETS", user / "secrets.json"))]
            for patcher in stack:
                patcher.start()
                self.addCleanup(patcher.stop)
            cfg = Config(project_root=pathlib.Path(home) / "project")
            asked = []

            class PlanModels:
                def __init__(self, base_url, api_key, model, **kw):
                    asked.append((base_url, api_key, kw.get("api_mode")))
                    self.api_mode = "responses"

                def list_models(self):
                    return ["gpt-6.1-sol", "gpt-6-astra"]

            def select(title, labels, hints=None):
                if title == "Provider":
                    return next(i for i, label in enumerate(labels) if label.startswith("ChatGPT · your plan"))
                if title == "Model":
                    return 0
                return None

            connect = mock.Mock(return_value=0)
            with mock.patch("dgc.menu.select", side_effect=select), mock.patch("dgc.subscriptions.status", return_value=[]), \
                    mock.patch.object(plan, "status", return_value={"state": "none"}), mock.patch.object(plan, "cli", connect), \
                    mock.patch("dgc.llm.LLMClient", PlanModels), mock.patch("dgc.agent.recommended_window", return_value=0), \
                    mock.patch("builtins.input", return_value=""), \
                    mock.patch.object(cli, "offer_voice", lambda *a, **k: False), \
                    mock.patch.object(cli, "pips_sandbox_note", lambda: ""), redirect_stdout(io.StringIO()):
                cli.run_setup(cfg)
            connect.assert_called_once_with(["connect"])
            self.assertEqual((cfg.base_url, cfg.api_key, cfg.get("api_mode"), cfg.model),
                             (plan.API, plan.PLAN_KEY, "responses", "gpt-6.1-sol"))
            self.assertEqual(asked[0][:2], (plan.API, plan.PLAN_KEY))


class TerminalTest(unittest.TestCase):
    def test_the_full_screen_terminal_signs_in_then_runs_on_the_plan(self):
        import types
        from dgc.tui import TUI
        done = threading.Event()
        set_, flashes = {}, []
        config = types.SimpleNamespace(model="old-model", set=lambda key, value: set_.__setitem__(key, value))
        screen = types.SimpleNamespace(config=config, agent=types.SimpleNamespace(refresh_client=done.set),
                                       _flash=lambda text, *a, **k: flashes.append(text))
        with mock.patch.object(plan, "status", return_value={"state": "none"}), \
                mock.patch.object(plan, "sign_in", return_value={"name": "T"}) as signed, \
                mock.patch.object(plan, "models", return_value=[{"slug": "gpt-6.1-sol", "name": "GPT-6.1 Sol"}]):
            TUI._connect_chatgpt_plan(screen)
            self.assertTrue(done.wait(5))
        signed.assert_called_once()
        self.assertEqual((set_["base_url"], set_["api_key"], set_["api_mode"], set_["model"]),
                         (plan.API, plan.PLAN_KEY, "responses", "gpt-6.1-sol"))
        self.assertTrue(any("ChatGPT plan" in line for line in flashes))
