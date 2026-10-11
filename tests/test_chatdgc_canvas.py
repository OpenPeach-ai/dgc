"""Canvas (ChatGPT's), as a real file beside the chat: the model makes and changes it with exact edits, the user edits
the file in their editor, and the model reads it fresh every turn. Every change is a version, the user's too."""
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc import canvas as chat_canvas
from dgc.chatdgc.engine import LOOK_UP, ChatEngine
from dgc.chatdgc.service import ChatService
from dgc.chatdgc.store import ChatStore
from dgc.editor_protocol import event_error
from dgc.llm import ToolCall
from dgc.shared_memory import SharedMemory

CHAT = "chat_" + "a" * 32
PLAN = "# Goa trip\n\n## Day 1\n\nBeach in the morning.\n\n## Day 2\n\nFort Aguada.\n"


class Store(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="canvas-")
        self.addCleanup(temp.cleanup)
        self.canvases = chat_canvas.Canvases(Path(temp.name) / "canvas")

    def test_a_canvas_is_a_file_named_for_its_title_with_versions(self):
        view = self.canvases.create(CHAT, title="Goa: trip/plan", kind="document", language="", content=PLAN)
        self.assertRegex(view["id"], r"^cv_[a-f0-9]{16}$")
        self.assertTrue(view["path"].endswith(f"/canvas/{CHAT}/{view['id']}/Goa trip plan.md"))
        self.assertEqual(Path(view["path"]).read_text(), PLAN)
        self.assertEqual((view["version"], view["versions"][0]["by"]), (1, "model"))
        code = self.canvases.create(CHAT, title="clean_csv", kind="code", language="Python", content="print(1)\n")
        self.assertTrue(code["path"].endswith("/clean_csv.py"))

    def test_edits_land_exactly_once_or_say_why_not(self):
        view = self.canvases.create(CHAT, title="Plan", kind="document", language="", content=PLAN)
        edited = self.canvases.edit(CHAT, view["id"], edits=[{"find": "Fort Aguada.", "replace": "Fort Aguada at sunset."}],
                                    note="Sunset")
        self.assertIn("Fort Aguada at sunset.", Path(view["path"]).read_text())
        self.assertEqual((edited["version"], edited["versions"][-1]["note"]), (2, "Sunset"))
        with self.assertRaisesRegex(chat_canvas.CanvasError, "isn't in the canvas now"):
            self.canvases.edit(CHAT, view["id"], edits=[{"find": "Day 3", "replace": "x"}])
        with self.assertRaisesRegex(chat_canvas.CanvasError, "2 times"):
            self.canvases.edit(CHAT, view["id"], edits=[{"find": "## Day", "replace": "### Day"}])
        everywhere = self.canvases.edit(CHAT, view["id"], edits=[{"find": "## Day", "replace": "### Day", "all": True}])
        self.assertEqual(everywhere["text"].count("### Day"), 2)
        with self.assertRaisesRegex(chat_canvas.CanvasError, "change nothing"):
            self.canvases.edit(CHAT, view["id"], content=everywhere["text"])

    def test_the_users_own_edits_are_a_version_before_the_models_and_any_version_comes_back(self):
        view = self.canvases.create(CHAT, title="Plan", kind="document", language="", content=PLAN)
        Path(view["path"]).write_text(PLAN.replace("Beach", "Calangute beach"))           # typed in the editor
        after = self.canvases.edit(CHAT, view["id"], edits=[{"find": "Calangute beach", "replace": "Calangute beach, early"}])
        self.assertEqual([(v["n"], v["by"]) for v in after["versions"]], [(1, "model"), (2, "user"), (3, "model")])
        self.assertIn("Calangute beach, early", after["text"], "the model's edit is on top of the user's")
        back = self.canvases.restore(CHAT, view["id"], 1)
        self.assertEqual(Path(view["path"]).read_text(), PLAN)
        self.assertEqual((back["version"], back["versions"][-1]["note"]), (4, "Restored version 1"))
        self.assertEqual(Path(back["versions"][1]["path"]).read_text(), PLAN.replace("Beach", "Calangute beach"))

    def test_a_chats_canvases_newest_first_copied_for_a_branch_and_gone_with_it(self):
        first = self.canvases.create(CHAT, title="One", kind="document", language="", content="one")
        second = self.canvases.create(CHAT, title="Two", kind="document", language="", content="two")
        self.canvases.edit(CHAT, first["id"], content="one, changed")
        self.assertEqual([c["title"] for c in self.canvases.all(CHAT)], ["One", "Two"])
        branch = "chat_" + "b" * 32
        self.canvases.copy_chat(CHAT, branch)
        self.assertEqual(self.canvases.get(branch, second["id"], text=True)["text"], "two")
        self.canvases.remove_chat(CHAT)
        self.assertEqual(self.canvases.all(CHAT), [])
        with self.assertRaises(chat_canvas.CanvasError):
            self.canvases.get("../etc", first["id"])


class Model:
    def __init__(self, world):
        self.world, self.model, self.context_size = world, "chat-model", 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return 32768

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        if str(messages[0]["content"]).startswith(LOOK_UP[:60]):       # the check before a reply: nothing to look up
            return SimpleNamespace(content="", tool_calls=[ToolCall("lu", "search_first", {"needs_search": False, "query": ""})],
                                   finish_reason="stop", thinking="", usage={})
        self.world["read"].append({"messages": messages, "tools": [t["function"]["name"] for t in tools or []]})
        step = self.world["script"].pop(0) if self.world["script"] else {"parts": ["OK."]}
        for part in step.get("parts", []):
            on_text(part)
        calls = [ToolCall(f"c{i}", name, args) for i, (name, args) in enumerate(step.get("calls", []))]
        return SimpleNamespace(content="".join(step.get("parts", [])), tool_calls=calls, finish_reason="stop",
                               thinking="", usage={"input_tokens": 10, "output_tokens": 5})


class InChat(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-canvas-")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        self.world = {"script": [], "read": []}
        self.config = SimpleNamespace(base_url="", api_key="", model="chat-model", project_root=str(folder),
                                      get=lambda key, default=None: default)
        self.engine = ChatEngine(self.config, ChatStore(folder / "chat"), searcher=lambda q: [],
                                 memory=SharedMemory(folder / "memory"), projects=lambda hidden: [],
                                 client_factory=lambda model: Model(self.world), plugins=lambda chat, said, taint: None)

    def say(self, text, *steps, chat=None, **kwargs):
        self.world["script"] += list(steps)
        chat = chat or self.engine.open()
        return chat, self.engine.send(chat["id"], text, search="off", **kwargs)

    def test_made_shown_read_back_with_the_users_edits_and_changed_by_exact_edits(self):
        shown = []
        chat, reply = self.say("Plan my Goa trip in a canvas.",
                               {"calls": [("canvas_create", {"title": "Goa trip", "kind": "document", "content": PLAN})]},
                               {"parts": ["A two-day plan is open beside the chat."]}, on_canvas=shown.append)
        [card] = reply["canvases"]
        self.assertEqual((card["title"], card["op"], card["version"]), ("Goa trip", "created", 1))
        self.assertEqual((shown[0]["id"], shown[0]["text"], shown[0]["op"]), (card["id"], PLAN, "created"))
        self.assertNotIn("canvas_edit", self.world["read"][0]["tools"], "nothing to edit yet")
        self.assertIn("canvas_edit", self.world["read"][1]["tools"])
        Path(shown[0]["path"]).write_text(PLAN.replace("Fort Aguada.", "Fort Aguada, then Panjim."))      # the user, in the editor
        chat, reply = self.say("Add lunch to day 2.",
                               {"calls": [("canvas_edit", {"id": card["id"], "edits": [
                                   {"find": "Fort Aguada, then Panjim.", "replace": "Fort Aguada, then lunch in Panjim."}],
                                   "note": "Lunch"})]},
                               {"parts": ["Added lunch."]}, chat=chat)
        system = self.world["read"][-2]["messages"][0]["content"]
        self.assertIn("Fort Aguada, then Panjim.", system, "the model reads what the user typed")
        self.assertIn(f"Canvas Goa trip (id {card['id']}, document, version 1)", system)
        self.assertEqual(reply["canvases"][0]["op"], "edited")
        self.assertEqual(Path(shown[0]["path"]).read_text(), PLAN.replace("Fort Aguada.", "Fort Aguada, then lunch in Panjim."))
        self.assertEqual([v["by"] for v in self.engine.canvas(chat["id"], card["id"])["versions"]], ["model", "user", "model"])
        history = "\n".join(str(m["content"]) for m in self.world["read"][-1]["messages"])
        self.assertIn(f"[You created the canvas Goa trip ({card['id']}) here.]", history)

    def test_a_failed_edit_is_said_and_a_selection_goes_with_the_message(self):
        chat, reply = self.say("Canvas please.", {"calls": [("canvas_create", {"title": "Plan", "kind": "document", "content": PLAN})]},
                               {"parts": ["Done."]})
        cid = reply["canvases"][0]["id"]
        chat, reply = self.say("Change day 3.", {"calls": [("canvas_edit", {"id": cid, "edits": [{"find": "Day 3", "replace": "x"}]})]},
                               {"parts": ["There's no day 3."]}, chat=chat)
        told = [m["content"] for m in self.world["read"][-1]["messages"] if m["role"] == "tool"]
        self.assertTrue(told[0].startswith("error: Edit 1"), told)
        self.assertNotIn("canvases", reply, "nothing changed, no card")
        chat, reply = self.say("Make this livelier.", {"parts": ["Sure."]}, chat=chat,
                               canvas_selection={"canvas_id": cid, "start_line": 5, "end_line": 5, "text": "Beach in the morning."})
        mine = self.engine.open(chat["id"])["messages"][-2]
        self.assertEqual(mine["canvas"], {"id": cid, "title": "Plan", "start_line": 5, "end_line": 5, "text": "Beach in the morning."})
        sent = self.world["read"][-1]["messages"][-1]["content"]
        self.assertIn(f"[About this part of the canvas Plan ({cid}), lines 5–5:\n<<<\nBeach in the morning.\n>>>]", sent)
        with self.assertRaisesRegex(Exception, "isn't in a canvas of this chat"):
            self.say("x", chat=chat, canvas_selection={"canvas_id": "cv_" + "0" * 16, "start_line": 1, "end_line": 1, "text": "x"})

    def test_a_branch_has_its_own_copy_and_deleting_the_chat_deletes_its_canvases(self):
        chat, reply = self.say("Canvas please.", {"calls": [("canvas_create", {"title": "Plan", "kind": "document", "content": PLAN})]},
                               {"parts": ["Done."]})
        cid = reply["canvases"][0]["id"]
        branch = self.engine.branch(chat["id"], reply["id"])
        theirs = self.engine.canvas(branch["id"], cid, text=True)
        self.assertEqual(theirs["text"], PLAN)
        self.assertIn(branch["id"], theirs["path"])
        self.engine.delete(chat["id"])
        with self.assertRaises(Exception):
            self.engine.canvas(chat["id"], cid)
        self.assertEqual(self.engine.canvas(branch["id"], cid, text=True)["text"], PLAN, "the branch keeps its own")


class Wire(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-canvas-wire-")
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        self.frames, self.world = [], {"script": [], "read": []}
        config = SimpleNamespace(base_url="", api_key="", model="chat-model", get=lambda key, default=None: default)
        self.engine = ChatEngine(config, ChatStore(self.folder / "chat"), searcher=lambda q: [],
                                 memory=SharedMemory(self.folder / "memory"), projects=lambda hidden: [],
                                 client_factory=lambda model: Model(self.world), plugins=lambda chat, said, taint: None)

        def emit(type, **fields):
            frame = {"type": type, "seq": len(self.frames), **fields}
            problem = event_error(frame)
            if problem:
                raise AssertionError(problem)
            self.frames.append(frame)
        self.service = ChatService(emit, config, engine=self.engine)
        self.addCleanup(self.service.close, 2.0)

    def test_get_restore_and_download_as_word_or_as_the_file(self):
        chat = self.engine.open()
        self.world["script"] += [{"calls": [("canvas_create", {"title": "Plan", "kind": "document", "content": PLAN})]},
                                 {"parts": ["Done."]}]
        reply = self.engine.send(chat["id"], "Canvas please.", search="off")
        cid = reply["canvases"][0]["id"]
        ask = {"type": "chatdgc_canvas", "conversation_id": chat["id"], "canvas_id": cid}
        self.service.dispatch({**ask, "request_id": "g", "op": "get"})
        got = [f for f in self.frames if f.get("request_id") == "g"][-1]
        self.assertEqual((got["type"], got["canvas"]["text"], got["canvas"]["version"]), ("chatdgc_canvas", PLAN, 1))
        word = self.folder / "Plan.docx"
        self.service.dispatch({**ask, "request_id": "w", "op": "export", "format": "docx", "path": str(word)})
        self.assertEqual([f["type"] for f in self.frames if f.get("request_id") == "w"], ["chatdgc_exported"])
        self.assertIn("word/document.xml", zipfile.ZipFile(io.BytesIO(word.read_bytes())).namelist())
        as_is = self.folder / "Plan.md"
        self.service.dispatch({**ask, "request_id": "f", "op": "export", "format": "file", "path": str(as_is)})
        self.assertEqual(as_is.read_text(), PLAN)
        Path(got["canvas"]["path"]).write_text("rewritten by hand")
        self.service.dispatch({**ask, "request_id": "r", "op": "restore", "version": 1})
        back = [f for f in self.frames if f.get("request_id") == "r"][-1]
        self.assertEqual((back["canvas"]["text"], back["canvas"]["version"]), (PLAN, 3), "theirs kept as version 2 first")
        self.service.dispatch({**ask, "request_id": "x", "op": "restore", "version": 99})
        self.assertEqual([f["type"] for f in self.frames if f.get("request_id") == "x"], ["chatdgc_error"])


if __name__ == "__main__":
    unittest.main()
