"""An isolated sub-agent must be able to write outside its own worktree.

Found in a real session on another machine: 15 refusals across 7 delegated tasks, over days, with
the message "the file was not changed - DGC could not capture its pre-edit state first: this turn
has no recovery point to record into". One of the tasks was named "write architecture findings
file" and could not write the file it existed to write. Others could not drop a test runner in
/tmp to run the tests they had been asked to run.

Cause: `checkpoints.open()` runs only at depth 0, so an isolated sub-agent -- which gets its OWN
CheckpointManager rather than sharing the parent's -- never has a recovery point. Writes inside its
worktree skip the capture (the worktree is disposable), so only writes OUTSIDE it hit the refusal,
which is why this looked intermittent.

The fix follows what the code already said should happen: a write by absolute path into the
parent's tree "is an ordinary mutation of the user's files and must be captured like any other, or
nothing can take it back" -- so it is captured by the parent's manager, the one that can undo it.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc.checkpoints import CheckpointManager


class ExternalWriteTest(unittest.TestCase):
    def setUp(self):
        self.parent_root = Path(tempfile.mkdtemp())
        self.worktree = Path(tempfile.mkdtemp())

    def test_a_fresh_managers_refusal_is_the_bug_we_saw(self):
        # The child's own manager, exactly as an isolated sub-agent gets it.
        child = CheckpointManager(project_root=self.worktree)
        target = self.parent_root / "findings.md"
        target.write_text("before\n")
        self.assertFalse(child.record_file(str(target)))
        self.assertEqual(child.last_record_error,
                         "this turn has no recovery point to record into")

    def test_the_parents_manager_can_take_it(self):
        parent = CheckpointManager(project_root=self.parent_root)
        parent.open(0, "the parent turn", [])
        target = self.parent_root / "findings.md"
        target.write_text("before\n")
        self.assertTrue(parent.record_file(str(target)),
                        "the parent's turn has a recovery point, so it can capture the write")

    def test_a_temp_path_is_captured_too(self):
        # /tmp scripts were the other half of the failures: a task asked to run tests could not
        # write the runner it needed.
        parent = CheckpointManager(project_root=self.parent_root)
        parent.open(0, "the parent turn", [])
        tmp = Path(tempfile.mkdtemp()) / "runner.sh"
        tmp.write_text("echo hi\n")
        self.assertTrue(parent.record_file(str(tmp)))

    def test_the_wiring_is_present(self):
        import inspect

        from dgc import agent
        loop = inspect.getsource(agent.Agent)
        self.assertIn("_external_checkpoints = self.checkpoints", loop,
                      "an isolated child must be handed the manager that can undo its external writes")
        self.assertIn("keeper = self.checkpoints", loop)
        self.assertIn("keeper.record_file", loop,
                      "the capture must go through the chosen manager, not always self's")

    def test_an_external_write_still_needs_a_capture(self):
        # The point of the gate: a write into the user's tree must remain undoable. Routing it to
        # the parent must not become a way to skip the capture entirely.
        import inspect

        from dgc import agent
        loop = inspect.getsource(agent.Agent)
        self.assertIn("_within_own_checkout(self, args.get(\"path\"))", loop)
        self.assertIn("the file was not changed", loop,
                      "a capture that cannot be made must still refuse the edit")


if __name__ == "__main__":
    unittest.main()
