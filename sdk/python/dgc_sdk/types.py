"""Public SDK types. Names match the planned Python/TypeScript contract."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Mapping

PermissionMode = Literal["default", "acceptEdits", "plan", "auto"]
UnhandledPolicy = Literal["deny", "callback"]
SandboxRequirement = Literal["required", "preferred", "off"]
RunStatus = Literal[
    "queued", "running", "waiting_for_approval", "completed", "cancelled", "failed", "blocked",
]
PermissionAction = Literal["once", "always", "deny"]
PlanAction = Literal["auto", "acceptEdits", "default", "reject"]
McpInputAction = Literal["accept", "decline", "cancel"]
TaskStatus = Literal["pending", "in_progress", "completed", "blocked", "cancelled"]
GoalStatus = Literal["none", "active", "paused", "completed", "blocked"]


@dataclass(frozen=True)
class PermissionPolicy:
    mode: PermissionMode = "default"
    unhandled: UnhandledPolicy = "deny"


@dataclass(frozen=True)
class SandboxPolicy:
    requirement: SandboxRequirement = "off"


@dataclass(frozen=True)
class PermissionRequest:
    id: str
    name: str
    args: Mapping[str, Any]
    summary: str = ""
    suggested_rule: str = ""
    call_id: str | None = None
    diff: str | None = None
    command: str | None = None


@dataclass(frozen=True)
class PlanRequest:
    id: str
    plan: str
    choices: tuple[str, ...] = ()


@dataclass(frozen=True)
class QuestionOption:
    label: str
    description: str = ""
    recommended: bool = False


@dataclass(frozen=True)
class Question:
    id: str
    question: str
    options: tuple[QuestionOption, ...] = ()
    header: str = ""
    multi_select: bool = False


@dataclass(frozen=True)
class QuestionRequest:
    id: str
    questions: tuple[Question, ...]
    call_id: str | None = None


@dataclass(frozen=True)
class QuestionAnswer:
    selected: tuple[int, ...] = ()
    other: str = ""


@dataclass(frozen=True)
class McpInputRequest:
    id: str
    server: str
    kind: str
    payload: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class McpInputResponse:
    action: McpInputAction
    content: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: Mapping[str, Any]
    handler: Callable[[Mapping[str, Any]], Any]
    timeout: float | None = 30.0


@dataclass(frozen=True)
class ToolRecord:
    name: str
    call_id: str = ""
    summary: str = ""
    output: str = ""
    is_error: bool = False
    is_diff: bool = False
    diff: str | None = None
    args: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class FileChange:
    path: str
    kind: str
    before: str = ""
    after: str = ""
    root: str = ""


@dataclass(frozen=True)
class Artifact:
    id: str
    name: str
    url: str
    rel: str = ""


@dataclass(frozen=True)
class TaskItem:
    id: str
    content: str
    status: TaskStatus
    revision: int = 0


@dataclass(frozen=True)
class Checkpoint:
    index: int
    preview: str = ""
    files: int = 0


@dataclass(frozen=True)
class SessionInfo:
    id: str
    path: str
    name: str = ""
    preview: str = ""
    message_count: int = 0
    when: str = ""


@dataclass(frozen=True)
class SkillInfo:
    name: str
    description: str = ""
    source: str = ""
    enabled: bool = True


@dataclass(frozen=True)
class HookInfo:
    event: str
    configured: int = 0
    matchers: tuple[str, ...] = ()
    valid: bool = True
    truncated: bool = False


@dataclass(frozen=True)
class PermissionRule:
    action: str
    rule: str


@dataclass(frozen=True)
class McpServerInfo:
    name: str
    state: str = ""
    enabled: bool = True
    tool_count: int = 0
    error: str = ""


@dataclass(frozen=True)
class Goal:
    text: str
    status: GoalStatus = "none"
    elapsed_seconds: int = 0
    details: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Monitor:
    id: str
    description: str = ""
    command: str = ""
    state: str = ""
    events: int = 0
    persistent: bool = False


@dataclass(frozen=True)
class AgentInfo:
    id: str
    state: str
    description: str = ""
    parent_id: str | None = None
    model: str | None = None


@dataclass(frozen=True)
class VerificationResult:
    ok: bool | None = None
    command: str = ""
    output: str = ""
    exit_code: int | None = None


@dataclass
class RunEvent:
    type: str
    data: dict[str, Any] = field(default_factory=dict)
    session_id: str = ""
    run_id: str = ""
    request_id: str | None = None


@dataclass
class RunResult:
    session_id: str
    run_id: str
    status: RunStatus
    reason: str = ""
    final_text: str = ""
    partial_text: str = ""
    output: Any = None
    usage: dict[str, Any] = field(default_factory=dict)
    tools: list[ToolRecord] = field(default_factory=list)
    changes: list[FileChange] = field(default_factory=list)
    artifacts: list[Artifact] = field(default_factory=list)
    documents: list[Artifact] = field(default_factory=list)
    tasks: list[TaskItem] = field(default_factory=list)
    agents: list[AgentInfo] = field(default_factory=list)
    verification: VerificationResult | None = None
    error: str | None = None


OnPermission = Callable[[PermissionRequest], PermissionAction]
OnPlan = Callable[[PlanRequest], PlanAction]
OnQuestion = Callable[[QuestionRequest], Mapping[str, QuestionAnswer] | Literal["dismiss"]]
OnMcpInput = Callable[[McpInputRequest], McpInputResponse]
