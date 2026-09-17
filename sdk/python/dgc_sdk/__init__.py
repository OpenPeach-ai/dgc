"""DGC SDK for embedding the harness in applications and CI.

Local package. Not published. Version with the TypeScript SDK when the contract changes.
"""

from ._mcp_bridge import define_tool
from ._version import PROTOCOL, REQUIRES_CLI, __version__
from .audit import redact, redact_text
from .client import AsyncDGC, AsyncRunHandle, AsyncSession, DGC
from .policy import RuntimePolicy
from .retry import RetryPolicy
from .usage import Pricing, cost_usd
from .errors import (
    DGCConfigError, DGCError, DGCProtocolError, DGCRuntimeError, DGCTimeoutError,
    DGCUnsupportedError,
)
from .session import RunHandle, Session
from .types import (
    AgentInfo, Artifact, Checkpoint, FileChange, Goal, HookInfo, McpInputRequest, McpInputResponse,
    McpServerInfo, Monitor, OnMcpInput, OnPermission, OnPlan, OnQuestion, PermissionAction,
    PermissionMode, PermissionPolicy, PermissionRequest, PermissionRule, PlanAction, PlanRequest,
    Question, QuestionAnswer, QuestionOption, QuestionRequest, RunEvent, RunResult, RunStatus,
    SandboxPolicy, SandboxRequirement, SessionInfo, SkillInfo, TaskItem, TaskStatus, ToolRecord,
    ToolSpec, UnhandledPolicy, VerificationResult,
)

__all__ = [
    "PROTOCOL", "REQUIRES_CLI", "__version__",
    "AgentInfo", "Artifact", "AsyncDGC", "AsyncRunHandle", "AsyncSession", "Checkpoint", "DGC",
    "Pricing", "RetryPolicy", "RuntimePolicy", "cost_usd", "redact", "redact_text",
    "DGCConfigError", "DGCError", "DGCProtocolError", "DGCRuntimeError", "DGCTimeoutError",
    "DGCUnsupportedError", "FileChange", "Goal", "HookInfo", "McpInputRequest", "McpInputResponse",
    "McpServerInfo", "Monitor", "OnMcpInput", "OnPermission", "OnPlan", "OnQuestion",
    "PermissionAction", "PermissionMode", "PermissionPolicy", "PermissionRequest",
    "PermissionRule", "PlanAction", "PlanRequest",
    "Question", "QuestionAnswer", "QuestionOption", "QuestionRequest", "RunEvent", "RunHandle",
    "RunResult", "RunStatus", "SandboxPolicy", "SandboxRequirement", "Session", "SessionInfo",
    "SkillInfo", "TaskItem", "TaskStatus", "ToolRecord", "ToolSpec", "UnhandledPolicy",
    "VerificationResult", "define_tool",
]
