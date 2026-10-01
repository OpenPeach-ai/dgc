"""A parent steering a running sub-agent names that agent, the way Codex does.

The row read "Used tool · message task" in the editor and a bare `message_task` in the terminal: a
message to no one in particular, from a parent that had started two or three children. Codex says
"Sent message to <agent>". The agent is named by what it was asked to do -- `sub-<hex>` names
nothing a reader recognises -- live, and again when the chat is reopened. Display only: the
arguments the model sent are never changed.
"""
from __future__ import annotations

import json
import time
import unittest
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc import sessions
from dgc.agent import Agent
from dgc.config import Config
from dgc.headless import HeadlessUI
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.protocol import Emitter, PendingRequests
from dgc.subagents import SubagentRegistry
from dgc.ui import arg_summary
import test_tool_activity_once as activity
from test_subagents import HarnessCase, Script, _Stream, child, clone_fixture

CHILD = "sub-0123456789ab"


class TheSummaryNamesTheAgentTest(unittest.TestCase):
    def test_the_agent_it_was_asked_to_be_not_its_id(self):
        for name in ("message_task", "close_task"):
            with self.subTest(name=name):
                args = {"id": CHILD, "text": "use the new schema", "agent": "Write the parser"}
                self.assertEqual(arg_summary(name, args), "Write the parser")

    def test_the_id_when_nothing_better_is_known(self):
        self.assertEqual(arg_summary("message_task", {"id": CHILD, "text": "x"}), CHILD)
        self.assertEqual(arg_summary("close_task", {"id": CHILD}), CHILD)

    def test_the_message_itself_is_not_the_summary(self):
        # What was said is the card's body; the head says who it went to.
        summary = arg_summary("message_task", {"id": CHILD, "text": "use the new schema"})
        self.assertNotIn("schema", summary)

    def test_one_line_and_bounded(self):
        summary = arg_summary("message_task", {"id": CHILD, "agent": "line one\nline two " + "x" * 200})
        self.assertNotIn("\n", summary)
        self.assertTrue(summary.startswith("line one line two"))
        self.assertEqual(len(summary), 121)
        self.assertTrue(summary.endswith("…"))

    def test_dgc_print_mode_names_it_too(self):
        from dgc.cli import UI
        self.assertEqual(UI._arg_summary("message_task", {"id": CHILD, "agent": "Write the parser"}),
                         "Write the parser")
        self.assertEqual(UI._arg_summary("close_task", {"id": CHILD}), CHILD)


class TheAgentResolvesItTest(unittest.TestCase):
    """`Agent._with_task_agent`: running, finished, or known only from the chat's saved record."""

    def parent(self, *, live=None, finished=None, registry=None) -> Agent:
        parent = object.__new__(Agent)
        parent._detached_jobs = dict(live or {})
        parent._finished_jobs = dict(finished or {})
        parent.subagents = registry or SubagentRegistry()
        return parent

    def resolved(self, parent, name="message_task", **args):
        return parent._with_task_agent(name, {"id": CHILD, "text": "go", **args})

    def test_a_running_child(self):
        parent = self.parent(live={CHILD: {"description": "Write the parser", "agent": None}})
        self.assertEqual(self.resolved(parent)["agent"], "Write the parser")

    def test_a_child_that_already_finished(self):
        parent = self.parent(finished={CHILD: {"id": CHILD, "description": "Write the parser"}})
        self.assertEqual(self.resolved(parent)["agent"], "Write the parser")

    def test_a_child_known_only_from_a_reopened_chat(self):
        registry = SubagentRegistry()
        registry.start(id=CHILD, description="Write the parser")
        parent = self.parent(registry=registry)
        self.assertEqual(self.resolved(parent)["agent"], "Write the parser")
        self.assertEqual(self.resolved(parent, name="close_task")["agent"], "Write the parser")

    def test_an_id_this_chat_never_ran_names_no_one(self):
        resolved = self.resolved(self.parent())
        self.assertNotIn("agent", resolved)
        self.assertEqual(arg_summary("message_task", resolved), CHILD)

    def test_never_the_models_own_arguments(self):
        parent = self.parent(live={CHILD: {"description": "Write the parser"}})
        sent = {"id": CHILD, "text": "go"}
        shown = parent._with_task_agent("message_task", sent)
        self.assertEqual(sent, {"id": CHILD, "text": "go"}, "the model's call was rewritten")
        self.assertIsNot(shown, sent)

    def test_no_other_tool_is_touched(self):
        parent = self.parent(live={CHILD: {"description": "Write the parser"}})
        args = {"id": CHILD, "description": "x"}
        self.assertIs(parent._with_task_agent("task", args), args)
        self.assertIs(parent._with_task_agent("wait_tasks", args), args)


class TheTerminalSaysItTest(unittest.TestCase):
    # The real TUI over a real Agent, as tests/test_tool_activity_once.py builds it. Borrowed,
    # not inherited, so that file's own test does not run twice.
    setUp = activity.TuiStatusLineTests.setUp
    tui = activity.TuiStatusLineTests.tui
    plain = staticmethod(activity.TuiStatusLineTests.plain)

    def test_sending_then_sent_message_to_the_agent(self):
        ui = self.tui()
        ui._turn.set()
        ui._turn_t0 = time.monotonic()
        ui.tool_call("message_task", {"id": CHILD, "text": "use the new schema",
                                      "agent": "Write the parser"}, "m1")
        self.assertIn("Sending message to Write the parser", self.plain(ui._tool_frags(ui.blocks[-1])))
        ui.tool_result("message_task", f"Delivered to {CHILD}, folded into the work.", "m1")
        done = self.plain(ui._tool_frags(ui.blocks[-1]))
        self.assertIn("Sent message to Write the parser", done)
        self.assertNotIn("message_task", done, "the raw tool name was the whole header")

    def test_stopping_then_stopped(self):
        ui = self.tui()
        ui._turn.set()
        ui._turn_t0 = time.monotonic()
        ui.tool_call("close_task", {"id": CHILD, "agent": "Write the parser"}, "k1")
        self.assertIn("Stopping Write the parser", self.plain(ui._tool_frags(ui.blocks[-1])))
        ui.tool_result("close_task", f"Signalled {CHILD} to stop.", "k1")
        self.assertIn("Stopped Write the parser", self.plain(ui._tool_frags(ui.blocks[-1])))


class ARealTurnNamesItTest(HarnessCase):
    """Through `run_turn`: the row the editor draws, and the row a reopened chat draws."""

    CHILD_SECONDS = 1.5

    def test_the_live_row_and_the_reopened_row_name_the_agent(self):
        h = self.make(git=True, mode="auto")
        # The normal session location, so reopening goes through production's path validation.
        h.agent.session_file = sessions.new_path(h.config.project_root)
        ended = []
        h.agent.on_detached_ended = ended.append
        spawned = {}

        def parent(messages, results, cancel):
            asked = next((i for i, m in enumerate(messages) if m.get("role") == "user"
                          and "now message it" in str(m.get("content", ""))), None)
            if asked is not None:
                if not any(m.get("role") == "tool" for m in messages[asked:]):
                    return ChatResult(tool_calls=[ToolCall("m1", "message_task", {
                        "id": spawned["id"], "text": "also say where logout lives"})])
                return ChatResult(content="sent")
            if not results:
                return ChatResult(tool_calls=[ToolCall("t1", "task", {
                    "description": "map auth", "prompt": "look at pkg/auth.py and say where login lives",
                    "agent": "explorer", "background": True})])
            return ChatResult(content="spawned")

        routes = [("look at pkg/auth.py", child("Auth is in pkg/auth.py.", sleep=self.CHILD_SECONDS)),
                  ("parent: background map", parent)]

        def turn(prompt):
            if isinstance(h.ui, HeadlessUI):
                h.ui.turn_id = prompt[:12]
                h.ui.reset_turn_messages()
            return h.agent.run_turn(prompt)

        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            turn("parent: background map")
            spawned["id"] = h.of("agent_started")[-1]["id"]
            turn("now message it")
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not ended:
                time.sleep(0.05)
        self.assertTrue(ended, "premise: the child finished")

        live = [f for f in h.of("tool_call") if f.get("call_id") == "m1"]
        self.assertEqual(len(live), 1, h.of("tool_call"))
        self.assertEqual(live[0]["summary"], "map auth", "the live row named no agent")

        # The model's own call is what the transcript keeps: no display field leaked into it.
        sent = [tc for m in h.agent.messages if m.get("role") == "assistant"
                for tc in (m.get("tool_calls") or []) if tc.get("id") == "m1"]
        self.assertEqual(len(sent), 1)
        self.assertNotIn("agent", json.loads(sent[0]["function"]["arguments"]))

        # Reopened in a fresh process: no live handle, no finished list -- only the saved record.
        saved = h.agent.session_file
        fresh = Agent(h.config, HeadlessUI(Emitter(_Stream(), validator=ep.event_error), PendingRequests()))
        self.addCleanup(fresh.mcp.stop_all)
        self.assertTrue(fresh.load_session(saved))
        self.assertFalse(getattr(fresh, "_detached_jobs", None))
        self.assertFalse(getattr(fresh, "_finished_jobs", None))
        h.backend.agent = fresh
        try:
            replayed = [i for i in h.backend._history()
                        if i.get("type") == "tool_call" and i.get("call_id") == "m1"]
        finally:
            h.backend.agent = h.agent
        self.assertEqual(len(replayed), 1)
        self.assertEqual(replayed[0]["summary"], "map auth", "the reopened row named no agent")
        self.assertFramesValid(h)


if __name__ == "__main__":
    unittest.main()
