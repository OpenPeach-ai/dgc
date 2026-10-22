"""Anthropic prompt caching: DGC marks where a cached prefix ends, and keeps what the reply says.

Before 0.48 the Claude Messages route sent no ``cache_control`` marker, so every turn re-billed the
whole context at the full input price. These tests hold the request shape Anthropic documents (at
most four breakpoints: the tool list, the system prompt, the newest message and the previous
request's read point; one TTL per request, "5m" by default or "1h") and the record of each reply's
cache read/write and the TTL the provider says it wrote. No model is contacted: a local server
answers like Anthropic.
"""
from __future__ import annotations

import json
import unittest

from dgc.llm import LLMClient, normalize_prompt_cache_ttl
from fake_providers import FakeProviders, Reply, say

TOOLS = [{"type": "function", "function": {
    "name": "read_file", "description": "Read a file",
    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}]

# A real tool round: system, the user's ask, the model's tool call, its result, and a new user line.
HISTORY = [
    {"role": "system", "content": "You are DGC."},
    {"role": "user", "content": "inspect main.py"},
    {"role": "assistant", "content": "", "tool_calls": [{"id": "toolu_1", "function": {
        "name": "read_file", "arguments": '{"path": "main.py"}'}}]},
    {"role": "tool", "tool_call_id": "toolu_1", "content": "print('hi')"},
    {"role": "assistant", "content": "It prints hi."},
    {"role": "user", "content": "now explain it"},
]


def markers(payload: dict) -> list[tuple[str, dict]]:
    """Every cache_control marker in a payload, with where it sits."""
    found = []
    for tool in payload.get("tools") or []:
        if "cache_control" in tool:
            found.append(("tool:" + tool["name"], tool["cache_control"]))
    system = payload.get("system")
    if isinstance(system, list):
        for block in system:
            if "cache_control" in block:
                found.append(("system", block["cache_control"]))
    for index, message in enumerate(payload.get("messages") or []):
        for block in message.get("content") or []:
            if isinstance(block, dict) and "cache_control" in block:
                found.append((f"messages[{index}].{block.get('type')}", block["cache_control"]))
    return found


def client(**settings) -> LLMClient:
    made = LLMClient("https://api.anthropic.com/v1", "k", "claude-sonnet-5-5", **settings)
    made.invalidate_capabilities()
    return made


class Markers(unittest.TestCase):
    def test_the_tool_list_the_system_prompt_and_the_conversation_are_marked(self):
        payload = client()._anthropic_payload(HISTORY, TOOLS, "off", set())
        where = [place for place, _ in markers(payload)]
        self.assertEqual(payload["system"], [{"type": "text", "text": "You are DGC.",
                                              "cache_control": {"type": "ephemeral"}}])
        self.assertIn("tool:read_file", where, "the tool list renders first; its last tool is a breakpoint")
        self.assertIn("system", where)
        last = len(payload["messages"]) - 1
        self.assertIn(f"messages[{last}].text", where, "the newest message: the next request reads it all back")
        # The previous request ended on the user message that held the tool result; marking it again
        # gives this request a read point that does not depend on the 20-position lookback.
        self.assertIn("messages[2].tool_result", where)
        self.assertLessEqual(len(where), 4, "Anthropic takes at most four breakpoints")

    def test_five_minutes_is_the_default_and_sends_no_ttl(self):
        payload = client()._anthropic_payload(HISTORY, TOOLS, "off", set())
        self.assertTrue(markers(payload))
        self.assertTrue(all(marker == {"type": "ephemeral"} for _, marker in markers(payload)))

    def test_one_hour_puts_the_same_ttl_on_every_marker(self):
        payload = client(prompt_cache_ttl="1h")._anthropic_payload(HISTORY, TOOLS, "off", set())
        self.assertTrue(markers(payload))
        # Longer TTLs must come before shorter ones: one TTL for the whole request keeps that true.
        self.assertTrue(all(marker == {"type": "ephemeral", "ttl": "1h"} for _, marker in markers(payload)))

    def test_prompt_cache_off_sends_no_marker(self):
        payload = client(prompt_cache=False)._anthropic_payload(HISTORY, TOOLS, "off", set())
        self.assertEqual(markers(payload), [])
        self.assertEqual(payload["system"], "You are DGC.", "the system prompt stays a plain string")

    def test_no_marker_on_an_empty_text_block_or_a_thinking_block(self):
        history = [
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": "done",
             "_provider_message": {"provider": "anthropic", "content": [
                 {"type": "thinking", "thinking": "plan", "signature": "sig"},
                 {"type": "text", "text": "done"}]}},
            {"role": "user", "content": ""},
        ]
        payload = client()._anthropic_payload(history, None, "off", set())
        for place, _ in markers(payload):
            self.assertNotIn("thinking", place)
        empty = payload["messages"][-1]["content"]
        self.assertEqual(empty, [{"type": "text", "text": ""}], "an empty text block never carries a marker")

    def test_ttl_values(self):
        self.assertEqual(normalize_prompt_cache_ttl("1h"), "1h")
        self.assertEqual(normalize_prompt_cache_ttl("5m"), "5m")
        self.assertEqual(normalize_prompt_cache_ttl("2 days"), "5m", "anything else is the default")


class Wire(unittest.TestCase):
    """A real request to a server that answers like Anthropic."""

    def setUp(self):
        self.server = FakeProviders()
        self.addCleanup(self.server.close)

    def client(self, **settings) -> LLMClient:
        made = LLMClient(self.server.url + "/v1", "k", "claude-sonnet-5-5", api_mode="anthropic",
                         **settings)
        made.invalidate_capabilities()
        return made

    def test_the_reply_records_the_ttl_the_provider_wrote_and_when_the_request_was_sent(self):
        self.server.script = lambda kind, body, index: say(
            "hi", input_tokens=40, cache_read_input_tokens=0, cache_creation_input_tokens=3000,
            cache_creation={"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 3000})
        import time
        before = time.time()
        result = self.client(prompt_cache_ttl="1h").chat(HISTORY, tools=TOOLS)
        self.assertEqual(result.content, "hi")
        self.assertEqual(result.cache["ttl"], "1h", "the TTL comes from the provider's own report")
        self.assertEqual(result.cache["write_1h_tokens"], 3000)
        self.assertEqual(result.cache["prompt_tokens"], 3040)
        self.assertEqual(result.cache["requested_ttl"], "1h")
        self.assertGreaterEqual(result.cache["sent_at"], before)
        self.assertLessEqual(result.cache["sent_at"], time.time())
        body = self.server.bodies("anthropic")[0]
        self.assertTrue(all(marker.get("ttl") == "1h" for _, marker in markers(body)))

    def test_a_reply_that_reports_no_cache_records_nothing(self):
        self.server.script = lambda kind, body, index: say("hi", input_tokens=40)
        result = self.client().chat(HISTORY, tools=TOOLS)
        self.assertEqual(result.cache, {})

    def test_a_server_that_refuses_the_marker_gets_the_request_again_without_it(self):
        refusals = []

        def script(kind, body, index):
            if markers(body):
                refusals.append(index)
                return Reply(status=400, error=json.dumps({"type": "error", "error": {
                    "type": "invalid_request_error",
                    "message": "tools.0.cache_control: Extra inputs are not permitted"}}))
            return say("fine")
        self.server.script = script
        result = self.client().chat(HISTORY, tools=TOOLS)
        self.assertEqual(result.content, "fine")
        self.assertEqual(refusals, [1], "one refusal, then the same request without markers")
        self.assertEqual(markers(self.server.bodies()[-1]), [])

    def test_a_server_that_refuses_only_the_one_hour_ttl_keeps_the_five_minute_marker(self):
        def script(kind, body, index):
            if any(marker.get("ttl") for _, marker in markers(body)):
                return Reply(status=400, error=json.dumps({"type": "error", "error": {
                    "type": "invalid_request_error", "message": "cache_control.ttl: unsupported value"}}))
            return say("fine")
        self.server.script = script
        result = self.client(prompt_cache_ttl="1h").chat(HISTORY, tools=TOOLS)
        self.assertEqual(result.content, "fine")
        last = markers(self.server.bodies()[-1])
        self.assertTrue(last)
        self.assertTrue(all(marker == {"type": "ephemeral"} for _, marker in last))


if __name__ == "__main__":
    unittest.main()
