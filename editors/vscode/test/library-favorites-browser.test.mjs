// Favorites in the Library (0.52): any item can be starred, and every tab filters by the starred. In real Chromium, on
// the ONE Library module in both places it shows (the side bar's Library tab and its editor tab), against the scene's
// stand-in for the host (support/library-scene.mjs, which keeps the starred rows' keys as the host says DGC's list).
// What it checks: a row's star is a real button with the item's name, an outline that shows when the row is pointed at
// or holds the keyboard and a filled star in the accent once it is a favorite; the item's menu has Add to Favorites /
// Remove from Favorites with the same star; "Favorites" is in every tab's filter line and works with the search and
// the other filters; an empty result says so in one line; a favorite on a later page of a long list is found; an older
// DGC, which keeps no favorites, shows none of it; and all of it fits at 300, 440 and 700 px, dark and light.
// Pictures go to DGC_SHOTS when it names a folder.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { openLibraryTab, openLibraryPage, LIB_ARTIFACTS, LIB_IMAGES, LIB_VIDEOS, LIB_FILES, LIB_WIDGETS, LIB_CHARTS, LIB_WORK_FILES, ar } from "./support/library-scene.mjs";

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
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const SHOTS = process.env.DGC_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/favorites-${name}.png` }); };

const DOC = `artifact:${ar(3)}`, SHEET = `artifact:${ar(2)}`, IMAGE = `image:${LIB_IMAGES[1].path}`, VIDEO = `video:${LIB_VIDEOS[0].path}`, FILE = `file:${LIB_FILES[1].id}`;
const WIDGET = `widget:${LIB_WIDGETS[0].id}`, CHART = `chart:${LIB_CHARTS[0].chat_id}:${LIB_CHARTS[0].id}`, WORKFILE = `workfile:${LIB_WORK_FILES[2].ref}`;
const open = (place, options = {}) => (place === "side" ? openLibraryTab(browser, { width: 440, ...options }) : openLibraryPage(browser, { width: 900, ...options }));

/** The stars as drawn: each row's star, the filter's button, and the colour the accent's text token is here. */
const stars = (page) => page.evaluate(() => {
  const probe = document.createElement("span"); probe.style.color = "var(--accent-text)"; document.body.append(probe);
  const accent = getComputedStyle(probe).color; probe.remove();
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  const rows = [...document.querySelectorAll("#library-list > .lib-row")].map((li) => {
    const star = li.querySelector(".lib-fav"), cs = star ? getComputedStyle(star) : null, svg = star?.querySelector("svg"), more = li.querySelector(".lib-row-more"), name = li.querySelector(".lib-row-name");
    return { key: li.dataset.key, title: name?.textContent || "", star: !!star, tag: star?.tagName || "", type: star?.type || "", pressed: star?.getAttribute("aria-pressed") || "", label: star?.getAttribute("aria-label") || "", tip: star?.title || star?.dataset.tipSaid || "",
      icon: svg?.dataset.icon || "", fill: svg?.getAttribute("fill") || "", opacity: cs ? Number(cs.opacity) : 0, color: cs?.color || "", radius: cs ? parseFloat(cs.borderTopLeftRadius) : 0, said: li.getAttribute("aria-label") || "",
      box: star ? box(star) : null, more: more ? box(more) : null, name: name ? box(name) : null, row: box(li), nameCut: name ? name.clientWidth : 0 };
  });
  const f = document.getElementById("library-filter-fav"), fcs = f ? getComputedStyle(f) : null, fsvg = f?.querySelector("svg");
  const filter = f ? { pressed: f.getAttribute("aria-pressed"), word: f.querySelector(".lib-fav-word")?.textContent || "", wordSeen: (f.querySelector(".lib-fav-word")?.getBoundingClientRect().width || 0) > 2, icon: fsvg?.dataset.icon || "", iconColor: fsvg ? getComputedStyle(fsvg).color : "",
    radius: parseFloat(fcs.borderTopLeftRadius), tag: f.tagName, ...box(f) } : null;
  const bar = document.getElementById("library-filters").getBoundingClientRect(), status = document.getElementById("library-status");
  return { accent, rows, filter, bar: { left: bar.left, right: bar.right }, status: status && !status.hidden ? status.textContent : "", said: document.getElementById("library-said")?.textContent || "",
    sideways: document.documentElement.scrollWidth > innerWidth + 1, focus: document.activeElement?.id || document.activeElement?.className || "" };
});
const row = (s, key) => s.rows.find((r) => r.key === key);
const asked = async (x, type) => (await x.said(type));

test("an older DGC keeps no favorites: no star on a row, no Favorites filter, no row in the menu", async (t) => {
  if (skipOrFail(t)) return;
  for (const place of ["side", "tab"]) {
    const x = await open(place);
    try {
      const s = await stars(x.page);
      assert.ok(s.rows.length >= 5, place);
      assert.deepEqual(s.rows.filter((r) => r.star), [], `${place}: no star`);
      assert.equal(s.filter, null, `${place}: no filter`);
      await x.page.click(`#library-list .lib-row[data-key="${DOC}"] .lib-row-more`); await x.page.waitForTimeout(300);
      assert.equal((await x.menuRows()).some((r) => /Favorites/.test(r)), false, `${place}: nothing in the menu`);
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  }
});

for (const place of ["side", "tab"]) {
  test(`${place}: every row's star is a button named for its item, an outline until it is a favorite, then filled in the accent and always there`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { favorites: [SHEET] });
    try {
      const p = x.page;
      await p.mouse.move(2, 2); await x.rest(200);
      let s = await stars(p);
      assert.ok(s.rows.every((r) => r.star && r.tag === "BUTTON" && r.type === "button"), "a real button on every row");
      const doc = row(s, DOC), sheet = row(s, SHEET);
      assert.deepEqual([doc.pressed, doc.label, doc.icon, doc.fill], ["false", "Add Launch notes to Favorites", "favorite", "none"], "not a favorite: an outline, named for the item");
      assert.equal(doc.opacity, 0, "and out of sight until the row is pointed at");
      assert.deepEqual([sheet.pressed, sheet.label, sheet.icon, sheet.fill], ["true", "Remove Acme sales sheet from Favorites", "unfavorite", "currentColor"], "a favorite: the star filled");
      assert.equal(sheet.opacity, 1, "a favorite's star always shows"); assert.equal(sheet.color, s.accent, "in the accent's text tone, from its token");
      assert.match(sheet.said, /A favorite\./, "and the row says so"); assert.doesNotMatch(doc.said, /favorite/i);
      assert.equal(doc.radius, 6); assert.deepEqual([doc.box.w, doc.box.h], [28, 28], "the row buttons' size and corner");
      // Pointed at, a row shows its star; so does one that holds the keyboard.
      await p.hover(`#library-list .lib-row[data-key="${DOC}"] .lib-row-name`); await x.rest(250);
      assert.equal(row(await stars(p), DOC).opacity, 1, "pointed at");
      await p.mouse.move(2, 2); await x.rest(250);
      await p.focus(`#library-list .lib-row[data-key="${DOC}"]`); await x.rest(250);
      assert.equal(row(await stars(p), DOC).opacity, 1, "the row holds the keyboard");
      // (Tab goes through the row: its maker's name, where it is a link, then the star.)
      for (let n = 0; n < 2 && !(await p.evaluate(() => document.activeElement.classList.contains("lib-fav"))); n++) await p.keyboard.press("Tab");
      await x.rest(120);
      assert.deepEqual(await p.evaluate(() => [document.activeElement.className, document.activeElement.closest(".lib-row")?.dataset.key]), ["lib-fav", DOC], "Tab reaches the star from its row");
      // Pressed from the keyboard: starred, shown at once, the host asked by the item's own id, the row not opened.
      await p.keyboard.press("Enter"); await x.rest(250);
      s = await stars(p);
      assert.deepEqual([row(s, DOC).pressed, row(s, DOC).icon, row(s, DOC).label], ["true", "unfavorite", "Remove Launch notes from Favorites"]);
      assert.equal(row(s, DOC).color, s.accent);
      assert.equal(s.focus, "lib-fav", "the keyboard stays on the star");
      assert.equal(s.said, "Added to Favorites");
      assert.deepEqual(await asked(x, "favorite"), [{ type: "favorite", item: { kind: "artifact", id: ar(3) }, on: true }]);
      assert.deepEqual(await asked(x, "itemAct"), [], "the row was not opened");
      // A click takes it off again.
      await p.click(`#library-list .lib-row[data-key="${SHEET}"] .lib-fav`); await x.rest(250);
      s = await stars(p);
      assert.equal(row(s, SHEET).pressed, "false"); assert.equal(s.said, "Removed from Favorites");
      assert.deepEqual((await asked(x, "favorite")).at(-1), { type: "favorite", item: { kind: "artifact", id: ar(2) }, on: false });
      assert.deepEqual(await asked(x, "itemAct"), []);
      assert.deepEqual(await p.evaluate(() => window.__lib.favorites), [DOC], "the host's list is the one kept");
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  });
}

test("every kind can be starred: an artifact, a widget, a chart, a reply's card, an image, a video, a chat's file and a Work attachment, each named to the host by its own id", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("side", { favorites: [], charts: LIB_CHARTS, workFiles: LIB_WORK_FILES });
  try {
    const p = x.page, CARD = `artifact:${ar(7)}`;
    const plan = [["artifacts", DOC, { kind: "artifact", id: ar(3) }], ["widgets", WIDGET, { kind: "widget", id: LIB_WIDGETS[0].id, chat_id: LIB_WIDGETS[0].chat_id }],
      ["widgets", CHART, { kind: "chart", id: LIB_CHARTS[0].id, chat_id: LIB_CHARTS[0].chat_id }], ["widgets", CARD, { kind: "artifact", id: ar(7) }],
      ["images", IMAGE, { kind: "image", path: LIB_IMAGES[1].path }], ["videos", VIDEO, { kind: "video", path: LIB_VIDEOS[0].path }],
      ["files", FILE, { kind: "file", id: LIB_FILES[1].id, source: "chat", chat_id: LIB_FILES[1].chat_id }], ["files", WORKFILE, { kind: "workfile", ref: LIB_WORK_FILES[2].ref }]];
    for (const [tab, key, item] of plan) {
      await x.libTab(tab); await x.rest(150);
      await p.locator(`#library-list .lib-row[data-key="${key}"] .lib-fav`).click({ force: true }); await x.rest(200);
      assert.deepEqual((await asked(x, "favorite")).at(-1), { type: "favorite", item, on: true }, key);
      assert.equal(row(await stars(p), key).pressed, "true", key);
    }
    assert.deepEqual(await p.evaluate(() => window.__lib.favorites), plan.map((r) => r[1]), "each kept by its row's key");
    // Every tab, with Favorites pressed, shows exactly its own.
    for (const [tab, keys] of [["artifacts", [DOC]], ["widgets", [CARD, CHART, WIDGET]], ["images", [IMAGE]], ["videos", [VIDEO]], ["files", [FILE, WORKFILE]]]) {
      await x.libTab(tab); await x.rest(150);
      assert.equal((await stars(p)).filter?.pressed, "false", `${tab}: Favorites is in its filter line`);
      await p.click("#library-filter-fav"); await x.rest(250);
      assert.deepEqual((await stars(p)).rows.map((r) => r.key).sort(), [...keys].sort(), tab);
    }
    assert.deepEqual(x.errors || [], []);
  } finally { await x.close(); }
});

for (const place of ["side", "tab"]) {
  test(`${place}: the item's menu has Add to Favorites and Remove from Favorites, with the star the row wears`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { favorites: [] });
    try {
      const p = x.page, menu = async () => { await p.click(`#library-list .lib-row[data-key="${DOC}"] .lib-row-more`); await p.waitForTimeout(350); };
      const favRow = () => p.evaluate(() => { const r = [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].find((n) => /Favorites/.test(n.textContent)); const svg = r?.querySelector("svg");
        return r ? { label: r.querySelector(".dgc-menu-label").textContent, icon: svg?.dataset.icon || "", last: r === [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].at(-1), role: r.getAttribute("role") } : null; });
      await menu();
      assert.deepEqual(await favRow(), { label: "Add to Favorites", icon: "favorite", last: true, role: "menuitem" });
      assert.deepEqual((await x.menuRows()).slice(0, 8), ["Open", "Open in editor", "Save a copy…", "Copy", "Copy path", "Reveal in file manager", "Rename…", "Remove…"], "the eight stay first, in their order");
      await shot(p, `menu-add-${place}`);
      await p.locator(".dgc-pop .dgc-menu-row", { hasText: "Add to Favorites" }).click(); await x.rest(250);
      assert.deepEqual(await asked(x, "favorite"), [{ type: "favorite", item: { kind: "artifact", id: ar(3) }, on: true }]);
      assert.equal(row(await stars(p), DOC).pressed, "true", "the row's star is filled");
      await menu();
      assert.deepEqual(await favRow(), { label: "Remove from Favorites", icon: "unfavorite", last: true, role: "menuitem" });
      await shot(p, `menu-remove-${place}`);
      // From the keyboard: End goes to it, Enter chooses it.
      await p.keyboard.press("Escape"); await x.rest(150);
      await p.focus(`#library-list .lib-row[data-key="${DOC}"]`); await p.keyboard.press("Shift+F10"); await p.waitForTimeout(350);
      await p.keyboard.press("End"); await p.keyboard.press("Enter"); await x.rest(250);
      assert.deepEqual((await asked(x, "favorite")).at(-1), { type: "favorite", item: { kind: "artifact", id: ar(3) }, on: false });
      assert.equal(row(await stars(p), DOC).pressed, "false");
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  });

  test(`${place}: Favorites filters the tab, with the search and the other filters; nothing starred says so in one line; it is kept across a reload`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { favorites: [DOC, SHEET, IMAGE] });
    try {
      const p = x.page;
      let s = await stars(p);
      assert.deepEqual([s.filter.tag, s.filter.pressed, s.filter.word, s.filter.icon, s.filter.h, s.filter.radius], ["BUTTON", "false", "Favorites", "favorite", 28, 6], "a button of the filters' height and corner");
      const all = s.rows.length;
      await p.click("#library-filter-fav"); await x.rest(250);
      s = await stars(p);
      assert.deepEqual([s.filter.pressed, s.filter.icon], ["true", "unfavorite"]); assert.equal(s.filter.iconColor, s.accent, "pressed: its star filled, in the accent");
      assert.deepEqual(s.rows.map((r) => r.key).sort(), [DOC, SHEET].sort(), "only the starred artifacts");
      assert.equal(s.focus, "library-filter-fav", "the keyboard stays on the button");
      await shot(p, `filter-on-${place}`);
      // With the other filters, and with the search.
      await x.pick("kind", "Documents");
      assert.deepEqual((await stars(p)).rows.map((r) => r.key), [DOC]);
      await x.pick("kind", "Slides");
      s = await stars(p);
      assert.deepEqual(s.rows, []); assert.equal(s.status, "No favorites with these filters.");
      await x.pick("kind", "All");
      await x.search("acme");
      assert.deepEqual((await stars(p)).rows.map((r) => r.key), [SHEET]);
      await x.search("nothing like this");
      assert.equal((await stars(p)).status, "No favorite named like “nothing like this”.");
      await x.search("");
      // Each tab keeps its own: Images shows its one; Videos has none, and says so.
      await x.libTab("images");
      assert.equal((await stars(p)).filter.pressed, "false", "another tab's filter is its own");
      await p.click("#library-filter-fav"); await x.rest(250);
      assert.deepEqual((await stars(p)).rows.map((r) => r.key), [IMAGE]);
      await x.libTab("videos"); await p.click("#library-filter-fav"); await x.rest(250);
      s = await stars(p);
      assert.deepEqual(s.rows, []); assert.equal(s.status, "No favorites here yet. Star an item to keep it here.");
      await shot(p, `filter-empty-${place}`);
      // Taking the star off under the filter takes the row out; the filter off shows everything again.
      await x.libTab("artifacts");
      assert.equal((await stars(p)).filter.pressed, "true", "back on Artifacts, its filter is as it was left");
      await p.click(`#library-list .lib-row[data-key="${SHEET}"] .lib-fav`); await x.rest(250);
      assert.deepEqual((await stars(p)).rows.map((r) => r.key), [DOC]);
      const kept = await p.evaluate(() => (window.__saved?.library || window.__state?.library || {}).favorites || null);
      await p.click("#library-filter-fav"); await x.rest(250);
      s = await stars(p);
      assert.equal(s.filter.pressed, "false"); assert.equal(s.rows.length, all);
      assert.deepEqual([kept?.artifacts, kept?.videos, kept?.widgets], [true, true, false], "kept with the tab's other filters, a tab at a time");
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  });
}

test("a favorite on a later page of a long list is found: with Favorites on, the tab reads on until it has them", async (t) => {
  if (skipOrFail(t)) return;
  const images = Array.from({ length: 9 }, (_, n) => ({ ...LIB_IMAGES[1], path: `/home/me/.dgc/images/chat/beach-${n}.png`, prompt: `A beach at dusk, number ${n}`, created_at: `ago:${10 + n}` }));
  const far = `image:${images[7].path}`;
  const x = await open("side", { favorites: [far], images, pageSize: 2 });
  try {
    const p = x.page;
    await x.libTab("images"); await x.rest(200);
    assert.equal((await stars(p)).rows.length, 2, "the first page");
    const before = (await asked(x, "workImages")).length;
    await p.click("#library-filter-fav"); await x.rest(900);
    const s = await stars(p);
    assert.deepEqual(s.rows.map((r) => r.key), [far], "the one starred, from the fourth page");
    const pages = (await asked(x, "workImages")).slice(before).map((m) => m.offset);
    assert.deepEqual(pages, [2, 4, 6], "read a page at a time, and no further than where it was found");
    assert.deepEqual(x.errors || [], []);
  } finally { await x.close(); }
});

test("the kept state opens the Library with its Favorites filter on, and the list the host says replaces what the page had", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryPage(browser, { width: 900, favorites: [DOC], state: { library: { tab: "artifacts", filters: {}, favorites: { artifacts: true } } } });
  try {
    const p = x.page;
    await x.rest(250);
    let s = await stars(p);
    assert.equal(s.filter.pressed, "true"); assert.deepEqual(s.rows.map((r) => r.key), [DOC]);
    // Starred in another window: the host says the new list, and the tab follows.
    await p.evaluate((keys) => window.dispatchEvent(new MessageEvent("message", { data: { type: "favorites", offered: true, keys } })), [DOC, SHEET]); await x.rest(200);
    assert.deepEqual((await stars(p)).rows.map((r) => r.key).sort(), [DOC, SHEET].sort());
    // A DGC that stops keeping them (an older one took over): the stars and the filter go, and everything shows.
    await p.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "favorites", offered: false, keys: [] } }))); await x.rest(200);
    s = await stars(p);
    assert.equal(s.filter, null); assert.ok(s.rows.length > 2 && s.rows.every((r) => !r.star));
    assert.deepEqual(x.errors || [], []);
  } finally { await x.close(); }
});

for (const theme of ["dark", "light"]) {
  for (const width of [300, 440, 700]) {
    test(`${theme} ${width}px: the star, the menu's row and the filter fit the side bar, and nothing is cut or covered`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await openLibraryTab(browser, { width, theme: `${theme}-modern`, favorites: [DOC, SHEET] });
      try {
        const p = x.page;
        await p.hover(`#library-list .lib-row[data-key="artifact:${ar(1)}"] .lib-row-name`); await x.rest(250);
        const s = await stars(p);
        assert.equal(s.sideways, false, "no sideways scroll");
        for (const r of s.rows) {
          assert.ok(r.box.left >= r.name.right - 0.5, `${r.title}: the star is after the name`);
          assert.ok(r.box.right <= r.more.left + 0.5 || width >= 560, `${r.title}: before the ⋯`);
          assert.ok(r.box.right <= r.row.right + 0.5 && r.more.right <= r.row.right + 0.5, `${r.title}: inside its row`);
          assert.ok(r.box.top >= r.row.top - 0.5 && r.box.bottom <= r.row.bottom + 0.5, `${r.title}: inside its row's height`);
          assert.ok(r.nameCut >= 90, `${r.title}: the name keeps room (${r.nameCut}px)`);
        }
        assert.equal(row(s, DOC).color, s.accent); assert.equal(row(s, DOC).opacity, 1);
        assert.equal(row(s, `artifact:${ar(1)}`).opacity, 1, "the row pointed at shows its outline");
        assert.equal(row(s, `artifact:${ar(4)}`).opacity, 0, "the others keep theirs out of sight");
        assert.ok(s.filter.left >= s.bar.left - 0.5 && s.filter.right <= s.bar.right + 0.5, "Favorites is inside the filter line");
        assert.deepEqual([s.filter.h, s.filter.radius], [28, 6]);
        assert.equal(s.filter.wordSeen, width >= 340, "its word is beside its star where there is room; narrower, the star alone");
        const line = await p.evaluate(() => [...document.querySelectorAll("#library-filters > button")].map((b) => Math.round(b.getBoundingClientRect().top)));
        assert.equal(new Set(line).size, 1, "Kind, By and Favorites are one line");
        // The filter's star against its ground: at least 3:1, as a control's mark must be.
        const contrast = await p.evaluate(() => {
          const lum = (c) => { const v = c.match(/[\d.]+/g).slice(0, 3).map((n) => { const x = Number(n) / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
          const star = document.querySelector('.lib-fav[aria-pressed="true"]'); let ground = "rgba(0, 0, 0, 0)", n = star;
          while (n && /rgba\(0, 0, 0, 0\)|transparent/.test(ground)) { ground = getComputedStyle(n).backgroundColor; n = n.parentElement; }
          if (/rgba\(0, 0, 0, 0\)|transparent/.test(ground)) ground = getComputedStyle(document.body).backgroundColor;
          const a = lum(getComputedStyle(star).color), b = lum(ground);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        assert.ok(contrast >= 3, `the filled star reads on its ground (${contrast.toFixed(2)}:1)`);
        await shot(p, `rows-${theme}-${width}`);
        await p.click("#library-filter-fav"); await x.rest(250);
        const on = await stars(p);
        assert.equal(on.sideways, false); assert.deepEqual(on.rows.map((r) => r.key).sort(), [DOC, SHEET].sort());
        await shot(p, `filter-${theme}-${width}`);
        await p.click(`#library-list .lib-row[data-key="${DOC}"] .lib-row-more`); await p.waitForTimeout(350);
        const menu = await p.evaluate(() => { const m = document.querySelector(".dgc-pop").getBoundingClientRect(), r = [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].at(-1), l = r.querySelector(".dgc-menu-label");
          return { left: m.left, right: m.right, bottom: m.bottom, label: l.textContent, cut: l.scrollWidth > l.clientWidth + 1, h: innerHeight, w: innerWidth }; });
        assert.equal(menu.label, "Remove from Favorites"); assert.equal(menu.cut, false, "its words are whole");
        assert.ok(menu.left >= 0 && menu.right <= menu.w + 0.5 && menu.bottom <= menu.h + 0.5, "the menu is inside the side bar");
        await shot(p, `menu-${theme}-${width}`);
        assert.deepEqual(x.errors || [], []);
      } finally { await x.close(); }
    });
  }
}
