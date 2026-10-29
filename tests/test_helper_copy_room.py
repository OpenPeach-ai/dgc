"""A helper's copy holds the project's code, and names what it leaves out.

Reported from a real project: 944 uncommitted paths, 67.6 MB. 36 changed tracked files (3.1 MB)
were the code that mattered; beside them sat 908 untracked files (64.5 MB): report screenshots, a
downloaded UI template with hundreds of small files, and a few genuinely new source files. The
helper's copy took all of it or refused, and past its 64 MB limit it refused: all three
delegations of one turn said "dirty baseline exceeds 67108864 bytes", no helper ever started, and
the model did the work itself.

The rule now (dgc/worktree.py `TaskWorkspace._populate`):
  1. every changed tracked file and every deletion is copied; only when those alone do not fit is
     a delegation refused, and then in words a person can act on, never a byte count;
  2. untracked files are copied while there is room: text and source first, then the rest, each
     smallest first; whatever does not fit is LEFT OUT, and that is never a refusal;
  3. the helper is told what it does not have (its prompt names the files);
  4. integration never writes, overwrites or deletes a left-out path, on every path that
     integrates: the live one, a kept checkout, and a retained task applied later from /tasks.

Every case runs real git in a real repository. Big files are sparse, so the 64 MB shapes cost
almost no disk and build in well under a second.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dgc import helper_memory, worktree                                 # noqa: E402
from dgc.llm import ToolCall                                            # noqa: E402
from dgc.worktree import KeptTaskWorkspace, TaskWorkspace               # noqa: E402
from test_helper_checkout import Case, Recorder                         # noqa: E402

KB = 1024
MB = 1024 * KB
PNG = b"\x89PNG\r\n\x1a\n"


def git(root: Path, *args) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True,
                          text=True).stdout


def write(root: Path, name: str, data) -> Path:
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data if isinstance(data, bytes) else data.encode())
    return target


def blob(root: Path, name: str, size: int, head: bytes = PNG) -> Path:
    """A file of exactly `size` bytes that costs almost no disk: a header, then a hole."""
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "wb") as handle:
        handle.write(head)
        handle.truncate(size)
    return target


def text_of(size: int, seed: str) -> str:
    line = f"value_{seed} = '{seed}' * 3  # generated\n"
    return (line * (size // len(line) + 1))[:size]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def new_repo(base: Path, files: dict) -> Path:
    root = base / "project"
    root.mkdir(parents=True)
    git(root, "init", "-q", ".")
    git(root, "config", "user.email", "tests@dgc.invalid")
    git(root, "config", "user.name", "DGC Tests")
    for name, data in files.items():
        write(root, name, data)
    git(root, "add", "-A")
    git(root, "commit", "-qm", "baseline")
    return root


def reported_shape(root: Path) -> dict:
    """The reported project, in `root` (a Git repository with at least one commit).

    Tracked: 36 source files, committed and then rewritten (about 3.1 MB of tracked changes), one
    tracked file deleted, and one tracked file left clean for a helper to edit. Untracked: 150
    report screenshots (about 60 MB of PNG), a downloaded template of 400 small files (300 text,
    100 images and fonts, about 13 MB), and 15 new source files (about 2.2 MB). About 78 MB of
    uncommitted state in all, so it cannot all fit.
    """
    modules = [f"backend/app/module_{i:02d}.py" for i in range(36)]
    for name in modules:
        write(root, name, f"# {name}\n")
    write(root, "backend/app/clean.py", "def ready():\n    return False\n")
    write(root, "backend/app/old.py", "obsolete = True\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "the project")
    for name in modules:
        write(root, name, text_of(88 * KB, name))
    (root / "backend/app/old.py").unlink()
    reports = []
    for i in range(150):
        name = f"reports/run-{i // 30}/screen-{i:03d}.png"
        blob(root, name, 300 * KB + (i * 37 % 200) * KB)
        reports.append(name)
    template_text = []
    for i in range(300):
        suffix = (".css", ".js", ".html", ".svg")[i % 4]
        name = f"ui-template/assets/part-{i:03d}{suffix}"
        write(root, name, text_of(1 * KB + (i % 5) * KB, name))
        template_text.append(name)
    template_media = []
    for i in range(100):
        suffix = (".jpg", ".png", ".woff2", ".ico")[i % 4]
        name = f"ui-template/media/item-{i:03d}{suffix}"
        blob(root, name, 130 * KB, head=b"\xff\xd8\xff\xe0")
        template_media.append(name)
    sources = []
    for i in range(15):
        name = f"backend/app/new_feature_{i:02d}.py"
        write(root, name, text_of(150 * KB, name))
        sources.append(name)
    return {"modules": modules, "deleted": "backend/app/old.py", "clean": "backend/app/clean.py",
            "reports": reports, "template_text": template_text,
            "template_media": template_media, "sources": sources}


class Fixture(unittest.TestCase):
    def base(self) -> Path:
        base = Path(tempfile.mkdtemp(prefix="dgc-copy-room-")).resolve()
        self.addCleanup(shutil.rmtree, base, True)
        return base

    def prepared(self, root: Path, store: Path) -> TaskWorkspace:
        workspace, error = TaskWorkspace.prepare(root, "room", store)
        if workspace is None:
            raise AssertionError(f"prepare refused: {error}")
        self.addCleanup(workspace.cleanup)
        return workspace


# ------------------------------------------------------------------------- the reported shape ---
class TheReportedProjectGetsAHelperTest(unittest.TestCase):
    """What the copy holds and says. Read-only, so one copy serves every test here."""

    @classmethod
    def setUpClass(cls) -> None:
        base = Path(tempfile.mkdtemp(prefix="dgc-copy-room-")).resolve()
        cls.addClassCleanup(shutil.rmtree, base, True)
        cls.root = new_repo(base, {"README.md": "the project\n", ".gitignore": "node_modules/\n"})
        cls.shape = reported_shape(cls.root)
        cls.workspace, error = TaskWorkspace.prepare(cls.root, "room", base / "store")
        if cls.workspace is None:
            raise AssertionError(f"prepare refused: {error}")
        cls.addClassCleanup(cls.workspace.cleanup)

    def test_prepare_succeeds_and_the_copy_has_all_the_code(self) -> None:
        copy = self.workspace.path
        for name in self.shape["modules"] + self.shape["sources"] + self.shape["template_text"]:
            self.assertEqual((copy / name).read_bytes(), (self.root / name).read_bytes(), name)
        self.assertFalse((copy / self.shape["deleted"]).exists(), "a deletion is part of the copy")
        self.assertLessEqual(sum(len(state.data) for state in self.workspace.baseline.values()),
                             worktree._MAX_TASK_BYTES, "the copy itself stays within its limit")
        self.assertEqual(self.workspace.changed_paths(), [],
                         "a fresh copy has no delta: nothing left out reads as a deletion")

    def test_the_bulky_files_are_left_out_smallest_kept_first(self) -> None:
        left = set(self.workspace.left_out)
        self.assertTrue(left, "78 MB cannot fit in a 64 MB copy")
        self.assertTrue(left <= set(self.shape["reports"]),
                        f"only the biggest extras are left out: {sorted(left)[:5]}")
        copy = self.workspace.path
        for name in left:
            self.assertFalse((copy / name).exists(), name)
            self.assertIn(name, self.workspace.initial_dirty, "still the user's uncommitted file")
            self.assertNotIn(name, self.workspace.baseline)
        for name in self.shape["template_media"]:
            self.assertTrue((copy / name).exists(), "smaller binary files are copied before bigger ones")
        copied = [name for name in self.shape["reports"] if name not in left]
        self.assertTrue(copied, "screenshots are copied while there is room")
        self.assertLessEqual(max((self.root / name).stat().st_size for name in copied),
                             min((self.root / name).stat().st_size for name in left),
                             "smallest first: every copied screenshot is no bigger than a left-out one")

    def test_the_helper_is_told_what_its_copy_does_not_have(self) -> None:
        note = worktree.left_out_note(self.workspace)
        left = sorted(self.workspace.left_out)
        self.assertGreater(len(left), 20, "enough left out to need the folder counts")
        self.assertIn(f"Not in this checkout: {len(left)} of the user's own uncommitted files", note)
        for name in left[:20]:
            self.assertIn(name, note)
        self.assertNotIn(left[20], note, "the rest is counted, not listed")
        self.assertIn(f"and {len(left) - 20} more (", note)
        self.assertRegex(note, r"\d+ in reports/")
        self.assertIn("If the task needs one of them, say which in your report.", note)
        self.assertIn("Do not recreate them", note)
        self.assertNotIn(str(worktree._MAX_TASK_BYTES), note, "no raw byte counts")
        summary = worktree.left_out_summary(self.workspace)
        self.assertIn(f"{len(left)} untracked files left out", summary)


class TheReportedProjectIntegratesTest(Fixture):
    def setUp(self) -> None:
        base = self.base()
        self.root = new_repo(base, {"README.md": "the project\n", ".gitignore": "node_modules/\n"})
        self.shape = reported_shape(self.root)
        self.store = base / "store"
        self.workspace = self.prepared(self.root, self.store)

    def test_a_helper_that_edits_a_tracked_file_integrates_and_every_left_out_file_stays(self) -> None:
        before = {name: digest(self.root / name) for name in self.workspace.left_out}
        write(self.workspace.path, self.shape["clean"], "def ready():\n    return True\n")
        write(self.workspace.path, "docs/notes.md", "what the helper found\n")
        result = self.workspace.integrate()
        self.assertEqual(result.status, "applied", result)
        self.assertEqual(sorted(result.paths), ["backend/app/clean.py", "docs/notes.md"])
        self.assertEqual((self.root / self.shape["clean"]).read_text(),
                         "def ready():\n    return True\n")
        for name, value in before.items():
            self.assertEqual(digest(self.root / name), value,
                             f"{name}: absent from the copy, and never read as deleted")

    def test_a_helper_that_writes_a_left_out_path_gets_only_that_path_refused(self) -> None:
        target = sorted(self.workspace.left_out)[-1]
        mine = digest(self.root / target)
        write(self.workspace.path, self.shape["clean"], "def ready():\n    return True\n")
        write(self.workspace.path, target, b"the helper's own picture")
        result = self.workspace.integrate()
        self.assertEqual(result.status, "partial", result)
        self.assertEqual(result.paths, [self.shape["clean"]], "its other work still lands")
        self.assertEqual(result.conflicts, [target])
        self.assertEqual(result.left_out, [target])
        self.assertIn(target, result.error)
        self.assertIn("not copied into its checkout", result.error)
        self.assertEqual(digest(self.root / target), mine, "the user's file is byte-for-byte unchanged")
        self.assertEqual((self.root / self.shape["clean"]).read_text(),
                         "def ready():\n    return True\n")
        # Held for /tasks, like any held-back change, and still refused from there -- even once the
        # user's own file is gone, which is when "the parent has not touched it" would let it in.
        tasks, errors = worktree.list_retained(self.root, self.store)
        self.assertEqual(errors, [])
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0].changed_paths, [target])
        self.assertIn(target, tasks[0].left_out)
        (self.root / target).unlink()
        again = worktree.resolve_retained(self.root, tasks[0].id, "apply", self.store)
        self.assertEqual(again.status, "conflict", again)
        self.assertEqual(again.left_out, [target])
        self.assertFalse((self.root / target).exists(), "a left-out path is never written")


# --------------------------------------------------------------------------- the plain refusal ---
class TrackedChangesAloneOverTheLimitTest(Fixture):
    def test_more_bytes_than_a_copy_holds_is_refused_in_plain_words(self) -> None:
        base = self.base()
        root = new_repo(base, {"data/one.txt": "1\n", "data/two.txt": "2\n", "keep.py": "x = 1\n"})
        blob(root, "data/one.txt", 34 * MB, head=b"1")
        blob(root, "data/two.txt", 34 * MB, head=b"2")
        blob(root, "reports/extra.png", 5 * MB)
        workspace, error = TaskWorkspace.prepare(root, "room", base / "store")
        self.assertIsNone(workspace)
        self.assertEqual(error, "This project has 68 MB of uncommitted changes to tracked files, more "
                                "than a helper's copy holds (64 MB). Commit some of it, or let the "
                                "model do this itself.")
        self.assertNotRegex(error, r"\d{5,}", "never a raw byte count")
        self.assertEqual(git(root, "worktree", "list", "--porcelain").count("worktree "), 1,
                         "the refused copy was removed")
        self.assertEqual((root / "keep.py").read_text(), "x = 1\n")

    def test_more_files_than_a_copy_holds_is_refused_in_plain_words(self) -> None:
        base = self.base()
        root = new_repo(base, {f"src/f{i}.py": f"x = {i}\n" for i in range(10)})
        for i in range(10):
            write(root, f"src/f{i}.py", f"x = {i + 1}\n")
        with mock.patch.object(worktree, "_MAX_TASK_FILES", 8):
            workspace, error = TaskWorkspace.prepare(root, "room", base / "store")
        self.assertIsNone(workspace)
        self.assertEqual(error, "This project has uncommitted changes to 10 tracked files, more than a "
                                "helper's copy holds (8 files). Commit some of them, or let the model "
                                "do this itself.")

    def test_untracked_extras_are_never_the_reason(self) -> None:
        """More untracked files than the copy's file limit: it used to refuse ("git path query
        exceeded 4096 entries"); now it copies what fits and leaves the rest out."""
        base = self.base()
        root = new_repo(base, {"app.py": "x = 1\n"})
        write(root, "app.py", "x = 2\n")
        for i in range(50):
            write(root, f"scratch/item-{i:02d}.txt", f"{i}\n" * (i + 1))
        with mock.patch.object(worktree, "_MAX_TASK_FILES", 20):
            workspace = self.prepared(root, base / "store")
            self.assertEqual(len(workspace.baseline), 20, "one tracked change and 19 extras")
            self.assertEqual(len(workspace.left_out), 31)
            self.assertIn("app.py", workspace.baseline)
            kept = sorted(path for path in workspace.baseline if path.startswith("scratch/"))
            self.assertEqual(kept, [f"scratch/item-{i:02d}.txt" for i in range(19)],
                             "the smallest ones")


# -------------------------------------------------------------------------------- the order ---
class WhatFitsIsChosenByKindThenSizeTest(Fixture):
    def setUp(self) -> None:
        base = self.base()
        self.root = new_repo(base, {"app.py": "x = 1\n"})
        self.store = base / "store"
        write(self.root, "app.py", "a" * (10 * KB))                   # 10 KB of tracked change
        write(self.root, "src/a.py", "a" * (20 * KB))
        write(self.root, "notes.txt", "n" * (25 * KB))
        write(self.root, "src/b.py", "b" * (30 * KB))
        write(self.root, "huge.txt", "h" * (200 * KB))
        write(self.root, "fake.txt", b"\0" + b"f" * (3 * KB - 1))      # a NUL byte: binary
        write(self.root, "logo.png", "p" * (12 * KB))                  # binary by its name
        write(self.root, "dump.dat", b"\0" * (9 * KB))                 # binary by its content

    def prepared_under(self, cap: int) -> tuple[TaskWorkspace, list[str]]:
        sniffed = []
        real = worktree._looks_binary

        def looks(path):
            sniffed.append(Path(path).name)
            return real(path)
        with mock.patch.object(worktree, "_MAX_TASK_BYTES", cap), \
                mock.patch.object(worktree, "_looks_binary", looks):
            return self.prepared(self.root, self.store), sniffed

    def test_text_first_then_the_rest_each_smallest_first(self) -> None:
        # 100 KB in all; the tracked change takes 10, leaving 90, and the extras want 99 (plus
        # huge.txt). Text first, smallest first: a.py, notes.txt, b.py (75 KB), and huge.txt is
        # past the cut. Then the rest, smallest first: fake.txt (3) and dump.dat (9) fit, logo.png
        # (12) does not. Size alone would have left b.py out; a binary class decided by name
        # alone, or by size among everything, would have kept logo.png over dump.dat.
        workspace, sniffed = self.prepared_under(100 * KB)
        self.assertEqual(sorted(workspace.baseline),
                         ["app.py", "dump.dat", "fake.txt", "notes.txt", "src/a.py", "src/b.py"])
        self.assertEqual(sorted(workspace.left_out), ["huge.txt", "logo.png"])
        self.assertNotIn("huge.txt", sniffed, "a file past the cut is never opened")
        self.assertNotIn("logo.png", sniffed, "its name already says what it is")

    def test_the_same_state_gives_the_same_copy(self) -> None:
        """Parallel siblings are refused a mixed baseline, so the choice must be deterministic."""
        first, _ = self.prepared_under(100 * KB)
        second, _ = self.prepared_under(100 * KB)
        self.assertEqual(set(first.baseline), set(second.baseline))
        self.assertEqual(set(first.left_out), set(second.left_out))
        self.assertEqual(first.baseline, second.baseline)


# ---------------------------------------------------------------- every path follows the rule ---
class EveryIntegrationKeepsOffLeftOutFilesTest(Fixture):
    CAP = 64 * KB

    def setUp(self) -> None:
        base = self.base()
        self.base_dir = base
        self.root = new_repo(base, {"app.py": "x = 1\n", "lib.py": "y = 1\n"})
        write(self.root, "app.py", "x = 2\n")                         # a dirty tracked file
        write(self.root, "new.py", "z = 1\n")                         # a small extra: copied
        self.big = blob(self.root, "media/big.png", 200 * KB)         # left out
        self.other = blob(self.root, "media/other.png", 150 * KB)     # left out
        self.patch = mock.patch.object(worktree, "_MAX_TASK_BYTES", self.CAP)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_a_left_out_file_the_user_changes_meanwhile_is_reported_and_never_restored(self) -> None:
        """The outside-the-copy report reads Git's view of the user's checkout. A left-out file was
        never read, so its earlier state is unknown: Undo must not be handed "it was absent"."""
        workspace = self.prepared(self.root, self.base_dir / "store")
        self.assertEqual(sorted(workspace.left_out), ["media/big.png", "media/other.png"])
        self.assertEqual(workspace.source_changes(), [], "an untouched left-out file is not news")
        with open(self.big, "ab") as handle:
            handle.write(b"edited by the user")
        changes = workspace.source_changes()
        self.assertEqual([change.repo_path for change in changes], ["media/big.png"])
        self.assertIsNone(changes[0].before)
        self.assertIsNone(workspace.exact_start_state(changes[0]),
                          "no recovery point from a guess: the base commit's 'absent' would delete it")

    def test_a_kept_checkout_holds_a_left_out_path_back_too(self) -> None:
        """A kept checkout integrates the user's dirty files (its Undo keeps exact copies), but a
        file it never had is still never written."""
        kept = self.base_dir / "kept" / "copy"
        workspace, error = KeptTaskWorkspace.sync(self.root, kept)
        self.assertIsNone(error)
        self.addCleanup(KeptTaskWorkspace.remove, self.root, kept)
        self.assertEqual(sorted(workspace.left_out), ["media/big.png", "media/other.png"])
        mine = digest(self.big)
        write(workspace.path, "app.py", "x = 3\n")
        write(workspace.path, "media/big.png", b"the fixer's picture")
        result = workspace.integrate()
        self.assertEqual(result.status, "partial", result)
        self.assertEqual(result.paths, ["app.py"])
        self.assertEqual(result.left_out, ["media/big.png"])
        self.assertEqual(workspace.held_paths, ["media/big.png"])
        self.assertEqual((self.root / "app.py").read_text(), "x = 3\n")
        self.assertEqual(digest(self.big), mine)

    def test_kept_checkout_refuses_an_unregistered_folder_without_removing_it(self) -> None:
        kept = self.base_dir / "kept" / "copy"
        kept.mkdir(parents=True)
        marker = kept / "user-work.txt"
        marker.write_text("keep this work\n")
        workspace, error = KeptTaskWorkspace.sync(self.root, kept)
        self.assertIsNone(workspace)
        self.assertIn("not registered", error)
        self.assertEqual(marker.read_text(), "keep this work\n")
        self.assertIn("not registered", KeptTaskWorkspace.remove(self.root, kept))
        self.assertEqual(marker.read_text(), "keep this work\n")

    def test_a_helper_that_only_writes_left_out_paths_changes_nothing(self) -> None:
        workspace = self.prepared(self.root, self.base_dir / "store")
        mine = {path: digest(path) for path in (self.big, self.other)}
        write(workspace.path, "media/big.png", b"one")
        write(workspace.path, "media/other.png", b"two")
        result = workspace.integrate()
        self.assertEqual(result.status, "conflict", result)
        self.assertEqual(result.left_out, ["media/big.png", "media/other.png"])
        self.assertNotIn("parent checkout changed", result.error,
                         "the user changed nothing; the reason must say what really happened")
        self.assertEqual({path: digest(path) for path in mine}, mine)

    def test_a_left_out_file_the_user_removed_meanwhile_is_still_not_written(self) -> None:
        """The case "the parent has not touched it" gets wrong: with the user's file gone, their
        checkout matches the base commit at that path, so the helper's bytes would simply land."""
        workspace = self.prepared(self.root, self.base_dir / "store")
        write(workspace.path, "lib.py", "y = 2\n")
        write(workspace.path, "media/big.png", b"the helper's picture")
        self.big.unlink()
        result = workspace.integrate()
        self.assertEqual(result.status, "partial", result)
        self.assertEqual(result.paths, ["lib.py"])
        self.assertEqual(result.left_out, ["media/big.png"])
        self.assertFalse(self.big.exists(), "never written, whatever the user's checkout holds there")

    def test_a_path_through_a_left_out_file_is_held_back_too(self) -> None:
        """A folder where the user has a left-out file: writing it would need to replace the
        user's file with a folder. Held back like the file itself, not an integration error."""
        workspace = self.prepared(self.root, self.base_dir / "store")
        write(workspace.path, "lib.py", "y = 2\n")
        (workspace.path / "media").mkdir(exist_ok=True)
        (workspace.path / "media" / "big.png").mkdir()
        write(workspace.path, "media/big.png/inside.txt", "nested\n")
        mine = digest(self.big)
        result = workspace.integrate()
        self.assertEqual(result.status, "partial", result)
        self.assertEqual(result.paths, ["lib.py"])
        self.assertEqual(result.left_out, ["media/big.png/inside.txt"])
        self.assertEqual(digest(self.big), mine)

    def test_a_continued_helper_is_not_told_its_left_out_files_changed(self) -> None:
        """"Changed since you last worked on it" compares the project with what the helper saw;
        it never saw a left-out file, so naming those would be false about every one of them."""
        workspace = self.prepared(self.root, self.base_dir / "store")
        view = helper_memory.view_state(workspace, SimpleNamespace(paths=[]))
        self.assertEqual(view["left_out"], ["media/big.png", "media/other.png"])
        write(self.root, "new.py", "z = 2\n")                         # a copied file that moved
        self.assertEqual(helper_memory.changed_since(self.root, view), ["new.py"])

    def test_own_earlier_work_that_is_left_out_stays_the_users(self) -> None:
        workspace = self.prepared(self.root, self.base_dir / "store")
        landed = {"media/big.png": "anything", "new.py": helper_memory._digest(
            workspace.baseline["new.py"])}
        self.assertEqual(helper_memory.own_dirty(workspace, {"landed": landed}), frozenset({"new.py"}))


# --------------------------------------------------------------------------- the whole loop ---
# ------------------------------------------------------------- a fleet agent's copy (Ctrl+N) ---
class AFleetAgentsCopyFollowsTheSameRuleTest(Fixture):
    """Ctrl+N's isolated agent copied everything or refused, as a helper's copy did ("dirty baseline exceeds
    67108864 bytes" on the reported project). It takes the helper's rule now, and its agent is told what's left out."""

    def test_the_reported_project_gets_its_agent_with_all_the_code_and_is_told_what_is_left_out(self) -> None:
        base = self.base()
        root = new_repo(base, {"README.md": "the project\n", ".gitignore": "node_modules/\n"})
        shape = reported_shape(root)
        fleet, error = worktree.FleetWorkspace.prepare(root, "agent 2", base / "fleet")
        self.assertIsNone(error)
        self.addCleanup(fleet.cleanup)
        copy = fleet.project_root
        for name in shape["modules"] + shape["sources"] + shape["template_text"]:
            self.assertEqual((copy / name).read_bytes(), (root / name).read_bytes(), name)
        self.assertFalse((copy / shape["deleted"]).exists(), "a deletion is part of the copy")
        left = set(fleet.left_out)
        self.assertTrue(left and left <= set(shape["reports"]) | set(shape["template_media"]), sorted(left)[:5])
        self.assertTrue(all(not (copy / name).exists() for name in left))
        note = fleet.left_out_note
        self.assertIn(f"{len(left):,} of the user's own uncommitted files", note)
        self.assertIn("left out because an isolated agent's copy holds at most 64 MB", note)
        self.assertIn("If the task needs one of them, tell the user which.", note)
        self.assertNotIn("your report", note, "an agent has no report to write")
        self.assertIn("no room for them in an isolated agent's copy", worktree.left_out_summary(fleet, "agent"))
        self.assertEqual(fleet.changed_paths(), [], "nothing left out reads as a change")
        # A conversation opened again is told too: the note is kept with the copy's private metadata.
        from dgc import sessions
        saved = sessions.new_path(root)
        sessions.save_workspace(saved, root, kind="managed", worktree=fleet.path, branch=fleet.branch,
                                metadata=fleet.metadata_path)
        again, error = worktree.FleetWorkspace.attach(root, sessions.load_workspace(saved, root), base / "fleet")
        self.assertIsNone(error)
        self.assertEqual((again.left_out, again.left_out_note), ({}, note))
        # Untouched, it closes clean: the left-out files were never its own.
        self.assertEqual(fleet.finish("closed").status, "cleaned")
        for name in left:
            self.assertTrue((root / name).exists(), "the user's files stay where they are")

    def test_an_agent_whose_copy_has_everything_is_told_nothing(self) -> None:
        base = self.base()
        root = new_repo(base, {"app.py": "x = 1\n"})
        write(root, "app.py", "x = 2\n")
        write(root, "notes.md", "todo\n")
        fleet, error = worktree.FleetWorkspace.prepare(root, "agent 2", base / "fleet")
        self.assertIsNone(error)
        self.addCleanup(fleet.cleanup)
        self.assertEqual((fleet.left_out, fleet.left_out_note, worktree.left_out_summary(fleet, "agent")), ({}, "", ""))
        self.assertNotIn("left_out_note", fleet.payload)
        self.assertEqual((fleet.project_root / "notes.md").read_text(), "todo\n")

    def test_too_much_tracked_change_is_refused_in_words_for_an_agent(self) -> None:
        base = self.base()
        root = new_repo(base, {"data/one.txt": "1\n", "data/two.txt": "2\n"})
        blob(root, "data/one.txt", 34 * MB, head=b"1")
        blob(root, "data/two.txt", 34 * MB, head=b"2")
        fleet, error = worktree.FleetWorkspace.prepare(root, "agent 2", base / "fleet")
        self.assertIsNone(fleet)
        self.assertEqual(error, "This project has 68 MB of uncommitted changes to tracked files, more than an "
                                "isolated agent's copy holds (64 MB). Commit some of it, then open the agent again.")
        self.assertEqual(git(root, "worktree", "list", "--porcelain").count("worktree "), 1,
                         "the refused copy was removed")


class TheReportedProjectEndToEndTest(Case):
    """The parent delegates through `task`, as the model does, in the reported project."""

    def test_the_helper_starts_is_told_and_its_work_lands_without_touching_left_out_files(self):
        h = self.make_repo()
        root = h.root.resolve()
        shape = reported_shape(root)
        seen = {}

        def calls(messages):
            system = str(messages[0].get("content"))
            seen["system"] = system
            named = next(name for name in shape["reports"] if name in system)
            seen["target"] = named
            seen["before"] = digest(root / named)
            return [ToolCall("w1", "write_file", {"path": "notes.txt", "content": "one\ntwo\n"}),
                    ToolCall("w2", "write_file", {"path": named, "content": "the helper's picture"})]

        child = Recorder(calls, "updated the notes")
        results = self.run_parent(h, [[ToolCall("t1", "task", {"description": "notes",
                                                               "prompt": "SHAPE-1 update notes"})],
                                      ("SHAPE-1", child)], "parent: delegate")
        output = results[0]
        self.assertNotIn("was not started", output)
        self.assertIn("Not in this checkout:", seen["system"])
        self.assertIn("of the user's own uncommitted files", seen["system"])
        self.assertIn("partly integrated. Applied 1 path(s): notes.txt.", output)
        self.assertIn(f"Not written: {seen['target']}, one of the user's own uncommitted files", output)
        self.assertNotIn("you changed the same lines", output)
        self.assertEqual((root / "notes.txt").read_text(), "one\ntwo\n")
        self.assertEqual(digest(root / seen["target"]), seen["before"], "byte-for-byte unchanged")
        infos = [frame.get("message", "") for frame in h.of("info")]
        self.assertTrue(any("↳ isolated checkout:" in line and "untracked files left out" in line
                            for line in infos), infos)

    def test_too_much_tracked_change_is_said_plainly_to_the_model(self):
        h = self.make_repo()
        write(h.root, "billing.py", "x" * (100 * KB))
        with mock.patch.object(worktree, "_MAX_TASK_BYTES", 64 * KB):
            results = self.run_parent(h, [[ToolCall("t1", "task", {"description": "fix",
                                                                   "prompt": "SHAPE-2 fix"})],
                                          ("SHAPE-2", Recorder(lambda messages: []))],
                                      "parent: delegate")
        self.assertEqual(results[0], (
            "Sub-task 'fix' was not started because its isolated Git worktree could not be created: "
            "This project has 100 KB of uncommitted changes to tracked files, more than a helper's "
            "copy holds (64 KB). Commit some of it, or let the model do this itself. The parent "
            "checkout was left unchanged."))


if __name__ == "__main__":
    unittest.main()
