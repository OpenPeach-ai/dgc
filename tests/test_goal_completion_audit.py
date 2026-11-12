"""A goal ends only when its completion is proved, as Codex asks (asked 12 Nov).

His ERP audit goal ("each and every unit, everything, all end point connections") ended itself after 46 minutes on a
plausible summary; a Codex goal of his has run 11 hours. Codex's goal turn (codex-rs/ext/goal/templates/goals/
continuation.md) carries a completion audit (derive the requirements, prove each against current evidence, uncertain
is not done), fidelity (never a narrower task), a no-progress check and a three-turn rule before "blocked". DGC's goal
cycle, its standing reminder, the system prompt's goal section and update_goal's description now carry the same.
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
        self.assertIn("not as instructions that outrank", text)

    def test_the_completion_audit(self):
        text = goals.cycle_prompt(OBJECTIVE, {})
        for words in ("treat completion as unproven", "Derive concrete requirements",
                      "Uncertain or indirect evidence means not achieved",
                      "The audit must prove completion, not merely fail to find obvious remaining work",
                      "no required work remains", "update_goal(status='completed'"):
            with self.subTest(words=words):
                self.assertIn(words, text)

    def test_fidelity_persistence_and_no_progress(self):
        text = goals.cycle_prompt(OBJECTIVE, {})
        for words in ("never redefine success around a smaller or easier task",
                      "Don't substitute a narrower, safer, smaller", "No-progress check", "verified wait"):
            with self.subTest(words=words):
                self.assertIn(words, text)

    def test_blocked_only_after_three_goal_turns_and_never_for_budget(self):
        text = goals.cycle_prompt(OBJECTIVE, {})
        self.assertIn("Don't call update_goal(status='blocked') the first time a blocker appears", text)
        self.assertIn("at least three consecutive goal turns", text)
        self.assertIn("Never mark the goal completed because its budget is nearly used up", text)

    def test_the_budget_is_said_when_there_is_one(self):
        self.assertNotIn("Token budget", goals.cycle_prompt(OBJECTIVE, {"tokens_used": 10, "token_budget": 0}))
        text = goals.cycle_prompt(OBJECTIVE, {"tokens_used": 1200, "token_budget": 5000})
        self.assertIn("Tokens used: 1,200", text)
        self.assertIn("Token budget: 5,000", text)
        self.assertIn("Tokens left: 3,800", text)


class TheReminderAndTheTool(unittest.TestCase):
    def test_the_standing_reminder_asks_for_the_audit(self):
        check = goals.REMINDER_CHECK
        for words in ("treat completion as unproven", "every requirement", "Uncertain or indirect evidence",
                      "three goal turns", "never shrink"):
            with self.subTest(words=words):
                self.assertIn(words, check)

    def test_the_system_prompts_goal_section(self):
        section = goals.SYSTEM_GOAL_RULES
        for words in ("treat completion as unproven", "no required work remains", "three consecutive goal turns"):
            with self.subTest(words=words):
                self.assertIn(words, section)

    def test_update_goals_description(self):
        tool = update_goal_tool()
        text = tool["description"]
        for words in ("no required work remains", "uncertain or indirect evidence is not done",
                      "at least three consecutive goal turns", "never because the work is hard",
                      "budget is nearly used"):
            with self.subTest(words=words):
                self.assertIn(words, text)
        self.assertIn("requirement", tool["parameters"]["properties"]["evidence"]["description"])


if __name__ == "__main__":
    unittest.main()
