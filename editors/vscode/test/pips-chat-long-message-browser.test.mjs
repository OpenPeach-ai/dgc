// A message to a Pip can be up to 256 KB (Limits for everyone, 10 Nov; it was 4,000 characters), in real Chromium with the
// real client: a runtime at Pips API 79 takes a 100 KB message whole; past 256 KB nothing is sent and the box says why;
// an older runtime keeps its old limit, so a long message is never sent to one that would refuse it.
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
  window.__sent = []; window.__active = null; user.status = "succeeded"; window.__user = user;
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
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: window.__api || 79, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(PIP)});`;
const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
  + `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

async function open(api = 79) {
  const context = await browser.newContext({ viewport: { width: 640, height: 800 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: page.replace("<script>", `<script>window.__api=${api};</script><script>`), contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector(`[data-job="${PIP}"]`);
  await p.click(`[data-job="${PIP}"]`);
  await p.waitForSelector("#chatText");
  return { p, errors, context };
}

const KB = 1024;
const long = (n) => ("Every detail of the plan matters. ".repeat(Math.ceil(n / 34))).slice(0, n);
async function say(p, text) {
  await p.evaluate((t) => { const box = document.getElementById("chatText"); box.focus();
    if ("value" in box) box.value = t; else box.textContent = t; box.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  await p.press("#chatText", "Enter");
}

test("a 100 KB message goes whole to a runtime at Pips API 79", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open(79);
  const text = long(100 * KB);
  await say(p, text);
  await p.waitForFunction(() => window.__sent.length === 1, null, { timeout: 5000 });
  assert.equal(await p.evaluate(() => window.__sent[0].length), text.length, "every character is sent");
  assert.deepEqual(errors, []);
  await context.close();
});

test("past 256 KB nothing is sent, and the box says why and what to do", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open(79);
  await say(p, long(300 * KB));
  await p.waitForTimeout(300);
  assert.deepEqual(await p.evaluate(() => window.__sent), [], "nothing was sent");
  const said = await p.locator(".conversation-log, #app").first().innerText();
  assert.match(said, /256 KB/, "it says the limit");
  assert.match(said, /Attach the rest as a file|attach it as a file/i, "and what to do");
  assert.deepEqual(errors, []);
  await context.close();
});

test("an older runtime (before API 79) keeps its 4,000-character limit", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open(73);
  await say(p, long(5000));
  await p.waitForTimeout(300);
  assert.deepEqual(await p.evaluate(() => window.__sent), [], "a runtime that would refuse it is never sent it");
  assert.match(await p.locator("#app").innerText(), /4,000 characters/);
  assert.deepEqual(errors, []);
  await context.close();
});
