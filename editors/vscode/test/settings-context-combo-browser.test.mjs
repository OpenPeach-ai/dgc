// A context size, typed or picked (src/contextCombo.js), the one box for DGC Router's "Context each" and Sub-agents'
// "Context window" (0.51: "users can manually enter any number here too"). A text box with 4K … 256K listed under it,
// up to the model's own maximum: type 24K, 24k, 24576 or 24,576, and it says what will be saved ("24K = 24,576
// tokens"); below 2K or past the model's maximum, a one-line note (above it still saves, as the model's maximum); what
// the choice costs on that computer beside it. Arrow keys open and move, Enter picks, Esc closes. Real Chromium, both
// themes, 300, 460 and 900 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { contextCost } from "../src/settingsRouter.js";
import { bindContextCombos, contextComboHTML, contextNote, contextSaid, parseContext } from "../src/contextCombo.js";

let chromium, browser;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
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

// Every top-level await comes before the first test(): a test declared before one runs while the module
// waits, and the runner can then end the file and close the browser before the later tests exist.
const src = new URL("../src/", import.meta.url).pathname;
const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out",
  platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const viewModule = { exports: {} };
new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const skeleton = viewModule.exports.settingsDocument("SCRIPT", "STYLE", "");
const GB = 1024 ** 3;
test("a size reads the same however it's typed, and says what will be saved", () => {
  for (const [text, tokens] of [["24K", 24576], ["24k", 24576], ["24576", 24576], ["24,576", 24576], [" 16K ", 16384], ["1.5k", 1536]]) {
    assert.equal(parseContext(text), tokens, text);
  }
  assert.equal(parseContext(""), "");
  for (const bad of ["lots", "16M", "16.5", "-4K"]) assert.equal(parseContext(bad), null, bad);
  assert.equal(contextSaid(24576), "24K = 24,576 tokens");
  assert.equal(contextSaid(30000), "30,000 tokens");
  assert.equal(contextSaid("", "Same as the main chat"), "Same as the main chat");
  assert.equal(contextNote(1024), "Below 2K: DGC needs at least 2K (2,048 tokens) for its own instructions.");
  assert.equal(contextNote(262144, 131072), "This model handles up to 128K; DGC will use 128K.");
  assert.equal(contextNote(65536, 131072), "", "and back under it, no note: the check works both ways");
  assert.equal(contextNote(null), "Type a size like 24K or 24576.");
});

test("what a choice costs, as Suggest counts it", () => {
  const system = { memory: { total_bytes: 64 * GB, kept_free_bytes: 6.4 * GB } };
  const model = { weights_bytes: 4.9 * GB, kv_bytes_per_token: 147456 };
  assert.equal(contextCost(system, model, 32768, 2), "≈ 4.5 GB each · 2 workers ≈ 9 GB of 53 GB free");
  assert.equal(contextCost({}, model, 32768, 1), "≈ 4.5 GB each · 1 worker ≈ 4.5 GB", "no memory known: no free part");
  assert.match(contextCost(system, model, 262144, 2), /^Won't fit: 2 workers need ≈ 72 GB and 53 GB is free \(saving still works\)\.$/);
  assert.equal(contextCost(system, { weights_bytes: 1 }, 32768, 2), "", "context memory unknown: nothing to say");
});

const THEMES = {
  dark: { body: "vscode-dark", vars: { "--vscode-foreground": "#cccccc", "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-editor-background": "#1f1f1f", "--vscode-input-background": "#313131", "--vscode-input-border": "#3c3c3c",
    "--vscode-panel-border": "#2b2b2b", "--vscode-sideBar-background": "#181818", "--vscode-focusBorder": "#0078d4" } },
  light: { body: "vscode-light", vars: { "--vscode-foreground": "#3b3b3b", "--vscode-descriptionForeground": "#3b3b3b",
    "--vscode-editor-background": "#ffffff", "--vscode-input-background": "#ffffff", "--vscode-input-border": "#cecece",
    "--vscode-panel-border": "#e5e5e5", "--vscode-sideBar-background": "#f8f8f8", "--vscode-focusBorder": "#005fb8" } },
};
const STATUS = { enabled: true, when_busy: "wait", workers: { total: 2, free: 2, busy: 0 }, systems: [
  { id: "nas", name: "NAS", base_url: "http://nas.local:11434", server: "ollama", enabled: true, jobs: ["subagents"],
    workers: 2, busy: 0, free: 2, one_model_at_a_time: false, health: { state: "online" }, has_key: false, leases: [],
    memory: { total_bytes: 64 * GB, kept_free_bytes: 6.4 * GB, source: "the memory set for it" },
    models: [{ name: "qwen3:8b", workers: 2, busy: 0, free: 2, context: 32768, params_b: 8.2, tools: true, context_max: 131072,
               weights_bytes: 4.9 * GB, kv_bytes_per_token: 147456 }],
    available: [{ name: "qwen3:8b", context_max: 131072, weights_bytes: 4.9 * GB, kv_bytes_per_token: 147456 }] }] };
const hostFor = () => `(${function (status) {
  window.__sent = [];
  const post = (m) => setTimeout(() => window.postMessage(m, "*"), 1);
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    window.__sent.push(m);
    if (m.type === "ready") {
      post({ type: "event", event: { type: "config", base_url: "http://nas.local:11434/v1", model: "qwen3:8b", mode: "auto",
        router_capable: false, subagent_model: "", subagent_context_size: 0, max_parallel_tasks: 4 } });
      post({ type: "show", section: "models" });
    }
    if (m.type === "routerCommand") post({ type: "routerReply", token: m.token, ok: true, status });
  } });
}})(${JSON.stringify(STATUS)});`;
const pageFor = (theme, router) => skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", `<head><style>:root{--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;${Object.entries(THEMES[theme].vars)
    .map(([k, v]) => `${k}:${v}`).join(";")}}</style>`)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`)
  .replace("<body>", `<body class="${THEMES[theme].body}">`)
  .replace('<script src="SCRIPT"></script>', () => `<script>${hostFor().replace("router_capable: false", `router_capable: ${router}`)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);
async function open(theme, width, router) {
  const context = await browser.newContext({ viewport: { width, height: 1300 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.route("https://settings.test/**", (r) => r.fulfill({ body: pageFor(theme, router), contentType: "text/html" }));
  await p.goto("https://settings.test/view");
  return { context, p, errors };
}
const box = (p, sel) => p.$eval(sel, (input) => {
  const combo = input.closest("[data-ctx-combo]"), r = combo.getBoundingClientRect();
  const cell = combo.parentElement.getBoundingClientRect();
  return { value: input.value, said: combo.querySelector(".ctx-combo-said").textContent,
    note: combo.querySelector(".ctx-combo-note").hidden ? "" : combo.querySelector(".ctx-combo-note").textContent,
    cost: combo.querySelector(".ctx-combo-cost").hidden ? "" : combo.querySelector(".ctx-combo-cost").textContent,
    open: !combo.querySelector(".ctx-combo-list").hidden, expanded: input.getAttribute("aria-expanded"),
    options: [...combo.querySelectorAll('[role="option"]')].map((o) => o.textContent),
    active: combo.querySelector('[role="option"].active')?.textContent || "", inside: r.right <= Math.max(cell.right, document.documentElement.clientWidth) + 1,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      || [...document.querySelectorAll(".router-models")].some((t) => t.scrollWidth > t.clientWidth + 1) };
});

for (const theme of ["dark", "light"]) {
  for (const width of [300, 460, 900]) {
    test(`${theme} at ${width}px: DGC Router's Context each, typed or picked, with what it costs`, async (t) => {
      if (skipOrFail(t)) return;
      const { context, p, errors } = await open(theme, width, true);
      try {
        await p.waitForSelector("[data-router-edit=nas]");
        await p.click("[data-router-edit=nas]");
        const sel = "#router-ctx-nas-0";
        await p.waitForSelector(sel);
        let seen = await box(p, sel);
        assert.equal(seen.value, "32K");
        assert.deepEqual(seen.options, ["4K", "8K", "16K", "32K", "64K", "128K"], "up to the model's own 128K");
        assert.equal(seen.said, "32K = 32,768 tokens");
        assert.equal(seen.cost, "≈ 4.5 GB each · 2 workers ≈ 9 GB of 53 GB free");
        assert.equal(seen.overflow, false, "no sideways scroll");
        // The keyboard: Down opens on the size it has, Down moves, Enter picks, Esc closes.
        await p.focus(sel);
        await p.keyboard.press("ArrowDown");
        seen = await box(p, sel);
        assert.deepEqual([seen.open, seen.expanded, seen.active], [true, "true", "32K"]);
        await p.keyboard.press("ArrowDown");
        await p.keyboard.press("Enter");
        seen = await box(p, sel);
        assert.deepEqual([seen.value, seen.open, seen.said], ["64K", false, "64K = 65,536 tokens"]);
        assert.equal(seen.cost, "≈ 9 GB each · 2 workers ≈ 18 GB of 53 GB free");
        await p.keyboard.press("ArrowUp");
        assert.equal((await box(p, sel)).open, true);
        await p.keyboard.press("Escape");
        assert.equal((await box(p, sel)).open, false, "Esc closes the list");
        if (process.env.DGC_SHOTS) { await p.$eval(sel, (el) => el.scrollIntoView({ block: "center" })); await p.screenshot({ path: `${process.env.DGC_SHOTS}/router-context-${theme}-${width}.png` }); }
        // Typing: any size, said back, nearest entry highlighted.
        await p.fill(sel, "24,576");
        seen = await box(p, sel);
        assert.deepEqual([seen.said, seen.note, seen.active], ["24K = 24,576 tokens", "", "32K"]);
        await p.press(sel, "Enter");
        assert.equal(await p.inputValue(sel), "24,576", "Enter accepts the custom size");
        await p.fill(sel, "1k");
        assert.equal((await box(p, sel)).note, "Below 2K: DGC needs at least 2K (2,048 tokens) for its own instructions.");
        await p.fill(sel, "200K");
        seen = await box(p, sel);
        assert.equal(seen.note, "This model handles up to 128K; DGC will use 128K.");
        assert.equal(seen.cost, "≈ 18 GB each · 2 workers ≈ 36 GB of 53 GB free", "what DGC will use: 128K");
        await p.fill('#router-ctx-nas-0 >> xpath=ancestor::*[@data-model-row][1] >> [data-edit="workers"]', "4");
        assert.equal((await box(p, sel)).cost, "Won't fit: 4 workers need ≈ 72 GB and 53 GB is free (saving still works).",
          "in one line, and the workers count in it");
        if (process.env.DGC_SHOTS) await p.screenshot({ path: `${process.env.DGC_SHOTS}/router-context-over-${theme}-${width}.png` });
        await p.fill('#router-ctx-nas-0 >> xpath=ancestor::*[@data-model-row][1] >> [data-edit="workers"]', "2");
        await p.fill(sel, "24k");
        await p.click("[data-router-edit-save=nas]");
        await p.waitForTimeout(200);
        const sent = await p.evaluate(() => window.__sent.filter((m) => m.type === "routerCommand").map((m) => m.command));
        const set = sent.find((c) => c.action === "set_model");
        assert.equal(set?.context, 24576, "saved as the tokens it means");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    test(`${theme} at ${width}px: Sub-agents' Context window, the same box, Same as the main chat first`, async (t) => {
      if (skipOrFail(t)) return;
      const { context, p, errors } = await open(theme, width, false);
      try {
        const sel = "#subagent_context_size";
        await p.waitForSelector(sel);
        let seen = await box(p, sel);
        assert.equal(seen.value, "");
        assert.equal(seen.options[0], "Same as the main chat");
        assert.deepEqual(seen.options.slice(1), ["4K", "8K", "16K", "32K", "64K", "128K", "256K"]);
        assert.equal(seen.said, "Same as the main chat");
        assert.equal(seen.overflow, false);
        await p.focus(sel);
        await p.keyboard.press("ArrowDown");
        assert.equal((await box(p, sel)).active, "Same as the main chat");
        for (let i = 0; i < 4; i++) await p.keyboard.press("ArrowDown");
        await p.keyboard.press("Enter");
        seen = await box(p, sel);
        assert.deepEqual([seen.value, seen.said], ["32K", "32K = 32,768 tokens"]);
        await p.fill(sel, "48k");
        assert.equal((await box(p, sel)).said, "48K = 49,152 tokens");
        if (process.env.DGC_SHOTS) { await p.$eval(sel, (el) => el.scrollIntoView({ block: "center" })); await p.screenshot({ path: `${process.env.DGC_SHOTS}/subagents-context-${theme}-${width}.png` }); }
        await p.click("#save");
        await p.waitForTimeout(150);
        const saved = await p.evaluate(() => window.__sent.filter((m) => m.type === "saveSettings").map((m) => m.values));
        assert.equal(saved.at(-1)?.subagent_context_size, "49152", "saved as the tokens it means");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }
}


test("Enter accepts typed context sizes until a preset is deliberately selected", async () => {
  const { JSDOM } = await import("jsdom");
  const w = new JSDOM("<body>" + contextComboHTML({ id: "context" }) + "</body>").window;
  const oldEvent = globalThis.Event;
  globalThis.Event = w.Event;
  try {
    bindContextCombos(w.document);
    const input = w.document.querySelector("input");
    const key = (key) => input.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true }));
    const type = (text) => { input.value = text; input.dispatchEvent(new w.Event("input", { bubbles: true })); };
    for (const text of ["24K", "24k", "24576", "24,576"]) {
      type(text); key("Enter");
      assert.equal(input.value, text);
      assert.equal(parseContext(input.value), 24576);
      assert.equal(input.getAttribute("aria-expanded"), "false");
    }
    type("24K"); key("ArrowDown"); key("Enter");
    assert.equal(input.value, "64K", "explicit navigation still chooses a preset");
    type("24K"); key("ArrowDown"); type("30K"); key("Enter");
    assert.equal(input.value, "30K", "typing clears the previous preset selection");
  } finally { globalThis.Event = oldEvent; w.close(); }
});
