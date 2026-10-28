// The Pips header with the runner stopped, in real Chromium. A user's screenshot (2026-10-06):
// the runner's error sat inside the header's one row, so "Pips" broke onto two lines ("Pi / ps"),
// "Start runner" wrapped and ran into "Controls". The error now takes its own row under the bar, and
// the title and the runner's buttons keep their words on one line at every panel width.
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

const bundled = await build({ entryPoints: [new URL("../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false,
  format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const MESSAGE = "The local Pips controller stopped (RegistryError). Check the runner's state storage, then restart dgc pips serve.";
const host = (message) => `(${function (message) {
  const P = "ws_" + "1".repeat(32), Q = "ws_" + "2".repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = (id, name, type) => ({ id, name, pip_type: type, workspace_id: P, status: "active", version: 1, lifecycle_revision: 1,
    goal: "Help", schedule: null, model_choice: { mode: "default" }, created_at: "2026-10-06T09:00:00Z", updated_at: "2026-10-06T09:00:00Z" });
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: P, name: "Your Pips", kind: "personal" }, { id: Q, name: "demo_project", kind: "project" }], current_workspace_id: P }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip("pip_" + "a".repeat(32), "Core", "core"), pip("pip_" + "b".repeat(32), "India Market Brief", "quill"), pip("pip_" + "c".repeat(32), "Gmail", "scout")] }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "stopped", online: false, paused: false, counts: { queued: 0, running: 0, cancelling: 0 },
      ...(message ? { error: { code: "runner_failed", message } } : {}) } }),
    get_workspace_context: () => ({ context: { workspace_id: P, revision: 0, entries: [] } }),
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    const make = m?.type === "pipsRequest" && answers[m.request.type];
    if (make) setTimeout(() => window.postMessage({ type: "pipsReply", id: m.id, ok: true, result: make() }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 43, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(message)});`;
const page = (message) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
  + `<script>${host(message)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

async function open(width, message = MESSAGE) {
  const context = await browser.newContext({ viewport: { width, height: 700 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: page(message), contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector(".simple-bar .runner-status");
  if (message) await p.waitForSelector(".simple-bar .notice.error");
  return { p, close: () => context.close() };
}

// Lines a box's text takes, and whether two boxes overlap.
const measure = (p) => p.evaluate(() => {
  const bar = document.querySelector(".simple-bar"), rect = (n) => n?.getBoundingClientRect();
  // Lines of text, read from the text's own boxes: a button's min-height is not a second line.
  const lines = (n) => { if (!n) return 0; const range = document.createRange(); range.selectNodeContents(n);
    return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size; };
  const title = bar.querySelector("h1"), start = bar.querySelector("#start-runner"), controls = bar.querySelector("#runner-controls-toggle"),
    tabs = document.querySelector(".pips-tabs"), notice = bar.querySelector(".notice.error");
  const overlap = (a, b) => { const x = rect(a), y = rect(b); return !!(x && y) && x.left < y.right - 0.5 && y.left < x.right - 0.5 && x.top < y.bottom - 0.5 && y.top < x.bottom - 0.5; };
  const controlsBottom = Math.max(...[title, start, controls].filter(Boolean).map((n) => rect(n).bottom));
  return {
    titleLines: lines(title.querySelector(".pips-wordmark") || title), startLines: lines(start), controlsLines: lines(controls),
    // Personal | Project are their own row under the bar (and under its error), never in it.
    overlaps: [[start, controls], [tabs, start], [title, tabs], [tabs, controls], [tabs, notice], [tabs, bar]].filter(([a, b]) => overlap(a, b)).length,
    tabsBelow: !!tabs && rect(tabs).top >= rect(bar).bottom - 0.5,
    noticeBelow: notice ? rect(notice).top >= controlsBottom - 0.5 : null,
    noticeWidth: notice ? Math.round(rect(notice).width / rect(bar).width * 100) : null,
    sideways: document.documentElement.scrollWidth > innerWidth + 1,
  };
});

for (const width of [753, 480, 320]) {
  test(`at ${width}px the runner's error sits under the Pips bar, and nothing in the bar wraps or overlaps`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close } = await open(width);
    try {
      const m = await measure(p);
      assert.equal(m.titleLines, 1, `"Pips" stays one word (${JSON.stringify(m)})`);
      assert.equal(m.startLines, 1, `"Start runner" stays on one line (${JSON.stringify(m)})`);
      assert.equal(m.controlsLines, 1);
      assert.equal(m.overlaps, 0, `no control covers another (${JSON.stringify(m)})`);
      assert.equal(m.tabsBelow, true, `the tabs are under the bar (${JSON.stringify(m)})`);
      assert.equal(m.noticeBelow, true, `the error is its own row under the bar (${JSON.stringify(m)})`);
      assert.ok(m.noticeWidth >= 85, `and runs the bar's width (${m.noticeWidth}%)`);
      assert.equal(m.sideways, false);
      assert.equal(await p.textContent(".simple-bar .notice.error"), MESSAGE);
    } finally { await close(); }
  });
}

test("with no error the bar is one row", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(753, "");
  try {
    const m = await measure(p);
    assert.equal(m.noticeBelow, null);
    const height = await p.evaluate(() => document.querySelector(".simple-bar").getBoundingClientRect().height);
    assert.ok(height < 60, `one row (${height}px)`);
  } finally { await close(); }
});
