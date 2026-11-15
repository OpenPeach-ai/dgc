// The Library's item menu (0.52, 15 Nov; his words: "when i right click on anything, it should allow us multiple
// things, like copy path etc, the current copy does nothing"). A right-click on a Library row used to open the editor's
// own Cut · Copy · Paste (nothing in the Library took the right-click), whose Copy copies the selected text: a row has
// none, so it did nothing. Now every item has ONE menu, the same on a right-click, on the row's ⋯ and from the
// keyboard, the same in the side bar and in the Library's editor tab:
//   Open · Open in editor · Save a copy… · Copy · Copy path · Reveal in file manager · Rename… · Remove…
// then, under a hairline, what only that kind has (Pin to the dock, Use in a new chat, ...). What a kind cannot do is
// there, off, and says why. Each of the eight asks the host one way ("itemAct", with the item named and nothing else:
// src/chatdgc.ts libraryAct checks it is one the Library was shown; that side is in chatdgc-tabs.test.mjs).
// In real Chromium: the real side bar and the page src/chatdgc.ts serves in an editor tab, on one stand-in host.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openLibraryTab, openLibraryPage, LIB_IMAGES, LIB_VIDEOS, LIB_FILES, LIB_WIDGETS, ar } from "./support/library-scene.mjs";

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

const open = (place, opts = {}) => (place === "side" ? openLibraryTab(browser, opts) : openLibraryPage(browser, opts));
const CORE = ["Open", "Open in editor", "Save a copy…", "Copy", "Copy path", "Reveal in file manager", "Rename…", "Remove…"];
const IDS = ["open", "editor", "save", "copy", "path", "reveal", "rename", "remove"];
// One of each kind of thing, the tab it is on, how the page names it to the host, and which of the eight it can do.
const IMG = LIB_IMAGES[1], VID = LIB_VIDEOS[0], PIC = LIB_FILES[0], PDF = LIB_FILES[1], CSV = LIB_FILES[2], WID = LIB_WIDGETS[0];
const ITEMS = {
  page: { tab: "artifacts", key: `artifact:${ar(1)}`, item: { kind: "artifact", id: ar(1) }, can: ["open", "save", "remove"], more: ["Pin to the dock"] },
  sheet: { tab: "artifacts", key: `artifact:${ar(2)}`, item: { kind: "artifact", id: ar(2) }, can: ["open", "save", "rename", "remove"], more: ["Pin to the dock"] },
  doc: { tab: "artifacts", key: `artifact:${ar(3)}`, item: { kind: "artifact", id: ar(3) }, can: IDS, more: ["Pin to the dock"] },
  widget: { tab: "widgets", key: `widget:${WID.id}`, item: { kind: "widget", id: WID.id, chat_id: WID.chat_id }, can: ["open", "remove"], more: ["Open the chat it's in", "Pin to the dock"] },
  image: { tab: "images", key: `image:${IMG.path}`, item: { kind: "image", path: IMG.path }, can: ["open", "editor", "save", "copy", "path", "reveal", "remove"], more: ["Save to project…"] },
  video: { tab: "videos", key: `video:${VID.path}`, item: { kind: "video", path: VID.path }, can: ["open", "editor", "save", "path", "reveal", "remove"], more: ["Open it in your player", "Save to project…"] },
  picture: { tab: "files", key: `file:${PIC.id}`, item: { kind: "file", id: PIC.id, source: "chat", chat_id: PIC.chat_id }, can: ["open", "save", "copy", "remove"], more: ["Use in a new chat", "Save to project…", "Add a copy to a project…", "Pin to the dock"] },
  pdf: { tab: "files", key: `file:${PDF.id}`, item: { kind: "file", id: PDF.id, source: "chat", chat_id: PDF.chat_id }, can: ["open", "save", "remove"], more: ["Use in a new chat", "Add a copy to a project…", "Pin to the dock"] },
  csv: { tab: "files", key: `file:${CSV.id}`, item: { kind: "file", id: CSV.id, source: "project", project_id: CSV.project_id }, can: ["open", "save", "remove"], more: ["Use in a new chat", "Add a copy to a project…", "Pin to the dock"] },
};
const rowOf = (x, key) => x.page.locator(`#library-list .lib-row[data-key="${key}"]`);
/** The menu that is open, as drawn: each row's words, whether it is off and why, "—" for a hairline; and where it is. */
const menu = (x) => x.page.evaluate(() => {
  const pop = document.querySelector(".dgc-pop"); if (!pop) return null;
  const b = pop.getBoundingClientRect();
  const rows = [...pop.children].map((n) => (n.matches(".dgc-menu-div") ? "—" : n.matches(".dgc-menu-row") ? { id: n.dataset.id, label: n.querySelector(".dgc-menu-label").textContent.trim(), off: n.getAttribute("aria-disabled") === "true" || n.disabled,
    why: (n.getAttribute("title") || n.dataset.tip || "").trim(), dim: Number(getComputedStyle(n.querySelector(".dgc-menu-label")).opacity) * Number(getComputedStyle(n).opacity), h: Math.round(n.getBoundingClientRect().height), radius: parseFloat(getComputedStyle(n).borderTopLeftRadius), cut: n.querySelector(".dgc-menu-label").scrollWidth > n.querySelector(".dgc-menu-label").clientWidth + 1 } : null)).filter(Boolean);
  return { rows, label: pop.getAttribute("aria-label") || "", left: b.left, right: b.right, top: b.top, bottom: b.bottom, radius: parseFloat(getComputedStyle(pop).borderTopLeftRadius), vw: innerWidth, vh: innerHeight,
    focus: document.activeElement?.closest?.(".dgc-menu-row")?.dataset.id || (document.activeElement === pop ? "(menu)" : "") };
});
const closed = async (x) => { await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(120); if (await x.page.locator(".dgc-pop").count()) { await x.page.mouse.click(2, 2); await x.page.waitForTimeout(120); } };
/** Opens an item's menu: "right" (a right-click on the row), "dots" (its ⋯) or "keys" (Shift+F10 with the row focused). */
async function openMenu(x, key, how = "right") {
  const row = rowOf(x, key); await row.scrollIntoViewIfNeeded();
  if (how === "right") await row.click({ button: "right", position: { x: 70, y: 14 } });
  else if (how === "dots") { await row.hover({ position: { x: 70, y: 14 } }); await row.locator(".lib-row-more").click(); }
  else { await row.focus(); await x.page.keyboard.press(how === "keys" ? "Shift+F10" : "ContextMenu"); }
  await x.page.waitForTimeout(320);
  return menu(x);
}
const choose = async (x, id) => { await x.page.locator(`.dgc-pop .dgc-menu-row[data-id="${id}"]`).click({ force: true }); await x.rest(160); };
const acts = (x) => x.said("itemAct");
const split = (m) => { const at = m.rows.indexOf("—"); return [at < 0 ? m.rows : m.rows.slice(0, at), at < 0 ? [] : m.rows.slice(at + 1)]; };

// ---- 1. why Copy did nothing: the right-click is the Library's now -------------------------------------------------------------
for (const [place, width] of [["side", 300], ["tab", 1100]]) {
  test(`${place}: a right-click on a row opens DGC's own menu at the pointer, never the editor's Cut · Copy · Paste`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width });
    try {
      await x.page.evaluate(() => { window.__ctx = []; window.addEventListener("contextmenu", (e) => window.__ctx.push(e.defaultPrevented)); });
      const row = rowOf(x, ITEMS.page.key), box = await row.boundingBox();
      await row.click({ button: "right", position: { x: 70, y: 14 } }); await x.page.waitForTimeout(320);
      assert.deepEqual(await x.page.evaluate(() => window.__ctx), [true], "the row took the right-click: the editor's own menu (whose Copy did nothing) does not open");
      const m = await menu(x);
      assert.ok(m, "the item's menu is open");
      assert.deepEqual(split(m)[0].map((r) => r.label), CORE, "with the eight things an item can do");
      assert.ok(Math.abs(m.left - (box.x + 70)) <= 8 || m.right >= m.vw - 8, `it opens at the pointer (${m.left} / ${box.x + 70})`);
      assert.ok(m.top >= box.y - 4 || m.bottom <= box.y + box.height + 4);
      assert.deepEqual(await acts(x), [], "opening it asks nothing of the host");
      await closed(x);
      // The rest of the Library has no Cut · Copy · Paste either; a field you type in keeps the editor's own.
      await x.page.locator(".dgc-lib .dgc-pagehead").click({ button: "right" }); await x.page.locator("#library-search").click({ button: "right" });
      assert.deepEqual((await x.page.evaluate(() => window.__ctx)).slice(1), [true, false], "the header: no dead menu; the search field: the editor's own, for its text");
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  });
}

// ---- 2. one menu: every kind, on right-click and on ⋯, the same in the side bar and the editor tab ----------------------------
test("every kind of item has the same eight rows in the same order, on a right-click and on its ⋯, in the side bar and in the editor tab; what it cannot do is off and says why", async (t) => {
  if (skipOrFail(t)) return;
  const side = await open("side", { width: 300 }), tab = await open("tab", { width: 1100 });
  try {
    for (const [name, it] of Object.entries(ITEMS)) {
      const seen = {};
      for (const [place, x] of [["side", side], ["tab", tab]]) {
        await x.libTab(it.tab);
        for (const how of ["right", "dots"]) {
          const m = await openMenu(x, it.key, how);
          assert.ok(m, `${name}, ${place}, ${how}: a menu opens`);
          const [core, more] = split(m);
          assert.deepEqual(core.map((r) => r.label), CORE, `${name}, ${place}, ${how}: the eight, never one missing`);
          assert.deepEqual(core.map((r) => r.id), IDS);
          assert.deepEqual(core.filter((r) => !r.off).map((r) => r.id), it.can, `${name}: what it can do`);
          for (const r of core.filter((r) => r.off)) assert.ok(r.dim <= 0.6, `${name}: “${r.label}” reads as off (its words at ${r.dim})`);
          for (const r of core.filter((r) => !r.off)) assert.equal(r.dim, 1, `${name}: “${r.label}” reads as on`);
          for (const r of core.filter((r) => r.off)) assert.ok(r.why.length >= 20 && /[.…]$/.test(r.why), `${name}: “${r.label}” is off and says why (“${r.why}”)`);
          for (const r of core.filter((r) => !r.off)) assert.equal(r.why, "", `${name}: “${r.label}” needs no excuse`);
          assert.deepEqual(more.map((r) => r.label), it.more, `${name}, ${place}: what only this kind has, under a hairline`);
          assert.ok(m.label.startsWith("More for "), "the menu is named for its item");
          seen[`${place}:${how}`] = m.rows.map((r) => (r === "—" ? r : [r.id, r.label, r.off, r.why]));
          await closed(x);
        }
      }
      assert.deepEqual(seen["side:right"], seen["side:dots"], `${name}: the right-click and the ⋯ open one menu`);
      assert.deepEqual(seen["tab:right"], seen["tab:dots"]);
      assert.deepEqual(seen["side:right"], seen["tab:right"], `${name}: the side bar and the editor tab open one menu`);
    }
    assert.deepEqual([...(side.errors || []), ...(tab.errors || [])], []);
  } finally { await side.close(); await tab.close(); }
});

test("the editor tab's rows have a ⋯ too, beside their buttons; the side bar's shows under the pointer or the keyboard", async (t) => {
  if (skipOrFail(t)) return;
  const tab = await open("tab", { width: 1100 }), side = await open("side", { width: 300 });
  try {
    const l = await tab.lib();
    assert.ok(l.rows.length >= 5 && l.rows.every((r) => r.more), "every row of the editor tab shows its ⋯");
    const sizes = await tab.page.evaluate(() => [...document.querySelectorAll(".dgc-lib .lib-row-more")].map((b) => { const r = b.getBoundingClientRect(), a = b.previousElementSibling.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), parseFloat(getComputedStyle(b).borderTopLeftRadius), r.left >= a.right - 0.5]; }));
    for (const s of sizes) assert.deepEqual(s, [28, 28, 6, true], "28 px, the 6 px corner, after the row's buttons");
    const row = rowOf(side, ITEMS.page.key); await side.page.mouse.move(2, 2); await side.rest(80);
    await row.focus(); await side.rest(80);
    assert.equal(await row.locator(".lib-row-more").evaluate((b) => b.checkVisibility()), true, "the side bar: reached by the keyboard, the row shows its ⋯");
  } finally { await tab.close(); await side.close(); }
});

// ---- 3. each row does what it says ------------------------------------------------------------------------------------------------
for (const place of ["side", "tab"]) {
  test(`${place}: each of the eight asks the host one way, naming the item and nothing more; a row that is off asks nothing`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width: place === "side" ? 440 : 1100 });
    try {
      for (const name of ["doc", "image", "video", "picture", "csv", "widget", "page"]) {
        const it = ITEMS[name]; await x.libTab(it.tab);
        for (const id of IDS) {
          const before = (await acts(x)).length;
          const m = await openMenu(x, it.key, id === "open" ? "dots" : "right");
          const r = split(m)[0].find((row) => row.id === id);
          await choose(x, r.id);
          const after = await acts(x);
          if (name === "video" && id === "open") {
            // A video plays in its own row: the host is asked for its bytes, not to open anything.
            assert.equal(after.length, before, "a video's Open plays it here");
            // (The side bar's scene does not load the shared player, media/videoPlayer.js; the real side bar and the tab do.)
            const player = await x.page.evaluate(() => !!window.DgcVideo);
            assert.equal(await rowOf(x, it.key).locator("figure.made-video").count(), player ? 1 : 0, "in its row");
            if (place === "tab") assert.equal(player, true);
          } else if (it.can.includes(id)) {
            assert.equal(after.length, before + 1, `${name}: “${r.label}” asks once`);
            assert.deepEqual(after.at(-1), { type: "itemAct", act: id, item: it.item }, `${name}: “${r.label}” names the item, and no path, title or content of the page's own`);
            assert.equal(await x.page.locator(".dgc-pop").count(), 0, "and the menu closes");
          } else {
            assert.equal(after.length, before, `${name}: “${r.label}” is off: nothing is asked`);
            assert.equal(await x.page.locator(".dgc-pop").count(), 1, "and the menu stays, so its reason can be read");
            await closed(x);
          }
        }
      }
      // A row's quick buttons (where there is room for them) and a click on the row ask the same one way.
      if (place === "tab") {
        await x.libTab("images");
        for (const [id, label] of [["open", "Open the image"], ["reveal", "Reveal in file manager"], ["save", "Save a copy…"]]) {
          const b = rowOf(x, ITEMS.image.key).locator(`.lib-row-actions [data-act="${id}"]`);
          assert.equal(await b.getAttribute("aria-label"), label); await b.click(); await x.rest(120);
          assert.deepEqual((await acts(x)).at(-1), { type: "itemAct", act: id, item: ITEMS.image.item });
        }
        await x.libTab("files"); await rowOf(x, ITEMS.pdf.key).locator('.lib-row-actions [data-act="remove"]').click(); await x.rest(120);
        assert.deepEqual((await acts(x)).at(-1), { type: "itemAct", act: "remove", item: ITEMS.pdf.item });
      }
      for (const old of ["artifactOpen", "artifactExport", "artifactRemove", "widgetOpen", "widgetRemove", "workImageOpen", "workImageReveal", "workImageSave", "videoReveal", "open", "save", "remove"])
        assert.deepEqual(await x.said(old), [], `nothing asks the old way (“${old}”): one route`);
      // What only a kind has still does what it did (the pin is the dock's, the rest the Library's own messages).
      await x.libTab("images"); await openMenu(x, ITEMS.image.key); await choose(x, "more:project");
      assert.deepEqual((await x.said("workImageToProject")).map((m) => m.path), [IMG.path]);
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  });
}

test("Copy puts an image on the clipboard as a picture, and the Library says so; a copy that cannot be made is told to the host", async (t) => {
  if (skipOrFail(t)) return;
  for (const place of ["side", "tab"]) {
    const x = await open(place, { width: place === "side" ? 300 : 1100, secure: true });
    try {
      await x.page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await x.page.bringToFront();
      for (const name of ["image", "picture"]) {
        const it = ITEMS[name]; await x.libTab(it.tab);
        await x.page.evaluate(() => navigator.clipboard.writeText("before"));
        await openMenu(x, it.key); await choose(x, "copy");
        await x.page.waitForFunction(() => /copied/i.test(document.querySelector(".dgc-lib .lib-said")?.textContent || ""), null, { timeout: 5000 });
        const clip = await x.page.evaluate(async () => { const items = await navigator.clipboard.read(); const out = [];
          for (const item of items) for (const type of item.types) { const blob = await item.getType(type); out.push([type, blob.size, type === "image/png" ? [...new Uint8Array(await blob.slice(0, 4).arrayBuffer())] : []]); } return out; });
        const png = clip.find((c) => c[0] === "image/png");
        assert.ok(png && png[1] > 60, `${place}, ${name}: the clipboard holds a picture (${JSON.stringify(clip)})`);
        assert.deepEqual(png[2], [0x89, 0x50, 0x4e, 0x47], "a PNG, which every app pastes");
        const said = await x.page.evaluate(() => { const n = document.querySelector(".dgc-lib .lib-said"); return { words: n.textContent, role: n.getAttribute("role"), shown: n.checkVisibility() }; });
        assert.deepEqual(said, { words: "Image copied", role: "status", shown: true });
        assert.deepEqual((await x.said("itemCopied")).at(-1), { type: "itemCopied", ok: true });
      }
      // The host's answer was not a picture: nothing is written, and the host hears it could not be copied.
      await x.page.evaluate((key) => { const say = (message) => window.dispatchEvent(new MessageEvent("message", { data: document.querySelector('.dgc-lib[data-place="side"]') ? { type: "sideLibrary", message } : message }));
        say({ type: "itemCopy", key, data: "data:text/html;base64,PGI+" }); }, ITEMS.image.key);
      await x.rest(200);
      assert.deepEqual((await x.said("itemCopied")).at(-1), { type: "itemCopied", ok: false });
      // What the host says it did ("Path copied") shows in the same line, then goes.
      await x.page.evaluate(() => { const say = (message) => window.dispatchEvent(new MessageEvent("message", { data: document.querySelector('.dgc-lib[data-place="side"]') ? { type: "sideLibrary", message } : message }));
        say({ type: "itemSaid", words: "Path copied" }); });
      await x.rest(120);
      assert.equal(await x.page.evaluate(() => { const n = document.querySelector(".dgc-lib .lib-said"); return n.checkVisibility() ? n.textContent : ""; }), "Path copied");
      await x.page.waitForFunction(() => !document.querySelector(".dgc-lib .lib-said").checkVisibility(), null, { timeout: 6000 });
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  }
});

// ---- 4. the keyboard ------------------------------------------------------------------------------------------------------------------
for (const [place, width] of [["side", 300], ["tab", 1100]]) {
  test(`${place}: Shift+F10 or the context-menu key opens a row's menu, the arrows move, Enter chooses, Escape closes and goes back to the row`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width });
    try {
      await x.libTab("images");
      const it = ITEMS.image;
      for (const how of ["keys", "menukey"]) {
        const m = await openMenu(x, it.key, how);
        assert.ok(m, `${how}: the menu opens`);
        assert.equal(m.focus, "open", "its first row has the keyboard");
        await x.page.keyboard.press("ArrowDown"); await x.page.keyboard.press("ArrowDown");
        assert.equal((await menu(x)).focus, "save", "Down, Down: Save a copy…");
        await x.page.keyboard.press("ArrowUp");
        assert.equal((await menu(x)).focus, "editor", "Up: Open in editor");
        await x.page.keyboard.press("End"); await x.page.keyboard.press("Home");
        assert.equal((await menu(x)).focus, "open");
        await x.page.keyboard.press("Escape"); await x.rest(150);
        assert.equal(await x.page.locator(".dgc-pop").count(), 0, "Escape closes it");
        assert.equal(await x.page.evaluate(() => document.activeElement?.dataset?.key || ""), it.key, "and the keyboard is back on the row it came from");
      }
      // Enter chooses: Copy path, four rows down.
      await openMenu(x, it.key, "keys");
      for (let i = 0; i < 4; i++) await x.page.keyboard.press("ArrowDown");
      assert.equal((await menu(x)).focus, "path");
      const before = (await acts(x)).length;
      await x.page.keyboard.press("Enter"); await x.rest(160);
      assert.deepEqual((await acts(x)).slice(before), [{ type: "itemAct", act: "path", item: it.item }]);
      // A row that is off can be reached (so its reason can be heard) and Enter on it does nothing.
      const m = await openMenu(x, it.key, "keys");
      for (let i = 0; i < 6; i++) await x.page.keyboard.press("ArrowDown");
      const at = await menu(x);
      assert.equal(at.focus, "rename"); assert.ok(m.rows.find((r) => r.id === "rename").off);
      const asked = (await acts(x)).length;
      await x.page.keyboard.press("Enter"); await x.rest(120);
      assert.equal((await acts(x)).length, asked, "Enter on a row that is off asks nothing");
      assert.equal(await x.page.evaluate(() => document.activeElement?.getAttribute("aria-disabled")), "true");
      // Its reason shows as the page's own label, over the menu and whole, without a pointer.
      await x.page.waitForTimeout(250);
      const tip = await x.page.evaluate(() => { const n = [...document.querySelectorAll(".tip, .dgc-tip")].find((t) => !t.hidden && t.checkVisibility()); if (!n) return null; const b = n.getBoundingClientRect();
        const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); const pop = document.querySelector(".dgc-pop");
        return { words: n.textContent, inside: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight, over: Number(getComputedStyle(n).zIndex) > Number(getComputedStyle(pop).zIndex), hit: at?.className || "" }; });
      assert.ok(tip, "the reason shows when the arrows reach the row");
      assert.match(tip.words, /^An image is listed by the words it was made from\. Its file keeps its name\.$/);
      assert.ok(tip.inside && tip.over, `inside the page and over the menu (${JSON.stringify(tip)})`);
      await closed(x);
      // Enter and Space on the row itself still open it, as before.
      await rowOf(x, it.key).focus(); await x.page.keyboard.press("Enter"); await x.rest(120);
      assert.deepEqual((await acts(x)).at(-1), { type: "itemAct", act: "open", item: it.item });
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  });
}

// ---- 5. how it looks: inside the page at every width, the Library's own menu ---------------------------------------------------
for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  test(`the menu stays inside the side bar and cuts no word, in the Library's own menu look (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open("side", { width, theme });
    try {
      // The Library's own menu (its header's ⋯), to be matched: the broad unification of controls waits for 0.53.
      await x.page.click("#library-more"); await x.page.waitForTimeout(320);
      const own = await menu(x); await closed(x);
      for (const name of ["doc", "image", "video", "picture"]) {
        const it = ITEMS[name]; await x.libTab(it.tab);
        for (const how of ["right", "dots"]) {
          const m = await openMenu(x, it.key, how);
          assert.ok(m.left >= 0 && m.right <= m.vw && m.top >= 0 && m.bottom <= m.vh, `${name}, ${how}: inside the page (${m.left}–${m.right} of ${m.vw})`);
          assert.ok(m.rows.every((r) => r === "—" || !r.cut), `${name}: no row's words are cut (${m.rows.filter((r) => r.cut).map((r) => r.label)})`);
          assert.ok(m.rows.every((r) => r === "—" || r.h === own.rows[0].h), `rows are the Library menu's own height (${own.rows[0].h}px)`);
          assert.ok(m.radius === own.radius && m.rows.every((r) => r === "—" || r.radius === own.rows[0].radius), "the Library's existing menu look: its corner, its rows' corner");
          assert.ok(m.rows.every((r) => r === "—" || r.radius < r.h / 2), "never a pill");
          assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "nothing scrolls sideways");
          await closed(x);
        }
      }
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  });
}
