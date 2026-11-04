"""Plugin cards (MCP Apps) in the Python SDK: session.cards.watch() / .get() / .call() / .answer() / .context() and
message_text(), each one valid command the CLI's protocol accepts, answered by its own events."""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk/python"))

from dgc_sdk import AsyncSession, Cards, DGCUnsupportedError  # noqa: E402
from dgc_sdk.session import Session  # noqa: E402
from dgc_sdk.wire.editor_protocol import command_error, event_error  # noqa: E402

CARD = "app_" + "a" * 24


class Wire:
    def __init__(self):
        self.calls, self.sent = [], []
        self.pending = {}

    def send(self, payload):
        assert command_error(payload) is None, command_error(payload)
        self.sent.append(dict(payload))

    def request(self, payload, response, **kwargs):
        assert command_error(payload) is None, command_error(payload)
        self.calls.append((dict(payload), response))
        rid = payload["request_id"]
        if payload["type"] == "mcp_app_answer":
            original = self.pending.pop(payload["ask_id"])
            assert rid == original, "Host replies under the original call ID"

        if payload["type"] == "mcp_app_get":
            answer = {"type": "mcp_app_resource", "seq": 1, "request_id": rid, "card_id": CARD, "surface": "work",
                      "server": "board", "plugin": "Board", "tool": "show_board", "uri": "ui://board/card.html",
                      "url": "http://127.0.0.1:1/card/" + CARD + "?t=x", "tool_input": {}, "tool_result": {"content": []},
                      "tool_info": {"name": "show_board"}, "csp": {}, "declared_csp": False, "link_hosts": [],
                      "html": "<p>board</p>", "csp_header": "default-src 'none'"}
        elif payload["type"] == "mcp_app_call" and payload["params"].get("name") == "move":
            answer = {"type": "mcp_app_reply", "seq": 1, "request_id": rid, "card_id": CARD,
                      "ask": {"ask_id": "ask_" + "b" * 24, "card_id": CARD, "plugin": "Board", "server": "board",
                              "tool": "move", "title": "move", "arguments": {"to": "a1"}, "always": True, "money": False}}
        else:
            answer = {"type": "mcp_app_reply", "seq": 1, "request_id": rid, "card_id": CARD,
                      "result": {"content": [{"type": "text", "text": "ok"}]}}
        if "ask" in answer:
            self.pending[answer["ask"]["ask_id"]] = rid
        assert event_error(answer) is None, event_error(answer)
        return answer


def session(wire, caps):
    return Session(wire, {"capabilities": caps}, unhandled="deny", on_permission=None, on_plan=None,
                   on_question=None, isolated=False)


class SessionCards(unittest.TestCase):
    def test_needs_the_capability(self):
        with self.assertRaises(DGCUnsupportedError):
            session(Wire(), {}).cards

    def test_each_call_is_one_valid_command(self):
        wire = Wire()
        cards = session(wire, {"mcp_apps": {"version": 1, "protocol": "2026-01-26"}}).cards
        self.assertIsInstance(cards, Cards)
        cards.watch()
        self.assertEqual(wire.sent, [{"type": "watch_mcp_apps"}])
        self.assertEqual(cards.get(CARD)["html"], "<p>board</p>")
        self.assertEqual(cards.call(CARD, "tools/call", {"name": "show_board", "arguments": {}}),
                         {"result": {"content": [{"type": "text", "text": "ok"}]}})
        asked = cards.call(CARD, "tools/call", {"name": "move", "arguments": {"to": "a1"}})
        self.assertEqual(asked["ask"]["tool"], "move")
        done = cards.answer(asked, "once")
        self.assertIn("result", done)
        answer, _ = wire.calls[-1]
        self.assertEqual((answer["type"], answer["ask_id"], answer["request_id"]),
                         ("mcp_app_answer", "ask_" + "b" * 24, asked["request_id"]),
                         "the answer names the call it decides, so its outcome comes back to it")
        with self.assertRaises(ValueError):
            cards.answer(asked, "maybe")
        cards.context(CARD, [{"type": "text", "text": "picked a2"}], {"cell": "a2"})
        self.assertEqual(wire.sent[-1], {"type": "mcp_app_context", "card_id": CARD,
                                          "content": [{"type": "text", "text": "picked a2"}],
                                          "structured_content": {"cell": "a2"}})
        self.assertEqual(Cards.message_text({"plugin": "Board"}, " bigger "), "From Board's card: bigger")

    def test_inner_ask_keeps_original_call_correlation(self):
        wire = Wire()
        cards = session(wire, {"mcp_apps": {"version": 1}}).cards
        asked = cards.call(CARD, "tools/call", {"name": "move"})
        self.assertIn("result", cards.answer(asked["ask"], "deny"))

    def test_answer_without_correlation_is_rejected_before_sending(self):
        wire = Wire()
        cards = session(wire, {"mcp_apps": {"version": 1}}).cards
        with self.assertRaises(ValueError):
            cards.answer({"ask_id": "ask_" + "b" * 24}, "deny")
        self.assertEqual(wire.calls, [])

    def test_async_parity(self):
        wire = Wire()
        async_session = AsyncSession(session(wire, {"mcp_apps": {"version": 1}}))

        async def go():
            cards = async_session.cards
            cards.watch()
            return await cards.call(CARD, "resources/read", {"uri": "ui://board/card.html"}), await cards.get(CARD)
        read, got = asyncio.run(go())
        self.assertIn("result", read)
        self.assertEqual(got["card_id"], CARD)


if __name__ == "__main__":
    unittest.main()
