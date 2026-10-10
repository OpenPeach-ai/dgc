import * as vscode from "vscode";
import { homedir } from "os";

/**
 * ChatDGC in the editor: a chat tab of its own (one conversation each) and the home's Chat list.
 *
 * Chats are the process's, not a session's (dgc/chatdgc): the same list in every folder. They ride
 * on the side bar's `dgc serve`, the process whose handshake already gave it your model settings
 * and keys, and every `chatdgc_*` event that process sends comes here (DgcViewProvider routes them
 * before any session sees them). The process is asked for afresh on every send: a restarted side bar
 * has a new one, and a retired one must never be started again.
 */
export const CHATDGC_EDITOR = "dgc.chatdgcEditor";
const CONVERSATION_ID = /^chat_[a-f0-9]{32}$/;
const MESSAGE_ID = /^msg_[a-f0-9]{32}$/;
const THINKING = new Set(["off", "low", "medium", "high", "xhigh"]);
const SEARCH = new Set(["off", "auto", "on"]);
const MAX_TEXT = 1_000_000;
const TITLE_CHARS = 40;
const HOME_FIRST = 6;          // the home shows a few chats; "Show more" pages on
const HOME_PAGE = 50;
const MAX_REQUESTS = 512;
const MAX_ATTACHMENTS = 10;
/** What one send may carry inline (pasted images and text), under the 4 MiB command frame; a picked file
 *  goes by its path and costs the frame nothing. */
const MAX_INLINE_CHARS = 3_000_000;

/** What ChatDGC needs of the side bar: its process, and its home's webview. */
export interface ChatDGCHost {
  /** "sent"; "starting" while its process comes up (sent again once it's ready); "old_cli" when it
   *  has no ChatDGC. */
  chatdgcSend(cmd: Record<string, unknown>): "sent" | "starting" | "old_cli";
  chatdgcModels(): Promise<{ ids: string[]; current: string }>;
  postHome(message: Record<string, unknown>): void;
}

interface Tab {
  panel: vscode.WebviewPanel;
  conversation: string;
  temporary: boolean;
  summary?: any;
  /** Commands held while the process starts. */
  held: Record<string, unknown>[];
  opened: boolean;
  /** Files this tab's picker returned: the only paths a send may name, so a page can never have the
   *  backend read a file the user didn't choose. */
  picked: Set<string>;
}

type Asker = { tab?: Tab; home?: boolean; kind: string };

export function chatTitle(text: string): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "New chat";
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1).trimEnd()}…` : flat;
}

const attr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function chatdgcDocument(asset: (name: string) => string, cspSource: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; font-src ${attr(cspSource)}; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};">
<link rel="stylesheet" href="${attr(asset("media/codicon.css"))}"><link rel="stylesheet" href="${attr(asset("media/main.css"))}"><link rel="stylesheet" href="${attr(asset("media/chatdgc.css"))}">
<title>ChatDGC</title></head><body class="cd-blank">
<header class="cd-head"><h1 id="cd-title" class="cd-title">New chat</h1><span id="cd-temp-badge" class="cd-badge" hidden>Temporary</span>
<button type="button" id="cd-keys-open" class="cd-icon" title="Keyboard shortcuts (Ctrl+/)" aria-label="Keyboard shortcuts"><span class="codicon codicon-keyboard" aria-hidden="true"></span></button>
<button type="button" id="cd-menu" class="cd-icon" title="Rename, pin, archive, export or delete" aria-label="Chat options" hidden><span class="codicon codicon-ellipsis" aria-hidden="true"></span></button>
<button type="button" id="cd-new" class="cd-icon" title="New chat" aria-label="New chat"><span class="codicon codicon-edit" aria-hidden="true"></span></button></header>
<main id="cd-scroll" class="cd-scroll"><div class="cd-column">
<button type="button" id="cd-earlier" class="cd-earlier" hidden>Show earlier messages</button>
<div id="cd-log" class="cd-log" role="log" aria-label="Conversation"></div>
<section id="cd-empty" class="cd-empty"><h2>What can I help with?</h2></section>
</div></main>
<footer class="cd-foot"><div class="cd-column">
<p id="cd-notice" class="cd-notice" role="alert" hidden></p>
<div id="cd-context-pop" class="cd-pop" role="dialog" aria-label="Context window" hidden></div>
<form id="cd-box" class="cd-box"><ul id="cd-chips" class="cd-chips" aria-label="Attached" hidden></ul><label for="cd-input" class="sr-only">Message ChatDGC</label>
<textarea id="cd-input" class="cd-input" rows="1" placeholder="Ask anything" maxlength="${MAX_TEXT}"></textarea>
<div class="cd-tools">
<button type="button" id="cd-attach" class="cd-icon" title="Attach files (or paste an image)" aria-label="Attach files"><span class="codicon codicon-attach" aria-hidden="true"></span></button>
<label class="sr-only" for="cd-model">Model</label><select id="cd-model" class="cd-select" title="Model"></select>
<label class="sr-only" for="cd-thinking">Thinking</label><select id="cd-thinking" class="cd-select" title="How much the model thinks first">
<option value="off">Thinking off</option><option value="low">Think: low</option><option value="medium">Think: medium</option><option value="high">Think: high</option><option value="xhigh">Think: extra high</option></select>
<label class="sr-only" for="cd-search">Web search</label><select id="cd-search" class="cd-select" title="Web search: Auto lets the model decide; Always searches before it answers">
<option value="auto">Web: auto</option><option value="on">Web: always</option><option value="off">Web: off</option></select>
<label id="cd-temp-toggle" class="cd-toggle" title="A temporary chat isn't saved or listed"><input type="checkbox" id="cd-temporary"> Temporary</label>
<span class="cd-spacer"></span>
<button type="button" id="cd-context" class="cd-meter" aria-haspopup="dialog" aria-expanded="false" hidden><svg class="cd-ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="cd-ring-track" cx="10" cy="10" r="8"></circle><circle id="cd-ring-fill" class="cd-ring-fill" cx="10" cy="10" r="8"></circle></svg><span id="cd-context-pct">0%</span></button>
<button type="submit" id="cd-send" class="cd-send" title="Send (Enter)" aria-label="Send" disabled><span class="codicon codicon-arrow-up" aria-hidden="true"></span></button>
<button type="button" id="cd-stop" class="cd-send cd-stop" title="Stop (Esc)" aria-label="Stop" hidden><span class="codicon codicon-debug-stop" aria-hidden="true"></span></button>
</div></form>
<p class="cd-fine">ChatDGC answers with your own model. Check what matters.</p>
</div></footer>
<div id="cd-announce" class="sr-only" aria-live="polite"></div>
<dialog id="cd-keys" class="cd-keys" aria-labelledby="cd-keys-title"><h2 id="cd-keys-title">Keyboard shortcuts</h2><dl id="cd-keys-list"></dl>
<button type="button" id="cd-keys-close" class="cd-edit-cancel">Close</button></dialog>
<script src="${attr(asset("dist/markdown.js"))}"></script><script src="${attr(asset("media/chatdgc.js"))}"></script></body></html>`;
}

export class ChatDGC implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private readonly tabs = new Set<Tab>();
  private readonly requests = new Map<string, Asker>();
  private seq = 0;
  private host?: ChatDGCHost;
  private homeQuery = "";
  private homeShown = HOME_FIRST;
  private homeHeld = false;
  private homeTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext) {}

  attach(host: ChatDGCHost): void { this.host = host; }

  register(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(CHATDGC_EDITOR, this);
  }

  /** A conversation in a tab of its own (or the tab it is already in); "" starts a new chat. */
  open(conversation = "", temporary = false): void {
    const id = CONVERSATION_ID.test(conversation) ? conversation : "";
    if (id) {
      for (const tab of this.tabs) { if (tab.conversation === id) { tab.panel.reveal(); return; } }
    }
    const panel = vscode.window.createWebviewPanel(CHATDGC_EDITOR, "New chat", vscode.ViewColumn.Active, this.options());
    this.adopt(panel, id, temporary);
  }

  /** A tab VS Code kept across a reload: its webview remembered which conversation it showed. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any): Promise<void> {
    const id = CONVERSATION_ID.test(String(state?.conversation || "")) ? String(state.conversation) : "";
    if (id && [...this.tabs].some((tab) => tab.conversation === id)) { panel.dispose(); return; }
    panel.webview.options = this.options();
    this.adopt(panel, id, state?.temporary === true);
  }

  private options(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] };
  }

  private adopt(panel: vscode.WebviewPanel, conversation: string, temporary: boolean): void {
    panel.iconPath = { light: vscode.Uri.joinPath(this.context.extensionUri, "media", "dgc-tab-light.svg"),
                       dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "dgc-tab-dark.svg") };
    const tab: Tab = { panel, conversation, temporary, held: [], opened: false, picked: new Set() };
    this.tabs.add(tab);
    panel.onDidDispose(() => {
      this.tabs.delete(tab);
      for (const [id, asker] of this.requests) { if (asker.tab === tab) this.requests.delete(id); }
    });
    panel.webview.onDidReceiveMessage((message) => { void this.fromTab(tab, message); });
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...name.split("/"))).toString();
    panel.webview.html = chatdgcDocument(asset, panel.webview.cspSource);
  }

  // -- the wire

  private nextId(kind: string): string { return `cd-${kind}-${++this.seq}`; }

  private ask(asker: Asker, cmd: Record<string, unknown>): void {
    const requestId = this.nextId(asker.kind);
    this.requests.set(requestId, asker);
    while (this.requests.size > MAX_REQUESTS) { this.requests.delete(this.requests.keys().next().value as string); }
    this.deliver(asker, { ...cmd, request_id: requestId });
  }

  private deliver(asker: Asker, cmd: Record<string, unknown>): void {
    const outcome = this.host ? this.host.chatdgcSend(cmd) : "starting";
    if (outcome === "sent") return;
    if (outcome === "old_cli") {
      const message = "ChatDGC needs a newer DGC CLI. Run “DGC: Update CLI”, then open this chat again.";
      if (asker.tab) this.post(asker.tab, { type: "unavailable", message });
      if (asker.home) this.host?.postHome({ type: "chatdgc_list", available: false });
      return;
    }
    if (asker.tab) asker.tab.held.push(cmd);
    else if (asker.home) this.homeHeld = true;
  }

  /** The side bar's process finished its handshake: whatever waited for it goes now. */
  backendReady(): void {
    for (const tab of this.tabs) {
      const held = tab.held.splice(0);
      for (const cmd of held) this.deliver({ tab, kind: "held" }, cmd);
    }
    if (this.homeHeld) { this.homeHeld = false; this.homeRefresh(); }
  }

  /** The side bar's process went away: a reply in progress there has stopped. */
  backendLost(): void {
    for (const tab of this.tabs) this.post(tab, { type: "lost", message: "DGC restarted, so this reply stopped. Continue it, or send again." });
  }

  /** Every chatdgc_* event the side bar's process sends. */
  onEvent(ev: any): void {
    const requestId = typeof ev?.request_id === "string" ? ev.request_id : "";
    const asker = requestId ? this.requests.get(requestId) : undefined;
    const conversation = typeof ev?.conversation_id === "string" ? ev.conversation_id : "";
    const showing = (id: string) => [...this.tabs].filter((tab) => tab.conversation === id);
    switch (ev?.type) {
      case "chatdgc_chats":
        if (asker?.home) {
          this.requests.delete(requestId);
          const chats = Array.isArray(ev.chats) ? ev.chats : [];
          this.host?.postHome({ type: "chatdgc_list", available: true, query: this.homeQuery, total: Number(ev.total) || 0,
                                more: ev.next_offset !== null && ev.next_offset !== undefined,
                                open: [...this.tabs].map((tab) => tab.conversation).filter(Boolean),
                                items: chats.filter((chat: any) => CONVERSATION_ID.test(String(chat?.id || ""))) });
        }
        return;
      case "chatdgc_opened": {
        if (asker?.kind === "fork" || asker?.kind === "version") {
          // A new version, or another one shown: every tab on this chat shows the conversation as it is now. A
          // fork's request stays open: its turn is still to come.
          if (asker.kind === "version") this.requests.delete(requestId);
          const id = String(ev.conversation?.id || "");
          for (const tab of showing(id)) {
            this.post(tab, { type: "opened", conversation: ev.conversation, messages: ev.messages, earlier: ev.earlier,
                             busy: ev.busy === true, replyId: typeof ev.reply_id === "string" ? ev.reply_id : "", keep: true });
          }
          return;
        }
        if (!asker?.tab) return;
        this.requests.delete(requestId);
        const tab = asker.tab;
        tab.conversation = String(ev.conversation?.id || "");
        tab.temporary = ev.conversation?.temporary === true;
        tab.summary = ev.conversation;
        tab.opened = true;
        tab.panel.title = chatTitle(ev.conversation?.title);
        this.post(tab, { type: "opened", conversation: ev.conversation, messages: ev.messages, earlier: ev.earlier,
                         busy: ev.busy === true, replyId: typeof ev.reply_id === "string" ? ev.reply_id : "" });
        this.homeChanged();
        return;
      }
      case "chatdgc_earlier":
        if (asker?.tab) { this.requests.delete(requestId); this.post(asker.tab, { type: "earlier", messages: ev.messages, earlier: ev.earlier }); }
        return;
      case "chatdgc_turn":
        if (ev.state === "ended" && requestId) this.requests.delete(requestId);
        for (const tab of showing(conversation)) this.post(tab, { type: "turn", state: ev.state, replyId: ev.reply_id });
        return;
      case "chatdgc_delta":
        for (const tab of showing(conversation)) {
          this.post(tab, { type: "delta", messageId: ev.message_id, text: ev.text || "", thinking: ev.thinking || "" });
        }
        return;
      case "chatdgc_message":
        for (const tab of showing(conversation)) this.post(tab, { type: "message", message: ev.message });
        return;
      case "chatdgc_question":
        for (const tab of showing(conversation)) this.post(tab, { type: "question", messageId: ev.message_id, question: ev.question });
        return;
      case "chatdgc_file":
        if (asker?.tab) {
          this.requests.delete(requestId);
          this.post(asker.tab, { type: "image", id: String(ev.attachment_id || ""),
                                 ...(typeof ev.data === "string" ? { data: ev.data } : { error: String(ev.error || "") }) });
        }
        return;
      case "chatdgc_context":
        for (const tab of showing(conversation)) {
          this.post(tab, { type: "context", window: ev.window, limit: ev.limit, used: ev.used, preset: ev.preset,
                           source: ev.source, parts: ev.parts, compactable: ev.compactable });
        }
        return;
      case "chatdgc_compacted":
        if (asker) this.requests.delete(requestId);
        for (const tab of showing(conversation)) this.post(tab, { type: "compacted", summary: ev.summary ?? null });
        return;
      case "chatdgc_exported":
        if (asker) {
          this.requests.delete(requestId);
          const where = String(ev.path || "");
          void vscode.window.showInformationMessage(`Exported to ${where.split(/[\\/]/).pop()}.`, "Open").then((open) => {
            if (open) void vscode.window.showTextDocument(vscode.Uri.file(where));
          });
        }
        return;
      case "chatdgc_activity":
        for (const tab of showing(conversation)) {
          this.post(tab, { type: "activity", messageId: ev.message_id, kind: ev.kind, text: String(ev.text || "") });
        }
        return;
      case "chatdgc_changed":
        for (const tab of showing(conversation)) {
          if (ev.summary) { tab.summary = { ...tab.summary, ...ev.summary }; tab.panel.title = chatTitle(ev.summary.title); }
          this.post(tab, { type: "changed", summary: ev.summary });
        }
        this.homeChanged();
        return;
      case "chatdgc_error": {
        if (asker) this.requests.delete(requestId);
        const message = String(ev.message || "ChatDGC hit an error.");
        if (asker?.tab) { this.post(asker.tab, { type: "error", message, opening: asker.kind === "open" }); return; }
        if (asker?.home) { this.host?.postHome({ type: "chatdgc_list", available: true, error: message, items: [], query: this.homeQuery }); return; }
        for (const tab of showing(conversation)) this.post(tab, { type: "error", message });
        return;
      }
    }
  }

  private post(tab: Tab, message: Record<string, unknown>): void {
    void tab.panel.webview.postMessage(message);
  }

  // -- a tab's own requests

  private async fromTab(tab: Tab, message: any): Promise<void> {
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;
    const conversation = tab.conversation;
    switch (message.type) {
      case "ready": {
        // The webview (re)loaded: it shows what this tab holds, or a new chat.
        this.ask({ tab, kind: "open" }, { type: "chatdgc_open", ...(conversation ? { conversation_id: conversation } : {}),
                                          ...(!conversation && tab.temporary ? { temporary: true } : {}) });
        void this.models(tab);
        return;
      }
      case "reopenNew":                      // the chat it held is gone (a temporary one after a restart)
      case "newChat":
        tab.conversation = "";
        tab.summary = undefined;
        tab.temporary = message.temporary === true;
        tab.panel.title = "New chat";
        this.ask({ tab, kind: "open" }, { type: "chatdgc_open", ...(tab.temporary ? { temporary: true } : {}) });
        this.homeChanged();
        return;
      case "attach": {
        const chosen = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach",
          title: "Attach files to this chat" });
        if (!chosen?.length) return;
        const items = [];
        for (const uri of chosen.slice(0, MAX_ATTACHMENTS)) {
          if (uri.scheme !== "file") continue;
          let size = 0;
          try { size = (await vscode.workspace.fs.stat(uri)).size; } catch { continue; }
          tab.picked.add(uri.fsPath);
          items.push({ kind: "file", path: uri.fsPath, name: uri.path.split("/").pop() || "file", size });
        }
        this.post(tab, { type: "attached", items });
        return;
      }
      case "image":
        if (conversation && /^att_[a-f0-9]{32}$/.test(String(message.id || ""))) {
          this.ask({ tab, kind: "image" }, { type: "chatdgc_file", conversation_id: conversation, attachment_id: message.id });
        }
        return;
      case "dropped": {
        // Dropped from VS Code's Explorer or the system's file manager: as good as picked, with one guard a picker
        // doesn't need. A drop names its files in the page, so a page could name any file; nothing inside a
        // hidden folder (~/.ssh, ~/.dgc, a project's .git) goes by drop. The picker can still choose one.
        const items = [];
        for (const raw of (Array.isArray(message.uris) ? message.uris : []).slice(0, MAX_ATTACHMENTS)) {
          let uri: vscode.Uri;
          try { uri = vscode.Uri.parse(String(raw), true); } catch { continue; }
          if (uri.scheme !== "file" || uri.path.split("/").some((part) => part.startsWith("."))) continue;
          let stat: vscode.FileStat;
          try { stat = await vscode.workspace.fs.stat(uri); } catch { continue; }
          if (stat.type !== vscode.FileType.File) continue;
          tab.picked.add(uri.fsPath);
          items.push({ kind: "file", path: uri.fsPath, name: uri.path.split("/").pop() || "file", size: stat.size });
        }
        if (items.length) this.post(tab, { type: "attached", items });
        else this.post(tab, { type: "error", message: "Those can't be attached here. Use the paperclip to choose a file." });
        return;
      }
      case "send": {
        const text = typeof message.text === "string" ? message.text : "";
        const attachments = this.attachmentsFrom(tab, message.attachments);
        if (attachments === undefined) {
          this.post(tab, { type: "error", message: "Those attachments are too large to send together. Attach big images as files instead." });
          return;
        }
        if (!conversation || (!text.trim() && !attachments.length) || text.length > MAX_TEXT) return;
        const model = typeof message.model === "string" && message.model.length <= 200 ? message.model : "";
        const thinking = typeof message.thinking === "string" && THINKING.has(message.thinking) ? message.thinking : "";
        const search = typeof message.search === "string" && SEARCH.has(message.search) ? message.search : "";
        this.ask({ tab, kind: "send" }, { type: "chatdgc_send", conversation_id: conversation, text,
                                          ...(model ? { model } : {}), ...(thinking ? { thinking } : {}),
                                          ...(search ? { search } : {}),
                                          ...(attachments.length ? { attachments } : {}) });
        return;
      }
      case "continue":
        if (!conversation || !MESSAGE_ID.test(String(message.messageId || ""))) return;
        this.ask({ tab, kind: "send" }, { type: "chatdgc_continue", conversation_id: conversation, message_id: message.messageId });
        return;
      case "edit":
      case "regenerate":
      case "answer": {
        if (!conversation || !MESSAGE_ID.test(String(message.messageId || ""))) return;
        const model = typeof message.model === "string" && message.model.length <= 200 ? message.model : "";
        const thinking = typeof message.thinking === "string" && THINKING.has(message.thinking) ? message.thinking : "";
        const search = typeof message.search === "string" && SEARCH.has(message.search) ? message.search : "";
        const chosen = { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(search ? { search } : {}) };
        if (message.type === "edit") {
          const text = typeof message.text === "string" ? message.text : "";
          if (text.length > MAX_TEXT) return;
          this.ask({ tab, kind: "fork" }, { type: "chatdgc_edit", conversation_id: conversation, message_id: message.messageId,
                                            text, ...chosen });
        } else if (message.type === "answer") {
          // A choice on a reply's question card: the backend writes the message the model prepared for it.
          const choice = typeof message.choice === "string" ? message.choice.trim() : "";
          const question = Number(message.question);
          if (!choice || choice.length > 500 || !Number.isInteger(question) || question < 0 || question > 50) return;
          this.ask({ tab, kind: "send" }, { type: "chatdgc_answer", conversation_id: conversation, message_id: message.messageId,
                                            question, choice, ...chosen });
        } else {
          this.ask({ tab, kind: "fork" }, { type: "chatdgc_regenerate", conversation_id: conversation,
                                            message_id: message.messageId, ...chosen });
        }
        return;
      }
      case "compact":
        if (conversation) this.ask({ tab, kind: "compact" }, { type: "chatdgc_compact", conversation_id: conversation });
        return;
      case "summary": {
        const text = typeof message.text === "string" ? message.text : "";
        if (conversation && text.trim() && text.length <= 20_000) {
          this.ask({ tab, kind: "summary" }, { type: "chatdgc_summary", conversation_id: conversation, text });
        }
        return;
      }
      case "carry":
        // Answered by the new chat's chatdgc_opened, which this tab then shows (an "open" request, as a new chat's).
        if (conversation) this.ask({ tab, kind: "open" }, { type: "chatdgc_carry", conversation_id: conversation });
        return;
      case "version": {
        const parent = String(message.parent || "");
        if (!conversation || !(parent === "root" || MESSAGE_ID.test(parent)) || !Number.isInteger(message.index)
            || message.index < 0 || message.index > 1000) return;
        this.ask({ tab, kind: "version" }, { type: "chatdgc_version", conversation_id: conversation, parent_id: parent,
                                             index: message.index });
        return;
      }
      case "stop":
        if (conversation) this.deliver({ tab, kind: "stop" }, { type: "chatdgc_cancel", conversation_id: conversation });
        return;
      case "earlier":
        if (!conversation || !MESSAGE_ID.test(String(message.before || ""))) return;
        this.ask({ tab, kind: "earlier" }, { type: "chatdgc_earlier", conversation_id: conversation, before: message.before });
        return;
      case "models":
        void this.models(tab);
        return;
      case "menu":
        await this.menu(tab);
        return;
      case "copy":
        if (typeof message.text === "string" && message.text.length <= MAX_TEXT * 2) {
          await vscode.env.clipboard.writeText(message.text);
          this.post(tab, { type: "copied" });
        }
        return;
      case "openLink": {
        const target = typeof message.target === "string" ? message.target : "";
        // Only the web: a chat has no project, so a file link names nothing this tab can open.
        if (/^https?:\/\/[^\s]+$/i.test(target) && target.length <= 8192) {
          await vscode.env.openExternal(vscode.Uri.parse(target, true));
        }
        return;
      }
    }
  }

  /** What a send may carry: files this tab's picker returned (by path), pasted images (PNG, JPEG, GIF or WebP
   *  data: URIs) and pasted text, together small enough for one frame. undefined: too large. */
  private attachmentsFrom(tab: Tab, raw: unknown): Record<string, string>[] | undefined {
    if (!Array.isArray(raw)) return [];
    const out: Record<string, string>[] = [];
    let inline = 0;
    for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
      const name = typeof item?.name === "string" ? item.name.slice(0, 120) : "";
      if (item?.kind === "file" && typeof item.path === "string" && tab.picked.has(item.path)) {
        out.push({ kind: "file", path: item.path, ...(name ? { name } : {}) });
      } else if (item?.kind === "image" && typeof item.data === "string"
                 && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(item.data)) {
        inline += item.data.length;
        out.push({ kind: "image", data: item.data, ...(name ? { name } : {}) });
      } else if (item?.kind === "text" && typeof item.text === "string" && item.text.trim()) {
        inline += item.text.length * 3;            // what it may weigh as UTF-8 in the frame
        out.push({ kind: "text", text: item.text, ...(name ? { name } : {}) });
      }
    }
    return inline > MAX_INLINE_CHARS ? undefined : out;
  }

  private async models(tab: Tab): Promise<void> {
    if (!this.host) return;
    try {
      const { ids, current } = await this.host.chatdgcModels();
      this.post(tab, { type: "models", ids, current });
    } catch (err: any) {
      this.post(tab, { type: "models", ids: [], current: "", error: String(err?.message || err || "") });
    }
  }

  private async menu(tab: Tab): Promise<void> {
    const conversation = tab.conversation;
    if (!conversation || tab.temporary) return;      // a new chat that was never sent says so if asked
    const pinned = tab.summary?.pinned === true;
    const picks = [
      { label: "$(edit) Rename", id: "rename" },
      { label: pinned ? "$(pinned) Unpin" : "$(pin) Pin", id: "pin" },
      { label: "$(archive) Archive", id: "archive" },
      { label: "$(export) Export…", id: "export" },
      { label: "$(trash) Delete", id: "delete" },
    ];
    const choice = await vscode.window.showQuickPick(picks, { placeHolder: chatTitle(tab.summary?.title) });
    if (!choice) return;
    if (choice.id === "rename") {
      const title = await vscode.window.showInputBox({ prompt: "Rename this chat", value: String(tab.summary?.title || ""),
        validateInput: (value) => (value.trim() ? undefined : "Give the chat a name.") });
      if (title === undefined) return;
      this.ask({ tab, kind: "update" }, { type: "chatdgc_update", conversation_id: conversation, title: title.slice(0, 120) });
    } else if (choice.id === "pin") {
      this.ask({ tab, kind: "update" }, { type: "chatdgc_update", conversation_id: conversation, pinned: !pinned });
    } else if (choice.id === "export") {
      const name = chatTitle(tab.summary?.title).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "chat";
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, `${name}.md`),
        filters: { Markdown: ["md"], JSON: ["json"] }, saveLabel: "Export", title: "Export this chat" });
      if (!target || target.scheme !== "file") return;
      this.ask({ tab, kind: "export" }, { type: "chatdgc_export", conversation_id: conversation, path: target.fsPath,
                                          format: /\.json$/i.test(target.fsPath) ? "json" : "markdown" });
    } else if (choice.id === "archive") {
      this.ask({ tab, kind: "update" }, { type: "chatdgc_update", conversation_id: conversation, archived: true });
      tab.panel.dispose();
    } else if (choice.id === "delete") {
      if (await this.confirmDelete(String(tab.summary?.title || ""))) {
        this.ask({ kind: "update" }, { type: "chatdgc_update", conversation_id: conversation, delete: true });
        tab.panel.dispose();
      }
    }
  }

  private async confirmDelete(title: string): Promise<boolean> {
    const DELETE = "Delete";
    const choice = await vscode.window.showWarningMessage(`Delete the chat “${chatTitle(title)}”? This can't be undone.`,
      { modal: true }, DELETE);
    return choice === DELETE;
  }

  // -- the home's Chat list

  homeRefresh(): void {
    this.ask({ home: true, kind: "list" }, { type: "chatdgc_list", limit: this.homeShown, ...(this.homeQuery ? { query: this.homeQuery } : {}) });
  }

  private homeChanged(): void {
    if (this.homeTimer) clearTimeout(this.homeTimer);
    this.homeTimer = setTimeout(() => { this.homeTimer = undefined; this.homeRefresh(); }, 250);
  }

  /** A message from the home's webview, if it is ChatDGC's. */
  async homeMessage(message: any): Promise<boolean> {
    switch (message?.type) {
      case "chatdgcOpen":
        this.open(String(message.id || ""));
        return true;
      case "chatdgcNew":
        this.open("", message.temporary === true);
        return true;
      case "chatdgcSearch":
        this.homeQuery = String(message.query || "").slice(0, 200);
        this.homeShown = this.homeQuery ? HOME_PAGE : HOME_FIRST;
        this.homeRefresh();
        return true;
      case "chatdgcMore":
        this.homeShown = Math.min(200, this.homeShown + HOME_PAGE);
        this.homeRefresh();
        return true;
      case "chatdgcDelete": {
        const id = String(message.id || "");
        if (!CONVERSATION_ID.test(id)) return true;
        if (!(await this.confirmDelete(String(message.title || "")))) return true;
        for (const tab of [...this.tabs]) { if (tab.conversation === id) tab.panel.dispose(); }
        this.ask({ kind: "update" }, { type: "chatdgc_update", conversation_id: id, delete: true });
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    if (this.homeTimer) clearTimeout(this.homeTimer);
    this.tabs.clear();
    this.requests.clear();
  }
}
