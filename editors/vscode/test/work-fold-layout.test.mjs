import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { CONTRAST_SOURCE, openThinkingPage } from "./render-thinking.mjs";
import { detailTurn } from "./support/commentary-detail-scene.mjs";

// A turn's work folded into its "Worked for" row, as Chromium draws it (work-fold.test.mjs checks the
// DOM). Folded, nothing of the work is drawn: the row heads the turn, then what stays (the detailed
// message), then the answer. The row reads as a control (a chevron, readable ink) and opens the work in
// place UNDER it, between the row and the answer, without moving itself; a second click folds it again.
// DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure.
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const FACTS = `(contrastSource) => {
  const contrast = eval(contrastSource);
  const block = document.querySelector("#log .msg.dgc");
  const row = block.querySelector(":scope > .work-toggle");
  const box = (n) => n.getBoundingClientRect();
  const drawn = (n) => n.checkVisibility() && box(n).height > 0;
  const steps = [...block.querySelectorAll(":scope > .work-step")];
  const detail = block.querySelector(":scope > .text.commentary-detail");
  const answer = block.querySelector(":scope > .answer");
  const firstDrawn = [...block.children].find((n) => !n.matches(".role") && drawn(n));
  return {
    folded: block.classList.contains("work-folded"), expanded: row.getAttribute("aria-expanded"),
    rowTop: Math.round(box(row).top), rowBottom: box(row).bottom, rowHeight: box(row).height,
    rowFirst: firstDrawn === row, chevron: getComputedStyle(row, "::after").content,
    stepsDrawn: steps.filter(drawn).length, steps: steps.length,
    stepsBetween: steps.every((n) => box(n).top >= box(row).bottom - 0.5 && box(n).bottom <= box(answer).top + 0.5),
    detailDrawn: drawn(detail), detailBelowRow: box(detail).top >= box(row).bottom,
    answerDrawn: drawn(answer), answerBelow: box(answer).top >= box(row).bottom,
    contrast: contrast(row), cursor: getComputedStyle(row).cursor,
    overflow: Math.max(document.getElementById("log").scrollWidth - document.getElementById("log").clientWidth, 0),
  };
}`;
const facts = (page) => page.evaluate(`(${FACTS})(${JSON.stringify(CONTRAST_SOURCE)})`);

for (const [theme, width] of [["dark-modern", 460], ["light-modern", 900]]) {
  test(`folded, the work is not drawn; opened by a click it is drawn under the row, which stays put (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openThinkingPage(browser, { theme, width, height: 1400, events: detailTurn(),
      config: { model: "deepseek-v4.1-flash:cloud" } });
    try {
      const folded = await facts(page);
      assert.equal(folded.folded, true);
      assert.equal(folded.steps, 5, "two progress lines and three tool lines");
      assert.equal(folded.stepsDrawn, 0, "none of the work is drawn");
      assert.ok(folded.rowFirst, "the row heads the turn");
      assert.ok(folded.detailDrawn && folded.detailBelowRow, "the detailed message stays, under the row");
      assert.ok(folded.answerDrawn && folded.answerBelow, "and the answer");
      assert.equal(folded.chevron, '"›"', "a chevron says it opens, like a tool group's line");
      assert.equal(folded.cursor, "pointer");
      assert.ok(folded.rowHeight <= 24, `one line (${folded.rowHeight}px)`);
      assert.ok(folded.contrast >= 4.5, `readable as a control (${folded.contrast.toFixed(2)}:1)`);
      assert.equal(folded.overflow, 0);

      await page.click("#log .work-toggle");
      const opened = await facts(page);
      assert.equal(opened.folded, false);
      assert.equal(opened.expanded, "true");
      assert.equal(opened.stepsDrawn, 5, "every step is drawn again");
      assert.ok(opened.stepsBetween, "under the row and above the answer, where they happened");
      assert.equal(opened.rowTop, folded.rowTop, "the row did not move under the pointer");
      assert.equal(opened.chevron, '"⌄"');
      assert.equal(opened.overflow, 0);

      await page.click("#log .work-toggle");
      const again = await facts(page);
      assert.equal(again.folded, true);
      assert.equal(again.stepsDrawn, 0);
      assert.equal(again.rowTop, folded.rowTop);
    } finally {
      await page.close();
    }
  });
}

test("the row takes keyboard focus: Enter opens it, Space folds it, and the focus ring shows", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openThinkingPage(browser, { theme: "dark-modern", width: 460, height: 1400, events: detailTurn(),
    config: { model: "deepseek-v4.1-flash:cloud" } });
  try {
    await page.focus("#log .work-toggle");
    await page.keyboard.press("Enter");
    assert.equal((await facts(page)).expanded, "true");
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert.notEqual(ring, "none", "keyboard focus is visible");
    await page.keyboard.press("Space");
    const after = await facts(page);
    assert.equal(after.expanded, "false");
    assert.equal(after.stepsDrawn, 0);
  } finally {
    await page.close();
  }
});

// A user's .111 Docker build (25 Oct): two commands run in the background exited while the turn worked, and
// their cards (up to 40 lines of build output each) stayed drawn under the answer. Folded, they are not drawn;
// opened, they are drawn under the row with the rest of the work.
test("a background command's card folds with the work and opens under the row (dark-modern, 460px)", async (t) => {
  if (skipOrFail(t)) return;
  const events = detailTurn();
  const exited = (id) => ({ type: "monitor_event", id, description: `docker build ${id}`, event_index: 1,
    lines: [`background task ${id} exited 0 after 20s`, ...Array.from({ length: 30 }, (_, i) => `#${i} DONE 0.${i}s`)],
    omitted_lines: 0, kind: "background_exit", delivery: "inline", turn_id: "t1" });
  events.splice(9, 0, exited("bg1"), exited("bg2"));
  const page = await openThinkingPage(browser, { theme: "dark-modern", width: 460, height: 1400, events,
    config: { model: "deepseek-v4.1-flash:cloud" } });
  try {
    const cards = () => page.evaluate(() => {
      const block = document.querySelector("#log .msg.dgc");
      const row = block.querySelector(":scope > .work-toggle").getBoundingClientRect();
      const answer = block.querySelector(":scope > .answer").getBoundingClientRect();
      return [...block.querySelectorAll(":scope > .monitor-event")].map((n) => {
        const box = n.getBoundingClientRect();
        return { drawn: n.checkVisibility() && box.height > 0, between: box.top >= row.bottom - 0.5 && box.bottom <= answer.top + 0.5 };
      });
    });
    const folded = await cards();
    assert.equal(folded.length, 2);
    assert.ok(folded.every((c) => !c.drawn), "folded, neither card is drawn");
    await page.click("#log .work-toggle");
    const opened = await cards();
    assert.ok(opened.every((c) => c.drawn && c.between), "opened, both are drawn under the row, above the answer");
  } finally {
    await page.close();
  }
});

// A turn split by a message sent mid-turn (reported 28 Oct: one "Worked for 3837s" row above the message, as if the
// whole hour came before it): a row above the message, one under it, each opening its own part in place without
// moving, and the message keeps the spacing it has with nothing folded.
const SPLIT = `() => {
  const block = document.querySelector("#log .msg.dgc");
  const box = (n) => n.getBoundingClientRect();
  const drawn = (n) => n.checkVisibility() && box(n).height > 0;
  const rows = [...block.querySelectorAll(":scope > .work-toggle")];
  const you = block.querySelector(":scope > .msg.user"), answer = block.querySelector(":scope > .answer");
  const steps = [...block.querySelectorAll(":scope > .work-step")];
  const before = steps.filter((n) => n.compareDocumentPosition(you) & Node.DOCUMENT_POSITION_FOLLOWING);
  const after = steps.filter((n) => !before.includes(n));
  const shown = [...block.children].filter((n) => !n.matches(".role") && drawn(n));
  const prev = shown[shown.indexOf(you) - 1], next = shown[shown.indexOf(you) + 1];
  return {
    rows: rows.map((n) => ({ text: n.textContent, top: Math.round(box(n).top), height: box(n).height,
      chevron: getComputedStyle(n, "::after").content })),
    order: rows.length === 2 && box(rows[0]).bottom <= box(you).top && box(you).bottom <= box(rows[1]).top
      && box(rows[1]).bottom <= box(answer).top,
    beforeDrawn: before.filter(drawn).length, afterDrawn: after.filter(drawn).length, before: before.length, after: after.length,
    beforeBetween: before.every((n) => !drawn(n) || (box(n).top >= box(rows[0]).bottom - 0.5 && box(n).bottom <= box(you).top + 0.5)),
    afterBetween: after.every((n) => !drawn(n) || (box(n).top >= box(rows[1]).bottom - 0.5 && box(n).bottom <= box(answer).top + 0.5)),
    gapAbove: Math.round(box(you).top - box(prev).bottom), gapBelow: Math.round(box(next).top - box(you).bottom),
    overflow: Math.max(document.getElementById("log").scrollWidth - document.getElementById("log").clientWidth, 0),
  };
}`;
for (const [theme, width] of [["dark-modern", 460], ["light-modern", 900]]) {
  test(`a turn split by a message sent mid-turn: a row above it and one under it, each opening its own part (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const { READY, splitTurn } = await import("./support/split-turn-scene.mjs");
    const page = await openThinkingPage(browser, { theme, width, height: 1400,
      events: [READY, { type: "history", complete: true, items: splitTurn() }], config: { model: "deepseek-v4.1-flash:cloud" } });
    try {
      const split = () => page.evaluate(`(${SPLIT})()`);
      const folded = await split();
      assert.deepEqual(folded.rows.map((r) => r.text), ["Worked for 18m 12s", "Worked for 45m 45s"]);
      assert.ok(folded.order, "row, the message, row, the answer");
      assert.ok(folded.rows.every((r) => r.height <= 24 && r.chevron === '"›"'), JSON.stringify(folded.rows));
      assert.deepEqual([folded.beforeDrawn, folded.afterDrawn], [0, 0], "none of the work is drawn");
      if (process.env.DGC_SHOT_DIR) await page.screenshot({ path: `${process.env.DGC_SHOT_DIR}/split-folded-${theme}.png` });

      await page.locator("#log .work-toggle").nth(1).click();
      const second = await split();
      assert.deepEqual([second.beforeDrawn, second.afterDrawn], [0, second.after], "only what came after the message");
      assert.ok(second.afterBetween, "under its row, above the answer");
      assert.deepEqual(second.rows.map((r) => r.chevron), ['"›"', '"⌄"']);
      assert.equal(second.rows[1].top, folded.rows[1].top, "the row did not move under the pointer");
      if (process.env.DGC_SHOT_DIR) await page.screenshot({ path: `${process.env.DGC_SHOT_DIR}/split-second-open-${theme}.png` });

      await page.locator("#log .work-toggle").nth(0).click();
      const both = await split();
      assert.deepEqual([both.beforeDrawn, both.afterDrawn], [both.before, both.after]);
      assert.ok(both.beforeBetween, "what came first is under the top row, above the message");
      assert.equal(both.rows[0].top, folded.rows[0].top);
      // Folded or open, the message is spaced as it is with nothing folded.
      assert.deepEqual([folded.gapAbove, folded.gapBelow], [both.gapAbove, both.gapBelow],
        `folded ${folded.gapAbove}/${folded.gapBelow}, open ${both.gapAbove}/${both.gapBelow}`);
      assert.equal(both.overflow, 0);
      if (process.env.DGC_SHOT_DIR) await page.screenshot({ path: `${process.env.DGC_SHOT_DIR}/split-both-open-${theme}.png` });
    } finally {
      await page.close();
    }
  });
}
