"""A helper's hand-back lands over the session's OWN uncommitted work (the goal soak, 16 Nov).

The soak's helpers did their jobs and 7 of 9 hand-backs were refused with "sub-agent changed files that were already
dirty before delegation". The dirty files were the session's own edits (its file tools had written them, nothing had
been committed yet) and a coverage.json a test run had generated. Only a continued helper's own earlier work counted
as not the person's (helper_memory.own_dirty); everything else uncommitted counted as the person's, so on a long goal
with no commits nearly every delegation was thrown away.

The rule now (dgc/worktree.py, TaskWorkspace.prepare and integrate):
  - a dirty file whose contents are exactly what this session itself last wrote there (its checkpoint record, by
    content digest, never by path alone) is the session's own: a helper's change to it lands like any file's when
    the parent hasn't changed it since delegation, and is merged when it has;
  - a file the person changed since (contents differ from what the session wrote) stays protected exactly as before;
  - a generated file (one Git's ignore rules match, or a typical tool output Git doesn't track) never refuses a
    hand-back on its own.

Real git, real CheckpointManager records, and a real Agent for the end-to-end case.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dgc.checkpoints import CheckpointManager                      # noqa: E402
from dgc.llm import ChatResult, ToolCall                            # noqa: E402
from dgc.worktree import TaskWorkspace                              # noqa: E402


def _project(files: dict) -> Path:
    repo = Path(tempfile.mkdtemp(prefix="dgc-own-work-")).resolve()
    run = lambda *a: subprocess.run(a, cwd=repo, check=True, capture_output=True)   # noqa: E731
    run("git", "init", "-q", ".")
    for name, data in files.items():
        target = repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(data)
    run("git", "add", "-A")
    run("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
    return repo


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _project({"app.py": "one\ntwo\nthree\nfour\n", "other.py": "original\n",
                              ".gitignore": "*.log\n"})
        self.store = Path(tempfile.mkdtemp(prefix="dgc-own-work-store-"))
        self.keeper = CheckpointManager(self.repo)

    def session_writes(self, name: str, text: str) -> None:
        """What one of the session's file tools does: write the file, then note what it left (Agent._handle_call)."""
        target = self.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        self.keeper.note_written(str(target))

    def delegate(self):
        workspace, error = TaskWorkspace.prepare(str(self.repo), "own-work", self.store,
                                                 left_hash=self.keeper.left_hash)
        self.assertIsNotNone(workspace, error)
        self.addCleanup(workspace.cleanup)
        return workspace

    def helper_writes(self, workspace, name: str, text: str) -> None:
        target = Path(workspace.path) / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def text(self, name: str) -> str:
        return (self.repo / name).read_text()


class TheSessionsOwnEditsAreItsOwnTest(Fixture):
    def test_a_helpers_change_to_a_file_the_session_wrote_lands(self) -> None:
        self.session_writes("app.py", "one\ntwo\nthree\nfour\nsession\n")
        workspace = self.delegate()
        self.helper_writes(workspace, "app.py", "one\nHELPER\nthree\nfour\nsession\n")
        self.helper_writes(workspace, "other.py", "helper too\n")
        result = workspace.integrate()
        self.assertEqual(result.status, "applied", result)
        self.assertEqual(sorted(result.paths), ["app.py", "other.py"])
        self.assertEqual(self.text("app.py"), "one\nHELPER\nthree\nfour\nsession\n")

    def test_a_new_file_the_session_made_is_its_own_too(self) -> None:
        self.session_writes("new.py", "made by the session\n")
        workspace = self.delegate()
        self.helper_writes(workspace, "new.py", "made by the session\nand finished by the helper\n")
        result = workspace.integrate()
        self.assertEqual(result.status, "applied", result)
        self.assertEqual(self.text("new.py"), "made by the session\nand finished by the helper\n")

    def test_a_file_the_person_changed_after_the_session_wrote_it_stays_protected(self) -> None:
        self.session_writes("app.py", "one\ntwo\nthree\nfour\nsession\n")
        (self.repo / "app.py").write_text("one\ntwo\nthree\nfour\nsession\nthe person's line\n")
        workspace = self.delegate()
        self.helper_writes(workspace, "app.py", "one\nHELPER\nthree\nfour\nsession\nthe person's line\n")
        result = workspace.integrate()
        self.assertEqual(result.status, "conflict", result)
        self.assertIn("dirty before delegation", result.error)
        self.assertEqual(self.text("app.py"), "one\ntwo\nthree\nfour\nsession\nthe person's line\n")

    def test_a_path_alone_is_never_trusted(self) -> None:
        """A record for the path that is not these contents (the session wrote something else there once) proves
        nothing about what is in the file now."""
        self.session_writes("app.py", "what the session wrote\n")
        (self.repo / "app.py").write_text("what the person wrote over it\n")
        workspace = self.delegate()
        self.helper_writes(workspace, "app.py", "the helper's\n")
        result = workspace.integrate()
        self.assertEqual(result.status, "conflict", result)
        self.assertEqual(self.text("app.py"), "what the person wrote over it\n")

    def test_without_a_record_every_dirty_file_stays_the_persons(self) -> None:
        (self.repo / "app.py").write_text("one\ntwo\nthree\nfour\nunrecorded\n")
        workspace, error = TaskWorkspace.prepare(str(self.repo), "no-record", self.store)
        self.assertIsNotNone(workspace, error)
        self.addCleanup(workspace.cleanup)
        self.helper_writes(workspace, "app.py", "one\nHELPER\nthree\nfour\nunrecorded\n")
        result = workspace.integrate()
        self.assertEqual(result.status, "conflict", result)
        self.assertIn("dirty before delegation", result.error)

    def test_a_session_file_the_parent_changed_again_meanwhile_is_merged_not_overwritten(self) -> None:
        self.session_writes("app.py", "one\ntwo\nthree\nfour\n# session\n")
        workspace = self.delegate()
        self.helper_writes(workspace, "app.py", "one\nHELPER\nthree\nfour\n# session\n")
        self.session_writes("app.py", "one\ntwo\nthree\nPARENT\n# session\n")      # the parent works on meanwhile
        result = workspace.integrate()
        self.assertEqual(result.status, "applied", result)
        self.assertEqual(result.merged, ["app.py"])
        self.assertEqual(self.text("app.py"), "one\nHELPER\nthree\nPARENT\n# session\n")


class AGeneratedFileNeverRefusesAHandBackTest(Fixture):
    def test_a_coverage_report_the_helper_regenerated_does_not_hold_back_its_work(self) -> None:
        # Not written by the session's tools (a command made it, or the person ran the suite), not ignored by Git.
        (self.repo / "coverage.json").write_text('{"percent": 81}\n')
        workspace = self.delegate()
        self.helper_writes(workspace, "coverage.json", '{"percent": 92}\n')
        self.helper_writes(workspace, "app.py", "one\ntwo\nthree\nfour\nhelper\n")
        result = workspace.integrate()
        self.assertEqual(result.status, "applied", result)
        self.assertEqual(self.text("app.py"), "one\ntwo\nthree\nfour\nhelper\n")

    def test_a_file_the_helpers_copy_ignores_is_generated(self) -> None:
        """Git's own rules first: the helper added the report to .gitignore."""
        (self.repo / "report.out").write_text("old run\n")
        workspace = self.delegate()
        self.helper_writes(workspace, ".gitignore", "*.log\nreport.out\n")
        self.helper_writes(workspace, "report.out", "new run\n")
        self.helper_writes(workspace, "app.py", "one\ntwo\nthree\nfour\nhelper\n")
        result = workspace.integrate()
        self.assertEqual(result.status, "applied", result)
        self.assertEqual(self.text("app.py"), "one\ntwo\nthree\nfour\nhelper\n")

    def test_a_tracked_file_is_never_generated_by_its_name_alone(self) -> None:
        repo = _project({"coverage.json": '{"committed": true}\n', "app.py": "x = 1\n"})
        (repo / "coverage.json").write_text('{"the person edited this": true}\n')
        workspace, error = TaskWorkspace.prepare(str(repo), "tracked", self.store, left_hash=self.keeper.left_hash)
        self.assertIsNotNone(workspace, error)
        self.addCleanup(workspace.cleanup)
        (Path(workspace.path) / "coverage.json").write_text('{"helper": true}\n')
        result = workspace.integrate()
        self.assertEqual(result.status, "conflict", result)
        self.assertEqual((repo / "coverage.json").read_text(), '{"the person edited this": true}\n')

    def test_a_tracked_file_an_ignore_rule_matches_is_still_the_persons(self) -> None:
        """A file somebody added despite an ignore rule (a local settings file) is tracked: their source."""
        repo = _project({"settings.local.json": '{"committed": true}\n', "app.py": "x = 1\n"})
        (repo / ".gitignore").write_text("*.local.json\n")
        subprocess.run(["git", "add", ".gitignore"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore"], cwd=repo,
                       check=True, capture_output=True)
        (repo / "settings.local.json").write_text('{"the person": true}\n')
        workspace, error = TaskWorkspace.prepare(str(repo), "ignored", self.store, left_hash=self.keeper.left_hash)
        self.assertIsNotNone(workspace, error)
        self.addCleanup(workspace.cleanup)
        (Path(workspace.path) / "settings.local.json").write_text('{"helper": true}\n')
        result = workspace.integrate()
        self.assertEqual(result.status, "conflict", result)
        self.assertEqual((repo / "settings.local.json").read_text(), '{"the person": true}\n')

    def test_a_persons_source_file_beside_a_generated_one_still_refuses(self) -> None:
        (self.repo / "coverage.json").write_text('{"percent": 81}\n')
        (self.repo / "other.py").write_text("the person's work\n")
        workspace = self.delegate()
        self.helper_writes(workspace, "coverage.json", '{"percent": 92}\n')
        self.helper_writes(workspace, "other.py", "the person's work\nhelper\n")
        result = workspace.integrate()
        self.assertEqual(result.status, "conflict", result)
        self.assertEqual(result.conflicts, ["other.py"])
        self.assertEqual(self.text("other.py"), "the person's work\n")
        self.assertEqual(self.text("coverage.json"), '{"percent": 81}\n', "a refused delta writes nothing")


class TheWholeLoopTest(unittest.TestCase):
    """A real Agent: its file tool writes a file, then it delegates, and the helper's change to that file lands."""

    def make(self):
        from test_subagents import Harness, git_repo
        directory = tempfile.TemporaryDirectory(prefix="dgc-own-work-loop-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name).resolve()
        git_repo(root)
        (root / "app.py").write_text("one\ntwo\nthree\n")
        subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
        subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "app"], cwd=root,
                       check=True, capture_output=True)
        harness = Harness(root, subagent_worktree_root=str(root.parent / (root.name + "-worktrees")))
        self.addCleanup(harness.close)
        return harness

    def parent(self, harness, between=None):
        results = []

        def route(messages, tool_results, cancel):
            done = [m for m in messages if m.get("role") == "tool"]
            if len(done) == 0:
                return ChatResult(tool_calls=[ToolCall("w1", "write_file", {"path": "app.py",
                                                                            "content": "one\ntwo\nthree\nsession\n"})])
            if len(done) == 1:
                if between:
                    between()
                return ChatResult(tool_calls=[ToolCall("t1", "task", {"description": "finish app",
                                                                      "prompt": "CHILD finish app.py"})])
            results.append(str(done[-1].get("content")))
            return ChatResult(content="done")
        return route, results

    @staticmethod
    def child(messages, tool_results, cancel):
        if not tool_results:
            return ChatResult(tool_calls=[ToolCall("e1", "edit_file", {"path": "app.py", "old_string": "two",
                                                                       "new_string": "HELPER"})])
        return ChatResult(content="Finished app.py.\nFILES: app.py")

    def test_the_helpers_change_to_the_sessions_own_file_lands(self) -> None:
        harness = self.make()
        route, results = self.parent(harness)
        self.assertTrue(harness.run("PARENT go", [("CHILD", self.child), ("PARENT", route)]))
        self.assertIn("completed and integrated 1 path(s): app.py", results[0])
        self.assertEqual((harness.root / "app.py").read_text(), "one\nHELPER\nthree\nsession\n")

    def test_a_save_the_person_made_after_the_session_wrote_keeps_the_file_theirs(self) -> None:
        harness = self.make()
        mine = "one\ntwo\nthree\nsession\nthe person saved this\n"
        route, results = self.parent(harness, between=lambda: (harness.root / "app.py").write_text(mine))
        self.assertTrue(harness.run("PARENT go", [("CHILD", self.child), ("PARENT", route)]))
        self.assertIn("NOT integrated", results[0])
        self.assertIn("already dirty before delegation", results[0])
        self.assertEqual((harness.root / "app.py").read_text(), mine)


if __name__ == "__main__":
    unittest.main()
