// Give it a folder, and Remove its folder, in real Chromium (Pips API 110): the side bar's real page with the real Pips
// view, on the stand-in DGC (test/support/one-pips-scene.mjs), at 300, 440 and 700 px, dark and light. Read from the DOM,
// computed style and geometry: the page's "Works in" row keeps its words and its button (the family's 6 px corner and
// a button height, its words whole), the picker New Pip uses opens from it, the confirmation fits the view with its two
// lists, and once it is done the page has its folder's rows with Remove its folder…; its ⋯ menu's row wears the folder
// glyph and says its words whole; nothing scrolls sideways. With DGC_PICTURES_DIR set, each step is also a picture.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ERP, GARDEN_DIR, MORNINGS, openOnePips } from "./support/one-pips-scene.mjs";

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

const PICTURES = process.env.DGC_PICTURES_DIR || "";
if (PICTURES) mkdirSync(PICTURES, { recursive: true });
const picture = async (x, name, selector) => {
  if (!PICTURES) return;
  if (selector) await x.page.locator(selector).first().screenshot({ path: join(PICTURES, `${name}.png`) });
  else await x.page.screenshot({ path: join(PICTURES, `${name}.png`) });
};
const look = (x, selector) => x.inPips((root, s) => {
  const n = root.querySelector(s); if (!n) return null;
  const r = n.getBoundingClientRect(), c = getComputedStyle(n);
  return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width * 10) / 10,
    height: Math.round(r.height * 10) / 10, radius: c.borderTopLeftRadius, shown: n.checkVisibility({ visibilityProperty: true }), cut: n.scrollWidth > n.clientWidth + 1, view: innerWidth };
}, selector);
const sideways = (x) => x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
const button = (b, what) => { assert.ok(b && b.shown, `${what} shows`); assert.equal(b.radius, "6px", `${what}: the family's corner, never a pill`);
  assert.ok([26, 28].includes(b.height), `${what}: a button height (${b.height})`); assert.equal(b.cut, false, `${what} says its words whole`); };
const inRow = (b, row, what) => assert.ok(b.left >= row.left - 1 && b.right <= row.right + 1, `${what} is inside its row (${JSON.stringify({ b, row })})`);
const page = async (x, id) => {
  await x.openPip(id);
  await x.click(".pip-topbar .pip-menu summary"); await x.click('.pip-topbar .pip-menu [data-tab="job"]');
  await x.waitIn(".pip-page"); await x.page.waitForTimeout(120);
};

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  const at = `${theme} at ${width}px`, name = `${theme.split("-")[0]}-${width}`;
  test(`${at}: Give it a folder… on its page, the picker, what stays and what changes, then its folder's rows`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, theme, api: 110, height: 900, faces: true });
    try {
      await page(x, MORNINGS);
      await x.inPips((root) => root.querySelector(".pip-place-part").scrollIntoView({ block: "center" }));
      await x.page.waitForTimeout(80);
      const row = await look(x, ".pip-place-part .pip-page-row"), give = await look(x, "#pip-give-folder");
      button(give, "Give it a folder…"); inRow(give, row, "Give it a folder…");
      assert.equal((await look(x, ".pip-place-part .pip-folder-where")).cut, false, "where it works, whole");
      assert.equal(await sideways(x), false);
      await picture(x, `give-row-${name}`, ".pip-place-part");
      await x.click("#pip-give-folder"); await x.waitIn(".dgc-folder-menu"); await x.page.waitForTimeout(150);
      const menu = await look(x, ".dgc-folder-menu");
      assert.ok(menu.left >= 0 && menu.right <= menu.view + 1, `the picker stays in the view (${JSON.stringify(menu)})`);
      await picture(x, `give-picker-${name}`);
      await x.inPips((root, f) => [...root.querySelectorAll(".dgc-folder-menu [role=menuitemradio]")].find((r) => r.dataset.folder === f).click(), GARDEN_DIR);
      await x.waitIn("#review-root .dialog .pip-folder-move-says"); await x.page.waitForTimeout(150);
      const dialog = await look(x, "#review-root .dialog");
      assert.ok(dialog.left >= 0 && dialog.right <= dialog.view + 1, `the confirmation fits the view (${JSON.stringify(dialog)})`);
      button(await look(x, "#review-confirm"), "Give it this folder");
      assert.deepEqual(await x.inPips((root) => [...root.querySelectorAll(".pip-folder-move-head")].map((h) => h.textContent)), ["What stays", "What changes"]);
      await picture(x, `give-confirm-${name}`);
      await x.click("#review-confirm"); await x.waitIn(".pip-folder-parts #pip-remove-folder"); await x.page.waitForTimeout(150);
      await x.inPips((root) => root.querySelector(".pip-folder-parts").scrollIntoView({ block: "center" }));
      await x.page.waitForTimeout(80);
      const parts = await look(x, ".pip-folder-parts .pip-page-row"), remove = await look(x, "#pip-remove-folder");
      button(remove, "Remove its folder…"); inRow(remove, parts, "Remove its folder…");
      assert.equal(await sideways(x), false);
      await picture(x, `given-page-${name}`, ".pip-folder-parts");
      const sent = (await x.requests("give_pip_folder")).map((r) => r.dry_run === true);
      assert.deepEqual(sent, [true, false], "DGC said first, then it moved once");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${at}: its ⋯ menu offers Remove its folder… with the folder glyph, whole; the header names its folder`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, theme, api: 110, height: 900, faces: true });
    try {
      await x.openPip(ERP);
      await x.click(".pip-topbar .pip-menu summary"); await x.waitIn(".pip-topbar .pip-menu [data-remove-folder]"); await x.page.waitForTimeout(120);
      const item = await look(x, ".pip-topbar .pip-menu [data-remove-folder]"), glyph = await look(x, '.pip-topbar .pip-menu [data-remove-folder] svg[data-icon="remove-folder"]');
      assert.ok(item.shown && glyph && glyph.shown, "the row and its glyph show");
      assert.equal(glyph.width, 15, "a menu row's glyph is 15 px");
      assert.equal(item.cut, false, "its words whole");
      assert.equal(await sideways(x), false);
      await picture(x, `remove-menu-${name}`);
      await x.click(".pip-topbar .pip-menu [data-remove-folder]"); await x.waitIn("#review-root .dialog .pip-folder-move-says"); await x.page.waitForTimeout(150);
      const dialog = await look(x, "#review-root .dialog");
      assert.ok(dialog.left >= 0 && dialog.right <= dialog.view + 1, "the confirmation fits the view");
      await picture(x, `remove-confirm-${name}`);
      await x.click("#review-confirm"); await x.waitIn(".pip-topbar-chat"); await x.page.waitForTimeout(200);
      assert.equal(await look(x, ".pip-topbar .pip-where"), null, "a Pip for anything: no folder in its header");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
