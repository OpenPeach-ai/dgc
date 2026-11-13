"""Archive for Work sessions (his call, 13 Nov), in Codex's shape: archiving moves the session out of the way and Restore
brings it back as it was.

Codex moves an archived thread's file into an archived folder and back (codex-rs thread-store archive_thread.rs,
unarchive_thread.rs). DGC moves the session's file and every file beside it that belongs to it (its plan, its counters,
its worktree note, its recall, its monitors, its images, its helpers' memory) into the project's `archived/` folder.
There nothing can resume, wake or run it; the list leaves it out; the archived list (its own index, searched the same
way) shows it; Restore moves it all back. Archiving is refused while a turn runs or while anything has it open.
`create_session` makes a named, empty session in this project: a new owner for the Project Pips of a session being
archived or deleted ("or give those pips a new session"). Behind ready.capabilities.session_archive.
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import editor_protocol, sessions


def write(project: Path, name: str, said: str, updated: float, title: str = "") -> Path:
    path = sessions.project_dir(project) / f"{name}.json"
    path.write_text(json.dumps({"schema_version": 3, "id": name, "project": str(project.resolve()), "updated": updated,
                                "messages": [{"role": "user", "content": said}, {"role": "assistant", "content": "Done."}],
                                **({"name": title} if title else {})}))
    return path


class Base(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="dgc-archive-"))
        self.addCleanup(shutil.rmtree, self.base, True)
        self.home = self.base / "home" / ".dgc"
        for p in (patch.object(sessions, "SESSIONS_DIR", self.home / "sessions"), patch("dgc.config.dgc_home", lambda: self.home)):
            p.start()
            self.addCleanup(p.stop)
        self.shop = self.base / "code" / "shop"
        self.shop.mkdir(parents=True)
        self.bucket = sessions.project_dir(self.shop)
        self.fix = write(self.shop, "20261113-090000-aaaa1111", "Fix the checkout total", 30, "Checkout")
        self.docs = write(self.shop, "20261113-080000-bbbb2222", "Write the release notes", 20)
        # Everything beside it that is the session's own.
        stem = self.fix.stem
        self.sidecars = [self.bucket / f"{stem}{suffix}" for suffix in (".metrics", ".plan.md", ".workspace", ".monitors")]
        self.sidecars.append(sessions.recall_path(self.fix, self.shop))
        for path in self.sidecars:
            path.write_text("kept")
        for store in (".images", ".helpers"):
            (self.bucket / f"{stem}{store}").mkdir()
            (self.bucket / f"{stem}{store}" / "one").write_text("kept")

    def listed(self):
        return [row[0].stem for row in sessions.listing(self.shop)]

    def archived(self, **kw):
        return [row[0].stem for row in sessions.listing_archived(self.shop, **kw)]


class ArchiveAndRestore(Base):
    def test_archive_moves_it_and_everything_that_is_its_own(self):
        self.assertEqual(sessions.archive(self.fix.name, self.shop), (True, ""))
        self.assertEqual(self.listed(), [self.docs.stem], "the list leaves it out")
        self.assertEqual(self.archived(), [self.fix.stem])
        away = self.bucket / sessions.ARCHIVED_DIR
        self.assertTrue((away / self.fix.name).is_file())
        for path in self.sidecars:
            self.assertFalse(path.exists(), path.name)
            self.assertEqual((away / path.name).read_text(), "kept", path.name)
        for store in (".images", ".helpers"):
            self.assertEqual((away / f"{self.fix.stem}{store}" / "one").read_text(), "kept")
        self.assertTrue(self.docs.is_file(), "another session is untouched")

    def test_restore_brings_it_all_back_as_it_was(self):
        before = self.fix.read_bytes()
        self.assertEqual(sessions.archive(self.fix.name, self.shop), (True, ""))
        self.assertEqual(sessions.restore(self.fix.name, self.shop), (True, ""))
        self.assertEqual(self.listed(), [self.fix.stem, self.docs.stem])
        self.assertEqual(self.archived(), [])
        self.assertEqual(self.fix.read_bytes(), before, "its record is unchanged")
        for path in self.sidecars:
            self.assertEqual(path.read_text(), "kept", path.name)
        self.assertEqual((self.bucket / f"{self.fix.stem}.images" / "one").read_text(), "kept")
        self.assertEqual(sessions.load_record(self.fix, self.shop)["name"], "Checkout")

    def test_every_file_that_is_its_own_is_known(self):
        # Each place DGC keeps something beside a session names it by its own constant or function: all are moved.
        from dgc import helper_memory, image_views, monitor_restart, serve_detach, stopped_work, wakeups
        own = {self.fix.stem + suffix for suffix in sessions.own_suffixes()}
        for path in (sessions.plan_path(self.fix, self.shop), sessions.metrics_path(self.fix, self.shop),
                     sessions.workspace_path(self.fix, self.shop), sessions.recall_path(self.fix, self.shop),
                     monitor_restart.journal_path(self.fix, self.shop), image_views.store_dir(self.fix),
                     helper_memory.store_dir(self.fix), self.fix.with_suffix(wakeups.SUFFIX),
                     self.fix.with_suffix(stopped_work.SUFFIX), Path(serve_detach._interrupted_path(self.fix))):
            self.assertIn(Path(path).name, own)

    def test_nothing_resumes_an_archived_session(self):
        sessions.archive(self.fix.name, self.shop)
        with self.assertRaises(ValueError):
            sessions.resolve_path(self.shop, f"{sessions.ARCHIVED_DIR}/{self.fix.name}")
        with self.assertRaises(FileNotFoundError):
            sessions.resolve_path(self.shop, self.fix.name, must_exist=True)
        self.assertIsNone(sessions.by_id(self.shop, self.fix.stem))
        self.assertFalse(sessions.save(self.bucket / sessions.ARCHIVED_DIR / self.fix.name, [], self.shop),
                         "nothing writes into the archived folder through a session save")

    def test_the_archived_list_is_searched_and_paged(self):
        sessions.archive(self.fix.name, self.shop)
        sessions.archive(self.docs.name, self.shop)
        self.assertEqual(self.archived(), [self.fix.stem, self.docs.stem], "newest first")
        self.assertEqual(self.archived(query="release"), [self.docs.stem])
        self.assertEqual(self.archived(limit=1, offset=1), [self.docs.stem])
        [row] = sessions.listing_archived(self.shop, query="Checkout")
        self.assertEqual((row[3], row[4]), (2, "Checkout"), "its count and name, as the list shows them")

    def test_every_project_archived_list(self):
        garden = self.base / "code" / "garden"
        garden.mkdir()
        tomatoes = write(garden, "20261113-070000-cccc3333", "Water the tomatoes", 10)
        sessions.archive(tomatoes.name, garden)
        sessions.archive(self.docs.name, self.shop)
        rows = sessions.listing_everywhere(self.shop, archived=True)
        self.assertEqual([(r["path"].stem, r["here"]) for r in rows], [(self.docs.stem, True), (tomatoes.stem, False)])
        self.assertEqual([r["path"].stem for r in sessions.listing_everywhere(self.shop, archived=True, folder=str(garden))],
                         [tomatoes.stem])
        self.assertEqual([r["path"].stem for r in sessions.listing_everywhere(self.shop)], [self.fix.stem],
                         "every project's list leaves archived ones out")

    def test_delete_an_archived_session(self):
        sessions.archive(self.fix.name, self.shop)
        self.assertTrue(sessions.delete_archived(self.fix.name, self.shop))
        away = self.bucket / sessions.ARCHIVED_DIR
        self.assertEqual(sorted(p.name for p in away.iterdir() if not p.name.startswith(".")), [])
        self.assertFalse(sessions.delete_archived(self.fix.name, self.shop), "nothing left to delete")
        self.assertFalse(sessions.delete_archived("../" + self.docs.name, self.shop))
        self.assertTrue(self.docs.is_file())


class ArchivedWithIt(Base):
    PIPS = ["pip_" + "a" * 32, "pip_" + "b" * 32]

    def test_the_pips_archived_with_it_are_kept_until_it_is_restored(self):
        self.assertEqual(sessions.archive(self.fix.name, self.shop, pips=self.PIPS + self.PIPS[:1]), (True, ""))
        self.assertEqual(sessions.archived_with(self.fix.name, self.shop), self.PIPS)
        self.assertEqual(sessions.archived_with(self.docs.name, self.shop), [], "another session has none")
        self.assertEqual(sessions.restore(self.fix.name, self.shop), (True, ""))
        self.assertEqual(sessions.archived_with(self.fix.name, self.shop), [])
        self.assertFalse(any(p.name.endswith(".pips") for p in self.bucket.rglob("*")), "nothing of it is left behind")
        self.assertEqual(sessions.archive(self.fix.name, self.shop), (True, ""))
        self.assertEqual(sessions.archived_with(self.fix.name, self.shop), [], "a later archive without Pips has none")

    def test_only_pip_ids(self):
        for bad in (["scout"], ["pip_" + "a" * 31], "pip_" + "a" * 32, ["pip_" + "a" * 32] * 0 + [3]):
            self.assertFalse(sessions.archive(self.fix.name, self.shop, pips=bad)[0], bad)
        self.assertTrue(self.fix.is_file())

    def test_deleting_it_deletes_the_note(self):
        sessions.archive(self.fix.name, self.shop, pips=self.PIPS)
        self.assertTrue(sessions.delete_archived(self.fix.name, self.shop))
        self.assertFalse(any(p.name.endswith(".pips") for p in self.bucket.rglob("*")))


class Refused(Base):
    def test_while_a_turn_runs(self):
        lease = sessions.session_turn_lock(self.fix, self.shop)
        self.assertTrue(lease.acquire(blocking=False))
        try:
            ok, why = sessions.archive(self.fix.name, self.shop)
        finally:
            lease.release()
        self.assertFalse(ok)
        self.assertIn("running", why)
        self.assertTrue(self.fix.is_file())
        self.assertTrue(all(p.exists() for p in self.sidecars))

    def test_while_anything_has_it_open(self):
        holder = sessions.session_owner_lock(self.fix, self.shop)
        self.assertTrue(holder.acquire(blocking=False))
        try:
            ok, why = sessions.archive(self.fix.name, self.shop)
        finally:
            holder.release()
        self.assertFalse(ok)
        self.assertIn("open", why)
        self.assertTrue(self.fix.is_file())

    def test_a_session_that_is_not_here(self):
        ok, why = sessions.archive("20990101-000000-ffffffff.json", self.shop)
        self.assertFalse(ok)
        self.assertTrue(why)
        self.assertEqual(sessions.archive("../elsewhere.json", self.shop)[0], False)
        self.assertEqual(sessions.restore(self.fix.name, self.shop)[0], False, "not archived")

    def test_restore_never_overwrites_a_session_of_the_same_id(self):
        sessions.archive(self.fix.name, self.shop)
        write(self.shop, self.fix.stem, "A new one with the same id", 40)
        ok, why = sessions.restore(self.fix.name, self.shop)
        self.assertFalse(ok)
        self.assertTrue(why)
        self.assertEqual(self.archived(), [self.fix.stem], "the archived one stays archived")
        self.assertIn("A new one", self.fix.read_text())


class NewSession(Base):
    def test_a_named_empty_session_in_this_project(self):
        path = sessions.create(self.shop, "Pips from Checkout")
        self.assertEqual(path.parent, self.bucket)
        record = sessions.load_record(path, self.shop)
        self.assertEqual((record["name"], record["messages"], record["project"]), ("Pips from Checkout", [], str(self.shop.resolve())))
        [row] = [r for r in sessions.listing(self.shop) if r[0] == path]
        self.assertEqual((row[3], row[4]), (0, "Pips from Checkout"))


def backend_for(root: Path, pips: bool = False):
    from dgc import headless
    backend = object.__new__(headless.Backend)
    backend.config = SimpleNamespace(project_root=root, get=lambda key, default=None: pips if key == "pips_enabled" else default)
    backend.events = []
    backend.em = SimpleNamespace(emit=lambda kind, **payload: backend.events.append({"type": kind, **payload}))
    return backend


class TheCommands(Base):
    def last(self, backend, **want):
        event = backend.events[-1]
        self.assertIsNone(editor_protocol.event_error({"seq": 1, **event}), event)
        for key, value in want.items():
            self.assertEqual(event.get(key), value, event)
        return event

    def test_archive_list_restore_and_delete_through_the_backend(self):
        backend = backend_for(self.shop)
        backend._dispatch({"type": "archive_session", "path": self.fix.name, "archived": True, "request_id": "r1"})
        self.last(backend, type="session_archived", path=self.fix.name, archived=True, request_id="r1")
        backend._dispatch({"type": "list_sessions", "request_id": "r2"})
        self.assertEqual([Path(i["path"]).stem for i in self.last(backend, type="sessions")["items"]], [self.docs.stem])
        backend._dispatch({"type": "list_sessions", "archived": True, "request_id": "r3"})
        [item] = self.last(backend, type="sessions", request_id="r3")["items"]
        self.assertEqual((Path(item["path"]).stem, item["name"], item["archived"]), (self.fix.stem, "Checkout", True))
        backend._dispatch({"type": "list_sessions", "archived": True, "scope": "all", "request_id": "r3b"})
        [item] = self.last(backend, type="sessions", request_id="r3b")["items"]
        self.assertEqual((item["here"], item["archived"]), (True, True))
        backend._dispatch({"type": "archive_session", "path": self.fix.name, "archived": False, "request_id": "r4"})
        self.last(backend, type="session_archived", archived=False, request_id="r4")
        self.assertEqual(self.listed(), [self.fix.stem, self.docs.stem])
        backend._dispatch({"type": "archive_session", "path": self.docs.name, "request_id": "r5"})
        self.last(backend, type="session_archived", archived=True)
        backend._dispatch({"type": "delete_session", "path": self.docs.name, "archived": True, "request_id": "r6"})
        event = self.last(backend, type="sessions", deleted=True, request_id="r6")
        self.assertEqual([Path(i["path"]).stem for i in event["items"]], [self.fix.stem], "the answer is this project's list, as always")
        self.assertEqual(self.archived(), [])

    def test_restoring_answers_with_the_pips_archived_with_it(self):
        backend = backend_for(self.shop)
        pips = ["pip_" + "c" * 32]
        backend._dispatch({"type": "archive_session", "path": self.fix.name, "pips": pips, "request_id": "r1"})
        event = self.last(backend, type="session_archived", archived=True)
        self.assertNotIn("pips", event)
        backend._dispatch({"type": "archive_session", "path": self.fix.name, "archived": False, "request_id": "r2"})
        self.last(backend, type="session_archived", archived=False, pips=pips)
        backend._dispatch({"type": "archive_session", "path": self.fix.name, "archived": False, "pips": pips, "request_id": "r3"})
        self.last(backend, type="command_rejected", command="archive_session", reason="invalid_request")

    def test_a_refusal_says_why(self):
        backend = backend_for(self.shop)
        lease = sessions.session_turn_lock(self.fix, self.shop)
        self.assertTrue(lease.acquire(blocking=False))
        try:
            backend._dispatch({"type": "archive_session", "path": self.fix.name, "request_id": "r1"})
        finally:
            lease.release()
        event = self.last(backend, type="command_rejected", command="archive_session", reason="session_archive_failed")
        self.assertIn("running", event["message"])
        backend._dispatch({"type": "archive_session", "path": 3, "request_id": "r2"})
        self.last(backend, type="command_rejected", command="archive_session")

    def test_create_session(self):
        backend = backend_for(self.shop)
        backend._dispatch({"type": "create_session", "name": "  Pips   from Checkout ", "request_id": "r1"})
        event = self.last(backend, type="session_created", name="Pips from Checkout", request_id="r1")
        path = self.bucket / event["path"]
        self.assertEqual(sessions.load_record(path, self.shop)["name"], "Pips from Checkout")
        for bad in ("", "   ", "x" * 201, 5):
            backend._dispatch({"type": "create_session", "name": bad, "request_id": "r2"})
            self.last(backend, type="command_rejected", command="create_session")

    def test_create_session_joins_the_projects_workspace_when_pips_are_on(self):
        backend = backend_for(self.shop, pips=True)
        with patch("dgc.workspace_sessions.associate_current_session", return_value={}) as associate:
            backend._dispatch({"type": "create_session", "name": "Pips from Checkout", "request_id": "r1"})
        self.last(backend, type="session_created")
        self.assertEqual(associate.call_count, 1, "a Project Pip can then be given it as its owner")

    def test_protocol_and_capability(self):
        from dgc import headless
        for command, fields in (("archive_session", {"path", "archived"}), ("create_session", {"name"}),
                                ("list_sessions", {"archived"}), ("delete_session", {"archived"})):
            self.assertTrue(fields <= set(editor_protocol.COMMAND_FIELDS[command]), command)
        self.assertIsNone(editor_protocol.event_error({"type": "session_archived", "seq": 1, "path": "a.json", "archived": True}))
        self.assertIsNone(editor_protocol.event_error({"type": "session_created", "seq": 1, "path": "a.json", "name": "A"}))
        self.assertIn('"session_archive": True', Path(headless.__file__).read_text())
        self.assertIn("archive_session", headless._BUSY_MUTATIONS)
        self.assertTrue({"archive_session", "create_session"} <= headless._OPTIONALLY_CORRELATED_COMMANDS)


if __name__ == "__main__":
    unittest.main()
