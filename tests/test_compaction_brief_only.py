"""A compaction keeps the summariser's brief, never its thinking (found by the goal soak, 16 Nov).

On kimi-k3.1-pro the second compaction's brief was mostly the summariser's own reasoning: it opened "I need produce
compact brief exactly headings…", guessed at things, and repeated one failed git line four times. The check only asked
that its three main headings appear somewhere, and thinking that names the headings passes that. Now the
brief is taken from its real first heading ("## The ask") on (headings at the start of a line, in order); anything before it, and
any <think> block, is dropped; a reply with no such brief is not used (the mechanical summary stands in, as before)."""
from __future__ import annotations

import time
import types
import unittest

from dgc.agent import _brief_only
from tests import test_compaction_keeps_the_ask as fixtures

BRIEF = "## The ask\n- Build everything in PLAN-2.md.\n## Done so far\n- Items 1–9 committed.\n## Next step\n- Item 10."
THINKING = ("I need produce compact brief exactly headings ## The ask ## Done so far ## Next step. The plan items are probably "
            "26-47. git commit failed. git commit failed. Let me write it.\n\n")


class BriefOnly(unittest.TestCase):
    def test_the_brief_from_its_goal_heading_on(self):
        self.assertEqual(_brief_only(THINKING + BRIEF), BRIEF)
        self.assertEqual(_brief_only("<think>headings first ## The ask</think>\n" + BRIEF), BRIEF)
        self.assertEqual(_brief_only(BRIEF), BRIEF)

    def test_thinking_that_only_names_the_headings_is_no_brief(self):
        self.assertEqual(_brief_only(THINKING), "")
        self.assertEqual(_brief_only("## The ask\n- x\n## Next step\n- y\n## Done so far\n- z"), "", "headings out of order")


class InACompaction(unittest.TestCase):
    setUp = fixtures.TheAskSurvivesEveryCompactionTest.setUp
    tearDown = fixtures.TheAskSurvivesEveryCompactionTest.tearDown
    agent = fixtures.TheAskSurvivesEveryCompactionTest.agent

    def compact_with(self, content):
        agent = self.agent()
        reply = types.SimpleNamespace(content=content, tool_calls=None, usage=None)
        agent._aux_client = lambda *a, **k: types.SimpleNamespace(chat=lambda *a, **k: reply)
        agent.messages.append({"role": "user", "content": fixtures.ASK})
        agent.messages += fixtures.steps(0, 40)
        self.assertTrue(agent.maybe_compact(deadline=time.monotonic() + 30, notify=False))
        return agent.messages[1]["content"]

    def test_the_kept_brief_has_no_thinking_in_it(self):
        kept = self.compact_with(THINKING + BRIEF)
        self.assertIn("- Items 1–9 committed.", kept)
        self.assertNotIn("I need produce", kept)
        self.assertNotIn("git commit failed", kept)

    def test_a_reply_that_is_only_thinking_is_not_used(self):
        kept = self.compact_with(THINKING)
        self.assertNotIn("I need produce", kept)


if __name__ == "__main__":
    unittest.main()
