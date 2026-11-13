// "A page made" arrives on Home as a card (media/main.js, media/shared/hub.js and hub.css; the host keeps them in
// src/pipHomeDismiss.ts), measured in real Chromium on the side bar's real page (support/dock-scene.mjs), with the
// host's real keeper between what the artifacts say and what the page is told. What is held here:
//   - a page made in a Work session and a document made in a ChatDGC chat each arrive under "New", as a card of the
//     same size and style as the others: the sheet of its kind, its title, and "Page made · version 1 · <where>"
//   - a new version of the same thing updates its card and never adds one; removed takes it off
//   - it counts in Home's number and in Show: under Work or Chat by where it was made, under All only when nothing says
//   - Open opens it as the chat's card does and takes it off Home; Dismiss takes it off; both hold over a reload
//   - at most the newest 20 are kept
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { openDock, DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { homeContrast, homeState, CHATS } from "./support/home-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const settle = (page, ms = 60) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);

// ---- the host's keeper, as the extension runs it ----------------------------------------------------------------------
let keeper;
async function host() {
  keeper ||= import(`data:text/javascript;base64,${Buffer.from((await build({ entryPoints: [new URL("../src/pipHomeDismiss.ts", import.meta.url).pathname], bundle: true, write: false,
    platform: "node", format: "esm", external: ["vscode"] })).outputFiles[0].text).toString("base64")}`);
  const store = await keeper;
  const value = {}, context = { globalState: { value, get: (k) => value[k], update: async (k, v) => { if (v === undefined) delete value[k]; else value[k] = v; } } };
  return { store, context, value,
    /** What the artifacts said (artifacts.ts's "artifactChanged"), heard by the host: the page's message, or null when Home is as it was. */
    hear(message, now) { const pages = store.noteHomePage?.(context, message, now); return pages ? { type: "homePages", pages } : null; },
    /** What the page said back. */
    said(message) { return store.rememberHomePagesDismissed?.(context, message); },
    /** What a reload stamps on the page: the attribute's own JSON. */
    stamped() { const attr = store.homePagesAttr?.(context) || ""; const m = / data-home-pages="([^"]*)"/.exec(attr);
      return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : ""; } };
}
const AR = (n) => "ar_" + String(n).padStart(16, "0");
const KEY = (n) => `page:${AR(n)}`;
const WORK = DOCK_SESSIONS[0], WORK_NAME = "Fix the login redirect after sign-out", CHAT = CHATS[1];
const fromWork = { surface: "work", project: "/work/shop", session: WORK.id }, fromChat = { surface: "chat", chat: CHAT.id };
/** An artifact's change, as artifacts.ts tells every screen. */
const change = (n, type, title, origin, op = "made", version = 1) => ({ type: "artifactChanged", op, surface: origin?.surface || "", conversation_id: "",
  artifact: { id: AR(n), type, label: "", title, version, created: "2026-11-11T09:00:00Z", updated: "2026-11-11T09:00:00Z", origin: origin || {}, exports: ["html"] } });
/** The host hears it and tells the page what Home holds now. */
async function tell(x, h, message) { const out = h.hear(message); if (out) await x.send(out); await settle(x.page); return out; }
// (A thing made is news: since 13 Nov evening what is new is in Recent only, so Home opens here on Recent opened whole.)
const open = (options = {}) => openDock(browser, { tab: "home", state: homeState("quiet"), width: 300, height: 900, open: "recent", ...options });
const pages = (hub) => hub.cards.filter((c) => c.key.startsWith("page:"));
const homeCount = async (x) => Number((await x.tabs()).tabs.find((t) => t.id === "home").count || 0);

test("a page made in a Work session and a document made in a ChatDGC chat each arrive on Home as a card", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(), h = await host();
  try {
    const before = await x.hub(), n = await homeCount(x);
    assert.deepEqual(pages(before), [], "nothing made yet");
    await tell(x, h, change(1, "page", "Login redirect map", fromWork));
    await tell(x, h, change(2, "doc", "Rent or buy, in one page", fromChat));
    const hub = await x.hub(), made = pages(hub);
    assert.deepEqual(made.map((c) => c.key), [KEY(2), KEY(1)], "one card each, the newest first");
    assert.deepEqual(made.map((c) => c.group), ["new", "new"], 'under "New"');
    assert.deepEqual(made.map((c) => c.who), ["sheet:doc", "sheet:page"], "the output card's sheet of its kind, where a face or a blob would be");
    assert.deepEqual(made.map((c) => c.title), ["Rent or buy, in one page", "Login redirect map"], "its title");
    assert.deepEqual(made.map((c) => c.from), [`Document made · version 1 · ${CHAT.title}`, `Page made · version 1 · ${WORK_NAME}`], "what it is, its version, and the session or chat that made it");
    assert.deepEqual(made.map((c) => c.source), ["chat", "work"], "each from where it was made");
    assert.deepEqual(made.map((c) => c.actions), [["Open*", "Dismiss"], ["Open*", "Dismiss"]], "Open and Dismiss");
    assert.deepEqual(made.map((c) => c.chips), [["Chat", "Just now"], ["Work", "Just now"]]);
    // (Another card, measured where it shows: one that is new beside these, else one that needs you, in Needs you opened.)
    let other = hub.cards.find((c) => !c.key.startsWith("page:") && c.height > 0);
    if (!other) { await x.card("needs"); other = (await x.hub()).cards.find((c) => !c.key.startsWith("page:") && c.height > 0); await x.card("recent"); }
    assert.ok(other, "another card is on Home to compare with");
    for (const c of made) {
      assert.equal(c.shared && c.thin, true, "the shared card, thin");
      assert.equal(c.height, other.height, "the same height as the others");
      assert.equal(c.width, other.width, "the same width as the others");
      assert.equal(c.radius, other.radius); assert.equal(c.ground, other.ground);
    }
    assert.equal(await homeCount(x), n + 2, "both count in Home's number");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("version 2 updates the card and never adds one; removed takes it off", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(), h = await host();
  try {
    const n = await homeCount(x);
    await tell(x, h, change(1, "slides", "Q3 plan", fromWork));
    assert.deepEqual(pages(await x.hub()).map((c) => [c.key, c.from]), [[KEY(1), `Slides made · version 1 · ${WORK_NAME}`]]);
    await tell(x, h, change(1, "slides", "Q3 plan, final", fromWork, "changed", 2));
    assert.deepEqual(pages(await x.hub()).map((c) => [c.key, c.title, c.from]), [[KEY(1), "Q3 plan, final", `Slides changed · version 2 · ${WORK_NAME}`]], "the same card, at version 2");
    assert.equal(await homeCount(x), n + 1, "still one");
    // A change to something that has no card on Home (made long ago, or dismissed) adds none.
    assert.equal(await tell(x, h, change(7, "sheet", "Old budget", fromWork, "changed", 9)), null);
    assert.deepEqual(pages(await x.hub()).map((c) => c.key), [KEY(1)]);
    await tell(x, h, change(1, "slides", "Q3 plan, final", fromWork, "removed", 2));
    assert.deepEqual(pages(await x.hub()), [], "removed: its card is gone");
    assert.equal(await homeCount(x), n, "and Home's number with it");
    assert.deepEqual(h.value["dgc.homePages"], [], "the host forgot it too");
  } finally { await x.close(); }
});

// (Home's Show filter went on 13 Nov, when Home became cards: the cards you add are the filter. Its test went with it; test/home-cards.test.mjs holds that Show is gone.)

test("Open opens it as the chat's card does; Dismiss takes it off; both are kept across a reload of the side bar", async (t) => {
  if (skipOrFail(t)) return;
  const h = await host();
  let x = await open();
  try {
    await tell(x, h, change(1, "page", "Login redirect map", fromWork));
    await tell(x, h, change(2, "doc", "Rent or buy, in one page", fromChat));
    await tell(x, h, change(3, "slides", "Q3 plan", fromWork));
    await x.page.click(`.dgc-hub-card[data-key="${KEY(1)}"] [data-hub-act="open"]`); await settle(x.page);
    assert.deepEqual(await x.posted("artifactOpen"), [{ type: "artifactOpen", id: AR(1), artifactType: "page", title: "Login redirect map" }], "what the chat card's Open sends");
    assert.deepEqual(pages(await x.hub()).map((c) => c.key), [KEY(3), KEY(2)], "opened: no longer news");
    await x.page.click(`.dgc-hub-card[data-key="${KEY(2)}"] [data-hub-act="dismiss"]`); await settle(x.page);
    assert.deepEqual(pages(await x.hub()).map((c) => c.key), [KEY(3)], "dismissed");
    assert.equal((await x.posted("artifactOpen")).length, 1, "Dismiss opens nothing");
    const said = await x.posted("homePagesDismissed");
    assert.deepEqual(said.map((m) => m.ids), [[AR(1)], [AR(2)]], "the host is told each time");
    for (const m of said) assert.equal(h.said(m), true);
    await x.close();
    // The side bar is reloaded: its page is built again from what the host kept.
    x = await open({ pages: h.stamped() });
    assert.deepEqual(pages(await x.hub()).map((c) => [c.key, c.title, c.from]), [[KEY(3), "Q3 plan", `Slides made · version 1 · ${WORK_NAME}`]], "what was left is still there; what was opened or dismissed is not");
    // A later change to a dismissed one does not bring it back.
    assert.equal(await tell(x, h, change(2, "doc", "Rent or buy, in one page", fromChat, "changed", 2)), null);
    assert.deepEqual(pages(await x.hub()).map((c) => c.key), [KEY(3)]);
    // Clear, beside New, takes it off as Dismiss does.
    await x.page.click("#home-hub .dgc-hub-clear"); await settle(x.page);
    assert.deepEqual(pages(await x.hub()), []);
    assert.deepEqual((await x.posted("homePagesDismissed")).map((m) => m.ids), [[AR(3)]]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("at most the newest 20 are kept; older ones drop off", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(), h = await host();
  try {
    let last = null;
    for (let n = 1; n <= 23; n++) last = h.hear(change(n, "page", `Page ${n}`, n % 2 ? fromWork : fromChat), 1_800_000_000_000 + n * 1000) || last;
    assert.equal(last.pages.length, 20, "the host keeps 20");
    await x.send(last); await settle(x.page);
    await x.page.click('#home-hub .dgc-hub-rest[data-group="new"]'); await settle(x.page);
    assert.deepEqual(pages(await x.hub()).map((c) => c.key), Array.from({ length: 20 }, (_, k) => KEY(23 - k)), "the newest 20, the newest first; the three oldest dropped off");
    // The page holds the same line whatever it is handed.
    await x.send({ type: "homePages", pages: Array.from({ length: 26 }, (_, k) => ({ id: AR(100 + k), type: "page", title: `P ${k}`, version: 1, op: "made", surface: "work", where: WORK.id, at: 1_800_000_100_000 - k })) });
    await settle(x.page);
    assert.equal(pages(await x.hub()).length, 20);
  } finally { await x.close(); }
});

test("the host keeps what was made: only what it can check, only Work's, Chat's and what names no place, escaped onto the page", async () => {
  const h = await host(), { store, context } = h;
  assert.equal(typeof store.noteHomePage, "function", "the host has a keeper for what was made");
  assert.equal(store.homePagesAttr(context), "", "nothing kept: no attribute");
  assert.equal(h.hear({ type: "artifactChanged", op: "made", artifact: { id: "nope", type: "page", title: "x", version: 1 } }), null, "not an artifact's id");
  assert.equal(h.hear({ type: "artifactChanged", op: "made", artifact: { id: AR(1), type: "movie", title: "x", version: 1 } }), null, "not a kind DGC makes");
  assert.equal(h.hear(change(1, "page", "A Pip's page", { surface: "pip", pip: "pip_" + "a".repeat(32) })), null, "a Pip's own page is its Pip's news, not a card here");
  const out = h.hear(change(2, "page", 'A "quoted" <b>title</b> & more', fromWork), 1_800_000_000_000);
  assert.deepEqual(out.pages, [{ id: AR(2), type: "page", title: 'A "quoted" <b>title</b> & more', version: 1, op: "made", surface: "work", where: WORK.id, at: 1_800_000_000_000 }]);
  const attr = store.homePagesAttr(context);
  assert.match(attr, /^ data-home-pages="[^"<>]*"$/, "one attribute, nothing in it that ends it");
  assert.deepEqual(JSON.parse(h.stamped()), out.pages);
  // The event's own surface is used when the artifact names none; a second one made in the same instant is still newer.
  const two = h.hear({ ...change(3, "doc", "Notes", {}), surface: "chat", conversation_id: "chat_9" }, 1_800_000_000_000);
  assert.deepEqual(two.pages.map((p) => [p.id, p.surface, p.where, p.at]), [[AR(3), "chat", "chat_9", 1_800_000_000_001], [AR(2), "work", WORK.id, 1_800_000_000_000]]);
  assert.equal(h.said({ type: "homePagesDismissed", ids: [AR(2), "junk", 7] }), true);
  assert.deepEqual(store.homePages(context).map((p) => p.id), [AR(3)]);
  assert.equal(h.said({ type: "homeShow", show: "work" }), false, "not its message");
  assert.equal(store.rememberHomePagesDismissed({}, { type: "homePagesDismissed", ids: [AR(3)] }), true, "a host with no store still takes the message");
  // What was kept is checked again when read: a store someone else wrote to gives nothing malformed.
  context.globalState.value["dgc.homePages"] = [{ id: AR(4), type: "page", title: "ok", version: 2, op: "changed", surface: "work", where: "s1", at: 5 }, { id: "x" }, null, "y"];
  assert.deepEqual(store.homePages(context).map((p) => p.id), [AR(4)]);
  // The panel: the side bar's provider hears every artifact's change, stamps what is kept on its page, and takes Dismiss.
  const panel = read("src/panel.ts"), page = read("media/main.js");
  assert.match(panel, /const homePagesKept = place === "home" \? homePagesAttr\(this\.context\) : "";/);
  assert.match(panel, /<html lang="en"[^>]*\$\{homePagesKept\}[^>]*>/);
  assert.match(panel, /if \(rememberHomePagesDismissed\(this\.context, msg\)\) return;/);
  assert.match(panel, /noteHomePage\(this\.context, message\)/);
  assert.match(page, /document\.documentElement\.dataset\.homePages/);
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`${theme} ${width}px: the card's words read at 4.5:1, its sheet's tab at 3:1, and the sheet stands in the face's place`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ theme, width }), h = await host();
    try {
      await tell(x, h, change(1, "page", "Login redirect map", fromWork));
      await tell(x, h, change(2, "doc", "Rent or buy, in one page, with every number the bank sent and the two that it did not", fromChat));
      await tell(x, h, change(3, "slides", "Q3 plan", fromWork));
      await tell(x, h, change(4, "sheet", "Budget", fromChat));
      await tell(x, h, change(5, "dashboard", "Sales this week", {}));
      assert.equal(pages(await x.hub()).length, 5);
      const rows = await homeContrast(x.page);
      // (The word on a sheet's tab is part of its mark: the card's line says the kind in words.)
      const low = rows.filter((m) => !m.what.includes("dgc-sheet-tag") && m.ratio < (m.kind === "words" ? 4.5 : 3));
      assert.deepEqual(low, []);
      const marks = await x.page.evaluate(() => {
        const parse = (c) => (c.match(/-?[\d.]+/g) || []).map(Number), lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const solid = (n) => { for (; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.length < 4 || c[3] === 1) { if (c.length) return c; } } return [255, 255, 255]; };
        return [...document.querySelectorAll('#home-hub .dgc-hub-card[data-key^="page:"]')].map((card) => {
          const sheet = card.querySelector(".dgc-sheet"), tag = sheet.querySelector(".dgc-sheet-tag"), words = card.querySelector(".dgc-card-words"), chips = card.querySelector(".dgc-card-chips"), acts = card.querySelector(".dgc-card-actions");
          // (A slim card is one row: the words, the chips and the answers all stand beside the sheet, none under it. The words' box has no box of its own now: the title's is measured.)
          const s = sheet.getBoundingClientRect(), g = tag.getBoundingClientRect(), w = card.querySelector(".dgc-card-title").getBoundingClientRect(), c = card.getBoundingClientRect(), beside = (chips && chips.checkVisibility() ? chips : acts).getBoundingClientRect();
          const [a, b] = [lum(parse(getComputedStyle(tag).backgroundColor)), lum(solid(card))].sort((p, q) => q - p);
          return { kind: sheet.dataset.kind, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100, w: Math.round(s.width), h: Math.round(s.height),
            inCard: s.left >= c.left && g.left >= c.left && s.top >= c.top, clearOfWords: Math.max(s.right, g.right) <= w.left, clearBelow: Math.max(s.right, g.right) <= beside.left + 0.5 && Math.max(s.bottom, g.bottom) <= c.bottom - 3,
            titleLines: Math.round(card.querySelector(".dgc-card-title").getBoundingClientRect().height / parseFloat(getComputedStyle(card.querySelector(".dgc-card-title")).lineHeight)) };
        });
      });
      assert.deepEqual(marks.map((m) => m.kind).sort(), ["dashboard", "doc", "page", "sheet", "slides"]);
      for (const m of marks) {
        assert.ok(m.ratio >= 3, `${m.kind}: its tab is ${m.ratio}:1 on the card`);
        assert.deepEqual([m.w, m.h], [26, 33], `${m.kind}: the sheet at the face's size`);
        assert.ok(m.inCard && m.clearOfWords && m.clearBelow, `${m.kind}: the sheet and its tab stand clear of the words and the chips (${JSON.stringify(m)})`);
        assert.ok(m.titleLines <= 2, "a long title keeps to two lines");
      }
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing runs off the side");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
