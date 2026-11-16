"""A goal carries on after a turn that failed, as its rule says (found by the goal soak, 16 Nov).

The rule (his call, 16 Nov: "keep it"): a standing goal whose turn stops on its own is continued automatically, twice in
a row at most, then waits for the user. The soak (kimi-k3.1-pro, a 3-minute model outage) found it never ran: a turn
that failed (the model answered 503) PAUSED the goal at once (goals: finish("paused")), and the automatic resume acts
only on an active goal, so nothing was ever retried: "Paused goal" until a person pressed Resume.

Now a goal paused by its own failed turn (never by the user) is resumed automatically, after a wait, so an outage has
time to pass: a minute, then five. Each resume says when it will come, and anything the user does first wins (Resume
now, Pause, a new goal, Stop). After the second one fails too, it stays paused with the reason and DGC says it has
stopped retrying."""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import goals, headless
from tests.test_goal_turns import agent_in


class TheGoalSide(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-goal-failed-")
        self.addCleanup(directory.cleanup)
        self.agent = agent_in(Path(directory.name))
        self.addCleanup(self.agent.mcp.stop_all)

    def test_a_failed_goal_turn_pauses_it_as_its_own_failure(self):
        self.agent.goal_turns = True
        self.agent.set_goal("build everything in PLAN.md", replace=True)

        def fails(prompt):
            self.agent.messages.append({"role": "user", "content": prompt})
            self.agent._last_turn_error = "HTTP 503 from the model server"
            return False
        self.agent._run_turn = fails
        self.agent.run_turn("build everything in PLAN.md")
        self.assertEqual(self.agent.goal_status, "paused")
        self.assertTrue(self.agent._goal_failed_pause, "paused by its own failed turn, not by the user")

    def test_any_later_change_of_the_goal_is_not_that_failure_any_more(self):
        self.agent.set_goal("build everything in PLAN.md", replace=True)
        self.agent._goal_failed_pause = True
        self.agent.update_goal("paused", reason="Paused by you")
        self.assertFalse(self.agent._goal_failed_pause)


class Agent:
    goal = "build everything in PLAN.md"
    stopping = False

    def __init__(self, status="paused", failed=True):
        self.goal_status, self._goal_failed_pause = status, failed
        self._last_turn_error = "HTTP 503 from the model server"
        self.transitions = []

    def set_goal(self, text, status="active", **kwargs):
        self.transitions.append(status)
        self.goal_status, self._goal_failed_pause = status, False
        return True

    def update_goal(self, status, *, reason="", evidence=None):
        self.transitions.append(status)
        self.goal_status, self._goal_failed_pause = status, False
        return True


class UI:
    def __init__(self):
        self.notes = []

    def info(self, text, *a, **k):
        self.notes.append(("info", text))

    def error(self, text, *a, **k):
        self.notes.append(("error", text))


class TheBackendSide(unittest.TestCase):
    def backend(self, agent):
        be = headless.Backend.__new__(headless.Backend)
        be.agent, be.ui, be._queue, be._goal_auto_resumes = agent, UI(), [], 0
        lock = threading.RLock()
        be._turn_state_lock = lambda: lock
        be._emit_goal = lambda *a, **k: None
        be._worker = None
        self.timers, self.started = [], []
        return be

    def schedule(self, be):
        class Timer:
            def __init__(timer, delay, call):
                timer.delay, timer.call, timer.daemon = delay, call, False
                self.timers.append(timer)

            def start(timer):
                pass

            def cancel(timer):
                timer.cancelled = True
        return patch.object(headless.threading, "Timer", Timer)

    def fire(self, be):
        class Thread:
            def __init__(thread, target=None, daemon=None, name=None):
                thread.target = target

            def start(thread):
                self.started.append(thread)
        with patch.object(headless.threading, "Thread", Thread):
            self.timers[-1].call()

    def test_a_goal_its_own_failed_turn_paused_is_resumed_after_a_wait(self):
        agent = Agent()
        be = self.backend(agent)
        with self.schedule(be):
            self.assertTrue(be._maybe_auto_resume_goal(failed=True, cancelled=False))
        self.assertEqual(self.timers[0].delay, goals.AUTO_RESUME_WAITS[0])
        self.assertEqual(be._queue, [], "nothing runs at once: an outage needs time to pass")
        self.assertTrue(any("tries it again" in text for kind, text in be.ui.notes), be.ui.notes)
        self.fire(be)
        self.assertEqual(agent.goal_status, "active")
        self.assertEqual(len(be._queue), 1)
        self.assertEqual(be._queue[0][3], "resume")
        self.assertIn("503", be._queue[0][0], "the next attempt is told why the last one stopped")
        self.assertEqual(len(self.started), 1, "a worker runs it")

    def test_the_second_wait_is_longer_and_after_it_dgc_stops_retrying(self):
        agent = Agent()
        be = self.backend(agent)
        be._goal_auto_resumes = 1
        with self.schedule(be):
            self.assertTrue(be._maybe_auto_resume_goal(failed=True, cancelled=False))
        self.assertEqual(self.timers[0].delay, goals.AUTO_RESUME_WAITS[1])
        self.assertGreater(goals.AUTO_RESUME_WAITS[1], goals.AUTO_RESUME_WAITS[0])
        be._goal_auto_resumes = goals.AUTO_RESUME_MAX
        agent.goal_status, agent._goal_failed_pause = "paused", True
        with self.schedule(be):
            self.assertFalse(be._maybe_auto_resume_goal(failed=True, cancelled=False))
        self.assertEqual(len(self.timers), 1, "no third")
        self.assertEqual(agent.goal_status, "paused", "it waits for the user, with its reason")
        self.assertTrue(any(kind == "error" and "stopped retrying" in text for kind, text in be.ui.notes))

    def test_what_the_user_does_first_wins(self):
        for change in ("resumed", "paused", "stopping", "queued"):
            with self.subTest(change=change):
                agent = Agent()
                be = self.backend(agent)
                with self.schedule(be):
                    be._maybe_auto_resume_goal(failed=True, cancelled=False)
                if change == "resumed":
                    agent.set_goal(agent.goal, status="active")
                    agent.transitions.clear()
                elif change == "paused":
                    agent.update_goal("paused", reason="Paused by you")
                    agent.transitions.clear()
                elif change == "stopping":
                    agent.stopping = True
                else:
                    be._queue.append(("their message", None, None, "prompt"))
                self.fire(be)
                self.assertEqual(agent.transitions, [], "the wait never overrides them")
                self.assertNotIn("resume", [item[3] for item in be._queue])

    def test_a_goal_the_user_paused_is_never_resumed(self):
        agent = Agent(failed=False)
        be = self.backend(agent)
        with self.schedule(be):
            self.assertFalse(be._maybe_auto_resume_goal(failed=True, cancelled=False))
        self.assertEqual(self.timers, [])


class WakesWaitForTheResume(unittest.TestCase):
    backend, schedule, fire = TheBackendSide.backend, TheBackendSide.schedule, TheBackendSide.fire
    """The soak's outage: every sub-agent hand-back woke the session and failed again (7 error lines in 2 minutes).
    While a goal waits on its resume after a failed turn, a wake waits too; the resumed turn reads what arrived."""

    def test_no_wake_while_the_resume_is_waiting(self):
        agent = Agent()
        agent.monitors = object()
        be = self.backend(agent)
        be._agent_wakes = ["agent finished"]
        with self.schedule(be):
            be._maybe_auto_resume_goal(failed=True, cancelled=False)
        self.assertTrue(be._wake_blocked_locked(), "waits for the resume")
        be._goal_resume_token = None
        self.assertFalse(be._wake_blocked_locked())

    def test_a_resume_that_doesnt_run_lets_the_waiting_wakes_go(self):
        agent = Agent()
        be = self.backend(agent)
        woken = []
        be._maybe_wake = lambda: woken.append(1)
        with self.schedule(be):
            be._maybe_auto_resume_goal(failed=True, cancelled=False)
        agent.update_goal("paused", reason="Paused by you")
        self.fire(be)
        self.assertEqual(woken, [1])


if __name__ == "__main__":
    unittest.main()
