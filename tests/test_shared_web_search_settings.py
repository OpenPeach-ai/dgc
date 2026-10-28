"""The one web search Work, ChatDGC and Pips share (reported 2026-10-09) is set in the editor's Settings.

`dgc setup` and `/search` could set it; the editor could set only the provider: `set_config` refused a
SearXNG address or a Brave or Tavily key as unknown keys. Now Settings sets all three. The key goes where
`dgc setup` keeps it, the owner-only secrets.json, because the CLI and the Pips runner read it there; the
`config` event says only whether one is saved, and only to an editor that asks (get_config `fields`)."""
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


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
        raise RuntimeError("tests/test_shared_web_search_settings.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-search-settings-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import editor_protocol as ep  # noqa: E402
from dgc import headless, pip_app_links, sessions  # noqa: E402
from dgc.config import Config  # noqa: E402

KEY = "brave-key-7f3a9c21d4e8"


class ValidationTests(unittest.TestCase):
    def check(self, values):
        return headless._validated_config_values(values, set())

    def test_settings_may_set_all_three(self):
        values, problem = self.check({"search_provider": "searxng", "search_url": "https://search.example.org",
                                      "search_api_key": KEY})
        self.assertIsNone(problem)
        self.assertEqual(values["search_url"], "https://search.example.org")
        self.assertEqual(self.check({"search_url": ""}), ({"search_url": ""}, None), "cleared")
        for key in ("search_provider", "search_url", "search_api_key"):
            self.assertIn(key, headless._LIVE_SAFE_CONFIG_KEYS, "read at each search: it can change mid-turn")

    def test_ollama_is_one_settings_may_choose(self):
        values, problem = self.check({"search_provider": "ollama", "search_api_key": KEY})
        self.assertIsNone(problem)
        self.assertEqual(values["search_provider"], "ollama")

    def test_what_is_refused(self):
        for bad in ({"search_url": "ftp://search.example.org"}, {"search_url": "search.example.org"},
                    {"search_url": "https://user:pw@search.example.org"}, {"search_url": "https://a b"},
                    {"search_api_key": "k" * 16_385}, {"search_api_key": "line\nbreak"},
                    {"search_provider": "google"}):
            with self.subTest(bad=bad):
                values, problem = self.check(bad)
                self.assertIsNone(values)
                self.assertTrue(problem)


class SettingsTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-search-settings-")).resolve()
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (self.user / "config.json").write_text(json.dumps({
            "model": "fixture", "base_url": "http://localhost.invalid/v1", "suggest": False,
            "artifact_autostart": False, "mcp_servers": {}}))
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_PROJECT_ROOT", None)
        for name in ("DGC_SEARCH_API_KEY",):
            os.environ.pop(name, None)
        (tmp / "a" / ".git").mkdir(parents=True)
        self.wire = io.StringIO()
        self.host = headless.Host(Config(project_root=tmp / "a"))
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

    def test_saved_where_the_cli_and_the_pips_runner_read_it(self):
        self.host.dispatch({"type": "set_config", "request_id": "s1",
                            "values": {"search_provider": "brave", "search_api_key": KEY}})
        self.assertEqual([f for f in self.frames() if f["type"] == "command_rejected"], [])
        secrets = json.loads((self.user / "secrets.json").read_text())
        self.assertEqual(secrets.get("search_api_key_brave"), KEY, "in secrets.json, as Brave's own, as `dgc setup` keeps it")
        self.assertNotIn("search_api_key", secrets, "never as one key for every provider")
        self.assertEqual(oct((self.user / "secrets.json").stat().st_mode & 0o777), "0o600")
        saved = json.loads((self.user / "config.json").read_text())
        self.assertEqual(saved.get("search_provider"), "brave")
        self.assertNotIn("search_api_key", saved, "never in config.json")
        fresh = Config(project_root=self.host.default.config.project_root)
        self.assertEqual((fresh.get("search_provider"), fresh.get("search_api_key")), ("brave", KEY), "a new CLI sees it")
        self.assertEqual(pip_app_links._search_settings(fresh), ("brave", KEY, ""), "and so does a Pip's search")

    def test_the_handshake_says_which_providers_settings_may_offer(self):
        # Settings offers Ollama only to a CLI that lists it: an older one refuses the whole save on a provider it
        # doesn't know. The list rides in ready.capabilities, an open object (a new field on `ready` would not).
        ready = self.host.default._ready_payload()
        self.assertEqual(ready["capabilities"]["search_providers"], list(config_module.SEARCH_PROVIDERS))
        self.assertIn("ollama", ready["capabilities"]["search_providers"])
        self.assertIsNone(ep.event_error({"type": "ready", "seq": 1, **ready}), "the handshake is still valid")
        self.host.dispatch({"type": "set_config", "request_id": "o1",
                            "values": {"search_provider": "ollama", "search_api_key": KEY}})
        self.assertEqual([f for f in self.frames() if f["type"] == "command_rejected"], [])
        self.assertEqual(json.loads((self.user / "secrets.json").read_text()).get("search_api_key_ollama"), KEY,
                         "kept where Brave's and Tavily's are, as Ollama's own")
        self.host.dispatch({"type": "get_config", "request_id": "o2", "fields": ["search_url", "search_api_key_set"]})
        asked = self.last("config")
        self.assertEqual((asked["search"], asked["search_api_key_set"]), ("ollama", True))
        self.assertIsNone(ep.event_error(asked))
        self.assertNotIn(KEY, self.wire.getvalue())

    def test_settings_hears_whether_a_key_is_saved_never_the_key(self):
        self.host.dispatch({"type": "set_config", "values": {"search_provider": "brave",
                                                             "search_url": "http://127.0.0.1:8888", "search_api_key": KEY}})
        self.host.dispatch({"type": "get_config", "request_id": "c0"})
        plain = self.last("config")
        self.assertNotIn("search_url", plain, "an editor that did not ask never sees the new fields")
        self.host.dispatch({"type": "get_config", "request_id": "c1", "fields": ["search_url", "search_api_key_set"]})
        asked = self.last("config")
        self.assertEqual((asked["search"], asked["search_url"], asked["search_api_key_set"]),
                         ("brave", "http://127.0.0.1:8888", True))
        self.assertIsNone(ep.event_error(asked))
        self.assertNotIn(KEY, self.wire.getvalue(), "the key itself never crosses the wire")
        self.host.dispatch({"type": "set_config", "values": {"search_api_key": ""}})
        self.host.dispatch({"type": "get_config", "request_id": "c2"})
        self.assertFalse(self.last("config")["search_api_key_set"], "cleared")


if __name__ == "__main__":
    unittest.main()
