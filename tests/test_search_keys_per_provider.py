"""Each web search provider keeps its own key (founder, 2026-10-21).

Brave, Tavily and Ollama shared one saved `search_api_key`. Switching provider kept it, so a Brave key went to Tavily
in its request body, or to ollama.com as a Bearer token when the Ollama on this computer couldn't search: a credential
sent to the wrong vendor. Now each provider has its own key in ~/.dgc/secrets.json (`search_api_key_brave`,
`search_api_key_tavily`, `search_api_key_ollama`) and a search sends only the key saved for the provider in use.

Every search here goes to a fake server on 127.0.0.1: requests to api.search.brave.com, api.tavily.com and ollama.com
are routed to it, and anything else that isn't this computer fails the test, so nothing goes online. What the fake
server records is what `requests` really sent: the headers and the body.
"""
from __future__ import annotations

import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError("tests/test_search_keys_per_provider.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-search-keys-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

import requests  # noqa: E402

from dgc import config as config_module  # noqa: E402
from dgc import editor_protocol as ep  # noqa: E402
from dgc import headless, pip_app_links, pip_web_reads, sessions, tools  # noqa: E402
from dgc import search as search_mod  # noqa: E402
from dgc.chatdgc.engine import ChatEngine  # noqa: E402
from dgc.config import Config  # noqa: E402

BRAVE = "brave-key-3e91c0d7a5b2"
TAVILY = "tvly-key-8a2f6c4e1d09"
OLLAMA = "ollama-key-5d7b9e2a4c16"
ENV_KEY = "env-search-key-6f0a2c8e4b13"
SLOTS = {"brave": "search_api_key_brave", "tavily": "search_api_key_tavily", "ollama": "search_api_key_ollama"}
# The vendors, and where the fake server takes each one's requests.
_VENDORS = {"https://api.search.brave.com": "/brave", "https://api.tavily.com": "/tavily",
            "https://ollama.com": "/ollamacom"}


class _Fake(BaseHTTPRequestHandler):
    seen: list = []

    def _answer(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        type(self).seen.append({"method": method, "path": self.path,
                                "headers": {k.lower(): v for k, v in self.headers.items()},
                                "body": raw.decode("utf-8", "replace")})
        if self.path.startswith("/brave/"):
            body = {"web": {"results": [{"title": "From Brave", "url": "https://brave.example/", "description": "b"}]}}
        elif self.path.startswith("/tavily/"):
            body = {"results": [{"title": "From Tavily", "url": "https://tavily.example/", "content": "t"}]}
        elif self.path.startswith("/ollamacom/"):
            body = {"results": [{"title": "From ollama.com", "url": "https://ollama.example/", "content": "o"}]}
        else:
            body = None
        data = json.dumps(body).encode() if body is not None else b"404 page not found"
        self.send_response(200 if body is not None else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):                                       # noqa: N802 -- http.server's name
        self._answer("GET")

    def do_POST(self):                                      # noqa: N802
        self._answer("POST")

    def log_message(self, *args):
        pass


def _closed_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Isolated(unittest.TestCase):
    """A fresh ~/.dgc per test, and every search sent to the fake server."""

    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-search-keys-")).resolve()
        self.tmp = tmp
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        for name in ("DGC_SEARCH_API_KEY", "DGC_SEARCH_API_KEY_FILE", "DGC_PROJECT_ROOT"):
            os.environ.pop(name, None)
        os.environ["OLLAMA_HOST"] = f"127.0.0.1:{_closed_port()}"     # no Ollama on this computer: ollama.com next
        (tmp / "project" / ".git").mkdir(parents=True)
        self.write_settings({"model": "fixture", "base_url": "http://localhost.invalid/v1", "suggest": False,
                             "artifact_autostart": False, "mcp_servers": {}})
        _Fake.seen = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Fake)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        base = f"http://127.0.0.1:{self.server.server_address[1]}"
        real_get, real_post = requests.get, requests.post

        def route(url):
            for origin, prefix in _VENDORS.items():
                if url.startswith(origin + "/"):
                    return base + prefix + url[len(origin):]
            if urlsplit(url).hostname not in ("127.0.0.1", "localhost", "::1"):
                raise AssertionError(f"a search went online: {url}")
            return url

        for target in (patch.object(requests, "get", lambda url, *a, **k: real_get(route(url), *a, **k)),
                       patch.object(requests, "post", lambda url, *a, **k: real_post(route(url), *a, **k)),
                       patch.object(search_mod, "_duckduckgo", self._no_duckduckgo)):
            target.start()
            self.addCleanup(target.stop)

    @staticmethod
    def _no_duckduckgo(query, n):
        raise search_mod.SearchError("DuckDuckGo is stubbed out in this test")

    def write_settings(self, data):
        current = {}
        if (self.user / "config.json").exists():
            current = json.loads((self.user / "config.json").read_text())
        current.update(data)
        (self.user / "config.json").write_text(json.dumps(current))

    def config(self) -> Config:
        return Config(project_root=self.tmp / "project")

    def secrets(self) -> dict:
        path = self.user / "secrets.json"
        return json.loads(path.read_text()) if path.exists() else {}

    def search_everywhere(self, cfg) -> list[str]:
        """One search from each place DGC searches: a Work turn's web_search tool, ChatDGC, a Pip's web_search and a
        Pip's reviewed web reads. Each reads the provider and key its own way."""
        said = [tools.web_search({"query": "red pandas"}, types.SimpleNamespace(config=cfg))]
        try:
            said.append(json.dumps(ChatEngine._search(types.SimpleNamespace(config=cfg), "red pandas")))
        except search_mod.SearchError as exc:
            said.append(f"error: {exc}")
        said.append(pip_app_links.RunSocket._search(types.SimpleNamespace(taint=None, config=cfg, said=""),
                                                    {"query": "red pandas"}))
        said.append(pip_web_reads._search("red pandas", cfg))
        return said

    def carried(self, key: str) -> list[str]:
        """Every vendor a request carrying `key` went to, from what the fake server was really sent."""
        return [r["path"].split("/")[1] for r in _Fake.seen if key in json.dumps(r["headers"]) or key in r["body"]]

    def vendors(self) -> set[str]:
        return {r["path"].split("/")[1] for r in _Fake.seen}


class AKeyGoesOnlyToItsOwnProvider(_Isolated):
    def test_a_brave_key_is_never_sent_to_tavily_or_ollama_com(self):
        cfg = self.config()
        cfg.set("search_provider", "brave")
        cfg.set("search_api_key", BRAVE)        # the one name `/search`, `dgc setup` and an older editor save it by
        self.search_everywhere(cfg)
        brave = [r for r in _Fake.seen if r["path"].startswith("/brave/")]
        self.assertEqual(len(brave), 4, "each place searched Brave")
        self.assertTrue(all(r["headers"].get("x-subscription-token") == BRAVE for r in brave), "with Brave's key")
        for provider in ("tavily", "ollama"):
            with self.subTest(provider=provider):
                _Fake.seen = []
                cfg.set("search_provider", provider)       # switched, no key typed for it
                said = self.search_everywhere(cfg)
                self.assertEqual(self.carried(BRAVE), [], f"the Brave key went to {provider}")
                self.assertEqual(_Fake.seen, [], f"{provider} has no key of its own, so nothing is sent")
                self.assertTrue(all(s.startswith("error") for s in said), said)
                self.assertTrue(any("API key" in s for s in said), "it says a key is needed")
                fresh = self.config()                     # and a new process reads the same
                _Fake.seen = []
                self.search_everywhere(fresh)
                self.assertEqual(self.carried(BRAVE), [])

    def test_each_provider_sends_its_own_key(self):
        cfg = self.config()
        for provider, key in (("brave", BRAVE), ("tavily", TAVILY), ("ollama", OLLAMA)):
            cfg.set("search_provider", provider)
            cfg.set("search_api_key", key)
        for provider, key, others in (("brave", BRAVE, (TAVILY, OLLAMA)), ("tavily", TAVILY, (BRAVE, OLLAMA)),
                                      ("ollama", OLLAMA, (BRAVE, TAVILY))):
            with self.subTest(provider=provider):
                cfg.set("search_provider", provider)
                _Fake.seen = []
                said = self.search_everywhere(cfg)
                self.assertFalse([s for s in said if s.startswith("error")], said)
                self.assertEqual(self.vendors(), {{"ollama": "ollamacom"}.get(provider, provider)})
                self.assertEqual(len(self.carried(key)), 4, "its own key, from every place")
                for other in others:
                    self.assertEqual(self.carried(other), [], "never another provider's")
                request = _Fake.seen[0]
                if provider == "brave":
                    self.assertEqual(request["headers"]["x-subscription-token"], BRAVE)
                elif provider == "tavily":
                    self.assertEqual(json.loads(request["body"])["api_key"], TAVILY)
                else:
                    self.assertEqual(request["headers"]["authorization"], f"Bearer {OLLAMA}")
        saved = self.secrets()
        self.assertEqual({p: saved.get(slot) for p, slot in SLOTS.items()},
                         {"brave": BRAVE, "tavily": TAVILY, "ollama": OLLAMA}, "three keys, each by its own name")
        self.assertNotIn("search_api_key", saved, "the shared name is gone")
        public = (self.user / "config.json").read_text()
        for key in (BRAVE, TAVILY, OLLAMA):
            self.assertNotIn(key, public, "never in config.json")

    def test_removing_one_key_leaves_the_others(self):
        cfg = self.config()
        for provider, key in (("brave", BRAVE), ("tavily", TAVILY)):
            cfg.set("search_provider", provider)
            cfg.set("search_api_key", key)
        cfg.set("search_api_key", "")              # Tavily's, the one selected
        self.assertEqual((self.secrets().get(SLOTS["brave"]), self.secrets().get(SLOTS["tavily"])), (BRAVE, None))
        self.search_everywhere(cfg)
        self.assertEqual(_Fake.seen, [], "Tavily has none now, and Brave's isn't borrowed")
        cfg.set("search_provider", "brave")
        self.search_everywhere(cfg)
        self.assertEqual(len(self.carried(BRAVE)), 4)


class TheOldSharedKeyMovesOnce(_Isolated):
    def test_it_becomes_the_key_of_the_provider_selected_at_load(self):
        self.write_settings({"search_provider": "tavily"})
        (self.user / "secrets.json").write_text(json.dumps({"search_api_key": TAVILY}))
        cfg = self.config()
        saved = self.secrets()
        self.assertEqual(saved.get(SLOTS["tavily"]), TAVILY, "Tavily's own now")
        self.assertNotIn("search_api_key", saved, "the shared name is never written back")
        self.assertEqual(oct((self.user / "secrets.json").stat().st_mode & 0o777), "0o600")
        self.search_everywhere(cfg)
        self.assertEqual({r["path"].split("/")[1] for r in _Fake.seen}, {"tavily"})
        self.assertEqual(len(self.carried(TAVILY)), 4)
        for provider in ("brave", "ollama"):
            with self.subTest(provider=provider):
                cfg.set("search_provider", provider)
                _Fake.seen = []
                self.search_everywhere(cfg)
                self.assertEqual(_Fake.seen, [], "Tavily's key stays Tavily's")
        again = self.config()                       # the move happens once: a later load doesn't move it again
        self.assertEqual((again.get("search_provider"), self.secrets().get(SLOTS["ollama"])), ("ollama", None))

    def test_a_key_still_in_config_json_moves_the_same_way(self):
        # Releases before secrets.json kept the key in config.json itself.
        self.write_settings({"search_provider": "brave", "search_api_key": BRAVE})
        cfg = self.config()
        self.assertNotIn("search_api_key", json.loads((self.user / "config.json").read_text()))
        self.assertEqual(self.secrets().get(SLOTS["brave"]), BRAVE)
        self.assertEqual(config_module.search_settings(cfg), ("brave", BRAVE, ""))

    def test_with_duckduckgo_selected_it_is_kept_aside_and_never_sent(self):
        self.write_settings({"search_provider": "duckduckgo"})
        (self.user / "secrets.json").write_text(json.dumps({"search_api_key": BRAVE}))
        cfg = self.config()
        saved = self.secrets()
        self.assertEqual(saved.get("search_api_key_unassigned"), BRAVE, "kept, whose it is unknown")
        self.assertEqual([saved.get(slot) for slot in SLOTS.values()], [None, None, None], "nobody's key")
        self.assertNotIn("search_api_key", saved)
        for provider in ("brave", "tavily", "ollama", "searxng"):
            with self.subTest(provider=provider):
                cfg.set("search_provider", provider)
                self.assertEqual(cfg.get("search_api_key", ""), "")
                self.search_everywhere(cfg)
                self.search_everywhere(self.config())         # nor after a reload with this provider selected
                self.assertEqual(self.carried(BRAVE), [], f"sent to {provider}")
        self.assertEqual(_Fake.seen, [], "no provider was sent anything")
        self.assertEqual(self.secrets().get("search_api_key_unassigned"), BRAVE)

    def test_with_searxng_selected_it_is_kept_aside_too(self):
        self.write_settings({"search_provider": "searxng", "search_url": "http://127.0.0.1:9"})
        (self.user / "secrets.json").write_text(json.dumps({"search_api_key": TAVILY}))
        self.config()
        self.assertEqual(self.secrets().get("search_api_key_unassigned"), TAVILY)
        self.assertIsNone(self.secrets().get(SLOTS["tavily"]))


class TheEnvironmentKey(_Isolated):
    def test_it_is_the_selected_providers_only(self):
        self.write_settings({"search_provider": "brave"})
        os.environ["DGC_SEARCH_API_KEY"] = ENV_KEY
        cfg = self.config()
        self.search_everywhere(cfg)
        self.assertEqual(len(self.carried(ENV_KEY)), 4, "Brave, the provider selected at launch, uses it")
        for provider in ("tavily", "ollama"):
            with self.subTest(provider=provider):
                cfg.set("search_provider", provider)
                _Fake.seen = []
                self.search_everywhere(cfg)
                self.assertEqual(self.carried(ENV_KEY), [], f"never carried over to {provider}")
                self.assertEqual(_Fake.seen, [])
        self.assertNotIn(ENV_KEY, json.dumps(self.secrets()), "an environment key is never saved")
        self.assertNotIn(ENV_KEY, (self.user / "config.json").read_text())

    def test_a_chat_opened_after_a_switch_does_not_hand_it_to_the_new_provider(self):
        # `dgc serve` builds a Config for each chat it opens. The key stays the one selected at start's.
        self.write_settings({"search_provider": "brave"})
        os.environ["DGC_SEARCH_API_KEY"] = ENV_KEY
        first = self.config()
        first.set("search_provider", "tavily")             # Settings switches; then a second chat opens
        second = self.config()
        self.assertEqual(config_module.search_settings(second), ("tavily", "", ""))
        self.search_everywhere(second)
        self.assertEqual(_Fake.seen, [], "Tavily got nothing")
        second.set("search_provider", "brave")
        self.assertEqual(config_module.search_settings(second), ("brave", ENV_KEY, ""), "still Brave's")

    def test_with_a_keyless_provider_selected_it_is_never_used(self):
        self.write_settings({"search_provider": "duckduckgo"})
        os.environ["DGC_SEARCH_API_KEY"] = ENV_KEY
        cfg = self.config()
        for provider in ("brave", "tavily", "ollama"):
            cfg.set("search_provider", provider)
            self.search_everywhere(cfg)
        self.assertEqual(_Fake.seen, [])
        self.assertNotIn(ENV_KEY, json.dumps(self.secrets()))

    def test_a_launchers_key_file_is_the_selected_providers_only_and_deleted(self):
        self.write_settings({"search_provider": "ollama"})
        handed = self.tmp / "search-key"
        handed.write_text(OLLAMA)
        os.environ["DGC_SEARCH_API_KEY_FILE"] = str(handed)
        cfg = self.config()
        self.assertFalse(handed.exists(), "read once and deleted")
        self.assertEqual(config_module.search_settings(cfg), ("ollama", OLLAMA, ""))
        cfg.set("search_provider", "brave")
        self.assertEqual(config_module.search_settings(cfg), ("brave", "", ""))


class EveryKeyNameIsRedacted(_Isolated):
    def test_each_providers_key_the_one_kept_aside_and_the_environments(self):
        from dgc.redaction import redact_text, secret_values
        self.write_settings({"search_provider": "tavily"})
        (self.user / "secrets.json").write_text(json.dumps({"search_api_key_unassigned": "aside-key-2b8d6f0e4a91",
                                                            "search_api_key_brave": BRAVE}))
        os.environ["DGC_SEARCH_API_KEY"] = ENV_KEY        # Tavily's, for this launch
        cfg = self.config()
        cfg.set("search_provider", "ollama")
        cfg.set("search_api_key", OLLAMA)
        cfg.set("search_provider", "duckduckgo")       # none of them selected: each is still a secret
        values = secret_values(cfg)
        for key in (BRAVE, OLLAMA, "aside-key-2b8d6f0e4a91", ENV_KEY):
            with self.subTest(key=key):
                self.assertIn(key, values)
                self.assertNotIn(key, redact_text(f"Authorization: Bearer {key} / api_key={key}", values))
        for name in ("search_api_key", "search_api_key_brave", "search_api_key_tavily", "search_api_key_ollama",
                     "search_api_key_unassigned"):
            self.assertIn(name, config_module.SECRET_KEYS, f"{name} is never written to config.json")
        public = json.loads((self.user / "config.json").read_text())
        self.assertFalse([k for k in public if k.startswith("search_api_key")], public)

    def test_a_chats_own_key_is_redacted_on_the_shared_wire(self):
        host = headless.Host(self.config())
        wire = io.StringIO()
        host.core.fp = wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(host.chats.values())])
        host.default.config.data["search_api_key_tavily"] = TAVILY
        host.default.em.emit("info", message=f"echo {TAVILY}")
        self.assertNotIn(TAVILY, wire.getvalue())


class SettingsKeepsEachProvidersKey(_Isolated):
    def setUp(self):
        super().setUp()
        self.wire = io.StringIO()
        self.host = headless.Host(self.config())
        self.host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(self.host.chats.values())])

    def frames(self):
        return [json.loads(line) for line in self.wire.getvalue().splitlines()]

    def last(self, kind, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = [f for f in self.frames() if f["type"] == kind]
            if found:
                return found[-1]
            time.sleep(0.02)
        self.fail(f"no {kind} frame: {self.frames()[-3:]}")

    def asked(self, request_id):
        self.host.dispatch({"type": "get_config", "request_id": request_id, "fields": ["search_url", "search_api_key_set"]})
        frame = self.last("config")
        self.assertIsNone(ep.event_error(frame))
        return frame["search"], frame["search_api_key_set"]

    def test_the_handshake_says_which_providers_keep_their_own_key_and_which_have_one(self):
        ready = self.host.default._ready_payload()
        self.assertEqual(ready["capabilities"]["search_keys"],
                         {"version": 1, "providers": ["brave", "tavily", "ollama"], "saved": []})
        self.assertIsNone(ep.event_error({"type": "ready", "seq": 1, **ready}), "still a valid handshake")
        self.host.dispatch({"type": "set_config", "request_id": "k1",
                            "values": {"search_provider": "ollama", "search_api_key_brave": BRAVE}})
        self.assertEqual([f for f in self.frames() if f["type"] == "command_rejected"], [])
        self.assertEqual(self.host.default._ready_payload()["capabilities"]["search_keys"]["saved"], ["brave"])
        self.assertEqual(self.asked("k2"), ("ollama", False), "the selected provider's own key: none")
        self.assertNotIn(BRAVE, self.wire.getvalue(), "a key never crosses the wire")

    def test_an_older_editors_one_key_field_saves_the_selected_providers_key(self):
        self.host.dispatch({"type": "set_config", "values": {"search_provider": "brave", "search_api_key": BRAVE}})
        self.host.dispatch({"type": "set_config", "values": {"search_provider": "tavily"}})
        self.assertEqual(self.asked("o1"), ("tavily", False), "switching keeps Brave's key Brave's")
        self.host.dispatch({"type": "set_config", "values": {"search_provider": "tavily", "search_api_key": TAVILY}})
        self.assertEqual(self.asked("o2"), ("tavily", True))
        self.assertEqual((self.secrets().get(SLOTS["brave"]), self.secrets().get(SLOTS["tavily"])), (BRAVE, TAVILY))
        self.host.dispatch({"type": "set_config", "values": {"search_provider": "searxng", "search_api_key": OLLAMA,
                                                             "search_url": "http://127.0.0.1:8888"}})
        self.assertEqual(self.asked("o3"), ("searxng", False), "a provider that takes no key keeps none")
        self.assertNotIn(OLLAMA, json.dumps(self.secrets()))
        self.assertEqual([f for f in self.frames() if f["type"] == "command_rejected"], [])

    def test_remove_clears_one_providers_key_by_its_own_name(self):
        self.host.dispatch({"type": "set_config", "values": {"search_provider": "brave", "search_api_key_brave": BRAVE,
                                                             "search_api_key_tavily": TAVILY}})
        self.assertEqual(self.asked("r0"), ("brave", True))
        self.host.dispatch({"type": "set_config", "request_id": "r1", "values": {"search_api_key_tavily": ""}})
        self.assertEqual(self.last("config")["request_id"], "r1", "answered like any save")
        self.assertEqual((self.secrets().get(SLOTS["brave"]), self.secrets().get(SLOTS["tavily"])), (BRAVE, None))
        self.assertEqual(self.host.default._ready_payload()["capabilities"]["search_keys"]["saved"], ["brave"])
        self.host.dispatch({"type": "set_config", "values": {"search_api_key_brave": ""}})
        self.assertEqual(self.asked("r2"), ("brave", False), "the selected one's too")
        self.assertEqual([self.secrets().get(slot) for slot in SLOTS.values()], [None, None, None])

    def test_each_key_name_is_bounded_like_the_others(self):
        for name in SLOTS.values():
            with self.subTest(name=name):
                self.assertIn(name, headless._LIVE_SAFE_CONFIG_KEYS, "read at each search: it can change mid-turn")
                for bad in ("k" * 16_385, "line\nbreak", 7):
                    values, problem = headless._validated_config_values({name: bad}, set())
                    self.assertIsNone(values)
                    self.assertTrue(problem)


class TheCommandLineKeepsEachProvidersKey(_Isolated):
    def test_slash_search_writes_the_chosen_providers_own_key(self):
        from dgc import cli
        cfg = self.config()
        said = []
        stub = types.SimpleNamespace(config=cfg, ui=types.SimpleNamespace(
            info=said.append, error=lambda m: said.append("error: " + m)))
        prompts = []

        def typed(answer):
            return patch("getpass.getpass", side_effect=lambda prompt: prompts.append(prompt) or answer)

        with typed(f"  {BRAVE} "):
            cli.CLI._search_cmd(stub, "brave")
        with typed(TAVILY):
            cli.CLI._search_cmd(stub, "tavily")
        self.assertEqual((self.secrets().get(SLOTS["brave"]), self.secrets().get(SLOTS["tavily"])), (BRAVE, TAVILY))
        with typed(""):
            cli.CLI._search_cmd(stub, "brave")
        self.assertIn("one is saved (Enter keeps it, - removes it)", prompts[-1])
        self.assertEqual(self.secrets().get(SLOTS["brave"]), BRAVE, "Enter keeps Brave's own key")
        self.assertIn("saved key kept", said[-1])
        with typed("-"):
            cli.CLI._search_cmd(stub, "brave")
        self.assertEqual((self.secrets().get(SLOTS["brave"]), self.secrets().get(SLOTS["tavily"])), (None, TAVILY),
                         "- removes Brave's, and only Brave's")
        self.assertIn("key removed", said[-1])
        with typed(""):
            cli.CLI._search_cmd(stub, "ollama")
        self.assertIsNone(self.secrets().get(SLOTS["ollama"]), "Enter keeps none: Tavily's isn't borrowed")
        self.assertIn("Enter for none", prompts[-1])
        cli.CLI._search_cmd(stub, "")
        self.assertIn("keys saved for: tavily", said[-1])
        self.assertFalse([m for m in said if BRAVE in m or TAVILY in m], "a key is never echoed")
        for prompt in prompts:
            self.assertNotIn(BRAVE, prompt)

    def test_dgc_setup_writes_the_chosen_providers_own_key(self):
        from contextlib import redirect_stdout
        from dgc import cli
        from dgc.config import SEARCH_PROVIDERS
        cfg = self.config()
        cfg.set("search_provider", "brave")
        cfg.set("search_api_key", BRAVE)

        class NoModels:
            def __init__(self, *a, **k):
                self.api_mode = "chat_completions"

            def list_models(self):
                return []

        def select(title, labels, hints=None):
            if title == "Provider":
                return 0
            return list(SEARCH_PROVIDERS).index("tavily")

        prompts = []
        with patch("dgc.menu.select", side_effect=select), patch("dgc.subscriptions.status", return_value=[]), \
                patch("dgc.llm.LLMClient", NoModels), patch("builtins.input", return_value=""), \
                patch("getpass.getpass", side_effect=lambda prompt: prompts.append(prompt) or TAVILY), \
                patch.object(cli, "offer_voice", lambda *a, **k: False), \
                patch.object(cli, "pips_sandbox_note", lambda: ""), redirect_stdout(io.StringIO()):
            cli.run_setup(cfg)
        self.assertEqual(cfg.get("search_provider"), "tavily")
        self.assertEqual([p for p in prompts if "Tavily" in p], [prompts[-1]], "Tavily's own key was asked for")
        self.assertEqual((self.secrets().get(SLOTS["brave"]), self.secrets().get(SLOTS["tavily"])), (BRAVE, TAVILY))

    def test_the_tui_web_search_page_is_the_selected_providers_own_key(self):
        from dgc.tui import TUI
        cfg = self.config()
        flashes, asked, opened = [], [], []
        stub = types.SimpleNamespace(config=cfg, _SETTINGS=TUI._SETTINGS, _CLIENT_KEYS=TUI._CLIENT_KEYS,
                                     _flash=flashes.append, _open_settings_cat=opened.append,
                                     _ask_input=lambda prompt, cb, secret=False: asked.append((prompt, cb, secret)))
        stub._apply_setting = lambda *a: TUI._apply_setting(stub, *a)

        def key_row():
            rows = {row[0]: row for row in TUI._settings_rows(stub, "Web search")}
            key = next(name for name in rows if name.startswith("search_api_key"))
            return key, rows[key][1], TUI._fmt_setting(stub, key, "secret")

        self.assertEqual(key_row(), ("search_api_key", "API key (duckduckgo takes none)", "(none)"))
        TUI._edit_setting(stub, "Web search", "search_api_key", "secret", [])
        self.assertEqual(asked, [], "nothing to type for a provider that takes no key")
        self.assertIn("takes no key", flashes[-1])
        for provider, key in (("brave", BRAVE), ("ollama", OLLAMA)):
            TUI._apply_setting(stub, "Web search", "search_provider", provider, "enum")
            slot, label, state = key_row()
            self.assertEqual((slot, state), (SLOTS[provider], "(none)"), f"{provider} starts with none of its own")
            self.assertEqual(label, f"API key for {provider.capitalize()}")
            TUI._edit_setting(stub, "Web search", slot, "secret", [])
            prompt, answer, secret = asked[-1]
            self.assertTrue(secret)
            self.assertIn(f"{provider.capitalize()} key", prompt)
            answer(key)
            self.assertEqual(flashes[-1], f"{provider.capitalize()} key saved")
            self.assertEqual(key_row()[2], "saved")
        self.assertEqual((self.secrets().get(SLOTS["brave"]), self.secrets().get(SLOTS["ollama"])), (BRAVE, OLLAMA))
        TUI._apply_setting(stub, "Web search", "search_provider", "tavily", "enum")
        self.assertEqual(key_row(), (SLOTS["tavily"], "API key for Tavily", "(none)"), "not Ollama's, not Brave's")
        TUI._apply_setting(stub, "Web search", "search_provider", "ollama", "enum")
        TUI._edit_setting(stub, "Web search", SLOTS["ollama"], "secret", [])
        asked[-1][1]("")
        self.assertEqual(flashes[-1], "Ollama key removed")
        self.assertEqual((self.secrets().get(SLOTS["brave"]), self.secrets().get(SLOTS["ollama"])), (BRAVE, None),
                         "blank removes the selected provider's key, and only its")
        self.assertFalse([f for f in flashes if BRAVE in f or OLLAMA in f])


if __name__ == "__main__":
    unittest.main()
