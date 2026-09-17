#!/usr/bin/env python3
"""Small local SDK probe. Point cwd at a checkout and a reachable model.

  PYTHONPATH=sdk/python:. python3 examples/sdk/hello_run.py /path/to/workspace
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdk" / "python"))
sys.path.insert(0, str(ROOT))

from dgc_sdk import DGC, QuestionAnswer


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: hello_run.py WORKSPACE", file=sys.stderr)
        return 2
    workspace = Path(sys.argv[1]).resolve()
    state = Path("/tmp/dgc-sdk-hello")
    with DGC(state_dir=state, inherit_user_state=False) as dgc:
        session = dgc.session(
            cwd=workspace,
            permissions={"mode": "default", "unhandled": "deny"},
            on_permission=lambda req: "deny",
            on_question=lambda req: {req.questions[0].id: QuestionAnswer(selected=(0,))}
            if req.questions else "dismiss",
        )
        result = session.run("Summarize this repository in two sentences. Do not edit files.")
        print(result.status, result.reason)
        print(result.final_text)
        return 0 if result.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
