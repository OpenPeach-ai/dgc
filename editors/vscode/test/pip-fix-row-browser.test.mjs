// How the fix's helper row looks (media/main.css .pip-report.is-fix-row; what it does is pip-fix-row.test.mjs), in real
// Chromium on Work's real page (support/agent-lines-scene.mjs), dark and light, at 300 and 700 px: Fix takes the card's
// box away and leaves a row like a helper's own, beside a real helper's row to compare with: the same mark size, the
// same left edge, the same words' size and tone; its answers inside the panel; done, Review and Undo on the row; a
// refused start draws the card again.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openAgentLines, sendEvents, settle, CONTRAST_SOURCE } from "./support/agent-lines-scene.mjs";
import { SCENE, FIXING, FIXED } from "./support/pip-fix-row-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

/** The report's node and a real helper's row, as drawn. */
const look = (page) => page.evaluate((contrastSource) => {
  const contrast = new Function(`return ${contrastSource}`)();
  const card = document.querySelector("#log .pip-report"), helper = document.querySelector("#log .agent-line"), r = (n) => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().width > 0, css = (n) => getComputedStyle(n);
  const mark = card.querySelector(".pip-fix-who .agent-mark"), name = card.querySelector(".pip-fix-name"), text = card.querySelector(".pip-fix-text"), hMark = helper?.querySelector(".agent-mark"), hName = helper?.querySelector(".agent-name");
  return { row: card.classList.contains("is-fix-row"), box: r(card), border: css(card).borderTopWidth, ground: css(card).backgroundColor, padLeft: css(card).paddingLeft,
    reportSeen: [...card.querySelectorAll(".pip-report-line1, .pip-report-line2, .pip-report-head, .pip-report-findings, .pip-report-face, .pip-report-fix-slim")].filter(seen).length,
    mark: mark ? { ...r(mark), size: [css(mark).width, css(mark).height], img: !!mark.querySelector("img")?.naturalWidth, live: mark.classList.contains("is-live") } : null, name: name ? { ...r(name), text: name.textContent, size: css(name).fontSize, color: css(name).color, ratio: contrast(name) } : null,
    text: text ? { text: text.textContent, seen: seen(text), ratio: contrast(text), whole: text.scrollWidth <= text.clientWidth + 1 } : null,
    helper: helper ? { mark: r(hMark), size: css(hName).fontSize, color: css(hName).color, height: r(helper).height } : null,
    actions: [...card.querySelectorAll(".pip-fix-actions button, .pip-fix-dismiss")].filter(seen).map((b) => ({ word: b.textContent || b.getAttribute("aria-label"), ...r(b) })),
    lineHeight: r(card.querySelector(".pip-fix-line") || card).height, vw: innerWidth, sideways: document.documentElement.scrollWidth > innerWidth || document.getElementById("log").scrollWidth > document.getElementById("log").clientWidth + 1 };
}, CONTRAST_SOURCE);

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`${theme} ${width}px: Fix takes the card away and leaves a helper row: a helper's mark, name and tone, its answers inside the panel`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openAgentLines(browser, { width, theme, events: SCENE });
    try {
      const card = await look(page);
      assert.deepEqual([card.row, card.border], [false, "1px"], "a report is a card, with its box");
      assert.ok(card.reportSeen >= 3, "its face, its lines and Fix are in sight");
      await page.click("#log .pip-report .pip-report-fix-slim"); await settle(page);
      const starting = await look(page);
      assert.deepEqual([starting.row, starting.border, starting.ground, starting.reportSeen, starting.text.text], [true, "0px", "rgba(0, 0, 0, 0)", 0, "Starting"], "pressed: the box and the report's words are gone at once");
      await sendEvents(page, FIXING); await settle(page);
      const v = await look(page);
      assert.deepEqual([v.row, v.border, v.ground, v.reportSeen], [true, "0px", "rgba(0, 0, 0, 0)", 0], "no box, none of the card's words");
      assert.deepEqual([v.name.text, v.text.seen], ["Fix what Billing review found", true]);
      assert.match(v.text.text, /^Fixing · .+pytest -q billing$/, "what it is doing now");
      // A helper's row, beside a real one: the same mark, edge and words.
      // (A live mark breathes: its drawn box swells a little, so its own size is read, and the two marks' centres compared.)
      assert.deepEqual([v.mark.size, v.mark.img, v.mark.live], [["16px", "16px"], true, true], "the helper's mark, 16 px, live");
      assert.ok(Math.abs((v.mark.left + v.mark.right) / 2 - (v.helper.mark.left + v.helper.mark.right) / 2) <= 1, `on a helper row's left edge (${v.mark.left} / ${v.helper.mark.left})`);
      assert.deepEqual([v.name.size, v.name.color], [v.helper.size, v.helper.color], "its name in a helper row's size and tone");
      assert.ok(v.name.ratio >= 4.5 && v.text.ratio >= 4.5, `its words read at 4.5:1 (${v.name.ratio}, ${v.text.ratio})`);
      assert.ok(v.lineHeight <= (width === 300 ? 70 : 26), `a row, not a card: ${v.lineHeight}px (a helper's row is ${v.helper.height}px)`);
      assert.deepEqual(v.actions.map((a) => a.word), ["Watch", "Stop"]);
      assert.ok(v.actions.every((a) => a.left >= 0 && a.right <= v.vw), `its answers are inside the panel: ${JSON.stringify(v.actions)}`);
      assert.equal(v.sideways, false, "nothing runs off the side");
      // Done: what changed, Review and Undo on the row; opened, its files under it.
      await sendEvents(page, FIXED); await settle(page);
      const done = await look(page);
      assert.deepEqual([done.row, done.border, done.reportSeen, done.text.text, done.mark.live], [true, "0px", 0, "Fixed · 3 files changed", false]);
      assert.deepEqual(done.actions.map((a) => a.word), ["Review", "Undo", "Watch", "Dismiss"]);
      assert.ok(done.actions.every((a) => a.left >= 0 && a.right <= done.vw) && !done.sideways, `inside the panel: ${JSON.stringify(done.actions)}`);
      await page.click("#log .pip-report .pip-fix-toggle"); await settle(page);
      const files = await page.evaluate(() => [...document.querySelectorAll("#log .pip-fix-files .pip-fix-file")].map((b) => { const r = b.getBoundingClientRect(); return [b.textContent, r.left >= 0 && r.right <= innerWidth && r.width > 0]; }));
      assert.deepEqual(files, [["billing/totals.py", true], ["billing/notes.py", true], ["tests/test_totals.py", true]]);
      assert.equal((await look(page)).sideways, false);
    } finally { await page.close(); }
  });
}

test("a refused start draws the card again, box and all; the keyboard reaches the row's name and answers", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openAgentLines(browser, { width: 300, events: SCENE });
  try {
    await page.click("#log .pip-report .pip-report-fix-slim"); await settle(page);
    assert.equal((await look(page)).row, true);
    await sendEvents(page, [{ type: "command_rejected", command: "start_pip_fix", reason: "plan_mode", message: "This chat is in Plan mode, where DGC changes nothing." }]); await settle(page);
    const back = await look(page);
    assert.deepEqual([back.row, back.border], [false, "1px"], "the card is back");
    assert.ok(back.reportSeen >= 3 && await page.locator("#log .pip-report .pip-report-fix-slim").isVisible(), "with its words and its Fix");
    // Asked again and started: Tab goes through the row's name and its answers, each with a ring.
    await page.click("#log .pip-report .pip-report-fix-slim"); await sendEvents(page, FIXING); await settle(page);
    await page.focus("#log .pip-report .pip-fix-name"); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");   // (reached by the keyboard, so its ring shows)
    const stops = [];
    for (let i = 0; i < 3; i++) { stops.push(await page.evaluate(() => { const a = document.activeElement, s = getComputedStyle(a); return [a.className.split(" ").find((c) => c.startsWith("pip-fix-")), s.outlineStyle !== "none"]; })); await page.keyboard.press("Tab"); }
    assert.deepEqual(stops, [["pip-fix-name", true], ["pip-fix-act", true], ["pip-fix-act", true]], "its name, Watch, Stop");
  } finally { await page.close(); }
});
