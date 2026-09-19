"""Ultra runs independent parts side by side; the default profile delegates only when it clearly helps.

The model can only delegate what it is offered and told about: these checks pin that the `task`
tool, the specialist roster and the calibrated delegation policy reach the top-level model under
Ultra on every tool profile and permission mode, and that the default profile does not pay for
guidance about a tool it was not offered. The policy's wording was measured on real runs: split
parts that change different files into one parallel batch; keep a single part, shared files and
reviews of tested changes with the lead.
"""
from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import agents
from dgc.agent import Agent
from dgc.llm import ToolCall
from dgc.tools import TOOL_SCHEMAS
from dgc.ultra import delegated_prompt
from test_subagents import HarnessCase, calls_then, child, fixture_config


class _UI:
    def __getattr__(self, _name):
        return lambda *args, **kwargs: None


class UltraDelegationTests(unittest.TestCase):
    def agent(self, **config):
        temp = tempfile.TemporaryDirectory(prefix="dgc-ultra-delegation-")
        self.addCleanup(temp.cleanup)
        agent = Agent(fixture_config(Path(temp.name), **config), _UI())
        self.addCleanup(agent.mcp.stop_all)
        return agent

    @staticmethod
    def names(agent) -> set[str]:
        return {tool["function"]["name"] for tool in agent._tool_schemas()}

    def assertUltraPolicy(self, prompt: str, workers: int, mode: str):
        for needle in (
                "# Delegating work",
                "- explorer: ", "- researcher: ", "- critic: ", "- worker: ",
                "A child cannot see this conversation",
                "project-relative paths",
                "exactly what to return",
                "# DGC Ultra execution profile",
                # The measured trade-off, stated so the lead can apply it.
                "not a token-saving mode",
                "saves time only beside other children, on work you have not done yet",
                "never from the size of the code",
                # Structural rules: locate, split parts that change different files, one batch.
                "1. Locate: find the files and symbols each part touches",
                "2. Split: when two or more parts change different files",
                "explorer to map an area",
                "all in ONE response",
                f"up to {workers} parallel workers",
                # A lone blocking child was measured as pure overhead: all parts or none.
                "every part goes in that batch or none does",
                "Parts that share a file or one investigation count as one part",
                "3. Do it yourself when the turn has one part, when running code answers the "
                "question, or when you already know every exact edit",
                "run the tests yourself",
                # Review is not a fixed step: it cost minutes per turn and found nothing when tests
                # already covered the change.
                "spawn critic only when the user asks for a review or no test or command",
                f"permission mode remains {mode}"):
            self.assertIn(needle, prompt)
        # A size-based escape hatch is what the model used to keep every turn to itself; the
        # split-first / always-review wording is what made Ultra 2-6x slower at equal quality.
        for wording in ("a few tool calls", "one small edit", "large, independent",
                        "BEFORE you read any source file", "however small",
                        "once files changed, run critic"):
            self.assertNotIn(wording, prompt)

    def test_ultra_offers_task_and_policy_on_every_profile_and_mode(self):
        for profile in ("adaptive", "full"):
            for mode in ("default", "acceptEdits", "auto"):
                with self.subTest(profile=profile, mode=mode):
                    agent = self.agent(ultra_mode=True, tool_profile=profile, mode=mode,
                                       max_parallel_tasks=3)
                    # No delegation wording, and an ask scoped to named files: Ultra still leads.
                    agent._activate_tool_intents("Fix the bug. Edit only these files: a.py",
                                                 replace=True)
                    self.assertIn("task", self.names(agent))
                    self.assertUltraPolicy(agent.system_prompt(), 3, mode)

    def test_ultra_task_reaches_text_protocol_models(self):
        agent = self.agent(ultra_mode=True)
        section = agent._text_protocol_section()
        self.assertIn('"name":"task"', section)
        self.assertIn("explorer (read-only search and map)", section)

    def test_roster_lists_personal_agents(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-user-agents-")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        (folder / "security.md").write_text(
            "---\nname: security\ndescription: Audit a change for injection bugs\n---\nBe strict.\n")
        with patch.object(agents, "USER_AGENTS", folder):
            agent = self.agent(ultra_mode=True)
            prompt = agent.system_prompt()
        self.assertIn("- security: Audit a change for injection bugs", prompt)
        self.assertLess(prompt.index("- worker: "), prompt.index("- security: "))

    def test_children_do_not_fan_out_recursively(self):
        agent = self.agent(ultra_mode=True)
        agent.depth = 1
        agent._activate_tool_intents("Fix the parser in src/parse.py and run its tests.",
                                     replace=True)
        prompt = agent.system_prompt()
        self.assertNotIn("task", self.names(agent))
        self.assertNotIn("# Delegating work", prompt)
        self.assertNotIn("# DGC Ultra execution profile", prompt)
        # A brief that itself asks for delegation still gets the tool, as before.
        agent._activate_tool_intents("Delegate each module to a sub-agent.", replace=True)
        self.assertIn("task", self.names(agent))

    def test_plan_mode_stays_read_only_under_ultra(self):
        agent = self.agent(ultra_mode=True, mode="plan")
        self.assertNotIn("task", self.names(agent))
        self.assertNotIn("# DGC Ultra execution profile", agent.system_prompt())

    def test_default_profile_pays_for_guidance_only_when_task_is_offered(self):
        agent = self.agent(ultra_mode=False, mode="default")
        agent._activate_tool_intents("Rename the helper in utils.py.", replace=True)
        self.assertNotIn("task", self.names(agent))
        self.assertNotIn("# Delegating work", agent.system_prompt())

        for ask in ("Use sub-agents to fix these two bugs.",
                    "Map how this codebase is structured and explain it."):
            with self.subTest(ask=ask):
                agent._activate_tool_intents(ask, replace=True)
                prompt = agent.system_prompt()
                self.assertIn("task", self.names(agent))
                self.assertIn("# Delegating work", prompt)
                self.assertIn("Delegate when it clearly helps", prompt)
                self.assertIn("Do small or tightly coupled work yourself", prompt)
                self.assertNotIn("# DGC Ultra execution profile", prompt)

    def test_task_schema_invites_exploration_parallelism_and_review(self):
        task = next(t for t in TOOL_SCHEMAS if t["function"]["name"] == "task")["function"]
        text = json.dumps(task)
        self.assertNotIn("large, independent chunks", text)
        for needle in ("exploring code", "a review", "cannot see this conversation",
                       "saves time only beside other tasks",
                       "ONE response", "never batch tasks that depend on or edit the same files",
                       "explorer", "researcher", "critic", "worker"):
            self.assertIn(needle, text)

    def test_delegated_cli_policy_explores_and_reviews(self):
        class _Cfg:
            def get(self, key, default=None):
                return {"ultra_mode": True, "max_parallel_tasks": 4}.get(key, default)
        wrapped = delegated_prompt(_Cfg(), "fix the parser", "default")
        self.assertIn("read-only sub-agents to explore", wrapped)
        self.assertIn("reviewer sub-agent check changed files", wrapped)
        self.assertIn("only when the whole turn is one question or one edit to one file", wrapped)
        self.assertNotIn("small edit", wrapped)
        self.assertTrue(wrapped.endswith("fix the parser"))


class ParallelFanOutTests(HarnessCase):
    def test_a_todo_beside_the_tasks_keeps_the_fan_out_parallel(self):
        # Observed live: the lead sent its checklist update in the same response as four explorer
        # tasks, and the whole batch ran one child after another.
        h = self.make(git=True, max_parallel_tasks=2)
        both = threading.Barrier(2)

        def concurrent_child(messages, results, cancel):
            if not results:
                both.wait(5)        # raises BrokenBarrierError unless the siblings overlap
            return child(summary="mapped", tool=False)(messages, results, cancel)
        todo = ToolCall("t0", "todo", {"todos": [{"content": "map both areas",
                                                  "status": "in_progress"}]})
        calls = [todo] + [ToolCall(f"p{n}", "task", {"description": f"area {n}", "agent": "explorer",
                                                     "prompt": f"CHILD{n} map it"})
                          for n in range(2)]
        h.run("split", [("CHILD0", concurrent_child), ("CHILD1", concurrent_child),
                        ("split", calls_then(calls, final="Both areas mapped."))])
        started = h.of("agent_started")
        self.assertEqual(len(started), 2)
        self.assertTrue(all(frame["parallel"] for frame in started))
        self.assertEqual({frame["state"] for frame in h.of("agent_ended")}, {"finished"})
        tool_ids = [m.get("tool_call_id") for m in h.agent.messages if m.get("role") == "tool"]
        self.assertEqual(tool_ids, ["t0", "p0", "p1"])
        self.assertEqual([item["content"] for item in h.agent.ctx.todos], ["map both areas"])

    def test_any_other_sibling_keeps_the_batch_serial(self):
        h = self.make(git=True, max_parallel_tasks=2)
        calls = [ToolCall("r0", "read_file", {"path": "README.md"})] + [
            ToolCall(f"p{n}", "task", {"description": f"part {n}", "prompt": f"CHILD{n}"})
            for n in range(2)]
        self.assertEqual(h.agent._parallel_task_outputs(calls), {})


if __name__ == "__main__":
    unittest.main()
