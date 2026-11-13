"""Every run of a Pip in a folder reads its box copy, your current files (0.52; pips-findings-fixes-plan.md A, B).

Seen 13 Nov on a user's machine: two scheduled Pips read committed code only, the fixes DGC made were applied but never
committed, so every evening they re-reported what was already fixed on disk. In 0.52 a Pip in a folder has its own box
with a copy of the folder (Git-listed files without what Git ignores, never .git): every run of it, scheduled ones too,
reads that copy, so its findings name the lines as they are now. And a finding is the same finding when its file and
quoted code are the same, however the model words its title that day.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from tests.test_folder_pip_box import FolderPipWorld  # noqa: E402
from dgc import pip_checkpoints, pips  # noqa: E402


class EveryRunReadsItsCopy(FolderPipWorld, unittest.TestCase):
    def setUp(self):
        super().setUp()
        # A scout, like the user's ERP audit and GST watchdog: it runs audits on a schedule.
        self.helper = self.store.create(self.workspace["id"], "ERP audit", "Audit the shop's billing code",
                                        "editor-user", pip_type="scout")

    def handed(self, kind):
        with patch.object(pips, "folder_boxes", return_value=True):
            run = self.store.enqueue(self.helper["id"], kind, "device_1", self.cfg)
            row = self.store.claim_next()
            self.assertEqual(row["id"], run["id"])
            given = {}

            class Handed(Exception):
                pass

            def payload(value):
                given.update(value)
                raise Handed()
            with patch.object(pips, "_worker_payload", side_effect=payload):
                try:
                    pips._execute_run(self.registry, row, self.cfg)
                except Handed:
                    pass
        return given

    def test_a_scheduled_style_audit_reads_the_current_files_in_its_copy(self):
        (self.root / "util.py").write_text("X = 2  # fixed, not committed\n")       # applied, never committed
        given = self.handed("audit")
        self.assertEqual(given["snapshot"], str(self.home()), "its run reads its box copy")
        self.assertIn("fixed, not committed", (self.home() / "util.py").read_text())
        self.assertEqual(given["manifest"]["own_folder"]["folder"], "projects/shop")

    def test_without_a_box_it_reads_committed_code_as_before(self):
        with patch.object(pips, "folder_boxes", return_value=False):
            run = self.store.enqueue(self.helper["id"], "audit", "device_1", self.cfg)
        manifest = run["manifest"]
        self.assertNotIn("computer", manifest)


class AFindingIsTheSameFindingWhateverItsTitle(unittest.TestCase):
    """The card's comparison: a reworded repeat is a repeat; a second issue on a line still reported is new."""
    A = {"path": "billing_routes.py", "evidence": "if not result.get(\"generated\"): raise HTTPException(500)",
         "title": "E-way generation failure raises a 500", "severity": "high", "line": 10301}

    def with_ids(self, *items):
        return [{**item, "identity": pip_checkpoints._identity(item)} for item in items]

    def test_a_reworded_title_pairs_with_the_earlier_finding(self):
        prior = self.with_ids(self.A)
        now = self.with_ids({**self.A, "title": "Unhandled e-way failure surfaces as HTTP 500", "line": 10305,
                             "evidence": "if not result.get(\"generated\"):  raise HTTPException(500) "})
        self.assertEqual(pip_checkpoints._reworded(now, prior), {0: prior[0]["identity"]})

    def test_a_second_issue_on_a_line_still_reported_is_new(self):
        prior = self.with_ids(self.A)
        now = self.with_ids(self.A, {**self.A, "title": "The e-way's failure is never logged"})
        self.assertEqual(pip_checkpoints._reworded(now, prior), {}, "the first is still reported, so the second is new")

    def test_other_code_never_pairs(self):
        prior = self.with_ids(self.A)
        now = self.with_ids({**self.A, "title": "x", "evidence": "raise HTTPException(404)"})
        self.assertEqual(pip_checkpoints._reworded(now, prior), {})


if __name__ == "__main__":
    unittest.main()
