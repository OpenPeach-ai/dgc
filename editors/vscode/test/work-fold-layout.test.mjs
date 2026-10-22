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
