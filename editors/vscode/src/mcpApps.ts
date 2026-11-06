import * as vscode from "vscode";
import { randomBytes } from "crypto";

/** The extension host's side of a plugin's card (MCP Apps, media/mcpApps.js): what a card asks of its server goes on
 *  to the backend that showed it (mcp_app_call / mcp_app_answer / mcp_app_context / mcp_app_get), and its answers come
 *  back to the page that asked; what a card asks of the editor is done here -- a link opens in the browser (asking
 *  first for a site the card didn't declare), a download goes through a save dialog, and a card that asks for the
 *  whole window opens in an editor tab of its own. */

type Post = (message: any) => void;
type Send = (command: any) => boolean | void;
const CARD_ID = /^app_[0-9a-f]{24}$/;
const REQUEST_ID = /^mcpapp-[a-z]+-[0-9a-z]+-[0-9a-z]+$/;
const ASK_ID = /^ask_[0-9a-f]{24}$/;
const CARD_URL = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\/card\/app_[0-9a-f]{24}\?t=[A-Za-z0-9_-]+$/;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const TAB_VIEW = "dgc.mcpAppCard";

/** A site the card named (its declared domains and its plugin's own site): `*.x` is x and its subdomains. */
export function declaredHost(url: string, hosts: unknown): boolean {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return (Array.isArray(hosts) ? hosts : []).some((pattern) => {
    const p = String(pattern || "").toLowerCase();
    if (!p) return false;
    if (p.startsWith("*.")) { const base = p.slice(2); return host === base || host.endsWith("." + base); }
    return host === p;
  });
}

/** A download's file name, from the last part of its address: no folders, no hidden name, nothing a shell would read. */
export function downloadName(uri: unknown, fallback = "download"): string {
  const last = String(uri || "").split(/[\\/]/).pop() || "";
  let name = last;
  try { name = decodeURIComponent(last); } catch { /* as it is */ }
  name = name.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  return name || fallback;
}

const attr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** A card in an editor tab of its own: the page, the same bridge, the whole window. */
export function cardTabDocument(card: any, scriptUri: string, styleUri: string, codiconUri: string, cspSource: string, nonce: string): string {
  const { html: _page, ...shown } = card || {};
  const data = JSON.stringify(shown).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${attr(cspSource)} 'unsafe-inline'; font-src ${attr(cspSource)}; img-src ${attr(cspSource)} data:; script-src 'nonce-${nonce}'; frame-src http://127.0.0.1:* http://localhost:*;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${attr(codiconUri)}"><link rel="stylesheet" href="${attr(styleUri)}">
<style>html,body{height:100%;margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}#root{box-sizing:border-box;height:100%;padding:10px 14px 14px}</style>
</head><body><div id="root"></div>
<script nonce="${nonce}" src="${attr(scriptUri)}"></script>
<script nonce="${nonce}">(() => {
  const vscode = acquireVsCodeApi();
  const card = ${data};
  DgcMcpApps.setup({ post: (m) => vscode.postMessage(m), surface: card.surface || "work" });
  window.addEventListener("message", (e) => {
    const m = e.data || {};          // the card's own messages never get here (media/mcpApps.js stops them first)
    if (m.type === "event") DgcMcpApps.event(m.event); else DgcMcpApps.host(m);
  });
  document.getElementById("root").append(DgcMcpApps.card(card, { display: "fullscreen",
    sendMessage: (text) => { vscode.postMessage({ type: "mcpApp", op: "send", card_id: card.card_id, text }); return true; } }));
})();</script></body></html>`;
}

export class McpAppsHost implements vscode.Disposable {
  /** Our request ids -> the page that asked. */
  private asked = new Map<string, Post>();
  /** Card id -> the pages that show it (the page a tab came from first). */
  private shown = new Map<string, Set<Post>>();
  private tabs = new Map<string, vscode.WebviewPanel>();
  private origins = new Map<string, string>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** One of the page's {type: "mcpApp"} messages. `send` reaches the backend that showed this page's cards. */
  fromPage(msg: any, post: Post, send: Send): void {
    const op = String(msg?.op || "");
    const cardId = String(msg?.card_id || "");
    if (!CARD_ID.test(cardId)) return;
    this.see(cardId, post);
    switch (op) {
      case "call": {
        const requestId = String(msg.request_id || "");
        if (!REQUEST_ID.test(requestId) || !["tools/call", "resources/read"].includes(msg.method)) return;
        this.remember(requestId, post);
        const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : {};
        const sent = send({ type: "mcp_app_call", request_id: requestId, card_id: cardId, method: msg.method, params });
        if (sent === false) post({ type: "event", event: { type: "mcp_app_reply", card_id: cardId, request_id: requestId,
                                                             error: { code: -32000, message: "DGC isn't running in this window." } } });
        return;
      }
      case "get": {
        const requestId = String(msg.request_id || "");
        if (!REQUEST_ID.test(requestId)) return;
        this.remember(requestId, post);
        send({ type: "mcp_app_get", request_id: requestId, card_id: cardId });
        return;
      }
      case "answer": {
        const askId = String(msg.ask_id || "");
        const requestId = String(msg.request_id || "");
        if (!ASK_ID.test(askId) || !["once", "always", "deny"].includes(msg.choice)) return;
        send({ type: "mcp_app_answer", ask_id: askId, choice: msg.choice, ...(REQUEST_ID.test(requestId) ? { request_id: requestId } : {}) });
        return;
      }
      case "context":
        send({ type: "mcp_app_context", card_id: cardId,
               content: Array.isArray(msg.content) ? msg.content.slice(0, 32) : [],
               structured_content: msg.structured_content && typeof msg.structured_content === "object" && !Array.isArray(msg.structured_content)
                 ? msg.structured_content : {} });
        return;
      case "url": void this.address(msg, post); return;
      case "link": void this.link(msg, post); return;
      case "download": void this.download(msg, post); return;
      case "tab": this.openTab(msg.card, post, send); return;
      case "closeTab": this.tabs.get(cardId)?.dispose(); return;
      case "send": {
        // A card in its own tab asked to send a message: the chat it came from sends it.
        const text = typeof msg.text === "string" ? msg.text.slice(0, 9000) : "";
        const pages = [...(this.shown.get(cardId) || [])].filter((p) => p !== post);
        if (text && pages[0]) pages[0]({ type: "mcpAppSend", card_id: cardId, text });
        return;
      }
    }
  }

  /** mcp_app_reply / mcp_app_resource: to the page that asked. True when it was a card's. */
  onEvent(ev: any): boolean {
    const type = String(ev?.type || "");
    if (!["mcp_app_reply", "mcp_app_resource"].includes(type)) return false;
    const requestId = String(ev.request_id || "");
    const post = this.asked.get(requestId);
    // An Allow card first: its outcome comes as a second reply to the same request.
    if (!(type === "mcp_app_reply" && ev.ask)) this.asked.delete(requestId);
    const targets = post ? [post] : [...(this.shown.get(String(ev.card_id || "")) || [])];
    for (const target of targets) target({ type: "event", event: ev });
    return true;
  }

  private see(cardId: string, post: Post): void {
    let pages = this.shown.get(cardId);
    if (!pages) { pages = new Set(); this.shown.set(cardId, pages); }
    pages.add(post);
    if (this.shown.size > 512) this.shown.delete(this.shown.keys().next().value!);
  }

  private remember(requestId: string, post: Post): void {
    this.asked.set(requestId, post);
    if (this.asked.size > 512) this.asked.delete(this.asked.keys().next().value!);
  }

  /** The address the page reaches the card's server at: forwarded for a remote window (SSH, WSL, a container). */
  private async address(msg: any, post: Post): Promise<void> {
    const url = String(msg.url || "");
    let shown = "";
    if (CARD_URL.test(url)) {
      shown = url;
      if (vscode.env?.remoteName) {
        const origin = new URL(url).origin;
        let mapped = this.origins.get(origin);
        if (!mapped) {
          try { mapped = (await vscode.env.asExternalUri(vscode.Uri.parse(origin + "/", true))).toString(true).replace(/\/$/, ""); }
          catch { mapped = origin; }
          this.origins.set(origin, mapped);
        }
        const forwarded = mapped + url.slice(origin.length);
        if (/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(forwarded)) shown = forwarded;
      }
    }
    post({ type: "mcpAppDone", id: msg.id, url: shown });
  }

  private async link(msg: any, post: Post): Promise<void> {
    const url = String(msg.url || "");
    let ok = false;
    try {
      const parsed = new URL(url);
      if (["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password) {
        const plugin = String(msg.plugin || "This plugin").slice(0, 80);
        let go = declaredHost(url, msg.hosts);
        if (!go) {
          const choice = await vscode.window.showWarningMessage(
            `${plugin}'s card wants to open ${parsed.origin}, a site it didn't say it would use.`,
            { modal: true, detail: url.slice(0, 500) }, "Open");
          go = choice === "Open";
        }
        if (go) ok = await vscode.env.openExternal(vscode.Uri.parse(url, true));
      }
    } catch { ok = false; }
    post({ type: "mcpAppDone", id: msg.id, ok });
  }

  private async download(msg: any, post: Post): Promise<void> {
    let ok = false;
    const plugin = String(msg.plugin || "This plugin").slice(0, 80);
    const item = Array.isArray(msg.contents) ? msg.contents[0] : undefined;
    try {
      if (item?.type === "resource" && item.resource && typeof item.resource === "object") {
        const res = item.resource;
        const bytes = typeof res.text === "string" ? Buffer.from(res.text, "utf8")
          : typeof res.blob === "string" && /^[A-Za-z0-9+/=\s]*$/.test(res.blob) ? Buffer.from(res.blob, "base64") : undefined;
        if (bytes && bytes.length <= MAX_DOWNLOAD_BYTES) {
          const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
          const name = downloadName(res.uri);
          const target = await vscode.window.showSaveDialog({
            title: `Save what ${plugin}'s card made`, saveLabel: "Save",
            ...(folder ? { defaultUri: vscode.Uri.joinPath(folder, name) } : {}) });
          if (target) { await vscode.workspace.fs.writeFile(target, bytes); ok = true; }
        }
      } else if (item?.type === "resource_link" && /^https:\/\//.test(String(item.uri || ""))) {
        const choice = await vscode.window.showWarningMessage(`${plugin}'s card wants to download ${String(item.name || item.uri).slice(0, 120)}.`,
          { modal: true, detail: String(item.uri).slice(0, 500) }, "Open in browser");
        if (choice === "Open in browser") ok = await vscode.env.openExternal(vscode.Uri.parse(String(item.uri), true));
      }
    } catch { ok = false; }
    post({ type: "mcpAppDone", id: msg.id, ok });
  }

  /** The card in an editor tab of its own (the card asked for the whole window, or the user opened it there). */
  private openTab(card: any, from: Post, send: Send): void {
    if (!card || !CARD_ID.test(String(card.card_id || ""))) return;
    const id = String(card.card_id);
    const open = this.tabs.get(id);
    if (open) { open.reveal(); return; }
    const title = `${String(card.plugin || card.server || "Card").slice(0, 40)} · ${String(card.tool_info?.title || card.tool || "").slice(0, 40)}`;
    const panel = vscode.window.createWebviewPanel(TAB_VIEW, title, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", name)).toString();
    panel.webview.html = cardTabDocument(card, asset("mcpApps.js"), asset("mcpApps.css"), asset("codicon.css"),
                                         panel.webview.cspSource, randomBytes(16).toString("base64"));
    const post: Post = (message) => { void panel.webview.postMessage(message); };
    this.tabs.set(id, panel);
    panel.webview.onDidReceiveMessage((msg) => { if (msg?.type === "mcpApp") this.fromPage(msg, post, send); });
    panel.onDidDispose(() => {
      this.tabs.delete(id);
      this.shown.get(id)?.delete(post);
      for (const [key, value] of this.asked) if (value === post) this.asked.delete(key);
    });
    void from;
  }

  dispose(): void {
    for (const panel of this.tabs.values()) panel.dispose();
    this.tabs.clear();
  }
}

let shared: McpAppsHost | undefined;
/** The one host side every page of the window shares (Work, ChatDGC's tabs, Pips, a card's own tab). */
export function mcpAppsHost(extensionUri: vscode.Uri): McpAppsHost {
  if (!shared) shared = new McpAppsHost(extensionUri);
  return shared;
}
