"""What the user allowed each mod: once, on the capabilities it showed them.

``~/.dgc/mods/consent.json`` holds, per mod, the version and every grant (manifest.grants) the user allowed, whether
it's on, and whether it may run with no sandbox (only on a computer without one, and only when the user said so for
that mod). A mod runs only while every grant it asks for is in its record: an update that asks for more is held until
the user allows it again; one that asks for less runs.

A record holds only for the mod it was given to (``identity``): DGC's own mod of that name, or the one folder it was
allowed in (its installed copy, or a dev folder). Another folder that takes the same name gets none of it.
"""
from __future__ import annotations

import json
import os
import contextlib
import threading
import time
from pathlib import Path

from ..config import dgc_home
from .manifest import Manifest

_lock = threading.Lock()


def path() -> Path:
    return dgc_home() / "mods" / "consent.json"


@contextlib.contextmanager
def write_lock():
    """Serialize mod state updates across windows, as well as threads in one process."""
    with _lock:
        target = path().parent / ".write.lock"
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            import fcntl
        except ImportError:
            yield
            return
        fd = os.open(target, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)


def _read() -> dict:
    try:
        data = json.loads(path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write(data: dict) -> None:
    from ..workspace import atomic_write_bytes
    target = path()
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    atomic_write_bytes(target, json.dumps(data, indent=1, sort_keys=True).encode("utf-8"), mode=0o600)


def _valid(got) -> bool:
    return (isinstance(got, dict) and isinstance(got.get("grants"), list)
            and all(isinstance(g, str) for g in got["grants"])
            and isinstance(got.get("enabled", True), bool)
            and isinstance(got.get("unsandboxed", False), bool)
            and isinstance(got.get("folder", ""), str))


def record(name: str) -> dict | None:
    got = _read().get(name)
    return got if _valid(got) else None


def identity(m: Manifest) -> str:
    """Who an Allow is for: DGC's own mod (its folder moves with each DGC update), or the one folder it runs from."""
    return "builtin" if m.builtin else str(m.folder)


def record_for(m: Manifest, *, at=None) -> dict | None:
    """The user's record for this mod: None when the record of its name was given to another (another folder that
    took the name). ``at`` asks for the folder it will run from instead (a plugin's mod about to be installed)."""
    got = record(m.name)
    if got is None:
        return None
    mine = identity(m) if at is None else str(Path(at).resolve())
    where = got.get("folder")
    if where is None:
        # Given before DGC kept where: an Allow was for DGC's own mod or the installed copy.
        from .catalog import installed_root
        return got if mine in ("builtin", str((installed_root() / m.name).resolve())) else None
    return got if where == mine else None


def missing(m: Manifest, *, at=None) -> set[str]:
    """What it asks for that the user hasn't allowed (everything, when never allowed)."""
    got = record_for(m, at=at)
    return set(m.grants()) if got is None else m.grants() - set(got.get("grants") or [])


def allowed(m: Manifest) -> bool:
    """On, and everything it asks for allowed."""
    got = record_for(m)
    return bool(got and got.get("enabled", True) and m.grants() <= set(got["grants"]))


def allow(m: Manifest, *, unsandboxed: bool = False) -> dict:
    """The user's Allow, of exactly what this manifest asks for, for this mod only; it turns the mod on."""
    with write_lock():
        data = _read()
        data[m.name] = {"version": m.version, "grants": sorted(m.grants()), "enabled": True,
                        "allowed_at": int(time.time()), "unsandboxed": bool(unsandboxed), "folder": identity(m)}
        _write(data)
        return data[m.name]


def set_enabled(name: str, on: bool) -> dict | None:
    """Turn an allowed mod off or back on (a mod never allowed can't be turned on here)."""
    with write_lock():
        data = _read()
        if not _valid(data.get(name)):
            return None
        data[name]["enabled"] = bool(on)
        _write(data)
        return data[name]


def forget(name: str) -> None:
    with write_lock():
        data = _read()
        if data.pop(name, None) is not None:
            _write(data)
