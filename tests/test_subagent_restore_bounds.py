"""Saved task arguments with malformed JSON must not break agent-map restoration."""

import unittest

from dgc.subagents import _task_calls


class SubagentRestoreBoundsTests(unittest.TestCase):
    def test_deep_task_arguments_are_ignored(self):
        raw = '{"tasks":' + '[' * 10000 + '0' + ']' * 10000 + '}'
        messages = [{"role": "assistant", "tool_calls": [
            {"id": "call_1", "function": {"name": "task", "arguments": raw}}]}]
        self.assertEqual(list(_task_calls(messages))[0][3], {})
