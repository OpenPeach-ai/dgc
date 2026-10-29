"""Artifact regressions: saved identity, malformed inputs, and consistent snapshots."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import artifact_service as service
from dgc.artifact_store import ArtifactError, Store
from dgc.artifact_commands import ArtifactCommands


class ArtifactAuditTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-artifact-audit-")
        self.addCleanup(tmp.cleanup)
        self.store = Store(Path(tmp.name))

    def make(self, kind, content, **kwargs):
        return self.store.create(kind, "Example", content, origin={"surface": "sdk"}, **kwargs)

    def test_compare_reports_added_empty_rows(self):
        def book(rows):
            return {"sheets": [{"name": "S", "columns": [{"name": "A"}], "rows": rows}]}
        art = self.make("sheet", book([[1]]))
        self.store.update(art.id, book([[1], [None]]))
        compared = service.compare(art.id, 1, 2, store=self.store)
        self.assertGreater(compared["total"], 0)
        self.assertTrue(any("row" in c["label"].lower() for c in compared["changes"]))

    def test_compare_reports_a_final_newline_change(self):
        for line in ("line", "--line"):
            with self.subTest(line=line):
                art = self.make("doc", line)
                self.store.update(art.id, line + "\n")
                compared = service.compare(art.id, 1, 2, store=self.store)
                self.assertIn("-" + line, compared["diff"])
                self.assertIn("+" + line, compared["diff"])
                self.assertIn("No newline", compared["diff"])

    def test_entry_only_page_change_is_saved_and_comparable(self):
        files = {"one.html": "one", "two.html": "two"}
        art = self.make("page", files, entry="one.html")
        self.store.update(art.id, files, entry="two.html")
        self.assertEqual(self.store.get(art.id).version, 2)
        self.assertEqual(self.store.get(art.id).entry, "two.html")
        self.assertGreater(service.compare(art.id, 1, 2, store=self.store)["total"], 0)

    def test_page_restore_export_and_clone_keep_each_versions_entry(self):
        art = self.make("page", {"one.html": "one"}, entry="one.html")
        self.store.update(art.id, {"two.html": "two"}, entry="two.html")
        files, entry = service.render(art.id, 1, store=self.store)
        self.assertEqual(entry, "one.html")
        self.assertEqual(files[entry], b"one")
        clone = self.store.clone(art.id, origin={"surface": "sdk"})
        self.assertEqual(service.render(clone.id, 1, store=self.store)[1], "one.html")
        self.assertEqual(service.export(art.id, "html", n=1, store=self.store).read_text(), "one")
        restored = self.store.restore(art.id, 1)
        self.assertEqual(restored.entry, "one.html")
        self.assertEqual(self.store.get(art.id).version, 3)

    def test_model_page_input_rejects_non_content_values(self):
        for value in (10, True, [65, 66], None, {}):
            with self.subTest(value=value), self.assertRaises(service.ArtifactUseError):
                service.make("page", "Bad", {"files": {"index.html": value}},
                             origin={"surface": "sdk"}, store=self.store)
        self.assertEqual(self.store.list(), [])

    def test_model_page_empty_mapping_has_a_useful_validation_error(self):
        with self.assertRaises(service.ArtifactUseError):
            service.make("page", "Bad", {"files": {}}, origin={"surface": "sdk"}, store=self.store)

    def test_store_rejects_non_content_page_values(self):
        with self.assertRaises(ArtifactError):
            self.make("page", {"index.html": 10})
        self.assertEqual(self.store.list(), [])

    def test_get_snapshot_content_matches_its_observed_version(self):
        art = self.make("doc", "old")
        events = []
        commands = ArtifactCommands(lambda kind, **fields: events.append({"type": kind, **fields}))
        original = self.store.source
        def raced(aid, n=None):
            if self.store.get(aid).version == 1:
                self.store.update(aid, "new")
            return original(aid, n)
        with patch("dgc.artifact_store.store", return_value=self.store), patch.object(self.store, "source", side_effect=raced):
            commands.dispatch({"type": "artifact_get", "id": art.id, "content": True, "request_id": "read"})
        self.assertEqual(events[0]["type"], "artifact_detail")
        self.assertEqual(events[0]["artifact"]["version"], 1)
        self.assertEqual(events[0]["content"], "old")

    def test_library_skips_structurally_broken_metadata(self):
        good = self.make("doc", "good")
        bad = self.make("doc", "bad")
        path = self.store._dir(bad.id) / "artifact.json"
        original = json.loads(path.read_text())
        for field, value in (("version", "broken"), ("origin", 5), ("sources", 5), ("link", [])):
            with self.subTest(field=field):
                path.write_text(json.dumps({**original, field: value}))
                self.assertEqual([a.id for a in self.store.list()], [good.id])

    def test_export_requests_keep_distinct_version_bytes(self):
        art = self.make("doc", "old")
        self.store.update(art.id, "new")
        before = service.export(art.id, "md", n=1, store=self.store)
        after = service.export(art.id, "md", n=2, store=self.store)
        self.assertNotEqual(before, after)
        self.assertEqual(before.read_text(), "old")
        self.assertEqual(after.read_text(), "new")

    def test_a_stale_allow_cannot_authorize_a_replaced_source(self):
        old = {"sources": [{"id": "sales", "kind": "file", "path": "old.csv"}], "widgets": []}
        new = {"sources": [{"id": "sales", "kind": "file", "path": "new.csv"}], "widgets": []}
        art = self.make("dashboard", old)
        self.store.update(art.id, new)
        with self.assertRaises(service.ArtifactUseError):
            service.allow_source(art.id, "sales", base_version=1, store=self.store)
        self.assertEqual(self.store.get(art.id).sources, [])
        service.allow_source(art.id, "sales", base_version=2, store=self.store)
        self.assertEqual(self.store.get(art.id).sources, ["sales"])

    def test_document_save_preserves_a_late_user_edit(self):
        art = service.make("doc", "Notes", "original", origin={"surface": "sdk"}, store=self.store)
        path = Path(art["file"])
        update = self.store.update

        def user_saves_during_update(*args, **kwargs):
            changed = update(*args, **kwargs)
            path.write_text("user typed this while DGC was working")
            return changed

        with patch.object(self.store, "update", side_effect=user_saves_during_update):
            with self.assertRaises(service.ArtifactUseError):
                service.edit(art["id"], content="proposed change", store=self.store)
        self.assertEqual(path.read_text(), "user typed this while DGC was working")
        self.assertEqual(self.store.source(art["id"]), "proposed change")

    def test_document_keeps_an_empty_user_version_before_editing(self):
        art = service.make("doc", "Notes", "original", origin={"surface": "sdk"}, store=self.store)
        Path(art["file"]).write_text("")
        changed = service.edit(art["id"], content="new content", store=self.store)
        self.assertEqual(changed["version"], 3)
        self.assertEqual(self.store.source(art["id"], 2), "")
        self.assertEqual(self.store.version(art["id"], 2).author, "you")
        self.assertEqual(Path(art["file"]).read_text(), "new content")


if __name__ == "__main__":
    unittest.main()
