"""Bounded Git review without running worktree filters, external diffs, or transports.

Git only enumerates the index/trees and reads stored blobs. Python reads worktree files through
the workspace boundary and compares their raw bytes. This deliberately does not run Git clean
filters or normalize checkout line endings. A review can narrow `path` when a limit is reached.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import time

from .workspace import WorkspaceBoundaryError, read_regular_bytes, resolve_path, stat_entry
from .worktree import _run_git

MAX_FILES = 4096
MAX_LIST_BYTES = 1024 * 1024
MAX_FILE_BYTES = 1024 * 1024
MAX_READ_BYTES = 64 * 1024 * 1024
MAX_OUTPUT = 24000
MAX_LINES = 6000
TIMEOUT = 20.0
_OID = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
_MODES = {"100644", "100755", "120000", "160000"}


def _label(value) -> str:
    return json.dumps(str(value), ensure_ascii=True)


class Review:
    def __init__(self, root: Path, target: Path, cancel=None, *, deadline=None):
        self.project, self.target, self.cancel = root, target, cancel
        self.cwd = target if target.is_dir() else target.parent
        self.deadline = min(time.monotonic() + TIMEOUT, deadline) if deadline is not None else time.monotonic() + TIMEOUT
        self.read_bytes = 0
        self.rows: list[str] = []
        self.output_size = 0
        self.changes = 0
        self.incomplete = False
        self.skip_worktree: set[str] = set()
        self.repo = Path(os.fsdecode(self.git(["rev-parse", "--show-toplevel"]))[:-1])
        # A project may be a subdirectory of a larger repository. All enumerations and file
        # reads remain scoped to the approved target, never the rest of that parent repository.
        self.scope = target.relative_to(self.repo).as_posix()
        self.cwd = self.repo

    def check(self):
        if self.cancel is not None and self.cancel.is_set():
            raise ValueError("review cancelled")
        if time.monotonic() >= self.deadline:
            raise ValueError("review timed out; narrow path and retry")

    def git(self, args: list[str], maximum=MAX_LIST_BYTES) -> bytes:
        self.check()
        result = _run_git(args, self.cwd, timeout=max(0.1, self.deadline - time.monotonic()),
                          max_stdout=maximum, text=False, read_only=True, cancelled=self.cancel)
        if result.returncode:
            raise ValueError(result.stderr.decode(errors="replace").strip()[:1000]
                             or "Git inspection failed")
        return result.stdout

    def commit(self, ref: str) -> str:
        if (not isinstance(ref, str) or not ref or len(ref) > 512 or ref.startswith("-")
                or any(ord(c) < 32 for c in ref)):
            raise ValueError("use a valid local branch, tag, or commit reference")
        oid = self.git(["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]).decode().strip()
        if not _OID.fullmatch(oid):
            raise ValueError("Git returned an invalid commit identity")
        return oid

    def path(self, raw: bytes) -> str:
        value = os.fsdecode(raw)
        parts = Path(value).parts
        if (not value or Path(value).is_absolute() or ".." in parts or ".git" in parts
                or (self.scope != "." and value != self.scope
                    and not value.startswith(self.scope + "/"))):
            raise ValueError("Git returned a path outside the selected scope")
        return value

    def entries(self, tree: str | None = None) -> dict:
        args = (["ls-tree", "-rz", "--full-tree", tree] if tree else ["ls-files", "--stage", "-t", "-z"])
        raw = self.git([*args, "--", self.scope])
        records = raw.rstrip(b"\0").split(b"\0") if raw else []
        if len(records) > MAX_FILES:
            raise ValueError(f"more than {MAX_FILES} entries; narrow path and retry")
        entries = {}
        for record in records:
            fields, raw_path = record.split(b"\t", 1)
            values = fields.decode("ascii").split(" ")
            tag = "" if tree else values.pop(0)
            mode, identity, stage = values
            if tree:
                identity, stage = stage, "0"  # tree records: mode type object-id
            if mode not in _MODES or not _OID.fullmatch(identity):
                raise ValueError("Git returned an unsupported tree/index entry")
            name = self.path(raw_path)
            if tag == "S":
                self.skip_worktree.add(name)
            entries[name] = (mode, identity) if stage == "0" else ("conflict", "")
        return entries

    def blob(self, entry) -> bytes:
        if entry is None:
            return b""
        raw = self.git(["cat-file", "blob", entry[1]], MAX_FILE_BYTES)
        self.account(raw)
        return raw

    def account(self, raw):
        self.read_bytes += len(raw)
        if self.read_bytes > MAX_READ_BYTES:
            raise ValueError("file read budget reached; narrow path and retry")

    def add(self, value: str):
        if self.output_size + len(value) + 1 > MAX_OUTPUT:
            raise ValueError("diff output limit reached; narrow path and retry")
        self.rows.append(value)
        self.output_size += len(value) + 1

    def diff(self, name, old, new, before=None, after=None):
        if old == new:
            return
        self.changes += 1
        path = self.repo / name
        label = _label(path.relative_to(self.project) if path.is_relative_to(self.project) else path)
        self.add(f"\nFile {label}: {old[0] if old else 'absent'} → {new[0] if new else 'absent'}")
        if any(entry and entry[0] not in ("100644", "100755") for entry in (old, new)):
            self.incomplete = True
            self.add("Symlink, submodule, or unmerged entry: content not followed; inspect separately.")
            return
        try:
            before = self.blob(old) if before is None else before
            after = self.blob(new) if after is None else after
        except (ValueError, OSError) as exc:
            self.incomplete = True
            self.add(f"Content unavailable: {str(exc)[:1000]}")
            return
        if b"\0" in before or b"\0" in after:
            self.add(f"Binary content changed ({len(before)} → {len(after)} bytes).")
            return
        left, right = before.decode(errors="replace").splitlines(), after.decode(errors="replace").splitlines()
        if before != after and left == right:
            self.add("Raw bytes changed but decoded lines match (line endings, final newline, or encoding).")
        if len(left) + len(right) > MAX_LINES:
            self.incomplete = True
            self.add(f"Text diff exceeds {MAX_LINES} combined lines; use read_file on the changed file.")
            return
        for line in difflib.unified_diff(left, right, fromfile=f"a/{label}", tofile=f"b/{label}", lineterm=""):
            self.check()
            if len(line) > 2000:
                self.incomplete = True
            self.add(line[:2000] + (" … [line truncated]" if len(line) > 2000 else ""))
        old_newline, new_newline = before.endswith(b"\n"), after.endswith(b"\n")
        if old_newline != new_newline:
            self.add(f"Final newline changed: {old_newline} → {new_newline}")

    def trees(self, old: dict, new: dict, title: str):
        self.add(title)
        for name in sorted(old.keys() | new.keys()):
            self.check()
            self.diff(name, old.get(name), new.get(name))

    def working(self, index: dict):
        self.add("Working tree vs index (raw bytes; checkout filters and line-ending conversion are not applied)")
        other = self.git(["ls-files", "--others", "--exclude-standard", "-z", "--", self.scope])
        names = set(index)
        names.update(self.path(raw) for raw in other.rstrip(b"\0").split(b"\0") if raw)
        if len(names) > MAX_FILES:
            raise ValueError(f"more than {MAX_FILES} files; narrow path and retry")
        for name in sorted(names):
            self.check()
            if name in self.skip_worktree:
                continue  # sparse/skip-worktree entries are not missing-file deletions
            old = index.get(name)
            if old and old[0] not in ("100644", "100755"):
                self.incomplete = True
                self.add(f"Skipped {_label(name)}: symlink, submodule, or unresolved conflict.")
                continue
            try:
                # Keep the lexical name frozen: resolve_path alone could follow a symlink inside
                # the workspace. read_regular_bytes checks every component without following it.
                path = self.repo / name
                if resolve_path(path, self.target if self.target.is_dir() else self.target.parent) != path:
                    raise WorkspaceBoundaryError("file is a symlink")
                read = read_regular_bytes(path, maximum=MAX_FILE_BYTES, missing_ok=True)
                raw = read[0] if read else b""
                self.account(raw)
                info = stat_entry(path, missing_ok=True)
                if read and (info is None or (info.st_ino, info.st_dev, info.st_ctime_ns) !=
                             (read[1].inode, read[1].device, read[1].changed_ns)):
                    raise WorkspaceBoundaryError("file changed while reading its mode")
                if not read and info is not None:
                    raise WorkspaceBoundaryError("file appeared while it was being inspected")
                algo = "sha256" if old and len(old[1]) == 64 else "sha1"
                oid = hashlib.new(algo, b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
                mode = "100755" if info and info.st_mode & 0o111 else "100644"
                new = (mode, oid) if read else None
                self.diff(name, old, new, after=raw)
            except (OSError, WorkspaceBoundaryError) as exc:
                self.incomplete = True
                self.add(f"Skipped {_label(name)}: {str(exc)[:500]}")


def review_diff(root: Path, target: Path, *, view="uncommitted", ref="", cancel=None) -> str:
    if view not in ("uncommitted", "working", "staged", "base", "commit"):
        return "error: view must be uncommitted, working, staged, base, or commit"
    review = None
    try:
        review = Review(root, target, cancel)
        if view in ("uncommitted", "working", "staged"):
            if ref:
                raise ValueError("ref is only supported for base or commit review")
            index = review.entries()
            if view != "working":
                # A symbolic HEAD with no matching ref is an unborn branch. Other read failures
                # must not be misreported as an empty repository.
                head = review.git(["rev-parse", "--revs-only", "HEAD"])
                identity = head.decode().strip()
                old = review.entries(identity) if _OID.fullmatch(identity) else {}
                review.trees(old, index, "Staged changes vs HEAD")
            if view != "staged":
                review.working(index)
        else:
            commit = review.commit(ref or "HEAD")
            if view == "base":
                if not ref:
                    raise ValueError("base review requires a local branch/tag reference")
                head = review.commit("HEAD")
                base = review.git(["merge-base", commit, head]).decode().strip()
                if not _OID.fullmatch(base):
                    raise ValueError("no unique merge base was found")
                review.trees(review.entries(base), review.entries(head), f"Branch changes: merge base {base} → HEAD {head}")
            else:
                raw = review.git(["cat-file", "commit", commit])
                parents = re.findall(rb"^parent ([0-9a-f]+)$", raw.split(b"\n\n", 1)[0], re.M)
                parent = parents[0].decode() if parents else ""
                if parent and not _OID.fullmatch(parent):
                    raise ValueError("invalid commit parent")
                review.trees(review.entries(parent) if parent else {}, review.entries(commit),
                             f"Commit {commit} vs {'first parent ' + parent if parent else 'empty tree'}")
        if not review.changes and not review.incomplete:
            review.add("No changes in the selected scope.")
        if review.incomplete:
            review.rows.append("Review is partial: some entries could not be inspected.")
    except (ValueError, OSError) as exc:
        if review is None:
            return "error: " + str(exc)[:1000]
        review.rows.append("Review is partial: " + str(exc)[:1000])
    return "\n".join(review.rows)
