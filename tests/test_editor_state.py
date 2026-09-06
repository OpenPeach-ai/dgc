"""Restored editor state and request acknowledgement boundaries."""
import json
import types
import unittest

from dgc.headless import Backend, _MAX_PROMPT_CHARS
from dgc.subscriptions import ENGINES


class EditorStateTests(unittest.TestCase):
    def backend(self):
        backend = object.__new__(Backend)
        backend.agent = types.SimpleNamespace(messages=[])
        backend.config = types.SimpleNamespace(data={}, get=lambda key, default=None: default)
        self.events = []
        backend.em = types.SimpleNamespace(emit=lambda kind, **value: self.events.append({"type": kind, **value}))
        return backend

    def test_history_preserves_tool_correlation_without_inventing_success(self):
        backend = self.backend()
        backend.agent.messages = [
            {"role": "assistant", "content": "Checking", "tool_calls": [{"id": "__proto__", "function": {
                "name": "bash", "arguments": '{"command":"npm test"}'}}]},
            {"role": "tool", "tool_call_id": "__proto__", "content": "Error: exit code 1"},
            {"role": "assistant", "content": "Tests failed."},
        ]
        history = backend._history()
        self.assertEqual(history[0]["tool_details"][0]["output"], "Error: exit code 1")
        self.assertEqual(history[0]["tool_details"][0]["status"], "returned")
        self.assertTrue(history[0]["commentary"])
        self.assertEqual(history[-1]["text"], "Tests failed.")

    def test_large_unicode_history_stays_within_wire_budget_and_keeps_latest(self):
        backend = self.backend()
        backend.agent.messages = [{"role": "assistant", "content": "\u4e16" * 100000}] * 30
        backend.agent.messages += [{"role": "user", "content": "Latest request"}]
        history = backend._history()
        self.assertLess(len(json.dumps(history)), 1_001_000)
        self.assertEqual(history[0]["role"], "notice")
        self.assertEqual(history[-1]["text"], "Latest request")
        self.assertEqual(len(backend.agent.messages), 31)

    def test_prompt_acknowledgement_and_rejections_are_correlated(self):
        backend = self.backend()
        backend._start_turn = lambda *args: ("queued", 2)
        backend.dispatch({"type": "prompt", "text": "test", "request_id": "p1"})
        self.assertIn({"type": "prompt_accepted", "request_id": "p1", "state": "queued"}, self.events)
        backend.dispatch({"type": "prompt", "text": "x" * (_MAX_PROMPT_CHARS + 1), "request_id": "p2"})
        self.assertEqual(self.events[-1]["request_id"], "p2")
        self.assertEqual(self.events[-1]["type"], "command_rejected")
        backend._start_turn = lambda *args: ("full", 16)
        backend.dispatch({"type": "prompt", "text": "test", "request_id": "p3"})
        self.assertEqual(self.events[-1]["request_id"], "p3")
        self.assertEqual(self.events[-1]["reason"], "queue_full")

    def test_legacy_codex_max_uses_the_supported_wire_effort(self):
        argv = ENGINES["codex"].build_argv("codex", "test", cont=False, effort="max")
        self.assertIn('model_reasoning_effort="xhigh"', argv)
        self.assertNotIn('model_reasoning_effort="max"', argv)
