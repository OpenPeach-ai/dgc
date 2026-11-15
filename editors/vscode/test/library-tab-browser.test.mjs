// The Library everywhere (0.52, his calls of 15 Nov; live round 1, findings 37 and 38): Library is one of the side
// bar's five tabs (Home · Work · Chat · Library · Pips since Library v2: Pips stays last; icons when narrow, as the
// others), Home's top row has a Library button beside Cards, and the Library page is in the side bar. What the page
// holds (the header row, the search field, its own five tabs, each tab's filters and rows) is library-v2-browser.test.mjs,
// for the side bar and the editor tab alike: one module draws both. Here: the tab and the button, and that the page
// reads on every one of its tabs (contrast, no pill, focus rings, touch, the dock).
// On the real side bar, in real Chromium (test/support/library-scene.mjs is the host's stand-in).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock } from "./support/dock-scene.mjs";
import { openGrid } from "./support/home-grid-scene.mjs";
import { openLibraryTab } from "./support/library-scene.mjs";

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
const posted = (x, type) => x.page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);

// ---- 1. the fifth tab ---------------------------------------------------------------------------------------------------
for (const width of [300, 440, 700]) {
  test(`${width} px: five tabs by name, Home · Work · Chat · Library · Pips, none cut`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 700 });
    try {
      const bar = await x.tabs();
      assert.deepEqual(bar.tabs.filter((b) => b.shown).map((b) => b.name), ["Home", "Work", "Chat", "Library", "Pips"]);
      for (const b of bar.tabs) { assert.equal(b.clipped, false, `${b.name} is whole`); assert.equal(b.icons, b.id === "pips" ? 1 : 0, `${b.name} is its word${b.id === "pips" ? " and the Core Pip's face" : " alone (only Pips has a picture: his call of 15 Nov)"}`); }
      const cut = await x.page.evaluate(() => [...document.querySelectorAll("#side-tabs .dgc-tab-word")].filter((w) => w.scrollWidth > w.clientWidth + 1 || w.getClientRects().length > 1).map((w) => w.textContent));
      assert.deepEqual(cut, [], "no name is cut or broken");
      assert.equal(bar.overflowX, false);
      const library = bar.tabs.at(-2);
      assert.equal(library.id, "library"); assert.equal(library.controls, "library-home");
      assert.ok(library.left >= bar.tabs.at(-3).right - 0.5 && bar.tabs.at(-1).left >= library.right - 0.5, "after Chat, before Pips");
    } finally { await x.close(); }
  });
}
for (const width of [170, 220]) {
  test(`${width} px: the five tabs are icons, each as wide as the others, Library's among them`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 700 });
    try {
      const bar = await x.tabs(), shown = bar.tabs.filter((b) => b.shown);
      assert.equal(shown.length, 5);
      const widths = shown.map((b) => Math.round(b.width));
      assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `five tabs of one width: ${widths}`);
      const library = shown.at(-2);
      assert.equal(library.id, "library"); assert.equal(library.icons, 1, "Library is an icon");
      assert.ok(shown.at(-1).right <= bar.bar.right + 0.5 && library.height === shown[0].height);
      const word = await x.page.evaluate(() => { const w = document.querySelector("#side-tab-library .dgc-tab-word").getBoundingClientRect(); return [w.width, w.height]; });
      assert.ok(word[0] <= 1.5 && word[1] <= 1.5, "its word is kept for a screen reader only");
      assert.equal(bar.overflowX, false);
    } finally { await x.close(); }
  });
}
test("the Library tab: a click shows the Library page, the arrow keys reach it, and a reload comes back to it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { tab: "home", width: 300 });
  try {
    await x.page.click("#side-tab-library"); await x.settle();
    let bar = await x.tabs();
    assert.deepEqual(bar.tabs.filter((b) => b.selected).map((b) => b.id), ["library"]);
    assert.equal(bar.panel, "library-home"); assert.equal(bar.panelRole, "tabpanel"); assert.equal(bar.panelLabelledBy, "side-tab-library");
    assert.equal((await x.kept()).sideTab, "library", "kept for a reload");
    await x.page.focus("#side-tab-library"); await x.page.keyboard.press("ArrowLeft"); await x.settle();
    bar = await x.tabs(); assert.deepEqual(bar.tabs.filter((b) => b.selected).map((b) => b.id), ["chat"], "Left of Library is Chat");
    await x.page.keyboard.press("ArrowRight"); await x.settle();
    bar = await x.tabs(); assert.deepEqual(bar.tabs.filter((b) => b.selected).map((b) => b.id), ["library"], "and Right of Chat is Library");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  const again = await openLibraryTab(browser, { saved: { sideTab: "library" }, width: 300 });
  try { assert.equal((await again.tabs()).panel, "library-home", "it opens on the Library again"); assert.ok((await again.lib()).rows.length > 0); } finally { await again.close(); }
});

// ---- 1b. Home's top row -------------------------------------------------------------------------------------------------
for (const width of [170, 300, 700]) {
  test(`Home at ${width} px: a Library button beside Cards, the same shape, and it opens the Library tab`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width, theme: "dark-modern", layout: ["needs", "recent", "clock"], height: 700 });
    try {
      await x.rest(300);
      const row = await x.page.evaluate(() => {
        const at = (n) => { if (!n) return null; const r = n.getBoundingClientRect(), s = getComputedStyle(n); return { left: r.left, right: r.right, top: r.top, h: r.height, w: r.width, radius: s.borderTopLeftRadius, border: s.borderTopWidth + " " + s.borderTopColor, ground: s.backgroundColor, font: s.font,
          words: [...n.childNodes].filter((c) => c.nodeType === 3 || c.matches?.(".hc-btn-word")).map((c) => c.textContent).join("").trim(), label: n.getAttribute("aria-label") || n.textContent.trim(), cut: n.scrollWidth > n.clientWidth + 1 }; };
        return { library: at(document.querySelector("#home-hub .hc-head .hc-library-btn")), cards: at(document.querySelector("#home-hub .hc-head .hc-cards-btn")), sideways: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(row.library, "Home's top row has a Library button");
      assert.match(row.library.label, /Library/);
      assert.ok(row.library.right <= row.cards.left && row.cards.left - row.library.right <= 12, "beside Cards, before it");
      assert.equal(Math.round(row.library.top), Math.round(row.cards.top));
      for (const key of ["h", "radius", "border", "ground", "font"]) assert.equal(row.library[key], row.cards[key], `the same ${key} as Cards`);
      assert.equal(row.library.cut, false); assert.equal(row.cards.cut, false); assert.equal(row.sideways, false);
      await x.page.click("#home-hub .hc-library-btn"); await x.rest(250);
      assert.equal((await x.tabs()).panel, "library-home", "it opens the Library tab");
    } finally { await x.close(); }
  });
}

// ---- 2. the page (what it holds is library-v2-browser.test.mjs; here: that it reads, on every one of its tabs) ---------------
// ---- the polish pass's measuring stick (test/support/polish-audit.mjs) on the new page ----------------------------------
const { audit, focusAudit } = await import("./support/polish-audit.mjs");
const lines = (list) => list.map((x) => `${x.what} “${x.text || x.title || ""}” ${x.ratio ?? x.corner ?? x.by ?? ""}`.trim());
for (const theme of ["dark-modern", "light-modern"]) for (const width of [170, 300, 700]) {
  test(`the Library page and the tab bar read at 4.5:1 or more, with no pill, nothing covered or off the page, and a focus ring on every control (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openLibraryTab(browser, { width, theme });
    try {
      await x.page.mouse.move(1, 1); await x.settle();
      for (const [tab, scope] of [["artifacts", "#side-tabs"], ["artifacts", "#library-home"], ["widgets", "#library-home"], ["images", "#library-home"], ["videos", "#library-home"], ["files", "#library-home"]]) {
        await x.libTab(tab); await x.page.mouse.move(1, 1); await x.settle();
        const a = await x.page.evaluate(audit, { scope });
        // (A sheet's own tag is a picture of a file's kind, drawn by media/shared/filesheet.js at its own tones.)
        assert.deepEqual(lines(a.contrast.filter((c) => !/dgc-sheet/.test(c.what))), [], `${scope} ${tab}: every word at 4.5:1`);
        assert.deepEqual(lines(a.pills), [], `${scope} ${tab}: no pill`);
        // (The dock floats over a long list mid-scroll, as over every tab; the list's end clears it: side-tabs-home.test.mjs.)
        assert.deepEqual(lines(a.covered.filter((c) => !/dgc-dock/.test(c.by))), [], `${scope} ${tab}: nothing lies over a control`);
        assert.deepEqual(lines(a.offscreen), [], `${scope} ${tab}: nothing is off the page`);
        assert.equal(a.overflowX, 0);
      }
      await x.page.keyboard.press("Shift");
      const f = await x.page.evaluate(focusAudit, { scope: "#library-home" });
      assert.ok(f.walked >= 6, `the controls were walked (${f.walked})`);
      assert.deepEqual(f.missing.map((m) => `${m.what} “${m.text}”`), [], "every control shows where the keyboard is");
      assert.deepEqual(f.cut.map((c) => `${c.what} “${c.text}”: ${c.lost}px of its ring is cut by ${c.by}`), []);
    } finally { await x.close(); }
  });
}
test("touch: every control of the Library page is in sight without a pointer, and the maker's name says it can be pressed", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 300, touch: true });
  try {
    const a = await x.page.evaluate(audit, { scope: "#library-home", touch: true });
    assert.deepEqual(lines(a.unseen), []);
    const line = await x.page.evaluate(() => getComputedStyle(document.querySelector("#library-list button.lib-row-maker")).textDecorationColor);
    assert.notEqual(line, "rgba(0, 0, 0, 0)", "a quiet underline where nothing can be pointed at");
  } finally { await x.close(); }
});
test("scrolled to its end, the Library's last row is clear of the dock", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 300, height: 520 });
  try {
    await x.page.evaluate(() => { const host = document.getElementById("sessions-host"); host.scrollTop = host.scrollHeight; }); await x.settle();
    const at = await x.page.evaluate(() => { const last = [...document.querySelectorAll("#library-list .lib-row")].at(-1).getBoundingClientRect(), bar = document.querySelector("#dgc-dock .dgc-dock-bar").getBoundingClientRect(); return { row: last.bottom, dock: bar.top }; });
    assert.ok(at.row <= at.dock + 0.5, `the last row ends at ${at.row}, the dock begins at ${at.dock}`);
  } finally { await x.close(); }
});
