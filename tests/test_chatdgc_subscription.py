"""A ChatDGC subscription keeps one restricted CLI alive across DGC tool calls."""
import json
import unittest

from dgc.chatdgc.subscription_client import SubscriptionChatClient
from tests.test_pip_brain import install_clis
from tests.test_pip_eyes import catalog_setup


class SubscriptionClientTests(unittest.TestCase):
    def setUp(self):
        catalog_setup(self)
        self.bin = install_clis(self)

    def test_tool_answer_returns_to_the_same_restricted_cli(self):
        (self.bin / "script.json").write_text(json.dumps([
            {"call": "look", "args": {"topic": "status"}},
            {"say": "The status is healthy."},
        ]))
        tools = [{"type": "function", "function": {"name": "look", "description": "Read status.",
                  "parameters": {"type": "object", "properties": {"topic": {"type": "string"}}}}}]
        for engine in ("claude", "codex"):
            with self.subTest(engine=engine):
                client = SubscriptionChatClient(engine)
                try:
                    messages = [{"role": "system", "content": "Use DGC tools only."},
                                {"role": "user", "content": "What is the status?"}]
                    first = client.chat(messages, tools)
                    self.assertEqual(first.finish_reason, "tool_calls")
                    self.assertEqual([(call.name, call.arguments) for call in first.tool_calls],
                                     [("look", {"topic": "status"})])
                    messages.append({"role": "assistant", "content": first.content,
                                     "tool_calls": [{"id": first.tool_calls[0].id, "type": "function",
                                                     "function": {"name": "look", "arguments": '{"topic":"status"}'}}]})
                    messages.append({"role": "tool", "tool_call_id": first.tool_calls[0].id,
                                     "content": "healthy"})
                    second = client.chat(messages, tools)
                    self.assertIn("healthy", second.content)
                    seen = json.loads((self.bin / "seen.json").read_text())
                    self.assertEqual(seen["tools"], ["look"])
                    self.assertEqual(len(seen["answers"]), 1, "the tool must not run again on continuation")
                    self.assertIn("healthy", seen["answers"][0]["text"])
                    self.assertNotIn("shell", seen["tools"])
                finally:
                    client.close()


if __name__ == "__main__":
    unittest.main()
