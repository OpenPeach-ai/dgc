"""Deterministic checkpoint persistence, review, scope and bounds tests."""
from __future__ import annotations

import copy
import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_checkpoints as checkpoints
from dgc.pips import PipStore
from dgc.workspace_context import ContextStore
from dgc.workspace_registry import RegistryError, WorkspaceRegistry, identifier

NOW = "2026-10-01T10:00:00.000Z"


class PipCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dgc-checkpoint-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "project"
        self.root.mkdir()
        self.registry = WorkspaceRegistry(self.base / "state", clock=lambda: NOW)
        self.addCleanup(self.registry.close)
        self.store = PipStore(self.registry)
        self.workspace = self.registry.resolve(self.root)
        self.job = self.new_pip()

    def new_pip(self, workspace=None):
        workspace = workspace or self.workspace
        return self.store.create(workspace["id"], "Review", "Inspect source evidence", "HEAD", "fixture")

    def finding(self, title="Check validation", **changes):
        return {"title": title, "severity": "medium", "path": "source.py", "line": 1,
                "evidence": "return value", "verification": "source_excerpt_only", **changes}

    def report(self, findings=None):
        return {"summary": "Source inspection", "findings": [self.finding()] if findings is None else findings,
                "limitations": ["Tests were not run."], "tests_executed": False,
                "verification": checkpoints._SOURCE_VERIFICATION}

    def source_run(self, findings=None, *, job=None, manifest_changes=None, result=None, status="running", legacy=False):
        job = job or self.job
        workspace = self.registry.get(job["workspace_id"])
        binding = self.registry.binding(job["workspace_id"])
        run_id = identifier("run")
        manifest = {"pip_id": job["id"], "workspace_id": workspace["id"], "job_version": job["current_version"],
                    "source_revision": "a" * 40, "model": "fixture-model", "run_kind": "audit",
                    "workspace_context": ContextStore(self.registry).snapshot(workspace["id"])}
        if not legacy:
            manifest["audit_checkpoint"] = checkpoints.snapshot(self.store, job["id"])
        manifest.update(manifest_changes or {})
        self.registry.db.execute("""INSERT INTO pip_runs
            (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at,started_at,finished_at,result,error)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)""", (run_id, job["id"], workspace["id"], binding["id"], run_id, "fixture",
                json.dumps(manifest), status, NOW, NOW, NOW if status == "succeeded" else None,
                json.dumps(result) if result is not None else None))
        return run_id, self.report(findings) if result is None else result

    def complete(self, findings=None, **kwargs):
        run_id, result = self.source_run(findings, **kwargs)
        self.store.finish(run_id, result=result)
        return run_id, checkpoints.for_run(self.store, run_id)

    def test_empty_snapshot_is_pure_bound_and_digested(self):
        snap = checkpoints.snapshot(self.store, self.job["id"])
        self.assertIsNone(snap["checkpoint"])
        with patch("sqlite3.connect", side_effect=AssertionError("worker validator must be pure")):
            self.assertEqual(checkpoints.validate_snapshot(snap, self.workspace["id"], self.job["id"]), snap)
        self.assertLessEqual(len(json.dumps(snap).encode()), checkpoints.MAX_SNAPSHOT_BYTES)

    def test_reformatted_result_survives_finish_and_reopen(self):
        result={**self.report(),"report_reformatted":True}
        run_id, checkpoint=self.complete(result=result)
        self.assertTrue(self.store.run(run_id)["result"]["report_reformatted"])
        self.assertEqual(self.store.run(run_id)["status"],"succeeded")
        with WorkspaceRegistry(self.registry.directory) as reopened:
            saved=PipStore(reopened).run(run_id)
            self.assertTrue(saved["result"]["report_reformatted"])
            self.assertEqual(saved["result"]["verification"],checkpoints._SOURCE_VERIFICATION)
            self.assertEqual(checkpoints.for_run(PipStore(reopened),run_id),checkpoint)

    def test_success_persists_exact_provenance_and_idempotent_finish(self):
        run_id, first = self.complete()
        self.assertEqual(first["counts"], {"total": 1, "new": 1, "repeated": 0, "not_observed": 0})
        self.assertIsNone(first["baseline_checkpoint_id"])
        self.assertEqual(first["source_revision"], "a" * 40)
        self.assertEqual(first["context_revision"], 0)
        self.assertEqual(first["findings"][0]["review"], {"status": "open", "revision": 0, "actor": None,
                                                        "reason": None, "updated_at": None})
        self.store.finish(run_id, result=self.report([]))
        self.assertEqual(checkpoints.for_run(self.store, run_id), first)
        with self.registry.transaction():
            self.assertEqual(checkpoints.record_completed(self.store, self.store.run(run_id), self.report()), first)
        with WorkspaceRegistry(self.registry.directory) as reopened:
            self.assertEqual(checkpoints.for_run(PipStore(reopened), run_id), first)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_checkpoints").fetchone()[0], 1)

    def test_transaction_failure_rolls_back_terminal_run_checkpoint_reviews_and_event(self):
        run_id, result = self.source_run()
        events = self.registry.db.execute("SELECT count(*) FROM workspace_events").fetchone()[0]
        with patch.object(self.registry, "event", side_effect=RuntimeError("event failure")), self.assertRaises(RuntimeError):
            self.store.finish(run_id, result=result)
        self.assertEqual(self.store.run(run_id)["status"], "running")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_checkpoints").fetchone()[0], 0)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_finding_reviews").fetchone()[0], 0)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_events").fetchone()[0], events)

    def test_failed_cancelled_chat_and_legacy_runs_do_not_create_checkpoint(self):
        for status in ("failed", "cancelled", "legacy", "chat"):
            changes = {"run_kind": "conversation"} if status == "chat" else None
            run_id, result = self.source_run(legacy=status == "legacy", manifest_changes=changes)
            if status == "failed":
                self.store.finish(run_id, error={"code": "fixture_failure"})
            elif status == "cancelled":
                self.store.cancel(run_id, "fixture")
                self.store.finish(run_id, result=result)
            elif status == "chat":
                # No chat-message insert here: a source-only fixture tests the checkpoint boundary.
                with patch("dgc.pip_chat.insert_reply"):
                    self.store.finish(run_id, result={"text": "A conversation reply"})
            else:
                self.store.finish(run_id, result={"summary": "Historical permissive result"})
            self.assertIsNone(checkpoints.for_run(self.store, run_id))
        self.assertIsNone(checkpoints.snapshot(self.store, self.job["id"])["checkpoint"])

    def test_unchecked_report_refused_and_finish_stays_running(self):
        mutations = [lambda r: r.pop("verification"), lambda r: r.update(tests_executed=True),
                     lambda r: r["findings"][0].update(verification="verified_bug"),
                     lambda r: r["findings"][0].update(line=True),
                     lambda r: r["findings"][0].update(path="../outside"),
                     lambda r: r["findings"][0].update(evidence="\ud800")]
        for change in mutations:
            run_id, result = self.source_run()
            change(result)
            with self.subTest(result=result), self.assertRaises(RegistryError):
                self.store.finish(run_id, result=result)
            self.assertEqual(self.store.run(run_id)["status"], "running")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_checkpoints").fetchone()[0], 0)

    def test_exact_occurrence_matching_never_infers_resolution(self):
        _, first = self.complete([self.finding(), self.finding("Other", path="other.py")])
        _, second = self.complete([self.finding(line=27, severity="high"), self.finding("New", path="new.py")])
        self.assertEqual(second["baseline_checkpoint_id"], first["id"])
        self.assertEqual(second["counts"], {"total": 2, "new": 1, "repeated": 1, "not_observed": 1})
        self.assertEqual([item["comparison"] for item in second["findings"]], ["repeated", "new"])
        self.assertNotIn("resolved", json.dumps(second))
        self.assertNotIn("fixed", json.dumps(second))
        _, third = self.complete([self.finding("Different title"), self.finding(path="renamed.py"), self.finding(evidence="return changed")])
        self.assertEqual(third["counts"]["repeated"], 0)

    def test_duplicate_prior_occurrences_are_not_silently_deduplicated(self):
        _, first = self.complete([self.finding(), self.finding()])
        self.assertNotEqual(first["findings"][0]["finding_id"], first["findings"][1]["finding_id"])
        self.assertEqual(first["findings"][0]["identity"], first["findings"][1]["identity"])
        _, next_checkpoint = self.complete([])
        self.assertEqual(next_checkpoint["counts"], {"total": 0, "new": 0, "repeated": 0, "not_observed": 2})

    def test_pinned_baseline_does_not_change_when_later_run_completes(self):
        _, first = self.complete()
        pending, result = self.source_run()
        _, later = self.complete([])
        self.assertNotEqual(first["id"], later["id"])
        self.store.finish(pending, result=result)
        completed = checkpoints.for_run(self.store, pending)
        self.assertEqual(completed["baseline_checkpoint_id"], first["id"])
        self.assertEqual(completed["counts"]["repeated"], 1)

    def test_whole_finding_omissions_keep_all_exact_identities(self):
        findings = [self.finding(f"Long finding {i}", evidence=(str(i) + "x" * 999)) for i in range(16)]
        _, first = self.complete(findings)
        snap = checkpoints.snapshot(self.store, self.job["id"])
        body = snap["checkpoint"]
        self.assertGreater(body["omitted_findings"], 0)
        self.assertEqual(body["total_findings"], 16)
        self.assertEqual(len(body["finding_identities"]), 16)
        self.assertEqual(body["findings"], first["findings"][:len(body["findings"])])
        self.assertLessEqual(len(checkpoints._encoded(snap, checkpoints.MAX_SNAPSHOT_BYTES)), 8192)
        self.assertEqual(checkpoints.validate_snapshot(snap), snap)
        _, second = self.complete(findings)
        self.assertEqual(second["counts"], {"total": 16, "new": 0, "repeated": 16, "not_observed": 0})

    def test_review_accept_dismiss_reopen_cas_history_and_no_context_promotion(self):
        run_id, checkpoint = self.complete()
        prior = checkpoints.snapshot(self.store, self.job["id"])
        for index, status in enumerate(("accepted", "dismissed", "open")):
            checkpoint = checkpoints.review_finding(self.store, run_id, 0, status, index, "device-one", "Explicit local review")
            self.assertEqual(checkpoint["findings"][0]["review"]["revision"], index + 1)
            self.assertEqual(checkpoint["findings"][0]["review"]["status"], status)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_finding_review_history").fetchone()[0], 3)
        self.assertEqual(ContextStore(self.registry).get(self.workspace["id"])["entries"], [])
        self.assertEqual(prior["checkpoint"]["findings"][0]["review"]["revision"], 0)
        self.assertEqual(checkpoints.validate_snapshot(prior), prior)
        self.assertEqual(checkpoint["counts"], {"total": 1, "new": 1, "repeated": 0, "not_observed": 0})

    def test_two_connection_stale_review_conflicts_without_losing_decision(self):
        run_id, _ = self.complete()
        with WorkspaceRegistry(self.registry.directory, clock=lambda: NOW) as second:
            checkpoints.review_finding(PipStore(second), run_id, 0, "dismissed", 0, "other", "Already assessed")
        with self.assertRaisesRegex(RegistryError, "changed"):
            checkpoints.review_finding(self.store, run_id, 0, "accepted", 0, "first", "Stale review")
        self.assertEqual(checkpoints.for_run(self.store, run_id)["findings"][0]["review"]["status"], "dismissed")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_finding_review_history").fetchone()[0], 1)

    def test_review_event_failure_rolls_back_review_and_history(self):
        run_id, first = self.complete()
        with patch.object(self.registry, "event", side_effect=RuntimeError("event failed")), self.assertRaises(RuntimeError):
            checkpoints.review_finding(self.store, run_id, 0, "accepted", 0, "device", "Review")
        self.assertEqual(checkpoints.for_run(self.store, run_id), first)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_finding_review_history").fetchone()[0], 0)

    def test_review_inputs_are_strict_and_do_not_mutate(self):
        run_id, first = self.complete()
        invalid = [(True, "accepted", 0, "device", "Reason"), (0, "accepted", True, "device", "Reason"),
                   (0, "resolved", 0, "device", "Reason"), (0, "accepted", 0, "device", ""),
                   (0, "accepted", 0, "bad\nactor", "Reason"), (0, "accepted", 0, "device", "\ud800"),
                   (0, "accepted", 0, "device", "x" * 1001), (15, "accepted", 0, "device", "Reason"),
                   (0, "open", 0, "device", "No change")]
        for args in invalid:
            with self.subTest(args=args), self.assertRaises(RegistryError):
                checkpoints.review_finding(self.store, run_id, *args)
        self.assertEqual(checkpoints.for_run(self.store, run_id), first)

    def test_history_pagination_and_cross_pip_cursor_rejection(self):
        first = self.complete()[1]
        middle = self.complete()[1]
        last = self.complete()[1]
        page = checkpoints.history(self.store, self.job["id"], limit=2)
        self.assertEqual([item["id"] for item in page["checkpoints"]], [last["id"], middle["id"]])
        self.assertTrue(page["has_more"])
        self.assertEqual(page["next_before_id"], middle["id"])
        self.assertTrue(all("findings" not in item for item in page["checkpoints"]))
        tail = checkpoints.history(self.store, self.job["id"], page["next_before_id"], 2)
        self.assertEqual([item["id"] for item in tail["checkpoints"]], [first["id"]])
        self.assertFalse(tail["has_more"])
        self.assertIsNone(tail["next_before_id"])
        other = self.new_pip()
        with self.assertRaisesRegex(RegistryError, "does not belong"):
            checkpoints.history(self.store, other["id"], first["id"])
        self.assertEqual(checkpoints.history(self.store, other["id"])["checkpoints"], [])

    def test_scope_digest_and_snapshot_shape_are_fail_closed(self):
        self.complete()
        snap = checkpoints.snapshot(self.store, self.job["id"])
        for kwargs in ({"pip_id": "pip_other"}, {"workspace_id": "ws_other"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(RegistryError):
                checkpoints.validate_snapshot(snap, **kwargs)
        mutations = [lambda v: v.update(digest="0" * 64), lambda v: v.update(schema_version=True),
                     lambda v: v.update(authority="sudo"), lambda v: v["checkpoint"].update(total_findings=0),
                     lambda v: v["checkpoint"]["findings"][0].update(evidence="changed")]
        for mutate in mutations:
            bad = copy.deepcopy(snap)
            mutate(bad)
            with self.assertRaises(RegistryError):
                checkpoints.validate_snapshot(bad)

    def test_snapshot_cross_workspace_and_cross_pip_manifest_is_refused(self):
        self.complete()
        other = self.new_pip()
        cross = checkpoints.snapshot(self.store, self.job["id"])
        run_id, result = self.source_run(job=other, manifest_changes={"audit_checkpoint": cross})
        with self.assertRaisesRegex(RegistryError, "different Pip"):
            self.store.finish(run_id, result=result)
        self.assertEqual(self.store.run(run_id)["status"], "running")

    def test_unknown_run_and_legacy_review_refuse(self):
        for operation in (lambda: checkpoints.for_run(self.store, "run_unknown"),
                          lambda: checkpoints.history(self.store, "pip_unknown")):
            with self.assertRaises(RegistryError):
                operation()
        legacy, _ = self.complete(legacy=True)
        with self.assertRaisesRegex(RegistryError, "no checked checkpoint"):
            checkpoints.review_finding(self.store, legacy, 0, "accepted", 0, "device", "Reason")

    def test_immutable_sql_records_and_review_history(self):
        run_id, checkpoint = self.complete()
        checkpoints.review_finding(self.store, run_id, 0, "accepted", 0, "device", "Reviewed")
        statements = ["UPDATE pip_checkpoints SET payload='{}'", "DELETE FROM pip_checkpoints",
                      "UPDATE pip_finding_reviews SET finding_index=1", "DELETE FROM pip_finding_reviews",
                      "UPDATE pip_finding_review_history SET reason='changed'", "DELETE FROM pip_finding_review_history"]
        for sql in statements:
            with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                self.registry.db.execute(sql)

    def test_stored_run_limit_checked_before_json_loading(self):
        run_id, _ = self.source_run(result={"huge": "x" * checkpoints.MAX_PAYLOAD_BYTES}, status="succeeded")
        with patch.object(checkpoints.json, "loads", side_effect=AssertionError("must not allocate parsed data")), self.assertRaises(RegistryError):
            checkpoints.for_run(self.store, run_id)

    def test_oversize_input_checked_before_encoding(self):
        class NoEncoding(str):
            def encode(self, *args, **kwargs):
                raise AssertionError("bound before encoding")
            def strip(self, *args, **kwargs):
                raise AssertionError("bound before normalization")
        run_id, _ = self.complete()
        with self.assertRaises(RegistryError):
            checkpoints.review_finding(self.store, run_id, 0, "accepted", 0, "device", NoEncoding("x" * 1001))

    def test_credentials_are_redacted_and_never_put_in_activity_payload(self):
        token = "sk-examplecredentialvalue123456"
        run_id, checkpoint = self.complete([self.finding(evidence="API_TOKEN=" + token)])
        self.assertNotIn(token, json.dumps(checkpoint))
        reviewed = checkpoints.review_finding(self.store, run_id, 0, "accepted", 0, "device", "API_TOKEN=" + token)
        self.assertNotIn(token, json.dumps(reviewed))
        events = self.registry.activity(self.workspace["id"])["events"]
        self.assertNotIn(token, json.dumps(events))
        self.assertNotIn("API_TOKEN", json.dumps(events))

    def test_history_limits_exact_integers(self):
        for cursor in (True, 0, -1, "1", 1.0, 2**63):
            with self.subTest(cursor=cursor), self.assertRaises(RegistryError):
                checkpoints.history(self.store, self.job["id"], cursor)
        for limit in (True, 0, 21, "2", 1.0):
            with self.subTest(limit=limit), self.assertRaises(RegistryError):
                checkpoints.history(self.store, self.job["id"], limit=limit)

    def test_result_preflight_accepts_only_bounded_native_metadata(self):
        value = self.report()
        value.update(usage={"input_tokens": 10, "output_tokens": 20, "requests": 2}, tools_called=2,
                     snapshot={"sha256": "b" * 64, "files": 3, "bytes": 80})
        self.assertEqual(json.loads(checkpoints.encode_result(value)), value)
        long_run = copy.deepcopy(value)
        long_run.update(tools_called=900)           # a run that keeps going reports its real count
        self.assertEqual(json.loads(checkpoints.encode_result(long_run))["tools_called"], 900)
        mutations = [lambda r: r.update(extra={"huge": "x" * 100000}),
                     lambda r: r.update(usage={"input_tokens": True}),
                     lambda r: r.update(usage={"unknown_field": 3}),
                     lambda r: r.update(tools_called=1_000_001), lambda r: r.update(tools_called=False),
                     lambda r: r["snapshot"].update(bytes=64 * 1024 * 1024 + 1),
                     lambda r: r.update(limitations=["x"] * 13),
                     lambda r: r.update(summary="\ud800"),
                     lambda r: r.update(summary="x" * 4001)]
        for mutation in mutations:
            invalid = copy.deepcopy(value)
            mutation(invalid)
            with self.assertRaises(RegistryError):
                checkpoints.encode_result(invalid)

    def test_valid_unicode_character_bounds_remain_supported(self):
        result = self.report([self.finding(title="語" * 200, evidence="語" * 1000)])
        result.update(summary="語" * 4000, limitations=["語" * 500])
        encoded = checkpoints.encode_result(result)
        self.assertEqual(json.loads(encoded), result)

    def test_checkpoint_recording_requires_transaction_and_authoritative_result(self):
        run_id, result = self.source_run(result=self.report(), status="succeeded")
        with self.assertRaisesRegex(RegistryError, "transaction"):
            checkpoints.record_completed(self.store, self.store.run(run_id), result)
        with self.registry.transaction(), self.assertRaisesRegex(RegistryError, "authoritative"):
            checkpoints.record_completed(self.store, self.store.run(run_id), self.report([]))

    def test_snapshot_does_not_commit_outer_transaction(self):
        self.complete()
        with self.assertRaisesRegex(RuntimeError, "abort outer"):
            with self.registry.transaction():
                self.registry.db.execute("INSERT INTO metadata VALUES('checkpoint-outer','pending')")
                checkpoints.snapshot(self.store, self.job["id"])
                self.assertTrue(self.registry.db.in_transaction)
                raise RuntimeError("abort outer")
        self.assertIsNone(self.registry.db.execute("SELECT value FROM metadata WHERE key='checkpoint-outer'").fetchone())

    def test_read_snapshot_keeps_review_revision_coherent_during_concurrent_commit(self):
        run_id, _ = self.complete()
        with WorkspaceRegistry(self.registry.directory, clock=lambda: NOW) as second:
            updated = False
            def trace(sql):
                nonlocal updated
                if not updated and sql.startswith("SELECT length(CAST(payload AS BLOB)) FROM pip_checkpoints"):
                    updated = True
                    checkpoints.review_finding(PipStore(second), run_id, 0, "accepted", 0, "second", "Concurrent decision")
            self.registry.db.set_trace_callback(trace)
            try:
                snap = checkpoints.snapshot(self.store, self.job["id"])
            finally:
                self.registry.db.set_trace_callback(None)
        self.assertTrue(updated)
        self.assertEqual(snap["checkpoint"]["findings"][0]["review"]["revision"], 0)
        self.assertEqual(checkpoints.snapshot(self.store, self.job["id"])["checkpoint"]["findings"][0]["review"]["revision"], 1)


if __name__ == "__main__":
    unittest.main()
