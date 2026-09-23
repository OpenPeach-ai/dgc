export const VERSION = "0.6.8";
export const PROTOCOL = 14;
export const REQUIRES_CLI = "0.44.0";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto";
export type PermissionAction = "once" | "always" | "deny";
export type PlanAction = "auto" | "acceptEdits" | "default" | "reject";
export type UnhandledPolicy = "deny" | "callback";
export type SandboxRequirement = "required" | "preferred" | "off";
/** `sandbox` option: the bare requirement or `{ requirement }`. */
export type SandboxSetting = SandboxRequirement | { requirement?: SandboxRequirement };

/**
 * Whether a session's shell commands run inside the OS sandbox (`session.sandbox`).
 * `requirement` is what the session asked for (a sandboxed-shell RuntimePolicy asks for at least
 * "preferred"), `active` whether the runtime confines shell commands, `backend` the confinement
 * tool (`bwrap` or `sandbox-exec`), and `reason` why a "preferred" sandbox is off.
 */
export type SandboxStatus = {
  requirement: SandboxRequirement;
  active: boolean;
  backend: string;
  reason: string;
};
/** A run's state. (0.5.2 listed a "blocked" status that was never produced; see `denials`.) */
export type RunStatus =
  | "queued" | "running" | "waiting_for_approval"
  | "completed" | "cancelled" | "failed";

export type PermissionRequest = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  summary?: string;
  suggestedRule?: string;
  callId?: string;
  diff?: string;
  command?: string;
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
  isDiff?: boolean;
  diff?: string;
  args?: Record<string, unknown>;
};

/**
 * One tool call the run refused (`RunResult.denials`). `source` is a best-effort category of who
 * refused it: "policy" (a RuntimePolicy or a deny rule), "callback" (your onPermission said deny,
 * or none answered), "hook" (a PreToolUse hook), "mode" (plan mode, or a turn with nobody to
 * approve), or "runtime" when it cannot be told apart.
 */
export type Denial = {
  name: string;
  reason: string;
  source: "policy" | "callback" | "hook" | "mode" | "runtime";
  callId: string;
  args: Record<string, unknown>;
};

/**
 * One file the run changed under the session cwd. `before`/`after` hold the text (up to 1 MB; ""
 * for binary files or the missing side) and `diff` is a `git apply`-able unified diff ("" when
 * either side is not text).
 */
export type FileChange = {
  path: string;
  kind: "added" | "modified" | "deleted";
  before: string;
  after: string;
  root: string;
  diff: string;
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

export type RunEvent = {
  type: string;
  data: Record<string, unknown>;
  runId: string;
  sessionId: string;
  /** The prompt, steer or repair this event belongs to, when DGC said. */
  requestId?: string;
};

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
  /**
   * Provider token usage for this run's turns (`input_tokens`, `output_tokens`,
   * `cached_input_tokens`, `reasoning_tokens`, `requests`; `null` when the provider did not
   * report them, never a guessed 0), `cost_usd` (null without pricing or known tokens),
   * `usage_known`, `model`, `department`, and DGC's `token_estimate` / `context_used` /
   * `context_size` (context-window estimates, not billed tokens).
   */
  usage: Record<string, unknown>;
  tools: ToolRecord[];
  /** Tool calls the run refused (a denied step does not fail the run; the agent is told). */
  denials?: Denial[];
  artifacts: Artifact[];
  documents: Artifact[];
  /** Files the run added, modified or deleted under the session cwd. */
  changes?: FileChange[];
  tasks?: TaskItem[];
  agents?: AgentInfo[];
  /**
   * Evidence about the configured `verifyCommand` (never about an unrelated command); undefined
   * when none is configured, `ok: null` when nothing shows whether it passed.
   */
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
  /** Cap on tool iterations for every run of this session (this session only). */
  maxTurns?: number;
  /** DGC's per-turn time budget in seconds (this session only). */
  turnBudgetS?: number;
  /** Maximum output tokens per model reply (this session only). */
  maxTokens?: number;
  /**
   * How long a decision callback (onPermission, onPlan, onQuestion, onMcpInput) may take.
   * Default 30 000 ms; `null` waits as long as it takes. A cancel always wins.
   */
  decisionTimeoutMs?: number | null;
  /** Command DGC runs before it may finish (verify-before-done), for this session only. */
  verifyCommand?: string;
  /** Overrides the client's `sandbox` for this session. */
  sandbox?: SandboxSetting;
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
    timeoutMs?: number | null;
  }>;
};

/**
 * Limits an embedder puts on every session of a DGC client. DGC enforces them in every
 * permission mode, `auto` included, on the runtime side (the policy travels to each session's
 * `dgc serve` in its environment and is never saved to any config.json).
 *
 * - Tools: `denyTools` / `allowTools` take DGC tool names (`read_file`, `bash`, `web_fetch`, ...)
 *   and MCP routes (`mcp__app__issue_refund` for a `defineTool` tool named `issue_refund`, or
 *   `mcp__app__*`). An unknown name throws DGCConfigError. With `allowTools`, every other tool is
 *   refused (the option picker `propose_options` stays unless denied).
 * - Paths: DGC's file tools cannot reach outside the session's cwd, except to read inside
 *   `extraReadDirs`, and cannot reach `denyPathPrefixes` at all (relative prefixes resolve
 *   against the cwd).
 * - Network: `network: "deny"` (the default) refuses web fetch, web search, the browser, skill
 *   downloads, and MCP servers other than the application's own tools.
 * - Shell: `shell: "sandboxed"` (default) turns the OS sandbox on for the session; in `auto` mode
 *   the shell runs only there (without a sandbox `bash`/`monitor` are refused, `python` always
 *   is), and in the other modes each shell command is a permission request for `onPermission`.
 *   `shell: "screened"` runs the shell unconfined and, in auto mode, refuses commands whose text
 *   looks like a network call or (with a write tool denied) a file write: best effort only.
 * - `redactEvents` (default true) redacts secrets in audit rows.
 */
export type RuntimePolicy = {
  network?: "deny" | "allow";
  denyTools?: string[];
  allowTools?: string[] | null;
  extraReadDirs?: string[];
  denyPathPrefixes?: string[];
  redactEvents?: boolean;
  shell?: "sandboxed" | "screened";
};

/** USD per 1 000 000 tokens. `cachedInputPerMillion` (0 = the input price) prices cached input. */
export type Pricing = {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
};

export type ClientOptions = {
  runtime?: string[];
  /**
   * Holds this client's isolated HOME, audit and usage logs. Must be private (owned by you, not
   * group/world-writable); left unset, a fresh private temporary directory is used. A
   * config.json already in it is never merged: every session writes its own from scratch.
   */
  stateDir?: string;
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
  /** OS sandbox for shell commands: "required", "preferred" or "off" (default). */
  sandbox?: SandboxSetting;
  /** Extra DGC settings written into every isolated session's config (the explicit way to add them). */
  extraConfig?: Record<string, unknown>;
  /**
   * Whether a session's workspace may grant itself capabilities: its own `.dgc/permissions.json`
   * allow rules and its `.dgc/agents` definitions (which choose a model endpoint and a credential
   * variable). Default false: the workspace can only narrow what runs. Set it when you trust the
   * checkout as your own machine would.
   */
  trustWorkspace?: boolean;
  /** Keep the temporary stateDir the SDK created (stateDir unset) instead of removing it on close(). */
  keepStateDir?: boolean;
  /** Bound on the runtime's startup handshake (default 30 000 ms). */
  startTimeoutMs?: number;
  /** Bound on each control request such as listSessions or setGoal (default 15 000 ms). */
  requestTimeoutMs?: number;
};

/**
 * What `signal` needs from an `AbortSignal` (a standard `AbortController().signal` fits). Declared
 * here so the package's types do not depend on DOM or Node type libraries.
 */
export type AbortSignalLike = {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
};

/** Environment variables, as `process.env` holds them. */
export type Env = Record<string, string | undefined>;

export type RunOptions = {
  /**
   * Limit for each turn of the run (default 180 000 ms; `null` means no limit). When it passes,
   * the run is cancelled and its result is `status: "failed"`, `reason: "timeout"`.
   */
  timeoutMs?: number | null;
  /** Aborting this signal cancels the run (result `status: "cancelled"`). */
  signal?: AbortSignalLike;
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
