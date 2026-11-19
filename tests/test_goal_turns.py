"""A Work goal as turns (12 Nov night, his call): each goal cycle is a turn of
its own, with its own reply and file changes, and the editor's backend starts the next one when the last ended with the
goal still running, after anything already queued. The stop rule replaces "three cycles without distinct tool
progress": three goal turns in a row that came back empty (no tool work and no reply). An SDK client and the terminal
keep the goal inside one turn (goal_turns off)."""
import copy
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import headless
from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.goals import CYCLE_MARKER


class QuietUI:
    def __getattr__(self, name):
        return lambda *a, **k: None


def agent_in(root: Path) -> Agent:
    config = object.__new__(Config)
    config.project_root = root
    config.project_dir = root / ".dgc"
    config._persist = False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", api_key="fixture-placeholder", model="fixture",
                       mode="auto", hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
    config._stored_secrets, config._env_secret_keys = {}, set()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return Agent(config, QuietUI())


class GoalTurnsAgentTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-goal-turns-")
        self.addCleanup(directory.cleanup)
        self.agent = agent_in(Path(directory.name))
        self.addCleanup(self.agent.mcp.stop_all)

    def step_that(self, say="Did a step.", tool=True, on=None):
        """A stand-in for one model step: it writes its prompt and a reply into the transcript, as a real step does."""
        agent = self.agent
        def step(prompt):
            agent.messages.append({"role": "user", "content": prompt})
            if tool:
                agent._goal_progress.add("read_file", {"path": f"f{len(agent.messages)}"}, "content")
            if say:
                agent.messages.append({"role": "assistant", "content": say})
            if on:
                on()
            return True
        return step

    def test_with_goal_turns_one_turn_runs_one_cycle_and_hands_back_the_next(self):
        self.agent.goal_turns = True
        self.agent.set_goal("ship the release")
        self.agent._run_turn = self.step_that()
        self.assertTrue(self.agent.run_turn("ship the release"))
        self.assertEqual(self.agent.goal_snapshot()["cycles"], 1, "one cycle, not a loop inside the turn")
        self.assertEqual(self.agent.goal_status, "active")
        prompt = self.agent.take_goal_next_turn()
        self.assertIn(CYCLE_MARKER, prompt)
        self.assertIn("ship the release", prompt)
        self.assertEqual(self.agent.take_goal_next_turn(), "", "handed back once")

    def test_the_goals_own_next_turn_is_not_the_users_words_and_is_numbered(self):
        self.agent.goal_turns = True
        self.agent.set_goal("ship the release")
        self.agent._run_turn = self.step_that()
        self.agent.run_turn("ship the release")
        prompt = self.agent.take_goal_next_turn()
        typed_before = list(getattr(self.agent, "_typed_turns", []))
        self.agent._goal_continuing = True
        with patch.object(self.agent, "prepare_goal_inputs", side_effect=AssertionError("given at the goal's start")):
            self.assertTrue(self.agent.run_turn(prompt))
        self.assertEqual(self.agent.goal_snapshot()["cycles"], 2)
        self.assertEqual(getattr(self.agent, "_typed_turns", []), typed_before, "DGC's cycle prompt is not typed words")
        cycle = [m for m in self.agent.messages if m.get("role") == "user" and CYCLE_MARKER in str(m.get("content"))]
        self.assertEqual(cycle[-1].get("_dgc_goal_turn"), 2, "the transcript says which goal turn it was")
        self.assertIn(CYCLE_MARKER, self.agent.take_goal_next_turn())
        self.assertFalse(self.agent.take_goal_continuing(), "read once")

    def test_a_finished_or_paused_goal_hands_back_no_next_turn(self):
        self.agent.goal_turns = True
        self.agent.set_goal("ship the release")
        def done():
            self.agent._pending_goal_report = {"status": "blocked", "summary": "Needs a key", "evidence": ["No key"]}
        self.agent._run_turn = self.step_that(on=done)
        self.agent.run_turn("ship the release")
        self.assertEqual(self.agent.goal_status, "blocked")
        self.assertEqual(self.agent.take_goal_next_turn(), "")
        self.agent.set_goal("another", replace=True)
        def stop():
            self.agent.cancelled.set()
        self.agent._run_turn = self.step_that(on=stop)
        self.agent.run_turn("another")
        self.assertEqual(self.agent.goal_status, "paused")
        self.assertEqual(self.agent.take_goal_next_turn(), "")

    def test_three_empty_goal_turns_in_a_row_block_it_across_turns(self):
        self.agent.goal_turns = True
        self.agent.set_goal("ship the release")
        self.agent._run_turn = self.step_that(say="", tool=False)
        self.agent.run_turn("ship the release")
        for _ in range(2):
            prompt = self.agent.take_goal_next_turn()
            self.assertTrue(prompt)
            self.agent._goal_continuing = True
            self.agent.run_turn(prompt)
        self.assertEqual(self.agent.goal_status, "blocked")
        self.assertIn("empty", self.agent._goal_details["reason"])

    def test_a_reply_or_tool_work_is_not_an_empty_turn(self):
        for say, tool in (("", True),):
            with self.subTest(say=say, tool=tool):
                self.agent.goal_turns = True
                self.agent.set_goal("watch the build", replace=True)
                self.agent._run_turn = self.step_that(say=say, tool=tool)
                self.agent.run_turn("watch the build")
                for _ in range(4):
                    self.agent._goal_continuing = True
                    self.agent.run_turn(self.agent.take_goal_next_turn())
                self.assertEqual(self.agent.goal_status, "active")
                self.assertEqual(self.agent._goal_details["stalled_cycles"], 0)

    def test_the_same_words_three_turns_running_with_no_work_pause_the_goal(self):
        # Live (19-20 Nov, a real Work goal on glm-5.3:cloud): its completion report was dropped with a failed cycle, and
        # it then replied "Steady state holds, goal complete" every turn for 57 turns (108M tokens). Words alone, the
        # same each time and with no tool work, are not progress: the third such turn pauses it, in plain words.
        self.agent.goal_turns = True
        self.agent.set_goal("build the dashboard")
        self.agent._run_turn = self.step_that(say="Steady state holds: goal complete, nothing to do until 07:36.", tool=False)
        self.agent.run_turn("build the dashboard")
        for _ in range(2):
            self.agent._goal_continuing = True
            self.agent.run_turn(self.agent.take_goal_next_turn())
        self.assertEqual(self.agent.goal_status, "paused")
        self.assertIn("said the same thing", self.agent._goal_details["reason"])
        self.assertEqual(self.agent.take_goal_next_turn(), "", "no fourth turn")

    def test_different_words_or_any_tool_work_keep_it_going(self):
        replies = iter([f"Still waiting on the build: {n} of 5 jobs left." for n in range(5, 0, -1)])
        self.agent.goal_turns = True
        self.agent.set_goal("watch the build")
        def step(prompt):
            self.agent.messages.append({"role": "user", "content": prompt})
            self.agent.messages.append({"role": "assistant", "content": next(replies)})
            return True
        self.agent._run_turn = step
        self.agent.run_turn("watch the build")
        for _ in range(4):
            self.agent._goal_continuing = True
            self.agent.run_turn(self.agent.take_goal_next_turn())
        self.assertEqual(self.agent.goal_status, "active")

    def test_each_goal_turn_says_the_goal_is_still_open(self):
        # So a model that believes it already closed the goal (its report was dropped) is told otherwise every turn.
        from dgc.goals import cycle_prompt
        text = cycle_prompt("build the dashboard", {})
        self.assertIn("still open", text)
        self.assertIn("update_goal(status='completed'", text)
        self.assertIn("Saying so in words doesn't close it", text)

    def test_inside_one_turn_repeated_tool_work_no_longer_blocks_it(self):
        # goal_turns off (an SDK client, the terminal): the cycles still run inside the turn; the same tool work again
        # is the model's own no-progress audit to judge, not a mechanical stop. Bounded here by a Stop on cycle 6.
        self.agent.set_goal("fix remaining work")
        calls = []
        def step(_):
            calls.append(1)
            self.agent._goal_progress.add("read_file", {"path": "same"}, "same content")
            if len(calls) == 6:
                self.agent.cancelled.set()
            return True
        self.agent._run_turn = step
        self.agent.run_turn("start")
        self.assertEqual(self.agent.goal_snapshot()["cycles"], 6)
        self.assertEqual(self.agent.goal_status, "paused", "stopped by the user, never blocked for repeating")


class GoalTurnsBackendTests(unittest.TestCase):
    class StandIn:
        goal = "ship the release"; goal_status = "active"; stopping = False
        def __init__(self, prompt="Continue the active goal from the current session state. next", asks=None):
            self._next, self._asks = prompt, asks or {}
            self._goal_details = {"cycles": 2}
        def take_goal_next_turn(self):
            prompt, self._next = self._next, ""
            return prompt
        def _open_asks(self):
            return self._asks

    def backend(self, agent, queue=None):
        be = headless.Backend.__new__(headless.Backend)
        be.agent = agent
        be._queue = list(queue or [])
        lock = threading.RLock()
        be._turn_state_lock = lambda: lock
        return be

    def test_the_next_goal_turn_is_queued_after_what_you_queued(self):
        mine = ("my queued message", None, None, "prompt", "req-1")
        be = self.backend(self.StandIn(), [mine])
        self.assertTrue(be._maybe_continue_goal(failed=False, cancelled=False))
        self.assertEqual(be._queue[0], mine, "your message runs first, as its own turn")
        self.assertEqual(be._queue[1][3], "goal")
        self.assertEqual(be._queued_prompt_count(), 1, "a goal's own turn is not a message of yours")
        be.agent._next = "Continue the active goal from the current session state. again"
        self.assertFalse(be._maybe_continue_goal(failed=False, cancelled=False), "one next turn at a time")

    def test_no_next_turn_after_a_failure_a_stop_an_open_question_or_shutdown(self):
        for kwargs, agent in (({"failed": True, "cancelled": False}, self.StandIn()),
                              ({"failed": False, "cancelled": True}, self.StandIn()),
                              ({"failed": False, "cancelled": False}, self.StandIn(asks={"ask-1": {}}))):
            with self.subTest(**kwargs):
                be = self.backend(agent)
                self.assertFalse(be._maybe_continue_goal(**kwargs))
                self.assertEqual(be._queue, [])
        going = self.StandIn(); going.stopping = True
        be = self.backend(going)
        self.assertFalse(be._maybe_continue_goal(failed=False, cancelled=False))
        nothing = self.StandIn(prompt="")
        self.assertFalse(self.backend(nothing)._maybe_continue_goal(failed=False, cancelled=False))

    def test_the_editors_backend_gets_goal_turns_and_an_sdk_client_does_not(self):
        be = self.backend(self.StandIn())
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DGC_GOAL_TURNS", None)
            os.environ["DGC_EDITOR_SESSION"] = "1"
            self.assertTrue(be._goal_turns_wanted(), "the editor starts dgc serve with DGC_EDITOR_SESSION=1")
            os.environ.pop("DGC_EDITOR_SESSION", None)
            self.assertFalse(be._goal_turns_wanted(), "an SDK client waits for the goal's one turn")
            os.environ["DGC_GOAL_TURNS"] = "1"
            self.assertTrue(be._goal_turns_wanted())
            os.environ["DGC_GOAL_TURNS"] = "0"; os.environ["DGC_EDITOR_SESSION"] = "1"
            self.assertFalse(be._goal_turns_wanted(), "said explicitly")

    def test_a_reload_draws_each_goal_turn_as_it_was_live(self):
        prompt = CYCLE_MARKER + " Take the next concrete step."
        self.assertEqual(headless._goal_scaffold(prompt, {"_dgc_goal_turn": 3}), "Goal · turn 3")
        self.assertEqual(headless._goal_scaffold(prompt, {}), "Continued the standing goal", "an older session's")
        self.assertEqual(headless._goal_scaffold(prompt, {"_dgc_goal_turn": True}), "Continued the standing goal")
        self.assertEqual(headless._goal_scaffold("what I typed"), "")


if __name__ == "__main__":
    unittest.main()
