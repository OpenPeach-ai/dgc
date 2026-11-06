"""Explicit local editor start/resume of the independent Pips supervisor.

Not a Remote command and not a model tool. No stored PID is ever a kill target.
The supervisor holds its own lease and continues when the editor backend exits.
"""
from __future__ import annotations

import os
from pathlib import Path
import stat
import subprocess
import sys
import threading
import time

from .pip_daemon import SUPERVISOR_KEY, _read, resume_runtime, runner_status
from .scheduler import named_process_lock
from .workspace_registry import RegistryError, WorkspaceRegistry, state_directory

_START_LOCK = threading.Lock()
START_TIMEOUT = 8.0

# Python 3.10-compatible safe imports. The child starts in our package directory,
# never the untrusted project, and receives the project only as a Config argument.
# Do not use `python -m dgc` with cwd=project_root: cwd outranks PYTHONPATH.
_SUPERVISOR_BOOTSTRAP = """
import sys
package_root, project_root = sys.argv[1:3]
sys.path[:] = [package_root] + [item for item in sys.path if item and item != package_root]
from pathlib import Path
from dgc.config import Config
from dgc.pip_cli import handle_command
raise SystemExit(handle_command(Config(project_root=Path(project_root)), ["serve"]))
"""


def _supervisor_command(project_root):
    return [sys.executable, "-c", _SUPERVISOR_BOOTSTRAP,
            str(Path(__file__).resolve().parents[1]), str(Path(project_root).absolute())]


def _state(directory):
    with WorkspaceRegistry(directory) as registry:
        return runner_status(registry), (_read(registry, SUPERVISOR_KEY) or {}).get("instance_id")


def supervisor_is_live(directory, status):
    if not status.get("online") or status.get("status") != "running" or status.get("paused"):
        return False
    lease = named_process_lock("pips-supervisor", str(directory))
    acquired = lease.acquire(blocking=False)
    if acquired:
        lease.release()
    elif lease.last_error:
        raise RegistryError("runner_unavailable", "The Pips supervisor lease could not be checked. Resolve local state access before starting or queueing work.")
    return not acquired


STOP_TIMEOUT = 30.0          # a runner checks the stop every heartbeat (2 s) and then winds down
SERVICE_TIMEOUT = 15.0


def _release(value):
    import re
    found = re.match(r"(\d+)\.(\d+)\.(\d+)", str(value or ""))
    return tuple(int(part) for part in found.groups()) if found else None


def _other_runner(status) -> str:
    """'' for this install's runner; else 'older', 'newer', or 'other' (another install of the same release, or a
    version that can't be compared)."""
    from . import __version__
    theirs = status.get("version")
    if theirs == __version__:
        return ""
    if theirs is None:
        return "older"                                   # from before runners said their version
    ours, found = _release(__version__), _release(theirs)
    if ours and found and ours != found:
        return "older" if found < ours else "newer"
    return "other"


def _mismatch(status, kind) -> RegistryError:
    from . import __version__
    theirs = status.get("version") or "an earlier version"
    if kind == "newer":
        text = (f"The Pips runner running now belongs to a newer DGC ({theirs}) than this one ({__version__}). "
                "Update this DGC, then retry.")
    else:
        which = f"an older DGC ({theirs})" if kind == "older" else f"another DGC install ({theirs})"
        text = (f"The Pips runner running now is from {which} and is still working. Try again when it finishes: "
                f"DGC then moves it to this one ({__version__}).")
    return RegistryError("runner_version_mismatch", text)


def _lease_free(directory) -> bool:
    lease = named_process_lock("pips-supervisor", str(directory))
    if lease.acquire(blocking=False):
        lease.release()
        return True
    return False


def _move_runner(config, directory, status, kind):
    """The live runner is another install's (an update left it running). While no Pip run is queued or running it
    stops the way Stop does, with the runtime stop alone (no Pip is paused, nothing is cancelled), and the stop is
    cleared again once it is gone; this install's runner then starts. Busy, it is left to finish, and the error
    says so."""
    from .pip_daemon import _set_paused, pause_if_idle
    with WorkspaceRegistry(directory) as registry:
        if not pause_if_idle(registry, "dgc-update"):
            raise _mismatch(status, kind)
    deadline = time.monotonic() + STOP_TIMEOUT
    wait = threading.Event()
    while True:
        if _lease_free(directory):
            try:
                resume_runtime(config, "dgc-update")
                return
            except RegistryError as exc:
                if exc.code != "runner_running":
                    raise
        if time.monotonic() >= deadline:
            with WorkspaceRegistry(directory) as registry:
                _set_paused(registry, False, "dgc-update")
            raise RegistryError("runner_version_mismatch", f"The Pips runner from {status.get('version') or 'an earlier DGC'} "
                                "didn't stop, so it keeps running. Stop Pips in the Pips view, then start the runner "
                                "again.")
        wait.wait(0.1)


def _keep_running():
    """Keep Pips running's state when it is on for this account; None when it is off or can't be read."""
    from . import pip_keep_running
    try:
        if not pip_keep_running._account_home():
            return None
        state = pip_keep_running.status()
    except Exception:                                    # noqa: BLE001 -- then the editor starts the runner itself
        return None
    return state if state.get("on") else None


def _start_through_keep_running(directory, before):
    """This install's runner, started the way Keep Pips running starts it (its service first moved to this
    install), so it is also the one that starts at login. None when it didn't come up in time."""
    from . import pip_keep_running
    try:
        pip_keep_running.set_on(True, runner_online=False)
    except (RegistryError, OSError):
        return None
    deadline = time.monotonic() + SERVICE_TIMEOUT
    wait = threading.Event()
    while time.monotonic() < deadline:
        status, instance = _state(directory)
        if instance != before and supervisor_is_live(directory, status) and not _other_runner(status):
            return status
        wait.wait(0.1)
    return None


def require_supervisor(config):
    """Local enqueue guard: a heartbeat alone cannot prove the supervisor is alive."""
    if config.get("pips_enabled", False) is not True:
        raise RegistryError("disabled", "Enable Pips locally before requesting work.")
    directory = state_directory()
    status, _ = _state(directory)
    if not supervisor_is_live(directory, status):
        raise RegistryError("runner_required", "Start the Pips runner before requesting work. Use Start runner in the editor or dgc pips serve in another terminal.")
    if _other_runner(status):
        # Moved to this install when it is idle, or the error says why not yet.
        return start_runtime(config)
    return status


def _log(directory):
    path = directory / "supervisor.log"
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
                 | getattr(os, "O_NONBLOCK", 0), 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or (os.name == "posix" and info.st_uid != os.getuid()):
            raise RegistryError("unsafe_state", "Supervisor log must be an owned regular file.")
        if os.name == "posix":
            os.fchmod(fd, 0o600)
        return os.fdopen(fd, "ab", buffering=0)
    except BaseException:
        os.close(fd)
        raise


def _stop_owned(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def start_runtime(config, *, resume=False):
    from .pips import _require_runner_platform
    if type(resume) is not bool:
        raise RegistryError("invalid_request", "Resume must be an explicit local choice.")
    if config.get("pips_enabled", False) is not True:
        raise RegistryError("disabled", "Enable Pips locally before starting its runner.")
    _require_runner_platform()
    with _START_LOCK:
        directory = state_directory()
        status, before = _state(directory)
        if resume:
            resume_runtime(config, "local-editor")
            status, before = _state(directory)
        if status["paused"]:
            raise RegistryError("runtime_paused", "Global stop is set. Review and explicitly resume the runner locally.")
        moved = False
        if supervisor_is_live(directory, status):
            kind = _other_runner(status)
            if not kind:
                return status
            if kind == "newer":
                raise _mismatch(status, kind)
            _move_runner(config, directory, status, kind)
            moved = True
            status, before = _state(directory)
        service = _keep_running()
        if service and (moved or service.get("outdated")):
            # Keep Pips running is on: its service starts this install's runner (and is moved to it first), so a
            # runner from the previous install never comes back at login or after a failure.
            started = _start_through_keep_running(directory, before)
            if started is not None:
                return started
            status, before = _state(directory)
            if supervisor_is_live(directory, status) and not _other_runner(status):
                return status
        env = dict(os.environ)
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
        env["PYTHONNOUSERSITE"] = "1"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        with _log(directory) as output:
            proc = subprocess.Popen(_supervisor_command(config.project_root),
                                    cwd=Path(__file__).resolve().parents[1], env=env, stdin=subprocess.DEVNULL,
                                    stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + START_TIMEOUT
        wait = threading.Event()
        try:
            while True:
                status, instance = _state(directory)
                if instance != before and supervisor_is_live(directory, status):
                    # Retain/reap this owned Popen without tying supervisor life
                    # to the editor. A competing starter may own the live lease.
                    threading.Thread(target=proc.wait, name="dgc-pips-supervisor-reap", daemon=True).start()
                    return status
                if status["paused"]:
                    raise RegistryError("runtime_paused", "A newer global stop prevented the runner from starting.")
                if proc.poll() is not None:
                    raise RegistryError("runner_start_failed", "The Pips runner could not start. Check its private supervisor.log and retry locally.")
                if time.monotonic() >= deadline:
                    raise RegistryError("runner_start_timeout", "The Pips runner did not report ready. Its owned startup process was stopped; review supervisor.log before retrying.")
                wait.wait(0.05)
        except BaseException:
            _stop_owned(proc)
            raise
