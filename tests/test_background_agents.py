"""Plan 3: background task children outlive the parent turn and notify when they land."""
from __future__ import annotations

import time
from unittest.mock import patch

from dgc.config import Config
from dgc.headless import HeadlessUI
from dgc.llm import ChatResult, LLMClient, ToolCall
from test_subagents import HarnessCase, Script, calls_then, child, clone_fixture


class BackgroundTaskTests(HarnessCase):
    # How long the scripted child takes; the timing assertions key off it.
    CHILD_SECONDS = 1.2

    def _go(self, h, prompt, routes):
        if isinstance(h.ui, HeadlessUI):
            h.ui.turn_id = "t1"
            h.ui.reset_turn_messages()
        return h.agent.run_turn(prompt)

    def test_background_task_returns_before_the_child_ends(self):
        h = self.make(git=True, mode="auto")
        notices = []
        h.agent.on_detached_ended = notices.append
        routes = [
            ("parent: background map", calls_then([
                ToolCall("t1", "task", {
                    "description": "map auth",
                    "prompt": "look at pkg/auth.py and say where login lives",
                    "agent": "explorer",
                    "background": True,
                }),
            ], final="spawned and done speaking")),
            # The parent is only "not waiting" relative to how long the child takes, so the two
            # numbers belong together: a parent that waited would take at least this long.
            ("look at pkg/auth.py", child("Auth is in pkg/auth.py.\nFILES: pkg/auth.py",
                                          sleep=self.CHILD_SECONDS)),
        ]
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            started = time.monotonic()
            self._go(h, "parent: background map", routes)
            elapsed = time.monotonic() - started
            # The real property, and it needs no clock: the child had not reported yet.
            self.assertFalse(notices, "the parent turn returned only after the child finished")
            # A hard bound of 0.8s against a 1.2s child left 0.4s of slack and failed CI on a
            # loaded runner. A parent that actually waited cannot come in under the child's own
            # sleep, so that is the bound worth asserting.
            self.assertLess(elapsed, self.CHILD_SECONDS, "the parent turn must not wait for the child")
            started_frame = h.of("agent_started")[-1]
            self.assertTrue(started_frame.get("background"))
            self.assertIn("running in the background", h.of("tool_result")[-1]["output"])
            self.assertTrue(h.agent._detached_jobs)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and not notices:
                time.sleep(0.05)
            self.assertTrue(notices, "the child must still finish and notify")
            self.assertIn("pkg/auth.py", notices[0]["message"])
            ended = [f for f in h.of("agent_ended") if f["id"] == started_frame["id"]]
            self.assertEqual(ended[-1]["state"], "finished")
            self.assertFalse(any("independent reads" in str(f.get("message") or "") for f in h.of("info")),
                             "child parallel-read banners stay off the parent transcript")

    def test_parent_stop_does_not_cancel_a_detached_child(self):
        h = self.make(git=True, mode="auto")
        notices = []
        h.agent.on_detached_ended = notices.append
        routes = [
            ("parent: background map", calls_then([
                ToolCall("t1", "task", {
                    "description": "map auth",
                    "prompt": "look at pkg/auth.py and say where login lives",
                    "agent": "explorer",
                    "background": True,
                }),
            ], final="spawned")),
            ("look at pkg/auth.py", child("Auth is in pkg/auth.py.", sleep=0.8)),
        ]
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            self._go(h, "parent: background map", routes)
            h.agent.cancelled.set()
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and not notices:
                time.sleep(0.05)
            self.assertTrue(notices)
            ended = h.of("agent_ended")[-1]
            self.assertEqual(ended["state"], "finished")

    def test_stop_detached_cancels_the_child(self):
        h = self.make(git=True, mode="auto")

        def stubborn(messages, results, cancel):
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                if cancel is not None and cancel.is_set():
                    break
                time.sleep(0.05)
            return ChatResult(content="still going")

        routes = [
            ("parent: background map", calls_then([
                ToolCall("t1", "task", {
                    "description": "map auth",
                    "prompt": "look at pkg/auth.py and say where login lives",
                    "agent": "explorer",
                    "background": True,
                }),
            ], final="spawned")),
            ("look at pkg/auth.py", stubborn),
        ]
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            self._go(h, "parent: background map", routes)
            agent_id = h.of("agent_started")[-1]["id"]
            self.assertEqual(h.agent.stop_detached(agent_id), 1)
            deadline = time.monotonic() + 6
            while time.monotonic() < deadline:
                ended = [f for f in h.of("agent_ended") if f["id"] == agent_id]
                # "stopped" is announced before the child's checkout is cleaned up; the job leaves
                # the list only after that, and the fixture's folder must not vanish under it.
                if ended and agent_id not in (getattr(h.agent, "_detached_jobs", None) or {}):
                    self.assertEqual(ended[-1]["state"], "stopped")
                    return
                time.sleep(0.05)
            self.fail("detached child did not stop")
