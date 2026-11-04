"""DGC Router's files under ~/.dgc/router: what each system serves (discovery), what the probes measured, its
hardware readout (hardware), and the worker leases every DGC process on this computer shares. Each is small JSON, written atomically under a file lock.
Nothing here holds a key."""
from __future__ import annotations

import contextlib
import json
import os
import tempfile
import time
from pathlib import Path

from .config import dgc_home

MAX_FILE = 4 * 1024 * 1024


def directory() -> Path:
    """~/.dgc/router (or $DGC_HOME/.dgc/router), read now so a test or an isolated SDK session has its own."""
    return dgc_home() / "router"


@contextlib.contextmanager
def locked(name: str):
    """An exclusive flock on ``<name>.lock`` beside the file: the kernel drops it if the holder dies."""
    folder = directory()
    folder.mkdir(parents=True, exist_ok=True)
    try:
        folder.chmod(0o700)
    except OSError:
        pass
    try:
        import fcntl
    except ImportError:                    # Windows runs DGC in WSL; a bare Windows Python gets no cross-process lock
        yield
        return
    fd = os.open(str(folder / f"{name}.lock"), os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


_CACHE: dict[str, tuple[tuple, dict]] = {}
_CACHED = frozenset({"probes", "discovery", "hardware"})


def read(name: str) -> dict:
    """The file's JSON (a fresh copy), {} when it is missing or unreadable. Unchanged files are not parsed again:
    the system prompt and every status read go through here."""
    import copy
    path = directory() / f"{name}.json"
    try:
        info = path.stat()
        if info.st_size > MAX_FILE:
            return {}
        # Only the rarely written files are cached; the leases are always read from disk, under their lock.
        stamp = (str(path), info.st_ino, info.st_mtime_ns, info.st_size) if name in _CACHED else None
        cached = _CACHE.get(name)
        if stamp is not None and cached is not None and cached[0] == stamp:
            return copy.deepcopy(cached[1])
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    value = value if isinstance(value, dict) else {}
    if stamp is None:
        return value
    _CACHE[name] = (stamp, value)
    return copy.deepcopy(value)


def write(name: str, value: dict) -> None:
    folder = directory()
    folder.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{name}.", suffix=".tmp", dir=str(folder))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(value, indent=1, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, folder / f"{name}.json")
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp)


def update(name: str, change) -> dict:
    """Read, change (``change(value)`` edits it in place) and write ``name`` under its lock; returns the result."""
    with locked(name):
        value = read(name)
        change(value)
        write(name, value)
        return value


# ---- what the probes measured --------------------------------------------------------------------------------
def save_probe(system_id: str, model: str, results: dict) -> dict:
    """Keep a probe's results for (system, model), each check with the time it ran."""
    stamped = {check: {**result, "at": result.get("at") or time.time()} for check, result in results.items()
               if isinstance(result, dict)}

    def change(value):
        system = value.setdefault(system_id, {})
        system.setdefault(model, {}).update(stamped)
    return update("probes", change).get(system_id, {}).get(model, {})


def probes(system_id: str | None = None) -> dict:
    value = read("probes")
    return value.get(system_id, {}) if system_id is not None else value


def forget(system_id: str) -> None:
    for name in ("probes", "discovery", "hardware"):
        update(name, lambda value: value.pop(system_id, None))


# ---- what each system serves ------------------------------------------------------------------------------------
def save_discovery(system_id: str, found: dict) -> None:
    def change(value):
        value[system_id] = found
    update("discovery", change)


def discovery(system_id: str | None = None) -> dict:
    value = read("discovery")
    return value.get(system_id, {}) if system_id is not None else value
