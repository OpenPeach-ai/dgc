// The Project Folder dropdown on a row that is already there (0.52, his calls on 12 Nov night), in real Chromium with
// the real pages (test/support/home-scene.mjs, test/support/project-folder-pips-scene.mjs), at 700 and 300 px, dark and
// light. Over the Work sessions it is on the Library row, at its right end; in View all, on the search field's row; on
// the Pips view's Project tab, at the right end of the "Needs attention" heading line, and at the same place on a row
// of the same height when nothing needs attention. One line always: when the row is too narrow for it the button drops
// its "Project Folder" word (measured, never a breakpoint), then a long folder name ends in an ellipsis. No line names
// one folder's path any more: the button's tooltip has it. And a long path is cut in the middle with its folder's own
// name whole and no space before the name's slash. Read from the DOM, computed style, geometry and the painted pixels.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { homeContrast, openHome } from "./support/home-scene.mjs";
import { GARDEN, HERE, LONG as PIPS_LONG, openPips, pipsContrast } from "./support/project-folder-pips-scene.mjs";
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

  test(`View all: the dropdown is on the search field's row, at its right end (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab: "work", motion: "reduce" });
    try {
      await x.send(listOf(""));
      await x.page.click("#sessions-all");
      await x.page.waitForSelector(".sessions-popover");
      await settle(x.page);
      const read = () => x.page.evaluate(() => {
        const box = (e) => e.getBoundingClientRect(), pop = document.querySelector(".sessions-popover"), field = pop.querySelector(".sessions-all-search"), pick = pop.querySelector(".dgc-folder"), list = pop.querySelector(".sessions-all-list");
        const mid = (e) => (box(e).top + box(e).bottom) / 2, value = pick.querySelector(".dgc-folder-v"), r = document.createRange(); r.selectNodeContents(value);
        const inner = box(pop).right - parseFloat(getComputedStyle(pop).paddingRight) - parseFloat(getComputedStyle(pop).borderRightWidth);
        return { sameLine: Math.abs(mid(pick) - mid(field)), after: box(pick).left - box(field).right, rightEnd: Math.abs(box(pick).right - inner), field: box(field).width, pickHeight: box(pick).height,
          listUnder: box(list).top - Math.max(box(field).bottom, box(pick).bottom), word: pick.querySelector(".dgc-folder-k").checkVisibility(), value: value.textContent, valueWhole: r.getBoundingClientRect().width <= box(value).width + 0.01,
          label: pick.getAttribute("aria-label"), inside: box(pick).right <= box(pop).right + 0.5 && box(field).left >= box(pop).left - 0.5 };
      });
      const m = await read();
      assert.ok(m.sameLine <= 1, `on the search field's line: ${m.sameLine}`);
      assert.ok(m.after >= 4 && m.rightEnd <= 0.5 && m.inside, `after the field, at the row's right end: ${JSON.stringify(m)}`);
      assert.ok(m.listUnder >= 0 && m.listUnder <= 8.5, `the list comes straight under that one row: ${m.listUnder}`);
      assert.ok(m.pickHeight <= 30 && m.field >= 100, `one line, and the field keeps room to type: ${JSON.stringify(m)}`);
      assert.deepEqual([m.value, m.valueWhole, m.label], ["All projects", true, "Project Folder: All projects"]);
      assert.equal(m.word, width !== 300, "at 300 px the word gives its room to the search field");
      // The choice changes what the page lists, and the page stays open with the dropdown on its row.
      await x.page.click(".sessions-popover .dgc-folder");
      await x.page.click(`.dgc-folder-menu [data-folder="${LONG}"]`);
      assert.deepEqual(await x.page.evaluate(() => window.__posted.filter((p) => p.type === "projectFolderChoose")), [{ type: "projectFolderChoose", folder: LONG }]);
      await x.send(listOf(LONG));
      await settle(x.page);
      const one = await read();
      assert.ok(one.sameLine <= 1 && one.rightEnd <= 0.5 && one.pickHeight <= 30 && one.field >= 100 && one.inside, JSON.stringify(one));
      assert.equal(one.label, "Project Folder: checkout-service");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Pips, the Project tab: the dropdown is at the right end of the Needs attention line, and stays there when nothing needs attention (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const read = (x) => x.inPips((root) => {
      const box = (e) => e.getBoundingClientRect(), panel = root.querySelector("#pips-tabpanel"), pick = root.querySelector("#pips-folder-pick"), toggle = root.querySelector(".attention-toggle:not(.attention-toggle-none)"), row = pick.closest(".attention-head, .pips-folder-row");
      const mid = (e) => (box(e).top + box(e).bottom) / 2, value = pick.querySelector(".dgc-folder-v"), r = document.createRange(); r.selectNodeContents(value);
      const count = toggle?.querySelector(".attention-count"), fold = toggle?.querySelector(".codicon"), words = toggle && document.createRange(); if (words) words.selectNodeContents(toggle.firstChild);
      const content = box(panel).right - parseFloat(getComputedStyle(panel).paddingRight);
      return { top: box(pick).top - box(panel).top, mid: mid(pick) - box(panel).top, rowHeight: row ? box(row).height : 0, rowTop: row ? box(row).top - box(panel).top : -1, rightEnd: Math.abs(box(pick).right - content), pickHeight: box(pick).height,
        heading: toggle ? { text: toggle.textContent.replace(/\s+/g, " ").trim(), sameLine: Math.abs(mid(pick) - mid(toggle)), left: box(toggle).left - box(panel).left - parseFloat(getComputedStyle(panel).paddingLeft),
          countAfterWords: box(count).left - words.getBoundingClientRect().right, foldAfterCount: box(fold).left - box(count).right, clear: box(pick).left - box(fold).right, wordsWhole: words.getBoundingClientRect().right <= box(count).left + 0.5,
          viewAll: root.querySelector("#attention-view-all") ? box(pick).left - box(root.querySelector("#attention-view-all")).right : null } : null,
        word: pick.querySelector(".dgc-folder-k").checkVisibility(), value: value.textContent, valueWhole: r.getBoundingClientRect().width <= box(value).width + 0.01, ellipsis: getComputedStyle(value).textOverflow,
        label: pick.getAttribute("aria-label"), title: pick.title, once: [...root.querySelectorAll(".pips-folder-once, .pips-folder-bar")].filter((e) => e.checkVisibility()).length,
        firstUnder: (() => { const next = root.querySelector("#pips-tabpanel .attention-carousel:not([hidden]), #pips-tabpanel .simple-home, #pips-tabpanel .pips-tab-empty"); return next ? box(next).top - box(pick).bottom : -99; })(),
        sideways: root.querySelector(".pip-app-root").scrollWidth > root.querySelector(".pip-app-root").clientWidth + 1 };
    });
    // All projects: a Project Pip's card waits, so the heading is drawn.
    let x = await openPips(browser, { theme, width });
    let withHeading, alone;
    try {
      withHeading = await read(x);
      assert.ok(withHeading.heading, "Needs attention is drawn");
      assert.match(withHeading.heading.text, /^Needs attention 1$/);
      assert.ok(withHeading.heading.sameLine <= 1, `centred on the heading's line: ${withHeading.heading.sameLine}`);
      assert.ok(withHeading.rightEnd <= 0.5, `at the line's right end: ${withHeading.rightEnd}`);
      assert.ok(Math.abs(withHeading.heading.left) <= 0.5 && withHeading.heading.countAfterWords >= 0 && withHeading.heading.countAfterWords <= 12 && withHeading.heading.foldAfterCount >= 0 && withHeading.heading.foldAfterCount <= 12,
        `the heading, its count and its fold stay at the left, together: ${JSON.stringify(withHeading.heading)}`);
      assert.ok(withHeading.heading.clear >= 6 && withHeading.heading.wordsWhole, `clear of the fold; the heading's words whole: ${JSON.stringify(withHeading.heading)}`);
      assert.deepEqual([withHeading.once, withHeading.sideways], [0, false], "no row of its own, no path line");
      assert.ok(withHeading.pickHeight <= 30);
      assert.deepEqual([withHeading.value, withHeading.label, withHeading.title], ["All projects", "Project Folder: All projects", "Project Folder: All projects"]);
      if (width === 700) assert.deepEqual([withHeading.word, withHeading.valueWhole], [true, true]);
      else assert.equal(withHeading.word, false, "at 300 px the word goes: the heading keeps its room");
      assert.deepEqual(low(await pipsContrast(x.page)), []);
      // Its menu opens from there.
      await x.inPips((root) => root.querySelector("#pips-folder-pick").click());
      const menu = await x.inPips((root) => { const m = root.querySelector(".dgc-folder-menu")?.getBoundingClientRect(); return m && { fits: m.left >= 0 && m.right <= innerWidth + 0.5 && m.bottom <= innerHeight + 0.5 }; });
      assert.deepEqual(menu, { fits: true });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
    // This window's folder: nothing of it waits, so no heading; the dropdown is where it was, on a row as tall.
    x = await openPips(browser, { theme, width, choice: HERE });
    try {
      alone = await read(x);
      assert.equal(alone.heading, null, "nothing needs attention: no heading");
      assert.ok(Math.abs(alone.top - withHeading.top) <= 0.5 && Math.abs(alone.rightEnd) <= 0.5, `the same place, top and right: ${alone.top} against ${withHeading.top}`);
      assert.ok(Math.abs(alone.rowHeight - withHeading.rowHeight) <= 0.5 && Math.abs(alone.rowTop - withHeading.rowTop) <= 0.5, `a row of the same height at the same place: ${alone.rowHeight} against ${withHeading.rowHeight}`);
      assert.deepEqual([alone.once, alone.sideways, alone.value, alone.valueWhole, alone.label, alone.title], [0, false, "shop", true, "Project Folder: shop", `Project Folder: shop\n${HERE}`], "its name on the button, its path in the tooltip, no path line");
      assert.equal(alone.word, true, "alone on its row there is room for the word");
      assert.ok(alone.firstUnder >= 0, "the list comes under that row");
      assert.deepEqual(low(await pipsContrast(x.page)), []);
      // A folder whose Pip waits: the heading comes, and the dropdown has not moved.
      await x.send({ type: "pipsProjectFolder", folder: GARDEN });
      await x.page.waitForFunction(() => { const root = document.getElementById("pips-host").shadowRoot; return root.querySelector(".attention-toggle:not(.attention-toggle-none)") && root.querySelector("#pips-folder-pick")?.getAttribute("aria-label") === "Project Folder: garden"; }, undefined, { timeout: 15000 });
      await settle(x.page);
      const garden = await read(x);
      assert.ok(garden.heading && garden.heading.sameLine <= 1 && Math.abs(garden.top - alone.top) <= 0.5 && garden.rightEnd <= 0.5, `it never jumps between rows: ${JSON.stringify(garden)}`);
      // A folder with a long path and nothing waiting: the name whole, no path line.
      await x.send({ type: "pipsProjectFolder", folder: PIPS_LONG });
      await x.page.waitForFunction(() => document.getElementById("pips-host").shadowRoot.querySelector("#pips-folder-pick")?.getAttribute("aria-label") === "Project Folder: checkout-service", undefined, { timeout: 15000 });
      await settle(x.page);
      const long = await read(x);
      assert.deepEqual([long.once, long.valueWhole, long.title, long.sideways], [0, true, `Project Folder: checkout-service\n${PIPS_LONG}`, false]);
      assert.ok(Math.abs(long.top - alone.top) <= 0.5 && long.rightEnd <= 0.5 && long.pickHeight <= 30, JSON.stringify(long));
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
    // The Personal tab has no dropdown.
    x = await openPips(browser, { theme, width, tab: "personal" });
    try { assert.equal(await x.inPips((root) => !!root.querySelector("#pips-folder-pick")), false, "Personal has no dropdown"); } finally { await x.close(); }
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
