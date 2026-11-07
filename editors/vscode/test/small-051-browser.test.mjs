// The small known issues fixed before 0.51.0, in real Chromium with the real client: a failed hello says so, and Details has
// all of a failure, in an editor's words.
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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const bundled = await build({ entryPoints: [new URL("../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false,
  format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const markdownJs = (await build({ entryPoints: [new URL("../src/markdown.ts", import.meta.url).pathname], bundle: true, write: false,
  format: "iife", globalName: "DgcMarkdown", platform: "browser" })).outputFiles[0].text;
const markdown = (await build({ entryPoints: [new URL("../src/markdown.ts", import.meta.url).pathname], bundle: true, write: false,
  format: "cjs", platform: "node" })).outputFiles[0].text;
const loaded = { exports: {} }; new Function("module", "exports", markdown)(loaded, loaded.exports);
const { editorAdvice, modelFailure } = loaded.exports;
const PIP = "pip_" + "g".repeat(32);

const host = (PIP, messages) => `(${function (PIP, messages) {
  const W = "ws_" + "p".repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = { id: PIP, workspace_id: W, pip_type: "lens", name: "Planner", goal: "Help.", source_policy: { mode: "personal" }, source_ref: "HEAD",
    status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null, proposals: [], pending_review_count: 0 };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576,
    effective_context_size: 8192, context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "", context_note: "" };
  const shaped = messages.map((m) => ({ pip_id: PIP, workspace_id: W, model: "", ...m }));
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: W, name: "Personal", kind: "personal" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip], total: 1, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: W, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m:1", models: [{ id: "m:1", name: "m:1" }], connection: "configured", providers: [] }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: W, messages: shaped, next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_posts: () => ({ pip_id: PIP, workspace_id: W, posts: [], next_before_id: null }),
    list_pip_reply_stats: () => ({ pip_id: PIP, stats: [] }),
    list_pip_apps: () => ({ apps: [] }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }), introduce_pip: () => ({ run: {}, message: {} }),
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
}})(${JSON.stringify(PIP)}, ${JSON.stringify(messages)});`;
const THEME = ":root{--vscode-editor-background:#1e1e1e;--vscode-foreground:#cccccc;--vscode-editor-foreground:#d4d4d4;--vscode-descriptionForeground:#9d9d9d}";

async function openChat(messages) {
  const context = await browser.newContext({ viewport: { width: 700, height: 800 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${THEME}</style><style>${css}</style></head><body class="vscode-dark"><main id="app"></main><div id="review-root"></div>`
    + `<script>${markdownJs.replace(/<\/script/g, "<\\/script")}</script><script>${host(PIP, messages)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: page, contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector(`[data-job="${PIP}"]`);
  await p.click(`[data-job="${PIP}"]`);
  await p.waitForSelector("#chatText");
  return { p, errors, context };
}
const KEY_REFUSED = "HTTP 401 from https://provider.example/v1/chat/completions: invalid api key";
const hello = (extra = {}) => ({ id: "h1", role: "user", intro: true, text: "Say hello", run_id: "run_" + "1".repeat(32), status: "failed", created_at: "2026-11-07T01:00:00Z", error: KEY_REFUSED, ...extra });

test("a new Pip whose first message failed says so, with where to fix it and Try again", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await openChat([hello()]);
  try {
    const line = await p.waitForSelector('[data-failed-turn] .message-status[data-status="failed"]');
    assert.match(await line.innerText(), /^Failed · The model provider turned down the API key\. Check the key\. Settings → Models Try again$/);
    assert.doesNotMatch(await line.innerText(), /http|401/, "its own answer stays behind Details");
    assert.equal(await p.locator(".pip-failed-turn .bubble").count(), 0, "DGC's hidden prompt has no bubble");
    assert.match(await p.innerText(".conversation-empty"), /Talk to/, "the chat still says what it is");
    assert.ok(await p.evaluate(() => { const failed = document.querySelector("[data-failed-turn]"), empty = document.querySelector(".conversation-empty");
      return !!(failed.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING); }), "above it, as no provider's line is");
    await p.click('[data-failed-turn] summary');
    assert.match(await p.innerText("[data-failed-turn] details span"), /HTTP 401 from https:\/\/provider\.example/);
    await p.click("[data-failed-turn] [data-open-models]");
    assert.ok((await p.evaluate(() => window.__posted)).includes("openSettings"));
    await p.click("[data-hello-again]");
    await p.waitForFunction(() => window.__posted.includes("introduce_pip"));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a hidden follow-up that failed says so too, with no Try again; one with a reply says nothing", async (t) => {
  if (skipOrFail(t)) return;
  const r2 = "run_" + "2".repeat(32);
  const talk = [{ id: "u1", role: "user", text: "hi", run_id: r2, status: "succeeded", created_at: "2026-11-07T01:00:00Z" },
    { id: "a1", role: "assistant", text: "Hello there.", run_id: r2, status: "succeeded", created_at: "2026-11-07T01:00:05Z" }];
  const after = hello({ id: "h2", run_id: "run_" + "3".repeat(32), created_at: "2026-11-07T01:01:00Z" });
  let open = await openChat([...talk, after]);
  try {
    await open.p.waitForSelector("[data-failed-turn]");
    assert.equal(await open.p.locator("[data-hello-again]").count(), 0, "Try again is for a first message only");
    assert.equal(await open.p.locator(".conversation-empty").count(), 0);
  } finally { await open.context.close(); }
  open = await openChat([hello({ id: "h3", run_id: r2 }), { id: "a2", role: "assistant", text: "Hello.", run_id: r2, status: "succeeded", created_at: "2026-11-07T01:00:05Z" }]);
  try {
    await open.p.waitForSelector('[data-message="a2"]');
    assert.equal(await open.p.locator("[data-failed-turn]").count(), 0);
  } finally { await open.context.close(); }
  // Try again worked: the old failure doesn't stand above the hello.
  const r5 = "run_" + "5".repeat(32);
  open = await openChat([hello({ id: "h4" }), { id: "h5", role: "user", intro: true, text: "Say hello", run_id: r5, status: "succeeded", created_at: "2026-11-07T01:02:00Z" },
    { id: "a3", role: "assistant", text: "Hello at last.", run_id: r5, status: "succeeded", created_at: "2026-11-07T01:02:05Z" }]);
  try {
    await open.p.waitForSelector('[data-message="a3"]');
    assert.equal(await open.p.locator("[data-failed-turn]").count(), 0);
    assert.equal(await open.p.locator(".conversation-empty").count(), 0);
  } finally { await open.context.close(); }
  // Two tries, both failed: one line, and Try again still there.
  open = await openChat([hello({ id: "h6" }), hello({ id: "h7", run_id: r5, created_at: "2026-11-07T01:02:00Z" })]);
  try {
    await open.p.waitForSelector("[data-failed-turn]");
    assert.equal(await open.p.locator("[data-failed-turn]").count(), 1);
    assert.equal(await open.p.locator("[data-hello-again]").count(), 1);
    assert.equal(await open.p.locator(".conversation-empty").count(), 1);
  } finally { await open.context.close(); }
});

test("Details has all of a failure, in an editor's words, and wraps", async (t) => {
  if (skipOrFail(t)) return;
  const tail = "Failed to establish a new connection: [Errno 111] Connection refused";
  const full = "cannot connect to http://127.0.0.1:18899/v1 — is your local LLM server running? (/connect <url> to change it) " + "HTTPConnectionPool ".repeat(30) + tail;
  const { p, context } = await openChat([{ id: "u1", role: "user", text: "hello", run_id: "run_" + "4".repeat(32), status: "failed", created_at: "2026-11-07T01:00:00Z",
    error: full.slice(0, 300), error_detail: full }]);
  try {
    await p.waitForSelector('.message-status[data-status="failed"]');
    await p.click(".message-failure summary");
    const shown = await p.innerText(".message-failure span");
    assert.ok(shown.endsWith(tail), shown.slice(-80));
    assert.doesNotMatch(shown, /\/connect/);
    assert.match(shown, /change it in Settings → Models/);
    const overflow = await p.evaluate(() => { const s = document.querySelector(".message-failure span"); return s.scrollWidth - s.clientWidth; });
    assert.ok(overflow <= 1, `it wraps: ${overflow}`);
  } finally { await context.close(); }
});

test("an editor names Settings → Models for what the terminal names a flag or a slash command for", () => {
  const words = editorAdvice("the server offers no model named 'm:1' — pull it (ollama pull m:1), pick one with /model or `dgc --model NAME`, or run `dgc setup`");
  assert.equal(words, "the server offers no model named 'm:1' — pull it (ollama pull m:1), or choose another in Settings → Models");
  assert.equal(editorAdvice("the endpoint rejected the key — set it with /connect, `dgc --api-key-env NAME` or DGC_API_KEY"), "the endpoint rejected the key — check it in Settings → Models");
  assert.equal(editorAdvice("the endpoint http://x/v1 is not answering — start your server (ollama serve / llama-server / LM Studio) or fix the URL; `dgc doctor` checks both"),
    "the endpoint http://x/v1 is not answering — start your server (ollama serve / llama-server / LM Studio) or fix the URL in Settings → Models");
  assert.equal(editorAdvice("the connection to x was dropped before it answered — check a proxy or VPN, or the server's logs; `dgc doctor` checks it"),
    "the connection to x was dropped before it answered — check a proxy or VPN, or the server's logs");
  assert.equal(editorAdvice("cannot connect — is Ollama running? (/connect <url> to change it)"), "cannot connect — is Ollama running? (change it in Settings → Models)");
  assert.equal(editorAdvice("the server failed on its side — check its logs; `dgc doctor` shows what it offers"), "the server failed on its side — check its logs");
  assert.doesNotMatch(modelFailure("HTTP 404 from x: model 'm:1' not found\n  → the server offers no model named 'm:1' — pull it (ollama pull m:1), pick one with /model or `dgc --model NAME`, or run `dgc setup`").detail, /dgc --model/);
});
