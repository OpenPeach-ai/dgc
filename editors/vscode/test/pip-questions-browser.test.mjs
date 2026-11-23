// A question card in a Pip's chat, as Work has it (Pips API 106; decided 18 Nov: "it can instead propose questions
// which user can just select and submit"), in real Chromium with the real client and its CSS (test/support/pip-chat-scene.mjs,
// opts.questions), in the side bar (a shadow root in Work's page) and in its tab:
// - the card under the reply that asked is Work's own (media/shared/askcard.js and askcard.css): its rows, the
//   recommended one badged and preselected, multi-select, "Something else", Next / Submit, the pager, the keys;
// - its look reaches the shadow root, and it fits 300, 440 and 700 px in both themes;
// - Submit sends the answers (answer_pip_questions), then the card shows what was chosen, and the answer is your next
//   message; Dismiss closes it with nothing sent; a refusal says why and the card can be answered again;
// - where you were on it survives a redraw; an older DGC is never told this view draws the card.
// DGC_PIP_QUESTIONS_PICTURES=<folder> also writes the pictures.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { openChat } from "./support/pip-chat-scene.mjs";
import { messageMarkup, questionCard } from "../src/pipsTranscript.js";

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const REPLY = "message_" + "a".repeat(32);
const QUESTIONS = [
  { id: "storage", header: "Storage", question: "Which storage backend should settings sync use?", multi_select: false, options: [
    { label: "SQLite file", description: "One local file with transactions; nothing extra to run.", recommended: true },
    { label: "JSON on disk", description: "Easy to read by hand; no safe concurrent writes.", recommended: false },
    { label: "Postgres table", description: "Reuses the app database; adds a network dependency.", recommended: false }] },
  { id: "extras", header: "Extras", question: "Which extras ship in the first version?", multi_select: true, options: [
    { label: "Conflict prompt", description: "Ask when two machines edited the same key.", recommended: true },
    { label: "Sync history", description: "Keep the last 20 versions of each key.", recommended: false },
    { label: "Export button", description: "Download all settings as one JSON file.", recommended: false }] }];
const asked = (state = "open", answers = {}) => [
  { role: "user", text: "Plan settings sync. Propose me options with your suggestion." },
  { role: "assistant", text: "Two things decide how I build it.", more: { id: REPLY, questions: { questions: QUESTIONS, state, answers } } }];
// (What a chat at API 106 reads besides, each with nothing to show, so the chat draws no line about it.)
const W = "ws_" + "e".repeat(32), PIP = "pip_" + "9".repeat(32);
const stubs = { get_pip_goal: { pip_id: PIP, goal: null }, list_pip_project_changes: { pip_id: PIP, changes: [] },
  list_pip_fixes: { pip_id: PIP, workspace_id: W, fixes: [] }, list_pip_keys: { pip_id: PIP, keys: [] },
  list_pip_unread: { workspace_id: W, total: 0, pips: [] } };
const open = (opts = {}) => openChat(browser, { width: 440, height: 860, api: 106, questions: true, said: asked(), stubs, ...opts });
const inPage = (p, fn, arg) => p.evaluate(([code, a]) => new Function("root", "arg", `return (${code})(root, arg)`)(window.__pipsRoot || document, a), [fn.toString(), arg]);
const card = `.pip-message[data-message="${REPLY}"] .msg-questions`;
const click = (p, selector, n = 0) => inPage(p, (root, [s, i]) => root.querySelectorAll(s)[i].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })), [selector, n]);
const answered = (p) => p.evaluate(() => window.__answered || []);
const sent = (p) => p.evaluate(() => (window.__sent || []).filter((r) => r.type === "send_pip_message"));
const until = (p, fn, arg) => p.waitForFunction(([code, a]) => new Function("root", "arg", `return (${code})(root, arg)`)(window.__pipsRoot || document, a), [fn.toString(), arg]);

test("the markup: a slot under a reply that asked, kept through redraws; none for a user message or a malformed card", () => {
  const base = { pip_id: "p", workspace_id: "w", run_id: "r", model: "", created_at: "2026-11-18T08:00:00Z", status: "succeeded" };
  const draw = (m) => messageMarkup({ ...base, ...m }, { name: "Mornings", formatDate: String, renderMarkdown: (t) => t, canSend: true });
  const html = draw({ id: REPLY, role: "assistant", text: "Two things.", questions: { questions: QUESTIONS, state: "open", answers: {} } });
  assert.match(html, new RegExp(`<div class="msg-questions" id="pip-questions-${REPLY}" data-pip-questions="${REPLY}" data-dom-own="1"></div>`));
  assert.doesNotMatch(draw({ id: REPLY, role: "user", text: "Hi", questions: { questions: QUESTIONS, state: "open" } }), /msg-questions/);
  for (const bad of [{ questions: QUESTIONS, state: "maybe" }, { questions: "x", state: "open" }, null, "open"])
    assert.doesNotMatch(draw({ id: REPLY, role: "assistant", text: "x", questions: bad }), /msg-questions/, JSON.stringify(bad));
  assert.doesNotMatch(draw({ id: "m2", role: "assistant", text: "x", questions: { questions: QUESTIONS, state: "open" } }), /msg-questions/, "only DGC's own message ids");
  assert.deepEqual(questionCard({ id: REPLY, role: "assistant", questions: { questions: QUESTIONS, state: "answered", answers: { storage: { selected: [0] } } } }),
    { questions: QUESTIONS, state: "answered", answers: { storage: { selected: [0] } } });
});

test("Work's card under the reply, its look inside the side bar's shadow root, at 300, 440 and 700 px in both themes", async (t) => {
  if (skipOrFail(t)) return;
  const pictures = process.env.DGC_PIP_QUESTIONS_PICTURES;
  if (pictures) mkdirSync(pictures, { recursive: true });
  for (const [where, width] of [["side", 300], ["side", 440], ["tab", 700]]) for (const theme of ["dark", "light"]) {
    const x = await open({ where, width, theme });
    try {
      await x.p.waitForSelector(`${card} .ask .ask-opt`);
      const seen = await inPage(x.p, (root, sel) => {
        const slot = root.querySelector(sel), ask = slot.querySelector(".ask"), rows = [...ask.querySelectorAll(".ask-opt")];
        const style = (el) => getComputedStyle(el), box = (el) => el.getBoundingClientRect(), log = root.querySelector(".conversation-log");
        const act = ask.querySelector(".ask-act"), x = ask.querySelector(".ask-x"), badge = ask.querySelector(".ask-badge");
        return { inShadow: root !== document, rows: rows.map((r) => r.querySelector(".ask-label").textContent), checked: rows.map((r) => r.getAttribute("aria-checked")),
          badge: badge?.textContent, badgeIn: rows.findIndex((r) => r.contains(badge)), question: ask.querySelector(".ask-q").textContent,
          rowRadius: style(rows[0]).borderTopLeftRadius, rowBg: style(rows[0]).backgroundColor, rowDisplay: style(rows[0]).display, actHeight: box(act).height,
          actRadius: style(act).borderTopLeftRadius, xIcon: x.querySelector("svg")?.dataset.icon, pager: ask.querySelector(".ask-pg")?.textContent,
          frame: style(ask).borderTopLeftRadius, frameBorder: style(ask).borderTopWidth, pencil: box(ask.querySelector(".ask-pencil svg")).width,
          overflow: log.scrollWidth - log.clientWidth, cardRight: box(ask).right, logRight: box(log).right,
          rowsFit: rows.every((r) => box(r).right <= box(ask).right + 0.5 && box(r).left >= box(ask).left - 0.5),
          field: ask.querySelector(".ask-field").placeholder };
      }, card);
      const where_ = `${where} ${width} ${theme}`;
      assert.equal(seen.inShadow, where === "side", where_);
      assert.deepEqual(seen.rows, ["SQLite file", "JSON on disk", "Postgres table"], where_);
      assert.deepEqual(seen.checked, ["true", "false", "false"], `${where_}: the recommendation is preselected`);
      assert.equal(seen.badge, "Recommended", where_);
      assert.equal(seen.badgeIn, 0, where_);
      assert.equal(seen.question, "Which storage backend should settings sync use?");
      assert.equal(seen.rowRadius, "10px", `${where_}: the card's own look reached it (askcard.css)`);
      assert.equal(seen.rowDisplay, "grid", where_);
      assert.notEqual(seen.rowBg, "rgba(0, 0, 0, 0)", where_);
      assert.equal(seen.actHeight, 28, `${where_}: a button's height`);
      assert.equal(seen.actRadius, "6px", `${where_}: the one corner, never a pill`);
      assert.equal(seen.frame, "6px", where_);
      assert.equal(seen.frameBorder, "1px", where_);
      assert.equal(seen.xIcon, "close", `${where_}: Dismiss draws the one close glyph`);
      assert.equal(seen.pager, "Question 1 of 2", where_);
      assert.equal(seen.pencil, 12, where_);
      assert.ok(seen.overflow <= 0, `${where_}: no sideways scroll (${seen.overflow})`);
      assert.ok(seen.rowsFit, `${where_}: every row inside the card`);
      assert.ok(seen.cardRight <= seen.logRight + 0.5, where_);
      assert.equal(seen.field, width === 300 ? "Other…" : width === 440 ? "Something else…" : "Something else? Tell Mornings", `${where_}: the hint fits its field`);
      assert.deepEqual(x.errors, [], where_);
      if (pictures) {
        await inPage(x.p, (root, sel) => root.querySelector(sel).scrollIntoView({ block: "center" }), card);
        await x.p.screenshot({ path: `${pictures}/card-${where}-${width}-${theme}.png` });
      }
    } finally { await x.close(); }
  }
});

test("Submit sends the answers; the card then shows what was chosen, and the answer is your next message", async (t) => {
  if (skipOrFail(t)) return;
  const pictures = process.env.DGC_PIP_QUESTIONS_PICTURES;
  for (const [where, width, theme] of [["side", 440, "dark"], ["tab", 700, "light"], ["side", 300, "light"]]) {
    const x = await open({ where, width, theme });
    try {
      await x.p.waitForSelector(`${card} .ask .ask-opt`);
      await x.p.waitForTimeout(450);                            // past the arrival guard
      await click(x.p, `${card} .ask-opt`, 1);                   // JSON on disk: question 1 settles and the card moves on
      await until(x.p, (root, sel) => root.querySelector(`${sel} .ask-pg`)?.textContent === "Question 2 of 2", card);
      await x.p.waitForTimeout(350);                            // past the step guard
      await click(x.p, `${card} .ask-opt`, 0); await click(x.p, `${card} .ask-opt`, 1);
      if (pictures) { await inPage(x.p, (root, sel) => root.querySelector(sel).scrollIntoView({ block: "center" }), card);
        await x.p.screenshot({ path: `${pictures}/card-multi-${where}-${width}-${theme}.png` }); }
      const act = await inPage(x.p, (root, sel) => root.querySelector(`${sel} .ask-act`).textContent, card);
      assert.equal(act, "Submit", "a card of several is sent only by Submit");
      await click(x.p, `${card} .ask-act`);
      await until(x.p, (root, sel) => !!root.querySelector(`${sel} .msg-questions-settled[data-state="answered"]`), card);
      const [first, ...again] = await answered(x.p);
      assert.equal(again.length, 0);
      assert.deepEqual([first.message_id, first.answers, "dismissed" in first],
        [REPLY, { storage: { selected: [1], other: "" }, extras: { selected: [0, 1], other: "" } }, false]);
      assert.match(first.idempotency_key, /^pip-answer-[0-9a-f-]{36}$/);
      assert.deepEqual(Object.keys(first.chat_options || {}).sort(), ["context_size", "thinking"], "with the box's own options, as a message");
      // The card settles from the answer's own reply; your message lands with the chat's next read, a moment later.
      await until(x.p, (root) => /JSON on disk/.test([...root.querySelectorAll(".pip-message.user")].at(-1)?.textContent || ""));
      const shown = await inPage(x.p, (root, sel) => {
        const slot = root.querySelector(sel);
        return { head: slot.querySelector(".msg-questions-head")?.textContent, open: !!slot.querySelector(".ask"),
          picked: [...slot.querySelectorAll(".asked-opt.picked .asked-opt-label")].map((n) => n.textContent),
          rows: slot.querySelectorAll(".asked-opt").length, last: [...root.querySelectorAll(".pip-message.user")].at(-1)?.textContent || "" };
      }, card);
      assert.equal(shown.head, "Answered · 2 questions");
      assert.equal(shown.open, false, "it can't be answered twice");
      assert.deepEqual(shown.picked, ["JSON on disk", "Conflict prompt", "Sync history"]);
      assert.equal(shown.rows, 6, "every option still listed");
      assert.match(shown.last, /Which storage backend should settings sync use\? JSON on disk/, "your answer is your next message");
      assert.deepEqual(await sent(x.p), [], "it went as the answer, not as another message");
      if (pictures) { await inPage(x.p, (root, sel) => root.querySelector(sel).scrollIntoView({ block: "center" }), card);
        await x.p.screenshot({ path: `${pictures}/answered-${where}-${width}-${theme}.png` }); }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("Dismiss closes it with nothing sent; Escape is Dismiss, the number keys pick, as in Work", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "side", width: 300, theme: "light" });
  try {
    await x.p.waitForSelector(`${card} .ask .ask-opt`);
    await x.p.waitForTimeout(450);
    await inPage(x.p, (root, sel) => root.querySelector(`${sel} .ask-opt`).focus(), card);
    await x.p.keyboard.press("3");                              // Postgres table, by its number
    await until(x.p, (root, sel) => root.querySelector(`${sel} .ask-pg`)?.textContent === "Question 2 of 2", card);
    await x.p.waitForTimeout(350);
    await x.p.keyboard.press("Escape");
    await until(x.p, (root, sel) => !!root.querySelector(`${sel} .msg-questions-settled[data-state="dismissed"]`), card);
    const [only, ...more] = await answered(x.p);
    assert.deepEqual([only.message_id, only.dismissed, "answers" in only, more.length], [REPLY, true, false, 0]);
    assert.equal(await inPage(x.p, (root, sel) => root.querySelector(sel).textContent, card), "Dismissed without an answer");
    if (process.env.DGC_PIP_QUESTIONS_PICTURES) { await inPage(x.p, (root, sel) => root.querySelector(sel).scrollIntoView({ block: "center" }), card);
      await x.p.screenshot({ path: `${process.env.DGC_PIP_QUESTIONS_PICTURES}/dismissed-side-300-light.png` }); }
    assert.deepEqual(await sent(x.p), [], "nothing sent");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a refused answer says why and stays answerable; where you were survives a redraw", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "side", width: 440, theme: "dark", questions: "refuse" });
  try {
    await x.p.waitForSelector(`${card} .ask .ask-opt`);
    await x.p.waitForTimeout(450);
    await click(x.p, `${card} .ask-opt`, 2);
    await until(x.p, (root, sel) => root.querySelector(`${sel} .ask-pg`)?.textContent === "Question 2 of 2", card);
    // A redraw (the box typed in redraws the chat): the same card, on the same question, with what was chosen.
    const before_ = await inPage(x.p, (root, sel) => { const el = root.querySelector(`${sel} .ask`); window.__askEl = el; return el.isConnected; }, card);
    assert.ok(before_);
    await x.p.fill("#chatText", "half a thought");
    await x.p.waitForTimeout(150);
    const kept = await inPage(x.p, (root, sel) => ({ same: root.querySelector(`${sel} .ask`) === window.__askEl,
      pg: root.querySelector(`${sel} .ask-pg`)?.textContent }), card);
    assert.deepEqual(kept, { same: true, pg: "Question 2 of 2" });
    await x.p.waitForTimeout(350);
    await click(x.p, `${card} .ask-act`);                       // Skip the multi-select one: all settled, Submit shows
    await x.p.waitForTimeout(350);
    await click(x.p, `${card} .ask-act`);                       // Submit: refused once
    await until(x.p, (root, sel) => !root.querySelector(`${sel} .ask-error`)?.hidden, card);
    const said = await inPage(x.p, (root, sel) => ({ error: root.querySelector(`${sel} .ask-error`).textContent,
      enabled: !root.querySelector(`${sel} .ask-act`).disabled }), card);
    assert.match(said.error, /Pips are stopped/);
    assert.equal(said.enabled, true, "it can be answered again");
    await x.p.waitForTimeout(450);
    await click(x.p, `${card} .ask-act`);
    await until(x.p, (root, sel) => !!root.querySelector(`${sel} .msg-questions-settled[data-state="answered"]`), card);
    const tries = await answered(x.p);
    assert.equal(tries.length, 2);
    assert.equal(tries[0].idempotency_key, tries[1].idempotency_key, "the same answer again is the same message");
    assert.deepEqual(tries[1].answers, { storage: { selected: [2], other: "" }, extras: { selected: [], other: "" } });
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("this view says it draws the card only to a DGC that has it (Pips API 106)", async (t) => {
  if (skipOrFail(t)) return;
  for (const [api, flagged] of [[105, false], [106, true]]) {
    const x = await open({ where: "tab", width: 700, api, said: [] });
    try {
      await x.p.fill("#chatText", "Propose me options");
      await x.p.keyboard.press("Enter");
      await x.p.waitForFunction(() => (window.__sent || []).some((r) => r.type === "send_pip_message"));
      const [message] = await sent(x.p);
      assert.equal(message.questions === true, flagged, `API ${api}`);
      assert.equal("questions" in message, flagged, `API ${api}`);
    } finally { await x.close(); }
  }
});
