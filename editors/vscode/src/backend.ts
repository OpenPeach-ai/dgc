import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import {
  DgcEvent,
  DgcEventType,
  DgcCommand,
  DGC_PROTOCOL_VERSION,
  MAX_COMMAND_BYTES,
  MAX_EVENT_BYTES,
  MAX_PENDING_BYTES,
  MAX_PENDING_COMMANDS,
  dgcCommandError,
  dgcEventError,
} from "./protocol.generated";

export { DGC_PROTOCOL_VERSION, MAX_COMMAND_BYTES };
export type { DgcEvent };
const RESERVED_EVENT_NAMES = new Set(["error", "event", "newListener", "removeListener"]);

interface PendingFrame {
  frame: string;
  bytes: number;
  type: string;
  requestId?: string;
}

const REQUEST_RESPONSES = new Map<string, string>([
  ["permission_request", "permission_response"],
  ["plan_proposal", "plan_response"],
  ["options_request", "options_response"],
  ["mcp_input_request", "mcp_input_response"],
]);
const RESPONSE_COMMANDS = new Set(REQUEST_RESPONSES.values());
const CONTROL_COMMANDS = new Set([...RESPONSE_COMMANDS, "cancel", "interrupt"]);
const QUEUED_TURN_COMMANDS = new Set(["prompt", "slash_command"]);

/**
 * Owns the `dgc serve` child process: writes JSON commands to its stdin, parses
 * newline-delimited JSON from its stdout, and re-emits each event by `type`.
 * Also emits "event" for every event and "exit" when the child dies.
 *
 * Commands sent during startup or stream backpressure are queued in a strict,
 * bounded FIFO. Unexpected exits reject that queue instead of silently dropping
 * or replaying state-changing commands. The next explicit command starts a fresh
 * backend and waits for a compatible protocol handshake before it is delivered.
 */
export class DgcBackend extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private buf = "";
  private setupPending: PendingFrame[] = [];
  private controlPending: PendingFrame[] = [];
  private pending: PendingFrame[] = [];
  private pendingBytes = 0;
  private activeRequests = new Map<string, string>();
  private respondedRequests = new Set<string>();
  private draining = false;
  private stopping = false;
  private released = false;
  private lastSeq = -1;
  ready = false;

  constructor(private readonly cwd: string, private readonly command: string) {
    super();
  }

  start(): void {
    if (this.proc) {
      return;
    }
    this.stopping = false;
    this.ready = false;
    this.draining = false;
    this.released = false;
    this.lastSeq = -1;
    this.buf = "";
    this.activeRequests.clear();
    this.respondedRequests.clear();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, ["serve"], {
        cwd: this.cwd,
        env: { ...process.env },
      });
    } catch (err: any) {
      this.launchError(err);
      return;
    }
    this.proc = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.proc === child) {
        this.onStdout(chunk);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (this.proc !== child) {
        return;
      }
      const text = String(chunk).trim();
      if (text) {
        this.emit("stderr", text);
      }
    });
    child.stdin.on("drain", () => {
      if (this.proc === child) {
        this.draining = false;
        this.flushPending();
      }
    });
    child.stdin.on("error", (err: any) => {
      // Writable streams can report EPIPE after the process has already been disposed. Always
      // consume the event; only fail the active transport instance.
      if (this.proc !== child) {
        return;
      }
      this.proc = undefined;
      this.ready = false;
      this.draining = false;
      this.released = false;
      this.lastSeq = -1;
      this.buf = "";
      this.activeRequests.clear();
      this.respondedRequests.clear();
      this.rejectPending("the backend command stream failed before queued commands could run");
      this.emit("event", {
        type: "error",
        message: `dgc backend command stream failed: ${err?.message ?? err}`,
        fatal: true,
        transport_error: true,
      });
      try {
        child.kill();
      } catch {
        /* process already exited */
      }
    });
    child.on("error", (err: any) => {
      if (this.proc !== child) {
        return;
      }
      this.proc = undefined;
      this.ready = false;
      this.draining = false;
      this.released = false;
      this.lastSeq = -1;
      this.buf = "";
      this.activeRequests.clear();
      this.respondedRequests.clear();
      this.rejectPending("the backend failed before queued commands could run");
      this.launchError(err);
    });
    child.on("exit", (code) => {
      if (this.proc !== child) {
        return;
      }
      this.proc = undefined;
      this.ready = false;
      this.draining = false;
      this.released = false;
      this.lastSeq = -1;
      this.buf = "";
      this.activeRequests.clear();
      this.respondedRequests.clear();
      if (!this.stopping) {
        this.rejectPending("the backend exited before queued commands could run");
      }
      this.emit("exit", code);
    });
  }

  private launchError(err: any): void {
    const missing = err?.code === "ENOENT";
    this.emit("event", {
      type: "error",
      message: missing
        ? `The DGC CLI ('${this.command}') isn't installed or isn't on PATH.`
        : `dgc backend failed to start: ${err?.message ?? err}. Set "dgc.command" to a DGC CLI that supports protocol v${DGC_PROTOCOL_VERSION}.`,
      fatal: true,
      notInstalled: missing,
    });
  }

  private protocolFailure(message: string): void {
    this.emit("event", { type: "error", message, fatal: true, protocol_error: true });
    this.rejectPending(message);
    this.dispose();
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const raw = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (Buffer.byteLength(raw, "utf8") > MAX_EVENT_BYTES) {
        this.protocolFailure(`dgc backend protocol frame exceeded ${MAX_EVENT_BYTES} bytes`);
        return;
      }
      const line = raw.trim();
      if (!line) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.protocolFailure("dgc backend emitted malformed NDJSON");
        return;
      }
      const schemaProblem = dgcEventError(parsed);
      if (schemaProblem) {
        this.protocolFailure(`dgc backend violated protocol v${DGC_PROTOCOL_VERSION}: ${schemaProblem}`);
        return;
      }
      const ev = parsed as DgcEvent;
      if (ev.seq <= this.lastSeq) {
        this.protocolFailure("dgc backend emitted a duplicate or out-of-order event sequence");
        return;
      }
      this.lastSeq = ev.seq;
      if (!this.ready && ev.type !== "ready") {
        this.protocolFailure("dgc backend emitted an event before the ready handshake");
        return;
      }
      if (ev.type === "ready") {
        if (this.ready) {
          this.protocolFailure("dgc backend emitted more than one ready event");
          return;
        }
        if (ev.protocol_version !== DGC_PROTOCOL_VERSION) {
          this.protocolFailure(
            `DGC protocol mismatch: extension requires v${DGC_PROTOCOL_VERSION}, backend offered v${ev.protocol_version ?? "unknown"}`,
          );
          return;
        }
        this.ready = true;
        // Notify the panel first. Its synchronous ready handler sends workspace roots and
        // begins loading SecretStorage-backed settings. User commands remain held until the
        // panel explicitly releases the handshake.
        if (!this.emitEvent(ev)) {
          return;
        }
        continue;
      }
      if (!this.emitEvent(ev)) {
        return;
      }
    }
    // Limit the unfinished frame, not the aggregate chunk: stdout may legitimately deliver
    // several individually valid events in one chunk whose combined size exceeds the cap.
    if (Buffer.byteLength(this.buf, "utf8") > MAX_EVENT_BYTES) {
      this.protocolFailure(`dgc backend protocol frame exceeded ${MAX_EVENT_BYTES} bytes`);
    }
  }

  private emitEvent(ev: DgcEvent): boolean {
    const expectedResponse = REQUEST_RESPONSES.get(ev.type);
    const requestId = "id" in ev ? String((ev as any).id ?? "") : "";
    if (expectedResponse) {
      if (!requestId || this.activeRequests.has(requestId)) {
        this.protocolFailure("dgc backend reused an active approval request ID");
        return false;
      }
      this.activeRequests.set(requestId, expectedResponse);
    } else if (ev.type === "request_expired") {
      this.activeRequests.delete(requestId);
      this.respondedRequests.delete(requestId);
      this.dropQueuedResponse(requestId);
    } else if (ev.type === "turn_end") {
      this.activeRequests.clear();
      this.respondedRequests.clear();
      // A response or Stop frame that never reached the just-ended turn must not spill into
      // the next queued turn. Ordinary queued prompts retain their documented FIFO lifecycle.
      for (const item of this.controlPending) {
        this.pendingBytes -= item.bytes;
      }
      this.controlPending = [];
    }
    this.emit("event", ev);
    // Backend output is an external protocol, so it must not reach EventEmitter's own lifecycle
    // channels. Every event still travels once through the universal "event" channel.
    if (!RESERVED_EVENT_NAMES.has(ev.type)) {
      this.emit(ev.type, ev);
    }
    return true;
  }

  private reject(message: string, count = 1): void {
    this.emit("event", { type: "command_rejected", message, count });
  }

  private rejectPending(message: string): void {
    const count = this.setupPending.length + this.controlPending.length + this.pending.length;
    this.setupPending = [];
    this.controlPending = [];
    this.pending = [];
    this.pendingBytes = 0;
    if (count) {
      this.reject(`${message} (${count} queued command${count === 1 ? "" : "s"})`, count);
    }
  }

  private enqueue(item: PendingFrame, setup = false, control = false): boolean {
    if (control) {
      // A saturated prompt queue must not starve a deny/cancel/approval response. Discard only
      // unsent ordinary commands from the tail until the bounded control frame fits.
      let dropped = 0;
      while (this.pending.length && (
          this.setupPending.length + this.controlPending.length + this.pending.length
            >= MAX_PENDING_COMMANDS
          || this.pendingBytes + item.bytes > MAX_PENDING_BYTES)) {
        const removed = this.pending.pop()!;
        this.pendingBytes -= removed.bytes;
        dropped += 1;
      }
      if (dropped) {
        this.reject(`DGC dropped ${dropped} queued command${dropped === 1 ? "" : "s"} to deliver a decision or cancellation`, dropped);
      }
    }
    if (this.setupPending.length + this.controlPending.length + this.pending.length
          >= MAX_PENDING_COMMANDS
        || this.pendingBytes + item.bytes > MAX_PENDING_BYTES) {
      this.reject("DGC command queue is full; wait for the backend before retrying");
      return false;
    }
    (setup ? this.setupPending : control ? this.controlPending : this.pending).push(item);
    this.pendingBytes += item.bytes;
    return true;
  }

  private dropQueuedResponse(requestId: string): void {
    if (!requestId) {
      return;
    }
    const keep: PendingFrame[] = [];
    for (const item of this.controlPending) {
      if (item.requestId === requestId) {
        this.pendingBytes -= item.bytes;
      } else {
        keep.push(item);
      }
    }
    this.controlPending = keep;
  }

  private dropQueuedTurns(): number {
    const keep: PendingFrame[] = [];
    let dropped = 0;
    for (const item of this.pending) {
      if (QUEUED_TURN_COMMANDS.has(item.type)) {
        this.pendingBytes -= item.bytes;
        dropped += 1;
      } else {
        keep.push(item);
      }
    }
    this.pending = keep;
    return dropped;
  }

  private writeFrame(frame: string): boolean {
    const child = this.proc;
    if (!child || !child.stdin.writable) {
      return false;
    }
    try {
      if (!child.stdin.write(frame)) {
        this.draining = true;
      }
      return true;
    } catch {
      return false;
    }
  }

  private flushPending(): void {
    while (this.ready && !this.draining
           && (this.setupPending.length
             || (this.released && (this.controlPending.length || this.pending.length)))) {
      const item = (this.setupPending.length ? this.setupPending
        : this.controlPending.length ? this.controlPending : this.pending).shift()!;
      this.pendingBytes -= item.bytes;
      if (!this.writeFrame(item.frame)) {
        this.reject("DGC backend closed while writing a queued command");
        this.rejectPending("the backend closed before queued commands could run");
        return;
      }
    }
  }

  private serialize(cmd: DgcCommand): PendingFrame | undefined {
    let frame: string;
    let wireCommand: DgcCommand;
    try {
      const encoded = JSON.stringify(cmd);
      if (typeof encoded !== "string") {
        throw new TypeError("command did not serialize to JSON");
      }
      // Validate the exact object the child will receive. In particular, optional
      // JavaScript properties set to `undefined` are absent on the JSON wire and
      // must not be rejected as though an invalid value had been transmitted.
      wireCommand = JSON.parse(encoded) as DgcCommand;
      frame = encoded + "\n";
    } catch {
      this.reject("DGC command is not JSON-serializable");
      return undefined;
    }
    const schemaProblem = dgcCommandError(wireCommand);
    if (schemaProblem) {
      this.reject(`DGC command violated protocol v${DGC_PROTOCOL_VERSION}: ${schemaProblem}`);
      return undefined;
    }
    const bytes = Buffer.byteLength(frame, "utf8");
    if (bytes > MAX_COMMAND_BYTES) {
      this.reject(`DGC command exceeded ${MAX_COMMAND_BYTES} bytes`);
      return undefined;
    }
    return { frame, bytes, type: String(wireCommand.type),
             requestId: "id" in wireCommand ? String((wireCommand as any).id ?? "") : undefined };
  }

  /** Send one command object to the backend. Returns false when it is explicitly rejected. */
  send(cmd: DgcCommand): boolean {
    const item = this.serialize(cmd);
    if (!item) {
      return false;
    }
    const isResponse = RESPONSE_COMMANDS.has(item.type);
    const isControl = CONTROL_COMMANDS.has(item.type);
    if (isResponse) {
      const expected = item.requestId ? this.activeRequests.get(item.requestId) : undefined;
      if (expected !== item.type || this.respondedRequests.has(item.requestId || "")) {
        this.reject("DGC ignored a stale, duplicate, or mismatched approval response");
        return false;
      }
    }
    if (item.type === "cancel" || item.type === "interrupt") {
      this.activeRequests.clear();
      this.respondedRequests.clear();
      const dropped = this.dropQueuedTurns();
      if (dropped) {
        this.reject(`DGC cancelled ${dropped} queued prompt${dropped === 1 ? "" : "s"}`, dropped);
      }
    }
    if (!this.proc) {
      if (isControl) {
        this.reject("DGC ignored a stale decision or cancellation after the backend exited");
        return false;
      }
      this.start();
    }
    if (!this.proc) {
      this.reject("DGC backend is unavailable; retry after fixing its command path");
      return false;
    }
    if (!this.ready || !this.released || this.draining
        || this.setupPending.length || this.controlPending.length || this.pending.length) {
      const accepted = this.enqueue(item, false, isControl);
      if (accepted && isResponse && item.requestId) {
        this.respondedRequests.add(item.requestId);
      }
      if (accepted && this.ready && this.released && !this.draining) {
        this.flushPending();
      }
      return accepted;
    }
    if (!this.writeFrame(item.frame)) {
      this.reject("DGC backend is unavailable; retry after it restarts");
      return false;
    }
    if (isResponse && item.requestId) {
      this.respondedRequests.add(item.requestId);
    }
    return true;
  }

  /** Send a query/state command and settle only from the response belonging to this request.
   * Current protocol-v4 backends echo `request_id`; callers may omit it only for a negotiated
   * legacy backend, where installing the listener before `send` still provides a post-send
   * sequence barrier. Rejections, fatal transport errors, process exit, and timeout always release
   * every listener. */
  request(cmd: DgcCommand, responseType: DgcEventType, timeoutMs = 5000): Promise<DgcEvent> {
    const rawRequestId = (cmd as any).request_id;
    const requestId = typeof rawRequestId === "string" && rawRequestId ? rawRequestId : undefined;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
      return Promise.reject(new Error("DGC request timeout must be between 1 and 60000ms"));
    }
    return new Promise<DgcEvent>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timer) { clearTimeout(timer); }
        this.off("event", onEvent);
        this.off("exit", onExit);
      };
      const finish = (event: DgcEvent) => {
        if (settled) { return; }
        settled = true;
        cleanup();
        resolve(event);
      };
      const fail = (message: string) => {
        if (settled) { return; }
        settled = true;
        cleanup();
        reject(new Error(message));
      };
      const belongsToRequest = (event: DgcEvent): boolean => {
        if (requestId !== undefined) {
          return event.request_id === requestId;
        }
        // Older protocol implementations did not echo optional state request IDs. Preserve
        // their best-effort post-send barrier by matching only the expected command route.
        return event.type !== "command_rejected" || event.command === cmd.type;
      };
      const onEvent = (event: DgcEvent) => {
        if (event.type === "error" && (event as any).fatal === true) {
          fail(String(event.message || `DGC failed while running ${cmd.type}`));
          return;
        }
        if (!belongsToRequest(event)) { return; }
        if (event.type === responseType) {
          finish(event);
        } else if (event.type === "command_rejected" || event.type === "error") {
          fail(String(event.message || `DGC rejected ${cmd.type}`));
        }
      };
      const onExit = () => fail(`DGC backend exited while waiting for ${responseType}`);
      this.on("event", onEvent);
      this.on("exit", onExit);
      timer = setTimeout(
        () => fail(`DGC timed out waiting for ${responseType}`), Math.trunc(timeoutMs));
      if (!this.send(cmd)) {
        fail(`DGC rejected ${cmd.type} before it could run`);
      }
    });
  }

  /** Send handshake configuration ahead of user commands queued during backend startup. */
  sendSetup(cmd: DgcCommand): boolean {
    const item = this.serialize(cmd);
    if (!item || !this.proc || !this.ready) {
      if (item) {
        this.reject("DGC backend is not ready for handshake configuration");
      }
      return false;
    }
    if (this.draining || this.setupPending.length) {
      return this.enqueue(item, true);
    }
    if (!this.writeFrame(item.frame)) {
      this.reject("DGC backend closed during handshake configuration");
      return false;
    }
    return true;
  }

  /** Release user commands only after roots and SecretStorage-backed settings are configured. */
  completeHandshake(): void {
    if (!this.ready) {
      return;
    }
    this.released = true;
    this.flushPending();
  }

  dispose(): void {
    this.stopping = true;
    this.ready = false;
    this.draining = false;
    this.released = false;
    this.setupPending = [];
    this.controlPending = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.activeRequests.clear();
    this.respondedRequests.clear();
    const p = this.proc;
    this.proc = undefined;
    if (!p) {
      return;
    }
    try {
      if (p.stdin.writable) {
        p.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
      }
    } catch {
      /* pipe already closed */
    }
    setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }, 300);
  }
}
