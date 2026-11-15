// A Pip's chat reads like a person working (0.52, 15 Nov; Pips API 99, tests/test_pip_steer_order.py): a message sent
// while the Pip works sits where it was read. A finished reply that read messages on the way (`steers`: [{id, at}]) is
// drawn in pieces with each message between them, never again at its own time; while the Pip works, a message sent now
// drops in under what is on screen and the live words carry on below it; the live words are the finished reply's own
// bubble and type, so nothing jumps when it finishes. The side bar's real page with the real Pips view, in Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const RUN = "run_" + "7".repeat(32);
const ONE = "I read the notes and started the summary.", TWO = "The shorter title is in. Now the totals.", THREE = "Done: the summary has the shorter title and no totals table.";
const WHOLE = [ONE, TWO, THREE].join("\n\n");
const asked = (status = "succeeded") => ({ id: "u1", role: "user", text: "Write the summary", run_id: RUN, status });
const late = (id, text, more = {}) => ({ id, role: "user", text, run_id: RUN, status: "succeeded", steered: true, steer_status: "applied", ...more });
const reply = (more = {}) => ({ id: "a1", role: "assistant", text: WHOLE, run_id: RUN, status: "succeeded", ...more });
const done = (more = {}) => ({ messages: [asked(), late("s1", "Use the shorter title"), late("s2", "Leave the totals table out"), reply(more)], active_run: null });
const STEERS = { steers: [{ id: "s1", at: ONE.length }, { id: "s2", at: ONE.length + 2 + TWO.length }] };
const working = (messages = [asked("running")]) => ({ messages, active_run: { id: RUN, status: "running", run_kind: "conversation", started_at: new Date().toISOString() } });
const words = (text) => ({ event_type: "pip_run_progress", payload: { kind: "text_delta", text } });
const doing = (message) => ({ event_type: "pip_run_progress", payload: { kind: "progress", state: "tool", message } });

/** What the chat says, top to bottom: each message of yours and each piece of the Pip's words, as drawn. */
const said = (x) => x.inPips((root) => [...root.querySelectorAll(".conversation-log .pip-message.user .prompt-text, .conversation-log .pip-message.assistant .message-body")]
  .filter((n) => n.checkVisibility()).map((n) => `${n.closest(".pip-message").classList.contains("user") ? "you" : "pip"}: ${n.textContent.trim()}`));
const open = async (scene, more = {}) => { const x = await openOnePips(browser, { api: 99, width: 440, height: 820, scene, ...more }); x.page.setDefaultTimeout(6000); await x.openPip(GST); await x.waitIn(".conversation-log .pip-message"); return x; };
const change = (x, fn, arg) => x.page.evaluate(([f, a]) => { (0, eval)(`(${f})`)(window.__backend.state, a); }, [fn.toString(), arg]);
const until = (x, fn, arg) => x.page.waitForFunction(([f, a]) => (0, eval)(`(${f})`)(document.getElementById("pips-host").shadowRoot, a), [fn.toString(), arg], { polling: 50 });

test("a finished reply that read two messages on the way is drawn in pieces, each message where it was read, and none twice", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ chat: { [GST]: done(STEERS) } });
  try {
    assert.deepEqual(await said(x), ["you: Write the summary", `pip: ${ONE}`, "you: Use the shorter title", `pip: ${TWO}`, "you: Leave the totals table out", `pip: ${THREE}`]);
    const seen = await x.inPips((root) => ({ late: [...root.querySelectorAll('.pip-message[data-message="s1"], .pip-message[data-message="s2"]')].length,
      quotes: root.querySelectorAll(".conversation-log .msg-quote").length, actions: root.querySelectorAll(".conversation-log .pip-message.assistant .response-actions").length,
      copies: root.querySelectorAll('.conversation-log [data-chat-action="copy"][data-message-id="a1"]').length, did: root.querySelectorAll('.conversation-log [data-chat-activity]').length,
      heads: root.querySelectorAll(".conversation-log .pip-message.assistant .run-post-head").length, ticks: [...root.querySelectorAll('.pip-message[data-message="s1"] .msg-read')].map((n) => n.dataset.read),
      turns: root.querySelectorAll(".conversation-log .pip-turn").length }));
    assert.equal(seen.late, 2, "each message it read is drawn once");
    assert.equal(seen.quotes, 0, "no ↪ quote of a message that is shown where it was read");
    assert.equal(seen.actions, 1, "one reply: one row of its actions, under its last words");
    assert.equal(seen.copies, 1, "Copy copies the one reply");
    assert.equal(seen.did, 1, "What it did is one click away, once");
    assert.equal(seen.heads, 1, "its face and name once, over its first words");
    assert.deepEqual(seen.ticks, ["read"], "a message it read keeps its tick");
    assert.equal(seen.turns, 1, "all of it is the one turn you started");
    // In order on the page too, not only in the markup: each sits under the one before.
    const tops = await x.inPips((root) => [...root.querySelectorAll(".conversation-log .pip-message.user .prompt-text, .conversation-log .pip-message.assistant .message-body")].map((n) => n.getBoundingClientRect().top));
    for (let i = 1; i < tops.length; i++) assert.ok(tops[i] > tops[i - 1], `piece ${i} is under piece ${i - 1}`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("where a message sits is counted as DGC counts it, in characters, so a reply with emoji breaks at the right place", async (t) => {
  if (skipOrFail(t)) return;
  const first = "Started 🙂🙂 on it.", text = `${first}\n\nAnd done.`;
  const x = await open({ chat: { [GST]: { messages: [asked(), late("s1", "Use the shorter title"), reply({ text, steers: [{ id: "s1", at: [...first].length }] })], active_run: null } } });
  try {
    assert.deepEqual(await said(x), ["you: Write the summary", `pip: ${first}`, "you: Use the shorter title", "pip: And done."]);
  } finally { await x.close(); }
});

test("an older reply with no steers is drawn as before: each message at its own time, the reply whole", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ chat: { [GST]: done() } });
  try {
    assert.deepEqual(await said(x), ["you: Write the summary", "you: Use the shorter title", "you: Leave the totals table out", `pip: ${ONE}\n${TWO}\n${THREE}`]);
    assert.equal(await x.inPips((root) => root.querySelectorAll(".conversation-log .pip-message.assistant").length), 1);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a bad list of steers never costs the chat: the reply is whole and each message is at its own time", async (t) => {
  if (skipOrFail(t)) return;
  for (const steers of [[{ id: "s1", at: 9999 }], [{ id: "s1", at: -1 }], "x", [{ id: "s2", at: 30 }, { id: "s1", at: 4 }], [{ id: "nobody", at: 5 }], [{ id: "u1", at: 5 }]]) {
    const x = await open({ chat: { [GST]: done({ steers }) } });
    try {
      assert.deepEqual(await said(x), ["you: Write the summary", "you: Use the shorter title", "you: Leave the totals table out", `pip: ${ONE}\n${TWO}\n${THREE}`], JSON.stringify(steers));
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("while the Pip works, a message sent now drops in under what is on screen, the words carry on below it, and nothing jumps when it finishes", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ chat: { [GST]: working() }, activity: { [RUN]: [words(ONE), doing("Reading the notes")] } });
  try {
    await until(x, (root, one) => [...root.querySelectorAll(".conversation-log .pip-message.assistant .message-body")].some((n) => n.textContent.trim() === one), ONE);
    // The live words are the finished reply's own bubble and type: the same classes, no preview look.
    const live = await x.inPips((root) => { const a = root.querySelector(".conversation-log .pip-message.assistant"), b = a.querySelector(".message-body"), s = getComputedStyle(b);
      return { article: a.className, body: b.className, text: root.querySelector(".conversation-log").textContent, type: [s.fontSize, s.lineHeight, s.color, s.fontFamily].join("|"), did: !!a.querySelector("[data-chat-activity]"), head: !!a.querySelector(".run-post-head") }; });
    assert.match(live.article, /\bmsg\b/); assert.match(live.article, /\bassistant\b/); assert.match(live.article, /\bdgc\b/);
    assert.doesNotMatch(live.article, /provisional/, "no preview look");
    assert.match(live.body, /\bfinal\b/, "the finished reply's own type");
    assert.doesNotMatch(live.text, /Still writing/);
    assert.ok(live.did, "What it did is one click away while it works too");
    assert.ok(live.head, "its face and name are over its words already");
    // The working row under the words says what it is doing in plain words.
    const row = await x.inPips((root) => { const w = root.querySelector(".conversation-log .pip-working"), last = [...root.querySelectorAll(".conversation-log .pip-message.assistant .message-body")].at(-1);
      return w ? { words: w.textContent, under: w.getBoundingClientRect().top >= last.getBoundingClientRect().bottom - 1 } : null; });
    assert.ok(row, "the working row is there");
    assert.match(row.words, /Reading the notes/); assert.ok(row.under, "under its words");
    assert.doesNotMatch(row.words, /read_file|tool_call|_/, "never a tool's name");

    await x.page.locator("#chatText").fill("Use the shorter title");
    await x.page.locator("#chatText").press("Enter");
    await until(x, (root) => [...root.querySelectorAll(".conversation-log .pip-message.user .prompt-text")].some((n) => n.textContent.trim() === "Use the shorter title"));
    assert.deepEqual(await said(x), ["you: Write the summary", `pip: ${ONE}`, "you: Use the shorter title"], "right under what is on screen so far");
    await change(x, (state, a) => { state.activity[a.run].push(a.more); }, { run: RUN, more: words(`\n\n${TWO}`) });
    await until(x, (root, two) => [...root.querySelectorAll(".conversation-log .pip-message.assistant .message-body")].some((n) => n.textContent.trim() === two), TWO);
    assert.deepEqual(await said(x), ["you: Write the summary", `pip: ${ONE}`, "you: Use the shorter title", `pip: ${TWO}`], "the live words carry on below it");
    assert.equal(await x.inPips((root) => root.querySelectorAll(".conversation-log .pip-working").length), 1, "one working row, at the end");

    // It finishes: its `steers` decide, and here they agree with what was on screen, so nothing moves.
    const places = () => x.inPips((root) => { const log = root.querySelector(".conversation-log"), first = root.querySelector(".conversation-log .pip-message.user .prompt-text").getBoundingClientRect().top;
      return [...log.querySelectorAll(".pip-message.user .prompt-text, .pip-message.assistant .message-body")].map((n) => Math.round(n.getBoundingClientRect().top - first)); });
    const before = await places();
    const id = await x.page.evaluate(() => window.__backend.state.sent[0].id);
    await change(x, (state, a) => { state.chat[a.pip] = { messages: [a.asked, { ...a.late, id: a.id }, { ...a.reply, text: a.text, steers: [{ id: a.id, at: a.at }] }], active_run: null }; state.activity[a.run].push({ event_type: "pip_run_succeeded" }); },
      { pip: GST, run: RUN, id, asked: asked(), late: late("x", "Use the shorter title"), reply: reply(), text: `${ONE}\n\n${TWO}`, at: ONE.length });
    await until(x, (root) => !!root.querySelector('.conversation-log .pip-message.assistant .response-actions [data-chat-action="copy"]'));
    assert.deepEqual(await said(x), ["you: Write the summary", `pip: ${ONE}`, "you: Use the shorter title", `pip: ${TWO}`]);
    assert.deepEqual(await places(), before, "every piece is where it was while it was being written");
    assert.equal(await x.inPips((root) => root.querySelectorAll(".conversation-log .pip-working").length), 0);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a message already waiting when the chat opens sits under the words written so far, and what comes next goes below it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ chat: { [GST]: working([asked("running"), late("s1", "Use the shorter title", { status: "queued", steer_status: "pending" })]) }, activity: { [RUN]: [words(ONE)] } });
  try {
    await until(x, (root, one) => [...root.querySelectorAll(".conversation-log .pip-message.assistant .message-body")].some((n) => n.textContent.trim() === one), ONE);
    assert.deepEqual(await said(x), ["you: Write the summary", `pip: ${ONE}`, "you: Use the shorter title"]);
    assert.equal(await x.inPips((root) => root.querySelector('.pip-message[data-message="s1"] .msg-read')?.dataset.read), "waiting", "its quiet clock until the Pip has read it");
    await change(x, (state, a) => { state.activity[a.run].push(a.more); }, { run: RUN, more: words(`\n\n${TWO}`) });
    await until(x, (root, two) => [...root.querySelectorAll(".conversation-log .pip-message.assistant .message-body")].some((n) => n.textContent.trim() === two), TWO);
    assert.deepEqual(await said(x), ["you: Write the summary", `pip: ${ONE}`, "you: Use the shorter title", `pip: ${TWO}`]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a message the reply never read is not put in it: it keeps today's line, Not sent", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ chat: { [GST]: { messages: [asked("cancelled"), late("s1", "Use the shorter title", { status: "failed", steer_status: "missed", error: "Stopped before the Pip read this." })], active_run: null } } });
  try {
    assert.deepEqual(await said(x), ["you: Write the summary", "you: Use the shorter title"]);
    assert.match(await x.inPips((root) => root.querySelector('.pip-message[data-message="s1"] .message-status').textContent), /^Not sent/);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
