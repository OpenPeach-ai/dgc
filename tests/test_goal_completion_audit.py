"""A goal ends only when its completion is proved (asked 12 Nov).

His ERP audit goal ("each and every unit, everything, all end point connections") ended itself after 46 minutes on a
plausible summary. The rules: prove every
requirement against current evidence before calling it done (unsure is not done), never a narrower task, a check of
whether the last turn moved anything, and a three-turn rule before "blocked". DGC's goal cycle, its standing reminder,
the system prompt's goal section and update_goal's description carry them, in DGC's own words (16 Nov: "learn from it
and build our own ... so it does not look exact copied text from codex").
"""
import unittest

from dgc import goals
from dgc.tools import TOOL_SCHEMAS as TOOLS

OBJECTIVE = "Audit every unit of the ERP: every endpoint, every link, every feature's wiring."


def update_goal_tool() -> dict:
    return next(t for t in TOOLS if t.get("function", {}).get("name") == "update_goal")["function"]


class CyclePrompt(unittest.TestCase):
    def test_it_starts_with_the_marker_and_carries_the_objective_as_data(self):
        text = goals.cycle_prompt(OBJECTIVE, {"tokens_used": 0, "token_budget": 0})
        self.assertTrue(text.startswith(goals.CYCLE_MARKER), "the transcript knows it by its first words")
        self.assertIn(f"<objective>\n{OBJECTIVE}\n</objective>", text)
        self.assertIn("it doesn't outrank your other instructions", text)

    def test_the_completion_audit(self):
        text = goals.cycle_prompt(OBJECTIVE, {})
        for words in ("It isn't done until you have proved it", "List what the objective actually requires",
                      "Unsure or indirect proof means not done",
                      "The check has to show it is done, not just fail to spot anything left",
                      "no required work remains", "update_goal(status='completed'"):
            with self.subTest(words=words):
                self.assertIn(words, text)

    def test_fidelity_persistence_and_no_progress(self):
        text = goals.cycle_prompt(OBJECTIVE, {})
        for words in ("success is never redefined as something smaller or easier",
                      "Never swap in something narrower, safer, smaller", "Was the last turn worth it?",
                      "waited on something real"):
            with self.subTest(words=words):
                self.assertIn(words, text)

    def test_blocked_only_after_three_goal_turns_and_never_for_budget(self):
        text = goals.cycle_prompt(OBJECTIVE, {})
        self.assertIn("The first time something blocks you, don't call update_goal(status='blocked')", text)
        self.assertIn("three goal turns in a row or more", text)
        self.assertIn("Running low on budget, or stopping work, is never a reason to mark the goal completed", text)

    def test_the_budget_is_said_when_there_is_one(self):
        self.assertNotIn("Token budget", goals.cycle_prompt(OBJECTIVE, {"tokens_used": 10, "token_budget": 0}))
        text = goals.cycle_prompt(OBJECTIVE, {"tokens_used": 1200, "token_budget": 5000})
        self.assertIn("Tokens used: 1,200", text)
        self.assertIn("Token budget: 5,000", text)
        self.assertIn("Tokens left: 3,800", text)


class TheReminderAndTheTool(unittest.TestCase):
    def test_the_standing_reminder_asks_for_the_audit(self):
        check = goals.REMINDER_CHECK
        for words in ("it isn't done until you have proved it", "every requirement", "Unsure or indirect proof",
                      "three goal turns", "never shrink"):
            with self.subTest(words=words):
                self.assertIn(words, check)

    def test_a_later_reminder_refers_back_briefly(self):
        """The suite's check: later reminders only refer back (under 600 characters); the audit is still named."""
        again = goals.REMINDER_CHECK_AGAIN
        for words in ("not done until today's evidence proves", "every requirement", "three goal turns"):
            with self.subTest(words=words):
                self.assertIn(words, again)
        self.assertLess(len(again) + 120 + goals.GoalLifecycle._GOAL_REFERENCE_CHARS + 1, 600)

    def test_the_system_prompts_goal_section(self):
        section = goals.SYSTEM_GOAL_RULES
        for words in ("It isn't done until you have proved it", "no required work remains", "three goal turns in a row"):
            with self.subTest(words=words):
                self.assertIn(words, section)

    def test_update_goals_description(self):
        tool = update_goal_tool()
        text = tool["description"]
        for words in ("no required work remains", "unsure or indirect proof is not done",
                      "three goal turns in a row or more", "never just because it's difficult",
                      "budget is nearly used"):
            with self.subTest(words=words):
                self.assertIn(words, text)
        self.assertIn("requirement", tool["parameters"]["properties"]["evidence"]["description"])


if __name__ == "__main__":
    unittest.main()
