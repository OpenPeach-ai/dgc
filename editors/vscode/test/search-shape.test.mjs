// The side bar's search fields have the shape of its buttons (0.52, asked 13 Nov: "make the search bar also like in
// this button shape, rounded edges long rectangular shape"): Work's "Search Work sessions", Chat's "Search chats", View
// all's search and the Pips view's "Search your Pips" take the shared button's corner and the height of the New button
// beside them, the same as the Project Folder dropdown's, so each row reads as one set. The focus ring follows the
// corner; the placeholder and the clear × are inside; dark, light and a high contrast theme, at 700 and 300 px.
// Read from computed style and geometry in real Chromium on the real pages.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openHome } from "./support/home-scene.mjs";
import { openPips } from "./support/project-folder-pips-scene.mjs";
import { listOf } from "./support/folder-row-scene.mjs";

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
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** A field (or a button) as it is: its corners, its box, and how it shows focus. `inPips`: in the Pips view's own root. */
const shape = (page, selector, inPips = false) => page.evaluate(([s, pips]) => {
  const root = pips ? document.getElementById("pips-host").shadowRoot : document, e = root.querySelector(s);
  if (!e || !e.checkVisibility()) return null;
  const c = getComputedStyle(e), r = e.getBoundingClientRect();
  return { corners: [...new Set([c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomRightRadius, c.borderBottomLeftRadius])], height: r.height, mid: (r.top + r.bottom) / 2, left: r.left, right: r.right,
    pad: [parseFloat(c.paddingLeft), parseFloat(c.paddingRight)], line: [c.borderTopWidth, c.borderTopColor], outline: [c.outlineStyle, c.outlineWidth, c.outlineOffset], clip: c.overflow, focused: root.activeElement === e };
}, [selector, inPips]);

for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of [700, 300]) {
  test(`Work, Chat and View all: each search field has the New button's corner and height, and its focus ring follows the corner (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab: "work", motion: "reduce" });
    try {
      await x.send(listOf(""));
      await settle(x.page);
      const fresh = await shape(x.page, "#sessions-new"), field = await shape(x.page, "#sessions-search"), pick = await shape(x.page, "#sessions-folder-pick");
      assert.deepEqual([fresh.corners, fresh.height], [["6px"], 28], "New: the shared button");
      assert.deepEqual(field.corners, fresh.corners, "Search Work sessions has the New button's corner");
      assert.equal(field.height, fresh.height, "and its height");
      assert.ok(Math.abs(field.mid - fresh.mid) <= 0.5 && field.right <= fresh.left - 4, "on one line with it, before it");
      assert.deepEqual([pick.corners, pick.height], [fresh.corners, fresh.height], "the Project Folder dropdown is of the same set");
      assert.ok(field.pad[0] >= 8 && field.pad[1] >= 6, `the placeholder and the clear × keep inside the corner (${field.pad})`);
      // Focus: the ring is the field's own line (or an outline), on the same corner; nothing square is drawn round it.
      await x.page.focus("#sessions-search");
      await x.page.keyboard.type("tomato");
      await settle(x.page);
      const held = await shape(x.page, "#sessions-search");
      assert.deepEqual([held.focused, held.corners, held.height], [true, fresh.corners, fresh.height], "focused: the same shape");
      const ring = held.outline[0] !== "none" ? held.outline : held.line;
      assert.ok(held.outline[0] !== "none" || (held.line[0] === "1px" && !/, 0\)$|transparent/.test(held.line[1]) && held.line[1] !== field.line[1]), `a focus ring is shown, and it is on the field's own rounded line: ${JSON.stringify(ring)}`);
      const clear = await x.page.evaluate(() => { const e = document.getElementById("sessions-search"); return [e.value, e.scrollWidth <= e.clientWidth + 1]; });
      assert.deepEqual(clear, ["tomato", true], "what is typed, and its clear ×, are inside the field");
      await x.page.fill("#sessions-search", "");
      // View all's search.
      await x.page.click("#sessions-all");
      await x.page.waitForSelector(".sessions-popover .sessions-all-search");
      await settle(x.page);
      const all = await shape(x.page, ".sessions-popover .sessions-all-search"), allPick = await shape(x.page, ".sessions-popover .dgc-folder");
      assert.deepEqual([all.corners, all.height], [fresh.corners, fresh.height], "View all's search: the same corner and height");
      assert.ok(Math.abs(all.mid - allPick.mid) <= 0.5 && allPick.height === all.height, "on one line with the dropdown beside it, the same height");
      await x.page.keyboard.press("Escape");
      // Chat.
      await x.page.click("#side-tab-chat");
      await settle(x.page);
      const chat = await shape(x.page, "#chats-search"), chatNew = await shape(x.page, "#chats-new");
      assert.deepEqual([chat.corners, chat.height], [chatNew.corners, chatNew.height], "Search chats has its New button's corner and height");
      assert.deepEqual([chatNew.corners, chatNew.height], [["6px"], 28]);
      assert.ok(Math.abs(chat.mid - chatNew.mid) <= 0.5);
      assert.equal(await x.page.evaluate(() => document.getElementById("sessions-host").scrollWidth > document.getElementById("sessions-host").clientWidth + 1), false, "nothing sideways");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`the Pips view: "Search your Pips" has the same corner and height, and its focus ring follows the corner (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width, tab: "personal" });
    try {
      await x.inPips((root) => { if (!root.querySelector("#pip-search")) root.querySelector("#pips-search-open, [id*=search]")?.click(); });
      await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot.querySelector("#pip-search"), undefined, { timeout: 15000 });
      await settle(x.page);
      const field = await shape(x.page, "#pip-search", true);
      assert.deepEqual([field.corners, field.height], [["6px"], 28], "the shared button's corner and the New button's height");
      assert.ok(field.pad[0] >= 8 && field.pad[1] >= 6);
      await x.inPips((root) => root.querySelector("#pip-search").focus());
      await x.page.keyboard.type("bed");
      await settle(x.page);
      const held = await shape(x.page, "#pip-search", true);
      assert.deepEqual([held.corners, held.height], [["6px"], 28], "focused: the same shape");
      assert.ok(held.outline[0] !== "none" && parseFloat(held.outline[2]) <= 0, `its ring is on the field's own rounded edge: ${held.outline}`);
      // On the Project tab the dropdown is of the same set.
      const pick = await (async () => { await x.inPips((root) => root.querySelector("#pips-tab-project").click()); await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot.querySelector("#pips-folder-pick")); return shape(x.page, "#pips-folder-pick", true); })();
      assert.deepEqual([pick.corners, pick.height], [field.corners, field.height]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
