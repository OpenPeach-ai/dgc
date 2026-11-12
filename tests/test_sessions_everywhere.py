"""Work sessions from every project (his call, 12 Nov, after Codex): the Sessions list opens on this project's sessions, as
before, and list_sessions {scope: "all"} gives every project's, each with its folder, so the editor can show where a
session belongs and open it here, running in its own folder. DGC's own folders (a helper's worktree, a fix's copy)
are never a project of the user's. Behind ready.capabilities.session_scopes.
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import sessions


def write(project: Path, name: str, said: str, updated: float, title: str = "") -> Path:
    path = sessions.project_dir(project) / f"{name}.json"
    path.write_text(json.dumps({"schema_version": 3, "id": name, "project": str(project.resolve()), "updated": updated,
                                "messages": [{"role": "user", "content": said}, {"role": "assistant", "content": "Done."}],
                                **({"name": title} if title else {})}))
    return path


class Everywhere(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="dgc-everywhere-"))
        self.addCleanup(shutil.rmtree, self.base, True)
        self.home = self.base / "home" / ".dgc"
        patches = [patch.object(sessions, "SESSIONS_DIR", self.home / "sessions"),
                   patch("dgc.config.dgc_home", lambda: self.home)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.shop, self.garden, self.notes = (self.base / "code" / n for n in ("shop", "garden", "notes"))
        for folder in (self.shop, self.garden, self.notes):
            folder.mkdir(parents=True)
        write(self.shop, "s1", "Fix the checkout total", 10, "Checkout")
        write(self.garden, "g1", "Water the tomatoes on Fridays", 30)
        write(self.garden, "g2", "Plan the herb bed", 20)
        write(self.notes, "n1", "Tidy the reading list", 5)
        # A helper's worktree and a fix's copy live in DGC's own folder: never a project of the user's.
        worktree = self.home / "worktrees" / "garden-task-run-ls"
        worktree.mkdir(parents=True)
        write(worktree, "w1", "Run ls", 40)

    def rows(self, **kw):
        return sessions.listing_everywhere(self.shop, **kw)

    def test_every_project_newest_first_with_its_folder(self):
        rows = self.rows()
        self.assertEqual([r["path"].stem for r in rows], ["g1", "g2", "s1", "n1"], "DGC's own worktree is left out")
        first = rows[0]
        self.assertEqual((first["project"], first["project_name"], first["here"], first["folder_exists"]),
                         (str(self.garden.resolve()), "garden", False, True))
        here = next(r for r in rows if r["path"].stem == "s1")
        self.assertEqual((here["here"], here["name"], here["preview"]), (True, "Checkout", "Fix the checkout total"))

    def test_pages_and_search_reach_every_project(self):
        self.assertEqual([r["path"].stem for r in self.rows(limit=2, offset=1)], ["g2", "s1"])
        [found] = self.rows(query="tomatoes")
        self.assertEqual(found["path"].stem, "g1")
        self.assertIn("tomatoes", found["match"] or found["preview"])

    def test_a_folder_that_is_gone_is_said(self):
        shutil.rmtree(self.notes)
        gone = next(r for r in self.rows() if r["path"].stem == "n1")
        self.assertFalse(gone["folder_exists"])


class TheCommand(unittest.TestCase):
    def test_list_sessions_scope_all_through_the_backend_and_the_protocol(self):
        from types import SimpleNamespace
        from dgc import editor_protocol, headless
        base = Path(tempfile.mkdtemp(prefix="dgc-everywhere-"))
        self.addCleanup(shutil.rmtree, base, True)
        shop, garden = base / "shop", base / "garden"
        shop.mkdir()
        garden.mkdir()
        with patch.object(sessions, "SESSIONS_DIR", base / ".dgc" / "sessions"), patch("dgc.config.dgc_home", lambda: base / ".dgc"):
            write(shop, "s1", "Fix the checkout total", 10)
            write(garden, "g1", "Water the tomatoes", 30)
            backend = object.__new__(headless.Backend)
            backend.config = SimpleNamespace(project_root=shop, get=lambda key, default=None: default)
            backend.events = []
            backend.em = SimpleNamespace(emit=lambda kind, **payload: backend.events.append({"type": kind, **payload}))
            backend._dispatch({"type": "list_sessions", "request_id": "r1"})
            self.assertEqual([i["preview"] for i in backend.events[-1]["items"]], ["Fix the checkout total"], "this project, as before")
            backend._dispatch({"type": "list_sessions", "request_id": "r2", "scope": "all"})
            items = backend.events[-1]["items"]
            self.assertEqual([(i["project_name"], i["here"]) for i in items], [("garden", False), ("shop", True)])
            self.assertEqual(items[0]["project"], str(garden.resolve()))
            backend._dispatch({"type": "list_sessions", "request_id": "r3", "scope": "everything"})
            self.assertEqual(backend.events[-1]["type"], "error")
        self.assertIn("scope", editor_protocol.COMMANDS["list_sessions"] if hasattr(editor_protocol, "COMMANDS")
                      else editor_protocol.COMMAND_FIELDS["list_sessions"])
        source = Path(headless.__file__).read_text()
        self.assertIn('"session_scopes": True', source, "the editor asks for every project's only where DGC says it can")


if __name__ == "__main__":
    unittest.main()
