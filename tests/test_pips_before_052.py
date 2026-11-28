"""The way back from 0.52 (pips-flow-design §3.4 step 2 and §3.7).

A 0.51 can't open a Pips database 0.52 has upgraded ("This Pips database needs a compatible DGC version", already
shipped and can't be changed from here), so 0.52 makes the way back itself: before it upgrades a 0.51 database it
copies it aside (SQLite's own backup, kept 30 days), and `dgc pips restore-before-0.52` puts that copy back after
copying the 0.52 database aside too, so neither direction loses anything. It says plainly what is lost.

Real registries on disk; the CLI's own parser and command.
"""
from __future__ import annotations

import io
import os
import sqlite3
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from dgc import pip_cli, workspace_registry as reg
from dgc.workspace_registry import RegistryError, WorkspaceRegistry


def version(path: Path) -> int:
    db = sqlite3.connect(path)
    try:
        return db.execute("PRAGMA user_version").fetchone()[0]
    finally:
        db.close()


class Registry051(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-before-052-")
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name) / "pips"
        with WorkspaceRegistry(self.directory) as registry:
            registry.db.execute("INSERT INTO metadata VALUES('marker','from 0.51')")
        self.path = self.directory / "registry.sqlite3"

    def as_051(self):
        db = sqlite3.connect(self.path)
        db.execute("PRAGMA user_version=51")
        db.commit()
        db.close()

    def backups(self):
        folder = self.directory / "backups" / "before-0.52"
        return sorted(folder.glob("*.sqlite3")) if folder.exists() else []


class BeforeTheUpgrade(Registry051):
    def test_a_051_database_is_copied_aside_before_052_upgrades_it(self):
        self.as_051()
        with WorkspaceRegistry(self.directory) as registry:
            self.assertEqual(registry.db.execute("PRAGMA user_version").fetchone()[0], reg.SCHEMA_VERSION)
        [copy] = self.backups()
        self.assertEqual(version(copy), 51, "the copy is the database as 0.51 left it")
        db = sqlite3.connect(copy)
        self.assertEqual(db.execute("SELECT value FROM metadata WHERE key='marker'").fetchone()[0], "from 0.51")
        db.close()
        if os.name == "posix":
            self.assertEqual(copy.stat().st_mode & 0o777, 0o600)

    def test_an_up_to_date_or_new_database_is_not_copied(self):
        with WorkspaceRegistry(self.directory):
            pass
        self.assertEqual(self.backups(), [])

    def test_a_copy_older_than_thirty_days_is_removed_when_a_new_one_is_made(self):
        folder = self.directory / "backups" / "before-0.52"
        folder.mkdir(parents=True)
        old = folder / "registry-v50-20260101T000000Z.sqlite3"
        old.write_bytes(b"")
        stale = time.time() - 31 * 86400
        os.utime(old, (stale, stale))
        self.as_051()
        WorkspaceRegistry(self.directory).close()
        self.assertFalse(old.exists())
        self.assertEqual(len(self.backups()), 1)


class RestoreBefore052(Registry051):
    def restore(self, *args, runner_online=False):
        parsed = pip_cli.parser().parse_args(["restore-before-0.52", *args])
        out = io.StringIO()
        status = {"online": runner_online, "status": "running" if runner_online else "stopped"}
        with patch.object(reg, "state_directory", return_value=self.directory), \
                patch("dgc.pip_daemon.runner_status", return_value=status), redirect_stdout(out):
            code = pip_cli.restore_before_052(parsed)
        return code, out.getvalue()

    def test_it_puts_the_051_copy_back_and_keeps_the_052_database_too(self):
        self.as_051()
        WorkspaceRegistry(self.directory).close()
        with WorkspaceRegistry(self.directory) as registry:
            registry.db.execute("INSERT INTO metadata VALUES('since','made by 0.52')")
        code, said = self.restore("--yes")
        self.assertEqual(code, 0)
        self.assertEqual(version(self.path), 51, "0.51 can open it again")
        db = sqlite3.connect(self.path)
        self.assertIsNone(db.execute("SELECT 1 FROM metadata WHERE key='since'").fetchone())
        db.close()
        [kept] = sorted((self.directory / "backups" / "from-0.52").glob("*.sqlite3"))
        self.assertEqual(version(kept), reg.SCHEMA_VERSION, "what 0.52 had is kept")
        self.assertIn("Pips go back to how they were on", said)
        self.assertIn(str(kept.parent), said)

    def test_it_asks_for_yes_and_refuses_while_pips_are_running(self):
        self.as_051()
        WorkspaceRegistry(self.directory).close()
        with patch("sys.stdin.isatty", return_value=False), self.assertRaises(RegistryError) as asked:
            self.restore()
        self.assertEqual(asked.exception.code, "confirmation_required")
        with self.assertRaises(RegistryError) as running:
            self.restore("--yes", runner_online=True)
        self.assertEqual(running.exception.code, "runner_running")
        self.assertEqual(version(self.path), reg.SCHEMA_VERSION, "nothing was changed")

    def test_with_no_copy_it_says_there_is_nothing_to_go_back_to(self):
        with self.assertRaises(RegistryError) as none:
            self.restore("--yes")
        self.assertEqual(none.exception.code, "not_found")

    def test_it_is_never_run_from_a_dgc_chats_own_shell(self):
        parsed = pip_cli.parser().parse_args(["restore-before-0.52", "--yes"])
        self.assertFalse(pip_cli.agent_shell_allows(parsed))


if __name__ == "__main__":
    unittest.main()


class TheWelcome(unittest.TestCase):
    """get_pips_welcome (Pips API 96): the Pips tab's one-time pop-up names what moved, only for someone who had Pips."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-welcome-052-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.directory = self.base / "pips"
        env = patch.dict(os.environ, {"DGC_HOME": str(self.base / "home")})
        env.start()
        self.addCleanup(env.stop)

    def made_in_051(self, make):
        from dgc import pips
        with WorkspaceRegistry(self.directory) as registry:
            store = pips.PipStore(registry)
            made = make(registry, store)
        db = sqlite3.connect(self.directory / "registry.sqlite3")
        db.execute("PRAGMA user_version=51")
        db.commit()
        db.close()
        return made

    def welcome(self):
        from dgc.pip_welcome import welcome
        with WorkspaceRegistry(self.directory) as registry:
            return welcome(registry)

    def test_it_names_what_moved_by_folder_the_personal_ones_and_those_on_do_it_all(self):
        from dgc import pip_levels
        shop = self.base / "lime_tiles"
        shop.mkdir()

        def make(registry, store):
            folder = registry.resolve(shop)
            gst = store.create(folder["id"], "GST watchdog", "Check GST.", "editor-user", pip_type="rook")
            erp = store.create(folder["id"], "ERP daily audit", "Check ERP.", "editor-user", pip_type="scout")
            home = registry.personal()["id"]
            core = store.create(home, "Core", None, "editor-user", pip_type="core")
            mornings = store.create(home, "Mornings", None, "editor-user", pip_type="quill")
            garden = store.create(home, "Garden notes", None, "editor-user", pip_type="lens")
            with registry.transaction():
                pip_levels.start(registry, mornings["id"])
            pip_levels.set_level(registry, mornings["id"], pip_levels.FULL, "editor-user")
            return gst, erp, core, mornings, garden
        gst, erp, core, mornings, garden = self.made_in_051(make)
        said = self.welcome()
        self.assertTrue(said["had_pips"])
        [folder] = said["folders"]
        self.assertEqual((folder["folder"], [p["name"] for p in folder["pips"]]), ("lime_tiles", ["GST watchdog", "ERP daily audit"]))
        self.assertEqual([p["name"] for p in said["personal"]], ["Mornings", "Garden notes"], "Core is not news")
        self.assertEqual([p["name"] for p in said["do_it_all"]], ["Mornings"])

    def test_pips_made_in_the_same_instant_are_named_in_the_order_they_were_made(self):
        # A fast machine makes two Pips within one stamp: the list was then ordered by their random ids (GitHub's runner
        # said "Garden notes, Mornings" on 27 Nov). It is the order they were made in.
        def make(registry, store):
            home = registry.personal()["id"]
            return [store.create(home, name, None, "editor-user", pip_type="quill")
                    for name in ("Mornings", "Garden notes", "Allotment", "Bills")]
        self.made_in_051(make)
        db = sqlite3.connect(self.directory / "registry.sqlite3")
        db.execute("UPDATE pips SET created_at=(SELECT MIN(created_at) FROM pips)")
        db.commit()
        db.close()
        self.assertEqual([p["name"] for p in self.welcome()["personal"]], ["Mornings", "Garden notes", "Allotment", "Bills"])

    def test_a_new_user_and_core_alone_are_not_welcomed(self):
        self.assertFalse(self.welcome()["had_pips"], "a new database: nothing moved")
        self.made_in_051(lambda registry, store: store.create(registry.personal()["id"], "Core", None, "editor-user",
                                                              pip_type="core"))
        self.assertFalse(self.welcome()["had_pips"], "Core alone")

    def test_a_pip_made_after_the_update_is_not_named(self):
        self.made_in_051(lambda registry, store: store.create(registry.personal()["id"], "Mornings", None, "editor-user",
                                                              pip_type="quill"))
        from dgc import pips
        with WorkspaceRegistry(self.directory) as registry:
            registry.clock = lambda: "2999-01-01T00:00:00.000Z"
            pips.PipStore(registry).create(registry.personal()["id"], "Later", None, "editor-user", pip_type="lens")
        self.assertEqual([p["name"] for p in self.welcome()["personal"]], ["Mornings"])

    def test_it_is_a_pips_control_read(self):
        from dgc import pips
        self.assertIn("get_pips_welcome", pips.CONTROL_COMMANDS)
