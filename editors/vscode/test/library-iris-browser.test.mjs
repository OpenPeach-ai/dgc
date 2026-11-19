// The Library icon, Iris (0.52): three books, hue 247,
// saturation 87%, lightness 65%, used exactly as he made it: its stylesheet (namespaced .library-iris) and its PNGs are
// copied into the extension byte for byte (media/icons/library-iris/), and its README's markup is what the page holds:
// <span class="library-iris" aria-hidden="true"><i></i><i></i><i></i></span> beside the visible word "Library", and
// role="img" + aria-label="Library" where it stands alone. Places: Home's Library button beside Cards, and the editor
// Library panel's tab icon (its PNG, light and dark). Sizes from its --size (16, 20, 24). Under forced colours it falls
// back to CanvasText, so it never vanishes.
// NOT on the side bar's header tab (his call of 15 Nov, after seeing it there: "the header tabs don't need to show icon
// for library, only Pips tab shows Core's face, not any other tab"): with words showing, the Library tab is the word
// alone; in the narrow icon mode it is a plain line icon of Home's, Work's and Chat's family, size and colour (the
// codicon "library"), never the coloured books.
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
  assert.doesNotMatch(tab, /library-iris/, "the header's Library tab does not hold it: only Pips has a picture on its tab");
  assert.match(tab, /<span class="dgc-tab-icon codicon codicon-library" aria-hidden="true"><\/span><span class="dgc-tab-word">Library<\/span>/, "the tab is the word, with the plain line icon for the narrow icon mode");
  assert.doesNotMatch(read("media/shared/tabs.css"), /\.dgc-tab[^{}]*\.library-iris/, "and the tab bar's stylesheet has no rule for it on a tab");
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

// The header's Library tab as it is drawn: what it shows, and Work's and Chat's icons beside it to compare.
const tabNow = (page) => page.evaluate(() => {
  const seen = (n) => !!n && n.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && n.getBoundingClientRect().width > 1.5 && n.getBoundingClientRect().height > 1.5;
  const of = (id) => { const t = document.getElementById(`side-tab-${id}`), icon = t.querySelector(".dgc-tab-icon"), word = t.querySelector(".dgc-tab-word"), r = icon.getBoundingClientRect(), s = getComputedStyle(icon);
    return { iris: t.querySelectorAll(".library-iris").length, pictures: [...t.querySelectorAll("svg, img, .library-iris, .dgc-tab-face")].filter(seen).length, icon: seen(icon), cls: [...icon.classList].filter((c) => c.startsWith("codicon-")).join(" "),
      w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, colour: s.color, font: s.fontFamily, size: s.fontSize, glyph: getComputedStyle(icon, "::before").content, image: s.backgroundImage, hidden: icon.getAttribute("aria-hidden"),
      word: seen(word), text: word.textContent, name: t.textContent.trim() }; };
  return { library: of("library"), work: of("work"), chat: of("chat") };
});
for (const theme of ["dark-modern", "light-modern"]) for (const width of [170, 279, 280, 300, 440]) {
  test(`${width} px (${theme}): the header's Library tab is ${width < 280 ? "a plain line icon like Work's and Chat's, never his coloured books" : "the word “Library” alone: no icon, no coloured mark"}`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, theme });
    try {
      const { library: l, work, chat } = await tabNow(x.page);
      assert.equal(l.iris, 0, "his Iris books are not on the tab");
      assert.equal(l.pictures, 0, "no picture or coloured mark on it (only Pips has one)");
      assert.equal(l.name, "Library"); assert.equal(l.cls, "codicon-library"); assert.equal(l.hidden, "true");
      if (width >= 280) { assert.equal(l.word, true, "the word is drawn"); assert.equal(l.icon, false, "and no icon beside it"); assert.deepEqual([work.icon, chat.icon], [false, false], "as on Work and Chat"); }
      else {
        assert.equal(l.word, false, "icon mode: the word takes no room (it stays for a screen reader)"); assert.equal(l.text, "Library");
        assert.equal(l.icon, true, "its line icon is drawn");
        assert.match(l.font, /codicon/, "from the editor's icon font, as Home's, Work's and Chat's");
        assert.ok(l.glyph && l.glyph !== "none" && l.glyph !== "normal", `it has its glyph (${l.glyph})`);
        assert.equal(l.image, "none", "a glyph in the text's colour, not a drawing");
        assert.deepEqual([l.w, l.h, l.size], [work.w, work.h, work.size], "the size of Work's icon"); assert.deepEqual([l.w, l.h], [chat.w, chat.h]);
        assert.equal(l.colour, work.colour, "the colour of Work's icon"); assert.equal(l.colour, chat.colour, "and of Chat's");
      }
      assert.equal((await x.tabs()).overflowX, false);
      const bar = await x.tabs();
      for (const b of bar.tabs) assert.equal(b.clipped, false, `${b.name} is whole`);
    } finally { await x.close(); }
  });
}
for (const theme of ["dark-modern", "light-modern"]) for (const width of [170, 292, 300, 440]) {
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
test("forced colours: the books fall back to CanvasText, so the icon never vanishes (Home's Library button, 170 px)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 170, forced: true });
  try {
    const i = await iris(x.page, "#home-hub .hc-library-btn");
    assert.ok(i?.seen && i.bookSeen);
    const canvasText = await x.page.evaluate(() => { const p = document.createElement("span"); p.style.color = "CanvasText"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
    assert.ok(i.ground.every((g) => g === canvasText), `each book is CanvasText (${i.ground[0]} vs ${canvasText})`);
  } finally { await x.close(); }
});
