"""Checkpoints + rewind — snapshot the conversation length and the pre-edit content of any
file DGC touches, per user turn, so the user can rewind both the conversation and the code
to an earlier point (for /rewind).

File state is captured lazily: the first time a file is written/edited in a turn, its prior
bytes, mode, or symlink target (or absence) is saved. Rewinding to checkpoint K restores every file
touched at K-or-later to its earliest saved state, and truncates the conversation to K.
"""
from __future__ import annotations

import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class _Snapshot:
    kind: str                         # missing | file | symlink
    data: bytes = b""
    mode: int = 0


def _capture(path: Path) -> _Snapshot:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return _Snapshot("missing")
    if stat.S_ISLNK(info.st_mode):
        return _Snapshot("symlink", os.fsencode(os.readlink(path)), 0o777)
    if not stat.S_ISREG(info.st_mode):
        raise OSError(f"checkpoint target is not a regular file: {path}")
    return _Snapshot("file", path.read_bytes(), stat.S_IMODE(info.st_mode))


def _restore(path: Path, snapshot: _Snapshot) -> bool:
    try:
        current = path.lstat()
    except FileNotFoundError:
        current = None
    if current is not None and stat.S_ISDIR(current.st_mode):
        return False
    if snapshot.kind == "missing":
        if current is not None:
            path.unlink()
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    if snapshot.kind == "symlink":
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        os.close(fd)
        tmp = Path(tmp_name)
        tmp.unlink()
        try:
            os.symlink(os.fsdecode(snapshot.data), tmp)
            os.replace(tmp, path)
            return True
        finally:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
    if snapshot.kind != "file":
        return False
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".dgc-rewind",
                                    dir=str(path.parent))
    tmp = Path(tmp_name)
    try:
        try:
            os.fchmod(fd, snapshot.mode)
        except (AttributeError, OSError):
            pass
        with os.fdopen(fd, "wb") as handle:
            handle.write(snapshot.data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        return True
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


class CheckpointManager:
    def __init__(self):
        self.points: list[dict] = []   # {"msg_count", "preview", "files": {path: _Snapshot}}

    def open(self, msg_count: int, preview: str) -> None:
        self.points.append({"msg_count": msg_count,
                            "preview": (preview or "").strip()[:70] or "(turn)",
                            "files": {}})

    def record_file(self, path: str) -> bool:
        """Save a path's exact current state before editing it (once per file per turn)."""
        if not self.points:
            return False
        files = self.points[-1]["files"]
        if path in files:
            return True
        p = Path(path)
        try:
            files[path] = _capture(p)
        except OSError:
            return False
        return True

    def listing(self) -> list[tuple[int, str, int]]:
        """(index, preview, files-touched) for each checkpoint, oldest first."""
        return [(i, pt["preview"], len(pt["files"])) for i, pt in enumerate(self.points)]

    def discard_last_empty(self) -> bool:
        """Remove a speculative checkpoint only when it captured no filesystem state."""
        if self.points and not self.points[-1]["files"]:
            self.points.pop()
            return True
        return False

    def rewind(self, idx: int) -> tuple[int, int]:
        """Restore files to their state at checkpoint idx and drop later checkpoints.
        Returns (message_count_to_truncate_to, files_restored)."""
        if not (0 <= idx < len(self.points)):
            return (-1, 0)
        restore: dict[str, _Snapshot | str | None] = {}
        for pt in self.points[idx:]:                 # earliest saved state per file wins
            for path, prior in pt["files"].items():
                restore.setdefault(path, prior)
        restored = 0
        for path, prior in restore.items():
            p = Path(path)
            try:
                # Accept legacy in-memory checkpoints created before exact byte/symlink snapshots.
                snapshot = (prior if isinstance(prior, _Snapshot) else
                            (_Snapshot("missing") if prior is None else
                             _Snapshot("file", str(prior).encode(), 0o644)))
                restored += int(_restore(p, snapshot))
            except OSError:
                pass
        msg_count = self.points[idx]["msg_count"]
        del self.points[idx:]
        return msg_count, restored
