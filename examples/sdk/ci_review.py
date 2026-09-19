#!/usr/bin/env python3
"""Unattended review for CI: read-only, JSON report, exit code for the job.

    python3 -m pip install dgc-sdk
    export DGC_MODEL=qwen3:8b DGC_BASE_URL=http://127.0.0.1:11434/v1
    python3 ci_review.py /path/to/checkout

Options and environment are the same as hello_run.py. The run uses plan mode, so the agent can
read the checkout but not edit it or run commands. It never reads the runner's ~/.dgc.
Exit codes: 0 accepted, 1 rejected, 2 usage, 3 no verdict with denied steps, 4 timeout, 5 failed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from dgc_sdk import DGC, DGCError

SCHEMA = {
    "type": "object",
    "required": ["summary", "ok"],
    "properties": {
        "ok": {"type": "boolean"},
        "summary": {"type": "string"},
    },
    "additionalProperties": True,
}


def exit_code(result) -> int:
    if result.status == "completed" and isinstance(result.output, dict):
        return 0 if result.output.get("ok") else 1
    # No valid verdict. If the run was held back by denied steps (a locked-down policy, or a
    # workspace it could not read), say so distinctly so the gate does not read that as "passed".
    if result.denials:
        return 3
    if result.reason == "timeout":
        return 4
    return 5


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("workspace", type=Path)
    parser.add_argument("--model", default=os.environ.get("DGC_MODEL"))
    parser.add_argument("--base-url", default=os.environ.get("DGC_BASE_URL"))
    parser.add_argument("--state-dir", type=Path, help="default: a new temporary directory")
    parser.add_argument("--timeout", type=float, default=600.0, help="seconds (default 600)")
    args = parser.parse_args()
    if not args.model or not args.base_url:
        parser.error("set --model and --base-url (or DGC_MODEL and DGC_BASE_URL)")
    if not args.workspace.is_dir():
        parser.error(f"{args.workspace} is not a directory")
    state = args.state_dir or Path(tempfile.mkdtemp(prefix="dgc-sdk-ci-review-"))
    try:
        with DGC(state_dir=state, model=args.model, base_url=args.base_url,
                 api_key=os.environ.get("DGC_API_KEY")) as dgc:
            session = dgc.session(cwd=args.workspace, permissions={"mode": "plan", "unhandled": "deny"})
            result = session.run(
                "Review this checkout for obvious bugs. Do not edit files. "
                "Return JSON {ok, summary}: ok is false when you found a bug.",
                output_schema=SCHEMA,
                timeout=args.timeout,
            )
    except DGCError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, indent=2))
        return 5
    print(json.dumps({
        "status": result.status,
        "reason": result.reason,
        "output": result.output,
        "error": result.error,
        "denials": [{"name": d.name, "source": d.source, "reason": d.reason}
                    for d in result.denials],
        "session_id": result.session_id,
        "run_id": result.run_id,
    }, indent=2))
    return exit_code(result)


if __name__ == "__main__":
    raise SystemExit(main())
