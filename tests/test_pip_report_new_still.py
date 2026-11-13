"""Pip reports say new or still there (0.52, agreed 7 Nov).

A reviewing Pip's card used to be "new" whenever its findings' exact words changed, so a model that worded the same
problems differently each evening carded every evening (a GST watchdog, every evening since 1 Nov). Now each audit is
told its last checkpoint and marks every finding with the one it repeats (same_as), or null when it is new. The card
says "1 new · 2 still there" and names the new one; a run with nothing new is not news, however it is worded.
"""
import json
import unittest
from unittest.mock import patch

from dgc import pip_report_delivery as delivery, pips
from dgc.workspace_registry import RegistryError
from tests.test_pip_report_delivery import Scene, finding

CONTINUITY = getattr(pips, "CONTINUITY_KEY", "_finding_continuity")
REWORDED = [finding("Invoice total skips the discount", "high"), finding("Tally export drops the GST number")]


class NewOrStillThere(Scene):
    def audit(self, findings, continuity=None):
        """A finished audit whose model said, by same_as, which findings repeat its last checkpoint."""
        original = self.store.finish

        def finish(run_id, *, result=None, error=None):
            if continuity is not None and result is not None:
                result = {**result, CONTINUITY: continuity}
            return original(run_id, result=result, error=error)
        with patch.object(self.store, "finish", finish):
            return self.finished(findings=findings)

    def test_the_same_findings_reworded_say_none_new_and_two_still_there(self):
        # Changed on purpose (0.52): it was "make no new card" in an attached chat. Scheduled runs no longer reach a
        # chat (pips-flow-design Q1); a run a chat asks for is always answered, and says nothing is new.
        chat = self.chat()
        self.asker = delivery.chat_identity(chat)
        self.audit([finding("Discount not applied to invoice total", "high"), finding("GST number missing in Tally export")])
        self.assertEqual(len(self.deliver(chat)), 1, "the first report is news")
        self.later(60)
        self.audit(REWORDED, [1, 2])
        [card] = self.deliver(chat)
        self.assertEqual((card["new"], card["still"], card["total"]), (0, 2, 2))

    def test_one_new_finding_says_one_new_and_names_it(self):
        chat = self.chat()
        self.asker = delivery.chat_identity(chat)      # 0.52: the chat that ran it (was an attached chat)
        self.audit([finding("Discount not applied to invoice total", "high"), finding("GST number missing in Tally export")])
        self.deliver(chat)
        self.later(60)
        self.audit([*REWORDED, finding("E-way bill valid-upto dropped on re-pull", "medium")], [1, 2, None])
        [card] = self.deliver(chat)
        self.assertEqual((card["new"], card["still"], card["total"]), (1, 2, 3))
        self.assertEqual(card["findings"][0]["title"], "E-way bill valid-upto dropped on re-pull", "the new one first")
        self.assertIs(card["findings"][0]["new"], True)
        self.assertIs(card["findings"][1]["new"], False)

    def test_without_its_word_the_card_counts_as_before(self):
        chat = self.chat()
        self.asker = delivery.chat_identity(chat)      # 0.52: the chat that ran it (was an attached chat)
        self.audit([finding("Discount not applied to invoice total", "high")])
        self.deliver(chat)
        self.later(60)
        self.audit([finding("Invoice total skips the discount", "high")])
        [card] = self.deliver(chat)
        self.assertNotIn("new", card, "a model that didn't say: the old words-based rule")

    def test_a_record_that_does_not_name_each_finding_is_dropped(self):
        run_id = self.audit(REWORDED, [1])
        self.assertIsNone(getattr(delivery, "continuity_of", lambda *a: "missing")(self.registry.db, run_id, 2))


class TheModelIsAsked(unittest.TestCase):
    def test_validate_report_takes_same_as_and_carries_it_beside_the_result(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as folder:
            snapshot = Path(folder)
            (snapshot / "app").mkdir()
            (snapshot / "app" / "billing.py").write_text("x = 1\nreturn total\n")
            base = {"title": "Total skips the discount", "severity": "high", "path": "app/billing.py", "line": 2,
                    "evidence": "return total"}
            said = pips.validate_report(json.dumps({"summary": "s", "findings": [{**base, "same_as": 1},
                                                                                   {**base, "title": "New one", "same_as": None}],
                                                    "limitations": []}), snapshot, read_calls=1)
            self.assertEqual(said[CONTINUITY], [1, None])
            self.assertEqual(set(said["findings"][0]), {"title", "severity", "path", "line", "evidence", "verification"},
                             "the findings keep their shape")
            plain = pips.validate_report(json.dumps({"summary": "s", "findings": [base], "limitations": []}), snapshot,
                                         read_calls=1)
            self.assertNotIn(CONTINUITY, plain)
            with self.assertRaises(RegistryError):
                pips.validate_report(json.dumps({"summary": "s", "findings": [{**base, "same_as": "1"}], "limitations": []}),
                                     snapshot, read_calls=1)


if __name__ == "__main__":
    unittest.main()
