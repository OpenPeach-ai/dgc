// Trace on a Pip's own page, in real Chromium with the real client: that page has none of main.css or Work's codicons in
// the side bar's document, so the dialog has to stand up by itself, wide and in a side bar's width.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
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

const bundled = await build({ entryPoints: [new URL("../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false,
  format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const fontCss = readFileSync(new URL("../media/codicon.css", import.meta.url), "utf8").replace(/url\([^)]*codicon\.ttf[^)]*\)/,
  `url("data:font/ttf;base64,${readFileSync(new URL("../media/codicon.ttf", import.meta.url)).toString("base64")}")`);
const PIP = "pip_" + "g".repeat(32);

const host = `(${function (PIP) {
  const W = "ws_" + "p".repeat(32), run = "run_" + "5".repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = { id: PIP, workspace_id: W, pip_type: "lens", name: "Planner", goal: "Help.", source_policy: { mode: "personal" }, source_ref: "HEAD",
    status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null, proposals: [], pending_review_count: 0 };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576,
    effective_context_size: 8192, context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const reply = { id: "a1", pip_id: PIP, workspace_id: W, role: "assistant", text: "Lake Baikal.", run_id: run, status: "succeeded", model: "deepseek", created_at: "2026-11-06T08:00:00Z" };
  const steps = { v: 1, ms: 8000, steps: [
    { kind: "model", label: "model.response", start: 0, end: 2000, tokens: 10634 },
    { kind: "tool", label: "web_search", detail: "deepest lake", hits: 6, start: 2000, end: 6000 },
    { kind: "tool", label: "read_app", start: 6000, end: 6400, error: true },
    { kind: "model", label: "model.response", start: 6400, end: 8000, tokens: 11275 }] };
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: W, name: "Personal", kind: "personal" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip], total: 1, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: W, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: W, messages: [reply], next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_posts: () => ({ pip_id: PIP, workspace_id: W, posts: [], next_before_id: null }),
    list_pip_reply_stats: () => ({ pip_id: PIP, stats: [{ run_id: run, status: "succeeded", seconds: 8, input_tokens: 20000, output_tokens: 1909, requests: 2, has_trace: true, trace: steps }] }),
    list_pip_apps: () => ({ apps: [] }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }),
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m?.type !== "pipsRequest") return;
    const make = answers[m.request.type];
    setTimeout(() => window.postMessage(make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) }
      : { type: "pipsReply", id: m.id, ok: false, error: "not offered here" }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 73, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(PIP)});`;
const THEME = ":root{--vscode-editor-background:#1e1e1e;--vscode-foreground:#cccccc;--vscode-editor-foreground:#d4d4d4;--vscode-descriptionForeground:#9d9d9d;--vscode-panel-border:#2b2b2b;--vscode-input-border:#3c3c3c;--vscode-editor-font-family:monospace}";
const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fontCss}</style><style>${THEME}</style><style>${css}</style></head><body class="vscode-dark"><main id="app"></main><div id="review-root"></div>`
  + `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

async function openTrace(width) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: page, contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector(`[data-job="${PIP}"]`);
  await p.click(`[data-job="${PIP}"]`);
  await p.waitForSelector(".pip-message .ract-trace", { state: "attached" });
  await p.hover(".pip-message.assistant");
  await p.click(".pip-message .ract-trace");
  await p.waitForSelector("body > .dgc-trace-backdrop .dgc-trace-dialog");
  return { p, errors, context };
}
const box = (p, s) => p.locator(s).first().boundingBox();

test("on a Pip's own page the dialog stands by itself: its colours, its rows, its range, its failed step in green", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await openTrace(1000);
  try {
    const look = await p.evaluate(() => {
      const dialog = getComputedStyle(document.querySelector(".dgc-trace-dialog")), scrub = getComputedStyle(document.querySelector(".dgc-trace-scrub"));
      const failed = document.querySelector(".dgc-trace-row.error");
      return { background: dialog.backgroundColor, color: dialog.color, edge: dialog.borderTopColor, scrubPad: scrub.paddingLeft, scrubBorder: scrub.borderTopWidth,
        glyph: getComputedStyle(document.querySelector(".dgc-trace-glyph")).fontFamily, height: document.querySelector(".dgc-trace-row").getBoundingClientRect().height,
        green: getComputedStyle(failed.querySelector(".dgc-trace-bar")).backgroundColor, greenTime: getComputedStyle(failed.querySelector(".dgc-trace-meta span:last-child")).color };
    });
    assert.deepEqual(look, { background: "rgb(30, 30, 30)", color: "rgb(212, 212, 212)", edge: "rgb(60, 60, 60)", scrubPad: "0px", scrubBorder: "0px", glyph: "codicon",
      height: 40, green: "rgb(118, 138, 0)", greenTime: "rgb(131, 153, 0)" });
    assert.deepEqual(await p.locator(".dgc-trace-meta span:first-child").allTextContents(), ["10,634 tk", "6 hits", "Failed", "11,275 tk"]);
    const playBox = await box(p, ".dgc-trace-play"), scrubBox = await box(p, ".dgc-trace-scrub");
    assert.equal(playBox.width, 44);
    assert.equal(Math.round(playBox.y + playBox.height / 2), Math.round(scrubBox.y + scrubBox.height / 2), "the play button and the timeline on one line");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("in a side bar's width each lane takes its own line: the bars, the ruler and the cursor share one timeline", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await openTrace(300);
  try {
    const dialog = await box(p, ".dgc-trace-dialog");
    assert.ok(dialog.width <= 300 - 16, `it fits (${dialog.width})`);
    const lane = await box(p, ".dgc-trace-lane"), label = await box(p, ".dgc-trace-label"), meta = await box(p, ".dgc-trace-meta");
    assert.ok(lane.width > dialog.width * 0.8, `the lane has the width (${lane.width} of ${dialog.width})`);
    assert.ok(lane.y >= label.y + label.height - 1, "under its name");
    assert.ok(Math.abs((label.y + label.height / 2) - (meta.y + meta.height / 2)) <= 1, "the name and its numbers on one line");
    assert.ok(meta.x + meta.width <= dialog.x + dialog.width + 0.5, "its numbers stay inside");
    // At the very end the cursor stands where the last bar ends, and in the middle halfway along the lane.
    const cursorX = async () => (await box(p, ".dgc-trace-cursor")).x;
    const bar = await p.locator(".dgc-trace-row").last().locator(".dgc-trace-bar").boundingBox();
    assert.ok(Math.abs(await cursorX() - (bar.x + bar.width)) <= 1.5);
    await p.locator(".dgc-trace-scrub").evaluate((n) => { n.value = "4000"; n.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.ok(Math.abs(await cursorX() - (lane.x + lane.width / 2)) <= 1.5);
    const transport = await box(p, ".dgc-trace-transport"), clock = await box(p, ".dgc-trace-clock"), scrub = await box(p, ".dgc-trace-scrub");
    assert.ok(scrub.width > 60, `the timeline can be used (${scrub.width})`);
    assert.ok(clock.x + clock.width <= transport.x + transport.width, "the clock stays inside");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
