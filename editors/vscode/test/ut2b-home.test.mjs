// User test round 2, Home. H2: the Folders card's "+1" chip said nothing: it says "1 more". (H3, the tab bar's glass
// where the editor draws no blur, is the owner's call: the glass stays.)
// H5: a kind's tag ("DESIGN") was wider than its small tile: a tag is never wider than its tile.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor, shot } from "./support/ut2b-common.mjs";
import { openGrid, ARTIFACTS, FOLDERS } from "./support/home-grid-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const LAYOUT = ["note", "recent", "token", "widgets", "artifacts", "folders", "pips", "chats", "work", "clock", "weather"];
const WITH_DESIGN = [...ARTIFACTS.slice(0, 2), ["design", "Bakery Landing Page", "work"], ...ARTIFACTS.slice(2)];
const short = (theme) => theme.replace("-modern", "");

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`H2, H5: the Folders card says how many more in words; no kind's tag is wider than its tile (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await openGrid(C.state.browser, { width, height: 1500, theme, layout: LAYOUT, artifacts: WITH_DESIGN });
    try {
      const p = x.page;
      const m = await p.evaluate(() => ({
        folders: (() => { const card = document.querySelector('.hc-card[data-card="folders"]'), n = card.querySelector(".hc-cnt, .hc-cap"); if (!n) return null; const r = n.getBoundingClientRect(), c = card.getBoundingClientRect();
          return { form: card.dataset.form, words: n.textContent.trim(), title: n.getAttribute("title") || "", in: r.right <= c.right && r.left >= c.left, cut: n.scrollWidth > n.clientWidth + 1 }; })(),
        tags: [...document.querySelectorAll("#home-hub .dgc-sheet-tag")].filter((n) => n.checkVisibility()).map((tag) => { const s = tag.closest(".dgc-sheet").getBoundingClientRect(), r = tag.getBoundingClientRect();
          return { words: tag.textContent, wide: Math.round(r.width * 10) / 10, tile: Math.round(s.width * 10) / 10, size: parseFloat(getComputedStyle(tag).fontSize), card: `${tag.closest(".hc-card")?.dataset.card}:${tag.closest(".hc-card")?.dataset.form}` }; }),
        tiles: document.querySelectorAll('#home-hub .hc-card[data-card="artifacts"] .dgc-sheet').length }));
      await shot(p, `h2-h5-home-cards-${short(theme)}-${width}`);
      assert.ok(m.tiles >= 1, "premise: the Artifacts card shows its tiles");
      for (const tag of m.tags) {
        assert.ok(tag.wide <= tag.tile + 0.5, `“${tag.words}” (${tag.wide}px) is no wider than its tile (${tag.tile}px), in ${tag.card}`);
        assert.ok(tag.size >= 6, `and still at a size to read (${tag.size}px)`);
      }
      if (width === 300) {
        assert.equal(m.folders?.form, "s", "premise: the small Folders card");
        assert.equal(m.folders.words, `${FOLDERS.rows.length - 1} more`, "in words, not “+N”");
        assert.match(m.folders.title, /more folders/);
        assert.ok(m.folders.in && !m.folders.cut, "whole, inside its card");
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}
