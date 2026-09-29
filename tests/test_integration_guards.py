"""The guards that decide whether a sub-agent's delta is allowed to touch your files.

Six of them refuse an integration, and five had no test at all — only "isolated checkout changed"
was covered. They are the entire safety story for delegation: each one exists because the state it
checks makes the delta unsafe to apply, and each is one deleted line away from passing vacuously.
This tree has already been bitten twice by exactly that shape (TheChildCheckoutMustHoldStillTest and
TheSafetyInvariantTest both exist for it).

Also pinned here: the rollback, which had no test either; that an interrupt rolls back at all (it
did not — `except Exception` does not catch KeyboardInterrupt, so Ctrl-C between two files left the
checkout half-applied); the breadcrumb on both apply paths; and that a `git pull` during a
delegation is no longer reported as the user having edited files by hand.
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

from dgc.worktree import TaskWorkspace, list_retained, resolve_retained            # noqa: E402


def project(files: dict) -> Path:
    repo = Path(tempfile.mkdtemp(prefix="dgc-guards-"))
    run = lambda *a: subprocess.run(a, cwd=repo, check=True, capture_output=True)   # noqa: E731
    run("git", "init", "-q", ".")
    run("git", "config", "user.email", "t@t")
    run("git", "config", "user.name", "t")
    for name, data in files.items():
        (repo / name).write_text(data, encoding="utf-8")
    run("git", "add", "-A")
    run("git", "commit", "-qm", "init")
    return repo


def write(root: Path, name: str, data: str) -> None:
    (root / name).write_text(data, encoding="utf-8")


def read(root: Path, name: str) -> str:
    return (root / name).read_text(encoding="utf-8")


class _Checkpoints:
    """The duck-typed stub the integration paths accept, with a hook at the one mid-flight moment."""

    def __init__(self, on_record=None):
        self.on_record, self.recorded = on_record, []

    def record_file(self, target: str) -> bool:
        self.recorded.append(target)
        return True if self.on_record is None else self.on_record(target)

    def note_written(self, target: str) -> None:
        pass


class TheLiveGuardsTest(unittest.TestCase):
    """TaskWorkspace.integrate — the path a delegation takes when it finishes."""

    def setUp(self) -> None:
        self.repo = project({"a.txt": "base a\n", "b.txt": "base b\n"})
        self.store = Path(tempfile.mkdtemp(prefix="dgc-guards-store-"))
        workspace, error = TaskWorkspace.prepare(self.repo, "task", self.store)
        self.assertIsNotNone(workspace, error)
        self.workspace = workspace
        write(Path(workspace.path), "a.txt", "child a\n")
        write(Path(workspace.path), "b.txt", "child b\n")

    def test_the_parent_changing_mid_loop_abandons_the_delta(self) -> None:
        """Between the check and the write, someone else moved the file DGC is about to overwrite."""
        seen = {"n": 0}

        def moving(_target):
            seen["n"] += 1
            if seen["n"] == 1:
                write(self.repo, "b.txt", "a human typed this\n")
            return True

        result = self.workspace.integrate(checkpoints=_Checkpoints(moving))
        self.assertEqual(result.status, "error")
        # The exact message, because two checks bracket `record_file` and a looser assertion cannot
        # tell them apart: this one fires BEFORE the capture, on a file the loop has not reached yet.
        self.assertIn("parent changed during integration", result.error)
        self.assertEqual(read(self.repo, "b.txt"), "a human typed this\n",
                         "the human's bytes must survive")

    def test_the_parent_changing_INSIDE_the_capture_window_is_caught_too(self) -> None:
        """The other half of the bracket: the file moves between the pre-check and the write, in
        the window the checkpoint capture itself opens."""
        def moving(target):
            if Path(target).name == "a.txt":
                write(self.repo, "a.txt", "a human typed this\n")
            return True

        result = self.workspace.integrate(checkpoints=_Checkpoints(moving))
        self.assertEqual(result.status, "error")
        self.assertIn("parent changed during checkpoint capture", result.error)
        self.assertEqual(read(self.repo, "a.txt"), "a human typed this\n")

    def test_a_checkpoint_that_cannot_capture_stops_everything(self) -> None:
        """No recovery point means no way back, so the delta must not land at all."""
        result = self.workspace.integrate(checkpoints=_Checkpoints(lambda _t: False))
        self.assertEqual(result.status, "error")
        self.assertIn("could not capture rewind checkpoint", result.error)
        self.assertEqual(read(self.repo, "a.txt"), "base a\n")
        self.assertEqual(read(self.repo, "b.txt"), "base b\n")

    def test_an_ordinary_failure_mid_loop_puts_every_applied_file_back(self) -> None:
        """The rollback itself, which had no test."""
        seen = {"n": 0}

        def explode(_target):
            seen["n"] += 1
            if seen["n"] == 2:
                raise RuntimeError("the disk fell over")
            return True

        result = self.workspace.integrate(checkpoints=_Checkpoints(explode))
        self.assertEqual(result.status, "error")
        self.assertIn("integration failed", result.error)
        self.assertEqual(read(self.repo, "a.txt"), "base a\n", "the first file was rolled back")
        self.assertEqual(read(self.repo, "b.txt"), "base b\n")

    def test_an_interrupt_mid_loop_rolls_back_and_is_not_swallowed(self) -> None:
        """`except Exception` does not catch KeyboardInterrupt. Ctrl-C between two files skipped the
        rollback entirely and left the checkout half-applied — measured before this was fixed."""
        seen = {"n": 0}

        def interrupt(_target):
            seen["n"] += 1
            if seen["n"] == 2:
                raise KeyboardInterrupt
            return True

        with self.assertRaises(KeyboardInterrupt):
            self.workspace.integrate(checkpoints=_Checkpoints(interrupt))
        self.assertEqual(read(self.repo, "a.txt"), "base a\n",
                         "an interrupt must roll back what it had already applied")
        self.assertEqual(read(self.repo, "b.txt"), "base b\n")

    def test_a_failed_rollback_names_the_path_it_could_not_restore(self) -> None:
        """The one outcome that genuinely loses consistency. It must say which file."""
        import dgc.worktree as worktree
        real = worktree._replace_state
        state = {"applied": 0}

        def flaky(target, value):
            name = Path(target).name
            if state["applied"] >= 1 and name == "a.txt":     # refuse only the ROLLBACK write
                raise OSError(13, "Permission denied")
            real(target, value)
            if name == "a.txt":
                state["applied"] += 1

        def explode(_target):
            if state["applied"] >= 1:
                raise RuntimeError("the disk fell over")
            return True

        worktree._replace_state = flaky
        try:
            result = self.workspace.integrate(checkpoints=_Checkpoints(explode))
        finally:
            worktree._replace_state = real
        self.assertEqual(result.status, "error")
        self.assertIn("rollback incomplete", result.error)
        self.assertIn("a.txt", result.error, "it has to say which file it could not put back")

    def test_a_breadcrumb_is_on_disk_WHILE_the_apply_is_in_flight(self) -> None:
        """The one thing that survives a process being killed outright, which no handler can catch.
        It is written before the loop, so it has to be visible from inside it."""
        seen = {}

        def look(_target):
            if "tasks" not in seen:
                tasks, _errors = list_retained(self.repo, self.store)
                seen["tasks"] = [t.reason for t in tasks]
            return True

        self.workspace.integrate(checkpoints=_Checkpoints(look))
        self.assertEqual(len(seen.get("tasks", [])), 1,
                         "nothing on disk said an integration was in flight")
        self.assertIn("in progress", seen["tasks"][0])

    def test_an_interrupted_apply_says_so_and_can_still_be_applied(self) -> None:
        """Interrupted, the rollback puts the parent back — so the record is not a torn apply, it is
        work still waiting. `/tasks apply` must finish it."""
        def interrupt(_target):
            raise KeyboardInterrupt

        with self.assertRaises(KeyboardInterrupt):
            self.workspace.integrate(checkpoints=_Checkpoints(interrupt))
        tasks, errors = list_retained(self.repo, self.store)
        self.assertEqual(errors, [])
        self.assertEqual(len(tasks), 1, "an interrupted apply must be visible to /tasks")
        self.assertIn("interrupted", tasks[0].reason)
        outcome = resolve_retained(self.repo, tasks[0].id, "apply", self.store,
                                   checkpoints=_Checkpoints())
        self.assertEqual(outcome.status, "applied", outcome.error)
        self.assertEqual(read(self.repo, "a.txt"), "child a\n")
        self.assertEqual(read(self.repo, "b.txt"), "child b\n")


class TheRetainedGuardsTest(unittest.TestCase):
    """RetainedTask.integrate — the `/tasks apply` retry a user drives by hand. Its three guards are
    twins of the live ones and had no test either."""

    def setUp(self) -> None:
        self.repo = project({"a.txt": "base a\n", "b.txt": "base b\n"})
        self.store = Path(tempfile.mkdtemp(prefix="dgc-guards-store-"))
        workspace, error = TaskWorkspace.prepare(self.repo, "task", self.store)
        self.assertIsNotNone(workspace, error)
        write(Path(workspace.path), "a.txt", "child a\n")
        write(Path(workspace.path), "b.txt", "child b\n")
        self.assertIsNone(workspace.retain("held for review", workspace.changed_paths()))
        self.workspace = workspace

    def retained(self):
        tasks, errors = list_retained(self.repo, self.store)
        self.assertEqual(errors, [])
        self.assertEqual(len(tasks), 1, tasks)
        return tasks[0]

    def test_the_parent_changing_mid_retry_abandons_the_delta(self) -> None:
        seen = {"n": 0}

        def moving(_target):
            seen["n"] += 1
            if seen["n"] == 1:
                write(self.repo, "b.txt", "a human typed this\n")
            return True

        result = self.retained().integrate(checkpoints=_Checkpoints(moving))
        self.assertEqual(result.status, "error")
        # Exact, for the same reason as the live path: two checks bracket the capture.
        self.assertIn("parent changed during retained integration", result.error)
        self.assertEqual(read(self.repo, "b.txt"), "a human typed this\n")

    def test_a_checkpoint_that_cannot_capture_stops_the_retry_too(self) -> None:
        result = self.retained().integrate(checkpoints=_Checkpoints(lambda _t: False))
        self.assertEqual(result.status, "error")
        self.assertIn("could not capture rewind checkpoint", result.error)
        self.assertEqual(read(self.repo, "a.txt"), "base a\n")

    def test_the_retained_checkout_moving_mid_retry_abandons_the_delta(self) -> None:
        """Somebody edited the held worktree between /tasks listing it and applying it."""
        child_root = Path(self.workspace.path)

        def moving(_target):
            write(child_root, "b.txt", "edited in the held checkout\n")
            return True

        result = self.retained().integrate(checkpoints=_Checkpoints(moving))
        self.assertEqual(result.status, "error")
        self.assertIn("retained checkout changed during integration", result.error)

    def test_an_interrupt_mid_retry_rolls_back_too(self) -> None:
        """The retry path has its own copy of the loop, and its own copy of the bug."""
        seen = {"n": 0}

        def interrupt(_target):
            seen["n"] += 1
            if seen["n"] == 2:
                raise KeyboardInterrupt
            return True

        with self.assertRaises(KeyboardInterrupt):
            self.retained().integrate(checkpoints=_Checkpoints(interrupt))
        self.assertEqual(read(self.repo, "a.txt"), "base a\n",
                         "an interrupt must roll back what the retry had already applied")
        self.assertEqual(read(self.repo, "b.txt"), "base b\n")

    def test_the_retry_path_leaves_a_breadcrumb_as_well(self) -> None:
        """It had none, and it is the path a user drives AFTER something already went wrong once."""
        seen = {}

        def look(_target):
            if "reasons" not in seen:
                tasks, _errors = list_retained(self.repo, self.store)
                seen["reasons"] = [t.reason for t in tasks]
            return True

        self.retained().integrate(checkpoints=_Checkpoints(look))
        self.assertTrue(any("in progress" in r for r in seen.get("reasons", [])),
                        f"the retry path said nothing while it was applying: {seen}")


class APullIsNotAHandEditTest(unittest.TestCase):
    """`git pull` during a delegation moves every file the delegation touched, and from the file
    state alone that is indistinguishable from the user editing them — so DGC said "someone outside
    this task edited them" about files nobody had touched."""

    def integrate_after(self, move_head: bool):
        repo = project({"a.txt": "one\ntwo\nthree\n"})
        store = Path(tempfile.mkdtemp(prefix="dgc-guards-head-"))
        workspace, error = TaskWorkspace.prepare(repo, "task", store)
        self.assertIsNotNone(workspace, error)
        write(Path(workspace.path), "a.txt", "ONE\ntwo\nthree\n")      # the child's edit
        write(repo, "a.txt", "one\ntwo\nTHREE\n")                      # a parent-side change
        if move_head:
            run = lambda *a: subprocess.run(a, cwd=repo, check=True, capture_output=True)  # noqa: E731
            run("git", "add", "-A")
            run("git", "commit", "-qm", "a pull landed")
        return workspace.integrate(checkpoints=_Checkpoints())

    def test_a_moved_head_is_reported_as_a_moved_branch(self) -> None:
        result = self.integrate_after(move_head=True)
        self.assertIn(result.status, ("applied", "partial"), result.error)
        self.assertTrue(result.head_moved, "the branch really did move")

    def test_an_ordinary_hand_edit_is_not_blamed_on_the_branch(self) -> None:
        result = self.integrate_after(move_head=False)
        self.assertIn(result.status, ("applied", "partial"), result.error)
        self.assertFalse(result.head_moved,
                         "HEAD did not move, so the user really did edit it")


if __name__ == "__main__":
    unittest.main()
