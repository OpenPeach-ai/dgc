"""Database-lock/error regressions; isolated local processes, no sleeps/network."""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from dgc import workspace_registry as registry_module
from dgc import pip_approvals
from dgc.pips import PipStore
from dgc.workspace_context import ContextStore
from dgc.workspace_registry import RegistryError, WorkspaceRegistry


class RegistryConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="registry-connection-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.registry = WorkspaceRegistry(self.directory)
        self.addCleanup(self.registry.close)

    @unittest.skipUnless(os.name == "posix", "POSIX record-lock regression")
    def test_another_connection_does_not_release_existing_sqlite_inode_locks(self):
        # SQLite's shared-byte range begins at PENDING_BYTE + 2. A different
        # process must never acquire an exclusive lock while our connection is
        # open. This catches raw open/close even if SQL still appears to work.
        script = """import errno,fcntl,os,sys
fd=os.open(sys.argv[1],os.O_RDWR)
try:
 try:
  fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB,1,1073741826)
  print('acquired')
 except OSError as exc:
  if exc.errno not in (errno.EACCES,errno.EAGAIN): raise
  print('blocked')
finally: os.close(fd)
"""
        def state():
            return subprocess.run([sys.executable, "-c", script, str(self.registry.path)],
                                  check=True, capture_output=True, text=True, timeout=10).stdout.strip()
        self.assertEqual(state(), "blocked")
        with WorkspaceRegistry(self.directory) as other:
            self.assertEqual(other.runner_id, self.registry.runner_id)
            self.assertEqual(state(), "blocked")
        self.assertEqual(state(), "blocked")
        self.registry.db.execute("INSERT INTO metadata VALUES('after-open','intact')")
        self.assertEqual(self.registry.db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_existing_database_is_never_raw_opened(self):
        with patch.object(registry_module.os, "open", side_effect=AssertionError("raw open of existing SQLite inode")):
            with WorkspaceRegistry(self.directory) as other:
                self.assertEqual(other.runner_id, self.registry.runner_id)

    def test_creation_race_validates_file_created_by_other_process(self):
        info = self.registry.path.lstat()
        with patch.object(registry_module, "_database_info", side_effect=[FileNotFoundError(), info, info]), \
             patch.object(registry_module.os, "open", side_effect=FileExistsError()) as opened:
            with WorkspaceRegistry(self.directory) as other:
                self.assertEqual(other.runner_id, self.registry.runner_id)
        self.assertTrue(opened.call_args.args[1] & os.O_EXCL)

    def test_changed_inode_after_connect_closes_connection(self):
        before = self.registry.path.lstat()
        after = SimpleNamespace(st_dev=before.st_dev, st_ino=before.st_ino + 1)
        db = Mock()
        with patch.object(registry_module, "_database_info", side_effect=[before, after]), \
             patch.object(registry_module.sqlite3, "connect", return_value=db) as connected, \
             self.assertRaisesRegex(RegistryError, "changed while"):
            registry_module._connect_private_database(self.registry.path)
        db.close.assert_called_once_with()
        self.assertTrue(connected.call_args.args[0].endswith("?mode=rw"))
        self.assertTrue(connected.call_args.kwargs["uri"])

    def test_symlink_is_rejected_without_opening_target(self):
        target = self.directory / "target"
        target.write_text("not a database")
        unsafe = self.directory / "unsafe"
        unsafe.mkdir()
        (unsafe / "registry.sqlite3").symlink_to(target)
        with patch.object(registry_module.sqlite3, "connect", side_effect=AssertionError("must reject before SQLite")), \
             self.assertRaisesRegex(RegistryError, "symbolic link"):
            WorkspaceRegistry(unsafe)
        self.assertEqual(target.read_text(), "not a database")

    def test_initial_pragma_error_closes_connection_and_preserves_original(self):
        error = sqlite3.OperationalError("original pragma failure")
        db = Mock()
        db.execute.side_effect = error
        db.close.side_effect = sqlite3.OperationalError("secondary close failure")
        with patch.object(registry_module, "_connect_private_database", return_value=db), \
             self.assertRaises(sqlite3.OperationalError) as caught:
            WorkspaceRegistry(self.directory)
        self.assertIs(caught.exception, error)
        db.close.assert_called_once_with()

    def test_auto_rollback_does_not_mask_original_transaction_failure(self):
        error = sqlite3.OperationalError("original disk I/O error")
        with self.assertRaises(sqlite3.OperationalError) as caught:
            with self.registry.transaction():
                self.registry.db.execute("ROLLBACK")  # SQLite may auto-rollback on I/O failure.
                raise error
        self.assertIs(caught.exception, error)
        self.assertFalse(self.registry.db.in_transaction)

    def test_failed_cleanup_does_not_mask_original_transaction_failure(self):
        error = sqlite3.OperationalError("original write failure")
        db = Mock(in_transaction=True)
        db.rollback.side_effect = sqlite3.OperationalError("secondary rollback failure")
        with patch.object(self.registry, "db", db), self.assertRaises(sqlite3.OperationalError) as caught:
            with self.registry.transaction():
                raise error
        self.assertIs(caught.exception, error)
        db.rollback.assert_called_once_with()

    def test_context_read_auto_rollback_preserves_original_error(self):
        root = self.directory / "project"
        root.mkdir()
        workspace = self.registry.resolve(root)["id"]
        store = ContextStore(self.registry)
        error = sqlite3.OperationalError("original read failure")
        def failed_view(_):
            self.registry.db.execute("ROLLBACK")
            raise error
        with patch.object(store, "_view", side_effect=failed_view), self.assertRaises(sqlite3.OperationalError) as caught:
            store.get(workspace)
        self.assertIs(caught.exception, error)
        self.assertFalse(self.registry.db.in_transaction)

    def _jobs(self):
        root = self.directory / "project"
        root.mkdir()
        workspace = self.registry.resolve(root)["id"]
        store = PipStore(self.registry)
        jobs = [store.create(workspace, name, "Review locally", "editor-user")
                for name in ("First Pip", "Second Pip")]
        return root, workspace, store, jobs

    def test_pip_list_releases_cursor_before_expiry_and_concurrent_commit(self):
        _, workspace, store, jobs = self._jobs()
        self.registry.clock = lambda: "2026-10-01T10:00:00.000Z"
        for job in jobs:
            store.propose(job["id"], 1, {"goal": "Reviewed replacement"}, "editor-user")
        self.registry.clock = lambda: "2026-10-09T10:00:00.000Z"
        original_get = store.get
        with WorkspaceRegistry(self.directory) as writer:
            def get_after_commit(pip_id):
                # Force the runner/UI interleaving synchronously, with real WAL
                # connections and no scheduling/timing assertion. The old lazy
                # list cursor produces SQLITE_BUSY_SNAPSHOT on the expiry write.
                writer.db.execute("INSERT OR REPLACE INTO metadata VALUES('test-heartbeat',?)", (pip_id,))
                return original_get(pip_id)
            with patch.object(store, "get", side_effect=get_after_commit):
                result = store.list(workspace)
        self.assertEqual({item["id"] for item in result}, {job["id"] for job in jobs})
        self.assertTrue(all(not item["proposals"] and item["pending_review_count"] == 0 for item in result))
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_approvals WHERE status='expired'").fetchone()[0], 2)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_events WHERE event_type='pip_approval_expired'").fetchone()[0], 2)
        self.assertFalse(self.registry.db.in_transaction)

    def test_current_registry_refresh_is_read_only_during_runner_write(self):
        root, workspace, _, jobs = self._jobs()
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO metadata VALUES('uncommitted-heartbeat','new')")
            # Avoid waiting if the regression returns: this is a write-lock
            # assertion, not an assertion about how many milliseconds it takes.
            connect = registry_module._connect_private_database
            def without_wait(path):
                connection = connect(path)
                connection.execute("PRAGMA busy_timeout=0")
                return connection
            with patch.object(registry_module, "_connect_private_database", side_effect=without_wait):
                with WorkspaceRegistry(self.directory) as reader:
                    self.assertEqual(reader.resolve(root)["id"], workspace)
                    store = PipStore(reader)
                    self.assertEqual(len(store.list(workspace)), 2)
                    self.assertEqual(pip_approvals.history(reader, jobs[0]["id"])["approvals"], [])
                    self.assertIsNone(reader.db.execute("SELECT value FROM metadata WHERE key='uncommitted-heartbeat'").fetchone())
                    self.assertEqual(reader.db.total_changes, 0)
                    self.assertFalse(reader.db.in_transaction)

    def test_expiry_rechecks_after_other_reader_resolves_review(self):
        _, _, store, jobs = self._jobs()
        self.registry.clock = lambda: "2026-10-01T10:00:00.000Z"
        job = jobs[0]
        store.propose(job["id"], 1, {"goal": "Reviewed replacement"}, "editor-user")
        now = "2026-10-09T10:00:00.000Z"
        with WorkspaceRegistry(self.directory) as other:
            transaction = self.registry.transaction
            def enter_after_expiry():
                pip_approvals.expire_pending(other, job["id"], now=now)
                return transaction()
            with patch.object(self.registry, "transaction", side_effect=enter_after_expiry):
                pip_approvals.expire_pending(self.registry, job["id"], now=now)
        self.assertEqual(self.registry.db.execute("SELECT status FROM pip_approvals WHERE pip_id=?", (job["id"],)).fetchone()[0], "expired")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_events WHERE event_type='pip_approval_expired'").fetchone()[0], 1)

    def test_real_expiry_write_failure_is_not_hidden(self):
        _, _, store, jobs = self._jobs()
        self.registry.clock = lambda: "2026-10-01T10:00:00.000Z"
        job = jobs[0]
        store.propose(job["id"], 1, {"goal": "Reviewed replacement"}, "editor-user")
        error = sqlite3.OperationalError("actual disk I/O failure")
        with patch.object(self.registry, "transaction", side_effect=error), \
             self.assertRaises(sqlite3.OperationalError) as caught:
            pip_approvals.expire_pending(self.registry, job["id"], now="2026-10-09T10:00:00.000Z")
        self.assertIs(caught.exception, error)
        self.assertEqual(self.registry.db.execute("SELECT status FROM pip_approvals WHERE pip_id=?", (job["id"],)).fetchone()[0], "pending")


if __name__ == "__main__":
    unittest.main()
