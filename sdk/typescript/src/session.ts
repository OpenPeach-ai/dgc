/**
 * One isolated DGC session: at most one active run (plus follow-ups queued behind it).
 * Mirrors sdk/python/dgc_sdk/session.py.
 */
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { DGCCommandRejectedError, DGCConfigError, DGCError, DGCRuntimeError, DGCTimeoutError } from "./errors.ts";
import type { Frame, Transport } from "./transport.ts";
import { longTimer } from "./transport.ts";
import { assertSupported, extractJson, validate as validateSchema } from "./schema.ts";
import type { ToolHub } from "./tools.ts";
import type { AuditLog } from "./audit.ts";
import type { UsageLog, UsageTotals } from "./usage.ts";
import { USAGE_TOTAL_KEYS, costUsd, emptyTotals, reported, usageDelta, usageTotals } from "./usage.ts";
import { diffWorkspace, snapshotWorkspace, type Snapshot } from "./changes.ts";
import { resolvePermission, type Policy } from "./policy.ts";
import type { StateLock } from "./state.ts";
import type {
  AbortSignalLike, AgentInfo, Artifact, Denial, Checkpoint, McpInputResponse, PermissionAction, PermissionRequest, Pricing,
  QuestionRequest, RunEvent, RunOptions, RunResult, RunStatus, SandboxStatus, SessionInfo,
  SessionOptions, TaskItem, ToolRecord, VerificationResult,
} from "./types.ts";

const LOOPBACK = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/\S+/gi;
// Control events left on the pipe after resume/fork/rewind; not attributed to the next run.
const IDLE_EVENT_TYPES = new Set([
  "history", "agents", "context", "goal_changed", "monitors", "info", "todos",
  "session", "session_named", "handoff_started", "ready", "config",
]);
const TASK_MAP: Record<string, TaskItem["status"]> = {
  done: "completed", completed: "completed", in_progress: "in_progress", progress: "in_progress",
  blocked: "blocked", cancelled: "cancelled", canceled: "cancelled", pending: "pending", todo: "pending",
};
const TERMINAL = new Set<RunStatus>(["completed", "cancelled", "failed"]);
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
const DEFAULT_RUN_TIMEOUT_MS = 180_000;

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
   * (default 180 000; null for none). `maxTurns` caps tool iterations for this run only; the
   * session's own setting is restored afterwards. `signal` cancels the run when aborted.
   */
  stream(prompt: string, runOptions: RunOptions = {}): RunHandle {
    if (this.closed) throw new DGCRuntimeError("this session is closed");
    if (typeof prompt !== "string" || !prompt.trim()) throw new DGCConfigError("prompt must be a non-empty string");
    if (runOptions.outputSchema) assertSupported(runOptions.outputSchema);
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
    if (prior) this.queued.push(run);
    else this.active = run;
    this.owners.set(run.requestId, run);
    const handle = new RunHandle(this, run);
    const timeoutMs = runOptions.timeoutMs === undefined ? DEFAULT_RUN_TIMEOUT_MS : runOptions.timeoutMs;
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
    const timeoutMs = runOptions.timeoutMs === undefined ? DEFAULT_RUN_TIMEOUT_MS : runOptions.timeoutMs;
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
    options: { timeoutMs?: number; uncorrelatedReply?: boolean } = {}): Promise<Frame> {
    const payload: Frame = { ...command };
    if (typeof payload.request_id !== "string" || !payload.request_id) payload.request_id = newId("req");
    const wait = options.timeoutMs === undefined
      ? this.init.requestTimeoutMs : Math.max(options.timeoutMs, this.init.requestTimeoutMs);
    return this.transport.request(payload, responseType, { timeoutMs: wait, uncorrelatedReply: options.uncorrelatedReply });
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

  async getUsage(range = "today"): Promise<Record<string, unknown>> {
    return this.request({ type: "get_usage", range, request_id: newId("usage") }, "usage_report");
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

  constructor(result: RunResult) {
    this.result = result;
    for (const item of result.artifacts) this.artifacts.set(item.id, item);
    for (const item of result.documents) this.documents.set(item.id, item);
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
