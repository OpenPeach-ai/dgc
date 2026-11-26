// A widget's mark, in real Chromium on ChatDGC's own pages (support/chat-scene.mjs) and the side bar's (support/
// dock-scene.mjs). A widget is one of ChatDGC's interactive answers (a calculator, a timer, a quiz); its mark is the
// maintainer's own Folio (media/shared/folio.css: span.folio.folio--<palette> > i*3), in one of twelve palettes (his
// fourteen without Citron and Lime). What is held here:
//   - the maintainer's sheet is shipped as written, and the old cube and its seven colour pairs are gone
//   - a widget wears its Folio wherever it is shown: the Library's Widgets tab, a chat's Widgets list, its card in its
//     reply, the dock; at each place's size, with nothing cut off; a deleted one's is dimmed
//   - twelve palettes, never citron or lime; a widget's Folio rests (it has no work of its own to show), and nothing
//     moves under reduced motion
//   - a widget keeps its palette: a new one takes the first its neighbours don't wear, the host is asked to keep it by
//     the widget's id, and a reload, another order and another page (the chat, the Library, the dock) show the same
//   - the still pictures for a widget's editor tab (media/session-icons/folio-*.png) are what this CSS draws
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { openChat, openLibrary, conversation, M } from "./support/chat-scene.mjs";
import { openDock, dockNow, LIBRARY_PINS } from "./support/dock-scene.mjs";
import { renderMark, iconFile } from "../scripts/render-session-icons.mjs";

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
const TWELVE = ["ember", "peach", "saffron", "fern", "mint", "lagoon", "ice", "azure", "iris", "lilac", "orchid", "rose"];
const WG = (n) => `wg_${String(n).padStart(16, "0")}`;
const widget = (n, more = {}) => ({ chat_id: `chat_${"a".repeat(32)}`, id: WG(n), message_id: M(2), title: `Widget ${n}`, created_at: "2026-11-10T09:00:00Z", chat_title: "Home loan", ...more });
/** A stand-in for the host's dock on a ChatDGC page: it keeps each widget's palette the way src/dock.ts does (the same
 *  media/shared/marks.js gives them out) and answers with the dock's state. */
const host = (x, colours = {}) => x.page.evaluate((colours) => {
  const state = window.__dock = { pins: [], colours: { ...colours }, since: 1, show: "always", most: 8, size: 34 };
  const say = () => window.dispatchEvent(new MessageEvent("message", { data: JSON.parse(JSON.stringify({ type: "dock", ...state })) }));
  const posted = window.__posted;
  posted.push = function (m) { Array.prototype.push.call(this, m);
    if (m?.type === "dockPalettes") { Object.assign(state.colours, window.DgcMarks.assign({ kind: m.kind, list: m.list, known: state.colours, since: state.since })); say(); }
    return this.length; };
  say();
}, colours);
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60)))));
/** Every Folio under `sel`: its widget, its palette, its markup, its size, whether it rests, and whether its holder and its row hold it. */
const folios = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-mark="folio"]`)].map((m) => {
  const r = m.getBoundingClientRect(), part = getComputedStyle(m.querySelector("i:last-child"));
  const row = m.closest(".lib-row, .cd-wrow, .cd-widget-card, .dgc-dock-item"), h = row.getBoundingClientRect(), words = row.querySelector(".lib-row-main, .cd-wwords, .cd-file-words")?.getBoundingClientRect();
  return { id: m.closest("[data-folio]")?.dataset.folio || row.dataset.widget || row.dataset.key || row.querySelector(".lib-pin")?.dataset.pin?.replace("widget:", "") || "", set: m.dataset.mark, palette: m.dataset.palette, cls: m.className, parts: [...m.children].map((c) => c.tagName).join(""),
    hidden: m.getAttribute("aria-hidden"), w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, name: part.animationName, state: part.animationPlayState, time: part.animationDuration,
    inside: r.left >= h.left - 0.5 && r.right <= h.right + 0.5 && r.top >= h.top - 0.5 && r.bottom <= h.bottom + 0.5, clearOfWords: !words || r.right <= words.left + 0.5,
    shown: m.checkVisibility({ visibilityProperty: true }), dim: Number(getComputedStyle(m.parentElement).opacity) };
}), sel);

test("the maintainer's Folio sheet is shipped as written and loaded with the others; the old cube and its seven colour pairs are gone", () => {
  assert.equal(createHash("sha256").update(readFileSync(new URL("../media/shared/folio.css", import.meta.url))).digest("hex"), "53a341b15d2c1986b1d4494ea1d7c79fd4b97af9ffce351c95566163062d7cb3", "folio.css, byte for byte");
  assert.match(read("media/main.css"), /@import url\("\.\/shared\/voxel\.css"\);\n@import url\("\.\/shared\/folio\.css"\);\n@import url\("\.\/shared\/blob\.css"\);/, "Work's page, ChatDGC's and the Library's all take it");
  for (const file of ["media/main.js", "media/chatdgc.js", "media/library.js", "media/shared/blob.js", "media/shared/blob.css", "media/shared/dock.css", "media/shared/tokens.css", "media/chatdgc.css"]) {
    assert.doesNotMatch(read(file), /dgc-cube|\.cube\(|--blob-/, `${file} has nothing of the old cube or its colour pairs`);
  }
  assert.doesNotMatch(read("media/chatdgc.css"), /\.cd-w(?:idget-)?badge \{[^}]*--accent/, "a widget's badge is no longer a purple tile: its Folio is its own colours");
  const files = readdirSync(new URL("../media/session-icons", import.meta.url)).filter((name) => name.startsWith("folio-")).sort();
  assert.deepEqual(files, [...TWELVE].sort().map((name) => `folio-${name}.png`), "twelve pictures for a widget's tab, and no Citron or Lime");
});

test("the Library's Widgets tab: every widget wears its Folio, the first palette its neighbours don't, and keeps it", async (t) => {
  if (skipOrFail(t)) return;
  let kept;
  for (const width of [300, 700]) {
    const x = await openLibrary(browser, { width, height: 700 });
    try {
      await host(x);
      await x.send({ type: "library", files: [], total: 0, next: null, counts: {} });
      await x.send({ type: "widgetsOffered", on: true });
      await x.send({ type: "view", view: "widgets" });
      const list = Array.from({ length: 14 }, (_, i) => widget(i + 1));
      await x.send({ type: "widgets", widgets: list, total: 14, next: null });
      await settle(x.page);
      const marks = await folios(x.page, "#library-list");
      assert.equal(marks.length, 14, "one for every widget");
      for (const m of marks) {
        assert.match(m.cls, /^folio folio--[a-z]+$/, "span.folio.folio--<palette>");
        assert.deepEqual([m.set, m.parts, m.hidden], ["folio", "III", "true"], "three empty <i>; its name beside it says which widget");
        // (One row height at every width, 16 Nov: its mark is 36 px in a narrow side bar too; it was 30 under 560 px.)
        assert.deepEqual([m.w, m.h], [36, 36], `its size in the row (${width})`);
        assert.ok(m.inside && m.clearOfWords && m.shown, `inside its row and clear of its name (${width})`);
        assert.deepEqual([m.name, m.state], ["folio-tilt", "paused"], "at rest (--folio-play: paused)");
      }
      assert.deepEqual(marks.slice(0, 12).map((m) => m.palette), TWELVE, "the first twelve: the twelve palettes in order, never citron or lime");
      marks.forEach((m, i) => { for (let d = 1; d <= 10; d++) if (marks[i + d]) assert.notEqual(m.palette, marks[i + d].palette, `widget ${i + 1} and the one ${d} below never share a palette`); });
      assert.deepEqual((await x.posted("dockPalettes")).at(0), { type: "dockPalettes", kind: "widget", list: list.map((w) => ({ id: w.id })) }, "the host is asked to keep them: the list in view, in order");
      kept = await x.page.evaluate(() => ({ ...window.__dock.colours }));
      assert.deepEqual(list.map((w) => kept[`widget:${w.id}`]), marks.map((m) => m.palette), "and it kept what the page drew, by each widget's id");
      assert.equal(await x.page.evaluate(() => document.querySelectorAll('[class*="citron"], [class*="lime"]').length), 0);
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing wider than the page");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  }
  // "A reload", with what the host kept: another order (a search found three) and a new one among them.
  const y = await openLibrary(browser, { width: 700, height: 700 });
  try {
    await host(y, kept);
    await y.send({ type: "library", files: [], total: 0, next: null, counts: {} });
    await y.send({ type: "widgetsOffered", on: true });
    await y.send({ type: "view", view: "widgets" });
    await y.send({ type: "widgets", widgets: [widget(9), widget(2), widget(31), widget(5)], total: 4, next: null });
    await settle(y.page);
    const marks = await folios(y.page, "#library-list");
    // (The Widgets tab lists newest first since Library v2, cards and widgets together: each is found by its id.)
    const of = (n) => marks.find((m) => m.id === WG(n));
    assert.equal(marks.length, 4);
    assert.deepEqual([9, 2, 5].map((n) => of(n).palette), [kept[`widget:${WG(9)}`], kept[`widget:${WG(2)}`], kept[`widget:${WG(5)}`]], "each wears what it was given, wherever it now is");
    assert.ok(![of(9).palette, of(2).palette, of(5).palette].includes(of(31).palette), "the new one: not what its neighbours wear");
    assert.deepEqual((await y.posted("dockPalettes")).map((m) => m.list.map((r) => r.id)), [[WG(9), WG(2), WG(31), WG(5)]], "asked once, for the list in view");
  } finally { await y.page.close(); }
});

test("a chat's Widgets list and a widget's card in its reply: the same Folio for the same widget, a deleted one dimmed", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, motion] of [[300, "no-preference"], [700, "no-preference"], [700, "reduce"]]) {
    const x = await openChat(browser, { width, height: 700 });
    try {
      if (motion === "reduce") await x.page.emulateMedia({ reducedMotion: "reduce" });
      // The Library gave widget 2 Rose long ago: the chat shows the same.
      await host(x, { [`widget:${WG(2)}`]: "rose" });
      const at = (n) => new Date(Date.UTC(2026, 10, 10, 9, n)).toISOString();
      const msgs = [];
      for (let i = 1; i <= 4; i++) {
        msgs.push({ id: M(10 + 2 * i), role: "user", text: `Make widget ${i}`, created_at: at(4 * i) });
        msgs.push({ id: M(11 + 2 * i), role: "assistant", text: "Here it is.", finish: "stop", created_at: at(4 * i + 1), widgets: [{ id: WG(i), title: `Widget ${i}`, html: `<title>Widget ${i}</title><p>x</p>`, created_at: at(4 * i + 1), ...(i === 3 ? { removed: true } : {}) }] });
      }
      await x.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: msgs });
      await settle(x.page);
      const cards = await folios(x.page, "body");
      assert.equal(cards.length, 4, "a Folio on every widget's card");
      for (const m of cards) {
        assert.match(m.cls, /^folio folio--[a-z]+$/); assert.deepEqual([m.set, m.parts, m.w, m.h], ["folio", "III", 36, 36], "36 px on a card, where a file's badge stands");
        assert.ok(m.inside && m.clearOfWords, `inside its card and clear of its words (${width})`);
        assert.ok(TWELVE.includes(m.palette));
        assert.equal(motion === "reduce" ? m.name : m.state, motion === "reduce" ? "none" : "paused", "it rests; under reduced motion nothing in it moves");
      }
      const byId = Object.fromEntries(cards.map((m) => [m.id, m]));
      assert.equal(byId[WG(2)].palette, "rose", "what it was given elsewhere");
      assert.equal(new Set(cards.map((m) => m.palette)).size, 4, "four widgets, four palettes");
      assert.ok(byId[WG(3)].dim < 0.6 && byId[WG(1)].dim === 1, "a deleted widget's Folio is dimmed, as a deleted file's badge is");
      // The chat's Widgets list.
      await x.page.click("#cd-widgets"); await settle(x.page);
      await x.page.waitForFunction(() => document.getElementById("cd-widgets-panel").getAnimations().every((a) => a.playState === "finished"));   // (the list has arrived)
      const rows = await folios(x.page, "#cd-widgets-panel");
      assert.deepEqual(rows.map((m) => [m.id, m.palette]), [1, 2, 3, 4].map((n) => [WG(n), byId[WG(n)].palette]), "in the order they were made, each the same as on its card");
      for (const m of rows) { assert.deepEqual([m.set, m.w, m.h], ["folio", 24, 24], "24 px in a list, as its sheet sets it"); assert.ok(m.inside && m.clearOfWords && m.shown, `inside its row (${width})`); }
      assert.ok(rows[2].dim < 0.6, "the deleted one dimmed here too");
      assert.equal(await x.page.evaluate(() => document.querySelectorAll("#cd-widgets-panel .codicon-play-circle, .cd-widget-badge .codicon-play-circle").length), 0, "the play glyph on a purple tile is gone");
      // The host was asked to keep the three it had not: by widget id.
      const asked = (await x.posted("dockPalettes")).filter((m) => m.kind === "widget").flatMap((m) => m.list.map((r) => r.id));
      for (const n of [1, 3, 4]) assert.ok(asked.includes(WG(n)), `widget ${n} had no palette: the host is asked to keep the one given, by its id`);
      const kept = await x.page.evaluate(() => window.__dock.colours);
      assert.deepEqual([1, 2, 3, 4].map((n) => kept[`widget:${WG(n)}`]), [1, 2, 3, 4].map((n) => byId[WG(n)].palette));
      // A ```widget block the backend has not stored has no id yet: its card still wears a Folio, one of the twelve.
      await x.send({ type: "message", message: { id: M(40), role: "assistant", text: "Try this.\n\n```widget\n<title>Dice</title><button>Roll</button>\n```", finish: "stop", created_at: at(40) } });
      await settle(x.page);
      const fenced = (await folios(x.page, "body")).filter((m) => !/^wg_/.test(m.id));
      assert.equal(fenced.length, 1); assert.ok(TWELVE.includes(fenced[0].palette) && fenced[0].w === 36);
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  }
});

test("on the dock a pinned widget is its Folio, in the palette it wears everywhere", async (t) => {
  if (skipOrFail(t)) return;
  const pin = LIBRARY_PINS.find((p) => p.kind === "widget");
  const x = await openDock(browser, { pins: [pin], width: 300, height: 700, colours: { [pin.key]: "orchid" } });
  try {
    const d = await dockNow(x.page);
    assert.deepEqual([d.items[0].kind, d.items[0].holds, d.items[0].mark.palette, d.items[0].mark.moving], ["widget", "folio", "orchid", false]);
    const box = await x.page.evaluate(() => { const m = document.querySelector("#dgc-dock [data-mark]").getBoundingClientRect(), tile = document.querySelector("#dgc-dock .dgc-dock-item").getBoundingClientRect(); return { share: m.height / tile.height, inside: m.top >= tile.top && m.bottom <= tile.bottom && m.left >= tile.left && m.right <= tile.right }; });
    assert.ok(box.inside && box.share > 0.66 && box.share < 0.78, `about seven tenths of its tile (${box.share})`);
    assert.deepEqual((await x.posted("dockPalettes")).filter((m) => m.kind === "widget"), [], "it has its palette: nothing is asked");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  // One pinned before it was ever given a palette is given one, and the host keeps it.
  const y = await openDock(browser, { pins: [pin], width: 300, height: 700 });
  try {
    const d = await dockNow(y.page);
    assert.equal(d.items[0].mark.palette, "ember", "the first of the twelve: nothing around it wears one");
    assert.equal(await y.page.evaluate((key) => window.__dock.colours[key], pin.key), "ember");
  } finally { await y.close(); }
});

test("the still pictures for a widget's editor tab are what this CSS draws: 12 Folios at rest", async (t) => {
  if (skipOrFail(t)) return;
  const context = await browser.newContext({ deviceScaleFactor: 1 }), page = await context.newPage();
  try {
    for (const palette of TWELVE) {
      const drawn = (await renderMark(page, "folio", palette)).toString("base64"), kept = readFileSync(iconFile("folio", palette)).toString("base64");
      const far = await page.evaluate(async ([a, b]) => {
        const px = async (b64) => { const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()), c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d"); g.drawImage(bmp, 0, 0); return { w: bmp.width, h: bmp.height, d: g.getImageData(0, 0, bmp.width, bmp.height).data }; };
        const p = await px(a), q = await px(b);
        if (p.w !== q.w || p.h !== q.h) return { size: [q.w, q.h], mean: Infinity };
        let sum = 0, edge = 0; for (let i = 0; i < p.d.length; i++) sum += Math.abs(p.d[i] - q.d[i]);
        for (let i = 0; i < q.w; i++) edge = Math.max(edge, q.d[i * 4 + 3], q.d[((q.h - 1) * q.w + i) * 4 + 3], q.d[i * q.w * 4 + 3], q.d[(i * q.w + q.w - 1) * 4 + 3]);
        return { size: [q.w, q.h], mean: sum / p.d.length, edge, middle: q.d[(36 * q.w + 34) * 4 + 3] };
      }, [drawn, kept]);
      assert.deepEqual(far.size, [64, 64], `folio-${palette}.png is 64 px`);
      assert.deepEqual([far.edge, far.middle], [0, 255], `folio-${palette}.png: clear at its edges (nothing cut off), filled in the middle`);
      assert.ok(far.mean < 1.5, `folio-${palette}.png is the Folio this CSS draws at rest (mean difference ${far.mean}): run scripts/render-session-icons.mjs after changing the sheet`);
    }
  } finally { await context.close(); }
});
