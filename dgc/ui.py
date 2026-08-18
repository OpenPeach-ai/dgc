"""The AgentUI seam — the single contract every front-end implements.

`Agent` (agent.py) talks to the outside world through exactly one injected object, `self.ui`.
Nothing in the agent core imports a concrete UI, so the terminal REPL (cli.py) and the headless
JSON backend (headless.py) are just two implementations of the protocol below. This module
documents that contract and holds the small formatters both implementations share.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class AgentUI(Protocol):
    # streaming (agent → front-end) --------------------------------------------
    def on_text(self, chunk: str) -> None: ...
    def on_thinking(self, chunk: str) -> None: ...
    def end_stream(self) -> None: ...
    # tool lifecycle -----------------------------------------------------------
    def tool_call(self, name: str, args: dict) -> None: ...
    def tool_result(self, name: str, out: str) -> None: ...
    def tool_denied(self, name: str, args: dict, reason: str) -> None: ...
    def on_todo(self, todos: list) -> None: ...
    # blocking decisions (front-end answers) -----------------------------------
    def approve(self, name: str, args: dict) -> str: ...            # 'once' | 'always' | 'no'
    def add_permission_rule(self, name: str, args: dict) -> None: ...
    def present_plan(self, plan: str): ...                          # mode str | None
    def propose_options(self, question: str, options: list) -> str: ...
    # notices ------------------------------------------------------------------
    def info(self, message: str) -> None: ...
    def error(self, message: str) -> None: ...


# ---- shared formatters (used by both the REPL and the JSON backend) ----------

def arg_summary(name: str, args: dict) -> str:
    """A one-line human summary of a tool call's primary argument."""
    for key in ("path", "command", "pattern", "url", "name", "memory"):
        if key in args:
            value = str(args[key]).replace("\n", " ")
            return value[:120] + ("…" if len(value) > 120 else "")
    return ""


def split_diff(out: str) -> tuple[bool, str]:
    """If a tool's output contains a unified diff, return (True, diff_text); else (False, "")."""
    if "\n--- " in out or out.startswith("---"):
        i = out.find("---")
        if i != -1:
            return True, out[i:]
    return False, ""
