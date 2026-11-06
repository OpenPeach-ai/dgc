// Settings → Models → DGC Router, in real Chromium with VS Code's Dark Modern and Light Modern colours: the buttons in
// a grey result box ("Test NAME (loads it)" under Test, "Close" under Suggest) look like buttons. VS Code's secondary
// button is the box's own grey in Dark Modern, so they read as plain text (QA, 2026-11-02). Each now has an edge that
// clears 3:1 against the box (WCAG 1.4.11), words that clear 4.5:1, and a button's height.
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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
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

// VS Code's own theme colours (Dark Modern and Light Modern), the variables this page reads.
const THEMES = {
  dark: { body: "vscode-dark", vars: { "--vscode-foreground": "#cccccc", "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-editor-background": "#1f1f1f", "--vscode-editor-foreground": "#cccccc", "--vscode-editorWidget-background": "#202020",
    "--vscode-input-background": "#313131", "--vscode-input-border": "#3c3c3c", "--vscode-panel-border": "#2b2b2b",
    "--vscode-button-secondaryBackground": "#313131", "--vscode-button-secondaryForeground": "#cccccc",
    "--vscode-button-secondaryHoverBackground": "#3c3c3c", "--vscode-sideBar-background": "#181818" } },
  light: { body: "vscode-light", vars: { "--vscode-foreground": "#3b3b3b", "--vscode-descriptionForeground": "#3b3b3b",
    "--vscode-editor-background": "#ffffff", "--vscode-editor-foreground": "#3b3b3b", "--vscode-editorWidget-background": "#f8f8f8",
    "--vscode-input-background": "#ffffff", "--vscode-input-border": "#cecece", "--vscode-panel-border": "#e5e5e5",
    "--vscode-button-secondaryBackground": "#e5e5e5", "--vscode-button-secondaryForeground": "#3b3b3b",
    "--vscode-button-secondaryHoverBackground": "#cccccc", "--vscode-sideBar-background": "#f8f8f8" } },
};
const STATUS = { enabled: true, when_busy: "wait", workers: { total: 4, free: 4, busy: 0 }, systems: [
  { id: "gpu", name: "GPU box", base_url: "http://gpu-box.local:11434", server: "ollama", enabled: true, jobs: ["subagents", "pips"],
    workers: 4, busy: 0, free: 4, one_model_at_a_time: false, health: { state: "online" }, has_key: false, memory_gb: 128, leases: [],
    models: [{ name: "qwen3.8:32b", workers: 2, busy: 0, free: 2, context: 65536, params_b: 32, tools: true },
             { name: "qwen3:8b", workers: 2, busy: 0, free: 2, context: 32768, params_b: 8.2, tools: true }],
    available: [{ name: "qwen3.8:32b" }, { name: "qwen3:8b" }] }] };

const hostFor = (status = STATUS, config = {}) => `(${function (status, config) {
  const post = (m) => setTimeout(() => window.postMessage(m, "*"), 1);
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m.type === "ready") {
      post({ type: "event", event: { type: "config", base_url: "http://gpu-box.local:11434/v1", model: "qwen3:8b", mode: "auto",
        router_capable: true, router_pips_default: true, pips_settable: true, subagent_model: "", max_parallel_tasks: 4, ...config } });
      post({ type: "show", section: "models" });
    }
    if (m.type !== "routerCommand") return;
    const command = m.command || {};
    const extra = command.type === "router_probe" ? { probe: { system: "gpu", results: {
      "qwen3.8:32b": { not_loaded: true, error: "not loaded on GPU box now: testing it would load it there (about 19 GB)" },
      "qwen3:8b": { speed: { ok: true, tokens_per_s: 80, ttft_ms: 90 } } } } }
      : command.type === "router_suggest" ? { suggestion: { applicable: false, line: "DGC can't back a number yet: Test it first." } } : {};
    post({ type: "routerReply", token: m.token, ok: true, status, ...extra });
  } });
}})(${JSON.stringify(status)}, ${JSON.stringify(config)});`;
const pageFor = (theme, status, config) => skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", `<head><style>:root{--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;${Object.entries(THEMES[theme].vars)
    .map(([k, v]) => `${k}:${v}`).join(";")}}</style>`)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`)
  .replace("<body>", `<body class="${THEMES[theme].body}">`)
  .replace('<script src="SCRIPT"></script>', () => `<script>${hostFor(status, config)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);

// The button's edge (its border, else its fill) against the box behind it, and its words against its fill.
const looks = (p, selector) => p.$eval(selector, (button) => {
  // rgb()/rgba(), or color(srgb r g b / a) on a 0-1 scale (what a color-mix() computes to).
  const rgb = (text) => {
    const m = (text.match(/[\d.]+/g) || []).map(Number);
    const unit = /^color\(srgb/.test(text) ? 255 : 1, values = m;
    return { c: values.slice(0, 3).map((v) => v * unit), a: values.length > 3 ? values[3] : 1 };
  };
  const lum = (c) => c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const over = (top, under) => top.c.map((v, i) => v * top.a + under[i] * (1 - top.a));
  const box = rgb(getComputedStyle(button.closest(".router-result")).backgroundColor).c;
  const s = getComputedStyle(button);
  const fill = over(rgb(s.backgroundColor), box);
  const width = parseFloat(s.borderTopWidth) || 0;
  const edge = width > 0 ? over(rgb(s.borderTopColor), box) : fill;
  return { edge: ratio(edge, box), words: ratio(rgb(s.color).c, fill), height: button.getBoundingClientRect().height, text: button.textContent };
});

for (const theme of ["dark", "light"]) {
  test(`${theme}: the buttons in Test's and Suggest's grey boxes look like buttons`, async (t) => {
    if (skipOrFail(t)) return;
    const context = await browser.newContext({ viewport: { width: 900, height: 1300 }, reducedMotion: "reduce", colorScheme: theme });
    const p = await context.newPage();
    try {
      await p.route("https://settings.test/**", (r) => r.fulfill({ body: pageFor(theme), contentType: "text/html" }));
      await p.goto("https://settings.test/view");
      await p.waitForSelector("[data-router-test=gpu]");
      await p.click("[data-router-test=gpu]");
      await p.waitForSelector("[data-router-test-model]");
      await p.click("[data-router-suggest=gpu]");
      await p.waitForSelector("[data-router-suggest-close]");
      await p.$eval("[data-router-system=gpu]", (el) => el.scrollIntoView({ block: "center" }));
      if (process.env.DGC_SHOTS) await p.screenshot({ path: `${process.env.DGC_SHOTS}/router-result-buttons-${theme}.png` });
      for (const selector of ["[data-router-test-model]", "[data-router-suggest-close]"]) {
        const b = await looks(p, selector);
        assert.ok(b.edge >= 3, `"${b.text}": its edge is ${b.edge.toFixed(2)}:1 against the grey box, so it reads as plain text`);
        assert.ok(b.words >= 4.5, `"${b.text}": its words read at ${b.words.toFixed(2)}:1`);
        assert.ok(b.height >= 26, `"${b.text}" is ${b.height}px tall`);
      }
    } finally { await context.close(); }
  });
}

// A saved system's card with DGC Router's Thinking column (a CLI with router.thinking): six columns, each heading and each
// model's facts on one line. Five columns put "Note" on a line of its own under "Model" (release check, 2026-11-03).
// Under 760px the facts stack under the model's name, as before.
const THINKING = { ...STATUS, systems: [{ ...STATUS.systems[0], models: [
  { ...STATUS.systems[0].models[0], thinks: true, thinking: "low", note: "design, debugging" },
  { ...STATUS.systems[0].models[1], thinks: true } ] }] };
for (const width of [900, 700]) {
  test(`a saved system's card with Thinking keeps each row on one line at ${width}px, or stacks under 760px`, async (t) => {
    if (skipOrFail(t)) return;
    const context = await browser.newContext({ viewport: { width, height: 1300 }, reducedMotion: "reduce", colorScheme: "dark" });
    const p = await context.newPage();
    try {
      await p.route("https://settings.test/**", (r) => r.fulfill({ body: pageFor("dark", THINKING, { router_thinking: true }), contentType: "text/html" }));
      await p.goto("https://settings.test/view");
      await p.waitForSelector("[data-router-system=gpu] .router-model.head", { state: "attached" });
      await p.$eval("[data-router-system=gpu]", (el) => el.scrollIntoView({ block: "start" }));
      if (process.env.DGC_SHOTS) await p.locator("[data-router-system=gpu]").screenshot({ path: `${process.env.DGC_SHOTS}/router-card-thinking-${width}.png` });
      // One grid row: every cell shares a band (they are centred, so a two-line note doesn't move the row).
      const rows = await p.$$eval("[data-router-system=gpu] .router-models > .router-model", (list) => list.map((row) => {
        const boxes = [...row.children].map((c) => c.getBoundingClientRect()).filter((b) => b.height > 0);
        return { text: [...row.children].filter((c) => c.getBoundingClientRect().height > 0).map((c) => c.textContent),
          oneRow: boxes.length > 0 && Math.max(...boxes.map((b) => b.top)) < Math.min(...boxes.map((b) => b.bottom)),
          shown: row.getBoundingClientRect().height > 0 };
      }));
      const [head, first] = rows;
      if (width > 760) {
        assert.deepEqual(head.text, ["Model", "Use", "Workers", "Context each", "Thinking", "Note"]);
        assert.ok(head.oneRow, "every heading on one row: Note beside Thinking, not under Model");
        assert.ok(first.oneRow, `a model's facts on one row: ${first.text.join(" | ")}`);
        assert.deepEqual(first.text.slice(-2), ["Low", "design, debugging"]);
      } else {
        assert.equal(head.shown, false, "the headings go");
        assert.ok(!first.oneRow, "the facts stack under the model's name");
      }
      const overflow = await p.$eval("[data-router-system=gpu]", (card) => card.scrollWidth - card.clientWidth);
      assert.ok(overflow <= 1, `nothing pokes out of the card (${overflow}px)`);
    } finally { await context.close(); }
  });
}
