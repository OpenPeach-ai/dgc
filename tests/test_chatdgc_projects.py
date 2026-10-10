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


PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
       b"\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7\x35\x81\x84\x00\x00\x00\x00IEND\xaeB`\x82")


class LibraryTests(Phase7):
    def setUp(self):
        super().setUp()
        self.files = {}
        for name, body in (("budget.csv", "day,cost\n1,500\n"), ("itinerary.pdf.txt", "Day 1"), ("deck.pptx.md", "# Slides"),
                           ("app.py", "print('hi')\n"), ("notes.md", "# Notes\nPack light.\n")):
            path = self.folder / name
            path.write_text(body)
            self.files[name] = path
        (self.folder / "sign.png").write_bytes(PNG)

    def attach(self, chat_id, *names, text="Here", **kwargs):
        items = [{"kind": "file", "path": str(self.folder / n)} for n in names]
        return self.say(chat_id, text, attachments=items, **kwargs)

    def test_every_file_you_attached_newest_first_with_its_kind_and_where_it_is(self):
        trip = self.store.create_project("Goa trip")
        one = self.engine.open()
        self.attach(one["id"], "budget.csv", "app.py")
        inside = self.engine.open(project=trip["id"])
        self.attach(inside["id"], "notes.md")
        self.engine.add_project_files(trip["id"], [{"kind": "text", "text": "Hotel: Casa Anjuna", "name": "Hotel"}])
        temporary = self.engine.open(temporary=True)
        self.attach(temporary["id"], "notes.md", text="Not kept")
        found = self.store.library()
        self.assertEqual([f["name"] for f in found["files"]], ["Hotel", "notes.md", "app.py", "budget.csv"],
                         "newest first (files sent together, by name); a temporary chat's files are never kept")
        self.assertEqual([f["type"] for f in found["files"]], ["text", "document", "code", "spreadsheet"])
        hotel, notes, budget = found["files"][0], found["files"][1], found["files"][3]
        self.assertEqual((hotel["source"], hotel["project_name"]), ("project", "Goa trip"))
        self.assertEqual((notes["source"], notes["chat_id"], notes["project_name"]), ("chat", inside["id"], "Goa trip"))
        self.assertEqual((budget["chat_title"], budget["chat_id"]), ("Here", one["id"]))
        self.assertEqual(found["counts"]["spreadsheet"], 1)
        self.assertEqual([f["name"] for f in self.store.library(kind="code")["files"]], ["app.py"])
        self.assertEqual([f["name"] for f in self.store.library(query="BUDG")["files"]], ["budget.csv"])
        page = self.store.library(limit=2)
        self.assertEqual((len(page["files"]), page["next_offset"], page["total"]), (2, 2, 4))
        with self.assertRaisesRegex(Exception, "Choose images, PDFs"):
            self.store.library(kind="videos")

    def test_a_library_file_attached_again_is_a_copy_the_model_reads(self):
        one = self.engine.open()
        self.attach(one["id"], "budget.csv")
        source = self.store.library()["files"][0]
        two = self.engine.open()
        self.say(two["id"], "What did day one cost?", attachments=[{"kind": "library", "conversation_id": one["id"],
                                                                     "attachment_id": source["id"]}])
        self.assertIn("1\t500", self.world["read"][-1][-1]["content"])
        copy = self.store.get(two["id"])["messages"][0]["attachments"][0]
        self.assertNotEqual(copy["id"], source["id"], "its own copy")
        self.assertEqual((copy["name"], copy["kind"]), ("budget.csv", "document"))
        self.assertEqual(self.store.library()["total"], 2, "and it's in the Library as this chat's too")
        with self.assertRaisesRegex(ChatEngineError, "no longer in your Library"):
            self.say(two["id"], "Again", attachments=[{"kind": "library", "conversation_id": one["id"], "attachment_id": "att_" + "0" * 32}])
        with self.assertRaisesRegex(ChatEngineError, "up to 10"):
            self.say(two["id"], "Too many", attachments=[{"kind": "library", "conversation_id": one["id"], "attachment_id": source["id"]}] * 11)

    def test_deleting_a_file_from_the_library_leaves_its_chat_saying_so(self):
        one = self.engine.open()
        self.attach(one["id"], "budget.csv")
        file = self.store.library()["files"][0]
        self.engine.remove_library_file({"conversation_id": one["id"], "attachment_id": file["id"]})
        self.assertEqual(self.store.library()["total"], 0)
        self.assertTrue(self.store.get(one["id"])["messages"][0]["attachments"][0]["removed"])
        self.say(one["id"], "And now?")
        self.assertIn("[budget.csv was attached here; it is no longer available]", str(self.world["read"][-1]))
        self.say(one["id"], "Still?")
        self.assertEqual(self.store.library()["total"], 0, "a later save doesn't bring it back")

    def test_a_library_file_goes_into_a_project_as_a_copy(self):
        trip = self.store.create_project("Goa trip")
        one = self.engine.open()
        self.attach(one["id"], "notes.md")
        file = self.store.library()["files"][0]
        project = self.engine.library_to_project({"conversation_id": one["id"], "attachment_id": file["id"]}, trip["id"])
        self.assertEqual([f["name"] for f in project["files"]], ["notes.md"])
        self.assertNotEqual(project["files"][0]["id"], file["id"])
        self.assertEqual(self.store.library()["total"], 2)
        self.engine.remove_library_file({"project_id": trip["id"], "attachment_id": project["files"][0]["id"]})
        self.assertEqual(self.store.project(trip["id"])["files"], [])

    def test_save_a_copy_and_remove_on_the_wire(self):
        from dgc.chatdgc.service import ChatService
        from dgc.editor_protocol import event_error
        frames = []

        def emit(type, **fields):
            frame = {"type": type, "seq": len(frames), **fields}
            problem = event_error(frame)
            if problem:
                raise AssertionError(f"invalid event: {problem}")
            frames.append(frame)
        service = ChatService(emit, self.config, engine=self.engine)
        self.addCleanup(service.close, 2.0)
        one = self.engine.open()
        self.attach(one["id"], "budget.csv")
        file = self.store.library()["files"][0]
        service.dispatch({"type": "chatdgc_library", "request_id": "l1", "kind": "spreadsheet"})
        self.assertEqual([f["id"] for f in frames[-1]["files"]], [file["id"]])
        target = self.folder / "out" / "budget-copy.csv"
        target.parent.mkdir()
        service.dispatch({"type": "chatdgc_library_file", "request_id": "s1", "op": "save", "conversation_id": one["id"],
                          "attachment_id": file["id"], "path": str(target)})
        self.assertEqual((frames[-1]["type"], frames[-1]["bytes"]), ("chatdgc_library_file", 15))
        self.assertEqual(target.read_bytes(), b"day,cost\n1,500\n")
        service.dispatch({"type": "chatdgc_library_file", "request_id": "s2", "op": "save", "conversation_id": one["id"],
                          "attachment_id": file["id"], "path": "relative.png"})
        self.assertEqual(frames[-1]["message"], "Choose where to save the file.")
        service.dispatch({"type": "chatdgc_library_file", "request_id": "r1", "op": "remove", "conversation_id": one["id"],
                          "attachment_id": file["id"]})
        self.assertEqual([f["type"] for f in frames[-2:]], ["chatdgc_library_file", "chatdgc_projects"])
        self.assertEqual(self.store.library()["total"], 0)


if __name__ == "__main__":
    unittest.main()
