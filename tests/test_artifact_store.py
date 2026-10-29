"""The artifact store: one place for every page, document, deck, sheet and dashboard DGC makes.

What matters most here is that nothing is ever lost: every change is a new version, an old version is never
rewritten, a restore is itself a new version, two writers at once never tear a file or skip a version, and removing
an artifact moves it aside rather than deleting it. And that a page's files can't name their way out of the store.
"""
from __future__ import annotations

import json
import multiprocessing
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_store
from dgc.artifact_store import ArtifactConflict, ArtifactError, Store


def _bump(root: str, aid: str, count: int) -> None:
    store = Store(root)
    for i in range(count):
        while True:
            art = store.get(aid)
            try:
                store.update(aid, f"line {os.getpid()} {i}\n", base_version=art.version, author=f"p{os.getpid()}")
                break
            except ArtifactConflict:
                continue


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-artifacts-"))
        self.store = Store(self.root)

    def test_a_doc_keeps_every_version_and_who_made_it(self):
        art = self.store.create("doc", "Launch notes", "# Launch\n", origin={"surface": "chat", "chat": "c1"})
        self.store.update(art.id, "# Launch\n\nShip Friday.\n", author="you", summary="Added the date")
        self.store.update(art.id, "# Launch\n\nShip Monday.\n", author="DGC", summary="Moved the date")
        versions = self.store.versions(art.id)
        self.assertEqual([v.n for v in versions], [1, 2, 3])
        self.assertEqual([v.author for v in versions], ["DGC", "you", "DGC"])
        self.assertEqual(self.store.source(art.id, 2), "# Launch\n\nShip Friday.\n")
        self.assertEqual(self.store.source(art.id), "# Launch\n\nShip Monday.\n")
        self.assertEqual(self.store.get(art.id).version, 3)

    def test_an_unchanged_save_makes_no_empty_version(self):
        art = self.store.create("doc", "Notes", "same\n", origin={"surface": "work"})
        self.store.update(art.id, "same\n")
        self.assertEqual(self.store.get(art.id).version, 1)

    def test_a_stale_writer_is_refused_and_nothing_is_written(self):
        art = self.store.create("sheet", "Budget", {"sheets": []}, origin={"surface": "chat"})
        self.store.update(art.id, {"sheets": [{"name": "Q1"}]}, base_version=1)
        with self.assertRaises(ArtifactConflict):
            self.store.update(art.id, {"sheets": [{"name": "stale"}]}, base_version=1)
        self.assertEqual(self.store.source(art.id), {"sheets": [{"name": "Q1"}]})
        self.assertEqual(self.store.get(art.id).version, 2)

    def test_restore_is_a_new_version_and_keeps_the_ones_between(self):
        art = self.store.create("slides", "Deck", {"slides": [1]}, origin={"surface": "chat"})
        self.store.update(art.id, {"slides": [1, 2]})
        self.store.update(art.id, {"slides": [1, 2, 3]})
        self.store.restore(art.id, 1, author="you")
        self.assertEqual(self.store.get(art.id).version, 4)
        self.assertEqual(self.store.source(art.id), {"slides": [1]})
        self.assertEqual(self.store.source(art.id, 3), {"slides": [1, 2, 3]})
        self.assertEqual(self.store.version(art.id, 4).summary, "Restored version 1")

    def test_old_versions_are_never_rewritten(self):
        art = self.store.create("doc", "D", "one\n", origin={"surface": "chat"})
        v1 = (self.root / art.id / "versions" / "1.json").read_bytes()
        for i in range(5):
            self.store.update(art.id, f"{i}\n")
        self.assertEqual((self.root / art.id / "versions" / "1.json").read_bytes(), v1)
        self.assertEqual(self.store.source(art.id, 1), "one\n")

    def test_a_page_stores_a_file_once_however_many_versions_hold_it(self):
        logo = os.urandom(200_000)
        art = self.store.create("page", "Site", {"index.html": "<h1>v1</h1>", "img/logo.png": logo},
                                origin={"surface": "work", "project": "/p"})
        self.store.update(art.id, {"index.html": "<h1>v2</h1>", "img/logo.png": logo})
        blobs = list((self.root / art.id / "blobs").iterdir())
        self.assertEqual(len(blobs), 3)            # two pages, one logo
        self.assertEqual(self.store.read_file(art.id, "img/logo.png", 1), logo)
        self.assertEqual(self.store.get(art.id).entry, "index.html")

    def test_a_page_file_cannot_name_its_way_out(self):
        for bad in ("../x.html", "/etc/passwd", ".env", "a/.git/config", "C:/x.html", "a/../../b", ""):
            with self.assertRaises(ArtifactError, msg=bad):
                self.store.create("page", "P", {"index.html": "x", bad: "y"}, origin={"surface": "work"})
        self.assertEqual(self.store.list(), [])

    def test_materialize_writes_only_inside_a_new_or_empty_folder(self):
        art = self.store.create("page", "P", {"index.html": "<p>hi</p>", "css/a.css": "p{}"},
                                origin={"surface": "chat"})
        dest = self.root.parent / f"{self.root.name}-out"
        self.store.materialize(art.id, dest)
        self.assertEqual((dest / "css" / "a.css").read_text(), "p{}")
        with self.assertRaises(ArtifactError):
            self.store.materialize(art.id, dest)   # not empty now: it is never wiped

    def test_a_version_too_large_is_refused_before_anything_is_written(self):
        art = self.store.create("doc", "D", "x\n", origin={"surface": "chat"})
        big = "y" * (artifact_store.MAX_VERSION_BYTES + 1)
        with self.assertRaises(ArtifactError):
            self.store.update(art.id, big)
        self.assertEqual(self.store.get(art.id).version, 1)
        self.assertEqual(len(list((self.root / art.id / "blobs").iterdir())), 1)

    def test_remove_moves_to_trash_and_the_list_skips_it(self):
        art = self.store.create("dashboard", "KPIs", {"charts": []}, origin={"surface": "pip", "pip": "pulse"})
        moved = self.store.remove(art.id)
        self.assertTrue((moved / "artifact.json").is_file())
        self.assertEqual(moved.parent.name, ".trash")
        self.assertEqual(self.store.list(), [])
        self.assertFalse(self.store.exists(art.id))

    def test_list_filters_and_skips_a_half_made_folder(self):
        self.store.create("doc", "A", "a\n", origin={"surface": "chat"})
        self.store.create("sheet", "B", {}, origin={"surface": "work"})
        (self.root / ("ar_" + "0" * 16)).mkdir()                       # a crash left an empty folder
        (self.root / ("ar_" + "1" * 16)).mkdir()
        (self.root / ("ar_" + "1" * 16) / "artifact.json").write_text("{not json")
        self.assertEqual(len(self.store.list()), 2)
        self.assertEqual([a.title for a in self.store.list(type="sheet")], ["B"])
        self.assertEqual([a.title for a in self.store.list(surface="chat")], ["A"])

    def test_ids_and_types_are_checked(self):
        with self.assertRaises(ArtifactError):
            self.store.create("design", "X", {}, origin={"surface": "chat"})
        with self.assertRaises(ArtifactError):
            self.store.create("doc", "X", "x", origin={"surface": "somewhere"})
        with self.assertRaises(ArtifactError):
            self.store.get("../../etc")
        with self.assertRaises(ArtifactError):
            self.store.create("doc", "X", {"not": "text"}, origin={"surface": "chat"})

    def test_files_are_private_to_the_account(self):
        art = self.store.create("doc", "D", "secret plans\n", origin={"surface": "chat"})
        meta = self.root / art.id / "artifact.json"
        self.assertEqual(oct(meta.stat().st_mode & 0o777), "0o600")
        blob = next((self.root / art.id / "blobs").iterdir())
        self.assertEqual(oct(blob.stat().st_mode & 0o777), "0o600")

    def test_titles_are_one_clean_line(self):
        art = self.store.create("doc", "  Q3\n\treview\x00  ", "x", origin={"surface": "chat"})
        self.assertEqual(art.title, "Q3 review")
        self.assertEqual(Store(self.root).get(art.id).title, "Q3 review")
        renamed = self.store.set_meta(art.id, title="New name")
        self.assertEqual(renamed.version, 1)       # a rename is not a new version

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_two_processes_writing_at_once_never_lose_or_skip_a_version(self):
        art = self.store.create("doc", "Shared", "start\n", origin={"surface": "chat"})
        ctx = multiprocessing.get_context("fork")
        procs = [ctx.Process(target=_bump, args=(str(self.root), art.id, 15)) for _ in range(3)]
        for p in procs:
            p.start()
        for p in procs:
            p.join(60)
            self.assertEqual(p.exitcode, 0)
        versions = self.store.versions(art.id)
        self.assertEqual(self.store.get(art.id).version, 46)
        self.assertEqual([v.n for v in versions], list(range(1, 47)))
        for v in versions:                          # every version's record and its file are whole
            json.loads((self.root / art.id / "versions" / f"{v.n}.json").read_text())
            self.store.source(art.id, v.n)


if __name__ == "__main__":
    unittest.main()
