"""Independent deterministic transaction/migration/worker-boundary chat regressions."""
from __future__ import annotations

import concurrent.futures
import sqlite3
import threading
import unittest
from unittest.mock import patch

from dgc import pip_chat, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry, SCHEMA_VERSION
from tests import test_pips_local as fixtures


class PipChatReviewTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    create = fixtures.LocalPipsTests.create

    def as_schema_three(self):
        job = self.create()
        with self.registry.transaction():
            # Remove later tables as well: this fixture represents a real v3 DB.
            from tests.pip_test_migrations import drop_archive_schema
            drop_archive_schema(self.registry.db)
            for table in ("pip_memories", "pip_notifications", "pip_notification_seen", "pip_notification_state", "workspace_session_outcomes", "pip_lifecycle_requests", "session_pip_attachments", "pip_commit_observations", "pip_event_trigger_state", "pip_adaptations", "pip_handoffs", "pip_execution_reviews", "pip_finding_review_history",
                          "pip_finding_reviews", "pip_checkpoints"):
                self.registry.db.execute("DROP TABLE " + table)
            self.registry.db.execute("DROP INDEX IF EXISTS pip_event_source")
            self.registry.db.execute("DROP TABLE pip_chat_messages")
            self.registry.db.execute("PRAGMA user_version=3")
        return job

    def test_schema_three_upgrade_preserves_existing_workspace_and_job(self):
        job = self.as_schema_three()
        with WorkspaceRegistry(self.registry.directory) as upgraded:
            self.assertEqual(upgraded.runner_id, self.registry.runner_id)
            self.assertEqual(upgraded.get(self.workspace["id"])["id"], self.workspace["id"])
            self.assertEqual(pips.PipStore(upgraded).get(job["id"])["current_version"], 1)
            self.assertEqual(upgraded.db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            self.assertEqual(upgraded.db.execute("SELECT count(*) FROM pip_chat_messages").fetchone()[0], 0)
        with WorkspaceRegistry(self.registry.directory) as reopened:
            self.assertEqual(reopened.db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_failed_chat_migration_rolls_back_every_statement_and_version(self):
        job = self.as_schema_three()
        broken = pip_chat.SCHEMA + "\nCREATE TABLE review_partial_migration(id INTEGER);\nSELECT * FROM review_missing_table;"
        with patch.object(pip_chat, "SCHEMA", broken), self.assertRaises(sqlite3.OperationalError):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute("PRAGMA user_version").fetchone()[0], 3)
        self.assertEqual(self.registry.db.execute(
            "SELECT name FROM sqlite_master WHERE name IN ('pip_chat_messages','review_partial_migration')").fetchall(), [])
        self.assertEqual(self.registry.db.execute("SELECT current_version FROM pips WHERE id=?", (job["id"],)).fetchone()[0], 1)
        with WorkspaceRegistry(self.registry.directory) as recovered:
            self.assertEqual(recovered.db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            self.assertEqual(pips.PipStore(recovered).get(job["id"])["id"], job["id"])

    def race(self, requests):
        job = self.create()
        barrier = threading.Barrier(2)

        def source(*_):
            # Both writers have missed the initial idempotency read, but neither
            # has acquired BEGIN IMMEDIATE. No timing assumptions or sleeps.
            barrier.wait(timeout=10)
            return "a" * 40

        def send(item):
            text, key = item
            with WorkspaceRegistry(self.registry.directory) as registry:
                store = pips.PipStore(registry)
                try:
                    value = pip_chat.send(store, job["id"], text, key, "review-device", self.cfg)
                    return ("ok", value["run"]["id"])
                except RegistryError as exc:
                    return (exc.code, str(exc))

        with patch.object(pips, "source_revision", side_effect=source), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")), \
             concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(send, request) for request in requests]
            results = [future.result(timeout=15) for future in futures]
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_runs WHERE pip_id=?", (job["id"],)).fetchone()[0], 1)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_chat_messages WHERE pip_id=?", (job["id"],)).fetchone()[0], 1)
        return results

    def test_two_connections_cannot_enqueue_two_pending_replies(self):
        results = self.race([("First message", "first-key"), ("Second message", "second-key")])
        self.assertCountEqual([value[0] for value in results], ["ok", "conversation_busy"])

    def test_two_connections_exact_retry_returns_one_run(self):
        results = self.race([("Same message", "same-key"), ("Same message", "same-key")])
        self.assertEqual([value[0] for value in results], ["ok", "ok"])
        self.assertEqual(results[0][1], results[1][1])

    def test_two_connections_same_key_changed_text_conflicts(self):
        results = self.race([("First message", "same-key"), ("Different message", "same-key")])
        self.assertCountEqual([value[0] for value in results], ["ok", "conflict"])

    def test_workspace_history_and_retry_keys_remain_independent(self):
        first_job = self.create()
        other_root = self.base / "other-repository"
        other_root.mkdir()
        other_workspace = self.registry.resolve(other_root)
        other_job = self.store.create(other_workspace["id"], "Other reviewer", "Inspect other source", "review-device")
        with patch.object(pips, "source_revision", return_value="a" * 40):
            first = pip_chat.send(self.store, first_job["id"], "First workspace only", "shared-key", "review-device", self.cfg)
            self.store.claim_next()
            self.store.finish(first["run"]["id"], result={"text": "First workspace's private answer"})
            other = pip_chat.send(self.store, other_job["id"], "Other workspace", "shared-key", "review-device", self.cfg)
        self.assertNotEqual(first["run"]["id"], other["run"]["id"])
        self.assertEqual(other["run"]["workspace_id"], other_workspace["id"])
        self.assertEqual(other["run"]["manifest"]["conversation"]["history"], [])
        self.assertIsNone(other["run"]["manifest"]["conversation"]["last_report"])
        page = pip_chat.list_messages(self.store, other_job["id"])
        self.assertEqual(page["workspace_id"], other_workspace["id"])
        self.assertTrue(all(item["workspace_id"] == other_workspace["id"] for item in page["messages"]))
        with self.assertRaises(RegistryError) as failure:
            pip_chat.list_messages(self.store, other_job["id"], first["message"]["id"])
        self.assertEqual(failure.exception.code, "invalid_cursor")

    def test_complete_worker_envelope_overflow_refuses_before_worker_spawn(self):
        # The original committed rules copy through clean_snapshot, which this test replaces.
        job = self.store.create(self.workspace["id"], "Backend Auditor", "Inspect correctness.", "device_1",
                                source_policy={"mode": "committed_only"})
        with patch.object(pips, "source_revision", return_value="a" * 40):
            pip_chat.send(self.store, job["id"], "Explain this source", "overflow", "review-device", self.cfg)
        row = self.store.claim_next()
        # A credential is part of the complete envelope even though it is never
        # saved in the manifest; validating only manifest length misses this.
        self.cfg.set("api_key", "x" * (pips.MAX_WORKER_INPUT_BYTES + 1), persist=False)

        def snapshot(_root, _revision, destination):
            destination.mkdir(parents=True)
            return {"sha256": "b" * 64, "files": 0, "bytes": 0}

        with patch.object(pips, "clean_snapshot", side_effect=snapshot), \
             patch.object(pips.subprocess, "Popen", side_effect=AssertionError("Worker must not spawn")) as spawn, \
             self.assertRaises(RegistryError) as failure:
            pips._execute_run(self.registry, row, self.cfg)
        self.assertEqual(failure.exception.code, "input_limit")
        spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
