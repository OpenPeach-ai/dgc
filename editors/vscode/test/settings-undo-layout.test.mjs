// The settings change line as real Chromium lays it out (0.52), dark and light, at 300 and 700 px: one quiet line in
// the chat's own small type; Undo is the chat's small button (the button family's 6 px corner and small height, never
// a pill) at the line's end, level with the line's first row of words; nothing runs off the side; the words and the
// answer ("Undone", or why not) read at 4.5:1.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { CHANGES, measureLines, openSettingsChanges } from "./support/settings-undo-scene.mjs";

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

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`the lines as they arrive: words, then Undo, inside the chat (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openSettingsChanges(browser, { theme, width, fresh: true });
    try {
      const m = await measureLines(x.page);
      assert.equal(m.lines.length, 3);
      assert.equal(m.sideways, 0, "the page never scrolls sideways");
      assert.deepEqual([m.family.radius, m.family.height], [6, 22], "the button family: 6 px, the small height");
      for (const [i, line] of m.lines.entries()) {
        assert.equal(line.state, "changed");
        assert.ok(line.box.left >= m.log.left - 0.5 && line.box.right <= m.log.right + 0.5, `line ${i} stays inside the chat`);
        const undo = line.undo;
        assert.equal(undo.text, "Undo");
        assert.equal(undo.radius, m.family.radius, "Undo's corner is the family's");
        assert.equal(undo.height, m.family.height, "Undo is the small button's height");
        assert.ok(undo.radius < undo.height / 2 - 2, "never a pill");
        assert.equal(undo.line, 1, "the small outline");
        assert.ok(undo.width >= 36 && undo.width <= 64, `Undo is as wide as its word (${undo.width})`);
        assert.ok(undo.right <= line.box.right + 0.5 && undo.right <= m.page, "Undo is on the page");
        // A turn paints nothing outside its own box: Undo's focus ring (2 px wide, 2 px off) has to fit inside it.
        assert.ok(undo.right + 4 <= m.turn.right + 0.01 && undo.left - 4 >= m.turn.left, `Undo's focus ring is whole (${m.turn.right - undo.right} px to the turn's edge)`);
        assert.ok(undo.left >= line.words.right - 0.5, "Undo comes after the words, never over them");
        // Level with the first row of the words (the words may wrap in a narrow side bar; Undo stays at the top).
        const middle = (line.words.first.top + line.words.first.bottom) / 2;
        assert.ok(Math.abs((undo.top + undo.bottom) / 2 - middle) <= 1.5, `Undo is level with the line's first row (${(undo.top + undo.bottom) / 2} vs ${middle})`);
        assert.ok(line.mark && Math.abs((line.mark.top + line.mark.bottom) / 2 - middle) <= 2.5, "the mark is level with the first row too");
        assert.ok(line.words.contrast >= 4.5, `the words read (${line.words.contrast})`);
        assert.ok(undo.contrast >= 4.5, `Undo reads (${undo.contrast})`);
        assert.ok(line.words.width >= 120, "the words keep room to be read");
      }
      // The lines are a quiet run: each no taller than its words need (Undo adds no height to a one-row line).
      if (width === 700) for (const line of m.lines) assert.ok(line.box.height <= 24, `one row at 700 px (${line.box.height})`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`answered: Undone, and one that couldn't be undone (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openSettingsChanges(browser, { theme, width });
    try {
      const m = await measureLines(x.page);
      assert.deepEqual(m.lines.map((line) => line.state), ["changed", "undone", "kept"]);
      assert.equal(m.sideways, 0);
      assert.deepEqual(m.lines.map((line) => !!line.undo), [true, false, false], "Undo goes away once answered");
      assert.equal(m.lines[1].text, `${CHANGES[1].words} · Undone`);
      assert.equal(m.lines[2].text, `${CHANGES[2].words} · work_helpers changed again since; nothing was undone.`);
      for (const line of m.lines.slice(1)) {
        assert.ok(line.said.contrast >= 4.5, `the answer reads (${line.said.contrast})`);
        assert.ok(line.box.right <= m.log.right + 0.5);
      }
      // Pointing at Undo lights the button itself, in the family's corner.
      const lit = await x.page.evaluate(() => {
        const undo = document.querySelector("#log .setting-change button"), line = undo.closest(".setting-change");
        undo.scrollIntoView({ block: "center" });
        const r = undo.getBoundingClientRect();
        return { rest: [getComputedStyle(undo).backgroundColor, getComputedStyle(line).backgroundColor], x: r.left + r.width / 2, y: r.top + r.height / 2,
          top: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === undo };
      });
      assert.ok(lit.top, "nothing lies over Undo");
      await x.page.mouse.move(lit.x, lit.y, { steps: 2 });
      await x.page.waitForTimeout(260);
      const now = await x.page.evaluate(() => { const undo = document.querySelector("#log .setting-change button"), line = undo.closest(".setting-change");
        return { fills: [getComputedStyle(undo).backgroundColor, getComputedStyle(line).backgroundColor], radius: parseFloat(getComputedStyle(undo).borderTopLeftRadius) }; });
      assert.notEqual(now.fills[0], lit.rest[0], "Undo lights up");
      assert.equal(now.fills[1], lit.rest[1], "the line it stands in does not");
      assert.equal(now.radius, 6);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
