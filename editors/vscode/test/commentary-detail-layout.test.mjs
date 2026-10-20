import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { CONTRAST_SOURCE, openThinkingPage } from "./render-thinking.mjs";
import { detailTurn, ONE_LINE } from "./support/commentary-detail-scene.mjs";

// A detailed mid-turn message as Chromium lays it out (jsdom checks the DOM in commentary-detail.test.mjs).
// It must read like an answer, not like one more progress line squeezed between tool rows: the room an
// answer gets above it (12px, where a progress line gets 4px under a tool row -- a more specific rule
// that a bare class pair would lose to) and the same below, full width but for the room its Copy needs
// on its last row, text as strong as the answer's, and still on screen after the turn ends.
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

const FACTS = `(contrastSource, oneLine) => {
  const contrast = eval(contrastSource);
  const blocks = [...document.querySelectorAll("#log .text")];
  const detail = blocks.find((n) => n.textContent.includes("Why the stock value is off"));
  const line = blocks.find((n) => n.textContent.includes(oneLine));
  const answer = document.querySelector(".answer .text.final");
  const box = (n) => n.getBoundingClientRect();
  const copy = detail.querySelector(":scope > .commentary-actions");
  const last = copy.previousElementSibling, first = detail.firstElementChild;
  const style = (n) => getComputedStyle(n);
  return {
    detailMarginTop: parseFloat(style(detail).marginTop), detailMarginBottom: parseFloat(style(detail).marginBottom),
    detailPadRight: parseFloat(style(detail).paddingRight), lineMarginTop: parseFloat(style(line).marginTop),
    detailAfterTool: detail.previousElementSibling?.matches(".tool-group, .tg-live") || false,
    copyOnLastRow: Math.abs(box(copy).bottom - box(detail).bottom) <= 1 && box(copy).top >= box(last).top,
    lastKeepsRoom: parseFloat(style(last).paddingRight) >= box(copy).width,
    firstFullWidth: Math.abs(box(first).width - box(detail).width) <= 1,
    visible: detail.checkVisibility() && box(detail).height > 60,
    detailColour: style(detail.querySelector("p")).color, answerColour: answer ? style(answer.querySelector("p") || answer).color : null,
    contrast: contrast(detail.querySelector("p")), widthGap: box(line).width - box(detail).width,
    overflow: Math.max(document.getElementById("log").scrollWidth - document.getElementById("log").clientWidth, 0),
  };
}`;

for (const [theme, width] of [["dark-modern", 460], ["light-modern", 900]]) {
  test(`a detailed mid-turn message reads like an answer (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openThinkingPage(browser, { theme, width, height: 1400, events: detailTurn(),
      config: { model: "deepseek-v4.1-flash:cloud" } });
    try {
      const facts = await page.evaluate(`(${FACTS})(${JSON.stringify(CONTRAST_SOURCE)}, ${JSON.stringify(ONE_LINE)})`);
      assert.equal(facts.detailAfterTool, true, "the scene puts it right under a tool row");
      assert.equal(facts.detailMarginTop, 12, "an answer's room above it, not a progress line's 4px");
      assert.equal(facts.lineMarginTop, 4, "a one-line update under a tool row keeps its 4px");
      assert.equal(facts.detailPadRight, 0, "no gutter down the whole message for a hover button");
      assert.ok(facts.firstFullWidth, "its first block uses the full width");
      assert.ok(facts.copyOnLastRow, "Copy sits on its last row, not in an empty row under it");
      assert.ok(facts.lastKeepsRoom, "and the last block keeps room for it, so it never covers text");
      assert.equal(facts.detailMarginBottom, 12, "the same room below it as above");
      assert.ok(facts.visible, "on screen after the turn ended");
      assert.equal(facts.detailColour, facts.answerColour, "as strong as the answer, not muted");
      assert.ok(facts.contrast >= 4.5, `readable (${facts.contrast.toFixed(2)}:1)`);
      assert.equal(facts.overflow, 0, "no sideways scroll");
    } finally {
      await page.close();
    }
  });
}
