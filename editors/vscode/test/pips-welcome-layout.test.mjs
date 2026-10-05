// The Pips view with no Pips yet is a welcome, and layout is a fact only a real browser can check:
// its intro and first-job card sit in the middle at every panel width, and the narrow rail beside
// the setup page never tries to show that card (its sentence stacked one letter per line).
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
const W = "ws_" + "1".repeat(32);
const host = `(${function (W) {
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: ["rook", "scout", "lens", "lock"].includes(id), unavailable_reason: ["rook", "scout", "lens", "lock"].includes(id) ? null : "Planned",
    default_name: id, default_goal: "Review", engine: ["rook", "scout", "lens", "lock"].includes(id) ? "source_audit" : null }));
  const answers = { list_workspaces: () => ({ workspaces: [{ id: W, name: "demo_project" }], current_workspace_id: W }), list_pip_types: () => ({ types }),
    list_pip_setups: () => ({ setups: [] }), list_pips: () => ({ pips: [] }), list_pip_starters: () => ({ starters: [] }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "stopped", online: false, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: W, revision: 0, entries: [] } }) };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    const make = m?.type === "pipsRequest" && answers[m.request.type];
    if (make) setTimeout(() => window.postMessage({ type: "pipsReply", id: m.id, ok: true, result: make() }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 41, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(W)});`;
const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
  + `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

async function open(width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: page, contentType: "text/html" }));   // a secure context, like the webview
  await p.goto("https://pips.test/view");
  await p.waitForSelector(".pips-first-job");
  return { p, close: () => context.close() };
}
const gaps = (p, selector) => p.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left, innerWidth - b.right]; }, selector);

test("with no Pips, the welcome and its card are centred at every width", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [480, 900, 1500]) {
    const { p, close } = await open(width);
    for (const selector of [".pips-overview-intro h2", ".pips-first-job"]) {
      const [left, right] = await gaps(p, selector);
      assert.ok(Math.abs(left - right) <= 2, `${selector} at ${width}px: ${Math.round(left)} left, ${Math.round(right)} right`);
    }
    await close();
  }
});

test("the rail beside the setup page never shows the welcome card", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(900);
  await p.click("#create-first");
  await p.waitForSelector(".layout.selected");
  const shown = await p.evaluate(() => [...document.querySelectorAll(".layout.selected>aside .pips-first-job")]
    .some((e) => getComputedStyle(e).display !== "none"));
  assert.equal(shown, false);
  const rail = await p.evaluate(() => document.querySelector(".layout.selected>aside").getBoundingClientRect().width);
  assert.ok(rail <= 60, `the rail stays narrow (${rail}px)`);
  await close();
});
