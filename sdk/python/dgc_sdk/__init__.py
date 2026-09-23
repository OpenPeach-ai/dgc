"""DGC SDK for embedding the harness in applications and CI.

Install: ``pip install dgc-sdk``. Import ``dgc_sdk``. Version 0.6.5 pairs with DGC CLI 0.43.4
(editor protocol v14). Guide and API reference: docs/SDK.md in the DGC repository.
"""

from ._mcp_bridge import define_tool
from ._version import PROTOCOL, REQUIRES_CLI, __version__
from .audit import redact, redact_text
from .client import AsyncDGC, AsyncRunHandle, AsyncSession, DGC
from .policy import RuntimePolicy
from .retry import RetryPolicy
from .usage import Pricing, cost_usd
from .errors import (
    DGCCommandRejectedError, DGCConfigError, DGCError, DGCProtocolError, DGCRuntimeError,
    DGCTimeoutError, DGCUnsupportedError,
)
from .session import RunHandle, Session
from .types import (
    AgentInfo, Artifact, Checkpoint, Denial, FileChange, Goal, HookInfo, McpInputRequest,
    McpInputResponse,
    McpServerInfo, Monitor, OnMcpInput, OnPermission, OnPlan, OnQuestion, PermissionAction,
    PermissionMode, PermissionPolicy, PermissionRequest, PermissionRule, PlanAction, PlanRequest,
    Question, QuestionAnswer, QuestionOption, QuestionRequest, RunEvent, RunResult, RunStatus,
    SandboxPolicy, SandboxRequirement, SandboxStatus, SessionInfo, SkillInfo, TaskItem, TaskStatus,
    ToolRecord, ToolSpec, UnhandledPolicy, VerificationResult,
)

__all__ = [
    "PROTOCOL", "REQUIRES_CLI", "__version__",
    "AgentInfo", "Artifact", "AsyncDGC", "AsyncRunHandle", "AsyncSession", "Checkpoint", "DGC",
    "Denial", "Pricing", "RetryPolicy", "RuntimePolicy", "cost_usd", "redact", "redact_text",
    "DGCCommandRejectedError", "DGCConfigError", "DGCError", "DGCProtocolError",
    "DGCRuntimeError", "DGCTimeoutError",
    "DGCUnsupportedError", "FileChange", "Goal", "HookInfo", "McpInputRequest", "McpInputResponse",
    "McpServerInfo", "Monitor", "OnMcpInput", "OnPermission", "OnPlan", "OnQuestion",
    "PermissionAction", "PermissionMode", "PermissionPolicy", "PermissionRequest",
    "PermissionRule", "PlanAction", "PlanRequest",
    "Question", "QuestionAnswer", "QuestionOption", "QuestionRequest", "RunEvent", "RunHandle",
    "RunResult", "RunStatus", "SandboxPolicy", "SandboxRequirement", "SandboxStatus", "Session",
    "SessionInfo",
    "SkillInfo", "TaskItem", "TaskStatus", "ToolRecord", "ToolSpec", "UnhandledPolicy",
    "VerificationResult", "define_tool",
]
