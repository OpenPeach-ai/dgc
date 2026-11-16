// 16 Nov calls 68 and 67, in real Chromium on the real pages (test/support/uir2a-scene.mjs).
// 68: a sent message's bubble has 10 px corners on every surface (Work, ChatDGC, a Pip's chat), a message sent while a
//     reply runs too; the fold's Show more keeps the buttons' 6 px.
// 67: Latest is solid in every theme (a theme whose input ground is see-through let the transcript's text show through
//     it), and ChatDGC has one, behaving as Work's does.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, LONG, openChatDgc, openPip, openWork, pixelGap } from "./support/uir2a-scene.mjs";

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

const corners = (page, selector) => page.evaluate((sel) => {
  const all = (root, s, out = []) => { out.push(...root.querySelectorAll(s)); for (const n of root.querySelectorAll("*")) if (n.shadowRoot) all(n.shadowRoot, s, out); return out; };
  return all(document, sel).map((n) => { const s = getComputedStyle(n); return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].join(" "); });
}, selector);
const TEN = "10px 10px 10px 10px";

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  test(`68: a sent bubble has 10 px corners in Work, ChatDGC and a Pip's chat (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const work = await openWork(browser, { theme, width, prompts: ["Short one", LONG], running: true });
    try {
      await work.say("And keep 20 as the default");                       // sent while the reply runs: a steer's bubble
      const got = await corners(work.page, "#log .msg.user .bubble");
      assert.ok(got.length >= 4, `the prompts and the steer are drawn (${got.length})`);
      for (const c of got) assert.equal(c, TEN, "Work");
      assert.equal(await work.page.evaluate(() => [...document.querySelectorAll("#log .msg.user .bubble")].at(-1).textContent.includes("And keep 20")), true, "premise: the message sent mid-reply is a bubble");
      assert.deepEqual(await corners(work.page, "#log .prompt-fold"), ["6px 6px 6px 6px"], "Show more keeps the buttons' corner");
      assert.deepEqual(work.errors, []);
    } finally { await work.page.close(); }
    const chat = await openChatDgc(browser, { theme, width, prompts: ["Short one", LONG] });
    try { const got = await corners(chat.page, ".cd-bubble"); assert.equal(got.length, 2); for (const c of got) assert.equal(c, TEN, "ChatDGC"); assert.deepEqual(chat.errors, []); }
    finally { await chat.page.close(); }
    const pip = await openPip(browser, { theme, width, said: [{ role: "user", text: LONG }, { role: "assistant", text: "Noted." }] });
    try { const got = await corners(pip.page, ".pip-message.user .bubble"); assert.ok(got.length >= 3); for (const c of got) assert.equal(c, TEN, "a Pip's chat"); assert.deepEqual(pip.errors, []); }
    finally { await pip.close(); }
  });
}

/** The pill's picture with the transcript's words under it, and with them taken away: the same when it is solid. */
async function throughPill(page, pillSel, hide) {
  const pill = page.locator(pillSel);
  await page.mouse.move(2, 2);
  // (Its own arrow and word are taken out of both pictures: they are drawn a touch differently once nothing scrolls
  // under them, and it is the pill's ground that is being looked at.)
  const add = (css) => page.evaluate((text) => { const all = (root, out = [root]) => { for (const n of root.querySelectorAll("*")) if (n.shadowRoot) all(n.shadowRoot, out); return out; };
    for (const root of all(document)) { const s = document.createElement("style"); s.textContent = text; (root.head || root).append(s); } }, css);
  await add(`${pillSel} > * { visibility: hidden !important; }`);
  // (Inside its rounded corners: what is outside them is the transcript's, and is meant to show.)
  const box = await pill.boundingBox(), clip = { x: box.x + 7, y: box.y + 3, width: box.width - 14, height: box.height - 6 };
  const withText = await page.screenshot({ clip });
  await add(hide);
  const without = await page.screenshot({ clip });
  return pixelGap(page, withText, without);
}
const scrollUp = (page, sel, by = 400) => page.evaluate(([s, d]) => { const find = (root) => root.querySelector(s) || [...root.querySelectorAll("*")].map((n) => n.shadowRoot && find(n.shadowRoot)).find(Boolean);
  const box = find(document); box.dispatchEvent(new WheelEvent("wheel", { deltaY: -d, bubbles: true })); box.scrollTop -= d; }, [sel, by]).then(() => page.waitForTimeout(120));

for (const theme of ["cursor-dark", "light-cursor", "dark-modern"]) {
  test(`67: Work's Latest is solid over the transcript's words (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openWork(browser, { theme, width: 440 });
    try {
      await scrollUp(x.page, "#log");
      assert.equal(await x.page.evaluate(() => document.getElementById("to-latest").hidden), false, "premise: away from the end, Latest shows");
      assert.equal(await throughPill(x.page, "#to-latest", "#log > * { visibility: hidden !important; }"), 0, "nothing under it shows through");
    } finally { await x.page.close(); }
  });
  test(`67: a Pip chat's Latest is solid over the transcript's words (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    for (const width of [300, 700]) {
      const x = await openPip(browser, { theme, width });
      try {
        await scrollUp(x.page, ".conversation-log");
        assert.equal(await x.page.evaluate(() => (window.__pipsRoot || document).querySelector(".pip-to-latest").hidden), false, "premise: Latest shows");
        assert.equal(await throughPill(x.page, ".pip-to-latest", ".conversation-log > * { visibility: hidden !important; }"), 0, `nothing under it shows through (${width}px)`);
      } finally { await x.close(); }
    }
  });
  test(`67: ChatDGC's Latest is solid over the transcript's words (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChatDgc(browser, { theme, width: 440 });
    try {
      await scrollUp(x.page, "#cd-scroll");
      assert.equal(await x.page.evaluate(() => document.getElementById("cd-to-latest")?.hidden), false, "premise: ChatDGC has a Latest, and it shows");
      assert.equal(await throughPill(x.page, "#cd-to-latest", "#cd-log > * { visibility: hidden !important; }"), 0, "nothing under it shows through");
    } finally { await x.page.close(); }
  });
}

test("67: ChatDGC's Latest shows away from the end, says New when more arrives, and a click goes to the end with the keyboard in the box", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChatDgc(browser, { width: 440 });
  try {
    const state = () => x.page.evaluate(() => { const p = document.getElementById("cd-to-latest"), s = document.getElementById("cd-scroll");
      return p ? { hidden: p.hidden, unread: p.classList.contains("unread"), label: p.textContent.trim(), title: p.title, fromEnd: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
        focus: document.activeElement?.id || document.activeElement?.className || "" } : null; });
    assert.ok(await state(), "ChatDGC has a Latest");
    assert.equal((await state()).hidden, true, "at the end: no pill");
    await scrollUp(x.page, "#cd-scroll", 500);
    let s = await state();
    assert.deepEqual([s.hidden, s.unread, s.label], [false, false, "Latest"]);
    assert.equal(s.title, "Jump to the newest message");
    // More arrives while reading back: the view stays, and the pill says New.
    const { M } = await import("./support/chat-scene.mjs");
    await x.send({ type: "message", message: { id: M(8), role: "assistant", text: "One more thing: book early for March.", created_at: "2026-11-10T09:31:00Z", finish: "stop", model: "qwen3.8:27b" } });
    await x.page.waitForTimeout(150);
    s = await state();
    assert.ok(s.fromEnd > 300, `the reader stays where they were (${s.fromEnd}px from the end)`);
    assert.deepEqual([s.hidden, s.unread, s.label], [false, true, "New"]);
    await x.page.click("#cd-to-latest");
    await x.page.waitForTimeout(150);
    s = await state();
    assert.ok(s.fromEnd < 2, `at the end (${s.fromEnd})`);
    assert.equal(s.hidden, true);
    assert.equal(s.focus, "cd-input", "the keyboard is back in the box");
    // And it has Work's look: the same size, corner, type and ground.
    await scrollUp(x.page, "#cd-scroll", 500);
    const look = (page, sel) => page.evaluate((q) => { const n = document.querySelector(q), c = getComputedStyle(n), r = n.getBoundingClientRect();
      return { height: r.height, corner: c.borderTopLeftRadius, font: `${c.fontWeight} ${c.fontSize}`, pad: c.paddingLeft, shadow: c.boxShadow, image: c.backgroundImage }; }, sel);
    const w = await openWork(browser, { width: 440 });
    try { await scrollUp(w.page, "#log"); assert.deepEqual(await look(x.page, "#cd-to-latest"), await look(w.page, "#to-latest"), "one look"); } finally { await w.page.close(); }
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});
