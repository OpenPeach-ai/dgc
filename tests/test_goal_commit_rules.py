"""A goal commits each verified piece when it is asked to, and never sits on finished work (the goal soak, 16 Nov).

The soak's objective pointed at a plan whose ground rules asked for one commit per finished item. After 04:11 the
model made its own rule, "no commits until a fresh passing coverage run", and committed nothing for 10.5 hours: 78
paths uncommitted when the run ended, 237M of 304M tokens spent after the last commit. The goal rules said nothing
about committing. Now the system prompt's goal section and every goal cycle say, in DGC's own words: when the
objective or the project's own instructions ask for commits, commit each piece as soon as it is verified; never hold
finished, verified work back behind a gate the objective didn't set. They never tell the model to commit when neither
asks, and DGC itself commits nothing.
"""
import re
import unittest

from dgc import goals

OBJECTIVE = "Build everything in PLAN-2.md. Done only when every numbered item works and has passing tests."


class TheCommitRule(unittest.TestCase):
    def texts(self):
        return {"system prompt": goals.SYSTEM_GOAL_RULES, "cycle": goals.cycle_prompt(OBJECTIVE, {})}

    def test_commit_each_verified_piece_when_the_objective_or_the_project_asks(self):
        for where, text in self.texts().items():
            with self.subTest(where=where):
                self.assertIn("the objective, the user in this conversation, or the project's own instructions ask for commits",
                              " ".join(text.split()))
                self.assertIn("commit each piece as soon as it is verified", text)

    def test_never_hold_finished_work_behind_a_gate_the_objective_did_not_set(self):
        for where, text in self.texts().items():
            with self.subTest(where=where):
                self.assertIn("never hold finished, verified work back behind a gate the objective didn't set",
                              text.replace("Never hold", "never hold"))

    def test_it_never_tells_the_model_to_commit_unasked(self):
        """Every sentence that says to commit is conditional on the objective or the project asking."""
        for where, text in self.texts().items():
            for sentence in re.split(r"(?<=[.;:])\s+|\n", text):
                if re.search(r"\bcommit each\b|\bcommit it\b|\bcommit them\b|\bthen commit\b", sentence, re.I):
                    with self.subTest(where=where, sentence=sentence):
                        self.assertRegex(sentence, r"(?i)\b(when|if)\b.*\bask")
            with self.subTest(where=where, part="unasked"):
                self.assertIn("When none of them asks", text)

    def test_the_standing_reminders_are_unchanged(self):
        """The per-turn reminder stays the proof rule only: committing is said where the goal's rules are."""
        self.assertNotIn("commit", goals.REMINDER_CHECK.lower())
        self.assertNotIn("commit", goals.REMINDER_CHECK_AGAIN.lower())


if __name__ == "__main__":
    unittest.main()
