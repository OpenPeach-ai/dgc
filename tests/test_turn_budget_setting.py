"""The per-turn token cap in Settings (founder, 2026-10-14: "Off, but shown in Settings"). `turn_token_budget` already
capped a turn, sub-agents included, but only config.json could set it. Now Settings -> General shows and saves it, and
the `config` event carries it only to an editor that asks (get_config `fields`), so an older editor never sees a field
it would reject."""
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
        raise RuntimeError("tests/test_turn_budget_setting.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-turn-budget-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import editor_protocol as ep  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.config import Config  # noqa: E402


class ValidationTests(unittest.TestCase):
    def test_a_whole_number_of_tokens_zero_for_no_cap(self):
        for good in (0, 1, 2_000_000, 1_000_000_000):
            with self.subTest(good=good):
                self.assertEqual(headless._validated_config_values({"turn_token_budget": good}, set()),
                                 ({"turn_token_budget": good}, None))
        for bad in (-1, 1_000_000_001, "2000000", 2.5, None):
            with self.subTest(bad=bad):
                values, problem = headless._validated_config_values({"turn_token_budget": bad}, set())
                self.assertIsNone(values)
                self.assertTrue(problem)
        self.assertIn("turn_token_budget", headless._LIVE_SAFE_CONFIG_KEYS, "read at every check: the next one uses it")


class SettingsTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-turn-budget-")).resolve()
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

    def test_settings_reads_and_saves_it_and_the_next_check_uses_it(self):
        self.host.dispatch({"type": "get_config", "request_id": "c0"})
        self.assertNotIn("turn_token_budget", self.last("config"), "an editor that did not ask never sees it")
        self.host.dispatch({"type": "get_config", "request_id": "c1", "fields": ["turn_token_budget"]})
        asked = self.last("config")
        self.assertEqual(asked["turn_token_budget"], 0, "off by default")
        self.assertIsNone(ep.event_error(asked))
        self.host.dispatch({"type": "set_config", "request_id": "s1", "values": {"turn_token_budget": 2_000_000}})
        self.assertEqual([f for f in self.frames() if f["type"] == "command_rejected"], [])
        self.assertEqual(json.loads((self.user / "config.json").read_text())["turn_token_budget"], 2_000_000)
        self.assertEqual(self.host.default.agent.turn_token_budget(), 2_000_000, "this session, from its next check")
        self.host.dispatch({"type": "get_config", "request_id": "c2"})
        self.assertEqual(self.last("config")["turn_token_budget"], 2_000_000)
        self.host.dispatch({"type": "set_config", "request_id": "s2", "values": {"turn_token_budget": -5}})
        self.assertEqual(self.last("command_rejected")["command"], "set_config")
        self.assertEqual(self.host.default.agent.turn_token_budget(), 2_000_000, "a refused value changes nothing")


if __name__ == "__main__":
    unittest.main()
