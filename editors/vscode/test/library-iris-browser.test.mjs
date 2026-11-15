// His Library icon, Iris (0.52, brief item 10; ~/evolving-fungi/outputs/library-iris/): three books, hue 247,
// saturation 87%, lightness 65%, used exactly as he made it: its stylesheet (namespaced .library-iris) and its PNGs are
// copied into the extension byte for byte (media/icons/library-iris/), and its README's markup is what the page holds:
// <span class="library-iris" aria-hidden="true"><i></i><i></i><i></i></span> beside the visible word "Library", and
// role="img" + aria-label="Library" where it stands alone. Places: the header's Library tab (beside the word; alone in
// icon mode), Home's Library button beside Cards, and the editor Library panel's tab icon (its PNG, light and dark).
// Sizes from its --size (16, 20, 24). Under forced colours it falls back to CanvasText, so it never vanishes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { openDock } from "./support/dock-scene.mjs";
import { openGrid } from "./support/home-grid-scene.mjs";

const root = new URL("..", import.meta.url).pathname;
const read = (name) => readFileSync(root + name, "utf8");
const sha = (name) => createHash("sha256").update(readFileSync(root + name)).digest("hex");
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

// His files, as he made them (sha256 of each; a change to one is a redraw, which this refuses).
const HIS = {
  "library.css": "ee8d43c53c0e05767daf9ae8d6f552d5a6c3e7672aed0017682b6143aa740dd1",
  "png/library-iris-16.png": "17cd2793e0f7e5c19e137999ad6e7d565f36ae501a515d59a23e649a107cb273", "png/library-iris-20.png": "dc1f4087509bb248d2d093b2fa0b0a453183ac978a9f57aaa1b7e66d679bc073", "png/library-iris-24.png": "11f73970106ab0f672e60c41b505390b093bd80ba20e4d87f51a092450174f9b", "png/library-iris-32.png": "c3e2e64c2f3128ff7010f9df044fee51a144492e604ee65b6e3489d8bb7acd21",
  "png/library-iris-48.png": "0e4dbf068e1829f621ed0d0e54d9f213cc791289130b7cc7c13312a89dcd9e31", "png/library-iris-64.png": "d96f8d10af01aa0c7e6f0caf3947dd7f21556e478c7189feb26540de9797a098", "png/library-iris-128.png": "6ce7dc34bac463b654c378d4a238f5007707ab40de92670696f0398523773b7f", "png/library-iris-256.png": "88920bc8446d8a54af9279434b608e67cde2eb9367cef2491aa4eeac1fc84f01",
};
const MARKUP = /<span class="library-iris"[^>]*>\s*<i><\/i><i><\/i><i><\/i>\s*<\/span>/;

test("his icon is in the extension exactly as he made it: library.css and every PNG, byte for byte, loaded by the side bar's page", () => {
  for (const [file, hash] of Object.entries(HIS)) {
    assert.ok(existsSync(root + "media/icons/library-iris/" + file), `media/icons/library-iris/${file} is there`);
    assert.equal(sha("media/icons/library-iris/" + file), hash, `${file} is his file, unchanged`);
  }
  const css = read("media/icons/library-iris/library.css");
  assert.match(css, /\.library-iris\{--size:24px;--h:247;--sat:87%;--light:65%/, "hue 247, saturation 87%, lightness 65%");
  assert.match(read("media/main.css"), /icons\/library-iris\/library\.css/, "the page loads his stylesheet");
  // Nothing of ours recolours or redraws it: our rules only size it, place it and give forced colours a fallback.
  const ours = [read("media/shared/tabs.css"), read("media/shared/homecards.css"), read("media/main.css")].join("\n");
  for (const rule of ours.match(/[^{}]*\.library-iris[^{}]*\{[^}]*\}/g) || []) {
    const forced = /forced-colors/.test(ours.slice(Math.max(0, ours.indexOf(rule) - 200), ours.indexOf(rule))) || /CanvasText|HighlightText|forced-color-adjust/.test(rule);
    if (!forced) assert.doesNotMatch(rule.slice(rule.indexOf("{")), /--h\s*:|--sat\s*:|--light\s*:|background|hsl\(|filter|opacity/, `ours never recolours it: ${rule.trim().slice(0, 120)}`);
  }
});
test("its markup is the README's: three <i> in a .library-iris span, hidden beside the word “Library”", () => {
  const panel = read("src/panel.ts"), cards = read("media/shared/homecards.js");
  const tab = panel.slice(panel.indexOf('id="side-tab-library"'), panel.indexOf("</button>", panel.indexOf('id="side-tab-library"')));
  assert.match(tab, MARKUP, "the header's Library tab holds it");
  assert.match(tab, /class="library-iris[^"]*"[^>]*aria-hidden="true"/); assert.match(tab, /<span class="dgc-tab-word">Library<\/span>/);
  assert.doesNotMatch(tab, /codicon-library/, "in place of the line icon");
  assert.match(cards, MARKUP, "Home's Library button holds it"); assert.doesNotMatch(cards, /LIBRARY_ICON = '<svg/, "in place of the drawn books");
  // The editor Library panel's tab icon: his PNG, light and dark.
  const chat = read("src/chatdgc.ts"), open = chat.slice(chat.indexOf("openLibrary(view"), chat.indexOf("libraryRef("));
  assert.match(open, /library-iris/, "the editor Library panel's tab icon is his PNG");
  assert.doesNotMatch(open, /panel\.iconPath = this\.chatdgcIcon\(\)/);
  assert.match(chat, /"media", "icons", "library-iris", "png", "library-iris-\d+\.png"/);
});
const iris = (page, scope) => page.evaluate((s) => {
  const n = document.querySelector(`${s} .library-iris`); if (!n) return null;
  const r = n.getBoundingClientRect(), cs = getComputedStyle(n), books = [...n.querySelectorAll(":scope > i")], word = n.closest("button").querySelector(".dgc-tab-word, .hc-btn-word")?.getBoundingClientRect();
  return { seen: n.checkVisibility({ opacityProperty: true }), w: r.width, h: r.height, size: cs.getPropertyValue("--size").trim(), hue: cs.getPropertyValue("--h").trim(), sat: cs.getPropertyValue("--sat").trim(), light: cs.getPropertyValue("--light").trim(),
    hidden: n.getAttribute("aria-hidden"), role: n.getAttribute("role"), label: n.getAttribute("aria-label"), books: books.length, bookSeen: books.every((b) => b.getBoundingClientRect().width > 1 && b.getBoundingClientRect().height > 4),
    paint: books.map((b) => getComputedStyle(b).backgroundImage.slice(0, 15)), ground: books.map((b) => getComputedStyle(b).backgroundColor), filter: cs.filter, opacity: cs.opacity,
    word: word ? [word.width, word.height] : null, wordLeft: word?.left, right: r.right, mid: r.top + r.height / 2, wordMid: word ? word.top + word.height / 2 : null,
    name: n.closest("button").getAttribute("aria-label") || n.closest("button").textContent.trim() };
}, scope);

for (const theme of ["dark-modern", "light-modern"]) for (const width of [170, 292, 300, 440]) {
  test(`${width} px (${theme}): the header's Library tab wears his books, at his hue, 16 px, ${width < 292 ? "alone (the word kept for a screen reader)" : "beside its word"}`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, theme });
    try {
      const i = await iris(x.page, "#side-tab-library");
      assert.ok(i?.seen, "his icon is on the tab");
      assert.deepEqual([i.hue, i.sat, i.light], ["247", "87%", "65%"], "his colour, untouched");
      assert.deepEqual([Math.round(i.w), Math.round(i.h), i.size], [16, 16, "16px"], "sized from its --size");
      assert.equal(i.books, 3); assert.equal(i.bookSeen, true); assert.ok(i.paint.every((p) => p.startsWith("linear-gradient")), "drawn by his stylesheet");
      assert.equal(i.filter, "none"); assert.equal(i.opacity, "1");
      assert.equal(i.hidden, "true", "hidden from a screen reader: the tab says Library in words");
      if (width < 292) assert.ok(i.word[0] <= 1.5 && i.word[1] <= 1.5, "icon mode: the word takes no room");
      else { assert.ok(i.word[0] > 20, "the word is beside it"); assert.ok(i.right <= i.wordLeft - 3, "the icon before the word, with a gap"); assert.ok(Math.abs(i.mid - i.wordMid) <= 1.5, "centred on the word"); }
      assert.equal((await x.tabs()).overflowX, false);
      const bar = await x.tabs();
      for (const b of bar.tabs) assert.equal(b.clipped, false, `${b.name} is whole`);
    } finally { await x.close(); }
  });
  test(`${width} px (${theme}): Home's Library button wears his books beside “Library” (alone when narrow)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width, theme });
    try {
      const i = await iris(x.page, "#home-hub .hc-library-btn");
      assert.ok(i?.seen); assert.deepEqual([i.hue, i.sat, i.light], ["247", "87%", "65%"]);
      assert.deepEqual([Math.round(i.w), Math.round(i.h), i.size], [16, 16, "16px"]);
      assert.equal(i.books, 3); assert.equal(i.hidden, "true"); assert.equal(i.name, "Library");
      assert.equal(await x.page.evaluate(() => !!document.querySelector("#home-hub .hc-library-btn svg")), false, "the line icon is gone");
    } finally { await x.close(); }
  });
}
test("forced colours: the books fall back to CanvasText, so the icon never vanishes (170 px)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 170, forced: true });
  try {
    const i = await iris(x.page, "#side-tab-library");
    assert.ok(i?.seen && i.bookSeen);
    const canvasText = await x.page.evaluate(() => { const p = document.createElement("span"); p.style.color = "CanvasText"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
    // (The chosen tab is Highlight with HighlightText; any other is CanvasText.)
    assert.ok(i.ground.every((g) => g === canvasText), `each book is CanvasText (${i.ground[0]} vs ${canvasText})`);
  } finally { await x.close(); }
});
