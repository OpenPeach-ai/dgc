"""A running command is shown once: in its tool block, not again on the status line under it."""
import contextlib
import copy
import tempfile
import threading
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


class ABackgroundChildsStepOutlivesTheTurnTests(unittest.TestCase):
    """A background sub-task's step that is still running when the parent's turn ends.

    The turn end settled EVERY running block, so a command still running read "Ran", and its result
    then opened a second block with no command ("$ Ran  · 2 lines"). A real TUI over a real _SubUI.
    """

    setUp = TuiStatusLineTests.setUp
    tui = TuiStatusLineTests.tui
    plain = staticmethod(TuiStatusLineTests.plain)

    def live_child(self, ui, label="Count the lines in README.md"):
        from dgc.agent import _SubUI
        child = _SubUI(ui, label, cancel=threading.Event())
        jobs = dict(getattr(self.agent, "_detached_jobs", None) or {})
        jobs[child.agent_id] = {"cancel": threading.Event(), "description": label}
        self.agent._detached_jobs = jobs
        self.addCleanup(setattr, self.agent, "_detached_jobs", {})
        return child

    def tool_blocks(self, ui, prefix=""):
        return [b for b in ui.blocks if isinstance(b, dict) and b.get("kind") == "tool"
                and str(b.get("call_id") or "").startswith(prefix)]

    def turn_ends(self, ui):
        ui._settle_running_tools()                 # what the turn worker's finally does
        ui._turn.clear()

    def test_the_step_keeps_its_command_progress_and_result(self):
        from dgc.agent import _SubUI
        ui = self.tui()
        child = self.live_child(ui)
        grandchild = _SubUI(child, "nested look")
        foreground = _SubUI(ui, "a child the turn waited on")     # not in _detached_jobs
        ui._turn.set()
        ui._turn_t0 = time.monotonic()
        child.tool_call("bash", {"command": "sleep 20; wc -l README.md"}, "c1")
        grandchild.tool_call("grep", {"pattern": "Deploy"}, "g1")
        foreground.tool_call("read_file", {"path": "a.py"}, "f1")
        ui.tool_call("bash", {"command": "echo parent"}, "p1")
        self.turn_ends(ui)
        step = ui._tool_block_by_call(f"{child.agent_id}:c1")
        self.assertTrue(step["running"], "the parent's turn end stopped a step still running")
        self.assertIn("Running sleep 20; wc -l README.md", self.plain(ui._tool_frags(step)))
        self.assertTrue(ui._tool_block_by_call(f"{child.agent_id}:{grandchild.agent_id}:g1")["running"])
        self.assertFalse(ui._tool_block_by_call(f"{foreground.agent_id}:f1")["running"],
                         "a child not running in the background settles with the turn")
        self.assertFalse(ui._tool_block_by_call("p1")["running"], "the turn's own steps still settle")
        child.tool_progress("bash", "halfway there", call_id="c1")
        self.assertIn("halfway there", self.plain(ui._tool_frags(step)),
                      "progress after the turn reached nothing")
        child.tool_result("bash", "exit code: 0\n3 README.md", "c1")
        steps = [b for b in self.tool_blocks(ui, child.agent_id + ":") if b.get("route_name") == "bash"]
        self.assertEqual(len(steps), 1, "the result opened a second block")
        text = self.plain(ui._tool_frags(steps[0]))
        for part in ("Ran sleep 20; wc -l README.md", "3 README.md"):
            self.assertIn(part, text)
        self.assertFalse([b for b in self.tool_blocks(ui) if not b.get("summary")],
                         "a tool block with no command")
        self.agent._detached_jobs = {}                               # the child has ended
        ui._settle_running_tools()
        self.assertFalse(ui._tool_block_by_call(f"{child.agent_id}:{grandchild.agent_id}:g1")["running"],
                         "what an ended child left open settles at the next turn end")

    def test_a_step_a_hook_blocked_is_closed_not_left_running(self):
        ui = self.tui()
        child = self.live_child(ui)
        ui._turn.set()
        child.tool_call("bash", {"command": "rm -rf build"}, "c1")
        child.tool_denied("bash", {"command": "rm -rf build"}, "PreToolUse hook", "c1")
        step = ui._tool_block_by_call(f"{child.agent_id}:c1")
        self.assertFalse(step["running"], "a blocked step never gets a result and read Running")
        self.assertTrue(step["error"])
        ui.tool_call("bash", {"command": "make"}, "p1")
        ui.tool_denied("bash", {"command": "make"}, "a denial with no id", None)
        self.assertTrue(ui._tool_block_by_call("p1")["running"],
                        "a denial without an id closed some other running block")

    def test_a_parallel_batch_straddling_the_turn_end_keeps_one_block_per_step(self):
        ui = self.tui()
        child = self.live_child(ui)
        ui._turn.set()
        for n in range(3):
            child.tool_call("read_file", {"path": f"f{n}.py"}, f"r{n}")
        self.turn_ends(ui)
        for n in range(3):
            child.tool_result("read_file", f"contents {n}", f"r{n}")
        steps = self.tool_blocks(ui, child.agent_id + ":")
        self.assertEqual([b["summary"] for b in steps], ["f0.py", "f1.py", "f2.py"])
        self.assertFalse([b for b in steps if b.get("running")])

    def test_another_turn_ending_meanwhile_leaves_the_step_whole(self):
        ui = self.tui()
        child = self.live_child(ui)
        ui._turn.set()
        child.tool_call("bash", {"command": "make build"}, "c1")
        self.turn_ends(ui)
        ui._turn.set()                                               # the user's next turn
        ui.tool_call("read_file", {"path": "notes.md"}, "q1")
        ui.tool_result("read_file", "notes", "q1")
        self.turn_ends(ui)
        child.tool_result("bash", "exit code: 0\nbuilt", "c1")
        steps = self.tool_blocks(ui, child.agent_id + ":")
        self.assertEqual(len(steps), 1)
        self.assertIn("built", self.plain(ui._tool_frags(steps[0])))


if __name__ == "__main__":
    unittest.main()
