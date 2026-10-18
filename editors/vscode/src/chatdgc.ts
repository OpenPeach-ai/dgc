import * as vscode from "vscode";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { CANVAS_DOC_VIEW, CanvasDocEditor } from "./canvasDoc";
import type { Dictation, DictationOwner, ReadAloud } from "./voice";

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
  /** What its backend offers ChatDGC (ready.capabilities.chatdgc), or {} before it's ready. */
  chatdgcOffers?(): Record<string, unknown>;
  /** ChatDGC's context window, for every chat: one of CHATDGC_WINDOWS its backend offers. */
  chatdgcSetWindow?(preset: string): void;
  /** Dictation for every message box (src/voice.ts): recorded on the computer you're at, written down by the model
   *  Settings -> Voice chose. One box records at a time. */
  dictation?(): Dictation | undefined;
  /** Reading a reply aloud, one at a time across the window. */
  readAloud?(): ReadAloud | undefined;
  /** A plugin's logo by its id (a data: URI), for a reply's "Used Aave" line; "" when it has none. */
  pluginLogo?(plugin: string): string;
}


interface Tab {
  panel: vscode.WebviewPanel;
  /** This tab's box, as dictation knows it. */
  mic: DictationOwner;
  conversation: string;
  temporary: boolean;
  summary?: any;
  /** Commands held while the process starts. */
  held: Record<string, unknown>[];
  opened: boolean;
  /** Messages for the page once its chat has opened (one sent from a canvas, before the tab was ready). */
  waitingSend?: Record<string, unknown>[];
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

type Asker = { tab?: Tab; home?: boolean; kind: string; project?: string; libraryPanel?: vscode.WebviewPanel; path?: string;
               widgetPanel?: vscode.WebviewPanel };

export function chatTitle(text: string): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "New chat";
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1).trimEnd()}…` : flat;
}

const CANVAS_ID = /^cv_[a-f0-9]{16}$/;

/** A widget's field as its page keeps it: by its place among the page's fields (and its id when it has one), a value
 *  or, for a checkbox or radio button, whether it's checked. */
export type WidgetField = { i: number; id: string; v?: string; c?: boolean };
const WIDGET_STATE_KEY = "dgc.chatdgcWidgetFields";
const MAX_WIDGET_STATES = 60;
const MAX_WIDGET_FIELDS = 200;

export function widgetName(title: unknown): string {
  return String(title || "Interactive").replace(/\s+/g, " ").trim().slice(0, 60) || "Interactive";
}
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** A widget page's fields as it said them, or null: anything else in it is dropped, and too much is refused. */
export function widgetFields(value: unknown): WidgetField[] | null {
  if (!Array.isArray(value) || value.length > MAX_WIDGET_FIELDS) return null;
  const out: WidgetField[] = [];
  for (const f of value) {
    if (!f || typeof f !== "object" || !Number.isInteger(f.i) || f.i < 0 || f.i >= MAX_WIDGET_FIELDS) return null;
    const id = typeof f.id === "string" ? f.id.slice(0, 100) : "";
    if (typeof f.c === "boolean") out.push({ i: f.i, id, c: f.c });
    else if (typeof f.v === "string" && f.v.length <= 2000) out.push({ i: f.i, id, v: f.v });
    else return null;
  }
  return JSON.stringify(out).length <= 64_000 ? out : null;
}

/** Which widget a tab shows, kept by VS Code with the tab so it opens again after a restart. */
export type WidgetRef = { id: string; chat: string; title: string };
export const CHATDGC_WIDGET = "dgc.chatdgcWidget";
/** An event for ChatDGC rather than a session: every chatdgc_* one, and a breakdown of a chat's window (one of a
 *  session's carries no conversation). */
export function isChatdgcEvent(ev: { type?: unknown; conversation_id?: unknown } | null | undefined): boolean {
  const type = typeof ev?.type === "string" ? ev.type : "";
  return type.startsWith("chatdgc_") || (type === "context_breakdown" && typeof ev?.conversation_id === "string" && !!ev.conversation_id);
}

/** ChatDGC's context window presets, as main DGC's sizes run (a backend offers the ones it takes). */
export const CHATDGC_WINDOWS = ["8k", "16k", "32k", "64k", "128k", "256k", "512k", "1m", "max"];
const WIDGET_ID = /^wg_[a-f0-9]{16}$/;

/** A widget's page: the model's HTML under a policy that loads nothing from anywhere and runs only its own inline
 *  code; network and peer-connection APIs gone before it runs; the theme's colours as CSS variables. */
export function widgetDocument(html: string, fields?: WidgetField[], ref?: WidgetRef): string {
  // JSON in an inline script: nothing in it can close the script or end a line.
  const inline = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  // The editor's own colours (a webview has them as --vscode-* variables), so it follows the theme as it changes. They
  // win over a page's own (a model often writes light ones, and prefers-color-scheme in a webview is the system's,
  // not VS Code's); color-scheme follows VS Code's theme too, for the form controls.
  const vars = "--bg:var(--vscode-editor-background)!important;--text:var(--vscode-editor-foreground)!important;"
    + "--muted:var(--vscode-descriptionForeground)!important;--accent:var(--vscode-button-background)!important;"
    + "--border:var(--vscode-panel-border,var(--vscode-widget-border,#80808059))!important;"
    + "--surface:var(--vscode-sideBar-background,var(--vscode-editorWidget-background))!important";
  const kind = (k: string) => `:root:has(>body[data-vscode-theme-kind="${k}"])`;
  const scheme = `${kind("vscode-light")},${kind("vscode-high-contrast-light")}{color-scheme:light}`
    + `${kind("vscode-dark")},${kind("vscode-high-contrast")}{color-scheme:dark}`;
  const guard = `(function(){for(const k of ["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","WebSocket","EventSource","Worker","SharedWorker","fetch","XMLHttpRequest"]){try{Object.defineProperty(window,k,{value:undefined,configurable:false,writable:false})}catch(e){}}`
    // A widget whose code fails says so, in the widget (to no one else): otherwise it just sits there showing dashes.
    + `function bar(m){try{var b=document.getElementById("dgc-widget-error");if(!b){b=document.createElement("div");b.id="dgc-widget-error";`
    + `b.setAttribute("role","alert");b.style.cssText="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:8px 12px;`
    + `font:12px/1.4 system-ui,sans-serif;background:var(--vscode-inputValidation-errorBackground,#5a1d1d);color:var(--vscode-foreground,#fff);`
    + `border-top:1px solid var(--vscode-inputValidation-errorBorder,#be1100)";(document.body||document.documentElement).appendChild(b)}`
    + `b.textContent="This widget hit an error, so it may not work: "+String(m||"unknown error").slice(0,240).replace(/\\.?$/,".")+" Ask ChatDGC to fix it."}catch(e){}}`
    + `var errors=[];function failed(m){errors.push(String(m||"unknown error").slice(0,300));bar(m)}`
    + `addEventListener("error",function(e){if(e&&e.message)failed(e.message)});`
    + `addEventListener("unhandledrejection",function(e){var r=e&&e.reason;failed(r&&r.message||r)});`
    // The only handle to VS Code, taken before the widget's own code runs (a second ask for it fails), and used for
    // two things: its fields as you change them, and what it shows once it's open.
    + `var api=null;try{api=acquireVsCodeApi()}catch(e){}function post(m){try{if(api)api.postMessage(m)}catch(e){}}`
    + `function controls(){return Array.prototype.slice.call(document.querySelectorAll("input,select,textarea"),0,${MAX_WIDGET_FIELDS})}`
    + `function kind(f){return String(f.type||"").toLowerCase()}`
    + `function snap(){return controls().map(function(f,i){var t=kind(f),id=String(f.id||"").slice(0,100);`
    + `return t==="checkbox"||t==="radio"?{i:i,id:id,c:!!f.checked}:{i:i,id:id,v:String(f.value==null?"":f.value).slice(0,2000)}})}`
    + `var timer=0;function changed(){clearTimeout(timer);timer=setTimeout(function(){post({type:"state",fields:snap()})},300)}`
    + `addEventListener("input",changed,true);addEventListener("change",changed,true);`
    + `var saved=${inline(fields || [])};`
    + (ref ? `try{if(api)api.setState({dgcWidget:${inline(ref)}})}catch(e){}` : "")
    + `function restore(){try{var list=controls(),done=[];saved.forEach(function(s){var f=(s.id&&document.getElementById(s.id))||list[s.i];`
    + `if(!f||list.indexOf(f)<0)return;var t=kind(f);if(typeof s.c==="boolean"){if(t==="checkbox"||t==="radio"){f.checked=s.c;done.push(f)}}`
    + `else if(t!=="file"&&t!=="checkbox"&&t!=="radio"&&typeof s.v==="string"){f.value=s.v;done.push(f)}});`
    + `done.forEach(function(f){f.dispatchEvent(new Event("input",{bubbles:true}));f.dispatchEvent(new Event("change",{bubbles:true}))})}catch(e){}}`
    + `addEventListener("load",function(){setTimeout(function(){if(saved.length)restore();setTimeout(function(){`
    // What it shows, its fields as they're set first (a page's text has no box's value, and lists a menu's every
    // choice): a check of its figures read a monthly-compounding widget as a yearly one without them.
    + `function named(f){return String((f.labels&&f.labels[0]&&f.labels[0].innerText)||f.getAttribute("aria-label")||f.placeholder||f.name||f.id||kind(f))`
    + `.replace(/\\s+/g," ").trim().slice(0,60)}`
    + `function valued(f){var t=kind(f);return f.tagName==="SELECT"?(f.selectedOptions[0]?f.selectedOptions[0].text:""):t==="checkbox"||t==="radio"?`
    + `(f.checked?"on":"off"):String(f.value==null?"":f.value)}`
    + `var b=document.getElementById("dgc-widget-error"),t=String(document.body&&document.body.innerText||"");if(b)t=t.replace(b.textContent,"");`
    + `var set=controls().filter(function(f){return kind(f)!=="hidden"&&kind(f)!=="file"}).slice(0,40).map(function(f){return named(f)+": "+valued(f).slice(0,80)}).join("\\n");`
    + `post({type:"report",text:((set?"Fields:\\n"+set+"\\n\\nPage:\\n":"")+t).slice(0,4000),errors:errors.slice(0,3)})},700)},0)});`
    + `})();`;
  // (Built, then returned: the chat page's tests find that page as the file's first `return` of a document.)
  const page = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{${vars}}${scheme}html,body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}body{padding:16px}</style>
<script>${guard}</script>
</head><body>${html}</body></html>`;
  return page;
}
// Absolute: POSIX, a drive, or DGC's own distro on Windows (hidden WSL: \\wsl.localhost\DGC\home\...).
const CANVAS_PATH = /^(?:\/|[A-Za-z]:\\|\\\\wsl(?:\.localhost|\$)\\).*[\\/]canvas[\\/](chat_[a-f0-9]{32})[\\/](cv_[a-f0-9]{16})[\\/][^\\/]+$/;
const attr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** The file a tab shows, as text or formatted (the canvas's own editor), or undefined. */
function canvasTabPath(tab: vscode.Tab): string | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) return input.uri.fsPath;
  if (input instanceof vscode.TabInputCustom && input.viewType === CANVAS_DOC_VIEW) return input.uri.fsPath;
  return undefined;
}

// Its header opens on DGC's wordmark as Work's does (panel.ts, #phead .pm), with ChatDGC's own mark: the tab icon's
// bubble and slashes, inline so the slashes can move as Work's do (main.css styles both).
export function chatdgcDocument(asset: (name: string) => string, cspSource: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data: https://www.google.com https://*.gstatic.com; font-src ${attr(cspSource)}; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};">
<link rel="stylesheet" href="${attr(asset("media/codicon.css"))}"><link rel="stylesheet" href="${attr(asset("media/main.css"))}"><link rel="stylesheet" href="${attr(asset("media/chatdgc.css"))}"><link rel="stylesheet" href="${attr(asset("media/voicebar.css"))}">
<title>ChatDGC</title></head><body class="cd-blank" data-katex="${attr(asset("dist/katex/katex.js"))}" data-katex-css="${attr(asset("dist/katex/katex.css"))}">
<header class="cd-head"><span class="pm"><svg class="mk mk-chat" viewBox="0 0 24 24" aria-hidden="true"><path class="mk-bubble" d="M5.5 2.5 H18.5 A4 4 0 0 1 22.5 6.5 V13.5 A4 4 0 0 1 18.5 17.5 H11 L6 21.5 V17.5 H5.5 A4 4 0 0 1 1.5 13.5 V6.5 A4 4 0 0 1 5.5 2.5 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><g class="mk-slashes" transform="translate(6.53 4.53) scale(0.4560)" fill="currentColor"><path d="M7.63 4.67 L3.44 6.76 L1 21.43 L5.19 19.33 Z"/><path d="M15.32 2.57 L11.13 4.67 L8.68 21.43 L12.87 19.33 Z"/><path d="M23 4.67 L18.81 6.76 L16.37 19.33 L20.56 17.24 Z"/></g></svg>DGC<span class="cur" aria-hidden="true"></span></span><button type="button" id="cd-crumb" class="cd-crumb" hidden></button><h1 id="cd-title" class="cd-title">New chat</h1><span id="cd-temp-badge" class="cd-badge" hidden>Temporary</span>
<button type="button" id="cd-keys-open" class="cd-icon" title="Keyboard shortcuts (Ctrl+/)" aria-label="Keyboard shortcuts"><span class="codicon codicon-keyboard" aria-hidden="true"></span></button>
<button type="button" id="cd-menu" class="cd-icon" title="Rename, pin, archive, export or delete" aria-label="Chat options" hidden><span class="codicon codicon-ellipsis" aria-hidden="true"></span></button>
<button type="button" id="cd-new" class="cd-icon" title="New chat" aria-label="New chat"><span class="codicon codicon-edit" aria-hidden="true"></span></button></header>
<main id="cd-scroll" class="cd-scroll"><div class="cd-column">
<button type="button" id="cd-earlier" class="cd-earlier" hidden>Show earlier messages</button>
<div id="cd-log" class="cd-log" role="log" aria-label="Conversation"></div>
<section id="cd-empty" class="cd-empty" aria-live="polite"></section>
</div></main>
<footer class="cd-foot"><div class="cd-column">
<p id="cd-notice" class="cd-notice" role="alert" hidden></p>
<div id="cd-context-pop" class="cd-pop" role="dialog" aria-label="Context window" hidden></div>
<form id="cd-box" class="cd-box"><div id="cd-queue" class="cd-queue" role="region" aria-label="Queued messages" hidden></div><ul id="cd-chips" class="cd-chips" aria-label="Attached" hidden></ul><label for="cd-input" class="sr-only">Message ChatDGC</label>
<textarea id="cd-input" class="cd-input" rows="1" placeholder="Ask anything" maxlength="${MAX_TEXT}"></textarea>
<div class="cd-tools">
<button type="button" id="cd-attach" class="cd-icon" title="Attach files (or paste an image)" aria-label="Attach files"><span class="codicon codicon-attach" aria-hidden="true"></span></button>
<span class="cd-picks" hidden><select id="cd-model" tabindex="-1" aria-hidden="true"></select><select id="cd-thinking" tabindex="-1" aria-hidden="true">
<option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option></select></span>
<button type="button" id="cd-websearch" class="cd-tool" aria-pressed="false" aria-label="Search" title="Search the web for this message. Without it, ChatDGC still searches whenever an answer depends on it"><span class="codicon codicon-globe" aria-hidden="true"></span><span class="cd-tool-label">Search</span></button>
<button type="button" id="cd-research" class="cd-tool" aria-pressed="false" aria-label="Deep research" title="Deep research: a plan to check, then many sources read, then a report with checked citations"><span class="codicon codicon-telescope" aria-hidden="true"></span><span class="cd-tool-label">Deep research</span></button>
<button type="button" id="cd-study" class="cd-tool" aria-pressed="false" aria-label="Study" title="Study: it teaches you step by step, asks you questions and quizzes you, instead of handing over answers. It stays on in this chat until you turn it off"><span class="codicon codicon-mortar-board" aria-hidden="true"></span><span class="cd-tool-label">Study</span></button>
<label id="cd-temp-toggle" class="cd-toggle" title="Temporary: this chat isn't saved or listed"><input type="checkbox" id="cd-temporary" aria-label="Temporary chat"><span class="codicon codicon-comment-draft cd-toggle-icon" aria-hidden="true"></span><span class="cd-tool-label">Temporary</span></label>
<span class="cd-spacer"></span>
<div class="cd-tools-end"><button type="button" id="cd-context" class="cd-meter" aria-haspopup="dialog" aria-expanded="false" hidden><span class="codicon codicon-pie-chart" aria-hidden="true"></span><span id="cd-context-pct">0%</span></button>
<div class="cd-picker"><button type="button" id="cd-model-pill" class="cd-model-pill" aria-haspopup="dialog" aria-expanded="false" hidden><span id="cd-model-name" class="cd-model-name">Model</span><svg class="cd-pill-arc" viewBox="0 0 16 10" aria-hidden="true"><path class="cd-arc-track" d="M2 9 A6 6 0 0 1 14 9"></path><path id="cd-pill-arc-fill" class="cd-arc-fill" d=""></path></svg><span class="codicon codicon-chevron-up cd-model-chevron" aria-hidden="true"></span></button>
<div id="cd-model-menu" class="cd-model-menu" role="dialog" aria-label="Model and thinking" hidden></div></div>
<button type="button" id="cd-mic" class="cd-icon cd-mic" title="Dictate" aria-label="Dictate"><span class="codicon codicon-mic" aria-hidden="true"></span></button>
<button type="button" id="cd-voicemode" class="cd-send cd-voicemode" title="Voice mode: talk with ChatDGC" aria-label="Voice mode" hidden><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 6.5v3M6 4v8M10 3v10M13 6v4"/></svg></button>
<button type="submit" id="cd-send" class="cd-send" title="Send (Enter)" aria-label="Send" disabled><span class="codicon codicon-arrow-up" aria-hidden="true"></span></button>
<button type="button" id="cd-stop" class="cd-send cd-stop" title="Stop (Esc)" aria-label="Stop" hidden><span class="codicon codicon-debug-stop" aria-hidden="true"></span></button></div>
</div><div id="cd-voice" class="cd-voice"></div></form>
<p class="cd-fine">ChatDGC answers with your own model. Check what matters.</p>
</div></footer>
<div id="cd-announce" class="sr-only" aria-live="polite"></div>
<dialog id="cd-keys" class="cd-keys" aria-labelledby="cd-keys-title"><h2 id="cd-keys-title">Keyboard shortcuts</h2><dl id="cd-keys-list"></dl>
<button type="button" id="cd-keys-close" class="cd-edit-cancel">Close</button></dialog>
<script src="${attr(asset("dist/markdown.js"))}"></script><script src="${attr(asset("media/chart.js"))}"></script><script src="${attr(asset("media/breakdown.js"))}"></script><script src="${attr(asset("media/voicebar.js"))}"></script><script src="${attr(asset("media/msgtime.js"))}"></script><script src="${attr(asset("media/readaloud.js"))}"></script><script src="${attr(asset("media/voicemode.js"))}"></script><script src="${attr(asset("media/texthistory.js"))}"></script><script src="${attr(asset("media/chatdgc.js"))}"></script></body></html>`;
}

/** The Library (ChatGPT's): every file attached in ChatDGC, in its own tab. */
export function libraryDocument(asset: (name: string) => string, cspSource: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; font-src ${attr(cspSource)}; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};">
<link rel="stylesheet" href="${attr(asset("media/codicon.css"))}"><link rel="stylesheet" href="${attr(asset("media/main.css"))}"><link rel="stylesheet" href="${attr(asset("media/chatdgc.css"))}">
<title>Library</title></head><body class="lib-body">
<main class="lib"><header class="lib-head"><h1 class="lib-title"><span class="codicon codicon-library" aria-hidden="true"></span>Library</h1>
<label class="sr-only" for="lib-search">Search your files by name</label><input id="lib-search" class="cd-field lib-search" type="search" placeholder="Search files" maxlength="200" autocomplete="off"></header>
<div id="lib-views" class="lib-views" role="tablist" aria-label="Show" hidden></div>
<p id="lib-about" class="lib-about">Every file you attached in ChatDGC or it made for you, in every chat and project. Temporary chats keep none.</p>
<div id="lib-origins" class="lib-kinds" role="toolbar" aria-label="Show files" hidden></div>
<div id="lib-kinds" class="lib-kinds" role="toolbar" aria-label="Show"></div>
<p id="lib-status" class="lib-status" role="status"></p>
<ul id="lib-list" class="lib-list" aria-label="Your files" role="tabpanel"></ul>
<button type="button" id="lib-more" class="cd-edit-cancel lib-more" hidden>Show more</button></main>
<script src="${attr(asset("media/library.js"))}"></script></body></html>`;
}

export class ChatDGC implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private readonly tabs = new Set<Tab>();
  private readonly requests = new Map<string, Asker>();
  private seq = 0;
  private host?: ChatDGCHost;
  private canvasDocs?: CanvasDocEditor;
  private homeQuery = "";
  private homeShown = HOME_FIRST;
  private homeHeld = false;
  private homeTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext) {}

  attach(host: ChatDGCHost): void { this.host = host; }

  register(): vscode.Disposable {
    const chats = vscode.window.registerWebviewPanelSerializer(CHATDGC_EDITOR, this);
    // A widget's tab open when VS Code closed comes back as it was (its page from the chat, its fields as left).
    const widgets = vscode.window.registerWebviewPanelSerializer(CHATDGC_WIDGET, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: any) => this.restoreWidget(panel, state) });
    // A document canvas opens formatted (Canvas option B), over the same file the Markdown editor opens.
    this.canvasDocs = new CanvasDocEditor(this.context.extensionUri, {
      canvasOf: (path) => this.canvasOf(path),
      canvasAskAbout: (conversation, canvas, text, start, end) => this.canvasAskAbout(conversation, canvas, text, start, end),
      canvasShortcut: () => this.canvasShortcut(),
    });
    const docs = this.canvasDocs.register();
    return { dispose: () => { chats.dispose(); widgets.dispose(); docs.dispose(); } };
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

  /** ChatDGC's own mark (DGC's three slashes in a speech bubble), so its tabs aren't taken for DGC's sessions. */
  private chatdgcIcon(): { light: vscode.Uri; dark: vscode.Uri } {
    return { light: vscode.Uri.joinPath(this.context.extensionUri, "media", "chatdgc-tab-light.svg"),
             dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "chatdgc-tab-dark.svg") };
  }

  private library?: vscode.WebviewPanel;

  /** The Library, in a tab of its own (one at a time). */
  openLibrary(): void {
    // Shown again, it asks again: a file attached or made since is there (it keeps its filters).
    if (this.library) { this.library.reveal(); void this.library.webview.postMessage({ type: "refresh" }); return; }
    const panel = vscode.window.createWebviewPanel(CHATDGC_LIBRARY, "Library", vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] });
    panel.iconPath = this.chatdgcIcon();
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

  // ---- canvas (ChatGPT's): a document or code in a real editor beside the chat, that both of you change

  /** The chat and canvas a file belongs to, when it's a canvas's file (`<chat root>/canvas/<chat>/<canvas>/<file>`). */
  canvasOf(path: string): { conversation: string; canvas: string } | undefined {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(String(path || ""))) return undefined;      // never a path that climbs out
    const m = CANVAS_PATH.exec(String(path || ""));
    return m ? { conversation: m[1], canvas: m[2] } : undefined;
  }

  /** The canvas in an editor beside the chat. A change the reply made goes into an open document as an edit (Undo
   *  takes it back) and is saved; a document with your unsaved typing is left alone: VS Code asks when you save. */
  private async showCanvas(conversation: string, view: any, focus: boolean): Promise<void> {
    const path = String(view?.path || "");
    if (this.canvasOf(path)?.conversation !== conversation) return;
    const uri = vscode.Uri.file(path);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    try {
      if (open && typeof view.text === "string" && open.getText() !== view.text) {
        if (open.isDirty) {
          void vscode.window.showWarningMessage(`ChatDGC changed “${view.title}” while you were typing in it. Your changes aren't saved yet: when you save, VS Code lets you compare and choose.`);
        } else {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), view.text);
          if (await vscode.workspace.applyEdit(edit)) await open.save();
        }
      }
      // Shown already, formatted or as Markdown, it stays as it is; a document opens formatted, code in the editor.
      const shown = vscode.window.tabGroups.all.some((g) => g.activeTab && canvasTabPath(g.activeTab) === uri.fsPath);
      if (!shown || focus) {
        const options = { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !focus, preview: false };
        const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => canvasTabPath(t) === uri.fsPath);
        if (open?.input instanceof vscode.TabInputText) await vscode.window.showTextDocument(uri, { ...options, viewColumn: open.group.viewColumn });
        else if (/\.md$/i.test(path)) await vscode.commands.executeCommand("vscode.openWith", uri, CANVAS_DOC_VIEW, open ? { ...options, viewColumn: open.group.viewColumn } : options);
        else await vscode.window.showTextDocument(uri, options);
      }
    } catch (err: any) {
      void vscode.window.showWarningMessage(`The canvas couldn't be opened: ${String(err?.message || err)}`);
    }
  }

  private unsavedCanvas(conversation: string): boolean {
    return vscode.workspace.textDocuments.some((d) => d.isDirty && this.canvasOf(d.uri.fsPath)?.conversation === conversation);
  }

  /** Before a message goes, a canvas's unsaved typing is saved: the model reads the file. */
  private async saveCanvases(conversation: string): Promise<void> {
    this.canvasDocs?.flush();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && this.canvasOf(doc.uri.fsPath)?.conversation === conversation) {
        try { await doc.save(); } catch { /* it goes as it was */ }
      }
    }
  }

  /** The canvas in front of you, for its commands: in the Markdown or code editor, or formatted (no text editor). */
  private canvasHere(): { path: string; editor?: vscode.TextEditor; conversation: string; canvas: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    const path = this.canvasDocs?.active()?.uri.fsPath ?? (editor ? editor.document.uri.fsPath : "");
    const found = path ? this.canvasOf(path) : undefined;
    if (!found) {
      void vscode.window.showInformationMessage("Open a ChatDGC canvas first: ask a chat for a document or code to work on together.");
      return undefined;
    }
    return { path, editor: this.canvasDocs?.active() ? undefined : editor, ...found };
  }

  /** A message to the canvas's chat, as if typed there: its tab opens (or shows), and the page sends it. */
  private sendFromCanvas(conversation: string, text: string, selection?: Record<string, unknown>): void {
    const message = { type: "sendFromEditor", text, ...(selection ? { canvasSelection: selection } : {}) };
    const tab = [...this.tabs].find((t) => t.conversation === conversation);
    if (tab?.opened) { tab.panel.reveal(undefined, true); this.post(tab, message); return; }
    const before = new Set(this.tabs);
    this.open(conversation);
    const fresh = [...this.tabs].find((t) => !before.has(t)) ?? [...this.tabs].find((t) => t.conversation === conversation);
    if (fresh) (fresh.waitingSend ??= []).push(message);
  }

  /** Ask ChatDGC about the selected part of a canvas (the line the cursor is on, with nothing selected). Formatted,
   *  the page finds the selection's lines and asks (canvasAskAbout). */
  async canvasAsk(): Promise<void> {
    const here = this.canvasHere();
    if (!here) return;
    if (!here.editor) { this.canvasDocs?.askSelection(); return; }
    const sel = here.editor.selection, doc = here.editor.document;
    const text = doc.getText(sel.isEmpty ? doc.lineAt(sel.active.line).range : sel);
    if (!text.trim()) { void vscode.window.showInformationMessage("Select the part of the canvas to ask about."); return; }
    const first = sel.isEmpty ? sel.active.line : sel.start.line;
    const last = sel.isEmpty ? sel.active.line : (sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line);
    await this.canvasAskAbout(here.conversation, here.canvas, text, first + 1, last + 1);
  }

  /** Ask about lines `start`–`end` (1-based) of a canvas: what to change or know, then it goes from the chat's tab. */
  async canvasAskAbout(conversation: string, canvas: string, text: string, start: number, end: number): Promise<void> {
    const ask = await vscode.window.showInputBox({ title: "Ask ChatDGC about the selection", prompt: "What should change, or what do you want to know?",
                                                    placeHolder: "Make this friendlier", ignoreFocusOut: true });
    if (!ask?.trim()) return;
    await this.saveCanvases(conversation);
    this.sendFromCanvas(conversation, ask.trim(), { canvas_id: canvas, start_line: start, end_line: end, text: text.slice(0, 20_000) });
  }

  /** The canvas in front, the other way: formatted to Markdown, or Markdown to formatted. */
  async canvasSwitch(formatted: boolean): Promise<void> {
    const here = this.canvasHere();
    if (!here || !/\.md$/i.test(here.path)) return;
    await this.saveCanvases(here.conversation);
    const uri = vscode.Uri.file(here.path);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    await vscode.commands.executeCommand("vscode.openWith", uri, formatted ? CANVAS_DOC_VIEW : "default", vscode.window.tabGroups.activeTabGroup.viewColumn);
    // In the same group VS Code swaps the editor in place, and the old tab is gone; one left beside it is closed.
    const left = tab && vscode.window.tabGroups.all.some((g) => g.tabs.includes(tab)) && tab !== vscode.window.tabGroups.activeTabGroup.activeTab;
    if (left && canvasTabPath(tab) === here.path) await vscode.window.tabGroups.close(tab, true).then(undefined, () => undefined);
  }

  /** ChatGPT's canvas shortcuts, for a document or for code. */
  async canvasShortcut(): Promise<void> {
    const here = this.canvasHere();
    if (!here) return;
    const code = !/\.md$/i.test(here.path);
    const items: [string, string][] = code
      ? [["Review the code", "Review the code in the canvas and suggest improvements as comments in it."],
         ["Add comments", "Add clear comments to the code in the canvas."],
         ["Add logs", "Add helpful logging to the code in the canvas."],
         ["Fix bugs", "Find and fix the bugs in the code in the canvas."],
         ["Port to another language…", ""]]
      : [["Suggest edits", "Improve the canvas where it needs it, and say what you changed."],
         ["Make it shorter", "Make the canvas shorter, keeping what matters."],
         ["Make it longer", "Make the canvas longer, with more useful detail."],
         ["Change the reading level…", ""],
         ["Add final polish", "Give the canvas a final polish: grammar, clarity and flow, without changing what it says."]];
    const pick = await vscode.window.showQuickPick(items.map(([label, ask]) => ({ label, ask })), { placeHolder: "What should ChatDGC do with this canvas?" });
    if (!pick) return;
    let ask = pick.ask;
    if (!ask && code) {
      const to = await vscode.window.showInputBox({ prompt: "Port the code to which language?", placeHolder: "TypeScript" });
      if (!to?.trim()) return;
      ask = `Port the code in the canvas to ${to.trim()}, in a new canvas.`;
    } else if (!ask) {
      const level = await vscode.window.showQuickPick(["A young child", "Middle school", "High school", "College", "Graduate school"],
                                                      { placeHolder: "Rewrite it for which reader?" });
      if (!level) return;
      ask = `Rewrite the canvas for a reader at this level: ${level}.`;
    }
    await this.saveCanvases(here.conversation);
    this.sendFromCanvas(here.conversation, ask);
  }

  /** Versions: any one compared with the canvas now (VS Code's diff), or restored. */
  async canvasVersions(): Promise<void> {
    const here = this.canvasHere();
    if (!here) return;
    await this.saveCanvases(here.conversation);
    this.ask({ kind: "canvasVersions" }, { type: "chatdgc_canvas", conversation_id: here.conversation, canvas_id: here.canvas, op: "get" });
  }

  private async pickVersion(conversation: string, view: any): Promise<void> {
    const versions = (Array.isArray(view.versions) ? view.versions : [])
      .filter((v: any) => this.canvasOf(String(v?.path || "").replace(/[\\/]\.versions[\\/][^\\/]+$/, "/x"))?.conversation === conversation).reverse();
    if (!versions.length) return;
    const when = (at: string) => { const t = Date.parse(at); return Number.isFinite(t) ? new Date(t).toLocaleString() : ""; };
    const pick = await vscode.window.showQuickPick(versions.map((v: any) => ({
      label: `Version ${v.n}${v.n === view.version ? " (now)" : ""}`, description: `${v.by === "user" ? "You" : "ChatDGC"} · ${v.note || ""}`,
      detail: when(v.at), v })), { placeHolder: `${view.title}: compare a version with the canvas now, or restore it` });
    if (!pick) return;
    const v = (pick as any).v;
    const choice = v.n === view.version ? "Compare with now"
      : await vscode.window.showQuickPick(["Compare with now", "Restore this version"], { placeHolder: `Version ${v.n}` });
    if (!choice) return;
    if (choice === "Restore this version") {
      this.ask({ kind: "canvasRestore" }, { type: "chatdgc_canvas", conversation_id: conversation, canvas_id: view.id, op: "restore", version: v.n });
      return;
    }
    await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(v.path), vscode.Uri.file(view.path), `${view.title}: version ${v.n} ↔ now`);
  }

  /** Download: Word, PDF or Markdown for a document (made.py lays it out), or the code file as it is. */
  async canvasDownload(): Promise<void> {
    const here = this.canvasHere();
    if (!here) return;
    await this.saveCanvases(here.conversation);
    const file = here.path, name = file.split(/[\\/]/).pop() || "canvas";
    const code = !/\.md$/i.test(file);
    const format = code ? { label: "The code file", format: "file", ext: name.split(".").pop() || "txt" }
      : await vscode.window.showQuickPick([{ label: "Word document (.docx)", format: "docx", ext: "docx" }, { label: "PDF", format: "pdf", ext: "pdf" },
                                           { label: "Markdown (.md)", format: "md", ext: "md" }], { placeHolder: "Download the canvas as" });
    if (!format) return;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
    const base = name.replace(/\.[^.]+$/, "");
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, `${base}.${format.ext}`), saveLabel: "Save" });
    if (!target || target.scheme !== "file") return;
    this.ask({ kind: "canvasExport" }, { type: "chatdgc_canvas", conversation_id: here.conversation, canvas_id: here.canvas, op: "export",
                                         format: format.format, path: target.fsPath });
  }

  /** The canvas commands show in an editor's title bar and menus when the file in front is a canvas, in the Markdown
   *  or code editor or formatted (dgc.chatdgcCanvasFormatted says which, for the switch between them). */
  canvasContext(): vscode.Disposable {
    const set = () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const path = tab ? canvasTabPath(tab) : undefined;
      const canvas = !!(path && this.canvasOf(path));
      void vscode.commands.executeCommand("setContext", "dgc.chatdgcCanvas", canvas);
      void vscode.commands.executeCommand("setContext", "dgc.chatdgcCanvasFormatted", canvas && tab?.input instanceof vscode.TabInputCustom);
    };
    set();
    return vscode.Disposable.from(vscode.window.onDidChangeActiveTextEditor(set), vscode.window.tabGroups.onDidChangeTabs(set),
                                  vscode.window.tabGroups.onDidChangeTabGroups(set), ...(this.canvasDocs ? [this.canvasDocs.onDidChangeActive(set)] : []));
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
    const widget = message?.widget && WIDGET_ID.test(String(message.widget.id || "")) && CONVERSATION_ID.test(String(message.widget.chat_id || ""))
      ? { id: String(message.widget.id), chat: String(message.widget.chat_id), title: widgetName(message.widget.title) } : undefined;
    switch (message?.type) {
      case "widgets": {
        void panel.webview.postMessage({ type: "widgetsOffered", on: this.widgetLibrary() });
        if (!this.widgetLibrary()) return;
        const offset = Number.isInteger(message.offset) && message.offset >= 0 ? message.offset : 0;
        this.libraryAsk(panel, "widgets", { type: "chatdgc_widgets", op: "list", ...(typeof message.query === "string" && message.query.trim()
          ? { query: message.query.slice(0, 200) } : {}), limit: 60, offset });
        return;
      }
      case "widgetOpen":
        if (widget) {
          const open = this.widgetPanels.get(widget.id);
          if (open) open.reveal(undefined, false);
          else this.libraryAsk(panel, "widgetGet", { type: "chatdgc_widgets", op: "get", conversation_id: widget.chat, widget_id: widget.id });
        }
        return;
      case "widgetChat":
        if (widget) this.open(widget.chat);
        return;
      case "widgetRemove": {
        if (!widget) return;
        const DELETE = "Delete";
        const choice = await vscode.window.showWarningMessage(
          `Delete the widget “${widget.title}”? Its card stays in the chat, marked as deleted. This can't be undone.`, { modal: true }, DELETE);
        if (choice === DELETE) this.libraryAsk(panel, "widgetRemove", { type: "chatdgc_widgets", op: "remove", conversation_id: widget.chat, widget_id: widget.id });
        return;
      }
      case "ready":
        void panel.webview.postMessage({ type: "widgetsOffered", on: this.widgetLibrary() });
        // falls through: the files are asked for as a list is
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

  // ---- interactive answers: a reply's widget (one self-contained HTML page) in a tab of its own beside the chat.
  // VS Code serves nothing to a frame inside a webview, and inline script in the chat page itself would open it up,
  // so a widget runs in its own webview: its own origin, a policy that loads nothing. Its page (DGC's part of it, which
  // holds the only handle to VS Code) says two things, and nothing else is heard: what its fields hold as you type
  // (kept, so it opens again as you left it) and, once open, what it shows (to the reply, which checks it).
  private readonly widgetPanels = new Map<string, vscode.WebviewPanel>();
  private readonly widgetPages = new Map<string, string>();         // the page each open tab shows
  private readonly widgetWaiting = new Map<string, string>();     // widget id -> its chat, while a reply waits

  /** The backend hears what a widget shows (ready.capabilities.chatdgc.widget_report). */
  private reportsWidgets(): boolean {
    try { return Number(this.host?.chatdgcOffers?.()?.widget_report) >= 1; } catch { return false; }
  }

  private widgetReport(id: string, report: { shown: boolean; text?: string; errors?: string[] }): void {
    const conversation = this.widgetWaiting.get(id);
    if (conversation === undefined) return;
    this.widgetWaiting.delete(id);
    this.host?.chatdgcSend({ type: "chatdgc_widget_report", request_id: this.nextId("widget"), conversation_id: conversation,
                             widget_id: id, shown: report.shown,
                             ...(report.shown ? { text: String(report.text || "").slice(0, 4000),
                                                  errors: (report.errors || []).slice(0, 3).map((e) => String(e).slice(0, 300)) } : {}) });
  }

  private widgetStates(): Record<string, { at: number; fields: WidgetField[] }> {
    try {
      const kept = this.context.globalState?.get<Record<string, { at: number; fields: WidgetField[] }>>(WIDGET_STATE_KEY);
      return kept && typeof kept === "object" ? kept : {};
    } catch { return {}; }
  }

  private keepWidgetState(key: string, fields: WidgetField[] | null): void {
    const all = this.widgetStates();
    if (fields) all[key] = { at: Date.now(), fields }; else delete all[key];
    const newest = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_WIDGET_STATES);
    void Promise.resolve(this.context.globalState?.update(WIDGET_STATE_KEY, Object.fromEntries(newest))).catch(() => {});
  }

  private showWidget(id: string, html: string, title: string, focus: boolean, chat = ""): void {
    // One tab a widget: by its id, or (a ```widget block in a reply has none) by its page.
    const key = id || "page:" + createHash("sha256").update(html).digest("hex");
    const name = widgetName(title);
    const open = this.widgetPanels.get(key);
    if (open) {
      if (this.widgetPages.get(key) !== html) {
        // The reply fixed it: the new page, from its start.
        this.keepWidgetState(key, null);
        this.widgetPages.set(key, html);
        open.title = name;
        open.webview.html = widgetDocument(html, undefined, id && chat ? { id, chat, title: name } : undefined);
      }
      open.reveal(undefined, !focus);
      return;
    }
    const panel = vscode.window.createWebviewPanel(CHATDGC_WIDGET, name, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !focus },
                                                   { enableScripts: true, localResourceRoots: [] });
    this.adoptWidget(panel, key, id, chat, html, name);
  }

  private adoptWidget(panel: vscode.WebviewPanel, key: string, id: string, chat: string, html: string, name: string): void {
    panel.title = name;
    panel.webview.html = widgetDocument(html, this.widgetStates()[key]?.fields, id && chat ? { id, chat, title: name } : undefined);
    this.widgetPanels.set(key, panel);
    this.widgetPages.set(key, html);
    panel.webview.onDidReceiveMessage((message: any) => {
      if (this.widgetPanels.get(key) !== panel || !message || typeof message !== "object") return;
      if (message.type === "state") {
        const fields = widgetFields(message.fields);
        if (fields) this.keepWidgetState(key, fields);
      } else if (message.type === "report" && id) {
        const errors = Array.isArray(message.errors) ? message.errors.filter((e: unknown) => typeof e === "string") : [];
        this.widgetReport(id, { shown: true, text: typeof message.text === "string" ? message.text : "", errors });
      }
    });
    panel.onDidDispose(() => { if (this.widgetPanels.get(key) === panel) { this.widgetPanels.delete(key); this.widgetPages.delete(key); } });
  }

  /** The window presets the backend takes (ready.capabilities.chatdgc.windows); none from one that doesn't say. */
  private windowPresets(): string[] {
    try {
      const offered = this.host?.chatdgcOffers?.()?.windows;
      return Array.isArray(offered) ? CHATDGC_WINDOWS.filter((w) => offered.includes(w)) : [];
    } catch { return []; }
  }

  /** The backend keeps widgets for the Library (ready.capabilities.chatdgc.widget_library). */
  private widgetLibrary(): boolean {
    try { return Number(this.host?.chatdgcOffers?.()?.widget_library) >= 1; } catch { return false; }
  }

  private readonly widgetRestores: { panel: vscode.WebviewPanel; id: string; chat: string }[] = [];

  /** A widget's tab VS Code kept across a restart: its page asked of the chat it's in, once the backend is up. */
  restoreWidget(panel: vscode.WebviewPanel, state: any): void {
    const ref = state?.dgcWidget;
    const id = String(ref?.id || ""), chat = String(ref?.chat || "");
    if (!WIDGET_ID.test(id) || !CONVERSATION_ID.test(chat) || this.widgetPanels.has(id)) { panel.dispose(); return; }
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    panel.webview.html = widgetDocument(`<p style="color:var(--muted)">Opening ${escapeHtml(widgetName(ref?.title))}…</p>`, undefined,
                                        { id, chat, title: widgetName(ref?.title) });
    this.widgetRestores.push({ panel, id, chat });
    panel.onDidDispose(() => { const at = this.widgetRestores.findIndex((r) => r.panel === panel); if (at >= 0) this.widgetRestores.splice(at, 1); });
    this.restoreWidgets();
  }

  private restoreWidgets(): void {
    for (const waiting of [...this.widgetRestores]) {
      const offers = this.host?.chatdgcOffers?.() || {};
      if (!("version" in offers)) return;                // not ready yet: backendReady asks again
      this.widgetRestores.splice(this.widgetRestores.indexOf(waiting), 1);
      if (!this.widgetLibrary()) { waiting.panel.dispose(); continue; }
      const requestId = this.nextId("widgetRestore");
      this.requests.set(requestId, { kind: "widgetRestore", widgetPanel: waiting.panel });
      const outcome = this.host?.chatdgcSend({ type: "chatdgc_widgets", request_id: requestId, op: "get", conversation_id: waiting.chat, widget_id: waiting.id });
      if (outcome !== "sent") { this.requests.delete(requestId); this.widgetRestores.push(waiting); return; }
    }
  }


  private adopt(panel: vscode.WebviewPanel, conversation: string, temporary: boolean, project = ""): void {
    panel.iconPath = this.chatdgcIcon();
    const tab: Tab = { panel, conversation, temporary, held: [], opened: false, picked: new Set(), ...(project ? { project } : {}),
                       mic: { post: (message) => this.post(tab, message) } };
    this.tabs.add(tab);
    panel.onDidDispose(() => {
      this.tabs.delete(tab);
      for (const [id, asker] of this.requests) { if (asker.tab === tab) this.requests.delete(id); }
      this.host?.dictation?.()?.release(tab.mic);
      this.host?.readAloud?.()?.release(tab.mic);
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
    // Said as late as this: a command held while the backend started learns only now what it offers.
    if (cmd.type === "chatdgc_open" && !cmd.widget_reports && this.reportsWidgets()) cmd = { ...cmd, widget_reports: true };
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
      // A tab opened before the backend was ready asked for models too early: its picker showed nothing chosen.
      void this.models(tab);
    }
    // The home's list, asked again whatever happened before: an answer that came while the side bar's page wasn't
    // ready to hear it (or a request turned away mid-start) would otherwise leave the home without its Chat tab.
    this.homeHeld = false;
    if (this.host) this.homeRefresh();
    // A tab that loaded before the backend was up was told of no window sizes: now it knows them.
    for (const tab of this.tabs) this.post(tab, { type: "windows", presets: this.windowPresets() });
    this.restoreWidgets();
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
        for (const waiting of tab.waitingSend?.splice(0) || []) this.post(tab, waiting);
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
      case "context_breakdown": {
        if (asker) this.requests.delete(requestId);
        if (!conversation) return;                        // a session's, not a chat's
        const breakdown = { window: ev.window, used: ev.used, source: ev.source, compact_at: ev.compact_at, buffer: ev.buffer,
                            free: ev.free, categories: Array.isArray(ev.categories) ? ev.categories : [],
                            ...(Array.isArray(ev.deferred) ? { deferred: ev.deferred } : {}) };
        for (const tab of showing(conversation)) this.post(tab, { type: "breakdown", conversation, breakdown });
        return;
      }
      case "chatdgc_widgets": {
        if (asker) this.requests.delete(requestId);
        if (asker?.kind === "widgets") {
          void asker.libraryPanel?.webview.postMessage({ type: "widgets", widgets: Array.isArray(ev.widgets) ? ev.widgets : [],
                                                         total: Number(ev.total) || 0, next: ev.next_offset ?? null });
          return;
        }
        const w = ev.widget && typeof ev.widget === "object" ? ev.widget : null;
        const chat = String(ev.conversation_id || "");
        if (asker?.kind === "widgetGet" && w && WIDGET_ID.test(String(w.id || "")) && typeof w.html === "string") {
          this.showWidget(w.id, w.html, String(w.title || ""), true, chat);
        } else if (asker?.kind === "widgetRestore" && asker.widgetPanel && w && WIDGET_ID.test(String(w.id || "")) && typeof w.html === "string") {
          if (this.widgetPanels.has(w.id)) asker.widgetPanel.dispose();
          else this.adoptWidget(asker.widgetPanel, w.id, w.id, chat, w.html, widgetName(w.title));
        } else if (asker?.kind === "widgetRemove") {
          const id = String(ev.widget_id || "");
          this.widgetPanels.get(id)?.dispose();
          this.keepWidgetState(id, null);
          void asker.libraryPanel?.webview.postMessage({ type: "changed" });
        }
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
      case "chatdgc_canvas": {
        const view = ev.canvas && typeof ev.canvas === "object" ? ev.canvas : null;
        if (!view || !CANVAS_ID.test(String(view.id || ""))) return;
        if (asker) this.requests.delete(requestId);
        if (asker?.kind === "canvasVersions") { void this.pickVersion(conversation, view); return; }
        // Asked to open it, a reply made or changed it, or a version came back: the editor beside the chat shows it.
        void this.showCanvas(conversation, view, asker?.kind === "canvasOpen");
        if (typeof ev.message_id === "string") {
          const card = { id: view.id, title: view.title, kind: view.kind, language: view.language, version: view.version, op: view.op };
          for (const tab of showing(conversation)) this.post(tab, { type: "canvas", messageId: ev.message_id, canvas: card });
        }
        return;
      }
      case "chatdgc_widget": {
        // An interactive answer: its card under the reply in every tab on the chat, and the widget itself in a tab
        // beside it (the chat keeps focus), as a canvas opens.
        const w = ev.widget && typeof ev.widget === "object" ? ev.widget : null;
        if (!w || !/^wg_[a-f0-9]{16}$/.test(String(w.id || "")) || typeof w.html !== "string" || w.html.length > 200_000) return;
        for (const tab of showing(conversation)) this.post(tab, { type: "widgetShown", messageId: ev.message_id, widget: w });
        // The reply waits to hear what it shows (from its page, once open), or at once that no tab shows the chat.
        if (this.reportsWidgets() && typeof conversation === "string" && conversation) this.widgetWaiting.set(w.id, conversation);
        if (showing(conversation).length) this.showWidget(w.id, w.html, String(w.title || ""), false, conversation);
        else this.widgetReport(w.id, { shown: false });
        return;
      }
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
        if (asker?.kind === "canvasExport") {
          this.requests.delete(requestId);
          void vscode.window.showInformationMessage(`Saved ${String(ev.path || "").split(/[\\/]/).pop()}.`);
          return;
        }
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
        if (asker?.kind === "widgetRestore") { asker.widgetPanel?.dispose(); return; }       // deleted since: no tab
        if (asker?.kind === "breakdown") return;          // the details show the meter's own lines instead
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
        // The webview (re)loaded: it shows what this tab holds, or a new chat. A recording it started is gone with
        // the page that showed it.
        this.host?.dictation?.()?.release(tab.mic);
        this.host?.readAloud?.()?.release(tab.mic);
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
        this.post(tab, { type: "windows", presets: this.windowPresets() });
        return;
      }
      case "pluginLogos": {
        // The logos of the plugins replies used ("Used [logo] Aave"), by id; "" for one with none (it shows a plug).
        const ids = Array.isArray(message.plugins) ? message.plugins.filter((id: unknown) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)).slice(0, 16) : [];
        if (!ids.length) return;
        const logos: Record<string, string> = {};
        for (const id of ids) logos[id] = this.host?.pluginLogo?.(id) || "";
        this.post(tab, { type: "pluginLogos", logos });
        return;
      }
      case "breakdown":
        // What fills this chat's window, part by part, for the meter's details (a backend that counts it).
        if (conversation && Number(this.host?.chatdgcOffers?.()?.context_breakdown) >= 1) {
          this.ask({ tab, kind: "breakdown" }, { type: "chatdgc_context_breakdown", conversation_id: conversation });
        }
        return;
      case "window": {
        // The window's size, chosen in the meter's details: for every chat, then this chat's meter again.
        const preset = String(message.preset || "");
        if (!this.windowPresets().includes(preset)) return;
        this.host?.chatdgcSetWindow?.(preset);
        if (conversation) this.ask({ tab, kind: "context" }, { type: "chatdgc_context", conversation_id: conversation });
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
        const picked = message.canvas_selection, selection = picked && typeof picked === "object" && CANVAS_ID.test(String(picked.canvas_id || ""))
          && Number.isInteger(picked.start_line) && Number.isInteger(picked.end_line) && typeof picked.text === "string" && picked.text.length <= 20_000
          ? { canvas_id: picked.canvas_id, start_line: picked.start_line, end_line: picked.end_line, text: picked.text } : undefined;
        if (this.unsavedCanvas(conversation)) await this.saveCanvases(conversation);   // the model reads what's on screen
        this.ask({ tab, kind: "send" }, { type: "chatdgc_send", conversation_id: conversation, text,
                                          ...(model ? { model } : {}), ...(thinking ? { thinking } : {}),
                                          ...(search ? { search } : {}),
                                          ...(typeof message.study === "boolean" ? { study: message.study } : {}),
                                          // Spoken in voice mode, on a backend that knows it: the reply is to sound like speech.
                                          ...(message.voice === true && this.host?.chatdgcOffers?.()?.voice_replies === 1 ? { voice: true } : {}),
                                          ...(selection ? { canvas_selection: selection } : {}),
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
          // A card of several questions answers them all at once, to a CLI that takes that (question_forms).
          const choices = message.choices === undefined ? null : message.choices;
          if (choices !== null && !(Array.isArray(choices) && choices.length >= 2 && choices.length <= 4
                                    && choices.every((c: unknown) => typeof c === "string" && !!c.trim() && c.length <= 500))) return;
          const forms = Number(this.host?.chatdgcOffers?.()?.question_forms) >= 1;
          this.ask({ tab, kind: "send" }, { type: "chatdgc_answer", conversation_id: conversation, message_id: message.messageId,
                                            question, choice, ...(choices && forms ? { choices: choices.map((c: string) => c.trim()) } : {}),
                                            ...chosen });
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
      case "widgetOpen": {
        // Open (again): the widget's own tab, beside the chat.
        const html = typeof message.html === "string" ? message.html : "";
        if (!html || html.length > 200_000) return;
        const id = /^wg_[a-f0-9]{16}$/.test(String(message.id || "")) ? String(message.id) : "";
        this.showWidget(id, html, String(message.title || ""), true, conversation || "");
        return;
      }
      case "saveImage": {
        // A chart as a PNG, drawn by the page: saved where you choose.
        const data = typeof message.data === "string" ? message.data : "";
        const found = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(data);
        if (!found || data.length > 20_000_000) return;
        const name = String(message.name || "chart.png").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").trim().slice(0, 80) || "chart.png";
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, /\.png$/i.test(name) ? name : `${name}.png`),
                                                            saveLabel: "Save", filters: { "PNG image": ["png"] } });
        if (!target) return;
        try {
          await vscode.workspace.fs.writeFile(target, Buffer.from(found[1], "base64"));
          void vscode.window.showInformationMessage(`Saved ${target.path.split("/").pop()}.`);
        } catch (err: any) {
          void vscode.window.showErrorMessage(`The image couldn't be saved: ${String(err?.message || err)}`);
        }
        return;
      }
      case "canvasOpen": {
        const canvasId = String(message.canvasId || "");
        if (!conversation || !CANVAS_ID.test(canvasId)) return;
        this.ask({ tab, kind: "canvasOpen" }, { type: "chatdgc_canvas", conversation_id: conversation, canvas_id: canvasId, op: "get" });
        return;
      }
      case "draftEdit": {
        // A writing block edited in place: the block's words as shown, and what replaces them.
        const messageId = String(message.messageId || "");
        const original = typeof message.original === "string" ? message.original : "";
        const text = typeof message.text === "string" ? message.text : "";
        if (!conversation || !MESSAGE_ID.test(messageId) || !original || !text.trim() || original.length > 60_000 || text.length > 60_000) return;
        this.ask({ tab, kind: "draft" }, { type: "chatdgc_draft", conversation_id: conversation, message_id: messageId, original, text });
        return;
      }
      case "openMail": {
        // An email draft into the user's mail app, as a new message with its fields filled in (RFC 6068). A body
        // too long for a mailto link (some apps cut it near 2,000) goes on the clipboard instead, and says so.
        const field = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
        const to = field(message.to, 500).replace(/[\r\n]/g, " ").trim(), subject = field(message.subject, 500).replace(/[\r\n]/g, " ");
        const body = field(message.body, 100_000);
        const enc = (v: string) => encodeURIComponent(v.replace(/\r?\n/g, "\r\n"));
        const head = [["cc", field(message.cc, 500)], ["bcc", field(message.bcc, 500)], ["subject", subject]]
          .filter(([, v]) => v.trim()).map(([k, v]) => `${k}=${enc(v.replace(/[\r\n]/g, " "))}`);
        let link = `mailto:${to.split(/\s*[,;]\s*/).filter(Boolean).map((a) => encodeURIComponent(a).replace(/%40/g, "@")).join(",")}`;
        const full = [...head, ...(body ? [`body=${enc(body)}`] : [])];
        const long = link.length + full.join("&").length > 1900;
        const query = long ? head : full;
        if (query.length) link += `?${query.join("&")}`;
        if (long) {
          await vscode.env.clipboard.writeText(body);
          void vscode.window.showInformationMessage("The email is long for a mail link, so its text is on your clipboard: paste it into the new message.");
        }
        const opened = await vscode.env.openExternal(vscode.Uri.parse(link, true));
        if (!opened) void vscode.window.showWarningMessage("No mail app opened. Use Copy and paste it into your email instead.");
        return;
      }
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
      case "micStart":
      case "micStop":
      case "micCancel":
      case "voiceCheck": {
        const dictation = this.host?.dictation?.();
        if (!dictation) { this.post(tab, { type: "mic", state: "idle", error: "Update the DGC CLI to use voice." }); return; }
        await dictation.handle(tab.mic, message);
        return;
      }
      case "speakStart":
      case "speakStop": {
        const reader = this.host?.readAloud?.();
        if (!reader) { this.post(tab, { type: "speak", id: String(message.id || ""), state: "idle", error: "Update the DGC CLI to use voice." }); return; }
        await reader.handle(tab.mic, message);
        return;
      }
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
