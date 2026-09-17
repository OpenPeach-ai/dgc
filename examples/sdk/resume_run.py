#!/usr/bin/env python3
"""Resume a prior SDK session from the same isolated HOME.

  PYTHONPATH=sdk/python:. python3 examples/sdk/resume_run.py /path/to/workspace
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdk" / "python"))
sys.path.insert(0, str(ROOT))

from dgc_sdk import DGC


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: resume_run.py WORKSPACE", file=sys.stderr)
        return 2
    workspace = Path(sys.argv[1]).resolve()
    with DGC(state_dir=Path("/tmp/dgc-sdk-resume"), inherit_user_state=False) as dgc:
        session = dgc.session(
            cwd=workspace,
            permissions={"mode": "default", "unhandled": "deny"},
        )
        first = session.run("Summarize this repository in one sentence. Do not edit files.")
        print("first", first.status, session.session_id)
        session.close()
        restored = dgc.resume(
            latest=True,
            cwd=workspace,
            permissions={"mode": "default", "unhandled": "deny"},
        )
        print("resumed", restored.session_id)
        second = restored.run("Repeat the previous summary in fewer words. Do not edit files.")
        print(second.status, second.reason)
        print(second.final_text)
        return 0 if second.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
