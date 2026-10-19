"""Short updates between tool calls: the Work agent keeps the user informed, a sub-agent does not.

The founder watched turns where many tool calls went by before the model said anything, with only
its thinking to read. Codex ("preamble messages") and Claude Code both tell their models to say in
a sentence what they are about to do before the first tool call, and to give a one-line update when
they find something or change course. DGC's Work prompt now says the same, with a concrete trigger
for a long quiet stretch.

A sub-agent is different: `_SubUI.on_text` keeps its prose and only the final message becomes the
task result, so nothing it writes between tool calls is ever shown. Narrating there only spends
tokens, and the child is told so instead.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dgc.agent import Agent                                       # noqa: E402
from dgc.llm import ToolCall                                      # noqa: E402
from dgc.presentation import (PROGRESS_UPDATES, RESPONSE_GUIDANCE,  # noqa: E402
                              SUBAGENT_UPDATES, delegated_presentation)
from test_subagents import Harness, calls_then, child, fixture_config  # noqa: E402


class _UI:
    def __getattr__(self, _name):
        return lambda *a, **kw: None


def cadence(prompt: str) -> str:
    """The "# Response cadence" section alone, so a match elsewhere in the prompt cannot pass."""
    assert "# Response cadence" in prompt, "the Work prompt lost its cadence section"
    return prompt.split("# Response cadence", 1)[1].split("\n# ", 1)[0]


class TheWorkPromptAsksForUpdatesTest(unittest.TestCase):
    def prompt(self, depth=0, **config) -> str:
        directory = tempfile.TemporaryDirectory(prefix="dgc-updates-")
        self.addCleanup(directory.cleanup)
        agent = Agent(fixture_config(Path(directory.name), **config), _UI())
        self.addCleanup(agent.mcp.stop_all)
        agent.depth = depth
        return agent.system_prompt()

    def test_the_rule_is_in_the_cadence_section(self) -> None:
        section = cadence(self.prompt())
        for line in PROGRESS_UPDATES:
            self.assertIn(line, section)
        self.assertNotIn(SUBAGENT_UPDATES[0], section)

    def test_the_rule_says_what_it_must(self) -> None:
        """The parts that changed behaviour: the first call, the triggers, the quiet-stretch cap,
        batching, and that thinking is not a message. And no update sent on its own: a text-only
        message ends the turn."""
        rule = " ".join(PROGRESS_UPDATES)
        for words in ("Before your first tool call", "one sentence", "in the same message as the call",
                      "find something that matters", "change approach", "hit a blocker",
                      "start editing", "every five or so calls", "One line covers a batch",
                      "not your thinking", "Do not narrate each call", "repeat the plan"):
            self.assertIn(words, rule)

    def test_the_old_every_group_line_is_gone(self) -> None:
        """It asked for a line before EVERY group, which the "trivial reads" exception beside it
        contradicted, and measured turns skipped the opening line 6 times in 20."""
        self.assertNotIn("Before EACH group of tool calls", self.prompt())

    def test_plan_mode_and_the_adaptive_profile_keep_it(self) -> None:
        for config in ({"mode": "plan"}, {"tool_profile": "adaptive"}, {"mode": "default"}):
            with self.subTest(config=config):
                section = cadence(self.prompt(**config))
                self.assertIn(PROGRESS_UPDATES[0], section)

    def test_the_final_answer_guidance_is_unchanged(self) -> None:
        section = cadence(self.prompt())
        self.assertIn(RESPONSE_GUIDANCE, section)
        self.assertIn("give a final response in normal text", section)

    def test_a_subscription_engine_does_not_get_it(self) -> None:
        """Claude Code and Codex bring their own preamble rules; two sets would disagree."""
        wired = delegated_presentation("do the thing")
        self.assertNotIn(PROGRESS_UPDATES[0], wired)


class ASubAgentIsToldNotToNarrateTest(unittest.TestCase):
    def test_its_prompt_has_the_child_line_instead(self) -> None:
        directory = tempfile.TemporaryDirectory(prefix="dgc-updates-child-")
        self.addCleanup(directory.cleanup)
        agent = Agent(fixture_config(Path(directory.name)), _UI())
        self.addCleanup(agent.mcp.stop_all)
        agent.depth = 1
        section = cadence(agent.system_prompt())
        self.assertIn(SUBAGENT_UPDATES[0], section)
        for line in PROGRESS_UPDATES:
            self.assertNotIn(line, section)

    def test_a_real_delegation_sends_the_child_line_on_the_wire(self) -> None:
        """`depth` is set after the child is constructed, so the prompt it actually SENDS is the
        one to check: the system message on the child's own request."""
        directory = tempfile.TemporaryDirectory(prefix="dgc-updates-wire-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name))
        self.addCleanup(harness.close)
        seen = {}

        def record(name, route):
            def wrapped(messages, results, cancel):
                seen.setdefault(name, messages[0]["content"])
                return route(messages, results, cancel)
            return wrapped

        task = ToolCall("t1", "task", {"description": "look around", "prompt": "CHILD look"})
        self.assertTrue(harness.run("go", [("CHILD", record("child", child())),
                                           ("go", record("parent", calls_then([task])))]))
        self.assertIn(PROGRESS_UPDATES[0], seen["parent"])
        self.assertNotIn(SUBAGENT_UPDATES[0], seen["parent"])
        self.assertIn(SUBAGENT_UPDATES[0], seen["child"])
        self.assertNotIn(PROGRESS_UPDATES[0], seen["child"])


if __name__ == "__main__":
    unittest.main()
