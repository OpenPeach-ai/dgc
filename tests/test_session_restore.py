"""Chat restoration is a read operation, scoped to the project, with correlated outcomes."""
from __future__ import annotations

import copy
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


class SessionRestoreTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-session-restore-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.enterContext(patch.object(sessions, "SESSIONS_DIR", self.root / "sessions"))
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
