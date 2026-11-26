// The "needs you" pill of a Pip's chat in real Chromium (26 Nov): the side bar's real page with the real Pips view in
// its shadow root, on the stand-in DGC (test/support/one-pips-scene.mjs), at 300 and 700 px, dark and light. What only
// you can do whose check is not in the chat is a pill on the bar over the prompt box, on one line with the other pills
// and inside the box's width; it opens the cards in the bar's popover, which fits the side bar. Read from the DOM,
// computed style and geometry. Nothing scrolls sideways.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GST, WAIT, WAIT2, WAIT3, openOnePips } from "./support/one-pips-scene.mjs";

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

const NEEDS = '#chat-tray .rail-chip[data-kind="needs"]';
// Every box asked for, by selector: each match's edges, corner and whether it shows.
const boxes = (x, selectors) => x.inPips((root, list) => Object.fromEntries(list.map((s) => [s, [...root.querySelectorAll(s)].map((n) => {
  const r = n.getBoundingClientRect(), c = getComputedStyle(n);
  return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, height: Math.round(r.height * 10) / 10,
    radius: c.borderTopLeftRadius, shown: n.checkVisibility({ visibilityProperty: true }), text: n.textContent.trim(), cut: n.scrollWidth > n.clientWidth + 1, color: c.color };
})])), selectors);
const sideways = (x) => x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
// One message waits in the Pip's queue, so the bar has a second pill beside this one.
const scene = { fix: "ask", more: 2, posts: true, chat: { [GST]: { messages: [], waiting: [{ id: "msg_" + "7".repeat(32), text: "Also look at March", created_at: new Date().toISOString() }] } } };

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`${theme} at ${width}px: the "needs you" pill is on the bar's one line with the other pills, inside the box's width`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, theme, scene });
    try {
      await x.openPip(GST); await x.waitIn(NEEDS); await x.waitIn('#chat-tray .rail-chip[data-kind="queue"]'); await x.page.waitForTimeout(200);
      const b = await boxes(x, [NEEDS, '#chat-tray .rail-chip[data-kind="queue"]', "#chat-tray", "#chat-form", `${NEEDS} .chip-num`, `${NEEDS} .chip-word`, `${NEEDS} > .codicon:first-child`,
        ".conversation-log .pip-found-waiting", ".conversation-log [data-flow-waiting]", "#chat-tray .rail-pop", "#chat-tray .rail-chips"]);
      const pill = b[NEEDS][0], queue = b['#chat-tray .rail-chip[data-kind="queue"]'][0], line = b["#chat-tray"][0], box = b["#chat-form"][0];
      assert.ok(pill.shown && queue.shown, `both pills show, neither behind "+N" (${JSON.stringify([pill, queue])})`);
      assert.equal(pill.top, queue.top, "on one line"); assert.equal(pill.height, 24); assert.equal(queue.height, 24);
      assert.equal(pill.radius, "6px", "the bar's own pill shape");
      assert.ok(pill.left >= box.left - 1 && pill.right <= box.right + 1, `inside the prompt box's width (${JSON.stringify({ pill, box })})`);
      assert.ok(pill.top >= line.top - 1 && pill.bottom <= line.bottom + 1 && line.bottom <= box.top + 6, "on the bar, which sits on the box");
      assert.equal(b["#chat-tray .rail-chips"][0].cut, false, "the line holds its pills whole");
      // Option A (26 Nov): "Needs you" and the purple count badge Home's tab and the Pips list use; no icon, no amber.
      assert.equal(b[`${NEEDS} .chip-num`][0].text, "2"); assert.equal(b[`${NEEDS} .chip-word`][0].text, "Needs you");
      assert.equal(b[`${NEEDS} > .codicon:first-child`].length, 0, "no icon of its own");
      const badge = await x.inPips((root, s) => { const n = root.querySelector(s + " .chip-num"), c = getComputedStyle(n), r = n.getBoundingClientRect();
        const probe = root.ownerDocument.createElement("span"); probe.className = "attention-count"; root.querySelector(".pip-composer-shell").append(probe);
        const want = getComputedStyle(probe).backgroundColor; probe.remove();
        return { bg: c.backgroundColor, want, fg: c.color, radius: parseFloat(c.borderTopLeftRadius), h: r.height, w: r.width }; }, NEEDS);
      assert.equal(badge.bg, badge.want, `the Pips list's own count badge colour (${JSON.stringify(badge)})`);
      assert.equal(badge.fg, "rgb(255, 255, 255)"); assert.ok(badge.radius >= badge.h / 2 - 0.5 && badge.h <= 18 && badge.w >= 17, `a round count (${JSON.stringify(badge)})`);
      assert.deepEqual(b[".conversation-log [data-flow-waiting]"].map((c) => c.text.slice(0, 19)), ["GSP wallet is empty"], "only the one under its own check is in the chat");
      assert.equal(b["#chat-tray .rail-pop"][0].shown, false, "closed");
      assert.equal(await sideways(x), false, "nothing scrolls sideways");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${theme} at ${width}px: its popover's cards fit the side bar, their answers are buttons of the family, and an answer takes its card`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, theme, scene });
    try {
      await x.openPip(GST); await x.waitIn(NEEDS); await x.page.waitForTimeout(200);
      await x.click(NEEDS); await x.waitIn("#chat-tray .rail-pop:not([hidden]) .pip-found-waiting"); await x.page.waitForTimeout(150);
      const b = await boxes(x, ["#chat-tray .rail-pop", "#chat-tray .rail-pop .pip-found-waiting", "#chat-tray .rail-pop [data-flow-waiting-answer]", "#chat-tray .rail-pop .dgc-card-title", "#chat-tray", ".pip-topbar", "#chat-tray .rail-pop-title"]);
      const pop = b["#chat-tray .rail-pop"][0], cards = b["#chat-tray .rail-pop .pip-found-waiting"], buttons = b["#chat-tray .rail-pop [data-flow-waiting-answer]"];
      const height = await x.page.evaluate(() => innerHeight);
      assert.equal(b["#chat-tray .rail-pop-title"][0].text, "Only you can do these");
      assert.ok(pop.left >= 0 && pop.right <= width && pop.top >= b[".pip-topbar"][0].bottom - 1 && pop.bottom <= b["#chat-tray"][0].top + 1 && pop.bottom <= height, `the popover is in view, between the header and the bar (${JSON.stringify(pop)})`);
      assert.equal(pop.cut, false, "it never scrolls sideways");
      assert.equal(cards.length, 2);
      for (const c of cards) assert.ok(c.shown && c.left >= pop.left && c.right <= pop.right && c.top >= pop.top && c.bottom <= pop.bottom, `a card is whole inside it (${JSON.stringify({ c, pop })})`);
      assert.deepEqual(b["#chat-tray .rail-pop .dgc-card-title"].map((n) => [n.text, n.cut]), [["Portal password expired", false], ["Bank asks for a new mandate", false]]);
      assert.equal(buttons.length, 6);
      for (const n of buttons) { assert.ok(n.left >= pop.left && n.right <= pop.right, `${n.text} is inside (${JSON.stringify(n)})`); assert.equal(n.cut, false, `${n.text} says its words whole`); assert.equal(n.radius, "6px"); }
      for (const n of buttons.filter((n) => n.text !== "Not a problem")) assert.equal(n.height, 28, `${n.text} is a button of the family`);
      assert.equal(await sideways(x), false);
      // The answer itself, from the popover.
      await x.click(`#chat-tray .rail-pop [data-flow-waiting-id="${WAIT2}"][data-flow-waiting-answer="done"]`);
      await x.page.waitForFunction((s) => document.getElementById("pips-host").shadowRoot.querySelector(s + " .chip-num")?.textContent === "1", NEEDS);
      assert.deepEqual((await x.requests("answer_pip_waiting")).at(-1), { type: "answer_pip_waiting", pip_id: GST, waiting_id: WAIT2, answer: "done" });
      assert.equal(await x.inPips((root, s) => root.querySelector(s + " .chip-word").textContent, NEEDS), "Needs you");
      assert.deepEqual(await x.inPips((root) => [...root.querySelectorAll("#chat-tray .rail-pop:not([hidden]) .pip-found-waiting")].map((c) => c.dataset.flowWaiting)), [WAIT3], "the other is still open");
      await x.click(`#chat-tray .rail-pop [data-flow-waiting-id="${WAIT3}"][data-flow-waiting-answer="later"]`);
      await x.page.waitForFunction((s) => !document.getElementById("pips-host").shadowRoot.querySelector(s), NEEDS);
      assert.equal(await x.inPips((root) => root.querySelector("#chat-tray .rail-pop").hidden), true, "the last answer closes it with its pill");
      assert.equal(await x.inPips((root, id) => root.querySelectorAll(`.conversation-log .pip-found-waiting[data-flow-waiting="${id}"]`).length, WAIT), 1, "the card under its check is where it was");
      assert.equal(await sideways(x), false);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
