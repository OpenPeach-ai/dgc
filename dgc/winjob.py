"""Windows Job Objects: the only way to end a process tree there.

POSIX gives DGC a process group: one ``killpg`` ends a build and every compiler, test runner and
dev server it spawned. Windows has no equivalent signal, and ``Popen.kill`` ends exactly one
process — so a timed-out ``npm run build`` left node, esbuild and their children running, holding
the CPU and the workspace's files.

A Job Object is the Windows answer. A process assigned to one stays in it, its children join it,
and ``TerminateJobObject`` ends all of them at once. With ``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE``
the tree also dies when the handle is dropped, which is what happens when DGC itself is killed.

Everything here is best-effort: ``taskkill /T /F`` is the fallback wherever a job cannot be
created or assigned (a host that already confines DGC in a job that forbids nesting, for
example), and every function is a no-op off Windows.
"""
from __future__ import annotations

import os
import subprocess

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JobObjectExtendedLimitInformation = 9
_PROCESS_TERMINATE = 0x0001
_PROCESS_SET_QUOTA = 0x0100


def available() -> bool:
    """Whether this process can use Job Objects at all."""
    return os.name == "nt"


def _kernel32():
    import ctypes
    return ctypes.WinDLL("kernel32", use_last_error=True)   # type: ignore[attr-defined]


def _limit_structures():
    import ctypes
    from ctypes import wintypes

    class _BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BasicLimits),
            ("IoInfo", _IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    return _ExtendedLimits


class Job:
    """A kill-on-close Job Object. ``ok`` is False when this machine would not give us one."""

    def __init__(self, *, kill_on_close: bool = True):
        self.handle = None
        self.ok = False
        self.reason = ""
        if os.name != "nt":
            self.reason = "job objects exist only on Windows"
            return
        try:
            import ctypes
            kernel32 = _kernel32()
            handle = kernel32.CreateJobObjectW(None, None)
            if not handle:
                self.reason = f"CreateJobObject failed ({ctypes.get_last_error()})"
                return
            self.handle = handle
            if kill_on_close:
                limits = _limit_structures()()
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if not kernel32.SetInformationJobObject(
                        handle, _JobObjectExtendedLimitInformation,
                        ctypes.byref(limits), ctypes.sizeof(limits)):
                    self.reason = f"SetInformationJobObject failed ({ctypes.get_last_error()})"
                    self.close()
                    return
            self.ok = True
        except (ImportError, AttributeError, OSError) as exc:   # pragma: no cover - Windows only
            self.reason = f"{type(exc).__name__}: {exc}"
            self.close()

    def assign(self, pid: int) -> bool:
        """Put one already-started process, and everything it starts, in this job."""
        if not self.ok or os.name != "nt":
            return False
        try:
            import ctypes
            kernel32 = _kernel32()
            process = kernel32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False,
                                           int(pid))
            if not process:
                self.reason = f"OpenProcess failed ({ctypes.get_last_error()})"
                return False
            try:
                if not kernel32.AssignProcessToJobObject(self.handle, process):
                    # A host that already put DGC in a job that forbids nesting lands here; the
                    # caller falls back to taskkill rather than leaving the tree unkillable.
                    self.reason = f"AssignProcessToJobObject failed ({ctypes.get_last_error()})"
                    return False
            finally:
                kernel32.CloseHandle(process)
            return True
        except (ImportError, AttributeError, OSError) as exc:   # pragma: no cover - Windows only
            self.reason = f"{type(exc).__name__}: {exc}"
            return False

    def terminate(self, code: int = 1) -> bool:
        """End every process in the job."""
        if not self.ok or self.handle is None or os.name != "nt":
            return False
        try:
            return bool(_kernel32().TerminateJobObject(self.handle, int(code)))
        except (ImportError, AttributeError, OSError):          # pragma: no cover - Windows only
            return False

    def close(self) -> None:
        """Drop the handle. With kill-on-close that also ends whatever is still running."""
        handle, self.handle = self.handle, None
        self.ok = False
        if handle is None or os.name != "nt":
            return
        try:
            _kernel32().CloseHandle(handle)
        except (ImportError, AttributeError, OSError):          # pragma: no cover - Windows only
            pass


def taskkill_tree(pid: int, *, timeout: float = 10.0) -> bool:
    """``taskkill /T /F`` on one pid: the fallback when a job is not available.

    taskkill.exe is named by absolute path: a ``taskkill.exe`` earlier on PATH, in the workspace
    the agent has been editing, must never be what ends a process tree.
    """
    if os.name != "nt":
        return False
    root = os.environ.get("SystemRoot") or r"C:\Windows"
    executable = os.path.join(root, "System32", "taskkill.exe")
    if not os.path.isfile(executable):
        return False
    try:
        done = subprocess.run([executable, "/T", "/F", "/PID", str(int(pid))],
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=timeout)
        return done.returncode == 0
    except (OSError, ValueError, subprocess.SubprocessError):
        return False
