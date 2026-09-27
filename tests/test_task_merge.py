"""A sub-agent's delta survives the parent editing a different part of the same file.

`TaskWorkspace.integrate` compared whole files: if the parent's copy differed at all from the bytes
the sub-agent was given, the WHOLE delta was refused. So the parent fixing one line at the bottom
of a file while the child rewrote a function at the top read exactly like a collision, and the
child's work on every other file in the delta was discarded along with it. That is what these
tests are about: only a real overlap should refuse, and a refusal should still apply nothing.

The safety invariant is the other half, and it is load-bearing. A file the user already had
uncommitted work in when they delegated is NEVER merged into — `integrate` checks `initial_dirty`
and returns before any of this runs. An earlier attempt at this feature put the merge ABOVE that
check and turned "the sub-agent refuses to touch your uncommitted work" into "the sub-agent
overwrites it", which the suite caught. `test_a_file_dirty_before_delegation_is_never_merged` is
that guard, and `test_the_protected_check_runs_before_any_merge` pins the ORDER it depends on.

Every case here runs the real executor against real git in a real repository. Nothing is mocked:
the whole point is that the reconciliation is git's, not ours.
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

from dgc.worktree import (TaskWorkspace, list_retained, _merge_file, _merge_mode,   # noqa: E402
                          _FileState)


def _project(files: dict, config=()) -> Path:
    repo = Path(tempfile.mkdtemp(prefix="dgc-task-merge-"))
    run = lambda *a: subprocess.run(a, cwd=repo, check=True, capture_output=True)   # noqa: E731
    run("git", "init", "-q", ".")
    for key, value in config:
        run("git", "config", key, value)
    for name, data in files.items():
        target = repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data if isinstance(data, bytes) else data.encode())
    run("git", "add", "-A")
    run("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
    return repo


def _write(root: Path, name: str, data) -> None:
    target = root / name
    if data is None:
        target.unlink()
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data if isinstance(data, bytes) else data.encode())


class DelegationCase:
    """One delegation: a project, what the child did, what the parent did meanwhile."""

    def __init__(self, files: dict, child: dict, parent: dict, config=()):
        self.repo = _project(files, config)
        workspace, error = TaskWorkspace.prepare(str(self.repo), "merge-case",
                                                 Path(tempfile.mkdtemp()))
        if not workspace:
            raise AssertionError(f"could not prepare the isolated task: {error}")
        self.workspace = workspace
        for name, data in child.items():
            _write(Path(workspace.path), name, data)
        for name, data in parent.items():
            _write(self.repo, name, data)
        self.result = workspace.integrate()

    def text(self, name: str) -> str:
        return (self.repo / name).read_text(encoding="utf-8")

    def raw(self, name: str) -> bytes:
        return (self.repo / name).read_bytes()


class TheParentEditedSomewhereElseTest(unittest.TestCase):
    """The case the whole change exists for."""

    def setUp(self) -> None:
        self.case = DelegationCase(
            files={"shared.py": "one\ntwo\nthree\nfour\n", "other.py": "original\n"},
            child={"shared.py": "one\nCHILD\nthree\nfour\n", "other.py": "the child wrote this\n"},
            parent={"shared.py": "one\ntwo\nthree\nPARENT\n"})

    def test_the_delta_applies(self) -> None:
        self.assertEqual(self.case.result.status, "applied", self.case.result.error)
        self.assertEqual(self.case.result.conflicts, [])

    def test_both_edits_survive_in_the_shared_file(self) -> None:
        merged = self.case.text("shared.py")
        self.assertIn("CHILD", merged, "the sub-agent's edit must land")
        self.assertIn("PARENT", merged, "and the parent's must not be overwritten by it")
        self.assertEqual(merged, "one\nCHILD\nthree\nPARENT\n")

    def test_the_rest_of_the_delta_is_not_thrown_away_with_it(self) -> None:
        # This is what the old detector really cost: one touched file refused every OTHER file the
        # sub-agent had written.
        self.assertEqual(self.case.text("other.py"), "the child wrote this\n")


class AnOverlapIsStillARefusalTest(unittest.TestCase):
    def setUp(self) -> None:
        self.case = DelegationCase(
            files={"shared.py": "one\ntwo\nthree\n", "other.py": "original\n"},
            child={"shared.py": "one\nCHILD\nthree\n", "other.py": "the child wrote this\n"},
            parent={"shared.py": "one\nPARENT\nthree\n"})

    def test_the_same_line_conflicts(self) -> None:
        self.assertEqual(self.case.result.status, "conflict")
        self.assertEqual(self.case.result.conflicts, ["shared.py"])

    def test_the_parent_keeps_its_own_bytes(self) -> None:
        self.assertEqual(self.case.text("shared.py"), "one\nPARENT\nthree\n")
        self.assertNotIn("<<<<<<<", self.case.text("shared.py"),
                         "conflict markers are git's way of asking a human; they must never be "
                         "written into the user's file behind their back")

    def test_a_refusal_applies_nothing_at_all(self) -> None:
        self.assertEqual(self.case.text("other.py"), "original\n",
                         "integration is atomic: one conflict means no file moves")


class TheSafetyInvariantTest(unittest.TestCase):
    """What a sub-agent may never do, and the ordering that guarantees it."""

    def test_a_file_dirty_before_delegation_is_never_merged(self) -> None:
        repo = _project({"dirty.txt": "committed\n"})
        (repo / "dirty.txt").write_text("the user's unsaved work\n", encoding="utf-8")
        workspace, error = TaskWorkspace.prepare(str(repo), "dirty", Path(tempfile.mkdtemp()))
        self.assertTrue(workspace, error)
        # An edit git WOULD merge happily: a different line entirely. It must still be refused,
        # because the question is not "can these be reconciled" but "may a sub-agent touch work
        # the user has not saved". The answer is no.
        (Path(workspace.path) / "dirty.txt").write_text("the user's unsaved work\nchild adds\n",
                                                        encoding="utf-8")
        result = workspace.integrate()
        self.assertEqual(result.status, "conflict")
        self.assertEqual(result.conflicts, ["dirty.txt"])
        self.assertEqual((repo / "dirty.txt").read_text(encoding="utf-8"),
                         "the user's unsaved work\n",
                         "a sub-agent must never overwrite work the user had not committed")
        self.assertIn("dirty before delegation", result.error)

    def test_the_protected_check_runs_before_any_merge(self) -> None:
        """The order is the guarantee, so assert the order, not only today's outcome.

        The previous attempt merged first and checked `initial_dirty` afterwards — every assertion
        about merging still passed, and the invariant above was silently inverted.
        """
        import inspect
        source = inspect.getsource(TaskWorkspace.integrate)
        protected = source.index("initial_dirty")
        merge = source.index("_merge_file")
        self.assertLess(protected, merge,
                        "initial_dirty must be checked (and returned on) before _merge_file is "
                        "ever reached; a merge above it overwrites the user's uncommitted work")


class WhatCannotBeReconciledTest(unittest.TestCase):
    """Every shape with no line structure to merge is a refusal, never a guess."""

    def test_binary_changed_on_both_sides(self) -> None:
        blob = bytes(range(256))
        case = DelegationCase(files={"img.bin": blob},
                              child={"img.bin": blob + b"CHILD\x00"},
                              parent={"img.bin": blob + b"PARENT\x00"})
        self.assertEqual(case.result.status, "conflict")
        self.assertEqual(case.raw("img.bin"), blob + b"PARENT\x00",
                         "a binary file must come through untouched, never half-merged")

    def test_the_parent_deleted_what_the_child_edited(self) -> None:
        case = DelegationCase(files={"gone.py": "one\ntwo\nthree\n"},
                              child={"gone.py": "one\nCHILD\nthree\n"},
                              parent={"gone.py": None})
        self.assertEqual(case.result.status, "conflict")

    def test_both_sides_set_a_different_mode(self) -> None:
        base = _FileState("file", b"one\ntwo\n", 0o644)
        ours = _FileState("file", b"one\ntwo\n", 0o755)
        theirs = _FileState("file", b"one\ntwo\n", 0o644)
        self.assertEqual(_merge_mode(0o644, 0o755, 0o644), 0o755, "only the parent moved it")
        self.assertEqual(_merge_mode(0o644, 0o644, 0o755), 0o755, "only the child moved it")
        self.assertIsNone(_merge_mode(0o644, 0o755, 0o700), "both moved it, differently")
        self.assertIsNotNone(_merge_file(base, ours, theirs, PROJECT))

    def test_binary_git_itself_would_have_merged(self) -> None:
        """The explicit NUL test is not belt-and-braces; it closes a hole git leaves open.

        Git decides "binary" by sniffing the first 8000 bytes for a NUL. Measured on git 2.43: a
        file whose first NUL sits at byte 10000 merges with rc=0 and comes back line-merged. Relying
        on git's refusal alone would corrupt exactly those files and report `applied`.
        """
        body = b"line\n" * 2000                       # 10000 bytes, no NUL in git's sniff window
        base = _FileState("file", body + b"\x00BASE\n", 0o644)
        ours = _FileState("file", b"OURS\n" + body[5:] + b"\x00BASE\n", 0o644)
        theirs = _FileState("file", body + b"\x00THEIRS\n", 0o644)
        self.assertIsNone(_merge_file(base, ours, theirs, PROJECT),
                          "a NUL past byte 8000 still makes this binary, whatever git thinks")

    def test_a_mode_collision_refuses_at_the_merge_itself(self) -> None:
        # Asserting _merge_mode alone leaves the branch in _merge_file that CONSULTS it untested.
        lines = [f"line {n}\n".encode() for n in range(12)]
        base = _FileState("file", b"".join(lines), 0o644)
        ours = _FileState("file", b"".join([b"OURS\n"] + lines[1:]), 0o755)
        theirs = _FileState("file", b"".join(lines[:-1] + [b"THEIRS\n"]), 0o700)
        self.assertIsNone(_merge_file(base, ours, theirs, PROJECT))
        # Same content, compatible modes: the refusal above is about the mode, not the text.
        agreed = _FileState("file", theirs.data, 0o644)
        self.assertIsNotNone(_merge_file(base, _FileState("file", ours.data, 0o644), agreed, PROJECT))

    def test_a_symlink_is_never_merged_as_text(self) -> None:
        link = _FileState("symlink", b"/etc/passwd", 0o777)
        text = _FileState("file", b"one\ntwo\n", 0o644)
        self.assertIsNone(_merge_file(text, link, text, PROJECT))
        self.assertIsNone(_merge_file(text, text, link, PROJECT))
        self.assertIsNone(_merge_file(link, link, text, PROJECT))


class AwkwardButOrdinaryTest(unittest.TestCase):
    """Cases the previous implementation silently got wrong."""

    def test_a_file_the_child_created_lands_beside_a_merge(self) -> None:
        # The old implementation staged with `git add -A -- <path>`, which exits 128 for a path the
        # parent does not have. The merge was skipped and the whole delta refused — for the single
        # commonest thing a sub-agent does.
        case = DelegationCase(
            files={"a.py": "one\ntwo\nthree\nfour\n"},
            child={"a.py": "one\nCHILD\nthree\nfour\n", "brand/new.py": "created by the child\n"},
            parent={"a.py": "one\ntwo\nthree\nPARENT\n"})
        self.assertEqual(case.result.status, "applied", case.result.error)
        self.assertEqual(case.text("brand/new.py"), "created by the child\n")
        self.assertEqual(case.text("a.py"), "one\nCHILD\nthree\nPARENT\n")

    def test_a_non_ascii_filename_is_handled_as_itself(self) -> None:
        # Non-`-z` plumbing output renders this path as "caf\303\251.txt". The old code merged the
        # file, reported `applied`, wrote a NEW file under that literal quoted name and left the
        # real one untouched — the child's work lost, with a success status.
        case = DelegationCase(files={"café.txt": "one\ntwo\nthree\nfour\n"},
                              child={"café.txt": "one\nCHILD\nthree\nfour\n"},
                              parent={"café.txt": "one\ntwo\nthree\nPARENT\n"})
        self.assertEqual(case.result.status, "applied", case.result.error)
        self.assertEqual(case.text("café.txt"), "one\nCHILD\nthree\nPARENT\n")
        stray = [p.name for p in case.repo.iterdir() if "\\" in p.name or "303" in p.name]
        self.assertEqual(stray, [], f"a quoted-path copy was created beside the real file: {stray}")

    def test_a_file_with_no_trailing_newline_gains_none(self) -> None:
        case = DelegationCase(files={"n.txt": "one\ntwo\nthree\nfour\nfive\nsix\nseven"},
                              child={"n.txt": "CHILD\ntwo\nthree\nfour\nfive\nsix\nseven"},
                              parent={"n.txt": "one\ntwo\nthree\nfour\nfive\nsix\nPARENT"})
        self.assertEqual(case.result.status, "applied", case.result.error)
        self.assertEqual(case.raw("n.txt"), b"CHILD\ntwo\nthree\nfour\nfive\nsix\nPARENT",
                         "merging must not invent a trailing newline")

    def test_an_oversized_merge_refuses_instead_of_truncating(self) -> None:
        """`_run_git` turns a capture over the ceiling into rc=125, and 125 is a refusal.

        Without that, the merged text is silently cut at the limit and written over the user's
        file — the worst outcome this code can produce.
        """
        from dgc import worktree
        # Far enough apart for git to reconcile them: adjacent lines have no context between them
        # and conflict, which would make this control prove nothing.
        lines = [f"line {n}\n".encode() for n in range(12)]
        base = _FileState("file", b"".join(lines), 0o644)
        ours = _FileState("file", b"".join([b"OURS\n"] + lines[1:]), 0o644)
        theirs = _FileState("file", b"".join(lines[:-1] + [b"THEIRS\n"]), 0o644)
        self.assertIsNotNone(_merge_file(base, ours, theirs, PROJECT),
                             "the control must merge, or the refusal below proves nothing")
        real = worktree._git_bytes
        try:
            worktree._git_bytes = lambda *a, **k: subprocess.CompletedProcess(
                list(a[0]), 125, b"ONE\n", b"git stdout exceeded")
            self.assertIsNone(_merge_file(base, ours, theirs, PROJECT),
                              "a truncated capture must refuse, never apply its prefix")
        finally:
            worktree._git_bytes = real


class TheChildCheckoutMustHoldStillTest(unittest.TestCase):
    """A merged file is written from `desired`, but the drift check compares against `child`.

    Those are different objects once a merge happens, and the check exists to catch a sub-agent
    process still writing while its delta is being applied. Pointing it at `desired` would make it
    pass vacuously for every merged file — the exact shape of bug that ships quietly.
    """

    def test_the_delta_is_abandoned_if_the_child_writes_during_integration(self) -> None:
        case_files = {"a.py": "one\ntwo\nthree\nfour\n"}
        repo = _project(case_files)
        workspace, error = TaskWorkspace.prepare(str(repo), "drift", Path(tempfile.mkdtemp()))
        self.assertTrue(workspace, error)
        _write(Path(workspace.path), "a.py", "one\nCHILD\nthree\nfour\n")
        _write(repo, "a.py", "one\ntwo\nthree\nPARENT\n")          # forces the merge path

        class MovingCheckpoints:
            """Writes to the child's checkout at the one moment integration is mid-flight."""

            def __init__(self, child_root: Path):
                self.child_root = child_root

            def record_file(self, _target: str) -> bool:
                _write(self.child_root, "a.py", "one\nCHILD MOVED AGAIN\nthree\nfour\n")
                return True

        result = workspace.integrate(checkpoints=MovingCheckpoints(Path(workspace.path)))
        self.assertEqual(result.status, "error")
        self.assertIn("isolated checkout changed", result.error)
        self.assertEqual((repo / "a.py").read_text(encoding="utf-8"),
                         "one\ntwo\nthree\nPARENT\n",
                         "nothing may be written once the child is known to have moved")


class TheRetryPathMergesTooTest(unittest.TestCase):
    """Resolving a retained task is where reconciliation matters most.

    A task is retained *because* something collided. By the time anyone comes back to resolve it
    the parent has usually moved on further still, so re-running a whole-file comparison refuses a
    second time — and retained work became effectively unrecoverable. `RetainedTask.integrate` got
    the same treatment as the live path, and this drives the real one through `list_retained`.
    """

    def test_a_retained_delta_lands_once_the_parent_edit_no_longer_overlaps(self) -> None:
        store = Path(tempfile.mkdtemp())
        repo = _project({"f.py": "one\ntwo\nthree\nfour\nfive\nsix\n"})
        workspace, error = TaskWorkspace.prepare(str(repo), "retry", store)
        self.assertTrue(workspace, error)
        _write(Path(workspace.path), "f.py", "one\nCHILD\nthree\nfour\nfive\nsix\n")
        _write(Path(workspace.path), "new.py", "the child also wrote this\n")

        # The parent lands on the SAME line: a real collision, so the task is retained.
        _write(repo, "f.py", "one\nPARENT\nthree\nfour\nfive\nsix\n")
        first = workspace.integrate()
        self.assertEqual(first.status, "conflict")
        self.assertFalse((repo / "new.py").exists(), "a refusal applies nothing")

        # The user reworks their own edit so it no longer touches the child's line.
        _write(repo, "f.py", "one\ntwo\nthree\nfour\nfive\nPARENT MOVED\n")

        retained, problems = list_retained(repo, store)
        self.assertEqual(problems, [])
        self.assertEqual(len(retained), 1, f"expected one retained task, got {retained}")
        second = retained[0].integrate()

        self.assertEqual(second.status, "applied", second.error)
        merged = (repo / "f.py").read_text(encoding="utf-8")
        self.assertIn("CHILD", merged, "the retained work must land on the retry")
        self.assertIn("PARENT MOVED", merged, "without discarding what the user did meanwhile")
        self.assertEqual((repo / "new.py").read_text(encoding="utf-8"),
                         "the child also wrote this\n")

    def test_a_retained_delta_still_refuses_while_the_overlap_remains(self) -> None:
        store = Path(tempfile.mkdtemp())
        repo = _project({"f.py": "one\ntwo\nthree\n"})
        workspace, error = TaskWorkspace.prepare(str(repo), "retry-no", store)
        self.assertTrue(workspace, error)
        _write(Path(workspace.path), "f.py", "one\nCHILD\nthree\n")
        _write(repo, "f.py", "one\nPARENT\nthree\n")
        self.assertEqual(workspace.integrate().status, "conflict")

        retained, _ = list_retained(repo, store)
        self.assertEqual(len(retained), 1)
        again = retained[0].integrate()
        self.assertEqual(again.status, "conflict",
                         "the overlap is still there, so the retry must refuse as well")
        self.assertEqual((repo / "f.py").read_text(encoding="utf-8"), "one\nPARENT\nthree\n")


class KnownLimitationTest(unittest.TestCase):
    """Recorded, not endorsed.

    Under `core.autocrlf` the committed blob holds LF while the checkout holds CRLF, so
    `_head_state` never equals `_read_state` and the detector calls it "parent checkout changed"
    for a file nobody touched. Every delegation in such a repository therefore refuses. This is
    PRE-EXISTING — measured identical before this change — and the fix (`git cat-file --filters`)
    runs smudge filters and touches the fleet and retained paths too, so it is deliberately not
    bundled here. This test pins today's behaviour so the day it is fixed is a visible change.
    """

    def test_autocrlf_still_refuses(self) -> None:
        case = DelegationCase(files={"crlf.txt": "one\r\ntwo\r\nthree\r\nfour\r\n"},
                              child={"crlf.txt": "one\r\nCHILD\r\nthree\r\nfour\r\n"},
                              parent={"crlf.txt": "one\r\ntwo\r\nthree\r\nPARENT\r\n"},
                              config=(("core.autocrlf", "true"),))
        self.assertEqual(case.result.status, "conflict")
        self.assertEqual(case.raw("crlf.txt"), b"one\r\ntwo\r\nthree\r\nPARENT\r\n",
                         "whatever else it does, it leaves the parent's bytes alone")


if __name__ == "__main__":
    unittest.main()
