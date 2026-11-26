"""DGC Browser was "Your Browser" until 26 Nov (decided 26 Nov: one name a person and every model can say, "use the DGC
browser", in the API and the SDK too). A test build's registry kept its sites under the old names: the sites the person
signed in to, which Pips may use each, and a few metadata keys (the sign-outs still to clear, when the Sites panel was
last opened). The registry's upgrade to schema 56 moves them to the new names once, every row kept; the profile folder
keeps its old name (the person's sign-ins live in it)."""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from dgc import dgc_browser, workspace_registry
from dgc.workspace_registry import WorkspaceRegistry


def _old_registry(directory: Path) -> None:
    """A schema-55 registry as a test build left it: two sites, one chosen for a Pip, and the old metadata keys."""
    registry = WorkspaceRegistry(directory)
    try:
        assert dgc_browser.notice_site(registry, "tiles-shop.com") is not None
        assert dgc_browser.notice_site(registry, "bank-of-tiles.com", card_fields=True) is not None
        with registry.transaction():
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", ("dgc_browser_sites_seen", "2026-11-25T10:00:00Z"))
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", ("dgc_browser_sign_outs", '[{"site": "old.example.com"}]'))
    finally:
        registry.close()
    db = sqlite3.connect(directory / "registry.sqlite3")      # (a raw connection: no foreign keys, so "pip_old" needn't exist)
    try:
        db.execute("INSERT INTO dgc_browser_site_pips VALUES(?,?)", ("bank-of-tiles.com", "pip_old"))
        db.execute("ALTER TABLE dgc_browser_sites RENAME TO your_browser_sites")
        db.execute("ALTER TABLE dgc_browser_site_pips RENAME TO your_browser_site_pips")
        db.execute("UPDATE metadata SET key=replace(key, 'dgc_browser_', 'your_browser_') WHERE key LIKE 'dgc_browser_%'")
        db.execute("PRAGMA user_version=55")
        db.commit()
    finally:
        db.close()


class DgcBrowserNames(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def tables(self, registry) -> set[str]:
        return {row[0] for row in registry.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    def test_a_test_builds_sites_and_keys_move_to_dgc_browser_once_every_row_kept(self):
        _old_registry(self.dir)
        registry = WorkspaceRegistry(self.dir)
        try:
            self.assertEqual(registry.db.execute("PRAGMA user_version").fetchone()[0], workspace_registry.SCHEMA_VERSION)
            tables = self.tables(registry)
            self.assertTrue({"dgc_browser_sites", "dgc_browser_site_pips"} <= tables, tables)
            self.assertFalse({"your_browser_sites", "your_browser_site_pips"} & tables, "the old tables are gone")
            self.assertEqual(sorted(s["site"] for s in dgc_browser.sites(registry)), ["bank-of-tiles.com", "tiles-shop.com"])
            self.assertEqual(registry.db.execute("SELECT pip_id FROM dgc_browser_site_pips WHERE site=?", ("bank-of-tiles.com",)).fetchone()[0],
                             "pip_old", "a site chosen for a Pip keeps that Pip")
            # The Pips chosen for a site still point at the sites table under its new name.
            sql = registry.db.execute("SELECT sql FROM sqlite_master WHERE name='dgc_browser_site_pips'").fetchone()[0]
            self.assertRegex(sql, r'REFERENCES "?dgc_browser_sites"?\(site\)', sql)
            keys = dict(registry.db.execute("SELECT key, value FROM metadata WHERE key LIKE '%browser%'").fetchall())
            self.assertEqual(keys, {"dgc_browser_sites_seen": "2026-11-25T10:00:00Z", "dgc_browser_sign_outs": '[{"site": "old.example.com"}]'})
        finally:
            registry.close()
        # Opened again, nothing more happens (and nothing is lost).
        again = WorkspaceRegistry(self.dir)
        try:
            self.assertEqual(len(dgc_browser.sites(again)), 2)
        finally:
            again.close()

    def test_an_old_key_beside_a_new_one_leaves_the_new_one(self):
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.executemany("INSERT INTO metadata VALUES(?,?)", [("dgc_browser_state", "new"), ("your_browser_state", "old"), ("your_browser_view", "v")])
        dgc_browser.moved_names(db)
        self.assertEqual(dict(db.execute("SELECT key, value FROM metadata").fetchall()), {"dgc_browser_state": "new", "dgc_browser_view": "v"})

    def test_the_profile_keeps_its_folder(self):
        self.assertEqual(dgc_browser.FOLDER, "your-browser", "the person's sign-ins live in this profile: it isn't moved")
        self.assertEqual(dgc_browser.folder(self.dir), self.dir / "your-browser")


if __name__ == "__main__":
    unittest.main()
