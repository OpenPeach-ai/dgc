"""Built-in task specialists: explorer / researcher / critic / worker."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import agents
from dgc.agent import Agent
from test_subagents import Harness


class BuiltinAgentCatalogTests(unittest.TestCase):
    def test_builtins_are_always_present(self):
        names = set(agents.discover_agents("/no/such/project").keys())
        self.assertEqual(names, {"explorer", "researcher", "critic", "worker"})
        explorer = agents.discover_agents("/no/such/project")["explorer"]
        self.assertTrue(explorer.builtin)
        self.assertIn("read_file", explorer.tool_allow)
        self.assertNotIn("write_file", explorer.tool_allow)
        self.assertNotIn("bash", explorer.tool_allow)
        self.assertEqual(agents.discover_agents("/no/such/project")["worker"].tool_allow, frozenset())

    def test_project_file_overrides_a_builtin_after_trust(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-named-agents-")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        folder = root / ".dgc" / "agents"
        folder.mkdir(parents=True)
        (folder / "explorer.md").write_text("---\nname: explorer\ndescription: Custom\n---\nMine\n")
        config = SimpleNamespace(data={"trusted_dirs": []})
        self.assertTrue(agents.discover_agents(root, config=config)["explorer"].builtin)
        config.data["trusted_dirs"] = [str(root)]
        custom = agents.discover_agents(root, config=config)["explorer"]
        self.assertFalse(custom.builtin)
        self.assertEqual(custom.body.strip(), "Mine")


class HandoffParseTests(unittest.TestCase):
    def test_files_line(self):
        self.assertEqual(agents.parse_handoff_files("Done.\nFILES: docs/a.md, src/b.py"),
                         ["docs/a.md", "src/b.py"])
        self.assertEqual(agents.parse_handoff_files("nothing"), [])
        self.assertEqual(agents.parse_handoff_files("FILES: `notes.md`"), ["notes.md"])


class ExplorerToolGateTests(unittest.TestCase):
    def test_explorer_child_is_not_offered_writes(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-explorer-gate-")
        self.addCleanup(temp.cleanup)
        h = Harness(Path(temp.name), tool_profile="full")
        self.addCleanup(h.close)
        child = Agent(h.config, h.ui)
        child.depth = 1
        child._agent_tool_allowlist = agents.builtin_agents()["explorer"].tool_allow
        names = {tool["function"]["name"] for tool in child._tool_schemas()}
        self.assertIn("read_file", names)
        self.assertIn("grep", names)
        self.assertNotIn("write_file", names)
        self.assertNotIn("edit_file", names)
        self.assertNotIn("bash", names)
        self.assertNotIn("task", names)

    def test_parent_prompt_names_the_specialists(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-parent-prompt-")
        self.addCleanup(temp.cleanup)
        h = Harness(Path(temp.name))
        self.addCleanup(h.close)
        prompt = h.agent.system_prompt()
        self.assertIn("explorer:", prompt)
        self.assertIn("critic:", prompt)
        self.assertIn("Do not paste the child's logs", prompt)

    def test_finished_agent_keeps_a_files_line(self):
        from dgc.subagents import SubagentRegistry
        seen = []
        registry = SubagentRegistry()
        registry.listener = lambda kind, payload: seen.append((kind, payload))
        registry.start(id="sub-aaaaaaaaaaaa", description="map", agent_type="explorer")
        registry.end("sub-aaaaaaaaaaaa", "finished",
                     "Map of the auth package.\nFILES: dgc/trust.py, dgc/config.py",
                     tool_calls=3)
        ended = [payload for kind, payload in seen if kind == "ended"][-1]
        self.assertIn("FILES: dgc/trust.py, dgc/config.py", ended["message"])
        self.assertEqual(ended["state"], "finished")


class ChildCallIdTests(unittest.TestCase):
    def test_child_tool_ids_are_prefixed_with_the_agent_id(self):
        from dgc.agent import _SubUI

        class Parent:
            def __init__(self):
                self.calls = []

            def tool_call(self, name, args, call_id=None):
                self.calls.append((name, call_id))

        parent = Parent()
        ui = _SubUI(parent, "map")
        ui.tool_call("grep", {"pattern": "x"}, "call_0")
        name, call_id = parent.calls[0]
        self.assertEqual(name, "grep")
        self.assertEqual(call_id, f"{ui.agent_id}:call_0")
        self.assertRegex(ui.agent_id, r"^sub-[0-9a-f]{12}$")
