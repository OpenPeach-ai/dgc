// The Library everywhere (0.52, his calls of 15 Nov; live round 1, findings 37 and 38): Library is the side bar's
// fifth tab (Home · Work · Chat · Pips · Library, icons when narrow as the other four), Home's top row has a Library
// button beside Cards, and the Library page is in the side bar: the header row of Work, Chat and Pips ("Library", ⋯, a
// line, the search field), one filter line (the type, and who made it), and a row for everything DGC keeps: a small
// preview or the type's sheet, the title, and "made by <name> · <when>" where the name leads back to the Pip, the
// session or the chat. A row opens the item in an editor tab; ⋯ opens the full Library. Work and Chat keep no Library.
// On the real side bar, in real Chromium (test/support/library-scene.mjs is the host's stand-in).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock } from "./support/dock-scene.mjs";
import { openGrid } from "./support/home-grid-scene.mjs";
import { openLibraryTab, LIB_ARTIFACTS, TILE, SESSION, CHAT, ar } from "./support/library-scene.mjs";

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
const posted = (x, type) => x.page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);

// ---- 1. the fifth tab ---------------------------------------------------------------------------------------------------
for (const width of [300, 440, 700]) {
  test(`${width} px: five tabs by name, Home · Work · Chat · Pips · Library, none cut`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 700 });
    try {
      const bar = await x.tabs();
      assert.deepEqual(bar.tabs.filter((b) => b.shown).map((b) => b.name), ["Home", "Work", "Chat", "Pips", "Library"]);
      for (const b of bar.tabs) { assert.equal(b.clipped, false, `${b.name} is whole`); assert.equal(b.icons, b.id === "pips" ? 1 : 0, `${b.name} is its word${b.id === "pips" ? " and the Core Pip's face" : ""}`); }
      const cut = await x.page.evaluate(() => [...document.querySelectorAll("#side-tabs .dgc-tab-word")].filter((w) => w.scrollWidth > w.clientWidth + 1 || w.getClientRects().length > 1).map((w) => w.textContent));
      assert.deepEqual(cut, [], "no name is cut or broken");
      assert.equal(bar.overflowX, false);
      const library = bar.tabs.at(-1);
      assert.equal(library.id, "library"); assert.equal(library.controls, "library-home");
      assert.ok(library.left >= bar.tabs.at(-2).right - 0.5, "after Pips");
    } finally { await x.close(); }
  });
}
for (const width of [170, 220]) {
  test(`${width} px: the five tabs are icons, each as wide as the others, Library's among them`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 700 });
    try {
      const bar = await x.tabs(), shown = bar.tabs.filter((b) => b.shown);
      assert.equal(shown.length, 5);
      const widths = shown.map((b) => Math.round(b.width));
      assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `five tabs of one width: ${widths}`);
      const library = shown.at(-1);
      assert.equal(library.id, "library"); assert.equal(library.icons, 1, "Library is an icon");
      assert.ok(library.right <= bar.bar.right + 0.5 && library.height === shown[0].height);
      const word = await x.page.evaluate(() => { const w = document.querySelector("#side-tab-library .dgc-tab-word").getBoundingClientRect(); return [w.width, w.height]; });
      assert.ok(word[0] <= 1.5 && word[1] <= 1.5, "its word is kept for a screen reader only");
      assert.equal(bar.overflowX, false);
    } finally { await x.close(); }
  });
}
test("the Library tab: a click shows the Library page, the arrow keys reach it, and a reload comes back to it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { tab: "home", width: 300 });
  try {
    await x.page.click("#side-tab-library"); await x.settle();
    let bar = await x.tabs();
    assert.deepEqual(bar.tabs.filter((b) => b.selected).map((b) => b.id), ["library"]);
    assert.equal(bar.panel, "library-home"); assert.equal(bar.panelRole, "tabpanel"); assert.equal(bar.panelLabelledBy, "side-tab-library");
    assert.equal((await x.kept()).sideTab, "library", "kept for a reload");
    await x.page.focus("#side-tab-library"); await x.page.keyboard.press("ArrowLeft"); await x.settle();
    bar = await x.tabs(); assert.deepEqual(bar.tabs.filter((b) => b.selected).map((b) => b.id), ["pips"], "Left of Library is Pips");
    await x.page.keyboard.press("End"); await x.settle();
    bar = await x.tabs(); assert.deepEqual(bar.tabs.filter((b) => b.selected).map((b) => b.id), ["library"], "End is Library");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  const again = await openLibraryTab(browser, { saved: { sideTab: "library" }, width: 300 });
  try { assert.equal((await again.tabs()).panel, "library-home", "it opens on the Library again"); assert.ok((await again.lib()).rows.length > 0); } finally { await again.close(); }
});

// ---- 1b. Home's top row -------------------------------------------------------------------------------------------------
for (const width of [170, 300, 700]) {
  test(`Home at ${width} px: a Library button beside Cards, the same shape, and it opens the Library tab`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width, theme: "dark-modern", layout: ["needs", "recent", "clock"], height: 700 });
    try {
      await x.rest(300);
      const row = await x.page.evaluate(() => {
        const at = (n) => { if (!n) return null; const r = n.getBoundingClientRect(), s = getComputedStyle(n); return { left: r.left, right: r.right, top: r.top, h: r.height, w: r.width, radius: s.borderTopLeftRadius, border: s.borderTopWidth + " " + s.borderTopColor, ground: s.backgroundColor, font: s.font,
          words: [...n.childNodes].filter((c) => c.nodeType === 3 || c.matches?.(".hc-btn-word")).map((c) => c.textContent).join("").trim(), label: n.getAttribute("aria-label") || n.textContent.trim(), cut: n.scrollWidth > n.clientWidth + 1 }; };
        return { library: at(document.querySelector("#home-hub .hc-head .hc-library-btn")), cards: at(document.querySelector("#home-hub .hc-head .hc-cards-btn")), sideways: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(row.library, "Home's top row has a Library button");
      assert.match(row.library.label, /Library/);
      assert.ok(row.library.right <= row.cards.left && row.cards.left - row.library.right <= 12, "beside Cards, before it");
      assert.equal(Math.round(row.library.top), Math.round(row.cards.top));
      for (const key of ["h", "radius", "border", "ground", "font"]) assert.equal(row.library[key], row.cards[key], `the same ${key} as Cards`);
      assert.equal(row.library.cut, false); assert.equal(row.cards.cut, false); assert.equal(row.sideways, false);
      await x.page.click("#home-hub .hc-library-btn"); await x.rest(250);
      assert.equal((await x.tabs()).panel, "library-home", "it opens the Library tab");
    } finally { await x.close(); }
  });
}

// ---- 2. the page --------------------------------------------------------------------------------------------------------
for (const theme of ["dark-modern", "light-modern"]) for (const width of [170, 300, 440]) {
  test(`the Library page: “Library”, ⋯ at the right, a line, the search field, one filter line, then the rows (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openLibraryTab(browser, { width, theme });
    try {
      const h = await x.page.evaluate(() => {
        const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, h: r.height, w: r.width }; };
        const section = document.getElementById("library-home"), header = section.querySelector(".home-head"), title = header.querySelector(".home-title"), dots = document.getElementById("library-more"), s = getComputedStyle(header);
        const filters = document.getElementById("library-filters"), list = document.getElementById("library-list");
        const work = getComputedStyle(document.querySelector("#work-home .home-head"));
        return { first: section.firstElementChild === header, header: box(header), title: { ...box(title), text: title.textContent.trim(), tag: title.tagName }, dots: { ...box(dots), radius: parseFloat(getComputedStyle(dots).borderTopLeftRadius), label: dots.getAttribute("aria-label") },
          line: parseFloat(s.borderBottomWidth), sameAsWork: s.borderBottomColor === work.borderBottomColor && s.font === work.font, search: box(document.getElementById("library-search")), filters: box(filters),
          buttons: [...filters.querySelectorAll("button")].map((b) => ({ ...box(b), radius: parseFloat(getComputedStyle(b).borderTopLeftRadius), text: b.textContent.replace(/\s+/g, " ").trim() })), list: box(list), sideways: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(h.first, true); assert.equal(h.title.text, "Library"); assert.equal(h.title.tag, "H2");
      assert.ok(h.title.left - h.header.left <= 16, "the name is at the left");
      assert.ok(h.header.right - h.dots.right <= 16 && h.dots.left >= h.title.right, "⋯ is at the right");
      assert.ok(h.dots.h >= 24 && h.dots.h <= 30 && Math.abs(h.dots.w - h.dots.h) <= 1 && h.dots.radius >= 4 && h.dots.radius <= 10, "⋯ is a square button of the family");
      assert.ok(h.line >= 1, "a line under the row"); assert.equal(h.sameAsWork, true, "the row is Work's and Chat's");
      assert.ok(h.search.top >= h.header.bottom, "the search field is under the line");
      assert.ok(h.filters.top >= h.search.bottom && h.list.top >= h.filters.bottom, "the filter line is between the search field and the rows");
      assert.equal(h.buttons.length, 2, "two filters: the type and who made it");
      assert.ok(Math.abs(h.buttons[0].top - h.buttons[1].top) < 1, "on one line");
      for (const b of h.buttons) { assert.ok(b.radius >= 4 && b.radius <= 10, `a button of the family, never a pill (${b.radius})`); assert.ok(b.h >= 24 && b.h <= 30, `a standard height (${b.h})`); assert.ok(b.right <= h.filters.right + 0.5); }
      assert.match(h.buttons[0].text, /All$/); assert.match(h.buttons[1].text, /Anyone$/);
      assert.equal(h.sideways, false);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("each row: a preview or the type's sheet, the title, and “made by <name> · <when>”; with no name, the kind only", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 440 });
  try {
    const l = await x.lib(), by = (title) => l.rows.find((r) => r.title === title);
    assert.equal(l.rows.length, 13, "nine artifacts, three files and one of Work's images");
    assert.equal(l.rows[0].title, "Open invoices by month", "the newest first");
    assert.match(by("Tide pool walk, Saturday").meta, /^made by Tile checker · \d+m$/);
    assert.equal(by("Tide pool walk, Saturday").makerIs, "BUTTON", "the name is a link back");
    assert.match(by("Acme sales sheet").meta, /^made by Fix totals · 2h$/);
    assert.match(by("Launch notes").meta, /^made by Rent or buy: the numbers · 1d$/);
    assert.match(by("Tip calculator").meta, /^made in Work · /); assert.equal(by("Tip calculator").maker, "", "no name: no link");
    assert.match(l.rows.at(-1).meta, /^made in the terminal · /);
    assert.match(by("Beach map.png").meta, /^made by A week in Goa in March · /);
    assert.match(by("Billing review.pdf").meta, /^in Rent or buy: the numbers · /, "a file you attached was not made by the chat");
    assert.match(by("ferry-times.csv").meta, /^in Goa trip · /);
    assert.match(by("hero-tiles.png").meta, /^made in Work · /);
    assert.equal(by("Acme sales sheet").thumb, "sheet", "the type's sheet"); assert.equal(by("Acme sales sheet").type, "sheet");
    assert.equal(by("Beach map.png").thumb, "img", "a picture shows itself"); assert.equal(by("hero-tiles.png").thumb, "img");
    assert.equal((await x.said("image")).length, 1); assert.equal((await x.said("workImage")).length, 1);
    // One line each, the long title ends in "…".
    const long = await x.page.evaluate(() => { const n = [...document.querySelectorAll("#library-list .lib-row-name")].find((e) => e.textContent.startsWith("A page with a name")); const s = getComputedStyle(n); return { dots: s.textOverflow, lines: n.getClientRects().length, over: n.scrollWidth > n.clientWidth }; });
    assert.deepEqual(long, { dots: "ellipsis", lines: 1, over: true });
  } finally { await x.close(); }
});

test("the type filter: All, Pages, Sheets, Docs, Decks, Dashboards, Widgets, Images, Files; Widgets are the Pages a widget or a card made", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 300 });
  try {
    const rows = await x.menu("type");
    assert.deepEqual(rows.map((r) => r.label), ["All", "Pages", "Sheets", "Docs", "Decks", "Dashboards", "Widgets", "Images", "Files"]);
    assert.deepEqual(rows.filter((r) => r.checked).map((r) => r.label), ["All"]);
    assert.equal(await x.page.getAttribute("#library-type", "aria-expanded"), "true");
    const titles = async () => (await x.lib()).rows.map((r) => r.title).sort();
    await x.pick("type", "Widgets");
    assert.equal((await x.lib()).type, "Widgets");
    assert.deepEqual(await titles(), ["Open invoices by month", "Weekly signups"]);
    await x.pick("type", "Pages"); assert.equal((await titles()).length, 5, "every Page, the widgets' among them");
    await x.pick("type", "Sheets"); assert.deepEqual(await titles(), ["Acme sales sheet"]);
    await x.pick("type", "Docs"); assert.deepEqual(await titles(), ["Launch notes"]);
    await x.pick("type", "Decks"); assert.deepEqual(await titles(), ["Q3 plan"]);
    await x.pick("type", "Dashboards"); assert.deepEqual(await titles(), ["Store sales"]);
    await x.pick("type", "Images"); assert.deepEqual(await titles(), ["Beach map.png", "hero-tiles.png"]);
    await x.pick("type", "Files"); assert.deepEqual(await titles(), ["Billing review.pdf", "ferry-times.csv"]);
    assert.equal((await x.kept()).library.type, "file", "the filter is kept for a reload");
    await x.pick("type", "All"); assert.equal((await titles()).length, 13);
    // Escape closes the menu and the keyboard goes back to the filter.
    await x.menu("type"); await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(250);
    assert.equal(await x.page.evaluate(() => document.activeElement?.id), "library-type");
  } finally { await x.close(); }
});

test("the maker filter: Anyone, Work, Chat, Pips, then each Pip, session and chat by name (from made_by)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 300 });
  try {
    const rows = await x.menu("maker");
    assert.deepEqual(rows.map((r) => r.head ? `# ${r.head}` : r.label), ["Anyone", "Work", "Chat", "Pips", "# Pips", "Morning brief", "Tile checker", "# Work sessions", "Fix totals", "# Chats", "A week in Goa in March", "Rent or buy: the numbers"]);
    const titles = async () => (await x.lib()).rows.map((r) => r.title).sort();
    await x.pick("maker", "Tile checker");
    assert.equal((await x.lib()).maker, "Tile checker");
    assert.deepEqual(await titles(), ["Open invoices by month", "Tide pool walk, Saturday"]);
    await x.pick("maker", "Pips"); assert.deepEqual(await titles(), ["Open invoices by month", "Store sales", "Tide pool walk, Saturday"]);
    await x.pick("maker", "Work"); assert.deepEqual(await titles(), ["Acme sales sheet", "Tip calculator", "hero-tiles.png"]);
    await x.pick("maker", "Fix totals"); assert.deepEqual(await titles(), ["Acme sales sheet"]);
    await x.pick("maker", "Chat"); assert.equal((await titles()).length, 6, "what the chats made, and the files in them");
    // The two filters together, and a filter that finds nothing says so in words.
    await x.pick("type", "Sheets");
    assert.deepEqual(await titles(), []); assert.match((await x.lib()).status, /No sheets made in Chat/i);
    await x.pick("maker", "Anyone"); assert.deepEqual(await titles(), ["Acme sales sheet"]);
    // A long maker's name beside the longest type: the type's word stays whole, the name ends in "…".
    await x.pick("type", "Dashboards"); await x.pick("maker", "Rent or buy: the numbers");
    const cut = await x.page.evaluate(() => Object.fromEntries(["type", "maker"].map((k) => { const v = document.querySelector(`#library-${k} .dgc-folder-v`); return [k, v.scrollWidth > v.clientWidth + 1]; })));
    assert.equal(cut.type, false, "“Dashboards” is whole"); assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  } finally { await x.close(); }
});

test("the search field finds by title and by who made it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 300 });
  try {
    await x.page.fill("#library-search", "sales"); await x.page.waitForTimeout(250);
    assert.deepEqual((await x.lib()).rows.map((r) => r.title).sort(), ["Acme sales sheet", "Store sales"]);
    await x.page.fill("#library-search", "tile checker"); await x.page.waitForTimeout(250);
    assert.equal((await x.lib()).rows.length, 2);
    await x.page.fill("#library-search", "zzzz"); await x.page.waitForTimeout(250);
    assert.match((await x.lib()).status, /Nothing named like “zzzz”/);
    assert.equal(await x.page.getAttribute("#library-search", "placeholder"), "Search the Library");
  } finally { await x.close(); }
});

test("a row opens its item in an editor tab; the maker's name leads back to the Pip's chat, the session or the chat", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 440 });
  try {
    const row = (title) => x.page.locator("#library-list .lib-row", { hasText: title }).first();
    await row("Acme sales sheet").locator(".lib-row-name").click(); await x.page.waitForTimeout(80);
    let opened = await x.said("artifactOpen");
    assert.equal(opened.length, 1); assert.equal(opened[0].artifact.id, ar(2)); assert.equal(opened[0].artifact.type, "sheet");
    // A document carries its file, so it opens in the editor without asking first.
    await row("Launch notes").focus(); await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(80);
    opened = await x.said("artifactOpen"); assert.equal(opened.at(-1).artifact.id, ar(3)); assert.match(opened.at(-1).artifact.file, /Launch notes\.md$/);
    await row("hero-tiles.png").locator(".lib-row-name").click(); await x.page.waitForTimeout(80);
    assert.deepEqual((await x.said("workImageOpen")).map((m) => m.path), ["/home/me/shop/assets/hero-tiles.png"]);
    await row("Billing review.pdf").locator(".lib-row-name").click(); await x.page.waitForTimeout(80);
    assert.equal((await x.said("open")).at(-1).file.name, "Billing review.pdf", "a chat's file opens where it is");
    // The maker's name: a session, a chat, a Pip. None of them opens the item too.
    const before = (await x.said("artifactOpen")).length;
    await row("Acme sales sheet").locator(".lib-row-maker").click(); await x.page.waitForTimeout(80);
    assert.deepEqual((await posted(x, "openSessionInEditor")).map((m) => [m.id, m.title]), [[SESSION, "Fix totals"]]);
    await row("Launch notes").locator(".lib-row-maker").click(); await x.page.waitForTimeout(80);
    assert.deepEqual((await posted(x, "chatdgcOpen")).map((m) => m.id), [CHAT]);
    assert.equal((await x.said("artifactOpen")).length, before, "the name is its own link");
    await row("Tide pool walk, Saturday").locator(".lib-row-maker").click(); await x.settle(); await x.page.waitForTimeout(300);
    const bar = await x.tabs();
    assert.deepEqual(bar.tabs.filter((b) => b.selected).map((b) => b.id), ["pips"], "the Pip's chat is on the Pips tab");
    assert.ok((await x.page.evaluate(() => window.__navigated || [])).some((n) => n && n.pip === "pip_" + "b".repeat(32)) || await x.page.evaluate((id) => (window.__posted || []).some((m) => JSON.stringify(m).includes(id)), TILE), "the Pips view was asked for that Pip");
  } finally { await x.close(); }
});

test("⋯ holds “Open the full Library” and the settings; Work and Chat keep no Library", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 300 });
  try {
    await x.page.click("#library-more"); await x.page.waitForTimeout(350);
    const rows = await x.page.evaluate(() => [...document.querySelectorAll(".dgc-pop [role^='menuitem']")].map((r) => r.textContent.trim()));
    assert.deepEqual(rows, ["Open the full Library", "Page preview settings"]);
    await x.page.getByRole("menuitem", { name: "Open the full Library" }).click(); await x.page.waitForTimeout(150);
    assert.deepEqual(await posted(x, "homeLibraryOpen"), [{ type: "homeLibraryOpen", view: "artifacts" }]);
    await x.page.click("#library-more"); await x.page.waitForTimeout(350);
    await x.page.getByRole("menuitem", { name: "Page preview settings" }).click(); await x.page.waitForTimeout(150);
    assert.deepEqual((await posted(x, "openSettings")).map((m) => m.section), ["security"]);
    assert.equal(await x.page.locator("#work-library, #chats-library").count(), 0, "no Library button in Work or Chat");
    assert.deepEqual([...(await posted(x, "workLibrary")), ...(await posted(x, "chatdgcLibrary"))], []);
  } finally { await x.close(); }
});

test("what changes is seen: an artifact made while the Library shows is listed, one removed goes, and a DGC with no artifacts says so", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 300 });
  try {
    const asked = (await x.said("artifactList")).length;
    assert.ok(asked >= 1, "the page asked for the artifacts");
    await x.page.evaluate((next) => { window.__lib.artifacts = [next, ...window.__lib.artifacts]; }, { ...LIB_ARTIFACTS[1], id: ar(0), title: "Made just now", updated: new Date().toISOString() });
    await x.send({ type: "sideLibrary", message: { type: "artifactChanged", artifact: { id: ar(0) }, op: "created" } }); await x.page.waitForTimeout(200);
    assert.equal((await x.lib()).rows[0].title, "Made just now");
    await x.send({ type: "sideLibrary", message: { type: "artifactRemoved", id: ar(0) } }); await x.page.waitForTimeout(100);
    assert.ok(!(await x.lib()).rows.some((r) => r.title === "Made just now"));
    // Shown again, it asks again.
    await x.page.click("#side-tab-work"); await x.settle(); await x.page.click("#side-tab-library"); await x.settle(); await x.page.waitForTimeout(100);
    assert.ok((await x.said("artifactList")).length > asked + 1, "the tab shown again asks again");
  } finally { await x.close(); }
  const none = await openLibraryTab(browser, { width: 300, artifacts: [], files: [], images: [] });
  try { const l = await none.lib(); assert.deepEqual(l.rows, []); assert.match(l.status, /Nothing here yet/); } finally { await none.close(); }
});

test("at 170 px a row keeps its preview, its title on one line ending in “…” and its maker line; nothing runs off sideways", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 170 });
  try {
    const l = await x.lib();
    assert.equal(l.sideways, false);
    for (const r of l.rows) { assert.ok(r.right <= 170.5 && r.left >= -0.5, `${r.title} is inside the side bar`); assert.ok(r.h <= 52, `${r.title} is one row (${r.h}px)`); }
    const lines = await x.page.evaluate(() => [...document.querySelectorAll("#library-list .lib-row-name, #library-list .lib-row-meta")].filter((n) => n.getClientRects().length > 1 || n.getBoundingClientRect().height > 22).map((n) => n.textContent));
    assert.deepEqual(lines, [], "each of a row's two lines is one line");
  } finally { await x.close(); }
});

// ---- the polish pass's measuring stick (test/support/polish-audit.mjs) on the new page ----------------------------------
const { audit, focusAudit } = await import("./support/polish-audit.mjs");
const lines = (list) => list.map((x) => `${x.what} “${x.text || x.title || ""}” ${x.ratio ?? x.corner ?? x.by ?? ""}`.trim());
for (const theme of ["dark-modern", "light-modern"]) for (const width of [170, 300, 700]) {
  test(`the Library page and the tab bar read at 4.5:1 or more, with no pill, nothing covered or off the page, and a focus ring on every control (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openLibraryTab(browser, { width, theme });
    try {
      await x.page.mouse.move(1, 1); await x.settle();
      for (const scope of ["#library-home", "#side-tabs"]) {
        const a = await x.page.evaluate(audit, { scope });
        // (A sheet's own tag is a picture of a file's kind, drawn by media/shared/filesheet.js at its own tones.)
        assert.deepEqual(lines(a.contrast.filter((c) => !/dgc-sheet/.test(c.what))), [], `${scope}: every word at 4.5:1`);
        assert.deepEqual(lines(a.pills), [], `${scope}: no pill`);
        // (The dock floats over a long list mid-scroll, as over every tab; the list's end clears it: side-tabs-home.test.mjs.)
        assert.deepEqual(lines(a.covered.filter((c) => !/dgc-dock/.test(c.by))), [], `${scope}: nothing lies over a control`);
        assert.deepEqual(lines(a.offscreen), [], `${scope}: nothing is off the page`);
        assert.equal(a.overflowX, 0);
      }
      await x.page.keyboard.press("Shift");
      const f = await x.page.evaluate(focusAudit, { scope: "#library-home" });
      assert.ok(f.walked >= 6, `the controls were walked (${f.walked})`);
      assert.deepEqual(f.missing.map((m) => `${m.what} “${m.text}”`), [], "every control shows where the keyboard is");
      assert.deepEqual(f.cut.map((c) => `${c.what} “${c.text}”: ${c.lost}px of its ring is cut by ${c.by}`), []);
    } finally { await x.close(); }
  });
}
test("touch: every control of the Library page is in sight without a pointer, and the maker's name says it can be pressed", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 300, touch: true });
  try {
    const a = await x.page.evaluate(audit, { scope: "#library-home", touch: true });
    assert.deepEqual(lines(a.unseen), []);
    const line = await x.page.evaluate(() => getComputedStyle(document.querySelector("#library-list button.lib-row-maker")).textDecorationColor);
    assert.notEqual(line, "rgba(0, 0, 0, 0)", "a quiet underline where nothing can be pointed at");
  } finally { await x.close(); }
});
test("scrolled to its end, the Library's last row is clear of the dock", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 300, height: 520 });
  try {
    await x.page.evaluate(() => { const host = document.getElementById("sessions-host"); host.scrollTop = host.scrollHeight; }); await x.settle();
    const at = await x.page.evaluate(() => { const last = [...document.querySelectorAll("#library-list .lib-row")].at(-1).getBoundingClientRect(), bar = document.querySelector("#dgc-dock .dgc-dock-bar").getBoundingClientRect(); return { row: last.bottom, dock: bar.top }; });
    assert.ok(at.row <= at.dock + 0.5, `the last row ends at ${at.row}, the dock begins at ${at.dock}`);
  } finally { await x.close(); }
});
