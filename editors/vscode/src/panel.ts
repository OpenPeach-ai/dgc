import * as vscode from "vscode";
import { createHash } from "crypto";
import { DgcBackend, DgcEvent } from "./backend";
import { resolveDgcExecutable } from "./configuration";

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
  private backend?: DgcBackend;
  private state = { model: "", mode: "default", think: "off", ultra: false,
                    baseUrl: "", workspaceTrusted: false,
                    subscriptionEngine: "",
                    goal: { text: "", status: "none", elapsed_seconds: 0 } };
  private _installPrompted = false;
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
  private mcpUrls = new Map<string, string>();
  private slashAliases = new Map<string, string>();
  private plaintextSecretWarnings = new Set<string>();
  private turnActive = false;
  private workspaceRootsRevision = 0;
  private workspaceRootsDirty = true;
  private workspaceRootsInFlight: { revision: number; requestId?: string } | undefined;
  private initializingBackend?: DgcBackend;
  private nativeSettingsReady = false;
  private webviewReady = false;
  private pendingWebviewActions: Array<() => void> = [];
  private testPostedMessages: Array<{ type: string; eventType?: string; id?: string }> = [];
  private settingsSaveInFlight = false;
  private commandOverrideWarningShown = false;
  private sb: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext) {
    // one status-bar item: `model · mode` (click to change model)
    this.sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.sb.command = "dgc.selectModel";
  }

  // ---- backend lifecycle ---------------------------------------------------
  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
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
  private async startGoal(text: string): Promise<void> {
    const objective = String(text || "").trim();
    if (!objective) { return; }
    const be = this.ensureBackend();
    try {
      await this.requestState(be, "goal", {
        type: "set_goal", text: objective, status: "active",
      }, "goal_changed", 10000);
    } catch (err: any) {
      this.post({ type: "goal_start_state", state: "error",
                  error: err?.message || "DGC could not start the goal." });
      return;
    }
    const accepted = be.send({
      type: "prompt", text: objective, context: this.editorContext(),
    });
    if (!accepted) {
      this.post({ type: "goal_start_state", state: "error",
                  error: "The goal was saved, but its first turn could not start. Send it again to continue." });
      return;
    }
    // Close the same command/turn_start race as an ordinary composer prompt.
    this.turnActive = true;
    this.post({ type: "goal_start_state", state: "started" });
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
      "workspace-roots", { type: "set_workspace_roots", roots: this.workspaceRoots() });
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
    this.initializingBackend = undefined;
    this.nativeSettingsReady = false;
    be.completeHandshake();
  }

  /** Called by the extension host when folders are added, removed, or reordered. */
  workspaceRootsChanged(): void {
    this.workspaceRootsRevision++;
    this.workspaceRootsDirty = true;
    this.syncWorkspaceRoots();
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

      if (activeUri) {
        const diagnostics = vscode.languages.getDiagnostics(activeUri).slice(0, 50).map((d) => ({
          severity: vscode.DiagnosticSeverity[d.severity], message: d.message.slice(0, 2000),
          source: d.source || "", code: typeof d.code === "object" ? d.code.value : d.code,
          range: { start_line: d.range.start.line + 1, start_character: d.range.start.character + 1,
                   end_line: d.range.end.line + 1, end_character: d.range.end.character + 1 },
        }));
        if (diagnostics.length) {
          resources.push({ type: "diagnostics", ...describe(activeUri), diagnostics });
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
    const be = new DgcBackend(this.cwd(), cmd);
    be.on("event", (ev: DgcEvent) => this.onEvent(ev));
    be.on("stderr", (line: string) => this.post({ type: "stderr", line }));
    be.on("exit", (code: number | null) => {
      this.mcpUrls.clear();
      if (this.backend === be) {
        this.turnActive = false;
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
    this.backend?.dispose();
    this.backend = undefined;
    this.mcpUrls.clear();
    this.turnActive = false;
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
    switch (ev.type) {
      case "ready":
        this.turnActive = false;
        this.workspaceRootsInFlight = undefined;
        this.workspaceRootsDirty = true;
        this.correlatedStateRequests = ev.capabilities?.correlated_state_requests === true;
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
          this.mcpUrls.set(String(ev.id), String(ev.payload.url || ""));
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
        break;
      }
      case "turn_start":
        this.turnActive = true;
        break;
      case "handoff_started":
        this.turnActive = true;
        break;
      case "handoff":
        this.turnActive = false;
        this.syncWorkspaceRoots();
        break;
      case "command_rejected":
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
        this.turnActive = false;
        this.syncWorkspaceRoots();
        break;
    }
    if (ev.type === "error" && (ev as any).notInstalled) {
      this.promptInstallCli();
    }
    this.post({ type: "event", event: ev });
  }

  /** The CLI ('dgc') is missing — offer to install it (the extension drives the CLI). */
  private promptInstallCli(): void {
    if (this._installPrompted) { return; }
    this._installPrompted = true;
    const INSTALL = "Install DGC CLI", SETPATH = "Set dgc.command…";
    vscode.window.showErrorMessage(
      "DGC needs the `dgc` command-line tool, which isn't installed or on PATH.",
      INSTALL, SETPATH,
    ).then((choice) => {
      if (choice === INSTALL) {
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

  private post(msg: any): void {
    if (process.env.DGC_EXTENSION_TEST_TOKEN) {
      const event = msg?.type === "event" && msg.event && typeof msg.event === "object"
        ? msg.event : undefined;
      this.testPostedMessages.push({
        type: String(msg?.type || ""),
        ...(event ? { eventType: String(event.type || ""),
          ...(event.id === undefined ? {} : { id: String(event.id) }) } : {}),
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

  testOnlyPostedMessages(token: string): Array<{ type: string; eventType?: string; id?: string }> {
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
    this.view = view;
    this.webviewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
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
    vscode.commands.executeCommand("dgc.chat.focus");
    this.view?.show?.(true);
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
        const actions = this.pendingWebviewActions.splice(0);
        for (const action of actions) { action(); }
        if (this.state.model) { this.postState(); }
        break;
      }
      case "prompt": {
        let text = String(msg.text ?? "");
        // Slash commands remain pure command text. Normal prompts carry typed resources
        // separately so display/history and model input cannot be confused.
        const attached = Array.isArray(msg.context)
          ? msg.context.filter((item: any) => item && typeof item === "object").slice(0, 64)
          : [];
        const live = text && !text.startsWith("/") ? this.editorContext() : [];
        const accepted = be.send({ type: "prompt", text, images: msg.images,
                                   context: [...attached, ...live].slice(0, 64) });
        if (!accepted) {
          this.post({ type: "prompt_rejected" });
        } else {
          // Close the small command/turn_start race so a simultaneous folder removal
          // cannot send a mutation that the backend must reject as newly busy.
          this.turnActive = true;
        }
        break;
      }
      case "permission_response":
        be.send({ type: "permission_response", id: msg.id, decision: msg.decision, rule: msg.rule });
        break;
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
        be.send({ type: "options_response", id: msg.id, choice: msg.choice });
        break;
      case "mcp_input_response": {
        let action = msg.action;
        const url = this.mcpUrls.get(String(msg.id));
        this.mcpUrls.delete(String(msg.id));
        if (action === "accept" && url) {
          try {
            const parsed = new URL(url);
            const target = vscode.Uri.parse(url, true);
            const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
            if (target.scheme !== "https" && !(target.scheme === "http" && loopback)) {
              action = "cancel";
            } else if (!await vscode.env.openExternal(target)) {
              action = "cancel";
            }
          } catch {
            action = "cancel";
          }
        }
        be.send({ type: "mcp_input_response", id: msg.id, action,
                  content: msg.content });
        break;
      }
      case "cancel":
        this.mcpUrls.clear();
        be.send({ type: "cancel" });
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
        this.openSettings();
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
      case "reqFiles":
        this.sendFiles();
        break;
      case "openFile":
        this.openFile(msg.path, msg.line);
        break;
      case "openExternal":
        if (msg.url) { void this.openSafeExternal(String(msg.url)); }
        break;
      case "getSkill":
        be.send({ type: "get_skill", request_id: this.nextRequestId("skill"), name: String(msg.name || "") });
        break;
      case "skillsReload":
        be.send({ type: "reload_skills", request_id: this.nextRequestId("skills-reload") });
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
    const uri = vscode.Uri.file(path.startsWith("/") ? path : this.cwd() + "/" + path);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const ed = await vscode.window.showTextDocument(doc, { preview: true });
      if (line) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      /* file may not exist on disk */
    }
  }

  private async openSafeExternal(raw: string): Promise<void> {
    try {
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
    if (!waitForAck) { return be.send(command); }
    const event = await be.request(command, "mcp_servers", 10000);
    if ((event as any).error) { throw new Error(String((event as any).error)); }
    return true;
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
    const be = this.ensureBackend();
    be.send({ type: "reload_mcp_servers", request_id: this.nextRequestId("mcp-reload") });
    for (const item of this.managedMcpServers()) { await this.sendManagedMcp(be, item); }
    be.send({ type: "list_mcp_tools", request_id: this.nextRequestId("mcp-tools"), limit: 100 });
  }

  private slash(action: string): void {
    switch (action) {
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
    if (name === "goal") {
      const low = rest.toLowerCase();
      if (!rest) { be.send(this.stateCommand("goal", { type: "get_goal" })); }
      else if (["clear", "off", "none", "remove"].includes(low)) {
        be.send(this.stateCommand(
          "goal", { type: "set_goal", text: "", status: "none" }));
      } else if (["complete", "completed", "done"].includes(low)) {
        be.send(this.stateCommand("goal", { type: "set_goal", status: "completed" }));
      } else if (["blocked", "block", "pause", "paused"].includes(low)) {
        be.send(this.stateCommand("goal", { type: "set_goal", status: "blocked" }));
        // Pausing the goal also interrupts any in-flight turn (parity with the
        // Codex-style pause), not just a status relabel. Harmless when idle.
        be.send({ type: "cancel" });
      } else if (["resume", "active", "reactivate"].includes(low)) {
        be.send(this.stateCommand("goal", { type: "set_goal", status: "active" }));
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
        this.post({ type: "composer_text", text: `$${skillName}${arguments_.length ? ` ${arguments_.join(" ")}` : ""}` });
      } else { this.openSkills(); }
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
    const baseUrl = c.get<string>("baseUrl", "");
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
    put("subagent_base_url", "subagentBaseUrl");
    put("subagent_api_mode", "subagentApiMode");
    const effectiveSubagentBase = c.get<string>("subagentBaseUrl", "")
      || this.routeState.subagentBaseUrl || effectiveBase;
    const subagentKey = await this.storedSecret("subagentApiKey", effectiveSubagentBase);
    if (subagentKey) { values.subagent_api_key = subagentKey; }
    put("fallback_model", "fallbackModel");
    put("fallback_base_url", "fallbackBaseUrl");
    put("fallback_api_mode", "fallbackApiMode");
    const effectiveFallbackBase = c.get<string>("fallbackBaseUrl", "")
      || this.routeState.fallbackBaseUrl || effectiveBase;
    const fallbackKey = await this.storedSecret("fallbackApiKey", effectiveFallbackBase);
    if (fallbackKey) { values.fallback_api_key = fallbackKey; }
    const cs = c.get<number>("contextSize", 0); if (cs) { values.context_size = cs; }
    const gate = c.get<string>("autonomousGate", ""); if (gate) { values.autonomous_gate = gate; }
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
      ? [...THINK, { id: "max", detail: "maximum session effort where the active model supports it" }]
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
      await this.requestState(
        be, "session-new", { type: "new_session" }, "session", 5000);
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
      return;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const a = ed.selection.start.line + 1;
    const b = ed.selection.end.line + 1;
    const folder = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    let text = ed.document.getText(ed.selection);
    if (text.length > 8192) { text = text.slice(0, 8192); }
    this.focus();
    this.post({ type: "attach", label: `${rel}:${a}-${b}`, resource: {
      type: "selection", uri: ed.document.uri.toString(), path: ed.document.uri.fsPath,
      relative_path: rel, workspace: folder?.name || "", language: ed.document.languageId,
      range: { start_line: a, end_line: b }, text,
    } });
  }

  dispose(): void {
    this.backend?.dispose();
    this.sb.dispose();
  }

  // ---- html ----------------------------------------------------------------
  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2) + String(Date.now());
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "codicon.css"));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
    return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DGC</title>
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${css}">
</head><body>
<header id="phead"><span class="pm"><svg class="mk" viewBox="0 0 90 90" fill="currentColor" aria-hidden="true"><path d="M32 24 L20 30 L13 72 L25 66 Z"/><path d="M54 18 L42 24 L35 72 L47 66 Z"/><path d="M76 24 L64 30 L57 66 L69 60 Z"/></svg>DGC<span class="cur" aria-hidden="true"></span></span><button type="button" id="thread-title" class="thread-title" title="Current chat — click to rename" aria-label="Current chat: New chat. Click to rename">New chat</button><button type="button" class="pd" id="pmodel" title="Model — click to change" aria-label="Change model">dgc</button></header>
<main id="log" role="log" aria-live="off" aria-label="DGC conversation"></main>
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
<div id="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" hidden>
  <div class="set-head">
    <span id="settings-title" class="set-title"><span class="codicon codicon-settings-gear" aria-hidden="true"></span> DGC Settings</span>
    <button type="button" id="set-close" class="fbtn" title="Close" aria-label="Close settings"><span class="codicon codicon-close" aria-hidden="true"></span></button>
  </div>
  <div class="settings-nav" role="tablist" aria-label="Settings categories">
    <button type="button" class="set-tab active" role="tab" aria-selected="true" data-section="general">General</button>
    <button type="button" class="set-tab" role="tab" aria-selected="false" data-section="models">Models</button>
    <button type="button" class="set-tab" role="tab" aria-selected="false" data-section="agents">Agents</button>
    <button type="button" class="set-tab" role="tab" aria-selected="false" data-section="security">Security</button>
    <button type="button" class="set-tab" role="tab" aria-selected="false" data-section="extensions">Extensions</button>
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
    <label>Context size (tokens)
      <input id="s-context_size" type="number" min="2048" step="1024" placeholder="32768"></label>
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
      <button type="button" class="act" data-open-surface="mcp">MCP servers</button>
      <button type="button" class="act" data-open-surface="skills">Skills</button>
      <button type="button" class="act" data-open-surface="permissions">Permission rules</button>
      <button type="button" class="act" data-open-surface="memory">Memory</button>
      <button type="button" class="act" data-open-surface="hooks">Lifecycle hooks</button>
      <button type="button" class="act" data-open-surface="docs">Documentation</button>
    </div>
    </section>
  </div>
  <div class="set-foot">
    <button type="button" id="set-save" class="csend set-save">Save</button>
    <button type="button" id="set-cancel" class="fbtn">Close</button>
  </div>
</div>
<div id="pop" class="pop" role="listbox" aria-label="Suggestions"></div>
<div id="queued" role="status" aria-live="polite"></div>
<footer>
  <section id="goalbar" aria-label="Standing goal" hidden>
    <span class="goal-icon codicon codicon-target" aria-hidden="true"></span>
    <div class="goal-copy">
      <div class="goal-label"><span id="goal-status">Active goal</span><span aria-hidden="true">·</span><time id="goal-time">0:00</time></div>
      <div id="goal-text"></div>
    </div>
    <div class="goal-actions">
      <button type="button" id="goal-edit" class="fbtn" title="Edit goal" aria-label="Edit standing goal"><span class="codicon codicon-edit" aria-hidden="true"></span></button>
      <button type="button" id="goal-toggle" class="fbtn" title="Pause goal" aria-label="Pause standing goal"><span class="codicon codicon-debug-pause" aria-hidden="true"></span></button>
      <button type="button" id="goal-clear" class="fbtn" title="Clear goal" aria-label="Clear standing goal"><span class="codicon codicon-close" aria-hidden="true"></span></button>
    </div>
  </section>
  <div id="attachments" aria-label="Attached context"></div>
  <div id="cbox" data-mode="default">
    <div class="cinput"><span class="pmark" aria-hidden="true">❯</span><textarea id="input" rows="1" placeholder="Ask DGC to build, fix or explain…" aria-label="Message DGC" aria-controls="pop" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false"></textarea></div>
    <div id="cfooter">
      <button type="button" id="btn-add" class="fbtn" title="Attach a file (@-mention)" aria-label="Attach a file"><span class="codicon codicon-add" aria-hidden="true"></span></button>
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
          <button type="button" id="ctx-compact" class="context-action">Compact now</button>
        </section>
      </div>
      <button type="button" id="btn-settings" class="fbtn" title="Settings" aria-label="Open settings"><span class="codicon codicon-settings-gear" aria-hidden="true"></span></button>
      <span class="cspacer"></span>
      <div class="picker">
        <button type="button" id="btn-model" class="fbtn mode model-control" title="Model and reasoning — click to change" aria-label="Change model and reasoning" aria-haspopup="menu" aria-expanded="false"><span class="codicon codicon-chip" aria-hidden="true"></span><span class="model-copy"><span id="modelname">dgc</span><span id="effortname">off</span></span><span class="codicon codicon-chevron-up model-chevron" aria-hidden="true"></span></button>
        <div id="modelmenu" class="cmenu" role="menu" aria-label="Model" hidden></div>
      </div>
      <div class="picker">
        <button type="button" id="btn-mode" class="fbtn mode" title="Permission mode — Shift+Tab to cycle" aria-label="Permission mode: default" aria-haspopup="menu" aria-expanded="false"><span id="modeicon" class="codicon codicon-shield" aria-hidden="true"></span> <span id="modelabel">default</span></button>
        <div id="modemenu" class="cmenu" role="menu" aria-label="Permission mode" hidden></div>
      </div>
      <button type="button" id="send" class="csend" data-mode="default" title="Send" aria-label="Send message"><span class="codicon codicon-arrow-up" aria-hidden="true"></span></button>
    </div>
  </div>
</footer>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}
