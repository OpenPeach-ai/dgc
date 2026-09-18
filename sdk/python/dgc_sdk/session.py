"""One isolated DGC session: at most one active run."""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from collections import deque
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

from .wire.client import DGCClient, DGCClientError, DGCEventTimeout

from ._mcp_bridge import ToolHub
from .errors import DGCConfigError, DGCRuntimeError, DGCTimeoutError
from .schema import assert_supported, extract_json, validate as validate_schema
from .types import (
    AgentInfo, Artifact, Checkpoint, FileChange, Goal, HookInfo, McpInputRequest, McpInputResponse,
    McpServerInfo, Monitor, OnMcpInput, OnPermission, OnPlan, OnQuestion, PermissionAction,
    PermissionRequest, PermissionRule, PlanRequest, Question, QuestionAnswer, QuestionOption,
    QuestionRequest, RunEvent, RunResult, SessionInfo, SkillInfo, TaskItem, TaskStatus,
    ToolRecord, ToolSpec, VerificationResult,
)

_LOOPBACK = re.compile(r"https?://(?:127\.0\.0\.1|localhost)(?::\d+)?/\S+", re.I)
# Control events left on the pipe after resume/fork/rewind. They must not be
# attributed to the next run.
_IDLE_EVENT_TYPES = frozenset({
    "history", "agents", "context", "goal_changed", "monitors", "info", "todos",
    "session", "session_named", "handoff_started",
})
_TASK_MAP = {
    "done": "completed", "completed": "completed",
    "in_progress": "in_progress", "progress": "in_progress",
    "blocked": "blocked",
    "cancelled": "cancelled", "canceled": "cancelled",
    "pending": "pending", "todo": "pending",
}


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


_CHANGE_SKIP_DIRS = frozenset({
    ".git", ".dgc", "node_modules", "__pycache__", ".venv", "home", "locks",
})
_CHANGE_SKIP_SUFFIXES = (".sqlite", ".sqlite-wal", ".sqlite-shm", ".lock")


def _ignore_rel(rel: Path) -> bool:
    if any(part in _CHANGE_SKIP_DIRS for part in rel.parts):
        return True
    name = rel.name
    return name.endswith(_CHANGE_SKIP_SUFFIXES)


def _snapshot_workspace(root: Path | None) -> dict[str, tuple[int, int]]:
    """relpath -> (mtime_ns, size). Bounded to the session cwd, not a parent git tree."""
    snap: dict[str, tuple[int, int]] = {}
    if root is None or not root.is_dir():
        return snap
    root = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = Path(dirpath).resolve().relative_to(root)
        dirnames[:] = [name for name in dirnames
                       if name not in _CHANGE_SKIP_DIRS and not name.startswith(".")]
        for name in filenames:
            rel = rel_dir / name if rel_dir.parts else Path(name)
            if _ignore_rel(rel):
                continue
            path = Path(dirpath) / name
            try:
                stat = path.stat()
            except OSError:
                continue
            snap[rel.as_posix()] = (stat.st_mtime_ns, stat.st_size)
    return snap


def _diff_workspace(root: Path | None, before: dict[str, tuple[int, int]]) -> list[FileChange]:
    after = _snapshot_workspace(root)
    root_s = str(root) if root is not None else ""
    changes: list[FileChange] = []
    for rel in sorted(set(before) | set(after)):
        if rel not in after:
            changes.append(FileChange(path=rel, kind="deleted", root=root_s))
            continue
        if rel not in before:
            kind = "added"
        elif before[rel] != after[rel]:
            kind = "modified"
        else:
            continue
        text = ""
        if root is not None:
            try:
                payload = (root / rel).read_bytes()
                if len(payload) <= 64_000 and b"\x00" not in payload[:1024]:
                    text = payload.decode("utf-8", errors="replace")
            except OSError:
                text = ""
        changes.append(FileChange(path=rel, kind=kind, after=text, root=root_s))
    return changes


def _prime(iterator: Iterator[RunEvent]) -> Iterator[RunEvent]:
    """Run until the first yield so ``stream()`` has already sent the prompt."""
    try:
        first = next(iterator)
    except StopIteration:
        return iterator

    def chained() -> Iterator[RunEvent]:
        yield first
        yield from iterator

    return chained()


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
    return mapped or "pending"


def _document_urls(text: str) -> list[str]:
    return _LOOPBACK.findall(text or "")


def _goal_from_event(event: Mapping[str, Any]) -> Goal:
    details = event.get("details") if isinstance(event.get("details"), dict) else {}
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


class RunHandle:
    """Streaming handle. Iterate events, then call :meth:`result`. Cancel is run-scoped."""

    def __init__(self, session: "Session", iterator: Iterator[RunEvent], result: RunResult):
        self._session = session
        self._iterator = iterator
        self._result = result
        self._consumed = False

    def __iter__(self) -> Iterator[RunEvent]:
        self._consumed = True
        self._iter_thread = threading.current_thread()
        return self._iterator

    def result(self, timeout: float | None = 180.0) -> RunResult:
        terminal = frozenset({"completed", "cancelled", "failed", "blocked"})
        owner = getattr(self, "_iter_thread", None)
        same_thread = owner is None or owner is threading.current_thread()
        if same_thread:
            for _ in self._iterator:
                pass
            self._consumed = True
            return self._result
        deadline = time.monotonic() + (180.0 if timeout is None else float(timeout))
        while self._result.status not in terminal and time.monotonic() < deadline:
            time.sleep(0.05)
        return self._result

    def cancel(self) -> None:
        self._session._cancel_run()

    def __enter__(self) -> "RunHandle":
        return self

    def __exit__(self, *_exc) -> None:
        if not self._consumed:
            try:
                self.cancel()
            except DGCClientError:
                pass
            try:
                self.result()
            except Exception:
                pass


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
        policy=None,
        pricing=None,
        department: str = "",
        usage_log=None,
        audit_log=None,
        model: str = "",
        permission_mode: str = "default",
    ):
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
        self._permission_mode = permission_mode or "default"
        self._decision_timeout = None if decision_timeout is None else max(0.05, float(decision_timeout))
        self._answered_ids: set[str] = set()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._busy = False
        self._closed = False
        self._pending: deque[dict[str, Any]] = deque()
        self._task_ids: dict[str, str] = {}
        self._task_revision = 0
        self._verify_command = ""
        self.session_id = str(ready.get("session_id") or "")
        self.session_path = ""
        self.protocol_version = ready.get("protocol_version")
        self.capabilities = dict(ready.get("capabilities") or {})

    @property
    def raw(self) -> DGCClient:
        """Advanced transport. Prefer :meth:`run` / :meth:`stream`."""
        return self._client

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        if self._tool_hub is not None:
            self._tool_hub.close()
        try:
            self._client.close()
        except Exception:
            pass

    def __enter__(self) -> "Session":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

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
        return handle.result()

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
        if self._closed:
            raise DGCRuntimeError("this session is closed")
        if not isinstance(prompt, str) or not prompt.strip():
            raise DGCConfigError("prompt must be a non-empty string")
        if output_schema is not None:
            assert_supported(output_schema)
        with self._lock:
            if self._busy:
                raise DGCConfigError("this session already has an active run")
            self._busy = True
            self._stop.clear()
        result = RunResult(session_id=self.session_id, run_id=_new_id("run"), status="running")
        iterator = self._pump(
            prompt.strip(), result, timeout, max_turns, output_schema, skills, workflow,
            repair_attempts,
        )
        return RunHandle(self, _prime(iterator), result)

    def cancel(self) -> None:
        self._cancel_run()

    def steer(self, text: str) -> None:
        """Inject into the live turn. No-op unless a run is in flight."""
        if not isinstance(text, str) or not text.strip():
            raise DGCConfigError("steer text must be a non-empty string")
        try:
            self._client.send({
                "type": "prompt", "text": text.strip(), "delivery": "steer",
                "request_id": _new_id("steer"),
            })
        except DGCClientError as exc:
            raise DGCRuntimeError(str(exc)) from exc

    def followup(self, text: str) -> None:
        """Queue a prompt behind the active run."""
        if not isinstance(text, str) or not text.strip():
            raise DGCConfigError("followup text must be a non-empty string")
        try:
            self._client.send({
                "type": "prompt", "text": text.strip(), "delivery": "queue",
                "request_id": _new_id("follow"),
            })
        except DGCClientError as exc:
            raise DGCRuntimeError(str(exc)) from exc

    def bind_identity(self) -> None:
        """Fill ``session_path`` from the runtime listing once a transcript exists."""
        for info in self.list_sessions():
            if info.id == self.session_id or (
                    self.session_id and info.path.rstrip("/").endswith(self.session_id + ".json")):
                self.session_path = info.path
                if info.id:
                    self.session_id = info.id
                return
        if not self.session_path:
            listing = self.list_sessions()
            if listing:
                self.session_path = listing[0].path
                self.session_id = listing[0].id or self.session_id

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
        self.session_id = str(event.get("session_id") or self.session_id)
        self.session_path = str(event.get("path") or self.session_path)
        self._discard_idle_events()
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
        event = self._request(
            {"type": "add_permission_rule", "action": action, "rule": rule,
             "request_id": _new_id("addperm")},
            "permissions")
        return [PermissionRule(action=str(row.get("action") or ""), rule=str(row.get("rule") or ""))
                for row in event.get("items") or [] if isinstance(row, dict)]

    def remove_permission_rule(self, action: str, rule: str) -> list[PermissionRule]:
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
        event = self._request({"type": "clear_todos", "request_id": _new_id("cleartodo")}, "todos")
        self._task_ids.clear()
        self._task_revision += 1
        return self._project_tasks(event.get("todos") or [])

    def get_config(self) -> dict[str, Any]:
        return self._request({"type": "get_config", "request_id": _new_id("cfgget")}, "config")

    def get_plan(self) -> dict[str, Any]:
        return self._request({"type": "get_plan", "request_id": _new_id("plan")}, "saved_plan")

    def _request(self, command: Mapping[str, Any], response_type: str,
                 timeout: float = 15.0) -> dict[str, Any]:
        try:
            return self._client.request(dict(command), response_type, timeout=timeout)
        except DGCEventTimeout as exc:
            raise DGCTimeoutError(str(exc)) from exc
        except DGCClientError as exc:
            raise DGCRuntimeError(str(exc)) from exc

    def _next_event(self, timeout: float | None) -> dict[str, Any]:
        if self._pending:
            return self._pending.popleft()
        return self._client.next_event(timeout=timeout)

    def _discard_idle_events(self, timeout: float = 0.25) -> None:
        deadline = time.monotonic() + max(0.05, float(timeout))
        while time.monotonic() < deadline:
            remaining = max(0.02, deadline - time.monotonic())
            try:
                event = self._client.next_event(timeout=min(0.05, remaining))
            except DGCEventTimeout:
                return
            except DGCClientError:
                return
            kind = str(event.get("type") or "")
            if kind in _IDLE_EVENT_TYPES:
                continue
            self._pending.append(event)
            return

    def _discard_stale_run_events(self, timeout: float = 0.4) -> None:
        """Drop leftover turn traffic so the next run does not inherit a prior cancel."""
        stale = _IDLE_EVENT_TYPES | {
            "turn_end", "turn_start", "text_delta", "stream_end", "tool_call", "tool_result",
            "tool_denied", "error", "command_rejected", "request_expired", "steering_update",
            "prompt_accepted",
        }
        deadline = time.monotonic() + max(0.05, float(timeout))
        while time.monotonic() < deadline:
            remaining = max(0.02, deadline - time.monotonic())
            try:
                event = self._client.next_event(timeout=min(0.05, remaining))
            except DGCEventTimeout:
                return
            except DGCClientError:
                return
            kind = str(event.get("type") or "")
            if kind in stale:
                continue
            self._pending.append(event)
            return

    def _cancel_run(self) -> None:
        self._stop.set()
        try:
            self._client.send({"type": "cancel"})
        except DGCClientError as exc:
            raise DGCRuntimeError("could not cancel the run") from exc

    def _compose_prompt(self, prompt: str) -> str:
        if not self._instructions.strip():
            return prompt
        return (
            "<application-instructions>\n"
            f"{self._instructions.strip()}\n"
            "</application-instructions>\n\n"
            f"{prompt}"
        )

    def _pump(
        self,
        prompt: str,
        result: RunResult,
        timeout: float | None,
        max_turns: int | None,
        output_schema: Mapping[str, Any] | None,
        skills: Sequence[str] | None,
        workflow: str | None,
        repair_attempts: int,
    ) -> Iterator[RunEvent]:
        try:
            yield from self._run_once(
                prompt, result, timeout, max_turns, skills, workflow, repairing=False)
            if output_schema is not None and result.status == "completed":
                self._apply_schema(result, output_schema)
                attempts = max(0, int(repair_attempts))
                while result.output is None and attempts > 0 and result.status == "completed":
                    attempts -= 1
                    repair_prompt = (
                        "Return only valid JSON matching this schema. Do not call tools. "
                        "Do not edit files.\n"
                        f"{json.dumps(dict(output_schema), ensure_ascii=False)}\n"
                        f"Previous errors: {result.error or 'the last answer was not valid JSON'}"
                    )
                    result.status = "running"
                    result.error = None
                    yield from self._run_once(
                        repair_prompt, result, timeout, 1, None, None, repairing=True)
                    if result.status == "completed":
                        self._apply_schema(result, output_schema)
        finally:
            self._discard_stale_run_events()
            with self._lock:
                self._busy = False

    def _apply_schema(self, result: RunResult, schema: Mapping[str, Any]) -> None:
        try:
            parsed = extract_json(result.final_text)
        except (ValueError, json.JSONDecodeError) as exc:
            result.error = f"output_schema: {exc}"
            result.output = None
            return
        problems = validate_schema(parsed, schema)
        if problems:
            result.error = "output_schema: " + "; ".join(problems[:8])
            result.output = None
            return
        result.output = parsed
        result.error = None

    def _run_once(
        self,
        prompt: str,
        result: RunResult,
        timeout: float | None,
        max_turns: int | None,
        skills: Sequence[str] | None,
        workflow: str | None,
        *,
        repairing: bool,
    ) -> Iterator[RunEvent]:
        deadline = None if timeout is None else time.monotonic() + float(timeout)
        request_id = _new_id("req")
        tools: dict[str, ToolRecord] = {}
        text_buf: list[str] = []
        blocks: dict[str, str] = {}
        answer_ids: list[str] = []
        artifacts: dict[str, Artifact] = {item.id: item for item in result.artifacts}
        documents: dict[str, Artifact] = {item.id: item for item in result.documents}
        tasks: list[TaskItem] = list(result.tasks)
        agents: dict[str, AgentInfo] = {item.id: item for item in result.agents}
        usage: dict[str, Any] = dict(result.usage)
        timed_out = False
        live_turn_id = ""
        before = _snapshot_workspace(self._cwd)
        try:
            self._discard_stale_run_events(timeout=0.2)
            if max_turns is not None:
                try:
                    self._client.send({
                        "type": "set_config",
                        "values": {"max_turns": int(max_turns)},
                        "request_id": _new_id("cfg"),
                    })
                except DGCClientError:
                    pass
            payload: dict[str, Any] = {
                "type": "prompt",
                "text": self._compose_prompt(prompt) if not repairing else prompt,
                "request_id": request_id,
            }
            if skills:
                payload["skills"] = list(skills)
            if workflow:
                payload["workflow"] = workflow
            self._client.send(payload)
            while True:
                if deadline is not None and time.monotonic() >= deadline:
                    if not timed_out:
                        timed_out = True
                        result.reason = "timeout"
                        result.error = "run exceeded timeoutMs"
                        result.partial_text = "".join(text_buf) or "".join(blocks.values())
                        try:
                            self._cancel_run()
                        except DGCRuntimeError:
                            pass
                        deadline = time.monotonic() + 5.0
                        continue
                    result.status = "failed"
                    result.partial_text = "".join(text_buf) or "".join(blocks.values())
                    break
                remaining = None if deadline is None else max(0.05, deadline - time.monotonic())
                try:
                    event = self._next_event(timeout=remaining)
                except DGCEventTimeout as exc:
                    self._cancel_run()
                    result.status = "cancelled" if self._stop.is_set() else "failed"
                    result.reason = "cancelled" if self._stop.is_set() else "timeout"
                    result.error = None if self._stop.is_set() else str(exc)
                    result.partial_text = "".join(text_buf) or "".join(blocks.values())
                    break
                except DGCClientError as exc:
                    result.status = "cancelled" if self._stop.is_set() else "failed"
                    result.reason = "cancelled" if self._stop.is_set() else "transport"
                    result.error = None if self._stop.is_set() else str(exc)
                    result.partial_text = "".join(text_buf) or "".join(blocks.values())
                    break
                kind = str(event.get("type") or "")
                if self._audit_log is not None and kind in (
                        "turn_start", "turn_end", "tool_call", "tool_result", "tool_denied",
                        "permission_request", "error"):
                    try:
                        payload = {k: event.get(k) for k in (
                            "name", "id", "reason", "summary", "path", "message", "is_error",
                            "args", "output", "diff", "command",
                        ) if k in event and event.get(k) not in (None, "", {}, [])}
                        self._audit_log.append(
                            self.session_id, result.run_id, kind, payload,
                            do_redact=not (self._policy and not self._policy.redact_events),
                        )
                    except Exception:
                        pass
                yield RunEvent(
                    type=kind, data=event, session_id=self.session_id, run_id=result.run_id,
                    request_id=event.get("request_id") if isinstance(event.get("request_id"), str)
                    else request_id,
                )
                if kind == "turn_start":
                    turn_id = str(event.get("turn_id") or "")
                    rid = event.get("request_id")
                    if turn_id and (rid == request_id or not live_turn_id):
                        live_turn_id = turn_id
                if kind == "permission_request":
                    result.status = "waiting_for_approval"
                    if self._stop.is_set() or repairing:
                        action = "deny"
                    else:
                        action = self._permission(event)
                    self._client.send({"type": "permission_response", "id": event["id"],
                                       "decision": action})
                    result.status = "cancelled" if self._stop.is_set() else "running"
                elif kind == "plan_proposal":
                    result.status = "waiting_for_approval"
                    decision = "reject" if repairing else self._plan(event)
                    self._client.send({"type": "plan_response", "id": event["id"],
                                       "decision": decision})
                    result.status = "running"
                elif kind == "options_request":
                    result.status = "waiting_for_approval"
                    self._answer_options(event)
                    result.status = "running"
                elif kind == "mcp_input_request":
                    result.status = "waiting_for_approval"
                    self._answer_mcp(event)
                    result.status = "running"
                elif kind == "text_delta":
                    text_buf.append(str(event.get("text") or ""))
                elif kind == "stream_end":
                    message_id = str(event.get("message_id") or "")
                    block = "".join(text_buf)
                    text_buf.clear()
                    if message_id:
                        blocks[message_id] = block
                        if event.get("phase") == "answer":
                            answer_ids.append(message_id)
                elif kind == "tool_call":
                    call_id = str(event.get("call_id") or "")
                    args = event.get("args") if isinstance(event.get("args"), dict) else {}
                    tools[call_id] = ToolRecord(
                        name=str(event.get("name") or ""),
                        call_id=call_id,
                        summary=str(event.get("summary") or ""),
                        args=args,
                    )
                elif kind == "tool_result":
                    call_id = str(event.get("call_id") or "")
                    record = tools.get(call_id) or ToolRecord(
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
                    tools[call_id] = record
                    if record.name == "present_document":
                        for index, url in enumerate(_document_urls(output)):
                            doc = Artifact(
                                id=f"{call_id or 'doc'}-{index}",
                                name="document" if index == 0 else "document.md",
                                url=url,
                            )
                            documents[doc.id] = doc
                elif kind == "tool_denied":
                    call_id = str(event.get("call_id") or "")
                    tools[call_id] = ToolRecord(
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
                    artifacts[art.id] = art
                    if art.url.startswith("http://127.0.0.1") or art.url.startswith("http://localhost"):
                        documents[art.id] = art
                elif kind == "todos":
                    tasks = self._project_tasks(event.get("todos") or [])
                elif kind == "agent_started":
                    info = _agent_from_row(event)
                    if info.id:
                        agents[info.id] = info
                elif kind == "agent_ended":
                    info = _agent_from_row(event)
                    if info.id:
                        agents[info.id] = info
                elif kind == "context":
                    if isinstance(event.get("used"), int):
                        usage["context_used"] = event["used"]
                    if isinstance(event.get("size"), int):
                        usage["context_size"] = event["size"]
                elif kind == "turn_end":
                    turn_id = str(event.get("turn_id") or "")
                    if not self._stop.is_set():
                        if live_turn_id and turn_id and turn_id != live_turn_id:
                            continue
                        if not live_turn_id and turn_id:
                            # Prompt has not been accepted yet; this end belongs to a prior turn.
                            continue
                    reason = str(event.get("reason") or "completed")
                    result.reason = reason
                    final_id = event.get("final_message_id")
                    if isinstance(final_id, str) and final_id in blocks:
                        result.final_text = blocks[final_id]
                    elif answer_ids and answer_ids[-1] in blocks:
                        result.final_text = blocks[answer_ids[-1]]
                    else:
                        result.final_text = "".join(blocks.values()) or "".join(text_buf)
                    if isinstance(event.get("token_estimate"), int):
                        usage["token_estimate"] = event["token_estimate"]
                    result.tools = list(tools.values())
                    result.artifacts = list(artifacts.values())
                    result.documents = list(documents.values())
                    result.tasks = tasks
                    result.agents = list(agents.values())
                    result.changes = _diff_workspace(self._cwd, before)
                    result.verification = self._verification_from_tools(result.tools)
                    if self._stop.is_set() or reason in ("cancelled", "interrupted"):
                        result.status = "cancelled"
                        result.reason = "cancelled"
                        result.partial_text = result.final_text
                    elif timed_out:
                        result.reason = "timeout"
                        result.partial_text = result.final_text
                        result.status = "cancelled" if reason in ("cancelled", "interrupted") else (
                            "failed" if reason in ("error", "failed") else "completed")
                    elif reason in ("error", "failed"):
                        result.status = "failed"
                    else:
                        # A denied tool is a step result. The CLI continues the turn; staff
                        # deny must not mark the whole run blocked.
                        result.status = "completed"
                    self._finish_usage(result, usage)
                    if not self.session_path:
                        try:
                            self.bind_identity()
                        except Exception:
                            pass
                    break
                elif kind == "error" and event.get("fatal"):
                    result.status = "cancelled" if self._stop.is_set() else "failed"
                    result.reason = "cancelled" if self._stop.is_set() else "runtime"
                    result.error = None if self._stop.is_set() else str(event.get("message") or "fatal backend error")
                    result.partial_text = "".join(text_buf) or "".join(blocks.values())
                    break
                elif kind == "command_rejected" and event.get("request_id") == request_id:
                    result.status = "cancelled" if self._stop.is_set() else "failed"
                    result.reason = "cancelled" if self._stop.is_set() else str(event.get("reason") or "rejected")
                    result.error = None if self._stop.is_set() else str(event.get("message") or "command rejected")
                    break
        except DGCClientError as exc:
            result.status = "cancelled" if self._stop.is_set() else "failed"
            result.reason = "cancelled" if self._stop.is_set() else "transport"
            result.error = None if self._stop.is_set() else str(exc)

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

    def _verification_from_tools(self, tools: list[ToolRecord]) -> VerificationResult | None:
        command = self._verify_command.strip()
        if not command:
            return None
        for record in reversed(tools):
            if record.name != "bash":
                continue
            output = record.output or ""
            exit_code = None
            if "exit code:" in output.lower():
                try:
                    exit_code = int(output.lower().rsplit("exit code:", 1)[1].split()[0])
                except (IndexError, ValueError):
                    exit_code = None
            ok = (not record.is_error) if exit_code is None else exit_code == 0
            return VerificationResult(ok=ok, command=command, output=output[:8000],
                                      exit_code=exit_code)
        return VerificationResult(ok=None, command=command)

    def _collect_changes(self) -> list[FileChange]:
        return _diff_workspace(self._cwd, _snapshot_workspace(self._cwd))

    def _finish_usage(self, result: RunResult, usage: dict[str, Any]) -> None:
        from .usage import cost_usd, tokens_from_usage_map
        inp, out, cached, estimate = tokens_from_usage_map(usage)
        if inp == 0 and out == 0 and estimate:
            inp, out = estimate, 0
        dollars = cost_usd(inp, out, cached, self._pricing)
        usage["input_tokens"] = inp
        usage["output_tokens"] = out
        usage["cached_input_tokens"] = cached
        usage["cost_usd"] = dollars
        usage["department"] = self._department
        result.usage = usage
        if self._usage_log is not None:
            try:
                self._usage_log.record({
                    "session_id": result.session_id or self.session_id,
                    "run_id": result.run_id,
                    "department": self._department,
                    "model": self._model,
                    "status": result.status,
                    "input_tokens": inp,
                    "output_tokens": out,
                    "cached_input_tokens": cached,
                    "token_estimate": estimate,
                    "cost_usd": dollars,
                })
            except Exception:
                pass

    def _decide(self, callback, request, default):
        key = getattr(request, "id", "") or ""
        if key:
            with self._lock:
                if key in self._answered_ids:
                    return default
                self._answered_ids.add(key)
        if callback is None:
            return default
        box: list = []

        def worker() -> None:
            try:
                box.append(callback(request))
            except Exception:
                box.append(default)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        timeout = self._decision_timeout or 30.0
        deadline = time.monotonic() + timeout
        while thread.is_alive() and time.monotonic() < deadline:
            if self._stop.is_set():
                return default
            thread.join(0.05)
        if thread.is_alive() or not box:
            return default
        return box[0]

    def _permission(self, event: dict[str, Any]) -> PermissionAction:
        request = PermissionRequest(
            id=str(event.get("id") or ""),
            name=str(event.get("name") or ""),
            args=event.get("args") if isinstance(event.get("args"), dict) else {},
            summary=str(event.get("summary") or ""),
            suggested_rule=str(event.get("suggested_rule") or ""),
            call_id=event.get("call_id") if isinstance(event.get("call_id"), str) else None,
            diff=event.get("diff") if isinstance(event.get("diff"), str) else None,
            command=event.get("command") if isinstance(event.get("command"), str) else None,
        )
        if self._policy is not None:
            forced = self._policy.decision(request, cwd=self._cwd)
            if forced == "deny":
                staff = self._on_permission is not None and self._permission_mode != "auto"
                # Named deny_tools stay fail-closed even when staff is present. Bash
                # write/network inspection defers to the callback so the ask is visible.
                if self._policy.named_tool_denied(request.name) or not staff:
                    return "deny"
        action = self._decide(self._on_permission, request, "deny")
        return action if action in ("once", "always", "deny") else "deny"

    def _plan(self, event: dict[str, Any]) -> str:
        request = PlanRequest(
            id=str(event.get("id") or ""),
            plan=str(event.get("plan") or ""),
            choices=tuple(str(item) for item in (event.get("choices") or [])
                          if isinstance(item, str)),
        )
        decision = self._decide(self._on_plan, request, "reject")
        return decision if decision in ("auto", "acceptEdits", "default", "reject") else "reject"

    def _answer_options(self, event: dict[str, Any]) -> None:
        request = QuestionRequest(
            id=str(event.get("id") or ""),
            questions=_parse_questions(event.get("questions")),
            call_id=event.get("call_id") if isinstance(event.get("call_id"), str) else None,
        )
        if self._on_question is None:
            self._client.send({"type": "options_response", "id": request.id, "dismissed": True})
            return
        answer = self._decide(self._on_question, request, "dismiss")
        if answer == "dismiss":
            self._client.send({"type": "options_response", "id": request.id, "dismissed": True})
            return
        payload: dict[str, Any] = {}
        for qid, value in dict(answer).items():
            if isinstance(value, QuestionAnswer):
                payload[str(qid)] = {"selected": list(value.selected), "other": value.other}
            elif isinstance(value, dict):
                payload[str(qid)] = value
        self._client.send({"type": "options_response", "id": request.id, "answers": payload})

    def _answer_mcp(self, event: dict[str, Any]) -> None:
        request = McpInputRequest(
            id=str(event.get("id") or ""),
            server=str(event.get("server") or ""),
            kind=str(event.get("kind") or ""),
            payload=event.get("payload") if isinstance(event.get("payload"), dict) else {},
        )
        action = "cancel"
        content = None
        if self._on_mcp_input is not None:
            try:
                response = self._on_mcp_input(request)
                if isinstance(response, McpInputResponse):
                    action = response.action
                    content = response.content
            except Exception:
                action = "cancel"
        payload: dict[str, Any] = {"type": "mcp_input_response", "id": request.id, "action": action}
        if content:
            payload["content"] = dict(content)
        self._client.send(payload)
