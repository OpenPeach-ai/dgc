"""Core/CLI/worker checkpoint integration. No live provider, network or sleeps."""
import json
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_cli, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class CheckpointIntegrationTests(unittest.TestCase):
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.commit()
        guard = patch("requests.sessions.Session.request", side_effect=AssertionError("No network"))
        guard.start(); self.addCleanup(guard.stop)

    def completed(self, job, key):
        run = self.store.enqueue(job["id"], key, "device_1", self.cfg)
        self.store.claim_next()
        result = pips.validate_report(json.dumps({"summary": "Inspected fixture", "findings": [{
            "title": "Review return value", "severity": "low", "path": "source.py",
            "line": 2, "evidence": "    return 'hello'"}], "limitations": ["Source only"]}),
            self.root, read_calls=1)
        return self.store.finish(run["id"], result=result)

    def control(self, request):
        with patch("dgc.workspace_registry.state_directory", return_value=self.registry.directory):
            return pips.handle_control(self.cfg, {"request_id": "fixture-control", **request}, "review-device", start_worker=False)

    def test_cli_requests_keep_schedule_changes_reviewed_and_exact(self):
        for args, schedule in [
            (["--once", "2026-10-02T09:00:00+05:30"],
             {"type": "once", "at": "2026-10-02T09:00:00+05:30"}),
            (["--cron", "0 2 * * 1-5", "--timezone", "Asia/Kolkata"],
             {"type": "cron", "cron": "0 2 * * 1-5", "timezone": "Asia/Kolkata"})]:
            parsed = pip_cli.parser().parse_args(["schedule", "pip-example", "--expected-version", "1", *args])
            request = pip_cli._request(parsed)
            self.assertEqual(request["type"], "propose_pip_update")
            self.assertEqual(request["changes"], {"schedule": schedule})
        for args in (["--cron", "0 2 * * *"], ["--once", "2026-10-02T00:00:00Z", "--timezone", "UTC"]):
            parsed = pip_cli.parser().parse_args(["schedule", "pip-x", "--expected-version", "1", *args])
            with self.assertRaises(RegistryError):
                pip_cli._request(parsed)

    def test_checkpoint_get_review_and_next_run_pin_are_connected(self):
        job = self.create()
        first = self.completed(job, "first")
        response = self.control({"type": "get_pip_run", "run_id": first["id"]})
        self.assertTrue(response["ok"], response)
        checkpoint = response["result"]["run"]["checkpoint"]
        self.assertEqual(checkpoint["counts"]["new"], 1)
        review = {"type": "review_pip_finding", "run_id": first["id"], "finding_index": 0,
                  "status": "dismissed", "expected_revision": 0, "reason": "Known fixture behavior"}
        response = self.control(review)
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"]["checkpoint"]["findings"][0]["review"]["revision"], 1)
        self.assertFalse(self.control(review)["ok"])
        next_run = self.store.enqueue(job["id"], "second", "device_1", self.cfg)
        pin = next_run["manifest"]["audit_checkpoint"]
        self.assertEqual(pin["checkpoint"]["id"], checkpoint["id"])
        self.assertEqual(pin["checkpoint"]["findings"][0]["review"]["status"], "dismissed")
        self.control({**review, "status": "open", "expected_revision": 1, "reason": "Review again"})
        self.assertEqual(self.store.run(next_run["id"])["manifest"]["audit_checkpoint"], pin)
        listing = self.control({"type": "list_pip_checkpoints", "pip_id": job["id"], "limit": 1})
        self.assertEqual(listing["result"]["checkpoints"][0]["run_id"], first["id"])
        from dgc import pip_context_tool
        with patch("dgc.workspace_registry.state_directory", return_value=self.registry.directory):
            read = json.loads(pip_context_tool.read({"action": "report", "run_id": first["id"]},
                SimpleNamespace(config=self.cfg, project_root=self.root)))
        self.assertEqual(read["findings"][0]["review"]["status"], "open")
        self.assertEqual(read["checkpoint"]["id"], checkpoint["id"])

    def test_review_reason_redaction_precedes_persistence_and_disabled_controls_refuse(self):
        job = self.create(); run = self.completed(job, "first")
        secret = "fixture-secret-that-must-stay-private"
        self.cfg.set("api_key", secret, persist=False)
        response = self.control({"type": "review_pip_finding", "run_id": run["id"], "finding_index": 0,
            "status": "accepted", "expected_revision": 0, "reason": "Context fixture-secret-that-must-stay-private"})
        self.assertTrue(response["ok"], response)
        self.assertFalse(any(secret in line for line in self.registry.db.iterdump()), "A configured credential reached checkpoint storage")
        self.cfg.data["pips_enabled"] = False
        response = self.control({"type": "list_pip_checkpoints", "pip_id": job["id"]})
        self.assertEqual(response["error"]["code"], "disabled")

    def test_failed_checkpoint_commit_rolls_back_terminal_result(self):
        job = self.create(); run = self.store.enqueue(job["id"], "first", "device_1", self.cfg)
        self.store.claim_next()
        report = pips.validate_report(json.dumps({"summary": "Valid report before checkpoint failure",
            "findings": [], "limitations": ["Fixture source only"]}), self.root, read_calls=1)
        with patch("dgc.pip_checkpoints.record_completed", side_effect=RegistryError("limit", "fixture")) as record:
            with self.assertRaises(RegistryError):
                self.store.finish(run["id"], result=report)
            record.assert_called_once()
        saved = self.store.run(run["id"])
        self.assertEqual(saved["status"], "running")
        self.assertIsNone(saved["result"])

    def test_real_worker_receives_pinned_baseline_as_reference_data(self):
        job = self.create(); first = self.completed(job, "first")
        run = self.store.enqueue(job["id"], "second", "device_1", self.cfg)
        row = self.store.claim_next()
        fixture = '''
import json
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult, ToolCall
from dgc.pips import _worker_main
calls = 0
def chat(self, messages, tools=None, on_text=None, **kwargs):
    global calls
    calls += 1
    joined = json.dumps(messages)
    assert "Previous audit checkpoint" in joined
    assert "untrusted reference data" in joined
    assert "Review return value" in joined
    result = (ChatResult(tool_calls=[ToolCall("read1", "read_file", {"path":"source.py"})]) if calls == 1 else
        ChatResult(content=json.dumps({"summary":"Compared source", "findings":[], "limitations":["Absence is not resolution"]})))
    if result.content and on_text: on_text(result.content)
    return result
with patch.object(LLMClient,"chat",chat), patch("requests.sessions.Session.request",side_effect=AssertionError("No network")):
    raise SystemExit(_worker_main())
'''
        original = subprocess.Popen
        def process(argv, *args, **kwargs):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", fixture]
            return original(argv, *args, **kwargs)
        with patch.object(pips.subprocess, "Popen", side_effect=process):
            result = pips._execute_run(self.registry, row, self.cfg)
        self.store.finish(run["id"], result=result)
        checkpoint = self.control({"type": "get_pip_run", "run_id": run["id"]})["result"]["run"]["checkpoint"]
        self.assertEqual(checkpoint["counts"]["not_observed"], 1)
        self.assertNotIn("resolved", json.dumps(checkpoint))
        self.assertEqual(checkpoint["baseline_checkpoint_id"],
                         self.control({"type": "get_pip_run", "run_id": first["id"]})["result"]["run"]["checkpoint"]["id"])


if __name__ == "__main__":
    unittest.main()
