"""Quill uses the existing local CLI with explicit draft meaning."""
import unittest
from unittest.mock import patch

from dgc import pip_cli, pip_drafts, pips
from tests import test_pip_cli as fixtures


class DraftCliTests(unittest.TestCase):
    setUp = fixtures.PipCliTests.setUp
    invoke = fixtures.PipCliTests.invoke
    value = fixtures.PipCliTests.value
    git = fixtures.PipCliTests.git
    commit = fixtures.PipCliTests.commit
    heartbeat = fixtures.PipCliTests.heartbeat
    hold_supervisor = fixtures.PipCliTests.hold_supervisor
    child_env = fixtures.PipCliTests.child_env
    child_cli = fixtures.PipCliTests.child_cli

    def test_actual_console_lists_creates_and_queues_manual_quill(self):
        self.commit()
        self.child_cli("enable")
        types = self.child_cli("types")["types"]
        quill = next(row for row in types if row["id"] == "quill")
        self.assertTrue(quill["available"])
        job = self.child_cli("create", "Documentation", "--goal", "Explain the source", "--type", "quill")["pip"]
        self.assertEqual(job["policy"], "read_only")
        self.hold_supervisor()
        run = self.child_cli("run", job["id"], "--idempotency-key", "draft-cli")["run"]
        self.assertEqual(run["manifest"]["run_kind"], "draft")
        self.assertEqual(run["manifest"]["tools"], sorted(pips.READ_TOOLS))
        self.assertEqual(self.child_cli("report", run["id"])["run"]["status"], "queued")

    def test_cli_schedule_proposes_quill_without_arming_or_worker(self):
        job = self.value("create", "Documentation", "--goal", "Explain source", "--type", "quill")["pip"]
        with patch.object(pips, "start_queued", side_effect=AssertionError("No worker")):
            result = self.value("schedule", job["id"], "--every", "30", "--expected-version", "1")
        self.assertEqual(result['proposal']['status'], 'proposed')
        self.assertIsNone(self.store.get(job['id'])['schedule'])
        self.assertEqual(self.store.runs(job['id']), [])

    def test_formatter_distinguishes_private_draft_from_audit_or_execution(self):
        run = {"id": "run_fixture", "pip_id": "pip_fixture", "status": "succeeded",
               "manifest": {"run_kind": "draft", "job_version": 1, "model": "fixture", "source_revision": "a" * 40},
               "result": {"title": "Hello", "summary": "Documentation draft", "verification": pip_drafts.VERIFICATION,
                          "draft": {"markdown": "# Draft\nExample prose.", "citations": [{"path": "source.py", "line": 1, "excerpt": "def hello():"}],
                                    "artifact": {"path": pip_drafts.ARTIFACT_PATH, "sha256": "a" * 64, "bytes": 23}}}}
        text = pip_cli._format({"run": run})
        self.assertIn("not applied", text)
        self.assertIn("Example prose.", text)
        self.assertIn("source.py:1", text)
        self.assertIn("SHA256:", text)
        self.assertNotIn("read-only audit", text)
        self.assertNotIn("Exact diff", text)
