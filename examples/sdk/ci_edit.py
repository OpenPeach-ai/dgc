#!/usr/bin/env python3
"""Controlled edit for CI: allow file edits only, then write a patch that `git apply` accepts.

    python3 -m pip install dgc-sdk
    export DGC_MODEL=qwen3:8b DGC_BASE_URL=http://127.0.0.1:11434/v1
    python3 ci_edit.py /path/to/git/checkout --patch fix.patch

Options and environment are the same as hello_run.py. WORKSPACE must be a git checkout with a
clean tree (a fresh CI checkout is). The agent may call write_file/edit_file; every other tool
that asks for permission, including shell commands, is denied. The patch is `git diff` of the
checkout against HEAD after the run, new files included; the real index is not touched.
Exit codes: 0 completed, 1 rejected, 2 usage, 3 blocked, 4 timeout, 5 failed.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from dgc_sdk import DGC, DGCError

ALLOWED = {"write_file", "edit_file"}


def git(workspace: Path, *args: str, env: dict[str, str] | None = None) -> str:
    return subprocess.run(["git", "-C", str(workspace), *args], check=True, capture_output=True,
                          text=True, env=env).stdout


def working_tree_patch(workspace: Path) -> str:
    """Unified diff of the working tree against HEAD, with untracked files as additions.

    `git add -A` runs against a throwaway copy of the index, so the checkout's own index and
    .gitignore rules are left exactly as they were.
    """
    git_dir = Path(git(workspace, "rev-parse", "--absolute-git-dir").strip())
    with tempfile.TemporaryDirectory(prefix="dgc-sdk-ci-edit-index-") as scratch:
        index = Path(scratch) / "index"
        if (git_dir / "index").is_file():
            shutil.copyfile(git_dir / "index", index)
        env = {**os.environ, "GIT_INDEX_FILE": str(index)}
        git(workspace, "add", "-A", "--", ".", env=env)
        return git(workspace, "diff", "--cached", "--binary", "--no-color", "--no-ext-diff",
                   "HEAD", env=env)


def exit_code(result) -> int:
    if result.status == "completed":
        return 0
    if result.status == "blocked":
        return 3
    if result.reason == "timeout":
        return 4
    if result.status == "failed":
        return 5
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("workspace", type=Path)
    parser.add_argument("--patch", type=Path, default=Path("dgc-sdk-ci-edit.patch"),
                        help="where to write the patch (default: ./dgc-sdk-ci-edit.patch)")
    parser.add_argument("--model", default=os.environ.get("DGC_MODEL"))
    parser.add_argument("--base-url", default=os.environ.get("DGC_BASE_URL"))
    parser.add_argument("--state-dir", type=Path, help="default: a new temporary directory")
    parser.add_argument("--timeout", type=float, default=900.0, help="seconds (default 900)")
    parser.add_argument("--prompt", default=(
        "Make the smallest safe fix you are sure of, then stop. "
        "If nothing needs changing, say so and do not edit files."))
    args = parser.parse_args()
    if not args.model or not args.base_url:
        parser.error("set --model and --base-url (or DGC_MODEL and DGC_BASE_URL)")
    workspace = args.workspace.resolve()
    try:
        dirty = git(workspace, "status", "--porcelain")
    except (OSError, subprocess.CalledProcessError):
        parser.error(f"{workspace} is not a git checkout")
    if dirty.strip():
        parser.error(f"{workspace} has uncommitted changes; the patch would include them")
    state = args.state_dir or Path(tempfile.mkdtemp(prefix="dgc-sdk-ci-edit-"))
    try:
        with DGC(state_dir=state, model=args.model, base_url=args.base_url,
                 api_key=os.environ.get("DGC_API_KEY")) as dgc:
            session = dgc.session(
                cwd=workspace,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=lambda req: "once" if req.name in ALLOWED else "deny",
            )
            result = session.run(args.prompt, timeout=args.timeout, max_turns=8)
    except DGCError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, indent=2))
        return 5
    patch = working_tree_patch(workspace)
    args.patch.write_text(patch, encoding="utf-8")
    print(json.dumps({
        "status": result.status,
        "reason": result.reason,
        "error": result.error,
        "session_id": result.session_id,
        "run_id": result.run_id,
        "changes": [{"path": change.path, "kind": change.kind} for change in result.changes],
        "patch": str(args.patch.resolve()),
        "patch_bytes": len(patch.encode("utf-8")),
    }, indent=2))
    return exit_code(result)


if __name__ == "__main__":
    raise SystemExit(main())
