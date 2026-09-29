"""Git worktrees for TUI fleets, manual sessions, and write-capable sub-agents.

Managed fleet worktrees are private interactive branches that retain changed work across resume;
manual worktrees are long-lived branches selected with ``/worktree``. Task worktrees are private,
unique, short-lived branches populated with the calling checkout's exact tracked/untracked state.
Only the sub-agent's delta is integrated, after a content-level conflict check; pre-existing dirty
files are never overwritten automatically.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

_MAX_TASK_FILES = 4096
_MAX_TASK_BYTES = 64 * 1024 * 1024
_MAX_RETAINED_METADATA_BYTES = 1024 * 1024
_GIT_TIMEOUT = 30.0
_MAX_GIT_TEXT_BYTES = 4 * 1024 * 1024
_MAX_GIT_PATH_BYTES = 20 * 1024 * 1024
_MAX_GIT_STDERR_BYTES = 64 * 1024
_RETAINED_SCHEMA = 2
_FLEET_SCHEMA = 1
_RETAINED_LEASE_WAIT_S = 2.0


class _GitCapture:
    """Drain a Git stream while retaining either an exact prefix or bounded head/tail."""

    def __init__(self, limit: int, *, tail: bool = False):
        self.limit = max(1, int(limit))
        self.tail_mode = tail
        self.head = bytearray()
        self.tail = bytearray()
        self.total = 0

    @property
    def exceeded(self) -> bool:
        return self.total > self.limit

    def feed(self, chunk: bytes) -> None:
        if not chunk:
            return
        self.total += len(chunk)
        if not self.tail_mode:
            remaining = self.limit - len(self.head)
            if remaining > 0:
                self.head.extend(chunk[:remaining])
            return
        half = self.limit // 2
        remaining = half - len(self.head)
        if remaining > 0:
            self.head.extend(chunk[:remaining])
            chunk = chunk[remaining:]
        if chunk:
            self.tail.extend(chunk)
            if len(self.tail) > self.limit - half:
                del self.tail[:len(self.tail) - (self.limit - half)]

    def bytes(self) -> bytes:
        if not self.tail_mode or not self.exceeded:
            return bytes(self.head + self.tail)
        omitted = self.total - len(self.head) - len(self.tail)
        return (bytes(self.head) + f"\n… [{omitted} git-output bytes omitted] …\n".encode()
                + bytes(self.tail))


def _git_timeout(value) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = _GIT_TIMEOUT
    if not math.isfinite(parsed):
        parsed = _GIT_TIMEOUT
    return max(0.1, min(300.0, parsed))


def _repo_hint(path: Path) -> Path:
    """Find the nearest lexical Git boundary without executing a repository-controlled binary."""
    resolved = path.resolve(strict=False)
    for candidate in (resolved, *resolved.parents):
        try:
            if (candidate / ".git").exists():
                return candidate
        except OSError:
            continue
    return resolved


def _git_executable(cwd) -> Path | None:
    candidate = shutil.which("git")
    if not candidate:
        return None
    try:
        executable = Path(candidate).resolve(strict=True)
        if not executable.is_file() or not os.access(executable, os.X_OK):
            return None
        executable.relative_to(_repo_hint(Path(cwd)))
        return None  # Never execute a model-writable repository's PATH-shadowed `git`.
    except ValueError:
        return executable
    except OSError:
        return None


def _terminate_git(proc: subprocess.Popen) -> None:
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:  # Windows Job Object coverage remains in the cross-platform soak gap.
            proc.kill()
    except (OSError, ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        pass
    for stream in (proc.stdout, proc.stderr):
        try:
            if stream is not None:
                stream.close()
        except (OSError, ValueError):
            pass


def _run_git(args: list[str], cwd, *, timeout: float, max_stdout: int,
             text: bool, read_only: bool = False, cancelled=None) -> subprocess.CompletedProcess:
    executable = _git_executable(cwd)
    display_args = ["git", *args]
    if executable is None:
        error = b"trusted git executable was not found outside the repository"
        return subprocess.CompletedProcess(
            display_args, 127, "" if text else b"", error.decode() if text else error)
    argv = [str(executable), "--no-pager", "-c", "core.hooksPath=",
            "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false",
            "-c", "gc.auto=0", *args]
    from .guards import mcp_process_env
    env, _ = mcp_process_env(None)
    env.update({
        "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never",
        "GIT_ASKPASS": "", "SSH_ASKPASS_REQUIRE": "never",
        "GIT_EDITOR": "true", "GIT_SEQUENCE_EDITOR": "true",
        "GIT_PAGER": "cat", "PAGER": "cat", "GIT_LITERAL_PATHSPECS": "1",
        "LC_ALL": "C",
    })
    if read_only:
        # Object inspection must never fetch missing objects, launch a transport/helper, refresh
        # the index, or resolve replacement objects. GIT_ALLOW_PROTOCOL also protects older Git
        # versions that predate GIT_NO_LAZY_FETCH. Callers still restrict argv to read operations.
        env.update(GIT_NO_LAZY_FETCH="1", GIT_ALLOW_PROTOCOL="", GIT_OPTIONAL_LOCKS="0",
                   GIT_NO_REPLACE_OBJECTS="1")
    popen_kwargs = {
        "cwd": str(cwd), "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "env": env,
    }
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True
    elif os.name == "nt":  # pragma: no cover - Windows full-suite runner remains outstanding
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        proc = subprocess.Popen(argv, **popen_kwargs)
    except OSError as exc:
        error = os.fsencode(str(exc))
        return subprocess.CompletedProcess(
            display_args, 127, "" if text else b"", error.decode(errors="replace") if text else error)

    stdout = _GitCapture(max_stdout)
    stderr = _GitCapture(_MAX_GIT_STDERR_BYTES, tail=True)
    reader_errors: list[str] = []

    def drain(stream, capture: _GitCapture) -> None:
        try:
            if stream is not None:
                while True:
                    chunk = stream.read(64 * 1024)
                    if not chunk:
                        break
                    capture.feed(chunk)
        except (OSError, ValueError) as exc:
            reader_errors.append(type(exc).__name__)

    out_reader = threading.Thread(target=drain, args=(proc.stdout, stdout), daemon=True)
    err_reader = threading.Thread(target=drain, args=(proc.stderr, stderr), daemon=True)
    out_reader.start()
    err_reader.start()
    deadline = time.monotonic() + _git_timeout(timeout)
    failure = ""
    while True:
        if cancelled is not None and cancelled.is_set():
            failure = "git cancelled"
            break
        if stdout.exceeded:
            failure = f"git stdout exceeded {max_stdout} bytes"
            break
        if proc.poll() is not None and not out_reader.is_alive() and not err_reader.is_alive():
            break
        if time.monotonic() >= deadline:
            failure = "git timed out"
            break
        time.sleep(0.005)
    if failure:
        _terminate_git(proc)
    out_reader.join(timeout=1)
    err_reader.join(timeout=1)
    if out_reader.is_alive() or err_reader.is_alive():
        _terminate_git(proc)
        failure = failure or "git output pipes did not close"
        out_reader.join(timeout=1)
        err_reader.join(timeout=1)

    # The reader can cross the ceiling after the loop checks ``stdout.exceeded`` but before the
    # adjacent process/readers-finished check becomes true.  Reconcile the final drained byte count
    # directly: otherwise that scheduling window returns Git's zero status with a silently truncated
    # payload.  At this point a no-failure path has observed process exit and joined both readers, so
    # ``total`` is the authoritative final count and no extra process termination is needed.
    if not failure and stdout.total > stdout.limit:
        failure = f"git stdout exceeded {max_stdout} bytes"

    for stream in (proc.stdout, proc.stderr):
        if stream is not None:
            stream.close()

    out = stdout.bytes()
    err = stderr.bytes()
    if failure or reader_errors:
        detail = failure or f"git output read failed ({', '.join(reader_errors[:2])})"
        suffix = (b"\n" if err else b"") + detail.encode()
        err = err[:max(0, _MAX_GIT_STDERR_BYTES - len(suffix))] + suffix
        returncode = 124 if detail == "git timed out" else 125
    else:
        returncode = int(proc.returncode or 0)
    from .redaction import redact_text, secret_values
    safe_error = redact_text(err.decode(errors="replace"), secret_values())
    if text:
        return subprocess.CompletedProcess(
            display_args, returncode, out.decode(errors="replace"), safe_error)
    return subprocess.CompletedProcess(display_args, returncode, out, safe_error.encode("utf-8"))


def _git(args: list[str], cwd, *, timeout: float = _GIT_TIMEOUT) -> subprocess.CompletedProcess:
    return _run_git(args, cwd, timeout=timeout, max_stdout=_MAX_GIT_TEXT_BYTES, text=True)


def _git_bytes(args: list[str], cwd, *, timeout: float = _GIT_TIMEOUT,
               max_stdout: int = _MAX_GIT_PATH_BYTES) -> subprocess.CompletedProcess:
    return _run_git(args, cwd, timeout=timeout, max_stdout=max_stdout, text=False)


def repo_root(path) -> Path | None:
    r = _git(["rev-parse", "--show-toplevel"], path)
    return Path(r.stdout.strip()).resolve() if r.returncode == 0 and r.stdout.strip() else None


def in_repo(path) -> bool:
    return repo_root(path) is not None


def _safe(name: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", name).lower()
    while ".." in value:
        value = value.replace("..", "-")
    value = value.strip(".-")
    if value.endswith(".lock"):
        value += "-work"
    return value or "work"


def _task_repo_prefixes(repo: Path) -> list[str]:
    """Current bounded task prefix plus compatibility with pre-v2 generated paths."""
    values = {_safe(repo.name)[:60] + "-task-", _safe(repo.name) + "-task-",
              repo.name + "-task-"}
    return sorted(values, key=len, reverse=True)


def _bounded_safe(name: str, limit: int) -> str:
    return _safe(_safe(name)[:max(1, limit)])


def list_worktrees(path) -> list[dict]:
    r = _git(["worktree", "list", "--porcelain"], path)
    if r.returncode != 0:
        return []
    out, cur = [], {}
    for line in r.stdout.splitlines():
        if line.startswith("worktree "):
            if cur:
                out.append(cur)
                if len(out) > _MAX_TASK_FILES:
                    return []
            cur = {"path": line[len("worktree "):]}
        elif line.startswith("branch "):
            cur["branch"] = line[len("branch "):].replace("refs/heads/", "")
        elif line == "bare":
            cur["bare"] = True
    if cur:
        out.append(cur)
    if len(out) > _MAX_TASK_FILES:
        return []
    return out


# Paths `create` handed back without making them. A caller's failure path must not remove one:
# it belongs to the user, not to this run.
_ATTACHED: set[str] = set()


def was_created(path) -> bool:
    """Did THIS process create that worktree, or merely attach to an existing one?"""
    from pathlib import Path as _Path
    return str(_Path(str(path)).resolve(strict=False)) not in _ATTACHED


def create(path, name: str) -> tuple[Path | None, str | None, str | None]:
    """Create a long-lived manual worktree on ``dgc/<name>``, or return one that already exists.

    Callers that clean up on failure must ask `was_created()` first: since this returns an
    existing worktree rather than refusing, an error path that removes "the worktree we just
    made" would delete a checkout the user has been working in for days.
    """
    root = repo_root(path)
    if not root:
        return None, None, "not inside a git repository — run `git init` first"
    safe = _bounded_safe(name, 80)
    branch = f"dgc/{safe}"
    wt_path = root.parent / f"{root.name}-{safe}"
    if wt_path.exists():
        # `/worktree feature-x` a second time means "take me back to feature-x", which is what a
        # user who left it and came back expects. It used to fail with "path already exists", so
        # the only way back into a worktree you had made was to remove it and start over.
        existing = next((row for row in list_worktrees(root)
                         if Path(row["path"]).resolve(strict=False) == wt_path.resolve(strict=False)),
                        None)
        if existing is not None:
            _ATTACHED.add(str(wt_path.resolve(strict=False)))
            return wt_path, str(existing.get("branch") or branch), None
        # Something else is sitting on the path. Attaching to it would be guessing.
        return None, None, (f"path already exists and is not a worktree of this repository: "
                            f"{wt_path}")
    _ATTACHED.discard(str(wt_path.resolve(strict=False)))
    r = _git(["worktree", "add", "-b", branch, str(wt_path)], root)
    if r.returncode != 0:                       # branch may already exist → attach to it
        r2 = _git(["worktree", "add", str(wt_path), branch], root)
        if r2.returncode != 0:
            return None, None, (r.stderr or r2.stderr or "git worktree add failed").strip()
    return wt_path, branch, None


def find_worktree(path, name: str) -> dict | None:
    """Resolve the same exact branch/path/slug forms accepted by ``remove``."""
    root = repo_root(path)
    if not root:
        return None
    safe = _safe(name)
    for row in list_worktrees(path):
        wp = Path(row["path"])
        if (str(wp) == name or wp.name == name or row.get("branch") == name
                or wp.name == f"{root.name}-{safe}" or row.get("branch") == f"dgc/{safe}"):
            return row
    return None


def remove(path, name: str) -> str | None:
    """Remove a clean worktree by exact branch, name, or generated slug.

    Git's ordinary refusal is intentional: a typo in `/worktree remove` must never discard dirty
    files. Users can inspect/commit the branch and use Git directly for an explicitly destructive
    removal.
    """
    root = repo_root(path)
    if not root:
        return "not inside a git repository"
    row = find_worktree(path, name)
    if row is None:
        return f"no worktree matching '{name}'"
    target = Path(row["path"])
    r = _git(["worktree", "remove", str(target)], root)
    return None if r.returncode == 0 else (r.stderr or "git worktree remove failed").strip()


# Task worktrees are the only unbounded on-disk store DGC creates, and the largest. Every other
# subsystem prunes -- checkpoints, image views, the usage ledger, notes -- and nothing ever swept
# these: `git worktree prune` appeared nowhere in the package, and no code path had ever asked how
# much disk was left. A 16-way fan-out makes sixteen full tracked-file checkouts of the repository
# before anything notices, and `git worktree add`'s own ENOSPC arrives one checkout at a time.
_MIN_FREE_BYTES = 512 * 1024 * 1024        # a floor, not an estimate of what this repo needs


def _free_bytes(path: Path) -> int | None:
    """Free space on the filesystem holding `path`, or None when it cannot be determined."""
    probe = path
    for _ in range(4):
        try:
            return shutil.disk_usage(probe).free
        except OSError:
            if probe.parent == probe:
                return None
            probe = probe.parent
    return None


def prune_worktrees(repo: Path) -> None:
    """Drop git's records of task worktrees whose directories are already gone.

    Best-effort and silent: a prune that fails must never be the reason a delegation is refused.
    """
    _git(["worktree", "prune"], repo)


_MAX_ABSENT_DIRS = 12
_ABSENT_SCAN_TIMEOUT = 5.0
# Absent from the child by design, and of no use to it: git's own directory and DGC's state.
_ABSENT_UNINTERESTING = {".git", ".dgc"}


def ignored_dirs(root) -> list[str]:
    """Directories this repository ignores, as git itself reports them, relative to `root`.

    `--directory` collapses a wholly-ignored tree into a single entry and does not descend into it,
    which is what keeps this cheap on exactly the repositories that have the most to report.

    This is the one source of ignore truth in this module: `git check-ignore` cannot be used,
    because every git call here runs with `GIT_LITERAL_PATHSPECS=1` and that command rejects
    pathspec magic outright (`fatal: pathspec magic not supported by this command: 'literal'`).
    Best-effort: any failure reports nothing.
    """
    try:
        out = _git_bytes(
            ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory",
             "--no-empty-directory", "-z"],
            root, timeout=_ABSENT_SCAN_TIMEOUT, max_stdout=_MAX_GIT_PATH_BYTES)
    except Exception:
        return []
    if out.returncode != 0:
        return []
    names = []
    for raw in out.stdout.split(b"\0"):
        if not raw.endswith(b"/"):          # `--directory` marks directories, and only those matter
            continue
        try:
            rel = raw.decode("utf-8", "strict").rstrip("/")
        except UnicodeDecodeError:
            continue
        if not rel or rel.startswith("/") or ".." in rel.split("/"):
            continue
        names.append(rel)
    return names


def absent_ignored_dirs(main_root, child_root, *, limit: int = _MAX_ABSENT_DIRS) -> list[str]:
    """Git-ignored directories the parent checkout has and an isolated child's does not.

    `git worktree add` checks out tracked files only, so everything the project deliberately keeps
    out of Git -- `node_modules`, a `.venv`, a built `dist`, a Rust `target` -- is simply not there
    for a sub-agent. Measured against a real delegation, the child discovers this by running the
    project's own command and reading the failure (`sh: 1: jest: not found`), then recovers by
    installing into its own checkout. That recovery works, but it costs a turn and it is the one
    moment where a capable model can instead conclude the task itself is impossible. Naming the
    absent directories up front costs one line of prompt.

    Returns repo-relative directory names, shallowest first, capped at `limit`. Best-effort: every
    failure path returns an empty list, because a hint must never be the reason a delegation is
    refused or delayed.
    """
    try:
        main = Path(main_root).resolve(strict=False)
        child = Path(child_root).resolve(strict=False)
    except Exception:
        return []
    if main == child:
        return []          # a shortcut: the per-entry `exists` check below also covers this
    found: list[tuple[int, str]] = []
    for rel in ignored_dirs(main):
        if set(rel.split("/")) & _ABSENT_UNINTERESTING:
            continue
        target = main / rel
        # The worktree root itself can sit inside the project and be ignored there; reporting the
        # directory the child is standing in as missing would be nonsense.
        if _inside_dir(child, target):
            continue
        try:
            if (child / rel).exists():      # an opt-in link, or a path the child made for itself
                continue
        except OSError:
            continue
        found.append((rel.count("/"), rel))
    found.sort()
    return [rel for _, rel in found[:max(0, int(limit))]]


def _inside_dir(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


class TaskWorkspaceError(RuntimeError):
    pass


@dataclass(frozen=True)
class _FileState:
    kind: str                         # missing | file | symlink
    data: bytes = b""
    mode: int = 0


def _normal_mode(mode: int) -> int:
    return 0o755 if mode & 0o111 else 0o644


def _state_fingerprint(state: _FileState) -> dict:
    return {"kind": state.kind, "mode": int(state.mode), "bytes": len(state.data),
            "sha256": hashlib.sha256(state.data).hexdigest()}


def _fingerprint_matches(state: _FileState, value: object) -> bool:
    return (isinstance(value, dict) and value.get("kind") == state.kind
            and value.get("mode") == int(state.mode) and value.get("bytes") == len(state.data)
            and value.get("sha256") == hashlib.sha256(state.data).hexdigest())


def _merge_mode(base: int, ours: int, theirs: int) -> int | None:
    """The executable bit, three ways. None when both sides moved it in different directions."""
    if ours == theirs:
        return ours
    if ours == base:              # only the sub-agent changed it
        return theirs
    if theirs == base:            # only the parent changed it
        return ours
    return None


def _merge_file(base: _FileState, ours: _FileState, theirs: _FileState,
                cwd: Path) -> _FileState | None:
    """Reconcile one file three ways, or None when the two sides genuinely collide.

    `integrate` compares whole files: if the parent's copy differs at all from the bytes the
    sub-agent started with, the delta is refused. Editing a DIFFERENT part of the same file -- the
    parent fixing a line at the bottom while the child rewrote a function at the top -- reads
    exactly like a collision, and the child's work on every other file is discarded with it.

    `git merge-file` is the whole mechanism. It reconciles three versions of ONE file, it is handed
    literal bytes in a scratch directory rather than paths in a repository, and with `-p` it writes
    nothing. That last part carries more weight than it sounds:

      * Nothing touches the index, so no lock is taken and the user's own `git status` is
        undisturbed -- the reason this is not built on `git stash create`, which rewrites the real
        index, omits untracked files entirely, and fails outright when a lock is held.
      * Git never sees these as tracked paths, so no clean filter, no `core.autocrlf` and no LFS
        smudge runs over the content. A CRLF file merges back byte for byte and a binary asset is
        refused rather than quietly replaced by its pointer text.

    Exit status is the entire contract, and every non-zero value means the same thing to us: 1 for
    a real conflict, 255 for a file git will not merge at all, 125 when the merged text would cross
    the task byte ceiling (`_run_git` converts a truncated capture into that failure, so an
    oversized merge becomes a refusal instead of a half-written file), 124 on timeout. So the rule
    is `returncode == 0, or refuse` -- and on any refusal the caller keeps the parent's bytes and
    retains the delta for review.
    """
    # Only a real file has lines to reconcile. A symlink, a deletion on either side, or a file one
    # side created from nothing has no common ancestor text, and "merging" it would mean inventing
    # one. Those are genuine collisions and are reported as such.
    if any(state.kind != "file" for state in (base, ours, theirs)):
        return None
    mode = _merge_mode(base.mode, ours.mode, theirs.mode)
    if mode is None:
        return None
    # Git answers 255 for these anyway; deciding it here keeps the refusal explicit and cheap.
    if any(b"\0" in state.data for state in (base, ours, theirs)):
        return None
    with tempfile.TemporaryDirectory(prefix="dgc-merge-") as holder:
        names = {}
        for name, state in (("base", base), ("ours", ours), ("theirs", theirs)):
            target = Path(holder) / name
            target.write_bytes(state.data)
            names[name] = str(target)
        # Argument order is ours, base, theirs -- not the three-way order the name suggests.
        done = _git_bytes(["merge-file", "-p", "--", names["ours"], names["base"], names["theirs"]],
                          cwd, max_stdout=_MAX_TASK_BYTES)
    if done.returncode != 0:
        return None
    return _FileState("file", done.stdout, mode)


def _read_state(path: Path, *, max_bytes: int = _MAX_TASK_BYTES) -> _FileState:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return _FileState("missing")
    if stat.S_ISLNK(info.st_mode):
        return _FileState("symlink", os.fsencode(os.readlink(path)), 0o777)
    if not stat.S_ISREG(info.st_mode):
        raise TaskWorkspaceError(f"unsupported non-file path: {path}")
    if info.st_size > max_bytes:
        raise TaskWorkspaceError(f"file exceeds isolated-task limit ({max_bytes} bytes): {path}")
    return _FileState("file", path.read_bytes(), _normal_mode(stat.S_IMODE(info.st_mode)))


def _replace_state(path: Path, state: _FileState) -> None:
    """Apply a captured file/symlink state without following an existing symlink."""
    try:
        current = path.lstat()
    except FileNotFoundError:
        current = None
    if current is not None and stat.S_ISDIR(current.st_mode):
        raise TaskWorkspaceError(f"refusing to replace directory: {path}")
    if state.kind == "missing":
        if current is not None:
            path.unlink()
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if state.kind == "symlink":
        fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        os.close(fd)
        Path(tmp).unlink()
        try:
            os.symlink(os.fsdecode(state.data), tmp)
            os.replace(tmp, path)
        finally:
            try:
                Path(tmp).unlink()
            except FileNotFoundError:
                pass
        return
    if state.kind != "file":
        raise TaskWorkspaceError(f"unsupported state for {path}: {state.kind}")
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".dgc-task", dir=str(path.parent))
    try:
        try:
            os.fchmod(fd, _normal_mode(state.mode))
        except (AttributeError, OSError):
            pass
        with os.fdopen(fd, "wb") as handle:
            handle.write(state.data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        try:
            Path(tmp).unlink()
        except FileNotFoundError:
            pass


def _nul_paths(result: subprocess.CompletedProcess) -> list[str]:
    if result.returncode != 0:
        raw = result.stderr.decode(errors="replace") if isinstance(result.stderr, bytes) else result.stderr
        raise TaskWorkspaceError((raw or "git path query failed").strip())
    raw = result.stdout if isinstance(result.stdout, bytes) else result.stdout.encode()
    paths = []
    for value in raw.split(b"\0"):
        if not value:
            continue
        path = os.fsdecode(value)
        parsed = Path(path)
        if parsed.is_absolute() or ".." in parsed.parts or path in ("", ".git"):
            raise TaskWorkspaceError(f"unsafe repository path: {path!r}")
        paths.append(path)
        if len(paths) > _MAX_TASK_FILES:
            raise TaskWorkspaceError(f"git path query exceeded {_MAX_TASK_FILES} entries")
    return paths


def _validate_repo_path(path: object) -> str:
    value = str(path)
    parsed = Path(value)
    if (not value or value == ".git" or parsed.is_absolute() or ".." in parsed.parts
            or "\x00" in value):
        raise TaskWorkspaceError(f"unsafe repository path: {value!r}")
    return value


def _inside_project(repo_path: str, project_rel: Path) -> bool:
    if project_rel == Path("."):
        return True
    try:
        Path(repo_path).relative_to(project_rel)
        return True
    except ValueError:
        return False


def _checked_target(root: Path, repo_path: str) -> Path:
    """Resolve parent components while deliberately not following the final path symlink."""
    resolved_root = root.resolve(strict=False)
    target = root / repo_path
    parent = target.parent.resolve(strict=False)
    try:
        if os.path.commonpath((str(resolved_root), str(parent))) != str(resolved_root):
            raise TaskWorkspaceError(f"repository path escapes through a symlink: {repo_path}")
    except ValueError as exc:
        raise TaskWorkspaceError(f"repository path is outside the checkout: {repo_path}") from exc
    return target


# Interpreter and test-runner caches are never a child's work, and parallel children that each
# run the tests write the same ones. In a repository that doesn't ignore them, counting them made
# the second child's real changes a conflict, and its work was not integrated.
_CACHE_DIRS = frozenset({"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis"})


def _is_cache(path: str) -> bool:
    parts = path.split("/")
    return any(part in _CACHE_DIRS for part in parts[:-1]) or path.endswith((".pyc", ".pyo"))


def _gitlink_paths(repo: Path, project_rel: Path) -> set[str]:
    """Submodule paths, by index mode. `git ls-files --stage` writes mode 160000 for a gitlink."""
    pathspec = str(project_rel) if project_rel != Path(".") else "."
    rows = _git_bytes(["ls-files", "--stage", "-z", "--", pathspec], repo)
    if rows.returncode != 0:
        return set()
    found = set()
    for record in (rows.stdout or b"").split(b"\0"):
        if not record:
            continue
        meta, _, name = record.partition(b"\t")
        if meta.split(b" ", 1)[0] == b"160000" and name:
            found.add(os.fsdecode(name))
    return found


def _dirty_paths(repo: Path, base_commit: str, project_rel: Path) -> set[str]:
    pathspec = str(project_rel) if project_rel != Path(".") else "."
    tracked = _nul_paths(_git_bytes(
        ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--no-renames",
         base_commit, "--", pathspec], repo))
    # A submodule whose HEAD differs from the recorded gitlink is reported here by name, and it is a
    # DIRECTORY on disk. `prepare` then calls `_read_state` on it, which raises "unsupported
    # non-file path", and `prepare` returning None refuses EVERY `task` call in the repository --
    # so one moved submodule silently disabled delegation entirely, with the user told only
    # "unsupported non-file path: <dir>". Skip gitlinks here; `_head_state` still refuses one that
    # reaches integration, which is the backstop its message already claims to be.
    gitlinks = _gitlink_paths(repo, project_rel)
    if gitlinks:
        tracked = [path for path in tracked if path not in gitlinks]
    untracked = [path for path in _nul_paths(_git_bytes(
        ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec], repo))
        if not _is_cache(path)]
    return {path for path in (*tracked, *untracked) if _inside_project(path, project_rel)}


def _skip_worktree_paths(repo: Path, project_rel: Path) -> set[str]:
    """Paths the parent has marked skip-worktree, which `git ls-files -v` tags `S`.

    A new linked worktree is dense for these even when the parent's copy is absent from disk, so the
    child sees a file the parent does not have. At integration `prior` is then `missing` while
    `expected` is the blob, `_merge_file` refuses on the kind mismatch, and a delta consisting only
    of such a path is refused with "parent checkout changed while the isolated task was running" --
    which is false; the parent changed nothing. `/tasks apply` reproduces it forever.

    (Cone-mode sparse-checkout does NOT do this: a new worktree inherits the parent's sparsity.
    Measured -- only skip-worktree diverges, which is why this reads the flag rather than the
    sparse-checkout config. dgc/git_review.py already parses the same tag.)
    """
    pathspec = str(project_rel) if project_rel != Path(".") else "."
    rows = _git(["ls-files", "-v", "-z", "--", pathspec], repo)
    if rows.returncode != 0:
        return set()
    found = set()
    for record in (rows.stdout or "").split("\0"):
        if len(record) > 2 and record[0] == "S" and record[1] == " ":
            found.add(record[2:])
    return found


def _head_state(repo: Path, base_commit: str, repo_path: str) -> _FileState:
    row = _git_bytes(["ls-tree", "-z", base_commit, "--", repo_path], repo)
    if row.returncode != 0:
        raise TaskWorkspaceError("could not inspect task baseline")
    record = (row.stdout or b"").split(b"\0", 1)[0]
    if not record:
        return _FileState("missing")
    try:
        meta, _name = record.split(b"\t", 1)
        mode, kind, oid = meta.split(b" ", 2)
    except ValueError as exc:
        raise TaskWorkspaceError(f"invalid git tree record for {repo_path}") from exc
    if kind != b"blob":
        raise TaskWorkspaceError(f"submodules are not supported in isolated task integration: {repo_path}")
    # What a CHECKOUT of that blob holds, not the blob. These differ whenever the repository
    # configures a conversion -- `core.autocrlf`, a `.gitattributes` `eol=` rule, or a clean/smudge
    # filter (Git LFS's exact shape) -- and this value is compared against bytes read off disk. Ask
    # for the blob itself and they never match, so EVERY delta touching such a file was refused and
    # the refusal was blamed on the parent ("parent checkout changed while the isolated task was
    # running"). Measured on Linux with no user config: an `eol=crlf` attribute and an LFS-shaped
    # filter both refuse; a plain repository applies.
    #
    # `--filters` runs the repository's smudge filter, and that is not a new capability: DGC
    # already runs it for every delegation, because `git worktree add` materialises the child's
    # checkout through the same filters. Measured -- a child's copy holds the smudged bytes.
    #
    # Symlinks are exempt. Git does not convert them, and `--filters` on a symlink blob would ask a
    # text filter to rewrite a link target.
    if mode == b"120000":
        blob = _git_bytes(["cat-file", "blob", oid.decode("ascii")], repo,
                          max_stdout=_MAX_TASK_BYTES + 1)
    else:
        blob = _git_bytes(["cat-file", "--filters", "--path", repo_path, oid.decode("ascii")], repo,
                          max_stdout=_MAX_TASK_BYTES + 1)
        if blob.returncode != 0:
            # An older git, or a filter that refuses: fall back to the raw blob rather than fail
            # the integration outright. That restores the previous behaviour for this file only.
            blob = _git_bytes(["cat-file", "blob", oid.decode("ascii")], repo,
                              max_stdout=_MAX_TASK_BYTES + 1)
    if blob.returncode != 0:
        raise TaskWorkspaceError(f"could not read task baseline blob: {repo_path}")
    data = bytes(blob.stdout or b"")
    if len(data) > _MAX_TASK_BYTES:
        raise TaskWorkspaceError(f"baseline file exceeds isolated-task limit: {repo_path}")
    if mode == b"120000":
        return _FileState("symlink", data, 0o777)
    return _FileState("file", data, 0o755 if mode == b"100755" else 0o644)


@dataclass
class TaskIntegration:
    status: str                       # applied | clean | conflict | dropped | error
    paths: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    error: str = ""
    cleanup_error: str = ""
    # Paths where the sub-agent's bytes were reconciled with a change the parent made DURING the
    # run, rather than written over an untouched file. The user is editing those files right now,
    # so a silent "integrated" is the wrong thing to say about them.
    #
    # LAST, deliberately. Several call sites build this positionally --
    # `TaskIntegration("conflict", display, conflicts, detail)` -- so a field inserted before
    # `error` silently swallows the message that explains a refusal. That is what happened when it
    # was added in the middle, and TheSafetyInvariantTest caught it.
    merged: list[str] = field(default_factory=list)


@dataclass
class TaskWorkspace:
    source_root: Path
    repo: Path
    project_rel: Path
    path: Path
    project_root: Path
    branch: str
    base_commit: str
    initial_dirty: set[str]
    baseline: dict[str, _FileState]
    metadata_path: Path
    # The opt-in escape hatch (`subagent_link_paths`). LAST and defaulted, because every existing
    # construction of this class is positional.
    linked: list[str] = field(default_factory=list)
    link_errors: list[str] = field(default_factory=list)

    @classmethod
    def prepare(cls, source_root: Path, name: str, storage_root: Path | None = None,
                link_paths=()) -> tuple["TaskWorkspace | None", str | None]:
        source_root = Path(source_root).resolve(strict=False)
        repo = repo_root(source_root)
        if repo is None:
            return None, "project is not inside a git repository"
        try:
            project_rel = source_root.relative_to(repo)
        except ValueError:
            return None, "project root is outside its git checkout"
        base = _git(["rev-parse", "HEAD"], repo)
        if base.returncode != 0 or not base.stdout.strip():
            return None, "repository has no committed HEAD"
        refusal = _case_alias_refusal(source_root)
        if refusal:
            return None, refusal
        base_commit = base.stdout.strip()
        token = uuid.uuid4().hex[:10]
        slug = _bounded_safe(name, 40)
        branch = f"dgc/task-{slug}-{token}"
        if storage_root is None:
            from .config import USER_HOME
            storage_root = USER_HOME / "worktrees"
        try:
            storage_root = Path(storage_root).expanduser().resolve(strict=False)
            if os.path.commonpath((str(repo), str(storage_root))) == str(repo):
                return None, "isolated task storage must be outside the source repository"
        except ValueError:
            pass
        except (OSError, RuntimeError) as exc:
            return None, f"could not resolve isolated task storage: {exc}"
        try:
            storage_root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return None, f"could not create isolated task storage: {exc}"
        try:
            storage_root.chmod(0o700)
        except OSError:
            pass
        path = storage_root / f"{_safe(repo.name)[:60]}-task-{slug}-{token}"
        metadata_path = storage_root / f"{path.name}.json"
        # Reclaim records for worktrees whose directories are already gone, so a long-lived
        # checkout does not accumulate them forever, and so the space check below sees the truth.
        prune_worktrees(repo)
        free = _free_bytes(storage_root)
        if free is not None and free < _MIN_FREE_BYTES:
            return None, (
                f"only {free // (1024 * 1024)} MB free where isolated task checkouts are created "
                f"({storage_root}); a delegation copies the repository's tracked files there. Free "
                f"some space, or remove finished task worktrees with `/worktree` — a partial "
                f"checkout would fail mid-task instead of before it starts.")
        add = _git(["worktree", "add", "--quiet", "-b", branch, str(path), base_commit], repo)
        if add.returncode != 0:
            return None, (add.stderr or "could not create isolated task worktree").strip()
        task = cls(source_root, repo, project_rel, path, path / project_rel, branch, base_commit,
                   set(), {}, metadata_path)
        try:
            task.initial_dirty = _dirty_paths(repo, base_commit, project_rel)
            if len(task.initial_dirty) > _MAX_TASK_FILES:
                raise TaskWorkspaceError(f"dirty baseline exceeds {_MAX_TASK_FILES} files")
            total = 0
            for repo_path in sorted(task.initial_dirty):
                state = _read_state(_checked_target(repo, repo_path))
                total += len(state.data)
                if total > _MAX_TASK_BYTES:
                    raise TaskWorkspaceError(f"dirty baseline exceeds {_MAX_TASK_BYTES} bytes")
                task.baseline[repo_path] = state
                _replace_state(_checked_target(path, repo_path), state)
            # DGC's checkout lease excludes peer DGC writers; this second read also detects a
            # manual editor change racing the baseline copy.
            if _dirty_paths(repo, base_commit, project_rel) != task.initial_dirty:
                raise TaskWorkspaceError("source file set changed while creating the isolated baseline")
            for repo_path, expected in task.baseline.items():
                if _read_state(_checked_target(repo, repo_path)) != expected:
                    raise TaskWorkspaceError(f"source changed while isolating: {repo_path}")
            # LAST: after the baseline is copied and verified, so a link can never be mistaken for
            # source state that changed mid-isolation.
            task._link_shared(link_paths)
            return task, None
        except Exception as exc:
            cleanup_error = task.cleanup()
            detail = str(exc)
            if cleanup_error:
                detail += (f"; cleanup failed for {task.path} on branch {task.branch}: "
                           f"{cleanup_error}")
            return None, detail

    def _link_shared(self, link_paths) -> None:
        """Share a few parent directories into this checkout, by explicit user opt-in only.

        A worktree holds tracked files only, so a delegated child re-installs a project's
        dependencies in its own checkout. Measured on a real Node delegation that is one
        `npm install` -- the child recovered by itself and the parent's `node_modules` was provably
        untouched -- so isolation stays the default. This hatch exists for the project where that
        install is expensive enough that the user would rather share the tree and accept that the
        child's writes land in the parent's copy.

        Every path is refused unless it is relative, inside this checkout, present in the parent,
        absent here, and ignored by this repository's own rules -- the last gate is what keeps a
        link out of the integration delta, because `changed_paths()` reads git's view of the
        worktree and would otherwise offer to write a symlink into the user's project. It also
        settles trackedness for free: a tracked path is never in git's ignore listing. A refusal is
        recorded, never raised: the hatch is a convenience and must not fail a delegation.
        """
        requested = list(link_paths or ())[:32]
        if not requested:
            return
        ignored = set(ignored_dirs(self.source_root))
        for raw in requested:
            # Trailing separators only. Stripping a LEADING one would silently reinterpret an
            # absolute path as a relative one instead of telling the user their entry is wrong.
            rel = str(raw or "").strip().replace("\\", "/").rstrip("/")
            if not rel:
                continue
            if len(self.linked) + len(self.link_errors) >= 32:
                break
            try:
                parts = PurePosixPath(rel).parts
                if not parts or ".." in parts or PurePosixPath(rel).is_absolute():
                    raise TaskWorkspaceError("must be a relative path inside the project")
                source = self.source_root / rel
                dest = self.project_root / rel
                # Containment FIRST, before anything follows this path. A checked-out symlink in
                # the middle of `rel` makes the two lexist checks below answer about a directory
                # somewhere else entirely, so asking them first would decide the case on the wrong
                # file -- and, with no `..` to catch, the traversal check above sees nothing wrong.
                if not _inside_dir(dest.resolve(strict=False).parent,
                                   self.project_root.resolve(strict=False)):
                    raise TaskWorkspaceError("resolves outside the isolated checkout")
                if not os.path.lexists(source):
                    raise TaskWorkspaceError("not present in the project")
                if os.path.lexists(dest):
                    raise TaskWorkspaceError("already present in the isolated checkout")
                # `rel` itself, or an ancestor git collapsed into one ignored entry.
                ancestors = {"/".join(parts[:i]) for i in range(1, len(parts) + 1)}
                if not (ancestors & ignored):
                    raise TaskWorkspaceError(
                        "not ignored by this repository, so sharing it would put a symlink in the "
                        "integrated result")
                dest.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(source, dest, target_is_directory=source.is_dir())
            except (TaskWorkspaceError, OSError, ValueError) as exc:
                self.link_errors.append(f"{rel}: {exc}")
            else:
                self.linked.append(rel)

    def _expected(self, repo_path: str) -> _FileState:
        return self.baseline.get(repo_path) or _head_state(self.repo, self.base_commit, repo_path)

    def changed_paths(self) -> list[str]:
        candidates = self.initial_dirty | _dirty_paths(self.path, self.base_commit, self.project_rel)
        changed = []
        total = 0
        for repo_path in sorted(candidates):
            actual = _read_state(_checked_target(self.path, repo_path))
            expected = self._expected(repo_path)
            if actual != expected:
                total += len(actual.data)
                if len(changed) >= _MAX_TASK_FILES or total > _MAX_TASK_BYTES:
                    raise TaskWorkspaceError("isolated task delta exceeds integration limits")
                changed.append(repo_path)
        return changed

    def _display_path(self, repo_path: str) -> str:
        return str(Path(repo_path).relative_to(self.project_rel)) if self.project_rel != Path(".") else repo_path

    def retain(self, reason: str, paths: list[str]) -> str | None:
        payload = {
            "kind": "dgc-isolated-task", "schema_version": _RETAINED_SCHEMA,
            "source": str(self.source_root), "worktree": str(self.path),
            "branch": self.branch, "base_commit": self.base_commit,
            "project_rel": str(self.project_rel), "repo_changed_paths": list(paths),
            "reason": str(reason)[:2000], "changed_paths": [self._display_path(p) for p in paths],
            "protected_baseline": {path: _state_fingerprint(state)
                                   for path, state in self.baseline.items()},
        }
        return _write_retained_metadata(self.metadata_path, payload)

    def integrate(self, checkpoints=None) -> TaskIntegration:
        try:
            changed = self.changed_paths()
        except Exception as exc:
            metadata_error = self.retain(str(exc), [])
            detail = str(exc) + (f"; {metadata_error}" if metadata_error else "")
            return TaskIntegration("error", error=detail)
        display = [self._display_path(path) for path in changed]
        if not changed:
            cleanup_error = self.cleanup() or ""
            return TaskIntegration("clean", cleanup_error=cleanup_error)
        protected = [path for path in changed if path in self.initial_dirty]
        if protected:
            conflicts = [self._display_path(path) for path in protected]
            reason = "sub-agent changed files that were already dirty before delegation"
            metadata_error = self.retain(reason, changed)
            detail = reason + (f"; {metadata_error}" if metadata_error else "")
            return TaskIntegration("conflict", display, conflicts, detail)

        skipped = _skip_worktree_paths(self.repo, self.project_rel)
        expected: dict[str, _FileState] = {}
        desired: dict[str, _FileState] = {}
        child: dict[str, _FileState] = {}
        prior: dict[str, _FileState] = {}
        merged: list[str] = []
        conflicts = []
        try:
            for repo_path in changed:
                expected[repo_path] = self._expected(repo_path)
                child[repo_path] = _read_state(_checked_target(self.path, repo_path))
                desired[repo_path] = child[repo_path]
                prior[repo_path] = _read_state(_checked_target(self.repo, repo_path))
                if prior[repo_path] == expected[repo_path]:
                    continue        # the parent has not touched it; the child's bytes stand
                if repo_path in skipped:
                    # The parent asked git to ignore its copy of this path. Its absence on disk is
                    # not a change the user made, and reporting it as one produced a refusal that
                    # blamed them for something they had not done.
                    conflicts.append(repo_path)
                    continue
                # The parent's copy moved while the task ran. That is a collision only if the two
                # sides touched the same lines. Reconcile them, and keep the child's work on this
                # file -- and on every other file in the delta -- when they did not.
                #
                # Nothing dirty before delegation reaches here: `protected` is checked above and
                # returns first, so a file the user already had uncommitted work in is still
                # refused outright rather than merged into. That ordering is the whole safety
                # argument, and tests/test_task_merge.py holds it.
                union = _merge_file(expected[repo_path], prior[repo_path], child[repo_path],
                                    self.repo)
                if union is None:
                    conflicts.append(repo_path)
                else:
                    desired[repo_path] = union
                    merged.append(repo_path)
        except Exception as exc:
            metadata_error = self.retain(str(exc), changed)
            detail = str(exc) + (f"; {metadata_error}" if metadata_error else "")
            return TaskIntegration("error", display, error=detail)
        # One collision used to discard the child's work on every OTHER file in the delta. That is
        # safe and very expensive: a sub-agent that edited ten files and overlapped on one lost all
        # ten, and the only way back was to resolve the retained task by hand. Apply the files that
        # DO reconcile and hold back only the ones that do not -- the shape Grok Build's
        # `apply_worktree` uses (xai-org/grok-build, xai-grok-workspace-types/src/rpc/worktree.rs:
        # `ApplyWorktreeResponse::Conflicts { files, conflicts: Vec<FileConflict> }`, each conflict
        # carrying path + base/ours/theirs), verified against that source rather than a summary of it.
        # The original comment below predates that check.
        # `apply_worktree` uses, where a conflict is reported per path.
        #
        # The cost of this, stated plainly: a change that spans two files can now half-land. It is
        # accepted because the alternative discards correct work on every delegation that touches a
        # file the user happened to edit, because the held-back files are named in the result and
        # kept in the worktree for review, and because `/rewind` undoes the whole turn again (it
        # could not, until the `note_written` fix in this same release).
        #
        # Nothing conflicting is applied, and a delta where EVERY path conflicts still refuses
        # wholesale, exactly as before.
        appliable = [path for path in changed if path not in conflicts]
        if conflicts and not appliable:
            shown = [self._display_path(path) for path in conflicts]
            reason = "parent checkout changed while the isolated task was running"
            metadata_error = self.retain(reason, changed)
            detail = reason + (f"; {metadata_error}" if metadata_error else "")
            return TaskIntegration("conflict", display, shown, detail)

        # A multi-file delta is not atomic. Each file lands atomically (_replace_state, :432) but the
        # loop below is not, the except-rollback cannot run if the process is gone, and until now
        # nothing on disk said an integration was in flight. Leave a breadcrumb first, so a torn
        # apply is visible to `/tasks` instead of silent. Evidence, not a resume: re-applying it is
        # refused, because the files already written no longer match the recorded baseline.
        self.retain("integration in progress; DGC stopped while applying this delta", changed)
        applied: list[str] = []
        try:
            for repo_path in appliable:
                target = _checked_target(self.repo, repo_path)
                if _read_state(target) != prior[repo_path]:
                    raise TaskWorkspaceError(f"parent changed during integration: {repo_path}")
                if checkpoints is not None and not checkpoints.record_file(str(target)):
                    raise TaskWorkspaceError(f"could not capture rewind checkpoint: {repo_path}")
                if _read_state(target) != prior[repo_path]:
                    raise TaskWorkspaceError(f"parent changed during checkpoint capture: {repo_path}")
                # Against the CHILD's own bytes: `desired` may be a merge of those bytes with the
                # parent's, and comparing the checkout to the merged result would fail every time.
                if _read_state(_checked_target(self.path, repo_path)) != child[repo_path]:
                    raise TaskWorkspaceError(f"isolated checkout changed during integration: {repo_path}")
                _replace_state(target, desired[repo_path])
                # Tell the manager what DGC just left here. `record_file` above captured the BEFORE
                # bytes; without this second half `_left` still holds whatever DGC wrote in an
                # earlier turn, so the next rewind finds a file it cannot account for, refuses the
                # WHOLE turn, and tells the user "changed outside this chat" about a file DGC's own
                # sub-agent wrote. `getattr` because the suites pass duck-typed checkpoint stubs
                # that define only `record_file`; a bare call would turn those into an integration
                # error. Same shape as the edit-tool path in agent.py.
                note = getattr(checkpoints, "note_written", None)
                if callable(note):
                    note(str(target))
                applied.append(repo_path)
        except Exception as exc:
            rollback_errors = []
            for repo_path in reversed(applied):
                try:
                    _replace_state(_checked_target(self.repo, repo_path), prior[repo_path])
                except Exception as rollback_exc:
                    rollback_errors.append(f"{repo_path}: {rollback_exc}")
            detail = f"integration failed: {exc}"
            if rollback_errors:
                detail += "; rollback incomplete: " + ", ".join(rollback_errors[:8])
            metadata_error = self.retain(detail, changed)
            if metadata_error:
                detail += f"; {metadata_error}"
            return TaskIntegration("error", display, error=detail)
        landed = [self._display_path(path) for path in applied]
        reconciled = [self._display_path(path) for path in merged if path in applied]
        if conflicts:
            # Part of the delta is still in the worktree. Keep it, and record ONLY what is left to
            # resolve so a retry does not try to re-apply what already landed.
            held = [self._display_path(path) for path in conflicts]
            reason = ("parent checkout changed while the isolated task was running; "
                      f"{len(applied)} path(s) still applied")
            metadata_error = self.retain(reason, conflicts)
            detail = reason + (f"; {metadata_error}" if metadata_error else "")
            return TaskIntegration("partial", landed, held, detail, merged=reconciled)
        # The delta landed: drop the in-flight breadcrumb BEFORE cleanup, so a worktree that cannot
        # be removed does not leave a retained row for work that is already applied (_cleanup_task
        # keeps the metadata on partial failure, by design).
        try:
            self.metadata_path.unlink()
        except OSError:
            pass
        cleanup_error = self.cleanup() or ""
        return TaskIntegration("applied", display, merged=reconciled,
                               cleanup_error=cleanup_error)

    def cleanup(self) -> str | None:
        return _cleanup_task(self.repo, self.path, self.branch, self.metadata_path)


@dataclass
class FleetWorkspaceResult:
    status: str                       # cleaned | retained | error
    path: Path
    branch: str
    changed_paths: list[str] = field(default_factory=list)
    error: str = ""


def _fleet_storage_root(storage_root: Path | None) -> Path:
    if storage_root is None:
        from .config import USER_HOME
        storage_root = USER_HOME / "fleet-worktrees"
    return Path(storage_root).expanduser().resolve(strict=False)


@dataclass
class FleetWorkspace:
    """Long-lived isolated checkout owned by one TUI fleet conversation.

    Unlike a delegated task, a fleet agent is interactive and may commit or keep working across DGC
    launches, so its delta is never merged or discarded automatically. Closing removes the checkout
    only when its complete repository state still matches the exact baseline DGC copied at creation;
    otherwise the path/branch and owner-private metadata are retained for recovery.
    """
    source_root: Path
    repo: Path
    project_rel: Path
    path: Path
    project_root: Path
    branch: str
    base_commit: str
    baseline: dict[str, dict]
    metadata_path: Path
    payload: dict = field(default_factory=dict, repr=False)

    @classmethod
    def prepare(cls, source_root: Path, name: str, storage_root: Path | None = None
                ) -> tuple["FleetWorkspace | None", str | None]:
        """Snapshot a source project into a private fleet worktree.

        The caller must hold the source checkout's mutation lease. This method copies tracked and
        non-ignored untracked project state and verifies it a second time before returning.
        """
        source_root = Path(source_root).resolve(strict=False)
        repo = repo_root(source_root)
        if repo is None:
            return None, "project is not inside a git repository"
        try:
            project_rel = source_root.relative_to(repo)
        except ValueError:
            return None, "project root is outside its git checkout"
        base = _git(["rev-parse", "HEAD"], repo)
        if base.returncode != 0 or not base.stdout.strip():
            return None, "repository has no committed HEAD"
        refusal = _case_alias_refusal(source_root)
        if refusal:
            return None, refusal
        base_commit = base.stdout.strip()
        token = uuid.uuid4().hex[:10]
        slug = _bounded_safe(name, 40)
        branch = f"dgc/fleet-{slug}-{token}"
        try:
            storage = _fleet_storage_root(storage_root)
            if os.path.commonpath((str(repo), str(storage))) == str(repo):
                return None, "fleet worktree storage must be outside the source repository"
        except ValueError:
            storage = _fleet_storage_root(storage_root)
        except (OSError, RuntimeError) as exc:
            return None, f"could not resolve fleet worktree storage: {exc}"
        try:
            storage.mkdir(parents=True, exist_ok=True)
            if os.name == "posix":
                storage.chmod(0o700)
        except OSError as exc:
            return None, f"could not create fleet worktree storage: {exc}"
        ident = f"{_safe(repo.name)[:60]}-fleet-{slug}-{token}"
        path = storage / ident
        metadata_path = storage / f"{ident}.json"
        add = _git(["worktree", "add", "--quiet", "-b", branch, str(path), base_commit], repo)
        if add.returncode != 0:
            return None, (add.stderr or "could not create fleet worktree").strip()
        workspace = cls(source_root, repo, project_rel, path, path / project_rel, branch,
                        base_commit, {}, metadata_path)
        try:
            dirty = _dirty_paths(repo, base_commit, project_rel)
            if len(dirty) > _MAX_TASK_FILES:
                raise TaskWorkspaceError(f"dirty baseline exceeds {_MAX_TASK_FILES} files")
            total = 0
            captured: dict[str, _FileState] = {}
            for repo_path in sorted(dirty):
                state = _read_state(_checked_target(repo, repo_path))
                total += len(state.data)
                if total > _MAX_TASK_BYTES:
                    raise TaskWorkspaceError(f"dirty baseline exceeds {_MAX_TASK_BYTES} bytes")
                captured[repo_path] = state
                workspace.baseline[repo_path] = _state_fingerprint(state)
                _replace_state(_checked_target(path, repo_path), state)
            if _dirty_paths(repo, base_commit, project_rel) != dirty:
                raise TaskWorkspaceError("source file set changed while creating the fleet baseline")
            for repo_path, expected in captured.items():
                if _read_state(_checked_target(repo, repo_path)) != expected:
                    raise TaskWorkspaceError(f"source changed while isolating: {repo_path}")
            workspace.payload = {
                "kind": "dgc-fleet-workspace", "schema_version": _FLEET_SCHEMA,
                "source": str(source_root), "repo": str(repo), "project_rel": str(project_rel),
                "worktree": str(path), "branch": branch, "base_commit": base_commit,
                "baseline": workspace.baseline, "status": "active", "reason": "",
                "changed_paths": [],
            }
            error = _write_retained_metadata(metadata_path, workspace.payload)
            if error:
                raise TaskWorkspaceError(error)
            return workspace, None
        except Exception as exc:
            cleanup_error = workspace.cleanup()
            detail = str(exc)
            if cleanup_error:
                detail += f"; cleanup failed for {path} on branch {branch}: {cleanup_error}"
            return None, detail

    @classmethod
    def attach(cls, source_root: Path, association: dict, storage_root: Path | None = None
               ) -> tuple["FleetWorkspace | None", str | None]:
        """Reattach a saved conversation only after validating its private metadata and Git row."""
        try:
            source_root = Path(source_root).resolve(strict=False)
            path = Path(str(association.get("worktree", ""))).resolve(strict=False)
            metadata_value = association.get("metadata")
            if not metadata_value:
                metadata_value = str(_fleet_storage_root(storage_root) / f"{path.name}.json")
            metadata_path = Path(str(metadata_value)).resolve(strict=False)
            storage = metadata_path.parent
            if (path.parent != storage or metadata_path.parent != storage
                    or metadata_path.name != f"{path.name}.json" or metadata_path.is_symlink()):
                raise TaskWorkspaceError("fleet association is outside its private storage root")
            if os.name == "posix":
                info = storage.stat()
                if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
                    raise TaskWorkspaceError("fleet workspace storage is not owner-private")
            payload = _read_retained_metadata(metadata_path)
            if payload.get("kind") != "dgc-fleet-workspace" or payload.get("schema_version") != _FLEET_SCHEMA:
                raise TaskWorkspaceError("invalid fleet workspace metadata")
            if Path(str(payload.get("source", ""))).resolve(strict=False) != source_root:
                raise TaskWorkspaceError("fleet workspace belongs to another source project")
            repo = repo_root(source_root)
            if repo is None or Path(str(payload.get("repo", ""))).resolve(strict=False) != repo:
                raise TaskWorkspaceError("fleet workspace repository no longer matches")
            try:
                if os.path.commonpath((str(repo), str(storage))) == str(repo):
                    raise TaskWorkspaceError("fleet workspace storage is inside the source repository")
            except ValueError:
                pass
            project_rel = source_root.relative_to(repo)
            if str(payload.get("project_rel", ".")) != str(project_rel):
                raise TaskWorkspaceError("fleet workspace project root no longer matches")
            branch = str(payload.get("branch", ""))
            if (not re.fullmatch(r"dgc/fleet-[A-Za-z0-9._-]{1,96}-[0-9a-f]{10}", branch)
                    or branch != str(association.get("branch", branch))):
                raise TaskWorkspaceError("invalid fleet workspace branch")
            if Path(str(payload.get("worktree", ""))).resolve(strict=False) != path:
                raise TaskWorkspaceError("fleet metadata path does not match its association")
            base_commit = str(payload.get("base_commit", ""))
            if not re.fullmatch(r"[0-9a-fA-F]{40,64}", base_commit):
                raise TaskWorkspaceError("invalid fleet workspace base commit")
            raw_baseline = payload.get("baseline", {})
            if not isinstance(raw_baseline, dict) or len(raw_baseline) > _MAX_TASK_FILES:
                raise TaskWorkspaceError("invalid fleet baseline")
            baseline = {}
            for raw, fingerprint in raw_baseline.items():
                repo_path = _validate_repo_path(raw)
                if not _inside_project(repo_path, project_rel):
                    raise TaskWorkspaceError(f"fleet baseline path is outside the project: {repo_path}")
                if not (isinstance(fingerprint, dict)
                        and fingerprint.get("kind") in ("missing", "file", "symlink")
                        and fingerprint.get("mode") in (0, 0o644, 0o755, 0o777)
                        and isinstance(fingerprint.get("bytes"), int)
                        and 0 <= fingerprint["bytes"] <= _MAX_TASK_BYTES
                        and re.fullmatch(r"[0-9a-f]{64}", str(fingerprint.get("sha256", "")))):
                    raise TaskWorkspaceError(f"invalid fleet baseline fingerprint: {repo_path}")
                baseline[repo_path] = fingerprint
            registered = next((item for item in list_worktrees(repo)
                               if Path(item.get("path", "")).resolve(strict=False) == path), None)
            if not path.is_dir() or not registered or registered.get("branch") != branch:
                raise TaskWorkspaceError("fleet worktree or branch is missing/stale")
            return cls(source_root, repo, project_rel, path, path / project_rel, branch,
                       base_commit, baseline, metadata_path, payload), None
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError, TaskWorkspaceError) as exc:
            return None, str(exc)

    def _display_path(self, repo_path: str) -> str:
        try:
            return str(Path(repo_path).relative_to(self.project_rel)) if self.project_rel != Path(".") else repo_path
        except ValueError:
            return f"repo:{repo_path}"

    def changed_paths(self) -> list[str]:
        """Return every repository path changed from this fleet checkout's exact birth state."""
        candidates = set(self.baseline) | _dirty_paths(self.path, self.base_commit, Path("."))
        if len(candidates) > _MAX_TASK_FILES:
            raise TaskWorkspaceError(f"fleet delta exceeds {_MAX_TASK_FILES} files")
        changed, total = [], 0
        for repo_path in sorted(candidates):
            actual = _read_state(_checked_target(self.path, repo_path))
            if repo_path in self.baseline:
                same = _fingerprint_matches(actual, self.baseline[repo_path])
            else:
                same = actual == _head_state(self.repo, self.base_commit, repo_path)
            if not same:
                total += len(actual.data)
                if total > _MAX_TASK_BYTES:
                    raise TaskWorkspaceError("fleet delta exceeds its byte limit")
                changed.append(repo_path)
        return changed

    def retain(self, reason: str, changed: list[str] | None = None) -> str | None:
        changed = list(changed or [])[:_MAX_TASK_FILES]
        head = _git(["rev-parse", "HEAD"], self.path)
        self.payload.update({
            "status": "retained", "reason": str(reason)[:2000],
            "changed_paths": [self._display_path(path) for path in changed],
            "current_head": head.stdout.strip() if head.returncode == 0 else "",
        })
        return _write_retained_metadata(self.metadata_path, self.payload)

    def finish(self, reason: str = "fleet session closed") -> FleetWorkspaceResult:
        """Clean an untouched checkout, or retain any uncertain/material state without data loss."""
        from .scheduler import workspace_mutation_lock
        lease = workspace_mutation_lock(self.project_root)
        if not lease.acquire(timeout=_RETAINED_LEASE_WAIT_S):
            detail = lease.last_error or "fleet checkout is still in use"
            metadata_error = self.retain(f"{reason}: {detail}", [])
            error = metadata_error or ""
            return FleetWorkspaceResult("error" if error else "retained", self.path, self.branch,
                                        error=error)
        try:
            changed = self.changed_paths()
            head = _git(["rev-parse", "HEAD"], self.path)
            if head.returncode != 0 or not head.stdout.strip():
                raise TaskWorkspaceError((head.stderr or "could not inspect fleet branch HEAD").strip())
            if changed or head.stdout.strip() != self.base_commit:
                error = self.retain(reason, changed)
                return FleetWorkspaceResult("error" if error else "retained", self.path, self.branch,
                                            [self._display_path(path) for path in changed], error or "")
            error = self.cleanup()
            return FleetWorkspaceResult("error" if error else "cleaned", self.path, self.branch,
                                        error=error or "")
        except Exception as exc:
            detail = str(exc)
            metadata_error = self.retain(f"{reason}: {detail}", [])
            if metadata_error:
                detail += f"; {metadata_error}"
            return FleetWorkspaceResult("error", self.path, self.branch, error=detail)
        finally:
            lease.release()

    def cleanup(self) -> str | None:
        return _cleanup_task(self.repo, self.path, self.branch, self.metadata_path)


def _write_retained_metadata(path: Path, payload: dict) -> str | None:
    tmp = ""
    try:
        # ASCII escaping round-trips POSIX surrogateescaped filenames without an encoding crash.
        encoded = (json.dumps(payload, indent=2, ensure_ascii=True) + "\n").encode("ascii")
        if len(encoded) > _MAX_RETAINED_METADATA_BYTES:
            return f"retained-task metadata exceeds {_MAX_RETAINED_METADATA_BYTES} bytes"
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
        try:
            try:
                os.fchmod(fd, 0o600)
            except (AttributeError, OSError):
                pass
            with os.fdopen(fd, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
        return None
    except OSError as exc:
        return f"could not write retained-task metadata: {exc}"
    finally:
        if tmp:
            try:
                Path(tmp).unlink()
            except FileNotFoundError:
                pass


def _cleanup_task(repo: Path, path: Path, branch_name: str, metadata_path: Path) -> str | None:
    """Remove a generated checkout without losing its recovery record on partial failure."""
    errors = []
    removed = _git(["worktree", "remove", "--force", str(path)], repo)
    if removed.returncode != 0 and path.exists():
        errors.append((removed.stderr or "worktree removal failed").strip())
    branch = _git(["branch", "-D", branch_name], repo)
    if branch.returncode != 0 and "not found" not in (branch.stderr or "").lower():
        errors.append((branch.stderr or "branch removal failed").strip())
    if errors:
        return "; ".join(error for error in errors if error)
    try:
        metadata_path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        return f"metadata cleanup failed: {exc}"
    return None


def _read_retained_metadata(path: Path) -> dict:
    """Read one bounded regular metadata file without following a symlink where supported."""
    flags = (os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
             | getattr(os, "O_NONBLOCK", 0))
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise TaskWorkspaceError(f"could not open metadata safely: {exc}") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise TaskWorkspaceError("metadata is not a regular file")
        if info.st_size > _MAX_RETAINED_METADATA_BYTES:
            raise TaskWorkspaceError("metadata exceeds its size limit")
        chunks, total = [], 0
        while True:
            chunk = os.read(fd, min(65536, _MAX_RETAINED_METADATA_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > _MAX_RETAINED_METADATA_BYTES:
                raise TaskWorkspaceError("metadata exceeds its size limit")
        value = json.loads(b"".join(chunks).decode("utf-8"))
        if not isinstance(value, dict):
            raise TaskWorkspaceError("metadata root is not an object")
        return value
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError(f"metadata is not valid UTF-8 JSON: {exc}") from exc
    finally:
        os.close(fd)


@dataclass
class RetainedTask:
    id: str
    source_root: Path
    repo: Path
    project_rel: Path
    path: Path
    project_root: Path
    branch: str
    base_commit: str
    reason: str
    changed_paths: list[str]
    display_paths: list[str]
    protected: dict[str, dict]
    metadata_path: Path
    legacy: bool
    available: bool
    problem: str
    payload: dict = field(repr=False)

    def as_dict(self) -> dict:
        shown, used = [], 0
        for path in self.display_paths[:50]:
            if used + len(path) > 4000:
                break
            shown.append(path)
            used += len(path)
        return {"id": self.id, "reason": self.reason, "changed_paths": shown,
                "changed_count": len(self.display_paths),
                "protected_paths": len(self.protected), "branch": self.branch,
                "worktree": str(self.path), "legacy": self.legacy,
                "available": self.available, "problem": self.problem}

    def _display_path(self, repo_path: str) -> str:
        return str(Path(repo_path).relative_to(self.project_rel)) if self.project_rel != Path(".") else repo_path

    def retain(self, reason: str, paths: list[str]) -> str | None:
        self.reason = str(reason)[:2000]
        self.changed_paths = list(paths)
        self.display_paths = [self._display_path(path) for path in paths]
        self.payload.update({"reason": self.reason, "repo_changed_paths": self.changed_paths,
                             "changed_paths": self.display_paths})
        return _write_retained_metadata(self.metadata_path, self.payload)

    def cleanup(self) -> str | None:
        return _cleanup_task(self.repo, self.path, self.branch, self.metadata_path)

    def _current_delta(self) -> list[str]:
        if self.legacy:
            raise TaskWorkspaceError(
                "legacy retained metadata lacks the baseline hashes required for safe auto-apply")
        candidates = set(_dirty_paths(self.path, self.base_commit, self.project_rel)) | set(self.protected)
        if len(candidates) > _MAX_TASK_FILES:
            raise TaskWorkspaceError(f"retained task delta exceeds {_MAX_TASK_FILES} files")
        changed = []
        total = 0
        for repo_path in sorted(candidates):
            actual = _read_state(_checked_target(self.path, repo_path))
            if repo_path in self.protected:
                same = _fingerprint_matches(actual, self.protected[repo_path])
            else:
                same = actual == _head_state(self.repo, self.base_commit, repo_path)
            if not same:
                total += len(actual.data)
                if total > _MAX_TASK_BYTES:
                    raise TaskWorkspaceError("retained task delta exceeds integration limits")
                changed.append(repo_path)
        return changed

    def integrate(self, checkpoints=None) -> TaskIntegration:
        if not self.available:
            return TaskIntegration("error", error=self.problem or "retained worktree is unavailable")
        try:
            changed = self._current_delta()
        except Exception as exc:
            return TaskIntegration("error", error=str(exc))
        display = [self._display_path(path) for path in changed]
        if not changed:
            cleanup_error = self.cleanup() or ""
            return TaskIntegration("clean", cleanup_error=cleanup_error)
        protected = [path for path in changed if path in self.protected]
        if protected:
            shown = [self._display_path(path) for path in protected]
            reason = "retained task changed files that were dirty before delegation"
            metadata_error = self.retain(reason, changed)
            error = reason + (f"; {metadata_error}" if metadata_error else "")
            return TaskIntegration("conflict", display, shown, error)

        expected: dict[str, _FileState] = {}
        desired: dict[str, _FileState] = {}
        child: dict[str, _FileState] = {}
        prior: dict[str, _FileState] = {}
        merged: list[str] = []
        satisfied: list[str] = []
        conflicts = []
        try:
            for repo_path in changed:
                expected[repo_path] = _head_state(self.repo, self.base_commit, repo_path)
                child[repo_path] = _read_state(_checked_target(self.path, repo_path))
                desired[repo_path] = child[repo_path]
                prior[repo_path] = _read_state(_checked_target(self.repo, repo_path))
                if prior[repo_path] == child[repo_path]:
                    # The parent already holds exactly these bytes. Since a partial integration
                    # applies the files that reconcile and retains only the ones that do not, the
                    # preserved worktree still contains the paths that already landed -- and
                    # re-applying them would compare a now-current parent against a stale base and
                    # report a collision on work that is already in place.
                    satisfied.append(repo_path)
                    continue
                if prior[repo_path] == expected[repo_path]:
                    continue
                # Same reconciliation the live path does, and it matters more here: this IS the
                # retry. A task is retained precisely because something collided, so by the time
                # anyone resolves it the parent has usually moved on further still. Refusing again
                # over an edit in a different part of the file is how retained work became
                # unrecoverable. `protected` is checked above, so nothing dirty at delegation
                # reaches this.
                union = _merge_file(expected[repo_path], prior[repo_path], child[repo_path],
                                    self.repo)
                if union is None:
                    conflicts.append(repo_path)
                else:
                    desired[repo_path] = union
                    merged.append(repo_path)
        except Exception as exc:
            return TaskIntegration("error", display, error=str(exc))
        if conflicts and not [p for p in changed if p not in conflicts and p not in satisfied]:
            shown = [self._display_path(path) for path in conflicts]
            reason = "parent checkout changed before retained task resolution"
            metadata_error = self.retain(reason, changed)
            error = reason + (f"; {metadata_error}" if metadata_error else "")
            return TaskIntegration("conflict", display, shown, error)

        # Same partial rule as the live path: apply what reconciles, hold back only what collides.
        # `satisfied` paths are already in place, so they are neither applied nor held.
        appliable = [path for path in changed
                     if path not in conflicts and path not in satisfied]
        applied: list[str] = []
        try:
            for repo_path in appliable:
                target = _checked_target(self.repo, repo_path)
                if _read_state(target) != prior[repo_path]:
                    raise TaskWorkspaceError(f"parent changed during retained integration: {repo_path}")
                if checkpoints is not None and not checkpoints.record_file(str(target)):
                    raise TaskWorkspaceError(f"could not capture rewind checkpoint: {repo_path}")
                if _read_state(target) != prior[repo_path]:
                    raise TaskWorkspaceError(
                        f"parent changed during retained checkpoint capture: {repo_path}")
                # Against the CHILD's bytes, not the merged result -- see TaskWorkspace.integrate.
                if _read_state(_checked_target(self.path, repo_path)) != child[repo_path]:
                    raise TaskWorkspaceError(f"retained checkout changed during integration: {repo_path}")
                _replace_state(target, desired[repo_path])
                # Tell the manager what DGC just left here. `record_file` above captured the BEFORE
                # bytes; without this second half `_left` still holds whatever DGC wrote in an
                # earlier turn, so the next rewind finds a file it cannot account for, refuses the
                # WHOLE turn, and tells the user "changed outside this chat" about a file DGC's own
                # sub-agent wrote. `getattr` because the suites pass duck-typed checkpoint stubs
                # that define only `record_file`; a bare call would turn those into an integration
                # error. Same shape as the edit-tool path in agent.py.
                note = getattr(checkpoints, "note_written", None)
                if callable(note):
                    note(str(target))
                applied.append(repo_path)
        except Exception as exc:
            rollback_errors = []
            for repo_path in reversed(applied):
                try:
                    _replace_state(_checked_target(self.repo, repo_path), prior[repo_path])
                except Exception as rollback_exc:
                    rollback_errors.append(f"{repo_path}: {rollback_exc}")
            detail = f"retained integration failed: {exc}"
            if rollback_errors:
                detail += "; rollback incomplete: " + ", ".join(rollback_errors[:8])
            self.retain(detail, changed)
            return TaskIntegration("error", display, error=detail)
        landed = [self._display_path(path) for path in applied]
        reconciled = [self._display_path(path) for path in merged if path in applied]
        if conflicts:
            held = [self._display_path(path) for path in conflicts]
            reason = ("parent checkout changed before retained task resolution; "
                      f"{len(applied)} path(s) still applied")
            metadata_error = self.retain(reason, conflicts)
            detail = reason + (f"; {metadata_error}" if metadata_error else "")
            return TaskIntegration("partial", landed, held, detail, merged=reconciled)
        cleanup_error = self.cleanup() or ""
        return TaskIntegration("applied", display, merged=reconciled,
                               cleanup_error=cleanup_error)


def _retained_storage_root(storage_root: Path | None) -> Path:
    if storage_root is None:
        from .config import USER_HOME
        storage_root = USER_HOME / "worktrees"
    return Path(storage_root).expanduser().resolve(strict=False)


_MAX_CASE_COLLISIONS_SHOWN = 6


def aliased_tracked_paths(root: Path, limit: int = _MAX_CASE_COLLISIONS_SHOWN) -> list[str]:
    """Tracked paths that differ only in case AND are one file on disk.

    Measured on the real thing -- macOS 26.5.1, APFS, git 2.50.1 -- with `README.md` and
    `readme.md` both in the index:

        core.ignorecase = true
        index entries:  README.md, readme.md
        files on disk:  readme.md
        a pristine `git worktree add` immediately reports:  M README.md
        both names read:  CONTENT-LOWER
        writing through `readme.md` changes what `README.md` reads

    For an isolated checkout that is a data-loss shape, not an inconvenience. Its delta contains a
    file nothing touched; each of the two names is compared against its OWN expected blob, so both
    look changed; and integrating the result writes one file's content over the other's in the
    user's own checkout. DGC cannot make a filesystem case-sensitive, so it refuses instead.

    The test is exact rather than inferred: two names in one casefold group whose `lstat` reports
    the same (device, inode) really are one file, whatever `core.ignorecase` claims. That config
    only decides whether listing the files is worth it at all, which keeps this free on Linux.
    `lstat`, not `stat`, so a tracked symlink between the two names is not mistaken for aliasing --
    git stores a symlink as a symlink and DGC reads it as one.
    """
    try:
        if _git(["config", "--type=bool", "--get", "core.ignorecase"],
                root).stdout.strip() != "true":
            return []
        out = _git_bytes(["ls-files", "-z"], root, timeout=_GIT_TIMEOUT,
                         max_stdout=_MAX_GIT_PATH_BYTES)
    except Exception:
        return []
    if out.returncode != 0:
        return []
    groups: dict[str, list[str]] = {}
    for raw in out.stdout.split(b"\0"):
        if not raw:
            continue
        name = raw.decode("utf-8", "surrogateescape")
        groups.setdefault(name.casefold(), []).append(name)
    aliased: list[str] = []
    for names in groups.values():
        if len(names) < 2:
            continue
        seen_ids: dict[tuple, str] = {}
        for name in sorted(names):
            try:
                info = os.lstat(root / name)
            except OSError:
                continue
            key = (info.st_dev, info.st_ino)
            if key in seen_ids:
                aliased.extend(sorted(names))
                break
            seen_ids[key] = name
        if len(aliased) >= limit:
            break
    return sorted(dict.fromkeys(aliased))[:limit]


def _case_alias_refusal(root: Path) -> str:
    """The one refusal message, used by both isolated-checkout builders."""
    aliased = aliased_tracked_paths(root)
    if not aliased:
        return ""
    return ("this project tracks paths that differ only in case and this filesystem stores them as "
            f"one file ({', '.join(aliased)}). An isolated checkout reports them as changed before "
            "anything has touched them, and integrating its result would write one file's content "
            "over the other's. Rename one of them (`git mv`), or keep the project on a "
            "case-sensitive volume.")


def _branch_exists(repo: Path, branch: str) -> bool:
    """Does this repository hold that branch? (A worktree's branch lives in the common dir.)"""
    if not branch:
        return False
    return _git(["rev-parse", "--verify", "--quiet",
                 f"refs/heads/{branch}"], repo).returncode == 0


def _is_task_checkout_of(candidate: Path, source_root: Path, storage_root: Path) -> bool:
    """Is `candidate` a delegated checkout of the project at `source_root`?

    Used to decide whether a retained record written against something other than the user's
    project still belongs to it. Two properties have to hold and both are structural rather than
    inferred from a path that may no longer exist: the checkout sat directly in the private
    storage root (created 0700, and never inside the repository), and its directory name carries
    this repository's own task prefix, which is what ties the record to the repository whose
    branch and worktree registration it owns.
    """
    try:
        if candidate.parent != storage_root or not candidate.name:
            return False
        repo = repo_root(source_root)
        if repo is None:
            return False
        return any(candidate.name.startswith(prefix) for prefix in _task_repo_prefixes(repo))
    except (OSError, ValueError):
        return False


def _load_retained(metadata_path: Path, source_root: Path, storage_root: Path
                   ) -> tuple[RetainedTask | None, str | None]:
    try:
        if metadata_path.is_symlink():
            return None, f"ignored unsafe retained-task metadata: {metadata_path.name}"
        payload = _read_retained_metadata(metadata_path)
        if payload.get("kind") != "dgc-isolated-task":
            return None, f"invalid retained-task metadata: {metadata_path.name}"
        recorded_source = Path(str(payload.get("source", ""))).resolve(strict=False)
        # A NESTED record: a grandchild retained work against its parent's delegated checkout, not
        # against the user's project. Measured, that checkout is normally gone by the time anyone
        # looks -- and its worktree and its `dgc/task-...` branch stay registered in the USER's
        # repository, with `/tasks` showing nothing, so there was no way to see the work, apply it,
        # or even delete it. It is listed here instead, against the repository that really owns the
        # branch, so at minimum it can be dropped.
        nested = recorded_source != source_root
        if nested and not _is_task_checkout_of(recorded_source, source_root, storage_root):
            return None, None
        repo = repo_root(source_root)
        if repo is None:
            return None, "retained task belongs to a project that is no longer a Git repository"
        project_rel = (Path(str(payload.get("project_rel", "."))) if nested
                       else source_root.relative_to(repo))
        if nested and (project_rel.is_absolute() or ".." in project_rel.parts):
            raise TaskWorkspaceError("invalid retained task project root")
        task_id = metadata_path.stem
        path = Path(str(payload.get("worktree", ""))).resolve(strict=False)
        if path.parent != storage_root or path.name != task_id:
            raise TaskWorkspaceError("metadata worktree is outside its private storage root")
        branch = str(payload.get("branch", ""))
        if not branch.startswith("dgc/task-") or len(branch) > 128:
            raise TaskWorkspaceError("invalid retained task branch")
        if nested and not _branch_exists(repo, branch):
            # The storage root is SHARED, and the task prefix is built from the repository's
            # directory name -- so two projects both called `app` produce records that look alike.
            # For an ordinary record the recorded source settles ownership; a nested one has given
            # that up, so ownership is taken from the thing this repository actually holds: the
            # branch `git worktree add -b` created in it. Silent, because another project's record
            # is not an error here.
            return None, None
        task_prefix = next((prefix for prefix in _task_repo_prefixes(repo)
                            if task_id.startswith(prefix)), "")
        # A nested id carries its whole lineage (`repo-task-child-X-task-grand-Y`) while the branch
        # names only the last hop, so the branch is checked against the segment after the LAST
        # `-task-`. The prefix still has to be this repository's: that is what ties the record to
        # the repo whose branch is about to be deleted.
        stem = task_id.rsplit("-task-", 1)[1] if nested else task_id[len(task_prefix):]
        if not task_prefix or branch != f"dgc/task-{stem}":
            raise TaskWorkspaceError("retained task id, path, and branch do not match")
        base_commit = str(payload.get("base_commit", ""))
        if not re.fullmatch(r"[0-9a-fA-F]{40,64}", base_commit):
            raise TaskWorkspaceError("invalid retained task base commit")
        schema = payload.get("schema_version")
        legacy = schema != _RETAINED_SCHEMA or "protected_baseline" not in payload
        if not legacy and not nested and str(payload.get("project_rel", ".")) != str(project_rel):
            raise TaskWorkspaceError("retained task project root no longer matches its metadata")
        raw_paths = payload.get("repo_changed_paths") if not legacy else payload.get("changed_paths", [])
        if not isinstance(raw_paths, list) or len(raw_paths) > _MAX_TASK_FILES:
            raise TaskWorkspaceError("invalid retained task changed-path list")
        changed = []
        for raw in raw_paths:
            repo_path = _validate_repo_path(raw if not legacy else str(project_rel / str(raw)))
            if not _inside_project(repo_path, project_rel):
                raise TaskWorkspaceError(f"retained path is outside the project: {repo_path}")
            changed.append(repo_path)
        protected_raw = payload.get("protected_baseline", {}) if not legacy else {}
        if not isinstance(protected_raw, dict) or len(protected_raw) > _MAX_TASK_FILES:
            raise TaskWorkspaceError("invalid retained task protected baseline")
        protected = {}
        for raw, fingerprint in protected_raw.items():
            repo_path = _validate_repo_path(raw)
            if not _inside_project(repo_path, project_rel):
                raise TaskWorkspaceError(f"protected path is outside the project: {repo_path}")
            if not (isinstance(fingerprint, dict)
                    and fingerprint.get("kind") in ("missing", "file", "symlink")
                    and fingerprint.get("mode") in (0, 0o644, 0o755, 0o777)
                    and isinstance(fingerprint.get("bytes"), int)
                    and 0 <= fingerprint.get("bytes") <= _MAX_TASK_BYTES
                    and re.fullmatch(r"[0-9a-f]{64}", str(fingerprint.get("sha256", "")))):
                raise TaskWorkspaceError(f"invalid protected baseline fingerprint: {repo_path}")
            protected[repo_path] = fingerprint
        registered = next((item for item in list_worktrees(repo)
                           if Path(item.get("path", "")).resolve(strict=False) == path), None)
        available = bool(path.exists() and registered and registered.get("branch") == branch)
        problem = "" if available else "retained worktree or branch is missing/stale"
        if available and nested:
            # Listed, never applied from here. This record's delta was written against a DELEGATED
            # checkout, not against this project, and that checkout is usually already gone --
            # applying it from the project's `/tasks` would mean writing one tree's state into a
            # different one. What the project genuinely owns is the branch and the worktree
            # registration, so what it offers is seeing the work and removing it.
            available = False
            problem = ("nested sub-task: written against a delegated checkout, not against this "
                       "project, so it cannot be applied here — read it at its worktree path, or "
                       "drop it to remove the worktree and branch it left in this repository")
        display = [str(Path(p).relative_to(project_rel)) if project_rel != Path(".") else p
                   for p in changed]
        return RetainedTask(task_id, recorded_source, repo, project_rel, path, path / project_rel,
                            branch, base_commit, str(payload.get("reason", ""))[:2000],
                            changed, display, protected, metadata_path, legacy, available,
                            problem, payload), None
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, TaskWorkspaceError) as exc:
        return None, f"could not load {metadata_path.name}: {exc}"


def list_retained(source_root: Path, storage_root: Path | None = None
                  ) -> tuple[list[RetainedTask], list[str]]:
    source_root = Path(source_root).resolve(strict=False)
    try:
        root = _retained_storage_root(storage_root)
    except (OSError, RuntimeError) as exc:
        return [], [f"could not resolve retained-task storage: {exc}"]
    repo = repo_root(source_root)
    if repo is not None:
        try:
            if os.path.commonpath((str(repo), str(root))) == str(repo):
                return [], ["retained-task storage must be outside the source repository"]
        except ValueError:
            pass
    if not root.is_dir():
        return [], []
    prefixes = set(_task_repo_prefixes(repo)) if repo else set()
    tasks, errors = [], []
    try:
        # Filter to THIS repository BEFORE bounding. The bound used to be applied to the shared
        # storage root first, and `sorted()` is lexical over `<repo-name>-task-...` stems, so one
        # busy repository whose name sorts early pushed another repository's records entirely out
        # of the window: `/tasks` came back empty, with "registry exceeds N records", while the
        # user's own retained work sat on disk unreachable.
        everything = sorted(root.glob("*.json"))
    except OSError as exc:
        return [], [f"could not list retained-task storage: {exc}"]
    if prefixes:
        everything = [path for path in everything
                      if any(path.stem.startswith(prefix) for prefix in prefixes)]
    overflow = len(everything) > _MAX_TASK_FILES
    candidates = everything[:_MAX_TASK_FILES]
    for metadata_path in candidates:
        task, error = _load_retained(metadata_path, source_root, root)
        if task is not None:
            tasks.append(task)
        elif error:
            errors.append(error)
    if overflow:
        errors.append(f"retained-task registry exceeds {_MAX_TASK_FILES} records; showing a bounded subset")
    return sorted(tasks, key=lambda task: task.id), errors[:32]


def resolve_retained(source_root: Path, task_id: str, action: str, storage_root: Path | None = None,
                     checkpoints=None, cancelled=None) -> TaskIntegration:
    """Apply or drop one retained task under the canonical checkout mutation lease."""
    action = str(action).strip().lower()
    task_id = str(task_id)
    if action not in ("apply", "drop"):
        return TaskIntegration("error", error="retained task action must be 'apply' or 'drop'")
    if not task_id or len(str(task_id)) > 240 or Path(str(task_id)).name != str(task_id):
        return TaskIntegration("error", error="invalid retained task id")
    from .scheduler import acquire_cancellable, workspace_mutation_lock
    timer = None
    cancel = cancelled
    if cancel is None:
        cancel = threading.Event()
        timer = threading.Timer(_RETAINED_LEASE_WAIT_S, cancel.set)
        timer.daemon = True
        timer.start()
    try:
        lease = workspace_mutation_lock(source_root)
        acquired = acquire_cancellable(lease, cancel)
    except Exception as exc:
        if timer is not None:
            timer.cancel()
        return TaskIntegration("error", error=f"could not acquire workspace lease: {type(exc).__name__}: {exc}")
    if not acquired:
        if timer is not None:
            timer.cancel()
        return TaskIntegration("error", error=lease.last_error or "cancelled waiting for workspace lease")
    try:
        tasks, errors = list_retained(source_root, storage_root)
        task = next((item for item in tasks if item.id == task_id), None)
        if task is None:
            detail = errors[0] if errors else f"no retained task matching {task_id!r}"
            return TaskIntegration("error", error=detail)
        if action == "drop":
            cleanup_error = task.cleanup() or ""
            return TaskIntegration("error" if cleanup_error else "dropped",
                                   error=cleanup_error, cleanup_error=cleanup_error)
        return task.integrate(checkpoints)
    except Exception as exc:
        return TaskIntegration("error", error=f"retained task resolution failed: {type(exc).__name__}: {exc}")
    finally:
        lease.release()
        if timer is not None:
            timer.cancel()
