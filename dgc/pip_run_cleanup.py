"""Free a finished Pip run's disk space without touching what reviews still read.

A run's folder holds a private copy of the source it read (`source/`), for Patch and Pulse a
private worktree and Git directory, and the private home its worker ran in. None of these is
read again once the run has finished and its token usage is in the ledger: reports, findings,
handoffs and exports use the saved run record and `artifacts/`, which stay. Kept forever, the
copies are what forced the project-run ceiling down to 1,000; removed, a run costs little more
than its record.
"""
from __future__ import annotations

import os
import re
import shutil
import stat
from pathlib import Path

RUN_ID = re.compile(r"run_[a-f0-9]{32}\Z")
TERMINAL = ("succeeded", "failed", "cancelled")
# The parts no review reads after the run. `artifacts/` and everything else stay. A macOS
# command's `scratch` is removed when the command ends; one is left only if the runner stopped
# mid-command.
COPIES = ("source", "worktree", "private-git", "scratch")
WORKER_HOME = "worker-home"
SWEEP_LIMIT = 200          # runs examined per sweep, so a large backlog never stalls the runner


def _owned_directory(path: Path) -> os.stat_result | None:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(info.st_mode) or (os.name == "posix" and info.st_uid != os.geteuid()):
        raise OSError(f"{path.name} is not a private directory of this user")
    return info


def _remove_tree(path: Path) -> int:
    """Delete `path` and return the bytes it held. Never follows a link.

    Snapshots are written read-only (files 0400, some directories 0500), so directories are made
    writable first; only real directories found by lstat are touched, never a link's target. The
    worker that wrote them has exited, so nothing races the walk.
    """
    if _owned_directory(path) is None:
        return 0
    freed = 0
    for root, dirs, files in os.walk(path, topdown=True, followlinks=False):
        os.chmod(root, 0o700)
        for name in files + dirs:
            try:
                info = os.lstat(os.path.join(root, name))
            except FileNotFoundError:
                continue
            if stat.S_ISREG(info.st_mode):
                freed += info.st_size
            if stat.S_ISDIR(info.st_mode):
                os.chmod(os.path.join(root, name), 0o700)
        # os.walk lists a directory link under `dirs` but never descends into it.
    shutil.rmtree(path)
    return freed


def _usage_recorded(run_id: str, home: Path) -> bool:
    """Import the run's token usage if it has not been; True once the ledger has it."""
    from .pip_usage import import_run
    try:
        import_run(run_id, home=home)
        return True
    except (OSError, ValueError):
        return False
    except Exception:          # sqlite3.Error and anything else: keep the worker home for a retry
        return False


def prune_run(state_directory, run_id: str) -> int:
    """Remove a finished run's copies (and its worker home once usage is recorded)."""
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        raise ValueError("invalid run id")
    state = Path(state_directory)
    run = state / "runs" / run_id
    if _owned_directory(state / "runs") is None or _owned_directory(run) is None:
        return 0
    freed = sum(_remove_tree(run / name) for name in COPIES)
    if (run / WORKER_HOME).exists() and _usage_recorded(run_id, state.parent):
        freed += _remove_tree(run / WORKER_HOME)
    return freed


def prune_finished(registry, *, limit: int = SWEEP_LIMIT) -> dict:
    """Sweep finished runs that still hold copies, oldest first, up to `limit` runs."""
    state = Path(registry.directory)
    runs = state / "runs"
    if _owned_directory(runs) is None:
        return {"runs": 0, "bytes": 0}
    candidates = [entry.name for entry in os.scandir(runs)
                  if RUN_ID.fullmatch(entry.name) and entry.is_dir(follow_symlinks=False)
                  and any(os.path.lexists(os.path.join(entry.path, name))
                          for name in (*COPIES, WORKER_HOME))]
    if not candidates:
        return {"runs": 0, "bytes": 0}
    waiting = set(candidates)
    # Filtered here rather than with IN (...): a backlog can exceed SQLite's parameter limit.
    finished = [run_id for (run_id,) in registry.db.execute(
        f"SELECT id FROM pip_runs WHERE status IN ({','.join('?' * len(TERMINAL))}) ORDER BY finished_at, id",
        TERMINAL) if run_id in waiting][:limit]
    pruned = freed = 0
    for run_id in finished:
        try:
            freed += prune_run(state, run_id)
            pruned += 1
        except OSError:
            continue           # one unreadable folder never stops the sweep or the runner
    return {"runs": pruned, "bytes": freed}
