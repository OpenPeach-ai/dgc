"""A manual Stop stops the turn's background work too (his call, 20 Nov): its background helpers, troupes and background
commands, each written down as stopped by request (so a reopen never starts them by itself). The next prompt tells the
model what stopped, once, so "continue" can start again what is still needed."""
import threading
import unittest
from unittest.mock import patch

from tests.test_goal_turns import agent_in
from tests import test_live_controls as live


class AgentSide(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        directory = tempfile.TemporaryDirectory(prefix="dgc-stop-bg-")
        self.addCleanup(directory.cleanup)
        self.agent = agent_in(Path(directory.name))
        self.addCleanup(self.agent.mcp.stop_all)

    def test_stop_stops_helpers_and_commands_and_the_next_prompt_says_what(self):
        cancel = threading.Event()
        self.agent._detached_jobs = {"agent_1": {"cancel": cancel, "description": "Build the pages"}}
        shells = [{"id": "bg_1", "command": "npm run dev", "cwd": "/work/app"}]
        with patch("dgc.tools.running_background", return_value=shells), \
             patch("dgc.tools.shutdown_background") as shut:
            lines = self.agent.stop_background_by_user()
        self.assertTrue(cancel.is_set(), "the helper was told to stop")
        shut.assert_called_once()
        self.assertTrue(shut.call_args.kwargs.get("by_user"), "commands stop as the user's own kill")
        self.assertTrue(any("Build the pages" in line for line in lines), lines)
        self.assertTrue(any("npm run dev" in line and "/work/app" in line for line in lines), lines)
        note = self.agent._turn_notes()
        self.assertIn("# Stopped when you were stopped", note)
        self.assertIn("npm run dev", note)
        self.assertIn("Build the pages", note)
        self.assertNotIn("# Stopped when you were stopped", self.agent._turn_notes(), "said once")

    def test_nothing_running_says_nothing(self):
        with patch("dgc.tools.running_background", return_value=[]), patch("dgc.tools.shutdown_background"):
            self.assertEqual(self.agent.stop_background_by_user(), [])
        self.assertNotIn("Stopped when you were stopped", self.agent._turn_notes())


class EditorStop(unittest.TestCase):
    setUp, wait = live.LiveControlTests.setUp, live.LiveControlTests.wait

    def test_the_editors_stop_stops_background_work_and_says_so(self):
        with patch.object(self.agent, "stop_background_by_user", return_value=["a background helper, \"Build the pages\""]) as stop:
            self.backend.dispatch({"type": "cancel"})
        stop.assert_called_once()
        self.wait("info", message="Stopped too: a background helper, \"Build the pages\".")


if __name__ == "__main__":
    unittest.main()
