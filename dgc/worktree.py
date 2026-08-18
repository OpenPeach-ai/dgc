"""Git worktree support — an isolated working copy on its own
branch, so you (or the agent) can build a change without disturbing the main checkout. Worktrees
are created as siblings of the repo (`<repo>-<name>`) on branch `dgc/<name>`.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path


def _git(args: list[str], cwd) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)


def repo_root(path) -> Path | None:
    r = _git(["rev-parse", "--show-toplevel"], path)
    return Path(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None


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
    """Create a worktree for `name` on a new branch `dgc/<name>`, sibling to the repo.
    Returns (worktree_path, branch, error)."""
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
    """Remove a worktree by name (or path). Returns an error string, or None on success."""
    root = repo_root(path)
    if not root:
        return "not inside a git repository"
    safe = _safe(name)
    target = None
    for w in list_worktrees(path):
        wp = Path(w["path"])
        if wp.name == f"{root.name}-{safe}" or wp.name == name or w.get("branch") == f"dgc/{safe}":
            target = wp
            break
    if target is None:
        return f"no worktree matching '{name}'"
    r = _git(["worktree", "remove", "--force", str(target)], root)
    return None if r.returncode == 0 else r.stderr.strip()
