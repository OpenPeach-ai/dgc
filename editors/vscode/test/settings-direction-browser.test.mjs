// The direction for Settings (24 Oct 2026), laid out in real Chromium: Models and Agents wear the chat panel's
// tokens, so they follow the VS Code theme (the rest of Settings was always dark, light theme or not); their
// controls line up; nothing scrolls sideways at a 460 px or a 900 px tab; a narrow tab puts each control under its
// words; Save stays in reach. jsdom has no layout or cascade, so editor-settings.test.mjs can't see any of this.
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

// What VS Code injects for its stock themes (the ones these pages read), and its webview defaults.
const THEMES = {
  dark: { body: "vscode-dark", tokens: { "--vscode-editor-background": "#1f1f1f", "--vscode-foreground": "#cccccc",
    "--vscode-descriptionForeground": "#9d9d9d", "--vscode-input-background": "#313131", "--vscode-input-border": "#3c3c3c",
    "--vscode-panel-border": "#2b2b2b", "--vscode-editorWidget-background": "#202020", "--vscode-focusBorder": "#0078d4" } },
  light: { body: "vscode-light", tokens: { "--vscode-editor-background": "#ffffff", "--vscode-foreground": "#3b3b3b",
    "--vscode-descriptionForeground": "#3b3b3b", "--vscode-input-background": "#ffffff", "--vscode-input-border": "#cecece",
    "--vscode-panel-border": "#e5e5e5", "--vscode-editorWidget-background": "#f8f8f8", "--vscode-focusBorder": "#005fb8" } },
};
const host = `(${function () {
  const config = { type: "config", mode: "auto", think: "off", base_url: "http://127.0.0.1:11434/v1", model: "deepseek-v4.1-flash:cloud",
    api_mode: "auto", max_parallel_tasks: 4, context_size: 65536, subagent_context_size: 0, list_models_at: true,
    pips_settable: true, pips_model: "", cache_settable: true, prompt_cache_ttl: "5m", ollama_keep_alive: "30m" };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m.type === "ready") setTimeout(() => window.postMessage({ type: "event", event: config }, "*"), 1);
    if (m.type === "listModelsAt") setTimeout(() => window.postMessage({ type: "modelsAt", token: m.token, role: m.role, ids: ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud"] }, "*"), 1);
  } });
}})();`;
const pageFor = (theme) => skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", "<head><style>@layer vscode-default{body{margin:0;padding:0 20px;font-family:system-ui;font-size:13px}}</style>"
    + `<style>:root{${Object.entries(THEMES[theme].tokens).map(([k, v]) => `${k}:${v}`).join(";")}}</style>`)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`)
  .replace("<body>", `<body class="${THEMES[theme].body}">`)
  .replace('<script src="SCRIPT"></script>', () => `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);

async function open(width, section, theme = "dark") {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  await p.route("https://settings.test/**", (r) => r.fulfill({ body: pageFor(theme), contentType: "text/html" }));
  await p.goto("https://settings.test/view");
  await p.waitForSelector("#ultra_mode");
  await p.click(`[data-nav=${section}]`);
  await p.waitForSelector(".page.v2");
  return { p, close: () => context.close() };
}

test("Models and Agents follow the VS Code theme, light included", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark", "light"]) {
    for (const section of ["models", "agents"]) {
      const { p, close } = await open(900, section, theme);
      try {
        const seen = await p.evaluate(() => {
          const color = (el, prop) => getComputedStyle(el)[prop];
          return { main: color(document.getElementById("main"), "backgroundColor"), title: color(document.querySelector(".v2>h2"), "color"),
            rows: color(document.querySelector(".v2 .rows"), "backgroundColor"), input: color(document.querySelector(".v2 input"), "backgroundColor") };
        });
        const expect = theme === "dark"
          ? { main: "rgb(31, 31, 31)", rows: "rgb(32, 32, 32)", input: "rgb(49, 49, 49)" }
          : { main: "rgb(255, 255, 255)", rows: "rgb(248, 248, 248)", input: "rgb(255, 255, 255)" };
        assert.deepEqual({ main: seen.main, rows: seen.rows, input: seen.input }, expect, `${section}, ${theme}`);
      } finally { await close(); }
    }
  }
});

test("at 900 px the controls line up; at 460 px each sits under its words; nothing scrolls sideways", async (t) => {
  if (skipOrFail(t)) return;
  for (const section of ["models", "agents"]) {
    let { p, close } = await open(900, section);
    try {
      await p.evaluate(() => document.querySelectorAll(".v2 details.more").forEach((d) => { d.open = true; }));
      const edges = await p.evaluate(() => [...document.querySelectorAll(".v2 .field")].filter((f) => f.offsetParent)
        .map((f) => f.lastElementChild).filter((c) => !c.classList.contains("switch")).map((c) => Math.round(c.getBoundingClientRect().left)));
      assert.ok(edges.length >= 5, section);
      assert.equal(new Set(edges).size, 1, `${section}: every control starts at the same x (${[...new Set(edges)]})`);
      const sideways = await p.$eval("#main", (m) => m.scrollWidth - m.clientWidth);
      assert.ok(sideways <= 0, `${section} at 900 scrolls sideways by ${sideways}px`);
    } finally { await close(); }
    ({ p, close } = await open(460, section));
    try {
      const under = await p.evaluate(() => [...document.querySelectorAll(".v2 .field")].filter((f) => f.offsetParent && !f.querySelector(".switch"))
        .every((f) => f.lastElementChild.getBoundingClientRect().top >= f.firstElementChild.getBoundingClientRect().bottom - 1));
      assert.ok(under, `${section} at 460: each control under its words`);
      const sideways = await p.$eval("#main", (m) => m.scrollWidth - m.clientWidth);
      assert.ok(sideways <= 0, `${section} at 460 scrolls sideways by ${sideways}px`);
    } finally { await close(); }
  }
});

test("Save stays in reach at the foot of the tab while the page scrolls", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(460, "agents");
  try {
    await p.setViewportSize({ width: 460, height: 520 });
    const bar = await p.evaluate(() => {
      const main = document.getElementById("main"), save = document.getElementById("save");
      main.scrollTop = 0;
      const box = save.getBoundingClientRect();
      return { position: getComputedStyle(save.parentElement).position, inView: box.bottom <= innerHeight && box.top >= 0,
        scrolls: main.scrollHeight > main.clientHeight };
    });
    assert.equal(bar.position, "sticky");
    assert.ok(bar.scrolls, "the page is longer than the tab");
    assert.ok(bar.inView, "Save is on screen at the top of a long page");
  } finally { await close(); }
});
