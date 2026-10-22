"""A tool's output is a diff only when it has a diff's shape.

`split_diff` decides which `tool_result`s the editor draws as a diff card and lists in the turn's
"Edited N files" summary. It used to accept any output with a line starting `---`, so a script that
printed section headers (`--- dispatch:`, `--- invoice:`) was listed as five edited files, +0 −0
each, with an Undo for files that never existed, and its real output was hidden behind an empty
diff. Found on a real ERP session on .111 (2026-10-22).
"""
from __future__ import annotations

import difflib
import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc.subscriptions import edit_diff  # noqa: E402
from dgc.ui import split_diff            # noqa: E402


class NotADiff(unittest.TestCase):
    def test_section_headers_a_script_printed(self):
        out = ("--- pause autopilot (Delhi):\n{\"ok\": true}\n--- dispatch:\n{\"id\": 289}\n"
               "--- patch dispatch 289:\n200\n--- invoice:\n1091/2026-27\n--- issue 237:\nqueued\n")
        self.assertEqual(split_diff(out), (False, ""))

    def test_headers_with_closing_dashes(self):
        self.assertEqual(split_diff("--- dispatch: ---\nstatus 200\n--- invoice: ---\nok\n"), (False, ""))

    def test_a_markdown_rule_and_yaml_front_matter(self):
        self.assertFalse(split_diff("intro\n---\ntitle: x\n---\nbody\n")[0])

    def test_minus_and_plus_lines_without_a_hunk(self):
        self.assertFalse(split_diff("--- before\n+++ after\nno hunk header here\n")[0])


class RealDiffs(unittest.TestCase):
    def test_an_edit_tools_diff_after_its_summary_line(self):
        body = "\n".join(difflib.unified_diff(["a", "b"], ["a", "c"], "a/src/x.py", "b/src/x.py", lineterm=""))
        out = "edited src/x.py (1 replacement(s))\n" + body
        is_diff, diff = split_diff(out)
        self.assertTrue(is_diff)
        self.assertTrue(diff.startswith("--- a/src/x.py\n+++ b/src/x.py\n@@ "), diff)

    def test_a_diff_at_the_very_start(self):
        out = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new"
        self.assertEqual(split_diff(out), (True, out))

    def test_a_subscription_engines_edit(self):
        diff = edit_diff("Edit", {"file_path": "app.py", "old_string": "x = 1", "new_string": "x = 2"})
        self.assertEqual(split_diff(diff), (True, diff))

    def test_git_diff_output(self):
        out = ("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n")
        is_diff, diff = split_diff(out)
        self.assertTrue(is_diff)
        self.assertTrue(diff.startswith("--- a/x"))


if __name__ == "__main__":
    unittest.main()
