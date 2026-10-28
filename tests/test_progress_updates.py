"""Short updates between tool calls: the Work agent keeps the user informed, a sub-agent does not.

A user watched turns where many tool calls went by before the model said anything, with only
its thinking to read. Codex ("preamble messages") and Claude Code both tell their models to say in
a sentence what they are about to do before the first tool call, and to give a one-line update when
they find something or change course. DGC's Work prompt now says the same. Its cadence is by time,
as Codex's newest templates put it (never more than about a minute without an update), and since an
open model cannot see a clock, DGC tells it when a tool round ends a minute or more after the user
last read anything from it (`Agent._quiet_note`). The model may also write out a detailed message
mid-turn (a diagnosis, a plan before substantial work), and the final answer must stand on its own.

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

from unittest import mock                                         # noqa: E402

from dgc import agent as agent_mod                                # noqa: E402
from dgc.agent import Agent, _dgc_round, _real_user_turns, summariser_role  # noqa: E402
from dgc.llm import ChatResult, ToolCall                          # noqa: E402
from dgc.presentation import (PROGRESS_UPDATES, QUIET_NOTE_AFTER_S,  # noqa: E402
                              RESPONSE_GUIDANCE, SUBAGENT_UPDATES, delegated_presentation, quiet_note)
from test_subagents import Harness, calls_then, child, fixture_config  # noqa: E402

QUIET = "since the user last heard from you"


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
        """The parts that changed behaviour: the first call, the triggers, the cadence by time,
        batching, the detailed message, a final answer that stands alone, and that thinking is not a
        message. And no update sent on its own: a text-only message ends the turn."""
        rule = " ".join(PROGRESS_UPDATES)
        for words in ("Before your first tool call", "one sentence", "in the same message as the call",
                      "find something that matters", "change approach", "hit a blocker",
                      "start editing", "more than about a minute without one", "One line covers a batch",
                      "not your thinking", "Do not narrate each call", "repeat the plan",
                      "write it out with formatting", "diagnosis", "then keep working",
                      "final answer stand on its own"):
            self.assertIn(words, rule)

    def test_the_final_answer_rule_says_the_updates_fold_away(self) -> None:
        """The editor folds a turn's one-line updates and tool rows into "Worked for 43s" once the
        answer arrives (Codex collapses its commentary the same way), so the model is told why the
        answer must stand alone, in the cadence section it reads."""
        section = cadence(self.prompt())
        self.assertIn("Make the final answer stand on its own: once it arrives, the one-line updates and "
                      "tool calls may fold away out of sight", section)

    def test_the_cadence_is_by_time_not_by_calls(self) -> None:
        """Counting calls rewarded splitting a batch and said nothing about a three-minute test run."""
        self.assertNotIn("every five or so calls", self.prompt())

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


class _Clock:
    """Moves the agent's notion of when the user last read something, as a minute passing would."""

    def __init__(self, agent):
        self.agent = agent

    def pass_seconds(self, seconds: float) -> None:
        if self.agent._heard_at is not None:
            self.agent._heard_at -= seconds


def reminders_in(messages) -> list[str]:
    return [m["content"] for m in messages
            if m.get("role") == "user" and isinstance(m.get("content"), str)
            and m["content"].startswith("<system-reminder>")]


class TheQuietNoteTest(unittest.TestCase):
    """The clock behind "never more than about a minute without an update"."""

    def agent(self, depth=0) -> Agent:
        directory = tempfile.TemporaryDirectory(prefix="dgc-quiet-")
        self.addCleanup(directory.cleanup)
        agent = Agent(fixture_config(Path(directory.name)), _UI())
        self.addCleanup(agent.mcp.stop_all)
        agent.depth = depth
        return agent

    def test_it_waits_a_minute_says_how_long_and_fires_once_per_silence(self) -> None:
        agent = self.agent()
        agent._heard(now=1000.0)
        self.assertEqual(agent._quiet_note(now=1000.0 + QUIET_NOTE_AFTER_S - 1), "", "not before a minute")
        note = agent._quiet_note(now=1075.0)
        self.assertEqual(note, quiet_note(75))
        self.assertIn("75s", note)
        self.assertIn("one-line update with your next tool call", note)
        self.assertEqual(agent._quiet_note(now=1300.0), "", "never twice in one silence")
        agent._heard(now=1310.0)                      # the model said something
        self.assertEqual(agent._quiet_note(now=1340.0), "")
        self.assertIn("61s", agent._quiet_note(now=1371.0), "a new silence gets its own note")

    def test_never_for_a_sub_agent_or_a_pip(self) -> None:
        child = self.agent(depth=1)
        child._heard(now=0.0)
        self.assertEqual(child._quiet_note(now=500.0), "", "a sub-agent's text is not shown")
        pip = self.agent()
        pip.progress_updates = False                  # what ReadOnlyAuditor (dgc/pips.py) declares
        pip._heard(now=0.0)
        self.assertEqual(pip._quiet_note(now=500.0), "")
        source = (PROJECT / "dgc" / "pips.py").read_text(encoding="utf-8")
        self.assertRegex(source, r"class ReadOnlyAuditor\(Agent\):\n\s+progress_updates = False",
                         "Pips (runs and Pip chats) turn the clock off")

    def test_a_real_turn_gets_the_note_after_a_silent_minute_once_and_again_after_it_spoke(self) -> None:
        """Through the real loop: the note joins the round's reminders as one <system-reminder> after
        the tool results, which compaction and the user-turn filters already treat as DGC's."""
        directory = tempfile.TemporaryDirectory(prefix="dgc-quiet-turn-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name))
        self.addCleanup(harness.close)
        clock = _Clock(harness.agent)
        seen = []
        plan = [  # what each response says, and how long the model went quiet before giving it
            ("", 70), ("", 70), ("Found it: the comparison on line 21.", 0), ("", 70), (None, 0)]

        def route(messages, results, cancel):
            seen.append(reminders_in(messages))
            text, seconds = plan[len(seen) - 1]
            if text is None:
                return ChatResult(content="Done: fixed and verified.")
            clock.pass_seconds(seconds)          # thinking and the previous round's tools took this long
            return ChatResult(content=text, tool_calls=[ToolCall(f"c{len(seen)}", "ls", {"path": "."})])

        self.assertTrue(harness.run("fix the failing test", [("fix the failing test", route)]))
        notes = [[r for r in rs if QUIET in r] for rs in seen]
        self.assertEqual([len(n) for n in notes], [0, 1, 1, 1, 2],
                         "a note after the first silent minute, none for the second, a new one after it spoke")
        messages = harness.agent.messages
        quiet = [m for m in messages if m.get("role") == "user" and QUIET in str(m.get("content"))]
        self.assertEqual(len(quiet), 2)
        for message in quiet:
            index = messages.index(message)
            self.assertEqual(messages[index - 1].get("role"), "tool", "it follows the round's tool results")
            self.assertEqual(_dgc_round(message), "reminder")
            self.assertEqual(summariser_role(message), "dgc-generated (not the user)")
        own = [str(m["content"]) for m in _real_user_turns(messages)]
        self.assertEqual(len(own), 1, "compaction still finds only the user's own words")
        self.assertTrue(own[0].startswith("fix the failing test"))
        self.assertNotIn(QUIET, own[0])

    def test_a_sub_agent_never_gets_it_even_when_due(self) -> None:
        directory = tempfile.TemporaryDirectory(prefix="dgc-quiet-child-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name))
        self.addCleanup(harness.close)
        seen = {}

        def record(name, route):
            def wrapped(messages, results, cancel):
                seen.setdefault(name, []).append(reminders_in(messages))
                return route(messages, results, cancel)
            return wrapped

        task = ToolCall("t1", "task", {"description": "look around", "prompt": "CHILD look"})
        with mock.patch.object(agent_mod, "QUIET_NOTE_AFTER_S", -1):     # always due
            self.assertTrue(harness.run("go", [("CHILD", record("child", child())),
                                               ("go", record("parent", calls_then([task])))]))
        self.assertTrue(any(QUIET in r for rs in seen["parent"] for r in rs), "the lead agent got it")
        self.assertFalse(any(QUIET in r for rs in seen["child"] for r in rs), "the sub-agent never did")


if __name__ == "__main__":
    unittest.main()
