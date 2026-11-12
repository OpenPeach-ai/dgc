"""Every goal a session ran is kept (asked 12 Nov): "a history of goal runs per session, so user can later see what all
goals a session had ran, and how much time and token usage each took, and could use our Trace feature for those".

A session keeps a short record of each finished goal (its name, how it ended, when it started and ended, its time,
tokens and cycles); a goal replaced or cleared is recorded too, as stopped. `goal_runs` (a new command and event, behind
ready.capabilities.goal_runs) lists them with the current goal last; the editor finds each goal's turns for Trace by
their times. The record survives a reload.
"""
import time
import unittest

from dgc import editor_protocol as ep
from dgc import goals, sessions
from tests import test_goals as goal_tests       # the module, so its tests aren't collected here too


class Summary(unittest.TestCase):
    def test_a_finished_goals_record(self):
        details = goals.new_details()
        details.update(id="g1", tokens_used=1800000, cycles=7)
        details["history"] = [{"status": "active", "at": 1000.0, "reason": "Goal started"},
                              {"status": "paused", "at": 1500.0, "reason": "Paused by user"},
                              {"status": "active", "at": 1600.0, "reason": "Resumed by user"},
                              {"status": "completed", "at": 3800.0, "reason": "Done: everything checked"}]
        run = goals.run_summary("Audit every unit of the ERP: every endpoint and link", "completed", 2791.0, details)
        self.assertEqual(run["id"], "g1")
        self.assertEqual(run["status"], "completed")
        self.assertEqual((run["started_at"], run["ended_at"]), (1000.0, 3800.0))
        self.assertEqual((run["elapsed_seconds"], run["tokens"], run["cycles"]), (2791, 1800000, 7))
        self.assertTrue(run["name"] and len(run["name"]) <= goals.GOAL_NAME_CHARS)

    def test_unfinished_when_replaced_is_stopped_and_ends_now(self):
        details = goals.new_details()
        details["history"] = [{"status": "active", "at": 1000.0, "reason": "Goal started"}]
        run = goals.run_summary("Write the docs", "paused", 60.0, details, now=2000.0)
        self.assertEqual((run["status"], run["ended_at"]), ("stopped", 2000.0))

    def test_runs_are_checked_and_bounded(self):
        good = {"id": "g", "name": "x", "status": "completed", "started_at": 1.0, "ended_at": 2.0,
                "elapsed_seconds": 1, "tokens": 5, "cycles": 1}
        cleaned = goals.clean_runs([good, {"id": 3}, "nope", {**good, "status": "weird"}] + [good] * 80)
        self.assertEqual(len(cleaned), goals.MAX_RUNS)
        self.assertTrue(all(r["status"] in ("completed", "blocked", "stopped") for r in cleaned))
        self.assertEqual(goals.clean_runs(None), [])


class InTheSession(unittest.TestCase):
    setUp = goal_tests.GoalTests.setUp     # the goal tests' agent, not their tests
    def test_a_replaced_goal_is_kept_and_listed_before_the_current_one(self):
        self.assertTrue(self.agent.set_goal("Finish the original work"))
        self.assertTrue(self.agent.update_goal("completed", reason="Done", evidence=["all checked"]))
        self.assertTrue(self.agent.set_goal("Write the release notes", replace=True))
        runs = self.agent.goal_runs()
        self.assertEqual([r["status"] for r in runs], ["completed", "active"])
        self.assertIn("original", runs[0]["name"].lower())
        self.assertIsNone(runs[1]["ended_at"])

    def test_a_cleared_goal_is_kept_as_stopped(self):
        self.assertTrue(self.agent.set_goal("Refactor the parser"))
        self.assertTrue(self.agent.set_goal(""))
        self.assertEqual([r["status"] for r in self.agent.goal_runs()], ["stopped"])

    def test_the_record_survives_a_reload(self):
        self.assertTrue(self.agent.set_goal("Finish the original work"))
        self.assertTrue(self.agent.update_goal("completed", reason="Done", evidence=["checked"]))
        self.assertTrue(self.agent.set_goal("Second goal", replace=True))
        path = sessions.new_path(self.root)
        self.assertTrue(sessions.save(path, [], self.root, goal=self.agent.goal, goal_status=self.agent.goal_status,
                                      goal_details=self.agent._goal_details, goal_runs=self.agent._goal_runs))
        record = sessions.load_record(path, self.root)
        self.assertEqual([r["status"] for r in goals.clean_runs(record.get("goal_runs"))], ["completed"])


class Protocol(unittest.TestCase):
    def test_a_new_command_and_event(self):
        self.assertIn("goal_runs", ep.COMMAND_FIELDS)
        self.assertIsNone(ep.event_error({"type": "goal_runs", "seq": 1, "runs": [], "request_id": "r1"}))


if __name__ == "__main__":
    unittest.main()
