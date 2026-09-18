/** DGC SDK for Node (@vibedgc/sdk). Protocol v14; pair with DGC CLI 0.41.6. */
export { VERSION, PROTOCOL, REQUIRES_CLI } from "./types.ts";
export type {
  AbortSignalLike, AgentInfo, Artifact, Checkpoint, ClientOptions, FileChange, Goal, HookInfo, McpInputRequest,
  McpInputResponse, McpServerInfo, Monitor, PermissionAction, PermissionMode, PermissionRequest,
  PermissionRule, PlanAction, PlanRequest, Pricing, QuestionAnswers, QuestionRequest, ResumeOptions,
  RunEvent, RunOptions, RunResult, RunStatus, RuntimePolicy, SandboxRequirement, SandboxSetting,
  SandboxStatus, SessionInfo, SessionOptions, SkillInfo, TaskItem,
  ToolRecord, UnhandledPolicy, VerificationResult,
} from "./types.ts";
export { DGC } from "./client.ts";
export { RunHandle, Session } from "./session.ts";
export { defineTool, type ToolSpec } from "./tools.ts";
export { assertSupported, extractJson, validate } from "./schema.ts";
export {
  DGCCommandRejectedError, DGCConfigError, DGCError, DGCProtocolError, DGCRuntimeError, DGCTimeoutError,
  DGCUnsupportedError,
} from "./errors.ts";
export { redact, redactText } from "./audit.ts";
export { costUsd, type UsageReport } from "./usage.ts";
