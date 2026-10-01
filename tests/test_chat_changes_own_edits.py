"""The changes bar reports a turn's own edits wherever the bounded workspace scan stopped.

The scan is bounded: a non-Git folder past 4,096 files records nothing, a repository with more
changed files than that keeps a prefix, a slow tree stops at the deadline. An edit it did not reach
was invisible, and the bar said "Changes not recorded" while the model edited files in front of you.
DGC's own file tools know what they write, so those edits never depend on the scan.
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc.chat_changes import ChatChanges  # noqa: E402
from dgc.git_review import MAX_FILES  # noqa: E402


class OwnEditsTest(unittest.TestCase):
    def big_folder(self) -> Path:
        """A non-Git folder the scan cannot list whole."""
        root = Path(tempfile.mkdtemp(prefix="dgc-own-edits-"))
        bulk = root / "bulk"
        bulk.mkdir()
        for index in range(MAX_FILES + 10):
            (bulk / f"f{index:05d}.txt").write_text("x\n")
        (root / "src").mkdir()
        (root / "src" / "app.py").write_text("print('old')\n")
        return root

    def edit(self, changes: ChatChanges, path: Path, text: str) -> None:
        changes.touched(path)                    # what the file tool does just before writing
        path.write_text(text)

    def small_repo(self) -> Path:
        root = Path(tempfile.mkdtemp(prefix="dgc-own-edits-git-"))
        for args in (["init", "-q", "."], ["config", "user.email", "t@t"], ["config", "user.name", "t"]):
            subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
        (root / "kept.txt").write_text("k\n")
        subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-qm", "init"], cwd=root, check=True, capture_output=True)
        return root

    def test_a_file_a_shell_command_made_earlier_in_the_turn_is_new(self):
        """`printf 'a\\n' > notes.txt`, then an edit_file: recorded as an edit of an existing 'a'."""
        root = self.small_repo()
        changes = ChatChanges(root)
        before = changes.begin()
        self.assertTrue(before["complete"], "premise: a small repository is scanned whole")
        (root / "notes.txt").write_text("a\n")            # the shell command, earlier in the turn
        self.edit(changes, root / "notes.txt", "b\n")
        changes.finish(before)
        files = {f["path"]: f for f in changes.report()["files"]}
        self.assertTrue(files["notes.txt"]["untracked"], "a file the turn created read as an edit")
        self.assertEqual((files["notes.txt"]["additions"], files["notes.txt"]["deletions"]), (1, 0))

    def test_a_tool_edit_is_reported_in_a_folder_too_big_to_scan(self):
        root = self.big_folder()
        changes = ChatChanges(root)
        before = changes.begin()
        self.assertFalse(before["complete"], "premise: the scan cannot list this folder whole")
        self.edit(changes, root / "src" / "app.py", "print('new')\n")
        changes.finish(before)
        report = changes.report()
        self.assertEqual([f["path"] for f in report["files"]], ["src/app.py"],
                         "the turn's own edit was invisible to the changes bar")
        self.assertEqual((report["files"][0]["additions"], report["files"][0]["deletions"]), (1, 1))

    def test_the_live_view_shows_it_mid_turn(self):
        root = self.big_folder()
        changes = ChatChanges(root)
        before = changes.begin()
        self.edit(changes, root / "src" / "app.py", "print('mid-turn')\n")
        live = changes.view().report()
        self.assertEqual([f["path"] for f in live["files"]], ["src/app.py"],
                         "mid-turn the bar said Changes not recorded")
        self.assertEqual(changes.report()["files"], [], "an inspection never writes durable evidence")
        changes.finish(before)

    def test_a_file_the_tool_created_is_new_and_one_it_restored_is_not_a_change(self):
        root = self.big_folder()
        changes = ChatChanges(root)
        before = changes.begin()
        self.edit(changes, root / "src" / "new.py", "x = 1\n")
        self.edit(changes, root / "src" / "app.py", "print('old')\n")   # written back unchanged
        changes.finish(before)
        files = {f["path"]: f for f in changes.report()["files"]}
        self.assertEqual(set(files), {"src/new.py"})
        self.assertTrue(files["src/new.py"]["untracked"])

    def test_a_path_outside_the_chat_is_never_its_change(self):
        root = self.big_folder()
        elsewhere = Path(tempfile.mkdtemp(prefix="dgc-own-edits-outside-")) / "x.txt"
        elsewhere.write_text("a\n")
        changes = ChatChanges(root)
        before = changes.begin()
        self.edit(changes, elsewhere, "b\n")
        changes.finish(before)
        self.assertEqual(changes.report()["files"], [])

    def test_the_next_turn_starts_with_nothing_remembered(self):
        root = self.big_folder()
        changes = ChatChanges(root)
        first = changes.begin()
        self.edit(changes, root / "src" / "app.py", "print('one')\n")
        changes.finish(first)
        second = changes.begin()
        changes.finish(second)
        report = changes.report()
        self.assertEqual(len(report["files"]), 1)
        self.assertEqual(len(changes.files["src/app.py"]), 1, "a finished turn's record leaked into the next")


    def test_a_turn_that_never_finished_leaves_nothing_for_the_next(self):
        root = self.big_folder()
        changes = ChatChanges(root)
        changes.begin()
        changes.touched(root / "src" / "app.py")          # recorded, then the turn died before writing
        later = changes.begin()
        (root / "src" / "app.py").write_text("print('external, between turns')\n")
        changes.finish(later)
        self.assertEqual(changes.report()["files"], [],
                         "a dead turn's record made an outside edit look like this turn's own")

if __name__ == "__main__":
    unittest.main()
