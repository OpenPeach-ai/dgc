"""Crash-safe coordination for DGC processes sharing a writable checkout."""
from __future__ import annotations

import errno
import hashlib
import math
import os
import sys
import tempfile
import threading
import time
import unicodedata
from pathlib import Path


_guard = threading.Lock()
_workspace_locks: dict[str, "WorkspaceMutationLock"] = {}
_named_locks: dict[str, "WorkspaceMutationLock"] = {}
_POLL_SECONDS = 0.05


def _canonical_key(project_root) -> str:
    key = unicodedata.normalize(
        "NFC", os.path.normcase(str(Path(project_root).resolve(strict=False))))
    # Windows and default macOS filesystems are case-insensitive. Conservatively sharing a lock on
    # a case-sensitive macOS volume is safer than allowing two spellings of one checkout to race.
    return key.casefold() if os.name == "nt" or sys.platform == "darwin" else key


def _lock_directory() -> Path:
    """Return an owner-private directory shared by this user's DGC processes."""
    try:
        base = Path.home() / ".dgc" / "locks"
    except (RuntimeError, OSError):
        identity = str(os.getuid()) if hasattr(os, "getuid") else "user"
        base = Path(tempfile.gettempdir()) / f"dgc-locks-{identity}"
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "posix":
        base.chmod(0o700)
    return base


def _lock_path(key: str) -> Path:
    digest = hashlib.sha256(key.encode("utf-8", errors="surrogatepass")).hexdigest()
    return _lock_directory() / f"workspace-{digest}.lock"


def _open_lock_file(path: Path) -> int:
    flags = os.O_RDWR | os.O_CREAT
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        os.set_inheritable(fd, False)
        if os.name == "posix":
            os.fchmod(fd, 0o600)
        # msvcrt.locking locks an existing byte range.
        if os.fstat(fd).st_size == 0:
            os.write(fd, b"\0")
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _lock_is_busy(exc: OSError) -> bool:
    return (exc.errno in (errno.EACCES, errno.EAGAIN)
            or getattr(exc, "winerror", None) in (33, 36))


def _try_os_lock(fd: int) -> bool:
    if os.name == "posix":
        import fcntl
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError as exc:
            if _lock_is_busy(exc):
                return False
            raise
    if os.name == "nt":  # pragma: no cover - exercised by Windows CI
        import msvcrt
        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return True
        except OSError as exc:
            if _lock_is_busy(exc):
                return False
            raise
    raise OSError(errno.ENOSYS, "OS file locking is unavailable")


def _unlock_os(fd: int) -> None:
    if os.name == "posix":
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_UN)
        return
    if os.name == "nt":  # pragma: no cover - exercised by Windows CI
        import msvcrt
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        return
    raise OSError(errno.ENOSYS, "OS file locking is unavailable")


class WorkspaceMutationLock:
    """A thread lock plus an owner-private OS lock file for one canonical checkout.

    The file descriptor stays open for the lease lifetime, so the operating system releases the
    cross-process lock even if DGC crashes. The local lock preserves Python's thread semantics and
    allows a background reader thread to release a lease acquired by its launching thread.
    """

    def __init__(self, key: str, label: str = "workspace"):
        self.key = key
        self.label = label
        self.path: Path | None = None
        self._local = threading.Lock()
        self._state = threading.Lock()
        self._fd: int | None = None
        self._thread_state = threading.local()

    @property
    def last_error(self) -> str:
        return str(getattr(self._thread_state, "last_error", ""))

    def _set_error(self, value: str = "") -> None:
        self._thread_state.last_error = value

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        self._set_error()
        if not blocking and timeout not in (-1, None):
            raise ValueError("can't specify a timeout for a non-blocking acquire")
        try:
            wait = float(timeout) if timeout is not None else -1.0
        except (TypeError, ValueError):
            raise ValueError("timeout must be a number") from None
        if not math.isfinite(wait):
            raise ValueError("timeout must be finite")
        deadline = None if wait < 0 else time.monotonic() + wait

        if not blocking:
            local_acquired = self._local.acquire(blocking=False)
        elif deadline is None:
            local_acquired = self._local.acquire()
        else:
            local_acquired = self._local.acquire(timeout=max(0.0, deadline - time.monotonic()))
        if not local_acquired:
            return False

        fd: int | None = None
        try:
            self.path = _lock_path(self.key)
            fd = _open_lock_file(self.path)
            while True:
                if _try_os_lock(fd):
                    with self._state:
                        self._fd = fd
                    return True
                if not blocking or (deadline is not None and time.monotonic() >= deadline):
                    return False
                remaining = (_POLL_SECONDS if deadline is None else
                             min(_POLL_SECONDS, max(0.0, deadline - time.monotonic())))
                if remaining <= 0:
                    return False
                time.sleep(remaining)
        except OSError as exc:
            self._set_error(
                f"{self.label} lease unavailable ({type(exc).__name__}: {str(exc)[:240]})")
            return False
        finally:
            with self._state:
                held = self._fd == fd and fd is not None
            if not held:
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                self._local.release()

    def release(self) -> None:
        with self._state:
            fd, self._fd = self._fd, None
        if fd is None:
            raise RuntimeError("release unlocked workspace mutation lock")
        try:
            _unlock_os(fd)
        except OSError as exc:
            self._set_error(
                f"{self.label} lease release failed ({type(exc).__name__}: {str(exc)[:240]})")
        finally:
            try:
                os.close(fd)
            finally:
                self._local.release()

    def locked(self) -> bool:
        return self._local.locked()


def workspace_mutation_lock(project_root) -> WorkspaceMutationLock:
    """Return the hybrid thread/process lock for one canonical checkout."""
    key = _canonical_key(project_root)
    with _guard:
        lock = _workspace_locks.get(key)
        if lock is None:
            lock = WorkspaceMutationLock(key)
            _workspace_locks[key] = lock
        return lock


def named_process_lock(namespace: str, key: str) -> WorkspaceMutationLock:
    """Return a crash-released process lock for a non-workspace internal resource."""
    namespace = str(namespace).strip().lower()
    if not namespace or not namespace.replace("-", "").replace("_", "").isalnum():
        raise ValueError("lock namespace must be alphanumeric")
    normalized = unicodedata.normalize("NFC", os.path.normcase(str(key)))
    if os.name == "nt" or sys.platform == "darwin":
        normalized = normalized.casefold()
    compound = f"{namespace}\0{normalized}"
    with _guard:
        lock = _named_locks.get(compound)
        if lock is None:
            lock = WorkspaceMutationLock(compound, label=namespace)
            _named_locks[compound] = lock
        return lock


def acquire_cancellable(lock: WorkspaceMutationLock, cancelled=None) -> bool:
    """Wait for a write lease while honoring cancellation and lock-backend failures."""
    while True:
        if cancelled is not None and cancelled.is_set():
            return False
        if lock.acquire(timeout=0.1):
            if cancelled is not None and cancelled.is_set():
                lock.release()
                return False
            return True
        if lock.last_error:
            return False
