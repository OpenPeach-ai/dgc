"""Goal lifecycle and delegated wire regressions; no model or vendor account is contacted."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.goals import ReportFilter, clean_report, extract_report, marker, request, parse_start
from dgc.llm import ChatResult, ToolCall
from dgc import sessions, subscriptions


class QuietUI:
    def __init__(self):
        self.events = []

    def __getattr__(self, name):
        return lambda *args, **kw: self.events.append((name, args))


class GoalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="dgc-goal-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        config = object.__new__(Config)
        config.project_root = self.root
        config.project_dir = self.root / ".dgc"
        config._persist = False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", api_key="fixture-placeholder",
                           model="fixture", mode="auto", hooks={}, mcp_servers={}, suggest=False,
                           artifact_autostart=False)
        config._stored_secrets, config._env_secret_keys = {}, set()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        self.ui = QuietUI()
        self.agent = Agent(config, self.ui)
        self.addCleanup(self.agent.mcp.stop_all)

    def test_no_goal_means_one_turn(self):
        calls = []
        self.agent._run_turn = lambda text: calls.append(text) or True
        self.assertTrue(self.agent.run_turn("ordinary request"))
        self.assertEqual(calls, ["ordinary request"])
        self.assertEqual(self.agent.goal_status, "none")

    def test_native_continues_and_commits_evidence_only_after_success(self):
        self.agent.set_goal("finish both steps")
        observed = []
        def step(text):
            observed.append((text, self.agent.goal_status))
            self.agent._goal_progress.add("write_file", {"path": "file"}, str(len(observed)))
            if len(observed) == 2:
                self.agent._handle_call(ToolCall("report", "update_goal", {
                    "status": "completed", "summary": "Both steps finished", "evidence": ["Two checks passed"]}))
                self.assertEqual(self.agent.goal_status, "active")
            return True
        self.agent._run_turn = step
        self.assertTrue(self.agent.run_turn("start"))
        self.assertEqual(len(observed), 2)
        snapshot = self.agent.goal_snapshot()
        self.assertEqual(snapshot["status"], "completed")
        self.assertEqual(snapshot["evidence"], ["Two checks passed"])
        self.assertEqual(snapshot["cycles"], 2)
        self.assertFalse(snapshot["running"])

    def test_actual_model_goal_tool_and_final_response(self):
        self.agent.set_goal("confirm the fixture")
        responses = iter([
            ChatResult(content="", tool_calls=[ToolCall("report", "update_goal", {
                "status": "completed", "summary": "Fixture confirmed", "evidence": ["Provided input is sufficient"]})]),
            ChatResult(content="Confirmed the fixture."),
        ])
        with patch.object(self.agent.client, "chat", side_effect=lambda *a, **k: next(responses)):
            self.assertTrue(self.agent.run_turn("confirm"))
        self.assertEqual(self.agent.goal_status, "completed")

    def test_plan_goal_exposes_status_reporting_without_execution_tools(self):
        self.agent.config.data["mode"] = "plan"
        self.agent.set_goal("prepare the plan")
        names = {item["function"]["name"] for item in self.agent._tool_schemas()}
        self.assertIn("update_goal", names)
        self.assertNotIn("bash", names)
        self.assertNotIn("write_file", names)

    def test_cli_budget_syntax_is_explicit_and_bounded(self):
        self.assertEqual(parse_start("--tokens 12000 ship release"), ("ship release", 12000))
        self.assertEqual(parse_start("ship release"), ("ship release", None))
        for invalid in ("--tokens -1 objective", "--tokens 0 objective", "--tokens 1000000000001 objective", "--tokens 4"):
            with self.assertRaises(ValueError):
                parse_start(invalid)

    def test_failure_and_cancellation_never_complete(self):
        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                self.agent.set_goal("finish", replace=True)
                def step(_):
                    self.agent._pending_goal_report = {"status": "completed", "summary": "Claim", "evidence": ["Claim"]}
                    if cancel:
                        self.agent.cancelled.set()
                    return cancel
                self.agent._run_turn = step
                self.agent.run_turn("start")
                self.assertEqual(self.agent.goal_status, "paused")

    def test_stalled_goal_is_bounded_and_resumable(self):
        self.agent.set_goal("fix remaining work")
        self.agent._run_turn = lambda _: True
        self.assertTrue(self.agent.run_turn("start"))
        self.assertEqual(self.agent.goal_status, "blocked")
        self.assertEqual(self.agent.goal_snapshot()["cycles"], 3)
        self.agent.update_goal("active")
        self.assertEqual(self.agent._goal_details["stalled_cycles"], 0)

    def test_repeated_tool_work_does_not_reset_the_bound(self):
        self.agent.set_goal("fix remaining work")
        def step(_):
            self.agent._goal_progress.add("read_file", {"path": "same"}, "same content")
            return True
        self.agent._run_turn = step
        self.agent.run_turn("start")
        self.assertEqual(self.agent.goal_snapshot()["cycles"], 4)
        self.assertEqual(self.agent.goal_status, "blocked")

    def test_user_clear_is_applied_after_active_tool_cleanup(self):
        self.agent.set_goal("work")
        def step(_):
            accepted = []
            worker = threading.Thread(target=lambda: accepted.append(self.agent.request_goal_control("clear")))
            worker.start(); worker.join(2)
            self.assertEqual(accepted, [True])
            self.assertEqual(self.agent.goal, "work")
            return True
        self.agent._run_turn = step
        self.agent.run_turn("start")
        self.assertEqual(self.agent.goal_status, "none")
        self.assertEqual(self.agent.goal, "")

    def test_edit_preserves_work_time_and_identity_reopen_does_not_charge_offline_time(self):
        self.agent.session_file = sessions.new_path(self.root)
        self.agent.set_goal("initial objective")
        original = self.agent.goal_snapshot()["id"]
        self.agent._goal_elapsed_seconds = 15
        self.assertTrue(self.agent.set_goal("revised objective"))
        self.assertEqual(self.agent.goal_elapsed_seconds(time.time() + 1000), 15)
        self.assertEqual(self.agent.goal_snapshot()["id"], original)
        self.agent.load_session(self.agent.session_file)
        self.assertEqual(self.agent.goal_status, "paused")
        self.assertEqual(self.agent.goal_elapsed_seconds(time.time() + 1000), 15)

    def test_concurrent_goal_mutation_cannot_change_live_state(self):
        self.agent.session_file = sessions.new_path(self.root)
        self.agent.set_goal("original")
        result = []
        with self.agent._session_turn_scope(reentrant=False):
            thread = threading.Thread(target=lambda: result.append(self.agent.set_goal("racing edit")))
            thread.start(); thread.join(2)
            self.assertEqual(result, [False])
            self.assertEqual(self.agent.goal, "original")

    def test_delegated_goal_continues_with_new_request_and_keeps_clean_history(self):
        self.agent.set_goal("complete task")
        requests = []
        def run(prompt):
            requests.append(self.agent._active_goal_request)
            return {"ok": True, "text": "Work summary", "usage": {"input_tokens": 4, "output_tokens": 2},
                    "progress_signature": str(len(requests)), "goal_report": {
                        "status": "completed" if len(requests) == 2 else "active", "summary": "Verified work",
                        "evidence": ["Fixture check passed"]}}
        self.assertTrue(self.agent.run_external_turn("user request", run)["ok"])
        self.assertEqual(self.agent.goal_status, "completed")
        self.assertNotEqual(requests[0]["nonce"], requests[1]["nonce"])
        self.assertEqual(self.agent.goal_snapshot()["tokens_used"], 12)
        self.assertEqual(self.agent.messages[1]["content"], "user request")
        self.assertNotIn("dgc-goal-report", json.dumps(self.agent.messages))

    def test_budget_pauses_after_reported_usage_and_never_claims_completion(self):
        self.agent.set_goal("task", token_budget=10)
        result = self.agent.run_external_turn("start", lambda _: {
            "ok": True, "text": "More remains", "usage": {"input_tokens": 10, "output_tokens": 3},
            "progress_signature": "work"})
        self.assertTrue(result["ok"])
        self.assertEqual(self.agent.goal_status, "paused")
        self.assertEqual(self.agent.goal_snapshot()["tokens_used"], 13)

    def test_report_filter_handles_every_split_without_control_text(self):
        req = request("goal")
        report = {"status": "completed", "summary": "Done", "evidence": ["Verified"]}
        text = "Visible answer.\n" + marker(req) + json.dumps(report) + "</dgc-goal-report>"
        for split in range(len(text)):
            stream = ReportFilter(req)
            visible = stream.feed(text[:split]) + stream.feed(text[split:]) + stream.finish()
            self.assertEqual(visible, "Visible answer.\n")
        self.assertEqual(extract_report(text, req), ("Visible answer.", report))
        self.assertIsNone(clean_report({**report, "evidence": []}))
        self.assertIsNone(extract_report(text, request("different run"))[1])
        self.assertIsNone(extract_report(text + " more work remains", req)[1])
        duplicate = marker(req) + '{"status":"active","status":"completed","summary":"x","evidence":["y"]}</dgc-goal-report>'
        self.assertIsNone(extract_report(duplicate, req)[1])

    def test_goal_transition_save_failure_is_not_success(self):
        self.agent.set_goal("task")
        def step(_):
            self.agent._pending_goal_report = {"status": "completed", "summary": "Finished", "evidence": ["Check"]}
            return True
        self.agent._run_turn = step
        with patch.object(self.agent, "_persist", return_value=False):
            self.assertFalse(self.agent.run_turn("start"))
        self.assertEqual(self.agent.goal_status, "active")

    def test_real_delegated_stream_redacts_split_secrets_and_hides_goal_protocol(self):
        from dataclasses import replace
        req = request("finish fixture")
        script = self.root / "vendor-fixture"
        report = marker(req) + json.dumps({"status": "completed", "summary": "Finished", "evidence": ["Check passed"]}) + "</dgc-goal-report>"
        events = [
            {"type": "text", "delta": "Visible fixture-"},
            {"type": "text", "delta": "secret-value\n" + report[:13]},
            {"type": "text", "delta": report[13:]},
        ]
        script.write_text("#!/usr/bin/env python3\nimport json\nfor item in " + repr(events) + ":\n print(json.dumps(item), flush=True)\n")
        script.chmod(0o700)
        engine = replace(subscriptions.ENGINES["codex"], binary=str(script), auth_markers=(), auth_on_launch=True, stream="qwen")
        shown = []
        result = subscriptions.run_turn(engine, "task", self.root, timeout=5, on_event=shown.append,
                                        goal_request=req, redact_secrets=("fixture-secret-value",))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["goal_report"]["status"], "completed")
        self.assertNotIn("fixture-secret-value", json.dumps(result))
        visible = "".join(event.get("text", "") for event in shown)
        self.assertNotIn("dgc-goal-report", visible)
        self.assertNotIn("fixture-secret-value", visible)
        self.assertIn("Visible", visible)

    def test_report_before_a_later_tool_cannot_complete_delegated_goal(self):
        from dataclasses import replace
        req = request("finish fixture")
        report = marker(req) + json.dumps({"status": "completed", "summary": "Claim", "evidence": ["Claim"]}) + "</dgc-goal-report>"
        events = [{"type": "text", "text": "Claim\n" + report},
                  {"type": "tool_call", "name": "edit", "id": "1", "arguments": {"path": "file"}},
                  {"type": "tool_result", "id": "1", "output": "changed"}]
        script = self.root / "vendor-fixture"
        script.write_text("#!/usr/bin/env python3\nimport json\nfor item in " + repr(events) + ":\n print(json.dumps(item), flush=True)\n")
        script.chmod(0o700)
        engine = replace(subscriptions.ENGINES["codex"], binary=str(script), auth_markers=(), auth_on_launch=True, stream="qwen")
        result = subscriptions.run_turn(engine, "task", self.root, timeout=5, goal_request=req)
        self.assertTrue(result["ok"])
        self.assertIsNone(result["goal_report"])

    def test_terminal_answer_after_commentary_is_delivered_once(self):
        from dataclasses import replace
        script = self.root / "vendor-fixture"
        events = [{"type": "text", "text": "Checking now."},
                  {"type": "result", "result": "The verified answer."}]
        script.write_text("#!/usr/bin/env python3\nimport json\nfor item in " + repr(events) + ":\n print(json.dumps(item), flush=True)\n")
        script.chmod(0o700)
        engine = replace(subscriptions.ENGINES["claude"], binary=str(script), auth_markers=(), auth_on_launch=True, stream="qwen")
        shown = []
        result = subscriptions.run_turn(engine, "task", self.root, timeout=5, on_event=shown.append)
        visible = "".join(event.get("text", "") for event in shown if event["kind"] == "text")
        self.assertEqual(visible, "Checking now.\n\nThe verified answer.")
        self.assertEqual(result["text"], visible)

    def test_excessive_vendor_text_is_stopped_and_cannot_complete(self):
        from dataclasses import replace
        script = self.root / "vendor-fixture"
        script.write_text("#!/usr/bin/env python3\nimport json\nprint(json.dumps({'type':'text','text':'x'*100}), flush=True)\n")
        script.chmod(0o700)
        engine = replace(subscriptions.ENGINES["claude"], binary=str(script), auth_markers=(), auth_on_launch=True, stream="qwen")
        with patch.object(subscriptions, "_MAX_TURN_TEXT_CHARS", 20):
            result = subscriptions.run_turn(engine, "task", self.root, timeout=5)
        self.assertFalse(result["ok"])
        self.assertIn("text limit", result["error"])
        self.assertEqual(result["text"], "")


if __name__ == "__main__":
    unittest.main()
