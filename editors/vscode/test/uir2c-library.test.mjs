// The Library lists the charts ChatDGC's replies drew (Widgets) and what you attached in Work sessions (Files), 16 Nov.
// In real Chromium: the real side bar and the page src/chatdgc.ts serves in an editor tab, on the stand-in host of
// library-scene.mjs (the host's own side, src/chatdgc.ts, is in chatdgc-tabs.test.mjs: "uir2c: …").
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openLibraryTab, openLibraryPage, LIB_CHARTS, LIB_WORK_FILES, LIB_FILES } from "./support/library-scene.mjs";

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
const closeIt = (x) => (x.close ? x.close() : x.page.close());
const CORE = ["Open", "Open in editor", "Save a copy…", "Copy", "Copy path", "Reveal in file manager", "Rename…", "Remove…"];
/** The open menu's rows: [words, off?, why]. */
const menuNow = (page) => page.evaluate(() => [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].map((r) => [r.querySelector(".dgc-menu-label")?.textContent.trim() || r.textContent.trim(), r.getAttribute("aria-disabled") === "true", r.getAttribute("title") || r.dataset.tip || ""]));
const rowMenu = async (x, key) => { await x.page.locator(`.lib-row[data-key="${key}"]`).click({ button: "right", position: { x: 60, y: 12 } }); await x.page.waitForTimeout(350); return menuNow(x.page); };
const chartKey = (c) => `chart:${c.chat_id}:${c.id}`, workKey = (f) => `workfile:${f.ref}`;

for (const [place, width] of [["side", 300], ["side", 440], ["tab", 700]]) {
  test(`${place} ${width}px: Widgets lists the charts ChatDGC's replies drew, each "A chart in" its chat with a chart mark, newest first among the widgets`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width, charts: LIB_CHARTS });
    try {
      await x.libTab("widgets");
      const lib = await x.lib(), charts = lib.rows.filter((r) => r.type === "chart");
      assert.deepEqual(charts.map((r) => r.title), ["Frost rating by tile", "Rent against buying, year by year", "Chart"], "the three charts, by their titles");
      assert.equal(lib.rows[0].title, "Open invoices by month", "premise: a card made 15 minutes ago is first");
      assert.equal(lib.rows[1].title, "Frost rating by tile", "the chart of 20 minutes ago is next: newest first, among the widgets");
      assert.ok(lib.rows.findIndex((r) => r.title === "Trip budget calculator") < lib.rows.findIndex((r) => r.title === "Rent against buying, year by year"), "a widget of five hours ago is before a chart of two days ago");
      assert.match(charts[0].meta, /^A chart in A week in Goa in March · 20m/, "it says where it is");
      assert.equal(charts[0].maker, "A week in Goa in March"); assert.equal(charts[0].makerIs, "BUTTON", "and its chat's name leads back to the chat");
      const mark = await x.page.evaluate(() => { const row = document.querySelector('.lib-row[data-type="chart"]'), m = row.querySelector(".lib-row-thumb .lib-chart-mark"), r = m?.getBoundingClientRect();
        return m ? { w: Math.round(r.width), h: Math.round(r.height), bars: m.querySelectorAll("rect, path").length } : null; });
      assert.ok(mark && mark.w >= 16 && mark.h >= 16 && mark.bars >= 3, `a chart mark is drawn (${JSON.stringify(mark)})`);
      assert.equal((await x.said("charts")).length, 1, "asked for once");
      assert.deepEqual(x.errors, []);
    } finally { await closeIt(x); }
  });
}

test("a chart is searched by its title with the widgets; Show more draws the next page; Open asks the host for that chart and names nothing else", async (t) => {
  if (skipOrFail(t)) return;
  const many = Array.from({ length: 5 }, (_, i) => ({ ...LIB_CHARTS[0], id: `${LIB_CHARTS[0].message_id}:${i}`, title: `Tide heights, week ${i + 1}`, created_at: `ago:${30 + i}` }));
  const x = await open("side", { width: 360, charts: many, pageSize: 3, widgets: [] , artifacts: [] });
  try {
    await x.libTab("widgets");
    assert.equal((await x.lib()).rows.length, 3, "the first page"); assert.equal((await x.lib()).load, true, "and Show more");
    await x.page.click("#library-load"); await x.rest(200);
    assert.equal((await x.lib()).rows.length, 5, "Show more draws the rest"); assert.equal((await x.lib()).load, false);
    assert.deepEqual((await x.said("charts")).map((m) => m.offset || 0), [0, 3]);
    await x.search("week 4");
    assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["Tide heights, week 4"], "found by its title");
    assert.equal((await x.said("charts")).at(-1).query, "week 4", "the host is asked with the words");
    await x.page.locator(".lib-row").first().click({ position: { x: 60, y: 12 } }); await x.rest(80);
    const act = (await x.said("itemAct")).at(-1);
    assert.deepEqual(act, { type: "itemAct", act: "open", item: { kind: "chart", id: `${LIB_CHARTS[0].message_id}:3`, chat_id: LIB_CHARTS[0].chat_id } }, "Open: the chart and its chat, by their ids alone");
    await x.search("no such chart");
    assert.equal((await x.lib()).status, "No widget named like “no such chart”.");
  } finally { await closeIt(x); }
});

test("a chart's menu is the Library's eight: Open is on (it opens its chat at the chart), the rest are off and say why", async (t) => {
  if (skipOrFail(t)) return;
  for (const place of ["side", "tab"]) {
    const x = await open(place, { width: place === "side" ? 300 : 900, charts: LIB_CHARTS });
    try {
      await x.libTab("widgets");
      const rows = await rowMenu(x, chartKey(LIB_CHARTS[0]));
      assert.deepEqual(rows.slice(0, 8).map((r) => r[0]), CORE, place);
      assert.deepEqual(rows.slice(0, 8).map((r) => r[1]), [false, true, true, true, true, true, true, true], `${place}: only Open is on`);
      for (const r of rows.slice(1, 8)) assert.ok(r[2].length > 12, `${place}: “${r[0]}” says why (${r[2]})`);
      assert.match(rows[7][2], /part of its reply/, "Remove: a chart is part of its reply");
      assert.equal(rows.length, 8, "nothing more: a chart is its reply's");
    } finally { await closeIt(x); }
  }
});

test("an older DGC that lists no charts and no Work attachments is asked for neither, and the Library says what it said before", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("side", { width: 300, files: [], widgets: [], artifacts: [] });
  try {
    await x.libTab("widgets"); await x.rest(150);
    assert.equal((await x.lib()).rows.length, 0);
    assert.match((await x.lib()).status, /A chart in a chat stays in its chat\.$/, "Widgets' empty words, as before");
    await x.libTab("files"); await x.rest(150);
    assert.match((await x.lib()).status, /What you attach in a Work session stays in that session\./, "Files' empty words, as before");
    assert.deepEqual([(await x.said("charts")).length, (await x.said("workFiles")).length], [0, 0], "neither is asked for");
  } finally { await closeIt(x); }
});

for (const [place, width] of [["side", 300], ["side", 440], ["tab", 700]]) {
  test(`${place} ${width}px: Files lists what you attached in Work sessions beside ChatDGC's files, each saying where it came from`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(place, { width, workFiles: LIB_WORK_FILES });
    try {
      await x.libTab("files");
      const lib = await x.lib(), work = lib.rows.filter((r) => r.key.startsWith("workfile:"));
      assert.deepEqual(lib.rows.map((r) => r.title), ["Picture 1.png", "Beach map.png", "order_total.py", "Billing review.pdf", "supplier-prices.csv", "ferry-times.csv"], "ChatDGC's and Work's, newest first");
      assert.match(work[0].meta, /^in Work · Fix totals · shop · 8m/, "a picture: in Work, its session, its project, when");
      assert.equal(work[0].maker, "Fix totals"); assert.equal(work[0].makerIs, "BUTTON", "the session's name leads back to it");
      assert.match(work[1].meta, /^in Work · lime_tiles · 3h/, "a session with no name: in Work, its project"); assert.equal(work[1].maker, "");
      assert.match(work[2].meta, /^in Work · Read the price list and say which tiles went up/);
      assert.equal(work[0].thumb, "img", "a picture shows itself");
      const tips = await x.page.evaluate(() => [...document.querySelectorAll('.lib-row[data-key^="workfile:"]')].map((r) => r.getAttribute("aria-label")));
      assert.match(tips[0], /Picture 1\.png, in Work · Fix totals · shop/, "the whole line, with its project, for a screen reader");
      assert.match(tips[1], /order_total\.py, in Work · lime_tiles/);
      // The page never names a path: what it was given, and what it asks with, is the host's own name for each.
      const html = await x.page.evaluate(() => document.querySelector(".dgc-lib").outerHTML + JSON.stringify(window.__posted || []));
      assert.doesNotMatch(html, /\.dgc\/sessions|\/home\/me\/projects/, "no session file and no project path is in the page");
      assert.deepEqual(x.errors, []);
    } finally { await closeIt(x); }
  });
}

test("a Work attachment's menu: a picture opens, saves and copies; a file opens (in the editor too), saves, gives its path and shows in its folder; neither is renamed or removed", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("tab", { width: 900, workFiles: LIB_WORK_FILES, secure: true });
  try {
    await x.libTab("files");
    const pic = await rowMenu(x, workKey(LIB_WORK_FILES[0]));
    assert.deepEqual(pic.slice(0, 8).map((r) => r[0]), CORE);
    assert.deepEqual(pic.slice(0, 8).map((r) => r[1]), [false, true, false, false, true, true, true, true], "a picture: Open, Save a copy…, Copy");
    assert.match(pic[4][2], /kept inside its session/, "Copy path says why not"); assert.match(pic[7][2], /stays in its session/, "Remove says why not");
    await x.page.keyboard.press("Escape"); await x.rest(120);
    const file = await rowMenu(x, workKey(LIB_WORK_FILES[1]));
    assert.deepEqual(file.slice(0, 8).map((r) => r[1]), [false, false, false, true, false, false, true, true], "a file: Open, Open in editor, Save a copy…, Copy path, Reveal");
    await x.page.locator(".dgc-pop .dgc-menu-row", { hasText: "Copy path" }).click(); await x.rest(80);
    assert.deepEqual((await x.said("itemAct")).at(-1), { type: "itemAct", act: "path", item: { kind: "workfile", ref: LIB_WORK_FILES[1].ref } }, "asked the one way, by the host's own name for it");
    // A click on the row opens it; Save a copy… and the quick button ask the same way.
    await x.page.locator(`.lib-row[data-key="${workKey(LIB_WORK_FILES[0])}"] .lib-row-name`).click(); await x.rest(80);
    assert.deepEqual((await x.said("itemAct")).at(-1), { type: "itemAct", act: "open", item: { kind: "workfile", ref: LIB_WORK_FILES[0].ref } });
    await x.page.locator(`.lib-row[data-key="${workKey(LIB_WORK_FILES[0])}"] [data-act="save"]`).click(); await x.rest(80);
    assert.deepEqual((await x.said("itemAct")).at(-1), { type: "itemAct", act: "save", item: { kind: "workfile", ref: LIB_WORK_FILES[0].ref } });
  } finally { await closeIt(x); }
});

test("Files' filters and search take Work's attachments too: a kind, where it came from, and its name", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("side", { width: 360, workFiles: LIB_WORK_FILES });
  try {
    await x.libTab("files");
    await x.pick("kind", "Images");
    assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["Picture 1.png", "Beach map.png"], "Images: Work's picture and ChatDGC's");
    await x.pick("kind", "All"); await x.pick("origin", "Made by ChatDGC");
    assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["Beach map.png"], "made by ChatDGC: nothing you attached");
    await x.pick("origin", "Uploaded");
    assert.ok((await x.lib()).rows.some((r) => r.title === "order_total.py"), "uploaded: what you attached in Work is there");
    await x.pick("origin", "All"); await x.search("order");
    assert.deepEqual((await x.lib()).rows.map((r) => r.title), ["order_total.py"]);
    assert.equal((await x.said("workFiles")).at(-1).query, "order", "the host is asked with the words");
    const kinds = await x.menu("kind");
    assert.ok(kinds.some((k) => k.label === "Code"), "a kind only Work's attachments have is offered");
  } finally { await closeIt(x); }
});

test("with Work's attachments listed, an empty Files says they show here; the tab's own label says so too", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("side", { width: 300, files: [], workFiles: [] });
  try {
    await x.libTab("files"); await x.rest(150);
    const lib = await x.lib();
    assert.equal(lib.status, "Files you attach in ChatDGC or in a Work session, and files in your spaces, show here. Incognito chats keep none.");
    assert.doesNotMatch(lib.status, /stays in that session/);
    assert.match(lib.tabs.find((t) => t.id === "files").tip, /attached in ChatDGC or in a Work session/);
  } finally { await closeIt(x); }
});

// His call (16 Nov): charts stay in the Library's Widgets, with a Kind filter, and are never on Home's Widgets card.
test("Widgets' Kind: All shows the widgets and the charts, Widgets the widgets alone, Charts the charts alone; with no charts listed there is no Kind", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("side", { width: 300, charts: LIB_CHARTS });
  try {
    await x.libTab("widgets"); await x.rest(150);
    const all = (await x.lib()).rows, ids = (list) => list.map((r) => r.title);
    assert.ok(all.some((r) => r.type === "chart") && all.some((r) => r.type !== "chart"), `premise: both kinds are listed (${ids(all).join(", ")})`);
    const kind = (await x.lib()).filters.find((f) => f.id === "kind");
    assert.ok(kind, "a Kind filter beside By"); assert.equal(kind.value, "All");
    assert.deepEqual((await x.menu("kind")).map((k) => k.label), ["All", "Widgets", "Charts"]);
    await x.pick("kind", "Charts");
    assert.deepEqual(ids((await x.lib()).rows), ids(all.filter((r) => r.type === "chart")), "Charts: the charts alone");
    await x.pick("kind", "Widgets");
    assert.deepEqual(ids((await x.lib()).rows), ids(all.filter((r) => r.type !== "chart")), "Widgets: the widgets and cards alone");
    await x.search("frost");
    assert.equal((await x.lib()).rows.length, 0, "the chart named Frost is not a widget");
    assert.match((await x.lib()).status, /^No widget named like “frost” with these filters\.$/);
    await x.search(""); await x.pick("kind", "All");
    assert.deepEqual(ids((await x.lib()).rows), ids(all), "All: both again, in the same order");
    assert.deepEqual(x.errors, []);
  } finally { await closeIt(x); }
  const older = await open("side", { width: 300, files: [], widgets: [], artifacts: [] });
  try {
    await older.libTab("widgets"); await older.rest(150);
    assert.deepEqual((await older.lib()).filters.map((f) => f.id), ["maker"], "a DGC that lists no charts: every row is a widget, so no Kind");
  } finally { await closeIt(older); }
});
