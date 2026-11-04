"""DGC Router settings (0.51): the `router` block, its validation, and each system's key in secrets.json.

Off by default, and off is 0.50: a config that never set the Router up is written byte for byte as before.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import config as C  # noqa: E402

PLAN_EXAMPLE = {
    "enabled": False,
    "when_busy": "wait",
    "systems": [
        {"id": "spark", "name": "GPU box", "base_url": "http://gpu-box.local:11434", "server": "ollama",
         "api_mode": "", "enabled": True, "jobs": ["subagents", "pips"], "workers": 4,
         "one_model_at_a_time": True, "memory_gb": 128,
         "models": [{"name": "qwen3.8:32b", "workers": 3, "context": 65536, "note": "design, debugging"},
                    {"name": "qwen3:8b", "workers": 4, "context": 32768, "note": "search, small edits"}],
         "hardware": {"source": "none"}},
    ],
}


class RouterHome:
    """Point config.py's files at a fresh folder for one test (never the real ~/.dgc)."""

    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-router-config-"))
        self.home = self.root / ".dgc"
        self.home.mkdir()
        self._patches = [patch.object(C, "USER_HOME", self.home),
                         patch.object(C, "USER_CONFIG", self.home / "config.json"),
                         patch.object(C, "USER_SECRETS", self.home / "secrets.json"),
                         patch.dict(os.environ, {"DGC_HOME": str(self.root)})]

    def __enter__(self):
        for item in self._patches:
            item.start()
        return self

    def __exit__(self, *exc):
        for item in reversed(self._patches):
            item.stop()

    def config(self):
        project = self.root / "project"
        project.mkdir(exist_ok=True)
        (project / ".git").mkdir(exist_ok=True)
        return C.Config(project)

    def disk(self, name="config.json") -> dict:
        path = self.home / name
        return json.loads(path.read_text()) if path.exists() else {}


class RouterOffIsTheOldConfig(unittest.TestCase):
    def test_router_is_not_a_default_so_a_fresh_config_is_written_as_before(self):
        self.assertNotIn("router", C.DEFAULTS)
        with RouterHome() as home:
            config = home.config()
            config.save()
            written = home.disk()
            self.assertNotIn("router", written)
            self.assertEqual(set(written) - {"permissions"}, set(C.DEFAULTS) - C.SECRET_KEYS)
            secrets = home.disk("secrets.json")
            self.assertFalse(any(key.startswith("router") for key in secrets), secrets)
            self.assertEqual(config.router_block(), {"enabled": False, "when_busy": "wait", "systems": []})

    def test_an_old_config_loads_and_saves_unchanged(self):
        with RouterHome() as home:
            old = {**{k: v for k, v in C.DEFAULTS.items() if k not in C.SECRET_KEYS},
                   "model": "qwen3:8b", "permissions": {"allow": [], "ask": [], "deny": []}}
            (home.home / "config.json").write_text(json.dumps(old, indent=2) + "\n")
            before = (home.home / "config.json").read_bytes()
            config = home.config()
            config.set("thinking", "off")         # an unrelated save
            self.assertNotIn("router", home.disk())
            self.assertEqual(json.loads(before), home.disk())


class RouterValidation(unittest.TestCase):
    def test_the_plan_example_validates_as_written(self):
        block, problems = C.validate_router(PLAN_EXAMPLE)
        self.assertEqual(problems, [])
        self.assertEqual(block["systems"][0]["models"][0], {"name": "qwen3.8:32b", "workers": 3, "context": 65536,
                                                            "note": "design, debugging"})
        self.assertEqual(block["systems"][0]["memory_gb"], 128.0)

    def test_a_bare_host_becomes_an_address_and_v1_is_dropped(self):
        self.assertEqual(C.router_base_url("nas.local"), ("http://nas.local", ""))
        self.assertEqual(C.router_base_url("http://GPU-Box.local:8000/v1/"), ("http://gpu-box.local:8000", ""))
        self.assertEqual(C.router_base_url("https://api.example.com/openai/v1"),
                         ("https://api.example.com/openai", ""))
        self.assertTrue(C.router_base_url("http://me:secret@nas.local:11434")[1])
        self.assertTrue(C.router_base_url("ftp://nas.local")[1])
        self.assertTrue(C.router_base_url("http://nas.local:11434/?key=1")[1])

    def test_problems_are_named(self):
        cases = [
            ({"systems": [{"id": "Bad Id!", "base_url": "nas.local"}]}, "id"),
            ({"systems": [{"id": "nas", "base_url": "nas.local", "key": "sk-1"}]}, "key is never kept"),
            ({"systems": [{"id": "nas", "base_url": "nas.local", "jobs": ["videos"]}]}, "jobs"),
            ({"systems": [{"id": "nas", "base_url": "nas.local", "workers": 0}]}, "workers"),
            ({"systems": [{"id": "nas", "base_url": "nas.local", "models": [{"name": "a", "context": 100}]}]},
             "context"),
            ({"systems": [{"id": "nas", "base_url": "nas.local"}, {"id": "nas", "base_url": "nas2.local"}]},
             "two systems"),
            ({"when_busy": "panic"}, "when_busy"),
            ({"enabled": "yes"}, "enabled"),
            ({"surprise": 1}, "unknown setting"),
        ]
        for value, word in cases:
            with self.subTest(word=word):
                _block, problems = C.validate_router(value)
                self.assertTrue(any(word in problem for problem in problems), problems)

    def test_reading_leaves_out_what_cannot_be_used(self):
        block, problems = C.validate_router({"enabled": True, "systems": [
            {"id": "ok", "base_url": "nas.local", "models": ["qwen3:8b", {"name": "bad name!"}]},
            {"id": "broken", "base_url": "ftp://x"}]})
        self.assertTrue(problems)
        self.assertEqual([s["id"] for s in block["systems"]], ["ok"])
        self.assertEqual([m["name"] for m in block["systems"][0]["models"]], ["qwen3:8b"])
        self.assertEqual(block["systems"][0]["models"][0]["context"], C.ROUTER_DEFAULT_CONTEXT)

    def test_set_router_refuses_a_block_with_problems(self):
        with RouterHome() as home:
            config = home.config()
            with self.assertRaises(ValueError):
                config.set_router({"systems": [{"id": "nas", "base_url": "nas.local", "api_key": "sk-1"}]})
            self.assertNotIn("router", home.disk())
            saved = config.set_router(PLAN_EXAMPLE)
            self.assertEqual(home.disk()["router"], saved)


class RouterKeys(unittest.TestCase):
    def _with_system(self, home, base_url="http://nas.local:11434"):
        config = home.config()
        config.set_router({"enabled": True, "systems": [{"id": "nas", "base_url": base_url}]})
        return config

    def test_a_key_lives_in_secrets_bound_to_the_address(self):
        with RouterHome() as home:
            config = self._with_system(home)
            config.set_router_key("nas", "sk-router-123456")
            secrets = home.disk("secrets.json")
            self.assertEqual(secrets["router_key_nas"], "sk-router-123456")
            self.assertIn("nas", secrets["router_identity"])
            self.assertNotIn("sk-router-123456", (home.home / "config.json").read_text())
            self.assertEqual(config.router_key("nas"), "sk-router-123456")
            again = home.config()
            self.assertEqual(again.router_key("nas"), "sk-router-123456")
            self.assertEqual(again.router_key_ids(), ["nas"])

    def test_a_new_address_drops_the_key(self):
        with RouterHome() as home:
            config = self._with_system(home)
            config.set_router_key("nas", "sk-router-123456")
            block = config.router_block()
            block["systems"][0]["base_url"] = "http://other.local:11434"
            config.set_router(block)
            self.assertEqual(config.router_key("nas"), "")
            self.assertNotIn("router_key_nas", home.disk("secrets.json"))

    def test_an_edited_address_on_disk_is_never_given_the_key(self):
        with RouterHome() as home:
            config = self._with_system(home)
            config.set_router_key("nas", "sk-router-123456")
            data = home.disk()
            data["router"]["systems"][0]["base_url"] = "http://evil.example:11434"
            (home.home / "config.json").write_text(json.dumps(data))
            fresh = home.config()
            self.assertEqual(fresh.router_key("nas"), "")
            self.assertNotIn("router_key_nas", home.disk("secrets.json"))

    def test_a_key_written_into_config_json_moves_to_secrets(self):
        with RouterHome() as home:
            self._with_system(home)
            data = home.disk()
            data["router_key_nas"] = "sk-moved-123456"
            (home.home / "config.json").write_text(json.dumps(data))
            fresh = home.config()
            self.assertEqual(fresh.router_key("nas"), "sk-moved-123456")
            self.assertNotIn("router_key_nas", home.disk())
            self.assertEqual(home.disk("secrets.json")["router_key_nas"], "sk-moved-123456")

    def test_keys_are_redacted(self):
        from dgc.redaction import redact_text, secret_values
        with RouterHome() as home:
            config = self._with_system(home)
            config.set_router_key("nas", "sk-router-abcdef123")
            self.assertIn("sk-router-abcdef123", secret_values(config))
            self.assertNotIn("sk-router-abcdef123", redact_text("key sk-router-abcdef123 here", secret_values(config)))

    def test_two_processes_keep_each_others_keys(self):
        with RouterHome() as home:
            a = home.config()
            a.set_router({"enabled": True, "systems": [{"id": "nas", "base_url": "nas.local"},
                                                       {"id": "mac", "base_url": "mac.local:1234"}]})
            b = home.config()
            a.set_router_key("nas", "sk-nas-111111")
            b.set_router_key("mac", "sk-mac-222222")
            secrets = home.disk("secrets.json")
            self.assertEqual(secrets.get("router_key_nas"), "sk-nas-111111")
            self.assertEqual(secrets.get("router_key_mac"), "sk-mac-222222")

    def test_a_clone_has_the_keys_and_never_saves(self):
        with RouterHome() as home:
            config = self._with_system(home)
            config.set_router_key("nas", "sk-router-123456")
            clone = config.clone_for_root(home.root / "project")
            self.assertEqual(clone.router_key("nas"), "sk-router-123456")


class RouterAcrossProcesses(unittest.TestCase):
    """A long-running DGC (the `dgc serve` behind an open Settings) and `dgc router` in a terminal share one Router:
    what the terminal sets up counts in the window at once, the window's own saves keep it, and the open Settings is
    told. Release check, 2026-11-03: after `dgc router hardware this-box URL --token`, Settings showed no readout for
    four minutes, until a window reload."""

    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from dgc import router as R
        patcher = patch.object(R.Router, "ensure_health", lambda self, config: None)   # no network health rounds
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def window(home):
        window = home.config()
        window.set_router({"enabled": True, "systems": [{"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434",
                                                         "models": [{"name": "qwen3.5:9b", "context": 16384}]}]})
        return window

    @staticmethod
    def terminal_sets_up_the_readout(home, url):
        """`dgc router hardware nas URL --token`, the token typed at its prompt, in a DGC of its own."""
        import contextlib
        import io
        from argparse import Namespace
        from dgc import router_cli
        with patch.object(router_cli, "_read_key", return_value="dgcn_secret"), contextlib.redirect_stdout(io.StringIO()):
            return router_cli._hardware(home.config(), Namespace(system="nas", address=url, token=True, json=True))

    def test_a_readout_set_up_in_a_terminal_counts_in_a_window_opened_before_and_its_changes_keep_it(self):
        import router_hw_fixtures as F
        from dgc import router as R
        with RouterHome() as home, F.FakeHardware("dgc_node", token="dgcn_secret") as fake:
            window = self.window(home)
            self.assertEqual(self.terminal_sets_up_the_readout(home, fake.url), 0)
            row = R.status(window, router=R.Router())["systems"][0].get("hardware") or {}
            self.assertEqual((row.get("source"), row.get("has_token")), ("node", True), row)
            self.assertIn("RTX 4090", row.get("line", ""))
            self.assertEqual(window.router_hardware_token("nas"), "dgcn_secret")
            # A Router change made in the window (a system renamed in Settings) is made on top of it.
            block = window.router_block()
            block["systems"][0]["name"] = "Big NAS"
            window.set_router(block)
            self.assertEqual(home.disk()["router"]["systems"][0]["hardware"], {"source": "node", "url": fake.url})
            self.assertEqual(home.disk()["router"]["systems"][0]["name"], "Big NAS")
            self.assertEqual(home.disk("secrets.json").get("router_key_nas:hardware"), "dgcn_secret")
            # And so is any other save of the window's.
            window.set("model", "qwen3:8b")
            self.assertEqual(home.disk("secrets.json").get("router_key_nas:hardware"), "dgcn_secret")
            self.assertEqual(window.router_hardware_token("nas"), "dgcn_secret")

    def test_the_open_settings_is_told_within_seconds(self):
        import time
        import router_hw_fixtures as F
        from types import SimpleNamespace
        from dgc import headless, router as R
        with RouterHome() as home, F.FakeHardware("dgc_node", token="dgcn_secret") as fake, \
                patch.object(R, "ROUTER", R.Router()), patch.object(R, "WATCH_EVERY_S", 0.05, create=True):
            backend = headless.Backend.__new__(headless.Backend)
            backend.config, events = self.window(home), []
            backend.em = SimpleNamespace(emit=lambda kind, **fields: events.append({"type": kind, **fields}))
            backend._router_watch()                     # Settings asked about the Router once
            self.addCleanup(lambda: backend.__dict__.get("_router_watch_stop", threading.Event()).set())
            time.sleep(0.3)
            self.assertEqual(events, [], "nothing changed yet")
            self.assertEqual(self.terminal_sets_up_the_readout(home, fake.url), 0)
            deadline = time.monotonic() + 5
            while not events and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(events, "the open Settings heard nothing")
            self.assertEqual(events[-1]["type"], "router_changed")
            row = events[-1]["status"]["systems"][0].get("hardware") or {}
            self.assertEqual((row.get("source"), row.get("has_token")), ("node", True), row)
            self.assertIn("RTX 4090", row.get("line", ""))


if __name__ == "__main__":
    unittest.main()
