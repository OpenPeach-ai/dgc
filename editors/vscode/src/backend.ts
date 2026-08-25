import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

/** Any protocol event from `dgc serve` (see dgc/headless.py). */
export interface DgcEvent {
  type: string;
  [k: string]: any;
}

export const DGC_PROTOCOL_VERSION = 2;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_COMMANDS = 256;
const RESERVED_EVENT_NAMES = new Set(["error", "event", "newListener", "removeListener"]);

function validMessageType(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

interface PendingFrame {
  frame: string;
  bytes: number;
}

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
  private pending: PendingFrame[] = [];
  private pendingBytes = 0;
  private draining = false;
  private stopping = false;
  private released = false;
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
    this.buf = "";
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
      this.buf = "";
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
      this.buf = "";
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
      this.buf = "";
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
      let ev: DgcEvent;
      try {
        ev = JSON.parse(line);
      } catch {
        this.protocolFailure("dgc backend emitted malformed NDJSON");
        return;
      }
      if (!ev || typeof ev !== "object" || Array.isArray(ev) || !validMessageType(ev.type)) {
        this.protocolFailure("dgc backend emitted an event without a valid type");
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
        this.emitEvent(ev);
        continue;
      }
      this.emitEvent(ev);
    }
    // Limit the unfinished frame, not the aggregate chunk: stdout may legitimately deliver
    // several individually valid events in one chunk whose combined size exceeds the cap.
    if (Buffer.byteLength(this.buf, "utf8") > MAX_EVENT_BYTES) {
      this.protocolFailure(`dgc backend protocol frame exceeded ${MAX_EVENT_BYTES} bytes`);
    }
  }

  private emitEvent(ev: DgcEvent): void {
    this.emit("event", ev);
    // Backend output is an external protocol, so it must not reach EventEmitter's own lifecycle
    // channels. Every event still travels once through the universal "event" channel.
    if (!RESERVED_EVENT_NAMES.has(ev.type)) {
      this.emit(ev.type, ev);
    }
  }

  private reject(message: string, count = 1): void {
    this.emit("event", { type: "command_rejected", message, count });
  }

  private rejectPending(message: string): void {
    const count = this.setupPending.length + this.pending.length;
    this.setupPending = [];
    this.pending = [];
    this.pendingBytes = 0;
    if (count) {
      this.reject(`${message} (${count} queued command${count === 1 ? "" : "s"})`, count);
    }
  }

  private enqueue(frame: string, bytes: number, setup = false): boolean {
    if (this.setupPending.length + this.pending.length >= MAX_PENDING_COMMANDS
        || this.pendingBytes + bytes > MAX_PENDING_BYTES) {
      this.reject("DGC command queue is full; wait for the backend before retrying");
      return false;
    }
    (setup ? this.setupPending : this.pending).push({ frame, bytes });
    this.pendingBytes += bytes;
    return true;
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
           && (this.setupPending.length || (this.released && this.pending.length))) {
      const item = (this.setupPending.length ? this.setupPending : this.pending).shift()!;
      this.pendingBytes -= item.bytes;
      if (!this.writeFrame(item.frame)) {
        this.reject("DGC backend closed while writing a queued command");
        this.rejectPending("the backend closed before queued commands could run");
        return;
      }
    }
  }

  private serialize(cmd: Record<string, any>): PendingFrame | undefined {
    if (!cmd || typeof cmd !== "object" || Array.isArray(cmd) || !validMessageType(cmd.type)) {
      this.reject("DGC command must contain a non-empty string type");
      return undefined;
    }
    let frame: string;
    try {
      frame = JSON.stringify(cmd) + "\n";
    } catch {
      this.reject("DGC command is not JSON-serializable");
      return undefined;
    }
    const bytes = Buffer.byteLength(frame, "utf8");
    if (bytes > MAX_COMMAND_BYTES) {
      this.reject(`DGC command exceeded ${MAX_COMMAND_BYTES} bytes`);
      return undefined;
    }
    return { frame, bytes };
  }

  /** Send one command object to the backend. Returns false when it is explicitly rejected. */
  send(cmd: Record<string, any>): boolean {
    const item = this.serialize(cmd);
    if (!item) {
      return false;
    }
    if (!this.proc) {
      this.start();
    }
    if (!this.proc) {
      this.reject("DGC backend is unavailable; retry after fixing its command path");
      return false;
    }
    if (!this.ready || !this.released || this.draining || this.pending.length) {
      return this.enqueue(item.frame, item.bytes);
    }
    if (!this.writeFrame(item.frame)) {
      this.reject("DGC backend is unavailable; retry after it restarts");
      return false;
    }
    return true;
  }

  /** Send handshake configuration ahead of user commands queued during backend startup. */
  sendSetup(cmd: Record<string, any>): boolean {
    const item = this.serialize(cmd);
    if (!item || !this.proc || !this.ready) {
      if (item) {
        this.reject("DGC backend is not ready for handshake configuration");
      }
      return false;
    }
    if (this.draining || this.setupPending.length) {
      return this.enqueue(item.frame, item.bytes, true);
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
    this.pending = [];
    this.pendingBytes = 0;
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
