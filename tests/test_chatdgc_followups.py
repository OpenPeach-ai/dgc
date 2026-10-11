"""Follow-ups, as ChatGPT shows them: a few next messages under a reply, from one small call after it ends, kept on the
reply and shown only under the chat's last one. None when they're turned off, after a reply that asked the user
something or waits on a card, after research, or when the model sees nothing natural to follow."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc.engine import FOLLOW_UP, LOOK_UP, ChatEngine
from dgc.chatdgc.store import ChatStore
from dgc.editor_protocol import event_error
from dgc.llm import ToolCall
from dgc.shared_memory import SharedMemory


class Config(dict):
    base_url, api_key, model = "http://127.0.0.1:11434/v1", "", "chat-model"

    def get(self, key, default=None):
        return super().get(key, default)


class Model:
    def __init__(self, world):
        self.world, self.model, self.context_size = world, "chat-model", 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return 32768

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        system = str(messages[0]["content"])
        if system.startswith(LOOK_UP[:60]):
            return SimpleNamespace(content="", tool_calls=[ToolCall("lu", "search_first", {"needs_search": False, "query": ""})],
                                   finish_reason="stop", thinking="", usage={})
        if system.startswith(FOLLOW_UP[:60]):
            self.world["asked"].append(messages[-1]["content"])
            return SimpleNamespace(content="", tool_calls=[ToolCall("f", "suggest", {"followups": self.world["next"]})],
                                   finish_reason="stop", thinking="", usage={})
        step = self.world["script"].pop(0) if self.world["script"] else {"parts": ["Mix flour and water, then feed it daily."]}
        for part in step.get("parts", []):
            on_text(part)
        calls = [ToolCall(f"c{i}", name, args) for i, (name, args) in enumerate(step.get("calls", []))]
        return SimpleNamespace(content="".join(step.get("parts", [])), tool_calls=calls, finish_reason="stop", thinking="",
                               usage={})


class FollowUps(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-next-")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        self.world = {"asked": [], "next": [], "script": []}
        self.config = Config(thinking="off")
        self.store = ChatStore(folder / "chat")
        self.engine = ChatEngine(self.config, self.store, searcher=lambda q: [], memory=SharedMemory(folder / "memory"),
                                 projects=lambda hidden: [], client_factory=lambda model: Model(self.world))

    def reply(self, text="How do I make a sourdough starter?", chat=None):
        chat = chat or self.engine.open()
        return chat, self.engine.send(chat["id"], text, search="auto")

    def test_the_next_messages_are_kept_on_the_reply_cleaned_and_at_most_three(self):
        self.world["next"] = ["1. How do I bake my first loaf?", "How do I bake my first loaf?", "- What do I do with the discard?",
                              "x" * 200, "How do I make a sourdough starter?", "Can I use rye flour?", "A fourth one"]
        chat, reply = self.reply()
        found = self.engine.followups(chat["id"], reply["id"])
        self.assertEqual(found, ["How do I bake my first loaf?", "What do I do with the discard?", "Can I use rye flour?"],
                         "numbering and bullets off, no repeats, nothing too long, not their own question back, three")
        self.assertEqual(self.store.get(chat["id"])["messages"][-1]["followups"], found, "kept with the reply")
        self.assertIn("The user's message:\n<<<\nHow do I make a sourdough starter?", self.world["asked"][0])
        self.assertIn("Your reply:\n<<<\nMix flour and water", self.world["asked"][0])

    def test_none_when_off_after_a_question_or_a_waiting_card_or_when_the_chat_moved_on(self):
        self.world["next"] = ["What next?"]
        chat, reply = self.reply()
        self.config["chatdgc_followups"] = False
        self.assertIsNone(self.engine.followups(chat["id"], reply["id"]), "Settings turned them off")
        self.config["chatdgc_followups"] = True
        self.world["script"].append({"parts": ["It depends. "], "calls": [("ask_user", {"question": "What flour?", "options": ["Rye", "White"]})]})
        chat2, asked = self.reply("Which flour should I use?")
        self.assertTrue(asked.get("questions"))
        self.assertIsNone(self.engine.followups(chat2["id"], asked["id"]), "the question card is the next step")
        later = self.engine.send(chat["id"], "Thanks", search="auto")
        self.assertIsNone(self.engine.followups(chat["id"], reply["id"]), "the conversation moved on")
        self.world["next"] = []
        self.assertIsNone(self.engine.followups(chat["id"], later["id"]), "the model saw nothing natural to follow")
        self.assertNotIn("followups", self.store.get(chat["id"])["messages"][-1])

    def test_on_the_wire_after_a_reply_ends(self):
        from dgc.chatdgc.service import ChatService
        frames = []

        def emit(type, **fields):
            frame = {"type": type, "seq": len(frames), **fields}
            problem = event_error(frame)
            if problem:
                raise AssertionError(f"invalid event: {problem}")
            frames.append(frame)
        service = ChatService(emit, self.config, engine=self.engine)
        self.addCleanup(service.close, 2.0)
        self.world["next"] = ["How do I bake my first loaf?"]
        service.dispatch({"type": "chatdgc_open", "request_id": "o"})
        # The opened frame, not the last one: opening also refreshes the meter on a thread, which can land first.
        chat_id = next(f for f in reversed(frames) if f["type"] == "chatdgc_opened")["conversation"]["id"]
        service.dispatch({"type": "chatdgc_send", "request_id": "s", "conversation_id": chat_id, "text": "Starter?"})
        import time
        for _ in range(500):
            found = [f for f in frames if f["type"] == "chatdgc_followups"]
            if found:
                break
            time.sleep(0.01)
        self.assertEqual(found[-1]["followups"], ["How do I bake my first loaf?"])
        ended = next(i for i, f in enumerate(frames) if f["type"] == "chatdgc_turn" and f["state"] == "ended")
        self.assertGreater(frames.index(found[-1]), ended - 1, "after the reply, not holding it up")


if __name__ == "__main__":
    unittest.main()
