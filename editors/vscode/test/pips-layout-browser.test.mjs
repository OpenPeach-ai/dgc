// Pips settings and a reply's details, laid out in real Chromium at side-bar widths. The founder's screenshot
// (2026-10-17): in Pips settings -> Apps, "How many Pips you can have" broke one letter per line, because the
// page-wide input rule gave the number box width:100% and it claimed the whole row. The visual pass then found a
// reply's "Response details" opening inside the row of small buttons, a few pixels wide. jsdom has no layout, so
// pips-many.test.mjs passed over both; these render the real client and its CSS.
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
const PIP = "pip_" + "g".repeat(32);
const hostFor = (opts = {}) => `(${function (PIP, opts) {
  const PW = "ws_" + "p".repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = { id: PIP, workspace_id: PW, pip_type: "core", name: "Core", goal: "Help with what I ask in this chat.", source_policy: { mode: "personal" },
    source_ref: "HEAD", status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null,
    proposals: [], pending_review_count: 0, created_at: "2026-10-17T09:00:00Z", updated_at: "2026-10-17T09:00:00Z" };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message",
    inherited_context_size: 1048576, effective_context_size: 8192, context_min: 2048, context_max: 32768,
    thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const reply = { id: "a1", pip_id: PIP, workspace_id: PW, role: "assistant",
    text: opts.long ? Array.from({ length: 30 }, (_, i) => `Point ${i + 1}: something worth knowing about your week.`).join("\n\n") : "Here is what I found about your week.",
    run_id: "run_" + "5".repeat(32), status: "succeeded", model: "deepseek-v4.1-flash:cloud", created_at: "2026-10-17T09:00:00.000Z" };
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: PW, name: "Personal", kind: "personal" }], current_workspace_id: PW }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip], total: 1, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: PW, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: PW, messages: opts.prompt ? [{ id: "u1", pip_id: PIP, workspace_id: PW, role: "user",
      text: "How was my week?", run_id: reply.run_id, status: "succeeded", model: reply.model, created_at: "2026-10-17T08:59:30.000Z" }, reply] : [reply],
      next_before_id: null, active_run: null,
      history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_apps: () => ({ apps: [] }),
    get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }),
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    const make = m?.type === "pipsRequest" && answers[m.request.type];
    if (make) setTimeout(() => window.postMessage({ type: "pipsReply", id: m.id, ok: true, result: make() }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 44, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(PIP)}, ${JSON.stringify(opts)});`;
const pageFor = (opts) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
  + `<script>${hostFor(opts)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

async function open(width, opts = {}) {
  const html = pageFor(opts);
  const context = await browser.newContext({ viewport: { width, height: opts.height || 800 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: html, contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector(`[data-job="${PIP}"]`);
  return { p, close: () => context.close() };
}
// Lines a text node takes, and their average width: crushed text is many narrow lines.
const lines = (p, selector) => p.evaluate((sel) => {
  const el = document.querySelector(sel); const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
  const range = document.createRange(); range.selectNodeContents(node);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
  return { count: rects.length, width: Math.round(rects.reduce((a, r) => a + r.width, 0) / rects.length) };
}, selector);

for (const width of [260, 320, 480]) {
  test(`Pips settings -> Apps keeps every row's words readable at ${width}px`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close } = await open(width);
    try {
      await p.click("#pips-settings-open");
      await p.click('[data-pips-settings="apps"]');
      await p.waitForSelector("#pips-limit-form #pipsMax");
      const title = await lines(p, "#pips-limit-form .row-words strong");
      assert.ok(title.count <= 2, `"How many Pips you can have" takes ${title.count} lines (${title.width}px each)`);
      const rows = await p.$$eval(".pip-page-row.static", (els) => els.filter((e) => e.offsetWidth).map((e) => {
        const words = e.querySelector(".row-words");
        return { row: Math.round(e.getBoundingClientRect().width), words: words ? Math.round(words.getBoundingClientRect().width) : null, text: e.textContent.trim().slice(0, 30) };
      }));
      assert.ok(rows.length >= 2, "the Accounts, Skills and limit rows render");
      for (const r of rows) if (r.words !== null) assert.ok(r.words >= Math.min(170, r.row - 40), `"${r.text}": words get ${r.words}px of a ${r.row}px row`);
      const box = await p.$eval("#pipsMax", (el) => el.getBoundingClientRect().width);
      assert.ok(box <= 120, `the number box is ${box}px wide`);
    } finally { await close(); }
  });
}

test("a reply's details open to a whole row, not a few pixels beside its buttons", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(300);
  try {
    await p.click(`[data-job="${PIP}"]`);
    await p.waitForSelector("details.message-details > summary", { state: "attached" });
    await p.evaluate(() => { document.querySelector("details.message-details").open = true; });
    const widths = await p.evaluate(() => {
      const w = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().width);
      return { message: w("article.pip-message.assistant"), panel: w(".message-provenance"), list: w(".message-provenance dl") };
    });
    assert.ok(widths.panel >= 160, `the details panel is ${widths.panel}px wide in a ${widths.message}px message`);
    assert.ok(widths.list >= 140, `its Saved/Model/Status list is ${widths.list}px wide`);
  } finally { await close(); }
});

test("in the chat, each message's time shows without the pointer while the buttons beside it wait for it", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(320, { prompt: true });
  try {
    await p.click(`[data-job="${PIP}"]`);
    await p.waitForSelector("article.pip-message.user time.msg-time");
    await p.mouse.move(0, 0);
    const look = (who) => p.evaluate((who) => {
      const n = document.querySelector(`article.pip-message.${who} .response-actions > time.msg-time`);
      const opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
      return { when: n.getAttribute("datetime"), opacity: opacity(n), buttons: Math.max(0, ...[...n.parentElement.querySelectorAll("button, summary")].map(opacity)),
               simple: !!n.closest(".simple-pips"), right: Math.round(n.getBoundingClientRect().right), edge: Math.round(n.closest("article").getBoundingClientRect().right) };
    }, who);
    const mine = await look("user"), reply = await look("assistant");
    assert.ok(mine.simple, "the chat a personal Pip opens in");
    assert.equal(mine.when, "2026-10-17T08:59:30.000Z");
    assert.equal(reply.when, "2026-10-17T09:00:00.000Z");
    assert.equal(mine.opacity, 1, "your message's time");
    assert.equal(reply.opacity, 1, "the reply's time");
    assert.equal(mine.buttons, 0, "the buttons wait for the pointer");
    assert.ok(mine.edge - mine.right <= 6, `your time sits at the message's right edge (${mine.right} of ${mine.edge})`);
    await p.hover("article.pip-message.user .bubble");
    await p.waitForTimeout(300);                             // their .12s fade
    assert.equal((await look("user")).buttons, 1, "pointed at, they come back");
  } finally { await close(); }
});

test("a reply's details opened at the bottom of the conversation come into view", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(320, { prompt: true, long: true });   // a long reply: its buttons end the conversation
  try {
    await p.click(`[data-job="${PIP}"]`);
    await p.waitForSelector("article.pip-message.assistant details.message-details > summary");
    await p.evaluate(() => { const log = document.querySelector(".conversation-log"); log.scrollTop = 0; });
    await p.click("article.pip-message.assistant details.message-details > summary");
    await p.waitForTimeout(150);
    const fit = await p.evaluate(() => {
      const log = document.querySelector(".conversation-log").getBoundingClientRect();
      const panel = document.querySelector("article.pip-message.assistant .message-provenance").getBoundingClientRect();
      return { logBottom: Math.round(log.bottom), panelBottom: Math.round(panel.bottom), logHeight: Math.round(log.height) };
    });
    assert.ok(fit.logHeight > 0);
    assert.ok(fit.panelBottom <= fit.logBottom + 1, `the panel ends at ${fit.panelBottom}, the conversation at ${fit.logBottom}`);
  } finally { await close(); }
});
