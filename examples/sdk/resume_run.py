#!/usr/bin/env python3
"""Close a session, then resume the same conversation from the client's state directory.

    python3 -m pip install dgc-sdk
    export DGC_MODEL=qwen3:8b DGC_BASE_URL=http://127.0.0.1:11434/v1
    python3 resume_run.py /path/to/workspace

Options and environment are the same as hello_run.py. Pass the same --state-dir to a later
process to resume across restarts.
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

from dgc_sdk import DGC, DGCError

PERMISSIONS = {"mode": "plan", "unhandled": "deny"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("workspace", type=Path)
    parser.add_argument("--model", default=os.environ.get("DGC_MODEL"))
    parser.add_argument("--base-url", default=os.environ.get("DGC_BASE_URL"))
    parser.add_argument("--state-dir", type=Path, help="default: a new temporary directory")
    args = parser.parse_args()
    if not args.model or not args.base_url:
        parser.error("set --model and --base-url (or DGC_MODEL and DGC_BASE_URL)")
    if not args.workspace.is_dir():
        parser.error(f"{args.workspace} is not a directory")
    state = args.state_dir or Path(tempfile.mkdtemp(prefix="dgc-sdk-resume-"))
    try:
        with DGC(state_dir=state, model=args.model, base_url=args.base_url,
                 api_key=os.environ.get("DGC_API_KEY")) as dgc:
            session = dgc.session(cwd=args.workspace, permissions=PERMISSIONS)
            first = session.run("Summarize this repository in one sentence. Do not edit files.")
            session_id = session.session_id
            print(f"first run: {first.status}, session {session_id}")
            session.close()
            restored = dgc.resume(session_id, cwd=args.workspace, permissions=PERMISSIONS)
            print(f"resumed: session {restored.session_id}")
            second = restored.run("Repeat your previous summary in fewer words. Do not edit files.")
    except DGCError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"second run: {second.status} ({second.reason or 'no reason'})")
    if second.error:
        print(f"error: {second.error}")
    print(second.final_text)
    return 0 if second.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
