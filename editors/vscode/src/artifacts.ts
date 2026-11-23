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
import * as path from "path";
import { randomBytes } from "crypto";
import { CANVAS_DOC_VIEW } from "./canvasDoc";
import { downloadFile, type DownloadPage } from "./download";
import { tabIcon } from "./tabIcon";
import { cleanEvery, filePaths, watchFiles } from "./dashboardWatch";

export { ArtifactNotice, madeWords, ARTIFACT_NOTICED_KEY, type MadeNotice } from "./artifactNotice";

export const ARTIFACT_PANEL = "dgc.artifactPanel";
export const ARTIFACT_PRESENT = "dgc.artifactPresent";
export const ARTIFACT_ID = /^ar_[a-f0-9]{16}$/;
export const ARTIFACT_TYPES = ["page", "doc", "slides", "sheet", "dashboard", "checklist", "design"];
/** The answers this hub takes (onEvent); the panel routes exactly these to it, so the two can never differ. */
export const ARTIFACT_EVENTS = ["artifact_items", "artifact_changed", "artifact_detail", "artifact_served", "artifact_exported",
  "artifact_comparison", "artifact_comments"];
/** The Output chip's choices, in its menu's order; "auto" lets the model choose (and is never sent). */
export const ARTIFACT_OUTPUTS = ["auto", "document", "slides", "spreadsheet", "page", "dashboard"];
const LABELS: Record<string, string> = { doc: "Document", slides: "Slides", sheet: "Spreadsheet", dashboard: "Dashboard", page: "Page", checklist: "Checklist", design: "Design" };
export const FORMAT_LABELS: Record<string, string> = {
  docx: "Word document (.docx)", pdf: "PDF", md: "Markdown (.md)", pptx: "PowerPoint (.pptx)", html: "Web page (.html)",
  xlsx: "Excel workbook (.xlsx)", csv: "CSV (first sheet)", zip: "Zip of its files (.zip)", png: "Picture (.png)",
};
/** A design's own words for its formats (its zip holds a picture of each artboard, its PDF a page for each). */
export const DESIGN_FORMAT_LABELS: Record<string, string> = {
  zip: "Every artboard as pictures (.zip)", pdf: "PDF, an artboard a page", html: "The canvas as a web page (.html)", png: "Picture (.png)",
};
/** What a format is called for this kind of artifact. */
export const formatLabel = (type: string, format: string): string => (type === "design" ? DESIGN_FORMAT_LABELS[format] : undefined) || FORMAT_LABELS[format] || format;
const BOARD_ID = /^b[1-9][0-9]{0,4}$/;
/** A served page DGC lays out is at most this big (a deck's pictures are inside it). */
const MAX_PAGE_BYTES = 60 * 1024 * 1024;
const MAX_REQUESTS = 256;
/** A save is one command frame (4 MiB, editor_protocol.MAX_COMMAND_BYTES) with room for its envelope. */
const MAX_SAVE_BYTES = 4 * 1024 * 1024 - 64 * 1024;
/** A doc's working file, wherever the store is: `<store>/ar_…/work/<title>.md`. */
const DOC_FILE = /[\\/](ar_[a-f0-9]{16})[\\/]work[\\/][^\\/]+$/;

export type ArtifactsOffer = { version: number; types: string[]; outputs: string[]; exports: Record<string, string[]>; present: boolean; compare?: boolean; sourceConsentVersion?: boolean;
                               /** artifact_comment_* and artifact_suggestion_* are understood (dgc/artifact_comments). */
                               comments?: boolean;
                               /** The "design" type is understood: artifact_design_edit, artifact_export's `board`. */
                               designs?: boolean };
/** How far along a checklist is: its items done of all, the ones that need you, the next one, pinned to its project. */
export type ChecklistProgress = { done: number; total: number; needs: string[]; next?: { id: string; title: string; status: string };
                                  waiting?: { id: string; title: string }; pinned: boolean };
export type ArtifactView = {
  id: string; type: string; label: string; title: string; version: number; created?: string; updated?: string;
  origin?: Record<string, unknown>; exports: string[]; link?: Record<string, unknown>; canvas?: string; file?: string;
  versions?: { n: number; author: string; at: string; summary: string; size?: number }[];
  allowed_sources?: string[];
  progress?: ChecklistProgress;
  /** Who made it: {kind: pip|session|chat|app|cli, id, name} (name "" when DGC does not know it). */
  made_by?: { kind: string; id: string; name: string };
  /** A Page a reply's card ("card") or a ChatDGC widget ("widget") made. */
  made_as?: "card" | "widget";
  /** Its comment threads, counted: the open ones and all (the Library row says how many are open). */
  comments?: { open: number; all: number };
  /** A design: how many artboards it has, how many are still to draw, and its pages. */
  design?: { boards: number; drawing: number; pages: number };
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
           ...(Number(raw.source_consent_version) >= 1 ? { sourceConsentVersion: true } : {}),
           ...(Number(raw.comments) >= 1 ? { comments: true } : {}),
           ...(Number(raw.designs) >= 1 ? { designs: true } : {}) };
}

/** What a send carries for the Output chip: the choice when it isn't Auto and the process offers it, else "". */
export function outputChoice(value: unknown, offer: ArtifactsOffer | undefined): string {
  const choice = typeof value === "string" ? value : "";
  if (!offer || !choice || choice === "auto" || !ARTIFACT_OUTPUTS.includes(choice)) return "";
  return offer.outputs.length && !offer.outputs.includes(choice) ? "" : choice;
}

/** A checklist's progress as the process said it, checked: {done, total, needs, next?, pinned}. */
export function checklistProgress(raw: any): ChecklistProgress | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 100000 ? (v as number) : 0);
  const total = count(raw.total), done = Math.min(count(raw.done), total);
  const next = raw.next && typeof raw.next === "object" && /^c[1-9][0-9]{0,4}$/.test(String(raw.next.id || ""))
    ? { id: String(raw.next.id), title: String(raw.next.title || "").slice(0, 200), status: String(raw.next.status || "").slice(0, 24) } : undefined;
  const waiting = raw.waiting && typeof raw.waiting === "object" && /^c[1-9][0-9]{0,4}$/.test(String(raw.waiting.id || ""))
    ? { id: String(raw.waiting.id), title: String(raw.waiting.title || "").slice(0, 200) } : undefined;
  return { done, total, needs: Array.isArray(raw.needs) ? raw.needs.filter((id: unknown) => typeof id === "string" && /^c[1-9][0-9]{0,4}$/.test(id)).slice(0, 200) : [],
           ...(next ? { next } : {}), ...(waiting ? { waiting } : {}), pinned: raw.pinned === true };
}

/** Work's list: the pinned checklists of one project folder (`folder`), or of every folder (`everywhere`, each then
 *  with its folder's name), the latest change first: {id, title, done, total, next, needs, folder}. */
export function workChecklistRows(views: ArtifactView[], folder: string, everywhere = false): Record<string, unknown>[] {
  const same = (a: string, b: string) => !!a && !!b && path.resolve(a) === path.resolve(b);
  return views.filter((view) => view.type === "checklist" && view.progress?.pinned === true)
    .map((view) => ({ view, project: typeof view.origin?.project === "string" ? String(view.origin.project) : "" }))
    .filter(({ project }) => (everywhere ? !!project : same(project, folder)))
    .sort((a, b) => String(b.view.updated || "").localeCompare(String(a.view.updated || "")))
    .slice(0, 8)
    .map(({ view, project }) => ({ id: view.id, title: view.title, done: view.progress!.done, total: view.progress!.total,
      next: view.progress!.next?.title || "", needs: view.progress!.waiting?.title || "",
      ...(everywhere ? { folder: path.basename(project) || project } : {}) }));
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
  // Who made it (0.52): a Pip, a Work session, a chat, an app or the terminal, by name when DGC knows it.
  if (raw.made_by && typeof raw.made_by === "object" && typeof raw.made_by.kind === "string" && /^[a-z_]{1,24}$/.test(raw.made_by.kind)) {
    view.made_by = { kind: raw.made_by.kind, id: text(raw.made_by.id, 128), name: text(raw.made_by.name, 120) };
  }
  // A Page that a reply's card or a ChatDGC widget made: the Library's Widgets. Said as `made_as`, or read from the
  // artifact's `legacy` record when the process lists that (card, widget).
  const legacy = raw.legacy && typeof raw.legacy === "object" ? raw.legacy : {};
  const as = raw.made_as === "card" || raw.made_as === "widget" ? raw.made_as : legacy.card ? "card" : legacy.widget ? "widget" : "";
  if (as) view.made_as = as;
  if (raw.link && typeof raw.link === "object") view.link = { ...raw.link };
  if (typeof raw.canvas === "string") view.canvas = raw.canvas.slice(0, 40);
  if (typeof raw.file === "string" && raw.file.length < 4096) view.file = raw.file;
  if (Array.isArray(raw.versions)) {
    view.versions = raw.versions.filter((v: any) => v && Number.isSafeInteger(v.n)).slice(-500)
      .map((v: any) => ({ n: v.n, author: text(v.author, 60), at: text(v.at, 40), summary: text(v.summary, 200), size: Number(v.size) || 0 }));
  }
  // Which of a dashboard's sources the user allowed (when the process says; see the panel for when it doesn't).
  if (Array.isArray(raw.allowed_sources)) view.allowed_sources = raw.allowed_sources.filter((s: unknown) => typeof s === "string").slice(0, 32);
  // A checklist: how far along it is (its card, the Library and Work's list say it without reading the list).
  const progress = checklistProgress(raw.progress);
  if (raw.type === "checklist" && progress) view.progress = progress;
  if (raw.type === "design" && raw.design && typeof raw.design === "object") {
    const count = (v: unknown, most: number) => (Number.isSafeInteger(v) && (v as number) >= 0 ? Math.min(v as number, most) : 0);
    const boards = count(raw.design.boards, 500);
    view.design = { boards, drawing: Math.min(count(raw.design.drawing, 500), boards), pages: Math.max(1, count(raw.design.pages, 50)) };
  }
  const said = raw.comments;
  if (said && typeof said === "object" && Number.isSafeInteger(said.all) && said.all > 0 && said.all <= 500) {
    view.comments = { open: Number.isSafeInteger(said.open) ? Math.max(0, Math.min(said.open, said.all)) : 0, all: said.all };
  }
  return view;
}

// ---- comments (dgc/artifact_comments): what a page may ask, checked here before it goes to the process
const COMMENT_COMMANDS: Record<string, string> = {
  list: "artifact_comment_list", add: "artifact_comment_add", reply: "artifact_comment_reply", resolve: "artifact_comment_resolve",
  delete: "artifact_comment_delete", ask: "artifact_comment_ask", accept: "artifact_suggestion_accept", reject: "artifact_suggestion_reject",
};
const THREAD_ID = /^t_[a-f0-9]{12}$/;
const SUGGESTION_ID = /^s_[a-f0-9]{12}$/;
const MAX_COMMENT = 4000;

/** What a comment points at, as a page said it: only the fields a place has, as the right kinds (the process checks it
 *  again for the artifact's type). Undefined when it isn't one. */
export function commentAnchor(raw: any): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || !["text", "cells", "slide", "item", "element", "artboard", "whole"].includes(String(raw.kind))) return undefined;
  const out: Record<string, unknown> = { kind: raw.kind };
  const text = (key: string, max: number) => { if (typeof raw[key] === "string" && raw[key]) out[key] = raw[key].slice(0, max); };
  text("quote", 2000); text("before", 200); text("after", 200); text("sheet", 80); text("range", 24); text("field", 20);
  text("title", 200); text("item", 8); text("path", 600); text("near", 200); text("tag", 20);
  if (raw.kind === "artboard") { if (!BOARD_ID.test(String(raw.board || ""))) return undefined; out.board = raw.board; }
  if (Number.isSafeInteger(raw.slide) && raw.slide > 0 && raw.slide <= 1000) out.slide = raw.slide;
  if (Array.isArray(raw.values) && raw.values.length <= 50 && raw.values.every((row: unknown) => Array.isArray(row) && row.length <= 50)
      && raw.values.flat().length <= 50
      && raw.values.flat().every((v: unknown) => v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 2000))) {
    out.values = raw.values;
  }
  return out;
}

/** A page's {type: "comments", op, …} as the command the process takes, or undefined when it isn't one. */
export function commentCommand(id: string, message: any): Record<string, unknown> | undefined {
  const op = String(message?.op || "");
  const type = COMMENT_COMMANDS[op];
  if (!type || !ARTIFACT_ID.test(String(id || ""))) return undefined;
  const cmd: Record<string, unknown> = { type, id };
  if (op !== "list" && op !== "add") {
    if (!THREAD_ID.test(String(message.thread || ""))) return undefined;
    cmd.thread = message.thread;
  }
  if (op === "accept" || op === "reject") {
    if (!SUGGESTION_ID.test(String(message.suggestion || ""))) return undefined;
    cmd.suggestion = message.suggestion;
  }
  if (op === "add" || op === "reply") {
    const words = typeof message.text === "string" ? message.text.trim().slice(0, MAX_COMMENT) : "";
    if (!words) return undefined;
    cmd.text = words;
    if (message.ask === true) cmd.ask = true;
  }
  if (op === "add") {
    const anchor = commentAnchor(message.anchor);
    if (!anchor) return undefined;
    cmd.anchor = anchor;
    if (Number.isSafeInteger(message.version) && message.version > 0) cmd.version = message.version;
  }
  if (op === "resolve") {
    if (typeof message.resolved !== "boolean") return undefined;
    cmd.resolved = message.resolved;
  }
  return cmd;
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

/** A link to DGC's artifact page (`http://127.0.0.1:45000/?a=<id>`, the list with a frame) in a remote window. That page
 *  frames each artifact from its own port, its own origin, so a script in one can't read the list, its stop token or another
 *  artifact; forwarding the list alone leaves the frame on a port the person's browser can't reach. So a remote window
 *  forwards an artifact's own address and opens that, as a card's Open in browser does. Separate origins stay.
 *  The page is the one the link names (`?a=<id>`, or an old `/a/<id>/<path>` link with the rest of it); the only one; or
 *  the one picked from their names, as the list would have shown them. Null when that pick was dismissed: open nothing.
 *  Undefined for a local window, a link that isn't one to that page, or a list with no pages (it opens as it is). */
export async function forwardedArtifactPage(raw: string): Promise<vscode.Uri | null | undefined> {
  if (!vscode.env?.remoteName) return undefined;
  let link: URL;
  try { link = new URL(raw); } catch { return undefined; }
  if (link.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(link.hostname) || !link.port) return undefined;
  const old = /^\/a\/([^/]+)(?:\/(.*))?$/.exec(link.pathname);
  if (!old && !["/", "/index.html"].includes(link.pathname)) return undefined;
  let pages: { id: string; name: string; path: string; port: number; uptime?: string }[];
  try {
    const listed = JSON.parse(await fetchPage(`http://127.0.0.1:${link.port}/_list`, 1024 * 1024, 5000));
    if (!Array.isArray(listed?.artifacts)) return undefined;
    pages = listed.artifacts.filter((row: any) => typeof row?.id === "string" && Number.isSafeInteger(row.port)
      && typeof row.path === "string" && row.path.startsWith("/"));
  } catch { return undefined; }
  if (!pages.length) return undefined;
  let wanted: string | null = null;
  try { wanted = old ? decodeURIComponent(old[1]) : link.searchParams.get("a"); } catch { wanted = null; }
  let page = wanted ? pages.find((row) => row.id === wanted) : undefined;
  if (!page && !wanted && pages.length === 1) page = pages[0];
  if (!page) {
    const picked = await vscode.window.showQuickPick(
      pages.map((row) => ({ label: String(row.name || row.id).slice(0, 200), description: row.uptime ? `up ${row.uptime}` : undefined, row })),
      { title: "Open a page", placeHolder: wanted
          ? "The page that link names isn't being served now. Pick one to open in your browser."
          : `DGC is serving ${pages.length} pages. Pick one to open in your browser.` });
    if (!picked) return null;
    page = picked.row;
  }
  // An old link keeps the rest of its path, its query and its fragment (the list's own redirect keeps the path).
  const rest = old && page.id === wanted && old[2] ? `/${old[2]}${link.search}${link.hash}` : page.path;
  try { return await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${page.port}${rest}`, true)); } catch { return undefined; }
}

// Download a copy (src/download.ts, the one module): the file goes to the page that asked, which saves it on the
// person's computer; one too large for a page goes to their browser. Kept here by name for the tests that knew it here.
export { DOWNLOAD_MINUTES, downloadThroughBrowser } from "./download";

/** The artifact panel's page. Its frames: a page artifact at its own address (frame-src), and DGC's own layout of a
 *  deck, a sheet or a dashboard as text the host fetched (srcdoc, sandboxed with no script). A page is served on this
 *  computer (127.0.0.1), or over https when asExternalUri forwards it for a remote window; nothing else is framed.
 *  A design's artboards are frames too (srcdoc, sandboxed with no origin): a srcdoc frame keeps this page's policy,
 *  so the only script one can run carries this page's nonce: DGC's own helper, which media/artifactDesign.js writes
 *  into it (it reads the nonce from the `dgc-frame-nonce` meta), and an interactive artboard's own while it plays.
 *  Pictures, fonts and sound in an artboard are data inside it (data:, blob:); nothing in one is fetched. */
export function artifactDocument(asset: (name: string) => string, cspSource: string, nonce: string): string {
  const s = (name: string) => `<script nonce="${nonce}" src="${attr(asset(name))}"></script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data: blob:; font-src ${attr(cspSource)} data:; media-src data: blob:; style-src ${attr(cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src http://127.0.0.1:* http://localhost:* https:;">
<link rel="stylesheet" href="${attr(asset("media/codicon.css"))}"><link rel="stylesheet" href="${attr(asset("media/main.css"))}"><link rel="stylesheet" href="${attr(asset("media/artifact.css"))}"><link rel="stylesheet" href="${attr(asset("media/artifactDesign.css"))}">
<meta name="dgc-frame-nonce" content="${nonce}">
<title>Artifact</title></head><body class="art-body">
<header class="art-head" id="art-head">
<span class="art-mark" id="art-mark" aria-hidden="true"><span class="codicon codicon-file"></span></span>
<div class="art-titles"><h1 class="art-title" id="art-title">Loading…</h1><p class="art-meta" id="art-meta"></p></div>
<div class="art-actions" id="art-actions" role="toolbar" aria-label="Artifact">
<button type="button" class="art-btn" id="art-comments-btn" aria-pressed="false" aria-controls="art-comments" title="Comments: what you and DGC said about parts of it" hidden><span class="art-glyph" data-dgc-icon="comment" data-dgc-icon-size="14" aria-hidden="true"></span><span class="art-btn-label">Comments</span><span class="art-count" id="art-comments-count"></span></button>
<button type="button" class="art-btn" id="art-versions" aria-haspopup="dialog" aria-expanded="false" title="Every version: who made it, when, and what changed" disabled><span class="codicon codicon-history" aria-hidden="true"></span><span class="art-btn-label">Versions</span></button>
<div class="art-menu-wrap"><button type="button" class="art-btn" id="art-export" aria-haspopup="menu" aria-expanded="false" title="Download a copy" disabled><span class="art-glyph" data-dgc-icon="download" data-dgc-icon-size="14" aria-hidden="true"></span><span class="art-btn-label">Download</span><span class="codicon codicon-chevron-down art-caret" aria-hidden="true"></span></button>
<div class="art-menu dgc-popover" id="art-export-menu" role="menu" aria-label="Download as" hidden></div></div>
<button type="button" class="art-btn" id="art-browser" title="Open it in your browser, at an address of its own" disabled><span class="codicon codicon-link-external" aria-hidden="true"></span><span class="art-btn-label">Open in browser</span></button>
</div></header>
<section class="art-versions dgc-popover" id="art-versions-panel" role="dialog" aria-label="Versions" hidden><div class="art-versions-head"><h2>Versions</h2><button type="button" class="art-icon" id="art-versions-close" title="Close" aria-label="Close versions"><span class="codicon codicon-close" aria-hidden="true"></span></button></div><ol class="art-version-list" id="art-version-list"></ol></section>
<div class="art-banner" id="art-banner" role="alert" hidden></div>
<div class="art-work" id="art-work"><main class="art-main" id="art-main"><p class="art-empty" id="art-loading">Loading…</p></main>
<aside class="art-comments" id="art-comments" aria-label="Comments" hidden></aside></div>
<div class="sr-only" id="art-announce" aria-live="polite"></div>
${s("media/shared/menu.js")}${s("media/shared/icons.js")}${s("media/shared/dismiss.js")}${s("media/shared/download.js")}${s("media/shared/comments.js")}${s("media/sheetRefs.js")}${s("media/artifactSlides.js")}${s("media/artifactSheet.js")}${s("media/artifactChecklist.js")}${s("media/artifactDesign.js")}${s("media/artifact.js")}
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
  private serveSeq = 0;
  private loadSeq = 0;

  private unwatch?: () => void;    // a live dashboard's watch on its files (src/dashboardWatch.ts)
  private comments?: vscode.Disposable;   // its comment threads, heard as they change
  private filesPending = false;    // they changed while the panel wasn't showing

  constructor(private readonly hub: Artifacts, readonly id: string, readonly panel: vscode.WebviewPanel) {
    panel.webview.onDidReceiveMessage((message) => { void this.fromPage(message); });
    panel.onDidChangeViewState?.(() => {
      if (this.panel.visible && this.filesPending) { this.filesPending = false; this.post({ type: "filesChanged" }); }
    });
    panel.onDidDispose(() => { this.unwatch?.(); this.unwatch = undefined; this.comments?.dispose(); this.comments = undefined; hub.forget(this); });
  }

  /** One of a live dashboard's files changed: its page refreshes, now if it shows, else when it shows again. */
  private filesChanged(): void {
    if (this.panel.visible) this.post({ type: "filesChanged" }); else this.filesPending = true;
  }

  post(message: Record<string, unknown>): void {
    if (!this.ready) { this.queue.push(message); return; }
    void this.panel.webview.postMessage(message);
  }

  /** The artifact as it is now, with its content for the editor; then what shows it. */
  load(): void {
    const seq = ++this.loadSeq;
    this.hub.ask({ type: "artifact_get", id: this.id, content: true }, {
      ok: (ev) => {
        if (seq !== this.loadSeq) return;
        const view = artifactView(ev.artifact);
        if (!view || (this.view && view.version < this.view.version)) return;
        this.view = view;
        this.panel.title = view.title;
        this.post({ type: "detail", artifact: view, content: ev.content ?? null, state: ev.state && typeof ev.state === "object" ? ev.state : null,
                    offer: this.hub.offers() ?? null, ...(view.type === "dashboard" ? { refreshEvery: this.hub.refreshEvery(this.id) } : {}) });
        // (A design's canvas draws its artboards itself, from the content: nothing of it is served.)
        if (view.type !== "doc" && view.type !== "design") this.serve();
      },
      fail: (reason, message) => { if (seq === this.loadSeq) this.post({ type: "rejected", what: "load", reason, message }); },
    });
  }

  /** Its own address (artifact_open), framed when it's a page; DGC's layout of a deck, sheet or dashboard, read here
   *  and handed to the page as text, so no webview needs to reach the address. */
  serve(): void {
    const version = this.view?.version ?? 0;
    const seq = ++this.serveSeq;
    const current = () => seq === this.serveSeq && this.view?.version === version;
    this.servedFor = version;
    this.servedUrl = "";
    this.hub.ask({ type: "artifact_open", id: this.id }, {
      ok: async (ev) => {
        if (!current()) return;
        const url = String(ev.url || "");
        if (!/^https?:\/\//i.test(url)) return;
        if (this.view?.type === "page") {
          let shown = url;
          try { shown = (await vscode.env.asExternalUri(vscode.Uri.parse(url, true))).toString(true); } catch { /* as it is */ }
          if (!current()) return;
          this.servedUrl = url;
          this.post({ type: "frame", url: shown, version });
          return;
        }
        try {
          const html = await fetchPage(url);
          if (current()) this.post({ type: "render", html, version });
        } catch (err: any) {
          if (current()) this.post({ type: "render", error: `DGC's view of it didn't load: ${String(err?.message || err)}`, version });
        }
      },
      fail: (reason, message) => { if (current()) this.post({ type: "render", error: message || reason, version }); },
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
        this.comments?.dispose();
        this.comments = this.hub.watchComments(this.id, (m) => this.post(m));
        return;
      case "comments": this.hub.comment(this.id, message, (m) => this.post(m)); return;
      case "reload": this.load(); return;
      case "preview": if (view && view.type !== "doc" && view.type !== "design") this.serve(); return;
      case "designEdit": {
        // A change made on a design's canvas: ops, as DGC's own edits are, one version by you.
        if (view?.type !== "design" || !Array.isArray(message.edits) || !message.edits.length || message.edits.length > 20) return;
        const edits = message.edits.filter((e: unknown) => e && typeof e === "object" && typeof (e as any).op === "string" && (e as any).op !== "measured");
        if (edits.length !== message.edits.length) return;
        if (Buffer.byteLength(JSON.stringify(edits), "utf8") > MAX_SAVE_BYTES) {
          this.post({ type: "rejected", what: "save", reason: "too_large", message: "That change is more than one save from the editor can carry. Ask DGC to make it." });
          return;
        }
        this.hub.ask({ type: "artifact_design_edit", id: this.id, edits }, {
          ok: (ev) => { const next = artifactView(ev.artifact); if (next) { this.view = next; this.post({ type: "saved", artifact: next }); } this.load(); },
          fail: (reason, text) => this.post({ type: "rejected", what: "save", reason, message: text }),
        });
        return;
      }
      case "designMeasured":
        // How tall a whole-page artboard is at its width, as its frame measured it: remembered, never a version.
        if (view?.type === "design" && BOARD_ID.test(String(message.board || "")) && Number.isSafeInteger(message.h) && message.h >= 100 && message.h <= 20000) {
          this.hub.ask({ type: "artifact_design_edit", id: this.id, edits: [{ op: "measured", board: message.board, h: message.h }] }, { ok: () => undefined, fail: () => undefined });
        }
        return;
      case "askChat":
        if (view?.type === "design") this.hub.askInChat(view, message);
        return;
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
          void this.hub.exportArtifact(view, message.format, Number.isSafeInteger(message.version) ? message.version : undefined,
                                       (m) => { this.post(m as Record<string, unknown>); return true; },
                                       view.type === "design" && BOARD_ID.test(String(message.board || "")) ? String(message.board) : undefined);
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
      case "refreshEvery": {
        // How often a dashboard refreshes by itself (its page keeps the timer); "files": on its files' change, watched here.
        const every = cleanEvery(message.every);
        if (view?.type !== "dashboard" || every === undefined) return;
        void this.hub.setRefreshEvery(this.id, every);
        this.unwatch?.(); this.unwatch = undefined; this.filesPending = false;
        if (every === "files") {
          const project = typeof (view as any).origin?.project === "string" ? String((view as any).origin.project) : undefined;
          this.unwatch = watchFiles(filePaths(message.files, project), () => this.filesChanged());
        }
        return;
      }
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

/** Each dashboard's own refresh choice (src/dashboardWatch.ts), in the editor's global state. */
const REFRESH_KEY = "dgc.dashboardRefresh";

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
  /** The pages showing an artifact's comments (its panel, a document's editor), by artifact. */
  private readonly commentWatch = new Map<string, Set<(message: Record<string, unknown>) => void>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** A page that shows this artifact's comments hears every change to them (artifact_comments), from now on; its
   *  threads are asked at once (again when the process is ready, if it is still starting). */
  watchComments(id: string, post: (message: Record<string, unknown>) => void): vscode.Disposable {
    if (!ARTIFACT_ID.test(String(id || ""))) return { dispose: () => undefined };
    const set = this.commentWatch.get(id) ?? new Set();
    set.add(post);
    this.commentWatch.set(id, set);
    if (this.offers()?.comments) this.comment(id, { op: "list" }, post);
    return { dispose: () => { set.delete(post); if (!set.size && this.commentWatch.get(id) === set) this.commentWatch.delete(id); } };
  }

  /** What a page asked of an artifact's comments ({op: list|add|reply|resolve|delete|ask|accept|reject, …}), checked
   *  and sent; its answer (the threads) goes to every page watching. A refusal goes back to the page that asked. */
  comment(id: string, message: unknown, post?: (message: Record<string, unknown>) => void): void {
    if (!this.offers()?.comments) return;
    const cmd = commentCommand(id, message);
    if (!cmd) return;
    const op = String((message as any)?.op || "");
    this.ask(cmd, {
      ok: () => undefined,
      fail: (reason, text) => { try { post?.({ type: "commentsRejected", op, reason, message: text }); } catch { /* the page closed */ } },
    });
  }

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
    if (this.offers()?.comments) for (const [id, set] of this.commentWatch) for (const post of set) this.comment(id, { op: "list" }, post);
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
    if (!ARTIFACT_EVENTS.includes(type)) return false;
    if (type === "artifact_comments") {
      // An artifact's threads now: to every page showing them, and a count to every screen (the Library row).
      const id = String(ev.id || "");
      if (ARTIFACT_ID.test(id) && Array.isArray(ev.threads)) {
        const threads = ev.threads.slice(0, 500);
        const message = { type: "comments", id, version: Number.isSafeInteger(ev.version) ? ev.version : 0, threads };
        for (const post of [...(this.commentWatch.get(id) ?? [])]) { try { post(message); } catch { /* one page never stops the rest */ } }
        this.tell({ type: "artifactComments", id, open: threads.filter((t: any) => t?.status !== "resolved").length, all: threads.length });
      }
      if (reply) { this.requests.delete(requestId); reply.ok(ev); }
      return true;
    }
    if (type === "artifact_changed") {
      const view = artifactView(ev.artifact);
      if (view) {
        const op = String(ev.op || "changed");
        this.remember(view);
        const panel = this.panels.get(view.id);
        panel?.changed(view, op, !!reply);
        // `mine`: it answers this window's own request (a panel's save), so it is no news to this window.
        this.tell({ type: "artifactChanged", artifact: view, op, surface: typeof ev.surface === "string" ? ev.surface : "",
                    conversation_id: typeof ev.conversation_id === "string" ? ev.conversation_id : "", mine: !!reply });
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

  /** Whether this artifact is on screen in a tab already: its panel, or a document's editor over its working file. */
  showing(id: string): boolean {
    if (this.panels.has(id)) return true;
    try {
      for (const group of vscode.window.tabGroups?.all ?? []) {
        for (const tab of group.tabs ?? []) {
          const path = (tab.input as any)?.uri?.fsPath;
          if (typeof path === "string" && this.docFiles.get(this.key(path)) === id) return true;
        }
      }
    } catch { /* an editor without tab groups: only the panels are known */ }
    return false;
  }

  // ---- what the screens do

  /** Open an artifact: a document in the canvas editor over its file, everything else in its panel. `hint` is what a
   *  card or the Library already knows, so a document opens without asking first. */
  open(id: string, hint?: Partial<ArtifactView>): void {
    if (!ARTIFACT_ID.test(id)) return;
    // Opened, from wherever (its card in a session or a chat, the Library, Home): it is no longer news on Home (H1).
    this.tell({ type: "artifactOpened", id });
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

  /** How often a dashboard refreshes by itself, as the person chose it here ("" by hand): kept by the editor. */
  refreshEvery(id: string): string {
    try { return cleanEvery(this.context.globalState.get<Record<string, string>>(REFRESH_KEY)?.[id]) ?? ""; } catch { return ""; }
  }
  async setRefreshEvery(id: string, every: string): Promise<void> {
    try {
      const all = { ...(this.context.globalState.get<Record<string, string>>(REFRESH_KEY) || {}) };
      if (every) all[id] = every; else delete all[id];
      const keys = Object.keys(all);
      for (const key of keys.slice(0, Math.max(0, keys.length - 500))) delete all[key];      // (the newest 500)
      await this.context.globalState.update(REFRESH_KEY, all);
    } catch { /* kept for this panel only */ }
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

  /** Download a copy (src/download.ts): the process makes it, and its bytes go to `page`, the page it was asked from,
   *  which saves it on the person's computer (never a save dialog here: over a remote connection it would browse the
   *  remote machine). Asked from a command, with no page, the artifact's own panel opens and saves it. */
  async exportArtifact(view: Pick<ArtifactView, "id" | "title" | "exports" | "type">, format: string, version?: number, page?: DownloadPage,
                       board?: string): Promise<void> {
    // (One artboard of a design has formats the whole canvas doesn't: its picture.)
    const formats = board ? this.offers()?.exports[view.type] ?? [] : view.exports?.length ? view.exports : this.offers()?.exports[view.type] ?? [];
    if (!formats.includes(format)) return;
    let name = fileName(view.title, format);
    const made = new Promise<string>((resolve, reject) => {
      this.ask({ type: "artifact_export", id: view.id, format, ...(version ? { version } : {}), ...(board ? { board } : {}) }, {
        ok: (ev) => resolve(String(ev.path || "")),
        fail: (_reason, message) => reject(new Error(message)),
      });
    });
    try {
      const path = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Preparing “${view.title}”…` }, () => made);
      if (!path) throw new Error("DGC said nothing about where it made the file.");
      // (An artboard's file is named for it, as the process named it: "Landing - Phone.png".)
      if (board) name = fileName(path.split(/[\\/]/).pop()!.replace(/\.[a-z0-9]{1,5}$/i, ""), format);
      if (!await downloadFile(page ?? this.ownPage(view), path, name)) throw new Error("the page that asked has closed");
    } catch (err: any) {
      void vscode.window.showWarningMessage(`“${view.title}” wasn't downloaded: ${String(err?.message || err)}`);
    }
  }

  /** The artifact's own panel, opened if it isn't, as the page a download goes to (a command has no page of its own).
   *  None for a document (it opens in the editor): the person's browser downloads it then (src/download.ts). */
  private ownPage(view: Pick<ArtifactView, "id" | "title" | "type">): DownloadPage | undefined {
    if (view.type === "doc") return undefined;
    this.open(view.id, { type: view.type as ArtifactView["type"], title: view.title });
    const panel = this.panels.get(view.id);
    return panel ? (message) => { panel.post(message as Record<string, unknown>); return true; } : undefined;
  }

  /** Ask in chat about an artboard of a design (or part of one): every chat surface hears it, and the one the design
   *  was made in (Work, a chat, a Pip's chat; Work when it was made elsewhere) puts a reference to it in its prompt
   *  box. `text` is that reference in words, with the ids the model changes it by. */
  askInChat(view: ArtifactView, raw: any): void {
    const board = String(raw?.board || "");
    if (view.type !== "design" || !BOARD_ID.test(board)) return;
    const clean = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n) : "");
    const title = clean(raw.title, 80) || board, tag = clean(raw.tag, 20).replace(/[^a-z0-9-]/g, ""), quote = clean(raw.quote, 160), path = clean(raw.path, 200);
    const part = tag ? ` · its <${tag}>${quote ? ` “${quote}”` : ""}` : "";
    const text = `[Artboard “${title}” of the design “${view.title}” (${view.id}, ${board}${path && tag ? `, ${path}` : ""})${part}] `;
    const surface = typeof view.origin?.surface === "string" ? String(view.origin.surface) : "";
    this.tell({ type: "artifactAsk", id: view.id, board, title, label: `${title} · ${view.title}`.slice(0, 120), text,
                surface: surface === "chat" || surface === "pip" ? surface : "work",
                chat: typeof view.origin?.chat === "string" ? view.origin.chat : "", pip: typeof view.origin?.pip === "string" ? view.origin.pip : "",
                session: typeof view.origin?.session === "string" ? view.origin.session : "" });
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

  /** What an artifact is now, with its content (a doc's text; a sheet, deck or dashboard as data): one answer. Nothing
   *  when DGC refuses or the artifact is a page (a page is files, which this window never holds). */
  detail(id: string): Promise<{ view: ArtifactView; content: unknown } | undefined> {
    if (!ARTIFACT_ID.test(String(id || ""))) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.ask({ type: "artifact_get", id, content: true }, {
        ok: (ev) => { const view = artifactView(ev.artifact); resolve(view && ev.content !== undefined && ev.content !== null ? { view, content: ev.content } : undefined); },
        fail: () => resolve(undefined),
      });
    });
  }

  /** Rename it (the Library's item menu): asks for the new name, then makes one new version that differs only in its
   *  title, as a save from the editor would (artifact_update keeps the title with the version). True when renamed. */
  async rename(view: Pick<ArtifactView, "id" | "title" | "type">): Promise<boolean> {
    if (!ARTIFACT_ID.test(String(view?.id || ""))) return false;
    if (view.type === "page") {
      void vscode.window.showWarningMessage("A page can't be renamed here yet. Ask DGC to rename it.");
      return false;
    }
    if (view.type === "design") return this.renameDesign(view);
    const typed = await vscode.window.showInputBox({
      title: `Rename “${view.title}”`, value: view.title, prompt: "Its new name",
      validateInput: (value: string) => !value.trim() ? "A name is needed." : value.trim().length > 200 ? "A name is at most 200 characters." : undefined,
    });
    const title = String(typed ?? "").trim().slice(0, 200);
    if (!title || title === view.title) return false;
    const refuse = (why: string) => { void vscode.window.showWarningMessage(`“${view.title}” wasn't renamed: ${why}`); return false; };
    const now = await this.detail(view.id);
    if (!now) return refuse("DGC couldn't read it.");
    const content = now.content as string | Record<string, unknown>;
    if (typeof content !== "string" && typeof content !== "object") return refuse("DGC couldn't read it.");
    if (Buffer.byteLength(typeof content === "string" ? content : JSON.stringify(content), "utf8") > MAX_SAVE_BYTES) {
      return refuse("it is more than one save from the editor can carry. Ask DGC to rename it.");
    }
    return new Promise<boolean>((resolve) => {
      this.ask({ type: "artifact_update", id: view.id, content, base_version: now.view.version, title, note: "Renamed" }, {
        ok: () => resolve(true),
        fail: (_reason, message) => resolve(refuse(message)),
      });
    });
  }

  /** A design renamed: its name only (its artboards stay as they are, each a file of the new version too). */
  private async renameDesign(view: Pick<ArtifactView, "id" | "title">): Promise<boolean> {
    const typed = await vscode.window.showInputBox({
      title: `Rename “${view.title}”`, value: view.title, prompt: "Its new name",
      validateInput: (value: string) => !value.trim() ? "A name is needed." : value.trim().length > 200 ? "A name is at most 200 characters." : undefined,
    });
    const title = String(typed ?? "").trim().slice(0, 200);
    if (!title || title === view.title) return false;
    return new Promise<boolean>((resolve) => {
      this.ask({ type: "artifact_design_edit", id: view.id, edits: [{ op: "title", title }] }, {
        ok: () => resolve(true),
        fail: (_reason, message) => { void vscode.window.showWarningMessage(`“${view.title}” wasn't renamed: ${message}`); resolve(false); },
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

  /** A document's versions, from the canvas editor: restore one, or export it (to `page`, the editor's own). */
  async docVersions(id: string, page?: DownloadPage): Promise<void> {
    const view = await new Promise<ArtifactView | undefined>((resolve) => {
      this.ask({ type: "artifact_get", id }, { ok: (ev) => resolve(artifactView(ev.artifact)), fail: (_r, m) => { void vscode.window.showWarningMessage(m); resolve(undefined); } });
    });
    if (!view?.versions?.length) return;
    const when = (at: string) => { const t = Date.parse(at); return Number.isFinite(t) ? new Date(t).toLocaleString() : ""; };
    const pick = await vscode.window.showQuickPick([...view.versions].reverse().map((v) => ({
      label: `Version ${v.n}${v.n === view.version ? " (now)" : ""}`, description: [v.author, v.summary].filter(Boolean).join(" · "), detail: when(v.at), n: v.n,
    })), { placeHolder: `${view.title}: restore a version, or download it` });
    if (!pick) return;
    const n = (pick as any).n as number;
    const actions = [...(n !== view.version ? ["Restore this version", ...(this.offers()?.compare ? ["Compare with current"] : [])] : []),
                     ...view.exports.map((f) => `Download as ${FORMAT_LABELS[f] || f}`)];      // (a document's formats)
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
    const format = view.exports.find((f) => action === `Download as ${FORMAT_LABELS[f] || f}`);
    if (format) await this.exportArtifact(view, format, n === view.version ? undefined : n, page);
  }

  /** Export a document from the canvas editor: which format; then the editor's page (`page`) saves it. */
  async docExport(id: string, page?: DownloadPage): Promise<void> {
    const view = await new Promise<ArtifactView | undefined>((resolve) => {
      this.ask({ type: "artifact_get", id }, { ok: (ev) => resolve(artifactView(ev.artifact)), fail: (_r, m) => { void vscode.window.showWarningMessage(m); resolve(undefined); } });
    });
    if (!view) return;
    const pick = await vscode.window.showQuickPick(view.exports.map((f) => ({ label: FORMAT_LABELS[f] || f, format: f })), { placeHolder: `Download “${view.title}” as` });
    if (pick) await this.exportArtifact(view, (pick as any).format, undefined, page);
  }

  title(id: string): string { return this.titles.get(id) || "this artifact"; }
}
