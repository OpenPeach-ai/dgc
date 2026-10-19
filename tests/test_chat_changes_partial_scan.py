"""A scan that stops early must not invent deletions, double-count them, or crowd out real edits.

Reported from a long Work session in a ~104 MiB repository: the bar above the prompt box said
"+1 −82173 · partial scan". DGC's own `ChatChanges.report()` on that session's journal showed 500
files (the cap), +93 −77,883, of which 497 were recorded as DELETED -- and every one of them was
still on disk, 377 still tracked and unchanged. 85 carried the same "deleted" step twice. Only 3
real edits had room left. The real change was +6,453 −2,215 over 86 files.

The mechanism, all in `chat_changes.py`:

1. `capture()` stops READING at 64 MiB or 5 seconds but still LISTS every name, and `finish()`
   compared every listed name, so a name one capture read and the other did not reach became
   `_MISSING` on that side: a deletion (or a creation) nobody made. The read cut-off moves from run
   to run -- a file grows, the 5-second deadline lands elsewhere -- so the phantoms came and went.
2. A later run that read the file again and missed it again could not continue the earlier step,
   so it added a second identical one, and the file's lines were counted twice.
3. The phantoms filled `MAX_CHANGED_FILES`, and every real edit after that was dropped.

These tests shrink the read budget (the module's own constant) instead of writing 64 MiB.
"""
from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import chat_changes                     # noqa: E402
from dgc.chat_changes import ChatChanges         # noqa: E402

BUDGET = 30_000          # the test's MAX_READ_BYTES: about 14 of the 40 bulk files fit
BULK = 40
LINE = "x" * 39 + "\n"   # 40 bytes; a bulk file is 50 lines, 2,000 bytes


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


def tree(*, repo: bool, track: bool = True) -> Path:
    """`a/edited.txt` (small, read first), then `b/f00..f39.txt` -- more than the budget holds --
    then `z/real.txt`, which sorts last and so lies beyond any cut-off."""
    root = Path(tempfile.mkdtemp(prefix="dgc-partial-scan-"))
    (root / "a").mkdir()
    (root / "a" / "edited.txt").write_text("one\ntwo\n")
    (root / "b").mkdir()
    for index in range(BULK):
        (root / "b" / f"f{index:02d}.txt").write_text(f"{index}\n" + LINE * 49)
    (root / "z").mkdir()
    (root / "z" / "real.txt").write_text("old\n")
    if repo:
        git(root, "init", "-q", ".")
        git(root, "config", "user.email", "t@t")
        git(root, "config", "user.name", "t")
        if track:
            git(root, "add", "-A")
        else:
            git(root, "add", "a")
        git(root, "commit", "-qm", "init")
    return root


def grow(root: Path) -> None:
    """A shell command that makes the first file 10 KB larger, which pulls the read cut-off of the
    NEXT capture about five files earlier."""
    (root / "a" / "edited.txt").write_text("one\ntwo\n" + LINE * 250)


def shrink(root: Path) -> None:
    (root / "a" / "edited.txt").write_text("one\ntwo\n")


def run(changes: ChatChanges, step) -> None:
    before = changes.begin()
    step()
    changes.finish(before)


def tool_edit(changes: ChatChanges, path: Path, text: str) -> None:
    changes.touched(path)               # what edit_file does just before it writes
    path.write_text(text)


class Budgeted(unittest.TestCase):
    def setUp(self) -> None:
        budget = patch.object(chat_changes, "MAX_READ_BYTES", BUDGET)
        budget.start()
        self.addCleanup(budget.stop)

    def rows(self, changes: ChatChanges) -> dict:
        return {row["path"]: row for row in changes.report()["files"]}


class ThePremiseTest(Budgeted):
    def test_the_bulk_really_is_bigger_than_the_read_budget(self) -> None:
        root = tree(repo=False)
        snapshot = chat_changes.capture(root)
        read = snapshot.get("read", snapshot["files"].keys())
        self.assertLess(len(read), BULK, "if every file fits, nothing below tests a partial scan")
        self.assertIn("b/f13.txt", read)
        self.assertNotIn("b/f20.txt", read)


class NoPhantomDeletionsTest(Budgeted):
    def test_a_git_repository_bigger_than_the_budget_records_exactly_the_one_edit(self) -> None:
        root = tree(repo=True)
        changes = ChatChanges(root)
        run(changes, lambda: grow(root))
        rows = self.rows(changes)
        self.assertEqual(list(rows), ["a/edited.txt"],
                         "files the after-scan stopped short of were recorded as deleted")
        self.assertEqual((rows["a/edited.txt"]["additions"], rows["a/edited.txt"]["deletions"]), (250, 0))
        self.assertTrue(changes.report()["complete"],
                        "every file the reads did not reach is one Git says is unmodified, so "
                        "nothing is unknown and the totals are whole")

    def test_a_folder_outside_git_bigger_than_the_budget_records_exactly_the_one_edit(self) -> None:
        root = tree(repo=False)
        changes = ChatChanges(root)
        run(changes, lambda: grow(root))
        rows = self.rows(changes)
        self.assertEqual(list(rows), ["a/edited.txt"])
        self.assertFalse([path for path, row in rows.items() if row["deleted"]])
        self.assertFalse(changes.report()["complete"],
                         "outside Git nothing vouches for the unread files: still partial")

    def test_untracked_files_bigger_than_the_budget_invent_nothing(self) -> None:
        root = tree(repo=True, track=False)
        changes = ChatChanges(root)
        run(changes, lambda: grow(root))
        self.assertEqual(list(self.rows(changes)), ["a/edited.txt"])
        self.assertFalse(changes.report()["complete"])

    def test_a_file_that_becomes_ignored_is_not_deleted(self) -> None:
        """The founder's session untracked and ignored 120 template files that were still on disk."""
        root = tree(repo=True)
        (root / "a" / "tmpl").mkdir()
        for index in range(5):
            (root / "a" / "tmpl" / f"t{index}.txt").write_text(f"template {index}\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "templates")
        changes = ChatChanges(root)

        def untrack() -> None:
            git(root, "rm", "-rq", "--cached", "a/tmpl")
            (root / ".gitignore").write_text("a/tmpl/\n")
            git(root, "add", ".gitignore")
            git(root, "commit", "-qm", "untrack")

        run(changes, untrack)
        rows = self.rows(changes)
        self.assertEqual(set(rows), {".gitignore"}, "still on disk, so never deleted")
        self.assertTrue(all((root / "a" / "tmpl" / f"t{index}.txt").exists() for index in range(5)))


class NoDoubleCountingTest(Budgeted):
    def test_a_file_missed_twice_is_not_deleted_twice(self) -> None:
        root = tree(repo=False)
        changes = ChatChanges(root)
        run(changes, lambda: grow(root))
        (root / "a" / "edited.txt").write_text("one\n")  # between runs, outside the chat
        run(changes, lambda: grow(root))
        rows = self.rows(changes)
        self.assertEqual(list(rows), ["a/edited.txt"], "files nobody touched were recorded")
        for name, segments in changes.state()["files"].items():
            steps = [json.dumps(pair, sort_keys=True) for pair in segments]
            self.assertEqual(len(steps), len(set(steps)), f"{name} carries the same step twice")
        # The external edit between runs is excluded by design: two steps, +250 and +251.
        self.assertEqual(rows["a/edited.txt"]["additions"], 501)


class TheCapHoldsRealEditsTest(Budgeted):
    def test_phantoms_never_take_the_room_a_real_edit_needs(self) -> None:
        root = tree(repo=False)
        changes = ChatChanges(root)
        with patch.object(chat_changes, "MAX_CHANGED_FILES", 3):
            before = changes.begin()
            grow(root)
            tool_edit(changes, root / "z" / "real.txt", "new\n")
            changes.finish(before)
        self.assertEqual(set(self.rows(changes)), {"a/edited.txt", "z/real.txt"},
                         "the cap was filled by files nobody touched")


class RealDeletionsTest(Budgeted):
    def test_a_deletion_past_the_cut_off_is_still_reported(self) -> None:
        root = tree(repo=True)
        changes = ChatChanges(root)
        run(changes, lambda: (root / "b" / "f30.txt").unlink())
        rows = self.rows(changes)
        self.assertEqual(list(rows), ["b/f30.txt"])
        self.assertTrue(rows["b/f30.txt"]["deleted"])
        self.assertEqual(rows["b/f30.txt"]["deletions"], 50, "its lines come from the blob Git holds")
        self.assertTrue(changes.report()["complete"])

    def test_a_deletion_within_reach_outside_git_is_still_reported(self) -> None:
        root = tree(repo=False)
        changes = ChatChanges(root)
        run(changes, lambda: (root / "b" / "f02.txt").unlink())
        rows = self.rows(changes)
        self.assertEqual(list(rows), ["b/f02.txt"])
        self.assertTrue(rows["b/f02.txt"]["deleted"])
        self.assertEqual(rows["b/f02.txt"]["deletions"], 50)

    def test_a_scan_that_says_missing_is_checked_on_disk(self) -> None:
        """`finish()` must look before it records a deletion: here the after-capture is wrong once."""
        root = tree(repo=False)
        changes = ChatChanges(root)
        real = chat_changes.capture_file_state
        lied = []

        def flaky(path, **kw):
            if Path(path).name == "f01.txt" and not lied and armed:
                lied.append(path)
                return "missing", b"", 0
            return real(path, **kw)

        armed = False
        with patch.object(chat_changes, "capture_file_state", flaky):
            before = changes.begin()
            armed = True
            changes.finish(before)
        self.assertTrue(lied, "premise: the capture reported the file missing")
        self.assertEqual(self.rows(changes), {}, "a file still on disk was recorded as deleted")


class ToolEditsAreAlwaysComparedTest(Budgeted):
    def test_a_tool_edit_past_the_cut_off_outside_git(self) -> None:
        root = tree(repo=False)
        changes = ChatChanges(root)
        before = changes.begin()
        tool_edit(changes, root / "b" / "f39.txt", "39\n" + LINE * 48 + "changed\n")
        changes.finish(before)
        rows = self.rows(changes)
        self.assertEqual(list(rows), ["b/f39.txt"])
        self.assertFalse(rows["b/f39.txt"]["untracked"], "an edit of an existing file read as new")
        self.assertEqual((rows["b/f39.txt"]["additions"], rows["b/f39.txt"]["deletions"]), (1, 1))

    def test_a_tool_edit_past_the_cut_off_in_git(self) -> None:
        root = tree(repo=True)
        changes = ChatChanges(root)
        before = changes.begin()
        tool_edit(changes, root / "b" / "f39.txt", "39\n" + LINE * 48 + "changed\n")
        changes.finish(before)
        rows = self.rows(changes)
        self.assertEqual(list(rows), ["b/f39.txt"])
        self.assertFalse(rows["b/f39.txt"]["untracked"])
        self.assertEqual((rows["b/f39.txt"]["additions"], rows["b/f39.txt"]["deletions"]), (1, 1))


class WhatGitHoldsIsReadAsACheckoutTest(Budgeted):
    def test_a_line_ending_rule_does_not_invent_a_change(self) -> None:
        """The start of an unread clean file comes from its blob. With an `eol=crlf` rule the blob
        holds LF and the disk CRLF, so the raw blob recorded an untracked-but-untouched file as
        changed."""
        root = tree(repo=True)
        (root / ".gitattributes").write_text("*.txt eol=crlf\n")
        git(root, "add", ".gitattributes")
        git(root, "rm", "-rq", "--cached", ".")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "crlf")
        for path in (root / "b").iterdir():
            path.unlink()
        git(root, "checkout", "--", ".")
        self.assertIn(b"\r\n", (root / "b" / "f33.txt").read_bytes(), "premise: CRLF on disk")
        changes = ChatChanges(root)
        run(changes, lambda: git(root, "rm", "-q", "--cached", "b/f33.txt"))
        self.assertTrue((root / "b" / "f33.txt").exists())
        self.assertEqual(self.rows(changes), {}, "the same bytes on disk were recorded as a change")

    def test_a_project_in_a_subfolder_of_its_repository(self) -> None:
        outer = Path(tempfile.mkdtemp(prefix="dgc-partial-scan-outer-"))
        git(outer, "init", "-q", ".")
        git(outer, "config", "user.email", "t@t")
        git(outer, "config", "user.name", "t")
        root = tree(repo=False)
        project = outer / "project"
        root.rename(project)
        git(outer, "add", "-A")
        git(outer, "commit", "-qm", "init")
        changes = ChatChanges(project)
        run(changes, lambda: (project / "b" / "f33.txt").write_text("33\n" + LINE * 48 + "sed\n"))
        rows = self.rows(changes)
        self.assertEqual(list(rows), ["b/f33.txt"])
        self.assertEqual((rows["b/f33.txt"]["additions"], rows["b/f33.txt"]["deletions"]), (1, 1))
        self.assertTrue(changes.report()["complete"])


class CommittedEditsTest(Budgeted):
    def test_a_shell_edit_committed_in_the_same_run_past_the_cut_off(self) -> None:
        """Neither capture reads b/f35.txt, and by the end it is clean again -- at a new commit."""
        root = tree(repo=True)
        changes = ChatChanges(root)

        def edit_and_commit() -> None:
            (root / "b" / "f35.txt").write_text("35\n" + LINE * 48 + "committed\n")
            git(root, "commit", "-qam", "edit")

        run(changes, edit_and_commit)
        rows = self.rows(changes)
        self.assertEqual(list(rows), ["b/f35.txt"])
        self.assertEqual((rows["b/f35.txt"]["additions"], rows["b/f35.txt"]["deletions"]), (1, 1))
        self.assertTrue(changes.report()["complete"])

    def test_a_shell_edit_of_a_clean_file_past_the_cut_off(self) -> None:
        root = tree(repo=True)
        changes = ChatChanges(root)
        run(changes, lambda: (root / "b" / "f33.txt").write_text("33\n" + LINE * 48 + "sed\n"))
        rows = self.rows(changes)
        self.assertEqual(list(rows), ["b/f33.txt"])
        self.assertFalse(rows["b/f33.txt"]["untracked"])
        self.assertEqual((rows["b/f33.txt"]["additions"], rows["b/f33.txt"]["deletions"]), (1, 1))


def snapshot(text: str | None) -> dict:
    if text is None:
        return {"kind": "missing", "hash": "", "mode": 0, "text": ""}
    import hashlib
    return {"kind": "file", "hash": hashlib.sha256(text.encode()).hexdigest(), "mode": 0o644, "text": text}


class OldJournalsAreRepairedTest(unittest.TestCase):
    """A journal saved before the fix holds the phantoms. Loading it must show sane numbers with
    nothing for the user to do."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="dgc-repair-"))
        for name, text in {"kept/real.txt": "B\n", "phantom/one.txt": "A\nA2\n",
                           "phantom/twice.txt": "A\nA2\nA3\n", "edited/then_phantom.txt": "B\n",
                           "phantom/then_edit.txt": "C\n"}.items():
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_text(text)
            (self.root / name).chmod(0o644)
        self.value = {"version": 1, "incomplete": True, "files": {
            "kept/real.txt": [{"before": snapshot("A\n"), "after": snapshot("B\n")}],
            "phantom/one.txt": [{"before": snapshot("A\nA2\n"), "after": snapshot(None)}],
            "phantom/twice.txt": [{"before": snapshot("A\nA2\nA3\n"), "after": snapshot(None)},
                                  {"before": snapshot("A\nA2\nA3\n"), "after": snapshot(None)}],
            "edited/then_phantom.txt": [{"before": snapshot("A\n"), "after": snapshot("B\n")},
                                        {"before": snapshot("B\n"), "after": snapshot(None)}],
            "phantom/then_edit.txt": [{"before": snapshot("B\n"), "after": snapshot(None)},
                                      {"before": snapshot("B\n"), "after": snapshot("C\n")}],
            "gone/really.txt": [{"before": snapshot("gone\n"), "after": snapshot(None)}],
        }}

    def test_the_premise_old_journal_reads_as_the_founder_saw_it(self) -> None:
        report = ChatChanges.from_state(self.root, copy.deepcopy(self.value)).report()
        self.assertEqual(sum(row["deleted"] for row in report["files"]), 4)

    def test_phantom_deletions_and_doubled_steps_are_dropped_on_load(self) -> None:
        changes = ChatChanges.from_state(self.root, copy.deepcopy(self.value))
        changes.repair()
        rows = {row["path"]: row for row in changes.report()["files"]}
        self.assertEqual(set(rows), {"kept/real.txt", "edited/then_phantom.txt",
                                     "phantom/then_edit.txt", "gone/really.txt"})
        self.assertTrue(rows["gone/really.txt"]["deleted"], "a file really gone stays deleted")
        self.assertFalse(rows["edited/then_phantom.txt"]["deleted"])
        self.assertEqual((rows["edited/then_phantom.txt"]["additions"],
                          rows["edited/then_phantom.txt"]["deletions"]), (1, 1))
        self.assertEqual(len(changes.files["phantom/then_edit.txt"]), 1,
                         "a phantom deletion before a real edit is dropped, leaving the edit")
        self.assertEqual(sum(row["deletions"] for row in rows.values()), 1 + 1 + 1 + 1)
        self.assertFalse(changes.report()["complete"],
                         "the old runs may still have missed changes, so the journal stays partial")

    def test_loading_a_session_repairs_its_journal(self) -> None:
        from dgc.agent import Agent
        from dgc.config import Config, DEFAULTS
        from dgc import sessions

        class QuietUI:
            def __getattr__(self, name):
                return lambda *args, **kw: None

        config = object.__new__(Config)
        config.project_root = self.root
        config.project_dir = self.root / ".dgc"
        config._persist = False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", api_key="fixture-placeholder",
                           model="fixture", mode="auto", hooks={}, mcp_servers={}, suggest=False,
                           artifact_autostart=False)
        config._stored_secrets, config._env_secret_keys = {}, set()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        agent = Agent(config, QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        state = Path(tempfile.mkdtemp(prefix="dgc-repair-state-"))
        with patch.object(sessions, "project_dir", return_value=state):
            agent.session_file = sessions.new_path(self.root)
            agent.messages.append({"role": "user", "content": "an old session"})
            agent.chat_changes = ChatChanges.from_state(self.root, copy.deepcopy(self.value))
            self.assertTrue(agent._persist(), "premise: the old journal was saved")
            saved = agent.session_file
            agent.reset()
            agent.load_session(saved)
        rows = {row["path"]: row for row in agent.chat_changes.report()["files"]}
        self.assertNotIn("phantom/one.txt", rows)
        self.assertNotIn("phantom/twice.txt", rows)
        self.assertEqual(sum(row["deleted"] for row in rows.values()), 1)

    def test_a_valid_journal_is_left_alone(self) -> None:
        value = {"version": 1, "incomplete": False, "files": {
            "kept/real.txt": [{"before": snapshot("A\n"), "after": snapshot("B\n")}],
            "gone/really.txt": [{"before": snapshot("gone\n"), "after": snapshot(None)}]}}
        changes = ChatChanges.from_state(self.root, copy.deepcopy(value))
        changes.repair()
        self.assertEqual(changes.state(), value)


if __name__ == "__main__":
    unittest.main()
