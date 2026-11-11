"""A chat wakes itself up later, in the editor's backend (0.52, asked 8 Nov). A wake-up the model set with `wake_later`
falls due on an idle chat and starts a turn by itself: it says which wake-up it is ("wake-up: Check the tests", drawn
as "Woke up as planned"), the model is told what it said it would do, and the chat's row of waiting wake-ups (the
`wakeups` event) follows each change. Cancel is a command. A real Backend whose frames pass the protocol validator,
a real Agent. (Harness from test_agent_reports.)"""
from __future__ import annotations

import threading
import time
from unittest.mock import patch

from dgc import editor_protocol as ep, tools
from dgc.llm import ChatResult
from tests.test_agent_reports import BackendCase


class Clock:
    def __init__(self):
        self.now = time.time()

    def __call__(self):
        return self.now


class WakeupBackend(BackendCase):
    def setUp(self):
        super().setUp()
        self.backend.ui.wakeups_supported = True
        self.clock = Clock()
        self.agent.wakeups.clock = self.clock
        self.agent.wakeups.on_change = self.backend._on_wakeups      # as Backend.__init__ wires it
        self.addCleanup(self.backend._cancel_wakeup_timer)

    def rows(self):
        return [e["items"] for e in self.events if e["type"] == "wakeups"]

    def test_the_tools_are_offered_where_a_wake_up_can_wake_the_chat(self):
        names = lambda: {t["function"]["name"] for t in self.agent._monitor_schema_filter(tools.TOOL_SCHEMAS)}
        self.assertTrue({"wake_later", "wake_cancel"} <= names())
        self.agent.config.data["mode"] = "plan"
        self.assertFalse({"wake_later", "wake_cancel"} & names(), "plan mode starts nothing by itself")
        self.agent.config.data["mode"] = "default"
        self.backend.ui.wakeups_supported = False
        self.assertFalse({"wake_later", "wake_cancel"} & names(), "a frontend that can't start the turn offers none")

    def test_a_wake_up_falls_due_and_its_turn_starts_by_itself(self):
        said = tools.execute("wake_later", {"minutes": 30, "why": "Check the tests", "prompt": "Run the suite and say what failed."},
                             self.agent.ctx)
        self.assertIn("Set wake", said)
        self.assertEqual([i["why"] for i in self.rows()[-1]], ["Check the tests"], "the row shows it")
        seen = []

        def chat(messages, *args, **kwargs):
            seen.append(messages)
            return ChatResult(content="All 12 tests pass.")
        self.clock.now += 30 * 60
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.backend._wakeup_due()
            self.ends(1)
            self.join()
        start = next(e for e in self.events if e["type"] == "turn_start")
        self.assertEqual((start["kind"], start["prompt"]), ("monitor", "wake-up: Check the tests"))
        told = str(seen[0][-1]["content"])
        self.assertIn("This is the wake-up you set 30 minutes ago", told)
        self.assertIn("Run the suite and say what failed.", told)
        self.assertEqual(self.rows()[-1], [], "taken off the row")
        self.assertEqual(self.agent.wakeups.items(), [])

    def test_a_wake_up_that_falls_due_while_a_turn_runs_waits_for_it_to_end(self):
        tools.execute("wake_later", {"minutes": 5, "why": "Look again", "prompt": "Look again."}, self.agent.ctx)
        self.clock.now += 6 * 60
        with self.backend._turn_state_lock():
            self.backend._queue.append(("busy", None, None, "prompt", ""))   # a prompt waits: the chat isn't idle
        self.backend._wakeup_due()
        self.assertEqual([e for e in self.events if e["type"] == "turn_start"], [])
        self.assertEqual(len(self.agent.wakeups.items()), 1, "still waiting")
        with self.backend._turn_state_lock():
            self.backend._queue.clear()

    def test_cancel_is_a_command_and_the_row_follows(self):
        tools.execute("wake_later", {"minutes": 10, "why": "Check CI", "prompt": "Check CI."}, self.agent.ctx)
        wid = self.agent.wakeups.items()[0]["id"]
        command = {"type": "cancel_wakeup", "id": wid, "request_id": "r1"}
        self.assertIsNone(ep.command_error(command), "declared in the protocol")
        self.backend._handle_cancel_wakeup(command)
        self.assertEqual(self.agent.wakeups.items(), [])
        self.assertEqual(self.rows()[-1], [])
        self.backend._handle_cancel_wakeup({"type": "cancel_wakeup", "id": wid, "request_id": "r2"})
        rejected = [e for e in self.events if e["type"] == "command_rejected"]
        self.assertEqual(rejected[-1]["command"], "cancel_wakeup")
