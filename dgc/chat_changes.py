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
    """`(names, bounded)` -- the workspace's files, and whether that list had to be cut short.

    `Review.entries()` REFUSES a repository with more than MAX_FILES entries ("more than 4096
    entries; narrow path and retry"), which is right for `/diff` -- a review the user asked for
    should say it cannot show everything rather than show a slice. It is wrong here: this is the
    chat's own change journal, and refusing meant a large repository recorded NOTHING, so Files and
    Changes were empty and a reloaded session had nothing to undo. Fall back to a bounded, sorted
    listing instead, and tell the caller it is bounded.
    """
    try:
        review = Review(root, root, deadline=deadline)
    except ValueError as exc:
        if "not a git repository" not in str(exc).lower():
            raise
    else:
        bounded = False
        try:
            names = set(review.entries())
        except ValueError as exc:
            if "entries" not in str(exc).lower():
                raise
            # Too large to enumerate whole. Select by what a chat change IS -- a file that differs
            # from HEAD -- rather than an arbitrary prefix. A sorted prefix was measured selecting
            # 4,096 `f*.txt` files and excluding the one file the turn actually edited, which is
            # the same empty change set by a longer route.
            raw_status = review.git(["status", "--porcelain=1", "-z", "--untracked-files=all",
                                     "--no-renames", "--", review.scope])
            names = set()
            for record in raw_status.rstrip(b"\0").split(b"\0"):
                if len(record) <= 3:
                    continue
                candidate = review.path(record[3:])
                # The same exclusion the untracked listing below applies. Without it a bounded
                # capture would pull DGC's own folder -- browser screenshots, locks -- and
                # dependency directories into the chat's change set, which the unbounded path
                # deliberately keeps out.
                if any(part in _IGNORED for part in str(candidate).split("/")):
                    continue
                names.add(candidate)
            bounded = True
        raw = review.git(["ls-files", "--others", "--exclude-standard", "-z", "--", review.scope])
        # Untracked files in DGC's own folder (browser screenshots, locks) or in dependency and
        # cache folders are not the chat's edits, exactly as the non-Git scan below treats them.
        names.update(name for name in (review.path(item) for item in raw.rstrip(b"\0").split(b"\0")
                                       if item)
                     if not any(part in _IGNORED for part in str(name).split("/")))
        # Names relative to the root as Git sees it: its real path (see git_review._within).
        base = review.repo / review.scope if review.scope != "." else review.repo
        listed = [(review.repo / name).relative_to(base).as_posix() for name in sorted(names)
                  if name not in review.skip_worktree]
        if len(listed) > MAX_FILES:
            listed, bounded = listed[:MAX_FILES], True
        return listed, bounded
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
    names.sort()                  # stable prefix when a bounded read has to stop early
    if len(names) > MAX_FILES:
        return names[:MAX_FILES], True
    return names, False


def _state(path: Path) -> dict | None:
    """One file's state in the shape `capture` records, or None when it cannot be read safely."""
    try:
        kind, raw, mode = capture_file_state(path, maximum=MAX_FILE_BYTES)
    except (OSError, ValueError):
        return None
    if kind == "missing":
        return dict(_MISSING)
    text = None
    if b"\0" not in raw and len(raw) <= MAX_DIFF_BYTES:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            pass
    return {"kind": kind, "hash": hashlib.sha256(raw).hexdigest(), "mode": mode, "text": text}


def capture(root: Path) -> dict:
    """Enumerate the workspace, keeping what was reachable and saying when that was not all.

    This used to be all-or-nothing: any deadline, entry cap or byte cap returned an EMPTY result
    with `complete: False`, and `finish()` then discarded the whole turn. Measured on a real
    4,090-name repository against `MAX_FILES = 4096` -- six files of headroom -- with a 5-second
    deadline for reading every file TWICE per turn. Once it tripped, `incomplete` was sticky, so
    Files and Changes were dead for the rest of the session and a reloaded session had nothing left
    to review or undo: `chat_changes` persisted as `{"files": [], "incomplete": true}`.

    Names arrive sorted, so a bounded read takes the same prefix on both sides of a turn and the two
    captures still overlap. `finish()` compares only names BOTH captures saw, which is what makes
    keeping a partial read sound rather than a source of invented creations and deletions.
    """
    result = {"files": {}, "skipped": set(), "complete": False, "selected": set()}
    deadline, size = time.monotonic() + 5, 0
    try:
        names, bounded = _names(root, deadline)
        result["selected"] = set(names)        # what was CONSIDERED, which a deletion leaves out of
        result["complete"] = not bounded       # `files`; provisional -- any bound below revokes it
        for name in names:
            if time.monotonic() >= deadline:
                result["complete"] = False
                break
            if not _path(name):
                result["skipped"].add(name)
                continue
            try:
                kind, raw, mode = capture_file_state(root / name, maximum=MAX_FILE_BYTES)
                size += len(raw)
                if size > MAX_READ_BYTES:
                    result["complete"] = False
                    break
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
    except (OSError, ValueError):
        result["complete"] = False
        pass
    return result


def _head_state(root: Path, name: str) -> dict:
    """What `name` held at HEAD, in the same shape `capture` records, or `_MISSING` if untracked."""
    try:
        review = Review(root, root, deadline=time.monotonic() + 5)
        raw = review.git(["cat-file", "blob", f"HEAD:{name}"])
    except (OSError, ValueError):
        return _MISSING
    if raw is None:
        return _MISSING
    text = None
    if b"\0" not in raw and len(raw) <= MAX_DIFF_BYTES:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            pass
    return {"kind": "file", "hash": hashlib.sha256(raw).hexdigest(), "mode": 0o644, "text": text}


def _same(left, right):
    return all(left[key] == right[key] for key in ("kind", "hash", "mode"))


class ChatChanges:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.lock = threading.RLock()
        self.files: dict[str, list[dict]] = {}
        self.incomplete = False
        self._active_before = None
        # This turn's own edits: what each file held just before one of DGC's file tools wrote it.
        self._touched: dict[str, dict] = {}

    def begin(self):
        before = capture(self.root)
        with self.lock:
            self._active_before = before
            self._touched = {}
        return before

    def touched(self, path) -> None:
        """A file tool is about to write `path`: remember what it holds now.

        The workspace scan is bounded -- a non-Git folder past 4,096 files records nothing, a
        repository with more changed files than that keeps a prefix, a slow tree stops at the
        deadline -- and an edit it does not reach was invisible: the bar said "Changes not
        recorded" while the model was editing files in front of you. DGC made these edits itself,
        so it never has to go looking for them. A shell command's edits still rely on the scan.
        """
        try:
            name = Path(path).resolve().relative_to(self.root).as_posix()
        except (OSError, ValueError):
            return                     # outside this chat's root: never this chat's change set
        if not _path(name):
            return
        with self.lock:
            if (self._active_before is None or name in self._touched
                    or len(self._touched) >= MAX_CHANGED_FILES):
                return
        state = _state(self.root / name)
        if state is not None:
            with self.lock:
                self._touched.setdefault(name, state)

    def view(self):
        """An owner-only live projection; never mutate durable evidence from an inspection."""
        with self.lock:
            before = self._active_before
            if before is None:
                return self
            preview = self.from_state(self.root, self.state())
            touched = dict(self._touched)
        preview.finish(before, touched=touched)
        return preview

    def finish(self, before, touched: dict | None = None):
        after = capture(self.root)
        with self.lock:
            own = dict(self._touched if touched is None else touched)
        # Read now, outside the lock, exactly as `capture` reads.
        own_after = {name: _state(self.root / name) for name in own}
        with self.lock:
            if self._active_before is before:
                self._active_before = None
                self._touched = {}
            bounded = not before["complete"] or not after["complete"]
            if bounded:
                self.incomplete = True
            skipped = before["skipped"] | after["skipped"]
            self.incomplete |= bool(skipped)
            # A bounded scan compares only what BOTH captures saw: a name one side missed is
            # UNKNOWN, not created or deleted, and inventing either would be worse than omitting it.
            # Returning here instead -- which is what this did -- threw away every real change in
            # the turn as well, which is how a large repository ended up with an empty change set.
            names = before["files"].keys() | after["files"].keys()
            # Every file this turn's tools wrote, wherever the scan stopped.
            names |= {name for name, state in own_after.items() if state is not None}
            if bounded:
                # A deleted file is in neither capture's `files` -- `capture` skips a missing path --
                # so a bounded turn that deleted something would record nothing at all. The selected
                # sets still name it. Unchanged names added here compare equal and drop out below.
                names |= before.get("selected", set()) | after.get("selected", set())
            for name in sorted(names):
                if name in skipped:
                    continue
                left, right = before["files"].get(name, _MISSING), after["files"].get(name, _MISSING)
                # A COMPLETE `before` lists every file, so a name absent from it did not exist when
                # the turn began -- whatever a shell command made of it before a tool wrote it.
                # Taking the tool's own record (made just before it wrote) there reported a file
                # `printf a > notes.txt` created as an edit of an existing 'a'.
                if (name not in before["files"] and not before["complete"]
                        and name not in before.get("selected", set())):
                    # A bounded `before` only considered what already differed from HEAD, so a
                    # file the turn changed from CLEAN is absent from it: its state at the start was
                    # HEAD's. Only where HEAD cannot tell (an untracked file, a folder outside git)
                    # is the tool's record the best there is.
                    left = _head_state(self.root, name)
                    if left == _MISSING and name in own:
                        left = own[name]
                if name in own and name not in after["files"] and own_after.get(name) is not None:
                    right = own_after[name]             # the scan stopped before it; the tool knows
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
