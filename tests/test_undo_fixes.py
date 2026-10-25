"""Undo never loses the person's work (the founder, 25 Oct: "fix all of these for 0.48").

The study (dgc-work/codex-undo-study/REPORT.md, cases D1-D16) drove DGC's real CheckpointManager and
found where a rewind discarded work nobody asked it to discard, or refused for no reason:

- D2/D2b/D2d: somebody's change made BETWEEN two of DGC's writes to a file was lost when an older turn
  was undone (the guard compared the disk only with DGC's latest write);
- D6: DGC's own command or formatter after one of its edits made the turn impossible to undo;
- D4a/D5/D8: a command's changes were never undone and never said so;
- D10: a later `chmod` was silently reverted (the guard compared bytes only);
- D13: an isolated helper's write outside its copy was noted in the wrong manager, so no guard;
- D14: the "what DGC left" record was saved for only the last 4,096 files;
- D15: a rewind that failed for any reason but a conflict said no more than "could not";
- and a second Undo right after a first one refused, over DGC's own restore.

These are those cases as tests. Each fails on the base (chatdgc at 243f8eab) and passes now.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

from dgc import checkpoints as cpmod
from dgc.checkpoints import CheckpointManager


class Chat:
    """A recovery-point manager over a temporary folder, written to the way the agent writes:
    record_file() before each edit-tool write, note_written() after it (dgc/agent.py)."""

    def __init__(self, case: unittest.TestCase, files: dict[str, bytes] | None = None, git: bool = False):
        directory = tempfile.TemporaryDirectory(prefix="dgc-undo-")
        case.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        for name, data in (files or {}).items():
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_bytes(data)
        if git:
            for args in (["init", "-q"], ["config", "user.email", "t@dgc.invalid"], ["config", "user.name", "t"],
                         ["add", "-A"], ["commit", "-qm", "base", "--allow-empty"]):
                subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)
        self.cp = CheckpointManager(self.root)

    def p(self, name) -> Path:
        return self.root / name

    def turn(self, prompt="a turn") -> int:
        assert self.cp.open(0, prompt, [])
        return len(self.cp.points) - 1

    def write(self, name, data: bytes) -> None:
        path = self.p(name)
        assert self.cp.record_file(str(path)), self.cp.last_record_error
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.cp.note_written(str(path))

    def restart(self) -> None:
        self.cp = CheckpointManager.from_state(json.loads(json.dumps(self.cp.state())), self.root)


class BetweenTurnsTests(unittest.TestCase):
    """§4.1: a change made after DGC wrote a file and before DGC wrote it again is somebody's work."""

    def test_d2_the_persons_line_typed_between_two_turns_stops_undo_of_the_first(self):
        c = Chat(self, {"a.py": b"one\ntwo\nthree\n"})
        first = c.turn("turn 1")
        c.write("a.py", b"one\nTWO\nthree\n")
        c.p("a.py").write_bytes(b"one\nTWO\nthree\n# the person's own line\n")      # between the turns
        c.turn("turn 2")
        c.write("a.py", b"one\nTWO\nTHREE\n# the person's own line\n")
        self.assertEqual(c.cp.rewind(first), (-1, 0), "the rewind must not bury the person's line")
        self.assertIn(b"the person's own line", c.p("a.py").read_bytes())
        self.assertEqual(c.cp.last_rewind_conflicts, [str(c.p("a.py"))])
        self.assertEqual(c.cp.last_rewind_reasons, {str(c.p("a.py")): "between"})

    def test_d2_a_rewind_to_the_later_turn_alone_keeps_the_change_and_is_not_stopped(self):
        c = Chat(self, {"a.py": b"one\n"})
        c.turn("turn 1")
        c.write("a.py", b"ONE\n")
        c.p("a.py").write_bytes(b"ONE\nmine\n")
        second = c.turn("turn 2")
        c.write("a.py", b"ONE\nmine\nTWO\n")
        self.assertGreaterEqual(c.cp.rewind(second)[0], 0, "turn 2's own before-state holds the person's line")
        self.assertEqual(c.p("a.py").read_bytes(), b"ONE\nmine\n")

    def test_d2_the_evidence_survives_a_restart(self):
        c = Chat(self, {"a.py": b"one\n"})
        first = c.turn("turn 1")
        c.write("a.py", b"ONE\n")
        c.p("a.py").write_bytes(b"ONE\nmine\n")
        c.turn("turn 2")
        c.write("a.py", b"ONE\nmine\nTWO\n")
        c.restart()
        self.assertEqual(c.cp.rewind(first)[0], -1)
        self.assertEqual(c.cp.last_rewind_reasons, {str(c.p("a.py")): "between"})

    def test_d2b_a_new_file_the_person_added_to_between_turns_is_not_deleted(self):
        c = Chat(self, {"keep.txt": b"k\n"})
        first = c.turn("turn 1")
        c.write("new.py", b"def f():\n    return 1\n")
        c.p("new.py").write_bytes(b"def f():\n    return 1\n\ndef users_function():\n    return 'mine'\n")
        c.turn("turn 2")
        c.write("new.py", b"def f():\n    return 2\n\ndef users_function():\n    return 'mine'\n")
        self.assertEqual(c.cp.rewind(first)[0], -1)
        self.assertIn(b"users_function", c.p("new.py").read_bytes(), "never deleted with the person's work in it")

    def test_d2d_a_save_made_while_the_turn_ran_is_not_lost_by_undo_of_that_turn(self):
        c = Chat(self, {"a.py": b"one\ntwo\n"})
        turn = c.turn("long turn")
        c.write("a.py", b"one\nTWO\n")
        c.p("a.py").write_bytes(b"one\nTWO\n# saved mid-turn\n")              # the person saves
        c.write("a.py", b"ONE\nTWO\n# saved mid-turn\n")                       # DGC writes on top
        self.assertEqual(c.cp.rewind(turn)[0], -1)
        self.assertEqual(c.cp.last_rewind_reasons, {str(c.p("a.py")): "between"})
        self.assertIn(b"saved mid-turn", c.p("a.py").read_bytes())

    def test_undo_anyway_restores_once_the_person_names_exactly_those_files(self):
        c = Chat(self, {"a.py": b"one\n", "b.py": b"b\n"})
        first = c.turn("turn 1")
        c.write("a.py", b"ONE\n")
        c.write("b.py", b"B\n")
        c.p("a.py").write_bytes(b"ONE\nmine\n")
        c.turn("turn 2")
        c.write("a.py", b"ONE\nmine\nTWO\n")
        self.assertEqual(c.cp.rewind(first)[0], -1)
        c.p("b.py").write_bytes(b"B\nalso mine\n")             # a second change appears after the question
        self.assertEqual(c.cp.rewind(first, overwrite=[str(c.p("a.py"))])[0], -1,
                         "agreeing to lose a.py's changes is not agreeing to lose b.py's")
        self.assertEqual(c.cp.last_rewind_conflicts, [str(c.p("a.py")), str(c.p("b.py"))], "both named again")
        count, restored = c.cp.rewind(first, overwrite=[str(c.p("a.py")), str(c.p("b.py"))])
        self.assertGreaterEqual(count, 0)
        self.assertEqual((restored, c.p("a.py").read_bytes(), c.p("b.py").read_bytes()), (2, b"one\n", b"b\n"))
        self.assertEqual(c.cp.last_rewind_conflicts, [])

    def test_d2c_and_d1_kept_a_change_after_the_last_write_still_stops_the_rewind(self):
        c = Chat(self, {"a.py": b"one\n"})
        first = c.turn("turn 1")
        c.write("a.py", b"ONE\n")
        c.turn("turn 2")
        c.write("a.py", b"ONE\nTWO\n")
        c.p("a.py").write_bytes(b"ONE\nTWO\nmine\n")
        self.assertEqual(c.cp.rewind(first)[0], -1)
        self.assertEqual(c.cp.last_rewind_reasons, {str(c.p("a.py")): "changed"})

    def test_no_record_of_what_dgc_left_is_still_not_evidence(self):
        c = Chat(self, {"a.py": b"one\n"})
        turn = c.turn()
        self.assertTrue(c.cp.record_file(str(c.p("a.py"))))
        c.p("a.py").write_bytes(b"changed by somebody\n")
        self.assertGreaterEqual(c.cp.rewind(turn)[0], 0)


class GuardDetailTests(unittest.TestCase):
    def test_d10_a_chmod_made_after_dgc_wrote_the_file_is_a_conflict_not_silently_reverted(self):
        c = Chat(self, {"run.sh": b"#!/bin/sh\necho hi\n"})
        os.chmod(c.p("run.sh"), 0o755)
        turn = c.turn()
        c.write("run.sh", b"#!/bin/sh\necho bye\n")
        os.chmod(c.p("run.sh"), 0o700)
        self.assertEqual(c.cp.rewind(turn)[0], -1)
        self.assertEqual(c.cp.last_rewind_reasons, {str(c.p("run.sh")): "mode"})
        self.assertEqual(stat.S_IMODE(c.p("run.sh").stat().st_mode), 0o700)

    def test_d10_the_mode_dgc_left_survives_a_restart(self):
        c = Chat(self, {"run.sh": b"#!/bin/sh\n"})
        os.chmod(c.p("run.sh"), 0o755)
        c.turn()
        c.write("run.sh", b"#!/bin/sh\necho\n")
        c.restart()
        os.chmod(c.p("run.sh"), 0o644)
        self.assertEqual(c.cp.rewind(0)[0], -1)

    def test_a_session_saved_before_modes_were_recorded_still_rewinds(self):
        c = Chat(self, {"run.sh": b"#!/bin/sh\n"})
        os.chmod(c.p("run.sh"), 0o755)
        c.turn()
        c.write("run.sh", b"#!/bin/sh\necho\n")
        state = json.loads(json.dumps(c.cp.state()))
        state.pop("left_modes")
        c.cp = CheckpointManager.from_state(state, c.root)
        self.assertGreaterEqual(c.cp.rewind(0)[0], 0, "no mode on record is no evidence")
        self.assertEqual(stat.S_IMODE(c.p("run.sh").stat().st_mode), 0o755)

    def test_d9_binary_bytes_come_back_exactly(self):
        blob = bytes(range(256)) * 4 + b"\x00\xff"
        c = Chat(self, {"img.bin": blob})
        turn = c.turn()
        c.write("img.bin", b"\x89PNG\r\n\x1a\n" + b"\x00" * 50)
        self.assertGreaterEqual(c.cp.rewind(turn)[0], 0)
        self.assertEqual(c.p("img.bin").read_bytes(), blob)

    def test_d14_what_dgc_left_is_saved_for_every_file_a_point_holds(self):
        saved = cpmod._MAX_FILES_PER_POINT
        cpmod._MAX_FILES_PER_POINT = 3                  # the cap, made small; it was the last 4,096 files
        self.addCleanup(setattr, cpmod, "_MAX_FILES_PER_POINT", saved)
        c = Chat(self, {f"f{n}.txt": b"0\n" for n in range(9)})
        for start in (0, 3, 6):
            c.turn(f"turn {start}")
            for n in range(start, start + 3):
                c.write(f"f{n}.txt", b"1\n")
        state = c.cp.state()
        self.assertEqual(len(state["left"]), 9, "every file a live point holds")
        c.restart()
        c.p("f0.txt").write_bytes(b"the person's\n")
        self.assertEqual(c.cp.rewind(0)[0], -1, "the guard still knows the oldest file after a restart")
        self.assertEqual(c.p("f0.txt").read_bytes(), b"the person's\n")

    def test_a_second_undo_right_after_the_first_is_not_refused_over_dgcs_own_restore(self):
        c = Chat(self, {"a.py": b"one\n"})
        first = c.turn("turn 1")
        c.write("a.py", b"ONE\n")
        second = c.turn("turn 2")
        c.write("a.py", b"ONE\nTWO\n")
        self.assertGreaterEqual(c.cp.rewind(second)[0], 0)
        self.assertEqual(c.p("a.py").read_bytes(), b"ONE\n")
        self.assertGreaterEqual(c.cp.rewind(first)[0], 0, "a.py holds what DGC itself just put back")
        self.assertEqual(c.p("a.py").read_bytes(), b"one\n")


class FailureTests(unittest.TestCase):
    @unittest.skipIf(os.geteuid() == 0, "root writes into a read-only folder")
    def test_d15_a_rewind_that_cannot_write_a_file_says_which_and_why_and_changes_nothing(self):
        c = Chat(self, {"a.py": b"a\n", "ro/b.py": b"b\n"})
        turn = c.turn()
        c.write("a.py", b"A\n")
        c.write("ro/b.py", b"B\n")
        os.chmod(c.p("ro"), 0o555)
        self.addCleanup(os.chmod, c.p("ro"), 0o755)
        self.assertEqual(c.cp.rewind(turn)[0], -1)
        self.assertEqual(c.cp.last_rewind_conflicts, [])
        self.assertEqual(c.cp.last_rewind_error, "DGC could not write ro/b.py: Permission denied; "
                                                 "the files it had already put back are as they were")
        self.assertEqual((c.p("a.py").read_bytes(), c.p("ro/b.py").read_bytes()), (b"A\n", b"B\n"))
        self.assertEqual(len(c.cp.points), 1, "the point is kept")

    def test_a_point_that_is_gone_says_so(self):
        c = Chat(self)
        self.assertEqual(c.cp.rewind(3)[0], -1)
        self.assertEqual(c.cp.last_rewind_error, "that recovery point is no longer there")


class FolderTests(unittest.TestCase):
    def test_d3_the_empty_folders_dgcs_own_write_created_go_with_the_file(self):
        c = Chat(self, {"keep.txt": b"k\n"})
        turn = c.turn()
        c.write("pkg/sub/new.py", b"print('new')\n")
        self.assertGreaterEqual(c.cp.rewind(turn)[0], 0)
        self.assertFalse(c.p("pkg").exists(), "pkg/ and pkg/sub/ were DGC's, and empty again")

    def test_a_folder_that_now_holds_somebody_elses_file_stays(self):
        c = Chat(self, {"keep.txt": b"k\n"})
        turn = c.turn()
        c.write("pkg/sub/new.py", b"print('new')\n")
        c.p("pkg/notes.txt").write_bytes(b"mine\n")
        self.assertGreaterEqual(c.cp.rewind(turn)[0], 0)
        self.assertFalse(c.p("pkg/sub").exists())
        self.assertEqual(c.p("pkg/notes.txt").read_bytes(), b"mine\n")

    def test_a_folder_that_was_there_before_is_never_removed(self):
        c = Chat(self, {"pkg/.keep": b""})
        c.p("pkg/.keep").unlink()                          # pkg/ exists and is empty before the turn
        turn = c.turn()
        c.write("pkg/new.py", b"x\n")
        self.assertGreaterEqual(c.cp.rewind(turn)[0], 0)
        self.assertTrue(c.p("pkg").is_dir())


class CommandRowTests(unittest.TestCase):
    def test_a_file_a_command_changed_that_undo_cannot_put_back_is_listed_and_survives_a_restart(self):
        c = Chat(self, {"a.py": b"a\n", "scratch.txt": b"s\n"})
        turn = c.turn()
        c.write("a.py", b"A\n")
        self.assertTrue(c.cp.note_command_change(str(c.p("scratch.txt")), "modified"))
        rows, total = c.cp.changes(turn, commands=True)
        self.assertEqual([(Path(r["path"]).name, r["status"], r.get("command", False)) for r in rows],
                         [("a.py", "modified", False), ("scratch.txt", "modified", True)])
        self.assertEqual(total, 2)
        self.assertEqual(c.cp.changes(turn)[1], 1, "what a rewind restores never counts it")
        c.restart()
        self.assertEqual(len(c.cp.changes(turn, commands=True)[0]), 2)
        count, restored = c.cp.rewind(turn)
        self.assertEqual((count >= 0, restored), (True, 1))
        self.assertEqual(c.cp.last_rewind_left, [str(c.p("scratch.txt"))])
        self.assertEqual(c.p("scratch.txt").read_bytes(), b"s\n", "left as it is")

    def test_a_turn_whose_only_change_is_a_command_keeps_its_point(self):
        c = Chat(self, {"scratch.txt": b"s\n"})
        c.turn()
        c.cp.note_command_change(str(c.p("scratch.txt")), "modified")
        self.assertFalse(c.cp.discard_last_empty(), "its card has something to say")


if __name__ == "__main__":
    unittest.main()
