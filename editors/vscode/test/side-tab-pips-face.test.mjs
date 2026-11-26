// The Pips tab, and only it, wears the Core Pip's animated face beside its name (src/panel.ts, media/main.js,
// media/shared/tabs.css; the face is the plush renderer's, as on the dock and Home's cards). Measured in real Chromium
// on the side bar's real page (support/dock-scene.mjs). What is held here:
//   - only Pips has a face; Home, Work and Chat stay names only
//   - the face is small, beside the word and after it (asked 12 Nov night: it was before it; test/pixel-notes-browser.test.mjs
//     holds the order, the gap and the centring), about the height of the word's line, never cut
//   - it is alive (it breathes and blinks) and keeps still under reduced motion
//   - the tab's name for a screen reader is still "Pips"; choosing tabs moves nothing; the keys work as before
//   - the five tabs still fit at 280 px (four fitted at 240 before Library; 292 while Library wore the maintainer's books, 15 Nov); at 170 px (icons: side-tabs-icons.test.mjs) Pips is the face alone
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock } from "./support/dock-scene.mjs";

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
const settle = (page, ms = 60) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);

/** Each tab as it is on screen: its box, its word, and its face when it has one. */
const tabsNow = (page) => page.evaluate(() => [...document.querySelectorAll('#side-tabs [role="tab"]')].filter((t) => t.checkVisibility()).map((t) => {
  const rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const face = t.querySelector(".dgc-tab-face"), plush = face?.querySelector(".dgc-plush"), word = t.querySelector(".dgc-tab-front .dgc-tab-word") || t.querySelector(".dgc-tab-front"), flip = t.querySelector(".dgc-tab-flip");
  const moving = plush ? [plush, ...plush.querySelectorAll("*")].map((n) => getComputedStyle(n).animationName).filter((n) => n && n !== "none") : [];
  return { id: t.dataset.tab, selected: t.getAttribute("aria-selected") === "true", box: rect(t), word: rect(word), wordBox: rect(flip), line: parseFloat(getComputedStyle(word).fontSize),
    face: plush ? { ...rect(face), hidden: face.getAttribute("aria-hidden"), state: plush.dataset.state, moving: [...new Set(moving)].sort() } : null,
    pictures: [...t.querySelectorAll("svg, img, .codicon, .dgc-plush")].filter((n) => n.checkVisibility()).length,   // (drawn ones: the icons of a narrow side bar are in the page, unseen)

    // What a screen reader says: the tab's own label, else its words that are not hidden from it.
    name: t.getAttribute("aria-label") || [...t.querySelectorAll("*")].filter((n) => !n.children.length && !n.closest('[aria-hidden="true"]')).map((n) => n.textContent).join("").trim() };
}));

for (const width of [280, 300, 700]) {
  test(`${width}px: only the Pips tab wears the Core Pip's face, beside its name, at the height of the word's line`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 600 });
    try {
      const tabs = await tabsNow(x.page), pips = tabs.find((tab) => tab.id === "pips");
      assert.deepEqual(tabs.map((tab) => [tab.id, !!tab.face]), [["home", false], ["work", false], ["chat", false], ["library", false], ["pips", true]], "Pips, and only Pips");
      assert.deepEqual(tabs.filter((tab) => tab.id !== "pips").map((tab) => tab.pictures), [0, 0, 0, 0], "Home, Work, Chat and Library draw no line icon and no face (Library is a word like the rest: library-iris-browser.test.mjs)");
      const f = pips.face;
      assert.equal(f.hidden, "true", "the face is decoration");
      assert.equal(pips.name, "Pips", "the tab is still named Pips");
      assert.ok(Math.abs(f.width - f.height) < 0.6 && f.height >= pips.line && f.height <= pips.wordBox.height + 0.5, `small: the height of the word's line (${f.height} for a ${pips.line}px word in a ${pips.wordBox.height}px line)`);
      assert.ok(f.left >= pips.word.right && f.left - pips.wordBox.right <= 8, `beside the word, after it (${pips.word.right} then ${f.left})`);
      assert.ok(Math.abs((f.top + f.bottom) / 2 - (pips.wordBox.top + pips.wordBox.bottom) / 2) <= 1.5, "level with the word");
      assert.ok(pips.word.left >= pips.box.left - 0.5 && f.right <= pips.box.right + 0.5, "neither the word nor the face is cut");
      assert.ok(f.moving.includes("dgc-plush-breathe") && f.moving.includes("dgc-plush-blink"), `it is alive: it breathes and blinks (${f.moving})`);
      assert.equal(f.state, "idle");
      for (const tab of tabs) assert.ok(tab.wordBox.left >= tab.box.left - 0.5 && tab.wordBox.right <= tab.box.right + 0.5, `${tab.id}: its name fits`);
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      // Choosing tabs moves nothing: every tab keeps its box, and the face its place.
      const boxes = (list) => list.map((tab) => [tab.id, Math.round(tab.box.left * 2) / 2, Math.round(tab.box.width * 2) / 2, tab.face ? Math.round(tab.face.left * 2) / 2 : null]);
      for (const id of ["work", "pips", "chat", "home"]) {
        await x.page.click(`#side-tab-${id}`); await x.page.mouse.move(width / 2, 400); await settle(x.page, 320);
        const now = await tabsNow(x.page);
        assert.deepEqual(boxes(now), boxes(tabs), `on ${id}: no tab moved`);
        assert.deepEqual(now.filter((tab) => tab.selected).map((tab) => tab.id), [id]);
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the keyboard is as it was: Left and Right move and choose, wrapping at the ends; Pips is the last tab, after Library", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 300, height: 600 });
  try {
    await x.page.focus("#side-tab-home");
    await x.page.keyboard.press("ArrowLeft"); await settle(x.page, 200);
    assert.deepEqual((await tabsNow(x.page)).filter((tab) => tab.selected).map((tab) => tab.id), ["pips"], "Left of Home wraps to the last tab, Pips");
    assert.equal(await x.page.evaluate(() => document.activeElement?.id), "side-tab-pips", "the keyboard is on the tab, never on its face");
    assert.equal(await x.page.evaluate(() => document.querySelectorAll("#side-tab-pips [tabindex], #side-tab-pips button, #side-tab-pips a").length), 0, "nothing in the tab takes the keyboard");
    await x.page.keyboard.press("ArrowLeft"); await settle(x.page, 200);
    assert.deepEqual((await tabsNow(x.page)).filter((tab) => tab.selected).map((tab) => tab.id), ["library"]);
    await x.page.keyboard.press("ArrowRight"); await settle(x.page, 200);
    assert.deepEqual((await tabsNow(x.page)).filter((tab) => tab.selected).map((tab) => tab.id), ["pips"]);
    await x.page.keyboard.press("ArrowRight"); await settle(x.page, 200);
    assert.deepEqual((await tabsNow(x.page)).filter((tab) => tab.selected).map((tab) => tab.id), ["home"]);
  } finally { await x.close(); }
});

test("under reduced motion the face keeps still", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 300, height: 600, motion: "reduce" });
  try {
    const pips = (await tabsNow(x.page)).find((tab) => tab.id === "pips");
    assert.ok(pips.face, "the face is there");
    assert.deepEqual(pips.face.moving, [], "and nothing in it moves");
  } finally { await x.close(); }
});

test("170px, the narrowest side bar: the tabs are icons, and Pips is the face alone, whole, in the middle of its tab", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 170, height: 600 });
  try {
    // (Under 280 px the words are not drawn and each tab is an icon: side-tabs-icons.test.mjs.)
    const tabs = await tabsNow(x.page);
    for (const tab of tabs) assert.ok(tab.word.width <= 1.5 && tab.word.height <= 1.5, `${tab.id}: its word is not drawn (${tab.word.width} x ${tab.word.height})`);
    assert.deepEqual(tabs.map((tab) => [tab.id, tab.name.replace(/:.*/, "")]), [["home", "Home"], ["work", "Work"], ["chat", "Chat"], ["library", "Library"], ["pips", "Pips"]], "each tab keeps its name");
    const pips = tabs.find((tab) => tab.id === "pips");
    assert.ok(pips.face && pips.face.left >= pips.box.left - 0.5 && pips.face.right <= pips.box.right + 0.5, "the face fits in its tab");
    assert.ok(Math.abs((pips.face.left + pips.face.right) / 2 - (pips.box.left + pips.box.right) / 2) <= 1, "in the middle of it");
    assert.ok(pips.face.moving.includes("dgc-plush-breathe"), "and is alive");
    assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  } finally { await x.close(); }
});
