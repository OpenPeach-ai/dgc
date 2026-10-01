"""The classic terminal's spinner never shares a row with what comes after it.

`dgc -p` printed "  ╱╱╱ wait_tasks… 1s   · esc to stop  [sub-…] Sub-task 'create notes.md'
completed …": wait_tasks reported progress, which restarts the spinner, and its result printed
straight onto the spinner's row. Every row that can follow a live spinner now wipes it first, and
one lock orders the spinner's frames against that wipe, so a frame can never land after it.

Tested on a real pseudo-terminal: the bytes the terminal received are replayed through a small
emulator (CR, ESC[K, LF), and no row on the final screen may hold the spinner.
"""
import os
import re
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from waiting import wait_until  # noqa: E402

from dgc import cli as cli_mod  # noqa: E402
from dgc.cli import UI  # noqa: E402

_CSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def screen(raw: str) -> list[str]:
    """The rows a terminal shows after receiving `raw`: CR, ESC[K and LF honoured, colours dropped."""
    rows, row, col, i = [], [], 0, 0
    while i < len(raw):
        match = _CSI.match(raw, i)
        if match:
            if match.group() == "\x1b[K":
                del row[col:]
            i = match.end()
            continue
        ch, i = raw[i], i + 1
        if ch == "\r":
            col = 0
        elif ch == "\n":
            rows.append("".join(row))
            row, col = [], 0
        else:
            row[col:col + 1] = [ch]
            col += 1
    rows.append("".join(row))
    return rows


@unittest.skipUnless(hasattr(os, "openpty"), "needs a pseudo-terminal")
class ClassicSpinnerOnATerminal(unittest.TestCase):
    def setUp(self):
        master, slave = os.openpty()
        self.raw = bytearray()
        self.raw_lock = threading.Lock()

        def read() -> None:
            while True:
                try:
                    chunk = os.read(master, 4096)
                except OSError:              # Linux: EIO once the slave side is closed
                    return
                if not chunk:                # macOS: EOF
                    return
                with self.raw_lock:
                    self.raw.extend(chunk)
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        tty = open(slave, "w", encoding="utf-8", buffering=1)
        patcher = mock.patch.object(sys, "stdout", tty)
        patcher.start()
        self.ui = UI()

        def cleanup() -> None:
            self.ui.stop_working()
            patcher.stop()
            tty.close()
            reader.join(5)
            os.close(master)
        self.addCleanup(cleanup)

    def received(self) -> bytes:
        with self.raw_lock:
            return bytes(self.raw)

    def spinner_frame(self) -> None:
        """Wait for the spinner to draw at least once from now on."""
        mark = len(self.received())
        wait_until(lambda: b"esc to stop" in self.received()[mark:], what="a spinner frame")

    def rows(self) -> list[str]:
        """The final screen. No row of it may still hold the spinner."""
        self.ui.stop_working()
        sys.stdout.write("<end>\n")
        sys.stdout.flush()
        wait_until(lambda: b"<end>" in self.received(), what="the end of the output")
        rows = screen(self.received().decode("utf-8", "replace"))
        self.assertFalse([row for row in rows if "esc to stop" in row],
                         "a spinner frame was left on a row of output:\n" + "\n".join(rows))
        return rows

    def test_a_wait_tasks_result_starts_on_its_own_row(self):
        ui = self.ui
        ui.tool_call("wait_tasks", {})
        ui.tool_progress("wait_tasks", "waiting on 1 background sub-task · 0s of 120s")
        self.spinner_frame()
        ui.tool_result("wait_tasks", "[sub-1] Sub-task 'create notes.md' completed and integrated "
                                     "1 path(s): notes.md.\nSummary:\nCreated notes.md.")
        rows = self.rows()
        self.assertIn("  [sub-1] Sub-task 'create notes.md' completed and integrated 1 path(s): "
                      "notes.md.", rows)
        self.assertIn("  Summary:", rows)

    def test_a_result_that_follows_another_result_starts_on_its_own_row(self):
        # Parallel reads, a vendor's parallel tools and a foreground task all print one result
        # after another, and every result restarts the spinner.
        ui = self.ui
        ui.tool_call("read_file", {"path": "a.py"})
        ui.tool_call("read_file", {"path": "b.py"})
        ui.tool_result("read_file", "alpha")
        self.spinner_frame()
        ui.tool_result("read_file", "bravo")
        self.assertIn("  bravo", self.rows())

    def test_image_rows_after_a_result_start_on_their_own_row(self):
        ui = self.ui
        ui.tool_result("view_image", "ok")
        self.spinner_frame()
        ui.tool_images("c1", [], meta=[{"path": "shot.png", "width": 4, "height": 3}])
        self.assertIsNotNone(ui._work_stop, "the spinner comes back after the image rows")
        self.assertIn("  ↳ image: shot.png (4×3)", self.rows())

    def test_a_hook_row_under_the_turn_spinner_starts_on_its_own_row(self):
        ui = self.ui
        ui.start_working()
        self.spinner_frame()
        ui.hook_activity("UserPromptSubmit", "completed", configured=1, duration_ms=180)
        self.assertIsNotNone(ui._work_stop, "the spinner comes back, so a stall can still rename it")
        self.assertIn("  · hook UserPromptSubmit completed · 1 configured · 180ms", self.rows())

    def test_a_print_run_plan_leaves_no_spinner_row(self):
        ui = self.ui
        ui.non_interactive = True
        ui.start_working()
        self.spinner_frame()
        ui.present_plan("# Plan\n1. do it")
        self.rows()

    def test_a_result_never_wipes_text_when_no_spinner_is_drawing(self):
        # The wipe is the spinner's own: thinking text left mid-row must survive the next result.
        ui = self.ui
        ui.on_thinking("pondering")
        ui.tool_result("task", "done")
        rows = self.rows()
        self.assertTrue([row for row in rows if "pondering" in row], rows)

    def test_a_print_run_ends_without_a_live_spinner(self):
        ui = self.ui

        class FakeAgent:
            messages = [{"role": "assistant", "content": "done"}]
            _detached_jobs: dict = {}

            def run_turn(self, prompt):
                ui.tool_call("bash", {"command": "true"})
                ui.tool_result("bash", "ok")        # the turn ends on a result: spinner drawing
                return True
        cli = SimpleNamespace(ui=ui, agent=FakeAgent(), expand_mentions=lambda text: text)
        args = SimpleNamespace(prompt="go", output_format="text", output=None, print_session_id=False,
                               cont=False, resume=None, model=None, think=None)
        with mock.patch.object(cli_mod, "_oneshot_prompt", lambda prompt: prompt):
            self.assertEqual(cli_mod._run_oneshot(cli, SimpleNamespace(data={}), args, None, ""), 0)
        self.assertIsNone(ui._work_stop, "dgc -p ended with the spinner still drawing")
        self.rows()


class SpinnerStopIsFinal(unittest.TestCase):
    def test_a_frame_that_raced_the_stop_is_never_written_after_the_wipe(self):
        writes: list[str] = []

        class FakeTTY:
            def isatty(self):
                return True

            def write(self, text):
                writes.append(text)
                return len(text)

            def flush(self):
                pass

        class Gate:
            """An RLock whose acquisition parks the spinner thread until the test lets it go."""

            def __init__(self):
                self._lock = threading.RLock()
                self.parked, self.go = threading.Event(), threading.Event()

            def __enter__(self):
                if threading.current_thread().name == "dgc-spinner":
                    self.parked.set()           # its wait() timed out and its frame is composed
                    self.go.wait(10)
                self._lock.acquire()
                return self

            def __exit__(self, *exc):
                self._lock.release()
                return False

        with mock.patch.object(sys, "stdout", FakeTTY()):
            ui = UI()
            gate = ui._work_lock = Gate()
            ui.start_working("x")
            wait_until(gate.parked.is_set, what="the spinner composing a frame")
            spinner = next(t for t in threading.enumerate() if t.name == "dgc-spinner")
            ui.stop_working()                   # the wipe lands while that frame is pending
            gate.go.set()
            spinner.join(5)
        self.assertFalse(spinner.is_alive())
        self.assertEqual(writes, ["\r\x1b[K"], "a spinner frame was written after its wipe")


class AOneShotRunStopsItsChildren(unittest.TestCase):
    """`dgc -p` exits with its turn; a background child still running is stopped, not killed."""

    def agent(self, *, finishes: bool):
        calls = []

        class FakeAgent:
            def __init__(self):
                self._detached_jobs = {"sub-0123456789ab": {"description": "x"}}

            def stop_detached(self):
                calls.append("stop")
                if finishes:
                    self._detached_jobs = {}     # the child winds down and retains its work
                return 1

            def wait_finalizers(self, timeout):
                calls.append(("wait", timeout))
                return ""
        return FakeAgent(), calls

    def test_a_running_child_is_stopped_and_waited_for(self):
        agent, calls = self.agent(finishes=True)
        with mock.patch.object(sys, "stderr") as err:
            self.assertEqual(cli_mod._end_one_shot_children(agent, grace_s=2), 1)
        self.assertEqual(calls, ["stop", ("wait", 2.0)])
        self.assertIn("stopped 1 background sub-task", "".join(c.args[0] for c in err.write.call_args_list))

    def test_the_wait_is_bounded(self):
        agent, calls = self.agent(finishes=False)
        with mock.patch.object(sys, "stderr"):
            self.assertEqual(cli_mod._end_one_shot_children(agent, grace_s=0.2), 1)
        self.assertEqual(calls[0], "stop")

    def test_the_print_run_stops_them_once_its_turn_is_over(self):
        agent, calls = self.agent(finishes=True)
        agent.messages = [{"role": "assistant", "content": "done"}]
        agent.run_turn = lambda prompt: calls.append("turn") or True
        cli = SimpleNamespace(ui=UI(), agent=agent, expand_mentions=lambda text: text)
        args = SimpleNamespace(prompt="go", output_format="text", output=None, print_session_id=False,
                               cont=False, resume=None, model=None, think=None)
        with mock.patch.object(cli_mod, "_oneshot_prompt", lambda prompt: prompt), \
                mock.patch.object(sys, "stderr"), mock.patch.object(sys, "stdout"):
            self.assertEqual(cli_mod._run_oneshot(cli, SimpleNamespace(data={}), args, None, ""), 0)
        self.assertEqual(calls[:2], ["turn", "stop"], "the child was left to die with the process")

    def test_nothing_running_means_nothing_to_do(self):
        agent, calls = self.agent(finishes=True)
        agent._detached_jobs = {}
        self.assertEqual(cli_mod._end_one_shot_children(agent), 0)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
