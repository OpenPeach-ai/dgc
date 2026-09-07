"""Private, bounded before/after evidence for changes observed during this chat's runs.

Workspace Git status is deliberately separate. Snapshots never enter model context. A saved
review is frozen at run completion, so later editor changes cannot silently alter its attribution.
Concurrent external writes during a run cannot be distinguished from tool writes.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path, PureWindowsPath
import stat
import threading
import time

from .git_review import Review, MAX_FILES, MAX_FILE_BYTES, MAX_READ_BYTES
from .workspace import capture_file_state, scan_directory_entries
from .workspace_changes import _counts, MAX_DIFF_BYTES

MAX_JOURNAL_BYTES = 4 * 1024 * 1024
MAX_CHANGED_FILES = 500
MAX_SEGMENTS = 16
_IGNORED = {".git", ".dgc", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache"}
_MISSING = {"kind": "missing", "hash": "", "mode": 0, "text": ""}
_LIMIT = "Some changes could not be recorded within the safe inspection limits. Inspect workspace changes separately."


def _path(value):
    return (isinstance(value, str) and 0 < len(value) <= 4096 and "\0" not in value
            and "\\" not in value and not Path(value).is_absolute() and not PureWindowsPath(value).drive
            and all(part not in ("", ".", "..", ".git") for part in value.split("/")))


def _names(root, deadline):
    try:
        review = Review(root, root, deadline=deadline)
    except ValueError as exc:
        if "not a git repository" not in str(exc).lower():
            raise
    else:
        names = set(review.entries())
        raw = review.git(["ls-files", "--others", "--exclude-standard", "-z", "--", review.scope])
        names.update(review.path(item) for item in raw.rstrip(b"\0").split(b"\0") if item)
        return [(review.repo / name).relative_to(root).as_posix() for name in sorted(names)
                if name not in review.skip_worktree]
    # Non-Git folders still support chat reviews. Descriptor-based enumeration refuses parent
    # symlink races, just like the exact-path reads below.
    pending, names, scanned = [root], [], 0
    while pending:
        if time.monotonic() >= deadline:
            raise ValueError("inspection timeout")
        parent = pending.pop()
        rows, truncated, count = scan_directory_entries(parent, maximum=MAX_FILES - scanned)
        scanned += count
        if truncated:
            raise ValueError("inspection entry limit")
        for name, info in rows:
            if name in _IGNORED:
                continue
            path = parent / name
            if stat.S_ISDIR(info.st_mode):
                pending.append(path)
            else:
                names.append(path.relative_to(root).as_posix())
    return names


def capture(root: Path) -> dict:
    """All-or-nothing enumeration, with explicitly skipped unreadable/oversize files."""
    result = {"files": {}, "skipped": set(), "complete": False}
    deadline, size = time.monotonic() + 5, 0
    try:
        names = _names(root, deadline)
        if len(names) > MAX_FILES:
            return result
        for name in names:
            if time.monotonic() >= deadline:
                return result
            if not _path(name):
                result["skipped"].add(name)
                continue
            try:
                kind, raw, mode = capture_file_state(root / name, maximum=MAX_FILE_BYTES)
                size += len(raw)
                if size > MAX_READ_BYTES:
                    return result
                if kind == "missing":
                    continue
                text = None
                if b"\0" not in raw and len(raw) <= MAX_DIFF_BYTES:
                    try:
                        text = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        pass
                result["files"][name] = {"kind": kind, "hash": hashlib.sha256(raw).hexdigest(),
                                         "mode": mode, "text": text}
            except (OSError, ValueError):
                result["skipped"].add(name)
        result["complete"] = True
    except (OSError, ValueError):
        pass
    return result


def _same(left, right):
    return all(left[key] == right[key] for key in ("kind", "hash", "mode"))


class ChatChanges:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.lock = threading.RLock()
        self.files: dict[str, list[dict]] = {}
        self.incomplete = False
        self._active_before = None

    def begin(self):
        before = capture(self.root)
        with self.lock:
            self._active_before = before
        return before

    def view(self):
        """An owner-only live projection; never mutate durable evidence from an inspection."""
        with self.lock:
            before = self._active_before
            if before is None:
                return self
            preview = self.from_state(self.root, self.state())
        preview.finish(before)
        return preview

    def finish(self, before):
        after = capture(self.root)
        with self.lock:
            if self._active_before is before:
                self._active_before = None
            if not before["complete"] or not after["complete"]:
                self.incomplete = True
                return
            skipped = before["skipped"] | after["skipped"]
            self.incomplete |= bool(skipped)
            for name in sorted(before["files"].keys() | after["files"].keys()):
                if name in skipped:
                    continue
                left, right = before["files"].get(name, _MISSING), after["files"].get(name, _MISSING)
                if _same(left, right):
                    continue
                old = self.files.get(name, [])
                segments = copy.deepcopy(old)
                # Merge only uninterrupted edits. An intervening manual edit starts a new pair,
                # excluding that external delta from both the line totals and the diff preview.
                if segments and _same(segments[-1]["after"], left):
                    segments[-1]["after"] = right
                    if _same(segments[-1]["before"], right):
                        segments.pop()
                else:
                    segments.append({"before": left, "after": right})
                if len(segments) > MAX_SEGMENTS or (name not in self.files and len(self.files) >= MAX_CHANGED_FILES):
                    self.incomplete = True
                    continue
                if segments:
                    self.files[name] = segments
                else:
                    self.files.pop(name, None)
                if len(json.dumps(self.files, ensure_ascii=True)) > MAX_JOURNAL_BYTES:
                    if old:
                        self.files[name] = old
                    else:
                        self.files.pop(name, None)
                    self.incomplete = True

    def state(self):
        with self.lock:
            return {"version": 1, "files": copy.deepcopy(self.files), "incomplete": self.incomplete}

    @classmethod
    def from_state(cls, root, value):
        result = cls(root)
        if value is None:  # Old sessions have no defensible chat baseline; never use Git HEAD.
            return result
        try:
            if (not isinstance(value, dict) or value.get("version") != 1
                    or not isinstance(value.get("files"), dict)
                    or len(value["files"]) > MAX_CHANGED_FILES
                    or len(json.dumps(value, ensure_ascii=True)) > MAX_JOURNAL_BYTES + 1024):
                raise ValueError("invalid chat review")
            for name, segments in value["files"].items():
                if not _path(name) or not isinstance(segments, list) or not 0 < len(segments) <= MAX_SEGMENTS:
                    raise ValueError("invalid chat review path")
                for pair in segments:
                    if not isinstance(pair, dict) or set(pair) != {"before", "after"}:
                        raise ValueError("invalid chat review pair")
                    for item in pair.values():
                        if (not isinstance(item, dict) or set(item) != set(_MISSING)
                                or item["kind"] not in ("file", "symlink", "missing")
                                or not isinstance(item["hash"], str)
                                or (item["kind"] != "missing" and (len(item["hash"]) != 64
                                    or any(c not in "0123456789abcdef" for c in item["hash"])))
                                or type(item["mode"]) is not int or not 0 <= item["mode"] <= 0o7777
                                or (item["text"] is not None and (not isinstance(item["text"], str)
                                    or len(item["text"].encode()) > MAX_DIFF_BYTES))):
                            raise ValueError("invalid chat review snapshot")
            result.files = copy.deepcopy(value["files"])
            result.incomplete = value.get("incomplete") is True
        except (ValueError, TypeError, UnicodeError):
            result.incomplete = True
        return result

    def report(self):
        with self.lock:
            files = []
            for name, segments in sorted(self.files.items()):
                additions = deletions = 0
                counted = True
                for pair in segments:
                    left, right = pair["before"]["text"], pair["after"]["text"]
                    if left is None or right is None:
                        counted = False
                        continue
                    counts = _counts(left.encode(), right.encode())
                    additions += counts["additions"]
                    deletions += counts["deletions"]
                    counted &= counts["counted"]
                files.append({"path": name, "additions": additions, "deletions": deletions,
                              "counted": counted, "binary": not counted, "staged": False,
                              "untracked": segments[0]["before"]["kind"] == "missing",
                              "deleted": segments[-1]["after"]["kind"] == "missing", "error": ""})
            return {"root": str(self.root), "files": files, "total": len(files),
                    "complete": not self.incomplete, "notices": [_LIMIT] if self.incomplete else []}

    def read(self, name):
        with self.lock:
            if not _path(name) or name not in self.files:
                raise ValueError("That file has no recorded change in this chat.")
            segments = self.files[name]
            sides = {}
            for side in ("before", "after"):
                texts = [pair[side]["text"] for pair in segments]
                if any(text is None for text in texts):
                    raise ValueError("Binary or oversized changes do not have a saved text preview.")
                text = texts[0] if len(texts) == 1 else "\n\n".join(
                    f"--- Recorded edit {index + 1} ---\n{value}" for index, value in enumerate(texts))
                if len(text.encode()) > MAX_DIFF_BYTES:
                    raise ValueError("This saved change is too large for a text preview.")
                sides[side] = text
            return {"root": str(self.root), "path": name, "kind": "chat", **sides}
