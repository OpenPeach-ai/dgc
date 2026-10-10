"""ChatDGC Phase 7, as ChatGPT has it: Branch in new chat (a reply's conversation so far, in a new chat of its own),
Projects (chats, files and instructions together) and the Library (every file you attached, in one place)."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc.engine import LOOK_UP, ChatEngine, ChatEngineError
from dgc.chatdgc.store import ChatStore
from dgc.llm import ToolCall
from dgc.shared_memory import SharedMemory


class Config(dict):
    base_url, api_key, model = "http://127.0.0.1:11434/v1", "", "chat-model"

    def get(self, key, default=None):
        return super().get(key, default)


class Model:
    """Answers "does this need the web?" with no, and every message with the next scripted reply; what it read is
    kept, to see what a chat's model is told."""

    def __init__(self, model, world):
        self.model, self.world, self.context_size = model, world, 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return 32768

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        if str(messages[0]["content"]).startswith(LOOK_UP[:60]):
            return SimpleNamespace(content="", tool_calls=[ToolCall("lu", "search_first", {"needs_search": False, "query": ""})],
                                   finish_reason="stop", thinking="", usage={})
        self.world["read"].append(messages)
        text = self.world["replies"].pop(0) if self.world["replies"] else "OK."
        if on_text:
            on_text(text)
        return SimpleNamespace(content=text, tool_calls=[], finish_reason="stop", thinking="",
                               usage={"input_tokens": 10, "output_tokens": 5})


class Phase7(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-p7-")
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        self.world = {"read": [], "replies": []}
        self.config = Config(thinking="off")
        self.store = ChatStore(self.folder / "chat")
        self.engine = ChatEngine(self.config, self.store, searcher=lambda q: [],
                                 memory=SharedMemory(self.folder / "memory"), projects=lambda hidden: [],
                                 client_factory=lambda model: Model(model or "chat-model", self.world))

    def say(self, chat_id, text, replies=("OK.",), **kwargs):
        self.world["replies"] += list(replies)
        return self.engine.send(chat_id, text, search="off", **kwargs)


class BranchTests(Phase7):
    def test_a_branch_holds_the_conversation_up_to_that_reply_with_its_files_and_the_original_is_untouched(self):
        notes = self.folder / "trip.csv"
        notes.write_text("day,place\n1,Calangute\n")
        chat = self.engine.open()
        first = self.say(chat["id"], "Plan from this", ["Beaches first."], attachments=[{"kind": "file", "path": str(notes)}])
        second = self.say(chat["id"], "And day two?", ["Old Goa."])
        self.say(chat["id"], "And day three?", ["Dudhsagar."])
        self.store.update(chat["id"], title="Goa trip")
        branch = self.engine.branch(chat["id"], second["id"])
        self.assertEqual(branch["title"], "Branch · Goa trip")
        self.assertEqual([m["text"] for m in branch["messages"]], ["Plan from this", "Beaches first.", "And day two?", "Old Goa."])
        self.assertEqual({k: branch["branched"][k] for k in ("from", "title", "at")},
                         {"from": chat["id"], "title": "Goa trip", "at": second["id"]})
        self.assertEqual(len(self.store.get(chat["id"])["messages"]), 6, "the original is untouched")
        # Its files came too: the branch reads the CSV as the original did, and deleting the original keeps them.
        att = branch["messages"][0]["attachments"][0]["id"]
        self.store.delete(chat["id"])
        self.say(branch["id"], "Which beach?", ["Calangute."])
        self.assertIn("<content>\nday\tplace\n1\tCalangute", self.world["read"][-1][1]["content"])
        self.assertEqual(self.store.get_file(branch["id"], att)[0], b"day,place\n1,Calangute\n")
        self.assertEqual(first["id"], branch["messages"][1]["id"])

    def test_a_branch_follows_the_version_you_see_and_keeps_a_summary_only_when_all_of_it_came(self):
        chat = self.engine.open()
        one = self.say(chat["id"], "Name a colour", ["Red."])
        self.world["replies"].append("Blue.")
        again = self.engine.regenerate(chat["id"], one["id"], search="off")
        later = self.say(chat["id"], "Another?", ["Green."])
        branch = self.engine.branch(chat["id"], again["id"])
        self.assertEqual([m["text"] for m in branch["messages"]], ["Name a colour", "Blue."], "the version shown, not Red")
        self.assertNotIn("forks", branch)
        current = self.store.get(chat["id"])
        current["summary"] = {"text": "They asked for colours.", "upto": later["id"]}
        self.store.save(current)
        self.assertNotIn("summary", self.engine.branch(chat["id"], again["id"]), "it summarized past the branch point")
        current = self.store.get(chat["id"])
        current["summary"] = {"text": "They asked for a colour.", "upto": again["id"]}
        self.store.save(current)
        self.assertEqual(self.engine.branch(chat["id"], later["id"])["summary"]["text"], "They asked for a colour.")

    def test_only_a_kept_chats_finished_reply_can_be_branched(self):
        chat = self.engine.open()
        reply = self.say(chat["id"], "Hi", ["Hello."])
        mine = self.store.get(chat["id"])["messages"][0]["id"]
        with self.assertRaisesRegex(ChatEngineError, "isn't in this chat"):
            self.engine.branch(chat["id"], mine)
        temporary = self.engine.open(temporary=True)
        said = self.say(temporary["id"], "Hi", ["Hello."])
        with self.assertRaisesRegex(ChatEngineError, "temporary chat can't be branched"):
            self.engine.branch(temporary["id"], said["id"])
        self.assertTrue(self.engine.branch(chat["id"], reply["id"]))


if __name__ == "__main__":
    unittest.main()
