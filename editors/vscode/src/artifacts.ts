// Artifacts in the editor: the one store of everything DGC makes that you keep (dgc/artifact_store), whichever part of
// DGC made it. A chat's card, a Work turn's card and the Library open the same panel; the panel edits a deck, a sheet
// or a dashboard and saves it as the user's own version; a document opens in the canvas editor over its working file.
//
// The process answers every artifact_* command itself (dgc/artifact_commands.py), whichever chat sends it, so they go
// to the side bar's `dgc serve` (as ChatDGC's do) and its replies come back with no chat on them. Nothing here is
// shown unless that process offers ready.capabilities.artifacts.
import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { CANVAS_DOC_VIEW } from "./canvasDoc";
import { tabIcon } from "./tabIcon";

export const ARTIFACT_PANEL = "dgc.artifactPanel";
export const ARTIFACT_PRESENT = "dgc.artifactPresent";
export const ARTIFACT_ID = /^ar_[a-f0-9]{16}$/;
export const ARTIFACT_TYPES = ["page", "doc", "slides", "sheet", "dashboard"];
/** The Output chip's choices, in its menu's order; "auto" lets the model choose (and is never sent). */
export const ARTIFACT_OUTPUTS = ["auto", "document", "slides", "spreadsheet", "page", "dashboard"];
const LABELS: Record<string, string> = { doc: "Document", slides: "Slides", sheet: "Spreadsheet", dashboard: "Dashboard", page: "Page" };
export const FORMAT_LABELS: Record<string, string> = {
  docx: "Word document (.docx)", pdf: "PDF", md: "Markdown (.md)", pptx: "PowerPoint (.pptx)", html: "Web page (.html)",
  xlsx: "Excel workbook (.xlsx)", csv: "CSV (first sheet)", zip: "Zip of its files (.zip)",
};
/** A served page DGC lays out is at most this big (a deck's pictures are inside it). */
const MAX_PAGE_BYTES = 60 * 1024 * 1024;
const MAX_REQUESTS = 256;
/** A save is one command frame (4 MiB, editor_protocol.MAX_COMMAND_BYTES) with room for its envelope. */
const MAX_SAVE_BYTES = 4 * 1024 * 1024 - 64 * 1024;
/** A doc's working file, wherever the store is: `<store>/ar_…/work/<title>.md`. */
const DOC_FILE = /[\\/](ar_[a-f0-9]{16})[\\/]work[\\/][^\\/]+$/;

export type ArtifactsOffer = { version: number; types: string[]; outputs: string[]; exports: Record<string, string[]>; present: boolean; compare?: boolean; sourceConsentVersion?: boolean };
export type ArtifactView = {
  id: string; type: string; label: string; title: string; version: number; created?: string; updated?: string;
  origin?: Record<string, unknown>; exports: string[]; link?: Record<string, unknown>; canvas?: string; file?: string;
  versions?: { n: number; author: string; at: string; summary: string; size?: number }[];
  allowed_sources?: string[];
};

/** ready.capabilities.artifacts, checked; undefined when the process doesn't offer artifacts. */
export function artifactsOffer(capabilities: unknown): ArtifactsOffer | undefined {
  const raw = (capabilities as any)?.artifacts;
  if (!raw || typeof raw !== "object" || !(Number(raw.version) >= 1)) return undefined;
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === "string").slice(0, 32) : []);
  const exports: Record<string, string[]> = {};
  if (raw.exports && typeof raw.exports === "object") {
    for (const [type, formats] of Object.entries(raw.exports)) if (ARTIFACT_TYPES.includes(type)) exports[type] = list(formats);
  }
  return { version: Number(raw.version), types: list(raw.types), outputs: list(raw.outputs), exports, present: Number(raw.present) >= 1,
           ...(Number(raw.compare) >= 1 ? { compare: true } : {}),
           ...(Number(raw.source_consent_version) >= 1 ? { sourceConsentVersion: true } : {}) };
}

/** What a send carries for the Output chip: the choice when it isn't Auto and the process offers it, else "". */
export function outputChoice(value: unknown, offer: ArtifactsOffer | undefined): string {
  const choice = typeof value === "string" ? value : "";
  if (!offer || !choice || choice === "auto" || !ARTIFACT_OUTPUTS.includes(choice)) return "";
  return offer.outputs.length && !offer.outputs.includes(choice) ? "" : choice;
}

/** An artifact as an event carried it, checked: only what the screens use, as the right kinds. */
export function artifactView(raw: any): ArtifactView | undefined {
  if (!raw || typeof raw !== "object" || !ARTIFACT_ID.test(String(raw.id || "")) || !ARTIFACT_TYPES.includes(String(raw.type))) return undefined;
  const text = (v: unknown, n = 200) => (typeof v === "string" ? v.slice(0, n) : "");
  const view: ArtifactView = {
    id: String(raw.id), type: String(raw.type), label: text(raw.label, 40) || LABELS[raw.type], title: text(raw.title, 200) || LABELS[raw.type],
    version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    created: text(raw.created, 40), updated: text(raw.updated, 40),
    origin: raw.origin && typeof raw.origin === "object" ? { ...raw.origin } : {},
    exports: Array.isArray(raw.exports) ? raw.exports.filter((f: unknown) => typeof f === "string" && /^[a-z0-9]{1,8}$/.test(f)).slice(0, 12) : [],
  };
  if (raw.link && typeof raw.link === "object") view.link = { ...raw.link };
  if (typeof raw.canvas === "string") view.canvas = raw.canvas.slice(0, 40);
  if (typeof raw.file === "string" && raw.file.length < 4096) view.file = raw.file;
  if (Array.isArray(raw.versions)) {
    view.versions = raw.versions.filter((v: any) => v && Number.isSafeInteger(v.n)).slice(-500)
      .map((v: any) => ({ n: v.n, author: text(v.author, 60), at: text(v.at, 40), summary: text(v.summary, 200), size: Number(v.size) || 0 }));
  }
  // Which of a dashboard's sources the user allowed (when the process says; see the panel for when it doesn't).
  if (Array.isArray(raw.allowed_sources)) view.allowed_sources = raw.allowed_sources.filter((s: unknown) => typeof s === "string").slice(0, 32);
  return view;
}

/** A file name from a title: what a save dialog suggests. */
export function fileName(title: string, ext: string): string {
  const base = String(title || "artifact").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "artifact";
  return `${base}.${ext}`;
}

/** What the artifacts need of the side bar: its process, and what it offers. */
export interface ArtifactsHost {
  /** "sent"; "starting" while the process comes up (sent once it's ready); "old_cli" when it has no artifacts. */
  send(cmd: Record<string, unknown>): "sent" | "starting" | "old_cli";
  offers(): ArtifactsOffer | undefined;
}

type Reply = { ok(ev: any): void; fail(reason: string, message: string): void };
type Listener = (message: Record<string, unknown>) => void;

const attr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** The artifact panel's page. Its frames: a page artifact at its own address (frame-src), and DGC's own layout of a
 *  deck, a sheet or a dashboard as text the host fetched (srcdoc, sandboxed with no script). A page is served on this
 *  computer (127.0.0.1), or over https when asExternalUri forwards it for a remote window; nothing else is framed. */
export function artifactDocument(asset: (name: string) => string, cspSource: string, nonce: string): string {
  const s = (name: string) => `<script nonce="${nonce}" src="${attr(asset(name))}"></script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; font-src ${attr(cspSource)}; style-src ${attr(cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src http://127.0.0.1:* http://localhost:* https:;">
<link rel="stylesheet" href="${attr(asset("media/codicon.css"))}"><link rel="stylesheet" href="${attr(asset("media/main.css"))}"><link rel="stylesheet" href="${attr(asset("media/artifact.css"))}">
<title>Artifact</title></head><body class="art-body">
<header class="art-head" id="art-head">
<span class="art-mark" id="art-mark" aria-hidden="true"><span class="codicon codicon-file"></span></span>
<div class="art-titles"><h1 class="art-title" id="art-title">Loading…</h1><p class="art-meta" id="art-meta"></p></div>
<div class="art-actions" id="art-actions" role="toolbar" aria-label="Artifact">
<button type="button" class="art-btn" id="art-versions" aria-haspopup="dialog" aria-expanded="false" title="Every version: who made it, when, and what changed" disabled><span class="codicon codicon-history" aria-hidden="true"></span><span class="art-btn-label">Versions</span></button>
<div class="art-menu-wrap"><button type="button" class="art-btn" id="art-export" aria-haspopup="menu" aria-expanded="false" title="Export a copy" disabled><span class="codicon codicon-desktop-download" aria-hidden="true"></span><span class="art-btn-label">Export</span><span class="codicon codicon-chevron-down art-caret" aria-hidden="true"></span></button>
<div class="art-menu" id="art-export-menu" role="menu" aria-label="Export as" hidden></div></div>
<button type="button" class="art-btn" id="art-browser" title="Open it in your browser, at an address of its own" disabled><span class="codicon codicon-link-external" aria-hidden="true"></span><span class="art-btn-label">Open in browser</span></button>
</div></header>
<section class="art-versions" id="art-versions-panel" role="dialog" aria-label="Versions" hidden><div class="art-versions-head"><h2>Versions</h2><button type="button" class="art-icon" id="art-versions-close" title="Close" aria-label="Close versions"><span class="codicon codicon-close" aria-hidden="true"></span></button></div><ol class="art-version-list" id="art-version-list"></ol></section>
<div class="art-banner" id="art-banner" role="alert" hidden></div>
<main class="art-main" id="art-main"><p class="art-empty" id="art-loading">Loading…</p></main>
<div class="sr-only" id="art-announce" aria-live="polite"></div>
${s("media/sheetRefs.js")}${s("media/artifactSlides.js")}${s("media/artifactSheet.js")}${s("media/artifact.js")}
</body></html>`;
}

/** The present tab: the deck's present mode, framed to fill it, focused so the arrow keys move at once; the deck's
 *  Esc (it posts {type: "dgc-slides", event: "exit"} to its parent) closes the tab. */
export function presentDocument(url: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src http://127.0.0.1:* http://localhost:* https:;">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body><iframe id="deck" src="${attr(url)}" sandbox="allow-scripts allow-same-origin" allow="fullscreen" title="Slides"></iframe>
<script nonce="${nonce}">(()=>{const vscode=acquireVsCodeApi(),deck=document.getElementById('deck');
deck.addEventListener('load',()=>deck.focus());
addEventListener('message',(e)=>{if(e.source===deck.contentWindow&&e.data&&e.data.type==='dgc-slides'&&e.data.event==='exit')vscode.postMessage({type:'exit'});});})();</script>
</body></html>`;
}

const nonceOf = () => randomBytes(16).toString("base64");

/** One artifact in a panel of its own. */
class ArtifactPanel {
  view?: ArtifactView;
  private ready = false;
  private queue: Record<string, unknown>[] = [];
  private servedFor = 0;           // the version the last render was asked for
  private servedUrl = "";

  constructor(private readonly hub: Artifacts, readonly id: string, readonly panel: vscode.WebviewPanel) {
    panel.webview.onDidReceiveMessage((message) => { void this.fromPage(message); });
    panel.onDidDispose(() => hub.forget(this));
  }

  post(message: Record<string, unknown>): void {
    if (!this.ready) { this.queue.push(message); return; }
    void this.panel.webview.postMessage(message);
  }

  /** The artifact as it is now, with its content for the editor; then what shows it. */
  load(): void {
    this.hub.ask({ type: "artifact_get", id: this.id, content: true }, {
      ok: (ev) => {
        const view = artifactView(ev.artifact);
        if (!view) return;
        this.view = view;
        this.panel.title = view.title;
        this.post({ type: "detail", artifact: view, content: ev.content ?? null, state: ev.state && typeof ev.state === "object" ? ev.state : null,
                    offer: this.hub.offers() ?? null });
        if (view.type !== "doc") this.serve();
      },
      fail: (reason, message) => this.post({ type: "rejected", what: "load", reason, message }),
    });
  }

  /** Its own address (artifact_open), framed when it's a page; DGC's layout of a deck, sheet or dashboard, read here
   *  and handed to the page as text, so no webview needs to reach the address. */
  serve(): void {
    const version = this.view?.version ?? 0;
    this.servedFor = version;
    this.servedUrl = "";
    this.hub.ask({ type: "artifact_open", id: this.id }, {
      ok: async (ev) => {
        const url = String(ev.url || "");
        if (!/^https?:\/\//i.test(url)) return;
        if (this.view?.type === "page") {
          this.servedUrl = url;
          let shown = url;
          try { shown = (await vscode.env.asExternalUri(vscode.Uri.parse(url, true))).toString(true); } catch { /* as it is */ }
          this.post({ type: "frame", url: shown, version });
          return;
        }
        try {
          const html = await fetchPage(url);
          if (version === this.servedFor) this.post({ type: "render", html, version });
        } catch (err: any) {
          this.post({ type: "render", error: `DGC's view of it didn't load: ${String(err?.message || err)}`, version });
        }
      },
      fail: (reason, message) => this.post({ type: "render", error: message || reason, version }),
    });
  }

  /** Someone else changed it (a chat's model, a Work turn, a Pip, another window): the page decides whether to show
   *  it at once or, with unsaved edits of its own, to say so. Its own saves are answered by their replies. */
  changed(view: ArtifactView, op: string, mine: boolean): void {
    if (op !== "removed") { this.view = view; this.panel.title = view.title; }
    if (!mine) this.post({ type: "changed", artifact: view, op });
  }

  private async fromPage(message: any): Promise<void> {
    if (!message || typeof message !== "object") return;
    const view = this.view;
    switch (message.type) {
      case "ready":
        this.ready = true;
        void this.panel.webview.postMessage({ type: "init", id: this.id });
        for (const queued of this.queue.splice(0)) void this.panel.webview.postMessage(queued);
        this.load();
        return;
      case "reload": this.load(); return;
      case "preview": if (view && view.type !== "doc") this.serve(); return;
      case "copyPageText":
        if (view?.type === "page" && this.servedUrl && this.servedFor === view.version) {
          try { this.post({ type: "copySource", html: await fetchPage(this.servedUrl) }); }
          catch (err: any) { this.post({ type: "copyFailed", message: `Could not read the page's text: ${String(err?.message || err)}` }); }
        }
        return;
      case "copyText":
        if ((view?.type === "page" || view?.type === "dashboard") && typeof message.text === "string"
            && message.text.length > 0 && message.text.length <= 200000) {
          try { await vscode.env.clipboard.writeText(message.text); this.post({ type: "copied" }); }
          catch { this.post({ type: "copyFailed", message: "Could not write to the clipboard here." }); }
        }
        return;
      case "save": {
        if (!view || !Number.isSafeInteger(message.base_version)) return;
        const content = message.content;
        if (typeof content !== "string" && (!content || typeof content !== "object")) return;
        // One command frame carries the whole artifact (a deck's pictures inside it): past the frame's limit it can't go.
        const size = Buffer.byteLength(typeof content === "string" ? content : JSON.stringify(content), "utf8");
        if (size > MAX_SAVE_BYTES) {
          this.post({ type: "rejected", what: "save", reason: "too_large",
                      message: `This is ${(size / 1048576).toFixed(1)} MB, more than one save from the editor can carry (${(MAX_SAVE_BYTES / 1048576).toFixed(1)} MB). Make its pictures smaller, or ask the agent to make the change.` });
          return;
        }
        this.hub.ask({ type: "artifact_update", id: this.id, content, base_version: message.base_version,
                       ...(typeof message.note === "string" && message.note.trim() ? { note: message.note.trim().slice(0, 200) } : {}) }, {
          ok: (ev) => { const next = artifactView(ev.artifact); if (next) { this.view = next; this.post({ type: "saved", artifact: next }); this.serve(); } },
          fail: (reason, text) => this.post({ type: "rejected", what: "save", reason, message: text }),
        });
        return;
      }
      case "restore": {
        if (!view || !Number.isSafeInteger(message.version)) return;
        this.hub.ask({ type: "artifact_restore", id: this.id, version: message.version }, {
          ok: () => this.load(),
          fail: (reason, text) => this.post({ type: "rejected", what: "restore", reason, message: text }),
        });
        return;
      }
      case "compare": {
        if (!view || !this.hub.offers()?.compare || !Number.isSafeInteger(message.version) || message.version < 1) return;
        this.hub.ask({ type: "artifact_compare", id: this.id, before: message.version, after: view.version }, {
          ok: (ev) => this.post({ type: "comparison", comparison: ev.comparison }),
          fail: (reason, text) => this.post({ type: "rejected", what: "compare", reason, message: text }),
        });
        return;
      }
      case "export":
        if (view && typeof message.format === "string") {
          void this.hub.exportArtifact(view, message.format, Number.isSafeInteger(message.version) ? message.version : undefined);
        }
        return;
      case "browser": if (view) this.hub.openInBrowser(view); return;
      case "present": if (view?.type === "slides") this.hub.present(view); return;
      case "refresh":
        if (view?.type !== "dashboard") return;
        this.hub.ask({ type: "artifact_refresh", id: this.id }, {
          ok: (ev) => { this.post({ type: "refreshed", state: ev.state && typeof ev.state === "object" ? ev.state : null }); this.serve(); },
          fail: (reason, text) => this.post({ type: "rejected", what: "refresh", reason, message: text }),
        });
        return;
      case "allow": {
        if (view?.type !== "dashboard" || typeof message.source !== "string" || typeof message.allowed !== "boolean") return;
        const source = message.source.slice(0, 40), allowed = message.allowed;
        const pinned = this.hub.offers()?.sourceConsentVersion;
        if (pinned && (!Number.isSafeInteger(message.base_version) || message.base_version < 1)) {
          this.post({ type: "rejected", what: "allow", reason: "conflict", source,
                      message: "Reload the dashboard's sources before allowing one." });
          return;
        }
        this.hub.ask({ type: "artifact_allow_source", id: this.id, source, allowed,
                       ...(pinned ? { base_version: message.base_version } : {}) }, {
          ok: (ev) => {
            const next = artifactView(ev.artifact);
            if (next) this.view = next;
            this.post({ type: "allowed", source, allowed, artifact: next ?? null });
          },
          fail: (reason, text) => this.post({ type: "rejected", what: "allow", reason, message: text, source }),
        });
        return;
      }
      case "openDoc":
        // A panel restored for a document: it opens in the editor instead.
        if (view?.type === "doc") { this.hub.open(this.id, view); this.panel.dispose(); }
        return;
      case "openLink": {
        const href = String(message.href || "");
        if (/^https?:\/\/\S+$/i.test(href) && href.length <= 4096) void vscode.env.openExternal(vscode.Uri.parse(href, true));
        return;
      }
    }
  }

}

/** The page DGC served, read over the loopback by the host (never by a webview). */
export function fetchPage(url: string, limit = MAX_PAGE_BYTES, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try { target = new URL(url); } catch { reject(new Error("not an address")); return; }
    if (target.protocol !== "http:" && target.protocol !== "https:") { reject(new Error("not a web address")); return; }
    const get = target.protocol === "https:" ? https.get : http.get;
    const req = get(target, { timeout: timeoutMs, headers: { Accept: "text/html" } }, (res) => {
      if ((res.statusCode || 0) !== 200) { res.resume(); reject(new Error(`it answered ${res.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) { req.destroy(new Error("it's too big to show here")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("it took too long")));
    req.on("error", reject);
  });
}

export class Artifacts implements vscode.Disposable {
  private disposed = false;
  private host?: ArtifactsHost;
  private seq = 0;
  private readonly requests = new Map<string, Reply>();
  private readonly held: Record<string, unknown>[] = [];
  private readonly panels = new Map<string, ArtifactPanel>();
  private readonly listeners = new Set<Listener>();
  /** A doc's working file -> its artifact, as the views said (and the store's own layout says, after a reload). */
  private readonly docFiles = new Map<string, string>();
  private readonly titles = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  attach(host: ArtifactsHost): void { this.host = host; }

  offers(): ArtifactsOffer | undefined {
    try { return this.host?.offers(); } catch { return undefined; }
  }

  register(): vscode.Disposable {
    const panels = vscode.window.registerWebviewPanelSerializer(ARTIFACT_PANEL, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: any) => {
        const id = String(state?.id || "");
        if (!ARTIFACT_ID.test(id) || this.panels.has(id)) { panel.dispose(); return; }
        this.adopt(panel, id);
      },
    });
    return { dispose: () => panels.dispose() };
  }

  dispose(): void {
    this.disposed = true;
    this.backendLost();
    this.host = undefined;
    for (const panel of [...this.panels.values()]) panel.panel.dispose();
    this.listeners.clear();
  }

  /** Every screen that shows artifacts hears what changed: a chat's cards, Work's cards, the Library. */
  listen(listener: Listener): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  private tell(message: Record<string, unknown>): void {
    for (const listener of [...this.listeners]) { try { listener(message); } catch { /* one screen never stops the rest */ } }
  }

  /** The side bar's process finished its handshake: what waited goes now, and every screen learns what it offers. */
  backendReady(): void {
    for (const cmd of this.held.splice(0)) this.deliver(cmd);
    this.tell({ type: "artifactsOffered", offered: this.offers() ?? null });
  }

  /** The process went away: nothing it was asked will be answered. */
  backendLost(): void {
    const pending = [...this.requests.values()];
    this.requests.clear();
    this.held.length = 0;
    for (const reply of pending) reply.fail("lost", "DGC restarted before it answered. Try again.");
  }

  ask(cmd: Record<string, unknown>, reply: Reply): void {
    if (this.disposed) { reply.fail("closed", "The artifact view was closed."); return; }
    const requestId = `art-${String(cmd.type).replace(/^artifact_/, "")}-${++this.seq}`;
    this.requests.set(requestId, reply);
    while (this.requests.size > MAX_REQUESTS) {
      const oldest = this.requests.keys().next().value as string;
      const evicted = this.requests.get(oldest);
      this.requests.delete(oldest);
      for (let i = this.held.length - 1; i >= 0; i--) if (this.held[i].request_id === oldest) this.held.splice(i, 1);
      evicted?.fail("busy", "Too many artifact requests are waiting. Try again.");
    }
    this.deliver({ ...cmd, request_id: requestId });
  }

  private deliver(cmd: Record<string, unknown>): void {
    if (!this.requests.has(String(cmd.request_id))) return;
    const outcome = this.host ? this.host.send(cmd) : "starting";
    if (outcome === "sent") return;
    if (outcome === "starting") { this.held.push(cmd); return; }
    const reply = this.requests.get(String(cmd.request_id));
    this.requests.delete(String(cmd.request_id));
    reply?.fail("old_cli", "Artifacts need a newer DGC CLI. Run “DGC: Update CLI”, then try again.");
  }

  /** An event from the side bar's process. True when it was for the artifacts and nothing else should show it; an
   *  artifact_changed from a Work turn returns false so the chat it came from still draws its card. */
  onEvent(ev: any): boolean {
    const type = String(ev?.type || "");
    const requestId = typeof ev?.request_id === "string" ? ev.request_id : "";
    const reply = requestId ? this.requests.get(requestId) : undefined;
    if (type === "command_rejected") {
      if (!reply) return false;
      this.requests.delete(requestId);
      reply.fail(String(ev.reason || "failed"), String(ev.message || "DGC couldn't do that."));
      return true;
    }
    if (!["artifact_items", "artifact_changed", "artifact_detail", "artifact_served", "artifact_exported", "artifact_comparison"].includes(type)) return false;
    if (type === "artifact_changed") {
      const view = artifactView(ev.artifact);
      if (view) {
        const op = String(ev.op || "changed");
        this.remember(view);
        const panel = this.panels.get(view.id);
        panel?.changed(view, op, !!reply);
        this.tell({ type: "artifactChanged", artifact: view, op, surface: typeof ev.surface === "string" ? ev.surface : "",
                    conversation_id: typeof ev.conversation_id === "string" ? ev.conversation_id : "" });
      }
      if (reply) { this.requests.delete(requestId); reply.ok(ev); }
      return ev.surface !== "work";
    }
    if (type === "artifact_detail") { const view = artifactView(ev.artifact); if (view) this.remember(view); }
    if (type === "artifact_items" && Array.isArray(ev.items)) for (const raw of ev.items) { const view = artifactView(raw); if (view) this.remember(view); }
    if (reply) { this.requests.delete(requestId); reply.ok(ev); }
    return true;
  }

  private remember(view: ArtifactView): void {
    this.titles.set(view.id, view.title);
    if (view.file) this.docFiles.set(this.key(view.file), view.id);
  }

  private key(path: string): string {
    return process.platform === "win32" ? path.toLowerCase() : path;
  }

  /** The doc artifact whose working file this is, if it is one. */
  docAt(path: string): { id: string; title: string } | undefined {
    const text = String(path || "");
    if (/(^|[\\/])\.\.([\\/]|$)/.test(text)) return undefined;
    const id = this.docFiles.get(this.key(text)) || DOC_FILE.exec(text)?.[1];
    if (!id || !ARTIFACT_ID.test(id)) return undefined;
    if (!this.docFiles.has(this.key(text)) && !/[\\/]artifacts[\\/]ar_[a-f0-9]{16}[\\/]work[\\/][^\\/]+\.md$/i.test(text)) return undefined;
    return { id, title: this.titles.get(id) || text.split(/[\\/]/).pop()!.replace(/\.md$/i, "") };
  }

  // ---- what the screens do

  /** Open an artifact: a document in the canvas editor over its file, everything else in its panel. `hint` is what a
   *  card or the Library already knows, so a document opens without asking first. */
  open(id: string, hint?: Partial<ArtifactView>): void {
    if (!ARTIFACT_ID.test(id)) return;
    // No check of the capability here: the side bar's process may still be starting (a card is only drawn by a CLI
    // that offers artifacts). Its answer says, and an older CLI's refusal reads "needs a newer DGC CLI".
    const existing = this.panels.get(id);
    if (existing) { existing.panel.reveal(); return; }
    if (hint?.type === "doc" && hint.file) { void this.openDoc(hint as ArtifactView); return; }
    if (hint?.type === "doc" || !hint?.type) {
      // Which kind it is (and a document's file) is the process's to say.
      this.ask({ type: "artifact_get", id }, {
        ok: (ev) => {
          const view = artifactView(ev.artifact);
          if (!view) return;
          this.remember(view);
          if (view.type === "doc") void this.openDoc(view);
          else this.openPanel(id, view.title);
        },
        fail: (_reason, message) => { void vscode.window.showWarningMessage(`That artifact couldn't be opened: ${message}`); },
      });
      return;
    }
    this.openPanel(id, hint.title || LABELS[hint.type] || "Artifact");
  }

  private openPanel(id: string, title: string): void {
    const panel = vscode.window.createWebviewPanel(ARTIFACT_PANEL, title, vscode.ViewColumn.Beside, this.options());
    this.adopt(panel, id);
  }

  private options(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] };
  }

  private adopt(panel: vscode.WebviewPanel, id: string): ArtifactPanel {
    panel.webview.options = this.options();
    panel.iconPath = tabIcon(this.context.extensionUri, "dgc-tab");
    const one = new ArtifactPanel(this, id, panel);
    this.panels.set(id, one);
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...name.split("/"))).toString();
    panel.webview.html = artifactDocument(asset, panel.webview.cspSource, randomBytes(16).toString("base64"));
    return one;
  }

  forget(panel: ArtifactPanel): void {
    if (this.panels.get(panel.id) === panel) this.panels.delete(panel.id);
  }

  private async openDoc(view: ArtifactView): Promise<void> {
    const file = view.file;
    if (!file) { void vscode.window.showWarningMessage(`“${view.title}” has no file to open here yet.`); return; }
    this.remember(view);
    const uri = vscode.Uri.file(file);
    try {
      if (/\.md$/i.test(file)) await vscode.commands.executeCommand("vscode.openWith", uri, CANVAS_DOC_VIEW, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      else await vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    } catch (err: any) {
      void vscode.window.showWarningMessage(`“${view.title}” couldn't be opened: ${String(err?.message || err)}`);
    }
  }

  /** Export a copy: where to keep it first, then the process makes it and it is copied there. */
  async exportArtifact(view: Pick<ArtifactView, "id" | "title" | "exports" | "type">, format: string, version?: number): Promise<void> {
    const formats = view.exports?.length ? view.exports : this.offers()?.exports[view.type] ?? [];
    if (!formats.includes(format)) return;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
    const name = fileName(view.title, format);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder, name), saveLabel: "Export",
      title: `Export “${view.title}”${version ? ` (version ${version})` : ""} as ${FORMAT_LABELS[format] || format}`,
    });
    if (!target) return;
    const made = new Promise<string>((resolve, reject) => {
      this.ask({ type: "artifact_export", id: view.id, format, ...(version ? { version } : {}) }, {
        ok: (ev) => resolve(String(ev.path || "")),
        fail: (_reason, message) => reject(new Error(message)),
      });
    });
    try {
      const path = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting “${view.title}”…` }, () => made);
      if (!path) throw new Error("DGC said nothing about where it made the file.");
      await vscode.workspace.fs.copy(vscode.Uri.file(path), target, { overwrite: true });
      const shown = target.path.split("/").pop() || name;
      const choice = await vscode.window.showInformationMessage(`Exported “${shown}”.`, "Open", "Show in Folder");
      if (choice === "Open") await this.openFile(target);
      else if (choice === "Show in Folder") await vscode.commands.executeCommand("revealFileInOS", target);
    } catch (err: any) {
      void vscode.window.showWarningMessage(`“${view.title}” wasn't exported: ${String(err?.message || err)}`);
    }
  }

  private async openFile(uri: vscode.Uri): Promise<void> {
    try {
      if (/\.(md|csv)$/i.test(uri.path)) { await vscode.window.showTextDocument(uri, { preview: false }); return; }
      await vscode.env.openExternal(uri);
    } catch { /* it's saved where they chose */ }
  }

  /** Remove it from the artifacts, after asking: it goes to DGC's trash, so it can be put back. */
  async remove(view: Pick<ArtifactView, "id" | "title">): Promise<boolean> {
    const REMOVE = "Remove";
    const choice = await vscode.window.showWarningMessage(`Remove “${view.title}”?`, {
      modal: true,
      detail: "It goes to DGC's trash with every version (in ~/.dgc/artifacts/.trash), where it can be recovered. Cards that show it say it was removed.",
    }, REMOVE);
    if (choice !== REMOVE) return false;
    return new Promise<boolean>((resolve) => {
      this.ask({ type: "artifact_remove", id: view.id }, {
        ok: () => resolve(true),
        fail: (_reason, message) => { void vscode.window.showWarningMessage(`“${view.title}” wasn't removed: ${message}`); resolve(false); },
      });
    });
  }

  /** In the browser, at its own address (asExternalUri, so a remote or WSL window's browser reaches it). */
  openInBrowser(view: Pick<ArtifactView, "id" | "title">): void {
    this.ask({ type: "artifact_open", id: view.id }, {
      ok: async (ev) => {
        const url = String(ev.url || "");
        if (!/^https?:\/\//i.test(url)) return;
        try {
          const external = await vscode.env.asExternalUri(vscode.Uri.parse(url, true));
          await vscode.env.openExternal(external);
        } catch (err: any) {
          void vscode.window.showWarningMessage(`“${view.title}” couldn't be opened in the browser: ${String(err?.message || err)}`);
        }
      },
      fail: (_reason, message) => { void vscode.window.showWarningMessage(`“${view.title}” couldn't be opened in the browser: ${message}`); },
    });
  }

  /** A deck presented, a slide at a time, in an editor tab of its own: its present mode at its own address
   *  (artifact_open mode "present"), framed; Esc in the deck closes the tab. A process that doesn't offer that
   *  address hands over the deck's one-file page instead. */
  present(view: Pick<ArtifactView, "id" | "title">): void {
    if (this.offers()?.present) {
      this.ask({ type: "artifact_open", id: view.id, mode: "present" }, {
        ok: async (ev) => {
          const url = String(ev.url || "");
          if (!/^https?:\/\//i.test(url)) return;
          let shown = url;
          try { shown = (await vscode.env.asExternalUri(vscode.Uri.parse(url, true))).toString(true); } catch { /* as it is */ }
          const panel = vscode.window.createWebviewPanel(ARTIFACT_PRESENT, `Present: ${view.title}`, vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
          panel.iconPath = tabIcon(this.context.extensionUri, "dgc-tab");
          panel.webview.html = presentDocument(shown, nonceOf());
          panel.webview.onDidReceiveMessage((message) => { if (message?.type === "exit") panel.dispose(); });
        },
        fail: (_reason, message) => { void vscode.window.showWarningMessage(`“${view.title}” couldn't be presented: ${message}`); },
      });
      return;
    }
    this.ask({ type: "artifact_export", id: view.id, format: "html" }, {
      ok: async (ev) => {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(String(ev.path || "")));
          const panel = vscode.window.createWebviewPanel(ARTIFACT_PRESENT, `Present: ${view.title}`, vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
          panel.iconPath = tabIcon(this.context.extensionUri, "dgc-tab");
          panel.webview.html = Buffer.from(bytes).toString("utf8");
        } catch (err: any) {
          void vscode.window.showWarningMessage(`“${view.title}” couldn't be presented: ${String(err?.message || err)}`);
        }
      },
      fail: (_reason, message) => { void vscode.window.showWarningMessage(`“${view.title}” couldn't be presented: ${message}`); },
    });
  }

  /** Every artifact (or every one of a type: a Pip's page lists dashboards), newest change first. */
  list(type?: string): Promise<ArtifactView[]> {
    return new Promise((resolve, reject) => {
      this.ask({ type: "artifact_list", ...(type && ARTIFACT_TYPES.includes(type) ? { artifact_type: type } : {}) }, {
        ok: (ev) => resolve((Array.isArray(ev.items) ? ev.items : []).map(artifactView).filter(Boolean) as ArtifactView[]),
        fail: (_reason, message) => reject(new Error(message)),
      });
    });
  }

  /** A document's versions, from the canvas editor: restore one, or export it. */
  async docVersions(id: string): Promise<void> {
    const view = await new Promise<ArtifactView | undefined>((resolve) => {
      this.ask({ type: "artifact_get", id }, { ok: (ev) => resolve(artifactView(ev.artifact)), fail: (_r, m) => { void vscode.window.showWarningMessage(m); resolve(undefined); } });
    });
    if (!view?.versions?.length) return;
    const when = (at: string) => { const t = Date.parse(at); return Number.isFinite(t) ? new Date(t).toLocaleString() : ""; };
    const pick = await vscode.window.showQuickPick([...view.versions].reverse().map((v) => ({
      label: `Version ${v.n}${v.n === view.version ? " (now)" : ""}`, description: [v.author, v.summary].filter(Boolean).join(" · "), detail: when(v.at), n: v.n,
    })), { placeHolder: `${view.title}: restore a version, or export it` });
    if (!pick) return;
    const n = (pick as any).n as number;
    const actions = [...(n !== view.version ? ["Restore this version", ...(this.offers()?.compare ? ["Compare with current"] : [])] : []),
                     ...view.exports.map((f) => `Export as ${FORMAT_LABELS[f] || f}`)];
    const action = await vscode.window.showQuickPick(actions, { placeHolder: `Version ${n}` });
    if (!action) return;
    if (action === "Compare with current") {
      this.ask({ type: "artifact_compare", id, before: n, after: view.version }, {
        ok: async (ev) => {
          const result = ev.comparison;
          if (!result || typeof result !== "object") return;
          const text = `Version ${n} → ${view.version}\n${result.truncated ? "Partial comparison: large content was shortened.\n" : ""}\n`
            + (typeof result.diff === "string" ? result.diff : "No text changes.");
          const doc = await vscode.workspace.openTextDocument({ content: text, language: "diff" });
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        },
        fail: (_r, m) => { void vscode.window.showWarningMessage(`Versions couldn't be compared: ${m}`); },
      });
      return;
    }
    if (action === "Restore this version") {
      this.ask({ type: "artifact_restore", id, version: n }, { ok: () => undefined, fail: (_r, m) => { void vscode.window.showWarningMessage(`Version ${n} wasn't restored: ${m}`); } });
      return;
    }
    const format = view.exports.find((f) => action === `Export as ${FORMAT_LABELS[f] || f}`);
    if (format) await this.exportArtifact(view, format, n === view.version ? undefined : n);
  }

  /** Export a document from the canvas editor: which format, then where. */
  async docExport(id: string): Promise<void> {
    const view = await new Promise<ArtifactView | undefined>((resolve) => {
      this.ask({ type: "artifact_get", id }, { ok: (ev) => resolve(artifactView(ev.artifact)), fail: (_r, m) => { void vscode.window.showWarningMessage(m); resolve(undefined); } });
    });
    if (!view) return;
    const pick = await vscode.window.showQuickPick(view.exports.map((f) => ({ label: FORMAT_LABELS[f] || f, format: f })), { placeHolder: `Export “${view.title}” as` });
    if (pick) await this.exportArtifact(view, (pick as any).format);
  }

  title(id: string): string { return this.titles.get(id) || "this artifact"; }
}
