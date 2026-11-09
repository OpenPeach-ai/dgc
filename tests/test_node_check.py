"""dgc doctor says when the Node.js that DGC's parts run on is out of date (0.52, the user's call, 9 Nov).

DGC never runs on Node itself; Claude Code and Codex installed with npm, `npx` MCP servers and the TypeScript SDK run
on the user's own. Node's 21 Oct 2026 security release fixed four High issues (22.23.4, 24.22.1, 26.12.1), and Node 20
gets no fixes at all. doctor names each Node it finds and the one command that updates it; it never blocks anything
and goes online for nothing.
"""
from __future__ import annotations

import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

from dgc import node_check                                # noqa: E402


def fake_node(folder: Path, version: str, name: str = "node") -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    node = folder / name
    node.write_text(f"#!/bin/sh\necho {version}\n", encoding="utf-8")
    node.chmod(node.stat().st_mode | stat.S_IXUSR)
    return node


class WhatEachNodeIs(unittest.TestCase):
    def test_behind_up_to_date_and_past_end_of_life(self):
        cases = {"v22.22.2": "behind", "v22.23.4": "ok", "v22.24.0": "ok", "v24.11.0": "behind", "v24.22.1": "ok",
                 "v26.12.1": "ok", "v27.0.0": "ok", "v20.19.6": "end_of_life", "v18.19.1": "end_of_life", "v23.1.0": "end_of_life",
                 "nonsense": "unknown"}
        for version, state in cases.items():
            with self.subTest(version=version):
                self.assertEqual(node_check.assess(version).state, state)
        behind = node_check.assess("v22.22.2", "/home/u/.nvm/versions/node/v22.22.2/bin/node")
        self.assertIn("22.23.4", behind.words, "names the release that fixes it")
        self.assertEqual(behind.fix, "nvm install 22")
        old = node_check.assess("v20.19.6", "/usr/bin/node")
        self.assertIn("past end of life", old.words)
        self.assertIn("Node 26", old.fix, "an end-of-life line moves to the newest supported one")

    def test_the_one_command_that_updates_it(self):
        self.assertEqual(node_check.update_command("/home/u/.nvm/versions/node/v24.11.0/bin/node", 24), "nvm install 24")
        self.assertEqual(node_check.update_command("/opt/homebrew/bin/node", 22), "brew upgrade node@22")
        self.assertIn("nodejs.org", node_check.update_command("/usr/local/bin/node", 24))

    def test_each_installer_gets_its_own_command(self):
        """The path is resolved, so Homebrew's formula, and the version manager that owns it, can be told apart."""
        cases = {("/opt/homebrew/Cellar/node/24.11.0/bin/node", 24): "brew upgrade node",
                 ("/opt/homebrew/Cellar/node@22/22.22.2/bin/node", 22): "brew upgrade node@22",
                 ("/home/linuxbrew/.linuxbrew/Cellar/node@20/20.19.6/bin/node", 20): "brew install node@26",
                 ("/home/u/.local/share/fnm/node-versions/v22.22.2/installation/bin/node", 22): "fnm install 22",
                 ("/home/u/.volta/tools/image/node/22.22.2/bin/node", 22): "volta install node@22",
                 ("/home/u/.local/share/mise/installs/node/24.11.0/bin/node", 24): "mise use -g node@24",
                 ("/home/u/.nvm/versions/node/v20.19.6/bin/node", 20): "nvm install 26"}
        for (path, line), command in cases.items():
            with self.subTest(path=path):
                self.assertEqual(node_check.update_command(path, line), command)


class WhichNodes(unittest.TestCase):
    def test_the_node_on_path_and_the_one_beside_an_npm_codex(self):
        base = Path(tempfile.mkdtemp(prefix="dgc-node-")).resolve()
        system = fake_node(base / "system", "v20.19.6")
        npm_bin = base / "nvm" / "versions" / "node" / "v22.22.2" / "bin"
        beside = fake_node(npm_bin, "v22.22.2")
        codex = npm_bin / "codex"
        codex.write_text("#!/usr/bin/env node\n", encoding="utf-8")
        codex.chmod(codex.stat().st_mode | stat.S_IXUSR)
        with patch.dict(os.environ, {"PATH": f"{system.parent}{os.pathsep}{npm_bin}"}):
            found = node_check.nodes()
            report = node_check.report()
        self.assertEqual(found, [str(system), str(beside)])
        self.assertEqual([r.state for r in report], ["end_of_life", "behind"])

    def test_no_node_at_all(self):
        with patch.dict(os.environ, {"PATH": tempfile.mkdtemp(prefix="dgc-empty-")}):
            self.assertEqual(node_check.report(), [])


class DoctorSaysIt(unittest.TestCase):
    def run_doctor(self, findings):
        from dgc import cli as cli_mod
        from dgc.llm import LLMClient
        printed = []

        class _Console:
            def print(self, *args, **kwargs):
                printed.append(" ".join(str(a) for a in args))

        class _Config:
            base_url = "http://127.0.0.1:59999/v1"
            api_key = ""
            model = "fixture-model"
            data = {"mode": "default", "context_size": 32768}

            def get(self, key, default=None):
                return self.data.get(key, default)

        with patch.object(LLMClient, "list_models", lambda _self: ["fixture-model"]), \
                patch.object(cli_mod, "Console", lambda *a, **k: _Console()), \
                patch.object(node_check, "report", return_value=findings):
            code = cli_mod.run_doctor(_Config())
        return code, "\n".join(printed)

    def test_an_out_of_date_node_is_said_with_its_fix_and_never_fails_doctor(self):
        findings = [node_check.assess("v22.22.2", "/home/u/.nvm/versions/node/v22.22.2/bin/node"),
                    node_check.assess("v20.19.6", "/usr/bin/node")]
        code, said = self.run_doctor(findings)
        self.assertEqual(code, 0, "a warning, never a failure")
        self.assertIn("node", said)
        self.assertIn("22.22.2", said)
        self.assertIn("nvm install 22", said)
        self.assertIn("past end of life", said)

    def test_a_folder_name_with_brackets_is_printed_as_written(self):
        """doctor's lines are Rich markup; a path is data, never markup."""
        from rich.console import Console
        from dgc import cli as cli_mod
        out = Console(record=True, width=200, color_system=None)
        finding = node_check.assess("v22.22.2", "/home/u/[red]x[/red]/node")
        with patch.object(node_check, "report", return_value=[finding]):
            cli_mod._doctor_node(out)
        self.assertIn("/home/u/[red]x[/red]/node", out.export_text())

    def test_no_node_says_nothing_is_needed(self):
        code, said = self.run_doctor([])
        self.assertEqual(code, 0)
        self.assertIn("not installed", said)


if __name__ == "__main__":
    unittest.main()
