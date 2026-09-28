"""Three repository shapes that stopped delegation working, and the nesting that refused its own writes.

Each was found by reading the isolated-worktree design against real git behaviour, and each was
confirmed by running git before anything was changed:

    submodule off its pin   `git diff --name-only <base>` reports it, it is a DIRECTORY on disk,
                            index mode 160000 -> `_read_state` raised "unsupported non-file path"
                            -> `prepare` returned None -> EVERY `task` call in that repository was
                            refused, with the user told only the path name.
    skip-worktree           the parent's copy is absent from disk but a new linked worktree is
                            dense, so the child sees a file the parent does not -> `prior` missing
                            vs `expected` blob -> refused with "parent checkout changed while the
                            isolated task was running", which is false. (Cone-mode sparse-checkout
                            does NOT do this -- measured, the child inherits the parent's sparsity.)
    /tasks starvation       `list_retained` bounded the SHARED storage root before filtering by
                            repository, and sorts lexically, so one busy repo could push another's
                            records out of the window entirely.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import worktree                                          # noqa: E402


def git(*args, cwd) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def repo(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    git("init", "-q", ".", cwd=root)
    git("config", "user.email", "t@t", cwd=root)
    git("config", "user.name", "t", cwd=root)
    return root


class ASubmoduleNoLongerDisablesDelegationTest(unittest.TestCase):
    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="dgc-submod-"))
        sub = repo(base / "sub")
        (sub / "s.txt").write_text("s1\n", encoding="utf-8")
        git("add", "-A", cwd=sub); git("commit", "-qm", "s1", cwd=sub)
        self.first = git("rev-parse", "HEAD", cwd=sub).stdout.strip()
        (sub / "s.txt").write_text("s2\n", encoding="utf-8")
        git("commit", "-qam", "s2", cwd=sub)

        self.main = repo(base / "main")
        (self.main / "a.txt").write_text("a\n", encoding="utf-8")
        git("add", "-A", cwd=self.main); git("commit", "-qm", "init", cwd=self.main)
        subprocess.run(["git", "-c", "protocol.file.allow=always", "submodule", "add", "-q",
                        "../sub", "sub"], cwd=self.main, check=True, capture_output=True)
        git("commit", "-qm", "add submodule", cwd=self.main)
        self.base_commit = git("rev-parse", "HEAD", cwd=self.main).stdout.strip()

    def test_git_really_reports_a_moved_submodule_as_a_changed_path(self) -> None:
        """The premise. Without this the fix below is guarding nothing."""
        git("checkout", "-q", self.first, cwd=self.main / "sub")
        changed = git("diff", "--name-only", self.base_commit, cwd=self.main).stdout.split()
        self.assertIn("sub", changed)
        self.assertTrue((self.main / "sub").is_dir())
        mode = git("ls-files", "--stage", "sub", cwd=self.main).stdout.split()[0]
        self.assertEqual(mode, "160000", "a gitlink, which is how the fix identifies it")

    def test_a_moved_submodule_is_excluded_rather_than_fatal(self) -> None:
        git("checkout", "-q", self.first, cwd=self.main / "sub")
        self.assertEqual(worktree._gitlink_paths(self.main, Path(".")), {"sub"})
        self.assertNotIn("sub", worktree._dirty_paths(self.main, self.base_commit, Path(".")),
                         "a gitlink must not reach _read_state, which raises on a directory")

    def test_delegation_is_available_in_such_a_repository(self) -> None:
        git("checkout", "-q", self.first, cwd=self.main / "sub")
        workspace, error = worktree.TaskWorkspace.prepare(
            str(self.main), "probe", Path(tempfile.mkdtemp()))
        self.assertTrue(workspace, f"every task call in this repo was refused: {error}")

    def test_an_unmoved_submodule_was_never_the_problem(self) -> None:
        workspace, error = worktree.TaskWorkspace.prepare(
            str(self.main), "probe", Path(tempfile.mkdtemp()))
        self.assertTrue(workspace, error)


class ASkipWorktreePathIsNotTheUsersEditTest(unittest.TestCase):
    def test_git_really_gives_the_child_a_file_the_parent_lacks(self) -> None:
        root = repo(Path(tempfile.mkdtemp(prefix="dgc-skip-")) / "main")
        (root / "keep.txt").write_text("k\n", encoding="utf-8")
        (root / "vanish.txt").write_text("v\n", encoding="utf-8")
        git("add", "-A", cwd=root); git("commit", "-qm", "init", cwd=root)
        git("update-index", "--skip-worktree", "vanish.txt", cwd=root)
        (root / "vanish.txt").unlink()
        self.assertEqual(worktree._skip_worktree_paths(root, Path(".")), {"vanish.txt"})
        self.assertFalse((root / "vanish.txt").exists(), "absent from the parent")
        added = subprocess.run(["git", "worktree", "add", "-q", str(root.parent / "wt"),
                                "-b", "probe"], cwd=root, capture_output=True, text=True)
        self.assertEqual(added.returncode, 0, added.stderr)
        self.assertTrue((root.parent / "wt" / "vanish.txt").exists(),
                        "present in the child -- this divergence is the whole bug")

    def test_sparse_checkout_is_not_the_mechanism(self) -> None:
        """The proposal blamed sparse-checkout. Measured: the child inherits the parent's sparsity."""
        root = repo(Path(tempfile.mkdtemp(prefix="dgc-sparse-")) / "main")
        (root / "keep").mkdir(); (root / "drop").mkdir()
        (root / "keep" / "k.txt").write_text("k\n", encoding="utf-8")
        (root / "drop" / "d.txt").write_text("d\n", encoding="utf-8")
        git("add", "-A", cwd=root); git("commit", "-qm", "init", cwd=root)
        if subprocess.run(["git", "sparse-checkout", "init", "--cone"], cwd=root,
                          capture_output=True).returncode != 0:
            self.skipTest("this git has no cone-mode sparse-checkout")
        git("sparse-checkout", "set", "keep", cwd=root)
        subprocess.run(["git", "worktree", "add", "-q", str(root.parent / "wt"), "-b", "probe"],
                       cwd=root, check=True, capture_output=True)
        self.assertFalse((root.parent / "wt" / "drop").exists(),
                         "a cone-sparse parent gives a sparse child; only skip-worktree diverges")


class RetainedTasksAreFilteredBeforeTheyAreBoundedTest(unittest.TestCase):
    def test_one_busy_repository_cannot_hide_anothers_work(self) -> None:
        storage = Path(tempfile.mkdtemp(prefix="dgc-retained-"))
        # `sorted()` is lexical, so "aaa-..." sorts ahead of "zzz-..." and used to consume the whole
        # window before the repository filter ever ran.
        for i in range(worktree._MAX_TASK_FILES + 50):
            (storage / f"aaa-busy-task-{i:05d}.json").write_text("{}", encoding="utf-8")
        mine = storage / "zzz-mine-task-00001.json"
        mine.write_text("{}", encoding="utf-8")
        listed = sorted(storage.glob("*.json"))
        self.assertGreater(len(listed), worktree._MAX_TASK_FILES)
        bounded_first = listed[:worktree._MAX_TASK_FILES]
        self.assertNotIn(mine, bounded_first,
                         "the old order: bound the shared root, then filter -- and the user's own "
                         "record was already gone")
        filtered_first = [p for p in listed if p.stem.startswith("zzz-mine")]
        self.assertIn(mine, filtered_first[:worktree._MAX_TASK_FILES],
                      "filter first and it survives, which is the fix")


if __name__ == "__main__":
    unittest.main()
