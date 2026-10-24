"""A Pips-wide default model (config `pips_model`): every Pip on Default follows it, new Pips start on Default.

Before it, a Pip's Default was "Same as DGC" -- DGC's own model, or DGC's subscription CLI -- with nothing in
between. Pinned here: Default resolves to the Pips default when one is set (with no model discovery, as before),
and to DGC's own otherwise; `list_pip_models` says so in its existing `default_model` (no new field, no API bump);
a Pips default is a model on DGC's own connection, so DGC's subscription default no longer captures a Pip on
Default; Settings reads it in an event of its own (`pips_settings`) and writes it with set_config; and the Pips
runner picks a saved change up without a restart, while its connection is the one it started with.
"""
from __future__ import annotations

import copy
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
        raise RuntimeError("tests/test_pips_default_model.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-pips-default-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]

from dgc import config as config_module  # noqa: E402
from dgc import editor_protocol as ep  # noqa: E402
from dgc import headless, pip_daemon, pip_models as models, pips, sessions  # noqa: E402
from dgc.config import DEFAULTS, Config  # noqa: E402
from test_pip_daemon import ConfigFixture, ScriptedEvent  # noqa: E402


class DefaultFollowsThePipsDefault(unittest.TestCase):
    def setUp(self):
        self.config = {"model": "dgc-main", "base_url": "http://model.invalid/v1", "api_mode": "chat_completions",
                       "api_key": "secret-fixture-provider-key", "subscription_engine": "",
                       "provider_capabilities": {}, "pips_model": ""}
        network = patch("requests.sessions.Session.request", side_effect=AssertionError("No network here"))
        network.start()
        self.addCleanup(network.stop)

    def test_it_is_a_config_key_that_starts_empty(self):
        self.assertEqual(DEFAULTS["pips_model"], "", "empty: Pips follow DGC, as before")

    def test_default_resolves_to_the_pips_default_without_discovery(self):
        with patch.object(models.LLMClient, "list_models", side_effect=AssertionError("Default does not discover")):
            self.assertEqual(models.resolve_model_choice(self.config, {"mode": "default"}), "dgc-main")
            self.config["pips_model"] = "glm-5.3:cloud"
            self.assertEqual(models.resolve_model_choice(self.config, {"mode": "default"}), "glm-5.3:cloud")
            self.config["pips_model"] = "  "
            self.assertEqual(models.resolve_model_choice(self.config, {"mode": "default"}), "dgc-main",
                             "blank is the same as DGC")
        self.config["pips_model"] = "not a model"
        with self.assertRaises(Exception):
            models.resolve_model_choice(self.config, {"mode": "default"})

    def test_an_explicit_choice_is_unaffected(self):
        self.config["pips_model"] = "glm-5.3:cloud"
        with patch.object(models.LLMClient, "list_models", return_value=["other", "glm-5.3:cloud"]):
            self.assertEqual(models.resolve_model_choice(self.config, {"mode": "model", "model": "other"}), "other")

    def test_the_model_list_says_what_default_runs(self):
        with patch.object(models.LLMClient, "list_models", return_value=["dgc-main", "glm-5.3:cloud"]), \
                patch("dgc.pip_brain.offered", return_value=[]):
            self.assertEqual(models.list_pip_models(self.config)["default_model"], "dgc-main")
            self.config["pips_model"] = "glm-5.3:cloud"
            self.assertEqual(models.list_pip_models(self.config)["default_model"], "glm-5.3:cloud")

    def test_a_pips_default_is_a_model_even_when_dgc_runs_on_a_subscription(self):
        self.config["subscription_engine"] = "codex"
        with patch("dgc.pip_brain.offered", return_value=[]), \
                patch("dgc.pip_brain.available", return_value=""), \
                patch.object(models.LLMClient, "list_models", return_value=["glm-5.3:cloud"]):
            following = models.list_pip_models(self.config)
            self.assertIn("default_engine", following, "with none set, Default follows DGC's Codex as before")
            self.assertTrue(models.is_subscription(self.config, {"mode": "default"}))
            self.config["pips_model"] = "glm-5.3:cloud"
            own = models.list_pip_models(self.config)
            self.assertNotIn("default_engine", own)
            self.assertEqual(own["default_model"], "glm-5.3:cloud")
            self.assertFalse(models.is_subscription(self.config, {"mode": "default"}))
            self.assertTrue(models.is_subscription(self.config, {"mode": "subscription", "engine": "codex"}),
                            "a Pip that chose a subscription keeps it")

    def test_a_run_on_default_is_pinned_to_the_pips_default(self):
        self.config["pips_model"] = "glm-5.3:cloud"
        with patch.object(models.LLMClient, "list_models", side_effect=AssertionError("Default does not discover")):
            settings = pips._model_settings(self.config, {"mode": "default"})
        self.assertEqual(settings["model"], "glm-5.3:cloud")
        self.assertEqual(settings["base_url"], "http://model.invalid/v1", "on DGC's own connection")
        # A setup prepared on the Pips default still matches it when it is written.
        prepared = {"choice": {"mode": "default"}, "settings": settings}
        self.assertEqual(pips._model_settings(self.config, {"mode": "default"}, _prepared=prepared), settings)

    def test_new_pips_start_on_default(self):
        self.assertEqual(pips._definition("A", "Read")["model_choice"], {"mode": "default"})


class SettingsReadsAndWritesIt(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-pips-default-")).resolve()
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.root = tmp / "project"
        (self.root / ".git").mkdir(parents=True)
        (self.user / "config.json").write_text(json.dumps({
            "suggest": False, "artifact_autostart": False, "mcp_servers": {}, "model": "dgc-main",
            "base_url": "http://127.0.0.1:9/v1"}))
        self.wire = io.StringIO()
        sessions_dir = patch.object(sessions, "SESSIONS_DIR", self.user / "sessions")
        sessions_dir.start()
        self.addCleanup(sessions_dir.stop)
        self.host = headless.Host(Config(project_root=self.root))
        self.host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(self.host.chats.values())])

    def frames(self, kind=""):
        frames = [json.loads(line) for line in self.wire.getvalue().splitlines()]
        for frame in frames:
            self.assertIsNone(ep.event_error(frame), frame)
        return [f for f in frames if not kind or f["type"] == kind]

    def test_only_a_client_that_asks_hears_it_and_set_config_writes_it(self):
        self.host.dispatch({"type": "get_config", "request_id": "c0"})
        self.assertEqual(self.frames("pips_settings"), [], "an SDK or an older editor never sees it")
        self.host.dispatch({"type": "get_config", "request_id": "c1", "fields": ["pips_settings", "nonsense"]})
        told = self.frames("pips_settings")
        self.assertEqual([(f["model"], f.get("request_id")) for f in told], [("", "c1")])
        types = [f["type"] for f in self.frames() if f.get("request_id") == "c1"]
        self.assertLess(types.index("pips_settings"), types.index("config"), "before config, as cache_settings")
        self.assertNotIn("pips_model", self.frames("config")[-1], "never a new field on config")
        self.host.dispatch({"type": "set_config", "request_id": "s1", "values": {"pips_model": "glm-5.3:cloud"}})
        self.assertEqual(self.frames("pips_settings")[-1]["model"], "glm-5.3:cloud")
        self.assertEqual(json.loads((self.user / "config.json").read_text())["pips_model"], "glm-5.3:cloud",
                         "saved for the runner and every other DGC")
        self.assertEqual(self.host.default.config.get("pips_model"), "glm-5.3:cloud")
        for bad in ("http://other/v1", "two words", "x" * 257, 7):
            self.host.dispatch({"type": "set_config", "request_id": "bad", "values": {"pips_model": bad}})
            self.assertEqual(self.frames("command_rejected")[-1]["reason"], "invalid_config_value", bad)
        self.assertEqual(self.host.default.config.get("pips_model"), "glm-5.3:cloud", "a refused one changes nothing")
        self.host.dispatch({"type": "set_config", "request_id": "s2", "values": {"pips_model": ""}})
        self.assertEqual(self.frames("pips_settings")[-1]["model"], "", "and blank goes back to following DGC")

    def test_it_may_change_while_a_turn_runs(self):
        self.assertIn("pips_model", headless._LIVE_SAFE_CONFIG_KEYS, "a Pips setting cannot disturb this chat's turn")


class TheRunnerFollowsItWithoutARestart(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dgc-pips-default-runner-")
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.root = base / "project"
        self.root.mkdir()
        self.user_config = base / "user-config.json"
        env = patch.dict(os.environ, {"DGC_HOME": str(base / "home"), "HOME": str(base / "home")})
        env.start()
        self.addCleanup(env.stop)
        user = patch.object(config_module, "USER_CONFIG", self.user_config)
        user.start()
        self.addCleanup(user.stop)
        execute = patch.object(pips, "_execute_run", side_effect=AssertionError("Tests must not start an audit"))
        execute.start()
        self.addCleanup(execute.stop)
        self.config = ConfigFixture(self.root)
        self.config.data.update(base_url="http://127.0.0.1:11434/v1", api_mode="ollama", model="dgc-main")

    def save(self, **values):
        data = {"base_url": "http://127.0.0.1:11434/v1", "api_mode": "ollama", "model": "dgc-main", **values}
        self.user_config.write_text(json.dumps(data))
        stat = self.user_config.stat()
        os.utime(self.user_config, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))   # a new save, always

    def test_a_saved_pips_default_reaches_the_next_tick(self):
        self.save()
        seen = []
        steps = [lambda event: self.save(pips_model="glm-5.3:cloud"),
                 lambda event: self.save(pips_model="glm-5.3:cloud", base_url="http://elsewhere:11434/v1"),
                 lambda event: self.save(pips_model=""),
                 lambda event: event.set()]
        event = ScriptedEvent(steps)
        with patch.object(pips, "start_queued", side_effect=lambda cfg: seen.append(cfg.get("pips_model"))):
            pip_daemon.serve(self.config, stop_event=event, clock=lambda: "2026-10-24T10:00:00.000Z")
        self.assertEqual(seen, ["", "glm-5.3:cloud", "glm-5.3:cloud", ""],
                         "picked up on the next tick; a save naming another host is not this runner's connection")

    def test_reading_it_never_disturbs_anything_else(self):
        config = ConfigFixture(self.root)
        config.data.update(base_url="http://127.0.0.1:11434/v1", api_mode="ollama", model="dgc-main", sandbox=True)
        before = copy.deepcopy(config.data)
        followed = {}
        pip_daemon._follow_pips_default(config, followed)          # no file yet
        self.assertEqual(config.data, {**before, "pips_model": ""})
        self.save(pips_model="qwen3:8b", model="another", sandbox=False)
        pip_daemon._follow_pips_default(config, followed)
        self.assertEqual(config.data, {**before, "pips_model": "qwen3:8b"}, "only pips_model moves")
        self.user_config.write_text("{ not json")
        pip_daemon._follow_pips_default(config, followed)
        self.assertEqual(config.data["pips_model"], "qwen3:8b", "an unreadable file changes nothing")


if __name__ == "__main__":
    unittest.main()
