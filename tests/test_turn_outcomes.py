"""Interrupted native work must not become CLI/editor success or goal completion."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.headless import Backend
from dgc.llm import ChatResult, ToolCall


class TurnOutcomeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-turn-outcome-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        config = object.__new__(Config)
        config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                           hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                           turn_budget_s=1, thinking="off")
        config._stored_secrets, config._env_secret_keys = {}, set()
        config.credential_warnings = ()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        self.events = []
        class UI:
            def __getattr__(_self, name):
                return lambda *args, **kwargs: self.events.append((name, args))
        self.agent = Agent(config, UI())
        self.addCleanup(self.agent.mcp.stop_all)
        self.now = 0.0
        replacement = patch("dgc.agent.time", types.SimpleNamespace(monotonic=lambda: self.now))
        replacement.start()
        self.addCleanup(replacement.stop)

    def deadline(self, *args, **kwargs):
        self.now += 2
        return ChatResult(content="Unfinished partial response", finish_reason="cancelled")

    def test_deadline_before_and_during_generation_never_succeeds(self):
        def expire_before_request():
            self.now += 2
            return False
        with patch.object(self.agent, "goal_budget_exhausted", side_effect=expire_before_request), \
                patch.object(self.agent.client, "chat") as chat:
            self.assertFalse(self.agent.run_turn("Inspect the fixture"))
            chat.assert_not_called()
        with patch.object(self.agent.client, "chat", side_effect=self.deadline) as chat:
            self.assertFalse(self.agent.run_turn("Inspect again"))
            self.assertEqual(chat.call_count, 1)
        self.assertIn("time limit", self.agent._last_turn_error)
        self.assertNotIn("Unfinished partial response", str(self.agent.messages[-1]))
        with patch.object(self.agent.client, "chat", return_value=ChatResult(content="Done")):
            self.assertTrue(self.agent.run_turn("A subsequent complete request"))
        self.assertEqual(self.agent._last_turn_error, "")

    def test_timeout_pauses_goal_and_discards_premature_completion_report(self):
        self.agent.set_goal("Finish the whole fixture")
        def claimed(*args, **kwargs):
            self.agent._pending_goal_report = {"status": "completed", "summary": "Premature",
                                               "evidence": ["Not verified"]}
            return self.deadline(*args, **kwargs)
        with patch.object(self.agent.client, "chat", side_effect=claimed):
            self.assertFalse(self.agent.run_turn("Start"))
        snapshot = self.agent.goal_snapshot()
        self.assertEqual(snapshot["status"], "paused")
        self.assertEqual(snapshot["evidence"], [])
        self.assertEqual(snapshot["cycles"], 1)

    def test_cli_exit_and_editor_terminal_event_agree_on_deadline(self):
        from dgc import cli
        facade = types.SimpleNamespace(agent=self.agent, ui=self.agent.ui, expand_mentions=lambda text: text)
        with patch.object(cli, "Config", return_value=self.agent.config), \
                patch.object(cli, "CLI", return_value=facade), \
                patch.object(cli.sessions_mod, "new_path", return_value=None), \
                patch.object(self.agent.client, "chat", side_effect=self.deadline), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["-p", "Inspect the fixture"]), 1)
        backend = object.__new__(Backend)
        backend.agent, backend.config, backend.ui = self.agent, self.agent.config, self.agent.ui
        backend._queue, backend._turn_n = [("Inspect again", None, [])], 0
        backend._worker = threading.current_thread()
        backend._emit_context = lambda: None
        captured = []
        backend.em = types.SimpleNamespace(emit=lambda event_type, **fields:
                                           captured.append({"type": event_type, **fields}))
        with patch.object(self.agent.client, "chat", side_effect=self.deadline):
            backend._run_turn_queue()
        terminal = [event for event in captured if event["type"] == "turn_end"]
        self.assertEqual(len(terminal), 1)
        self.assertEqual(terminal[0]["reason"], "error")
        self.assertIsNone(backend._worker)

    def test_user_stop_and_provider_cancelled_response_are_not_success(self):
        for user_stop in (False, True):
            with self.subTest(user_stop=user_stop):
                def cancel(*args, **kwargs):
                    if user_stop:
                        self.agent.cancelled.set()
                    return ChatResult(content="Partial", finish_reason="cancelled")
                with patch.object(self.agent.client, "chat", side_effect=cancel):
                    self.assertFalse(self.agent.run_turn("Inspect the fixture"))
                self.assertTrue(any(name == "info" and args == ("turn cancelled",)
                                    for name, args in self.events))


class TurnProseIdentityTests(unittest.TestCase):
    """The panel must never have to guess which prose was the answer, or what the loop is doing."""

    def setUp(self):
        import io as _io
        from dgc.editor_protocol import event_error
        from dgc.headless import HeadlessUI
        from dgc.protocol import Emitter, PendingRequests
        self.stream = _io.StringIO()
        self.emitter = Emitter(self.stream, validator=event_error)
        self.ui = HeadlessUI(self.emitter, PendingRequests())
        self.ui.turn_id = "t1"
        self.ui.reset_turn_messages()

    def events(self, kind=""):
        rows = [json.loads(line) for line in self.stream.getvalue().splitlines() if line.strip()]
        return [row for row in rows if not kind or row["type"] == kind]

    def test_a_gate_round_never_leaves_the_answer_ambiguous(self):
        # The exact shape the founder hit: an answer, a gate that continued the turn, tool work,
        # then the real answer. Every block is classified and the turn names the last one.
        self.ui.on_text("A first, finished-looking answer.")
        self.ui.end_stream("answer")
        self.ui.on_text("Now I will check something.")
        self.ui.end_stream("commentary")            # this round also called tools
        self.ui.tool_call("bash", {"command": "npm test"}, "c1")
        self.ui.tool_result("bash", "ok", "c1")
        self.ui.on_text("The real answer.")
        self.ui.end_stream("answer")
        closes = self.events("stream_end")
        self.assertEqual([(c["message_id"], c["phase"]) for c in closes],
                         [("t1:1", "answer"), ("t1:2", "commentary"), ("t1:3", "answer")])
        self.assertEqual(self.ui.final_message_id, "t1:3")

    def test_a_round_that_only_called_tools_is_not_a_message(self):
        # No prose streamed -> no id, so final_message_id can never name a block with no node.
        self.ui.end_stream("commentary")
        self.assertNotIn("message_id", self.events("stream_end")[0])
        self.ui.on_text("Done.")
        self.ui.end_stream("answer")
        self.assertEqual(self.ui.final_message_id, "t1:1")

    def test_an_unphased_close_keeps_the_compatibility_path(self):
        # A seam that states no phase still gets a designated answer, because turn_end is terminal.
        self.ui.on_text("Partial prose from a cancelled round.")
        self.ui.end_stream()
        closed = self.events("stream_end")[0]
        self.assertNotIn("phase", closed)
        self.assertEqual(self.ui.final_message_id, "t1:1")
        # ... but a stated answer outranks it, exactly as Codex orders the two rules.
        self.ui.on_text("The answer.")
        self.ui.end_stream("answer")
        self.assertEqual(self.ui.final_message_id, "t1:2")

    def test_a_long_answer_costs_one_activity_frame(self):
        # on_text runs per streamed chunk. Without the (state, label, detail) guard a single long
        # answer would spend thousands of frames against the 4MB event budget saying one word.
        for _ in range(500):
            self.ui.on_text("x")
        self.assertEqual([(e["state"], e["label"]) for e in self.events("turn_activity")],
                         [("responding", "Responding")])
        self.assertEqual(len(self.events("text_delta")), 500)

    def test_activity_names_each_step_and_repeats_none_of_them(self):
        from dgc.reasoning import ReasoningBlock
        thought = ReasoningBlock(key="r1", source="raw")
        self.ui.on_thinking("…", thought)
        self.ui.on_thinking("…", thought)
        self.ui.tool_call("read_file", {"path": "a.py"}, "c1")
        self.ui.tool_result("read_file", "contents", "c1")
        self.ui.tool_call("read_file", {"path": "b.py"}, "c2")     # a new target is a new step
        self.ui.tool_result("read_file", "contents", "c2")
        self.ui.hook_activity("PostToolUse", "started", configured=1)
        self.assertEqual([(e["state"], e["label"], e.get("detail", ""))
                          for e in self.events("turn_activity")],
                         [("thinking", "Thinking", ""),
                          ("tool", "Reading a file", "a.py"),
                          ("waiting", "Waiting for the model", ""),
                          ("tool", "Reading a file", "b.py"),
                          ("waiting", "Waiting for the model", ""),
                          ("hook", "Running PostToolUse hooks", "")])
        self.assertTrue(all(e["turn_id"] == "t1" for e in self.events("turn_activity")))

    def test_a_gate_that_continues_the_turn_says_so(self):
        # The six gates were correct and silent, which is why a finished-looking answer was
        # followed by a burst of tool calls under a spinner that could only say "working".
        agent = object.__new__(Agent)
        agent.ui = self.ui
        agent._activity("continuing", "Finishing open todos")
        agent._activity("continuing", "Finishing open todos")       # unchanged -> no second frame
        agent._activity("verifying", "Running the check", "npm test")
        self.assertEqual([(e["state"], e["label"], e.get("detail", ""))
                          for e in self.events("turn_activity")],
                         [("continuing", "Finishing open todos", ""),
                          ("verifying", "Running the check", "npm test")])

    def test_the_turn_publishes_the_id_of_the_block_it_designates(self):
        """End to end: the worker numbers the turn, the loop classifies, turn_end names the answer."""
        directory = tempfile.TemporaryDirectory(prefix="dgc-turn-final-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        config = object.__new__(Config)
        config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                           hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                           thinking="off")
        config._stored_secrets, config._env_secret_keys = {}, set()
        config.credential_warnings = ()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        (root / "answer.txt").write_text("green\n")
        agent = Agent(config, self.ui)
        self.addCleanup(agent.mcp.stop_all)
        rounds = iter([
            ChatResult(content="Looking at the saved result.",
                       tool_calls=[ToolCall("c1", "read_file", {"path": "answer.txt"})]),
            ChatResult(content="All green."),
        ])
        def streamed(*args, **kwargs):
            result = next(rounds)
            kwargs["on_text"](result.content)       # the provider streams prose, as it does live
            return result
        backend = object.__new__(Backend)
        backend.agent, backend.config, backend.ui = agent, config, self.ui
        backend._queue, backend._turn_n = [("Run the tests", None, [])], 0
        backend._worker = threading.current_thread()
        backend._emit_context = lambda: None
        backend.em = self.emitter
        with patch.object(agent.client, "chat", side_effect=streamed):
            backend._run_turn_queue()
        closes = self.events("stream_end")
        self.assertEqual([(c.get("message_id"), c.get("phase")) for c in closes],
                         [("t1:1", "commentary"), ("t1:2", "answer")])
        end = self.events("turn_end")[0]
        self.assertEqual(end["reason"], "completed")
        self.assertEqual(end["final_message_id"], "t1:2")
        # The activity row is driven by stated facts for the whole turn, never by a static verb.
        self.assertEqual([e["state"] for e in self.events("turn_activity")][:4],
                         ["waiting", "responding", "tool", "waiting"])

    def test_a_front_end_without_the_seam_is_not_broken_by_it(self):
        class Older:
            def __init__(self): self.closed = []
            def end_stream(self): self.closed.append(True)
        agent = object.__new__(Agent)
        agent.ui = Older()
        agent._activity("continuing", "Finishing open todos")       # must not raise
        self.assertEqual(agent.ui.closed, [])


if __name__ == "__main__":
    unittest.main()
