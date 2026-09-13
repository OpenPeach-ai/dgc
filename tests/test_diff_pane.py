"""The /diff panel: a real git repository, a real diff, and a real composer insertion."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from dgc.diffpane import DiffPane, GitLoader, _unified
from dgc.pane import render_frame
import dgc.style as style_mod


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=root, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Host:
    def __init__(self):
        self.inserted: list[str] = []
        self.flashes: list[str] = []
        self.mode = "default"
        self.config = None

    def insert_reference(self, text: str) -> None:
        self.inserted.append(text)

    def flash(self, message: str) -> None:
        self.flashes.append(message)

    def changed_paths(self):
        return set()

    def agent_busy(self):
        return False


class DiffPaneTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-diff-"))
        _git(self.root, "init", "-q")
        (self.root / "app.py").write_text("def clamp(v, lo, hi):\n    return min(lo, max(hi, v))\n\n"
                                          "def other():\n    return 1\n")
        (self.root / "keep.txt").write_text("unchanged\n")
        _git(self.root, "add", ".")
        _git(self.root, "commit", "-q", "-m", "base")
        # the working tree: one edit, one new file, one deletion
        (self.root / "app.py").write_text("def clamp(v, lo, hi):\n    return max(lo, min(hi, v))\n\n"
                                          "def other():\n    return 1\n")
        (self.root / "new.md").write_text("# fresh\nline two\n")
        (self.root / "keep.txt").unlink()
        self.host = Host()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def pane(self, **kw) -> DiffPane:
        return DiffPane(self.root, host=self.host, threaded=False, now=0.0, **kw)

    # --------------------------------------------------------------------------- data ----
    def test_lists_every_changed_file_with_counts(self):
        pane = self.pane()
        paths = {row["path"]: row for row in pane.files}
        self.assertEqual(set(paths), {"app.py", "new.md", "keep.txt"})
        self.assertEqual((paths["app.py"]["additions"], paths["app.py"]["deletions"]), (1, 1))
        self.assertTrue(paths["new.md"]["untracked"])
        self.assertEqual(paths["new.md"]["additions"], 2)
        self.assertTrue(paths["keep.txt"]["deleted"])
        self.assertFalse(pane.loading)

    def test_unified_diff_rows_carry_kinds_and_new_line_numbers(self):
        rows = _unified("a\nb\nc\n", "a\nB\nc\nd\n", "x.txt")
        kinds = [k for k, _, _ in rows]
        self.assertEqual(kinds[0], "hunk")
        self.assertIn("del", kinds)
        self.assertIn("add", kinds)
        added = [(t, n) for k, t, n in rows if k == "add"]
        self.assertEqual(added, [("B", 2), ("d", 4)], "added rows are numbered on the new side")
        self.assertTrue(all(n is None for k, _, n in rows if k == "del"))

    def test_non_git_directory_says_so_instead_of_failing(self):
        plain = Path(tempfile.mkdtemp(prefix="dgc-nogit-"))
        try:
            pane = DiffPane(plain, host=self.host, threaded=False, now=0.0)
            self.assertEqual(pane.files, [])
            self.assertFalse(pane.complete)
            frame = pane.snapshot(80, 10)
            text = "".join(seg.text for row in frame.lines for seg in row)
            self.assertIn("incomplete", text.lower())
        finally:
            shutil.rmtree(plain, ignore_errors=True)

    # ---------------------------------------------------------------------- navigation ----
    def test_open_diff_and_move_through_it(self):
        pane = self.pane()
        pane.cursor = [r["path"] for r in pane.files].index("app.py")
        self.assertEqual(pane.handle_key("enter"), "changed")
        self.assertEqual(pane.mode, "diff")
        self.assertEqual(pane.diff_path, "app.py")
        self.assertTrue(any(k == "add" and "max(lo, min(hi, v))" in t for k, t, _ in pane.diff_rows))
        start = pane.line
        pane.handle_key("j"); pane.handle_key("j")
        self.assertEqual(pane.line, start + 2)
        pane.handle_key("G")
        self.assertEqual(pane.line, len(pane.diff_rows) - 1)
        pane.handle_key("g")
        self.assertEqual(pane.line, 0)
        self.assertEqual(pane.handle_key("h"), "changed")
        self.assertEqual(pane.mode, "list")

    def test_next_file_from_inside_a_diff(self):
        pane = self.pane()
        pane.cursor = 0
        pane.handle_key("enter")
        first = pane.diff_path
        pane.handle_key("J")
        self.assertNotEqual(pane.diff_path, first)
        self.assertEqual(pane.mode, "diff")

    def test_q_and_escape_return_to_dgc(self):
        pane = self.pane()
        self.assertEqual(pane.handle_key("q"), "exit")
        pane = self.pane()
        self.assertEqual(pane.handle_key("escape"), "exit")

    # ----------------------------------------------------------------------- selection ----
    def test_selected_lines_are_attached_to_the_prompt_as_a_fenced_snippet(self):
        pane = self.pane()
        pane.cursor = [r["path"] for r in pane.files].index("app.py")
        pane.handle_key("enter")
        # find the removed and added lines and select across them
        rows = pane.diff_rows
        del_i = next(i for i, r in enumerate(rows) if r[0] == "del")
        add_i = next(i for i, r in enumerate(rows) if r[0] == "add")
        pane.line = min(del_i, add_i)
        pane.handle_key("space")                       # anchor
        while pane.line < max(del_i, add_i):
            pane.handle_key("j")
        self.assertEqual(pane.handle_key("enter"), "changed")
        self.assertEqual(len(self.host.inserted), 1)
        snippet = self.host.inserted[0]
        self.assertIn("From the /diff panel · app.py · working tree vs HEAD", snippet)
        self.assertIn("```diff\n", snippet)
        self.assertIn("-    return min(lo, max(hi, v))", snippet)
        self.assertIn("+    return max(lo, min(hi, v))", snippet)
        self.assertTrue(snippet.endswith("```\n"))
        self.assertNotIn("@", snippet.split("\n")[0][:1], "no @mention: the whole file must not be expanded")
        self.assertIsNone(pane.anchor, "the selection clears once attached")
        self.assertIn("attached", pane.status)

    def test_enter_without_a_selection_explains_instead_of_inserting(self):
        pane = self.pane()
        pane.cursor = [r["path"] for r in pane.files].index("app.py")
        pane.handle_key("enter")
        pane.handle_key("enter")
        self.assertEqual(self.host.inserted, [])
        self.assertIn("Space selects", pane.status)

    def test_a_attaches_the_whole_hunk(self):
        pane = self.pane()
        pane.cursor = [r["path"] for r in pane.files].index("app.py")
        pane.handle_key("enter")
        pane.line = next(i for i, r in enumerate(pane.diff_rows) if r[0] == "add")
        pane.handle_key("a")
        self.assertEqual(len(self.host.inserted), 1)
        self.assertIn("-    return min(lo, max(hi, v))", self.host.inserted[0])
        self.assertIn("+    return max(lo, min(hi, v))", self.host.inserted[0])

    def test_escape_clears_a_selection_before_it_leaves_the_diff(self):
        pane = self.pane()
        pane.cursor = 0
        pane.handle_key("enter")
        pane.handle_key("space")
        self.assertIsNotNone(pane.anchor)
        pane.handle_key("escape")
        self.assertIsNone(pane.anchor)
        self.assertEqual(pane.mode, "diff", "the first Esc only drops the selection")
        pane.handle_key("escape")
        self.assertEqual(pane.mode, "list")

    # -------------------------------------------------------------------------- frames ----
    def test_frame_is_exactly_the_requested_height_at_every_width(self):
        th = style_mod.theme()
        pane = self.pane()
        for width in (24, 48, 70, 110, 160):
            for mode in ("list", "diff"):
                if mode == "diff":
                    pane.cursor = 0
                    pane.handle_key("enter")
                else:
                    pane.mode = "list"
                frame = pane.snapshot(width - 2, 14 - 2)
                rendered = render_frame(frame, width, 14, agent_state="IDLE", theme=th)
                lines = rendered.plain.split("\n")
                self.assertEqual(len(lines), 14, f"{mode}@{width}: {len(lines)} rows")
                for line in lines:
                    self.assertLessEqual(len(line), width, f"{mode}@{width} overflowed")

    def test_wide_pane_shows_list_and_diff_side_by_side(self):
        pane = self.pane()
        pane.cursor = [r["path"] for r in pane.files].index("app.py")
        pane.handle_key("enter")
        frame = pane.snapshot(118, 12)
        joined = ["".join(seg.text for seg in row) for row in frame.lines]
        self.assertTrue(any("│" in row for row in joined), "a rule separates the two columns")
        self.assertTrue(any("app.py" in row for row in joined))
        self.assertTrue(any("max(lo, min(hi, v))" in row for row in joined))

    def test_narrow_pane_shows_one_view_and_tab_swaps_it(self):
        pane = self.pane()
        frame = pane.snapshot(50, 10)
        joined = ["".join(seg.text for seg in row) for row in frame.lines]
        self.assertFalse(any("│" in row for row in joined), "no side-by-side at 50 columns")
        self.assertIn("changed files", joined[0])
        pane.handle_key("tab")
        self.assertEqual(pane.view, "diff")

    def test_help_lists_the_keys_and_closes(self):
        pane = self.pane()
        pane.handle_key("?")
        self.assertEqual(pane.mode, "help")
        text = "".join(seg.text for row in pane.snapshot(100, 12).lines for seg in row)
        self.assertIn("attach", text)
        pane.handle_key("?")
        self.assertEqual(pane.mode, "list")

    def test_score_summarises_the_change_set(self):
        pane = self.pane()
        frame = pane.snapshot(100, 10)
        self.assertRegex(frame.score, r"3 files · \+\d+ −\d+")

    def test_refresh_picks_up_new_edits(self):
        pane = self.pane()
        before = {r["path"] for r in pane.files}
        (self.root / "another.py").write_text("x = 1\n")
        pane.handle_key("r")
        self.assertIn("another.py", {r["path"] for r in pane.files} - before)

    def test_pending_start_opens_that_file(self):
        pane = self.pane(start="new.md")
        self.assertEqual(pane.mode, "diff")
        self.assertEqual(pane.diff_path, "new.md")
        self.assertTrue(all(k in ("hunk", "add") for k, _, _ in pane.diff_rows))

    def test_loader_failure_never_raises_out_of_the_pane(self):
        class Broken:
            def changes(self, cancel=None):
                raise RuntimeError("boom")

            def diff(self, path, cancel=None):
                raise RuntimeError("boom")

        pane = DiffPane(self.root, host=self.host, loader=Broken(), threaded=False, now=0.0)
        self.assertEqual(pane.files, [])
        self.assertIn("could not read changes", " ".join(pane.notices))
        frame = pane.snapshot(80, 8)
        self.assertEqual(len(frame.lines), 8)


class RealTuiSmokeTests(unittest.TestCase):
    """Drive the real prompt_toolkit application through pipe input: /diff must open in the focus
    pane, take its keys through the eager bindings, put a selection into the real composer, and
    close on q."""

    def test_diff_pane_through_the_real_key_bindings(self):
        import threading
        import time
        from types import SimpleNamespace
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput
        from dgc.tui import TUI

        tmp = tempfile.TemporaryDirectory(prefix="dgc-diff-smoke-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name).resolve()
        _git(root, "init", "-q")
        (root / "clamp.py").write_text("def clamp(v, lo, hi):\n    return min(lo, max(hi, v))\n")
        _git(root, "add", ".")
        _git(root, "commit", "-q", "-m", "base")
        (root / "clamp.py").write_text("def clamp(v, lo, hi):\n    return max(lo, min(hi, v))\n")
        (root / "NOTES.md").write_text("new\n")

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=30, columns=120)

        class Cfg:
            project_root = root
            model = "fixture"
            base_url = "http://fixture"
            data = {"mode": "default"}

            def get(self, key, default=None):
                return {"theme": "dark", "context_size": 32768, "logo_animation": False,
                        "suggest": False, "trash_mode": "dgc", "eta": True}.get(key, default)

        class Agent:
            def __init__(self, config):
                self.config = config
                self.cancelled = threading.Event()
                self.messages = []
                self.session_name = "diff-smoke"
                self.mode = "default"
                self.ui = None

            def estimate_tokens(self):
                return 0

            def context_size(self):
                return 32768

            def steer(self, text):
                return False

            def eta_snapshot(self):
                return None

        def eventually(predicate, timeout=3.0):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    if predicate():
                        return True
                except Exception:
                    pass
                time.sleep(0.01)
            return False

        with create_pipe_input() as pipe:
            with create_app_session(input=pipe, output=Output()):
                cfg = Cfg()
                ui = TUI(cfg, agent=Agent(cfg))
                ui._arcade_scores = SimpleNamespace(best=lambda key: 0, refresh=lambda: None,
                                                    record=lambda key, value: value)
                thread = threading.Thread(target=ui.app.run, daemon=True)
                thread.start()
                try:
                    pipe.send_text("/diff\r")
                    self.assertTrue(eventually(lambda: getattr(ui._pane, "kind", "") == "diff"), "/diff opens the pane")
                    pane = ui._pane
                    self.assertTrue(eventually(lambda: not pane.loading and len(pane.files) == 2), "git is read off-thread")
                    self.assertEqual([r["path"] for r in pane.files], ["NOTES.md", "clamp.py"])
                    self.assertTrue(ui._pane_height() >= 4)
                    frame = ui._render_pane()
                    self.assertIn("DIFF", getattr(frame, "value", str(frame)))
                    pipe.send_text("j")
                    self.assertTrue(eventually(lambda: pane.cursor == 1), "j moves the cursor")
                    pipe.send_text("\r")
                    self.assertTrue(eventually(lambda: pane.mode == "diff" and pane.diff_path == "clamp.py"), "Enter opens the diff")
                    del_row = next(i for i, r in enumerate(pane.diff_rows) if r[0] == "del")
                    for _ in range(del_row):
                        pipe.send_text("j")
                    self.assertTrue(eventually(lambda: pane.line == del_row), "j walks the diff rows")
                    pipe.send_text(" ")
                    self.assertTrue(eventually(lambda: pane.anchor == del_row), "Space anchors a selection")
                    pipe.send_text("j")
                    self.assertTrue(eventually(lambda: pane.line == del_row + 1))
                    pipe.send_text("\r")
                    self.assertTrue(eventually(lambda: "```diff" in ui.input_buf.text), "Enter attaches the selection to the composer")
                    self.assertIn("-    return min(lo, max(hi, v))", ui.input_buf.text)
                    self.assertIn("+    return max(lo, min(hi, v))", ui.input_buf.text)
                    self.assertIn("clamp.py", ui.input_buf.text)
                    pipe.send_text("?")
                    self.assertTrue(eventually(lambda: pane.mode == "help"))
                    pipe.send_text("?")
                    self.assertTrue(eventually(lambda: pane.mode == "diff"))
                    pipe.send_text("q")
                    self.assertTrue(eventually(lambda: ui._pane is None), "q closes the pane")
                    self.assertIn("```diff", ui.input_buf.text, "closing the pane keeps the draft")
                finally:
                    if ui.app:
                        ui.app.exit()
                    thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
