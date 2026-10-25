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


class HelperDeleteTests(unittest.TestCase):
    def test_d4b_a_file_a_helpers_integration_removed_comes_back(self):
        c = Chat(self, {"old.py": b"old\n"})
        turn = c.turn("helper deletes old.py")
        target = c.p("old.py")
        self.assertTrue(c.cp.record_file(str(target)))      # as worktree.py integrates a delete
        target.unlink()
        c.cp.note_written(str(target))
        self.assertGreaterEqual(c.cp.rewind(turn)[0], 0)
        self.assertEqual(target.read_bytes(), b"old\n")


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




# ---------------------------------------------------------------------------------------------------
# The agent: a turn's own commands, its hooks, its helpers, and the editor's undo_to
# ---------------------------------------------------------------------------------------------------
import threading
import time
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc.config import Config
from dgc.llm import ChatResult, LLMClient, ToolCall
from test_subagents import HarnessCase, Script, clone_fixture


def run_git(root: Path, *args):
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)


def by_prompt(**turns):
    """A scripted parent for several turns in one chat: routed by the newest prompt, not the first."""
    def route(messages, results, cancel):
        users = [i for i, m in enumerate(messages) if m.get("role") == "user"]
        last = users[-1] if users else 0
        prompt = str(messages[last].get("content", "")) if users else ""
        done = [m for m in messages[last:] if m.get("role") == "tool"]
        for needle, calls in turns.items():
            if needle.replace("_", " ") in prompt:
                return steps(*calls)(messages, done, cancel)
        raise AssertionError(f"no turn for {prompt[:60]!r}")
    return route


def steps(*calls, final="Done."):
    """A scripted parent: each tool call in turn, then a final answer."""
    def route(messages, results, cancel):
        if len(results) < len(calls):
            return ChatResult(tool_calls=[calls[len(results)]])
        return ChatResult(content=final)
    return route


class CommandUndoTests(HarnessCase):
    """§4.2 and §4.4: what the main chat's own commands change is put back by Undo when its earlier
    state is exact, and named on the card ("Changed by a command — Undo leaves it") when it is not."""

    def repo(self, files: dict[str, str], git=True, **config):
        h = self.make(git=git, mode="auto", **config)
        for name, text in files.items():
            (h.root / name).parent.mkdir(parents=True, exist_ok=True)
            (h.root / name).write_text(text)
        if git:
            run_git(h.root, "add", "-A")
            run_git(h.root, "commit", "-qm", "files")
        return h

    def turn(self, h, prompt, *calls):
        self.assertTrue(h.run(prompt, [(prompt, steps(*calls))]))
        return h.agent.last_turn_files

    def rows(self, card):
        return {row["path"]: (row["status"], row.get("command", False)) for row in card["files"]}

    def undo(self, h, index=0, overwrite=None):
        return h.agent.rewind(index, overwrite=overwrite), h.agent.last_rewind

    def test_d5_a_sed_on_a_clean_tracked_file_is_on_the_card_and_undone(self):
        h = self.repo({"a.py": "a = 1\n", "b.py": "x = 1\n"})
        card = self.turn(h, "edit and sed", ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "1",
                                                                        "new_string": "2"}),
                         ToolCall("b1", "bash", {"command": "sed -i 's/1/2/' b.py"}))
        self.assertEqual(self.rows(card), {"a.py": ("modified", False), "b.py": ("modified", False)})
        (count, restored), outcome = self.undo(h)
        self.assertGreaterEqual(count, 0, outcome)
        self.assertEqual(restored, 2)
        self.assertEqual(((h.root / "a.py").read_text(), (h.root / "b.py").read_text()), ("a = 1\n", "x = 1\n"))
        self.assertEqual(outcome["left"], [])

    def test_d4a_a_tracked_file_a_command_deleted_comes_back(self):
        h = self.repo({"old.py": "old\n", "a.py": "a\n"})
        card = self.turn(h, "delete old", ToolCall("b1", "bash", {"command": "rm old.py"}))
        self.assertEqual(self.rows(card), {"old.py": ("deleted", False)})
        (count, restored), _ = self.undo(h)
        self.assertEqual((count >= 0, restored), (True, 1))
        self.assertEqual((h.root / "old.py").read_text(), "old\n")

    def test_a_file_a_command_created_is_removed_again(self):
        h = self.repo({"a.py": "a\n"})
        card = self.turn(h, "generate", ToolCall("b1", "bash", {"command": "echo made > gen.txt"}))
        self.assertEqual(self.rows(card), {"gen.txt": ("new", False)})
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertFalse((h.root / "gen.txt").exists())

    def test_d8_an_untracked_file_a_command_changed_is_named_and_left(self):
        h = self.repo({"a.py": "a\n"})
        (h.root / "notes.txt").write_text("my notes\n")          # untracked: no exact earlier state
        card = self.turn(h, "append notes", ToolCall("b1", "bash", {"command": "echo more >> notes.txt"}))
        self.assertEqual(card["files"], [{"path": "notes.txt", "additions": 0, "deletions": 0, "counted": False,
                                          "status": "modified", "command": True}])
        self.assertEqual(card["total"], 1)
        (count, restored), outcome = self.undo(h)
        self.assertEqual((count >= 0, restored, outcome["left"]), (True, 0, ["notes.txt"]))
        self.assertEqual((h.root / "notes.txt").read_text(), "my notes\nmore\n", "left as it is, and said so")

    def test_a_file_with_uncommitted_changes_a_command_changed_is_named_and_left(self):
        h = self.repo({"c.py": "c = 1\n"})
        (h.root / "c.py").write_text("c = 1\n# the person's uncommitted line\n")
        card = self.turn(h, "sed c", ToolCall("b1", "bash", {"command": "sed -i 's/1/2/' c.py"}))
        self.assertEqual(self.rows(card), {"c.py": ("modified", True)})

    def test_d6_a_command_after_dgcs_own_edit_is_dgcs_own_and_undo_restores_the_turn(self):
        for git in (True, False):
            with self.subTest(git=git):
                h = self.repo({"a.py": "x = 1\n"}, git=git)
                self.turn(h, "edit then sed", ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "x = 1",
                                                                           "new_string": "x = 1\ny = 1"}),
                          ToolCall("b1", "bash", {"command": "sed -i 's/1/2/g' a.py"}))
                self.assertEqual((h.root / "a.py").read_text(), "x = 2\ny = 2\n")
                (count, _), outcome = self.undo(h)
                self.assertGreaterEqual(count, 0, outcome)
                self.assertEqual((h.root / "a.py").read_text(), "x = 1\n")

    def test_d6_a_formatter_hook_after_an_edit_does_not_lock_undo(self):
        hooks = {"PostToolUse": [{"command": "sed -i 's/ugly/pretty/' a.py"}]}
        h = self.repo({"a.py": "x = 1\n"}, hooks=hooks)
        self.turn(h, "edit with hook", ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "x = 1",
                                                                    "new_string": "x = 'ugly'"}))
        self.assertEqual((h.root / "a.py").read_text(), "x = 'pretty'\n", "the hook formatted DGC's edit")
        (count, _), outcome = self.undo(h)
        self.assertGreaterEqual(count, 0, outcome)
        self.assertEqual((h.root / "a.py").read_text(), "x = 1\n")

    def test_d7_a_sed_before_the_edit_is_undone_too(self):
        h = self.repo({"a.py": "x = 1\n"})
        self.turn(h, "sed then edit", ToolCall("b1", "bash", {"command": "sed -i 's/1/2/' a.py"}),
                  ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "x = 2", "new_string": "x = 3"}))
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual((h.root / "a.py").read_text(), "x = 1\n", "Git's copy was the file's exact state")

    def test_a_person_editing_between_dgcs_edit_and_its_command_still_stops_undo(self):
        h = self.repo({"a.py": "x = 1\n"})

        def person_then_sed(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "x = 1",
                                                                           "new_string": "x = 2"})])
            if len(results) == 1:
                (h.root / "a.py").write_text("x = 2\n# typed by the person\n")
                return ChatResult(tool_calls=[ToolCall("b1", "bash", {"command": "sed -i 's/2/3/' a.py"})])
            return ChatResult(content="Done.")
        self.assertTrue(h.run("racing", [("racing", person_then_sed)]))
        (count, _), outcome = self.undo(h)
        self.assertEqual(count, -1)
        self.assertEqual(outcome["conflicts"], [{"path": "a.py", "reason": "between"}])
        self.assertIn("typed by the person", (h.root / "a.py").read_text())

    def test_the_cost_of_the_look_around_a_command_is_recorded(self):
        h = self.repo({"a.py": "a\n"})
        self.turn(h, "one command", ToolCall("b1", "bash", {"command": "true"}))
        costs = h.agent.__dict__.get("_command_watch_costs")
        self.assertEqual(len(costs), 1)
        self.assertLess(costs[0], 2.0)


class HelperUndoTests(HarnessCase):
    def test_d13_an_isolated_helpers_write_outside_its_copy_is_guarded(self):
        h = self.make(git=True, mode="auto")
        outside = Path(tempfile.mkdtemp(prefix="dgc-outside-")).resolve()
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", str(outside)]))
        notes = outside / "notes.md"
        notes.write_text("before\n")
        h.answer("permission_request", {"decision": "once"})

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("p1", "task", {
                    "description": "write notes", "prompt": "CHILD write the notes", "agent": "worker"})])
            return ChatResult(content="The helper wrote the notes.")

        def worker(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("w1", "write_file", {"path": str(notes),
                                                                            "content": "helper\n"})])
            return ChatResult(content="Wrote them.")
        self.assertTrue(h.run("parent: notes", [("CHILD write", worker), ("parent: notes", parent)]))
        self.assertEqual(notes.read_text(), "helper\n", "the helper's write landed")
        notes.write_text("helper\nthe person's edit\n")
        self.assertEqual(h.agent.rewind(0)[0], -1, "the parent's guard knows what the helper left")
        self.assertIn("the person's edit", notes.read_text())

    def test_a_rewind_stops_a_background_helper_its_turn_started(self):
        h = self.make(git=True, mode="auto")
        go, release = threading.Event(), threading.Event()

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("p1", "task", {
                    "description": "slow work", "prompt": "CHILD slow work", "agent": "worker",
                    "background": True})])
            return ChatResult(content="A helper is on it.")

        def worker(messages, results, cancel):
            if not results:
                go.set()
                release.wait(20)
                return ChatResult(tool_calls=[ToolCall("w1", "bash", {"command": "echo late > late.txt"})])
            return ChatResult(content="Done late.")
        with patch.object(LLMClient, "chat", Script([("CHILD slow", worker), ("parent: start", parent)])), \
                patch.object(Config, "clone_for_root", clone_fixture):
            self.assertTrue(h.agent.run_turn("parent: start a helper"))
            self.assertTrue(go.wait(10))
            count, _ = h.agent.rewind(0)
            self.assertGreaterEqual(count, 0, h.agent.last_rewind)
            self.assertEqual(h.agent.last_rewind["stopped"], 1)
            release.set()
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and getattr(h.agent, "_detached_jobs", None):
                time.sleep(0.05)
        self.assertFalse((h.root / "late.txt").exists(), "nothing landed after the Undo")
        lines = [f["message"] for f in h.of("info")]
        self.assertIn("1 background helper from those turns was stopped.", lines)


class UndoToCommandTests(HarnessCase):
    """The editor's `undo_to`: a refusal says whose changes, Undo anyway goes ahead for exactly those."""

    def test_refusal_then_undo_anyway(self):
        h = self.make(git=True, mode="auto")
        (h.root / "a.py").write_text("one\n")
        run_git(h.root, "add", "-A")
        run_git(h.root, "commit", "-qm", "a")
        route = by_prompt(turn_1=[ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "one",
                                                                "new_string": "ONE"})],
                          turn_2=[ToolCall("e2", "edit_file", {"path": "a.py", "old_string": "mine",
                                                                "new_string": "mine\nTWO"})])
        self.assertTrue(h.run("turn 1", [("turn", route)]))
        (h.root / "a.py").write_text("ONE\nmine\n")
        self.assertTrue(h.run("turn 2", [("turn", route)]))
        h.backend._dispatch({"type": "undo_to", "index": 0, "request_id": "u1"})
        [answer] = [f for f in h.of("undo_result") if f["request_id"] == "u1"]
        self.assertEqual((answer["ok"], answer["conflicts"]), (False, [{"path": "a.py", "reason": "between"}]))
        h.backend._dispatch({"type": "undo_to", "index": 0, "overwrite": ["a.py"], "request_id": "u2"})
        [answer] = [f for f in h.of("undo_result") if f["request_id"] == "u2"]
        self.assertEqual((answer["ok"], answer["files_restored"], answer["conflicts"]), (True, 1, []))
        self.assertEqual((h.root / "a.py").read_text(), "one\n")
        self.assertEqual([f["ok"] for f in h.of("rewound")], [False, True], "every client still gets `rewound`")
        for frame in h.of("undo_result"):
            self.assertIsNone(ep.event_error(frame), frame)

    def test_declared_offered_and_vendored(self):
        self.assertIsNone(ep.command_error({"type": "undo_to", "index": 0, "request_id": "r"}))
        self.assertIsNone(ep.command_error({"type": "undo_to", "index": 0, "overwrite": ["a.py"], "request_id": "r"}))
        self.assertIsNotNone(ep.command_error({"type": "undo_to", "index": 0}), "the answer needs its request")
        project = Path(__file__).resolve().parents[1]
        self.assertEqual((project / "sdk/python/dgc_sdk/wire/editor_protocol.py").read_text(),
                         (project / "dgc/editor_protocol.py").read_text())
        known = (project / "sdk/typescript/src/transport.ts").read_text()
        self.assertIn('"undo_result"', known.split("KNOWN_EVENTS", 1)[1].split("]);", 1)[0])
        self.assertIn('"undo_to": 1', (project / "dgc/headless.py").read_text())



class TerminalRewindTests(unittest.TestCase):
    """The full-screen terminal's /rewind: the true count, a refusal's question, and its last line."""

    class Fake:
        def __init__(self, agent):
            from types import SimpleNamespace
            self.agent = agent
            self.overlays, self.flashes, self.infos = [], [], []
            self.blocks = SimpleNamespace(clear=lambda: None)

        def _open_overlay(self, rows, **kw):
            self.overlays.append((rows, kw))

        def _flash(self, msg, secs=2.2):
            self.flashes.append(msg)

        def info(self, msg):
            self.infos.append(msg)

        def _render_history(self):
            pass

        def _invalidate(self):
            pass

    def fake(self, agent):
        from dgc import tui as tui_mod
        fake = self.Fake(agent)
        for name in ("_do_rewind", "_ask_rewind_anyway", "_confirm_rewind"):
            setattr(fake, name, getattr(tui_mod.TUI, name).__get__(fake))
        return fake

    def test_d16_the_question_counts_every_file_the_rewind_restores(self):
        c = Chat(self, {"a.py": b"a\n", "b.py": b"b\n", "c.py": b"c\n"})
        for n, name in enumerate(("a.py", "b.py", "c.py")):
            c.turn(f"t{n}")
            c.write(name, name.upper().encode())
        from types import SimpleNamespace
        fake = self.fake(SimpleNamespace(checkpoints=c.cp))
        fake._confirm_rewind(0)
        header = " ".join(t.plain for t in fake.overlays[-1][1]["header"])
        self.assertIn("Reverts 3 file(s)", header, "t0 recorded one file; the rewind restores three")

    def test_a_refusal_asks_keep_or_undo_anyway_and_undo_anyway_overwrites_exactly_those(self):
        from types import SimpleNamespace
        calls = []

        def rewind(index, overwrite=None):
            calls.append((index, overwrite))
            if overwrite is None:
                agent.last_rewind = {"conflicts": [{"path": "a.py", "reason": "between"}], "error": "",
                                     "left": [], "stopped": 0}
                return (-1, 0)
            agent.last_rewind = {"conflicts": [], "error": "", "left": ["notes.txt"], "stopped": 1}
            return (0, 2)
        agent = SimpleNamespace(rewind=rewind)
        fake = self.fake(agent)
        fake._do_rewind(0)
        rows, kw = fake.overlays[-1]
        self.assertEqual([r["value"] for r in rows], ["keep", "anyway"], "Enter keeps the person's changes")
        self.assertEqual(kw["header"][0].plain, "These files changed after DGC wrote them, by you or another "
                         "program: a.py. Undo anyway puts back the version from before this turn and loses those "
                         "changes.")
        kw["on_pick"]({"value": "keep"})
        self.assertEqual(calls, [(0, None)])
        kw["on_pick"]({"value": "anyway"})
        self.assertEqual(calls, [(0, None), (0, ["a.py"])])
        self.assertEqual(fake.flashes[-1], "↩ Undone; DGC restored 2 files. 1 file changed by a command was left as "
                                           "it is.")
        self.assertEqual(fake.infos, ["1 background helper from those turns was stopped."])

    def test_any_other_refusal_says_why(self):
        from types import SimpleNamespace
        agent = SimpleNamespace()

        def rewind(index, overwrite=None):
            agent.last_rewind = {"conflicts": [], "error": "DGC could not write ro/b.py: Permission denied",
                                 "left": [], "stopped": 0}
            return (-1, 0)
        agent.rewind = rewind
        fake = self.fake(agent)
        fake._do_rewind(0)
        self.assertEqual(fake.flashes, ["Undo stopped: DGC could not write ro/b.py: Permission denied"])


if __name__ == "__main__":
    unittest.main()
