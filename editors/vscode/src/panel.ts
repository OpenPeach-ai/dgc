import { APP_CONNECTORS, connectorUrl, ownAppRedirect } from "./appConnectors";
import { COMPOSIO_CATALOG } from "./composioConnections";
import * as vscode from "vscode";
import { createHash, randomBytes } from "crypto";
import { realpath } from "fs/promises";
import * as fs from "fs";
import { homedir } from "os";
import * as path from "path";
import { basename, isAbsolute, join, resolve, sep } from "path";
import { AttachMode, AttachedChatState, ChildExitInfo, DgcBackend, DgcEvent, MOVED_CAUSE, STOP_CAUSE } from "./backend";
import { ChatBackend, OpenedChat } from "./chatChannel";
import { CHATDGC_WINDOWS, isChatdgcEvent, type ChatDGC, type ChatDGCHost } from "./chatdgc";
import { keepRunningAfterClose } from "./closingTab";
import { Dictation, MIC_MESSAGES, ReadAloud, SPEAK_MESSAGES, VoiceClient, type DictationOwner } from "./voice";
import { offerVoiceInstall } from "./voiceInstall";
import { resolveDgcExecutable, userScopedString } from "./configuration";
import { backendPath, dgcHome, editorPath, hiddenWslDistro, setUpWsl, wslRoute } from "./wslSetup";
import {
  autoUpdateEnabled, INSTALL_COMMAND, installTerminalOptions, isUserChosenCommand, updateCliWithProgress, runCliUpdate,
} from "./cliupdate";
import { checkForExtensionUpdates } from "./extensionupdate";
import { workspaceFile } from "./navigation";
import { McpBrowserRequest, openMcpBrowser } from "./mcpAuth";
import { PipsEditor } from "./pipsView";
import { PLUGIN_ID, pluginLogoData, pluginLogoSource, type PluginLogoItem } from "./pluginLogos";
import { pipsAttention, PipsAttentionState } from "./pipsAttention";
import { settingsDocument } from "./settingsView";

function isSlashCommandText(text: string): boolean {
  if (!text.startsWith("/")) { return false; }
  const name = text.slice(1).split(/\s+/, 1)[0] || "";
  return !name.includes("/");
}

/** Where the "a goal is being pursued" marker lives, and how long it stays believable. */
const GOAL_PURSUIT_KEY = "dgc.goalPursuit.v1";
const GOAL_PURSUIT_MAX_AGE_MS = 15 * 60 * 1000;
/** An ordinary turn that was running when the backend went away, so a reconnect can offer to
 *  continue it. Written on turn_start, cleared by a turn that ends on its own terms. */
const INTERRUPTED_TURN_KEY = "dgc.interruptedTurn.v1";
/** A turn_end "error" this close to an unassisted exit is the exit's doing, not the model's. */
const EXIT_AFTER_ERROR_MS = 30 * 1000;
/** Backend deaths nobody asked for, kept across hosts: a cause that repeats every few minutes
 *  never trips the three-in-two-minutes crash budget, and each resumed goal would feed it again. */
const UNASSISTED_EXITS_KEY = "dgc.unassistedExits.v1";
/** Messages the backend accepted as queued and has not started, kept across hosts: a window reload
 *  kills the backend that held them, and the next host hands them back to the webview as not sent. */
const QUEUED_PROMPTS_KEY = "dgc.queuedPrompts.v1";
function checkedPromptPipReferences(value: any): any[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("Choose between one and eight Pip references.");
  const ids = new Set<string>();
  return value.map((p: any) => {
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).sort().join(",") !== "expected_lifecycle_revision,expected_version,pip_id"
        || typeof p.pip_id !== "string" || p.pip_id.length !== 36 || !/^pip_[a-f0-9]{32}$/.test(p.pip_id)
        || ids.has(p.pip_id) || !Number.isSafeInteger(p.expected_version) || p.expected_version < 1 || p.expected_version > 999999
        || !Number.isSafeInteger(p.expected_lifecycle_revision) || p.expected_lifecycle_revision < 0) throw new Error("Remove and select the invalid Pip reference again.");
    ids.add(p.pip_id); return {...p};
  });
}

const QUEUED_PROMPTS_LIMIT = 17;                     // the webview's own bound on unanswered prompts
const QUEUED_PROMPT_DRAFT_CHARS = 256 * 1024;        // a bigger restore draft is kept as its text only
type QueuedPrompt = {
  requestId: string; session: string; text: string;
  draft: { text: string; attachments: any[] }; queued: boolean;
  /** Acknowledged as steering ("steered") and not applied yet: as unsent as a queued prompt. */
  steering?: boolean;
};
const REPEAT_EXIT_WINDOW_MS = 30 * 60 * 1000;
const REPEAT_EXIT_LIMIT = 3;
/** The `/usage` range spellings, exactly as dgc/usage_ledger.py `_RANGE_ALIASES` reads them. */
const USAGE_RANGE_ALIASES: Record<string, string> = {
  today: "today", day: "today", "1d": "today",
  "7d": "7d", "7": "7d", week: "7d", "7days": "7d",
  "30d": "30d", "30": "30d", "30days": "30d",
  month: "month", "this-month": "month", thismonth: "month",
  all: "all", "all-time": "all", alltime: "all", ever: "all",
};
const PANEL_DISPOSED_CAUSE = "panel disposed (window reload, close or extension update)";
/** Prefix for a backend stopped because the user closed its chat. A close is not a crash, and
 *  the teardown handler must not log it as one or arm the dead slot to resume. */
const CHAT_CLOSED_CAUSE = "chat closed: ";

/** How a child ended, for the exit line and for the cause it reports: Node gives (code=null,
 *  signal="SIGKILL") for a killed process, and a code alone made a crash read as a clean stop. */
function exitHow(code: number | null, signal?: string | null): string {
  return signal ? `killed by ${signal}` : code === null ? "killed by an unreported signal" : `code ${code}`;
}
/** One animation frame's worth. Long enough to collapse a streamed response into a few rail
 *  posts, short enough that an unread count still reads as live. */
const CHAT_SLOTS_COALESCE_MS = 120;
/** How often the editor checks whether a Pip needs you (pipsAttention.ts). */
const PIPS_ATTENTION_MS = 60_000;
const PIPS_ATTENTION_KEY = "dgc.pipsAttention.v1";
/** Whether the side bar's last backend offered ChatDGC: the next window shows Chat | Work at once, not when its
 *  backend has started (seconds, with the user's MCP servers and plugins starting first). */
const CHATDGC_SEEN_KEY = "dgc.chatdgcSeen.v1";
/** What a Work chat's page may not do while its session is open in another window (session_elsewhere): anything that
 *  changes the session, its turn or its settings. */
const WORK_READ_ONLY_REFUSES = new Set(["prompt", "slash", "slashText", "cancel", "setMode", "setModel", "setReasoningProfile",
  "setContextSize", "pickModel", "compact", "rateResponse", "branchChat", "resumeTurn", "permission_response", "plan_response",
  "options_response", "mcp_input_response", "askSkip", "steerQueued", "rerunTask", "learnSave", "clear_todos", "undoTurn",
  "startGoal", "updateGoal", "clearGoal", "resumeGoal", "drop_uris", "stopAgent", "stopMonitor", "restartMonitor",
  "stopBackgroundShell", "stopTroupe", "stopArtifact", "startPipFix", "undoPipFix"]);
/** The Sessions home's last backend, by its chat's session: a reload asks for it back (it may be writing a ChatDGC reply). */
const HOME_BACKEND_KEY = "dgc.homeBackend.v1";
/** Voice was offered once (the editor's first run with a CLI that has it): never again, whatever was answered. */
const VOICE_OFFERED_KEY = "dgc.voiceOffered.v1";
/** What voice costs to turn on, as `dgc setup` says it: Moonshine (111 MB) and Kitten (68 MB), with the engine. */
const VOICE_OFFER_MB = 229;

interface InterruptedTurnMark {
  scope?: string; id?: string; turnId?: string; at?: number;
  endedAt?: number; exitedAt?: number; cause?: string;
  /** The window went while the turn ran, and its backend kept it running with no window: whether it
   *  was cut off is that backend's to say (turn_interrupted), not this mark's. */
  detachedAt?: number;
}
interface UnassistedExit { at: number; cause: string; last: string }

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
// The web search providers this editor can offer in Settings; a CLI says which of them it takes.
const SEARCH_PROVIDERS = ["duckduckgo", "brave", "tavily", "searxng", "ollama"];
// The ones that take a key. A CLI with ready.capabilities.search_keys keeps one per provider (set_config
// search_api_key_<provider>); an older one keeps one key for all of them.
const SEARCH_KEY_PROVIDERS = ["brave", "tavily", "ollama"];
// Ollama's keep_alive as the CLI takes it (dgc/headless.py _KEEP_ALIVE_RE): a duration, seconds, -1, or "".
const KEEP_ALIVE_RE = /^(?:|-?\d{1,9}|(?:\d{1,6}(?:\.\d{1,3})?(?:ms|s|m|h)){1,4})$/;

// The most sub-agents that may run at once (dgc/config.py MAX_PARALLEL_TASKS); a Save never writes a wider one.
const MAX_PARALLEL_TASKS = 32;
// A model id as Pips take one (dgc/pip_models.py _MODEL_ID).
const PIPS_MODEL_RE = /^[A-Za-z0-9_][A-Za-z0-9._:/@+\-]{0,255}$/;

const endpointId = (value: unknown): string => String(value || "").trim().replace(/\/$/, "").toLowerCase();

// The sub-agents' context window as the CLI keeps it (dgc/config.py subagent_window_arg): 0 is the main model's,
// otherwise 2,048 to 16,777,216 tokens. Blank, 0 or anything unreadable saves 0; a number outside is brought inside.
const SUBAGENT_WINDOW_MIN = 2_048;
const SUBAGENT_WINDOW_MAX = 16_777_216;
function subagentWindow(value: unknown): number {
  const tokens = Math.floor(Number(String(value ?? "").trim() || 0));
  if (!Number.isFinite(tokens) || tokens <= 0) { return 0; }
  return Math.min(SUBAGENT_WINDOW_MAX, Math.max(SUBAGENT_WINDOW_MIN, tokens));
}

// Settings -> Models -> Advanced: how long DGC waits on a model (model_wait_settings, 0.48). The CLI keeps seconds:
// model_first_token_timeout_s "auto" | seconds (0: no limit), model_idle_timeout_s seconds (0: no limit); the page
// shows Auto / Minutes / Never and minutes.
type WaitSettings = { first_token: string; between_words_s: number };
const WAIT_MAX_MINUTES = 1440;
const minutesText = (seconds: number): string => String(Math.round((Math.max(0, seconds) / 60) * 100) / 100);
/** The page's fields for what the CLI keeps. */
export function waitDraft(w: WaitSettings): { wait_first_word: string; wait_first_word_minutes: string; wait_between_words: string } {
  const first = String(w.first_token ?? "auto").trim().toLowerCase();
  const seconds = Number(first);
  const auto = first === "auto" || first === "" || !Number.isFinite(seconds);
  return {
    wait_first_word: auto ? "auto" : seconds > 0 ? "minutes" : "never",
    wait_first_word_minutes: !auto && seconds > 0 ? minutesText(seconds) : "",
    wait_between_words: minutesText(Number(w.between_words_s) || 0),
  };
}
/** What a Save sends for the page's fields: only a value that differs from what the CLI keeps (so a rounded number
 *  on the page never rewrites the seconds behind it). Throws, in the page's words, on a number it can't take. */
export function waitValues(v: any, kept: WaitSettings): { model_first_token_timeout_s?: "auto" | number; model_idle_timeout_s?: number } {
  const out: { model_first_token_timeout_s?: "auto" | number; model_idle_timeout_s?: number } = {};
  const choice = String(v?.wait_first_word ?? "");
  let first: "auto" | number | undefined;
  if (choice === "auto") { first = "auto"; }
  else if (choice === "never") { first = 0; }
  else if (choice === "minutes") {
    const minutes = Number(String(v?.wait_first_word_minutes ?? "").trim());
    if (!String(v?.wait_first_word_minutes ?? "").trim() || !Number.isFinite(minutes) || minutes <= 0 || minutes > WAIT_MAX_MINUTES) {
      throw new Error("Wait for the first word takes a number of minutes, more than 0 and up to 1,440 (a day).");
    }
    first = Math.min(86_400, Math.max(1, Math.round(minutes * 60)));
  }
  const keptFirst = waitDraft(kept);
  const sameFirst = first === "auto" ? keptFirst.wait_first_word === "auto"
    : first === 0 ? keptFirst.wait_first_word === "never"
    : first !== undefined && keptFirst.wait_first_word === "minutes" && keptFirst.wait_first_word_minutes === String(v?.wait_first_word_minutes ?? "").trim();
  if (first !== undefined && !sameFirst) { out.model_first_token_timeout_s = first; }
  const between = String(v?.wait_between_words ?? "").trim();
  if (between) {
    const minutes = Number(between);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > WAIT_MAX_MINUTES) {
      throw new Error("Wait between words takes a number of minutes, from 0 (no limit) up to 1,440 (a day).");
    }
    if (between !== keptFirst.wait_between_words) { out.model_idle_timeout_s = Math.min(86_400, Math.round(minutes * 60)); }
  }
  return out;
}

/** ready.capabilities.search_keys -> which providers have a key of their own saved; undefined from an older CLI. */
function searchKeysFromHandshake(offered: any): Map<string, boolean> | undefined {
  if (!offered || typeof offered !== "object" || !Array.isArray(offered.providers)) { return undefined; }
  const saved = Array.isArray(offered.saved) ? offered.saved : [];
  const own = offered.providers.filter((p: unknown) => typeof p === "string" && SEARCH_KEY_PROVIDERS.includes(p));
  return new Map(own.map((p: string) => [p, saved.includes(p)]));
}

type ManagedMcpServer = {
  connector?: string;
  connectorLicense?: string;
  name: string;
  transport: "stdio" | "remote";
  target: string;
  args: string[];
  envNames: string[];
  logLevel: string;
  // Your own OAuth app at the vendor (Asana, Zoom, Docusign, a Google app of your own): its public
  // client id and the fixed callback port registered there. The secret lives in SecretStorage.
  oauth?: { clientId: string; port: number };
};

type ManagedMcpSecrets = { env?: Record<string, string>; token?: string; oauthSecret?: string };
const OAUTH_CLIENT_ID = /^[A-Za-z0-9._:@\/+=-]{3,300}$/;
const validOauth = (value: any): value is { clientId: string; port: number } => !!value && typeof value === "object"
  && typeof value.clientId === "string" && OAUTH_CLIENT_ID.test(value.clientId)
  && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535;

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

/** The file of the focused editor tab, whatever kind of editor shows it (text, diff, notebook,
 * or a custom editor such as the image preview). */
function activeTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
    || input instanceof vscode.TabInputNotebook) { return input.uri; }
  if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) { return input.modified; }
  return undefined;
}

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
    // Only when set, so a server without its own app keeps the identity (and the secrets) it had.
    ...(item.oauth ? { oauth: item.oauth } : {}),
  });
  return createHash("sha256").update(publicIdentity, "utf8").digest("hex");
}

/** How many chats may hold a live `dgc serve` at once. 0 -- the default -- means no limit.
 *
 *  DGC does not invent a number here. A backend is about 9 MB, and writes from several chats into
 *  one checkout are already serialised by the workspace write lease rather than by a chat count, so
 *  nothing in DGC breaks as the count rises. What another chat actually costs is another model
 *  context -- tokens on a cloud endpoint, or a share of a local model -- which only the person
 *  running it can judge. `dgc.maxLiveChats` exists for someone who WANTS a ceiling (set it to 1 to
 *  keep DGC single-chat); left alone, the limit is the machine.
 */
/** `dgc.shareBackend`: chats open on one `dgc serve` when the CLI can hold several (Codex's model:
 *  one process, every session in its own folder). Off, each chat starts its own backend. */
function shareBackend(): boolean {
  return vscode.workspace.getConfiguration("dgc").get<boolean>("shareBackend", true) !== false;
}

function maxLiveChats(): number {
  const raw = vscode.workspace.getConfiguration("dgc").get<number>("maxLiveChats", 0);
  const value = Number.isFinite(raw) ? Math.floor(Number(raw)) : 0;
  return value > 0 ? value : Infinity;
}

/** Panel fields that belong to ONE chat rather than to the panel. Switching chats moves the whole
 *  list out to the outgoing slot and back in from the incoming one, so nothing from the chat you
 *  left can be read as if it described the chat you are looking at. Captured and restored as a
 *  unit by name: a field added here is automatically saved, and one that is only ever captured or
 *  only ever restored cannot exist. */
/** The rejections the settings tab can explain: its own skill toggle, its own usage read, and the
 *  five MCP commands it issues. Anything else that fails reaches it as a typed message, so
 *  forwarding the raw rejection too both duplicated it and let a failure from the CHAT paint a red
 *  banner over a settings page that was working. */
const SETTINGS_REJECTIONS = [
  "set_skill_enabled", "get_usage", "get_pip_usage_report",
  "upsert_mcp_server", "remove_mcp_server", "set_mcp_enabled", "reconnect_mcp_server", "list_mcp_servers",
];

const PER_CHAT_FIELDS = [
  "backend", "initializingBackend", "lastReadyEvent",
  "sessionReady", "sessionRestoreCandidate", "sessionRestoreSaved", "sessionRestoreStarted",
  "sessionRestoreSuppressed", "openDecisions",
  "sessionRestoreFinished", "sessionRestoreRequestId", "sessionDraftSource", "sessionHandshakeGeneration",
  "currentSessionId", "currentSessionName", "currentSessionSaved",
  "turnActive", "confirmedTurnActive", "monitorTurnActive", "liveTurn", "turnStartedAt",
  "correlatedStateRequests", "workspaceRootsRevision", "workspaceRootsDirty", "workspaceRootsInFlight",
  "nativeSettingsReady", "mcpUrls", "unstartedPrompts", "unsentPrompts",
  "workspaceChanges", "chatChanges", "changesRefreshRevision",
  "backendRecoveries", "intentionalShutdown", "pendingCommandRestart",
  "imageRefs", "slashAliases", "behaviorState", "routeState", "state",
  // Derived from `lastReadyEvent`, which IS per-chat -- but derived once, in the `ready` handler,
  // so they are not recomputed on a switch. `dgc.command` restarts only the ACTIVE backend, so two
  // chats really can run different CLI builds: without these, a chat on an older CLI inherited the
  // newer one's capabilities and the panel offered it commands it rejects.
  "composerSelections", "skillManagement", "mcpContext", "mcpManagement", "goalInputs",
  // A chat reattached to a backend that kept running with no window (dgc/serve_detach.py): its handshake
  // repaints from that backend, and its folder grant waits for the running turn to end. A chat shown in
  // another window is read-only here until "Open here".
  "attachedLive", "rootsAfterLiveTurn", "sessionElsewhere",
] as const;

/** Where the window's chats are (#3 Sessions home): the side bar's Sessions list, and a session per
 *  editor tab. sessionTabs.ts implements it. */
export interface ChatPlaces {
  /** The tab the user last worked in, while it is open: palette commands and the status bar follow it. */
  current(): DgcViewProvider | undefined;
  /** A saved session (its id) in a tab of its own, or the tab it is already in; "" opens a new one. */
  open(session: string, title?: string): DgcViewProvider;
  /** The sessions open in tabs. */
  openSessions(): Set<string>;
  /** A tab's session changed, or a tab opened or closed. */
  changed(): void;
}

/** What an editor tab's chat is given when it is made. */
export interface ChatTabInit {
  /** Names the tab's workspace state; kept across a window reload in the webview's own state. */
  key: string;
  /** The session it opens on, or "" for a new one. */
  session: string;
  places: ChatPlaces;
  /** The side bar's provider: the window-wide pieces the tab shares. */
  host: DgcViewProvider;
  /** Names the tab. */
  title(text: string): void;
  /** VS Code brought the tab back after a reload: its session may still be running in the backend the
   *  reload left behind, which may need a moment to fall quiet before it can be reattached to. */
  restored?: boolean;
}

interface ChatSlot {
  /** Stable for the life of the slot; the webview names it when it asks to switch. */
  id: string;
  /** The chat's own name, or its session id, or "New chat" — whatever the chip can show. */
  label: string;
  /** Captured panel fields while this slot is in the background; undefined while it is active. */
  saved?: Record<string, unknown>;
  /** The backend, mirrored here so a background slot can be found without restoring it. */
  backend?: ChatBackend;
  /** The folder this chat works in, when it is not the window's own. Its project root, config,
   *  trust, MCP servers and sessions are that folder's. */
  cwd?: string;
  /** A turn is running in this chat. */
  busy: boolean;
  /** This chat is blocked on a decision only the user can make. */
  needsYou: boolean;
  /** Display events seen since the user last looked at this chat. */
  unread: number;
  /** A turn finished here while the user was looking at another chat: its answer is unread. */
  done?: boolean;
  /** This wait has already been announced in a notification; cleared when nothing waits. */
  announced?: boolean;
  /** Set when this background chat's backend died: why. Switching back starts a fresh one and
   *  resumes the session it was on, so a chat you were not watching is not simply gone. */
  lost?: string;
  /** A `ready` that arrived while this chat was in the background. The handshake it starts writes
   *  the panel's own fields and calls completeHandshake() on the backend, so it can only run for
   *  the chat on screen — and until it does, that backend accepts nothing: every prompt is queued
   *  and never sent. Held here and replayed the moment the chat becomes active. */
  pendingReady?: DgcEvent;
}

export class DgcViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private viewType = "dgc.chat";   // the container the chat currently lives in
  private turnStartedAt = 0;
  private backend?: ChatBackend;
  /** Backends whose own slot has closed while chats other slots opened on them are still running. */
  private releasedHosts = new Set<DgcBackend>();
  /** Folders outside this window you agreed to open a chat in (mayOpenChatIn). */
  private readonly foldersOpenedHere = new Set<string>();
  /** What the panel hung on each backend for its slot, so a slot that goes away can take it off a
   *  process that stays up for other chats. */
  private readonly backendListeners = new WeakMap<object, Array<[string, (...args: any[]) => void]>>();
  /** Bumped by every restart. A chat opens only on a process started since the last one: a restart
   *  is how a new CLI is loaded, and a chat that opened on an older process kept the old one. */
  private processEpoch = 0;
  private readonly processEpochs = new WeakMap<object, number>();
  private state = { model: "", mode: "default", think: "off", ultra: false,
                    baseUrl: "", workspaceTrusted: false,
                    subscriptionEngine: "",
                    goal: { text: "", status: "none", elapsed_seconds: 0 } as { text: string; status: string; elapsed_seconds: number; id?: string } };
  private _installPrompted = false;
  private _updatePrompted = false;
  /** Survives restart() on purpose. A successful update restarts the backend, which clears the
   *  per-attempt latch above; without this the next mismatch would reinstall again, and a CLI
   *  that cannot reach the version the extension wants would reinstall forever. One attempt a
   *  session, then the user decides. */
  private cliAutoUpdateAttempted = false;
  private updateChannel?: vscode.OutputChannel;
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
  private behaviorState = { showReasoning: true, thinkingInline: true, preserveThinking: false, codeAction: false };
  private mcpUrls = new Map<string, McpBrowserRequest>();
  private settingsEditor?: vscode.WebviewPanel;
  /** The CLI takes the web search's address and key from Settings (its config said whether a key is saved). */
  private searchSettable = false;
  /** Which web search providers have a key of their own saved, from a CLI that keeps one per provider
   *  (ready.capabilities.search_keys), kept current from each config reply and each Remove. Undefined: an older CLI
   *  keeps one key for all of them, and Settings shows that one as it always did. */
  private searchKeysSaved?: Map<string, boolean>;
  /** The handshake searchKeysSaved was read from: a new backend's handshake starts it again. */
  private searchKeysFrom?: unknown;
  /** The CLI takes ChatDGC's custom instructions and personality from Settings. */
  private chatdgcSettable = false;
  /** The CLI takes the per-turn token cap from Settings (its config answered turn_token_budget). */
  private budgetSettable = false;
  /** The CLI takes the sub-agents' context window from Settings (its config answered subagent_context_size). */
  private subagentWindowSettable = false;
  /** Settings -> Models: the prompt-cache lifetime and Ollama's keep-loaded time, from a CLI that answers
   *  get_config's "cache_settings" with an event of that name (0.48). Undefined: an older CLI, which would
   *  refuse a save that carried them. */
  private cacheSettings?: { prompt_cache: boolean; prompt_cache_ttl: string; ollama_keep_alive: string };
  /** Settings -> Agents -> Pips: the model every Pip on Default uses ("" follows DGC), from a CLI that answers
   *  get_config's "pips_settings" with an event of that name (0.48). Undefined: an older CLI, which would refuse a
   *  save that carried it. */
  private pipsSettings?: { model: string };
  /** Settings -> Models -> Advanced: how long DGC waits on a model, from a CLI that answers get_config's
   *  "model_wait_settings" with an event of that name (0.48). Undefined: an older CLI, which would refuse a save that
   *  carried them. */
  private waitSettings?: WaitSettings;
  /** The window a vLLM, SGLang or llama.cpp server was started with (server_window, 0.48), for Settings -> General.
   *  Undefined until a CLI that offers it answers; `window` 0 when DGC sizes the window itself. */
  private serverWindow?: { model: string; window: number; server: string; trained: number };
  private pipsEditor?: PipsEditor;
  private pipsDocumentId = randomBytes(16).toString("hex");
  private pendingSignIn?: McpBrowserRequest;
  private pendingSignInServer = "";
  /** The sign-in the browser was opened for: its request id and the chat that asked. Cancel needs
   *  both once the request is answered, to cancel that sign-in rather than the chat's turn. */
  private openedSignIn?: { id: string; be: ChatBackend };
  private settingsSelection = { section: "general", range: "7d" };
  private settingsCatalog: any[] = [];
  private settingsInstalls = new Map<string, string>();
  private settingsPreviews = new Map<string, any>();
  private settingsPreviewRequests = new Map<string, string>();
  /** A plugin key Save or Remove in flight: its request id, to the plugin and server it was for. */
  private settingsKeyRequests = new Map<string, { name: string; server: string; kind?: "scopes" }>();
  private createdPluginFiles = new Set<string>();
  private settingsMcpOperation = 0;
  // ---- 0.40 images: refs this panel was shown, the stored path an `image` answer named for each,
  // and Open file requests waiting on a fresh answer. Never a path the webview supplies.
  private imageRefs = new Map<string, { path?: string }>();
  private imageOpenWaiters = new Map<string, (path: string | undefined) => void>();
  private slashAliases = new Map<string, string>();
  private composerSelections = false;
  private skillManagement = false;
  private mcpContext = false;
  private mcpManagement = false;
  private goalInputs = false;
  private pendingGoalEdit?: string;
  private plaintextSecretWarnings = new Set<string>();
  private turnActive = false;
  // The running turn was started by the backend on a background monitor event. It yields to any
  // user action (the backend stops it and runs the action), so panel-side "wait for the turn"
  // guards let actions through, and it never raises a walk-away notification.
  private monitorTurnActive = false;
  private confirmedTurnActive = false;
  // The running turn as its turn_start (or handoff_started) described it, so a webview reloaded
  // mid-turn can be told a turn is running: its Stop, its clock and the turn a history snapshot
  // leaves open. Meaningful only while confirmedTurnActive.
  private liveTurn: { turnId: string; kind: string; prompt: string; startedAt: number; handoff: boolean } | undefined;
  /** This chat's backend is a window reattached to a session that kept running (ready.capabilities.attached). */
  private attachedLive = false;
  /** The reattached turn was running, so the folder grant waits for it to end, then is sent. */
  private rootsAfterLiveTurn = false;
  /** This chat's session is shown in another window: "moved" (it was taken from here) or "elsewhere"
   *  (it was already there). Read-only here until the user presses "Open here". */
  private sessionElsewhere: { state: "moved" | "elsewhere"; pid?: number; reason?: string } | undefined;
  /** How this provider's next backend asks to reattach: its first after a window opens is a restore. */
  private attachMode: AttachMode = "restore";
  private workspaceRootsRevision = 0;
  private workspaceRootsDirty = true;
  private workspaceRootsInFlight: { revision: number; requestId?: string } | undefined;
  private initializingBackend?: ChatBackend;
  private chatSlotsTimer?: ReturnType<typeof setTimeout>;
  private nativeSettingsReady = false;
  private webviewReady = false;
  private lastReadyEvent?: DgcEvent;
  private currentSessionId = "";
  private currentSessionName = "";
  /** Whether the current chat has a session file: the backend writes one only once the chat has
   *  content (a turn, a name) or when it was resumed or branched from one. */
  private currentSessionSaved = false;
  private sessionRestoreCandidate = "";
  /** The remembered chat had a file when it was remembered (older records say nothing: assume so). */
  private sessionRestoreSaved = true;
  /** This chat was opened deliberately empty, so it must NOT adopt the workspace's remembered
   *  session. Without it the second chat resumed the SAME session as the first, which the backend
   *  correctly refused — one session is held by whichever DGC is running a turn in it — so the
   *  second chat's first turn died on "this session has an active turn in another DGC process". */
  private sessionRestoreSuppressed = false;
  /** Ids of this chat's still-open permission, plan, options and question requests. A chat you
   *  switch away from keeps waiting on them, and its chip is the only place that can say so. */
  private openDecisions = new Set<string>();
  /** Automatic backend restarts in the recent past, so a crash loop cannot spin forever. */
  private backendRecoveries: number[] = [];
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set while restart()/dispose() are tearing the backend down on purpose. */
  private intentionalShutdown = false;
  /** dgc.command changed while a turn was running; restart once that turn ends. */
  private pendingCommandRestart = false;
  private commandRestartCheck: Promise<void> | undefined;
  private commandRestartRecheck = false;
  private sessionRestoreStarted = false;
  private sessionRestoreFinished = false;
  private sessionRestoreRequestId?: string;
  private sessionDraftSource = "";
  private sessionHandshakeGeneration = 0;
  private sessionReady = false;
  /** Prompts sent to the backend whose turn has not started, by request id, in send order. The
   *  webview's own copy dies with a reload, so this is what brings a queued message back. */
  private unstartedPrompts = new Map<string, QueuedPrompt>();
  /** Queued prompts whose backend is gone, waiting for a ready webview and session to take them. */
  private unsentPrompts: QueuedPrompt[] = [];
  private composerScope = "";
  private pendingWebviewActions: Array<() => void> = [];
  private testProbeNonce = "";
  private testPostedMessages: Array<{ type: string; eventType?: string; id?: string; command?: string; fileCount?: number; state?: string; route?: string; label?: string; detail?: string; kind?: string; attempt?: number; retryId?: string }> = [];
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

  // ---- concurrent chats ------------------------------------------------------------------------
  // Up to `dgc.maxLiveChats` chats each hold their own `dgc serve`. Exactly one is "active": its state
  // IS the panel's own fields, so every existing call site keeps working unchanged. The others are
  // parked as captured field sets. Their backends keep running -- that is the whole point -- and
  // their events are read off the pipe and reduced to a chip, never painted into the transcript
  // you are looking at. Switching repaints from the incoming backend's own history snapshot rather
  // than from anything the panel buffered, so the chat you come back to is the backend's truth.
  private slots: ChatSlot[] = [];
  private activeSlotId = "";
  private slotSeq = 0;
  /** The value each per-chat field has before any chat has touched it, captured in the constructor
   *  so a new chat starts from the real initializers and cannot drift from them. */
  private pristineChatState: Record<string, unknown> = {};

  // ---- #3 Sessions home ------------------------------------------------------------------------
  // The side bar is the Sessions home (and the Pips); each coding session opens in an editor tab, a
  // second DgcViewProvider of its own with its own `dgc serve` (sessionTabs.ts). A tab takes the
  // window-wide pieces from the side bar's provider rather than making its own: one status bar item,
  // one backend log, one `dgc-review` provider and one file watcher, one settings editor, and the
  // CLI install/update prompts. Its workspace state is namespaced by its key (stateKey).
  /** Set on an editor tab's provider. */
  private readonly tab?: ChatTabInit;
  /** Set on the side bar's provider once it is the Sessions home (useSessionsHome). */
  private places?: ChatPlaces;
  private home = false;
  /** ChatDGC (chatdgc.ts): only the side bar's provider has it. */
  private chatdgc?: ChatDGC;
  /** Dictation and reading aloud for every message box in the window: the side bar's, made when a box first asks. */
  private dictation?: Dictation;
  private readAloud?: ReadAloud;
  /** This chat's box, and (in the side bar) the Pips box beside it, as dictation knows them: one page, so each says
   *  which box a mic message is for. */
  private readonly micChat: DictationOwner = { post: (message) => this.post({ ...message, from: "chat" }) };
  private readonly micPips: DictationOwner = { post: (message) => this.post({ ...message, from: "pips" }) };
  /** The side bar's tabs: their review documents and file events go through it. */
  private readonly tabProviders = new Set<DgcViewProvider>();
  /** The tab's title has been set from its session or its first prompt. */
  private tabTitled = false;
  private sessionsTimer?: ReturnType<typeof setTimeout>;
  private sessionsRequest = 0;
  // Thousands of sessions (backend capability session_paging): a page at a time, 200 more with Load
  // more, and a search over names, first messages and everything said.
  private sessionsQuery = "";
  private sessionsShown = 200;

  constructor(private readonly context: vscode.ExtensionContext, tab?: ChatTabInit) {
    // Before anything mutates them: this is what "a chat nobody has used yet" looks like. Copied,
    // not referenced -- the field initializers hand out live Maps, and holding those would make
    // "pristine" track whatever the first chat did to them.
    this.pristineChatState = {};
    for (const field of PER_CHAT_FIELDS) {
      this.pristineChatState[field] = this.cloneChatValue((this as any)[field]);
    }
    this.tab = tab;
    if (tab) {
      // A tab opens on its own session (or a new one), never on the window's remembered chat.
      this.sessionRestoreCandidate = tab.session;
      this.sessionRestoreSaved = !!tab.session;
      this.sessionRestoreSuppressed = true;
      this.tabTitled = !!tab.session;              // opened from the list: it already has its title
      this.attachMode = tab.restored ? "restore" : "auto";
      this.backendLog = tab.host.backendLog;
      this.sb = tab.host.sb;
      tab.host.tabProviders.add(this);
    } else {
      this.backendLog = vscode.window.createOutputChannel("DGC Backend");
      // one status-bar item: `model · mode` (click to change model)
      this.sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      this.sb.command = "dgc.selectModel";
    }
    this.adoptQueuedPromptsFromPreviousHost();
    if (tab) { return; }
    if (typeof vscode.workspace.registerTextDocumentContentProvider === "function") {
      this.context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("dgc-review", {
        provideTextDocumentContent: (uri) => {
          const key = uri.toString();
          for (const owner of [this, ...this.tabProviders]) {
            const text = owner.reviewDocuments.get(key);
            if (text !== undefined) { return text; }
          }
          return "";
        },
      }));
    }
    if (typeof vscode.workspace.createFileSystemWatcher === "function") {
      const watcher = vscode.workspace.createFileSystemWatcher("**/*");
      const changed = () => { for (const owner of [this, ...this.tabProviders]) { owner.scheduleWorkspaceChanges(); } };
      watcher.onDidCreate(changed);
      watcher.onDidChange(changed);
      watcher.onDidDelete(changed);
      this.context.subscriptions.push(watcher);
    }
  }

  /** ChatDGC rides on this provider's dgc serve: the side bar's, whose handshake gave it the user's
   *  model settings and keys. It hears every chatdgc_* event (routeEvent) and sends through here. */
  useChatDGC(chat: ChatDGC): void {
    this.chatdgc = chat;
    const host: ChatDGCHost = {
      chatdgcSend: (cmd) => this.chatdgcSend(cmd),
      chatdgcModels: () => this.chatdgcModels(),
      postHome: (message) => { if (this.home && this.webviewReady) this.post(message); },
      openSettings: (section) => this.openSettings(section),
      chatdgcSetWindow: (preset) => {
        const offered = (this.lastReadyEvent?.capabilities as any)?.chatdgc?.windows;
        if (!CHATDGC_WINDOWS.includes(preset) || !Array.isArray(offered) || !offered.includes(preset)) return;
        try {
          this.ensureBackend().send(this.stateCommand("chatdgc-window", { type: "set_config", values: { chatdgc_window: preset } }));
        } catch { /* not running: nothing to change */ }
      },
      chatdgcOffers: () => {
        const offered = (this.lastReadyEvent?.capabilities as any)?.chatdgc;
        return offered && typeof offered === "object" ? offered : {};
      },
      dictation: () => this.dictationService(),
      readAloud: () => this.readAloudService(),
      pluginLogo: (plugin) => this.replyPluginLogo(plugin),
      chatdgcKeepsRunning: () => !!this.processOf(this.backend)?.detach,
      chatdgcOpenHere: () => this.chatdgcOpenHere(),
    };
    chat.attach(host);
  }

  /** The editor's first run with voice: offered once, a moment after DGC is up, unless a model is already there. */
  private offerVoiceOnce(): void {
    if (this.tab || this.voiceOffer || this.context.globalState.get<boolean>(VOICE_OFFERED_KEY)) return;
    if (!(this.lastReadyEvent?.capabilities as any)?.voice) return;
    this.voiceOffer = setTimeout(async () => {
      if (this.context.globalState.get<boolean>(VOICE_OFFERED_KEY)) return;
      const state = await this.dictationService().client.models();
      if ("error" in state) { this.voiceOffer = undefined; return; }               // asked again next start
      void this.context.globalState.update(VOICE_OFFERED_KEY, true);
      if (state.models.some((m: any) => m?.installed)) return;
      const choice = await vscode.window.showInformationMessage(
        `Talk to DGC instead of typing, and hear replies read aloud? Voice runs on your own computer: a one-time download of about ${VOICE_OFFER_MB} MB.`,
        "Set up voice", "Not now");
      if (choice === "Set up voice") this.openSettings("voice");
    }, 6000);
  }
  private voiceOffer?: ReturnType<typeof setTimeout>;

  /** Reading aloud for the window, on the same voice client as dictation. */
  readAloudService(): ReadAloud {
    if (this.tab) return this.tab.host.readAloudService();
    return this.readAloud ??= new ReadAloud(this.dictationService().client);
  }

  /** Dictation for the window: a session tab uses the side bar's, whose process carries voice. */
  dictationService(): Dictation {
    if (this.tab) return this.tab.host.dictationService();
    return this.dictation ??= new Dictation(new VoiceClient({
      send: (cmd) => this.voiceSend(cmd),
      openSettings: (section) => this.openSettings(section),
      where: () => ({ remote: vscode.env.remoteName || "", app: vscode.env.appName || "" }),
      // DGC carries DGC Voice (dist/dgc-voice.vsix), so Install works before it's on the Marketplace.
      offerInstall: (message) => offerVoiceInstall(message, this.context.extensionPath),
    }));
  }

  /** Voice's commands, on the side bar's process as Settings -> Voice uses (dgc/voice). */
  private voiceSend(cmd: Record<string, unknown>): "sent" | "starting" | "old_cli" {
    let be: ChatBackend;
    try { be = this.ensureBackend(); } catch { return "starting"; }
    if (!this.sessionReady || !this.lastReadyEvent || !be.ready) return "starting";
    if (!(this.lastReadyEvent.capabilities as any)?.voice) return "old_cli";
    return be.send(cmd as Parameters<DgcBackend["send"]>[0]) ? "sent" : "starting";
  }

  /** The side bar's backend holds the chats this window shows and moves one with Open here: it opted in to keep
   *  ChatDGC running with no window (set_detach_chatdgc), and offers ready.capabilities.detach.chatdgc_open_here. */
  private chatdgcOpenHere(): boolean {
    const detach = this.processOf(this.backend)?.detach;
    return !!detach && Number((detach as any).chatdgc_open_here) >= 1;
  }

  /** Never a cached backend: the one this provider holds now, started if it has none. A send to a
   *  retired instance would start a child nobody watches. */
  private chatdgcSend(cmd: Record<string, unknown>): "sent" | "starting" | "old_cli" {
    let be: ChatBackend;
    try { be = this.ensureBackend(); } catch { return "starting"; }
    if (!this.sessionReady || !this.lastReadyEvent || !be.ready) { return "starting"; }
    const offered = (this.lastReadyEvent.capabilities as any)?.chatdgc;
    if (!offered || typeof offered !== "object" || Number(offered.version) < 1) { return "old_cli"; }
    return be.send(cmd as any) ? "sent" : "starting";
  }

  private async chatdgcModels(): Promise<{ ids: string[]; current: string }> {
    const current = String(this.state.model || "");
    try { return { ids: await this.fetchModels(), current }; } catch { return { ids: [], current }; }
  }

  /** The side bar becomes the Sessions home: its own chat starts empty rather than on the window's
   *  remembered session (that one opens in a tab from the list), and sessions open in tabs. */
  useSessionsHome(places: ChatPlaces): void {
    this.places = places;
    this.home = true;
    if (!this.backend) {
      this.sessionRestoreCandidate = "";
      this.sessionRestoreSuppressed = true;
    }
  }

  /** Workspace state that belongs to one chat: a tab's is its own. */
  private stateKey(base: string): string {
    return this.tab ? `${base}#${this.tab.key}` : base;
  }

  /** The session this chat is on, or about to resume. */
  sessionId(): string {
    return this.sessionReady ? this.currentSessionId : (this.sessionRestoreCandidate || this.currentSessionId);
  }

  /** A tab the user closed: what it kept for a window reload goes with it. */
  forgetTab(): void {
    if (!this.tab) { return; }
    for (const base of [QUEUED_PROMPTS_KEY, GOAL_PURSUIT_KEY, INTERRUPTED_TURN_KEY, UNASSISTED_EXITS_KEY]) {
      void Promise.resolve(this.context.workspaceState.update(this.stateKey(base), undefined)).catch(() => { /* gone with the tab */ });
    }
  }

  /** Whether the status bar describes this chat: the tab palette commands act on, else the side bar. */
  private ownsStatusBar(): boolean {
    const places = this.tab?.places ?? this.places;
    if (!places) { return true; }
    const current = places.current();
    return this.tab ? current === this : !current;
  }

  paintStatusBar(): void {
    if (!this.ownsStatusBar()) { return; }
    const profile = this.state.ultra ? "Ultra" : this.state.think;
    this.sb.text = `$(circuit-board) ${this.state.model || "dgc"} · ${profile} · ${this.state.mode}`;
    this.sb.tooltip = `DGC — ${this.state.model || "no model"} · ${profile} reasoning · ${this.state.mode} mode · click to change model`;
    this.sb.show();
  }

  /** A tab's name follows its session's name, else its first prompt. */
  private retitle(prompt = ""): void {
    if (!this.tab) { return; }
    const name = this.currentSessionName.trim();
    if (name) { this.tabTitled = true; this.tab.title(name); return; }
    if (prompt.trim() && !this.tabTitled) { this.tabTitled = true; this.tab.title(prompt); }
  }

  /** A tab's session changed: its webview keeps the id for a reload, and the list follows. */
  private tabSessionChanged(): void {
    if (!this.tab) { return; }
    // Only a session with a file: one never sent a message would come back as "no such session".
    this.post({ type: "chat_tab", session: this.currentSessionSaved ? this.currentSessionId : "" });
    this.tab.places.changed();
  }

  /** The tabs changed: the Sessions list marks which sessions are open. */
  sessionsChanged(): void {
    if (!this.home || !this.webviewReady) { return; }
    if (this.sessionsTimer) { clearTimeout(this.sessionsTimer); }
    this.sessionsTimer = setTimeout(() => { this.sessionsTimer = undefined; void this.postSessions(); }, 150);
  }

  /** The Sessions home's list: this project's saved sessions, newest first, and which are open. */
  private async postSessions(): Promise<void> {
    if (!this.home || !this.places) { return; }
    const request = ++this.sessionsRequest;
    let items: any[] = [];
    let error = "";
    try {
      const paging = this.lastReadyEvent?.capabilities?.session_paging === true;
      const command: any = paging
        ? { type: "list_sessions", limit: this.sessionsShown + 1, ...(this.sessionsQuery ? { query: this.sessionsQuery } : {}) }
        : { type: "list_sessions" };
      const response = await this.requestState(this.ensureBackend(), "sessions", command, "sessions", 30000);
      items = Array.isArray(response.items) ? response.items : [];
    } catch (err: any) {
      error = err?.message || "DGC could not list this project's sessions.";
    }
    if (request !== this.sessionsRequest) { return; }
    this.postSessionItems(items, error);
    // Which of them a backend is still running with no window: the list marks them, and the marks
    // follow the work while there is any (live_sessions -> liveSessionsArrived repaints the list).
    this.requestLiveSessions();
  }

  /** The list as last shown, so the running marks can be repainted without asking for it again. */
  private lastSessionItems: any[] | undefined;
  private lastSessionError = "";
  private liveSessionsTimer?: ReturnType<typeof setTimeout>;

  /** Sessions a backend is running with no window, by id: what it is doing. */
  private windowlessSessions(): Map<string, string> {
    const found = new Map<string, string>();
    for (const row of this.runningRows(this.liveSessionRows)) { if (row.session) found.set(row.session, row.work || ""); }
    return found;
  }

  private postSessionItems(items: any[], error = ""): void {
    this.lastSessionItems = items;
    this.lastSessionError = error;
    const windowless = this.windowlessSessions();
    if (this.liveSessionsTimer) { clearTimeout(this.liveSessionsTimer); this.liveSessionsTimer = undefined; }
    if (windowless.size && this.home) {
      // While anything runs with no window, look again now and then: its mark goes when its work ends.
      this.liveSessionsTimer = setTimeout(() => { this.liveSessionsTimer = undefined; this.requestLiveSessions(); }, 30_000);
      (this.liveSessionsTimer as any).unref?.();
    }
    const open = this.places?.openSessions() ?? new Set<string>();
    const paging = this.lastReadyEvent?.capabilities?.session_paging === true;
    // One more than shown was asked for: its presence is what says there are more.
    const shown = paging ? this.sessionsShown : 500;
    this.post({ type: "sessions_list", error, searchable: paging, query: paging ? this.sessionsQuery : "", more: items.length > shown,
      items: items.slice(0, shown).map((item) => {
      const id = path.basename(String(item?.path || "")).replace(/\.json$/i, "");
      return { id, path: String(item?.path || ""), name: String(item?.name || ""), preview: String(item?.preview || ""),
               when: String(item?.when || ""), count: Number(item?.count) || 0, open: open.has(id),
               ...(windowless.has(id) && !open.has(id) ? { windowless: windowless.get(id) || "working" } : {}),
               ...(typeof item?.match === "string" && item.match ? { match: item.match.slice(0, 300) } : {}) };
    }).filter((item) => /^[A-Za-z0-9_-]{1,128}$/.test(item.id)) });
  }

  private openSessionInEditor(id: string, title: string): void {
    if (!this.places || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) { return; }
    this.places.open(id, title);
  }

  private async deleteSessionFromHome(id: string, title: string): Promise<void> {
    if (!this.places || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) { return; }
    if (this.places.openSessions().has(id)) {
      void vscode.window.showInformationMessage("That session is open in a tab. Close its tab first, then delete it.");
      return;
    }
    const DELETE = "Delete";
    const choice = await vscode.window.showWarningMessage(
      `Delete the session “${title || id}”? Its conversation is removed from this project, and this can't be undone.`,
      { modal: true }, DELETE);
    if (choice !== DELETE) { return; }
    try {
      const response = await this.requestState(this.ensureBackend(), "sessions", { type: "delete_session", path: `${id}.json` }, "sessions", 10000);
      if ((response as any).deleted === false) {
        void vscode.window.showWarningMessage("DGC could not delete that session. It may be running a turn in another DGC.");
      }
      this.sessionsRequest++;
      this.postSessionItems(Array.isArray(response.items) ? response.items : []);
    } catch (err: any) {
      void vscode.window.showErrorMessage(err?.message || "DGC could not delete that session.");
    }
  }

  // ---- chat slots ------------------------------------------------------------------------------

  /** One level of copying for the container fields, so a parked chat and a live one never share a
   *  Map or an array. The values inside are treated as immutable by every writer here. */
  private cloneChatValue(value: unknown): unknown {
    if (value instanceof Map) { return new Map(value); }
    if (value instanceof Set) { return new Set(value); }
    if (Array.isArray(value)) { return value.slice(); }
    if (value && typeof value === "object" && (value as object).constructor === Object) { return { ...(value as object) }; }
    return value;                                   // primitives, undefined, and class instances (the backend)
  }

  private captureChatFields(): Record<string, unknown> {
    const saved: Record<string, unknown> = {};
    for (const field of PER_CHAT_FIELDS) { saved[field] = (this as any)[field]; }
    return saved;
  }

  private applyChatFields(saved: Record<string, unknown>): void {
    for (const field of PER_CHAT_FIELDS) { (this as any)[field] = saved[field]; }
  }

  /** The slot whose state the panel's fields currently are. Creates the first one on demand, so a
   *  panel that never switches chats behaves exactly as it did before slots existed. */
  private activeSlot(): ChatSlot {
    let slot = this.slots.find((candidate) => candidate.id === this.activeSlotId);
    if (!slot) {
      slot = { id: `chat-${++this.slotSeq}`, label: "", busy: false, needsYou: false, unread: 0 };
      this.slots.push(slot);
      this.activeSlotId = slot.id;
    }
    return slot;
  }

  /** Park the panel's fields on the active slot. After this the panel's own fields are stale and
   *  the caller must install another slot's before anything reads them. */
  private parkActiveSlot(): ChatSlot {
    const slot = this.activeSlot();
    slot.saved = this.captureChatFields();
    slot.backend = this.backend;
    slot.label = this.chatLabel();
    slot.busy = this.confirmedTurnActive;
    // A chat blocked on a decision stays blocked after you leave it, and its chip is the only
    // thing that can tell you. Dropping this meant the one state worth surfacing was the one
    // state a switch erased.
    slot.needsYou = this.openDecisions.size > 0;
    slot.unread = 0;                                 // you were just looking at it
    slot.done = false;
    return slot;
  }

  /** What the chip shows for a chat: its name if it has one, else a short session id, else new. */
  private chatLabel(): string {
    return (this.currentSessionName || "").trim()
      || (this.currentSessionId ? this.currentSessionId.slice(-6) : "")
      || "New chat";
  }

  private slotById(id: string): ChatSlot | undefined {
    return this.slots.find((slot) => slot.id === id);
  }

  /** Make `id` the chat the panel describes and repaint the transcript from its backend. */
  private switchToSlot(id: string): void {
    if (!id || id === this.activeSlotId) { return; }
    const incoming = this.slotById(id);
    if (!incoming || !incoming.saved) { return; }
    this.parkActiveSlot();
    const saved = incoming.saved;
    incoming.saved = undefined;
    this.activeSlotId = incoming.id;
    this.applyChatFields(saved);
    if (this.sessionReady && this.backend) this.pipsEditor?.ready(this.lastReadyEvent?.capabilities, this.backend);
    else this.pipsEditor?.offline();
    incoming.unread = 0;
    incoming.needsYou = this.openDecisions.size > 0;   // still true; you are just looking at it now
    incoming.announced = false;
    // The window remembers ONE current chat, and it is read whenever a backend starts without
    // suppression — including the replacement after a crash. Leaving it on the chat we just left
    // meant a foreground restart resumed that chat's session here and died on "this session has
    // an active turn in another DGC process": the exact collision this branch set out to fix.
    this.rememberSession();
    this.setReadyContext(!!this.backend?.ready && this.sessionReady);
    // The transcript on screen belongs to the chat we just left. Clear it before a single event of
    // the incoming chat's can land in it, then rebuild from that backend's own snapshot.
    this.post({ type: "chat_switched", slotId: incoming.id, label: incoming.label });
    this.post({ type: "session_elsewhere", ...(this.sessionElsewhere || { state: "none" }) });
    const held = incoming.pendingReady;
    incoming.pendingReady = undefined;
    if (held && this.backend) {
      // Its backend became ready while this chat was in the background. Run that handshake now,
      // through the ordinary path, or the backend never releases and every prompt is swallowed.
      this.onEvent(held);
      this.postChatSlots();
      this.scheduleWorkspaceChanges(0);
      return;
    }
    if (this.backend && this.initializingBackend === this.backend) {
      // This chat was parked in the middle of its handshake, and a handshake cannot finish for a
      // chat nobody is looking at: every door out of maybeCompleteHandshake is guarded on
      // `this.backend === be`, and the `workspace_roots` acknowledgement that clears
      // workspaceRootsInFlight is one of the events backgroundEvent drops. The backend therefore
      // never releases, and every prompt typed here queues for ever. Pick it up from where it
      // stopped, now that this chat is the one on screen.
      this.redriveHandshake(this.backend);
      this.postChatSlots();
      this.postState();
      return;
    }
    if (!this.backend) {
      // Its backend died while we were elsewhere. Start one now; the restore candidate set when we
      // noticed the death puts it back on the same session, and its handshake repaints the panel.
      const lost = incoming.lost;
      incoming.lost = undefined;
      if (lost) { this.post({ type: "stderr", line: `[extension: restarting this chat — ${lost}]` }); }
      try {
        this.ensureBackend();
      } catch (error: any) {
        this.backendNote(`[extension: could not restart the chat — ${error?.message || error}]`);
      }
    } else {
      this.repaintFromBackend();
    }
    this.postChatSlots();
    this.postState();
    this.scheduleWorkspaceChanges(0);
  }

  /** Palette and header: DGC: Open a Chat in Another Folder. */
  async newChatInFolder(): Promise<void> {
    if (this.atChatLimit()) { return; }          // before the picker, not after a folder is chosen
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      openLabel: "Open chat here", title: "Open a DGC chat in a folder",
    });
    const folder = picked?.[0]?.fsPath;
    if (!folder) { return; }
    if (!(await this.mayOpenChatIn(folder))) { return; }
    this.focus();
    this.inVisiblePanel(() => this.openChatSlot(folder));
  }

  /** A chat in a folder starts your MCP servers there and runs your hooks with it as their working
   *  directory before you type anything -- a cloned repository's own scripts among them (a relative
   *  hook command, a package npx finds in its node_modules). VS Code's workspace trust covers only
   *  this window's folders, and the extension does not run in a window that is not trusted; any
   *  other folder is asked about first, as the terminal's /new DIR does. Once per folder per window. */
  private async mayOpenChatIn(folder: string): Promise<boolean> {
    const real = (target: string) => { try { return fs.realpathSync(target); } catch { return resolve(target); } };
    const target = real(folder);
    const inWindow = vscode.workspace.isTrusted !== false && (vscode.workspace.workspaceFolders || [])
      .some((root) => { const base = real(root.uri.fsPath); return target === base || target.startsWith(base + sep); });
    if (inWindow || this.foldersOpenedHere.has(target)) { return true; }
    const open = "Trust it and open";
    const choice = await vscode.window.showWarningMessage(`Open a DGC chat in ${target}?`, {
      modal: true,
      detail: "DGC starts your MCP servers there and runs your hooks with that folder as their working "
        + "directory, so scripts it contains can run. Open it only if you trust what is in it.",
    }, open);
    if (choice !== open) { return false; }
    this.foldersOpenedHere.add(target);
    return true;
  }

  /** Start a second (or third, if the ceiling ever rises) chat with its own backend. */
  /** At the user's own ceiling (`dgc.maxLiveChats`): says so, and returns true. */
  private atChatLimit(): boolean {
    if (this.slots.length < maxLiveChats()) { return false; }
    // Only reachable when the user set a ceiling themselves.
    void vscode.window.showInformationMessage(
      `DGC is running ${this.slots.length} chats, the limit set in "dgc.maxLiveChats". `
      + "Close one, or raise the setting.");
    return true;
  }

  private openChatSlot(cwd?: string, sessionId = ""): void {
    if (this.atChatLimit()) { return; }
    this.parkActiveSlot();
    const slot: ChatSlot = { id: `chat-${++this.slotSeq}`, label: "New chat", busy: false, needsYou: false, unread: 0,
                             ...(cwd && cwd !== this.cwd() ? { cwd } : {}) };
    this.slots.push(slot);
    this.activeSlotId = slot.id;
    // A brand-new chat starts from the field initializers, not from whatever the last chat left.
    const fresh: Record<string, unknown> = {};
    for (const field of PER_CHAT_FIELDS) { fresh[field] = this.cloneChatValue(this.pristineChatState[field]); }
    this.applyChatFields(fresh);
    this.pipsEditor?.offline();
    this.sessionRestoreCandidate = sessionId;        // a new chat resumes nothing -- unless opened ON a session
    this.sessionRestoreSaved = true;
    this.sessionRestoreSuppressed = true;            // …and ensureBackend must not re-add one
    this.sessionRestoreStarted = true;
    this.setReadyContext(false);
    this.post({ type: "chat_switched", slotId: slot.id, label: slot.label });
    this.postChatSlots();
    try {
      this.ensureBackend();                          // spawns this chat's own `dgc serve`
    } catch (error: any) {
      this.backendNote(`[extension: could not start a second chat — ${error?.message || error}]`);
    }
  }

  /** Close a chat: its backend is told to stop, and the slot goes away. The last one never does. */
  private closeChatSlot(id: string): void {
    const slot = this.slotById(id);
    if (!slot || this.slots.length < 2) { return; }
    if (slot.id === this.activeSlotId) {
      const other = this.slots.find((candidate) => candidate.id !== slot.id);
      if (!other) { return; }
      // Move off it first so the panel is never describing a chat that is being torn down.
      this.switchToSlot(other.id);
    }
    const be = slot.backend || (slot.saved?.backend as ChatBackend | undefined);
    this.slots = this.slots.filter((candidate) => candidate.id !== slot.id);
    // close, not dispose: if this slot started the process that other chats were opened on, the
    // process stays up for them and stops when the last of them closes.
    const cause = `${CHAT_CLOSED_CAUSE}${slot.label || slot.id}`;
    try { be?.close(cause); } catch { /* already gone */ }
    const released = be as DgcBackend | undefined;
    if (released?.ownerReleased && released.chatUsers instanceof Set) {
      // Nothing about the process to log -- it did not stop -- but the chat did end.
      const others = released.chatUsers.size;
      this.backendNote(`[extension: closed the chat in ${slot.cwd || this.cwd()} — ${cause}; dgc serve pid `
        + `${released.childPid ?? "?"} stays up for ${others} other chat${others === 1 ? "" : "s"}]`);
      // The process stays up for the chats opened on it; this slot's handlers go. What its own
      // chat says from here (the retirement close() asked for) has no tab to go to.
      for (const [name, handler] of this.backendListeners.get(released) || []) {
        released.off(name, handler);
      }
      this.releasedHosts.add(released);
      released.once("exit", () => this.releasedHosts.delete(released));
      released.once("disposed", () => this.releasedHosts.delete(released));
    }
    this.postChatSlots();
  }

  /** Palette: DGC: Open a Second Chat. */
  newParallelChat(): void {
    this.focus();
    this.inVisiblePanel(() => this.openChatSlot());
  }

  /** The user dragged a chat's tab to another place in the rail. Order is all that changes. */
  private moveChatSlot(id: string, toIndex: number): void {
    const from = this.slots.findIndex((slot) => slot.id === id);
    if (from < 0 || !Number.isInteger(toIndex)) return;
    const to = Math.max(0, Math.min(this.slots.length - 1, toIndex));
    if (to !== from) {
      const [slot] = this.slots.splice(from, 1);
      this.slots.splice(to, 0, slot);
    }
    this.postChatSlots();
  }

  /** Palette: DGC: Switch Chat. Lists the running chats and what each is doing. */
  async pickChat(): Promise<void> {
    if (this.slots.length < 2) {
      const start = "Open a second chat";
      const choice = await vscode.window.showInformationMessage(
        "Only one chat is running.", start);
      if (choice === start) { this.newParallelChat(); }
      return;
    }
    const active = this.activeSlot();
    active.label = this.chatLabel();
    const items = this.slots.map((slot) => {
      const showing = slot.id === this.activeSlotId;
      const busy = showing ? this.confirmedTurnActive : slot.busy;
      const detail = slot.lost ? `stopped — ${slot.lost}`
        : !showing && slot.needsYou ? "waiting for you"
        : busy ? "working" : !showing && slot.done ? "finished · not read yet" : "idle";
      return {
        label: slot.id === this.activeSlotId ? this.chatLabel() : (slot.label || "New chat"),
        description: showing ? `$(check) showing · ${detail}` : detail,
        slotId: slot.id,
      };
    });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Switch to a running chat" });
    if (picked) { this.focus(); this.inVisiblePanel(() => this.switchToSlot(picked.slotId)); }
  }

  /** Tell the webview what chats exist, which one it is showing, and what the others are doing. */
  /** Post the rail soon, not now. The webview rebuilds every tab on each message, so a streaming
   *  background chat was costing one full rebuild per token. One frame's worth of delay collapses
   *  a whole response into a handful of posts, and the count on the chip is no less useful for it. */
  private scheduleChatSlotsPost(): void {
    if (this.chatSlotsTimer !== undefined) { return; }
    this.chatSlotsTimer = setTimeout(() => {
      this.chatSlotsTimer = undefined;
      this.postChatSlots();
    }, CHAT_SLOTS_COALESCE_MS);
  }

  /** Did WE stop this backend on purpose? Those paths own their own lifecycle and must not be
   *  logged as a crash, nor arm the slot to resume the session it was on. Closing a chat belongs
   *  here: it was reported to the user as that chat losing its backend, in the one log they are
   *  told to open when a chat disappears. */
  private isDeliberateStop(cause: string): boolean {
    return cause.startsWith("restart: ") || cause === PANEL_DISPOSED_CAUSE
      || cause.startsWith(CHAT_CLOSED_CAUSE);
  }

  /** What a backend's unassisted exit does to the panel's own records. Those records belong to the
   *  chat ON SCREEN, so a background child's death must reach `backgroundBackendLost` and stop —
   *  it was stamping its own cause onto the foreground chat's still-running turn. Returns what the
   *  caller should report as resumable, or undefined when the death was not the active chat's. */
  private recordExitAgainstActiveChat(slot: ChatSlot, cause: string,
                                      lastFrame: string): string | undefined {
    if (slot.id !== this.activeSlotId) {
      this.backgroundBackendLost(slot, cause);
      return undefined;
    }
    return this.markInterruptedWork(cause, this.recordUnassistedExit(cause, lastFrame));
  }

  /** Which decision an event is about. `ask_request`/`ask_resolved` carry `ask_id`; every other
   *  decision event carries `id`. Reading only `id` on the add side meant an open ask was never
   *  recorded, so switching away from a chat that was waiting on one showed it as idle. */
  private static decisionId(ev: unknown): string {
    const row = (ev || {}) as Record<string, unknown>;
    return String(row.id ?? row.ask_id ?? row.request_id ?? "");
  }

  private postChatSlots(): void {
    if (this.chatSlotsTimer !== undefined) {
      clearTimeout(this.chatSlotsTimer);
      this.chatSlotsTimer = undefined;
    }
    const active = this.activeSlot();
    active.label = this.chatLabel();
    active.busy = this.confirmedTurnActive;
    this.post({
      type: "chat_slots",
      // 0 tells the webview there is no ceiling, so the + never disables. JSON has no Infinity.
      max: Number.isFinite(maxLiveChats()) ? maxLiveChats() : 0,
      activeId: this.activeSlotId,
      items: this.slots.map((slot) => ({
        id: slot.id,
        label: slot.id === this.activeSlotId ? this.chatLabel() : (slot.label || "New chat"),
        active: slot.id === this.activeSlotId,
        busy: slot.id === this.activeSlotId ? this.confirmedTurnActive : slot.busy,
        needsYou: slot.id === this.activeSlotId ? false : slot.needsYou,
        unread: slot.id === this.activeSlotId ? 0 : slot.unread,
        done: slot.id === this.activeSlotId ? false : !!slot.done,
        ...(slot.cwd ? { folder: path.basename(slot.cwd) || slot.cwd } : {}),
      })),
    });
  }

  /** Rebuild everything the transcript shows from the ACTIVE backend's own snapshot.
   *
   *  Two callers need exactly this: a webview that just (re)loaded and knows nothing, and a switch
   *  to another chat, whose transcript the webview has just been told to clear. Asking the backend
   *  rather than replaying anything the panel kept is what makes both safe -- `get_history` is
   *  taken under the backend's turn-state lock, so it carries the running turn's bytes so far and
   *  is followed by a fresh announcement of every decision that turn is blocked on, with the same
   *  request ids. Events that arrive after it on the pipe are exactly the ones it does not contain.
   */
  private repaintFromBackend(): void {
    if (!this.webviewReady) { return; }
    const be = this.backend;
    if (this.lastReadyEvent) {
      this.post({ type: "event", event: { ...this.lastReadyEvent, session_id: this.currentSessionId,
        session_name: this.currentSessionName } });
    }
    if (this.sessionElsewhere) { this.post({ type: "session_elsewhere", ...this.sessionElsewhere }); }
    if (this.sessionReady) {
      this.post({ type: "session_ready", sessionId: this.currentSessionId });
      if (be && this.lastReadyEvent?.capabilities?.history_snapshot) {
        be.send({ type: "get_history", request_id: this.nextRequestId("restore-history") });
      }
      // A webview that knows nothing of a running turn: say so before the snapshot lands, so Stop
      // shows and the snapshot's unfinished last turn stays the live one (the backend re-sends the
      // question or approval it is waiting on right after it).
      if (this.confirmedTurnActive && this.liveTurn) {
        this.post({ type: "turn_active", ...this.liveTurn,
                    history: this.lastReadyEvent?.capabilities?.history_snapshot === true });
      }
      // An empty monitors rail knows no monitor ids, so it would drop the end of one that is still
      // running. The backend's list restores both.
      if (be && this.lastReadyEvent?.capabilities?.monitors) {
        be.send({ type: "list_monitors", request_id: this.nextRequestId("monitors-restore") });
      }
      // Nor a running troupe's row above the prompt, with its Stop.
      if (be && (this.lastReadyEvent?.capabilities as any)?.troupe) {
        be.send({ type: "list_troupes", request_id: this.nextRequestId("troupes-restore") });
      }
      // Nor is there an agents list; the backend's snapshot brings back the pill.
      if (be && this.lastReadyEvent?.capabilities?.agents) {
        be.send({ type: "list_agents", request_id: this.nextRequestId("agents-restore") });
      }
      // Nor the background commands the agent map lists.
      if (be && this.backgroundTasks()) {
        be.send({ type: "list_background_shells", request_id: this.nextRequestId("shells-restore") } as any);
      }
      // Nor the messages queued behind the running turn: without them a Stop (or the backend going
      // away) had nothing to hand back, and the user's words were lost.
      const queued = [...this.unstartedPrompts.values()].filter((prompt) => prompt.queued);
      if (queued.length) { this.post({ type: "prompts_queued", items: queued }); }
      this.surfaceUnsentPrompts();
    }
  }

  /** Every event from a backend arrives here first, tagged with the chat that owns it. The active
   *  chat's events take the ordinary path. A background chat's are reduced to chip state: they are
   *  NOT painted, and nothing is buffered, because switching asks that backend for its own history
   *  snapshot -- which re-announces whatever decision it is blocked on, with the same request ids. */
  private routeEvent(slot: ChatSlot, ev: DgcEvent): void {
    // ChatDGC's, never a session's: no transcript, chip or card of this chat is about a ChatDGC chat.
    if (isChatdgcEvent(ev as any)) { this.chatdgc?.onEvent(ev); return; }
    // A dictation's answer, whichever chat's process carried it: no session's.
    if (String(ev.type).startsWith("voice_") && this.dictation?.client.onEvent(ev)) return;
    if (slot.id === this.activeSlotId) { this.onEvent(ev); return; }
    this.backgroundEvent(slot, ev);
  }

  /** A chat the user is not looking at lost its backend. Nothing can be posted to the transcript
   *  for it -- the transcript belongs to another chat -- so the chip carries the news, and the
   *  slot is armed to resume its session in a fresh child the moment the user switches to it. */
  private backgroundBackendLost(slot: ChatSlot, cause: string): void {
    if (slot.id === this.activeSlotId) { return; }
    slot.lost = cause || "the backend stopped";
    slot.busy = false;
    slot.needsYou = false;
    slot.backend = undefined;
    // Hand its unsent messages back, as the foreground path does. They were the user's words and
    // were being dropped without a trace when the chat they were typed in was not on screen.
    const parked = slot.saved;
    if (parked) {
      const queued = [...((parked.unstartedPrompts as Map<string, QueuedPrompt>) || new Map()).values()]
        .filter((prompt) => prompt.queued);
      if (queued.length) {
        parked.unsentPrompts = [...((parked.unsentPrompts as QueuedPrompt[]) || []), ...queued];
        (parked.unstartedPrompts as Map<string, QueuedPrompt>).clear();
      }
    }
    if (slot.saved) {
      const sessionId = String(slot.saved.currentSessionId || "");
      slot.saved.backend = undefined;
      slot.saved.initializingBackend = undefined;
      slot.saved.sessionReady = false;
      slot.saved.turnActive = false;
      slot.saved.confirmedTurnActive = false;
      slot.saved.monitorTurnActive = false;
      slot.saved.liveTurn = undefined;
      // Resume what it was on rather than opening an empty chat under the same chip.
      slot.saved.sessionRestoreCandidate = sessionId;
      slot.saved.sessionRestoreSuppressed = true;    // its own session, not the workspace's
      slot.saved.sessionRestoreStarted = false;
      slot.saved.sessionRestoreFinished = false;
      slot.saved.sessionRestoreSaved = true;
    }
    this.backendNote(`[extension: the background chat "${slot.label || slot.id}" lost its backend — ${slot.lost}]`);
    this.postChatSlots();
  }

  /** The parked chat's own set of open decisions: the one a switch restores. */
  private static parkedDecisions(slot: ChatSlot): Set<string> {
    const saved = slot.saved || (slot.saved = {});
    if (!(saved.openDecisions instanceof Set)) { saved.openDecisions = new Set<string>(); }
    return saved.openDecisions as Set<string>;
  }

  private backgroundEvent(slot: ChatSlot, ev: DgcEvent): void {
    const type = String((ev as any)?.type || "");
    // A background chat's turn flags live in its parked fields, which a switch puts back. Setting
    // only the chip left `confirmedTurnActive` true in them after the turn ended, so coming back
    // to a finished chat showed it working until its next turn.
    const saved = slot.saved;
    switch (type) {
      case "turn_start":
        slot.busy = true;
        slot.done = false;
        if (saved) {
          saved.turnActive = saved.confirmedTurnActive = true;
          saved.monitorTurnActive = (ev as any).kind === "monitor";
          saved.turnStartedAt = Date.now();
          saved.liveTurn = { turnId: String((ev as any).turn_id || ""), kind: String((ev as any).kind || "prompt"),
                             prompt: String((ev as any).prompt || ""), startedAt: Date.now(), handoff: false };
        }
        break;
      case "turn_end":
        slot.busy = false;
        slot.done = true;                            // an answer you have not read yet
        slot.needsYou = false;
        slot.announced = false;
        if (saved) {
          saved.turnActive = saved.confirmedTurnActive = saved.monitorTurnActive = false;
          saved.liveTurn = undefined;
          DgcViewProvider.parkedDecisions(slot).clear();   // nothing can still be waiting
        }
        // A dgc.command restart waits for every chat on the process, not only the one on screen.
        if (this.pendingCommandRestart) { setTimeout(() => this.runPendingCommandRestart(), 0); }
        break;
      case "session":
        slot.label = String((ev as any).name || "").trim()
          || String((ev as any).session_id || "").slice(-6) || "New chat";
        break;
      case "session_named":
        slot.label = String((ev as any).name || "").trim() || slot.label;
        break;
      case "ready":
        // Hold it: the handshake it begins can only run for the active chat. Replayed on switch.
        slot.pendingReady = ev;
        slot.label = String((ev as any).session_name || "").trim()
          || String((ev as any).session_id || "").slice(-6) || slot.label;
        break;
      // The real names, from schemas/editor-protocol-v14.schema.json. An earlier version of this
      // switch listed `plan_request`, `question_request` and `ask` — none of which the protocol
      // emits — so a chat blocked on a plan or a question showed no dot at all.
      // A chat can be blocked on several decisions at once — the active path keeps a Set for
      // exactly that reason (`openDecisions`), and a prompt can carry up to four open asks. A
      // boolean cleared by the first resolve put the dot out while the chat was still stopped on
      // the others, and nothing else would ever light it again.
      case "permission_request":
      case "options_request":
      case "ask_request":
      case "plan_proposal": {
        // Recorded in the chat's own parked set, so a switch in and out without answering still
        // knows it is waiting. A separate copy here was never restored.
        const id = DgcViewProvider.decisionId(ev);
        if (id) { DgcViewProvider.parkedDecisions(slot).add(id); }
        slot.needsYou = true;
        this.announceWaiting(slot, type);
        break;
      }
      case "permission_resolved":
      case "options_resolved":
      case "ask_resolved":
      case "request_expired": {
        const open = DgcViewProvider.parkedDecisions(slot);
        open.delete(DgcViewProvider.decisionId(ev));
        slot.needsYou = open.size > 0;
        if (!slot.needsYou) { slot.announced = false; }
        break;
      }
      case "text_delta":
      case "tool_call":
        slot.unread++;
        // The chip shows a COUNT, and the CLI emits one text_delta per stream chunk. Reposting
        // each time sent one message per token and rebuilt the whole rail DOM in the webview
        // (replaceChildren on every tab), which also drops keyboard focus if it is on a tab.
        // Coalesce: the count is worth showing promptly, not instantly.
        this.scheduleChatSlotsPost();
        return;
      default:
        return;                                      // nothing the chip shows: no repost
    }
    this.postChatSlots();
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

  /** The Sessions home's own backend, by its chat's session id: the one a reload asks for back (ChatDGC replies it
   *  keeps running with no window, set_detach_chatdgc). Kept per workspace, as the window's remembered chat is. */
  private rememberHomeBackend(): void {
    if (!this.home || !/^[A-Za-z0-9_-]{1,128}$/.test(this.currentSessionId)) { return; }
    try {
      void Promise.resolve(this.context.workspaceState.update(HOME_BACKEND_KEY, { scope: this.draftScope(), session: this.currentSessionId }))
        .catch(() => { /* only a reload's reattach is lost: the chats are on disk */ });
    } catch { /* the same */ }
  }

  private keptHomeBackend(): string {
    try {
      const kept = this.context.workspaceState.get<{ scope?: string; session?: string }>(HOME_BACKEND_KEY);
      return kept?.scope === this.draftScope() && /^[A-Za-z0-9_-]{1,128}$/.test(String(kept.session || "")) ? String(kept.session) : "";
    } catch { return ""; }
  }

  private rememberSession(): void {
    if (!this.currentSessionId) { return; }
    // A tab's session is kept by the tab itself (sessionTabs.ts): the window's one remembered chat is
    // the side bar's, and a tab writing it made the side bar resume a session a tab holds.
    if (this.tab) { return; }
    // A chat in another folder: its session is that folder's, and the window reopens on its own.
    if (this.slots.find((slot) => slot.id === this.activeSlotId)?.cwd) { return; }
    void this.context.workspaceState.update("dgc.activeSession.v1", {
      scope: this.draftScope(), id: this.currentSessionId, saved: this.currentSessionSaved,
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

  private finishSessionHandshake(be: ChatBackend, adoptDraftFrom = ""): void {
    if (this.backend !== be) { return; }
    const reattached = this.attachedLive;
    this.attachedLive = false;
    this.sessionReady = true;
    this.setReadyContext(true);                                             // gates palette entries
    this.rememberSession();
    if (reattached) {
      // Exactly what a reloaded webview gets: ready, session_ready and the running turn in one go, then
      // the backend's own snapshot, the decisions it waits on (same ids), and its agents, watchers and
      // tasks. The events that arrive after the snapshot are the ones it does not hold.
      this.repaintFromBackend();
    } else {
      this.post({ type: "session_ready", sessionId: this.currentSessionId, adoptDraftFrom });
    }
    if (this.sessionElsewhere) {
      const shown = this.sessionElsewhere;
      this.whenWebviewReady(() => this.post({ type: "session_elsewhere", ...shown }));
    }
    this.surfaceUnsentPrompts();
    this.initializingBackend = undefined;
    this.nativeSettingsReady = false;
    be.completeHandshake();
    this.chatdgc?.backendReady(reattached);
    if (this.chatdgc) {
      const offered = !!(this.lastReadyEvent?.capabilities as any)?.chatdgc;
      if (this.context.globalState.get<boolean>(CHATDGC_SEEN_KEY) !== offered) void this.context.globalState.update(CHATDGC_SEEN_KEY, offered);
      this.offerVoiceOnce();
    }
    // A new backend (first start, crash recovery) owns the truth about this chat's agents: its
    // snapshot replaces whatever the webview marked stopped when the old one exited.
    if (this.lastReadyEvent?.capabilities?.agents) {
      be.send({ type: "list_agents", request_id: this.nextRequestId("agents-restore") });
    }
    // And about its background commands. The CLI pushes a shell's start and end only to a client
    // that has asked for the list once; the agents pill counts the running ones, so it asks now
    // rather than when the agent map first opens.
    if (this.backgroundTasks()) {
      be.send({ type: "list_background_shells", request_id: this.nextRequestId("shells-restore") } as any);
    }
    this.scheduleWorkspaceChanges(0);
    if (this.settingsEditor) this.refreshEditorSettings();   // new backend, same page the user is on
    this.pipsEditor?.ready(this.lastReadyEvent?.capabilities, this.backend);
    this.startPipsAttention();
    // A reattached chat's turn did not stop: it is still running, or it finished with no window.
    if (!reattached) { void this.resumeInterruptedWork(be); }
  }

  private pipsAttentionTimer?: ReturnType<typeof setInterval>;
  private pipsAttentionBusy = false;

  /** Once a minute, whether the panel is on screen or not: a new Pip alert or review says so once. */
  private startPipsAttention(): void {
    if (this.pipsAttentionTimer) return;
    // Unref'd: the watcher never keeps a process alive on its own (tests, a shutting-down host).
    this.pipsAttentionTimer = setInterval(() => { void this.checkPipsAttention(); }, PIPS_ATTENTION_MS);
    (this.pipsAttentionTimer as any).unref?.();
    (setTimeout(() => { void this.checkPipsAttention(); }, 3_000) as any).unref?.();
  }

  private async checkPipsAttention(): Promise<void> {
    if (this.pipsAttentionBusy || !this.sessionReady || !this.backend) return;
    if (!vscode.workspace.getConfiguration("dgc").get<boolean>("notifyPips", true)) return;
    const caps = this.lastReadyEvent?.capabilities;
    if (caps?.pips_enabled !== true || !(Number(caps?.pips_api_version) >= 41)) return;
    this.pipsAttentionBusy = true;
    try {
      const bridge = this.ensurePipsBridge();
      const result = await bridge.hostRead("get_pip_digest");
      let waiting: number | undefined;
      if (Number(caps?.pips_api_version) >= 44) {
        try { const list = await bridge.hostRead("list_pip_attention", { limit: 1 }); if (Number.isSafeInteger(list?.total)) waiting = list.total; }
        catch { /* the digest alone still counts reviews and drafts */ }
      }
      const notice = pipsAttention(result?.digest, this.context.globalState.get<PipsAttentionState>(PIPS_ATTENTION_KEY), waiting);
      if (!notice) return;
      await this.context.globalState.update(PIPS_ATTENTION_KEY, notice.state);
      if (!notice.text) return;
      const open = "Open Pips";
      void Promise.resolve(vscode.window.showInformationMessage(notice.text, open)).then((choice) => {
        if (choice === open) this.openPips();
      });
    } catch {
      // Nothing to say when Pips cannot be read; the bar and the Pips view show the error.
    } finally {
      this.pipsAttentionBusy = false;
    }
  }

  /** Post to the webview now, or as soon as it exists — without pulling the panel into focus. */
  private whenWebviewReady(action: () => void): void {
    if (this.webviewReady) { action(); return; }
    if (this.pendingWebviewActions.length < 16) { this.pendingWebviewActions.push(action); }
  }

  /**
   * After a reconnect, pick up what the dead backend was doing: a goal resumes by itself (unless
   * the same death keeps repeating), and an ordinary turn is OFFERED a Continue — never re-run
   * behind the user's back, because a half-finished step (a partial install, a migration) may not
   * be safe to repeat.
   */
  private async resumeInterruptedWork(be: ChatBackend): Promise<void> {
    const goal = this.context.workspaceState.get<{ scope?: string; id?: string }>(this.stateKey(GOAL_PURSUIT_KEY));
    if (goal && goal.scope === this.draftScope() && goal.id === this.currentSessionId) {
      await this.forgetInterruptedTurn();          // the goal's own resume covers its turn
      await this.resumeInterruptedGoal(be);
      return;
    }
    await this.offerInterruptedTurn(be);
  }

  private async forgetInterruptedTurn(): Promise<void> {
    try {
      await this.context.workspaceState.update(this.stateKey(INTERRUPTED_TURN_KEY), undefined);
    } catch { /* losing the marker only costs a Continue offer */ }
  }

  private noteInterruptedTurn(update: Partial<InterruptedTurnMark> | undefined): void {
    const current = this.context.workspaceState.get<InterruptedTurnMark>(this.stateKey(INTERRUPTED_TURN_KEY));
    // A new turn starts a fresh record; anything else only amends the record that exists.
    if (update !== undefined && update.turnId === undefined && !current) { return; }
    if (update === undefined && !current) { return; }
    const next = update === undefined ? undefined
      : { ...(update.turnId !== undefined ? {} : current), ...update };
    void Promise.resolve(this.context.workspaceState.update(this.stateKey(INTERRUPTED_TURN_KEY), next))
      .then(undefined, () => { /* losing the marker only costs a Continue offer */ });
  }

  private async offerInterruptedTurn(be: ChatBackend): Promise<void> {
    const mark = this.context.workspaceState.get<InterruptedTurnMark>(this.stateKey(INTERRUPTED_TURN_KEY));
    if (!mark) { return; }
    if (mark.scope !== this.draftScope() || mark.id !== this.currentSessionId) { return; }
    await this.forgetInterruptedTurn();              // one offer per interruption, never a loop
    // The turn ran on a backend that keeps working when its window goes, and the window went (no exit was
    // seen). If that backend later stopped it, it says so itself (turn_interrupted); if it finished, there
    // is nothing to continue. A backend this window saw die is an interruption as before.
    if (mark.detachedAt && !mark.exitedAt && (this.lastReadyEvent?.capabilities as any)?.detach) { return; }
    // A turn that ended with an error and no backend death behind it failed on its own; the
    // user has already seen why. A turn with neither an end nor a recorded exit was cut off with
    // the extension host (a reload or crash), which is an interruption too.
    if (mark.endedAt && !mark.exitedAt) { return; }
    const age = Date.now() - Number(mark.exitedAt || mark.at || 0);
    if (!(age >= 0 && age < GOAL_PURSUIT_MAX_AGE_MS)) { return; }
    if (this.backend !== be || this.lastReadyEvent?.capabilities?.resume_turn !== true) { return; }
    this.backendNote(`[extension: offering to continue the interrupted turn${mark.cause ? ` — ${mark.cause}` : ""}]`);
    this.whenWebviewReady(() => this.post({ type: "continue_offer", cause: String(mark.cause || ""),
                                            sessionId: this.currentSessionId }));
  }

  /** A backend that kept this session running with no window stopped its turn there (an hour waiting on
   *  an answer, the 12-hour limit, `dgc stop`, an update): the next window to open it offers Continue,
   *  once. The question it was waiting on is in the replayed transcript above it. */
  private offerTurnStoppedWithoutWindow(ev: DgcEvent): void {
    if (String((ev as any).session_id || "") !== this.currentSessionId) { return; }
    if (this.lastReadyEvent?.capabilities?.resume_turn !== true) { return; }
    const cause = String((ev as any).cause || "").slice(0, 300);
    this.backendNote(`[extension: offering to continue a turn stopped while no window was open${cause ? ` — ${cause}` : ""}]`);
    this.whenWebviewReady(() => this.post({ type: "continue_offer", cause, sessionId: this.currentSessionId,
                                            windowless: true }));
  }

  /** This chat's session is shown in another window now ("Open here" there), or this window went quiet
   *  for so long that its backend let it go: nothing stopped. The transcript stays, read-only, with Open
   *  here; the backend this chat had is released, not stopped. */
  private sessionMoved(reason: string): void {
    this.sessionElsewhere = { state: "moved", reason: reason.slice(0, 64) };
    this.noteInterruptedTurn(undefined);                // the turn goes on where the session is now
    this.backendNote(`[extension: this session is open in another window now (${reason || "opened elsewhere"}); `
      + "this one shows it read-only]");
    const shown = this.sessionElsewhere;
    this.whenWebviewReady(() => this.post({ type: "session_elsewhere", ...shown }));
  }

  /** "Open here": take this chat's session from the window that shows it, or from the backend that kept
   *  it running. That window keeps its transcript, read-only, with an Open here of its own, and the work
   *  never stops: this window reattaches to the process that has it. */
  openSessionHere(): void {
    const id = this.currentSessionId || this.sessionRestoreCandidate;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) { return; }
    this.backendNote(`[extension: Open here — taking session ${id} into this window]`);
    this.sessionElsewhere = undefined;
    this.sessionRestoreCandidate = id;
    this.sessionRestoreSaved = true;
    this.sessionRestoreSuppressed = true;
    this.attachMode = "steal";
    this.restart("Open here");
  }

  /** The DGC processes on this computer (list_live_sessions / stop_live_session): Settings -> Running
   *  sessions, and the Sessions list's "Running, no window". */
  private liveSessionsArrived(ev: DgcEvent): void {
    const items = Array.isArray((ev as any).items) ? (ev as any).items : [];
    this.liveSessionRows = items;
    const message = typeof (ev as any).message === "string" ? (ev as any).message : "";
    this.settingsEditor?.webview.postMessage({ type: "running", items: this.runningRows(items), message });
    if (this.home && this.lastSessionItems) { this.postSessionItems(this.lastSessionItems, this.lastSessionError); }
  }

  /** What Settings -> Running sessions lists: each session a backend is running with no window, and each ChatDGC
   *  chat a Sessions home's backend is answering with no window (`kind: "chat"`). That backend's own session holds
   *  nothing of the user's (scope "chatdgc"), so it is not listed. */
  private runningRows(items: any[]): any[] {
    const rows: any[] = [];
    const openHere = (this.tab?.host ?? this).chatdgcOpenHere();
    for (const row of items) {
      if (!row || row.kind !== "serve" || row.attached !== false || !row.detachable) { continue; }
      const sessions = Array.isArray(row.sessions) ? row.sessions : [];
      const common = { pid: row.pid, instance: String(row.instance || ""), version: String(row.version || ""),
                       work: String(row.work || ""), windowless_s: Number(row.windowless_s) || 0 };
      for (const session of row.scope === "chatdgc" ? [] : sessions) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(session?.session_id || ""))) { continue; }
        rows.push({ ...common, session: session.session_id, name: String(session.name || ""), cwd: String(session.cwd || ""),
                    working: session.status === "working" });
      }
      for (const chat of Array.isArray(row.chats) ? row.chats : []) {
        if (!/^chat_[a-f0-9]{32}$/.test(String(chat?.conversation_id || ""))) { continue; }
        // Open: in a ChatDGC tab here, taken from that process the way Open here takes it (its reply streams here).
        rows.push({ ...common, kind: "chat", chat: chat.conversation_id, name: String(chat.title || "").slice(0, 200),
                    cwd: String(sessions[0]?.cwd || ""), working: true, openable: openHere });
      }
    }
    return rows;
  }

  /** Ask this window's backend for the DGC processes on this computer. Only a CLI that can run a session
   *  with no window answers list_live_sessions. */
  private requestLiveSessions(): void {
    const be = this.backend;
    if (!be?.ready || !this.processOf(be)?.detachOffer) { return; }
    be.send({ type: "list_live_sessions", request_id: this.nextRequestId("live-sessions") } as any);
  }

  /** Continue the interrupted turn: the backend writes the instruction, the user clicked a button. */
  private continueInterruptedTurn(): void {
    if (this.turnActive && !this.monitorTurnActive) {
      this.post({ type: "event", event: { type: "error",
        message: "Finish or stop the current turn before continuing the interrupted one." } });
      return;
    }
    const be = this.ensureBackend();
    if (this.lastReadyEvent?.capabilities?.resume_turn !== true) {
      this.post({ type: "event", event: { type: "error",
        message: "This DGC CLI cannot continue an interrupted turn. Update it, then try again." } });
      return;
    }
    if (be.send({ type: "resume_turn", request_id: this.nextRequestId("resume-turn") })) {
      this.turnActive = true;
    }
  }

  /** Unassisted exits in the repeat window, oldest first. */
  private recentUnassistedExits(now = Date.now()): UnassistedExit[] {
    const stored = this.context.workspaceState.get<UnassistedExit[]>(this.stateKey(UNASSISTED_EXITS_KEY));
    return (Array.isArray(stored) ? stored : [])
      .filter((row) => row && Number.isFinite(row.at) && now - row.at >= 0 && now - row.at < REPEAT_EXIT_WINDOW_MS);
  }

  /** Record one unassisted exit; returns how many fall in the repeat window, this one included. */
  private recordUnassistedExit(cause: string, last: string): number {
    const rows = [...this.recentUnassistedExits(), { at: Date.now(), cause: cause.slice(0, 300), last: last.slice(0, 64) }]
      .slice(-16);
    void Promise.resolve(this.context.workspaceState.update(this.stateKey(UNASSISTED_EXITS_KEY), rows))
      .then(undefined, () => { /* the breaker is a guard, not a ledger */ });
    return rows.length;
  }

  /**
   * Record (or clear) the fact that a goal is being pursued right now.
   *
   * This is the one piece of state that has to outlive the extension host, because the host dying
   * is exactly the case it exists for. It is written to workspaceState rather than kept in memory
   * for that reason.
   */
  private noteGoalPursuit(active: boolean): void {
    if (active) {
      if (!this.currentSessionId) { return; }
      void this.context.workspaceState.update(this.stateKey(GOAL_PURSUIT_KEY), {
        scope: this.draftScope(), id: this.currentSessionId, at: Date.now(),
      }).then(undefined, () => { /* losing the marker only costs an automatic resume */ });
      return;
    }
    void this.context.workspaceState.update(this.stateKey(GOAL_PURSUIT_KEY), undefined)
      .then(undefined, () => { /* same */ });
  }

  /**
   * Pick a goal back up after the backend was killed under it.
   *
   * `Agent.load_session` demotes a restored active goal to paused ("Session reopened; resume to
   * continue the goal"), which is right when a person deliberately opens an old chat and wrong
   * when the runner died seconds ago -- the goal exists so the work continues unattended. The
   * marker tells those two apart: it is written only while a goal is actually being pursued, and
   * cleared the moment the user pauses, completes or clears it. A stale marker is ignored, so
   * reopening yesterday's chat still waits for a human.
   */
  private async resumeInterruptedGoal(be: ChatBackend): Promise<void> {
    const mark = this.context.workspaceState.get<{ scope?: string; id?: string; at?: number }>(this.stateKey(GOAL_PURSUIT_KEY));
    if (!mark || mark.scope !== this.draftScope() || mark.id !== this.currentSessionId) { return; }
    const age = Date.now() - Number(mark.at || 0);
    await this.context.workspaceState.update(this.stateKey(GOAL_PURSUIT_KEY), undefined);   // one shot, never a loop
    if (!(age >= 0 && age < GOAL_PURSUIT_MAX_AGE_MS)) { return; }
    let goal: any;
    try {
      const status: any = await this.requestState(
        be, "goal-after-recovery", { type: "status" }, "status", 10000);
      goal = status?.goal;
    } catch { return; }                        // a backend that cannot answer cannot be resumed
    if (this.backend !== be || !goal?.text || goal.status !== "paused") { return; }
    // The repeat-cause breaker. Each resumed goal rewrites its marker, so a death that recurs
    // every few minutes (the npm loop that kept killing the backend) would be resumed forever:
    // stop after three in half an hour, say why, and leave the resume to a person.
    const exits = this.recentUnassistedExits();
    if (exits.length >= REPEAT_EXIT_LIMIT) {
      const last = exits[exits.length - 1];
      const cause = last.cause || "no cause was reported";
      this.backendNote(`[extension: not resuming the goal automatically — ${exits.length} unassisted `
        + `backend exits in 30 minutes; last: ${cause}]`);
      this.whenWebviewReady(() => this.post({ type: "goal_resume_held", exits: exits.length, cause,
                                              lastCommand: last.last || "", logPath: this.backendLogPath() }));
      return;
    }
    this.post({ type: "event", event: { type: "info", message:
      "DGC reconnected after its backend stopped, and is continuing the goal from where it left off." } });
    try {
      await this.resumeGoal(String(goal.text));
    } catch { /* resumeGoal surfaces its own failure */ }
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

  private requestState(be: ChatBackend, prefix: string, command: any,
                       responseType: DgcEvent["type"], timeoutMs = 5000): Promise<DgcEvent> {
    return be.request(this.stateCommand(prefix, command), responseType, timeoutMs);
  }

  private async compactContext(): Promise<void> {
    if (this.turnActive && !this.monitorTurnActive) {
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

  /** What fills the session's window, part by part, for the context menu (a CLI that counts it). A breakdown that
   *  can't be had leaves the menu as it was. */
  private async contextBreakdown(): Promise<void> {
    if (!(this.lastReadyEvent?.capabilities as any)?.context_breakdown) return;
    try {
      const ev: any = await this.requestState(this.ensureBackend(), "ctx-breakdown", { type: "context_breakdown" },
                                              "context_breakdown", 15000);
      this.post({ type: "contextBreakdown", breakdown: { window: ev.window, used: ev.used, source: ev.source, compact_at: ev.compact_at,
        buffer: ev.buffer, free: ev.free, categories: Array.isArray(ev.categories) ? ev.categories : [],
        ...(Array.isArray(ev.deferred) ? { deferred: ev.deferred } : {}) } });
    } catch { /* the menu keeps its own lines */ }
  }

  /** Stop one monitor (or "all"). The backend signals it at once and reaps it in the background;
   * the `monitors` answer and the later monitor_ended event reach the webview as ordinary events. */
  private async stopMonitor(id: string): Promise<void> {
    const monitorId = String(id || "").slice(0, 64);
    if (!monitorId) { return; }
    try {
      await this.requestState(this.ensureBackend(), "monitor-stop",
                              { type: "stop_monitor", id: monitorId }, "monitors", 5000);
    } catch (err: any) {
      this.post({ type: "event", event: { type: "error",
        message: err?.message || "DGC could not stop the monitor." } });
    }
  }

  /** The Restart on a monitor the reopened chat did not bring back on its own. The answer (a monitor_restart
   *  line, or command_rejected) reaches the webview as an ordinary event. A CLI without monitor_restart never sent
   *  the note the button is on, so it is never asked. */
  private restartMonitor(key: string): void {
    const recordKey = String(key || "");
    if (!/^[0-9a-f]{12}$/.test(recordKey) || (this.lastReadyEvent?.capabilities as any)?.monitor_restart !== true) { return; }
    this.backend?.send({ type: "restart_monitor", key: recordKey, request_id: this.nextRequestId("monitor-restart") });
  }

  /** Run again / Resume on a command, sub-agent or troupe a restart stopped (task_interrupted). The answer reaches the
   *  webview as an ordinary event. Only a CLI with task_interrupted sent the line the button is on. */
  private rerunTask(key: string, how: "again" | "resume"): void {
    const recordKey = String(key || "");
    if (!/^[0-9a-f]{12}$/.test(recordKey) || (this.lastReadyEvent?.capabilities as any)?.task_interrupted !== true) { return; }
    this.backend?.send({ type: "rerun_task", key: recordKey, how, request_id: this.nextRequestId("rerun-task") });
  }

  /** Stop one troupe. The backend stops its agents; the `troupes` answer and the troupe_finished that follows update
   *  its row. A CLI without troupes never sent one, so it is never asked. */
  private async stopTroupe(id: string): Promise<void> {
    const runId = String(id || "").slice(0, 64);
    if (!/^tr-[0-9a-f]{10}$/.test(runId) || !(this.lastReadyEvent?.capabilities as any)?.troupe) { return; }
    try {
      await this.requestState(this.ensureBackend(), "troupe-stop", { type: "stop_troupe", run_id: runId }, "troupes", 5000);
    } catch (err: any) {
      this.post({ type: "event", event: { type: "error", message: err?.message || "DGC could not stop the troupe." } });
    }
  }

  /** Stop ONE sub-agent from the agent map. A background agent always could be (`agent_control`); a foreground one
   *  only when the CLI says so (`agent_control_foreground`), otherwise the map offers the turn's own Stop instead
   *  and never sends this. The backend answers with an `agents` snapshot and, later, the agent's own agent_ended;
   *  only a refusal needs saying here, so the map can put its Stop back. */
  private pipFixLive(): boolean {
    return (this.lastReadyEvent?.capabilities as any)?.pip_fix === 1;
  }

  /** Undo a background fix: every file it wrote that still holds what it left goes back. Confirmed first. */
  private async undoPipFix(fixId: string, files: number): Promise<void> {
    if (!/^fix_[0-9a-f]{32}$/.test(fixId) || !this.pipFixLive()) return;
    const count = files > 0 ? `${files} file${files === 1 ? "" : "s"}` : "the files it changed";
    const choice = await vscode.window.showWarningMessage(
      `Undo this fix? DGC puts back ${count} as they were before it. A file you changed since is kept.`,
      { modal: true }, "Undo fix");
    if (choice !== "Undo fix") return;
    this.ensureBackend().send({ type: "undo_pip_fix", fix_id: fixId, request_id: this.nextRequestId("pip-fix-undo") });
  }

  /** Review a background fix: one file opens its diff, several are offered to pick from. */
  private async reviewPipFix(fixId: string, paths: string[]): Promise<void> {
    if (!/^fix_[0-9a-f]{32}$/.test(fixId) || !this.pipFixLive() || !paths.length) return;
    let path = paths[0];
    if (paths.length > 1) {
      const pick = await vscode.window.showQuickPick(paths.map((label) => ({ label })),
        { placeHolder: "Review what the fix changed in…" });
      if (!pick) return;
      path = pick.label;
    }
    try {
      const result: any = await this.ensureBackend().request({ type: "get_pip_fix_change", fix_id: fixId, path,
        request_id: this.nextRequestId("pip-fix-change") }, "pip_fix_change", 15000);
      if (result?.type !== "pip_fix_change" || result.path !== path) throw new Error("The fix's change could not be read.");
      this.reviewDocuments.clear();
      const id = createHash("sha256").update(`${fixId}:${path}:${Date.now()}`).digest("hex").slice(0, 16);
      const leaf = basename(path) || "change";
      const left = vscode.Uri.from({ scheme: "dgc-review", authority: id, path: `/before/${leaf}` });
      const right = vscode.Uri.from({ scheme: "dgc-review", authority: id, path: `/after/${leaf}` });
      this.reviewDocuments.set(left.toString(), String(result.before ?? ""));
      this.reviewDocuments.set(right.toString(), String(result.after ?? ""));
      const label = result.kind === "held" ? "your file ↔ the fix's version, held back" : "before ↔ after the fix";
      await vscode.commands.executeCommand("vscode.diff", left, right, `${path} (${label})`, { preview: true });
    } catch (error) {
      void vscode.window.showInformationMessage(error instanceof Error ? error.message : "The fix's change could not be read.");
    }
  }

  private async stopAgent(id: string): Promise<void> {
    const agentId = String(id || "");
    if (!/^sub-[0-9a-f]{12}$/i.test(agentId) || !(this.lastReadyEvent?.capabilities as any)?.agent_control) { return; }
    try {
      await this.ensureBackend().request({ type: "agent_control", action: "close", id: agentId,
        request_id: this.nextRequestId("agent-stop") }, "agents", 5000);
    } catch (err: any) {
      this.post({ type: "agent_stop_state", id: agentId, state: "error",
        error: err?.message || "DGC could not stop the agent." });
    }
  }

  /** Background shells (`bash` with background:true) reach the map only from a CLI that advertises
   *  `background_tasks`. The commands are new in that version, so nothing here is sent to one that is not. */
  private backgroundTasks(): boolean {
    return Number((this.lastReadyEvent?.capabilities as any)?.background_tasks?.version) >= 1;
  }

  private async stopBackgroundShell(id: string): Promise<void> {
    const shellId = String(id || "").slice(0, 64);
    if (!shellId || !this.backgroundTasks()) { return; }
    try {
      await this.ensureBackend().request({ type: "stop_background_shell", id: shellId,
        request_id: this.nextRequestId("shell-stop") } as any, "background_shells" as DgcEvent["type"], 5000);
    } catch (err: any) {
      this.post({ type: "background_stop_state", kind: "shell", id: shellId, state: "error",
        error: err?.message || "DGC could not stop the command." });
    }
  }

  /** The tail of a background shell's or a monitor's output, for the map's open task card. The answer is an
   *  ordinary `background_output` event, which reaches the webview like any other; a refusal or a timeout is
   *  said separately, so the card can say the output is not available instead of waiting. */
  private async getBackgroundOutput(id: string): Promise<void> {
    const taskId = String(id || "").slice(0, 64);
    if (!taskId || !this.backgroundTasks()) { return; }
    try {
      await this.ensureBackend().request({ type: "get_background_output", id: taskId, max_bytes: 65536,
        request_id: this.nextRequestId("task-output") } as any, "background_output" as DgcEvent["type"], 5000);
    } catch {
      this.post({ type: "background_output_failed", id: taskId });
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
    const liveGoalReplace = this.lastReadyEvent?.capabilities?.live_goal_replace === true
      || this.lastReadyEvent?.capabilities?.live_goal_start === true;
    if (this.turnActive && !this.monitorTurnActive && !liveGoalReplace) {
      reject("Finish or stop the current turn before replacing its goal. Your draft is retained."); return;
    }
    const be = this.ensureBackend();
    const prior = this.state.goal;
    const session = this.currentSessionId;
    const epoch = this.processEpoch;
    if (prior.text && prior.status !== "completed" && prior.status !== "none") {
      const choice = await vscode.window.showWarningMessage("Replace the current goal?", {
        modal: true,
        detail: `Current objective: ${prior.text}\n\nNew objective: ${objective}\n\nReplacing starts a new goal and resets its usage and token budget. Cancel keeps the current goal and your draft.`,
      }, "Replace goal");
      if (choice !== "Replace goal") {
        this.post({type: "prompt_rejected", requestId});
        this.post({type: "goal_start_state", state: "cancelled"}); return;
      }
      if (session !== this.currentSessionId || epoch !== this.processEpoch || (this.turnActive && !liveGoalReplace) ||
          ["id", "text", "status", "token_budget"].some(key => (this.state.goal as any)[key] !== (prior as any)[key])) {
        reject("The chat or goal changed while you reviewed it. Review the current goal before replacing it."); return;
      }
    }
    const expectedGoalId = prior.text ? String((prior as any).id || "") : "";
    const guardedGoal = this.lastReadyEvent?.capabilities?.goal_replace_guard === true;
    if (guardedGoal && prior.text && !/^[a-f0-9]{32}$/.test(expectedGoalId)) {
      reject("Refresh the current goal before replacing it. Its saved identity is unavailable."); return;
    }
    const attached = Array.isArray(payload.context) ? payload.context.filter((item: any) => item && typeof item === "object") : [];
    if (this.goalInputs) {
      const accepted = be.send({ type: "start_goal", text: objective, request_id: requestId,
        ...(guardedGoal ? {expected_goal_id: expectedGoalId} : {}),
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
    if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0 || tokenBudget > 1e12)) {
      this.post({ type: "goal_edit_state", state: "error", error: "Enter a valid non-negative whole-number token budget." }); return;
    }
    if (this.pendingGoalEdit) { return; }
    const liveEdit = this.lastReadyEvent?.capabilities?.live_goal_edit === true;
    if (this.turnActive && !this.monitorTurnActive && liveEdit) {
      const requestId = this.nextRequestId("goal-edit");
      this.pendingGoalEdit = requestId;
      this.post({ type: "goal_edit_state", state: "pending" });
      // No short response timeout: this edit belongs to the running turn's next boundary.
      // Its correlated commit/refusal (or backend exit) settles the editor without restarting.
      try {
        const accepted = this.ensureBackend().send({ type: "set_goal", request_id: requestId,
          ...(liveEdit ? { expected_goal_id: String(this.state.goal.id || "") } : {}), text: objective, status: "active",
          ...(tokenBudget !== undefined ? { token_budget: tokenBudget } : {}) });
        if (!accepted) { this.settleGoalEdit("DGC did not accept the edit. Your draft is retained."); }
      } catch (err: any) {
        this.settleGoalEdit(err?.message || "DGC could not send the edit. Your draft is retained.");
      }
      return;
    }
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

  private settleGoalEdit(error?: string): void {
    if (!this.pendingGoalEdit) { return; }
    this.pendingGoalEdit = undefined;
    this.post({ type: "goal_edit_state", state: error ? "error" : "saved", ...(error ? {error} : {}) });
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
    if (this.turnActive && !this.monitorTurnActive) {
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
  private async stopActiveTurn(be: ChatBackend): Promise<void> {
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
    this.turnActive = this.confirmedTurnActive = this.monitorTurnActive = false;
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

  /** The folders this chat works in: the window's, or, for a chat opened in another folder, that
   *  chat's project and nothing else. Sent the window's folders, such a chat got each one as an
   *  external-directory grant -- writes into the window's project with no approval card, while
   *  its own files still asked -- and its Changes views scanned the window's folder, not its own. */
  private chatFolders(): Array<{ name: string; fsPath: string }> {
    const cwd = this.activeSlot().cwd;
    if (cwd) {
      const reported = this.lastReadyEvent?.project_root;
      const root = typeof reported === "string" && reported ? reported : cwd;
      return [{ name: basename(root) || root, fsPath: root }];
    }
    return (vscode.workspace.workspaceFolders || []).map((f) => ({ name: f.name, fsPath: f.uri.fsPath }));
  }

  /** Keep the backend's external-directory grants identical to this chat's folders. Root
   * mutations are blocked by `dgc serve` during a turn, so one acknowledged update is kept in
   * flight and newer changes are coalesced until the backend is idle. The backend supports the
   * project root plus 32 external roots; keep the editor side within the same explicit bound. */
  private workspaceRoots(): string[] {
    return this.chatFolders().slice(0, 33).map((f) => f.fsPath);
  }

  private syncWorkspaceRoots(be = this.backend, setup = false): void {
    if (!be || be !== this.backend || (this.turnActive && !this.monitorTurnActive)
        || this.workspaceRootsInFlight !== undefined
        || !this.workspaceRootsDirty || (!setup && !be.ready)) {
      return;
    }
    const revision = this.workspaceRootsRevision;
    // open_asks says this panel can show a question the turn did not stop for, and keep its card
    // alive after the turn moves past it. A backend never emits ask_* to a client that did not say
    // so, and withholds the tool entirely when nobody can show one.
    //
    // It is sent ONLY to a CLI that declared it. The field arrived in CLI 0.42.0, and the command
    // schema rejects a field it does not declare -- so 0.27.0 sending it unconditionally made
    // every chat fail against an older CLI with "invalid command: set_workspace_roots has
    // undeclared field 'open_asks'". set_workspace_roots is part of the handshake, so nothing
    // started at all: Cursor reported "timed out waiting for sessions" and Resume said there were
    // no past sessions in the project. The authoritative sync runs from the `ready` handler, where
    // capabilities are known.
    const supportsOpenAsks = this.lastReadyEvent?.capabilities?.open_asks === true;
    // ask_options is the same promise one step further: this panel can draw the OPTIONS on that
    // question, not only its text box. Gated identically, and for the identical reason -- a CLI
    // that has not declared the field rejects the whole handshake command, which is not a
    // degraded question but no session at all.
    const supportsAskOptions = this.lastReadyEvent?.capabilities?.ask_options === true;
    // The panel draws the CLI's own face slot for each sub-agent, so two at work never share a
    // face. Same gate: an undeclared field fails the whole handshake on an older CLI.
    const supportsAgentFaces = this.lastReadyEvent?.capabilities?.agent_faces === true;
    const command = this.stateCommand(
      "workspace-roots", { type: "set_workspace_roots", roots: this.workspaceRoots(),
                           ...(supportsOpenAsks ? { open_asks: true } : {}),
                           ...(supportsAskOptions ? { ask_options: true } : {}),
                           ...(supportsAgentFaces ? { agent_faces: true } : {}) });
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
  /** Resume a handshake that stalled because its chat was parked. Only the two steps that can
   *  be left dangling are redone: the native-settings promise whose `.finally` found a different
   *  active chat, and the roots acknowledgement that was dropped as a background event. Session
   *  restore is not touched -- it can only have started once both of those had already passed. */
  private redriveHandshake(be: ChatBackend): void {
    if (this.workspaceRootsInFlight !== undefined) {
      this.workspaceRootsInFlight = undefined;
      this.workspaceRootsDirty = true;                 // re-ask, and wait for THIS acknowledgement
      this.syncWorkspaceRoots(be, true);               // same order the `ready` handler uses
    }
    if (this.nativeSettingsReady) {
      this.maybeCompleteHandshake(be);
      return;
    }
    void this.applyNativeSettings(be, true)
      .catch((err: any) => this.post({ type: "event", event: {
        type: "error", message: `Could not initialize DGC editor settings: ${err?.message ?? err}`,
      } }))
      .finally(() => {
        if (this.backend === be) {
          this.nativeSettingsReady = true;
          this.maybeCompleteHandshake(be);
        }
      });
  }

  private maybeCompleteHandshake(be: ChatBackend): void {
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
    if (!this.sessionRestoreSaved) {
      // The remembered chat never had a message, so there is no file to resume: asking for it only
      // produced "no such session" and a notice that the chat was unavailable. Its draft still moves
      // to the new chat, exactly as when a saved chat has gone missing.
      this.sessionRestoreFinished = true;
      this.sessionDraftSource = previous;
      this.finishSessionHandshake(be, previous);
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
          be.close("chat restoration timed out");
          if (this.backend === be) { this.retireBackend(); }    // its process may live on for other chats
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
    const allFolders = this.chatFolders();
    const notices = allFolders.length > 16 ? ["Only the first 16 workspace folders were scanned."] : [];
    const folders = (await Promise.all(allFolders.slice(0, 16).map(async folder => ({
      name: folder.name, path: await realpath(folder.fsPath).catch(() => ""),
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

  /** Resolved on first use: a field initializer would run before `context` is assigned. */
  private backendLogPath(): string {
    if (this.backendLogFileCache !== undefined) { return this.backendLogFileCache; }
    this.backendLogFileCache = "";
    try {
      const dir = (this.context as any)?.logUri?.fsPath;
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "backend.log");
        // Keep it bounded: a chatty backend must not fill the user's disk.
        try {
          if (fs.statSync(file).size > 4 * 1024 * 1024) { fs.rmSync(file); }
        } catch { /* no file yet */ }
        this.backendLogFileCache = file;
      }
    } catch { /* no writable log directory; the output channel still has it */ }
    return this.backendLogFileCache;
  }

  /** Record one line of backend output in both places, and never let logging break a turn. */
  private backendNote(line: string): void {
    // The file first: the output channel is disposed before a panel's final exit line arrives,
    // and appending to a closed channel throws — which used to lose exactly that line.
    const file = this.backendLogPath();
    if (file) {
      try {
        fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
      } catch { /* a full or read-only disk must not take the panel down with it */ }
    }
    try {
      this.backendLog.appendLine(line);
    } catch { /* the channel is already disposed */ }
  }

  private ensureBackend(): ChatBackend {
    if (vscode.workspace.isTrusted === false) {
      throw new Error("DGC is disabled until this workspace is trusted.");
    }
    if (this.backend) {
      this.activeSlot().backend = this.backend;
      return this.backend;
    }
    const executable = resolveDgcExecutable();
    if (executable.ignoredWorkspaceOverride && !this.commandOverrideWarningShown) {
      this.commandOverrideWarningShown = true;
      void vscode.window.showWarningMessage(
        "DGC ignored a workspace-level dgc.command override. Configure the executable in User Settings.");
    }
    const cmd = executable.command;
    // A chat opened deliberately empty keeps the candidate its slot was given (none, or the
    // session it is being restarted onto). Reading the workspace's remembered id here is right for
    // the first chat and wrong for a second one: both would resume the same session, and the
    // backend refuses the second because a session is held by whoever is running a turn in it.
    if (!this.sessionRestoreSuppressed && (this.tab || this.activeSlot().cwd)) {
      // A chat in another folder is never the window's remembered chat (rememberSession skips it),
      // and its sessions live in its own project. Restart Backend and crash recovery brought it
      // back on the window's remembered id: "no such session", then a new empty chat -- or, in a
      // folder inside the window's project, the window's own last chat. It comes back on its own.
      // So does an editor tab's chat: the window's remembered chat is the side bar's.
      // A tab whose backend died before its own session was restored goes back for that session,
      // not for the empty one the dead backend started with.
      const unrestored = !!this.tab && !this.sessionRestoreFinished && !!this.sessionRestoreCandidate
        && this.sessionRestoreCandidate !== this.currentSessionId;
      if (!unrestored) {
        this.sessionRestoreCandidate = /^[A-Za-z0-9_-]{1,128}$/.test(this.currentSessionId) ? this.currentSessionId : "";
        this.sessionRestoreSaved = this.currentSessionSaved;
      }
      this.sessionRestoreSuppressed = true;       // so `ready` keeps it instead of re-reading the window's
    }
    if (!this.sessionRestoreSuppressed) {
      const saved = this.context.workspaceState.get<{ scope?: string; id?: string; saved?: boolean }>("dgc.activeSession.v1");
      this.sessionRestoreCandidate = saved?.scope === this.draftScope() && /^[A-Za-z0-9_-]{1,128}$/.test(saved.id || "")
        ? saved.id! : "";
      this.sessionRestoreSaved = saved?.saved !== false;
    }
    this.sessionRestoreStarted = false;
    this.sessionReady = false;
    // The chat this child belongs to, captured now. Every handler below asks the slot rather than
    // comparing against `this.backend`: with a second chat running, `this.backend` is whichever
    // chat the user is looking at, and a background child's own death must still be handled.
    const slot = this.activeSlot();
    const folder = slot.cwd || this.cwd();
    // "Open here", or a session another process is running: this chat reattaches with a process of its
    // own (dgc/serve_relay.py), never a chat opened on the window's other one.
    const reattach = this.attachMode === "steal" || this.liveElsewhere(this.sessionRestoreCandidate);
    const host = reattach ? undefined : this.chatHost(slot);
    const be: ChatBackend = host
      ? new OpenedChat(host, folder, this.nextRequestId("open-chat"))
      : new DgcBackend(folder, cmd, this.context.extension.packageJSON.dgcCliVersion, this.hostRoute());
    if (!host) {
      this.processEpochs.set(be, this.processEpoch);
      this.logProcess(be as DgcBackend);
      // A session's chat keeps its work running when the window goes (a reload, a closed window), and a
      // window that comes back reattaches to it. The Sessions home's own backend holds no session of its own,
      // but it carries ChatDGC: it keeps a ChatDGC reply running, and nothing else (set_detach_chatdgc).
      (be as DgcBackend).keepWorkRunning = !this.home;
      (be as DgcBackend).keepChatdgcRunning = this.home;
      // The session this chat is about to restore may still be running in a backend whose window went:
      // a CLI that kept it running relays this spawn to it (dgc/serve_relay.py), and an older one ignores it.
      const session = /^[A-Za-z0-9_-]{1,128}$/.test(this.sessionRestoreCandidate) ? this.sessionRestoreCandidate : "";
      if (session && !this.home) { (be as DgcBackend).attach = { session, mode: this.attachMode }; }
      // The home asks for its own last backend back, by its chat's session (remembered at each ready): one this
      // window left writing a ChatDGC reply is still running it. Its first start after the window opens is a
      // reload's; any later one (a crash's recovery) asks automatically.
      const kept = this.home ? this.keptHomeBackend() : "";
      if (kept) { (be as DgcBackend).attach = { session: kept, mode: this.attachMode === "steal" ? "auto" : this.attachMode }; }
    }
    this.attachMode = "auto";
    this.wireSlotBackend(slot, be, host);
    be.start();
    this.backend = be;
    return be;
  }

  /** Hang this slot's handlers on its backend: everything it says reaches the slot, whether or not the
   *  slot is the chat on screen. */
  private wireSlotBackend(slot: ChatSlot, be: ChatBackend, host: DgcBackend | undefined): void {
    slot.backend = be;
    const wired: Array<[string, (...args: any[]) => void]> = [];
    this.backendListeners.set(be, wired);
    const on = (name: string, handler: (...args: any[]) => void) => {
      be.on(name, handler);
      wired.push([name, handler]);
    };
    // The backend's own last word ("serve loop ended: <cause>; …") arrives on stderr before the
    // exit does. Keep it per instance: it is the cause the Continue card and the breaker name.
    let serveCause = "";
    on("event", (ev: DgcEvent) => this.routeEvent(slot, ev));
    // The backend log: what the process says about itself is written by the process, once
    // (logProcess). A chat opened on it writes only what happened to that chat.
    on("chat-log", (line: string) => this.backendNote(line));
    on("stderr", (line: string) => {
      const ended = /serve loop ended: ([^;\n]+)/.exec(line);
      if (ended) { serveCause = ended[1].trim().slice(0, 300); }
      if (slot.id === this.activeSlotId) { this.post({ type: "stderr", line }); }
    });
    on("teardown", (cause: string) => {
      if (cause.startsWith(MOVED_CAUSE)) {
        // Another window took this session ("Open here" there). Nothing died: this chat goes read-only.
        if (slot.id !== this.activeSlotId) { this.backgroundBackendLost(slot, "it is open in another window now"); return; }
        if (this.backend === be) { this.retireBackend(); }
        return;
      }
      // restart() and dispose() own their own lifecycle. Any other teardown (a protocol failure, a
      // restore that timed out) retires this instance NOW: leaving it as this.backend let the next
      // send() start a child on it, whose own later death was then mislabelled and never recovered.
      if (this.isDeliberateStop(cause)) { return; }
      if (slot.id !== this.activeSlotId) { this.backgroundBackendLost(slot, cause); return; }
      if (this.backend !== be) { return; }
      this.queuedPromptsLost();
      this.retireBackend();
      this.post({ type: "backend_exit", code: null, signal: null, recovering: false, cause, resumes: "none" });
    });
    on("exit", (code: number | null, signal?: string | null, info?: ChildExitInfo) => {
      const facts: ChildExitInfo = info || { uptimeMs: be.uptimeMs, framesWritten: 0 };
      const how = exitHow(code, signal);
      if (slot.id === this.activeSlotId) { this.mcpUrls.clear(); }
      if (!host) { this.chatdgc?.backendLost(); }   // a ChatDGC reply on this process stopped with it
      if (facts.cause) { return; }             // our own teardown: already logged and handled
      // With no word from the backend, the exit status is the cause: "killed by SIGKILL", or
      // "exited with code 1". (`exited with ${how}` read "exited with killed by SIGKILL".)
      const cause = serveCause || (signal || code === null ? how : `exited with ${how}`);
      serveCause = "";
      // Both of the calls below read and WRITE the panel's own fields, which belong to the chat
      // on screen. Running them for a background child's death stamped that child's cause onto the
      // foreground chat's interrupted-turn record — a turn that was still running, now marked as
      // having died of another chat's SIGKILL.
      const resumes = this.recordExitAgainstActiveChat(slot, cause, facts.lastFrame || "");
      if (resumes === undefined) { return; }      // a background chat's death; already handled
      this.pendingCommandRestart = false;       // the replacement starts from the new path anyway
      if (this.backend !== be) { return; }
      this.queuedPromptsLost();
      if (be.childPid !== undefined) {
        // A command already started a new child on this instance; that child is the recovery.
        this.turnActive = this.confirmedTurnActive = this.monitorTurnActive = false;
        this.post({ type: "backend_exit", code, signal, recovering: true, cause, resumes });
        return;
      }
      this.retireBackend();
      const recovering = this.recoverBackend();
      this.post({ type: "backend_exit", code, signal, recovering, cause, resumes: recovering ? resumes : "none" });
    });
  }


  /** What a `dgc serve` says about itself -- its stderr, its start, a start that failed, being
   *  stopped, its exit -- written to the backend log once, by the process, however many chats run
   *  on it. Each chat's slot used to write what its backend heard, and every chat opened on a
   *  process hears the process: with three chats on one, every traceback and exit line appeared
   *  three times. These stay on the process for its whole life; a slot that closes takes off only
   *  its own handlers. */
  private logProcess(serve: DgcBackend): void {
    serve.on("stderr", (line: string) => this.backendNote(line));
    serve.on("spawned", (pid?: number) => this.backendNote(`[dgc serve started: pid ${pid ?? "?"}, host pid ${process.pid}]`));
    serve.on("launch_failed", (message: string) => this.backendNote(`[dgc serve failed to start: ${message}]`));
    serve.on("teardown", (cause: string, pid?: number, kept?: boolean) => {
      this.backendNote(kept
        ? `[extension: the window is going; dgc serve keeps its work running with no window — ${cause}${pid ? ` (pid ${pid})` : ""}]`
        : cause.startsWith(MOVED_CAUSE)
        ? `[extension: this session is open in another window now; dgc serve${pid ? ` pid ${pid}` : ""} keeps running there]`
        : `[extension: stopping the backend — ${cause}${pid ? ` (pid ${pid})` : ""}]`);
    });
    serve.on("exit", (code: number | null, signal?: string | null, info?: ChildExitInfo) => {
      const facts: ChildExitInfo = info || { uptimeMs: serve.uptimeMs, framesWritten: 0 };
      // "code 0" alone reads like a clean, asked-for stop. Whether WE asked is the whole question
      // when a turn disappears, so the log says it outright, with what the child was last sent.
      const up = Math.round((facts.uptimeMs || 0) / 1000);
      const asked = facts.cause ? `yes (${facts.cause})` : "no";
      this.backendNote(`[dgc serve exited: ${exitHow(code, signal)} · extension asked for it: ${asked} · up ${up}s`
        + ` · pid ${facts.pid ?? "?"} · frames sent ${facts.framesWritten}`
        + `${facts.lastFrame ? `, last '${facts.lastFrame}'` : ""}`
        + `${facts.transport ? `, transport ${facts.transport}` : ""}]`);
    });
  }

  /** A running backend this slot's chat can open on -- one process, every chat in its own folder --
   *  or undefined, and the slot starts a backend of its own: sharing is off, the CLI cannot hold
   *  several chats, no other backend has finished starting, or the ones there are full. */
  private chatHost(slot: ChatSlot): DgcBackend | undefined {
    if (!shareBackend()) { return undefined; }
    const hosts: DgcBackend[] = [];
    for (const other of this.slots) {
      if (other === slot) { continue; }
      const be = other.backend || (other.saved?.backend as ChatBackend | undefined);
      // A chat opened on a process leads to that process; a process is whatever holds chat users.
      const process = ((be as OpenedChat | undefined)?.host ?? be) as DgcBackend | undefined;
      if (process?.chatUsers instanceof Set && !hosts.includes(process)) { hosts.push(process); }
    }
    for (const released of this.releasedHosts) {
      if (!hosts.includes(released)) { hosts.push(released); }
    }
    return hosts.find((process) => process.chats && process.handshakeComplete
      && process.childPid !== undefined && process.chatUsers.size + 1 < process.chats.max
      && (this.processEpochs.get(process) ?? this.processEpoch) === this.processEpoch);
  }

  /** The `dgc serve` a chat's backend runs on: the backend itself, or the process it was opened on. */
  private processOf(be: ChatBackend | undefined): DgcBackend | undefined {
    const process = ((be as OpenedChat | undefined)?.host ?? be) as DgcBackend | undefined;
    return process?.chatUsers instanceof Set ? process : undefined;
  }

  /** A turn runs in a chat on the active chat's process: restarting it would end that turn too. */
  private processBusy(): boolean {
    if (this.turnActive) { return true; }
    const process = this.processOf(this.backend);
    return !!process && this.slots.some((other) => other.id !== this.activeSlotId && other.busy
      && this.processOf(other.backend || (other.saved?.backend as ChatBackend | undefined)) === process);
  }

  /** Forget the current backend and every piece of per-connection state that went with it. */
  private retireBackend(): void {
    this.setReadyContext(false);
    this.changesRefreshRevision++;
    this.workspaceChanges = [];
    this.sessionReady = false;
    this.turnActive = this.confirmedTurnActive = this.monitorTurnActive = false;
    this.correlatedStateRequests = false;
    this.workspaceRootsInFlight = undefined;
    this.workspaceRootsDirty = true;
    this.initializingBackend = undefined;
    this.nativeSettingsReady = false;
    this.settingsPreviews.clear();
    this.settingsPreviewRequests.clear();
    // The dead child must not be handed out again. ensureBackend() returns `this.backend`
    // whenever it is set, so leaving the corpse here meant every later command went to a
    // closed pipe and the panel could never recover on its own -- the user had to find
    // "DGC: Restart Backend" or reload the window.
    this.backend = undefined;
    const slot = this.slots.find((candidate) => candidate.id === this.activeSlotId);
    if (slot) { slot.backend = undefined; }
  }

  // ---- messages queued behind a running turn ---------------------------------------------------------
  // A queued message is the user's until its own turn starts. The webview keeps one copy, but that
  // copy dies with a webview or window reload, and restarting the backend cleared the transcript
  // without giving anything back. The host keeps the request id, the words and the restore draft
  // from send until turn_start (or the backend's own "returned"), persists the queued ones, and
  // hands them back as not sent once a backend that held them is gone.

  private trackPrompt(requestId: string, text: string, restore: any, images: any): void {
    if (!requestId || this.unstartedPrompts.size >= 64) { return; }
    const pictures = Array.isArray(images) ? images.filter((image: any) => typeof image === "string") : [];
    let draft: QueuedPrompt["draft"] = { text: text.slice(0, 1_000_000), attachments: [] };
    if (restore && typeof restore === "object" && typeof restore.text === "string" && Array.isArray(restore.attachments)) {
      let picture = 0;
      // The webview leaves each image's bytes out of the restore draft: they are already in `images`.
      const attachments = restore.attachments.slice(0, 64).map((item: any) => item && typeof item === "object" && item.img
        ? { ...item, data: pictures[picture++] } : item);
      draft = { text: restore.text.slice(0, 1_000_000), attachments };
    }
    this.unstartedPrompts.set(requestId, { requestId, session: this.currentSessionId, text: text.slice(0, 1_000_000),
                                           draft, queued: false });
  }

  private markPromptQueued(requestId: string, steering = false): void {
    const prompt = this.unstartedPrompts.get(requestId);
    if (!prompt || (prompt.queued && !!prompt.steering === steering)) { return; }
    prompt.queued = true;
    if (steering) { prompt.steering = true; } else { delete prompt.steering; }
    this.persistQueuedPrompts();
  }

  private forgetPrompt(requestId: string): void {
    const prompt = requestId ? this.unstartedPrompts.get(requestId) : undefined;
    if (!prompt) { return; }
    this.unstartedPrompts.delete(requestId);
    if (prompt.queued) { this.persistQueuedPrompts(); }
  }

  /** The backend that held the queued prompts is gone: they were not sent. Unacknowledged ones are
   *  the webview's to report ("delivery unconfirmed"); only an acknowledged queue is certain. */
  private queuedPromptsLost(): void {
    const lost = [...this.unstartedPrompts.values()].filter((prompt) => prompt.queued);
    this.unstartedPrompts.clear();
    for (const prompt of lost) {
      if (!this.unsentPrompts.some((known) => known.requestId === prompt.requestId)) { this.unsentPrompts.push(prompt); }
    }
    this.unsentPrompts = this.unsentPrompts.slice(-QUEUED_PROMPTS_LIMIT);
    this.persistQueuedPrompts();
  }

  /** Hand the not-sent prompts to the webview once its chat is ready (the reconnect's history is then
   *  already on its way, and nothing clears the transcript under them). The webview ignores any it
   *  already gave back itself. */
  private surfaceUnsentPrompts(): void {
    if (!this.unsentPrompts.length || !this.webviewReady || !this.sessionReady) { return; }
    const items = this.unsentPrompts.splice(0);
    this.post({ type: "prompts_unsent", items });
    this.persistQueuedPrompts();
  }

  private persistQueuedPrompts(): void {
    const items = [...this.unsentPrompts, ...[...this.unstartedPrompts.values()].filter((prompt) => prompt.queued)]
      .slice(-QUEUED_PROMPTS_LIMIT)
      .map((prompt) => JSON.stringify(prompt.draft).length > QUEUED_PROMPT_DRAFT_CHARS
        ? { ...prompt, draft: { text: prompt.draft.text.slice(0, QUEUED_PROMPT_DRAFT_CHARS), attachments: [] } } : prompt);
    try {
      void Promise.resolve(this.context.workspaceState.update(this.stateKey(QUEUED_PROMPTS_KEY),
        items.length ? { scope: this.draftScope(), items } : undefined)).catch(() => { /* only a reload's restore is lost */ });
    } catch { /* only a reload's restore is lost */ }
  }

  /** This chat's state in a backend that kept its session running with no window, when `ready` says it
   *  reattached to one (ready.capabilities.attached): undefined for an ordinary start, and for a chat
   *  opened anew on a reattached process (its session is not among the ones that process kept). */
  private attachedChat(ev: DgcEvent): AttachedChatState | undefined {
    const attached = (ev.capabilities as any)?.attached;
    const session = String(ev.session_id || "");
    if (!session || !attached || typeof attached !== "object" || !Array.isArray(attached.chats)) { return undefined; }
    const found = attached.chats.find((chat: any) => chat && typeof chat === "object" && String(chat.session_id || "") === session);
    return found ? found as AttachedChatState : undefined;
  }

  /** The prompts this window queued before it went are still queued in the backend that kept the
   *  session running: they are tracked again as queued, not handed back as unsent. One that is no
   *  longer in its queue ran with no window (the transcript has it); handing it back would send it
   *  twice. One queued from another window is tracked with the backend's own words. */
  private adoptLiveQueue(live: AttachedChatState): void {
    const queued = new Map<string, string>();
    for (const item of Array.isArray(live.queued) ? live.queued : []) {
      const id = String(item?.request_id || "");
      if (/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) { queued.set(id, String(item?.text || "")); }
    }
    const keep: QueuedPrompt[] = [];
    for (const prompt of this.unsentPrompts) {
      if (prompt.session && prompt.session !== live.session_id) { keep.push(prompt); continue; }
      if (queued.has(prompt.requestId)) {
        this.unstartedPrompts.set(prompt.requestId, { ...prompt, session: live.session_id, queued: true });
        queued.delete(prompt.requestId);
      }
    }
    for (const [requestId, text] of queued) {
      if (this.unstartedPrompts.size >= 64) { break; }
      this.unstartedPrompts.set(requestId, { requestId, session: live.session_id, text,
                                             draft: { text, attachments: [] }, queued: true });
    }
    this.unsentPrompts = keep;
    this.persistQueuedPrompts();
  }

  /** The other chats a reattached process kept running (ready.capabilities.attached), each back in a
   *  background chat of its own on that process, its session and folder as they were. The process closes
   *  a kept chat no window takes back once it is idle, so each is claimed at once (OpenedChat.adopt). */
  private adoptKeptChats(host: DgcBackend): void {
    const own = host.chats?.default;
    const taken = new Set(this.slots.map((slot) => (slot.backend as OpenedChat | undefined)?.chatId).filter(Boolean));
    for (const chat of host.attached?.chats || []) {
      const chatId = String(chat?.chat_id || ""), session = String(chat?.session_id || "");
      if (!chatId || chatId === own || taken.has(chatId) || !host.attachedOpened.has(chatId)) { continue; }
      if (this.slots.length >= maxLiveChats()) { break; }
      const cwd = String(chat.cwd || "") || this.cwd();
      const saved: Record<string, unknown> = {};
      for (const field of PER_CHAT_FIELDS) { saved[field] = this.cloneChatValue(this.pristineChatState[field]); }
      Object.assign(saved, { sessionRestoreCandidate: session, sessionRestoreSaved: true, sessionRestoreSuppressed: true,
                             currentSessionId: session, currentSessionSaved: true,
                             turnActive: !!chat.turn, confirmedTurnActive: !!chat.turn });
      const slot: ChatSlot = { id: `chat-${++this.slotSeq}`, label: session.slice(-6) || "Chat", busy: !!chat.turn,
                               needsYou: Array.isArray(chat.waiting) && chat.waiting.length > 0, unread: 0, saved,
                               ...(cwd !== this.cwd() ? { cwd } : {}) };
      this.slots.push(slot);
      const be = new OpenedChat(host, cwd, this.nextRequestId("adopt-chat"), chatId);
      this.wireSlotBackend(slot, be, host);
      saved.backend = be;
      be.start();
    }
    this.postChatSlots();
  }

  /** The last word from any backend on the DGC processes of this computer (live_sessions). */
  private liveSessionRows: any[] = [];

  /** `session` is running in another DGC process that a window can reattach to: a chat that opens it
   *  starts a process of its own, which relays to that one, rather than a chat on this window's. */
  private liveElsewhere(session: string): boolean {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) { return false; }
    // The Sessions home asks for the list (its Settings and its Sessions marks); a tab reads the home's.
    const rows = (this.tab?.host ?? this).liveSessionRows;
    return rows.some((row) => row && !row.here && row.detachable
      && Array.isArray(row.sessions) && row.sessions.some((item: any) => item?.session_id === session));
  }

  /** What a host that died (a window reload) had queued: its backend died with it, so none of it ran. */
  private adoptQueuedPromptsFromPreviousHost(): void {
    let saved: { scope?: string; items?: any[] } | undefined;
    try { saved = this.context.workspaceState.get(this.stateKey(QUEUED_PROMPTS_KEY)); } catch { return; }
    if (!saved || saved.scope !== this.draftScope() || !Array.isArray(saved.items)) { return; }
    this.unsentPrompts = saved.items.slice(-QUEUED_PROMPTS_LIMIT).filter((item: any) => item && typeof item === "object"
      && typeof item.requestId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(item.requestId)
      && typeof item.text === "string" && item.draft && typeof item.draft.text === "string"
      && Array.isArray(item.draft.attachments))
      .map((item: any) => ({ requestId: item.requestId, session: typeof item.session === "string" ? item.session : "",
                             text: item.text, draft: item.draft, queued: true }));
  }

  /**
   * Decide, at the moment of an unassisted exit, what a reconnect will pick back up — and say so
   * to the webview, which used to promise "picking the work back up" when nothing would be.
   * `recentExits` counts the unassisted exits in the repeat window, this one included: at the
   * breaker's limit the goal is "held" (resumeInterruptedGoal will not resume it), so the exit line
   * must not promise the pickup that the goal_resume_held card then contradicts.
   */
  private markInterruptedWork(cause: string, recentExits = this.recentUnassistedExits().length): "goal" | "held" | "offer" | "none" {
    const goal = this.context.workspaceState.get<{ scope?: string; id?: string }>(this.stateKey(GOAL_PURSUIT_KEY));
    if (goal && goal.scope === this.draftScope() && goal.id === this.currentSessionId) {
      return recentExits >= REPEAT_EXIT_LIMIT ? "held" : "goal";
    }
    const mark = this.context.workspaceState.get<InterruptedTurnMark>(this.stateKey(INTERRUPTED_TURN_KEY));
    if (!mark || mark.scope !== this.draftScope() || mark.id !== this.currentSessionId) { return "none"; }
    const running = this.confirmedTurnActive || !mark.endedAt;
    const justFailed = !!mark.endedAt && Date.now() - mark.endedAt <= EXIT_AFTER_ERROR_MS;
    if (!running && !justFailed) {
      this.noteInterruptedTurn(undefined);
      return "none";
    }
    this.noteInterruptedTurn({ exitedAt: Date.now(), cause });
    return this.lastReadyEvent?.capabilities?.resume_turn === true ? "offer" : "none";
  }

  /**
   * Come back after the backend dies, instead of leaving the panel pointed at nothing.
   *
   * `dgc serve` is a plain, non-detached child of the extension host with piped stdio, so it goes
   * down with the host -- an extension update, a window reload, a host crash -- and it also exits
   * by itself when stdin closes. None of that is preventable from here, but all of it is
   * recoverable: the conversation and the goal live on disk, so a fresh backend can pick the work
   * back up. Bounded on purpose: a backend that cannot start (missing CLI, bad `dgc.command`)
   * must not be respawned forever.
   */
  private recoverBackend(): boolean {
    if (this.intentionalShutdown) { return false; }   // restart()/dispose() own their own lifecycle
    const now = Date.now();
    this.backendRecoveries = this.backendRecoveries.filter((at) => now - at < 120_000);
    if (this.backendRecoveries.length >= 3) {
      this.post({ type: "event", event: { type: "error", message:
        "DGC could not keep its backend running (three restarts in two minutes), so it stopped "
        + "trying. Open the DGC Backend output channel to see why it exited, then run "
        + "DGC: Restart Backend." } });
      return false;
    }
    this.backendRecoveries.push(now);
    const delay = Math.min(4000, 500 * 2 ** (this.backendRecoveries.length - 1));
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); }
    const timer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (this.backend || !this.view) { return; }
      try {
        this.ensureBackend();
      } catch { /* an untrusted workspace or missing executable already told the user */ }
    }, delay);
    // A pending retry is not a reason to keep a process alive; without this the timer holds the
    // Node event loop open, which is wrong on its own and hangs the test runner after the last
    // assertion has already passed.
    timer.unref?.();
    this.recoveryTimer = timer;
    return true;
  }

  /**
   * The resolved dgc.command changed (Settings Sync, settings.json, the settings UI). A restart
   * mid-turn kills the turn, so a running turn finishes first and the restart follows its end.
   */
  commandPathChanged(): void {
    if (this.processBusy()) {
      if (!this.pendingCommandRestart) {
        this.pendingCommandRestart = true;
        this.backendNote("[extension: dgc.command changed during a turn — restarting when it ends]");
        void vscode.window.showInformationMessage(
          "DGC will restart with the new command path when the current turn ends.");
      }
      return;
    }
    this.restart("setting dgc.command changed");
    void vscode.window.showInformationMessage("DGC restarted with the new command path.");
  }

  /**
   * The deferred half of commandPathChanged(): once nothing is running, apply the new path.
   *
   * A turn_end is not "nothing is running": the backend's worker may already hold the next queued
   * prompt (or a goal's retry), whose turn_start follows the turn_end, and a restart there shut
   * the backend down under it and dropped the user's queued message. So ask the backend first --
   * `status.busy` is computed under the same lock the queue uses, and commands are handled in
   * order, so a prompt sent before this request is already counted. Anything still busy keeps the
   * restart pending for the next turn_end.
   */
  private runPendingCommandRestart(): void {
    if (!this.pendingCommandRestart || this.processBusy()) { return; }
    // One status check at a time; a turn that ends while one is out is looked at again after it.
    if (this.commandRestartCheck) { this.commandRestartRecheck = true; return; }
    this.commandRestartRecheck = false;
    const be = this.backend;
    const apply = () => {
      this.pendingCommandRestart = false;
      this.restart("setting dgc.command changed");
      void vscode.window.showInformationMessage("DGC restarted with the new command path.");
    };
    if (!be) {
      // After the event being handled reaches the webview, so a finished turn renders as finished.
      setTimeout(() => { if (this.pendingCommandRestart && !this.processBusy()) { apply(); } }, 0);
      return;
    }
    const check = this.requestState(be, "command-restart", { type: "status" }, "status", 10000)
      .then((status: any) => {
        if (!this.pendingCommandRestart || this.backend !== be) { return; }
        if (this.processBusy() || status?.busy === true) {
          this.backendNote("[extension: dgc.command restart still waiting — the backend has more work queued]");
          // The next turn_end asks again. A foreground operation that ends with no turn event (a
          // compaction) would leave nothing to ask, so look again later too; a no-op once applied.
          const later = setTimeout(() => this.runPendingCommandRestart(), 15_000);
          later.unref?.();
          return;
        }
        apply();
      }, () => {
        // A backend that cannot answer is not proof that it is idle; keep waiting. Its exit clears
        // the pending restart, because the replacement starts from the new path anyway.
        this.backendNote("[extension: dgc.command restart still waiting — the backend did not answer a status check]");
      })
      .finally(() => {
        if (this.commandRestartCheck !== check) { return; }
        this.commandRestartCheck = undefined;
        if (this.commandRestartRecheck) { this.commandRestartRecheck = false; this.runPendingCommandRestart(); }
      });
    this.commandRestartCheck = check;
  }

  restart(reason = "command DGC: Restart Backend"): void {
    this._installPrompted = false;      // a fresh start earns a fresh prompt if the CLI is still missing
    this._updatePrompted = false;
    this.pendingCommandRestart = false;
    this.setReadyContext(false);
    this.changesRefreshRevision++;
    this.workspaceChanges = [];
    // A deliberate restart is not a crash: it must not spend the automatic-recovery budget, and
    // the respawn below is the one that counts.
    this.backendNote(`[extension: restarting the backend — ${reason}]`);
    this.intentionalShutdown = true;
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined; }
    this.backendRecoveries = [];
    // Restarting is the user's (or the updater's) decision, so a turn it cuts off is not offered back.
    this.noteInterruptedTurn(undefined);
    this.queuedPromptsLost();                          // the backend holding them is going away
    // A new process, not a new chat on the old one: a changed CLI or a wedged backend is the
    // reason to restart, and every chat on a shared process restarts with it. The others are
    // armed to come back on their own sessions when you switch to them. Left as they were, an
    // opened chat took every prompt and never sent it, and its tab kept a working dot.
    const process = this.processOf(this.backend);
    if (process) {
      for (const other of this.slots) {
        if (other.id === this.activeSlotId) { continue; }
        if (this.processOf(other.backend || (other.saved?.backend as ChatBackend | undefined)) === process) {
          this.backgroundBackendLost(other, `the backend was restarted (${reason})`);
        }
      }
    }
    this.processEpoch++;
    this.backend?.restartProcess(`restart: ${reason}`);
    this.backend = undefined;
    this.intentionalShutdown = false;
    this.mcpUrls.clear();
    this.turnActive = this.confirmedTurnActive = this.monitorTurnActive = false;
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
    const refEvent: any = ev;
    if (this.pendingGoalEdit) {
      if (["ready", "session"].includes(ev.type)) {
        this.settleGoalEdit("The session changed before the goal edit was confirmed. Check the current goal before trying again.");
      } else if (refEvent.request_id === this.pendingGoalEdit) {
        if (ev.type === "goal_changed") { this.settleGoalEdit(); }
        else if (["command_rejected", "error"].includes(ev.type)) {
          this.settleGoalEdit(String(refEvent.message || "The goal edit could not be applied."));
          return;
        }
      }
    }

    if (refEvent.type === "prompt_pips" || refEvent.type === "command_rejected" && refEvent.command === "list_prompt_pips") {
      const owner = this.promptPipRequests.get(refEvent.request_id); this.promptPipRequests.delete(refEvent.request_id);
      if (owner && owner.backend === this.backend && owner.session === this.currentSessionId && owner.generation === this.sessionHandshakeGeneration) this.post({type:"event",event:ev});
      return;
    }
    if (this.pipsEditor?.event(ev)) return;
    if (["pips_result", "pips_status"].includes(ev.type)) return;
    // A session that keeps running with no window (dgc/serve_detach.py): the panel's own business.
    if (ev.type === "session_live") return;          // ready.capabilities.attached has already said it
    if (ev.type === "models_at") return;             // Settings' Model boxes: answered to their own request
    if (ev.type === "session_moved") { this.sessionMoved(String((ev as any).reason || "")); return; }
    if (ev.type === "turn_interrupted") { this.offerTurnStoppedWithoutWindow(ev); return; }
    if (ev.type === "live_sessions") { this.liveSessionsArrived(ev); return; }
    // The request handlers project summaries and open text documents. Raw roots and file bodies
    // are owner-facing host data, not chat events or model inputs for the webview.
    if (ev.type === "chat_changes" || ev.type === "chat_change" || ev.type === "workspace_changes" || ev.type === "workspace_change"
        || ev.type === "pip_fix_change"
        || (ev.type === "command_rejected" && ["get_workspace_changes", "get_workspace_change", "get_chat_changes", "get_chat_change", "get_pip_fix_change"].includes(ev.command))) return;
    // Account setup replies may contain single-use consent links. Never send them to chat.
    if (ev.type === "composio_connection") return;
    const openImageAnswer = this.noteImageEvent(ev);
    switch (ev.type) {
      case "ready":
        this.sessionReady = false;
        this.sessionRestoreStarted = false;
        this.sessionRestoreFinished = false;
        this.sessionRestoreRequestId = undefined;
        this.sessionDraftSource = "";
        this.sessionHandshakeGeneration++;
        if (this.sessionRestoreSuppressed) {
          // This chat was opened deliberately empty (or is being restarted onto its own session),
          // so it keeps the candidate its slot gave it. `ready` re-reading the workspace's
          // remembered chat here is what made a second chat resume the FIRST chat's session and
          // die on "this session has an active turn in another DGC process" — ensureBackend's
          // suppression was already spent by the time this ran.
          this.sessionRestoreSuppressed = false;
        } else {
          const saved = this.context.workspaceState.get<{ scope?: string; id?: string; saved?: boolean }>("dgc.activeSession.v1");
          this.sessionRestoreCandidate = saved?.scope === this.draftScope() && /^[A-Za-z0-9_-]{1,128}$/.test(saved.id || "")
            ? saved.id! : "";
          this.sessionRestoreSaved = saved?.saved !== false;
        }
        this.lastReadyEvent = ev;
        // A finished background agent's report, drawn as its own line in the chat (agent_report). Asked with the
        // handshake, ahead of the session this chat restores, so the history it replays has those lines too. A
        // backend that doesn't offer it is never asked, and its wake turns keep the plain "Woke on agent" note.
        if (Number((ev.capabilities as any)?.agent_reports) >= 1) {
          this.backend?.sendSetup({ type: "watch_agent_reports" });
        }
        // Memory that learns: this panel shows the line a Work session's look back adds ("Remembered: … · Forget"),
        // so it asks for memory_learned. A backend that doesn't offer it never sends one.
        if (Number((ev.capabilities as any)?.memory?.learned) >= 1) {
          this.backend?.send({ type: "memory_watch", request_id: this.nextRequestId("memory-watch") });
        }
        // The window a vLLM, SGLang or llama.cpp server was started with: asked once, then sent as it changes. The
        // meter and Settings show it as set by the server. A backend that doesn't offer it is never asked.
        this.serverWindow = undefined;
        if (Number((ev.capabilities as any)?.server_window) >= 1) {
          this.backend?.send({ type: "server_window", request_id: this.nextRequestId("server-window") });
        }
        this.currentSessionId = String(ev.session_id || "");
        this.currentSessionName = String(ev.session_name || "");
        this.currentSessionSaved = false;           // a fresh backend's chat has no file yet
        this.rememberHomeBackend();
        this.turnActive = this.confirmedTurnActive = this.monitorTurnActive = false;
        this.workspaceRootsInFlight = undefined;
        this.workspaceRootsDirty = true;
        const live = this.attachedChat(ev);
        this.attachedLive = !!live;
        this.rootsAfterLiveTurn = false;
        if (live) {
          // A window reattached to the session it was showing, which kept running with no window. The
          // turn, its queue and the decisions it waits on are that backend's; the transcript is repainted
          // from its snapshot once the handshake ends.
          this.currentSessionSaved = true;
          this.sessionElsewhere = undefined;
          this.whenWebviewReady(() => this.post({ type: "session_elsewhere", state: "none" }));
          if (live.turn) {
            this.turnActive = this.confirmedTurnActive = true;
            this.monitorTurnActive = live.turn.kind === "monitor";
            const startedAt = Number(live.turn.started_at) > 0 ? Math.min(Date.now(), Number(live.turn.started_at) * 1000) : Date.now();
            this.turnStartedAt = startedAt;
            this.liveTurn = { turnId: String(live.turn.turn_id || ""), kind: String(live.turn.kind || "prompt"),
                              prompt: String(live.turn.prompt || ""), startedAt, handoff: false };
          } else {
            this.liveTurn = undefined;
            this.noteInterruptedTurn(undefined);   // it finished with no window: nothing to continue
          }
          this.openDecisions = new Set((live.waiting || []).map(String));
          this.adoptLiveQueue(live);
          // The process this window started kept other chats running too (a tab's second chat): each
          // comes back as a chat of its own here, in the background, as it was.
          if (this.backend instanceof DgcBackend) { this.adoptKeptChats(this.backend); }
          this.backendNote(`[extension: reattached to dgc serve pid ${(ev.capabilities as any)?.attached?.pid ?? "?"}, `
            + `which kept this session running${live.turn ? " (a turn is running)" : ""}]`);
        } else {
          const elsewhere = (ev.capabilities as any)?.detach?.elsewhere;
          this.sessionElsewhere = elsewhere && elsewhere.session_id && elsewhere.session_id === this.sessionRestoreCandidate
            ? { state: "elsewhere", pid: Number(elsewhere.pid) || undefined } : undefined;
        }
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
        if (this.backend && live) {
          // The backend already has this window's settings and folders: its last window sent them, and a
          // turn may be using them. Only the folder grant is sent again, once nothing is running.
          const backend = this.backend;
          this.initializingBackend = backend;
          this.nativeSettingsReady = true;
          if (this.turnActive && !this.monitorTurnActive) {
            this.workspaceRootsDirty = false;
            this.rootsAfterLiveTurn = true;
          } else {
            this.syncWorkspaceRoots(backend, true);
          }
          this.maybeCompleteHandshake(backend);
        } else if (this.backend) {
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
          this.currentSessionSaved = ev.kind === "resumed" || ev.kind === "forked"
            || (ev.kind !== "new" && ev.kind !== "cleared" && this.currentSessionSaved);
          this.rememberSession();
          this.postChatSlots();                      // the chip carries this chat's name
          // /new or /clear in a tab: it is a new session's tab now, named by its next prompt.
          if (this.tab && (ev.kind === "new" || ev.kind === "cleared")) { this.tabTitled = false; this.tab.title(""); }
          this.retitle();
          this.tabSessionChanged();
        }
        break;
      case "session_named":
        this.currentSessionName = String(ev.name || "");
        if (!this.currentSessionSaved) { this.currentSessionSaved = true; this.rememberSession(); }   // naming saves it
        this.postChatSlots();
        this.retitle();
        this.tabSessionChanged();
        break;
      case "server_window":
        this.serverWindow = { model: String((ev as any).model || ""), window: Math.max(0, Math.floor(Number((ev as any).window) || 0)),
                              server: String((ev as any).server || ""), trained: Math.max(0, Math.floor(Number((ev as any).trained) || 0)) };
        break;
      case "pips_settings":
        this.pipsSettings = { model: String((ev as any).model ?? "").slice(0, 256) };
        break;
      case "model_wait_settings":
        this.waitSettings = { first_token: String((ev as any).first_token ?? "auto").slice(0, 16),
                              between_words_s: Math.max(0, Math.floor(Number((ev as any).between_words_s) || 0)) };
        break;
      case "cache_settings":
        this.cacheSettings = {
          prompt_cache: (ev as any).prompt_cache !== false,
          prompt_cache_ttl: (ev as any).prompt_cache_ttl === "1h" ? "1h" : "5m",
          ollama_keep_alive: String((ev as any).ollama_keep_alive ?? ""),
        };
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
        // Remember that a goal was genuinely being pursued, durably enough to survive the
        // extension host restarting. Any other status is the user's own decision and clears it,
        // so a goal somebody paused or finished is never revived behind their back.
        this.noteGoalPursuit(this.state.goal.status === "active");
        this.postState();
        break;
      case "config":
        if ("search_api_key_set" in ev) { this.searchSettable = true; }
        // search_api_key_set is the selected provider's own key, from a CLI that keeps one per provider.
        if (this.searchKeyState()?.has(String(ev.search || "")) && typeof ev.search_api_key_set === "boolean") {
          this.searchKeyState()!.set(String(ev.search), ev.search_api_key_set);
        }
        if ("chatdgc_personality" in ev) { this.chatdgcSettable = true; }
        if ("turn_token_budget" in ev) { this.budgetSettable = true; }
        if ("subagent_context_size" in ev) { this.subagentWindowSettable = true; }
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
        this.behaviorState.thinkingInline = ev.thinking_inline !== false;
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
          const callbackUrl = typeof ev.payload._dgc_bridge_callback === "string"
            ? ev.payload._dgc_bridge_callback : "";
          // A device sign-in (Sign in with GitHub): DGC's own client set this code, as it sets the callback above.
          const deviceCode = typeof ev.payload._dgc_device_code === "string"
            && /^[A-Za-z0-9-]{4,24}$/.test(ev.payload._dgc_device_code) ? ev.payload._dgc_device_code : "";
          this.backendNote(`[mcp sign-in prompt for ${String(ev.server || "plugin")}]`);
          this.mcpUrls.set(String(ev.id), { url: String(ev.payload.url || ""),
            ...(callbackUrl ? { callbackUrl } : {}), ...(deviceCode ? { deviceCode } : {}) });
          // Open straight away ONLY for the pinned local sign-in bridge. That callback is set by
          // the CLI (mcp.py, at the point it starts the bridge) and never by a server, so its
          // presence means the user clicked Connect a moment ago and is waiting for the browser.
          //
          // Any connected server can send this same elicitation while servicing a tools/call the
          // model just made -- the CLI requires only that one client request be in flight, and
          // tools/call qualifies. Those go to the webview, which names the requesting server,
          // shows the host and the full URL, and draws the punycode warning that the CLI and the
          // TUI both still draw. 0.44.1 asked; returning here for every mode:"url" took the ask
          // away from the editor alone, and the same batch ships a marketplace that installs
          // third-party MCP servers.
          if (callbackUrl || deviceCode) {
            void this.confirmMcpBrowser(String(ev.id), String(ev.server || "this plugin"));
            return;
          }
          break;
        }
        this.backendNote(`[mcp input ignored kind=${String(ev.kind || "")}]`);
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
      case "prompt_accepted":
        // Steering waits for the running step to finish before it is applied; until then the backend
        // holds it exactly as it holds a queued prompt, and loses it the same way.
        if (ev.state === "queued" || ev.state === "steered") {
          this.markPromptQueued(String(ev.request_id || ""), ev.state === "steered");
        }
        break;
      case "steering_update":
        if (ev.state === "queued") { this.markPromptQueued(String(ev.request_id || "")); }
        else { this.forgetPrompt(String(ev.request_id || "")); }   // applied, or handed back to the webview
        break;
      case "turn_start": {
        this.forgetPrompt(String(ev.request_id || ""));
        const wasSaved = this.currentSessionSaved;
        if (!this.currentSessionSaved) { this.currentSessionSaved = true; this.rememberSession(); }   // it has content now
        this.turnActive = this.confirmedTurnActive = true;
        this.monitorTurnActive = ev.kind === "monitor";
        this.turnStartedAt = Date.now();
        this.liveTurn = { turnId: String(ev.turn_id || ""), kind: String(ev.kind || "prompt"),
                          prompt: String(ev.prompt || ""), startedAt: this.turnStartedAt, handoff: false };
        // Goal cycles ("resume") are the goal's to pick back up; only an ordinary turn, or a
        // continuation of one, is offered a Continue after a backend death. A monitor turn is
        // DGC's own and simply wakes again on the next event.
        if (ev.kind !== "resume" && ev.kind !== "monitor" && this.currentSessionId) {
          // On a backend that keeps its work running when the window goes, a reload does not cut this turn
          // off: that backend says so itself if it ever stops it (turn_interrupted).
          const keeps = !!this.processOf(this.backend)?.detach;
          this.noteInterruptedTurn({ scope: this.draftScope(), id: this.currentSessionId,
                                     turnId: String(ev.turn_id || ""), at: Date.now(),
                                     ...(keeps ? { detachedAt: Date.now() } : {}) });
        }
        this.postChatSlots();                        // this chat's chip shows it is working now
        if (ev.kind === "prompt" || !ev.kind) { this.retitle(String(ev.prompt || "").replace(/📷/g, " ")); }
        if (this.tab && !wasSaved) { this.tabSessionChanged(); }   // its session is in the list now
        break;
      }
      case "handoff_started":
        this.turnActive = this.confirmedTurnActive = true;
        this.liveTurn = { turnId: "", kind: "prompt", prompt: "", startedAt: Date.now(), handoff: true };
        break;
      case "handoff":
        this.turnActive = this.confirmedTurnActive = this.monitorTurnActive = false;
        this.syncWorkspaceRoots();
        this.runPendingCommandRestart();
        break;
      case "command_rejected":
        if (ev.command === "prompt") { this.forgetPrompt(String(ev.request_id || "")); }
        if (ev.command === "prompt" || ev.command === "start_goal" || ev.command === "resume_turn") {
          this.turnActive = this.confirmedTurnActive;
          this.syncWorkspaceRoots();
          this.runPendingCommandRestart();
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
      case "permission_request":
      case "options_request":
      case "ask_request":
      case "plan_proposal":
        // Remembered so switching away can show this chat as waiting on you. Painting is the
        // webview's job; this is only the bookkeeping the chip needs.
        {
          const id = DgcViewProvider.decisionId(ev);
          if (id) { this.openDecisions.add(id); }
        }
        if (!this.view?.visible) { this.announceWaiting(this.activeSlot(), String(ev.type)); }
        break;
      case "permission_resolved":
      case "options_resolved":
      case "ask_resolved":
        this.openDecisions.delete(DgcViewProvider.decisionId(ev));
        break;
      case "request_expired":
        this.openDecisions.delete(DgcViewProvider.decisionId(ev));
        this.mcpUrls.delete(String(ev.id));
        break;
      case "turn_end": {
        this.mcpUrls.clear();
        this.activeSlot().announced = false;
        const monitorTurn = this.monitorTurnActive;
        this.turnActive = this.confirmedTurnActive = this.monitorTurnActive = false;
        this.openDecisions.clear();      // nothing can still be waiting once the turn is over
        this.postChatSlots();
        // An error end is kept for thirty seconds: when the backend is shutting down under a turn
        // the turn ends "error" first and the process exits after, and that turn WAS interrupted.
        if (ev.reason === "error") { this.noteInterruptedTurn({ endedAt: Date.now() }); }
        else { this.noteInterruptedTurn(undefined); }
        // A reattached turn ran on the folders its last window granted; this window's go now.
        if (this.rootsAfterLiveTurn) { this.rootsAfterLiveTurn = false; this.workspaceRootsDirty = true; }
        this.syncWorkspaceRoots();
        // Nobody asked for a monitor turn, so nobody is waiting to hear that it finished.
        if (monitorTurn) { this.turnStartedAt = 0; }
        else { this.notifyTurnEnd(String(ev.reason || "completed")); }
        this.runPendingCommandRestart();
        break;
      }
    }
    if (ev.type === "error" && (ev as any).notInstalled) {
      this.promptInstallCli();
    }
    if (ev.type === "error" && (ev as any).cli_outdated) {
      this.promptUpdateCli();
    }
    if (ev.type === "error" && (ev as any).extension_outdated && !this.tab) {
      void checkForExtensionUpdates(this.context, true);
    }
    if (["tool_result", "turn_end", "rewound", "session"].includes(ev.type)) {
      this.scheduleWorkspaceChanges(ev.type === "tool_result" ? 120 : 0);
    }
    if (ev.type === "image") {
      // The stored copy's path is for this host's Open file only; the webview asks by ref.
      // An answer to Open file's own get_image went to its waiter: the bytes never cross the bridge.
      if (openImageAnswer) { return; }
      const { path: _stored, ...answer } = ev as any;
      this.post({ type: "event", event: answer });
      return;
    }
    // The rejections the settings page can actually explain: its own skill toggle, its own usage
    // read, its own MCP write. Every other failure it shows reaches it as a typed message
    // (`pluginOperationError`, `pluginResult`), so forwarding the raw rejection as well did two
    // things: it delivered every plugin failure twice, and -- because the client's chain ends in a
    // bare `section === 'mcp'` -- it painted a rejection from the CHAT (a refused prompt, a
    // duplicate skill name, a full follow-up queue) as a red MCP-server banner over a page that
    // was working, where it then outlived leaving the section.
    const settingsRejection = ev.type === "command_rejected" && SETTINGS_REJECTIONS.includes(String(ev.command || ""));
    // Voice: the page's own state and progress, and only its own errors (a chat's dictation reports its own).
    const settingsVoice = ["voice_state", "voice_progress"].includes(ev.type)
      || (ev.type === "voice_error" && String((ev as any).request_id || "").startsWith("settings-voice"));
    if (this.settingsEditor && (settingsRejection || settingsVoice || ["config", "server_window", "usage_report", "pip_usage_report", "mcp_servers", "memory_state", "memory_history"].includes(ev.type))) {
      const managed = ev.type === "mcp_servers" ? new Map(this.managedMcpServers().map((m) => [m.name, m])) : null;
      // The form shows a server's own OAuth app (its public client id and port); never its secret.
      const event = managed && Array.isArray((ev as any).items) ? { ...ev, items: (ev as any).items.map((item: any) => {
        const own = managed.get(item?.name)?.oauth;
        return own ? { ...item, oauth_client_id: own.clientId, oauth_port: own.port } : item;
      }) }
        // Settings -> Web search offers the providers this CLI takes, from its handshake, and (from a CLI that keeps
        // one key per provider) which of them have a key saved. Never a key itself.
        : ev.type === "config" ? { ...ev, search_providers: this.searchProviders(),
                                   ...(this.searchKeyState() ? { search_keys: Object.fromEntries(this.searchKeyState()!) } : {}),
                                   // Not protocol fields: the cache_settings event that came just before.
                                   ...(this.cacheSettings ? { prompt_cache_ttl: this.cacheSettings.prompt_cache_ttl,
                                                              ollama_keep_alive: this.cacheSettings.ollama_keep_alive,
                                                              cache_settable: true } : {}),
                                   // Not a protocol field either: the last server_window event, for Context size.
                                   ...(this.serverWindow ? { server_window: { ...this.serverWindow } } : {}),
                                   // Nor this: the CLI lists the models at a host as typed (list_models_at).
                                   list_models_at: this.listsModelsAt(),
                                   // Nor these: the pips_settings event that came just before.
                                   ...(this.pipsSettings ? { pips_model: this.pipsSettings.model, pips_settable: true } : {}),
                                   // Nor these: the model_wait_settings event that came just before, as the page shows it.
                                   ...(this.waitSettings ? { ...waitDraft(this.waitSettings), wait_settable: true } : {}) } : ev;
      this.settingsEditor.webview.postMessage({ type: "event", event });
    }
    if (ev.type === "mcp_servers" && this.pendingSignInServer) {
      const row = (ev as any).items?.find((item: any) => item.name === this.pendingSignInServer);
      if (row && ["connected", "failed", "disabled"].includes(row.state)) {
        this.pendingSignIn = undefined; this.openedSignIn = undefined;
        this.pendingSignInServer = "";
        this.settingsEditor?.webview.postMessage({ type: "signin", clear: true });
      }
    }
    if (ev.type === "plugin_preview") {
      const requested = this.settingsPreviewRequests.get(ev.request_id);
      this.settingsPreviewRequests.delete(ev.request_id);
      if (requested) {
        const item = ev.item as any;
        if (this.settingsPreviews.size >= 32) this.settingsPreviews.clear();
        this.settingsPreviews.set(String(item.name), item);
        this.settingsPreviews.set(requested, item);
        this.settingsEditor?.webview.postMessage({ type: "pluginPreview", requested, item: { ...item, logo: this.pluginLogo(item, this.settingsEditor?.webview) } });
      }
      return;
    }
    if (ev.type === "plugin_marketplaces") {
      this.settingsEditor?.webview.postMessage({ type: "marketplaces", items: ev.items });
      return;
    }
    // A plugin key saved or removed from its page: answered to that page alone, never with the key.
    const keyRequest = ["plugin_operation", "command_rejected"].includes(ev.type)
      ? this.settingsKeyRequests.get(String((ev as any).request_id || "")) : undefined;
    if (keyRequest && (ev.type === "plugin_operation"
        || ["set_plugin_key", "remove_plugin_key", "set_plugin_sign_in_scopes"].includes(String((ev as any).command || "")))) {
      this.settingsKeyRequests.delete(String((ev as any).request_id || ""));
      this.settingsEditor?.webview.postMessage({ type: "pluginKeyResult", ...keyRequest,
        ...(ev.type === "plugin_operation" ? { message: String((ev as any).message || "") }
          : { error: String((ev as any).message || "DGC couldn't save the key.") }) });
      return;
    }
    if (ev.type === "plugin_operation") {
      if (ev.action === "create_plugin" && ev.path) {
        const root = join(dgcHome(), "plugins", "authored");
        if (path.resolve(ev.path).startsWith(root + path.sep)) this.createdPluginFiles.add(ev.path);
      }
      if (ev.action === "uninstall_plugin" && ev.removed_servers?.length) {
        void this.clearUninstalledPluginServers(ev.removed_servers as string[]).then(() => {
          this.settingsEditor?.webview.postMessage({ ...ev, type: "pluginOperation" });
        }).catch((error: any) => {
          this.settingsEditor?.webview.postMessage({ type: "pluginOperationError", action: ev.action,
            message: `Plugin removed, but its editor server records could not be cleared: ${error?.message || "storage error"}. Remove those servers in MCP settings before reloading.` });
        });
      } else this.settingsEditor?.webview.postMessage({ ...ev, type: "pluginOperation" });
      return;
    }
    if (ev.type === "command_rejected" && ["inspect_plugin", "uninstall_plugin", "add_plugin_marketplace", "remove_plugin_marketplace", "refresh_plugin_marketplace", "create_plugin", "list_plugin_marketplaces"].includes(ev.command)) {
      const requested = this.settingsPreviewRequests.get(String(ev.request_id || ""));
      this.settingsPreviewRequests.delete(String(ev.request_id || ""));
      this.settingsEditor?.webview.postMessage({ type: "pluginOperationError", requested, action: ev.command, message: ev.message });
    }
    if (ev.type === "command_rejected" && ev.command === "set_plugin_sign_in_scopes"
        && this.settingsInstalls.has(String(ev.request_id || ""))) {
      // Sign in again didn't connect: said on the plugin's page, like a Connect that failed there.
      const name = this.settingsInstalls.get(String(ev.request_id || ""));
      this.settingsInstalls.delete(String(ev.request_id));
      this.pendingSignIn = undefined; this.openedSignIn = undefined;
      this.pendingSignInServer = "";
      this.settingsEditor?.webview.postMessage({ type: "signin", clear: true });
      this.settingsEditor?.webview.postMessage({ type: "pluginResult", name, error: String(ev.message || "Sign-in didn't finish.") });
      return;
    }
    if (ev.type === "command_rejected" && ev.command === "install_plugin") {
      const name = this.settingsInstalls.get(String(ev.request_id || ""));
      if (name) {
        this.settingsInstalls.delete(String(ev.request_id));
        this.pendingSignIn = undefined; this.openedSignIn = undefined;
        this.pendingSignInServer = "";
        this.settingsEditor?.webview.postMessage({ type: "signin", clear: true });
        this.settingsEditor?.webview.postMessage({ type: "pluginResult", name, error: String(ev.message || "Plugin install failed.") });
      }
      void vscode.window.showErrorMessage(String(ev.message || "Plugin install failed."));
    }
    if (ev.type === "plugin_catalog" && Array.isArray((ev as any).items)) {
      this.settingsCatalog = (ev as any).items;
      if (this.pendingSignInServer && this.settingsCatalog.some(row => (row.name === this.pendingSignInServer || row.server_names?.includes(this.pendingSignInServer)) && row.connected)) {
        this.pendingSignIn = undefined; this.openedSignIn = undefined;
        this.pendingSignInServer = "";
        this.settingsEditor?.webview.postMessage({ type: "signin", clear: true });
      }
      const installName = this.settingsInstalls.get(String(ev.request_id || ""));
      if (installName && !this.settingsCatalog.some(row => row.name === installName && row.opening)) {
        this.settingsInstalls.delete(String(ev.request_id));
        this.settingsEditor?.webview.postMessage({ type: "pluginResult", name: installName });
        this.backend?.send({ type: "list_mcp_servers", request_id: this.nextRequestId("settings-mcp") });
      }
      const items = (ev as any).items.map((item: any) => ({ ...item, logo: this.pluginLogo(item, this.view?.webview) }));
      if (this.view) this.post({ type: "event", event: { ...ev, items } });
      const editorItems = (ev as any).items.map((item: any) => ({
        ...item, logo: this.pluginLogo(item, this.settingsEditor?.webview),
      }));
      this.settingsEditor?.webview.postMessage({ type: "plugins", items: editorItems });
      return;
    }
    this.post({ type: "event", event: ev });
  }

  private async confirmMcpBrowser(id: string, server: string): Promise<void> {
    const be = this.backend;
    const request = this.mcpUrls.get(id);
    if (!be || !request || request.opening) return;
    request.opening = true;
    let host = "";
    try { host = new URL(request.url).host; } catch { host = ""; }
    // The plugin's own name where Settings knows it ("GitHub", not "Github").
    const known = this.settingsCatalog.find(row => row?.name === server || row?.server_names?.includes?.(server));
    const title = (typeof known?.display_name === "string" && known.display_name)
      || server.replace(/[-_]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()) || "This plugin";
    const current = () => this.backend === be && this.mcpUrls.get(id) === request;
    this.pendingSignIn = request;
    this.pendingSignInServer = server;
    this.settingsEditor?.webview.postMessage({
      type: "signin", title, host, server, id, ...(request.deviceCode ? { code: request.deviceCode } : {}),
    });
    // Cursor draws its own "open the external website?" dialog from openExternal.
    let action = "cancel";
    try {
      // A device sign-in shows its code first and copies it, as VS Code's own GitHub sign-in does: the page that
      // opens asks for it.
      const go = !request.deviceCode || await vscode.window.showInformationMessage(
        `Sign in to ${title}: enter the code ${request.deviceCode}`,
        { modal: true, detail: `DGC copies the code. Paste it on the ${host || "sign-in"} page that opens, then approve DGC.` },
        "Copy code and open") === "Copy code and open";
      if (go && request.deviceCode) await vscode.env.clipboard.writeText(request.deviceCode);
      if (go && await openMcpBrowser(request, current)) action = "accept";
    } catch (error) {
      if (current()) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : "The browser did not open.");
      }
    }
    if (!current()) return; // an expired dialog must not clear a newer connection banner
    if (action !== "accept") {
      this.pendingSignIn = undefined; this.openedSignIn = undefined;
      this.settingsEditor?.webview.postMessage({ type: "signin", clear: true });
    }
    if (this.backend !== be || !this.mcpUrls.has(id)) return;
    this.mcpUrls.delete(id);
    be.send({ type: "mcp_input_response", id, action });
    if (action === "accept" && this.pendingSignIn === request) { this.openedSignIn = { id, be }; }
  }

  /** On native Windows, DGC's `dgc serve` runs in its own WSL distro (src/wslSetup.ts); elsewhere, as it is. */
  private hostRoute() {
    const distro = hiddenWslDistro();
    return distro ? wslRoute(distro) : undefined;
  }

  private promptInstallCli(): void {
    if (this._installPrompted || this.tab) { return; }       // the side bar asks, once for the window
    this._installPrompted = true;
    const distro = hiddenWslDistro();
    if (distro) {
      // Not a CLI on PATH: DGC's distro, set up step by step, then this backend starts again.
      void setUpWsl(distro, this.backendLog).then((ready) => {
        this._installPrompted = false;
        if (ready) { this.restart("DGC set up in WSL"); }
      });
      return;
    }
    const INSTALL = "Install DGC CLI", SETPATH = "Set dgc.command…", RETRY = "Retry";
    vscode.window.showErrorMessage(
      "DGC needs the `dgc` command-line tool, which isn't installed or on PATH.",
      INSTALL, SETPATH, RETRY,
    ).then((choice) => {
      if (choice === RETRY) {
        this.restart("install prompt Retry");
      } else if (choice === INSTALL) {
        const term = vscode.window.createTerminal(installTerminalOptions("Install DGC"));
        term.show();
        term.sendText(INSTALL_COMMAND);
        vscode.window.showInformationMessage(
          "Installing the DGC CLI in the terminal. When it finishes, reload the window to connect.");
      } else if (choice === SETPATH) {
        vscode.commands.executeCommand("workbench.action.openSettings", "dgc.command");
      }
    });
  }

  /** The CLI is older than this extension — bring it forward rather than naming the problem.
   *
   *  Updating the extension is the common way to land here: editors update extensions on their own
   *  and the CLI does not follow, so the user is told their own tool is out of date by the thing
   *  that just changed underneath them. So by default the extension does the update itself and
   *  restarts, and the user watches a progress notification instead of running a command.
   *
   *  Two cases still ask first, because an automatic reinstall would be the wrong answer:
   *  a CLI the user chose by path (unless that path is a DGC versioned install, which updates
   *  itself in place), and dgc.autoUpdateCli turned off. A third case asks after the fact: the
   *  installer refuses to repoint a launcher that runs a git checkout, so a contributor's working
   *  tree stays in use and the refusal is reported as the reason. */
  private promptUpdateCli(): void {
    if (this._updatePrompted || this.tab) { return; }        // the side bar updates it, once for the window
    this._updatePrompted = true;
    const executable = resolveDgcExecutable();
    if (!autoUpdateEnabled() || isUserChosenCommand() || executable.ignoredWorkspaceOverride) {
      this.offerManualCliUpdate("This DGC CLI is older than the DGC extension. Update it to reconnect.");
      return;
    }
    if (this.cliAutoUpdateAttempted) {
      // Already tried once this session and we are still mismatched, so the installer is not going
      // to resolve it — most likely the matching CLI is not published yet. Say that, and stop.
      this.offerManualCliUpdate(
        "This DGC CLI is still older than the DGC extension after an update. "
        + "The matching CLI may not be published yet.");
      return;
    }
    this.cliAutoUpdateAttempted = true;
    void this.updateCliInPlace(executable.command);
  }

  /** Run the update with a progress notification, then restart so the panel reconnects by itself. */
  private async updateCliInPlace(executable: string): Promise<void> {
    // No targetVersion. The installer serves exactly one version -- the latest -- and refuses any
    // other outright ("DGC <x> was requested, but <site> publishes <y>"). Naming the version this
    // extension was built against could therefore only ever do nothing (when they happen to match)
    // or fail the update (whenever the CLI has shipped since), which is what it did: every user on
    // an older CLI was told the update failed and left disconnected until they found the unpinned
    // "Update CLI" command. Install what is published; the handshake below still enforces the
    // minimum, and offerManualCliUpdate() already covers "still older after an update".
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "DGC: updating the CLI to match the extension…", cancellable: true },
      // No targetVersion. The installer serves exactly one version -- the latest -- and refuses
      // any other outright, so naming the version this extension was built against could only do
      // nothing (when they happen to match) or fail the update. It failed: every user on an older
      // CLI was told the update failed and left disconnected, unable to reach the CLI that would
      // have fixed them. Install what is published; the handshake still enforces the minimum.
      (_progress, token) => runCliUpdate(executable, token),
    );
    if (result.ok) {
      this.restart("CLI updated to match the extension");
      void vscode.window.showInformationMessage("DGC CLI updated. Reconnecting…");
      return;
    }
    this.cliUpdateLog(result.log);
    if (result.reason === "cancelled") {
      this.offerManualCliUpdate("The DGC CLI update was cancelled. The CLI is still older than the extension.");
      return;
    }
    this.offerManualCliUpdate(`DGC could not update the CLI automatically: ${result.reason}`);
  }

  /** Keep the installer's own output where the user can read it; a refusal explains itself there. */
  private cliUpdateLog(log: string): void {
    if (!log.trim()) { return; }
    if (!this.updateChannel) { this.updateChannel = vscode.window.createOutputChannel("DGC update"); }
    this.updateChannel.appendLine(log.trimEnd());
    this.updateChannel.show(true);
  }

  /** The pre-existing route, now the fallback: name the problem and offer the two manual fixes. */
  private offerManualCliUpdate(message: string): void {
    const UPDATE = "Update DGC CLI", SETPATH = "Set dgc.command…";
    void vscode.window.showErrorMessage(message, UPDATE, SETPATH).then((choice) => {
      if (choice === UPDATE) {
        // The exact executable with `update`, not `curl | bash` typed into a shell: an old CLI then
        // still updates the install it belongs to (DGC_DIR/DGC_BIN), and DGC_SKIP_EXTENSION keeps
        // the installer from replacing this running extension with the published .vsix.
        void updateCliWithProgress(resolveDgcExecutable().command, () => this.restart("manual CLI update"));
      } else if (choice === SETPATH) {
        void vscode.commands.executeCommand("workbench.action.openSettings", "dgc.command");
      }
    });
  }

  /** A chat you are not looking at stopped on something only you can answer: say so once, with a
   *  button that opens that chat. `dgc.notifyWhenWaiting` turns it off. */
  private announceWaiting(slot: ChatSlot, type: string): void {
    if (slot.announced) return;
    if (!vscode.workspace.getConfiguration("dgc").get<boolean>("notifyWhenWaiting", true)) return;
    slot.announced = true;
    const name = slot.id === this.activeSlotId ? this.chatLabel() : (slot.label || "New chat");
    const what = type === "permission_request" ? "is waiting for your approval"
      : type === "plan_proposal" ? "has a plan for you to review" : "has a question for you";
    const open = "Open chat";
    void Promise.resolve(vscode.window.showInformationMessage(`DGC: "${name}" ${what}.`, open)).then((choice) => {
      if (choice !== open || !this.slotById(slot.id)) return;
      this.focus();
      this.inVisiblePanel(() => this.switchToSlot(slot.id));
    });
  }

  /** A walk-away ping: only for turns over 20 s, only while the panel is not on screen. */
  private notifyTurnEnd(reason: string): void {
    const started = this.turnStartedAt;
    this.turnStartedAt = 0;
    if (!started || !vscode.workspace.getConfiguration("dgc").get<boolean>("notifyOnTurnEnd", false)) return;
    const seconds = Math.round((Date.now() - started) / 1000);
    if (seconds < 20 || this.view?.visible) return;
    const verb = reason === "paused" ? "paused" : reason === "cancelled" ? "stopped" : reason === "error" ? "failed" : "finished";
    void vscode.window.showInformationMessage(`DGC ${verb} after ${seconds}s`, "Show").then((choice) => {
      if (choice === "Show") this.view?.show?.(true);
    });
  }

  /** Write pasted images into the backend's spool and return what to send instead of base64.
   *
   * Returns undefined when there is nothing to spool or the backend does not offer the
   * capability, in which case the caller sends the data URIs as it always did. A failure to
   * write is also undefined, not an error: falling back to the inline path costs the user
   * nothing but the old ceiling, whereas failing the prompt would lose their message. */
  private async spoolImages(images: unknown): Promise<Array<{ name: string; media_type: string }> | undefined> {
    const list = Array.isArray(images) ? images : [];
    if (!list.length) { return undefined; }
    const caps = (this.lastReadyEvent as { capabilities?: Record<string, unknown> } | undefined)?.capabilities;
    const dir = typeof caps?.image_spool_dir === "string" ? caps.image_spool_dir : "";
    if (caps?.image_spool !== true || !dir) { return undefined; }
    const out: Array<{ name: string; media_type: string }> = [];
    try {
      const fs = await import("node:fs/promises");
      const crypto = await import("node:crypto");
      const nodePath = await import("node:path");
      await fs.mkdir(dir, { recursive: true });
      for (const value of list) {
        const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(String(value ?? ""));
        if (!match) { return undefined; }        // not ours to reinterpret; let the backend judge it
        // An iPhone photo (HEIC/HEIF) goes too: a backend with capabilities.heic_images sends the model a JPEG.
        const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
                       "image/webp": "webp", "image/bmp": "bmp",
                       ...(caps?.heic_images === true ? { "image/heic": "heic", "image/heif": "heif" } : {}) } as Record<string, string>)[match[1].toLowerCase()];
        if (!ext) { return undefined; }
        const name = `${crypto.randomUUID()}.${ext}`;
        await fs.writeFile(nodePath.join(dir, name), Buffer.from(match[2], "base64"), { mode: 0o600 });
        out.push({ name, media_type: match[1].toLowerCase() });
      }
    } catch {
      return undefined;            // the inline path still works; a lost prompt would not be better
    }
    return out.length ? out : undefined;
  }

  private post(msg: any): void {
    if (["backend_exit", "cleared"].includes(msg?.type)) {
      this.settleGoalEdit("The backend stopped before confirming the goal edit. Check the saved goal before trying again.");
    }
    if (["backend_exit", "cleared"].includes(msg?.type)) this.pipsEditor?.offline();
    // A settings-side MCP write reports its progress to the settings tab, not into the chat. The
    // counter alone could not say WHICH webview started the command, and it is held across a
    // request that may take three minutes -- so a /mcp the user typed in chat during that window
    // was redirected too, and vanished: no bubble, no "Working with MCP...", no Stop, no output,
    // and no error either, because a timeout is reported as this same event and main.js discards a
    // result whose request id it never recorded. The id says who asked. sendManagedMcp mints
    // "mcp-config-" for an editor-managed write; the chat's own /mcp mints "mcp-command-".
    if (this.settingsMcpOperation && msg?.type === "mcp_command_started"
        && String(msg.requestId || "").startsWith("mcp-config-")) {
      this.settingsEditor?.webview.postMessage(msg);
      return;
    }
    if (process.env.DGC_EXTENSION_TEST_TOKEN) {
      const event = msg?.type === "event" && msg.event && typeof msg.event === "object"
        ? msg.event : undefined;
      this.testPostedMessages.push({
        type: String(msg?.type || ""),
        ...(["workspace_changes", "chat_changes"].includes(msg?.type) ? { fileCount: Array.isArray(msg.files) ? msg.files.length : 0 } : {}),
        ...(msg?.type === "attach" ? { label: String(msg.label || "").slice(0, 200) } : {}),
        ...(msg?.type === "state" ? { route: String(msg.state?.subscriptionEngine || "") } : {}),
        ...(event ? { eventType: String(event.type || ""),
          ...(event.id === undefined ? {} : { id: String(event.id) }),
          ...(event.command === undefined ? {} : { command: String(event.command) }),
          ...(event.type === "image" ? { id: String(event.request_id || "") } : {}),
          // What the status row says (e.g. a silent model request), for the installed-host stall test.
          ...(event.type === "turn_activity" ? { state: String(event.state || ""),
            label: String(event.label || "").slice(0, 80),
            detail: String(event.detail || "").slice(0, 120) } : {}),
          // A model retry run's frames, and the cause kind of a model error (installed-host reconnect test).
          ...(event.type === "model_retry" ? { state: String(event.state || ""), kind: String(event.kind || ""),
            attempt: Number(event.attempt) || 0, retryId: String(event.retry_id || "").slice(0, 128) } : {}),
          ...(event.type === "error" && event.cause && typeof event.cause === "object"
            ? { kind: String(event.cause.kind || ""), retryId: String(event.cause.retry_id || "").slice(0, 128) } : {}) } : {}),
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
    if (msg?.type === "agentsProbeRequest") {
      // Ask the live webview what the agents pill shows. The nonce marks the request as the
      // bridge's; only a reply carrying it is recorded (testOnlyWebviewReply).
      this.testProbeNonce = randomBytes(16).toString("hex");
      this.post({ type: "agentsProbe", probe: this.testProbeNonce });
      return;
    }
    await this.onMessage(msg);
  }

  /** The webview's answer to a bridge probe, recorded with the delivery evidence. False (and the
   * message goes on to onMessage) unless the test token is set and the reply carries the nonce. */
  private testOnlyWebviewReply(msg: any): boolean {
    if (!process.env.DGC_EXTENSION_TEST_TOKEN || msg?.type !== "agentsProbeResult") return false;
    if (!this.testProbeNonce || msg.probe !== this.testProbeNonce) return true;
    this.testProbeNonce = "";
    this.testPostedMessages.push({ type: "agentsProbeResult", state: msg.hidden ? "hidden" : String(msg.state || ""),
      label: String(msg.label || "").slice(0, 80) });
    return true;
  }

  testOnlyPostedMessages(token: string): Array<{ type: string; eventType?: string; id?: string; command?: string; fileCount?: number; state?: string; route?: string; label?: string; detail?: string; kind?: string; attempt?: number; retryId?: string }> {
    if (!token || token !== process.env.DGC_EXTENSION_TEST_TOKEN) {
      throw new Error("DGC extension test bridge is unavailable");
    }
    return this.testPostedMessages.map((item) => ({ ...item }));
  }
  private postState(): void {
    this.post({ type: "state", state: this.state });
    this.paintStatusBar();
  }

  // ---- webview -------------------------------------------------------------
  /**
   * The backend's stderr. It used to be posted to the webview, which has no handler for it, so
   * every Python traceback `dgc serve` ever wrote was dropped on the floor -- a backend could die
   * repeatedly and leave no evidence anywhere. It goes to an output channel now, where it persists
   * across restarts and can be copied into a bug report.
   */
  private readonly backendLog: vscode.OutputChannel;   // the side bar's; a tab writes to it too (constructor)
  /**
   * ...and to a file, because an output channel only reaches disk once somebody opens it. The
   * crash we needed evidence for happened while nobody was looking at one, which is the normal
   * case: a backend that dies unattended must still leave its traceback behind.
   */
  private backendLogFileCache: string | undefined;

  /** Views whose listeners are already wired; re-resolving one must not double-register them. */
  private readonly adoptedViews = new WeakSet<vscode.WebviewView>();

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
    // A replaced/adopted webview is a new control client. Retire all old reply
    // correlations and reject queued commands from the previous document.
    this.pipsDocumentId = randomBytes(16).toString("hex");
    this.pipsEditor?.attach(message => this.post(message));
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.file(join(dgcHome(), "plugins", "logos"))],
    };
    view.webview.html = this.html(view.webview);
    // VS Code keeps both copies alive (retainContextWhenHidden), and it does not resolve a view a
    // second time -- so the twin that was stamped with the "moved" notice would sit on that dead
    // end forever, even once the user came back to it and it was the only chat on screen. Adopt
    // whichever copy the user is actually looking at.
    if (!this.adoptedViews.has(view)) {
      this.adoptedViews.add(view);
      view.onDidChangeVisibility(() => {
        if (view.visible && this.view !== view) { this.resolveWebviewView(view); }
        if (this.view === view && this.pipsEditor) this.post({ type: "pipsVisibility", visible: view.visible });
      });
      view.onDidDispose(() => {
        // The user unchecked the view: the renderer is gone, the WINDOW is not, and closing the
        // view has never stopped the backend. Say which of the two it is, once. The backend gives
        // that claim a bounded extra wait before it hands the session to a window that is asking,
        // and nothing more -- a host cannot prove its window is still there.
        if (this.view === view) { this.webviewReady = false; }
        for (const be of this.liveBackends()) { be.editorState("host", "closed"); }
      });
      view.webview.onDidReceiveMessage((msg) => {
        if (this.view !== view) return;
        if (msg?.type === "editorAlive") { this.rendererAlive(); return; }
        if (this.testOnlyWebviewReply(msg)) return;
        void this.onMessage(msg).catch((err: any) => vscode.window.showErrorMessage(
          err?.message || "DGC could not process that editor request."));
      });
    }
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

  /** The chat webview says it is on screen. Every live backend hears it -- one panel serves all
   *  the chats, and a parked chat's child is judged by the same clock -- and none is STARTED by
   *  it. */
  private rendererAlive(): void {
    for (const be of this.liveBackends()) { be.editorState("renderer", "open"); }
  }

  /** Every `dgc serve` this panel currently owns: the active chat's and each parked chat's. */
  private liveBackends(): ChatBackend[] {
    const all: ChatBackend[] = this.backend ? [this.backend] : [];
    for (const slot of this.slots) {
      const parked = slot.backend || (slot.saved?.backend as ChatBackend | undefined);
      if (parked && !all.includes(parked)) { all.push(parked); }
    }
    return all;
  }

  focus(): void {
    if (this.tab) { this.view?.show?.(false); return; }      // an editor tab: bring it forward
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

  /** A Pip's run, asked about from its own chat: this chat sends the Work chat card's prompt when it is ready. */
  askFromPips(report: unknown): void {
    this.inVisiblePanel(() => this.post({ type: "pipAskDgc", report }));
  }

  /** A fix this chat ran, opened from its run's post on the Pips page: the chat shows its card once it is drawn. */
  showPipFix(runId: string): void {
    this.inVisiblePanel(() => this.post({ type: "pipShowFix", run_id: runId }));
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

  private promptPipRequests = new Map<string, {backend: ChatBackend; session: string; generation: number}>();
  private async onMessage(msg: any): Promise<void> {
    if (this.sessionElsewhere && WORK_READ_ONLY_REFUSES.has(String(msg?.type || ""))) {
      // Read-only while the session is open in another window: the page offers none of these then, and nothing here
      // changes a session another window holds. The page is shown read-only again, in case it lost track.
      this.post({ type: "session_elsewhere", ...this.sessionElsewhere });
      return;
    }
    const be = this.ensureBackend();
    switch (msg.type) {
      case "list_prompt_pips": {
        const id = typeof msg.request_id === "string" ? msg.request_id : "";
        const fail = (message: string) => this.post({type:"event",event:{type:"command_rejected",command:"list_prompt_pips",request_id:id,message}});
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || /[\r\n]/.test(id)) return;
        if (this.lastReadyEvent?.capabilities?.pip_references !== 1) { fail("Update or reconnect DGC to use Pip references."); return; }
        if (Object.keys(msg).some(k => !["type","request_id","query","after","limit"].includes(k))
          || msg.query !== undefined && (typeof msg.query !== "string" || Buffer.byteLength(msg.query,"utf8") > 128)
          || msg.after !== undefined && (typeof msg.after !== "string" || !msg.after || msg.after.length > 256 || /[\u0000-\u001f\u007f]/.test(msg.after))
          || msg.limit !== undefined && (!Number.isSafeInteger(msg.limit) || msg.limit < 1 || msg.limit > 20)) { fail("Invalid Pip reference search."); return; }
        if (this.promptPipRequests.size >= 32) this.promptPipRequests.delete(this.promptPipRequests.keys().next().value!);
        this.promptPipRequests.set(id,{backend:be,session:this.currentSessionId,generation:this.sessionHandshakeGeneration});
        if (!be.send({...msg} as any)) { this.promptPipRequests.delete(id);fail("DGC could not search this chat’s Pips."); }
        return;
      }
      case "micStart":
      case "micStop":
      case "micCancel":
      case "voiceCheck": {
        // The chat's box, or the Pips box beside it in the side bar: the page says which.
        const owner = msg.from === "pips" && !this.tab ? this.micPips : this.micChat;
        await this.dictationService().handle(owner, msg);
        return;
      }
      case "speakStart":
      case "speakStop": {
        const owner = msg.from === "pips" && !this.tab ? this.micPips : this.micChat;
        await this.readAloudService().handle(owner, msg);
        return;
      }
      case "pipAskDgc": {
        // Ask DGC to fix, from a Pip's own chat (Pips API 51). The side bar's Sessions home has no chat: the chat the
        // Pip reports to opens in its tab (a new one when it has none) and sends the Work chat card's prompt, once.
        if (!this.home || !this.places) return;
        const report = msg.report;
        if (!report || typeof report !== "object" || !/^run_[0-9a-f]{32}$/.test(String(report.run_id || ""))) return;
        const session = /^[A-Za-z0-9_-]{1,128}$/.test(String(msg.session || "")) ? String(msg.session) : "";
        this.places.open(session).askFromPips(report);
        return;
      }
      case "pipOpenFix": {
        // What a fix did, from a run's post on the Pips page (Pips API 65): the chat it ran in opens in its tab and shows
        // the fix's card, where Review, Undo, Watch and Stop are. From the Sessions home, or from another session's tab.
        const places = this.tab?.places ?? this.places;
        if (!places || !/^run_[0-9a-f]{32}$/.test(String(msg.run_id || ""))) return;
        const session = /^[A-Za-z0-9_-]{1,128}$/.test(String(msg.session || "")) ? String(msg.session) : "";
        if (session) places.open(session).showPipFix(String(msg.run_id));
        return;
      }
      case "pipsReady":
      case "pipsReconnect":
      case "pipsRequest":
      case "pipsOpenComputer":
      case "pipsOpenPhoto":
      case "pipsPluginLogos":
        if (msg.documentId !== this.pipsDocumentId) return;
        this.ensurePipsBridge().receive(msg);
        return;
      case "webviewReady": {
        this.webviewReady = true;
        // The home's chats, asked for now its page can hear the answer (one that came before was dropped).
        if (this.home) this.chatdgc?.homeRefresh();
        // A reloaded page: a recording its boxes started went with the page that showed it.
        this.dictationService().release(this.micChat);
        this.readAloudService().release(this.micChat);
        if (!this.tab) { this.dictationService().release(this.micPips); this.readAloudService().release(this.micPips); }
        this.repaintFromBackend();
        const actions = this.pendingWebviewActions.splice(0);
        for (const action of actions) { action(); }
        if (this.state.model) { this.postState(); }
        this.postChatSlots();
        this.scheduleWorkspaceChanges(0);
        if (this.home) { void this.postSessions(); }
        break;
      }
      case "switchChat": {
        this.switchToSlot(String(msg.slotId ?? ""));
        return;
      }
      case "newChat": {
        // With sessions in tabs, + is a new session in a tab of its own.
        const places = this.tab?.places ?? this.places;
        if (places) { places.open(""); return; }
        this.openChatSlot();
        return;
      }
      case "sessionsList":
        if (this.home) { void this.postSessions(); this.chatdgc?.homeRefresh(); }
        return;
      case "chatdgcOpen": case "chatdgcNew": case "chatdgcSearch": case "chatdgcMore": case "chatdgcDelete":
      case "chatdgcProjectOpen": case "chatdgcProjectNew": case "chatdgcProjectChats": case "chatdgcMove": case "chatdgcLibrary":
        if (this.home && this.chatdgc) { await this.chatdgc.homeMessage(msg); }
        return;
      case "openSessionInEditor":
        this.openSessionInEditor(String(msg.id ?? ""), String(msg.title ?? ""));
        return;
      case "newSessionInEditor":
        (this.tab?.places ?? this.places)?.open("");
        return;
      case "deleteSession":
        if (this.home) { await this.deleteSessionFromHome(String(msg.id ?? ""), String(msg.title ?? "")); }
        return;
      case "sessionsSearch":
        if (this.home) {
          this.sessionsQuery = String(msg.query ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
          this.sessionsShown = 200;
          void this.postSessions();
        }
        return;
      case "sessionsMore":
        if (this.home) { this.sessionsShown = Math.min(this.sessionsShown + 200, 4800); void this.postSessions(); }
        return;
      case "newChatInFolder": {
        void this.newChatInFolder();
        return;
      }
      case "closeChat": {
        this.closeChatSlot(String(msg.slotId ?? ""));
        return;
      }
      case "moveChat": {
        this.moveChatSlot(String(msg.slotId ?? ""), Number(msg.toIndex));
        return;
      }
      case "pickChat": {
        void this.pickChat();
        return;
      }
      case "askSkip": {
        // Waving a question away is an answer of a kind: the backend tells the model to decide
        // and say what it assumed, rather than leaving it waiting.
        const askId = String(msg.askId ?? "");
        if (askId && this.lastReadyEvent?.capabilities?.open_asks) {
          this.backend?.send({ type: "ask_skip", ask_id: askId });
        }
        return;
      }
      case "prompt": {
        let text = String(msg.text ?? "");
        let pipReferences: any[] | undefined;
        if (msg.pip_references !== undefined) {
          try {
            if (this.lastReadyEvent?.capabilities?.pip_references !== 1) throw new Error("Update or reconnect DGC to send Pip references. Your draft is saved.");
            pipReferences = checkedPromptPipReferences(msg.pip_references);
            if (!text.trim()) throw new Error("Write a message to send with the Pip reference.");
          } catch (error: any) { this.post({type:"event",event:{type:"error",message:error.message}});this.post({type:"prompt_rejected",requestId:msg.requestId});return; }
        }
        const referenceSession = this.currentSessionId, referenceGeneration = this.sessionHandshakeGeneration;
        const answers = (Array.isArray(msg.answers) ? msg.answers : [])
          .filter((a: any) => a && typeof a === "object" && typeof a.ask_id === "string")
          .slice(0, 4)
          .map((a: any) => ({ ask_id: String(a.ask_id), question: String(a.question ?? "") }));
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
        const live = workflow || (text && !isSlashCommandText(text)) ? this.editorContext() : [];
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
        // Out-of-band images: write them into the directory the backend named, and send the file
        // names. The 4 MiB command frame no longer has to carry them, which is what forced the
        // editor's 2 MiB total and its 4-image count limit in the first place. A backend that does
        // not offer the capability is sent base64 exactly as before.
        const spooled = await this.spoolImages(msg.images);
        if (pipReferences && (this.backend !== be || this.currentSessionId !== referenceSession || this.sessionHandshakeGeneration !== referenceGeneration)) {
          this.post({type:"prompt_rejected",requestId:msg.requestId});return;
        }
        const accepted = be.send({ type: "prompt", text,
                                   images: spooled ? undefined : msg.images,
                                   ...(spooled ? { spooled_images: spooled } : {}),
                                   request_id: requestId,
                                   ...(pipReferences ? {pip_references:pipReferences} : {}),
                                   context: [...attached, ...live].slice(0, 64), ...selections,
                                   ...(this.lastReadyEvent?.capabilities?.live_steering
                                     ? { delivery: msg.delivery === "queue" ? "queue" : "steer" } : {}),
                                   ...(workflow ? { workflow: workflow as "plan" | "review" | "init" } : {}),
                                   // A reply to open questions says which ones it answers. Without
                                   // the tag this is an ordinary message, and the backend treats it
                                   // as one -- a follow-up typed while a question is open must
                                   // never be recorded as its answer.
                                   ...(answers.length && this.lastReadyEvent?.capabilities?.open_asks
                                     ? { answers } : {}) });
        if (!accepted) {
          this.post({ type: "prompt_rejected", requestId });
        } else {
          // Close the small command/turn_start race so a simultaneous folder removal
          // cannot send a mutation that the backend must reject as newly busy.
          this.turnActive = true;
          this.trackPrompt(requestId, String(msg.text ?? ""), msg.restore, msg.images);
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
            this.openDecisions.delete(String(msg.id ?? ""));
            this.postChatSlots();
            break;
          }
        }
        be.send({ type: "plan_response", id: msg.id, decision: msg.decision,
                  feedback: msg.feedback });
        // `plan_response` is a COMMAND, and the CLI emits no matching event — so nothing else ever
        // clears this id. Left in, an accepted plan kept the chat flagged "waiting for you" for
        // the whole rest of a turn that was, in fact, working.
        this.openDecisions.delete(String(msg.id ?? ""));
        this.postChatSlots();
        break;
      case "options_response":
        // v14: the question card's answers ({question_id: {selected, other}}) or a dismissal.
        be.send({ type: "options_response", id: msg.id,
          ...(msg.dismissed === true ? { dismissed: true } : { answers: msg.answers }) });
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
      case "resumeTurn":
        this.continueInterruptedTurn();
        break;
      case "openSessionHere":
        this.openSessionHere();
        break;
      case "clear_todos":
        // The backend empties the list at once, even while a turn runs, and answers with an empty
        // `todos` event; that is what hides the Tasks row. An older CLI that still refuses mid-turn
        // answers with command_rejected (command "clear_todos"), which the webview shows beside
        // the row. Correlated when the backend supports it, so the answer can be traced.
        be.send(this.stateCommand("clear-todos", { type: "clear_todos" }));
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
      case "contextBreakdown":            // the context menu opened (or the window changed while it's open)
        void this.contextBreakdown();
        break;
      case "setContextSize":
        await this.setContextSize(Number(msg.size));
        break;
      case "openPips": this.openPips(); return;
      case "openSettings":
        // The header gear. It opens the standalone Settings tab beside the chat.
        this.openSettings(typeof msg.section === "string" ? msg.section : "general");
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
      case "getOutline": {
        // Every prompt of the session, for the prompt rail; the answer (`outline`) carries the webview's token back.
        // Only to a CLI that offers it: an older one would reject the command.
        const be = this.backend, token = typeof msg.token === "number" ? msg.token : NaN;
        if (be && (this.lastReadyEvent?.capabilities as any)?.outline >= 1 && Number.isSafeInteger(token) && token > 0) {
          be.send({ type: "get_outline", request_id: `outline-${token}` });
        }
        break;
      }
      case "reqFiles":
        this.sendFiles();
        break;
      case "openFile":
        await this.openFile(msg.path, msg.line);
        break;
      case "openTroupeJournal":
        await this.openTroupeJournal(String(msg.runId || ""));
        break;
      case "saveImage":
        await this.saveImage(String(msg.name || "image.png"), String(msg.data || ""));
        break;
      case "getImage": {
        const requestId = String(msg.requestId || "");
        const ref = typeof msg.ref === "string" ? msg.ref : "";
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) { break; }
        if (this.lastReadyEvent?.capabilities?.image_views !== true || !DgcViewProvider.IMAGE_REF.test(ref)) {
          // A backend without image views (or a ref this panel never saw) cannot answer: answer for it.
          this.post({ type: "event", event: { type: "image", request_id: requestId, ref, image: "",
            reason: DgcViewProvider.IMAGE_REF.test(ref) ? "unreadable" : "invalid_ref" } });
          break;
        }
        be.send({ type: "get_image", request_id: requestId, ref });
        break;
      }
      case "openImage":
        await this.openImage(msg.ref);
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
      case "requestPlugins":
        this.sendPluginCommand({ type: "list_plugins", request_id: this.nextRequestId("plugins") });
        break;
      case "installPlugin":
        this.openEditorSettings("plugins");
        break;
      case "openPluginBrowser":
        this.openEditorSettings("plugins");
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
      case "memoryForgetFact": {
        // Forget on a "Remembered" line: the one memory every DGC surface shares.
        const id = typeof msg.id === "string" && /^mem_[0-9a-f]{12}$/.test(msg.id) ? msg.id : "";
        if (id) be.send({ type: "memory_forget", request_id: this.nextRequestId("memory-forget"), id });
        break;
      }
      case "learnSave": {
        // /learn's Save: the skill as shown (maybe edited) is written now, and not before.
        const markdown = typeof msg.markdown === "string" ? msg.markdown.slice(0, 65536) : "";
        const scope = msg.scope === "project" ? "project" : "user";
        if (markdown.trim()) be.send({ type: "save_skill", request_id: String(msg.requestId || this.nextRequestId("learn-save")).slice(0, 128), markdown, scope });
        break;
      }
      case "listArtifacts":
        be.send(this.stateCommand("artifacts", { type: "list_artifacts" }));
        break;
      case "stopArtifact":
        void this.stopArtifact(String(msg.id || ""));
        break;
      case "restartMonitor":
        this.restartMonitor(String(msg.key || ""));
        break;
      case "rerunTask":
        this.rerunTask(String(msg.key || ""), msg.how === "resume" ? "resume" : "again");
        break;
      case "stopMonitor":
        void this.stopMonitor(String(msg.id || ""));
        break;
      case "pipReportsWatch":
        // The panel draws Pip reports (ready.capabilities.pip_reports): this chat's start arriving.
        if (this.lastReadyEvent?.capabilities?.pip_reports === 1) { be.send({ type: "watch_pip_reports" }); }
        break;
      case "pipRunsWatch":
        // The chip above the box (ready.capabilities.pip_runs_running): which of this chat's Pips are running.
        if ((this.lastReadyEvent?.capabilities as any)?.pip_runs_running === 1) { be.send({ type: "watch_pip_runs" }); }
        break;
      case "steerQueued": {
        // "Steer now" / "Steer all" on queued messages (ready.capabilities.steer_queued): they move into the running
        // turn as steering; the backend answers with prompt_accepted "steered" for each, or a command_rejected.
        const ids = Array.isArray(msg.request_ids) ? msg.request_ids.filter((i: unknown) => typeof i === "string" && i.length > 0 && i.length <= 200).slice(0, 16) : [];
        if (this.lastReadyEvent?.capabilities?.steer_queued === true && ids.length) be.send({ type: "steer_queued", request_ids: ids });
        break;
      }
      case "pipReportDismiss":
        // A Pip report's card in this chat's transcript (ready.capabilities.pip_reports): the panel
        // has already removed it; the backend saves that with the chat.
        if (this.lastReadyEvent?.capabilities?.pip_reports === 1 && /^run_[0-9a-f]{32}$/.test(String(msg.run_id || ""))) {
          be.send({ type: "pip_report_dismiss", run_id: String(msg.run_id) });
        }
        break;
      // Ask DGC to fix in the background (ready.capabilities.pip_fix): the card is the fix's status.
      case "startPipFix":
        if (this.pipFixLive() && /^run_[0-9a-f]{32}$/.test(String(msg.run_id || ""))) {
          be.send({ type: "start_pip_fix", run_id: String(msg.run_id), request_id: this.nextRequestId("pip-fix") });
        }
        break;
      case "listPipFixes":
        if (this.pipFixLive()) be.send({ type: "list_pip_fixes", request_id: this.nextRequestId("pip-fixes") });
        break;
      case "undoPipFix":
        void this.undoPipFix(String(msg.fix_id || ""), Number(msg.files) || 0);
        break;
      case "reviewPipFix":
        void this.reviewPipFix(String(msg.fix_id || ""),
          Array.isArray(msg.paths) ? msg.paths.filter((p: unknown) => typeof p === "string" && p.length > 0 && p.length <= 4096).slice(0, 50) : []);
        break;
      case "stopTroupe":
        void this.stopTroupe(String(msg.run_id || ""));
        break;
      case "stopAgent":
        void this.stopAgent(String(msg.id || ""));
        break;
      case "listBackgroundShells":
        if (this.backgroundTasks()) {
          be.send({ type: "list_background_shells", request_id: this.nextRequestId("shells-list") } as any);
        }
        break;
      case "stopBackgroundShell":
        void this.stopBackgroundShell(String(msg.id || ""));
        break;
      case "getBackgroundOutput":
        void this.getBackgroundOutput(String(msg.id || ""));
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

  // ---- 0.40 images -------------------------------------------------------------------------------
  private static readonly IMAGE_REF = /^img_[0-9a-f]{32}$/;

  private rememberImageRef(ref: unknown): void {
    if (typeof ref !== "string" || !DgcViewProvider.IMAGE_REF.test(ref) || this.imageRefs.has(ref)) { return; }
    if (this.imageRefs.size >= 1024) { this.imageRefs.delete(this.imageRefs.keys().next().value as string); }
    this.imageRefs.set(ref, {});
  }

  /** Tracks refs and stored paths; true when ``ev`` answered an Open file request (consumed here). */
  private noteImageEvent(ev: DgcEvent): boolean {
    const itemsOf = (event: any) => (event?.type === "tool_images" && Array.isArray(event.items) ? event.items : []);
    if (ev.type === "tool_images") {
      for (const item of itemsOf(ev)) { this.rememberImageRef(item?.ref); }
    } else if (ev.type === "history" && Array.isArray(ev.items)) {
      for (const event of ev.items) { for (const item of itemsOf(event)) { this.rememberImageRef(item?.ref); } }
    } else if (ev.type === "session" && ["new", "cleared", "resumed"].includes(String(ev.kind))) {
      this.imageRefs.clear();
    } else if (ev.type === "image") {
      const ref = String(ev.ref || "");
      const stored = typeof ev.path === "string" && isAbsolute(ev.path) ? ev.path : undefined;
      const known = this.imageRefs.get(ref);
      if (known && stored) { known.path = stored; }
      const waiter = this.imageOpenWaiters.get(String(ev.request_id));
      if (waiter) {
        this.imageOpenWaiters.delete(String(ev.request_id));
        waiter(known ? stored : undefined);
        return true;
      }
    }
    return false;
  }

  /** The stored file behind a ref, only if it is a regular image file inside DGC's own image
   * stores: a session's `.images` sidecar under ~/.dgc/sessions, or a workspace's `.dgc/screenshots`. */
  private async allowedImageFile(candidate: string | undefined): Promise<string | undefined> {
    if (!candidate || !isAbsolute(candidate)) { return undefined; }
    try {
      const info = await fs.promises.lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink()) { return undefined; }
      const real = await realpath(candidate);
      const folder = path.dirname(real);
      const inside = async (root: string) => {
        try {
          const base = await realpath(root);
          return folder === base || folder.startsWith(base + sep);
        } catch { return false; }
      };
      const sessions = join(dgcHome(), "sessions");
      const inSessionStore = folder.endsWith(".images") && await inside(sessions);
      let inScreenshots = false;
      for (const root of this.workspaceRoots()) {
        try { if (folder === await realpath(join(root, ".dgc", "screenshots"))) { inScreenshots = true; break; } } catch { /* absent */ }
      }
      if (!inSessionStore && !inScreenshots) { return undefined; }
      const handle = await fs.promises.open(real, "r");
      try {
        const head = Buffer.alloc(16);
        const { bytesRead } = await handle.read(head, 0, 16, 0);
        const bytes = head.subarray(0, bytesRead);
        const magic = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
          || bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a"
          || (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP")
          || bytes.subarray(0, 2).toString("latin1") === "BM";
        return magic ? real : undefined;
      } finally { await handle.close(); }
    } catch {
      return undefined;
    }
  }

  private async openImage(ref: unknown): Promise<void> {
    const unavailable = () => void vscode.window.showInformationMessage("That image is no longer available.");
    if (typeof ref !== "string" || !DgcViewProvider.IMAGE_REF.test(ref) || !this.imageRefs.has(ref)) { unavailable(); return; }
    let stored = this.imageRefs.get(ref)?.path;
    const be = this.backend;
    if (!stored && be && this.lastReadyEvent?.capabilities?.image_views === true) {
      const requestId = this.nextRequestId("open-image");
      stored = await new Promise<string | undefined>((done) => {
        const timer = setTimeout(() => { this.imageOpenWaiters.delete(requestId); done(undefined); }, 30_000);
        this.imageOpenWaiters.set(requestId, (value) => { clearTimeout(timer); done(value); });
        be.send({ type: "get_image", request_id: requestId, ref });
      });
    }
    const target = await this.allowedImageFile(stored);
    if (!target) { unavailable(); return; }
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(target), { preview: true });
  }
  // ---- end 0.40 images ---------------------------------------------------------------------------

  // A webview cannot write to disk, so saving an image the panel is showing has to come back
  // here. The reader picks the destination: nothing is written anywhere without a dialog, and the
  // bytes never leave the machine. Only the inline image types the panel renders are accepted, so
  // a crafted `data:` URI cannot smuggle a script or an executable through the save dialog.
  private async saveImage(name: string, data: string): Promise<void> {
    const match = /^data:image\/(png|jpeg|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!match) {
      void vscode.window.showWarningMessage("DGC can only save an image it is displaying.");
      return;
    }
    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    const safe = (name.split(/[\\/]/).pop() || "image").replace(/[^\w.-]+/g, "-").slice(0, 80);
    const stem = safe.replace(/\.[^.]*$/, "") || "image";
    const target = await vscode.window.showSaveDialog({
      title: "Save image",
      filters: { Images: [ext] },
      defaultUri: vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()),
        `${stem}.${ext}`),
    });
    if (!target) return;                       // cancelled: say nothing, write nothing
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(match[2], "base64"));
    } catch (err) {
      void vscode.window.showErrorMessage(`DGC could not save the image: ${String(err)}`);
    }
  }

  private async openFile(path: string, line?: number): Promise<void> {
    // A path DGC (or its model) wrote in its own Linux names, under hidden WSL: the file as Windows names it.
    const target = await workspaceFile(typeof path === "string" ? editorPath(path) : path, this.workspaceRoots());
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
      // openTextDocument REFUSES a binary file, and this catch used to swallow that as "may not
      // exist" -- so clicking a produced PNG chip did nothing at all, with no error and no hint.
      // `vscode.open` routes to whatever editor owns the type: the image preview for a PNG, the
      // PDF viewer for a PDF, a text editor for text. Only reached when the text path failed, so
      // a line number was never going to apply anyway.
      try {
        await vscode.commands.executeCommand("vscode.open", uri);
        return;
      } catch {
        void vscode.window.showInformationMessage(
          `VS Code has no editor for ${vscode.workspace.asRelativePath(uri)}. Reveal it in the explorer to open it another way.`);
        return;
      }
    }
  }

  /** A troupe's journal, from its popover's "Open the journal". The webview names only the run; the path is
   *  this side's: ~/.dgc/troupes/<run id>, its report once the run has ended, else what it has written so far. */
  private async openTroupeJournal(runId: string): Promise<void> {
    if (!/^tr-[0-9a-f]{10}$/.test(runId)) { return; }
    const root = join(dgcHome(), "troupes");
    let base = "";
    try { base = await realpath(root); } catch { /* no troupe has run on this computer */ }
    for (const name of ["report.md", "results.jsonl", "plan.json"]) {
      if (!base) { break; }
      try {
        const real = await realpath(join(root, runId, name));
        if (!real.startsWith(base + sep) || !(await fs.promises.stat(real)).isFile()) { continue; }
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(real));
        return;
      } catch { /* not written yet: the next one */ }
    }
    void vscode.window.showInformationMessage("This troupe's journal is not on this computer.");
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
                  args, envNames, logLevel,
                  ...(item.transport === "remote" && validOauth(item.oauth) ? { oauth: { clientId: item.oauth.clientId, port: item.oauth.port } } : {}),
                  ...(item.connector && APP_CONNECTORS[item.connector] && item.name === item.connector
                    ? { connector: item.connector, connectorLicense: String(item.connectorLicense || "") } : {}) });
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

  // Your own OAuth app: DGC's remote client reads its client id and secret from an owner-only file (never from
  // argv, where other local users could see a secret) and listens for the sign-in on the fixed port the
  // app registered: http://localhost:<port>/oauth/callback (http://127.0.0.1:<port>/... for Zoom).
  // One file per server name AND content: a save the backend rejects never rewrites the file the
  // server already uses, and "Asana" and "asana" never share one on a case-blind disk.
  private oauthAppPrefix(name: string): string {
    return join(dgcHome(), "mcp-oauth",
      `${name.toLowerCase().replace(/[^a-z0-9_.-]/g, "_")}-${createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8)}-`);
  }

  private oauthAppBody(item: ManagedMcpServer, secrets: ManagedMcpSecrets): string | undefined {
    if (item.transport !== "remote" || !validOauth(item.oauth)) return undefined;
    // A guided own app (a connector) is the app its setup had you register: its loopback address (Zoom takes only
    // 127.0.0.1), never a secret for a public client (Zoom), and, where you added the scopes to the app yourself, an
    // empty scope: DGC asks for none and the app's own scopes decide.
    const own = item.connector && item.name === item.connector ? APP_CONNECTORS[item.connector]?.own_app : undefined;
    return JSON.stringify({ client_id: item.oauth.clientId,
      ...(secrets.oauthSecret && !(own && !own.secret_label) ? { client_secret: secrets.oauthSecret } : {}),
      redirect_uris: [ownAppRedirect({ port: item.oauth.port, redirect_host: own?.redirect_host })],
      ...(own?.scopes ? { scope: "" } : {}) });
  }

  private oauthAppFile(item: ManagedMcpServer, secrets: ManagedMcpSecrets): string | undefined {
    const body = this.oauthAppBody(item, secrets);
    return body === undefined ? undefined
      : `${this.oauthAppPrefix(item.name)}${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16)}.json`;
  }

  private oauthAppArgs(item: ManagedMcpServer, secrets: ManagedMcpSecrets): string[] {
    const file = this.oauthAppFile(item, secrets), body = this.oauthAppBody(item, secrets);
    if (!file || body === undefined || !item.oauth) return [];
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, body, { mode: 0o600 });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
    // DGC's remote client runs in `dgc serve`: under hidden WSL it reads the file by its path in the distro.
    return [String(item.oauth.port), "--static-oauth-client-info", `@${backendPath(file)}`];
  }

  /** Remove a server's own-app files, keeping `keep` (the one it uses now), if any. */
  private pruneOauthFiles(name: string, keep?: string): void {
    const prefix = this.oauthAppPrefix(name);
    let entries: string[] = [];
    try { entries = fs.readdirSync(path.dirname(prefix)); } catch { return; }
    for (const entry of entries) {
      const full = join(path.dirname(prefix), entry);
      if (full.startsWith(prefix) && full !== keep) fs.rmSync(full, { force: true });
    }
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
    const oauthSecret = typeof value.oauth_secret === "string" && value.oauth_secret.length <= 1024
      && !/[\s\0]/.test(value.oauth_secret) ? value.oauth_secret : "";
    return { env, token, ...(oauthSecret ? { oauthSecret } : {}) };
  }

  private async storeMcpSecrets(item: ManagedMcpServer, value: ManagedMcpSecrets): Promise<void> {
    const env = value.env && typeof value.env === "object" ? value.env : {};
    if (!Object.keys(env).length && !value.token && !value.oauthSecret) {
      await this.context.secrets.delete(this.mcpSecretKey(item.name));
      return;
    }
    await this.context.secrets.store(this.mcpSecretKey(item.name), JSON.stringify({
      identity: managedMcpIdentity(item), env, token: value.token || "",
      ...(value.oauthSecret ? { oauth_secret: value.oauthSecret } : {}),
    }));
  }

  private async restoreRawMcpSecret(name: string, value: string | undefined): Promise<void> {
    const key = this.mcpSecretKey(name);
    if (value === undefined) { await this.context.secrets.delete(key); }
    else { await this.context.secrets.store(key, value); }
  }

  private async removeManagedMcpBackend(be: ChatBackend, name: string, prefix: string): Promise<void> {
    const event = await this.requestState(be, prefix, {
      type: "remove_mcp_server", name,
    }, "mcp_servers", 10000);
    if ((event as any).error) { throw new Error(String((event as any).error)); }
  }

  private async sendManagedMcp(be: ChatBackend, item: ManagedMcpServer,
                               setup = false, suppliedSecrets?: ManagedMcpSecrets,
                               waitForAck = false): Promise<boolean> {
    if (item.connector && this.lastReadyEvent?.capabilities?.app_connectors !== true) {
      const message = "This CLI does not include app connectors. Select the local connector build and run DGC: Restart Backend.";
      this.settingsEditor?.webview.postMessage({type: "pluginOperationError", message});
      // Finish the normal handshake without replaying private fields or tokens to a release CLI.
      if (setup) return true;
      throw new Error(message);
    }
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
      ? ["-y", "mcp-remote", item.target, ...this.oauthAppArgs(item, secrets)]
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
      ...(item.connector ? { connector: item.connector, accept_license: item.connectorLicense || "" } : {}),
      runtime: { ...common, args: runtimeArgs, env }, persisted: { ...common, args: baseArgs },
    };
    if (setup) { return be.sendSetup(command); }
    if (this.mcpManagement) {
      command.interactive = true;
      this.post({ type: "mcp_command_started", requestId: command.request_id, view: "servers" });
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

  private async requestMcpContext(be: ChatBackend, msg: any, listing: boolean): Promise<void> {
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

  private async saveMcpServer(values: any, connector?: {id: string; license: string}): Promise<boolean> {
    const name = String(values.name || "").trim();
    const original = String(values.original_name || name).trim();
    const transport = values.transport === "remote" ? "remote" : "stdio";
    let target = String(values.target || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      void vscode.window.showErrorMessage("MCP server names use 1–64 letters, digits, dots, underscores, or hyphens.");
      return false;
    }
    if (!target || target.length > 4096 || target.includes("\0")) {
      void vscode.window.showErrorMessage(transport === "remote" ? "Enter a valid MCP URL." : "Enter an MCP command path.");
      return false;
    }
    if (transport === "remote") {
      const remote = normalizedRemoteMcpUrl(target);
      if (!remote) {
        void vscode.window.showErrorMessage(
          "Remote MCP URLs must use HTTPS (or loopback HTTP) without embedded credentials.");
        return false;
      }
      target = remote;
    }
    const logLevel = String(values.log_level || "warning").toLowerCase();
    if (!["debug", "info", "notice", "warning", "error", "critical", "alert",
      "emergency", "off"].includes(logLevel)) {
      void vscode.window.showErrorMessage("Choose a supported MCP log level.");
      return false;
    }
    const existingManaged = this.managedMcpServers();
    if (!existingManaged.some((item) => item.name === original) && existingManaged.length >= 64) {
      void vscode.window.showErrorMessage("At most 64 editor-managed MCP servers are supported.");
      return false;
    }
    const args = String(values.args || "").split(/\r?\n/).map((line) => line.trim())
      .filter(Boolean).slice(0, 128);
    if (args.some((arg) => arg.length > 8192 || arg.includes("\0"))) {
      void vscode.window.showErrorMessage("Each MCP argument must be a bounded single line.");
      return false;
    }
    if (transport === "stdio" && !persistedMcpArgsSafe(args)) {
      void vscode.window.showErrorMessage(
        "Store MCP credentials as environment entries so DGC can keep them in SecretStorage.");
      return false;
    }
    const clearSecrets = values.clear_secrets === true;
    const previous = existingManaged.find((entry) => entry.name === original);
    const previousAtDestination = existingManaged.find((entry) => entry.name === name);
    if (original !== name && previousAtDestination) {
      void vscode.window.showErrorMessage(
        `An editor-managed MCP server named “${name}” already exists. Choose another name.`);
      return false;
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
      return false;
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
          return false;
        }
        if (at < 0) { referencedEnvNames.push(key); } else { env[key] = value; }
      }
    }
    const tokenInput = String(values.token || "");
    const secrets: ManagedMcpSecrets = {
      env, token: transport === "remote" ? (tokenInput || savedSecrets.token || "") : "",
    };
    // Your own OAuth app (remote only): a client id and the fixed port registered at the vendor; the
    // secret is optional (a public client), and blank keeps the saved one for the same client id.
    let oauth: { clientId: string; port: number } | undefined;
    const clientId = String(values.oauth_client_id || "").trim();
    if (transport === "remote" && clientId) {
      const port = Number(String(values.oauth_port || "").trim());
      oauth = { clientId, port };
      if (!validOauth(oauth)) {
        void vscode.window.showErrorMessage(
          "Your own OAuth app needs its client ID (letters, digits and . _ : @ / + = -) and a callback port from 1024 to 65535.");
        return false;
      }
      const secretInput = String(values.oauth_client_secret || "").trim();
      if (secretInput.length > 1024 || /[\s\0]/.test(secretInput)) {
        void vscode.window.showErrorMessage("Paste the client secret as one line.");
        return false;
      }
      const sameClient = previous?.oauth?.clientId === clientId;
      // Only across the same server URL and client: savedSecrets is empty when either changed.
      const kept = sameClient ? savedSecrets.oauthSecret || "" : "";
      if (secretInput || kept) secrets.oauthSecret = secretInput || kept;
    }
    const declaredEnvNames = [...new Set([...referencedEnvNames, ...Object.keys(env)])].slice(0, 64);
    if (transport === "stdio") {
      secrets.env = Object.fromEntries(
        Object.entries(env).filter(([key]) => declaredEnvNames.includes(key)));
    }
    const item: ManagedMcpServer = {
      name, transport, target, args: transport === "stdio" ? args : [],
      envNames: declaredEnvNames, logLevel, ...(oauth ? { oauth } : {}),
      ...(connector ? {connector: connector.id, connectorLicense: connector.license} : previous?.connector ? {connector: previous.connector, connectorLicense: previous.connectorLicense} : {}),
    };
    const be = this.ensureBackend();
    try {
      await this.sendManagedMcp(be, item, false, secrets, true);
    } catch (err: any) {
      const attempted = this.oauthAppFile(item, secrets);
      const inUse = previousAtDestination ? this.oauthAppFile(previousAtDestination, destinationSecrets) : undefined;
      if (attempted && attempted !== inUse) fs.rmSync(attempted, { force: true });   // a rejected save leaves no secret behind
      void vscode.window.showErrorMessage(err?.message || "DGC rejected that MCP server.");
      return false;
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
        return false;
      }
    }
    try {
      await this.context.globalState.update("dgc.managedMcpServers.v1", managed.slice(0, 64));
      await this.storeMcpSecrets(item, secrets);
      if (original !== name) { await this.context.secrets.delete(this.mcpSecretKey(original)); }
      // Its own app's file is the one now in use, or none; a renamed server's old files go.
      this.pruneOauthFiles(name, this.oauthAppFile(item, secrets));
      if (original !== name) this.pruneOauthFiles(original);
      this.settingsEditor?.webview.postMessage({ type: "mcpSaved", ok: true });
      return true;
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
    return false;
  }

  private async clearUninstalledPluginServers(names: string[]): Promise<void> {
    const removed = new Set(names.filter(name => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)));
    const managed = this.managedMcpServers();
    await this.context.globalState.update("dgc.managedMcpServers.v1", managed.filter(row => !removed.has(row.name)));
    for (const name of removed) { await this.context.secrets.delete(this.mcpSecretKey(name)); this.pruneOauthFiles(name); }
  }

  private async removeMcpServer(name: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) { return; }
    const confirm = await vscode.window.showWarningMessage(
      `Remove MCP server “${name}”?`, { modal: true }, "Remove server");
    if (confirm !== "Remove server") { return; }
    const existingManaged = this.managedMcpServers();
    const previous = existingManaged.find((item) => item.name === name);
    if (!previous) {
      // Servers configured by the CLI live in the same backend config, without editor metadata.
      try {
        await this.removeManagedMcpBackend(this.ensureBackend(), name, "mcp-remove");
        this.settingsEditor?.webview.postMessage({ type: "mcpSaved", ok: true });
      } catch (err: any) { void vscode.window.showErrorMessage(err?.message || "DGC could not remove that MCP server."); }
      return;
    }
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
      this.pruneOauthFiles(name);   // its own app's secret goes too
      this.settingsEditor?.webview.postMessage({ type: "mcpSaved", ok: true });
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
      case "usage": this.openSettings("usage"); break;
      case "settings": this.openSettings(); break;
      case "pips": this.openPips(); break;
      case "securitySettings": this.openSettings("security"); break;
      case "bug": void this.openSafeExternal("https://github.com/OpenPeach-ai/dgc/issues"); break;
      case "viewPlan": this.ensureBackend().send(
        this.stateCommand("plan", { type: "get_plan" })); break;
      case "artifacts": this.ensureBackend().send(
        this.stateCommand("artifacts", { type: "list_artifacts" })); break;
      case "monitors": this.ensureBackend().send(
        { type: "list_monitors", request_id: this.nextRequestId("monitors-list") }); break;
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
      case "learn": this.learn(""); break;
    }
  }

  /** /learn [what]: a skill drafted from this session, shown with Save, Edit and Cancel; nothing is written yet. */
  private learn(request: string): void {
    if (!(Number((this.lastReadyEvent?.capabilities as any)?.learn?.version) >= 1)) {
      this.post({ type: "event", event: { type: "error", message: "Update the DGC CLI to turn what you just did into a skill with /learn." } });
      return;
    }
    const requestId = this.nextRequestId("learn");
    if (this.ensureBackend().send({ type: "learn_skill", request_id: requestId, ...(request ? { request: request.slice(0, 1000) } : {}) })) {
      this.post({ type: "learn_started", requestId, request });
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
    const monitorStop = /^stop\s+(\S+)$/i.exec(rest);
    if (name === "monitors" && monitorStop) {
      await this.stopMonitor(monitorStop[1]); return;
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
      // Enable, disable and reconnect act on a row in the SERVERS list. Without saying so, the
      // webview switched to the context view and cleared the panel, so the list you were working
      // in vanished for the length of a connection attempt — up to three minutes.
      const verb = rest.trim().split(/\s+/, 1)[0].toLowerCase();
      const view = ["enable", "disable", "reconnect", "remove", "add"].includes(verb) ? "servers" : "context";
      this.post({ type: "mcp_command_started", requestId, view });
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
      else if (/^budget(?:\s|$)/i.test(rest)) {
        const match = /^budget\s+(off|none|0|[1-9]\d{0,12})$/i.exec(rest);
        const budget = match && !["off", "none"].includes(match[1].toLowerCase()) ? Number(match[1]) : 0;
        if (!match || budget > 1e12 || !this.state.goal.text) {
          this.post({ type: "event", event: { type: "error", message: "Use /goal budget NUMBER|off with an existing goal." } });
        } else { await this.updateGoal(this.state.goal.text, budget); }
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
    if (name === "usage") {
      // The terminals print the ledger; the editor has the Token Usage tab for it. The ranges and
      // their spellings are the CLI's (usage_ledger.normalize_range), so `/usage 30d` means the same.
      const range = USAGE_RANGE_ALIASES[rest.toLowerCase().replace(/\s+/g, "")];
      if (!rest) { this.openSettings("usage"); }
      else if (range) { this.openSettings("usage", range); }
      else {
        this.post({ type: "event", event: { type: "error", message: "usage: /usage [today|7d|30d|month|all]" } });
      }
      return;
    }
    if (name === "todo") {
      // The terminals' `/todo clear` works here too: the editor has no `todo` command of its own,
      // and sending it on as a custom command only ever produced "unknown command".
      if (rest.toLowerCase() === "clear") {
        await this.onMessage({ type: "clear_todos" });
      } else {
        this.post({ type: "event", event: { type: "error", message: "usage: /todo clear" } });
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
    // /branch [NAME] and its /fork alias are advertised by dgc/commands.py and handled by
    // branchChat, but nothing routed the typed form there: it fell through to the backend, which
    // rejects it as an unknown command (built-in names are reserved, so a custom command cannot
    // fill the gap either). The palette entry worked the whole time.
    if (name === "branch" || name === "fork") { void this.branchChat(rest); return; }
    if (name === "learn") { this.learn(rest); return; }
    // /artifact with an argument (`stop <id>`, `list`) is the backend's to interpret. The map
    // below keys on the command name alone, so every form of it opened the artifacts list.
    if (name === "artifact" && rest) { be.send({ type: "slash_command", text }); return; }
    const direct: Record<string, string> = {
      "view-plan": "viewPlan", artifact: "artifacts", monitors: "monitors", status: "status",
      compact: "compact",
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

  /** Open a saved session from the picker. Into this chat when it is idle; into a chat of its own,
   *  in this chat's folder, when this chat's turn is running -- opening it HERE would replace the
   *  conversation that turn belongs to, which the backend refuses ("resume_session is unavailable
   *  while a turn is running"), so the switch failed and the turn was the only way out. */
  private openPastSession(be: ChatBackend, sessionPath: string): void {
    const picked = path.basename(sessionPath).replace(/\.json$/i, "");
    // A session one of the open chats is on opens there. A second chat on it was refused as held
    // by "another DGC process", which it was not.
    if (picked && picked === this.currentSessionId) {
      void vscode.window.showInformationMessage("That session is the chat on screen.");
      return;
    }
    const holder = this.slots.find((slot) => slot.id !== this.activeSlotId
      && String(slot.saved?.currentSessionId || "") === picked
      && (slot.cwd || "") === (this.activeSlot().cwd || ""));
    if (picked && holder) {
      this.switchToSlot(holder.id);
      return;
    }
    if (this.turnActive || this.confirmedTurnActive) {
      const id = picked;
      if (/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        this.openChatSlot(this.activeSlot().cwd, id);
        return;
      }
    }
    void this.requestState(
      be, "session-resume", { type: "resume_session", path: sessionPath }, "session", 5000,
    ).catch((err: any) => vscode.window.showErrorMessage(
      err?.message || "DGC could not resume that session."));
  }

  async resume(): Promise<void> {
    // The Sessions home IS the side bar's resume: show it.
    if (this.home) { this.inVisiblePanel(() => { this.post({ type: "sessions_show" }); void this.postSessions(); }); return; }
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
        // In a tab, a session opens in a tab of its own: one session, one tab.
        if (pick && this.tab) {
          this.tab.places.open(path.basename(String(pick.path || "")).replace(/\.json$/i, ""), String(pick.label || ""));
        } else if (pick) { this.openPastSession(be, String(pick.path || "")); }
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

  // ---- Pips in the main DGC panel ------------------------------------------
  private ensurePipsBridge(): PipsEditor {
    if (!this.pipsEditor) {
      this.pipsEditor = new PipsEditor(this.context.extensionUri,
      (message, owner) => {
        // OpenedChat stamps its own chat_id on the outer envelope. Never send a
        // Pip control through whichever chat happened to become active later.
        const be = owner as ChatBackend | undefined;
        return !!be && this.sessionReady && this.backend === be && be.send(message);
      }, () => {
        this.ensureBackend();
        if (this.sessionReady) this.pipsEditor?.ready(this.lastReadyEvent?.capabilities, this.backend);
      }, true);
      this.pipsEditor.attach(message => this.post(message));
      this.pipsEditor.useDictation(() => this.dictationService(), () => this.readAloudService());
      this.pipsEditor.usePluginLogos((plugin) => this.replyPluginLogo(plugin));
    }
    if (this.sessionReady) this.pipsEditor.ready(this.lastReadyEvent?.capabilities, this.backend);
    return this.pipsEditor;
  }
  openPips(): void {
    if (this.tab) { this.tab.host.openPips(); return; }      // the Pips live in the side bar
    this.ensurePipsBridge();
    this.inVisiblePanel(() => this.post({ type: "pipsOpen" }));
  }

  openSettings(section = "general", usageRange?: string): void {
    if (this.tab) { this.tab.host.openSettings(section, usageRange); return; }   // one Settings tab for the window
    const name = section === "extensions" ? "plugins" : section;
    this.openEditorSettings(name, usageRange);
  }

  /** Codex-style settings: a real editor tab beside the chat, not a page inside it. */
  openEditorSettings(section = "general", usageRange?: string): void {
    this.settingsSelection = { section, range: usageRange || "7d" };
    if (this.settingsEditor) {
      this.settingsEditor.reveal(vscode.ViewColumn.Beside);
      this.showEditorSettings();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "dgc.settings", "DGC Settings", vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] });
    this.settingsEditor = panel;
    panel.webview.onDidReceiveMessage((msg) => this.onSettingsMessage(msg));
    panel.onDidDispose(() => { this.settingsEditor = undefined; });
    const asset = (name: string) => panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", name)).toString();
    panel.webview.html = settingsDocument(asset("settings.js"), asset("settings.css"), panel.webview.cspSource);
    // The webview's ready message sends the initial selection after its listener exists.
  }

  private sendPluginCommand(command: any): boolean {
    if (this.lastReadyEvent?.capabilities?.plugin_management !== true) {
      if (this.lastReadyEvent) this.settingsEditor?.webview.postMessage({type: "pluginOperationError",
        message: "This CLI does not include plugin management. Select the local connector build and run DGC: Restart Backend."});
      return false;
    }
    return this.ensureBackend().send(command);
  }

  /** Open the tab AT a section. Only a user action reaches this: the gear, a palette entry, or a
   *  webview that has just loaded and has nowhere else to start. */
  private showEditorSettings(): void {
    this.settingsEditor?.webview.postMessage({ type: "show", ...this.settingsSelection });
    this.refreshEditorSettings();
  }

  /** Which web search providers have their own key saved (see searchKeysSaved), read again from each new handshake. */
  private searchKeyState(): Map<string, boolean> | undefined {
    if (this.searchKeysFrom !== this.lastReadyEvent) {
      this.searchKeysFrom = this.lastReadyEvent;
      this.searchKeysSaved = searchKeysFromHandshake((this.lastReadyEvent?.capabilities as any)?.search_keys);
    }
    return this.searchKeysSaved;
  }

  /** Settings -> Web search -> Remove: clear one provider's own key, at once and by its own name, on a CLI that keeps
   *  one per provider (the page offers Remove only then). The page hears how it went. */
  private async removeSearchKey(provider: string): Promise<void> {
    const saved = this.searchKeyState();
    const reply = (ok: boolean, message = "") =>
      this.settingsEditor?.webview.postMessage({ type: "searchKeyRemoved", provider, ok, ...(message ? { message } : {}) });
    if (!saved?.has(provider)) { reply(false, "Update the DGC CLI to remove a web search key here."); return; }
    const before = saved.get(provider) === true;
    saved.set(provider, false);            // the config reply this asks for then shows it gone
    try {
      await this.requestState(this.ensureBackend(), "search-key",
                              { type: "set_config", values: { [`search_api_key_${provider}`]: "" } }, "config", 10000);
      reply(true);
    } catch (err: any) {
      saved.set(provider, before);
      reply(false, err?.message || "DGC could not remove the key.");
    }
  }

  /** The CLI lists the models at a host Settings has typed (ready.capabilities.list_models_at). */
  private listsModelsAt(): boolean {
    return (this.lastReadyEvent?.capabilities as any)?.list_models_at === 1;
  }

  /** Settings -> a Model box: the models at its card's own host, as typed. Only what the page typed goes: the host,
   *  the transport, and a key typed in the form. The CLI decides whether a saved key may go with it (only to the host
   *  it is bound to); the extension never adds one. The page hears the ids or a short reason, by its token. */
  private async listModelsAt(msg: any): Promise<void> {
    const token = String(msg?.token || "").slice(0, 64);
    const role = ["main", "subagent", "fallback"].includes(msg?.role) ? String(msg.role) : "";
    const reply = (fields: Record<string, unknown>) =>
      this.settingsEditor?.webview.postMessage({ type: "modelsAt", token, role, ...fields });
    if (!token || !role) return;
    if (!this.listsModelsAt()) { reply({ ids: [], unsupported: true }); return; }
    const baseUrl = typeof msg.base_url === "string" ? msg.base_url.trim().slice(0, 4096) : "";
    const mode = ["", "auto", "ollama", "anthropic", "chat_completions", "responses"].includes(String(msg.api_mode ?? ""))
      ? String(msg.api_mode ?? "") : "";
    const typedKey = typeof msg.api_key === "string" ? msg.api_key.trim().slice(0, 16384) : "";
    try {
      const ev: any = await this.ensureBackend().request({
        type: "list_models_at", request_id: this.nextRequestId("models-at"), role: role as any, base_url: baseUrl,
        api_mode: mode as any, ...(typedKey ? { api_key: typedKey } : {}),
      } as any, "models_at", 30000);
      const ids = Array.isArray(ev.ids) ? ev.ids.filter((id: unknown) => typeof id === "string").slice(0, 4096) : [];
      reply({ ids, ...(typeof ev.error === "string" && ev.error ? { error: ev.error.slice(0, 200) } : {}) });
    } catch {
      reply({ ids: [], error: "DGC didn't answer" });
    }
  }

  /** The web search providers this CLI's set_config takes: ready.capabilities.search_providers (Ollama came with it),
   *  else the four every CLI that takes the search from Settings knows. One it doesn't know refuses the whole save. */
  private searchProviders(): string[] {
    const offered = (this.lastReadyEvent?.capabilities as any)?.search_providers;
    return Array.isArray(offered) ? offered.filter((p: unknown) => typeof p === "string" && SEARCH_PROVIDERS.includes(p))
      : ["duckduckgo", "brave", "tavily", "searxng"];
  }

  /** What a NEW backend owes the tab, and nothing else. Deliberately without the `show` post:
   *  `settingsSelection` is written only when the user opens settings, so re-posting it on a
   *  handshake -- Restart Backend, crash recovery, or opening a second chat, none of which the
   *  user aimed at this tab -- sends the page back to wherever settings was opened and takes a
   *  half-typed MCP server (name, command, args, env lines, token) with it, because `navTo`
   *  clears `mcpEditing` and the `mcp-*` fields are not in the `defaults` snapshot. A chosen
   *  usage range reverts to 7 days the same way. Every other push below is already guarded by
   *  `!mcpEditing` on the client; `show` was the one that routed around that guard. */
  private refreshEditorSettings(): void {
    const providers = Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, url: p.url, needsKey: p.needsKey }));
    this.settingsEditor?.webview.postMessage({ type: "providers", providers });
    const be = this.ensureBackend();
    // The web search's address and whether its key is saved are opt-in fields (an older editor never
    // sees them); every supported CLI takes `fields` and ignores names it doesn't know.
    be.send({ type: "get_config", request_id: this.nextRequestId("config-read"),
              fields: ["search_url", "search_api_key_set", "chatdgc_about", "chatdgc_style", "chatdgc_personality",
                       "chatdgc_window", "memory", "chatdgc_web", "chatdgc_followups", "turn_token_budget",
                       "subagent_context_size", "cache_settings", "pips_settings", "model_wait_settings"] });
    this.sendPluginCommand({ type: "list_plugins", request_id: this.nextRequestId("plugins") });
    this.sendPluginCommand({ type: "list_plugin_marketplaces", request_id: this.nextRequestId("marketplaces") });
    be.send({ type: "list_mcp_servers", request_id: this.nextRequestId("settings-mcp") });
  }

  private pluginLogo(item: PluginLogoItem, webview?: vscode.Webview): string {
    if (!webview) return "";
    const found = pluginLogoSource(this.context.extensionUri, item);
    return found.data ?? (found.file ? webview.asWebviewUri(found.file).toString() : "");
  }

  /** A plugin's logo for a reply's "Used Aave" line (ChatDGC, Pips), by its id: as the catalog knows it when Settings
   *  has listed plugins, else the logo DGC ships for it. */
  private replyPluginLogo(plugin: string): string {
    if (!PLUGIN_ID.test(plugin)) return "";
    const known = this.settingsCatalog.find(row => row?.name === plugin);
    return pluginLogoData(this.context.extensionUri, known && typeof known === "object" ? known : { name: plugin });
  }

  private async saveConnector(msg: any): Promise<void> {
    const id = String(msg.name || "");
    const def = APP_CONNECTORS[id];
    try {
      if (!def) throw new Error("Unknown app connector");
      if (this.lastReadyEvent && !(this.lastReadyEvent as any).capabilities?.app_connectors)
        throw new Error("This backend does not include the local connector build. Select the local DGC CLI and run DGC: Restart Backend.");
      const target = connectorUrl(id, msg.url);
      const auth = String(msg.auth || def.auth[0]);
      if (!def.auth.includes(auth)) throw new Error("Choose a supported authentication method");
      const token = auth === "token" ? String(msg.token || "") : "";
      if (token.length > 16384 || /[\x00-\x20\x7f]/.test(token)) throw new Error("Enter a valid connection token");
      const previous = this.managedMcpServers().find(s => s.name === id && s.target === target);
      if (auth === "token" && !token && !(previous && (await this.mcpSecrets(previous)).token))
        throw new Error("Enter the connection token from your provider");
      // Your own app (Asana, Docusign, Zoom): its ID, its secret unless it is a public client (Zoom's has none), and
      // the callback port the setup told you to register.
      const ownApp = auth === "own-app" && def.own_app ? def.own_app : undefined;
      const clientId = ownApp ? String(msg.client_id || "").trim() : "";
      const clientSecret = ownApp?.secret_label ? String(msg.client_secret || "").trim() : "";
      const field = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);   // "client ID", "secret key"
      if (ownApp && !clientId) throw new Error(`Enter the ${field(ownApp.id_label)} from ${def.name}`);
      if (ownApp?.secret_label && !clientSecret
          && !(previous?.oauth?.clientId === clientId && (await this.mcpSecrets(previous)).oauthSecret))
        throw new Error(`Enter the ${field(ownApp.secret_label)} from ${def.name}`);
      if (!this.settingsCatalog.some(row => row.name === id && row.installed)) {
        const answer = await vscode.window.showWarningMessage(
          `Connect ${def.name} under ${def.license}?`,
          {modal:true, detail:`${def.summary} Review the provider's terms: ${def.terms}`}, "Accept and connect");
        if (answer !== "Accept and connect") return;
      }
      this.settingsMcpOperation++;
      try {
        const saved = await this.saveMcpServer({name:id, original_name:id, transport:"remote", target,
          token, clear_secrets:auth === "oauth",
          ...(ownApp ? { oauth_client_id: clientId, oauth_client_secret: clientSecret, oauth_port: String(ownApp.port) } : {}),
        }, {id, license:def.license});
        if (!saved) throw new Error("Connection setup did not finish. Review the editor error, check your provider settings, and try again.");
      } finally { this.settingsMcpOperation--; }
      this.sendPluginCommand({ type: "list_plugins", request_id:this.nextRequestId("connectors")});
      this.ensureBackend().send({type:"list_mcp_servers", request_id:this.nextRequestId("connectors-mcp")});
    } catch (error: any) {
      this.settingsEditor?.webview.postMessage({type:"connectorError", message:error?.message || "Could not connect"});
    } finally {
      this.settingsEditor?.webview.postMessage({type:"connectorSaveFinished"});
    }
  }

  private async onSettingsMessage(msg: any): Promise<void> {
    const be = this.ensureBackend();
    if (msg?.type === "ready") {
      this.showEditorSettings();
    } else if (msg?.type === "saveSettings") {
      await this.saveSettings(msg.values || {});
    } else if (msg?.type === "listModelsAt") {
      await this.listModelsAt(msg);
    } else if (msg?.type === "removeSearchKey") {
      await this.removeSearchKey(String(msg.provider || ""));
    } else if (msg?.type === "listRunning") {
      // Settings -> Running sessions: what runs with no window, from a CLI that can keep it running.
      if (!be.ready) { this.settingsEditor?.webview.postMessage({ type: "running", pending: true }); }
      else if (!this.processOf(be)?.detachOffer) { this.settingsEditor?.webview.postMessage({ type: "running", unsupported: true }); }
      else { this.requestLiveSessions(); }
    } else if (msg?.type === "stopRunning") {
      const pid = Number(msg.pid), instance = String(msg.instance || "");
      if (be.ready && this.processOf(be)?.detachOffer && Number.isSafeInteger(pid) && pid > 0 && /^[a-f0-9]{1,64}$/.test(instance)) {
        be.send({ type: "stop_live_session", pid, instance, request_id: this.nextRequestId("stop-live") } as any);
      }
    } else if (msg?.type === "openRunning") {
      const id = String(msg.session || ""), chat = String(msg.chat || "");
      if (/^chat_[a-f0-9]{32}$/.test(chat)) { (this.tab?.host ?? this).chatdgc?.open(chat, false, true); }
      else if (this.places && /^[A-Za-z0-9_-]{1,128}$/.test(id)) { this.places.open(id, String(msg.name || "")); }
    } else if (msg?.type === "copy") {
      const text = String(msg.text || "");
      if (text.length <= 2048) await vscode.env.clipboard.writeText(text);
    } else if (msg?.type === "saveConnector") {
      await this.saveConnector(msg);
    } else if (msg?.type === "connectorManage") {
      const def = APP_CONNECTORS[String(msg.name || "")];
      if (def) {
        let url=def.manage || def.docs;
        if (msg.name === "n8n") {
          const row=this.settingsCatalog.find(r=>r.name === "n8n" && r.installed);
          const endpoint=row?.mcps?.[0]?.url;
          if(endpoint) try { url=connectorUrl("n8n",endpoint).replace(/\/mcp-server\/http\/?$/, "/"); } catch { /* use setup docs */ }
        }
        await this.openSafeExternal(url);
      }
    } else if (msg?.type === "composioCatalog") {
      try {
        if (!await vscode.env.openExternal(vscode.Uri.parse(COMPOSIO_CATALOG))) {
          this.settingsEditor?.webview.postMessage({ type: "pluginOperationError", message: "The browser was not opened. Choose Manage apps in Composio to try again." });
        }
      } catch {
        this.settingsEditor?.webview.postMessage({ type: "pluginOperationError", message: "Could not open Composio in your browser. Try again." });
      }
    } else if (["composioConnection", "composioBrowser", "composioCancel"].includes(msg?.type)) {
      // Retired webview controls cannot initiate app setup or cancel a chat turn.
      this.settingsEditor?.webview.postMessage({ type: "pluginOperationError", message: "App connections are managed in Composio. Open Apps → Manage apps in Composio." });
    } else if (msg?.type === "getUsage") {
      const range = ["today", "7d", "30d", "month", "all"].includes(msg.range) ? msg.range : "7d";
      const requestId = String(msg.requestId || this.nextRequestId("usage")).slice(0, 128);
      if (this.lastReadyEvent && !this.lastReadyEvent.capabilities?.usage_ledger) {
        this.settingsEditor?.webview.postMessage({ type: "usage_unavailable", requestId,
          message: "Update the DGC CLI to see token usage in the editor." });
      } else if (!be.send({ type: "get_usage", request_id: requestId, range })) {
        this.settingsEditor?.webview.postMessage({ type: "usage_unavailable", requestId,
          message: "DGC could not ask its backend for token usage. Try Refresh." });
      }
    } else if (["getVoice", "voiceInstall", "voiceCancel", "voiceRemove", "voiceUse"].includes(msg?.type)) {
      // Settings -> Voice: the models that dictate and read aloud, on the side bar's process (dgc/voice).
      const say = (message: string) => this.settingsEditor?.webview.postMessage({ type: "voice_unavailable", message });
      if (this.lastReadyEvent && !this.lastReadyEvent.capabilities?.voice) {
        say("Update the DGC CLI to use voice.");
        return;
      }
      const id = typeof msg.id === "string" && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(msg.id) ? msg.id : "";
      const role = msg.role === "dictation" || msg.role === "read_aloud" ? msg.role : "";
      let cmd: { type: string } & Record<string, unknown> | null = null;
      if (msg.type === "getVoice") cmd = { type: "voice_models" };
      else if (msg.type === "voiceInstall" && id) cmd = { type: "voice_install", id };
      else if (msg.type === "voiceCancel" && id) cmd = { type: "voice_cancel", id };
      else if (msg.type === "voiceRemove" && id) cmd = { type: "voice_remove", id };
      else if (msg.type === "voiceUse" && id && role) cmd = { type: "voice_use", id, role };
      if (cmd && !be.send({ ...cmd, request_id: this.nextRequestId("settings-voice") } as Parameters<DgcBackend["send"]>[0])) {
        say("DGC couldn't reach its backend. Try again.");
      }
    } else if (["getMemory", "memoryAdd", "memoryEdit", "memoryForget", "memoryClear", "memoryProject", "memorySwitch",
                "getMemoryHistory", "memoryUndo"].includes(msg?.type)) {
      // Settings -> Memory: one memory about the user, kept by the side bar's process (dgc/shared_memory.py).
      const say = (message: string) => this.settingsEditor?.webview.postMessage({ type: "memory_unavailable", message });
      if (this.lastReadyEvent && !this.lastReadyEvent.capabilities?.memory) {
        say("Update the DGC CLI to see and manage what DGC remembers about you.");
        return;
      }
      const requestId = this.nextRequestId("memory");
      const text = typeof msg.text === "string" ? msg.text.slice(0, 1000) : "";
      const id = typeof msg.id === "string" && /^mem_[0-9a-f]{12}$/.test(msg.id) ? msg.id : "";
      let cmd: { type: string } & Record<string, unknown> | null = null;
      const history = Number((this.lastReadyEvent?.capabilities as any)?.memory?.history) >= 1;
      if (msg.type === "getMemory") cmd = { type: "memory_list" };
      else if (msg.type === "getMemoryHistory") {
        // An older CLI keeps no history: the page says so instead of asking.
        if (!history) { this.settingsEditor?.webview.postMessage({ type: "memory_history_unavailable" }); return; }
        cmd = { type: "memory_history" };
      } else if (msg.type === "memoryUndo") {
        const change = typeof msg.id === "string" && /^memj_[0-9a-f]{12}$/.test(msg.id) ? msg.id : "";
        if (!history || !change) return;
        cmd = { type: "memory_undo", id: change };
      }
      else if (msg.type === "memoryAdd" && text.trim()) cmd = { type: "memory_add", text };
      else if (msg.type === "memoryEdit" && id && text.trim()) cmd = { type: "memory_edit", id, text };
      else if (msg.type === "memoryForget" && id) cmd = { type: "memory_forget", id };
      else if (msg.type === "memoryClear") cmd = { type: "memory_clear" };
      else if (msg.type === "memoryProject" && typeof msg.folder === "string" && msg.folder) {
        cmd = { type: "memory_project", folder: msg.folder.slice(0, 4096), remember: msg.remember === true };
      } else if (msg.type === "memorySwitch") {
        // On or off for every surface at once: saved now, not with the page's Save.
        if (!be.send({ type: "set_config", request_id: this.nextRequestId("memory-switch"), values: { memory: msg.on === true } })) {
          say("DGC couldn't reach its backend. Try again.");
          return;
        }
        cmd = { type: "memory_list" };
      }
      if (cmd && !be.send({ ...cmd, request_id: requestId } as Parameters<DgcBackend["send"]>[0])) say("DGC couldn't reach its backend. Try again.");
    } else if (msg?.type === "getPipUsage") {
      const range = ["today", "7d", "30d", "month", "all"].includes(msg.range) ? msg.range : "7d";
      const requestId = String(msg.requestId || this.nextRequestId("pip-usage")).slice(0, 128);
      if (this.lastReadyEvent && !this.lastReadyEvent.capabilities?.pip_usage_report) {
        this.settingsEditor?.webview.postMessage({ type: "pip_usage_unavailable", requestId,
          message: "Update the DGC CLI to see token usage by Pip." });
      } else if (!be.send({ type: "get_pip_usage_report", request_id: requestId, range })) {
        this.settingsEditor?.webview.postMessage({ type: "pip_usage_unavailable", requestId,
          message: "DGC could not ask its backend for token usage by Pip. Try Refresh." });
      }
    } else if (msg?.type === "installPlugin") {
      const name = String(msg.name || "");
      const reviewed = this.settingsPreviews.get(name);
      const row = reviewed || this.settingsCatalog.find((item) => item.name === name && item.installed);
      if (!row) {
        this.settingsEditor?.webview.postMessage({ type: "pluginResult", name,
          error: "Open the plugin install review before installing." });
        return;
      }
      let accept = "";
      if (row?.install === "block") {
        this.settingsEditor?.webview.postMessage({ type: "pluginResult", name, error: row.block_reason || "This plugin is not offered." });
        return;
      }
      if (row?.install === "accept" && reviewed) {
        const answer = await vscode.window.showWarningMessage(
          `Install ${row.display_name} under ${row.license}?`,
          { modal: true, detail: `Review the publisher's terms before installing: ${row.terms_url || row.license_url || "See plugin information."}` },
          "Accept and install");
        if (answer !== "Accept and install") {
          this.settingsEditor?.webview.postMessage({ type: "pluginResult", name });
          return;
        }
        accept = row.license;
      }
      const commands = Object.entries(reviewed?.server_specs || {})
        .filter(([key]) => !Array.isArray(msg.selectedServers) || msg.selectedServers.includes(key))
        .map(([, spec]) => spec) as any[];
      if (commands.some(spec => spec.transport === "stdio")) {
        const answer = await vscode.window.showWarningMessage(
          `Install ${row.display_name || name} and run its MCP commands?`,
          { modal: true, detail: commands.filter(spec => spec.transport === "stdio").map(spec => spec.command + " " + (spec.args || []).join(" ")).join("\n") }, "Install and run");
        if (answer !== "Install and run") {
          this.settingsEditor?.webview.postMessage({ type: "pluginResult", name });
          return;
        }
      }
      const requestId = this.nextRequestId("settings-plugin");
      this.settingsInstalls.set(requestId, String(row.name || name));
      if (!this.sendPluginCommand({ type: "install_plugin", request_id: requestId, name, accept_license: accept, ...(Array.isArray(msg.selectedServers) ? { selected_servers: msg.selectedServers } : {}) })) {
        this.settingsInstalls.delete(requestId);
        this.settingsEditor?.webview.postMessage({ type: "pluginResult", name, error: "DGC could not start installation. Try again." });
      }
    } else if (msg?.type === "savePluginKey" || msg?.type === "removePluginKey") {
      // The key field on a plugin's page. The key goes to dgc serve, which keeps it in the system keychain; nothing
      // here stores it, and the page only ever hears back whether one is saved.
      const name = String(msg.name || ""), server = String(msg.server || ""), env = String(msg.env || "");
      const reply = (error: string) => this.settingsEditor?.webview.postMessage({ type: "pluginKeyResult", name, server, error });
      if (!PLUGIN_ID.test(name) || (server && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(server))
          || (env && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(env))) return;
      if (this.lastReadyEvent && this.lastReadyEvent.capabilities?.plugin_keys !== true) {
        reply("This DGC CLI can't keep a plugin's key yet. Update it, then save the key here.");
        return;
      }
      const saving = msg.type === "savePluginKey";
      const key = saving ? String(msg.key || "").trim() : "";
      if (saving && !key) { reply("Paste the key first."); return; }
      if (key.length > 16384) { reply("That key is too long. Copy the key itself."); return; }
      const requestId = this.nextRequestId("plugin-key");
      this.settingsKeyRequests.set(requestId, { name, server });
      const command = saving
        ? { type: "set_plugin_key" as const, request_id: requestId, name, key, ...(server ? { server } : {}), ...(env ? { env } : {}) }
        : { type: "remove_plugin_key" as const, request_id: requestId, name, ...(server ? { server } : {}), ...(env ? { env } : {}) };
      if (!this.sendPluginCommand(command)) {
        this.settingsKeyRequests.delete(requestId);
        reply("DGC couldn't reach its backend. Try again.");
      }
    } else if (msg?.type === "setPluginSignInScopes" || msg?.type === "signInAgain") {
      // "What DGC may do on GitHub": dgc serve keeps the choice (beside the plugin's permission level) and asks GitHub
      // for exactly that at the next sign-in. Sign in again sets the current sign-in aside and signs in with it now,
      // answered like a Connect from this page.
      const name = String(msg.name || ""), again = msg.type === "signInAgain";
      const scopes = (Array.isArray(msg.scopes) ? msg.scopes : [])
        .filter((id: unknown): id is string => typeof id === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(id)).slice(0, 16);
      if (!PLUGIN_ID.test(name)) return;
      const reply = (error: string) => this.settingsEditor?.webview.postMessage(again
        ? { type: "pluginResult", name, error } : { type: "pluginKeyResult", name, server: "", kind: "scopes", error });
      if (this.lastReadyEvent && this.lastReadyEvent.capabilities?.plugin_sign_in_scopes !== true) {
        reply("This DGC CLI can't choose what a sign-in may do yet. Update it, then choose here.");
        return;
      }
      const requestId = this.nextRequestId(again ? "settings-plugin" : "plugin-key");
      if (again) this.settingsInstalls.set(requestId, name);
      else this.settingsKeyRequests.set(requestId, { name, server: "", kind: "scopes" });
      if (!this.sendPluginCommand({ type: "set_plugin_sign_in_scopes", request_id: requestId, name, scopes,
                                    ...(again ? { sign_in_again: true } : {}) })) {
        this.settingsInstalls.delete(requestId); this.settingsKeyRequests.delete(requestId);
        reply("DGC couldn't reach its backend. Try again.");
      }
    } else if (msg?.type === "openSignIn") {
      const request = this.pendingSignIn;
      if (request) await openMcpBrowser(request, () => this.pendingSignIn === request);
    } else if (msg?.type === "cancelSignIn") {
      // Revoke a not-yet-opened URL as well as stopping its foreground worker.
      for (const [id, request] of this.mcpUrls) {
        if (request === this.pendingSignIn) {
          this.mcpUrls.delete(id);
          be.send({ type: "mcp_input_response", id, action: "cancel" });
        }
      }
      // Opened in the browser, its request is answered: cancel it by its id, which the backend turns
      // into the install's own cancel. The `cancel` sent here before is the turn's Stop, and with
      // installs running beside a turn it ended the turn on screen -- handing back its queued
      // messages, expiring its cards -- while the plugin went on connecting.
      const opened = this.openedSignIn;
      if (this.pendingSignIn && opened) {
        opened.be.send({ type: "mcp_input_response", id: opened.id, action: "cancel" });
      }
      this.pendingSignIn = undefined; this.openedSignIn = undefined;
      this.pendingSignInServer = "";
      this.settingsEditor?.webview.postMessage({ type: "signin", clear: true });
    } else if (msg?.type === "inspectPlugin") {
      const requestId = this.nextRequestId("plugin-preview");
      const name = String(msg.name || "");
      this.settingsPreviewRequests.set(requestId, name);
      if (!this.sendPluginCommand({ type: "inspect_plugin", name, request_id: requestId })) {
        this.settingsPreviewRequests.delete(requestId);
        this.settingsEditor?.webview.postMessage({ type: "pluginOperationError", action: "inspect_plugin", requested: name, message: "DGC is not connected. Try again." });
      }
    } else if (msg?.type === "uninstallPlugin") {
      const row = this.settingsCatalog.find(item => item.name === msg.name && item.installed);
      if (!row) return;
      const answer = await vscode.window.showWarningMessage(`Uninstall ${row.display_name}?`,
        { modal: true, detail: "Remove this plugin's skills and its unchanged MCP server settings from DGC. This does not revoke permissions at the vendor; manage those in your vendor account." }, "Uninstall");
      if (answer === "Uninstall") this.sendPluginCommand({ type: "uninstall_plugin", name: row.name, request_id: this.nextRequestId("plugin-uninstall") });
      else this.settingsEditor?.webview.postMessage({ type: "pluginOperationCancelled" });
    } else if (msg?.type === "marketplaceAction") {
      const request_id = this.nextRequestId("plugin-marketplace");
      if (msg.action === "add") this.sendPluginCommand({ type: "add_plugin_marketplace", source: String(msg.source || ""), request_id });
      else if (msg.action === "remove") {
        const answer = await vscode.window.showWarningMessage(`Remove marketplace ${String(msg.name)}?`, { modal: true, detail: "Installed plugins remain installed." }, "Remove marketplace");
        if (answer === "Remove marketplace") this.sendPluginCommand({ type: "remove_plugin_marketplace", name: String(msg.name), request_id });
        else this.settingsEditor?.webview.postMessage({ type: "pluginOperationCancelled" });
      } else if (msg.action === "refresh") this.sendPluginCommand({ type: "refresh_plugin_marketplace", name: String(msg.name), request_id });
    } else if (msg?.type === "browseMarketplace") {
      const chosen = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: "Choose a plugin marketplace folder" });
      if (chosen?.[0]) this.settingsEditor?.webview.postMessage({ type: "marketplaceFolder", path: chosen[0].fsPath });
    } else if (msg?.type === "createPlugin") {
      this.sendPluginCommand({ type: "create_plugin", request_id: this.nextRequestId("plugin-create"), name: String(msg.name || ""), display_name: String(msg.displayName || ""), description: String(msg.description || "") });
    } else if (msg?.type === "editCreatedPlugin" && this.createdPluginFiles.has(String(msg.path))) {
      const root = String(msg.path);
      const name = path.basename(root);
      await vscode.window.showTextDocument(vscode.Uri.file(join(root, "skills", name, "SKILL.md")));
    } else if (msg?.type === "openPluginLink") {
      // Metadata links may open a website, never a command/file URI.
      try {
        const url = new URL(String(msg.url || ""));
        if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) {
          await vscode.env.openExternal(vscode.Uri.parse(url.href));
        }
      } catch { /* malformed package link */ }
    } else if (msg?.type === "skillToggle" && typeof msg.enabled === "boolean") {
      be.send({ type: "set_skill_enabled", request_id: this.nextRequestId("skill-toggle"),
                name: String(msg.name || ""), enabled: msg.enabled });
      // These switches render from plugin_catalog, and nothing else delivers it. The backend used
      // to answer set_skill_enabled with one, which is the single case of a 0.45.0 event answering
      // a command a 0.44.1 panel also sends -- so it announced itself broken over an ordinary
      // toggle. Ask for it here instead, from the surface that owns the switch: commands share one
      // ordered pipe, so this is dispatched after the toggle has been applied.
      this.sendPluginCommand({ type: "list_plugins", request_id: this.nextRequestId("plugins") });
    } else if (msg?.type === "listMcp") {
      be.send({ type: "list_mcp_servers", request_id: this.nextRequestId("settings-mcp") });
    } else if (msg?.type === "mcpToggle" || msg?.type === "mcpReconnect") {
      const name = String(msg.name || "");
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) return;
      const command = msg.type === "mcpToggle"
        ? { type: "set_mcp_enabled" as const, name, enabled: msg.enabled === true }
        : { type: "reconnect_mcp_server" as const, name };
      be.send({ ...command, request_id: this.nextRequestId("settings-mcp") });
    } else if (msg?.type === "mcpSave" || msg?.type === "mcpRemove") {
      this.settingsMcpOperation++;
      try { await this.onMessage(msg); }
      finally {
        this.settingsMcpOperation--;
        be.send({ type: "list_mcp_servers", request_id: this.nextRequestId("settings-mcp") });
      }
    }
  }

  async saveSettings(v: any): Promise<void> {
    if (this.settingsSaveInFlight) {
      void vscode.window.showWarningMessage("DGC is already saving settings.");
      return;
    }
    this.settingsSaveInFlight = true;
    let backend: ChatBackend | undefined;
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
        show_reasoning: v.show_reasoning !== false,
        thinking_inline: v.thinking_inline === undefined ? this.behaviorState.thinkingInline : v.thinking_inline !== false,
        suggest: v.suggest !== false,
        monitor_wake: v.monitor_wake !== false,
        ultra_mode: v.ultra_mode === true,
        plan_artifact: v.plan_artifact !== false,
        artifact_autostart: v.artifact_autostart !== false,
        artifact_in_plan: v.artifact_in_plan === true,
        tool_profile: v.tool_profile === "full" ? "full"
          : v.tool_profile === "adaptive" ? "adaptive" : "standard",
        max_parallel_tasks: Math.max(1, Math.min(MAX_PARALLEL_TASKS, Math.floor(Number(v.max_parallel_tasks || 4)) || 1)),
        // General → Thinking is the composer dial. On a subscription route it maps to
        // subscription_effort; native thinking stays the last native value so a Save does not
        // overwrite it with the vendor effort.
        thinking: selectedEngine ? (this.routeState.nativeThink || "off") : (v.think || "off"),
        subscription_engine: selectedEngine,
        subscription_model: v.subscription_model || "",
        subscription_effort: selectedEngine
          ? (String(v.think || "off") === "off" ? "" : String(v.think || "").trim().toLowerCase())
          : subscriptionEffort,
      };
      if (subagentKey !== undefined) { values.subagent_api_key = subagentKey; }
      if (fallbackKey !== undefined) { values.fallback_api_key = fallbackKey; }
      // The one web search Work, ChatDGC and Pips share. Only to a CLI that takes all three (its config
      // answered search_api_key_set): one that cannot would refuse the whole save. A blank key keeps
      // the saved one; the key is saved by the CLI in its own secrets.json, where its Pips read it.
      if (this.searchSettable) {
        const provider = String(v.search_provider || "");
        const taken = this.searchProviders().includes(provider);
        if (taken) { values.search_provider = provider; }
        if (typeof v.search_url === "string") { values.search_url = v.search_url.trim(); }
        // A key goes with a provider this CLI takes: otherwise it would be kept as the key of the one it has. To a CLI
        // that keeps one per provider it goes by that provider's own name, so it can never become another's.
        if (taken && typeof v.search_api_key === "string" && v.search_api_key.trim()) {
          const own = this.searchKeyState();
          if (own?.has(provider)) { values[`search_api_key_${provider}`] = v.search_api_key.trim(); }
          else if (!own) { values.search_api_key = v.search_api_key.trim(); }
        }
        if (typeof v.chatdgc_web === "boolean") { values.chatdgc_web = v.chatdgc_web; }
      }
      if (this.chatdgcSettable) {
        for (const key of ["chatdgc_about", "chatdgc_style"]) {
          if (typeof v[key] === "string") { values[key] = v[key].slice(0, 1500); }
        }
        if (["default", "concise", "warm", "candid", "nerdy"].includes(String(v.chatdgc_personality || ""))) {
          values.chatdgc_personality = v.chatdgc_personality;
        }
        // A size its backend takes: an older CLI knows only 8k, 32k, 128k and max (it doesn't list them).
        const offeredWindows = (this.lastReadyEvent?.capabilities as any)?.chatdgc?.windows;
        const takes = Array.isArray(offeredWindows) ? offeredWindows : ["8k", "32k", "128k", "max"];
        if (CHATDGC_WINDOWS.includes(String(v.chatdgc_window || "")) && takes.includes(String(v.chatdgc_window))) {
          values.chatdgc_window = v.chatdgc_window;
        }
        if (typeof v.chatdgc_followups === "boolean") { values.chatdgc_followups = v.chatdgc_followups; }
      }
      if (v.context_size) { values.context_size = Number(v.context_size); }
      // The per-turn token cap: blank or 0 is no cap. Only to a CLI that answered it (an older one refuses the save).
      if (this.budgetSettable && v.turn_token_budget !== undefined) {
        values.turn_token_budget = Math.max(0, Math.min(1_000_000_000, Math.floor(Number(v.turn_token_budget) || 0)));
      }
      // The prompt-cache lifetime and Ollama's keep-loaded time: only to a CLI that answered cache_settings.
      if (this.cacheSettings) {
        if (v.prompt_cache_ttl === "5m" || v.prompt_cache_ttl === "1h") { values.prompt_cache_ttl = v.prompt_cache_ttl; }
        if (typeof v.ollama_keep_alive === "string" && KEEP_ALIVE_RE.test(v.ollama_keep_alive.trim())) {
          values.ollama_keep_alive = v.ollama_keep_alive.trim();
        }
      }
      // The sub-agents' window: blank or 0 is the main model's. Only to a CLI that answered it (an older one
      // refuses the whole save on a key it doesn't know).
      if (this.subagentWindowSettable && v.subagent_context_size !== undefined) {
        values.subagent_context_size = subagentWindow(v.subagent_context_size);
      }
      if (v.capability_cache_ttl_s) {
        values.capability_cache_ttl_s = Math.max(1, Number(v.capability_cache_ttl_s));
      }
      // How long DGC waits on a model: only to a CLI that answered model_wait_settings, and only what changed.
      if (this.waitSettings) {
        Object.assign(values, waitValues(v, this.waitSettings));
      }
      // The model every Pip on Default uses ("" follows DGC). Only to a CLI that answered pips_settings.
      if (this.pipsSettings && typeof v.pips_model === "string") {
        const pipsModel = v.pips_model.trim();
        if (pipsModel && (pipsModel.length > 256 || !PIPS_MODEL_RE.test(pipsModel) || pipsModel.includes("://"))) {
          throw new Error("Model for Pips takes a model's name, like qwen3:8b, or nothing to use DGC's.");
        }
        values.pips_model = pipsModel;
      }

      const saveConfig = async (prefix: string, configValues: any): Promise<void> => {
        await this.requestState(
          be, prefix, { type: "set_config", values: configValues }, "config", 10000);
        appliedStages.push("configuration");
      };
      const saveNativeModel = async (): Promise<void> => {
        // The settings form posts every field, so base_url/api_key/model are almost always
        // PRESENT even when the user touched none of them. Sending set_model on presence meant
        // every Save asked to move the execution route -- which the backend rightly refuses
        // while a turn is running, so saving an unrelated setting mid-run failed on a model that
        // had not changed. Send it only when the native route actually differs.
        const currentModel = String(this.routeState.nativeModel || this.state.model || "");
        const routeChanged = baseChanged
          || Boolean(apiKey)
          || (Boolean(v.model) && String(v.model) !== currentModel);
        if (!routeChanged) { return; }
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
      this.settingsEditor?.webview.postMessage({ type: "settingsSaved", ok: true });
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
      this.settingsEditor?.webview.postMessage({ type: "settingsSaved", ok: false, message: `${partial}${detail}${rollbackNote}` });
      void vscode.window.showErrorMessage(`${partial}${detail}${rollbackNote}`);
    } finally {
      this.settingsSaveInFlight = false;
      this.settingsEditor?.webview.postMessage({ type: "settingsSaveFinished" });
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
      detail: "extended reasoning guidance plus proactive bounded sub-agents; permissions stay unchanged",
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

  // The composer's context menu sets the window exactly as Settings does. The backend answers with
  // config and then context, and the context event redraws the meter.
  private async setContextSize(size: number, be = this.ensureBackend()): Promise<void> {
    if (!Number.isInteger(size) || size < 2048 || size > 16_777_216) { return; }
    try {
      await this.requestState(be, "context-size",
        { type: "set_config", values: { context_size: size } }, "config", 5000);
    } catch (err: any) {
      void vscode.window.showErrorMessage(err?.message || "DGC could not change the context window.");
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

  /** /new in this chat: a fresh session in place. (DGC: New Session from the palette, and +, open a
   *  new session's tab instead -- extension.ts and the newChat message.) */
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
    const selection = DgcViewProvider.selectionToAdd();
    if (selection) { this.attachSelection(selection); }
  }

  /** The selection in the editor in front of you, read BEFORE anything else opens: with sessions in
   *  tabs, the command may open a new session's tab, which then becomes the editor in front. */
  static selectionToAdd(): { label: string; resource: any } | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) {
      void vscode.window.showInformationMessage("Select some text first — DGC: Add Selection sends the selection.");
      return undefined;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const a = ed.selection.start.line + 1;
    const b = ed.selection.end.line + 1;
    const folder = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    let text = ed.document.getText(ed.selection);
    if (text.length > 8192) { text = text.slice(0, 8192); }
    return { label: `${rel}:${a}-${b}`, resource: {
      type: "selection", uri: ed.document.uri.toString(), path: ed.document.uri.fsPath,
      relative_path: rel, workspace: folder?.name || "", language: ed.document.languageId,
      range: { start_line: a, end_line: b }, text,
    } };
  }

  attachSelection(selection: { label: string; resource: any }): void {
    // Queued until the webview is up: the selection used to be dropped silently when the view
    // had never been opened.
    this.inVisiblePanel(() => this.post({ type: "attach", label: selection.label, resource: selection.resource }));
  }

  /** DGC: Add File to DGC — from the explorer, a tab, the palette, or a drop. From the palette
   * it adds the file in front of you, which is not always a text editor: an image in VS Code's
   * image preview, a PDF or notebook in a custom editor has no activeTextEditor, and the command
   * used to answer "Open or select a file" with the image open. */
  addFiles(uri?: vscode.Uri, uris?: vscode.Uri[]): void {
    const list = DgcViewProvider.filesToAdd(uri, uris);
    if (list.length) { this.attachFiles(list); }
  }

  /** The files to add: the ones named, else the file in front of you -- read before a session tab
   *  can open and become the thing in front (see selectionToAdd). */
  static filesToAdd(uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] {
    const picked = (Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [])
      .filter((u): u is vscode.Uri => !!u && u.scheme === "file");
    const active = vscode.window.activeTextEditor?.document.uri ?? activeTabUri();
    const list = picked.length ? picked : active && active.scheme === "file" ? [active] : [];
    if (!list.length) {
      void vscode.window.showInformationMessage("Open or select a file to add it to DGC.");
    }
    return list;
  }

  attachFiles(list: vscode.Uri[]): void {
    for (const u of list.slice(0, 16)) {
      const folder = vscode.workspace.getWorkspaceFolder(u);
      const rel = folder ? vscode.workspace.asRelativePath(u, false) : u.fsPath;
      this.inVisiblePanel(() => this.post({ type: "attach", label: rel, resource: {
        type: "file_mention", uri: u.toString(), path: u.fsPath, relative_path: rel,
        workspace: folder?.name || "",
      } }));
    }
  }

  /** `closedByUser`: the user closed this session's tab (not a reload or a closed window). A turn still
   *  running is then asked about once (keep it running in the background, or stop it), unless the
   *  answer was remembered; anything else in the tab stops, as closing a tab always did. */
  dispose(closedByUser = false): void {
    if (this.liveSessionsTimer) { clearTimeout(this.liveSessionsTimer); this.liveSessionsTimer = undefined; }
    if (this.pipsAttentionTimer) { clearInterval(this.pipsAttentionTimer); this.pipsAttentionTimer = undefined; }
    // A tab's box lets go of a recording it started; the side bar's dictation goes with the window.
    if (this.voiceOffer) clearTimeout(this.voiceOffer);
    if (this.tab) { this.tab.host.dictationService().release(this.micChat); this.tab.host.readAloudService().release(this.micChat); }
    else { this.readAloud?.release(this.micChat); this.readAloud?.release(this.micPips); this.dictation?.dispose(); }
    // Note first, dispose the channel after: a panel teardown is one of the three things that can
    // end a turn, and it is the one the user never sees.
    this.backendNote("[extension: panel disposed — stopping the backend, or leaving a session's work running with no window]");
    this.intentionalShutdown = true;                 // shutting down; do not respawn behind us
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined; }
    if (this.changesRefreshTimer) { clearTimeout(this.changesRefreshTimer); }
    this.changesRefreshDirty = false;
    this.changesRefreshRevision++;
    this.reviewDocuments.clear();
    this.pipsEditor?.dispose();
    // A chat parked in the background still holds a live `dgc serve`. Closing the window must take
    // every one of them with it, or a child outlives the editor that owns it. Chats opened on a
    // process go first: closing one is a command to its process, and a process already stopped
    // started a new `dgc serve` to carry it.
    const all = new Set<ChatBackend>();
    if (this.backend) { all.add(this.backend); }
    for (const slot of this.slots) {
      const parked = slot.backend || (slot.saved?.backend as ChatBackend | undefined);
      if (parked) { all.add(parked); }
    }
    const opened = [...all].filter((be) => (be as OpenedChat).host !== undefined);
    // A tab the user closed: its turn, if one runs on a backend that can carry on with no window, waits
    // for the user's answer (askAboutClosedTab); everything else stops as it always did. A reload or a
    // closed window leaves every backend that can keep its work running with no window doing so.
    const asked = closedByUser && this.tab && this.confirmedTurnActive && this.backend instanceof DgcBackend
      && this.backend.detach ? this.backend : undefined;
    const cause = closedByUser && this.tab ? `${STOP_CAUSE}its tab was closed` : PANEL_DISPOSED_CAUSE;
    for (const be of [...opened, ...[...all].filter((be) => !opened.includes(be)), ...this.releasedHosts]) {
      if (be === asked) { continue; }
      try { be.dispose(cause); } catch { /* already gone */ }
    }
    if (asked) {
      for (const [name, handler] of this.backendListeners.get(asked) || []) { asked.off(name, handler); }
      void DgcViewProvider.askAboutClosedTab(asked, (this.currentSessionName || this.chatLabel()).slice(0, 80));
    }
    if (this.sessionsTimer) { clearTimeout(this.sessionsTimer); this.sessionsTimer = undefined; }
    if (this.tab) {
      // The status bar and the log are the side bar's: a closing tab hands the bar back.
      this.tab.host.tabProviders.delete(this);
      return;
    }
    this.sb.dispose();
    // Last: the backend's exit line arrives after this and still reaches backend.log.
    try { this.backendLog.dispose(); } catch { /* already gone */ }
  }

  /** Q3 (founder, 19 Oct 2026): a session's tab closed while it works is asked about once, "keep it
   *  running in the background, or stop it", and the answer is remembered if ticked
   *  (dgc.closingAWorkingTab, closingTab.ts). Until it is answered the work goes on; dismissed, it keeps running,
   *  where Settings -> Running sessions and the Sessions list show it, with Stop. */
  private static async askAboutClosedTab(be: DgcBackend, name: string): Promise<void> {
    const keep = await keepRunningAfterClose({
      title: `“${name}” was still working when you closed its tab`,
      keep: "It carries on with no window. Open it again from Sessions; Settings › Running sessions can stop it.",
      stop: "Its turn stops now, and the session is saved.",
    });
    try { be.dispose(keep ? PANEL_DISPOSED_CAUSE : `${STOP_CAUSE}its tab was closed`); } catch { /* already gone */ }
  }

  // ---- html ----------------------------------------------------------------
  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2) + String(Date.now());
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const markdown = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "markdown.js"));
    const pipsScript = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "pips.js"));
    const breakdownScript = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "breakdown.js"));
    const pipSetupStyle = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "pip-setup-cards.css"));
    const pipsStyle = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "pips.css"));
    // Mermaid is fetched by the webview only when a diagram is actually rendered, so its ~5MB is
    // never parsed by a panel that shows none. The URI travels as data, not as a script tag.
    const mermaid = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "mermaid.js"));
    const agentMarks = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "agents"));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "codicon.css"));
    // The voice bar: what the box shows while you dictate, the same here, in ChatDGC and in Pips.
    const voicebarCss = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "voicebar.css"));
    const voicebarJs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "voicebar.js"));
    const readAloudJs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "readaloud.js"));
    const msgTimeJs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "msgtime.js"));
    // The prompt rail beside the transcript, the same as ChatDGC's.
    const promptRailJs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "promptrail.js"));
    // `https:` in img-src is what lets a favicon load beside a link the user typed, and it is
    // the same allowance Codex ships. It is NOT what keeps model output from phoning home: the
    // markdown renderer never emits an <img> for model content -- it turns every image into a
    // labelled link the user has to click. That renderer is the guarantee, and
    // model-images-never-render.test.mjs is what holds it still now that the CSP no longer would.
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: blob: https:;`;
    const favicons = vscode.workspace.getConfiguration("dgc").get<boolean>("linkFavicons", true) ? "on" : "off";
    const draftScope = this.draftScope();
    // Where this page is (#3): "home" is the side bar's Sessions home, "tab" a session's editor tab
    // (its key and saved session go in the webview's state, which is what restores it after a reload).
    const place = this.tab ? "tab" : this.home ? "home" : "chat";
    const chatdgcSeen = place === "home" && this.context.globalState.get<boolean>(CHATDGC_SEEN_KEY) === true ? ` data-chatdgc-seen="1"` : "";
    const tabAttrs = this.tab ? ` data-tab-key="${this.tab.key}" data-tab-session="${this.currentSessionSaved ? this.currentSessionId : this.tab.session}"` : "";
    return `<!doctype html><html lang="en" data-draft-scope="${draftScope}" data-pips-document-id="${this.pipsDocumentId}" data-chat-place="${place}"${tabAttrs}${chatdgcSeen}><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DGC</title>
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${css}">
<link rel="stylesheet" href="${voicebarCss}">
<link rel="stylesheet" href="${pipSetupStyle}">
</head><body data-mermaid-src="${mermaid}" data-agent-marks="${agentMarks}" data-link-favicons="${favicons}">
<header id="phead"><button type="button" id="btn-pips-back" class="pips-back" title="Back to DGC chat" aria-label="Back to DGC chat" hidden><span class="codicon codicon-chevron-left" aria-hidden="true"></span>Chat</button><button type="button" id="agent-back" class="agent-back" hidden title="Back to chat" aria-label="Back to chat"><span class="codicon codicon-chevron-left" aria-hidden="true"></span></button><span class="pm"><svg class="mk" viewBox="0 0 90 90" fill="currentColor" aria-hidden="true"><path d="M32 24 L20 30 L13 72 L25 66 Z"/><path d="M54 18 L42 24 L35 72 L47 66 Z"/><path d="M76 24 L64 30 L57 66 L69 60 Z"/></svg>DGC<span class="cur" aria-hidden="true"></span></span><span id="agent-mark" class="agent-mark" hidden aria-hidden="true"></span><button type="button" id="thread-title" class="thread-title" title="Current chat — click to rename" aria-label="Current chat: New chat. Click to rename">New chat</button><button type="button" class="pd" id="pmodel" title="Model — click to change" aria-label="Change model">dgc</button><button type="button" id="btn-pips" class="pips-nav" title="Open Pips" aria-label="Open Pips" aria-pressed="false"><span class="pips-wordmark">Pips</span><span class="pips-nav-core" aria-hidden="true"></span></button><button type="button" id="chat-add" class="chat-add" title="Open a second chat" aria-label="Open a second chat"><span class="codicon codicon-add" aria-hidden="true"></span></button><button type="button" id="chat-add-folder" class="chat-add" title="Open a chat in another folder" aria-label="Open a chat in another folder"><span class="codicon codicon-folder-opened" aria-hidden="true"></span></button></header>
<section id="pips-host" data-style-uri="${pipsStyle}" aria-label="DGC Pips" hidden></section>
<section id="sessions-host" class="sessions-home" aria-labelledby="sessions-title" hidden><section id="sessions-pips" class="home-pips" aria-label="Your Pips" hidden></section><input id="sessions-search" class="sessions-search" type="search" placeholder="Search sessions" aria-label="Search sessions: names and everything said" autocomplete="off" maxlength="200" hidden><div id="home-tabs" class="home-tabs" role="tablist" aria-label="Your chats, or this project's sessions" hidden><button type="button" role="tab" id="home-tab-chat" class="home-tab" aria-controls="chats-home" aria-selected="true" title="Your chats: the same in every folder">Chat<span id="home-tab-chat-count" class="home-tab-count" hidden></span></button><button type="button" role="tab" id="home-tab-work" class="home-tab" aria-controls="work-home" aria-selected="false" tabindex="-1" title="This project's sessions">Work<span id="home-tab-work-count" class="home-tab-count" hidden></span></button></div><section id="chats-home" class="home-chats" aria-labelledby="chats-title" hidden><div class="sessions-head"><h2 id="chats-title">Chat</h2><button type="button" id="chats-new" class="sessions-new" title="Start a new chat in an editor tab"><span class="codicon codicon-add" aria-hidden="true"></span>New chat</button></div><button type="button" id="chats-library" class="home-library" title="Library: every file you attached or ChatDGC made, and every widget, in one place" hidden><span class="codicon codicon-library" aria-hidden="true"></span><span>Library</span></button><div id="projects-home" class="home-projects" hidden><div class="home-sub-head"><h3 id="projects-title" class="home-sub">Projects</h3><button type="button" id="projects-new" class="home-sub-add" title="New project: chats, files and instructions together" aria-label="New project"><span class="codicon codicon-new-folder" aria-hidden="true"></span></button></div><ul id="projects-list" class="projects-list" aria-labelledby="projects-title"></ul></div><h3 id="chats-sub" class="home-sub home-sub-chats" hidden>Chats</h3><p id="chats-status" class="sessions-status" role="status" hidden></p><ul id="chats-list" class="sessions-list" aria-label="Your chats"></ul><button type="button" id="chats-more" class="sessions-more" title="Show more of your chats" hidden>Show more</button></section><section id="work-home" class="home-work" aria-labelledby="sessions-title"><div class="sessions-head"><h2 id="sessions-title">Sessions</h2><button type="button" id="sessions-new" class="sessions-new" title="Start a new session in an editor tab"><span class="codicon codicon-add" aria-hidden="true"></span>New session</button></div><p id="sessions-status" class="sessions-status" role="status">Loading this project's sessions…</p><ul id="sessions-list" class="sessions-list" aria-label="Sessions in this project"></ul><button type="button" id="sessions-more" class="sessions-more" title="Show 200 more sessions" hidden>Load more</button></section></section>
<nav id="chatbar" class="chatbar" hidden aria-label="Running chats"></nav>
<main id="log" role="log" aria-live="off" aria-label="DGC conversation"></main>
<section id="agent-page" hidden>
  <p id="agent-page-meta" class="agent-page-meta"></p>
  <div id="agent-log"></div>
</section>
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
    <label id="goal-budget-label" for="goal-editor-budget">Token budget</label>
    <input id="goal-editor-budget" aria-labelledby="goal-budget-label" type="number" min="0" max="1000000000000" step="1" aria-describedby="goal-budget-hint" placeholder="No limit" />
    <p id="goal-budget-hint">Total reported tokens for this goal. Leave blank to remove the limit. Paused goals stay paused until you resume.</p>
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
<div id="agent-map" class="modal-layer agent-map-layer" role="dialog" aria-modal="true" aria-labelledby="agent-map-title" aria-describedby="agent-map-subtitle" hidden>
  <div id="agent-map-box" class="agent-map" data-layout="vertical" tabindex="-1">
    <div class="agent-map-head">
      <div class="agent-map-titles"><h2 id="agent-map-title">Agent map</h2><p id="agent-map-subtitle" class="agent-map-subtitle"></p></div>
      <button type="button" id="agent-map-close" class="fbtn agent-map-close" title="Close" aria-label="Close the agent map"><span class="codicon codicon-close" aria-hidden="true"></span></button>
    </div>
    <div id="agent-map-body" class="agent-map-body">
      <div id="agent-map-tree" class="am-tree"></div>
      <p id="agent-map-more" class="am-note" hidden></p>
      <section id="agent-map-tasks" class="am-tasks" aria-labelledby="agent-map-tasks-title" hidden>
        <h3 id="agent-map-tasks-title" class="agent-map-subtitle"></h3>
        <ul id="agent-map-task-list" class="am-task-list"></ul>
      </section>
      <button type="button" id="agent-map-settings" class="link am-settings" title="Open Settings ▸ Agents to change the sub-agent model and host">Sub-agent settings</button>
    </div>
  </div>
</div>
<div id="agent-card" class="modal-layer agent-map-layer am-card-layer" role="dialog" aria-modal="true" aria-labelledby="agent-card-title" aria-describedby="agent-card-meta" hidden>
  <div id="agent-card-box" class="agent-map am-window am-card-window" tabindex="-1">
    <div class="agent-map-head">
      <button type="button" id="agent-card-back" class="fbtn agent-map-back" title="Back to the agent map" aria-label="Back to the agent map"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>
      <span id="agent-card-dot" class="agent-dot agent-map-head-dot" aria-hidden="true"></span>
      <div class="agent-map-titles"><h2 id="agent-card-title"></h2><p id="agent-card-meta" class="agent-map-subtitle"></p></div>
    </div>
    <div id="agent-card-body" class="agent-map-body am-card"></div>
  </div>
</div>
<div id="agent-transcript" class="modal-layer agent-map-layer am-transcript-layer" role="dialog" aria-modal="true" aria-labelledby="agent-transcript-title" aria-describedby="agent-transcript-meta" hidden>
  <div id="agent-transcript-box" class="agent-map am-window am-transcript-window" tabindex="-1">
    <div class="agent-map-head">
      <button type="button" id="agent-transcript-back" class="fbtn agent-map-back" title="Back" aria-label="Back"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>
      <span id="agent-transcript-dot" class="agent-dot agent-map-head-dot" aria-hidden="true"></span>
      <div class="agent-map-titles"><h2 id="agent-transcript-title"></h2><p id="agent-transcript-meta" class="agent-map-subtitle"></p><p id="agent-transcript-sub" class="agent-map-subtitle"></p></div>
    </div>
    <div id="agent-transcript-body" class="agent-map-body am-transcript-body"><div id="agent-transcript-log" class="am-transcript-log"></div></div>
  </div>
</div>
<div id="pop" class="pop" role="listbox" aria-label="Suggestions"></div>
<footer>
  <div id="rail-line" class="rail-line">
    <div id="rail-chips" class="rail-chips" role="toolbar" aria-label="Running in this chat" hidden></div>
    <div id="queued" role="status" aria-live="polite"></div>
    <button type="button" id="workspace-changes" class="rail-text-action" title="Review all workspace changes since the last Git commit"><span class="codicon codicon-diff" aria-hidden="true"></span><span class="workspace-changes-label">Workspace changes</span></button>
    <div id="rail-pop" class="rail-pop" role="dialog" aria-modal="false" aria-labelledby="rail-pop-title" tabindex="-1" hidden>
      <div class="rail-pop-head"><span id="rail-pop-title" class="rail-pop-title"></span><button type="button" id="rail-pop-close" class="rail-icon-button" title="Close" aria-label="Close"><span class="codicon codicon-close" aria-hidden="true"></span></button></div>
      <div id="rail-pop-body" class="rail-pop-body"></div>
      <div id="rail-pop-links" class="rail-pop-links" hidden></div>
    </div>
  </div>
  <div id="elsewhere-bar" class="elsewhere-bar" role="status" hidden><span class="codicon codicon-multiple-windows" aria-hidden="true"></span><span id="elsewhere-text" class="elsewhere-text"></span><button type="button" id="elsewhere-open" class="act primary" title="Carry on with this session in this window; the other window shows it read-only">Open here</button></div>
  <div id="composer-rail" aria-label="Current work" hidden>
    <section id="pipsbar" class="rail-item" aria-label="Pips digest" hidden>
      <div id="pips-digest-panel" class="pips-digest-panel" role="region" aria-label="What your Pips found" hidden></div>
      <button type="button" id="pips-digest-main" class="rail-main" aria-expanded="false" aria-controls="pips-digest-panel" title="Show what your Pips found"><span class="pips-digest-icon codicon codicon-bell rail-icon" aria-hidden="true"></span><span class="pips-digest-label">Pips</span><span id="pips-digest-text"></span></button>
      <button type="button" id="pips-digest-open" class="rail-text-action" title="Open the Pips view">Open</button>
      <button type="button" id="pips-digest-dismiss" class="rail-text-action" title="Mark this digest seen until something new">Dismiss</button>
    </section>
    <section id="monitorsbar" class="rail-item" aria-label="Background monitors" hidden>
      <div class="rail-row">
        <span class="monitors-icon codicon codicon-pulse rail-icon" aria-hidden="true"></span>
        <span id="monitors-count" class="monitors-count">Monitors</span>
        <div id="monitor-chips" class="monitor-chips" role="list" aria-label="Running monitors"></div>
        <span id="monitors-paused" class="monitors-paused" title="Wake-ups are paused: new events wait for your next message" hidden>paused</span>
      </div>
    </section>
    <section id="troupebar" class="rail-item" aria-label="Troupes" data-state="running" hidden>
      <div id="troupe-panel" class="troupe-panel" role="region" aria-label="Troupe stages" hidden></div>
      <div class="rail-row">
        <button type="button" id="troupe-main" class="rail-main" aria-expanded="false" aria-controls="troupe-panel" title="Show the troupe's stages"><span id="troupe-mark" class="troupe-mark" aria-hidden="true"></span><span id="troupe-label" class="troupe-label">Troupe</span><span id="troupe-title"></span><span id="troupe-mini" class="troupe-bar troupe-mini" aria-hidden="true"><span></span></span><span id="troupe-count"></span></button>
        <div class="goal-actions">
          <button type="button" id="troupe-stop" class="rail-icon-button" title="Stop the troupe" aria-label="Stop the troupe"><span class="codicon codicon-debug-stop" aria-hidden="true"></span></button>
          <button type="button" id="troupe-dismiss" class="rail-icon-button" title="Dismiss" aria-label="Dismiss" hidden><span class="codicon codicon-close" aria-hidden="true"></span></button>
          <button type="button" id="troupe-toggle" class="rail-icon-button" aria-expanded="false" aria-controls="troupe-panel" title="Show the troupe's stages" aria-label="Show the troupe's stages"><span class="codicon codicon-chevron-up" aria-hidden="true"></span></button>
        </div>
      </div>
      <span id="troupe-status" class="sr-only" role="status"></span>
    </section>
    <section id="changesbar" class="rail-item" aria-label="Changes in this chat" hidden>
      <button type="button" id="changes-main" class="rail-main" aria-label="Review changed files" title="Every file this chat has changed, with its diff"><span class="codicon codicon-diff-multiple rail-icon" aria-hidden="true"></span><span id="changes-count">1 file changed in this chat</span><span id="changes-add" class="change-add">+0</span><span id="changes-del" class="change-del">−0</span></button>
      <button type="button" id="changes-review-button" class="rail-text-action" title="Open the list of changed files">Review</button>
    </section>
    <section id="tasksbar" class="rail-item" aria-label="Session tasks" data-status="pending" hidden>
      <div id="tasks-panel" class="tasks-panel" hidden><div id="tasks-list" role="list" aria-label="Checklist"></div></div>
      <div class="rail-row">
        <button type="button" id="tasks-main" class="rail-main" aria-expanded="false" aria-controls="tasks-panel" aria-label="Tasks" title="Show the checklist"><span class="tasks-icon codicon codicon-checklist rail-icon" aria-hidden="true"></span><span id="tasks-count">Tasks 0/0</span><span id="tasks-text"></span><span id="tasks-blocked" hidden></span></button>
        <span id="tasks-note" class="tasks-note" role="status" hidden></span>
        <div class="goal-actions">
          <button type="button" id="tasks-clear" class="rail-icon-button" title="Clear the checklist" aria-label="Clear the checklist"><span class="codicon codicon-trash" aria-hidden="true"></span></button>
          <button type="button" id="tasks-toggle" class="rail-icon-button" aria-expanded="false" aria-controls="tasks-panel" title="Show the checklist" aria-label="Show the checklist"><span class="codicon codicon-chevron-up" aria-hidden="true"></span></button>
        </div>
      </div>
    </section>
    <section id="goalbar" class="rail-item" aria-label="Standing goal" hidden>
      <button type="button" id="goal-main" class="rail-main" aria-label="Expand and edit goal" title="Read and edit the standing objective"><span class="goal-icon codicon codicon-target rail-icon" aria-hidden="true"></span><span id="goal-status">Pursuing goal</span><span id="goal-text"></span><time id="goal-time">0:00</time></button>
      <div class="goal-actions">
        <button type="button" id="goal-review-button" class="rail-icon-button" title="Review goal" aria-label="Review goal"><span class="codicon codicon-inspect" aria-hidden="true"></span></button>
        <button type="button" id="goal-clear" class="rail-icon-button" title="Clear goal" aria-label="Clear goal"><span class="codicon codicon-trash" aria-hidden="true"></span></button>
        <button type="button" id="goal-toggle" class="rail-icon-button" title="Pause goal" aria-label="Pause goal"><span class="codicon codicon-debug-pause" aria-hidden="true"></span></button>
        <button type="button" id="goal-edit" class="rail-icon-button" title="Edit goal" aria-label="Edit goal"><span class="codicon codicon-edit" aria-hidden="true"></span></button>
      </div>
      <div id="goal-detail" class="goal-detail" role="region" aria-label="Goal detail" tabindex="0" hidden></div>
    </section>
    <section id="pastebar" class="rail-item" aria-label="Invisible characters in this draft" data-status="noise" hidden>
      <button type="button" id="paste-strip" class="rail-main" aria-label="Remove the invisible characters" title="Remove them from the draft"><span class="paste-icon codicon codicon-eye-closed rail-icon" aria-hidden="true"></span><span id="paste-count">Remove 0 invisible characters</span></button>
      <button type="button" id="paste-keep" class="rail-text-action" title="Send the text exactly as pasted">Keep</button>
    </section>
  </div>
  <div id="cbox" data-mode="default">
    <div id="attachments" aria-label="Attached context"></div>
    <div class="cinput"><span class="pmark" aria-hidden="true">❯</span><div id="input" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Ask DGC to build, fix or explain…" aria-label="Message DGC" aria-controls="pop" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false"></div></div>
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
          <div class="context-head"><div><span class="context-kicker">Context window</span><strong id="ctx-used">0 / 0</strong><span id="ctx-max" class="context-max" hidden></span></div><span id="ctx-pct">0%</span></div>
          <div class="context-track" aria-hidden="true"><span id="ctx-fill"></span></div>
          <div class="context-split"><span id="ctx-free">0 free</span><span id="ctx-auto">auto at 85%</span></div>
          <div id="ctx-breakdown" hidden></div>
          <div class="context-size">
            <label for="ctx-size" class="context-kicker">Window size</label>
            <div class="context-size-controls">
              <span id="ctx-size-server" class="context-size-server" hidden></span>
              <input id="ctx-size-custom" class="context-size-custom" type="number" min="2048" step="1024" inputmode="numeric" placeholder="tokens" aria-label="Custom context window in tokens" hidden>
              <select id="ctx-size" class="context-size-select" aria-label="Context window size" title="How much conversation the model is sent, in tokens">
                <option value="8192">8K</option><option value="16384">16K</option><option value="32768">32K</option>
                <option value="65536">64K</option><option value="131072">128K</option><option value="262144">256K</option>
                <option value="524288">512K</option><option value="1048576">1M</option><option value="custom">Custom\u2026</option>
              </select>
            </div>
          </div>
          <p id="ctx-size-note" class="context-size-note" hidden></p>
          <div id="ctx-usage" class="context-usage">0 in · 0 out · 0 requests</div>
          <div class="context-last"><span class="codicon codicon-history" aria-hidden="true"></span><span id="ctx-last">DGC compacts automatically near 85%.</span></div>
          <p id="ctx-detail" class="context-detail" hidden></p>
          <button type="button" id="ctx-compact" class="context-action" title="Summarise the conversation now so the model has room to keep working">Compact now</button>
        </section>
      </div>
      <!-- The prompt cache's clock (0.48, Work only): hidden unless the provider says how long its cache lasts. -->
      <span id="cache-clock" class="fbtn cache-clock" role="status" aria-live="off" data-cache-window="unknown" hidden><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5C14.1421 2.5 17.5 5.85786 17.5 10C17.5 14.1421 14.1421 17.5 10 17.5C5.85786 17.5 2.5 14.1421 2.5 10C2.5 5.85786 5.85786 2.5 10 2.5ZM10 3.5C6.41015 3.5 3.5 6.41015 3.5 10C3.5 13.5899 6.41015 16.5 10 16.5C13.5899 16.5 16.5 13.5899 16.5 10C16.5 6.41015 13.5899 3.5 10 3.5ZM10 5C10.2761 5 10.5 5.22386 10.5 5.5V9.66895L13.6973 11.04L13.7852 11.0898C13.9763 11.2224 14.0552 11.4751 13.96 11.6973C13.8647 11.9193 13.6272 12.0372 13.3994 11.9902L13.3027 11.96L9.80273 10.46C9.61896 10.3811 9.5 10.2 9.5 10V5.5C9.5 5.22386 9.72386 5 10 5Z" fill="currentColor"/></svg><span id="cache-clock-left" class="cache-clock-left"></span></span>
      <button type="button" id="btn-settings" class="fbtn" title="Settings" aria-label="Open settings"><span class="codicon codicon-settings-gear" aria-hidden="true"></span></button>
      <div class="picker">
        <button type="button" id="btn-mode" class="fbtn mode" title="Permission mode — Shift+Tab to cycle" aria-label="Permission mode: default" aria-haspopup="menu" aria-expanded="false"><span id="modeicon" class="codicon codicon-shield" aria-hidden="true"></span> <span id="modelabel">default</span></button>
        <div id="modemenu" class="cmenu" role="menu" aria-label="Permission mode" hidden></div>
      </div>
      <button type="button" id="btn-goal" class="fbtn goal-control" data-state="none" hidden><span class="codicon codicon-target" aria-hidden="true"></span> <span id="goal-control-label">Goal</span></button>
      </div>
      <div class="cf-right">
      <div class="picker agents-picker" id="agents-picker" hidden>
        <button type="button" id="agents-pill" class="fbtn agents-pill" data-state="idle" title="No agents working · Click to open the agent map" aria-label="0 agents · No agents working · Click to open the agent map" aria-haspopup="dialog" aria-expanded="false" aria-controls="agent-map"><span class="agents-dot" aria-hidden="true"></span><span class="agents-label"><span class="agents-text">0 agents</span><span class="agents-short">0</span><span class="agents-need" hidden> · needs you</span></span></button>
      </div>
      <div class="picker">
        <button type="button" id="btn-model" class="fbtn mode model-control" title="Model and reasoning — click to change" aria-label="Change model and reasoning" aria-haspopup="menu" aria-expanded="false"><span class="codicon codicon-zap model-icon" aria-hidden="true"></span><span class="model-copy"><span id="modelname">dgc</span><span id="effortname">off</span></span><span class="codicon codicon-chevron-up model-chevron" aria-hidden="true"></span></button>
        <div id="modelmenu" class="cmenu" role="menu" aria-label="Model" hidden></div>
      </div>
      <button type="button" id="queue-send" class="fbtn" title="Queue for the next turn — Alt+Enter" aria-label="Queue for next turn" hidden>Queue</button>
      <button type="button" id="stop-run" class="fbtn" title="Stop generation" aria-label="Stop generation" hidden><span class="codicon codicon-debug-stop" aria-hidden="true"></span></button>
      <button type="button" id="btn-mic" class="fbtn mic-control" title="Dictate" aria-label="Dictate"><span class="codicon codicon-mic" aria-hidden="true"></span></button>
      <button type="button" id="send" class="csend" data-mode="default" title="Send" aria-label="Send message"><span class="codicon codicon-arrow-up" aria-hidden="true"></span></button>
      </div>
    </div>
    <div id="cvoice" class="cvoice"></div>
  </div>
  <div id="followup-hint" hidden></div>
</footer>
<script nonce="${nonce}" src="${markdown}"></script>
<script nonce="${nonce}" src="${breakdownScript}"></script>
<script nonce="${nonce}" src="${pipsScript}"></script>
<script nonce="${nonce}" src="${voicebarJs}"></script>
<script nonce="${nonce}" src="${msgTimeJs}"></script>
<script nonce="${nonce}" src="${promptRailJs}"></script>
<script nonce="${nonce}" src="${readAloudJs}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}
