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

# Provider credentials DGC consumes. They belong to the model client, never to a tool the model
# runs, so they are stripped from every shell/python/monitor/hook subprocess environment — in
# every mode, sandboxed or not. Without this an unsandboxed `echo -n "$DGC_API_KEY" | rev` (or a
# read of /proc/<pid>/environ) recovers the key past output redaction.
_PROVIDER_KEY_ENV = frozenset({
    "DGC_API_KEY", "DGC_SEARCH_API_KEY", "DGC_SUBAGENT_API_KEY", "DGC_FALLBACK_API_KEY",
})


def _is_provider_key_env(name: str) -> bool:
    up = str(name).upper()
    if up in _PROVIDER_KEY_ENV or (up.startswith("DGC_") and up.endswith("_API_KEY")):
        return True
    # The launcher hands a key through DGC_<NAME>_API_KEY_FILE; the file is deleted at config load,
    # but drop the pointer from tool environments too so it never even hints where it was.
    return up.startswith("DGC_") and up.endswith("_API_KEY_FILE")


def tool_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The environment for an UNSANDBOXED shell/python/monitor tool: the inherited environment
    with DGC's provider credentials removed. (A sandboxed tool uses :func:`process_env`, which is
    far more restrictive.) ``extra`` is merged on top, its provider keys stripped too."""
    env = {k: v for k, v in os.environ.items() if not _is_provider_key_env(k)}
    for k, v in (extra or {}).items():
        if not _is_provider_key_env(k):
            env[k] = v
    return env


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


# Cache of "does this bubblewrap binary actually confine?" keyed by (path, size, mtime). Where
# unprivileged user namespaces are disabled, or bwrap is too old, the binary is on PATH but every
# `bwrap` invocation fails; probing keeps available()/requested() truthful without spawning a
# probe on every permission check.
_BWRAP_PROBE: dict[tuple[str, int, float], bool] = {}


def _bwrap_confines(executable: Path) -> bool:
    try:
        info = executable.stat()
        key = (str(executable), info.st_size, info.st_mtime)
    except OSError:
        return False
    cached = _BWRAP_PROBE.get(key)
    if cached is not None:
        return cached
    ok = False
    try:
        import subprocess
        probe = subprocess.run(
            [str(executable), "--unshare-all", "--ro-bind", "/", "/", "/bin/true"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=10)
        ok = probe.returncode == 0
    except (OSError, ValueError, subprocess.SubprocessError):
        ok = False
    _BWRAP_PROBE[key] = ok
    return ok


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
    # A bwrap on PATH is not proof it confines: unprivileged user namespaces may be disabled. Probe
    # once (cached) so `required` cannot pass, and active never reports True, while the shell fails.
    if name == "bwrap" and not _bwrap_confines(executable):
        return None
    return name, executable


def available() -> str | None:
    backend = _backend()
    return backend[0] if backend else None


def capabilities(config=None) -> SandboxCapabilities:
    """Describe guarantees without treating unlike host backends as equivalent."""
    kind = available()
    network_allowed = _network_allowed(config)
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


def _session():
    """The launching process's session policy (``DGC_SESSION_POLICY``), when one parsed."""
    from .permissions import session_policy
    policy = session_policy()
    return policy if policy is not None and not policy.error else None


def requested(config) -> bool:
    """Return whether confinement was explicitly requested, backend availability aside.

    A session policy can require the sandbox (then a missing backend makes shell commands fail
    closed) or prefer it (on when a backend exists); it never turns a configured sandbox off.
    """
    policy = _session()
    if policy is not None:
        if policy.sandbox == "required" or (policy.sandbox == "preferred" and available()):
            return True
    return bool(config and config.get("sandbox"))


def session_confined() -> bool:
    """True when this process's session policy has the OS sandbox on (backend present)."""
    policy = _session()
    return bool(policy is not None and policy.sandbox in ("required", "preferred")
                and available() is not None)


def _network_allowed(config) -> bool:
    policy = _session()
    if policy is not None and policy.sandbox_network is not None:
        return policy.sandbox_network
    return bool(config and config.get("sandbox_network", False))


def _read_only(config) -> bool:
    policy = _session()
    return bool((config and config.get("sandbox_read_only", False))
                or (policy is not None and policy.sandbox_read_only))


def _account_home() -> Path | None:
    """The OS account's home, which HOME may not name (an SDK child runs with a private HOME)."""
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except (ImportError, KeyError, OSError, AttributeError):
        return None


def _isolated_state_dir() -> Path | None:
    """An SDK client's whole state_dir (the parent of the isolated HOME), or None.

    Masking only the isolated HOME left ``state_dir/audit`` and ``state_dir/usage`` readable by a
    sandboxed shell when the state_dir sits outside home, /tmp and /run. The SDK's HOME is
    ``state_dir/home``, so the state_dir is its parent.
    """
    if os.environ.get("DGC_SDK_ISOLATED") != "1":
        return None
    home = os.environ.get("DGC_HOME")
    if not home:
        return None
    try:
        return Path(home).resolve(strict=False).parent
    except (OSError, RuntimeError, ValueError):
        return None


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
    network = _network_allowed(config)
    # `--sandbox read-only` (a review run, or a session policy that denies writes): the project is
    # visible but nothing under it is writable.
    read_only = _read_only(config)
    if kind == "bwrap":
        argv = [
            str(executable), "--unshare-all", "--unshare-user",
            *(["--share-net"] if network else []),
            "--die-with-parent", "--new-session", "--disable-userns",
            "--ro-bind", "/", "/",
            "--ro-bind" if read_only else "--bind", str(root), "/mnt",
        ]
        # Hide ambient credentials and user state. The real project stays reachable at
        # /mnt and, when nested below a masked path, through a compatibility link.
        seen: set[Path] = set()
        # HOME and the account's home differ for an SDK child (a private HOME under its state
        # directory); both hold user state, so both are hidden.
        homes = [Path.home()] + ([account] if (account := _account_home()) else [])
        # The SDK client's whole state_dir (audit and usage logs, not just its isolated HOME).
        extra = [state] if (state := _isolated_state_dir()) else []
        for candidate in (*homes, *extra, Path("/root"), Path("/tmp"), Path("/run")):
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

        homes: list[Path] = []
        for candidate in (Path.home(), _account_home(), _isolated_state_dir()):
            if candidate is not None and candidate.resolve(strict=False) not in homes:
                homes.append(candidate.resolve(strict=False))
        writable_project = "" if read_only else f'(subpath "{q(root)}") '
        profile = [
            "(version 1)", "(allow default)", "(deny file-write*)",
            f'(allow file-write* {writable_project}(subpath "/tmp") (subpath "/private/tmp") '
            '(literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") '
            '(literal "/dev/dtracehelper") (subpath "/dev/fd"))',
        ]
        hidden = [home for home in homes if not _inside(home, root)]
        for home in hidden:
            profile.append(f'(deny file-read* (subpath "{q(home)}"))')
        if hidden:
            profile.append(f'(allow file-read* (subpath "{q(root)}"))')
        if not network:
            profile.append("(deny network*)")
        return [str(executable), "-p", "".join(profile),
                "/bin/bash", "-o", "pipefail", "-c", command]
    return None
