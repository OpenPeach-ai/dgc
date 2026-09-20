"""Review probe: what can a confined command learn about processes OUTSIDE the sandbox?

strict-v1 allows `process-info*` and `signal` only for `(target same-sandbox)` and keeps an
allow-list for sysctl-read. `ps` is setgid and cannot be exec'd from ANY sandbox (it failed under
the old allow-by-default profile too), so the shipped probes never exercise the raw sysctl route.
Always exits 0; the verdict is the first line of output.
"""
import ctypes
import os
import sys

libc = ctypes.CDLL(None)


def sysctl(mib):
    arr = (ctypes.c_int * len(mib))(*mib)
    size = ctypes.c_size_t(0)
    if libc.sysctl(arr, len(mib), None, ctypes.byref(size), None, 0) != 0:
        size = ctypes.c_size_t(1 << 20)          # PROCARGS2 refuses the sizing call on some builds
    buf = ctypes.create_string_buffer(size.value + 8192)
    got = ctypes.c_size_t(len(buf))
    if libc.sysctl(arr, len(mib), buf, ctypes.byref(got), None, 0) != 0:
        return None
    return buf.raw[:got.value]


pid = int(sys.argv[1])
one = sysctl([1, 14, 1, pid])           # CTL_KERN, KERN_PROC, KERN_PROC_PID, <pid>
allp = sysctl([1, 14, 0, 0])            # KERN_PROC_ALL
uidp = sysctl([1, 14, 5, os.getuid()])  # KERN_PROC_UID
args = sysctl([1, 49, pid])             # KERN_PROCARGS2: argv + environ of another process
print("SUMMARY",
      "pid_record=%s" % ("yes" if one and b"sleep" in one else "no"),
      "all_records=%s" % ("yes" if allp and len(allp) > 2000 else "no"),
      "uid_records=%s" % ("yes" if uidp and len(uidp) > 2000 else "no"),
      "procargs2=%s" % ("yes" if args else "no"),
      "env_marker=%s" % ("yes" if args and b"DGC_SEATBELT_MARK=" in args else "no"),
      "sizes=%d/%d/%d/%d" % (len(one or b""), len(allp or b""), len(uidp or b""), len(args or b"")))
