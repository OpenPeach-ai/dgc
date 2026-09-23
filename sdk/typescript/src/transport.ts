/**
 * The `dgc serve` child and its NDJSON pipe. Mirrors the SDK copy of the wire client
 * (sdk/python/dgc_sdk/wire/client.py):
 *
 * - Every failure is an SDK error (DGCRuntimeError, DGCProtocolError, DGCTimeoutError,
 *   DGCCommandRejectedError).
 * - The first event must be a `ready` handshake offering protocol v14; anything else is a
 *   protocol error. After it, event types this SDK does not know (the CLI adds some within a
 *   protocol version) are skipped and counted, not fatal.
 * - A correlated request's reply goes to that request even while a run reads the stream, and a
 *   `command_rejected` / `error` naming it fails it at once instead of running out its timeout.
 * - Waits may be longer than Node's 24.8-day timer limit, or unbounded (`null`).
 * - The child runs in its own process group; close() and failed starts reap it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  DGCCommandRejectedError, DGCProtocolError, DGCRuntimeError, DGCTimeoutError,
} from "./errors.ts";
import { PROTOCOL, type Env } from "./types.ts";

export type Frame = Record<string, unknown>;

/** Protocol v14 event types (dgc/editor_protocol.py EVENT_FIELDS). Others are skipped. */
export const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "agent_ended", "agent_started", "agent_updated", "agents", "artifact_ready", "artifacts",
  "ask_request", "ask_resolved",
  "chat_change", "chat_changes", "checkpoints", "command_rejected", "compacted", "config",
  "context", "doc", "docs_catalog", "error", "files_ready", "goal_changed", "handoff", "handoff_started",
  "history", "hook_activity", "hook_catalog", "image", "info", "mcp_call_complete",
  "mcp_command_result", "mcp_context", "mcp_context_catalog", "mcp_input_request", "mcp_servers",
  "mcp_tools", "memory", "mode_changed", "model_changed", "model_retry", "models",
  "monitor_ended", "monitor_event", "monitor_started", "monitors", "options_request",
  "options_resolved", "permission_decision", "permission_request", "permission_resolved",
  "permissions", "plan_proposal", "prompt_accepted", "queued", "ready", "recall",
  "request_expired", "retained_tasks", "rewound", "rule_added", "saved_plan", "session",
  "session_named", "sessions", "skill_catalog", "skill_detail", "skill_package", "status",
  "steering_update", "stream_end", "text_delta", "think_changed", "thinking_delta",
  "thinking_end", "todos", "tool_call", "tool_denied", "tool_images", "tool_progress",
  "tool_result", "turn_activity", "turn_end", "turn_eta", "turn_start", "usage_report",
  "workspace_change", "workspace_changes", "workspace_roots",
]);
const DECISION_EVENTS = new Set(["permission_request", "plan_proposal", "options_request", "mcp_input_request"]);
const TURN_EVENTS = new Set(["turn_start", "turn_end", "request_expired", "prompt_accepted"]);
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_EVENTS = 65_536;
const STDERR_LIMIT = 64 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;
const LATE_REPLY_WINDOW_MS = 300_000;

type Reader = {
  predicate?: (frame: Frame) => boolean;
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
};

type Request = {
  answers: (frame: Frame) => boolean;
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
};

/** A timer that works for any length (Node timers overflow past ~24.8 days) or none (`null`). */
export function longTimer(ms: number | null, fire: () => void): () => void {
  if (ms === null || !Number.isFinite(ms)) return () => {};
  const deadline = Date.now() + Math.max(0, ms);
  let handle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const left = deadline - Date.now();
    if (left <= 0) {
      fire();
      return;
    }
    handle = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
  };
  arm();
  return () => { if (handle !== undefined) clearTimeout(handle); };
}

function isObject(value: unknown): value is Frame {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class Transport {
  readonly argv: readonly string[];
  private readonly cwd: string;
  private readonly env: Env;
  private child: ChildProcess | null = null;
  private buf = "";
  private events: Frame[] = [];
  private readers: Reader[] = [];
  private requests: Request[] = [];
  private awaited = new Map<string, number>();
  private abandoned = new Map<string, number>();
  private lastSeq = -1;
  private readyFrame: Frame | null = null;
  private readyWaiter: { resolve: (frame: Frame) => void; reject: (error: Error) => void } | null = null;
  private dead: Error | null = null;
  private closing = false;
  private exited: Promise<void> | null = null;
  private stderr = "";
  private readonly ignored = new Map<string, number>();

  constructor(argv: readonly string[], cwd: string, env: Env) {
    this.argv = [...argv];
    this.cwd = cwd;
    this.env = env;
  }

  /** The runtime's process id, once started. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The runtime's exit code, or null while it runs. */
  get exitCode(): number | null {
    return this.child ? this.child.exitCode : null;
  }

  /** The ready handshake, once received. */
  get ready(): Frame | null {
    return this.readyFrame;
  }

  /** The last lines of the runtime's stderr (bounded). */
  get stderrTail(): string {
    return this.stderr;
  }

  get closed(): boolean {
    return this.dead !== null;
  }

  /** Event types skipped because this SDK does not know them yet, with counts. */
  get ignoredEventTypes(): Record<string, number> {
    return Object.fromEntries(this.ignored);
  }

  /** Launch the runtime and wait for its `ready` handshake (protocol checked). */
  start(timeoutMs: number): Promise<Frame> {
    if (this.child) return Promise.reject(new DGCRuntimeError("this transport was already started"));
    return new Promise<Frame>((resolve, reject) => {
      let stop = () => {};
      this.readyWaiter = {
        resolve: (frame) => { stop(); resolve(frame); },
        reject: (error) => { stop(); reject(error); },
      };
      stop = longTimer(timeoutMs, () => {
        this.fail(new DGCRuntimeError(`timed out after ${timeoutMs} ms waiting for the DGC ready handshake`));
      });
      let child: ChildProcess;
      try {
        child = spawn(this.argv[0], this.argv.slice(1), {
          cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"],
          // Its own process group, so close() can reap whatever it started.
          detached: process.platform !== "win32",
        });
      } catch (error) {
        this.fail(new DGCRuntimeError(`could not launch the DGC backend ${JSON.stringify(this.argv[0])}: ${String(error)}`));
        return;
      }
      this.child = child;
      this.exited = new Promise<void>((done) => {
        child.once("exit", () => done());
        child.once("error", () => { if (child.pid === undefined) done(); });
      });
      child.on("error", (error) => {
        this.fail(new DGCRuntimeError(`could not launch the DGC backend ${JSON.stringify(this.argv[0])}: ${error.message}`));
      });
      child.stdin?.on("error", () => { /* a dead child: reported through exit */ });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => this.onData(chunk));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
      });
      let reported = false;
      const report = (code: number | null, signal: NodeJS.Signals | null) => {
        if (reported) return;
        reported = true;
        if (this.closing) {
          this.fail(new DGCRuntimeError("the DGC backend was closed"));
          return;
        }
        const how = code !== null ? `code ${code}` : `signal ${signal}`;
        this.fail(new DGCRuntimeError(`the DGC backend exited unexpectedly (${how})`));
      };
      // "close" comes after the last output was read; a descendant holding the pipe open must
      // not keep a dead backend looking alive, so "exit" reports too after a short grace.
      child.on("close", (code, signal) => report(code, signal));
      child.on("exit", (code, signal) => {
        setTimeout(() => report(code, signal), 500).unref();
      });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "").trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      if (this.dead) return;
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
        this.fail(new DGCProtocolError(`backend event frame exceeded ${MAX_EVENT_BYTES} bytes`));
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        this.fail(new DGCProtocolError("backend emitted malformed NDJSON"));
        return;
      }
      try {
        this.accept(frame);
      } catch (error) {
        this.fail(error instanceof Error ? error : new DGCProtocolError(String(error)));
        return;
      }
    }
    if (Buffer.byteLength(this.buf, "utf8") > MAX_EVENT_BYTES) {
      this.fail(new DGCProtocolError(`backend event frame exceeded ${MAX_EVENT_BYTES} bytes`));
    }
  }

  private accept(frame: unknown): void {
    if (!isObject(frame) || typeof frame.type !== "string" || !frame.type) {
      throw new DGCProtocolError(`backend violated protocol v${PROTOCOL}: an event without a type`);
    }
    const type = frame.type;
    const seq = frame.seq;
    if (typeof seq === "number" && Number.isInteger(seq)) {
      if (seq <= this.lastSeq) throw new DGCProtocolError("backend emitted a duplicate or out-of-order event sequence");
      this.lastSeq = seq;
    }
    if (this.readyFrame === null) {
      if (type !== "ready") throw new DGCProtocolError("backend emitted an event before the ready handshake");
      if (frame.protocol_version !== PROTOCOL) {
        const version = typeof frame.version === "string" ? frame.version.slice(0, 64) : "";
        throw new DGCProtocolError(
          `backend offered protocol v${String(frame.protocol_version)}; client requires v${PROTOCOL}`,
          { offeredProtocol: frame.protocol_version, backendVersion: version });
      }
      this.readyFrame = frame;
      const waiter = this.readyWaiter;
      this.readyWaiter = null;
      waiter?.resolve(frame);
      return;
    }
    if (type === "ready") throw new DGCProtocolError("backend emitted more than one ready event");
    if (!KNOWN_EVENTS.has(type)) {
      // Added within protocol v14 by a newer CLI (remote_status and friends): tolerate it.
      if (this.ignored.has(type) || this.ignored.size < 64) this.ignored.set(type, (this.ignored.get(type) || 0) + 1);
      return;
    }
    const replyTo = typeof frame.request_id === "string" ? frame.request_id : "";
    if (replyTo && this.abandoned.has(replyTo) && !DECISION_EVENTS.has(type) && !TURN_EVENTS.has(type)) {
      if ((this.abandoned.get(replyTo) || 0) > Date.now()) return;   // late reply to a timed-out request
      this.abandoned.delete(replyTo);
    }
    for (let index = 0; index < this.requests.length; index++) {
      const request = this.requests[index];
      if (request.answers(frame)) {
        this.requests.splice(index, 1);
        request.resolve(frame);
        return;
      }
    }
    if (this.events.length >= MAX_PENDING_EVENTS) {
      throw new DGCProtocolError("backend event retention limit was exceeded");
    }
    this.events.push(frame);
    this.dispatch();
  }

  private takeable(frame: Frame): boolean {
    const rid = frame.request_id;
    return !(typeof rid === "string" && this.awaited.has(rid));
  }

  private dispatch(): void {
    let index = 0;
    while (index < this.readers.length && this.events.length) {
      const reader = this.readers[index];
      const at = this.events.findIndex((frame) => this.takeable(frame) && (!reader.predicate || reader.predicate(frame)));
      if (at < 0) {
        index += 1;
        continue;
      }
      const [frame] = this.events.splice(at, 1);
      this.readers.splice(index, 1);
      reader.resolve(frame);
    }
  }

  /** Write one command. Throws DGCRuntimeError when the backend is gone. */
  send(command: Frame): void {
    if (this.dead) throw new DGCRuntimeError(this.dead.message, { cause: this.dead });
    const stdin = this.child?.stdin;
    if (!stdin || !this.readyFrame) throw new DGCRuntimeError("the DGC backend has not completed its ready handshake");
    const text = JSON.stringify(command);
    if (Buffer.byteLength(text, "utf8") > MAX_EVENT_BYTES) throw new DGCRuntimeError("command is too large to send");
    stdin.write(text + "\n");
  }

  /** Put an event back at the front of the stream. */
  unread(frame: Frame): void {
    this.events.unshift(frame);
    this.dispatch();
  }

  /**
   * The oldest event (matching `predicate`) nobody's request is waiting for. `timeoutMs` null
   * waits without limit. Rejects DGCTimeoutError on timeout, DGCRuntimeError once the backend is
   * gone and nothing is left.
   */
  next(timeoutMs: number | null = 30_000, predicate?: (frame: Frame) => boolean): Promise<Frame> {
    const at = this.events.findIndex((frame) => this.takeable(frame) && (!predicate || predicate(frame)));
    if (at >= 0) return Promise.resolve(this.events.splice(at, 1)[0]);
    if (this.dead) return Promise.reject(this.dead);
    return new Promise<Frame>((resolve, reject) => {
      let stop = () => {};
      const reader: Reader = {
        predicate,
        resolve: (frame) => { stop(); resolve(frame); },
        reject: (error) => { stop(); reject(error); },
      };
      stop = longTimer(timeoutMs, () => {
        const index = this.readers.indexOf(reader);
        if (index >= 0) this.readers.splice(index, 1);
        reject(new DGCTimeoutError("timed out waiting for the next DGC event"));
      });
      this.readers.push(reader);
    });
  }

  /**
   * Send a command and wait for its reply. While waiting, other readers leave events for this
   * request alone. A `command_rejected` or `error` for the same request throws
   * DGCCommandRejectedError at once. `uncorrelatedReply` also accepts a `responseType` event
   * without a request_id (commands acknowledged by a broadcast, such as clear_todos -> todos).
   */
  request(command: Frame, responseType: string,
    options: { timeoutMs?: number | null; uncorrelatedReply?: boolean } = {}): Promise<Frame> {
    const requestId = typeof command.request_id === "string" ? command.request_id : undefined;
    const commandType = typeof command.type === "string" ? command.type : "";
    const failedPrefix = `Command '${commandType}' failed`;
    const answers = (frame: Frame): boolean => {
      const kind = frame.type;
      const replyId = frame.request_id;
      if (requestId === undefined) {
        if (kind === responseType) return true;
      } else if (replyId === requestId) {
        return kind === responseType || kind === "command_rejected" || kind === "error";
      }
      if (replyId !== undefined && replyId !== null) return false;
      if (options.uncorrelatedReply && kind === responseType) return true;
      // Refusals the backend cannot correlate still name the command type.
      if (kind === "command_rejected") return Boolean(commandType) && frame.command === commandType;
      return kind === "error" && Boolean(commandType) && String(frame.message || "").startsWith(failedPrefix);
    };
    if (this.dead) return Promise.reject(new DGCRuntimeError(this.dead.message, { cause: this.dead }));
    if (requestId !== undefined) this.awaited.set(requestId, (this.awaited.get(requestId) || 0) + 1);
    const release = (timedOut: boolean) => {
      if (requestId === undefined) return;
      const left = (this.awaited.get(requestId) || 1) - 1;
      if (left > 0) this.awaited.set(requestId, left);
      else {
        this.awaited.delete(requestId);
        if (timedOut) this.abandon(requestId);
      }
      this.dispatch();
    };
    return new Promise<Frame>((resolve, reject) => {
      let stop = () => {};
      const entry: Request = {
        answers,
        resolve: (frame) => {
          stop();
          release(false);
          if (frame.type === responseType) {
            resolve(frame);
            return;
          }
          const message = String(frame.message || frame.reason || `${commandType || "command"} was refused`);
          reject(new DGCCommandRejectedError(message, {
            reason: typeof frame.reason === "string" ? frame.reason : "",
            command: typeof frame.command === "string" ? frame.command : commandType,
          }));
        },
        reject: (error) => {
          stop();
          release(false);
          reject(error);
        },
      };
      this.requests.push(entry);
      stop = longTimer(options.timeoutMs === undefined ? 15_000 : options.timeoutMs, () => {
        const index = this.requests.indexOf(entry);
        if (index >= 0) this.requests.splice(index, 1);
        release(true);
        reject(new DGCTimeoutError(`timed out waiting for the ${responseType} reply to ${commandType || "command"}`));
      });
      try {
        this.send(command);
      } catch (error) {
        const index = this.requests.indexOf(entry);
        if (index >= 0) this.requests.splice(index, 1);
        entry.reject(error instanceof Error ? error : new DGCRuntimeError(String(error)));
      }
    });
  }

  private abandon(requestId: string): void {
    const now = Date.now();
    for (const [key, expiry] of this.abandoned) if (expiry <= now) this.abandoned.delete(key);
    while (this.abandoned.size >= 1024) this.abandoned.delete(this.abandoned.keys().next().value as string);
    this.abandoned.set(requestId, now + LATE_REPLY_WINDOW_MS);
  }

  private fail(error: Error): void {
    if (this.dead) return;
    this.dead = error;
    const waiter = this.readyWaiter;
    this.readyWaiter = null;
    waiter?.reject(error);
    for (const reader of this.readers.splice(0)) reader.reject(error);
    for (const request of this.requests.splice(0)) request.reject(error);
    if (!this.closing && this.child && this.child.exitCode === null && this.child.signalCode === null) {
      // A protocol violation or a failed handshake: the child is useless now; reap it.
      void this.close();
    }
  }

  private signal(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child || child.pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  }

  /**
   * Shut the runtime down: ask politely, then SIGTERM and SIGKILL its process group. Resolves once
   * the child is gone (bounded to a few seconds).
   */
  async close(graceMs = 2000): Promise<void> {
    if (this.closing) {
      await this.exited;
      return;
    }
    this.closing = true;
    const child = this.child;
    const alive = () => child !== null && child.exitCode === null && child.signalCode === null;
    if (child && alive() && this.readyFrame && !this.dead) {
      try { child.stdin?.write(JSON.stringify({ type: "shutdown" }) + "\n"); } catch { /* gone */ }
    }
    try { child?.stdin?.end(); } catch { /* gone */ }
    this.fail(new DGCRuntimeError("the DGC backend was closed"));
    if (!child || child.pid === undefined) return;
    const wait = (ms: number) => Promise.race([
      this.exited ?? Promise.resolve(),
      new Promise<void>((done) => setTimeout(done, ms).unref()),
    ]);
    if (alive()) await wait(graceMs);
    if (alive()) {
      this.signal("SIGTERM");
      await wait(1000);
    }
    if (alive()) {
      this.signal("SIGKILL");
      await wait(1000);
    }
    // A clean exit can still leave a descendant holding the group; sweep it.
    this.signal("SIGKILL");
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
