// Settings in a narrow editor tab, laid out in real Chromium. The visual pass (2026-10-17): with a wide DGC side
// bar and three editor groups, the Settings tab was ~270px wide and its rows crushed their words beside the
// control -- "DGC Ultra"'s hint ran nine lines in a 60px column beside its switch, "Updated 08:56 PM" broke a
// syllable per line beside Refresh, the usage figures clipped "17.3k" to "17.3l", the filter box scrolled the page
// sideways, and Memory's and Voice's words ran five lines. jsdom has no layout, so editor-settings.test.mjs passed
// over all of it; this renders the real client and its CSS, inside the defaults VS Code itself injects into every
// webview (its body padding of 0 20px and 10px scroll bars), so the page gets the width it really gets.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const src = new URL("../src/", import.meta.url).pathname;
// As esbuild.js builds dist/settings.js and dist/settings.css (settings.css @imports settingsUsage.css).
const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out",
  platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
// The editor tab's own document (settingsView.ts), so the shell, side bar and main are the real ones.
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const viewModule = { exports: {} };
new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const skeleton = viewModule.exports.settingsDocument("SCRIPT", "STYLE", "");

// What VS Code prepends to every webview's <head> (workbench/contrib/webview/browser/pre/index.html), in its
// own cascade layer so any rule of the page's wins; the font is VS Code's on Linux.
const VSCODE_WEBVIEW = '<style id="_defaultStyles">@layer vscode-default{body{margin:0;padding:0 20px;font-family:var(--vscode-font-family);'
  + "font-size:var(--vscode-font-size)}::-webkit-scrollbar{width:10px;height:10px}}</style>"
  + '<style>:root{--vscode-font-family:system-ui,"Ubuntu","Droid Sans",sans-serif;--vscode-font-size:13px}</style>';

const hostFor = (opts = {}) => `(${function (opts) {
  const config = { type: "config", mode: "auto", think: "off", ultra_mode: false, max_parallel_tasks: 4, turn_token_budget: 0,
    context_size: 65536, suggest: true, monitor_wake: true, tool_profile: "standard" };
  const memory = { type: "memory_state", enabled: true, projects: [], facts: opts.facts ? [{ id: "f1", text: "Prefers metric units and short answers",
    source: { surface: "chat", where: "Weekend in Lisbon" }, updated_at: "2026-10-17T10:00:00Z" }] : [] };
  if (opts.facts) memory.projects = [{ name: "evolving-fungi", folder: "/home/me/evolving-fungi", when: "today", remember: true, recent: ["Fix the narrow settings layout"] }];
  // dgc/voice/catalog.py's dictation models: Nemotron's facts line is the longest.
  const models = [
    { id: "moonshine-base-en", role: "dictation", name: "Moonshine", summary: "Fast. English only.", languages: "English", licence: "MIT", size: 111266225 },
    { id: "nemotron-3.5-asr", role: "dictation", name: "Nemotron 3.5", summary: "Most accurate. 40 languages, found by itself.",
      languages: "40 languages", licence: "NVIDIA Open Model (OpenMDW-1.1)", size: 475271763 }];
  const event = (ev) => setTimeout(() => window.postMessage({ type: "event", event: ev }, "*"), 1);
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m.type === "ready") event(config);
    else if (m.type === "getMemory") event(memory);
    else if (m.type === "listMcp") event({ type: "mcp_servers", items: [{ name: "local-files", enabled: true, state: "connected",
      command: "npx -y @modelcontextprotocol/server-filesystem", tool_count: 12 }] });
    else if (m.type === "getVoice") event({ type: "voice_state", models, runtime: { installed: false, size_mb: 50 } });
    else if (m.type === "getUsage") event({ type: "usage_report", request_id: m.requestId, range: m.range, timezone: "IST, UTC+05:30",
      generated_at: "2026-10-17T15:26:00Z", totals: { input_tokens: 17346, output_tokens: 459, cached_input_tokens: 0, requests: 3 },
      by_model: [{ model: "deepseek-v4.1-flash:cloud", provider: "ollama", host: "localhost:11434", input_tokens: 17346, output_tokens: 459, requests: 3 }],
      by_day: [{ date: "2026-10-16", input_tokens: 9000, output_tokens: 200, requests: 1 }, { date: "2026-10-17", input_tokens: 8346, output_tokens: 259, requests: 2 }] });
  } });
}})(${JSON.stringify(opts)});`;
const pageFor = (opts) => skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", "<head>" + VSCODE_WEBVIEW)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`)
  .replace("<body>", '<body class="vscode-dark">')
  .replace('<script src="SCRIPT"></script>', () => `<script>${hostFor(opts)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);

async function open(width, section, opts = {}) {
  const html = pageFor(opts);
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "Asia/Kolkata" });
  const p = await context.newPage();
  await p.route("https://settings.test/**", (r) => r.fulfill({ body: html, contentType: "text/html" }));
  await p.goto("https://settings.test/view");
  await p.waitForSelector("#ultra_mode");
  if (section !== "general") await p.click(`[data-nav=${section}]`);
  return { p, close: () => context.close() };
}
// A text run's lines and width, beside the room its card (or the page) has for it.
const run = (p, selector) => p.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const range = document.createRange(); range.selectNodeContents(el);
  const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
  const holder = el.closest(".card") || document.getElementById("page");
  const s = getComputedStyle(holder);
  const room = holder.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
  return { lines: tops.size, width: Math.round(el.getBoundingClientRect().width), room: Math.round(room), viewport: innerWidth,
    text: el.textContent.trim().slice(0, 40) };
}, selector);
// The control is below its words (wrapped underneath), or beside them on the same line.
const placement = (p, words, control) => p.evaluate(([w, c]) => {
  const a = document.querySelector(w).getBoundingClientRect(), b = document.querySelector(c).getBoundingClientRect();
  return { under: b.top >= a.bottom - 1, beside: b.left >= a.right - 1 && b.top < a.bottom && b.bottom > a.top };
}, [words, control]);
const readable = (r, most) => {
  assert.ok(r, "the text is on the page");
  // A readable column: 150px, or all a tab narrower than 190px can give.
  assert.ok(r.width >= Math.min(150, r.viewport - 40), `"${r.text}" gets ${r.width}px (its card has ${r.room}px) in a ${r.viewport}px tab`);
  assert.ok(r.lines <= most, `"${r.text}" takes ${r.lines} lines at ${r.width}px`);
};
const noSideways = async (p) => {
  const main = await p.$eval("#main", (m) => ({ client: m.clientWidth, scroll: m.scrollWidth }));
  assert.ok(main.scroll <= main.client, `the page scrolls sideways (${main.scroll}px in ${main.client}px)`);
};

test("General at 270px: DGC Ultra's words keep a readable column and its switch wraps underneath", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(270, "general");
  try {
    const hint = '.field:has(#ultra_mode) .hint';
    readable(await run(p, hint), 3);
    assert.ok((await placement(p, ".field:has(#ultra_mode)>span", "#ultra_mode")).under, "the switch sits under its words");
    await noSideways(p);
  } finally { await close(); }
});

test("Memory at 270px: the switch's words and the empty list read in a full column; a fact's and a project's controls wrap underneath", async (t) => {
  if (skipOrFail(t)) return;
  let { p, close } = await open(270, "memory");
  try {
    await p.waitForSelector(".memory-facts p.empty");
    readable(await run(p, ".field:has([data-memory-switch]) .hint"), 4);
    readable(await run(p, ".memory-facts p.empty"), 4);
    await noSideways(p);
  } finally { await close(); }
  ({ p, close } = await open(270, "memory", { facts: true }));
  try {
    await p.waitForSelector("[data-memory-edit]");
    readable(await run(p, ".memory-facts .row .copy strong"), 3);
    assert.ok((await placement(p, ".memory-facts .row .copy", ".memory-facts .row .actions")).under, "Edit and Delete sit under the fact");
    readable(await run(p, ".row:has([data-memory-project]) .copy strong"), 2);
    assert.ok((await placement(p, ".row:has([data-memory-project]) .copy", "[data-memory-project]")).under, "a project's switch sits under its words");
    await p.click("[data-memory-edit]");
    const edit = await p.$eval("#memory-edit", (el) => Math.round(el.getBoundingClientRect().width));
    assert.ok(edit >= 150, `the box to edit a fact is ${edit}px wide`);
    await noSideways(p);
  } finally { await close(); }
});

test("Voice at 270px: a model's facts line reads in a full column", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(270, "voice");
  try {
    await p.waitForSelector('[data-voice-model="nemotron-3.5-asr"]');
    readable(await run(p, '[data-voice-model="nemotron-3.5-asr"] .description'), 3);
    await noSideways(p);
  } finally { await close(); }
});

test("Token usage at 270px: the status never breaks inside a word, the figures stack unclipped, nothing scrolls sideways", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(270, "usage");
  try {
    await p.waitForFunction(() => document.querySelectorAll(".usage-figure").length === 4);
    const status = await run(p, "#usage-status");
    assert.equal(status.text, "Updated 08:56 PM");
    assert.equal(status.lines, 1, `"Updated 08:56 PM" takes ${status.lines} lines at ${status.width}px`);
    readable(await run(p, "#usage-timezone"), 3);
    const figures = await p.$$eval(".usage-figure", (els) => els.map((f) => {
      const value = f.querySelector(".usage-figure-value"), r = f.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), clipped: f.scrollWidth > f.clientWidth || value.scrollWidth > value.clientWidth,
        label: f.getAttribute("aria-label") };
    }));
    for (const f of figures) assert.ok(!f.clipped, `${f.label}: clipped in a ${f.width}px box`);
    assert.equal(new Set(figures.map((f) => f.left)).size, 1, `one figure per row (${JSON.stringify(figures.map((f) => [f.left, f.top]))})`);
    const exact = await run(p, ".usage-figure-exact");
    assert.equal(exact.lines, 1, `"${exact.text}" takes ${exact.lines} lines`);
    await noSideways(p);
  } finally { await close(); }
});

test("MCP servers at 270px: a server's words stay beside its mark, and its switch and gear wrap underneath", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(270, "mcp");
  try {
    await p.waitForSelector('[data-mcp-toggle="local-files"]');
    const row = 'article.row:has([data-mcp-toggle="local-files"])';
    assert.ok((await placement(p, `${row} .mark`, `${row} .copy`)).beside, "the words beside the server's mark");
    assert.ok((await placement(p, `${row} .copy`, `${row} .actions`)).under, "the switch and gear under the words");
    const words = await run(p, `${row} .copy strong`);
    assert.ok(words.width >= words.room - 52, `"${words.text}" gets ${words.width}px of the ${words.room - 50}px beside its mark`);
    await noSideways(p);
  } finally { await close(); }
});

test("at 900px nothing moved: each control sits beside its words, the figures share one row, VS Code's gutter stays", async (t) => {
  if (skipOrFail(t)) return;
  let { p, close } = await open(900, "general");
  try {
    assert.equal(await p.evaluate(() => getComputedStyle(document.body).paddingLeft), "20px", "VS Code's own webview gutter");
    assert.ok((await placement(p, ".field:has(#ultra_mode)>span", "#ultra_mode")).beside, "the Ultra switch beside its words");
    assert.ok((await placement(p, ".field:has(#mode)>span", "#mode")).beside, "the Permission mode select beside its words");
    assert.equal((await run(p, ".field:has(#ultra_mode) .hint")).lines, 1);
  } finally { await close(); }
  ({ p, close } = await open(900, "memory", { facts: true }));
  try {
    await p.waitForSelector("[data-memory-edit]");
    assert.ok((await placement(p, ".field:has([data-memory-switch])>span", "[data-memory-switch]")).beside, "the memory switch beside its words");
    assert.ok((await placement(p, ".memory-facts .row .copy", ".memory-facts .row .actions")).beside, "Edit and Delete beside the fact");
    assert.ok((await placement(p, ".row:has([data-memory-project]) .copy", "[data-memory-project]")).beside, "a project's switch beside its words");
  } finally { await close(); }
  ({ p, close } = await open(900, "usage"));
  try {
    await p.waitForFunction(() => document.querySelectorAll(".usage-figure").length === 4);
    assert.ok((await placement(p, "#usage-status", "#usage-refresh")).beside, "Refresh beside the status");
    assert.ok((await placement(p, "#usage-timezone", "#usage-range")).beside, "the range beside its words");
    const tops = await p.$$eval(".usage-figure", (els) => els.map((f) => Math.round(f.getBoundingClientRect().top)));
    assert.equal(new Set(tops).size, 1, `the four figures share one row (${tops})`);
  } finally { await close(); }
  ({ p, close } = await open(900, "mcp"));
  try {
    await p.waitForSelector('[data-mcp-toggle="local-files"]');
    const row = 'article.row:has([data-mcp-toggle="local-files"])';
    assert.ok((await placement(p, `${row} .copy`, `${row} .actions`)).beside, "a server's switch and gear beside its words");
  } finally { await close(); }
});
