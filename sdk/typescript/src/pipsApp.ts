/**
 * Your app's tools for Personal Pips (Pips API 61): define them, register them, and serve DGC's calls.
 * Mirrors sdk/python/dgc_sdk/pips_app.py.
 *
 * Define each tool with `definePipTool`, register the app once with `session.pips.registerApp(...)` (an approved
 * mutation: DGC answers with the app's signing secret, shown that once), then serve DGC's calls at the address you
 * registered with `AppToolHandler`: `handle()` is framework-free, `express()` is an Express handler (mount it before
 * any JSON body parser, or with `express.raw({ type: "application/json" })`, so the signed bytes are the ones it
 * reads), and `fetch()` answers a web `Request` with a `Response`.
 *
 * Each call is signed: `X-DGC-Signature` is `v1=` and the hex HMAC-SHA256, keyed by the secret's text, of
 * `"<timestamp>.<nonce>."` followed by the body. The handler refuses a timestamp more than five minutes off and a
 * nonce it has seen (kept in memory, bounded), checks the arguments against the tool's schema, and answers
 * `{ok: true, result}` or `{ok: false, error: {code, message}}`. A change runs only for a call that carries the
 * action the user accepted (`ctx.actionId`, `ctx.actionDigest`); DGC sends each accepted action once, never again.
 *
 * Approvals in your app (Pips API 62): when a Pip's change waits for a person, DGC POSTs a signed `approval_requested`
 * to the same address, and `approval_resolved` when it is accepted, rejected or expires (wherever that happened). Pass
 * `onApprovalRequested` and `onApprovalResolved` to show them on your own admin screen; each gets the event once the
 * same signature checks pass. Without a callback the handler answers 204, so an app that doesn't care loses nothing.
 * Decide one with `session.pips.decide(actionId, "accept" | "reject", actionDigest, { approved: true })`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { DGCConfigError } from "./errors.ts";
import { validate as schemaErrors } from "./schema.ts";

export type PipToolKind = "read" | "change";
export type PipTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: PipToolKind;
  movesMoney: boolean;
}>;
/** A tool as register_app and update_app send it. */
export type PipToolWire = { name: string; description: string; input_schema: Record<string, unknown>; kind: PipToolKind; moves_money?: boolean };

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SECRET = /^dgcapp_[0-9a-f]{64}$/;
const KEYWORDS = new Set(["type", "properties", "required", "items", "enum", "additionalProperties", "minLength", "maxLength",
  "minimum", "maximum", "minItems", "maxItems", "description", "title", "default"]);
const TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);
const MAX_DESCRIPTION = 1000;
const MAX_SCHEMA_BYTES = 8192;
const MAX_SCHEMA_DEPTH = 6;
const MAX_BODY = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function checkSchema(schema: unknown, where: string): void {
  if (!isRecord(schema) || schema.type !== "object") throw new DGCConfigError(`${where} must be a JSON schema object with type "object"`);
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(schema), "utf8"); } catch { throw new DGCConfigError(`${where} must be plain JSON`); }
  if (size > MAX_SCHEMA_BYTES) throw new DGCConfigError(`${where} is over ${MAX_SCHEMA_BYTES / 1024} KB`);
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_SCHEMA_DEPTH) throw new DGCConfigError(`${where} nests more than ${MAX_SCHEMA_DEPTH} levels`);
    if (!isRecord(node)) throw new DGCConfigError(`${where} has a part that isn't a schema object`);
    if ("$ref" in node || "$id" in node || "$schema" in node) throw new DGCConfigError(`${where} must not use $ref, $id or $schema`);
    const unknown = Object.keys(node).filter((key) => !KEYWORDS.has(key)).sort();
    if (unknown.length) throw new DGCConfigError(`${where} uses ${unknown[0]}, which the schema subset doesn't have`);
    if (node.type !== undefined) {
      const kinds = Array.isArray(node.type) ? node.type : [node.type];
      if (!kinds.length || kinds.some((kind) => !TYPES.has(String(kind)))) throw new DGCConfigError(`${where} has an unknown type`);
    }
    if (node.properties !== undefined) {
      if (!isRecord(node.properties)) throw new DGCConfigError(`${where}'s properties must be an object`);
      for (const child of Object.values(node.properties)) walk(child, depth + 1);
    }
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((r) => typeof r !== "string"))) {
      throw new DGCConfigError(`${where}'s required must be a list of names`);
    }
    if ("items" in node) walk(node.items, depth + 1);
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") walk(node.additionalProperties, depth + 1);
    if ("enum" in node && !Array.isArray(node.enum)) throw new DGCConfigError(`${where}'s enum must be a list`);
    for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
      if (key in node && !(Number.isInteger(node[key]) && (node[key] as number) >= 0)) throw new DGCConfigError(`${where}'s ${key} must be a whole number`);
    }
    for (const key of ["minimum", "maximum"]) {
      if (key in node && !(typeof node[key] === "number" && Number.isFinite(node[key]))) throw new DGCConfigError(`${where}'s ${key} must be a number`);
    }
  };
  walk(schema, 0);
}

/**
 * Describe one tool of your app for Personal Pips. `kind` is "read" (a Pip uses it freely, or as an exact approved
 * read before its runs) or "change" (a proposal the user accepts once, or always allows for that Pip).
 * `movesMoney: true` marks a change that pays, refunds or transfers: it asks every time and never gets Always allow.
 */
export function definePipTool(name: string, description: string, schema: Record<string, unknown>, kind: PipToolKind,
  options: { movesMoney?: boolean } = {}): PipTool {
  if (typeof name !== "string" || !TOOL_NAME.test(name)) throw new DGCConfigError("a Pip tool's name is a letter and up to 63 letters, digits, _ or -");
  if (typeof description !== "string" || !description.trim() || description.length > MAX_DESCRIPTION) {
    throw new DGCConfigError(`a Pip tool's description is 1 to ${MAX_DESCRIPTION} characters`);
  }
  if (kind !== "read" && kind !== "change") throw new DGCConfigError('a Pip tool\'s kind is "read" or "change"');
  const movesMoney = options.movesMoney ?? false;
  if (typeof movesMoney !== "boolean") throw new DGCConfigError("movesMoney is true or false");
  if (movesMoney && kind !== "change") throw new DGCConfigError("only a change tool can move money");
  checkSchema(schema, `${name}'s schema`);
  return Object.freeze({ name, description: description.trim(), inputSchema: JSON.parse(JSON.stringify(schema)), kind, movesMoney });
}

/** register_app's and update_app's `tools`: definePipTool values, or their wire shape. */
export function pipToolsWire(tools: unknown): PipToolWire[] {
  if (!Array.isArray(tools) || !tools.length) throw new DGCConfigError("tools is a non-empty list of definePipTool values");
  return tools.map((tool) => {
    if (!isRecord(tool)) throw new DGCConfigError("tools is a list of definePipTool values");
    const wire = Object.hasOwn(tool, "inputSchema");
    const keys = Object.keys(tool);
    const allowed = wire ? ["name", "description", "inputSchema", "kind", "movesMoney"] : ["name", "description", "input_schema", "kind", "moves_money"];
    if (keys.some((key) => !allowed.includes(key))) {
      throw new DGCConfigError("a Pip tool has name, description, input schema, kind and moves money: nothing else");
    }
    const checked = definePipTool(tool.name as string, tool.description as string,
      (wire ? tool.inputSchema : tool.input_schema) as Record<string, unknown>, tool.kind as PipToolKind,
      { movesMoney: (wire ? tool.movesMoney : tool.moves_money) as boolean | undefined });
    return { name: checked.name, description: checked.description, input_schema: checked.inputSchema, kind: checked.kind,
      ...(checked.movesMoney ? { moves_money: true } : {}) };
  });
}

/** X-DGC-Signature for one call: "v1=" and the hex HMAC-SHA256 of "<timestamp>.<nonce>." + body. */
export function sign(secret: string, timestamp: string, nonce: string, body: string | Uint8Array): string {
  const hmac = createHmac("sha256", Buffer.from(secret, "utf8"));
  hmac.update(Buffer.from(`${timestamp}.${nonce}.`, "ascii"));
  hmac.update(typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body));
  return "v1=" + hmac.digest("hex");
}

/** Who is calling: the app, the tool, the Pip and its run, and for a change the action the user accepted. */
export type PipCallContext = Readonly<{
  app: string;
  tool: string;
  kind: PipToolKind;
  pipId: string;
  runId: string;
  callId: string;
  timestamp: number;
  nonce: string;
  actionId: string | null;
  actionDigest: string | null;
  /** The accepted action's id (a change's receipt): the same as actionId. */
  approvalId: string | null;
}>;

/** Throw it in a tool to refuse with a message DGC shows the Pip ("the shop app said: ..."). Any other error is
 *  answered as "the tool failed", so its details stay in your app. */
export class PipToolError extends Error {
  readonly code: string;
  constructor(message: string, code = "tool_refused") {
    super(message);
    this.name = "PipToolError";
    this.code = code;
  }
}

/** A Pip's change on your app waits for a person (Pips API 62): show it, and decide it with `pips.decide`.
 *  `movesMoney` is true for a tool you marked so: it always asks a person, and never gets Always allow. */
export type PipApprovalRequested = Readonly<{
  type: "approval_requested";
  app: string;
  actionId: string;
  actionDigest: string;
  tool: string;
  arguments: Record<string, unknown>;
  pipId: string;
  pipName: string;
  runId: string;
  summary: string;
  expiresAt: string;
  movesMoney: boolean;
}>;
/** How one closed, wherever that happened (Pips API 62). `by` is "dgc" (DGC's own card, the CLI or the expiry), "app"
 *  (you, through `pips.decide`), "always_allow" (the Pip's Always allow) or "level" (the Pip's level let it through). */
export type PipApprovalResolved = Readonly<{
  type: "approval_resolved";
  app: string;
  actionId: string;
  tool: string;
  decision: "accepted" | "rejected" | "expired";
  by: string;
  at: string;
}>;
export type AppToolFunction = (args: Record<string, unknown>, ctx: PipCallContext) => unknown | Promise<unknown>;
export type AppToolResponse = { status: number; headers: Record<string, string>; body: string };
export type AppToolHandlerOptions = {
  /** The same definePipTool values you registered, so the handler can check each call's arguments. */
  definitions: readonly PipTool[];
  maxSkewSeconds?: number;
  maxBody?: number;
  maxNonces?: number;
  /** Seconds since the epoch (for tests). */
  clock?: () => number;
  /** Called when a tool throws something other than PipToolError (default: console.error). */
  onError?: (error: unknown, ctx: PipCallContext) => void;
  /** A change waits for a person (Pips API 62). Without it the handler answers 204. */
  onApprovalRequested?: (event: PipApprovalRequested) => unknown | Promise<unknown>;
  /** A change was accepted, rejected or expired (Pips API 62). Without it the handler answers 204. */
  onApprovalResolved?: (event: PipApprovalResolved) => unknown | Promise<unknown>;
};
/** What the handler reads of a web `Headers`. Declared here so the package needs neither the DOM lib nor Node's types. */
export interface HeaderReader { get(name: string): string | null }
/** What `fetch()` reads of a web `Request`: a real one from Node 18+, Bun, Deno or a worker fits. */
export interface WebRequestLike { readonly method: string; readonly headers: HeaderReader; arrayBuffer(): Promise<ArrayBuffer> }
/** A web `Response` where your project has one (the DOM lib, or Node's types); otherwise its shape. */
export type WebResponse = typeof globalThis extends { Response: { prototype: infer R } } ? R
  : { readonly status: number; readonly headers: HeaderReader; text(): Promise<string> };
type HeaderBag = HeaderReader | Record<string, string | string[] | undefined>;
const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function answer(status: number, value: unknown): AppToolResponse {
  return { status, headers: { ...HEADERS }, body: JSON.stringify(value) };
}
function refuse(status: number, code: string, message: string): AppToolResponse {
  return answer(status, { ok: false, error: { code, message } });
}
const text = (value: unknown, limit = 2048): value is string => typeof value === "string" && value.length <= limit;
/** The approval event DGC sent, checked, or null when it isn't one. */
function approvalEvent(call: Record<string, unknown>): PipApprovalRequested | PipApprovalResolved | null {
  if (!text(call.app, 40) || !(typeof call.action_id === "string" && /^appaction_[a-f0-9]{32}$/.test(call.action_id)) || !text(call.tool, 64)) return null;
  if (call.type === "approval_requested") {
    if (!(typeof call.action_digest === "string" && /^[a-f0-9]{64}$/.test(call.action_digest)) || !isRecord(call.arguments)
      || typeof call.moves_money !== "boolean" || !["pip_id", "pip_name", "run_id", "summary", "expires_at"].every((key) => text(call[key]))) return null;
    return Object.freeze({ type: "approval_requested", app: call.app, actionId: call.action_id, actionDigest: call.action_digest,
      tool: call.tool, arguments: call.arguments as Record<string, unknown>, pipId: call.pip_id as string, pipName: call.pip_name as string,
      runId: call.run_id as string, summary: call.summary as string, expiresAt: call.expires_at as string, movesMoney: call.moves_money });
  }
  if (!["accepted", "rejected", "expired"].includes(call.decision as string) || !text(call.by, 32) || !text(call.at, 64)) return null;
  return Object.freeze({ type: "approval_resolved", app: call.app, actionId: call.action_id, tool: call.tool,
    decision: call.decision as "accepted" | "rejected" | "expired", by: call.by, at: call.at });
}
function header(headers: HeaderBag, name: string): string {
  if (typeof (headers as HeaderReader).get === "function") return (headers as HeaderReader).get(name) ?? "";
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value.join(",") : String(value ?? "");
  }
  return "";
}

/** Serve DGC's signed calls to your app's tools: `new AppToolHandler(secret, {name: fn}, {definitions})`. */
export class AppToolHandler {
  private readonly secret: string;
  private readonly tools = new Map<string, { definition: PipTool; fn: AppToolFunction }>();
  private readonly nonces = new Map<string, number>();
  private readonly maxSkew: number;
  private readonly maxBody: number;
  private readonly maxNonces: number;
  private readonly clock: () => number;
  private readonly onError: (error: unknown, ctx: PipCallContext) => void;
  private readonly onApproval: Record<string, ((event: any) => unknown) | undefined>;

  constructor(secret: string, tools: Record<string, AppToolFunction>, options: AppToolHandlerOptions) {
    if (typeof secret !== "string" || !SECRET.test(secret.trim())) {
      throw new DGCConfigError("secret is the one register_app answered with: dgcapp_ and 64 hex digits");
    }
    this.secret = secret.trim();
    const known = new Map((options?.definitions ?? []).map((d) => [d.name, d]));
    if (!isRecord(tools) || !Object.keys(tools).length) throw new DGCConfigError("tools maps each tool's name to its function");
    for (const [name, fn] of Object.entries(tools)) {
      const definition = known.get(name);
      if (!definition) throw new DGCConfigError(`${name} needs its definition to check its arguments: pass its definePipTool value in definitions`);
      if (typeof fn !== "function") throw new DGCConfigError(`${name}'s function is not a function`);
      this.tools.set(name, { definition, fn });
    }
    this.maxSkew = options?.maxSkewSeconds ?? 300;
    this.maxBody = options?.maxBody ?? MAX_BODY;
    this.maxNonces = options?.maxNonces ?? 50_000;
    this.clock = options?.clock ?? (() => Date.now() / 1000);
    this.onError = options?.onError ?? ((error, ctx) => console.error(`Pip tool ${ctx.tool} failed:`, error));
    for (const key of ["onApprovalRequested", "onApprovalResolved"] as const) {
      if (options?.[key] !== undefined && typeof options[key] !== "function") throw new DGCConfigError(`${key} is not a function`);
    }
    this.onApproval = { approval_requested: options?.onApprovalRequested, approval_resolved: options?.onApprovalResolved };
  }

  private seen(nonce: string, now: number): boolean {
    for (const [old, at] of this.nonces) {
      if (now - at <= 2 * this.maxSkew && this.nonces.size < this.maxNonces) break;
      this.nonces.delete(old);
    }
    if (this.nonces.has(nonce)) return true;
    this.nonces.set(nonce, now);
    return false;
  }

  /** One call: headers (any case) and the raw body, as received. */
  async handle(request: { headers: HeaderBag; body: string | Uint8Array }): Promise<AppToolResponse> {
    const raw = typeof request.body === "string" ? Buffer.from(request.body, "utf8") : Buffer.from(request.body ?? []);
    if (raw.byteLength > this.maxBody) return refuse(413, "too_large", "The call is too large.");
    const timestamp = header(request.headers, "x-dgc-timestamp"), nonce = header(request.headers, "x-dgc-nonce");
    const given = header(request.headers, "x-dgc-signature");
    if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{32}$/.test(nonce) || !given.startsWith("v1=")) {
      return refuse(401, "unsigned", "The call isn't signed by DGC.");
    }
    const want = Buffer.from(sign(this.secret, timestamp, nonce, raw), "ascii"), got = Buffer.from(given, "ascii");
    if (want.length !== got.length || !timingSafeEqual(want, got)) return refuse(401, "bad_signature", "The signature didn't match.");
    const now = this.clock();
    if (Math.abs(now - Number(timestamp)) > this.maxSkew) return refuse(401, "stale", "The call's time is more than five minutes off.");
    if (this.seen(nonce, now)) return refuse(401, "replayed", "This call was already received.");
    let call: Record<string, unknown>;
    try { call = JSON.parse(raw.toString("utf8")); } catch { return refuse(400, "invalid_request", "The call isn't JSON."); }
    if (isRecord(call) && (call.type === "approval_requested" || call.type === "approval_resolved")) {
      const event = approvalEvent(call);
      if (!event) return refuse(400, "invalid_request", "The approval event isn't one DGC sends.");
      const callback = this.onApproval[call.type];
      if (!callback) return { status: 204, headers: { "Cache-Control": "no-store" }, body: "" };
      try {
        await callback(event);
      } catch (error) {
        // DGC tries again; the details stay in your app.
        this.onError(error, Object.freeze({ app: event.app, tool: event.tool, kind: "change", pipId: event.type === "approval_requested" ? event.pipId : "",
          runId: event.type === "approval_requested" ? event.runId : "", callId: "", timestamp: Number(timestamp), nonce,
          actionId: event.actionId, actionDigest: event.type === "approval_requested" ? event.actionDigest : null, approvalId: event.actionId }));
        return refuse(500, "callback_failed", "The app couldn't take this approval event.");
      }
      return answer(200, { ok: true });
    }
    if (!isRecord(call) || call.type !== "tool_call" || typeof call.tool !== "string" || !isRecord(call.arguments)
      || ["app", "pip_id", "run_id", "call_id"].some((key) => typeof call[key] !== "string")) {
      return refuse(400, "invalid_request", "The call isn't a DGC tool call.");
    }
    const found = this.tools.get(call.tool);
    if (!found) return refuse(404, "unknown_tool", `This app has no tool named ${call.tool.slice(0, 80)}.`);
    const { definition, fn } = found;
    const actionId = typeof call.action_id === "string" ? call.action_id : null;
    const actionDigest = typeof call.action_digest === "string" ? call.action_digest : null;
    if (definition.kind === "change" && !(actionId && /^appaction_[a-f0-9]{32}$/.test(actionId) && actionDigest && /^[a-f0-9]{64}$/.test(actionDigest))) {
      return refuse(400, "not_accepted", `${definition.name} is a change: it runs only for an action the user accepted.`);
    }
    const wrong = schemaErrors(call.arguments, definition.inputSchema);
    if (wrong.length) return refuse(400, "invalid_arguments", wrong.slice(0, 5).join("; "));
    const ctx: PipCallContext = Object.freeze({ app: call.app as string, tool: definition.name, kind: definition.kind,
      pipId: call.pip_id as string, runId: call.run_id as string, callId: call.call_id as string, timestamp: Number(timestamp),
      nonce, actionId, actionDigest, approvalId: actionId });
    let value: unknown;
    try {
      value = await fn(call.arguments as Record<string, unknown>, ctx);
    } catch (error) {
      if (error instanceof PipToolError) return refuse(422, error.code.slice(0, 64) || "tool_refused", error.message.slice(0, 1000));
      this.onError(error, ctx);
      return refuse(500, "tool_failed", "The tool failed.");
    }
    try {
      return answer(200, { ok: true, result: value === undefined ? null : value });
    } catch {
      return refuse(500, "invalid_result", "The tool's result isn't JSON.");
    }
  }

  /** An Express handler: `app.post("/dgc/pips", express.raw({ type: "application/json" }), handler.express())`. */
  express(): (req: any, res: any) => Promise<void> {
    return async (req: any, res: any) => {
      let out: AppToolResponse;
      if (req.method !== "POST") out = refuse(405, "method", "DGC calls with POST.");
      else {
        let body: Buffer | null = null, tooLarge = false;
        if (Buffer.isBuffer(req.body)) body = req.body;
        else if (typeof req.body === "string") body = Buffer.from(req.body, "utf8");
        else if (req.body === undefined && typeof req[Symbol.asyncIterator] === "function") {
          // Nothing parsed it: read the bytes DGC signed.
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > this.maxBody) { tooLarge = true; break; }
            chunks.push(Buffer.from(chunk));
          }
          body = Buffer.concat(chunks);
        }
        out = tooLarge ? refuse(413, "too_large", "The call is too large.")
          : body === null
            ? refuse(400, "parsed_body", "The body was parsed before the handler: mount it with express.raw({ type: \"application/json\" }), or before express.json().")
            : await this.handle({ headers: req.headers ?? {}, body });
      }
      res.status(out.status);
      for (const [key, value] of Object.entries(out.headers)) res.setHeader(key, value);
      res.send(out.body);
    };
  }

  /** A web `Request` answered with a `Response` (Node 18+, Bun, Deno, workers). */
  async fetch(request: WebRequestLike): Promise<WebResponse> {
    // The runtime's own Response (Node 18+, Bun, Deno, workers), found at run time so the types need no DOM lib.
    const WebResponseClass = (globalThis as unknown as {
      Response: new (body: string | null, init: { status: number; headers: Record<string, string> }) => WebResponse }).Response;
    if (request.method !== "POST") {
      const out = refuse(405, "method", "DGC calls with POST.");
      return new WebResponseClass(out.body, { status: out.status, headers: out.headers });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    const out = await this.handle({ headers: request.headers, body });
    return new WebResponseClass(out.status === 204 ? null : out.body, { status: out.status, headers: out.headers });
  }
}
