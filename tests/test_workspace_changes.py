"""Owner-facing change reports use actual Git objects without repository execution."""
from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from dgc import workspace_changes
from dgc.editor_changes import EditorChanges
from dgc.editor_protocol import event_error


class WorkspaceChangesTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dgc-workspace-changes-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE).stdout.decode().strip()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def test_first_commit_literal_scope_staged_and_untracked_counts(self):
        self.write("[app]/[one].ts", "one\n")
        self.git("add", ".")
        report = workspace_changes.collect_changes(self.root / "[app]")
        self.assertEqual(report["total"], 1)
        self.assertEqual(report["files"][0]["path"], "[one].ts")
        self.assertEqual(report["files"][0]["additions"], 1)
        initial = workspace_changes.read_change(self.root / "[app]", "[one].ts")
        self.assertEqual((initial["before"], initial["after"]), ("", "one\n"))
        self.commit()
        self.write("[app]/[one].ts", "two\nthree\n")
        self.write("outside.ts", "not in selected folder\n")
        report = workspace_changes.collect_changes(self.root / "[app]")
        self.assertEqual(report["total"], 1)
        self.assertEqual((report["files"][0]["additions"], report["files"][0]["deletions"]), (2, 1))
        self.assertEqual(workspace_changes.read_change(self.root / "[app]", "[one].ts")["before"], "one\n")
        with self.assertRaises(ValueError):
            workspace_changes.read_change(self.root / "[app]", "../outside.ts")

    def test_root_aliases_match_git_paths_without_following_child_links(self):
        alias_directory = tempfile.TemporaryDirectory(prefix="dgc-root-alias-")
        self.addCleanup(alias_directory.cleanup)
        alias = Path(alias_directory.name) / "workspace"
        alias.symlink_to(self.root, target_is_directory=True)
        self.write("one.py", "original\n")
        self.commit()
        self.write("one.py", "changed\n")
        original_git = workspace_changes.Review.git
        def aliased_git(review, args, *rest, **kwargs):
            if args == ["rev-parse", "--show-toplevel"]:
                return (str(alias) + "\n").encode()
            return original_git(review, args, *rest, **kwargs)
        with patch.object(workspace_changes.Review, "git", aliased_git):
            report = workspace_changes.collect_changes(alias)
            self.assertTrue(report["complete"], report["notices"])
            self.assertEqual([row["path"] for row in report["files"]], ["one.py"])
            preview = workspace_changes.read_change(alias, "one.py")
            self.assertEqual((preview["before"], preview["after"]), ("original\n", "changed\n"))
        manager = EditorChanges(self.root, lambda *args, **kwargs: None)
        self.addCleanup(manager.close)
        manager.set_roots([alias, self.root])
        self.assertEqual(manager.roots, (self.root.resolve(),))

    def test_symlink_preview_reads_link_text_and_parent_swaps_fail(self):
        self.write("src/one.py", "original\n")
        self.commit()
        outside_dir = tempfile.TemporaryDirectory(prefix="dgc-changes-outside-")
        self.addCleanup(outside_dir.cleanup)
        outside = Path(outside_dir.name)
        (outside / "one.py").write_text("EXTERNAL_PRIVATE_SENTINEL")
        link = self.root / "link.py"
        link.symlink_to(outside / "one.py")
        diff = workspace_changes.read_change(self.root, "link.py")
        self.assertEqual(diff["after"], str(outside / "one.py") + "\n")
        self.assertNotIn("EXTERNAL_PRIVATE_SENTINEL", diff["after"])
        (self.root / "src").rename(self.root / "old-src")
        (self.root / "src").symlink_to(outside, target_is_directory=True)
        with self.assertRaises((ValueError, OSError)):
            workspace_changes.read_change(self.root, "src/one.py")

    def test_filters_never_run_and_staged_only_change_stays_visible(self):
        self.write("one.py", "original\n")
        self.commit()
        self.write("one.py", "staged\n")
        self.git("add", "one.py")
        self.write("one.py", "original\n")
        script = self.write("filter.sh", "#!/bin/sh\nprintf executed > ran-filter\ncat\n")
        script.chmod(0o755)
        self.write(".gitattributes", "*.py filter=evil diff=evil\n")
        for key in ("filter.evil.clean", "diff.evil.textconv", "diff.external", "core.fsmonitor"):
            self.git("config", key, str(script))
        report = workspace_changes.collect_changes(self.root)
        row = next(row for row in report["files"] if row["path"] == "one.py")
        self.assertTrue(row["staged"])
        self.assertEqual((row["additions"], row["deletions"]), (0, 0))
        preview = workspace_changes.read_change(self.root, "one.py")
        self.assertEqual((preview["before"], preview["after"], preview["kind"]),
                         ("original\n", "staged\n", "staged"))
        self.assertFalse((self.root / "ran-filter").exists())

    def test_limits_cancellation_and_unknown_files_are_truthful(self):
        self.write("big.py", "x" * 20)
        self.commit()
        with patch.object(workspace_changes, "MAX_FILE_BYTES", 2):
            report = workspace_changes.collect_changes(self.root)
            self.assertFalse(report["complete"])
            self.assertEqual(report["total"], 0, "an unreadable file is not evidence of a change")
        for index in range(505):
            self.write(f"new-{index:03d}.txt", "new line\n")
        report = workspace_changes.collect_changes(self.root)
        self.assertEqual(report["total"], 505)
        self.assertEqual(len(report["files"]), 500)
        self.assertTrue(all(row["additions"] == 1 for row in report["files"]))
        cancel = threading.Event()
        cancel.set()
        report = workspace_changes.collect_changes(self.root, cancel)
        self.assertFalse(report["complete"])
        self.assertIn("cancelled", " ".join(report["notices"]))
        with patch.object(workspace_changes, "MAX_DIFF_BYTES", 2):
            with self.assertRaisesRegex(ValueError, "too large"):
                workspace_changes.read_change(self.root, "big.py")

    def test_sparse_checkout_and_deleted_parent_directory(self):
        self.write("included/one.py", "keep\n")
        self.write("omitted/two.py", "sparse\n")
        self.commit()
        self.git("sparse-checkout", "init", "--cone")
        self.git("sparse-checkout", "set", "included")
        report = workspace_changes.collect_changes(self.root)
        self.assertTrue(report["complete"])
        self.assertEqual(report["files"], [])
        (self.root / "included/one.py").unlink()
        (self.root / "included").rmdir()
        diff = workspace_changes.read_change(self.root, "included/one.py")
        self.assertEqual((diff["before"], diff["after"]), ("keep\n", ""))

    def test_inspection_workers_bound_concurrency_and_revoke_before_late_results(self):
        events, entered, finished = [], threading.Event(), threading.Event()
        def emit(event_type, **fields):
            events.append({"type": event_type, **fields})
        manager = EditorChanges(self.root, emit)
        self.addCleanup(manager.close)
        def hold(root, cancel, **kwargs):
            entered.set()
            cancel.wait(3)
            finished.set()
            return {"root": str(root), "files": [], "total": 0, "notices": []}
        with patch("dgc.editor_changes.collect_changes", side_effect=hold):
            manager.request({"type": "get_workspace_changes", "request_id": "first"})
            self.assertTrue(entered.wait(2))
            manager.request({"type": "get_workspace_changes", "request_id": "second"})
            self.assertEqual(events[-1]["reason"], "inspection_in_progress")
            manager.request({"type": "get_workspace_change", "root": str(self.root.parent), "path": "private",
                             "request_id": "outside"})
            self.assertEqual(events[-1]["reason"], "workspace_unavailable")
            manager.set_roots([])
            self.assertTrue(finished.wait(2))
            manager.close()
        first = [event for event in events if event["request_id"] == "first"]
        self.assertEqual(len(first), 1)
        self.assertEqual(first[0]["reason"], "inspection_cancelled")
        self.assertFalse(any(event["type"] == "workspace_changes" for event in events))

    def test_headless_inspection_during_a_model_turn_and_bounded_multi_root_output(self):
        from dgc.headless import Backend
        self.write("new.py", "new line\n")
        backend = object.__new__(Backend)
        backend.config = types.SimpleNamespace(project_root=self.root)
        backend._busy = lambda: True
        events, done = [], threading.Event()
        def emit(event_type, **fields):
            events.append({"type": event_type, **fields})
            done.set()
        backend.em = types.SimpleNamespace(emit=emit)
        backend.dispatch({"type": "get_workspace_changes", "request_id": "during-turn"})
        self.addCleanup(backend._editor_inspection.close)
        self.assertTrue(done.wait(3))
        self.assertEqual(events[-1]["type"], "workspace_changes")
        self.assertEqual(events[-1]["roots"][0]["total"], 1)
        self.assertIsNone(event_error({"seq": 1, **events[-1]}))
        events.clear()
        done.clear()
        second = tempfile.TemporaryDirectory(prefix="dgc-other-workspace-")
        self.addCleanup(second.cleanup)
        root2 = Path(second.name)
        backend._editor_inspection.set_roots([self.root, root2])
        report = {"files": [{"path": "😀" * 700, "additions": 1, "deletions": 0} for _ in range(600)],
                  "total": 600, "complete": True, "notices": []}
        with patch("dgc.editor_changes.collect_changes", side_effect=lambda root, *args, **kwargs:
                   {**report, "notices": [], "root": str(root)}):
            backend.dispatch({"type": "get_workspace_changes", "request_id": "bounded"})
            self.assertTrue(done.wait(3))
        self.assertIsNone(event_error({"seq": 1, **events[-1]}))
        self.assertLessEqual(sum(len(row["files"]) for row in events[-1]["roots"]), 500)
        self.assertTrue(any(not row["complete"] for row in events[-1]["roots"]))

    def test_overlapping_roots_inspect_once_and_preserve_read_authority(self):
        nested = self.root / "nested"
        nested.mkdir()
        self.write("nested/new.py", "new line\n")
        events, done = [], threading.Event()
        def emit(event_type, **fields):
            events.append({"type": event_type, **fields})
            done.set()
        manager = EditorChanges(self.root, emit)
        self.addCleanup(manager.close)
        manager.set_roots([nested, self.root, nested])
        manager.request({"type": "get_workspace_changes", "request_id": "overlap"})
        self.assertTrue(done.wait(3))
        self.assertEqual(len(events[-1]["roots"]), 1)
        self.assertEqual(events[-1]["roots"][0]["files"][0]["path"], "nested/new.py")
        done.clear()
        manager.request({"type": "get_workspace_change", "root": str(nested), "path": "new.py", "request_id": "read"})
        self.assertTrue(done.wait(3))
        self.assertEqual(events[-1]["after"], "new line\n")


if __name__ == "__main__":
    unittest.main()
