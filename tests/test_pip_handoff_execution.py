"""Real Agent dispatch and private-worker boundaries with offline providers."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_execution, pip_handoffs, pips
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.workspace_registry import RegistryError
from tests import test_pip_handoffs as fixtures


class HandoffExecutionTests(unittest.TestCase):
    setUp = fixtures.PipHandoffTests.setUp
    git = fixtures.PipHandoffTests.git
    commit = fixtures.PipHandoffTests.commit
    setup_source = fixtures.PipHandoffTests.setup_source
    propose = fixtures.PipHandoffTests.propose
    accept = fixtures.PipHandoffTests.accept
    raw_manifest = fixtures.PipHandoffTests.raw_manifest

    def prepare(self, pip_type, action):
        self.setup_source()
        self.target = self.store.create(self.workspace["id"], pip_type, "Investigate the approved issue", "device", pip_type=pip_type)
        with patch.object(pip_execution, "capability", return_value={"available": True}):
            accepted = self.accept(self.propose(action=action))
            self.run_record = accepted["run"]
            self.manifest = self.raw_manifest(self.run_record["id"])
            run_dir = self.registry.directory / "runs" / self.run_record["id"]
            pips.clean_snapshot(self.root, self.manifest["source_revision"], run_dir / "source")
            self.prepared = pip_execution.prepare_isolated_repo(run_dir / "source", run_dir)
        self.worktree = Path(self.prepared["worktree"])
        self.action = self.manifest["handoff"]["payload"]["action"]
        self.worker_cfg = self.cfg.clone_for_root(self.worktree)
        self.worker_cfg.data["mode"] = "acceptEdits" if pip_type == "patch" else "default"

    def native(self, responses):
        answers, self.events = iter(responses), []
        def chat(client, messages, tools=None, **kwargs):
            self.assertTrue(all(t["function"]["name"] not in ("bash", "task", "python", "fetch_url", "pips_propose") for t in tools))
            return next(answers)
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(self.action))}), \
             patch.object(LLMClient, "chat", chat), patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            return pips.execute_native(self.worker_cfg, self.worktree, self.manifest, self.events.append)

    def test_patch_existing_tools_edit_only_exact_reviewed_private_file(self):
        self.prepare("patch", {"kind": "patch", "write_paths": ["source.py"], "tests": []})
        original = (self.root / "source.py").read_text()
        result = self.native([
            ChatResult(tool_calls=[ToolCall("deny1", "write_file", {"path": "unreviewed.py", "content": "no"})]),
            ChatResult(tool_calls=[ToolCall("deny2", "write_file", {"path": str(self.root / "source.py"), "content": "no"})]),
            ChatResult(tool_calls=[ToolCall("edit", "write_file", {"path": "source.py", "content": "def hello():\n    return 'fixed'\n"})]),
            ChatResult(content="Prepared a small isolated edit. Tests have not run.")])
        self.assertEqual((self.root / "source.py").read_text(), original)
        self.assertFalse((self.worktree / "unreviewed.py").exists())
        self.assertIn("fixed", (self.worktree / "source.py").read_text())
        self.assertEqual(len([e for e in self.events if e["kind"] == "tool_denied"]), 2)
        self.assertFalse(result["tests_executed"])
        changes = pip_execution.collect_artifacts(self.prepared, self.action)
        self.assertEqual(changes["changed_files"], ["source.py"])

    def test_pulse_model_cannot_write_and_command_selection_stays_controller_owned(self):
        self.prepare("pulse", {"kind": "test", "tests": [{"argv": ["/usr/bin/true"], "cwd": "."}]})
        original = (self.worktree / "source.py").read_text()
        result = self.native([
            ChatResult(tool_calls=[ToolCall("deny", "write_file", {"path": "source.py", "content": "changed"})]),
            ChatResult(tool_calls=[ToolCall("deny-shell", "bash", {"command": "touch should-not-exist"})]),
            ChatResult(content="Inspected the request. The reviewed command has not run yet.")])
        self.assertEqual((self.worktree / "source.py").read_text(), original)
        self.assertFalse((self.worktree / "should-not-exist").exists())
        self.assertFalse(result["tests_executed"])

    def test_execution_summary_truncates_freeform_unicode_without_claiming_test_results(self):
        self.prepare("pulse", {"kind": "test", "tests": [{"argv": ["/usr/bin/true"], "cwd": "."}]})
        result = self.native([ChatResult(content="Reviewed source. " + "\u591a" * 5000)])
        self.assertLessEqual(len(result["summary"].encode("utf-8")), 4000)
        self.assertTrue(result["summary"].startswith("Reviewed source. "))
        self.assertIn("[Model summary truncated to fit the run report.]", result["summary"])
        self.assertFalse(result["tests_executed"])
        self.assertNotIn("execution", result)

    def test_execution_without_matching_handoff_pin_refuses_before_model(self):
        self.prepare("patch", {"kind": "patch", "write_paths": ["source.py"], "tests": []})
        for mutate in (lambda m: m.pop("handoff"), lambda m: m.update(run_kind="test"),
                       lambda m: m["handoff"]["payload"]["action"]["write_paths"].append("extra.py")):
            bad = copy.deepcopy(self.manifest)
            mutate(bad)
            with patch.object(LLMClient, "chat", side_effect=AssertionError("refuse before model")), self.assertRaises(RegistryError):
                pips.execute_native(self.worker_cfg, self.worktree, bad, lambda event: None)

    def test_patch_chat_stays_readonly_even_though_role_supports_reviewed_edits(self):
        self.setup_source()
        job = self.store.create(self.workspace["id"], "Fixer", "Review", "device", pip_type="patch")
        from dgc.pip_chat import send
        sent = send(self.store, job["id"], "Discuss this issue", "conversation", "device", self.cfg)
        manifest = self.raw_manifest(sent["run"]["id"])
        self.assertEqual(manifest["run_kind"], "conversation")
        self.assertEqual(manifest["policy"], "read_only")
        self.assertEqual(manifest["tools"], sorted(pips.READ_TOOLS))
        self.assertNotIn("handoff", manifest)

    def test_real_private_worker_patch_and_confined_test_roundtrip(self):
        available = pip_execution.capability()
        if not available["available"]:
            self.skipTest("Actual isolated execution is unavailable: " + available["reason"])
        self.setup_source()
        self.target = self.store.create(self.workspace["id"], "Fixer", "Prepare reviewed fix", "device", pip_type="patch")
        action = {"kind": "patch", "write_paths": ["source.py"], "tests": [{
            "argv": ["/usr/bin/python3", "-c", "import source; assert source.hello() == 'fixed'; print('reviewed check passed')"], "cwd": "."}]}
        approved = self.accept(self.propose(action=action))
        row = self.store.claim_next()
        (self.root / "source.py").write_text("dirty_local = 'preserve me'\n")
        original = (self.root / "source.py").read_text()
        fixture = r'''
from unittest.mock import patch
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.pips import _worker_main
responses = iter([
 ChatResult(tool_calls=[ToolCall('write1','write_file',{'path':'source.py','content':"def hello():\n    return 'fixed'\n"})]),
 ChatResult(content='Prepared the exact reviewed change. Verification will run in the controller.')
])
def chat(self, messages, tools=None, on_text=None, **kwargs):
 return next(responses)
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
        finished = self.store.finish(approved["run"]["id"], result=result)
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["result"]["execution"]["tests"][0]["status"], "passed")
        self.assertTrue(finished["result"]["tests_executed"])
        self.assertEqual(finished["result"]["execution"]["tests_not_run"], 0)
        self.assertEqual((self.root / "source.py").read_text(), original)
        self.assertEqual(pip_handoffs.get(self.store, approved["handoff"]["id"])["run_status"], "succeeded")

    def test_cancellation_between_model_and_tests_prevents_command_spawn(self):
        self.setup_source()
        self.target = self.store.create(self.workspace["id"], "Fixer", "Prepare reviewed fix", "device", pip_type="patch")
        action = {"kind": "patch", "write_paths": ["source.py"], "tests": [
            {"argv": ["/usr/bin/true"], "cwd": "."}]}
        with patch.object(pip_execution, "capability", return_value={"available": True}):
            self.accept(self.propose(action=action))
        row = self.store.claim_next()
        fixture = """
import json, sys
payload = json.load(sys.stdin)
print(json.dumps({'kind':'policy_ready','digest':payload['manifest']['policy_digest']}))
print(json.dumps({'kind':'result','result':{'summary':'Inspection complete','tests_executed':False}}))
"""
        spawn, collect = subprocess.Popen, pip_execution.collect_artifacts
        spawned = []
        def process(argv, *args, **kwargs):
            self.assertEqual(argv[1:], ["-m", "dgc.pips", "--worker"], "No reviewed command may spawn after cancellation")
            spawned.append(argv)
            return spawn([sys.executable, "-c", fixture], *args, **kwargs)
        def cancel_after_collect(prepared, reviewed):
            value = collect(prepared, reviewed)
            self.store.cancel(row["id"], "device")
            return value
        # Git preparation occurs before worker interception; only test/worker
        # process launches are interesting to this exact cancellation boundary.
        def subprocess_dispatch(argv, *args, **kwargs):
            if argv and Path(argv[0]).name == "git":
                return spawn(argv, *args, **kwargs)
            return process(argv, *args, **kwargs)
        with patch.object(pip_execution, "capability", return_value={"available": True}), \
             patch.object(pip_execution, "collect_artifacts", side_effect=cancel_after_collect), \
             patch.object(pips.subprocess, "Popen", side_effect=subprocess_dispatch), self.assertRaises(RegistryError) as caught:
            pips._execute_run(self.registry, row, self.cfg)
        self.assertEqual(caught.exception.code, "cancelled")
        self.assertEqual(len(spawned), 1)
        self.assertEqual(self.store.run(row["id"])["status"], "cancelling")


if __name__ == "__main__":
    unittest.main()
