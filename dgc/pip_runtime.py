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


def require_supervisor(config):
    """Local enqueue guard: a heartbeat alone cannot prove the supervisor is alive."""
    if config.get("pips_enabled", False) is not True:
        raise RegistryError("disabled", "Enable Pips locally before requesting work.")
    directory = state_directory()
    status, _ = _state(directory)
    if not supervisor_is_live(directory, status):
        raise RegistryError("runner_required", "Start the Pips runner before requesting work. Use Start runner in the editor or dgc pips serve in another terminal.")
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
        if supervisor_is_live(directory, status):
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
