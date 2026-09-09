"""Best-effort OS sandbox for shell tools, enabled with ``sandbox: true``.

Linux uses bubblewrap with a private home/runtime/tmp view, a writable project mount,
a minimal environment, isolated process namespaces, and no network by default. macOS
uses sandbox-exec with the closest available filesystem/network policy. Permission
approval remains independent: confinement never turns an arbitrary shell string into
a trusted read-only operation. The host-side backend is resolved outside the writable
workspace, and startup-injection environment variables are never forwarded.
"""
from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

from .guards import ENV_HIJACK_BLOCKLIST


_SAFE_ENV = {
    "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TZ",
    "USER", "LOGNAME", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
}


@dataclass(frozen=True)
class SandboxCapabilities:
    """Truthful, user-visible properties of the selected host backend."""

    backend: str | None
    available: bool
    filesystem: str
    home: str
    temporary: str
    network: str
    process: str
    private_temporary: bool
    network_isolated: bool


def _backend() -> tuple[str, Path] | None:
    name = ("bwrap" if sys.platform.startswith("linux") else
            "sandbox-exec" if sys.platform == "darwin" else "")
    candidate = shutil.which(name) if name else None
    if not candidate:
        return None
    try:
        executable = Path(candidate).resolve(strict=True)
        if not executable.is_file() or not os.access(executable, os.X_OK):
            return None
    except (OSError, RuntimeError, ValueError):
        return None
    return name, executable


def available() -> str | None:
    backend = _backend()
    return backend[0] if backend else None


def capabilities(config=None) -> SandboxCapabilities:
    """Describe guarantees without treating unlike host backends as equivalent."""
    kind = available()
    network_allowed = bool(config and config.get("sandbox_network", False))
    network = "shared by explicit opt-in" if network_allowed else "isolated"
    if kind == "bwrap":
        return SandboxCapabilities(
            backend=kind,
            available=True,
            filesystem="project writable; host filesystem read-only outside masked user state",
            home="private sandbox home; ambient home hidden outside the project",
            temporary="private temporary and runtime directories",
            network=network,
            process="isolated user, PID, IPC, and UTS namespaces",
            private_temporary=True,
            network_isolated=not network_allowed,
        )
    if kind == "sandbox-exec":
        return SandboxCapabilities(
            backend=kind,
            available=True,
            filesystem="project and shared system temporary paths writable",
            home="ambient home reads denied outside the project",
            temporary="shared system temporary paths (not a private namespace)",
            network=network,
            process="host process namespace with sandbox-exec policy enforcement",
            private_temporary=False,
            network_isolated=not network_allowed,
        )
    return SandboxCapabilities(
        backend=None,
        available=False,
        filesystem="no supported OS confinement backend",
        home="not isolated",
        temporary="not isolated",
        network="not isolated",
        process="not isolated",
        private_temporary=False,
        network_isolated=False,
    )


def describe(config=None) -> str:
    """Return a compact status line suitable for the TUI and diagnostics."""
    report = capabilities(config)
    if not report.available:
        return f"unavailable on {sys.platform}; requested commands fail closed"
    if report.backend == "bwrap":
        return (f"bwrap; project writable; private home/tmp/runtime; network {report.network}; "
                "approvals unchanged")
    return (f"sandbox-exec; project + shared system temp writable; ambient home denied "
            f"outside project; network {report.network}; approvals unchanged")


def requested(config) -> bool:
    """Return whether confinement was explicitly requested, backend availability aside."""
    return bool(config and config.get("sandbox"))


def active(config) -> bool:
    return requested(config) and available() is not None


def process_env(config=None) -> dict[str, str]:
    """Return the intentionally small environment visible inside a sandbox.

    Extra names must be opted into by *name* through ``sandbox_env_allow``. This
    keeps unrelated cloud credentials and runtime injection variables out while
    still allowing a user to authorize a build-specific variable deliberately.
    """
    env = {k: v for k, v in os.environ.items() if k.upper() in _SAFE_ENV}
    configured = config.get("sandbox_env_allow", []) if config else []
    if isinstance(configured, str):
        configured = [part.strip() for part in configured.split(",") if part.strip()]
    for name in configured if isinstance(configured, (list, tuple)) else []:
        key = str(name)
        if (key in os.environ and key and "\x00" not in key and "=" not in key
                and key.upper() not in ENV_HIJACK_BLOCKLIST):
            env[key] = os.environ[key]
    env.update({"HOME": "/tmp/dgc-home", "TMPDIR": "/tmp", "TMP": "/tmp", "TEMP": "/tmp"})
    return env


def _inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _mask_with_workspace_link(argv: list[str], masked: Path, root: Path) -> None:
    """Mask a sensitive tree; reconstruct an in-tree workspace as a /mnt link."""
    if not masked.is_absolute() or not masked.exists() or masked == Path("/"):
        return
    # If the selected workspace contains the masked path, it is explicitly in scope.
    if _inside(masked, root):
        return
    argv += ["--tmpfs", str(masked)]
    if not _inside(root, masked):
        return
    ancestors: list[Path] = []
    cur = root.parent
    while cur != masked:
        ancestors.append(cur)
        if cur == cur.parent:
            return
        cur = cur.parent
    for directory in reversed(ancestors):
        argv += ["--dir", str(directory)]
    argv += ["--symlink", "/mnt", str(root)]


def wrap(command: str, project_root, config=None) -> list[str] | None:
    """Build a confined argv, or return ``None`` when no supported sandbox exists."""
    backend = _backend()
    if backend is None:
        return None
    kind, executable = backend
    try:
        executable = Path(executable).resolve(strict=False)
        root = Path(project_root).resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        return None
    if root == Path("/") or _inside(executable, root):
        # `/` has no outside boundary. A helper inside the model-writable workspace could be
        # replaced between turns and would execute on the host before confinement takes effect.
        return None
    network = bool(config and config.get("sandbox_network", False))
    if kind == "bwrap":
        argv = [
            str(executable), "--unshare-all", "--unshare-user",
            *(["--share-net"] if network else []),
            "--die-with-parent", "--new-session", "--disable-userns",
            "--ro-bind", "/", "/",
            "--bind", str(root), "/mnt",
        ]
        # Hide ambient credentials and user state. The real project stays reachable at
        # /mnt and, when nested below a masked path, through a compatibility link.
        seen: set[Path] = set()
        for candidate in (Path.home().resolve(strict=False), Path("/root"), Path("/tmp"), Path("/run")):
            try:
                candidate = candidate.resolve(strict=False)
            except OSError:
                continue
            if candidate not in seen:
                seen.add(candidate)
                _mask_with_workspace_link(argv, candidate, root)
        argv += [
            "--dir", "/tmp/dgc-home", "--proc", "/proc", "--dev", "/dev",
            "--chdir", "/mnt", "/bin/bash", "-o", "pipefail", "-c", command,
        ]
        return argv
    if kind == "sandbox-exec":
        def q(value: Path) -> str:
            return str(value).replace("\\", "\\\\").replace('"', '\\"')

        home = Path.home().resolve(strict=False)
        profile = [
            "(version 1)", "(allow default)", "(deny file-write*)",
            f'(allow file-write* (subpath "{q(root)}") (subpath "/tmp") (subpath "/private/tmp") '
            '(literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") '
            '(literal "/dev/dtracehelper") (subpath "/dev/fd"))',
        ]
        if not _inside(home, root):
            profile += [f'(deny file-read* (subpath "{q(home)}"))',
                        f'(allow file-read* (subpath "{q(root)}"))']
        if not network:
            profile.append("(deny network*)")
        return [str(executable), "-p", "".join(profile),
                "/bin/bash", "-o", "pipefail", "-c", command]
    return None
