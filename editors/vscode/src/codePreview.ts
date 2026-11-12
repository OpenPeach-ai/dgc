// A preview of the HTML or SVG a reply wrote, in an editor tab beside the chat (0.52).
//
// The chat shows one line of link text under the code block (src/markdown.ts previewLine); a press sends the block as
// the reply wrote it, with the reply's CSS blocks, and this opens it: one tab a page, the same page again shows its
// tab. The tab can run nothing and reach nothing: the webview has scripts off and no local files, its
// Content-Security-Policy has no script-src and lets in only inline styles and data: images and fonts, and the page
// itself sits in frames with an empty sandbox, so its links, its forms and anything it would load do nothing. With no
// script to run, the tab's one control, the ground switch, is two radio buttons and CSS.
import { createHash } from "node:crypto";
import * as vscode from "vscode";

export const CODE_PREVIEW_VIEW = "dgc.codePreview";
/** The whole policy: no script-src, no connect-src, no frame-src; what isn't named falls to 'none'. */
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
/** A page and its CSS over this many bytes isn't drawn. */
export const PREVIEW_LIMIT = 512 * 1024;
export type PreviewKind = "html" | "svg";
export type CodePreview = { kind: PreviewKind; title: string; html: string; css: string[] };

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const GROUNDS = { light: "#ffffff", dark: "#1f1f1f" } as const;
type Ground = keyof typeof GROUNDS;

/** One short line of text, whatever was sent. */
function titleOf(value: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim() || "page";
  return text.length > 80 ? text.slice(0, 80).trimEnd() : text;
}

/** What a chat's page sent, if it is a preview to open. */
export function readPreview(message: unknown): CodePreview | undefined {
  const m = message as any;
  if (!m || typeof m !== "object" || m.type !== "codePreview") return;
  if (m.kind !== "html" && m.kind !== "svg") return;
  if (typeof m.html !== "string" || !m.html.trim() || typeof m.title !== "string") return;
  if (!Array.isArray(m.css) || m.css.length > 64 || m.css.some((sheet: unknown) => typeof sheet !== "string")) return;
  return { kind: m.kind, title: titleOf(m.title), html: m.html, css: m.kind === "html" ? m.css : [] };
}

const bytes = (view: CodePreview) => Buffer.byteLength(view.html, "utf8") + view.css.reduce((sum, sheet) => sum + Buffer.byteLength(sheet, "utf8"), 0);
export const tooLarge = (view: CodePreview) => bytes(view) > PREVIEW_LIMIT;

// A link out of the page points nowhere (one within the page still works), and what would move or re-aim the page by
// itself is taken out. The policy and the sandbox already stop all of it; this keeps a stopped navigation from blanking
// the frame, so "links do nothing" is what you see.
function inert(page: string): string {
  return page
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b[^>]*>/gi, "")
    .replace(/<(a|area)\b[^>]*>/gi, (tag) => tag.replace(/(\s(?:xlink:)?href\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
      (_all, lead: string, dq?: string, sq?: string, bare?: string) => {
        const target = (dq ?? sq ?? bare ?? "").trim();
        return `${lead}"${/^#[^\s"<>]*$/.test(target) ? target : "#"}"`;
      }));
}
/** CSS as the text of a <style>: nothing in it can end the element. */
const sheetText = (css: string) => css.replace(/<\/(?=style)/gi, "<\\/").replace(/<!--/g, "<\\!--");

/** The page as written, on one ground: the ground first in its head (so the page's own colours win), the reply's CSS
 *  after the page's own head. A fragment gets a standards-mode page around it; an SVG is drawn in the middle. */
export function previewPage(view: CodePreview, ground: Ground): string {
  const base = `<base href="about:srcdoc"><style>:root{color-scheme:${ground};background:${GROUNDS[ground]}}</style>`;
  const sheets = view.css.map((css) => `<style>${sheetText(css)}</style>`).join("");
  if (view.kind === "svg") {
    return `<!doctype html><html><head><meta charset="utf-8">${base}<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;padding:24px;box-sizing:border-box}svg{max-width:100%;max-height:100%}</style></head><body>${inert(view.html)}</body></html>`;
  }
  let page = inert(view.html);
  const head = /<head\b[^>]*>/i.exec(page), html = /<html\b[^>]*>/i.exec(page), doctype = /^\s*<!doctype[^>]*>/i.exec(page);
  if (!head && !html && !doctype && !/<body\b/i.test(page)) {
    return `<!doctype html><html><head><meta charset="utf-8">${base}${sheets}</head><body>${page}</body></html>`;
  }
  const at = head ? head.index + head[0].length : html ? html.index + html[0].length : doctype ? doctype[0].length : 0;
  page = page.slice(0, at) + base + page.slice(at);
  if (!sheets) return page;
  const end = /<\/head\s*>/i.exec(page);
  const to = end ? end.index : at + base.length;
  return page.slice(0, to) + sheets + page.slice(to);
}

const TAB_CSS = `
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:var(--vscode-editor-background,#1f1f1f);color:var(--vscode-foreground,#cccccc);font:var(--vscode-font-size,13px)/1.4 var(--vscode-font-family,system-ui,sans-serif);overflow:hidden}
.choice{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
.grounds{align-self:flex-end;flex:none;display:flex;gap:2px;margin:6px 8px;padding:2px;border:1px solid var(--vscode-widget-border,rgba(128,128,128,.35));border-radius:8px}
.grounds label{padding:1px 9px;border-radius:6px;font-size:11px;line-height:18px;color:var(--vscode-descriptionForeground,inherit);cursor:pointer;user-select:none}
.grounds label:hover{color:var(--vscode-foreground,inherit)}
.page{flex:1 1 auto;min-height:0;width:100%;border:0;display:block}
.page.dark{display:none}
body.vscode-dark .page.light,body.vscode-high-contrast:not(.vscode-high-contrast-light) .page.light{display:none}
body.vscode-dark .page.dark,body.vscode-high-contrast:not(.vscode-high-contrast-light) .page.dark{display:block}
.grounds label[for="ground-light"],body.vscode-dark .grounds label[for="ground-dark"],body.vscode-high-contrast:not(.vscode-high-contrast-light) .grounds label[for="ground-dark"]{background:rgba(128,128,128,.24);color:var(--vscode-foreground,inherit)}
body.vscode-dark .grounds label[for="ground-light"],body.vscode-high-contrast:not(.vscode-high-contrast-light) .grounds label[for="ground-light"]{background:transparent;color:var(--vscode-descriptionForeground,inherit)}
#ground-light:checked~.page.light,#ground-dark:checked~.page.dark{display:block}
#ground-light:checked~.page.dark,#ground-dark:checked~.page.light{display:none}
#ground-light:checked~.grounds label[for="ground-light"],#ground-dark:checked~.grounds label[for="ground-dark"]{background:rgba(128,128,128,.24);color:var(--vscode-foreground,inherit)}
#ground-light:checked~.grounds label[for="ground-dark"],#ground-dark:checked~.grounds label[for="ground-light"]{background:transparent;color:var(--vscode-descriptionForeground,inherit)}
#ground-light:focus-visible~.grounds label[for="ground-light"],#ground-dark:focus-visible~.grounds label[for="ground-dark"]{outline:1px solid var(--vscode-focusBorder,#0078d4);outline-offset:1px}
.too-large{margin:auto;padding:24px;color:var(--vscode-descriptionForeground,inherit);text-align:center}
`.replace(/\n/g, "");

/** The tab's own page: the policy, the ground switch, and the page as written in a frame for each ground. */
export function previewDocument(view: CodePreview): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(`Preview · ${view.title}`)}</title><style>${TAB_CSS}</style></head>`;
  if (tooLarge(view)) return `${head}<body><p class="too-large">Too large to preview</p></body></html>`;
  const frame = (ground: Ground) => `<iframe class="page ${ground}" data-ground="${ground}" sandbox="" title="${escape(`Preview of ${view.title}`)}" srcdoc="${escape(previewPage(view, ground))}"></iframe>`;
  // Neither choice is made to begin with: the ground follows the editor's theme until you pick one.
  return `${head}<body><input class="choice" type="radio" name="ground" id="ground-light" aria-label="Light ground"><input class="choice" type="radio" name="ground" id="ground-dark" aria-label="Dark ground">`
    + `<div class="grounds" role="group" aria-label="Ground"><label for="ground-light">Light</label><label for="ground-dark">Dark</label></div>`
    + `${frame("light")}${frame("dark")}</body></html>`;
}

const open = new Map<string, vscode.WebviewPanel>();

/** Opens what a chat's page sent in a tab beside, or shows the tab that already holds it. False: it wasn't a preview. */
export function openCodePreview(message: unknown): boolean {
  const view = readPreview(message);
  if (!view) return false;
  const key = createHash("sha256").update(JSON.stringify([view.kind, view.html, view.css])).digest("hex");
  const shown = open.get(key);
  if (shown) { shown.reveal(undefined, false); return true; }
  const panel = vscode.window.createWebviewPanel(CODE_PREVIEW_VIEW, `Preview · ${view.title}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: false, enableForms: false, enableCommandUris: false, localResourceRoots: [] });
  open.set(key, panel);
  panel.onDidDispose(() => { if (open.get(key) === panel) open.delete(key); });
  panel.webview.html = previewDocument(view);
  return true;
}
