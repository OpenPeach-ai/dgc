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


class ExistingWorktreeIsNotDeletedTests(unittest.TestCase):
    """A failure path must not remove a checkout this run did not create.

    `create` returns an existing worktree rather than refusing — that is the whole point of the
    re-entry fix. But the callers' cleanup ran `git worktree remove` on "the worktree we just
    made", so `/worktree feature-x` a second time, where starting the agent then failed (a bad
    model host in that worktree's own config, an MCP server that will not start), removed a
    checkout the user had been working in for days.
    """

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory(prefix="dgc-wt-keep-")
        self.addCleanup(self._dir.cleanup)
        self.root = Path(self._dir.name) / "repo"
        self.root.mkdir()
        git(self.root, "init", "-q", "-b", "main")
        git(self.root, "config", "user.email", "t@example.invalid")
        git(self.root, "config", "user.name", "t")
        (self.root / "a.txt").write_text("hello\n", encoding="utf-8")
        git(self.root, "add", "a.txt")
        git(self.root, "commit", "-qm", "first")

    def test_a_freshly_made_worktree_is_ours_to_remove(self):
        path, _branch, err = wt.create(self.root, "brand-new")
        self.assertIsNone(err, err)
        self.assertTrue(wt.was_created(path),
                        "this run made it, so a failure path may clean it up")

    def test_a_worktree_we_only_attached_to_is_not(self):
        first, _b, err = wt.create(self.root, "existing")
        self.assertIsNone(err, err)
        (first / "days-of-work.txt").write_text("mine\n", encoding="utf-8")

        again, _b2, err2 = wt.create(self.root, "existing")
        self.assertIsNone(err2, err2)
        self.assertEqual(again, first)
        self.assertFalse(wt.was_created(again),
                         "an attached worktree must not be removed by a failure path")

    def test_the_tui_cleanup_asks_before_removing(self):
        source = (Path(__file__).resolve().parents[1] / "dgc" / "tui.py").read_text(encoding="utf-8")
        index = source.index("cleanup_error = ")
        window = source[index:index + 220]
        self.assertIn("was_created", window,
                      "the failure path removes the worktree without asking whose it is")
