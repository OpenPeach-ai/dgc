// Several conversations per Pip, in the editor (pips-17; Pips API 79), in real Chromium with the real client and its
// CSS (test/support/pip-chat-scene.mjs, opts.convs). The selector in the middle of its chat's top bar (the conversation
// shown, by its name; it was the Pip's name until 14 Nov) opens its conversations: New
// conversation, then each one, the newest first, with a dot for something unread, a ring while it answers there and how
// long ago it was written in; a row's "…" renames or archives (the first can't be archived); Archived lists those with
// Restore. A wide chat (900 px and up) shows the same list as a column, which folds away. The chat shows one
// conversation: switching keeps each one's draft and place, and send, mark read and the context meter name the one
// shown (none for the first, as before). New conversation asks about its computer; its page says how many it has and
// adds one; a routine's row says which conversation it posts in. A runtime before API 79 shows today's single chat.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { openChat, PIP } from "./support/pip-chat-scene.mjs";
import { conversationsPage, conversationAge, conversationTitle } from "../src/pipConversations.js";
import { pipComputer } from "../src/pipsModel.js";
import { routine } from "../src/pipRoutines.js";

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

const cid = (c) => "conv_" + c.repeat(32);
const GOA = cid("a"), FIRST = cid("f"), GROCERIES = cid("b"), TAX = cid("c"), MA = cid("d");
const row = (id, place = "menu") => `#conv-${place} [data-conv="${id}"]`;
const open = (opts = {}) => openChat(browser, { width: 700, height: 800, api: 80, convs: true, ...opts });
// Read in the page, in the root the chat is drawn in (the side bar's shadow root, or the document).
const inPage = (p, fn, arg) => p.evaluate(([code, a]) => new Function("root", "arg", `return (${code})(root, arg)`)(window.__pipsRoot || document, a), [fn.toString(), arg]);
const titles = (p, place = "menu") => inPage(p, (root, at) => [...root.querySelectorAll(`#conv-${at} .conv-row .dgc-menu-label`)].map((e) => e.textContent), place);
const shownTitle = (p) => inPage(p, (root) => root.querySelector(".pip-conv-title")?.textContent || "");
const boxText = (p) => inPage(p, (root) => root.querySelector("#chatText").value);
const focused = (p) => inPage(p, (root) => { const e = root.activeElement; return e ? (e.id || e.dataset.conv || Object.keys(e.dataset)[0] || e.className) : ""; });
const state = (p) => p.evaluate(() => JSON.parse(JSON.stringify(window.__convs)));
const sentTypes = (p) => p.evaluate(() => (window.__sent || []).map((r) => r.type));
const show = async (p, id, title) => { await p.click("#pip-convs"); await p.click(row(id)); await p.waitForFunction(([t]) => ((window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent || "") === t, [title]); };
const lastMessage = (p) => inPage(p, (root) => [...root.querySelectorAll(".conversation-log .pip-message")].at(-1)?.textContent || "");

test("a runtime before Pips API 79 shows today's single chat: no menu, no column, and no request names a conversation", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ api: 78, where: "tab", width: 1000 });
  try {
    await x.p.waitForTimeout(300);
    assert.equal(await x.p.locator("#pip-convs").count(), 0, "its name is words, not a button");
    assert.equal(await inPage(x.p, (root) => root.querySelector(".pip-topbar .pip-pill>span:not(.avatar)")?.textContent), "Mornings");
    assert.equal(await x.p.locator("#conv-column").count(), 0);
    assert.equal(await x.p.locator("#conv-menu").count(), 0);
    const sent = await x.p.evaluate(() => window.__sent);
    assert.equal(sent.some((r) => /conversation|add_pip_computer/.test(r.type)), false, "it is never asked for conversations");
    assert.equal(sent.some((r) => "conversation_id" in r), false);
    await x.p.fill("#chatText", "Hello");
    await x.p.press("#chatText", "Enter");
    await x.p.waitForFunction(() => window.__sent.some((r) => r.type === "send_pip_message"));
    assert.equal("conversation_id" in (await x.p.evaluate(() => window.__sent.find((r) => r.type === "send_pip_message"))), false);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the Pip's name opens its conversations: New conversation, then the newest first, with unread dots, the ring where it is answering, and ages", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.p.waitForSelector("#pip-convs");
    assert.equal(await x.p.locator("#conv-menu").count(), 0, "closed until asked for");
    assert.equal(await x.p.getAttribute("#pip-convs", "aria-expanded"), "false");
    // (14 Nov: the selector in the middle of the header names the conversation shown; the Pip's own name stands at the
    // left, beside its face, and no longer moves with the conversation: test/pip-chat-header-browser.test.mjs.)
    assert.match(await x.p.locator("#pip-convs").textContent(), /^Chat/);
    assert.equal(await inPage(x.p, (root) => root.querySelector(".pip-topbar .pip-name")?.textContent), "Mornings");
    await x.p.click("#pip-convs");
    await x.p.waitForSelector("#conv-menu");
    assert.equal(await x.p.getAttribute("#pip-convs", "aria-expanded"), "true");
    assert.equal(await x.p.getAttribute("#conv-menu", "role"), "menu");
    const facts = await inPage(x.p, (root) => {
      const menu = root.querySelector("#conv-menu"), rows = [...menu.querySelectorAll(".dgc-menu-row")];
      const mark = (r) => { const m = r.querySelector(".conv-mark"); return m.classList.contains("unread") ? "unread" : m.classList.contains("replying") ? "replying" : ""; };
      const box = menu.getBoundingClientRect(), bar = root.querySelector(".pip-topbar").getBoundingClientRect(), dot = getComputedStyle(root.querySelector("#conv-menu .conv-mark.unread"), "::before");
      return { first: rows[0].textContent.trim(), last: rows.at(-1).textContent.trim(), rows: [...menu.querySelectorAll(".conv-row")].map((r) => [r.querySelector(".dgc-menu-label").textContent, r.querySelector(".dgc-menu-sub")?.textContent || "", r.querySelector(".conv-age").textContent, mark(r), r.getAttribute("aria-checked")]),
        under: box.top >= bar.bottom - 6, inside: box.left >= 0 && box.right <= window.innerWidth, width: Math.round(box.width), dot: [dot.width, dot.backgroundColor], said: menu.querySelector(`[data-conv$="dddd"] .sr-only`).textContent };
    });
    assert.equal(facts.first, "New conversation");
    assert.equal(facts.last, "Archived (2)");
    assert.deepEqual(facts.rows, [["Trip to Goa", "", "now", "", "false"], ["Chat", "Its routines post here", "8m", "", "true"], ["Groceries", "Replying…", "1h", "replying", "false"],
      ["Tax papers", "", "3d", "", "false"], ["Birthday ideas for Ma", "", "2w", "unread", "false"]], "the first one is “Chat” until named, and is the one shown");
    assert.equal(facts.under && facts.inside, true, "it hangs from the top bar, inside the view");
    assert.equal(facts.width, 288);
    assert.deepEqual(facts.dot, ["7px", "rgb(124, 92, 255)"], "the unread dot is the one accent");
    assert.equal(facts.said, "2 unread, 2 weeks ago", "and it is said, not only shown");
    // A click outside closes it.
    await x.p.click(".conversation-log", { position: { x: 5, y: 300 } });
    assert.equal(await x.p.locator("#conv-menu").count(), 0);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the keyboard works the menu: Down opens it, Up and Down move, Enter shows the conversation, Right reaches a row's choices, Escape steps back and closes", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.p.waitForSelector("#pip-convs");
    await x.p.focus("#pip-convs");
    await x.p.keyboard.press("ArrowDown");
    await x.p.waitForSelector("#conv-menu");
    assert.equal(await focused(x.p), FIRST, "it opens on the conversation shown");
    await x.p.keyboard.press("ArrowDown");
    assert.equal(await focused(x.p), GROCERIES);
    await x.p.keyboard.press("ArrowUp"); await x.p.keyboard.press("ArrowUp");
    assert.equal(await focused(x.p), GOA);
    await x.p.keyboard.press("ArrowUp");
    assert.equal(await focused(x.p), "convNew", "New conversation is the first stop");
    await x.p.keyboard.press("ArrowUp");
    assert.equal(await focused(x.p), "convArchived", "and Up from the top goes round to the end");
    await x.p.keyboard.press("Home"); await x.p.keyboard.press("ArrowDown");
    assert.equal(await focused(x.p), GOA);
    await x.p.keyboard.press("Enter");
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent === "Trip to Goa");
    assert.equal(await x.p.locator("#conv-menu").count(), 0, "choosing closes it");
    await x.p.waitForFunction(() => /Bhakti Kutir is held/.test((window.__pipsRoot || document).querySelector(".conversation-log").textContent));
    assert.equal(await focused(x.p), "chatText", "and the keyboard is in its box");
    // Its choices, and Escape one step at a time.
    await x.p.focus("#pip-convs");
    await x.p.keyboard.press("Enter");
    await x.p.waitForSelector("#conv-menu");
    assert.equal(await focused(x.p), GOA);
    await x.p.keyboard.press("ArrowRight");
    assert.equal(await focused(x.p), "convMore");
    await x.p.keyboard.press("Enter");
    await x.p.waitForSelector("#conv-menu [data-conv-rename]");
    assert.equal(await focused(x.p), "convRename");
    await x.p.keyboard.press("Escape");
    assert.equal(await x.p.locator("#conv-menu [data-conv-rename]").count(), 0);
    assert.equal(await x.p.locator("#conv-menu").count(), 1, "the menu is still open");
    assert.equal(await focused(x.p), GOA);
    await x.p.keyboard.press("Escape");
    assert.equal(await x.p.locator("#conv-menu").count(), 0);
    assert.equal(await focused(x.p), "pip-convs", "focus is back on the name");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("switching keeps each conversation's draft and its place, and send, mark read and the context meter name the one shown", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.p.waitForSelector("#pip-convs");
    await x.p.fill("#chatText", "a draft for the first chat");
    await show(x.p, TAX, "Tax papers");
    assert.equal(await boxText(x.p), "", "another conversation starts with an empty box");
    assert.match(await lastMessage(x.p), /Paper 15 is filed/);
    assert.equal(await inPage(x.p, (root) => root.querySelectorAll(".conversation-log .pip-message").length), 30, "its own messages only");
    await x.p.fill("#chatText", "tax draft");
    // Read back to the middle, by hand.
    const log = x.p.locator(".conversation-log");
    await log.hover();
    await x.p.mouse.wheel(0, -900);
    await x.p.waitForFunction(() => { const l = (window.__pipsRoot || document).querySelector(".conversation-log"); return l.scrollHeight - l.scrollTop - l.clientHeight > 300; });
    await x.p.waitForTimeout(150);
    const left = await inPage(x.p, (root) => Math.round(root.querySelector(".conversation-log").scrollTop));
    await show(x.p, GOA, "Trip to Goa");
    assert.equal(await boxText(x.p), "");
    assert.equal(await inPage(x.p, (root) => root.querySelectorAll(".conversation-log .pip-message").length), 4);
    await show(x.p, TAX, "Tax papers");
    assert.equal(await boxText(x.p), "tax draft", "its draft is back");
    await x.p.waitForTimeout(250);   // the list is read again; the view stays where it was left
    assert.ok(Math.abs(await inPage(x.p, (root) => Math.round(root.querySelector(".conversation-log").scrollTop)) - left) <= 2, "and so is its place");
    await show(x.p, FIRST, "Chat");
    assert.equal(await boxText(x.p), "a draft for the first chat");
    assert.match(await inPage(x.p, (root) => root.querySelector(".conversation-log").textContent), /Which sources will you read/);
    // Sending: the first conversation is named by nothing (as an older editor does); another by its id.
    await x.p.fill("#chatText", "to the first");
    await x.p.press("#chatText", "Enter");
    await x.p.waitForFunction(() => window.__convs.sent.length === 1);
    await show(x.p, GOA, "Trip to Goa");
    await x.p.fill("#chatText", "Book the 9 am train too");
    await x.p.press("#chatText", "Enter");
    await x.p.waitForFunction(() => window.__convs.sent.length === 2);
    const s = await state(x.p);
    assert.deepEqual(s.sent.map((m) => [m.conversation, m.text]), [[null, "to the first"], [GOA, "Book the 9 am train too"]]);
    assert.notEqual(s.sent[0].key, s.sent[1].key, "each message its own request key");
    assert.ok(s.contexts.includes(GOA) && s.contexts.includes(TAX) && s.contexts.includes(null), "the context meter measures the conversation shown");
    const listed = await x.p.evaluate(() => window.__sent.filter((r) => r.type === "list_pip_messages").map((r) => r.conversation_id || null));
    assert.ok(listed.includes(GOA) && listed.includes(TAX) && listed.includes(null));
    // Opening the one with something unread reads it: its own newest reply, in its own name; the dot goes.
    await show(x.p, MA, "Birthday ideas for Ma");
    await x.p.waitForFunction(([id]) => window.__convs.read.some((r) => r.conversation === id), [MA]);
    assert.deepEqual((await state(x.p)).read.find((r) => r.conversation === MA), { conversation: MA, message: "d2" });
    await x.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector("#pip-convs .conv-mark.unread"));
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a reply running in another conversation is a quiet ring on its row; Stop and the steering line belong to the one shown", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.p.waitForSelector("#pip-convs");
    // The first conversation is idle: its box sends, and nothing here says "working".
    assert.equal(await x.p.locator(".pip-working").count(), 0);
    assert.notEqual(await inPage(x.p, (root) => root.querySelector(".chat-send")?.getAttribute("aria-label")), "Send mid-turn update");
    await show(x.p, GROCERIES, "Groceries");
    await x.p.waitForSelector(".pip-working");
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".chat-send")?.getAttribute("aria-label") === "Send mid-turn update");
    await x.p.fill("#chatText", "And oat milk");
    await x.p.press("#chatText", "Enter");
    await x.p.waitForFunction(() => window.__convs.sent.length === 1);
    assert.deepEqual((await state(x.p)).sent.map((m) => [m.conversation, m.text]), [[GROCERIES, "And oat milk"]], "the update joins that conversation's reply");
    await show(x.p, FIRST, "Chat");
    assert.equal(await x.p.locator(".pip-working").count(), 0, "back in the first one, nothing is running");
    await x.p.click("#pip-convs");
    assert.equal(await inPage(x.p, (root, id) => root.querySelector(`#conv-menu [data-conv="${id}"] .conv-mark`).classList.contains("replying"), GROCERIES), true);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a wide chat shows the list as a column beside it; narrower, only the menu; the column folds away", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "tab", width: 1000 });
  try {
    await x.p.waitForSelector("#conv-column .conv-row");
    const wide = await x.p.evaluate(() => { const c = document.querySelector("#conv-column").getBoundingClientRect(), bar = document.querySelector(".pip-topbar").getBoundingClientRect(), box = document.querySelector("#chat-form").getBoundingClientRect();
      return { shown: c.width > 0, left: c.left, width: Math.round(c.width), tall: c.height >= window.innerHeight - 1, barLeft: Math.round(bar.left), boxLeft: box.left, chevron: getComputedStyle(document.querySelector(".pip-convs-chevron")).display,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, head: document.querySelector(".conv-column-head h2").textContent }; });
    assert.deepEqual([wide.shown, wide.left, wide.width, wide.tall, wide.barLeft, wide.chevron, wide.overflow, wide.head], [true, 0, 252, true, 252, "none", false, "Mornings"]);
    assert.ok(wide.boxLeft >= 252, "the chat stands to its right");
    assert.deepEqual(await titles(x.p, "column"), ["Trip to Goa", "Chat", "Groceries", "Tax papers", "Birthday ideas for Ma"]);
    assert.equal(await x.p.getAttribute(row(FIRST, "column"), "aria-current"), "true");
    // With the column there, the name opens no second list.
    await x.p.click("#pip-convs");
    assert.equal(await x.p.locator("#conv-menu").count(), 0);
    await x.p.click(row(GOA, "column"));
    await x.p.waitForFunction(() => document.querySelector(".pip-conv-title")?.textContent === "Trip to Goa");
    assert.equal(await x.p.getAttribute(row(GOA, "column"), "aria-current"), "true");
    await x.p.waitForFunction(() => /Bhakti Kutir is held/.test(document.querySelector(".conversation-log").textContent));
    // Up and Down move along the column too.
    await x.p.focus(row(GOA, "column"));
    await x.p.keyboard.press("ArrowDown");
    assert.equal(await focused(x.p), FIRST);
    // Narrower than 900 px: the column goes, and the name's menu is back.
    await x.p.setViewportSize({ width: 700, height: 800 });
    await x.p.waitForFunction(() => document.querySelector("#conv-column").getClientRects().length === 0);
    assert.equal(await x.p.evaluate(() => document.querySelector(".pip-topbar").getBoundingClientRect().left), 0);
    await x.p.click("#pip-convs");
    await x.p.waitForSelector("#conv-menu");
    await x.p.keyboard.press("Escape");
    // Wide again, and folded away: one mark to bring it back, and the menu meanwhile.
    await x.p.setViewportSize({ width: 1000, height: 800 });
    await x.p.waitForFunction(() => document.querySelector("#conv-column").getClientRects().length > 0);
    await x.p.click("#conv-column-hide");
    assert.equal(await x.p.evaluate(() => document.querySelector(".pip-topbar").getBoundingClientRect().left), 0, "the chat takes the whole width");
    assert.equal(await x.p.locator("#conv-column .conv-row").count(), 0);
    await x.p.click("#pip-convs");
    await x.p.waitForSelector("#conv-menu");
    await x.p.keyboard.press("Escape");
    const marks = await x.p.evaluate(() => { const a = document.querySelector("#conv-column-show").getBoundingClientRect(), b = document.querySelector("#simple-back").getBoundingClientRect(); return a.right <= b.left && Math.abs(a.top - b.top) <= 2; });
    assert.equal(marks, true, "its mark sits before Back, on one line");
    await x.p.click("#conv-column-show");
    await x.p.waitForSelector("#conv-column .conv-row");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  // The side bar is narrow: no column there, at 300 or 700 px.
  for (const width of [300, 700]) {
    const y = await open({ width });
    try {
      await y.p.waitForSelector("#pip-convs");
      assert.equal(await inPage(y.p, (root) => root.querySelector("#conv-column").getClientRects().length), 0, `no column at ${width}px`);
      await y.p.click("#pip-convs");
      await y.p.waitForSelector("#conv-menu");
      const fit = await inPage(y.p, (root) => { const m = root.querySelector("#conv-menu").getBoundingClientRect(), name = root.querySelector(".pip-conv-title"); return [m.left >= 0 && m.right <= window.innerWidth, name.getBoundingClientRect().width >= 24, document.documentElement.scrollWidth > document.documentElement.clientWidth]; });
      assert.deepEqual(fit, [true, true, false], `the menu fits at ${width}px`);
    } finally { await y.close(); }
  }
});

test("a row's “…” renames and archives; the first can't be archived; Archived lists them with Restore", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await show(x.p, GOA, "Trip to Goa");
    await x.p.click("#pip-convs");
    await x.p.hover(row(FIRST));
    await x.p.click(`#conv-menu [data-conv-more="${FIRST}"]`);
    assert.deepEqual(await inPage(x.p, (root) => [...root.querySelectorAll("#conv-menu .conv-more button")].map((b) => b.textContent)), ["Rename"], "the first one stays: its routines post there");
    await x.p.click(`#conv-menu [data-conv-more="${GOA}"]`);
    assert.deepEqual(await inPage(x.p, (root) => [...root.querySelectorAll("#conv-menu .conv-more button")].map((b) => b.textContent)), ["Rename", "Archive"]);
    await x.p.click(`#conv-menu [data-conv-rename="${GOA}"]`);
    assert.equal(await inPage(x.p, (root) => root.activeElement?.value), "Trip to Goa", "its name is in the box, selected");
    await x.p.keyboard.type("Goa in March");
    await x.p.keyboard.press("Enter");
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent === "Goa in March");
    assert.deepEqual(await x.p.evaluate(() => { const r = window.__sent.find((v) => v.type === "rename_pip_conversation"); return [r.conversation_id.slice(-4), r.title]; }), ["aaaa", "Goa in March"]);
    assert.equal(await focused(x.p), GOA, "the keyboard stays on its row");
    assert.equal((await titles(x.p))[0], "Goa in March");
    // Archive the one shown: the chat goes back to the first, and it is under Archived.
    await x.p.click(`#conv-menu [data-conv-more="${GOA}"]`);
    await x.p.click(`#conv-menu [data-conv-archive="${GOA}"]`);
    await x.p.waitForFunction(() => window.__convs.list.find((c) => c.title === "Goa in March").archived);
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent === "Chat");
    assert.match(await inPage(x.p, (root) => root.querySelector(".conversation-log").textContent), /Which sources will you read/);
    await x.p.click("#pip-convs");
    await x.p.waitForSelector("#conv-menu");
    assert.deepEqual(await titles(x.p), ["Chat", "Groceries", "Tax papers", "Birthday ideas for Ma"]);
    assert.equal(await x.p.locator("#conv-menu [data-conv-archived]").textContent(), "Archived (3)");
    assert.equal(await x.p.locator("#conv-menu .conv-archived-row").count(), 0, "folded until opened");
    await x.p.click("#conv-menu [data-conv-archived]");
    assert.deepEqual(await inPage(x.p, (root) => [...root.querySelectorAll("#conv-menu .conv-archived-name")].map((e) => e.textContent)), ["Goa in March", "Old plans", "Spring cleaning"]);
    // Restore is DGC's one button at its dense size.
    const size = await inPage(x.p, (root) => { const b = root.querySelector("#conv-menu [data-conv-restore]"), r = b.getBoundingClientRect(), s = getComputedStyle(b); return [Math.round(r.width), Math.round(r.height), s.borderTopLeftRadius, b.textContent]; });
    assert.deepEqual(size, [76, 22, "6px", "Restore"]);
    await x.p.click(`#conv-menu [data-conv-restore="${GOA}"]`);
    await x.p.waitForFunction(([id]) => !!(window.__pipsRoot || document).querySelector(`#conv-menu .conv-row[data-conv="${id}"]`), [GOA]);
    assert.equal(await x.p.locator("#conv-menu [data-conv-archived]").textContent(), "Archived (2)");
    assert.deepEqual(await x.p.evaluate(() => window.__sent.filter((v) => v.type === "archive_pip_conversation").map((v) => v.archived)), [true, false]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("New conversation asks about its computer: use the one it has, or add another, and says they are shared", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.p.waitForSelector("#pip-convs");
    await x.p.click("#pip-convs");
    await x.p.click("#conv-menu [data-conv-new]");
    await x.p.waitForSelector("#conv-menu .conv-new-step");
    const step = await inPage(x.p, (root) => { const f = root.querySelector("#conv-menu .conv-new-step"); return { choices: [...f.querySelectorAll(".conv-choice")].map((l) => [l.querySelector("strong").textContent, l.querySelector("small").textContent, l.querySelector("input").checked, l.querySelector("input").disabled]),
      note: f.querySelector(".conv-note").textContent, buttons: [...f.querySelectorAll("button")].map((b) => { const r = b.getBoundingClientRect(); return [b.textContent, Math.round(r.width), Math.round(r.height)]; }), focus: root.activeElement?.value }; });
    assert.deepEqual(step.choices, [["Use its computer", "It has 1 computer.", true, false], ["Add another", "One more, so two things can go on at once. Up to 3.", false, false]]);
    assert.equal(step.note, "Its computers are shared by all its conversations.");
    assert.deepEqual(step.buttons, [["Start", 76, 22], ["Cancel", 76, 22]]);
    assert.equal(step.focus, "use", "the keyboard is on the choice");
    assert.equal((await sentTypes(x.p)).includes("create_pip_conversation"), false, "nothing is made until Start");
    // Cancel goes back to the list; Escape does too.
    await x.p.click("#conv-menu [data-conv-new-cancel]");
    assert.equal(await x.p.locator("#conv-menu .conv-new-step").count(), 0);
    assert.equal(await focused(x.p), "convNew");
    // Add another: one more computer, then the new conversation, shown and empty.
    await x.p.click("#conv-menu [data-conv-new]");
    await x.p.check('#conv-menu .conv-new-step input[value="add"]');
    await x.p.click("#conv-menu .conv-new-step button[type=submit]");
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent === "New conversation");
    const types = (await sentTypes(x.p)).filter((v) => ["add_pip_computer", "create_pip_conversation"].includes(v));
    assert.deepEqual(types, ["add_pip_computer", "create_pip_conversation"]);
    assert.equal((await state(x.p)).computers, 2);
    assert.equal(await x.p.locator("#conv-menu").count(), 0);
    assert.equal(await inPage(x.p, (root) => root.querySelectorAll(".conversation-log .pip-message").length), 0, "it starts empty");
    assert.equal((await sentTypes(x.p)).includes("introduce_pip"), false, "and the Pip's hello stays in its first conversation");
    assert.equal(await focused(x.p), "chatText");
    // Its first message names it.
    await x.p.fill("#chatText", "Plan a weekend in Coorg\nwith a long second line");
    await x.p.press("#chatText", "Enter");
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent === "Plan a weekend in Coorg");
    const made = (await state(x.p)).list.find((c) => c.title === "Plan a weekend in Coorg");
    assert.deepEqual((await state(x.p)).sent.map((m) => m.conversation), [made.id]);
    // Using the ones it has adds nothing; and it now says it has two.
    await x.p.click("#pip-convs");
    await x.p.click("#conv-menu [data-conv-new]");
    assert.deepEqual(await inPage(x.p, (root) => [...root.querySelectorAll("#conv-menu .conv-new-step .conv-choice")].map((l) => [l.querySelector("strong").textContent, l.querySelector("small").textContent])), [["Use its computers", "It has 2 computers."], ["Add another", "One more, so three things can go on at once. Up to 3."]]);
    await x.p.keyboard.press("Enter");
    await x.p.waitForFunction(() => window.__sent.filter((v) => v.type === "create_pip_conversation").length === 2);
    assert.equal((await state(x.p)).added, 1);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("at its limit Add another is off and says why; a Pip with no computer starts a conversation at once; a refusal is said in the list", async (t) => {
  if (skipOrFail(t)) return;
  const full = await open({ convs: { computers: 3 } });
  try {
    await full.p.waitForSelector("#pip-convs");
    await full.p.click("#pip-convs");
    await full.p.click("#conv-menu [data-conv-new]");
    assert.deepEqual(await inPage(full.p, (root) => [...root.querySelectorAll("#conv-menu .conv-new-step .conv-choice")].map((l) => [l.querySelector("strong").textContent, l.querySelector("small").textContent, l.querySelector("input").disabled])),
      [["Use its computers", "It has 3 computers.", false], ["Add another", "3 is the most it can have.", true]]);
  } finally { await full.close(); }
  const project = await open({ project: true });
  try {
    await project.p.waitForSelector("#pip-convs");
    await project.p.click("#pip-convs");
    await project.p.click("#conv-menu [data-conv-new]");
    await project.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent === "New conversation");
    assert.equal(await project.p.locator("#conv-menu .conv-new-step").count(), 0, "nothing to ask");
    assert.equal(await project.p.locator(".run-post").count(), 0, "its runs post in its first conversation, not here");
    assert.deepEqual(project.errors, []);
  } finally { await project.close(); }
  const refused = await open({ project: true, convs: { fail: "create" } });
  try {
    await refused.p.waitForSelector("#pip-convs");
    await refused.p.click("#pip-convs");
    await refused.p.click("#conv-menu [data-conv-new]");
    await refused.p.waitForSelector("#conv-menu .conv-error");
    assert.equal(await refused.p.locator("#conv-menu .conv-error").textContent(), "A Pip keeps up to 500 conversations. Archive or delete one first.");
    assert.equal(await shownTitle(refused.p), "Chat", "the chat stays where it was");
  } finally { await refused.close(); }
});

test("a message that fails after its conversation left the screen goes back to that conversation's box, not the one shown", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ convs: { fail: "send" } });
  try {
    await show(x.p, GOA, "Trip to Goa");
    await x.p.fill("#chatText", "Hold the huts instead");
    // Sent and switched in one step, before DGC answers.
    await inPage(x.p, (root) => { root.querySelector("#chatText").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true })); root.querySelector("#pip-convs").click(); });
    await x.p.click(row(TAX));
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent === "Tax papers");
    await x.p.waitForFunction(() => window.__convs.sent.length === 1);
    await x.p.waitForTimeout(100);
    assert.equal(await boxText(x.p), "", "the one shown is left alone");
    assert.equal(await inPage(x.p, (root) => /Hold the huts/.test(root.querySelector(".conversation-log").textContent)), false);
    await show(x.p, GOA, "Trip to Goa");
    assert.equal(await boxText(x.p), "Hold the huts instead", "the words are back where they were written");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("its page: how many computers it has with Add another, and each routine's “Posts in” picker", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ settings: true });
  try {
    await x.p.waitForSelector("#pip-convs");
    await inPage(x.p, (root) => root.querySelector('[data-tab="job"]').click());
    await x.p.waitForSelector("[data-computers]");
    assert.equal(await inPage(x.p, (root) => root.querySelector("[data-computers] .row-words").textContent), "Computers: 1Its computers are shared by all its conversations.");
    const button = await inPage(x.p, (root) => { const b = root.querySelector("#add-computer"), r = b.getBoundingClientRect(); return [b.textContent, Math.round(r.width), Math.round(r.height), b.disabled]; });
    assert.deepEqual(button, ["Add another", 104, 28, false]);
    await x.p.click("#add-computer");
    await x.p.waitForSelector('[data-computers="2"]');
    assert.match(await inPage(x.p, (root) => root.querySelector(".notice")?.textContent || ""), /Mornings has 2 computers now/);
    await x.p.click("#add-computer");
    await x.p.waitForSelector('[data-computers="3"]');
    assert.equal(await inPage(x.p, (root) => root.querySelector("#add-computer").disabled), true, "three is its limit");
    assert.match(await inPage(x.p, (root) => root.querySelector("[data-computers] small").textContent), /^3 is the most it can have\./);
    // A routine posts in the first conversation until moved; back to the first is "none".
    const picker = ".routine-posts select";
    await x.p.waitForSelector(picker);
    assert.equal(await inPage(x.p, (root) => root.querySelector(".routine-posts span").textContent), "Posts in");
    assert.deepEqual(await inPage(x.p, (root) => { const s = root.querySelector(".routine-posts select"); return [[...s.options].map((o) => o.textContent), s.selectedOptions[0].textContent]; }),
      [["Trip to Goa", "Chat", "Groceries", "Tax papers", "Birthday ideas for Ma"], "Chat"]);
    await x.p.selectOption(picker, GOA);
    await x.p.waitForFunction(() => window.__convs.routines.length === 1);
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".routine-posts select")?.selectedOptions[0].textContent === "Trip to Goa");
    await x.p.selectOption(picker, FIRST);
    await x.p.waitForFunction(() => window.__convs.routines.length === 2);
    assert.deepEqual((await state(x.p)).routines, [{ conversation_id: GOA }, { conversation_id: null }]);
    assert.equal(await x.p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the menu reads in dark and light: its words and marks are legible, and the accent is only the dot", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark", "light"]) {
    const x = await open({ theme, width: 300 });
    try {
      await x.p.waitForSelector("#pip-convs");
      await x.p.click("#pip-convs");
      await x.p.waitForSelector("#conv-menu");
      const inks = await inPage(x.p, (root) => {
        const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number), lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const ratio = (a, b) => { const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
        const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        const solid = (c) => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = "#000"; probe.fillStyle = c; probe.fillRect(0, 0, 1, 1); const d = probe.getImageData(0, 0, 1, 1).data; return `rgb(${d[0]}, ${d[1]}, ${d[2]})`; };
        const menu = root.querySelector("#conv-menu"), ground = solid(getComputedStyle(menu).backgroundColor);
        const over = (el) => ratio(solid(getComputedStyle(el).color), ground);
        const purple = [...menu.querySelectorAll("*")].filter((e) => { const [r, g, b] = rgb(solid(getComputedStyle(e).color)); return b > 200 && r < 190 && g < 150; }).length;
        return { label: over(menu.querySelector(".conv-row .dgc-menu-label")), sub: over(menu.querySelector(".dgc-menu-sub")), age: over(menu.querySelector(".conv-age")), archived: over(menu.querySelector(".conv-archived")), purple };
      });
      for (const key of ["label", "sub", "age", "archived"]) assert.ok(inks[key] >= 4.5, `${theme}: ${key} reads at ${inks[key].toFixed(2)}:1`);
      assert.equal(inks.purple, 0, `${theme}: no words in the accent`);
    } finally { await x.close(); }
  }
});

// ---- The words and the checks behind it (no browser) ----
test("a conversation's name, its age and DGC's list are read as sent", () => {
  assert.equal(conversationTitle({ title: "", first: true }), "Chat");
  assert.equal(conversationTitle({ title: "", first: false }), "New conversation");
  assert.equal(conversationTitle({ title: "Trip to Goa", first: false }), "Trip to Goa");
  const now = Date.parse("2026-11-11T12:00:00Z"), ago = (m) => new Date(now - m * 60000).toISOString();
  assert.deepEqual([0.5, 8, 59, 60, 23 * 60, 24 * 60, 13 * 1440, 14 * 1440, 59 * 1440, 60 * 1440, 364 * 1440, 800 * 1440].map((m) => conversationAge(ago(m), now)),
    ["now", "8m", "59m", "1h", "23h", "1d", "13d", "2w", "8w", "2mo", "12mo", "2y"]);
  assert.equal(conversationAge("soon", now), "");
  const one = { id: cid("a"), pip_id: PIP, title: "Trip", first: false, created_at: ago(9), updated_at: ago(1), archived: false, unread: 2, replying: true };
  assert.deepEqual(conversationsPage({ pip_id: PIP, conversations: [one, one] }, PIP), [{ id: cid("a"), title: "Trip", first: false, created_at: ago(9), updated_at: ago(1), archived: false, unread: 2, replying: true }], "one row a conversation");
  const { replying, unread, ...plain } = one;
  assert.deepEqual(conversationsPage({ pip_id: PIP, conversations: [plain] }, PIP)[0].replying, false, "a DGC that doesn't say where it is answering");
  assert.throws(() => conversationsPage({ pip_id: "pip_other", conversations: [] }, PIP));
  assert.throws(() => conversationsPage({ pip_id: PIP, conversations: [{ ...one, pip_id: "pip_other" }] }, PIP), "another Pip's conversation is refused");
  assert.throws(() => conversationsPage({ pip_id: PIP, conversations: [{ ...one, id: "conv_x" }] }, PIP));
});

test("its computer's status may say how many computers it has, and a routine where it posts", () => {
  const status = { pip_id: PIP, granted: true, available: true, reason: "", pending: 0, actions: [] };
  assert.equal(pipComputer({ ...status, computers: 2, computers_limit: 3 }, PIP).computers, 2, "as a DGC with Pips API 79 sends it");
  assert.equal(pipComputer({ ...status }, PIP).computers, undefined, "and as an older one does");
  assert.throws(() => pipComputer({ ...status, computers: 0, computers_limit: 3 }, PIP));
  assert.throws(() => pipComputer({ ...status, computers: 1, more: true }, PIP), "anything else is still refused");
  const r = { id: "routine_" + "b".repeat(32), pip_id: PIP, title: "Brief", prompt: "Do it", status: "on", created_by: "user", trigger: { kind: "email", query: "x", every_minutes: 10 }, run_id: null, next_due_at: null, last_run_at: null, last_error: null, updated_at: "2026-11-11T00:00:00Z" };
  assert.equal(routine({ ...r, conversation_id: cid("a") }, PIP).conversation_id, cid("a"));
  assert.throws(() => routine({ ...r, conversation_id: "elsewhere" }, PIP));
});

test("the host sends the new commands to a DGC with Pips API 79, and never a conversation to an older one", async () => {
  const require = createRequire(import.meta.url);
  const code = (await build({ entryPoints: [fileURLToPath(new URL("../src/pipsView.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, (name) => (name === "vscode" ? {} : require(name)));
  const { conversationsRefusal } = mod.exports;
  assert.equal(typeof conversationsRefusal, "function");
  for (const type of ["list_pip_conversations", "create_pip_conversation", "rename_pip_conversation", "archive_pip_conversation"]) {
    assert.equal(conversationsRefusal({ type, pip_id: PIP }, 78), "Update DGC to have several conversations with a Pip.");
    assert.equal(conversationsRefusal({ type, pip_id: PIP }, 79), "");
    assert.match(code, new RegExp(`["']${type}["']`), `${type} is a command the host passes on`);
  }
  assert.match(code, /["']add_pip_computer["'], "list_pip_keys"/);
  assert.equal(conversationsRefusal({ type: "add_pip_computer", pip_id: PIP }, 78), "Update DGC to give a Pip another computer.");
  assert.equal(conversationsRefusal({ type: "add_pip_computer", pip_id: PIP }, 79), "");
  for (const type of ["send_pip_message", "list_pip_messages", "mark_pip_read", "get_pip_chat_context"]) {
    assert.equal(conversationsRefusal({ type, pip_id: PIP }, 78), "", "the first conversation, as before");
    assert.equal(conversationsRefusal({ type, pip_id: PIP, conversation_id: GOA }, 78), "Update DGC to have several conversations with a Pip.");
    assert.equal(conversationsRefusal({ type, pip_id: PIP, conversation_id: GOA }, 79), "");
    assert.equal(conversationsRefusal({ type, pip_id: PIP, conversation_id: "conv_1" }, 79), "Choose one of this Pip’s conversations.");
  }
  assert.equal(conversationsRefusal({ type: "update_pip_routine", changes: { conversation_id: null } }, 79), "", "a routine back to the first conversation");
  assert.equal(conversationsRefusal({ type: "update_pip_routine", changes: { conversation_id: GOA } }, 78), "Update DGC to have several conversations with a Pip.");
  assert.equal(conversationsRefusal({ type: "update_pip_routine", changes: { status: "off" } }, 78), "");
});
