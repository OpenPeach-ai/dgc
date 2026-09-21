"""A rewind is DGC undoing DGC. It must never undo somebody else.

`_restore` rewrote a file from a snapshot with no regard for what was in it now, so a rewind
silently destroyed an edit another chat -- or the person in their editor -- had made since. Nothing
reported it. This is the first thing that has to be true before DGC runs several chats at once.

The distinction the guard draws: DGC records what it LEFT in a file (record_file already captured
what was there BEFORE), so at rewind time it can tell its own work from anyone else's.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc.checkpoints import CheckpointManager


class RewindGuardTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.file = self.root / "shared.py"
        self.file.write_text("original\n")

    def armed(self) -> CheckpointManager:
        """A manager with one rewind point, having made and recorded one edit of its own."""
        m = CheckpointManager(project_root=self.root)
        m.open(0, "before the turn", [])
        m.record_file(str(self.file))
        self.file.write_text("DGC's edit\n")
        m.note_written(str(self.file))
        return m

    def test_dgc_can_still_undo_its_own_edit(self):
        m = self.armed()
        count, files = m.rewind(0)
        self.assertGreaterEqual(count, 0, "a normal rewind must still work")
        self.assertEqual(self.file.read_text(), "original\n")
        self.assertEqual(m.last_rewind_conflicts, [])

    def test_an_edit_made_since_is_not_overwritten(self):
        m = self.armed()
        self.file.write_text("someone else's work\n")
        count, files = m.rewind(0)
        self.assertEqual(count, -1, "the rewind must refuse")
        self.assertEqual(files, 0)
        self.assertEqual(self.file.read_text(), "someone else's work\n")
        self.assertEqual(m.last_rewind_conflicts, [str(self.file)])

    def test_nothing_at_all_is_restored_when_one_file_clashes(self):
        # A partial rewind leaves the workspace in a state neither side chose.
        other = self.root / "untouched.py"
        other.write_text("before\n")
        m = CheckpointManager(project_root=self.root)
        m.open(0, "before the turn", [])
        m.record_file(str(self.file)); m.record_file(str(other))
        self.file.write_text("DGC a\n"); m.note_written(str(self.file))
        other.write_text("DGC b\n"); m.note_written(str(other))
        self.file.write_text("someone else\n")          # only one file clashes
        self.assertEqual(m.rewind(0)[0], -1)
        self.assertEqual(other.read_text(), "DGC b\n", "the clean file must not be rolled back")

    def test_a_file_already_holding_the_old_content_is_not_a_clash(self):
        # Restoring it would change nothing, so there is nothing to protect.
        m = self.armed()
        self.file.write_text("original\n")
        self.assertGreaterEqual(m.rewind(0)[0], 0)

    def test_a_file_deleted_since_is_a_clash(self):
        m = self.armed()
        self.file.unlink()
        self.assertEqual(m.rewind(0)[0], -1)
        self.assertFalse(self.file.exists(), "a deletion someone else made stands")

    def test_it_fires_on_evidence_not_on_uncertainty(self):
        # A file DGC has no record of writing -- an older session, one resumed before this was
        # tracked -- must NOT be refused. Refusing on "I cannot tell" refuses every rewind after a
        # restart, which is far more common than a concurrent edit; the full suite caught exactly
        # that when this guard first shipped, with six durable-rewind tests going red.
        m = CheckpointManager(project_root=self.root)
        m.open(0, "before the turn", [])
        m.record_file(str(self.file))
        self.file.write_text("changed by somebody\n")
        self.assertGreaterEqual(m.rewind(0)[0], 0,
                                "no record of what DGC left is not evidence of a foreign edit")

    def test_what_dgc_left_survives_a_resume(self):
        # So the guard keeps working after a restart rather than quietly going blind.
        m = self.armed()
        state = m.state()
        self.assertIn("left", state)
        revived = CheckpointManager.from_state(state, self.root)
        self.file.write_text("someone else's work\n")
        self.assertEqual(revived.rewind(0)[0], -1, "a resumed session still guards")
        self.assertEqual(self.file.read_text(), "someone else's work\n")

    @unittest.skipUnless(hasattr(os, "symlink"), "needs symlinks")
    def test_a_symlink_repointed_since_is_a_clash(self):
        link = self.root / "link.py"
        (self.root / "a.txt").write_text("a\n")
        (self.root / "b.txt").write_text("b\n")
        os.symlink(self.root / "a.txt", link)
        m = CheckpointManager(project_root=self.root)
        m.open(0, "before", [])
        m.record_file(str(link))
        m.note_written(str(link))
        link.unlink(); os.symlink(self.root / "b.txt", link)
        self.assertEqual(m.rewind(0)[0], -1)
        self.assertEqual(os.readlink(str(link)), str(self.root / "b.txt"))

    def test_the_refusal_names_the_files(self):
        # A bare "rewind failed" over somebody else's edit reads as a bug. It is the one case
        # where DGC declining to act is the whole point, so it has to say so.
        m = self.armed()
        self.file.write_text("someone else's work\n")
        m.rewind(0)
        self.assertEqual(m.last_rewind_conflicts, [str(self.file)])

    def test_the_conflict_list_is_cleared_by_a_clean_rewind(self):
        m = self.armed()
        self.file.write_text("someone else\n")
        self.assertEqual(m.rewind(0)[0], -1)
        self.file.write_text("DGC's edit\n")            # put back what DGC left
        self.assertGreaterEqual(m.rewind(0)[0], 0)
        self.assertEqual(m.last_rewind_conflicts, [])


if __name__ == "__main__":
    unittest.main()
