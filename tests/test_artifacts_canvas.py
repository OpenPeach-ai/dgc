"""ChatDGC's canvases are Docs in the one artifact store.

A canvas made before the store kept its versions in its own folder; the first time it is read, that history moves
into the store with each version's author, time and note, and the file the user edits stays exactly where the editor
opens it. A branched chat's canvases become artifacts of their own, history included, and a deleted chat's canvases
go to the store's trash rather than vanishing.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc.artifact_store import Store
from dgc.chatdgc.canvas import Canvases

CHAT = "chat_" + "a" * 32
BRANCH = "chat_" + "b" * 32


class CanvasInTheStoreTest(unittest.TestCase):
    def setUp(self):
        base = Path(tempfile.mkdtemp(prefix="dgc-canvas-store-"))
        self.store = Store(base / "artifacts")
        self.canvases = Canvases(base / "canvas", self.store)
        self.base = base

    def test_a_canvas_is_a_doc_artifact_of_its_chat_with_every_version(self):
        view = self.canvases.create(CHAT, title="Trip plan", kind="document", language="", content="# Goa\n")
        self.canvases.edit(CHAT, view["id"], content="# Goa\n\nDay 1: beach.\n", note="Day 1")
        arts = self.store.list()
        self.assertEqual(len(arts), 1)
        art = arts[0]
        self.assertEqual((art.type, art.title, art.origin), ("doc", "Trip plan", {"surface": "chat", "chat": CHAT}))
        self.assertEqual(art.legacy["canvas"], view["id"])
        self.assertEqual([(v.author, v.summary) for v in self.store.versions(art.id)],
                         [("DGC", "Created"), ("DGC", "Day 1")])
        self.assertEqual(self.canvases.get(CHAT, view["id"])["artifact"], art.id)

    def test_the_users_edit_in_the_editor_is_their_version_in_the_store(self):
        view = self.canvases.create(CHAT, title="Notes", kind="document", language="", content="one\n")
        Path(view["path"]).write_text("one, by me\n")
        self.canvases.edit(CHAT, view["id"], content="one, by me\ntwo\n")
        authors = [v.author for v in self.store.versions(view["artifact"])]
        self.assertEqual(authors, ["DGC", "you", "DGC"])
        self.assertEqual(self.store.source(view["artifact"], 2), "one, by me\n")

    def test_a_canvas_from_before_the_store_moves_its_history_in_on_first_read(self):
        cid = "cv_" + "c" * 16
        folder = self.base / "canvas" / CHAT / cid
        (folder / ".versions").mkdir(parents=True)
        (folder / ".versions" / "v3.md").write_text("draft\n")
        (folder / ".versions" / "v4.md").write_text("draft, edited by me\n")
        (folder / "Old plan.md").write_text("draft, edited by me\n")
        (folder / "meta.json").write_text(json.dumps({
            "id": cid, "title": "Old plan", "kind": "document", "language": "markdown", "ext": "md",
            "file": "Old plan.md", "created_at": "2026-10-01T09:00:00Z",
            "versions": [{"n": 3, "at": "2026-10-01T09:00:00Z", "by": "model", "note": "Created", "chars": 6},
                         {"n": 4, "at": "2026-10-02T10:30:00Z", "by": "user", "note": "Your edits", "chars": 20}]}))
        view = self.canvases.get(CHAT, cid, text=True)
        self.assertEqual(view["text"], "draft, edited by me\n")
        versions = self.store.versions(view["artifact"])
        self.assertEqual([(v.author, v.at, v.summary) for v in versions],
                         [("DGC", "2026-10-01T09:00:00Z", "Created"), ("you", "2026-10-02T10:30:00Z", "Your edits")])
        meta = json.loads((folder / "meta.json").read_text())
        self.assertNotIn("versions", meta)                     # the store holds them now
        self.assertEqual(self.canvases.get(CHAT, cid)["artifact"], view["artifact"])   # moved once, not each read
        self.assertEqual(len(self.store.list()), 1)

    def test_a_branch_gets_its_own_artifacts_with_the_history_so_far(self):
        view = self.canvases.create(CHAT, title="Plan", kind="document", language="", content="v1\n")
        self.canvases.edit(CHAT, view["id"], content="v2\n")
        self.canvases.copy_chat(CHAT, BRANCH)
        theirs = self.canvases.get(BRANCH, view["id"], text=True)
        self.assertNotEqual(theirs["artifact"], view["artifact"])
        self.assertEqual(theirs["text"], "v2\n")
        self.assertEqual(len(self.store.versions(theirs["artifact"])), 2)
        self.canvases.edit(BRANCH, view["id"], content="branch only\n")
        self.assertEqual(self.canvases.get(CHAT, view["id"], text=True)["text"], "v2\n")
        self.assertEqual(self.store.get(theirs["artifact"]).origin, {"surface": "chat", "chat": BRANCH})

    def test_deleting_a_chat_moves_its_canvases_to_the_trash(self):
        view = self.canvases.create(CHAT, title="Plan", kind="document", language="", content="x\n")
        self.canvases.remove_chat(CHAT)
        self.assertEqual(self.store.list(), [])
        trashed = list((self.store.root / ".trash").iterdir())
        self.assertEqual(len(trashed), 1)
        self.assertTrue(trashed[0].name.startswith(view["artifact"]))
        self.assertFalse((self.base / "canvas" / CHAT).exists())

    def test_the_compare_view_files_come_back_from_the_store_when_missing(self):
        view = self.canvases.create(CHAT, title="Plan", kind="document", language="", content="first\n")
        self.canvases.edit(CHAT, view["id"], content="second\n")
        got = self.canvases.get(CHAT, view["id"])
        first = Path(got["versions"][0]["path"])
        first.unlink(missing_ok=True)
        again = self.canvases.get(CHAT, view["id"])
        self.assertEqual(Path(again["versions"][0]["path"]).read_text(), "first\n")


if __name__ == "__main__":
    unittest.main()
