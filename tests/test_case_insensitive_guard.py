"""Two tracked paths that differ only in case are one file, and a delegation would lose one.

Measured on the real thing, over SSH to a Mac Studio (macOS 26.5.1, APFS, git 2.50.1), with
`README.md` and `readme.md` both in the index:

    core.ignorecase = true
    index entries:  README.md, readme.md
    files on disk:  readme.md
    a pristine `git worktree add` reports, with nothing touched:  M README.md
    both names read:  CONTENT-LOWER
    writing through `readme.md` changes what `README.md` reads

So an isolated checkout starts out reporting a change nothing made; both names are compared
against DIFFERENT expected blobs and both look changed; and integrating the result writes one
file's content over the other's in the user's own checkout. DGC cannot make a filesystem
case-sensitive, so the delegation is refused with the two names and a way out.

These tests run on a case-SENSITIVE filesystem, so the aliasing is reproduced the one way that
works there: a hard link between the two names, which gives exactly the property the guard tests
for -- two tracked paths, one file. That is also a real hazard in its own right, for the same
reason.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import worktree                                              # noqa: E402


def git(*args, cwd) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _case_sensitive(directory: Path) -> bool:
    """Ask the filesystem rather than the platform: a case-sensitive volume can be mounted on a
    Mac, and a case-insensitive one on Linux, so `sys.platform` is the wrong question."""
    probe = directory / ".dgc-case-probe"
    try:
        probe.write_text("", encoding="utf-8")
        return not (directory / ".DGC-CASE-PROBE").exists()
    finally:
        probe.unlink(missing_ok=True)


class ACaseAliasedProjectRefusesDelegationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.base = Path(tempfile.mkdtemp(prefix="dgc-case-")).resolve()
        self.main = self.base / "main"
        self.main.mkdir()
        git("init", "-q", ".", cwd=self.main)
        git("config", "user.email", "t@t", cwd=self.main)
        git("config", "user.name", "t", cwd=self.main)
        (self.main / "readme.md").write_text("CONTENT-LOWER\n", encoding="utf-8")
        (self.main / "other.txt").write_text("unrelated\n", encoding="utf-8")
        git("add", "-A", cwd=self.main)
        git("commit", "-qm", "init", cwd=self.main)
        # Whatever git called the first branch. It is `master` here and `main` under Apple Git
        # 2.50.1 with init.defaultBranch unset in every scope, so the NAME is not the property --
        # "the refusal added nothing" is.
        self.branches_before = self.branch_names()

    def branch_names(self) -> list[str]:
        return sorted(git("branch", "--format=%(refname:short)", cwd=self.main).stdout.split())

    def alias(self) -> None:
        """One file, two tracked names -- the property the Mac gets from its filesystem.

        How the second name is made has to differ by filesystem, and getting that wrong is what
        broke the macOS release matrix: `os.link` is how you FAKE this on a case-sensitive one,
        and on a case-insensitive one the two names are already the same path, so the link
        raises FileExistsError and every test here errors in setUp.

        On a case-insensitive filesystem only the INDEX needs the second spelling -- which is
        exactly the shape the real thing has: a repository authored on Linux, checked out on a
        Mac, where `git ls-files` lists both and the disk holds one. That is the case the
        docstring on aliased_tracked_paths was measured against.
        """
        if _case_sensitive(self.main):
            os.link(self.main / "readme.md", self.main / "README.md")
            git("add", "README.md", cwd=self.main)
        else:
            blob = git("rev-parse", "HEAD:readme.md", cwd=self.main).stdout.strip()
            git("update-index", "--add", "--cacheinfo", f"100644,{blob},README.md",
                cwd=self.main)
        git("commit", "-qm", "alias", cwd=self.main)
        git("config", "core.ignorecase", "true", cwd=self.main)

    def test_the_premise_they_really_are_one_file(self) -> None:
        self.alias()
        lower = os.lstat(self.main / "readme.md")
        upper = os.lstat(self.main / "README.md")
        self.assertEqual((lower.st_dev, lower.st_ino), (upper.st_dev, upper.st_ino))
        self.assertEqual(sorted(git("ls-files", cwd=self.main).stdout.split()),
                         ["README.md", "other.txt", "readme.md"])

    def test_both_names_are_reported(self) -> None:
        self.alias()
        self.assertEqual(worktree.aliased_tracked_paths(self.main), ["README.md", "readme.md"])

    def test_delegation_is_refused_with_the_names_and_a_way_out(self) -> None:
        self.alias()
        workspace, error = worktree.TaskWorkspace.prepare(self.main, "task", self.base / "store")
        self.assertIsNone(workspace, "a checkout that would lose a file must not be created")
        self.assertIn("README.md", error)
        self.assertIn("readme.md", error)
        self.assertIn("git mv", error, "tell them how to make delegation work again")

    def test_nothing_is_created_by_the_refusal(self) -> None:
        self.alias()
        worktree.TaskWorkspace.prepare(self.main, "task", self.base / "store")
        self.assertEqual(self.branch_names(), self.branches_before,
                         "the refusal must not leave a branch behind")
        self.assertEqual(len(worktree.list_worktrees(self.main)), 1)

    def test_a_fleet_checkout_is_refused_too(self) -> None:
        """The same corruption, the same refusal: it copies the same tracked state."""
        self.alias()
        workspace, error = worktree.FleetWorkspace.prepare(self.main, "fleet", self.base / "fleet")
        self.assertIsNone(workspace)
        self.assertIn("case", error)

    def test_an_ordinary_project_is_untouched(self) -> None:
        self.assertEqual(worktree.aliased_tracked_paths(self.main), [])
        workspace, error = worktree.TaskWorkspace.prepare(self.main, "task", self.base / "store")
        self.assertIsNotNone(workspace, error)
        workspace.cleanup()

    def test_case_differing_paths_that_are_separate_files_are_fine(self) -> None:
        """A case-sensitive filesystem holding both is not the hazard -- only sharing one is."""
        (self.main / "README.md").write_text("CONTENT-UPPER\n", encoding="utf-8")
        git("add", "-A", cwd=self.main)
        git("commit", "-qm", "two real files", cwd=self.main)
        git("config", "core.ignorecase", "true", cwd=self.main)
        self.assertEqual(worktree.aliased_tracked_paths(self.main), [])
        workspace, error = worktree.TaskWorkspace.prepare(self.main, "task", self.base / "store")
        self.assertIsNotNone(workspace, error)
        workspace.cleanup()

    def test_a_case_sensitive_filesystem_is_not_even_listed(self) -> None:
        """`core.ignorecase` is the cheap gate, so this costs a Linux user one config read."""
        self.alias()
        git("config", "core.ignorecase", "false", cwd=self.main)
        self.assertEqual(worktree.aliased_tracked_paths(self.main), [])

    def test_a_tracked_symlink_between_the_two_names_is_not_aliasing(self) -> None:
        """git stores a symlink as a symlink and DGC reads it as one, so `lstat` is the right
        question -- `stat` would follow it and refuse a project that is perfectly fine.

        Case-sensitive filesystems only, and not for convenience: the scenario needs `readme.md`
        and a SEPARATE `README.md` symlink pointing at it, and on a case-insensitive volume those
        are one name -- `symlink_to` raises FileExistsError, which is what this test did on every
        macOS CI run. There is no macOS equivalent to gate differently, because there the symlink
        case collapses into the plain aliasing case that the other tests already cover.
        """
        if not _case_sensitive(self.main):
            self.skipTest("needs two distinct directory entries; this volume collapses their case")
        (self.main / "README.md").symlink_to("readme.md")
        git("add", "-A", cwd=self.main)
        git("commit", "-qm", "symlinked alias", cwd=self.main)
        git("config", "core.ignorecase", "true", cwd=self.main)
        self.assertEqual(worktree.aliased_tracked_paths(self.main), [])


if __name__ == "__main__":
    unittest.main()
