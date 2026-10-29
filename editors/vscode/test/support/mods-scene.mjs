// The user's mods in the real Work panel and the real ChatDGC screen, in Chromium: a running mod with a status, a
// band and a panel, one waiting for an Allow, one from a plugin, a command's answer, a notice and the question about
// a mod DGC wrote. Shared by mods-layout-browser.test.mjs (assertions) and render-mods.mjs (the screenshots).
// setContent only; no port is opened. Not a *.test.mjs file.
import { build } from "esbuild";
import { THEMES, panelHtml } from "./options-scene.mjs";
import { openChat } from "./chat-scene.mjs";

export { THEMES };
export const LONG = "edit_file 41 · bash 17 · read_file 112 · grep 9 · write_file 3 · web_fetch 2 · apply_patch 6 · todo 4";
export const MODS = [
  { name: "tally", title: "Tally", version: "1.0.0", description: "Counts the steps DGC takes this session.", builtin: true,
    dev: false, state: "running", error: "",
    asks: ["Run Python code from Tally, in a sandbox.", "It can see each step DGC is about to take, and stop it or ask you first.",
           "It can see what each step returned.", "It can show a line in the status bar, a panel beside the chat.",
           "It adds /tally.", "It can't reach the internet.", "It can never approve anything for you."],
    missing: [], commands: [{ name: "tally", description: "Steps this session, by tool" }], draws: ["status", "pane", "band"] },
  { name: "context", title: "Context", version: "1.0.0", description: "What fills the context window, part by part.",
    builtin: true, dev: false, state: "running", error: "", asks: ["It can read this session's token use."], missing: [],
    commands: [{ name: "window", description: "The context window, part by part" }], draws: ["status", "pane"] },
  { name: "guard", title: "Guard", version: "1.0.0", description: "Holds a risky command and asks you first.", builtin: true,
    dev: false, state: "needs_allow", error: "",
    review: "a".repeat(64),
    asks: ["Run Python code from Guard, in a sandbox.", "It can see each step DGC is about to take, and stop it or ask you first.",
           "It can read your project's git status and changes.", "It can show short notices.", "It can't reach the internet.",
           "It can never approve anything for you."], missing: ["event:tool.call"], commands: [], draws: ["toast"] },
  { name: "release-notes", title: "Release notes", version: "2.1.0", description: "Drafts release notes from the merged work.",
    builtin: false, dev: false, state: "off", error: "", plugin: "shipkit", plugin_title: "Ship Kit",
    asks: ["Run JavaScript code from Release notes, in a sandbox.", "It can read your project's git status and changes.",
           "It adds /notes.", "It can reach api.github.com on the internet, and nothing else."], missing: [], commands: [], draws: [] },
];
export const STATUS = { type: "Row", children: [{ type: "Text", text: "214 steps" }, { type: "Text", text: LONG, tone: "muted" }] };
export const CONTEXT = { type: "Row", children: [{ type: "Text", text: "41%", tone: "warn" }, { type: "Bar", segments: [
  { label: "used", value: 41, tone: "warn" }, { label: "free", value: 59, tone: "muted" }] }] };
export const BAND = { type: "Row", children: [{ type: "Text", text: "watching" }, { type: "Text", text: "3 held · 0 stopped", tone: "ok" },
  { type: "Sparkline", values: [2, 4, 3, 6, 5, 9, 7, 11], label: "steps" }] };
export const PANE = { type: "Column", children: [
  { type: "Markdown", text: "### Steps by tool\nThis session, **214** steps so far. `bash` was the slowest." },
  { type: "Bar", segments: [{ label: "read", value: 112, tone: "accent" }, { label: "edit", value: 47, tone: "ok" },
    { label: "bash", value: 17, tone: "warn" }, { label: "failed", value: 4, tone: "bad" }] },
  { type: "Table", columns: ["Tool", "Steps", "Failed"], rows: [["read_file", 112, 0], ["edit_file", 41, 1], ["bash", 17, 3],
    ["grep", 9, 0], ["a_tool_with_a_rather_long_name_that_wraps", 1, 0]] },
  { type: "Sparkline", values: [3, 5, 4, 8, 6, 12, 9, 14, 11, 16], label: "per turn" },
  { type: "Box", title: "Reset", children: [{ type: "Text", text: "Start counting again from zero.", tone: "muted" },
    { type: "Row", children: [{ type: "Input", id: "why", placeholder: "Why (optional)" },
      { type: "Select", id: "scope", options: [{ value: "session", label: "This session" }, { value: "all", label: "Everything" }], value: "session" },
      { type: "Button", id: "reset", label: "Reset", tone: "accent" }] }] },
  { type: "Row", children: ["muted", "strong", "accent", "ok", "warn", "bad"].map((t) => ({ type: "Text", text: t, tone: t })) }] };
export const OFFER = { type: "mod_offer", id: "mo_0123456789abcdef", name: "counter", mod: "Counter", version: "1.0.0",
  folder: "mods/counter", asks: ["Run Python code from Counter, in a sandbox.", "It can see what each step returned.",
    "It can show a line in the status bar.", "It adds /count.", "It can't reach the internet.", "It can never approve anything for you."],
  more: false };
export const RESULT = { type: "Column", children: [{ type: "Text", text: "214 steps this session", tone: "strong" },
  { type: "Table", columns: ["Tool", "Steps"], rows: [["read_file", 112], ["edit_file", 41], ["bash", 17]] }] };

const frames = (surface) => [
  { type: "mods", mods: MODS, on: true, surface },
  { type: "mod_ui", name: "tally", mod: "Tally", slot: "status", tree: STATUS, surface },
  { type: "mod_ui", name: "context", mod: "Context", slot: "status", tree: CONTEXT, surface },
  { type: "mod_ui", name: "tally", mod: "Tally", slot: "band", tree: BAND, surface },
  { type: "mod_ui", name: "tally", mod: "Tally", slot: "pane", tree: PANE, surface },
];

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// The Work panel with the mods drawn. theme: dark-modern, light-modern, hc.
export async function openWork(browser, { width = 1200, height = 760, theme = "dark-modern" } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate(([t, mjs, mdjs]) => {
    document.body.classList.add(t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark");
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [theme, mainJs, markdownJs]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const event = (ev) => send({ type: "event", event: ev });
  const posted = (op) => page.evaluate((o) => window.__posted.filter((m) => m.type === "mods" && (!o || m.op === o)), op);
  await event({ type: "ready", capabilities: { live_steering: true, mods: { version: 1, offers: 1 } }, model: "qwen3-coder:30b",
                mode: "default", think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true, commands: [],
                custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536 });
  await send({ type: "session_ready", sessionId: "s1" });
  for (const f of frames("work")) await event(f);
  await settle(page);
  return { page, send, event, posted, errors, settle: () => settle(page) };
}

// The transcript with a little in it, then a command's answer, a notice and the question.
export async function workTranscript(scene) {
  const { event, page } = scene;
  await event({ type: "turn_start", turn_id: "t1", prompt: "Add a counter mod for this project", kind: "prompt" });
  await event({ type: "text_delta", text: "I wrote `mods/counter` with its manifest and code, and checked it with `dgc mods validate`." });
  await event({ type: "stream_end" });
  await event({ ...OFFER, surface: "work" });
  await event({ type: "turn_end", turn_id: "t1" });
  await event({ type: "mod_toast", name: "tally", mod: "Tally", text: "counting from zero again", surface: "work" });
  const id = await page.evaluate(() => {
    const input = document.getElementById("input");
    input.textContent = "/tally"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("send").click();
    return window.__posted.filter((m) => m.type === "mods" && m.op === "command").at(-1)?.request_id;
  });
  await event({ type: "mod_result", request_id: id, name: "tally", mod: "Tally", tree: RESULT });
  await scene.settle();
}

// ChatDGC with the mods drawn.
export async function openChatMods(browser, { width = 1200, height = 760, theme = "dark-modern" } = {}) {
  const scene = await openChat(browser, { width, height, theme });
  const { send, page } = scene;
  await send({ type: "modsReady", capabilities: { mods: { version: 1, offers: 1 } } });
  for (const f of frames("chat")) await send({ type: "modsEvent", event: f });
  await settle(page);
  return { ...scene, settle: () => settle(page),
           modsPosted: (op) => page.evaluate((o) => window.__posted.filter((m) => m.type === "mods" && (!o || m.op === o)), op) };
}

// Settings, with a host that answers like the extension: one installed plugin, the mods list, and an install review
// of a plugin with two mods (one asking for more than before). theme: dark or light. Posted messages: window.__posted.
let settingsBuilt;
async function settingsBundle() {
  if (settingsBuilt) return settingsBuilt;
  const src = new URL("../../src/", import.meta.url).pathname;
  const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out",
    platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
  const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
  const viewModule = { exports: {} };
  new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
  settingsBuilt = { js: bundled.outputFiles.find((f) => f.path.endsWith(".js")).text,
                    css: bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n"),
                    skeleton: viewModule.exports.settingsDocument("SCRIPT", "STYLE", "") };
  return settingsBuilt;
}
const SETTINGS_TOKENS = {
  dark: { body: "vscode-dark", vars: "--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-input-background:#313131;--vscode-input-border:#3c3c3c;--vscode-panel-border:#2b2b2b;--vscode-widget-border:#313131;--vscode-editorWidget-background:#202020;--vscode-focusBorder:#0078d4;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;" },
  light: { body: "vscode-light", vars: "--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-descriptionForeground:#3b3b3b;--vscode-input-background:#ffffff;--vscode-input-border:#cecece;--vscode-panel-border:#e5e5e5;--vscode-widget-border:#e5e5e5;--vscode-editorWidget-background:#f8f8f8;--vscode-focusBorder:#005fb8;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;" },
};
const settingsHost = (mods, unsupported) => `(${function (list, none) {
  const post = (m) => setTimeout(() => window.postMessage(m, "*"), 1);
  const review = { name: "shipkit", display_name: "Ship Kit", summary: "Release notes and a changelog check.", license: "MIT", install: "allow",
    marketplace: "personal", upstream: "Created locally", supported: true, skills: [], server_specs: {}, warnings: [],
    mods: [{ name: "release-notes", title: "Release notes", version: "2.1.0", state: "more", grants: [],
      asks: ["Run JavaScript code from Release notes, in a sandbox.", "It can read your project's git status and changes.", "It adds /notes.",
             "It can reach api.github.com on the internet, and nothing else.", "It can never approve anything for you."] },
      { name: "changelog-check", title: "Changelog check", version: "1.0.0", state: "new", grants: [],
      asks: ["Run Python code from Changelog check, in a sandbox.", "It can see each step DGC is about to take, and stop it or ask you first.", "It can't reach the internet.", "It can never approve anything for you."] }] };
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    window.__posted.push(m);
    if (m.type === "ready") post({ type: "plugins", items: [{ name: "shipkit", display_name: "Ship Kit", summary: "Release notes and a changelog check.", installed: true, license: "MIT", marketplace: "personal", skills: [] }] });
    else if (m.type === "modsList") post(none ? { type: "mods", unsupported: true } : { type: "mods", mods: list, on: true });
    else if (m.type === "inspectPlugin") post({ type: "pluginPreview", requested: m.name, item: review });
  } });
}})(${JSON.stringify(mods)}, ${JSON.stringify(!!unsupported)});`;
export async function openSettings(browser, { width = 1200, height = 900, theme = "dark", mods = MODS, unsupported = false } = {}) {
  const { js, css, skeleton } = await settingsBundle();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const tokens = SETTINGS_TOKENS[theme];
  const html = skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace('<link rel="stylesheet" href="STYLE">', () => `<style>:root{${tokens.vars}--vscode-font-family:system-ui,sans-serif;--vscode-editor-font-family:ui-monospace,monospace}</style><style>${css}</style>`)
    .replace("<body>", `<body class="${tokens.body}">`)
    .replace('<script src="SCRIPT"></script>', () => `<script>${settingsHost(mods, unsupported)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => window.postMessage({ type: "show", section: "plugins" }, "*"));
  await page.waitForTimeout(60);
  return { page, errors, posted: (type) => page.evaluate((t) => window.__posted.filter((m) => !t || m.type === t), type) };
}
