"""The AgentUI seam — the single contract every front-end implements.

`Agent` (agent.py) talks to the outside world through exactly one injected object, `self.ui`.
Nothing in the agent core imports a concrete UI, so the terminal REPL (cli.py) and the headless
JSON backend (headless.py) are just two implementations of the protocol below. This module
documents that contract and holds the small formatters both implementations share.
"""
from __future__ import annotations

import re
from typing import Protocol, runtime_checkable


@runtime_checkable
class AgentUI(Protocol):
    # streaming (agent → front-end) --------------------------------------------
    def on_text(self, chunk: str) -> None: ...
    def on_thinking(self, chunk: str) -> None: ...
    def end_stream(self) -> None: ...
    # tool lifecycle -----------------------------------------------------------
    def tool_call(self, name: str, args: dict, call_id: str | None = None) -> None: ...
    def tool_progress(self, name: str, message: str, *, progress=None, total=None,
                      level: str = "", call_id: str | None = None) -> None: ...
    def tool_result(self, name: str, out: str, call_id: str | None = None) -> None: ...
    def tool_denied(self, name: str, args: dict, reason: str,
                    call_id: str | None = None) -> None: ...
    def on_todo(self, todos: list) -> None: ...
    def hook_activity(self, event: str, status: str, *, configured: int = 0,
                      duration_ms: int = 0, message: str = "") -> None: ...
    # blocking decisions (front-end answers) -----------------------------------
    def approve(self, name: str, args: dict, call_id: str | None = None) -> str: ...
    def add_permission_rule(self, name: str, args: dict) -> None: ...
    plan_feedback: str                                             # one-shot rejection steer
    def present_plan(self, plan: str): ...                          # mode str | None
    def propose_options(self, question: str, options: list) -> str: ...
    def propose_questions(self, questions: list[dict]) -> dict | None: ...
    # MCP server input is a separate, always-consent-gated channel. ``kind`` is one of
    # elicitation | sampling_request | sampling_response; implementations return an action dict.
    def mcp_capabilities(self) -> dict: ...
    def mcp_input(self, server: str, kind: str, payload: dict, *, cancel=None) -> dict: ...
    # notices ------------------------------------------------------------------
    def info(self, message: str) -> None: ...
    def error(self, message: str) -> None: ...


# ---- shared formatters (used by both the REPL and the JSON backend) ----------

def arg_summary(name: str, args: dict) -> str:
    """A one-line human summary of a tool call's primary argument."""
    for key in ("path", "command", "pattern", "url", "name", "memory", "symbol", "operation"):
        if key in args:
            value = str(args[key]).replace("\n", " ")
            return value[:120] + ("…" if len(value) > 120 else "")
    return ""


def _cap_diff(text: str, limit: int = 200) -> str:
    rows = text.splitlines()
    if len(rows) > limit:
        return "\n".join(rows[:limit]) + f"\n… {len(rows) - limit} more lines"
    return "\n".join(rows)


def edit_preview(name: str, args: dict, root) -> str:
    """A unified diff of what an edit tool WOULD do, for an approval card.

    Read-only and bounded: the file is read once (skipped past 256 KB) and the diff is cut at
    200 lines. "" when there is nothing to show — a tool that is not an edit, a target that
    does not match, a no-op — so the card falls back to the raw arguments.
    """
    import difflib
    from pathlib import Path
    try:
        if name == "apply_patch":
            return _cap_diff(str(args.get("patch") or ""))
        raw = str(args.get("path") or "")
        if not raw or name not in ("write_file", "edit_file", "multi_edit"):
            return ""
        path = Path(raw)
        if not path.is_absolute():
            path = Path(str(root)) / path
        old = ""
        if path.is_file():
            if path.stat().st_size > 262_144:
                return ""
            old = path.read_text(encoding="utf-8", errors="replace")
        if name == "write_file":
            new = str(args.get("content") or "")
        else:
            edits = ([args] if name == "edit_file" else
                     [e for e in (args.get("edits") or []) if isinstance(e, dict)])
            new = old
            for edit in edits:
                before, after = str(edit.get("old_string") or ""), str(edit.get("new_string") or "")
                if not before or before not in new:
                    return ""
                new = new.replace(before, after) if edit.get("replace_all") else new.replace(before, after, 1)
        if new == old:
            return ""
        lines = difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True),
                                     fromfile=f"a/{raw}", tofile=f"b/{raw}")
        return _cap_diff("".join(lines))
    except (OSError, UnicodeError, ValueError, TypeError):
        return ""


def split_diff(out: str) -> tuple[bool, str]:
    """If a tool's output contains a unified diff, return (True, diff_text); else (False, "")."""
    if "\n--- " in out or out.startswith("---"):
        i = out.find("---")
        if i != -1:
            return True, out[i:]
    return False, ""


def tool_output_is_error(out: str) -> bool:
    """Classify the canonical tool result formats for front-end status rendering."""
    text = str(out or "").lstrip()
    low = text.lower()
    if low.startswith(("error", "permission denied", "blocked by")):
        return True
    if low.startswith("exit code:"):
        first = low.splitlines()[0].partition(":")[2].strip()
        try:
            return int(first) != 0
        except ValueError:
            return True
    async_exit = re.match(r"\[[^]]+ · exited\s+(-?\d+)\]", low)
    if async_exit:
        return int(async_exit.group(1)) != 0
    return False
