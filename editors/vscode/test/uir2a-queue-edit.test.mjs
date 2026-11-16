// 16 Nov call 66, in real Chromium on the real pages: a queued message can be edited in Work and in a Pip's chat, as
// ChatDGC's already could (media/messagequeue.js "Edit: back to the box").
// Work's queue is the backend's: Edit asks DGC to take the message out (queue_remove), and its words, @ marks and the
// Artifact chip go back in the box only when DGC says it is out (queue_changed). If it started first, the page says "It
// already started" and the box is left alone. A draft already in the box is never lost: the row asks before replacing it.
// A Pip's queue is the page's own: Edit takes the message out and gives it back to the box.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openPip, openWorkQueue } from "./support/uir2a-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const EDIT = '#queue-list [data-queue-role="edit"]';

test("66 Work: Edit takes a queued message out, and it is back in the box (words, mark, Artifact chip) once DGC confirms; changed and sent", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWorkQueue(browser);
  try {
    const { id, sent } = await x.queue("Also add a note to the changelog", { skill: true, output: "slides" });
    assert.deepEqual([sent.output, sent.skills], ["slides", ["fixture"]], "premise: it was queued with its mark and its Artifact choice");
    await x.openRows();
    let b = await x.box();
    assert.deepEqual([b.text.trim(), b.rows.length, b.output], ["", 1, ""], "premise: queued, the box empty, the chip back to Auto");
    assert.equal(await x.page.locator(EDIT).count(), 1, "the row offers Edit");
    assert.equal(await x.page.locator(EDIT).getAttribute("title"), "Edit: back to the box");
    await x.page.click(EDIT);
    assert.deepEqual((await x.posted("queueRemove")).map((m) => m.id), [id], "DGC is asked to take it out");
    b = await x.box();
    assert.equal(b.text.trim(), "", "nothing is in the box until DGC says it is out");
    await x.event({ type: "queue_changed", removed: id, order: [], count: 0 });
    b = await x.box();
    assert.match(b.text, /^Also add a note to the changelog/);
    assert.deepEqual(b.pills, ["fixture"], "its mark is back where it was");
    assert.match(b.output, /Slides/, "and its Artifact choice");
    assert.equal(b.focus, true, "the keyboard is in the box");
    assert.deepEqual(b.rows, [], "it left the queue");
    assert.equal(await x.page.evaluate((text) => [...document.querySelectorAll("#log .msg.user")].filter((n) => !n.hidden && n.textContent.includes(text)).length, "Also add a note"), 0, "and it is not in the transcript");
    await x.page.keyboard.press("End"); await x.page.keyboard.type(" today"); await x.page.keyboard.press("Alt+Enter"); await x.page.waitForTimeout(60);
    const again = (await x.posted("prompt")).pop();
    assert.match(again.text, /Also add a note to the changelog.*today/s);
    assert.deepEqual([again.output, again.skills], ["slides", ["fixture"]], "sent again with its mark and its Artifact choice");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("66 Work: if the message started before DGC could take it out, the page says so and leaves the box alone", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWorkQueue(browser);
  try {
    const { id } = await x.queue("Run the whole suite at the end");
    await x.openRows();
    await x.page.click(EDIT);
    // The reply before it ends, and its own turn starts, before the removal is read.
    await x.event({ type: "turn_end", turn_id: "t2", status: "completed", usage: {} });
    await x.event({ type: "turn_start", turn_id: "t3", prompt: "Run the whole suite at the end", request_id: id });
    await x.event({ type: "command_rejected", command: "queue_remove", reason: "not_queued", message: "That message is no longer waiting in the queue." });
    const b = await x.box();
    assert.equal(b.text.trim(), "", "the box is as it was");
    const lines = await x.page.evaluate(() => [...document.querySelectorAll("#log .sys, #log .msg.sys, #log .sysline")].map((n) => n.textContent.trim()));
    assert.equal(lines.filter((l) => /^It already started/.test(l)).length, 1, `one line says it already started (${JSON.stringify(lines.slice(-3))})`);
    assert.equal(lines.some((l) => /no longer waiting/.test(l)), false, "and not the backend's own words as well");
    assert.equal(await x.page.evaluate((text) => [...document.querySelectorAll("#log .msg.user")].filter((n) => !n.hidden && n.textContent.includes(text)).length, "Run the whole suite"), 1, "the message is in the transcript, sent");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("66 Work: a draft in the box is never lost: Edit asks before replacing it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWorkQueue(browser);
  try {
    const { id } = await x.queue("Also add a note to the changelog");
    await x.page.click("#input"); await x.page.keyboard.type("half a thought");
    await x.openRows();
    await x.page.click(EDIT);
    let b = await x.box();
    assert.match(b.ask, /Replace/, "the row asks");
    assert.deepEqual([(await x.posted("queueRemove")).length, b.text], [0, "half a thought"], "nothing is asked of DGC yet, and the draft is untouched");
    await x.page.click('#queue-list .dgc-queue-ask [data-queue-role="ask-keep"]');
    b = await x.box();
    assert.deepEqual([b.ask, b.text, b.rows.length, (await x.posted("queueRemove")).length], ["", "half a thought", 1, 0], "Keep: the draft stays, the message stays queued");
    await x.page.click(EDIT);
    await x.page.keyboard.press("Escape");
    assert.equal((await x.box()).ask, "", "Escape is Keep");
    await x.page.click(EDIT);
    await x.page.click('#queue-list .dgc-queue-ask [data-queue-role="ask-replace"]');
    assert.deepEqual((await x.posted("queueRemove")).map((m) => m.id), [id]);
    assert.equal((await x.box()).text, "half a thought", "still the draft until DGC confirms");
    await x.event({ type: "queue_changed", removed: id, order: [], count: 0 });
    b = await x.box();
    assert.equal(b.text.trim(), "Also add a note to the changelog");
    assert.equal(b.focus, true);
    // The replaced draft is one undo away.
    await x.page.keyboard.press("Control+Z"); await x.page.waitForTimeout(80);
    assert.equal((await x.box()).text.trim(), "half a thought", "Undo brings the draft back");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("66 Work: a draft typed while DGC was taking the message out is kept; the message waits beside it, unsent", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWorkQueue(browser);
  try {
    const { id } = await x.queue("Also add a note to the changelog");
    await x.openRows();
    await x.page.click(EDIT);
    await x.page.click("#input"); await x.page.keyboard.type("typed meanwhile");
    await x.event({ type: "queue_changed", removed: id, order: [], count: 0 });
    const b = await x.box();
    assert.equal(b.text, "typed meanwhile", "what was typed meanwhile is not replaced");
    const kept = await x.page.evaluate(() => [...document.querySelectorAll("#log .msg.user.rejected")].map((n) => ({ text: n.querySelector(".bubble").textContent, restore: !!n.querySelector("button.act") })));
    assert.equal(kept.length, 1, "the message is kept, marked not sent"); assert.match(kept[0].text, /Also add a note/); assert.equal(kept[0].restore, true, "with its Restore");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

for (const width of [300, 700]) {
  test(`66 a Pip's chat: Edit takes a queued message out and gives it back to the box; a draft there is asked about first (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPip(browser, { width, said: [], running: true });
    try {
      const p = x.page, value = () => p.evaluate(() => { const n = (window.__pipsRoot || document).querySelector("#chatText"); return (n.value ?? n.textContent ?? "").trim(); });
      const rows = () => p.locator("#chat-queue .dgc-queue-text").allTextContents();
      const type = async (text, key) => { await p.click("#chatText"); await p.keyboard.type(text); if (key) await p.keyboard.press(key); await p.waitForTimeout(60); };
      await p.waitForFunction(() => /mid-turn/.test((window.__pipsRoot || document).querySelector(".chat-send")?.getAttribute("aria-label") || ""));
      await type("Add the weather too", "Alt+Enter"); await type("And keep it under five lines", "Alt+Enter");
      assert.deepEqual(await rows(), ["Add the weather too", "And keep it under five lines"]);
      await p.click('#chat-tray .rail-chip[data-kind="queue"]');
      const edit = '#chat-queue .dgc-queue-row:nth-child(1) [data-queue-role="edit"]';
      assert.equal(await p.locator(edit).count(), 1, "the row offers Edit");
      await p.click(edit);
      assert.equal(await value(), "Add the weather too", "it is back in the box");
      assert.deepEqual(await rows(), ["And keep it under five lines"], "and out of the queue");
      assert.equal(await p.evaluate(() => { const root = window.__pipsRoot || document; return (root.activeElement || document.activeElement)?.id; }), "chatText", "the keyboard is in the box");
      // Now the box has a draft: the other row asks before replacing it.
      if (!(await p.locator("#chat-queue .dgc-queue-row").first().isVisible())) await p.click('#chat-tray .rail-chip[data-kind="queue"]');
      await p.click('#chat-queue .dgc-queue-row:nth-child(1) [data-queue-role="edit"]');
      assert.match(await p.locator("#chat-queue .dgc-queue-ask").textContent(), /Replace/);
      assert.equal(await value(), "Add the weather too", "the draft is untouched while it asks");
      await p.click('#chat-queue .dgc-queue-ask [data-queue-role="ask-keep"]');
      assert.deepEqual([await value(), (await rows()).length], ["Add the weather too", 1]);
      await p.click('#chat-queue .dgc-queue-row:nth-child(1) [data-queue-role="edit"]');
      await p.click('#chat-queue .dgc-queue-ask [data-queue-role="ask-replace"]');
      assert.equal(await value(), "And keep it under five lines");
      assert.deepEqual(await rows(), []);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// 79.2 (16 Nov): the extension keeps a queued message's restore copy across a window reload; it now carries the @ marks
// where they stood and the Artifact choice, and Restore puts both back, as Edit does.
test("79.2 Work: a queued message handed back after a window reload is restored with its words, its mark and its Artifact choice", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWorkQueue(browser);
  let restoreCopy, id;
  try {
    const q = await x.queue("Also add a note to the changelog", { skill: true, output: "slides" });
    id = q.id; restoreCopy = q.sent.restore;
    assert.equal(restoreCopy.output, "slides", "the copy the extension keeps has the Artifact choice");
    assert.ok(Array.isArray(restoreCopy.parts) && restoreCopy.parts.some((p) => p && typeof p === "object" && p.label === "fixture"), "and the mark where it stood");
  } finally { await x.page.close(); }
  // The window reloads: its backend died with the queue, and the next host hands the message back as not sent.
  const y = await openWorkQueue(browser);
  try {
    await y.send({ type: "prompts_unsent", items: [{ requestId: id, session: "", text: "Also add a note to the changelog", draft: restoreCopy }] });
    await y.page.waitForTimeout(150);
    const restore = y.page.locator('#log .msg.user.rejected button[aria-label="Restore unsent message"]');
    assert.equal(await restore.count(), 1, "it is back in the transcript as not sent, with Restore");
    await restore.click(); await y.page.waitForTimeout(80);
    const b = await y.box();
    assert.match(b.text, /^Also add a note to the changelog/);
    assert.deepEqual(b.pills, ["fixture"], "its mark is back where it was");
    assert.match(b.output, /Slides/, "and its Artifact choice");
    assert.deepEqual(y.errors, []);
  } finally { await y.page.close(); }
});
