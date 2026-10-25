"""The Edited card lists exactly the files the turn's recovery point will restore (the founder, 25 Oct: "this
should go into 0.48").

The 0.48 marketing take 5: a worker fixed billing.py in its own checkout with a shell command, DGC integrated it, and
DGC then wrote test_billing.py with its edit tools. The card said "Edited 1 file +64 -2 · test_billing.py", the
changes bar "2 files changed", and Undo restored both. The panel built the card from the diffs of DGC's own edit
tools, so a file a helper changed (however it changed it) was restored by Undo and listed nowhere.

Now the CLI counts it: each file in the turn's recovery point, its saved before-state against what is on disk now
(CheckpointManager.changes), sent as a new `turn_files` event before `turn_end` to a client that asked
(watch_turn_files, ready.capabilities.turn_files), and saved on the turn's last message so a reopened chat replays the
same card. Real checkpoints, a real isolated helper in a real git repository, real edit tools, a real Backend whose
frames go through the protocol validator.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc.checkpoints import CheckpointManager
from dgc.config import Config
from dgc import headless
from dgc.headless import Backend
from dgc.llm import ChatResult, LLMClient, ToolCall
from test_subagents import HarnessCase, Script, clone_fixture

BILLING = "def total(items):\n    rate = 0.1\n    return sum(items) * (1 + rate)\n"
TESTS = "".join(f"def test_{n}():\n    assert True\n" for n in range(2))


def git(root: Path, *args):
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)


class ChangesTests(unittest.TestCase):
    """CheckpointManager.changes: every file a rewind to the point would change, with true counts."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-turn-files-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.cp = CheckpointManager(self.root)
        self.cp.open(0, "change things", [])

    def touch(self, name, content: bytes | None):
        path = self.root / name
        self.assertTrue(self.cp.record_file(str(path)), self.cp.last_record_error)
        if content is None:
            path.unlink()
        else:
            path.write_bytes(content)
        return str(path)

    def rows(self, start=0):
        rows, total = self.cp.changes(start)
        return {Path(row["path"]).name: row for row in rows}, total

    def test_an_edit_is_counted_from_the_saved_before_state(self):
        (self.root / "a.py").write_text("one\ntwo\nthree\n")
        self.touch("a.py", b"one\nTWO\nthree\nfour\n")
        rows, total = self.rows()
        self.assertEqual(total, 1)
        self.assertEqual(rows["a.py"], {"path": str(self.root / "a.py"), "additions": 2, "deletions": 1,
                                        "counted": True, "status": "modified"})

    def test_new_binary_large_deleted_and_permission_changes_have_no_line_count(self):
        from dgc.workspace_changes import MAX_DIFF_BYTES
        (self.root / "logo.png").write_bytes(b"\x89PNG\0old")
        (self.root / "big.txt").write_text("x\n" * 10)
        (self.root / "gone.py").write_text("bye\n")
        (self.root / "run.sh").write_text("echo hi\n")
        self.touch("new.py", b"print('new')\n")
        self.touch("logo.png", b"\x89PNG\0new")
        self.touch("big.txt", b"y\n" * (MAX_DIFF_BYTES // 2 + 10))
        self.touch("gone.py", None)
        self.cp.record_file(str(self.root / "run.sh"))
        os.chmod(self.root / "run.sh", 0o755)
        rows, total = self.rows()
        self.assertEqual(total, 5)
        self.assertEqual({name: (row["status"], row["counted"]) for name, row in rows.items()},
                         {"new.py": ("new", False), "logo.png": ("modified", False), "big.txt": ("modified", False),
                          "gone.py": ("deleted", False), "run.sh": ("modified", False)})
        self.assertTrue(all(row["additions"] == row["deletions"] == 0 for row in rows.values()),
                        "no made-up numbers beside a file with no count")

    def test_a_file_put_back_exactly_is_not_a_change_and_undo_does_not_count_it(self):
        (self.root / "a.py").write_text("keep\n")
        (self.root / "b.py").write_text("before\n")
        self.touch("a.py", b"edited\n")
        (self.root / "a.py").write_text("keep\n")             # edited, then put back
        self.touch("b.py", b"after\n")
        rows, total = self.rows()
        self.assertEqual((sorted(rows), total), (["b.py"], 1))
        count, restored = self.cp.rewind(0)
        self.assertEqual((count, restored), (0, 1), "Undo restores the one file the card lists, and says one")
        self.assertEqual((self.root / "b.py").read_text(), "before\n")

    def test_the_rows_keep_the_order_the_files_were_first_changed_and_span_every_later_point(self):
        (self.root / "z.py").write_text("z\n")
        (self.root / "a.py").write_text("a\n")
        self.touch("z.py", b"z1\n")
        self.cp.open(1, "goal cycle 2", [])
        self.touch("a.py", b"a1\n")
        self.touch("z.py", b"z2\n")                          # the earliest before-state wins
        rows, total = self.cp.changes(0)
        self.assertEqual([Path(row["path"]).name for row in rows], ["z.py", "a.py"])
        self.assertEqual((rows[0]["additions"], rows[0]["deletions"]), (1, 1))
        later, _ = self.cp.changes(1)
        self.assertEqual([Path(row["path"]).name for row in later], ["a.py", "z.py"])

    def test_a_point_out_of_range_has_nothing(self):
        self.assertEqual(self.cp.changes(5), ([], 0))
        self.assertEqual(CheckpointManager(self.root).changes(0), ([], 0))


class TurnFilesAgentTests(HarnessCase):
    """The Agent counts the card at the end of a turn's work, from the recovery point the turn opened."""

    def repo(self):
        h = self.make(git=True, mode="auto")
        (h.root / "billing.py").write_text(BILLING)
        (h.root / "test_billing.py").write_text(TESTS)
        git(h.root, "add", ".")
        git(h.root, "commit", "-qm", "billing")
        return h

    def test_take_5_a_helpers_shell_edit_and_dgcs_own_edit_are_both_on_the_card_with_true_counts(self):
        h = self.repo()
        script = ("python3 -c \"import pathlib; p = pathlib.Path('billing.py'); "
                  "p.write_text(p.read_text().replace('rate = 0.1', 'rate = 0.18'))\"")
        new_tests = TESTS.replace("assert True", "assert total([1]) > 1") + "def test_rate():\n    assert total([100]) == 118\n"

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("p1", "task", {
                    "description": "fix billing", "prompt": "CHILD fix the rate in billing.py", "agent": "worker"})])
            if len(results) == 1:
                return ChatResult(tool_calls=[ToolCall("p2", "write_file", {
                    "path": "test_billing.py", "content": new_tests})])
            return ChatResult(content="Fixed the rate and covered it with a test.")

        def worker(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("w1", "bash", {"command": script})])
            return ChatResult(content="Changed the rate in billing.py.")

        self.assertTrue(h.run("parent: fix billing", [("CHILD fix the rate", worker),
                                                      ("parent: fix billing", parent)]))
        integrated = [m for m in h.agent.messages if m.get("role") == "tool"][0]["content"]
        self.assertIn("completed and integrated 1 path(s): billing.py", integrated)
        self.assertIn("rate = 0.18", (h.root / "billing.py").read_text(), "the helper's shell edit landed")
        card = h.agent.last_turn_files
        self.assertEqual(card["files"], [
            {"path": "billing.py", "additions": 1, "deletions": 1, "counted": True, "status": "modified"},
            {"path": "test_billing.py", "additions": 4, "deletions": 2, "counted": True, "status": "modified"}])
        self.assertEqual(card["total"], 2)
        # Undo finds this very point, and the question names as many files as the card.
        [(index, preview, recorded)] = h.agent.checkpoints.listing()
        self.assertEqual((card["checkpoint_index"], card["checkpoint_preview"]), (index, preview))
        self.assertEqual(recorded, len(card["files"]))
        self.assertEqual(h.agent.checkpoints.rewind(index)[1], len(card["files"]), "and restores that many")
        self.assertEqual((h.root / "billing.py").read_text(), BILLING)

    def test_dgcs_own_edits_are_counted_net_of_the_whole_turn(self):
        h = self.repo()

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("e1", "edit_file", {
                    "path": "billing.py", "old_string": "rate = 0.1", "new_string": "rate = 0.2"})])
            if len(results) == 1:
                return ChatResult(tool_calls=[ToolCall("e2", "edit_file", {
                    "path": "billing.py", "old_string": "rate = 0.2", "new_string": "rate = 0.3"})])
            if len(results) == 2:
                return ChatResult(tool_calls=[ToolCall("e3", "write_file", {
                    "path": "notes/NEW.md", "content": "# New\n"})])
            return ChatResult(content="Done.")
        self.assertTrue(h.run("parent: edit", [("parent: edit", parent)]))
        self.assertEqual(h.agent.last_turn_files["files"], [
            {"path": "billing.py", "additions": 1, "deletions": 1, "counted": True, "status": "modified"},
            {"path": "notes/NEW.md", "additions": 0, "deletions": 0, "counted": False, "status": "new"}],
            "one line changed twice is one line changed; a new file is New")

    def test_an_edit_put_back_is_left_off_and_a_turn_that_changed_nothing_has_an_empty_card(self):
        h = self.repo()

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("e1", "edit_file", {
                    "path": "billing.py", "old_string": "rate = 0.1", "new_string": "rate = 0.2"})])
            if len(results) == 1:
                return ChatResult(tool_calls=[ToolCall("e2", "edit_file", {
                    "path": "billing.py", "old_string": "rate = 0.2", "new_string": "rate = 0.1"})])
            return ChatResult(content="Left it as it was.")
        self.assertTrue(h.run("parent: try", [("parent: try", parent)]))
        card = h.agent.last_turn_files
        self.assertEqual((card["files"], card["total"]), ([], 0))
        self.assertEqual(card["checkpoint_index"], 0, "it still names its recovery point")
        self.assertEqual(h.agent.checkpoints.rewind(0)[1], 0, "Undo has nothing to restore, and says so")

    def test_the_card_is_saved_on_the_turns_last_message(self):
        h = self.repo()

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("e1", "edit_file", {
                    "path": "billing.py", "old_string": "rate = 0.1", "new_string": "rate = 0.2"})])
            return ChatResult(content="Done.")
        self.assertTrue(h.run("parent: save", [("parent: save", parent)]))
        last = h.agent.messages[-1]
        self.assertEqual(last["role"], "assistant")
        self.assertEqual(last["_dgc_turn_files"], h.agent.last_turn_files)
        self.assertEqual(headless._history_turn_files(last["_dgc_turn_files"]), h.agent.last_turn_files)

    def test_a_late_background_integration_redraws_the_card_of_the_turn_whose_point_holds_it(self):
        """A helper that finishes while the chat is idle integrates into the newest recovery point: the turn that
        last ended. Its Undo restores that file, so its card lists it, live and in the saved session."""
        h = self.repo()
        go = threading.Event()
        updates = []
        h.agent.on_turn_files = lambda record: updates.append(json.loads(json.dumps(
            h.agent._turn_files_view(record))))
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
            first = h.agent.last_turn_files
            self.assertEqual(first["files"], [], "nothing changed yet when the turn ended")
            go.set()
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and not updates:
                time.sleep(0.05)
        self.assertTrue(updates, "the helper integrated and the card was told")
        self.assertEqual(updates[-1]["files"], [
            {"path": "billing.py", "additions": 1, "deletions": 1, "counted": True, "status": "modified"}])
        self.assertEqual(updates[-1]["checkpoint_index"], first["checkpoint_index"])
        saved = h.agent.messages[-1].get("_dgc_turn_files")
        self.assertEqual(saved, updates[-1], "the saved card says the same")
        self.assertEqual(h.agent.checkpoints.listing()[-1][2], 1, "and Undo of that turn restores it")

    def test_a_turn_that_opened_no_point_of_its_own_shows_no_card_its_edits_are_on_the_last_ones(self):
        h = self.repo()

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("e1", "edit_file", {
                    "path": "billing.py", "old_string": "rate = 0.1", "new_string": "rate = 0.2"})])
            return ChatResult(content="Done.")
        self.assertTrue(h.run("parent: first", [("parent: first", parent)]))
        updates = []
        h.agent.on_turn_files = lambda record: updates.append(h.agent._turn_files_view(record))
        began = h.agent._turn_files_begin()             # a monitor turn: it opens no recovery point
        self.assertTrue(h.agent.checkpoints.record_file(str(h.root / "test_billing.py")))
        (h.root / "test_billing.py").write_text(TESTS + "def test_more():\n    pass\n")
        h.agent._settle_turn_files(began)
        self.assertEqual(h.agent.last_turn_files, {"files": [], "total": 0})
        self.assertEqual([row["path"] for row in updates[-1]["files"]], ["billing.py", "test_billing.py"])


class TurnFilesWireTests(unittest.TestCase):
    """The event, the command and the capability; the Backend sends it only to a client that asked."""

    VIEW = {"files": [{"path": "billing.py", "additions": 1, "deletions": 1, "counted": True, "status": "modified"}],
            "total": 1, "checkpoint_index": 0, "checkpoint_preview": "fix billing"}

    def test_the_event_and_command_are_in_the_protocol_and_both_sdks(self):
        self.assertIsNone(ep.command_error({"type": "watch_turn_files"}))
        self.assertIsNone(ep.event_error({"type": "turn_files", "seq": 1, "turn_id": "t1", **self.VIEW}))
        self.assertIsNone(ep.event_error({"type": "turn_files", "seq": 1, "turn_id": "t2", "files": [], "total": 0}))
        self.assertIsNotNone(ep.event_error({"type": "turn_files", "seq": 1, "turn_id": "t1", "files": []}))
        project = Path(__file__).resolve().parents[1]
        self.assertEqual((project / "sdk/python/dgc_sdk/wire/editor_protocol.py").read_text(),
                         (project / "dgc/editor_protocol.py").read_text())
        known = (project / "sdk/typescript/src/transport.ts").read_text()
        self.assertIn('"turn_files"', known.split("KNOWN_EVENTS", 1)[1].split("]);", 1)[0])
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "turn_files_sdk_protocol", project / "sdk/python/dgc_sdk/wire/editor_protocol.py")
        sdk = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sdk)
        history = {"type": "history", "seq": 3, "items": [{"type": "turn_files", "turn_id": "h1", **self.VIEW}]}
        self.assertIsNone(sdk.event_error(history), "an SDK reading history takes the new item")

    def backend(self, watch):
        frames = []
        backend = object.__new__(Backend)
        backend.em = types.SimpleNamespace(emit=lambda kind, **fields: frames.append({"type": kind, **fields}))
        backend._turn_lock = threading.RLock()
        record = {"files": self.VIEW["files"], "total": 1, "checkpoint_index": 0, "checkpoint_preview": "fix billing"}
        backend.agent = types.SimpleNamespace(last_turn_files=dict(self.VIEW), turn_files_record=record)
        if watch:
            backend._turn_files_on = True
        return backend, frames, record

    def test_a_client_that_never_asks_is_sent_none(self):
        backend, frames, _record = self.backend(watch=False)
        backend._emit_turn_files("t1")
        self.assertEqual(frames, [])

    def test_sent_before_turn_end_and_again_for_that_turn_when_its_point_grows(self):
        backend, frames, record = self.backend(watch=True)
        backend._emit_turn_files("t3")
        self.assertEqual(frames, [{"type": "turn_files", "turn_id": "t3", **self.VIEW}])
        for frame in frames:
            self.assertIsNone(ep.event_error({"seq": 1, **frame}))
        record["files"] = [*record["files"], {"path": "b.py", "additions": 2, "deletions": 0, "counted": True,
                                              "status": "modified"}]
        record["total"] = 2
        backend._on_turn_files(record)
        self.assertEqual((frames[-1]["turn_id"], frames[-1]["total"]), ("t3", 2), "the update names that turn")

    def test_a_turn_dgc_cannot_say_this_for_gets_none(self):
        backend, frames, _record = self.backend(watch=True)
        backend.agent.last_turn_files = None             # a subscription engine's turn
        backend._emit_turn_files("t1")
        self.assertEqual(frames, [])


class TurnFilesHistoryTests(unittest.TestCase):
    """After a reload the reopened chat replays the same card: the event, just before that turn's turn_end."""

    def history(self, messages):
        backend = object.__new__(Backend)
        backend.agent = types.SimpleNamespace(messages=messages)
        backend.config = types.SimpleNamespace(data={}, get=lambda key, default=None: default)
        backend.em = types.SimpleNamespace(emit=lambda kind, **value: None)
        return backend._history()

    def test_a_saved_card_replays_before_its_turns_end(self):
        saved = TurnFilesWireTests.VIEW
        items = self.history([
            {"role": "user", "content": "fix billing"},
            {"role": "assistant", "content": "Fixed.", "_dgc_turn_files": saved},
            {"role": "user", "content": "thanks"},
            {"role": "assistant", "content": "Any time."}])
        shape = [item.get("type") for item in items]
        self.assertEqual(shape, ["turn_start", "text_delta", "stream_end", "turn_files", "turn_end",
                                 "turn_start", "text_delta", "stream_end", "turn_end"])
        replayed = items[3]
        self.assertEqual(replayed, {"type": "turn_files", "turn_id": items[0]["turn_id"], **saved})
        self.assertIsNone(ep.event_error({"seq": 1, **replayed}))

    def test_a_damaged_card_is_left_out_rather_than_sent(self):
        good = self.history([{"role": "user", "content": "q"},
                             {"role": "assistant", "content": "a", "_dgc_turn_files": TurnFilesWireTests.VIEW}])
        self.assertIn("turn_files", [item.get("type") for item in good], "a sound one replays")
        for bad in ("x", {"files": "x"}, {"files": [{"path": "a.py"}]},
                    {"files": [{"path": "", "additions": 0, "deletions": 0, "counted": True, "status": "new"}]},
                    {"files": [{"path": "a", "additions": -1, "deletions": 0, "counted": True, "status": "new"}]},
                    {"files": [{"path": "a", "additions": 0, "deletions": 0, "counted": 1, "status": "new"}]},
                    {"files": [{"path": "a", "additions": 0, "deletions": 0, "counted": True, "status": "gone"}]}):
            items = self.history([{"role": "user", "content": "q"},
                                  {"role": "assistant", "content": "a", "_dgc_turn_files": bad}])
            self.assertNotIn("turn_files", [item.get("type") for item in items], bad)

    def test_a_card_whose_point_is_unknown_still_replays_its_files(self):
        items = self.history([{"role": "user", "content": "q"}, {"role": "assistant", "content": "a",
                              "_dgc_turn_files": {"files": [], "total": 0, "checkpoint_index": "x"}}])
        [card] = [item for item in items if item.get("type") == "turn_files"]
        self.assertEqual(card, {"type": "turn_files", "turn_id": items[0]["turn_id"], "files": [], "total": 0})


if __name__ == "__main__":
    unittest.main()
