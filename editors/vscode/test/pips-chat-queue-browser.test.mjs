// Alt+Enter while a Pip is answering keeps the message above the box (reported 6 Nov), in real Chromium with the real
// client: the queue row is the one Work and ChatDGC draw, Enter still steers, and the queue sends itself when the reply ends.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const bundled = await build({ entryPoints: [new URL("../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false,
  format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const PIP = "pip_" + "g".repeat(32);

const host = `(${function (PIP) {
  const W = "ws_" + "p".repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = { id: PIP, workspace_id: W, pip_type: "lens", name: "Planner", goal: "Help.", source_policy: { mode: "personal" }, source_ref: "HEAD",
    status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null, proposals: [], pending_review_count: 0 };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576,
    effective_context_size: 8192, context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const run = "run_" + "5".repeat(32);
  const user = { id: "u1", pip_id: PIP, workspace_id: W, role: "user", text: "Plan the day", run_id: run, status: "running", model: "m", created_at: "2026-11-06T08:00:00Z" };
  window.__sent = []; window.__active = { id: run, status: "running" }; window.__user = user;
  const nativeInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => { if (ms === 4000) window.__pipPoll = fn; return nativeInterval(fn, ms, ...args); };
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: W, name: "Personal", kind: "personal" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip], total: 1, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: W, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: W, messages: [user], next_before_id: null, active_run: window.__active, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_posts: () => ({ pip_id: PIP, workspace_id: W, posts: [], next_before_id: null }),
    list_pip_reply_stats: () => ({ pip_id: PIP, stats: [] }),
    list_pip_apps: () => ({ apps: [] }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }),
    get_pip_chat_stream: () => ({ run_id: run, cursor: 0, text: "", done: false, events: [] }),
    send_pip_message: (req) => { window.__sent.push(req.text); return { message: { ...user, id: "u" + (window.__sent.length + 1), text: req.text }, run: { id: run, status: "queued" } }; },
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m?.type !== "pipsRequest") return;
    const make = answers[m.request.type];
    setTimeout(() => window.postMessage(make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) }
      : { type: "pipsReply", id: m.id, ok: false, error: "not offered here" }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 73, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(PIP)});`;
const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
  + `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

async function open() {
  const context = await browser.newContext({ viewport: { width: 640, height: 800 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: page, contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector(`[data-job="${PIP}"]`);
  await p.click(`[data-job="${PIP}"]`);
  await p.waitForSelector("#chatText");
  return { p, errors, context };
}
const words = (p) => p.locator("#chat-queue .dgc-queue-text").allTextContents();
const type = async (p, text, key) => { await p.fill("#chatText", text); await p.press("#chatText", key); };

test("Alt+Enter while a Pip answers queues above the box; the queue edits and drains when the reply ends", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open();
  await p.waitForFunction(() => document.querySelector(".chat-send")?.getAttribute("aria-label") === "Send mid-turn update");
  await type(p, "first", "Alt+Enter");
  await type(p, "second", "Alt+Enter");
  await type(p, "third", "Alt+Enter");
  assert.deepEqual(await words(p), ["first", "second", "third"]);
  assert.equal(await p.evaluate(() => document.getElementById("chatText").value), "", "the box is clear");
  assert.deepEqual(await p.evaluate(() => window.__sent), [], "nothing is sent while it waits");
  assert.match(await p.locator(".chat-queue-head").textContent(), /^3 queued messages$/);
  // The queue sits above the box, not in the transcript.
  assert.equal(await p.locator(".conversation-log").getByText("second").count(), 0);
  const above = await p.evaluate(() => document.querySelector("#chat-queue-box").getBoundingClientRect().bottom <= document.querySelector("#chat-form").getBoundingClientRect().top + 1);
  assert.equal(above, true);
  // Reorder by keyboard, remove, and Move to top.
  await p.focus("#chat-queue .dgc-queue-row:nth-child(1) .dgc-queue-handle");
  await p.keyboard.press("ArrowDown");
  assert.deepEqual(await words(p), ["second", "first", "third"]);
  await p.click("#chat-queue .dgc-queue-row:nth-child(2) [data-queue-role='remove']");
  assert.deepEqual(await words(p), ["second", "third"]);
  await p.click("#chat-queue .dgc-queue-row:nth-child(2) .dgc-queue-more");
  await p.getByRole("menuitem", { name: "Move to top" }).click();
  assert.deepEqual(await words(p), ["third", "second"]);
  // A refresh of the page does not disturb the rows.
  await p.evaluate(() => window.__pipPoll());
  await p.waitForTimeout(40);
  assert.deepEqual(await words(p), ["third", "second"]);
  // The reply ends: the first goes by itself.
  await p.evaluate(() => { window.__active = null; window.__user.status = "succeeded"; window.__pipPoll(); });
  await p.waitForFunction(() => window.__sent.length === 1);
  assert.deepEqual(await p.evaluate(() => window.__sent), ["third"]);
  assert.deepEqual(await words(p), ["second"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("Enter still steers a running reply, and Steer sends a queued message as a mid-turn update", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open();
  await p.waitForFunction(() => document.querySelector(".chat-send")?.getAttribute("aria-label") === "Send mid-turn update");
  await type(p, "go now", "Enter");
  await p.waitForFunction(() => window.__sent.length === 1);
  await p.waitForFunction(() => !document.querySelector("#chatText")?.disabled);
  await type(p, "later", "Alt+Enter");
  await p.waitForSelector("#chat-queue .dgc-queue-steer");
  await p.click("#chat-queue .dgc-queue-steer");
  await p.waitForFunction(() => window.__sent.length === 2);
  assert.deepEqual(await p.evaluate(() => window.__sent), ["go now", "later"]);
  assert.deepEqual(await words(p), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test("a stopped or failed reply sends none of the queue: it comes back to the box", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open();
  await p.waitForFunction(() => document.querySelector(".chat-send")?.getAttribute("aria-label") === "Send mid-turn update");
  await type(p, "one", "Alt+Enter");
  await type(p, "two", "Alt+Enter");
  await p.evaluate(() => { window.__active = null; window.__user.status = "cancelled"; window.__pipPoll(); });
  await p.waitForFunction(() => document.querySelector("#chatText")?.value === "one\n\ntwo");
  assert.deepEqual(await p.evaluate(() => window.__sent), []);
  assert.deepEqual(await words(p), []);
  assert.deepEqual(errors, []);
  await context.close();
});
