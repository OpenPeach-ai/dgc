"""Accepted Patch inputs stay immutable and isolated when reviewed for Pulse."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_artifacts, pip_execution, pip_execution_reviews as reviews, pip_handoffs as handoffs, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry, SCHEMA_VERSION, _execute_schema
from tests import test_pip_handoffs as fixtures


class ArtifactHandoffTests(unittest.TestCase):
    setUp = fixtures.PipHandoffTests.setUp
    git = fixtures.PipHandoffTests.git
    commit = fixtures.PipHandoffTests.commit
    setup_source = fixtures.PipHandoffTests.setup_source
    propose = fixtures.PipHandoffTests.propose
    accept = fixtures.PipHandoffTests.accept
    raw_manifest = fixtures.PipHandoffTests.raw_manifest
    control = fixtures.PipHandoffTests.control

    def completed_patch(self, *, accept=True):
        self.setup_source()
        self.target = self.store.create(self.workspace["id"], "Fixer", "Prepare the exact reviewed edit", "device", pip_type="patch")
        action = {"kind": "patch", "write_paths": ["source.py"], "tests": []}
        with patch.object(pip_execution, "capability", return_value={"available": True}):
            queued = self.accept(self.propose(action=action))["run"]
            self.store.claim_next()
            manifest = self.raw_manifest(queued["id"])
            self.patch_directory = self.registry.directory / "runs" / queued["id"]
            pips.clean_snapshot(self.root, manifest["source_revision"], self.patch_directory / "source")
            prepared = pip_execution.prepare_isolated_repo(self.patch_directory / "source", self.patch_directory)
        (Path(prepared["worktree"]) / "source.py").write_text("def hello():\n    return 'fixed'\n")
        changes = pip_execution.collect_artifacts(prepared, action)
        self.patch_run = self.store.finish(queued["id"], result={
            "summary": "Prepared the reviewed change", "verification": pip_execution.VERIFICATION,
            "tests_executed": False, "execution": {"changes": changes, "tests": []}})
        if accept:
            reviews.review(self.store, queued["id"], "accepted", 0, "device", "Inspected the diff")
        self.pulse = self.store.create(self.workspace["id"], "Verifier", "Verify reviewed changes", "device", pip_type="pulse")
        self.test_action = {"kind": "test", "tests": [{
            "argv": ["/usr/bin/python3", "-c", "import source; assert source.hello() == 'fixed'; print('Patched input passed')"],
            "cwd": "."}]}
        return self.patch_run

    def artifact_proposal(self, **changes):
        args = dict(source_run_id=self.patch_run["id"], target_pip_id=self.pulse["id"],
                    task="Verify the accepted Patch using these exact commands.", action=self.test_action,
                    idempotency_key="artifact-one", actor="device", config=self.cfg)
        args.update(changes)
        return handoffs.propose_artifact(self.store, **args)

    def approve_artifact(self, proposed):
        with patch.object(pip_execution, "capability", return_value={"available": True}):
            return self.accept(proposed)

    def test_proposal_pins_accepted_result_artifact_base_and_commands_without_dispatch(self):
        self.completed_patch()
        proposed = self.artifact_proposal()
        source = proposed["payload"]["source"]
        self.assertEqual(proposed["payload"]["type"], "patch_artifact.v1")
        self.assertIsNone(proposed["source_finding_id"])
        self.assertEqual(source["run_id"], self.patch_run["id"])
        self.assertEqual(source["artifact"], self.patch_run["result"]["execution"]["changes"]["artifact"])
        self.assertEqual(source["changed_files"], ["source.py"])
        self.assertEqual(source["result_digest"], reviews.for_run(self.store, self.patch_run["id"])["result_digest"])
        self.assertEqual(source["review_revision"], 1)
        self.assertEqual(source["source_revision"], self.patch_run["manifest"]["source_revision"])
        self.assertEqual(self.store.runs(self.pulse["id"]), [])
        self.assertEqual(self.artifact_proposal(), proposed)
        with self.assertRaises(RegistryError):
            self.artifact_proposal(task="Different task, same retry key")

    def test_source_requires_accepted_successful_patch_not_open_dismissed_audit_or_pulse(self):
        self.completed_patch(accept=False)
        with self.assertRaisesRegex(RegistryError, "accepted"):
            self.artifact_proposal()
        reviews.review(self.store, self.patch_run["id"], "dismissed", 0, "device", "Not ready")
        with self.assertRaises(RegistryError):
            self.artifact_proposal()
        with self.assertRaises(RegistryError):
            self.artifact_proposal(source_run_id=self.source_run["id"])
        with self.assertRaises(RegistryError):
            self.artifact_proposal(target_pip_id=self.target["id"])

    def test_changed_review_refuses_approval_and_queued_dispatch_but_retry_is_same_run(self):
        self.completed_patch()
        proposed = self.artifact_proposal()
        reviews.review(self.store, self.patch_run["id"], "open", 1, "device", "Review again")
        with self.assertRaises(RegistryError):
            self.approve_artifact(proposed)
        reviews.review(self.store, self.patch_run["id"], "accepted", 2, "device", "Accepted again")
        fresh = self.artifact_proposal(idempotency_key="fresh")
        accepted = self.approve_artifact(fresh)
        reviews.review(self.store, self.patch_run["id"], "dismissed", 3, "device", "Withdraw before dispatch")
        retried = self.approve_artifact(fresh)
        self.assertEqual(retried["run"]["id"], accepted["run"]["id"])
        manifest = self.raw_manifest(accepted["run"]["id"])
        with self.assertRaises(RegistryError):
            handoffs.artifact_input(self.store, manifest["handoff"], manifest)
        self.assertEqual(len(self.store.runs(self.pulse["id"])), 1)

    def test_corrupt_missing_symlink_and_hardlink_artifacts_refuse_before_enqueue(self):
        self.completed_patch()
        path = self.patch_directory / "artifacts/changes.patch"
        original = path.read_bytes()
        for mode in ("corrupt", "missing", "symlink", "hardlink", "oversize"):
            with self.subTest(mode=mode):
                path.unlink(missing_ok=True)
                other = self.patch_directory / "other.patch"
                other.unlink(missing_ok=True)
                other.write_bytes(original)
                if mode == "corrupt":
                    path.write_bytes(b"x" * len(original))
                elif mode == "symlink":
                    path.symlink_to(other)
                elif mode == "hardlink":
                    os.link(other, path)
                elif mode == "oversize":
                    with path.open("wb") as stream:
                        stream.truncate(pip_execution.MAX_DIFF_BYTES + 1)
                with self.assertRaises(RegistryError):
                    self.artifact_proposal(idempotency_key=mode)
                self.assertEqual(self.store.runs(self.pulse["id"]), [])
        path.unlink(missing_ok=True)
        path.write_bytes(original)
        self.assertEqual(self.artifact_proposal()["status"], "pending")

    def test_approval_uses_existing_atomic_queue_and_rolls_back_queue_failure(self):
        self.completed_patch()
        proposed = self.artifact_proposal()
        with patch.object(self.store, "enqueue", side_effect=RegistryError("busy", "Busy")), self.assertRaises(RegistryError):
            self.approve_artifact(proposed)
        self.assertEqual(handoffs.get(self.store, proposed["id"])["status"], "pending")
        queued = self.approve_artifact(proposed)["run"]
        self.assertEqual(queued["manifest"]["run_kind"], "test")
        self.assertEqual(queued["manifest"]["tools"], sorted(pips.READ_TOOLS))
        self.assertEqual(queued["manifest"]["handoff"]["payload"]["source"]["run_id"], self.patch_run["id"])

    def test_artifact_shape_rejects_forged_fields_boolean_revision_paths_and_targets(self):
        self.completed_patch()
        proposed = self.artifact_proposal()
        mutations = [
            lambda p: p["source"].update(review_revision=True),
            lambda p: p["source"].update(review_status="open"),
            lambda p: p["source"]["artifact"].update(path="../changes.patch"),
            lambda p: p["source"]["artifact"].update(bytes=True),
            lambda p: p["source"].update(changed_files=["../escape.py"]),
            lambda p: p["source"].update(changed_files=["source.py", "source.py"]),
            lambda p: p["target"].update(pip_type="patch"),
            lambda p: p["source"].update(result_digest="0"),
            lambda p: p["source"].update(url="https://example.invalid"),
        ]
        for mutate in mutations:
            value = copy.deepcopy(proposed["payload"])
            mutate(value)
            with self.assertRaises(RegistryError):
                handoffs.validate_payload(value)
        with self.assertRaises(RegistryError):
            self.artifact_proposal(action={"kind": "test", "tests": [], "network": True})

    def test_cross_workspace_and_changed_target_configuration_refused(self):
        self.completed_patch()
        other_root = self.root.parent / "other-workspace"
        other_root.mkdir()
        workspace = self.registry.resolve(other_root)
        other = self.store.create(workspace["id"], "Other", "Other", "device", pip_type="pulse")
        with self.assertRaises(RegistryError):
            self.artifact_proposal(target_pip_id=other["id"])
        proposed = self.artifact_proposal()
        self.cfg.data["model"] = "different"
        with self.assertRaises(RegistryError):
            self.approve_artifact(proposed)

    def test_control_schema_is_strict_and_history_keeps_finding_handoffs(self):
        self.completed_patch()
        response = self.control("propose_pip_artifact_handoff", source_run_id=self.patch_run["id"],
            target_pip_id=self.pulse["id"], task="Verify accepted patch", action=self.test_action, idempotency_key="control")
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"]["handoff"]["payload"]["type"], "patch_artifact.v1")
        self.assertFalse(self.control("propose_pip_artifact_handoff", source_run_id=self.patch_run["id"],
            target_pip_id=self.pulse["id"], task="Verify", action=self.test_action,
            idempotency_key="bad", source_finding_id="forged")["ok"])
        history = handoffs.history(self.store, self.target["id"])
        self.assertEqual({row["payload"]["type"] for row in history["handoffs"]}, {"audit_finding.v1", "patch_artifact.v1"})

    def test_reconstruction_checks_all_hunks_before_writes_and_pulse_has_no_own_edits(self):
        self.completed_patch()
        proposed = self.artifact_proposal()
        run = self.approve_artifact(proposed)["run"]
        manifest = self.raw_manifest(run["id"])
        directory = self.registry.directory / "runs" / run["id"]
        pips.clean_snapshot(self.root, manifest["source_revision"], directory / "source")
        with patch.object(pip_execution, "capability", return_value={"available": True}):
            prepared = pip_execution.prepare_isolated_repo(directory / "source", directory)
        source = proposed["payload"]["source"]
        data = handoffs.artifact_input(self.store, manifest["handoff"], manifest)
        root_before = (self.root / "source.py").read_bytes()
        pip_artifacts.apply_reviewed_patch(prepared, data, source["artifact"], source["changed_files"])
        self.assertIn("'fixed'", (Path(prepared["worktree"]) / "source.py").read_text())
        self.assertEqual((self.root / "source.py").read_bytes(), root_before)
        changes = pip_execution.collect_artifacts(prepared, self.test_action)
        self.assertEqual(changes["changed_files"], [])
        self.assertEqual(changes["artifact"]["bytes"], 0)

    def test_real_worker_and_bwrap_test_receive_the_patched_input(self):
        available = pip_execution.capability()
        if not available["available"]:
            self.skipTest(available["reason"])
        self.completed_patch()
        run = self.approve_artifact(self.artifact_proposal())["run"]
        row = self.store.claim_next()
        (self.root / "source.py").write_text("dirty_work = 'must remain unchanged'\n")
        original = (self.root / "source.py").read_bytes()
        fixture = r'''
import json
from unittest.mock import patch
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.pips import _worker_main
calls = 0
def chat(self, messages, tools=None, **kwargs):
 global calls
 calls += 1
 if calls == 1:
  return ChatResult(tool_calls=[ToolCall('read1','read_file',{'path':'source.py'})])
 assert 'fixed' in json.dumps(messages), 'Model did not receive patched source'
 return ChatResult(content='Inspected the accepted patched input. The controller will run the reviewed verification.')
with patch.object(LLMClient,'chat',chat), patch('requests.sessions.Session.request',side_effect=AssertionError('No provider network')):
 raise SystemExit(_worker_main())
'''
        original_spawn = subprocess.Popen
        def process(argv, *args, **kwargs):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", fixture]
            return original_spawn(argv, *args, **kwargs)
        with patch.object(pips.subprocess, "Popen", side_effect=process):
            result = pips._execute_run(self.registry, row, self.cfg)
        for mutate in (lambda r: r["execution"].pop("input"),
                       lambda r: r["execution"]["input"].update(artifact_sha256="0" * 64)):
            invalid = copy.deepcopy(result)
            mutate(invalid)
            with self.assertRaises(RegistryError):
                self.store.finish(run["id"], result=invalid)
            self.assertEqual(self.store.run(run["id"])["status"], "running")
        done = self.store.finish(run["id"], result=result)
        self.assertEqual(done["status"], "succeeded")
        self.assertEqual(done["result"]["execution"]["tests"][0]["status"], "passed")
        self.assertEqual(done["result"]["execution"]["changes"]["changed_files"], [])
        self.assertEqual(done["result"]["execution"]["input"]["source_run_id"], self.patch_run["id"])
        self.assertEqual((self.root / "source.py").read_bytes(), original)
        review = reviews.review(self.store, run["id"], "accepted", 0, "device", "Actual patched-input test passed")
        self.assertEqual(review["revision"], 1)

    def test_schema_six_migration_preserves_pending_finding_handoff_and_rolls_back(self):
        self.setup_source()
        proposed = self.propose()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "state"
            directory.mkdir(mode=0o700)
            with sqlite3.connect(directory / "registry.sqlite3") as db:
                self.registry.db.backup(db)
                for trigger in ("immutable_pip_handoff", "one_way_pip_handoff", "retain_pip_handoff"):
                    db.execute("DROP TRIGGER " + trigger)
                for index in ("pip_handoff_source_history", "pip_handoff_target_history"):
                    db.execute("DROP INDEX " + index)
                db.execute("ALTER TABLE pip_handoffs RENAME TO previous")
                _execute_schema(db, handoffs.SCHEMA)
                db.execute("INSERT INTO pip_handoffs SELECT * FROM previous")
                db.execute("DROP TABLE previous")
                from tests.pip_test_migrations import drop_archive_schema
                drop_archive_schema(db)
                for later_table in ("pip_memories", "pip_notifications", "pip_notification_seen", "pip_notification_state", "workspace_session_outcomes", "pip_lifecycle_requests", "session_pip_attachments", "pip_adaptations", "pip_commit_observations", "pip_event_trigger_state"):
                    db.execute("DROP TABLE " + later_table)
                db.execute("DROP INDEX pip_event_source")
                db.execute("PRAGMA user_version=6")
            original = handoffs.migrate_v7
            def fail(registry):
                original(registry)
                raise RuntimeError("Fixture migration failure")
            with patch.object(handoffs, "migrate_v7", side_effect=fail), self.assertRaises(RuntimeError):
                WorkspaceRegistry(directory, clock=lambda: self.now)
            with sqlite3.connect(directory / "registry.sqlite3") as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 6)
                self.assertEqual(db.execute("SELECT id FROM pip_handoffs").fetchone()[0], proposed["id"])
            # The fixture's clock, not today's: on the real clock the handoff's seven-day window had closed by 2026-10-08.
            with WorkspaceRegistry(directory, clock=lambda: self.now) as upgraded:
                self.assertEqual(upgraded.db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
                self.assertEqual(handoffs.get(pips.PipStore(upgraded), proposed["id"]), proposed)


class StrictPatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "source.py").write_bytes(b"one\ntwo\n")
        self.diff = b"diff --git a/source.py b/source.py\nindex 1111111..2222222 100644\n--- a/source.py\n+++ b/source.py\n@@ -1,2 +1,2 @@\n one\n-two\n+fixed\n"

    def test_regular_text_edit_add_delete_and_no_newline(self):
        plan = pip_artifacts._plan(self.root, self.diff, ["source.py"])
        self.assertEqual(plan[0][1], b"one\nfixed\n")
        added = b"diff --git a/new.py b/new.py\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+hello\n"
        self.assertEqual(pip_artifacts._plan(self.root, added, ["new.py"])[0][1], b"hello\n")
        deleted = b"diff --git a/source.py b/source.py\ndeleted file mode 100644\nindex 1234567..0000000\n--- a/source.py\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n"
        self.assertIsNone(pip_artifacts._plan(self.root, deleted, ["source.py"])[0][1])
        (self.root / "source.py").write_bytes(b"old")
        no_newline = b"diff --git a/source.py b/source.py\nindex 1111111..2222222 100644\n--- a/source.py\n+++ b/source.py\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n"
        self.assertEqual(pip_artifacts._plan(self.root, no_newline, ["source.py"])[0][1], b"new")

    def test_hostile_formats_and_unreviewed_paths_refused_without_source_writes(self):
        before = (self.root / "source.py").read_bytes()
        bad = [
            self.diff.replace(b"source.py", b"../outside"),
            self.diff.replace(b"source.py", b".git/config"),
            self.diff.replace(b"index 1111111..2222222 100644\n", b"old mode 100644\nnew mode 100755\n"),
            self.diff.replace(b"100644", b"120000"),
            self.diff.replace(b"100644", b"160000"),
            self.diff.replace(b"index 1111111..2222222 100644\n", b"rename from source.py\nrename to other.py\n"),
            self.diff.replace(b"index 1111111..2222222 100644\n", b"copy from source.py\ncopy to other.py\n"),
            self.diff.replace(b"--- a/source.py", b"--- /etc/passwd"),
            self.diff.replace(b"diff --git a/source.py b/source.py", b'diff --git "a/\\056\\056/outside" "b/\\056\\056/outside"'),
            self.diff.split(b"--- ")[0] + b"GIT binary patch\nliteral 999999999999\n",
            self.diff.replace(b"@@ -1,2 +1,2 @@", b"@@ -99999999,2 +1,2 @@"),
            self.diff.replace(b"-two", b"-different"),
            self.diff + self.diff,
            self.diff + b"garbage\n",
            self.diff[:-3],
        ]
        for data in bad:
            with self.subTest(data=data[:80]), self.assertRaises(RegistryError):
                pip_artifacts._plan(self.root, data, ["source.py"])
            self.assertEqual((self.root / "source.py").read_bytes(), before)

    def test_impossible_midfile_no_newline_marker_refused(self):
        bad = self.diff.replace(b" one\n", b" one\n\\ No newline at end of file\n")
        with self.assertRaises(RegistryError):
            pip_artifacts._plan(self.root, bad, ["source.py"])
        new_lines = self.diff.replace(b"+fixed\n", b"+first\n\\ No newline at end of file\n+second\n").replace(b"+1,2", b"+1,3")
        with self.assertRaisesRegex(RegistryError, "no-newline"):
            pip_artifacts._plan(self.root, new_lines, ["source.py"])

    def test_many_short_base_lines_refused_before_split_allocation(self):
        (self.root / "source.py").write_bytes(b"\n" * (pip_artifacts.MAX_SOURCE_LINES + 1))
        with self.assertRaisesRegex(RegistryError, "line reconstruction"):
            pip_artifacts._plan(self.root, self.diff, ["source.py"])

    def test_all_files_validated_before_any_private_write(self):
        run = self.root / "run"
        run.mkdir()
        root = run / "worktree"
        root.mkdir()
        (run / "private-git").mkdir()
        (root / "source.py").write_bytes(b"one\ntwo\n")
        (root / "other.py").write_bytes(b"one\ntwo\n")
        data = self.diff + self.diff.replace(b"source.py", b"other.py").replace(b"-two\n", b"-wrong\n")
        reference = {"path": "artifacts/changes.patch", "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        prepared = {"run_dir": str(run), "worktree": str(root), "git_dir": str(run / "private-git"), "baseline": "a" * 40}
        with self.assertRaises(RegistryError):
            pip_artifacts.apply_reviewed_patch(prepared, data, reference, ["other.py", "source.py"])
        self.assertEqual((root / "source.py").read_bytes(), b"one\ntwo\n")
        self.assertEqual((root / "other.py").read_bytes(), b"one\ntwo\n")

    def test_real_git_space_path_headers_use_exact_optional_tab_delimiter(self):
        path = self.root / "name with spaces.py"
        path.write_bytes(b"before\n")
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.root), "add", "--", path.name], check=True, capture_output=True)
        path.write_bytes(b"after\n")
        diff = subprocess.run(["git", "-C", str(self.root), "diff", "--no-ext-diff", "--no-textconv", "--", path.name],
                              check=True, capture_output=True).stdout
        path.write_bytes(b"before\n")
        plan = pip_artifacts._plan(self.root, diff, [path.name])
        self.assertEqual(plan[0][1], b"after\n")

    def test_new_parent_directories_count_before_any_mkdir_or_write(self):
        run = self.root / "run"
        run.mkdir()
        root = run / "worktree"
        root.mkdir()
        (run / "private-git").mkdir()
        (root / "source.py").write_bytes(b"base\n")
        data = b"diff --git a/nested/deeper/new.py b/nested/deeper/new.py\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/nested/deeper/new.py\n@@ -0,0 +1 @@\n+hello\n"
        reference = {"path": "artifacts/changes.patch", "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        prepared = {"run_dir": str(run), "worktree": str(root), "git_dir": str(run / "private-git"), "baseline": "a" * 40}
        with patch.object(pip_execution, "MAX_FILES", 2), self.assertRaisesRegex(RegistryError, "entry budget"):
            pip_artifacts.apply_reviewed_patch(prepared, data, reference, ["nested/deeper/new.py"])
        self.assertFalse((root / "nested").exists())
        self.assertEqual((root / "source.py").read_bytes(), b"base\n")


if __name__ == "__main__":
    unittest.main()
