// One header row everywhere (0.52, asked 15 Nov on build 4960f96a: "Pip's page top section, which i asked you to
// build for work and chat too, does not match, there is size difference … make the work, chat and library match the
// Pip's style or vice versa"). Work, Chat, Library and Pips draw their header row with ONE shared component
// (media/shared/pagehead.js + pagehead.css, window.DgcPageHead): the title at the left, ⋯ at the right, the line under
// it. Measured here on the real side bar in real Chromium, tab by tab on one page: the title's font size, weight,
// colour, place and height, the ⋯'s place and size, the row's height and padding, and the line are identical in all
// four. The one look: a quiet title in the text colour (Pips' title is no longer purple); Pips keeps its small status
// dot beside the title. The Library's editor tab wears the same row.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openLibraryTab, openLibraryPage } from "./support/library-scene.mjs";

const root = new URL("..", import.meta.url).pathname;
const read = (name) => readFileSync(root + name, "utf8");
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

/** The header row that is on screen now (the side bar's page, or the Pips view's shadow root), as drawn. */
export const headNow = (page) => page.evaluate(() => {
  const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true });
  const pips = document.getElementById("pips-host");
  const all = [...document.querySelectorAll(".dgc-pagehead"), ...(pips?.shadowRoot?.querySelectorAll(".dgc-pagehead") || [])].filter(seen);
  if (all.length !== 1) return { count: all.length };
  const head = all[0], title = head.querySelector(".dgc-pagehead-title"), more = head.querySelector(".dgc-pagehead-more"), cs = getComputedStyle(head), ts = getComputedStyle(title), ms = getComputedStyle(more);
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  const range = document.createRange(); range.selectNodeContents(title);
  const words = [...range.getClientRects()].filter((r) => r.width > 1);
  return { count: 1, text: title.textContent.trim(), tag: title.tagName, head: box(head), title: box(title), more: box(more), words: new Set(words.map((r) => Math.round(r.top / 4))).size, wordsLeft: words[0]?.left, wordsTop: words[0]?.top, wordsHeight: words[0]?.height,
    font: [ts.fontSize, ts.fontWeight, ts.fontFamily, ts.lineHeight, ts.letterSpacing], colour: ts.color, cut: title.scrollWidth > title.clientWidth + 1,
    pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft], line: [cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor],
    dots: { colour: ms.color, radius: ms.borderTopLeftRadius, background: ms.backgroundColor, border: ms.borderTopWidth, icon: (() => { const r = more.querySelector("svg").getBoundingClientRect(); return [r.width, r.height, r.left - more.getBoundingClientRect().left]; })() },
    moreLabel: more.getAttribute("aria-label") || "", aside: !!head.querySelector(".dgc-pagehead-aside"), width: innerWidth, sideways: document.documentElement.scrollWidth > innerWidth };
});
const TABS = [["work", "Work"], ["chat", "Chat"], ["library", "Library"], ["pips", "Pips"]];
async function four(x) {
  const out = {};
  for (const [id] of TABS) {
    await x.page.click(`#side-tab-${id}`);
    if (id === "pips") await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot?.querySelector("[data-job]"), null, { timeout: 20000 });
    await x.settle(); await x.page.waitForTimeout(120);
    out[id] = await headNow(x.page);
  }
  return out;
}
const near = (a, b) => Math.abs(a - b) < 0.6;

test("one component: Work, Chat, Library and Pips draw their header row with DgcPageHead, and the old rows' own rules are gone", () => {
  const head = read("media/shared/pagehead.js"), css = read("media/shared/pagehead.css");
  assert.match(head, /DgcPageHead/); assert.match(css, /\.dgc-pagehead-title/);
  assert.match(read("media/main.css"), /shared\/pagehead\.css/, "the side bar's page has its look");
  const pips = read("src/pipsClient.js");
  assert.match(pips, /shared\/pagehead\.css/); assert.match(pips, /shared\/pagehead\.js/); assert.match(pips, /DgcPageHead\.html\(/, "Pips draws its row with it");
  assert.match(read("media/main.js"), /DgcPageHead\.html\(/, "Work and Chat draw theirs with it");
  assert.match(read("media/library.js"), /DgcPageHead\.html\(/, "and the Library its own, in the side bar and in its tab");
  assert.doesNotMatch(read("src/panel.ts"), /class="home-head"|class="home-title"/, "no second copy of the row in the page");
  assert.doesNotMatch(read("media/main.css"), /\.home-head\b|\.home-title\b|\.home-more\b/, "nor of its look");
  assert.doesNotMatch(read("src/pips.css"), /\.simple-bar h1\b/, "Pips' own title rule is gone");
  assert.doesNotMatch(pips, /<header class="simple-bar"><h1>/);
});
for (const theme of ["dark-modern", "light-modern"]) for (const width of [170, 300, 440, 700]) {
  test(`${width} px (${theme}): Work, Chat, Library and Pips have the same header row, measured: title, ⋯, height, padding, line`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openLibraryTab(browser, { tab: "work", width, theme });
    try {
      const h = await four(x), work = h.work;
      for (const [id, name] of TABS) {
        const it = h[id];
        assert.equal(it.count, 1, `${name}: one header row on screen`);
        assert.equal(it.text, name, `${name}: its title`);
        assert.equal(it.words, 1, `${name}: the title is one line, never broken inside the word`);
        assert.equal(it.cut, false, `${name}: the title is whole`);
        assert.deepEqual(it.font, work.font, `${name}: the title's font size, weight, family, line and spacing are Work's`);
        assert.equal(it.colour, work.colour, `${name}: the title's colour is Work's`);
        assert.ok(near(it.wordsLeft, work.wordsLeft) && near(it.wordsTop, work.wordsTop) && near(it.wordsHeight, work.wordsHeight), `${name}: the title's words are where Work's are (${it.wordsLeft}, ${it.wordsTop} vs ${work.wordsLeft}, ${work.wordsTop})`);
        assert.ok(near(it.head.top, work.head.top) && near(it.head.h, work.head.h) && near(it.head.left, work.head.left) && near(it.head.right, work.head.right), `${name}: the row is Work's row (${JSON.stringify(it.head)} vs ${JSON.stringify(work.head)})`);
        assert.deepEqual(it.pad, work.pad, `${name}: the row's padding`);
        assert.deepEqual(it.line, work.line, `${name}: the line under it (width, style, colour)`);
        assert.ok(near(it.more.left, work.more.left) && near(it.more.top, work.more.top) && near(it.more.w, work.more.w) && near(it.more.h, work.more.h), `${name}: ⋯ is where Work's is, the same size`);
        assert.deepEqual(it.dots, work.dots, `${name}: ⋯ looks the same (colour, corner, icon)`);
        assert.ok(it.moreLabel, `${name}: ⋯ has a name`);
        assert.equal(it.sideways, false);
      }
      assert.equal(work.line[0], "1px"); assert.equal(work.line[1], "solid");
      assert.ok(near(work.more.w, 28) && near(work.more.h, 28), "⋯ is 28 px square");
      assert.equal(work.dots.radius, "6px", "with the 6 px corner");
      assert.ok(work.more.right <= width - 7.5 && work.title.left >= 7.5, "inside the side bar's margin");
      assert.equal(h.pips.aside, true, "Pips keeps its status dot beside the title");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
test("the Library's editor tab wears the same header row: the same title font and colour, the same ⋯ and line", async (t) => {
  if (skipOrFail(t)) return;
  const side = await openLibraryTab(browser, { width: 440 }), tab = await openLibraryPage(browser, { width: 1100 });
  try {
    const a = await headNow(side.page), b = await headNow(tab.page);
    assert.equal(b.count, 1); assert.equal(b.text, "Library");
    assert.deepEqual(b.font, a.font); assert.equal(b.colour, a.colour); assert.deepEqual(b.pad, a.pad); assert.deepEqual(b.line, a.line); assert.deepEqual(b.dots, a.dots);
    assert.ok(near(b.head.h, a.head.h) && near(b.more.w, a.more.w) && near(b.more.h, a.more.h));
  } finally { await side.close(); await tab.close(); }
});
test("the ⋯ of each still opens its own menu", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { tab: "work", width: 300 });
  try {
    const rows = async (id, more) => { await x.page.click(`#side-tab-${id}`); await x.settle(); await x.page.click(more); await x.page.waitForTimeout(350);
      const said = await x.page.evaluate(() => [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].map((r) => r.textContent.trim())); await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(200); return said; };
    assert.deepEqual(await rows("work", "#work-more"), ["Archived sessions", "Sub-agent settings", "Work settings"]);
    assert.deepEqual(await rows("chat", "#chats-more-menu"), ["New incognito chat", "What DGC remembers", "Archived chats", "Chat settings"]);
    assert.deepEqual(await rows("library", "#library-more"), ["Open the Library in the editor", "Page preview settings"]);
    await x.page.click("#side-tab-pips");
    await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot?.querySelector("[data-job]"), null, { timeout: 20000 });
    const open = await x.page.evaluate(() => { const root = document.getElementById("pips-host").shadowRoot, toggle = root.querySelector(".dgc-pagehead .dgc-pagehead-more"); toggle.click(); return [toggle.id, root.querySelector(".runner-controls").open, !!root.querySelector(".runner-menu #refresh")]; });
    assert.deepEqual(open, ["runner-controls-toggle", true, true], "Pips' ⋯ is its Controls");
  } finally { await x.close(); }
});

// Noted 17 Nov: "below the main header tab, we have “Pips” then a green dot, and on the right three dots … the green
// dot and three dots don't align to the centre of the “Pips” text." The row centred each part's box, and the title's
// box runs from above its capitals to below its descenders ("p"), so the dot and ⋯ sat 1.5 px under the middle of the
// letters. The title's box is now its capitals (text-box: cap to the baseline), so the row centres on them; the
// descenders still show. Measured on the drawn pixels at 2x: the middle of the "P" (its top to the baseline), of the
// dot, and of the ⋯.
test("the status dot and ⋯ sit on the middle of the title's letters, not of its box (Pips, 2x, both themes)", async (t) => {
  if (skipOrFail(t)) return;
  const { openOnePips } = await import("./support/one-pips-scene.mjs");
  for (const theme of ["dark-modern", "light-modern"]) {
    const x = await openOnePips(browser, { width: 440, theme, scale: 2 });
    try {
      await x.page.waitForTimeout(400);
      const parts = await x.inPips((root) => {
        const head = root.querySelector(".dgc-pagehead"), r = (n) => { const b = n.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
        const title = head.querySelector(".dgc-pagehead-title"), range = document.createRange(); range.setStart(title.firstChild, 0); range.setEnd(title.firstChild, 1);
        const first = range.getBoundingClientRect();
        return { head: r(head), cap: { x: first.left, y: first.top, w: first.width, h: first.height }, word: r(title), dot: r(head.querySelector(".status-dot")), more: r(head.querySelector(".dgc-pagehead-more svg")),
          text: title.textContent, trim: getComputedStyle(title).textBoxTrim || "" };
      });
      assert.equal(parts.text, "Pips");
      const png = (await x.page.screenshot({ clip: { x: parts.head.x, y: parts.head.y, width: parts.head.w, height: parts.head.h } })).toString("base64");
      const blank = await browser.newPage();
      const cols = (b) => ({ x0: Math.round((b.x - parts.head.x) * 2) + 1, x1: Math.round((b.x + b.w - parts.head.x) * 2) - 1 });
      const [cap, word, dot, more] = await blank.evaluate(async ([src, boxes]) => {
        const img = new Image(); img.src = `data:image/png;base64,${src}`; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data, bg = [d[0], d[1], d[2]];
        return boxes.map((b) => { let top = 1e9, bot = -1;
          for (let y = 0; y < c.height - 3; y++) for (let x = Math.max(0, b.x0); x < Math.min(c.width, b.x1); x++) { const i = (y * c.width + x) * 4;
            if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 90) { top = Math.min(top, y); bot = Math.max(bot, y); } }
          return { top, bot, mid: (top + bot) / 2 }; });
      }, [png, [cols(parts.cap), cols(parts.word), cols(parts.dot), cols(parts.more)]]);
      await blank.close();
      assert.ok(Math.abs(dot.mid - cap.mid) <= 1.5, `${theme}: the dot's middle (${dot.mid}) is the capital's (${cap.mid}), in device pixels`);
      assert.ok(Math.abs(more.mid - cap.mid) <= 1.5, `${theme}: the ⋯'s middle (${more.mid}) is the capital's (${cap.mid})`);
      assert.ok(word.bot >= cap.bot + 4, `${theme}: the "p"s still hang below the line (${word.bot} vs ${cap.bot}): nothing is cut`);
    } finally { await x.close(); }
  }
});
