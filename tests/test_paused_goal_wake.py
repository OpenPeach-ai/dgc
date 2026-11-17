"""A turn that wakes on a paused goal handles what woke it, and stops (the goal soak, 16 Nov).

The soak's goal was paused (a failed turn), and a helper's hand-back woke the chat. That one wake turn ran 5 h 12 min
and 178M tokens doing the goal's work, kept going by wake-ups the model set itself; the person's Resume could not even
land while it ran. The goal's own numbers counted none of it: 78M tokens against 304M in the ledger.

Already in place (and kept): a paused goal's system prompt says not to resume it unasked (goals.goal_record), the
per-turn goal reminder skips wake turns, and wakes wait for a failed turn's automatic resume. Now:
  - every wake turn on a paused goal (a helper's report, a wake-up the model set, a monitor's output) carries a turn
    note: the goal is paused, handle what woke you and stop, don't do the goal's work;
  - DGC ends such a turn after goals.PAUSED_WAKE_MAX_REQUESTS model requests, with a plain line saying why;
  - the tokens and time it spent are counted where the goal keeps its numbers (tokens_used, its work time).
"""
from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dgc import goals                                                    # noqa: E402
from dgc.llm import ChatResult, ToolCall                                 # noqa: E402
from test_agent_reports import BackendCase, notice                       # noqa: E402

NOTE = "The goal is paused"
USAGE = {"prompt_tokens": 100, "completion_tokens": 10}


def max_requests() -> int:
    return int(getattr(goals, "PAUSED_WAKE_MAX_REQUESTS", 10))


class Model:
    """A scripted model: `rounds` tool rounds (a `glob` each), then a final answer. Keeps every request's messages."""

    def __init__(self, rounds: int = 0, sleep: float = 0.0):
        self.rounds, self.sleep = rounds, sleep
        self.requests: list[list] = []
        self.lock = threading.Lock()

    def __call__(self, messages, *args, **kwargs):
        with self.lock:
            self.requests.append(list(messages))
            n = len(self.requests)
        if self.sleep:
            time.sleep(self.sleep)
        if n <= self.rounds:
            # A different look each round, so the repeated-call guard never ends the turn first.
            return ChatResult(tool_calls=[ToolCall(f"c{n}", "glob", {"pattern": f"**/*{n}.txt"})],
                              usage=dict(USAGE))
        return ChatResult(content="Noted.", usage=dict(USAGE))

    def first_prompt(self) -> str:
        """The newest user message of the turn's first request: the wake's own text, with its turn notes."""
        users = [m for m in self.requests[0] if m.get("role") == "user"]
        content = users[-1].get("content") if users else ""
        return content if isinstance(content, str) else str(content)


class Case(BackendCase):
    GOAL = "Build everything in PLAN.md. Done only when every numbered item works and has passing tests."

    def pause_goal(self):
        self.assertTrue(self.agent.set_goal(self.GOAL, status="paused"), self.agent._last_persist_error)
        self.assertEqual(self.agent.goal_status, "paused")

    def helper_reports(self, model: Model) -> None:
        """A background helper's hand-back wakes the idle chat, as the editor's backend runs it."""
        with patch.object(self.agent.client, "chat", side_effect=model):
            self.backend._on_detached_ended(notice())
            self.ends(1)
            self.join()

    def wake_up_fires(self, model: Model) -> None:
        """A wake-up the model set comes due while the chat is idle."""
        book = self.agent.wakeups
        book.add(1, "check the suite", "Look at the suite's result.")
        later = time.time() + 120
        book.clock = lambda: later
        with patch.object(self.agent.client, "chat", side_effect=model):
            self.backend._maybe_wake()
            self.ends(1)
            self.join()

    def typed(self, model: Model, text: str = "What does item 3 ask for?") -> bool:
        with patch.object(self.agent.client, "chat", side_effect=model):
            return self.agent.run_turn(text)


class TheWakeTurnIsToldTheGoalIsPaused(Case):
    def test_a_helpers_report_on_a_paused_goal_carries_the_note(self):
        self.pause_goal()
        model = Model()
        self.helper_reports(model)
        prompt = model.first_prompt()
        self.assertIn(NOTE, prompt)
        self.assertIn("Handle what woke you", prompt)
        self.assertIn("Don't do the goal's work", prompt)

    def test_a_wake_up_on_a_paused_goal_carries_the_note(self):
        self.pause_goal()
        model = Model()
        self.wake_up_fires(model)
        self.assertIn("This is the wake-up you set", model.first_prompt(), "premise: the wake-up's own turn")
        self.assertIn(NOTE, model.first_prompt())

    def test_a_monitors_output_on_a_paused_goal_carries_the_note(self):
        self.pause_goal()
        hub = self.agent.monitors
        self.assertTrue(hub.queue_background_exit("bg1", "python3 -m unittest", 0, 61.0, "OK", hub.epoch))
        notification = hub.take_pending()
        model = Model()
        with patch.object(self.agent.client, "chat", side_effect=model):
            self.assertTrue(self.agent.run_monitor_turn(notification))
        self.assertIn("background task bg1 exited 0", model.first_prompt(), "premise: the monitor's notice")
        self.assertIn(NOTE, model.first_prompt())

    def test_no_note_without_a_paused_goal(self):
        model = Model()
        self.helper_reports(model)
        self.assertNotIn(NOTE, model.first_prompt())

    def test_no_note_on_a_turn_the_user_typed(self):
        self.pause_goal()
        model = Model()
        self.assertTrue(self.typed(model))
        self.assertNotIn(NOTE, model.first_prompt())


class TheWakeTurnIsBounded(Case):
    def test_dgc_ends_a_paused_goals_wake_turn_after_its_requests_and_says_why(self):
        self.pause_goal()
        model = Model(rounds=40)
        self.helper_reports(model)
        self.assertEqual(len(model.requests), max_requests())
        last = self.agent.messages[-1]
        self.assertEqual(last.get("role"), "assistant")
        self.assertIn("DGC ended this turn", last.get("content", ""))
        self.assertIn("the goal is paused", last.get("content", ""))
        self.assertFalse(self.frames("error"), "a planned stop, not a failure")
        self.assertEqual(self.agent.goal_status, "paused", "it never resumes the goal")

    def test_a_wake_turn_that_finishes_sooner_is_left_alone(self):
        self.pause_goal()
        model = Model(rounds=2)
        self.helper_reports(model)
        self.assertEqual(len(model.requests), 3)
        self.assertEqual(self.agent.messages[-1].get("content"), "Noted.")

    def test_a_turn_the_user_typed_is_not_bounded(self):
        self.pause_goal()
        model = Model(rounds=max_requests() + 2)
        self.assertTrue(self.typed(model))
        self.assertEqual(len(model.requests), max_requests() + 3)

    def test_a_wake_turn_without_a_paused_goal_is_not_bounded(self):
        model = Model(rounds=max_requests() + 2)
        self.helper_reports(model)
        self.assertEqual(len(model.requests), max_requests() + 3)


class TheGoalCountsWorkDoneWhilePaused(Case):
    def test_a_wake_turns_tokens_and_time_join_the_goals_numbers(self):
        self.pause_goal()
        before_tokens = self.agent._goal_details["tokens_used"]
        before_time = self.agent._goal_elapsed_seconds
        model = Model(rounds=2, sleep=0.15)
        self.helper_reports(model)
        self.assertEqual(self.agent._goal_details["tokens_used"] - before_tokens, 3 * 110)
        self.assertGreaterEqual(self.agent._goal_elapsed_seconds - before_time, 0.4)
        self.assertEqual(self.agent.goal_snapshot()["tokens_used"], before_tokens + 330)

    def test_a_turn_the_user_typed_on_a_paused_goal_is_not_the_goals(self):
        self.pause_goal()
        model = Model(rounds=1)
        self.assertTrue(self.typed(model))
        self.assertEqual(self.agent._goal_details["tokens_used"], 0)
        self.assertEqual(self.agent._goal_elapsed_seconds, 0)


if __name__ == "__main__":
    unittest.main()
