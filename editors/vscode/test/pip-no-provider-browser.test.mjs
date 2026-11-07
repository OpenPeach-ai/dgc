// A Pip's chat with no provider saved, and a failed model request's words, in real Chromium with the real client.
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
const markdownJs = (await build({ entryPoints: [new URL("../src/markdown.ts", import.meta.url).pathname], bundle: true, write: false,
  format: "iife", globalName: "DgcMarkdown", platform: "browser" })).outputFiles[0].text;
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
  const failedMessage = { id: "u1", pip_id: PIP, workspace_id: W, role: "user", text: "hello", run_id: run, status: "failed", model: "", created_at: "2026-11-07T01:00:00Z",
    error: "HTTP 404 from http://localhost:11434/v1/chat/completions: {\"error\":{\"message\":\"model 'qwen3:8b' not found\"}}" };
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
    list_pip_models: () => ({ default_model: "qwen3:8b", models: [{ id: "qwen3.8:27b", name: "qwen3.8:27b" }], connection: "configured", no_provider: true, providers: [] }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: W, messages: [failedMessage], next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_posts: () => ({ pip_id: PIP, workspace_id: W, posts: [], next_before_id: null }),
    list_pip_reply_stats: () => ({ pip_id: PIP, stats: [{ run_id: run, status: "succeeded", seconds: 8, input_tokens: 20000, output_tokens: 1909, requests: 2, has_trace: true, trace: steps }] }),
    list_pip_apps: () => ({ apps: [] }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }),
  };
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    window.__posted.push(m?.type === "pipsRequest" ? m.request.type : m?.type);
    if (m?.type !== "pipsRequest") return;
    const make = answers[m.request.type];
    setTimeout(() => window.postMessage(make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) }
      : { type: "pipsReply", id: m.id, ok: false, error: "not offered here" }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 73, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(PIP)});`;
const THEME = ":root{--vscode-editor-background:#1e1e1e;--vscode-foreground:#cccccc;--vscode-editor-foreground:#d4d4d4;--vscode-descriptionForeground:#9d9d9d;--vscode-panel-border:#2b2b2b;--vscode-input-border:#3c3c3c;--vscode-editor-font-family:monospace}";
const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fontCss}</style><style>${THEME}</style><style>${css}</style></head><body class="vscode-dark"><main id="app"></main><div id="review-root"></div>`
  + `<script>${markdownJs.replace(/<\/script/g, "<\\/script")}</script><script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

async function openChat() {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: page, contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector(`[data-job="${PIP}"]`);
  await p.click(`[data-job="${PIP}"]`);
  await p.waitForSelector("#chatText");
  await p.waitForFunction(() => document.body.innerText.includes("No provider"));
  return { p, errors, context };
}

test("no provider: the chip says so, a send stays in the box and says where to fix it", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await openChat();
  try {
    assert.equal((await p.innerText("body")).includes("qwen3:8b)"), false, "no model is claimed");
    await p.fill("#chatText", "hello again");
    await p.press("#chatText", "Enter");
    await p.waitForSelector('.message-status[role="alert"]');
    assert.match(await p.innerText('.message-status[role="alert"]'), /^No model provider yet\. Add one to start\. Settings → Models/);
    assert.equal((await p.innerText("#chatText")).trim(), "hello again", "what you wrote stays");
    assert.equal((await p.evaluate(() => window.__posted)).includes("send_pip_message"), false, "nothing is sent");
    await p.click('.message-status[role="alert"] [data-open-models]');
    assert.ok((await p.evaluate(() => window.__posted)).includes("openSettings"));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a failed model request reads plainly, with its own answer one click away", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await openChat();
  try {
    const line = await p.innerText('.message-status[data-status="failed"]');
    assert.match(line, /^Failed · The model qwen3:8b isn't available\. Choose another one, or add a provider\. Settings → Models/);
    assert.doesNotMatch(line, /http|\{|404/);
    assert.equal(await p.locator(".message-failure span").isVisible(), false, "behind Details");
    await p.click(".message-failure summary");
    assert.match(await p.innerText(".message-failure span"), /HTTP 404 from http:/);
  } finally { await context.close(); }
});
