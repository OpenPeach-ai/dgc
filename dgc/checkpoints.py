"""Checkpoints + rewind — snapshot the conversation length and the pre-edit content of any
file DGC touches, per user turn, so the user can rewind both the conversation and the code
to an earlier point (for /rewind).

File state is captured lazily: the first time a file is written/edited in a turn, its prior
bytes, mode, or symlink target (or absence) is saved. Rewinding to checkpoint K restores every file
touched at K-or-later to its earliest saved state, and truncates the conversation to K.

Project-root snapshots and content-addressed exact conversation prefixes are embedded in the
private session. External paths remain in-memory only: a later process must never acquire authority
to write outside the project merely by resuming a transcript.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .workspace import (
    canonicalize_trusted_os_alias,
    capture_file_state,
    restore_file_state,
)


CHECKPOINT_SCHEMA_VERSION = 1
_MAX_POINTS = 512
_MAX_FILES_PER_POINT = 4096
_MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
_MAX_MESSAGE_STORE_BYTES = 128 * 1024 * 1024
_MAX_MESSAGE_BLOBS = 100_000
_MAX_CHAIN_NODES = 200_000
_HEX = frozenset("0123456789abcdef")
# What a turn's Edited card lists (changes): rows sent, and how long counting lines may take.
_MAX_TURN_FILES = 500
_TURN_FILES_BUDGET_S = 3.0


@dataclass(frozen=True)
class _Snapshot:
    kind: str                         # missing | file | symlink
    data: bytes = b""
    mode: int = 0


@dataclass(frozen=True)
class WorkspaceSnapshot:
    """Exact ephemeral state for project files touched in the current turn.

    Unlike durable rewind points, this is never serialized and never carries external-path
    authority across a process boundary. Relative paths bind it to one canonical checkout root.
    """
    root: str
    files: tuple[tuple[str, _Snapshot], ...]


def _capture(path: Path, max_bytes: int | None = None) -> _Snapshot:
    kind, data, mode = capture_file_state(path, maximum=max_bytes)
    return _Snapshot(kind, data, mode)


def _why(exc: BaseException) -> str:
    """An OS error as a person reads it: "Permission denied", not "[Errno 13] ... '/abs/path'"."""
    text = getattr(exc, "strerror", None) or str(exc) or type(exc).__name__
    return str(text)[:200]


def _restore(path: Path, snapshot: _Snapshot) -> bool:
    if not isinstance(snapshot, _Snapshot):
        return False
    return restore_file_state(path, snapshot.kind, snapshot.data, snapshot.mode)


class CheckpointManager:
    def __init__(self, project_root=None, on_change: Callable[[], bool | None] | None = None):
        self.points: list[dict] = []   # {"msg_count", "preview", "files": {path: _Snapshot}}
        self.last_record_error = ""    # why the most recent record_file() refused, for the user
        # What DGC itself last left in each file, so a rewind can tell its own work from somebody
        # else's. Without this, _restore rewrites a file from a snapshot with no regard for what is
        # in it now: another chat's edit, or the user's own, is silently destroyed and nothing says
        # so. path -> sha256 of the bytes DGC left, or "" for a file DGC removed.
        self._left: dict[str, str] = {}
        # ...and the permission bits it left in a regular file, so a later `chmod` by somebody else is
        # a change too. Kept apart from the hash: sessions saved before this carry bytes-only hashes.
        self._left_modes: dict[str, int] = {}
        self.last_rewind_conflicts: list[str] = []   # paths that changed outside DGC, for the user
        # Why each of those is a conflict: changed (not what DGC left), between (changed after DGC
        # wrote it, and DGC wrote it again since), mode (its permissions changed), unreadable.
        self.last_rewind_reasons: dict[str, str] = {}
        self.last_rewind_error = ""                  # why the last rewind refused, when not a conflict
        self.last_rewind_left: list[str] = []        # files commands changed in the rewound turns
        self.project_root = (Path(project_root).resolve(strict=False) if project_root is not None
                             else None)
        self._on_change = on_change
        # A content-addressed linked sequence stores exact pre-turn conversation prefixes. Repeated
        # checkpoints add only the new messages, and old prefixes remain reconstructable after the
        # live model transcript is compacted.
        self._message_blobs: dict[str, object] = {}
        self._chains: dict[str, tuple[str, str]] = {}  # chain hash -> (previous chain, message hash)
        self._message_blob_bytes = 0
        self._snapshot_bytes_total = 0
        self._pending_rewind: tuple | None = None   # what rollback_rewind needs, while a rewind is unsaved
        # How many points open() has added in this process: the points a turn opened are the last
        # (opened now - opened when it began) ones, which is how its Edited card finds them.
        self.opened = 0

    @staticmethod
    def _hash(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def _on_disk_hash(path: Path) -> str | None:
        """sha256 of what is in the file now, "" when it is not there, None when unreadable.

        Unreadable is deliberately distinct from absent: a file DGC cannot read is one it cannot
        vouch for either, and the guard treats that as a conflict rather than assuming the best.
        """
        try:
            if not path.exists() and not path.is_symlink():
                return ""
            if path.is_symlink():
                return hashlib.sha256(os.readlink(str(path)).encode("utf-8", "surrogateescape")).hexdigest()
            return hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            return None

    @staticmethod
    def _on_disk_mode(path: Path) -> int | None:
        """The permission bits of a regular file now; None for anything else or when unreadable."""
        try:
            info = path.lstat()
        except OSError:
            return None
        return stat.S_IMODE(info.st_mode) if stat.S_ISREG(info.st_mode) else None

    def note_written(self, path: str) -> None:
        """Remember what DGC just left in a file, so a later rewind can recognise its own work."""
        try:
            resolved = Path(path)
        except (TypeError, ValueError):
            return
        digest = self._on_disk_hash(resolved)
        if digest is not None:
            self._left[str(resolved)] = digest
            mode = self._on_disk_mode(resolved)
            if mode is None:
                self._left_modes.pop(str(resolved), None)
            else:
                self._left_modes[str(resolved)] = mode

    def _changed_since_left(self, path: str, digest: str | None, mode: int | None) -> bool:
        """Positive evidence that `path` holds something other than what DGC last left there.

        No record, or a file DGC cannot read, is not evidence (see _rewind_conflicts)."""
        key = str(Path(path))
        left = self._left.get(key)
        if left is None or digest is None:
            return False
        if digest != left:
            return True
        left_mode = self._left_modes.get(key)
        return left_mode is not None and mode is not None and mode != left_mode

    @classmethod
    def _snapshot_digest(cls, snapshot: _Snapshot) -> str:
        return "" if snapshot.kind == "missing" else cls._hash(snapshot.data)

    @staticmethod
    def _mark_outside(point: dict, path: str, when: str) -> bool:
        """Mark a path whose earlier state, found as DGC came to write it again, is somebody else's.

        `when` is "before" (found as this point first captured it: the point's own before-state
        holds the change, so only a rewind past this point loses it) or "during" (found on a later
        write in the same point: even a rewind to this point loses it). Returns whether it changed."""
        marks = point.setdefault("outside", {})
        if marks.get(path) in (when, "during"):
            return False
        marks[path] = when
        return True

    def _missing_parents(self, path: str) -> list[str]:
        """The project folders above a missing file that do not exist yet, deepest first: the ones
        DGC's own write is about to create, which a rewind may remove again once they are empty."""
        relative = self._relative_project_path(path)
        if relative is None:
            return []
        made: list[str] = []
        parts = relative.split("/")[:-1]
        while parts:
            folder = self.project_root.joinpath(*parts)
            if folder.exists() or folder.is_symlink():
                break
            made.append("/".join(parts))
            parts = parts[:-1]
        return made

    def left_hash(self, path: str) -> str | None:
        """sha256 of what DGC itself last left in `path` -- one of this chat's file tools, or an
        integration -- "" for a file it removed, None when it has no record of the path."""
        try:
            return self._left.get(str(Path(path)))
        except (TypeError, ValueError):
            return None

    def _rewind_conflicts(self, restore: dict, between=()) -> list[str]:
        """Files whose current contents DGC cannot account for, with why in `last_rewind_reasons`.

        A file is accounted for when it holds exactly what DGC last left there (bytes, and the
        permission bits DGC left when it knows them), or already holds what the rewind would put back
        (so restoring it is a no-op). Anything else was written by another chat, another tool or the
        person, and a rewind must not quietly discard it. `between`: files somebody changed after DGC
        wrote them and before DGC wrote them again (the `outside` marks) -- what DGC left since then is
        theirs too, and the rewind would put back a state from before their change.
        """
        reasons: dict[str, str] = {}
        for path, (prior, _durable) in restore.items():
            p = Path(path)
            now = self._on_disk_hash(p)
            if now is None:
                reasons[path] = "unreadable"
                continue
            snapshot = (prior if isinstance(prior, _Snapshot) else
                        (_Snapshot("missing") if prior is None else
                         _Snapshot("file", str(prior).encode(), 0o644)))
            target = "" if snapshot.kind == "missing" else self._hash(snapshot.data)
            now_mode = self._on_disk_mode(p)
            target_mode = snapshot.mode if snapshot.kind == "file" else None
            if now == target and (target_mode is None or now_mode is None or now_mode == target_mode):
                continue                       # restoring it would change nothing
            key = str(p)
            left = self._left.get(key)
            if left is not None:
                if now != left:
                    reasons[path] = "changed"
                    continue
                left_mode = self._left_modes.get(key)
                if left_mode is not None and now_mode is not None and now_mode != left_mode:
                    reasons[path] = "mode"
                    continue
            if path in between:
                reasons[path] = "between"
            # Otherwise: no record of what DGC left here -- an older session, a resumed one, or an
            # edit made before this was tracked. Absence of evidence is not evidence: refusing on "I
            # cannot tell" would refuse EVERY rewind after a restart, which is far more common than a
            # concurrent edit and would break the feature for everyone. The guard only ever fires on
            # POSITIVE evidence that the file is not what DGC left.
        self.last_rewind_reasons = reasons
        return sorted(reasons)

    @staticmethod
    def _valid_hash(value) -> bool:
        return isinstance(value, str) and len(value) == 64 and all(c in _HEX for c in value)

    @classmethod
    def _snapshot_hash(cls, relative: str, snapshot: _Snapshot) -> str:
        header = json.dumps([relative, snapshot.kind, snapshot.mode], ensure_ascii=True,
                            separators=(",", ":")).encode("ascii")
        return cls._hash(header + b"\x00" + snapshot.data)

    @staticmethod
    def _message_bytes(message) -> tuple[bytes, object]:
        encoded = json.dumps(message, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), default=str).encode("utf-8")
        return encoded, json.loads(encoded)

    def _ingest_messages(self, messages: list | None) -> tuple[bool, str, int]:
        if messages is None:
            return False, "", 0
        if not isinstance(messages, list):
            raise ValueError("checkpoint conversation must be a list")
        head = ""
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in ("user", "assistant", "tool"):
                raise ValueError("checkpoint conversation contains an invalid message")
            encoded, normalized = self._message_bytes(message)
            message_hash = self._hash(encoded)
            if message_hash not in self._message_blobs:
                if (len(self._message_blobs) >= _MAX_MESSAGE_BLOBS
                        or self._message_blob_bytes + len(encoded) > _MAX_MESSAGE_STORE_BYTES):
                    raise ValueError("checkpoint conversation store exceeds its limit")
                self._message_blobs[message_hash] = normalized
                self._message_blob_bytes += len(encoded)
            chain_hash = self._hash(f"{head}:{message_hash}".encode("ascii"))
            if chain_hash not in self._chains:
                if len(self._chains) >= _MAX_CHAIN_NODES:
                    raise ValueError("checkpoint conversation chain exceeds its limit")
                self._chains[chain_hash] = (head, message_hash)
            head = chain_hash
        return True, head, len(messages)

    def _notify(self) -> bool:
        if self._on_change is None:
            return True
        if getattr(self, "_batched", 0):
            self._batch_dirty = True             # saved once, when the batch ends
            return True
        try:
            return self._on_change() is not False
        except Exception:
            return False

    @contextmanager
    def batch(self):
        """Save the session once for many records made after the fact (a command's changes),
        instead of once per file. Never use it around record_file: an edit tool's write may only
        start once its before-state is saved."""
        self._batched = getattr(self, "_batched", 0) + 1
        try:
            yield self
        finally:
            self._batched -= 1
            if not self._batched and getattr(self, "_batch_dirty", False):
                self._batch_dirty = False
                self._notify()

    def _lexical_project_path(self, path: str) -> str | None:
        if self.project_root is None:
            return None
        try:
            # Checkpoint roots are canonical storage identities. On Darwin, tempfile paths may
            # retain the protected /var spelling while project_root is /private/var. Normalize
            # only that OS-owned anchor alias here; descendant links are deliberately left for
            # _relative_project_path's parent-resolution confinement check.
            candidate = canonicalize_trusted_os_alias(
                Path(os.path.abspath(os.path.expanduser(path))))
            if os.path.commonpath((str(self.project_root), str(candidate))) != str(self.project_root):
                return None
            return candidate.relative_to(self.project_root).as_posix()
        except (OSError, RuntimeError, ValueError):
            return None

    def _relative_project_path(self, path: str) -> str | None:
        relative = self._lexical_project_path(path)
        if relative is None:
            return None
        try:
            candidate = self.project_root / relative
            # Never treat a path as safe while its parent escapes through a symlink. The final path
            # itself is deliberately not resolved so an exact symlink snapshot can be restored.
            parent = candidate.parent.resolve(strict=False)
            if os.path.commonpath((str(self.project_root), str(parent))) != str(self.project_root):
                return None
            return relative
        except (OSError, RuntimeError, ValueError):
            return None

    def _lexically_within_project(self, path: str) -> bool:
        """Check only lexical containment; symlink containment is checked separately."""
        return self._lexical_project_path(path) is not None

    def _project_path(self, relative: str) -> Path | None:
        if (self.project_root is None or not isinstance(relative, str) or not relative
                or "\x00" in relative):
            return None
        rel = Path(relative)
        if rel.is_absolute() or ".." in rel.parts or rel.as_posix() != relative or relative == ".":
            return None
        try:
            candidate = self.project_root.joinpath(*rel.parts)
            if self._lexical_project_path(str(candidate)) != relative:
                return None
            return candidate
        except (OSError, RuntimeError, ValueError):
            return None

    def open(self, msg_count: int, preview: str, messages: list | None = None) -> bool:
        if self._pending_rewind is not None:
            return False
        old_points = list(self.points)
        old_messages, old_chains = dict(self._message_blobs), dict(self._chains)
        old_message_bytes = self._message_blob_bytes
        old_snapshot_bytes = self._snapshot_bytes_total
        try:
            if len(self.points) >= _MAX_POINTS:
                self._snapshot_bytes_total -= sum(
                    len(snapshot.data) for snapshot in self.points[0]["files"].values()
                    if isinstance(snapshot, _Snapshot))
                del self.points[0]
                self._prune_conversations()
            exact, head, conversation_count = self._ingest_messages(messages)
            self.points.append({"msg_count": max(0, int(msg_count)),
                                "preview": (preview or "").strip()[:70] or "(turn)",
                                "files": {}, "conversation_head": head,
                                "conversation_count": conversation_count,
                                "conversation_exact": exact, "durable": False})
            if self._notify():
                self.opened += 1
                return True
        except (TypeError, ValueError):
            pass
        self.points = old_points
        self._message_blobs, self._chains = old_messages, old_chains
        self._message_blob_bytes = old_message_bytes
        self._snapshot_bytes_total = old_snapshot_bytes
        return False

    def record_file(self, path: str) -> bool:
        """Save a path's exact current state before editing it (once per file per turn).

        On failure `last_record_error` says which of the several reasons it was. One sentence for
        all of them left the user — and the model, which then routed its writes through the shell —
        with no way to tell a spent budget from a symlinked path from a session that would not save.
        """
        self.last_record_error = ""
        if self._pending_rewind is not None:
            self.last_record_error = "a rewind is being applied to this session"
            return False
        if not self.points:
            self.last_record_error = "this turn has no recovery point to record into"
            return False
        point = self.points[-1]
        files = point["files"]
        p = Path(path)
        if path in files:
            # DGC is about to write a file this turn already holds a before-state for. If it no longer
            # holds what DGC left there, somebody else wrote it in between (the person, while the turn
            # ran), and DGC's write is about to bury that: a rewind would lose it without a word.
            if (self._changed_since_left(path, self._on_disk_hash(p), self._on_disk_mode(p))
                    and self._mark_outside(point, path, "during")):
                self._notify()
            return True
        if len(files) >= _MAX_FILES_PER_POINT:
            self.last_record_error = (f"this turn has already captured {_MAX_FILES_PER_POINT} files")
            return False
        if self._lexically_within_project(path) and self._relative_project_path(path) is None:
            self.last_record_error = "the path leaves the project through a symlink"
            return False
        remaining = _MAX_SNAPSHOT_BYTES - self._snapshot_bytes_total
        if remaining <= 0:
            # Say the budget is spent rather than letting _capture report a "0-byte safety limit",
            # which reads like the file is at fault.
            self.last_record_error = (f"this session's {_MAX_SNAPSHOT_BYTES // (1024 * 1024)} MB "
                                      "snapshot budget is spent")
            return False
        try:
            snapshot = _capture(p, remaining)
        except (OSError, ValueError) as exc:
            detail = str(exc)[:200] or type(exc).__name__
            if "safety limit" in detail:
                # The limit it hit is what is LEFT of the session budget, not a property of the
                # file. Saying "file exceeds the 524288-byte safety limit" blamed the file for the
                # session's own accounting.
                detail = (f"only {remaining // 1024} KB of this session's "
                          f"{_MAX_SNAPSHOT_BYTES // (1024 * 1024)} MB snapshot budget is left, "
                          "and the file is larger than that")
            self.last_record_error = detail
            return False
        if self._snapshot_bytes_total + len(snapshot.data) > _MAX_SNAPSHOT_BYTES:
            self.last_record_error = (f"this session's {_MAX_SNAPSHOT_BYTES // (1024 * 1024)} MB "
                                      "snapshot budget is spent")
            return False
        made = self._missing_parents(path) if snapshot.kind == "missing" else []
        return self._keep(point, path, snapshot, made)

    def _keep(self, point: dict, path: str, snapshot: _Snapshot, made: list[str] = ()) -> bool:
        """Put a captured before-state into the point and save it; undone entirely if saving fails.

        A file DGC wrote in an earlier turn that no longer holds what DGC left there was changed by
        somebody else in between. This point's before-state keeps that change, but a rewind to an
        EARLIER point would put back the earlier state over it: the path is marked, and that rewind
        stops and names it."""
        files = point["files"]
        files[path] = snapshot
        self._snapshot_bytes_total += len(snapshot.data)
        old_mark = (point.get("outside") or {}).get(path)
        marked = self._changed_since_left(
            path, self._snapshot_digest(snapshot), snapshot.mode if snapshot.kind == "file" else None)
        if marked:
            self._mark_outside(point, path, "before")
        old_made = list(point.get("made_dirs") or [])
        if made:
            point["made_dirs"] = old_made + [folder for folder in made if folder not in old_made]
        if not self._notify():
            files.pop(path, None)
            self._snapshot_bytes_total -= len(snapshot.data)
            if marked:
                if old_mark is None:
                    point["outside"].pop(path, None)
                else:
                    point["outside"][path] = old_mark
            if made:
                point["made_dirs"] = old_made
            self.last_record_error = "the session could not be saved"
            return False
        return True

    def record_known(self, path: str, kind: str, data: bytes, mode: int) -> bool:
        """Save a path's state from BEFORE a change DGC learned of afterwards (once per file per turn).

        `record_file` reads the state off disk, which is right only before DGC's own write. A
        helper's shell command can change a file in the user's checkout with nothing watching; DGC
        finds it when the helper ends, and knows the exact state from before it when the helper's
        checkout copied that file (or Git's blob, for a file that was clean then). This puts that
        state where Undo finds it, under record_file's own limits. A path this turn has already
        captured keeps the earlier capture, which is older still.
        """
        self.last_record_error = ""
        if self._pending_rewind is not None:
            self.last_record_error = "a rewind is being applied to this session"
            return False
        if not self.points:
            self.last_record_error = "this turn has no recovery point to record into"
            return False
        if kind not in ("missing", "file", "symlink") or not isinstance(data, bytes):
            self.last_record_error = "the earlier state is not a file, a link or an absence"
            return False
        files = self.points[-1]["files"]
        if path in files:
            return True
        if len(files) >= _MAX_FILES_PER_POINT:
            self.last_record_error = (f"this turn has already captured {_MAX_FILES_PER_POINT} files")
            return False
        if self._lexically_within_project(path) and self._relative_project_path(path) is None:
            self.last_record_error = "the path leaves the project through a symlink"
            return False
        if self._snapshot_bytes_total + len(data) > _MAX_SNAPSHOT_BYTES:
            self.last_record_error = (f"this session's {_MAX_SNAPSHOT_BYTES // (1024 * 1024)} MB "
                                      "snapshot budget is spent")
            return False
        snapshot = _Snapshot(kind, data if kind != "missing" else b"",
                             0 if kind == "missing" else int(mode))
        return self._keep(self.points[-1], path, snapshot)

    def note_command_change(self, path: str, status: str) -> bool:
        """A file one of this chat's commands changed that Undo cannot put back.

        There is no exact earlier state for it (it had uncommitted changes, it is not tracked, Git
        converts it, or the turn's limits are spent), so the point cannot restore it. It is kept so the
        turn's Edited card can say so ("Changed by a command — Undo leaves it") and so can Undo.
        `status` is what it is now against before the command: new, modified or deleted."""
        if (self._pending_rewind is not None or not self.points
                or status not in ("new", "modified", "deleted")):
            return False
        point = self.points[-1]
        if path in point["files"]:
            return False                       # the point restores it: not one Undo leaves
        changed = point.setdefault("commands", {})
        prior = changed.get(path)
        if prior is None and len(changed) >= _MAX_FILES_PER_POINT:
            return False
        if prior == "new":
            if status == "deleted":
                changed.pop(path, None)        # made and removed again within the turn: nothing left
        elif prior == "deleted" and status != "deleted":
            changed[path] = "modified"
        else:
            changed[path] = status
        if changed.get(path) != prior:
            self._notify()
        return True

    def capture_touched_workspace(self) -> WorkspaceSnapshot | None:
        """Capture exact current state for project paths touched in the active turn.

        External paths may exist in the in-memory rewind point after one explicit approval, but
        automatic timeout recovery never inherits that authority. A project path whose parent now
        escapes through a symlink fails the entire capture instead of weakening the snapshot.
        """
        if self.project_root is None or not self.points or self._pending_rewind is not None:
            return None
        captured: dict[str, _Snapshot] = {}
        snapshot_bytes = 0
        for raw_path in sorted(self.points[-1]["files"]):
            relative = self._relative_project_path(raw_path)
            if relative is None:
                if self._lexically_within_project(raw_path):
                    return None
                continue                         # explicit external grants stay outside auto-recovery
            path = self._project_path(relative)
            if path is None:
                return None
            try:
                snapshot = _capture(path, _MAX_SNAPSHOT_BYTES - snapshot_bytes)
            except (OSError, ValueError):
                return None
            snapshot_bytes += len(snapshot.data)
            if snapshot_bytes > _MAX_SNAPSHOT_BYTES:
                return None
            captured[relative] = snapshot
        return WorkspaceSnapshot(str(self.project_root), tuple(sorted(captured.items())))

    def restore_workspace_snapshot(self, snapshot: WorkspaceSnapshot) -> bool:
        """Transactionally restore an exact ephemeral snapshot inside this checkout.

        Every target and rollback image is validated before the first write. Changed paths are
        restored atomically through ``_restore``; a later failure rolls earlier paths back to their
        state at entry. Unchanged files are not rewritten, preserving mtimes.
        """
        if (self.project_root is None or not isinstance(snapshot, WorkspaceSnapshot)
                or snapshot.root != str(self.project_root)
                or len(snapshot.files) > _MAX_FILES_PER_POINT):
            return False
        targets: list[tuple[str, Path, _Snapshot]] = []
        rollback: dict[str, _Snapshot] = {}
        snapshot_bytes = 0
        rollback_bytes = 0
        seen: set[str] = set()
        for relative, target in snapshot.files:
            if (not isinstance(relative, str) or relative in seen
                    or not isinstance(target, _Snapshot)
                    or target.kind not in ("missing", "file", "symlink")
                    or not isinstance(target.data, bytes)
                    or isinstance(target.mode, bool) or not isinstance(target.mode, int)
                    or target.mode < 0 or target.mode > 0o7777
                    or (target.kind == "missing" and target.data)):
                return False
            seen.add(relative)
            snapshot_bytes += len(target.data)
            if snapshot_bytes > _MAX_SNAPSHOT_BYTES:
                return False
            path = self._project_path(relative)
            if path is None or self._relative_project_path(str(path)) != relative:
                return False
            try:
                current = _capture(path, _MAX_SNAPSHOT_BYTES - rollback_bytes)
            except (OSError, ValueError):
                return False
            rollback_bytes += len(current.data)
            rollback[relative] = current
            if current != target:
                targets.append((relative, path, target))

        applied: list[tuple[str, Path]] = []
        for relative, path, target in targets:
            try:
                if not _restore(path, target):
                    raise OSError("workspace snapshot restore refused the target")
                applied.append((relative, path))
            except (OSError, ValueError):
                for changed_relative, changed_path in reversed(applied):
                    try:
                        _restore(changed_path, rollback[changed_relative])
                    except (OSError, ValueError):
                        pass
                return False
        # What DGC put back is DGC's own state again: the rewind guard must not take it for a change
        # somebody else made (nor DGC's next write to it for one made between its writes).
        for _relative, path in applied:
            self.note_written(str(path))
        return True

    def listing(self) -> list[tuple[int, str, int]]:
        """(index, preview, files-touched) for each checkpoint, oldest first."""
        return [(i, pt["preview"], len(pt["files"])) for i, pt in enumerate(self.points)]

    def changes(self, start: int, *, limit: int = _MAX_TURN_FILES,
                budget_s: float = _TURN_FILES_BUDGET_S, commands: bool = False) -> tuple[list[dict], int]:
        """What a rewind to point ``start`` would change, file by file: ``(files, total)``.

        Each file's state before (its earliest snapshot from ``start`` on, as rewind_state picks it)
        against what is on disk now, so it is every way a file changed: DGC's own edits, a helper's
        integrated file however the helper wrote it, a new file, a deleted one. A file recorded and
        then left exactly as it was is not a change, and is not listed. In the order the files were
        first recorded. Each row is ``{path, additions, deletions, counted, status}``: ``status`` is
        new, modified or deleted; ``counted`` is False where there is no honest line count (a new or
        deleted file, a binary or very large one, a symlink, a permissions-only change, or one the
        time budget did not reach). ``path`` is the recorded (absolute) path; a file outside the
        project also has ``outside: True`` (its before-state lives only in this process: a restart
        leaves Undo unable to put it back). ``total`` counts every changed file, which is exactly how
        many a rewind to ``start`` restores now; at most ``limit`` rows are returned.

        ``commands``: also list, after those, each file one of this chat's commands changed that the
        rewind cannot put back (note_command_change), as ``{..., counted: False, command: True}``;
        ``total`` then counts those too. The Edited card asks for them; Undo's counts never do.
        """
        if not (0 <= start < len(self.points)):
            return [], 0
        from .workspace_changes import MAX_DIFF_BYTES, _counts
        earliest: dict[str, object] = {}
        for point in list(self.points[start:]):
            # A copy: an Undo question can ask while a turn on another thread records into the point.
            for path, prior in list(point["files"].items()):
                earliest.setdefault(path, prior)
        rows: list[dict] = []
        total = 0
        deadline = time.monotonic() + max(0.0, budget_s)
        for path, prior in earliest.items():
            before = (prior if isinstance(prior, _Snapshot) else
                      (_Snapshot("missing") if prior is None else
                       _Snapshot("file", str(prior).encode(), 0o644)))
            try:
                # Never more than the snapshot plus one byte: a file larger than what it was is
                # changed whatever it holds, and reading it whole would only be to count lines that
                # are past the counting limit anyway.
                now = _capture(Path(path), max(len(before.data), MAX_DIFF_BYTES) + 1)
            except (OSError, ValueError):
                now = None                     # unreadable or grown past the cap: changed, uncounted
            if now is not None and now == before:
                continue                       # put back exactly as it was: nothing to restore
            total += 1
            if len(rows) >= limit:
                continue
            if before.kind == "missing":
                status = "new"
            elif now is not None and now.kind == "missing":
                status = "deleted"
            else:
                status = "modified"
            additions = deletions = 0
            counted = False
            if (status == "modified" and now is not None and before.kind == now.kind == "file"
                    and before.data != now.data and time.monotonic() < deadline
                    and len(before.data) <= MAX_DIFF_BYTES and len(now.data) <= MAX_DIFF_BYTES):
                try:
                    before.data.decode("utf-8")
                    now.data.decode("utf-8")
                    measured = _counts(before.data, now.data)
                except UnicodeDecodeError:
                    measured = {"binary": True, "counted": False}
                if measured.get("counted") and not measured.get("binary"):
                    additions, deletions, counted = measured["additions"], measured["deletions"], True
            row = {"path": path, "additions": additions, "deletions": deletions,
                   "counted": counted, "status": status}
            if self._lexical_project_path(path) is None:
                row["outside"] = True
            rows.append(row)
        if commands:
            for path, status in self._command_changes(start, earliest).items():
                total += 1
                if len(rows) < limit:
                    rows.append({"path": path, "additions": 0, "deletions": 0, "counted": False,
                                 "status": status, "command": True})
        return rows, total

    def _command_changes(self, start: int, restored) -> dict[str, str]:
        """What commands changed in points ``start`` on that a rewind there leaves as it is: path ->
        status, in the order first seen. A path the rewind restores (from any of those points) is not
        one of them."""
        out: dict[str, str] = {}
        for point in list(self.points[start:]):
            for path, status in list((point.get("commands") or {}).items()):
                if path in restored:
                    continue
                if path in out:
                    if out[path] == "new" and status == "deleted":
                        out.pop(path)
                    elif out[path] != "new":
                        out[path] = "modified" if out[path] == "deleted" and status != "deleted" else status
                else:
                    out[path] = status
        return out

    def discard_last_empty(self) -> bool:
        """Remove a speculative checkpoint only when it captured no filesystem state."""
        if self._pending_rewind is not None:
            return False
        if self.points and not self.points[-1]["files"] and not self.points[-1].get("commands"):
            old_messages, old_chains = dict(self._message_blobs), dict(self._chains)
            old_message_bytes = self._message_blob_bytes
            point = self.points.pop()
            self._prune_conversations()
            if self._notify():
                return True
            self.points.append(point)
            self._message_blobs, self._chains = old_messages, old_chains
            self._message_blob_bytes = old_message_bytes
        return False

    def _conversation(self, point: dict) -> list | None:
        if not point.get("conversation_exact"):
            return None
        head, rows, seen = str(point.get("conversation_head") or ""), [], set()
        while head:
            if head in seen or head not in self._chains or len(rows) >= _MAX_CHAIN_NODES:
                return None
            seen.add(head)
            previous, message_hash = self._chains[head]
            if message_hash not in self._message_blobs:
                return None
            # Return detached JSON data so later transcript mutation cannot corrupt the store.
            rows.append(json.loads(json.dumps(self._message_blobs[message_hash], default=str)))
            head = previous
        rows.reverse()
        return rows if len(rows) == int(point.get("conversation_count", -1)) else None

    def _prune_conversations(self) -> None:
        chains, messages = set(), set()
        for point in self.points:
            head, seen = str(point.get("conversation_head") or ""), set()
            while head and head not in seen and head in self._chains:
                seen.add(head); chains.add(head)
                previous, message_hash = self._chains[head]
                messages.add(message_hash); head = previous
        self._chains = {key: value for key, value in self._chains.items() if key in chains}
        self._message_blobs = {key: value for key, value in self._message_blobs.items()
                               if key in messages}
        self._message_blob_bytes = sum(
            len(self._message_bytes(value)[0]) for value in self._message_blobs.values())

    def _display(self, path: str) -> str:
        """A path as the person would recognise it: relative inside the project, else as is."""
        return self._lexical_project_path(path) or str(path)

    def rewind_state(self, idx: int, *, transactional: bool = False,
                     overwrite=None) -> tuple[int, int, list | None]:
        """Restore files to their state at checkpoint idx and drop later checkpoints.
        Returns (legacy message count, files restored, exact non-system conversation if captured).

        `overwrite`: paths the person agreed to lose changes in ("Undo anyway", after a refusal named
        them). The rewind still stops if any other file is a conflict, and names them all again.
        On a refusal, `last_rewind_conflicts` names the files somebody else changed (and
        `last_rewind_reasons` why), or `last_rewind_error` says what else stopped it."""
        self.last_rewind_error = ""
        self.last_rewind_left = []
        if self._pending_rewind is not None:
            self.last_rewind_error = "another Undo of this chat is still being applied"
            return (-1, 0, None)
        if not (0 <= idx < len(self.points)):
            self.last_rewind_error = "that recovery point is no longer there"
            return (-1, 0, None)
        old_points = list(self.points)
        old_messages, old_chains = dict(self._message_blobs), dict(self._chains)
        old_message_bytes = self._message_blob_bytes
        old_snapshot_bytes = self._snapshot_bytes_total
        conversation = self._conversation(self.points[idx])
        restore: dict[str, tuple[_Snapshot | str | None, bool]] = {}
        first: dict[str, int] = {}                   # the point each file's restored state comes from
        for offset, pt in enumerate(self.points[idx:]):   # earliest saved state per file wins
            for path, prior in pt["files"].items():
                if path not in restore:
                    restore[path] = (prior, bool(pt.get("durable")))
                    first[path] = idx + offset
        # A change somebody made between two of DGC's writes is lost when the rewind puts back a
        # state from before it: marked "during" in the point whose turn wrote over it, or "before"
        # in a LATER point than the one the restored state comes from (that point's own before-state
        # holds the change, so a rewind to it alone keeps it).
        between: set[str] = set()
        for offset, pt in enumerate(self.points[idx:]):
            for path, when in list((pt.get("outside") or {}).items()):
                origin = first.get(path)
                if origin is not None and (idx + offset > origin
                                           or (when == "during" and idx + offset >= origin)):
                    between.add(path)

        # Refuse rather than overwrite. A rewind is DGC undoing DGC; a file somebody else has
        # written since is not DGC's to take back, and the whole rewind stops so the person can
        # decide -- a partial rewind would leave the workspace in a state neither side chose.
        conflicts = self._rewind_conflicts(restore, between)
        self.last_rewind_conflicts = conflicts
        allowed = {str(path) for path in (overwrite or ())}
        if conflicts and not set(conflicts) <= allowed:
            return (-1, 0, None)

        # Validate every target and capture a rollback image before changing anything. In
        # particular, a project-relative path loaded from disk must not become an external write
        # merely because one of its parents was replaced with a symlink after resume.
        rollback: dict[str, _Snapshot] = {}
        rollback_bytes = 0
        for path, (_prior, durable) in restore.items():
            lexical_inside = self._lexically_within_project(path)
            if ((durable and not lexical_inside)
                    or (lexical_inside and self._relative_project_path(path) is None)):
                self.last_rewind_error = (f"{self._display(path)} now leads outside the project "
                                          "through a link, so DGC will not write it")
                return (-1, 0, None)
            try:
                rollback[path] = _capture(
                    Path(path), _MAX_SNAPSHOT_BYTES - rollback_bytes)
                rollback_bytes += len(rollback[path].data)
            except (OSError, ValueError) as exc:
                self.last_rewind_error = f"DGC could not read {self._display(path)}: {_why(exc)}"
                return (-1, 0, None)

        applied: list[str] = []
        for path, (prior, _durable) in restore.items():
            p = Path(path)
            try:
                # Accept legacy in-memory checkpoints created before exact byte/symlink snapshots.
                snapshot = (prior if isinstance(prior, _Snapshot) else
                            (_Snapshot("missing") if prior is None else
                             _Snapshot("file", str(prior).encode(), 0o644)))
                if rollback[path] == snapshot:
                    # Already exactly as it was (edited, then put back): nothing to restore, and
                    # not counted as restored -- the Edited card does not list it either, and
                    # "restored 3 files" after a question about 2 would be the two disagreeing.
                    continue
                if not _restore(p, snapshot):
                    raise OSError("something else is in its place")
                applied.append(path)
            except (OSError, ValueError) as exc:
                for changed in reversed(applied):
                    try:
                        _restore(Path(changed), rollback[changed])
                    except (OSError, ValueError):
                        pass
                self.last_rewind_error = (f"DGC could not write {self._display(path)}: {_why(exc)}"
                                          + ("; the files it had already put back are as they were"
                                             if applied else ""))
                return (-1, 0, None)
        # The folders DGC's own writes created in those turns, now empty again: removed, deepest
        # first. Only an empty folder goes (rmdir refuses anything else), never through a link.
        removed_dirs: list[Path] = []
        folders: list[str] = []
        for pt in self.points[idx:]:
            for folder in pt.get("made_dirs") or ():
                if isinstance(folder, str) and folder not in folders:
                    folders.append(folder)
        for folder in sorted(folders, key=lambda name: name.count("/"), reverse=True):
            target = self._project_path(folder)
            if target is None or self._relative_project_path(str(target)) != folder:
                continue
            try:
                if target.is_symlink() or not target.is_dir():
                    continue
                os.rmdir(target)
                removed_dirs.append(target)
            except OSError:
                continue
        self.last_rewind_left = list(self._command_changes(idx, restore))
        # What DGC put back is now what DGC last left there: a second Undo right after this one
        # must not take DGC's own restore for somebody else's edit.
        old_left = {path: (self._left.get(path), self._left_modes.get(path)) for path in applied}
        for path in applied:
            self.note_written(path)
        msg_count = self.points[idx]["msg_count"]
        del self.points[idx:]
        self._snapshot_bytes_total = sum(
            len(snapshot.data) for point in self.points for snapshot in point["files"].values()
            if isinstance(snapshot, _Snapshot))
        self._prune_conversations()
        self.last_rewind_conflicts = []
        if transactional:
            self._pending_rewind = (
                rollback, applied, old_points, old_messages, old_chains,
                old_message_bytes, old_snapshot_bytes, removed_dirs, old_left)
        return msg_count, len(applied), conversation

    def commit_rewind(self) -> bool:
        """Finalize a transactional rewind after the owning Agent durably saves its transcript."""
        if self._pending_rewind is None:
            return False
        self._pending_rewind = None
        return True

    def rollback_rewind(self) -> bool:
        """Undo a transactional rewind and retain its recovery point after persistence failure."""
        if self._pending_rewind is None:
            return False
        (rollback, applied, points, messages, chains, message_bytes, snapshot_bytes,
         removed_dirs, old_left) = self._pending_rewind
        restored = True
        for folder in reversed(removed_dirs):
            try:
                folder.mkdir(parents=True, exist_ok=True)
            except OSError:
                restored = False
        for path in reversed(applied):
            lexical_inside = self._lexically_within_project(path)
            if lexical_inside and self._relative_project_path(path) is None:
                restored = False
                continue
            try:
                restored = _restore(Path(path), rollback[path]) and restored
            except (OSError, ValueError):
                restored = False
        for path, (digest, mode) in old_left.items():
            if digest is None:
                self._left.pop(path, None)
            else:
                self._left[path] = digest
            if mode is None:
                self._left_modes.pop(path, None)
            else:
                self._left_modes[path] = mode
        self.points = points
        self._message_blobs, self._chains = messages, chains
        self._message_blob_bytes = message_bytes
        self._snapshot_bytes_total = snapshot_bytes
        self._pending_rewind = None
        return restored

    def rewind(self, idx: int, overwrite=None) -> tuple[int, int]:
        msg_count, restored, _conversation = self.rewind_state(idx, overwrite=overwrite)
        return msg_count, restored

    def _left_state(self) -> dict:
        """What DGC last left in each file, keyed by project-relative path.

        Carried in the session so a rewind after a restart can still tell DGC's own work from
        somebody else's. Project-relative and bounded, like every other durable field here: every
        path a live point holds (a rewind can only touch those), then the most recent 4,096 others
        (an earlier write that a later turn's capture compares with). "" is a file DGC removed.
        """
        held = {path for point in self.points for path in point["files"]}
        out: dict[str, str] = {}
        others: list[tuple[str, str]] = []
        for path, digest in list(self._left.items()):
            relative = self._lexical_project_path(path)
            if relative is None or not isinstance(digest, str) or not (digest == "" or len(digest) == 64):
                continue
            if path in held:
                out[relative] = digest
            else:
                others.append((relative, digest))
        for relative, digest in others[-_MAX_FILES_PER_POINT:]:
            out.setdefault(relative, digest)
        return out

    def _left_modes_state(self, left: dict) -> dict:
        """The permission bits DGC left, for the files `left` names (project-relative)."""
        out: dict[str, int] = {}
        for path, mode in list(self._left_modes.items()):
            relative = self._lexical_project_path(path)
            if relative in left and isinstance(mode, int) and 0 <= mode <= 0o7777:
                out[relative] = mode
        return out

    def _adopt_left_state(self, value, modes=None) -> None:
        if not isinstance(value, dict):
            return
        bound = sum(len(point["files"]) for point in self.points) + _MAX_FILES_PER_POINT
        for relative, digest in list(value.items())[:bound]:
            if not (isinstance(relative, str) and (digest == "" or self._valid_hash(digest))):
                continue
            resolved = self._project_path(relative)
            if resolved is not None:
                self._left[str(resolved)] = digest
                mode = modes.get(relative) if isinstance(modes, dict) else None
                if isinstance(mode, int) and not isinstance(mode, bool) and 0 <= mode <= 0o7777:
                    self._left_modes[str(resolved)] = mode

    def state(self) -> dict:
        """Validated JSON state embedded atomically in the private session transcript."""
        if len(self.points) > _MAX_POINTS:
            raise ValueError("too many durable checkpoints")
        if self._snapshot_bytes_total > _MAX_SNAPSHOT_BYTES:
            raise ValueError("checkpoint snapshots exceed the in-memory size limit")
        points = []
        snapshot_bytes = 0
        for point in self.points:
            files = {}
            for path, snapshot in point["files"].items():
                # A path that was safe when captured may currently be blocked by a parent symlink.
                # Keep its lexical project identity durable so the user can fix the parent and retry;
                # rewind_state revalidates symlink containment immediately before every restore.
                relative = self._lexical_project_path(path)
                if relative is None or not isinstance(snapshot, _Snapshot):
                    continue  # external grants are deliberately session-only
                snapshot_bytes += len(snapshot.data)
                if snapshot_bytes > _MAX_SNAPSHOT_BYTES:
                    raise ValueError("checkpoint snapshots exceed the durable size limit")
                files[relative] = {"kind": snapshot.kind,
                                   "data": base64.b64encode(snapshot.data).decode("ascii"),
                                   "mode": snapshot.mode,
                                   "sha256": self._snapshot_hash(relative, snapshot)}
            durable = {"msg_count": point["msg_count"], "preview": point["preview"],
                       "files": files,
                       "conversation_head": point.get("conversation_head", ""),
                       "conversation_count": point.get("conversation_count", 0),
                       "conversation_exact": bool(point.get("conversation_exact"))}
            # Somebody else's change found between two of DGC's writes (the rewind guard's evidence),
            # what commands changed that Undo leaves, and the folders DGC's writes created.
            outside = {}
            for path, when in (point.get("outside") or {}).items():
                relative = self._lexical_project_path(path)
                if relative in files and when in ("before", "during"):
                    outside[relative] = when
            commands = {}
            for path, status in (point.get("commands") or {}).items():
                relative = self._lexical_project_path(path)
                if relative is not None and status in ("new", "modified", "deleted"):
                    commands[relative] = status
            made = [folder for folder in (point.get("made_dirs") or ())
                    if isinstance(folder, str) and self._project_path(folder) is not None]
            if outside:
                durable["outside"] = outside
            if commands:
                durable["commands"] = commands
            if made:
                durable["made_dirs"] = made[:_MAX_FILES_PER_POINT]
            points.append(durable)

        self._prune_conversations()
        if len(self._message_blobs) > _MAX_MESSAGE_BLOBS or len(self._chains) > _MAX_CHAIN_NODES:
            raise ValueError("checkpoint conversation store exceeds the durable item limit")
        serialized_messages, message_bytes = {}, 0
        for key, value in self._message_blobs.items():
            encoded, normalized = self._message_bytes(value)
            message_bytes += len(encoded)
            serialized_messages[key] = normalized
        if message_bytes > _MAX_MESSAGE_STORE_BYTES:
            raise ValueError("checkpoint conversation store exceeds the durable size limit")
        return {"schema_version": CHECKPOINT_SCHEMA_VERSION,
                "project": str(self.project_root) if self.project_root is not None else None,
                "points": points,
                "messages": serialized_messages,
                # What DGC left in each file, so a rewind after a restart still knows its own work.
                "left": (left := self._left_state()),
                "left_modes": self._left_modes_state(left),
                "chains": {key: {"previous": value[0], "message": value[1]}
                           for key, value in self._chains.items()}}

    @classmethod
    def from_state(cls, state, project_root, *, on_change=None,
                   max_message_count: int | None = None) -> "CheckpointManager":
        """Load fail-closed durable state; malformed/tampered data yields no rewind points."""
        manager = cls(project_root, on_change)
        if not isinstance(state, dict) or state.get("schema_version") != CHECKPOINT_SCHEMA_VERSION:
            return manager
        try:
            recorded_project = state.get("project")
            if ((manager.project_root is None and recorded_project is not None)
                    or (manager.project_root is not None
                        and (not isinstance(recorded_project, str)
                             or Path(recorded_project).resolve(strict=False) != manager.project_root))):
                return manager
            raw_messages, raw_chains, raw_points = state["messages"], state["chains"], state["points"]
            if (not isinstance(raw_messages, dict) or len(raw_messages) > _MAX_MESSAGE_BLOBS
                    or not isinstance(raw_chains, dict) or len(raw_chains) > _MAX_CHAIN_NODES
                    or not isinstance(raw_points, list) or len(raw_points) > _MAX_POINTS):
                return manager
            message_bytes = 0
            for key, message in raw_messages.items():
                if (not isinstance(message, dict)
                        or message.get("role") not in ("user", "assistant", "tool")):
                    return cls(project_root, on_change)
                encoded, normalized = manager._message_bytes(message)
                message_bytes += len(encoded)
                if (not manager._valid_hash(key) or manager._hash(encoded) != key
                        or message_bytes > _MAX_MESSAGE_STORE_BYTES):
                    return cls(project_root, on_change)
                manager._message_blobs[key] = normalized
                manager._message_blob_bytes += len(encoded)
            for key, node in raw_chains.items():
                if not isinstance(node, dict):
                    return cls(project_root, on_change)
                previous, message_hash = node.get("previous", ""), node.get("message")
                if (not manager._valid_hash(key) or (previous and not manager._valid_hash(previous))
                        or not manager._valid_hash(message_hash)
                        or message_hash not in manager._message_blobs
                        or manager._hash(f"{previous}:{message_hash}".encode("ascii")) != key):
                    return cls(project_root, on_change)
                manager._chains[key] = (previous, message_hash)
            if any(previous and previous not in manager._chains
                   for previous, _message in manager._chains.values()):
                return cls(project_root, on_change)

            snapshot_bytes = 0
            for raw_point in raw_points:
                if not isinstance(raw_point, dict) or not isinstance(raw_point.get("files"), dict):
                    return cls(project_root, on_change)
                raw_msg_count = raw_point.get("msg_count", -1)
                raw_conversation_count = raw_point.get("conversation_count", 0)
                exact = raw_point.get("conversation_exact", False)
                head = raw_point.get("conversation_head", "")
                if (isinstance(raw_msg_count, bool) or not isinstance(raw_msg_count, int)
                        or isinstance(raw_conversation_count, bool)
                        or not isinstance(raw_conversation_count, int)
                        or not isinstance(exact, bool) or not isinstance(head, str)):
                    return cls(project_root, on_change)
                msg_count = raw_msg_count
                conversation_count = raw_conversation_count
                if (msg_count < 0 or conversation_count < 0
                        or (max_message_count is not None and msg_count > max_message_count
                            and not exact)
                        or (not exact and (head or conversation_count != 0))):
                    return cls(project_root, on_change)
                raw_files = raw_point["files"]
                if len(raw_files) > _MAX_FILES_PER_POINT:
                    return cls(project_root, on_change)
                files = {}
                for relative, raw_snapshot in raw_files.items():
                    path = manager._project_path(relative)
                    if path is None or not isinstance(raw_snapshot, dict):
                        return cls(project_root, on_change)
                    kind = raw_snapshot.get("kind")
                    if kind not in ("missing", "file", "symlink"):
                        return cls(project_root, on_change)
                    encoded_data = raw_snapshot.get("data", "")
                    remaining = _MAX_SNAPSHOT_BYTES - snapshot_bytes
                    if (not isinstance(encoded_data, str)
                            or len(encoded_data) > 4 * ((remaining + 2) // 3)):
                        return cls(project_root, on_change)
                    data = base64.b64decode(encoded_data, validate=True)
                    mode = raw_snapshot.get("mode", 0)
                    snapshot_bytes += len(data)
                    if (isinstance(mode, bool) or not isinstance(mode, int)
                            or snapshot_bytes > _MAX_SNAPSHOT_BYTES or mode < 0 or mode > 0o7777
                            or (kind == "missing" and data)):
                        return cls(project_root, on_change)
                    snapshot = _Snapshot(kind, data, mode)
                    digest = raw_snapshot.get("sha256")
                    if (not manager._valid_hash(digest)
                            or manager._snapshot_hash(relative, snapshot) != digest):
                        return cls(project_root, on_change)
                    files[str(path)] = snapshot
                    manager._snapshot_bytes_total += len(data)
                point = {"msg_count": msg_count,
                         "preview": str(raw_point.get("preview") or "(turn)")[:70],
                         "files": files,
                         "conversation_head": head,
                         "conversation_count": conversation_count,
                         "conversation_exact": exact,
                         "durable": True}
                extras = manager._point_extras(raw_point, files)
                if extras is None:
                    return cls(project_root, on_change)
                point.update(extras)
                if (point["conversation_head"] and point["conversation_head"] not in manager._chains
                        or (point["conversation_exact"] and manager._conversation(point) is None)):
                    return cls(project_root, on_change)
                manager.points.append(point)
            manager._prune_conversations()
            # What DGC left in each file, so a resumed session's rewind can still recognise its own
            # work rather than treating every file as unaccounted for.
            manager._adopt_left_state(state.get("left"), state.get("left_modes"))
            return manager
        except (KeyError, TypeError, ValueError, UnicodeError):
            return cls(project_root, on_change)

    def _point_extras(self, raw_point: dict, files: dict) -> dict | None:
        """A saved point's optional fields (`outside`, `commands`, `made_dirs`), checked like the
        rest: None when one is malformed, so the whole state is refused rather than half believed."""
        extras: dict = {}
        outside = raw_point.get("outside", {})
        commands = raw_point.get("commands", {})
        made = raw_point.get("made_dirs", [])
        if (not isinstance(outside, dict) or not isinstance(commands, dict) or not isinstance(made, list)
                or len(outside) > _MAX_FILES_PER_POINT or len(commands) > _MAX_FILES_PER_POINT
                or len(made) > _MAX_FILES_PER_POINT):
            return None
        marks = {}
        for relative, when in outside.items():
            path = self._project_path(relative) if isinstance(relative, str) else None
            if path is None or str(path) not in files or when not in ("before", "during"):
                return None
            marks[str(path)] = when
        changed = {}
        for relative, status in commands.items():
            path = self._project_path(relative) if isinstance(relative, str) else None
            if path is None or status not in ("new", "modified", "deleted"):
                return None
            changed[str(path)] = status
        folders = []
        for folder in made:
            if not isinstance(folder, str) or self._project_path(folder) is None:
                return None
            folders.append(folder)
        if marks:
            extras["outside"] = marks
        if changed:
            extras["commands"] = changed
        if folders:
            extras["made_dirs"] = folders
        return extras
