"""Chat attribution starts from actual run inputs, not the repository's last commit."""
from pathlib import Path
import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from dgc.chat_changes import ChatChanges
from dgc import chat_changes


class ChatChangesTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-chat-changes-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.journal = ChatChanges(self.root)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def test_dirty_git_new_chat_and_read_only_run_stay_empty(self):
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.write("a.py", "committed\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.write("a.py", "existing staged edit\n")
        self.git("add", "a.py")
        self.write("a.py", "existing working edit\n")
        for index in range(5):
            self.write(f"existing-{index}.py", "already here\n")
        self.assertEqual(self.journal.report()["total"], 0)
        before = self.journal.begin()
        self.journal.finish(before)
        self.assertEqual(self.journal.report()["total"], 0)
        before = self.journal.begin()
        self.write("a.py", "existing working edit\nDGC added line\n")
        self.journal.finish(before)
        report = self.journal.report()
        self.assertEqual(report["total"], 1)
        self.assertEqual((report["files"][0]["additions"], report["files"][0]["deletions"]), (1, 0))
        self.assertEqual(self.journal.read("a.py")["before"], "existing working edit\n")

    def test_frozen_review_and_external_edits_between_runs_are_excluded(self):
        self.write("a.py", "start\n")
        before = self.journal.begin()
        self.write("a.py", "first DGC edit\n")
        self.journal.finish(before)
        saved = self.journal.state()
        self.write("a.py", "manual edit\nmanual second line\n")
        self.assertEqual(self.journal.read("a.py")["after"], "first DGC edit\n")
        self.journal = ChatChanges.from_state(self.root, json.loads(json.dumps(saved)))
        before = self.journal.begin()
        self.write("a.py", "manual edit\nmanual second line\nsecond DGC edit\n")
        self.journal.finish(before)
        row = self.journal.report()["files"][0]
        self.assertEqual((row["additions"], row["deletions"]), (2, 1))
        self.assertEqual(len(self.journal.state()["files"]["a.py"]), 2)
        self.assertIn("Recorded edit 2", self.journal.read("a.py")["before"])
        self.assertEqual(ChatChanges(self.root).report()["total"], 0)

    def test_contiguous_edits_merge_and_reverts_clear_the_card(self):
        self.write("a.py", "before\n")
        for content in ("middle\n", "after\n", "before\n"):
            before = self.journal.begin()
            self.write("a.py", content)
            self.journal.finish(before)
        self.assertEqual(self.journal.report()["total"], 0)
        before = self.journal.begin()
        self.write("new.py", "new\n")
        self.journal.finish(before)
        self.assertTrue(self.journal.report()["files"][0]["untracked"])
        before = self.journal.begin()
        (self.root / "new.py").unlink()
        self.journal.finish(before)
        self.assertEqual(self.journal.report()["total"], 0)

    def test_delete_binary_and_oversize_are_not_fake_text_counts(self):
        self.write("remove.py", "one\ntwo\n")
        before = self.journal.begin()
        (self.root / "remove.py").unlink()
        (self.root / "binary").write_bytes(b"\0binary")
        self.journal.finish(before)
        rows = {row["path"]: row for row in self.journal.report()["files"]}
        self.assertEqual(rows["remove.py"]["deletions"], 2)
        self.assertTrue(rows["remove.py"]["deleted"])
        self.assertFalse(rows["binary"]["counted"])
        with self.assertRaises(ValueError):
            self.journal.read("binary")
        with patch.object(chat_changes, "MAX_FILE_BYTES", 1):
            before = self.journal.begin()
            self.write("large.py", "too large\n")
            self.journal.finish(before)
        self.assertFalse(self.journal.report()["complete"])
        self.assertNotIn("large.py", self.journal.state()["files"])

    def test_parent_symlinks_limits_and_untrusted_saved_paths_fail_closed(self):
        outside = tempfile.TemporaryDirectory(prefix="dgc-chat-outside-")
        self.addCleanup(outside.cleanup)
        Path(outside.name, "private").write_text("PRIVATE_OUTSIDE_SENTINEL")
        try:
            (self.root / "link").symlink_to(outside.name, target_is_directory=True)
        except OSError:
            self.skipTest("symlink creation unavailable")
        before = self.journal.begin()
        self.write("safe.py", "safe\n")
        self.journal.finish(before)
        self.assertNotIn("PRIVATE_OUTSIDE_SENTINEL", json.dumps(self.journal.state()))
        state = self.journal.state()
        state["files"]["../private"] = state["files"].pop("safe.py")
        restored = ChatChanges.from_state(self.root, state)
        self.assertEqual(restored.report()["total"], 0)
        self.assertFalse(restored.report()["complete"])
        with patch.object(chat_changes, "MAX_JOURNAL_BYTES", 1):
            before = self.journal.begin()
            self.write("another.py", "no room\n")
            self.journal.finish(before)
        self.assertNotIn("another.py", self.journal.state()["files"])

    def test_native_and_subscription_boundaries_record_failed_turn_edits(self):
        from dgc.agent import Agent
        agent = object.__new__(Agent)
        agent.depth, agent.chat_changes = 0, self.journal
        def runner(_prompt):
            self.write("partial.py", "created before cancellation\n")
            raise RuntimeError("cancelled")
        with self.assertRaises(RuntimeError):
            agent._record_chat_step(runner, "task")
        self.assertEqual(self.journal.report()["total"], 1)
        self.assertEqual(self.journal.read("partial.py")["before"], "")

    def test_live_review_is_a_projection_and_does_not_change_saved_evidence(self):
        self.write("live.py", "before\n")
        before = self.journal.begin()
        self.write("live.py", "during\n")
        preview = self.journal.view()
        self.assertEqual(preview.read("live.py")["after"], "during\n")
        self.assertEqual(self.journal.state()["files"], {})
        self.write("live.py", "final\n")
        self.journal.finish(before)
        self.write("live.py", "later manual edit\n")
        self.assertEqual(self.journal.view().read("live.py")["after"], "final\n")

    def test_editor_inspection_binds_saved_diffs_to_their_chat_and_workspace(self):
        import threading
        from dgc.editor_changes import EditorChanges
        from dgc.editor_protocol import event_error
        before = self.journal.begin()
        self.write("a.py", "new\n")
        self.journal.finish(before)
        replies, finished = [], threading.Event()
        def emit(event_type, **fields):
            replies.append({"type": event_type, "seq": len(replies), **fields})
            finished.set()
        reader = EditorChanges(self.root, emit)
        self.addCleanup(reader.close)
        reader.request({"type": "get_chat_changes", "request_id": "list"},
                       journal=self.journal, session_id="chat-one")
        self.assertTrue(finished.wait(5))
        self.assertIsNone(event_error(replies[-1]))
        self.assertEqual(replies[-1]["roots"][0]["total"], 1)
        reader.request({"type": "get_chat_change", "request_id": "stale", "root": str(self.root),
                        "path": "a.py", "session_id": "chat-two"},
                       journal=self.journal, session_id="chat-one")
        self.assertEqual(replies[-1]["type"], "command_rejected")
        self.assertNotIn("before", replies[-1])
        finished.clear()
        reader.request({"type": "get_chat_change", "request_id": "read", "root": str(self.root),
                        "path": "a.py", "session_id": "chat-one"},
                       journal=self.journal, session_id="chat-one")
        self.assertTrue(finished.wait(5))
        self.assertIsNone(event_error(replies[-1]))
        self.assertEqual(replies[-1]["after"], "new\n")


if __name__ == "__main__":
    unittest.main()
