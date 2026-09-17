#!/usr/bin/env python3
"""Unattended review recipe. No TTY, no host ~/.dgc.

  PYTHONPATH=sdk/python:. python3 examples/sdk/ci_review.py /path/to/checkout
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdk" / "python"))
sys.path.insert(0, str(ROOT))

from dgc_sdk import DGC


SCHEMA = {
    "type": "object",
    "required": ["summary", "ok"],
    "properties": {
        "ok": {"type": "boolean"},
        "summary": {"type": "string"},
    },
    "additionalProperties": True,
}


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: ci_review.py WORKSPACE", file=sys.stderr)
        return 2
    workspace = Path(sys.argv[1]).resolve()
    state = Path("/tmp/dgc-sdk-ci-review")
    with DGC(state_dir=state, inherit_user_state=False) as dgc:
        session = dgc.session(
            cwd=workspace,
            permissions={"mode": "plan", "unhandled": "deny"},
        )
        result = session.run(
            "Review this checkout. Do not edit files. Return JSON {ok, summary}.",
            output_schema=SCHEMA,
            timeout=180,
        )
    print(json.dumps({
        "status": result.status,
        "reason": result.reason,
        "output": result.output,
        "error": result.error,
        "session_id": result.session_id,
        "run_id": result.run_id,
    }, indent=2))
    if result.status == "completed" and result.output and result.output.get("ok"):
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
