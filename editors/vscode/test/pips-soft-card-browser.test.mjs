// The Soft card and the Stop all dialog at side-bar widths, in real Chromium (0.51.0 morning check). In the normal side bar the
// card's two-line clamp cut "Nothing has been sent." to "Nothing...": nothing on an approval card may be cut off silently, and
// that sentence is the part that reassures. Stop all's dialog opened under the Controls popover, which hid its title.
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


const hostFor = (opts) => `(${function (PIP, opts) {
  const W = "ws_" + "p".repeat(32), run = "run_" + "b".repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = { id: PIP, workspace_id: W, pip_type: "lens", name: "Site Traffic", goal: "Help.", source_policy: { mode: "personal" }, source_ref: "HEAD",
    status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null, proposals: [], pending_review_count: 0 };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576,
    effective_context_size: 8192, context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const hold = { id: "compact_" + "c".repeat(32), pip_id: PIP, workspace_id: W, run_id: opts.olderCard ? "run_" + "e".repeat(32) : run, digest: "d".repeat(64), frame: null, status: "pending", created_at: "2026-11-07T04:00:00Z", expires_at: "2036-11-07T04:00:00Z", resolved_at: null, resolved_by: null, continuation_run_id: null,
    summary: { method: "POST", host: "traffic.pip-test.example", path: "/accounts/a616a45d1179e324aa98c4ce2663bb51/billing/profile", page: "http://traffic.pip-test.example/billing", route: "/accounts/*/billing/profile", asks_because: "maybe_payment", asks_word: "billing", fields: [{ name: "company", value: "Garden Co" }], more_fields: 0, body_bytes: 30 } };
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: W, name: "Personal", kind: "personal" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip], total: 1, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: W, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: W, messages: [opts.running ? { id: "u1", pip_id: PIP, workspace_id: W, role: "user", text: "Press Refresh", run_id: run, status: "running", model: "m", created_at: "2026-11-07T04:00:00Z" }
      : { id: "a1", pip_id: PIP, workspace_id: W, role: "assistant", text: "It's waiting for your okay.", run_id: run, status: "succeeded", model: "m", created_at: "2026-11-07T04:00:00Z" }], next_before_id: null, active_run: opts.running ? { id: run, status: "running", started_at: "2026-11-07T04:00:00Z" } : null, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_activity: (r) => { const events = r.after ? [] : [{ seq: 1, run_id: run, pip_id: PIP, workspace_id: W, event_type: "pip_run_progress", payload: { kind: "progress", state: "waiting", message: "Waiting for the model" }, created_at: "2026-11-07T04:00:01Z" }];
      return { run_id: run, pip_id: PIP, workspace_id: W, events, next_cursor: r.after || 1, has_more: false, history_may_be_truncated: false, retention_limit: 500, retention_scope: "workspace" }; },
    list_pip_run_posts: () => ({ pip_id: PIP, workspace_id: W, posts: [], next_before_id: null }), list_pip_reply_stats: () => ({ pip_id: PIP, stats: [] }),
    list_pip_apps: () => ({ apps: [] }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }),
    get_pip_computer: () => ({ computer: { pip_id: PIP, granted: true, available: true, reason: "", pending: opts.noCard ? 0 : 1, actions: opts.noCard ? [] : [hold] } }),
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m?.type !== "pipsRequest") return;
    const make = answers[m.request.type];
    setTimeout(() => window.postMessage(make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) }
      : { type: "pipsReply", id: m.id, ok: false, error: "not offered here" }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 73, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(PIP)}, ${JSON.stringify(opts)});`;
const dark = ":root{--vscode-editor-background:#181818;--vscode-foreground:#e2e2e2;--vscode-descriptionForeground:#a3a3a3;--vscode-input-background:#242424;--vscode-font-family:sans-serif}";
const light = ":root{--vscode-editor-background:#ffffff;--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#616161;--vscode-input-background:#ffffff;--vscode-font-family:sans-serif}";

async function open(width, theme = dark, opts = {}) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${theme}${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
    + `<script>${hostFor(opts)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;
  const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: html, contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector(`[data-job="${PIP}"]`);
  return { p, close: () => context.close() };
}

for (const [width, name, theme] of [[300, "dark", dark], [300, "light", light], [260, "dark", dark], [640, "light", light], [1100, "dark", dark]]) {
  test(`every word on the Soft card shows at ${width}px, ${name}`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close } = await open(width, theme);
    try {
      await p.click(`[data-job="${PIP}"]`);
      await p.waitForSelector("[data-computer-card] .app-link-words small");
      const shown = await p.evaluate(() => {
        const small = document.querySelector("[data-computer-card] .app-link-words small"), style = getComputedStyle(small);
        const range = document.createRange(); range.selectNodeContents(small);
        return { text: small.textContent, cut: small.scrollHeight > small.clientHeight + 1, clamp: style.webkitLineClamp, overflow: style.overflow, words: range.getBoundingClientRect().bottom - small.getBoundingClientRect().bottom };
      });
      assert.match(shown.text, /Nothing has been sent\.$/);
      assert.equal(shown.cut, false, JSON.stringify(shown));
      assert.equal(shown.clamp, "none", "no clamp");
      assert.ok(shown.words <= 1, "the last word is inside the card's own box");
    } finally { await close(); }
  });
}

test("Stop all Pips: the Controls popover closes first, the dialog's title shows, and Cancel gives the focus back", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(300);
  try {
    await p.click("#runner-controls-toggle");
    await p.waitForSelector(".runner-menu");
    await p.click("#stop-all");
    await p.waitForSelector(".dialog h2");
    const seen = await p.evaluate(() => {
      const title = document.querySelector(".dialog h2"), box = title.getBoundingClientRect();
      const atTitle = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { title: title.textContent, onTop: title === atTitle || title.contains(atTitle), controlsOpen: !!document.querySelector("details.runner-controls[open]"),
        overlay: Number(getComputedStyle(document.querySelector(".overlay")).zIndex) };
    });
    assert.equal(seen.title, "Stop all Pips?");
    assert.equal(seen.onTop, true, "nothing lies over its title");
    assert.equal(seen.controlsOpen, false);
    assert.ok(seen.overlay > 30, "and it stacks over the menu in any case");
    await p.getByRole("button", { name: "Cancel" }).click();
    await p.waitForFunction(() => document.activeElement?.id === "runner-controls-toggle");
    assert.equal(await p.evaluate(() => !!document.querySelector("details.runner-controls[open]")), false, "it stays closed");
  } finally { await close(); }
});

test("a Pip whose card waits says it is waiting for you, not for the model", async (t) => {
  if (skipOrFail(t)) return;
  // A card this run made; none; and one from an earlier reply, which says nothing about this run.
  for (const [opts, words] of [[{ running: true }, /Waiting for you/], [{ running: true, noCard: true }, /Waiting for the model/], [{ running: true, olderCard: true }, /Waiting for the model/]]) {
    const { p, close } = await open(300, dark, opts);
    try {
      await p.click(`[data-job="${PIP}"]`);
      await p.waitForFunction((source) => new RegExp(source).test(document.querySelector(".pip-working")?.textContent || ""), words.source);
      assert.match(await p.locator(".pip-working").textContent(), words);
    } finally { await close(); }
  }
});
