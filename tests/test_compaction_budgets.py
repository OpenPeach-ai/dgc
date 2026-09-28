"""The summariser must be able to read the transcript it is summarising.

A live session on a 1,048,576-token window compacted and came back working on something the user
had never asked for in that session. Asked "when and what did i ask about this?", the model answered
that the request "only appears inside the compacted summary" -- which was true, and is the bug.

`source_limit` was `max(4_000, min(60_000, context_size * 2))`. `context_size()` returns TOKENS;
`_bounded_head_tail` spends the number as CHARACTERS; and the 60,000 ceiling binds for every window
above ~30k tokens. So on that session the summariser read 60,000 characters -- about 1.68% -- of an
891,289-token transcript: 20,106 characters of head, 30,159 of tail, and the whole middle thrown
away before any model saw it. The early user asks were in the discarded middle. What survived was
the recent tail, which in a sub-agent run is tool output. The summariser was then asked, under the
heading "## Goal -- what the user ultimately wants", to say what the user wanted.

These tests pin the two properties that failure violated: the budget is derived from the window
rather than capped flat, and on a real window the summariser sees the whole transcript.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc.agent import (COMPACT_THRESHOLD, _COMPACT_CHARS_PER_TOKEN,   # noqa: E402
                       _bounded_head_tail, _compaction_source, compaction_budgets)

# The window the incident happened on.
INCIDENT_WINDOW = 1_048_576


def transcript_chars(window: int) -> int:
    """Roughly how many characters a transcript holds when compaction fires."""
    return int(window * COMPACT_THRESHOLD) * _COMPACT_CHARS_PER_TOKEN


class TheSummariserCanReadTheTranscriptTest(unittest.TestCase):
    def test_the_incident_window_now_shows_the_whole_transcript(self) -> None:
        source_chars, _brief_tokens, _brief_chars = compaction_budgets(INCIDENT_WINDOW)
        self.assertGreaterEqual(
            source_chars, transcript_chars(INCIDENT_WINDOW),
            "on a 1M window the summariser must see the whole transcript it is summarising; the "
            "old formula showed it 60,000 characters of ~3.5M")

    def test_the_source_budget_scales_with_the_window(self) -> None:
        windows = [32_768, 65_536, 131_072, 262_144, 1_048_576]
        budgets = [compaction_budgets(w)[0] for w in windows]
        self.assertEqual(budgets, sorted(budgets),
                         "a bigger window must not buy a smaller view of the transcript")
        self.assertGreater(budgets[-1], budgets[0] * 8,
                           "a 32x window with a flat ceiling is the defect this pins")

    def test_the_brief_scales_too(self) -> None:
        small = compaction_budgets(32_768)[1]
        large = compaction_budgets(INCIDENT_WINDOW)[1]
        self.assertGreater(large, small,
                           "3,500 tokens for an 891k-token transcript is a 250:1 squeeze")
        self.assertLessEqual(large, 32_000, "the brief is carried on every later turn; bound it")

    def test_the_request_still_fits_inside_the_window(self) -> None:
        """A budget that overflows the window would trade this bug for a failed compaction."""
        for window in (8_192, 32_768, 65_536, 1_048_576):
            source_chars, brief_tokens, _ = compaction_budgets(window)
            total = source_chars // _COMPACT_CHARS_PER_TOKEN + brief_tokens
            self.assertLessEqual(total, window,
                                 f"source+output must fit in {window}; got {total}")

    def test_a_tiny_window_still_gets_a_usable_floor(self) -> None:
        source_chars, brief_tokens, brief_chars = compaction_budgets(2_048)
        self.assertGreaterEqual(source_chars, 2_000 * _COMPACT_CHARS_PER_TOKEN)
        self.assertGreaterEqual(brief_tokens, 1)
        self.assertGreater(brief_chars, 0)


class WhatTheSummariserActuallyReceivesTest(unittest.TestCase):
    """The budget is only real if `_compaction_source` spends it on the transcript."""

    def test_a_real_sized_transcript_survives_end_to_end(self) -> None:
        source_chars, _bt, _bc = compaction_budgets(INCIDENT_WINDOW)
        # One line per turn, sized so the whole thing is what a 1M window holds at 0.85.
        line = "user: please fix the invoice Bags column on the ERP\n" + ("x" * 900)
        lines = [line] * (transcript_chars(INCIDENT_WINDOW) // len(line))
        built = _compaction_source("", lines, source_chars)
        self.assertNotIn("chars omitted during compaction", built,
                         "the transcript that fits in the window must reach the summariser whole")

    def test_the_marker_still_appears_when_a_transcript_genuinely_overflows(self) -> None:
        source_chars, _bt, _bc = compaction_budgets(32_768)
        huge = ["y" * (source_chars * 3)]
        built = _compaction_source("", huge, source_chars)
        self.assertIn("chars omitted during compaction", built,
                      "the bound must remain a real backstop, not be removed")
        self.assertLessEqual(len(built), source_chars + 200)

    def test_head_and_tail_are_both_kept_when_it_does_overflow(self) -> None:
        text = "HEAD" + "m" * 50_000 + "TAIL"
        bounded = _bounded_head_tail(text, 2_000)
        self.assertTrue(bounded.startswith("HEAD"))
        self.assertTrue(bounded.endswith("TAIL"))


if __name__ == "__main__":
    unittest.main()


class OnlyTheUserIsLabelledUserTest(unittest.TestCase):
    """The summariser is asked what the USER wants, so everything else must say it is not the user.

    In the live incident a sub-agent's completion summary -- role `tool`, prose reading exactly like
    a statement of intent -- was carried into the brief as an active user request. DGC already
    rewrote two roles to stop precisely this, with comments reading "Never 'user'", and then passed
    `tool` and `assistant` through bare.
    """

    def test_only_a_real_user_message_gets_the_bare_label(self) -> None:
        from dgc.agent import _COMPACT_PREFIX, summariser_role
        self.assertEqual(summariser_role({"role": "user", "content": "fix the Bags column"}), "user")
        for message in (
                {"role": "tool", "content": "Sub-task 'Build components' completed"},
                {"role": "assistant", "content": "I will add a badge"},
                {"role": "system", "content": "config"},
                {"role": "weird", "content": "?"},
                {"role": "user", "content": "relayed", "_dgc_steering": ["x"]},
                {"role": "user", "content": _COMPACT_PREFIX + "\n## Goal\n- old thing"}):
            label = summariser_role(message)
            self.assertNotEqual(label, "user", f"{message.get('role')} must not read as the user")
            self.assertIn("not the user", label,
                          f"the label must SAY it is not the user, got {label!r}")

    def test_the_prompt_forbids_inferring_a_goal_from_anything_else(self) -> None:
        import inspect
        from dgc.agent import Agent
        source = inspect.getsource(Agent._compact)
        self.assertIn("ONLY lines labelled `user:` are the user speaking", source)
        self.assertIn("NOTES FOR THE NEXT MODEL", source,
                      "the brief must be framed as notes, not as the user talking")


class TheUsersOwnWordsSurviveTest(unittest.TestCase):
    """Compaction used to guarantee nothing the user wrote."""

    def test_a_tool_loop_tail_keeps_no_user_turn_which_is_why_retention_exists(self) -> None:
        from dgc.agent import KEEP_RECENT, _compaction_split_index
        messages = [{"role": "system", "content": "sys"},
                    {"role": "user", "content": "THE REAL ASK"}]
        for i in range(12):
            messages.append({"role": "assistant",
                             "tool_calls": [{"id": f"c{i}",
                                             "function": {"name": "bash", "arguments": "{}"}}]})
            messages.append({"role": "tool", "tool_call_id": f"c{i}", "content": f"out {i}"})
        for keep in (KEEP_RECENT, 2):
            tail = messages[_compaction_split_index(messages, keep):]
            self.assertEqual([m for m in tail if m.get("role") == "user"], [],
                             "this is the measured hole: the kept tail can hold zero user turns")

    def test_real_user_turns_are_retained_newest_first_in_original_order(self) -> None:
        from dgc.agent import _retain_user_turns
        messages = [{"role": "user", "content": "A" * 100},
                    {"role": "assistant", "content": "ok"},
                    {"role": "user", "content": "B" * 100},
                    {"role": "tool", "content": "sub-task completed: add a badge"},
                    {"role": "user", "content": "C" * 100}]
        kept = _retain_user_turns(messages, 10_000)
        self.assertEqual([m["content"][0] for m in kept], ["A", "B", "C"],
                         "order must read forwards")
        tight = _retain_user_turns(messages, 150)
        self.assertEqual([m["content"][0] for m in tight], ["C"],
                         "under pressure the most recent intent is the one that must survive")

    def test_dgc_authored_user_role_messages_are_never_retained_as_the_user(self) -> None:
        from dgc.agent import _COMPACT_PREFIX, _retain_user_turns
        messages = [{"role": "user", "content": "real ask"},
                    {"role": "user", "content": "steered", "_dgc_steering": ["s"]},
                    {"role": "user", "content": _COMPACT_PREFIX + "\n## Goal\n- stale"}]
        kept = _retain_user_turns(messages, 10_000)
        self.assertEqual([m["content"] for m in kept], ["real ask"],
                         "a prior brief carried forward as a user turn is the bug, not the fix")

    def test_the_injected_brief_says_it_is_not_the_user(self) -> None:
        from dgc.agent import _COMPACT_ENVELOPE, _COMPACT_PREFIX
        self.assertIn("NOT a message from the user", _COMPACT_ENVELOPE)
        self.assertEqual(_COMPACT_PREFIX, "[Earlier conversation compacted to this summary]",
                         "saved sessions are matched by this prefix; changing it orphans every "
                         "existing brief, which would then be re-fed as fresh transcript")

    def test_compact_actually_installs_the_retained_turns(self) -> None:
        """A helper nothing calls is not a fix. Both reconstruction paths must carry the block."""
        import inspect
        from dgc.agent import Agent
        source = inspect.getsource(Agent._compact)
        self.assertIn("retained_users = _retained_user_block(", source)
        rebuilds = source.split("self.messages = (")[1:]
        self.assertGreaterEqual(len(rebuilds), 2,
                                "there is a provider-native path and a local one; fixing one and "
                                "not the other fixes nothing for half the users")
        for i, rebuild in enumerate(rebuilds):
            head = rebuild.split("_repair_tool_transcript")[0]
            self.assertIn("retained_users", head,
                          f"reconstruction #{i} drops the user's own words")
            self.assertIn("_COMPACT_ENVELOPE", head,
                          f"reconstruction #{i} injects the brief without saying it is not the user")

    def test_the_block_reads_as_a_quote_not_as_a_new_request(self) -> None:
        from dgc.agent import _retained_user_block
        block = _retained_user_block([{"role": "user", "content": "fix the Bags column"}], 10_000)
        self.assertIn("fix the Bags column", block)
        self.assertIn("not re-sent as new requests", block,
                      "the whole defect was machine text read as a fresh user request")
        self.assertIn("these win", block,
                      "the user's words must outrank the brief's reconstruction of them")

    def test_an_empty_block_when_there_is_nothing_of_the_users_to_quote(self) -> None:
        from dgc.agent import _retained_user_block
        self.assertEqual(_retained_user_block([{"role": "tool", "content": "done"}], 10_000), "")

    def test_the_block_is_text_carried_inside_the_brief_not_extra_messages(self) -> None:
        """Splicing real messages in moved every image anchor and a rewind then dropped a record.

        Measured: four retained turns moved anchors 3 -> 8, and `test_image_views` lost b.png. The
        brief carries the words instead, so the compacted transcript keeps its exact shape --
        [system, brief, ack] + kept tail -- and every image anchor still lands where it did.
        `tests/test_image_views.py::CompactionAnchorTests` is the behavioural proof; this pins the
        return type that keeps it true.
        """
        from dgc.agent import _retained_user_block
        block = _retained_user_block([{"role": "user", "content": "the real ask"}], 10_000)
        self.assertIsInstance(block, str,
                              "a list here would mean messages are being spliced into the "
                              "transcript again, which is what moved the image anchors")
        self.assertTrue(block.startswith("\n\n##"),
                        "it has to append cleanly to the brief's own markdown")

    def test_the_brief_never_claims_more_than_a_quarter_of_any_window(self) -> None:
        """A floor that outranks the cap is not a cap. At 2,048 tokens an earlier version of this
        clamp handed the brief 1,000 of them -- 49% of the context compaction exists to free."""
        for window in (2_048, 4_000, 8_192, 32_768, 65_536, 262_144, 1_048_576):
            _source, brief_tokens, _chars = compaction_budgets(window)
            self.assertLessEqual(brief_tokens, window // 4,
                                 f"window {window}: brief of {brief_tokens} exceeds a quarter")
            self.assertGreaterEqual(brief_tokens, 1)
