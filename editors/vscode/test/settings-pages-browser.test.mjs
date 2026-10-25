// Every Settings page, laid out in real Chromium at a 300, 460 and 900 px tab, in VS Code's dark and light themes
// (the tokens VS Code itself injects): nothing is cut off, nothing scrolls sideways, the page follows the theme --
// side list included, no dark list in a light VS Code -- and where the room allows (460 and 900), every row's hint is
// one line, the rest of its words behind "?". jsdom has no layout or cascade, so editor-settings.test.mjs can't.
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
const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out",
  platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const viewModule = { exports: {} };
new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const skeleton = viewModule.exports.settingsDocument("SCRIPT", "STYLE", "");

// What VS Code injects for Default Dark Modern and Default Light Modern.
const THEMES = {
  dark: { body: "vscode-dark", tokens: { "--vscode-editor-background": "#1f1f1f", "--vscode-sideBar-background": "#181818",
    "--vscode-foreground": "#cccccc", "--vscode-editor-foreground": "#cccccc", "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-input-background": "#313131", "--vscode-input-border": "#3c3c3c", "--vscode-panel-border": "#2b2b2b",
    "--vscode-widget-border": "#313131", "--vscode-editorWidget-background": "#202020", "--vscode-focusBorder": "#0078d4",
    "--vscode-list-hoverBackground": "#2a2d2e", "--vscode-list-inactiveSelectionBackground": "#37373d",
    "--vscode-button-secondaryBackground": "#313131", "--vscode-button-secondaryForeground": "#cccccc", "--vscode-errorForeground": "#f85149" } },
  light: { body: "vscode-light", tokens: { "--vscode-editor-background": "#ffffff", "--vscode-sideBar-background": "#f8f8f8",
    "--vscode-foreground": "#3b3b3b", "--vscode-editor-foreground": "#3b3b3b", "--vscode-descriptionForeground": "#3b3b3b",
    "--vscode-input-background": "#ffffff", "--vscode-input-border": "#cecece", "--vscode-panel-border": "#e5e5e5",
    "--vscode-widget-border": "#e5e5e5", "--vscode-editorWidget-background": "#f8f8f8", "--vscode-focusBorder": "#005fb8",
    "--vscode-list-hoverBackground": "#f2f2f2", "--vscode-list-inactiveSelectionBackground": "#e4e6f1",
    "--vscode-button-secondaryBackground": "#e5e5e5", "--vscode-button-secondaryForeground": "#3b3b3b", "--vscode-errorForeground": "#f85149" } },
};
// A host that answers like the extension, with a little of everything a page shows.
const host = `(${function () {
  const config = { type: "config", mode: "auto", think: "off", base_url: "http://127.0.0.1:11434/v1", model: "deepseek-v4.1-flash:cloud",
    api_mode: "auto", max_parallel_tasks: 4, context_size: 65536, subagent_context_size: 0, list_models_at: true, turn_token_budget: 0,
    pips_settable: true, pips_model: "", cache_settable: true, prompt_cache_ttl: "5m", ollama_keep_alive: "30m",
    wait_settable: true, wait_first_word: "minutes", wait_first_word_minutes: "40", wait_between_words: "5",
    search: "ollama", search_url: "", search_api_key_set: false, search_providers: ["duckduckgo", "brave", "tavily", "searxng", "ollama"],
    search_keys: { brave: true, tavily: false, ollama: false }, chatdgc_personality: "default", chatdgc_window: "32k", chatdgc_about: "", chatdgc_style: "",
    chatdgc_web: true, chatdgc_followups: true, sandbox: false };
  const plugin = (name, extra = {}) => ({ name, display_name: name[0].toUpperCase() + name.slice(1), summary: "Short writing templates for a status note, a decision, a plan and a letter.",
    installed: false, license: "MIT", marketplace: "dgc-curated", skills: [{ name: "status-note", description: "Write a one-page project status in plain Markdown.", enabled: true }], ...extra });
  const plugins = [plugin("templates", { installed: true }), plugin("granola"), plugin("airtable", { requirements: "An Airtable account (all plans)." })];
  const event = (ev) => setTimeout(() => window.postMessage({ type: "event", event: ev }, "*"), 1);
  const post = (m) => setTimeout(() => window.postMessage(m, "*"), 1);
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m.type === "ready") { event(config); post({ type: "plugins", items: plugins }); }
    else if (m.type === "listModelsAt") post({ type: "modelsAt", token: m.token, role: m.role, ids: ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud"] });
    else if (m.type === "getMemory") event({ type: "memory_state", enabled: true, facts: [{ id: "f1", text: "Prefers metric units and short answers", source: { surface: "chat", where: "Weekend in Lisbon" }, updated_at: "2026-10-17T10:00:00Z" }],
      projects: [{ name: "evolving-fungi", folder: "/home/me/evolving-fungi", when: "today", remember: true, recent: ["Fix the narrow settings layout"] }] });
    else if (m.type === "getMemoryHistory") event({ type: "memory_history", entries: [] });
    else if (m.type === "getVoice") event({ type: "voice_state", runtime: { installed: false, size_mb: 50 }, models: [
      { id: "moonshine-base-en", role: "dictation", name: "Moonshine", summary: "Fast. English only.", languages: "English", licence: "MIT", size: 111266225 },
      { id: "nemotron-3.5-asr", role: "dictation", name: "Nemotron 3.5", summary: "Most accurate. 40 languages, found by itself.", languages: "40 languages", licence: "NVIDIA Open Model (OpenMDW-1.1)", size: 475271763 },
      { id: "kitten", role: "read_aloud", name: "Kitten", summary: "Small and clear. English.", languages: "English", licence: "Apache-2.0", size: 68000000 }] });
    else if (m.type === "listRunning") post({ type: "running", items: [{ kind: "session", pid: 4242, instance: "i1", session: "s1", name: "Fix the narrow settings layout", cwd: "/home/me/evolving-fungi", windowless_s: 400, working: true, work: "running the tests" }] });
    else if (m.type === "listMcp") event({ type: "mcp_servers", items: [{ name: "local-files", enabled: true, state: "connected", command: "npx -y @modelcontextprotocol/server-filesystem", tool_count: 12 }] });
    else if (m.type === "getUsage") event({ type: "usage_report", request_id: m.requestId, range: m.range, timezone: "IST, UTC+05:30", generated_at: "2026-10-17T15:26:00Z",
      totals: { input_tokens: 17346, output_tokens: 459, cached_input_tokens: 0, requests: 3 },
      by_model: [{ model: "deepseek-v4.1-flash:cloud", provider: "ollama", host: "localhost:11434", input_tokens: 17346, output_tokens: 459, requests: 3 }],
      by_day: [{ date: "2026-10-16", input_tokens: 9000, output_tokens: 200, requests: 1 }, { date: "2026-10-17", input_tokens: 8346, output_tokens: 259, requests: 2 }] });
    else if (m.type === "inspectPlugin") post({ type: "pluginPreview", requested: m.name, item: { ...plugins.find((p) => p.name === m.name), supported: true, server_specs: {}, warnings: [] } });
  } });
}})();`;
const pageFor = (theme) => skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", "<head><style>@layer vscode-default{body{margin:0;padding:0 20px;font-family:system-ui,'Ubuntu','Droid Sans',sans-serif;font-size:13px}::-webkit-scrollbar{width:10px;height:10px}}</style>"
    + `<style>:root{${Object.entries(THEMES[theme].tokens).map(([k, v]) => `${k}:${v}`).join(";")};--vscode-font-family:system-ui,'Ubuntu','Droid Sans',sans-serif;--vscode-font-size:13px}</style>`)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`)
  .replace("<body>", `<body class="${THEMES[theme].body}">`)
  .replace('<script src="SCRIPT"></script>', () => `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);

// Each state: the page, and how to reach it.
const STATES = [
  ["general"], ["models"],
  // Models -> Advanced open: Wait for the first word (with its minutes box) and Wait between words, one-line hints.
  ["models-advanced", "models", async (p) => { await p.click('details[data-more="models-advanced"] > summary'); await p.waitForSelector("#wait_first_word_minutes:not([hidden])"); }],
  ["agents"], ["web"], ["chatdgc"], ["security"], ["memory"], ["voice"], ["running"], ["usage"],
  ["plugins"], ["plugins-directory", "plugins", async (p) => { await p.click("#browse-directory"); }],
  ["plugin-page", "plugins", async (p) => { await p.click("#browse-directory"); await p.click('.directory-open[data-open="airtable"]'); }],
  ["plugin-review", "plugins", async (p) => { await p.click("#browse-directory"); await p.click('[data-install="granola"]'); await p.waitForSelector("#confirm-plugin"); }],
  ["mcp"], ["mcp-form", "mcp", async (p) => { await p.waitForSelector('[data-mcp-edit="local-files"]'); await p.click('[data-mcp-edit="local-files"]'); }],
];
async function open(width, theme) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  await p.route("https://settings.test/**", (r) => r.fulfill({ body: pageFor(theme), contentType: "text/html" }));
  await p.goto("https://settings.test/view");
  await p.waitForSelector("#ultra_mode");
  return { p, close: () => context.close() };
}
async function go(p, page, then) {
  if (await p.isVisible(`[data-nav=${page}]`)) await p.click(`[data-nav=${page}]`);
  else await p.selectOption("#page-picker", page);
  await p.waitForTimeout(80);
  if (then) await then(p);
  await p.waitForTimeout(80);
}
// What the eye would catch: text cut off by its box, anything past the tab's right edge, and the page scrolling sideways.
const problems = (p) => p.evaluate(() => {
  const out = [];
  const vw = document.documentElement.clientWidth;
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "");
  const scroller = (el) => { for (let e = el.parentElement; e; e = e.parentElement) if (/(auto|scroll)/.test(getComputedStyle(e).overflowX) && e !== document.getElementById("main") && e !== document.scrollingElement) return true; return false; };
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || el.closest("[hidden]")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || ["OPTION", "SCRIPT", "STYLE"].includes(el.tagName)) continue;
    const text = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (text && /(hidden|clip)/.test(cs.overflowX) && cs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 2
        && !el.classList.contains("skill-description") && !el.closest(".usage-head"))
      out.push(`cut off: ${name(el)} "${el.textContent.trim().slice(0, 40)}"`);
    if (r.right > vw + 2 && r.left < vw && cs.position !== "fixed" && !scroller(el)) out.push(`past the right edge: ${name(el)} (${Math.round(r.right)} > ${vw})`);
  }
  const main = document.getElementById("main");
  if (main.scrollWidth > main.clientWidth + 1) out.push(`the page scrolls sideways by ${main.scrollWidth - main.clientWidth}px`);
  const dialog = document.querySelector("dialog[open]");
  if (dialog) { const r = dialog.getBoundingClientRect(); if (r.left < 0 || r.right > innerWidth + 1 || r.top < 0 || r.bottom > innerHeight + 1) out.push("the dialog leaves the tab"); }
  return out;
});
// Every visible row hint on one line.
const longHints = (p) => p.evaluate(() => [...document.querySelectorAll("#page .field .hint")].filter((h) => {
  if (!h.offsetParent || !h.textContent.trim()) return false;
  const range = document.createRange(); range.selectNodeContents(h);
  return new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top))).size > 1;
}).map((h) => h.textContent.trim()));
const luminance = (rgb) => { const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

for (const theme of ["dark", "light"]) {
  for (const width of [300, 460, 900]) {
    test(`every Settings page at ${width}px, ${theme}: nothing cut off, nothing sideways${width > 300 ? ", one-line hints" : ""}, in the theme's colours`, async (t) => {
      if (skipOrFail(t)) return;
      const { p, close } = await open(width, theme);
      try {
        const found = [];
        for (const [state, page = state, then] of STATES) {
          await go(p, page, then);
          for (const problem of await problems(p)) found.push(`${state}: ${problem}`);
          if (width > 300) for (const hint of await longHints(p)) found.push(`${state}: a hint takes more than one line: "${hint}"`);
          const colours = await p.evaluate(() => ({ main: getComputedStyle(document.getElementById("main")).backgroundColor,
            text: getComputedStyle(document.querySelector("#page h2, #page h1, .dialog-heading h2") || document.body).color,
            side: getComputedStyle(document.querySelector(".sidebar")).backgroundColor,
            sideShown: getComputedStyle(document.querySelector(".sidebar")).display !== "none" }));
          const ground = luminance(colours.main), ink = luminance(colours.text);
          if (theme === "light" ? ground < 0.8 || ink > 0.3 : ground > 0.1 || ink < 0.4) found.push(`${state}: not in the ${theme} theme (${colours.main} / ${colours.text})`);
          if (colours.sideShown && (theme === "light" ? luminance(colours.side) < 0.8 : luminance(colours.side) > 0.1)) found.push(`${state}: the side list is not in the ${theme} theme (${colours.side})`);
          if (state === "plugin-review") await p.click("#dialog-cancel");
        }
        assert.deepEqual(found, []);
      } finally { await close(); }
    });
  }
}
