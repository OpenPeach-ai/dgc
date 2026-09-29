"""With the sandbox on, a delegated sub-agent could not run one git command.

Reproduced before anything was changed, inside a real task worktree under a real home:

    git rev-parse --git-dir  -> rc 128  fatal: not a git repository: ~/…/.git/worktrees/…
    git status --porcelain   -> rc 128  (same)
    git log --oneline -1     -> rc 128  (same)
    pwd                      -> /mnt    (the worktree itself IS bound correctly)

A task worktree's `.git` is a POINTER FILE into the source repository, and `sandbox.wrap` masks the
user's home with a tmpfs -- which erases that repository, so the pointer dangles. `sandbox: false`
is the default, so this only ever hit the security-conscious user: the one who turned the sandbox
on got a sub-agent that could not read its own history.

The repository directory is re-exposed read-only, and `.git` ONLY. Binding the whole source
repository was the other candidate and it works equally well for git -- but it hands the child back
exactly the ignored files its worktree deliberately does not have, which is the isolation these
tests exist to keep. That the child then cannot commit is deliberate: DGC integrates a sub-task by
reading its working tree, never its commits.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import sandbox, worktree                                     # noqa: E402


def git(*args, cwd) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


SANDBOX_AVAILABLE = sandbox._backend() is not None
BACKEND = sandbox._backend()[0] if SANDBOX_AVAILABLE else ""

# The `.git` re-exposure below is implemented on BOTH arms and both are exercised here, but a
# confined child can only actually RUN git under bwrap today. Measured on the real thing --
# macOS 26.5.1, APFS, git 2.50.1, through the product's own sandbox.wrap:
#
#   as shipped:                 fatal: unable to access '/Users/<me>/.gitconfig': Operation not permitted
#   with the global config off: fatal: Invalid path '/Users/<me>': Operation not permitted
#   + ancestor metadata:        fatal: Invalid path '/Users/<me>/<base>/...': Operation not permitted
#
# bwrap masks the home with a tmpfs, so the global config and the ancestors are ABSENT and git
# proceeds. sandbox-exec denies them instead, and git treats EPERM as fatal where it treats ENOENT
# as "nothing configured". Absent is fine; forbidden is fatal. Re-exposing enough of the path for
# git to walk up to its own checkout is a profile change that needs its own review, so the gap is
# named here rather than papered over: these skips must come off with that fix, not before it.
GIT_RUNS_CONFINED = BACKEND == "bwrap"


class ADelegatedChildCanReadItsOwnHistoryTest(unittest.TestCase):
    """Run against the real backend. The fixture lives under the real home ON PURPOSE: the tmpfs
    mask is what breaks this, and a fixture outside the home would never meet it."""

    @classmethod
    def setUpClass(cls) -> None:
        if not SANDBOX_AVAILABLE:
            raise unittest.SkipTest("no supported sandbox backend on this host")
        cls.base = Path(tempfile.mkdtemp(prefix="dgc-sbx-", dir=Path.home())).resolve()
        cls.main = cls.base / "main"
        cls.main.mkdir()
        git("init", "-q", ".", cwd=cls.main)
        git("config", "user.email", "t@t", cwd=cls.main)
        git("config", "user.name", "t", cwd=cls.main)
        (cls.main / "a.txt").write_text("v1\n", encoding="utf-8")
        (cls.main / ".gitignore").write_text(".env\nnode_modules\n", encoding="utf-8")
        (cls.main / ".env").write_text("SECRET=hunter2\n", encoding="utf-8")
        (cls.main / "node_modules").mkdir()
        (cls.main / "node_modules" / "x.js").write_text("pkg\n", encoding="utf-8")
        git("add", "-A", cwd=cls.main)
        git("commit", "-qm", "init", cwd=cls.main)
        workspace, error = worktree.TaskWorkspace.prepare(cls.main, "child", cls.base / "store")
        if workspace is None:
            raise unittest.SkipTest(f"could not prepare a task worktree: {error}")
        cls.workspace = workspace

    @classmethod
    def tearDownClass(cls) -> None:
        if getattr(cls, "workspace", None) is not None:
            cls.workspace.cleanup()
        shutil.rmtree(getattr(cls, "base", Path("/nonexistent")), ignore_errors=True)

    def run_confined(self, command: str) -> subprocess.CompletedProcess:
        # `cwd=` exactly as production does it (tools.py passes cwd=ctx.project_root to Popen).
        # Without it this only ever worked on Linux, where bwrap's own `--chdir /mnt` covered for
        # the omission; sandbox-exec has no such remap, so the child ran in the RUNNER's directory
        # and every git command here failed 128 on macOS for a reason the product does not have.
        argv = sandbox.wrap(command, self.workspace.project_root, None)
        self.assertIsNotNone(argv, "the backend was available a moment ago")
        return subprocess.run(argv, cwd=self.workspace.project_root,
                              capture_output=True, text=True)

    def test_the_premise_its_git_is_a_pointer_into_the_source_repository(self) -> None:
        marker = self.workspace.project_root / ".git"
        self.assertTrue(marker.is_file(), "a linked worktree, not an ordinary checkout")
        self.assertTrue(marker.read_text(encoding="utf-8").startswith("gitdir:"))

    def test_it_is_still_confined_to_its_own_checkout(self) -> None:
        """The two backends put the checkout in different places -- bwrap remaps it to `/mnt`,
        sandbox-exec leaves it where it is -- so `/mnt` is an implementation detail, not the
        property. What has to hold on both is that the child starts in ITS OWN checkout and
        never in the parent's."""
        observed = self.run_confined("pwd").stdout.strip()
        backend, _ = sandbox._backend()
        expected = "/mnt" if backend == "bwrap" else str(self.workspace.project_root)
        self.assertEqual(observed, expected)
        self.assertNotEqual(observed, str(self.main), "never the parent's checkout")

    @unittest.skipUnless(GIT_RUNS_CONFINED,
                         "a confined child cannot run git under sandbox-exec yet "
                         "(see GIT_RUNS_CONFINED above for the measured reason)")
    def test_git_works(self) -> None:
        for command in ("git rev-parse --git-dir", "git status --porcelain",
                        "git log --oneline -1", "git diff --stat HEAD"):
            with self.subTest(command=command):
                self.assertEqual(self.run_confined(command).returncode, 0, command)

    @unittest.skipUnless(GIT_RUNS_CONFINED,
                         "a confined child cannot run git under sandbox-exec yet "
                         "(see GIT_RUNS_CONFINED above for the measured reason)")
    def test_git_sees_the_childs_own_work(self) -> None:
        result = self.run_confined("echo new > b.txt && git status --porcelain")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("b.txt", result.stdout)

    def test_the_parents_ignored_files_stay_invisible(self) -> None:
        """The reason for binding `.git` and not the repository: these are exactly what a
        worktree leaves behind, and re-exposing them would undo that silently."""
        for command in (f"cat {self.main}/.env", f"ls {self.main}/node_modules"):
            with self.subTest(command=command):
                self.assertNotEqual(self.run_confined(command).returncode, 0, command)

    def test_the_parents_working_tree_stays_invisible(self) -> None:
        self.assertNotEqual(self.run_confined(f"ls {self.main}/a.txt").returncode, 0)

    @unittest.skipUnless(GIT_RUNS_CONFINED,
                         "a confined child cannot run git under sandbox-exec yet "
                         "(see GIT_RUNS_CONFINED above for the measured reason)")
    def test_committing_is_refused(self) -> None:
        """Deliberate, and worth pinning: the bind is read-only, and DGC integrates a sub-task by
        reading its working tree rather than its commits.

        The tracked file is modified first ON PURPOSE. `git commit -am` on a clean tree fails for
        having nothing to commit, which made an earlier version of this test pass against a
        WRITABLE bind -- it was measuring the fixture, not the sandbox.
        """
        result = self.run_confined("echo more >> a.txt && git commit -qam x")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("nothing to commit", result.stdout + result.stderr,
                         "the refusal must be the read-only repository, not an empty commit")
        self.assertEqual(self.run_confined("git log --oneline | wc -l").stdout.strip(), "1")


class TheRepositoryIsFoundWithoutRunningGitTest(unittest.TestCase):
    """`wrap` builds an argv for EVERY sandboxed command, so the lookup reads the pointer file
    rather than shelling out."""

    def setUp(self) -> None:
        self.base = Path(tempfile.mkdtemp(prefix="dgc-sbx-find-")).resolve()

    def test_a_linked_worktree_resolves_to_the_shared_repository(self) -> None:
        main = self.base / "main"
        main.mkdir()
        git("init", "-q", ".", cwd=main)
        git("config", "user.email", "t@t", cwd=main)
        git("config", "user.name", "t", cwd=main)
        (main / "a.txt").write_text("v1\n", encoding="utf-8")
        git("add", "-A", cwd=main)
        git("commit", "-qm", "init", cwd=main)
        workspace, error = worktree.TaskWorkspace.prepare(main, "child", self.base / "store")
        self.assertIsNotNone(workspace, error)
        self.assertEqual(sandbox._worktree_git_common_dir(workspace.project_root),
                         (main / ".git").resolve(strict=False))

    def test_an_ordinary_checkout_needs_nothing(self) -> None:
        """Its `.git` is a directory, already covered by the read-only bind of `/`."""
        plain = self.base / "plain"
        plain.mkdir()
        git("init", "-q", ".", cwd=plain)
        self.assertIsNone(sandbox._worktree_git_common_dir(plain))

    def test_a_directory_that_is_not_a_checkout_needs_nothing(self) -> None:
        self.assertIsNone(sandbox._worktree_git_common_dir(self.base))

    def test_a_junk_pointer_file_is_not_fatal(self) -> None:
        odd = self.base / "odd"
        odd.mkdir()
        (odd / ".git").write_text("not a gitdir line at all\n", encoding="utf-8")
        self.assertIsNone(sandbox._worktree_git_common_dir(odd))


if __name__ == "__main__":
    unittest.main()
