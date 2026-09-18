"""Private SDK state: the ``state_dir`` tree and the isolated config each session starts from.

The isolated ``home/.dgc/config.json`` is owned by the SDK. Every session rewrites it from
scratch, under a lock, from the options the embedder passed; nothing a previous session, run,
or another local user left in that file is merged back in. That is what keeps per-session
options (model, verifier, run budgets, trusted_dirs) out of later sessions, and what stops a
planted file from running commands (``verify_command``, ``autonomous_gate``, ``hooks``...).
Extra CLI settings are allowed only when passed explicitly (``DGC(extra_config=...)``).
"""

from __future__ import annotations

import contextlib
import json
import os
import stat
import tempfile
import threading
from pathlib import Path
from typing import Any, Iterator, Mapping

from .errors import DGCConfigError

_LOCKS_GUARD = threading.Lock()
_LOCKS: dict[str, "_StateLock"] = {}


def _posix_owner_checks() -> bool:
    return os.name == "posix" and hasattr(os, "geteuid")


def _private_group(gid: int) -> bool:
    """True for this user's own primary group with no other listed members (umask 002 hosts)."""
    try:
        import grp
        import pwd
        if gid != os.getegid():
            return False
        name = pwd.getpwuid(os.geteuid()).pw_name
        return all(member == name for member in grp.getgrgid(gid).gr_mem)
    except (ImportError, KeyError, OSError):
        return False


def private_dir(path: Path) -> Path:
    """Create ``path`` (and missing parents) and leave it owner-only (0700)."""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "posix":
        try:
            if stat.S_IMODE(path.stat().st_mode) != 0o700:
                path.chmod(0o700)
        except OSError:
            pass
    return path


def prepare_state_dir(state_dir: str | os.PathLike[str] | None) -> Path:
    """Return a private state directory, creating it when needed.

    ``None`` makes a fresh ``tempfile.mkdtemp`` directory (0700). An existing directory must be
    owned by this user and must not be group- or world-writable; a readable one that we own is
    tightened to 0700. Anything else is refused, because another local user could have planted
    files the DGC child would read.
    """
    if state_dir is None:
        return Path(tempfile.mkdtemp(prefix="dgc-sdk-")).resolve()
    path = Path(state_dir).expanduser()
    existed = path.exists()
    if existed and not path.is_dir():
        raise DGCConfigError(f"state_dir {str(path)!r} exists and is not a directory")
    try:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as exc:
        raise DGCConfigError(f"could not create state_dir {str(path)!r}: {exc}") from exc
    path = path.resolve()
    if _posix_owner_checks():
        info = path.stat()
        if info.st_uid != os.geteuid():
            raise DGCConfigError(
                f"state_dir {str(path)!r} is owned by another user; use a directory you own "
                "(or leave state_dir unset for a private temporary one)")
        mode = stat.S_IMODE(info.st_mode)
        if existed and (mode & 0o002 or (mode & 0o020 and not _private_group(info.st_gid))):
            raise DGCConfigError(
                f"state_dir {str(path)!r} is group- or world-writable (mode {mode:o}); files in "
                "it cannot be trusted. Use a private directory (mode 0700)")
        if mode != 0o700:
            try:
                path.chmod(0o700)
            except OSError as exc:
                raise DGCConfigError(f"could not make state_dir {str(path)!r} private: {exc}") from exc
    return path


def config_path(state_dir: Path) -> Path:
    return Path(state_dir) / "home" / ".dgc" / "config.json"


class _StateLock:
    """Serialize isolated-config writes and child startups for one state_dir.

    Re-entrant within a thread. Across processes it holds ``flock`` on ``state_dir/.config.lock``
    where the platform has it.
    """

    def __init__(self, state_dir: Path):
        self._path = Path(state_dir) / ".config.lock"
        self._rlock = threading.RLock()
        self._local = threading.local()

    @contextlib.contextmanager
    def hold(self) -> Iterator[None]:
        with self._rlock:
            depth = getattr(self._local, "depth", 0)
            handle = None
            if depth == 0:
                handle = self._acquire_file()
            self._local.depth = depth + 1
            try:
                yield
            finally:
                self._local.depth = depth
                if handle is not None:
                    self._release_file(handle)

    def _acquire_file(self):
        try:
            import fcntl
        except ImportError:  # pragma: no cover - Windows: in-process serialization only
            return None
        try:
            fd = os.open(str(self._path), os.O_RDWR | os.O_CREAT, 0o600)
        except OSError:
            return None
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
        except OSError:
            os.close(fd)
            return None
        return fd

    @staticmethod
    def _release_file(fd) -> None:
        try:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_UN)
        except (ImportError, OSError):
            pass
        try:
            os.close(fd)
        except OSError:
            pass


def state_lock(state_dir: Path) -> _StateLock:
    key = str(Path(state_dir).resolve())
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = _StateLock(Path(key))
            _LOCKS[key] = lock
        return lock


def write_session_config(state_dir: Path, values: Mapping[str, Any]) -> dict[str, Any]:
    """Atomically replace the isolated config.json with exactly ``values`` (None dropped).

    Call with :func:`state_lock` held. Directories are 0700 and the file is 0600. Returns the
    values as they read back from JSON, for :func:`config_drift`.
    """
    payload = {str(key): value for key, value in values.items() if value is not None}
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    home = private_dir(Path(state_dir) / "home")
    folder = private_dir(home / ".dgc")
    path = folder / "config.json"
    fd, tmp = tempfile.mkstemp(prefix=".config.json.", suffix=".tmp", dir=str(folder))
    try:
        try:
            os.fchmod(fd, 0o600)
        except (AttributeError, OSError):
            pass
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return json.loads(text)


def config_drift(state_dir: Path, expected: Mapping[str, Any]) -> list[str]:
    """Keys of ``expected`` whose value in the isolated config.json now differs.

    A DGC child saves its whole configuration when it persists anything (an ``always``
    approval, a plan decision). If another session's child did that between our write and our
    child's startup, our child may have loaded that session's options; the caller retries.
    """
    try:
        current = json.loads(config_path(state_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ["config.json"]
    if not isinstance(current, dict):
        return ["config.json"]
    return sorted(key for key, value in expected.items() if current.get(key) != value)
