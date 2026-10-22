import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { ChatPlaces, ChatTabInit, DgcViewProvider } from "./panel";
import { tabIcon } from "./tabIcon";

/** The editor-tab chat (#3 Sessions home). One tab is one session, with a `dgc serve` of its own. */
export const CHAT_EDITOR = "dgc.chatEditor";
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TAB_KEY = /^[a-f0-9]{16}$/;
const TITLE_CHARS = 40;

interface Tab { key: string; panel: vscode.WebviewPanel; provider: DgcViewProvider; seq: number; }

/** What the chat needs of a view, made out of an editor tab: the same webview, its visibility,
 *  its end, and `show` as a reveal. */
function viewOf(panel: vscode.WebviewPanel): vscode.WebviewView {
  const visibility = new vscode.EventEmitter<void>();
  panel.onDidChangeViewState(() => visibility.fire());
  panel.onDidDispose(() => visibility.dispose());
  return {
    viewType: CHAT_EDITOR,
    webview: panel.webview,
    get visible() { return panel.visible; },
    get title() { return panel.title; },
    set title(value: string | undefined) { if (value) panel.title = value; },
    description: undefined,
    badge: undefined,
    onDidChangeVisibility: visibility.event,
    onDidDispose: panel.onDidDispose,
    show: (preserveFocus?: boolean) => panel.reveal(undefined, preserveFocus),
  } as unknown as vscode.WebviewView;
}

/** A tab's name: its session's name, else its first prompt, else "New session". */
export function tabTitle(text: string): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "New session";
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1).trimEnd()}…` : flat;
}

export class SessionTabs implements ChatPlaces, vscode.WebviewPanelSerializer, vscode.Disposable {
  private readonly tabs = new Map<string, Tab>();
  private seq = 0;
  private closing = false;

  constructor(private readonly context: vscode.ExtensionContext,
              private readonly sidebar: DgcViewProvider,
              private readonly make: (init: ChatTabInit) => DgcViewProvider) {}

  register(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(CHAT_EDITOR, this);
  }

  /** The tab the user last worked in, while it is open: palette commands and the status bar follow it. */
  current(): DgcViewProvider | undefined {
    let best: Tab | undefined;
    for (const tab of this.tabs.values()) if (!best || tab.seq > best.seq) best = tab;
    return best?.provider;
  }

  /** Every tab's chat: window-wide changes (settings, the CLI's path, folders) reach each one. */
  all(): DgcViewProvider[] {
    return [...this.tabs.values()].map((tab) => tab.provider);
  }

  openSessions(): Set<string> {
    const ids = new Set<string>();
    for (const tab of this.tabs.values()) { const id = tab.provider.sessionId(); if (id) ids.add(id); }
    return ids;
  }

  /** A saved session in a tab of its own, or the tab it is already in. "" opens a new session. */
  open(session: string, title = ""): DgcViewProvider {
    const id = SESSION_ID.test(session) ? session : "";
    if (id) {
      for (const tab of this.tabs.values()) {
        if (tab.provider.sessionId() === id) { tab.panel.reveal(); return tab.provider; }
      }
    }
    const panel = vscode.window.createWebviewPanel(CHAT_EDITOR, tabTitle(title), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    return this.adopt(panel, randomBytes(8).toString("hex"), id);
  }

  /** VS Code restoring a tab after a reload: the webview kept its key and session in its state. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any): Promise<void> {
    const key = TAB_KEY.test(String(state?.chatTab?.key || "")) ? state.chatTab.key : randomBytes(8).toString("hex");
    const session = SESSION_ID.test(String(state?.chatTab?.session || "")) ? state.chatTab.session : "";
    if ([...this.tabs.values()].some((tab) => tab.key === key || (session && tab.provider.sessionId() === session))) {
      panel.dispose();                       // a second copy of a tab already open: one session, one tab
      return;
    }
    this.adopt(panel, key, session);
  }

  private adopt(panel: vscode.WebviewPanel, key: string, session: string): DgcViewProvider {
    // Not the activity bar's dgc.svg: its currentColor is black in a tab, invisible on a dark theme. Inline, so a
    // reload draws it before the tab is revived (tabIcon.ts).
    panel.iconPath = tabIcon(this.context.extensionUri, "dgc-tab");
    const provider = this.make({
      key, session, places: this, host: this.sidebar,
      title: (text) => { if (this.tabs.get(key)?.panel === panel) panel.title = tabTitle(text); },
    });
    const tab: Tab = { key, panel, provider, seq: ++this.seq };
    this.tabs.set(key, tab);
    panel.onDidChangeViewState(() => {
      if (panel.active && tab.seq !== this.seq) { tab.seq = ++this.seq; this.changedCurrent(); }
    });
    panel.onDidDispose(() => {
      if (this.tabs.get(key) !== tab) return;
      this.tabs.delete(key);
      // Closed by the user (not a reload or a closed window): a turn still running is asked about.
      provider.dispose(!this.closing);
      if (!this.closing) provider.forgetTab();     // closed by the user: its state goes with it
      this.changedCurrent();
      this.changed();
    });
    provider.resolveWebviewView(viewOf(panel));
    this.changedCurrent();
    this.changed();
    return provider;
  }

  /** The status bar describes the chat palette commands act on. */
  private changedCurrent(): void {
    (this.current() ?? this.sidebar).paintStatusBar();
  }

  /** A tab's session changed, opened or closed: the side bar's list marks which are open. */
  changed(): void {
    this.sidebar.sessionsChanged();
  }

  /** The window is closing: stop every tab's backend, and keep what a reload restores. */
  dispose(): void {
    this.closing = true;
    for (const tab of [...this.tabs.values()]) { try { tab.provider.dispose(); } catch { /* already gone */ } }
    this.tabs.clear();
  }
}
