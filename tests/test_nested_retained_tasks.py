"""A grandchild's retained work left an unreachable worktree and branch in the user's repository.

Measured before anything was changed. A sub-agent that delegates again prepares its checkout FROM
its own worktree, so `git rev-parse --show-toplevel` answers with that worktree and the retained
record names it as the source. `git worktree add` still registers in the common dir, so the
grandchild's checkout and its `dgc/task-...` branch are created in the USER's repository -- but
`/tasks` matches a record's recorded source against the project it is asked about, so from the
project it showed nothing:

    from MAIN : []
    from CHILD: [('grandchild work', 'main-task-child-...-task-grand-...')]

and once the parent's checkout was cleaned up (which is the normal end of a delegation) the record
became unreachable from anywhere, while this stayed behind in the user's own repository:

    branches left in main: ['dgc/task-grand-3fa674b6da', 'master']
    worktree list:         .../store/main-task-child-...-task-grand-3fa674b6da

No surface could show it, apply it, or delete it. These tests pin that it is now listed against the
repository that really owns the branch, that an apply is refused honestly once the checkout it was
written against is gone, that dropping it removes everything, and that a record belonging to a
DIFFERENT project which merely shares a directory name is still not shown.
"""
from __future__ import annotations

import json
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


def repo(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    git("init", "-q", ".", cwd=root)
    git("config", "user.email", "t@t", cwd=root)
    git("config", "user.name", "t", cwd=root)
    (root / "a.txt").write_text("v1\n", encoding="utf-8")
    git("add", "-A", cwd=root)
    git("commit", "-qm", "init", cwd=root)
    return root


def prepare(source: Path, name: str, store: Path):
    workspace, error = worktree.TaskWorkspace.prepare(source, name, store)
    if workspace is None:
        raise AssertionError(f"prepare failed: {error}")
    return workspace


def branches(root: Path) -> list[str]:
    return git("branch", "--format=%(refname:short)", cwd=root).stdout.split()


class ANestedRetainedTaskIsReachableTest(unittest.TestCase):
    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="dgc-nested-")).resolve()
        self.main = repo(base / "main")
        self.store = base / "store"
        self.child = prepare(self.main, "child", self.store)
        self.grand = prepare(self.child.project_root, "grand", self.store)
        (self.grand.project_root / "a.txt").write_text("by the grandchild\n", encoding="utf-8")
        self.assertIsNone(self.grand.retain("grandchild work", self.grand.changed_paths()))

    def listed(self, root: Path):
        tasks, errors = worktree.list_retained(root, self.store)
        self.assertEqual(errors, [])
        return tasks

    def test_git_really_registers_the_grandchild_in_the_users_repository(self) -> None:
        """The premise: this is the user's repo carrying it, which is why they must be able to see it."""
        self.assertIn(self.grand.branch, branches(self.main))
        registered = [Path(item.get("path", "")).resolve(strict=False)
                      for item in worktree.list_worktrees(self.main)]
        self.assertIn(self.grand.path.resolve(strict=False), registered)

    def test_it_is_listed_from_the_project(self) -> None:
        tasks = self.listed(self.main)
        self.assertEqual([task.reason for task in tasks], ["grandchild work"])
        self.assertIn("worktree path", tasks[0].problem,
                      "listed with somewhere to go and read it")

    def test_it_survives_the_parent_checkout_being_cleaned_up(self) -> None:
        self.assertIsNone(self.child.cleanup())
        tasks = self.listed(self.main)
        self.assertEqual([task.reason for task in tasks], ["grandchild work"],
                         "this is the state the work used to disappear in")

    def test_it_is_listed_but_never_applied_from_the_project(self) -> None:
        """Its delta was written against a delegated checkout. Applying it from here would mean
        writing one tree's state into a different one, so the project offers reading and removing
        it instead -- which is what was impossible before."""
        for task in (self.listed(self.main)[0], ):
            self.assertFalse(task.available)
            self.assertIn("nested sub-task", task.problem)
        self.child.cleanup()
        task = self.listed(self.main)[0]
        self.assertFalse(task.available)
        self.assertEqual((self.main / "a.txt").read_text(encoding="utf-8"), "v1\n",
                         "and nothing about listing it touched the user's own checkout")

    def test_dropping_it_removes_the_branch_the_worktree_and_the_record(self) -> None:
        self.child.cleanup()
        task = self.listed(self.main)[0]
        outcome = worktree.resolve_retained(self.main, task.id, "drop", self.store)
        self.assertEqual(outcome.status, "dropped", outcome.error)
        self.assertNotIn(self.grand.branch, branches(self.main))
        self.assertFalse(self.grand.path.exists())
        self.assertEqual(sorted(p.name for p in self.store.glob("*.json")), [])
        self.assertEqual(self.listed(self.main), [])

    def test_a_grandchild_can_still_revise_its_parents_work_directly(self) -> None:
        """Not through `/tasks`, but through its own integration -- the path a live delegation
        takes. The plan this work came from listed this as broken; it is not."""
        grand = prepare(self.child.project_root, "grand2", self.store)
        (grand.project_root / "a.txt").write_text("revised\n", encoding="utf-8")
        outcome = grand.integrate()
        self.assertEqual(outcome.status, "applied", outcome.error)
        self.assertEqual((self.child.project_root / "a.txt").read_text(encoding="utf-8"),
                         "revised\n", "a grandchild revises its PARENT's work")
        self.assertEqual((self.main / "a.txt").read_text(encoding="utf-8"), "v1\n",
                         "and the user's own checkout is untouched by it")


class TheRecordItselfIsNotTrustedTest(unittest.TestCase):
    """A retained record is a file on disk, and this module already treats one as hostile input.
    Accepting nested records widened what a bad record can claim, so each new claim is checked."""

    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="dgc-nested-bad-")).resolve()
        self.main = repo(base / "main")
        self.store = base / "store"
        self.child = prepare(self.main, "child", self.store)
        self.grand = prepare(self.child.project_root, "grand", self.store)
        (self.grand.project_root / "a.txt").write_text("by the grandchild\n", encoding="utf-8")
        self.grand.retain("grandchild work", self.grand.changed_paths())
        self.record = next(iter(self.store.glob("*.json")))

    def rewrite(self, **fields) -> None:
        payload = json.loads(self.record.read_text(encoding="utf-8"))
        payload.update(fields)
        self.record.write_text(json.dumps(payload), encoding="utf-8")

    def test_a_source_outside_the_private_storage_root_is_not_accepted(self) -> None:
        """The branch is genuinely this repository's, so only the path rule refuses this."""
        self.rewrite(source=str(Path(tempfile.mkdtemp(prefix="elsewhere-")) / "main-task-fake"))
        tasks, errors = worktree.list_retained(self.main, self.store)
        self.assertEqual((tasks, errors), ([], []))

    def test_a_project_root_that_climbs_out_is_refused(self) -> None:
        self.rewrite(project_rel="../../escape")
        tasks, errors = worktree.list_retained(self.main, self.store)
        self.assertEqual(tasks, [])
        self.assertTrue(errors, "a corrupt record is reported, not silently skipped")

    def test_re_retaining_does_not_turn_it_into_a_record_of_this_project(self) -> None:
        """If the rewrite named THIS project as the source, the record would stop being nested --
        and the next apply would write a delegated checkout's delta into the user's own files."""
        task = worktree.list_retained(self.main, self.store)[0][0]
        self.assertIsNone(task.retain("re-stated", task.changed_paths))
        payload = json.loads(self.record.read_text(encoding="utf-8"))
        self.assertEqual(Path(payload["source"]), self.child.project_root)
        again = worktree.list_retained(self.main, self.store)[0][0]
        self.assertEqual(again.reason, "re-stated")
        self.assertFalse(again.available, "still nested, still never applied from here")


class AnotherProjectsRecordIsStillNotShownTest(unittest.TestCase):
    """The storage root is shared and the task prefix comes from a directory NAME, so two projects
    both called `main` produce records that look alike. An ordinary record is separated by its
    recorded source; a nested one has given that up, so ownership comes from the branch."""

    def test_a_same_named_projects_nested_record_is_invisible(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="dgc-nested-two-")).resolve()
        store = base / "store"
        mine = repo(base / "mine" / "main")
        theirs = repo(base / "theirs" / "main")
        their_child = prepare(theirs, "child", store)
        their_grand = prepare(their_child.project_root, "grand", store)
        (their_grand.project_root / "a.txt").write_text("theirs\n", encoding="utf-8")
        their_grand.retain("their work", their_grand.changed_paths())

        self.assertTrue(any(p.stem.startswith("main-task-") for p in store.glob("*.json")),
                        "the premise: the stems collide")
        tasks, errors = worktree.list_retained(mine, store)
        self.assertEqual((tasks, errors), ([], []),
                         "another project's delegated work must not appear in mine")
        their_tasks, _ = worktree.list_retained(theirs, store)
        self.assertEqual([task.reason for task in their_tasks], ["their work"],
                         "and it must still be reachable from the project it belongs to")


if __name__ == "__main__":
    unittest.main()
