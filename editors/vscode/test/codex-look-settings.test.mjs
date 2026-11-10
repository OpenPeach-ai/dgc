// Settings in the 0.52 look, in real Chromium on the real Settings page: the side menu is 200 px wide with 30 px rows in
// 12 px words, quiet until chosen, and folds to a 54 px column of icons (by its button, and by itself under 620 px);
// the page fills the width it has, with no empty bar down the right; a group is a card on a 20 px corner with hairlines;
// Save is the text colour, filled, and only a switch that is on is purple; and under 620 px a row puts its control
// under its words. Dark and light, at 300, 500, 900 and 1400 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull, isPurple, look, tokenColours } from "./support/look-probe.mjs";

const chromium = await chromiumOrNull();
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

import { openSettingsGeneral } from "./support/codex-look-scene.mjs";

const box = (page, selector) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }, selector);

for (const theme of ["dark", "light"]) for (const width of [300, 500, 900, 1400]) {
  test(`the page fills its width and the side menu is the right size (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openSettingsGeneral(browser, { theme, width });
    try {
      const side = await box(x.page, ".sidebar"), card = await box(x.page, ".group .rows"), main = await box(x.page, "main");
      assert.equal(Math.round(side.width), width < 620 ? 54 : 200, "the side menu: 200 px, or a 54 px column of icons in a narrow tab");
      const gutter = width < 620 ? 12 : 16;
      assert.ok(Math.abs(card.left - (main.left + gutter)) <= 1, `a card starts ${gutter}px into the page: ${card.left - main.left}`);
      assert.ok(Math.abs(width - card.right - gutter) <= 1, `and ends ${gutter}px from the window's edge, at any width: ${width - card.right}`);
      const row = await look(x.page, ".sidebar nav button:not(.active)"), chosen = await look(x.page, ".sidebar nav button.active");
      const token = await tokenColours(x.page, ["--text-2", "--text", "--solid", "--on-solid", "--accent-fill"]);
      assert.deepEqual([row.height, row.size, row.corner], [30, "12px", "12.5px"], "a menu row");
      assert.deepEqual([row.words, chosen.words], [token["--text-2"], token["--text"]], "quiet until chosen");
      assert.notEqual(chosen.fill, "rgba(0, 0, 0, 0)", "the chosen row is raised");
      assert.equal(isPurple(chosen.fill), false);
      const group = await look(x.page, ".group .rows");
      assert.equal(group.corner, "20px", "a group's card");
      const save = await look(x.page, "#save");
      assert.deepEqual([save.fill, save.words, save.corner], [token["--solid"], token["--on-solid"], "9999px"], "Save: the text colour, filled, a pill");
      assert.equal((await look(x.page, ".switch.on")).fill, token["--accent-fill"], "a switch that is on stays purple");
      const sideways = await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.querySelector("main").scrollWidth > document.querySelector("main").clientWidth + 1);
      assert.equal(sideways, false, "no sideways scroll");
      // A row: its control beside its words, or under them in a narrow tab.
      const words = await box(x.page, ".field:has(> input) .words, .field:has(> input) > span:first-child"), control = await box(x.page, ".field > input");
      if (width < 620) assert.ok(control.top >= words.bottom - 1 && control.width > card.width - 40, `under its words, as wide as the card: ${JSON.stringify([words, control])}`);
      else assert.ok(control.left >= words.right - 1 && control.top < words.bottom, `beside its words: ${JSON.stringify([words, control])}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

for (const theme of ["dark", "light"]) test(`the side menu folds to icons and opens again (${theme})`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await openSettingsGeneral(browser, { theme, width: 900 });
  try {
    await x.page.click("#collapse-nav");
    const side = await box(x.page, ".sidebar"), row = await box(x.page, ".sidebar nav button"), card = await box(x.page, ".group .rows");
    assert.equal(Math.round(side.width), 54);
    assert.deepEqual([Math.round(row.width), Math.round(row.height)], [29, 30], "each entry fills the column (54 less its two 12 px gutters and the hairline) with its icon");
    assert.equal(await x.page.evaluate(() => getComputedStyle(document.querySelector(".sidebar .nav-text")).display), "none");
    assert.ok(Math.abs(card.left - (side.right + 16)) <= 1 && Math.abs(900 - card.right - 16) <= 1, "the page takes the room the menu gave up");
    assert.equal(await x.page.getAttribute(".sidebar nav button", "title") !== null || await x.page.getAttribute(".sidebar nav button", "aria-label") !== null, true, "an icon still has its name");
    await x.page.click("#collapse-nav");
    assert.equal(Math.round((await box(x.page, ".sidebar")).width), 200);
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});
