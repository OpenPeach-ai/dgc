"""The Project Folder dropdown (his calls, 12 Nov, for 0.52): one shared choice, "All projects" or one folder, over the
Work sessions, Home's recent sessions, the Pips view's Project tab and Needs Attention for Project Pips; New Session and
Create Project Pip pick a folder, with "Add a folder…". Pips API 93 gives the editor what it needs:

- list_project_folders: the folders that have a Work session or a Project Pip, newest first, this window's marked,
  a gone one marked; never DGC's own folders.
- list_pips {scope: "projects"}: every project's Pips (each with its workspace), paged across them.
- list_pip_attention {projects: "all" | <workspace id>}: Project Pips' cards too, for the folder chosen.
- add_project_folder {folder}: a folder the user picked becomes a project (to make a Project Pip there); it must
  exist and be a folder, and never be /, the home folder or DGC's own.
"""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dgc import pip_attention, project_folders, sessions
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


def session(project: Path, name: str, updated: float):
    path = sessions.project_dir(project) / f"{name}.json"
    path.write_text(json.dumps({"schema_version": 3, "id": name, "project": str(project.resolve()), "updated": updated,
                                "messages": [{"role": "user", "content": "Hello"}]}))
    os.utime(path, (updated, updated))
    return path


class Folders(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.home = self.base / "home"
        self.dgc = self.home / ".dgc"
        for p in (mock.patch.object(sessions, "SESSIONS_DIR", self.dgc / "sessions"),
                  mock.patch("dgc.config.dgc_home", lambda: self.dgc), mock.patch.object(project_folders, "_home", lambda: self.home)):
            p.start()
            self.addCleanup(p.stop)
        self.shop, self.garden, self.notes = (self.base / "code" / n for n in ("shop", "garden", "notes"))
        for folder in (self.shop, self.garden, self.notes):
            folder.mkdir(parents=True)
        session(self.shop, "s1", 1_800_000_100)
        session(self.garden, "g1", 1_800_000_300)
        worktree = self.dgc / "worktrees" / "task"
        worktree.mkdir(parents=True)
        session(worktree, "w1", 1_800_000_400)                  # a helper's worktree: DGC's own, never listed
        self.notes_ws = self.registry.resolve(self.notes)      # a project with a Pip and no session
        self.notes_pip = self.store.create(self.notes_ws["id"], "Notes watcher", "Watch the notes.", "local-console",
                                           pip_type="rook")
        self.repo_pip = self.store.create(self.workspace["id"], "Repo reviewer", "Review.", "local-console", pip_type="rook")

    def folders(self, here=None):
        cfg = fixtures.config(here or self.shop)
        return project_folders.listing(self.registry, cfg)["folders"]

    def test_the_folders_with_a_session_or_a_project_pip(self):
        rows = self.folders()
        by_name = {r["name"]: r for r in rows}
        self.assertEqual(set(by_name), {"shop", "garden", "notes", "repo"}, "DGC's own worktree is never one")
        self.assertEqual(rows[0]["name"], "garden", "newest first")
        self.assertTrue(by_name["shop"]["here"])
        self.assertEqual((by_name["notes"]["sessions"], by_name["notes"]["pips"]), (0, 1))
        self.assertEqual(by_name["notes"]["workspace_id"], self.notes_ws["id"])
        self.assertIsNone(by_name["garden"]["workspace_id"], "a folder with only sessions has no Pips' workspace yet")
        self.assertTrue(all(r["exists"] for r in rows))
        shutil.rmtree(self.garden)
        self.assertFalse(next(r for r in self.folders() if r["name"] == "garden")["exists"], "a gone folder is said")

    def test_every_projects_pips(self):
        page = project_folders.pips_everywhere(self.store, limit=100)
        self.assertEqual({p["name"] for p in page["pips"]}, {"Notes watcher", "Repo reviewer"})
        self.assertEqual(page["total"], 2)
        self.assertTrue(all(p["workspace_id"] for p in page["pips"]))
        self.assertNotIn("Personal", {p["name"] for p in page["pips"]})
        one = project_folders.pips_everywhere(self.store, limit=1)
        self.assertEqual((len(one["pips"]), one["next_offset"]), (1, 1))

    def test_needs_attention_takes_the_project_chosen(self):
        from dgc.pip_schedules import timestamp
        now = timestamp(self.registry.clock())
        with mock.patch.object(pip_attention, "_in_projects", lambda registry, now, personal: {"in_projects": 0, "projects": {}}):
            seen = []
            real = self.registry.db.execute

            def spy(sql, *args):
                if "FROM pips p JOIN workspaces w" in sql:
                    seen.append((sql, args))
                return real(sql, *args)
            with mock.patch.object(self.registry, "db", mock.Mock(wraps=self.registry.db, execute=spy)):
                pip_attention.collect(self.registry, now)
                pip_attention.collect(self.registry, now, projects="all")
                pip_attention.collect(self.registry, now, projects=self.notes_ws["id"])
        self.assertIn("w.kind='personal'", seen[0][0])
        self.assertIn("w.kind<>'personal'", seen[1][0], "all projects: every Project Pip too")
        self.assertIn(self.notes_ws["id"], seen[2][1][0], "one folder: that project's Pips too")
        with self.assertRaises(RegistryError):
            pip_attention.collect(self.registry, now, projects="ws_nothere")

    def test_add_a_folder(self):
        added = project_folders.add(self.registry, str(self.garden))
        self.assertEqual(added["workspace"]["id"], self.registry.lookup(self.garden)["id"])
        for bad in (str(self.base / "missing"), "/", str(self.home), str(self.dgc), str(self.dgc / "worktrees" / "task"),
                    str(self.shop / "file.txt"), "relative/path", ""):
            (self.shop / "file.txt").write_text("x")
            with self.subTest(folder=bad), self.assertRaises(RegistryError):
                project_folders.add(self.registry, bad)


class TheCommands(unittest.TestCase):
    def test_api_93(self):
        from dgc import pips
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 93)
        for name, args in (("list_project_folders", set()), ("add_project_folder", {"folder"})):
            with self.subTest(name=name):
                self.assertIn(name, pips.CONTROL_COMMANDS)
                self.assertEqual(pips._COMMAND_ARGS[name], args)
        self.assertIn("scope", pips._COMMAND_ARGS["list_pips"])
        self.assertIn("projects", pips._COMMAND_ARGS["list_pip_attention"])


if __name__ == "__main__":
    unittest.main()
