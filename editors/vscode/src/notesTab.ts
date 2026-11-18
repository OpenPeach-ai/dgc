// Notes outside the card (src/notes.ts keeps the notes; media/shared/notes.js is the page): a note open wide in an
// editor tab, and what Notes asks of the editor: the system's Save dialog for an export, the clipboard, the browser for
// a link. The tab is the same editor on the same store, so a change in the tab is in the card and one in the card is
// in the tab. Its document loads only the extension's own files; it has no inline script and no inline style.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Notes, NotesEnv } from "./notes";
import { downloadBytes, zipFiles } from "./download";

export const NOTE_TAB = "dgc.noteTab";
const ID = /^[a-z0-9]{4,24}$/;
const attr = (value: string) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const STYLES = ["shared/tokens.css", "shared/menu.css", "shared/homecards.css", "shared/notes.css", "shared/tip.css"], SCRIPTS = ["shared/menu.js", "shared/tip.js", "shared/download.js", "shared/notes.js", "shared/notestab.js"];
/** The tab's document for one note. `uri(name)`: where a file under media/ is served from. */
export function noteTabDocument(uri: (name: string) => string, cspSource: string, noteId: string): string {
  const id = ID.test(noteId) ? noteId : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${attr(cspSource)}; script-src ${attr(cspSource)};">
${STYLES.map((name) => `<link rel="stylesheet" href="${attr(uri(name))}">`).join("")}<title>Note</title></head>
<body class="nt-tabpage" data-note="${attr(id)}"><main class="dgc-home nt-tab"><section class="hc-card hc-note" data-card="note" data-form="full" aria-label="Note"></section><p class="hc-live" role="status" aria-live="polite"></p></main>
${SCRIPTS.map((name) => `<script src="${attr(uri(name))}"></script>`).join("")}</body></html>`;
}

export class NoteTabs implements vscode.Disposable {
  private readonly tabs = new Map<string, vscode.WebviewPanel>();
  constructor(private readonly context: Pick<vscode.ExtensionContext, "extensionUri">, private readonly notes: Notes) {}
  /** A note's tab left open comes back after a reload (locked notes are locked again: it asks for the PIN). */
  register(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(NOTE_TAB, { deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: any) => {
      const id = String(state?.note ?? "");
      if (!ID.test(id) || this.tabs.has(id)) { panel.dispose(); return; }
      this.wire(panel, id);
    } });
  }
  private options(): vscode.WebviewOptions & vscode.WebviewPanelOptions { return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] }; }
  /** The note's tab: made, or brought forward when it is open already. */
  open(id: string): void {
    const note = this.notes.state().notes.find((n) => n.id === id && !n.deleted);
    if (!note) return;
    const had = this.tabs.get(id);
    if (had) { had.reveal(); return; }
    this.wire(vscode.window.createWebviewPanel(NOTE_TAB, note.title.slice(0, 60) || "Note", vscode.ViewColumn.Active, this.options()), id);
  }
  private wire(panel: vscode.WebviewPanel, id: string): void {
    this.tabs.set(id, panel);
    try { panel.webview.options = this.options(); } catch { /* a stand-in's are fixed */ }
    // What Notes says goes to the tab's page; the tab is named by its note as the note is renamed.
    const post = (said: any): void => {
      if (said?.type === "homeNotes") { const note = (said.notes as any[]).find((n) => n.id === id); if (note && !note.deleted && panel.title !== note.title.slice(0, 60)) panel.title = note.title.slice(0, 60) || "Note"; }
      void panel.webview.postMessage(said);
    };
    const heard = this.notes.onSaid(post);
    panel.webview.onDidReceiveMessage((message: any) => { this.notes.handle(message, post); });
    panel.onDidDispose(() => { heard.dispose(); if (this.tabs.get(id) === panel) this.tabs.delete(id); });
    panel.webview.html = noteTabDocument((name) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", ...name.split("/"))).toString(), panel.webview.cspSource, id);
  }
  dispose(): void { for (const panel of [...this.tabs.values()]) panel.dispose(); this.tabs.clear(); }
}

/** Whether the editor keeps secrets in its own weak store (Linux started with the "basic" password store, set by a flag
 *  or in argv.json): there a "keychain" is a file anyone signed in as the user reads, so Notes locks nothing. The editor
 *  gives no way to ask this outright; this reads what can be read, and only where its window is on this computer. */
function weakKeychain(): boolean {
  if (process.platform !== "linux" || vscode.env.remoteName) return false;
  if (process.argv.some((a) => a === "--password-store=basic") || /--password-store[= ]basic/.test(String(process.env.VSCODE_CLI_ARGS || ""))) return true;
  for (const dir of [".vscode", ".vscode-insiders", ".vscode-oss", ".cursor", ".windsurf"]) {
    try { if (/^\s*"password-store"\s*:\s*"basic"/m.test(fs.readFileSync(path.join(os.homedir(), dir, "argv.json"), "utf8"))) return true; } catch { /* no such file */ }
  }
  return false;
}
const bytes = (text: string) => Buffer.from(text, "utf8");
/** What Notes asks of the editor, for real. */
export function notesEnv(tabs: NoteTabs): NotesEnv {
  return {
    openExternal: (url) => { void vscode.env.openExternal(vscode.Uri.parse(url, true)); },
    weakKeychain,
    clipboard: async (text) => { await vscode.env.clipboard.writeText(text); },
    // Export: a download to the person's own computer from the page that asked (src/download.ts), never a dialog here,
    // which over a remote connection would browse the remote machine. A folder of notes is one .zip of their files.
    saveFile: async ({ name, text }, reply) => downloadBytes(reply ? (m) => { reply(m); return true; } : undefined, name, bytes(text), "text/markdown"),
    saveFolder: async ({ name, files }, reply) => {
      const zip = `${name}.zip`;
      const sent = await downloadBytes(reply ? (m) => { reply(m); return true; } : undefined, zip,
                                       zipFiles(files.map((f) => ({ name: f.name, bytes: bytes(f.text) }))), "application/zip");
      return sent ? zip : undefined;
    },
    openTab: (id) => tabs.open(id),
  };
}
