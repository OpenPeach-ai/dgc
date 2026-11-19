"""A check's post in the Pip's own chat says what it found the way the One Pips screens draw it (0.52, Pips API 96).

The API 96 contract: under the Pip's own words
(`said`: what is wrong, why it matters, how sure it is; short messages split at a line of ---) one findings card
"2 new · 1 still there", each finding marked new, back or still (`findings[].state`) and the counts in `found`
({new, back, still}; `counts` stays the severity counts). New or still comes from the model's word (same_as) when it
gave one, else from DGC's own comparison with the last checkpoint. "Back" needs a fix's verdict (step 2): 0 here.

Real registry, real runs enqueued (with their checkpoint pin), claimed, validated and finished by PipStore.
"""
import json
import unittest
from unittest.mock import patch

from dgc import pip_run_posts as posts, pips
from tests import test_pips_local as fixtures

CONTINUITY = getattr(pips, "CONTINUITY_KEY", "_finding_continuity")
RETURN = {"title": "Returns a fixed word", "severity": "low", "path": "source.py", "line": 2,
          "evidence": "    return 'hello'"}
NAME = {"title": "Function name says nothing", "severity": "medium", "path": "source.py", "line": 1,
        "evidence": "def hello():"}


class PostFound(unittest.TestCase):
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.commit()
        guard = patch("requests.sessions.Session.request", side_effect=AssertionError("No network"))
        guard.start()
        self.addCleanup(guard.stop)
        self.job = self.store.create(self.workspace["id"], "GST watchdog", "Inspect correctness.", "device_1")

    def audit(self, key, findings, *, summary="Inspected source.py.", continuity=None):
        run = self.store.enqueue(self.job["id"], key, "device_1", self.cfg)
        self.store.claim_next()
        result = pips.validate_report(json.dumps({"summary": summary, "findings": findings, "limitations": []}),
                                      self.root, read_calls=1)
        if continuity is not None:
            result = {**result, CONTINUITY: continuity}
        self.store.finish(run["id"], result=result)
        return run["id"]

    def post(self, run_id):
        [post] = [p for p in posts.page(self.store, self.job["id"])["posts"] if p["run_id"] == run_id]
        return post

    def test_the_first_check_marks_every_finding_new_and_counts_them_in_found(self):
        post = self.post(self.audit("first", [RETURN, NAME]))
        self.assertEqual(post["found"], {"new": 2, "back": 0, "still": 0})
        self.assertEqual(sorted(f["state"] for f in post["findings"]), ["new", "new"])
        self.assertEqual(post["counts"], {"critical": 0, "high": 0, "medium": 1, "low": 1}, "counts stay severities")

    def test_the_next_check_says_still_there_from_dgcs_comparison_when_the_model_gave_no_word(self):
        self.audit("first", [RETURN])
        post = self.post(self.audit("second", [RETURN, NAME]))
        self.assertEqual(post["found"], {"new": 1, "back": 0, "still": 1})
        self.assertEqual({f["title"]: f["state"] for f in post["findings"]},
                         {"Returns a fixed word": "still", "Function name says nothing": "new"})

    def test_the_models_same_as_decides_when_it_gave_one(self):
        self.audit("first", [RETURN])
        # The model says the new wording of line 1 repeats its last checkpoint's finding 1 (it reworded it).
        post = self.post(self.audit("second", [NAME], continuity=[1]))
        self.assertEqual(post["found"], {"new": 0, "back": 0, "still": 1})
        self.assertEqual([f["state"] for f in post["findings"]], ["still"])

    def test_the_card_lists_up_to_eight_findings_and_new_ones_first(self):
        source = "\n".join(f"value_{n} = {n}" for n in range(1, 13)) + "\n"
        (self.root / "values.py").write_text(source, encoding="utf-8")
        self.git("add", "values.py")
        self.git("commit", "-qm", "values")
        many = [{"title": f"Value {n} is hard-coded", "severity": "low", "path": "values.py", "line": n,
                 "evidence": f"value_{n} = {n}"} for n in range(1, 13)]
        post = self.post(self.audit("first", many))
        self.assertEqual((post["total"], len(post["findings"])), (12, 8))

    def test_said_is_the_pips_own_words_about_what_it_found(self):
        words = "The return value is fixed, so callers never see real data.\n---\nI'm fairly sure: it's on line 2."
        post = self.post(self.audit("first", [RETURN], summary=words))
        self.assertEqual(post["said"], words)

    def test_a_clean_check_carries_no_said_and_nothing_found(self):
        post = self.post(self.audit("first", [], summary="Read source.py; nothing wrong. I could only read one file."))
        self.assertEqual(post["outcome"], "clear")
        self.assertNotIn("said", post, "a clean check says nothing of its own (flow step 4)")
        self.assertEqual(post["found"], {"new": 0, "back": 0, "still": 0})

    def test_said_never_carries_a_saved_key(self):
        secret = "sk-live-" + "9" * 24
        with patch("dgc.pip_report_delivery.secret_values", return_value=(secret,)):
            post = self.post(self.audit("first", [RETURN], summary=f"The key {secret} is in the code."))
        self.assertNotIn(secret, post["said"])

    def test_the_audit_instructions_ask_for_the_summary_as_its_own_message(self):
        instructions = pips.AUDIT_SYSTEM_INSTRUCTIONS
        self.assertIn("what is wrong, why it matters, how sure you are", instructions)
        self.assertIn("a line with only ---", instructions)


if __name__ == "__main__":
    unittest.main()
