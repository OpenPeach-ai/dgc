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

/** What the panel needs to say about one child's end, reported exactly once per child. */
export interface ChildExitInfo {
  pid?: number;
  uptimeMs: number;
  /** Set only when the EXTENSION decided to stop this child, naming why. */
  cause?: string;
  /** A write-side failure (EPIPE, ERR_STREAM_DESTROYED) seen before the exit. */
  transport?: string;
  framesWritten: number;
  lastFrame?: string;
}

interface ChildLife {
  pid?: number;
  startedAt: number;
  cause?: string;
  transport?: string;
  framesWritten: number;
  lastFrame?: string;
}

interface PendingFrame {
  frame: string;
  bytes: number;
  type: string;
  requestId?: string;
  /** The chat the command addresses: "" for the backend's default chat. */
  chat: string;
}

/** ready.capabilities.chats: this backend can hold several chats, each in its own directory. */
export interface ChatsCapability {
  version: number;
  max: number;
  /** The id the backend gave the chat it started with; its events carry it once chats are open. */
  default: string;
}

const REQUEST_RESPONSES = new Map<string, string>([
  ["permission_request", "permission_response"],
  ["plan_proposal", "plan_response"],
  ["options_request", "options_response"],
  ["mcp_input_request", "mcp_input_response"],
]);
const RESPONSE_COMMANDS = new Set(REQUEST_RESPONSES.values());
const CONTROL_COMMANDS = new Set([...RESPONSE_COMMANDS, "cancel", "interrupt", "ping", "editor_state"]);

// How often we tell the backend this window still exists. Comfortably inside the backend's own
// patience (15 minutes), so a missed tick or a slow machine never reads as a closed window.
const LIVENESS_PING_MS = 60_000;
const QUEUED_TURN_COMMANDS = new Set(["prompt", "slash_command"]);

/** Send a query/state command and settle only from the response belonging to this request.
 * Current protocol-v7 backends echo `request_id`; callers may omit it only for a negotiated
 * legacy backend, where installing the listener before `send` still provides a post-send
 * sequence barrier. Rejections, fatal transport errors, process exit, and timeout always release
 * every listener. `source` is whatever emits this chat's events: a backend, or a chat on one. */
export function awaitResponse(source: EventEmitter, send: (cmd: DgcCommand) => boolean, cmd: DgcCommand,
                              responseType: DgcEventType, timeoutMs = 5000): Promise<DgcEvent> {
  const rawRequestId = (cmd as any).request_id;
  const requestId = typeof rawRequestId === "string" && rawRequestId ? rawRequestId : undefined;
  // Manual compaction may use the backend's 120-second summarization deadline. Keep the
  // transport watchdog bounded, but long enough that the UI does not report a timeout while
  // a valid compaction request is still running.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180000) {
    return Promise.reject(new Error("DGC request timeout must be between 1 and 180000ms"));
  }
  return new Promise<DgcEvent>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); }
      source.off("event", onEvent);
      source.off("exit", onExit);
      source.off("disposed", onDisposed);
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
    const onDisposed = () => fail(`DGC backend restarted or closed while waiting for ${responseType}`);
    source.on("event", onEvent);
    source.on("exit", onExit);
    source.on("disposed", onDisposed);
    timer = setTimeout(
      () => fail(`DGC timed out waiting for ${responseType}`), Math.trunc(timeoutMs));
    if (!send(cmd)) {
      fail(`DGC rejected ${cmd.type} before it could run`);
    }
  });
}

/**
 * Owns the `dgc serve` child process: writes JSON commands to its stdin, parses
 * newline-delimited JSON from its stdout, and re-emits each event by `type`.
 * Also emits "event" for every event, and three lifecycle channels:
 * - "teardown" (cause, pid) the moment the extension decides to stop a child;
 * - "launch_failed" (message) when a child could not be started;
 * - "exit" (code, signal, info: ChildExitInfo) exactly once per child that ran, whether we
 *   asked for it (info.cause) or not, including after a failed write to its stdin.
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
  /** Which chat each open request belongs to. A Stop or a turn_end ends ITS chat's requests only:
   *  once one backend holds several chats, clearing them all forgot another chat's open approval
   *  card, and the user's answer to it was then refused as stale. */
  private requestChats = new Map<string, string>();
  /** What `ready` offered for several chats, or undefined from a CLI that cannot hold them. */
  chats: ChatsCapability | undefined;
  /** This process's own `ready`: a chat opened on it borrows the version and capabilities. */
  readyEvent: DgcEvent | undefined;
  /** Chats other slots opened on this backend. While any remains, this process must outlive the
   *  slot that started it. */
  readonly chatUsers = new Set<unknown>();
  /** The slot that started this backend has closed, but chats on it are still open. */
  ownerReleased = false;
  private ignoredUnknownTypes = new Set<string>();
  private draining = false;
  private startedAt = 0;
  /**
   * One record per child that has not reported its exit yet. Whether WE stopped a child is a fact
   * about that child, not about this instance: an instance-wide flag set by one teardown stayed
   * set for the next child this instance started, so that child's own death was logged as asked
   * for and never recovered.
   */
  private life = new Map<ChildProcessWithoutNullStreams, ChildLife>();

  /** The current child's pid and how long it has been up — for the log that explains a lost turn. */
  get childPid(): number | undefined { return this.proc?.pid; }
  get uptimeMs(): number { return this.startedAt ? Date.now() - this.startedAt : 0; }
  private stopping = false;
  private released = false;
  private lastSeq = -1;
  ready = false;

  constructor(private readonly cwd: string, private readonly command: string,
              private readonly requiredCliVersion?: string) {
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
    this.requestChats.clear();
    this.ignoredUnknownTypes.clear();
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
    this.startedAt = Date.now();
    this.life.set(child, { pid: child.pid, startedAt: this.startedAt, framesWritten: 0 });
    // Every child, including one a later send() starts on this same instance, announces itself.
    // A spawn that failed outright has no pid; its launch_failed says so instead.
    if (child.pid !== undefined) {
      this.emit("spawned", child.pid);
    }

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
      // consume the event; only fail the active transport instance. The child stays in `life`:
      // its exit still has to be reported (this path used to swallow it entirely, so a backend
      // that died under a busy host left no exit line, no recovery and a turn spinning forever).
      const record = this.life.get(child);
      if (record && !record.transport) {
        record.transport = String(err?.code ?? err?.message ?? err);
      }
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
      this.requestChats.clear();
      this.ignoredUnknownTypes.clear();
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
      // A child that never started has no exit worth reporting as a backend death: the launch
      // error (a missing CLI above all) is the whole story, and recovery must not respawn it. A
      // child that did start keeps its record, so its exit is still reported.
      if (child.pid === undefined) {
        this.life.delete(child);
        this.emit("launch_failed", String(err?.message ?? err));
      }
      this.proc = undefined;
      this.ready = false;
      this.draining = false;
      this.released = false;
      this.lastSeq = -1;
      this.buf = "";
      this.activeRequests.clear();
      this.respondedRequests.clear();
      this.requestChats.clear();
      this.ignoredUnknownTypes.clear();
      this.rejectPending("the backend failed before queued commands could run");
      this.launchError(err);
    });
    // The SIGNAL matters as much as the code: Node reports (code=null, signal="SIGKILL") for a
    // killed process, and reporting only the code made a crash indistinguishable from a clean
    // exit(0) -- both surfaced as "dgc backend exited" with nothing after it.
    child.on("exit", (code, signal) => {
      const record = this.life.get(child);
      if (!record) {
        return;                                  // a launch failure, or already reported
      }
      this.life.delete(child);
      this.stopLivenessPings();
      const info: ChildExitInfo = {
        pid: record.pid, uptimeMs: Date.now() - record.startedAt, cause: record.cause,
        transport: record.transport, framesWritten: record.framesWritten, lastFrame: record.lastFrame,
      };
      if (this.proc !== child) {
        // Disposed, or its transport already failed: report it — silently swallowing it is what
        // left a lost turn with no record of who ended it — but do not disturb a newer child.
        this.emit("exit", code, signal, info);
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
      this.requestChats.clear();
      this.ignoredUnknownTypes.clear();
      if (!this.stopping) {
        this.rejectPending("the backend exited before queued commands could run");
      }
      this.emit("exit", code, signal, info);
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

  /**
   * A newer CLI may emit extra event types (for example remote_status) before this
   * extension's generated schema knows them. Killing the child and reconnecting
   * turns that into a chat-spam loop. Advance seq and keep the connection.
   */
  private skipUnknownEvent(parsed: unknown, schemaProblem: string): boolean {
    if (!schemaProblem.startsWith("unknown message type")) {
      return false;
    }
    if (!parsed || typeof parsed !== "object") {
      return false;
    }
    const rec = parsed as Record<string, unknown>;
    const seq = rec.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq <= this.lastSeq) {
      return false;
    }
    this.lastSeq = seq;
    const name = typeof rec.type === "string" ? rec.type : "unknown";
    if (!this.ignoredUnknownTypes.has(name)) {
      this.ignoredUnknownTypes.add(name);
      this.emit("event", {
        type: "error",
        message: `This extension skipped a backend event it does not handle yet (${name}). The connection stays up. Update Vibe DGC if this keeps appearing.`,
        fatal: false,
      });
    }
    return true;
  }

  private protocolFailure(message: string, cliOutdated = false, extensionOutdated = false): void {
    this.emit("event", { type: "error", message, fatal: true, protocol_error: true,
                         ...(cliOutdated ? { cli_outdated: true } : {}),
                         ...(extensionOutdated ? { extension_outdated: true } : {}) });
    this.rejectPending(message);
    this.dispose(`protocol: ${message}`);
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
        if (this.skipUnknownEvent(parsed, schemaProblem)) {
          continue;
        }
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
          // Equality is deliberate — a version range would move the failure from second zero to
          // turn forty — so the message has to say which side to update, and how. Whoever
          // updates one half first lands here, and "protocol mismatch" alone strands them.
          // The schema has already established that this is a number.
          const offered = ev.protocol_version as number;
          const fix = offered < DGC_PROTOCOL_VERSION
            ? `This DGC CLI is too old for this extension. Update it — run "DGC: Update CLI to Latest", or \`dgc update\` in a terminal — then run "DGC: Restart Backend".`
            // "Use the Update button" is not always enough: an editor's extension gallery is a
            // mirror that can lag a publish, and an uninstall leaves old copies on disk that the
            // scanner may prefer. vibedgc.com/vscode/dgc.vsix is always the build that matches the
            // CLI, so name it as the reliable route rather than the fallback.
            : `The DGC CLI needs a newer extension. Run "DGC: Check for Extension Updates" to install the matching release directly, even if your editor's marketplace is delayed, then reload the window.`;
          this.protocolFailure(
            `${fix} (the extension speaks editor protocol v${DGC_PROTOCOL_VERSION}; this CLI speaks v${offered}.)`,
            offered < DGC_PROTOCOL_VERSION,
            offered > DGC_PROTOCOL_VERSION,
          );
          return;
        }
        const needed = this.requiredCliVersion?.split(".").map(Number);
        const installed = String(ev.version || "").split(".").map(Number);
        if (needed?.length === 3 && installed.length === 3 && needed.every(Number.isFinite)
            && installed.every(Number.isFinite)) {
          const first = needed.findIndex((n, i) => n !== installed[i]);
          if (first >= 0 && needed[first] > installed[first]) {
            this.protocolFailure(`This extension requires DGC CLI ${this.requiredCliVersion} or later; installed: ${ev.version}. Updating the matching CLI is required.`, true);
            return;
          }
        }
        this.ready = true;
        this.readyEvent = ev;
        const offered = (ev as any).capabilities?.chats;
        this.chats = offered && typeof offered === "object" && typeof offered.default === "string"
            && offered.default && Number.isSafeInteger(offered.max) && offered.max > 0
          ? { version: Number(offered.version) || 1, max: offered.max, default: offered.default }
          : undefined;
        // An editor that goes away without closing its backend's stdin -- a reload that leaves the
        // old extension host running -- used to strand the session lease for as long as that host
        // lived. Saying "still here" on a timer lets the backend tell a closed window from a
        // thinking user. Gated on the capability: `dgc.command` can point at any CLI build, and an
        // older one would only answer with command_rejected.
        if ((ev as any).capabilities?.editor_liveness) {
          this.startLivenessPings(this.proc);
        }
        // Renderer-sourced liveness, and deliberately NOT a replacement for the timer above. That
        // timer says "this extension host is alive", which is exactly what an orphaned host also
        // says -- true, useless for a takeover, and still the right signal for the backend's
        // 15-minute self-heal. What the backend cannot get from us, it gets from the webview.
        this.editorStateSupported = !!(ev as any).capabilities?.editor_state;
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

  /** "" for the default chat -- untagged, or tagged with the id `ready` gave it -- else the chat's id. */
  chatKey(chatId: unknown): string {
    return typeof chatId === "string" && chatId && chatId !== this.chats?.default ? chatId : "";
  }

  /** Forget one chat's open requests: its turn ended, or the user stopped it. */
  private endChatRequests(chat: string): void {
    for (const [requestId, owner] of [...this.requestChats]) {
      if (owner !== chat) { continue; }
      this.requestChats.delete(requestId);
      this.activeRequests.delete(requestId);
      this.respondedRequests.delete(requestId);
    }
  }

  private emitEvent(ev: DgcEvent): boolean {
    const expectedResponse = REQUEST_RESPONSES.get(ev.type);
    const requestId = "id" in ev ? String((ev as any).id ?? "") : "";
    const chat = this.chatKey((ev as any).chat_id);
    if (expectedResponse) {
      const active = requestId ? this.activeRequests.get(requestId) : undefined;
      if (!requestId || (active !== undefined && active !== expectedResponse)) {
        this.protocolFailure("dgc backend reused an active approval request ID");
        return false;
      }
      if (active !== undefined) {
        // The same open decision announced again (a history snapshot re-sends what the turn is still
        // waiting on, for a reloaded webview). Show it again unless it has already been answered.
        if (this.respondedRequests.has(requestId)) {
          return true;
        }
      }
      this.activeRequests.set(requestId, expectedResponse);
      this.requestChats.set(requestId, chat);
    } else if (ev.type === "request_expired") {
      this.activeRequests.delete(requestId);
      this.respondedRequests.delete(requestId);
      this.requestChats.delete(requestId);
      this.dropQueuedResponse(requestId);
    } else if (ev.type === "turn_end") {
      this.endChatRequests(chat);
      // A response or Stop frame that never reached the just-ended turn must not spill into
      // the next queued turn. Ordinary queued prompts retain their documented FIFO lifecycle.
      // Only this chat's: another chat's turn is still running and still waiting on its own.
      const keep: PendingFrame[] = [];
      for (const item of this.controlPending) {
        if (item.chat === chat) {
          this.pendingBytes -= item.bytes;
        } else {
          keep.push(item);
        }
      }
      this.controlPending = keep;
    }
    if (chat) {
      // Another chat's event. The listener on "event" is the chat this backend started with, and a
      // second chat's tokens must never land in its transcript: they go to that chat's channel.
      this.emit("chat-event", chat, ev);
      return true;
    }
    if (ev.type === "command_rejected" && (ev as any).command === "open_chat") {
      // A chat that could not open has no id to carry yet. Its refusal belongs to the slot that
      // asked for it, not to the transcript of the chat this backend started with.
      this.emit("chat-open-failed", ev);
      return true;
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

  private dropQueuedTurns(chat: string): number {
    const keep: PendingFrame[] = [];
    let dropped = 0;
    for (const item of this.pending) {
      if (QUEUED_TURN_COMMANDS.has(item.type) && item.chat === chat) {
        this.pendingBytes -= item.bytes;
        dropped += 1;
      } else {
        keep.push(item);
      }
    }
    this.pending = keep;
    return dropped;
  }

  private writeFrame(frame: string, type: string): boolean {
    const child = this.proc;
    if (!child || !child.stdin.writable) {
      return false;
    }
    try {
      if (!child.stdin.write(frame)) {
        this.draining = true;
      }
      const record = this.life.get(child);
      if (record) {
        record.framesWritten += 1;
        record.lastFrame = type;
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
      if (!this.writeFrame(item.frame, item.type)) {
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
             requestId: "id" in wireCommand ? String((wireCommand as any).id ?? "") : undefined,
             chat: this.chatKey((wireCommand as any).chat_id) };
  }

  /** Send one command object to the backend. Returns false when it is explicitly rejected. */
  private livenessTimer: ReturnType<typeof setInterval> | undefined;

  private startLivenessPings(child: any): void {
    this.stopLivenessPings();
    this.livenessTimer = setInterval(() => {
      // Only for the child we started this for; a replaced backend gets its own timer.
      if (this.proc !== child) {
        this.stopLivenessPings();
        return;
      }
      this.send({ type: "ping" });
    }, LIVENESS_PING_MS);
    // Never hold the extension host open on our account.
    (this.livenessTimer as any)?.unref?.();
  }

  private editorStateSupported = false;

  /** Tell the backend what is actually on screen. A no-op against a CLI that does not declare it,
   *  and never against a child that is not running: `send` would start one for a non-control
   *  command and surface a stale-decision rejection for a control one, and a heartbeat must do
   *  neither. */
  editorState(source: "renderer" | "host", view: "open" | "closed"): void {
    if (!this.editorStateSupported || !this.ready || !this.proc) { return; }
    // A liveness statement is only true at the instant it is sent, so it must never be QUEUED.
    // `send` enqueues whenever the transport is not clear, and `flushPending` would then write it
    // minutes later -- moving the backend's renderer clock forward on behalf of a window that had
    // already gone, and delaying the handover by however long the queue was backed up. That is the
    // one thing this signal exists to prevent. Dropping it is safe in the direction that matters:
    // the next renderer statement is 20s away and will be true when it goes, and a dropped
    // host/closed claim only costs a closed view its bounded extra minute.
    if (!this.released || this.draining
        || this.setupPending.length || this.controlPending.length || this.pending.length) { return; }
    this.send({ type: "editor_state", source, view });
  }

  private stopLivenessPings(): void {
    if (this.livenessTimer !== undefined) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
  }

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
      // The chat that was stopped: another chat's open approvals and queued prompts are not this
      // Stop's to end.
      this.endChatRequests(item.chat);
      const dropped = this.dropQueuedTurns(item.chat);
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
    if (!this.writeFrame(item.frame, item.type)) {
      this.reject("DGC backend is unavailable; retry after it restarts");
      return false;
    }
    if (isResponse && item.requestId) {
      this.respondedRequests.add(item.requestId);
    }
    return true;
  }

  /** Send a query/state command and settle only from the response belonging to this request.
   * Current protocol-v7 backends echo `request_id`; callers may omit it only for a negotiated
   * legacy backend, where installing the listener before `send` still provides a post-send
   * sequence barrier. Rejections, fatal transport errors, process exit, and timeout always release
   * every listener. */
  request(cmd: DgcCommand, responseType: DgcEventType, timeoutMs = 5000, setup = false): Promise<DgcEvent> {
    return awaitResponse(this, (command) => (setup ? this.sendSetup(command) : this.send(command)),
                         cmd, responseType, timeoutMs);
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
    if (!this.writeFrame(item.frame, item.type)) {
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

  /** Whether user commands flow: ready, and the slot that started it finished its handshake. */
  get handshakeComplete(): boolean { return this.ready && this.released; }

  /** The slot that started this backend is closing. Chats other slots opened on it keep the process
   *  alive -- closing one chat must not end the others -- and the last of them to close stops it.
   *  The chat this slot showed ends all the same: a new session stops its turn, its queued prompts,
   *  its sub-tasks, monitors and goal, and expires its open cards. Left alone it kept editing files
   *  with no tab, no transcript and no Stop until the last other chat closed. */
  close(cause: string): void {
    if (this.chatUsers.size) {
      if (!this.ownerReleased && this.handshakeComplete) {
        this.send({ type: "new_session", request_id: `retire-${this.childPid ?? 0}-${Date.now()}` } as DgcCommand);
      }
      this.ownerReleased = true;
      return;
    }
    this.dispose(cause);
  }

  /** Restart means a new process: every chat on this one goes with it. */
  restartProcess(cause: string): void {
    this.dispose(cause);
  }

  /** Stop the current child on purpose. `cause` is what the exit line and the panel will report. */
  dispose(cause = "disposed"): void {
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
    this.requestChats.clear();
    const p = this.proc;
    this.proc = undefined;
    // The doomed child keeps its `life` record until its exit is observed, now carrying the
    // cause, so the exit line says whether WE asked for the shutdown and why — the one question a
    // lost turn needs answered.
    const record = p ? this.life.get(p) : undefined;
    if (record && !record.cause) {
      record.cause = cause;
    }
    if (p) {
      this.emit("teardown", cause, p.pid);
    }
    this.emit("disposed");
    if (!p) {
      return;
    }
    try {
      if (p.stdin.writable) {
        p.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
        if (record) {
          record.framesWritten += 1;
          record.lastFrame = "shutdown";
        }
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
