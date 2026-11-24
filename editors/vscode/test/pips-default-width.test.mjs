// The Pips list at a side bar's default width (about 300 px) and up to 340 px. Seen live on the 0.52 upgrade test: the
// heading read "Your P…" beside its three buttons (the compact header began only under 298 px, a few pixels short of a
// real side bar's room), and the "Meet Core" card left a word a line beside its Create button. Here New Pip is its
// plus, so the heading is whole; the menu beside it opens inside the page; Create sits under the card's words.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { openPips } from "./support/dgc-look-scene.mjs";

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

const measure = (p) => p.evaluate(() => {
  const roots = [document]; for (const n of document.querySelectorAll("*")) if (n.shadowRoot) roots.push(n.shadowRoot);
  const pick = (sel) => { for (const r of roots) { const n = r.querySelector(sel); if (n) return n; } return null; };
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  const head = pick(".simple-home-head h2"), plus = pick("#simple-new"), words = pick(".core-offer span"), create = pick(".core-offer > button");
  const line = words ? parseFloat(getComputedStyle(words).lineHeight) || 18 : 18;
  return { head: head && { words: head.textContent, cut: head.scrollWidth > head.clientWidth + 1 }, plus: plus && box(plus),
    plusName: plus && (plus.getAttribute("aria-label") || plus.textContent.trim()), core: words && { lines: Math.round(box(words).h / line), create: create && box(create), words: box(words) },
    page: document.documentElement.clientWidth };
});

for (const theme of ["dark", "light"]) for (const width of [300, 340]) {
  test(`the Pips list at ${width}px: the heading whole beside New Pip's plus, its menu inside the page, Create under the Core card's words (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width, list: true });
    try {
      const m = await measure(x.p);
      assert.deepEqual([m.head?.words, m.head?.cut], ["Your Pips", false], "the heading is whole");
      assert.ok(m.plus && m.plus.w <= 30, `New Pip is its plus at this width (${m.plus?.w}px)`);
      assert.match(m.plusName || "", /New Pip/, "and still says New Pip to a screen reader");
      assert.ok(m.core, "premise: the Meet Core card shows");
      assert.ok(m.core.lines <= 2, `the card's words take at most two lines (${m.core.lines})`);
      assert.ok(m.core.create && m.core.create.top >= m.core.words.bottom - 1, "Create sits under them");
      // The menu beside it (Export team, Import...): open, it stays inside the page.
      const more = x.p.locator(".simple-home-actions .pip-menu > summary").first();
      if (await more.count()) {
        await more.click(); await x.p.waitForTimeout(250);
        const menu = await x.p.evaluate(() => { const roots = [document]; for (const n of document.querySelectorAll("*")) if (n.shadowRoot) roots.push(n.shadowRoot);
          for (const r of roots) { const n = r.querySelector(".simple-home-actions .pip-menu[open] .tabs-menu"); if (n) { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right }; } } return null; });
        assert.ok(menu && menu.left >= 0 && menu.right <= m.page + 0.5, `its menu is inside the page (${JSON.stringify(menu)} of ${m.page})`);
      }
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  });
}
