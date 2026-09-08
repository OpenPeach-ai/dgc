"""The /files explorer: listings, operations with undo, both trash routes, policy by mode, keys,
and cell-exact frames. Everything runs on temporary trees; no model, Git transport, or shell."""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from dgc.files import FilesPane, FilesPaneError
from dgc.files.model import human_size, natural_key, scan, sort_entries
from dgc.files.ops import FileOps, OpError, Trash, validate_name
from dgc.pane import render_frame
from dgc.style import theme


class Host:
    def __init__(self, mode="acceptEdits", config=None):
        self.mode = mode
        self.config = config
        self.inserted: list[str] = []
        self.flashes: list[str] = []
        self.changed: set[str] = set()

    def flash(self, message):
        self.flashes.append(message)

    def insert_reference(self, text):
        self.inserted.append(text)

    def changed_paths(self):
        return set(self.changed)


def drive(pane: FilesPane, *keys: str, now: float = 1.0) -> list[str]:
    results = []
    for key in keys:
        if len(key) == 1 and pane.raw_text_input:
            results.append("changed" if pane.handle_text(key) else "ignored")
        else:
            results.append(pane.handle_key(key, now=now))
    return results


def type_text(pane: FilesPane, text: str) -> None:
    for ch in text:
        pane.handle_text(ch)


class FilesModelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-files-")
        self.root = Path(self.tmp.name).resolve()
        (self.root / "b_dir").mkdir()
        (self.root / "a_dir").mkdir()
        (self.root / "file10.txt").write_text("x" * 10)
        (self.root / "file2.txt").write_text("x" * 2000)
        (self.root / ".secret").write_text("")
        os.symlink("a_dir", self.root / "link_to_dir")

    def tearDown(self):
        self.tmp.cleanup()

    def test_scan_sorts_dirs_first_naturally_and_hides_dotfiles(self):
        listing = scan(self.root)
        self.assertEqual([e.name for e in listing.entries],
                         ["a_dir", "b_dir", "link_to_dir", "file2.txt", "file10.txt"])
        self.assertEqual(listing.total, 6)
        self.assertTrue(scan(self.root, show_hidden=True).entries[-1].hidden or
                        any(e.name == ".secret" for e in scan(self.root, show_hidden=True).entries))
        link = next(e for e in listing.entries if e.name == "link_to_dir")
        self.assertEqual(link.kind, "link")
        self.assertTrue(link.is_dir)

    def test_sort_modes_and_filter(self):
        entries = scan(self.root).entries
        by_size = [e.name for e in sort_entries(entries, "size") if not e.is_dir]
        self.assertEqual(by_size, ["file2.txt", "file10.txt"])
        self.assertEqual([e.name for e in scan(self.root, pattern="FILE").entries], [])
        self.assertEqual([e.name for e in scan(self.root, pattern="file").entries],
                         ["file2.txt", "file10.txt"])
        self.assertLess(natural_key("file2"), natural_key("file10"))
        self.assertEqual(human_size(0), "0B")
        self.assertEqual(human_size(2000), "2.0K")

    def test_scan_reports_missing_directory_without_raising(self):
        listing = scan(self.root / "gone")
        self.assertEqual(listing.entries, [])
        self.assertTrue(listing.error)


class FileOpsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-ops-")
        self.root = Path(self.tmp.name).resolve()
        self.trash_dir = self.root / "_trash"
        self.ops = FileOps(Trash("dgc", dgc_dir=self.trash_dir))
        (self.root / "work").mkdir()
        (self.root / "work" / "note.txt").write_text("hello")

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_rename_and_undo(self):
        result = self.ops.create(self.root / "work", "new.txt")
        self.assertIn("created", result.message)
        self.assertTrue((self.root / "work" / "new.txt").is_file())
        folder = self.ops.create(self.root / "work", "nested/deep/")
        self.assertIn("folder", folder.message)
        self.assertTrue((self.root / "work" / "nested" / "deep").is_dir())
        renamed = self.ops.rename(self.root / "work" / "new.txt", "renamed.txt")
        self.assertIn("renamed", renamed.message)
        self.assertTrue((self.root / "work" / "renamed.txt").exists())
        with self.assertRaises(OpError):
            self.ops.rename(self.root / "work" / "renamed.txt", "note.txt")   # collision
        self.assertIn("renamed back", self.ops.undo().message)
        self.assertTrue((self.root / "work" / "new.txt").exists())
        self.ops.undo()                                                       # nested/deep
        self.assertIn("removed new.txt", self.ops.undo().message)
        self.assertFalse((self.root / "work" / "new.txt").exists())
        with self.assertRaises(OpError):
            self.ops.undo()

    def test_undo_of_create_keeps_a_file_the_user_edited(self):
        self.ops.create(self.root / "work", "draft.txt")
        target = self.root / "work" / "draft.txt"
        target.write_text("typed something")
        os.utime(target, (1, 1))
        self.assertIn("left in place", self.ops.undo().message)
        self.assertTrue(target.exists())

    def test_copy_move_with_collisions_and_undo(self):
        src = self.root / "work" / "note.txt"
        dest = self.root / "dest"
        dest.mkdir()
        (dest / "note.txt").write_text("existing")
        copied = self.ops.copy([src], dest)
        self.assertEqual((dest / "note (2).txt").read_text(), "hello")
        self.assertEqual((dest / "note.txt").read_text(), "existing")
        self.assertIn("removed 1 copied", self.ops.undo().message)
        self.assertFalse((dest / "note (2).txt").exists())
        overwritten = self.ops.copy([src], dest, overwrite=True)
        self.assertEqual((dest / "note.txt").read_text(), "hello")
        self.ops.undo()
        self.assertEqual((dest / "note.txt").read_text(), "existing", "overwrite undo restores the snapshot")
        moved = self.ops.move([src], dest)
        self.assertFalse(src.exists())
        self.assertTrue((dest / "note (2).txt").exists())
        self.assertIn("moved 1 item(s) back", self.ops.undo().message)
        self.assertTrue(src.exists())
        with self.assertRaises(OpError):
            self.ops.move([self.root / "work"], self.root / "work" / "inner")
        self.assertIn("copied", copied.message)
        self.assertIn("copied", overwritten.message)
        self.assertIn("moved", moved.message)

    def test_dgc_trash_round_trip_and_prune(self):
        src = self.root / "work" / "note.txt"
        result = self.ops.send_to_trash([src])
        self.assertIn("DGC trash", result.message)
        self.assertFalse(src.exists())
        buckets = [p for p in self.trash_dir.iterdir() if p.is_dir()]
        self.assertEqual(len(buckets), 1)
        self.assertTrue((buckets[0] / "manifest.json").exists())
        self.assertIn("restored 1", self.ops.undo().message)
        self.assertEqual(src.read_text(), "hello")
        self.ops.send_to_trash([src])
        self.assertEqual(self.ops.trash.prune(now=4e9), 1, "old buckets are pruned")

    def test_os_trash_uses_the_freedesktop_layout_on_linux(self):
        if os.name != "posix" or os.uname().sysname == "Darwin":
            self.skipTest("freedesktop trash layout is Linux-only")
        home = self.root / "home"
        home.mkdir()
        os.environ["XDG_DATA_HOME"] = str(home / "share")
        try:
            ops = FileOps(Trash("os", dgc_dir=self.trash_dir, home=home))
            src = self.root / "work" / "note.txt"
            self.assertIn("OS trash", ops.send_to_trash([src]).message)
            files = home / "share" / "Trash" / "files"
            info = home / "share" / "Trash" / "info"
            self.assertTrue((files / "note.txt").exists())
            self.assertIn("[Trash Info]", (info / "note.txt.trashinfo").read_text())
            ops.undo()
            self.assertTrue(src.exists())
        finally:
            os.environ.pop("XDG_DATA_HOME", None)

    def test_permanent_delete_restores_files_but_not_folders(self):
        src = self.root / "work" / "note.txt"
        folder = self.root / "work" / "sub"
        folder.mkdir()
        (folder / "x").write_text("1")
        result = self.ops.delete([src, folder])
        self.assertIn("folders are not restorable", result.message)
        self.assertFalse(src.exists() or folder.exists())
        undone = self.ops.undo()
        self.assertIn("restored 1 file", undone.message)
        self.assertEqual(src.read_text(), "hello")
        self.assertFalse(folder.exists())

    def test_names_are_validated(self):
        for bad in ("", "  ", "..", "a/../b", "x\0"):
            with self.assertRaises(OpError):
                validate_name(bad)
        self.assertEqual(validate_name(" ok.txt "), "ok.txt")


class FilesPaneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-pane-")
        self.root = Path(self.tmp.name).resolve()
        (self.root / "src").mkdir()
        (self.root / "src" / "main.py").write_text("print('hi')\n" * 40)
        (self.root / "src" / "util.py").write_text("x = 1\n")
        (self.root / "README.md").write_text("# hello\n")
        (self.root / "bin.dat").write_bytes(b"\0\1\2" * 100)
        self.host = Host()
        self.trash_dir = self.root.parent / (self.root.name + "-trash")
        self.ops = FileOps(Trash("dgc", dgc_dir=self.trash_dir))

    def tearDown(self):
        self.tmp.cleanup()
        import shutil
        shutil.rmtree(self.trash_dir, ignore_errors=True)

    def pane(self, mode="acceptEdits", start=None):
        self.host.mode = mode
        return FilesPane(self.root, host=self.host, start=start, ops=self.ops, now=0.0)

    def test_navigation_selection_and_reference_insertion(self):
        pane = self.pane()
        self.assertEqual([e.name for e in pane.listing.entries], ["src", "bin.dat", "README.md"])
        self.assertEqual(drive(pane, "l"), ["changed"])
        self.assertEqual(pane.cwd, self.root / "src")
        drive(pane, "j", "enter")
        self.assertEqual(self.host.inserted, ["@src/util.py "])
        drive(pane, "c")
        self.assertEqual(self.host.inserted[-1], "src/util.py ")
        drive(pane, "h")
        self.assertEqual(pane.cwd, self.root)
        self.assertEqual(pane.listing.entries[pane.cursor].name, "src", "leaving keeps the folder focused")
        drive(pane, "H")
        self.assertEqual(pane.cwd, self.root / "src")
        drive(pane, "L")
        self.assertEqual(pane.cwd, self.root)
        drive(pane, "space", "space")
        self.assertEqual({p.name for p in pane.selected}, {"src", "bin.dat"})
        drive(pane, "escape")
        self.assertFalse(pane.selected)
        drive(pane, "home", "v", "j")
        self.assertEqual(len(pane.selected), 2)
        self.assertEqual(drive(pane, "escape", "escape"), ["changed", "exit"])

    def test_start_path_and_go(self):
        pane = self.pane(start="src/util.py")
        self.assertEqual(pane.cwd, self.root / "src")
        self.assertEqual(pane.listing.entries[pane.cursor].name, "util.py")
        pane.go("..")
        self.assertEqual(pane.cwd, self.root)
        with self.assertRaises(FilesPaneError):
            self.pane(start="nope/nothing")

    def test_create_rename_trash_undo_through_keys(self):
        pane = self.pane()
        drive(pane, "l", "a")
        self.assertTrue(pane.raw_text_input)
        type_text(pane, "notes/")
        drive(pane, "enter")
        self.assertTrue((self.root / "src" / "notes").is_dir())
        self.assertIn("created folder", pane.status)
        pane._focus_name("util.py")
        drive(pane, "r")
        self.assertEqual(pane.prompt["value"], "util.py")
        self.assertEqual(pane.prompt["cursor"], 4, "the cursor sits before the extension")
        drive(pane, "end")
        type_text(pane, ".bak")
        drive(pane, "enter")
        self.assertTrue((self.root / "src" / "util.py.bak").exists())
        drive(pane, "d")
        self.assertEqual(pane.mode, "normal", "acceptEdits trashes without a confirm line")
        self.assertFalse((self.root / "src" / "util.py.bak").exists())
        drive(pane, "u")
        self.assertTrue((self.root / "src" / "util.py.bak").exists())

    def test_default_mode_confirms_destructive_and_plan_mode_is_read_only(self):
        pane = self.pane(mode="default")
        pane._focus_name("README.md")
        drive(pane, "d")
        self.assertEqual(pane.mode, "confirm")
        drive(pane, "n")
        self.assertTrue((self.root / "README.md").exists())
        drive(pane, "d", "y")
        self.assertFalse((self.root / "README.md").exists())
        drive(pane, "u")
        self.assertTrue((self.root / "README.md").exists())
        plan = self.pane(mode="plan")
        plan._focus_name("README.md")
        drive(plan, "d")
        self.assertEqual(plan.mode, "normal")
        self.assertIn("read-only in plan mode", plan.status)
        self.assertTrue((self.root / "README.md").exists())
        drive(plan, "a")
        type_text(plan, "x.txt")
        drive(plan, "enter")
        self.assertFalse((self.root / "x.txt").exists())

    def test_permanent_delete_always_confirms(self):
        pane = self.pane(mode="auto")
        pane._focus_name("README.md")
        drive(pane, "D")
        self.assertEqual(pane.mode, "confirm")
        drive(pane, "y")
        self.assertFalse((self.root / "README.md").exists())

    def test_writes_outside_the_project_are_refused_unless_auto(self):
        pane = self.pane(mode="acceptEdits")
        pane._focus_name("README.md")
        drive(pane, "y", "h")                    # copy README, go to the parent (outside the root)
        self.assertNotEqual(pane.cwd, self.root)
        drive(pane, "p")
        self.assertIn("writes stay inside the project", pane.status)
        self.assertFalse((self.root.parent / "README.md").exists())
        auto = self.pane(mode="auto")
        auto._focus_name("README.md")
        drive(auto, "y", "h", "p")
        self.assertEqual(auto.mode, "confirm")
        drive(auto, "n")
        self.assertFalse((self.root.parent / "README.md").exists())

    def test_copy_cut_paste_and_filter_find(self):
        pane = self.pane()
        pane._focus_name("README.md")
        drive(pane, "y")                         # copy README.md
        pane._focus_name("src")
        drive(pane, "l", "p")                    # into src/
        self.assertTrue((self.root / "src" / "README.md").exists())
        drive(pane, "f")
        type_text(pane, "py")
        self.assertEqual([e.name for e in pane.listing.entries], ["main.py", "util.py"])
        drive(pane, "escape")
        self.assertEqual(len(pane.listing.entries), 3)
        drive(pane, "/")
        type_text(pane, "util")
        drive(pane, "enter")
        self.assertEqual(pane.listing.entries[pane.cursor].name, "util.py")
        drive(pane, "x", "h", "p")               # cut util.py to the root
        self.assertTrue((self.root / "util.py").exists())
        self.assertFalse((self.root / "src" / "util.py").exists())
        self.assertIsNone(pane.clipboard)

    def test_external_changes_are_picked_up_and_marks_shown(self):
        pane = self.pane()
        (self.root / "fresh.txt").write_text("new")
        self.host.changed = {str(self.root / "fresh.txt")}
        pane.advance(now=2.5)
        names = [e.name for e in pane.listing.entries]
        self.assertIn("fresh.txt", names)
        frame = pane.snapshot(100, 10)
        text = "".join(seg.text for row in frame.lines for seg in row)
        self.assertIn("✎", text)

    def test_frames_are_cell_exact_at_every_width(self):
        pane = self.pane()
        drive(pane, "j")
        for width, height in ((40, 6), (60, 8), (80, 12), (120, 16), (200, 18)):
            frame = pane.snapshot(width - 2, height - 2)
            panel = render_frame(frame, width, height, agent_state="WORKING", theme=theme())
            rows = panel.plain.splitlines()
            self.assertEqual(len(rows), height)
            self.assertTrue(all(len(row) <= width for row in rows), (width, height))
        drive(pane, "?")
        panel = render_frame(pane.snapshot(98, 12), 100, 14, agent_state="IDLE", theme=theme())
        self.assertIn("copy · cut · paste", panel.plain)
        drive(pane, "?", "i")
        panel = render_frame(pane.snapshot(98, 12), 100, 14, agent_state="IDLE", theme=theme())
        self.assertIn("modified", panel.plain)

    def test_binary_and_text_previews(self):
        pane = self.pane()
        pane._focus_name("bin.dat")
        text = "".join(seg.text for row in pane.snapshot(100, 8).lines for seg in row)
        self.assertIn("binary", text)
        pane._focus_name("README.md")
        text = "".join(seg.text for row in pane.snapshot(100, 8).lines for seg in row)
        self.assertIn("# hello", text)


class CommandSurfaceTests(unittest.TestCase):
    def test_files_is_a_discoverable_tui_command_usable_during_a_turn(self):
        from dgc.commands import command_pairs, resolve_command
        spec = resolve_command("files", "tui")
        self.assertIsNotNone(spec)
        self.assertTrue(spec.discoverable and spec.available_while_running and spec.accepts_args)
        self.assertIn("files", {name for name, _ in command_pairs("tui")})
        self.assertIsNone(resolve_command("files", "editor"))

    def test_trash_mode_default(self):
        from dgc.config import DEFAULTS
        self.assertEqual(DEFAULTS["trash_mode"], "dgc")


if __name__ == "__main__":
    unittest.main()


class RealTuiSmokeTests(unittest.TestCase):
    """Drive the real prompt_toolkit application through pipe input: /files must open in the
    focus pane, take navigation and raw-text keys through the eager bindings, and close on q."""

    def test_files_pane_through_the_real_key_bindings(self):
        import threading
        import time
        from types import SimpleNamespace
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput
        from dgc.tui import TUI

        tmp = tempfile.TemporaryDirectory(prefix="dgc-files-smoke-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name).resolve()
        (root / "alpha").mkdir()
        (root / "alpha" / "one.py").write_text("x = 1\n")
        (root / "Zeta.md").write_text("# z\n")

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=24, columns=100)

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
                self.session_name = "files-smoke"
                self.mode = "acceptEdits"
                self.ui = None

            def estimate_tokens(self):
                return 0

            def context_size(self):
                return 32768

            def steer(self, text):
                return False

            def eta_snapshot(self):
                return None

        def eventually(predicate, timeout=2.0):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if predicate():
                    return True
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
                    pipe.send_text("/files\r")
                    self.assertTrue(eventually(lambda: getattr(ui._pane, "kind", "") == "files"), "/files opens the pane")
                    pane = ui._pane
                    self.assertEqual(pane.cwd, root)
                    self.assertEqual(ui._header_height(), 1)
                    pipe.send_text("j")
                    self.assertTrue(eventually(lambda: pane.listing.entries[pane.cursor].name == "Zeta.md"), "j moves the cursor")
                    pipe.send_text("k")
                    self.assertTrue(eventually(lambda: pane.listing.entries[pane.cursor].name == "alpha"))
                    pipe.send_text("l")
                    self.assertTrue(eventually(lambda: pane.cwd == root / "alpha"), "l enters a folder")
                    pipe.send_text("a")
                    self.assertTrue(eventually(lambda: pane.mode == "text"), "a opens the raw-text prompt")
                    pipe.send_text("Mixed Case.TXT")
                    self.assertTrue(eventually(lambda: pane.prompt is not None and pane.prompt["value"] == "Mixed Case.TXT"),
                                    "raw text keeps its case and spaces")
                    pipe.send_text("\r")
                    self.assertTrue(eventually(lambda: (root / "alpha" / "Mixed Case.TXT").exists()), "Enter creates the file")
                    pipe.send_text("?")
                    self.assertTrue(eventually(lambda: pane.help))
                    pipe.send_text("?")
                    self.assertTrue(eventually(lambda: not pane.help))
                    pipe.send_text("\r")
                    self.assertTrue(eventually(lambda: "@" in ui.input_buf.text), "Enter on a file inserts @path")
                    self.assertIn('alpha/Mixed Case.TXT', ui.input_buf.text)
                    pipe.send_text("q")
                    self.assertTrue(eventually(lambda: ui._pane is None), "q closes the pane")
                finally:
                    if ui.app:
                        ui.app.exit()
                    thread.join(timeout=3)
