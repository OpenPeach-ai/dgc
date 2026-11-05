"""`dgc router` (status, add, edit, remove, test, on, off, find, --json), `/router` in the terminal, and the system a
sub-agent runs on, shown on its row."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from router_fakes import FakeServer  # noqa: E402

from dgc import commands, subagents  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


class CommandLine(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-router-cli-"))
        self.project = self.home / "project"
        self.project.mkdir()

    def dgc(self, *args, stdin="", env=None):
        environment = {key: value for key, value in os.environ.items() if not key.startswith("DGC_")}
        environment.update(HOME=str(self.home), PYTHONPATH=str(ROOT), **(env or {}))
        return subprocess.run([sys.executable, "-m", "dgc", "router", *args], cwd=self.project, env=environment,
                              input=stdin, capture_output=True, text=True, timeout=120)

    def config(self) -> dict:
        return json.loads((self.home / ".dgc" / "config.json").read_text())

    def test_the_whole_round(self):
        empty = self.dgc("status", "--json")
        self.assertEqual(empty.returncode, 0, empty.stderr)
        self.assertEqual(json.loads(empty.stdout)["systems"], [])
        self.assertFalse((self.home / ".dgc" / "config.json").exists() and "router" in self.config(),
                         "reading the status writes nothing")
        with FakeServer("ollama") as fake:
            added = self.dgc("add", fake.url, "--name", "GPU box", "--models", "qwen3:8b", "--json")
            self.assertEqual(added.returncode, 0, added.stderr)
            self.assertEqual(json.loads(added.stdout)["change"],
                             f"Add GPU box (ollama at {fake.url}) for sub-agents and Pips with qwen3:8b")
            system = self.config()["router"]["systems"][0]
            self.assertEqual((system["id"], system["models"][0]["context"]), ("gpu-box", 16384))
            self.assertEqual(self.dgc("on").returncode, 0)
            self.assertTrue(self.config()["router"]["enabled"])
            edited = self.dgc("edit", "gpu-box", "--model", "qwen3:8b", "--model-workers", "2", "--note", "search",
                              "--when-busy", "default", "--json")
            self.assertEqual(edited.returncode, 0, edited.stderr)
            block = self.config()["router"]
            self.assertEqual(block["when_busy"], "default")
            self.assertEqual(block["systems"][0]["models"][0]["workers"], 2)
            keyed = self.dgc("edit", "gpu-box", "--key", stdin="sk-from-a-pipe-123\n")
            self.assertEqual(keyed.returncode, 0, keyed.stderr)
            secrets = json.loads((self.home / ".dgc" / "secrets.json").read_text())
            self.assertEqual(secrets["router_key_gpu-box"], "sk-from-a-pipe-123")
            self.assertNotIn("sk-from-a-pipe-123", (self.home / ".dgc" / "config.json").read_text())
            tested = self.dgc("test", "gpu-box", "--checks", "speed,tools", "--json")
            self.assertEqual(tested.returncode, 0, tested.stderr)
            self.assertTrue(json.loads(tested.stdout)["results"]["qwen3:8b"]["tools"]["ok"])
            status = self.dgc("status")
            self.assertIn('gpu-box "GPU box"', status.stdout)
            self.assertIn("tools ✓", status.stdout)
        removed = self.dgc("remove", "gpu-box")
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(self.config()["router"]["systems"], [])
        self.assertNotIn("router_key_gpu-box", json.loads((self.home / ".dgc" / "secrets.json").read_text()))
        self.assertEqual(self.dgc("off").returncode, 0)

    def test_context_by_name_on_add_and_edit(self):
        """0.51: --context takes what Settings' box takes: 16384, 16,384, 16K or 16k."""
        with FakeServer("ollama") as fake:
            added = self.dgc("add", fake.url, "--name", "GPU box", "--models", "qwen3:8b", "--context", "8k", "--json")
            self.assertEqual(added.returncode, 0, added.stderr)
            self.assertEqual(self.config()["router"]["systems"][0]["models"][0]["context"], 8192)
            for given, tokens in (("16K", 16384), ("24,576", 24576), ("12288", 12288)):
                edited = self.dgc("edit", "gpu-box", "--model", "qwen3:8b", "--context", given, "--json")
                self.assertEqual(edited.returncode, 0, edited.stderr)
                self.assertEqual(self.config()["router"]["systems"][0]["models"][0]["context"], tokens, given)
            refused = self.dgc("edit", "gpu-box", "--model", "qwen3:8b", "--context", "1k")
            self.assertEqual(refused.returncode, 2)
            self.assertIn("between 2,048 and 16,777,216", refused.stderr)

    def test_editing_address_and_key_binds_the_key_to_the_new_address(self):
        with FakeServer("ollama") as first, FakeServer("ollama") as second:
            self.assertEqual(self.dgc("add", first.url, "--name", "GPU box", "--models", "qwen3:8b").returncode, 0)
            edited = self.dgc("edit", "gpu-box", "--address", second.url, "--key", stdin="new-key\n")
            self.assertEqual(edited.returncode, 0, edited.stderr)
            from dgc.config import _router_identity
            secrets = json.loads((self.home / ".dgc" / "secrets.json").read_text())
            self.assertEqual(secrets["router_key_gpu-box"], "new-key")
            self.assertEqual(secrets["router_identity"]["gpu-box"],
                             _router_identity(self.config()["router"], "gpu-box"))
            self.assertEqual(self.config()["router"]["systems"][0]["base_url"], second.url)

    def test_errors_are_plain_and_exit_one(self):
        bad = self.dgc("add", "http://127.0.0.1:9")
        self.assertEqual(bad.returncode, 1)
        self.assertIn("no model server answered", bad.stderr)
        self.assertEqual(self.dgc("remove", "nope").returncode, 1)

    def test_the_agents_own_shell_cannot_change_it(self):
        for args in (("on",), ("off",), ("add", "nas.local"), ("remove", "nas"), ("find",),
                     ("edit", "nas", "--key")):
            with self.subTest(args=args):
                refused = self.dgc(*args, env={"DGC_AGENT_SHELL": "1"})
                self.assertEqual(refused.returncode, 2)
                self.assertIn("your decision", refused.stderr)
        self.assertEqual(self.dgc("status", env={"DGC_AGENT_SHELL": "1"}).returncode, 0, "reading is fine")

    def test_help_never_runs_anything(self):
        shown = self.dgc("add", "--help")
        self.assertEqual(shown.returncode, 0)
        self.assertIn("usage: dgc router add", shown.stdout)
        self.assertFalse((self.home / ".dgc" / "config.json").exists())


class Terminal(unittest.TestCase):
    def test_router_is_a_terminal_command(self):
        spec = next((s for s in commands.command_specs("tui") if s.name == "router"), None)
        self.assertIsNotNone(spec)
        self.assertIn("tui", spec.surfaces)
        self.assertIn("classic", spec.surfaces)
        self.assertNotIn("editor", spec.surfaces, "the editor gets its Settings screen instead")

    def test_slash_router(self):
        from dgc import router as R
        from dgc.router_cli import slash
        from test_subagents import fixture_config
        home = tempfile.mkdtemp(prefix="dgc-router-slash-")
        with patch.dict(os.environ, {"DGC_HOME": home}), patch.object(R, "ROUTER", R.Router()), \
                patch.object(R.Router, "ensure_health", lambda self, config: None), FakeServer("ollama") as fake:
            config = fixture_config(Path(home))
            body, line = slash(config, "")
            self.assertIn("has no systems", body)
            body, line = slash(config, f"add {fake.url} GPU box")
            self.assertIn("**Add GPU box (ollama at", body)
            self.assertIn("```diff", body)
            self.assertIn("`/router on`", body)
            _, line = slash(config, "on")
            self.assertEqual(line, "Turn DGC Router on")
            body, line = slash(config, "test gpu-box qwen3:8b")
            self.assertIn("qwen3:8b:", body)
            saved = []
            slash(config, "key gpu-box", ask_key=lambda sid, done: saved.append(sid))
            self.assertEqual(saved, ["gpu-box"])
            _, line = slash(config, "dance")
            self.assertTrue(line.startswith("usage: /router"))

    def test_the_docs_page_has_a_homelab_example_in_plain_words(self):
        import re
        from dgc import docs
        page = next(body for title, _summary, body in docs.DOCS if title == "DGC Router")
        self.assertIn("## A homelab example", page)
        for words in ("gpu-box.local", "nas.local", "dgc router add", "It is **off** until you turn it on",
                      "router_update", "secrets.json"):
            self.assertIn(words, page)
        self.assertIsNone(re.search(r"\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+", page),
                          "examples use names, never an address on someone's network")
        self.assertTrue((ROOT / "docs" / "ROUTER.md").read_text().startswith("# DGC Router"))

    def test_settings_has_a_router_row(self):
        import types
        from dgc.tui import TUI
        from test_subagents import fixture_config
        rows = {row[0]: row for row in TUI._SETTINGS["Model routing"]}
        self.assertEqual(rows["router"][2], "router")
        config = fixture_config(Path(tempfile.mkdtemp()), router={"enabled": True, "systems": [
            {"id": "nas", "base_url": "nas.local:11434", "models": ["qwen3.5:9b"]}]})
        stub = types.SimpleNamespace(config=config)
        self.assertEqual(TUI._fmt_setting(stub, "router", "router"), "on · 1 system · Enter for /router")
        opened = []
        stub._router_command = opened.append
        TUI._edit_setting(stub, "Model routing", "router", "router", [])
        self.assertEqual(opened, [""], "Enter shows /router")

    def test_a_sub_agent_row_names_its_system(self):
        registry = subagents.SubagentRegistry()
        registry.start(id="sub-000000000001", description="look", depth=1, isolated=False, parallel=False)
        registry.running("sub-000000000001", model="qwen3.5:9b")
        registry.set_system("sub-000000000001", "NAS")
        item = registry.snapshot()["items"][0]
        self.assertEqual(item["system"], "NAS")
        self.assertIn("qwen3.5:9b · on NAS", subagents.meta_text(item, main_model="main"))


if __name__ == "__main__":
    unittest.main()
