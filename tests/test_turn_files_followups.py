"""The Edited card's four follow-ups for 0.48 (the founder, 25 Oct: fix the gaps, now).

1. A background helper that integrates while the chat is idle is in the chat's change set: the bar counts it and a
   row on the card opens its real diff, live and after a reload.
2. Undo on an older turn's card takes back every turn after it: `rewind_preview` says how many files that rewind
   restores across all of them -- the number the rewind reports once it has run.
3. A file outside the project keeps its before-state only in the process that changed it (never saved). A reopened
   card marks it as one Undo can no longer put back, and Undo's count leaves it out.
(4, the redraw of a card drawn from history, is the panel's: editors/vscode/test/edited-card-followups.test.mjs.)

Real checkpoints, a real background helper in a real git repository, a real saved session, a real Backend whose
frames go through the protocol validator.
"""
from __future__ import annotations

import json
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc import sessions
from dgc.chat_changes import ChatChanges
from dgc.checkpoints import CheckpointManager
from dgc.config import Config
from dgc.headless import Backend
from dgc.llm import ChatResult, LLMClient, ToolCall
from test_subagents import HarnessCase, Script, clone_fixture
from test_turn_files import BILLING, TESTS, git


class IdleIntegrationChangesTests(HarnessCase):
    """1. The changes bar counts a helper that integrated while the chat was idle."""

    def test_an_idle_integration_is_in_the_chats_changes_live_and_after_a_reload(self):
        h = self.make(git=True, mode="auto")
        (h.root / "billing.py").write_text(BILLING)
        (h.root / "test_billing.py").write_text(TESTS)
        git(h.root, "add", ".")
        git(h.root, "commit", "-qm", "billing")
        h.agent.session_file = sessions.new_path(h.root)
        go, updates = threading.Event(), []
        h.agent.on_turn_files = lambda record: updates.append(record)
        script = "sed -i 's/rate = 0.1/rate = 0.25/' billing.py"

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("p1", "task", {
                    "description": "fix billing", "prompt": "CHILD later fix billing.py", "agent": "worker",
                    "background": True})])
            return ChatResult(content="A worker is on it.")

        def worker(messages, results, cancel):
            if not results:
                go.wait(10)
                return ChatResult(tool_calls=[ToolCall("w1", "bash", {"command": script})])
            return ChatResult(content="Changed the rate.")

        with patch.object(LLMClient, "chat", Script([("CHILD later fix", worker), ("parent: start", parent)])), \
                patch.object(Config, "clone_for_root", clone_fixture):
            self.assertTrue(h.agent.run_turn("parent: start a worker"))
            self.assertEqual(h.agent.chat_changes.report()["files"], [], "nothing changed when the turn ended")
            go.set()
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and not updates:
                time.sleep(0.05)
        self.assertTrue(updates, "the helper integrated")
        [row] = h.agent.chat_changes.report()["files"]
        self.assertEqual((row["path"], row["additions"], row["deletions"]), ("billing.py", 1, 1),
                         "the bar counts it")
        diff = h.agent.chat_changes.read("billing.py")
        self.assertIn("rate = 0.1", diff["before"])
        self.assertIn("rate = 0.25", diff["after"], "and a row on the card opens its real diff")
        saved = sessions.load_record(h.agent.session_file, h.root)
        [reopened] = ChatChanges.from_state(h.root, saved["chat_changes"]).report()["files"]
        self.assertEqual((reopened["path"], reopened["additions"]), ("billing.py", 1), "a reopened chat has it")

    def test_record_writes_records_new_and_changed_files_and_leaves_a_recording_run_to_its_own_scan(self):
        h = self.make(git=True)
        journal = h.agent.chat_changes
        (h.root / "a.py").write_text("one\n")
        before = journal.states([h.root / "a.py", h.root / "new.py", h.root.parent / "elsewhere.py"])
        self.assertEqual(sorted(before), ["a.py", "new.py"], "a path outside the chat's root is never its change")
        (h.root / "a.py").write_text("two\n")
        (h.root / "new.py").write_text("x\n")
        self.assertTrue(journal.record_writes(before))
        report = {row["path"]: row for row in journal.report()["files"]}
        self.assertEqual((report["a.py"]["additions"], report["a.py"]["deletions"]), (1, 1))
        self.assertTrue(report["new.py"]["untracked"])
        self.assertFalse(journal.record_writes(journal.states([h.root / "a.py"])), "nothing changed since")
        running = journal.begin()
        before = journal.states([h.root / "a.py"])
        (h.root / "a.py").write_text("three\n")
        self.assertFalse(journal.record_writes(before), "a run that is recording sees it in its own scan")
        journal.finish(running)


class RewindPreviewTests(unittest.TestCase):
    """2. How many files Undo on an older turn's card restores across every turn it takes back."""

    def setUp(self):
        import tempfile
        directory = tempfile.TemporaryDirectory(prefix="dgc-rewind-preview-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        cp = CheckpointManager(self.root)
        for name in ("a.py", "b.py", "c.py"):
            (self.root / name).write_text(f"{name}\n")
        cp.open(0, "first turn", [])
        cp.record_file(str(self.root / "a.py"))
        (self.root / "a.py").write_text("a1\n")
        cp.open(2, "second turn", [])
        for name in ("a.py", "b.py", "c.py"):
            cp.record_file(str(self.root / name))
        (self.root / "a.py").write_text("a2\n")
        (self.root / "b.py").write_text("b2\n")              # c.py recorded, then left as it was
        self.cp = cp
        frames = []
        backend = object.__new__(Backend)
        backend.em = types.SimpleNamespace(emit=lambda kind, **fields: frames.append({"type": kind, **fields}))
        backend.agent = types.SimpleNamespace(checkpoints=cp)
        backend.config = types.SimpleNamespace(data={}, get=lambda key, default=None: default)
        self.backend, self.frames = backend, frames

    def ask(self, index):
        self.backend._dispatch({"type": "rewind_preview", "index": index, "request_id": f"rp-{index}"})
        frame = self.frames[-1]
        self.assertIsNone(ep.event_error({"seq": 1, **frame}), frame)
        return frame

    def test_it_counts_every_file_the_rewind_restores_across_the_later_turns_too(self):
        older = self.ask(0)
        self.assertEqual((older["type"], older["request_id"], older["index"], older["files"]),
                         ("rewind_preview", "rp-0", 0, 2), "a.py and b.py; c.py was put back")
        self.assertEqual(self.ask(1)["files"], 2)
        self.assertEqual(self.cp.rewind(0)[1], 2, "the number the rewind reports once it has run")

    def test_an_index_that_is_no_recovery_point_restores_nothing(self):
        self.assertEqual(self.ask(7)["files"], 0)
        self.assertEqual(self.ask(-1)["files"], 0)

    def test_the_command_and_event_are_declared_and_offered(self):
        self.assertIsNone(ep.command_error({"type": "rewind_preview", "index": 0, "request_id": "r"}))
        self.assertIsNotNone(ep.command_error({"type": "rewind_preview", "index": 0}), "a reply needs its request")
        project = Path(__file__).resolve().parents[1]
        self.assertEqual((project / "sdk/python/dgc_sdk/wire/editor_protocol.py").read_text(),
                         (project / "dgc/editor_protocol.py").read_text())
        known = (project / "sdk/typescript/src/transport.ts").read_text()
        self.assertIn('"rewind_preview"', known.split("KNOWN_EVENTS", 1)[1].split("]);", 1)[0])
        self.assertIn('"rewind_preview": 1', (project / "dgc/headless.py").read_text())


class OutsideFilesAfterRestartTests(unittest.TestCase):
    """3. A file outside the project: Undo can put it back only in the process that changed it."""

    def setUp(self):
        import tempfile
        directory = tempfile.TemporaryDirectory(prefix="dgc-outside-")
        self.addCleanup(directory.cleanup)
        base = Path(directory.name).resolve()
        self.root, self.outside = base / "project", base / "notes.txt"
        self.root.mkdir()
        (self.root / "a.py").write_text("one\n")
        self.outside.write_text("before\n")
        self.cp = CheckpointManager(self.root)
        self.cp.open(0, "edit both", [])
        for path in (self.root / "a.py", self.outside):
            self.assertTrue(self.cp.record_file(str(path)))
        (self.root / "a.py").write_text("two\n")
        self.outside.write_text("after\n")

    def history_card(self, manager):
        """The card saved when the turn ended, replayed by get_history in a process holding `manager`."""
        name = lambda path: manager._lexical_project_path(path) or str(path)      # noqa: E731
        files = [{**row, "path": name(row["path"])} for row in self.cp.changes(0)[0]]
        saved = {"files": files, "total": len(files), "checkpoint_index": 0, "checkpoint_preview": "edit both"}
        backend = object.__new__(Backend)
        backend.agent = types.SimpleNamespace(
            messages=[{"role": "user", "content": "edit both"},
                      {"role": "assistant", "content": "Done.", "_dgc_turn_files": saved}],
            checkpoints=manager, _turn_files_path=name)
        backend.config = types.SimpleNamespace(data={}, get=lambda key, default=None: default)
        backend.em = types.SimpleNamespace(emit=lambda kind, **value: None)
        [card] = [item for item in backend._history() if item.get("type") == "turn_files"]
        self.assertIsNone(ep.event_error({"seq": 1, **card}), card)
        return {Path(row["path"]).name: row for row in card["files"]}

    def test_the_counted_row_says_it_is_outside_the_project(self):
        rows = {Path(row["path"]).name: row for row in self.cp.changes(0)[0]}
        self.assertEqual(rows["notes.txt"].get("outside"), True)
        self.assertNotIn("outside", rows["a.py"])

    def test_in_the_process_that_changed_it_undo_still_puts_it_back(self):
        rows = self.history_card(self.cp)                  # a reloaded window, same backend
        self.assertNotIn("undoable", rows["notes.txt"])
        self.assertNotIn("undoable", rows["a.py"])

    def test_after_a_restart_the_card_marks_it_and_undo_restores_only_the_rest(self):
        restarted = CheckpointManager.from_state(self.cp.state(), self.root)    # what a later process loads
        self.assertEqual([Path(p).name for p in restarted.points[0]["files"]], ["a.py"],
                         "its before-state is never saved: that is the rule this keeps")
        rows = self.history_card(restarted)
        self.assertEqual(rows["notes.txt"].get("undoable"), False)
        self.assertNotIn("undoable", rows["a.py"])
        self.assertEqual(restarted.rewind(0)[1], 1, "Undo restores the one file the card still offers")
        self.assertEqual(self.outside.read_text(), "after\n")


if __name__ == "__main__":
    unittest.main()
