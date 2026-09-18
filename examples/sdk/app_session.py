#!/usr/bin/env python3
"""Application-shaped session: stream events as they arrive, answer the option picker.

    python3 -m pip install dgc-sdk
    export DGC_MODEL=qwen3:8b DGC_BASE_URL=http://127.0.0.1:11434/v1
    python3 app_session.py /path/to/workspace

Options and environment are the same as hello_run.py.
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

from dgc_sdk import DGC, DGCError, QuestionAnswer, QuestionRequest


def pick_recommended(request: QuestionRequest):
    """Answer every question with its recommended option (else the first)."""
    if not request.questions:
        return "dismiss"
    answers = {}
    for question in request.questions:
        index = next((i for i, option in enumerate(question.options) if option.recommended), 0)
        answers[question.id] = QuestionAnswer(selected=(index,))
    return answers


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
    state = args.state_dir or Path(tempfile.mkdtemp(prefix="dgc-sdk-app-"))
    try:
        with DGC(state_dir=state, model=args.model, base_url=args.base_url,
                 api_key=os.environ.get("DGC_API_KEY")) as dgc:
            session = dgc.session(
                cwd=args.workspace,
                permissions={"mode": "plan", "unhandled": "deny"},
                on_question=pick_recommended,
            )
            with session.stream("Summarize this repository in two sentences. Do not edit files.") as run:
                for event in run:
                    if event.type == "text_delta":
                        print(event.data.get("text", ""), end="", flush=True)
                    elif event.type == "tool_call":
                        print(f"\n[tool] {event.data.get('name', '')}", flush=True)
                    elif event.type == "turn_end":
                        print(f"\n[turn_end] {event.data.get('reason', '')}", flush=True)
                result = run.result()
    except DGCError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"status: {result.status} ({result.reason or 'no reason'})")
    if result.error:
        print(f"error: {result.error}")
    return 0 if result.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
