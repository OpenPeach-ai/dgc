"""Checklist state must agree across tools, goal completion, session reset and display."""
import copy
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import sessions
from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.editor_protocol import event_error
from dgc.headless import Backend
from dgc.llm import ChatResult, ToolCall
from dgc.tools import execute


class TodoLifecycleTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-todo-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        scoped = patch.object(sessions, "SESSIONS_DIR", self.root / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        cfg = object.__new__(Config)
        cfg.project_root, cfg.project_dir, cfg._persist = self.root, self.root / ".dgc", False
        cfg.data = copy.deepcopy(DEFAULTS)
        cfg.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto",
                        hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                        max_turns=8, thinking="off")
        cfg._stored_secrets, cfg._env_secret_keys = {}, set()
        cfg.permissions = {"allow": [], "ask": [], "deny": []}
        class UI:
            def __getattr__(self, name):
                return lambda *args, **kwargs: None
        self.agent = Agent(cfg, UI())
        self.agent.session_file = sessions.new_path(self.root)
        self.addCleanup(self.agent.mcp.stop_all)
        self.events = []
        self.backend = object.__new__(Backend)
        self.backend.agent, self.backend.config = self.agent, cfg
        self.backend.em = types.SimpleNamespace(emit=lambda event_type, **data: self.events.append({"type": event_type, **data}))
        self.backend._busy = lambda: False
        self.backend._emit_context = lambda *args: None
        self.backend._emit_goal = lambda *args: None

    def update(self, rows):
        return execute("todo", {"todos": rows}, self.agent.ctx)

    def test_goal_and_tool_use_the_same_current_checklist(self):
        self.update([{"content": "Check the result", "status": "pending"}])
        self.assertEqual(self.agent.todos, self.agent.ctx.todos)
        self.assertIs(self.agent.todos, self.agent.ctx.todos)
        self.update([{"content": "Check the result", "status": "done"}])
        self.assertEqual(self.agent.todos[0]["status"], "done")

    def test_new_and_cleared_chats_cannot_inherit_tasks(self):
        for command in ("new_session", "clear_session"):
            with self.subTest(command=command):
                self.update([{"content": "Previous chat only", "status": "pending"}])
                self.backend.dispatch({"type": command})
                self.assertEqual(self.agent.ctx.todos, [])
                self.assertEqual(self.agent.todos, [])

    def test_goal_cannot_accept_a_completion_report_with_pending_tasks(self):
        self.agent.set_goal("Finish all required work")
        self.update([{"content": "Required check", "status": "pending"}])
        def step(_prompt):
            self.agent._handle_call(ToolCall("report", "update_goal", {
                "status": "completed", "summary": "Claimed complete", "evidence": ["Claim"]}))
            return True
        self.agent._run_turn = step
        self.agent.run_turn("Continue")
        self.assertNotEqual(self.agent.goal_status, "completed")

    def test_saved_checklist_redacts_credentials_like_the_transcript(self):
        token = "sk-proj-todo-secret-fixture-0123456789"
        self.agent.config.data["api_key"] = token
        self.update([{"content": "Validate credential " + token, "status": "pending"}])
        self.agent.messages.append({"role": "user", "content": "Validate the configuration"})
        self.assertTrue(self.agent._persist())
        self.assertNotIn(token, self.agent.session_file.read_text())

    def test_resume_and_webview_history_snapshot_include_saved_tasks(self):
        rows = [{"content": "Inspect", "status": "done"}, {"content": "Verify", "status": "in_progress"}]
        self.update(rows)
        self.agent.messages.append({"role": "user", "content": "Finish the work"})
        self.assertTrue(self.agent._persist())
        saved = self.agent.session_file
        self.agent.reset()
        self.backend.dispatch({"type": "resume_session", "path": saved.name, "request_id": "resume"})
        history = next(event for event in self.events if event["type"] == "history")
        self.assertEqual(history.get("todos"), rows)
        self.assertIsNone(event_error({"seq": 0, **history}))
        self.assertEqual(self.agent.todos, rows)
        self.backend.dispatch({"type": "get_history", "request_id": "reload"})
        self.assertEqual(self.events[-1].get("todos"), rows)
        self.assertEqual(self.events[-1]["request_id"], "reload")

    def test_invalid_tool_payload_is_atomic_and_bounded(self):
        before = [{"content": "Keep this task", "status": "pending"}]
        for value in (None, "not a list", [None], [{"content": "", "status": "pending"}],
                      [{"content": "Task", "status": "invented"}],
                      [{"content": "x" * 501, "status": "pending"}], before * 101):
            with self.subTest(value=str(value)[:60]):
                self.update(before)
                self.assertTrue(self.update(value).startswith("error:"))
                self.assertEqual(self.agent.ctx.todos, before)
        self.assertEqual(self.update([]), "todo list cleared")

    def test_acp_resume_replays_the_current_plan(self):
        from dgc.acp import ACPServer
        self.update([{"content": "Inspect", "status": "done"},
                     {"content": "Verify", "status": "in_progress"}])
        self.agent.messages.append({"role": "user", "content": "Finish the work"})
        self.assertTrue(self.agent._persist())
        server, wire = ACPServer(), []
        server._write = wire.append
        with patch("dgc.acp.Config", return_value=self.agent.config), \
                patch.object(server, "_session_inputs", return_value={}):
            server._dispatch({"id": 1, "method": "initialize", "params": {"protocolVersion": 1}})
            server._dispatch({"id": 2, "method": "session/load", "params": {
                "cwd": str(self.root), "sessionId": self.agent.session_file.stem}})
        for state in server._sessions.values():
            self.addCleanup(state.agent.mcp.stop_all)
        plans = [row["params"]["update"] for row in wire
                 if row.get("method") == "session/update"
                 and row["params"]["update"].get("sessionUpdate") == "plan"]
        self.assertEqual(plans, [{"sessionUpdate": "plan", "entries": [
            {"content": "Inspect", "priority": "medium", "status": "completed"},
            {"content": "Verify", "priority": "medium", "status": "in_progress"}]}])

    def test_repeated_final_answers_do_not_complete_with_unresolved_tasks(self):
        self.update([{"content": "Run the required check", "status": "pending"}])
        with patch.object(self.agent.client, "chat", return_value=ChatResult(content="All done.")) as chat:
            self.assertFalse(self.agent.run_turn("Finish the checklist"))
        self.assertEqual(chat.call_count, 3)
        self.assertIn("unfinished", self.agent._last_turn_error)
        self.assertEqual(self.agent.ctx.todos[0]["status"], "pending")


if __name__ == "__main__":
    unittest.main()
