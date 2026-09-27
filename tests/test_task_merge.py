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


class AnOverlapHoldsBackOnlyTheFileItTouchesTest(unittest.TestCase):
    """One collision must not discard the child's work on every other file.

    It used to. `integrate` was all-or-nothing, and this class asserted that as a feature
    ("integration is atomic: one conflict means no file moves"). Safe, and very expensive: a
    sub-agent that edited ten files and overlapped on one lost all ten, recoverable only by
    resolving the retained task by hand.

    The contract now matches Grok Build's `apply_worktree`, which reports a conflict per path: the
    files that reconcile land, the ones that collide are held in the worktree and named in the
    result. The colliding file itself is still never touched, and a delta where EVERY path collides
    still refuses wholesale.

    The cost, stated so nobody has to rediscover it: a change spanning two files can half-land.
    That is accepted because the held-back paths are named, the work is preserved, and `/rewind`
    undoes the whole turn again.
    """

    def setUp(self) -> None:
        self.case = DelegationCase(
            files={"shared.py": "one\ntwo\nthree\n", "other.py": "original\n"},
            child={"shared.py": "one\nCHILD\nthree\n", "other.py": "the child wrote this\n"},
            parent={"shared.py": "one\nPARENT\nthree\n"})

    def test_the_status_says_partly_integrated(self) -> None:
        self.assertEqual(self.case.result.status, "partial", self.case.result.error)
        self.assertEqual(self.case.result.conflicts, ["shared.py"])
        self.assertEqual(self.case.result.paths, ["other.py"])

    def test_the_colliding_file_still_never_moves(self) -> None:
        self.assertEqual(self.case.text("shared.py"), "one\nPARENT\nthree\n")
        self.assertNotIn("<<<<<<<", self.case.text("shared.py"),
                         "conflict markers are git's way of asking a human; they must never be "
                         "written into the user's file behind their back")

    def test_the_rest_of_the_delta_is_no_longer_thrown_away(self) -> None:
        self.assertEqual(self.case.text("other.py"), "the child wrote this\n")

    def test_a_delta_where_everything_collides_still_refuses_wholesale(self) -> None:
        case = DelegationCase(
            files={"a.py": "one\ntwo\nthree\n", "b.py": "one\ntwo\nthree\n"},
            child={"a.py": "one\nCHILD\nthree\n", "b.py": "one\nCHILD\nthree\n"},
            parent={"a.py": "one\nPARENT\nthree\n", "b.py": "one\nPARENT\nthree\n"})
        self.assertEqual(case.result.status, "conflict")
        self.assertEqual(case.text("a.py"), "one\nPARENT\nthree\n")
        self.assertEqual(case.text("b.py"), "one\nPARENT\nthree\n")

    def test_the_held_back_work_is_retained_for_review(self) -> None:
        store = Path(tempfile.mkdtemp())
        repo = _project({"x.py": "one\ntwo\nthree\n", "y.py": "keep\n"})
        workspace, error = TaskWorkspace.prepare(str(repo), "held", store)
        self.assertTrue(workspace, error)
        _write(Path(workspace.path), "x.py", "one\nCHILD\nthree\n")
        _write(Path(workspace.path), "y.py", "child wrote y\n")
        _write(repo, "x.py", "one\nPARENT\nthree\n")
        result = workspace.integrate()
        self.assertEqual(result.status, "partial", result.error)

        retained, problems = list_retained(repo, store)
        self.assertEqual(problems, [])
        self.assertEqual(len(retained), 1, "the held-back work must still be recoverable")
        # Only the unresolved path is recorded, so a retry does not re-apply what already landed.
        self.assertEqual(retained[0].display_paths, ["x.py"])


class EverySurfaceKnowsThePartialStatusTest(unittest.TestCase):
    """A new status value is only safe if every reader has a branch for it.

    `partial` joins applied/clean/dropped/conflict/error. Three surfaces switch on the string: the
    sub-task result the model reads, the terminal's `/tasks` resolver, and the editor's. A surface
    without a branch falls through to "could not apply", reporting a partial success as a failure
    and hiding the files that did change. Nothing crosses the wire -- the editor protocol carries a
    boolean, not this string -- so an older extension is unaffected.
    """

    def test_all_three_readers_name_it(self) -> None:
        for name in ("dgc/agent.py", "dgc/cli.py", "dgc/headless.py"):
            with self.subTest(surface=name):
                source = (PROJECT / name).read_text(encoding="utf-8")
                self.assertIn('"partial"', source,
                              f"{name} switches on the integration status and has no branch for "
                              f"partial; it would report a partial success as a failure")

    def test_the_status_is_not_sent_over_the_wire(self) -> None:
        protocol = (PROJECT / "dgc" / "editor_protocol.py").read_text(encoding="utf-8")
        self.assertNotIn("integration_status", protocol)
        self.assertNotIn('"partial"', protocol,
                         "a new enum value on the wire is refused wholesale by an installed SDK")


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

        # The parent lands on the SAME line: a real collision on f.py, so THAT file is held back.
        # new.py has no collision and lands immediately -- partial application, since 0.46.0.
        _write(repo, "f.py", "one\nPARENT\nthree\nfour\nfive\nsix\n")
        first = workspace.integrate()
        self.assertEqual(first.status, "partial", first.error)
        self.assertEqual(first.conflicts, ["f.py"])
        self.assertEqual((repo / "new.py").read_text(encoding="utf-8"),
                         "the child also wrote this\n",
                         "the file that did not collide must not wait on the one that did")

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
                         "the child also wrote this\n", "and it is still there after the retry")

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


class AReconciledFileIsReportedAsOneTest(unittest.TestCase):
    """"Integrated" must not read the same whether or not the user's own edit was merged into.

    The merge reconciles the child's bytes with a change the parent made DURING the run. Those are
    files the user has open right now, and their edit is now interleaved with the child's. The
    `merged` list was computed and then discarded, so the transcript said "integrated 1 path(s)"
    for both cases and gave the user no reason to look at the result.
    """

    def _case(self, parent_edits: bool):
        repo = _project({"shared.py": "one\ntwo\nthree\nfour\nfive\nsix\n"})
        workspace, error = TaskWorkspace.prepare(str(repo), "report", Path(tempfile.mkdtemp()))
        self.assertTrue(workspace, error)
        _write(Path(workspace.path), "shared.py", "one\nCHILD\nthree\nfour\nfive\nsix\n")
        if parent_edits:
            _write(repo, "shared.py", "one\ntwo\nthree\nfour\nfive\nPARENT\n")
        return workspace.integrate()

    def test_a_merge_is_named_and_a_clean_apply_is_not(self) -> None:
        reconciled = self._case(parent_edits=True)
        plain = self._case(parent_edits=False)
        self.assertEqual(reconciled.status, "applied", reconciled.error)
        self.assertEqual(plain.status, "applied", plain.error)
        self.assertEqual(reconciled.merged, ["shared.py"],
                         "the file the user was editing must be named")
        self.assertEqual(plain.merged, [],
                         "writing over an untouched file is not a reconciliation")

    def test_the_field_sits_last_so_positional_callers_keep_working(self) -> None:
        """Several call sites build this positionally, and a field added before `error` ate the
        message that explains a refusal. Keep the order, and keep a guard on it."""
        from dgc.worktree import TaskIntegration
        import dataclasses
        names = [f.name for f in dataclasses.fields(TaskIntegration)]
        self.assertEqual(names[:3], ["status", "paths", "conflicts"])
        self.assertLess(names.index("error"), names.index("merged"),
                        "a field before `error` swallows the refusal message of every positional "
                        "TaskIntegration(...) call")
        positional = TaskIntegration("conflict", ["a"], ["a"], "the reason")
        self.assertEqual(positional.error, "the reason")
        self.assertEqual(positional.merged, [])


class RewindStillWorksAfterADelegationTest(unittest.TestCase):
    """Integration must tell the checkpoint manager what DGC left, not just what was there before.

    `record_file` captures the BEFORE bytes; `note_written` records what DGC then wrote. Integration
    called only the first. So `_left` still held whatever an EARLIER turn's edit tool had written,
    the next rewind found a file it could not account for, and it refused the WHOLE turn with
    "changed outside this chat since DGC last wrote it. Nothing was restored" -- about a file DGC's
    own sub-agent had written seconds earlier. The user is sent hunting a second writer that does
    not exist, and rewind stays dead for the rest of the session.

    Pre-existing (measured identical at 82775c9e, before the three-way merge landed). The suite was
    green over it because tests/run_tests.py drives this sequence without ever calling
    `note_written`, so `_left` is empty and the guard takes its "nothing recorded" escape -- the one
    precondition that makes the bug appear is the one the test omitted.
    """

    def _delegated_turn(self, checkpoints):
        """DGC edits a file in turn one, then a sub-agent edits it again in turn two."""
        repo = _project({"app.py": "one\ntwo\nthree\nfour\n"})
        run = lambda *a: subprocess.run(a, cwd=repo, check=True, capture_output=True)  # noqa: E731

        checkpoints.open(1, "turn one")
        checkpoints.record_file(str(repo / "app.py"))
        _write(repo, "app.py", "one\nDGC EDIT\nthree\nfour\n")
        checkpoints.note_written(str(repo / "app.py"))
        run("git", "add", "-A")
        run("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "turn one")

        checkpoints.open(2, "turn two")
        workspace, error = TaskWorkspace.prepare(str(repo), "rewind", Path(tempfile.mkdtemp()))
        self.assertTrue(workspace, error)
        _write(Path(workspace.path), "app.py", "one\nDGC EDIT\nthree\nCHILD\n")
        result = workspace.integrate(checkpoints=checkpoints)
        self.assertEqual(result.status, "applied", result.error)
        return repo

    def test_a_rewind_after_integration_restores_instead_of_blaming_the_user(self) -> None:
        from dgc.checkpoints import CheckpointManager
        checkpoints = CheckpointManager(Path(tempfile.mkdtemp()))
        repo = self._delegated_turn(checkpoints)
        # The manager's project_root must be the repo for the snapshot paths to line up.
        checkpoints.project_root = repo.resolve()

        state = checkpoints.rewind_state(1)
        self.assertEqual(checkpoints.last_rewind_conflicts, [],
                         "the sub-agent's write is DGC's own; it must not read as a foreign edit")
        self.assertNotEqual(state[0], -1, "a wholesale refusal leaves the user with nothing")
        self.assertEqual((repo / "app.py").read_text(encoding="utf-8"),
                         "one\nDGC EDIT\nthree\nfour\n",
                         "turn two's delegated edit is what a rewind of turn two should undo")

    def test_a_checkpoint_stub_without_note_written_still_integrates(self) -> None:
        """The guard is load-bearing: the suites pass duck-typed stubs with only `record_file`."""
        class OnlyRecords:
            def __init__(self): self.seen = []
            def record_file(self, path): self.seen.append(path); return True

        stub = OnlyRecords()
        repo = _project({"a.py": "one\ntwo\n"})
        workspace, error = TaskWorkspace.prepare(str(repo), "stub", Path(tempfile.mkdtemp()))
        self.assertTrue(workspace, error)
        _write(Path(workspace.path), "a.py", "one\nCHILD\n")
        result = workspace.integrate(checkpoints=stub)
        self.assertEqual(result.status, "applied", result.error)
        self.assertTrue(stub.seen, "record_file must still be called")


class ARepositoryThatConvertsItsFilesStillDelegatesTest(unittest.TestCase):
    """A checkout's bytes are not always its blob's bytes, and the comparison used the blob.

    `_head_state` answers "what did the sub-agent start from?", and its answer is compared against
    bytes read off disk. It returned the BLOB. Whenever a repository configures a conversion those
    two differ for every affected file, so every delta touching one was refused -- and the refusal
    blamed the parent: "parent checkout changed while the isolated task was running."

    This was originally recorded as a Windows-only `core.autocrlf` limitation. It is not. Measured
    on Linux with no user configuration at all, an `eol=crlf` attribute and a clean/smudge filter
    pair -- Git LFS's exact shape -- both refuse. Any repository shipping `* text=auto eol=crlf`,
    `*.bat text eol=crlf`, or using LFS could not have a sub-agent edit those files on any platform.

    The fix asks git for the blob AS CHECKED OUT (`cat-file --filters`). That runs the repository's
    smudge filter, which is not a new capability: `git worktree add` already runs it for every
    delegation when it materialises the child's checkout -- verified, a child's copy holds the
    smudged bytes, not the blob's.
    """

    def _delegate(self, *, config=(), attributes=None, filters=False):
        # Build the repository the way a user's really is: the conversion is configured BEFORE the
        # content is committed, so the blob is the cleaned form and the checkout is the smudged one.
        # Configuring it afterwards leaves an unconverted blob and tests nothing.
        repo = Path(tempfile.mkdtemp(prefix="dgc-conv-"))
        run = lambda *a: subprocess.run(a, cwd=repo, check=True, capture_output=True)  # noqa: E731
        run("git", "init", "-q", ".")
        for key, value in config:
            run("git", "config", key, value)
        if filters:
            run("git", "config", "filter.fake.clean", "sed -e 's/^/C:/'")
            run("git", "config", "filter.fake.smudge", "sed -e 's/^C://'")
        if attributes:
            (repo / ".gitattributes").write_bytes((attributes + "\n").encode())
        (repo / "app.dat").write_bytes(b"one\ntwo\nthree\nfour\n")
        run("git", "add", "-A")
        run("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
        # Re-materialise through the conversion, which is what a fresh clone gives every user.
        (repo / "app.dat").unlink()
        run("git", "checkout", "HEAD", "--", "app.dat")

        workspace, error = TaskWorkspace.prepare(str(repo), "conv", Path(tempfile.mkdtemp()))
        self.assertTrue(workspace, error)
        target = Path(workspace.path) / "app.dat"
        # BYTES. read_text() applies universal newlines and would silently turn the CRLF this test
        # exists to protect into LF before the code under test ever sees it.
        target.write_bytes(target.read_bytes().replace(b"two", b"CHILD"))
        return repo, workspace.integrate()

    def test_core_autocrlf(self) -> None:
        repo, result = self._delegate(config=(("core.autocrlf", "true"),))
        self.assertEqual(result.status, "applied", result.error)
        self.assertIn("CHILD", (repo / "app.dat").read_text(encoding="utf-8"))

    def test_a_gitattributes_eol_rule(self) -> None:
        repo, result = self._delegate(attributes="*.dat text eol=crlf")
        self.assertEqual(result.status, "applied", result.error)
        self.assertIn(b"\r\n", (repo / "app.dat").read_bytes(),
                      "the repository asked for CRLF; integration must not quietly normalise it")

    def test_a_clean_smudge_filter_pair(self) -> None:
        # Git LFS's shape. Before the fix an LFS repository could not have a sub-agent edit an
        # LFS-tracked file at all.
        repo, result = self._delegate(attributes="*.dat filter=fake", filters=True)
        self.assertEqual(result.status, "applied", result.error)
        self.assertIn("CHILD", (repo / "app.dat").read_text(encoding="utf-8"))

    def test_a_plain_repository_is_unchanged(self) -> None:
        repo, result = self._delegate()
        self.assertEqual(result.status, "applied", result.error)

    def test_a_real_overlap_under_conversion_still_refuses(self) -> None:
        """The fix must not turn a genuine collision into a silent merge."""
        repo = _project({"app.dat": "one\ntwo\nthree\n"}, (("core.autocrlf", "true"),))
        workspace, error = TaskWorkspace.prepare(str(repo), "conv", Path(tempfile.mkdtemp()))
        self.assertTrue(workspace, error)
        _write(Path(workspace.path), "app.dat", "one\nCHILD\nthree\n")
        _write(repo, "app.dat", "one\nPARENT\nthree\n")
        result = workspace.integrate()
        self.assertEqual(result.status, "conflict")
        self.assertEqual((repo / "app.dat").read_text(encoding="utf-8"), "one\nPARENT\nthree\n")


if __name__ == "__main__":
    unittest.main()
