// The dialog a Work session's delete (or archive) opens when it owns Project Pips, in real Chromium on the side bar's
// own page (src/panel.ts, media/main.js, media/main.css), dark and light, at 700 and 300 px: it stays inside the
// window, its four Pips each wear their face beside their name, nothing overlaps, no button's words are cut, and its
// words clear 4.5:1.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openHome } from "./support/home-scene.mjs";
import { SESSION_PIPS_ASK, askSessionPips, measureSessionPips } from "./support/session-pips-scene.mjs";

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

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) for (const mode of ["delete", "archive"]) {
  test(`${theme} ${width}px: the ${mode} dialog fits, names four Pips with their faces, and reads whole`, async (t) => {
    if (skipOrFail(t)) return;
    const home = await openHome(browser, { width, height: 760, theme, tab: "work" });
    try {
      await askSessionPips(home.page, { ...SESSION_PIPS_ASK, mode });
      const m = await measureSessionPips(home.page);
      assert.ok(m.box.left >= 0 && m.box.right <= width && m.box.top >= 0 && m.box.bottom <= 760, `inside the window (${JSON.stringify(m.box)})`);
      assert.deepEqual(m.pips.map((p) => p.name), SESSION_PIPS_ASK.pips.map((p) => p.name));
      for (const p of m.pips) {
        assert.ok(p.face, `${p.name} wears its face`);
        assert.ok(p.faceRight <= p.nameLeft, `${p.name}: the face is before the name`);
        assert.ok(p.inside && !p.cut, `${p.name} is whole, inside the dialog`);
      }
      for (let i = 1; i < m.pips.length; i++) assert.ok(m.pips[i].top >= m.pips[i - 1].bottom - 0.5, "the Pips' rows don't overlap");
      assert.deepEqual(m.buttons.map((b) => b.word), ["Cancel", mode === "delete" ? "Delete session" : "Archive session"]);
      for (const b of m.buttons) assert.ok(!b.cut && b.inside && b.height === 28 && [104, 152].includes(b.width), `“${b.word}” is whole in the button's own box (${b.width}x${b.height})`);
      assert.ok(m.select.inside && m.select.width >= 120, `the session picker is inside and wide enough (${m.select.width})`);
      assert.equal(m.overlaps.length, 0, `nothing overlaps: ${m.overlaps.join("; ")}`);
      for (const w of m.words) assert.ok(w.ratio >= 4.5, `“${w.text}” reads at ${w.ratio}:1`);
      assert.deepEqual(home.errors, []);
      if (mode === "delete") {
        await home.page.click('.session-pips-dialog input[value="delete"]');
        await home.page.click(".session-pips-dialog .session-pips-confirm");
        const again = await measureSessionPips(home.page);
        assert.deepEqual(again.buttons.map((b) => [b.word, b.width]), [["Back", 104], ["Delete permanently", 152]]);
        for (const b of again.buttons) assert.ok(!b.cut && b.inside, `“${b.word}” is whole`);
        assert.ok(again.box.left >= 0 && again.box.right <= width && again.box.bottom <= 760);
        for (const w of again.words) assert.ok(w.ratio >= 4.5, `“${w.text}” reads at ${w.ratio}:1`);
      }
    } finally { await home.page.context().close(); }
  });
}
