// The Project Folder dropdown on a row that is already there (0.52, his calls on 12 Nov night), in real Chromium with
// the real pages (test/support/home-scene.mjs, test/support/project-folder-pips-scene.mjs), at 700 and 300 px, dark and
// light. Over the Work sessions it has a line of its own under the search row, at the LEFT, as on the Pips tab (the
// Library button whose row it shared left Work on 14 Nov; View all lists in place, with no dropdown of its own).
// (The Pips view's Project tab: test/pips-folder-line-browser.test.mjs.)
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

/** The dropdown's line as it is on screen. */
const rowNow = (page) => page.evaluate(() => {
  const box = (e) => e.getBoundingClientRect(), pick = document.getElementById("sessions-folder-pick"), list = document.getElementById("sessions-list"), search = document.getElementById("sessions-search");
  const word = pick?.querySelector(".dgc-folder-k"), value = pick?.querySelector(".dgc-folder-v"), host = document.getElementById("sessions-host");
  const whole = (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().width <= box(e).width + 0.01; };
  return { pick: !!pick?.checkVisibility(), library: document.querySelectorAll("#work-library, #chats-library, .home-library").length,
    word: !!word?.checkVisibility(), value: value?.textContent || "", valueWhole: value ? whole(value) : false, ellipsis: value ? getComputedStyle(value).textOverflow : "",
    label: pick?.getAttribute("aria-label") || "", title: pick?.title || "", pickHeight: pick ? box(pick).height : 0,
    // At the left, under the search box's own left edge; never past New's right edge.
    leftEnd: pick ? Math.abs(box(pick).left - box(search).left) : 99, pastRight: pick ? box(pick).right - box(document.getElementById("sessions-new")).right : 0,
    under: pick ? box(pick).top - box(search).bottom : 0,
    // What the line takes: the list starts this far under the search row.
    listTop: box(list).top - box(search).bottom,
    pathLine: [...document.querySelectorAll("#sessions-folder, .sessions-folder, .sessions-folder-path")].filter((e) => e.checkVisibility()).length,
    bar: [...document.querySelectorAll("#sessions-folderbar")].filter((e) => e.checkVisibility()).length, sideways: host.scrollWidth > host.clientWidth + 1 };
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`Work sessions: the dropdown has a line of its own under the search row, at the left, on one line; no Library button (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab: "work", motion: "reduce" });
    try {
      const before = await rowNow(x.page);                       // a DGC that lists no folders: no line at all
      assert.deepEqual([before.pick, before.library], [false, 0]);
      await x.send(listOf(""));
      await settle(x.page);
      const all = await rowNow(x.page);
      assert.equal(all.pick, true);
      assert.deepEqual([all.bar, all.pathLine, all.library], [0, 0, 0], "no second bar, no path line, no Library button");
      assert.ok(all.leftEnd <= 0.5, `at the left, under the search box's edge: ${all.leftEnd}`);
      assert.ok(all.under >= 4 && all.under <= 16, `just under the search row: ${all.under}`);
      assert.ok(all.pastRight <= 0.5, "inside the page");
      assert.ok(all.listTop - before.listTop <= 44, `the line is one row high: the list starts ${all.listTop - before.listTop}px lower than with no dropdown`);
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
      assert.equal(one.word, true, "the line is its own now: the word and this name both fit, at 300 px too");
      assert.ok(one.leftEnd <= 0.5 && one.pastRight <= 0.5 && one.pickHeight <= 30, JSON.stringify(one));
      assert.ok(Math.abs(one.listTop - all.listTop) <= 0.5, "the list does not move with the choice");
      assert.deepEqual(low(await homeContrast(x.page)), []);

      // A folder whose own name is longer than the line: the word goes first, then the name ends in an ellipsis.
      await x.send(listOf(WORDY));
      await settle(x.page);
      const wordy = await rowNow(x.page);
      if (width === 300) assert.deepEqual([wordy.word, wordy.valueWhole, wordy.ellipsis], [false, false, "ellipsis"], "the word gone, the name cut with an ellipsis");
      assert.ok(wordy.leftEnd <= 0.5 && wordy.pastRight <= 0.5 && wordy.pickHeight <= 30 && !wordy.sideways, JSON.stringify(wordy));
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

test("the word goes only when the line has no room for it, and comes back when it has: every width from 170 to 700 px", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 700, tab: "work", motion: "reduce" });
  try {
    await x.send(listOf(WORDY));
    const seen = [];
    const at = async (width) => { await x.page.setViewportSize({ width, height: 760 }); await settle(x.page); const m = await rowNow(x.page); seen.push([width, m.word]);
      assert.ok(m.valueWhole || !m.word, `${width}px: the name is never cut while the word still shows`);
      assert.ok(m.leftEnd <= 0.5 && m.pastRight <= 0.5 && m.pickHeight <= 30 && !m.sideways, `${width}px: one line, at the left, inside the page: ${JSON.stringify(m)}`);
      // The word is gone only where it would not fit: with it, the button would be wider than the line.
      const fits = await x.page.evaluate(() => { const pick = document.getElementById("sessions-folder-pick"), copy = pick.cloneNode(true); copy.removeAttribute("id"); copy.style.cssText = "position:absolute;visibility:hidden;max-width:none;left:0;top:0";
        copy.querySelector(".dgc-folder-k").style.display = "inline"; document.getElementById("work-home").append(copy); const need = copy.getBoundingClientRect().width; copy.remove();
        return need <= document.getElementById("work-folder-line").getBoundingClientRect().width + 0.5; });
      assert.equal(m.word, fits, `${width}px: the word shows exactly when there is room for it`);
      return m; };
    for (let width = 700; width >= 170; width -= 25) await at(width);
    await at(170);
    assert.equal(seen.at(-1)[1], false, "gone at the narrowest side bar");
    for (let width = 200; width <= 700; width += 50) await at(width);
    assert.equal(seen.at(-1)[1], true, "back at 700 px");
    assert.deepEqual(x.errors, []);
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
