import * as vscode from "vscode";
import { createHash } from "crypto";
import { realpath } from "fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "path";
import { DgcBackend, DgcEvent } from "./backend";
import { resolveDgcExecutable, userScopedString } from "./configuration";
import { workspaceFile } from "./navigation";
import { McpBrowserRequest, openMcpBrowser } from "./mcpAuth";

const MODES = [
  { id: "default", label: "$(shield) default", detail: "ask before writes and shell commands" },
  { id: "acceptEdits", label: "$(edit) acceptEdits", detail: "auto-approve file edits, ask before shell commands" },
  { id: "plan", label: "$(book) plan", detail: "read-only — research and propose a plan you approve" },
  { id: "auto", label: "$(zap) auto", detail: "full auto — approve everything (deny rules still apply)" },
];
const MODE_CAPABILITY_RANK: Record<string, number> = {
  plan: 0, default: 1, acceptEdits: 2, auto: 3,
};
const THINK = [
  { id: "off", detail: "no extra reasoning" },
  { id: "low", detail: "think briefly before acting" },
  { id: "medium", detail: "reason step by step; consider edge cases" },
  { id: "high", detail: "sustained reasoning on complex work" },
  { id: "xhigh", detail: "deepest available reasoning effort" },
];
const PROVIDERS: Record<string, { url: string; needsKey: boolean; label: string; apiKey?: string }> = {
  ollama: { url: "http://localhost:11434/v1", needsKey: false, label: "Ollama (local)", apiKey: "ollama" },
  llamacpp: { url: "http://localhost:8080/v1", needsKey: false, label: "llama.cpp (local)", apiKey: "sk-local" },
  lmstudio: { url: "http://localhost:1234/v1", needsKey: false, label: "LM Studio (local)", apiKey: "lm-studio" },
  vllm: { url: "http://localhost:8000/v1", needsKey: false, label: "vLLM (local)", apiKey: "sk-local" },
  openai: { url: "https://api.openai.com/v1", needsKey: true, label: "OpenAI" },
  anthropic: { url: "https://api.anthropic.com/v1", needsKey: true, label: "Anthropic" },
  openrouter: { url: "https://openrouter.ai/api/v1", needsKey: true, label: "OpenRouter" },
  groq: { url: "https://api.groq.com/openai/v1", needsKey: true, label: "Groq" },
  deepseek: { url: "https://api.deepseek.com/v1", needsKey: true, label: "DeepSeek" },
  together: { url: "https://api.together.xyz/v1", needsKey: true, label: "Together AI" },
  mistral: { url: "https://api.mistral.ai/v1", needsKey: true, label: "Mistral" },
};

const endpointId = (value: unknown): string => String(value || "").trim().replace(/\/$/, "").toLowerCase();

type ManagedMcpServer = {
  name: string;
  transport: "stdio" | "remote";
  target: string;
  args: string[];
  envNames: string[];
  logLevel: string;
};

type ManagedMcpSecrets = { env?: Record<string, string>; token?: string };

type ProviderSecretId = "apiKey" | "subagentApiKey" | "fallbackApiKey";
type ProviderSecretMutation = {
  id: ProviderSecretId;
  value?: string;
  endpoint: string;
  remove: boolean;
};
type ApprovedModeChange = { mode: string; acknowledgeWorkspaceTrust: boolean };

type WorkspaceChange = {
  id: string;
  counted: boolean;
  staged: boolean;
  error: string;
  root: string;
  folder: string;
  path: string;
  displayPath: string;
  additions: number;
  deletions: number;
  binary: boolean;
  untracked: boolean;
  deleted: boolean;
};

const MCP_SECRET_FLAGS = new Set([
  "--header", "--api-key", "--apikey", "--api_key", "--token", "--access-token",
  "--auth", "--authorization", "--password", "--passwd", "--secret", "--bearer",
  "--key", "--credential", "--credentials", "--env", "--env-file", "-e",
  "--user", "--username", "-u",
  "--client-secret", "--client_secret", "--clientsecret",
  "--refresh-token", "--refresh_token", "--refreshtoken",
  "--access_token", "--accesstoken",
]);
const MCP_SECRET_FLAG_NAMES = new Set([
  "apikey", "token", "accesstoken", "refreshtoken", "clientsecret", "auth",
  "authorization", "password", "passwd", "secret", "bearer", "key", "credential",
  "credentials", "env", "envfile", "user",
]);
const MCP_SECRET_ASSIGNMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*)?(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*=/i;
const MCP_SENSITIVE_QUERY_NAMES = new Set([
  "token", "accesstoken", "apikey", "key", "secret", "password", "credential",
  "authorization", "auth",
]);
const MCP_SENSITIVE_NAME_PARTS = new Set([
  "token", "apikey", "key", "secret", "password", "passwd", "credential",
  "credentials", "authorization", "auth", "bearer",
]);
const MCP_SENSITIVE_NAME_SUFFIXES = [
  "apikey", "token", "secret", "password", "passwd", "credential", "credentials",
  "authorization", "bearer", "auth",
];

function mcpSensitiveName(value: string): boolean {
  const lower = value.toLowerCase();
  const normalized = lower.replace(/[^a-z0-9]/g, "");
  const parts = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return MCP_SENSITIVE_QUERY_NAMES.has(normalized)
    || parts.some((part) => MCP_SENSITIVE_NAME_PARTS.has(part))
    || MCP_SENSITIVE_NAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function mcpArgHasCredentials(value: string): boolean {
  const raw = value.trim();
  const candidates = [raw];
  if (raw.includes("=")) { candidates.push(raw.slice(raw.indexOf("=") + 1).trim()); }
  for (const candidate of candidates) {
    if (!/^https?:\/\//i.test(candidate)) { continue; }
    try {
      const url = new URL(candidate);
      const fragmentParams = new URLSearchParams(url.hash.slice(1));
      if (url.username || url.password || [...url.searchParams.keys()].some(mcpSensitiveName)
          || [...fragmentParams.keys()].some(mcpSensitiveName)) {
        return true;
      }
    } catch { return true; }
  }
  return false;
}

/** Return the canonical URL accepted by both the managed-server editor and its migration path. */
function normalizedRemoteMcpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 4096
      || value.includes("\0") || /\s/u.test(value)) { return undefined; }
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    const sensitiveQuery = [...url.searchParams.keys()].some(mcpSensitiveName);
    const sensitiveFragment = [...new URLSearchParams(url.hash.slice(1)).keys()]
      .some(mcpSensitiveName);
    if (!url.hostname || url.username || url.password || sensitiveQuery || sensitiveFragment
        || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function persistedMcpArgsSafe(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index].trim(), lower = raw.toLowerCase();
    const priorRaw = index ? args[index - 1].trim() : "";
    const prior = priorRaw.toLowerCase();
    const head = lower.split("=", 1)[0];
    const priorHead = prior.split("=", 1)[0];
    const normalizedHead = head.replace(/^-+/, "").replace(/[^a-z0-9]/g, "");
    const normalizedPrior = priorHead.replace(/^-+/, "").replace(/[^a-z0-9]/g, "");
    const combinedEnv = /^-e(?:=.*|[A-Za-z_][A-Za-z0-9_]*(?:=.*)?)$/.test(raw);
    const combinedUser = raw.startsWith("-u") && raw.length > 2 && raw.slice(2).includes(":");
    if (lower.startsWith("authorization:") || lower === "--header" || prior === "--header"
        || raw === "-H" || priorRaw === "-H"
        || raw.startsWith("-H")
        || MCP_SECRET_FLAGS.has(head) || MCP_SECRET_FLAGS.has(priorHead)
        || MCP_SECRET_FLAG_NAMES.has(normalizedHead)
        || MCP_SECRET_FLAG_NAMES.has(normalizedPrior)
        || mcpSensitiveName(head.replace(/^-+/, ""))
        || mcpSensitiveName(priorHead.replace(/^-+/, ""))
        || combinedEnv || combinedUser || MCP_SECRET_ASSIGNMENT.test(raw)
        || mcpArgHasCredentials(raw)) { return false; }
  }
  return true;
}

function managedMcpIdentity(item: ManagedMcpServer): string {
  const publicIdentity = JSON.stringify({
    transport: item.transport,
    target: item.target,
    args: item.args,
    envNames: item.envNames,
  });
  return createHash("sha256").update(publicIdentity, "utf8").digest("hex");
}

export class DgcViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private viewType = "dgc.chat";   // the container the chat currently lives in
  private turnStartedAt = 0;
  private backend?: DgcBackend;
  private state = { model: "", mode: "default", think: "off", ultra: false,
                    baseUrl: "", workspaceTrusted: false,
                    subscriptionEngine: "",
                    goal: { text: "", status: "none", elapsed_seconds: 0 } };
  private _installPrompted = false;
  private _updatePrompted = false;
  private featureRequest = 0;
  private correlatedStateRequests = false;
  private routeState: {
    subagentBaseUrl: string; fallbackBaseUrl: string;
    nativeModel: string; nativeThink: string;
    subscriptionEngine: string; subscriptionModel: string; subscriptionEffort: string;
    subscriptionEngines: any[];
  } = { subagentBaseUrl: "", fallbackBaseUrl: "", nativeModel: "", nativeThink: "off",
        subscriptionEngine: "", subscriptionModel: "", subscriptionEffort: "",
        subscriptionEngines: [] };
  private behaviorState = { showReasoning: true, preserveThinking: false, codeAction: false };
  private mcpUrls = new Map<string, McpBrowserRequest>();
  private slashAliases = new Map<string, string>();
  private composerSelections = false;
  private skillManagement = false;
  private mcpContext = false;
  private mcpManagement = false;
  private goalInputs = false;
  private plaintextSecretWarnings = new Set<string>();
  private turnActive = false;
  private confirmedTurnActive = false;
  private workspaceRootsRevision = 0;
  private workspaceRootsDirty = true;
  private workspaceRootsInFlight: { revision: number; requestId?: string } | undefined;
  private initializingBackend?: DgcBackend;
  private nativeSettingsReady = false;
  private webviewReady = false;
  private lastReadyEvent?: DgcEvent;
  private currentSessionId = "";
  private currentSessionName = "";
  private sessionRestoreCandidate = "";
  private sessionRestoreStarted = false;
  private sessionRestoreFinished = false;
  private sessionRestoreRequestId?: string;
  private sessionDraftSource = "";
  private sessionHandshakeGeneration = 0;
  private sessionReady = false;
  private composerScope = "";
  private pendingWebviewActions: Array<() => void> = [];
  private testPostedMessages: Array<{ type: string; eventType?: string; id?: string; command?: string; fileCount?: number }> = [];
  private settingsSaveInFlight = false;
  private commandOverrideWarningShown = false;
  private changesRefreshTimer?: NodeJS.Timeout;
  private changesRefreshRevision = 0;
  private changesRefreshInFlight = false;
  private changesRefreshDirty = false;
  private workspaceChanges: WorkspaceChange[] = [];
  private chatChanges: WorkspaceChange[] = [];
  private reviewDocuments = new Map<string, string>();
  private sb: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext) {
    // one status-bar item: `model · mode` (click to change model)
    this.sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.sb.command = "dgc.selectModel";
    if (typeof vscode.workspace.registerTextDocumentContentProvider === "function") {
      this.context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("dgc-review", {
        provideTextDocumentContent: (uri) => this.reviewDocuments.get(uri.toString()) || "",
      }));
    }
    if (typeof vscode.workspace.createFileSystemWatcher === "function") {
      const watcher = vscode.workspace.createFileSystemWatcher("**/*");
      watcher.onDidCreate(() => this.scheduleWorkspaceChanges());
      watcher.onDidChange(() => this.scheduleWorkspaceChanges());
      watcher.onDidDelete(() => this.scheduleWorkspaceChanges());
      this.context.subscriptions.push(watcher);
    }
  }

  // ---- backend lifecycle ---------------------------------------------------
  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private draftScope(): string {
    if (!this.composerScope) {
      const workspace = vscode.workspace.workspaceFile?.toString()
        || vscode.workspace.workspaceFolders?.[0]?.uri.toString() || this.cwd();
      this.composerScope = createHash("sha256").update(workspace).digest("hex");
    }
    return this.composerScope;
  }

  private rememberSession(): void {
    if (!this.currentSessionId) { return; }
    void this.context.workspaceState.update("dgc.activeSession.v1", {
      scope: this.draftScope(), id: this.currentSessionId,
    }).then(undefined, () => this.post({ type: "event", event: { type: "error",
      message: "DGC could not remember this chat for window reload. The saved conversation remains available under Resume." } }));
  }

  /** The `dgc.ready` context key gates palette entries that need a running backend. */
  private setReadyContext(value: boolean): void {
    try {
      const pending = vscode.commands?.executeCommand?.("setContext", "dgc.ready", value);
      if (pending && typeof (pending as Thenable<unknown>).then === "function") {
        (pending as Thenable<unknown>).then(undefined, () => { /* the host is what matters */ });
      }
    } catch { /* a stub host without commands — the key is only a palette convenience */ }
  }

  private finishSessionHandshake(be: DgcBackend, adoptDraftFrom = ""): void {
    if (this.backend !== be) { return; }
    this.sessionReady = true;
    this.setReadyContext(true);                                             // gates palette entries
    this.rememberSession();
    this.post({ type: "session_ready", sessionId: this.currentSessionId, adoptDraftFrom });
    this.initializingBackend = undefined;
    this.nativeSettingsReady = false;
    be.completeHandshake();
    this.scheduleWorkspaceChanges(0);
  }

  private nextRequestId(prefix: string): string {
    this.featureRequest = this.featureRequest >= Number.MAX_SAFE_INTEGER
      ? 1 : this.featureRequest + 1;
    return `${prefix}-${Date.now()}-${this.featureRequest}`;
  }

  /** Add an optional protocol correlation ID only after the backend advertises support. */
  private stateCommand(prefix: string, command: any): any {
    return this.correlatedStateRequests
      ? { ...command, request_id: this.nextRequestId(prefix) }
      : command;
  }

  private requestState(be: DgcBackend, prefix: string, command: any,
                       responseType: DgcEvent["type"], timeoutMs = 5000): Promise<DgcEvent> {
    return be.request(this.stateCommand(prefix, command), responseType, timeoutMs);
  }

  private async compactContext(): Promise<void> {
    if (this.turnActive) {
      this.post({ type: "compact_state", state: "idle",
                  error: "Context compaction waits until the current turn is complete." });
      return;
    }
    this.post({ type: "compact_state", state: "working" });
    try {
      await this.requestState(this.ensureBackend(), "compact", { type: "compact" },
                              "compacted", 130000);
      this.post({ type: "compact_state", state: "idle" });
    } catch (err: any) {
      this.post({ type: "compact_state", state: "idle",
                  error: err?.message || "Context compaction did not complete." });
    }
  }

  private async stopArtifact(id: string): Promise<void> {
    const artifactId = String(id || "").slice(0, 200);
    if (!artifactId) { return; }
    this.post({ type: "artifact_stop_state", id: artifactId, state: "working" });
    try {
      const response = await this.requestState(
        this.ensureBackend(), "artifact-stop", { type: "stop_artifact", id: artifactId },
        "artifacts", 5000);
      const items = Array.isArray((response as any).items) ? (response as any).items : [];
      if (items.some((item: any) => String(item?.id || "") === artifactId)) {
        throw new Error("The artifact preview is still running.");
      }
      this.post({ type: "artifact_stop_state", id: artifactId, state: "stopped" });
    } catch (err: any) {
      this.post({ type: "artifact_stop_state", id: artifactId, state: "error",
                  error: err?.message || "DGC could not stop the artifact preview." });
    }
  }

  /** `/goal <objective>` is an action, not only a state mutation: persist the standing goal
   * first, then run that exact objective as the next agent turn. Awaiting the correlated goal
   * acknowledgement prevents a failed/busy goal update from launching an untagged prompt. */
  private async startGoal(text: string, payload: any = {}): Promise<void> {
    let objective = String(text || "").trim();
    const requestId = String(payload.requestId || this.nextRequestId("goal-prompt")).slice(0, 128);
    const reject = (error: string) => {
      this.post({ type: "prompt_rejected", requestId });
      this.post({ type: "goal_start_state", state: "error", error });
    };
    for (const key of ["context", "images", "skills", "templates"]) {
      if (payload[key] !== undefined && !Array.isArray(payload[key])) {
        reject(`Invalid goal ${key}; select the attachments again.`); return;
      }
    }
    if (payload.context?.length > 64 || payload.context?.some((item: any) => !item || typeof item !== "object" || Array.isArray(item))) {
      reject("Select at most 64 valid goal context attachments."); return;
    }
    let tokenBudget: number | undefined;
    if (objective.startsWith("--tokens")) {
      const match = /^--tokens\s+(\d{1,13})\s+([\s\S]+)$/.exec(objective);
      if (!match || Number(match[1]) <= 0 || Number(match[1]) > 1e12) {
        reject("Use /goal --tokens POSITIVE_NUMBER objective");
        return;
      }
      tokenBudget = Number(match[1]); objective = match[2].trim();
    }
    if (!objective) { reject("Enter a goal objective."); return; }
    const be = this.ensureBackend();
    const attached = Array.isArray(payload.context) ? payload.context.filter((item: any) => item && typeof item === "object") : [];
    if (this.goalInputs) {
      const accepted = be.send({ type: "start_goal", text: objective, request_id: requestId,
        skills: payload.skills, templates: payload.templates, images: payload.images,
        context: [...attached, ...this.editorContext()].slice(0, 64),
        ...(tokenBudget !== undefined ? { token_budget: tokenBudget } : {}) });
      if (!accepted) { reject("DGC could not submit the goal. Your draft has been retained."); return; }
      this.turnActive = true;
      this.post({ type: "goal_start_state", state: "submitted" });
      return;
    }
    if (attached.length || payload.images?.length || payload.skills?.length || payload.templates?.length) {
      reject("Update the DGC CLI to start goals with attachments."); return;
    }
    try {
      await this.requestState(be, "goal", {
        type: "set_goal", text: objective, status: "active", replace: true,
        ...(tokenBudget !== undefined ? { token_budget: tokenBudget } : {}),
      }, "goal_changed", 10000);
    } catch (err: any) {
      reject(err?.message || "DGC could not start the goal.");
      return;
    }
    const accepted = be.send({
      type: "prompt", text: objective, context: this.editorContext(), request_id: requestId,
    });
    if (!accepted) {
      reject("The goal was saved, but its first turn could not start. Resume the goal to continue.");
      return;
    }
    // Close the same command/turn_start race as an ordinary composer prompt.
    this.turnActive = true;
    this.post({ type: "goal_start_state", state: "started" });
  }

  private async updateGoal(text: string, tokenBudget?: number): Promise<void> {
    const objective = String(text || "").trim();
    if (!objective) { return; }
    const resume = this.state.goal.status === "active";
    const status = this.state.goal.status || "paused";
    const be = this.ensureBackend();
    try {
      await this.stopActiveTurn(be);
      await this.requestState(be, "goal", {
        type: "set_goal", text: objective, status,
        ...(tokenBudget !== undefined ? { token_budget: tokenBudget } : {}),
      }, "goal_changed", 10000);
      this.post({ type: "goal_edit_state", state: "saved" });
      if (resume) { await this.resumeGoal(objective); }
    } catch (err: any) {
      this.post({ type: "goal_edit_state", state: "error",
                  error: err?.message || "DGC could not update the goal." });
    }
  }

  private async pauseGoal(): Promise<void> {
    const be = this.ensureBackend();
    try {
      await this.stopActiveTurn(be);
      await this.requestState(be, "goal", {
        type: "set_goal", status: "paused",
      }, "goal_changed", 10000);
    } catch (err: any) {
      this.post({ type: "goal_control_state", state: "error",
                  error: err?.message || "DGC could not pause the goal." });
    }
  }

  // `known` is the objective the caller already has. Editing a goal awaits its own goal_changed
  // reply, which can consume the event before the panel's state handler sees it, so re-reading
  // this.state.goal here would sometimes find it stale and silently skip the resume.
  private async resumeGoal(known?: string): Promise<void> {
    const objective = String(known ?? this.state.goal.text ?? "").trim();
    if (!objective) { return; }
    if (this.turnActive) {
      this.post({ type: "goal_control_state", state: "error",
                  error: "Finish or stop the current turn before resuming the goal." });
      return;
    }
    const be = this.ensureBackend();
    try {
      // The backend owns resuming now: it reactivates the goal and continues the run. Sending the
      // objective as a prompt used to replay days-old text into the chat as though the user had
      // just typed it, and the model read it as a new request.
      const accepted = be.send({ type: "resume_goal" });
      if (!accepted) { throw new Error("The backend did not accept the resumed goal turn."); }
      // The panel asked for this, so its own view reflects it immediately. Waiting for the
      // backend's goal_changed to arrive would leave a window where the goal still reads
      // "paused" here -- and an edit landing in that window would save the revision and then
      // decline to continue, because it decides whether to resume from this very field.
      this.state.goal = { ...this.state.goal, status: "active" };
      this.turnActive = true;
      this.post({ type: "goal_start_state", state: "started" });
    } catch (err: any) {
      this.post({ type: "goal_control_state", state: "error",
                  error: err?.message || "DGC could not resume the goal." });
    }
  }

  private async clearGoal(): Promise<void> {
    const be = this.ensureBackend();
    try {
      await this.stopActiveTurn(be);
      await this.requestState(be, "goal", {
        type: "set_goal", text: "", status: "none",
      }, "goal_changed", 10000);
    } catch (err: any) {
      this.post({ type: "goal_control_state", state: "error",
                  error: err?.message || "DGC could not clear the goal." });
    }
  }

  /** Goal mutations are deliberately unavailable while the agent worker owns the session.
   * Observe the terminal turn event before persisting pause/clear so the control cannot race the
   * backend's busy gate and leave a still-active goal behind. */
  private async stopActiveTurn(be: DgcBackend): Promise<void> {
    if (!this.turnActive) { return; }
    await new Promise<void>((resolveStop, rejectStop) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        be.off("event", onEvent);
        be.off("exit", onExit);
        if (error) { rejectStop(error); } else { resolveStop(); }
      };
      const onEvent = (event: DgcEvent) => {
        if (event.type === "turn_end") { finish(); }
        else if (event.type === "error" && event.fatal) {
          finish(new Error(String(event.message || "The active DGC turn failed while stopping.")));
        }
      };
      const onExit = () => finish(new Error("The DGC backend exited while stopping the active turn."));
      const timer = setTimeout(() => finish(new Error("DGC did not finish stopping the active turn.")), 15000);
      be.on("event", onEvent);
      be.once("exit", onExit);
      if (!be.send({ type: "cancel" })) {
        finish(new Error("The DGC backend did not accept the stop request."));
      }
    });
    // Resolving here means turn_end has arrived, so the turn is over by definition. The panel's
    // own event handler also clears these, but it and the listener above observe the same event in
    // an order we do not control -- and a caller that stops a turn in order to do something next
    // must not find a stale "a turn is running" flag when it gets here.
    this.turnActive = this.confirmedTurnActive = false;
  }

  private activeSubscription(): any | undefined {
    if (!this.routeState.subscriptionEngine) { return undefined; }
    return this.routeState.subscriptionEngines.find(
      (item) => item && item.key === this.routeState.subscriptionEngine);
  }

  private syncActiveRouteState(): void {
    const engine = this.routeState.subscriptionEngine;
    this.state.subscriptionEngine = engine;
    if (!engine) {
      this.state.model = this.routeState.nativeModel;
      this.state.think = this.routeState.nativeThink;
      return;
    }
    const info = this.activeSubscription();
    const short = String(info?.label || engine).split(" (")[0];
    this.state.model = this.routeState.subscriptionModel || `${short} default`;
    this.state.think = this.routeState.subscriptionEffort || "off";
  }

  private modelCommand(model: string): { command: any; response: DgcEvent["type"] } {
    return this.routeState.subscriptionEngine
      ? { command: { type: "set_config", values: { subscription_model: model } },
          response: "config" }
      : { command: { type: "set_model", route: "native", model }, response: "model_changed" };
  }

  private thinkCommand(level: string): { command: any; response: DgcEvent["type"] } {
    return this.routeState.subscriptionEngine
      ? { command: { type: "set_config",
                     values: { subscription_effort: level === "off" ? "" : level } },
          response: "config" }
      : { command: { type: "set_think", level }, response: "think_changed" };
  }

  /** Keep the backend's external-directory grants identical to the live VS Code
   * workspace. Root mutations are blocked by `dgc serve` during a turn, so one
   * acknowledged update is kept in flight and newer changes are coalesced until
   * the backend is idle. The backend supports the project root plus 32 external
   * roots; keep the editor side within the same explicit bound. */
  private workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders || []).slice(0, 33).map((f) => f.uri.fsPath);
  }

  private syncWorkspaceRoots(be = this.backend, setup = false): void {
    if (!be || be !== this.backend || this.turnActive || this.workspaceRootsInFlight !== undefined
        || !this.workspaceRootsDirty || (!setup && !be.ready)) {
      return;
    }
    const revision = this.workspaceRootsRevision;
    const command = this.stateCommand(
      "workspace-roots", { type: "set_workspace_roots", roots: this.workspaceRoots(),
        ...(this.lastReadyEvent?.capabilities?.question_forms === true ? { question_forms: true } : {}) });
    const accepted = setup || this.initializingBackend === be
      ? be.sendSetup(command)
      : be.send(command);
    if (accepted) {
      this.workspaceRootsInFlight = {
        revision,
        ...(typeof command.request_id === "string" ? { requestId: command.request_id } : {}),
      };
      this.maybeCompleteHandshake(be);
    }
  }

  /** Release queued user commands only after settings are staged and the newest workspace-root
   * grant has received its exact backend acknowledgement. */
  private maybeCompleteHandshake(be: DgcBackend): void {
    if (this.backend !== be || this.initializingBackend !== be || !this.nativeSettingsReady) {
      return;
    }
    // A queued prompt must not cross the setup barrier until the backend has acknowledged the
    // exact root grant. An accepted stdin write is not an acknowledgement: a stale response from
    // an earlier revision/backend must never release commands into the wrong workspace boundary.
    if (this.workspaceRootsInFlight !== undefined) {
      return;
    }
    if (this.workspaceRootsDirty) {
      this.syncWorkspaceRoots(be, true);
      return;
    }
    if (this.sessionRestoreStarted) {
      if (this.sessionRestoreFinished) { this.finishSessionHandshake(be, this.sessionDraftSource); }
      return;
    }
    this.sessionRestoreStarted = true;
    const generation = this.sessionHandshakeGeneration;
    const previous = this.sessionRestoreCandidate;
    if (!previous || previous === this.currentSessionId) {
      this.finishSessionHandshake(be);
      return;
    }
    const command = this.stateCommand("restore-session", { type: "resume_session", path: `${previous}.json` });
    this.sessionRestoreRequestId = command.request_id;
    void be.request(command, "session", 10000, true)
      .then(() => {
        if (this.backend !== be || generation !== this.sessionHandshakeGeneration) { return; }
        this.sessionRestoreFinished = true;
        this.maybeCompleteHandshake(be);
      })
      .catch((error: any) => {
        if (this.backend !== be || generation !== this.sessionHandshakeGeneration) { return; }
        if (!be.ready || String(error?.message || "").includes("timed out")) {
          be.dispose();
          this.post({ type: "event", event: { type: "error",
            message: "Chat restoration did not complete. Your draft is retained; restart DGC to reconnect." } });
          return;
        }
        this.post({ type: "event", event: { type: "info",
          message: "The previous chat is unavailable. DGC opened a new chat and retained its unsent draft." } });
        this.sessionRestoreFinished = true;
        this.sessionDraftSource = previous;
        this.maybeCompleteHandshake(be);
      });
  }

  /** Called by the extension host when folders are added, removed, or reordered. */
  workspaceRootsChanged(): void {
    this.changesRefreshRevision++;
    this.workspaceChanges = [];
    this.reviewDocuments.clear();
    this.workspaceRootsRevision++;
    this.workspaceRootsDirty = true;
    this.syncWorkspaceRoots();
    this.scheduleWorkspaceChanges(0);
  }

  /** Owner-facing inspection runs in the backend's bounded object/file reader. The host never
   * executes repository diff filters, and the webview receives only opaque IDs and display data. */
  private scheduleWorkspaceChanges(delay = 260): void {
    if (this.changesRefreshTimer) { clearTimeout(this.changesRefreshTimer); }
    this.changesRefreshTimer = setTimeout(() => {
      this.changesRefreshTimer = undefined;
      void this.refreshWorkspaceChanges();
    }, Math.max(0, delay));
  }

  private async collectWorkspaceChanges(chat = false): Promise<{ files: WorkspaceChange[]; total: number; notices: string[] }> {
    const be = this.backend;
    const sessionId = this.currentSessionId;
    if (chat && !this.lastReadyEvent?.capabilities?.chat_inspection) {
      return { files: [], total: 0, notices: ["Update DGC CLI to review changes recorded during this chat."] };
    }
    if (this.workspaceRootsInFlight || this.workspaceRootsDirty) {
      return { files: [], total: 0, notices: ["Workspace changes are waiting for the current folder access to be confirmed."] };
    }
    if (!be?.ready || !this.lastReadyEvent?.capabilities?.workspace_inspection) {
      return { files: [], total: 0, notices: [be?.ready
        ? "Update the DGC CLI to inspect workspace changes."
        : "Workspace changes will be available when DGC reconnects."] };
    }
    const allFolders = vscode.workspace.workspaceFolders || [];
    const notices = allFolders.length > 16 ? ["Only the first 16 workspace folders were scanned."] : [];
    const folders = (await Promise.all(allFolders.slice(0, 16).map(async folder => ({
      name: folder.name, path: await realpath(folder.uri.fsPath).catch(() => ""),
    })))).filter(folder => {
      if (!folder.path) notices.push(`${folder.name}: workspace folder is unavailable.`);
      return !!folder.path;
    });
    // An overlapping folder already belongs to its parent report; counting both would duplicate
    // files and make the total inaccurate. Preserve the first label for duplicate folder roots.
    const scopes = folders.filter((folder, index) => !folders.some((other, otherIndex) =>
      otherIndex !== index && ((other.path === folder.path && otherIndex < index)
        || folder.path.startsWith(other.path + sep))));
    const changes = new Map<string, WorkspaceChange>();
    const reported = new Set<string>();
    let total = 0;
    try {
      const result = await be.request({ type: chat ? "get_chat_changes" : "get_workspace_changes", request_id: this.nextRequestId("changes") },
        chat ? "chat_changes" : "workspace_changes", 30000);
      if (be !== this.backend || (result.type !== "workspace_changes" && result.type !== "chat_changes")
          || (chat && (result.type !== "chat_changes" || result.session_id !== sessionId || sessionId !== this.currentSessionId))) return { files: [], total: 0, notices };
      for (const report of result.roots.slice(0, 16)) {
        const folder = scopes.find(item => typeof report?.root === "string" && item.path === report.root);
        if (!folder || !Array.isArray(report.files) || reported.has(folder.path)) continue;
        reported.add(folder.path);
        if (report.complete !== true && !report.notices?.length) {
          notices.push(`${folder.name}: changes could not be inspected completely.`);
        }
        notices.push(...(Array.isArray(report.notices) ? report.notices.slice(0, 8).map((value: unknown) =>
          `${folder.name}: ${String(value).slice(0, 500)}`) : []));
        total += Number.isSafeInteger(report.total) ? Math.max(0, Math.min(4096, report.total)) : report.files.length;
        for (const row of report.files.slice(0, 500)) {
          if (typeof row?.path !== "string" || !row.path || row.path.length > 4096 || isAbsolute(row.path)) continue;
          const absolute = resolve(folder.path, row.path);
          if (!absolute.startsWith(folder.path + sep)) continue;
          const id = createHash("sha256").update(absolute).digest("hex").slice(0, 24);
          changes.set(absolute, {
            id, root: folder.path, folder: folder.name, path: row.path,
            displayPath: scopes.length > 1 ? `${folder.name}/${row.path}` : row.path,
            additions: Number.isSafeInteger(row.additions) ? Math.max(0, row.additions) : 0,
            deletions: Number.isSafeInteger(row.deletions) ? Math.max(0, row.deletions) : 0,
            binary: row.binary === true, counted: row.counted === true, staged: row.staged === true,
            untracked: row.untracked === true, deleted: row.deleted === true,
            error: typeof row.error === "string" ? row.error.slice(0, 500) : "",
          });
        }
      }
      for (const folder of scopes) {
        if (!chat && !reported.has(folder.path)) notices.push(`${folder.name}: no change report was returned.`);
      }
    } catch (error) {
      notices.push(error instanceof Error ? error.message : "Workspace changes could not be inspected.");
    }
    if (changes.size > 500) notices.push(`Showing 500 of ${total} changed files. Line totals cover the displayed files only.`);
    return { files: [...changes.values()].slice(0, 500).sort((a, b) => a.displayPath.localeCompare(b.displayPath)), total, notices };
  }

  private async refreshWorkspaceChanges(): Promise<void> {
    if (this.changesRefreshInFlight) { this.changesRefreshDirty = true; return; }
    this.changesRefreshInFlight = true;
    const revision = ++this.changesRefreshRevision;
    try {
      const sessionId = this.currentSessionId;
      const [{ files, total, notices }, chat] = await Promise.all([
        this.collectWorkspaceChanges(), this.collectWorkspaceChanges(true),
      ]);
      if (revision !== this.changesRefreshRevision || sessionId !== this.currentSessionId) return;
      this.chatChanges = chat.files;
      this.post({ type: "chat_changes", sessionId, ...chat,
        additions: chat.files.reduce((sum, item) => sum + item.additions, 0),
        deletions: chat.files.reduce((sum, item) => sum + item.deletions, 0),
        files: chat.files.map(item => ({ id: item.id, path: item.displayPath,
          additions: item.additions, deletions: item.deletions, counted: item.counted,
          binary: item.binary, untracked: item.untracked, deleted: item.deleted, error: item.error })),
      });
      this.workspaceChanges = files;
      this.post({ type: "workspace_changes", total, notices,
        additions: files.reduce((sum, item) => sum + item.additions, 0),
        deletions: files.reduce((sum, item) => sum + item.deletions, 0),
        files: files.map(item => ({ id: item.id, path: item.displayPath,
          additions: item.additions, deletions: item.deletions, counted: item.counted,
          binary: item.binary, untracked: item.untracked, deleted: item.deleted, staged: item.staged,
          error: item.error })),
      });
    } finally {
      this.changesRefreshInFlight = false;
      if (this.changesRefreshDirty) {
        this.changesRefreshDirty = false;
        this.scheduleWorkspaceChanges();
      }
    }
  }

  private async reviewWorkspaceChange(identity: string, chat = false): Promise<void> {
    const matches = (chat ? this.chatChanges : this.workspaceChanges).filter(item => item.id === identity || item.displayPath === identity);
    const change = matches.length === 1 ? matches[0] : undefined;
    if (!change) {
      this.scheduleWorkspaceChanges(0);
      void vscode.window.showInformationMessage("That file is no longer in the workspace change set.");
      return;
    }
    const be = this.backend;
    if (!be?.ready || !this.lastReadyEvent?.capabilities?.workspace_inspection) {
      void vscode.window.showInformationMessage("Update or reconnect the DGC CLI to inspect this change."); return;
    }
    const revision = this.workspaceRootsRevision;
    const sessionId = this.currentSessionId;
    const roots = await Promise.all(this.workspaceRoots().map(root => realpath(root).catch(() => "")));
    if (!roots.includes(change.root)) {
      void vscode.window.showInformationMessage("That change is outside the current workspace."); return;
    }
    try {
      const command = chat
        ? { type: "get_chat_change" as const, root: change.root, path: change.path, session_id: sessionId, request_id: this.nextRequestId("change-preview") }
        : { type: "get_workspace_change" as const, root: change.root, path: change.path, request_id: this.nextRequestId("change-preview") };
      const result = await be.request(command, chat ? "chat_change" : "workspace_change", 30000);
      if (be !== this.backend || revision !== this.workspaceRootsRevision
          || (result.type !== "workspace_change" && result.type !== "chat_change")
          || (chat && (result.type !== "chat_change" || result.session_id !== sessionId || sessionId !== this.currentSessionId))) return;
      if (result.root !== change.root || result.path !== change.path) throw new Error("The change preview no longer matches this file.");
      this.reviewDocuments.clear();
      const id = createHash("sha256").update(`${change.id}:${Date.now()}`).digest("hex").slice(0, 16);
      const leaf = basename(change.path) || "change";
      const left = vscode.Uri.from({ scheme: "dgc-review", authority: id, path: `/before/${leaf}` });
      const right = vscode.Uri.from({ scheme: "dgc-review", authority: id, path: `/after/${leaf}` });
      this.reviewDocuments.set(left.toString(), result.before);
      this.reviewDocuments.set(right.toString(), result.after);
      const label = chat ? "DGC chat changes" : result.kind === "staged" ? "DGC staged review" : "DGC workspace review";
      await vscode.commands.executeCommand("vscode.diff", left, right, `${change.displayPath} (${label})`, { preview: true });
    } catch (error) {
      void vscode.window.showInformationMessage(error instanceof Error ? error.message : "The change preview could not be read.");
      this.scheduleWorkspaceChanges(0);
    }
  }

  /** Structured resources describing what the user is looking at. The backend
   * bounds and labels these as untrusted data instead of concatenating HTML-ish
   * text in the webview or extension host. */
  private editorContext(): any[] {
    try {
      const resources: any[] = [];
      const describe = (uri: vscode.Uri) => {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return { uri: uri.toString(), path: uri.fsPath,
                 relative_path: folder ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath,
                 workspace: folder?.name || "" };
      };
      const ed = vscode.window.activeTextEditor;
      const activeUri = ed && ed.document.uri.scheme === "file" ? ed.document.uri : undefined;
      if (activeUri && ed) {
        resources.push({ type: "active_file", ...describe(activeUri), language: ed.document.languageId });
      }

      const open = new Set<string>();
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input: any = tab.input;
          const uri: vscode.Uri | undefined = input && input.uri;
          if (uri && uri.scheme === "file" && !open.has(uri.toString())) {
            open.add(uri.toString());
            resources.push({ type: "open_file", ...describe(uri) });
          }
        }
      }

      if (ed && activeUri && !ed.selection.isEmpty) {
        const a = ed.selection.start.line + 1, b = ed.selection.end.line + 1;
        const CAP = 8192;
        let sel = ed.document.getText(ed.selection);
        if (sel.length > CAP) { sel = sel.slice(0, CAP); }
        resources.push({ type: "selection", ...describe(activeUri), language: ed.document.languageId,
                         range: { start_line: a, end_line: b }, text: sel });
      }

      const mapDiagnostic = (d: vscode.Diagnostic) => ({
        severity: vscode.DiagnosticSeverity[d.severity], message: d.message.slice(0, 2000),
        source: d.source || "", code: typeof d.code === "object" ? d.code.value : d.code,
        range: { start_line: d.range.start.line + 1, start_character: d.range.start.character + 1,
                 end_line: d.range.end.line + 1, end_character: d.range.end.character + 1 },
      });
      if (activeUri) {
        const diagnostics = vscode.languages.getDiagnostics(activeUri).slice(0, 50).map(mapDiagnostic);
        if (diagnostics.length) {
          resources.push({ type: "diagnostics", ...describe(activeUri), diagnostics });
        }
      }
      // Files this chat touched, not just the one on screen: after editing five files the agent
      // could not see the errors it had just created. Errors and warnings only, bounded.
      const touched = new Set<string>(activeUri ? [activeUri.toString()] : []);
      for (const change of this.chatChanges) {
        if (touched.size >= 9) { break; }
        if (!change.path) { continue; }
        const uri = vscode.Uri.file(isAbsolute(change.path) ? change.path : join(change.root, change.path));
        if (touched.has(uri.toString())) { continue; }
        touched.add(uri.toString());
        const diagnostics = vscode.languages.getDiagnostics(uri)
          .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning).slice(0, 20).map(mapDiagnostic);
        if (diagnostics.length) {
          resources.push({ type: "diagnostics", ...describe(uri), diagnostics });
        }
      }
      return resources.slice(0, 64);
    } catch {
      return [];
    }
  }

  private ensureBackend(): DgcBackend {
    if (vscode.workspace.isTrusted === false) {
      throw new Error("DGC is disabled until this workspace is trusted.");
    }
    if (this.backend) {
      return this.backend;
    }
    const executable = resolveDgcExecutable();
    if (executable.ignoredWorkspaceOverride && !this.commandOverrideWarningShown) {
      this.commandOverrideWarningShown = true;
      void vscode.window.showWarningMessage(
        "DGC ignored a workspace-level dgc.command override. Configure the executable in User Settings.");
    }
    const cmd = executable.command;
    const saved = this.context.workspaceState.get<{ scope?: string; id?: string }>("dgc.activeSession.v1");
    this.sessionRestoreCandidate = saved?.scope === this.draftScope() && /^[A-Za-z0-9_-]{1,128}$/.test(saved.id || "")
      ? saved.id! : "";
    this.sessionRestoreStarted = false;
    this.sessionReady = false;
    const be = new DgcBackend(this.cwd(), cmd);
    be.on("event", (ev: DgcEvent) => this.onEvent(ev));
    be.on("stderr", (line: string) => this.post({ type: "stderr", line }));
    be.on("exit", (code: number | null) => {
      this.mcpUrls.clear();
      this.setReadyContext(false);
      if (this.backend === be) {
        this.changesRefreshRevision++;
        this.workspaceChanges = [];
        this.sessionReady = false;
        this.turnActive = this.confirmedTurnActive = false;
        this.correlatedStateRequests = false;
        this.workspaceRootsInFlight = undefined;
        this.workspaceRootsDirty = true;
        this.initializingBackend = undefined;
        this.nativeSettingsReady = false;
      }
      this.post({ type: "backend_exit", code });
    });
    be.start();
    this.backend = be;
    return be;
  }

  restart(): void {
    this._installPrompted = false;      // a fresh start earns a fresh prompt if the CLI is still missing
    this._updatePrompted = false;
    this.setReadyContext(false);
    this.changesRefreshRevision++;
    this.workspaceChanges = [];
    this.backend?.dispose();
    this.backend = undefined;
    this.mcpUrls.clear();
    this.turnActive = this.confirmedTurnActive = false;
    this.correlatedStateRequests = false;
    this.workspaceRootsInFlight = undefined;
    this.workspaceRootsDirty = true;
    this.initializingBackend = undefined;
    this.nativeSettingsReady = false;
    this.routeState.subscriptionEngine = "";
    this.routeState.subscriptionModel = "";
    this.routeState.subscriptionEffort = "";
    this.routeState.subscriptionEngines = [];
    this.ensureBackend();
    this.post({ type: "cleared" });
  }

  private onEvent(ev: DgcEvent): void {
    // The request handlers project summaries and open text documents. Raw roots and file bodies
    // are owner-facing host data, not chat events or model inputs for the webview.
    if (ev.type === "chat_changes" || ev.type === "chat_change" || ev.type === "workspace_changes" || ev.type === "workspace_change"
        || (ev.type === "command_rejected" && ["get_workspace_changes", "get_workspace_change", "get_chat_changes", "get_chat_change"].includes(ev.command))) return;
    switch (ev.type) {
      case "ready":
        this.sessionReady = false;
        this.sessionRestoreStarted = false;
        this.sessionRestoreFinished = false;
        this.sessionRestoreRequestId = undefined;
        this.sessionDraftSource = "";
        this.sessionHandshakeGeneration++;
        {
          const saved = this.context.workspaceState.get<{ scope?: string; id?: string }>("dgc.activeSession.v1");
          this.sessionRestoreCandidate = saved?.scope === this.draftScope() && /^[A-Za-z0-9_-]{1,128}$/.test(saved.id || "")
            ? saved.id! : "";
        }
        this.lastReadyEvent = ev;
        this.currentSessionId = String(ev.session_id || "");
        this.currentSessionName = String(ev.session_name || "");
        this.turnActive = this.confirmedTurnActive = false;
        this.workspaceRootsInFlight = undefined;
        this.workspaceRootsDirty = true;
        this.correlatedStateRequests = ev.capabilities?.correlated_state_requests === true;
        this.composerSelections = ev.capabilities?.composer_selections === true;
        this.skillManagement = ev.capabilities?.skill_management === true;
        this.mcpContext = ev.capabilities?.mcp_context === true;
        this.mcpManagement = ev.capabilities?.mcp_management === true;
        this.goalInputs = ev.capabilities?.goal_inputs === true;
        this.routeState.nativeModel = String(ev.model || "");
        this.routeState.nativeThink = String(ev.think || "off");
        this.routeState.subscriptionEngine = "";
        this.routeState.subscriptionModel = "";
        this.routeState.subscriptionEffort = "";
        this.routeState.subscriptionEngines = [];
        this.state = { model: ev.model, mode: ev.mode, think: ev.think,
                       ultra: ev.ultra_mode === true, baseUrl: ev.base_url,
                       subscriptionEngine: "",
                       workspaceTrusted: ev.workspace_trusted === true,
                       goal: ev.goal || { text: "", status: "none", elapsed_seconds: 0 } };
        this.routeState.subagentBaseUrl = String(ev.subagent_base_url || "");
        this.routeState.fallbackBaseUrl = String(ev.fallback_base_url || "");
        this.slashAliases.clear();
        for (const command of (Array.isArray(ev.commands) ? ev.commands : [])) {
          if (!command || typeof command !== "object") { continue; }
          const canonical = String((command as any).name || "").toLowerCase();
          if (!canonical) { continue; }
          for (const alias of (Array.isArray((command as any).aliases) ? (command as any).aliases : [])) {
            const normalized = String(alias || "").toLowerCase();
            if (normalized) { this.slashAliases.set(normalized, canonical); }
          }
        }
        this.postState();
        if (this.backend) {
          const backend = this.backend;
          this.initializingBackend = backend;
          this.nativeSettingsReady = false;
          this.syncWorkspaceRoots(backend, true);
          // SecretStorage is asynchronous. Keep user prompts queued until roots and all explicit
          // native settings have reached this exact backend instance.
          void this.applyNativeSettings(backend, true)
            .catch((err: any) => this.post({ type: "event", event: {
              type: "error", message: `Could not initialize DGC editor settings: ${err?.message ?? err}`,
            } }))
            .finally(() => {
              if (this.backend === backend) {
                this.nativeSettingsReady = true;
                this.maybeCompleteHandshake(backend);
              }
            });
        }
        break;
      case "session":
        if (this.initializingBackend && this.sessionRestoreStarted && !this.sessionRestoreFinished
            && this.sessionRestoreRequestId && ev.request_id !== this.sessionRestoreRequestId) { return; }
        if (typeof ev.session_id === "string") {
          this.changesRefreshRevision++;
          this.chatChanges = [];
          this.reviewDocuments.clear();
          this.currentSessionId = ev.session_id;
          this.post({ type: "chat_changes", sessionId: this.currentSessionId, files: [], total: 0 });
          this.currentSessionName = String(ev.name || "");
          this.rememberSession();
        }
        break;
      case "session_named":
        this.currentSessionName = String(ev.name || "");
        break;
      case "model_changed":
        if (this.routeState.subscriptionEngine) {
          this.routeState.subscriptionModel = String(ev.model || "");
        } else {
          this.routeState.nativeModel = String(ev.model || "");
        }
        this.syncActiveRouteState();
        this.state.baseUrl = ev.base_url ?? this.state.baseUrl;
        this.postState();
        break;
      case "mode_changed":
        this.state.mode = ev.mode;
        if (typeof ev.workspace_trusted === "boolean") {
          this.state.workspaceTrusted = ev.workspace_trusted;
        }
        this.postState();
        break;
      case "think_changed":
        if (this.routeState.subscriptionEngine) {
          this.routeState.subscriptionEffort = ev.think === "off" ? "" : String(ev.think || "");
        } else {
          this.routeState.nativeThink = String(ev.think || "off");
        }
        this.syncActiveRouteState();
        this.postState();
        break;
      case "goal_changed":
        this.state.goal = {
          ...(ev.details || {}),
          text: String(ev.goal || ""), status: String(ev.status || "none"),
          elapsed_seconds: Number.isFinite(ev.elapsed_seconds)
            ? Math.max(0, Number(ev.elapsed_seconds)) : this.state.goal.elapsed_seconds,
        };
        this.postState();
        break;
      case "config":
        this.routeState.nativeModel = String(ev.model || "");
        this.routeState.nativeThink = String(ev.think || "off");
        this.routeState.subscriptionEngine = String(ev.subscription_engine || "");
        this.routeState.subscriptionModel = String(ev.subscription_model || "");
        this.routeState.subscriptionEffort = String(ev.subscription_effort || "");
        this.routeState.subscriptionEngines = Array.isArray(ev.subscription_engines)
          ? ev.subscription_engines : [];
        this.routeState.subagentBaseUrl = String(ev.subagent_base_url || "");
        this.routeState.fallbackBaseUrl = String(ev.fallback_base_url || "");
        this.behaviorState.showReasoning = ev.show_reasoning !== false;
        this.behaviorState.preserveThinking = ev.preserve_thinking === true;
        this.behaviorState.codeAction = ev.code_action === true;
        this.state.ultra = ev.ultra_mode === true;
        this.state.baseUrl = String(ev.base_url || this.state.baseUrl);
        this.state.mode = String(ev.mode || this.state.mode);
        this.syncActiveRouteState();
        this.postState();
        break;
      case "mcp_input_request":
        if (ev.kind === "elicitation" && ev.payload?.mode === "url") {
          this.mcpUrls.set(String(ev.id), { url: String(ev.payload.url || ""),
            ...(typeof ev.payload._dgc_bridge_callback === "string"
              ? { callbackUrl: ev.payload._dgc_bridge_callback } : {}) });
        }
        break;
      case "workspace_roots": {
        const inFlight = this.workspaceRootsInFlight;
        if (!inFlight
            || (inFlight.requestId !== undefined && ev.request_id !== inFlight.requestId)) {
          break;
        }
        this.workspaceRootsInFlight = undefined;
        this.workspaceRootsDirty = inFlight.revision !== this.workspaceRootsRevision;
        this.syncWorkspaceRoots();
        if (this.backend) {
          this.maybeCompleteHandshake(this.backend);
        }
        this.scheduleWorkspaceChanges(0);
        break;
      }
      case "turn_start":
        this.turnActive = this.confirmedTurnActive = true;
        this.turnStartedAt = Date.now();
        break;
      case "handoff_started":
        this.turnActive = this.confirmedTurnActive = true;
        break;
      case "handoff":
        this.turnActive = this.confirmedTurnActive = false;
        this.syncWorkspaceRoots();
        break;
      case "command_rejected":
        if (ev.command === "prompt" || ev.command === "start_goal") {
          this.turnActive = this.confirmedTurnActive;
          this.syncWorkspaceRoots();
        }
        if (ev.command === "set_workspace_roots" && this.workspaceRootsInFlight !== undefined
            && (this.workspaceRootsInFlight.requestId === undefined
                || ev.request_id === this.workspaceRootsInFlight.requestId)) {
          this.workspaceRootsInFlight = undefined;
          this.workspaceRootsDirty = true;
          // A custom slash command can start a worker just before its turn_start event
          // reaches the extension. Preserve the update and retry when that turn ends.
          if (ev.reason === "turn_in_progress") {
            this.turnActive = true;
          }
        }
        break;
      case "request_expired":
        this.mcpUrls.delete(String(ev.id));
        break;
      case "turn_end":
        this.mcpUrls.clear();
        this.turnActive = this.confirmedTurnActive = false;
        this.syncWorkspaceRoots();
        this.notifyTurnEnd(String(ev.reason || "completed"));
        break;
    }
    if (ev.type === "error" && (ev as any).notInstalled) {
      this.promptInstallCli();
    }
    if (ev.type === "error" && (ev as any).cli_outdated) {
      this.promptUpdateCli();
    }
    if (["tool_result", "turn_end", "rewound", "session"].includes(ev.type)) {
      this.scheduleWorkspaceChanges(ev.type === "tool_result" ? 120 : 0);
    }
    this.post({ type: "event", event: ev });
  }

  /** The CLI ('dgc') is missing — offer to install it (the extension drives the CLI). */
  private promptInstallCli(): void {
    if (this._installPrompted) { return; }
    this._installPrompted = true;
    const INSTALL = "Install DGC CLI", SETPATH = "Set dgc.command…", RETRY = "Retry";
    vscode.window.showErrorMessage(
      "DGC needs the `dgc` command-line tool, which isn't installed or on PATH.",
      INSTALL, SETPATH, RETRY,
    ).then((choice) => {
      if (choice === RETRY) {
        this.restart();
      } else if (choice === INSTALL) {
        const term = vscode.window.createTerminal("Install DGC");
        term.show();
        term.sendText("curl -fsSL https://vibedgc.com/install.sh | bash");
        vscode.window.showInformationMessage(
          "Installing the DGC CLI in the terminal. When it finishes, reload the window to connect.");
      } else if (choice === SETPATH) {
        vscode.commands.executeCommand("workbench.action.openSettings", "dgc.command");
      }
    });
  }

  /** The CLI is older than this extension — offer the update instead of only naming the problem.
   *  DGC drives the CLI you installed rather than shipping its own copy, so the fix is one click
   *  and then a restart, not a silent swap of a bundled binary. */
  private promptUpdateCli(): void {
    if (this._updatePrompted) { return; }
    this._updatePrompted = true;
    const UPDATE = "Update DGC CLI", SETPATH = "Set dgc.command…";
    void vscode.window.showErrorMessage(
      "This DGC CLI is older than the DGC extension. Update it to reconnect.", UPDATE, SETPATH,
    ).then((choice) => {
      if (choice === UPDATE) {
        const term = vscode.window.createTerminal("Update DGC");
        term.show();
        term.sendText("curl -fsSL https://vibedgc.com/install.sh | bash");
        void vscode.window.showInformationMessage(
          "Updating the DGC CLI in the terminal. When it finishes, run “DGC: Restart Backend”.",
          "Restart Backend",
        ).then((next) => { if (next === "Restart Backend") { this.restart(); } });
      } else if (choice === SETPATH) {
        void vscode.commands.executeCommand("workbench.action.openSettings", "dgc.command");
      }
    });
  }

  /** A walk-away ping: only for turns over 20 s, only while the panel is not on screen. */
  private notifyTurnEnd(reason: string): void {
    const started = this.turnStartedAt;
    this.turnStartedAt = 0;
    if (!started || !vscode.workspace.getConfiguration("dgc").get<boolean>("notifyOnTurnEnd", false)) return;
    const seconds = Math.round((Date.now() - started) / 1000);
    if (seconds < 20 || this.view?.visible) return;
    const verb = reason === "cancelled" ? "stopped" : reason === "error" ? "failed" : "finished";
    void vscode.window.showInformationMessage(`DGC ${verb} after ${seconds}s`, "Show").then((choice) => {
      if (choice === "Show") this.view?.show?.(true);
    });
  }

  private post(msg: any): void {
    if (process.env.DGC_EXTENSION_TEST_TOKEN) {
      const event = msg?.type === "event" && msg.event && typeof msg.event === "object"
        ? msg.event : undefined;
      this.testPostedMessages.push({
        type: String(msg?.type || ""),
        ...(["workspace_changes", "chat_changes"].includes(msg?.type) ? { fileCount: Array.isArray(msg.files) ? msg.files.length : 0 } : {}),
        ...(event ? { eventType: String(event.type || ""),
          ...(event.id === undefined ? {} : { id: String(event.id) }),
          ...(event.command === undefined ? {} : { command: String(event.command) }) } : {}),
      });
      if (this.testPostedMessages.length > 256) {
        this.testPostedMessages.splice(0, this.testPostedMessages.length - 256);
      }
    }
    this.view?.webview.postMessage(msg);
  }

  /** Installed-host tests use the same boundary as a real webview without exposing a production
   * command. The activation API exists only when the isolated runner supplies an exact token. */
  async testOnlyWebviewMessage(token: string, msg: any): Promise<void> {
    if (!token || token !== process.env.DGC_EXTENSION_TEST_TOKEN) {
      throw new Error("DGC extension test bridge is unavailable");
    }
    await this.onMessage(msg);
  }

  testOnlyPostedMessages(token: string): Array<{ type: string; eventType?: string; id?: string; command?: string; fileCount?: number }> {
    if (!token || token !== process.env.DGC_EXTENSION_TEST_TOKEN) {
      throw new Error("DGC extension test bridge is unavailable");
    }
    return this.testPostedMessages.map((item) => ({ ...item }));
  }
  private postState(): void {
    this.post({ type: "state", state: this.state });
    const profile = this.state.ultra ? "Ultra" : this.state.think;
    this.sb.text = `$(circuit-board) ${this.state.model || "dgc"} · ${profile} · ${this.state.mode}`;
    this.sb.tooltip = `DGC — ${this.state.model || "no model"} · ${profile} reasoning · ${this.state.mode} mode · click to change model`;
    this.sb.show();
  }

  // ---- webview -------------------------------------------------------------
  resolveWebviewView(view: vscode.WebviewView): void {
    const previous = this.view;
    if (previous && previous !== view) {
      // retainContextWhenHidden keeps the abandoned twin alive, so it must say where the
      // conversation went instead of sitting there looking like a second, dead chat.
      try {
        previous.webview.html = this.movedNotice(view.viewType === "dgc.chatSecondary"
          ? "the secondary side bar" : "the activity bar");
      } catch { /* the old view may already be disposed */ }
    }
    this.view = view;
    this.viewType = view.viewType || "dgc.chat";
    this.webviewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => {
      void this.onMessage(msg).catch((err: any) => vscode.window.showErrorMessage(
        err?.message || "DGC could not process that editor request."));
    });
    if (vscode.workspace.isTrusted === false) {
      void vscode.window.showWarningMessage(
        "DGC is disabled in Restricted Mode. Trust this workspace before starting the coding agent.");
      return;
    }
    this.ensureBackend();
    if (this.state.model) {
      this.postState();
    }
  }

  focus(): void {
    // Focus wherever the chat actually is: the activity bar by default, or the secondary side
    // bar once the user has opened it there.
    vscode.commands.executeCommand(`${this.viewType}.focus`);
    this.view?.show?.(true);
  }

  /** Shown in the copy of the view the conversation just left. */
  private movedNotice(where: string): string {
    const css = "font:13px var(--vscode-font-family);color:var(--vscode-descriptionForeground);"
      + "padding:16px;line-height:1.5";
    return `<!DOCTYPE html><html><body style="${css}">DGC is open in ${where}.` +
      ` This copy stays out of the way — close it, or run <b>DGC: Focus Chat</b> to come back.</body></html>`;
  }

  private inVisiblePanel(action: () => void): void {
    this.focus();
    if (this.webviewReady) { action(); return; }
    if (this.pendingWebviewActions.length < 16) { this.pendingWebviewActions.push(action); }
  }

  openCommandMenu(): void {
    this.inVisiblePanel(() => this.post({ type: "command_menu" }));
  }

  openSkills(): void {
    this.inVisiblePanel(() => {
      this.post({ type: "surface_open", surface: "skills" });
      this.ensureBackend().send({ type: "list_skills", request_id: this.nextRequestId("skills") });
    });
  }

  openDocs(): void {
    this.inVisiblePanel(() => {
      this.post({ type: "surface_open", surface: "docs" });
      this.ensureBackend().send({ type: "list_docs", request_id: this.nextRequestId("docs") });
    });
  }

  openMcp(): void {
    this.inVisiblePanel(() => {
      this.post({ type: "surface_open", surface: "mcp" });
      const be = this.ensureBackend();
      be.send({ type: "list_mcp_servers", request_id: this.nextRequestId("mcp-servers") });
      be.send({ type: "list_mcp_tools", request_id: this.nextRequestId("mcp-tools"), limit: 100 });
    });
  }

  openPermissions(): void {
    this.inVisiblePanel(() => {
      this.post({ type: "surface_open", surface: "permissions" });
      this.ensureBackend().send({ type: "list_permissions", request_id: this.nextRequestId("permissions") });
    });
  }

  openHooks(): void {
    this.inVisiblePanel(() => {
      this.post({ type: "surface_open", surface: "hooks" });
      this.ensureBackend().send({ type: "list_hooks", request_id: this.nextRequestId("hooks") });
    });
  }

  openMemory(): void {
    this.inVisiblePanel(() => {
      this.post({ type: "surface_open", surface: "memory" });
      this.ensureBackend().send({ type: "get_memory", request_id: this.nextRequestId("memory") });
    });
  }

  runEditorAction(action: string): void {
    this.inVisiblePanel(() => this.slash(action));
  }

  private async onMessage(msg: any): Promise<void> {
    const be = this.ensureBackend();
    switch (msg.type) {
      case "webviewReady": {
        this.webviewReady = true;
        if (this.lastReadyEvent) {
          this.post({ type: "event", event: { ...this.lastReadyEvent, session_id: this.currentSessionId,
            session_name: this.currentSessionName } });
        }
        if (this.sessionReady) {
          this.post({ type: "session_ready", sessionId: this.currentSessionId });
          if (this.lastReadyEvent?.capabilities?.history_snapshot) {
            be.send({ type: "get_history", request_id: this.nextRequestId("restore-history") });
          }
        }
        const actions = this.pendingWebviewActions.splice(0);
        for (const action of actions) { action(); }
        if (this.state.model) { this.postState(); }
        this.scheduleWorkspaceChanges(0);
        break;
      }
      case "prompt": {
        let text = String(msg.text ?? "");
        const prefixWorkflow = /^\/(plan|review|init)(?:\s+([\s\S]*))?$/i.exec(text.trim());
        const suffixWorkflow = /^([\s\S]*\S)\s+\/(plan|review|init)$/i.exec(text.trim());
        const workflow = (prefixWorkflow?.[1] || suffixWorkflow?.[2] || "").toLowerCase();
        if (workflow) {
          if (!this.lastReadyEvent?.capabilities?.workflows) {
            this.post({ type: "event", event: { type: "error",
              message: "Update the DGC CLI to use plan, review, and project-guide workflows." } });
            this.post({ type: "prompt_rejected", requestId: msg.requestId }); return;
          }
          text = (prefixWorkflow ? prefixWorkflow[2] || "" : suffixWorkflow?.[1] || "").trim();
        }
        if (msg.context !== undefined && (!Array.isArray(msg.context) || msg.context.length > 64
            || msg.context.some((item: any) => !item || typeof item !== "object" || Array.isArray(item)))) {
          this.post({ type: "event", event: { type: "error", message: "Select at most 64 valid context attachments." } });
          this.post({ type: "prompt_rejected", requestId: msg.requestId }); return;
        }
        // Slash commands remain pure command text. Normal prompts carry typed resources
        // separately so display/history and model input cannot be confused.
        const attached = Array.isArray(msg.context)
          ? msg.context.filter((item: any) => item && typeof item === "object").slice(0, 64)
          : [];
        const live = workflow || (text && !text.startsWith("/")) ? this.editorContext() : [];
        const requestId = String(msg.requestId || this.nextRequestId("prompt")).slice(0, 128);
        const selections: { skills?: string[]; templates?: string[] } = {};
        for (const key of ["skills", "templates"] as const) {
          if (Array.isArray(msg[key]) && msg[key].length) {
            if (!this.composerSelections) {
              this.post({ type: "event", event: { type: "error",
                message: "Update the DGC CLI to use attached skills and prompt templates." } });
              this.post({ type: "prompt_rejected", requestId }); return;
            }
            selections[key] = msg[key];
          }
        }
        const accepted = be.send({ type: "prompt", text, images: msg.images, request_id: requestId,
                                   context: [...attached, ...live].slice(0, 64), ...selections,
                                   ...(this.lastReadyEvent?.capabilities?.live_steering
                                     ? { delivery: msg.delivery === "queue" ? "queue" : "steer" } : {}),
                                   ...(workflow ? { workflow: workflow as "plan" | "review" | "init" } : {}) });
        if (!accepted) {
          this.post({ type: "prompt_rejected", requestId });
        } else {
          // Close the small command/turn_start race so a simultaneous folder removal
          // cannot send a mutation that the backend must reject as newly busy.
          this.turnActive = true;
        }
        break;
      }
      case "startGoal":
        // The webview uses this typed route for `objective /goal`, preserving the objective
        // exactly even when it happens to equal a /goal state verb such as "pause".
        void this.startGoal(String(msg.text || ""), msg);
        break;
      case "permission_response":
        be.send({ type: "permission_response", id: msg.id, decision: msg.decision, rule: msg.rule,
                  ...(typeof msg.reason === "string" && msg.reason.trim()
                      ? { reason: msg.reason.trim().slice(0, 2000) } : {}) });
        break;
      case "drop_uris": {
        // files dragged into the chat from the explorer or a tab
        const dropped = (Array.isArray(msg.uris) ? msg.uris : []).slice(0, 16)
          .map((raw: unknown) => { try { return vscode.Uri.parse(String(raw), true); } catch { return undefined; } })
          .filter((u: vscode.Uri | undefined): u is vscode.Uri => !!u && u.scheme === "file");
        this.attachFiles(dropped);
        break;
      }
      case "plan_response":
        if (msg.decision === "auto") {
          const confirm = await vscode.window.showWarningMessage(
            "Full-auto will execute every plan write and shell command without another prompt.",
            { modal: true }, "Enable full-auto");
          if (confirm !== "Enable full-auto") {
            be.send({ type: "plan_response", id: msg.id, decision: "reject",
                      feedback: msg.feedback || "Full-auto was not confirmed; offer a safer execution mode." });
            break;
          }
        }
        be.send({ type: "plan_response", id: msg.id, decision: msg.decision,
                  feedback: msg.feedback });
        break;
      case "options_response":
        be.send({ type: "options_response", id: msg.id,
          ...(msg.answers ? { answers: msg.answers } : { choice: msg.choice }) });
        break;
      case "mcp_input_response": {
        let action = msg.action;
        const id = String(msg.id), request = this.mcpUrls.get(id);
        if (request?.opening && action === "accept") break;
        if (action === "accept" && request) {
          request.opening = true;
          const current = () => this.backend === be && this.mcpUrls.get(id) === request;
          try {
            if (!await openMcpBrowser(request, current)) action = "cancel";
          } catch (error) {
            action = "cancel";
            if (current()) void vscode.window.showInformationMessage(
              error instanceof Error ? error.message : "MCP sign-in could not open. Reconnect the server to retry.");
          }
          if (!current()) break;
        }
        this.mcpUrls.delete(id);
        be.send({ type: "mcp_input_response", id: msg.id, action,
                  content: msg.content });
        break;
      }
      case "cancel":
        this.mcpUrls.clear();
        be.send({ type: "cancel" });
        break;
      case "pauseGoal":
        await this.pauseGoal();
        break;
      case "resumeGoal":
        await this.resumeGoal();
        break;
      case "clearGoal":
        await this.clearGoal();
        break;
      case "updateGoal":
        await this.updateGoal(String(msg.text || ""), msg.tokenBudget);
        break;
      case "reviewGoal":
        be.send(this.stateCommand("goal", { type: "get_goal" }));
        break;
      case "reviewChange":
        await this.reviewWorkspaceChange(String(msg.path || ""), msg.scope === "chat");
        break;
      case "undoTurn":
        await this.undoTurn(String(msg.prompt || ""),
                            Array.isArray(msg.files) ? msg.files.map(String) : []);
        break;
      case "branchChat":
        await this.branchChat(String(msg.prompt || ""));
        break;
      case "rateResponse":
        await this.rateResponse(String(msg.rating || "none"), String(msg.prompt || ""));
        break;
      case "pickModel":
        this.selectModel();
        break;
      case "listModels":
        this.listModels();
        break;
      case "setModel":
        {
          const mutation = this.modelCommand(String(msg.model || ""));
          be.send(this.stateCommand("model", mutation.command));
        }
        break;
      case "connect":
        this.connect();
        break;
      case "setMode":
        void this.requestMode(String(msg.mode));
        break;
      case "setThink":
        {
          const mutation = this.thinkCommand(String(msg.level || "off"));
          be.send(this.stateCommand("think", mutation.command));
        }
        break;
      case "setReasoningProfile":
        await this.setReasoningProfile(String(msg.level || "off"));
        break;
      case "setUltra":
        await this.setUltra(msg.enabled === true);
        break;
      case "compact":
        void this.compactContext();
        break;
      case "openSettings":
        // A surface opened from a settings tab asks to be put back on that tab when it closes.
        this.openSettings(typeof msg.section === "string" ? msg.section : "general");
        break;
      case "saveSettings":
        await this.saveSettings(msg.values || {});
        break;
      case "pickMode":
        this.setMode();
        break;
      case "pickThink":
        this.setThinking();
        break;
      case "getRecall": {
        // Everything compaction folded away is archived beside the session. Forward the request;
        // the backend pages backwards through it and answers with a `recall` event.
        const be = this.backend;
        if (be) {
          const before = Number(msg.before);
          be.send({ type: "get_recall", limit: 50,
                    ...(Number.isSafeInteger(before) && before >= 0 ? { before } : {}) });
        }
        break;
      }
      case "reqFiles":
        this.sendFiles();
        break;
      case "openFile":
        await this.openFile(msg.path, msg.line);
        break;
      case "openExternal":
        if (msg.url) { void this.openSafeExternal(String(msg.url)); }
        break;
      case "getSkill":
        be.send({ type: "get_skill", request_id: this.nextRequestId("skill"), name: String(msg.name || "") });
        break;
      case "requestSkills":
        be.send({ type: "list_skills", request_id: this.nextRequestId("composer-skills") });
        break;
      case "skillsReload":
        be.send({ type: "reload_skills", request_id: this.nextRequestId("skills-reload") });
        break;
      case "skillsManage":
        await this.manageSkillPackage();
        break;
      case "skillToggle":
        if (this.skillManagement && typeof msg.enabled === "boolean") {
          be.send({ type: "set_skill_enabled", request_id: this.nextRequestId("skill-toggle"),
                    name: String(msg.name || ""), enabled: msg.enabled });
        }
        break;
      case "getDoc":
        be.send({ type: "get_doc", request_id: this.nextRequestId("doc"), id: String(msg.id || "") });
        break;
      case "mcpSave":
        await this.saveMcpServer(msg.values || {});
        break;
      case "mcpRemove":
        await this.removeMcpServer(String(msg.name || ""));
        break;
      case "mcpReload":
        await this.reloadMcpServers();
        break;
      case "mcpToggle":
        if (this.mcpManagement && typeof msg.enabled === "boolean") {
          await this.slashText(`/mcp ${msg.enabled ? "enable" : "disable"} ${JSON.stringify(String(msg.name || ""))}`);
        }
        break;
      case "mcpReconnect":
        if (this.mcpManagement) {
          await this.slashText(`/mcp reconnect ${JSON.stringify(String(msg.name || ""))}`);
        }
        break;
      case "mcpContextList":
        if (this.mcpContext) {
          await this.requestMcpContext(be, msg, true);
        }
        break;
      case "mcpContextGet":
        if (this.mcpContext) {
          await this.requestMcpContext(be, msg, false);
        }
        break;
      case "permissionAdd":
        be.send({ type: "add_permission_rule", request_id: this.nextRequestId("permission-add"),
                  action: msg.action, rule: String(msg.rule || "") });
        break;
      case "permissionRemove":
        be.send({ type: "remove_permission_rule", request_id: this.nextRequestId("permission-remove"),
                  action: msg.action, rule: String(msg.rule || "") });
        break;
      case "memoryAdd":
        be.send({ type: "add_memory", request_id: this.nextRequestId("memory-add"),
                  scope: msg.scope, text: String(msg.text || "") });
        break;
      case "listArtifacts":
        be.send(this.stateCommand("artifacts", { type: "list_artifacts" }));
        break;
      case "stopArtifact":
        void this.stopArtifact(String(msg.id || ""));
        break;
      case "copy":
        vscode.env.clipboard.writeText(String(msg.text || ""));
        break;
      case "slash":
        this.slash(msg.action);
        break;
      case "slashText":
        void this.slashText(String(msg.text || ""));
        break;
    }
  }

  private async sendFiles(): Promise<void> {
    const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,out,.venv,.next}/**", 600);
    const multiRoot = (vscode.workspace.workspaceFolders?.length || 0) > 1;
    const files = uris.map((uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      return {
        label: vscode.workspace.asRelativePath(uri, multiRoot),
        uri: uri.toString(),
        path: uri.fsPath,
        relative_path: folder ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath,
        workspace: folder?.name || "",
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
    this.post({ type: "files", files });
  }

  private async openFile(path: string, line?: number): Promise<void> {
    const target = await workspaceFile(path, this.workspaceRoots());
    if (!target) {
      void vscode.window.showInformationMessage("That file is unavailable in the current workspace.");
      return;
    }
    const uri = vscode.Uri.file(target);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const ed = await vscode.window.showTextDocument(doc, { preview: true });
      if (typeof line === "number" && Number.isSafeInteger(line) && line > 0) {
        const pos = new vscode.Position(Math.min(doc.lineCount - 1, line - 1), 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      /* file may not exist on disk */
    }
  }

  private async openSafeExternal(raw: string): Promise<void> {
    try {
      if (raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error("invalid URL");
      const parsed = new URL(raw);
      if (parsed.username || parsed.password || !["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("unsupported external URL");
      }
      await vscode.env.openExternal(vscode.Uri.parse(parsed.toString(), true));
    } catch {
      void vscode.window.showErrorMessage("DGC refused an invalid or unsafe external URL.");
    }
  }

  private managedMcpServers(): ManagedMcpServer[] {
    const value = this.context.globalState.get<ManagedMcpServer[]>("dgc.managedMcpServers.v1", []);
    if (!Array.isArray(value)) {
      void this.context.globalState.update("dgc.managedMcpServers.v1", []);
      return [];
    }
    const safe: ManagedMcpServer[] = [];
    for (const item of value.slice(0, 64)) {
      if (!item || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(item.name)
          || !["stdio", "remote"].includes(item.transport)
          || typeof item.target !== "string" || !item.target || item.target.length > 4096
          || item.target.includes("\0") || !Array.isArray(item.args)
          || !Array.isArray(item.envNames)) { continue; }
      let target = item.target;
      let args: string[];
      let envNames: string[];
      if (item.transport === "remote") {
        const remote = normalizedRemoteMcpUrl(target);
        // Editor-managed remote entries always synthesize one exact `npx -y mcp-remote URL`
        // bridge at runtime. Persisted argv or environment names are an unsupported legacy shape
        // and could otherwise smuggle a credential around the SecretStorage boundary.
        if (!remote || item.args.length !== 0 || item.envNames.length !== 0) { continue; }
        target = remote;
        args = [];
        envNames = [];
      } else {
        args = item.args.filter((arg) => typeof arg === "string"
          && arg.length <= 8192 && !arg.includes("\0")).slice(0, 128);
        if (!persistedMcpArgsSafe(args)) { continue; }
        envNames = item.envNames.filter((name) =>
          typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)).slice(0, 64);
      }
      const logLevel = ["debug", "info", "notice", "warning", "error", "critical", "alert",
        "emergency", "off"].includes(item.logLevel) ? item.logLevel : "warning";
      safe.push({ name: item.name, transport: item.transport, target,
                  args, envNames, logLevel });
    }
    if (JSON.stringify(safe) !== JSON.stringify(value)) {
      // Migrate malformed or pre-hardening definitions out of durable globalState. Literal
      // credentials belong only in SecretStorage and are intentionally not recoverable here. The
      // full-value comparison also removes an otherwise invisible tail beyond the 64-server cap.
      void this.context.globalState.update("dgc.managedMcpServers.v1", safe).then(undefined, () => {
        void vscode.window.showWarningMessage(
          "DGC could not persist the managed MCP safety migration; unsafe entries remain disabled for this session.");
      });
    }
    return safe;
  }

  private mcpSecretKey(name: string): string {
    return `dgc.mcp.${encodeURIComponent(name)}`;
  }

  private async mcpSecrets(item: ManagedMcpServer): Promise<ManagedMcpSecrets> {
    const key = this.mcpSecretKey(item.name);
    const raw = await this.context.secrets.get(key);
    if (!raw) { return {}; }
    let value: any;
    try { value = JSON.parse(raw); }
    catch {
      await this.context.secrets.delete(key);
      return {};
    }
    if (!value || typeof value !== "object" || Array.isArray(value)
        || value.identity !== managedMcpIdentity(item)) {
      // Malformed/pre-fingerprint records and same-name identity changes are intentionally not
      // migrated: replaying any of them could disclose a credential to another executable or URL.
      await this.context.secrets.delete(key);
      return {};
    }
    const env: Record<string, string> = {};
    if (value.env && typeof value.env === "object" && !Array.isArray(value.env)) {
      for (const [envKey, envValue] of Object.entries(value.env).slice(0, 64)) {
        if (/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(envKey) && typeof envValue === "string"
            && envValue.length <= 16_384 && !envValue.includes("\0")) { env[envKey] = envValue; }
      }
    }
    const token = typeof value.token === "string" && value.token.length <= 16_384
      && !value.token.includes("\0") ? value.token : "";
    return { env, token };
  }

  private async storeMcpSecrets(item: ManagedMcpServer, value: ManagedMcpSecrets): Promise<void> {
    const env = value.env && typeof value.env === "object" ? value.env : {};
    if (!Object.keys(env).length && !value.token) {
      await this.context.secrets.delete(this.mcpSecretKey(item.name));
      return;
    }
    await this.context.secrets.store(this.mcpSecretKey(item.name), JSON.stringify({
      identity: managedMcpIdentity(item), env, token: value.token || "",
    }));
  }

  private async restoreRawMcpSecret(name: string, value: string | undefined): Promise<void> {
    const key = this.mcpSecretKey(name);
    if (value === undefined) { await this.context.secrets.delete(key); }
    else { await this.context.secrets.store(key, value); }
  }

  private async removeManagedMcpBackend(be: DgcBackend, name: string, prefix: string): Promise<void> {
    const event = await this.requestState(be, prefix, {
      type: "remove_mcp_server", name,
    }, "mcp_servers", 10000);
    if ((event as any).error) { throw new Error(String((event as any).error)); }
  }

  private async sendManagedMcp(be: DgcBackend, item: ManagedMcpServer,
                               setup = false, suppliedSecrets?: ManagedMcpSecrets,
                               waitForAck = false): Promise<boolean> {
    const secrets = suppliedSecrets ?? await this.mcpSecrets(item);
    const env: Record<string, string> = {};
    for (const name of item.envNames.slice(0, 64)) {
      const value = secrets.env?.[name];
      if (typeof value === "string") { env[name] = value; }
    }
    const hasStoredSecrets = Object.keys(env).length > 0
      || (item.transport === "remote" && Boolean(secrets.token));
    // Secret-free definitions already started from ~/.dgc/config.json. Re-sending them during
    // handshake would unnecessarily restart the process (and can duplicate a remote OAuth flow).
    if (setup && !hasStoredSecrets) { return true; }
    const baseArgs = item.transport === "remote"
      ? ["-y", "mcp-remote", item.target]
      : item.args.slice(0, 128);
    const runtimeArgs = [...baseArgs];
    const envNames = item.envNames.slice(0, 64);
    if (item.transport === "remote" && secrets.token) {
      const tokenName = "DGC_MCP_BEARER_TOKEN";
      env[tokenName] = secrets.token;
      const priorToken = envNames.indexOf(tokenName);
      if (priorToken >= 0) { envNames.splice(priorToken, 1); }
      if (envNames.length >= 64) { envNames.length = 63; }
      envNames.push(tokenName);
      runtimeArgs.push("--header", "Authorization: Bearer ${" + tokenName + "}");
    }
    const common = {
      transport: item.transport, command: item.transport === "remote" ? "npx" : item.target,
      env_names: envNames, url: item.transport === "remote" ? item.target : "",
      log_level: item.logLevel || "warning",
      defer_until_setup: hasStoredSecrets,
      ...(item.transport === "remote" && secrets.token
        ? { auth_env: "DGC_MCP_BEARER_TOKEN" } : {}),
    };
    const command: any = {
      type: "upsert_mcp_server", request_id: this.nextRequestId("mcp-config"), name: item.name,
      runtime: { ...common, args: runtimeArgs, env }, persisted: { ...common, args: baseArgs },
    };
    if (setup) { return be.sendSetup(command); }
    if (this.mcpManagement) {
      command.interactive = true;
      this.post({ type: "mcp_command_started", requestId: command.request_id });
      try {
        const event = await be.request(command, "mcp_servers", 180000);
        this.post({ type: "event", event: { type: "mcp_command_result", request_id: command.request_id,
          output: "", ...((event as any).error ? { error: String((event as any).error) } : {}) } });
        if ((event as any).error) { throw new Error(String((event as any).error)); }
      } catch (error) {
        this.post({ type: "event", event: { type: "mcp_command_result", request_id: command.request_id, output: "",
          error: error instanceof Error ? error.message : "MCP connection failed" } });
        throw error;
      }
      return true;
    }
    if (!waitForAck) { return be.send(command); }
    const event = await be.request(command, "mcp_servers", this.mcpManagement ? 180000 : 15000);
    if ((event as any).error) { throw new Error(String((event as any).error)); }
    return true;
  }

  private async requestMcpContext(be: DgcBackend, msg: any, listing: boolean): Promise<void> {
    const requestId = String(msg.requestId || this.nextRequestId("mcp-context"));
    const event = listing ? "mcp_context_catalog" : "mcp_context";
    const fields = { request_id: requestId, server: String(msg.server || ""), kind: String(msg.kind || "") };
    try {
      await be.request(listing
        ? { type: "list_mcp_context", ...fields }
        : { type: "get_mcp_context", ...fields, identifier: String(msg.identifier || ""), arguments: msg.arguments || {} },
        event, listing ? 30000 : 180000);
    } catch (error) {
      this.post({ type: "event", event: { type: event, ...fields, items: [], text: "", omitted: [],
        identifier: String(msg.identifier || ""), error: error instanceof Error ? error.message : "MCP request failed" } });
    }
  }

  private async saveMcpServer(values: any): Promise<void> {
    const name = String(values.name || "").trim();
    const original = String(values.original_name || name).trim();
    const transport = values.transport === "remote" ? "remote" : "stdio";
    let target = String(values.target || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      void vscode.window.showErrorMessage("MCP server names use 1–64 letters, digits, dots, underscores, or hyphens.");
      return;
    }
    if (!target || target.length > 4096 || target.includes("\0")) {
      void vscode.window.showErrorMessage(transport === "remote" ? "Enter a valid MCP URL." : "Enter an MCP command path.");
      return;
    }
    if (transport === "remote") {
      const remote = normalizedRemoteMcpUrl(target);
      if (!remote) {
        void vscode.window.showErrorMessage(
          "Remote MCP URLs must use HTTPS (or loopback HTTP) without embedded credentials.");
        return;
      }
      target = remote;
    }
    const logLevel = String(values.log_level || "warning").toLowerCase();
    if (!["debug", "info", "notice", "warning", "error", "critical", "alert",
      "emergency", "off"].includes(logLevel)) {
      void vscode.window.showErrorMessage("Choose a supported MCP log level.");
      return;
    }
    const existingManaged = this.managedMcpServers();
    if (!existingManaged.some((item) => item.name === original) && existingManaged.length >= 64) {
      void vscode.window.showErrorMessage("At most 64 editor-managed MCP servers are supported.");
      return;
    }
    const args = String(values.args || "").split(/\r?\n/).map((line) => line.trim())
      .filter(Boolean).slice(0, 128);
    if (args.some((arg) => arg.length > 8192 || arg.includes("\0"))) {
      void vscode.window.showErrorMessage("Each MCP argument must be a bounded single line.");
      return;
    }
    if (transport === "stdio" && !persistedMcpArgsSafe(args)) {
      void vscode.window.showErrorMessage(
        "Store MCP credentials as environment entries so DGC can keep them in SecretStorage.");
      return;
    }
    const clearSecrets = values.clear_secrets === true;
    const previous = existingManaged.find((entry) => entry.name === original);
    const previousAtDestination = existingManaged.find((entry) => entry.name === name);
    if (original !== name && previousAtDestination) {
      void vscode.window.showErrorMessage(
        `An editor-managed MCP server named “${name}” already exists. Choose another name.`);
      return;
    }
    let originalSecrets: ManagedMcpSecrets;
    let destinationSecrets: ManagedMcpSecrets;
    let originalRawSecret: string | undefined;
    let destinationRawSecret: string | undefined;
    try {
      originalSecrets = previous ? await this.mcpSecrets(previous) : {};
      destinationSecrets = original === name
        ? originalSecrets : previousAtDestination ? await this.mcpSecrets(previousAtDestination) : {};
      // Read rollback bytes only after identity verification has purged an unbound/mismatched record.
      originalRawSecret = await this.context.secrets.get(this.mcpSecretKey(original));
      destinationRawSecret = original === name
        ? originalRawSecret : await this.context.secrets.get(this.mcpSecretKey(name));
    } catch (err: any) {
      void vscode.window.showErrorMessage(
        err?.message || "DGC could not read the prior MCP credentials; no server was changed.");
      return;
    }
    const sameCredentialBoundary = Boolean(previous
      && previous.transport === transport
      && previous.target === target
      && JSON.stringify(previous.args) === JSON.stringify(transport === "stdio" ? args : []));
    // A credential belongs to one exact executable/URL boundary. Blank fields preserve it only
    // while that identity is unchanged; renaming the same definition remains safe.
    const savedSecrets = clearSecrets || !sameCredentialBoundary
      ? {} : originalSecrets;
    let env = transport === "stdio" ? { ...(savedSecrets.env || {}) } : {};
    let referencedEnvNames = transport === "stdio" && !clearSecrets
      ? (Array.isArray(values.env_names) ? values.env_names.filter((key: unknown) =>
        typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)).slice(0, 64) : [])
      : [];
    const envText = String(values.env || "").trim();
    if (transport === "stdio" && envText) {
      env = {}; referencedEnvNames = [];
      for (const line of envText.split(/\r?\n/).filter(Boolean).slice(0, 64)) {
        const at = line.indexOf("=");
        const key = (at < 0 ? line : line.slice(0, at)).trim();
        const value = at < 0 ? "" : line.slice(at + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)
            || value.length > 16_384 || value.includes("\0")) {
          void vscode.window.showErrorMessage(
            "MCP environment entries use KEY=value for SecretStorage or KEY for ambient lookup.");
          return;
        }
        if (at < 0) { referencedEnvNames.push(key); } else { env[key] = value; }
      }
    }
    const tokenInput = String(values.token || "");
    const secrets: ManagedMcpSecrets = {
      env, token: transport === "remote" ? (tokenInput || savedSecrets.token || "") : "",
    };
    const declaredEnvNames = [...new Set([...referencedEnvNames, ...Object.keys(env)])].slice(0, 64);
    if (transport === "stdio") {
      secrets.env = Object.fromEntries(
        Object.entries(env).filter(([key]) => declaredEnvNames.includes(key)));
    }
    const item: ManagedMcpServer = {
      name, transport, target, args: transport === "stdio" ? args : [],
      envNames: declaredEnvNames, logLevel,
    };
    const be = this.ensureBackend();
    try {
      await this.sendManagedMcp(be, item, false, secrets, true);
    } catch (err: any) {
      void vscode.window.showErrorMessage(err?.message || "DGC rejected that MCP server.");
      return;
    }
    let managed = existingManaged.filter((entry) => entry.name !== original && entry.name !== name);
    managed.push(item);
    if (original !== name) {
      try {
        await this.removeManagedMcpBackend(be, original, "mcp-rename-remove-old");
      } catch (err: any) {
        let restored = false;
        try {
          if (previousAtDestination) {
            await this.sendManagedMcp(be, previousAtDestination, false, destinationSecrets, true);
          } else {
            await this.removeManagedMcpBackend(be, name, "mcp-rename-remove-new");
          }
          restored = true;
        } catch { /* report the incomplete compensation below */ }
        void vscode.window.showErrorMessage(
          `${err?.message || "DGC could not remove the old MCP server."}${restored
            ? " The new backend entry was rolled back; local settings were not changed."
            : " DGC could not roll back the new backend entry; reload MCP servers before continuing."}`);
        return;
      }
    }
    try {
      await this.context.globalState.update("dgc.managedMcpServers.v1", managed.slice(0, 64));
      await this.storeMcpSecrets(item, secrets);
      if (original !== name) { await this.context.secrets.delete(this.mcpSecretKey(original)); }
    } catch (err: any) {
      let localRestored = false;
      let backendRestored = false;
      try {
        await this.context.globalState.update("dgc.managedMcpServers.v1", existingManaged);
        await this.restoreRawMcpSecret(name, destinationRawSecret);
        if (original !== name) { await this.restoreRawMcpSecret(original, originalRawSecret); }
        localRestored = true;
      } catch { /* retain the original storage failure */ }
      try {
        if (previousAtDestination) {
          await this.sendManagedMcp(be, previousAtDestination, false, destinationSecrets, true);
        } else {
          await this.removeManagedMcpBackend(be, name, "mcp-save-rollback-new");
        }
        if (original !== name && previous) {
          await this.sendManagedMcp(be, previous, false, originalSecrets, true);
        }
        backendRestored = true;
      } catch { /* surface rollback status without hiding the persistence error */ }
      void vscode.window.showErrorMessage(
        `${err?.message || "DGC could not persist that MCP server."} `
        + (localRestored && backendRestored
          ? "The prior MCP settings were restored."
          : "DGC could not fully restore prior MCP state; reload MCP servers before continuing."));
    }
  }

  private async removeMcpServer(name: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) { return; }
    const confirm = await vscode.window.showWarningMessage(
      `Remove MCP server “${name}”?`, { modal: true }, "Remove server");
    if (confirm !== "Remove server") { return; }
    const existingManaged = this.managedMcpServers();
    const previous = existingManaged.find((item) => item.name === name);
    if (!previous) { return; }
    let previousSecrets: ManagedMcpSecrets;
    let previousRawSecret: string | undefined;
    try {
      previousSecrets = await this.mcpSecrets(previous);
      previousRawSecret = await this.context.secrets.get(this.mcpSecretKey(name));
    } catch (err: any) {
      void vscode.window.showErrorMessage(
        err?.message || "DGC could not read the prior MCP credentials; no server was removed.");
      return;
    }
    const be = this.ensureBackend();
    try {
      await this.removeManagedMcpBackend(be, name, "mcp-remove");
    } catch (err: any) {
      void vscode.window.showErrorMessage(err?.message || "DGC could not remove that MCP server.");
      return;
    }
    try {
      await this.context.globalState.update("dgc.managedMcpServers.v1",
        existingManaged.filter((item) => item.name !== name));
      await this.context.secrets.delete(this.mcpSecretKey(name));
    } catch (err: any) {
      let restored = false;
      try {
        await this.context.globalState.update("dgc.managedMcpServers.v1", existingManaged);
        await this.restoreRawMcpSecret(name, previousRawSecret);
        await this.sendManagedMcp(be, previous, false, previousSecrets, true);
        restored = true;
      } catch { /* make an incomplete rollback explicit below */ }
      void vscode.window.showErrorMessage(
        `${err?.message || "DGC could not persist MCP removal."} ${restored
          ? "The server and its prior local settings were restored."
          : "DGC could not fully restore prior MCP state; reload MCP servers before continuing."}`);
    }
  }

  private async reloadMcpServers(): Promise<void> {
    if (this.mcpManagement) {
      await this.slashText("/mcp reconnect");
      return;
    }
    const be = this.ensureBackend();
    be.send({ type: "reload_mcp_servers", request_id: this.nextRequestId("mcp-reload") });
    for (const item of this.managedMcpServers()) { await this.sendManagedMcp(be, item); }
    be.send({ type: "list_mcp_tools", request_id: this.nextRequestId("mcp-tools"), limit: 100 });
  }

  private slash(action: string): void {
    switch (action) {
      case "workflow:plan":
      case "workflow:review":
      case "workflow:init":
        this.post({ type: "workflow_draft", name: action.slice("workflow:".length) }); break;
      case "pickModel": this.selectModel(); break;
      case "connect": this.connect(); break;
      case "pickMode": this.setMode(); break;
      case "pickThink": this.setThinking(); break;
      case "toggleUltra": void this.setUltra(!this.state.ultra).catch((err: any) =>
        vscode.window.showErrorMessage(err?.message || "DGC could not change the Ultra profile.")); break;
      case "resume": this.resume(); break;
      case "new": this.newSession(); break;
      case "compact": void this.compactContext(); break;
      case "clear": this.ensureBackend().send(
        this.stateCommand("session-clear", { type: "clear_session" })); break;
      case "rewind": this.rewind(); break;
      case "branchChat": void this.branchChat(""); break;
      case "retainedTasks": void this.retainedTasks(); break;
      case "subagent": this.openSettings("agents"); break;
      case "settings": this.openSettings(); break;
      case "securitySettings": this.openSettings("security"); break;
      case "bug": void this.openSafeExternal("https://github.com/OpenPeach-ai/dgc/issues"); break;
      case "viewPlan": this.ensureBackend().send(
        this.stateCommand("plan", { type: "get_plan" })); break;
      case "artifacts": this.ensureBackend().send(
        this.stateCommand("artifacts", { type: "list_artifacts" })); break;
      case "status": this.ensureBackend().send(
        this.stateCommand("status", { type: "status" })); break;
      case "goal": this.ensureBackend().send(
        this.stateCommand("goal", { type: "get_goal" })); break;
      case "skills": this.openSkills(); break;
      case "hooks": this.openHooks(); break;
      case "docs": this.openDocs(); break;
      case "mcp": this.openMcp(); break;
      case "permissions": this.openPermissions(); break;
      case "memory": this.openMemory(); break;
      case "commandMenu": this.openCommandMenu(); break;
      case "toggleThoughts": this.ensureBackend().send(this.stateCommand("thoughts", {
        type: "set_config", values: { show_reasoning: !this.behaviorState.showReasoning },
      })); break;
      case "togglePreserveThinking": this.ensureBackend().send(this.stateCommand("preserve-thinking", {
        type: "set_config", values: { preserve_thinking: !this.behaviorState.preserveThinking },
      })); break;
      case "toggleCodeAction": this.ensureBackend().send(this.stateCommand("code-action", {
        type: "set_config", values: { code_action: !this.behaviorState.codeAction },
      })); break;
      case "nameSession": void this.nameSession(); break;
      case "skill": this.openSkills(); break;
      case "update": vscode.commands.executeCommand("dgc.updateCli"); break;
      case "handoff": {
        const accepted = this.ensureBackend().send({
          type: "generate_handoff", request_id: this.nextRequestId("handoff"),
          save: true,
        });
        if (accepted) { this.turnActive = true; }
        break;
      }
    }
  }

  private async slashText(raw: string): Promise<void> {
    const text = raw.trim();
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) { return; }
    const typedName = match[1].toLowerCase(), rest = (match[2] || "").trim();
    const name = this.slashAliases.get(typedName) || typedName;
    const be = this.ensureBackend();
    if (name === "plan" && !rest) {
      await this.requestMode("plan"); return;
    }
    if (["plan", "review", "init"].includes(name)) {
      await this.onMessage({ type: "prompt", text, requestId: this.nextRequestId("workflow") });
      return;
    }
    if (name === "mcp" && rest) {
      if (!this.mcpManagement) {
        this.post({ type: "event", event: { type: "error", message: "Update the DGC CLI to use MCP commands in the editor." } });
        return;
      }
      const requestId = this.nextRequestId("mcp-command");
      this.post({ type: "mcp_command_started", requestId });
      try {
        await be.request({ type: "mcp_command", request_id: requestId, arguments: rest }, "mcp_command_result", 180000);
      } catch (error) {
        this.post({ type: "event", event: { type: "mcp_command_result", request_id: requestId, output: "",
          error: error instanceof Error ? error.message : "MCP command failed" } });
      }
      return;
    }
    if (name === "goal") {
      const low = rest.toLowerCase();
      if (!rest || ["review", "status"].includes(low)) {
        be.send(this.stateCommand("goal", { type: "get_goal" }));
        this.post({ type: "open_goal_review" });
      }
      else if (["clear", "off", "none", "remove", "delete"].includes(low)) {
        await this.clearGoal();
      } else if (["complete", "completed", "done"].includes(low)) {
        await this.stopActiveTurn(be);
        be.send(this.stateCommand("goal", { type: "set_goal", status: "completed" }));
      } else if (["blocked", "block"].includes(low)) {
        await this.stopActiveTurn(be);
        be.send(this.stateCommand("goal", { type: "set_goal", status: "blocked" }));
      } else if (["pause", "paused"].includes(low)) {
        await this.pauseGoal();
      } else if (["resume", "active", "reactivate"].includes(low)) {
        await this.resumeGoal();
      } else {
        await this.startGoal(rest);
      }
      return;
    }
    if (name === "model") {
      if (rest) {
        const mutation = this.modelCommand(rest);
        be.send(this.stateCommand("model", mutation.command));
      } else { await this.selectModel(); }
      return;
    }
    if (name === "mode") {
      if (rest) { await this.requestMode(rest); } else { await this.setMode(); }
      return;
    }
    if (name === "think") {
      const levels = this.routeState.subscriptionEngine
        ? ["off", "low", "medium", "high", "xhigh", "max"]
        : ["off", "low", "medium", "high", "xhigh"];
      if (levels.includes(rest)) {
        const mutation = this.thinkCommand(rest);
        be.send(this.stateCommand("think", mutation.command));
      } else { await this.setThinking(); }
      return;
    }
    if (name === "ultra") {
      const low = rest.toLowerCase();
      if (["on", "true", "1", "yes", "enable", "enabled"].includes(low)) {
        await this.setUltra(true);
      } else if (["off", "false", "0", "no", "disable", "disabled"].includes(low)) {
        await this.setUltra(false);
      } else if (!low || low === "status") {
        this.post({ type: "event", event: { type: "info",
          message: `DGC Ultra is ${this.state.ultra ? "on" : "off"} — /ultra on|off` } });
      } else {
        this.post({ type: "event", event: { type: "error", message: "usage: /ultra [on|off]" } });
      }
      return;
    }
    if (name === "name") {
      if (rest) {
        be.send(this.stateCommand("session-name", { type: "name_session", name: rest }));
      } else { await this.nameSession(); }
      return;
    }
    if (name === "skill") {
      if (rest) {
        const [skillName, ...arguments_] = rest.split(/\s+/);
        this.post({ type: "composer_skill", name: skillName, text: arguments_.join(" ") });
      } else { this.openSkills(); }
      return;
    }
    if (name === "skills" && rest) {
      const parts = rest.split(/\s+/);
      this.post({ type: "surface_open", surface: "skills" });
      if (parts[0] === "reload" && parts.length === 1) {
        be.send({ type: "reload_skills", request_id: this.nextRequestId("skills-reload") });
      } else if (parts[0] === "show" && parts.length === 2) {
        be.send({ type: "get_skill", request_id: this.nextRequestId("skill"), name: parts[1] });
      } else if (["enable", "disable"].includes(parts[0]) && parts.length === 2 && this.skillManagement) {
        be.send({ type: "set_skill_enabled", request_id: this.nextRequestId("skill-toggle"),
                  name: parts[1], enabled: parts[0] === "enable" });
      } else if (parts[0] === "list" && parts.length === 1) {
        be.send({ type: "list_skills", request_id: this.nextRequestId("skills") });
      } else {
        this.post({ type: "event", event: { type: "error",
          message: "Usage: /skills [list|reload|show NAME|enable NAME|disable NAME]. Enable/disable requires an updated DGC CLI." } });
      }
      return;
    }
    if (name === "memory" && rest) {
      const matchMemory = /^add(?:\s+(user|project))?\s+([\s\S]+)$/i.exec(rest);
      if (matchMemory) {
        be.send({ type: "add_memory", request_id: this.nextRequestId("memory-add"),
                  scope: (matchMemory[1] || "project").toLowerCase(), text: matchMemory[2] });
        return;
      }
    }
    if (name === "permissions" && rest) {
      const matchRule = /^(allow|ask|deny)\s+([\s\S]+)$/i.exec(rest);
      if (matchRule) {
        be.send({ type: "add_permission_rule", request_id: this.nextRequestId("permission-add"),
                  action: matchRule[1].toLowerCase(), rule: matchRule[2] });
        return;
      }
    }
    if (name === "sandbox" && rest) {
      const low = rest.toLowerCase();
      if (["on", "off"].includes(low)) {
        be.send(this.stateCommand("sandbox", { type: "set_config", values: { sandbox: low === "on" } }));
        return;
      }
      if (["network on", "network off"].includes(low)) {
        be.send(this.stateCommand("sandbox-network", {
          type: "set_config", values: { sandbox_network: low.endsWith("on") },
        }));
        return;
      }
    }
    const direct: Record<string, string> = {
      "view-plan": "viewPlan", artifact: "artifacts", status: "status", compact: "compact",
      clear: "clear", new: "new", resume: "resume", rewind: "rewind", connect: "connect",
      subagent: "subagent", tasks: "retainedTasks", settings: "settings", bug: "bug",
      skills: "skills", hooks: "hooks", handoff: "handoff", docs: "docs", mcp: "mcp",
      permissions: "permissions", memory: "memory", help: "commandMenu",
      thoughts: "toggleThoughts", "preserve-thinking": "togglePreserveThinking",
      "code-action": "toggleCodeAction",
      sandbox: "securitySettings", context: "status",
      agents: "subagent", update: "update", skill: "skill", name: "nameSession",
    };
    if (direct[name]) { this.slash(direct[name]); return; }
    be.send({ type: "slash_command", text }); // custom command, or a typed unknown-command error
  }

  async resume(): Promise<void> {
    const be = this.ensureBackend();
    const listSessions = async (cmd: any): Promise<any[]> => {
      try {
        const response = await this.requestState(
          be, "sessions", cmd, "sessions", 3000);
        return Array.isArray(response.items) ? response.items : [];
      } catch (err: any) {
        void vscode.window.showErrorMessage(
          err?.message || "DGC could not list saved sessions.");
        return [];
      }
    };
    let items = await listSessions({ type: "list_sessions" });
    if (!items.length) { vscode.window.showInformationMessage("No past DGC sessions in this project."); return; }

    const trash = new vscode.ThemeIcon("trash");
    const qp = vscode.window.createQuickPick<any>();
    qp.placeholder = "Resume a session — trash icon deletes";
    const render = () => {
      qp.items = items.map((s) => ({
        label: s.name ? `${s.name} · ${s.preview}` : (s.preview || s.path),
        description: `${s.when} · ${s.count} msgs`,
        path: s.path,
        buttons: [{ iconPath: trash, tooltip: "Delete this session" }],
      }));
    };
    render();
    return new Promise<void>((resolve) => {
      qp.onDidTriggerItemButton(async (e) => {           // trash icon → delete + refresh the list
        items = await listSessions({ type: "delete_session", path: (e.item as any).path });
        if (!items.length) { qp.hide(); resolve(); return; }
        render();
      });
      qp.onDidAccept(() => {
        const pick = qp.selectedItems[0] as any;
        if (pick) {
          void this.requestState(
            be, "session-resume", { type: "resume_session", path: pick.path }, "session", 5000,
          ).catch((err: any) => vscode.window.showErrorMessage(
            err?.message || "DGC could not resume that session."));
        }
        qp.hide();
      });
      qp.onDidHide(() => { qp.dispose(); resolve(); });
      qp.show();
    });
  }

  /**
   * Undo one turn's edits. The turn is identified by the prompt that opened its recovery point,
   * so a card from further up the transcript refuses rather than rewinding the wrong turn — the
   * failure mode of an "undo" that guesses is losing work the user never asked to lose.
   */
  async undoTurn(prompt: string, files: string[]): Promise<void> {
    const be = this.ensureBackend();
    let items: any[] = [];
    try {
      const response = await this.requestState(
        be, "checkpoints", { type: "list_checkpoints" }, "checkpoints", 2500);
      items = Array.isArray(response.items) ? response.items : [];
    } catch (err: any) {
      void vscode.window.showErrorMessage(
        err?.message || "DGC could not read its recovery points.");
      return;
    }
    // The backend stores the first 70 characters of the prompt, stripped, as the preview.
    const wanted = prompt.trim().slice(0, 70);
    const squash = (value: string) => value.replace(/\s+/g, " ").trim();
    let match: any;
    for (const item of items) {
      const preview = String(item?.preview ?? "");
      if (preview === wanted || (wanted && squash(preview) === squash(wanted))) match = item;
    }
    if (!match || typeof match.index !== "number") {
      void vscode.window.showWarningMessage(
        "DGC can no longer undo that turn — its recovery point has been used or pruned. "
        + "Open Review to see the changes and revert the ones you want.");
      return;
    }
    const count = Number(match.files) || files.length;
    const choice = await vscode.window.showWarningMessage(
      `Undo this turn? DGC restores ${count} file${count === 1 ? "" : "s"} and rewinds the `
      + "conversation to just before this prompt.",
      { modal: true, detail: wanted }, "Undo turn");
    if (choice !== "Undo turn") return;
    let outcome: any;
    try {
      outcome = await this.requestState(
        be, "rewind", { type: "rewind", index: match.index }, "rewound", 5000);
    } catch (err: any) {
      outcome = { message: err?.message || "DGC could not queue the undo." };
    }
    if (outcome?.type === "rewound" && outcome.ok === true) {
      void vscode.window.showInformationMessage(
        `↩ Undone; DGC restored ${outcome.files_restored} file(s).`);
    } else {
      void vscode.window.showErrorMessage(
        outcome?.message || "DGC could not undo the turn; the recovery point was kept.");
    }
  }

  /** Continue in a new chat from this point, leaving the chat it came from as it stands. */
  async branchChat(prompt: string): Promise<void> {
    const be = this.ensureBackend();
    const name = prompt.trim().replace(/\s+/g, " ").slice(0, 60);
    try {
      await this.requestState(
        be, "session", { type: "fork_session", name }, "session", 5000);
    } catch (err: any) {
      void vscode.window.showErrorMessage(
        err?.message || "DGC could not branch this chat into a new one.");
    }
  }

  /**
   * A rating is a private note about this workspace's own history. It is stored in workspace
   * state, is never sent anywhere, and exists so a later session can be asked what went well.
   */
  async rateResponse(rating: string, prompt: string): Promise<void> {
    if (!["up", "down", "none"].includes(rating)) return;
    const key = "dgc.responseRatings";
    const stored = this.context.workspaceState.get<any[]>(key);
    const rows = Array.isArray(stored) ? stored.slice(-199) : [];
    rows.push({ rating, prompt: prompt.trim().slice(0, 200), at: new Date().toISOString() });
    await this.context.workspaceState.update(key, rows);
  }

  async rewind(): Promise<void> {
    const be = this.ensureBackend();
    let items: any[] = [];
    try {
      const response = await this.requestState(
        be, "checkpoints", { type: "list_checkpoints" }, "checkpoints", 2500);
      items = Array.isArray(response.items) ? response.items : [];
    } catch (err: any) {
      void vscode.window.showErrorMessage(
        err?.message || "DGC could not list rewind checkpoints.");
      return;
    }
    if (!items.length) { vscode.window.showInformationMessage("No checkpoints yet — run a turn first."); return; }
    const pick = await vscode.window.showQuickPick(
      items.map((c) => ({ label: c.preview, description: `${c.files} file(s)`, index: c.index })),
      { placeHolder: "Rewind code + conversation to…" });
    if (pick) {
      let outcome: any;
      try {
        outcome = await this.requestState(
          be, "rewind", { type: "rewind", index: (pick as any).index }, "rewound", 5000);
      } catch (err: any) {
        outcome = { message: err?.message || "DGC could not queue the rewind command." };
      }
      if (outcome?.type === "rewound" && outcome.ok === true) {
        vscode.window.showInformationMessage(
          `↩ DGC rewound code + conversation; restored ${outcome.files_restored} file(s).`);
      } else {
        vscode.window.showErrorMessage(
          outcome?.message || "DGC could not complete rewind; the recovery point was retained.");
      }
    }
  }

  async retainedTasks(): Promise<void> {
    const be = this.ensureBackend();
    const request = async (command: any): Promise<any> => {
      try {
        return await this.requestState(
          be, "retained-tasks", command, "retained_tasks", 5000);
      } catch (err: any) {
        return { items: [], errors: [err?.message || "Retained-task request failed."] };
      }
    };
    let response = await request({ type: "list_retained_tasks" });
    let tasks: any[] = Array.isArray(response.items) ? response.items : [];
    if (Array.isArray(response.errors) && response.errors.length) {
      void vscode.window.showWarningMessage(String(response.errors[0]));
    }
    if (!tasks.length) {
      vscode.window.showInformationMessage("No retained DGC sub-agent work for this project.");
      return;
    }

    const applyButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("check"), tooltip: "Apply conflict-free delta",
    };
    const dropButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("trash"), tooltip: "Permanently drop retained work",
    };
    type RetainedPick = vscode.QuickPickItem & { task: any };
    const qp = vscode.window.createQuickPick<RetainedPick>();
    let closed = false;
    let resolving = false;
    const render = () => {
      const total = Number(response.total || tasks.length);
      qp.placeholder = total > tasks.length
        ? `Showing ${tasks.length} of ${total} retained tasks — Enter applies; trash drops`
        : "Retained sub-agent work — Enter applies; trash permanently drops";
      qp.items = tasks.map((task) => {
        const state = task.legacy ? "legacy/manual" : (task.available ? "ready" : "stale");
        const count = Number(task.changed_count || 0);
        const paths = Array.isArray(task.changed_paths) ? task.changed_paths.join(", ") : "";
        const buttons = task.available && !task.legacy ? [applyButton, dropButton] : [dropButton];
        return {
          label: String(task.id || "retained task"),
          description: `${state} · ${count} path(s)`,
          detail: `${String(task.reason || task.problem || "No reason recorded")} · ${paths || task.worktree}`,
          task, buttons,
        };
      });
    };
    const resolveTask = async (task: any, action: "apply" | "drop") => {
      if (resolving || closed) { return; }
      if (action === "apply" && (task.legacy || !task.available)) {
        void vscode.window.showWarningMessage(
          task.legacy
            ? `This older recovery record cannot be auto-applied safely. Inspect ${task.worktree} manually.`
            : `This retained checkout is stale or missing: ${task.problem || task.worktree}`);
        return;
      }
      resolving = true;
      if (action === "drop") {
        const choice = await vscode.window.showWarningMessage(
          `Permanently delete retained task '${task.id}' and its isolated checkout?`,
          { modal: true }, "Drop retained work");
        if (choice !== "Drop retained work") { resolving = false; return; }
      }
      if (!closed) { qp.busy = true; qp.enabled = false; }
      try {
        response = await request({ type: "resolve_retained_task", id: String(task.id), action,
                                   confirm: action === "drop" });
        if (closed) { return; }
        tasks = Array.isArray(response.items) ? response.items : [];
        if (!tasks.length) { qp.hide(); return; }
        render();
      } finally {
        resolving = false;
        if (!closed) { qp.busy = false; qp.enabled = true; }
      }
    };
    render();
    return new Promise<void>((resolve) => {
      qp.onDidAccept(() => {
        const selected = qp.selectedItems[0];
        if (selected) { void resolveTask(selected.task, "apply"); }
      });
      qp.onDidTriggerItemButton((event) => {
        void resolveTask(event.item.task, event.button === dropButton ? "drop" : "apply");
      });
      qp.onDidHide(() => { closed = true; qp.dispose(); resolve(); });
      qp.show();
    });
  }

  // ---- model listing --------------------------------------------------------
  private async deleteSecret(id: "apiKey" | "subagentApiKey" | "fallbackApiKey"): Promise<void> {
    const key = `dgc.${id}`;
    await this.context.secrets.delete(key);
    await this.context.secrets.delete(`${key}.endpoint`);
  }

  private async storeSecret(id: "apiKey" | "subagentApiKey" | "fallbackApiKey",
                            value: string, endpoint: string): Promise<void> {
    const key = `dgc.${id}`;
    await this.context.secrets.store(key, value);
    await this.context.secrets.store(`${key}.endpoint`, endpointId(endpoint));
  }

  private async storedSecret(id: "apiKey" | "subagentApiKey" | "fallbackApiKey",
                             endpoint: string): Promise<string> {
    const key = `dgc.${id}`;
    const saved = await this.context.secrets.get(key);
    const config = vscode.workspace.getConfiguration("dgc");
    const inspected = config.inspect<string>(id);
    // Removed plaintext settings can still exist in old user/workspace files. Only a user-scoped
    // value is eligible for migration; a repository-controlled value must never become a live key.
    const legacy = typeof inspected?.globalValue === "string" ? inspected.globalValue : "";
    const globalSetting = (name: string): string => {
      const value = config.inspect<string>(name)?.globalValue;
      return typeof value === "string" ? value : "";
    };
    const globalBase = globalSetting("baseUrl") || this.state.baseUrl || PROVIDERS.ollama.url;
    const migrationEndpoint = id === "apiKey" ? globalBase
      : id === "subagentApiKey"
        ? (globalSetting("subagentBaseUrl") || this.routeState.subagentBaseUrl || globalBase)
        : (globalSetting("fallbackBaseUrl") || this.routeState.fallbackBaseUrl || globalBase);
    const migrated = !saved && Boolean(legacy);
    if (migrated) {
      await this.storeSecret(id, legacy, migrationEndpoint);
    }

    // One-way compatibility migration from the old plaintext settings. Remove
    // every scope after the value is safely in SecretStorage so it cannot linger
    // in settings.json, workspace files, sync, or configuration exports.
    const oldScopes: Array<[string | undefined, vscode.ConfigurationTarget]> = [
      [inspected?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
      [inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace],
      [inspected?.globalValue, vscode.ConfigurationTarget.Global],
    ];
    // Removed configuration keys can make VS Code reject—or, when its file watcher
    // is unhealthy, never settle—the update even after settings.json was rewritten.
    // Keep each cleanup alive, but never hold the credential/backend handshake forever.
    const removals = oldScopes.filter(([value, target]) => value !== undefined
      && (target !== vscode.ConfigurationTarget.Global || Boolean(saved) || migrated))
      .map(async ([, target]) => {
      try { await config.update(id, undefined, target); }
      catch { /* verify the post-update configuration below */ }
    });
    if (removals.length) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500);
        void Promise.all(removals).then(() => { clearTimeout(timer); resolve(); });
      });
    }
    const remaining = config.inspect<string>(id);
    const plaintextRemains = remaining?.workspaceFolderValue !== undefined
      || remaining?.workspaceValue !== undefined || remaining?.globalValue !== undefined;
    if (plaintextRemains && !this.plaintextSecretWarnings.has(id)) {
      this.plaintextSecretWarnings.add(id);
      void vscode.window.showWarningMessage(
        `DGC secured this key, but VS Code could not remove the legacy plaintext dgc.${id} setting from every scope. Delete that setting manually.`);
    }
    const secret = saved || (migrated ? legacy : "");
    if (!secret) { return ""; }
    // A completed migration just stored both values atomically from this call's
    // perspective; avoid a redundant keyring read on the activation hot path.
    const boundEndpoint = migrated
      ? endpointId(migrationEndpoint)
      : await this.context.secrets.get(`${key}.endpoint`);
    if (!boundEndpoint) {
      await this.deleteSecret(id);
      void vscode.window.showWarningMessage(
        "DGC discarded an unbound provider key. Reconnect that provider to continue.");
      return "";
    }
    if (boundEndpoint !== endpointId(endpoint)) {
      // A workspace can override provider URLs. Fail closed for the active endpoint without letting
      // that workspace erase a user-owned credential that remains valid for its original host.
      void vscode.window.showWarningMessage(
        "DGC did not send a provider key because it is bound to a different endpoint.");
      return "";
    }
    return secret;
  }

  /** Commit provider credentials only after every corresponding backend state command has
   * acknowledged. SecretStorage has no multi-key transaction API, so preserve and restore the
   * exact prior records if a later keyring write fails. */
  private async commitProviderSecrets(changes: ProviderSecretMutation[]): Promise<void> {
    if (!changes.length) { return; }
    const previous = new Map<ProviderSecretId, { value?: string; endpoint?: string }>();
    for (const change of changes) {
      if (previous.has(change.id)) { continue; }
      const key = `dgc.${change.id}`;
      previous.set(change.id, {
        value: await this.context.secrets.get(key),
        endpoint: await this.context.secrets.get(`${key}.endpoint`),
      });
    }
    try {
      for (const change of changes) {
        if (change.remove) {
          await this.deleteSecret(change.id);
        } else {
          await this.storeSecret(change.id, String(change.value || ""), change.endpoint);
        }
      }
    } catch (err) {
      // Best-effort compensation keeps a failed multi-secret save from leaving a mixture of old
      // and new credentials. Missing endpoint bindings fail closed in storedSecret() on restart.
      for (const [id, snapshot] of [...previous.entries()].reverse()) {
        const key = `dgc.${id}`;
        try {
          if (snapshot.value === undefined) { await this.context.secrets.delete(key); }
          else { await this.context.secrets.store(key, snapshot.value); }
          if (snapshot.endpoint === undefined) {
            await this.context.secrets.delete(`${key}.endpoint`);
          } else {
            await this.context.secrets.store(`${key}.endpoint`, snapshot.endpoint);
          }
        } catch { /* retain the original keyring error */ }
      }
      throw err;
    }
  }

  private async fetchModels(): Promise<string[]> {
    const be = this.ensureBackend();
    const requestId = this.nextRequestId("models");
    const ev = await be.request(
      { type: "list_models", request_id: requestId }, "models", 10000);
    if (ev.error) { throw new Error(String(ev.error)); }
    return Array.isArray(ev.ids)
      ? ev.ids.filter((id: unknown): id is string => typeof id === "string").sort()
      : [];
  }

  // in-composer model menu (rendered inside the webview)
  async listModels(): Promise<void> {
    const subscription = this.activeSubscription();
    if (this.routeState.subscriptionEngine) {
      const ids = Array.isArray(subscription?.model_hints)
        ? subscription.model_hints.filter((id: unknown): id is string => typeof id === "string")
        : [];
      if (this.routeState.subscriptionModel
          && !ids.includes(this.routeState.subscriptionModel)) {
        ids.unshift(this.routeState.subscriptionModel);
      }
      this.post({ type: "models", ids, current: this.routeState.subscriptionModel,
                  subscription: true,
                  supportsEffort: subscription?.supports_effort !== false,
                  label: String(subscription?.label || this.routeState.subscriptionEngine) });
      return;
    }
    const base = this.state.baseUrl || PROVIDERS.ollama.url;
    try {
      const ids = await this.fetchModels();
      this.post({ type: "models", ids, current: this.state.model, base, supportsEffort: true });
    } catch {
      this.post({ type: "models", ids: [], base, err: true });
    }
  }

  // ---- native VS Code settings → backend (only explicitly-set values override the CLI config) ---
  async applyNativeSettings(be = this.backend, setup = false): Promise<void> {
    if (!be) { return; }
    const send = (prefix: string, cmd: any) => {
      const command = this.stateCommand(prefix, cmd);
      return setup ? be.sendSetup(command) : be.send(command);
    };
    const c = vscode.workspace.getConfiguration("dgc");
    // Endpoints and the gate command come from the USER scope only: a repository must not be able
    // to redirect the conversation or run a shell command by carrying workspace settings.
    const baseUrl = userScopedString("baseUrl").value;
    const effectiveBase = baseUrl || this.state.baseUrl || PROVIDERS.ollama.url;
    const apiKey = await this.storedSecret("apiKey", effectiveBase);
    const model = c.get<string>("model", "");
    if (baseUrl || apiKey || model) {
      send("model-setup", { type: "set_model", route: "native", base_url: effectiveBase,
                            api_key: apiKey || undefined, model: model || undefined });
    }
    const values: any = {};
    const put = (key: string, cfgKey: string) => { const v = c.get<string>(cfgKey, ""); if (v) { values[key] = v; } };
    put("subagent_model", "subagentModel");
    const subagentBase = userScopedString("subagentBaseUrl").value;
    if (subagentBase) { values.subagent_base_url = subagentBase; }
    put("subagent_api_mode", "subagentApiMode");
    const effectiveSubagentBase = subagentBase || this.routeState.subagentBaseUrl || effectiveBase;
    const subagentKey = await this.storedSecret("subagentApiKey", effectiveSubagentBase);
    if (subagentKey) { values.subagent_api_key = subagentKey; }
    put("fallback_model", "fallbackModel");
    const fallbackBase = userScopedString("fallbackBaseUrl").value;
    if (fallbackBase) { values.fallback_base_url = fallbackBase; }
    put("fallback_api_mode", "fallbackApiMode");
    const effectiveFallbackBase = fallbackBase || this.routeState.fallbackBaseUrl || effectiveBase;
    const fallbackKey = await this.storedSecret("fallbackApiKey", effectiveFallbackBase);
    if (fallbackKey) { values.fallback_api_key = fallbackKey; }
    const cs = c.get<number>("contextSize", 0); if (cs) { values.context_size = cs; }
    const gate = userScopedString("autonomousGate").value; if (gate) { values.autonomous_gate = gate; }
    const gateMax = c.get<number>("autonomousMaxTurns", 0);
    if (gateMax) { values.autonomous_max_turns = gateMax; }
    if (Object.keys(values).length) { send("config-setup", { type: "set_config", values }); }
    // Rehydrate extension-managed MCP credentials from SecretStorage on every backend generation.
    // Only the safe command/URL/env-name shape is persisted in ~/.dgc/config.json.
    for (const item of this.managedMcpServers()) {
      await this.sendManagedMcp(be, item, setup);
    }
  }

  // ---- in-webview settings page --------------------------------------------
  openSettings(section = "general"): void {
    this.inVisiblePanel(() => { void this.loadSettings(section); });
  }

  private async loadSettings(section: string): Promise<void> {
    const be = this.ensureBackend();
    const configReady = this.requestState(
      be, "config-read", { type: "get_config" }, "config", 5000);
    const providers = Object.entries(PROVIDERS).map(([id, p]) =>
      ({ id, label: p.label, url: p.url, needsKey: p.needsKey }));
    let models: string[] = [];
    const modelReady = this.fetchModels().then((ids) => { models = ids; })
      .catch(() => undefined); // endpoint may be down; settings must still open
    try { await configReady; }
    catch (err: any) {
      void vscode.window.showErrorMessage(
        err?.message || "DGC could not read its current settings.");
    }
    await modelReady;
    this.post({ type: "settings_open", providers, models, section });
  }

  async saveSettings(v: any): Promise<void> {
    if (this.settingsSaveInFlight) {
      void vscode.window.showWarningMessage("DGC is already saving settings.");
      return;
    }
    this.settingsSaveInFlight = true;
    let backend: DgcBackend | undefined;
    const appliedStages: string[] = [];
    const previousMode = this.state.mode;
    const previousSubscription = {
      engine: this.routeState.subscriptionEngine,
      model: this.routeState.subscriptionModel,
      effort: this.routeState.subscriptionEffort,
    };
    let stagedKimiMode = false;
    try {
      const be = this.ensureBackend();
      backend = be;
      const baseChanged = Boolean(v.base_url)
        && endpointId(v.base_url) !== endpointId(this.state.baseUrl);
      const subagentBaseChanged = endpointId(v.subagent_base_url)
        !== endpointId(this.routeState.subagentBaseUrl);
      const fallbackBaseChanged = endpointId(v.fallback_base_url)
        !== endpointId(this.routeState.fallbackBaseUrl);
      let apiKey: string | undefined = v.api_key ? String(v.api_key) : undefined;
      let subagentKey: string | undefined = v.subagent_api_key
        ? String(v.subagent_api_key) : undefined;
      let fallbackKey: string | undefined = v.fallback_api_key
        ? String(v.fallback_api_key) : undefined;
      const effectiveBase = String(v.base_url || this.state.baseUrl || PROVIDERS.ollama.url);
      const effectiveSubagentBase = String(v.subagent_base_url || effectiveBase);
      const effectiveFallbackBase = String(v.fallback_base_url || effectiveBase);
      const secretChanges: ProviderSecretMutation[] = [];
      if (apiKey) {
        secretChanges.push({ id: "apiKey", value: apiKey, endpoint: effectiveBase, remove: false });
      } else if (baseChanged) {
        apiKey = "";
        secretChanges.push({ id: "apiKey", endpoint: effectiveBase, remove: true });
      }
      if (subagentKey) {
        secretChanges.push({ id: "subagentApiKey", value: subagentKey,
                             endpoint: effectiveSubagentBase, remove: false });
      } else if (subagentBaseChanged) {
        subagentKey = "";
        secretChanges.push({ id: "subagentApiKey", endpoint: effectiveSubagentBase, remove: true });
      }
      if (fallbackKey) {
        secretChanges.push({ id: "fallbackApiKey", value: fallbackKey,
                             endpoint: effectiveFallbackBase, remove: false });
      } else if (fallbackBaseChanged) {
        fallbackKey = "";
        secretChanges.push({ id: "fallbackApiKey", endpoint: effectiveFallbackBase, remove: true });
      }

      const requestedMode = String(v.mode || this.state.mode || "default");
      if (!MODES.some((mode) => mode.id === requestedMode)) {
        throw new Error("DGC settings contain an unsupported permission mode.");
      }
      const selectedEngine = String(v.subscription_engine || "").trim().toLowerCase();
      if (selectedEngine && !["claude", "codex", "qwen", "kimi", "copilot"].includes(selectedEngine)) {
        throw new Error("DGC settings contain an unsupported subscription engine.");
      }
      if (selectedEngine === "kimi" && requestedMode !== "auto") {
        throw new Error("Kimi prompt mode requires DGC auto mode.");
      }
      const subscriptionEffort = String(v.subscription_effort || "").trim().toLowerCase();
      if ((selectedEngine === "qwen" || selectedEngine === "kimi") && subscriptionEffort) {
        throw new Error(`${selectedEngine} does not expose a subscription effort setting.`);
      }
      // Confirm trust/full-auto before changing any backend or secret state. Applying the mode is
      // kept separate because an active Kimi route must first receive an acknowledged disconnect.
      const approvedMode = requestedMode !== this.state.mode
        ? await this.approveModeChange(requestedMode) : undefined;
      if (requestedMode !== this.state.mode && !approvedMode) { return; }
      const enteringKimiNeedsAutoFirst = selectedEngine === "kimi"
        && this.routeState.subscriptionEngine !== "kimi" && this.state.mode !== "auto";
      const restrictiveModeChange = Boolean(approvedMode)
        && MODE_CAPABILITY_RANK[requestedMode] < MODE_CAPABILITY_RANK[this.state.mode];

      const values: any = {
        subagent_model: v.subagent_model || "", subagent_base_url: v.subagent_base_url || "",
        subagent_api_mode: v.subagent_api_mode || "",
        fallback_model: v.fallback_model || "",
        fallback_base_url: v.fallback_base_url || "",
        fallback_api_mode: v.fallback_api_mode || "",
        api_mode: v.api_mode || "auto", provider_state: v.provider_state || "stateless",
        prompt_cache: v.prompt_cache !== false,
        sandbox: v.sandbox === true, sandbox_network: v.sandbox_network === true,
        show_reasoning: v.show_reasoning !== false, suggest: v.suggest !== false,
        ultra_mode: v.ultra_mode === true,
        plan_artifact: v.plan_artifact !== false,
        artifact_autostart: v.artifact_autostart !== false,
        artifact_in_plan: v.artifact_in_plan === true,
        tool_profile: v.tool_profile === "full" ? "full" : "adaptive",
        max_parallel_tasks: Math.max(1, Math.min(8, Number(v.max_parallel_tasks || 4))),
        thinking: v.think || "off",
        subscription_engine: selectedEngine,
        subscription_model: v.subscription_model || "",
        subscription_effort: subscriptionEffort,
      };
      if (subagentKey !== undefined) { values.subagent_api_key = subagentKey; }
      if (fallbackKey !== undefined) { values.fallback_api_key = fallbackKey; }
      if (v.context_size) { values.context_size = Number(v.context_size); }
      if (v.capability_cache_ttl_s) {
        values.capability_cache_ttl_s = Math.max(1, Number(v.capability_cache_ttl_s));
      }

      const saveConfig = async (prefix: string, configValues: any): Promise<void> => {
        await this.requestState(
          be, prefix, { type: "set_config", values: configValues }, "config", 10000);
        appliedStages.push("configuration");
      };
      const saveNativeModel = async (): Promise<void> => {
        if (!(v.base_url || v.api_key || v.model)) { return; }
        await this.requestState(be, "model-save", {
          type: "set_model", route: "native", base_url: effectiveBase,
          api_key: apiKey, clear_stored_api_key: baseChanged,
          model: v.model || undefined,
        }, "model_changed", 10000);
        if (v.model) { this.routeState.nativeModel = String(v.model); }
        appliedStages.push("native provider");
      };

      if (enteringKimiNeedsAutoFirst) {
        // Validate/apply every independent setting before elevating permissions. The first config
        // keeps the current route because the backend intentionally refuses Kimi outside auto.
        await saveConfig("config-save-before-kimi", {
          ...values,
          subscription_engine: previousSubscription.engine,
          subscription_model: previousSubscription.model,
          subscription_effort: previousSubscription.effort,
        });
        await saveNativeModel();
        await this.commitProviderSecrets(secretChanges);
        if (secretChanges.length) { appliedStages.push("provider credentials"); }
        if (!approvedMode || !await this.applyApprovedModeChange(approvedMode)) {
          void vscode.window.showWarningMessage(
            `DGC applied ${[...new Set(appliedStages)].join(" and ")}, but the permission mode did not change. Review Settings before continuing.`);
          return;
        }
        stagedKimiMode = true;
        appliedStages.push("permission mode");
        // Keep the post-elevation operation minimal: all fallible independent values were already
        // acknowledged, and a failed/ambiguous route switch is compensated in the catch block.
        await saveConfig("config-save-kimi-route", {
          subscription_engine: selectedEngine,
          subscription_model: values.subscription_model,
          subscription_effort: values.subscription_effort,
        });
      } else {
        if (restrictiveModeChange && approvedMode) {
          let disconnectedKimi = false;
          if (previousSubscription.engine === "kimi") {
            // The backend refuses every non-auto mode while Kimi is active. Disconnect only that
            // route first; if lowering fails, restore Kimi while the prior auto mode is intact.
            await saveConfig("config-disconnect-kimi-before-mode", {
              subscription_engine: "", subscription_model: "", subscription_effort: "",
            });
            disconnectedKimi = true;
          }
          if (!await this.applyApprovedModeChange(approvedMode)) {
            let restored = !disconnectedKimi;
            if (disconnectedKimi) {
              try {
                await this.requestState(be, "config-restore-kimi-after-mode-failure", {
                  type: "set_config", values: {
                    subscription_engine: previousSubscription.engine,
                    subscription_model: previousSubscription.model,
                    subscription_effort: previousSubscription.effort,
                  },
                }, "config", 10000);
                restored = true;
              } catch { /* the warning below makes an incomplete restore explicit */ }
            }
            void vscode.window.showWarningMessage(restored
              ? "DGC did not change the permission mode; no other settings were applied."
              : "DGC did not change the permission mode and could not restore the prior Kimi route. Review Settings before continuing.");
            return;
          }
          appliedStages.push("permission mode");
        }
        // Elevations are deliberately last: a rejected sandbox/config/provider setting must never
        // leave a previously guarded workspace in auto/acceptEdits or persist a trust elevation.
        // Restrictive changes run above, as early as the Kimi route invariant permits.
        await saveConfig("config-save", values);
        await saveNativeModel();
        await this.commitProviderSecrets(secretChanges);
        if (secretChanges.length) { appliedStages.push("provider credentials"); }
        if (approvedMode && !restrictiveModeChange
            && !await this.applyApprovedModeChange(approvedMode)) {
          void vscode.window.showWarningMessage(
            `DGC applied ${[...new Set(appliedStages)].join(" and ")}, but the permission mode did not change. Review Settings before continuing.`);
          return;
        }
        if (approvedMode && !restrictiveModeChange) { appliedStages.push("permission mode"); }
      }
      this.routeState.subagentBaseUrl = String(v.subagent_base_url || "");
      this.routeState.fallbackBaseUrl = String(v.fallback_base_url || "");
      void vscode.window.showInformationMessage("DGC settings saved.");
    } catch (err: any) {
      let rollbackNote = "";
      if (stagedKimiMode && backend) {
        let routeRestored = false;
        let modeRestored = false;
        try {
          await this.requestState(backend, "config-rollback-kimi", {
            type: "set_config", values: {
              subscription_engine: previousSubscription.engine,
              subscription_model: previousSubscription.model,
              subscription_effort: previousSubscription.effort,
            },
          }, "config", 10000);
          routeRestored = true;
          modeRestored = await this.applyApprovedModeChange({
            mode: previousMode, acknowledgeWorkspaceTrust: false,
          });
        } catch { /* surface the fail-closed rollback status below */ }
        rollbackNote = routeRestored && modeRestored
          ? " The previous route and permission mode were restored; any explicit workspace-trust confirmation remains recorded."
          : " DGC could not fully restore the previous Kimi route/mode; review Settings before continuing.";
      }
      const detail = err?.message || "DGC settings could not be saved.";
      const partial = appliedStages.length
        ? `Some settings were applied (${[...new Set(appliedStages)].join(", ")}) before the save stopped. `
        : "";
      void vscode.window.showErrorMessage(`${partial}${detail}${rollbackNote}`);
    } finally {
      this.settingsSaveInFlight = false;
    }
  }

  async selectModel(): Promise<void> {
    const be = this.ensureBackend();
    const subscription = this.activeSubscription();
    if (this.routeState.subscriptionEngine) {
      const current = this.routeState.subscriptionModel;
      const label = String(subscription?.label || this.routeState.subscriptionEngine).split(" (")[0];
      const hints = Array.isArray(subscription?.model_hints)
        ? subscription.model_hints.filter((id: unknown): id is string => typeof id === "string")
        : [];
      let selected: string | undefined;
      if (hints.length) {
        const items = [
          { label: "$(circle-slash) CLI default", description: current ? "" : "$(check) current",
            value: "", custom: false },
          ...hints.map((id: string) => ({ label: id,
            description: id === current ? "$(check) current" : "", value: id, custom: false })),
          { label: "$(edit) Enter another model…", description: "vendor model id or alias",
            value: "", custom: true },
        ];
        const pick = await vscode.window.showQuickPick(items, {
          placeHolder: `${label} subscription model`, matchOnDescription: true });
        if (!pick) { return; }
        if (!pick.custom) {
          selected = pick.value;
        }
      }
      if (selected === undefined) {
        const input = await vscode.window.showInputBox({
          prompt: `${label} model override (leave blank to use the CLI default)`,
          value: current, placeHolder: "CLI default",
        });
        if (input === undefined) { return; }
        selected = input.trim();
      }
      try {
        const mutation = this.modelCommand(selected);
        await this.requestState(
          be, "model-select", mutation.command, mutation.response, 10000);
      } catch (err: any) {
        void vscode.window.showErrorMessage(err?.message || "DGC could not switch subscription models.");
      }
      return;
    }
    const base = this.state.baseUrl || PROVIDERS.ollama.url;
    let ids: string[] = [];
    try {
      ids = await this.fetchModels();
    } catch (e: any) {
      const go = await vscode.window.showWarningMessage(
        `Can't reach ${base} — connect a provider?`, "Connect Provider");
      if (go) {
        this.connect();
      }
      return;
    }
    if (!ids.length) {
      vscode.window.showInformationMessage("The endpoint offered no models.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      ids.map((id) => ({ label: id, description: id === this.state.model ? "$(check) current" : "" })),
      { placeHolder: `Model (${base})`, matchOnDescription: true });
    if (pick) {
      try {
        await this.requestState(
          be, "model-select", { type: "set_model", route: "native", model: pick.label }, "model_changed", 10000);
      } catch (err: any) {
        void vscode.window.showErrorMessage(err?.message || "DGC could not switch models.");
      }
    }
  }

  async connect(): Promise<void> {
    const be = this.ensureBackend();
    const items = Object.entries(PROVIDERS).map(([id, p]) => ({ label: id, description: p.label, detail: p.url }));
    items.push({ label: "custom", description: "Custom OpenAI-compatible URL…", detail: "" });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Connect a provider" });
    if (!pick) {
      return;
    }
    let url: string;
    let needsKey = false;
    if (pick.label === "custom") {
      const input = await vscode.window.showInputBox({ prompt: "OpenAI-compatible base URL", value: "http://localhost:11434/v1", validateInput: (v) => (/^https?:\/\/.+/.test(v) ? undefined : "must be a http(s):// URL") });
      if (!input) {
        return;
      }
      url = input;
      needsKey = true;
    } else {
      url = PROVIDERS[pick.label].url;
      needsKey = PROVIDERS[pick.label].needsKey;
    }
    let key: string | undefined;
    if (needsKey) {
      key = await vscode.window.showInputBox({ prompt: `API key for ${pick.label}`, password: true });
      if (key === undefined || (pick.label !== "custom" && !key)) { return; }
    } else {
      key = PROVIDERS[pick.label].apiKey || "sk-local";
    }
    if (key) { await this.storeSecret("apiKey", key, url); }
    else { await this.deleteSecret("apiKey"); }
    try {
      if (pick.label !== "custom") {
        await this.requestState(
          be, "provider-config", { type: "set_config", values: { api_mode: "auto" } },
          "config", 10000);
      }
      if (this.routeState.subscriptionEngine) {
        await this.requestState(
          be, "provider-route", { type: "set_config", values: { subscription_engine: "" } },
          "config", 10000);
      }
      await this.requestState(be, "provider-model", {
        type: "set_model", route: "native", base_url: url, api_key: key, clear_stored_api_key: true,
      }, "model_changed", 10000);
      await this.selectModel();
    } catch (err: any) {
      void vscode.window.showErrorMessage(err?.message || "DGC could not connect that provider.");
    }
  }

  private async manageSkillPackage(): Promise<void> {
    if (!this.skillManagement) { return; }
    const action = await vscode.window.showQuickPick([
      { label: "Create a skill", description: "Scaffold an explicit-only workflow", value: "create_skill" },
      { label: "Install a local skill package", description: "Copy SKILL.md and supporting files", value: "install_skill" },
    ], { placeHolder: "Manage DGC skills" });
    if (!action) { return; }
    const scope = await vscode.window.showQuickPick([
      { label: "This project", value: "project" }, { label: "All projects", value: "user" },
    ], { placeHolder: "Where should this skill be installed?" });
    if (!scope) { return; }
    let command: any;
    if (action.value === "create_skill") {
      const name = await vscode.window.showInputBox({ prompt: "Skill name", placeHolder: "review-api",
        validateInput: (value) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) && !/[._-]$/.test(value)
          ? undefined : "Use 1–64 lowercase letters, digits, hyphens, underscores or dots." });
      if (!name) { return; }
      const description = await vscode.window.showInputBox({ prompt: "When should this skill be used?" });
      if (description === undefined) { return; }
      command = { type: action.value, name, description, scope: scope.value };
    } else {
      const source = await vscode.window.showOpenDialog({ title: "Select a skill package containing SKILL.md",
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Install skill package" });
      if (!source?.length || source[0].scheme !== "file") { return; }
      command = { type: action.value, source: source[0].fsPath, scope: scope.value, allow_external: true };
    }
    const result = await this.requestState(this.ensureBackend(), "skill-package", command, "skill_package", 30000);
    if (result.type === "skill_package") {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(result.path)));
    }
  }

  async setMode(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      MODES.map((m) => ({ label: m.label, detail: m.detail, description: m.id === this.state.mode ? "current" : "", id: m.id })),
      { placeHolder: "Permission mode" });
    if (!pick) {
      return;
    }
    await this.requestMode(pick.id);
  }

  private async approveModeChange(mode: string): Promise<ApprovedModeChange | undefined> {
    if (!MODES.some((m) => m.id === mode)) { return undefined; }
    const mutationMode = mode === "acceptEdits" || mode === "auto";
    const needsTrust = mutationMode && !this.state.workspaceTrusted;
    const needsAutoWarning = mode === "auto" && this.state.mode !== "auto";
    if (needsTrust || needsAutoWarning) {
      const message = needsTrust
        ? (mode === "auto"
          ? "This workspace is not trusted. Full-auto will run every file write and shell command without prompts. Trust it and continue?"
          : "This workspace is not trusted. acceptEdits will apply file changes without prompting. Trust it and continue?")
        : "Full-auto approves every file write and shell command with no prompts. Continue?";
      const action = needsTrust ? "Trust and enable" : "Enable auto";
      const ok = await vscode.window.showWarningMessage(
        message, { modal: true }, action);
      if (ok !== action) {
        this.postState();
        return undefined;
      }
    }
    return { mode, acknowledgeWorkspaceTrust: needsTrust };
  }

  private async applyApprovedModeChange(change: ApprovedModeChange): Promise<boolean> {
    try {
      await this.requestState(this.ensureBackend(), "mode", {
        type: "set_mode", mode: change.mode,
        ...(this.lastReadyEvent?.capabilities?.live_modes ? { live: true } : {}),
        acknowledge_workspace_trust: change.acknowledgeWorkspaceTrust,
      }, "mode_changed", 5000);
      return true;
    } catch (err: any) {
      void vscode.window.showErrorMessage(err?.message || "DGC could not change permission mode.");
      this.postState();
      return false;
    }
  }

  private async requestMode(mode: string): Promise<boolean> {
    const approved = await this.approveModeChange(mode);
    return approved ? this.applyApprovedModeChange(approved) : false;
  }

  async cycleMode(): Promise<void> {
    const order = ["default", "acceptEdits", "plan", "auto"];
    const next = order[(order.indexOf(this.state.mode) + 1) % order.length];
    if (await this.requestMode(next)) {
      vscode.window.setStatusBarMessage(`DGC mode → ${next}`, 1500);
    }
  }

  async setThinking(): Promise<void> {
    const be = this.ensureBackend();
    const subscription = this.activeSubscription();
    const current = this.routeState.subscriptionEngine
      ? (this.routeState.subscriptionEffort || "off") : this.state.think;
    const supportsEffort = !this.routeState.subscriptionEngine
      || subscription?.supports_effort !== false;
    const available = this.routeState.subscriptionEngine && supportsEffort
      ? this.routeState.subscriptionEngine === "codex" ? THINK
        : [...THINK, { id: "max", detail: "maximum session effort where the active model supports it" }]
      : this.routeState.subscriptionEngine ? [THINK[0]] : THINK;
    const profiles = [...available, {
      id: "ultra",
      detail: "deepest reasoning plus proactive bounded sub-agents; permissions stay unchanged",
    }];
    const pick = await vscode.window.showQuickPick(
      profiles.map((t) => ({ label: t.id === "ultra" ? "Ultra"
                                   : this.routeState.subscriptionEngine && t.id === "off"
                                     ? "default" : t.id,
                          detail: t.id === "ultra" ? t.detail
                            : this.routeState.subscriptionEngine && t.id === "off"
                            ? "use the vendor CLI's default effort" : t.detail,
                          description: (t.id === "ultra" ? this.state.ultra
                            : !this.state.ultra && t.id === current) ? "current" : "",
                          level: t.id })),
      { placeHolder: "Model reasoning profile" });
    if (pick) {
      try {
        await this.setReasoningProfile(pick.level, be);
      } catch (err: any) {
        void vscode.window.showErrorMessage(err?.message || "DGC could not change thinking level.");
      }
    }
  }

  private async setUltra(enabled: boolean, be = this.ensureBackend()): Promise<void> {
    await this.requestState(be, "ultra", {
      type: "set_config", values: { ultra_mode: enabled },
    }, "config", 5000);
  }

  private async setReasoningProfile(level: string, be = this.ensureBackend()): Promise<void> {
    if (level === "ultra") {
      await this.setUltra(true, be);
      return;
    }
    if (this.state.ultra) {
      await this.setUltra(false, be);
    }
    const mutation = this.thinkCommand(level);
    await this.requestState(be, "think", mutation.command, mutation.response);
  }

  async newSession(): Promise<void> {
    const be = this.ensureBackend();
    try {
      // The backend cancels a running turn before it resets, and an unwinding turn can take a
      // few seconds, so this waits longer than a plain state mutation would.
      await this.requestState(
        be, "session-new", { type: "new_session" }, "session", 25000);
    } catch (err: any) {
      void vscode.window.showErrorMessage(err?.message || "DGC could not start a new session.");
    }
  }

  async nameSession(): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: "Name this DGC session", placeHolder: "Short descriptive session name",
      validateInput: (value) => value.trim() ? undefined : "Session name cannot be empty",
    });
    if (!name) { return; }
    try {
      await this.requestState(this.ensureBackend(), "session-name",
        { type: "name_session", name: name.trim() }, "session_named", 5000);
    } catch (err: any) {
      void vscode.window.showErrorMessage(err?.message || "DGC could not name this session.");
    }
  }

  addSelection(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) {
      void vscode.window.showInformationMessage("Select some text first — DGC: Add Selection sends the selection.");
      return;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const a = ed.selection.start.line + 1;
    const b = ed.selection.end.line + 1;
    const folder = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    let text = ed.document.getText(ed.selection);
    if (text.length > 8192) { text = text.slice(0, 8192); }
    // Queued until the webview is up: the selection used to be dropped silently when the view
    // had never been opened.
    this.inVisiblePanel(() => this.post({ type: "attach", label: `${rel}:${a}-${b}`, resource: {
      type: "selection", uri: ed.document.uri.toString(), path: ed.document.uri.fsPath,
      relative_path: rel, workspace: folder?.name || "", language: ed.document.languageId,
      range: { start_line: a, end_line: b }, text,
    } }));
  }

  /** DGC: Add File to Chat — from the explorer, a tab, the palette, or a drop. */
  addFiles(uri?: vscode.Uri, uris?: vscode.Uri[]): void {
    const picked = (Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [])
      .filter((u): u is vscode.Uri => !!u && u.scheme === "file");
    const active = vscode.window.activeTextEditor?.document.uri;
    const list = picked.length ? picked : active && active.scheme === "file" ? [active] : [];
    if (!list.length) {
      void vscode.window.showInformationMessage("Open or select a file to add it to DGC.");
      return;
    }
    this.attachFiles(list);
  }

  private attachFiles(list: vscode.Uri[]): void {
    for (const u of list.slice(0, 16)) {
      const folder = vscode.workspace.getWorkspaceFolder(u);
      const rel = folder ? vscode.workspace.asRelativePath(u, false) : u.fsPath;
      this.inVisiblePanel(() => this.post({ type: "attach", label: rel, resource: {
        type: "file_mention", uri: u.toString(), path: u.fsPath, relative_path: rel,
        workspace: folder?.name || "",
      } }));
    }
  }

  dispose(): void {
    if (this.changesRefreshTimer) { clearTimeout(this.changesRefreshTimer); }
    this.changesRefreshDirty = false;
    this.changesRefreshRevision++;
    this.reviewDocuments.clear();
    this.backend?.dispose();
    this.sb.dispose();
  }

  // ---- html ----------------------------------------------------------------
  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2) + String(Date.now());
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const markdown = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "markdown.js"));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "codicon.css"));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;`;
    const draftScope = this.draftScope();
    return `<!doctype html><html lang="en" data-draft-scope="${draftScope}"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DGC</title>
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${css}">
</head><body>
<header id="phead"><span class="pm"><svg class="mk" viewBox="0 0 90 90" fill="currentColor" aria-hidden="true"><path d="M32 24 L20 30 L13 72 L25 66 Z"/><path d="M54 18 L42 24 L35 72 L47 66 Z"/><path d="M76 24 L64 30 L57 66 L69 60 Z"/></svg>DGC<span class="cur" aria-hidden="true"></span></span><button type="button" id="thread-title" class="thread-title" title="Current chat — click to rename" aria-label="Current chat: New chat. Click to rename">New chat</button><button type="button" class="pd" id="pmodel" title="Model — click to change" aria-label="Change model">dgc</button></header>
<main id="log" role="log" aria-live="off" aria-label="DGC conversation"></main>
<button type="button" id="to-latest" title="Jump to the newest message" aria-label="Jump to the newest message" hidden><span class="codicon codicon-arrow-down" aria-hidden="true"></span><span id="to-latest-label">Latest</span></button>
<div id="announcer" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<div id="surface" class="panel-overlay" role="dialog" aria-modal="true" aria-labelledby="surface-title" hidden>
  <div class="set-head">
    <span id="surface-title" class="set-title"><span id="surface-icon" class="codicon codicon-library" aria-hidden="true"></span> <span id="surface-title-text">DGC</span></span>
    <button type="button" id="surface-close" class="fbtn" title="Close" aria-label="Close panel"><span class="codicon codicon-close" aria-hidden="true"></span></button>
  </div>
  <div id="surface-toolbar" class="surface-toolbar">
    <input id="surface-search" type="search" aria-label="Filter items" placeholder="Filter…">
    <button type="button" id="surface-primary" class="act primary" aria-label="Primary panel action" hidden></button>
    <button type="button" id="surface-secondary" class="act" aria-label="Secondary panel action" hidden></button>
  </div>
  <div id="surface-body" class="surface-body" tabindex="-1"></div>
</div>
<div id="changes-review" class="panel-overlay" role="dialog" aria-modal="true" aria-labelledby="changes-review-title" hidden>
  <div class="set-head">
    <span id="changes-review-title" class="set-title"><span class="codicon codicon-diff-multiple" aria-hidden="true"></span> Workspace changes</span>
    <button type="button" id="changes-review-close" class="fbtn" title="Close" aria-label="Close changed files"><span class="codicon codicon-close" aria-hidden="true"></span></button>
  </div>
  <div id="changes-review-description" class="surface-notice"></div>
  <div id="changes-review-summary" class="changes-review-summary"></div>
  <div id="changes-review-list" class="changes-review-list" tabindex="-1"></div>
</div>
<div id="goal-editor" class="modal-layer" role="dialog" aria-modal="true" aria-labelledby="goal-editor-title" hidden>
  <div class="goal-dialog">
    <div class="goal-dialog-mark"><span class="codicon codicon-target" aria-hidden="true"></span></div>
    <button type="button" id="goal-editor-close" class="fbtn goal-dialog-close" title="Close" aria-label="Close goal editor"><span class="codicon codicon-close" aria-hidden="true"></span></button>
    <h2 id="goal-editor-title">Edit goal</h2>
    <label class="sr-only" for="goal-editor-text">Goal</label>
    <textarea id="goal-editor-text" rows="8" aria-label="Goal" maxlength="4000"></textarea>
    <label class="goal-budget">Token budget (optional)<input id="goal-editor-budget" type="number" min="0" max="1000000000000" step="1" placeholder="No limit"></label>
    <div class="goal-dialog-actions"><button type="button" id="goal-editor-cancel" class="act" title="Close without changing the objective">Cancel</button><button type="button" id="goal-editor-save" class="act primary" title="Save the objective and start pursuing it">Save</button></div>
  </div>
</div>
<div id="goal-review" class="modal-layer" role="dialog" aria-modal="true" aria-labelledby="goal-review-title" hidden>
  <div class="goal-dialog">
    <button type="button" id="goal-review-close" class="fbtn goal-dialog-close" aria-label="Close goal review" title="Close"><span class="codicon codicon-close" aria-hidden="true"></span></button>
    <h2 id="goal-review-title">Review goal</h2>
    <div id="goal-review-body" class="surface-markdown" tabindex="0"></div>
  </div>
</div>
<div id="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" hidden>
  <div class="set-head">
    <span id="settings-title" class="set-title"><span class="codicon codicon-settings-gear" aria-hidden="true"></span> DGC Settings</span>
    <button type="button" id="set-close" class="fbtn" title="Close" aria-label="Close settings"><span class="codicon codicon-close" aria-hidden="true"></span></button>
  </div>
  <div class="settings-nav" role="tablist" aria-label="Settings categories">
    <button type="button" class="set-tab active" role="tab" aria-selected="true" data-section="general" title="Permission mode, thinking, context size and tool profile">General</button>
    <button type="button" class="set-tab" role="tab" aria-selected="false" data-section="models" title="Where DGC sends a turn: a local host, a provider, or your own subscription CLI">Models</button>
    <button type="button" class="set-tab" role="tab" aria-selected="false" data-section="agents" title="The model and host that sub-agents and the fallback route use">Agents</button>
    <button type="button" class="set-tab" role="tab" aria-selected="false" data-section="security" title="Sandbox confinement, plan-mode limits and artifact previews">Security</button>
    <button type="button" class="set-tab" role="tab" aria-selected="false" data-section="extensions" title="Skills, MCP servers, hooks and permission rules">Extensions</button>
  </div>
  <div class="set-body">
    <section class="set-section" data-section="models" hidden>
    <div class="set-group">Connection</div>
    <label>Provider preset
      <select id="s-provider"></select></label>
    <label>Host URL
      <input id="s-base_url" type="text" spellcheck="false" placeholder="http://localhost:11434/v1"></label>
    <label>API key
      <input id="s-api_key" type="password" spellcheck="false" placeholder="(dummy for local)"></label>
    <label>Model
      <span class="set-row"><input id="s-model" type="text" spellcheck="false" placeholder="model id" list="s-models"><datalist id="s-models"></datalist></span></label>

    <div class="set-group">Subscription <span class="set-hint">run each turn through your own Claude/Codex/Qwen/Kimi/Copilot plan via its official CLI</span></div>
    <label>Engine
      <select id="s-subscription_engine"><option value="">off — use the model above</option><option value="claude">Claude Code (your subscription)</option><option value="codex">Codex / ChatGPT (your subscription)</option><option value="qwen">Qwen Code (your subscription)</option><option value="kimi">Kimi for Coding (your subscription)</option><option value="copilot">GitHub Copilot (your subscription)</option></select></label>
    <div id="s-subscription_status" class="set-hint"></div>
    <label>Subscription model <span class="set-hint">optional — overrides the CLI's own default</span>
      <input id="s-subscription_model" type="text" spellcheck="false" placeholder="(the CLI's default)"></label>
    <label>Reasoning effort <span class="set-hint">Claude, Codex &amp; Copilot · model support varies</span>
      <select id="s-subscription_effort"><option value="">default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label>

    <div class="set-group">Provider runtime <span class="set-hint">server state stores Responses with the provider</span></div>
    <label>API transport
      <select id="s-api_mode"><option value="auto">auto</option><option value="ollama">Ollama native</option><option value="anthropic">Anthropic Messages</option><option value="chat_completions">Chat Completions</option><option value="responses">Responses</option></select></label>
    <label>Responses state
      <select id="s-provider_state"><option value="stateless">stateless (private default)</option><option value="server">server stored</option></select></label>
    <label>Prompt cache routing
      <select id="s-prompt_cache"><option value="true">enabled</option><option value="false">disabled</option></select></label>
    <label>Capability retry TTL (seconds)
      <input id="s-capability_cache_ttl_s" type="number" min="1" step="1" placeholder="300"></label>
    </section>

    <section class="set-section" data-section="agents" hidden>
    <div class="set-group">Sub-agents <span class="set-hint">run <code>task</code> sub-agents on a different model / host — blank = inherit main</span></div>
    <label>Provider preset <span class="set-hint">fills the host below; leave the fields blank to inherit the main model</span>
      <select id="s-subagent_provider"><option value="">choose a preset\u2026</option></select></label>
      <label>Sub-agent model
      <input id="s-subagent_model" type="text" spellcheck="false" placeholder="inherit main"></label>
    <label>Sub-agent host URL
      <input id="s-subagent_base_url" type="text" spellcheck="false" placeholder="inherit main host"></label>
    <label>Sub-agent API transport
      <select id="s-subagent_api_mode"><option value="">inherit on main host / auto on another</option><option value="auto">auto</option><option value="ollama">Ollama native</option><option value="anthropic">Anthropic Messages</option><option value="chat_completions">Chat Completions</option><option value="responses">Responses</option></select></label>
    <label>Sub-agent API key
      <input id="s-subagent_api_key" type="password" spellcheck="false" placeholder="inherit only on the same endpoint"></label>

    <div class="set-group">Fallback <span class="set-hint">retried if the primary model errors</span></div>
    <label>Fallback model
      <input id="s-fallback_model" type="text" spellcheck="false" placeholder="none"></label>
    <label>Fallback host URL
      <input id="s-fallback_base_url" type="text" spellcheck="false" placeholder="same as main"></label>
    <label>Fallback API transport
      <select id="s-fallback_api_mode"><option value="">inherit on main host / auto on another</option><option value="auto">auto</option><option value="ollama">Ollama native</option><option value="anthropic">Anthropic Messages</option><option value="chat_completions">Chat Completions</option><option value="responses">Responses</option></select></label>
    <label>Fallback API key
      <input id="s-fallback_api_key" type="password" spellcheck="false" placeholder="same endpoint only / DGC_FALLBACK_API_KEY"></label>
    </section>

    <section class="set-section" data-section="general">
    <div class="set-group">Behavior</div>
    <label>Permission mode
      <select id="s-mode"><option value="default">default</option><option value="acceptEdits">acceptEdits</option><option value="plan">plan</option><option value="auto">auto</option></select></label>
    <label>Thinking
      <select id="s-think"><option value="off">off</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label>
    <label>DGC Ultra <span class="set-hint">deepest reasoning + proactive bounded sub-agents; never changes permissions</span>
      <select id="s-ultra_mode"><option value="false">off</option><option value="true">on</option></select></label>
    <label>Context size (tokens) <span class="set-hint">DGC uses the smaller of this and the model\u2019s own maximum, and compacts near 85% of it. Ollama cloud models ignore the request server-side, so this governs when DGC compacts rather than what the server accepts.</span>
      <div class="set-row">
        <select id="s-context_size_preset" aria-label="Context size preset">
          <option value="8192">8K &middot; 8,192</option>
          <option value="16384">16K &middot; 16,384</option>
          <option value="32768">32K &middot; 32,768</option>
          <option value="65536">64K &middot; 65,536</option>
          <option value="131072">128K &middot; 131,072</option>
          <option value="262144">256K &middot; 262,144</option>
          <option value="524288">512K &middot; 524,288</option>
          <option value="1048576">1M &middot; 1,048,576</option>
          <option value="custom">Custom\u2026</option>
        </select>
        <input id="s-context_size" type="number" min="2048" step="1024" placeholder="32768"
               aria-label="Custom context size in tokens" hidden>
      </div></label>
    <label>Show model thinking
      <select id="s-show_reasoning"><option value="true">shown in a collapsed block</option><option value="false">hidden</option></select></label>
    <label>Prompt suggestions
      <select id="s-suggest"><option value="true">enabled</option><option value="false">disabled</option></select></label>
    <label>Tool profile
      <select id="s-tool_profile"><option value="adaptive">adaptive</option><option value="full">full catalog every turn</option></select></label>
    <label>Parallel sub-agent tasks
      <input id="s-max_parallel_tasks" type="number" min="1" max="8" step="1" placeholder="4"></label>
    </section>

    <section class="set-section" data-section="security" hidden>
    <div class="set-group">Sandbox and plan safety</div>
    <label>OS sandbox
      <select id="s-sandbox"><option value="false">off</option><option value="true">on</option></select></label>
    <label>Sandbox network
      <select id="s-sandbox_network"><option value="false">blocked</option><option value="true">allowed</option></select></label>
    <label>Automatic plan preview
      <select id="s-plan_artifact"><option value="true">enabled (loopback only)</option><option value="false">disabled</option></select></label>
    <label>Restore artifact previews on launch
      <select id="s-artifact_autostart"><option value="true">enabled</option><option value="false">disabled</option></select></label>
    <label>Arbitrary artifact tool in plan mode
      <select id="s-artifact_in_plan"><option value="false">disabled</option><option value="true">enabled</option></select></label>
    <p class="set-note">Sandbox confinement and permission policy are independent. Plan mode stays read-only; enabling arbitrary artifacts in plan mode broadens that surface.</p>
    </section>

    <section class="set-section" data-section="extensions" hidden>
    <div class="set-group">Agent extensions</div>
    <p class="set-note">Manage the same local DGC capabilities used by the CLI. Credentials entered for editor-managed MCP servers stay in VS Code SecretStorage.</p>
    <div class="settings-links">
      <button type="button" class="act" data-open-surface="mcp" title="Connect and manage Model Context Protocol servers">MCP servers</button>
      <button type="button" class="act" data-open-surface="skills" title="Reusable instructions DGC can apply to a request">Skills</button>
      <button type="button" class="act" data-open-surface="permissions" title="What DGC may run and edit without asking">Permission rules</button>
      <button type="button" class="act" data-open-surface="memory" title="Facts DGC keeps about this project and about you">Memory</button>
      <button type="button" class="act" data-open-surface="hooks" title="Commands that run at points in a turn, such as before an edit">Lifecycle hooks</button>
      <button type="button" class="act" data-open-surface="docs" title="How-to guides, read inside the panel">Documentation</button>
    </div>
    </section>
  </div>
  <div class="set-foot">
    <button type="button" id="set-save" class="act primary set-save" title="Save these settings for this workspace">Save</button>
    <button type="button" id="set-cancel" class="fbtn" title="Close without saving">Close</button>
  </div>
</div>
<div id="pop" class="pop" role="listbox" aria-label="Suggestions"></div>
<div id="queued" role="status" aria-live="polite"></div>
<footer>
  <button type="button" id="workspace-changes" class="rail-text-action" title="Review all workspace changes since the last Git commit">Workspace changes</button>
  <div id="composer-rail" aria-label="Current work" hidden>
    <section id="changesbar" class="rail-item" aria-label="Changes in this chat" hidden>
      <button type="button" id="changes-main" class="rail-main" aria-label="Review changed files" title="Every file this chat has changed, with its diff"><span class="codicon codicon-diff-multiple rail-icon" aria-hidden="true"></span><span id="changes-count">1 file changed in this chat</span><span id="changes-add" class="change-add">+0</span><span id="changes-del" class="change-del">−0</span></button>
      <button type="button" id="changes-review-button" class="rail-text-action" title="Open the list of changed files">Review</button>
    </section>
    <section id="goalbar" class="rail-item" aria-label="Standing goal" hidden>
      <button type="button" id="goal-main" class="rail-main" aria-label="Expand and edit goal" title="Read and edit the standing objective"><span class="goal-icon codicon codicon-target rail-icon" aria-hidden="true"></span><span id="goal-status">Pursuing goal</span><span id="goal-text"></span><time id="goal-time">0:00</time></button>
      <div class="goal-actions">
        <button type="button" id="goal-review-button" class="rail-icon-button" title="Review goal" aria-label="Review goal"><span class="codicon codicon-inspect" aria-hidden="true"></span></button>
        <button type="button" id="goal-clear" class="rail-icon-button" title="Clear goal" aria-label="Clear goal"><span class="codicon codicon-trash" aria-hidden="true"></span></button>
        <button type="button" id="goal-toggle" class="rail-icon-button" title="Pause goal" aria-label="Pause goal"><span class="codicon codicon-debug-pause" aria-hidden="true"></span></button>
        <button type="button" id="goal-edit" class="rail-icon-button" title="Edit goal" aria-label="Edit goal"><span class="codicon codicon-edit" aria-hidden="true"></span></button>
      </div>
    </section>
  </div>
  <div id="cbox" data-mode="default">
    <div id="attachments" aria-label="Attached context"></div>
    <div class="cinput"><span class="pmark" aria-hidden="true">❯</span><textarea id="input" rows="1" placeholder="Ask DGC to build, fix or explain…" aria-label="Message DGC" aria-controls="pop" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false"></textarea></div>
    <div id="cfooter">
      <div class="cf-left">
      <div class="picker add-picker">
        <button type="button" id="btn-add" class="fbtn" title="Add files and more" aria-label="Add files and more" aria-haspopup="menu" aria-expanded="false"><span class="codicon codicon-add" aria-hidden="true"></span></button>
        <div id="addmenu" class="cmenu" role="menu" aria-label="Add" hidden></div>
      </div>
      <button type="button" id="btn-cmd" class="fbtn" title="Commands (/)" aria-label="Open commands"><span class="codicon codicon-terminal" aria-hidden="true"></span></button>
      <div class="picker context-picker">
        <button type="button" id="btn-ctx" class="fbtn" title="Context used — click for details" aria-label="Context used: 0 percent; open context details" aria-haspopup="dialog" aria-expanded="false"><span class="codicon codicon-pie-chart" aria-hidden="true"></span> <span id="ctx">0%</span></button>
        <section id="ctxmenu" class="cmenu context-menu" role="dialog" aria-label="Context window" hidden>
          <div class="context-head"><div><span class="context-kicker">Context window</span><strong id="ctx-used">0 / 0</strong></div><span id="ctx-pct">0%</span></div>
          <div class="context-track" aria-hidden="true"><span id="ctx-fill"></span></div>
          <div class="context-split"><span id="ctx-free">0 free</span><span id="ctx-auto">auto at 85%</span></div>
          <div id="ctx-usage" class="context-usage">0 in · 0 out · 0 requests</div>
          <div class="context-last"><span class="codicon codicon-history" aria-hidden="true"></span><span id="ctx-last">DGC compacts automatically near 85%.</span></div>
          <p id="ctx-detail" class="context-detail" hidden></p>
          <button type="button" id="ctx-compact" class="context-action" title="Summarise the conversation now so the model has room to keep working">Compact now</button>
        </section>
      </div>
      <button type="button" id="btn-settings" class="fbtn" title="Settings" aria-label="Open settings"><span class="codicon codicon-settings-gear" aria-hidden="true"></span></button>
      <div class="picker">
        <button type="button" id="btn-mode" class="fbtn mode" title="Permission mode — Shift+Tab to cycle" aria-label="Permission mode: default" aria-haspopup="menu" aria-expanded="false"><span id="modeicon" class="codicon codicon-shield" aria-hidden="true"></span> <span id="modelabel">default</span></button>
        <div id="modemenu" class="cmenu" role="menu" aria-label="Permission mode" hidden></div>
      </div>
      </div>
      <div class="cf-right">
      <div class="picker">
        <button type="button" id="btn-model" class="fbtn mode model-control" title="Model and reasoning — click to change" aria-label="Change model and reasoning" aria-haspopup="menu" aria-expanded="false"><span class="model-copy"><span id="modelname">dgc</span><span id="effortname">off</span></span><span class="codicon codicon-chevron-up model-chevron" aria-hidden="true"></span></button>
        <div id="modelmenu" class="cmenu" role="menu" aria-label="Model" hidden></div>
      </div>
      <button type="button" id="queue-send" class="fbtn" title="Queue for the next turn — Alt+Enter" aria-label="Queue for next turn" hidden>Queue</button>
      <button type="button" id="stop-run" class="fbtn" title="Stop generation" aria-label="Stop generation" hidden><span class="codicon codicon-debug-stop" aria-hidden="true"></span></button>
      <button type="button" id="send" class="csend" data-mode="default" title="Send" aria-label="Send message"><span class="codicon codicon-arrow-up" aria-hidden="true"></span></button>
      </div>
    </div>
  </div>
  <div id="followup-hint" hidden></div>
</footer>
<script nonce="${nonce}" src="${markdown}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}
