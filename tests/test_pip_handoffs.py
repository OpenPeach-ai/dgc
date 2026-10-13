"""Offline source-bound handoff reviews and existing-queue integration tests."""
from __future__ import annotations

import copy
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_checkpoints, pip_execution, pip_handoffs as handoffs, pips
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.workspace_registry import RegistryError, WorkspaceRegistry, SCHEMA_VERSION
from tests import test_pips_local as fixtures


class PipHandoffTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setup_source(self):
        self.commit()
        self.now = "2026-10-01T10:00:00.000Z"
        self.registry.clock = lambda: self.now
        self.source = self.store.create(self.workspace["id"], "Source reviewer", "Inspect source", "device")
        self.target = self.store.create(self.workspace["id"], "Target researcher", "Investigate findings", "device", pip_type="lens")
        queued = self.store.enqueue(self.source["id"], "source-audit", "device", self.cfg)
        self.store.claim_next()
        report = pips.validate_report(json.dumps({"summary": "Reviewed source", "findings": [
            {"title": "Assess return value", "severity": "low", "path": "source.py", "line": 2,
             "evidence": "    return 'hello'"}], "limitations": ["Source only"]}), self.root, read_calls=1)
        self.source_run = self.store.finish(queued["id"], result=report)

    def propose(self, **changes):
        args = dict(source_run_id=self.source_run["id"], finding_index=0, target_pip_id=self.target["id"],
                    task="Investigate this finding using the approved job.", action={"kind": "read_only"},
                    idempotency_key="handoff-one", actor="device", config=self.cfg)
        args.update(changes)
        return handoffs.propose(self.store, **args)

    def accept(self, proposed, **changes):
        args = dict(handoff_id=proposed["id"], expected_revision=0, actor="device", config=self.cfg)
        args.update(changes)
        return handoffs.accept(self.store, **args)

    def raw_manifest(self, run_id):
        return json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run_id,)).fetchone()[0])

    def control(self, command, **fields):
        with patch.object(pips, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory, clock=lambda: self.now)):
            return pips.handle_control(self.cfg, {"type": command, "request_id": "fixture-request", **fields}, "device", start_worker=False)

    def test_proposal_is_source_bound_and_does_not_dispatch(self):
        self.setup_source()
        proposed = self.propose()
        self.assertEqual(proposed["status"], "pending")
        self.assertEqual(proposed["revision"], 0)
        self.assertIsNone(proposed["run_id"])
        self.assertIsNone(proposed["run_status"])
        self.assertEqual(proposed["payload"]["source"]["run_id"], self.source_run["id"])
        self.assertEqual(proposed["payload"]["target"]["model"], "fixture")
        self.assertNotIn("base_url", json.dumps(proposed))
        self.assertEqual(self.store.runs(self.target["id"]), [])
        self.assertEqual(handoffs.validate_payload(proposed["payload"]), proposed["payload"])

    def test_finding_acceptance_never_implicitly_creates_handoff(self):
        self.setup_source()
        pip_checkpoints.review_finding(self.store, self.source_run["id"], 0, "accepted", 0, "device", "Useful assessment")
        self.assertEqual(handoffs.history(self.store, self.source["id"])["handoffs"], [])
        self.assertEqual(self.store.runs(self.target["id"]), [])

    def test_proposal_retry_is_exact_and_changed_content_conflicts(self):
        self.setup_source()
        first = self.propose()
        self.assertEqual(self.propose(), first)
        with self.assertRaisesRegex(RegistryError, "different work"):
            self.propose(task="Different requested work")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_handoffs").fetchone()[0], 1)

    def test_accept_atomically_creates_one_existing_queue_run(self):
        self.setup_source()
        proposed = self.propose()
        result = self.accept(proposed)
        approved, run = result["handoff"], result["run"]
        self.assertEqual(approved["status"], "accepted")
        self.assertEqual(approved["revision"], 1)
        self.assertEqual(approved["run_id"], run["id"])
        self.assertEqual(approved["run_status"], "queued")
        self.assertEqual(run["id"], handoffs._reserved_run_id(proposed["id"]))
        self.assertEqual(run["manifest"]["trigger"], "handoff")
        self.assertEqual(run["manifest"]["run_kind"], "audit")
        self.assertEqual(run["manifest"]["tools"], sorted(pips.READ_TOOLS))
        self.assertEqual(run["manifest"]["handoff"]["payload"], proposed["payload"])
        self.assertEqual(handoffs.validate_manifest(self.raw_manifest(run["id"])["handoff"], self.raw_manifest(run["id"])),
                         self.raw_manifest(run["id"])["handoff"])
        self.assertEqual(len(self.store.runs(self.target["id"])), 1)

    def test_exact_accept_retry_survives_changed_configuration_source_and_cancellation(self):
        self.setup_source()
        proposed = self.propose()
        first = self.accept(proposed)
        self.store.cancel(first["run"]["id"], "device")
        self.cfg.data["model"] = "different"
        with patch.object(pips, "source_revision", side_effect=AssertionError("exact retry must not resolve a new source")):
            repeated = self.accept(proposed)
        self.assertEqual(repeated["run"]["id"], first["run"]["id"])
        self.assertEqual(repeated["run"]["status"], "cancelled")
        with self.assertRaises(RegistryError):
            self.accept(proposed, actor="other-device")
        self.assertEqual(len(self.store.runs(self.target["id"])), 1)

    def test_queue_failure_rolls_back_approval_reservation_and_events(self):
        self.setup_source()
        proposed = self.propose()
        count = self.registry.db.execute("SELECT count(*) FROM workspace_events").fetchone()[0]
        with patch.object(self.store, "enqueue", side_effect=RegistryError("limit", "queue full")), self.assertRaises(RegistryError):
            self.accept(proposed)
        self.assertEqual(handoffs.get(self.store, proposed["id"])["status"], "pending")
        self.assertEqual(self.store.runs(self.target["id"]), [])
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_events").fetchone()[0], count)

    def test_event_failure_after_run_insert_rolls_back_both_records(self):
        self.setup_source()
        proposed = self.propose()
        original = self.registry.event
        def event(workspace, kind, **kwargs):
            if kind == "pip_run_queued":
                raise RuntimeError("fixture queue event failed")
            return original(workspace, kind, **kwargs)
        with patch.object(self.registry, "event", side_effect=event), self.assertRaises(RuntimeError):
            self.accept(proposed)
        self.assertEqual(handoffs.get(self.store, proposed["id"])["status"], "pending")
        self.assertEqual(self.store.runs(self.target["id"]), [])

    def test_deferred_foreign_key_prevents_accepted_without_target_run(self):
        self.setup_source()
        proposed = self.propose()
        with self.assertRaises(sqlite3.IntegrityError):
            with self.registry.transaction():
                row = handoffs._row(self.store, proposed["id"])
                handoffs._resolve(self.store, row, "accepted", "device", self.now,
                                  run_id=handoffs._reserved_run_id(proposed["id"]))
        self.assertEqual(handoffs.get(self.store, proposed["id"])["status"], "pending")

    def test_stale_target_job_model_connection_and_source_refuse(self):
        self.setup_source()
        proposed = self.propose()
        for key, value in (("model", "new-model"), ("base_url", "http://other.invalid/v1"), ("api_mode", "responses")):
            before = self.cfg.data[key]
            self.cfg.data[key] = value
            with self.subTest(key=key), self.assertRaises(RegistryError):
                self.accept(proposed)
            self.cfg.data[key] = before
        revision = self.store.propose(self.target["id"], 1, {"goal": "Changed target job"}, "device")
        self.store.accept(self.target["id"], revision["id"], 1, "device")
        with self.assertRaisesRegex(RegistryError, "changed"):
            self.accept(proposed)
        self.assertEqual(handoffs.get(self.store, proposed["id"])["status"], "pending")

    def test_changed_finding_review_invalidates_pending_handoff(self):
        self.setup_source()
        proposed = self.propose()
        pip_checkpoints.review_finding(self.store, self.source_run["id"], 0, "dismissed", 0, "device", "Not convincing")
        with self.assertRaisesRegex(RegistryError, "changed"):
            self.accept(proposed)
        self.assertEqual(self.store.runs(self.target["id"]), [])

    def test_source_branch_advance_requires_fresh_audit(self):
        self.setup_source()
        proposed = self.propose()
        (self.root / "later.py").write_text("value = 2\n")
        self.git("add", "later.py")
        self.git("commit", "-qm", "later")
        with self.assertRaisesRegex(RegistryError, "advanced"):
            self.accept(proposed)
        with self.assertRaisesRegex(RegistryError, "advanced"):
            self.propose(idempotency_key="new-key")

    def test_cross_workspace_self_and_unknown_source_refuse(self):
        self.setup_source()
        other_root = self.base / "other"
        other_root.mkdir()
        other_workspace = self.registry.resolve(other_root)
        other = self.store.create(other_workspace["id"], "Other", "Review", "device")
        for target in (other["id"], self.source["id"]):
            with self.subTest(target=target), self.assertRaises(RegistryError):
                self.propose(target_pip_id=target)
        with self.assertRaises(RegistryError):
            self.propose(source_run_id="run_missing")
        with self.assertRaises(RegistryError):
            self.propose(finding_index=1)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_handoffs").fetchone()[0], 0)

    def test_paused_target_or_global_stop_cannot_dispatch(self):
        self.setup_source()
        proposed = self.propose()
        self.store.set_paused(self.target["id"], True, "device")
        with self.assertRaisesRegex(RegistryError, "Resume"):
            self.accept(proposed)
        self.store.set_paused(self.target["id"], False, "device")
        with patch("dgc.pip_daemon.is_runtime_paused", return_value=True), self.assertRaises(RegistryError):
            self.accept(proposed)
        self.assertEqual(handoffs.get(self.store, proposed["id"])["status"], "pending")

    def test_expiry_is_durable_and_no_late_acceptance(self):
        self.setup_source()
        proposed = self.propose()
        self.now = proposed["expires_at"]
        with self.assertRaises(RegistryError) as caught:
            self.accept(proposed)
        self.assertEqual(caught.exception.code, "expired")
        expired = handoffs.get(self.store, proposed["id"])
        self.assertEqual(expired["status"], "expired")
        self.assertEqual(expired["revision"], 1)
        self.assertIsNone(expired["run_id"])

    def test_rejection_has_provenance_idempotent_retry_and_no_dispatch(self):
        self.setup_source()
        proposed = self.propose()
        first = handoffs.reject(self.store, proposed["id"], 0, "device", "Scope needs review")
        self.assertEqual(first["status"], "rejected")
        self.assertEqual(first["resolution_reason"], "Scope needs review")
        self.assertEqual(handoffs.reject(self.store, proposed["id"], 0, "device", "Scope needs review"), first)
        with self.assertRaises(RegistryError):
            handoffs.reject(self.store, proposed["id"], 0, "other", "Different decision")
        with self.assertRaises(RegistryError):
            self.accept(proposed)
        self.assertEqual(self.store.runs(self.target["id"]), [])

    def test_separate_connection_decision_conflicts(self):
        self.setup_source()
        proposed = self.propose()
        with WorkspaceRegistry(self.registry.directory, clock=lambda: self.now) as other:
            handoffs.reject(pips.PipStore(other), proposed["id"], 0, "other", "Reviewed elsewhere")
        with self.assertRaises(RegistryError):
            self.accept(proposed)
        self.assertEqual(handoffs.get(self.store, proposed["id"])["resolved_by"], "other")

    def test_history_scopes_both_participants_and_rejects_foreign_cursor(self):
        self.setup_source()
        first = self.propose()
        self.now = "2026-10-01T10:01:00.000Z"
        second = self.propose(idempotency_key="second")
        page = handoffs.history(self.store, self.target["id"], limit=1)
        self.assertEqual([h["id"] for h in page["handoffs"]], [second["id"]])
        self.assertEqual(page["next_before_id"], second["id"])
        tail = handoffs.history(self.store, self.target["id"], page["next_before_id"], 1)
        self.assertEqual([h["id"] for h in tail["handoffs"]], [first["id"]])
        self.assertFalse(tail["has_more"])
        self.assertIsNone(tail["next_before_id"])
        self.assertEqual(len(handoffs.history(self.store, self.source["id"])["handoffs"]), 2)
        unrelated = self.store.create(self.workspace["id"], "Unrelated", "Inspect", "device")
        with self.assertRaises(RegistryError):
            handoffs.history(self.store, unrelated["id"], first["id"])
        self.assertEqual(handoffs.history(self.store, unrelated["id"])["handoffs"], [])

    def test_malformed_input_and_extra_permissions_are_refused(self):
        self.setup_source()
        for changes in ({"finding_index": True}, {"task": "\ud800"}, {"task": "x" * 4001},
                        {"idempotency_key": "spaces not allowed"}, {"action": {"kind": "read_only", "network": True}},
                        {"action": {"kind": "patch", "write_paths": ["../outside"], "tests": []}}):
            with self.subTest(changes=changes), self.assertRaises(RegistryError):
                self.propose(**changes)
        for revision in (True, -1, 2, None, "0"):
            with self.assertRaises(RegistryError):
                handoffs.accept(self.store, "unused", revision, "device", self.cfg)

    def test_source_payload_and_target_run_pin_are_tamper_evident(self):
        self.setup_source()
        accepted = self.accept(self.propose())
        manifest = self.raw_manifest(accepted["run"]["id"])
        for mutate in (lambda m: m.update(pip_id=self.source["id"]), lambda m: m.update(source_revision="f" * 40),
                       lambda m: m.update(model="other"), lambda m: m["handoff"]["payload"]["source"].update(evidence="changed"),
                       lambda m: m["handoff"].update(digest="0" * 64)):
            changed = copy.deepcopy(manifest)
            mutate(changed)
            with self.assertRaises(RegistryError):
                handoffs.validate_manifest(changed["handoff"], changed)

    def test_immutable_payload_and_one_way_decision_triggers(self):
        self.setup_source()
        proposed = self.propose()
        with self.assertRaises(sqlite3.IntegrityError):
            self.registry.db.execute("UPDATE pip_handoffs SET payload='{}'")
        handoffs.reject(self.store, proposed["id"], 0, "device", "Reviewed")
        for sql in ("UPDATE pip_handoffs SET resolved_by='other'", "DELETE FROM pip_handoffs"):
            with self.assertRaises(sqlite3.IntegrityError):
                self.registry.db.execute(sql)

    def test_stored_payload_size_is_checked_before_json_parse(self):
        self.setup_source()
        proposed = self.propose()
        self.registry.db.execute("DROP TRIGGER immutable_pip_handoff")
        self.registry.db.execute("PRAGMA ignore_check_constraints=ON")
        self.registry.db.execute("UPDATE pip_handoffs SET payload=? WHERE id=?", ("x" * (handoffs.MAX_PAYLOAD_BYTES + 1), proposed["id"]))
        with patch.object(handoffs.json, "loads", side_effect=AssertionError("must not parse oversized stored data")), self.assertRaises(RegistryError):
            handoffs.get(self.store, proposed["id"])

    def test_controller_shapes_and_extra_fields(self):
        self.setup_source()
        response = self.control("propose_pip_handoff", source_run_id=self.source_run["id"], finding_index=0,
            target_pip_id=self.target["id"], task="Investigate", action={"kind": "read_only"}, idempotency_key="control")
        self.assertTrue(response["ok"], response)
        proposed = response["result"]["handoff"]
        denied = self.control("accept_pip_handoff", handoff_id=proposed["id"], expected_revision=0, workspace_id="forged")
        self.assertFalse(denied["ok"])
        accepted = self.control("accept_pip_handoff", handoff_id=proposed["id"], expected_revision=0)
        self.assertTrue(accepted["ok"], accepted)
        self.assertEqual(accepted["result"]["run"]["id"], accepted["result"]["handoff"]["run_id"])
        listed = self.control("list_pip_handoffs", pip_id=self.target["id"])
        self.assertEqual(len(listed["result"]["handoffs"]), 1)

    def test_task_redaction_and_action_credentials_rejected(self):
        self.setup_source()
        secret = "sk-knownfixturecredential123456"
        self.cfg.data["api_key"] = secret
        proposed = self.propose(task="Investigate " + secret)
        self.assertNotIn(secret, json.dumps(proposed))
        pulse = self.store.create(self.workspace["id"], "Tester", "Review tests", "device", pip_type="pulse")
        with self.assertRaisesRegex(RegistryError, "credentials"):
            self.propose(target_pip_id=pulse["id"], idempotency_key="secret-action", action={"kind": "test",
                         "tests": [{"argv": ["/usr/bin/printf", secret], "cwd": "."}]})

    def test_patch_and_pulse_need_separately_reviewed_actions(self):
        self.setup_source()
        with patch.object(pip_execution, "capability", return_value={"available": True}):
            for pip_type, action, kind in (("patch", {"kind": "patch", "write_paths": ["source.py"], "tests": []}, "patch"),
                ("pulse", {"kind": "test", "tests": [{"argv": ["/usr/bin/python3", "-m", "unittest"], "cwd": "."}]}, "test")):
                job = self.store.create(self.workspace["id"], pip_type, "Reviewed isolated task", "device", pip_type=pip_type)
                self.assertEqual(job["policy"], "review_required")
                with self.assertRaisesRegex(RegistryError, "handoff you approve"):
                    self.store.enqueue(job["id"], "direct", "device", self.cfg)
                with self.assertRaisesRegex(RegistryError, "schedule"):
                    self.store.propose(job["id"], 1, {"schedule": {"type": "interval", "minutes": 60}}, "device")
                proposed = self.propose(target_pip_id=job["id"], action=action, idempotency_key=pip_type)
                approved = self.accept(proposed)
                self.assertEqual(approved["run"]["manifest"]["run_kind"], kind)
                self.assertNotIn("audit_checkpoint", approved["run"]["manifest"])
                self.assertNotIn("bash", approved["run"]["manifest"]["tools"])
                if pip_type == "patch":
                    self.assertEqual(set(approved["run"]["manifest"]["tools"]), pips.READ_TOOLS | pip_execution.WRITE_TOOLS)

    def test_execution_capability_failure_keeps_handoff_pending(self):
        self.setup_source()
        job = self.store.create(self.workspace["id"], "Fixer", "Reviewed fix", "device", pip_type="patch")
        proposed = self.propose(target_pip_id=job["id"], action={"kind": "patch", "write_paths": ["source.py"], "tests": []})
        with patch.object(pip_execution, "capability", return_value={"available": False, "reason": "Sandbox unavailable"}), self.assertRaisesRegex(RegistryError, "Sandbox unavailable"):
            self.accept(proposed)
        self.assertEqual(handoffs.get(self.store, proposed["id"])["status"], "pending")
        self.assertEqual(self.store.runs(job["id"]), [])

    def test_readonly_handoff_enters_existing_native_agent_without_new_tools(self):
        self.setup_source()
        approved = self.accept(self.propose())
        manifest = self.raw_manifest(approved["run"]["id"])
        answers = iter([ChatResult(tool_calls=[ToolCall("read1", "read_file", {"path": "source.py"})]),
                        ChatResult(content=json.dumps({"summary": "Second inspection", "findings": [], "limitations": ["Source only"]}))])
        prompts = []
        def chat(client, messages, tools=None, **kwargs):
            prompts.append(copy.deepcopy(messages))
            self.assertFalse(any(t["function"]["name"] in pip_execution.WRITE_TOOLS | {"bash", "task"} for t in tools))
            return next(answers)
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", chat), patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        self.assertEqual(result["summary"], "Second inspection")
        self.assertIn("Separately reviewed handoff task", json.dumps(prompts))
        self.assertIn("untrusted model assessment", json.dumps(prompts))

    def test_rejection_rechecks_expiry_after_preview_before_resolution(self):
        self.setup_source()
        proposal = self.propose()
        times = iter(["2026-10-08T09:59:59.000Z", "2026-10-08T10:00:00.000Z"])
        self.registry.clock = lambda: next(times, "2026-10-08T10:00:00.000Z")
        with self.assertRaisesRegex(RegistryError, "window ended"):
            handoffs.reject(self.store, proposal["id"], 0, "device", "Too late")
        row = self.registry.db.execute("SELECT status,resolved_by FROM pip_handoffs WHERE id=?", (proposal["id"],)).fetchone()
        self.assertEqual(tuple(row), ("expired", "expiry"))

    def test_execution_capability_control_uses_no_workspace_or_permission_mutation(self):
        self.setup_source()
        expected = {"available": False, "reason": "Fixture capability unavailable", "backend": None}
        with patch.object(pip_execution, "capability", return_value=expected), \
             patch.object(WorkspaceRegistry, "resolve", side_effect=AssertionError("No workspace required")):
            response = self.control("get_pip_execution")
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"], expected)
        self.assertFalse(self.control("get_pip_execution", workspace_id=self.workspace["id"])["ok"])

    def test_schema_five_upgrade_preserves_existing_audit_and_rolls_back_failure(self):
        from dgc import pip_execution_reviews
        self.setup_source()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "registry"
            directory.mkdir(mode=0o700)
            path = directory / "registry.sqlite3"
            with sqlite3.connect(path) as copied:
                self.registry.db.backup(copied)
                copied.execute("DROP TABLE pip_handoffs")
                copied.execute("DROP TABLE pip_execution_reviews")
                from tests.pip_test_migrations import drop_archive_schema
                drop_archive_schema(copied)
                for later_table in ("pip_memories", "pip_notifications", "pip_notification_seen", "pip_notification_state", "workspace_session_outcomes", "pip_lifecycle_requests", "session_pip_attachments", "pip_adaptations", "pip_commit_observations", "pip_event_trigger_state"):
                    copied.execute("DROP TABLE " + later_table)
                copied.execute("DROP INDEX pip_event_source")
                copied.execute("PRAGMA user_version=5")
            with patch.object(pip_execution_reviews, "SCHEMA", pip_execution_reviews.SCHEMA + "\nINVALID SQL;"), \
                 self.assertRaises(sqlite3.OperationalError):
                WorkspaceRegistry(directory)
            with sqlite3.connect(path) as copied:
                self.assertEqual(copied.execute("PRAGMA user_version").fetchone()[0], 5)
                self.assertIsNone(copied.execute("SELECT name FROM sqlite_master WHERE name='pip_handoffs'").fetchone())
                self.assertIsNone(copied.execute("SELECT name FROM sqlite_master WHERE name='pip_execution_reviews'").fetchone())
            with WorkspaceRegistry(directory) as upgraded:
                self.assertEqual(upgraded.db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
                self.assertEqual(pips.PipStore(upgraded).run(self.source_run["id"])["status"], "succeeded")
                self.assertEqual(upgraded.db.execute("SELECT count(*) FROM pip_handoffs").fetchone()[0], 0)
                self.assertEqual(upgraded.db.execute("SELECT count(*) FROM pip_execution_reviews").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
