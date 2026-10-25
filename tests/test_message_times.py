"""When each prompt was sent and each reply written, for the chat to show (founder, 2026-10-17: "there is no
timestamp or date for user sent prompts and model's responses").

The agent stamps ``_dgc_at`` (seconds since 1970) on the prompt and on every reply it writes. Like every ``_dgc_``
key it stays in the session file and never reaches the model. A reopened chat's history carries the times as
``{"role": "time"}`` markers: a field on turn_start would be a field on an existing event, which the SDK refuses.
"""
from __future__ import annotations

import copy
import http.server
import json
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path

from dgc import editor_protocol as ep
from dgc.agent import Agent
from dgc.headless import Backend
from dgc.llm import ChatResult, LLMClient, ToolCall
from test_monitors import FrontendUI, make_config, scripted   # HOME is already redirected there


class AgentStampTests(unittest.TestCase):
    def agent(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-times-agent-")
        self.addCleanup(directory.cleanup)
        agent = Agent(make_config(Path(directory.name), mode="auto"), FrontendUI())
        self.addCleanup(agent.mcp.stop_all)
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        return agent

    def test_a_prompt_and_its_reply_carry_when_they_were_written(self):
        agent = self.agent()
        scripted(agent, [ChatResult(content="Here it is.")])
        before = time.time()
        self.assertTrue(agent.run_turn("what changed?"))
        after = time.time()
        prompt = next(m for m in agent.messages if m.get("role") == "user")
        reply = agent.messages[-1]
        self.assertEqual(reply["role"], "assistant")
        self.assertLessEqual(before - 0.01, prompt["_dgc_at"])
        self.assertLessEqual(prompt["_dgc_at"], reply["_dgc_at"])
        self.assertLessEqual(reply["_dgc_at"], after + 0.01)

    def test_every_model_round_is_stamped_and_tool_results_are_not(self):
        agent = self.agent()
        scripted(agent, [ChatResult(content="", tool_calls=[ToolCall("c1", "bash", {"command": "echo hi"})],
                                    finish_reason="tool_calls"),
                         ChatResult(content="Done.")])
        self.assertTrue(agent.run_turn("run it"))
        replies = [m for m in agent.messages if m.get("role") == "assistant"]
        self.assertEqual(len(replies), 2)
        self.assertTrue(all(isinstance(m.get("_dgc_at"), float) for m in replies))
        self.assertFalse(any("_dgc_at" in m for m in agent.messages if m.get("role") == "tool"))

    def test_messages_already_in_the_transcript_are_left_alone(self):
        agent = self.agent()
        agent.messages.extend([{"role": "user", "content": "earlier"}, {"role": "assistant", "content": "ok"}])
        saved = copy.deepcopy(agent.messages)
        scripted(agent, [ChatResult(content="Fine.")])
        self.assertTrue(agent.run_turn("and now?"))
        self.assertEqual(agent.messages[:len(saved)], saved, "a session saved before times were kept stays as it was")


class WireTests(unittest.TestCase):
    """The stamp is for the chat: no provider ever receives it."""

    def serve(self, reply):
        bodies = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path.endswith(("/api/chat", "/chat/completions", "/messages", "/responses")):
                    bodies.append(body)
                raw = json.dumps(reply(self.path)).encode()
                self.send_response(200 if not self.path.endswith("/api/show") else 404)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}", bodies

    MESSAGES = [{"role": "user", "content": "hello", "_dgc_at": 1_760_000_000.5},
                {"role": "assistant", "content": "hi", "_dgc_at": 1_760_000_001.25},
                {"role": "user", "content": "again", "_dgc_at": 1_760_000_002.0}]

    def check(self, api_mode, path, reply):
        url, bodies = self.serve(reply)
        client = LLMClient(url + path, "", "times-model", api_mode=api_mode, read_timeout=10)
        client.chat(copy.deepcopy(self.MESSAGES))
        self.assertTrue(bodies)
        for body in bodies:
            self.assertNotIn("_dgc_at", json.dumps(body))
            self.assertNotIn("1760000000", json.dumps(body))

    def test_native_ollama(self):
        self.check("ollama", "", lambda path: {"message": {"role": "assistant", "content": "ok"}, "done": True,
                                                "done_reason": "stop"})

    def test_chat_completions(self):
        self.check("chat_completions", "/v1", lambda path: {"choices": [{"index": 0, "finish_reason": "stop",
                                                            "message": {"role": "assistant", "content": "ok"}}]})

    def test_anthropic_messages(self):
        self.check("anthropic", "/v1", lambda path: {"id": "m1", "type": "message", "stop_reason": "end_turn",
                                                      "content": [{"type": "text", "text": "ok"}]})


class HistoryTests(unittest.TestCase):
    def history(self, messages):
        backend = object.__new__(Backend)
        backend.agent = types.SimpleNamespace(messages=messages)
        backend.config = types.SimpleNamespace(data={}, get=lambda key, default=None: default)
        backend.em = types.SimpleNamespace(emit=lambda kind, **value: None)
        return backend._history()

    def test_a_saved_turn_says_when_its_prompt_was_sent_and_its_reply_written(self):
        items = self.history([
            {"role": "user", "content": "first", "_dgc_at": 1_760_000_000.0},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "function": {
                "name": "bash", "arguments": '{"command":"ls"}'}}], "_dgc_at": 1_760_000_003.0},
            {"role": "tool", "tool_call_id": "c1", "content": "a.txt"},
            {"role": "assistant", "content": "One file.", "_dgc_at": 1_760_000_009.5},
            {"role": "user", "content": "second", "_dgc_at": 1_760_000_100.0},
            {"role": "assistant", "content": "Yes.", "_dgc_at": 1_760_000_104.0},
        ])
        shape = [item.get("type") or f'{item["role"]}:{item.get("of")}' for item in items]
        self.assertEqual(shape, ["turn_start", "time:prompt", "tool_call", "tool_result", "text_delta", "stream_end",
                                 "time:reply", "turn_end",
                                 "turn_start", "time:prompt", "text_delta", "stream_end", "time:reply", "turn_end"])
        times = [(item["of"], item["at"]) for item in items if item.get("role") == "time"]
        self.assertEqual(times, [("prompt", 1_760_000_000.0), ("reply", 1_760_000_009.5),
                                 ("prompt", 1_760_000_100.0), ("reply", 1_760_000_104.0)],
                         "the reply's time is its last message's, after the tools")

    def test_the_turn_events_are_unchanged(self):
        stamped = self.history([{"role": "user", "content": "q", "_dgc_at": 1_760_000_000.0},
                                {"role": "assistant", "content": "a", "_dgc_at": 1_760_000_001.0}])
        plain = self.history([{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}])
        self.assertEqual([item for item in stamped if item.get("role") != "time"], plain)
        for item in stamped:
            if "type" in item:
                self.assertIsNone(ep.event_error({**item, "seq": 0}), item)
            else:
                self.assertEqual(set(item), {"role", "of", "at"}, "a marker, not an event")

    def test_a_session_saved_before_times_were_kept_has_no_markers(self):
        items = self.history([{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}])
        self.assertFalse(any(item.get("role") == "time" for item in items))

    def test_a_value_that_is_not_a_time_is_left_out(self):
        for bad in ("1760000000", None, True, float("nan"), float("inf"), -5, 12, time.time() + 30 * 86400):
            items = self.history([{"role": "user", "content": "q", "_dgc_at": bad},
                                  {"role": "assistant", "content": "a", "_dgc_at": bad}])
            self.assertFalse(any(item.get("role") == "time" for item in items), bad)


if __name__ == "__main__":
    unittest.main()


class SteeringTimeTests(unittest.TestCase):
    """The founder, 25 Oct: "the mid-turn sent prompts do not get the timestamp like usual prompts". A message sent while
    a turn runs keeps the time it was sent, and a reopened chat shows it under that message's own bubble."""

    def agent(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-times-steer-")
        self.addCleanup(directory.cleanup)
        agent = Agent(make_config(Path(directory.name), mode="auto"), FrontendUI())
        self.addCleanup(agent.mcp.stop_all)
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        return agent

    def test_each_steered_message_keeps_when_it_was_sent(self):
        agent = self.agent()
        agent._accepting_steer = True
        before = time.time()
        self.assertTrue(agent.steer("use staging-2"))
        self.assertTrue(agent.steer("and run the tests"))
        self.assertTrue(agent._drain_steer())
        message = agent.messages[-1]
        self.assertEqual(message["_dgc_steering"], ["use staging-2", "and run the tests"])
        sent = message["_dgc_steering_at"]
        self.assertEqual(len(sent), 2)
        for at in sent:
            self.assertGreaterEqual(at, before - 1)
            self.assertLessEqual(at, time.time() + 1)

    def history(self, messages):
        return HistoryTests.history(self, messages)

    def test_a_reopened_chat_has_a_time_marker_before_each_steered_message(self):
        from dgc.workflows import STEERING_PREFIX, STEERING_SUFFIX
        items = self.history([
            {"role": "user", "content": "deploy it", "_dgc_at": 1_760_000_000.0},
            {"role": "user", "content": STEERING_PREFIX + "use staging-2\nand run the tests" + STEERING_SUFFIX,
             "_dgc_steering": ["use staging-2", "and run the tests"],
             "_dgc_steering_at": [1_760_000_030.0, 1_760_000_041.5]},
            {"role": "assistant", "content": "Done.", "_dgc_at": 1_760_000_090.0},
        ])
        shape = [item.get("type") or f'{item["role"]}:{item.get("of") or item.get("text")}' for item in items]
        self.assertEqual(shape[:6], ["turn_start", "time:prompt", "time:steering", "steering:use staging-2",
                                     "time:steering", "steering:and run the tests"])
        self.assertEqual([item["at"] for item in items if item.get("of") == "steering"], [1_760_000_030.0, 1_760_000_041.5])

    def test_a_steer_saved_before_times_were_kept_has_no_marker(self):
        from dgc.workflows import STEERING_PREFIX, STEERING_SUFFIX
        items = self.history([
            {"role": "user", "content": "deploy it"},
            {"role": "user", "content": STEERING_PREFIX + "use staging-2" + STEERING_SUFFIX, "_dgc_steering": ["use staging-2"]},
            {"role": "assistant", "content": "Done."}])
        self.assertFalse([item for item in items if item.get("of") == "steering"])
        self.assertTrue([item for item in items if item.get("role") == "steering"])


class UndoFindsATurnWithFilesOpenTests(unittest.TestCase):
    """The D2 recording, 25 Oct: the Edited card's Undo said "DGC can no longer undo that turn" whenever a file was open,
    because the turn's checkpoint was labelled with the editor's context block instead of the prompt."""

    def test_the_checkpoint_label_is_the_prompt_not_the_editor_context(self):
        from dgc.editor_context import _strip_editor_context
        directory = tempfile.TemporaryDirectory(prefix="dgc-undo-label-")
        self.addCleanup(directory.cleanup)
        agent = Agent(make_config(Path(directory.name), mode="auto"), FrontendUI())
        self.addCleanup(agent.mcp.stop_all)
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        context = ('<editor-context-json trust="untrusted-reference-data">\n'
                   '{"open_files":[{"path":"/home/me/shop/billing.py"}]}\n</editor-context-json>\n\n')
        prompt = "Review the billing module and fix what's wrong"
        self.assertEqual(_strip_editor_context(context + prompt), prompt, "the stripper this relies on")
        scripted(agent, [ChatResult(content="Done.")])
        self.assertTrue(agent.run_turn(context + prompt))
        label = agent.checkpoints.points[-1]["preview"]
        self.assertEqual(label, prompt[:70], "the label the editor's Undo matches is the prompt the user sees")
        self.assertNotIn("editor-context", label)
