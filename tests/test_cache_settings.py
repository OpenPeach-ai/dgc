"""Settings -> Models: the prompt-cache lifetime and how long a local Ollama keeps the model loaded.

`prompt_cache_ttl` (0.48) is how long an Anthropic cache entry lives: "5m" or "1h". `ollama_keep_alive`
was config/TUI only. Both now round-trip through the editor: the backend sends them in a NEW event,
`cache_settings`, to an editor whose get_config `fields` named it (a published SDK refuses a new
field on an existing event, so they never ride on `config`), and set_config takes and validates them.
"""
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
        raise RuntimeError("tests/test_cache_settings.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-cache-settings-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import editor_protocol as ep  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.config import DEFAULTS, Config  # noqa: E402
from dgc.llm import LLMClient  # noqa: E402
from fake_providers import FakeProviders  # noqa: E402


class ValidationTests(unittest.TestCase):
    def test_the_lifetime_is_five_minutes_or_one_hour(self):
        self.assertEqual(DEFAULTS["prompt_cache_ttl"], "5m")
        for good in ("5m", "1h"):
            self.assertEqual(headless._validated_config_values({"prompt_cache_ttl": good}, set()),
                             ({"prompt_cache_ttl": good}, None))
        for bad in ("2h", "", "1H", 5, None):
            with self.subTest(bad=bad):
                values, problem = headless._validated_config_values({"prompt_cache_ttl": bad}, set())
                self.assertIsNone(values)
                self.assertTrue(problem)

    def test_keep_alive_takes_what_ollama_takes(self):
        self.assertEqual(DEFAULTS["ollama_keep_alive"], "30m")
        for good in ("30m", "5m", "1h", "24h", "1h30m", "90s", "-1", "0", "300", ""):
            with self.subTest(good=good):
                self.assertEqual(headless._validated_config_values({"ollama_keep_alive": good}, set()),
                                 ({"ollama_keep_alive": good}, None))
        for bad in ("forever", "30 minutes", "1d", "m", "30m;rm", 30, None, "1" * 40):
            with self.subTest(bad=bad):
                values, problem = headless._validated_config_values({"ollama_keep_alive": bad}, set())
                self.assertIsNone(values)
                self.assertIn("ollama_keep_alive", problem)

    def test_both_change_from_the_next_request_even_during_a_turn(self):
        for key in ("prompt_cache_ttl", "ollama_keep_alive"):
            self.assertIn(key, headless._LIVE_SAFE_CONFIG_KEYS)


class RoundTripTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-cache-settings-")).resolve()
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (self.user / "config.json").write_text(json.dumps({
            "model": "qwen3.8:27b", "base_url": "http://localhost.invalid:11434/v1", "suggest": False,
            "artifact_autostart": False, "mcp_servers": {}}))
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
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

    def test_settings_reads_and_saves_both_and_the_next_request_uses_them(self):
        self.host.dispatch({"type": "get_config", "request_id": "c0"})
        self.last("config")
        self.assertEqual([f for f in self.frames() if f["type"] == "cache_settings"], [],
                         "an editor that did not ask never sees the new event")
        self.assertNotIn("prompt_cache_ttl", self.last("config"))
        self.host.dispatch({"type": "get_config", "request_id": "c1", "fields": ["cache_settings"]})
        frames = self.frames()
        asked = [f for f in frames if f["type"] == "cache_settings"]
        self.assertEqual(len(asked), 1)
        self.assertEqual({k: asked[0][k] for k in ("prompt_cache", "prompt_cache_ttl", "ollama_keep_alive")},
                         {"prompt_cache": True, "prompt_cache_ttl": "5m", "ollama_keep_alive": "30m"})
        self.assertIsNone(ep.event_error(asked[0]))
        self.assertLess(frames.index(asked[0]), max(i for i, f in enumerate(frames) if f["type"] == "config"),
                        "it comes before the config the editor forwards to Settings")
        self.assertNotIn("prompt_cache_ttl", self.last("config"), "never a new field on config")

        self.host.dispatch({"type": "set_config", "request_id": "s1",
                            "values": {"prompt_cache_ttl": "1h", "ollama_keep_alive": "4h"}})
        self.assertEqual([f for f in self.frames() if f["type"] == "command_rejected"], [])
        saved = json.loads((self.user / "config.json").read_text())
        self.assertEqual((saved["prompt_cache_ttl"], saved["ollama_keep_alive"]), ("1h", "4h"))
        client = self.host.default.agent.client
        self.assertEqual((client.prompt_cache_ttl, client.keep_alive), ("1h", "4h"),
                         "the client this chat sends its next request with")
        self.assertEqual(self.last("cache_settings")["prompt_cache_ttl"], "1h")
        self.assertEqual(self.last("cache_settings")["ollama_keep_alive"], "4h")
        self.host.dispatch({"type": "set_config", "request_id": "s2", "values": {"ollama_keep_alive": "forever"}})
        self.assertEqual(self.last("command_rejected")["command"], "set_config")
        self.assertEqual(self.host.default.agent.client.keep_alive, "4h", "a refused value changes nothing")


class WireTests(unittest.TestCase):
    def test_a_local_ollama_request_asks_to_keep_the_model_loaded_that_long(self):
        server = FakeProviders()
        self.addCleanup(server.close)
        client = LLMClient(server.url, "ollama", "qwen3.8:27b", api_mode="ollama", ollama_keep_alive="4h")
        client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(server.bodies("ollama")[-1].get("keep_alive"), "4h")
        silent = LLMClient(server.url, "ollama", "qwen3.8:27b", api_mode="ollama", ollama_keep_alive="")
        silent.chat([{"role": "user", "content": "hi"}])
        self.assertNotIn("keep_alive", server.bodies("ollama")[-1], "empty: Ollama's own default")


if __name__ == "__main__":
    unittest.main()
