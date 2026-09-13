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
        # Restored work is replayed through the SAME events a live turn emits, so the panel drives
        # the same builders: a real tool card with its real output, not prose.
        kinds = [item.get("type") or item.get("role") for item in history]
        self.assertEqual(kinds, ["turn_start", "text_delta", "stream_end", "tool_call",
                                 "tool_result", "text_delta", "stream_end", "turn_end"])
        result = history[4]
        self.assertEqual(result["output"], "Error: exit code 1")
        self.assertEqual(result["call_id"], "__proto__")
        self.assertEqual(result["name"], "bash")
        self.assertTrue(result["is_error"])          # the saved output classifies itself
        self.assertEqual(history[3]["args"], {"command": "npm test"})
        # Prose beside a tool call is commentary; prose with no call is the answer, and the turn
        # says which block that was instead of leaving the panel to guess from position.
        self.assertEqual(history[2]["phase"], "commentary")
        self.assertEqual(history[6]["phase"], "answer")
        self.assertEqual(history[5]["text"], "Tests failed.")
        self.assertEqual(history[-1]["final_message_id"], history[6]["message_id"])

    def test_history_recovers_a_reviewed_diff_from_the_saved_output_alone(self):
        # No session-file migration: split_diff is a pure function of the output string, so a
        # restored patch comes back as a diff card exactly as the live one did.
        backend = self.backend()
        patch = "--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-old\n+new\n"
        backend.agent.messages = [
            {"role": "user", "content": "Patch it"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "function": {
                "name": "apply_patch", "arguments": '{"path":"x.py"}'}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "Applied.\n" + patch},
        ]
        result = next(item for item in backend._history() if item.get("type") == "tool_result")
        self.assertTrue(result["is_diff"])
        self.assertTrue(result["diff"].startswith("--- a/x.py"))
        self.assertFalse(result["is_error"])
        # A round that called tools and wrote nothing contributes no prose block at all.
        self.assertFalse([i for i in backend._history() if i.get("type") == "text_delta"])

    def test_large_unicode_history_stays_within_wire_budget_and_keeps_latest(self):
        backend = self.backend()
        backend.agent.messages = [{"role": "assistant", "content": "\u4e16" * 100000}] * 30
        backend.agent.messages += [{"role": "user", "content": "Latest request"}]
        history = backend._history()
        self.assertLess(len(json.dumps(history)), 1_001_000)
        self.assertEqual(history[0]["role"], "notice")
        self.assertEqual(history[-1]["type"], "turn_end")
        self.assertEqual(history[-2]["prompt"], "Latest request")
        # A dropped prefix must never leave the panel a turn that begins in the middle.
        self.assertIn(history[1].get("type"), (None, "turn_start"))
        self.assertEqual(len(backend.agent.messages), 31)

    def test_prompt_acknowledgement_and_rejections_are_correlated(self):
        backend = self.backend()
        backend._start_turn = lambda *args, **kwargs: ("queued", 2)
        backend.dispatch({"type": "prompt", "text": "test", "request_id": "p1"})
        self.assertIn({"type": "prompt_accepted", "request_id": "p1", "state": "queued"}, self.events)
        backend.dispatch({"type": "prompt", "text": "x" * (_MAX_PROMPT_CHARS + 1), "request_id": "p2"})
        self.assertEqual(self.events[-1]["request_id"], "p2")
        self.assertEqual(self.events[-1]["type"], "command_rejected")
        backend._start_turn = lambda *args, **kwargs: ("full", 16)
        backend.dispatch({"type": "prompt", "text": "test", "request_id": "p3"})
        self.assertEqual(self.events[-1]["request_id"], "p3")
        self.assertEqual(self.events[-1]["reason"], "queue_full")

    def test_legacy_codex_max_uses_the_supported_wire_effort(self):
        argv = ENGINES["codex"].build_argv("codex", "test", cont=False, effort="max")
        self.assertIn('model_reasoning_effort="xhigh"', argv)
        self.assertNotIn('model_reasoning_effort="max"', argv)
