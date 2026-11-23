// Home's head row: Library and Cards, then one ⋯ that holds GitHub, Docs, DGC-SDK and Settings at every width (decided,
// 18 Nov: "only Library and Cards button stay as is, rest 4 buttons always come under the 3 dotted menu"). Each row of
// the menu has its own coloured mark (Docs a page stack, DGC-SDK DGC's three strokes in the SDK's olive, Settings a
// graphite gear, GitHub its own mark). GitHub opens DGC's repository, Docs docs.vibedgc.com, DGC-SDK vibedgc.com/sdk,
// Settings DGC's Settings. Not while Home is arranged. In real Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openGrid } from "./support/home-grid-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  const why = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!why) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${why}`);
  t.skip(why);
  return true;
};
const posted = (p, type) => p.evaluate((t) => window.__posted.filter((m) => m && m.type === t), type);
const MORE = "More: GitHub, Docs, DGC-SDK and Settings";

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 460, 700, 1100]) {
  test(`Home at ${width} px (${theme}): Library, Cards and one ⋯ in one row; the four are in the ⋯ at every width`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width, theme, layout: ["needs", "recent"], height: 700 });
    try {
      await x.rest(300);
      const row = await x.page.evaluate(() => [...document.querySelectorAll("#home-hub .hc-head > button")].filter((b) => b.checkVisibility())
        .map((b) => { const r = b.getBoundingClientRect(), s = getComputedStyle(b);
          return { label: b.getAttribute("aria-label"), top: Math.round(r.top), h: r.height, w: r.width, radius: s.borderTopLeftRadius, ground: s.backgroundColor, border: s.borderTopWidth }; }));
      const labels = row.map((b) => b.label);
      assert.deepEqual(labels.filter((l) => ["Library", "Cards", MORE].includes(l)), ["Library", "Cards", MORE], "Library, Cards, then the ⋯");
      for (const gone of ["GitHub", "Docs", "DGC-SDK", "Settings"]) assert.ok(!labels.includes(gone), `${width}px: ${gone} is never a button of its own`);
      const cards = row.find((b) => b.label === "Cards"), more = row.find((b) => b.label === MORE);
      assert.equal(more.top, cards.top, "one row");
      for (const key of ["h", "radius", "ground", "border"]) assert.equal(more[key], cards[key], `the ⋯: the same ${key} as Cards`);
      assert.ok(Math.abs(more.w - more.h) < 0.5, "the ⋯ is a square");
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no sideways scroll");
      // Opened: the four, each with a 16 px mark; the SDK's strokes in its olive.
      await x.page.click(`#home-hub .hc-head > button[aria-label="${MORE}"]`); await x.rest(120);
      const menu = await x.page.evaluate(() => [...document.querySelectorAll("#home-hub .hc-links-menu .hc-links-row")].map((r) => {
        const m = r.querySelector(".hc-mark").getBoundingClientRect(), sdk = r.querySelector(".hc-mark-sdk");
        return [r.textContent.trim(), Math.round(m.width), Math.round(m.height), sdk ? getComputedStyle(sdk).fill : ""]; }));
      assert.deepEqual(menu.map((m) => m[0]), ["GitHub", "Docs", "DGC-SDK", "Settings"]);
      for (const [word, w, h] of menu) assert.deepEqual([w, h], [16, 16], `${word}: a 16 px mark`);
      assert.equal(menu[2][3], "rgb(123, 140, 36)", "the SDK's strokes are its olive, #7B8C24");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("each opens its place from the ⋯: DGC's repository, its docs, its SDK page, and Settings", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 1100, layout: ["needs"], height: 700 });
  try {
    await x.rest(300);
    for (const word of ["GitHub", "Docs", "DGC-SDK", "Settings"]) {
      await x.page.click(`#home-hub .hc-head > button[aria-label="${MORE}"]`); await x.rest(80);
      await x.page.locator("#home-hub .hc-links-menu .hc-links-row", { hasText: word }).click(); await x.rest(60);
    }
    assert.deepEqual((await posted(x.page, "openExternal")).map((m) => m.url),
      ["https://github.com/OpenPeach-ai/dgc", "https://docs.vibedgc.com/", "https://vibedgc.com/sdk/"]);
    assert.equal((await posted(x.page, "openSettings")).length, 1, "Settings opens DGC's Settings");
  } finally { await x.close(); }
});

test("while Home is arranged, the four aren't there (as Library isn't)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 700, layout: ["needs", "recent"], height: 700 });
  try {
    await x.rest(300);
    await x.page.evaluate(() => document.querySelector('#home-hub .hc-grid .hc-card[data-card="needs"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await x.rest(300);
    const labels = await x.page.evaluate(() => [...document.querySelectorAll("#home-hub .hc-head > button")].map((b) => b.getAttribute("aria-label") || b.textContent.trim()));
    for (const gone of ["Library", "GitHub", "Docs", "DGC-SDK", "Settings"]) assert.ok(!labels.includes(gone), `${gone} isn't there while Home is arranged: ${labels}`);
  } finally { await x.close(); }
});

// Where even their marks don't fit -- the narrowest side bar, or a card open beside its Back -- the four are one ⋯, whose
// menu lists them in the same order, each with its mark and name (an action is never out of reach at a narrow width).
test("the narrowest side bar: one ⋯ holds GitHub, Docs, DGC-SDK and Settings; the arrows move, Escape closes, a row opens its place", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 220, layout: ["needs"], height: 700 });
  try {
    await x.rest(300);
    const seen = () => x.page.evaluate(() => [...document.querySelectorAll("#home-hub .hc-head > button")].filter((b) => b.checkVisibility()).map((b) => b.getAttribute("aria-label")));
    const before = await seen();
    assert.ok(before.includes("More: GitHub, Docs, DGC-SDK and Settings"), before.join(" | "));
    for (const gone of ["GitHub", "Docs", "DGC-SDK", "Settings"]) assert.ok(!before.includes(gone), `${gone} is in the ⋯`);
    await x.page.click("#home-hub .hc-links-more"); await x.rest(150);
    const menu = await x.page.evaluate(() => ({ rows: [...document.querySelectorAll("#home-hub .hc-links-menu [role=menuitem]")].map((r) => [r.textContent.trim(), !!r.querySelector(".hc-mark svg, .hc-mark .hc-sdk-tile")]),
      focus: document.activeElement?.textContent.trim(), expanded: document.querySelector("#home-hub .hc-links-more").getAttribute("aria-expanded"),
      inside: (() => { const m = document.querySelector("#home-hub .hc-links-menu").getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth; })() }));
    assert.deepEqual(menu.rows, [["GitHub", true], ["Docs", true], ["DGC-SDK", true], ["Settings", true]]);
    assert.equal(menu.focus, "GitHub", "the focus goes to its first row");
    assert.equal(menu.expanded, "true");
    assert.equal(menu.inside, true, "the menu stays inside the side bar");
    await x.page.keyboard.press("ArrowDown"); await x.page.keyboard.press("ArrowDown");
    assert.equal(await x.page.evaluate(() => document.activeElement.textContent.trim()), "DGC-SDK");
    await x.page.keyboard.press("Escape"); await x.rest(100);
    assert.equal(await x.page.evaluate(() => document.querySelector("#home-hub .hc-links-menu")), null, "Escape closes it");
    assert.equal(await x.page.evaluate(() => document.activeElement.classList.contains("hc-links-more")), true, "to its ⋯");
    await x.page.click("#home-hub .hc-links-more"); await x.rest(100);
    await x.page.click('#home-hub .hc-links-menu [data-head-link="docs"]'); await x.rest(100);
    assert.deepEqual((await posted(x.page, "openExternal")).map((m) => m.url), ["https://docs.vibedgc.com/"]);
    assert.equal(await x.page.evaluate(() => document.querySelector("#home-hub .hc-links-menu")), null, "a row's choice closes it");
    await x.page.click("#home-hub .hc-links-more"); await x.rest(100);
    await x.page.mouse.click(5, 650); await x.rest(100);
    assert.equal(await x.page.evaluate(() => document.querySelector("#home-hub .hc-links-menu")), null, "a click elsewhere closes it");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a card open beside its Back at 300 px: the four are the ⋯ too, and Back keeps its word", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 300, layout: ["token", "needs"], height: 700 });
  try {
    await x.rest(300);
    await x.page.click('#home-hub .hc-grid .hc-card[data-card="token"]'); await x.rest(300);
    const row = await x.page.evaluate(() => ({ labels: [...document.querySelectorAll("#home-hub .hc-head > button")].filter((b) => b.checkVisibility()).map((b) => b.getAttribute("aria-label") || b.textContent.trim()),
      back: document.querySelector("#home-hub .hc-back")?.textContent.trim(), sideways: document.documentElement.scrollWidth > innerWidth }));
    assert.equal(row.back, "Home");
    assert.ok(row.labels.includes("More: GitHub, Docs, DGC-SDK and Settings"), row.labels.join(" | "));
    assert.equal(row.sideways, false);
  } finally { await x.close(); }
});
