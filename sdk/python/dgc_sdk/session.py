"""One isolated DGC session: at most one active run (plus follow-ups queued behind it)."""

from __future__ import annotations

import asyncio
import contextlib
import difflib
import inspect
import json
import logging
import os
import re
import stat
import threading
import time
import uuid
import weakref
from collections import deque
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, Callable, NamedTuple

from .wire.client import DGCClient, DGCClientError, DGCEventTimeout

from ._mcp_bridge import ToolHub
from .errors import (
    DGCCommandRejectedError, DGCConfigError, DGCRuntimeError, DGCTimeoutError, public_error,
)
from .schema import assert_supported, extract_json, validate as validate_schema
from .types import (
    AgentInfo, Artifact, Checkpoint, FileChange, Goal, HookInfo, McpInputRequest, McpInputResponse,
    McpServerInfo, Monitor, OnMcpInput, OnPermission, OnPlan, OnQuestion, PermissionAction,
    PermissionRequest, PermissionRule, PlanRequest, Question, QuestionAnswer, QuestionOption,
    QuestionRequest, RunEvent, RunResult, SandboxStatus, SessionInfo, SkillInfo, TaskItem,
    TaskStatus, ToolRecord, ToolSpec, VerificationResult,
)
from .usage import USAGE_TOTAL_KEYS, cost_usd, reported, usage_delta, usage_totals

log = logging.getLogger("dgc_sdk")

_LOOPBACK = re.compile(r"https?://(?:127\.0\.0\.1|localhost)(?::\d+)?/\S+", re.I)
# Control events left on the pipe after resume/fork/rewind. They must not be
# attributed to the next run.
_IDLE_EVENT_TYPES = frozenset({
    "history", "agents", "context", "goal_changed", "monitors", "info", "todos",
    "session", "session_named", "handoff_started", "ready", "config",
})
_TASK_MAP = {
    "done": "completed", "completed": "completed",
    "in_progress": "in_progress", "progress": "in_progress",
    "blocked": "blocked",
    "cancelled": "cancelled", "canceled": "cancelled",
    "pending": "pending", "todo": "pending",
}
_TERMINAL = frozenset({"completed", "cancelled", "failed", "blocked"})
_DECISION_EVENTS = frozenset({
    "permission_request", "plan_proposal", "options_request", "mcp_input_request",
})
_AUDIT_EVENTS = frozenset({
    "turn_start", "turn_end", "tool_call", "tool_result", "tool_denied", "permission_request",
    "error",
})
_SLICE_S = 0.5            # longest a pump waits on the pipe before re-checking deadlines
_CANCEL_GRACE_S = 10.0    # after a cancel, how long to wait for the turn to end
_TIMEOUT_GRACE_S = 5.0    # after a run timeout, how long to wait for the cancelled turn
_STEER_GRACE_S = 5.0      # after the last turn, how long to wait for a steer's outcome
_BILLING_WAIT_S = 2.0     # after the last turn, how long to wait for its usage totals
_VERIFY_STARTED = "⧗ verify:"


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


# ---- workspace changes -------------------------------------------------------------------------
# Only VCS metadata and dependency/tool caches are skipped. Everything else under the session cwd
# is reported, including dot-directories (.github), lockfiles and directories named home/ or
# locks/. The SDK's own state_dir (and, when inheriting user state, ~/.dgc) is skipped by
# absolute path when it lives under the cwd.
_CHANGE_SKIP_DIRS = frozenset({
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", ".mypy_cache",
    ".pytest_cache", ".ruff_cache",
})
_TEXT_LIMIT = 1_000_000           # bytes kept per file for before/after/diff
_SNAPSHOT_BUDGET = 64 * 1024 * 1024  # before-content kept per run


class _FileState(NamedTuple):
    mtime_ns: int
    size: int
    mode: int
    content: bytes | None


def _snapshot_workspace(root: Path | None, exclude: Sequence[Path] = (), *,
                        keep_content: bool = True) -> dict[str, _FileState]:
    """relpath -> state. Bounded to the session cwd, not a parent git tree. No symlink is read."""
    snap: dict[str, _FileState] = {}
    if root is None or not root.is_dir():
        return snap
    root = root.resolve()
    skip = {os.path.normcase(str(Path(item))) for item in exclude}
    budget = _SNAPSHOT_BUDGET if keep_content else 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [
            name for name in dirnames
            if name not in _CHANGE_SKIP_DIRS
            and os.path.normcase(os.path.join(dirpath, name)) not in skip
        ]
        rel_dir = Path(dirpath).relative_to(root)
        for name in filenames:
            path = os.path.join(dirpath, name)
            if os.path.normcase(path) in skip:
                continue
            try:
                info = os.lstat(path)
            except OSError:
                continue
            content = None
            if (budget > 0 and stat.S_ISREG(info.st_mode) and info.st_size <= _TEXT_LIMIT
                    and info.st_size <= budget):
                content = _read_regular(path)
                if content is not None:
                    budget -= len(content)
            rel = (rel_dir / name).as_posix() if rel_dir.parts else name
            snap[rel] = _FileState(info.st_mtime_ns, info.st_size, info.st_mode, content)
    return snap


def _read_regular(path: str) -> bytes | None:
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    try:
        with os.fdopen(fd, "rb") as handle:
            return handle.read(_TEXT_LIMIT + 1)[:_TEXT_LIMIT + 1]
    except OSError:
        return None


def _as_text(payload: bytes | None) -> str | None:
    if payload is None or len(payload) > _TEXT_LIMIT or b"\x00" in payload[:8192]:
        return None
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _split_lines(text: str) -> list[str]:
    parts = text.split("\n")
    lines = [part + "\n" for part in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


def _git_path(prefix: str, rel: str) -> str:
    path = f"{prefix}/{rel}"
    if any(ch in path for ch in ('"', "\\", "\t", "\n")) or any(ord(ch) < 32 for ch in path):
        escaped = (path.replace("\\", "\\\\").replace('"', '\\"')
                   .replace("\t", "\\t").replace("\n", "\\n"))
        return f'"{escaped}"'
    return path


def _file_mode(mode: int) -> str:
    return "100755" if mode & 0o111 else "100644"


def _unified_diff(rel: str, kind: str, before: str | None, after: str | None,
                  mode_before: int, mode_after: int) -> str:
    """A ``git apply``-able diff for one text file, or "" when either side is not text."""
    if (kind != "added" and before is None) or (kind != "deleted" and after is None):
        return ""
    old = _split_lines(before or "") if kind != "added" else []
    new = _split_lines(after or "") if kind != "deleted" else []
    a_name, b_name = _git_path("a", rel), _git_path("b", rel)
    header = [f"diff --git {a_name} {b_name}\n"]
    if kind == "added":
        header.append(f"new file mode {_file_mode(mode_after)}\n")
    elif kind == "deleted":
        header.append(f"deleted file mode {_file_mode(mode_before)}\n")
    elif _file_mode(mode_before) != _file_mode(mode_after):
        header.append(f"old mode {_file_mode(mode_before)}\nnew mode {_file_mode(mode_after)}\n")
    body: list[str] = []
    fromfile = "/dev/null" if kind == "added" else a_name
    tofile = "/dev/null" if kind == "deleted" else b_name
    for line in difflib.unified_diff(old, new, fromfile, tofile, n=3):
        body.append(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n")
    if not body and kind == "modified" and len(header) == 1:
        return ""
    return "".join(header + body)


def _diff_workspace(root: Path | None, before: dict[str, _FileState],
                    exclude: Sequence[Path] = ()) -> list[FileChange]:
    after = _snapshot_workspace(root, exclude, keep_content=False)
    root_s = str(root.resolve()) if root is not None else ""
    changes: list[FileChange] = []
    for rel in sorted(set(before) | set(after)):
        old, new = before.get(rel), after.get(rel)
        if new is None and old is not None:
            kind = "deleted"
        elif old is None and new is not None:
            kind = "added"
        elif old is not None and new is not None and (
                old.mtime_ns, old.size, old.mode) != (new.mtime_ns, new.size, new.mode):
            kind = "modified"
        else:
            continue
        old_mode = old.mode if old is not None else 0
        new_mode = new.mode if new is not None else 0
        after_bytes = None
        if new is not None and stat.S_ISREG(new_mode) and root is not None:
            after_bytes = _read_regular(str(root / rel))
        if kind == "modified" and old is not None and old.content is not None \
                and after_bytes == old.content and old_mode == new_mode:
            continue          # touched, not changed
        before_text = _as_text(old.content) if old is not None else ""
        after_text = _as_text(after_bytes) if new is not None else ""
        if kind == "added" and not stat.S_ISREG(new_mode):
            after_text = None
        diff = _unified_diff(rel, kind, before_text, after_text, old_mode, new_mode)
        changes.append(FileChange(path=rel, kind=kind, before=before_text or "",
                                  after=after_text or "", root=root_s, diff=diff))
    return changes


# ---- small parsers ------------------------------------------------------------------------------

def _parse_questions(raw: Any) -> tuple[Question, ...]:
    items: list[Question] = []
    if not isinstance(raw, list):
        return ()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        options = []
        for option in entry.get("options") or []:
            if isinstance(option, dict):
                options.append(QuestionOption(
                    label=str(option.get("label") or ""),
                    description=str(option.get("description") or ""),
                    recommended=bool(option.get("recommended")),
                ))
            elif isinstance(option, str):
                options.append(QuestionOption(label=option))
        items.append(Question(
            id=str(entry.get("id") or f"q{len(items)}"),
            question=str(entry.get("question") or entry.get("header") or ""),
            options=tuple(options),
            header=str(entry.get("header") or ""),
            multi_select=bool(entry.get("multi_select")),
        ))
    return tuple(items)


def _task_status(raw: Any) -> TaskStatus:
    mapped = _TASK_MAP.get(str(raw or "").strip().lower())
    return mapped or "pending"  # type: ignore[return-value]


def _document_urls(text: str) -> list[str]:
    return _LOOPBACK.findall(text or "")


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _goal_from_event(event: Mapping[str, Any]) -> Goal:
    details = _mapping(event.get("details"))
    status = str(event.get("status") or details.get("status") or "none")
    if status not in ("none", "active", "paused", "completed", "blocked"):
        status = "none"
    return Goal(
        text=str(event.get("goal") or details.get("text") or ""),
        status=status,  # type: ignore[arg-type]
        elapsed_seconds=int(event.get("elapsed_seconds") or details.get("elapsed_seconds") or 0),
        details=details,
    )


def _agent_from_row(row: Mapping[str, Any]) -> AgentInfo:
    parent = row.get("parent_id")
    return AgentInfo(
        id=str(row.get("id") or ""),
        state=str(row.get("state") or ""),
        description=str(row.get("description") or ""),
        parent_id=str(parent) if parent else None,
        model=str(row["model"]) if row.get("model") else None,
    )


def _exit_code(output: str) -> int | None:
    lowered = (output or "").lower()
    if "exit code:" not in lowered:
        return None
    try:
        return int(lowered.split("exit code:", 1)[1].split()[0])
    except (IndexError, ValueError):
        return None


def _same_command(left: str, right: str) -> bool:
    return " ".join(str(left or "").split()) == " ".join(str(right or "").split())


class _Run:
    """Pump-side state of one run. Outcome events for its prompt ids land here, whoever reads
    them off the pipe."""

    def __init__(self, result: RunResult, request_id: str):
        self.result = result
        self.request_id = request_id
        self.ids: set[str] = {request_id}          # prompt / steer / repair ids this run owns
        self.expect: set[str] = {request_id}       # ids whose turn has not started yet
        self.steers: set[str] = set()
        self.unresolved: set[str] = set()          # steers without an outcome yet
        self.returned: set[str] = set()            # prompts DGC handed back unrun
        self.rejected: dict[str, str] = {}         # prompt id -> backend reason
        self.accepted: set[str] = set()
        self.turn_ids: set[str] = set()
        self.started_ids: set[str] = set()         # prompt ids whose turn has started
        self.live_turn = ""                        # our turn in progress
        self.started = False                       # a turn of ours has started
        self.cancel_reason: str | None = None      # "cancelled" | "timeout" | "decision_failed"
        self.cancel_at = 0.0
        self.cancel_sent = False
        self.decision_error = ""
        self.usage = {key: 0 for key in USAGE_TOTAL_KEYS}
        self.billed = 0
        self.pending_bills = 0
        self.usage_unknown = False
        self.done = threading.Event()
        self.handle_ref: Callable[[], "RunHandle | None"] = lambda: None
        self.pump_started = False
        # This run changes DGC's config for its own turns (a per-run max_turns, or a schema
        # repair still to come), so a follow-up behind it must not start inside those turns.
        self.holds_followups = False
        # A follow-up the SDK keeps until the run in front of it is over, then sends.
        self.held = False


class _Turn(NamedTuple):
    id: str
    owner: _Run | None
    request_id: str


class _Completed:
    """An awaitable that is already done (lets a sync method also be awaited)."""

    __slots__ = ()

    def __await__(self):
        return
        yield  # pragma: no cover


class RunHandle:
    """Streaming handle. Iterate events, then call :meth:`result`. Cancel is run-scoped.

    Leaving a ``with`` block before the run finished cancels it and waits (bounded) for DGC to
    stop, so the session is free again. ``result()`` drains whatever was not iterated.
    """

    def __init__(self, session: "Session", run: _Run):
        self._session = session
        self._run = run
        self._result = run.result
        self._gen: Iterator[RunEvent | None] | None = None
        self._primed: deque[RunEvent] = deque()
        self._step_lock = threading.Lock()
        self._done = False
        run.handle_ref = weakref.ref(self)

    @property
    def run_id(self) -> str:
        return self._result.run_id

    @property
    def _consumed(self) -> bool:
        return self._done

    def _next_locked(self, *, idle: bool) -> RunEvent | None:
        if self._primed:
            return self._primed.popleft()
        if self._done or self._gen is None:
            self._done = True
            raise StopIteration
        try:
            while True:
                event = next(self._gen)
                if event is not None or idle:
                    return event
        except StopIteration:
            self._done = True
            raise
        except BaseException:
            self._done = True
            raise

    def _step(self, *, idle: bool = False) -> RunEvent | None:
        with self._step_lock:
            return self._next_locked(idle=idle)

    def _prime(self) -> None:
        """Run until the first event so the prompt has been sent when ``stream()`` returns."""
        with self._step_lock:
            try:
                event = self._next_locked(idle=True)
            except StopIteration:
                return
            if event is not None:
                self._primed.append(event)

    def __iter__(self) -> Iterator[RunEvent]:
        while True:
            try:
                event = self._step()
            except StopIteration:
                return
            if event is not None:
                yield event

    def result(self, timeout: float | None = None) -> RunResult:
        """Drain the run and return its result.

        Events nobody iterated are consumed here. If another thread is iterating, this waits
        for it between events. ``timeout`` (seconds) bounds this wait; ``None`` waits until the
        run ends, which the run's own ``timeout`` bounds. If the run is still going when it
        lapses, :class:`DGCTimeoutError` is raised; the run keeps going (call :meth:`cancel`
        to stop it).
        """
        deadline = None if timeout is None else time.monotonic() + max(0.0, float(timeout))
        while not self._done:
            wait = 0.1 if deadline is None else max(0.0, min(0.1, deadline - time.monotonic()))
            if self._step_lock.acquire(timeout=wait):
                try:
                    self._next_locked(idle=True)
                except StopIteration:
                    pass
                finally:
                    self._step_lock.release()
            if deadline is not None and time.monotonic() >= deadline and not self._done:
                raise DGCTimeoutError(
                    f"run {self._result.run_id} was still {self._result.status} after "
                    f"{float(timeout or 0):g}s")
        return self._result

    def cancel(self) -> None:
        self._session._cancel(self._run, "cancelled")

    def _abandon(self, timeout: float = 15.0) -> None:
        """Cancel if still going, then drain; used when the consumer went away."""
        if not self._done:
            try:
                self._session._cancel(self._run, "cancelled")
            except DGCRuntimeError:
                pass
            try:
                self.result(timeout=timeout)
            except Exception as exc:  # the transport may already be gone
                log.debug("draining an abandoned run failed: %s", exc)
        if not self._done:
            self._close()

    def _close(self) -> None:
        if self._step_lock.acquire(timeout=5.0):
            try:
                if self._gen is not None and not self._done:
                    close = getattr(self._gen, "close", None)
                    if callable(close):
                        close()
                self._done = True
            finally:
                self._step_lock.release()
        if not self._run.pump_started:
            self._session._forget(self._run)

    def __enter__(self) -> "RunHandle":
        return self

    def __exit__(self, *_exc: Any) -> None:
        if not self._done:
            self._abandon()


class Session:
    def __init__(
        self,
        client: DGCClient,
        ready: dict[str, Any],
        *,
        unhandled: str,
        on_permission: OnPermission | None,
        on_plan: OnPlan | None,
        on_question: OnQuestion | None,
        on_mcp_input: OnMcpInput | None = None,
        tools: Sequence[ToolSpec] = (),
        tool_hub: ToolHub | None = None,
        instructions: str = "",
        decision_timeout: float | None = 30.0,
        cwd: str | Path | None = None,
        policy: Any = None,
        pricing: Any = None,
        department: str = "",
        usage_log: Any = None,
        audit_log: Any = None,
        model: str = "",
        permission_mode: str = "default",
        state_dir: str | Path | None = None,
        isolated: bool = True,
        max_turns: int | None = None,
        verify_command: str = "",
        state_lock: Any = None,
        exclude_paths: Sequence[str | Path] = (),
        request_timeout: float | None = None,
        sandbox: SandboxStatus | None = None,
    ):
        if unhandled not in ("deny", "callback"):
            raise DGCConfigError("permissions.unhandled must be 'deny' or 'callback'")
        self._client = client
        self._ready = ready
        self._unhandled = unhandled
        self._on_permission = on_permission
        self._on_plan = on_plan
        self._on_question = on_question
        self._on_mcp_input = on_mcp_input
        self._tools = list(tools)
        self._tool_hub = tool_hub
        self._instructions = instructions
        self._cwd = Path(cwd).resolve() if cwd is not None else None
        self._policy = policy
        self._pricing = pricing
        self._department = department
        self._usage_log = usage_log
        self._audit_log = audit_log
        self._model = model
        self._model_seen = str(ready.get("model") or model or "")
        self._permission_mode = permission_mode or "default"
        self._decision_timeout = None if decision_timeout is None else max(0.05, float(decision_timeout))
        self._isolated = bool(isolated)
        self._session_max_turns = None if max_turns is None else int(max_turns)
        self._max_turns_dirty = False     # a run-scoped max_turns still in the child's config
        self._verify_command = str(verify_command or "")
        self._state_lock = state_lock
        excluded = [Path(item) for item in exclude_paths]
        if state_dir is not None:
            excluded.append(Path(state_dir))
        self._exclude = tuple(path.resolve() for path in excluded)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._answered_ids: set[str] = set()
        self._lock = threading.RLock()
        self._closed = False
        self._pending: deque[tuple[dict[str, Any], _Run | None, bool]] = deque()
        self._outstanding: set[str] = set()
        self._owners: dict[str, _Run] = {}
        self._run: _Run | None = None
        self._queued: deque[_Run] = deque()
        self._turn: _Turn | None = None
        self._usage_last: dict[str, int] | None = None
        self._bill_to: tuple[_Run | None, str] | None = None
        self._task_ids: dict[str, str] = {}
        self._task_revision = 0
        self._request_timeout = 15.0 if request_timeout is None else float(request_timeout)
        self.session_id = str(ready.get("session_id") or "")
        self.session_path = ""
        self.protocol_version = ready.get("protocol_version")
        self.capabilities = dict(ready.get("capabilities") or {})
        #: Whether this session's shell commands run inside the OS sandbox.
        self.sandbox: SandboxStatus = sandbox if sandbox is not None else SandboxStatus()

    @property
    def raw(self) -> DGCClient:
        """Advanced transport. Prefer :meth:`run` / :meth:`stream`."""
        return self._client

    @property
    def _busy(self) -> bool:
        with self._lock:
            return self._run is not None or bool(self._queued)

    def _set_callback_loop(self, loop: asyncio.AbstractEventLoop | None) -> None:
        """Coroutine callbacks run on this loop (set by :class:`AsyncDGC`)."""
        self._loop = loop

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        if self._tool_hub is not None:
            self._tool_hub.close()
        try:
            self._client.close()
        except Exception as exc:
            log.debug("closing the DGC transport failed: %s", exc)

    def __enter__(self) -> "Session":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    # ---- runs -----------------------------------------------------------------------------------

    def run(
        self,
        prompt: str,
        *,
        timeout: float | None = 180.0,
        max_turns: int | None = None,
        output_schema: Mapping[str, Any] | None = None,
        skills: Sequence[str] | None = None,
        workflow: str | None = None,
        repair_attempts: int = 1,
    ) -> RunResult:
        handle = self.stream(
            prompt, timeout=timeout, max_turns=max_turns, output_schema=output_schema,
            skills=skills, workflow=workflow, repair_attempts=repair_attempts,
        )
        return handle.result(timeout=None)

    def stream(
        self,
        prompt: str,
        *,
        timeout: float | None = 180.0,
        max_turns: int | None = None,
        output_schema: Mapping[str, Any] | None = None,
        skills: Sequence[str] | None = None,
        workflow: str | None = None,
        repair_attempts: int = 1,
    ) -> RunHandle:
        """Send ``prompt`` and return a handle over its events.

        ``timeout`` is seconds for each turn of the run (None: no limit). ``max_turns`` caps
        tool iterations for this run only; the session's own setting is restored afterwards.
        """
        if self._closed:
            raise DGCRuntimeError("this session is closed")
        if not isinstance(prompt, str) or not prompt.strip():
            raise DGCConfigError("prompt must be a non-empty string")
        if output_schema is not None:
            assert_supported(output_schema)
        _check_timeout(timeout)
        if max_turns is not None:
            if isinstance(max_turns, bool) or not isinstance(max_turns, int) or max_turns < 0:
                raise DGCConfigError("max_turns must be a non-negative integer")
            if not self._isolated:
                raise DGCConfigError(
                    "a per-run max_turns needs an isolated session: with inherit_user_state=True "
                    "DGC would save it into your own ~/.dgc/config.json")
        self._settle()
        with self._lock:
            idle = self._run is None and not self._queued
        if idle and self._max_turns_dirty:
            self._restore_max_turns()     # an abandoned run left its own max_turns behind
        with self._lock:
            if self._closed:
                raise DGCRuntimeError("this session is closed")
            if self._run is not None or self._queued:
                raise DGCConfigError("this session already has an active run")
            run = _Run(RunResult(session_id=self.session_id, run_id=_new_id("run"),
                                 status="running"), _new_id("req"))
            run.holds_followups = max_turns is not None or output_schema is not None
            self._run = run
            self._owners[run.request_id] = run
        handle = RunHandle(self, run)
        handle._gen = self._pump(
            run, prompt.strip(), timeout, max_turns, output_schema, skills, workflow,
            repair_attempts, send=True, prior=None,
        )
        handle._prime()
        return handle

    def followup(
        self,
        text: str,
        *,
        timeout: float | None = 180.0,
        output_schema: Mapping[str, Any] | None = None,
        skills: Sequence[str] | None = None,
        repair_attempts: int = 1,
    ) -> RunHandle:
        """Queue a prompt behind the active run and return a handle for its own turn.

        With no run in flight this is :meth:`stream`. A queued follow-up is observed, audited
        and billed like any run; iterate its handle or call ``result()`` once the run it is
        queued behind is done. A new ``stream()`` first waits for queued follow-ups.

        Behind a run with its own ``max_turns`` or ``output_schema``, the follow-up is sent
        when that run is over, so it runs under the session's own settings. A follow-up does
        not run when the run in front of it is cancelled or times out.
        """
        if not isinstance(text, str) or not text.strip():
            raise DGCConfigError("followup text must be a non-empty string")
        if output_schema is not None:
            assert_supported(output_schema)
        _check_timeout(timeout)
        with self._lock:
            if self._closed:
                raise DGCRuntimeError("this session is closed")
            prior = self._queued[-1] if self._queued else self._run
            if prior is None:
                queued = None
            else:
                queued = _Run(RunResult(session_id=self.session_id, run_id=_new_id("run"),
                                        status="queued"), _new_id("follow"))
                # DGC would start a queued prompt as soon as the turn in front of it ends: inside
                # that run's own max_turns, or ahead of its schema repair. Such a follow-up is
                # kept here and sent once the run in front of it is over.
                queued.held = prior.holds_followups or prior.held
                queued.holds_followups = output_schema is not None
                self._queued.append(queued)
                self._owners[queued.request_id] = queued
        if queued is None:
            return self.stream(text, timeout=timeout, output_schema=output_schema,
                               skills=skills, repair_attempts=repair_attempts)
        if not queued.held:
            payload: dict[str, Any] = {
                "type": "prompt", "text": self._compose_prompt(text.strip()),
                "delivery": "queue", "request_id": queued.request_id,
            }
            if skills:
                payload["skills"] = list(skills)
            try:
                self._client.send(payload)
            except DGCClientError as exc:
                self._forget(queued)
                raise DGCRuntimeError(str(exc)) from exc
        handle = RunHandle(self, queued)
        handle._gen = self._pump(
            queued, text.strip(), timeout, None, output_schema, skills, None, repair_attempts,
            send=queued.held, prior=prior,
        )
        # Keep the handle alive while it is queued so stream() can drain it.
        queued.handle_ref = _strong(handle)
        return handle

    def cancel(self) -> None:
        """Cancel the active run. DGC's stop also hands back prompts queued behind it."""
        with self._lock:
            run = self._run
        if run is None:
            try:
                self._client.send({"type": "cancel"})
            except DGCClientError as exc:
                raise DGCRuntimeError("could not cancel the run") from exc
            return
        self._cancel(run, "cancelled")

    def steer(self, text: str) -> None:
        """Add ``text`` to the run in flight. Raises unless a run is active.

        If DGC cannot fold it into the live turn, it runs as a further turn of the same run, so
        its tool calls are part of that run's result, audit and usage.
        """
        if not isinstance(text, str) or not text.strip():
            raise DGCConfigError("steer text must be a non-empty string")
        with self._lock:
            run = self._run
            if run is None or run.done.is_set() or run.cancel_reason:
                raise DGCConfigError("steer() needs an active run; use followup() or stream()")
            rid = _new_id("steer")
            run.ids.add(rid)
            run.steers.add(rid)
            run.unresolved.add(rid)
            self._owners[rid] = run
        try:
            self._client.send({
                "type": "prompt", "text": text.strip(), "delivery": "steer", "request_id": rid,
            })
        except DGCClientError as exc:
            with self._lock:
                run.unresolved.discard(rid)
            raise DGCRuntimeError(str(exc)) from exc

    def bind_identity(self) -> None:
        """Fill ``session_path`` once this session's own transcript exists.

        Only a transcript whose file name is this session's id is used; another session's
        transcript is never adopted.
        """
        if not self.session_id:
            return
        for info in self.list_sessions():
            if info.id == self.session_id:
                self.session_path = info.path
                return

    # ---- control requests -----------------------------------------------------------------------

    def list_sessions(self) -> list[SessionInfo]:
        event = self._request({"type": "list_sessions", "request_id": _new_id("sessions")},
                              "sessions")
        items: list[SessionInfo] = []
        for row in event.get("items") or []:
            if not isinstance(row, dict):
                continue
            path = str(row.get("path") or "")
            stem = Path(path).stem if path else ""
            items.append(SessionInfo(
                id=stem,
                path=path,
                name=str(row.get("name") or ""),
                preview=str(row.get("preview") or ""),
                message_count=int(row.get("count") or 0),
                when=str(row.get("when") or ""),
            ))
        return items

    def delete_session(self, path: str) -> list[SessionInfo]:
        event = self._request(
            {"type": "delete_session", "path": path, "request_id": _new_id("del")}, "sessions")
        items: list[SessionInfo] = []
        for row in event.get("items") or []:
            if isinstance(row, dict):
                p = str(row.get("path") or "")
                items.append(SessionInfo(id=Path(p).stem if p else "", path=p,
                                         name=str(row.get("name") or ""),
                                         preview=str(row.get("preview") or ""),
                                         message_count=int(row.get("count") or 0),
                                         when=str(row.get("when") or "")))
        return items

    def list_checkpoints(self) -> list[Checkpoint]:
        event = self._request({"type": "list_checkpoints", "request_id": _new_id("ck")},
                              "checkpoints")
        items: list[Checkpoint] = []
        for row in event.get("items") or []:
            if isinstance(row, dict):
                items.append(Checkpoint(
                    index=int(row.get("index") or 0),
                    preview=str(row.get("preview") or ""),
                    files=int(row.get("files") or 0),
                ))
        return items

    def rewind(self, index: int) -> dict[str, Any]:
        event = self._request({"type": "rewind", "index": int(index), "request_id": _new_id("rw")},
                              "rewound")
        self._discard_idle_events()
        return event

    def fork(self, name: str | None = None) -> dict[str, Any]:
        command: dict[str, Any] = {"type": "fork_session", "request_id": _new_id("fork")}
        if name:
            command["name"] = name
        event = self._request(command, "session")
        forked = str(event.get("session_id") or self.session_id)
        if event.get("path"):
            self.session_path = str(event.get("path"))
        elif forked != self.session_id:
            self.session_path = ""        # the parent's transcript is not the fork's
        self.session_id = forked
        self._discard_idle_events()
        if not self.session_path:
            with contextlib.suppress(DGCRuntimeError):
                self.bind_identity()
        return event

    def new_session(self) -> dict[str, Any]:
        event = self._request({"type": "new_session", "request_id": _new_id("new")}, "session")
        self.session_id = str(event.get("session_id") or self.session_id)
        self.session_path = str(event.get("path") or "")
        self._discard_idle_events()
        return event

    def name_session(self, name: str) -> dict[str, Any]:
        return self._request(
            {"type": "name_session", "name": name, "request_id": _new_id("name")}, "session_named")

    def history(self) -> dict[str, Any]:
        return self._request({"type": "get_history", "request_id": _new_id("hist")}, "history")

    def get_usage(self, range: str = "today") -> dict[str, Any]:
        return self._request({"type": "get_usage", "range": range, "request_id": _new_id("usage")},
                             "usage_report")

    def list_skills(self) -> list[SkillInfo]:
        event = self._request({"type": "list_skills", "request_id": _new_id("skills")},
                              "skill_catalog")
        items: list[SkillInfo] = []
        for row in event.get("items") or []:
            if not isinstance(row, dict):
                continue
            items.append(SkillInfo(
                name=str(row.get("name") or ""),
                description=str(row.get("description") or ""),
                source=str(row.get("source") or ""),
                enabled=row.get("enabled", True) is not False,
            ))
        return items

    def get_skill(self, name: str) -> dict[str, Any]:
        return self._request(
            {"type": "get_skill", "name": name, "request_id": _new_id("skill")}, "skill_detail")

    def set_skill_enabled(self, name: str, enabled: bool) -> dict[str, Any]:
        return self._request(
            {"type": "set_skill_enabled", "name": name, "enabled": bool(enabled),
             "request_id": _new_id("sken")}, "skill_catalog")

    def get_goal(self) -> Goal:
        event = self._request({"type": "get_goal", "request_id": _new_id("goal")}, "goal_changed")
        return _goal_from_event(event)

    def set_goal(self, text: str, *, status: str = "active",
                 token_budget: int | None = None, replace: bool = False) -> Goal:
        command: dict[str, Any] = {
            "type": "set_goal", "text": text, "status": status,
            "replace": bool(replace), "request_id": _new_id("setgoal"),
        }
        if token_budget is not None:
            command["token_budget"] = int(token_budget)
        event = self._request(command, "goal_changed")
        return _goal_from_event(event)

    def list_monitors(self) -> list[Monitor]:
        event = self._request({"type": "list_monitors", "request_id": _new_id("mon")}, "monitors")
        items: list[Monitor] = []
        for row in event.get("items") or []:
            if isinstance(row, dict):
                items.append(Monitor(
                    id=str(row.get("id") or ""),
                    description=str(row.get("description") or ""),
                    command=str(row.get("command") or ""),
                    state=str(row.get("state") or ""),
                    events=int(row.get("events") or 0),
                    persistent=bool(row.get("persistent")),
                ))
        return items

    def list_hooks(self) -> list[HookInfo]:
        event = self._request({"type": "list_hooks", "request_id": _new_id("hooks")},
                              "hook_catalog")
        items: list[HookInfo] = []
        for row in event.get("items") or []:
            if not isinstance(row, dict):
                continue
            matchers = tuple(str(item) for item in (row.get("matchers") or []) if item)
            items.append(HookInfo(
                event=str(row.get("event") or ""),
                configured=int(row.get("configured") or 0),
                matchers=matchers,
                valid=row.get("valid", True) is not False,
                truncated=bool(row.get("truncated")),
            ))
        return items

    def get_memory(self) -> dict[str, str]:
        event = self._request({"type": "get_memory", "request_id": _new_id("mem")}, "memory")
        return {
            "project": str(event.get("project") or ""),
            "user": str(event.get("user") or ""),
            "message": str(event.get("message") or ""),
        }

    def add_memory(self, text: str, *, scope: str = "project") -> dict[str, str]:
        if scope not in ("project", "user"):
            raise DGCConfigError("memory scope must be 'project' or 'user'")
        event = self._request(
            {"type": "add_memory", "text": text, "scope": scope, "request_id": _new_id("addmem")},
            "memory")
        return {
            "project": str(event.get("project") or ""),
            "user": str(event.get("user") or ""),
            "message": str(event.get("message") or ""),
        }

    def list_permissions(self) -> list[PermissionRule]:
        event = self._request({"type": "list_permissions", "request_id": _new_id("perms")},
                              "permissions")
        items: list[PermissionRule] = []
        for row in event.get("items") or []:
            if isinstance(row, dict):
                items.append(PermissionRule(action=str(row.get("action") or ""),
                                            rule=str(row.get("rule") or "")))
        return items

    def add_permission_rule(self, action: str, rule: str) -> list[PermissionRule]:
        if action not in ("allow", "ask", "deny"):
            raise DGCConfigError("permission action must be allow, ask, or deny")
        with self._config_scope():
            event = self._request(
                {"type": "add_permission_rule", "action": action, "rule": rule,
                 "request_id": _new_id("addperm")},
                "permissions")
        return [PermissionRule(action=str(row.get("action") or ""), rule=str(row.get("rule") or ""))
                for row in event.get("items") or [] if isinstance(row, dict)]

    def remove_permission_rule(self, action: str, rule: str) -> list[PermissionRule]:
        with self._config_scope():
            event = self._request(
                {"type": "remove_permission_rule", "action": action, "rule": rule,
                 "request_id": _new_id("rmperm")},
                "permissions")
        return [PermissionRule(action=str(row.get("action") or ""), rule=str(row.get("rule") or ""))
                for row in event.get("items") or [] if isinstance(row, dict)]

    def add_mcp_server(self, name: str, command: str, args: Sequence[str] | None = None) -> list[McpServerInfo]:
        runtime = {
            "transport": "stdio",
            "command": command,
            "args": list(args or []),
            "env": {},
            "env_names": [],
            "log_level": "warning",
        }
        with self._config_scope():
            event = self._request(
                {
                    "type": "upsert_mcp_server",
                    "request_id": _new_id("mcpadd"),
                    "name": name,
                    "runtime": runtime,
                    "persisted": {k: v for k, v in runtime.items() if k != "env"},
                },
                "mcp_servers",
                timeout=20.0,
            )
        items: list[McpServerInfo] = []
        for row in event.get("items") or []:
            if isinstance(row, dict):
                items.append(McpServerInfo(
                    name=str(row.get("name") or ""),
                    state=str(row.get("state") or ""),
                    enabled=row.get("enabled", True) is not False,
                    tool_count=int(row.get("tool_count") or 0),
                    error=str(row.get("error") or ""),
                ))
        return items

    def list_mcp_servers(self) -> list[McpServerInfo]:
        event = self._request({"type": "list_mcp_servers", "request_id": _new_id("mcp")},
                              "mcp_servers")
        items: list[McpServerInfo] = []
        for row in event.get("items") or []:
            if isinstance(row, dict):
                items.append(McpServerInfo(
                    name=str(row.get("name") or ""),
                    state=str(row.get("state") or ""),
                    enabled=row.get("enabled", True) is not False,
                    tool_count=int(row.get("tool_count") or 0),
                    error=str(row.get("error") or ""),
                ))
        return items

    def generate_handoff(self, *, save: bool = False) -> dict[str, Any]:
        return self._request(
            {"type": "generate_handoff", "save": bool(save), "request_id": _new_id("handoff")},
            "handoff")

    def stop_monitor(self, monitor_id: str = "all") -> list[Monitor]:
        event = self._request(
            {"type": "stop_monitor", "id": monitor_id, "request_id": _new_id("stopmon")},
            "monitors")
        return [Monitor(id=str(row.get("id") or ""),
                        description=str(row.get("description") or ""),
                        command=str(row.get("command") or ""),
                        state=str(row.get("state") or ""))
                for row in event.get("items") or [] if isinstance(row, dict)]

    def list_artifacts(self) -> list[Artifact]:
        event = self._request({"type": "list_artifacts", "request_id": _new_id("arts")},
                              "artifacts")
        items: list[Artifact] = []
        for row in event.get("items") or []:
            if isinstance(row, dict):
                items.append(Artifact(
                    id=str(row.get("id") or ""),
                    name=str(row.get("name") or ""),
                    url=str(row.get("url") or ""),
                    rel=str(row.get("rel") or row.get("path") or ""),
                ))
        return items

    def list_agents(self) -> list[AgentInfo]:
        event = self._request({"type": "list_agents", "request_id": _new_id("agents")}, "agents")
        return [_agent_from_row(row) for row in event.get("items") or [] if isinstance(row, dict)]

    def clear_todos(self) -> list[TaskItem]:
        # DGC acknowledges with the uncorrelated ``todos`` event every frontend hears.
        event = self._request({"type": "clear_todos", "request_id": _new_id("cleartodo")}, "todos",
                              uncorrelated_reply=True)
        self._task_ids.clear()
        self._task_revision += 1
        return self._project_tasks(event.get("todos") or [])

    def get_config(self) -> dict[str, Any]:
        return self._request({"type": "get_config", "request_id": _new_id("cfgget")}, "config")

    def get_plan(self) -> dict[str, Any]:
        return self._request({"type": "get_plan", "request_id": _new_id("plan")}, "saved_plan")

    def _config_scope(self) -> contextlib.AbstractContextManager[Any]:
        """Hold the state_dir lock around commands that make DGC save the isolated config."""
        lock = self._state_lock
        if lock is None or not self._isolated:
            return contextlib.nullcontext()
        return lock.hold()

    def _request(self, command: Mapping[str, Any], response_type: str,
                 timeout: float | None = None, *,
                 uncorrelated_reply: bool = False) -> dict[str, Any]:
        """Send one correlated command and wait for its answer (or its rejection).

        A run pump reading the pipe at the same time skips this request's events, so the answer
        cannot be lost to it. A refusal raises :class:`DGCCommandRejectedError` at once; no
        answer within ``timeout`` (at least the client's ``request_timeout``) raises
        :class:`DGCTimeoutError`.
        """
        payload = dict(command)
        rid = payload.get("request_id")
        if not isinstance(rid, str) or not rid:
            rid = _new_id("req")
            payload["request_id"] = rid
        wait = self._request_timeout if timeout is None else max(timeout, self._request_timeout)
        with self._lock:
            self._outstanding.add(rid)
        try:
            return self._client.request(payload, response_type, timeout=wait,
                                        uncorrelated_reply=uncorrelated_reply)
        except DGCClientError as exc:
            raise public_error(exc) from exc
        finally:
            with self._lock:
                self._outstanding.discard(rid)

    # ---- reading the pipe -----------------------------------------------------------------------

    def _takeable(self, event: Mapping[str, Any]) -> bool:
        rid = event.get("request_id")
        return not (isinstance(rid, str) and rid in self._outstanding)

    def _read(self, timeout: float) -> tuple[dict[str, Any], _Run | None, bool]:
        """Next event as (event, turn owner, inside a turn). Every event is observed once."""
        if self._pending:
            return self._pending.popleft()
        event = self._client.wait_for(None, predicate=self._takeable, timeout=max(0.01, timeout))
        owner, scoped = self._observe(event)
        return event, owner, scoped

    def _observe(self, event: dict[str, Any]) -> tuple[_Run | None, bool]:
        """Bookkeeping every event gets, whichever reader takes it: turn ownership, prompt
        outcomes, usage billing, the audit row, and identity."""
        kind = str(event.get("type") or "")
        rid = str(event.get("request_id") or "") if isinstance(event.get("request_id"), str) else ""
        owner: _Run | None = None
        scoped = False
        with self._lock:
            if kind == "turn_start":
                tid = str(event.get("turn_id") or "")
                owner = self._owners.get(rid) if rid else None
                if owner is None and not rid and str(event.get("kind") or "prompt") == "prompt":
                    owner = self._adoptable_locked()
                if owner is not None:
                    started = rid if rid else owner.request_id
                    owner.turn_ids.add(tid)
                    owner.started_ids.add(started)
                    owner.expect.discard(started)
                    owner.live_turn = tid
                    owner.started = True
                self._turn = _Turn(tid, owner, rid)
                scoped = True
            elif kind == "turn_end":
                tid = str(event.get("turn_id") or "")
                turn = self._turn
                if turn is not None and turn.id == tid:
                    owner = turn.owner
                    self._turn = None
                else:
                    owner = next((run for run in self._owners.values() if tid in run.turn_ids), None)
                if owner is not None:
                    owner.live_turn = ""
                    owner.pending_bills += 1
                self._bill_to = (owner, tid)
                scoped = True
            elif self._turn is not None and not rid:
                owner, scoped = self._turn.owner, True
            if kind == "context":
                self._account_locked(event)
            elif kind in ("prompt_accepted", "steering_update", "command_rejected", "error") and rid:
                self._note_outcome_locked(kind, rid, event)
            elif kind in ("model_changed", "config") and event.get("model"):
                self._model_seen = str(event.get("model"))
            elif kind == "session" and not rid:
                self.session_id = str(event.get("session_id") or self.session_id)
                if event.get("path"):
                    self.session_path = str(event.get("path"))
            if owner is not None:
                run_id = owner.result.run_id
            elif rid and rid in self._owners:
                run_id = self._owners[rid].result.run_id
            elif scoped:
                # A turn no run owns (a goal resume, a monitor wake, a late steer).
                turn_id = event.get("turn_id") or (self._turn.id if self._turn else "")
                run_id = f"turn-{turn_id}"
            else:
                run_id = self._run.result.run_id if self._run is not None else ""
        if self._audit_log is not None and kind in _AUDIT_EVENTS:
            try:
                payload = {k: event.get(k) for k in (
                    "name", "id", "reason", "summary", "path", "message", "is_error",
                    "args", "output", "diff", "command", "turn_id", "request_id", "call_id",
                ) if k in event and event.get(k) not in (None, "", {}, [])}
                self._audit_log.append(
                    self.session_id, run_id, kind, payload,
                    do_redact=not (self._policy and not self._policy.redact_events),
                )
            except Exception as exc:
                log.warning("dgc_sdk: could not write an audit row: %s", exc)
        return owner, scoped

    def _adoptable_locked(self) -> _Run | None:
        """A workflow prompt's turn carries no request id; give it to the run waiting for it.

        The SDK sends every other prompt with a request id, and goal/monitor/wake turns are a
        different ``kind``, so an unlabelled prompt turn can only be that workflow prompt.
        """
        run = self._run
        if run is not None and run.request_id in run.expect:
            return run
        return None

    def _note_outcome_locked(self, kind: str, rid: str, event: Mapping[str, Any]) -> None:
        run = self._owners.get(rid)
        if run is None:
            return
        state = str(event.get("state") or "")
        if kind == "prompt_accepted":
            run.accepted.add(rid)
            run.unresolved.discard(rid)
            if state in ("started", "queued") and rid in run.steers and rid not in run.started_ids:
                run.expect.add(rid)         # the steer became a turn of its own
        elif kind == "steering_update":
            run.unresolved.discard(rid)
            if state == "queued" and rid not in run.started_ids:
                run.expect.add(rid)         # not applied in time; DGC runs it as the next turn
            elif state == "returned":
                run.expect.discard(rid)
                run.returned.add(rid)
        else:
            run.unresolved.discard(rid)
            run.expect.discard(rid)
            run.rejected[rid] = str(event.get("message") or event.get("reason") or kind)

    def _account_locked(self, event: Mapping[str, Any]) -> None:
        totals = usage_totals(event)
        if totals is None:
            return
        bill, self._bill_to = self._bill_to, None
        if bill is not None:
            owner, tid = bill
            delta = usage_delta(self._usage_last, totals) if self._usage_last is not None else None
            if owner is not None:
                owner.pending_bills = max(0, owner.pending_bills - 1)
                owner.billed += 1
                if delta is None or not reported(delta):
                    owner.usage_unknown = True
                    if delta is not None:
                        # DGC still counted the requests; only their token usage is unknown.
                        owner.usage["requests"] += delta["requests"]
                else:
                    for key in USAGE_TOTAL_KEYS:
                        owner.usage[key] += delta[key]
            elif delta is not None and delta.get("requests") and self._usage_log is not None:
                # A turn no run owns (a goal resume, a late steer): its spend is still recorded.
                known = reported(delta)
                self._record_usage({
                    "run_id": f"turn-{tid}",
                    "status": "unowned",
                    **{key: (delta[key] if known or key == "requests" else None)
                       for key in USAGE_TOTAL_KEYS},
                })
        self._usage_last = totals

    def _discard_idle_events(self, timeout: float = 0.25) -> None:
        deadline = time.monotonic() + max(0.05, float(timeout))
        while time.monotonic() < deadline:
            remaining = max(0.02, deadline - time.monotonic())
            try:
                item = self._read(min(0.05, remaining))
            except DGCEventTimeout:
                return
            except DGCClientError:
                return
            if str(item[0].get("type") or "") in _IDLE_EVENT_TYPES:
                continue
            self._pending.appendleft(item)
            return

    # ---- cancellation ---------------------------------------------------------------------------

    def _cancel(self, run: _Run, reason: str) -> None:
        with self._lock:
            if run.done.is_set():
                return
            if not run.cancel_reason:
                run.cancel_reason = reason
            # A follow-up still queued behind another run is cancelled when its turn starts;
            # DGC's cancel would stop the run in front of it too.
            send = run is self._run and not run.cancel_sent
            if send:
                run.cancel_sent = True
                run.cancel_at = time.monotonic()
        if send:
            try:
                self._client.send({"type": "cancel"})
            except DGCClientError as exc:
                raise DGCRuntimeError("could not cancel the run") from exc

    def _forget(self, run: _Run) -> None:
        """Drop a queued run nobody will drive (its turn, if DGC runs it, is audited unowned)."""
        with self._lock:
            with contextlib.suppress(ValueError):
                self._queued.remove(run)
            for rid in list(run.ids):
                if self._owners.get(rid) is run:
                    del self._owners[rid]
            if self._run is run:
                self._run = None
            if run.result.status not in _TERMINAL:
                run.result.status = "cancelled"
                run.result.reason = "cancelled"
            run.done.set()

    def _settle(self) -> None:
        """Before a new run: let a cancelled run wind down and drain queued follow-ups."""
        with self._lock:
            run = self._run
        if run is not None and run.cancel_reason and not run.done.is_set():
            handle = run.handle_ref()
            if handle is not None:
                handle._abandon(timeout=_CANCEL_GRACE_S + 5.0)
            else:
                run.done.wait(_CANCEL_GRACE_S + 5.0)
        while True:
            with self._lock:
                if self._run is not None and not self._run.done.is_set():
                    return
                queued = self._queued[0] if self._queued else None
            if queued is None:
                return
            handle = queued.handle_ref()
            if handle is None:
                self._forget(queued)
                continue
            handle.result(timeout=None)
            if not queued.done.is_set():
                self._forget(queued)

    # ---- the pump -------------------------------------------------------------------------------

    def _compose_prompt(self, prompt: str) -> str:
        if not self._instructions.strip():
            return prompt
        return (
            "<application-instructions>\n"
            f"{self._instructions.strip()}\n"
            "</application-instructions>\n\n"
            f"{prompt}"
        )

    def _set_run_max_turns(self, value: int) -> None:
        """Apply a run-scoped max_turns; DGC persists set_config, so it is restored after."""
        deadline = time.monotonic() + 5.0
        while True:
            try:
                with self._config_scope():
                    self._request({"type": "set_config", "values": {"max_turns": int(value)},
                                   "request_id": _new_id("cfg")}, "config")
                return
            except DGCCommandRejectedError as exc:
                if exc.reason == "turn_in_progress" and time.monotonic() < deadline:
                    time.sleep(0.1)
                    continue
                raise

    def _restore_max_turns(self) -> None:
        try:
            self._set_run_max_turns(self._session_max_turns or 0)
            self._max_turns_dirty = False
        except DGCRuntimeError as exc:
            log.warning("dgc_sdk: could not restore the session max_turns: %s", exc)

    def _send_prompt(self, run: _Run, text: str, skills: Sequence[str] | None,
                     workflow: str | None, request_id: str) -> None:
        payload: dict[str, Any] = {"type": "prompt", "text": text, "request_id": request_id}
        if skills:
            payload["skills"] = list(skills)
        if workflow:
            payload["workflow"] = workflow
        with self._lock:
            run.ids.add(request_id)
            run.expect.add(request_id)
            self._owners[request_id] = run
        self._client.send(payload)

    def _pump(
        self,
        run: _Run,
        prompt: str,
        timeout: float | None,
        max_turns: int | None,
        output_schema: Mapping[str, Any] | None,
        skills: Sequence[str] | None,
        workflow: str | None,
        repair_attempts: int,
        *,
        send: bool,
        prior: _Run | None,
    ) -> Iterator[RunEvent | None]:
        result = run.result
        acc = _Accumulator(result)
        abandoned = False
        scoped = False
        before: dict[str, _FileState] = {}
        try:
            run.pump_started = True
            if prior is not None:
                prior_handle = prior.handle_ref()
                if prior_handle is not None:
                    prior_handle.result(timeout=None)
                prior.done.wait(_CANCEL_GRACE_S + 5.0)
                with self._lock:
                    with contextlib.suppress(ValueError):
                        self._queued.remove(run)
                    if self._run is None or self._run.done.is_set():
                        self._run = run
                    result.status = "running"
            before = _snapshot_workspace(self._cwd, self._exclude)
            if run.held and (run.cancel_reason or (prior is not None and (
                    prior.cancel_reason or prior.result.status == "cancelled"))):
                # DGC hands queued prompts back when the run in front of them is stopped; a
                # follow-up the SDK held does the same and never runs.
                acc.cancel()
                if run.cancel_reason != "cancelled":
                    acc.error = "DGC stopped before this queued prompt ran"
                self._finish(run, acc, before)
                return
            if send:
                if max_turns is not None:
                    self._max_turns_dirty = True
                    self._set_run_max_turns(max_turns)
                    scoped = True
                self._send_prompt(run, self._compose_prompt(prompt), skills, workflow,
                                  run.request_id)
            yield from self._turns(run, acc, timeout, repairing=False)
            if output_schema is not None and acc.status == "completed":
                self._apply_schema(result, output_schema, acc)
                attempts = max(0, int(repair_attempts))
                while result.output is None and attempts > 0 and acc.status == "completed" \
                        and not run.cancel_reason:
                    attempts -= 1
                    repair_prompt = (
                        "Return only valid JSON matching this schema. Do not call tools. "
                        "Do not edit files.\n"
                        f"{json.dumps(dict(output_schema), ensure_ascii=False)}\n"
                        f"Previous errors: {acc.error or 'the last answer was not valid JSON'}"
                    )
                    acc.error = None
                    if self._isolated:
                        try:
                            self._max_turns_dirty = True
                            self._set_run_max_turns(1)
                            scoped = True
                        except DGCRuntimeError as exc:
                            log.warning("dgc_sdk: repair runs without a turn cap: %s", exc)
                    repair_id = _new_id("repair")
                    self._send_prompt(run, repair_prompt, None, None, repair_id)
                    yield from self._turns(run, acc, timeout, repairing=True)
                    if acc.status == "completed":
                        self._apply_schema(result, output_schema, acc)
            if scoped:
                scoped = False
                self._restore_max_turns()
            self._finish(run, acc, before)
        except GeneratorExit:
            abandoned = True
            if not run.done.is_set() and result.status not in _TERMINAL:
                with contextlib.suppress(DGCRuntimeError):
                    self._cancel(run, "cancelled")
                result.status = "cancelled"
                result.reason = "cancelled"
            raise
        except DGCClientError as exc:
            result.status = "cancelled" if run.cancel_reason == "cancelled" else "failed"
            result.reason = "cancelled" if run.cancel_reason == "cancelled" else "transport"
            result.error = None if run.cancel_reason == "cancelled" else str(exc)
        finally:
            if scoped and not abandoned:
                self._restore_max_turns()
            if result.status not in _TERMINAL:
                result.status = "failed"
                result.reason = result.reason or "error"
            with self._lock:
                if self._run is run:
                    self._run = None
                with contextlib.suppress(ValueError):
                    self._queued.remove(run)
                for rid in list(run.ids):
                    if self._owners.get(rid) is run:
                        del self._owners[rid]
                run.done.set()

    def _turns(self, run: _Run, acc: "_Accumulator", timeout: float | None, *,
               repairing: bool) -> Iterator[RunEvent | None]:
        """Pump events until every turn this run owns has ended.

        ``None`` is yielded while nothing arrives, so a caller can check its own deadline.
        """
        result = run.result
        deadline = None if timeout is None else time.monotonic() + float(timeout)
        grace: float | None = None     # after our last turn: waiting for a steer's outcome
        ended_any = False
        while True:
            now = time.monotonic()
            with self._lock:
                rejected = None if ended_any else run.rejected.get(run.request_id)
                returned = run.request_id in run.returned and not run.started
            if rejected is not None:
                if run.cancel_reason == "cancelled":
                    acc.cancel()
                else:
                    acc.fail("rejected", rejected)
                return
            if returned:
                acc.cancel()
                acc.error = "DGC stopped before this queued prompt ran"
                return
            if run.cancel_reason and not run.cancel_sent:
                with contextlib.suppress(DGCRuntimeError):
                    self._cancel(run, run.cancel_reason)
            if deadline is not None and now >= deadline and not run.cancel_reason:
                acc.timeout_s = float(timeout or 0)
                acc.partial()
                with contextlib.suppress(DGCRuntimeError):
                    self._cancel(run, "timeout")
            if run.cancel_sent:
                limit = _TIMEOUT_GRACE_S if run.cancel_reason == "timeout" else _CANCEL_GRACE_S
                if now - run.cancel_at >= limit:
                    acc.stopped(run, timeout)
                    return
            if grace is not None:
                state = self._completion(run)
                if state == "done" or (state == "steer" and now >= grace):
                    return
                if state == "turn":
                    grace = None
            wait = _SLICE_S
            if deadline is not None and not run.cancel_reason:
                wait = max(0.01, min(wait, deadline - now))
            try:
                event, owner, scoped = self._read(wait)
            except DGCEventTimeout:
                yield None
                continue
            except DGCClientError as exc:
                acc.transport(run, exc)
                return
            kind = str(event.get("type") or "")
            if kind == "ready":
                continue
            mine = scoped and owner is run
            if scoped and not mine and kind not in _DECISION_EVENTS:
                continue      # a turn this run does not own: observed and audited, not reported
            if not scoped or mine:
                yield RunEvent(
                    type=kind, data=event, session_id=self.session_id, run_id=result.run_id,
                    request_id=event.get("request_id") if isinstance(event.get("request_id"), str)
                    else run.request_id,
                )
            if kind in _DECISION_EVENTS:
                # A decision blocks DGC whoever's turn it is, so it is always answered.
                self._answer(run, event, kind, repairing=repairing, mine=mine or not scoped)
                continue
            if not mine:
                if kind in ("context", "artifact_ready", "agent_started", "agent_ended"):
                    acc.take(kind, event, self)
                continue
            if kind == "turn_end":
                ended_any = True
                acc.end_turn(event)
                if run.cancel_reason:
                    return
                state = self._completion(run)
                if state == "done":
                    return
                if state == "steer":
                    grace = time.monotonic() + _STEER_GRACE_S
                continue
            acc.take(kind, event, self)
            if kind == "error" and event.get("fatal"):
                acc.fatal_error(run, event)
                return

    def _completion(self, run: _Run) -> str:
        """After a turn of ours ended: ``turn`` (another is expected), ``steer`` (a steer's
        outcome is unknown yet) or ``done``."""
        with self._lock:
            if run.expect:
                return "turn"
            if run.unresolved:
                return "steer"
        return "done"

    def _await_billing(self, run: _Run) -> None:
        """The usage totals for a turn arrive right after its ``turn_end``."""
        deadline = time.monotonic() + _BILLING_WAIT_S
        held: list[tuple[dict[str, Any], _Run | None, bool]] = []
        try:
            while run.pending_bills > 0 and time.monotonic() < deadline:
                try:
                    item = self._read(max(0.01, min(0.2, deadline - time.monotonic())))
                except DGCEventTimeout:
                    continue
                except DGCClientError:
                    return
                if item[0].get("type") != "context":
                    held.append(item)
        finally:
            self._pending.extendleft(reversed(held))

    def _finish(self, run: _Run, acc: "_Accumulator", before: dict[str, _FileState]) -> None:
        result = run.result
        if run.pending_bills:
            self._await_billing(run)
        status = acc.settle(run)
        result.changes = _diff_workspace(self._cwd, before, self._exclude)
        result.verification = acc.verification(self._verify_command)
        self._finish_usage(run, acc, status)
        if not self.session_path:
            try:
                self.bind_identity()
            except DGCRuntimeError as exc:
                log.debug("could not bind the session transcript yet: %s", exc)
        result.status = status  # type: ignore[assignment]  # last: terminal means complete

    def _apply_schema(self, result: RunResult, schema: Mapping[str, Any],
                      acc: "_Accumulator") -> None:
        try:
            parsed = extract_json(result.final_text)
        except (ValueError, json.JSONDecodeError) as exc:
            acc.error = f"output_schema: {exc}"
            result.output = None
            return
        problems = validate_schema(parsed, schema)
        if problems:
            acc.error = "output_schema: " + "; ".join(problems[:8])
            result.output = None
            return
        result.output = parsed
        acc.error = None

    def _project_tasks(self, rows: Any) -> list[TaskItem]:
        self._task_revision += 1
        items: list[TaskItem] = []
        seen: dict[str, str] = {}
        if not isinstance(rows, list):
            return items
        for row in rows:
            if not isinstance(row, dict):
                continue
            content = str(row.get("content") or row.get("text") or "")
            key = content.strip().lower()
            tid = str(row.get("id") or self._task_ids.get(key) or f"task-{uuid.uuid4().hex[:10]}")
            if key:
                seen[key] = tid
                self._task_ids[key] = tid
            items.append(TaskItem(
                id=tid, content=content, status=_task_status(row.get("status")),
                revision=self._task_revision,
            ))
        self._task_ids = {key: value for key, value in self._task_ids.items() if key in seen}
        return items

    def _collect_changes(self) -> list[FileChange]:
        return _diff_workspace(self._cwd, _snapshot_workspace(self._cwd, self._exclude),
                               self._exclude)

    def _record_usage(self, row: Mapping[str, Any]) -> None:
        if self._usage_log is None:
            return
        payload = {
            "session_id": self.session_id,
            "department": self._department,
            "model": self._model_seen or self._model,
            **dict(row),
        }
        try:
            self._usage_log.record(payload)
        except Exception as exc:
            log.warning("dgc_sdk: could not record usage: %s", exc)

    def _finish_usage(self, run: _Run, acc: "_Accumulator", status: str) -> None:
        result = run.result
        usage = dict(acc.usage)
        known = run.billed > 0 and not run.usage_unknown
        for key in USAGE_TOTAL_KEYS:
            if key == "requests":
                usage[key] = run.usage[key] if run.billed else None
            else:
                usage[key] = run.usage[key] if known else None
        dollars = cost_usd(usage["input_tokens"], usage["output_tokens"],
                           usage["cached_input_tokens"], self._pricing) if known else None
        usage["cost_usd"] = dollars
        usage["usage_known"] = known
        usage["department"] = self._department
        usage["model"] = self._model_seen or self._model
        result.usage = usage
        self._record_usage({
            "session_id": result.session_id or self.session_id,
            "run_id": result.run_id,
            "status": status,
            **{key: usage[key] for key in USAGE_TOTAL_KEYS},
            "token_estimate": usage.get("token_estimate"),
            "cost_usd": dollars,
        })

    # ---- decisions ------------------------------------------------------------------------------

    def _answer(self, run: _Run, event: dict[str, Any], kind: str, *, repairing: bool,
                mine: bool) -> None:
        run.result.status = "waiting_for_approval" if mine else run.result.status
        try:
            if kind == "permission_request":
                if run.cancel_reason or repairing:
                    action = "deny"
                else:
                    action = self._permission(run, event, mine=mine)
                self._respond({"type": "permission_response", "id": event["id"],
                               "decision": action}, run)
            elif kind == "plan_proposal":
                decision = "reject" if repairing or run.cancel_reason else self._plan(run, event, mine)
                self._respond({"type": "plan_response", "id": event["id"],
                               "decision": decision}, run)
            elif kind == "options_request":
                self._answer_options(run, event, mine)
            elif kind == "mcp_input_request":
                self._answer_mcp(run, event, mine)
        finally:
            if mine and run.result.status == "waiting_for_approval":
                run.result.status = "running"
        if mine and run.decision_error and self._unhandled == "callback" and not run.cancel_reason:
            with contextlib.suppress(DGCRuntimeError):
                self._cancel(run, "decision_failed")

    def _respond(self, command: Mapping[str, Any], run: _Run) -> None:
        try:
            self._client.send(dict(command))
        except DGCClientError:
            if not run.cancel_reason:
                raise

    def _decide(self, run: _Run, callback: Callable[[Any], Any] | None, request: Any,
                default: Any, *, label: str, valid: Callable[[Any], bool], mine: bool) -> Any:
        """Ask an application callback (sync or async) on a worker thread.

        ``decision_timeout=None`` waits as long as the callback takes; a cancel always wins. A
        callback that raises, times out, or returns an invalid answer gets ``default``; with
        ``permissions={"unhandled": "callback"}`` that also stops the run.
        """
        key = getattr(request, "id", "") or ""
        if key:
            with self._lock:
                if key in self._answered_ids:
                    return default
                self._answered_ids.add(key)
        if callback is None:
            return default
        box: list[Any] = []
        errors: list[BaseException] = []
        futures: list[Any] = []

        def worker() -> None:
            try:
                value = callback(request)
                if inspect.isawaitable(value):
                    value = self._await_callback(value, futures)
                box.append(value)
            except BaseException as exc:  # noqa: BLE001 - reported below, never raised into DGC
                errors.append(exc)

        thread = threading.Thread(target=worker, daemon=True, name=f"dgc-sdk-{label}")
        thread.start()
        deadline = None if self._decision_timeout is None else time.monotonic() + self._decision_timeout
        while thread.is_alive():
            if run.cancel_reason:
                self._drop_futures(futures)
                return default
            if deadline is not None and time.monotonic() >= deadline:
                break
            thread.join(0.05)
        problem = ""
        if thread.is_alive():
            self._drop_futures(futures)
            problem = f"{label} did not answer within {self._decision_timeout:g}s"
        elif errors:
            problem = f"{label} raised {type(errors[0]).__name__}: {errors[0]}"
        elif not box or not valid(box[0]):
            problem = f"{label} returned an invalid answer: {box[0] if box else None!r}"
        if problem:
            log.warning("dgc_sdk: %s; answering %r", problem, default)
            if mine and not run.decision_error:
                run.decision_error = problem
            return default
        return box[0]

    def _await_callback(self, awaitable: Any, futures: list[Any]) -> Any:
        loop = self._loop
        if loop is not None and loop.is_running() and not loop.is_closed():
            future = asyncio.run_coroutine_threadsafe(_as_coroutine(awaitable), loop)
            futures.append(future)
            return future.result()
        return asyncio.run(_as_coroutine(awaitable))

    @staticmethod
    def _drop_futures(futures: list[Any]) -> None:
        for future in futures:
            with contextlib.suppress(Exception):
                future.cancel()

    def _permission(self, run: _Run, event: dict[str, Any], *, mine: bool) -> PermissionAction:
        request = PermissionRequest(
            id=str(event.get("id") or ""),
            name=str(event.get("name") or ""),
            args=_mapping(event.get("args")),
            summary=str(event.get("summary") or ""),
            suggested_rule=str(event.get("suggested_rule") or ""),
            call_id=event.get("call_id") if isinstance(event.get("call_id"), str) else None,
            diff=event.get("diff") if isinstance(event.get("diff"), str) else None,
            command=event.get("command") if isinstance(event.get("command"), str) else None,
        )
        from .policy import resolve_permission
        # Policy denies (tools, paths) are final; command screening defers to a reviewing
        # callback so staff see the Bash ask; policy-checked reads are answered here.
        return resolve_permission(
            self._policy, request, cwd=self._cwd, permission_mode=self._permission_mode,
            on_permission=self._on_permission,
            ask=lambda: self._decide(
                run, self._on_permission, request, "deny", label="on_permission",
                valid=lambda value: value in ("once", "always", "deny"), mine=mine))

    def _plan(self, run: _Run, event: dict[str, Any], mine: bool) -> str:
        request = PlanRequest(
            id=str(event.get("id") or ""),
            plan=str(event.get("plan") or ""),
            choices=tuple(str(item) for item in (event.get("choices") or [])
                          if isinstance(item, str)),
        )
        choices = ("auto", "acceptEdits", "default", "reject")
        decision = self._decide(run, self._on_plan, request, "reject", label="on_plan",
                                valid=lambda value: value in choices, mine=mine)
        return decision if decision in choices else "reject"

    def _answer_options(self, run: _Run, event: dict[str, Any], mine: bool) -> None:
        request = QuestionRequest(
            id=str(event.get("id") or ""),
            questions=_parse_questions(event.get("questions")),
            call_id=event.get("call_id") if isinstance(event.get("call_id"), str) else None,
        )
        answer: Any = "dismiss"
        if self._on_question is not None and not run.cancel_reason:
            answer = self._decide(
                run, self._on_question, request, "dismiss", label="on_question",
                valid=lambda value: value == "dismiss" or isinstance(value, Mapping), mine=mine)
        payload: dict[str, Any] = {}
        if isinstance(answer, Mapping):
            for qid, value in answer.items():
                if isinstance(value, QuestionAnswer):
                    payload[str(qid)] = {"selected": list(value.selected), "other": value.other}
                elif isinstance(value, dict):
                    payload[str(qid)] = value
        if not payload:
            self._respond({"type": "options_response", "id": request.id, "dismissed": True}, run)
            return
        self._respond({"type": "options_response", "id": request.id, "answers": payload}, run)

    def _answer_mcp(self, run: _Run, event: dict[str, Any], mine: bool) -> None:
        request = McpInputRequest(
            id=str(event.get("id") or ""),
            server=str(event.get("server") or ""),
            kind=str(event.get("kind") or ""),
            payload=_mapping(event.get("payload")),
        )
        response: Any = None
        if self._on_mcp_input is not None and not run.cancel_reason:
            response = self._decide(
                run, self._on_mcp_input, request, None, label="on_mcp_input",
                valid=lambda value: isinstance(value, McpInputResponse)
                and value.action in ("accept", "decline", "cancel"), mine=mine)
        action = response.action if isinstance(response, McpInputResponse) else "cancel"
        payload: dict[str, Any] = {"type": "mcp_input_response", "id": request.id, "action": action}
        if isinstance(response, McpInputResponse) and response.content:
            payload["content"] = dict(response.content)
        self._respond(payload, run)


def _strong(handle: RunHandle) -> Callable[[], RunHandle | None]:
    return lambda: handle


async def _as_coroutine(awaitable: Any) -> Any:
    return await awaitable


def _check_timeout(timeout: float | None) -> None:
    if timeout is None:
        return
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not timeout > 0 \
            or timeout != timeout or timeout == float("inf"):
        raise DGCConfigError("timeout must be a positive number of seconds, or None")


class _Accumulator:
    """What one run collects from the turns it owns."""

    def __init__(self, result: RunResult):
        self.result = result
        self.tools: dict[str, ToolRecord] = {}
        self.text: list[str] = []
        self.blocks: dict[str, str] = {}
        self.answer_ids: list[str] = []
        self.artifacts: dict[str, Artifact] = {item.id: item for item in result.artifacts}
        self.documents: dict[str, Artifact] = {item.id: item for item in result.documents}
        self.tasks: list[TaskItem] = list(result.tasks)
        self.agents: dict[str, AgentInfo] = {item.id: item for item in result.agents}
        self.usage: dict[str, Any] = {}
        self.status = "running"
        self.reason = ""
        self.error: str | None = None
        self.fatal = False
        self.timeout_s = 0.0             # the run's timeout, once it was reached
        self.last_error = ""
        self.turn_final = ""
        self.verify_calls: set[str] = set()
        self.verify_model: VerificationResult | None = None
        self.verify_cli: str = ""          # "", "ran", "failed"
        self.verify_cli_message = ""
        self.verify_order = 0
        self.verify_model_order = -1
        self.verify_cli_order = -1

    # events -------------------------------------------------------------------------------------

    def take(self, kind: str, event: Mapping[str, Any], session: Session) -> None:
        if kind == "text_delta":
            self.text.append(str(event.get("text") or ""))
        elif kind == "stream_end":
            message_id = str(event.get("message_id") or "")
            block = "".join(self.text)
            self.text.clear()
            if message_id:
                self.blocks[message_id] = block
                if event.get("phase") == "answer":
                    self.answer_ids.append(message_id)
        elif kind == "tool_call":
            call_id = str(event.get("call_id") or "")
            args = _mapping(event.get("args"))
            name = str(event.get("name") or "")
            self.tools[call_id] = ToolRecord(name=name, call_id=call_id,
                                             summary=str(event.get("summary") or ""), args=args)
            if name == "bash" and session._verify_command and _same_command(
                    str(args.get("command") or ""), session._verify_command):
                self.verify_calls.add(call_id)
        elif kind == "tool_result":
            call_id = str(event.get("call_id") or "")
            record = self.tools.get(call_id) or ToolRecord(
                name=str(event.get("name") or ""), call_id=call_id)
            output = event.get("output")
            if output is None:
                output = event.get("result") or event.get("content") or ""
            output = output if isinstance(output, str) else json.dumps(output, default=str)
            if not output and record.summary:
                output = record.summary
            record = ToolRecord(
                name=record.name or str(event.get("name") or ""),
                call_id=call_id,
                summary=record.summary,
                output=output,
                is_error=bool(event.get("is_error")),
                is_diff=bool(event.get("is_diff")),
                diff=event.get("diff") if isinstance(event.get("diff"), str) else None,
                args=record.args,
            )
            self.tools[call_id] = record
            if call_id in self.verify_calls:
                code = _exit_code(output)
                ok = (not record.is_error) if code is None else code == 0
                self.verify_model = VerificationResult(
                    ok=ok, command=session._verify_command, output=output[:8000], exit_code=code)
                self.verify_order += 1
                self.verify_model_order = self.verify_order
            if record.name == "present_document":
                for index, url in enumerate(_document_urls(output)):
                    doc = Artifact(
                        id=f"{call_id or 'doc'}-{index}",
                        name="document" if index == 0 else "document.md",
                        url=url,
                    )
                    self.documents[doc.id] = doc
        elif kind == "tool_denied":
            call_id = str(event.get("call_id") or "")
            self.tools[call_id] = ToolRecord(
                name=str(event.get("name") or ""),
                call_id=call_id,
                output=str(event.get("reason") or "denied"),
                is_error=True,
            )
        elif kind == "artifact_ready":
            art = Artifact(
                id=str(event.get("id") or ""),
                name=str(event.get("name") or ""),
                url=str(event.get("url") or ""),
                rel=str(event.get("rel") or ""),
            )
            self.artifacts[art.id] = art
            if art.url.startswith("http://127.0.0.1") or art.url.startswith("http://localhost"):
                self.documents[art.id] = art
        elif kind == "todos":
            self.tasks = session._project_tasks(event.get("todos") or [])
        elif kind in ("agent_started", "agent_ended"):
            info = _agent_from_row(event)
            if info.id:
                self.agents[info.id] = info
        elif kind == "context":
            if isinstance(event.get("used"), int):
                self.usage["context_used"] = event["used"]
            if isinstance(event.get("size"), int):
                self.usage["context_size"] = event["size"]
        elif kind == "info":
            self._note_verifier(str(event.get("message") or ""), session._verify_command)
        elif kind == "error":
            message = str(event.get("message") or "")
            if message:
                self.last_error = message
            self._note_verifier(message, session._verify_command)

    def _note_verifier(self, message: str, command: str) -> None:
        if not command or not message:
            return
        text = message.strip()
        if text.startswith(_VERIFY_STARTED):
            self.verify_order += 1
            self.verify_cli_order = self.verify_order
            self.verify_cli = "ran"
            self.verify_cli_message = ""
        elif "configured verifier" in text and self.verify_cli and any(
                word in text for word in ("failed", "still failing", "did not pass")):
            self.verify_cli = "failed"
            self.verify_cli_message = text

    def end_turn(self, event: Mapping[str, Any]) -> None:
        reason = str(event.get("reason") or "completed")
        self.reason = reason
        final_id = event.get("final_message_id")
        if isinstance(final_id, str) and final_id in self.blocks:
            final = self.blocks[final_id]
        elif self.answer_ids and self.answer_ids[-1] in self.blocks:
            final = self.blocks[self.answer_ids[-1]]
        else:
            final = "".join(self.blocks.values()) or "".join(self.text)
        self.result.final_text = final
        self.blocks.clear()
        self.answer_ids.clear()
        self.text.clear()
        if isinstance(event.get("token_estimate"), int):
            self.usage["token_estimate"] = event["token_estimate"]
        if reason in ("error", "failed"):
            self.status = "failed"
            self.error = self.last_error or "the turn ended with an error"
        elif reason in ("cancelled", "interrupted"):
            self.status = "cancelled"
        else:
            self.status = "completed"
        self.last_error = ""

    def fail(self, reason: str, message: str) -> None:
        self.status = "failed"
        self.reason = reason
        self.error = message

    def cancel(self) -> None:
        self.status = "cancelled"
        self.reason = "cancelled"

    def partial(self) -> None:
        self.result.partial_text = "".join(self.text) or "".join(self.blocks.values())

    def stopped(self, run: _Run, timeout: float | None) -> None:
        """A cancel or timeout whose turn never reported its end within the grace period."""
        self.partial()
        if run.cancel_reason == "timeout":
            self.fail("timeout", f"run exceeded its {float(timeout or 0):g}s timeout")
        elif run.cancel_reason == "decision_failed":
            self.fail("decision_failed", run.decision_error or "a decision callback failed")
        else:
            self.cancel()

    def transport(self, run: _Run, exc: BaseException) -> None:
        self.partial()
        if run.cancel_reason == "cancelled":
            self.cancel()
        else:
            self.fail("transport", str(exc))

    def fatal_error(self, run: _Run, event: Mapping[str, Any]) -> None:
        self.partial()
        self.fatal = True
        if run.cancel_reason == "cancelled":
            self.cancel()
        else:
            self.fail("runtime", str(event.get("message") or "fatal backend error"))

    def settle(self, run: _Run) -> str:
        """Fill the run's result and return its final status (the caller publishes it last)."""
        result = self.result
        result.tools = list(self.tools.values())
        result.artifacts = list(self.artifacts.values())
        result.documents = list(self.documents.values())
        result.tasks = self.tasks
        result.agents = list(self.agents.values())
        status, reason, error = self.status, self.reason, self.error
        if run.cancel_reason == "timeout":
            status, reason = "failed", "timeout"
            error = error if error and "timeout" in error else (
                f"run exceeded its {self.timeout_s:g}s timeout" if self.timeout_s
                else "run exceeded its timeout")
            result.partial_text = result.partial_text or result.final_text
        elif run.cancel_reason == "decision_failed":
            status, reason = "failed", "decision_failed"
            error = run.decision_error or "a decision callback failed"
            result.partial_text = result.partial_text or result.final_text
        elif run.cancel_reason == "cancelled" or status == "cancelled":
            status, reason, error = "cancelled", "cancelled", None
            result.partial_text = result.partial_text or result.final_text
        elif status == "running":
            status, reason = "failed", reason or "error"
            error = error or "the run ended without a result"
        result.error = error
        result.reason = reason or status
        result.usage = dict(self.usage)
        return status

    def verification(self, command: str) -> VerificationResult | None:
        """Evidence about the configured verify_command, never about an unrelated command.

        DGC's own verify-before-done gate reports only that it ran and when it failed; a turn
        that then completes passed its last check (exit 0), but DGC does not report its output.
        """
        command = (command or "").strip()
        if not command:
            return None
        if self.verify_cli and self.verify_cli_order > self.verify_model_order:
            if self.verify_cli == "failed":
                return VerificationResult(ok=False, command=command, output=self.verify_cli_message)
            if self.status == "completed" and self.reason == "completed":
                return VerificationResult(ok=True, command=command, exit_code=0)
            return VerificationResult(ok=None, command=command)
        if self.verify_model is not None:
            return self.verify_model
        return VerificationResult(ok=None, command=command)
