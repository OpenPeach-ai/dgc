// One Pips in real Chromium: the side bar's real page with the real Pips view in its shadow root, on the stand-in DGC
// (test/support/one-pips-scene.mjs), at 300 and 700 px, dark and light. Read from the DOM, computed style and
// geometry: the search on top and the filter line at the left under it, both in the button family's shape (6 px
// corners, the button height: never a pill); each row's place; the flow's cards inside the chat's width with their
// answers in that shape; and the reports page, a table where there is room and stacked rows at 300 px (what and when on
// the first line, files and model under it). Nothing scrolls sideways.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GST, TONI_DIR, openOnePips } from "./support/one-pips-scene.mjs";

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

// What a selector's first match looks like: its box, its corner, and whether its words are cut.
const look = (x, selector) => x.inPips((root, s) => {
  const n = root.querySelector(s); if (!n) return null;
  const r = n.getBoundingClientRect(), c = getComputedStyle(n);
  return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10,
    radius: c.borderTopLeftRadius, display: c.display, shown: n.checkVisibility({ visibilityProperty: true }), text: n.textContent.trim(), cut: n.scrollWidth > n.clientWidth + 1 };
}, selector);
const sideways = (x) => x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`${theme} at ${width}px: the search is on top, the filter line at the left under it, both in the button family's shape`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, theme, scene: { fix: "ask" } });
    try {
      const search = await look(x, "#pip-search"), filter = await look(x, "#pips-filter"), attention = await look(x, ".attention"), list = await look(x, ".pips-one-list");
      assert.ok(search.bottom <= filter.top && filter.bottom <= attention.top && attention.bottom <= list.top, "search, then the filter line, then Needs attention, then the list");
      assert.equal(search.radius, "6px"); assert.equal(search.height, 28);
      assert.equal(filter.radius, "6px"); assert.equal(filter.height, 28);
      assert.ok(Math.abs(filter.left - search.left) <= 1, `the filter line starts at the left edge (${filter.left} against ${search.left})`);
      assert.ok(filter.width < search.width / 2, "as wide as its words, not the line");
      const word = await look(x, "#pips-filter .dgc-folder-k"), value = await look(x, "#pips-filter .dgc-folder-v");
      assert.equal(value.text, "All Pips"); assert.equal(word.shown, false, "it says the choice alone");
      assert.equal(await sideways(x), false, "nothing scrolls sideways");
      // Each row says where its Pip works; in a narrow list the way to the folder gives way and its name stays whole.
      const place = await x.inPips((root, id) => { const p = root.querySelector(`.pips-one-list [data-job="${id}"] .pip-row-place`), dir = p.querySelector(".pip-row-place-dir"), name = p.querySelector(".pip-row-place-name");
        return { dir: dir.checkVisibility(), name: name.textContent, whole: name.getBoundingClientRect().right <= p.getBoundingClientRect().right + 0.5, title: p.title }; }, GST);
      assert.equal(place.name, "toni_fabrics"); assert.equal(place.title, TONI_DIR); assert.equal(place.whole, true, "the folder's own name shows whole");
      assert.equal(place.dir, width > 420, width > 420 ? "with room, the way there too" : "narrow: the name alone");
      // The filter's menu is one shape with its button, and its rows are in view.
      await x.click("#pips-filter");
      await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot.querySelector(".dgc-folder-menu")); await x.page.waitForTimeout(450);
      const menu = await look(x, ".dgc-folder-menu");
      assert.ok(Math.abs(menu.left - filter.left) <= 1 && menu.top >= filter.bottom - 1, "the menu opens under its button, on its left edge");
      assert.ok(menu.right <= width, "inside the view");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${theme} at ${width}px: the flow's cards fit the chat, and their answers are buttons of the family`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, theme, scene: { fix: "ask" } });
    try {
      await x.openPip(GST); await x.waitIn(".pip-found-ask");
      const log = await look(x, ".conversation-log");
      for (const s of [".pip-found-findings", ".pip-found-ask", ".pip-found-waiting-line"]) { const b = await look(x, s); assert.ok(b && b.left >= log.left - 1 && b.right <= log.right + 1, `${s} is inside the chat (${JSON.stringify(b)})`); }
      for (const s of ["[data-flow-allow]", "[data-flow-no]"]) { const b = await look(x, s); assert.equal(b.radius, "6px", s); assert.equal(b.height, 28, s); assert.equal(b.cut, false, `${s} says its word whole`); }
      const allow = await look(x, "[data-flow-allow]"), no = await look(x, "[data-flow-no]");
      assert.equal(allow.top, no.top, "Allow and Not now are on one line");
      const titles = await x.inPips((root) => [...root.querySelectorAll(".pip-found-finding")].map((li) => { const t = li.querySelector(".pip-found-title"), f = li.querySelector(".pip-found-file"); return { cut: t.scrollWidth > t.clientWidth + 1, fileCut: f.scrollWidth > f.clientWidth + 1, under: f.getBoundingClientRect().top >= t.getBoundingClientRect().bottom - 2 }; }));
      if (width === 300) assert.ok(titles.every((v) => !v.cut && !v.fileCut && v.under), `narrow: each finding's words are whole, its file under them (${JSON.stringify(titles)})`);
      else assert.ok(titles.every((v) => !v.cut && !v.under), "with room: the finding and its file on one line");
      assert.equal(await sideways(x), false);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${theme} at ${width}px: the reports page is ${width === 300 ? "stacked rows: what and when first, files and model under" : "a table"}`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, theme, scene: { fix: "ask" } });
    try {
      await x.openPip(GST);
      await x.inPips((root) => [...root.querySelectorAll(".pip-topbar .pip-menu [data-tab]")].find((b) => b.dataset.tab === "runs").click());
      await x.waitIn("table.pip-reports"); await x.page.waitForTimeout(150);
      const got = await x.inPips((root) => { const box = (n) => { const r = n.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
        const row = root.querySelector("tbody tr.pip-report-row"), cell = (c) => row.querySelector(`.pip-report-${c}`), wrap = root.querySelector(".pip-reports-wrap");
        return { head: root.querySelector("table.pip-reports thead").getBoundingClientRect().height > 4, row: getComputedStyle(row).display, wrapScrolls: wrap.scrollWidth > wrap.clientWidth + 1, wrap: box(wrap),
          what: box(cell("what")), when: box(cell("when")), files: box(cell("files")), model: box(cell("model")), found: box(cell("found")) }; });
      assert.equal(got.wrapScrolls, false, "it fits its width"); assert.equal(await sideways(x), false);
      if (width === 300) {
        assert.equal(got.head, false, "no header row"); assert.equal(got.row, "grid");
        assert.ok(Math.abs(got.what.top - got.when.top) <= 2 && got.what.left < got.when.left, "what and when share the first line");
        assert.ok(got.files.top >= got.what.bottom - 1, "its files under that"); assert.ok(got.model.top >= got.files.bottom - 1, "then its model");
      } else {
        assert.equal(got.head, true, "a header row"); assert.equal(got.row, "table-row");
        assert.ok(got.when.right <= got.what.left + 1 && got.what.right <= got.files.left + 1 && got.files.right <= got.model.left + 1 && got.model.right <= got.found.right, "its columns side by side: When, What, Files, Model, Findings");
        assert.ok(got.found.right <= got.wrap.right + 1, "Findings is in view");
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
