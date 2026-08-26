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
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .workspace import capture_file_state, restore_file_state


CHECKPOINT_SCHEMA_VERSION = 1
_MAX_POINTS = 512
_MAX_FILES_PER_POINT = 4096
_MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
_MAX_MESSAGE_STORE_BYTES = 128 * 1024 * 1024
_MAX_MESSAGE_BLOBS = 100_000
_MAX_CHAIN_NODES = 200_000
_HEX = frozenset("0123456789abcdef")


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


def _restore(path: Path, snapshot: _Snapshot) -> bool:
    if not isinstance(snapshot, _Snapshot):
        return False
    return restore_file_state(path, snapshot.kind, snapshot.data, snapshot.mode)


class CheckpointManager:
    def __init__(self, project_root=None, on_change: Callable[[], bool | None] | None = None):
        self.points: list[dict] = []   # {"msg_count", "preview", "files": {path: _Snapshot}}
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
        self._pending_rewind: tuple[dict[str, _Snapshot], list[str], list[dict],
                                    dict[str, object], dict[str, tuple[str, str]], int, int] | None = None

    @staticmethod
    def _hash(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

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
        try:
            return self._on_change() is not False
        except Exception:
            return False

    def _lexical_project_path(self, path: str) -> str | None:
        if self.project_root is None:
            return None
        try:
            candidate = Path(os.path.abspath(os.path.expanduser(path)))
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
                return True
        except (TypeError, ValueError):
            pass
        self.points = old_points
        self._message_blobs, self._chains = old_messages, old_chains
        self._message_blob_bytes = old_message_bytes
        self._snapshot_bytes_total = old_snapshot_bytes
        return False

    def record_file(self, path: str) -> bool:
        """Save a path's exact current state before editing it (once per file per turn)."""
        if not self.points or self._pending_rewind is not None:
            return False
        files = self.points[-1]["files"]
        if path in files:
            return True
        if len(files) >= _MAX_FILES_PER_POINT:
            return False
        p = Path(path)
        if self._lexically_within_project(path) and self._relative_project_path(path) is None:
            return False
        try:
            snapshot = _capture(p, _MAX_SNAPSHOT_BYTES - self._snapshot_bytes_total)
        except (OSError, ValueError):
            return False
        if self._snapshot_bytes_total + len(snapshot.data) > _MAX_SNAPSHOT_BYTES:
            return False
        files[path] = snapshot
        self._snapshot_bytes_total += len(snapshot.data)
        if not self._notify():
            files.pop(path, None)
            self._snapshot_bytes_total -= len(snapshot.data)
            return False
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
        return True

    def listing(self) -> list[tuple[int, str, int]]:
        """(index, preview, files-touched) for each checkpoint, oldest first."""
        return [(i, pt["preview"], len(pt["files"])) for i, pt in enumerate(self.points)]

    def discard_last_empty(self) -> bool:
        """Remove a speculative checkpoint only when it captured no filesystem state."""
        if self._pending_rewind is not None:
            return False
        if self.points and not self.points[-1]["files"]:
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

    def rewind_state(self, idx: int, *, transactional: bool = False) -> tuple[int, int, list | None]:
        """Restore files to their state at checkpoint idx and drop later checkpoints.
        Returns (legacy message count, files restored, exact non-system conversation if captured)."""
        if self._pending_rewind is not None or not (0 <= idx < len(self.points)):
            return (-1, 0, None)
        old_points = list(self.points)
        old_messages, old_chains = dict(self._message_blobs), dict(self._chains)
        old_message_bytes = self._message_blob_bytes
        old_snapshot_bytes = self._snapshot_bytes_total
        conversation = self._conversation(self.points[idx])
        restore: dict[str, tuple[_Snapshot | str | None, bool]] = {}
        for pt in self.points[idx:]:                 # earliest saved state per file wins
            for path, prior in pt["files"].items():
                restore.setdefault(path, (prior, bool(pt.get("durable"))))

        # Validate every target and capture a rollback image before changing anything. In
        # particular, a project-relative path loaded from disk must not become an external write
        # merely because one of its parents was replaced with a symlink after resume.
        rollback: dict[str, _Snapshot] = {}
        rollback_bytes = 0
        for path, (_prior, durable) in restore.items():
            lexical_inside = self._lexically_within_project(path)
            if ((durable and not lexical_inside)
                    or (lexical_inside and self._relative_project_path(path) is None)):
                return (-1, 0, None)
            try:
                rollback[path] = _capture(
                    Path(path), _MAX_SNAPSHOT_BYTES - rollback_bytes)
                rollback_bytes += len(rollback[path].data)
            except (OSError, ValueError):
                return (-1, 0, None)

        applied: list[str] = []
        for path, (prior, _durable) in restore.items():
            p = Path(path)
            try:
                # Accept legacy in-memory checkpoints created before exact byte/symlink snapshots.
                snapshot = (prior if isinstance(prior, _Snapshot) else
                            (_Snapshot("missing") if prior is None else
                             _Snapshot("file", str(prior).encode(), 0o644)))
                if not _restore(p, snapshot):
                    raise OSError("checkpoint restore refused the target")
                applied.append(path)
            except (OSError, ValueError):
                for changed in reversed(applied):
                    try:
                        _restore(Path(changed), rollback[changed])
                    except (OSError, ValueError):
                        pass
                return (-1, 0, None)
        msg_count = self.points[idx]["msg_count"]
        del self.points[idx:]
        self._snapshot_bytes_total = sum(
            len(snapshot.data) for point in self.points for snapshot in point["files"].values()
            if isinstance(snapshot, _Snapshot))
        self._prune_conversations()
        if transactional:
            self._pending_rewind = (
                rollback, applied, old_points, old_messages, old_chains,
                old_message_bytes, old_snapshot_bytes)
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
        rollback, applied, points, messages, chains, message_bytes, snapshot_bytes = (
            self._pending_rewind)
        restored = True
        for path in reversed(applied):
            lexical_inside = self._lexically_within_project(path)
            if lexical_inside and self._relative_project_path(path) is None:
                restored = False
                continue
            try:
                restored = _restore(Path(path), rollback[path]) and restored
            except (OSError, ValueError):
                restored = False
        self.points = points
        self._message_blobs, self._chains = messages, chains
        self._message_blob_bytes = message_bytes
        self._snapshot_bytes_total = snapshot_bytes
        self._pending_rewind = None
        return restored

    def rewind(self, idx: int) -> tuple[int, int]:
        msg_count, restored, _conversation = self.rewind_state(idx)
        return msg_count, restored

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
            points.append({"msg_count": point["msg_count"], "preview": point["preview"],
                           "files": files,
                           "conversation_head": point.get("conversation_head", ""),
                           "conversation_count": point.get("conversation_count", 0),
                           "conversation_exact": bool(point.get("conversation_exact"))})

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
                if (point["conversation_head"] and point["conversation_head"] not in manager._chains
                        or (point["conversation_exact"] and manager._conversation(point) is None)):
                    return cls(project_root, on_change)
                manager.points.append(point)
            manager._prune_conversations()
            return manager
        except (KeyError, TypeError, ValueError, UnicodeError):
            return cls(project_root, on_change)
