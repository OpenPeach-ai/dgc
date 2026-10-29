"""Saved versions compare by type, without writes or executing page content."""
import json
import tempfile
import unittest
from pathlib import Path

from dgc import artifact_service as service
from dgc.artifact_store import Store


class CompareTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="dgc-compare-")
        self.addCleanup(folder.cleanup)
        self.store = Store(Path(folder.name) / "artifacts")

    def pair(self, kind, old, new):
        art = self.store.create(kind, "Example", old, origin={"surface": "sdk"})
        self.store.update(art.id, new)
        return art.id

    def compare(self, aid):
        before = self.store.get(aid).to_json()
        result = service.compare(aid, 1, 2, store=self.store)
        self.assertEqual(self.store.get(aid).to_json(), before)
        return result

    def test_document_diff_and_identical_versions(self):
        aid = self.pair("doc", "# Plan\nShip Friday.\n", "# Plan\nShip Monday.\n")
        result = self.compare(aid)
        self.assertIn("-Ship Friday.", result["diff"])
        self.assertIn("+Ship Monday.", result["diff"])
        self.assertFalse(result["truncated"])
        self.assertEqual(service.compare(aid, 2, store=self.store)["total"], 0)

    def test_slides_by_position_and_deck_settings(self):
        aid = self.pair("slides", {"theme": "paper", "slides": [{"title": "Old"}]},
                        {"theme": "night", "slides": [{"title": "New"}, {"title": "Next"}]})
        result = self.compare(aid)
        self.assertEqual([r["label"] for r in result["changes"]], ["Slide 1", "Slide 2", "Deck settings"])
        self.assertEqual(result["changes"][1]["kind"], "added")

    def test_sheet_addresses_include_header_row_and_do_not_conflate_boolean_with_number(self):
        def book(rows):
            return {"sheets": [{"name": "Budget", "columns": [{"name": "Item"}, {"name": "Cost"}], "rows": rows}]}
        aid = self.pair("sheet", book([["Rent", 1], ["Food", 20]]), book([["Rent", True], ["Food", 25]]))
        result = self.compare(aid)
        self.assertEqual([r["label"] for r in result["changes"]], ["Budget!B2", "Budget!B3"])
        self.assertEqual(result["changes"][0]["after"], "true")

    def test_pages_compare_file_identity_even_when_sizes_match(self):
        aid = self.pair("page", {"index.html": b"<b>old</b>", "old.js": b"bad()"},
                        {"index.html": b"<b>new</b>", "new.js": b"bad()"})
        result = self.compare(aid)
        self.assertEqual([(r["label"], r["kind"]) for r in result["changes"]],
                         [("index.html", "changed"), ("new.js", "added"), ("old.js", "removed")])

    def test_large_comparison_says_it_is_partial_and_stays_bounded(self):
        aid = self.pair("doc", "old\n" * 100_000, "new\n" * 100_000)
        result = self.compare(aid)
        self.assertTrue(result["truncated"])
        self.assertLess(len(json.dumps(result)), 100_000)
        def book(n):
            return {"sheets": [{"name": "S", "columns": [{"name": "N"}], "rows": [[n]] * 300}]}
        aid = self.pair("sheet", book(1), book(2))
        result = self.compare(aid)
        self.assertEqual((result["total"], len(result["changes"]), result["truncated"]), (300, 200, True))

    def test_missing_and_invalid_versions_are_refused(self):
        aid = self.pair("doc", "a", "b")
        for n in (0, -1, True, "1", 999):
            with self.subTest(version=n), self.assertRaises(service.ArtifactUseError):
                service.compare(aid, n, store=self.store)


if __name__ == "__main__":
    unittest.main()
