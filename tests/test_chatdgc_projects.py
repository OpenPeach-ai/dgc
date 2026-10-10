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


class ProjectTests(Phase7):
    def project_chat(self, project, text="Hi", replies=("OK.",)):
        chat = self.engine.open(project=project["id"])
        return chat, self.say(chat["id"], text, replies)

    def test_a_chat_started_on_a_projects_page_is_in_it_and_listed_with_it_not_with_your_chats(self):
        trip = self.store.create_project("Goa trip", color="teal")
        loose = self.engine.open()
        self.say(loose["id"], "Unrelated", ["Sure."])
        chat, _ = self.project_chat(trip, "Beaches near Calangute?", ["Baga and Candolim."])
        self.assertEqual(self.store.get(chat["id"])["project"], trip["id"])
        self.assertEqual([c["id"] for c in self.store.listing()["chats"]], [loose["id"]], "your chats: those in no project")
        inside = self.store.listing(project=trip["id"])["chats"]
        self.assertEqual(([c["id"] for c in inside], inside[0]["project"]), ([chat["id"]], trip["id"]))
        found = self.store.listing(query="Candolim")["chats"]
        self.assertEqual([(c["id"], c.get("project")) for c in found], [(chat["id"], trip["id"])], "search covers every chat")
        self.assertEqual(self.store.projects()[0]["chats"], 1)
        with self.assertRaisesRegex(ChatEngineError, "temporary chat isn't kept"):
            self.engine.open(temporary=True, project=trip["id"])

    def test_a_project_chats_model_reads_its_instructions_files_and_other_chats(self):
        trip = self.store.create_project("Goa trip", instructions="Budget traveller, vegetarian. Prices in rupees.")
        plan = self.folder / "itinerary.md"
        plan.write_text("# Itinerary\nDay 1: Calangute\nDay 2: Old Goa\n")
        self.engine.add_project_files(trip["id"], [{"kind": "file", "path": str(plan)},
                                                   {"kind": "text", "text": "Hotel: Casa Anjuna, ₹3,000 a night", "name": "Hotel"}])
        first, _ = self.project_chat(trip, "Where do we stay?", ["Casa Anjuna."])
        self.store.update(first["id"], title="Where we stay")
        self.project_chat(trip, "What's on day two?", ["Old Goa."])
        system = self.world["read"][-1][0]["content"]
        self.assertIn("This chat is in the user's project \u201cGoa trip\u201d.", system)
        self.assertIn("follow these):\n<<<\nBudget traveller, vegetarian. Prices in rupees.\n>>>", system)
        self.assertIn("Day 2: Old Goa", system)
        self.assertIn("Hotel: Casa Anjuna, ₹3,000 a night", system)
        self.assertIn("- \u201cWhere we stay\u201d (", system, "and what its other chats are about")
        self.assertIn("Casa Anjuna.", system)
        loose = self.engine.open()
        self.say(loose["id"], "Hi")
        self.assertNotIn("Goa trip", self.world["read"][-1][0]["content"], "a chat in no project knows none of it")

    def test_project_only_memory_keeps_your_saved_memories_out_and_offers_no_remember(self):
        self.engine.memory.add("Is vegetarian")
        shared = self.store.create_project("Shared")
        private = self.store.create_project("Private", memory="project")
        self.project_chat(shared, "Hi")
        self.assertIn("Is vegetarian", self.world["read"][-1][0]["content"])
        self.project_chat(private, "Hi")
        system = self.world["read"][-1][0]["content"]
        self.assertNotIn("Is vegetarian", system)
        self.assertIn("The user keeps this project to itself", system)
        chat = self.engine.open(project=private["id"])
        self.assertFalse(self.engine._memory_on(chat))
        self.store.update_project(private["id"], memory="shared")
        self.assertTrue(self.engine._memory_on(chat), "switchable, as ChatGPT's is")

    def test_moving_a_chat_in_and_out_and_a_move_made_mid_reply_stays(self):
        trip = self.store.create_project("Goa trip")
        chat = self.engine.open()
        self.say(chat["id"], "Hi")
        self.engine.move(chat["id"], trip["id"])
        self.assertEqual(self.store.listing(project=trip["id"])["total"], 1)
        # A reply that started before the move saves the copy it started with: the move stays.
        started = self.store.get(chat["id"])
        started.pop("project")
        self.store.save(started)
        self.assertEqual(self.store.get(chat["id"])["project"], trip["id"])
        self.engine.move(chat["id"], "")
        self.assertNotIn("project", self.store.get(chat["id"]))
        draft = self.engine.open()
        self.engine.move(draft["id"], trip["id"])
        self.say(draft["id"], "Written now")
        self.assertEqual(self.store.get(draft["id"])["project"], trip["id"], "a new chat moved before its first message")
        with self.assertRaisesRegex(Exception, "doesn't exist"):
            self.engine.move(chat["id"], "proj_" + "f" * 32)

    def test_deleting_a_project_deletes_its_chats_or_keeps_them_as_yours(self):
        one, two = self.store.create_project("One"), self.store.create_project("Two")
        a, _ = self.project_chat(one)
        b, _ = self.project_chat(two)
        notes = self.folder / "n.txt"
        notes.write_text("notes")
        self.engine.add_project_files(one["id"], [{"kind": "file", "path": str(notes)}])
        self.assertEqual(self.store.delete_project(one["id"], keep_chats=False), [a["id"]])
        with self.assertRaisesRegex(Exception, "doesn't exist"):
            self.store.get(a["id"])
        self.assertFalse(self.store.project_files_dir(one["id"]).exists())
        self.assertEqual(self.store.delete_project(two["id"], keep_chats=True), [])
        self.assertNotIn("project", self.store.get(b["id"]))
        self.assertEqual([c["id"] for c in self.store.listing()["chats"]], [b["id"]], "back with your chats")
        self.assertEqual(self.store.projects(), [])

    def test_project_files_are_capped_removable_and_a_large_one_is_cut_to_fit(self):
        from dgc.chatdgc import engine as engine_mod
        from dgc.chatdgc.store import MAX_PROJECT_FILES
        trip = self.store.create_project("Big")
        big = self.folder / "big.txt"
        big.write_text("word " * 60_000)
        project = self.engine.add_project_files(trip["id"], [{"kind": "file", "path": str(big)}])
        self.project_chat(trip, "Summarize")
        self.assertIn("[Only the first part of big.txt fits", self.world["read"][-1][0]["content"])
        removed = self.store.remove_project_file(trip["id"], project["files"][0]["id"])
        self.assertEqual(removed["files"], [])
        for i in range(MAX_PROJECT_FILES):
            self.engine.add_project_files(trip["id"], [{"kind": "text", "text": f"note {i}", "name": f"n{i}"}])
        with self.assertRaisesRegex(Exception, f"up to {MAX_PROJECT_FILES} files"):
            self.engine.add_project_files(trip["id"], [{"kind": "text", "text": "one more"}])
        self.assertGreater(engine_mod.PROJECT_SHARE, 0)

    def test_a_branch_stays_in_its_project(self):
        trip = self.store.create_project("Goa trip")
        chat, reply = self.project_chat(trip)
        self.assertEqual(self.engine.branch(chat["id"], reply["id"])["project"], trip["id"])
        self.assertEqual(self.store.listing(project=trip["id"])["total"], 2)

    def test_an_older_index_gains_projects_and_files(self):
        import sqlite3
        chat = self.engine.open()
        self.say(chat["id"], "Hi")
        db = sqlite3.connect(self.store.root / "index.sqlite3")
        db.execute("DROP TABLE files")
        db.execute("DROP INDEX chats_project")
        db.execute("ALTER TABLE chats DROP COLUMN project")
        db.execute("PRAGMA user_version = 2")
        db.commit()
        db.close()
        self.assertEqual(self.store.listing()["total"], 1, "the column is back, and the chat is in no project")
        self.assertEqual(self.store.listing(query="Hi")["total"], 1)


if __name__ == "__main__":
    unittest.main()
