// No blank icons in the Pips view (0.52, found 13 Nov). The view is drawn in two places: an editor tab (a page of its
// own, which links the icon font's stylesheet) and the side bar (a shadow root inside Work's page). The font is
// declared in Work's page, so CSS in the shadow root that names it draws; but the stylesheet's CLASSES are not in the
// shadow root, so an element that asks for a glyph by class (codicon codicon-chevron-up) had no size and drew nothing.
// The fold of "Needs attention" was the one such glyph the view draws. (13 Nov: the heading has no mark at all now. A
// chevron beside it read as a dropdown, so the fold is a quiet word at the end of its line, "Hide" or "Show": this
// file holds that the word paints in both places, that it says the fold's state, and that no mark is left behind.)
// Read in real Chromium from the painted pixels: the side bar's real page with the real Pips view in its shadow root
// (test/support/project-folder-pips-scene.mjs) at 700 and 300 px, dark and light, and the view as a tab and in forced
// colours (test/support/pip-chat-scene.mjs).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { openPips } from "./support/project-folder-pips-scene.mjs";
import { client, openChat } from "./support/pip-chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, decoder;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); decoder = await browser.newPage(); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const here = new URL("..", import.meta.url).pathname;
await client();   // built before the first test is registered (a pending top-level await would end the file early)

// ---- which files draw the view -----------------------------------------------------------------------------------
// Drawn in Work's page or the page's own body, where the font's classes are loaded in both places: the main chat's
// setup cards (src/pipSetupCards.js is in the bundle for window.DgcPips.mountSetupCards), and the trace dialog
// (media/trace.js appends it to document.body). The shared pieces under media/ keep a font glyph as their fallback for
// Work and ChatDGC; the Pips view gives each of them its own drawing (the brief's audit lists them).
test("the Pips view's own files ask the icon font for no glyph by class", async () => {
  const out = await build({ entryPoints: [`${here}src/pipsClient.js`], bundle: true, write: false, metafile: true, format: "iife", outdir: "out", platform: "browser", logLevel: "silent",
    loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" } });
  const own = Object.keys(out.metafile.inputs).filter((f) => /^src\/pips?[A-Z][A-Za-z]*\.js$/.test(f) && f !== "src/pipSetupCards.js");
  assert.ok(own.includes("src/pipsClient.js") && own.includes("src/pipAttention.js") && own.length > 30, `the view's files: ${own.length}`);
  const asks = own.flatMap((f) => (readFileSync(here + f, "utf8").match(/codicon-[a-z][a-z-]*/g) || []).map((name) => `${f}: ${name}`));
  assert.deepEqual(asks, [], "a glyph asked for by class is blank in the side bar: draw it (see trayIcon, transcriptIcon)");
});

// ---- the painted pixels --------------------------------------------------------------------------------------------
const ROOT = '(window.__pipsRoot || document.getElementById("pips-host")?.shadowRoot || document)';
const FOLD = "#attention-toggle";
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
/** What `selector` (in the Pips view) paints: its box, and its ink read from two pictures of that box, with it and
 *  without it. `ink`: how many pixels it changes; `top` and `bottom`: how wide the ink is in its first and last rows (a
 *  chevron pointing up is narrow at the top and wide at the bottom); `ratio`: its strongest pixel against the ground. */
async function painted(page, selector) {
  const read = (hide) => page.evaluate(([root, s, hide]) => { const e = (0, eval)(root).querySelector(s); if (!e) return null; e.style.visibility = hide ? "hidden" : "";
    const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; }, [ROOT, selector, hide]);
  const box = await read(false);
  if (!box) return { missing: true, ink: 0, width: 0, height: 0 };
  if (box.width < 1 || box.height < 1) return { ...box, ink: 0 };
  const clip = { x: Math.floor(box.x) - 1, y: Math.floor(box.y) - 1, width: Math.ceil(box.width) + 2, height: Math.ceil(box.height) + 2 };
  await settle(page);
  const shown = (await page.screenshot({ clip })).toString("base64");
  await read(true); await settle(page);
  const hidden = (await page.screenshot({ clip })).toString("base64");
  await read(false); await settle(page);
  const m = await decoder.evaluate(async ([a, b]) => {
    const px = async (data) => { const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const ctx = new OffscreenCanvas(image.width, image.height).getContext("2d"); ctx.drawImage(image, 0, 0); return { w: image.width, h: image.height, d: ctx.getImageData(0, 0, image.width, image.height).data }; };
    const A = await px(a), B = await px(b), rows = [];
    const lum = (r, g, bl) => { const v = [r, g, bl].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    let ink = 0, ratio = 1;
    for (let y = 0; y < A.h; y++) { let lo = -1, hi = -1;
      for (let x = 0; x < A.w; x++) { const i = (y * A.w + x) * 4, d = Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]);
        if (d <= 24) continue;
        ink++; if (lo < 0) lo = x; hi = x;
        const [p, q] = [lum(A.d[i], A.d[i + 1], A.d[i + 2]), lum(B.d[i], B.d[i + 1], B.d[i + 2])].sort((m, n) => n - m); ratio = Math.max(ratio, (p + 0.05) / (q + 0.05)); }
      if (lo >= 0) rows.push(hi - lo + 1); }
    return { ink, rows: rows.length, top: rows[0] || 0, bottom: rows[rows.length - 1] || 0, ratio: Math.round(ratio * 100) / 100 };
  }, [shown, hidden]);
  return { ...box, ...m };
}
/** The fold as the page has it: the heading's words, and the word at the end of its line that folds it. */
const fold = (page) => page.evaluate(([root, s]) => { const r = (0, eval)(root), toggle = r.querySelector(s), head = toggle.closest(".attention-head"), title = head.querySelector(".attention-title"), list = r.querySelector("#attention-list");
  const box = (e) => e.getBoundingClientRect(), t = box(toggle), count = title.querySelector(".attention-count");
  return { expanded: toggle.getAttribute("aria-expanded"), controls: toggle.getAttribute("aria-controls"), heading: title.textContent.replace(/\s+/g, " ").trim(), word: toggle.textContent, label: toggle.getAttribute("aria-label"), tag: toggle.tagName, type: toggle.type,
    marks: head.querySelectorAll("svg, .codicon, .attention-fold, [aria-hidden=true]").length, drawn: [title, toggle].map((e) => [getComputedStyle(e, "::before").content, getComputedStyle(e, "::after").content].join()).join(),
    afterCount: t.left - box(count).right, centred: Math.abs((t.top + t.bottom) / 2 - (box(count).top + box(count).bottom) / 2), atEnd: Math.abs(t.right - box(head).right),
    list: !!list && !list.hasAttribute("hidden") && box(list).height > 0, cards: r.querySelectorAll(".attention-list > li").length,
    sideways: (r.querySelector(".pip-app-root") || document.body).scrollWidth - (r.querySelector(".pip-app-root") || document.body).clientWidth }; }, [ROOT, FOLD]);
/** Every element of the view that asks the icon font for a glyph, by class or in CSS, and has no box to draw it in. */
const blank = (page) => page.evaluate((root) => [...(0, eval)(root).querySelectorAll("*")].filter((e) => { const cls = String(e.className?.baseVal ?? e.className ?? "");
  const font = /codicon/.test(getComputedStyle(e).fontFamily), before = getComputedStyle(e, "::before"), b = e.getBoundingClientRect();
  if (!e.checkVisibility()) return false;
  if (/\bcodicon-[a-z]/.test(cls)) return !(font || /codicon/.test(before.fontFamily)) || b.width < 1 || b.height < 1;   // asked for by class: the class must be here
  return /\bcodicon\b/.test(cls) && !e.querySelector("svg") && getComputedStyle(e).maskImage === "none";                    // a holder with nothing in it
}).map((e) => String(e.className)), ROOT);
const expanded = (page, value) => page.waitForFunction(([root, v]) => (0, eval)(root).querySelector("#attention-toggle")?.getAttribute("aria-expanded") === v, [ROOT, value]);

async function checkFold(page, { where, colours = "themed" }) {
  // Open, as it starts with something in it: the heading is words and its count with no mark, and the fold's word,
  // "Hide", paints at the end of its line.
  let f = await fold(page), m = await painted(page, FOLD);
  assert.deepEqual([f.tag, f.type, f.expanded, f.controls, f.list], ["BUTTON", "button", "true", "attention-list", true], `${where}: the fold is a button, open`);
  assert.equal(f.cards, 1, "one card in view");
  assert.match(f.heading, /^Needs you \d+$/, "the heading is its words and its count");
  assert.deepEqual([f.marks, f.drawn], [0, "none,none,none,none"], `${where}: no chevron, no mark of any kind on the heading's line`);
  assert.deepEqual([f.word, f.label], ["Hide", "Hide the cards that need your attention"]);
  assert.ok(m.width >= 20 && m.height >= 16, `${where}: the word has room to be drawn in: ${JSON.stringify(m)}`);
  assert.ok(m.ink >= 30, `${where}: the word paints: ${JSON.stringify(m)}`);
  if (colours === "themed") assert.ok(m.ratio >= 4.5, `${where}: and can be read against its ground (4.5:1): ${m.ratio}`);
  assert.ok(f.afterCount >= 6 && f.centred <= 1.5 && f.atEnd <= 0.5, `${where}: after the count, on its line, at the line's end: ${JSON.stringify(f)}`);
  assert.ok(f.sideways <= 1, "nothing scrolls sideways");
  assert.deepEqual(await blank(page), [], `${where}: nothing in the view waits on the font's classes`);
  // Folded by the keyboard: the word says Show and the card goes. (The redraw makes the button anew, so each key is
  // given to the button as it then is, as test/pip-cards-browser.test.mjs does: where the keyboard is afterwards is as it was.)
  const focus = () => page.evaluate((root) => (0, eval)(root).querySelector("#attention-toggle").focus(), ROOT);
  await focus(); await page.keyboard.press("Enter"); await expanded(page, "false");
  f = await fold(page); m = await painted(page, FOLD);
  assert.deepEqual([f.expanded, f.list, f.cards, f.controls, f.word, f.label, f.marks], ["false", false, 0, "attention-list", "Show", "Show the cards that need your attention", 0], `${where}: Enter folds it`);
  assert.ok(m.ink >= 30, `${where}: folded, the word paints: ${JSON.stringify(m)}`);
  assert.match(f.heading, /^Needs you \d+$/);
  // Open again with Space.
  await focus(); await page.keyboard.press("Space"); await expanded(page, "true");
  f = await fold(page);
  assert.deepEqual([f.expanded, f.list, f.cards, f.word], ["true", true, 1, "Hide"], `${where}: Space opens it`);
}

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) for (const tab of ["personal", "project"]) {
  test(`the side bar: the fold of Needs attention is a word that paints and says its state, with no mark (${tab} tab, ${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width, tab, scale: 2 });
    try {
      await x.page.mouse.move(2, 2);
      await checkFold(x.page, { where: `side bar, ${tab}` });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const theme of ["dark", "light"]) {
  test(`an editor tab: the same word and no mark, beside the font's own stylesheet (${theme}, 700px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width: 700, height: 800, theme, where: "tab", home: true, waiting: 3, scale: 2 });
    try {
      // The tab's page links media/codicon.css (src/pipsView.ts): with it here too, nothing of the font is drawn on the heading.
      await x.p.addStyleTag({ content: readFileSync(`${here}media/codicon.css`, "utf8").replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${readFileSync(`${here}media/codicon.ttf`).toString("base64")}")`) });
      await x.p.waitForSelector(".attention-toggle"); await x.p.mouse.move(2, 2);
      await checkFold(x.p, { where: "tab" });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
  test(`high contrast (forced colours): the word still shows and says its state, in the side bar at 300px and a tab at 700px (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    for (const [where, width] of [["side", 300], ["tab", 700]]) {
      const x = await openChat(browser, { width, height: 800, theme, where, home: true, waiting: 3, scale: 2, forced: true });
      try {
        await x.p.waitForSelector(".attention-toggle"); await x.p.mouse.move(2, 2);
        await checkFold(x.p, { where: `forced colours, ${where}`, colours: "forced" });
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });
}

// CSS that NAMES the font (media/mentions.css: a link's, a skill's and a template's pill) does draw in the shadow root,
// since Work's page declares the font. A Pip's box makes none of those pills; this pins why they were left as they are.
test("the side bar: a glyph the view's CSS draws by naming the font paints in the shadow root", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPips(browser, { theme: "dark-modern", width: 300, tab: "personal", scale: 2 });
  try {
    await x.inPips((root) => { const pill = document.createElement("span"); pill.className = "composer-pill pill-link"; pill.id = "probe-pill"; pill.style.cssText = "position:fixed;left:8px;top:8px;z-index:99;display:inline-block;font-size:0";
      root.querySelector(".pip-app-root").append(pill); });
    await x.page.evaluate(() => document.fonts.load("12px codicon"));
    const made = await x.inPips((root) => { const b = getComputedStyle(root.querySelector("#probe-pill"), "::before"); return [b.fontFamily, b.content !== "none" && b.content !== '""' ? "a glyph" : b.content, document.fonts.check("12px codicon")]; });
    assert.deepEqual(made, ["codicon", "a glyph", true]);
    await x.inPips((root) => { root.querySelector("#probe-pill").style.fontSize = "12px"; });
    const m = await painted(x.page, "#probe-pill");
    assert.ok(m.ink >= 20, `the globe paints: ${JSON.stringify(m)}`);
  } finally { await x.close(); }
});
