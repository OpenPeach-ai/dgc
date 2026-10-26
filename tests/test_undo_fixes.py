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


MODULE = (b"def total(items):\n    return sum(items)\n\n\n"
          b"def tax(amount):\n    return amount * 0.18\n\n\n"
          b"def discount(amount):\n    return amount\n")


class BetweenTurnsTests(unittest.TestCase):
    """§4.1, merged (the founder, 25 Oct: "yes want them now in 0.48.0"): a change somebody made after
    DGC wrote a file -- between two of DGC's writes, during a turn, or after its last one -- is kept,
    and DGC's own changes are taken out, by a 3-way merge with what DGC left (its after-bytes). Only
    when their edits overlap DGC's is the file held back and named."""

    def d2(self, c, person=b"\n\ndef mine():\n    return 'the person'\n"):
        """Turn 1 changes tax(); the person adds a function at the end; turn 2 changes total()."""
        first = c.turn("turn 1")
        c.write("a.py", MODULE.replace(b"0.18", b"0.2"))
        c.p("a.py").write_bytes(c.p("a.py").read_bytes() + person)                    # between the turns
        c.turn("turn 2")
        c.write("a.py", c.p("a.py").read_bytes().replace(b"sum(items)", b"round(sum(items))"))
        return first

    def test_d2_the_persons_function_typed_between_two_turns_is_kept_and_dgcs_changes_go(self):
        c = Chat(self, {"a.py": MODULE})
        first = self.d2(c)
        self.assertEqual(c.cp.undo_plan(first), {"merged": [str(c.p("a.py"))], "held": []})
        self.assertEqual(c.cp.rewind(first), (0, 1))
        self.assertEqual(c.p("a.py").read_bytes(), MODULE + b"\n\ndef mine():\n    return 'the person'\n")
        self.assertEqual(c.cp.last_rewind_merged, [str(c.p("a.py"))])

    def test_d2_a_rewind_to_the_later_turn_alone_keeps_the_change_and_is_not_stopped(self):
        c = Chat(self, {"a.py": b"one\n"})
        c.turn("turn 1")
        c.write("a.py", b"ONE\n")
        c.p("a.py").write_bytes(b"ONE\nmine\n")
        second = c.turn("turn 2")
        c.write("a.py", b"ONE\nmine\nTWO\n")
        self.assertGreaterEqual(c.cp.rewind(second)[0], 0, "turn 2's own before-state holds the person's line")
        self.assertEqual(c.p("a.py").read_bytes(), b"ONE\nmine\n")

    def test_d2_the_merge_base_survives_a_restart(self):
        c = Chat(self, {"a.py": MODULE})
        first = self.d2(c)
        c.restart()
        self.assertEqual(c.cp.rewind(first), (0, 1), "DGC's after-bytes were saved with the points")
        self.assertIn(b"def mine()", c.p("a.py").read_bytes())
        self.assertIn(b"0.18", c.p("a.py").read_bytes())

    def test_a_tampered_after_state_is_refused_on_load(self):
        c = Chat(self, {"a.py": MODULE})
        self.d2(c)
        state = json.loads(json.dumps(c.cp.state()))
        state["points"][0]["writes"]["a.py"][0]["after"]["data"] = "dGFtcGVyZWQK"   # "tampered\n"
        self.assertEqual(CheckpointManager.from_state(state, c.root).points, [])

    def test_d2b_a_new_file_the_person_added_to_keeps_only_their_lines(self):
        c = Chat(self, {"keep.txt": b"k\n"})
        first = c.turn("turn 1")
        c.write("new.py", b"def f():\n    return 1\n")
        c.p("new.py").write_bytes(b"def f():\n    return 1\n\n\ndef users_function():\n    return 'mine'\n")
        c.turn("turn 2")
        c.write("new.py", b"def f():\n    return 2\n\n\ndef users_function():\n    return 'mine'\n")
        self.assertGreaterEqual(c.cp.rewind(first)[0], 0)
        self.assertEqual(c.p("new.py").read_bytes(), b"def users_function():\n    return 'mine'\n",
                         "DGC created the file: its lines go, the person's stay")

    def test_d2d_a_save_made_while_the_turn_ran_is_merged_on_undo(self):
        c = Chat(self, {"a.py": MODULE})
        turn = c.turn("long turn")
        c.write("a.py", MODULE.replace(b"0.18", b"0.2"))
        c.p("a.py").write_bytes(c.p("a.py").read_bytes() + b"\n\n# saved mid-turn\n")   # the person saves
        c.write("a.py", c.p("a.py").read_bytes().replace(b"sum(items)", b"round(sum(items))"))
        self.assertEqual(c.cp.rewind(turn), (0, 1))
        self.assertEqual(c.p("a.py").read_bytes(), MODULE + b"\n\n# saved mid-turn\n")

    def test_d1_and_d2c_an_edit_after_dgcs_last_write_is_kept_too(self):
        c = Chat(self, {"a.py": MODULE})
        first = c.turn("turn 1")
        c.write("a.py", MODULE.replace(b"0.18", b"0.2"))
        c.turn("turn 2")
        c.write("a.py", c.p("a.py").read_bytes().replace(b"sum(items)", b"round(sum(items))"))
        c.p("a.py").write_bytes(c.p("a.py").read_bytes().replace(b"return amount\n", b"return amount * 0.9\n"))
        self.assertEqual(c.cp.rewind(first), (0, 1))
        self.assertEqual(c.p("a.py").read_bytes(), MODULE.replace(b"return amount\n", b"return amount * 0.9\n"))

    def test_an_overlapping_edit_is_held_back_and_named(self):
        c = Chat(self, {"a.py": MODULE, "b.py": b"b\n"})
        first = c.turn("turn 1")
        c.write("a.py", MODULE.replace(b"0.18", b"0.2"))
        c.write("b.py", b"B\n")
        c.p("a.py").write_bytes(MODULE.replace(b"0.18", b"0.25"))            # the same line DGC changed
        self.assertEqual(c.cp.undo_plan(first), {"merged": [], "held": [{"path": str(c.p("a.py")),
                                                                          "reason": "overlap"}]})
        self.assertEqual(c.cp.rewind(first)[0], -1, "named, nothing written")
        self.assertEqual(c.cp.last_rewind_reasons, {str(c.p("a.py")): "overlap"})
        self.assertEqual(c.cp.rewind(first, keep=[str(c.p("a.py"))]), (0, 1), "held back: the rest is undone")
        self.assertEqual((c.p("a.py").read_bytes(), c.p("b.py").read_bytes()),
                         (MODULE.replace(b"0.18", b"0.25"), b"b\n"))
        self.assertEqual(c.cp.last_rewind_kept, [str(c.p("a.py"))])

    def test_undo_anyway_still_puts_back_the_before_state_over_an_overlap(self):
        c = Chat(self, {"a.py": MODULE})
        first = c.turn("turn 1")
        c.write("a.py", MODULE.replace(b"0.18", b"0.2"))
        c.p("a.py").write_bytes(MODULE.replace(b"0.18", b"0.25"))
        self.assertEqual(c.cp.rewind(first, overwrite=[str(c.p("a.py"))]), (0, 1))
        self.assertEqual(c.p("a.py").read_bytes(), MODULE)

    def test_crlf_files_merge_byte_for_byte(self):
        crlf = MODULE.replace(b"\n", b"\r\n")
        c = Chat(self, {"a.py": crlf})
        first = c.turn("turn 1")
        c.write("a.py", crlf.replace(b"0.18", b"0.2"))
        c.p("a.py").write_bytes(c.p("a.py").read_bytes() + b"\r\n\r\n# mine\r\n")
        self.assertEqual(c.cp.rewind(first), (0, 1))
        self.assertEqual(c.p("a.py").read_bytes(), crlf + b"\r\n\r\n# mine\r\n")

    def test_no_final_newline_merges_without_adding_one(self):
        bare = MODULE.rstrip(b"\n")
        c = Chat(self, {"a.py": bare})
        first = c.turn("turn 1")
        c.write("a.py", bare.replace(b"0.18", b"0.2"))
        c.p("a.py").write_bytes(b"# mine\n\n\n" + c.p("a.py").read_bytes())
        self.assertEqual(c.cp.rewind(first), (0, 1))
        self.assertEqual(c.p("a.py").read_bytes(), b"# mine\n\n\n" + bare)

    def test_binary_and_over_the_cap_keep_refusing(self):
        blob = bytes(range(256)) * 8
        c = Chat(self, {"img.bin": blob, "big.txt": b"x\n" * 10})
        first = c.turn("turn 1")
        c.write("img.bin", blob[::-1])
        c.p("img.bin").write_bytes(blob[::-1] + b"\x00mine")
        saved = cpmod._MERGE_MAX_BYTES
        cpmod._MERGE_MAX_BYTES = 8                 # the 1 MiB cap, made small
        self.addCleanup(setattr, cpmod, "_MERGE_MAX_BYTES", saved)
        c.write("big.txt", b"y\n" * 10)
        c.p("big.txt").write_bytes(b"y\n" * 10 + b"mine\n")
        self.assertEqual(c.cp.rewind(first)[0], -1)
        self.assertEqual(c.cp.last_rewind_reasons, {str(c.p("img.bin")): "binary", str(c.p("big.txt")): "large"})

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
        self.assertEqual(c.cp.last_rewind_error, "couldn't write ro/b.py (Permission denied)")
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


class CommandHelpers:
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


class CommandUndoTests(CommandHelpers, HarnessCase):
    """§4.2 and §4.4: what the main chat's own commands change is put back by Undo when its earlier
    state is exact, and named on the card ("Changed by a command — Undo leaves it") when it is not."""

    def test_d5_a_sed_on_a_clean_tracked_file_is_on_the_card_and_undone(self):
        h = self.repo({"a.py": "a = 1\n", "b.py": "x = 1\n"})
        card = self.turn(h, "edit and sed", ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "1",
                                                                        "new_string": "2"}),
                         ToolCall("b1", "bash", {"command": "perl -pi -e 's/1/2/' b.py"}))
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

    def test_d8_an_untracked_file_a_command_changed_is_put_back_from_its_copy(self):
        # Since 25 Oct (uncommitted work): copied before the command, so Undo puts it back.
        h = self.repo({"a.py": "a\n"})
        (h.root / "notes.txt").write_text("my notes\n")          # untracked
        card = self.turn(h, "append notes", ToolCall("b1", "bash", {"command": "echo more >> notes.txt"}))
        self.assertEqual(card["files"], [{"path": "notes.txt", "additions": 1, "deletions": 0, "counted": True,
                                          "status": "modified", "by_command": True}])
        (count, restored), outcome = self.undo(h)
        self.assertEqual((count >= 0, restored, outcome["left"]), (True, 1, []))
        self.assertEqual((h.root / "notes.txt").read_text(), "my notes\n")

    def test_a_file_with_uncommitted_changes_a_command_changed_is_put_back_from_its_copy(self):
        h = self.repo({"c.py": "c = 1\n"})
        (h.root / "c.py").write_text("c = 1\n# the person's uncommitted line\n")
        card = self.turn(h, "sed c", ToolCall("b1", "bash", {"command": "perl -pi -e 's/1/2/' c.py"}))
        self.assertEqual(self.rows(card), {"c.py": ("modified", False)})
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual((h.root / "c.py").read_text(), "c = 1\n# the person's uncommitted line\n")

    def test_d6_a_command_after_dgcs_own_edit_is_dgcs_own_and_undo_restores_the_turn(self):
        for git in (True, False):
            with self.subTest(git=git):
                h = self.repo({"a.py": "x = 1\n"}, git=git)
                self.turn(h, "edit then sed", ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "x = 1",
                                                                           "new_string": "x = 1\ny = 1"}),
                          ToolCall("b1", "bash", {"command": "perl -pi -e 's/1/2/g' a.py"}))
                self.assertEqual((h.root / "a.py").read_text(), "x = 2\ny = 2\n")
                (count, _), outcome = self.undo(h)
                self.assertGreaterEqual(count, 0, outcome)
                self.assertEqual((h.root / "a.py").read_text(), "x = 1\n")

    def test_d6_a_formatter_hook_after_an_edit_does_not_lock_undo(self):
        hooks = {"PostToolUse": [{"command": "perl -pi -e 's/ugly/pretty/' a.py"}]}
        h = self.repo({"a.py": "x = 1\n"}, hooks=hooks)
        self.turn(h, "edit with hook", ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "x = 1",
                                                                    "new_string": "x = 'ugly'"}))
        self.assertEqual((h.root / "a.py").read_text(), "x = 'pretty'\n", "the hook formatted DGC's edit")
        (count, _), outcome = self.undo(h)
        self.assertGreaterEqual(count, 0, outcome)
        self.assertEqual((h.root / "a.py").read_text(), "x = 1\n")

    def test_d7_a_sed_before_the_edit_is_undone_too(self):
        h = self.repo({"a.py": "x = 1\n"})
        self.turn(h, "sed then edit", ToolCall("b1", "bash", {"command": "perl -pi -e 's/1/2/' a.py"}),
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
                return ChatResult(tool_calls=[ToolCall("b1", "bash", {"command": "perl -pi -e 's/2/3/' a.py"})])
            return ChatResult(content="Done.")
        self.assertTrue(h.run("racing", [("racing", person_then_sed)]))
        (count, _), outcome = self.undo(h)
        self.assertEqual(count, -1)
        self.assertEqual(outcome["conflicts"], [{"path": "a.py", "reason": "overlap"}])
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
        self.assertEqual((answer["ok"], answer["conflicts"]), (False, [{"path": "a.py", "reason": "overlap"}]))
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



# ---------------------------------------------------------------------------------------------------
# The person's saves (the coordinator, 25 Oct: "close the gap you flagged yourself"), the question that
# names what a command's change puts back, and the failure line read once.
# ---------------------------------------------------------------------------------------------------
from dgc import command_watch, rewind_words


class SaveDuringCommandTests(HarnessCase):
    """DGC runs a long command; meanwhile the person edits and saves a clean tracked file in the editor. The
    watch used to take that for the command's change, and Undo put Git's copy back with no question."""

    def repo(self, **config):
        h = self.make(git=True, mode="auto", **config)
        (h.root / "README.md").write_text("# Billing\n")
        (h.root / "rates.py").write_text("REDUCED_RATE = 0.05\n")
        (h.root / "a.py").write_text("x = 1\n")
        run_git(h.root, "add", "-A")
        run_git(h.root, "commit", "-qm", "files")
        return h

    def run_with_person(self, h, calls, person):
        """The scripted turn; `person` runs on its own thread while the turn's command sleeps."""
        worker = threading.Thread(target=person, daemon=True)

        def route(messages, results, cancel):
            if len(results) < len(calls):
                if calls[len(results)].name == "bash" and not worker.is_alive() and not worker.ident:
                    worker.start()
                return ChatResult(tool_calls=[calls[len(results)]])
            return ChatResult(content="Done.")
        self.assertTrue(h.run("long command", [("long command", route)]))
        worker.join(10)
        return h.agent.last_turn_files

    def test_a_file_the_person_saves_while_a_command_runs_is_theirs(self):
        h = self.repo()
        readme = (h.root / "README.md").resolve()

        def person():
            time.sleep(0.5)
            readme.write_text("# Billing\n\nMy own paragraph.\n")
            command_watch.note_saves([str(readme)], time.time())         # the editor's user_saved
        card = self.run_with_person(h, [ToolCall("b1", "bash", {
            "command": "sleep 1.5 && perl -pi -e 's/0.05/0.07/' rates.py"})], person)
        self.assertEqual({row["path"]: row.get("by_command", False) for row in card["files"]}, {"rates.py": True},
                         "README.md is the person's, not the command's: not on the card")
        self.assertGreaterEqual(h.agent.rewind(0)[0], 0, h.agent.last_rewind)
        self.assertEqual(readme.read_text(), "# Billing\n\nMy own paragraph.\n", "Undo leaves the person's edit")
        self.assertEqual((h.root / "rates.py").read_text(), "REDUCED_RATE = 0.05\n", "and puts the command's back")

    def test_a_save_that_reaches_dgc_after_the_command_was_looked_at_is_taken_back(self):
        h = self.repo()
        readme = (h.root / "README.md").resolve()
        saved_at = []

        def person():
            time.sleep(0.5)
            readme.write_text("# Billing\n\nSaved late.\n")
            saved_at.append(time.time())                               # the editor tells DGC only later
        self.run_with_person(h, [ToolCall("b1", "bash", {"command": "sleep 1.5"})], person)
        rows, _ = h.agent.checkpoints.changes(0, commands=True)
        self.assertIn(str(readme), [row["path"] for row in rows], "by time alone it looked like the command's")
        self.assertEqual(command_watch.note_saves([str(readme)], saved_at[0]), 1)
        rows, _ = h.agent.checkpoints.changes(0, commands=True)
        self.assertNotIn(str(readme), [row["path"] for row in rows], "taken back")
        self.assertGreaterEqual(h.agent.rewind(0)[0], 0, h.agent.last_rewind)
        self.assertEqual(readme.read_text(), "# Billing\n\nSaved late.\n")

    def test_a_file_dgc_wrote_that_the_person_saves_during_a_command_makes_undo_ask(self):
        h = self.repo()
        target = (h.root / "a.py").resolve()

        def person():
            time.sleep(0.5)
            target.write_text("x = 2\n# the person's line\n")
            command_watch.note_saves([str(target)], time.time())
        self.run_with_person(h, [ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "x = 1",
                                                              "new_string": "x = 2"}),
                                 ToolCall("b1", "bash", {"command": "sleep 1.5"})], person)
        self.assertEqual(h.agent.rewind(0)[0], -1, "not re-noted as DGC's own: the guard sees the person's save")
        self.assertEqual(h.agent.last_rewind["conflicts"], [{"path": "a.py", "reason": "overlap"}],
                         "their line touches DGC's: held back and named")
        self.assertIn("the person's line", target.read_text())

    def test_the_terminal_has_no_editor_to_say_so_and_stays_by_time(self):
        h = self.repo()
        readme = (h.root / "README.md").resolve()

        def person():
            time.sleep(0.5)
            readme.write_text("# Billing\n\nTyped elsewhere.\n")    # no user_saved: nothing tells DGC
        card = self.run_with_person(h, [ToolCall("b1", "bash", {"command": "sleep 1.5"})], person)
        self.assertEqual([row["path"] for row in card["files"]], ["README.md"], "documented: by time")

    def test_the_command_is_declared_offered_and_handled(self):
        self.assertIsNone(ep.command_error({"type": "user_saved", "paths": ["/x/a.py"], "at": 1.5}))
        self.assertIsNone(ep.command_error({"type": "user_saved", "paths": ["/x/a.py"]}))
        self.assertIsNotNone(ep.command_error({"type": "user_saved"}))
        project = Path(__file__).resolve().parents[1]
        self.assertIn('"user_saved": 1', (project / "dgc/headless.py").read_text())
        self.assertEqual((project / "sdk/python/dgc_sdk/wire/editor_protocol.py").read_text(),
                         (project / "dgc/editor_protocol.py").read_text())
        h = self.make(mode="auto")
        target = str((h.root / "saved-by-the-person.txt").resolve())
        h.backend._dispatch({"type": "user_saved", "paths": [target], "at": 1000.0})
        self.assertTrue(command_watch._saved_between(target, 999.0, 1001.0))
        self.assertEqual(h.of("command_rejected"), [], "nothing answers it, nothing refuses it")


class QuestionNamesCommandFilesTests(unittest.TestCase):
    def test_the_words(self):
        self.assertEqual(rewind_words.also_puts_back(["rates.py", "README.md"]),
                         "Also puts back 2 files changed while a command ran: rates.py, README.md.")
        self.assertEqual(rewind_words.also_puts_back(["rates.py"]),
                         "Also puts back 1 file changed while a command ran: rates.py.")
        self.assertEqual(rewind_words.also_puts_back([f"f{n}.py" for n in range(7)]),
                         "Also puts back 7 files changed while a command ran: f0.py, f1.py, f2.py, f3.py, f4.py "
                         "and 2 more.")
        self.assertEqual(rewind_words.also_puts_back([]), "")

    def test_a_file_restored_from_gits_copy_is_marked_and_survives_a_restart(self):
        c = Chat(self, {"rates.py": b"0.05\n", "a.py": b"a\n"})
        turn = c.turn()
        c.write("a.py", b"A\n")
        self.assertTrue(c.cp.record_known(str(c.p("rates.py")), "file", b"0.05\n", 0o644, by_command=True))
        c.p("rates.py").write_bytes(b"0.07\n")
        c.cp.note_written(str(c.p("rates.py")))
        rows = {Path(row["path"]).name: row.get("by_command", False) for row in c.cp.changes(turn)[0]}
        self.assertEqual(rows, {"a.py": False, "rates.py": True})
        c.restart()
        rows = {Path(row["path"]).name: row.get("by_command", False) for row in c.cp.changes(turn)[0]}
        self.assertEqual(rows, {"a.py": False, "rates.py": True})

    def test_the_terminal_question_names_them(self):
        from types import SimpleNamespace
        c = Chat(self, {"rates.py": b"0.05\n", "README.md": b"# r\n", "a.py": b"a\n"})
        c.turn("t0")
        c.write("a.py", b"A\n")
        for name in ("rates.py", "README.md"):
            self.assertTrue(c.cp.record_known(str(c.p(name)), "file", c.p(name).read_bytes(), 0o644, by_command=True))
            c.p(name).write_bytes(b"changed by a command\n")
            c.cp.note_written(str(c.p(name)))
        agent = SimpleNamespace(checkpoints=c.cp, _turn_files_path=lambda path: Path(path).name)
        fake = TerminalRewindTests.Fake(agent)
        from dgc import tui as tui_mod
        tui_mod.TUI._confirm_rewind.__get__(fake)(0)
        header = [t.plain for t in fake.overlays[-1][1]["header"]]
        self.assertIn("Also puts back 2 files changed while a command ran: rates.py, README.md.", header)
        self.assertIn("Reverts 3 file(s)", " ".join(header))


class FailureLineTests(HarnessCase):
    @unittest.skipIf(os.geteuid() == 0, "root writes into a read-only folder")
    def test_the_failure_reads_once_in_the_chat(self):
        h = self.make(mode="auto")
        (h.root / "ro").mkdir()
        (h.root / "ro" / "b.py").write_text("b\n")
        self.assertTrue(h.run("edit b", [("edit b", steps(ToolCall("e1", "edit_file", {
            "path": "ro/b.py", "old_string": "b", "new_string": "B"})))]))
        os.chmod(h.root / "ro", 0o555)
        self.addCleanup(os.chmod, h.root / "ro", 0o755)
        self.assertEqual(h.agent.rewind(0)[0], -1)
        lines = [f["message"] for f in h.of("info") if "Undo stopped" in f["message"]]
        self.assertEqual(lines, ["Undo stopped: couldn't write ro/b.py (Permission denied). Nothing was changed, "
                                 "and the recovery point was kept."])
        self.assertEqual(h.agent.last_rewind["error"], "couldn't write ro/b.py (Permission denied)")



# ---------------------------------------------------------------------------------------------------
# Uncommitted work (the founder, 25 Oct): a model's git checkout . / reset --hard / clean -fd / stash / rm
# over uncommitted changes is undoable. DGC copies every file with uncommitted changes before each of the
# chat's own commands, and Undo puts back the copy of each one the command changed. It never touches Git.
# ---------------------------------------------------------------------------------------------------
def git_out(root: Path, *args) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


class UncommittedWorkTests(CommandHelpers, HarnessCase):
    MINE_A = "a = 1\n# my uncommitted work\n"

    def dirty(self, **config):
        h = self.repo({"a.py": "a = 1\n", "b.py": "b = 1\n", "README.md": "# r\n"}, **config)
        (h.root / "a.py").write_text(self.MINE_A)
        (h.root / "notes.txt").write_text("my notes\n")
        (h.root / "docs").mkdir()
        (h.root / "docs" / "draft.md").write_text("# my draft\n")
        return h

    def test_git_checkout_dot_is_undone(self):
        h = self.dirty()
        card = self.turn(h, "checkout", ToolCall("b1", "bash", {"command": "git checkout -- ."}))
        self.assertEqual((h.root / "a.py").read_text(), "a = 1\n", "the command threw the work away")
        self.assertEqual(self.rows(card), {"a.py": ("modified", False)})
        self.assertTrue(card["files"][0]["by_command"], "Undo's question names it")
        self.assertNotIn("git_moved", card, "checkout of files moves neither HEAD nor the index")
        (count, restored), outcome = self.undo(h)
        self.assertEqual((count >= 0, restored, outcome["git"]), (True, 1, False))
        self.assertEqual((h.root / "a.py").read_text(), self.MINE_A)

    def test_git_reset_hard_is_undone_and_staging_is_left_and_said(self):
        h = self.dirty()
        (h.root / "b.py").write_text("b = 2\n")
        run_git(h.root, "add", "b.py")                                   # staged
        head = git_out(h.root, "rev-parse", "HEAD")
        card = self.turn(h, "reset", ToolCall("b1", "bash", {"command": "git reset --hard -q"}))
        self.assertTrue(card.get("git_moved"), "the index changed")
        (count, restored), outcome = self.undo(h)
        self.assertEqual((count >= 0, restored, outcome["git"]), (True, 2, True))
        self.assertEqual(((h.root / "a.py").read_text(), (h.root / "b.py").read_text()), (self.MINE_A, "b = 2\n"))
        self.assertEqual(git_out(h.root, "diff", "--cached", "--name-only"), "", "staging is not touched")
        self.assertEqual(git_out(h.root, "rev-parse", "HEAD"), head)
        self.assertEqual(rewind_words.done(restored, 0, outcome["git"]),
                         "↩ Undone; DGC restored 2 files. Git's commits, branches, stashes and staging are left as "
                         "they are.")

    def test_git_clean_fd_is_undone(self):
        h = self.dirty()
        self.turn(h, "clean", ToolCall("b1", "bash", {"command": "git clean -fdq"}))
        self.assertFalse((h.root / "docs").exists())
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual(((h.root / "notes.txt").read_text(), (h.root / "docs" / "draft.md").read_text()),
                         ("my notes\n", "# my draft\n"))

    def test_git_stash_is_undone_and_the_stash_is_left_and_said(self):
        h = self.dirty()
        card = self.turn(h, "stash", ToolCall("b1", "bash", {"command": "git stash -q"}))
        self.assertTrue(card.get("git_moved"))
        (count, _), outcome = self.undo(h)
        self.assertEqual((count >= 0, outcome["git"]), (True, True))
        self.assertEqual((h.root / "a.py").read_text(), self.MINE_A)
        self.assertEqual(len(git_out(h.root, "stash", "list").splitlines()), 1, "the stash is left alone")

    def test_rm_of_a_dirty_file_is_undone(self):
        h = self.dirty()
        self.turn(h, "rm", ToolCall("b1", "bash", {"command": "rm a.py notes.txt"}))
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual(((h.root / "a.py").read_text(), (h.root / "notes.txt").read_text()),
                         (self.MINE_A, "my notes\n"))

    def test_a_file_deleted_before_the_command_and_restored_by_it_is_deleted_again(self):
        h = self.dirty()
        (h.root / "b.py").unlink()                                      # the person's uncommitted delete
        self.turn(h, "checkout b", ToolCall("b1", "bash", {"command": "git checkout -- b.py"}))
        self.assertTrue((h.root / "b.py").exists())
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertFalse((h.root / "b.py").exists())

    def test_over_the_limits_the_card_says_which(self):
        cases = (("size", {"_COPY_MAX_FILE": 8}, None), ("count", {"_COPY_MAX_FILES": 1}, None),
                 ("budget", {}, 16))
        for limit, watch_limits, budget in cases:
            with self.subTest(limit=limit):
                saved = {name: getattr(command_watch, name) for name in watch_limits}
                for name, value in watch_limits.items():
                    setattr(command_watch, name, value)
                saved_budget = cpmod._MAX_SNAPSHOT_BYTES
                if budget is not None:
                    cpmod._MAX_SNAPSHOT_BYTES = budget
                try:
                    h = self.dirty()
                    (h.root / "b.py").write_text("b = 1\n# also mine, longer than the budget allows\n")
                    card = self.turn(h, f"limit {limit}", ToolCall("b1", "bash", {"command": "git checkout -- ."}))
                finally:
                    for name, value in saved.items():
                        setattr(command_watch, name, value)
                    cpmod._MAX_SNAPSHOT_BYTES = saved_budget
                limited = [row for row in card["files"] if row.get("command")]
                self.assertTrue(limited, card)
                self.assertTrue(all(row.get("limit") == limit for row in limited), card)

    def test_a_repeat_command_copies_nothing_new(self):
        h = self.dirty()
        self.turn(h, "twice", ToolCall("b1", "bash", {"command": "true"}), ToolCall("b2", "bash", {"command": "true"}))
        copied = h.agent.__dict__["_command_watch_copied"]
        self.assertGreater(copied[-2], 0, "the first command copied the uncommitted files")
        self.assertEqual(copied[-1], 0, "the second only re-read and hashed them")

    def test_a_head_moved_by_the_turn_is_said_in_the_question(self):
        from types import SimpleNamespace
        from dgc import tui as tui_mod
        h = self.dirty()
        card = self.turn(h, "commit", ToolCall("e1", "edit_file", {"path": "b.py", "old_string": "b = 1",
                                                                    "new_string": "b = 3"}),
                         ToolCall("b1", "bash", {"command": "git commit -qam wip"}))
        self.assertTrue(card.get("git_moved"))
        fake = TerminalRewindTests.Fake(SimpleNamespace(checkpoints=h.agent.checkpoints,
                                                        _turn_files_path=h.agent._turn_files_path))
        tui_mod.TUI._confirm_rewind.__get__(fake)(0)
        self.assertIn("Your files are put back; Git's commits, branches, stashes and staging are left as they are.",
                      [t.plain for t in fake.overlays[-1][1]["header"]])
        head = git_out(h.root, "rev-parse", "HEAD")
        (count, _), outcome = self.undo(h)
        self.assertEqual((count >= 0, outcome["git"]), (True, True))
        self.assertEqual(git_out(h.root, "rev-parse", "HEAD"), head, "the commit stays")
        self.assertEqual((h.root / "b.py").read_text(), "b = 1\n")

    def test_a_dirty_file_the_person_saves_during_a_command_is_theirs_and_the_commands_is_put_back(self):
        h = self.dirty()
        (h.root / "b.py").write_text("b = 1\n# b, uncommitted\n")
        a = (h.root / "a.py").resolve()

        def person():
            time.sleep(0.5)
            a.write_text(self.MINE_A + "# saved during the command\n")
            command_watch.note_saves([str(a)], time.time())
        worker = threading.Thread(target=person, daemon=True)

        def route(messages, results, cancel):
            if not results:
                worker.start()
                return ChatResult(tool_calls=[ToolCall("b1", "bash", {"command": "sleep 1.5 && git checkout -- b.py"})])
            return ChatResult(content="Done.")
        self.assertTrue(h.run("person saves", [("person saves", route)]))
        worker.join(10)
        self.assertEqual([row["path"] for row in h.agent.last_turn_files["files"]], ["b.py"])
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual((h.root / "b.py").read_text(), "b = 1\n# b, uncommitted\n", "the command's: put back")
        self.assertIn("saved during the command", a.read_text(), "the person's: left alone")

    def test_the_copies_survive_a_restart_and_are_checked(self):
        h = self.dirty()
        self.turn(h, "checkout", ToolCall("b1", "bash", {"command": "git checkout -- ."}))
        state = json.loads(json.dumps(h.agent.checkpoints.state()))
        revived = CheckpointManager.from_state(json.loads(json.dumps(state)), h.root.resolve())
        self.assertGreaterEqual(revived.rewind(0)[0], 0)
        self.assertEqual((h.root / "a.py").read_text(), self.MINE_A)
        entry = state["points"][0]["files"]["a.py"]
        import base64
        entry["data"] = base64.b64encode(b"tampered\n").decode("ascii")
        self.assertEqual(CheckpointManager.from_state(state, h.root.resolve()).points, [], "a changed copy is refused")



# ---------------------------------------------------------------------------------------------------
# Undo merges the person's edits, and the terminal hears their saves (the founder, 25 Oct: "yes want them
# now in 0.48.0 only"). Each fails on chatdgc at ef98964f and passes now.
# ---------------------------------------------------------------------------------------------------
import sys
from types import SimpleNamespace

from dgc import peers, save_inbox

PROJECT = Path(__file__).resolve().parents[1]


class MergeWordsTests(unittest.TestCase):
    def test_the_question_and_the_line(self):
        self.assertEqual(rewind_words.merged_line("a.py"), "a.py: your later edits are kept and DGC's are taken out")
        self.assertEqual(rewind_words.held_line("a.py"), "a.py: your edits overlap DGC's; it is left as it is")
        self.assertEqual(rewind_words.question_lines({"merged": ["a.py"], "held": [
            {"path": "b.py", "reason": "overlap"}, {"path": "c.bin", "reason": "binary"}]}),
            ["a.py: your later edits are kept and DGC's are taken out",
             "b.py: your edits overlap DGC's; it is left as it is"])
        self.assertEqual(rewind_words.done(3, merged=1), "↩ Undone; DGC restored 2 files and merged 1 with your edits.")
        self.assertEqual(rewind_words.done(1, merged=1), "↩ Undone; DGC merged 1 file with your edits.")
        self.assertEqual(rewind_words.done(2, kept_paths=["a.py"]), "↩ Undone; DGC restored 2 files. a.py was left as it is.")
        self.assertEqual(rewind_words.done(2, merged=1, kept_paths=["a.py", "b.py"], left_count=1),
                         "↩ Undone; DGC restored 1 file and merged 1 with your edits. a.py and b.py were left as they "
                         "are. 1 file changed by a command was left as it is.")
        self.assertEqual(rewind_words.REASONS["overlap"], "your edits overlap DGC's")


class MergeThroughTheChatTests(CommandHelpers, HarnessCase):
    """The D2 case through the real tools and the editor's commands: turn 1 edits tax(), the person adds a function,
    turn 2 edits total(); Undo turn 1."""

    def d2(self, person_line="\n\ndef mine():\n    return 'the person'\n"):
        h = self.repo({"a.py": MODULE.decode()})
        route = by_prompt(turn_1=[ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "0.18", "new_string": "0.2"})],
                          turn_2=[ToolCall("e2", "edit_file", {"path": "a.py", "old_string": "sum(items)",
                                                                "new_string": "round(sum(items))"})])
        self.assertTrue(h.run("turn 1", [("turn", route)]))
        with open(h.root / "a.py", "a") as handle:
            handle.write(person_line)
        self.assertTrue(h.run("turn 2", [("turn", route)]))
        return h

    def test_the_preview_says_it_merges_and_undo_keeps_the_persons_function(self):
        h = self.d2()
        h.backend._dispatch({"type": "rewind_preview", "index": 0, "request_id": "p1"})
        [preview] = [f for f in h.of("rewind_preview") if f["request_id"] == "p1"]
        self.assertEqual((preview["files"], preview["merged"]), (1, ["a.py"]))
        self.assertNotIn("held", preview)
        h.backend._dispatch({"type": "undo_to", "index": 0, "request_id": "u1"})
        [answer] = [f for f in h.of("undo_result") if f["request_id"] == "u1"]
        self.assertEqual((answer["ok"], answer["files_restored"], answer["merged"]), (True, 1, ["a.py"]))
        self.assertEqual((h.root / "a.py").read_text(), MODULE.decode() + "\n\ndef mine():\n    return 'the person'\n")
        for frame in h.of("rewind_preview", "undo_result"):
            self.assertIsNone(ep.event_error(frame), frame)

    def test_an_overlap_is_held_back_named_and_left_as_it_is(self):
        h = self.repo({"a.py": MODULE.decode(), "b.py": "b = 1\n"})
        self.turn(h, "edit both", ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "0.18", "new_string": "0.2"}),
                  ToolCall("e2", "edit_file", {"path": "b.py", "old_string": "1", "new_string": "2"}))
        (h.root / "a.py").write_text(MODULE.decode().replace("0.18", "0.25"))      # the line DGC changed
        h.backend._dispatch({"type": "rewind_preview", "index": 0, "request_id": "p1"})
        [preview] = [f for f in h.of("rewind_preview") if f["request_id"] == "p1"]
        self.assertEqual(preview["held"], [{"path": "a.py", "reason": "overlap"}])
        h.backend._dispatch({"type": "undo_to", "index": 0, "keep": ["a.py"], "request_id": "u1"})
        [answer] = [f for f in h.of("undo_result") if f["request_id"] == "u1"]
        self.assertEqual((answer["ok"], answer["files_restored"], answer["kept"]), (True, 1, ["a.py"]))
        self.assertEqual(((h.root / "a.py").read_text(), (h.root / "b.py").read_text()),
                         (MODULE.decode().replace("0.18", "0.25"), "b = 1\n"))

    def test_declared_and_offered(self):
        self.assertIsNone(ep.command_error({"type": "undo_to", "index": 0, "keep": ["a.py"], "request_id": "r"}))
        self.assertIsNone(ep.event_error({"type": "undo_result", "seq": 1, "request_id": "r", "index": 0, "ok": True,
                                          "files_restored": 1, "conflicts": [], "left": [], "stopped": 0,
                                          "merged": ["a.py"], "kept": ["b.py"]}))
        self.assertIsNone(ep.event_error({"type": "rewind_preview", "seq": 1, "request_id": "r", "index": 0, "files": 2,
                                          "merged": ["a.py"], "held": [{"path": "b.py", "reason": "overlap"}],
                                          "commands": ["c.py"]}))
        self.assertIn('"undo_merge": 1', (PROJECT / "dgc/headless.py").read_text())
        self.assertEqual((PROJECT / "sdk/python/dgc_sdk/wire/editor_protocol.py").read_text(),
                         (PROJECT / "dgc/editor_protocol.py").read_text())


class TerminalMergeQuestionTests(unittest.TestCase):
    """/rewind's question in the full-screen terminal: what it does with each file, and the choice about the files
    that changed while a command ran (Restore all, or Keep the ones I edited, with a picker)."""

    def chat(self):
        c = Chat(self, {"a.py": MODULE, "b.py": MODULE, "rates.py": b"0.05\n", "README.md": b"# r\n"})
        c.turn("t0")
        c.write("a.py", MODULE.replace(b"0.18", b"0.2"))
        c.write("b.py", MODULE.replace(b"0.18", b"0.2"))
        for name in ("rates.py", "README.md"):
            self.assertTrue(c.cp.record_known(str(c.p(name)), "file", c.p(name).read_bytes(), 0o644, by_command=True))
            c.p(name).write_bytes(b"changed while a command ran\n")
            c.cp.note_written(str(c.p(name)))
        c.p("a.py").write_bytes(c.p("a.py").read_bytes() + b"\n\n# mine\n")          # merges
        c.p("b.py").write_bytes(MODULE.replace(b"0.18", b"0.25"))                    # overlaps
        return c

    def fake(self, c, calls):
        def rewind(index, overwrite=None, keep=None):
            calls.append((index, overwrite, keep))
            agent.last_rewind = {"conflicts": [], "error": "", "left": [], "stopped": 0, "merged": ["a.py"],
                                 "kept": list(keep or [])}
            return (0, 3)
        agent = SimpleNamespace(checkpoints=c.cp, _turn_files_path=lambda path: Path(path).name, rewind=rewind)
        fake = TerminalRewindTests.Fake(agent)
        from dgc import tui as tui_mod
        for name in ("_do_rewind", "_ask_rewind_anyway", "_confirm_rewind", "_pick_kept"):
            setattr(fake, name, getattr(tui_mod.TUI, name).__get__(fake))
        return fake

    def test_the_question_says_what_it_does_with_each_file(self):
        c = self.chat()
        calls = []
        fake = self.fake(c, calls)
        fake._confirm_rewind(0)
        rows, kw = fake.overlays[-1]
        header = [t.plain for t in kw["header"]]
        self.assertIn("a.py: your later edits are kept and DGC's are taken out", header)
        self.assertIn("b.py: your edits overlap DGC's; it is left as it is", header)
        self.assertIn("Also puts back 2 files changed while a command ran: rates.py, README.md.", header)
        self.assertEqual([r["value"] for r in rows], ["yes", "pick", "anyway", "no"])
        self.assertIn("Restore all", rows[0]["label"])
        self.assertIn("Keep the ones I edited…", rows[1]["label"])
        kw["on_pick"]({"value": "yes"})
        self.assertEqual(calls, [(0, None, ["b.py"])], "Restore all leaves the held-back file as it is")
        self.assertEqual(fake.flashes[-1], "↩ Undone; DGC restored 2 files and merged 1 with your edits. b.py was left "
                                           "as it is.")
        fake._confirm_rewind(0)
        fake.overlays[-1][1]["on_pick"]({"value": "anyway"})
        self.assertEqual(calls[-1], (0, ["b.py"], None), "Undo anyway puts it back too")

    def test_the_picker_keeps_the_ones_the_person_ticks(self):
        c = self.chat()
        calls = []
        fake = self.fake(c, calls)
        fake._confirm_rewind(0)
        fake.overlays[-1][1]["on_pick"]({"value": "pick"})
        rows, kw = fake.overlays[-1]
        self.assertEqual([r["label"] for r in rows][:2], ["[ ] rates.py", "[ ] README.md"])
        self.assertEqual(kw["header"][0].plain, rewind_words.PICK_QUESTION)
        kw["on_pick"](rows[1])                                    # tick README.md
        rows, kw = fake.overlays[-1]
        self.assertEqual([r["label"] for r in rows][:2], ["[ ] rates.py", "[x] README.md"])
        self.assertIn("Undo, keeping 1 file", rows[2]["label"])
        kw["on_pick"](rows[2])
        self.assertEqual(calls, [(0, None, ["b.py", "README.md"])])

    def test_the_picker_runs_against_the_real_rewind(self):
        c = self.chat()
        agent = SimpleNamespace(checkpoints=c.cp, _turn_files_path=lambda path: Path(path).name)

        def rewind(index, overwrite=None, keep=None):
            names = {Path(path).name: path for path in c.cp.points[0]["files"]}
            count, restored = c.cp.rewind(index, overwrite=[names[n] for n in overwrite or ()] or None,
                                          keep=[names[n] for n in keep or ()] or None)
            agent.last_rewind = {"conflicts": [], "error": "", "left": [], "stopped": 0,
                                 "merged": [Path(p).name for p in c.cp.last_rewind_merged],
                                 "kept": [Path(p).name for p in c.cp.last_rewind_kept]}
            return count, restored
        agent.rewind = rewind
        fake = TerminalRewindTests.Fake(agent)
        from dgc import tui as tui_mod
        for name in ("_do_rewind", "_ask_rewind_anyway", "_confirm_rewind", "_pick_kept"):
            setattr(fake, name, getattr(tui_mod.TUI, name).__get__(fake))
        fake._confirm_rewind(0)
        fake.overlays[-1][1]["on_pick"]({"value": "pick"})
        rows, kw = fake.overlays[-1]
        kw["on_pick"](rows[0])                                    # tick rates.py: the person edited it in vim
        rows, kw = fake.overlays[-1]
        kw["on_pick"](rows[2])
        self.assertEqual(c.p("a.py").read_bytes(), MODULE + b"\n\n# mine\n", "merged")
        self.assertEqual(c.p("b.py").read_bytes(), MODULE.replace(b"0.18", b"0.25"), "held back")
        self.assertEqual(c.p("rates.py").read_bytes(), b"changed while a command ran\n", "kept: the person's")
        self.assertEqual(c.p("README.md").read_bytes(), b"# r\n", "put back: the command's")
        self.assertEqual(fake.flashes[-1], "↩ Undone; DGC restored 1 file and merged 1 with your edits. b.py and "
                                           "rates.py were left as they are.")


class ClassicPickerTests(CommandHelpers, HarnessCase):
    """`dgc --classic`'s /rewind: the same choice, with a numbered or arrow-key picker."""

    def cli(self, h):
        from dgc.cli import CLI
        lines = []

        class UI:
            def __getattr__(self, name):
                return lambda *args, **kwargs: lines.append((name, args[0] if args else ""))
        cli = object.__new__(CLI)
        cli.agent, cli.config, cli.ui = h.agent, h.config, UI()
        return cli, lines

    def test_keep_the_ones_i_edited(self):
        h = self.repo({"rates.py": "RATE = 0.05\n", "README.md": "# Billing\n"})
        self.turn(h, "change rates", ToolCall("b1", "bash", {
            "command": "perl -pi -e 's/0.05/0.07/' rates.py && printf 'more\\n' >> README.md"}))
        cli, lines = self.cli(h)
        # The point; Keep the ones I edited…; tick README.md; Undo, keeping 1 file.
        answers = iter(["change rates", "Keep the ones I edited…", "[ ] README.md", "Undo, keeping 1 file"])

        def select(title, labels, *args, **kwargs):
            wanted = next(answers)
            return next(i for i, label in enumerate(labels) if label.startswith(wanted))
        with patch("dgc.menu.select", side_effect=select):
            cli.handle_slash("/rewind")
        self.assertEqual((h.root / "rates.py").read_text(), "RATE = 0.05\n", "put back")
        self.assertEqual((h.root / "README.md").read_text(), "# Billing\nmore\n", "kept, as the person said")
        said = [text for kind, text in lines if kind == "info"]
        self.assertIn("Also puts back 2 files changed while a command ran: README.md, rates.py.", said)
        self.assertIn("↩ Undone; DGC restored 1 file. README.md was left as it is. The conversation was truncated.",
                      said)


class SaveInboxTests(unittest.TestCase):
    """The channel a window's DGC passes the person's saves on through: believed only from our own user, with the
    receiving process's token, as a plain file of ours."""

    def setUp(self):
        home = tempfile.TemporaryDirectory(prefix="dgc-saves-")
        self.addCleanup(home.cleanup)
        self.home = Path(home.name)
        env = patch.dict(os.environ, {"DGC_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        save_inbox.close_inbox()
        self.addCleanup(save_inbox.close_inbox)
        self.inbox = save_inbox.open_inbox()
        self.assertIsNotNone(self.inbox)
        self.token = (self.inbox / "token").read_text()

    def drop(self, name, message, mode=0o600):
        path = self.inbox / name
        path.write_text(json.dumps(message) if not isinstance(message, str) else message)
        os.chmod(path, mode)
        return path

    def test_it_is_private_and_has_its_own_token(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.inbox).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.inbox / "token").st_mode), 0o600)
        self.assertEqual(len(self.token), 32)
        self.assertEqual(self.inbox, self.home / ".dgc" / "peers" / "saves" / str(os.getpid()))

    def test_an_unauthenticated_message_is_refused(self):
        target = str(self.home / "work" / "a.py")
        at = 5000.0
        self.drop("1.json", {"token": "0" * 32, "paths": [target], "at": at})              # a wrong token
        self.drop("2.json", {"paths": [target], "at": at})                                 # none
        self.drop("3.json", {"token": self.token, "paths": [target], "at": at}, 0o622)     # others may write it
        outside = self.home / "elsewhere.json"
        outside.write_text(json.dumps({"token": self.token, "paths": [target], "at": at}))
        os.symlink(outside, self.inbox / "4.json")                                         # a link
        self.drop("5.json", {"token": self.token, "paths": ["relative.py"], "at": at})     # not absolute
        self.drop("6.json", "not json")
        self.assertEqual(save_inbox.drain(), (0, 6))
        self.assertFalse(command_watch._saved_between(target, at - 1, at + 1), "nothing refused is believed")
        self.assertEqual(sorted(os.listdir(self.inbox)), ["token"], "and nothing is left to read twice")

    def test_a_message_with_the_token_is_heard(self):
        target = str(self.home / "work" / "b.py")
        self.drop("1.json", {"token": self.token, "paths": [target], "at": 6000.0})
        self.assertEqual(save_inbox.drain(), (1, 0))
        self.assertTrue(command_watch._saved_between(target, 5999.0, 6001.0))

    def test_a_widened_inbox_is_believed_no_more(self):
        target = str(self.home / "work" / "c.py")
        self.drop("1.json", {"token": self.token, "paths": [target], "at": 7000.0})
        os.chmod(self.inbox, 0o777)
        # private_dir narrows it back before reading; a replaced one (a link) is refused outright.
        self.assertEqual(save_inbox.drain(), (1, 0))
        self.assertEqual(stat.S_IMODE(os.stat(self.inbox).st_mode), 0o700)
        moved = self.inbox.with_name("moved")
        os.rename(self.inbox, moved)
        os.symlink(moved, self.inbox)
        self.drop("2.json", {"token": self.token, "paths": [target], "at": 7100.0})
        self.assertEqual(save_inbox.drain(), (0, 0))
        os.unlink(self.inbox)
        os.rename(moved, self.inbox)

    def test_a_save_goes_only_to_the_dgcs_working_in_that_folder(self):
        sleeper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(sleeper.wait)
        self.addCleanup(sleeper.kill)
        other = save_inbox.inbox_dir(sleeper.pid)
        other.mkdir(mode=0o700)
        (other / "token").write_text("f" * 32)
        os.chmod(other / "token", 0o600)
        work = self.home / "work"
        notes = peers.peers_dir()
        for pid, root in ((sleeper.pid, str(work)),):
            (notes / f"{pid}.json").write_text(json.dumps({"pid": pid, "kind": "tui", "project_root": root,
                                                            "cwd": root, "heartbeat": time.time(),
                                                            "proc_start": peers._proc_start(pid)}))
        self.assertEqual(save_inbox.forward([str(self.home / "other-project" / "x.py")], 1.0), 0, "not its folder")
        self.assertEqual(save_inbox.forward(["relative.py"], 1.0), 0)
        self.assertEqual(save_inbox.forward([str(work / "a.py")], 2.0), 1)
        [message] = [json.loads(path.read_text()) for path in other.glob("*.json")]
        self.assertEqual((message["token"], message["paths"], message["at"]), ("f" * 32, [str(work / "a.py")], 2.0))
        self.assertEqual(sorted(os.listdir(self.inbox)), ["token"], "never to itself")


class TerminalHearsTheWindowsSavesTests(CommandHelpers, HarnessCase):
    """A terminal `dgc` runs a long command; meanwhile the person saves another tracked file in VS Code. The window's
    `dgc serve` (a real one, in its own process) hears the save and passes it on: the terminal never takes it for
    the command's change."""

    def setUp(self):
        home = tempfile.TemporaryDirectory(prefix="dgc-saves-home-")
        self.addCleanup(home.cleanup)
        self.home = Path(home.name)
        (self.home / ".dgc").mkdir()
        (self.home / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": "http://127.0.0.1:9/v1", "model": "mock-model", "api_key": "sk-fixture-0123456789abcdef",
            "api_mode": "chat_completions", "suggest": False, "notes": False, "artifact_autostart": False}))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        save_inbox.close_inbox()
        self.addCleanup(save_inbox.close_inbox)

    def window(self, folder: Path):
        """A window's backend: `dgc serve` in its own process, answering on stdin and stdout."""
        import queue
        env = dict(os.environ, HOME=str(self.home), DGC_HOME=str(self.home), PYTHONPATH=str(PROJECT),
                   PYTHONDONTWRITEBYTECODE="1", NO_COLOR="1")
        log = open(self.home / "serve.log", "w")
        self.addCleanup(log.close)
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=str(folder), env=env, text=True,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)

        def stop():
            try:
                proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
                proc.stdin.flush()
                proc.wait(timeout=30)
            except Exception:
                proc.kill()
                proc.wait()
            for stream in (proc.stdin, proc.stdout):
                try:
                    stream.close()
                except Exception:
                    pass
        self.addCleanup(stop)
        frames: "queue.Queue[dict]" = queue.Queue()

        def read():
            for line in proc.stdout:
                try:
                    frames.put(json.loads(line))
                except ValueError:
                    pass
        threading.Thread(target=read, daemon=True).start()

        def wait(predicate, timeout=60):
            end = time.time() + timeout
            while time.time() < end:
                try:
                    frame = frames.get(timeout=max(0.05, end - time.time()))
                except queue.Empty:
                    break
                if predicate(frame):
                    return frame
            raise AssertionError("the window's DGC did not answer")

        def send(command):
            self.assertIsNone(ep.command_error(command), command)
            proc.stdin.write(json.dumps(command) + "\n")
            proc.stdin.flush()
        wait(lambda f: f.get("type") == "ready")
        return send, wait

    def test_a_save_in_the_window_reaches_the_terminal_and_is_not_the_commands(self):
        h = self.repo({"README.md": "# Billing\n", "rates.py": "REDUCED_RATE = 0.05\n"})
        root = h.root.resolve()
        peers.announce(kind="tui", project_root=str(root), cwd=str(root), takeover=True)
        self.addCleanup(peers.withdraw)
        send, wait = self.window(root)
        readme = root / "README.md"
        heard = []

        def person():
            time.sleep(0.8)
            readme.write_text("# Billing\n\nSaved in VS Code.\n")
            send({"type": "user_saved", "paths": [str(readme)], "at": time.time()})       # what the extension sends
            send({"type": "list_checkpoints", "request_id": "sync"})
            heard.append(wait(lambda f: f.get("type") == "checkpoints" and f.get("request_id") == "sync"))
            # The window answers in order, so its answer means the save is in the terminal's inbox: only now may the
            # command end. A fixed 3 s left a slow runner's window still passing the save on when it ended.
            (root / ".git" / "dgc-person-saved").touch()
        worker = threading.Thread(target=person, daemon=True)

        def route(messages, results, cancel):
            if not results:
                worker.start()
                return ChatResult(tool_calls=[ToolCall("b1", "bash", {
                    "command": "for i in $(seq 300); do [ -e .git/dgc-person-saved ] && break; sleep 0.1; done; "
                               "perl -pi -e 's/0.05/0.07/' rates.py"})])
            return ChatResult(content="Done.")
        self.assertTrue(h.run("long command", [("long command", route)]))
        worker.join(30)
        self.assertTrue(heard, "the window's DGC answered after the save")
        card = h.agent.last_turn_files
        self.assertEqual({row["path"]: row.get("by_command", False) for row in card["files"]}, {"rates.py": True},
                         "README.md is the person's: not on the terminal's card")
        self.assertGreaterEqual(h.agent.rewind(0)[0], 0, h.agent.last_rewind)
        self.assertEqual(readme.read_text(), "# Billing\n\nSaved in VS Code.\n", "Undo leaves the person's save")
        self.assertEqual((root / "rates.py").read_text(), "REDUCED_RATE = 0.05\n")


if __name__ == "__main__":
    unittest.main()
