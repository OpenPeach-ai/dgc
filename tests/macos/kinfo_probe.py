"""Review probe: can a confined command read process records of processes outside it?

strict-v1's sysctl allow-list keeps `kern.proc.pid.` and `kern.proc.pgrp.` (inherited from the
Codex/Chromium list) while dropping kern.proc.all. `ps` is setgid and cannot be exec'd from ANY
sandbox (it failed under the old allow-by-default profile too), so the shipped probes never
exercise the sysctl route. Always exits 0; the verdict is the first line of output.
"""
import ctypes
import os
import sys

libc = ctypes.CDLL(None)


def sysctl(mib):
    arr = (ctypes.c_int * len(mib))(*mib)
    size = ctypes.c_size_t(0)
    if libc.sysctl(arr, len(mib), None, ctypes.byref(size), None, 0) != 0:
        return None
    buf = ctypes.create_string_buffer(size.value + 8192)
    got = ctypes.c_size_t(len(buf))
    if libc.sysctl(arr, len(mib), buf, ctypes.byref(got), None, 0) != 0:
        return None
    return buf.raw[:got.value]


pid = int(sys.argv[1])
one = sysctl([1, 14, 1, pid])           # CTL_KERN, KERN_PROC, KERN_PROC_PID, <pid>
allp = sysctl([1, 14, 0, 0])            # KERN_PROC_ALL
uidp = sysctl([1, 14, 5, os.getuid()])  # KERN_PROC_UID
count = ctypes.c_int(0)
try:
    count.value = libc.proc_listpids(1, 0, None, 0)   # PROC_ALL_PIDS
except Exception:
    count.value = -1
found = bool(one) and b"sleep" in one
print("VERDICT", "outside-process-visible" if found else "hidden")
print("PID_RECORD", "yes" if found else "no", len(one or b""))
print("ALL_RECORDS", "yes" if allp and len(allp) > 2000 else "no", len(allp or b""))
print("UID_RECORDS", "yes" if uidp and len(uidp) > 2000 else "no", len(uidp or b""))
print("LISTPIDS_BYTES", count.value)
