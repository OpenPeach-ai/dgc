// The header's tab order (0.52, his words of 15 Nov: "put library before pips, so pips remains last: Home, Work, Chat,
// Library and then Pips"). On the real side bar, in real Chromium: the order on screen and for the arrow keys, by name
// from 292 px and as icons under it (the narrow-width rule is kept).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock } from "./support/dock-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

for (const width of [170, 220, 291, 292, 300, 440, 700]) {
  test(`${width} px: Home · Work · Chat · Library · Pips, Pips last, ${width < 292 ? "as five icons of one width" : "by name, none cut"}`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 700 });
    try {
      const bar = await x.tabs(), shown = bar.tabs.filter((b) => b.shown);
      assert.deepEqual(shown.map((b) => b.id), ["home", "work", "chat", "library", "pips"]);
      for (let i = 1; i < shown.length; i++) assert.ok(shown[i].left >= shown[i - 1].right - 0.5, `${shown[i].id} is after ${shown[i - 1].id} on screen`);
      for (const b of shown) assert.equal(b.clipped, false, `${b.id} is whole`);
      if (width < 292) { const widths = shown.map((b) => Math.round(b.width)); assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `one width: ${widths}`); for (const b of shown) assert.equal(b.icons, 1, `${b.id} is an icon`); }
      else assert.deepEqual(shown.map((b) => b.name), ["Home", "Work", "Chat", "Library", "Pips"]);
      assert.equal(bar.overflowX, false);
      assert.equal(await x.page.evaluate(() => document.querySelector("#side-tabs .dgc-tabs-bar").getAttribute("aria-label")), "Home, Work, Chat, Library and Pips");
    } finally { await x.close(); }
  });
}
test("the arrow keys follow the order: Right of Chat is Library, End is Pips, Left of Pips is Library", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "chat", width: 300 });
  try {
    const chosen = async () => (await x.tabs()).tabs.filter((b) => b.selected).map((b) => b.id);
    await x.page.focus("#side-tab-chat"); await x.page.keyboard.press("ArrowRight"); await x.settle();
    assert.deepEqual(await chosen(), ["library"]);
    await x.page.keyboard.press("End"); await x.settle();
    assert.deepEqual(await chosen(), ["pips"]);
    await x.page.keyboard.press("ArrowLeft"); await x.settle();
    assert.deepEqual(await chosen(), ["library"]);
  } finally { await x.close(); }
});
