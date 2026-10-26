"""macOS process facts through ``/usr/lib/libproc.dylib``: no helper process, no task port.

macOS has no ``/proc`` and no per-tree process namespace, and the kernel rejects finite
``RLIMIT_AS``/``RLIMIT_DATA`` values. Parent-side sampling is therefore how DGC observes a
child's memory and descendants there (the PDF worker's RSS watchdog, the Pips Seatbelt runner).
Every call is one bounded syscall against a public libproc ABI.
"""
from __future__ import annotations

import ctypes
from typing import NamedTuple

LIBRARY = "/usr/lib/libproc.dylib"   # absolute: find_library may spawn helpers
PROC_PIDTBSDINFO = 3
PROC_PIDTASKINFO = 4
PROC_PIDLISTFDS = 1
PROC_PIDFDPIPEINFO = 6
PROX_FDTYPE_PIPE = 6
PROC_UID_ONLY = 4
RUSAGE_INFO_V0 = 0
_ESRCH = 3


class TaskInfo(ctypes.Structure):
    # Public proc_taskinfo ABI: six uint64 fields, then twelve int32.
    _fields_ = [(name, ctypes.c_uint64) for name in (
        'virtual_size', 'resident_size', 'total_user', 'total_system', 'threads_user', 'threads_system'
    )] + [(name, ctypes.c_int32) for name in (
        'policy', 'faults', 'pageins', 'cow_faults', 'messages_sent', 'messages_received',
        'syscalls_mach', 'syscalls_unix', 'csw', 'threadnum', 'numrunning', 'priority'
    )]


class BSDInfo(ctypes.Structure):
    # Public proc_bsdinfo ABI (136 bytes).
    _fields_ = [(name, ctypes.c_uint32) for name in (
        'pbi_flags', 'pbi_status', 'pbi_xstatus', 'pbi_pid', 'pbi_ppid', 'pbi_uid', 'pbi_gid',
        'pbi_ruid', 'pbi_rgid', 'pbi_svuid', 'pbi_svgid', 'rfu_1')] + [
        ('pbi_comm', ctypes.c_char * 16), ('pbi_name', ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32) for name in ('pbi_nfiles', 'pbi_pgid', 'pbi_pjobc', 'e_tdev', 'e_tpgid')] + [
        ('pbi_nice', ctypes.c_int32), ('pbi_start_tvsec', ctypes.c_uint64), ('pbi_start_tvusec', ctypes.c_uint64)]


class RusageInfo(ctypes.Structure):
    # Public rusage_info_v0 ABI (96 bytes).
    _fields_ = [('ri_uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        'ri_user_time', 'ri_system_time', 'ri_pkg_idle_wkups', 'ri_interrupt_wkups', 'ri_pageins',
        'ri_wired_size', 'ri_resident_size', 'ri_phys_footprint', 'ri_proc_start_abstime',
        'ri_proc_exit_abstime')]


class FdInfo(ctypes.Structure):
    # Public proc_fdinfo ABI (8 bytes).
    _fields_ = [('proc_fd', ctypes.c_int32), ('proc_fdtype', ctypes.c_uint32)]


class _FileInfo(ctypes.Structure):
    # Public proc_fileinfo ABI (24 bytes).
    _fields_ = [('fi_openflags', ctypes.c_uint32), ('fi_status', ctypes.c_uint32), ('fi_offset', ctypes.c_int64),
                ('fi_type', ctypes.c_int32), ('fi_guardflags', ctypes.c_uint32)]


class _VinfoStat(ctypes.Structure):
    # Public vinfo_stat ABI (136 bytes).
    _fields_ = [('vst_dev', ctypes.c_uint32), ('vst_mode', ctypes.c_uint16), ('vst_nlink', ctypes.c_uint16),
                ('vst_ino', ctypes.c_uint64), ('vst_uid', ctypes.c_uint32), ('vst_gid', ctypes.c_uint32)] + [
        (name, ctypes.c_int64) for name in (
            'vst_atime', 'vst_atimensec', 'vst_mtime', 'vst_mtimensec', 'vst_ctime', 'vst_ctimensec',
            'vst_birthtime', 'vst_birthtimensec', 'vst_size', 'vst_blocks')] + [
        ('vst_blksize', ctypes.c_int32), ('vst_flags', ctypes.c_uint32), ('vst_gen', ctypes.c_uint32),
        ('vst_rdev', ctypes.c_uint32), ('vst_qspare', ctypes.c_int64 * 2)]


class PipeFdInfo(ctypes.Structure):
    # Public pipe_fdinfo ABI (184 bytes): proc_fileinfo, then pipe_info (its vinfo_stat, the end's own handle,
    # the other end's handle, status). The handles name pipe ends as the kernel does, the same in every process.
    _fields_ = [('pfi', _FileInfo), ('pipe_stat', _VinfoStat), ('pipe_handle', ctypes.c_uint64),
                ('pipe_peerhandle', ctypes.c_uint64), ('pipe_status', ctypes.c_int32), ('rfu_1', ctypes.c_int32)]


class Identity(NamedTuple):
    pid: int
    ppid: int
    pgid: int
    uid: int
    start: float   # seconds since the epoch; with the pid, identifies one process instance


class Libproc:
    def __init__(self) -> None:
        library = ctypes.CDLL(LIBRARY, use_errno=True)
        self._pidinfo = library.proc_pidinfo
        self._pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self._pidinfo.restype = ctypes.c_int
        self._children = library.proc_listchildpids
        self._group = library.proc_listpgrppids
        for function in (self._children, self._group):
            function.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
            function.restype = ctypes.c_int
        self._rusage = library.proc_pid_rusage
        self._rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        self._rusage.restype = ctypes.c_int
        self._listpids = library.proc_listpids
        self._listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
        self._listpids.restype = ctypes.c_int
        self._fdinfo = library.proc_pidfdinfo
        self._fdinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        self._fdinfo.restype = ctypes.c_int
        self._task = TaskInfo()

    def task_resident(self, pid: int) -> int:
        """Current resident size from PROC_PIDTASKINFO; OSError when it cannot be read."""
        size = ctypes.sizeof(self._task)
        received = self._pidinfo(pid, PROC_PIDTASKINFO, 0, ctypes.byref(self._task), size)
        if received != size:
            raise OSError(ctypes.get_errno(), 'could not sample child RSS')
        return int(self._task.resident_size)

    def identity(self, pid: int) -> Identity | None:
        """A live process's identity, or None once it has exited (a zombie included)."""
        info = BSDInfo()
        size = ctypes.sizeof(info)
        ctypes.set_errno(0)
        received = self._pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), size)
        if received != size:
            error = ctypes.get_errno()
            if error == _ESRCH:
                return None
            raise OSError(error, 'could not read process identity')
        return Identity(int(info.pbi_pid), int(info.pbi_ppid), int(info.pbi_pgid), int(info.pbi_uid),
                        int(info.pbi_start_tvsec) + int(info.pbi_start_tvusec) / 1_000_000)

    def memory(self, pid: int) -> int | None:
        """Larger of resident size and physical footprint (which counts compressed pages).

        None once the process is gone; OSError when a live process cannot be sampled.
        """
        info = RusageInfo()
        if self._rusage(pid, RUSAGE_INFO_V0, ctypes.byref(info)) != 0:
            error = ctypes.get_errno()
            if error == _ESRCH:
                return None
            raise OSError(error, 'could not sample process memory')
        return max(int(info.ri_resident_size), int(info.ri_phys_footprint))

    def _list(self, function, key: int, capacity: int) -> list[int]:
        buffer = (ctypes.c_int * capacity)()
        count = function(key, buffer, ctypes.sizeof(buffer))
        if count < 0:
            raise OSError(ctypes.get_errno(), 'could not list processes')
        # The count saturates at the buffer's capacity; a caller that sees `capacity` entries
        # must treat the list as possibly incomplete.
        return [pid for pid in buffer[:min(count, capacity)] if pid > 0]

    def children(self, pid: int, capacity: int) -> list[int]:
        return self._list(self._children, pid, capacity)

    def group(self, pgid: int, capacity: int) -> list[int]:
        return self._list(self._group, pgid, capacity)

    def uid_pids(self, uid: int, capacity: int) -> list[int]:
        """The processes whose effective user is UID (at most CAPACITY)."""
        buffer = (ctypes.c_int * capacity)()
        size = self._listpids(PROC_UID_ONLY, uid, buffer, ctypes.sizeof(buffer))   # in bytes, unlike the two above
        if size < 0:
            raise OSError(ctypes.get_errno(), 'could not list processes')
        return [pid for pid in buffer[:min(size // ctypes.sizeof(ctypes.c_int), capacity)] if pid > 0]

    def pipe_end(self, pid: int, fd: int) -> tuple[int, int] | None:
        """(this end's handle, the other end's) for a pipe open as FD in PID; None when it is not one, or gone."""
        info = PipeFdInfo()
        if self._fdinfo(pid, fd, PROC_PIDFDPIPEINFO, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
            return None
        return int(info.pipe_handle), int(info.pipe_peerhandle)

    def pipe_ends(self, pid: int, capacity: int = 1024) -> list[tuple[int, int]]:
        """Every pipe end PID holds open, as pipe_end() names them; [] once it is gone or can't be read."""
        buffer = (FdInfo * capacity)()
        size = self._pidinfo(pid, PROC_PIDLISTFDS, 0, ctypes.byref(buffer), ctypes.sizeof(buffer))
        if size <= 0:
            return []
        ends = []
        for entry in buffer[:min(size // ctypes.sizeof(FdInfo), capacity)]:
            if entry.proc_fdtype == PROX_FDTYPE_PIPE:
                end = self.pipe_end(pid, entry.proc_fd)
                if end is not None:
                    ends.append(end)
        return ends
