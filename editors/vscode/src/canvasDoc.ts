// ChatDGC's formatted canvas (Canvas option B): a custom text editor for a document canvas's .md, over the same
// TextDocument option A edits. VS Code keeps the document, so the dirty dot, save, the model's edits (a WorkspaceEdit
// from chatdgc.ts), versions and the title-bar commands all work as they do in the Markdown editor. The page
// (canvasEditor.ts) sends the whole Markdown as you type; only the part that changed is replaced here, and the
// file is saved once you pause, like a doc.
import * as vscode from "vscode";

export const CANVAS_DOC_VIEW = "dgc.chatdgcCanvasDoc";
const SAVE_AFTER_MS = 1200;
const MAX_TEXT = 2_000_000;

/** What the formatted canvas needs from ChatDGC (chatdgc.ts). */
export interface CanvasDocHost {
  canvasOf(path: string): { conversation: string; canvas: string } | undefined;
  /** Ask about these lines of the canvas (1-based, inclusive), as the Markdown editor's Ask does. */
  canvasAskAbout(conversation: string, canvas: string, text: string, startLine: number, endLine: number): Promise<void>;
  canvasShortcut(): Promise<void>;
}

const attr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function canvasDocDocument(asset: (name: string) => string, cspSource: string): string {
  const b = (does: string, icon: string, label: string, extra = "") =>
    `<button type="button" class="cv-btn" data-do="${does}" title="${attr(label)}" aria-label="${attr(label)}"${extra}><span class="codicon codicon-${icon}" aria-hidden="true"></span></button>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; font-src ${attr(cspSource)}; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};">
<link rel="stylesheet" href="${attr(asset("media/codicon.css"))}"><link rel="stylesheet" href="${attr(asset("media/canvas.css"))}">
<title>Canvas</title></head><body data-katex="${attr(asset("dist/katex/katex.js"))}" data-katex-css="${attr(asset("dist/katex/katex.css"))}">
<div id="cv-bar" class="cv-bar" role="toolbar" aria-label="Formatting">
<label class="sr-only" for="cv-style">Text style</label><select id="cv-style" class="cv-style" title="Text style">
<option value="p">Text</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="code">Code block</option></select>
<span class="cv-sep" aria-hidden="true"></span>
${b("strong", "bold", "Bold (Ctrl+B)", ' data-mark="strong" aria-pressed="false"')}${b("em", "italic", "Italic (Ctrl+I)", ' data-mark="em" aria-pressed="false"')}${b("strike", "strikethrough", "Strikethrough (Ctrl+Shift+X)", ' data-mark="strike" aria-pressed="false"')}${b("code", "code", "Code (Ctrl+E)", ' data-mark="code" aria-pressed="false"')}${b("link", "link", "Link (Ctrl+K)", ' data-mark="link" aria-pressed="false"')}
<span class="cv-sep" aria-hidden="true"></span>
${b("bullet", "list-unordered", "Bulleted list")}${b("ordered", "list-ordered", "Numbered list")}${b("quote", "quote", "Quote")}${b("rule", "horizontal-rule", "Divider")}
<span class="cv-spacer"></span>
<button type="button" id="cv-ask" class="cv-ask" data-do="ask" title="Ask ChatDGC about the selection"><span class="codicon codicon-sparkle" aria-hidden="true"></span><span>Ask ChatDGC</span></button>
${b("shortcuts", "wand", "Shortcuts: suggest edits, length, reading level, polish")}${b("markdown", "markdown", "Open as Markdown")}
</div>
<main class="cv-page"><div id="cv-editor" class="cv-editor"></div></main>
<script src="${attr(asset("dist/canvas.js"))}"></script></body></html>`;
}

/** The part of `before` that `after` changed: one range and its new text, so an edit doesn't replace the file. */
export function minimalChange(before: string, after: string): { start: number; end: number; text: string } | undefined {
  if (before === after) return undefined;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let tail = 0;
  while (tail < max - start && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}

/** What an Ask from the page quotes: the words picked when the file has them as they are, else those lines' Markdown
 *  as the file has it. The page has the words without their Markdown ("For eight years" for "**For** eight years"),
 *  and the model, told that's the canvas's text, used it as an exact find and missed (live run, 2026-10-11). */
export function selectionText(file: string, start: number, end: number, picked: string): string {
  const lines = file.split("\n").slice(start - 1, end).join("\n");
  return picked.trim() && lines.includes(picked) ? picked : lines;
}

export class CanvasDocEditor implements vscode.CustomTextEditorProvider {
  private readonly open = new Map<vscode.WebviewPanel, vscode.TextDocument>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** The formatted canvas in front, or none; fires as that changes (for the title-bar commands' context key). */
  readonly onDidChangeActive = this.changed.event;
  private activePanel?: vscode.WebviewPanel;

  constructor(private readonly extensionUri: vscode.Uri, private readonly host: CanvasDocHost) {}

  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(CANVAS_DOC_VIEW, this,
        { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }),
      this.changed);
  }

  /** The document of the formatted canvas in front, if one is. */
  active(): vscode.TextDocument | undefined {
    return this.activePanel?.active ? this.open.get(this.activePanel) : undefined;
  }

  /** Ask about the selection in the formatted canvas in front: its page sends the selection back (an "ask"). */
  askSelection(): boolean {
    const panel = this.activePanel?.active ? this.activePanel : undefined;
    if (!panel) return false;
    void panel.webview.postMessage({ type: "askSelection" });
    return true;
  }

  /** Have every formatted canvas send what was typed, now (before a message goes and the canvas is saved). */
  flush(): void {
    for (const panel of this.open.keys()) void panel.webview.postMessage({ type: "flush" });
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const found = this.host.canvasOf(document.uri.fsPath);
    const roots = [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")];
    panel.webview.options = { enableScripts: !!found, localResourceRoots: roots };
    if (!found || !/\.md$/i.test(document.uri.fsPath)) {
      panel.webview.html = `<!doctype html><html><body><p>Only a ChatDGC document canvas opens formatted. Reopen this file with the text editor.</p></body></html>`;
      return;
    }
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, name)).toString();
    panel.webview.html = canvasDocDocument(asset, panel.webview.cspSource);
    panel.iconPath = { light: vscode.Uri.joinPath(this.extensionUri, "media", "chatdgc-tab-light.svg"),
                       dark: vscode.Uri.joinPath(this.extensionUri, "media", "chatdgc-tab-dark.svg") };
    this.open.set(panel, document);
    if (panel.active) { this.activePanel = panel; this.changed.fire(); }

    let fromPage: string | undefined;          // the text this page last sent: its own change, not to be sent back
    let saving: ReturnType<typeof setTimeout> | undefined;
    const send = (external: boolean) => void panel.webview.postMessage({ type: "doc", text: document.getText(), external });
    const save = () => {
      if (saving) clearTimeout(saving);
      saving = setTimeout(() => { saving = undefined; if (document.isDirty) void document.save(); }, SAVE_AFTER_MS);
    };
    const subscriptions = [
      panel.webview.onDidReceiveMessage(async (msg: any) => {
        switch (msg?.type) {
          case "ready": send(false); break;
          case "edit": {
            if (typeof msg.text !== "string" || msg.text.length > MAX_TEXT) return;
            const change = minimalChange(document.getText(), msg.text);
            if (!change) return;
            fromPage = msg.text;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
            if (await vscode.workspace.applyEdit(edit)) save();
            break;
          }
          case "ask": {
            const start = Number(msg.start_line), end = Number(msg.end_line), text = String(msg.text || "");
            if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || !text.trim()) return;
            if (document.isDirty) await document.save();
            await this.host.canvasAskAbout(found.conversation, found.canvas, selectionText(document.getText(), start, end, text).slice(0, 20_000), start, end);
            break;
          }
          case "shortcuts": if (document.isDirty) await document.save(); await this.host.canvasShortcut(); break;
          case "markdown":
            if (document.isDirty) await document.save();
            await vscode.commands.executeCommand("vscode.openWith", document.uri, "default", panel.viewColumn);
            panel.dispose();
            break;
          case "openLink": {
            const href = String(msg.href || "");
            if (/^https?:\/\/[^\s]+$/i.test(href) && href.length <= 4096) void vscode.env.openExternal(vscode.Uri.parse(href, true));
            break;
          }
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document !== document || !e.contentChanges.length) return;
        if (fromPage !== undefined && document.getText() === fromPage) return;      // the page's own typing
        fromPage = undefined;
        send(true);                                                                 // the model's change, or another editor's
      }),
      panel.onDidChangeViewState(() => {
        if (panel.active) this.activePanel = panel;
        else if (this.activePanel === panel) this.activePanel = undefined;
        this.changed.fire();
      }),
    ];
    panel.onDidDispose(() => {
      if (saving) { clearTimeout(saving); if (document.isDirty) void document.save(); }
      subscriptions.forEach((s) => s.dispose());
      this.open.delete(panel);
      if (this.activePanel === panel) { this.activePanel = undefined; this.changed.fire(); }
    });
  }
}
