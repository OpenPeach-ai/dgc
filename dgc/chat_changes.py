"""Private, bounded before/after evidence for changes observed during this chat's runs.

Workspace Git status is deliberately separate. Snapshots never enter model context. A saved
review is frozen at run completion, so later editor changes cannot silently alter its attribution.
Concurrent external writes during a run cannot be distinguished from tool writes.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
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


def _folder_names(root, deadline):
    """`(names, bounded)` for a folder outside Git. Descriptor-based enumeration refuses parent
    symlink races, just like the exact-path reads below."""
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
    names.sort()
    if len(names) > MAX_FILES:
        return names[:MAX_FILES], True
    return names, False


def _listing(root, deadline) -> dict:
    """The workspace's names, and what Git already knows about them.

    `names` is what a capture considers and `bounded` says that list had to be cut short. In a Git
    repository it also carries `dirty` -- names Git reports as differing from HEAD or the index --
    and `clean`: every tracked file Git reports as unmodified, with the blob it holds. A capture
    that has to stop reading still knows what a clean file holds, so the files it never reached are
    not unknown. Measured on the session that reported "+1 −82173": a ~104 MiB tree against a
    64 MiB read budget, where everything past the cut-off was tracked and unmodified.

    `Review.entries()` REFUSES a repository with more than MAX_FILES entries ("more than 4096
    entries; narrow path and retry"), which is right for `/diff` -- a review the user asked for
    should say it cannot show everything rather than show a slice. It is wrong here: this is the
    chat's own change journal, and refusing meant a large repository recorded NOTHING, so Files and
    Changes were empty and a reloaded session had nothing to undo. Fall back to listing what
    `git status` names instead (`status_listing`), and tell the caller it is bounded.
    """
    out = {"names": [], "bounded": False, "dirty": set(), "clean": {}, "status_listing": False,
           "head": None, "prefix": ""}
    try:
        review = Review(root, root, deadline=deadline)
    except ValueError as exc:
        if "not a git repository" not in str(exc).lower():
            raise
        out["names"], out["bounded"] = _folder_names(root, deadline)
        return out
    # Names relative to the root as Git sees it: its real path (see git_review._within).
    base = review.repo / review.scope if review.scope != "." else review.repo
    out["prefix"] = "" if review.scope == "." else review.scope + "/"

    def relative(name):
        return (review.repo / name).relative_to(base).as_posix()

    def status(untracked, *, skip_ignored):
        raw = review.git(["status", "--porcelain=1", "-z", f"--untracked-files={untracked}",
                          "--no-renames", "--", review.scope])
        found = set()
        for record in raw.rstrip(b"\0").split(b"\0"):
            if len(record) <= 3:
                continue
            candidate = review.path(record[3:])
            if skip_ignored and any(part in _IGNORED for part in str(candidate).split("/")):
                continue
            found.add(candidate)
        return found

    entries = None
    try:
        entries = review.entries()
        names = set(entries)
    except ValueError as exc:
        if "entries" not in str(exc).lower():
            raise
        # Too large to enumerate whole. Select by what a chat change IS -- a file that differs
        # from HEAD -- rather than an arbitrary prefix. A sorted prefix was measured selecting
        # 4,096 `f*.txt` files and excluding the one file the turn actually edited, which is
        # the same empty change set by a longer route. DGC's own folder and dependency folders
        # stay out, exactly as the untracked listing below keeps them out.
        names = status("all", skip_ignored=True)
        out["bounded"] = out["status_listing"] = True
        try:
            out["head"] = review.commit("HEAD")
        except ValueError:
            pass                                        # no commit yet: nothing was tracked
    raw = review.git(["ls-files", "--others", "--exclude-standard", "-z", "--", review.scope])
    # Untracked files in DGC's own folder (browser screenshots, locks) or in dependency and
    # cache folders are not the chat's edits, exactly as the non-Git scan treats them.
    untracked = {name for name in (review.path(item) for item in raw.rstrip(b"\0").split(b"\0")
                                   if item)
                 if not any(part in _IGNORED for part in str(name).split("/"))}
    names.update(untracked)
    if entries is None:
        out["dirty"] = {relative(name) for name in names}
    else:
        try:
            dirty = status("no", skip_ignored=False)
        except ValueError:
            dirty = None                                # nothing vouched for: every file is read
        if dirty is not None:
            out["dirty"] = {relative(name) for name in dirty}
            out["clean"] = {relative(name): entry for name, entry in entries.items()
                            if name not in dirty and name not in review.skip_worktree
                            and entry[0] in ("100644", "100755", "120000")}
    listed = [relative(name) for name in sorted(names) if name not in review.skip_worktree]
    if len(listed) > MAX_FILES:
        listed, out["bounded"] = listed[:MAX_FILES], True
    out["names"] = listed
    return out


def _names(root, deadline):
    """`(names, bounded)` -- the workspace's files, and whether that list had to be cut short."""
    listing = _listing(root, deadline)
    return listing["names"], listing["bounded"]


def _record(kind: str, raw: bytes, mode: int) -> dict:
    """One file's state in the shape a journal stores."""
    if kind == "missing":
        return dict(_MISSING)
    text = None
    if b"\0" not in raw and len(raw) <= MAX_DIFF_BYTES:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            pass
    return {"kind": kind, "hash": hashlib.sha256(raw).hexdigest(), "mode": mode, "text": text}


def _state(path: Path) -> dict | None:
    """One file's state in the shape `capture` records, or None when it cannot be read safely."""
    try:
        kind, raw, mode = capture_file_state(path, maximum=MAX_FILE_BYTES)
    except (OSError, ValueError):
        return None
    return _record(kind, raw, mode)


def _reading_order(names, first, listing, also=()):
    """What a capture that may stop early reads first: the names it is told matter most (`first`:
    what this run's tools wrote, what the chat already changed), then what Git says differs, then
    `also` (what the other capture read), then the files Git knows nothing about, and last the ones
    Git vouches for unread. It used to be plain alphabetical, so the folders that sort last were
    the ones a long session never saw."""
    chosen = set(names)
    order, seen = [], set()
    for tier in (set(first), listing["dirty"], set(also)):
        picked = sorted((tier & chosen) - seen)
        order += picked
        seen.update(picked)
    clean = listing["clean"]
    return (order + [name for name in names if name not in seen and name not in clean]
            + [name for name in names if name not in seen and name in clean])


def capture(root: Path, first=(), also=()) -> dict:
    """Enumerate the workspace, keeping what was reachable and saying when that was not all.

    This used to be all-or-nothing: any deadline, entry cap or byte cap returned an EMPTY result
    with `complete: False`, and `finish()` then discarded the whole turn. Measured on a real
    4,090-name repository against `MAX_FILES = 4096` -- six files of headroom -- with a 5-second
    deadline for reading every file TWICE per turn.

    `selected` is every name considered and `read` every name actually checked -- read, or found
    missing. Only those are evidence. The two differ whenever the 64 MiB or 5-second budget stops
    the reads, and treating a listed-but-unread name as missing is what recorded 497 files still
    on disk as deleted. `clean` names Git vouches for without a read (see `_listing`); `modes`
    holds the file mode of each one the reads did not reach, which is all a snapshot of it lacks.
    `complete` means every listed name is known one way or the other.
    """
    result = {"files": {}, "read": set(), "skipped": set(), "complete": False, "whole": False,
              "selected": set(), "dirty": set(), "clean": {}, "modes": {}, "status_listing": False,
              "head": None, "prefix": ""}
    deadline, size = time.monotonic() + 5, 0
    try:
        listing = _listing(root, deadline)
        names = listing["names"]
        for key in ("dirty", "clean", "status_listing", "head", "prefix"):
            result[key] = listing[key]
        result["selected"] = set(names)
        result["whole"] = not listing["bounded"]
        for name in _reading_order(names, first, listing, also):
            if time.monotonic() >= deadline:
                break
            if not _path(name):
                result["skipped"].add(name)
                continue
            try:
                kind, raw, mode = capture_file_state(root / name, maximum=MAX_FILE_BYTES)
            except (OSError, ValueError):
                result["skipped"].add(name)
                continue
            size += len(raw)
            if size > MAX_READ_BYTES:
                break
            result["read"].add(name)
            if kind != "missing":
                result["files"][name] = _record(kind, raw, mode)
        for index, (name, entry) in enumerate(result["clean"].items()):
            if index % 256 == 0 and time.monotonic() >= deadline:
                break
            if name in result["read"] or not _path(name):
                continue
            try:
                info = os.lstat(root / name)
            except OSError:
                continue                                # gone since `git status`: not vouched for
            if entry[0] == "120000" and stat.S_ISLNK(info.st_mode):
                result["modes"][name] = 0o777           # as capture_file_state reports a link
            elif entry[0] != "120000" and stat.S_ISREG(info.st_mode):
                result["modes"][name] = stat.S_IMODE(info.st_mode)
        known = result["read"] | result["skipped"] | result["modes"].keys()
        result["complete"] = result["whole"] and all(name in known for name in names)
    except (OSError, ValueError):
        result["complete"] = False
    return result


def _unlisted(root: Path, names: set[str]) -> set[str]:
    """Which of `names` a complete capture leaves out whatever they hold: DGC's own and dependency
    folders, untracked files .gitignore excludes, skip-worktree entries. Their absence from a
    complete `before` says nothing about whether they existed. Two `ls-files` for the lot, not a
    pair of git processes per file."""
    out = {name for name in names if any(part in _IGNORED for part in name.split("/"))}
    rest = sorted(names - out)
    if not rest:
        return out
    try:
        review = Review(root, root, deadline=time.monotonic() + 5)
    except (OSError, ValueError):
        return out                                      # not Git: a complete scan lists the rest
    prefix = "" if review.scope == "." else review.scope + "/"
    by_relative = {prefix + name: name for name in rest}
    try:
        flags = review.git(["ls-files", "-v", "-z", "--", *by_relative])
    except (OSError, ValueError):
        flags = b""
    tracked = set()
    for record in flags.rstrip(b"\0").split(b"\0"):
        if len(record) > 2:
            path = os.fsdecode(record[2:])
            tracked.add(path)
            if record[:1] == b"S" and path in by_relative:
                out.add(by_relative[path])              # skip-worktree
    untracked = [path for path in by_relative if path not in tracked]
    if untracked:
        # check-ignore would say it directly, but refuses the literal pathspecs read-only git runs
        # with; ls-files lists the ignored ones among exactly these paths.
        try:
            ignored = review.git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z",
                                  "--", *untracked])
        except (OSError, ValueError):
            ignored = b""
        out.update(by_relative[os.fsdecode(path)] for path in ignored.rstrip(b"\0").split(b"\0")
                   if path and os.fsdecode(path) in by_relative)
    return out


def _same(left, right):
    return all(left[key] == right[key] for key in ("kind", "hash", "mode"))


def _gone(root: Path, name: str) -> bool:
    """True only when the file is really not there: `lstat` says it does not exist."""
    try:
        os.lstat(root / name)
    except (FileNotFoundError, NotADirectoryError):
        return True
    except OSError:
        return False
    return False


def _blob_id(data: bytes, like: str) -> str:
    algorithm = "sha256" if len(like) == 64 else "sha1"
    return hashlib.new(algorithm, b"blob %d\0" % len(data) + data).hexdigest()


class _Reads:
    """Reads `finish()` makes beyond the two captures, bounded like one capture (64 MiB, 5 s)."""

    def __init__(self, root: Path):
        self.root, self.deadline, self.size, self.review = root, time.monotonic() + 5, 0, None

    def _spent(self) -> bool:
        return self.size > MAX_READ_BYTES or time.monotonic() >= self.deadline

    def take(self, name):
        """`(state, raw)` of `name` on disk now, or `(None, None)` when it cannot be read."""
        if self._spent() or not _path(name):
            return None, None
        try:
            kind, raw, mode = capture_file_state(self.root / name, maximum=MAX_FILE_BYTES)
        except (OSError, ValueError):
            return None, None
        self.size += len(raw)
        if self._spent():
            return None, None
        return _record(kind, raw, mode), raw

    def _git(self, args):
        if self.review is None:
            self.review = Review(self.root, self.root, deadline=self.deadline)
        data = self.review.git(args, MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("blob exceeds the per-file limit")
        return data

    def _checkout(self, spec_args, raw_args):
        """A blob as a checkout holds it -- `core.autocrlf`, an `eol=` rule or a smudge filter
        change the bytes -- falling back to the raw blob, as worktree.py does."""
        try:
            return self._git(["cat-file", "--filters", *spec_args])
        except ValueError:
            return self._git(["cat-file", "blob", *raw_args])

    def blob(self, snapshot, name, right, raw):
        """What a file Git vouched for held at `snapshot`, which the reads did not reach."""
        mode, oid = snapshot["clean"][name]
        kind = "symlink" if mode == "120000" else "file"
        file_mode = snapshot["modes"][name]
        if right is not None and right["kind"] == kind:
            data = raw if raw is not None else (right["text"].encode("utf-8")
                                                if right["text"] is not None else None)
            if data is not None and _blob_id(data, oid) == oid:
                return {**right, "mode": file_mode}    # the other side holds that very blob
        if self._spent():
            return None
        try:
            data = (self._git(["cat-file", "blob", oid]) if kind == "symlink"
                    else self._checkout(["--path", snapshot["prefix"] + name, oid], [oid]))
        except (OSError, ValueError):
            return None
        self.size += len(data)
        return None if self._spent() else _record(kind, data, file_mode)

    def head(self, snapshot, name, right):
        """What a name a status-only listing left out held: it was clean, so HEAD's content at that
        capture. Not this moment's HEAD -- a commit during the run moves it."""
        if snapshot["head"] is None:
            return dict(_MISSING)                       # no commit yet, so nothing was tracked
        if self._spent():
            return None
        spec = f"{snapshot['head']}:{snapshot['prefix']}{name}"
        try:
            data = self._checkout([spec], [spec])
        except (OSError, ValueError):
            # Not in that commit, so untracked when the run began -- unless time ran out.
            return None if self._spent() else dict(_MISSING)
        self.size += len(data)
        if self._spent():
            return None
        mode = right["mode"] if right is not None and right["kind"] == "file" else 0o644
        return _record("file", data, mode)


def _compare(root: Path, before: dict, after: dict, own: dict, own_after: dict, unlisted: set):
    """`({name: (before, after)}, unknown)`: every name whose two states are both KNOWN and differ,
    and whether some name had to be left out because one of its states was not.

    A state is known when a capture read it, when Git vouched for it, or when a file tool recorded
    it. A name one capture saw and the other did not reach is UNKNOWN -- not created, not deleted --
    and inventing either is worse than leaving it out and saying the scan was partial.
    """
    reads = _Reads(root)
    skipped = before["skipped"] | after["skipped"]
    vouched_before, vouched_after = before["clean"], after["clean"]
    names = before["read"] | after["read"] | set(own_after)
    # A commit during the run, or a file that stopped (or started) being clean, changes what Git
    # vouches for even where neither capture read the file.
    names |= {name for name in vouched_before.keys() | vouched_after.keys()
              if vouched_before.get(name) != vouched_after.get(name)}
    steps, unknown = {}, False
    for name in sorted(names):
        if name in skipped or not _path(name):
            continue
        vouched = vouched_before.get(name)
        if (vouched is not None and vouched == vouched_after.get(name)
                and not (name in before["read"] and name in after["read"])):
            continue                                    # the same blob on both sides: unchanged
        if name in own:
            right, raw = own_after[name], None
        elif name in after["read"]:
            right, raw = after["files"].get(name, _MISSING), None
        elif name in after["selected"] and name not in vouched_after:
            right = raw = None                          # listed, never reached: unknown
        else:
            # Git vouches for a different blob than at the start, or the name is no longer listed
            # at all -- deleted, newly ignored, clean again in a status-only listing. Look.
            right, raw = reads.take(name)
        if right is not None and right["kind"] == "missing" and not _gone(root, name):
            right, raw = reads.take(name)               # never call a file deleted on a scan's word
        if right is None:
            unknown = True
            continue
        if name in before["read"]:
            left = before["files"].get(name, _MISSING)
        elif name in unlisted:
            left = own[name]                            # what the tool saw just before it wrote
        elif name in vouched_before and name in before["modes"]:
            left = reads.blob(before, name, right, raw)
        elif name not in before["selected"] and before["whole"]:
            # A WHOLE listing names every file it can, so such a name did not exist when the run
            # began -- whatever a shell command made of it before a tool wrote it. Taking the
            # tool's record there reported a file `printf a > notes.txt` created as an edit.
            left = dict(_MISSING)
        elif (name not in before["selected"] and before["status_listing"]
              and name not in before["dirty"]):
            # A status-only listing names only what differed from HEAD, so a file the run changed
            # from CLEAN is absent from it: HEAD held it. Where HEAD cannot tell (an untracked
            # file) the tool's record is the best there is.
            left = reads.head(before, name, right)
            if left is not None and left["kind"] == "missing" and name in own:
                left = own[name]
        else:
            left = own.get(name)                        # listed but never reached
        if left is None:
            unknown = True
            continue
        if not _same(left, right):
            steps[name] = (left, right)
    return steps, unknown


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
        with self.lock:
            recorded = set(self.files)
        before = capture(self.root, first=recorded)     # what the chat already changed, first
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
        with self.lock:
            own = dict(self._touched if touched is None else touched)
            recorded = set(self.files)
        # A name is compared only when BOTH sides are known, so the after-capture reads first what
        # this run's tools wrote and what the chat has already changed, then what Git says differs,
        # then what the before-capture read and Git could not vouch for.
        after = capture(self.root, first=set(own) | recorded,
                        also={name for name in before["read"] if name not in before["clean"]})
        # Every file this run's tools wrote, wherever the scan stopped. Read now, outside the lock,
        # exactly as `capture` reads.
        own_after = {name: (after["files"].get(name, dict(_MISSING)) if name in after["read"]
                            else _state(self.root / name)) for name in own}
        # A whole listing still never names some files -- one .gitignore excludes, DGC's own and
        # dependency folders, a skip-worktree entry -- so a tool-written one absent from it may well
        # have existed. Read as created, an edit of an existing .env showed every line as added and
        # an empty "before". (Git runs here, outside the lock, like the reads above.)
        unlisted = (_unlisted(self.root, {name for name in own if name not in before["selected"]})
                    if before["whole"] else set())
        steps, unknown = _compare(self.root, before, after, own, own_after, unlisted)
        with self.lock:
            if self._active_before is before:
                self._active_before = None
                self._touched = {}
            skipped = before["skipped"] | after["skipped"]
            if not before["complete"] or not after["complete"] or skipped or unknown:
                self.incomplete = True
            # This run's own edits claim room first, so the cap is never spent on side effects.
            for name in sorted(steps, key=lambda item: (item not in own, item)):
                left, right = steps[name]
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

    def repair(self) -> int:
        """Drop the deletions an older scan invented, so a journal saved before the fix reads true.

        A scan that stopped early used to record every name it listed but did not read as DELETED,
        and a later run that read the file and missed it again recorded the same step a second
        time. The session behind this held 497 such deletions of files still on disk -- 85 of them
        twice -- and the 500-file cap left room for 3 real edits. A deletion step is dropped when
        the file was back in exactly the state it was "deleted" from: on disk now, for the last
        step, or at the start of the next recorded step. Steps it split are joined again. A file
        really gone keeps its deletion, and a journal without the defect is left as it was. The
        journal stays partial: those old runs may still have missed changes.

        Returns how many steps were dropped. Disk reads are bounded like one capture.
        """
        with self.lock:
            files = copy.deepcopy(self.files)
        reads, now = _Reads(self.root), {}
        for name, segments in files.items():
            last = segments[-1]
            if (last["after"]["kind"] == "missing" and last["before"]["kind"] != "missing"
                    and not _gone(self.root, name)):
                state, _raw = reads.take(name)
                if state is not None:
                    now[name] = state
        repaired, dropped = {}, 0
        for name, segments in files.items():
            kept = []
            for index, pair in enumerate(segments):
                if pair["after"]["kind"] == "missing" and pair["before"]["kind"] != "missing":
                    later = segments[index + 1]["before"] if index + 1 < len(segments) else now.get(name)
                    if later is not None and _same(later, pair["before"]):
                        dropped += 1
                        continue
                if kept and _same(kept[-1]["after"], pair["before"]):
                    kept[-1] = {"before": kept[-1]["before"], "after": pair["after"]}
                    if _same(kept[-1]["before"], kept[-1]["after"]):
                        kept.pop()
                else:
                    kept.append(pair)
            if kept:
                repaired[name] = kept
        if not dropped:
            return 0
        with self.lock:
            if self.files != files:
                return 0                                # recorded meanwhile: leave it to the next load
            self.files = repaired
        return dropped

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
