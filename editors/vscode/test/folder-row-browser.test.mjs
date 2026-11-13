// The Project Folder dropdown on a row that is already there (0.52, his calls on 12 Nov night), in real Chromium with
// the real pages (test/support/home-scene.mjs, test/support/project-folder-pips-scene.mjs), at 700 and 300 px, dark and
// light. Over the Work sessions it is on the Library row, at its right end (View all lists in place, with no dropdown of its own, since 13 Nov).
// (On the Pips view's Project tab it has a line of its own since 13 Nov: test/pips-folder-line-browser.test.mjs.)
// One line always: when the row is too narrow for it the button drops
// its "Project Folder" word (measured, never a breakpoint), then a long folder name ends in an ellipsis. No line names
// one folder's path any more: the button's tooltip has it. And a long path is cut in the middle with its folder's own
// name whole and no space before the name's slash. Read from the DOM, computed style, geometry and the painted pixels.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { homeContrast, openHome } from "./support/home-scene.mjs";
import { FOLDERS, listOf } from "./support/folder-row-scene.mjs";

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

const LONG = FOLDERS[2].folder, WORDY = FOLDERS[4].folder;
const low = (marks) => marks.filter((m) => m.ratio < (m.kind === "words" || !m.kind ? 4.5 : 3));
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** The Library row as it is on screen. */
const rowNow = (page) => page.evaluate(() => {
  const box = (e) => e.getBoundingClientRect(), pick = document.getElementById("sessions-folder-pick"), lib = document.getElementById("work-library"), list = document.getElementById("sessions-list");
  const word = pick?.querySelector(".dgc-folder-k"), value = pick?.querySelector(".dgc-folder-v"), host = document.getElementById("sessions-host");
  const whole = (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().width <= box(e).width + 0.01; };
  const mid = (e) => (box(e).top + box(e).bottom) / 2, words = lib.querySelector("span:last-child");
  return { pick: !!pick?.checkVisibility(), lib: lib.checkVisibility() ? { left: box(lib.querySelector(".codicon")).left, wordsLeft: box(words).left, wordsWidth: box(words).width, whole: whole(words), text: words.textContent } : null,
    word: !!word?.checkVisibility(), value: value?.textContent || "", valueWhole: value ? whole(value) : false, ellipsis: value ? getComputedStyle(value).textOverflow : "",
    label: pick?.getAttribute("aria-label") || "", title: pick?.title || "", pickHeight: pick ? box(pick).height : 0,
    sameLine: pick && lib.checkVisibility() ? Math.abs(mid(pick) - mid(lib)) : 0, apart: pick && lib.checkVisibility() ? box(pick).left - box(words).right : 99,
    rightEnd: pick ? Math.abs(box(pick).right - box(document.getElementById("sessions-new")).right) : 99,
    // Nothing between the search row and the list but this one row: the list starts where it did with no dropdown at all.
    listTop: box(list).top - box(document.getElementById("sessions-search")).bottom,
    pathLine: [...document.querySelectorAll("#sessions-folder, .sessions-folder, .sessions-folder-path")].filter((e) => e.checkVisibility()).length,
    bar: [...document.querySelectorAll("#sessions-folderbar")].filter((e) => e.checkVisibility()).length, sideways: host.scrollWidth > host.clientWidth + 1 };
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`Work sessions: the dropdown is on the Library row, at its right end, on one line; Library stays where it was (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab: "work", motion: "reduce" });
    try {
      const before = await rowNow(x.page);                       // a DGC that lists no folders: Library alone
      assert.equal(before.pick, false);
      await x.send(listOf(""));
      await settle(x.page);
      const all = await rowNow(x.page);
      assert.equal(all.pick, true);
      assert.deepEqual([all.bar, all.pathLine], [0, 0], "no row of its own, no path line");
      assert.ok(all.sameLine <= 1, `centred on Library's line: ${all.sameLine}`);
      assert.ok(all.rightEnd <= 0.5, `at the row's right end, under New's edge: ${all.rightEnd}`);
      assert.ok(all.apart >= 8, `clear of Library's word: ${all.apart}`);
      assert.deepEqual([all.lib.left, all.lib.wordsLeft, all.lib.wordsWidth, all.lib.whole], [before.lib.left, before.lib.wordsLeft, before.lib.wordsWidth, true], "Library is where it was, whole");
      assert.ok(Math.abs(all.listTop - before.listTop) <= 0.5, `the list starts where it did with no dropdown: ${all.listTop} against ${before.listTop}`);
      assert.ok(all.pickHeight <= 30, "one line");
      assert.deepEqual([all.word, all.value, all.valueWhole, all.label, all.title], [true, "All projects", true, "Project Folder: All projects", "Project Folder: All projects"], "room for all of it: the word stays");
      assert.equal(all.sideways, false);
      assert.deepEqual(low(await homeContrast(x.page)), []);

      // One folder with a long path: its name on the button, the whole path in the tooltip, no line for it.
      await x.send(listOf(LONG));
      await settle(x.page);
      const one = await rowNow(x.page);
      assert.deepEqual([one.bar, one.pathLine], [0, 0]);
      assert.deepEqual([one.value, one.valueWhole, one.label], ["checkout-service", true, "Project Folder: checkout-service"]);
      assert.equal(one.title, `Project Folder: checkout-service\n${LONG}`, "the tooltip says the choice and the whole path");
      assert.equal(one.word, width !== 300, "at 300 px the row is too narrow for the word and this name: the word goes, the name is whole");
      assert.ok(one.sameLine <= 1 && one.rightEnd <= 0.5 && one.pickHeight <= 30 && one.apart >= 8, JSON.stringify(one));
      assert.deepEqual([one.lib.left, one.lib.wordsLeft, one.lib.wordsWidth, one.lib.whole], [before.lib.left, before.lib.wordsLeft, before.lib.wordsWidth, true]);
      assert.ok(Math.abs(one.listTop - before.listTop) <= 0.5);
      assert.deepEqual(low(await homeContrast(x.page)), []);

      // A folder whose own name is longer than the row: the word goes first, then the name ends in an ellipsis.
      await x.send(listOf(WORDY));
      await settle(x.page);
      const wordy = await rowNow(x.page);
      if (width === 300) assert.deepEqual([wordy.word, wordy.valueWhole, wordy.ellipsis], [false, false, "ellipsis"], "the word gone, the name cut with an ellipsis");
      assert.ok(wordy.sameLine <= 1 && wordy.rightEnd <= 0.5 && wordy.pickHeight <= 30 && wordy.apart >= 8, JSON.stringify(wordy));
      assert.deepEqual([wordy.lib.left, wordy.lib.wordsLeft, wordy.lib.wordsWidth, wordy.lib.whole, wordy.sideways], [before.lib.left, before.lib.wordsLeft, before.lib.wordsWidth, true, false], "Library never shrinks or moves");
      assert.equal(wordy.label, "Project Folder: storefront-redesign-checkout-service-next-generation");
      // The menu still opens from it, under it and inside the view.
      await x.page.click("#sessions-folder-pick");
      await x.page.waitForSelector(".dgc-folder-menu");
      const menu = await x.page.evaluate(() => { const m = document.querySelector(".dgc-folder-menu").getBoundingClientRect(), p = document.getElementById("sessions-folder-pick").getBoundingClientRect();
        return { fits: m.left >= 0 && m.right <= innerWidth + 0.5 && m.bottom <= innerHeight + 0.5, under: m.top >= p.bottom - 0.5 }; });
      assert.deepEqual(menu, { fits: true, under: true });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`View all: the list opens in place, with no second search field or dropdown (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    // (View all opened a popover with a search field and a dropdown of its own until 13 Nov; the ones above the list
    // are the only ones now: test/sessions-view-all.test.mjs.)
    const x = await openHome(browser, { theme, width, tab: "work", motion: "reduce" });
    try {
      await x.send(listOf(""));
      await settle(x.page);
      const all = await x.page.locator("#sessions-all").isVisible();
      if (all) await x.page.click("#sessions-all");
      await settle(x.page);
      const m = await x.page.evaluate(() => ({ pops: document.querySelectorAll(".sessions-popover").length, fields: [...document.querySelectorAll("#work-home input")].filter((n) => n.checkVisibility()).length,
        picks: [...document.querySelectorAll("#work-home .dgc-folder")].filter((n) => n.checkVisibility()).length }));
      assert.deepEqual(m, { pops: 0, fields: 1, picks: 1 }, "one search field and one Project Folder dropdown, above the list");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the word goes only when the row has no room for it, and comes back when it has: every width from 300 to 700 px", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 700, tab: "work", motion: "reduce" });
  try {
    await x.send(listOf(LONG));
    const seen = [];
    const at = async (width) => { await x.page.setViewportSize({ width, height: 760 }); await settle(x.page); const m = await rowNow(x.page); seen.push([width, m.word]);
      assert.ok(m.valueWhole || !m.word, `${width}px: the name is never cut while the word still shows`);
      assert.ok(m.sameLine <= 1 && m.rightEnd <= 0.5 && m.pickHeight <= 30 && m.apart >= 8 && m.lib.whole && !m.sideways, `${width}px: one line, Library whole: ${JSON.stringify(m)}`);
      // The word is gone only where it would not fit: with it, the button would be wider than the room Library leaves.
      const fits = await x.page.evaluate(() => { const pick = document.getElementById("sessions-folder-pick"), copy = pick.cloneNode(true); copy.removeAttribute("id"); copy.style.cssText = "position:absolute;visibility:hidden;max-width:none;left:0;top:0";
        copy.querySelector(".dgc-folder-k").style.display = "inline"; document.getElementById("work-home").append(copy); const need = copy.getBoundingClientRect().width; copy.remove();
        const words = document.querySelector("#work-library span:last-child").getBoundingClientRect(); return need <= document.getElementById("sessions-new").getBoundingClientRect().right - words.right - 8; });
      assert.equal(m.word, fits, `${width}px: the word shows exactly when there is room for it`);
      return m; };
    for (let width = 700; width >= 300; width -= 25) await at(width);
    assert.equal(seen.at(-1)[1], false, "gone at 300 px");
    for (let width = 300; width <= 700; width += 50) await at(width);
    assert.equal(seen.at(-1)[1], true, "back at 700 px");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("with no Library yet, the dropdown is still at the right end of that one row", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 300, tab: "work", motion: "reduce", library: false });
  try {
    await x.send(listOf(""));
    await settle(x.page);
    const m = await rowNow(x.page);
    assert.deepEqual([m.pick, m.lib, m.bar, m.pathLine, m.word], [true, null, 0, 0, true]);
    assert.ok(m.rightEnd <= 0.5 && m.pickHeight <= 30, JSON.stringify(m));
    await x.page.evaluate(() => { document.getElementById("work-library").hidden = false; });
    await settle(x.page);
    const after = await rowNow(x.page);
    assert.ok(Math.abs(after.listTop - m.listTop) <= 0.5 && after.rightEnd <= 0.5 && after.sameLine <= 1, `Library arriving moves nothing down: ${after.listTop} against ${m.listTop}`);
  } finally { await x.close(); }
});

// ---- a long path, cut in the middle: the folder's own name whole, and no space before its slash ----------------------
/** The painted columns of `clip` (CSS px, at the page's scale): true where anything but the ground is drawn. */
async function inkColumns(page, clip, scale) {
  const shot = (await page.screenshot({ clip })).toString("base64");
  return decoder.evaluate(async ([data, s]) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
    const px = ctx.getImageData(0, 0, image.width, image.height).data, ground = [px[0], px[1], px[2]], cols = [];
    for (let xx = 0; xx < image.width; xx++) { let ink = false;
      for (let y = 0; y < image.height && !ink; y++) { const i = (y * image.width + xx) * 4; ink = Math.abs(px[i] - ground[0]) + Math.abs(px[i + 1] - ground[1]) + Math.abs(px[i + 2] - ground[2]) > 36; }
      cols.push(ink); }
    return { cols, scale: s };
  }, [shot, scale]);
}
/** A cut path as painted: whether its name is whole, and the unpainted gap (CSS px) between the head's ellipsis and the name's slash. */
async function pathPainted(page, path, scale = 2) {
  const g = await path.evaluate((e) => { const box = (n) => n.getBoundingClientRect(), tail = e.querySelector(".dgc-path-tail"), head = e.querySelector(".dgc-path-head"), r = document.createRange(); r.selectNodeContents(tail);
    const h = document.createRange(); if (head) h.selectNodeContents(head);
    return { x: box(e).left, y: box(e).top, width: box(e).width, height: box(e).height, tail: box(tail).left, tailWhole: r.getBoundingClientRect().width <= box(tail).width + 0.01 && box(tail).right <= box(e).right + 0.01,
      headCut: head ? h.getBoundingClientRect().width > box(head).width + 0.01 || getComputedStyle(head).clipPath !== "none" : false }; });
  const { cols } = await inkColumns(page, { x: Math.floor(g.x), y: g.y, width: Math.ceil(g.width) + 1, height: g.height }, scale);
  // From the slash's first painted column, back over what is not painted, to the ellipsis's last dot.
  let slash = Math.max(0, Math.round((g.tail - Math.floor(g.x)) * scale) - 1);
  while (slash < cols.length && !cols[slash]) slash++;
  let gap = 0;
  for (let c = slash - 1; c >= 0 && !cols[c]; c--) gap++;
  return { ...g, gap: gap / scale };
}

for (const theme of ["dark-modern", "light-modern"]) {
  test(`a long path in the Work list: the folder's name whole and no space before its slash, at every side bar width from 280 to 380 px (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width: 300, tab: "work", motion: "reduce", scale: 2 });
    try {
      await x.send(listOf(""));
      // What "no space" is: the gap the same letters have when nothing is cut ("…/" set as plain words, in the path's own type).
      const plain = x.page.locator('#sessions-list .session-row[data-id="s-shop-1"] .session-path');
      await plain.evaluate((e) => { e.querySelector(".dgc-path-head").textContent = "~/code…"; });
      await settle(x.page);
      const natural = (await pathPainted(x.page, plain)).gap;
      assert.ok(natural <= 2.5, `two letters side by side: ${natural}px`);
      const wide = [];
      for (let width = 280; width <= 380; width += 4) {
        await x.page.setViewportSize({ width, height: 760 }); await settle(x.page);
        const p = await pathPainted(x.page, x.page.locator('#sessions-list .session-row[data-id="s-long-1"] .session-path'));
        assert.equal(p.tailWhole, true, `${width}px: "/checkout-service" is whole`);
        assert.equal(p.headCut, true, `${width}px: what comes before it gives way`);
        if (p.gap > natural + 1) wide.push(`${width}px: ${p.gap}px`);
      }
      assert.deepEqual(wide, [], `no space between the ellipsis and the slash (two letters side by side are ${natural}px apart)`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`a long path in the dropdown's menu at 700 and 300 px: the name whole, no space before its slash (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    for (const width of [700, 300]) {
      const x = await openHome(browser, { theme, width, tab: "work", motion: "reduce", scale: 2 });
      try {
        await x.send(listOf(""));
        await x.page.click("#sessions-folder-pick");
        await x.page.waitForSelector(".dgc-folder-menu");
        await x.page.mouse.move(0, 0);
        await settle(x.page);
        const short = x.page.locator('.dgc-folder-menu [data-folder="/home/me/code/garden"] .dgc-path');
        await short.evaluate((e) => { e.querySelector(".dgc-path-head").textContent = "~/code…"; });
        await settle(x.page);
        const natural = (await pathPainted(x.page, short)).gap;
        const p = await pathPainted(x.page, x.page.locator(`.dgc-folder-menu [data-folder="${LONG}"] .dgc-path`));
        assert.deepEqual([p.tailWhole, p.headCut], [true, true], `${width}px: the name whole, the head cut`);
        assert.ok(p.gap <= natural + 1, `${width}px: no space between the ellipsis and the slash: ${p.gap}px against ${natural}px`);
        // A name longer than the menu is the one thing that may end in an ellipsis itself.
        const wordy = await x.page.locator(`.dgc-folder-menu [data-folder="${WORDY}"] .dgc-path`).evaluate((e) => { const tail = e.querySelector(".dgc-path-tail"), r = document.createRange(); r.selectNodeContents(tail);
          return { inside: tail.getBoundingClientRect().right <= e.getBoundingClientRect().right + 0.01, cut: r.getBoundingClientRect().width > tail.getBoundingClientRect().width + 0.01, how: getComputedStyle(tail).textOverflow, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) }; });
        if (width === 300) assert.deepEqual(wordy, { inside: true, cut: true, how: "ellipsis", lines: 1 }, "a name wider than the line ends in an ellipsis");
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });
}

test("a path that fits is drawn whole, with no ellipsis; one that is cut keeps its whole words for a reader and a copy", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 300, tab: "work", motion: "reduce" });
  try {
    await x.send(listOf(""));
    await settle(x.page);
    const m = await x.page.evaluate(() => [...document.querySelectorAll("#sessions-list .session-row")].map((row) => { const e = row.querySelector(".session-path"), head = e.querySelector(".dgc-path-head"), dots = e.querySelector(".dgc-path-dots");
      return { id: row.dataset.id, words: (head?.textContent || "") + e.querySelector(".dgc-path-tail").textContent, dots: !!dots?.checkVisibility(), said: dots?.getAttribute("aria-hidden") || "", title: e.title }; }));
    assert.deepEqual(m.filter((p) => p.dots).map((p) => p.id), ["s-long-1", "s-wordy-1"], "only the long ones have an ellipsis");
    assert.equal(m[2].words, "~/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service", "its words are all there");
    assert.equal(m[2].said, "true", "the ellipsis is drawing, not words");
    assert.equal(m[2].title, LONG);
  } finally { await x.close(); }
});
