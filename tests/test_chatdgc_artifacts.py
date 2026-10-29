"""Artifacts in ChatDGC: a deck, sheet, dashboard or page the chat keeps with every version, a document as a canvas,
and the Output chip's choice kept as a promise."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dgc import artifact_store
from dgc.chatdgc.engine import ChatEngine
from dgc.chatdgc.store import ChatStore
from dgc.shared_memory import SharedMemory
from test_chatdgc_canvas import Model

DECK = {"theme": "dusk", "slides": [{"layout": "title", "title": "Goa in three days"},
                                    {"layout": "bullets", "title": "Day 1", "bullets": ["Beach", "Fort Aguada"]}]}


class ArtifactsInChat(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-artifacts-")
        self.addCleanup(temp.cleanup)
        folder = Path(os.path.realpath(temp.name))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(folder / "home")
        self.addCleanup(self._restore_env)
        self.world = {"script": [], "read": []}
        self.config = SimpleNamespace(base_url="", api_key="", model="chat-model", project_root=str(folder),
                                      get=lambda key, default=None: default)
        self.engine = ChatEngine(self.config, ChatStore(folder / "chat"), searcher=lambda q: [],
                                 memory=SharedMemory(folder / "memory"), projects=lambda hidden: [],
                                 client_factory=lambda model: Model(self.world), plugins=lambda chat, said, taint: None)
        self.heard = []
        self.engine.on_artifact = lambda view, op, chat_id: self.heard.append((view, op, chat_id))

    def _restore_env(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def say(self, text, *steps, chat=None, **kwargs):
        self.world["script"] += list(steps)
        chat = chat or self.engine.open(**({"temporary": True} if kwargs.pop("temporary", False) else {}))
        return chat, self.engine.send(chat["id"], text, search="off", **kwargs)

    def test_a_deck_is_kept_with_a_card_on_the_reply_and_every_screen_hears_it(self):
        chat, reply = self.say("Make me slides for the trip.",
                               {"calls": [("make_artifact", {"type": "slides", "title": "Goa trip", "data": DECK})]},
                               {"parts": ["Your deck is open beside the chat."]})
        [card] = reply["artifacts"]
        self.assertEqual((card["type"], card["title"], card["op"], card["version"]), ("slides", "Goa trip", "made", 1))
        view, op, chat_id = self.heard[-1]
        self.assertEqual((op, chat_id, view["origin"]), ("made", chat["id"], {"surface": "chat", "chat": chat["id"]}))
        self.assertEqual(artifact_store.store().get(card["id"]).type, "slides")
        self.assertIn("make_artifact", self.world["read"][0]["tools"])

    def test_non_text_artifact_note_does_not_abort_the_chat_activity(self):
        from dgc import artifact_service
        view = artifact_service.make("doc", "Notes", {"content": "Before"}, origin={"surface": "chat"})
        activity = []
        _chat, reply = self.say("Update the notes.",
            {"calls": [("edit_artifact", {"id": view["id"], "content": "After", "note": 7})]},
            {"parts": ["Updated the notes."]}, on_activity=lambda *args: activity.append(args))
        self.assertEqual(reply["text"], "Updated the notes.")
        self.assertEqual(artifact_store.store().source(view["id"]), "After")
        self.assertTrue(activity)

    def test_a_document_is_a_canvas_beside_the_chat(self):
        chat, reply = self.say("Write the plan as a document.",
                               {"calls": [("make_artifact", {"type": "doc", "title": "Plan", "content": "# Plan\n"})]},
                               {"parts": ["It's beside the chat."]})
        self.assertEqual(reply["canvases"][0]["title"], "Plan")
        self.assertNotIn("artifacts", reply)

    def test_the_output_chip_line_rides_on_this_reply_only_and_a_miss_is_said(self):
        chat, reply = self.say("Plan my Goa trip.", {"parts": ["Here's a plan in words."]}, output="slides")
        request = self.world["read"][0]["messages"]
        self.assertIn("The user chose Slides for this reply", str(request[-1]["content"]))
        self.assertNotIn("The user chose Slides", str(request[0]["content"]), "never in the system prompt")
        self.assertIn("didn't make slides", reply["output_note"])
        saved = self.engine.store.get(chat["id"])
        user = next(m for m in saved["messages"] if m["role"] == "user")
        self.assertEqual(user.get("output"), "slides")
        self.assertNotIn("The user chose", user["text"], "the saved message is what the user typed")

    def test_the_chip_kept_its_promise_so_no_note(self):
        chat, reply = self.say("Plan my Goa trip.",
                               {"calls": [("make_artifact", {"type": "slides", "title": "Goa", "data": DECK})]},
                               {"parts": ["Done."]}, output="slides")
        self.assertNotIn("output_note", reply)

    def test_a_temporary_chat_makes_no_artifacts(self):
        chat, reply = self.say("Slides please.",
                               {"calls": [("make_artifact", {"type": "slides", "title": "Goa", "data": DECK})]},
                               {"parts": ["I can't keep slides in a temporary chat."]}, temporary=True)
        self.assertNotIn("artifacts", reply)
        self.assertEqual(artifact_store.store().list(), [])


if __name__ == "__main__":
    unittest.main()
