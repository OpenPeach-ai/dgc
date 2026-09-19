#!/usr/bin/env python3
"""Ask one read-only question about a workspace and print the answer.

    python3 -m pip install dgc-sdk
    export DGC_MODEL=qwen3:8b DGC_BASE_URL=http://127.0.0.1:11434/v1
    python3 hello_run.py /path/to/workspace

The model and endpoint come from --model/--base-url or DGC_MODEL/DGC_BASE_URL; DGC_API_KEY is
passed through when the endpoint needs a key. The SDK finds a `dgc serve` to run on its own —
`dgc` on PATH, `~/.local/bin/dgc`, or the Python named by DGC_PYTHON (see the SDK README). State
goes to a fresh temporary directory unless --state-dir is given.
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

from dgc_sdk import DGC, DGCError


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("workspace", type=Path)
    parser.add_argument("--model", default=os.environ.get("DGC_MODEL"))
    parser.add_argument("--base-url", default=os.environ.get("DGC_BASE_URL"))
    parser.add_argument("--state-dir", type=Path, help="default: a new temporary directory")
    args = parser.parse_args()
    if not args.model or not args.base_url:
        parser.error("set --model and --base-url (or DGC_MODEL and DGC_BASE_URL), for example "
                     "qwen3:8b and http://127.0.0.1:11434/v1")
    if not args.workspace.is_dir():
        parser.error(f"{args.workspace} is not a directory")
    state = args.state_dir or Path(tempfile.mkdtemp(prefix="dgc-sdk-hello-"))
    try:
        with DGC(state_dir=state, model=args.model, base_url=args.base_url,
                 api_key=os.environ.get("DGC_API_KEY")) as dgc:
            # Plan mode: the agent may read and search, but it cannot edit or run commands.
            session = dgc.session(cwd=args.workspace, permissions={"mode": "plan", "unhandled": "deny"})
            result = session.run("Summarize this repository in two sentences. Do not edit files.")
    except DGCError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"status: {result.status} ({result.reason or 'no reason'})")
    if result.error:
        print(f"error: {result.error}")
    print(result.final_text)
    return 0 if result.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
