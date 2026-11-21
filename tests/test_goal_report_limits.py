"""A goal's completion report is never refused for its length (his 21 Nov session: a 61-item goal's report was turned
away again and again with "include a concise summary and a nonempty evidence list", and the model called it a
validation error): more than 12 evidence lines fold into the twelfth, a long line or summary is trimmed, and only an
empty or malformed report is refused, saying exactly what is wrong."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc.goals import clean_report, report_problem  # noqa: E402


class LongReports(unittest.TestCase):
    def report(self, **changes):
        value = {"status": "completed", "summary": "Built the dashboard.", "evidence": ["Ports 5173 and 4173 answer 200."]}
        value.update(changes)
        return value

    def test_sixty_one_lines_are_kept_folded_into_twelve(self):
        lines = [f"Checklist item {n}: verified in Chromium" for n in range(1, 62)]
        got = clean_report(self.report(evidence=lines))
        self.assertIsNotNone(got)
        self.assertEqual(len(got["evidence"]), 12)
        self.assertEqual(got["evidence"][:11], lines[:11])
        self.assertTrue(got["evidence"][11].startswith("Checklist item 12"), got["evidence"][11][:80])
        self.assertIn("and 49 more", got["evidence"][11])
        self.assertLessEqual(len(got["evidence"][11]), 1000)

    def test_a_long_line_and_a_long_summary_are_trimmed(self):
        got = clean_report(self.report(summary="s" * 5000, evidence=["e" * 3000]))
        self.assertEqual(len(got["summary"]), 2000)
        self.assertEqual(len(got["evidence"][0]), 1000)

    def test_only_an_empty_or_malformed_report_is_refused_and_it_says_why(self):
        for bad, why in ((self.report(evidence=[]), "evidence"), (self.report(summary="  "), "summary"),
                         (self.report(evidence="all good"), "list"), (self.report(evidence=[3, None]), "text")):
            with self.subTest(why=why):
                self.assertIsNone(clean_report(bad))
                self.assertIn(why, report_problem(bad))
        self.assertEqual(report_problem(self.report()), "")


if __name__ == "__main__":
    unittest.main()
