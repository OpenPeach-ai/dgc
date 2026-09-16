"""Plan 3: background task children outlive the parent turn and notify when they land."""
from __future__ import annotations

import time
from unittest.mock import patch

from dgc.config import Config
from dgc.headless import HeadlessUI
from dgc.llm import ChatResult, LLMClient, ToolCall
from test_subagents import HarnessCase, Script, calls_then, child, clone_fixture


class BackgroundTaskTests(HarnessCase):
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
            ("look at pkg/auth.py", child("Auth is in pkg/auth.py.\nFILES: pkg/auth.py", sleep=0.6)),
        ]
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            started = time.monotonic()
            self._go(h, "parent: background map", routes)
            self.assertLess(time.monotonic() - started, 0.5, "the parent turn must not wait for the child")
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
                if ended:
                    self.assertEqual(ended[-1]["state"], "stopped")
                    return
                time.sleep(0.05)
            self.fail("detached child did not stop")
