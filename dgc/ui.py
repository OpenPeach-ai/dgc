"""The AgentUI seam — the single contract every front-end implements.

`Agent` (agent.py) talks to the outside world through exactly one injected object, `self.ui`.
Nothing in the agent core imports a concrete UI, so the terminal REPL (cli.py) and the headless
JSON backend (headless.py) are just two implementations of the protocol below. This module
documents that contract and holds the small formatters both implementations share.

Two optional hooks sit outside the Protocol body (so every existing UI stays valid) and are looked
up with ``getattr``:

``model_wait(label, detail="", *, since=None, restore=True, origin=None)``
    The stall watcher (dgc/model_watch.py) saw a model request go silent. ``label`` names it
    ("No response from the model", "Loading the model", "The model stopped streaming", "Retrying
    the model request"), ``since`` is the ``time.monotonic()`` when the silence began, and
    ``label=None`` means output resumed or the call ended. ``restore=False`` on a clear means the
    call ended in an error, a cancel or a stall, so the activity the notice replaced should not
    come back. ``origin`` is None for the main agent and a per-child token for a sub-agent, so
    parallel children keep separate notices. It is called from the watcher's own thread. The
    Agent passes only the keyword options a hook declares, so the original three-argument form
    still works. Without the hook the Agent falls back to
    ``turn_activity("waiting", label, detail)``.

``callback_route()``
    Called on the agent's worker thread; returns ``run(fn)`` that invokes ``fn`` as if on that
    thread's UI session. A multi-session front end (the TUI) needs it so a watcher-thread notice
    lands on the session that made the request.

0.40 adds the optional hooks declared at the end of the Protocol body below. The Agent looks each
one up with ``getattr`` and skips a UI that lacks it, so every existing implementation stays valid.
"""
from __future__ import annotations

import re
from typing import Protocol, runtime_checkable


@runtime_checkable
class AgentUI(Protocol):
    # streaming (agent → front-end) --------------------------------------------
    def on_text(self, chunk: str) -> None: ...
    # ``block`` (0.40, thinking provenance) describes the reasoning block the chunk belongs to:
    # its key, source (raw | summarized | narration | withheld | unknown), provider and sub-agent.
    # None from a caller that does not know; a UI must accept both forms.
    def on_thinking(self, chunk: str, block=None) -> None: ...
    # ``phase`` is the backend's own classification of the prose block just closed:
    # "commentary" when the same model round also called tools, "answer" when it did not.
    # Optional on purpose -- every existing implementation stays valid, and an empty phase
    # means "undetermined", which front-ends must treat as their pre-existing behaviour.
    def end_stream(self, phase: str = "") -> None: ...
    # What the loop is doing right now. Front-ends that show a running-turn verb read this
    # instead of inferring one; the ones that do not simply ignore it.
    def turn_activity(self, state: str, label: str, detail: str = "") -> None: ...
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
    def add_permission_rule(self, name: str, args: dict) -> str | None: ...
    plan_feedback: str                                             # one-shot rejection steer
    def present_plan(self, plan: str): ...                          # mode str | None
    # MCP server input is a separate, always-consent-gated channel. ``kind`` is one of
    # elicitation | sampling_request | sampling_response; implementations return an action dict.
    def mcp_capabilities(self) -> dict: ...
    def mcp_input(self, server: str, kind: str, payload: dict, *, cancel=None) -> dict: ...
    # notices ------------------------------------------------------------------
    def info(self, message: str) -> None: ...
    def error(self, message: str) -> None: ...
    # 0.40 optional hooks (looked up with getattr; a UI may omit any of them) ----------------
    # A reasoning block closed (thinking provenance).
    def on_thinking_end(self, block) -> None: ...
    # Images a tool step produced for the model to view. ``items`` describes each image (ref, name,
    # mime, width, height, bytes, source, host); ``omitted`` counts images past the per-step cap;
    # ``meta`` carries front-end-only detail such as the store path (viewed images).
    def tool_images(self, call_id, images: list, caption: str = "", *, items=None,
                    omitted: int = 0, meta=None) -> None: ...
    # One retry run of a model request: state retrying | recovered | gave_up | cancelled, with the
    # model_retry protocol fields as keywords (reconnecting).
    def model_retry(self, state: str, **fields) -> None: ...
    # Ask the user 1-4 normalised questions (dgc/questions.py shape) and return the decision
    # {"outcome": answered | dismissed | cancelled | unavailable, "answers": {id: {selected, other}}}.
    def ask_questions(self, questions: list[dict], call_id=None) -> dict: ...
    # How a question request ended: answered | dismissed | cancelled | unavailable.
    def options_resolved(self, call_id, outcome, questions, answers) -> None: ...


# ---- shared formatters (used by both the REPL and the JSON backend) ----------

# The present-tense verb a running tool earns in the activity row. Deliberately the same
# vocabulary the TUI status line already uses, so both surfaces name a step the same way.
_ACTIVITY_VERBS = {
    "bash": "Running a command", "bash_output": "Reading command output",
    "read_file": "Reading a file", "write_file": "Writing a file", "edit_file": "Editing a file",
    "view_image": "Viewing an image",
    "multi_edit": "Editing a file", "apply_patch": "Applying a patch", "grep": "Searching",
    "glob": "Finding files", "ls": "Listing files", "repo_map": "Mapping the repo",
    "code_intel": "Reading code structure", "web_search": "Searching the web",
    "web_fetch": "Fetching a page", "todo": "Updating the plan", "task": "Delegating a task",
    "skill": "Reading a skill", "present_plan": "Presenting the plan",
    "propose_options": "Asking a question",
    "memory": "Updating memory", "artifact": "Building an artifact",
    "monitor": "Starting a monitor", "monitor_stop": "Stopping a monitor",
}


def activity_verb(name: str) -> str:
    """A present-tense label for what the named tool is doing, for the activity row."""
    key = str(name or "")
    if key in _ACTIVITY_VERBS:
        return _ACTIVITY_VERBS[key]
    if key.startswith("mcp_") or key.startswith("mcp__"):
        return "Using an integration"
    return "Running " + (key or "a tool")


def arg_summary(name: str, args: dict) -> str:
    """A one-line human summary of a tool call's primary argument."""
    if name == "propose_options" and isinstance(args, dict):
        from .questions import args_summary
        value = args_summary(args).replace("\n", " ")
        return value[:120] + ("…" if len(value) > 120 else "")
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
