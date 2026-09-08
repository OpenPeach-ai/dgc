"""File operations for the explorer, with a snapshot-backed undo journal and two trash routes.

Every operation is synchronous and bounded, runs on the caller's thread, and reports through
:class:`OpResult`.  Directories that are too large for the pane are refused rather than half-done.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

from ..config import USER_HOME
from ..workspace import capture_file_state, restore_file_state

MAX_TREE_ENTRIES = 5000
MAX_TREE_BYTES = 512 * 1024 * 1024
MAX_UNDO_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_UNDO = 32
TRASH_RETENTION_S = 30 * 24 * 3600
DGC_TRASH = USER_HOME / "trash"


class OpError(Exception):
    pass


@dataclass
class OpResult:
    message: str
    changed: list[Path] = field(default_factory=list)


@dataclass
class UndoAction:
    label: str
    undo: object                     # callable returning a message
    created_at: float = field(default_factory=time.monotonic)


def _measure(path: Path) -> tuple[int, int]:
    """Count entries and bytes of a tree without following symlinks; refuses oversize trees."""
    entries, size = 0, 0
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise OpError(f"cannot read {path.name}: {exc.strerror or exc}") from None
    if not stat.S_ISDIR(info.st_mode):
        return 1, int(info.st_size)
    for root, dirs, files in os.walk(path):
        entries += len(dirs) + len(files)
        for name in files:
            try:
                size += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
        if entries > MAX_TREE_ENTRIES or size > MAX_TREE_BYTES:
            raise OpError(f"{path.name} is too large for the pane (over "
                          f"{MAX_TREE_ENTRIES} entries or {MAX_TREE_BYTES // (1024 * 1024)} MB)")
    return entries, size


def _fingerprint(path: Path) -> tuple:
    try:
        info = os.lstat(path)
    except OSError:
        return ()
    return (info.st_size, info.st_mtime_ns, stat.S_IFMT(info.st_mode))


def _unique(dest: Path) -> Path:
    """Return a non-existing sibling name (``name (2).ext``) for collisions."""
    if not dest.exists() and not dest.is_symlink():
        return dest
    stem, suffix = dest.stem, dest.suffix
    for index in range(2, 1000):
        candidate = dest.with_name(f"{stem} ({index}){suffix}")
        if not candidate.exists() and not candidate.is_symlink():
            return candidate
    raise OpError("too many name collisions")


def _remove(path: Path) -> None:
    if path.is_symlink() or not path.is_dir():
        path.unlink()
    else:
        shutil.rmtree(path)


def _copy(src: Path, dest: Path) -> None:
    if src.is_symlink():
        os.symlink(os.readlink(src), dest)
    elif src.is_dir():
        shutil.copytree(src, dest, symlinks=True)
    else:
        shutil.copy2(src, dest)


def validate_name(name: str) -> str:
    text = str(name or "").strip()
    if not text or text in (".", "..") or "\0" in text:
        raise OpError("enter a name")
    if "/" in text.rstrip("/") and any(part in ("", ".", "..") for part in text.rstrip("/").split("/")):
        raise OpError("names cannot contain '.' or '..' segments")
    return text


class Trash:
    """Move entries to DGC's private trash (default) or the OS trash."""

    def __init__(self, mode: str = "dgc", *, dgc_dir: Path | None = None, home: Path | None = None):
        self.mode = "os" if str(mode).lower() == "os" else "dgc"
        self.dgc_dir = Path(dgc_dir) if dgc_dir else DGC_TRASH
        self.home = Path(home) if home else Path.home()

    def _os_trash_dir(self) -> tuple[Path, Path] | None:
        if os.name != "posix":
            return None
        if hasattr(os, "uname") and os.uname().sysname == "Darwin":
            base = self.home / ".Trash"
            return base, base
        data_home = os.environ.get("XDG_DATA_HOME") or str(self.home / ".local" / "share")
        base = Path(data_home) / "Trash"
        return base / "files", base / "info"

    def send(self, path: Path) -> tuple[Path, str]:
        """Move ``path`` to the trash; return (new location, route used)."""
        if self.mode == "os":
            target = self._os_trash_dir()
            if target is not None:
                files_dir, info_dir = target
                try:
                    files_dir.mkdir(parents=True, exist_ok=True)
                    info_dir.mkdir(parents=True, exist_ok=True)
                    dest = _unique(files_dir / path.name)
                    if info_dir != files_dir:
                        info = info_dir / (dest.name + ".trashinfo")
                        info.write_text("[Trash Info]\nPath=" + quote(str(path.resolve(strict=False)))
                                        + "\nDeletionDate=" + time.strftime("%Y-%m-%dT%H:%M:%S") + "\n")
                    shutil.move(str(path), str(dest))
                    return dest, "os"
                except OSError:
                    pass  # fall back to DGC's own trash rather than fail the delete
        self.dgc_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.prune()
        stamp = f"{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
        bucket = None
        for index in range(1, 10000):
            candidate = self.dgc_dir / (stamp if index == 1 else f"{stamp}-{index}")
            try:
                candidate.mkdir(mode=0o700)
            except FileExistsError:
                continue
            bucket = candidate
            break
        if bucket is None:
            raise OSError("could not allocate a trash bucket")
        dest = bucket / path.name
        (bucket / "manifest.json").write_text(json.dumps(
            {"original": str(path), "deleted_at": time.time(), "name": path.name}))
        shutil.move(str(path), str(dest))
        return dest, "dgc"

    def prune(self, now: float | None = None) -> int:
        """Drop DGC-trash buckets older than the retention window."""
        moment = time.time() if now is None else now
        removed = 0
        try:
            buckets = list(self.dgc_dir.iterdir())
        except OSError:
            return 0
        for bucket in buckets:
            manifest = bucket / "manifest.json"
            try:
                deleted_at = float(json.loads(manifest.read_text()).get("deleted_at", 0))
            except (OSError, ValueError, TypeError):
                continue
            if moment - deleted_at > TRASH_RETENTION_S:
                try:
                    shutil.rmtree(bucket)
                    removed += 1
                except OSError:
                    pass
        return removed


class FileOps:
    """Operations plus the undo journal, all scoped by the pane's policy decisions."""

    def __init__(self, trash: Trash | None = None):
        self.trash = trash or Trash()
        self.undo_stack: list[UndoAction] = []

    def _push(self, label: str, undo) -> None:
        self.undo_stack.append(UndoAction(label, undo))
        del self.undo_stack[:-MAX_UNDO]

    # ---- create / rename ---------------------------------------------------------------------
    def create(self, cwd: Path, raw_name: str) -> OpResult:
        name = validate_name(raw_name)
        is_dir = name.endswith("/")
        target = cwd / name.rstrip("/")
        if target.exists() or target.is_symlink():
            raise OpError(f"{target.name} already exists")
        try:
            if is_dir:
                target.mkdir(parents=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with open(target, "x"):
                    pass
        except OSError as exc:
            raise OpError(f"cannot create {target.name}: {exc.strerror or exc}") from None
        mark = _fingerprint(target)

        def undo():
            if _fingerprint(target) != mark:
                return f"{target.name} changed since it was created; left in place"
            _remove(target)
            return f"removed {target.name}"
        self._push(f"create {target.name}", undo)
        return OpResult(f"created {'folder ' if is_dir else ''}{target.name}", [target])

    def rename(self, src: Path, raw_name: str) -> OpResult:
        name = validate_name(raw_name).rstrip("/")
        if "/" in name:
            raise OpError("a new name cannot contain '/'")
        dest = src.with_name(name)
        if dest == src:
            return OpResult("unchanged")
        if dest.exists() or dest.is_symlink():
            raise OpError(f"{name} already exists")
        try:
            os.rename(src, dest)
        except OSError as exc:
            raise OpError(f"cannot rename: {exc.strerror or exc}") from None

        def undo():
            if src.exists() or src.is_symlink():
                return f"{src.name} exists again; rename not undone"
            os.rename(dest, src)
            return f"renamed back to {src.name}"
        self._push(f"rename {src.name}", undo)
        return OpResult(f"renamed to {name}", [dest])

    # ---- copy / move -------------------------------------------------------------------------
    def copy(self, sources: list[Path], dest_dir: Path, *, overwrite: bool = False) -> OpResult:
        done: list[tuple[Path, tuple]] = []
        restores: list[tuple[Path, tuple]] = []
        for src in sources:
            _measure(src)
            dest = dest_dir / src.name
            if dest == src or (src.is_dir() and not src.is_symlink() and dest.is_relative_to(src)):
                raise OpError(f"cannot copy {src.name} into itself")
            if dest.exists() or dest.is_symlink():
                if overwrite:
                    restores.append((dest, self._snapshot(dest)))
                    _remove(dest)
                else:
                    dest = _unique(dest)
            try:
                _copy(src, dest)
            except OSError as exc:
                raise OpError(f"copy failed at {src.name}: {exc.strerror or exc}") from None
            done.append((dest, _fingerprint(dest)))

        def undo():
            kept = 0
            for path, mark in done:
                if _fingerprint(path) == mark:
                    _remove(path)
                else:
                    kept += 1
            for path, snap in restores:
                self._restore(path, snap)
            return f"removed {len(done) - kept} copied item(s)" + (f" · kept {kept} edited" if kept else "")
        self._push(f"copy {len(done)}", undo)
        return OpResult(f"copied {len(done)} item(s)", [p for p, _ in done])

    def move(self, sources: list[Path], dest_dir: Path, *, overwrite: bool = False) -> OpResult:
        moved: list[tuple[Path, Path]] = []
        restores: list[tuple[Path, tuple]] = []
        for src in sources:
            dest = dest_dir / src.name
            if dest == src:
                continue
            if src.is_dir() and not src.is_symlink() and dest.is_relative_to(src):
                raise OpError(f"cannot move {src.name} into itself")
            if dest.exists() or dest.is_symlink():
                if overwrite:
                    restores.append((dest, self._snapshot(dest)))
                    _remove(dest)
                else:
                    dest = _unique(dest)
            try:
                shutil.move(str(src), str(dest))
            except OSError as exc:
                raise OpError(f"move failed at {src.name}: {exc.strerror or exc}") from None
            moved.append((src, dest))

        def undo():
            back = 0
            for src, dest in reversed(moved):
                if not (src.exists() or src.is_symlink()) and (dest.exists() or dest.is_symlink()):
                    shutil.move(str(dest), str(src))
                    back += 1
            for path, snap in restores:
                self._restore(path, snap)
            return f"moved {back} item(s) back"
        self._push(f"move {len(moved)}", undo)
        return OpResult(f"moved {len(moved)} item(s)", [d for _, d in moved])

    # ---- trash / delete ----------------------------------------------------------------------
    def send_to_trash(self, paths: list[Path]) -> OpResult:
        moved: list[tuple[Path, Path]] = []
        route = "dgc"
        for path in paths:
            try:
                dest, route = self.trash.send(path)
            except OSError as exc:
                raise OpError(f"cannot trash {path.name}: {exc.strerror or exc}") from None
            moved.append((path, dest))

        def undo():
            back = 0
            for src, dest in reversed(moved):
                if not (src.exists() or src.is_symlink()) and (dest.exists() or dest.is_symlink()):
                    shutil.move(str(dest), str(src))
                    back += 1
                    bucket = dest.parent
                    try:
                        if (bucket.parent == self.trash.dgc_dir
                                and {p.name for p in bucket.iterdir()} <= {"manifest.json"}):
                            shutil.rmtree(bucket)
                    except OSError:
                        pass
            return f"restored {back} item(s) from the trash"
        self._push(f"trash {len(moved)}", undo)
        where = "OS trash" if route == "os" else "DGC trash"
        return OpResult(f"moved {len(moved)} item(s) to the {where} · u undoes", [])

    def delete(self, paths: list[Path]) -> OpResult:
        snapshots: list[tuple[Path, tuple | None]] = []
        for path in paths:
            snap = self._snapshot(path) if (path.is_symlink() or path.is_file()) else None
            _measure(path)
            try:
                _remove(path)
            except OSError as exc:
                raise OpError(f"cannot delete {path.name}: {exc.strerror or exc}") from None
            snapshots.append((path, snap))
        restorable = sum(1 for _, snap in snapshots if snap is not None)

        def undo():
            back = 0
            for path, snap in snapshots:
                if snap is not None and self._restore(path, snap):
                    back += 1
            lost = len(snapshots) - back
            return f"restored {back} file(s)" + (f" · {lost} could not be restored" if lost else "")
        self._push(f"delete {len(paths)}", undo)
        note = "" if restorable == len(paths) else " · folders are not restorable"
        return OpResult(f"deleted {len(paths)} item(s) permanently{note}", [])

    # ---- undo --------------------------------------------------------------------------------
    def undo(self) -> OpResult:
        if not self.undo_stack:
            raise OpError("nothing to undo")
        action = self.undo_stack.pop()
        try:
            return OpResult(f"undo {action.label}: {action.undo()}")
        except OSError as exc:
            raise OpError(f"undo {action.label} failed: {exc.strerror or exc}") from None

    # ---- snapshots ---------------------------------------------------------------------------
    @staticmethod
    def _snapshot(path: Path) -> tuple | None:
        try:
            return capture_file_state(path, maximum=MAX_UNDO_SNAPSHOT_BYTES)
        except (OSError, ValueError):
            return None

    @staticmethod
    def _restore(path: Path, snap: tuple | None) -> bool:
        if snap is None:
            return False
        kind, data, mode = snap
        try:
            return bool(restore_file_state(path, kind, data, mode))
        except (OSError, ValueError):
            return False
