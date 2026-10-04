"""Deterministic local context/migration tests. No provider, callbacks or sleeps."""
from __future__ import annotations

import copy
import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import workspace_context as context
from dgc import workspace_registry as registry_module
from dgc.workspace_context import ContextStore, validate_snapshot
from dgc.workspace_registry import RegistryError, WorkspaceRegistry, identifier

NOW = "2026-10-01T10:00:00.000Z"


class WorkspaceContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dgc-context-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "project"
        self.root.mkdir()
        self.registry = WorkspaceRegistry(self.base / "state", clock=lambda: NOW)
        self.addCleanup(self.registry.close)
        self.store = ContextStore(self.registry)
        self.workspace = self.registry.resolve(self.root)
        self.ws = self.workspace["id"]

    def record(self, *, kind="decision", title="Choice", content="Use the existing router.", revision=0, actor="device-one"):
        return self.store.record(self.ws, kind, title, content, revision, actor)

    def source_run(self, *, workspace=None, status="succeeded", finding=None, manifest=None, result=None):
        workspace = workspace or self.workspace
        pip_id, run_id = identifier("pip"), identifier("run")
        finding = finding if finding is not None else {"title": "Potential missing validation", "severity": "medium",
            "path": "source.py", "line": 2, "evidence": "    return value", "verification": "source_excerpt_only"}
        manifest = manifest if manifest is not None else {"job_version": 1, "source_revision": "a" * 40, "model": "fixture-model"}
        result = result if result is not None else {"summary": "Fixture report", "findings": [finding], "limitations": [], "tests_executed": False}
        self.registry.db.execute("INSERT INTO pips VALUES(?,?,?,?,?,?)", (pip_id, workspace["id"], "active", 1, NOW, NOW))
        self.registry.db.execute("INSERT INTO pip_versions VALUES(?,?,?,?,?,?)", (pip_id, 1, "{}", "fixture", "", NOW))
        self.registry.db.execute("""INSERT INTO pip_runs
            (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at,started_at,finished_at,result,error)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (run_id, pip_id, workspace["id"], workspace["binding_id"], run_id, "fixture",
                json.dumps(manifest), status, NOW, NOW, NOW, json.dumps(result), None))
        return run_id

    def test_empty_view_revision_zero_and_snapshot_is_pure(self):
        view = self.store.get(self.ws)
        self.assertEqual(view, {"workspace_id": self.ws, "revision": 0, "entries": []})
        snapshot = self.store.snapshot(self.ws)
        expected = hashlib.sha256(json.dumps(view, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(snapshot["digest"], expected)
        with patch.object(registry_module, "WorkspaceRegistry", side_effect=AssertionError("pure validation must not open state")):
            self.assertEqual(validate_snapshot(snapshot, self.ws), snapshot)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_context_revisions").fetchone()[0], 0)

    def test_user_kinds_are_explicit_immutable_reference_records(self):
        for revision, kind in enumerate(sorted(context.RECORD_KINDS)):
            view = self.record(kind=kind, title=kind, content="  reference text\nwith formatting\n", revision=revision)
            entry = view["entries"][-1]
            self.assertEqual(entry["kind"], kind)
            self.assertEqual(entry["created_revision"], revision + 1)
            self.assertEqual(entry["content"], "  reference text\nwith formatting\n")
            self.assertEqual(entry["provenance"], {"source": "user_recorded", "classification": "user_record"})
        events = self.registry.activity(self.ws)["events"]
        self.assertEqual(sum(event["event_type"] == "workspace_context_recorded" for event in events), 5)
        self.assertNotIn("content", events[-1]["payload"])

    def test_no_automatic_transcript_or_model_finding_promotion(self):
        for kind in ("finding", "transcript", "memory", "model_instruction", {}, None):
            with self.subTest(kind=kind), self.assertRaises(RegistryError):
                self.record(kind=kind)
        self.assertEqual(self.store.get(self.ws)["revision"], 0)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_context_entries").fetchone()[0], 0)

    def test_commands_and_exceptions_are_reference_data_not_executed(self):
        with patch("subprocess.Popen", side_effect=AssertionError("context must not execute")), \
             patch("socket.socket", side_effect=AssertionError("context must not contact services")):
            first = self.record(kind="command", content="sudo systemctl reload example-service")
            second = self.record(kind="exception", content="Reference: release exception proposed, not a permission grant.", revision=1)
            pin = self.store.snapshot(self.ws)
        self.assertEqual(first["entries"][0]["provenance"]["classification"], "user_record")
        self.assertEqual(second["revision"], 2)
        self.assertNotIn("permissions", json.dumps(pin))

    def test_actor_and_expected_revision_are_strict(self):
        for revision in (True, False, -1, "0", 0.0, None, 2 ** 63):
            with self.subTest(revision=revision), self.assertRaises(RegistryError):
                self.record(revision=revision)
        for actor in ("", " ", None, 7, "line\nbreak"):
            with self.subTest(actor=actor), self.assertRaises(RegistryError):
                self.record(actor=actor)
        self.assertEqual(self.store.get(self.ws)["revision"], 0)

    def test_oversize_text_is_bounded_before_normalization_or_encoding(self):
        class NoNormalization(str):
            def strip(self, *args):
                raise AssertionError("oversize strings must be bounded before normalization")
            def encode(self, *args, **kwargs):
                raise AssertionError("oversize strings must be bounded before encoding")
        with self.assertRaises(RegistryError):
            self.record(content=NoNormalization("x" * (context.MAX_CONTENT_BYTES + 1)))
        self.assertEqual(self.store.get(self.ws)["revision"], 0)

    def test_stale_writer_on_separate_connection_cannot_overwrite(self):
        seen = self.store.get(self.ws)["revision"]
        with WorkspaceRegistry(self.registry.directory, clock=lambda: NOW) as other:
            ContextStore(other).record(self.ws, "decision", "Other", "Concurrent explicit record", seen, "device-two")
        with self.assertRaisesRegex(RegistryError, "changed"):
            self.record(revision=seen)
        view = self.store.get(self.ws)
        self.assertEqual(view["revision"], 1)
        self.assertEqual([entry["title"] for entry in view["entries"]], ["Other"])

    def test_standalone_read_uses_one_database_snapshot(self):
        with WorkspaceRegistry(self.registry.directory, clock=lambda: NOW) as other:
            fired = False
            def trace(sql):
                nonlocal fired
                if not fired and sql.startswith("SELECT revision FROM workspace_context_revisions"):
                    fired = True
                    ContextStore(other).record(self.ws, "decision", "Concurrent", "Newer view", 0, "device-two")
            self.registry.db.set_trace_callback(trace)
            try:
                view = self.store.get(self.ws)
            finally:
                self.registry.db.set_trace_callback(None)
        self.assertTrue(fired)
        self.assertEqual(view, {"workspace_id": self.ws, "revision": 0, "entries": []})
        self.assertEqual(self.store.get(self.ws)["revision"], 1)

    def test_snapshot_inside_enqueue_transaction_never_commits_outer_work(self):
        with self.assertRaisesRegex(RuntimeError, "abort outer"):
            with self.registry.transaction():
                self.registry.db.execute("INSERT INTO metadata VALUES('outer-change','pending')")
                self.assertEqual(self.store.snapshot(self.ws)["revision"], 0)
                self.assertTrue(self.registry.db.in_transaction)
                raise RuntimeError("abort outer")
        self.assertIsNone(self.registry.db.execute("SELECT value FROM metadata WHERE key='outer-change'").fetchone())

    def test_record_event_failure_rolls_back_entry_and_revision(self):
        with patch.object(self.registry, "event", side_effect=RuntimeError("event failure")), \
             self.assertRaisesRegex(RuntimeError, "event failure"):
            self.record()
        self.assertEqual(self.store.get(self.ws)["revision"], 0)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_context_entries").fetchone()[0], 0)

    def test_archive_removes_active_entry_but_preserves_immutable_history(self):
        entry = self.record()["entries"][0]
        archived = self.store.archive(self.ws, entry["id"], 1, "device-two")
        self.assertEqual(archived, {"workspace_id": self.ws, "revision": 2, "entries": []})
        row = self.registry.db.execute("SELECT * FROM workspace_context_entries WHERE id=?", (entry["id"],)).fetchone()
        self.assertEqual(row["status"], "archived")
        self.assertEqual(row["archived_by"], "device-two")
        self.assertEqual(row["archived_revision"], 2)
        self.assertEqual(row["content"], entry["content"])
        with self.assertRaises(sqlite3.IntegrityError):
            self.registry.db.execute("DELETE FROM workspace_context_entries WHERE id=?", (entry["id"],))
        with self.assertRaises(sqlite3.IntegrityError):
            self.registry.db.execute("UPDATE workspace_context_entries SET status='active',archived_at=NULL,archived_by=NULL,archived_revision=NULL WHERE id=?", (entry["id"],))

    def test_archive_wrong_workspace_stale_or_already_archived_is_refused(self):
        entry = self.record()["entries"][0]
        other_root = self.base / "other"
        other_root.mkdir()
        other = self.registry.resolve(other_root)
        for workspace, revision in ((other["id"], 0), (self.ws, 0)):
            with self.subTest(workspace=workspace), self.assertRaises(RegistryError):
                self.store.archive(workspace, entry["id"], revision, "device-one")
        self.store.archive(self.ws, entry["id"], 1, "device-one")
        with self.assertRaises(RegistryError):
            self.store.archive(self.ws, entry["id"], 2, "device-one")
        self.assertEqual(self.store.get(self.ws)["revision"], 2)

    def test_entry_bodies_actor_and_provenance_cannot_be_changed_in_sql(self):
        entry = self.record()["entries"][0]
        for column in ("content", "title", "kind", "provenance", "created_by", "created_revision", "source_run_id"):
            with self.subTest(column=column), self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                self.registry.db.execute(f"UPDATE workspace_context_entries SET {column}=? WHERE id=?", ("changed", entry["id"]))

    def test_pin_is_detached_and_does_not_change_when_context_changes(self):
        entry = self.record()["entries"][0]
        pin = self.store.snapshot(self.ws)
        saved = copy.deepcopy(pin)
        self.store.archive(self.ws, entry["id"], 1, "device-two")
        self.assertEqual(pin, saved)
        self.assertEqual(validate_snapshot(pin), saved)
        detached = validate_snapshot(pin)
        detached["entries"][0]["content"] = "caller mutation"
        self.assertEqual(pin, saved)

    def test_snapshot_schema_digest_authority_and_workspace_are_validated(self):
        self.record()
        pin = self.store.snapshot(self.ws)
        variants = []
        changed = copy.deepcopy(pin); changed["entries"][0]["content"] = "tampered"; variants.append(changed)
        changed = copy.deepcopy(pin); changed["revision"] = True; variants.append(changed)
        changed = copy.deepcopy(pin); changed["permissions"] = {"shell": True}; variants.append(changed)
        changed = copy.deepcopy(pin); changed["entries"][0]["provenance"]["classification"] = "verified_fact"; variants.append(changed)
        changed = copy.deepcopy(pin); changed["entries"][0]["status"] = "archived"; variants.append(changed)
        for changed in variants:
            with self.subTest(changed=changed), self.assertRaises(RegistryError):
                validate_snapshot(changed)
        with self.assertRaisesRegex(RegistryError, "different workspace"):
            validate_snapshot(pin, "different-workspace")

    def test_byte_limits_and_invalid_unicode_fail_before_writes(self):
        for title, body in (("x" * 241, "body"), ("title", "x" * 4097), ("title", "😀" * 1025),
                            ("title", "\ud800"), ("title\n", "body"), ("title", "bad\x00data")):
            before = self.registry.db.total_changes
            with self.subTest(title=title, body_length=len(body)), self.assertRaises(RegistryError):
                self.record(title=title, content=body)
            self.assertEqual(self.registry.db.total_changes, before)

    def test_aggregate_budget_does_not_truncate_or_partially_write(self):
        for revision in range(3):
            self.record(content="😀" * 1000, revision=revision)
        before = self.store.snapshot(self.ws)
        statements = []
        self.registry.db.set_trace_callback(statements.append)
        try:
            with self.assertRaisesRegex(RegistryError, "budget"):
                self.record(content="😀" * 1000, revision=3)
        finally:
            self.registry.db.set_trace_callback(None)
        self.assertFalse(any(sql.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) for sql in statements))
        self.assertEqual(self.store.snapshot(self.ws), before)
        self.assertEqual(len(before["entries"][0]["content"]), 1000)

    def test_snapshot_budget_includes_its_digest_field(self):
        pin = self.store.snapshot(self.ws)
        exact = len(json.dumps(pin, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())
        with patch.object(context, "MAX_SNAPSHOT_BYTES", exact):
            self.assertEqual(self.store.snapshot(self.ws), pin)
        with patch.object(context, "MAX_SNAPSHOT_BYTES", exact - 1), self.assertRaises(RegistryError):
            self.store.snapshot(self.ws)

    def test_active_and_total_record_caps_keep_archived_history(self):
        with patch.object(context, "MAX_ACTIVE_ENTRIES", 1):
            entry = self.record()["entries"][0]
            with self.assertRaises(RegistryError):
                self.record(revision=1)
        self.store.archive(self.ws, entry["id"], 1, "device-one")
        with patch.object(context, "MAX_TOTAL_ENTRIES", 1), self.assertRaisesRegex(RegistryError, "retained"):
            self.record(revision=2)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_context_entries").fetchone()[0], 1)

    def test_accept_finding_keeps_model_classification_and_pinned_provenance(self):
        run = self.source_run()
        view = self.store.accept_finding(self.ws, run, 0, 0, "device-one")
        entry = view["entries"][0]
        self.assertEqual(entry["kind"], "finding")
        self.assertEqual(entry["content"], "    return value")
        provenance = entry["provenance"]
        self.assertEqual(provenance["classification"], "model_assessment")
        self.assertEqual(provenance["verification"], "source_excerpt_only")
        self.assertEqual(provenance["run_id"], run)
        self.assertEqual(provenance["source_revision"], "a" * 40)
        self.assertEqual(provenance["finding_index"], 0)
        self.assertEqual(provenance["job_version"], 1)
        self.assertEqual(provenance["model"], "fixture-model")
        self.registry.db.execute("UPDATE pip_runs SET result=? WHERE id=?", ('{"findings":[]}', run))
        self.assertEqual(self.store.get(self.ws), view, "Accepted provenance must not be a mutable run-result pointer")

    def test_only_successful_same_workspace_runs_can_be_promoted(self):
        other_root = self.base / "other"
        other_root.mkdir()
        foreign = self.source_run(workspace=self.registry.resolve(other_root))
        with self.assertRaisesRegex(RegistryError, "this workspace"):
            self.store.accept_finding(self.ws, foreign, 0, 0, "device-one")
        for status in ("queued", "running", "failed", "cancelled", "cancelling"):
            run = self.source_run(status=status)
            with self.subTest(status=status), self.assertRaisesRegex(RegistryError, "successfully completed"):
                self.store.accept_finding(self.ws, run, 0, 0, "device-one")
        self.assertEqual(self.store.get(self.ws)["revision"], 0)

    def test_finding_index_is_strict_and_missing_finding_refused(self):
        run = self.source_run()
        for index in (True, False, 0.0, "0", -1, 1, 16, None, 2 ** 63):
            with self.subTest(index=index), self.assertRaises(RegistryError):
                self.store.accept_finding(self.ws, run, index, 0, "device-one")
        self.assertEqual(self.store.get(self.ws)["revision"], 0)

    def test_acceptance_requires_source_checked_marker_and_pinned_commit(self):
        finding = {"title": "Unverified", "severity": "low", "path": "source.py", "line": 2,
                   "evidence": "    return value", "verification": "model_claimed_verified"}
        for run in (self.source_run(finding=finding), self.source_run(manifest={"model": "fixture", "job_version": 1}),
                    self.source_run(manifest={"model": "fixture", "job_version": True, "source_revision": "a" * 40})):
            with self.subTest(run=run), self.assertRaises(RegistryError):
                self.store.accept_finding(self.ws, run, 0, 0, "device-one")
        self.assertEqual(self.store.get(self.ws)["revision"], 0)

    def test_active_duplicate_acceptance_refused_and_archive_allows_deliberate_reaccept(self):
        run = self.source_run()
        entry = self.store.accept_finding(self.ws, run, 0, 0, "device-one")["entries"][0]
        with self.assertRaisesRegex(RegistryError, "already active"):
            self.store.accept_finding(self.ws, run, 0, 1, "device-two")
        self.store.archive(self.ws, entry["id"], 1, "device-one")
        second = self.store.accept_finding(self.ws, run, 0, 2, "device-two")["entries"][0]
        self.assertNotEqual(second["id"], entry["id"])
        self.assertEqual(second["provenance"], entry["provenance"])

    def test_oversize_run_result_rejected_before_json_decoding(self):
        run = self.source_run(result={"padding": "x" * (context.MAX_RUN_DATA_BYTES + 1)})
        decode = json.loads
        def bounded_decode(value, *args, **kwargs):
            self.assertLessEqual(len(value), context.MAX_RUN_DATA_BYTES, "must bound source data before decoding")
            return decode(value, *args, **kwargs)
        with patch.object(context.json, "loads", side_effect=bounded_decode), \
             self.assertRaises(RegistryError):
            self.store.accept_finding(self.ws, run, 0, 0, "device-one")

    def test_finding_source_paths_reject_directory_root_and_escape_paths(self):
        for path in (".", "/etc/passwd", "../secret", "folder/../../secret", "C:/secret", "folder\\secret"):
            finding = {"title": "Invalid source", "severity": "low", "path": path, "line": 1,
                       "evidence": "source text", "verification": "source_excerpt_only"}
            run = self.source_run(finding=finding)
            with self.subTest(path=path), self.assertRaisesRegex(RegistryError, "relative snapshot path"):
                self.store.accept_finding(self.ws, run, 0, 0, "device-one")
        self.assertEqual(self.store.get(self.ws)["revision"], 0)

    def test_finding_provenance_cannot_be_promoted_to_verified_fact_in_pin(self):
        run = self.source_run()
        self.store.accept_finding(self.ws, run, 0, 0, "device-one")
        pin = self.store.snapshot(self.ws)
        pin["entries"][0]["provenance"]["classification"] = "verified_fact"
        body = {key: pin[key] for key in ("workspace_id", "revision", "entries")}
        pin["digest"] = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        with self.assertRaisesRegex(RegistryError, "model assessment"):
            validate_snapshot(pin)


class RegistryContextMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dgc-context-migration-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.path = self.directory / "registry.sqlite3"
        with sqlite3.connect(self.path) as db:
            registry_module._execute_schema(db, registry_module._SCHEMA_V1)
            db.execute("INSERT INTO metadata VALUES('runner_id','runner-existing')")
            db.execute("INSERT INTO metadata VALUES('daemon_heartbeat','do-not-change')")
            db.execute("INSERT INTO workspaces VALUES('ws-old','Existing','git',?,?)", (NOW, NOW))
            db.execute("INSERT INTO bindings VALUES('binding-old','ws-old','runner-existing',?,?)", (str(self.directory), NOW))
            db.execute("INSERT INTO pips VALUES('pip-old','ws-old','active',1,?,?)", (NOW, NOW))
            db.execute("INSERT INTO pip_versions VALUES('pip-old',1,'{" + '"goal":"Original job"' + "}','original','',?)", (NOW,))
            db.execute("""INSERT INTO pip_runs VALUES('run-old','pip-old','ws-old','binding-old','old-key','original',
                '{"source_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}','succeeded',?,?,?,'{"summary":"Original result"}',NULL)""", (NOW, NOW, NOW))
            db.execute("PRAGMA user_version=1")
        with sqlite3.connect(self.path) as db:
            self.original_run = db.execute("SELECT * FROM pip_runs").fetchone()
            self.original_job = db.execute("SELECT * FROM pip_versions").fetchone()

    def test_atomic_v1_to_v2_preserves_runner_jobs_runs_and_unrelated_metadata(self):
        with WorkspaceRegistry(self.directory) as registry:
            self.assertEqual(registry.db.execute("PRAGMA user_version").fetchone()[0], registry_module.SCHEMA_VERSION)
            self.assertEqual(registry.runner_id, "runner-existing")
            self.assertEqual(tuple(registry.db.execute("SELECT * FROM pip_runs").fetchone()), self.original_run)
            self.assertEqual(tuple(registry.db.execute("SELECT * FROM pip_versions").fetchone()), self.original_job)
            self.assertEqual(registry.db.execute("SELECT value FROM metadata WHERE key='daemon_heartbeat'").fetchone()[0], "do-not-change")
            self.assertEqual(ContextStore(registry).get("ws-old"), {"workspace_id": "ws-old", "revision": 0, "entries": []})
        with WorkspaceRegistry(self.directory) as reopened:
            self.assertEqual(reopened.runner_id, "runner-existing")

    def test_migration_failure_after_version_change_rolls_back_every_new_object(self):
        initialize = WorkspaceRegistry._initialize_schema
        def fail(registry):
            initialize(registry)
            raise RuntimeError("injected migration failure")
        with patch.object(WorkspaceRegistry, "_initialize_schema", fail), self.assertRaisesRegex(RuntimeError, "injected"):
            WorkspaceRegistry(self.directory)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT * FROM pip_runs").fetchone(), self.original_run)
            self.assertFalse(db.execute("SELECT name FROM sqlite_master WHERE name LIKE '%context%'").fetchall())
        with WorkspaceRegistry(self.directory) as retried:
            self.assertEqual(retried.db.execute("PRAGMA user_version").fetchone()[0], registry_module.SCHEMA_VERSION)

    def test_unknown_schema_is_refused_without_migration_or_record_changes(self):
        with sqlite3.connect(self.path) as db:
            db.execute("PRAGMA user_version=999")
        with patch.object(registry_module, "_execute_schema", side_effect=AssertionError("must not migrate unknown schema")), \
             self.assertRaisesRegex(RegistryError, "compatible"):
            WorkspaceRegistry(self.directory)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 999)
            self.assertEqual(db.execute("SELECT * FROM pip_runs").fetchone(), self.original_run)
            self.assertFalse(db.execute("SELECT name FROM sqlite_master WHERE name LIKE '%context%'").fetchall())


if __name__ == "__main__":
    unittest.main()
