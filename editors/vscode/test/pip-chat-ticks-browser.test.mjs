// Messaging feel in a Personal Pip's chat (pips-17c; Pips API 83), in real Chromium with the real client and its CSS
// (test/support/pip-chat-scene.mjs, opts.ticks):
// - a message sent while the Pip worked shows a small grey tick beside its time once its model has read it ("Read by
//   <Pip>"), a quiet clock until then, and no word "Steered"; a message that started a reply of its own shows neither;
// - a reply shows one quote line only when it answers something other than the message just above it;
// - Reply on a Pip's message puts a quote of it in the prompt box (removable), sends its id as `reply_to`, and your
//   message shows the same quote line above it; each conversation keeps its own.
// A runtime before API 83 shows no Reply and is never sent `reply_to`.
// DGC_TICKS_PICTURES=<folder> also writes the pictures (dark and light, 700 and 300 px).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { openChat } from "./support/pip-chat-scene.mjs";
import { messageMarkup, quoteLine } from "../src/pipsTranscript.js";

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

const GOA = "conv_" + "a".repeat(32);
const open = (opts = {}) => openChat(browser, { width: 700, height: 800, api: 83, convs: true, ticks: true, ...opts });
const inPage = (p, fn, arg) => p.evaluate(([code, a]) => new Function("root", "arg", `return (${code})(root, arg)`)(window.__pipsRoot || document, a), [fn.toString(), arg]);
const message = (id) => `.pip-message[data-message="${id}"]`;
const sends = (p) => p.evaluate(() => window.__sent.filter((r) => r.type === "send_pip_message"));
const show = async (p, id, title) => { await p.click("#pip-convs"); await p.click(`#conv-menu [data-conv="${id}"]`); await p.waitForFunction(([t]) => ((window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent || "") === t, [title]); };
const chip = (p) => inPage(p, (root) => root.querySelector(".chat-reply .chat-reply-text")?.textContent ?? null);
// Painted colour of an element's ink, as [r, g, b].
const ink = (p, selector) => inPage(p, (root, s) => { const c = document.createElement("canvas").getContext("2d"); c.fillStyle = getComputedStyle(root.querySelector(s)).color; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3); }, selector);
const grey = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) <= 24;

const base = { id: "m1", pip_id: "p", workspace_id: "w", run_id: "r", model: "", created_at: "2026-11-10T08:00:00Z", status: "succeeded" };
const draw = (m, more = {}) => messageMarkup({ ...base, ...m }, { name: "Mornings", formatDate: String, renderMarkdown: (t) => t, canSend: true, ...more });

test("the markup: a tick for a message its model read, a clock for one it hasn't, neither for a plain message, and no word Steered", () => {
  const read = draw({ role: "user", text: "And a window seat", steered: true, steer_status: "applied" });
  assert.match(read, /class="msg-read" data-read="read" role="img" aria-label="Read by Mornings" title="Read by Mornings"/);
  assert.doesNotMatch(read, /Steered/);
  const waits = draw({ role: "user", text: "And a meal", steered: true, steer_status: "pending", status: "queued" });
  assert.match(waits, /data-read="waiting" role="img" aria-label="Mornings hasn’t read this yet"/);
  assert.doesNotMatch(draw({ role: "user", text: "Book the train" }), /msg-read/, "a message that started its own reply");
  assert.doesNotMatch(draw({ role: "user", text: "Late", steered: true, steer_status: "missed", status: "failed", error: "Stopped before the Pip read this." }), /msg-read/, "one that wasn't sent says Not sent, as before");
  assert.doesNotMatch(draw({ role: "user", text: "Stopping", steered: true, steer_status: "pending", status: "cancelling" }), /msg-read/);
});

test("the markup: a quote line is one escaped line, and Reply is offered only where the chat says it can be", () => {
  assert.equal(quoteLine("  "), "");
  const line = quoteLine("Book the <b>9 am</b> train\n\n---\n\nto Pune", { reply: false });
  assert.match(line, /^<p class="msg-quote" title="Book the &lt;b&gt;9 am&lt;\/b&gt; train to Pune">/);
  assert.match(line, /<span class="msg-quote-mark" aria-hidden="true">↪<\/span><span class="sr-only">Answering: <\/span>/);
  assert.ok(quoteLine("word ".repeat(100)).includes("…"), "a long one is cut");
  assert.match(quoteLine("x", { reply: true, who: "Mornings" }), /Replying to Mornings: /);
  assert.doesNotMatch(draw({ role: "assistant", text: "Booked." }), /data-chat-action="reply"/, "not unless the chat can send one");
  assert.match(draw({ role: "assistant", text: "Booked." }, { canReply: true }), /data-chat-action="reply" data-message-id="m1" aria-label="Reply"/);
  assert.doesNotMatch(draw({ role: "user", text: "Mine" }, { canReply: true }), /data-chat-action="reply"/, "only on the Pip's messages");
  assert.match(draw({ role: "assistant", text: "Booked." }, { quote: "Book the train" }), /<span class="sr-only role">Mornings<\/span><p class="msg-quote"/);
});

test("a message its model read has a quiet grey tick beside its time, always shown; one it hasn't read has a clock", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ ticks: "working" });
  try {
    const facts = await inPage(x.p, (root) => {
      const of = (id) => { const m = root.querySelector(`.pip-message[data-message="${id}"]`), mark = m.querySelector(".msg-read"); if (!mark) return null;
        const box = mark.getBoundingClientRect(), time = m.querySelector("time.msg-time").getBoundingClientRect();
        return { read: mark.dataset.read, title: mark.title, label: mark.getAttribute("aria-label"), w: Math.round(box.width), h: Math.round(box.height), opacity: Number(getComputedStyle(mark).opacity),
          afterTime: box.left >= time.right - 1, sameRow: Math.abs((box.top + box.bottom) / 2 - (time.top + time.bottom) / 2) <= 3, text: m.innerText }; };
      return { s1: of("m1"), s3: of("m3"), u1: of("u1"), u2: of("u2") };
    });
    assert.deepEqual([facts.s1.read, facts.s1.title, facts.s1.label], ["read", "Read by Mornings", "Read by Mornings"]);
    assert.equal(facts.s1.opacity, 1, "shown without a hover, like the time");
    assert.ok(facts.s1.w <= 14 && facts.s1.h <= 14, "small");
    assert.ok(facts.s1.afterTime && facts.s1.sameRow, "beside its time");
    assert.doesNotMatch(facts.s1.text, /Steered/);
    assert.deepEqual([facts.s3.read, facts.s3.title], ["waiting", "Mornings hasn’t read this yet"]);
    assert.doesNotMatch(facts.s3.text, /Queued/, "no tag while it waits");
    assert.equal(facts.u1, null, "a message that started its own reply has no tick");
    assert.equal(facts.u2, null);
    assert.ok(grey(await ink(x.p, `${message("m1")} .msg-read`)), "the tick is grey, never the accent");
    assert.deepEqual(await ink(x.p, `${message("m1")} .msg-read`), await ink(x.p, `${message("m1")} time.msg-time`), "the same ink as its time");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a reply quotes the message it answers only when that isn't the one just above it", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [700, 300]) {
    const x = await open({ width });
    try {
      const facts = await inPage(x.p, (root) => {
        const quote = (id) => root.querySelector(`.pip-message[data-message="${id}"] .msg-quote`);
        const a1 = quote("a1"), box = a1.getBoundingClientRect(), body = root.querySelector(`.pip-message[data-message="a1"] .answer`).getBoundingClientRect(), log = root.querySelector(".conversation-log");
        const text = a1.querySelector(".msg-quote-text");
        return { a1: text.textContent, mark: a1.querySelector(".msg-quote-mark").textContent, a2: !!quote("a2"), height: Math.round(box.height), above: box.bottom <= body.top + 1,
          inside: box.right <= log.getBoundingClientRect().right + 1 && box.left >= log.getBoundingClientRect().left - 1, cut: text.scrollWidth > text.clientWidth, sideways: log.scrollWidth > log.clientWidth + 1 };
      });
      assert.equal(facts.a1, "Book the 9 am train to Pune for Friday", "it answers the first of the two, not the one just above");
      assert.equal(facts.mark, "↪");
      assert.equal(facts.a2, false, "a reply to the message just above it needs no quote");
      assert.ok(facts.height <= 20, `one line (${facts.height}px at ${width})`);
      assert.ok(facts.above && facts.inside && !facts.sideways, `above its reply, inside the chat at ${width}`);
      assert.ok(grey(await ink(x.p, `${message("a1")} .msg-quote`)));
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("your message shows the Pip's message you replied to, one line, cut when the chat is narrow", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [700, 300]) {
    const x = await open({ width });
    try {
      const facts = await inPage(x.p, (root) => {
        const m = root.querySelector(`.pip-message[data-message="u2"]`), q = m.querySelector(".msg-quote"), text = q.querySelector(".msg-quote-text"), box = q.getBoundingClientRect(), bubble = m.querySelector(".bubble").getBoundingClientRect();
        return { text: text.textContent, said: q.querySelector(".sr-only").textContent, height: Math.round(box.height), above: box.bottom <= bubble.top + 1, right: Math.abs(box.right - bubble.right) <= 6,
          inside: box.left >= m.getBoundingClientRect().left - 1, cut: text.scrollWidth > text.clientWidth, title: q.title };
      });
      assert.match(facts.text, /^Booked: the 9:05 Deccan Express on Friday/);
      assert.equal(facts.said, "Replying to Mornings: ");
      assert.match(facts.title, /Want me to book the way back too\?$/, "all of the quote is the tooltip");
      assert.ok(facts.height <= 20 && facts.above && facts.right && facts.inside, `one line above the bubble, at its edge (${width})`);
      assert.equal(facts.cut, true, "cut with an ellipsis, never wrapped");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("Reply on a Pip's message quotes it in the prompt box, removable, and sends its id with your message", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    assert.equal(await x.p.locator(".chat-reply").count(), 0);
    assert.equal(await x.p.locator(`${message("u2")} [data-chat-action="reply"]`).count(), 0, "only on the Pip's messages");
    await x.p.hover(message("a2"));
    const reply = x.p.locator(`${message("a2")} [data-chat-action="reply"]`);
    assert.equal(await reply.getAttribute("title"), "Reply");
    await reply.click();
    assert.equal(await chip(x.p), "Sunday has a 5:40 pm and a 7:15 pm back to Mumbai. Which one?");
    assert.equal(await inPage(x.p, (root) => root.activeElement?.id), "chatText", "the box is ready to type in");
    const placed = await inPage(x.p, (root) => { const c = root.querySelector(".chat-reply").getBoundingClientRect(), form = root.querySelector("#chat-form").getBoundingClientRect(), box = root.querySelector("#chatText").getBoundingClientRect();
      return { inside: c.left >= form.left && c.right <= form.right && c.top >= form.top, above: c.bottom <= box.top + 1, label: root.querySelector(".chat-reply-row").getAttribute("aria-label") }; });
    assert.deepEqual(placed, { inside: true, above: true, label: "Replying to Mornings’s message" });
    // Removable, by its own button.
    await x.p.click(".chat-reply [data-reply-remove]");
    assert.equal(await chip(x.p), null);
    assert.equal(await inPage(x.p, (root) => root.activeElement?.id), "chatText");
    // Another message takes its place: one quote at a time.
    await x.p.hover(message("a1"));
    await x.p.click(`${message("a1")} [data-chat-action="reply"]`);
    await x.p.hover(message("a2"));
    await x.p.click(`${message("a2")} [data-chat-action="reply"]`);
    assert.equal(await x.p.locator(".chat-reply").count(), 1);
    await x.p.fill("#chatText", "The later one");
    await x.p.press("#chatText", "Enter");
    await x.p.waitForFunction(() => window.__sent.some((r) => r.type === "send_pip_message"));
    const [sent] = await sends(x.p);
    assert.equal(sent.reply_to, "a2");
    assert.equal(sent.text, "The later one", "your words go as you wrote them");
    assert.equal("conversation_id" in sent, false, "its first conversation, as before");
    await x.p.waitForSelector(`${message("s1")}:has-text("The later one")`);
    assert.equal(await chip(x.p), null, "the quote went with the message");
    assert.equal(await x.p.locator(`.pip-message.user:has-text("The later one") .msg-quote-text`).textContent(), "Sunday has a 5:40 pm and a 7:15 pm back to Mumbai. Which one?");
    // The next message carries none.
    await x.p.fill("#chatText", "Thanks");
    await x.p.press("#chatText", "Enter");
    await x.p.waitForFunction(() => window.__sent.filter((r) => r.type === "send_pip_message").length === 2);
    assert.equal("reply_to" in (await sends(x.p))[1], false);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a message that didn't go comes back with its quote", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ convs: { fail: "send" } });
  try {
    await x.p.hover(message("a2"));
    await x.p.click(`${message("a2")} [data-chat-action="reply"]`);
    await x.p.fill("#chatText", "The later one");
    await x.p.press("#chatText", "Enter");
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector("#chatText").value === "The later one");
    assert.equal(await chip(x.p), "Sunday has a 5:40 pm and a 7:15 pm back to Mumbai. Which one?");
  } finally { await x.close(); }
});

test("each conversation keeps its own quote, and a reply names its own conversation", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.p.hover(message("a2"));
    await x.p.click(`${message("a2")} [data-chat-action="reply"]`);
    await show(x.p, GOA, "Trip to Goa");
    await x.p.waitForSelector(message("a4"));
    assert.equal(await chip(x.p), null, "the other conversation's quote stays there");
    await x.p.hover(message("a4"));
    await x.p.click(`${message("a4")} [data-chat-action="reply"]`);
    assert.equal(await chip(x.p), "Bhakti Kutir is held until 6 pm today.");
    await x.p.fill("#chatText", "Make it two nights");
    await x.p.press("#chatText", "Enter");
    await x.p.waitForFunction(() => window.__sent.some((r) => r.type === "send_pip_message"));
    const [sent] = await sends(x.p);
    assert.deepEqual([sent.reply_to, sent.conversation_id, sent.text], ["a4", GOA, "Make it two nights"]);
    await x.p.click("#pip-convs");
    await x.p.click(`#conv-menu [data-conv="${"conv_" + "f".repeat(32)}"]`);
    await x.p.waitForSelector(message("a2"));
    assert.equal(await chip(x.p), "Sunday has a 5:40 pm and a 7:15 pm back to Mumbai. Which one?", "the first one's quote is still in its box");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a runtime before Pips API 83 has the tick, no Reply, and is never sent reply_to", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ api: 82 });
  try {
    assert.equal(await x.p.locator(`${message("m1")} .msg-read[data-read="read"]`).count(), 1, "it has said which messages were read since API 73");
    assert.equal(await x.p.locator(`[data-chat-action="reply"]`).count(), 0);
    await x.p.fill("#chatText", "Hello");
    await x.p.press("#chatText", "Enter");
    await x.p.waitForFunction(() => window.__sent.some((r) => r.type === "send_pip_message"));
    assert.equal("reply_to" in (await sends(x.p))[0], false);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("at 300 px, dark and light, the quote in the box and the lines in the chat stay inside it", async (t) => {
  if (skipOrFail(t)) return;
  const folder = process.env.DGC_TICKS_PICTURES || "";
  if (folder) mkdirSync(folder, { recursive: true });
  for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
    const x = await open({ width, theme, ticks: "working", height: width === 300 ? 1180 : 900 });
    try {
      await x.p.hover(message("a2"));
      await x.p.click(`${message("a2")} [data-chat-action="reply"]`);
      await x.p.waitForSelector(".chat-reply");
      const facts = await inPage(x.p, (root) => {
        const form = root.querySelector("#chat-form").getBoundingClientRect(), c = root.querySelector(".chat-reply"), box = c.getBoundingClientRect(), log = root.querySelector(".conversation-log"), x = c.querySelector("[data-reply-remove]").getBoundingClientRect();
        return { inside: box.left >= form.left && box.right <= form.right + 0.5, height: Math.round(box.height), remove: x.right <= box.right + 0.5 && x.width >= 20, sideways: log.scrollWidth > log.clientWidth + 1,
          page: document.documentElement.scrollWidth > window.innerWidth, quotes: [...root.querySelectorAll(".conversation-log .msg-quote")].every((q) => q.getBoundingClientRect().height <= 20) };
      });
      assert.deepEqual(facts, { inside: true, height: 32, remove: true, sideways: false, page: false, quotes: true }, `${theme} ${width}`);
      assert.ok(grey(await ink(x.p, ".chat-reply .chat-reply-text")), "the quote is quiet grey");
      if (folder) {
        await x.p.mouse.move(2, 2);
        await x.p.screenshot({ path: `${folder}/ticks-${theme}-${width}.png` });
        await x.p.hover(message("a2"));
        await x.p.screenshot({ path: `${folder}/ticks-${theme}-${width}-hover.png` });
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});
