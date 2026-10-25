/**
 * ChatDGC from your program: `dgc.chat()`.
 *
 * ChatDGC is DGC's chat app, for everything that isn't code: your model answers, with web search and cited sources,
 * deep research, and files. The same chats the editor shows (with `inheritUserState: true`) or a private store of
 * your own (the client's isolated state). Everything goes through `dgc serve`'s ChatDGC commands (`chatdgc_*`), on
 * a backend of its own that never opens your workspace.
 *
 *     const dgc = new DGC({ inheritUserState: true });
 *     const chats = await dgc.chat();
 *     const reply = await chats.ask("How does compound interest work?");
 *     console.log(reply.text);
 *     for (const source of reply.sources) console.log(source.n, source.title, source.url);
 *
 * A {@link Chat} holds one conversation: `send()` waits for the whole reply, `stream()` yields it as it's written,
 * `research()` runs deep research. One reply at a time per chat; any number of chats at once. The same API as the
 * Python SDK's `DGC.chat()`.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { DGCConfigError, DGCRuntimeError, DGCTimeoutError, DGCUnsupportedError } from "./errors.ts";
import type { Session } from "./session.ts";
import type { Frame } from "./transport.ts";

export const CHAT_THINKING = ["off", "low", "medium", "high", "xhigh"] as const;
export type ChatThinking = (typeof CHAT_THINKING)[number];
export type ChatSearch = "off" | "auto" | "on";
const SEARCH: readonly string[] = ["off", "auto", "on"];
const MAX_FILES = 10;

/** A page a reply cites: `[n]` in its text. */
export type ChatSource = { n: number; title: string; url: string; snippet: string };

/** A finished reply. `text` is Markdown with `[n]` citations; `sources` are what they point to. */
export type ChatReply = {
  chatId: string;
  messageId: string;
  text: string;
  sources: ChatSource[];
  searches: string[];
  files: Array<Record<string, unknown>>;
  model: string;
  finish: string;
  usage: Record<string, unknown>;
  research: Record<string, unknown> | null;
  raw: Record<string, unknown>;
};

/** A chat in the list, newest first. */
export type ChatSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
  messages: number;
  pinned: boolean;
  archived: boolean;
  project: string;
};

/**
 * One moment of a reply, from {@link Chat.stream}. `kind`: `"text"` (`text` is the next piece of the reply),
 * `"thinking"` (the model's thinking, when it shows it), `"activity"` (`data` = {kind, text}: searching, looking,
 * compacting, ...), `"question"` (`data` is a question the reply put to you), `"research"` (`data` is deep
 * research's progress) or `"reply"` (the last one: `reply` is the finished {@link ChatReply}).
 */
export type ChatEvent = {
  kind: "text" | "thinking" | "activity" | "question" | "research" | "reply";
  text: string;
  data: Record<string, unknown>;
  reply?: ChatReply;
};

export type ChatSendOptions = {
  model?: string;
  thinking?: ChatThinking;
  /** `"auto"` (the default: it searches when an answer depends on facts), `"on"` (search first) or `"off"`. */
  search?: ChatSearch;
  /** Up to ten local files the backend reads. */
  files?: string[];
  /** `true` turns Study mode on for the chat from this message (it teaches instead of answering), `false` off. */
  study?: boolean;
  /** For the whole reply (default: the client's `replyTimeoutMs`); past it the reply is stopped. `null`: none. */
  timeoutMs?: number | null;
};

export type ChatAnswerOptions = {
  /** The card's index in the reply (0 for the first). */
  question?: number;
  /** A card of several questions: one answer each, in order (instead of the single choice). */
  choices?: string[];
  model?: string;
  thinking?: ChatThinking;
  search?: ChatSearch;
  timeoutMs?: number | null;
};

export type ChatsOptions = {
  /** Every message's model and thinking, unless a message says otherwise. */
  model?: string;
  thinking?: ChatThinking;
  /** How long a reply may take, in ms (default: no limit, as `null`). */
  replyTimeoutMs?: number | null;
};

export type ResearchOptions = {
  model?: string;
  thinking?: ChatThinking;
  /** Gets the plan ({title, steps, sites}) and may return a changed one, as you'd edit it in the editor. */
  editPlan?: (plan: Record<string, unknown>) => Record<string, unknown> | null | undefined | Promise<Record<string, unknown> | null | undefined>;
  /** Sees the progress. */
  onEvent?: (event: ChatEvent) => void;
  /** Each of its two turns, in ms (default: the client's `replyTimeoutMs`, which is no limit unless given one). */
  timeoutMs?: number | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const thinkingOf = (value: unknown, name = "thinking"): ChatThinking | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!(CHAT_THINKING as readonly string[]).includes(String(value))) throw new DGCConfigError(`${name} must be one of ${CHAT_THINKING.join(", ")}`);
  return value as ChatThinking;
};

function toReply(chatId: string, message: Record<string, unknown>): ChatReply {
  const sources = (Array.isArray(message.sources) ? message.sources : []).map(record)
    .map((s) => ({ n: Number(s.n) || 0, title: text(s.title), url: text(s.url), snippet: text(s.snippet) }));
  const research = message.research && typeof message.research === "object" ? { ...record(message.research) } : null;
  return {
    chatId, messageId: text(message.id), text: text(message.text), sources,
    searches: (Array.isArray(message.searches) ? message.searches : []).map(text),
    files: (Array.isArray(message.files) ? message.files : []).map((f) => ({ ...record(f) })),
    model: text(message.model), finish: text(message.finish), usage: { ...record(message.usage) }, research, raw: { ...message },
  };
}

function toSummary(row: Record<string, unknown>): ChatSummary {
  return {
    id: text(row.id), title: text(row.title), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
    preview: text(row.preview), messages: Number(row.messages) || 0, pinned: Boolean(row.pinned),
    archived: Boolean(row.archived), project: text(row.project),
  };
}

let counter = 0;
const requestId = (): string => `chat-${Date.now().toString(36)}-${(++counter).toString(36)}`;

/** One conversation's events, handed from the reader to the reply that waits for them. */
class Inbox {
  private readonly items: Array<Frame | Error> = [];
  private waiter: ((item: Frame | Error | null) => void) | null = null;

  push(item: Frame | Error): void {
    const waiter = this.waiter;
    if (waiter) { this.waiter = null; waiter(item); } else this.items.push(item);
  }

  take(ms: number): Promise<Frame | Error | null> {
    if (this.items.length) return Promise.resolve(this.items.shift() as Frame | Error);
    return new Promise((done) => {
      const timer = setTimeout(() => { this.waiter = null; done(null); }, Math.max(1, Math.min(ms, 2 ** 31 - 1)));
      this.waiter = (item) => { clearTimeout(timer); done(item); };
    });
  }
}

/** ChatDGC on its own backend: list, open and start chats. Made by `dgc.chat()`; close it (or the client) when done. */
export class Chats {
  private readonly session: Session;
  /** @internal What the backend offers (a card of several questions, ...). */
  capabilities(): Record<string, unknown> { return this.session.capabilities as Record<string, unknown>; }
  private readonly ownsSession: boolean;
  /** @internal */ readonly model: string | undefined;
  /** @internal */ readonly thinking: ChatThinking | undefined;
  /** @internal */ readonly replyTimeoutMs: number | null;
  /** @internal */ readonly listeners = new Map<string, Inbox>();
  /** @internal */ readonly titles = new Map<string, string>();
  private failure: Error | null = null;
  private closedFlag = false;

  constructor(session: Session, options: ChatsOptions = {}, ownsSession = true) {
    const chatdgc = record(session.capabilities.chatdgc);
    if (!(Number(chatdgc.version) >= 1)) throw new DGCUnsupportedError("This DGC CLI has no ChatDGC; update it (dgc update).");
    this.session = session;
    this.ownsSession = ownsSession;
    this.model = options.model;
    this.thinking = thinkingOf(options.thinking);
    this.replyTimeoutMs = options.replyTimeoutMs ?? null;
    if (this.replyTimeoutMs !== null && !(this.replyTimeoutMs > 0 && Number.isFinite(this.replyTimeoutMs))) {
      throw new DGCConfigError("replyTimeoutMs must be a positive number of ms, or null for no limit");
    }
    void this.read();
  }

  /** @internal */ get closed(): boolean {
    return this.closedFlag;
  }

  /** The one reader: every ChatDGC event goes to its conversation; a reply to a request is left for it. */
  private async read(): Promise<void> {
    for (;;) {
      let frame: Frame;
      try {
        frame = await this.session.transport.next(null);
      } catch (error) {
        this.fail(error instanceof Error ? error : new DGCRuntimeError(String(error)));
        return;
      }
      const kind = text(frame.type), conversation = frame.conversation_id;
      if (kind === "chatdgc_changed" && typeof conversation === "string") {
        const title = record(frame.summary).title;
        if (title) this.titles.set(conversation, text(title));
      }
      if (!kind.startsWith("chatdgc_") || typeof conversation !== "string") continue;
      this.listeners.get(conversation)?.push(frame);
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const inbox of this.listeners.values()) inbox.push(error);
  }

  /** @internal */ failureMessage(): string {
    return this.failure?.message || "the ChatDGC backend went away";
  }

  /** @internal */ async request(command: Frame, response: string, timeoutMs?: number): Promise<Frame> {
    if (this.closedFlag) throw new DGCRuntimeError("these chats are closed");
    const id = requestId();
    return this.session.transport.request({ ...command, request_id: id }, response, { timeoutMs, requestId: id });
  }

  /** @internal */ send(command: Frame): void {
    if (this.closedFlag) throw new DGCRuntimeError("these chats are closed");
    this.session.transport.send(command);
  }

  /** Chats, newest first; `query` finds a chat by its title or anything said in it. */
  async list(query?: string, options: { limit?: number; offset?: number; archived?: boolean } = {}): Promise<ChatSummary[]> {
    const command: Frame = {
      type: "chatdgc_list", limit: Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 200)),
      offset: Math.max(0, Math.trunc(options.offset ?? 0)), archived: Boolean(options.archived),
    };
    if (query) command.query = String(query).slice(0, 500);
    const answer = await this.request(command, "chatdgc_chats");
    return (Array.isArray(answer.chats) ? answer.chats : []).map(record).map(toSummary);
  }

  /** A new chat. It's saved (and listed) from its first message; a temporary one never is. */
  async new(options: { temporary?: boolean } = {}): Promise<Chat> {
    return new Chat(this, await this.request({ type: "chatdgc_open", ...(options.temporary ? { temporary: true } : {}) }, "chatdgc_opened"));
  }

  /** An existing chat, with its latest messages. */
  async open(chatId: string): Promise<Chat> {
    if (typeof chatId !== "string" || !chatId) throw new DGCConfigError("chatId must be a chat's id");
    return new Chat(this, await this.request({ type: "chatdgc_open", conversation_id: chatId }, "chatdgc_opened"));
  }

  /** One question in a new chat: its reply. Options as {@link Chat.send}, plus `temporary`. */
  async ask(question: string, options: ChatSendOptions & { temporary?: boolean } = {}): Promise<ChatReply> {
    const { temporary, ...rest } = options;
    return (await this.new({ temporary })).send(question, rest);
  }

  async close(): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.fail(new DGCRuntimeError("these chats are closed"));
    if (this.ownsSession) await this.session.close();
  }
}

/** One conversation: `id`, `title` and `messages` (as the chat was opened, then each turn's). */
export class Chat {
  readonly id: string;
  readonly temporary: boolean;
  messages: Array<Record<string, unknown>>;
  private readonly chats: Chats;
  private openedTitle: string;

  constructor(chats: Chats, opened: Frame) {
    this.chats = chats;
    const conversation = record(opened.conversation);
    this.id = text(conversation.id);
    this.openedTitle = text(conversation.title) || "New chat";
    this.temporary = Boolean(conversation.temporary);
    this.messages = (Array.isArray(opened.messages) ? opened.messages : []).map((m) => ({ ...record(m) }));
    if (!this.id) throw new DGCRuntimeError("ChatDGC opened a chat without an id");
  }

  get title(): string {
    return this.chats.titles.get(this.id) ?? this.openedTitle;
  }

  /** One turn: send `command`, yield its events until it ends. */
  private async *turn(command: Frame, timeoutMs: number | null | undefined): AsyncGenerator<ChatEvent> {
    const chats = this.chats;
    if (chats.closed) throw new DGCRuntimeError("these chats are closed");
    if (chats.listeners.has(this.id)) throw new DGCRuntimeError("this chat is already answering; wait for its reply");
    const inbox = new Inbox();
    chats.listeners.set(this.id, inbox);
    const id = requestId();
    const limit = timeoutMs === undefined ? chats.replyTimeoutMs : timeoutMs;
    const deadline = limit === null ? Infinity : Date.now() + limit;
    try {
      chats.send({ ...command, conversation_id: this.id, request_id: id });
      let started = false;
      let final: ChatReply | null = null;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) {
          this.cancel();
          throw new DGCTimeoutError("ChatDGC didn't finish the reply in time; it was stopped");
        }
        const event = await inbox.take(Math.min(left, 1000));
        if (event === null) continue;
        if (event instanceof Error) throw new DGCRuntimeError(chats.failureMessage(), { cause: event });
        const kind = text(event.type);
        if (kind === "chatdgc_error") {
          if (event.request_id === id || started) throw new DGCRuntimeError(text(event.message) || "ChatDGC couldn't answer");
          continue;
        }
        if (kind === "chatdgc_turn") {
          if (event.state === "started") started = true;
          else if (event.state === "ended" && started) {
            if (!final) throw new DGCRuntimeError("ChatDGC ended the reply without one");
            yield { kind: "reply", text: "", data: {}, reply: final };
            return;
          }
        } else if (kind === "chatdgc_delta" && started) {
          if (event.text) yield { kind: "text", text: text(event.text), data: {} };
          if (event.thinking) yield { kind: "thinking", text: text(event.thinking), data: {} };
        } else if (kind === "chatdgc_activity" && started) {
          yield { kind: "activity", text: text(event.text), data: { kind: event.kind, text: event.text } };
        } else if (kind === "chatdgc_question" && started) {
          yield { kind: "question", text: "", data: { ...record(event.question) } };
        } else if (kind === "chatdgc_research") {
          yield { kind: "research", text: "", data: { ...record(event.research) } };
        } else if (kind === "chatdgc_message" && event.message && typeof event.message === "object") {
          const message = { ...record(event.message) };
          this.remember(message);
          if (message.role === "assistant" && started) final = toReply(this.id, message);
        }
      }
    } finally {
      if (chats.listeners.get(this.id) === inbox) chats.listeners.delete(this.id);
    }
  }

  /** The question card `question` of reply `messageId`, as this chat last saw it (undefined when unknown). */
  private card(messageId: string, question: number): Record<string, unknown> | undefined {
    const message = this.messages.find((m) => m.id === messageId && m.role === "assistant");
    const asked = Array.isArray(message?.questions) ? (message!.questions as unknown[]) : [];
    const found = asked[question];
    return found && typeof found === "object" ? found as Record<string, unknown> : undefined;
  }

  private remember(message: Record<string, unknown>): void {
    const at = this.messages.findIndex((known) => known.id === message.id);
    if (at >= 0) this.messages[at] = message;
    else this.messages.push(message);
  }

  private sendCommand(message: string, options: ChatSendOptions): Frame {
    if (typeof message !== "string" || !message.trim()) throw new DGCConfigError("text must be a non-empty message");
    const files = options.files ?? [];
    if (!Array.isArray(files)) throw new DGCConfigError("files must be a list of paths");
    if (files.length > MAX_FILES) throw new DGCConfigError(`a message takes at most ${MAX_FILES} files`);
    const command: Frame = { type: "chatdgc_send", text: message };
    const model = options.model || this.chats.model;
    const thinking = thinkingOf(options.thinking) ?? this.chats.thinking;
    if (model) command.model = String(model);
    if (thinking) command.thinking = thinking;
    if (options.search !== undefined) {
      if (!SEARCH.includes(options.search)) throw new DGCConfigError("search must be one of off, auto, on");
      command.search = options.search;
    }
    if (options.study !== undefined) {
      if (typeof options.study !== "boolean") throw new DGCConfigError("study must be true or false");
      command.study = options.study;
    }
    if (files.length) {
      command.attachments = files.map((item) => {
        const path = resolve(String(item).replace(/^~(?=$|\/)/, homedir()));
        let file = false;
        try { file = statSync(path).isFile(); } catch { /* reported below */ }
        if (!file) throw new DGCConfigError(`not a file: ${path}`);
        return { kind: "file", path };
      });
    }
    return command;
  }

  /** Send a message and yield the reply as it's written; the last event is `"reply"`. */
  stream(message: string, options: ChatSendOptions = {}): AsyncGenerator<ChatEvent> {
    const command = this.sendCommand(message, options);
    return this.turn(command, options.timeoutMs);
  }

  /** Send a message and wait for the whole reply. */
  async send(message: string, options: ChatSendOptions = {}): Promise<ChatReply> {
    let reply: ChatReply | undefined;
    for await (const event of this.stream(message, options)) if (event.kind === "reply") reply = event.reply;
    if (!reply) throw new DGCRuntimeError("ChatDGC ended the reply without one");
    return reply;
  }

  /**
   * Deep research: a plan ({title, steps, sites}), then the research, then a report whose citations are checked.
   * `editPlan` gets the plan and may return a changed one; `onEvent` sees the progress. Returns the report.
   */
  async research(question: string, options: ResearchOptions = {}): Promise<ChatReply> {
    if (typeof question !== "string" || !question.trim()) throw new DGCConfigError("question must be non-empty");
    const command: Frame = { type: "chatdgc_research", text: question };
    const model = options.model || this.chats.model;
    const thinking = thinkingOf(options.thinking) ?? this.chats.thinking;
    if (model) command.model = String(model);
    if (thinking) command.thinking = thinking;
    const timeout = options.timeoutMs;          // undefined: the client's replyTimeoutMs (default: no limit)
    let planned: ChatReply | undefined;
    for await (const event of this.turn(command, timeout)) {
      options.onEvent?.(event);
      if (event.kind === "reply") planned = event.reply;
    }
    if (!planned) throw new DGCRuntimeError("ChatDGC ended the plan without one");
    let plan = { ...record(record(planned.research).plan) };
    if (!Object.keys(plan).length) return planned;            // it answered without researching (a quick question)
    if (options.editPlan) {
      const changed = await options.editPlan({ ...plan });
      if (changed) plan = { ...changed };
    }
    let report: ChatReply | undefined;
    for await (const event of this.turn({ type: "chatdgc_research_start", message_id: planned.messageId, plan }, timeout)) {
      options.onEvent?.(event);
      if (event.kind === "reply") report = event.reply;
    }
    if (!report) throw new DGCRuntimeError("ChatDGC ended the research without a report");
    return report;
  }

    /**
   * Answer the question card a reply asked (a `"question"` event), as a click on it does: the message the model wrote
   * for it is sent with your answer in, and its reply comes back. `choice` answers a one-question card; `choices`
   * (in options) answers a card of several questions, one each, in order. Only while that reply is the last thing said.
   */
  async answer(messageId: string, choice?: string, options: ChatAnswerOptions = {}): Promise<ChatReply> {
    if (typeof messageId !== "string" || !messageId) throw new DGCConfigError("messageId must be the id of the reply that asked");
    const question = options.question ?? 0;
    if (!Number.isSafeInteger(question) || question < 0) throw new DGCConfigError("question must be the card's index (0 for the first)");
    const command: Frame = { type: "chatdgc_answer", message_id: messageId, question };
    // Counted in characters (code points) after trimming, as the Python SDK counts them.
    const size = (text: string) => [...text].length;
    const card = this.card(messageId, question);
    const form = card && Array.isArray(card.questions) && card.questions.length > 1 ? card.questions : null;
    if (options.choices !== undefined) {
      if (!Array.isArray(options.choices) || !options.choices.every((c) => typeof c === "string")) {
        throw new DGCConfigError("choices must be a list of answers, each one text");
      }
      const picked = options.choices.map((c) => c.trim());
      if (picked.length < 2 || picked.length > 4 || picked.some((c) => size(c) < 1 || size(c) > 500)) {
        throw new DGCConfigError("choices must be 2 to 4 answers of 1 to 500 characters, one for each question on the card");
      }
      if (card && !form) throw new DGCConfigError("that card asks one question: answer it with choice");
      if (form && form.length !== picked.length) throw new DGCConfigError(`that card asks ${form.length} questions: give one answer each`);
      const forms = record(this.chats.capabilities().chatdgc).question_forms;
      if (typeof forms !== "number" || forms < 1) throw new DGCUnsupportedError("This DGC CLI can't take a card of several questions; update it (dgc update).");
      command.choice = picked[0]; command.choices = picked;
    } else {
      const text = typeof choice === "string" ? choice.trim() : "";
      if (size(text) < 1 || size(text) > 500) throw new DGCConfigError("choice must be the answer, 1 to 500 characters");
      if (form) throw new DGCConfigError(`that card asks ${form.length} questions: answer them with choices, one each`);
      command.choice = text;
    }
    const model = options.model || this.chats.model;
    const thinking = thinkingOf(options.thinking) ?? this.chats.thinking;
    if (model) command.model = String(model);
    if (thinking) command.thinking = thinking;
    if (options.search !== undefined) {
      if (!SEARCH.includes(options.search)) throw new DGCConfigError("search must be one of off, auto, on");
      command.search = options.search;
    }
    let reply: ChatReply | undefined;
    for await (const event of this.turn(command, options.timeoutMs)) if (event.kind === "reply") reply = event.reply;
    if (!reply) throw new DGCRuntimeError("ChatDGC ended the reply without one");
    return reply;
  }

  /** Stop the reply being written; what it wrote so far is kept. */
  cancel(): void {
    try { this.chats.send({ type: "chatdgc_cancel", conversation_id: this.id }); } catch { /* the backend is gone */ }
  }

  private async update(fields: Frame): Promise<void> {
    await this.chats.request({ type: "chatdgc_update", conversation_id: this.id, ...fields }, "chatdgc_changed");
  }

  async rename(title: string): Promise<void> {
    if (typeof title !== "string" || !title.trim()) throw new DGCConfigError("title must be non-empty");
    const clean = title.trim().slice(0, 200);
    await this.update({ title: clean });
    this.chats.titles.set(this.id, clean);
  }

  async pin(pinned = true): Promise<void> {
    await this.update({ pinned: Boolean(pinned) });
  }

  async archive(archived = true): Promise<void> {
    await this.update({ archived: Boolean(archived) });
  }

  /** Delete the chat (its canvases and files too). It can't be undone. */
  async delete(): Promise<void> {
    await this.update({ delete: true });
  }

  /** Save the chat as Markdown (what you see, with its sources) or JSON (everything). Resolves to the file written. */
  async export(path: string, options: { format?: "markdown" | "json" } = {}): Promise<string> {
    const format = options.format ?? "markdown";
    if (format !== "markdown" && format !== "json") throw new DGCConfigError("format must be markdown or json");
    const target = resolve(String(path).replace(/^~(?=$|\/)/, homedir()));
    const answer = await this.chats.request({ type: "chatdgc_export", conversation_id: this.id, path: target, format }, "chatdgc_exported", 120_000);
    return text(answer.path) || target;
  }

  /** Read the chat again (another client may have added to it). */
  async refresh(): Promise<void> {
    const opened = await this.chats.request({ type: "chatdgc_open", conversation_id: this.id }, "chatdgc_opened");
    this.messages = (Array.isArray(opened.messages) ? opened.messages : []).map((m) => ({ ...record(m) }));
    const title = record(opened.conversation).title;
    if (title) this.openedTitle = text(title);
  }
}
