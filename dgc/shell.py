"""Which shell DGC runs tool commands with, on every platform it supports.

Every shell tool (``bash``, ``monitor``, hooks, the agent's verify command) used to hard-code
``/bin/bash``. That path does not exist on Windows, so each of those tools failed with
``[WinError 2]`` before it ran anything. This module resolves one shell once and hands the same
argv shape back to all of them.

On Windows the only supported shell is the bash that ships with Git for Windows. It is never
``%SystemRoot%\\System32\\bash.exe``: that file is the WSL launcher, so running a command through
it would silently move the work into a Linux distribution with a different filesystem, a
different user and none of DGC's path boundaries.
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

#: Shown when nothing usable was found on Windows. The SDK repeats this sentence, so the two
#: must stay identical; see the platform contract for 0.41.9.
WINDOWS_MISSING_BASH = ("no bash found: install Git for Windows "
                        "(https://git-scm.com/download/win)")
POSIX_MISSING_BASH = "no bash found: install bash and make sure it is on PATH"

#: An explicit override, for tests and for an unusual install. It must name an executable file,
#: and on Windows it is rejected when it is the WSL launcher, exactly like a PATH hit.
SHELL_ENV = "DGC_BASH"


class ShellUnavailable(RuntimeError):
    """No usable shell on this machine. ``str(...)`` is the user-facing sentence."""


@dataclass(frozen=True)
class Shell:
    """The resolved shell: ``kind`` is None when there is none, and ``path`` is then ""."""

    path: str
    kind: str | None
    reason: str

    @property
    def available(self) -> bool:
        return self.kind is not None

    def capability(self) -> dict:
        """The ``capabilities.shell`` object of the ready frame (protocol v14, additive)."""
        return {"path": self.path, "kind": self.kind, "reason": self.reason}


# Directories whose ``bash.exe`` is the WSL launcher rather than a shell we can run a command in.
# Sysnative is the 32-bit process's view of System32; SysWOW64 is the 64-bit process's view of the
# 32-bit system directory. All three spell the same launcher.
_WSL_DIRS = ("system32", "sysnative", "syswow64")


def is_wsl_launcher(candidate: Path | str) -> bool:
    """Whether this path is Windows' own ``bash.exe``, which starts a WSL distribution.

    Deliberately independent of the host OS so it can be tested anywhere: the parent directory's
    name is the whole test, and a Windows path parses the same way everywhere.
    """
    import ntpath
    text = str(candidate)
    name = ntpath.basename(text).lower()
    if name not in ("bash.exe", "bash", "wsl.exe"):
        return False
    return ntpath.basename(ntpath.dirname(text)).lower() in _WSL_DIRS


def _usable(candidate: Path | str | None) -> Path | None:
    if not candidate:
        return None
    path = Path(candidate)
    try:
        if not path.is_file() or not os.access(path, os.X_OK):
            return None
    except (OSError, ValueError):
        return None
    if os.name == "nt" and is_wsl_launcher(path):
        return None
    return path


def windows_candidates(env) -> list[str]:
    """Where a Git for Windows bash is looked for, in order. Pure: no filesystem is touched."""
    return [str(item) for item in _windows_candidates(env)]


def _windows_candidates(env) -> list[Path]:
    import ntpath
    found: list[Path] = []

    def add(value) -> None:
        if value:
            found.append(Path(value))

    for variable in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
        root = env.get(variable)
        if root:
            add(ntpath.join(root, "Git", "bin", "bash.exe"))
    local = env.get("LOCALAPPDATA")
    if local:
        add(ntpath.join(local, "Programs", "Git", "bin", "bash.exe"))
    add(r"C:\Program Files\Git\bin\bash.exe")
    # Wherever git itself came from: Git for Windows installs git.exe in <root>\cmd and
    # <root>\mingw64\bin, and bash.exe in <root>\bin.
    git = shutil.which("git", path=env.get("PATH"))
    if git:
        directory = ntpath.dirname(git)
        for root in (ntpath.dirname(directory), ntpath.dirname(ntpath.dirname(directory))):
            add(ntpath.join(root, "bin", "bash.exe"))
    # PATH last: a bash on PATH is usually the same Git for Windows one, and _usable() drops the
    # WSL launcher that Windows puts in System32.
    on_path = shutil.which("bash", path=env.get("PATH"))
    if on_path:
        add(on_path)
    return found


def _posix_candidates(env) -> list[Path]:
    found = [Path("/bin/bash")]
    on_path = shutil.which("bash", path=env.get("PATH"))
    if on_path:
        found.append(Path(on_path))
    found.append(Path("/usr/bin/bash"))
    return found


def _resolve(env) -> Shell:
    override = env.get(SHELL_ENV, "").strip()
    if override:
        usable = _usable(override)
        if usable is not None:
            kind = "git-bash" if os.name == "nt" else "bash"
            return Shell(path=str(usable), kind=kind, reason="")
        missing = WINDOWS_MISSING_BASH if os.name == "nt" else POSIX_MISSING_BASH
        return Shell(path="", kind=None,
                     reason=f"{SHELL_ENV}={override!r} is not a usable shell — {missing}")
    windows = os.name == "nt"
    candidates = _windows_candidates(env) if windows else _posix_candidates(env)
    for candidate in candidates:
        usable = _usable(candidate)
        if usable is not None:
            return Shell(path=str(usable), kind="git-bash" if windows else "bash", reason="")
    return Shell(path="", kind=None,
                 reason=WINDOWS_MISSING_BASH if windows else POSIX_MISSING_BASH)


_CACHE: tuple[tuple, Shell] | None = None
_CACHE_KEYS = (SHELL_ENV, "PATH", "ProgramFiles", "ProgramW6432", "ProgramFiles(x86)",
               "LOCALAPPDATA", "SystemRoot")


def _cache_key(env) -> tuple:
    return tuple(env.get(name, "") for name in _CACHE_KEYS)


def resolve(env=None) -> Shell:
    """The shell this machine runs tool commands with. Cached per relevant environment."""
    global _CACHE
    environment = os.environ if env is None else env
    key = _cache_key(environment)
    if _CACHE is not None and _CACHE[0] == key:
        return _CACHE[1]
    shell = _resolve(environment)
    _CACHE = (key, shell)
    return shell


def reset_cache() -> None:
    """Forget the resolved shell (tests change the environment between resolutions)."""
    global _CACHE
    _CACHE = None


def path() -> str | None:
    """The absolute path of the shell, or None when this machine has none."""
    shell = resolve()
    return shell.path or None


def argv(command: str, *, pipefail: bool = True, login: bool = False) -> list[str]:
    """The argv that runs ``command`` in this machine's shell.

    Raises :class:`ShellUnavailable` with a sentence a user can act on when there is none, so a
    caller reports the missing shell instead of a bare ``FileNotFoundError``.
    """
    shell = resolve()
    if not shell.available:
        raise ShellUnavailable(shell.reason)
    options = ["-o", "pipefail"] if pipefail else []
    if login:
        options = ["-l"] + options
    return [shell.path, *options, "-c", command]


def capability() -> dict:
    """``capabilities.shell`` for the ready frame."""
    return resolve().capability()


def missing_reason() -> str:
    """"" when a shell is available, otherwise the sentence explaining what to install."""
    shell = resolve()
    return "" if shell.available else shell.reason
