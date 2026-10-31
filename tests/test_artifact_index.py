"""What was made before the artifact store comes into it once: Work's old served pages, ChatDGC's widgets and the
spreadsheets a chat made. Indexing again adds nothing, and one moved to the trash isn't brought back."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import dgc.artifacts as A
from dgc import artifact_index, artifact_store
from dgc import artifact_service as S
from dgc.chatdgc.store import ChatStore

WIDGET = "wg_" + "a" * 16
GONE = "wg_" + "b" * 16
MADE = "att_" + "1" * 32
UPLOADED = "att_" + "2" * 32


class Index(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-index-")))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp)
        self._state, A.STATE_FILE = A.STATE_FILE, self.tmp / "artifacts.json"
        self._srv, A._SRV = A._SRV, A._Server(persistent=False)
        self.store = artifact_store.store()
        self.chats = ChatStore(self.tmp / "chat")

    def tearDown(self):
        A._SRV.shutdown()
        A._SRV, A.STATE_FILE = self._srv, self._state
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def run_index(self):
        return artifact_index.index(chats=self.chats, force=True)

    def seed_chat(self):
        chat = self.chats.create()
        chat["messages"] = [
            {"id": "msg_" + "0" * 32, "role": "user", "text": "Make me a tip calculator and the sales table",
             "attachments": [{"id": UPLOADED, "name": "mine.csv", "kind": "document", "mime": "text/csv", "size": 20}],
             "created_at": "2026-10-20T09:00:00.000Z"},
            {"id": "msg_" + "1" * 32, "role": "assistant", "text": "Here they are.",
             "widgets": [{"id": WIDGET, "title": "Tip calculator", "html": "<p>Tip: 10%</p>",
                          "created_at": "2026-10-20T09:01:00.000Z"},
                         {"id": GONE, "title": "Deleted one", "removed": True, "created_at": "2026-10-20T09:01:00.000Z"}],
             "files": [{"id": MADE, "name": "sales.csv", "kind": "document", "mime": "text/csv", "size": 30,
                        "made": True}],
             "created_at": "2026-10-20T09:01:00.000Z"},
        ]
        self.chats.save(chat)
        self.chats.put_file(chat["id"], MADE, b"city,amount\nGoa,1200\nPune,800\n")
        self.chats.put_file(chat["id"], UPLOADED, b"a,b\n1,2\n")
        return chat

    def test_an_old_served_page_comes_in_once_and_a_trashed_one_stays_out(self):
        site = self.tmp / "site"
        site.mkdir()
        (site / "index.html").write_text("<h1>Old page</h1>")
        old = A._SRV.add(str(site), str(self.tmp), "Old page")
        self.assertEqual(old.store_id, "")
        self.assertEqual(self.run_index(), 1)
        pages = self.store.list(type="page")
        self.assertEqual([p.legacy.get("server") for p in pages], [old.id])
        self.assertEqual(old.store_id, pages[0].id)
        self.assertEqual(self.store.read_file(pages[0].id, "index.html"), b"<h1>Old page</h1>")
        self.assertEqual(self.run_index(), 0)
        self.store.remove(pages[0].id)
        old.store_id = ""                         # even an entry that forgot its page isn't brought back
        self.assertEqual(self.run_index(), 0)
        self.assertEqual(self.store.list(), [])

    def test_a_widget_becomes_a_page_of_its_own_html_and_a_removed_one_does_not(self):
        chat = self.seed_chat()
        self.run_index()
        pages = self.store.list(type="page")
        self.assertEqual([p.title for p in pages], ["Tip calculator"])
        page = pages[0]
        self.assertEqual(page.origin, {"surface": "chat", "chat": chat["id"]})
        self.assertEqual((page.legacy["widget"], page.legacy["chat"]), (WIDGET, chat["id"]))
        self.assertEqual(self.store.read_file(page.id, "index.html"), b"<p>Tip: 10%</p>")
        self.assertEqual(self.chats.widget(chat["id"], WIDGET)["html"], "<p>Tip: 10%</p>", "the chat keeps its widget")
        self.assertEqual(self.run_index(), 0)
        self.store.remove(page.id)
        self.assertEqual(self.run_index(), 0)
        self.assertEqual(self.store.list(type="page"), [])

    def test_a_spreadsheet_a_chat_made_becomes_a_sheet_and_an_uploaded_one_stays_a_file(self):
        chat = self.seed_chat()
        self.run_index()
        sheets = self.store.list(type="sheet")
        self.assertEqual([s.title for s in sheets], ["sales"])
        self.assertEqual(sheets[0].legacy, {"made": MADE, "chat": chat["id"]})
        self.assertIn("Goa", json.dumps(self.store.source(sheets[0].id)))
        self.assertEqual(self.run_index(), 0)
        self.assertEqual(len(self.store.list(type="sheet")), 1)

    def test_sheet_import_commits_its_legacy_identity_with_the_first_version(self):
        from unittest.mock import patch
        self.seed_chat()
        # A process may end between any two writes. No extra metadata write may be
        # needed to recognize a spreadsheet imported by a previous process.
        with patch.object(self.store, "set_meta", side_effect=OSError("metadata write unavailable")):
            self.run_index()
        sheets = self.store.list(type="sheet")
        self.assertEqual(len(sheets), 1)
        self.assertEqual(sheets[0].legacy.get("made"), MADE)
        self.run_index()
        self.assertEqual(len(self.store.list(type="sheet")), 1)

    def test_unwritable_index_lock_does_not_hide_existing_artifacts(self):
        from unittest.mock import patch
        view = S.make("sheet", "Existing", {"sheets": [{"name": "Sheet", "columns": [{"name": "City"}],
                        "rows": [["Goa"]]}]}, origin={"surface": "work"})
        artifact_index._last = 0.0
        with patch.object(artifact_index.os, "open", side_effect=PermissionError("read-only store")):
            listed = S.listing()
        self.assertEqual([item["id"] for item in listed], [view["id"]])

    def test_the_library_listing_indexes_but_not_more_than_once_in_a_while(self):
        self.seed_chat()
        artifact_index._last = 0.0
        real = artifact_index.index

        calls = []

        def counted(**kw):
            calls.append(kw)
            return real(chats=self.chats, **kw)
        artifact_index.index = counted
        self.addCleanup(setattr, artifact_index, "index", real)
        listed = S.listing()
        self.assertEqual(sorted(a["type"] for a in listed), ["page", "sheet"])
        S.listing()
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(S.listing()), 2, "the second pass, inside the interval, adds nothing")

    def test_another_sdk_state_dir_indexes_without_waiting_for_the_first(self):
        chat = self.seed_chat()
        self.assertEqual(artifact_index.index(store=self.store, chats=self.chats, force=True), 2)
        other_store = artifact_store.Store(self.tmp / "other-artifacts")
        other_chats = ChatStore(self.tmp / "other-chat")
        other_chat = other_chats.create()
        other_chat["messages"] = chat["messages"]
        other_chats.save(other_chat)
        self.assertEqual(artifact_index.index(store=other_store, chats=other_chats), 1)
        self.assertEqual([art.title for art in other_store.list(type="page")], ["Tip calculator"])


if __name__ == "__main__":
    unittest.main()
