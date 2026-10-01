import { EventEmitter } from "events";
import { awaitResponse, ChildExitInfo, DgcBackend, DgcEvent } from "./backend";
import type { DgcCommand, DgcEventType } from "./protocol.generated";

const RESERVED_EVENT_NAMES = new Set(["error", "event", "newListener", "removeListener"]);

/** What a chat slot holds: a backend of its own (DgcBackend), or a chat opened on one another slot
 *  started (OpenedChat). The panel drives both the same way. */
export interface ChatBackend extends EventEmitter {
  readonly ready: boolean;
  readonly childPid: number | undefined;
  readonly uptimeMs: number;
  start(): void;
  send(cmd: DgcCommand): boolean;
  sendSetup(cmd: DgcCommand): boolean;
  request(cmd: DgcCommand, responseType: DgcEventType, timeoutMs?: number, setup?: boolean): Promise<DgcEvent>;
  completeHandshake(): void;
  editorState(source: "renderer" | "host", view: "open" | "closed"): void;
  /** Stop this chat on purpose: the cause is what its exit line reports. */
  dispose(cause?: string): void;
  /** The slot is going away: end this chat, but never another slot's chat on the same process. */
  close(cause: string): void;
  /** A new process, not just a new chat -- after the CLI changed, or when the process is wedged. */
  restartProcess(cause: string): void;
}

/** How many commands a chat holds while its own handshake runs, before it refuses more. */
const MAX_HELD = 256;

/**
 * A chat in its own directory, opened on a backend another chat slot started -- Codex's model: one
 * `dgc serve`, many sessions, each with its own project root, config, trust, MCP servers and mode.
 *
 * To the panel it is a backend like any other. It "starts" by asking that backend for a chat; its
 * `ready` is the backend's answer -- chat_opened, completed with the process's own version and
 * capabilities -- so the panel runs the same handshake it runs for a process it spawned. Everything
 * it sends carries its chat id, and it hears only its own chat's events. What the process says
 * about itself -- stderr, an exit -- every chat on it hears, because every chat on it is affected.
 */
export class OpenedChat extends EventEmitter implements ChatBackend {
  ready = false;
  chatId = "";
  private released = false;
  private closed = false;
  private held: DgcCommand[] = [];
  private readonly hostListeners: Array<[string, (...args: any[]) => void]> = [];

  constructor(readonly host: DgcBackend, readonly cwd: string, private readonly openRequestId: string) {
    super();
  }

  get childPid(): number | undefined { return this.host.childPid; }
  get uptimeMs(): number { return this.host.uptimeMs; }

  start(): void {
    if (this.hostListeners.length || this.closed) { return; }
    this.host.chatUsers.add(this);
    this.listen("chat-event", (chat: string, ev: DgcEvent) => this.onChatEvent(chat, ev));
    this.listen("chat-open-failed", (ev: DgcEvent) => {
      if ((ev as any).request_id !== this.openRequestId || this.chatId) { return; }
      this.failToOpen(String((ev as any).message || "the backend could not open this chat"));
    });
    for (const name of ["stderr", "spawned", "launch_failed", "teardown"]) {
      this.listen(name, (...args: any[]) => this.emit(name, ...args));
    }
    this.listen("exit", (...args: any[]) => {
      // The process is gone, and every chat on it with it.
      this.detach();
      this.emit("exit", ...args);
    });
    this.listen("disposed", () => this.emit("disposed"));
    if (!this.host.send({ type: "open_chat", request_id: this.openRequestId, cwd: this.cwd } as DgcCommand)) {
      this.failToOpen("the backend would not take a request to open a chat");
    }
  }

  private listen(name: string, handler: (...args: any[]) => void): void {
    this.host.on(name, handler);
    this.hostListeners.push([name, handler]);
  }

  /** Stop hearing the process. Idempotent. */
  private detach(): void {
    for (const [name, handler] of this.hostListeners.splice(0)) {
      this.host.off(name, handler);
    }
    this.host.chatUsers.delete(this);
    this.ready = false;
    this.released = false;
    this.held = [];
  }

  /** The chat never opened: report it the way a backend that died at start is reported, so the
   *  slot shows why and its bounded recovery decides whether to try again. */
  private failToOpen(message: string): void {
    this.closed = true;
    this.detach();
    this.emit("launch_failed", message);
    this.emit("stderr", `serve loop ended: ${message}`);
    this.emit("exit", 1, null, { uptimeMs: 0, framesWritten: 0 } as ChildExitInfo);
    this.releaseHostIfLast(`the chat in ${this.cwd} could not open`);
  }

  private onChatEvent(chat: string, ev: DgcEvent): void {
    if (!this.chatId) {
      if (ev.type === "chat_opened" && (ev as any).request_id === this.openRequestId) {
        this.chatId = chat;
        this.ready = true;
        this.deliver(this.readyFrom(ev));
      }
      return;
    }
    if (chat !== this.chatId) { return; }
    this.deliver(ev);
    if (ev.type === "chat_closed" && !this.closed) {
      // Ended by the backend, not by us: report it as this chat's backend going away.
      this.closed = true;
      this.detach();
      this.emit("stderr", `serve loop ended: the chat was ${String((ev as any).reason || "closed")}`);
      this.emit("exit", 0, null, { uptimeMs: this.uptimeMs, framesWritten: 0 } as ChildExitInfo);
    }
  }

  /** chat_opened is ready's per-chat half; the rest is the process's own. */
  private readyFrom(opened: DgcEvent): DgcEvent {
    const base: any = this.host.readyEvent || {};
    const { request_id: _request, ...fields } = opened as any;
    return { ...fields, type: "ready", version: base.version, protocol_version: base.protocol_version,
             capabilities: base.capabilities || {} } as DgcEvent;
  }

  private deliver(ev: DgcEvent): void {
    this.emit("event", ev);
    if (!RESERVED_EVENT_NAMES.has(ev.type)) {
      this.emit(ev.type, ev);
    }
  }

  private stamp(cmd: DgcCommand): DgcCommand {
    return { ...(cmd as any), chat_id: this.chatId } as DgcCommand;
  }

  send(cmd: DgcCommand): boolean {
    if (this.closed) { return false; }
    if (!this.released) {
      // Like a backend that has not finished its handshake: user commands wait for the slot to
      // configure this chat's roots and settings first.
      if (this.held.length >= MAX_HELD) { return false; }
      this.held.push(cmd);
      return true;
    }
    return this.host.send(this.stamp(cmd));
  }

  sendSetup(cmd: DgcCommand): boolean {
    if (this.closed || !this.ready) { return false; }
    return this.host.send(this.stamp(cmd));
  }

  request(cmd: DgcCommand, responseType: DgcEventType, timeoutMs = 5000, setup = false): Promise<DgcEvent> {
    return awaitResponse(this, (command) => (setup ? this.sendSetup(command) : this.send(command)),
                         cmd, responseType, timeoutMs);
  }

  completeHandshake(): void {
    if (!this.ready || this.released) { return; }
    this.released = true;
    for (const cmd of this.held.splice(0)) {
      this.host.send(this.stamp(cmd));
    }
  }

  editorState(source: "renderer" | "host", view: "open" | "closed"): void {
    // Liveness is the process's: what is on screen keeps the whole backend, every chat, alive.
    this.host.editorState(source, view);
  }

  dispose(cause = "disposed"): void {
    if (this.closed) { return; }
    this.closed = true;
    const chatId = this.chatId;
    const pid = this.childPid;
    this.detach();
    if (chatId) {
      this.host.send({ type: "close_chat", request_id: this.openRequestId + "-close", chat_id: chatId } as DgcCommand);
    }
    // The same shape a deliberately stopped process reports, so the slot treats it as asked-for.
    this.emit("teardown", cause, pid);
    this.emit("disposed");
    this.emit("exit", null, null, { pid, uptimeMs: this.uptimeMs, cause, framesWritten: 0 } as ChildExitInfo);
    this.releaseHostIfLast(cause);
  }

  close(cause: string): void {
    this.dispose(cause);
  }

  restartProcess(cause: string): void {
    this.host.restartProcess(cause);
  }

  /** The slot that started the process has already gone; this was the last chat keeping it up. */
  private releaseHostIfLast(cause: string): void {
    if (this.host.ownerReleased && !this.host.chatUsers.size) {
      this.host.dispose(cause);
    }
  }
}
