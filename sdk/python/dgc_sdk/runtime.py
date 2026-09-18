"""Find and launch an isolated ``dgc serve`` child. Host ~/.dgc is not used unless inherited.

Discovery order (the first runtime that imports DGC and speaks this SDK's protocol wins):

1. ``DGC_PYTHON`` or ``DGC_RUNTIME_PYTHON``: that interpreter runs ``-m dgc serve``.
2. The Python running this SDK, when it can import DGC itself.
3. From a source checkout only: the checkout's ``.venv``.
4. The installed CLI: ``dgc`` on ``PATH``, then ``~/.local/bin/dgc`` (the vibedgc.com installer),
   then the newest complete version in the installer's data directory. It runs as ``dgc serve``.

The child gets a small environment: the names in :data:`BASE_ENV`, the isolated HOME and XDG
directories, and what the application passes on purpose (``api_key``, ``extra_env``,
``inherit_env``). Nothing from the application's own site-packages is put on its PYTHONPATH.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import re
import shutil
import site
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from ._version import PROTOCOL, REQUIRES_CLI, __version__
from .errors import DGCConfigError, DGCProtocolError

log = logging.getLogger("dgc_sdk")

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SDK_ROOT = Path(__file__).resolve().parents[1]

#: Host variables every runtime child receives. They locate programs, set the language and time
#: zone, name temp and certificate locations, and on Windows let a process start at all. None of
#: them is a credential. Everything else stays with the application unless it is passed on
#: purpose through ``inherit_env`` or ``extra_env``.
BASE_ENV = frozenset({
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
    "LC_MESSAGES", "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "LC_MONETARY", "TERM", "COLORTERM",
    "NO_COLOR", "TZ", "TMPDIR", "TEMP", "TMP", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
    "PATHEXT",
})
# With inherit_user_state=True the child is the user's own DGC: it keeps their DGC_* settings
# and XDG/Windows profile locations.
_USER_STATE_PREFIXES = ("DGC_", "XDG_")
_USER_STATE_NAMES = frozenset({"USERPROFILE", "APPDATA", "LOCALAPPDATA"})
_SECRET_ENV = ("DGC_API_KEY", "DGC_SEARCH_API_KEY", "DGC_SUBAGENT_API_KEY",
               "DGC_FALLBACK_API_KEY")

_PROBE = (
    "import sys\n"
    "if sys.path and sys.path[0] == '':\n"
    "    del sys.path[0]\n"
    "import dgc, dgc.cli, dgc.headless, dgc.editor_protocol as p\n"
    "sys.stdout.write('%s %s %d %d' % (p.PROTOCOL_VERSION, getattr(dgc, '__version__', '?'),"
    " sys.version_info[0], sys.version_info[1]))\n"
)
_PROBE_TIMEOUT_S = 30.0


def repo_root() -> Path:
    return _REPO_ROOT


def sdk_root() -> Path:
    return _SDK_ROOT


def is_checkout() -> bool:
    """True when this SDK is imported from a DGC source tree rather than an installed wheel."""
    return ((_REPO_ROOT / "dgc" / "headless.py").is_file()
            and _SDK_ROOT == _REPO_ROOT / "sdk" / "python")


@dataclass(frozen=True)
class RuntimeSpec:
    """A ``dgc serve`` the SDK can launch, and what it needs to start."""

    argv: tuple[str, ...]
    #: The interpreter that runs DGC, when known.
    python: str = ""
    #: Import roots the runtime needs on PYTHONPATH (only a source checkout or a clone the
    #: application itself imports DGC from; never the application's site-packages).
    pythonpath: tuple[str, ...] = ()
    #: Where discovery found it, for messages.
    source: str = ""
    version: str = ""
    protocol: int | None = None
    notes: tuple[str, ...] = field(default=(), compare=False)


_CACHE: dict[tuple, RuntimeSpec] = {}


def _base_env(source: Mapping[str, str] | None = None) -> dict[str, str]:
    source = os.environ if source is None else source
    return {key: value for key, value in source.items() if key.upper() in BASE_ENV}


def _probe(python: str, pythonpath: Sequence[str]) -> tuple[int, str, tuple[int, int]] | str:
    """(protocol, CLI version, Python version) when ``python`` can serve DGC, else why not."""
    if not python or not os.path.isfile(python) or not os.access(python, os.X_OK):
        return "not an executable file"
    env = _base_env()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if pythonpath:
        env["PYTHONPATH"] = os.pathsep.join(pythonpath)
    try:
        done = subprocess.run(
            [python, "-c", _PROBE], env=env, cwd=str(Path(python).resolve().parent),
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=_PROBE_TIMEOUT_S)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return f"could not run it ({exc})"
    if done.returncode != 0:
        last = (done.stderr or "").strip().splitlines()[-1:] or [f"exit {done.returncode}"]
        return f"cannot import dgc ({last[0][:200]})"
    parts = (done.stdout or "").split()
    try:
        return int(parts[0]), parts[1], (int(parts[2]), int(parts[3]))
    except (IndexError, ValueError):
        return "gave an unreadable answer"


def _python_argv(python: str, py_version: tuple[int, int]) -> tuple[str, ...]:
    # ``-m`` puts the working directory (the session cwd) first on sys.path, so a project with
    # its own ``dgc/`` package would replace the runtime. -P (Python 3.11+) turns that off.
    if py_version >= (3, 11):
        return (python, "-P", "-m", "dgc", "serve")
    return (python, "-m", "dgc", "serve")


def _current_python_roots() -> tuple[str, ...] | None:
    """Where this interpreter imports ``dgc`` from, as extra roots; None when it cannot."""
    try:
        spec = importlib.util.find_spec("dgc")
    except (ImportError, ValueError):
        return None
    if spec is None or not spec.submodule_search_locations:
        return None
    root = Path(list(spec.submodule_search_locations)[0]).resolve().parent
    installed = set()
    try:
        entries = list(site.getsitepackages()) + [site.getusersitepackages()]
    except AttributeError:          # very old virtualenv site.py
        entries = [path for path in sys.path if path.endswith("site-packages")]
    for entry in entries:
        try:
            installed.add(Path(entry).resolve())
        except (OSError, RuntimeError):
            continue
    return () if root in installed else (str(root),)


def _launcher_python(launcher: Path) -> str:
    """The Python behind an installed ``dgc`` console script, or ''."""
    try:
        real = Path(os.path.realpath(launcher))
        with open(real, "rb") as handle:
            head = handle.read(4096).decode("utf-8", errors="replace").splitlines()
    except OSError:
        head, real = [], Path(os.path.realpath(launcher))
    if head and head[0].startswith("#!"):
        words = head[0][2:].strip().split()
        candidate = words[0] if words else ""
        if candidate.endswith("/sh") and len(head) > 1:
            # pip's wrapper for long interpreter paths: '''exec' "/path/python" "$0" "$@"
            match = re.search(r"exec'\s+\"?([^\"\s]+)", head[1])
            candidate = match.group(1) if match else ""
        elif candidate.endswith("/env") and len(words) > 1:
            candidate = shutil.which(words[1]) or ""
        if (candidate and Path(candidate).name.lower().startswith("python")
                and os.path.isfile(candidate)):
            return candidate
    for name in ("python3", "python", "python.exe"):
        sibling = real.parent / name
        if sibling.is_file():
            return str(sibling)
    return ""


def _version_key(name: str) -> tuple:
    return tuple(int(part) if part.isdigit() else -1 for part in re.split(r"[.+-]", name))


def _installed_launchers(env: Mapping[str, str], home: Path) -> list[tuple[Path, str]]:
    found: list[tuple[Path, str]] = []
    on_path = shutil.which("dgc", path=env.get("PATH") or os.defpath)
    if on_path:
        found.append((Path(on_path), "dgc on PATH"))
    found.append((home / ".local" / "bin" / "dgc", "~/.local/bin/dgc"))
    data_dirs = []
    if env.get("DGC_DATA_DIR"):
        data_dirs.append(Path(env["DGC_DATA_DIR"]).expanduser())
    xdg = env.get("XDG_DATA_HOME", "")
    share = Path(xdg) if xdg and os.path.isabs(xdg) else home / ".local" / "share"
    data_dirs.append(share / "dgc")
    for data in data_dirs:
        try:
            names = [entry.name for entry in (data / "versions").iterdir() if entry.is_dir()]
        except OSError:
            continue
        complete = []
        for name in names:
            try:
                marker = (data / "versions" / name / ".complete").read_text(encoding="utf-8")
            except OSError:
                continue
            if f"version={name}" in marker.splitlines():
                complete.append(name)
        for name in sorted(complete, key=_version_key, reverse=True):
            found.append((data / "versions" / name / ".venv" / "bin" / "dgc",
                          f"installed DGC {name}"))
    seen: set[str] = set()
    unique = []
    for launcher, label in found:
        key = os.path.realpath(launcher)
        if key not in seen and os.path.isfile(launcher):
            seen.add(key)
            unique.append((launcher, label))
    return unique


def discover_runtime(env: Mapping[str, str] | None = None, *, home: Path | None = None,
                     use_current: bool = True, checkout: bool | None = None) -> RuntimeSpec:
    """Find a ``dgc serve`` this SDK can drive.

    Raises :class:`DGCProtocolError` when every DGC found speaks another protocol (with the
    advice to update the CLI or dgc-sdk), and :class:`DGCConfigError` when none was found.
    """
    env = os.environ if env is None else env
    home = Path.home() if home is None else home
    checkout = is_checkout() if checkout is None else checkout
    key = (env.get("DGC_PYTHON"), env.get("DGC_RUNTIME_PYTHON"), env.get("PATH"), str(home),
           use_current, checkout)
    cached = _CACHE.get(key)
    if cached is not None and os.path.exists(cached.argv[0]):
        return cached
    tree_path = (str(_REPO_ROOT),) if checkout else ()
    candidates: list[tuple[str, str, tuple[str, ...], tuple[str, ...] | None]] = []
    for name in ("DGC_PYTHON", "DGC_RUNTIME_PYTHON"):
        if env.get(name):
            candidates.append((name, env[name], tree_path, None))
    if use_current:
        roots = _current_python_roots()
        if roots is not None or checkout:
            candidates.append(("this Python", sys.executable, tuple(dict.fromkeys(
                tree_path + (roots or ()))), None))
    if checkout:
        for rel in (("bin", "python"), ("Scripts", "python.exe")):
            venv = _REPO_ROOT.joinpath(".venv", *rel)
            if venv.is_file():
                candidates.append(("this checkout's .venv", str(venv), tree_path, None))
    for launcher, label in _installed_launchers(env, home):
        python = _launcher_python(launcher)
        if python:
            candidates.append((f"{label} ({launcher})", python, (), (str(launcher), "serve")))

    notes: list[str] = []
    offered: list[int] = []
    for label, python, pythonpath, launch in candidates:
        answer = _probe(python, pythonpath)
        if isinstance(answer, str):
            notes.append(f"{label} {python}: {answer}")
            continue
        protocol, version, py_version = answer
        if protocol != PROTOCOL:
            offered.append(protocol)
            if protocol > PROTOCOL:
                notes.append(f"{label} {python}: DGC {version} speaks protocol v{protocol}, "
                             f"newer than this SDK's v{PROTOCOL}")
            else:
                notes.append(f"{label} {python}: DGC {version} speaks protocol v{protocol}, "
                             f"this SDK needs v{PROTOCOL} (CLI {REQUIRES_CLI} or newer)")
            continue
        spec = RuntimeSpec(
            argv=launch or _python_argv(python, py_version), python=python,
            pythonpath=pythonpath, source=label, version=version, protocol=protocol,
            notes=tuple(notes))
        explicit = [note for note in notes if note.startswith(("DGC_PYTHON ", "DGC_RUNTIME_PYTHON "))]
        if explicit:
            log.warning("dgc_sdk: %s; using %s instead", explicit[0], label)
        _CACHE[key] = spec
        return spec
    detail = "; ".join(notes) if notes else "no candidates"
    if offered:
        if all(protocol > PROTOCOL for protocol in offered):
            advice = "Upgrade dgc-sdk (pip install -U dgc-sdk) to drive this CLI."
        else:
            advice = ("Update the CLI (dgc update), or point DGC_PYTHON or runtime= at a DGC "
                      f"that is {REQUIRES_CLI} or newer.")
        raise DGCProtocolError(
            f"DGC SDK {__version__} speaks protocol v{PROTOCOL} and needs CLI {REQUIRES_CLI} or "
            f"newer, but no DGC found speaks it. {advice} Looked at: {detail}")
    raise DGCConfigError(
        "no DGC runtime found. Install the CLI (curl -fsSL https://vibedgc.com/install.sh | bash) "
        "or set DGC_PYTHON to a Python that can import dgc, or pass runtime=[...]. "
        f"Looked at: {detail}")


def default_runtime_argv() -> list[str]:
    """The argv of :func:`discover_runtime`."""
    return list(discover_runtime().argv)


def runtime_for_argv(argv: Sequence[str]) -> RuntimeSpec:
    """Describe an explicit ``runtime=`` argv. Nothing is probed; the caller chose it."""
    words = tuple(str(item) for item in argv)
    python = ""
    if len(words) >= 3 and "-m" in words[1:4]:
        python = words[0]
    return RuntimeSpec(argv=words, python=python,
                       pythonpath=(str(_REPO_ROOT),) if is_checkout() else (),
                       source="runtime=")


def isolated_env(state_dir: Path, *, extra: Mapping[str, str] | None = None,
                 inherit_user_state: bool = False,
                 project_root: Path | None = None,
                 pythonpath: Sequence[str] = (),
                 inherit_env: bool | Sequence[str] = False,
                 host_env: Mapping[str, str] | None = None) -> dict[str, str]:
    """The runtime child's environment.

    ``inherit_env=False`` (the default) passes only :data:`BASE_ENV`. A sequence of names adds
    those host variables. ``True`` passes the whole host environment, as SDK 0.5.2 did. In
    isolated mode the host's DGC_*_API_KEY values are never passed implicitly, and HOME, DGC_HOME
    and the XDG directories point into ``state_dir``.
    """
    source = os.environ if host_env is None else host_env
    if inherit_env is True:
        env = dict(source)
    else:
        env = _base_env(source)
        if inherit_user_state:
            env.update({key: value for key, value in source.items()
                        if key.upper().startswith(_USER_STATE_PREFIXES)
                        or key.upper() in _USER_STATE_NAMES})
        if inherit_env:
            if isinstance(inherit_env, (str, bytes)):
                raise DGCConfigError("inherit_env must be a bool or a sequence of variable names")
            for name in inherit_env:
                if not isinstance(name, str) or not name or "=" in name or "\0" in name:
                    raise DGCConfigError(f"inherit_env has an invalid variable name: {name!r}")
                if name in source:
                    env[name] = source[name]
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if not inherit_user_state:
        if inherit_env is True:
            for key in _SECRET_ENV:
                env.pop(key, None)
        home = state_dir / "home"
        (home / ".dgc").mkdir(parents=True, exist_ok=True)
        (home / ".config").mkdir(parents=True, exist_ok=True)
        (home / ".local" / "share").mkdir(parents=True, exist_ok=True)
        (home / ".local" / "state").mkdir(parents=True, exist_ok=True)
        env["HOME"] = str(home)
        env["USERPROFILE"] = str(home)
        env["DGC_HOME"] = str(home)
        env["DGC_SDK_ISOLATED"] = "1"
        if project_root is not None:
            env["DGC_PROJECT_ROOT"] = str(Path(project_root).resolve())
        env["XDG_CONFIG_HOME"] = str(home / ".config")
        env["XDG_DATA_HOME"] = str(home / ".local" / "share")
        env["XDG_STATE_HOME"] = str(home / ".local" / "state")
    if extra:
        env.update(extra)
    path_parts = list(dict.fromkeys(str(item) for item in pythonpath if item))
    if env.get("PYTHONPATH"):
        path_parts.append(env["PYTHONPATH"])
    if path_parts:
        env["PYTHONPATH"] = os.pathsep.join(path_parts)
    return env
