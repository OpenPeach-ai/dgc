"""A repository too large to enumerate must still record what the chat changed.

Reported from a live session: after a reload, every row in "Edited files" answered a click with
"That file is no longer in the workspace change set." The persisted journal was
`{"version": 1, "files": [], "incomplete": true}` -- empty, so nothing was reviewable or undoable.

Three mechanisms stacked:

1. `Review.entries()` REFUSES a repository with more than MAX_FILES entries. That is right for
   `/diff`, which the user asked for and which should say it cannot show everything. It is wrong
   for the chat's own journal.
2. `capture()` was all-or-nothing: any deadline, entry cap or byte cap returned an EMPTY result.
3. `finish()` turned an incomplete capture into `return` -- discarding the turn's real changes --
   and `incomplete` is sticky, so one trip killed the feature for the rest of the session.

The reporting repository had 3,389 tracked + 701 untracked = 4,090 names against a 4,096 cap. Six
files of headroom, and a 5-second deadline for reading every file TWICE per turn.

The selection matters as much as the bound: a sorted PREFIX was measured taking 4,096 `f*.txt`
files and excluding the one file the turn edited. A chat change is by definition a file that
differs from HEAD, so that is what a bounded capture selects.
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

from dgc.chat_changes import ChatChanges, capture      # noqa: E402
from dgc.git_review import MAX_FILES, Review           # noqa: E402


def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def repository(extra_files: int) -> Path:
    root = Path(tempfile.mkdtemp(prefix="dgc-bigrepo-"))
    git("init", "-q", ".", cwd=root)
    git("config", "user.email", "t@t", cwd=root)
    git("config", "user.name", "t", cwd=root)
    (root / "real.txt").write_text("before\n", encoding="utf-8")
    for i in range(extra_files):
        (root / f"f{i:05d}.txt").write_text("x\n", encoding="utf-8")
    git("add", "-A", cwd=root)
    git("commit", "-qm", "init", cwd=root)
    return root


class ThePremiseTest(unittest.TestCase):
    def test_a_large_repository_really_refuses_enumeration(self) -> None:
        root = repository(MAX_FILES + 40)
        review = Review(root, root, deadline=__import__("time").monotonic() + 5)
        with self.assertRaises(ValueError) as caught:
            review.entries()
        self.assertIn("entries", str(caught.exception),
                      "if this stops raising, the fallback below is guarding nothing")


class ALargeRepositoryStillRecordsItsChangesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = repository(MAX_FILES + 40)

    def journal_after(self, change) -> dict:
        journal = ChatChanges(self.root)
        before = journal.begin()
        change()
        journal.finish(before)
        return journal.report()

    def test_capture_says_it_is_bounded_rather_than_pretending(self) -> None:
        snapshot = capture(self.root)
        self.assertFalse(snapshot["complete"],
                         "a bounded capture must announce itself so the UI can say 'partial'")

    def test_an_edit_to_a_previously_clean_file_survives(self) -> None:
        report = self.journal_after(
            lambda: (self.root / "real.txt").write_text("after\n", encoding="utf-8"))
        self.assertEqual([f["path"] for f in report["files"]], ["real.txt"],
                         "this is the edit the user clicks on after a reload")
        self.assertFalse(report["complete"], "and it is still honest about being partial")

    def test_a_new_file_is_recorded_as_untracked(self) -> None:
        report = self.journal_after(
            lambda: (self.root / "brand_new.txt").write_text("hello\n", encoding="utf-8"))
        self.assertEqual([(f["path"], f["untracked"]) for f in report["files"]],
                         [("brand_new.txt", True)])

    def test_a_turn_that_changes_nothing_records_nothing(self) -> None:
        """A bounded capture must not invent changes -- that would be worse than losing them."""
        self.assertEqual(self.journal_after(lambda: None)["files"], [])

    def test_a_deleted_file_is_recorded(self) -> None:
        report = self.journal_after(lambda: (self.root / "real.txt").unlink())
        self.assertEqual([(f["path"], f["deleted"]) for f in report["files"]], [("real.txt", True)])

    def test_the_journal_survives_a_save_and_reload(self) -> None:
        """The actual complaint: the rows were there, and a reloaded session could not use them."""
        journal = ChatChanges(self.root)
        before = journal.begin()
        (self.root / "real.txt").write_text("after\n", encoding="utf-8")
        journal.finish(before)
        restored = ChatChanges.from_state(self.root, journal.state())
        self.assertEqual([f["path"] for f in restored.report()["files"]], ["real.txt"])
        self.assertIn("after", restored.read("real.txt")["after"],
                      "a restored row must still open its diff, not answer 'no longer in the set'")


class SmallRepositoriesAreUnaffectedTest(unittest.TestCase):
    def test_a_normal_repository_still_reports_complete(self) -> None:
        root = repository(5)
        journal = ChatChanges(root)
        before = journal.begin()
        (root / "real.txt").write_text("after\n", encoding="utf-8")
        journal.finish(before)
        report = journal.report()
        self.assertEqual([f["path"] for f in report["files"]], ["real.txt"])
        self.assertTrue(report["complete"], "nothing was bounded, so nothing may claim it was")


if __name__ == "__main__":
    unittest.main()


class ABoundedCaptureKeepsTheSameExclusionsTest(unittest.TestCase):
    """The bounded path selects from `git status`, which lists things the normal path filters out.

    DGC's own folder holds browser screenshots and locks. They are not edits made in the chat, and
    the unbounded listing drops them explicitly; a bounded capture that pulled them in would put
    DGC's own state into the user's change set precisely in the large repositories where the bound
    applies.
    """

    def test_dgc_state_and_dependency_dirs_stay_out_of_a_bounded_capture(self) -> None:
        root = repository(MAX_FILES + 40)
        (root / ".dgc").mkdir(exist_ok=True)
        (root / ".dgc" / "shot.png").write_bytes(b"\x89PNG\r\n")
        (root / "node_modules").mkdir(exist_ok=True)
        (root / "node_modules" / "dep.js").write_text("module.exports = 1\n", encoding="utf-8")
        (root / "real.txt").write_text("after\n", encoding="utf-8")

        journal = ChatChanges(root)
        before = journal.begin()
        (root / "real.txt").write_text("after again\n", encoding="utf-8")
        journal.finish(before)
        paths = [f["path"] for f in journal.report()["files"]]
        self.assertNotIn(".dgc/shot.png", paths)
        self.assertFalse([p for p in paths if p.startswith(".dgc/")], paths)
        self.assertFalse([p for p in paths if p.startswith("node_modules/")], paths)
