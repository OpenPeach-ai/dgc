#!/usr/bin/env python3
"""Application-shaped session: stream events, native picker, stop.

  PYTHONPATH=sdk/python:. python3 examples/sdk/app_session.py /path/to/workspace
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
        print("usage: app_session.py WORKSPACE", file=sys.stderr)
        return 2
    workspace = Path(sys.argv[1]).resolve()
    with DGC(state_dir=Path("/tmp/dgc-sdk-app"), inherit_user_state=False) as dgc:
        session = dgc.session(
            cwd=workspace,
            permissions={"mode": "default", "unhandled": "deny"},
            on_permission=lambda req: "deny",
            on_question=lambda req: (
                {req.questions[0].id: QuestionAnswer(selected=(0,))}
                if req.questions else "dismiss"
            ),
        )
        with session.stream("Summarize this repository in two sentences. Do not edit files.") as run:
            for event in run:
                if event.type in ("text_delta", "tool_call", "permission_request",
                                  "options_request", "turn_end"):
                    print(event.type)
            result = run.result()
        print(result.status, result.reason)
        print(result.final_text)
        return 0 if result.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
