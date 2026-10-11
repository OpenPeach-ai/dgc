"""DGC.chat(): ChatDGC from the Python SDK, against a real `dgc serve` and a local mock model (Phase 10)."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_dgc_sdk as harness                               # noqa: E402  (its mock model and HOME handling)

from dgc_sdk import ChatReply, DGCConfigError                 # noqa: E402

ANSWER = "The checkout flow creates an empty cart and then redirects."


class ChatTests(unittest.TestCase):
    setUp = harness.SdkTests.setUp
    tearDown = harness.SdkTests.tearDown
    _client = harness.SdkTests._client

    def test_ask_list_open_rename_export_delete(self):
        with self._client() as dgc, dgc.chat() as chats:
            reply = chats.ask("What does the checkout do?", search="off")
            self.assertIsInstance(reply, ChatReply)
            self.assertEqual(reply.text, ANSWER)
            self.assertTrue(reply.chat_id.startswith("chat_") and reply.message_id)
            listed = chats.list()
            self.assertEqual([c.id for c in listed], [reply.chat_id], "a sent chat is listed")
            chat = chats.open(reply.chat_id)
            self.assertEqual([m["role"] for m in chat.messages], ["user", "assistant"])
            self.assertEqual(chat.messages[-1]["text"], ANSWER)
            chat.rename("Checkout notes")
            self.assertEqual(chats.list()[0].title, "Checkout notes")
            out = Path(tempfile.mkdtemp(prefix="dgc-chat-export-")) / "chat.md"
            saved = chat.export(out)
            self.assertIn(ANSWER, saved.read_text(encoding="utf-8"))
            chat.delete()
            self.assertEqual(chats.list(), [])

    def test_stream_writes_the_reply_then_ends_with_it(self):
        with self._client() as dgc, dgc.chat() as chats:
            chat = chats.new()
            events = list(chat.stream("Explain the checkout.", search="off"))
            self.assertEqual(events[-1].kind, "reply")
            written = "".join(e.text for e in events if e.kind == "text")
            self.assertEqual(written, ANSWER, "the pieces add up to the reply")
            self.assertEqual(events[-1].reply.text, ANSWER)
            # A second message in the same chat: its history goes with it.
            again = chat.send("And then?", search="off")
            self.assertEqual(again.chat_id, chat.id)
            self.assertEqual(len(chat.messages), 4)

    def test_a_temporary_chat_is_never_listed_and_bad_options_are_refused(self):
        with self._client() as dgc, dgc.chat() as chats:
            reply = chats.ask("Just between us.", temporary=True, search="off")
            self.assertEqual(reply.text, ANSWER)
            self.assertEqual(chats.list(), [])
            chat = chats.new()
            for bad in ({"search": "sometimes"}, {"thinking": "max"}, {"files": ["/nope/missing.txt"]}):
                with self.subTest(bad=bad), self.assertRaises(DGCConfigError):
                    chat.send("x", **bad)


if __name__ == "__main__":
    unittest.main()
