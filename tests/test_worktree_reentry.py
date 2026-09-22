"""`/worktree NAME` on a worktree you already made should take you back to it.

It called `git worktree add` unconditionally and reported "path already exists", so the only way
back into a named worktree was to remove it and start over — losing whatever was in it.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

from dgc import worktree as wt                            # noqa: E402


def git(root, *args):
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True)


class WorktreeReentryTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory(prefix="dgc-wt-")
        self.addCleanup(self._dir.cleanup)
        self.root = Path(self._dir.name) / "repo"
        self.root.mkdir()
        git(self.root, "init", "-q", "-b", "main")
        git(self.root, "config", "user.email", "t@example.invalid")
        git(self.root, "config", "user.name", "t")
        (self.root / "a.txt").write_text("hello\n", encoding="utf-8")
        git(self.root, "add", "a.txt")
        git(self.root, "commit", "-qm", "first")

    def test_asking_for_the_same_worktree_twice_returns_it(self):
        first_path, first_branch, err = wt.create(self.root, "feature-x")
        self.assertIsNone(err, err)
        self.assertTrue(first_path.is_dir())
        # Leave something in it, so "took me back" is distinguishable from "made a new one".
        (first_path / "work-in-progress.txt").write_text("mine\n", encoding="utf-8")

        again_path, again_branch, err = wt.create(self.root, "feature-x")

        self.assertIsNone(err, "asking for a worktree you already have must not be an error")
        self.assertEqual(again_path, first_path)
        self.assertEqual(again_branch, first_branch)
        self.assertTrue((again_path / "work-in-progress.txt").is_file(),
                        "it must be the same checkout, with the work still in it")

    def test_a_stray_directory_on_the_path_is_still_refused(self):
        # Attaching to something that is not a worktree of this repo would be guessing.
        stray = self.root.parent / f"{self.root.name}-squatter"
        stray.mkdir()
        (stray / "not-ours.txt").write_text("x", encoding="utf-8")
        path, branch, err = wt.create(self.root, "squatter")
        self.assertIsNone(path)
        self.assertIn("not a worktree of this repository", err or "")

    def test_a_new_name_still_creates_one(self):
        path, branch, err = wt.create(self.root, "fresh")
        self.assertIsNone(err, err)
        self.assertTrue(path.is_dir())
        self.assertEqual(branch, "dgc/fresh")


if __name__ == "__main__":
    unittest.main()
