/**
 * One isolated DGC session: at most one active run (plus follow-ups queued behind it).
 * Mirrors sdk/python/dgc_sdk/session.py.
 */
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { DGCCommandRejectedError, DGCConfigError, DGCError, DGCRuntimeError, DGCTimeoutError, DGCUnsupportedError } from "./errors.ts";
import type { Frame, Transport } from "./transport.ts";
import { longTimer } from "./transport.ts";
import { assertSupported, extractJson, validate as validateSchema } from "./schema.ts";
import type { ToolHub } from "./tools.ts";
import type { AuditLog } from "./audit.ts";
import type { UsageLog, UsageTotals } from "./usage.ts";
import { USAGE_TOTAL_KEYS, costUsd, emptyTotals, reported, usageDelta, usageTotals } from "./usage.ts";
import { diffWorkspace, snapshotWorkspace, type Snapshot } from "./changes.ts";
import { resolvePermission, type Policy } from "./policy.ts";
import { Pips } from "./pips.ts";
import type { StateLock } from "./state.ts";
import type {
  AbortSignalLike, AgentInfo, Artifact, ArtifactInfo, Denial, Checkpoint, ContextBreakdown, ContextPart, McpInputResponse, PermissionAction, PermissionRequest, Pricing,
  QuestionRequest, RunEvent, RunOptions, RunResult, RunStatus, SandboxStatus, SessionInfo,
  SessionOptions, TaskItem, ToolRecord, VerificationResult,
} from "./types.ts";

const LOOPBACK = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/\S+/gi;
// Control events left on the pipe after resume/fork/rewind; not attributed to the next run.
const IDLE_EVENT_TYPES = new Set([
  "history", "agents", "context", "goal_changed", "monitors", "info", "todos",
  "session", "session_named", "handoff_started", "ready", "config", "mode_changed",
]);
const TASK_MAP: Record<string, TaskItem["status"]> = {
  done: "completed", completed: "completed", in_progress: "in_progress", progress: "in_progress",
  blocked: "blocked", cancelled: "cancelled", canceled: "cancelled", pending: "pending", todo: "pending",
};
const TERMINAL = new Set<RunStatus>(["completed", "cancelled", "failed", "paused"]);
const DECISION_EVENTS = new Set(["permission_request", "plan_proposal", "options_request", "mcp_input_request"]);
const AUDIT_EVENTS = new Set([
  "turn_start", "turn_end", "tool_call", "tool_result", "tool_denied", "permission_request", "error",
]);
const AUDIT_FIELDS = [
  "name", "id", "reason", "summary", "path", "message", "is_error", "args", "output", "diff",
  "command", "turn_id", "request_id", "call_id",
];
const SLICE_MS = 500;            // longest a pump waits on the pipe before re-checking deadlines
const CANCEL_GRACE_MS = 10_000;  // after a cancel, how long to wait for the turn to end
const TIMEOUT_GRACE_MS = 5_000;  // after a run timeout, how long to wait for the cancelled turn
const STEER_GRACE_MS = 5_000;    // after the last turn, how long to wait for a steer's outcome
const BILLING_WAIT_MS = 2_000;   // after the last turn, how long to wait for its usage totals
const VERIFY_STARTED = "⧗ verify:";

function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function warn(message: string): void {
  process.emitWarning(message, { code: "DGC_SDK" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function mapping(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function exitCode(output: string): number | null {
  const lowered = (output || "").toLowerCase();
  const at = lowered.indexOf("exit code:");
  if (at < 0) return null;
  const word = lowered.slice(at + "exit code:".length).trim().split(/\s+/)[0];
  const code = Number.parseInt(word, 10);
  return Number.isNaN(code) ? null : code;
}

function sameCommand(left: string, right: string): boolean {
  return String(left || "").split(/\s+/).filter(Boolean).join(" ") === String(right || "").split(/\s+/).filter(Boolean).join(" ");
}

function agentFromRow(row: Record<string, unknown>): AgentInfo {
  return {
    id: String(row.id || ""),
    state: String(row.state || ""),
    description: String(row.description || ""),
    parentId: row.parent_id ? String(row.parent_id) : null,
  };
}

/** Best-effort category for a `tool_denied` reason (see {@link Denial}). */
export function denialSource(reason: string): Denial["source"] {
  const low = (reason || "").toLowerCase();
  if (low.includes("pretooluse hook") || low.includes("blocked by a pretooluse")) return "hook";
  if (low.includes("plan mode") || low.includes("monitor event") || low.includes("approve on your next prompt")) return "mode";
  if (low.includes("deny rule") || low.includes("session policy") || low.includes("outside the project")
      || low.includes("application running this session") || low.includes("the application's")) return "policy";
  if (low.includes("denied by the user") || low.includes("the user denied") || low === "denied") return "callback";
  return "runtime";
}

function checkTimeout(timeoutMs: unknown, name = "timeoutMs"): void {
  if (timeoutMs === undefined || timeoutMs === null) return;
  if (typeof timeoutMs !== "number" || !(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
    throw new DGCConfigError(`${name} must be a positive number of milliseconds, or null for no limit`);
  }
}

/** Pump-side state of one run. Outcome events for its prompt ids land here, whoever reads them. */
export const ARTIFACT_OUTPUTS: readonly string[] = ["auto", "document", "slides", "spreadsheet", "page", "dashboard"];

export function artifactInfo(row: unknown): ArtifactInfo {
  const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const versions = (Array.isArray(r.versions) ? r.versions : []).filter((v) => v && typeof v === "object").map((v) => {
    const x = v as Record<string, unknown>;
    return { n: Number(x.n || 0), author: String(x.author || ""), at: String(x.at || ""),
             summary: String(x.summary || ""), size: Number(x.size || 0) };
  });
  return { id: String(r.id || ""), type: String(r.type || ""), title: String(r.title || ""),
           version: Number(r.version || 0), label: String(r.label || ""), created: String(r.created || ""),
           updated: String(r.updated || ""), origin: (r.origin && typeof r.origin === "object" ? r.origin : {}) as Record<string, unknown>,
           exports: (Array.isArray(r.exports) ? r.exports : []).map(String),
           ...(r.file ? { file: String(r.file) } : {}), versions };
}

type ArtifactRequest = (command: Frame, answer: string, timeoutMs?: number) => Promise<Record<string, unknown>>;

/** `session.mods`: the mods this session runs (CLI 0.50+): the user's allowed ones and those named with
 *  `session({ mods: [...] })`. */
export class Mods {
  private readonly ask: ArtifactRequest;

  constructor(ask: ArtifactRequest) {
    this.ask = ask;
  }

  /** Every mod this session knows: {name, title, state, error, asks, commands, ...}. */
  async list(): Promise<Array<Record<string, unknown>>> {
    const event = await this.ask({ type: "mods_list", request_id: newId("mods") }, "mods");
    return Array.isArray(event.mods) ? (event.mods as Array<Record<string, unknown>>) : [];
  }

  /** A mod's own command, at once, with no model turn: {mod, text?, tree?, error?}. */
  async run(name: string, args = ""): Promise<Record<string, unknown>> {
    const event = await this.ask({ type: "mod_command", request_id: newId("mods"), name, args }, "mod_result");
    return Object.fromEntries(Object.entries(event).filter(([k]) => ["mod", "text", "tree", "error"].includes(k)));
  }
}

type CardSend = (command: Frame) => void;

/** `session.cards`: plugins' own cards (MCP Apps, the open MCP extension io.modelcontextprotocol/ui; CLI 0.51+,
 *  `capabilities.mcp_apps`). Call `watch()` once: from then on a tool whose server gave it a card shows it as an
 *  `mcp_app_card` event in the run (card_id, plugin, tool, tool_input, the tool's whole tool_result, `url` where the CLI
 *  serves the page with its CSP, `html` when it fits one frame), and history replays it. To draw one yourself, frame
 *  `url` (or `get()` it and serve `html` with `csp_header`) in a sandboxed iframe and answer its MCP Apps JSON-RPC:
 *  `tools/call` and `resources/read` go to `call()`, `ui/update-model-context` to `context()`, and a `ui/message` is the
 *  user's own prompt, labelled with `messageText()`. A change comes back as `{ask}` (DGC's Allow card) until you
 *  `answer()` it with the user's choice. */
export class Cards {
  private readonly ask: ArtifactRequest;
  private readonly send: CardSend;

  constructor(ask: ArtifactRequest, send: CardSend) {
    this.ask = ask;
    this.send = send;
  }

  /** This app draws cards: the CLI makes them from now on. */
  watch(): void {
    this.send({ type: "watch_mcp_apps" });
  }

  /** One card with its page (`html`), its whole result and the exact CSP header (`csp_header`) the CLI serves it with. */
  async get(cardId: string): Promise<Record<string, unknown>> {
    const event = await this.ask({ type: "mcp_app_get", request_id: newId("card"), card_id: cardId }, "mcp_app_resource");
    return Object.fromEntries(Object.entries(event).filter(([k]) => !["type", "seq", "request_id"].includes(k)));
  }

  /** What the card asked of its own server: `{result}`, `{error}`, or `{ask, request_id}` for `answer()`. */
  async call(cardId: string, method: "tools/call" | "resources/read", params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const requestId = newId("card");
    const event = await this.ask({ type: "mcp_app_call", request_id: requestId, card_id: cardId, method, params }, "mcp_app_reply");
    if (event.ask && typeof event.ask === "object") return { ask: { ...event.ask, request_id: requestId }, request_id: requestId };
    const out = Object.fromEntries(Object.entries(event).filter(([k]) => k === "result" || k === "error"));
    return Object.keys(out).length ? out : { result: {} };
  }

  /** The user's choice on an Allow card `call()` returned: "once", "always" (only when `ask.always`) or "deny". */
  async answer(asked: { ask?: Record<string, unknown>; request_id?: string; ask_id?: string },
    choice: "once" | "always" | "deny"): Promise<Record<string, unknown>> {
    if (!["once", "always", "deny"].includes(choice)) throw new TypeError("choice is once, always or deny");
    const ask = (asked.ask && typeof asked.ask === "object" ? asked.ask : asked) as Record<string, unknown>;
    if (typeof asked.request_id !== "string" || !asked.request_id.trim()) {
      throw new TypeError("pass the card question returned by call, including its request_id");
    }
    const event = await this.ask({ type: "mcp_app_answer", ask_id: String(ask.ask_id || ""), choice,
                                   request_id: asked.request_id }, "mcp_app_reply");
    const out = Object.fromEntries(Object.entries(event).filter(([k]) => k === "result" || k === "error"));
    return Object.keys(out).length ? out : { result: {} };
  }

  /** A card's ui/update-model-context: the model's next turn in that chat gets it once, as untrusted plugin content. */
  context(cardId: string, content: Array<Record<string, unknown>> = [], structured: Record<string, unknown> = {}): void {
    this.send({ type: "mcp_app_context", card_id: cardId, content: content.slice(0, 32), structured_content: structured });
  }

  /** A card's ui/message as the user's prompt, labelled as DGC's editor labels it. */
  static messageText(card: { plugin?: unknown; server?: unknown }, text: string): string {
    return `From ${String(card.plugin || card.server || "a plugin")}'s card: ${String(text).trim().slice(0, 8000)}`;
  }
}

const ROUTER_ACTIONS = ["turn_on", "turn_off", "add_system", "edit_system", "remove_system", "enable_system",
  "disable_system", "set_model", "set_jobs", "set_when_busy", "set_key", "prefer", "apply_suggestion"];
const ROUTER_FIELDS = new Set(["system", "name", "base_url", "jobs", "models", "workers", "one_model_at_a_time",
  "memory_gb", "model", "use", "context", "note", "when_busy", "key"]);

/** `session.router`: DGC Router, the user's other computers that run models, for sub-agents and Pips (CLI 0.51+,
 *  `capabilities.router`). The answers are the CLI's status objects. A key is set only with `setKey`, never read. */
/** A context size as Settings' box and `dgc router --context` read it: 16384, "16384", "16,384", "16K" or "16k" (K is
 *  1,024 tokens), 2,048 to 16,777,216 tokens. Throws DGCConfigError. */
export function contextTokens(value: unknown): number {
  let tokens: number;
  if (typeof value === "number") tokens = value;
  else if (typeof value === "string") {
    const raw = value.trim().toLowerCase().replace(/[,_\s]/g, "");
    const scale = raw.endsWith("k") ? 1024 : 1;
    const digits = scale > 1 ? raw.slice(0, -1) : raw;
    if (!/^\d+(\.\d+)?$/.test(digits)) throw new DGCConfigError('context is a number of tokens, like 16384 or "16K"');
    tokens = Math.round(Number(digits) * scale);
    if (scale === 1 && !Number.isInteger(Number(digits))) throw new DGCConfigError('context is a whole number of tokens, like 16384 or "16K"');
  } else throw new DGCConfigError('context is a number of tokens, like 16384 or "16K"');
  if (!Number.isInteger(tokens) || tokens < 2048 || tokens > 16_777_216) {
    throw new DGCConfigError("context is between 2,048 and 16,777,216 tokens (2K and up)");
  }
  return tokens;
}

export class Router {
  private readonly ask: ArtifactRequest;
  private readonly commands: string[];

  constructor(ask: ArtifactRequest, commands: string[] = []) {
    this.ask = ask;
    this.commands = commands;
  }

  private needs(command: string): void {
    if (!this.commands.includes(command)) throw new DGCUnsupportedError(`This DGC CLI has no ${command}; update it (dgc update).`);
  }

  private async send(command: Frame, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.ask({ ...command, request_id: newId("router") }, "router_status", timeoutMs);
  }

  /** Every system with its jobs, models, workers busy and free, health and measured speed. */
  async status(options: { refresh?: boolean } = {}): Promise<Record<string, unknown>> {
    const event = await this.send({ type: "router_status", ...(options.refresh ? { refresh: true } : {}) },
      options.refresh ? 60_000 : undefined);
    return mapping(event.status);
  }

  /** One change, made at once: `{change, status}`. The fields are those of the router_update tool. */
  async update(action: string, fields: Record<string, unknown> = {}): Promise<{ change: string; status: Record<string, unknown> }> {
    if (!ROUTER_ACTIONS.includes(action)) throw new DGCConfigError(`action must be one of ${ROUTER_ACTIONS.join(", ")}`);
    if ("key" in fields && action !== "set_key") throw new DGCConfigError("a key goes only with set_key (router.setKey)");
    const unknown = Object.keys(fields).filter((key) => !ROUTER_FIELDS.has(key)).sort();
    if (unknown.length) throw new DGCConfigError(`router update has no field "${unknown[0]}"`);
    const clean = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
    if (clean.context !== undefined) clean.context = contextTokens(clean.context);     // 16384, "16K" or "16k"
    const event = await this.send({ type: "router_update", action, ...clean }, 60_000);
    return { change: typeof event.change === "string" ? event.change : "", status: mapping(event.status) };
  }

  /** Add a computer by its address: DGC detects the server and lists its models. */
  addSystem(baseUrl: string, fields: Record<string, unknown> = {}): Promise<{ change: string; status: Record<string, unknown> }> {
    return this.update("add_system", { ...fields, base_url: baseUrl });
  }

  /** Save (or with "" remove) a system's key in the user's secrets.json, bound to its address. */
  setKey(system: string, key: string): Promise<{ change: string; status: Record<string, unknown> }> {
    if (typeof key !== "string") throw new DGCConfigError("key must be a string");
    return this.update("set_key", { system, key });
  }

  /** Test one system now (models, speed, parallel, tools) and save the results. */
  async probe(system: string, options: { model?: string; checks?: string[] } = {}): Promise<Record<string, unknown>> {
    const command: Frame = { type: "router_probe", system };
    if (options.model) command.model = options.model;
    if (options.checks) command.checks = [...options.checks];
    return mapping((await this.send(command, 300_000)).probe);
  }

  /** Model servers on this computer's own /24, the known ports only. */
  async find(): Promise<Record<string, unknown>> {
    return mapping((await this.send({ type: "router_find" }, 120_000)).found);
  }

  /** Where the next turn's helpers run (call before `run`); no system lets DGC pick. */
  prefer(system?: string, model?: string): Promise<{ change: string; status: Record<string, unknown> }> {
    return this.update("prefer", { system: system ?? "", model: model ?? "" });
  }

  /** A system's hardware readout (CLI 0.51+): `url` is an exporter's (node_exporter, NVIDIA DCGM, AMD's, Glances,
   *  Netdata) or a dgc node's address, which the CLI detects; "" stops it. `token` is a dgc node's pairing token, kept
   *  in the user's secrets.json bound to that address and never read back. With neither, it reads the hardware now. */
  async setHardware(system: string, url?: string, options: { token?: string } = {}): Promise<{ change: string; status: Record<string, unknown> }> {
    this.needs("router_hardware");
    const command: Frame = { type: "router_hardware", system };
    if (url !== undefined) {
      if (typeof url !== "string") throw new DGCConfigError("url must be a string");
      command.url = url;
    }
    if (options.token !== undefined) {
      if (typeof options.token !== "string") throw new DGCConfigError("token must be a string");
      command.token = options.token;
    }
    const event = await this.send(command, 60_000);
    return { change: typeof event.change === "string" ? event.change : "", status: mapping(event.status) };
  }

  /** Workers per model for one system (CLI 0.51+), from its memory, what the server reports and what Test measured;
   *  each model's `line` shows the arithmetic. `update("apply_suggestion", { system, context })` uses it. */
  async suggest(system: string, options: { context?: number | string } = {}): Promise<Record<string, unknown>> {
    this.needs("router_suggest");
    const command: Frame = { type: "router_suggest", system, request_id: newId("router") };
    if (options.context !== undefined) command.context = contextTokens(options.context);
    return mapping((await this.ask(command, "router_suggestion", 30_000)).suggestion);
  }
}

const IMAGE_ACTIONS = ["add_generator", "edit_generator", "remove_generator", "set_default", "set_project_choice",
  "set_auto_fallback", "set_save_dir", "set_key", "test"];
const IMAGE_FIELDS = new Set(["generator", "provider", "base_url", "name", "id", "model", "size", "steps",
  "negative_prompt", "asks", "good_for", "enabled", "monthly_limit_usd", "system", "default", "workflow", "mapping",
  "confirm", "auto_fallback", "save_dir", "key", "makes", "video_asks", "video_pips"]);

/** Options for `session.images.generate`. */
export interface ImageGenerateOptions {
  size?: string; aspect?: string; count?: number; images?: string[]; mask?: string; generator?: string;
  model?: string; seed?: number; negativePrompt?: string; saveTo?: string; approve?: boolean; timeoutMs?: number;
}

/** `session.images`: the user's image generators (CLI 0.51+, `capabilities.images`). `generate` makes pictures now,
 *  each with a sidecar in DGC's own folder (in the project with `saveTo`); a paid generator that asks before each image runs only with
 *  `approve: true`. A key is set only with `setKey`, never read back. Once any call is made here, the session's runs
 *  also carry `images_made` events when the model's generate_image made pictures. */
export class Images {
  private readonly ask: ArtifactRequest;

  constructor(ask: ArtifactRequest) {
    this.ask = ask;
  }

  private send(command: Frame, answer: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.ask({ ...command, request_id: newId("images") }, answer, timeoutMs);
  }

  /** Every generator: what it can do, its price, whether it works now, and this project's choice. */
  async generators(options: { refresh?: boolean } = {}): Promise<Record<string, unknown>> {
    const event = await this.send({ type: "images_list", ...(options.refresh ? { refresh: true } : {}) },
      "images_status", options.refresh ? 60_000 : undefined);
    return mapping(event.status);
  }

  /** One change, made at once: `{change, status, pending?, notes?, tested?}`. */
  async update(action: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!IMAGE_ACTIONS.includes(action)) throw new DGCConfigError(`action must be one of ${IMAGE_ACTIONS.join(", ")}`);
    if ("key" in fields && action !== "set_key") throw new DGCConfigError("a key goes only with set_key (images.setKey)");
    const unknown = Object.keys(fields).filter((key) => !IMAGE_FIELDS.has(key)).sort();
    if (unknown.length) throw new DGCConfigError(`images update has no field "${unknown[0]}"`);
    const clean = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
    const event = await this.send({ type: "images_update", action, ...clean }, "images_status", 60_000);
    return Object.fromEntries(["change", "status", "pending", "notes", "tested"].filter((key) => key in event)
      .map((key) => [key, event[key]]));
  }

  /** Add a generator (comfyui, a1111, openai, xai, together, localai, ollama, openai_compatible, gemini, bfl, fal,
   *  replicate). A ComfyUI `workflow` comes back as `pending` with the inputs DGC found until `confirm: true`. */
  add(provider: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.update("add_generator", { ...fields, provider });
  }

  /** Save (or with "" remove) a generator's key in the user's secrets.json, bound to its address. */
  setKey(generator: string, key: string): Promise<Record<string, unknown>> {
    if (typeof key !== "string") throw new DGCConfigError("key must be a string");
    return this.update("set_key", { generator, key });
  }

  remove(generator: string): Promise<Record<string, unknown>> {
    return this.update("remove_generator", { generator });
  }

  setDefault(generator: string): Promise<Record<string, unknown>> {
    return this.update("set_default", { generator });
  }

  /** Test one generator (or all) without making an image. */
  async test(generator?: string): Promise<Record<string, unknown>> {
    return mapping((await this.update("test", generator ? { generator } : {})).tested);
  }

  /** Make images now: `{ok, text, images: [{path, rel, sidecar, width, height, seed}], generator, model, cost_usd?,
   *  error?, card?}`. */
  async generate(prompt: string, options: ImageGenerateOptions = {}): Promise<Record<string, unknown>> {
    if (typeof prompt !== "string" || !prompt.trim()) throw new DGCConfigError("prompt must be a non-empty string");
    const count = options.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new DGCConfigError("count must be 1 to 4");
    const command: Frame = { type: "images_generate", prompt, count };
    const names: [keyof ImageGenerateOptions, string][] = [["size", "size"], ["aspect", "aspect"], ["mask", "mask"],
      ["generator", "generator"], ["model", "model"], ["seed", "seed"], ["negativePrompt", "negative_prompt"],
      ["saveTo", "save_to"]];
    for (const [from, to] of names) if (options[from] !== undefined) command[to] = options[from];
    if (options.images) command.images = [...options.images];
    if (options.approve) command.approve = true;
    const event = await this.send(command, "images_result", options.timeoutMs ?? 600_000);
    const { type: _type, request_id: _rid, ...rest } = event;
    return rest;
  }

  /** Every image DGC made, newest first. */
  async library(options: { query?: string; surface?: string; limit?: number; offset?: number } = {}): Promise<Record<string, unknown>> {
    const event = await this.send({ type: "images_library", limit: options.limit ?? 60, offset: options.offset ?? 0,
      ...(options.query ? { query: options.query } : {}), ...(options.surface ? { surface: options.surface } : {}) },
      "images_library");
    return { images: event.images, total: event.total, ...(event.next_offset !== undefined ? { next_offset: event.next_offset } : {}) };
  }
}

export interface VideoGenerateOptions {
  durationS?: number; aspect?: "16:9" | "9:16" | "1:1"; resolution?: string; image?: string; audio?: boolean;
  generator?: string; model?: string; seed?: number; negativePrompt?: string; saveTo?: string; approve?: boolean;
  /** Follow the job until it ends (default true). */
  wait?: boolean; timeoutMs?: number; pollMs?: number;
}

const VIDEO_ENDED = new Set(["done", "failed", "cancelled"]);

/** `session.videos`: video generation (CLI 0.51+, `capabilities.videos`). A video is a long job: `generate` starts it
 *  and, with `wait` (the default), follows it until it is made, failed or stopped. Every video runs only with
 *  `approve: true` (or a generator the user set to make videos without asking); without, the answer has
 *  `error.kind` "needs_approval" and the `card` with its price. */
export class Videos {
  private readonly ask: ArtifactRequest;

  constructor(ask: ArtifactRequest) {
    this.ask = ask;
  }

  private send(command: Frame, answer: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.ask({ ...command, request_id: newId("videos") }, answer, timeoutMs);
  }

  /** The generators that make videos (each one's `video` says lengths, resolutions, sound and price per second). */
  async generators(options: { refresh?: boolean } = {}): Promise<Record<string, unknown>[]> {
    const event = await this.ask({ type: "images_list", request_id: newId("images"),
      ...(options.refresh ? { refresh: true } : {}) }, "images_status", options.refresh ? 60_000 : undefined);
    const rows = (mapping(event.status).generators as Record<string, unknown>[] | undefined) ?? [];
    return rows.filter((row) => row.makes === "videos" || row.makes === "both");
  }

  /** This session's video jobs and every unfinished one (or the one named). */
  async jobs(job?: string): Promise<Record<string, unknown>[]> {
    const event = await this.send({ type: "videos_jobs", ...(job ? { job } : {}) }, "video_jobs");
    return Array.isArray(event.jobs) ? event.jobs as Record<string, unknown>[] : [];
  }

  async job(job: string): Promise<Record<string, unknown>> {
    const found = await this.jobs(job);
    if (!found.length) throw new DGCConfigError(`there is no video job ${job}`);
    return found[0];
  }

  /** Stop a job (at the provider where it can): the job, with `charged` saying what it cost. */
  async stop(job: string): Promise<Record<string, unknown>> {
    const event = await this.send({ type: "videos_stop", job }, "video_jobs");
    const jobs = Array.isArray(event.jobs) ? event.jobs as Record<string, unknown>[] : [];
    return { ...(jobs[0] ?? {}), change: event.change ?? "" };
  }

  /** Follow a job until it ends; rejects when `timeoutMs` passes first (the job keeps running). */
  async wait(job: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<Record<string, unknown>> {
    const deadline = Date.now() + (options.timeoutMs ?? 1_800_000);
    for (;;) {
      const current = await this.job(job);
      if (VIDEO_ENDED.has(String(current.state))) return current;
      if (Date.now() > deadline) throw new DGCTimeoutError(`video job ${job} is still ${String(current.state)}`);
      await new Promise((resolve) => setTimeout(resolve, Math.max(200, options.pollMs ?? 5000)));
    }
  }

  /** Make one video: `{ok, text, job?, card?, error?}`; with `wait`, `job` is the ended job (its `result` has the
   *  path, sidecar, poster, length and size). */
  async generate(prompt: string, options: VideoGenerateOptions = {}): Promise<Record<string, unknown>> {
    if (typeof prompt !== "string" || !prompt.trim()) throw new DGCConfigError("prompt must be a non-empty string");
    if (options.durationS !== undefined && (!Number.isInteger(options.durationS) || options.durationS < 1 || options.durationS > 60)) {
      throw new DGCConfigError("durationS must be 1 to 60 seconds");
    }
    if (options.aspect !== undefined && !["16:9", "9:16", "1:1"].includes(options.aspect)) {
      throw new DGCConfigError("aspect must be 16:9, 9:16 or 1:1");
    }
    const command: Frame = { type: "videos_generate", prompt };
    const names: [keyof VideoGenerateOptions, string][] = [["durationS", "duration_s"], ["aspect", "aspect"],
      ["resolution", "resolution"], ["image", "image"], ["audio", "audio"], ["generator", "generator"],
      ["model", "model"], ["seed", "seed"], ["negativePrompt", "negative_prompt"], ["saveTo", "save_to"]];
    for (const [from, to] of names) if (options[from] !== undefined) command[to] = options[from];
    if (options.approve) command.approve = true;
    const event = await this.send(command, "video_jobs", 120_000);
    const jobs = Array.isArray(event.jobs) ? event.jobs as Record<string, unknown>[] : [];
    const out: Record<string, unknown> = { ok: jobs.length > 0, text: event.change ?? "" };
    if (event.card !== undefined) out.card = event.card;
    if (event.error !== undefined) out.error = event.error;
    if (!jobs.length) return out;
    let job = jobs[0];
    if (options.wait !== false) {
      job = await this.wait(String(job.id), { timeoutMs: options.timeoutMs, pollMs: options.pollMs });
      out.ok = job.state === "done";
      if (job.error !== undefined) out.error = job.error;
    }
    out.job = job;
    return out;
  }

  /** Every video DGC made, newest first. */
  async library(options: { query?: string; surface?: string; limit?: number; offset?: number } = {}): Promise<Record<string, unknown>> {
    const event = await this.send({ type: "videos_library", limit: options.limit ?? 60, offset: options.offset ?? 0,
      ...(options.query ? { query: options.query } : {}), ...(options.surface ? { surface: options.surface } : {}) },
      "videos_library");
    return { videos: event.videos, total: event.total, ...(event.next_offset !== undefined ? { next_offset: event.next_offset } : {}) };
  }
}

/** `session.artifacts`: the store every part of DGC shares. Each call is one request to the CLI. */
export class Artifacts {
  private readonly ask: ArtifactRequest;
  private readonly capabilities: Record<string, unknown>;

  constructor(ask: ArtifactRequest, capabilities: Record<string, unknown> = {}) {
    this.ask = ask;
    this.capabilities = capabilities;
  }

  private send(command: Frame, answer: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.ask({ ...command, request_id: newId("art") }, answer, timeoutMs);
  }

  /** Newest first; `type` is doc|slides|sheet|dashboard|page, `surface` chat|work|pip|sdk|cli. */
  async list(options: { type?: string; surface?: string } = {}): Promise<ArtifactInfo[]> {
    const command: Frame = { type: "artifact_list" };
    if (options.type) command.artifact_type = options.type;
    if (options.surface) command.surface = options.surface;
    const event = await this.send(command, "artifact_items");
    return (Array.isArray(event.items) ? event.items : []).map(artifactInfo);
  }

  async get(id: string): Promise<ArtifactInfo> {
    return artifactInfo((await this.send({ type: "artifact_get", id }, "artifact_detail")).artifact);
  }

  /** Bounded changes between saved versions. Requires the CLI's artifacts.compare capability. */
  async compare(id: string, before: number, after?: number): Promise<Record<string, unknown>> {
    if (!this.capabilities.compare) throw new DGCUnsupportedError("This DGC CLI can't compare artifact versions; update it (dgc update).");
    const command: Frame = { type: "artifact_compare", id, before };
    if (after !== undefined) command.after = after;
    return (await this.send(command, "artifact_comparison")).comparison as Record<string, unknown>;
  }

  /** What a version says: a document's text, or a deck's, sheet's or dashboard's data. */
  async content(id: string, version?: number): Promise<unknown> {
    const command: Frame = { type: "artifact_get", id, content: true };
    if (version !== undefined) command.version = version;
    return (await this.send(command, "artifact_detail")).content;
  }

  /** A new version by "you"; rejected (reason "conflict") if it moved on since `baseVersion`. */
  async update(id: string, content: unknown, options: { baseVersion: number; note?: string }): Promise<ArtifactInfo> {
    const command: Frame = { type: "artifact_update", id, content: content as Frame[string], base_version: options.baseVersion };
    if (options.note) command.note = options.note;
    return artifactInfo((await this.send(command, "artifact_changed")).artifact);
  }

  async restore(id: string, version: number): Promise<ArtifactInfo> {
    return artifactInfo((await this.send({ type: "artifact_restore", id, version }, "artifact_changed")).artifact);
  }

  /** Write it as a file; returns its path. */
  async export(id: string, format: string, version?: number): Promise<string> {
    const command: Frame = { type: "artifact_export", id, format };
    if (version !== undefined) command.version = version;
    return String((await this.send(command, "artifact_exported")).path || "");
  }

  /** Serve it at an address of its own on this computer; returns the URL. */
  async open(id: string): Promise<string> {
    return String((await this.send({ type: "artifact_open", id }, "artifact_served", 60_000)).url || "");
  }

  /** Into DGC's trash, where it can be put back. */
  async remove(id: string): Promise<void> {
    await this.send({ type: "artifact_remove", id }, "artifact_changed");
  }

  /** Run a dashboard's queries now (no model); returns what each widget shows. */
  async refresh(id: string): Promise<Record<string, unknown>> {
    const detail = await this.send({ type: "artifact_refresh", id }, "artifact_detail");
    const state = (detail.state && typeof detail.state === "object" ? detail.state : {}) as Record<string, unknown>;
    return (state.results && typeof state.results === "object" ? state.results : {}) as Record<string, unknown>;
  }

  async allowSource(id: string, source: string, allowed = true, baseVersion?: number): Promise<ArtifactInfo> {
    const command: Frame = { type: "artifact_allow_source", id, source, allowed };
    if (baseVersion !== undefined) {
      if (!this.capabilities.source_consent_version) throw new DGCUnsupportedError("This DGC CLI can't check source consent versions; update it (dgc update).");
      if (!Number.isSafeInteger(baseVersion) || baseVersion < 1) throw new RangeError("baseVersion is a positive version number");
      command.base_version = baseVersion;
    }
    return artifactInfo((await this.send(command, "artifact_changed")).artifact);
  }
}

export class Run {
  readonly result: RunResult;
  readonly requestId: string;
  readonly ids = new Set<string>();        // prompt / steer / repair ids this run owns
  readonly expect = new Set<string>();     // ids whose turn has not started yet
  readonly steers = new Set<string>();
  readonly unresolved = new Set<string>(); // steers without an outcome yet
  readonly returned = new Set<string>();   // prompts DGC handed back unrun
  readonly rejected = new Map<string, string>();
  readonly turnIds = new Set<string>();
  readonly startedIds = new Set<string>();
  liveTurn = "";
  started = false;
  cancelReason: "" | "cancelled" | "timeout" | "decision_failed" = "";
  cancelAt = 0;
  cancelSent = false;
  decisionError = "";
  usage: UsageTotals = emptyTotals();
  billed = 0;
  pendingBills = 0;
  usageUnknown = false;
  done = false;
  handle: RunHandle | null = null;
  pumpStarted = false;
  holdsFollowups = false;   // this run changes DGC's config for its own turns
  output = "";              // the Output chip's choice for this run's prompt (CLI 0.50+)
  held = false;             // a follow-up the SDK sends once the run in front of it is over
  /** The workspace when this run's last turn ended: its "after", and a follow-up's "before". */
  after: Snapshot | null = null;
  private cancelWaiters: Array<() => void> = [];
  private doneWaiters: Array<() => void> = [];

  constructor(result: RunResult, requestId: string) {
    this.result = result;
    this.requestId = requestId;
    this.ids.add(requestId);
    this.expect.add(requestId);
  }

  /** Resolves once a cancel (of any reason) is requested. */
  cancelled(): Promise<void> {
    if (this.cancelReason) return Promise.resolve();
    return new Promise((done) => this.cancelWaiters.push(done));
  }

  noteCancel(): void {
    for (const wake of this.cancelWaiters.splice(0)) wake();
  }

  markDone(): void {
    this.done = true;
    for (const wake of this.doneWaiters.splice(0)) wake();
  }

  waitDone(timeoutMs: number): Promise<void> {
    if (this.done) return Promise.resolve();
    return new Promise((done) => {
      const timer = setTimeout(done, timeoutMs);
      this.doneWaiters.push(() => { clearTimeout(timer); done(); });
    });
  }
}

type Item = { event: Frame; owner: Run | null; scoped: boolean };

/**
 * Streaming handle. Iterate its events (`for await`), then call {@link result}. Leaving the loop
 * early (`break`, `return`, a throw) cancels the run and waits (bounded) for DGC to stop, so the
 * session is free again. `result()` drains whatever was not iterated.
 */
export class RunHandle implements AsyncIterable<RunEvent> {
  private readonly session: Session;
  /** @internal */
  readonly run: Run;
  private gen: AsyncGenerator<RunEvent> | null = null;
  private primed: Promise<IteratorResult<RunEvent>> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private finished = false;
  private detach: () => void = () => {};

  constructor(session: Session, run: Run) {
    this.session = session;
    this.run = run;
    run.handle = this;
  }

  get runId(): string {
    return this.run.result.runId;
  }

  /** True once the run is over and every event was consumed. */
  get done(): boolean {
    return this.finished;
  }

  /**
   * @internal Attach the pump. `prime` starts it now, so the prompt is sent when stream()
   * returns; a run queued behind another starts when it is iterated or awaited (starting it here
   * would drain the run in front of it behind its caller's back).
   */
  begin(gen: AsyncGenerator<RunEvent>, signal: AbortSignalLike | undefined, prime: boolean): void {
    this.gen = gen;
    if (signal) {
      const abort = () => {
        try { this.cancel(); } catch { /* the backend is gone; the run reports it */ }
      };
      if (signal.aborted) this.run.cancelReason = "cancelled";
      else {
        signal.addEventListener("abort", abort, { once: true });
        this.detach = () => signal.removeEventListener("abort", abort);
      }
    }
    if (prime) {
      this.primed = gen.next();
      this.primed.catch(() => { /* surfaced by the first step */ });
    }
  }

  private step(): Promise<RunEvent | null> {
    const next = this.chain.then(async (): Promise<RunEvent | null> => {
      try {
        if (this.primed) {
          const primed = this.primed;
          this.primed = null;
          const first = await primed;
          if (first.done) {
            this.finish();
            return null;
          }
          return first.value;
        }
        if (this.finished || !this.gen) return null;
        const item = await this.gen.next();
        if (item.done) {
          this.finish();
          return null;
        }
        return item.value;
      } catch (error) {
        this.finish();
        throw error;
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }

  private finish(): void {
    this.finished = true;
    this.detach();
  }

  [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    return {
      next: async () => {
        const event = await this.step();
        return event ? { value: event, done: false } : { value: undefined, done: true };
      },
      return: async () => {
        if (!this.finished) await this.abandon();
        return { value: undefined, done: true };
      },
    };
  }

  /**
   * Drain the run and return its result. `timeoutMs` bounds this wait (undefined/null waits until
   * the run ends, which the run's own timeout bounds); if the run is still going when it lapses,
   * DGCTimeoutError is thrown and the run keeps going (call {@link cancel} to stop it).
   */
  async result(timeoutMs?: number | null): Promise<RunResult> {
    const drain = (async () => {
      while (await this.step()) { /* drain */ }
      return this.run.result;
    })();
    if (timeoutMs === undefined || timeoutMs === null) return drain;
    checkTimeout(timeoutMs);
    drain.catch(() => {});
    let stop = () => {};
    const lapse = new Promise<never>((_resolve, reject) => {
      stop = longTimer(timeoutMs, () => reject(new DGCTimeoutError(
        `run ${this.runId} was still ${this.run.result.status} after ${timeoutMs} ms`)));
    });
    try {
      return await Promise.race([drain, lapse]);
    } finally {
      stop();
    }
  }

  /** Cancel this run. The result settles with `status: "cancelled"`. */
  cancel(): void {
    this.session.cancelRun(this.run, "cancelled");
  }

  /** Cancel if still going, then drain (bounded); used when the consumer went away. */
  async abandon(timeoutMs = 15_000): Promise<void> {
    if (!this.finished) {
      try { this.session.cancelRun(this.run, "cancelled"); } catch { /* the transport is gone */ }
      try { await this.result(timeoutMs); } catch { /* the transport may already be gone */ }
    }
    if (!this.finished) await this.close();
  }

  private async close(): Promise<void> {
    const gen = this.gen;
    this.finish();
    if (gen) {
      await Promise.race([gen.return(undefined).catch(() => undefined), sleep(5_000)]);
    }
    if (!this.run.pumpStarted) this.session.forget(this.run);
  }
}

/** @internal What DGC.session() hands a Session. */
export type SessionInit = {
  options: SessionOptions;
  unhandled: "deny" | "callback";
  instructions: string;
  toolHub: ToolHub | null;
  cwd: string | null;
  policy: Policy | null;
  pricing?: Pricing;
  department: string;
  usageLog: UsageLog | null;
  auditLog: AuditLog | null;
  model: string;
  permissionMode: string;
  isolated: boolean;
  maxTurns?: number;
  verifyCommand: string;
  stateLock: StateLock | null;
  excludePaths: string[];
  requestTimeoutMs: number;
  sandbox: SandboxStatus;
};

type Turn = { id: string; owner: Run | null; requestId: string };

export class Session {
  readonly pips: Pips;
  sessionId: string;
  sessionPath = "";
  readonly transport: Transport;
  readonly protocolVersion: unknown;
  readonly capabilities: Record<string, unknown>;
  /** Whether this session's shell commands run inside the OS sandbox. */
  readonly sandbox: SandboxStatus;
  private readonly init: SessionInit;
  private closed = false;
  private pending: Item[] = [];
  private owners = new Map<string, Run>();
  private active: Run | null = null;
  private queued: Run[] = [];
  private turn: Turn | null = null;
  private usageLast: UsageTotals | null = null;
  private billTo: [Run | null, string] | null = null;
  private taskIds = new Map<string, string>();
  private taskRevision = 0;
  private answeredIds = new Set<string>();
  private maxTurnsDirty = false;
  private modelSeen: string;

  constructor(transport: Transport, ready: Record<string, unknown>, init: SessionInit) {
    if (init.unhandled !== "deny" && init.unhandled !== "callback") {
      throw new DGCConfigError("permissions.unhandled must be 'deny' or 'callback'");
    }
    this.transport = transport;
    this.init = init;
    this.sessionId = String(ready.session_id || "");
    this.protocolVersion = ready.protocol_version;
    this.capabilities = mapping(ready.capabilities);
    this.sandbox = init.sandbox;
    this.modelSeen = String(ready.model || init.model || "");
    this.pips = new Pips(this.capabilities,
      init.policy !== null || init.sandbox.requirement !== "off" || init.sandbox.active,
      init.permissionMode === "plan",
      (payload, response, requestId) => this.request(payload, response, { requestId }), init.isolated);
  }

  /** Advanced transport. Prefer {@link run} / {@link stream}. */
  get raw(): Transport {
    return this.transport;
  }

  /** @internal The verify command, for the accumulator. */
  get verifyCommand(): string {
    return this.init.verifyCommand;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.init.toolHub?.close();
    await this.transport.close();
  }

  // ---- runs -----------------------------------------------------------------------------------

  async run(prompt: string, runOptions?: RunOptions): Promise<RunResult> {
    return this.stream(prompt, runOptions).result();
  }

  /**
   * Send `prompt` and return a handle over its events. `timeoutMs` limits each turn of the run
   * (default: no limit, as null; a big local model can take tens of minutes before its first word). `maxTurns` caps tool iterations for this run only; the
   * session's own setting is restored afterwards. `signal` cancels the run when aborted.
   */
  stream(prompt: string, runOptions: RunOptions = {}): RunHandle {
    if (this.closed) throw new DGCRuntimeError("this session is closed");
    if (typeof prompt !== "string" || !prompt.trim()) throw new DGCConfigError("prompt must be a non-empty string");
    if (runOptions.outputSchema) assertSupported(runOptions.outputSchema);
    const output = runOptions.output;
    if (output !== undefined && !ARTIFACT_OUTPUTS.includes(output)) {
      throw new DGCConfigError(`output must be one of ${ARTIFACT_OUTPUTS.join(", ")}`);
    }
    if (output && output !== "auto" && !(this.capabilities.artifacts && typeof this.capabilities.artifacts === "object")) {
      throw new DGCUnsupportedError("This DGC CLI can't make artifacts; update it (dgc update).");
    }
    checkTimeout(runOptions.timeoutMs);
    const maxTurns = runOptions.maxTurns;
    if (maxTurns !== undefined) {
      if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 0) {
        throw new DGCConfigError("maxTurns must be a non-negative integer");
      }
      if (!this.init.isolated) {
        throw new DGCConfigError("a per-run maxTurns needs an isolated session: with inheritUserState DGC "
          + "would save it into your own ~/.dgc/config.json");
      }
    }
    const current = this.active;
    if (current && !current.done && !current.cancelReason) {
      throw new DGCConfigError("this session already has an active run");
    }
    // A cancelled run still winding down, or queued follow-ups: this run starts after them.
    const prior = this.queued.length ? this.queued[this.queued.length - 1] : (current && !current.done ? current : null);
    const run = new Run(this.newResult("running"), newId("req"));
    run.holdsFollowups = maxTurns !== undefined || Boolean(runOptions.outputSchema);
    run.output = output && output !== "auto" ? output : "";
    if (prior) this.queued.push(run);
    else this.active = run;
    this.owners.set(run.requestId, run);
    const handle = new RunHandle(this, run);
    const timeoutMs = runOptions.timeoutMs ?? null;
    handle.begin(this.pump(run, prompt.trim(), timeoutMs, maxTurns, runOptions.outputSchema,
      runOptions.skills, runOptions.workflow, runOptions.repairAttempts ?? 1, true, prior), runOptions.signal,
    prior === null);
    return handle;
  }

  /**
   * Queue a prompt behind the active run and return a handle for its own turn. With no run in
   * flight this is {@link stream}. A follow-up is observed, audited and billed like any run.
   * Behind a run with its own `maxTurns` or `outputSchema`, it is sent when that run is over (so
   * it runs under the session's own settings). It does not run when the run in front of it is
   * cancelled or times out.
   */
  followup(text: string, runOptions: Omit<RunOptions, "maxTurns" | "workflow"> = {}): RunHandle {
    if (typeof text !== "string" || !text.trim()) throw new DGCConfigError("followup text must be a non-empty string");
    if (runOptions.outputSchema) assertSupported(runOptions.outputSchema);
    checkTimeout(runOptions.timeoutMs);
    if (this.closed) throw new DGCRuntimeError("this session is closed");
    const prior = this.queued.length ? this.queued[this.queued.length - 1] : (this.active && !this.active.done ? this.active : null);
    if (!prior) return this.stream(text, runOptions);
    const queued = new Run(this.newResult("queued"), newId("follow"));
    queued.held = prior.holdsFollowups || prior.held;
    queued.holdsFollowups = Boolean(runOptions.outputSchema);
    this.queued.push(queued);
    this.owners.set(queued.requestId, queued);
    if (!queued.held) {
      const payload: Frame = {
        type: "prompt", text: this.composePrompt(text.trim()), delivery: "queue", request_id: queued.requestId,
      };
      if (runOptions.skills?.length) payload.skills = [...runOptions.skills];
      try {
        this.transport.send(payload);
      } catch (error) {
        this.forget(queued);
        throw new DGCRuntimeError(error instanceof Error ? error.message : String(error), { cause: error });
      }
    }
    const handle = new RunHandle(this, queued);
    const timeoutMs = runOptions.timeoutMs ?? null;
    handle.begin(this.pump(queued, text.trim(), timeoutMs, undefined, runOptions.outputSchema,
      runOptions.skills, undefined, runOptions.repairAttempts ?? 1, queued.held, prior), runOptions.signal, false);
    return handle;
  }

  /** Cancel the active run. DGC's stop also hands back prompts queued behind it. */
  cancel(): void {
    const run = this.active;
    if (!run) {
      try {
        this.transport.send({ type: "cancel" });
      } catch (error) {
        throw new DGCRuntimeError("could not cancel the run", { cause: error });
      }
      return;
    }
    this.cancelRun(run, "cancelled");
  }

  /**
   * Add `text` to the run in flight. Throws unless a run is active. If DGC cannot fold it into
   * the live turn, it runs as a further turn of the same run (its tool calls are part of that
   * run's result, audit and usage).
   */
  steer(text: string): void {
    if (typeof text !== "string" || !text.trim()) throw new DGCConfigError("steer text must be a non-empty string");
    const run = this.active;
    if (!run || run.done || run.cancelReason) {
      throw new DGCConfigError("steer() needs an active run; use followup() or stream()");
    }
    const rid = newId("steer");
    run.ids.add(rid);
    run.steers.add(rid);
    run.unresolved.add(rid);
    this.owners.set(rid, run);
    try {
      this.transport.send({ type: "prompt", text: text.trim(), delivery: "steer", request_id: rid });
    } catch (error) {
      run.unresolved.delete(rid);
      throw new DGCRuntimeError(error instanceof Error ? error.message : String(error), { cause: error });
    }
  }

  /**
   * Fill `sessionPath` once this session's own transcript exists. Only a transcript whose file
   * name is this session's id is used; another session's transcript is never adopted.
   */
  async bindIdentity(): Promise<void> {
    if (!this.sessionId) return;
    for (const info of await this.listSessions()) {
      if (info.id === this.sessionId) {
        this.sessionPath = info.path;
        return;
      }
    }
  }

  private newResult(status: RunStatus): RunResult {
    return {
      sessionId: this.sessionId, runId: newId("run"), status, reason: "", finalText: "",
      usage: {}, tools: [], denials: [], artifacts: [], documents: [], changes: [], tasks: [], agents: [],
    };
  }

  // ---- control requests -----------------------------------------------------------------------

  private async request(command: Frame, responseType: string,
    options: { timeoutMs?: number; uncorrelatedReply?: boolean; requestId?: string } = {}): Promise<Frame> {
    const payload: Frame = { ...command };
    if (options.requestId === undefined && (typeof payload.request_id !== "string" || !payload.request_id)) payload.request_id = newId("req");
    const wait = options.timeoutMs === undefined
      ? this.init.requestTimeoutMs : Math.max(options.timeoutMs, this.init.requestTimeoutMs);
    return this.transport.request(payload, responseType, { timeoutMs: wait, uncorrelatedReply: options.uncorrelatedReply,
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}) });
  }

  /** Hold the stateDir lock around commands that make DGC save the isolated config. */
  private configScope<T>(work: () => Promise<T>): Promise<T> {
    const lock = this.init.stateLock;
    if (!lock || !this.init.isolated) return work();
    return lock.hold(work);
  }

  async listSessions(): Promise<SessionInfo[]> {
    const event = await this.request({ type: "list_sessions", request_id: newId("sessions") }, "sessions");
    return rowsToSessions(event.items);
  }

  /** The mods this session runs (CLI 0.50+). Needs `capabilities.mods`. */
  get mods(): Mods {
    if (!(this.capabilities.mods && typeof this.capabilities.mods === "object")) {
      throw new DGCUnsupportedError("This DGC CLI has no mods; update it (dgc update).");
    }
    return new Mods((command, answer) => this.request(command, answer));
  }

  /** Image generation (CLI 0.51+): the user's image generators. Needs `capabilities.images`. */
  get images(): Images {
    if (!(this.capabilities.images && typeof this.capabilities.images === "object")) {
      throw new DGCUnsupportedError("This DGC CLI makes no images; update it (dgc update).");
    }
    return new Images((command, answer, timeoutMs) => this.request(command, answer, { timeoutMs }));
  }

  /** Video generation (CLI 0.51+): long jobs on the user's video generators. Needs `capabilities.videos`. */
  get videos(): Videos {
    if (!(this.capabilities.videos && typeof this.capabilities.videos === "object")) {
      throw new DGCUnsupportedError("This DGC CLI makes no videos; update it (dgc update).");
    }
    return new Videos((command, answer, timeoutMs) => this.request(command, answer, { timeoutMs }));
  }

  /** DGC Router (CLI 0.51+): the user's other computers that run models. Needs `capabilities.router`. */
  get router(): Router {
    if (!(this.capabilities.router && typeof this.capabilities.router === "object")) {
      throw new DGCUnsupportedError("This DGC CLI has no DGC Router; update it (dgc update).");
    }
    const router = this.capabilities.router as Record<string, unknown>;
    const commands = Array.isArray(router.commands) ? router.commands.filter((c): c is string => typeof c === "string") : [];
    return new Router((command, answer, timeoutMs) => this.request(command, answer, { timeoutMs }), commands);
  }

  /** Plugins' own cards (MCP Apps, CLI 0.51+): see `Cards`. Needs `capabilities.mcp_apps`. */
  get cards(): Cards {
    if (!(this.capabilities.mcp_apps && typeof this.capabilities.mcp_apps === "object")) {
      throw new DGCUnsupportedError("This DGC CLI shows no plugin cards; update it (dgc update).");
    }
    return new Cards((command, answer, timeoutMs) => this.request(command, answer, { timeoutMs }),
                     (command) => this.transport.send(command));
  }

  /** Everything DGC made that the user keeps (CLI 0.50+): documents, decks, sheets, dashboards and pages, each with
   *  every version. Needs `capabilities.artifacts`. */
  get artifacts(): Artifacts {
    if (!(this.capabilities.artifacts && typeof this.capabilities.artifacts === "object")) {
      throw new DGCUnsupportedError("This DGC CLI has no artifacts; update it (dgc update).");
    }
    return new Artifacts((command, answer, timeoutMs) => this.request(command, answer, { timeoutMs }), mapping(this.capabilities.artifacts));
  }

  /** What fills this session's context window, part by part, as DGC's meter shows it: messages, tool results, the
   *  system prompt, tools one by one (built-in and MCP), memory, skills, and the room kept and free. Needs a DGC CLI
   *  that offers it (`capabilities.context_breakdown`). */
  async contextBreakdown(): Promise<ContextBreakdown> {
    if (!this.capabilities.context_breakdown) throw new DGCUnsupportedError("This DGC CLI can't break its context window down; update it (dgc update).");
    const event = await this.request({ type: "context_breakdown", request_id: newId("ctx") }, "context_breakdown");
    const part = (row: unknown): ContextPart => {
      const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
      const items = (Array.isArray(r.items) ? r.items : []).filter((i) => i && typeof i === "object")
        .map((i) => ({ name: String((i as Record<string, unknown>).name || ""), tokens: Number((i as Record<string, unknown>).tokens || 0) }));
      return { id: String(r.id || ""), label: String(r.label || ""), tokens: Number(r.tokens || 0), items };
    };
    return { window: Number(event.window || 0), used: Number(event.used || 0),
             source: event.source === "reported" ? "reported" : "estimated", compactAt: Number(event.compact_at || 0),
             parts: (Array.isArray(event.categories) ? event.categories : []).map(part),
             buffer: Number(event.buffer || 0), free: Number(event.free || 0),
             deferred: (Array.isArray(event.deferred) ? event.deferred : []).map(part) };
  }

  async listCheckpoints(): Promise<Checkpoint[]> {
    const event = await this.request({ type: "list_checkpoints", request_id: newId("ck") }, "checkpoints");
    return (Array.isArray(event.items) ? event.items : []).filter((row) => row && typeof row === "object").map((row) => {
      const item = row as Record<string, unknown>;
      return { index: Number(item.index || 0), preview: String(item.preview || ""), files: Number(item.files || 0) };
    });
  }

  async rewind(index: number): Promise<Record<string, unknown>> {
    const event = await this.request({ type: "rewind", index, request_id: newId("rw") }, "rewound");
    if (!event.ok) {
      throw new DGCConfigError(`could not rewind to checkpoint ${index}; listCheckpoints() shows the valid indexes`);
    }
    await this.discardIdle();
    return event;
  }

  async fork(name?: string): Promise<Record<string, unknown>> {
    const command: Frame = { type: "fork_session", request_id: newId("fork") };
    if (name) command.name = name;
    const event = await this.request(command, "session");
    const forked = String(event.session_id || this.sessionId);
    if (event.path) this.sessionPath = String(event.path);
    else if (forked !== this.sessionId) this.sessionPath = "";   // the parent's transcript is not the fork's
    this.sessionId = forked;
    await this.discardIdle();
    if (!this.sessionPath) {
      try { await this.bindIdentity(); } catch { /* bound after the next run */ }
    }
    return event;
  }

  async history(): Promise<Record<string, unknown>> {
    return this.request({ type: "get_history", request_id: newId("hist") }, "history");
  }

  async listSkills(): Promise<Array<{ name: string; description: string; source: string; enabled: boolean }>> {
    const event = await this.request({ type: "list_skills", request_id: newId("skills") }, "skill_catalog");
    return (Array.isArray(event.items) ? event.items : []).filter((row) => row && typeof row === "object").map((row) => {
      const item = row as Record<string, unknown>;
      return {
        name: String(item.name || ""), description: String(item.description || ""),
        source: String(item.source || ""), enabled: item.enabled !== false,
      };
    });
  }

  async getGoal(): Promise<Record<string, unknown>> {
    return this.request({ type: "get_goal", request_id: newId("goal") }, "goal_changed");
  }

  async setGoal(text: string, status = "active"): Promise<Record<string, unknown>> {
    return this.request({ type: "set_goal", text, status, request_id: newId("setgoal") }, "goal_changed");
  }

  async listMonitors(): Promise<unknown[]> {
    const event = await this.request({ type: "list_monitors", request_id: newId("mon") }, "monitors");
    return Array.isArray(event.items) ? event.items : [];
  }

  async listHooks(): Promise<Record<string, unknown>> {
    return this.request({ type: "list_hooks", request_id: newId("hooks") }, "hook_catalog");
  }

  async getMemory(): Promise<Record<string, unknown>> {
    return this.request({ type: "get_memory", request_id: newId("mem") }, "memory");
  }

  async addMemory(text: string, scope: "project" | "user" = "project"): Promise<Record<string, unknown>> {
    if (scope !== "project" && scope !== "user") throw new DGCConfigError("memory scope must be 'project' or 'user'");
    return this.request({ type: "add_memory", text, scope, request_id: newId("addmem") }, "memory");
  }

  async listPermissions(): Promise<Array<{ action: string; rule: string }>> {
    const event = await this.request({ type: "list_permissions", request_id: newId("perms") }, "permissions");
    return permissionRows(event.items);
  }

  /**
   * Add a rule. In an isolated session it lasts for this state_dir's sessions until the next
   * session rewrites the config; a RuntimePolicy is not installed this way (it is per session).
   */
  async addPermissionRule(action: "allow" | "ask" | "deny", rule: string): Promise<Array<{ action: string; rule: string }>> {
    if (!["allow", "ask", "deny"].includes(action)) throw new DGCConfigError("permission action must be allow, ask, or deny");
    const event = await this.configScope(() => this.request(
      { type: "add_permission_rule", action, rule, request_id: newId("addperm") }, "permissions"));
    return permissionRows(event.items);
  }

  async removePermissionRule(action: "allow" | "ask" | "deny", rule: string): Promise<Array<{ action: string; rule: string }>> {
    const event = await this.configScope(() => this.request(
      { type: "remove_permission_rule", action, rule, request_id: newId("rmperm") }, "permissions"));
    return permissionRows(event.items);
  }

  async addMcpServer(name: string, command: string, args: string[] = []): Promise<unknown[]> {
    const runtime = { transport: "stdio", command, args: [...args], env: {}, env_names: [], log_level: "warning" };
    const { env: _env, ...persisted } = runtime;
    const event = await this.configScope(() => this.request({
      type: "upsert_mcp_server", request_id: newId("mcpadd"), name, runtime, persisted,
    }, "mcp_servers", { timeoutMs: 20_000 }));
    return Array.isArray(event.items) ? event.items : [];
  }

  async listMcpServers(): Promise<unknown[]> {
    const event = await this.request({ type: "list_mcp_servers", request_id: newId("mcp") }, "mcp_servers");
    return Array.isArray(event.items) ? event.items : [];
  }

  async getSkill(name: string): Promise<Record<string, unknown>> {
    return this.request({ type: "get_skill", name, request_id: newId("skill") }, "skill_detail");
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<unknown> {
    return this.request({ type: "set_skill_enabled", name, enabled, request_id: newId("sken") }, "skill_catalog");
  }

  async stopMonitor(id = "all"): Promise<unknown[]> {
    const event = await this.request({ type: "stop_monitor", id, request_id: newId("stopmon") }, "monitors");
    return Array.isArray(event.items) ? event.items : [];
  }

  async listArtifacts(): Promise<Artifact[]> {
    const event = await this.request({ type: "list_artifacts", request_id: newId("arts") }, "artifacts");
    return (Array.isArray(event.items) ? event.items : []).filter((row) => row && typeof row === "object").map((row) => {
      const item = row as Record<string, unknown>;
      return { id: String(item.id || ""), name: String(item.name || ""), url: String(item.url || ""), rel: String(item.rel || item.path || "") };
    });
  }

  async listAgents(): Promise<unknown[]> {
    const event = await this.request({ type: "list_agents", request_id: newId("agents") }, "agents");
    return Array.isArray(event.items) ? event.items : [];
  }

  async clearTodos(): Promise<TaskItem[]> {
    // DGC acknowledges with the uncorrelated `todos` event every frontend hears.
    const event = await this.request({ type: "clear_todos", request_id: newId("cleartodo") }, "todos",
      { uncorrelatedReply: true });
    this.taskIds.clear();
    this.taskRevision += 1;
    return this.projectTasks(event.todos);
  }

  async getPlan(): Promise<Record<string, unknown>> {
    return this.request({ type: "get_plan", request_id: newId("plan") }, "saved_plan");
  }

  async getConfig(): Promise<Record<string, unknown>> {
    return this.request({ type: "get_config", request_id: newId("cfgget") }, "config");
  }

  /** The CLI's token usage for `range`. Each `by_model` row names the system it ran on (`system`, `system_id`,
   *  `system_kind`) on a CLI with `capabilities.usage_by_system`; `system` (a row's `system_id`, or a system's name)
   *  keeps that system's usage only, and needs that CLI. */
  async getUsage(range = "today", system?: string): Promise<Record<string, unknown>> {
    const command: Record<string, unknown> = { type: "get_usage", range, request_id: newId("usage") };
    if (system) {
      if (!this.capabilities.usage_by_system) throw new DGCUnsupportedError("This DGC CLI can't show usage by system; update it (dgc update).");
      command.system = String(system);
    }
    return this.request(command, "usage_report");
  }

  async newSession(): Promise<Record<string, unknown>> {
    const event = await this.request({ type: "new_session", request_id: newId("new") }, "session");
    this.sessionId = String(event.session_id || this.sessionId);
    this.sessionPath = String(event.path || "");
    await this.discardIdle();
    return event;
  }

  async nameSession(name: string): Promise<Record<string, unknown>> {
    return this.request({ type: "name_session", name, request_id: newId("name") }, "session_named");
  }

  async deleteSession(path: string): Promise<SessionInfo[]> {
    const event = await this.request({ type: "delete_session", path, request_id: newId("del") }, "sessions");
    return rowsToSessions(event.items);
  }

  async generateHandoff(save = false): Promise<Record<string, unknown>> {
    return this.request({ type: "generate_handoff", save, request_id: newId("handoff") }, "handoff",
      { timeoutMs: 60_000 });
  }

  // ---- reading the pipe -----------------------------------------------------------------------

  private async read(timeoutMs: number): Promise<Item> {
    const pending = this.pending.shift();
    if (pending) return pending;
    const event = await this.transport.next(Math.max(10, timeoutMs));
    const [owner, scoped] = this.observe(event);
    return { event, owner, scoped };
  }

  /**
   * Bookkeeping every event gets, whichever reader takes it: turn ownership, prompt outcomes,
   * usage billing, the audit row, and identity.
   */
  private observe(event: Frame): [Run | null, boolean] {
    const kind = String(event.type || "");
    const rid = typeof event.request_id === "string" ? event.request_id : "";
    let owner: Run | null = null;
    let scoped = false;
    if (kind === "turn_start") {
      const tid = String(event.turn_id || "");
      owner = rid ? this.owners.get(rid) || null : null;
      if (!owner && !rid && String(event.kind || "prompt") === "prompt") owner = this.adoptable();
      if (owner) {
        const started = rid || owner.requestId;
        owner.turnIds.add(tid);
        owner.startedIds.add(started);
        owner.expect.delete(started);
        owner.liveTurn = tid;
        owner.started = true;
      }
      this.turn = { id: tid, owner, requestId: rid };
      scoped = true;
    } else if (kind === "turn_end") {
      const tid = String(event.turn_id || "");
      const turn = this.turn;
      if (turn && turn.id === tid) {
        owner = turn.owner;
        this.turn = null;
      } else {
        owner = [...this.owners.values()].find((run) => run.turnIds.has(tid)) || null;
      }
      if (owner) {
        owner.liveTurn = "";
        owner.pendingBills += 1;
      }
      this.billTo = [owner, tid];
      scoped = true;
    } else if (this.turn && !rid) {
      owner = this.turn.owner;
      scoped = true;
    }
    if (kind === "context") this.account(event);
    else if (["prompt_accepted", "steering_update", "command_rejected", "error"].includes(kind) && rid) {
      this.noteOutcome(kind, rid, event);
    } else if ((kind === "model_changed" || kind === "config") && event.model) {
      this.modelSeen = String(event.model);
    } else if (kind === "session" && !rid) {
      this.sessionId = String(event.session_id || this.sessionId);
      if (event.path) this.sessionPath = String(event.path);
    }
    let runId: string;
    if (owner) runId = owner.result.runId;
    else if (rid && this.owners.has(rid)) runId = this.owners.get(rid)!.result.runId;
    else if (scoped) runId = `turn-${String(event.turn_id || this.turn?.id || "")}`;
    else runId = this.active ? this.active.result.runId : "";
    if (this.init.auditLog && AUDIT_EVENTS.has(kind)) {
      try {
        const payload: Record<string, unknown> = {};
        for (const key of AUDIT_FIELDS) {
          const value = event[key];
          if (value === undefined || value === null || value === "") continue;
          if (Array.isArray(value) && !value.length) continue;
          if (typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length) continue;
          payload[key] = value;
        }
        this.init.auditLog.append(this.sessionId, runId, kind, payload,
          !(this.init.policy && !this.init.policy.redactEvents));
      } catch (error) {
        warn(`dgc sdk: could not write an audit row: ${String(error)}`);
      }
    }
    return [owner, scoped];
  }

  /** A workflow prompt's turn carries no request id; give it to the run waiting for it. */
  private adoptable(): Run | null {
    const run = this.active;
    return run && run.expect.has(run.requestId) ? run : null;
  }

  private noteOutcome(kind: string, rid: string, event: Frame): void {
    const run = this.owners.get(rid);
    if (!run) return;
    const state = String(event.state || "");
    if (kind === "prompt_accepted") {
      run.unresolved.delete(rid);
      if ((state === "started" || state === "queued") && run.steers.has(rid) && !run.startedIds.has(rid)) {
        run.expect.add(rid);        // the steer became a turn of its own
      }
    } else if (kind === "steering_update") {
      run.unresolved.delete(rid);
      if (state === "queued" && !run.startedIds.has(rid)) run.expect.add(rid);
      else if (state === "returned") {
        run.expect.delete(rid);
        run.returned.add(rid);
      }
    } else {
      run.unresolved.delete(rid);
      run.expect.delete(rid);
      run.rejected.set(rid, String(event.message || event.reason || kind));
    }
  }

  private account(event: Frame): void {
    const totals = usageTotals(event);
    if (!totals) return;
    const bill = this.billTo;
    this.billTo = null;
    if (bill) {
      const [owner, tid] = bill;
      const delta = this.usageLast ? usageDelta(this.usageLast, totals) : null;
      if (owner) {
        owner.pendingBills = Math.max(0, owner.pendingBills - 1);
        owner.billed += 1;
        if (!delta || !reported(delta)) {
          owner.usageUnknown = true;
          // DGC still counted the requests; only their token usage is unknown.
          if (delta) owner.usage.requests += delta.requests;
        } else {
          for (const key of USAGE_TOTAL_KEYS) owner.usage[key] += delta[key];
        }
      } else if (delta && delta.requests && this.init.usageLog) {
        // A turn no run owns (a goal resume, a late steer): its spend is still recorded.
        const known = reported(delta);
        const row: Record<string, unknown> = { run_id: `turn-${tid}`, status: "unowned" };
        for (const key of USAGE_TOTAL_KEYS) row[key] = known || key === "requests" ? delta[key] : null;
        this.recordUsage(row);
      }
    }
    this.usageLast = totals;
  }

  /**
   * After a resume: run in the mode this session asked for, not the transcript's. DGC 0.47.0
   * reopens a transcript in the mode it last ran in, when that asks no less than the mode it
   * replaces. Isolated sessions only; an inherited one takes your own DGC's mode.
   */
  async keepRequestedMode(timeoutMs: number): Promise<void> {
    if (!this.init.isolated) return;
    const mode = this.init.permissionMode;
    const command: Frame = { type: "set_mode", mode, request_id: newId("mode") };
    if (mode === "acceptEdits" || mode === "auto") command.acknowledge_workspace_trust = true;
    await this.transport.request(command, "mode_changed", { timeoutMs });
  }

  /** Drop control events left on the pipe (after resume/fork/rewind); stop at anything else. */
  async discardIdle(timeoutMs = 250): Promise<void> {
    const deadline = Date.now() + Math.max(50, timeoutMs);
    while (Date.now() < deadline) {
      let item: Item;
      try {
        item = await this.read(Math.min(50, Math.max(20, deadline - Date.now())));
      } catch {
        return;
      }
      if (IDLE_EVENT_TYPES.has(String(item.event.type || ""))) continue;
      this.pending.unshift(item);
      return;
    }
  }

  // ---- cancellation ---------------------------------------------------------------------------

  /** @internal */
  cancelRun(run: Run, reason: "cancelled" | "timeout" | "decision_failed"): void {
    if (run.done) return;
    if (!run.cancelReason) {
      run.cancelReason = reason;
      run.noteCancel();
    }
    // A follow-up still queued behind another run is cancelled when its turn starts; DGC's cancel
    // would stop the run in front of it too.
    const send = run === this.active && !run.cancelSent;
    if (send) {
      run.cancelSent = true;
      run.cancelAt = Date.now();
      try {
        this.transport.send({ type: "cancel" });
      } catch (error) {
        throw new DGCRuntimeError("could not cancel the run", { cause: error });
      }
    }
  }

  /** @internal Drop a queued run nobody will drive. */
  forget(run: Run): void {
    this.queued = this.queued.filter((item) => item !== run);
    for (const rid of run.ids) if (this.owners.get(rid) === run) this.owners.delete(rid);
    if (this.active === run) this.active = null;
    if (!TERMINAL.has(run.result.status)) {
      run.result.status = "cancelled";
      run.result.reason = "cancelled";
    }
    run.markDone();
  }

  // ---- the pump -------------------------------------------------------------------------------

  private composePrompt(prompt: string): string {
    const instructions = this.init.instructions.trim();
    if (!instructions) return prompt;
    return `<application-instructions>\n${instructions}\n</application-instructions>\n\n${prompt}`;
  }

  /** Apply a run-scoped max_turns; DGC persists set_config, so it is restored after. */
  private async setRunMaxTurns(value: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        await this.configScope(() => this.request(
          { type: "set_config", values: { max_turns: value }, request_id: newId("cfg") }, "config"));
        return;
      } catch (error) {
        if (error instanceof DGCCommandRejectedError && error.reason === "turn_in_progress" && Date.now() < deadline) {
          await sleep(100);
          continue;
        }
        throw error;
      }
    }
  }

  private async restoreMaxTurns(): Promise<void> {
    try {
      await this.setRunMaxTurns(this.init.maxTurns ?? 0);
      this.maxTurnsDirty = false;
    } catch (error) {
      warn(`dgc sdk: could not restore the session maxTurns: ${String(error)}`);
    }
  }

  private sendPrompt(run: Run, text: string, skills: string[] | undefined, workflow: string | undefined,
    requestId: string): void {
    const payload: Frame = { type: "prompt", text, request_id: requestId };
    if (skills?.length) payload.skills = [...skills];
    if (workflow) payload.workflow = workflow;
    if (run.output) payload.output = run.output;
    run.ids.add(requestId);
    run.expect.add(requestId);
    this.owners.set(requestId, run);
    this.transport.send(payload);
  }

  private async *pump(
    run: Run, prompt: string, timeoutMs: number | null, maxTurns: number | undefined,
    outputSchema: Record<string, unknown> | undefined, skills: string[] | undefined,
    workflow: string | undefined, repairAttempts: number, send: boolean, prior: Run | null,
  ): AsyncGenerator<RunEvent> {
    const result = run.result;
    const acc = new Accumulator(result);
    let normal = false;
    let scoped = false;
    let before: Snapshot = new Map();
    try {
      run.pumpStarted = true;
      if (prior) {
        if (prior.handle) {
          try { await prior.handle.result(); } catch { /* its own caller sees that */ }
        }
        await prior.waitDone(CANCEL_GRACE_MS + 5_000);
        this.queued = this.queued.filter((item) => item !== run);
        if (!this.active || this.active.done) this.active = run;
        result.status = "running";
      }
      // DGC starts a queued follow-up as soon as the turn in front of it ends, so its "before" is
      // the workspace at that moment, not whenever this pump got here.
      before = (!send && prior?.after ? prior.after : null) ?? snapshotWorkspace(this.init.cwd, this.init.excludePaths);
      const stopped = run.held && (Boolean(prior?.cancelReason) || prior?.result.status === "cancelled");
      if ((send && run.cancelReason) || (run.held && (run.cancelReason || stopped))) {
        // Cancelled before its prompt went out (an aborted signal), or a held follow-up behind a
        // stopped run: DGC hands queued prompts back when the run in front is stopped; so does this.
        acc.cancel();
        if (run.held && run.cancelReason !== "cancelled") acc.error = "DGC stopped before this queued prompt ran";
        await this.finish(run, acc, before);
        normal = true;
        return;
      }
      if (send) {
        if (maxTurns !== undefined) {
          this.maxTurnsDirty = true;
          await this.setRunMaxTurns(maxTurns);
          scoped = true;
        } else if (this.maxTurnsDirty) {
          await this.restoreMaxTurns();       // an abandoned run left its own max_turns behind
        }
        this.sendPrompt(run, this.composePrompt(prompt), skills, workflow, run.requestId);
      }
      yield* this.turns(run, acc, timeoutMs, false);
      if (outputSchema && acc.status === "completed") {
        this.applySchema(result, outputSchema, acc);
        let attempts = Math.max(0, Math.trunc(repairAttempts));
        while (result.output === undefined && attempts > 0 && acc.status === "completed" && !run.cancelReason) {
          attempts -= 1;
          const repair = "Return only valid JSON matching this schema. Do not call tools. Do not edit files.\n"
            + JSON.stringify(outputSchema)
            + `\nPrevious errors: ${acc.error || "the last answer was not valid JSON"}`;
          acc.error = undefined;
          if (this.init.isolated) {
            try {
              this.maxTurnsDirty = true;
              await this.setRunMaxTurns(1);
              scoped = true;
            } catch (error) {
              warn(`dgc sdk: repair runs without a turn cap: ${String(error)}`);
            }
          }
          this.sendPrompt(run, repair, undefined, undefined, newId("repair"));
          yield* this.turns(run, acc, timeoutMs, true);
          if (acc.status === "completed") this.applySchema(result, outputSchema, acc);
        }
      }
      if (scoped) {
        scoped = false;
        await this.restoreMaxTurns();
      }
      await this.finish(run, acc, before);
      normal = true;
    } catch (error) {
      if (!(error instanceof DGCError) || !this.transport.closed) throw error;
      // The backend went away under this run.
      normal = true;
      const cancelled = run.cancelReason === "cancelled";
      result.status = cancelled ? "cancelled" : "failed";
      result.reason = cancelled ? "cancelled" : "transport";
      result.error = cancelled ? undefined : error.message;
    } finally {
      if (!normal && !run.done && !TERMINAL.has(result.status)) {
        // The consumer left early (break / return): stop the agent too.
        try { this.cancelRun(run, "cancelled"); } catch { /* the transport is gone */ }
        result.status = "cancelled";
        result.reason = "cancelled";
      }
      if (scoped && normal) await this.restoreMaxTurns();
      if (!TERMINAL.has(result.status)) {
        result.status = "failed";
        result.reason = result.reason || "error";
      }
      if (this.active === run) this.active = null;
      this.queued = this.queued.filter((item) => item !== run);
      for (const rid of run.ids) if (this.owners.get(rid) === run) this.owners.delete(rid);
      run.markDone();
    }
  }

  /** Pump events until every turn this run owns has ended. */
  private async *turns(run: Run, acc: Accumulator, timeoutMs: number | null, repairing: boolean): AsyncGenerator<RunEvent> {
    const result = run.result;
    const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
    let grace: number | null = null;      // after our last turn: waiting for a steer's outcome
    let endedAny = false;
    for (;;) {
      const now = Date.now();
      const rejected = endedAny ? undefined : run.rejected.get(run.requestId);
      const returned = run.returned.has(run.requestId) && !run.started;
      if (rejected !== undefined) {
        if (run.cancelReason === "cancelled") acc.cancel();
        else acc.fail("rejected", rejected);
        return;
      }
      if (returned) {
        acc.cancel();
        acc.error = "DGC stopped before this queued prompt ran";
        return;
      }
      if (run.cancelReason && !run.cancelSent) {
        try { this.cancelRun(run, run.cancelReason); } catch { /* reported by the next read */ }
      }
      if (deadline !== null && now >= deadline && !run.cancelReason) {
        acc.timeoutMs = timeoutMs || 0;
        acc.partial();
        try { this.cancelRun(run, "timeout"); } catch { /* reported by the next read */ }
      }
      if (run.cancelSent) {
        const limit = run.cancelReason === "timeout" ? TIMEOUT_GRACE_MS : CANCEL_GRACE_MS;
        if (now - run.cancelAt >= limit) {
          acc.stopped(run, timeoutMs);
          return;
        }
      }
      if (grace !== null) {
        const state = this.completion(run);
        if (state === "done" || (state === "steer" && now >= grace)) return;
        if (state === "turn") grace = null;
      }
      let wait = SLICE_MS;
      if (deadline !== null && !run.cancelReason) wait = Math.max(10, Math.min(wait, deadline - now));
      let item: Item;
      try {
        item = await this.read(wait);
      } catch (error) {
        if (error instanceof DGCTimeoutError) continue;
        acc.transport(run, error);
        return;
      }
      const { event, owner, scoped } = item;
      const kind = String(event.type || "");
      if (kind === "ready") continue;
      const mine = scoped && owner === run;
      if (mine && kind === "turn_end" && !run.expect.size && !run.unresolved.size) {
        // This run's last turn just ended; a queued follow-up may start any moment now.
        run.after = snapshotWorkspace(this.init.cwd, this.init.excludePaths);
      }
      if (scoped && !mine && !DECISION_EVENTS.has(kind)) continue;   // observed and audited, not reported
      if (!scoped || mine) {
        yield {
          type: kind, data: event, sessionId: this.sessionId, runId: result.runId,
          requestId: typeof event.request_id === "string" ? event.request_id : run.requestId,
        };
      }
      if (DECISION_EVENTS.has(kind)) {
        // A decision blocks DGC whoever's turn it is, so it is always answered.
        await this.answer(run, event, kind, repairing, mine || !scoped);
        continue;
      }
      if (!mine) {
        if (["context", "artifact_ready", "agent_started", "agent_ended"].includes(kind)) acc.take(kind, event, this);
        continue;
      }
      if (kind === "turn_end") {
        endedAny = true;
        acc.endTurn(event);
        if (run.cancelReason) return;
        const state = this.completion(run);
        if (state === "done") return;
        if (state === "steer") grace = Date.now() + STEER_GRACE_MS;
        continue;
      }
      acc.take(kind, event, this);
      if (kind === "error" && event.fatal) {
        acc.fatalError(run, event);
        return;
      }
    }
  }

  private completion(run: Run): "turn" | "steer" | "done" {
    if (run.expect.size) return "turn";
    if (run.unresolved.size) return "steer";
    return "done";
  }

  /** The usage totals for a turn arrive right after its turn_end. */
  private async awaitBilling(run: Run): Promise<void> {
    const deadline = Date.now() + BILLING_WAIT_MS;
    const held: Item[] = [];
    try {
      while (run.pendingBills > 0 && Date.now() < deadline) {
        let item: Item;
        try {
          item = await this.read(Math.max(10, Math.min(200, deadline - Date.now())));
        } catch (error) {
          if (error instanceof DGCTimeoutError) continue;
          return;
        }
        if (item.event.type !== "context") held.push(item);
      }
    } finally {
      this.pending.unshift(...held);
    }
  }

  private async finish(run: Run, acc: Accumulator, before: Snapshot): Promise<void> {
    const result = run.result;
    if (run.pendingBills) await this.awaitBilling(run);
    const status = acc.settle(run);
    result.changes = diffWorkspace(this.init.cwd, before, this.init.excludePaths, run.after);
    result.verification = acc.verification(this.init.verifyCommand);
    this.finishUsage(run, acc, status);
    if (!this.sessionPath && !this.transport.closed) {
      try { await this.bindIdentity(); } catch { /* bound after a later run */ }
    }
    result.status = status;    // last: a terminal status means the result is complete
  }

  private applySchema(result: RunResult, schema: Record<string, unknown>, acc: Accumulator): void {
    let parsed: unknown;
    try {
      parsed = extractJson(result.finalText);
    } catch (error) {
      acc.error = `output_schema: ${error instanceof Error ? error.message : String(error)}`;
      result.output = undefined;
      return;
    }
    const problems = validateSchema(parsed, schema);
    if (problems.length) {
      acc.error = "output_schema: " + problems.slice(0, 8).join("; ");
      result.output = undefined;
      return;
    }
    result.output = parsed;
    acc.error = undefined;
  }

  /** @internal */
  projectTasks(rows: unknown): TaskItem[] {
    this.taskRevision += 1;
    const items: TaskItem[] = [];
    const seen = new Map<string, string>();
    if (!Array.isArray(rows)) return items;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      const content = String(item.content || item.text || "");
      const key = content.trim().toLowerCase();
      const tid = String(item.id || this.taskIds.get(key) || `task-${randomUUID().replace(/-/g, "").slice(0, 10)}`);
      if (key) {
        seen.set(key, tid);
        this.taskIds.set(key, tid);
      }
      const status = TASK_MAP[String(item.status || "").trim().toLowerCase()] || "pending";
      items.push({ id: tid, content, status, revision: this.taskRevision });
    }
    for (const key of [...this.taskIds.keys()]) if (!seen.has(key)) this.taskIds.delete(key);
    return items;
  }

  private recordUsage(row: Record<string, unknown>): void {
    if (!this.init.usageLog) return;
    try {
      this.init.usageLog.record({
        session_id: this.sessionId, department: this.init.department,
        model: this.modelSeen || this.init.model, ...row,
      });
    } catch (error) {
      warn(`dgc sdk: could not record usage: ${String(error)}`);
    }
  }

  private finishUsage(run: Run, acc: Accumulator, status: string): void {
    const result = run.result;
    const usage: Record<string, unknown> = { ...acc.usage };
    const known = run.billed > 0 && !run.usageUnknown;
    for (const key of USAGE_TOTAL_KEYS) {
      if (key === "requests") usage[key] = run.billed ? run.usage[key] : null;
      else usage[key] = known ? run.usage[key] : null;
    }
    const dollars = known ? costUsd(usage.input_tokens as number, usage.output_tokens as number,
      usage.cached_input_tokens as number, this.init.pricing) : null;
    usage.cost_usd = dollars;
    usage.usage_known = known;
    usage.department = this.init.department;
    usage.model = this.modelSeen || this.init.model;
    result.usage = usage;
    const row: Record<string, unknown> = {
      session_id: result.sessionId || this.sessionId, run_id: result.runId, status,
    };
    for (const key of USAGE_TOTAL_KEYS) row[key] = usage[key];
    row.token_estimate = usage.token_estimate ?? null;
    row.cost_usd = dollars;
    this.recordUsage(row);
  }

  // ---- decisions ------------------------------------------------------------------------------

  private async answer(run: Run, event: Frame, kind: string, repairing: boolean, mine: boolean): Promise<void> {
    if (mine) run.result.status = "waiting_for_approval";
    try {
      if (kind === "permission_request") {
        const { action, reason } = run.cancelReason || repairing
          ? { action: "deny" as const, reason: "" } : await this.permission(run, event, mine);
        const command: Frame = { type: "permission_response", id: event.id, decision: action };
        // So the runtime does not report the application's policy denial as "Denied by the user".
        if (action === "deny" && reason) command.reason = reason;
        this.respond(command, run);
      } else if (kind === "plan_proposal") {
        const decision = repairing || run.cancelReason ? "reject" : await this.plan(run, event, mine);
        this.respond({ type: "plan_response", id: event.id, decision }, run);
      } else if (kind === "options_request") {
        await this.answerOptions(run, event, mine);
      } else if (kind === "mcp_input_request") {
        await this.answerMcp(run, event, mine);
      }
    } finally {
      if (mine && run.result.status === "waiting_for_approval") run.result.status = "running";
    }
    if (mine && run.decisionError && this.init.unhandled === "callback" && !run.cancelReason) {
      try { this.cancelRun(run, "decision_failed"); } catch { /* reported by the next read */ }
    }
  }

  private respond(command: Frame, run: Run): void {
    try {
      this.transport.send(command);
    } catch (error) {
      if (!run.cancelReason) throw error;
    }
  }

  /**
   * Ask an application callback (sync or async). `decisionTimeoutMs: null` waits as long as it
   * takes; a cancel always wins. A callback that throws, times out, or returns an invalid answer
   * gets `fallback`; with `permissions.unhandled: "callback"` that also stops the run.
   */
  private async decide<T>(run: Run, callback: ((request: never) => unknown) | undefined, request: { id?: string },
    fallback: T, label: string, valid: (value: unknown) => boolean, mine: boolean): Promise<T> {
    const key = request.id || "";
    if (key) {
      if (this.answeredIds.has(key)) return fallback;
      this.answeredIds.add(key);
    }
    if (!callback) return fallback;
    const limit = this.init.options.decisionTimeoutMs === undefined ? 30_000 : this.init.options.decisionTimeoutMs;
    type Outcome = { kind: "value"; value: unknown } | { kind: "error"; error: unknown } | { kind: "timeout" } | { kind: "cancel" };
    let stop = () => {};
    const outcome = await Promise.race<Outcome>([
      Promise.resolve().then(() => (callback as (request: unknown) => unknown)(request))
        .then((value): Outcome => ({ kind: "value", value }), (error): Outcome => ({ kind: "error", error })),
      run.cancelled().then((): Outcome => ({ kind: "cancel" })),
      new Promise<Outcome>((resolve) => {
        stop = longTimer(limit === null ? null : Math.max(50, limit), () => resolve({ kind: "timeout" }));
      }),
    ]);
    stop();
    if (outcome.kind === "cancel") return fallback;
    let problem = "";
    if (outcome.kind === "timeout") problem = `${label} did not answer within ${limit} ms`;
    else if (outcome.kind === "error") {
      const error = outcome.error;
      problem = `${label} threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    } else if (!valid(outcome.value)) {
      let shown: string;
      try { shown = JSON.stringify(outcome.value); } catch { shown = String(outcome.value); }
      problem = `${label} returned an invalid answer: ${shown}`;
    }
    if (problem) {
      warn(`dgc sdk: ${problem}; answering ${JSON.stringify(fallback)}`);
      if (mine && !run.decisionError) run.decisionError = problem;
      return fallback;
    }
    return (outcome as { value: T }).value;
  }

  private async permission(run: Run, event: Frame, mine: boolean): Promise<{ action: PermissionAction; reason: string }> {
    const request: PermissionRequest = {
      id: String(event.id || ""),
      name: String(event.name || ""),
      args: mapping(event.args),
      summary: event.summary ? String(event.summary) : undefined,
      suggestedRule: event.suggested_rule ? String(event.suggested_rule) : undefined,
      callId: typeof event.call_id === "string" ? event.call_id : undefined,
      diff: typeof event.diff === "string" ? event.diff : undefined,
      command: typeof event.command === "string" ? event.command : undefined,
      choices: Array.isArray(event.choices)
        ? (event.choices as unknown[]).filter((c): c is PermissionAction => c === "once" || c === "always" || c === "deny")
        : undefined,
    };
    // Policy denies (tools, paths) are final; command screening defers to a reviewing callback;
    // policy-checked reads are answered here.
    return resolvePermission(this.init.policy, request, {
      cwd: this.init.cwd, permissionMode: this.init.permissionMode, onPermission: this.init.options.onPermission,
      ask: () => this.decide<PermissionAction>(run, this.init.options.onPermission as never, request, "deny",
        "onPermission", (value) => value === "once" || value === "always" || value === "deny", mine),
    });
  }

  private async plan(run: Run, event: Frame, mine: boolean): Promise<string> {
    const request = {
      id: String(event.id || ""),
      plan: String(event.plan || ""),
      choices: Array.isArray(event.choices) ? event.choices.filter((item) => typeof item === "string") as string[] : [],
    };
    const choices = ["auto", "acceptEdits", "default", "reject"];
    const decision = await this.decide<string>(run, this.init.options.onPlan as never, request, "reject", "onPlan",
      (value) => typeof value === "string" && choices.includes(value), mine);
    return choices.includes(decision) ? decision : "reject";
  }

  private async answerOptions(run: Run, event: Frame, mine: boolean): Promise<void> {
    const request: QuestionRequest = {
      id: String(event.id || ""),
      questions: Array.isArray(event.questions) ? event.questions as QuestionRequest["questions"] : [],
      callId: typeof event.call_id === "string" ? event.call_id : undefined,
    };
    let answer: unknown = "dismiss";
    if (this.init.options.onQuestion && !run.cancelReason) {
      answer = await this.decide<unknown>(run, this.init.options.onQuestion as never, request, "dismiss", "onQuestion",
        (value) => value === "dismiss" || (Boolean(value) && typeof value === "object" && !Array.isArray(value)), mine);
    }
    const payload: Record<string, unknown> = {};
    if (answer && typeof answer === "object") {
      for (const [qid, value] of Object.entries(answer as Record<string, unknown>)) {
        if (value && typeof value === "object") payload[qid] = value;
      }
    }
    if (!Object.keys(payload).length) {
      this.respond({ type: "options_response", id: request.id, dismissed: true }, run);
      return;
    }
    this.respond({ type: "options_response", id: request.id, answers: payload }, run);
  }

  private async answerMcp(run: Run, event: Frame, mine: boolean): Promise<void> {
    const request = {
      id: String(event.id || ""), server: String(event.server || ""), kind: String(event.kind || ""),
      payload: mapping(event.payload),
    };
    let response: McpInputResponse | null = null;
    if (this.init.options.onMcpInput && !run.cancelReason) {
      response = await this.decide<McpInputResponse | null>(run, this.init.options.onMcpInput as never, request, null,
        "onMcpInput", (value) => Boolean(value) && typeof value === "object"
          && ["accept", "decline", "cancel"].includes(String((value as McpInputResponse).action)), mine);
    }
    const payload: Frame = { type: "mcp_input_response", id: request.id, action: response ? response.action : "cancel" };
    if (response?.content) payload.content = { ...response.content };
    this.respond(payload, run);
  }
}

/** What one run collects from the turns it owns. */
class Accumulator {
  readonly result: RunResult;
  tools = new Map<string, ToolRecord>();
  denials: Denial[] = [];
  text: string[] = [];
  blocks = new Map<string, string>();
  answerIds: string[] = [];
  artifacts = new Map<string, Artifact>();
  documents = new Map<string, Artifact>();
  tasks: TaskItem[];
  agents = new Map<string, AgentInfo>();
  usage: Record<string, unknown> = {};
  status: RunStatus = "running";
  reason = "";
  error: string | undefined;
  timeoutMs = 0;
  lastError = "";
  verifyCalls = new Set<string>();
  verifyModel: VerificationResult | null = null;
  verifyCli: "" | "ran" | "failed" = "";
  verifyCliMessage = "";
  verifyOrder = 0;
  verifyModelOrder = -1;
  verifyCliOrder = -1;
  made = new Map<string, ArtifactInfo>();

  constructor(result: RunResult) {
    this.result = result;
    for (const item of result.artifacts) this.artifacts.set(item.id, item);
    for (const item of result.documents) this.documents.set(item.id, item);
    for (const item of result.madeArtifacts || []) this.made.set(item.id, item);
    this.tasks = [...(result.tasks || [])];
    for (const item of result.agents || []) this.agents.set(item.id, item);
  }

  take(kind: string, event: Frame, session: Session): void {
    if (kind === "text_delta") {
      this.text.push(String(event.text || ""));
    } else if (kind === "stream_end") {
      const messageId = String(event.message_id || "");
      const block = this.text.join("");
      this.text = [];
      if (messageId) {
        this.blocks.set(messageId, block);
        if (event.phase === "answer") this.answerIds.push(messageId);
      }
    } else if (kind === "tool_call") {
      const callId = String(event.call_id || "");
      const args = mapping(event.args);
      const name = String(event.name || "");
      this.tools.set(callId, { name, callId, summary: String(event.summary || ""), args });
      if (name === "bash" && session.verifyCommand && sameCommand(String(args.command || ""), session.verifyCommand)) {
        this.verifyCalls.add(callId);
      }
    } else if (kind === "tool_result") {
      const callId = String(event.call_id || "");
      const record = this.tools.get(callId) || { name: String(event.name || ""), callId };
      let output: unknown = event.output;
      if (output === undefined || output === null) output = event.result || event.content || "";
      let text = typeof output === "string" ? output : JSON.stringify(output);
      if (!text && record.summary) text = record.summary;
      const updated: ToolRecord = {
        name: record.name || String(event.name || ""), callId, summary: record.summary, output: text,
        isError: Boolean(event.is_error), isDiff: Boolean(event.is_diff),
        diff: typeof event.diff === "string" ? event.diff : undefined, args: record.args,
      };
      this.tools.set(callId, updated);
      if (this.verifyCalls.has(callId)) {
        const code = exitCode(text);
        const ok = code === null ? !updated.isError : code === 0;
        this.verifyModel = { ok, command: session.verifyCommand, output: text.slice(0, 8000), exitCode: code };
        this.verifyOrder += 1;
        this.verifyModelOrder = this.verifyOrder;
      }
      if (updated.name === "present_document") {
        (text.match(LOOPBACK) || []).forEach((url, index) => {
          const id = `${callId || "doc"}-${index}`;
          this.documents.set(id, { id, name: index === 0 ? "document" : "document.md", url });
        });
      }
    } else if (kind === "tool_denied") {
      const callId = String(event.call_id || "");
      const name = String(event.name || "");
      const reason = String(event.reason || "denied");
      this.tools.set(callId, { name, callId, output: reason, isError: true });
      this.denials.push({ name, reason, source: denialSource(reason), callId, args: mapping(event.args) });
    } else if (kind === "artifact_ready") {
      const art: Artifact = {
        id: String(event.id || ""), name: String(event.name || ""), url: String(event.url || ""), rel: String(event.rel || ""),
      };
      this.artifacts.set(art.id, art);
      if (art.url.startsWith("http://127.0.0.1") || art.url.startsWith("http://localhost")) this.documents.set(art.id, art);
    } else if (kind === "artifact_changed" && event.artifact && typeof event.artifact === "object") {
      const info = artifactInfo(event.artifact);
      if (event.op === "removed") this.made.delete(info.id);
      else this.made.set(info.id, info);
    } else if (kind === "todos") {
      this.tasks = session.projectTasks(event.todos);
    } else if (kind === "agent_started" || kind === "agent_ended") {
      const info = agentFromRow(event);
      if (info.id) this.agents.set(info.id, info);
    } else if (kind === "context") {
      if (typeof event.used === "number") this.usage.context_used = event.used;
      if (typeof event.size === "number") this.usage.context_size = event.size;
    } else if (kind === "info") {
      this.noteVerifier(String(event.message || ""), session.verifyCommand);
    } else if (kind === "error") {
      const message = String(event.message || "");
      if (message) this.lastError = message;
      this.noteVerifier(message, session.verifyCommand);
    }
  }

  private noteVerifier(message: string, command: string): void {
    if (!command || !message) return;
    const text = message.trim();
    if (text.startsWith(VERIFY_STARTED)) {
      this.verifyOrder += 1;
      this.verifyCliOrder = this.verifyOrder;
      this.verifyCli = "ran";
      this.verifyCliMessage = "";
    } else if (text.includes("configured verifier") && this.verifyCli
        && ["failed", "still failing", "did not pass"].some((word) => text.includes(word))) {
      this.verifyCli = "failed";
      this.verifyCliMessage = text;
    }
  }

  endTurn(event: Frame): void {
    const reason = String(event.reason || "completed");
    this.reason = reason;
    const finalId = event.final_message_id;
    let final: string;
    if (typeof finalId === "string" && this.blocks.has(finalId)) final = this.blocks.get(finalId) || "";
    else if (this.answerIds.length && this.blocks.has(this.answerIds[this.answerIds.length - 1])) {
      final = this.blocks.get(this.answerIds[this.answerIds.length - 1]) || "";
    } else final = [...this.blocks.values()].join("") || this.text.join("");
    this.result.finalText = final;
    this.blocks.clear();
    this.answerIds = [];
    this.text = [];
    if (typeof event.token_estimate === "number") this.usage.token_estimate = event.token_estimate;
    if (reason === "error" || reason === "failed") {
      this.status = "failed";
      this.error = this.lastError || "the turn ended with an error";
    } else if (reason === "paused") {
      this.status = "paused";
    } else if (reason === "cancelled" || reason === "interrupted") {
      this.status = "cancelled";
    } else {
      this.status = "completed";
    }
    this.lastError = "";
  }

  fail(reason: string, message: string): void {
    this.status = "failed";
    this.reason = reason;
    this.error = message;
  }

  cancel(): void {
    this.status = "cancelled";
    this.reason = "cancelled";
  }

  partial(): void {
    this.result.partialText = this.text.join("") || [...this.blocks.values()].join("");
  }

  /** A cancel or timeout whose turn never reported its end within the grace period. */
  stopped(run: Run, timeoutMs: number | null): void {
    this.partial();
    if (run.cancelReason === "timeout") this.fail("timeout", `run exceeded its ${timeoutMs || 0} ms timeout`);
    else if (run.cancelReason === "decision_failed") this.fail("decision_failed", run.decisionError || "a decision callback failed");
    else this.cancel();
  }

  transport(run: Run, error: unknown): void {
    this.partial();
    if (run.cancelReason === "cancelled") this.cancel();
    else this.fail("transport", error instanceof Error ? error.message : String(error));
  }

  fatalError(run: Run, event: Frame): void {
    this.partial();
    if (run.cancelReason === "cancelled") this.cancel();
    else this.fail("runtime", String(event.message || "fatal backend error"));
  }

  /** Fill the run's result and return its final status (the caller publishes it last). */
  settle(run: Run): RunStatus {
    const result = this.result;
    result.tools = [...this.tools.values()];
    result.denials = [...this.denials];
    result.artifacts = [...this.artifacts.values()];
    result.documents = [...this.documents.values()];
    result.madeArtifacts = [...this.made.values()];
    result.tasks = this.tasks;
    result.agents = [...this.agents.values()];
    let status = this.status;
    let reason = this.reason;
    let error = this.error;
    if (run.cancelReason === "timeout") {
      status = "failed";
      reason = "timeout";
      error = error && error.includes("timeout") ? error
        : this.timeoutMs ? `run exceeded its ${this.timeoutMs} ms timeout` : "run exceeded its timeout";
      result.partialText = result.partialText || result.finalText;
    } else if (run.cancelReason === "decision_failed") {
      status = "failed";
      reason = "decision_failed";
      error = run.decisionError || "a decision callback failed";
      result.partialText = result.partialText || result.finalText;
    } else if (run.cancelReason === "cancelled" || status === "cancelled") {
      status = "cancelled";
      reason = "cancelled";
      error = undefined;
      result.partialText = result.partialText || result.finalText;
    } else if (status === "running") {
      status = "failed";
      reason = reason || "error";
      error = error || "the run ended without a result";
    }
    result.error = error;
    result.reason = reason || status;
    result.usage = { ...this.usage };
    return status;
  }

  verification(command: string): VerificationResult | undefined {
    const text = (command || "").trim();
    if (!text) return undefined;
    if (this.verifyCli && this.verifyCliOrder > this.verifyModelOrder) {
      if (this.verifyCli === "failed") return { ok: false, command: text, output: this.verifyCliMessage };
      if (this.status === "completed" && this.reason === "completed") return { ok: true, command: text, exitCode: 0 };
      return { ok: null, command: text };
    }
    if (this.verifyModel) return this.verifyModel;
    return { ok: null, command: text };
  }
}

function permissionRows(raw: unknown): Array<{ action: string; rule: string }> {
  return (Array.isArray(raw) ? raw : []).filter((row) => row && typeof row === "object").map((row) => {
    const item = row as Record<string, unknown>;
    return { action: String(item.action || ""), rule: String(item.rule || "") };
  });
}

export function rowsToSessions(raw: unknown): SessionInfo[] {
  const items: SessionInfo[] = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const path = String(item.path || "");
    items.push({
      id: path ? basename(path).replace(/\.json$/, "") : "",
      path,
      name: String(item.name || ""),
      preview: String(item.preview || ""),
      messageCount: Number(item.count || 0),
      when: String(item.when || ""),
    });
  }
  return items;
}
