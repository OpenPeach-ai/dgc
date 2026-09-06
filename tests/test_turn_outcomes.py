"""Interrupted native work must not become CLI/editor success or goal completion."""
import contextlib
import copy
import io
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.headless import Backend
from dgc.llm import ChatResult


class TurnOutcomeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-turn-outcome-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        config = object.__new__(Config)
        config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                           hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                           turn_budget_s=1, thinking="off")
        config._stored_secrets, config._env_secret_keys = {}, set()
        config.credential_warnings = ()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        self.events = []
        class UI:
            def __getattr__(_self, name):
                return lambda *args, **kwargs: self.events.append((name, args))
        self.agent = Agent(config, UI())
        self.addCleanup(self.agent.mcp.stop_all)
        self.now = 0.0
        replacement = patch("dgc.agent.time", types.SimpleNamespace(monotonic=lambda: self.now))
        replacement.start()
        self.addCleanup(replacement.stop)

    def deadline(self, *args, **kwargs):
        self.now += 2
        return ChatResult(content="Unfinished partial response", finish_reason="cancelled")

    def test_deadline_before_and_during_generation_never_succeeds(self):
        def expire_before_request():
            self.now += 2
            return False
        with patch.object(self.agent, "goal_budget_exhausted", side_effect=expire_before_request), \
                patch.object(self.agent.client, "chat") as chat:
            self.assertFalse(self.agent.run_turn("Inspect the fixture"))
            chat.assert_not_called()
        with patch.object(self.agent.client, "chat", side_effect=self.deadline) as chat:
            self.assertFalse(self.agent.run_turn("Inspect again"))
            self.assertEqual(chat.call_count, 1)
        self.assertIn("time limit", self.agent._last_turn_error)
        self.assertNotIn("Unfinished partial response", str(self.agent.messages[-1]))
        with patch.object(self.agent.client, "chat", return_value=ChatResult(content="Done")):
            self.assertTrue(self.agent.run_turn("A subsequent complete request"))
        self.assertEqual(self.agent._last_turn_error, "")

    def test_timeout_pauses_goal_and_discards_premature_completion_report(self):
        self.agent.set_goal("Finish the whole fixture")
        def claimed(*args, **kwargs):
            self.agent._pending_goal_report = {"status": "completed", "summary": "Premature",
                                               "evidence": ["Not verified"]}
            return self.deadline(*args, **kwargs)
        with patch.object(self.agent.client, "chat", side_effect=claimed):
            self.assertFalse(self.agent.run_turn("Start"))
        snapshot = self.agent.goal_snapshot()
        self.assertEqual(snapshot["status"], "paused")
        self.assertEqual(snapshot["evidence"], [])
        self.assertEqual(snapshot["cycles"], 1)

    def test_cli_exit_and_editor_terminal_event_agree_on_deadline(self):
        from dgc import cli
        facade = types.SimpleNamespace(agent=self.agent, ui=self.agent.ui, expand_mentions=lambda text: text)
        with patch.object(cli, "Config", return_value=self.agent.config), \
                patch.object(cli, "CLI", return_value=facade), \
                patch.object(cli.sessions_mod, "new_path", return_value=None), \
                patch.object(self.agent.client, "chat", side_effect=self.deadline), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["-p", "Inspect the fixture"]), 1)
        backend = object.__new__(Backend)
        backend.agent, backend.config, backend.ui = self.agent, self.agent.config, self.agent.ui
        backend._queue, backend._turn_n = [("Inspect again", None, [])], 0
        backend._worker = threading.current_thread()
        backend._emit_context = lambda: None
        captured = []
        backend.em = types.SimpleNamespace(emit=lambda event_type, **fields:
                                           captured.append({"type": event_type, **fields}))
        with patch.object(self.agent.client, "chat", side_effect=self.deadline):
            backend._run_turn_queue()
        terminal = [event for event in captured if event["type"] == "turn_end"]
        self.assertEqual(len(terminal), 1)
        self.assertEqual(terminal[0]["reason"], "error")
        self.assertIsNone(backend._worker)

    def test_user_stop_and_provider_cancelled_response_are_not_success(self):
        for user_stop in (False, True):
            with self.subTest(user_stop=user_stop):
                def cancel(*args, **kwargs):
                    if user_stop:
                        self.agent.cancelled.set()
                    return ChatResult(content="Partial", finish_reason="cancelled")
                with patch.object(self.agent.client, "chat", side_effect=cancel):
                    self.assertFalse(self.agent.run_turn("Inspect the fixture"))
                self.assertTrue(any(name == "info" and args == ("turn cancelled",)
                                    for name, args in self.events))


if __name__ == "__main__":
    unittest.main()
