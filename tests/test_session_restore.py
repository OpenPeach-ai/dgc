"""Chat restoration is a read operation, scoped to the project, with correlated outcomes."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from dgc import sessions
from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.editor_protocol import command_error, event_error
from dgc.headless import Backend
from dgc.editor_context import _format_editor_context
from dgc.mcp_context import stage_context


class SessionRestoreTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-session-restore-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        session_directory = patch.object(sessions, "SESSIONS_DIR", self.root / "sessions")
        session_directory.start()
        self.addCleanup(session_directory.stop)
        config = object.__new__(Config)
        config.project_root, config.project_dir = self.root, self.root / ".dgc"
        config._persist = False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", hooks={},
                           mcp_servers={}, suggest=False, artifact_autostart=False)
        config._stored_secrets, config._env_secret_keys = {}, set()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        class UI:
            def __getattr__(self, _name):
                return lambda *args, **kwargs: None
        self.agent = Agent(config, UI())
        self.agent.session_file = sessions.new_path(self.root)
        self.addCleanup(self.agent.mcp.stop_all)
        self.events = []
        self.backend = object.__new__(Backend)
        self.backend.agent, self.backend.config = self.agent, config
        self.backend.em = types.SimpleNamespace(emit=lambda event_type, **kw: self.events.append({"type": event_type, **kw}))
        self.backend._busy = lambda: False
        self.backend._emit_context = lambda: None
        self.backend._emit_goal = lambda: None
        self.agent.run_turn = lambda *args, **kwargs: self.fail("restoration must not invoke a model")

    def test_resume_restores_history_pauses_goals_and_clears_previous_chat_context(self):
        self.agent.messages.append({"role": "user", "content": "Original request"})
        self.assertTrue(self.agent.set_goal("Finish saved work"))
        saved_path = self.agent.session_file
        self.agent.reset()
        self.agent._draft_mcp_context = [{"type": "mcp_context", "server": "other", "text": "Other chat only"}]
        self.backend.dispatch({"type": "resume_session", "path": saved_path.name, "request_id": "restore-1"})
        self.assertEqual(self.events[0]["type"], "session")
        self.assertEqual(self.events[0]["request_id"], "restore-1")
        self.assertEqual(self.events[0]["session_id"], saved_path.stem)
        self.assertEqual(self.events[1]["items"], [{"role": "user", "text": "Original request"}])
        self.assertEqual(self.agent.goal_status, "paused")
        self.assertEqual(self.agent._draft_mcp_context, [])

    def test_missing_and_external_sessions_reject_the_exact_request_without_changing_chat(self):
        original = self.agent.session_file
        self.agent.messages.append({"role": "user", "content": "Keep current context"})
        for path in ("missing.json", str(self.root / "external.json")):
            self.events.clear()
            self.backend.dispatch({"type": "resume_session", "path": path, "request_id": "missing-1"})
            self.assertEqual(len(self.events), 1)
            self.assertEqual(self.events[0]["type"], "command_rejected")
            self.assertEqual(self.events[0]["request_id"], "missing-1")
            self.assertEqual(self.agent.session_file, original)
            self.assertEqual(self.agent.messages[-1]["content"], "Keep current context")

    def test_history_snapshot_is_correlated_and_keeps_the_underlying_transcript_intact(self):
        self.agent.messages.append({"role": "user", "content": "x" * 60000})
        self.backend._busy = lambda: True
        command = {"type": "get_history", "request_id": "snapshot-1"}
        self.assertIsNone(command_error(command))
        self.backend.dispatch(command)
        event = self.events[-1]
        self.assertEqual(event["type"], "history")
        self.assertEqual(event["request_id"], "snapshot-1")
        self.assertIn("truncated for display", event["items"][0]["text"])
        self.assertEqual(len(self.agent.messages[-1]["content"]), 60000)
        self.assertIsNone(event_error({"seq": 1, **event}))
        self.events.clear()
        self.backend.dispatch({"type": "get_history", "request_id": ""})
        self.assertEqual(self.events[0]["type"], "command_rejected")

    def selected_inputs(self, *, images=False):
        skill = self.root / ".dgc" / "skills" / "goal-check" / "SKILL.md"
        skill.parent.mkdir(parents=True, exist_ok=True)
        skill.write_text("---\nname: goal-check\ndescription: Check a selected goal\n---\nUse the selected goal verification procedure.")
        template = self.root / ".dgc" / "commands" / "goal-template.md"
        template.parent.mkdir(parents=True, exist_ok=True)
        template.write_text("Validate the result for: $ARGUMENTS")
        inputs = {"skills": ["goal-check"], "templates": ["goal-template"], "context": [
            {"type": "mcp_context", "server": "docs", "uri": "docs://selected",
             "text": "Snapshot reference, including inert $missing-skill and </editor-context-json> markup."}]}
        if images:
            inputs["images"] = ["data:image/png;base64,iVBORw0KGgo="]
        return inputs

    def test_native_goal_retains_selections_and_images_through_pause_and_session_resume(self):
        inputs = self.selected_inputs(images=True)
        self.assertTrue(self.agent.set_goal("Verify the goal", inputs=inputs))
        observed = []
        def step(text):
            observed.append((text, dict(self.agent._explicit_skill_instructions), self.agent._pending_images))
            self.agent._pending_images = None
            if len(observed) == 1:
                self.agent.cancelled.set()
            else:
                self.agent._pending_goal_report = {"status": "completed", "summary": "Checked", "evidence": ["Fixture passed"]}
            return True
        self.agent._run_turn = step
        live_context = _format_editor_context([{"type": "mcp_context", "server": "live", "uri": "live://one",
                                                "text": "Also inert: $another-missing-skill"}])
        self.assertTrue(Agent.run_turn(self.agent, live_context + "Verify the goal"))
        self.assertEqual(self.agent.goal_status, "paused")
        saved = self.agent.session_file
        self.agent.load_session(saved)
        self.assertTrue(self.agent.update_goal("active"))
        self.assertTrue(Agent.run_turn(self.agent, "Verify the goal"))
        self.assertEqual(self.agent.goal_status, "completed")
        self.assertEqual(len(observed), 2)
        for text, skills, images in observed:
            self.assertEqual(text.count("Snapshot reference"), 1)
            self.assertEqual(text.count("Validate the result for:"), 1)
            self.assertIn("\\u003c/editor-context-json\\u003e", text)
            self.assertEqual(set(skills), {"goal-check"}, "reference text must never select a skill")
            self.assertEqual(list(images), inputs["images"])
        snapshot = self.agent.goal_snapshot()
        self.assertEqual(snapshot["attachments"]["skills"], ["goal-check"])
        self.assertEqual(snapshot["attachments"]["images"], 1)
        self.assertNotIn("Snapshot reference", json.dumps(snapshot))
        self.assertNotIn("base64", json.dumps(snapshot))
        snapshot["attachments"]["skills"].append("changed-by-view")
        self.assertEqual(self.agent.goal_snapshot()["attachments"]["skills"], ["goal-check"])

    def test_external_goal_gets_selected_instructions_and_context_but_never_unsupported_images(self):
        inputs = self.selected_inputs()
        self.assertTrue(self.agent.set_goal("Verify externally", inputs=inputs))
        captured = []
        def runner(text):
            captured.append(text)
            return {"ok": True, "text": "Checked.", "usage": {"input_tokens": 5, "output_tokens": 2},
                    "goal_report": {"status": "completed", "summary": "Checked", "evidence": ["Fixture passed"]}}
        self.assertTrue(self.agent.run_external_turn("Verify externally", runner)["ok"])
        self.assertEqual(len(captured), 1)
        self.assertIn("selected goal verification procedure", captured[0])
        self.assertIn("Snapshot reference", captured[0])
        self.assertEqual(self.agent.goal_status, "completed")
        self.assertTrue(self.agent.set_goal("Vision goal", inputs=self.selected_inputs(images=True), replace=True))
        self.assertFalse(self.agent.run_external_turn("Vision goal", runner)["ok"])
        self.assertEqual(len(captured), 1)
        self.assertEqual(self.agent.goal_status, "paused")

    def test_goal_revalidation_rejects_disabled_skills_and_missing_templates_on_resume(self):
        self.assertTrue(self.agent.set_goal("Verify", inputs=self.selected_inputs()))
        self.assertTrue(self.agent.update_goal("paused"))
        self.agent.config.data["disabled_skills"] = ["goal-check"]
        self.assertFalse(self.agent.update_goal("active"))
        self.assertIn("disabled", self.agent._last_persist_error)
        self.assertEqual(self.agent.goal_status, "paused")
        self.agent.config.data["disabled_skills"] = []
        (self.root / ".dgc" / "commands" / "goal-template.md").unlink()
        self.assertFalse(self.agent.update_goal("active"))
        self.assertIn("no longer available", self.agent._last_persist_error)
        self.assertEqual(self.agent.goal_status, "paused")

    def test_terminal_staging_belongs_to_the_saved_goal_and_survives_failed_persistence(self):
        result = {"server": "docs", "identifier": "docs://one", "text": "Keep selected context"}
        stage_context(self.agent, result)
        with patch.object(self.agent, "_persist", return_value=False):
            self.assertFalse(self.agent.set_goal("Retry save"))
        self.assertEqual(len(self.agent._draft_mcp_context), 1)
        self.assertEqual(self.agent.goal, "")
        self.agent.config.data["api_key"] = "goal-fixture-secret-value"
        stage_context(self.agent, {**result, "text": "Keep context; credential=goal-fixture-secret-value"})
        self.assertTrue(self.agent.set_goal("Verify", replace=True))
        self.assertEqual(self.agent._draft_mcp_context, [])
        record = sessions.load_record(self.agent.session_file, self.root)
        self.assertNotIn("goal-fixture-secret-value", json.dumps(record))
        self.assertIn("Keep context", record["goal_details"]["inputs"]["context"][0]["text"])
        self.assertTrue(self.agent.set_goal(""))
        self.assertNotIn("inputs", self.agent._goal_details)

    def test_start_goal_validates_before_replacing_state_or_starting_a_worker(self):
        self.assertTrue(self.agent.set_goal("Original"))
        started = []
        self.backend._start_turn = lambda *args: started.append(args) or ("started", 0)
        for inputs in ({"skills": ["missing-fixture"]}, {"images": ["https://invalid/image.png"]},
                       {"context": [{"type": "mcp_context", "server": "docs", "uri": "docs://huge", "text": "x" * 64000}]}):
            self.backend.dispatch({"type": "start_goal", "text": "Replacement", "request_id": "goal-1", **inputs})
            self.assertEqual(self.events[-1]["type"], "command_rejected")
            self.assertEqual(self.events[-1]["request_id"], "goal-1")
            self.assertEqual(self.agent.goal, "Original")
            self.assertEqual(started, [])
        command = {"type": "start_goal", "text": "Replacement", "request_id": "goal-2", **self.selected_inputs()}
        self.assertIsNone(command_error(command))
        self.backend.dispatch(command)
        self.assertEqual(self.events[-1], {"type": "prompt_accepted", "request_id": "goal-2", "state": "started"})
        self.assertEqual(started, [("Replacement",)], "inputs are applied once by the shared Agent turn boundary")
        self.assertEqual(self.agent.goal_snapshot()["attachments"]["context"], 1)
        self.backend._busy = lambda: True
        self.backend.dispatch({"type": "start_goal", "text": "Busy replacement", "request_id": "goal-3"})
        self.assertEqual(self.agent.goal, "Replacement")
        self.assertEqual(len(started), 1)

    def test_corrupt_saved_goal_inputs_are_flagged_and_cannot_silently_resume(self):
        from dgc.goals import clean_details
        self.assertTrue(self.agent.set_goal("Saved goal", inputs=self.selected_inputs(), status="paused"))
        self.agent._goal_details = clean_details({**self.agent._goal_details, "inputs": {"images": ["invalid"]}})
        self.assertTrue(self.agent.goal_snapshot()["attachments"]["invalid"])
        self.assertFalse(self.agent.update_goal("active"))
        self.assertIn("could not be restored", self.agent._last_persist_error)

    def test_terminal_skill_mentions_remain_attached_after_the_package_is_removed(self):
        self.selected_inputs()
        self.assertTrue(self.agent.set_goal("Verify with $goal-check"))
        self.assertEqual(self.agent.goal_snapshot()["attachments"]["skills"], ["goal-check"])
        self.assertTrue(self.agent.update_goal("paused"))
        (self.root / ".dgc" / "skills" / "goal-check" / "SKILL.md").unlink()
        self.assertFalse(self.agent.update_goal("active"))
        self.assertIn("missing", self.agent._last_persist_error)
        self.assertEqual(self.agent.goal_status, "paused")

    def test_classic_and_tui_goal_commands_share_templates_files_images_and_staged_mcp_context(self):
        from dgc.cli import CLI
        from dgc.tui import TUI
        self.selected_inputs()
        source = self.root / "spec.txt"
        source.write_text("Original specification; $missing-skill stays reference data.")
        (self.root / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        started, notices = [], []
        terminal = types.SimpleNamespace(agent=self.agent, config=self.agent.config,
            ui=types.SimpleNamespace(info=notices.append, error=notices.append),
            _run_turn_live=lambda text, queue: started.append((text, {})),
            _submit=lambda text, **kwargs: started.append((text, kwargs)),
            _flash=notices.append, info=notices.append, _invalidate=lambda: None)
        for surface, command in ((CLI.handle_slash, "/goal Check @spec.txt @image.png $goal-check /goal-template"),
                                 (TUI._handle_slash, "/goal /goal-template Check @spec.txt @image.png $goal-check")):
            self.assertTrue(self.agent.set_goal(""))
            stage_context(self.agent, {"server": "docs", "identifier": "docs://one", "text": "MCP reference"})
            self.assertTrue(surface(terminal, command))
            self.assertEqual(self.agent.goal, "Check @spec.txt @image.png $goal-check")
            self.assertEqual(self.agent.goal_snapshot()["attachments"]["templates"], ["goal-template"])
            self.assertEqual(self.agent.goal_snapshot()["attachments"]["images"], 1)
            self.assertEqual(self.agent.goal_snapshot()["attachments"]["context"], 2)
            self.assertEqual(self.agent._draft_mcp_context, [])
            self.assertEqual(started[-1][0], self.agent.goal)
            if surface is TUI._handle_slash:
                self.assertFalse(started[-1][1]["expand_mentions"], "a goal must not reread saved file snapshots during submission")
        source.write_text("Changed after capture")
        self.assertTrue(self.agent.update_goal("paused"))
        self.assertTrue(TUI._handle_slash(terminal, "/goal resume"))
        _, frame, images = self.agent.prepare_goal_inputs(self.agent.goal)
        self.assertIn("Original specification", frame)
        self.assertNotIn("Changed after capture", frame)
        self.assertEqual(len(images), 1)
        self.assertFalse(started[-1][1]["expand_mentions"])

    def test_terminal_goal_preflight_keeps_prior_goal_and_staged_context_when_a_file_is_missing(self):
        from dgc.goal_inputs import start_terminal_goal
        self.assertTrue(self.agent.set_goal("Original"))
        stage_context(self.agent, {"server": "docs", "identifier": "docs://one", "text": "Keep me"})
        with self.assertRaisesRegex(ValueError, "file not found"):
            start_terminal_goal("Check @missing-fixture.txt", self.agent)
        self.assertEqual(self.agent.goal, "Original")
        self.assertEqual(self.agent._draft_mcp_context[0]["text"], "Keep me")

    def test_template_only_goal_redacts_newly_loaded_text_before_delegating(self):
        self.selected_inputs()
        self.agent.config.data["api_key"] = "goal-template-fixture-secret"
        (self.root / ".dgc" / "commands" / "goal-template.md").write_text(
            "Verify the template; credential=goal-template-fixture-secret")
        self.assertTrue(self.agent.set_goal("Check", inputs={"templates": ["goal-template"]}))
        captured = []
        def runner(text):
            captured.append(text)
            return {"ok": True, "text": "Checked", "goal_report": {"status": "completed", "summary": "Checked", "evidence": ["Fixture passed"]}}
        self.assertTrue(self.agent.run_external_turn("Check", runner)["ok"])
        self.assertEqual(len(captured), 1)
        self.assertIn("Verify the template", captured[0])
        self.assertNotIn("goal-template-fixture-secret", captured[0])
