"""DGC.chat(): ChatDGC from the Python SDK, against a real `dgc serve` and a local mock model (Phase 10)."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_dgc_sdk as harness                               # noqa: E402  (its mock model and HOME handling)

from dgc_sdk import DGC, ChatReply, DGCConfigError            # noqa: E402

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

    def test_on_your_own_profile_it_answers_whatever_your_mode(self):
        """inherit_user_state=True is the guide's own example: chat() asked for plan mode, which an inherited client
        refuses unless it is already your mode -- so for anyone in default or auto it raised at once (the overnight
        battle, 2026-10-13). Its backend runs no prompt, so it takes your mode as it is."""
        import json
        for mode, client_mode in (("default", None), ("auto", None), ("auto", "auto")):
            with self.subTest(mode=mode, client_mode=client_mode):
                (self.host_home / ".dgc" / "config.json").write_text(json.dumps({
                    "model": "sdk-model", "base_url": self.base_url, "mode": mode}), encoding="utf-8")
                before = (self.host_home / ".dgc" / "config.json").read_text()
                extra = {"mode": client_mode} if client_mode else {}
                with DGC(state_dir=self.state, inherit_user_state=True, api_key="sk-local", **extra) as dgc, dgc.chat() as chats:
                    self.assertEqual(chats.ask("What does the checkout do?", search="off").text, ANSWER)
                self.assertEqual((self.host_home / ".dgc" / "config.json").read_text(), before,
                                 "nothing saved into your settings (no trust acknowledged for its private folder)")

    def test_study_mode_and_answering_a_card_as_the_editor_does(self):
        """What the editor's Chat tab can do, a program can too (the overnight battle found both missing): Study mode
        from a message, and answering a reply's question card -- one choice, or a card of several questions."""
        from dgc_sdk import DGCUnsupportedError  # noqa: F401
        with self._client() as dgc, dgc.chat() as chats:
            chat = chats.new()
            chat.send("Teach me how compound interest works.", search="off", study=True)
            self.assertIn("Study mode is on", harness._Model.last_system, "the model is told to teach")
            chat.send("And simple interest?", search="off")
            self.assertIn("Study mode is on", harness._Model.last_system, "it stays on for the chat")
            chat.send("Thanks.", search="off", study=False)
            self.assertNotIn("Study mode is on", harness._Model.last_system, "and off when asked")
            with self.assertRaises(DGCConfigError):
                chat.send("x", study="yes")
            card = None
            for event in chat.stream("Help me plan buying a flat. Ask me what you need, all at once.", search="off"):
                if event.kind == "question":
                    card = event.data
                if event.kind == "reply":
                    asked = event.reply
            self.assertEqual([q["question"] for q in card["questions"]], ["Who should own it?", "Where is it?"])
            # Adversarial review (2026-10-13): non-text answers went as "None"; a count that doesn't match the card,
            # or one choice for a card of several, went through with answers dropped.
            for bad in ({"choices": ["Only me"]}, {"choices": ["Only me", ""]}, {"choices": "Only me,England"},
                        {"choices": [None, None]}, {"choices": [b"x", "y"]}, {"choices": ["Only me", "England", "Wales"]},
                        {"choices": ["Only me", "\ufeff"]}, {"choice": "Jointly"}, {"choice": "  "}, {"choice": None}):
                with self.assertRaises(DGCConfigError, msg=str(bad)):
                    chat.answer(asked.message_id, **bad)
            reply = chat.answer(asked.message_id, choices=["Jointly", "Scotland"], search="off")
            self.assertEqual(reply.text, ANSWER)
            sent = [m for m in chat.messages if m.get("role") == "user"][-1]
            self.assertEqual(sent["text"], "Build my plan.\n\nWho should own it? Jointly\nWhere is it? Scotland")
            self.assertEqual(sent["answers"]["choices"], ["Jointly", "Scotland"])

    def test_the_async_chat_answers_a_card_too(self):
        import asyncio
        from dgc_sdk import AsyncDGC

        async def run():
            async with AsyncDGC(state_dir=self.state, model="sdk-model", base_url=self.base_url, api_key="sk-local") as dgc:
                chats = await dgc.chat()
                try:
                    chat = await chats.new()
                    asked = await chat.send("Help me plan buying a flat. Ask me what you need, all at once.", search="off")
                    reply = await chat.answer(asked.message_id, choices=["Only me", "England"], search="off")
                    return reply.text
                finally:
                    await chats.close()
        self.assertEqual(asyncio.run(run()), ANSWER)

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

    def test_a_reply_has_no_limit_by_default_and_a_limit_is_still_taken(self):
        with self._client() as dgc, dgc.chat() as chats:
            self.assertIsNone(chats._reply_timeout)
            self.assertIn("checkout", chats.ask("How does checkout work?", search="off").text)
        with self._client() as dgc:
            with dgc.chat(reply_timeout=120) as chats:
                self.assertEqual(chats._reply_timeout, 120.0)
            for bad in (0, -1, float("nan"), True, "60"):
                with self.subTest(bad=bad), self.assertRaises(DGCConfigError):
                    dgc.chat(reply_timeout=bad)

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
