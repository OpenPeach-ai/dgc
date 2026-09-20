"""Starting, ending and outliving process trees, the same way on Linux, macOS and Windows.

Three jobs live here.

**One killable tree per command.** POSIX puts each tool command in its own session, so one
``killpg`` ends the whole tree. Windows has no such signal: :mod:`dgc.winjob` gives the command a
kill-on-close Job Object instead, and ``taskkill /T /F`` is the fallback.

**A registry of the groups this process started** (POSIX only). A ``dgc serve`` that is killed
outright — the host crashed, or the SDK force-closed the session — cannot run its own cleanup, so
it leaves a build or a dev server behind. Each group is appended to
``<DGC home>/.dgc/run/serve-<pid>.pgids`` as ``"<pgid> <starttime>\\n"``, and a sweeper ends only
the groups whose leader still has the same owner and the same start time. Without that check the
sweep would kill whatever process had since been given the same pid. Windows keeps no such file:
the Job Object already dies with the process that holds it.

**A watch on the process that launched us.** ``DGC_SERVE_PARENT_PID`` names it. A host that forks
can die while a child keeps our stdin's write end open, so the usual "stdin closed" signal never
arrives and ``dgc serve`` runs forever. The watcher notices the death directly — ``pidfd`` on
Linux, ``kqueue`` on macOS, ``WaitForSingleObject`` on Windows — and guarantees we are gone within
:data:`WATCH_DEADLINE_S`.
"""
from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from pathlib import Path

#: The launching process. Unset or unparsable means no watcher and no error.
PARENT_PID_ENV = "DGC_SERVE_PARENT_PID"
#: The contract the SDKs rely on: serve is gone this long after its launcher dies, at the latest.
WATCH_DEADLINE_S = 25.0
#: How long the ordinary shutdown gets before the watcher stops waiting for it.
PARENT_EXIT_GRACE_S = 15.0
#: A session cannot append more than this many groups; a runaway loop must not fill a disk.
MAX_REGISTRY_LINES = 20_000

_CREATE_NO_WINDOW = 0x08000000


# --------------------------------------------------------------------- spawning ---

def spawn_kwargs(extra: dict | None = None) -> dict:
    """Popen keywords that make a command's whole tree killable on this OS.

    On Windows this also sets ``CREATE_NO_WINDOW``: without it a GUI host (a ``pythonw`` app, an
    editor extension) flashes a console window for every command the agent runs.
    """
    kwargs = dict(extra or {})
    if os.name == "posix":
        kwargs["start_new_session"] = True
    elif os.name == "nt":
        flags = kwargs.get("creationflags", 0)
        kwargs["creationflags"] = (flags | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                                   | _CREATE_NO_WINDOW)
    return kwargs


def track(proc, *, register: bool = False) -> object | None:
    """Put a freshly started process in its own Job Object (Windows). Returns the job, or None.

    ``register`` additionally records the POSIX process group in this session's registry, so a
    serve that is killed outright can be cleaned up after. Only the long-running trees ask for
    it — a build, a dev server, an MCP or language server — because a registry line per `git
    status` would be a busy file for no benefit. Safe to call twice, and on an exited process.
    """
    if proc is None:
        return None
    if os.name == "posix":
        if register:
            # Off the caller's thread: reading a start time costs a `ps` on macOS, which has no
            # /proc, and a tool command must not wait on a best-effort bookkeeping file.
            threading.Thread(target=register_group, args=(proc.pid,),
                             name="dgc-group-registry", daemon=True).start()
        return None
    if os.name != "nt":
        return None
    existing = getattr(proc, "_dgc_job", None)
    if existing is not None:
        return existing
    from . import winjob
    job = winjob.Job()
    if job.ok and job.assign(proc.pid):
        try:
            proc._dgc_job = job
        except AttributeError:                    # pragma: no cover - a Popen stand-in in tests
            pass
        return job
    job.close()
    return None


def release(proc) -> None:
    """Drop a tracked job handle once its process has been reaped."""
    job = getattr(proc, "_dgc_job", None)
    if job is not None:
        try:
            job.close()
        finally:
            try:
                proc._dgc_job = None
            except AttributeError:                # pragma: no cover
                pass


# ---------------------------------------------------------------------- ending ---

def terminate_tree(proc, *, grace_s: float = 2.0) -> bool:
    """End ``proc`` and everything it started. True when nothing of it is left running.

    POSIX callers that already hold a pgid keep using ``killpg``; this is the one call that also
    works on Windows, where the tree is a Job Object and ``taskkill /T /F`` is the fallback.
    """
    if proc is None:
        return True
    if os.name == "posix":
        pgid = proc.pid
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pgid, sig)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            try:
                proc.wait(timeout=grace_s if sig == signal.SIGTERM else 2.0)
                break
            except (subprocess.TimeoutExpired, OSError):
                continue
        return group_alive(pgid) is False
    # The job is terminated even when the leader has already exited: a command that printed and
    # returned can leave a grandchild holding the output pipe, which is exactly the case a
    # timeout has to sweep. Popen.poll() says nothing about the rest of the tree.
    job = getattr(proc, "_dgc_job", None)
    ended = bool(job.terminate()) if job is not None else False
    if not ended and proc.poll() is None:
        from . import winjob
        ended = winjob.taskkill_tree(proc.pid)
        if not ended:
            try:
                proc.kill()                        # at least the direct child
            except (OSError, ValueError):
                pass
    try:
        proc.wait(timeout=max(0.1, grace_s))
    except (subprocess.TimeoutExpired, OSError):
        pass
    release(proc)
    return proc.poll() is not None


def group_alive(pgid: int) -> bool | None:
    """True while any member of the POSIX group exists, False when empty, None when unknowable."""
    if os.name != "posix":
        return None
    try:
        os.killpg(int(pgid), 0)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return None


# ------------------------------------------------------------------ start times ---

def start_time(pid: int) -> str:
    """An opaque stamp of when ``pid`` started, or "" when that cannot be read.

    Linux: field 22 of ``/proc/<pid>/stat``, in clock ticks since boot. macOS: whole seconds
    since the epoch, from the process's own start time. Both are stable for the life of the
    process and are never reused by a later process with the same pid, which is the entire point
    of recording them.
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return ""
    if pid <= 0:
        return ""
    if os.environ.get("DGC_NO_PROCFS") != "1" and os.path.isdir("/proc"):
        try:
            with open(f"/proc/{pid}/stat", "rb") as handle:
                fields = handle.read().decode("utf-8", "replace").rsplit(")", 1)[1].split()
            return fields[19]
        except (OSError, IndexError, ValueError):
            return ""
    try:
        done = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5,
                              env=dict(os.environ, LC_ALL="C"))
    except (OSError, subprocess.SubprocessError):
        return ""
    row = done.stdout.decode("utf-8", "replace").strip().splitlines()
    if done.returncode != 0 or not row:
        return ""
    try:
        return str(int(time.mktime(time.strptime(row[0].strip(), "%a %b %d %H:%M:%S %Y"))))
    except (ValueError, OverflowError):
        return ""


def process_owner(pid: int) -> int | None:
    """The uid that owns ``pid``, or None when it cannot be read."""
    if os.name != "posix":
        return None
    try:
        return os.stat(f"/proc/{int(pid)}").st_uid
    except (OSError, ValueError):
        pass
    try:
        done = subprocess.run(["ps", "-o", "uid=", "-p", str(int(pid))], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5,
                              env=dict(os.environ, LC_ALL="C"))
        text = done.stdout.decode("utf-8", "replace").strip()
        return int(text.split()[0]) if done.returncode == 0 and text else None
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


# ------------------------------------------------------------------- registry ---

def registry_dir() -> Path:
    from .config import USER_HOME
    return Path(USER_HOME) / "run"


def registry_path(pid: int | None = None) -> Path:
    return registry_dir() / f"serve-{int(pid if pid is not None else os.getpid())}.pgids"


def register_group(pgid: int, *, path: Path | None = None) -> bool:
    """Append one process group to this process's registry. Never raises."""
    if os.name != "posix":
        return False                  # Windows uses the Job Object; there is nothing to record
    target = Path(path) if path is not None else registry_path()
    stamp = start_time(pgid)
    if not stamp:
        return False                  # a record with no start time is one a sweeper must skip
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            target.parent.chmod(0o700)
        except OSError:
            pass
        if target.exists() and target.stat().st_size > MAX_REGISTRY_LINES * 32:
            return False
        fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, f"{int(pgid)} {stamp}\n".encode("utf-8"))
        finally:
            os.close(fd)
        return True
    except (OSError, ValueError):
        return False


def read_registry(path: Path) -> list[tuple[int, str]]:
    """Every well-formed record in one registry file. A malformed line is skipped, not fatal."""
    records: list[tuple[int, str]] = []
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return records
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        try:
            records.append((int(parts[0]), parts[1]))
        except ValueError:
            continue
    return records


def sweep_registry(path: Path, *, remove: bool = True) -> int:
    """End every recorded group that is still the group this session started. Returns the count.

    The owner and the start time must both still match: a pid is reused within hours on a busy
    machine, and a cleanup that kills the wrong process is worse than one that leaves a stray.
    """
    if os.name != "posix":
        return 0
    killed = 0
    uid = os.getuid()
    for pgid, stamp in read_registry(path):
        if group_alive(pgid) is not True:
            continue
        if start_time(pgid) != stamp:
            continue                         # the leader is gone; this pid belongs to someone else
        owner = process_owner(pgid)
        if owner is not None and owner != uid:
            continue
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pgid, sig)
            except (ProcessLookupError, PermissionError, OSError):
                break
            if sig == signal.SIGTERM:
                time.sleep(0.2)
        killed += 1
    if remove:
        try:
            Path(path).unlink()
        except (OSError, ValueError):
            pass
    return killed


def sweep_stale_registries(directory: Path | None = None) -> int:
    """Sweep the registries left by `dgc serve` processes that are no longer running."""
    if os.name != "posix":
        return 0
    folder = Path(directory) if directory is not None else registry_dir()
    swept = 0
    try:
        names = sorted(folder.glob("serve-*.pgids"))
    except (OSError, ValueError):
        return 0
    for entry in names:
        try:
            owner = int(entry.stem.split("-", 1)[1])
        except (IndexError, ValueError):
            continue
        if owner == os.getpid():
            continue
        try:
            os.kill(owner, 0)
            continue                             # that serve is alive and owns its own cleanup
        except ProcessLookupError:
            pass
        except (PermissionError, OSError):
            continue
        swept += sweep_registry(entry)
    return swept


def clear_registry(path: Path | None = None) -> None:
    """Remove this process's registry file at a clean shutdown."""
    try:
        (Path(path) if path is not None else registry_path()).unlink()
    except (OSError, ValueError):
        pass


# ------------------------------------------------------------- parent watcher ---

def parent_pid(env=None) -> int | None:
    """The pid named by ``DGC_SERVE_PARENT_PID``, or None when it is unset or not a pid."""
    raw = (os.environ if env is None else env).get(PARENT_PID_ENV, "")
    try:
        pid = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return pid if pid > 0 else None


def _wait_linux(pid: int) -> bool:
    try:
        import select
        fd = os.pidfd_open(pid)                   # type: ignore[attr-defined]
    except (AttributeError, ImportError, OSError):
        return False
    try:
        select.select([fd], [], [])
        return True
    except (OSError, ValueError):
        return False
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _wait_darwin(pid: int) -> bool:
    try:
        import select
        queue = select.kqueue()
    except (AttributeError, ImportError, OSError):
        return False
    try:
        event = select.kevent(pid, filter=select.KQ_FILTER_PROC,
                              flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE,
                              fflags=select.KQ_NOTE_EXIT)
        queue.control([event], 0, 0)
        queue.control(None, 1, None)
        return True
    except (OSError, ValueError, AttributeError):
        return False
    finally:
        try:
            queue.close()
        except OSError:
            pass


def _wait_windows(pid: int) -> bool:
    if os.name != "nt":
        return False
    try:
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        synchronize = 0x00100000
        handle = kernel32.OpenProcess(synchronize, False, int(pid))
        if not handle:
            return False
        try:
            kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)       # INFINITE
            return True
        finally:
            kernel32.CloseHandle(handle)
    except (ImportError, AttributeError, OSError):                 # pragma: no cover - Windows
        return False


def _wait_by_polling(pid: int, interval: float = 2.0) -> bool:
    while True:
        if not process_alive(pid):
            return True
        time.sleep(interval)


def process_alive(pid: int) -> bool:
    """Whether ``pid`` is still running, on any platform."""
    if os.name == "nt":                                            # pragma: no cover - Windows
        try:
            import ctypes
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(0x1000, False, int(pid))     # QUERY_LIMITED_INFORMATION
            if not handle:
                return False
            try:
                code = ctypes.c_ulong(0)
                if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return code.value == 259                           # STILL_ACTIVE
                return True
            finally:
                kernel32.CloseHandle(handle)
        except (ImportError, AttributeError, OSError, ValueError):
            return True
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, OSError, ValueError):
        return True


def wait_for_exit(pid: int) -> bool:
    """Block until ``pid`` exits. True when its death was observed."""
    if not process_alive(pid):
        return True
    for waiter in (_wait_linux, _wait_darwin, _wait_windows):
        if waiter(pid):
            return True
    return _wait_by_polling(pid)


def watch_parent(on_death, *, env=None, pid: int | None = None) -> threading.Thread | None:
    """Call ``on_death()`` once the launching process is gone. None when there is none to watch.

    The thread is a daemon: it never holds the process open, and a launcher that outlives us
    simply means the thread is still blocked when we exit.
    """
    watched = pid if pid is not None else parent_pid(env)
    if watched is None:
        return None

    def run() -> None:
        wait_for_exit(watched)
        try:
            on_death()
        except Exception:
            pass

    thread = threading.Thread(target=run, name="dgc-parent-watch", daemon=True)
    thread.start()
    return thread
