// Home's head row, after Library and Cards (his call, 17 Nov): GitHub, Docs, DGC-SDK and Settings, each with its own
// coloured mark at the same visible size (the icon sheet he approved: Docs a page stack, DGC-SDK the website's tilted
// tile with DGC's three strokes, Settings a graphite gear, GitHub its own mark). GitHub opens DGC's repository, Docs
// docs.vibedgc.com, DGC-SDK vibedgc.com/sdk, Settings DGC's Settings. One row at every width: the four are their marks
// alone below 640 px, and Library and Cards too below 360 px; a mark alone keeps its name for a screen reader and as
// its hover label. Not while Home is arranged. In real Chromium.
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
const ORDER = ["Library", "Cards", "GitHub", "Docs", "DGC-SDK", "Settings"];

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 460, 700, 1100]) {
  test(`Home at ${width} px (${theme}): Library, Cards, GitHub, Docs, DGC-SDK, Settings in one row, one shape, nothing cut`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width, theme, layout: ["needs", "recent"], height: 700 });
    try {
      await x.rest(300);
      const row = await x.page.evaluate(() => [...document.querySelectorAll("#home-hub .hc-head > button")].filter((b) => b.checkVisibility())
        .map((b) => { const r = b.getBoundingClientRect(), s = getComputedStyle(b), mark = b.firstElementChild?.getBoundingClientRect();
          const word = b.querySelector(".hc-btn-word"), shown = word && word.getBoundingClientRect().width > 2;
          return { label: b.getAttribute("aria-label"), title: b.title, top: Math.round(r.top), h: r.height, w: r.width, radius: s.borderTopLeftRadius,
            ground: s.backgroundColor, border: s.borderTopWidth, word: shown ? word.textContent : "", cut: b.scrollWidth > b.clientWidth + 1,
            mark: mark ? [Math.round(mark.width), Math.round(mark.height)] : null }; }));
      const named = row.filter((b) => ORDER.includes(b.label));
      assert.deepEqual(named.map((b) => b.label), ORDER, "in his order, after Library and Cards");
      const cards = named[1];
      for (const b of named) {
        assert.equal(b.top, cards.top, `${b.label}: one row`);
        for (const key of ["h", "radius", "ground", "border"]) assert.equal(b[key], cards[key], `${b.label}: the same ${key} as Cards`);
        assert.equal(b.cut, false, `${b.label}: nothing cut`);
        assert.deepEqual(b.mark, [16, 16], `${b.label}: a 16 px mark, as Library's and Cards'`);
        assert.ok(b.title, `${b.label}: a hover label`);
      }
      const words = (b) => b.word !== "";
      if (width >= 700) assert.ok(named.every(words), "wide: every button says its name");
      if (width < 640) for (const b of named.slice(2)) assert.ok(!words(b) && Math.abs(b.w - b.h) < 0.5, `${b.label}: its mark alone, a square`);
      if (width < 360) assert.ok(named.every((b) => !words(b)), "the narrowest: every one is its mark");
      else assert.ok(words(named[0]) && words(named[1]), "Library and Cards keep their words down to 360 px");
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no sideways scroll");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("each opens its place: DGC's repository, its docs, its SDK page, and Settings", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 1100, layout: ["needs"], height: 700 });
  try {
    await x.rest(300);
    for (const label of ["GitHub", "Docs", "DGC-SDK"]) { await x.page.click(`#home-hub .hc-head > button[aria-label="${label}"]`); await x.rest(60); }
    assert.deepEqual((await posted(x.page, "openExternal")).map((m) => m.url),
      ["https://github.com/OpenPeach-ai/dgc", "https://docs.vibedgc.com/", "https://vibedgc.com/sdk/"]);
    await x.page.click('#home-hub .hc-head > button[aria-label="Settings"]'); await x.rest(60);
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
