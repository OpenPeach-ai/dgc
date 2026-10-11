import * as vscode from "vscode";
import { mkdirSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

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
export const CHATDGC_LIBRARY = "dgc.chatdgcLibrary";
const LIBRARY_KINDS = new Set(["image", "pdf", "document", "spreadsheet", "presentation", "code", "text"]);
const ATTACHMENT_ID = /^att_[a-f0-9]{32}$/;
const CONVERSATION_ID = /^chat_[a-f0-9]{32}$/;
const MESSAGE_ID = /^msg_[a-f0-9]{32}$/;
const PROJECT_ID = /^proj_[a-f0-9]{32}$/;
const PROJECT_COLORS = ["purple", "blue", "teal", "green", "yellow", "orange", "red", "pink", "gray"];
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
  /** Settings at a section (Memory, from "Manage memory" under a reply). */
  openSettings?(section: string): void;
}

interface Tab {
  panel: vscode.WebviewPanel;
  conversation: string;
  temporary: boolean;
  summary?: any;
  /** Commands held while the process starts. */
  held: Record<string, unknown>[];
  opened: boolean;
  /** A project's page (a new chat in that project, as ChatGPT's project page is), until it's sent. */
  project?: string;
  /** Files this tab's picker returned: the only paths a send may name, so a page can never have the
   *  backend read a file the user didn't choose. */
  picked: Set<string>;
  /** Library files chosen for this tab ("<chat or project>/<file>"), the only ones a send may copy. */
  pickedLibrary?: Set<string>;
  /** A Library file to attach once the tab has its chat (Use in a new chat). */
  waitingAttach?: Record<string, unknown>[];
}

type Asker = { tab?: Tab; home?: boolean; kind: string; project?: string; libraryPanel?: vscode.WebviewPanel; path?: string };

export function chatTitle(text: string): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "New chat";
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1).trimEnd()}…` : flat;
}

const attr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function chatdgcDocument(asset: (name: string) => string, cspSource: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data: https://www.google.com https://*.gstatic.com; font-src ${attr(cspSource)}; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};">
<link rel="stylesheet" href="${attr(asset("media/codicon.css"))}"><link rel="stylesheet" href="${attr(asset("media/main.css"))}"><link rel="stylesheet" href="${attr(asset("media/chatdgc.css"))}">
<title>ChatDGC</title></head><body class="cd-blank">
<header class="cd-head"><button type="button" id="cd-crumb" class="cd-crumb" hidden></button><h1 id="cd-title" class="cd-title">New chat</h1><span id="cd-temp-badge" class="cd-badge" hidden>Temporary</span>
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
<button type="button" id="cd-websearch" class="cd-tool" aria-pressed="false" title="Search the web for this message. Without it, ChatDGC still searches whenever an answer depends on it"><span class="codicon codicon-globe" aria-hidden="true"></span><span>Search</span></button>
<button type="button" id="cd-research" class="cd-tool" aria-pressed="false" title="Deep research: a plan to check, then many sources read, then a report with checked citations"><span class="codicon codicon-telescope" aria-hidden="true"></span><span>Deep research</span></button>
<button type="button" id="cd-study" class="cd-tool" aria-pressed="false" title="Study: it teaches you step by step, asks you questions and quizzes you, instead of handing over answers. It stays on in this chat until you turn it off"><span class="codicon codicon-mortar-board" aria-hidden="true"></span><span>Study</span></button>
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

/** The Library (ChatGPT's): every file attached in ChatDGC, in its own tab. */
export function libraryDocument(asset: (name: string) => string, cspSource: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; font-src ${attr(cspSource)}; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};">
<link rel="stylesheet" href="${attr(asset("media/codicon.css"))}"><link rel="stylesheet" href="${attr(asset("media/main.css"))}"><link rel="stylesheet" href="${attr(asset("media/chatdgc.css"))}">
<title>Library</title></head><body class="lib-body">
<main class="lib"><header class="lib-head"><h1 class="lib-title"><span class="codicon codicon-library" aria-hidden="true"></span>Library</h1>
<label class="sr-only" for="lib-search">Search your files by name</label><input id="lib-search" class="cd-field lib-search" type="search" placeholder="Search files" maxlength="200" autocomplete="off"></header>
<p class="lib-about">Every file you attached in ChatDGC or it made for you, in every chat and project. Temporary chats keep none.</p>
<div id="lib-origins" class="lib-kinds" role="toolbar" aria-label="Show files" hidden></div>
<div id="lib-kinds" class="lib-kinds" role="toolbar" aria-label="Show"></div>
<p id="lib-status" class="lib-status" role="status"></p>
<ul id="lib-list" class="lib-list" aria-label="Your files"></ul>
<button type="button" id="lib-more" class="cd-edit-cancel lib-more" hidden>Show more</button></main>
<script src="${attr(asset("media/library.js"))}"></script></body></html>`;
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

  private library?: vscode.WebviewPanel;

  /** The Library, in a tab of its own (one at a time). */
  openLibrary(): void {
    // Shown again, it asks again: a file attached or made since is there (it keeps its filters).
    if (this.library) { this.library.reveal(); void this.library.webview.postMessage({ type: "refresh" }); return; }
    const panel = vscode.window.createWebviewPanel(CHATDGC_LIBRARY, "Library", vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] });
    panel.iconPath = { light: vscode.Uri.joinPath(this.context.extensionUri, "media", "dgc-tab-light.svg"),
                       dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "dgc-tab-dark.svg") };
    this.library = panel;
    panel.onDidDispose(() => { if (this.library === panel) this.library = undefined; });
    panel.webview.onDidReceiveMessage((message) => { void this.fromLibrary(panel, message); });
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...name.split("/"))).toString();
    panel.webview.html = libraryDocument(asset, panel.webview.cspSource);
  }

  /** A file as the Library names it: which chat or project it's in, and its id (nothing the page made up). */
  private libraryRef(file: any): Record<string, string> | undefined {
    const id = String(file?.id || "");
    if (!ATTACHMENT_ID.test(id)) return undefined;
    if (file?.source === "project" && PROJECT_ID.test(String(file.project_id || ""))) return { project_id: String(file.project_id), attachment_id: id };
    if (CONVERSATION_ID.test(String(file?.chat_id || ""))) return { conversation_id: String(file.chat_id), attachment_id: id };
    return undefined;
  }

  private libraryAsk(panel: vscode.WebviewPanel, kind: string, cmd: Record<string, unknown>): void {
    const requestId = this.nextId(kind);
    this.requests.set(requestId, { kind, libraryPanel: panel } as Asker);
    this.deliver({ kind }, { ...cmd, request_id: requestId });
  }

  /** A made file, written where DGC opens files: in its own app, or a Markdown or CSV file in an editor tab. */
  private async openMade(path: string): Promise<void> {
    const uri = vscode.Uri.file(path);
    try {
      if (/\.(md|csv)$/i.test(path)) { await vscode.window.showTextDocument(uri, { preview: false }); return; }
      if (await vscode.env.openExternal(uri)) return;
    } catch { /* said below */ }
    void vscode.window.showWarningMessage(`${path.split(/[\\/]/).pop()} couldn't be opened here. Use Save a copy… to keep it.`);
  }

  private async fromLibrary(panel: vscode.WebviewPanel, message: any): Promise<void> {
    const ref = this.libraryRef(message?.file);
    switch (message?.type) {
      case "ready":
      case "list": {
        const kind = LIBRARY_KINDS.has(String(message.kind)) ? String(message.kind) : "";
        const offset = Number.isInteger(message.offset) && message.offset >= 0 ? message.offset : 0;
        const origin = message.origin === "made" || message.origin === "uploaded" ? message.origin : "";
        this.libraryAsk(panel, "library", { type: "chatdgc_library", ...(typeof message.query === "string" && message.query.trim()
          ? { query: message.query.slice(0, 200) } : {}), ...(kind ? { kind } : {}), ...(origin ? { origin } : {}), limit: 60, offset });
        return;
      }
      case "image":
        if (ref?.conversation_id) this.libraryAsk(panel, "libraryImage", { type: "chatdgc_file", conversation_id: ref.conversation_id, attachment_id: ref.attachment_id });
        return;
      case "open":
        if (ref?.project_id) this.openProject(ref.project_id); else if (ref?.conversation_id) this.open(ref.conversation_id);
        return;
      case "use": {
        // Use in a new chat: a new chat's tab, with the file attached and waiting for what you'll ask.
        if (!ref) return;
        const before = new Set(this.tabs);
        this.open("");
        const tab = [...this.tabs].find((t) => !before.has(t));
        if (tab) tab.waitingAttach = [this.libraryItem(message.file, ref)];
        return;
      }
      case "save": {
        if (!ref) return;
        const name = String(message.file?.name || "file").replace(/[\\/:*?"<>|]+/g, " ").trim() || "file";
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, name), saveLabel: "Save", title: "Save a copy of this file" });
        if (!target || target.scheme !== "file") return;
        this.libraryAsk(panel, "librarySave", { type: "chatdgc_library_file", op: "save", ...ref, path: target.fsPath });
        return;
      }
      case "toProject": {
        if (!ref) return;
        const projects = await this.projectList();
        const choice = await vscode.window.showQuickPick(projects.map((p) => ({ label: `$(folder) ${p.name}`, id: p.id })),
          { placeHolder: projects.length ? "Add a copy to a project: every chat in it can read it" : "No projects yet: make one from the side bar" });
        if (!choice) return;
        this.libraryAsk(panel, "libraryChange", { type: "chatdgc_library_file", op: "to_project", ...ref, target_project: choice.id });
        return;
      }
      case "remove": {
        if (!ref) return;
        const DELETE = "Delete";
        const choice = await vscode.window.showWarningMessage(
          `Delete “${chatTitle(String(message.file?.name || "this file"))}” from your Library? The chat it's in keeps its name, marked as no longer available. This can't be undone.`,
          { modal: true }, DELETE);
        if (choice === DELETE) this.libraryAsk(panel, "libraryChange", { type: "chatdgc_library_file", op: "remove", ...ref });
        return;
      }
    }
  }

  /** A Library file as the composer shows it, and what a send says of it. */
  private libraryItem(file: any, ref: Record<string, string>): Record<string, unknown> {
    return { kind: "library", fileKind: String(file?.kind || "document"), name: String(file?.name || "file").slice(0, 120),
             size: Number(file?.size) || 0, chars: Number(file?.chars) || 0, ...ref };
  }

  /** A project's page: its chats, files and instructions, and a box that starts a chat in it. */
  openProject(project: string): void {
    if (!PROJECT_ID.test(project)) return;
    for (const tab of this.tabs) { if (tab.project === project) { tab.panel.reveal(); return; } }
    const panel = vscode.window.createWebviewPanel(CHATDGC_EDITOR, "Project", vscode.ViewColumn.Active, this.options());
    this.adopt(panel, "", false, project);
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

  private adopt(panel: vscode.WebviewPanel, conversation: string, temporary: boolean, project = ""): void {
    panel.iconPath = { light: vscode.Uri.joinPath(this.context.extensionUri, "media", "dgc-tab-light.svg"),
                       dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "dgc-tab-dark.svg") };
    const tab: Tab = { panel, conversation, temporary, held: [], opened: false, picked: new Set(), ...(project ? { project } : {}) };
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
        if (asker?.kind === "projectChats") {
          this.requests.delete(requestId);
          const items = (Array.isArray(ev.chats) ? ev.chats : []).filter((chat: any) => CONVERSATION_ID.test(String(chat?.id || "")));
          if (asker.home) this.host?.postHome({ type: "chatdgc_project_chats", project: asker.project, items, total: Number(ev.total) || 0 });
          else if (asker.tab) this.post(asker.tab, { type: "projectChats", project: asker.project, items, total: Number(ev.total) || 0 });
          return;
        }
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
        if (asker?.kind === "branch") {
          // Branch in new chat: it opens in a tab of its own, as ChatGPT opens one; the chat it came from stays.
          this.requests.delete(requestId);
          const id = String(ev.conversation?.id || "");
          if (CONVERSATION_ID.test(id)) this.open(id);
          this.homeChanged();
          return;
        }
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
        const page = tab.project && !(Array.isArray(ev.messages) && ev.messages.length) && ev.project?.name;
        tab.panel.title = page ? chatTitle(ev.project.name) : chatTitle(ev.conversation?.title);
        const waitingAttach = tab.waitingAttach?.splice(0) || [];
        this.post(tab, { type: "opened", conversation: ev.conversation, messages: ev.messages, earlier: ev.earlier,
                         busy: ev.busy === true, replyId: typeof ev.reply_id === "string" ? ev.reply_id : "",
                         ...(ev.project && typeof ev.project === "object" ? { project: ev.project } : {}) });
        if (waitingAttach.length) this.attachLibrary(tab, waitingAttach);
        this.homeChanged();
        return;
      }
      case "chatdgc_library": {
        if (asker) this.requests.delete(requestId);
        if (asker?.kind === "libraryRecent") { this.recentWaiting.shift()?.(Array.isArray(ev.files) ? ev.files : []); return; }
        void asker?.libraryPanel?.webview.postMessage({ type: "library", files: Array.isArray(ev.files) ? ev.files : [], total: Number(ev.total) || 0,
          next: ev.next_offset ?? null, counts: ev.counts && typeof ev.counts === "object" ? ev.counts : {},
          origins: ev.origins && typeof ev.origins === "object" ? ev.origins : {} });
        return;
      }
      case "chatdgc_library_file": {
        if (asker) this.requests.delete(requestId);
        if (asker?.kind === "fileOpen" && typeof ev.path === "string" && ev.path === asker.path) { void this.openMade(ev.path); return; }
        if (ev.op === "save" && typeof ev.path === "string") {
          void vscode.window.showInformationMessage(`Saved ${ev.path.split(/[\\/]/).pop()}.`);
        } else void asker?.libraryPanel?.webview.postMessage({ type: "changed" });
        return;
      }
      case "chatdgc_projects": {
        // Asked for, or broadcast after any change: the home's list and every tab (a project's page, a chat's
        // header) show them as they are now.
        if (asker) this.requests.delete(requestId);
        const projects = (Array.isArray(ev.projects) ? ev.projects : []).filter((p: any) => PROJECT_ID.test(String(p?.id || "")));
        if (asker?.kind === "projectsFor") { this.projectsWaiting.shift()?.(projects); return; }
        if (!asker || asker.home) this.host?.postHome({ type: "chatdgc_projects", projects });
        for (const tab of asker?.tab ? [asker.tab] : asker ? [] : [...this.tabs]) this.post(tab, { type: "projects", projects });
        return;
      }
      case "chatdgc_project": {
        if (asker) this.requests.delete(requestId);
        const id = String(ev.project?.id || "");
        const waiting = this.createWaiting.get(requestId);
        if (waiting) { this.createWaiting.delete(requestId); waiting(PROJECT_ID.test(id) ? id : ""); return; }
        if (asker?.kind === "projectCreate" && PROJECT_ID.test(id)) this.openProject(id);
        if (asker?.tab) this.post(asker.tab, { type: "projectSaved", project: ev.project ?? null });
        if (Array.isArray(ev.deleted) || ev.project === null) {
          // A deleted project: its page closes, and so does every tab on a chat that went with it.
          const gone = new Set((Array.isArray(ev.deleted) ? ev.deleted : []).map(String));
          for (const tab of [...this.tabs]) {
            if ((tab.project && tab.project === asker?.project) || gone.has(tab.conversation)) tab.panel.dispose();
          }
        }
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
      case "chatdgc_images":
        for (const tab of showing(conversation)) this.post(tab, { type: "images", messageId: ev.message_id, images: ev.images });
        return;
      case "chatdgc_made":
        // A file the reply made: its card shows under the reply in every tab on the chat.
        if (ev.file && typeof ev.file === "object") for (const tab of showing(conversation)) this.post(tab, { type: "made", messageId: ev.message_id, file: ev.file });
        return;
      case "chatdgc_followups":
        if (Array.isArray(ev.followups)) {
          const followups = ev.followups.filter((f: unknown) => typeof f === "string").slice(0, 3);
          for (const tab of showing(conversation)) this.post(tab, { type: "followups", messageId: ev.message_id, followups });
        }
        return;
      case "chatdgc_action":
        // A plugin's card under a reply, as it's put there or decided: every tab on the chat shows it.
        if (asker) this.requests.delete(requestId);
        if (ev.action && typeof ev.action === "object") {
          for (const tab of showing(conversation)) this.post(tab, { type: "action", messageId: ev.message_id, action: ev.action });
        }
        return;
      case "chatdgc_pips": {
        if (asker) this.requests.delete(requestId);
        const pips = (Array.isArray(ev.pips) ? ev.pips : []).filter((p: any) => /^pip_[a-f0-9]{32}$/.test(String(p?.id || "")));
        this.pipsWaiting.shift()?.({ pips, error: typeof ev.error === "string" ? ev.error : "" });
        return;
      }
      case "chatdgc_research": {
        const research = ev.research && typeof ev.research === "object" ? ev.research : {};
        const tabs = showing(conversation);
        for (const tab of tabs) this.post(tab, { type: "research", messageId: ev.message_id, research });
        // Research takes minutes: when it ends out of sight, say so, as ChatGPT does.
        if ((research.status === "done" || research.status === "failed") && !tabs.some((tab) => tab.panel.visible)) {
          const title = String(research.plan?.title || "your research").slice(0, 120);
          const said = research.status === "done" ? `Deep research finished: ${title}` : `Deep research didn't finish: ${title}`;
          void vscode.window.showInformationMessage(said, "Open").then((open) => { if (open) this.open(conversation); });
        }
        return;
      }
      case "chatdgc_file":
        if (asker?.libraryPanel) {
          this.requests.delete(requestId);
          void asker.libraryPanel.webview.postMessage({ type: "image", id: String(ev.attachment_id || ""),
            ...(typeof ev.data === "string" ? { data: ev.data } : { error: String(ev.error || "") }) });
          return;
        }
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
        const waiting = this.createWaiting.get(requestId);
        if (waiting) { this.createWaiting.delete(requestId); waiting(""); }
        if (asker?.libraryPanel) { void asker.libraryPanel.webview.postMessage({ type: "error", message }); return; }
        if (asker?.kind === "libraryRecent") { this.recentWaiting.shift()?.([]); return; }
        if (asker && !asker.tab && asker.kind !== "list") { void vscode.window.showErrorMessage(message); return; }
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
                                          ...(!conversation && tab.temporary ? { temporary: true } : {}),
                                          ...(!conversation && tab.project ? { project: tab.project } : {}) });
        this.ask({ tab, kind: "projects" }, { type: "chatdgc_projects" });
        void this.models(tab);
        // A source's favicon, as Work's panel shows one: Google's icon service, asked about the origin only.
        // dgc.linkFavicons off: no request leaves for an icon.
        let favicons = true;
        try { favicons = vscode.workspace.getConfiguration("dgc").get<boolean>("linkFavicons", true) !== false; } catch { /* default */ }
        this.post(tab, { type: "favicons", on: favicons });
        return;
      }
      case "reopenNew":                      // the chat it held is gone (a temporary one after a restart)
      case "newChat":
        tab.conversation = "";
        tab.summary = undefined;
        tab.temporary = message.temporary === true;
        tab.project = undefined;
        tab.panel.title = "New chat";
        this.ask({ tab, kind: "open" }, { type: "chatdgc_open", ...(tab.temporary ? { temporary: true } : {}) });
        this.homeChanged();
        return;
      case "attach": {
        // Your recent files from the Library first, as ChatGPT's paperclip lists them; with none, the picker.
        const recent = await this.recentFiles();
        if (recent.length) {
          type Pick = vscode.QuickPickItem & { file?: any };
          const UPLOAD: Pick = { label: "$(cloud-upload) Upload files…", description: "from this computer" };
          const picks: Pick[] = [UPLOAD, { label: "Recent files in your Library", kind: vscode.QuickPickItemKind?.Separator ?? -1 } as Pick,
            ...recent.map((file) => ({ label: `$(${file.kind === "image" ? "file-media" : "file"}) ${String(file.name || "file")}`,
                                       description: String(file.source === "project" ? file.project_name || "" : file.chat_title || ""), file }))];
          const chosen = await vscode.window.showQuickPick(picks, { placeHolder: "Attach a file", canPickMany: false });
          if (!chosen) return;
          if (chosen !== UPLOAD) {
            const ref = this.libraryRef(chosen.file);
            if (ref) this.attachLibrary(tab, [this.libraryItem(chosen.file, ref)]);
            return;
          }
        }
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
                                          ...(typeof message.study === "boolean" ? { study: message.study } : {}),
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
      case "branch": {
        const at = String(message.messageId || "");
        if (conversation && MESSAGE_ID.test(at)) {
          this.ask({ tab, kind: "branch" }, { type: "chatdgc_branch", conversation_id: conversation, message_id: at });
        }
        return;
      }
      case "openChat": {
        // The chat a branch came from (or any chat the screen names): its tab if open, else a new one.
        const id = String(message.id || "");
        if (CONVERSATION_ID.test(id)) this.open(id);
        return;
      }
      case "openProject":
        this.openProject(String(message.id || ""));
        return;
      case "fileOpen":
      case "fileSave": {
        // A file the reply made: saved where you choose, or into a folder of DGC's and opened in its own app (a
        // Markdown or CSV file in an editor tab). The backend writes it, as it saves a Library file.
        const fileId = String(message.fileId || "");
        if (!conversation || !/^att_[a-f0-9]{32}$/.test(fileId)) return;
        const name = String(message.name || "file").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").trim().slice(0, 120) || "file";
        const ref = { type: "chatdgc_library_file", op: "save", conversation_id: conversation, attachment_id: fileId };
        if (message.type === "fileSave") {
          const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
          const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, name), saveLabel: "Save", title: "Save a copy of this file" });
          if (!target || target.scheme !== "file") return;
          this.ask({ tab, kind: "fileSave" }, { ...ref, path: target.fsPath });
          return;
        }
        const dir = join(tmpdir(), "dgc-chatdgc-files", fileId);
        try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return; }
        const path = join(dir, name);
        this.ask({ tab, kind: "fileOpen", path }, { ...ref, path });
        return;
      }
      case "actionRun":
      case "actionDismiss":
      case "actionHand": {
        // A card's choice: only ids go to the backend, and edited inputs as one JSON object.
        const messageId = String(message.messageId || ""), actionId = String(message.actionId || "");
        if (!conversation || !MESSAGE_ID.test(messageId) || !/^act_[a-f0-9]{32}$/.test(actionId)) return;
        const base = { type: "chatdgc_action", conversation_id: conversation, message_id: messageId, action_id: actionId };
        if (message.type === "actionDismiss") { this.ask({ tab, kind: "action" }, { ...base, op: "dismiss" }); return; }
        if (message.type === "actionRun") {
          const edited = message.arguments && typeof message.arguments === "object" && !Array.isArray(message.arguments)
            && JSON.stringify(message.arguments).length <= 10_000 ? { arguments: message.arguments } : {};
          this.ask({ tab, kind: "action" }, { ...base, op: "run", ...edited });
          return;
        }
        const { pips, error } = await this.personalPips();
        if (!pips.length) {
          this.post(tab, { type: "actionIdle", actionId });
          void vscode.window.showInformationMessage(error || "You have no Personal Pips yet. Make one in Pips, then hand this to it.");
          return;
        }
        const choice = await vscode.window.showQuickPick(pips.map((p: any) => ({ label: `$(hubot) ${String(p.name || "Pip")}`,
          description: String(p.goal || "").slice(0, 80), id: String(p.id) })), { placeHolder: "Hand this to one of your Pips" });
        if (!choice) { this.post(tab, { type: "actionIdle", actionId }); return; }
        this.ask({ tab, kind: "action" }, { ...base, op: "hand", pip_id: choice.id });
        return;
      }
      case "projectChats": {
        const project = String(message.id || "");
        if (PROJECT_ID.test(project)) {
          this.ask({ tab, kind: "projectChats", project }, { type: "chatdgc_list", project, limit: 50 });
        }
        return;
      }
      case "projectSave": {
        const project = String(message.id || "");
        if (!PROJECT_ID.test(project)) return;
        const fields: Record<string, unknown> = {};
        if (typeof message.name === "string") fields.name = message.name.slice(0, 200);
        if (PROJECT_COLORS.includes(String(message.color))) fields.color = message.color;
        if (typeof message.instructions === "string") fields.instructions = message.instructions.slice(0, 20_000);
        if (message.memory === "shared" || message.memory === "project") fields.memory = message.memory;
        this.ask({ tab, kind: "projectSave", project }, { type: "chatdgc_project", op: "update", project_id: project, ...fields });
        return;
      }
      case "projectAddFiles": {
        // Picked here, sent from here: a page never names a file for the backend to read.
        const project = String(message.id || "");
        if (!PROJECT_ID.test(project)) return;
        const chosen = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Add to project",
          title: "Add files to this project: every chat in it can read them" });
        const items = (chosen || []).filter((uri) => uri.scheme === "file").slice(0, MAX_ATTACHMENTS)
          .map((uri) => ({ kind: "file", path: uri.fsPath }));
        if (items.length) {
          this.ask({ tab, kind: "projectFiles", project }, { type: "chatdgc_project", op: "add_files", project_id: project, attachments: items });
        }
        return;
      }
      case "projectRemoveFile": {
        const project = String(message.id || ""), file = String(message.fileId || "");
        if (PROJECT_ID.test(project) && /^att_[a-f0-9]{32}$/.test(file)) {
          this.ask({ tab, kind: "projectFiles", project }, { type: "chatdgc_project", op: "remove_file", project_id: project, file_id: file });
        }
        return;
      }
      case "projectDelete":
        await this.deleteProject(String(message.id || ""), String(message.name || ""), Number(message.chats) || 0, tab);
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
      case "research": {
        const text = typeof message.text === "string" ? message.text : "";
        const model = typeof message.model === "string" && message.model.length <= 200 ? message.model : "";
        const thinking = typeof message.thinking === "string" && THINKING.has(message.thinking) ? message.thinking : "";
        if (!conversation || !text.trim() || text.length > MAX_TEXT) return;
        this.ask({ tab, kind: "send" }, { type: "chatdgc_research", conversation_id: conversation, text,
                                          ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) });
        return;
      }
      case "researchStart": {
        if (!conversation || !MESSAGE_ID.test(String(message.messageId || ""))) return;
        const plan = message.plan && typeof message.plan === "object" && !Array.isArray(message.plan) ? message.plan : undefined;
        this.ask({ tab, kind: "send" }, { type: "chatdgc_research_start", conversation_id: conversation,
                                          message_id: message.messageId, ...(plan ? { plan } : {}),
                                          ...(message.write === true ? { write: true } : {}) });
        return;
      }
      case "steer": {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (!conversation || !MESSAGE_ID.test(String(message.messageId || "")) || !text || text.length > 1000) return;
        this.ask({ tab, kind: "steer" }, { type: "chatdgc_research_steer", conversation_id: conversation,
                                           message_id: message.messageId, text });
        return;
      }
      case "forgetMemory":
        // "Forget" under a reply that saved a fact: the one memory every DGC surface shares.
        if (typeof message.id === "string" && /^mem_[0-9a-f]{12}$/.test(message.id)) {
          this.ask({ tab, kind: "memory" }, { type: "memory_forget", id: message.id });
        }
        return;
      case "openMemory":
        this.host?.openSettings?.("memory");
        return;
      case "exportReport":
        if (conversation && MESSAGE_ID.test(String(message.messageId || ""))) {
          void this.exportReport(tab, conversation, message.messageId, String(message.title || ""));
        }
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
      } else if (item?.kind === "library" && ATTACHMENT_ID.test(String(item.attachment_id || ""))) {
        const holder: Record<string, string> | undefined = CONVERSATION_ID.test(String(item.conversation_id || ""))
          ? { conversation_id: String(item.conversation_id) }
          : PROJECT_ID.test(String(item.project_id || "")) ? { project_id: String(item.project_id) } : undefined;
        const key = holder ? `${Object.values(holder)[0]}/${item.attachment_id}` : "";
        if (holder && tab.pickedLibrary?.has(key)) out.push({ kind: "library", ...holder, attachment_id: String(item.attachment_id) });
      }
    }
    return inline > MAX_INLINE_CHARS ? undefined : out;
  }

  private recentWaiting: ((files: any[]) => void)[] = [];
  private pipsWaiting: ((answer: { pips: any[]; error: string }) => void)[] = [];

  /** Your Personal Pips, for "Hand it to a Pip" (none, and why, when Pips are off or don't answer). */
  private personalPips(): Promise<{ pips: any[]; error: string }> {
    return new Promise((resolve) => {
      const requestId = this.nextId("pips");
      this.requests.set(requestId, { kind: "pips" });
      this.pipsWaiting.push(resolve);
      const outcome = this.host ? this.host.chatdgcSend({ type: "chatdgc_pips", request_id: requestId }) : "starting";
      if (outcome !== "sent") { this.pipsWaiting.splice(this.pipsWaiting.indexOf(resolve), 1); resolve({ pips: [], error: "" }); return; }
      setTimeout(() => { const i = this.pipsWaiting.indexOf(resolve); if (i >= 0) { this.pipsWaiting.splice(i, 1); resolve({ pips: [], error: "Pips didn't answer." }); } }, 10_000);
    });
  }

  /** The newest files in the Library, for the paperclip ([] if it can't say quickly). */
  private recentFiles(): Promise<any[]> {
    return new Promise((resolve) => {
      const requestId = this.nextId("libraryRecent");
      this.requests.set(requestId, { kind: "libraryRecent" });
      this.recentWaiting.push(resolve);
      const outcome = this.host ? this.host.chatdgcSend({ type: "chatdgc_library", limit: 8, request_id: requestId }) : "starting";
      if (outcome !== "sent") { this.recentWaiting.splice(this.recentWaiting.indexOf(resolve), 1); resolve([]); return; }
      setTimeout(() => { const i = this.recentWaiting.indexOf(resolve); if (i >= 0) { this.recentWaiting.splice(i, 1); resolve([]); } }, 3000);
    });
  }

  /** Library files into a tab's box: shown as chips, and the only Library files its next send may name. */
  private attachLibrary(tab: Tab, items: Record<string, unknown>[]): void {
    tab.pickedLibrary ??= new Set();
    for (const item of items) tab.pickedLibrary.add(`${item.conversation_id || item.project_id}/${item.attachment_id}`);
    this.post(tab, { type: "attached", items });
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

  /** A finished research report as a Markdown file, with its sources and what the citation check found. */
  private async exportReport(tab: Tab, conversation: string, messageId: string, title: string): Promise<void> {
    const name = chatTitle(title).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "report";
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, `${name}.md`),
      filters: { Markdown: ["md"] }, saveLabel: "Export", title: "Export this report" });
    if (!target || target.scheme !== "file") return;
    this.ask({ tab, kind: "export" }, { type: "chatdgc_export", conversation_id: conversation, path: target.fsPath,
                                        format: "report", message_id: messageId });
  }

  private async menu(tab: Tab): Promise<void> {
    const conversation = tab.conversation;
    if (!conversation || tab.temporary) return;      // a new chat that was never sent says so if asked
    const pinned = tab.summary?.pinned === true;
    const picks = [
      { label: "$(edit) Rename", id: "rename" },
      { label: pinned ? "$(pinned) Unpin" : "$(pin) Pin", id: "pin" },
      { label: "$(archive) Archive", id: "archive" },
      { label: "$(folder) Move to project…", id: "move" },
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
    } else if (choice.id === "move") {
      await this.moveToProject(conversation, String(tab.summary?.project || ""), tab);
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

  /** Move to project…: a project, a new one, or out of the one it's in (ChatGPT's "Move to project"). */
  private async moveToProject(conversation: string, current: string, tab?: Tab): Promise<void> {
    const projects = await this.projectList();
    const picks: (vscode.QuickPickItem & { id: string })[] = [
      ...projects.filter((p) => p.id !== current).map((p) => ({ label: `$(folder) ${p.name}`, description: `${p.chats} chat${p.chats === 1 ? "" : "s"}`, id: p.id })),
      { label: "$(new-folder) New project…", id: "new" },
      ...(current ? [{ label: "$(close) Remove from project", description: projects.find((p) => p.id === current)?.name, id: "" }] : []),
    ];
    const choice = await vscode.window.showQuickPick(picks, { placeHolder: "Move this chat to a project" });
    if (!choice) return;
    let target = choice.id;
    if (target === "new") {
      const name = await vscode.window.showInputBox({ prompt: "Name the new project", placeHolder: "Goa trip",
        validateInput: (value) => (value.trim() ? undefined : "Give the project a name.") });
      if (!name) return;
      target = (await this.createProject(name)) || "";
      if (!target) return;
    }
    this.ask({ tab, kind: "move" }, { type: "chatdgc_move", conversation_id: conversation, project_id: target });
  }

  private projectsWaiting: ((projects: any[]) => void)[] = [];
  private createWaiting = new Map<string, (id: string) => void>();

  /** The projects as the backend has them now. */
  private projectList(): Promise<{ id: string; name: string; chats: number }[]> {
    return new Promise((resolve) => {
      const requestId = this.nextId("projects");
      this.requests.set(requestId, { kind: "projectsFor", home: false });
      this.projectsWaiting.push(resolve);
      this.deliver({ kind: "projectsFor" }, { type: "chatdgc_projects", request_id: requestId });
      setTimeout(() => { const i = this.projectsWaiting.indexOf(resolve); if (i >= 0) { this.projectsWaiting.splice(i, 1); resolve([]); } }, 5000);
    });
  }

  /** A new project, its id once the backend has made it ("" if it couldn't). */
  private createProject(name: string): Promise<string> {
    return new Promise((resolve) => {
      const requestId = this.nextId("projectNew");
      this.requests.set(requestId, { kind: "projectNew" });
      this.createWaiting.set(requestId, resolve);
      this.deliver({ kind: "projectNew" }, { type: "chatdgc_project", op: "create", name: name.trim().slice(0, 200), request_id: requestId });
      setTimeout(() => { if (this.createWaiting.delete(requestId)) resolve(""); }, 5000);
    });
  }

  /** Delete a project, as ChatGPT does (its chats with it), or keep its chats as your own. */
  private async deleteProject(project: string, name: string, chats: number, tab?: Tab): Promise<void> {
    if (!PROJECT_ID.test(project)) return;
    const ALL = chats ? `Delete project and ${chats} chat${chats === 1 ? "" : "s"}` : "Delete project";
    const KEEP = "Delete project, keep its chats";
    const choice = await vscode.window.showWarningMessage(
      `Delete the project “${chatTitle(name)}”? Its files and instructions go${chats ? `; its chats too, unless you keep them` : ""}. This can't be undone.`,
      { modal: true }, ALL, ...(chats ? [KEEP] : []));
    if (!choice) return;
    this.ask({ tab, kind: "projectDelete", project }, { type: "chatdgc_project", op: "delete", project_id: project,
                                                        keep_chats: choice === KEEP });
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
    this.ask({ home: true, kind: "projects" }, { type: "chatdgc_projects" });
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
      case "chatdgcProjectOpen":
        this.openProject(String(message.id || ""));
        return true;
      case "chatdgcLibrary":
        this.openLibrary();
        return true;
      case "chatdgcProjectNew": {
        const name = await vscode.window.showInputBox({ prompt: "Name the new project: its chats, files and instructions stay together",
          placeHolder: "Goa trip", validateInput: (value) => (value.trim() ? undefined : "Give the project a name.") });
        if (!name) return true;
        const id = await this.createProject(name);
        if (id) this.openProject(id);
        return true;
      }
      case "chatdgcProjectChats": {
        const project = String(message.id || "");
        if (PROJECT_ID.test(project)) this.ask({ home: true, kind: "projectChats", project }, { type: "chatdgc_list", project, limit: 20 });
        return true;
      }
      case "chatdgcMove": {
        // A chat dragged onto a project in the side bar ("" : dragged back to your chats).
        const id = String(message.id || ""), project = String(message.project || "");
        if (CONVERSATION_ID.test(id) && (!project || PROJECT_ID.test(project))) {
          this.ask({ kind: "move" }, { type: "chatdgc_move", conversation_id: id, project_id: project });
        }
        return true;
      }
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
