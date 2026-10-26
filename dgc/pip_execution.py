"""Reviewed Patch/Pulse actions in a private copy, never the user's working tree.

Only the controller grants an immutable action. Models have no command executor:
reviewed shell argv uses mandatory OS confinement, bubblewrap on Linux and Seatbelt
(``sandbox-exec``) on macOS. The standalone fixed HTTP probe uses a separately
reviewed loopback profile, never project code. Hard CPU limits are per process; on
Linux AS is too, while aggregate RSS is a sampled guard, not a hard ceiling. macOS
has no PID namespace and rejects finite AS limits, so there memory, process count
and scratch size are all sampled guards.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path, PurePosixPath

from .workspace_registry import RegistryError

WRITE_TOOLS = frozenset({"write_file", "edit_file", "multi_edit", "apply_patch"})
LIMITS = {"wall_seconds": 60, "cpu_seconds": 30, "memory_bytes": 512 * 1024 * 1024,
          "output_bytes": 65536, "processes": 32}
MAX_FILES = 10000
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_DIFF_BYTES = 256 * 1024
MAX_COMMANDS = 4
MAX_WRITE_PATHS = 32
MAX_ACTION_BYTES = 16384
SCRATCH_BYTES = 64 * 1024 * 1024
_PROBE_LOCK = threading.Lock()
_PROBE_CACHE = {}
# A failed probe is tried again after this long: the user may have just fixed the machine (dgc pips execution --fix),
# and the supervisor that asks lives for days.
FAILED_PROBE_SECONDS = 60
FIX_COMMAND = "dgc pips execution --fix"


def _error(message, code="invalid_execution"):
    return RegistryError(code, message)


def _text(value, name, maximum=1024):
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise _error(f"{name} must be nonempty bounded text without control characters.")
    try:
        encoded = value.encode("utf-8")
    except UnicodeError:
        raise _error(f"{name} must contain valid Unicode.") from None
    if len(encoded) > maximum:
        raise _error(f"{name} exceeds its {maximum}-byte limit.")
    return value


def _relative(value, name, *, directory=False):
    value = _text(value, name)
    if directory and value == ".":
        return value
    path = PurePosixPath(value)
    if (path.is_absolute() or not path.parts or str(path) != value or ".." in path.parts
            or any(part.lower() == ".git" for part in path.parts)
            or any(char in value for char in ("\\", ":", "*", "?", "[", "]"))):
        raise _error(f"{name} must be a normalized relative path without traversal or Git metadata.")
    return value


def validate_action(pip_type, value):
    """Pure, bounded canonical permissions; an action is not an approval by itself."""
    if not isinstance(value, dict) or len(value) > 6:
        raise _error("Choose an explicit reviewed execution action.")
    kind = value.get("kind")
    if pip_type in ("scout", "lens", "rook", "lock"):
        if value != {"kind": "read_only"}:
            raise _error("Source review Pips accept only a read_only action.")
        return {"kind": "read_only"}
    expected = {"patch": "patch", "pulse": "test"}.get(pip_type) if isinstance(pip_type, str) else None
    if expected is None or kind != expected:
        raise _error("This Pip type does not support the selected execution action.")
    allowed = {"kind", "tests", "network", "limits"} | ({"write_paths", "specialists"} if kind == "patch" else set())
    if set(value) - allowed:
        raise _error("Execution actions cannot add endpoints, environment variables, shell authority or other grants.")
    local_http = pip_type == "pulse" and value.get("network") == "loopback_http_v1"
    if value.get("network", False) is not False and not local_http:
        raise _error("Reviewed tests always run without network access.")
    limits = value.get("limits", LIMITS)
    if (not isinstance(limits, dict) or set(limits) != set(LIMITS)
            or any(type(limits[key]) is not int or limits[key] != expected for key, expected in LIMITS.items())):
        raise _error("Execution limits are fixed by this runner and cannot be expanded.")
    result = {"kind": kind}
    if kind == "patch":
        paths = value.get("write_paths")
        if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_WRITE_PATHS:
            raise _error("Patch needs from one to 32 exact reviewed file paths.")
        paths = [_relative(path, "Write path") for path in paths]
        if len(set(paths)) != len(paths):
            raise _error("Reviewed write paths must be unique.")
        result["write_paths"] = sorted(paths)
    tests = value.get("tests")
    if not isinstance(tests, list) or not (0 if kind == "patch" else 1) <= len(tests) <= MAX_COMMANDS:
        raise _error("Pulse needs one to four reviewed commands; Patch permits zero to four.")
    commands, size = [], 0
    for item in tests:
        if not isinstance(item, dict) or set(item) != {"argv", "cwd"}:
            raise _error("Each test requires exactly argv and cwd.")
        argv = item["argv"]
        if not isinstance(argv, list) or not 1 <= len(argv) <= 32:
            raise _error("A reviewed command requires one to 32 argv items.")
        argv = [_text(arg, "Command argument") for arg in argv]
        size += sum(len(arg.encode("utf-8")) for arg in argv)
        if size > 8192:
            raise _error("Reviewed command arguments exceed their combined 8192-byte limit.")
        commands.append({"argv": argv, "cwd": _relative(item["cwd"], "Command directory", directory=True)})
    if local_http:
        from .pip_http_checks import validate_test
        commands = [validate_test(test) for test in commands]
    result.update(tests=commands, network="loopback_http_v1" if local_http else False, limits=dict(LIMITS))
    if 'specialists' in value:
        from .pip_specialists import validate_grant
        result['specialists'] = validate_grant(value['specialists'])
    if len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()) > MAX_ACTION_BYTES:
        raise _error("The complete execution action exceeds 16 KiB.")
    return result


def sandbox_required(action) -> bool:
    """Whether running ACTION needs the OS sandbox (bubblewrap, Seatbelt).

    A Pulse plan whose every test is DGC's own loopback HTTP check (`loopback_http_v1`: each test validated by
    pip_http_checks.validate_test, 127.0.0.1 only, no query, credentials or redirects) runs no project code and no argv
    from the plan: only DGC's fixed checker with validated arguments, under its own timeout and rlimits. It never ran
    inside the sandbox (see _run_command), yet a Pulse that only checked a local page was refused wherever the sandbox
    can't start, as on stock Ubuntu 24.04, and its schedule was put off every 30 seconds (ERP session review,
    2026-10-18). Anything else, every command and every Patch, still needs the sandbox."""
    try:
        canonical = _canonical_action(action)
    except RegistryError:
        return True
    return not (canonical["kind"] == "test" and canonical.get("network") == "loopback_http_v1" and canonical["tests"])


def run_here_notice(job) -> str | None:
    """Why this Pulse or Patch can't do its work on this computer, or None (it can, or it runs no commands). For its
    setup card and its status: a Pulse was accepted here and then put off every 30 seconds, and the model told the
    user twice that it was working (ERP session review, 2026-10-18)."""
    if not isinstance(job, dict) or job.get("pip_type") not in ("pulse", "patch"):
        return None
    if job.get("source_policy") in ({"mode": "personal"}, "personal"):
        return None
    if job.get("live_plan") is not None:
        from .pip_live_data import run_here_notice as live_notice      # its read-only box, not the test sandbox
        return live_notice(job)
    plan = job.get("verification_plan")
    if job["pip_type"] == "pulse" and isinstance(plan, dict) and isinstance(plan.get("action"), dict) \
            and not sandbox_required(plan["action"]):
        return None                      # DGC's own local page checks: no sandbox needed
    found = capability()
    return None if found.get("available") else str(found.get("reason") or "Commands can't run here.")


def action_digest(action):
    kind = action.get("kind") if isinstance(action, dict) else None
    selected = {"patch": "patch", "test": "pulse", "read_only": "rook"}.get(kind) if isinstance(kind, str) else None
    canonical = validate_action(selected, action)
    return hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def _canonical_action(action):
    kind = action.get("kind") if isinstance(action, dict) else None
    selected = {"patch": "patch", "test": "pulse"}.get(kind) if isinstance(kind, str) else None
    return validate_action(selected, action)


def _directory(value):
    path = Path(value)
    if not path.is_absolute() or path == Path("/"):
        raise _error("Execution paths must be private absolute directories.", "unsafe_execution_path")
    # No symlink ancestor can redirect an artifact or source boundary.
    for part in reversed((path, *path.parents)):
        info = part.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise _error("Execution directories cannot contain symlink components.", "unsafe_execution_path")
    return path


def _inside(root, relative, *, directory=False, missing=False):
    relative = _relative(relative, "Execution path", directory=directory)
    target = root if relative == "." else root / relative
    parts = () if relative == "." else PurePosixPath(relative).parts
    current = root
    for index, part in enumerate(parts):
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise _error("A reviewed path does not exist in the isolated copy.", "execution_path_missing") from None
        last = index == len(parts) - 1
        if stat.S_ISLNK(info.st_mode) or (not stat.S_ISDIR(info.st_mode) and not (last and not directory and stat.S_ISREG(info.st_mode))):
            raise _error("Execution paths must be ordinary files/directories, never symlinks or special files.", "unsafe_execution_path")
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            raise _error("Hard-linked execution files are not supported.", "unsafe_execution_path")
    return target


def authorize_write(worktree, path, action):
    """Controller calls before each existing write tool, in addition to permissions."""
    action = _canonical_action(action)
    if action["kind"] != "patch":
        raise _error("This reviewed action does not permit file edits.", "execution_denied")
    root = _directory(worktree)
    path = _text(path, "Write tool path", 4096)
    supplied = Path(path)
    if supplied.is_absolute():
        try:
            path = supplied.relative_to(root).as_posix()
        except ValueError:
            raise _error("Patch edits are confined to the isolated copy.", "execution_denied") from None
    relative = _relative(path, "Write tool path")
    if relative not in action["write_paths"]:
        raise _error("This file was not included in the reviewed Patch write paths.", "execution_denied")
    return _inside(root, relative, missing=True)


def _backend():
    if sys.platform.startswith("linux"):
        return "bwrap"
    if sys.platform == "darwin":
        return "seatbelt"
    return None


def _helpers(paths, message):
    for path in paths:
        try:
            info = path.resolve(strict=True).stat()
        except OSError:
            raise _error(message, "execution_unavailable") from None
        if not stat.S_ISREG(info.st_mode) or not os.access(path, os.X_OK):
            raise _error("A required execution helper is unavailable.", "execution_unavailable")


_SANDBOX_EXEC = Path("/usr/bin/sandbox-exec")
_XCODE_SELECT = Path("/usr/bin/xcode-select")


def _developer_directory():
    """The active Xcode or Command Line Tools folder, found without running an xcrun shim.

    `/usr/bin/python3` and `/usr/bin/git` are shims. With no developer tools installed they
    open the "install command line developer tools" dialog, and inside Seatbelt every call
    fails to write xcrun's cache in the per-user temporary folder (an error line in the test
    output and about a second of delay). `xcode-select -p` only reports the selection, so
    the runner asks it whenever it resolves the runtime and runs that folder's real binaries.
    """
    result = _capture([str(_XCODE_SELECT), "-p"], maximum=4096, timeout=5, env={"PATH": "/usr/bin:/bin"})
    try:
        text = result["data"].decode("utf-8").strip()
    except UnicodeError:
        text = ""
    path = Path(text) if result["status"] == "passed" and text and "\n" not in text else None
    if path is None or not path.is_absolute():
        raise _error("No Xcode or Command Line Tools folder is selected; install them with "
                     "`xcode-select --install`.", "execution_unavailable")
    try:
        return path.resolve(strict=True)
    except OSError:
        raise _error("The selected developer tools folder is missing.", "execution_unavailable") from None


def _runtime():
    backend = _backend()
    if backend == "bwrap":
        bwrap, python = Path("/usr/bin/bwrap"), Path("/usr/bin/python3")
        _helpers((bwrap, python, Path("/usr/bin/git")),
                 "This runner needs system bubblewrap, Python 3 and Git for isolated execution.")
        return str(bwrap), str(python)
    if backend == "seatbelt":
        message = "This runner needs sandbox-exec and the Xcode or Command Line Tools Python 3 and Git."
        _helpers((_SANDBOX_EXEC, _XCODE_SELECT, Path("/usr/bin/git")), message)
        developer = _developer_directory()
        python = developer / "usr" / "bin" / "python3"
        _helpers((python, developer / "usr" / "bin" / "git"), message)
        return str(_SANDBOX_EXEC), str(python)
    raise _error("Patch and Pulse execution require Linux with working bubblewrap or macOS with "
                 "Seatbelt (sandbox-exec) confinement.", "execution_unavailable")


def _sandbox_argv(worktree, cwd, command):
    bwrap, _ = _runtime()
    argv = [bwrap, "--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent",
            "--new-session", "--cap-drop", "ALL"]
    for raw in ("/usr", "/bin", "/lib", "/lib64"):
        if Path(raw).exists():
            argv += ["--ro-bind", raw, raw]
    if Path("/etc/ld.so.cache").is_file():
        argv += ["--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"]
    argv += ["--ro-bind", str(worktree), "/workspace", "--proc", "/proc", "--dev", "/dev",
             "--size", str(SCRATCH_BYTES), "--tmpfs", "/tmp", "--dir", "/tmp/home", "--clearenv",
             "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "HOME", "/tmp/home",
             "--setenv", "TMPDIR", "/tmp", "--setenv", "LANG", "C.UTF-8",
             "--setenv", "PYTHONDONTWRITEBYTECODE", "1", "--setenv", "PYTHONNOUSERSITE", "1",
             "--remount-ro", "/dev", "--remount-ro", "/proc", "--remount-ro", "/",
             "--chdir", "/workspace" + ("/" + cwd if cwd != "." else ""), "--", *command]
    return argv


_RLIMITS = (("RLIMIT_AS", 536870912), ("RLIMIT_CPU", 30), ("RLIMIT_FSIZE", 67108864),
            ("RLIMIT_NOFILE", 64), ("RLIMIT_NPROC", 32), ("RLIMIT_CORE", 0))
# macOS counts RLIMIT_NPROC per user across the whole system (a cap of 32 would refuse the
# first fork of a logged-in user) and rejects finite RLIMIT_AS/RLIMIT_DATA. Memory and
# process count are enforced there by the parent's sampler instead.
_DARWIN_RLIMITS = tuple(item for item in _RLIMITS if item[0] not in ("RLIMIT_AS", "RLIMIT_NPROC"))


def _limit_exec(limits):
    pairs = ",".join(f"(resource.{name},{value})" for name, value in limits)
    return ("import os,resource,sys\n"
            f"for key,value in ({pairs}):\n"
            " resource.setrlimit(key,(value,value))\n"
            "os.execvpe(sys.argv[1],sys.argv[1:],os.environ)\n")


# Executed inside the sandbox before the exact reviewed argv. No preexec_fn in
# a multithreaded controller, no eval, no shell interpolation and no inherited key.
_LIMIT_EXEC = _limit_exec(_RLIMITS)
_LIMIT_EXEC_DARWIN = _limit_exec(_DARWIN_RLIMITS)

# Seatbelt rules beyond the file and network policy. With no PID namespace, the user's other
# processes are visible to a test, so it may signal or inspect only processes in its own
# sandbox (KERN_PROCARGS2, which exposes another process's arguments and environment, needs
# both the process-info and the sysctl rule). Keychain, clipboard and Apple Events are user
# data that Mach IPC would otherwise reach. A test cannot set ACLs, so its scratch can always
# be removed.
_SEATBELT_RULES = (
    "(deny signal)", "(allow signal (target same-sandbox))",
    "(deny process-info*)", "(allow process-info* (target self))",
    "(allow process-info* (target same-sandbox))",
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") '
    '(global-name "com.apple.pasteboard.1") (global-name "com.apple.coreservices.appleevents"))',
    "(deny file-write-acl)",
)

LIMITATIONS = {
    "seatbelt": [
        "Shared host process namespace: there is no PID namespace. A test can signal and inspect "
        "only processes in its own sandbox, but its process tree is found by sampling, so a "
        "process that detaches between samples can outlive its command (still inside the "
        "Seatbelt policy and its rlimits).",
        "No private loopback: all network access is denied, including 127.0.0.1, so tests that "
        "start or contact a local server fail.",
        "System paths outside home folders (such as /usr, /Library, /Applications and /opt) stay "
        "readable. Home folders, DGC state, other runs and shared temporary folders do not.",
        "Memory (512 MiB aggregate footprint), process count (32) and scratch size (64 MiB) are "
        "sampled by the runner about every 50 ms, not kernel limits; a spike can exceed them "
        "between samples. CPU, file size, open files and core dumps are hard per-process rlimits.",
        "Apple marks sandbox-exec as deprecated; a future macOS release may change or remove it.",
    ],
}


def _hidden_paths(run):
    """Trees a Seatbelt test may not read: homes, DGC state, other runs, shared temp folders."""
    from .config import _user_home_root
    from .sandbox import _account_home, _isolated_state_dir
    candidates = [Path.home(), _account_home(), Path("/Users"), _user_home_root() / ".dgc", _isolated_state_dir()]
    if run.parent.name == "runs":
        candidates += [run.parent.parent, run.parent]
    candidates += [run, Path("/private/tmp"), Path("/private/var/tmp"), Path("/private/var/folders")]
    hidden = []
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            resolved = Path(candidate).resolve(strict=False)
        except (OSError, RuntimeError):
            continue
        if resolved != Path("/") and resolved not in hidden:
            hidden.append(resolved)
    return hidden


def _seatbelt_argv(helper, run, worktree, scratch, command):
    """Exact argv for one Seatbelt command: no shell, every helper an absolute path.

    The project copy is readable, never writable; the per-command scratch is the only
    writable tree. Seatbelt applies the last matching rule, so the copy and the scratch are
    re-allowed after the trees that contain them are hidden.
    """
    from . import seatbelt
    profile = seatbelt.profile(writable=[scratch], hidden=_hidden_paths(run), readable=[worktree, scratch],
                               reachable=[worktree, scratch], network=False, rules=_SEATBELT_RULES)
    return [helper, "-p", profile, *command]


def _seatbelt_env(scratch, python):
    # The selected developer folder's bin precedes /usr/bin, so `python3` and `git` in a
    # reviewed argv run the real tools rather than the xcrun shims.
    developer = str(Path(python).parent)
    return {"PATH": f"/usr/local/bin:/opt/homebrew/bin:{developer}:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(scratch / "home"), "TMPDIR": str(scratch / "tmp"), "LANG": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}


def _make_scratch(run):
    """A fresh private scratch tree for one command, inside the run's private folder."""
    path = run / "scratch"
    if os.path.lexists(path):
        _remove_scratch(path)  # left by an interrupted earlier command of this run
    path.mkdir(mode=0o700)
    (path / "home").mkdir(mode=0o700)
    (path / "tmp").mkdir(mode=0o700)
    return path


def _unlock(path):
    """Undo modes and user flags a test set on its own scratch, so the tree can be removed."""
    for root, dirs, files in os.walk(path, topdown=True, followlinks=False):
        for target in (root, *(os.path.join(root, name) for name in dirs + files)):
            try:
                info = os.lstat(target)
                if hasattr(os, "lchflags") and info.st_flags:
                    os.lchflags(target, 0)
                if stat.S_ISDIR(info.st_mode):
                    os.chmod(target, 0o700)
            except OSError:
                continue


def _remove_scratch(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode):
        os.unlink(path)
        return
    for attempt in range(2):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            if attempt:
                raise _error("A reviewed test left private scratch that could not be removed.",
                             "execution_cleanup_failed") from None
            _unlock(path)


def _scratch_bytes(path, maximum):
    """Allocated bytes under scratch, or maximum + 1 past the entry budget. Never follows links."""
    total, entries, pending = 0, 0, [path]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as listing:
                for entry in listing:
                    entries += 1
                    if entries > MAX_FILES:
                        return maximum + 1
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue  # removed between the listing and the stat
                    total += getattr(info, "st_blocks", 0) * 512
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(entry.path)
        except OSError:
            continue  # a directory the test made unreadable or already removed
        if total > maximum:
            return total
    return total


def _darwin_probe_code(scratch, hidden):
    """Real guarantees, checked from inside the profile; any other exception fails the probe."""
    return "\n".join([
        "import os,resource,socket",
        "def refused(action):",
        " try: action()",
        " except PermissionError: return True",
        " return False",
        "assert refused(lambda: open('probe.txt','a'))",
        "assert refused(lambda: open('created.txt','x'))",
        *(f"assert refused(lambda: os.listdir({str(path)!r}))" for path in hidden),
        "s=socket.socket(socket.AF_INET,socket.SOCK_STREAM)",
        "assert refused(lambda: s.connect(('127.0.0.1',9)))",
        "s.close()",
        f"assert refused(lambda: os.kill({os.getpid()},0))",
        "p=os.path.join(os.environ['TMPDIR'],'probe')",
        "open(p,'w').write('ok')",
        "assert open(p).read()=='ok'",
        f"assert os.environ['HOME'].startswith({str(scratch) + '/'!r})",
        *(f"assert resource.getrlimit(resource.{name})==({value},{value})" for name, value in _DARWIN_RLIMITS),
        "print('dgc-confined')",
    ])


def _probe_darwin(helper, python):
    from .sandbox import _account_home
    # The controller records every run with /usr/bin/git outside the sandbox. That shim fails
    # when, for example, the Xcode license has not been accepted; report it here rather than
    # as a failure in the first run's preparation. The developer folder exists by now, so the
    # shim cannot open an install prompt.
    if _capture(["/usr/bin/git", "--version"], maximum=4096, timeout=10, env=_GIT_ENV)["status"] != "passed":
        return False
    with tempfile.TemporaryDirectory(prefix="dgc-pip-confinement-") as directory:
        run = Path(directory).resolve()
        worktree = run / "worktree"
        worktree.mkdir(mode=0o700)
        (worktree / "probe.txt").write_text("probe\n")
        scratch = _make_scratch(run)
        try:
            # HOME, the account's home and this probe's own run folder must all be unreadable.
            hidden = [path.resolve() for path in (Path.home(), _account_home(), run)
                      if path is not None and path.is_dir()]
            argv = _seatbelt_argv(helper, run, worktree, scratch, [
                python, "-I", "-c", _LIMIT_EXEC_DARWIN, python, "-I", "-c", _darwin_probe_code(scratch, hidden)])
            checked = _capture(argv, maximum=4096, timeout=10, env=_seatbelt_env(scratch, python),
                               cwd=str(worktree), monitor=True, scratch=scratch)
        finally:
            _remove_scratch(scratch)
        return checked["status"] == "passed" and checked["data"].strip() == b"dgc-confined"


def _probe_bwrap(helper, python):
    with tempfile.TemporaryDirectory(prefix="dgc-pip-confinement-") as directory:
        probe = ("import os,resource; "
                 "assert os.statvfs('/workspace').f_flag & os.ST_RDONLY; "
                 "assert os.statvfs('/usr').f_flag & os.ST_RDONLY; "
                 "assert os.statvfs('/').f_flag & os.ST_RDONLY; "
                 "assert os.statvfs('/dev/shm').f_flag & os.ST_RDONLY; "
                 "assert not os.path.exists('/home'); "
                 "assert resource.getrlimit(resource.RLIMIT_AS)==(536870912,536870912); "
                 "assert resource.getrlimit(resource.RLIMIT_NPROC)==(32,32); "
                 "assert len(os.listdir('/proc/self/fd'))<10; print('dgc-confined')")
        argv = _sandbox_argv(Path(directory), ".", [python, "-I", "-c", _LIMIT_EXEC,
                             python, "-I", "-c", probe])
        checked = _capture(argv, maximum=1024, timeout=10, env={"PATH": "/usr/bin:/bin"})
        return checked["status"] == "passed" and checked["data"].strip() == b"dgc-confined"


def capability():
    backend = _backend()
    seatbelt = backend == "seatbelt"
    result = {"available": False, "platform": sys.platform, "backend": None, "reason": None,
              "network": False, "test_workspace": "read_only", "limits": dict(LIMITS),
              "memory_scope": ("sampled_aggregate_footprint" if seatbelt
                               else "per_process_with_sampled_aggregate_rss"),
              "cpu_scope": "per_process",
              "process_scope": "sampled_process_tree" if seatbelt else "per_namespace",
              "scratch_bytes": SCRATCH_BYTES,
              "limitations": list(LIMITATIONS.get(backend, []))}
    try:
        helper, python = _runtime()
        info, interpreter = Path(helper).stat(), Path(python).stat()
        key = (backend, helper, info.st_size, info.st_mtime_ns, python, interpreter.st_size,
               interpreter.st_mtime_ns, os.getuid(), str(Path.home()))
        with _PROBE_LOCK:
            cached, when = _PROBE_CACHE.get(key, (None, 0.0))
            if cached is None or (not cached and time.monotonic() - when >= FAILED_PROBE_SECONDS):
                cached = (_probe_darwin if seatbelt else _probe_bwrap)(helper, python)
                if len(_PROBE_CACHE) >= 8:
                    _PROBE_CACHE.clear()
                _PROBE_CACHE[key] = (cached, time.monotonic())
        if not cached:
            raise _error("The sandbox helper is installed but its confinement probe failed. Execution is unavailable.", "execution_unavailable")
        result.update(available=True, backend=backend)
    except (RegistryError, OSError, ValueError):
        from . import wsl
        if wsl.version() == 1:
            result["reason"] = ("This distro runs on WSL 1, which has no Linux kernel of its own, so DGC can't box "
                                "Patch and Pulse commands. Switch it to WSL 2 in Windows: "
                                f"`wsl --set-version {wsl.distro() or '<distro>'} 2`.")
            return result
        from .browser_setup import container_reason, in_container
        if backend == "bwrap" and in_container():
            result["reason"] = (container_reason("Pulse and Patch commands") + " DGC's local page checks "
                                "(dgc-http-check) need no sandbox and run anyway.")
            result["local_http_checks"] = True
            return result
        fix = machine_fix() if backend == "bwrap" else None
        result["reason"] = (
            "Patch and Pulse on macOS require sandbox-exec Seatbelt confinement, the selected Xcode or "
            "Command Line Tools Python 3 and Git, and the runner's process sampler; this runner did not "
            "pass that probe." if seatbelt else
            fix["reason"] if fix is not None else
            "Patch and Pulse require working Linux bubblewrap namespaces, isolated mounts and resource "
            "limits; this runner did not pass that probe." if backend == "bwrap" else
            "Patch and Pulse require Linux with bubblewrap or macOS with Seatbelt confinement; this "
            "platform has neither.")
        if fix is not None:
            result["fix"] = {"command": FIX_COMMAND, "runs": fix["shell"]}
    # DGC's own loopback HTTP checks need none of this (sandbox_required): say so, so a heartbeat isn't given up on.
    result["local_http_checks"] = True
    return result


# Ubuntu's own profile for bubblewrap, shipped but off (as dgc/pip_computer_box.UBUNTU_BWRAP_PROFILE uses for a
# Pip's computer): bwrap may make user namespaces, and what runs inside gets no capabilities.
UBUNTU_BWRAP_STEPS = (
    ("sudo", "apt", "update"),
    ("sudo", "apt", "install", "apparmor-profiles"),
    ("sudo", "install", "-m", "0644", "/usr/share/apparmor/extra-profiles/bwrap-userns-restrict", "/etc/apparmor.d/"),
    ("sudo", "apparmor_parser", "-r", "/etc/apparmor.d/bwrap-userns-restrict"),
)
INSTALL_BWRAP_STEPS = (("sudo", "apt", "install", "bubblewrap"),)


def machine_fix():
    """What keeps Pulse and Patch commands out of the sandbox on this Linux machine, when DGC knows the one-time fix:
    {reason, steps, shell}, else None. Never runs anything."""
    if not sys.platform.startswith("linux"):
        return None
    from .browser_setup import in_container
    if in_container():
        return None                  # no sudo inside a container fixes it: the container's own options do
    if not Path("/usr/bin/bwrap").exists():
        if shutil.which("apt") is None:
            return None
        steps = INSTALL_BWRAP_STEPS
        reason = ("Pulse and Patch run commands in a sealed-off copy with bubblewrap, which isn't installed on this "
                  f"computer. Install it once ({FIX_COMMAND} shows and runs the command), then check with "
                  "`dgc pips execution`.")
    else:
        from .browser_setup import userns_restricted
        if not userns_restricted():
            return None
        steps = UBUNTU_BWRAP_STEPS
        reason = ("Ubuntu 23.10 and later (24.04 included) let only programs with an AppArmor profile make the user "
                  "namespaces that bubblewrap, the sandbox Pulse and Patch run commands in, needs, and bubblewrap has "
                  "none here, so commands can't run on this computer. Turn on Ubuntu's own profile for it once: "
                  f"{FIX_COMMAND} shows and runs the commands (with your own sudo password), then check with "
                  "`dgc pips execution`. DGC's local page checks (dgc-http-check) need no sandbox and run anyway.")
    return {"reason": reason, "steps": [list(step) for step in steps],
            "shell": " && ".join(" ".join(step) for step in steps)}


def fix_machine(*, run=None, ask=None, out=None) -> int:
    """`dgc pips execution --fix`: say what keeps commands from running and the exact fix; in a terminal, ask, then
    run it with the user's own sudo prompt. DGC never runs sudo by itself: no terminal, no run."""
    import builtins
    out = out or (lambda text: print(text, flush=True))
    with _PROBE_LOCK:
        _PROBE_CACHE.clear()
    if capability()["available"]:
        out("Pulse and Patch commands already run in their sandbox on this computer. Nothing to fix.")
        return 0
    fix = machine_fix()
    if fix is None:
        out(capability()["reason"])
        out("DGC knows no one-time fix for this computer.")
        return 1
    out(fix["reason"])
    out("")
    out("The fix, which needs administrator rights (sudo):")
    for step in fix["steps"]:
        out("  " + " ".join(step))
    interactive = sys.stdin.isatty() and sys.stdout.isatty()
    if ask is None:
        if not interactive:
            out("")
            out("Run those commands in a terminal, or run `dgc pips execution --fix` in one to have DGC run them.")
            return 1
        ask = builtins.input
    try:
        answer = ask("Run them now? Your own sudo password prompt will appear. [y/N] ")
    except (EOFError, KeyboardInterrupt):
        answer = ""
    if str(answer).strip().lower() not in ("y", "yes"):
        out("Nothing was changed.")
        return 1
    # The user's own terminal, on purpose: sudo asks for their password there. Only reached in a terminal (above);
    # a chat and the model's shell are refused before this (pip_cli).
    run = run or (lambda argv: subprocess.run(argv, check=False, stdin=sys.stdin).returncode)
    for step in fix["steps"]:
        out("$ " + " ".join(step))
        code = run(list(step))
        if code != 0:
            out(f"That step failed (exit {code}). Nothing after it was run.")
            return code or 1
    with _PROBE_LOCK:
        _PROBE_CACHE.clear()
    result = capability()
    out("Pulse and Patch commands can run on this computer now." if result["available"]
        else "The sandbox still can't start: " + str(result["reason"]))
    return 0 if result["available"] else 1


def require_capability():
    result = capability()
    if not result["available"]:
        raise _error(result["reason"], "execution_unavailable")
    return result


def _kill(proc):
    if proc.returncode is not None:
        return  # A reaped process identifier is no longer ours to signal.
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        # macOS answers EPERM, not ESRCH, when the group holds only an unreaped zombie. The
        # child is not yet reaped, so its group cannot belong to anyone else.
        if sys.platform != "darwin":
            raise


def _descendant_usage(pid):
    """Bounded Linux process-tree sample; namespace process cap is authoritative."""
    queue, seen, rss, tasks = {pid}, set(), 0, 0
    maximum = LIMITS["processes"] + 2
    page = os.sysconf("SC_PAGE_SIZE")
    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.add(current)
        if len(seen) > maximum:
            return len(seen), LIMITS["memory_bytes"] + 1
        try:
            with open(f"/proc/{current}/statm", "rb") as stream:
                raw = stream.read(128)
            parts = raw.split()
            if len(parts) < 2 or not parts[1].isdigit() or len(parts[1]) > 20:
                raise _error("The test resource monitor could not read process memory.", "execution_monitor_failed")
            rss += int(parts[1]) * page
            # Linux keeps children per task, not only on the thread-group
            # leader. A nonleader thread can fork a memory-heavy child too.
            with os.scandir(f"/proc/{current}/task") as entries:
                for entry in entries:
                    tasks += 1
                    if tasks > maximum * 2:
                        return maximum + 1, LIMITS["memory_bytes"] + 1
                    if not entry.name.isdigit() or len(entry.name) > 12:
                        raise _error("The test task list is invalid.", "execution_monitor_failed")
                    try:
                        with open(f"/proc/{current}/task/{entry.name}/children", "rb") as stream:
                            raw = stream.read(4097)
                    except (FileNotFoundError, ProcessLookupError):
                        continue
                    parts = raw.split()
                    if len(raw) > 4096 or len(parts) > maximum or any(not p.isdigit() or len(p) > 12 for p in parts):
                        return maximum + 1, LIMITS["memory_bytes"] + 1
                    queue.update(int(p) for p in parts if int(p) not in seen)
                    if len(queue | seen) > maximum:
                        return maximum + 1, LIMITS["memory_bytes"] + 1
        except (FileNotFoundError, ProcessLookupError):
            continue  # A child can exit between the namespace and RSS samples.
    return len(seen), rss


class _LinuxProcesses:
    """bwrap's PID namespace is the process boundary; the sample is a secondary guard."""
    interval = 0.1

    def __init__(self, scratch=None):
        self._root = None

    def attach(self, pid, output=None):
        self._root = pid

    def exceeded(self):
        count, rss = _descendant_usage(self._root)
        # +2: bwrap and the namespace's init sit above the reviewed command.
        return count > LIMITS["processes"] + 2 or rss > LIMITS["memory_bytes"]

    def stop(self):
        pass  # The namespace ends with its init, and --die-with-parent ties it to the run.


class _DarwinProcesses:
    """Sampled accounting for Seatbelt, which shares the host's process namespace.

    There is no namespace to count or tear down, so the parent walks the tree through libproc:
    the children of every live member, plus every member of each process group that a member
    led (a process that daemonizes keeps the group it created, even once its parent exits).
    A pid counts as ours when it was seen before with the same start time, or when it is newly
    found from one of ours and started after this run began, so a recycled pid is never
    counted or signalled. When the reviewed command exits, whatever it left running is
    killed, as the end of a PID namespace would.
    """
    interval = 0.05
    _SCRATCH_EVERY = 4   # samples between scratch-size walks (about 0.2 s)

    def __init__(self, scratch=None):
        from .darwin_libproc import Libproc
        self._proc = Libproc()   # loaded before any spawn: a missing monitor never runs a test
        self._uid = os.getuid()
        self._since = time.time() - 1.0
        self._known = {}         # pid -> start time of every process of this run still relevant
        self._groups = set()     # process groups that held a live member at the last sample
        self._root = None
        self._scratch = scratch
        self._samples = 0
        self._output = 0         # the kernel's handle for the write end of the run's output pipe

    def attach(self, pid, output=None):
        # The controller has not reaped its child yet, so the pid is still this process. A
        # child that already exited is a zombie with no identity: record a start no process
        # can have, so the pid is never accepted again once it is reaped and recycled.
        info = self._identity(pid)
        self._root = pid
        self._known[pid] = info.start if info is not None and info.uid == self._uid else -1.0
        if output is not None:
            # OUTPUT is the controller's read end; its peer, the write end, is what the run inherited.
            try:
                end = self._proc.pipe_end(os.getpid(), output)
            except (AttributeError, OSError):
                end = None
            self._output = end[1] if end is not None else 0

    def _end_output_holders(self):
        """Kill what still holds the run's output pipe once no sample finds a member: a program the run left running
        that started, left its group and lost its parent between two samples (a fork whose parent exits at once, on
        a busy machine). Only a process of this user, started since the run began, holding that very pipe: nothing
        else can have it."""
        if not self._output:
            return
        me = os.getpid()
        try:
            for _ in range(20):
                found = []
                for pid in self._proc.uid_pids(self._uid, 16384):
                    if pid == me:
                        continue
                    info = self._identity(pid)
                    if info is None or info.uid != self._uid or info.start < self._since:
                        continue
                    if any(handle == self._output for handle, _peer in self._proc.pipe_ends(pid)):
                        found.append(pid)
                if not found:
                    return
                for pid in found:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
                time.sleep(0.01)
        except (AttributeError, OSError, RegistryError):
            return              # the samples' own stop stands; this pass only ever adds to it

    def _identity(self, pid):
        try:
            return self._proc.identity(pid)
        except PermissionError:
            return None  # another user's process is never one of ours
        except OSError as exc:
            raise _error("The test resource monitor could not read process identity.", "execution_monitor_failed") from exc

    def _ours(self, pid, info):
        if info is None or info.uid != self._uid:
            return False
        start = self._known.get(pid)
        return info.start >= self._since if start is None else start == info.start

    def _members(self, limit):
        """Live processes of this run; more than `limit` entries means over the cap."""
        live, pending, listed = {}, [], set()

        def list_group(pgid):
            if pgid in listed:
                return
            listed.add(pgid)
            start = self._known.get(pgid)
            if start is not None:
                leader = self._identity(pgid)
                if leader is not None and leader.start != start:
                    return  # a recycled pid: a group it leads now is not ours
            pending.extend(self._proc.group(pgid, limit + 2))

        try:
            if self._root is not None:
                pending.append(self._root)
            # Every pid of ours may have become a group leader (setsid) before it exited.
            for pgid in (*self._known, *self._groups):
                list_group(pgid)
            while pending and len(live) <= limit:
                pid = pending.pop()
                if pid in live:
                    continue
                info = self._identity(pid)
                if not self._ours(pid, info):
                    continue
                self._known[pid] = info.start
                live[pid] = info
                pending.extend(self._proc.children(pid, limit + 2))
                list_group(info.pgid)
        except RegistryError:
            raise
        except OSError as exc:
            raise _error("The test resource monitor could not list test processes.", "execution_monitor_failed") from exc
        # A group lives while it has members (and its id cannot be recycled meanwhile). Forget
        # a pid once it has exited and leads no live member's group: such a group can never
        # gain members again, and a recycled pid must not inherit it.
        self._groups = {info.pgid for info in live.values()}
        self._known = {pid: start for pid, start in self._known.items() if pid in live or pid in self._groups}
        return live

    def exceeded(self):
        live = self._members(LIMITS["processes"])
        # First: a walk stopped at the cap is incomplete, so it says nothing about the root.
        if len(live) > LIMITS["processes"]:
            return True
        if self._root not in live:
            # The reviewed command has exited; nothing it started may outlive it.
            self.stop()
            return False
        total = 0
        for pid in live:
            try:
                total += self._proc.memory(pid) or 0
            except OSError as exc:
                raise _error("The test resource monitor could not read process memory.", "execution_monitor_failed") from exc
        if total > LIMITS["memory_bytes"]:
            return True
        self._samples += 1
        if self._scratch is not None and self._samples % self._SCRATCH_EVERY == 1:
            return _scratch_bytes(self._scratch, SCRATCH_BYTES) > SCRATCH_BYTES
        return False

    def stop(self):
        """Kill every remaining member of this run, including detached process groups."""
        for _ in range(200):
            live = self._members(4096)
            if not live:
                self._end_output_holders()
                return
            # A member's group belongs to the session the root started or to one a member
            # created, never the controller's; while it has a member its id cannot be recycled.
            for group in {info.pgid for info in live.values()}:
                try:
                    os.killpg(group, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            for pid in live:
                try:
                    os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            time.sleep(0.005)
        raise _error("Processes started by a reviewed test could not all be stopped.", "execution_monitor_failed")


def _process_monitor(scratch=None):
    return (_DarwinProcesses if sys.platform == "darwin" else _LinuxProcesses)(scratch)


def _capture(argv, *, maximum, timeout, env, cancelled=None, monitor=False, cwd=None, scratch=None):
    """Bound output while reading, and kill the owned process group on every stop."""
    if cancelled is not None and cancelled.is_set():
        return {"status": "cancelled", "exit_code": None, "data": b"", "truncated": False}
    watch = _process_monitor(scratch) if monitor else None
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=env, cwd=cwd, start_new_session=True, close_fds=True)
    selector = selectors.DefaultSelector()
    data, status, truncated, eof = bytearray(), None, False, False
    deadline = time.monotonic() + timeout
    try:
        if watch is not None:
            watch.attach(proc.pid, output=proc.stdout.fileno())
        os.set_blocking(proc.stdout.fileno(), False)
        selector.register(proc.stdout, selectors.EVENT_READ)
        while True:
            if cancelled is not None and cancelled.is_set():
                status = "cancelled"
                break
            if time.monotonic() >= deadline:
                status = "timed_out"
                break
            if watch is not None and watch.exceeded():
                status = "resource_limit"
                break
            ready = selector.select(watch.interval if watch is not None else 0.1)
            if ready:
                chunk = os.read(proc.stdout.fileno(), min(4096, maximum - len(data) + 1))
                if not chunk:
                    selector.unregister(proc.stdout)
                    eof = True
                    if proc.poll() is not None:
                        break
                    continue
                if len(data) + len(chunk) > maximum:
                    data.extend(chunk[:maximum - len(data)])
                    truncated, status = True, "output_limit"
                    break
                data.extend(chunk)
            elif eof and proc.poll() is not None:
                break
        if status is not None:
            _kill(proc)
        code = proc.wait(timeout=5)
        return {"status": status or ("passed" if code == 0 else "failed"), "exit_code": code,
                "data": bytes(data), "truncated": truncated}
    finally:
        _kill(proc)
        proc.wait(timeout=5)
        try:
            if watch is not None:
                watch.stop()
        finally:
            selector.close()
            proc.stdout.close()


_GIT_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0", "GIT_LITERAL_PATHSPECS": "1", "GIT_ATTR_NOSYSTEM": "1"}


def _git(prepared, *args, maximum=4096):
    argv = ["/usr/bin/git", "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
            "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.attributesFile=/dev/null", "-c", "diff.external=",
            "--git-dir=" + str(prepared["git_dir"])]
    if not args or args[0] != "init":
        argv.append("--work-tree=" + str(prepared["worktree"]))
    argv.extend(args)
    result = _capture(argv, maximum=maximum, timeout=15, env=_GIT_ENV)
    if result["status"] != "passed":
        raise _error("The private Git artifact exceeded its budget or could not be recorded.", "execution_artifact_failed")
    return result["data"]


def _files(root):
    files, total, visited, pending = [], 0, 0, [root]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                visited += 1
                if visited > MAX_FILES:
                    raise _error("The isolated source exceeds its 10000-entry budget.", "execution_source_limit")
                relative = Path(entry.path).relative_to(root).as_posix()
                _relative(relative, "Isolated source path")
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    pending.append(Path(entry.path))
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    if info.st_size > MAX_FILE_BYTES:
                        raise _error("An isolated source file exceeds 4 MiB.", "execution_source_limit")
                    total += info.st_size
                    files.append((relative, info.st_size, stat.S_IMODE(info.st_mode)))
                else:
                    raise _error("Isolated source must not contain links or special files.", "unsafe_execution_path")
                if len(files) + len(pending) > MAX_FILES or total > MAX_SOURCE_BYTES:
                    raise _error("The isolated source exceeds its file-count or 64 MiB budget.", "execution_source_limit")
    return sorted(files), total


def prepare_isolated_repo(snapshot, run_dir, *, action=None):
    """Copy a clean committed snapshot; private Git metadata stays outside the edit root."""
    if action is None or sandbox_required(action):
        require_capability()
    source, run = _directory(snapshot), _directory(run_dir)
    if source.parent != run or source.name != "source":
        raise _error("Execution requires this run's private committed-source snapshot.", "unsafe_execution_path")
    files, total = _files(source)
    worktree, git_dir = run / "worktree", run / "private-git"
    if os.path.lexists(git_dir):
        raise _error("Private Git metadata already exists; do not reuse another preparation.", "unsafe_execution_path")
    worktree.mkdir(mode=0o700)
    try:
        for relative, size, mode in files:
            origin = _inside(source, relative)
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(origin, flags), "rb") as reader:
                info = os.fstat(reader.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != size:
                    raise _error("The committed source changed while making an isolated copy.", "unsafe_execution_path")
                target = worktree / relative
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with target.open("xb") as writer:
                    remaining = size
                    while remaining:
                        part = reader.read(min(65536, remaining))
                        if not part:
                            raise _error("The committed source was truncated.", "unsafe_execution_path")
                        writer.write(part)
                        remaining -= len(part)
                    if reader.read(1):
                        raise _error("The committed source grew while being copied.", "unsafe_execution_path")
                target.chmod(0o700 if mode & 0o111 else 0o600)
        prepared = {"worktree": str(worktree), "git_dir": str(git_dir), "run_dir": str(run), "files": len(files), "bytes": total}
        _git(prepared, "init", "--bare", "--quiet", "--template=")
        _git(prepared, "add", "--all", "--force", "--", ".")
        baseline = _git(prepared, "write-tree").decode("ascii").strip()
        if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", baseline):
            raise _error("The private baseline tree has an invalid identity.", "execution_artifact_failed")
        prepared["baseline"] = baseline
        return prepared
    except BaseException:
        # Only this function's exclusively-created worktree is removed. The
        # snapshot and any preexisting path are never cleanup targets.
        shutil.rmtree(worktree)
        raise


def _prepared(value):
    if not isinstance(value, dict) or not {"worktree", "git_dir", "run_dir", "baseline"} <= set(value):
        raise _error("Isolated execution needs its controller-created preparation record.")
    run = _directory(value["run_dir"])
    worktree, git_dir = _directory(value["worktree"]), _directory(value["git_dir"])
    if worktree != run / "worktree" or git_dir != run / "private-git" or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", value["baseline"]):
        raise _error("The isolated preparation record crosses its run boundary.", "unsafe_execution_path")
    return run, worktree


def _artifact(run, name, data):
    directory = run / "artifacts"
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        _directory(directory)
    path = directory / name
    with path.open("xb") as stream:
        stream.write(data)
    path.chmod(0o400)
    return {"path": "artifacts/" + name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def _preview(data, maximum):
    text = data[:maximum].decode("utf-8", "replace")
    encoded = text.encode("utf-8")
    return encoded[:maximum].decode("utf-8", "ignore"), len(data) > maximum or len(encoded) > maximum


def collect_artifacts(prepared, action):
    action = _canonical_action(action)
    run, root = _prepared(prepared)
    _files(root)
    _git(prepared, "add", "--all", "--force", "--", ".")
    names = _git(prepared, "diff", "--cached", "--name-only", "--no-renames", "-z", prepared["baseline"], maximum=65536)
    try:
        changed = [_relative(value.decode("utf-8"), "Changed path") for value in names.split(b"\0") if value]
    except UnicodeError:
        raise _error("Changed paths must be UTF-8 text.", "execution_artifact_failed") from None
    allowed = action.get("write_paths", [])
    if len(changed) > MAX_WRITE_PATHS or any(path not in allowed for path in changed):
        raise _error("The isolated copy changed outside the exact reviewed write paths.", "execution_denied")
    diff = _git(prepared, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary",
                prepared["baseline"], "--", maximum=MAX_DIFF_BYTES)
    artifact = _artifact(run, "changes.patch", diff)
    preview, truncated = _preview(diff, 8192)
    return {"kind": action["kind"], "changed_files": changed, "diff": preview,
            "diff_truncated": truncated, "artifact": artifact}


def verify_unmodified(prepared, action):
    """Check a Pulse copy without republishing an existing change artifact."""
    action = _canonical_action(action)
    if action['kind'] != 'test':
        raise _error('Only a read-only Pulse copy can use this check.', 'execution_denied')
    _, root = _prepared(prepared)
    _files(root)
    _git(prepared, 'add', '--all', '--force', '--', '.')
    changed = _git(prepared, 'diff', '--cached', '--name-only', '--no-renames', '-z', prepared['baseline'], maximum=65536)
    if changed:
        raise _error('The isolated Pulse copy changed during verification.', 'execution_denied')


def _http_python():
    """The interpreter for DGC's own loopback checker: this DGC's Python, isolated (-I) with an explicit environment.
    It needs no sandbox helper, so a local page check runs where bubblewrap can't start."""
    return sys.executable or "/usr/bin/python3"


def _run_http_check(test, cancelled):
    """DGC's fixed loopback HTTP checker (pip_http_checks.WORKER) for one validated test, in a plain subprocess."""
    from .pip_http_checks import WORKER, WALL_SECONDS
    return _capture([_http_python(), '-I', '-c', WORKER, *test['argv'][1:]], maximum=LIMITS["output_bytes"],
                    timeout=WALL_SECONDS, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                    cancelled=cancelled, monitor=True)


def _run_command(runtime, run, root, directory, test, local_http, cancelled):
    """Launch one reviewed command under the platform's confinement."""
    if local_http:
        return _run_http_check(test, cancelled)
    helper, python = runtime
    if _backend() == "seatbelt":
        # No mount namespace: the command runs in the copy's real path, not /workspace.
        command = [python, "-I", "-c", _LIMIT_EXEC_DARWIN, *test["argv"]]
        scratch = _make_scratch(run)
        try:
            return _capture(_seatbelt_argv(helper, run, root, scratch, command), maximum=LIMITS["output_bytes"],
                            timeout=LIMITS['wall_seconds'], env=_seatbelt_env(scratch, python), cancelled=cancelled,
                            monitor=True, cwd=str(directory), scratch=scratch)
        finally:
            _remove_scratch(scratch)
    command = [python, "-I", "-c", _LIMIT_EXEC, *test["argv"]]
    return _capture(_sandbox_argv(root, test["cwd"], command), maximum=LIMITS["output_bytes"],
                    timeout=LIMITS['wall_seconds'], env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                    cancelled=cancelled, monitor=True)


def run_reviewed_tests(prepared, action, *, cancelled=None, before_command=None, after_command=None):
    action = _canonical_action(action)
    if sandbox_required(action):
        require_capability()
    run, root = _prepared(prepared)
    return _run_tests(run, root, action, cancelled, before_command, after_command)


def run_local_http_checks(run_dir, action, *, cancelled=None, before_command=None, after_command=None):
    """A Pulse plan of DGC's own loopback checks only (sandbox_required is False): no copy of the project, no sandbox.
    Outcomes and artifacts are recorded exactly as run_reviewed_tests records them, in the run's private folder."""
    action = _canonical_action(action)
    if sandbox_required(action):
        raise _error("Only DGC's own local page checks run without the sandbox.", "execution_denied")
    return _run_tests(_directory(run_dir), None, action, cancelled, before_command, after_command)


def _run_tests(run, root, action, cancelled, before_command, after_command):
    runtime, results = None, []
    for index, test in enumerate(action["tests"]):
        local_http = action['network'] == 'loopback_http_v1'
        directory = _inside(root, test["cwd"], directory=True) if root is not None else None
        if local_http:
            from .pip_http_checks import validate_test
            validate_test(test)
        if before_command is not None:
            before_command(index, {"argv": list(test["argv"]), "cwd": test["cwd"]})
        if cancelled is not None and cancelled.is_set():
            # Once cancelled, nothing more is resolved or launched (macOS resolves its
            # developer tools with a process).
            result = {"status": "cancelled", "exit_code": None, "data": b"", "truncated": False}
        else:
            runtime = runtime or (None if local_http else _runtime())
            result = _run_command(runtime, run, root, directory, test, local_http, cancelled)
        artifact = _artifact(run, f"test-{index + 1}.txt", result["data"])
        output, truncated = _preview(result["data"], 4096)
        results.append({"index": index, "argv": list(test["argv"]), "cwd": test["cwd"], "status": result["status"],
                        "exit_code": result["exit_code"], "output": output,
                        "output_truncated": truncated or result["truncated"], "artifact": artifact})
        if after_command is not None:
            # A detached callback cannot replace native outcomes or mutate the
            # next reviewed argv. Failure prevents all subsequent commands.
            after_command(index, json.loads(json.dumps(results[-1])))
        if result["status"] in ("cancelled", "timed_out", "output_limit", "resource_limit"):
            break
    return results


VERIFICATION = "Isolated changes and reviewed command results; no automatic apply, merge or deployment."


def validate_command_result(value, action, index):
    """One native invocation; no approval, process launch, or success inference."""
    action = _canonical_action(action)
    def fail():
        raise _error("Command outcome does not match its bounded reviewed invocation.", "invalid_execution_result")
    if type(index) is not int or not 0 <= index < len(action['tests']): fail()
    if (type(value) is not dict or set(value) != {'index','argv','cwd','status','exit_code','output','output_truncated','artifact'}
            or type(value['index']) is not int or value['index'] != index
            or type(value['argv']) is not list or not 1 <= len(value['argv']) <= 32
            or any(type(arg) is not str or len(arg) > 1024 for arg in value['argv'])
            or type(value['cwd']) is not str or len(value['cwd']) > 1024
            or value['argv'] != action['tests'][index]['argv'] or value['cwd'] != action['tests'][index]['cwd']
            or type(value['status']) is not str or value['status'] not in ('passed','failed','timed_out','cancelled','output_limit','resource_limit')
            or type(value['output_truncated']) is not bool): fail()
    output, artifact, code = value['output'], value['artifact'], value['exit_code']
    if type(output) is not str or len(output) > 4096: fail()
    try:
        if len(output.encode('utf-8')) > 4096: fail()
    except UnicodeError: fail()
    if (type(artifact) is not dict or set(artifact) != {'path','sha256','bytes'}
            or artifact['path'] != f'artifacts/test-{index+1}.txt'
            or type(artifact['sha256']) is not str or re.fullmatch('[0-9a-f]{64}', artifact['sha256']) is None
            or type(artifact['bytes']) is not int or not 0 <= artifact['bytes'] <= LIMITS['output_bytes']): fail()
    if code is None:
        if value['status'] != 'cancelled' or output or artifact['bytes']: fail()
    elif type(code) is not int or not -128 <= code <= 255: fail()
    if (value['status'] == 'passed' and code != 0) or (value['status'] == 'failed' and code == 0): fail()
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


def validate_execution_result(result, action):
    """Pure controller/finish guard: command evidence cannot acquire audit claims."""
    action = _canonical_action(action)
    required = {"summary", "verification", "tests_executed", "execution"}
    if (not isinstance(result, dict) or not required <= set(result)
            or set(result) - required - {"usage", "tools_called", "snapshot", "specialists"}):
        raise _error("Execution results require summary, verification, tests_executed and execution.", "invalid_execution_result")

    def text(value, maximum, *, nonempty=False):
        if not isinstance(value, str) or len(value) > maximum or (nonempty and not value.strip()):
            raise _error("Execution result text exceeds its bounded schema.", "invalid_execution_result")
        try:
            if len(value.encode("utf-8")) > maximum:
                raise _error("Execution result text exceeds its byte budget.", "invalid_execution_result")
        except UnicodeError:
            raise _error("Execution result text is not valid Unicode.", "invalid_execution_result") from None

    def integer(value, maximum, minimum=0):
        if type(value) is not int or not minimum <= value <= maximum:
            raise _error("Execution result counts must be bounded integers.", "invalid_execution_result")

    def artifact(value, expected, maximum):
        if not isinstance(value, dict) or set(value) != {"path", "sha256", "bytes"} or value["path"] != expected:
            raise _error("Execution artifact references must match the private run artifact.", "invalid_execution_result")
        if not isinstance(value["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"]):
            raise _error("Execution artifact digest is invalid.", "invalid_execution_result")
        integer(value["bytes"], maximum)

    text(result["summary"], 4000, nonempty=True)
    if result["verification"] != VERIFICATION or type(result["tests_executed"]) is not bool:
        raise _error("Execution results cannot claim audit verification or automatic application.", "invalid_execution_result")
    execution = result["execution"]
    if (not isinstance(execution, dict) or not {"changes", "tests"} <= set(execution)
            or set(execution) - {"changes", "tests", "tests_not_run", "input"}):
        raise _error("Execution results need bounded changes and exact reviewed test results.", "invalid_execution_result")
    if "input" in execution:
        receipt = execution["input"]
        if (action["kind"] != "test" or not isinstance(receipt, dict)
                or set(receipt) != {"type", "source_run_id", "source_revision", "artifact_sha256", "tree"}
                or receipt["type"] != "patch_artifact.v1"
                or not isinstance(receipt["source_run_id"], str) or not re.fullmatch(r"run_[0-9a-f]{32}", receipt["source_run_id"])
                or any(not isinstance(receipt[key], str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", receipt[key])
                       for key in ("source_revision", "tree"))
                or not isinstance(receipt["artifact_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", receipt["artifact_sha256"])):
            raise _error("The reconstructed Patch input receipt is invalid.", "invalid_execution_result")
    changes = execution["changes"]
    if (not isinstance(changes, dict) or set(changes) != {"kind", "changed_files", "diff", "diff_truncated", "artifact"}
            or changes["kind"] != action["kind"] or type(changes["diff_truncated"]) is not bool):
        raise _error("Execution changes have an invalid schema or action kind.", "invalid_execution_result")
    paths = changes["changed_files"]
    if (not isinstance(paths, list) or len(paths) > MAX_WRITE_PATHS
            or any(not isinstance(path, str) or path not in action.get("write_paths", []) for path in paths)
            or len(set(paths)) != len(paths)):
        raise _error("Execution changes extend beyond the exact reviewed paths.", "invalid_execution_result")
    text(changes["diff"], 8192)
    artifact(changes["artifact"], "artifacts/changes.patch", MAX_DIFF_BYTES)
    if not paths and (changes["diff"] or changes["artifact"]["bytes"]):
        raise _error("An unchanged copy cannot claim a nonempty change artifact.", "invalid_execution_result")
    tests = execution["tests"]
    if not isinstance(tests, list) or len(tests) > len(action["tests"]):
        raise _error("Only reviewed commands may appear as executed tests.", "invalid_execution_result")
    stop_states = {"timed_out", "cancelled", "output_limit", "resource_limit"}
    executed = 0
    for index, test in enumerate(tests):
        validate_command_result(test, action, index)
        if (not isinstance(test, dict) or set(test) != {"index", "argv", "cwd", "status", "exit_code", "output", "output_truncated", "artifact"}
                or type(test["index"]) is not int or test["index"] != index
                or test["argv"] != action["tests"][index]["argv"] or test["cwd"] != action["tests"][index]["cwd"]
                or test["status"] not in ("passed", "failed", "timed_out", "cancelled", "output_limit", "resource_limit")
                or type(test["output_truncated"]) is not bool):
            raise _error("Test result does not match its reviewed command and order.", "invalid_execution_result")
        code = test["exit_code"]
        if code is not None:
            integer(code, 255, -128)
            executed += 1
        elif test["status"] != "cancelled":
            raise _error("Only a cancellation before spawn may lack an exit code.", "invalid_execution_result")
        if ((test["status"] == "passed" and code != 0) or (test["status"] == "failed" and code == 0)
                or (test["status"] in stop_states and index != len(tests) - 1)):
            raise _error("Test status does not match its process outcome.", "invalid_execution_result")
        text(test["output"], 4096)
        artifact(test["artifact"], f"artifacts/test-{index + 1}.txt", LIMITS["output_bytes"])
        if code is None and (test["output"] or test["artifact"]["bytes"]):
            raise _error("A command cancelled before spawn cannot claim captured output.", "invalid_execution_result")
    missing = len(action["tests"]) - len(tests)
    if missing and (not tests or tests[-1]["status"] not in stop_states):
        raise _error("Reviewed commands are missing without an explicit stopped outcome.", "invalid_execution_result")
    not_run = len(action["tests"]) - executed
    if "tests_not_run" in execution:
        integer(execution["tests_not_run"], MAX_COMMANDS)
        if execution["tests_not_run"] != not_run:
            raise _error("The omitted test count is inconsistent.", "invalid_execution_result")
    if result["tests_executed"] != bool(executed):
        raise _error("The result cannot claim test execution without a started command.", "invalid_execution_result")
    if "tools_called" in result:
        integer(result["tools_called"], 1_000_000)        # a real count; specialist receipts check their own
    if 'specialists' in action:
        from .pip_specialists import validate_result as validate_specialists
        checked_specialists = validate_specialists(result.get('specialists'), action['specialists'])
        if result.get('tools_called') != checked_specialists['tool_calls']:
            raise _error('Specialist tools must match the complete run count.', 'invalid_execution_result')
    elif 'specialists' in result:
        raise _error('This action did not authorize specialist work.', 'invalid_execution_result')
    if "usage" in result:
        usage = result["usage"]
        if not isinstance(usage, dict) or set(usage) - {"input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "requests"}:
            raise _error("Execution usage contains unsupported fields.", "invalid_execution_result")
        for count in usage.values():
            integer(count, 2**63 - 1)
    if "snapshot" in result:
        info = result["snapshot"]
        if (not isinstance(info, dict) or set(info) != {"sha256", "files", "bytes"}
                or not isinstance(info["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", info["sha256"])):
            raise _error("Execution source snapshot metadata is invalid.", "invalid_execution_result")
        integer(info["files"], MAX_FILES)
        integer(info["bytes"], MAX_SOURCE_BYTES)
    canonical = {**result, "execution": {**execution, "tests_not_run": not_run}}
    raw = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(raw) > 65536:
        raise _error("The complete execution result exceeds 64 KiB.", "invalid_execution_result")
    return json.loads(raw)
