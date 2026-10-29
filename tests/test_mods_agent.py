"""Mods inside a real Agent (dgc/mods/bridge.py): on the real tool path, Guard turns an allowed `rm -rf` into an
Ask that a rule can't answer behind the user's back, a mod's stop stops the step, a step it didn't mind runs and
is reported to it, and a prompt it may rewrite is rewritten, said and kept."""
from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import sandbox
from dgc.agent import Agent
from dgc.config import DEFAULTS, Config
from dgc.llm import ToolCall
from dgc.mods import bridge, catalog, consent

BOXED = sandbox._backend() is not None


class _UI:
    def __init__(self):
        self.infos, self.denied, self.asked, self.rechecked, self.results = [], [], [], [], []

    def info(self, text, *a, **k):
        self.infos.append(text)

    def tool_denied(self, name, args, reason, call_id):
        self.denied.append((name, reason))

    def tool_result(self, name, out, call_id):
        self.results.append((name, out))

    def approve_live(self, name, args, call_id, recheck=None):
        self.asked.append(name)
        self.rechecked.append(recheck() if recheck else None)
        return "no"

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


def write_mod(root: Path, name: str, code: str, caps: dict) -> Path:
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "main.py").write_text(textwrap.dedent(code))
    (folder / "dgc-mod.json").write_text(json.dumps({"name": name, "version": "1.0.0", "entry": "main.py",
                                                     "title": name.title(), "capabilities": caps}))
    return folder


class ModsInTheAgent(unittest.TestCase):
    def setUp(self):
        tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-modagent-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(tmp / "home")
        self.root = tmp / "project"
        self.root.mkdir()
        cfg = object.__new__(Config)
        cfg.project_root, cfg.project_dir, cfg._persist = self.root, self.root / ".dgc", False
        cfg.data = copy.deepcopy(DEFAULTS)
        cfg.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto", hooks={},
                        mcp_servers={}, suggest=False, artifact_autostart=False, thinking="off")
        cfg._stored_secrets, cfg._env_secret_keys = {}, set()
        cfg.permissions = {"allow": [], "ask": [], "deny": []}
        self.config = cfg
        self.ui = _UI()
        self.agent = Agent(cfg, self.ui)
        self.addCleanup(self.agent.mcp.stop_all)
        stopper = write_mod(tmp / "src", "stopper", """
            import dgc_mod as dm
            mod = dm.Mod()
            heard = []
            @mod.on("tool.call")
            def call(e):
                if "forbidden" in str(e.get("args")):
                    return dm.deny("not that file")
            @mod.on("tool.result")
            def result(e):
                heard.append(e.get("tool"))
                mod.state_set("heard", heard)
            @mod.command("heard")
            def show(args):
                return ",".join(mod.state_get("heard", []) or [])
            mod.run()
        """, {"events": ["tool.call", "tool.result"], "commands": [{"name": "heard"}]})
        shouter = write_mod(tmp / "src", "shouter", """
            import dgc_mod as dm
            mod = dm.Mod()
            @mod.on("prompt.submit")
            def loud(e):
                return dm.rewrite(e["text"].upper(), "shouted")
            mod.run()
        """, {"events": ["prompt.submit"], "rewrites_prompt": True})
        self.extra = (str(stopper), str(shouter))
        for m in catalog.available(self.extra):
            if m.name in ("guard", "stopper", "shouter"):
                consent.allow(m, unsandboxed=not BOXED)
        self.host = bridge.start(self.agent, extra=self.extra)
        self.addCleanup(bridge.stop, self.agent)

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def call(self, command: str) -> str:
        return self.agent._handle_call(ToolCall(id=f"c{time.monotonic_ns()}", name="bash",
                                                arguments={"command": command}))

    def test_guard_asks_first_where_auto_mode_would_have_run_it_and_no_rule_answers_for_the_user(self):
        running = {e["name"] for e in self.host.mods() if e["state"] == "running"}
        self.assertTrue({"guard", "stopper", "shouter"} <= running, self.host.mods())
        out = self.call("rm -rf build")
        self.assertEqual(self.ui.asked, ["bash"], "auto mode, yet the user is asked")
        self.assertEqual(self.ui.rechecked, [None], "the rules (all allow) don't answer the mod's Ask")
        self.assertTrue(any("Guard asks you first" in i and "deletes build" in i for i in self.ui.infos), self.ui.infos)
        self.assertIn("DENIED", out)

    def test_a_mods_stop_stops_the_step_and_a_step_it_didnt_mind_runs_and_is_reported(self):
        out = self.call("touch forbidden.txt")
        self.assertTrue(out.startswith("STOPPED by the user's Stopper mod: not that file"), out)
        self.assertFalse((self.root / "forbidden.txt").exists())
        self.assertIn(("bash", "Stopped by Stopper: not that file"), self.ui.denied)
        out = self.call("echo fine")
        self.assertIn("fine", out)
        for _ in range(50):
            got = self.host.run_command("heard")
            if got.get("text") == "bash":
                break
            time.sleep(0.05)
        self.assertEqual(got.get("text"), "bash", "tool.result reached the mod")

    def test_a_prompt_may_be_rewritten_and_it_is_said(self):
        self.assertEqual(bridge.prompt(self.agent, "make it so"), "MAKE IT SO")
        self.assertTrue(any(i.startswith("Edited by Shouter (shouted). What you typed: make it so") for i in self.ui.infos))
        self.assertEqual(self.agent._mod_prompt_edit["original"], "make it so")

    def test_in_a_pips_run_only_guard_mods_run_and_an_ask_stops_the_step(self):
        """A Pip's run is unattended: guard mods (ones that hear tool.call) watch its steps and nothing else runs
        there or is drawn; a mod that would ask stops the step, since nobody is there to answer."""
        bridge.stop(self.agent)
        self.agent.mods = None
        host = bridge.start(self.agent, extra=self.extra, surface="pip")
        running = {e["name"] for e in host.mods() if e["state"] == "running"}
        self.assertTrue({"guard", "stopper"} <= running, host.mods())
        self.assertNotIn("shouter", running, "a mod that only rewrites prompts doesn't run in a Pip's run")
        self.assertEqual(bridge.prompt(self.agent, "make it so"), "make it so")
        out = self.call("rm -rf build")
        self.assertEqual(self.ui.asked, [], "nobody is asked")
        self.assertTrue(out.startswith("STOPPED by the user's Guard mod"), out)
        self.assertIn("nobody to ask", out)
        self.assertTrue(self.call("touch forbidden.txt").startswith("STOPPED by the user's Stopper mod"))
        self.assertIn("ok", self.call("echo ok"))
        self.assertEqual(host.ui_state, {}, "nothing is drawn")

    def test_safe_mode_runs_none_of_them(self):
        bridge.stop(self.agent)
        self.agent.mods = None
        os.environ["DGC_SAFE_MODE"] = "1"
        self.addCleanup(os.environ.pop, "DGC_SAFE_MODE", None)
        host = bridge.start(self.agent, extra=self.extra)
        self.assertEqual(host.running, {})
        self.assertIn("ok", self.call("echo ok"))
        self.assertEqual(self.ui.asked, [])


if __name__ == "__main__":
    unittest.main()
