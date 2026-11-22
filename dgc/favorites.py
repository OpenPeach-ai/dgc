"""Favorites in the Library: the items a person starred, one list for every kind.

Anything the Library lists can be a Favorite: an artifact, a ChatDGC widget, a chart a reply drew, an image, a video, a
chat's or a space's file, and something attached in a Work session. Each of those lives in a store of its own (the
artifact store, ChatDGC's chats, the image and video lists, the Work sessions), so the star is not kept in any one of
them: it is kept here, once, by the item's own identity, which is its kind and the id or path the Library already lists
it by. Nothing else of the item is written: never a title, a prompt or a file's content.

The list is one small file in DGC's home (``~/.dgc/library/favorites.json``), read from disk every time it is asked
for, so every window, a reload and another DGC process see the same favorites. A write holds one lock (flock on
``.favorites.lock``; the kernel drops it if the holder dies) and replaces the file whole.

An id that is not one of its kind's is refused (``invalid_favorite``). An artifact, an image and a video are also
looked up where DGC keeps them, and refused when they are not there (``unknown_favorite``); the chat kinds and a Work
attachment are named by the editor only from what DGC listed for it. Taking a star off needs only a well-formed id, so
a favorite whose item has since gone can always be cleared.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import workspace
from .config import dgc_home

# The most favorites kept: far more than a person stars by hand, and a bound on the file.
MOST = 5000
MAX_PATH = 4096

_HEX16, _HEX32 = "[a-f0-9]{16}", "[a-f0-9]{32}"
# Each kind's id, as the Library lists it. An image and a video are their file's whole path (checked below).
_SHAPES = {
    "artifact": re.compile(rf"ar_{_HEX16}\Z"),
    "widget": re.compile(rf"wg_{_HEX16}\Z"),
    "chart": re.compile(rf"chat_{_HEX32}:msg_{_HEX32}:\d{{1,4}}\Z"),
    "file": re.compile(rf"att_{_HEX32}\Z"),
    "workfile": re.compile(rf"wa_{_HEX16}\Z"),
}
KINDS = (*_SHAPES, "image", "video")

_thread_lock = threading.RLock()


class FavoriteError(Exception):
    """Why a favorite was not set: ``reason`` is a word for the editor, the message is for a person."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def path() -> Path:
    return dgc_home() / "library" / "favorites.json"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _well_formed(kind, ident) -> bool:
    if not isinstance(kind, str) or not isinstance(ident, str) or kind not in KINDS:
        return False
    if kind in _SHAPES:
        return bool(_SHAPES[kind].match(ident))
    # A file's path: whole, of a sane length, with nothing a path never holds.
    return (0 < len(ident) <= MAX_PATH and not re.search(r"[\x00-\x1f]", ident)
            and (ident.startswith("/") or bool(re.match(r"[A-Za-z]:[\\/]", ident)) or ident.startswith("\\\\")))


def _listed(folder: Path, ident: str) -> bool:
    """Is this path one of the rows of a made-things list (images, videos), with its file still there?"""
    try:
        lines = (folder / "library.jsonl").read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    for line in lines:
        if ident not in line and json.dumps(ident)[1:-1] not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("path") == ident:
            return Path(ident).is_file()
    return False


def _known(kind: str, ident: str) -> bool:
    """Is the item where DGC keeps its kind? Only the kinds this module can look up say no."""
    if kind == "artifact":
        from . import artifact_store
        return artifact_store.store().exists(ident)
    if kind == "image":
        from . import images
        return _listed(images.directory(), ident)
    if kind == "video":
        from . import videos
        return _listed(videos.directory(), ident)
    return True


@contextlib.contextmanager
def _lock():
    """One writer at a time across every DGC on this computer, and across this process's threads."""
    with _thread_lock:
        try:
            import fcntl
        except ImportError:
            yield
            return
        folder = path().parent
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(str(folder / ".favorites.lock"), os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0), 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)


def listing() -> list[dict]:
    """Every favorite, in the order they were starred: ``[{kind, id, at}]``. Read from disk now. A file that cannot be
    read, or a row that is not a favorite, is no favorite; nothing here raises."""
    try:
        data = json.loads(path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows, seen = [], set()
    for row in (data.get("items") if isinstance(data, dict) else None) or []:
        if not isinstance(row, dict) or not _well_formed(row.get("kind"), row.get("id")):
            continue
        key = (row["kind"], row["id"])
        if key in seen:
            continue
        seen.add(key)
        at = row.get("at")
        rows.append({"kind": row["kind"], "id": row["id"], "at": at[:40] if isinstance(at, str) else ""})
        if len(rows) >= MOST:
            break
    return rows


def mark(kind, ident, on: bool) -> list[dict]:
    """Star an item (``on``) or take its star off; the whole list afterwards. Raises FavoriteError."""
    if not _well_formed(kind, ident):
        raise FavoriteError("invalid_favorite", "That isn't something in the Library.")
    if on and not _known(kind, ident):
        raise FavoriteError("unknown_favorite", "That item isn't in the Library any more.")
    with _lock():
        rows = listing()
        there = any(row["kind"] == kind and row["id"] == ident for row in rows)
        if bool(on) == there:
            return rows
        if on:
            if len(rows) >= MOST:
                raise FavoriteError("too_many_favorites",
                                    f"The Library keeps up to {MOST} favorites. Take a star off something first.")
            rows.append({"kind": kind, "id": ident, "at": _now()})
        else:
            rows = [row for row in rows if not (row["kind"] == kind and row["id"] == ident)]
        target = path()
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        workspace.atomic_write_bytes(target, json.dumps({"version": 1, "items": rows}, indent=1).encode("utf-8"),
                                     mode=0o600)
        return rows
