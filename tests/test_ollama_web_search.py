"""Ollama web search (founder, 2026-10-21: "for Web Search, we could give option to use Ollama cloud web search").

Two ways in, tried in order. A signed-in Ollama on this computer serves POST /api/experimental/web_search (Ollama 0.18
and later) and signs the request to ollama.com with its own sign-in, so no key is needed. Otherwise ollama.com's
POST /api/web_search takes an API key as `Authorization: Bearer <key>`. Both take {query, max_results} (at most 10) and
answer {results: [{title, url, content}]}, `content` being the page's text as markdown, labelled text/html.

Everything here runs against a fake server on 127.0.0.1: never the real network. DuckDuckGo is stubbed to fail loudly,
so a provider that falls through to it (as "ollama" did before it existed) fails here instead of going online.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import search as search_mod  # noqa: E402
from dgc.config import SEARCH_PROVIDERS  # noqa: E402

KEY = "ollama-key-5b1e0c7d9a2f"
PAGE = ("Ollama\n\n## Cloud models\n\n[Cloud models](https://ollama.com/blog/cloud-models) are now available in "
        "Ollama. ![logo](https://ollama.com/logo.png) **Run** `gpt-oss` on datacenter hardware.\n\n- one\n- two\n")
RESULTS = {"results": [
    {"title": "Ollama", "url": "https://ollama.com/", "content": PAGE},
    {"title": "What is Ollama?", "url": "https://www.example.org/ollama", "content": "word " * 400},
    {"title": "no link", "url": "javascript:alert(1)", "content": "dropped"},
    {"title": "", "url": "https://untitled.example/", "content": ""},
]}


class _Fake(BaseHTTPRequestHandler):
    """Answers by path from `routes` ({path: (status, body)}) and records each request it was sent."""

    routes: dict = {}
    seen: list = []

    def do_POST(self):                                      # noqa: N802 -- http.server's name
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        type(self).seen.append({"method": "POST", "path": self.path, "headers": dict(self.headers),
                                "body": json.loads(raw or b"null")})
        status, body = type(self).routes.get(self.path, (404, "404 page not found"))
        data = body if isinstance(body, bytes) else (json.dumps(body) if not isinstance(body, str) else body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")   # ollama.com labels its JSON so
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):                           # quiet
        pass


def _closed_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class OllamaSearchTests(unittest.TestCase):
    def setUp(self):
        _Fake.routes, _Fake.seen = {}, []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Fake)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.dead = f"127.0.0.1:{_closed_port()}"
        for target in (patch.object(search_mod, "OLLAMA_SEARCH_URL", self.base + "/api/web_search", create=True),
                       patch.object(search_mod, "_duckduckgo", side_effect=AssertionError("DuckDuckGo was asked")),
                       patch.object(search_mod, "_ddgs_images", side_effect=AssertionError("DuckDuckGo was asked")),
                       patch.dict(os.environ, {"OLLAMA_HOST": self.dead})):
            target.start()
            self.addCleanup(target.stop)

    def local(self):
        """This computer's Ollama is the fake server."""
        os.environ["OLLAMA_HOST"] = self.base

    def answers(self, path, status, body):
        _Fake.routes[path] = (status, body)

    # -- choosing it

    def test_it_is_a_provider_with_an_optional_key(self):
        self.assertIn("ollama", SEARCH_PROVIDERS)
        meta = SEARCH_PROVIDERS["ollama"]
        self.assertFalse(meta["needs_key"], "a signed-in Ollama needs none")
        self.assertTrue(meta.get("optional_key"))
        self.assertFalse(meta["needs_url"])
        self.assertIn("Ollama", meta["label"])

    def test_choosing_ollama_asks_ollama_not_duckduckgo(self):
        self.local()
        self.answers("/api/experimental/web_search", 200, RESULTS)
        out = search_mod.search("what is ollama", "ollama")
        self.assertEqual([r["path"] for r in _Fake.seen], ["/api/experimental/web_search"])
        self.assertTrue(out.startswith('Web results for "what is ollama"'), out)

    # -- the signed-in Ollama on this computer: no key

    def test_a_signed_in_ollama_here_searches_without_a_key(self):
        self.local()
        self.answers("/api/experimental/web_search", 200, RESULTS)
        found = search_mod.results("what is ollama", "ollama", api_key=KEY, n=3)
        self.assertEqual(len(_Fake.seen), 1, "the local Ollama answered: ollama.com was never asked")
        sent = _Fake.seen[0]
        self.assertEqual((sent["method"], sent["path"]), ("POST", "/api/experimental/web_search"))
        self.assertEqual(sent["body"], {"query": "what is ollama", "max_results": 3})
        self.assertNotIn("Authorization", sent["headers"], "Ollama signs with its own sign-in; the key stays here")
        self.assertNotIn(KEY, json.dumps(sent))
        self.assertEqual([r["url"] for r in found], ["https://ollama.com/", "https://www.example.org/ollama",
                                                     "https://untitled.example/"])

    def test_ollama_host_is_read_the_way_ollama_reads_it(self):
        for value, expected in (("", "http://127.0.0.1:11434"), ("0.0.0.0", "http://127.0.0.1:11434"),
                                ("0.0.0.0:11500", "http://127.0.0.1:11500"), ("localhost", "http://localhost:11434"),
                                ("http://box.lan", "http://box.lan:80"), ("https://box.lan/ollama/", "https://box.lan:443/ollama"),
                                ("[::1]:7000", "http://[::1]:7000"), ("::1", "http://[::1]:11434"),
                                (":11434", "http://127.0.0.1:11434"), ("ollama.com", "")):
            with self.subTest(OLLAMA_HOST=value):
                os.environ["OLLAMA_HOST"] = value
                self.assertEqual(search_mod._ollama_daemon(), expected)

    # -- ollama.com with the saved key

    def test_without_a_local_ollama_the_key_goes_to_ollama_com_as_a_bearer_token(self):
        self.answers("/api/web_search", 200, RESULTS)
        search_mod.results("what is ollama", "ollama", api_key=KEY)
        self.assertEqual(len(_Fake.seen), 1)
        sent = _Fake.seen[0]
        self.assertEqual((sent["method"], sent["path"]), ("POST", "/api/web_search"))
        self.assertEqual(sent["headers"].get("Authorization"), f"Bearer {KEY}")
        self.assertEqual(sent["headers"].get("Content-Type"), "application/json")
        self.assertEqual(sent["body"], {"query": "what is ollama", "max_results": 6}, "the same six the others ask for")

    def test_at_most_ten_results_are_asked_for(self):
        self.answers("/api/web_search", 200, RESULTS)
        search_mod.results("x", "ollama", api_key=KEY, n=25)
        self.assertEqual(_Fake.seen[-1]["body"]["max_results"], 10, "Ollama's own limit")

    def test_a_local_ollama_that_isnt_signed_in_hands_over_to_the_key(self):
        self.local()
        _Fake.routes["/api/experimental/web_search"] = (401, {"error": "unauthorized", "signin_url": "https://ollama.com/connect?x"})
        self.answers("/api/web_search", 200, RESULTS)
        found = search_mod.results("x", "ollama", api_key=KEY)
        self.assertEqual([r["path"] for r in _Fake.seen], ["/api/experimental/web_search", "/api/web_search"])
        self.assertEqual(found[0]["url"], "https://ollama.com/")

    # -- what comes back

    def test_results_map_to_title_url_snippet_like_the_other_providers(self):
        self.answers("/api/web_search", 200, RESULTS)
        found = search_mod.results("what is ollama", "ollama", api_key=KEY)
        self.assertEqual(set(found[0]), {"title", "url", "snippet"}, "the same shape as Brave, Tavily and SearXNG")
        first = found[0]
        self.assertEqual((first["title"], first["url"]), ("Ollama", "https://ollama.com/"))
        # The page's start, in plain words: its own title, markdown links, pictures and marks taken out.
        self.assertEqual(first["snippet"], "Cloud models Cloud models are now available in Ollama. Run gpt-oss on "
                                           "datacenter hardware. one two")
        self.assertLessEqual(len(found[1]["snippet"]), search_mod.OLLAMA_SNIPPET_CHARS + 1, "a whole page is cut short")
        self.assertTrue(found[1]["snippet"].endswith("…"))
        self.assertNotIn("javascript:alert(1)", [r["url"] for r in found], "only web links")
        self.assertEqual(found[2]["title"], "https://untitled.example/", "an untitled page is named by its address")

    def test_the_agents_web_search_tool_reads_them_as_it_reads_any_provider(self):
        self.answers("/api/web_search", 200, RESULTS)
        out = search_mod.search("what is ollama", "ollama", api_key=KEY)
        self.assertIn("1. Ollama\n   https://ollama.com/\n   Cloud models Cloud models are now available", out)
        self.assertIn("Use web_fetch on a result URL to read the full page.", out)
        self.assertNotIn(KEY, out)

    def test_no_results_is_said_plainly(self):
        self.answers("/api/web_search", 200, {"results": []})
        self.assertEqual(search_mod.search("zzqx", "ollama", api_key=KEY), 'No web results for "zzqx".')

    def test_an_answer_that_is_not_results_is_an_error(self):
        self.answers("/api/web_search", 200, "<html>a captive portal</html>")
        with self.assertRaises(search_mod.SearchError):
            search_mod.results("x", "ollama", api_key=KEY)

    def test_an_answer_too_big_to_be_results_is_refused(self):
        self.answers("/api/web_search", 200, {"results": [{"title": "t", "url": "https://a.example/", "content": "x" * 5000}]})
        with patch.object(search_mod, "OLLAMA_MAX_BYTES", 1000, create=True):
            with self.assertRaises(search_mod.SearchError) as caught:
                search_mod.results("x", "ollama", api_key=KEY)
        self.assertIn("more than", str(caught.exception))

    # -- errors that say what to do

    def test_no_signed_in_ollama_and_no_key_says_where_to_get_one_and_where_to_paste_it(self):
        with self.assertRaises(search_mod.SearchError) as caught:
            search_mod.results("x", "ollama")
        message = str(caught.exception)
        self.assertEqual(_Fake.seen, [], "nothing was sent anywhere")
        self.assertIn(f"no Ollama answered at http://{self.dead}", message, "what was tried")
        self.assertIn("ollama signin", message)
        self.assertIn("ollama.com → Settings → API keys", message, "where to get a key")
        self.assertIn("Settings → Web search", message, "where to paste it")
        self.assertIn("/search ollama", message)
        out = search_mod.search("x", "ollama")
        self.assertTrue(out.startswith("error: Ollama web search can't run"), out)

    def test_each_reason_this_computers_ollama_cant_search_is_named(self):
        self.local()
        for status, body, said in ((401, {"error": "unauthorized"}, "isn't signed in to ollama.com"),
                                   (404, "404 page not found", "has no web search (Ollama 0.18 and later has it)"),
                                   (403, {"error": "ollama cloud is disabled: web search is unavailable"},
                                    "has its cloud features turned off")):
            with self.subTest(status=status):
                self.answers("/api/experimental/web_search", status, body)
                with self.assertRaises(search_mod.SearchError) as caught:
                    search_mod.results("x", "ollama")
                self.assertIn(f"the Ollama at {self.base} {said}", str(caught.exception))
                self.assertIn("ollama.com → Settings → API keys", str(caught.exception))

    def test_a_refused_key_says_so_and_never_shows_it(self):
        self.answers("/api/web_search", 401, {"error": "unauthorized"})
        with self.assertRaises(search_mod.SearchError) as caught:
            search_mod.results("x", "ollama", api_key=KEY)
        message = str(caught.exception)
        self.assertIn("ollama.com refused the API key saved for web search (HTTP 401)", message)
        self.assertIn("ollama.com → Settings → API keys", message)
        self.assertIn("Settings → Web search", message)
        self.assertNotIn(KEY, message)
        self.assertNotIn(KEY, search_mod.search("x", "ollama", api_key=KEY))

    def test_rate_limits_and_server_errors_fail_as_the_other_providers_do(self):
        # Brave and Tavily raise a requests error here: the web_search tool says "web search failed (provider)",
        # ChatDGC and Pips get a SearchError, and Deep Research asks again once. Ollama does the same.
        for status in (429, 500, 502, 503):
            with self.subTest(status=status):
                self.answers("/api/web_search", status, {"error": f"upstream said {KEY}"})
                with self.assertRaises(search_mod.requests.RequestException):
                    search_mod._run("x", "ollama", KEY, "", 6)
                out = search_mod.search("x", "ollama", api_key=KEY)
                self.assertTrue(out.startswith(f"error: web search failed (ollama): HTTP {status}"), out)
                self.assertIn("from ollama.com", out)
                self.assertNotIn(KEY, out, "an error that echoes the key has it taken out")
                with self.assertRaises(search_mod.SearchError) as caught:
                    search_mod.results("x", "ollama", api_key=KEY)
                self.assertIn("web search failed (ollama)", str(caught.exception))
        self.answers("/api/web_search", 429, {})
        self.assertIn("HTTP 429 Too Many Requests from ollama.com", search_mod.search("x", "ollama", api_key=KEY))

    def test_a_rate_limited_local_ollama_is_not_retried_with_the_key(self):
        # The same account's limit: asking again with the key would only spend another request.
        self.local()
        self.answers("/api/experimental/web_search", 429, {"error": "too many requests"})
        out = search_mod.search("x", "ollama", api_key=KEY)
        self.assertTrue(out.startswith(f"error: web search failed (ollama): HTTP 429 Too Many Requests from the Ollama at {self.base}"), out)
        self.assertEqual([r["path"] for r in _Fake.seen], ["/api/experimental/web_search"])

    def test_it_has_no_image_search_and_says_so(self):
        with self.assertRaises(search_mod.SearchError) as caught:
            search_mod.images("red panda", "ollama", api_key=KEY)
        self.assertIn("not pictures", str(caught.exception))
        self.assertEqual(_Fake.seen, [])

    # -- the key is a secret like the others

    def test_the_key_is_redacted_like_every_search_key(self):
        from dgc.redaction import redact_text, secret_values

        class Cfg:
            def get(self, key, default=None):
                return {"search_provider": "ollama", "search_api_key": KEY}.get(key, default)
        self.assertIn(KEY, secret_values(Cfg()))
        self.assertNotIn(KEY, redact_text(f"Authorization: Bearer {KEY}", secret_values(Cfg())))


class _Cfg:
    def __init__(self, **data):
        self.data = dict(data)

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value, **_):
        self.data[key] = value


class SettingsSurfacesTests(unittest.TestCase):
    """Every place the web search is chosen offers Ollama: `/search`, `dgc setup` and the TUI's /settings here; the
    editor's Settings in editors/vscode/test, and `set_config` in test_shared_web_search_settings."""

    def test_slash_search_ollama_asks_for_an_optional_key_masked(self):
        from dgc import cli
        said = []
        stub = types.SimpleNamespace(config=_Cfg(), ui=types.SimpleNamespace(info=said.append,
                                                                             error=lambda m: said.append("error: " + m)))
        prompts = []
        with patch("getpass.getpass", side_effect=lambda prompt: prompts.append(prompt) or ""):
            cli.CLI._search_cmd(stub, "ollama")
        self.assertEqual(stub.config.data, {"search_provider": "ollama", "search_api_key": ""},
                         "Enter keeps no key: the signed-in Ollama here searches without one")
        self.assertIn("ollama.com → Settings → API keys", prompts[0])
        self.assertIn("Enter for none", prompts[0])
        with patch("getpass.getpass", return_value=f"  {KEY} "):
            cli.CLI._search_cmd(stub, "ollama")
        self.assertEqual(stub.config.data["search_api_key"], KEY)
        self.assertFalse([m for m in said if KEY in m], "the key is never echoed")
        self.assertIn("Ollama web search", said[-1])

    def test_dgc_setup_offers_it_and_asks_for_the_optional_key(self):
        import io
        from contextlib import redirect_stdout
        from dgc import cli

        class SetupCfg(_Cfg):
            base_url = property(lambda self: self.data.get("base_url", ""))
            api_key = property(lambda self: self.data.get("api_key", ""))
            model = property(lambda self: self.data.get("model", "fixture"))

        class NoModels:
            def __init__(self, *a, **k):
                self.api_mode = "chat_completions"

            def list_models(self):
                return []

        menus, prompts = [], []

        def select(title, labels, hints=None):
            menus.append((title, list(labels)))
            if title == "Provider":
                return 0                                    # the first preset: Ollama (local), no key
            return [SEARCH_PROVIDERS[k]["label"] for k in SEARCH_PROVIDERS].index(SEARCH_PROVIDERS["ollama"]["label"])

        cfg = SetupCfg(context_size=32768)
        with patch("dgc.menu.select", side_effect=select), patch("dgc.subscriptions.status", return_value=[]), \
                patch("dgc.llm.LLMClient", NoModels), patch("builtins.input", return_value=""), \
                patch("getpass.getpass", side_effect=lambda prompt: prompts.append(prompt) or ""), \
                patch.object(cli, "offer_voice", lambda *a, **k: False), \
                patch.object(cli, "pips_sandbox_note", lambda: ""), redirect_stdout(io.StringIO()):
            cli.run_setup(cfg)
        search_menu = [labels for title, labels in menus if title.startswith("Web search")]
        self.assertEqual(len(search_menu), 1)
        self.assertIn(SEARCH_PROVIDERS["ollama"]["label"], search_menu[0])
        self.assertEqual((cfg.data["search_provider"], cfg.data["search_api_key"]), ("ollama", ""))
        self.assertEqual(len(prompts), 1, "its optional key is asked for, masked")
        self.assertIn("Enter for none", prompts[0])
        self.assertEqual(cli._search_key_prompt(SEARCH_PROVIDERS["brave"]), "  API key for Brave Search (API key) › ",
                         "Brave's prompt is as it was")

    def test_the_tui_settings_have_web_search_and_never_show_the_key(self):
        from dgc.tui import TUI
        rows = {row[0]: row for row in TUI._SETTINGS["Web search"]}
        self.assertEqual(list(rows["search_provider"][2:]), ["enum", list(SEARCH_PROVIDERS)])
        self.assertIn("ollama", rows["search_provider"][3])
        self.assertEqual(rows["search_api_key"][2], "secret")
        flashes, asked = [], []
        stub = types.SimpleNamespace(config=_Cfg(search_api_key=KEY), _CLIENT_KEYS=TUI._CLIENT_KEYS,
                                     _flash=flashes.append, _open_settings_cat=lambda cat: None,
                                     _ask_input=lambda prompt, cb, secret=False: asked.append((prompt, cb, secret)))
        stub._apply_setting = lambda *a: TUI._apply_setting(stub, *a)
        self.assertEqual(TUI._fmt_setting(stub, "search_api_key", "secret"), "saved")
        TUI._edit_setting(stub, "Web search", "search_api_key", "secret", [])
        prompt, answer, secret = asked[-1]
        self.assertTrue(secret, "typed masked")
        self.assertNotIn(KEY, prompt, "the saved key is not shown back")
        answer("new-ollama-key-81c2")
        self.assertEqual(stub.config.data["search_api_key"], "new-ollama-key-81c2")
        self.assertEqual(flashes[-1], "search_api_key saved")
        answer("")
        self.assertEqual(stub.config.data["search_api_key"], "", "blank removes it")
        self.assertEqual((flashes[-1], TUI._fmt_setting(stub, "search_api_key", "secret")),
                         ("search_api_key removed", "(none)"))
        TUI._apply_setting(stub, "Web search", "search_provider", "ollama", "enum")
        self.assertEqual(stub.config.data["search_provider"], "ollama")
        self.assertFalse([f for f in flashes if "ollama-key" in f])


if __name__ == "__main__":
    unittest.main()
