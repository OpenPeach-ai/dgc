"""Seeded fuzz of every arcade game and the /files pane through the shared frame contract."""
from __future__ import annotations

import random
import tempfile
import unittest
from pathlib import Path

from dgc.bored import BoredController, game_choices
from dgc.pane import render_frame
from dgc.style import theme

KEYS = ["up", "down", "left", "right", "w", "a", "s", "d", "space", "enter", "p", "r", "tab",
        "backspace", "delete", "x", "z", "1", "5", "9", "e", "t", "h", "j", "k", "l", "G", "n"]
SIZES = [(20, 4), (40, 8), (60, 12), (100, 16), (200, 40)]


class ArcadeFuzzTests(unittest.TestCase):
    def test_every_game_survives_random_input_at_every_size(self):
        th = theme()
        for choice in game_choices():
            for seed in range(3):
                rng = random.Random(seed)
                controller = BoredController(choice.key, seed=seed, now=0.0)
                clock = 0.0
                for step in range(400):
                    clock += rng.choice([0.0, 0.016, 0.1, 0.5, 2.0])
                    key = rng.choice(KEYS)
                    if controller.handle_key(key, now=clock) == "exit":
                        controller = BoredController(choice.key, seed=seed + 50, now=clock)
                    controller.advance(now=clock)
                    if step % 40 == 0:
                        for width, height in SIZES:
                            frame = controller.snapshot(width - 2, height - 2)
                            rows = render_frame(frame, width, height, agent_state="WORKING",
                                                theme=th).plain.splitlines()
                            self.assertEqual(len(rows), height, (choice.key, width, height))
                            self.assertTrue(all(len(row) <= width for row in rows),
                                            (choice.key, width, height))


class FilesFuzzTests(unittest.TestCase):
    def test_explorer_survives_random_keys_without_leaving_the_tree(self):
        from dgc.files import FilesPane
        from dgc.files.ops import FileOps, Trash

        class Host:
            mode = "acceptEdits"
            config = None
            def flash(self, m): pass
            def insert_reference(self, t): pass
            def changed_paths(self): return set()
        # The tree sits alone inside a fresh parent so "h" lands the cursor on the project root itself
        # on every platform (a macOS runner's TMPDIR did that by accident and trashed the root).
        with tempfile.TemporaryDirectory(prefix="dgc-files-fuzz-") as tmp:
            root = (Path(tmp).resolve() / "project")
            root.mkdir()
            for name in ("a", "b/c", "b/d/e"):
                (root / name).mkdir(parents=True)
            for name in ("a/one.txt", "b/two.md", "b/c/three.py", "top.txt"):
                (root / name).write_text("data\n" * 5)
            trash = root.parent / (root.name + "-trash")
            keys = KEYS + ["y", "v", "c-a", "escape", "f", "/", "i", "?", ".", "S", "u", "H", "L", "-", "g"]
            for seed in range(3):
                rng = random.Random(seed)
                pane = FilesPane(root, host=Host(), ops=FileOps(Trash("dgc", dgc_dir=trash)), now=0.0)
                clock = 0.0
                for step in range(300):
                    clock += 0.3
                    key = rng.choice(keys)
                    if key in ("q",):
                        continue
                    if pane.raw_text_input and rng.random() < 0.7:
                        pane.handle_text(rng.choice("abcXYZ.1 "))
                    else:
                        pane.handle_key(key, now=clock)
                    if key == "~":
                        continue
                    pane.advance(now=clock)
                    if step % 30 == 0:
                        for width, height in SIZES:
                            rows = render_frame(pane.snapshot(width - 2, height - 2), width, height,
                                                agent_state="IDLE", theme=theme()).plain.splitlines()
                            state = (f"seed={seed} step={step} size={width}x{height} cwd={str(pane.cwd)!r} "
                                     f"mode={pane.mode} help={pane.help} status={pane.status!r}")
                            self.assertEqual(len(rows), height, state + " rows=" + repr(rows))
                            self.assertTrue(all(len(row) <= width for row in rows), state)
                self.assertTrue(root.exists(), f"the tree root survives (seed={seed} cwd={pane.cwd})")
            import shutil
            shutil.rmtree(trash, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
