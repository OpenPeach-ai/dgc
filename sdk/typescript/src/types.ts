export const VERSION = "0.5.3";
export const PROTOCOL = 14;
export const REQUIRES_CLI = "0.41.6";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto";
export type PermissionAction = "once" | "always" | "deny";
export type PlanAction = "auto" | "acceptEdits" | "default" | "reject";
export type UnhandledPolicy = "deny" | "callback";
export type RunStatus =
  | "queued" | "running" | "waiting_for_approval"
  | "completed" | "cancelled" | "failed" | "blocked";

export type PermissionRequest = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  summary?: string;
  suggestedRule?: string;
  callId?: string;
  diff?: string;
};

export type PlanRequest = {
  id: string;
  plan: string;
  choices: string[];
};

export type QuestionRequest = {
  id: string;
  questions: Array<{
    id: string;
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string; recommended?: boolean }>;
  }>;
  callId?: string;
};

export type QuestionAnswers = Record<string, { selected: number[]; other?: string }>;

export type McpInputRequest = {
  id: string;
  server: string;
  kind: string;
  payload: Record<string, unknown>;
};

export type McpInputResponse = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

export type Goal = {
  text: string;
  status: "none" | "active" | "paused" | "completed" | "blocked";
  elapsedSeconds?: number;
};

export type HookInfo = {
  event: string;
  configured: number;
  matchers?: string[];
  valid?: boolean;
};

export type Monitor = {
  id: string;
  description?: string;
  command?: string;
  state?: string;
};

export type PermissionRule = { action: string; rule: string };

export type McpServerInfo = {
  name: string;
  state: string;
  enabled?: boolean;
  toolCount?: number;
  error?: string;
};

export type SkillInfo = {
  name: string;
  description: string;
  source: string;
  enabled: boolean;
};

export type AgentInfo = {
  id: string;
  state: string;
  description?: string;
  parentId?: string | null;
};

export type VerificationResult = {
  ok: boolean | null;
  command: string;
  output?: string;
  exitCode?: number | null;
};

export type Artifact = { id: string; name: string; url: string; rel?: string };

export type ToolRecord = {
  name: string;
  callId: string;
  summary?: string;
  output?: string;
  isError?: boolean;
};

export type SessionInfo = {
  id: string;
  path: string;
  name?: string;
  preview?: string;
  messageCount?: number;
  when?: string;
};

export type Checkpoint = { index: number; preview: string; files: number };

export type RunEvent = { type: string; data: Record<string, unknown>; runId: string; sessionId: string };

export type TaskItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
  revision?: number;
};

export type RunResult = {
  sessionId: string;
  runId: string;
  status: RunStatus;
  reason: string;
  finalText: string;
  partialText?: string;
  output?: unknown;
  usage: Record<string, unknown>;
  tools: ToolRecord[];
  artifacts: Artifact[];
  documents: Artifact[];
  tasks?: TaskItem[];
  agents?: AgentInfo[];
  verification?: VerificationResult;
  error?: string;
};

export type SessionOptions = {
  cwd: string;
  permissions?: { mode?: PermissionMode; unhandled?: UnhandledPolicy };
  onPermission?: (request: PermissionRequest) => PermissionAction | Promise<PermissionAction>;
  onPlan?: (request: PlanRequest) => PlanAction | Promise<PlanAction>;
  onQuestion?: (request: QuestionRequest) =>
    | QuestionAnswers
    | "dismiss"
    | Promise<QuestionAnswers | "dismiss">;
  onMcpInput?: (request: McpInputRequest) => McpInputResponse | Promise<McpInputResponse>;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  mode?: PermissionMode;
  thinking?: string;
  instructions?: string;
  maxTurns?: number;
  decisionTimeoutMs?: number;
  verifyCommand?: string;
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  }>;
};

export type RuntimePolicy = {
  network?: "deny" | "allow";
  denyTools?: string[];
  extraReadDirs?: string[];
  redactEvents?: boolean;
};

export type Pricing = {
  inputPerMillion?: number;
  outputPerMillion?: number;
};

export type ClientOptions = {
  runtime?: string[];
  stateDir: string;
  inheritUserState?: boolean;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  mode?: PermissionMode;
  thinking?: string;
  extraEnv?: Record<string, string>;
  /** Host variables the runtime may see besides the basic ones: false (default), names, or true. */
  inheritEnv?: boolean | string[];
  instructions?: string;
  department?: string;
  pricing?: Pricing;
  policy?: RuntimePolicy;
};

export type RunOptions = {
  timeoutMs?: number;
  maxTurns?: number;
  outputSchema?: Record<string, unknown>;
  repairAttempts?: number;
  skills?: string[];
  workflow?: string;
};

export type ResumeOptions = SessionOptions & {
  sessionId?: string;
  latest?: boolean;
};
