// A Personal Pip changes its own job at once in a turn you started, with Undo (0.52, the user's call D6), and /setup
// in its box. The chat shows each change after the reply that made it as one line: "Pitch updated its job: name,
// instructions · Undo · Details"; after Undo it reads Undone. In real Chromium with the real client and CSS.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { messageMarkup } from "../src/pipsTranscript.js";
import { scheduleLabel } from "../src/pipsModel.js";
import { routineWhen } from "../src/pipRoutines.js";
import { createRequire } from "node:module";

const OWN = "own_" + "a".repeat(32), ROUTINE = "own_" + "b".repeat(32);
const JOB_CHANGE = { id: OWN, kind: "job", fields: ["name", "goal"], status: "applied", created_at: "2026-11-10T03:00:00.000Z",
  undone_at: null, after: { name: "Pitch", goal: "Write one-page sales sheets for Acme Notes" } };
const ROUTINE_CHANGE = { id: ROUTINE, kind: "routine", fields: ["routine"], status: "applied", created_at: "2026-11-10T03:00:00.000Z",
  undone_at: null, after: { title: "Morning brief", when: "every day at 08:00 (Asia/Kolkata)", prompt: "Tell me the news." } };
const options = { name: "Pitch", formatDate: () => "", renderMarkdown: (t) => `<p>${t}</p>`, prompt: "", canSend: true, undo: true };

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
  const W = "ws_" + "p".repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = { id: PIP, workspace_id: W, pip_type: "lens", name: "Pitch", goal: "Write one-page sales sheets for Acme Notes", source_policy: { mode: "personal" },
    source_ref: "HEAD", status: "active", current_version: 2, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null, proposals: [], pending_review_count: 0 };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576,
    effective_context_size: 8192, context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const at = (i) => new Date(Date.UTC(2026, 10, 10, 3, i)).toISOString();
  window.__messages = [
    { id: "u1", pip_id: PIP, workspace_id: W, role: "user", text: "Call yourself Pitch and write one-page sales sheets", run_id: "run_" + "1".repeat(32), status: "succeeded", model: "m", created_at: at(1) },
    { id: "a1", pip_id: PIP, workspace_id: W, role: "assistant", text: "I'm Pitch now, writing one-page sales sheets.", run_id: "run_" + "1".repeat(32), status: "succeeded", model: "m", created_at: at(2),
      changes: [opts.change] },
  ];
  window.__requests = [];
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: W, name: "Personal", kind: "personal" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip], total: 1, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: W, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: W, messages: window.__messages, next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_posts: () => ({ pip_id: PIP, workspace_id: W, posts: [], next_before_id: null }),
    list_pip_reply_stats: () => ({ pip_id: PIP, stats: [] }),
    list_pip_apps: () => ({ apps: [] }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }),
    undo_pip_change: (req) => {
      const change = window.__messages[1].changes.find((c) => c.id === req.change_id);
      if (opts.refuse) throw Object.assign(new Error("It changed since, so this can't be undone here. Change it back in its Settings."), { code: "conflict" });
      change.status = "undone"; change.undone_at = at(5);
      return { change, pip: { ...pip, name: "Planner", current_version: 3 } };
    },
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m?.type !== "pipsRequest") return;
    window.__requests.push(m.request);
    const make = answers[m.request.type];
    let reply;
    try { reply = make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } : { type: "pipsReply", id: m.id, ok: false, error: "not offered here" }; }
    catch (error) { reply = { type: "pipsReply", id: m.id, ok: false, error: { code: error.code, message: error.message } }; }
    setTimeout(() => window.postMessage(reply, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: opts.api, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(PIP)}, ${JSON.stringify(opts)});`;
const theme = ":root{--vscode-editor-background:#181818;--vscode-foreground:#e2e2e2;--vscode-descriptionForeground:#a3a3a3;--vscode-input-background:#242424;--vscode-font-family:sans-serif}";

async function open(opts) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${theme}${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
    + `<script>${hostFor({ api: 77, change: JOB_CHANGE, ...opts })}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;
  const context = await browser.newContext({ viewport: { width: opts?.width || 360, height: 760 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: html, contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector(`[data-job="${PIP}"]`);
  await p.click(`[data-job="${PIP}"]`);
  await p.waitForSelector("#chatText");
  await p.waitForSelector(".own-change");
  return { p, errors, close: () => context.close() };
}

// The host passes only the Pips commands it knows: the page's Undo came back "Unknown Pips command." in the first live
// check, because the page's stand-in host above answers it directly.
const require = createRequire(import.meta.url);
const viewCode = (await build({ entryPoints: [new URL("../src/pipsView.ts", import.meta.url).pathname], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["vscode"], loader: { ".css": "empty" } })).outputFiles[0].text;
const viewModule = (() => { const m = { exports: {} }; new Function("module", "exports", "require", viewCode)(m, m.exports, (n) => n === "vscode" ? {} : require(n)); return m.exports; })();

// Every top-level await above is settled before the first test is registered (node:test runs tests registered before a
// pending top-level await, and the file then never ends).
test("each change it made shows after its reply, in words, with Undo and Details", () => {
  const html = messageMarkup({ id: "message_a", role: "assistant", text: "I'm Pitch now.", run_id: "run_a", changes: [JOB_CHANGE, ROUTINE_CHANGE] }, options);
  assert.match(html, /Pitch updated its job: name, instructions/);
  assert.match(html, /Pitch added a routine: Morning brief/);
  assert.match(html, new RegExp(`data-own-undo="${OWN}"`));
  assert.match(html, new RegExp(`data-own-undo="${ROUTINE}"`));
  assert.ok(html.indexOf("I'm Pitch now.") < html.indexOf("updated its job"), "after what it said");
  assert.match(html, /Instructions/);
  assert.match(html, /Write one-page sales sheets for Acme Notes/);
  assert.match(html, /every day at 08:00/);
});

// Its own schedule on any days, the way routines run (pips-07b, asked 10 Nov): "weekdays at 9" is the Pip's schedule,
// said in the same words on its page, in a routine and on the line of the change that set it.
test("a schedule on weekdays, weekends or named days is said in words on its page, in routines and on its change line", () => {
  const cron = (c) => ({ type: "cron", cron: c, timezone: "Asia/Kolkata", missed_policy: "coalesce_latest", dst_policy: "skip_gap_first_fold" });
  const cases = [
    ["0 9 * * 1-5", "Weekdays at 09:00", "on weekdays at 09:00"],
    ["0 10 * * 0,6", "Weekends at 10:00", "on weekends at 10:00"],
    ["0 10 * * 6,0", "Weekends at 10:00", "on weekends at 10:00"],
    ["0 8 * * 1,4", "Mondays and Thursdays at 08:00", "on Mondays and Thursdays at 08:00"],
    ["30 7 * * 1,3,5", "Mondays, Wednesdays and Fridays at 07:30", "on Mondays, Wednesdays and Fridays at 07:30"],
    ["0 9 * * 0,1", "Mondays and Sundays at 09:00", "on Mondays and Sundays at 09:00"],
    ["0 18 * * 5", "Fridays at 18:00", "on Fridays at 18:00"],
    ["0 9 * * 7", "Sundays at 09:00", "on Sundays at 09:00"],
    ["0 9 * * *", "Every day at 09:00", "every day at 09:00"],
    ["0 9 * * 0-6", "Every day at 09:00", "every day at 09:00"],
  ];
  for (const [c, page, line] of cases) {
    assert.equal(scheduleLabel(cron(c)), `${page} · Asia/Kolkata`, c);
    assert.equal(routineWhen({ kind: "schedule", schedule: cron(c) }), page, c);
    const html = messageMarkup({ id: "message_s", role: "assistant", text: "Done.", changes: [{ ...JOB_CHANGE, fields: ["schedule"],
      after: { by: "Pitch", schedule: cron(c) } }] }, options);
    assert.ok(html.includes(`${line} (Asia/Kolkata)`), `${c}: ${html.match(/<dd>[^<]*<\/dd>/g)}`);
  }
  // Anything else (several times a day, steps, a day of the month) stays the exact expression.
  for (const c of ["*/30 9-17 * * 1-5", "0 9,17 * * 1-5", "0 9 1 * *", "0 9 * * 1-5/2"]) {
    assert.equal(scheduleLabel(cron(c)), `Cron ${c} · Asia/Kolkata`, c);
    assert.equal(routineWhen({ kind: "schedule", schedule: cron(c) }), `On the schedule ${c}`, c);
  }
});

test("a line names the Pip as it was called then, not after a later rename", () => {
  const html = messageMarkup({ id: "message_e", role: "assistant", text: "Done.", changes: [{ ...JOB_CHANGE, fields: ["goal"],
    after: { goal: "Sales sheets", by: "Brief" } }] }, { ...options, name: "Acme Notes sales sheets" });
  assert.match(html, /Brief updated its job: instructions/);
});

test("an undone change says Undone, and with no Undo here (an older DGC, or Pips off) the line has no button", () => {
  const undone = messageMarkup({ id: "message_b", role: "assistant", text: "Done.", changes: [{ ...JOB_CHANGE, status: "undone" }] }, options);
  assert.match(undone, /Undone/);
  assert.doesNotMatch(undone, /data-own-undo/);
  const older = messageMarkup({ id: "message_c", role: "assistant", text: "Done.", changes: [JOB_CHANGE] }, { ...options, undo: false });
  assert.match(older, /updated its job/);
  assert.doesNotMatch(older, /data-own-undo/);
  assert.doesNotMatch(messageMarkup({ id: "message_d", role: "assistant", text: "Hi." }, options), /own-change/);
});

test("Undo puts it back: the request names the change, and the line says Undone", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({});
  try {
    const line = p.locator(".own-change").first();
    assert.match(await line.innerText(), /Pitch updated its job: name, instructions/);
    await line.locator("[data-own-details]").click();
    assert.match(await line.innerText(), /Instructions/);
    await line.locator(`[data-own-undo="${OWN}"]`).click();
    await p.waitForFunction(() => /Undone/.test(document.querySelector(".own-change")?.innerText || ""));
    const sent = await p.evaluate(() => window.__requests.filter((r) => r.type === "undo_pip_change"));
    assert.deepEqual(sent.map((r) => [r.pip_id, r.change_id]), [[PIP, OWN]]);
    assert.equal(await line.locator("[data-own-undo]").count(), 0, "no second Undo");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("Undo after a later change says why it can't, and the line keeps its Undo", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({ refuse: true });
  try {
    await p.locator(`[data-own-undo="${OWN}"]`).click();
    await p.waitForFunction(() => /changed since/.test(document.querySelector(".own-change")?.innerText || ""));
    assert.equal(await p.locator(".own-change [role=alert]").count(), 1, "said on the line itself, not at the top of the chat");
    assert.equal(await p.locator(`[data-own-undo="${OWN}"]`).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("/ at the start of the box offers /setup; choosing it puts /setup in the box", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({});
  try {
    await p.click("#chatText");
    await p.keyboard.type("/");
    await p.waitForFunction(() => getComputedStyle(document.getElementById("chat-pop")).display !== "none");
    const rows = await p.locator("#chat-pop .pi").allInnerTexts();
    assert.ok(rows.some((r) => /setup/.test(r) && /job/i.test(r)), rows.join(" | "));
    // As tall as its one row (asked 10 Nov): not the @ list's fixed 210 px with an empty space under /setup.
    const fit = await p.evaluate(() => { const pop = document.getElementById("chat-pop"), r = pop.getBoundingClientRect();
      const rows = [...pop.querySelectorAll(".pi")].map((x) => x.getBoundingClientRect());
      return { height: r.height, rows: rows.reduce((a, x) => a + x.height, 0) }; });
    assert.ok(fit.height <= fit.rows + 4, `the / list is ${fit.height}px for ${fit.rows}px of rows`);
    await p.keyboard.press("Enter");
    assert.equal(await p.evaluate(() => document.getElementById("chatText").innerText.replace(/ /g, " ")), "/setup ");
    await p.keyboard.type("Write sales sheets");
    assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById("chat-pop")).display), "none", "the list closes as the job is typed");
    // The @ list is as tall as its rows too (asked 12 Nov night: one match had a tall empty box under it), up to its
    // 210 px cap. It hangs over the conversation from the box's top edge, so the box never jumps as it narrows.
    await p.evaluate(() => { const box = document.getElementById("chatText"); box.focus(); document.execCommand("selectAll"); document.execCommand("delete"); });
    await p.keyboard.type("@");
    await p.waitForFunction(() => getComputedStyle(document.getElementById("chat-pop")).display !== "none");
    const at = await p.evaluate(() => { const pop = document.getElementById("chat-pop"), rows = [...pop.querySelectorAll(".pi")].reduce((a, r) => a + r.getBoundingClientRect().height, 0);
      return { height: pop.getBoundingClientRect().height, rows, box: document.getElementById("chatText").getBoundingClientRect().top, bottom: pop.getBoundingClientRect().bottom }; });
    assert.ok(at.height <= Math.min(210, at.rows + 4) + 0.5 && at.bottom <= at.box, `the @ list is ${at.height}px for ${at.rows}px of rows, above the box`);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("an older DGC (API 76): no Undo, no /setup", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open({ api: 76 });
  try {
    assert.equal(await p.locator("[data-own-undo]").count(), 0);
    await p.click("#chatText");
    await p.keyboard.type("/");
    await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById("chat-pop")).display), "none");
  } finally { await close(); }
});

test("the host sends Undo to DGC from API 77, and asks for an update before it", async () => {
  for (const api of [76, 77]) {
    const sent = [], posted = [];
    const editor = new viewModule.PipsEditor({}, (m) => { sent.push(m); return true; }, () => {});
    editor.attach((m) => posted.push(m));
    editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
    editor.receive({ type: "pipsRequest", id: "u", request: { type: "undo_pip_change", pip_id: PIP, change_id: OWN } });
    await new Promise((r) => setTimeout(r, 0));
    if (api < 77) {
      assert.equal(sent.length, 0, `API ${api}`);
      assert.match(posted.find((m) => m.id === "u")?.error?.message || "", /Update DGC/);
    } else {
      assert.equal(sent.at(-1)?.request?.type, "undo_pip_change", `API ${api}`);
      assert.equal(sent.at(-1).request.change_id, OWN);
    }
  }
});
