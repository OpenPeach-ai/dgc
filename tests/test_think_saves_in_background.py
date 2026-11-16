"""The thinking slider answers at once (his call, 16 Nov: "Thinking slider saves faster" into 0.52).

A change of the thinking level for this session saved the whole session before answering: about 2 s a step on a long
session, while the editor's slider waited, and its line said the code word ("Thinking → xhigh"). Now the level applies and
is answered at once, the session saves in the background, and a save that fails puts the level back and says so; the line
says the level in words ("Thinking: Extra high")."""
import threading
import unittest
from unittest.mock import patch

from tests import test_live_controls as live


class AtOnce(unittest.TestCase):
    setUp, wait = live.LiveControlTests.setUp, live.LiveControlTests.wait

    def test_the_level_is_answered_before_the_session_has_saved(self):
        saving, done = threading.Event(), threading.Event()
        def slow_save(*a, **k):
            saving.set()
            done.wait(5)
            return True
        with patch.object(self.agent, "_persist", side_effect=slow_save):
            self.backend.dispatch({"type": "set_think", "level": "xhigh", "scope": "session", "request_id": "t1"})
            self.wait("think_changed", request_id="t1", think="xhigh")
            self.assertEqual(self.agent.config.get("thinking"), "xhigh")
            self.assertTrue(saving.wait(5), "the save runs, in the background")
            done.set()
        self.wait("info", message="Thinking: Extra high")

    def test_a_save_that_fails_puts_the_level_back_and_says_so(self):
        with patch.object(self.agent, "_persist", return_value=False):
            self.backend.dispatch({"type": "set_think", "level": "high", "scope": "session", "request_id": "t2"})
            self.wait("command_rejected", command="set_think", reason="session_save_failed")
        self.wait("think_changed", think="off")
        self.assertEqual(self.agent.config.get("thinking"), "off")


class ATurnRightAfter(unittest.TestCase):
    setUp, wait = live.LiveControlTests.setUp, live.LiveControlTests.wait

    def test_a_turn_started_right_after_waits_for_the_save_instead_of_finding_the_session_busy(self):
        order = []
        def slow_save(*a, **k):
            import time
            time.sleep(0.5)
            order.append("saved")
            return True
        from dgc.llm import ChatResult
        def chat(messages, **kwargs):
            order.append("turn")
            return ChatResult(content="done")
        with patch.object(self.agent, "_persist", side_effect=slow_save), \
                patch.object(self.agent.client, "chat", side_effect=chat):
            self.backend.dispatch({"type": "set_think", "level": "low", "scope": "session", "request_id": "t3"})
            self.backend.dispatch({"type": "prompt", "text": "Go", "request_id": "p3"})
            self.wait("turn_end", reason="completed")
        self.assertEqual(order[:2], ["saved", "turn"], "the turn ran after the save, not into it")

