#!/usr/bin/env python3
"""Controlled edit recipe. One allowed write, then a JSON report + patch list.

  PYTHONPATH=sdk/python:. python3 examples/sdk/ci_edit.py /path/to/checkout
Exit: 0 accepted, 1 rejected, 2 usage, 3 blocked, 4 timeout, 5 failed.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdk" / "python"))
sys.path.insert(0, str(ROOT))

from dgc_sdk import DGC


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: ci_edit.py WORKSPACE", file=sys.stderr)
        return 2
    workspace = Path(sys.argv[1]).resolve()
    allowed = {"write_file", "edit_file"}
    with DGC(state_dir=Path("/tmp/dgc-sdk-ci-edit"), inherit_user_state=False) as dgc:
        session = dgc.session(
            cwd=workspace,
            permissions={"mode": "default", "unhandled": "deny"},
            on_permission=lambda req: "once" if req.name in allowed else "deny",
        )
        result = session.run(
            "Make the smallest safe fix you are sure of, then stop. "
            "If nothing needs changing, say so and do not edit files.",
            timeout=180,
            max_turns=8,
        )
    report = {
        "status": result.status,
        "reason": result.reason,
        "error": result.error,
        "session_id": result.session_id,
        "run_id": result.run_id,
        "changes": [
            {"path": change.path, "kind": change.kind} for change in result.changes
        ],
        "verification": None if result.verification is None else {
            "ok": result.verification.ok,
            "command": result.verification.command,
            "exit_code": result.verification.exit_code,
        },
    }
    patch_path = Path("/tmp/dgc-sdk-ci-edit.patch")
    lines = []
    for change in result.changes:
        lines.append(f"--- a/{change.path}\n+++ b/{change.path}\n")
        if change.after:
            for row in change.after.splitlines():
                lines.append(f"+{row}\n")
    patch_path.write_text("".join(lines), encoding="utf-8")
    report["patch"] = str(patch_path)
    print(json.dumps(report, indent=2))
    if result.status == "completed":
        return 0
    if result.status == "blocked":
        return 3
    if result.reason == "timeout":
        return 4
    if result.status == "failed":
        return 5
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
