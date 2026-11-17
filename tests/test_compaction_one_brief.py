"""A compaction brief carries one earlier brief, and keeps the user's rules apart from the model's own choices.

Found by the goal soak (16 Nov):
  (a) When no model could write the brief, DGC's fallback wrapped the whole earlier brief inside itself, envelope,
      quoted user words and all; the next fallback wrapped that one, so at 03:36 and 05:10 the brief opened with three
      "Earlier brief (merge this in)" sections nested inside each other, the same envelope repeated at every level.
      It still did at 05dd1ea7. Now a fallback carries ONE brief, the latest one a model wrote, and the evidence the
      fallbacks since then kept, flat; the envelope and the user's quoted words are written once, by the message.
  (b) The model's own decisions became "Constraints" ("Do not skip legacy timing tests under coverage; reduce tracing
      overhead instead"), and later turns obeyed them as the user's rules. The summariser is now told that rules are
      the user's alone and that the assistant's decisions are its own choices, which a later turn may revisit.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dgc import agent as agent_mod                                       # noqa: E402
from dgc.agent import (_COMPACT_ENVELOPE, _COMPACT_PREFIX, _mechanical_compaction_brief,  # noqa: E402
                       _retained_user_block)

MODEL_BRIEF = ("## The ask\n- Build everything in PLAN-2.md.\n## Rules to keep\n- Python 3.12 standard library only.\n"
               "## Done so far\n- MODEL-BRIEF-ITEMS-1-TO-24 committed.\n## Next step\n- Item 25.")
USER_WORDS = [{"role": "user", "content": "Build everything in PLAN-2.md. Done only when every item works."}]
NEST = "### Earlier brief (merge this in)"


def message_for(brief: str) -> str:
    """The compacted message DGC writes, as Agent._compact builds it."""
    return f"{_COMPACT_PREFIX}\n{_COMPACT_ENVELOPE}\n{brief}{_retained_user_block(USER_WORDS, 10_000)}"


def old_fallback(prior: str, lines: list[str]) -> str:
    """The no-model brief as 05dd1ea7 wrote it: the whole earlier message's text under "Earlier brief"."""
    return ("## The ask\n- Find what the user wants in the earlier notes or the first user line below.\n"
            "## Rules to keep\n- Keep every rule the user stated in the evidence below.\n"
            "## Done so far\n" + agent_mod._compaction_source(prior, lines, 19_300) + "\n"
            "## Next step\n- Carry on from the user's own words that follow these notes.\n"
            "## Exact details\n- Written without a model (none was available, or its notes couldn't be used): check "
            "anything uncertain against the files.\n")


def prior_of(content: str) -> str:
    """What the next compaction reads back as the earlier brief (Agent._compact)."""
    return content.split("\n", 1)[-1]


class TheFallbackCarriesOneBrief(unittest.TestCase):
    def chain(self, steps: int) -> str:
        content = message_for(MODEL_BRIEF)
        for n in range(1, steps + 1):
            brief = _mechanical_compaction_brief(prior_of(content), [f"assistant: EVIDENCE-{n} did step {n}"],
                                                 20_000, quoted_carried=True)
            content = message_for(brief)
        return brief

    def test_three_fallbacks_in_a_row_hold_one_earlier_brief(self):
        brief = self.chain(3)
        self.assertEqual(brief.count(NEST), 1, brief)
        self.assertNotIn(_COMPACT_ENVELOPE, brief, "the message writes the envelope once, outside the brief")
        self.assertNotIn("The user's own messages, verbatim", brief, "the message quotes them once, outside it")
        self.assertEqual(brief.count("Find what the user wants in the earlier notes"), 1)

    def test_the_latest_model_brief_and_every_fallbacks_evidence_survive(self):
        brief = self.chain(3)
        self.assertIn("MODEL-BRIEF-ITEMS-1-TO-24", brief)
        for n in (1, 2, 3):
            with self.subTest(step=n):
                self.assertIn(f"EVIDENCE-{n}", brief)
        self.assertLess(brief.index("EVIDENCE-1"), brief.index("EVIDENCE-3"), "oldest evidence first")

    def test_the_soaks_already_nested_brief_is_flattened(self):
        """A session saved by an earlier build already holds the nested shape: the next fallback flattens it."""
        content = message_for(MODEL_BRIEF)
        for n in (1, 2, 3):        # the old way: the whole message, envelope and quoted words, inside the next one
            content = message_for(old_fallback(prior_of(content), [f"assistant: OLD-{n}"]))
        self.assertGreaterEqual(prior_of(content).count(NEST), 2, "premise: the nested shape")
        brief = _mechanical_compaction_brief(prior_of(content), ["assistant: NEW"], 20_000, quoted_carried=True)
        self.assertEqual(brief.count(NEST), 1, brief)
        self.assertNotIn(_COMPACT_ENVELOPE, brief)
        for marker in ("MODEL-BRIEF-ITEMS-1-TO-24", "OLD-1", "OLD-3", "NEW"):
            with self.subTest(marker=marker):
                self.assertIn(marker, brief)

    def test_without_the_quoted_words_carried_they_stay_in_the_brief(self):
        """An old session whose brief has no saved copy of the user's words keeps the only copy there is."""
        brief = _mechanical_compaction_brief(prior_of(message_for(MODEL_BRIEF)), ["assistant: x"], 20_000)
        self.assertIn("Build everything in PLAN-2.md. Done only when every item works.", brief)


class TheSummariserKeepsRulesAndChoicesApart(unittest.TestCase):
    def prompt(self) -> str:
        from test_subagents import Harness
        directory = tempfile.TemporaryDirectory(prefix="dgc-compaction-brief-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name))
        self.addCleanup(harness.close)
        agent = harness.agent
        agent.messages = [{"role": "system", "content": "system"}] + [
            {"role": "user" if i % 2 == 0 else "assistant", "content": f"entry-{i} " + "x" * 400} for i in range(20)]
        seen = []

        class Summariser:
            def chat(self, messages, **kwargs):
                seen.append(messages[0]["content"])
                raise RuntimeError("no summary in this test")
        agent._aux_client = lambda **kwargs: Summariser()
        agent.maybe_compact(force=True)
        self.assertTrue(seen, "premise: the summariser was asked")
        return seen[0]

    def test_rules_are_the_users_alone(self):
        prompt = self.prompt()
        self.assertIn("## Rules to keep — only what the user said", prompt)
        self.assertIn("never a rule the assistant or a helper made for itself", prompt)

    def test_decisions_are_the_assistants_own_choices_a_later_turn_may_revisit(self):
        prompt = self.prompt()
        self.assertIn("## Choices and why — what the assistant decided along the way", prompt)
        self.assertIn("as its own choice", prompt)
        self.assertIn("a later turn may revisit it", prompt)

    def test_the_no_model_brief_says_the_same(self):
        brief = _mechanical_compaction_brief("", ["user: keep it small", "assistant: chose sqlite"], 20_000)
        self.assertIn("choices the assistant made there are its own", brief)


if __name__ == "__main__":
    unittest.main()
