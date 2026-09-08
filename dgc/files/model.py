"""Directory listings for the explorer: bounded, no-follow, sortable, filterable."""
from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

from ..workspace import scan_directory_entries

MAX_ENTRIES = 4000
SORTS = ("name", "mtime", "size", "ext")
_NUMBER = re.compile(r"(\d+)")


@dataclass(frozen=True)
class Entry:
    name: str
    path: Path
    kind: str            # dir | file | link | other
    is_dir: bool         # navigable (a directory, or a link that resolves to one)
    size: int
    mtime: float
    mode: int
    hidden: bool

    @property
    def ext(self) -> str:
        return self.path.suffix.lower()


@dataclass
class Listing:
    path: Path
    entries: list[Entry]
    total: int           # entries before hidden/filter rules
    truncated: bool
    error: str = ""
    version: tuple = ()  # (mtime_ns, ctime_ns, scanned) used to detect external changes cheaply


def natural_key(text: str) -> tuple:
    return tuple(int(part) if part.isdigit() else part.lower()
                 for part in _NUMBER.split(text) if part != "")


def _classify(name: str, path: Path, info: os.stat_result) -> Entry:
    mode = info.st_mode
    hidden = name.startswith(".")
    if stat.S_ISDIR(mode):
        return Entry(name, path, "dir", True, 0, info.st_mtime, mode, hidden)
    if stat.S_ISLNK(mode):
        navigable = False
        try:
            navigable = path.is_dir()          # resolves the link once, for navigation only
        except OSError:
            navigable = False
        return Entry(name, path, "link", navigable, 0, info.st_mtime, mode, hidden)
    if stat.S_ISREG(mode):
        return Entry(name, path, "file", False, int(info.st_size), info.st_mtime, mode, hidden)
    return Entry(name, path, "other", False, 0, info.st_mtime, mode, hidden)


def sort_entries(entries: list[Entry], sort: str, reverse: bool = False) -> list[Entry]:
    if sort == "mtime":
        key = lambda e: (not e.is_dir, -e.mtime, natural_key(e.name))
    elif sort == "size":
        key = lambda e: (not e.is_dir, -e.size, natural_key(e.name))
    elif sort == "ext":
        key = lambda e: (not e.is_dir, e.ext, natural_key(e.name))
    else:
        key = lambda e: (not e.is_dir, natural_key(e.name))
    ordered = sorted(entries, key=key)
    if reverse:
        dirs = [e for e in ordered if e.is_dir]
        files = [e for e in ordered if not e.is_dir]
        ordered = list(reversed(dirs)) + list(reversed(files))
    return ordered


def matches_filter(name: str, pattern: str) -> bool:
    """Smart-case substring filter: lowercase patterns are case-insensitive."""
    if not pattern:
        return True
    if pattern == pattern.lower():
        return pattern in name.lower()
    return pattern in name


def directory_version(path: Path) -> tuple:
    try:
        info = os.stat(path, follow_symlinks=False)
    except OSError:
        return ()
    return (info.st_mtime_ns, info.st_ctime_ns)


def scan(path: Path, *, show_hidden: bool = False, sort: str = "name", reverse: bool = False,
         pattern: str = "", maximum: int = MAX_ENTRIES) -> Listing:
    try:
        rows, truncated, _scanned = scan_directory_entries(path, maximum=maximum)
    except PermissionError:
        return Listing(path, [], 0, False, error="permission denied")
    except FileNotFoundError:
        return Listing(path, [], 0, False, error="directory is gone")
    except (OSError, ValueError) as exc:
        return Listing(path, [], 0, False, error=str(exc)[:80] or "cannot read directory")
    entries = [_classify(name, path / name, info) for name, info in rows]
    visible = [e for e in entries if (show_hidden or not e.hidden) and matches_filter(e.name, pattern)]
    return Listing(path, sort_entries(visible, sort, reverse), len(entries), truncated,
                   version=directory_version(path) + (len(entries),))


def human_size(size: int) -> str:
    value = float(max(0, int(size)))
    for unit in ("B", "K", "M", "G", "T"):
        if value < 1024 or unit == "T":
            return f"{value:.0f}{unit}" if unit == "B" or value >= 10 else f"{value:.1f}{unit}"
        value /= 1024
    return f"{value:.0f}T"
