// ChatDGC's screen and the Library as src/chatdgc.ts serves them, in Chromium, for the artifact tests and captures:
// each page's own document with its stylesheets inlined and its scripts run after a stub acquireVsCodeApi, as
// chatdgc-screen.test.mjs does. Not a *.test.mjs file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { THEMES } from "./options-scene.mjs";
import { extensionRoot as root } from "./artifact-scene.mjs";

const read = (name) => readFileSync(join(root, name), "utf8");
const codicon = () => read("media/codicon.css").replace(/url\([^)]*codicon\.ttf[^)]*\)/,
  `url("data:font/ttf;base64,${readFileSync(join(root, "media/codicon.ttf")).toString("base64")}")`);

let cached;
function documents() {
  if (cached) return cached;
  const source = read("src/chatdgc.ts");
  const docs = [...source.matchAll(/return `(<!doctype html>[\s\S]*?<\/html>)`;/g)].map((m) => m[1]);
  const prepare = (doc) => doc.replace(/<link [^>]*>/g, "").replace(/<script [^>]*><\/script>/g, "").replace(/\$\{[^}]*\}/g, "")
    .replace("font-src ;", "font-src data:;");
  const scripts = (doc) => [...doc.matchAll(/asset\("media\/([\w-]+\.js)"\)/g)].map((m) => m[1]).map((f) => read(`media/${f}`)).join("\n");
  const css = read("media/main.css").replace(/@import[^;]*;/, "") + read("media/mentions.css");
  const own = read("media/chatdgc.css") + read("media/voicebar.css");
  const styled = (doc) => prepare(doc).replace("</head>", `<style>${codicon()}</style><style>${css}</style><style>${own}</style></head>`);
  const chat = docs.find((d) => d.includes('id="cd-input"'));
  const library = docs.find((d) => d.includes('id="lib-list"'));
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife",
    globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  cached = { chat: { html: styled(chat), js: scripts(chat) }, library: { html: styled(library), js: scripts(library) }, markdownJs };
  return cached;
}

async function open(browser, which, { width, height, theme, state }) {
  const docs = documents();
  const { html, js } = docs[which];
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([code, md, saved]) => {
    window.__posted = []; window.__state = saved;
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => window.__state, setState(s) { window.__state = s; } });
    eval(md + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(code);
  }, [js, docs.markdownJs, state]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => !t || m.type === t), type);
  return { page, send, posted, errors };
}

export const openChat = (browser, { width = 900, height = 760, theme = "dark-modern", state } = {}) => open(browser, "chat", { width, height, theme, state });
export const openLibrary = (browser, { width = 900, height = 760, theme = "dark-modern", state } = {}) => open(browser, "library", { width, height, theme, state });

export const OFFER = { version: 1, types: ["page", "doc", "slides", "sheet", "dashboard"], outputs: ["auto", "document", "slides", "spreadsheet", "page", "dashboard"],
                       exports: { doc: ["docx", "pdf", "md"], slides: ["pptx", "pdf", "html"], sheet: ["xlsx", "csv"], dashboard: ["html"], page: ["html", "zip"] } };
export const CHAT = `chat_${"a".repeat(32)}`;
export const M = (n) => `msg_${String(n).repeat(32).slice(0, 32)}`;
export const conversation = (extra = {}) => ({ id: CHAT, title: "Q3 planning", model: null, thinking: null, pinned: false, archived: false, temporary: false, ...extra });
const A = (c, type, title, version, origin, updated) => ({ id: `ar_${c.repeat(16)}`, type, label: { doc: "Document", slides: "Slides", sheet: "Spreadsheet", page: "Page", dashboard: "Dashboard" }[type],
  title, version, created: "2026-10-26T10:00:00Z", updated, origin: { surface: origin }, exports: OFFER.exports[type] });
/** A Library's worth: every kind, made in Chat, Work and by a Pip. */
export const ITEMS = [
  A("1", "slides", "Q3 plan", 3, "chat", "2026-10-28T08:40:00Z"),
  A("2", "sheet", "Home budget", 2, "work", "2026-10-28T07:10:00Z"),
  A("3", "dashboard", "Store sales", 1, "pip", "2026-10-27T18:00:00Z"),
  A("4", "page", "Tip calculator", 1, "work", "2026-10-26T12:00:00Z"),
  A("5", "doc", "Launch notes", 4, "chat", "2026-10-25T09:30:00Z"),
];
