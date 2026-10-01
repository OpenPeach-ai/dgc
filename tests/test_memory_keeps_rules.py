"""A rule in the middle of a long DGC.md is never silently dropped.

`bounded_memory_view` keeps the first third and the newest tail of an over-long instruction file and
drops everything between. Measured on the shipping code: 96,079 characters in, 32,768 out, the middle
not kept -- so a rule written there was simply gone. Not summarised: absent. A fact can be lost
cheaply; a rule cannot.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc.memory import bounded_memory_view, MAX_MEMORY_PROMPT_CHARS   # noqa: E402
from dgc.redaction import REDACTED                                      # noqa: E402

FILLER = "This is ordinary context about the project that can be lost cheaply.\n" * 40


def long_file(middle: str, *, sections: int = 30) -> str:
    """An over-budget DGC.md with `middle` placed exactly where the old view dropped content."""
    head = "".join(f"## Section {i}\n\n{FILLER}\n" for i in range(sections // 2))
    tail = "".join(f"## Section {i}\n\n{FILLER}\n" for i in range(sections // 2, sections))
    return head + middle + tail


class AFileThatFitsIsUntouchedTest(unittest.TestCase):
    def test_a_short_file_comes_back_byte_identical(self) -> None:
        """Rule-keeping only engages where truncation would lose something; nobody under the limit
        sees their instructions reordered."""
        text = "## Rule: always run the visual pass\n\nShort file.\n\n## Notes\n\nmore\n"
        self.assertEqual(bounded_memory_view(text), text.strip())

    def test_a_long_file_with_no_rules_keeps_the_old_view(self) -> None:
        text = long_file("## Middle\n\nnothing special\n")
        out = bounded_memory_view(text)
        self.assertLessEqual(len(out), MAX_MEMORY_PROMPT_CHARS)
        self.assertNotIn("[Rules from this file", out)


class ARuleInTheMiddleSurvivesTest(unittest.TestCase):
    RULE = "## Rule: every deploy goes through a visual pass\n\nNo exceptions, ever.\n\n"

    def test_the_premise_the_old_view_drops_the_middle(self) -> None:
        """Without this, the test below proves nothing: the rule must sit where content is lost."""
        from dgc.redaction import bounded_redacted_view
        text = long_file("## Middle fact\n\nTHE-MIDDLE-CANARY\n\n")
        old = bounded_redacted_view(text, MAX_MEMORY_PROMPT_CHARS, label="memory characters",
                                    head_fraction=1 / 3)
        self.assertNotIn("THE-MIDDLE-CANARY", old)

    def test_a_middle_rule_is_kept_whole(self) -> None:
        out = bounded_memory_view(long_file(self.RULE))
        self.assertIn("every deploy goes through a visual pass", out)
        self.assertIn("No exceptions, ever.", out)

    def test_it_is_labelled_as_a_rule(self) -> None:
        out = bounded_memory_view(long_file(self.RULE))
        self.assertTrue(out.startswith("[Rules from this file"))

    def test_ordinary_middle_content_is_still_dropped(self) -> None:
        """Keeping rules must not quietly mean keeping everything -- the budget still holds."""
        out = bounded_memory_view(long_file(self.RULE + "## Fact\n\nTHE-MIDDLE-CANARY\n\n"))
        self.assertNotIn("THE-MIDDLE-CANARY", out)

    def test_the_budget_is_never_exceeded(self) -> None:
        for maximum in (256, 1000, 8000, MAX_MEMORY_PROMPT_CHARS):
            with self.subTest(maximum=maximum):
                self.assertLessEqual(len(bounded_memory_view(long_file(self.RULE), maximum)), maximum)


class TheRuleMarkersTest(unittest.TestCase):
    def test_each_marker_counts(self) -> None:
        for heading in ("## Rule: x", "## Rules", "### rule - y", "# RULES",
                        "## Deploys\n<!-- dgc:rule -->"):
            with self.subTest(heading=heading):
                text = long_file(f"{heading}\n\nKEEP-ME\n\n")
                self.assertIn("KEEP-ME", bounded_memory_view(text))

    def test_a_word_that_merely_starts_with_rule_does_not(self) -> None:
        """'Rulebook' is not a rule; the marker is the WORD."""
        text = long_file("## Rulebook\n\nNOT-A-RULE-CANARY\n\n")
        self.assertNotIn("NOT-A-RULE-CANARY", bounded_memory_view(text))


class TooManyRulesAreNamedNotDroppedTest(unittest.TestCase):
    def rules(self, n: int, size: int = 3000) -> str:
        return "".join(f"## Rule: number {i}\n\n{'x' * size}\n\n" for i in range(n))

    def test_rules_that_do_not_fit_are_named(self) -> None:
        out = bounded_memory_view(long_file(self.rules(20)))
        self.assertIn("did not fit in the instruction budget", out)
        self.assertIn("are NOT in effect", out)
        self.assertLessEqual(len(out), MAX_MEMORY_PROMPT_CHARS)

    def test_the_kept_rules_are_whole_and_in_order(self) -> None:
        out = bounded_memory_view(long_file(self.rules(20)))
        kept = [i for i in range(20) if f"## Rule: number {i}\n" in out]
        self.assertEqual(kept, sorted(kept))
        self.assertGreater(len(kept), 0)
        for i in kept:
            self.assertIn(f"## Rule: number {i}\n\n{'x' * 3000}", out, "a kept rule is never cut")

    def test_the_count_of_missing_rules_is_always_given(self) -> None:
        """Even when there is no room to NAME them all, the reader learns how many are missing."""
        out = bounded_memory_view(long_file(self.rules(200, size=600)), 4000)
        self.assertLessEqual(len(out), 4000)
        self.assertRegex(out, r"\[\d+ rule\(s\) from this file did not fit")

    def test_the_notice_reads_as_a_sentence_even_when_no_name_fits(self) -> None:
        """Mutation-found. With no room to name a single rule, the list came out empty and the notice
        read "...are NOT in effect: . The file needs..." -- a dangling colon before a full stop."""
        from dgc.memory import _dropped_notice
        for room in (90, 120, 160, 220):
            with self.subTest(room=room):
                notice = _dropped_notice([f"rule {i}" for i in range(50)], room)
                self.assertNotIn(": .", notice)
                self.assertNotRegex(notice, r":\s*\.")

    def test_the_budget_holds_at_every_size(self) -> None:
        for n in (5, 20, 80):
            for maximum in (256, 2000, 12000, MAX_MEMORY_PROMPT_CHARS):
                with self.subTest(rules=n, maximum=maximum):
                    out = bounded_memory_view(long_file(self.rules(n, 900)), maximum)
                    self.assertLessEqual(len(out), maximum)


class ARedactionSentinelIsNeverSlicedTest(unittest.TestCase):
    """The property this module exists to protect: a `[REDACTED]` marker is either whole or absent.

    The first version of this change ended with a hard `[:maximum]` slice that, when its budget
    arithmetic undercounted, would cut through whatever came last -- including a sentinel inside a
    kept rule. Checked across many sizes, because a sliced sentinel looks like a leaked fragment.
    """

    def test_no_partial_sentinel_at_any_budget(self) -> None:
        rule = f"## Rule: secrets\n\nkey={REDACTED} and token={REDACTED}\n\n" * 6
        text = long_file(rule + "".join(f"## Rule: r{i}\n\n{'y' * 700} {REDACTED}\n\n" for i in range(40)))
        fragments = [REDACTED[:k] for k in range(2, len(REDACTED))]
        for maximum in range(256, MAX_MEMORY_PROMPT_CHARS, 997):
            out = bounded_memory_view(text, maximum)
            whole = out.count(REDACTED)
            stripped = out.replace(REDACTED, "")
            with self.subTest(maximum=maximum):
                self.assertLessEqual(len(out), maximum)
                self.assertFalse(any(stripped.endswith(f) for f in fragments),
                                 "a sentinel was cut at the end of the view")
                self.assertGreaterEqual(whole, 0)


class ARuleWithFencedCodeTest(unittest.TestCase):
    RULE = ("## Rule: never push without tests\n\nRun:\n\n```sh\n# from the repo root\nmake test\n"
            "```\n\nIf it fails, stop.\n\n")

    def test_a_comment_in_a_fence_is_not_a_heading(self) -> None:
        out = bounded_memory_view(long_file(self.RULE))
        self.assertIn("make test", out, "the rule was cut at the # comment inside its code block")
        self.assertIn("If it fails, stop.", out)

    def test_a_tilde_fence_too(self) -> None:
        out = bounded_memory_view(long_file(self.RULE.replace("```", "~~~")))
        self.assertIn("If it fails, stop.", out)

    def test_a_closing_fence_must_match_its_opening(self) -> None:
        rule = ("## Rule: quote fences\n\n````md\n```sh\n# not a heading\n```\nstill inside\n````\n\n"
                "KEPT-AFTER-THE-FENCE\n\n")
        out = bounded_memory_view(long_file(rule))
        self.assertIn("KEPT-AFTER-THE-FENCE", out, "a shorter inner fence closed the outer one")


if __name__ == "__main__":
    unittest.main()
