"""Best-effort OS sandbox for the bash tool — opt-in via config `sandbox: true`.

On Linux with bubblewrap (`bwrap`) or macOS with `sandbox-exec`, a shell command runs with the
filesystem READ-ONLY except the project directory and /tmp (network stays allowed). Because a
confined command can't touch the rest of your machine, DGC auto-approves bash while the sandbox
is active. If no sandbox tool is installed we fall back to running unsandboxed (with a notice) —
we never pretend to confine something we can't.
"""
from __future__ import annotations

import shutil
import sys


def available() -> str | None:
    if shutil.which("bwrap"):
        return "bwrap"
    if sys.platform == "darwin" and shutil.which("sandbox-exec"):
        return "sandbox-exec"
    return None


def active(config) -> bool:
    return bool(config and config.get("sandbox")) and available() is not None


def wrap(command: str, project_root) -> list[str] | None:
    """An argv that runs `command` inside the sandbox — writable: project dir + /tmp, everything
    else read-only, network allowed. None if no sandbox tool is available."""
    kind = available()
    root = str(project_root)
    if kind == "bwrap":
        return [
            "bwrap",
            "--ro-bind", "/", "/",                 # whole filesystem read-only …
            "--dev", "/dev", "--proc", "/proc",
            "--bind", root, root,                  # … except the project directory (writable)
            "--bind", "/tmp", "/tmp",              # … and /tmp
            "--tmpfs", "/run",
            "--unshare-uts", "--unshare-ipc", "--die-with-parent",
            "--chdir", root,
            "/bin/bash", "-c", command,
        ]
    if kind == "sandbox-exec":
        profile = (
            "(version 1)(allow default)(deny file-write*)"
            f'(allow file-write* (subpath "{root}") (subpath "/tmp") (subpath "/private/tmp") '
            '(literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") '
            '(literal "/dev/dtracehelper") (subpath "/dev/fd"))'
        )
        return ["sandbox-exec", "-p", profile, "/bin/bash", "-c", command]
    return None
