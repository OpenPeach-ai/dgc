"""A running command is shown once: in its tool block, not again on the status line under it."""
import contextlib
import copy
import tempfile
import time
import unittest
from pathlib import Path

from dgc.agent import Agent
from dgc.config import Config, DEFAULTS

COMMAND = "cd /home/fixture/project && npm test -- --runInBand"


class _SilentUI:
    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


class TuiStatusLineTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-activity-once-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        cfg = object.__new__(Config)
        cfg.project_root, cfg.project_dir, cfg._persist = root, root / ".dgc", False
        cfg.data = copy.deepcopy(DEFAULTS)
        cfg.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto",
                        hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                        thinking="off")
        cfg._stored_secrets, cfg._env_secret_keys = {}, set()
        cfg.permissions = {"allow": [], "ask": [], "deny": []}
        self.config = cfg
        self.agent = Agent(cfg, _SilentUI())
        self.addCleanup(self.agent.mcp.stop_all)

    def tui(self):
        """A real TUI over the agent, with pipe input and a dummy output (no application loop)."""
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput
        from dgc.tui import TUI

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=30, columns=160)

        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        pipe = stack.enter_context(create_pipe_input())
        stack.enter_context(create_app_session(input=pipe, output=Output()))
        return TUI(self.config, agent=self.agent)

    @staticmethod
    def plain(formatted) -> str:
        from prompt_toolkit.formatted_text import fragment_list_to_text, to_formatted_text
        return fragment_list_to_text(to_formatted_text(formatted))

    def test_the_status_line_names_the_step_and_the_block_holds_the_command(self):
        ui = self.tui()
        ui._turn.set()
        ui._turn_t0 = time.monotonic()
        ui.tool_call("bash", {"command": COMMAND}, "call-1")
        status = self.plain(ui._status())
        block = self.plain(ui._tool_frags(ui.blocks[-1]))
        self.assertEqual(block.count(COMMAND), 1, block)
        self.assertIn("Running a command", status)
        self.assertNotIn("npm test", status, "the command is already on screen in its block")
        self.assertIn("⇣", status, "the status line keeps its clock and token count")
        # A read names the step the same way; the path stays in the block.
        ui.tool_result("bash", "ok", "call-1")
        ui.tool_call("read_file", {"path": "src/app/very_specific_module.py"}, "call-2")
        self.assertIn("Reading a file", self.plain(ui._status()))
        self.assertNotIn("very_specific_module", self.plain(ui._status()))
        self.assertIn("very_specific_module", self.plain(ui._tool_frags(ui.blocks[-1])))
        # The pane's state still sees a tool in flight.
        self.assertEqual(ui._pane_agent_state(), "USING TOOLS")


if __name__ == "__main__":
    unittest.main()
