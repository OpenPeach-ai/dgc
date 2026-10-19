"""Steer now / Steer all: a queued message moves into the running turn as steering (the founder, 2026-10-19).

A message queued while a turn ran ("you · queued", from Alt+Enter or a Pip report's Ask DGC to fix) could only wait
for the turn to end. `steer_queued {request_ids}` moves the user's own queued prompts, in queue order, into the running
turn the way Enter-while-working does; anything else in the queue stays put, and nothing moves when no turn can take it.
"""
from __future__ import annotations

import threading
import unittest
from types import SimpleNamespace

from dgc.headless import Backend


class Agent:
    def __init__(self, accept=True):
        self.cancelled = threading.Event()
        self.steered = []
        self.accept = accept

    def steer(self, text, *, images=None, request_id="", **_):
        if not self.accept:
            return False
        self.steered.append((request_id, text))
        return True


def backend(queue, *, running=True, agent=None):
    b = object.__new__(Backend)
    b.events = []
    b.em = SimpleNamespace(emit=lambda kind, **kw: b.events.append({"type": kind, **kw}))
    b.agent = agent or Agent()
    b.config = SimpleNamespace(get=lambda key, default=None: default)
    b._queue = list(queue)
    b._worker = object() if running else None
    b._foreground_worker = None
    b._running_turn_kind = "prompt"
    b._steer_payloads = {}
    return b


def prompt(rid, text, kind="prompt"):
    return (text, None, None, kind, rid)


class SteerQueuedTests(unittest.TestCase):
    def test_steer_now_moves_one_queued_message_into_the_running_turn(self):
        b = backend([prompt("q1", "also check the totals"), prompt("q2", "and the dates")])
        moved, why = b._steer_queued(["q1"])
        self.assertEqual(moved, ["q1"])
        self.assertEqual(why, "")
        self.assertEqual([rid for rid, _ in b.agent.steered], ["q1"])
        self.assertIn("also check the totals", b.agent.steered[0][1])
        self.assertEqual([q[4] for q in b._queue], ["q2"], "the other message stays queued")
        self.assertIn({"type": "prompt_accepted", "request_id": "q1", "state": "steered"}, b.events)
        self.assertIn({"type": "queued", "count": 1, "text": ""}, b.events, "the queued count goes down")

    def test_steer_all_keeps_queue_order_and_leaves_turns_that_are_not_the_users_prompts(self):
        b = backend([prompt("q1", "one"), prompt("c", "continue", kind="continue"), prompt("q2", "two"),
                     prompt("p", "setup", kind="pip_setup")])
        moved, _ = b._steer_queued(["q2", "q1", "c", "p"])
        self.assertEqual(moved, ["q1", "q2"], "queue order, and only the user's own prompts")
        self.assertEqual([q[4] for q in b._queue], ["c", "p"])

    def test_nothing_moves_when_no_turn_is_running(self):
        b = backend([prompt("q1", "one")], running=False)
        moved, why = b._steer_queued(["q1"])
        self.assertEqual(moved, [])
        self.assertIn("No turn is running", why)
        self.assertEqual(len(b._queue), 1)

    def test_a_turn_that_cannot_take_steering_keeps_the_message_queued(self):
        b = backend([prompt("q1", "one"), prompt("q2", "two")], agent=Agent(accept=False))
        moved, why = b._steer_queued(["q1", "q2"])
        self.assertEqual(moved, [])
        self.assertEqual([q[4] for q in b._queue], ["q1", "q2"])
        self.assertEqual(b._steer_payloads, {}, "nothing is left half-steered")
        self.assertTrue(why)

    def test_a_stopping_turn_takes_nothing(self):
        b = backend([prompt("q1", "one")])
        b.agent.cancelled.set()
        moved, _ = b._steer_queued(["q1"])
        self.assertEqual(moved, [])

    def test_the_command_moves_them_and_says_plainly_when_none_could(self):
        b = backend([prompt("q1", "one")])
        b._dispatch({"type": "steer_queued", "request_ids": ["q1"]})
        self.assertIn({"type": "prompt_accepted", "request_id": "q1", "state": "steered"}, b.events)
        idle = backend([prompt("q1", "one")], running=False)
        idle._dispatch({"type": "steer_queued", "request_ids": ["q1"]})
        refused = [e for e in idle.events if e["type"] == "command_rejected"]
        self.assertEqual(refused[0]["reason"], "not_steerable")
        self.assertIn("next one", refused[0]["message"])
        bad = backend([])
        bad._dispatch({"type": "steer_queued", "request_ids": "q1"})
        self.assertEqual([e["reason"] for e in bad.events if e["type"] == "command_rejected"], ["invalid_command"], "the protocol check refuses a malformed request first")

    def test_ready_offers_steer_queued(self):
        import inspect
        from dgc import headless
        self.assertIn('"steer_queued": True', inspect.getsource(headless.Backend))


if __name__ == "__main__":
    unittest.main()
