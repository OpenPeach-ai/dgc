// User-test round 1 (15 Nov), Home and the Library, in real Chromium on the real side bar page and with the real host
// code: H1 the Home badge counted things made that were already opened, and looked like "things that need me"; H2 a
// card's quiet line was cut ("Dashboard made · v…"); H6 two folders with one name read as one folder with two counts;
// H7 Weather's first Add did nothing visible; H8 the dock over the end of a list; L2 a reply's card listed as a "Page"
// under Widgets; L3 Files didn't say it is ChatDGC's. (Home's counts are in chatdgc-tabs.test.mjs: "L2: Home's …".)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openHomeCards, grid, MADE, TWINS, PINS } from "./support/uir2b-scene.mjs";
import { openLibraryTab, LIB_ARTIFACTS, ar } from "./support/library-scene.mjs";
import { DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); cleanup(); });
const CALM = DOCK_SESSIONS.map((s) => ({ ...s, waiting: false, running: false, ask: undefined }));     // sessions with nothing waiting

test("H1: Home's number says which is which: quiet with only news, and its words name what needs you and what is new", async (t) => {
  if (skipOrFail(t)) return;
  const news = await openHomeCards(browser, { quiet: true, sessions: CALM });
  try {
    const b = await news.badge();
    assert.equal(b.text, "", "the four things made are new, not waiting: no number (16 Nov: the number is what needs you)");
    assert.equal(b.label, "Home: 4 new", "a screen reader hears that they are new, not waiting"); assert.equal(b.title, "4 new");
    assert.equal(b.newsOnly, true, "nothing waits for you: a quiet dot");
    const needs = await news.page.evaluate(() => document.querySelector('.hc-card[data-card="needs"]').innerText.replace(/\s+/g, " "));
    assert.match(needs, /Nothing needs you/, "and the Needs you card agrees with it");
  } finally { await news.page.close(); }
  const busy = await openHomeCards(browser);
  try {
    const b = await busy.badge();
    assert.match(b.label, /^Home: \d+ needs? you, \d+ new$/); assert.equal(b.newsOnly, false, "something waits: the number is the filled one");
    const [, needs, fresh] = /^Home: (\d+) needs? you, (\d+) new$/.exec(b.label).map(Number);
    assert.ok(fresh > 0, "premise: there are new things too"); assert.equal(String(needs), b.text, "the number is what needs you; the new things are in its words");
    assert.notEqual(b.ground, (await (async () => { const q = await openHomeCards(browser, { quiet: true, sessions: CALM }); try { return (await q.badge()).ground; } finally { await q.page.close(); } })()), "and the two are drawn apart");
  } finally { await busy.page.close(); }
});

test("H1 host: a thing made is no longer news on Home once it is opened anywhere (its card in the session, the Library)", async () => {
  const { provider, posted } = makeProvider();
  const kept = new Map();
  provider.context.globalState = { get: (k) => kept.get(k), update: async (k, v) => { if (v === undefined) kept.delete(k); else kept.set(k, JSON.parse(JSON.stringify(v))); } };
  provider.home = true;
  const hub = { listen(fn) { this.tell = fn; return { dispose() {} }; }, attach() {}, offers: () => ({ version: 1 }) };
  provider.useArtifacts(hub, true);
  const ID = "ar_" + "a".repeat(16), OTHER = "ar_" + "b".repeat(16);
  hub.tell({ type: "artifactChanged", artifact: { id: ID, type: "dashboard", title: "Orders", version: 1 }, op: "made", surface: "work" });
  hub.tell({ type: "artifactChanged", artifact: { id: OTHER, type: "sheet", title: "Budget", version: 1 }, op: "made", surface: "work" });
  const pages = () => posted.filter((m) => m.type === "homePages").at(-1).pages.map((p) => p.id);
  assert.deepEqual(pages().sort(), [ID, OTHER].sort(), "both are news on Home");
  const before = posted.length;
  hub.tell({ type: "artifactOpened", id: ID });           // its card's Open in the session's tab
  assert.deepEqual(pages(), [OTHER], "the opened one is gone from Home, and from Home's number");
  assert.deepEqual((kept.get("dgc.homePages") || []).map((p) => p.id), [OTHER], "and stays gone after a reload");
  hub.tell({ type: "artifactOpened", id: ID });
  assert.equal(posted.length, before + 1, "one that isn't on Home says nothing more");
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  test(`H2: a card's quiet line is never cut mid-word: it says as much as fits whole (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHomeCards(browser, { theme, width, quiet: true, sessions: CALM });
    try {
      // On the card itself (one row when it is small, a few when it is wider): the short way, whole.
      const onCard = await x.page.evaluate(() => [...document.querySelectorAll('.hc-grid .hc-card[data-card="recent"] :is(.hc-sub, .hc-rs, .hc-meta)')].filter((n) => /made|changed/.test(n.textContent)).map((n) => { const range = document.createRange(); range.selectNodeContents(n);
        return { text: n.textContent, cut: range.getBoundingClientRect().width > n.getBoundingClientRect().width + 0.25 }; }));
      assert.ok(onCard.length >= 1, "the card names what was made");
      for (const l of onCard) assert.equal(l.cut, false, `on the card, “${l.text}” is whole`);
      // Opened (the card itself when it is small, View all when it is wider): each thing made is a card of its own.
      if (await x.page.locator('.hc-card[data-card="recent"] .hc-viewall').count()) await x.page.click('.hc-card[data-card="recent"] .hc-viewall'); else await x.page.click('.hc-card[data-card="recent"]');
      await x.rest(400);
      const made = (await x.lines()).filter((l) => l.key.startsWith("page:"));
      assert.equal(made.length, 4);
      for (const l of made) {
        assert.equal(l.cut, false, `“${l.text}” is whole (${l.name})`);
        assert.match(l.text, /^(Dashboard|Spreadsheet|Slides|Document) (made|changed)/, "it always says what was made");
        if (l.title) assert.ok(l.title.startsWith(l.text) && l.title.length > l.text.length, "a shortened line says the rest to a pointer");
      }
      if (width >= 700) assert.ok(made.every((l) => /version \d/.test(l.text)), "with room, the whole line");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("H6: two folders with one name each say where they are, under their count", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHomeCards(browser, { width: 440, layout: ["folders", "needs"], folders: TWINS, made: false });
  try {
    const tiles = await x.page.evaluate(() => [...document.querySelectorAll('.hc-card[data-card="folders"] .hc-tile')].map((t) => ({ name: t.dataset.name, sub: t.querySelector(".hc-tile-sub").textContent,
      cut: t.querySelector(".hc-tile-sub").scrollHeight > t.querySelector(".hc-tile-sub").clientHeight + 1, title: t.querySelector(".hc-tile-open").title })));
    assert.deepEqual(tiles.map((t) => [t.name, t.sub]), [["lime_tiles", "2 sessions · in usertest"], ["lime_tiles", "9 sessions · in pipshot"], ["garden-notes", "6 sessions"]]);
    assert.ok(tiles.every((t) => !t.cut), "each tile's line is whole");
    assert.match(tiles[1].title, /~\/pipshot\/projects\/lime_tiles/, "and a pointer reads the whole path");
  } finally { await x.page.close(); }
});

for (const width of [300, 440]) test(`H7: Weather's button says a step is to come, and its place form opens in sight, with the keyboard in it (${width}px)`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHomeCards(browser, { width, height: 600, made: false });
  try {
    await x.page.click(".hc-cards-btn"); await x.rest(300);
    const add = x.page.locator('.hc-lib-item[data-card="weather"] .hc-add');
    assert.equal((await add.textContent()).trim(), "Add…"); assert.equal(await add.getAttribute("aria-label"), "Add Weather to Home: choose its place first");
    assert.equal((await x.page.locator('.hc-lib-item[data-card="clock"] .hc-add').textContent()).trim(), "Add", "a card that needs nothing more keeps Add");
    // As a person scrolling down to it has it: the button just above the list's lower edge.
    await x.page.evaluate(() => { const list = document.querySelector(".hc-lib-list"), b = document.querySelector('.hc-lib-item[data-card="weather"] .hc-add'); list.scrollTop += b.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom + 4; });
    await add.click(); await x.rest(300);
    const f = await x.page.evaluate(() => { const list = document.querySelector(".hc-lib-list").getBoundingClientRect(), item = document.querySelector('.hc-lib-item[data-card="weather"]'), field = item.querySelector(".hc-city"), r = (n) => n.getBoundingClientRect();
      return { top: list.top, bottom: list.bottom, item: [r(item).top, r(item).bottom], field: [r(field).top, r(field).bottom], save: r(item.querySelector(".hc-lib-act button")).bottom, focus: document.activeElement === field,
        said: document.querySelector("#home-hub [aria-live], .hc-live")?.textContent || "" }; });
    assert.ok(f.focus, "the keyboard is in the City field");
    assert.ok(f.item[0] >= f.top - 1 && f.save <= f.bottom + 1, `the whole form is in sight (${JSON.stringify(f)})`);
    assert.ok(f.bottom - f.field[1] >= 60 || f.item[0] - f.top <= 12, "with room under the field for the places it lists");
  } finally { await x.page.close(); }
});

for (const [name, opts] of [["two pinned", { pins: PINS.slice(0, 2) }], ["nothing pinned", { pins: [] }]]) for (const width of [300, 440, 700]) {
  test(`H8: at the end of Home, and of Recent opened, the last thing is clear of the dock (${name}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHomeCards(browser, { width, height: 700, layout: grid.EVERY, ...opts });
    try {
      const home = await x.end();
      assert.ok(home.scrolls, "Home is longer than the side bar");
      assert.ok(home.dockTop === null || home.last <= home.dockTop, `the last card ends above the dock (${JSON.stringify(home)})`);
      await x.page.evaluate(() => { let sc = document.querySelector("#home-hub"); while (sc && sc.scrollHeight <= sc.clientHeight + 2) sc = sc.parentElement; if (sc) sc.scrollTop = 0; });
      await x.page.click('.hc-card[data-card="recent"]'); await x.rest(400);
      const recent = await x.end();
      assert.ok(recent.dockTop === null || recent.last <= recent.dockTop, `Recent's last row ends above the dock (${JSON.stringify(recent)})`);
    } finally { await x.page.close(); }
  });
}

test("L2: under Widgets a reply's card is a card, with a widget's mark: never a “Page” with a page's sheet", async (t) => {
  if (skipOrFail(t)) return;
  const card = { id: ar("c"), type: "page", title: "UK heat pump tariffs, 2026", version: 1, made_as: "card", origin: { surface: "work" }, made_by: { kind: "session", id: "s-1", name: "Do a deep research for me" }, created: "2026-11-15T05:10:00Z", updated: "2026-11-15T05:10:00Z" };
  const x = await openLibraryTab(browser, { artifacts: [...LIB_ARTIFACTS, card], width: 300 });
  try {
    const tab = async (name) => { await x.page.click(`.lib-tab[data-tab="${name}"]`); await x.page.waitForTimeout(250);
      return x.page.evaluate(() => [...document.querySelectorAll("#library-list .lib-row")].map((r) => ({ name: r.querySelector(".lib-row-name").textContent, tip: r.getAttribute("aria-label") || "", mark: r.querySelector(".lib-row-mark") ? "mark" : r.querySelector(".lib-row-sheet") ? "sheet" : "", label: r.getAttribute("aria-label") }))); };
    const widgets = await tab("widgets"), row = widgets.find((r) => r.name === card.title);
    assert.ok(row, "the card is under Widgets");
    assert.equal(row.mark, "mark", "wearing a widget's mark, not the Page sheet");
    assert.match(row.tip, /A reply’s card/); assert.doesNotMatch(row.tip, /\bPage\b/, "and never called a Page there");
    const artifacts = await tab("artifacts");
    assert.equal(artifacts.some((r) => r.name === card.title), false, "and not among the artifacts");
    assert.match(await x.page.evaluate(() => document.querySelector('.lib-tab[data-tab="widgets"]').title), /cards a reply drew in Work or a Pip's chat/);
  } finally { await x.page.close(); }
});

test("L3: an empty Files tab says whose files it lists, and where a Work session's attachment is", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { files: [], width: 300 });
  try {
    await x.page.click('.lib-tab[data-tab="files"]'); await x.page.waitForTimeout(300);
    const said = await x.page.evaluate(() => document.getElementById("library-status").textContent);
    assert.match(said, /Files you attach in ChatDGC, and files in your spaces, show here\. What you attach in a Work session stays in that session\./);
  } finally { await x.page.close(); }
});
