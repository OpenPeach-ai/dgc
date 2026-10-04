"""`/goal` typed while a terminal turn runs: queued for the turn's next step, never lost."""
import threading
import unittest

from prompt_toolkit.buffer import Buffer

from tests import test_goals as goal_fixtures
from dgc.tui import TUI


class TerminalLiveGoalTests(unittest.TestCase):
    setUp_goal = goal_fixtures.GoalTests.setUp

    def setUp(self):
        self.setUp_goal()
        ui = object.__new__(TUI)
        ui.agent = self.agent
        ui.config = self.agent.config
        ui.input_buf = Buffer(multiline=True)
        ui.blocks = []
        ui._invalidate = lambda: None
        self.flashes, self.errors, self.infos, self.overlays = [], [], [], []
        ui._flash = lambda message, secs=2.2: self.flashes.append(message)
        ui.error = lambda message: self.errors.append(str(message))
        ui.info = lambda message: self.infos.append(str(message))
        ui._open_overlay = lambda rows, **kw: self.overlays.append((rows, kw))
        self.tui = ui
        self.agent.ui = ui              # the agent reports live goal outcomes to this terminal

    def running(self, objective="Write the long comparison", **kw):
        self.assertTrue(self.agent.set_goal(objective, **kw))
        self.agent._goal_running = True
        self.agent._goal_owner = threading.get_ident()
        self.agent._accepting_steer = True
        self.agent._goal_cycle_token_start = 0
        self.addCleanup(setattr, self.agent, "_goal_running", False)
        return self.agent.goal_snapshot()["id"]

    def pick(self, value):
        rows, options = self.overlays[-1]
        options["on_pick"](next(row for row in rows if row["value"] == value))

    def test_replacing_a_running_goal_is_reviewed_then_applied_at_the_next_step(self):
        old = self.running()
        draft = "/goal --tokens 900 Write three bullets"
        self.tui.input_buf.insert_text(draft)
        self.assertTrue(self.tui._live_goal(draft))
        self.assertIsNone(self.agent._queued_goal_replacement, "nothing queues before the review")
        header = " ".join(text.plain for text in self.overlays[-1][1]["header"])
        self.assertIn("Write the long comparison", header)
        self.assertIn("Write three bullets", header)
        self.pick("replace")
        queued = self.agent._queued_goal_replacement
        self.assertEqual((queued["text"], queued["token_budget"], queued["replace"]),
                         ("Write three bullets", 900, True))
        self.assertEqual(self.tui.input_buf.text, "", "the sent draft leaves the composer")
        self.assertEqual(self.tui.blocks[-1]["tag"], "goal · applies at the next step")
        self.assertEqual(self.agent.goal, "Write the long comparison", "unchanged until the boundary")
        self.assertTrue(self.agent._drain_steer(close_if_empty=True))
        self.assertEqual(self.agent.goal, "Write three bullets")
        self.assertNotEqual(self.agent.goal_snapshot()["id"], old)
        self.assertTrue(self.tui._service_goal_results())
        self.assertEqual(self.infos[-1], "goal replaced · continuing with the new objective")

    def test_cancel_keeps_the_running_goal(self):
        self.running()
        self.assertTrue(self.tui._live_goal("/goal Something else"))
        self.pick("cancel")
        self.assertIsNone(self.agent._queued_goal_replacement)
        self.assertEqual(self.agent.goal, "Write the long comparison")

    def test_budget_edit_keeps_identity_and_applies_at_the_next_step(self):
        old = self.running(token_budget=100_000)
        self.assertTrue(self.tui._live_goal("/goal budget 200000"))
        self.assertFalse(self.overlays, "an edit is not a replacement and needs no review")
        queued = self.agent._queued_goal_replacement
        self.assertEqual((queued["replace"], queued["token_budget"]), (False, 200_000))
        self.assertTrue(self.agent._drain_steer(close_if_empty=True))
        snapshot = self.agent.goal_snapshot()
        self.assertEqual((snapshot["id"], snapshot["token_budget"]), (old, 200_000))
        self.tui._service_goal_results()
        self.assertEqual(self.infos[-1], "goal updated · continuing with the revised budget")

    def test_a_change_the_turn_cannot_take_returns_the_text(self):
        # An ordinary turn that never accepted a goal start, so there is nothing to queue into.
        draft = "/goal Ship the fix"
        self.tui.input_buf.insert_text(draft)
        self.assertTrue(self.tui._live_goal(draft))
        self.assertIsNone(self.agent._queued_goal_replacement)
        self.assertEqual(self.tui.input_buf.text, draft)
        self.assertTrue(self.errors and "goal" in self.errors[-1].lower(), self.errors)
        self.assertIn("goal not changed · your text is back in the composer", self.flashes)

    def test_a_replacement_the_owner_refuses_comes_back_to_the_composer(self):
        old = self.running()
        self.assertTrue(self.tui._live_goal("/goal Ship the fix"))
        self.pick("replace")
        self.agent._goal_details["id"] = "f" * 32   # the goal changed under the queued review
        self.assertFalse(self.agent._drain_steer())
        self.assertEqual(self.agent.goal_snapshot()["id"], "f" * 32)
        self.assertNotEqual(old, "f" * 32)
        self.tui._service_goal_results()
        self.assertEqual(self.tui.input_buf.text, "/goal Ship the fix")
        self.assertTrue(self.errors)

    def test_first_goal_adopts_an_ordinary_running_turn(self):
        self.agent._accepting_steer = True
        self.agent._goal_accepts_start = True
        self.addCleanup(setattr, self.agent, "_goal_accepts_start", False)
        self.assertTrue(self.tui._live_goal("/goal Summarize the findings"))
        self.assertFalse(self.overlays, "no current goal: nothing to review replacing")
        self.assertEqual(self.agent._queued_goal_replacement["expected_goal_id"], "")

    def test_an_over_long_objective_is_refused_before_any_review(self):
        self.running()
        objective = "x" * (self.agent.goal_max_chars() + 10)
        self.assertTrue(self.tui._live_goal("/goal " + objective))
        self.assertFalse(self.overlays)
        self.assertIsNone(self.agent._queued_goal_replacement)
        self.assertIn(f"{self.agent.goal_max_chars():,}", self.errors[-1])

    def test_review_stop_and_resume_forms_keep_their_own_routes(self):
        for text in ("/goal", "/goal review", "/goal pause", "/goal clear", "/goal resume", "/goals x"):
            self.assertFalse(self.tui._live_goal(text), text)


if __name__ == "__main__":
    unittest.main()
