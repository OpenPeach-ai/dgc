"""Bounded previews and a cached per-directory Git status for the explorer."""
from __future__ import annotations

import os
import stat
import time
from pathlib import Path

from .model import Entry, human_size, natural_key

PREVIEW_BYTES = 64 * 1024
GIT_CACHE_S = 2.0


def read_head(path: Path, limit: int = PREVIEW_BYTES) -> tuple[bytes, int]:
    """Read the first ``limit`` bytes of a regular file without following a symlink."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OSError("not a regular file")
        return os.read(fd, limit), int(info.st_size)
    finally:
        os.close(fd)


def text_preview(path: Path, width: int, height: int) -> list[tuple[str, str]]:
    """Return (role, text) rows for a file: numbered text, or a one-line binary summary."""
    try:
        data, size = read_head(path)
    except OSError as exc:
        return [("file-preview-dim", f"cannot read: {getattr(exc, 'strerror', None) or exc}")]
    if b"\0" in data[:8192]:
        return [("file-preview-dim", f"binary · {human_size(size)}")]
    text = data.decode("utf-8", errors="replace").expandtabs(4)
    rows: list[tuple[str, str]] = []
    lines = text.splitlines()
    gutter = len(str(min(len(lines), height))) + 1
    for number, line in enumerate(lines[:height], start=1):
        body = line[:max(1, width - gutter - 1)]
        rows.append(("file-preview", f"{number:>{gutter}} {body}"))
    if not rows:
        rows.append(("file-preview-dim", "empty file" if size == 0 else "no text"))
    if size > len(data):
        rows.append(("file-preview-dim", f"… {human_size(size)} total"))
    return rows[:height]


def directory_preview(entries: list[Entry], height: int, *, count: int) -> list[tuple[str, str]]:
    rows = [("file-dir" if e.is_dir else "file-name", e.name + ("/" if e.is_dir else ""))
            for e in sorted(entries, key=lambda e: (not e.is_dir, natural_key(e.name)))[:height]]
    if not rows:
        rows.append(("file-preview-dim", "empty folder"))
    elif count > len(rows):
        rows[-1] = ("file-preview-dim", f"… {count} items")
    return rows


class GitStatus:
    """Per-directory `git status` cache; read-only Git, never a transport or filter."""

    def __init__(self):
        self._cache: dict[str, tuple[float, dict[str, str]]] = {}

    def statuses(self, directory: Path) -> dict[str, str]:
        key = str(directory)
        cached = self._cache.get(key)
        now = time.monotonic()
        if cached and now - cached[0] < GIT_CACHE_S:
            return cached[1]
        result = self._query(directory)
        self._cache[key] = (now, result)
        return result

    @staticmethod
    def _query(directory: Path) -> dict[str, str]:
        try:
            from ..worktree import _run_git
        except Exception:
            return {}
        try:
            proc = _run_git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--",
                             "."], directory, timeout=1.5, max_stdout=256 * 1024, text=False,
                            read_only=True)
        except Exception:
            return {}
        if proc.returncode != 0 or not proc.stdout:
            return {}
        try:
            top = _run_git(["rev-parse", "--show-toplevel"], directory, timeout=1.0,
                           max_stdout=4096, text=False, read_only=True)
            repo = Path(os.fsdecode(top.stdout).strip()) if top.returncode == 0 else directory
        except Exception:
            repo = directory
        statuses: dict[str, str] = {}
        records = proc.stdout.split(b"\0")
        index = 0
        while index < len(records):
            record = records[index]
            index += 1
            if len(record) < 4:
                continue
            code = record[:2].decode("ascii", errors="replace")
            name = os.fsdecode(record[3:])
            if code[0] == "R" or code[0] == "C":
                index += 1  # the original path follows as its own record
            full = (repo / name)
            try:
                relative = full.relative_to(directory)
            except ValueError:
                continue
            head = relative.parts[0] if relative.parts else ""
            if not head:
                continue
            letter = "u" if code == "??" else ("d" if "D" in code else ("a" if "A" in code else "m"))
            previous = statuses.get(head)
            statuses[head] = letter if previous in (None, "u") or letter == "d" else previous
        return statuses
