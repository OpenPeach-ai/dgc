"""The terminal draws a finished background agent's report as one dim line that opens to it.

Before, a sub-task's wake was a band that read like a typed prompt ("sub-task · woke on its result")
over a card headed "Sub-task result" with the report's first lines spilling out of it. Now each
finished agent gets "○ ▸ Woke on agent · <what it was asked>", folded, opening on a click or /expand
to what became of its changes and what it reported; a reopened chat draws the same lines, also for a
chat the editor ran (its wake notice is DGC's, never a prompt someone typed).
"""
from __future__ import annotations

import contextlib
import os
import pwd
import sys
import tempfile
import unittest
from pathlib import Path

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:                    # imported by another module first: verify, never assume
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_tui_agent_reports.py needs HOME redirected before dgc is imported")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-tui-agent-reports-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc.agent import Agent                                        # noqa: E402
from dgc.headless import _agent_wake_prompt as wake_prompt        # noqa: E402
from dgc.llm import ChatResult                                     # noqa: E402
from test_monitors_tui import _SilentUI, make_config              # noqa: E402

INTEGRATED = ("Sub-task 'Review billing.py' completed and integrated 2 path(s): billing.py, "
              "test_billing.py.\nSummary:\nThe rounding bug is in total(): it rounded each line.\n"
              "Fixed it to round once and added a test.")
HELD = ("Sub-task 'Port the CLI' completed but its changes were NOT integrated: conflict. Conflicts: "
        "cli.py. The isolated worktree is preserved at /work/.dgc/worktrees/sub-1 on branch dgc/sub-1.\n"
        "Summary:\nPorted the argument parser.")


class TuiAgentReportTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-tui-agent-reports-")
        self.addCleanup(directory.cleanup)
        self.config = make_config(Path(directory.name))
        self.agent = Agent(self.config, _SilentUI())
        self.addCleanup(self.agent.mcp.stop_all)
        self.addCleanup(lambda: self.agent.monitors.shutdown(wait=3.0))

    def tui(self):
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput
        from dgc.tui import TUI

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=30, columns=120)

        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        pipe = stack.enter_context(create_pipe_input())
        stack.enter_context(create_app_session(input=pipe, output=Output()))
        return TUI(self.config, agent=self.agent)

    @staticmethod
    def plain(frags) -> str:
        from prompt_toolkit.formatted_text import fragment_list_to_text
        return fragment_list_to_text(frags)

    def lines(self, ui, blocks):
        return [b for b in blocks if isinstance(b, dict) and b.get("kind") == "handback"]

    def wake(self, ui, *finished):
        sess = ui.active
        self.agent._chat = lambda *a, **k: ChatResult(content="Both helpers are done.")
        hub = self.agent.monitors
        for agent_id, description, message, integrated in finished:
            hub.queue_subtask_ended(agent_id, description, message, integrated, hub.epoch)
        ui._submit_monitor_wake(sess, hub.take_pending())
        worker = sess._worker_thread
        worker.join(10)
        self.assertFalse(worker.is_alive())
        return sess

    def test_a_finished_agent_is_one_dim_folded_line_not_a_band_and_a_card(self):
        ui = self.tui()
        sess = self.wake(ui, ("sub-0123456789ab", "Review billing.py", INTEGRATED, True))
        self.assertEqual([b for b in sess.blocks if isinstance(b, dict) and b.get("kind") == "user"], [],
                         "nobody typed it: no band that reads like a prompt")
        self.assertEqual([b for b in sess.blocks if isinstance(b, dict) and b.get("kind") == "tool"], [])
        [line] = self.lines(ui, sess.blocks)
        folded = self.plain(ui._handback_frags(line))
        self.assertEqual(folded, "○ ▸ Woke on agent · Review billing.py")
        th = __import__("dgc.style", fromlist=["theme"]).theme()
        self.assertEqual(ui._handback_frags(line)[0][0], f"fg:{th.faint}", "dim, like the rest of DGC's notes")
        self.assertEqual(ui._block_lines(line), 1)

    def test_a_click_opens_it_to_the_note_and_the_report_and_closes_it_again(self):
        from prompt_toolkit.mouse_events import MouseEvent, MouseEventType
        ui = self.tui()
        sess = self.wake(ui, ("sub-0123456789ab", "Review billing.py", INTEGRATED, True))
        [line] = self.lines(ui, sess.blocks)
        toggle = ui._handback_frags(line)[0][2]
        toggle(MouseEvent(position=None, event_type=MouseEventType.MOUSE_UP, button=None, modifiers=frozenset()))
        opened = self.plain(ui._handback_frags(line)).splitlines()
        self.assertEqual(opened[0], "○ ▾ Woke on agent · Review billing.py")
        self.assertIn("completed and integrated 2 path(s): billing.py, test_billing.py.", opened[1])
        self.assertIn("The rounding bug is in total(): it rounded each line.", "\n".join(opened))
        self.assertTrue(all(row.startswith("  ┃ ") for row in opened[1:]), opened)
        self.assertEqual(ui._block_lines(line), len(opened))
        toggle(MouseEvent(position=None, event_type=MouseEventType.MOUSE_UP, button=None, modifiers=frozenset()))
        self.assertEqual(self.plain(ui._handback_frags(line)), "○ ▸ Woke on agent · Review billing.py")

    def test_expand_opens_the_last_report_from_the_keyboard(self):
        ui = self.tui()
        sess = self.wake(ui, ("sub-0123456789ab", "Review billing.py", INTEGRATED, True),
                         ("sub-ba9876543210", "Port the CLI", HELD, False))
        first, second = self.lines(ui, sess.blocks)
        self.assertEqual([self.plain(ui._handback_frags(b)) for b in (first, second)],
                         ["○ ▸ Woke on agent · Review billing.py", "○ ▸ Woke on agent · Port the CLI"],
                         "one line per finished agent")
        ui._handle_slash("/expand")
        self.assertEqual((first["exp"], second["exp"]), (False, True))
        opened = self.plain(ui._handback_frags(second))
        self.assertIn("NOT integrated", opened)
        self.assertIn("/work/.dgc/worktrees/sub-1", opened)
        self.assertIn("Ported the argument parser.", opened)
        ui._handle_slash("/expandall")
        self.assertTrue(first["exp"])

    def test_a_reopened_chat_draws_the_same_lines(self):
        ui = self.tui()
        self.wake(ui, ("sub-0123456789ab", "Review billing.py", INTEGRATED, True),
                  ("sub-ba9876543210", "Port the CLI", HELD, False))
        rows = [row for chunk, _ in ui._message_rows(self.agent.messages) for row in chunk]
        blocks, _ = ui._history_blocks(rows)
        self.assertEqual([b for b in blocks if isinstance(b, dict) and b.get("kind") == "user"], [])
        replayed = self.lines(ui, blocks)
        self.assertEqual([(b["label"], b["note"].split(":")[0]) for b in replayed],
                         [("Review billing.py", "Sub-task 'Review billing.py' completed and integrated 2 path(s)"),
                          ("Port the CLI", "Sub-task 'Port the CLI' completed but its changes were NOT integrated")])
        self.assertTrue(replayed[0]["said"].startswith("The rounding bug"))
        self.assertTrue(all(not b["exp"] for b in replayed), "folded after a reload too")

    def test_a_chat_the_editor_ran_shows_its_wake_as_the_agents_line_not_a_prompt(self):
        ui = self.tui()
        prompt = wake_prompt({"id": "sub-0123456789ab", "description": "Review billing.py",
                              "message": INTEGRATED, "integrated": True})
        self.agent.messages += [{"role": "user", "content": "review billing in the background"},
                                {"role": "assistant", "content": "Started a helper."},
                                {"role": "user", "content": prompt},
                                {"role": "assistant", "content": "The helper fixed the rounding."}]
        rows = [row for chunk, _ in ui._message_rows(self.agent.messages) for row in chunk]
        blocks, marks = ui._history_blocks(rows)
        users = [b["text"] for b in blocks if isinstance(b, dict) and b.get("kind") == "user"]
        self.assertEqual(users, ["review billing in the background"])
        self.assertEqual(len(marks), 1, "/jump lists only what someone typed")
        [line] = self.lines(ui, blocks)
        self.assertEqual(self.plain(ui._handback_frags(line)), "○ ▸ Woke on agent · Review billing.py")
        self.assertIn("completed and integrated", line["note"])

    def test_a_monitor_wake_keeps_its_band(self):
        ui = self.tui()
        sess = ui.active
        self.agent._chat = lambda *a, **k: ChatResult(content="noted")
        hub = self.agent.monitors
        hub.queue_background_exit("bg2", "make build", 0, 3.0, "built", hub.epoch)
        ui._submit_monitor_wake(sess, hub.take_pending())
        worker = sess._worker_thread
        worker.join(10)
        bands = [b.get("tag") for b in sess.blocks if isinstance(b, dict) and b.get("kind") == "user"]
        self.assertEqual(bands, ["background command · woke on its exit"])
        self.assertEqual(self.lines(ui, sess.blocks), [])


if __name__ == "__main__":
    unittest.main()
