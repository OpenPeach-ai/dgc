"""A ChatDGC subscription keeps one restricted CLI alive across DGC tool calls."""
import json
import sys
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

    def test_an_older_claude_code_still_answers(self):
        """Its help doesn't list --restricted, and it refuses the whole command for it (seen with 2.1.220)."""
        (self.bin / "old-claude").write_text("")
        (self.bin / "script.json").write_text(json.dumps([{"say": "Hello from the older CLI."}]))
        client = SubscriptionChatClient("claude")
        try:
            result = client.chat([{"role": "user", "content": "Hello?"}], [])
        finally:
            client.close()
        self.assertIn("Hello from the older CLI.", result.content)
        seen = json.loads((self.bin / "seen.json").read_text())
        self.assertNotIn("--restricted", seen["argv"])
        for held in ("--strict-mcp-config", "--setting-sources", "--tools", "--permission-mode"):
            self.assertIn(held, seen["argv"], "the older CLI stays as confined")

    def test_a_current_claude_code_keeps_restricted(self):
        (self.bin / "script.json").write_text(json.dumps([{"say": "Hello."}]))
        client = SubscriptionChatClient("claude")
        try:
            client.chat([{"role": "user", "content": "Hello?"}], [])
        finally:
            client.close()
        self.assertIn("--restricted", json.loads((self.bin / "seen.json").read_text())["argv"])

    def test_a_cli_that_refuses_the_command_says_it_is_too_old(self):
        """Not "check its sign-in": that was the wrong place to send someone."""
        path = self.bin / "claude"
        path.write_text(f"#!{sys.executable}\nimport sys\nif '--help' in sys.argv: print('--restricted'); sys.exit(0)\n"
                        "sys.stderr.write(\"error: unknown option '--brand-new'\\n\"); sys.exit(1)\n")
        client = SubscriptionChatClient("claude")
        try:
            with self.assertRaisesRegex(RuntimeError, "too old for DGC"):
                client.chat([{"role": "user", "content": "Hello?"}], [])
        finally:
            client.close()

    def test_a_usage_limit_keeps_the_vendor_words(self):
        """Codex says when it comes back; "check its sign-in" sent people the wrong way."""
        path = self.bin / "codex"
        words = "You've hit your usage limit. Try again at Nov 11th, 2026 8:13 PM."
        path.write_text(f"#!{sys.executable}\nimport json, sys\nargv = sys.argv[1:]\n"
                        "if argv[:2] == ['debug', 'models']:\n"
                        "    print(json.dumps({'models': [{'slug': 'gpt-test'}]})); sys.exit(0)\n"
                        f"print(json.dumps({{'type': 'turn.failed', 'error': {{'message': {words!r}}}}}), flush=True)\n"
                        "sys.exit(1)\n")
        client = SubscriptionChatClient("codex")
        try:
            with self.assertRaisesRegex(RuntimeError, "usage limit.*Nov 11th"):
                client.chat([{"role": "user", "content": "Hello?"}], [])
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
