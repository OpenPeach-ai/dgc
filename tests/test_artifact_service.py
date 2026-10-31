"""One way to make, change, show, export and serve an artifact, whichever part of DGC asks.

The model's tools, the Library, the CLI and the SDK all come through dgc.artifact_service, so these tests hold the
behaviour every one of them gets: a choice is checked before anything is written, an edit lands on the current
version or says why not, exports are real files, and an artifact shown in the browser is served at an address of its
own, from a folder that holds only what it shows.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import dgc.artifacts as A
from dgc import artifact_service as S
from dgc.artifact_store import Store

DECK = {"theme": "paper", "slides": [{"layout": "title", "title": "Q3 review", "subtitle": "Editor team"},
                                     {"layout": "bullets", "title": "Results",
                                      "bullets": ["Weekly users grew 38%", "Two hires joined"]}]}


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-artsvc-")))
        self.store = Store(self.tmp / "artifacts")
        self.chat = {"surface": "chat", "chat": "chat_" + "a" * 32}

    def test_a_doc_is_made_edited_exactly_and_versioned(self):
        doc = S.make("document", "Launch plan", {"content": "# Launch\n\nShip Friday.\n"}, origin=self.chat,
                     store=self.store)
        self.assertEqual((doc["type"], doc["version"], doc["label"]), ("doc", 1, "Document"))
        changed = S.edit(doc["id"], edits=[{"find": "Friday", "replace": "Monday"}], note="Moved", store=self.store)
        self.assertEqual(changed["version"], 2)
        self.assertIn("Ship Monday.", S.outline(doc["id"], store=self.store))
        with self.assertRaises(S.ArtifactUseError):
            S.edit(doc["id"], edits=[{"find": "Tuesday", "replace": "x"}], store=self.store)
        self.assertEqual(S.view(doc["id"], store=self.store)["version"], 2)

    def test_a_stale_edit_is_refused_and_nothing_is_written(self):
        doc = S.make("doc", "D", "one\n", origin=self.chat, store=self.store)
        S.edit(doc["id"], content="two\n", store=self.store, author="you")
        with self.assertRaises(S.ArtifactUseError):
            S.edit(doc["id"], content="stale\n", base_version=1, store=self.store)
        self.assertIn("two", S.outline(doc["id"], store=self.store))

    def test_a_deck_is_checked_before_anything_is_written(self):
        with self.assertRaises(S.ArtifactUseError):
            S.make("slides", "Bad", {"slides": [{"layout": "nonsense"}]}, origin=self.chat, store=self.store)
        self.assertEqual(self.store.list(), [])
        deck = S.make("slides", "Q3", DECK, origin=self.chat, store=self.store)
        moved = S.edit(deck["id"], edits=[{"op": "move", "slide": 2, "to": 1}], store=self.store)
        self.assertEqual(moved["version"], 2)
        self.assertEqual(self.store.source(deck["id"])["slides"][0]["title"], "Results")

    def test_exports_are_real_files_of_each_kind(self):
        doc = S.make("doc", "Notes", "# Notes\n\n- one\n- two\n", origin=self.chat, store=self.store)
        word = S.export(doc["id"], "docx", store=self.store)
        self.assertTrue(zipfile.is_zipfile(word))
        self.assertIn("word/document.xml", zipfile.ZipFile(word).namelist())
        self.assertEqual(S.export(doc["id"], "md", store=self.store).read_text(), "# Notes\n\n- one\n- two\n")
        deck = S.make("slides", "Q3", DECK, origin=self.chat, store=self.store)
        pptx = S.export(deck["id"], "pptx", store=self.store)
        self.assertEqual(len([n for n in zipfile.ZipFile(pptx).namelist() if n.startswith("ppt/slides/slide")]), 2)
        with self.assertRaises(S.ArtifactUseError):
            S.export(deck["id"], "xlsx", store=self.store)
        self.assertEqual(oct(pptx.stat().st_mode & 0o777), "0o600")

    def test_a_doc_page_never_runs_html_from_the_text(self):
        html = S.doc_html("T", "# Hi\n\n<script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")
        self.assertNotIn("<script>alert", html)
        self.assertIn("<table>", html)

    def test_dashboard_pdf_prints_the_snapshot_and_reports_a_missing_browser(self):
        import base64
        seen = {}
        class Browser:
            def navigate(self, url):
                seen["path"] = Path(url.removeprefix("file://"))
                seen["html"] = seen["path"].read_text()
            def command(self, method, params, timeout=0):
                seen["method"] = method
                return {"data": base64.b64encode(b"%PDF-1.7\nfixture\n%%EOF").decode()}
        dash = {"title": "Snapshot", "sources": [{"id": "shop", "kind": "sqlite", "path": "shop.db"}],
                "widgets": [{"id": "n", "kind": "number", "title": "Orders", "source": "shop", "value": "n",
                             "query": "SELECT COUNT(*) AS n FROM orders"}]}
        aid = S.make("dashboard", "Snapshot", dash, origin=self.chat, store=self.store)["id"]
        target = S.export(aid, "pdf", browser=Browser(), store=self.store)
        self.assertTrue(target.read_bytes().startswith(b"%PDF"))
        self.assertEqual(seen["method"], "Page.printToPDF")
        self.assertIn("Orders", seen["html"])
        self.assertFalse(seen["path"].exists(), "temporary print content is removed")
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        class Missing:
            def navigate(self, _url):
                raise RuntimeError("No Chrome or Chromium found. Install one")
        with self.assertRaisesRegex(S.ArtifactUseError, "couldn't be printed"):
            S.export(aid, "pdf", browser=Missing(), store=self.store)

    def test_dashboard_render_does_not_show_numbers_from_another_version(self):
        from unittest.mock import patch
        dash = {"title": "Snapshot", "sources": [{"id": "shop", "kind": "sqlite", "path": "shop.db"}],
                "widgets": [{"id": "n", "kind": "number", "title": "Orders", "source": "shop", "value": "n",
                             "query": "SELECT COUNT(*) AS n FROM orders"}]}
        aid = S.make("dashboard", "Snapshot", dash, origin=self.chat, store=self.store)["id"]
        S._put_state(aid, {"version": 1, "results": {"n": {"value": 123}}}, self.store)
        S.allow_source(aid, "shop", store=self.store)
        S.edit(aid, content={**dash, "title": "Revised"}, store=self.store)
        with patch("dgc.artifact_dashboard.render_html", return_value="ok") as render:
            S.render(aid, store=self.store)
            self.assertEqual(render.call_args.args[1], {})
            S.render(aid, 1, store=self.store)
            self.assertEqual(render.call_args.args[1], {"n": {"value": 123}})

    def test_dashboard_waits_for_allow_before_the_first_refresh(self):
        dash = {"title": "Sales", "sources": [{"id": "shop", "kind": "sqlite", "path": "shop.db"}],
                "widgets": [{"id": "n", "kind": "number", "title": "Orders", "source": "shop", "value": "n",
                             "query": "SELECT COUNT(*) AS n FROM orders"}]}
        aid = S.make("dashboard", "My sales", dash, origin=self.chat, store=self.store)["id"]
        html = S.render(aid, store=self.store)[0]["index.html"].decode()
        self.assertIn("Allow shop.db to show this", html)
        self.assertIn("My sales", html)
        S.allow_source(aid, "shop", store=self.store)
        html = S.render(aid, store=self.store)[0]["index.html"].decode()
        self.assertIn("Not refreshed yet", html)

    def test_a_page_the_model_writes_is_kept_and_restored(self):
        page = S.make("page", "Timer", {"html": "<h1>v1</h1>"}, origin=self.chat, store=self.store)
        S.edit(page["id"], content={"html": "<h1>v2</h1>"}, store=self.store)
        S.restore(page["id"], 1, store=self.store)
        self.assertEqual(self.store.read_file(page["id"], "index.html"), b"<h1>v1</h1>")
        self.assertEqual([v["summary"] for v in S.view(page["id"], store=self.store)["versions"]],
                         ["Made", "Changed", "Restored version 1"])

    def test_a_page_file_marker_does_not_replace_saved_html(self):
        marker = "@@FILE: /tmp/missing-page.html"
        with self.assertRaisesRegex(S.ArtifactUseError, "file reference"):
            S.make("page", "Bad", {"html": marker}, origin=self.chat, store=self.store)
        self.assertEqual(self.store.list(), [])
        page = S.make("page", "Good", {"html": "<h1>Saved</h1>"}, origin=self.chat, store=self.store)
        with self.assertRaisesRegex(S.ArtifactUseError, "file reference"):
            S.edit(page["id"], content={"html": marker}, store=self.store)
        with self.assertRaisesRegex(S.ArtifactUseError, "file reference"):
            S.edit(page["id"], content={"files": {"index.html": marker}}, store=self.store)
        self.assertEqual(S.view(page["id"], store=self.store)["version"], 1)
        self.assertEqual(self.store.read_file(page["id"], "index.html"), b"<h1>Saved</h1>")

    def test_listing_filters_by_type_and_where_it_was_made(self):
        S.make("doc", "A", "a\n", origin=self.chat, store=self.store)
        S.make("slides", "B", DECK, origin={"surface": "work", "project": "/p"}, store=self.store)
        self.assertEqual([a["title"] for a in S.listing(type="slides", store=self.store)], ["B"])
        self.assertEqual([a["title"] for a in S.listing(surface="chat", store=self.store)], ["A"])

    def test_a_doc_is_edited_in_its_own_file_and_the_users_typing_is_their_version(self):
        doc = S.make("doc", "Plan", "# Plan\n\nOne.\n", origin={"surface": "work", "project": "/p"},
                     store=self.store)
        path = Path(doc["file"])
        self.assertEqual(path.read_text(), "# Plan\n\nOne.\n")
        path.write_text("# Plan\n\nOne, by me.\n")                         # typed in the editor
        S.edit(doc["id"], edits=[{"find": "One, by me.", "replace": "One, by me. Two."}], store=self.store)
        versions = S.view(doc["id"], store=self.store)["versions"]
        self.assertEqual([(v["author"], v["summary"]) for v in versions],
                         [("DGC", "Made"), ("you", "Your edits"), ("DGC", "Changed")])
        self.assertEqual(path.read_text(), "# Plan\n\nOne, by me. Two.\n")   # the editor shows the change
        S.restore(doc["id"], 1, store=self.store)
        self.assertEqual(path.read_text(), "# Plan\n\nOne.\n")

    def test_a_save_in_the_editor_is_kept_as_a_version(self):
        doc = S.make("doc", "Notes", "a\n", origin=self.chat, store=self.store)
        Path(doc["file"]).write_text("a, saved\n")
        self.assertTrue(S.keep_users_edits(doc["id"], store=self.store))
        self.assertFalse(S.keep_users_edits(doc["id"], store=self.store))      # nothing new: no empty version
        self.assertEqual(self.store.source(doc["id"]), "a, saved\n")

    def test_a_canvas_changed_through_its_artifact_changes_its_file(self):
        from dgc.chatdgc.canvas import Canvases
        canvases = Canvases(self.tmp / "canvas", self.store)
        chat = "chat_" + "c" * 32
        view = canvases.create(chat, title="Trip", kind="document", language="", content="Goa\n")
        S.edit(view["artifact"], content="Goa, then Panjim\n", store=self.store)
        self.assertEqual(Path(view["path"]).read_text(), "Goa, then Panjim\n")
        self.assertEqual(canvases.get(chat, view["id"], text=True)["text"], "Goa, then Panjim\n")

    def test_a_dashboard_source_pointed_at_other_data_is_asked_about_again(self):
        dash = {"title": "Sales", "sources": [{"id": "shop", "kind": "sqlite", "path": "data/shop.db"}],
                "widgets": [{"id": "n", "kind": "number", "title": "Orders", "source": "shop", "value": "n",
                             "query": "SELECT COUNT(*) AS n FROM orders"}]}
        made = S.make("dashboard", "Sales", dash, origin=self.chat, store=self.store)
        S.allow_source(made["id"], "shop", store=self.store)
        self.assertEqual(S.view(made["id"], store=self.store)["allowed_sources"], ["shop"], "the screens see the Allow")
        retitled = {**dash, "widgets": [{**dash["widgets"][0], "title": "Orders this month"}]}
        S.edit(made["id"], content=retitled, store=self.store)
        self.assertEqual(self.store.get(made["id"]).sources, ["shop"], "a new title keeps the Allow")
        moved = {**retitled, "sources": [{"id": "shop", "kind": "sqlite", "path": "data/other.db"}]}
        S.edit(made["id"], content=moved, store=self.store)
        self.assertEqual(self.store.get(made["id"]).sources, [], "other data under the same name is asked again")

    def test_restoring_dashboard_data_does_not_restore_or_transfer_consent(self):
        dash = {"title": "Sales", "sources": [{"id": "shop", "kind": "sqlite", "path": "data/old.db"}],
                "widgets": [{"id": "n", "kind": "number", "title": "Orders", "source": "shop", "value": "n",
                             "query": "SELECT COUNT(*) AS n FROM orders"}]}
        aid = S.make("dashboard", "Sales", dash, origin=self.chat, store=self.store)["id"]
        S.allow_source(aid, "shop", store=self.store)
        moved = {**dash, "sources": [{"id": "shop", "kind": "sqlite", "path": "data/new.db"}]}
        S.edit(aid, content=moved, store=self.store)
        S.allow_source(aid, "shop", store=self.store)
        restored = S.restore(aid, 1, store=self.store)
        self.assertEqual(restored["allowed_sources"], [], "permission for new.db cannot allow old.db")
        S.allow_source(aid, "shop", store=self.store)
        S.restore(aid, 1, store=self.store)
        self.assertEqual(self.store.get(aid).sources, ["shop"], "unchanged source keeps its current consent")

    def test_direct_store_update_revokes_changed_source_before_publishing_content(self):
        from unittest.mock import patch
        dash = {"title": "Sales", "sources": [{"id": "shop", "kind": "sqlite", "path": "data/old.db"}],
                "widgets": [{"id": "n", "kind": "number", "title": "Orders", "source": "shop", "value": "n",
                             "query": "SELECT COUNT(*) AS n FROM orders"}]}
        aid = S.make("dashboard", "Sales", dash, origin=self.chat, store=self.store)["id"]
        S.allow_source(aid, "shop", store=self.store)
        writes = []
        write = self.store._write_json
        def record(path, value):
            if path.name == "artifact.json":
                writes.append(dict(value))
            return write(path, value)
        with patch.object(self.store, "_write_json", side_effect=record):
            self.store.update(aid, {**dash, "sources": [{"id": "shop", "kind": "sqlite", "path": "data/new.db"}]})
        self.assertTrue(writes)
        self.assertTrue(all(not item.get("sources") for item in writes), "no published head may transfer consent")

    def test_an_artifact_is_shown_at_its_own_address_from_its_view_folder(self):
        state, A.STATE_FILE = A.STATE_FILE, self.tmp / "artifacts.json"
        server, A._SRV = A._SRV, A._Server(persistent=False)
        try:
            doc = S.make("doc", "Shown", "# Shown here\n", origin=self.chat, store=self.store)
            url = S.serve(doc["id"], store=self.store)
            self.assertTrue(url.startswith("http://127.0.0.1:"))
            body = urllib.request.urlopen(url, timeout=10).read().decode()
            self.assertIn("<h1>Shown here</h1>", body)
            S.edit(doc["id"], content="# Changed\n", store=self.store)
            again = S.serve(doc["id"], store=self.store)
            self.assertEqual(again, url)                                  # same address, new content
            self.assertIn("<h1>Changed</h1>", urllib.request.urlopen(again, timeout=10).read().decode())
            self.assertEqual(sorted(p.name for p in (self.store.root / doc["id"] / "view").iterdir()), ["index.html"])
        finally:
            A._SRV.shutdown()
            A._SRV, A.STATE_FILE = server, state


if __name__ == "__main__":
    unittest.main()
