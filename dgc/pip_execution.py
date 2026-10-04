"""Reviewed Patch/Pulse actions in a private copy, never the user's working tree.

Only the controller grants an immutable action. Models have no command executor:
reviewed shell argv uses mandatory Linux confinement. The standalone fixed HTTP
probe uses a separately reviewed loopback profile, never project code. Hard
AS/CPU limits are per process; aggregate RSS is a sampled guard, not a hard ceiling.
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


def _runtime():
    if not sys.platform.startswith("linux"):
        raise _error("Patch and Pulse execution currently require Linux with working bubblewrap confinement.", "execution_unavailable")
    bwrap, python = Path("/usr/bin/bwrap"), Path("/usr/bin/python3")
    for path in (bwrap, python, Path("/usr/bin/git")):
        try:
            info = path.resolve(strict=True).stat()
        except OSError:
            raise _error("This runner needs system bubblewrap, Python 3 and Git for isolated execution.", "execution_unavailable") from None
        if not stat.S_ISREG(info.st_mode) or not os.access(path, os.X_OK):
            raise _error("A required execution helper is unavailable.", "execution_unavailable")
    return str(bwrap), str(python)


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


# Executed inside the namespace before the exact reviewed argv. No preexec_fn in
# a multithreaded controller, no eval, no shell interpolation and no inherited key.
_LIMIT_EXEC = """import os,resource,sys
for key,value in ((resource.RLIMIT_AS,536870912),(resource.RLIMIT_CPU,30),(resource.RLIMIT_FSIZE,67108864),(resource.RLIMIT_NOFILE,64),(resource.RLIMIT_NPROC,32),(resource.RLIMIT_CORE,0)):
 resource.setrlimit(key,(value,value))
os.execvpe(sys.argv[1],sys.argv[1:],os.environ)
"""


def capability():
    result = {"available": False, "platform": sys.platform, "backend": None, "reason": None,
              "network": False, "test_workspace": "read_only", "limits": dict(LIMITS),
              "memory_scope": "per_process_with_sampled_aggregate_rss", "cpu_scope": "per_process",
              "scratch_bytes": SCRATCH_BYTES}
    try:
        bwrap, python = _runtime()
        info = Path(bwrap).stat()
        key = (bwrap, info.st_size, info.st_mtime_ns, os.getuid())
        with _PROBE_LOCK:
            cached = _PROBE_CACHE.get(key)
            if cached is None:
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
                    cached = checked["status"] == "passed" and checked["data"].strip() == b"dgc-confined"
                if len(_PROBE_CACHE) >= 8:
                    _PROBE_CACHE.clear()
                _PROBE_CACHE[key] = cached
        if not cached:
            raise _error("Bubblewrap is installed but its required namespace, read-only mounts or resource-limit probe failed. Execution is unavailable.", "execution_unavailable")
        result.update(available=True, backend="bwrap")
    except (RegistryError, OSError, ValueError):
        result["reason"] = "Patch and Pulse require working Linux bubblewrap namespaces, isolated mounts and resource limits; this runner did not pass that probe."
    return result


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


def _capture(argv, *, maximum, timeout, env, cancelled=None, monitor=False):
    """Bound output while reading, and kill the owned process group on every stop."""
    if cancelled is not None and cancelled.is_set():
        return {"status": "cancelled", "exit_code": None, "data": b"", "truncated": False}
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=env, start_new_session=True, close_fds=True)
    selector = selectors.DefaultSelector()
    data, status, truncated, eof = bytearray(), None, False, False
    deadline = time.monotonic() + timeout
    try:
        os.set_blocking(proc.stdout.fileno(), False)
        selector.register(proc.stdout, selectors.EVENT_READ)
        while True:
            if cancelled is not None and cancelled.is_set():
                status = "cancelled"
                break
            if time.monotonic() >= deadline:
                status = "timed_out"
                break
            if monitor:
                count, rss = _descendant_usage(proc.pid)
                if count > LIMITS["processes"] + 2 or rss > LIMITS["memory_bytes"]:
                    status = "resource_limit"
                    break
            ready = selector.select(0.1)
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
        selector.close()
        proc.stdout.close()


def _git(prepared, *args, maximum=4096):
    argv = ["/usr/bin/git", "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
            "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.attributesFile=/dev/null", "-c", "diff.external=",
            "--git-dir=" + str(prepared["git_dir"])]
    if not args or args[0] != "init":
        argv.append("--work-tree=" + str(prepared["worktree"]))
    argv.extend(args)
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1",
           "GIT_OPTIONAL_LOCKS": "0", "GIT_LITERAL_PATHSPECS": "1", "GIT_ATTR_NOSYSTEM": "1"}
    result = _capture(argv, maximum=maximum, timeout=15, env=env)
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


def prepare_isolated_repo(snapshot, run_dir):
    """Copy a clean committed snapshot; private Git metadata stays outside the edit root."""
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


def run_reviewed_tests(prepared, action, *, cancelled=None, before_command=None, after_command=None):
    action = _canonical_action(action)
    require_capability()
    run, root = _prepared(prepared)
    _, python = _runtime()
    results = []
    for index, test in enumerate(action["tests"]):
        _inside(root, test["cwd"], directory=True)
        if action['network'] == 'loopback_http_v1':
            from .pip_http_checks import validate_test, WORKER, WALL_SECONDS
            validate_test(test)
            argv = [python, '-I', '-c', WORKER, *test['argv'][1:]]
            timeout = WALL_SECONDS
        else:
            command = [python, "-I", "-c", _LIMIT_EXEC, *test["argv"]]
            argv = _sandbox_argv(root, test["cwd"], command)
            timeout = LIMITS['wall_seconds']
        if before_command is not None:
            before_command(index, {"argv": list(test["argv"]), "cwd": test["cwd"]})
        result = _capture(argv, maximum=LIMITS["output_bytes"], timeout=timeout,
                          env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, cancelled=cancelled, monitor=True)
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
        integer(result["tools_called"], 64)
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
