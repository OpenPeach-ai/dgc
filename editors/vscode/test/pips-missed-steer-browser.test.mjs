// A mid-turn message to a Pip that the reply never read, in real Chromium with the real client: it moves down
// and is answered with no mark of failure, waits above the box when others are ahead of it, and on Stop says it wasn't
// sent, comes back to an empty box and can be sent again.
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
const queueScript = (await import("node:fs")).readFileSync(new URL("../media/messagequeue.js", import.meta.url), "utf8");

const host = `(${function (PIP, opening) {
  const W = "ws_" + "p".repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = { id: PIP, workspace_id: W, pip_type: "lens", name: "Planner", goal: "Help.", source_policy: { mode: "personal" }, source_ref: "HEAD",
    status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null, proposals: [], pending_review_count: 0 };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576,
    effective_context_size: 8192, context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const base = { pip_id: PIP, workspace_id: W, model: "", created_at: "2026-11-06T08:00:00Z" };
  window.__msg = (id, role, text, run_id, status, extra = {}) => ({ ...base, id, role, text, run_id, status, ...extra });
  window.__page = opening(window.__msg);
  window.__sent = [];
  window.__sendReply = null;
  const nativeInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => { if (ms === 4000) window.__pipPoll = fn; return nativeInterval(fn, ms, ...args); };
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: W, name: "Personal", kind: "personal" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip], total: 1, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: W, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => (window.__lists = (window.__lists || 0) + 1, { pip_id: PIP, workspace_id: W, next_before_id: null, history_context_omitted_count: 0, chat_controls: controls, ...window.__page }),
    list_pip_run_posts: () => ({ pip_id: PIP, workspace_id: W, posts: [], next_before_id: null }),
    list_pip_reply_stats: () => ({ pip_id: PIP, stats: [] }),
    list_pip_apps: () => ({ apps: [] }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }),
    get_pip_chat_stream: () => ({ run_id: "r", cursor: 0, text: "", done: false, events: [] }),
    send_pip_message: (req) => { window.__sent.push(req.text); (window.__reqs ||= []).push(req); window.__afterSend?.(req); return { message: window.__msg("sent" + window.__sent.length, "user", req.text, "run_x", "queued"), run: { id: "run_x", pip_id: PIP, status: "queued" } }; },
  };
  window.acquireVsCodeApi = () => ({ getState: () => (window.__savedQueue ? { workspace_id: W, selected: window.__savedQueue.pipId, chat_queues: { [window.__savedQueue.pipId]: [window.__savedQueue.queue] } } : undefined), setState() {}, postMessage(m) {
    if (m?.type === "copy") { window.__copied = m.text; return; }
    if (m?.type !== "pipsRequest") return;
    const make = answers[m.request.type];
    setTimeout(() => window.postMessage(make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) }
      : { type: "pipsReply", id: m.id, ok: false, error: "not offered here" }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 74, generation: 1, connected: true, supported: true, enabled: true, displayMentions: true }, "*"), 5);
}})(${JSON.stringify(PIP)}, __OPENING__);`;
const running = (msg) => ({ messages: [msg("u1", "user", "Write the summary", "run_1", "running"),
  msg("s1", "user", "One more thing", "run_1", "queued", { steered: true, steer_status: "pending" })],
active_run: { id: "run_1", status: "running", run_kind: "conversation" }, waiting: [] });
const pageFor = (opening) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
  + `<script>${queueScript}</script><script>${host.replace("__OPENING__", opening.toString())}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

async function open(opening = running, saved = null) {
  const context = await browser.newContext({ viewport: { width: 640, height: 800 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  if (saved) await p.addInitScript((q) => { window.__savedQueue = q; }, saved);
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: pageFor(opening), contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  if (!saved) {     // a saved view opens on its Pip
    await p.waitForSelector(`[data-job="${PIP}"]`);
    await p.click(`[data-job="${PIP}"]`);
  }
  await p.waitForSelector("#chatText");
  await p.waitForSelector(".pip-message");
  return { p, errors, context };
}
const boxValue = (p) => p.evaluate(() => document.getElementById("chatText").value);
const log = (p) => p.evaluate(() => [...document.querySelectorAll(".conversation-log .pip-message:not(.provisional)")].map((m) => (m.querySelector(".prompt-text, .message-body")?.textContent || "").trim()));
const article = (p, id) => p.locator(`.pip-message[data-message="${id}"]`);
// A change on the server, then the view's own poll until it has read the page twice: the first read was drawn by the second.
const seen = async (p, from) => { await p.waitForFunction((n) => { if (window.__lists >= n + 2) return true; window.__pipPoll(); return false; }, from, { polling: 50 }); await p.waitForTimeout(40); };
const poll = async (p, change) => seen(p, await p.evaluate(`(() => { (${change.toString()})(window.__msg); return window.__lists; })()`));
const stopped = (msg) => { window.__page = { messages: [msg("u1", "user", "Write the summary", "run_1", "cancelled"),
  msg("s1", "user", "One more thing", "run_1", "failed", { steered: true, steer_status: "missed", error: "Stopped before the Pip read this." })], active_run: null, waiting: [] }; };

test("a message the reply never read moves below that reply as its own turn, with no mark of failure", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open();
  assert.deepEqual(await log(p), ["Write the summary", "One more thing"]);
  assert.doesNotMatch(await article(p, "s1").innerText(), /Steered/, "it isn't Steered until the model has read it");
  await poll(p, (msg) => { window.__page = { messages: [msg("u1", "user", "Write the summary", "run_1", "succeeded"), msg("a1", "assistant", "Here is the summary.", "run_1", "succeeded"),
    msg("s1", "user", "One more thing", "run_2", "queued")], active_run: { id: "run_2", status: "queued", run_kind: "conversation" }, waiting: [] }; });
  assert.deepEqual(await log(p), ["Write the summary", "Here is the summary.", "One more thing"], "the chat follows the page, not where the bubble was");
  assert.doesNotMatch(await article(p, "s1").innerText(), /Failed|Not sent|Steered/);
  assert.equal(await p.locator(".message-send-again").count(), 0);
  await poll(p, (msg) => { window.__page = { messages: [...window.__page.messages.slice(0, 2), msg("s1", "user", "One more thing", "run_2", "succeeded"), msg("a2", "assistant", "About that.", "run_2", "succeeded")], active_run: null, waiting: [] }; });
  assert.deepEqual(await log(p), ["Write the summary", "Here is the summary.", "One more thing", "About that."]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("once the model has read it, it says Steered before its time", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await open();
  await poll(p, (msg) => { window.__page.messages[1] = msg("s1", "user", "One more thing", "run_1", "running", { steered: true, steer_status: "applied" }); });
  assert.match(await article(p, "s1").locator(".msg-time").innerText(), /^Steered · /);
  await context.close();
});

test("others waiting behind it sit above the box in order, not in the transcript, and only show and copy", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open();
  await p.fill("#chatText", "mine, queued here");
  await p.press("#chatText", "Alt+Enter");
  await poll(p, (msg) => { window.__page = { messages: [msg("u1", "user", "Write the summary", "run_1", "succeeded"), msg("a1", "assistant", "Here is the summary.", "run_1", "succeeded"),
    msg("s1", "user", "One more thing", "run_2", "running")], active_run: { id: "run_2", status: "running", run_kind: "conversation" },
  waiting: [{ id: "s2", text: "Second thing", created_at: "2026-11-06T08:00:01Z" }, { id: "s3", text: "Third\nthing", created_at: "2026-11-06T08:00:02Z" }] }; });
  assert.deepEqual(await p.locator("#chat-queue .dgc-queue-text").allTextContents(), ["Second thing", "Third thing", "mine, queued here"]);
  assert.equal(await p.locator(".chat-queue-head").textContent(), "3 queued messages");
  assert.deepEqual(await log(p), ["Write the summary", "Here is the summary.", "One more thing"]);
  const held = p.locator("#chat-queue .dgc-queue-row").first();
  assert.equal(await held.locator("[data-queue-role='steer'], [data-queue-role='remove'], [data-queue-role='handle']").count(), 0, "DGC holds this one");
  assert.equal(await p.locator("#chat-queue .dgc-queue-row").nth(2).locator("[data-queue-role='remove']").count(), 1, "the one queued here stays this view's");
  await p.locator("#chat-queue .dgc-queue-row").nth(1).locator(".dgc-queue-more").click();
  await p.getByRole("menuitem", { name: "Copy message" }).click();
  assert.equal(await p.evaluate(() => window.__copied), "Third\nthing", "its words as sent");
  assert.deepEqual(await p.evaluate(() => window.__sent), [], "this view sends nothing while DGC still holds messages");
  // The reply and DGC's queue end: only then this view's own queued message goes.
  await poll(p, (msg) => { window.__page = { messages: window.__page.messages, active_run: { id: "run_2", status: "running", run_kind: "conversation" }, waiting: [{ id: "s3", text: "Third\nthing", created_at: "2026-11-06T08:00:02Z" }] }; });
  assert.equal(await p.locator(".chat-queue-head").textContent(), "2 queued messages");
  await poll(p, () => { window.__page = { messages: window.__page.messages.map((m) => ({ ...m, status: "succeeded" })), active_run: null, waiting: [{ id: "s3", text: "Third\nthing", created_at: "2026-11-06T08:00:02Z" }] }; });
  assert.deepEqual(await p.evaluate(() => window.__sent), [], "still held: its turn is about to start");
  await poll(p, () => { window.__page = { ...window.__page, waiting: [] }; });
  await p.waitForFunction(() => window.__sent.length === 1);
  assert.deepEqual(await p.evaluate(() => window.__sent), ["mine, queued here"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("on Stop it says it wasn't sent in plain words, comes back to an empty box, and Send again sends it", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open();
  await poll(p, stopped);
  const said = await article(p, "s1").locator(".message-status").innerText();
  assert.match(said, /^Not sent · Stopped before the Pip read this\. Send again$/);
  assert.doesNotMatch(said, /Failed/);
  assert.equal(await boxValue(p), "One more thing", "back in the box, as in Work");
  await p.fill("#chatText", "");
  // Sending again does not touch the box, and the row goes once the server replaces it.
  await p.fill("#chatText", "typing something else");
  await p.evaluate(() => { window.__afterSend = () => { window.__page = { ...window.__page, messages: [window.__page.messages[0], window.__msg("n1", "user", "One more thing", "run_3", "queued")], active_run: { id: "run_3", status: "queued", run_kind: "conversation" } }; }; });
  await article(p, "s1").locator(".message-send-again").click();
  await p.waitForFunction(() => window.__sent.length === 1);
  assert.deepEqual(await p.evaluate(() => window.__sent), ["One more thing"]);
  await p.waitForFunction(() => !document.querySelector('.pip-message[data-message="s1"]'));
  assert.equal(await boxValue(p), "typing something else", "what you were typing stays");
  assert.deepEqual(await log(p), ["Write the summary", "One more thing"], "one message, not a sent one beside an unsent one");
  assert.deepEqual(errors, []);
  await context.close();
});

test("Send again with the same words back in the box sends once and clears the box", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open();
  await poll(p, stopped);
  assert.equal(await boxValue(p), "One more thing");
  await p.evaluate(() => { window.__afterSend = () => { window.__page = { ...window.__page, messages: [window.__page.messages[0], window.__msg("n1", "user", "One more thing", "run_3", "queued")], active_run: { id: "run_3", status: "queued", run_kind: "conversation" } }; }; });
  await article(p, "s1").locator(".message-send-again").click();
  await p.waitForFunction(() => window.__sent.length === 1);
  await p.waitForFunction(() => !document.querySelector('.pip-message[data-message="s1"]'));
  assert.equal(await boxValue(p), "", "not left there to be sent twice");
  assert.deepEqual(await p.evaluate(() => window.__sent), ["One more thing"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("on Stop with something already in the box, the box is left alone", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await open();
  await p.fill("#chatText", "my next thought");
  await poll(p, stopped);
  assert.equal(await boxValue(p), "my next thought");
  assert.equal(await article(p, "s1").locator(".message-send-again").count(), 1);
  await context.close();
});

test("after a reload it still says Not sent with Send again, and the box stays empty", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await open((msg) => ({ messages: [msg("u1", "user", "Write the summary", "run_1", "cancelled"),
    msg("s1", "user", "One more thing", "run_1", "failed", { steered: true, steer_status: "missed", error: "Stopped before the Pip read this." })], active_run: null, waiting: [] }));
  assert.match(await article(p, "s1").locator(".message-status").innerText(), /^Not sent/);
  assert.equal(await boxValue(p), "", "only as it happens, never on a reload");
  await context.close();
});

test("a message the reply read before it failed has no answer, and offers Send again too", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await open((msg) => ({ messages: [msg("u1", "user", "Write the summary", "run_1", "failed"),
    msg("s1", "user", "One more thing", "run_1", "failed", { steered: true, steer_status: "applied" })], active_run: null, waiting: [] }));
  assert.match(await article(p, "s1").locator(".message-status").innerText(), /^Failed · No reply/);
  assert.equal(await article(p, "s1").locator(".message-send-again").count(), 1);
  assert.equal(await article(p, "u1").locator(".message-send-again").count(), 0, "the first message has its own way back");
  await context.close();
});

// The @ marks of a message stay with it (media/mentions.js): a plugin that is in the words, and a Pip named by its name.
const WORDS = "Ask Aave and Scout about it";
const MARKS = [{ start: 4, kind: "plugin", label: "Aave", identity: "aave" }, { start: 13, kind: "pip", label: "Scout", identity: "pip_" + "b".repeat(32), pip_type: "lens", wired: true }];
const markedRunning = `(msg) => ({ messages: [msg("u1", "user", "Write the summary", "run_1", "running"),
  msg("s1", "user", ${JSON.stringify(WORDS)}, "run_1", "queued", { steered: true, steer_status: "pending", display_mentions: ${JSON.stringify(MARKS)} })],
active_run: { id: "run_1", status: "running", run_kind: "conversation" }, waiting: [] })`;
const markedStopped = `(msg) => { window.__page = { messages: [msg("u1", "user", "Write the summary", "run_1", "cancelled"),
  msg("s1", "user", ${JSON.stringify(WORDS)}, "run_1", "failed", { steered: true, steer_status: "missed", error: "Stopped before the Pip read this.", display_mentions: ${JSON.stringify(MARKS)} })], active_run: null, waiting: [] }; }`;
const pills = (p) => p.evaluate(() => [...document.querySelectorAll("#chatText [data-pill]")].map((n) => [n.dataset.kind, n.textContent.trim()]));
const bubblePills = (p, id) => article(p, id).locator(".sent-mention").allInnerTexts();

test("a message given back on Stop comes back with its @ marks, and sending it from the box sends them", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open(markedRunning);
  assert.equal((await bubblePills(p, "s1")).length, 2, "its bubble has them while it waits to be read");
  await poll(p, markedStopped);
  await p.waitForFunction((w) => document.getElementById("chatText").value === w, WORDS);
  assert.deepEqual((await pills(p)).map(([kind]) => kind), ["plugin", "pip"], "marks in the box, where they were");
  assert.equal(await boxValue(p), WORDS, "the same words");
  assert.equal((await bubblePills(p, "s1")).length, 2, "and in the Not sent bubble");
  await p.focus("#chatText"); await p.press("#chatText", "Enter");
  await p.waitForFunction(() => window.__sent.length === 1);
  const [sent] = await p.evaluate(() => window.__reqs);
  assert.equal(sent.text, WORDS);
  assert.deepEqual(sent.display_mentions, MARKS, "the marks went with it, exactly");
  assert.deepEqual(errors, []);
  await context.close();
});

test("Send again sends the message's @ marks, and its bubble shows them while it goes", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open(markedRunning);
  await p.fill("#chatText", "typing something else");
  await poll(p, markedStopped);
  await article(p, "s1").locator(".message-send-again").waitFor();
  assert.equal(await boxValue(p), "typing something else");
  await p.evaluate((marks) => { window.__afterSend = () => { window.__page = { ...window.__page, messages: [window.__page.messages[0], window.__msg("n1", "user", window.__reqs[0].text, "run_3", "queued", { display_mentions: marks })], active_run: { id: "run_3", status: "queued", run_kind: "conversation" } }; }; }, MARKS);
  await article(p, "s1").locator(".message-send-again").click();
  await p.waitForFunction(() => window.__sent.length === 1);
  assert.deepEqual((await p.evaluate(() => window.__reqs))[0].display_mentions, MARKS);
  await p.waitForFunction(() => document.querySelector('.pip-message[data-message="n1"]'));
  assert.equal((await bubblePills(p, "n1")).length, 2, "the re-sent bubble keeps them");
  assert.equal(await boxValue(p), "typing something else", "what you were typing stays");
  assert.deepEqual(errors, []);
  await context.close();
});

test("a message that becomes its own turn keeps its @ marks in its bubble", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open(markedRunning);
  await p.evaluate((a) => { const [words, marks] = a; window.__page = { messages: [window.__msg("u1", "user", "Write the summary", "run_1", "succeeded"), window.__msg("a1", "assistant", "Summary.", "run_1", "succeeded"),
    window.__msg("s1", "user", words, "run_2", "queued", { display_mentions: marks })], active_run: { id: "run_2", status: "queued", run_kind: "conversation" }, waiting: [] }; window.__pipPoll(); }, [WORDS, MARKS]);
  await p.waitForFunction(() => document.querySelector(".pip-message.assistant"));
  await p.waitForTimeout(60);
  assert.deepEqual(await log(p), ["Write the summary", "Summary.", WORDS]);
  assert.equal((await bubblePills(p, "s1")).length, 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test("a message queued above the box and given back on Stop comes back with its @ marks too", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, context } = await open(markedRunning, { queue: { id: "q1", text: WORDS, marks: MARKS }, pipId: PIP });
  assert.deepEqual(await p.locator("#chat-queue .dgc-queue-text").allTextContents(), [WORDS]);
  await p.evaluate(() => { window.__page = { messages: [window.__msg("u1", "user", "Write the summary", "run_1", "cancelled")], active_run: null, waiting: [] }; window.__pipPoll(); });
  await p.waitForFunction((w) => document.getElementById("chatText").value === w, WORDS);
  assert.deepEqual((await pills(p)).map(([kind]) => kind), ["plugin", "pip"]);
  assert.deepEqual(await p.locator("#chat-queue .dgc-queue-text").allTextContents(), []);
  assert.deepEqual(errors, []);
  await context.close();
});
