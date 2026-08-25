"""Process-local coordination for agents sharing a writable checkout."""
from __future__ import annotations

import threading
from pathlib import Path


_guard = threading.Lock()
_workspace_locks: dict[str, threading.Lock] = {}


def workspace_mutation_lock(project_root) -> threading.Lock:
    """One lock per canonical checkout, shared by TUI/headless/sub-agent runtimes."""
    key = str(Path(project_root).resolve(strict=False))
    with _guard:
        lock = _workspace_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _workspace_locks[key] = lock
        return lock


def acquire_cancellable(lock: threading.Lock, cancelled=None) -> bool:
    """Wait for a write lease while still honoring turn cancellation."""
    while not lock.acquire(timeout=0.1):
        if cancelled is not None and cancelled.is_set():
            return False
    return True
