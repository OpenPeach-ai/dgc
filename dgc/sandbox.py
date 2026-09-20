"""OS sandbox for shell tools, enabled with ``sandbox: true``.

Linux uses bubblewrap (profile ``bwrap-v1``) with a private home/runtime/tmp view, a writable
project mount, a minimal environment, isolated process namespaces, and no network by default.

macOS uses ``/usr/bin/sandbox-exec`` with the deny-by-default ``strict-v1`` profile in
``sandbox_macos.sbpl``: the account's home, ``~/.dgc``, an SDK session's state folder, the shared
temporary folders (``/tmp``, ``/private/tmp``, ``DARWIN_USER_TEMP_DIR``, ``DARWIN_USER_CACHE_DIR``)
and every process outside the sandbox are invisible, the command gets a private 0700 folder as its
HOME/TMPDIR, and LaunchServices (``open``), launchd and cfprefsd (``defaults write``) are
unreachable. The keychain is unreachable while network is denied; with network allowed macOS needs
SecurityServer for TLS, so it is reachable again and ``keychain_hidden`` says so.

Permission approval remains independent: confinement never turns an arbitrary shell string into a
trusted read-only operation. The host-side backend is resolved outside the writable workspace, is
pinned to an absolute path on macOS, and startup-injection environment variables are never
forwarded.
"""
from __future__ import annotations

import atexit
import errno
import os
import shutil
import stat
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from .guards import ENV_HIJACK_BLOCKLIST

#: Identity of the confinement ruleset reported to a launching application (protocol v14
#: ``capabilities.session_policy.sandbox_capabilities.profile``). A CLI older than 0.41.9 reports
#: no profile at all on macOS, and its allow-by-default policy must never be read as ``strict-v1``.
LINUX_PROFILE = "bwrap-v1"
MACOS_PROFILE = "strict-v1"

#: Only this sandbox-exec is used. A ``sandbox-exec`` found on PATH could be anything.
MACOS_BACKEND_PATH = Path("/usr/bin/sandbox-exec")

#: The deny-by-default policy text, beside this module.
MACOS_PROFILE_FILE = Path(__file__).with_name("sandbox_macos.sbpl")


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
    profile: str | None = None            # bwrap-v1 | strict-v1 | None (no confinement)
    process_isolated: bool = False        # outside processes cannot be seen or signalled
    home_hidden: bool = False             # the user's home and ~/.dgc are unreadable
    keychain_hidden: bool = False         # the OS credential store cannot be reached
    reason: str = ""                      # why no backend is usable, when available is False


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


# Why no backend could be used, for the one platform that can lose one at runtime. macOS
# sandbox-exec refuses to nest, so a DGC already running inside a sandbox (an App Store host, a
# codesigned app container, another sandbox-exec) must say so instead of silently running free.
_UNAVAILABLE_REASON = ""

# Cache of "did this sandbox-exec apply the strict profile?" -> (confines, why not), keyed by the
# backend path and the size/mtime of both the binary and the profile.
_SEATBELT_PROBE: dict[tuple, tuple[bool, str]] = {}


def _seatbelt_confines(executable: Path) -> bool:
    """Apply the real strict profile to ``/usr/bin/true`` once, and remember the answer.

    This proves three things at once, before any model command depends on them: the pinned
    sandbox-exec runs, the shipped ``sandbox_macos.sbpl`` still compiles on this macOS, and this
    process is not itself sandboxed (Seatbelt cannot nest).
    """
    def fingerprint(path: Path) -> tuple[float, float]:
        try:
            info = path.stat()
            return (info.st_size, info.st_mtime)
        except OSError:
            return (0.0, 0.0)              # a re-probe is cheaper than a wrong cached answer

    def remember(ok: bool, why: str) -> bool:
        global _UNAVAILABLE_REASON
        _SEATBELT_PROBE[key] = (ok, why)
        _UNAVAILABLE_REASON = "" if ok else why
        return ok

    key = (str(executable), *fingerprint(executable), *fingerprint(MACOS_PROFILE_FILE))
    cached = _SEATBELT_PROBE.get(key)
    if cached is not None:
        return remember(*cached)
    detail = ""
    try:
        import subprocess
        scratch = _private_root()
        if scratch is None:
            return remember(False, "no private temporary folder could be created for the sandbox")
        text, params = _macos_profile(scratch, scratch, network=False, read_only=True,
                                      extra_read_dirs=())
        if text is None:
            return remember(False, "the macOS sandbox policy is missing or unreadable: "
                                   f"{MACOS_PROFILE_FILE}")
        probe = subprocess.run(
            [str(executable), "-p", text, *params, "--", "/usr/bin/true"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            timeout=20)
        if probe.returncode == 0:
            return remember(True, "")
        detail = (probe.stderr or b"").decode("utf-8", "replace").strip().replace("\n", " ")
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        detail = f"{type(exc).__name__}: {exc}"
    detail = detail[:200]
    # macOS refuses to apply a profile inside an existing sandbox, and says so with EPERM.
    if "not permitted" in detail.lower() or "sandbox_apply" in detail.lower():
        return remember(False, "this DGC is already running inside a sandbox and macOS Seatbelt "
                               f"cannot nest ({detail})")
    return remember(False, "/usr/bin/sandbox-exec could not apply the strict-v1 profile"
                           + (f": {detail}" if detail else ""))


def _backend() -> tuple[str, Path] | None:
    global _UNAVAILABLE_REASON
    _UNAVAILABLE_REASON = ""
    if sys.platform == "darwin":
        # Pinned, never PATH: a `sandbox-exec` earlier on PATH would be an unconfined passthrough.
        executable = MACOS_BACKEND_PATH
        try:
            if not executable.is_file() or not os.access(executable, os.X_OK):
                _UNAVAILABLE_REASON = f"{executable} is missing or not executable"
                return None
        except OSError as exc:
            _UNAVAILABLE_REASON = f"{executable} could not be inspected: {exc}"
            return None
        if not _seatbelt_confines(executable):
            return None
        return "sandbox-exec", executable
    name = "bwrap" if sys.platform.startswith("linux") else ""
    candidate = shutil.which(name) if name else None
    if not candidate:
        _UNAVAILABLE_REASON = (f"no {name} on PATH" if name else
                               f"no supported confinement backend on {sys.platform}")
        return None
    try:
        executable = Path(candidate).resolve(strict=True)
        if not executable.is_file() or not os.access(executable, os.X_OK):
            return None
    except (OSError, RuntimeError, ValueError):
        return None
    # A bwrap on PATH is not proof it confines: unprivileged user namespaces may be disabled. Probe
    # once (cached) so `required` cannot pass, and active never reports True, while the shell fails.
    if not _bwrap_confines(executable):
        _UNAVAILABLE_REASON = ("bubblewrap cannot confine here (unprivileged user namespaces "
                               "look disabled)")
        return None
    return name, executable


def available() -> str | None:
    backend = _backend()
    return backend[0] if backend else None


def unavailable_reason() -> str:
    """Why confinement is unavailable, in one user-facing clause ("" when it is available)."""
    if _backend() is not None:
        return ""
    return _UNAVAILABLE_REASON or f"no supported confinement backend on {sys.platform}"


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
            profile=LINUX_PROFILE,
            process_isolated=True,
            home_hidden=True,
            # The Secret Service lives behind the session bus in /run/user/<uid> and the keyring
            # files under the home: both are replaced by empty tmpfs mounts.
            keychain_hidden=True,
        )
    if kind == "sandbox-exec":
        return SandboxCapabilities(
            backend=kind,
            available=True,
            filesystem="project writable; the rest of the disk read-only or hidden",
            home="ambient home, ~/.dgc and an SDK state folder hidden",
            temporary="private per-command temporary directory; host /tmp hidden",
            network=network,
            process="Seatbelt strict-v1: outside processes cannot be listed or signalled",
            private_temporary=True,
            network_isolated=not network_allowed,
            profile=MACOS_PROFILE,
            process_isolated=True,
            home_hidden=True,
            # macOS needs SecurityServer for TLS, so the keychain is reachable again exactly when
            # this session allows network. Frozen contract (C8) — the docs say so too.
            keychain_hidden=not network_allowed,
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
        profile=None,
        reason=unavailable_reason(),
    )


def capabilities_dict(config=None) -> dict:
    """The ready frame's ``session_policy.sandbox_capabilities`` object (protocol v14, additive).

    What THIS session actually has, not what the host could offer: with the sandbox off, or with
    no usable backend, every flag is false and there is no backend or profile to name. Every flag
    is a boolean, never null. A launching application reads this instead of guessing what an OS
    sandbox on this platform confines.
    """
    report = capabilities(config)
    on = bool(report.available and requested(config))
    return {
        "backend": report.backend if on else None,
        "profile": report.profile if on else None,
        "process_isolated": bool(on and report.process_isolated),
        "home_hidden": bool(on and report.home_hidden),
        "private_temporary": bool(on and report.private_temporary),
        "network_isolated": bool(on and report.network_isolated),
        "keychain_hidden": bool(on and report.keychain_hidden),
    }


def describe(config=None) -> str:
    """Return a compact status line suitable for the TUI and diagnostics."""
    report = capabilities(config)
    if not report.available:
        reason = report.reason or f"no supported confinement backend on {sys.platform}"
        return f"unavailable — {reason}; requested commands fail closed"
    if report.backend == "bwrap":
        return (f"bwrap ({LINUX_PROFILE}); project writable; private home/tmp/runtime; "
                f"network {report.network}; approvals unchanged")
    keychain = "keychain hidden" if report.keychain_hidden else "keychain reachable (TLS)"
    return (f"sandbox-exec ({MACOS_PROFILE}); project writable; private home/tmp; ambient home, "
            f"host temp and outside processes hidden; network {report.network}; {keychain}; "
            "approvals unchanged")


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


# ---------------------------------------------------------------------------------------------
# macOS: the private per-command temporary folder
#
# Seatbelt has no mount namespace, so "private temp" is a real 0700 directory the profile is the
# only thing allowed to reach. One folder per confined command, used as HOME/TMPDIR/TMP/TEMP, so
# two commands cannot read each other's scratch files and nothing lands in the host's shared /tmp.
# ---------------------------------------------------------------------------------------------

#: Folders this process created and has not reaped yet.
_CALL_DIRS: set[str] = set()

#: A foreign process's leftovers are only reaped once they are this old, so a recycled pid cannot
#: make one DGC delete another's live scratch folder.
_REAP_FOREIGN_AGE_S = 3600.0
_REAP_MAX_ENTRIES = 500


def _private_root() -> Path | None:
    """``<temp>/dgc-sandbox-<uid>``: owner-only, never a symlink, never someone else's."""
    try:
        base = Path(tempfile.gettempdir())
        root = base / f"dgc-sandbox-{os.getuid()}"
        try:
            root.mkdir(mode=0o700, exist_ok=False)
        except FileExistsError:
            info = root.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
                return None                      # someone else's, or a symlink into their tree
            if stat.S_IMODE(info.st_mode) != 0o700:
                os.chmod(root, 0o700)
        return root.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return None


def _reap_call_dirs() -> None:
    """Remove finished commands' folders: this process's emptied ones, and dead processes'."""
    root = _private_root()
    if root is None:
        return
    now = time.time()
    try:
        with os.scandir(root) as listing:
            entries = sorted(listing, key=lambda e: e.name)[:_REAP_MAX_ENTRIES]
    except OSError:
        return
    mine = os.getpid()
    for entry in entries:
        name = entry.name
        if not name.startswith("box-"):
            continue
        try:
            pid = int(name.split("-")[1])
        except (IndexError, ValueError):
            pid = -1
        path = os.path.join(root, name)
        if path in _CALL_DIRS:
            # Ours. The confined shell deletes its HOME/TMPDIR subtree as it exits, so an empty
            # call folder means that command is over; a running one always still has it.
            try:
                if not os.listdir(path):
                    os.rmdir(path)
                    _CALL_DIRS.discard(path)
            except OSError:
                pass
            continue
        if pid != mine:
            try:
                if now - entry.stat(follow_symlinks=False).st_mtime < _REAP_FOREIGN_AGE_S:
                    continue                     # too young to judge: a pid can be recycled
            except OSError:
                continue
            if pid > 0:                          # never os.kill(-1, ...): that is "every process"
                try:
                    os.kill(pid, 0)
                    continue                     # that DGC is alive; leave its folder alone
                except OSError as exc:
                    if getattr(exc, "errno", None) == errno.EPERM:
                        continue                 # alive, and another user's
        shutil.rmtree(path, ignore_errors=True)


#: The confined command's HOME/TMPDIR, inside its call folder. The shell can delete this whole
#: subtree as it exits (its parent is writable), which is what makes "removed after the call"
#: true even though Seatbelt has no mount namespace to throw away.
CALL_HOME_NAME = "t"


def _new_call_dir() -> Path | None:
    """A fresh 0700 folder for one confined command (None when it cannot be made privately)."""
    _reap_call_dirs()
    root = _private_root()
    if root is None:
        return None
    try:
        box = Path(tempfile.mkdtemp(prefix=f"box-{os.getpid()}-", dir=root))
        os.chmod(box, 0o700)
        (box / CALL_HOME_NAME).mkdir(mode=0o700)
    except (OSError, ValueError):
        return None
    _CALL_DIRS.add(str(box))
    return box


def release_call_dir(path) -> None:
    """Remove one command's private folder now. Safe to call twice, or never.

    The confined shell removes its own folder's contents on exit, and the next confined command
    (or process exit) reaps what is left, so callers are not required to call this.
    """
    text = str(path)
    _CALL_DIRS.discard(text)
    root = _private_root()
    if root is None or os.path.dirname(text) != str(root):
        return                                   # only ever our own boxes
    shutil.rmtree(text, ignore_errors=True)


@atexit.register
def _release_all_call_dirs() -> None:
    for text in list(_CALL_DIRS):
        _CALL_DIRS.discard(text)
        shutil.rmtree(text, ignore_errors=True)


def _ancestors(path: Path) -> list[Path]:
    """``/a/b/c`` -> ``[/, /a, /a/b]`` — the components a shell stats on the way in."""
    return list(reversed(path.parents))


def _extra_read_dirs(config) -> tuple[Path, ...]:
    """Directories outside the project the confined command may read (``sandbox_read_dirs``).

    macOS hides the home folder, so a toolchain installed under it (``~/.cargo``, ``~/.nvm``,
    ``~/.pyenv``, ``~/.rustup``) is invisible until the user names it here.
    """
    configured = config.get("sandbox_read_dirs", []) if config else []
    if isinstance(configured, str):
        configured = [part.strip() for part in configured.split(",") if part.strip()]
    if not isinstance(configured, (list, tuple)):
        return ()
    found: list[Path] = []
    for value in configured[:32]:
        try:
            path = Path(str(value)).expanduser().resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            continue
        if path.is_dir() and path != Path("/") and path not in found:
            found.append(path)
    return tuple(found)


def _macos_profile(root: Path, session_tmp: Path, *, network: bool, read_only: bool,
                   extra_read_dirs=()) -> tuple[str | None, list[str]]:
    """Compose ``strict-v1`` for one command: policy text plus the ``-D`` parameter arguments.

    Every path is a parameter. Nothing a user or a model controls is ever spliced into the policy
    text, so a workspace path holding ``"`` or ``)`` cannot close a rule and widen the profile.
    """
    try:
        base = MACOS_PROFILE_FILE.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError, ValueError):
        return None, []                          # no policy on disk: fail closed, never unconfined
    params: dict[str, str] = {"WORKSPACE": str(root), "SESSION_TMP": str(session_tmp)}
    lines = ["", "; --- this command's workspace and private temporary folder ------------------",
             '(allow file-read* file-test-existence file-map-executable'
             ' (subpath (param "WORKSPACE")))']
    if not read_only:
        lines.append('(allow file-write* (subpath (param "WORKSPACE")))')
    lines.append('(allow file-read* file-write* file-test-existence file-map-executable'
                 ' (subpath (param "SESSION_TMP")))')
    stats: list[str] = []
    for prefix, path in (("WS_ANC", root), ("TMP_ANC", session_tmp)):
        for index, ancestor in enumerate(_ancestors(path)):
            key = f"{prefix}_{index}"
            params[key] = str(ancestor)
            stats.append(f'(literal (param "{key}"))')
    if stats:
        lines.append("(allow file-read-metadata file-test-existence " + " ".join(stats) + ")")
    for index, extra in enumerate(extra_read_dirs):
        key = f"READ_EXTRA_{index}"
        params[key] = str(extra)
        lines.append('(allow file-read* file-test-existence file-map-executable'
                     f' (subpath (param "{key}")))')
        for depth, ancestor in enumerate(_ancestors(extra)):
            anc_key = f"{key}_ANC_{depth}"
            params[anc_key] = str(ancestor)
            lines.append(f'(allow file-read-metadata file-test-existence (literal (param "{anc_key}")))')
    if network:
        lines += [
            "",
            "; --- network allowed for this session ---------------------------------------",
            "; IP, plus the one unix socket name resolution needs: the SDK's tool relay and every",
            "; other agent behind /var/run stay out of reach. SecurityServer comes back for TLS,",
            "; which is why capabilities report keychain_hidden=false whenever network is allowed.",
            '(allow network-outbound (remote ip "*:*"))',
            '(allow network-outbound (remote unix-socket'
            ' (literal "/private/var/run/mDNSResponder")))',
            '(allow network-inbound (local ip "*:*"))',
            '(allow network-bind (local ip "*:*"))',
            "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
            "(allow sysctl-read (sysctl-name-regex #\"^net\\.\"))",
            "(allow mach-lookup",
            '  (global-name "com.apple.SystemConfiguration.DNSConfiguration")',
            '  (global-name "com.apple.SystemConfiguration.configd")',
            '  (global-name "com.apple.SystemConfiguration.PPPController")',
            '  (global-name "com.apple.mDNSResponder")',
            '  (global-name "com.apple.dnssd.service")',
            '  (global-name "com.apple.networkd")',
            '  (global-name "com.apple.nehelper")',
            '  (global-name "com.apple.nesessionmanager")',
            '  (global-name "com.apple.ocspd")',
            '  (global-name "com.apple.trustd")',
            '  (global-name "com.apple.trustd.agent")',
            '  (global-name "com.apple.SecurityServer")',
            '  (global-name "com.apple.bsd.dirhelper")',
            '  (global-name "com.apple.system.opendirectoryd.membership"))',
            '(allow file-read* (literal "/private/var/run/resolv.conf")'
            ' (subpath "/private/var/db/nsurlsessiond"))',
        ]
    text = base + "\n".join(lines) + "\n"
    return text, [f"-D{key}={value}" for key, value in params.items()]


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
        # strict-v1: nothing is allowed that the profile does not name. The command gets a private
        # 0700 folder as HOME/TMPDIR/TMP/TEMP — the host's /tmp, /private/tmp, DARWIN_USER_TEMP_DIR
        # and DARWIN_USER_CACHE_DIR are not in the profile at all, so they are invisible.
        box = _new_call_dir()
        if box is None:
            return None                          # no private temp: fail closed, never unconfined
        home = box / CALL_HOME_NAME
        profile, params = _macos_profile(
            root, box, network=network, read_only=read_only,
            extra_read_dirs=_extra_read_dirs(config))
        if profile is None:
            release_call_dir(box)
            return None
        # The shell wipes its own scratch folder as it exits; `release_call_dir`, the next confined
        # command and process exit each remove what a killed shell leaves behind. `eval "$1"` keeps
        # the model's command a separate argument instead of splicing it into a wrapper script.
        runner = ('__dgc_box=$TMPDIR\n'
                  'mkdir -p -- "$__dgc_box" >/dev/null 2>&1\n'
                  'trap \'rm -rf -- "$__dgc_box" >/dev/null 2>&1\' EXIT\n'
                  'eval "$1"')
        return [
            str(executable), "-p", profile, *params, "--",
            "/usr/bin/env", f"HOME={home}", f"TMPDIR={home}", f"TMP={home}", f"TEMP={home}",
            "/bin/bash", "-o", "pipefail", "-c", runner, "dgc-sandbox", command,
        ]
    return None


def _print_profile(argv: list[str]) -> int:
    """``python -m dgc.sandbox --print-profile`` — show exactly what would confine a command."""
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m dgc.sandbox",
        description="Print the macOS Seatbelt profile DGC applies to sandboxed shell commands.")
    parser.add_argument("--print-profile", action="store_true", required=True,
                        help="print the composed strict-v1 policy and its -D parameters")
    parser.add_argument("--workspace", default=".", help="the project directory (default: .)")
    parser.add_argument("--network", action="store_true", help="compose it with network allowed")
    parser.add_argument("--read-only", action="store_true", help="compose it read-only")
    args = parser.parse_args(argv)
    if sys.platform != "darwin":
        print(f"the strict-v1 Seatbelt profile is macOS only (this is {sys.platform}); "
              f"the policy text lives in {MACOS_PROFILE_FILE}", file=sys.stderr)
    try:
        workspace = Path(args.workspace).expanduser().resolve(strict=False)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"unusable --workspace: {exc}", file=sys.stderr)
        return 2
    box = _new_call_dir()
    if box is None:
        print("could not create a private temporary folder to compose the profile",
              file=sys.stderr)
        return 1
    try:
        text, params = _macos_profile(workspace, box, network=args.network,
                                      read_only=args.read_only, extra_read_dirs=())
        if text is None:
            print(f"the policy file is missing or unreadable: {MACOS_PROFILE_FILE}",
                  file=sys.stderr)
            return 1
        print(text, end="")
        print("\n; parameters passed to /usr/bin/sandbox-exec for this command:")
        for param in params:
            print(f";   {param}")
    finally:
        release_call_dir(box)
    return 0


if __name__ == "__main__":                       # pragma: no cover - a diagnostic entry point
    sys.exit(_print_profile(sys.argv[1:]))
