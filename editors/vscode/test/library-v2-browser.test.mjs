// Library v2 (0.52, asked 15 Nov on build 4960f96a): ONE Library module (media/library.js) draws the Library in
// the side bar's tab AND in its editor tab: narrow in the side bar, wide in the tab, the same code and the same host
// messages. In both: the header row, the search field, the tabs Artifacts · Widgets · Images · Videos · Files (icons
// when narrow), then that tab's own filter line, with real gaps between them ("the dropdowns for Type and By literally
// touch the search bar"). Images lists every image DGC made or kept, in Work, ChatDGC and the Pips, each with who made
// it and a way back. The side bar's ⋯ keeps "Open the Library in the editor"; Home's Widgets and Artifacts cards open
// the side bar's Library on that tab. In real Chromium: the real side bar (support/library-scene.mjs openLibraryTab)
// and the page src/chatdgc.ts serves in an editor tab (openLibraryPage), on one stand-in host.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { openGrid } from "./support/home-grid-scene.mjs";
import { openLibraryTab, openLibraryPage, LIB_ARTIFACTS, LIB_IMAGES, TILE, SESSION, CHAT, ar } from "./support/library-scene.mjs";

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

const TABS = ["Artifacts", "Widgets", "Images", "Videos", "Files"];
/** Both places the one module draws: the side bar at a width, the editor tab at a width. */
const open = (place, opts = {}) => (place === "side" ? openLibraryTab(browser, opts) : openLibraryPage(browser, opts));
const posted = (x, type) => x.page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
/** What the module asked to be done (not a list): through "sideLibrary" in the side bar, straight to the host in the tab. */
const asked = (x, type) => x.said(type);

// ---- 1. one module --------------------------------------------------------------------------------------------------------
test("one Library module: the side bar and the editor tab load media/library.js, and the side bar's own copy is gone", () => {
  const panel = read("src/panel.ts"), chat = read("src/chatdgc.ts"), lib = read("media/library.js");
  assert.match(lib, /DgcLibrary/, "the module is window.DgcLibrary");
  assert.match(panel, /"media", "library\.js"/, "the side bar's page loads it");
  assert.match(chat.slice(chat.indexOf("export function libraryDocument")), /asset\("media\/library\.js"\)/, "the editor tab's page loads it");
  assert.equal(existsSync(root + "media/shared/librarypage.js"), false, "the side bar's own Library page is retired");
  assert.equal(existsSync(root + "media/shared/librarypage.css"), false);
  assert.doesNotMatch(panel + read("media/main.js") + read("media/main.css"), /librarypage/, "nothing loads it");
  // The editor tab's page holds no list of its own: the module draws all of it into one root.
  const doc = chat.slice(chat.indexOf("export function libraryDocument")).match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1];
  assert.match(doc, /id="library-root"/); assert.doesNotMatch(doc, /lib-views|lib-kinds|lib-list/);
  // And the side bar's page holds only where it goes.
  assert.doesNotMatch(panel, /id="library-filters"|id="library-list"/);
});
for (const [place, width] of [["side", 300], ["tab", 1100]]) {
  test(`${place} ${width} px: the module draws the header row, the search field, the five tabs, the filter line and the rows`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width });
    try {
      const l = await x.lib();
      assert.ok(l && l.shown, "the Library is drawn by the module (.dgc-lib)");
      assert.equal(l.place, place);
      assert.equal(l.title, "Library");
      assert.deepEqual(l.tabs.map((t) => t.name), TABS, "Artifacts · Widgets · Images · Videos · Files");
      assert.equal(l.tab, "artifacts", "it opens on Artifacts");
      assert.ok(l.rows.length > 0, "with its rows");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- 2 and 3. the order, the gaps, the tabs ---------------------------------------------------------------------------------
for (const theme of ["dark-modern", "light-modern"]) for (const [place, width] of [["side", 170], ["side", 300], ["side", 440], ["side", 700], ["tab", 560], ["tab", 1100]]) {
  test(`${place} ${width} px (${theme}): header row, then search, then the tabs, then the filter line, 8 px or more apart, nothing off the side`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width, theme });
    try {
      const l = await x.lib();
      assert.ok(l.head && l.more && l.search && l.tabsBar && l.filtersBar && l.list, "every part is there");
      const order = [["the header row", l.head], ["the search field", l.search], ["the tabs", l.tabsBar], ["the filter line", l.filtersBar], ["the rows", l.list]];
      for (let i = 1; i < order.length; i++) {
        const gap = order[i][1].top - order[i - 1][1].bottom;
        assert.ok(gap >= 7.5, `${order[i][0]} are ${gap.toFixed(1)} px under ${order[i - 1][0]}: 8 px or more, never touching`);
        assert.ok(gap <= 16.5, `${order[i][0]} are ${gap.toFixed(1)} px under ${order[i - 1][0]}: one family of gaps (8 to 16)`);
      }
      const gaps = order.slice(2).map((o, i) => Math.round(o[1].top - order[i + 1][1].bottom));
      assert.equal(new Set(gaps).size, 1, `search → tabs → filters → rows are one gap apart: ${gaps}`);
      assert.equal(l.sideways, false, "nothing runs off the side");
      for (const part of [l.head, l.search, l.tabsBar, l.filtersBar]) assert.ok(part.left >= 7.5 && part.right <= l.width - 7.5, "inside the page's own margin");
      assert.ok(Math.abs(l.search.left - l.tabsBar.left) < 0.6 && Math.abs(l.search.right - l.tabsBar.right) < 0.6, "the tabs are as wide as the search field");
      assert.ok(Math.abs(l.filters[0].left - l.search.left) < 0.6, "the filter line starts where the search field does");
      assert.equal(Math.round(l.search.h), 28, "the search field is a control's height");
      for (const f of l.filters) { assert.equal(Math.round(f.h), 28, `${f.key}: a control's height`); assert.equal(f.radius, 6, `${f.key}: the 6 px corner, never a pill`); }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
for (const [place, width] of [["side", 440], ["side", 700], ["tab", 560], ["tab", 1100]]) {
  test(`${place} ${width} px: the five tabs show their names, whole, with one chosen; the arrow keys move between them`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width });
    try {
      let l = await x.lib();
      assert.deepEqual(l.tabs.map((t) => t.name), TABS);
      for (const tab of l.tabs) { assert.equal(tab.word, true, `${tab.name} shows its name`); assert.equal(tab.cut, false, `${tab.name} is whole`); assert.ok(tab.radius <= 6, "never a pill"); }
      assert.deepEqual(l.tabs.map((t) => t.tabindex), [0, -1, -1, -1, -1], "one tab stop");
      assert.equal(await x.page.evaluate(() => document.getElementById("library-tabs").getAttribute("role")), "tablist");
      await x.page.focus("#library-tab-artifacts"); await x.page.keyboard.press("ArrowRight"); await x.rest(150);
      l = await x.lib(); assert.equal(l.tab, "widgets", "Right chooses Widgets");
      await x.page.keyboard.press("End"); await x.rest(150);
      l = await x.lib(); assert.equal(l.tab, "files", "End chooses Files");
      await x.page.keyboard.press("ArrowRight"); await x.rest(150);
      l = await x.lib(); assert.equal(l.tab, "artifacts", "and round to Artifacts");
      assert.equal(await x.page.evaluate(() => document.activeElement?.id), "library-tab-artifacts", "focus follows");
      const panel = await x.page.evaluate(() => { const list = document.getElementById("library-list"); return [list.getAttribute("role"), list.getAttribute("aria-labelledby")]; });
      assert.deepEqual(panel, ["tabpanel", "library-tab-artifacts"]);
    } finally { await x.close(); }
  });
}
for (const width of [170, 220]) {
  test(`side ${width} px: the Library's tabs are icons, each as wide as the others, their names kept for a screen reader and as a label`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open("side", { width });
    try {
      const l = await x.lib();
      assert.equal(l.tabs.length, 5);
      for (const tab of l.tabs) { assert.equal(tab.icon, true, `${tab.name} is its icon`); assert.equal(tab.word, false, `${tab.name}'s word takes no room`); assert.equal(tab.name, TABS[l.tabs.indexOf(tab)], "the word is still in the page"); assert.ok(tab.tip.startsWith(tab.name), "and is its label"); }
      const widths = l.tabs.map((t) => Math.round(t.w));
      assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `five tabs of one width: ${widths}`);
      assert.ok(l.tabs.at(-1).right <= l.tabsBar.right + 0.5 && l.tabs[0].left >= l.tabsBar.left - 0.5, "all inside the bar");
      assert.equal(l.sideways, false);
    } finally { await x.close(); }
  });
}
for (const width of [260, 284, 288, 292, 300]) {
  test(`side ${width} px: where the names turn into icons no name is ever cut: names with room to spare, or icons`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open("side", { width });
    try {
      const l = await x.lib();
      for (const tab of l.tabs) { assert.equal(tab.cut, false, `${tab.name} is not cut`); assert.ok(tab.word || tab.icon, `${tab.name} shows a name or an icon`); }
      assert.equal(new Set(l.tabs.map((t) => t.word)).size, 1, "all five the same way");
      assert.equal(l.tabs[0].word, width >= 288, "names from a side bar of about 286 px (the usual 300 px shows them)");
      // A name has 2 px or more each side inside its tab, so a font a little wider than this one still fits.
      const room = await x.page.evaluate(() => [...document.querySelectorAll("#library-tabs .lib-tab")].map((t) => { const w = t.querySelector(".lib-tab-word").getBoundingClientRect(), r = t.getBoundingClientRect(); return w.width > 2 ? Math.min(w.left - r.left, r.right - w.right) : 9; }));
      assert.ok(Math.min(...room) >= 2, `room each side of a name: ${room.map((v) => v.toFixed(1))}`);
      assert.equal(l.sideways, false);
    } finally { await x.close(); }
  });
}

// ---- 3. each tab's own filter line ------------------------------------------------------------------------------------------
for (const place of ["side", "tab"]) {
  test(`${place}: each tab has its own filter line: Artifacts kind + maker; Widgets, Images and Videos maker; Files kind + origin`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width: place === "side" ? 440 : 1100 });
    try {
      const filters = async () => (await x.lib()).filters.map((f) => [f.id, f.key, f.value]);
      assert.deepEqual(await filters(), [["kind", "Kind", "All"], ["maker", "By", "Anyone"]]);
      assert.deepEqual((await x.menu("kind")).map((r) => r.label), ["All", "Pages", "Spreadsheets", "Documents", "Slides", "Dashboards", "Checklists", "Designs"]);
      await x.page.keyboard.press("Escape"); await x.rest(200);
      const makers = await x.menu("maker");
      assert.deepEqual(makers.slice(0, 4).map((r) => r.label), ["Anyone", "Work", "Chat", "Pips"]);
      assert.deepEqual(makers.filter((r) => r.head).map((r) => r.head), ["Pips", "Work sessions", "Chats"], "then each maker by name, by kind");
      assert.ok(makers.some((r) => r.label === "Tile checker") && makers.some((r) => r.label === "Fix totals") && makers.some((r) => r.label === "Rent or buy: the numbers"));
      await x.page.keyboard.press("Escape"); await x.rest(200);
      for (const id of ["widgets", "images", "videos"]) { await x.libTab(id); assert.deepEqual(await filters(), [["maker", "By", "Anyone"]], `${id}: the maker only`); }
      await x.libTab("files");
      assert.deepEqual(await filters(), [["kind", "Kind", "All"], ["origin", "From", "All"]]);
      assert.deepEqual((await x.menu("kind")).map((r) => r.label), ["All", "Images", "PDFs", "Spreadsheets"], "the kinds of file there are");
      await x.page.keyboard.press("Escape"); await x.rest(200);
      assert.deepEqual((await x.menu("origin")).map((r) => r.label), ["All", "Uploaded", "Made by ChatDGC"]);
      await x.pick("origin", "Made by ChatDGC");
      assert.equal((await asked(x, "list")).at(-1).origin, "made", "the host is asked for that origin");
      assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["Beach map.png"]);
      await x.pick("kind", "PDFs");
      assert.deepEqual([(await asked(x, "list")).at(-1).kind, (await asked(x, "list")).at(-1).origin], ["pdf", "made"]);
      assert.match((await x.lib()).status, /No PDFs/);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
  test(`${place}: Artifacts lists the pages, sheets, docs, decks and dashboards; its filters are the kind and the maker`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width: place === "side" ? 300 : 1100 });
    try {
      let l = await x.lib();
      assert.deepEqual(l.rows.map((r) => r.title), ["Tide pool walk, Saturday", "Acme sales sheet", "Launch notes", "Q3 plan", "Store sales", "Tip calculator", LIB_ARTIFACTS[8].title], "newest first; what a widget or a card made is under Widgets");
      const tide = l.rows[0];
      assert.equal(tide.thumb, "sheet"); assert.equal(tide.by, "made by"); assert.equal(tide.maker, "Tile checker"); assert.equal(tide.when, "40m"); assert.equal(tide.makerIs, "BUTTON");
      assert.equal(l.rows.find((r) => r.title === "Tip calculator").meta.startsWith("made in Work"), true, "no name: the kind only");
      await x.pick("kind", "Spreadsheets"); l = await x.lib();
      assert.deepEqual(l.rows.map((r) => r.title), ["Acme sales sheet"]); assert.equal(l.filters[0].value, "Spreadsheets");
      await x.pick("kind", "All"); await x.pick("maker", "Pips"); l = await x.lib();
      assert.deepEqual(l.rows.map((r) => r.title), ["Tide pool walk, Saturday", "Store sales"]);
      await x.pick("maker", "Tile checker"); l = await x.lib();
      assert.deepEqual(l.rows.map((r) => r.title), ["Tide pool walk, Saturday"]); assert.equal(l.filters[1].value, "Tile checker");
      await x.pick("kind", "Slides"); l = await x.lib();
      assert.equal(l.rows.length, 0); assert.equal(l.status, "No slides made by Tile checker yet.");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
  test(`${place}: Widgets lists ChatDGC's widgets and the cards a reply drew, each with who made it; its filter is the maker`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width: place === "side" ? 300 : 1100 });
    try {
      await x.libTab("widgets");
      let l = await x.lib();
      assert.deepEqual(l.rows.map((r) => r.title), ["Open invoices by month", "Trip budget calculator"], "a card a Pip's reply drew, and a ChatDGC widget (once, not also as its page)");
      assert.deepEqual(l.rows.map((r) => [r.by, r.maker]), [["made by", "Tile checker"], ["made by", "A week in Goa in March"]]);
      assert.equal(l.rows[1].thumb, "mark", "a widget wears its mark");
      assert.equal((await asked(x, "widgets")).length >= 1, true, "ChatDGC's widgets are asked of the host");
      await x.pick("maker", "Chat"); l = await x.lib();
      assert.deepEqual(l.rows.map((r) => r.title), ["Trip budget calculator"]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
    // A DGC whose ChatDGC keeps no widgets: the pages a widget made are listed here from the artifacts.
    const y = await open(place, { width: place === "side" ? 300 : 1100, widgets: null });
    try { await y.libTab("widgets"); assert.deepEqual((await y.lib()).rows.map((r) => r.title), ["Open invoices by month", "Weekly signups"]); } finally { await y.close(); }
  });
}

// ---- 4. Images ------------------------------------------------------------------------------------------------------------
for (const place of ["side", "tab"]) {
  test(`${place}: Images lists every image DGC made or kept, in Work, ChatDGC and the Pips: its picture, its title, who made or kept it, when`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width: place === "side" ? 300 : 1100 });
    try {
      await x.libTab("images");
      const ask = (await asked(x, "workImages")).at(-1);
      assert.equal("surface" in ask, false, "every surface is asked for: no `surface`");
      const l = await x.lib();
      assert.deepEqual(l.rows.map((r) => r.title), ["Tile prices, 2024 to 2026", "A beach at dusk, in watercolour", "A wall of lime green tiles in morning light", "A logo of three slashes"], "a kept image's title, else its prompt");
      for (const r of l.rows) assert.equal(r.thumb, "img", `${r.title} shows its picture`);
      assert.deepEqual(l.rows.map((r) => [r.by, r.maker, r.when]), [["kept by", "Tile checker", "12m"], ["made by", "Rent or buy: the numbers", "45m"], ["made by", "Fix totals", "3h"], ["made in the terminal", "", "4d"]]);
      assert.deepEqual(l.rows.map((r) => r.makerIs), ["BUTTON", "BUTTON", "BUTTON", ""], "a name with somewhere to go back to is a link");
      assert.match(l.rows[0].tip, /The chart for the supplier call/, "why it was kept is said on the row: its name's label, and what a screen reader hears");
      assert.match(l.rows[0].said, /The chart for the supplier call/);
      assert.equal((await asked(x, "workImage")).length, 4, "each picture is read from the host");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
  // Save to Library (18 Nov): a picture you kept from a chat says so, and leads back to the chat it came from.
  test(`${place}: a picture you saved to the Library says "saved by you from" its chat`, async (t) => {
    if (skipOrFail(t)) return;
    const mine = { ...LIB_IMAGES[0], path: "/home/me/.dgc/images/kept/cafe-front-20261118.png", title: "Painter: picture 1", why: "", kept_by: "you",
                   made_by: { kind: "pip", id: TILE, name: "Painter" } };
    const x = await open(place, { width: place === "side" ? 300 : 1100, images: [mine] });
    try {
      await x.libTab("images");
      const l = await x.lib();
      assert.deepEqual(l.rows.map((r) => [r.title, r.by, r.maker]), [["Painter: picture 1", "saved by you from", "Painter"]]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
  test(`${place}: an image's maker leads back (a Pip to its chat, a session and a chat open), and it opens, shows in its folder and saves a copy`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width: place === "side" ? 300 : 1100 });
    try {
      await x.libTab("images");
      const maker = (n) => x.page.locator("#library-list .lib-row").nth(n).locator(".lib-row-maker").click();
      await maker(2); await x.rest(150);
      if (place === "side") assert.deepEqual((await posted(x, "openSessionInEditor")).at(-1), { type: "openSessionInEditor", id: SESSION, title: "Fix totals" });
      else assert.deepEqual((await asked(x, "maker")).at(-1), { type: "maker", maker: { kind: "session", id: SESSION, name: "Fix totals" } });
      await maker(1); await x.rest(150);
      if (place === "side") assert.deepEqual((await posted(x, "chatdgcOpen")).at(-1), { type: "chatdgcOpen", id: CHAT });
      else assert.deepEqual((await asked(x, "maker")).at(-1), { type: "maker", maker: { kind: "chat", id: CHAT, name: "Rent or buy: the numbers" } });
      assert.equal((await asked(x, "itemAct")).length, 0, "the name is its own press: the row did not open");
      // The row opens the image; Reveal in file manager and Save a copy are its actions. Each asks the host the one
      // way an item's menu does (itemAct, library-actions-browser.test.mjs), naming the image by its path.
      const path = LIB_IMAGES[2].path, item = { kind: "image", path };
      await x.page.locator("#library-list .lib-row").nth(2).locator(".lib-row-name").click(); await x.rest(120);
      assert.deepEqual((await asked(x, "itemAct")).at(-1), { type: "itemAct", act: "open", item });
      const act = async (n, id, label) => {
        const row = x.page.locator("#library-list .lib-row").nth(n);
        if (place === "tab") { const b = row.locator(`.lib-row-actions [data-act="${id}"]`); assert.equal(await b.getAttribute("aria-label"), label); await b.click(); }
        else { await row.hover(); await row.locator(".lib-row-more").click(); await x.page.waitForTimeout(350); await x.page.locator(`.dgc-pop .dgc-menu-row[data-id="${id}"]`).click(); }
        await x.rest(200);
      };
      if (place === "side") { const row = x.page.locator("#library-list .lib-row").nth(2); await row.hover(); await row.locator(".lib-row-more").click(); await x.page.waitForTimeout(350);
        assert.deepEqual(await x.menuRows(), ["Open", "Open in editor", "Save a copy…", "Copy", "Copy path", "Reveal in file manager", "Rename…", "Remove…", "Save to project…"]); await x.page.keyboard.press("Escape"); await x.rest(200); }
      await act(2, "reveal", "Reveal in file manager");
      assert.deepEqual((await asked(x, "itemAct")).at(-1), { type: "itemAct", act: "reveal", item });
      await act(2, "save", "Save a copy…");
      assert.deepEqual((await asked(x, "itemAct")).at(-1), { type: "itemAct", act: "save", item });
      if (place === "side") {
        // A Pip's name opens that Pip's chat, in the Pips view.
        await maker(0);
        await x.page.waitForFunction(() => document.getElementById("pips-host").checkVisibility(), null, { timeout: 15000 });
        assert.equal((await x.tabs()).tabs.find((b) => b.selected).id, "pips");
      } else { await maker(0); await x.rest(120); assert.deepEqual((await asked(x, "maker")).at(-1), { type: "maker", maker: { kind: "pip", id: TILE, name: "Tile checker" } }); }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
  test(`${place}: Images' maker filter asks the host for one surface, and a name shows what that one made; Videos say who made each`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width: place === "side" ? 300 : 1100 });
    try {
      await x.libTab("images");
      const makers = await x.menu("maker");
      assert.deepEqual(makers.slice(0, 4).map((r) => r.label), ["Anyone", "Work", "Chat", "Pips"]);
      assert.ok(makers.some((r) => r.label === "Tile checker") && makers.some((r) => r.label === "Fix totals"), "the makers by name");
      await x.pick("maker", "Pips");
      assert.equal((await asked(x, "workImages")).at(-1).surface, "pip");
      assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["Tile prices, 2024 to 2026"]);
      await x.pick("maker", "Fix totals");
      assert.equal((await asked(x, "workImages")).at(-1).surface, "work", "a session's images are Work's");
      assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["A wall of lime green tiles in morning light"]);
      await x.libTab("videos");
      const l = await x.lib();
      assert.deepEqual(l.rows.map((r) => [r.title, r.by, r.maker]), [["Tiles being laid, a time-lapse", "made by", "Tile checker"], ["The hero wall, a slow pan", "made by", "Fix totals"]]);
      assert.equal("surface" in (await asked(x, "videoList")).at(-1), false, "Videos start on Anyone (each tab keeps its own filter)");
      await x.pick("maker", "Work");
      assert.equal((await asked(x, "videoList")).at(-1).surface, "work");
      assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["The hero wall, a slow pan"]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
  test(`${place}: the search field searches the tab you are on, and says so`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width: place === "side" ? 300 : 1100 });
    try {
      assert.equal((await x.lib()).search.placeholder, "Search artifacts");
      const before = (await asked(x, "list")).length;
      await x.search("sales");
      assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["Acme sales sheet", "Store sales"]);
      assert.equal((await asked(x, "list")).length, before, "Artifacts are searched here: the files are not asked for");
      await x.search("tile checker");
      assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["Tide pool walk, Saturday"], "by who made it too");
      await x.search("zzz");
      assert.equal((await x.lib()).status, "No artifact named like “zzz”.");
      await x.search("");
      await x.libTab("images");
      assert.equal((await x.lib()).search.placeholder, "Search images");
      await x.search("beach");
      assert.equal((await asked(x, "workImages")).at(-1).query, "beach", "the host searches the images");
      assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["A beach at dusk, in watercolour"]);
      await x.libTab("files");
      assert.equal((await x.lib()).search.placeholder, "Search files");
      assert.equal((await asked(x, "list")).at(-1).query, "beach", "the words stay as you change tab, and search that tab");
      assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["Beach map.png"]);
      await x.libTab("videos");
      assert.equal((await asked(x, "videoList")).at(-1).query, "beach");
      assert.equal((await x.lib()).status, "No video made from words like “beach”.");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
test("Images reads on: Show more asks the host for the next page of images", async (t) => {
  if (skipOrFail(t)) return;
  const many = Array.from({ length: 7 }, (_, i) => ({ ...LIB_IMAGES[2], path: `/home/me/shop/assets/tile-${i}.png`, prompt: `Tile number ${i}`, created_at: new Date(Date.now() - (i + 1) * 60000).toISOString() }));
  const x = await open("side", { width: 300, images: many, pageSize: 4 });
  try {
    await x.libTab("images");
    let l = await x.lib(); assert.equal(l.rows.length, 4); assert.equal(l.load, true, "Show more is offered");
    await x.page.click("#library-load"); await x.rest(250);
    l = await x.lib(); assert.equal(l.rows.length, 7); assert.equal(l.load, false);
    assert.deepEqual((await asked(x, "workImages")).map((m) => m.offset), [0, 4]);
  } finally { await x.close(); }
});

// ---- rows: what each can do, the same in both ---------------------------------------------------------------------------------
test("tab 1100 px: a row's quick actions are icon buttons beside it, then its ⋯; side 300 px: everything under the row's ⋯", async (t) => {
  if (skipOrFail(t)) return;
  const wide = await open("tab", { width: 1100 }), narrow = await open("side", { width: 300 });
  try {
    const w = (await wide.lib()).rows[1], n = (await narrow.lib()).rows[1];
    assert.equal(w.title, "Acme sales sheet"); assert.equal(n.title, "Acme sales sheet");
    assert.deepEqual(w.acts, ["open", "save", "pin", "remove"], "wide: its buttons"); assert.equal(w.more, true, "wide: and its ⋯, the whole menu");
    assert.deepEqual(n.acts, [], "narrow: no row of buttons");
    const row = narrow.page.locator("#library-list .lib-row").nth(1); await row.hover(); await narrow.rest(200);
    assert.equal(await row.locator(".lib-row-more").evaluate((b) => b.checkVisibility({ opacityProperty: true })), true, "narrow: ⋯ under the pointer");
    await row.locator(".lib-row-more").click(); await narrow.page.waitForTimeout(350);
    assert.deepEqual(await narrow.menuRows(), ["Open", "Open in editor", "Save a copy…", "Copy", "Copy path", "Reveal in file manager", "Rename…", "Remove…", "Pin to the dock"]);
    // Save a copy…: the host offers a sheet's formats (Excel, CSV) and then its own save dialog (src/chatdgc.ts libraryAct).
    const sheet = { kind: "artifact", id: ar(2) };
    await narrow.page.locator('.dgc-pop .dgc-menu-row[data-id="save"]').click(); await narrow.rest(150);
    assert.deepEqual((await asked(narrow, "itemAct")).at(-1), { type: "itemAct", act: "save", item: sheet });
    // Wide: the same, from its buttons.
    const save = wide.page.locator("#library-list .lib-row").nth(1).locator('[data-act="save"]');
    assert.equal(await save.getAttribute("aria-label"), "Save a copy…");
    await save.click(); await wide.rest(150);
    assert.deepEqual((await asked(wide, "itemAct")).at(-1), { type: "itemAct", act: "save", item: sheet });
    await wide.page.locator("#library-list .lib-row").nth(1).locator('[data-act="remove"]').click(); await wide.rest(150);
    assert.deepEqual((await asked(wide, "itemAct")).at(-1), { type: "itemAct", act: "remove", item: sheet });
    // A row opens its item, by a click and by Enter, in both.
    for (const x of [wide, narrow]) {
      await x.page.locator("#library-list .lib-row").first().locator(".lib-row-name").click(); await x.rest(120);
      assert.deepEqual((await asked(x, "itemAct")).at(-1), { type: "itemAct", act: "open", item: { kind: "artifact", id: ar(1) } });
      await x.page.locator("#library-list .lib-row").nth(2).focus(); await x.page.keyboard.press("Enter"); await x.rest(120);
      assert.deepEqual((await asked(x, "itemAct")).at(-1), { type: "itemAct", act: "open", item: { kind: "artifact", id: ar(3) } });
      assert.deepEqual(x.errors, []);
    }
  } finally { await wide.close(); await narrow.close(); }
});
test("side: a pin from a row's ⋯ goes to the side bar's own dock; tab: a row's pin goes to the host", async (t) => {
  if (skipOrFail(t)) return;
  const narrow = await open("side", { width: 300, pins: [] }), wide = await open("tab", { width: 1100 });
  try {
    const row = narrow.page.locator("#library-list .lib-row").first(); await row.hover(); await row.locator(".lib-row-more").click(); await narrow.page.waitForTimeout(350);
    await narrow.page.locator(".dgc-pop .dgc-menu-row", { hasText: "Pin to the dock" }).click(); await narrow.rest(300);
    const pinned = (await posted(narrow, "dockToggle")).at(-1);
    assert.deepEqual([pinned.item.kind, pinned.item.id, pinned.item.title], ["artifact", ar(1), "Tide pool walk, Saturday"], "said to the side bar's host itself, not through sideLibrary");
    assert.equal((await asked(narrow, "dockToggle")).length, 0);
    await row.hover(); await row.locator(".lib-row-more").click(); await narrow.page.waitForTimeout(350);
    assert.ok((await narrow.menuRows()).includes("Unpin from the dock"), "and the row knows it is pinned");
    await narrow.page.keyboard.press("Escape");
    await wide.page.locator("#library-list .lib-row").first().locator('[data-act="pin"]').click(); await wide.rest(150);
    assert.equal((await asked(wide, "dockToggle")).at(-1).item.id, ar(1));
  } finally { await narrow.close(); await wide.close(); }
});

// ---- 7. the side bar's ⋯ -----------------------------------------------------------------------------------------------------
test("the side bar's ⋯ keeps “Open the Library in the editor”: it opens the editor tab on the tab you are on", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("side", { width: 300 });
  try {
    await x.page.click("#library-more"); await x.page.waitForTimeout(350);
    assert.deepEqual(await x.menuRows(), ["Open the Library in the editor", "Page preview settings"]);
    await x.page.locator(".dgc-pop .dgc-menu-row", { hasText: "Open the Library in the editor" }).click(); await x.rest(150);
    assert.deepEqual((await posted(x, "homeLibraryOpen")).at(-1), { type: "homeLibraryOpen", view: "artifacts" });
    await x.libTab("images");
    await x.page.click("#library-more"); await x.page.waitForTimeout(350);
    await x.page.locator(".dgc-pop .dgc-menu-row", { hasText: "Open the Library in the editor" }).click(); await x.rest(150);
    assert.deepEqual((await posted(x, "homeLibraryOpen")).at(-1), { type: "homeLibraryOpen", view: "images" });
  } finally { await x.close(); }
  // In the editor tab it is the same module, already full width: its ⋯ has the settings only; the host's "view" chooses a tab.
  const y = await open("tab", { width: 1100, view: "images" });
  try {
    assert.equal((await y.lib()).tab, "images", "opened on the tab the side bar was on");
    await y.page.click("#library-more"); await y.page.waitForTimeout(350);
    assert.deepEqual(await y.menuRows(), ["Page preview settings"]);
    await y.page.locator(".dgc-pop .dgc-menu-row").first().click(); await y.rest(150);
    assert.deepEqual((await asked(y, "settings")).at(-1), { type: "settings", section: "security" });
  } finally { await y.close(); }
});

// ---- 8. Home's cards ------------------------------------------------------------------------------------------------------------
test("Home's Widgets and Artifacts cards open the side bar's Library on that tab, not the editor's page", async (t) => {
  if (skipOrFail(t)) return;
  for (const [card, tab] of [["widgets", "widgets"], ["artifacts", "artifacts"]]) {
    const x = await openGrid(browser, { width: 440, layout: [card] });
    try {
      await x.page.locator(`#home-hub .hc-card[data-card="${card}"] [data-library]`).first().click();
      await x.page.waitForTimeout(400);
      assert.equal(await x.page.evaluate(() => document.getElementById("side-tab-library").getAttribute("aria-selected")), "true", `${card}: the Library tab is chosen`);
      assert.equal(await x.page.evaluate(() => document.querySelector('#library-tabs [aria-selected="true"]')?.dataset.tab), tab, `${card}: on its tab`);
      assert.deepEqual(await x.page.evaluate(() => window.__posted.filter((m) => m.type === "homeLibraryOpen")), [], "the editor's page is not opened");
    } finally { await x.close(); }
  }
});

// ---- kept, changed, narrow, touch ---------------------------------------------------------------------------------------------
for (const place of ["side", "tab"]) {
  test(`${place}: the tab and each tab's filters are kept for a reload`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width: place === "side" ? 300 : 1100 });
    let saved;
    try {
      await x.pick("kind", "Pages");
      await x.libTab("images"); await x.pick("maker", "Pips");
      saved = await x.page.evaluate(() => (typeof window.__saved === "object" && window.__saved) || window.__state);
    } finally { await x.close(); }
    const again = await open(place, place === "side" ? { width: 300, saved: { ...saved, sideTab: "library" } } : { width: 1100, state: saved });
    try {
      let l = await again.lib();
      assert.equal(l.tab, "images"); assert.equal(l.filters[0].value, "Pips");
      assert.deepEqual(l.rows.map((r) => r.title), ["Tile prices, 2024 to 2026"]);
      await again.libTab("artifacts"); l = await again.lib();
      assert.equal(l.filters[0].value, "Pages", "Artifacts kept its own");
    } finally { await again.close(); }
  });
}
test("what changes is seen: an artifact made while the Library shows is listed, one removed goes; a DGC with no artifacts, images or videos has no such tab", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("side", { width: 300 });
  try {
    await x.page.evaluate((a) => { window.__lib.artifacts = [a, ...window.__lib.artifacts]; }, { ...LIB_ARTIFACTS[0], id: ar(0), title: "Brand new page", updated: new Date().toISOString() });
    await x.send({ type: "sideLibrary", message: { type: "artifactChanged", artifact: { id: ar(0) }, op: "created" } }); await x.rest(250);
    assert.equal((await x.lib()).rows[0].title, "Brand new page");
    await x.send({ type: "sideLibrary", message: { type: "artifactRemoved", id: ar(0) } }); await x.rest(150);
    assert.notEqual((await x.lib()).rows[0].title, "Brand new page");
  } finally { await x.close(); }
  for (const place of ["side", "tab"]) {
    const y = await open(place, { width: place === "side" ? 300 : 1100, artifacts: null, images: null, videos: null, widgets: null });
    try {
      const l = await y.lib();
      assert.deepEqual(l.tabs.map((t) => t.name), ["Files"], "only what this DGC keeps");
      assert.equal(l.tab, "files"); assert.deepEqual(l.rows.map((r) => r.title), ["Beach map.png", "Billing review.pdf", "ferry-times.csv"]);
    } finally { await y.close(); }
  }
});
for (const theme of ["dark-modern", "light-modern"]) {
  test(`side 170 px (${theme}): every tab's rows keep their picture, a title on one line ending in “…” and the maker line; no word is cut mid-word, no button is a pill`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open("side", { width: 170, theme });
    try {
      for (const id of ["artifacts", "widgets", "images", "videos", "files"]) {
        await x.libTab(id);
        const l = await x.lib();
        assert.equal(l.sideways, false, `${id}: nothing runs off the side`);
        assert.ok(l.rows.length > 0, `${id}: rows`);
        for (const r of l.rows) { assert.ok(r.right <= 170.5 && r.left >= -0.5, `${id}: ${r.title} is inside`); assert.ok(r.h <= 56, `${id}: ${r.title} is one row (${r.h})`); assert.ok(r.thumb, `${id}: ${r.title} keeps its picture`); }
        const found = await x.page.evaluate(() => {
          const out = { split: [], pills: [], titles: [] };
          for (const b of document.querySelectorAll(".dgc-lib button, .dgc-lib [role=tab]")) { if (!b.checkVisibility()) continue; const r = b.getBoundingClientRect(), radius = parseFloat(getComputedStyle(b).borderTopLeftRadius);
            if (radius > 6.5 && r.width > 12) out.pills.push(b.id || b.className); }
          for (const n of document.querySelectorAll(".dgc-lib .dgc-pagehead-title, .dgc-lib .lib-row-name, .dgc-lib .lib-filter span, .dgc-lib .lib-tab-word")) { if (!n.checkVisibility()) continue;
            // (One line: every piece of the words is on the same line. A title cut by "…" is still one line.)
            const range = document.createRange(); range.selectNodeContents(n); if (new Set([...range.getClientRects()].filter((r) => r.width > 1).map((r) => Math.round(r.top / 4))).size > 1) out.split.push(n.textContent); }
          for (const n of document.querySelectorAll(".dgc-lib .lib-row-name")) if (getComputedStyle(n).textOverflow !== "ellipsis" || getComputedStyle(n).whiteSpace !== "nowrap") out.titles.push(n.textContent);
          return out; });
        assert.deepEqual(found, { split: [], pills: [], titles: [] }, id);
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
test("side 170 px: a filter is one word: its key while it is on All (“Kind”, “From”), what is chosen otherwise; two never both read “All”", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("side", { width: 170 });
  try {
    const words = () => x.page.evaluate(() => [...document.querySelectorAll("#library-filters .lib-filter")].map((b) => b.innerText.trim()));
    assert.deepEqual(await words(), ["Kind", "Anyone"]);
    await x.pick("kind", "Spreadsheets"); assert.deepEqual(await words(), ["Spreadsheets", "Anyone"]);
    await x.pick("maker", "Fix totals"); assert.deepEqual(await words(), ["Spreadsheets", "Fix totals"]);
    await x.libTab("files"); assert.deepEqual(await words(), ["Kind", "From"]);
    await x.pick("origin", "Uploaded"); assert.deepEqual(await words(), ["Kind", "Uploaded"]);
    const l = await x.lib();
    assert.equal(l.sideways, false);
    for (const f of l.filters) assert.ok(f.right <= 170 - 7.5, `${f.value || f.key} is inside the side bar`);
    // Said in full to a screen reader, whatever is drawn.
    assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll("#library-filters .lib-filter")].map((b) => b.getAttribute("aria-label"))), ["Kind: All", "From: Uploaded"]);
  } finally { await x.close(); }
});
for (const [place, width] of [["side", 300], ["tab", 1100]]) {
  test(`${place} ${width} px, touch: every control is in sight without a pointer, and a maker's name says it can be pressed`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width, touch: true });
    try {
      await x.libTab("images");
      const l = await x.lib();
      assert.ok(l.rows.every((r) => r.more || r.acts.length > 0), "each row's actions can be reached");
      const sizes = await x.page.evaluate(() => [...document.querySelectorAll(".dgc-lib .lib-row-more, .dgc-lib .lib-row-actions [data-act], .dgc-lib .dgc-pagehead-more")].filter((b) => b.checkVisibility({ opacityProperty: true })).map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
      assert.ok(sizes.length > 0 && sizes.every(([w, h]) => w >= 28 && h >= 28), `each is 28 px or more: ${JSON.stringify(sizes.slice(0, 6))}`);
      const underline = await x.page.evaluate(() => getComputedStyle(document.querySelector(".dgc-lib button.lib-row-maker")).textDecorationLine);
      assert.equal(underline, "underline");
    } finally { await x.close(); }
  });
}
