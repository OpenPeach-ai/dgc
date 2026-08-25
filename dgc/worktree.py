"""Git worktrees for manual sessions and isolated write-capable sub-agents.

Manual worktrees are long-lived branches selected with ``/worktree``. Task worktrees are private,
unique, short-lived branches populated with the calling checkout's exact tracked/untracked state.
Only the sub-agent's delta is integrated, after a content-level conflict check; pre-existing dirty
files are never overwritten automatically.
"""
from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path

_MAX_TASK_FILES = 4096
_MAX_TASK_BYTES = 64 * 1024 * 1024
_GIT_TIMEOUT = 30.0


def _git(args: list[str], cwd, *, timeout: float = _GIT_TIMEOUT) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True,
                              timeout=max(0.1, float(timeout)))
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode(errors="replace")
        return subprocess.CompletedProcess(["git", *args], 124, stdout, "git timed out")
    except OSError as exc:
        return subprocess.CompletedProcess(["git", *args], 127, "", str(exc))


def _git_bytes(args: list[str], cwd, *, timeout: float = _GIT_TIMEOUT) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True,
                              timeout=max(0.1, float(timeout)))
    except subprocess.TimeoutExpired as exc:
        return subprocess.CompletedProcess(["git", *args], 124, exc.stdout or b"", b"git timed out")
    except OSError as exc:
        return subprocess.CompletedProcess(["git", *args], 127, b"", os.fsencode(str(exc)))


def repo_root(path) -> Path | None:
    r = _git(["rev-parse", "--show-toplevel"], path)
    return Path(r.stdout.strip()).resolve() if r.returncode == 0 and r.stdout.strip() else None


def in_repo(path) -> bool:
    return repo_root(path) is not None


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-").lower() or "work"


def list_worktrees(path) -> list[dict]:
    r = _git(["worktree", "list", "--porcelain"], path)
    if r.returncode != 0:
        return []
    out, cur = [], {}
    for line in r.stdout.splitlines():
        if line.startswith("worktree "):
            if cur:
                out.append(cur)
            cur = {"path": line[len("worktree "):]}
        elif line.startswith("branch "):
            cur["branch"] = line[len("branch "):].replace("refs/heads/", "")
        elif line == "bare":
            cur["bare"] = True
    if cur:
        out.append(cur)
    return out


def create(path, name: str) -> tuple[Path | None, str | None, str | None]:
    """Create a long-lived manual worktree on ``dgc/<name>``."""
    root = repo_root(path)
    if not root:
        return None, None, "not inside a git repository — run `git init` first"
    safe = _safe(name)
    branch = f"dgc/{safe}"
    wt_path = root.parent / f"{root.name}-{safe}"
    if wt_path.exists():
        return None, None, f"path already exists: {wt_path}"
    r = _git(["worktree", "add", "-b", branch, str(wt_path)], root)
    if r.returncode != 0:                       # branch may already exist → attach to it
        r2 = _git(["worktree", "add", str(wt_path), branch], root)
        if r2.returncode != 0:
            return None, None, (r.stderr or r2.stderr or "git worktree add failed").strip()
    return wt_path, branch, None


def remove(path, name: str) -> str | None:
    """Remove a worktree by exact branch, name, or generated slug."""
    root = repo_root(path)
    if not root:
        return "not inside a git repository"
    safe = _safe(name)
    target = None
    for w in list_worktrees(path):
        wp = Path(w["path"])
        if (str(wp) == name or wp.name == name or w.get("branch") == name
                or wp.name == f"{root.name}-{safe}" or w.get("branch") == f"dgc/{safe}"):
            target = wp
            break
    if target is None:
        return f"no worktree matching '{name}'"
    r = _git(["worktree", "remove", "--force", str(target)], root)
    return None if r.returncode == 0 else (r.stderr or "git worktree remove failed").strip()


class TaskWorkspaceError(RuntimeError):
    pass


@dataclass(frozen=True)
class _FileState:
    kind: str                         # missing | file | symlink
    data: bytes = b""
    mode: int = 0


def _normal_mode(mode: int) -> int:
    return 0o755 if mode & 0o111 else 0o644


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
    return paths


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


def _dirty_paths(repo: Path, base_commit: str, project_rel: Path) -> set[str]:
    pathspec = str(project_rel) if project_rel != Path(".") else "."
    tracked = _nul_paths(_git_bytes(
        ["diff", "--name-only", "-z", "--no-renames", base_commit, "--", pathspec], repo))
    untracked = _nul_paths(_git_bytes(
        ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec], repo))
    return {path for path in (*tracked, *untracked) if _inside_project(path, project_rel)}


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
    blob = _git_bytes(["cat-file", "blob", oid.decode("ascii")], repo)
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
    status: str                       # applied | clean | conflict | error
    paths: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    error: str = ""
    cleanup_error: str = ""


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

    @classmethod
    def prepare(cls, source_root: Path, name: str, storage_root: Path | None = None
                ) -> tuple["TaskWorkspace | None", str | None]:
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
        base_commit = base.stdout.strip()
        token = uuid.uuid4().hex[:10]
        slug = _safe(name)[:40]
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
        except OSError as exc:
            return None, f"could not resolve isolated task storage: {exc}"
        try:
            storage_root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return None, f"could not create isolated task storage: {exc}"
        try:
            storage_root.chmod(0o700)
        except OSError:
            pass
        path = storage_root / f"{repo.name}-task-{slug}-{token}"
        metadata_path = storage_root / f"{path.name}.json"
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
            return task, None
        except Exception as exc:
            cleanup_error = task.cleanup()
            detail = str(exc)
            if cleanup_error:
                detail += (f"; cleanup failed for {task.path} on branch {task.branch}: "
                           f"{cleanup_error}")
            return None, detail

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
            "kind": "dgc-isolated-task", "source": str(self.source_root), "worktree": str(self.path),
            "branch": self.branch, "base_commit": self.base_commit,
            "reason": str(reason)[:2000], "changed_paths": [self._display_path(p) for p in paths],
        }
        tmp = ""
        try:
            fd, tmp = tempfile.mkstemp(prefix=f".{self.metadata_path.name}.", suffix=".tmp",
                                       dir=str(self.metadata_path.parent))
            try:
                try:
                    os.fchmod(fd, 0o600)
                except (AttributeError, OSError):
                    pass
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, indent=2)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(tmp, self.metadata_path)
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

    def integrate(self, checkpoints=None) -> TaskIntegration:
        try:
            changed = self.changed_paths()
        except Exception as exc:
            self.retain(str(exc), [])
            return TaskIntegration("error", error=str(exc))
        display = [self._display_path(path) for path in changed]
        if not changed:
            cleanup_error = self.cleanup() or ""
            return TaskIntegration("clean", cleanup_error=cleanup_error)
        protected = [path for path in changed if path in self.initial_dirty]
        if protected:
            conflicts = [self._display_path(path) for path in protected]
            reason = "sub-agent changed files that were already dirty before delegation"
            self.retain(reason, changed)
            return TaskIntegration("conflict", display, conflicts, reason)

        expected: dict[str, _FileState] = {}
        desired: dict[str, _FileState] = {}
        prior: dict[str, _FileState] = {}
        conflicts = []
        try:
            for repo_path in changed:
                expected[repo_path] = self._expected(repo_path)
                desired[repo_path] = _read_state(_checked_target(self.path, repo_path))
                prior[repo_path] = _read_state(_checked_target(self.repo, repo_path))
                if prior[repo_path] != expected[repo_path]:
                    conflicts.append(repo_path)
        except Exception as exc:
            self.retain(str(exc), changed)
            return TaskIntegration("error", display, error=str(exc))
        if conflicts:
            shown = [self._display_path(path) for path in conflicts]
            reason = "parent checkout changed while the isolated task was running"
            self.retain(reason, changed)
            return TaskIntegration("conflict", display, shown, reason)

        applied: list[str] = []
        try:
            for repo_path in changed:
                target = _checked_target(self.repo, repo_path)
                if _read_state(target) != prior[repo_path]:
                    raise TaskWorkspaceError(f"parent changed during integration: {repo_path}")
                if checkpoints is not None and not checkpoints.record_file(str(target)):
                    raise TaskWorkspaceError(f"could not capture rewind checkpoint: {repo_path}")
                if _read_state(target) != prior[repo_path]:
                    raise TaskWorkspaceError(f"parent changed during checkpoint capture: {repo_path}")
                _replace_state(target, desired[repo_path])
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
            self.retain(detail, changed)
            return TaskIntegration("error", display, error=detail)
        cleanup_error = self.cleanup() or ""
        return TaskIntegration("applied", display, cleanup_error=cleanup_error)

    def cleanup(self) -> str | None:
        errors = []
        registered = _git(["worktree", "remove", "--force", str(self.path)], self.repo)
        if registered.returncode != 0 and self.path.exists():
            errors.append((registered.stderr or "worktree removal failed").strip())
        branch = _git(["branch", "-D", self.branch], self.repo)
        if branch.returncode != 0 and "not found" not in (branch.stderr or "").lower():
            errors.append((branch.stderr or "branch removal failed").strip())
        try:
            self.metadata_path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            errors.append(f"metadata cleanup failed: {exc}")
        return "; ".join(error for error in errors if error) or None
