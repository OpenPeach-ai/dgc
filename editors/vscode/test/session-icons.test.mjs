// A session's mark, in real Chromium on the side bar's real page (support/dock-scene.mjs, which keeps each session's
// palette the way src/dock.ts does). The marks are the maintainer's own designs, in the maintainer's own CSS: Mote for a ChatDGC
// chat (media/shared/mote.css), Voxel for a Work session (media/shared/voxel.css), each in one of twelve palettes (his
// fourteen without Citron and Lime, which are too bright). What is held here:
//   - the maintainer's two sheets are shipped as written, and every page that shows a session loads them
//   - each list draws a Mote for a chat and a Voxel for a Work session: Work's list, Chat's list, Home's cards, the dock,
//     the menu of colours, at each place's size, and nothing of a mark is cut off or lies over its neighbour
//   - twelve palettes, never citron or lime
//   - only the session at work moves; every other mark is paused at rest; under reduced motion none moves
//   - a new session's palette differs from its neighbours', and a reload and another order keep it
//   - a session from before the marks wears its old colour's palette
//   - the still pictures for editor tabs (media/session-icons/) are what this CSS draws
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { openDock, dockNow, DOCK_SESSIONS, PINS } from "./support/dock-scene.mjs";
import { openHome, CHATS, SESSIONS } from "./support/home-scene.mjs";
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
/** `n` Work sessions, the newest first, none of them doing anything. */
const sessions = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `202611${String(28 - i - from).padStart(2, "0")}-101500-s${i + from}`, path: `/s/s${i + from}.json`, name: `Session ${i + from + 1}`, preview: "", when: `2026-11-${String(28 - i - from).padStart(2, "0")} 10:15`, count: 3 + i, open: false }));
/** Every mark under `sel`, as drawn: its set and palette, its classes, its parts, whether it moves, its box, and whether its row's box holds it. */
const marksIn = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-mark]`)].map((m) => {
  const r = m.getBoundingClientRect(), part = getComputedStyle(m.querySelector("i:last-child")), body = getComputedStyle(m, "::before");
  const holder = m.closest(".session-row, .chat-row, .dgc-hub-card, .dgc-dock-item, .dgc-swatch"), h = holder?.getBoundingClientRect();
  const next = m.closest(".session-blob")?.nextElementSibling?.getBoundingClientRect();
  return { id: m.closest("[data-id]")?.dataset.id || m.closest("[data-key]")?.dataset.key || "", set: m.dataset.mark, palette: m.dataset.palette, cls: m.className, parts: [...m.children].map((c) => c.tagName).join(""), hidden: m.getAttribute("aria-hidden"),
    w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, shown: m.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
    name: part.animationName, state: part.animationPlayState, time: part.animationDuration, bodyName: body.animationName, bodyState: body.animationPlayState, moving: m.hasAttribute("data-moving"),
    inside: !h || (r.left >= h.left - 0.5 && r.right <= h.right + 0.5 && r.top >= h.top - 0.5 && r.bottom <= h.bottom + 0.5), clearOfWords: !next || r.right <= next.left + 0.5,
    hue: getComputedStyle(m).getPropertyValue("--h").trim() };
}), sel);

test("the maintainer's sheets are shipped as written, and every page that shows a session loads them before its own rules", () => {
  const sha = (rel) => createHash("sha256").update(readFileSync(new URL(`../${rel}`, import.meta.url))).digest("hex");
  assert.equal(sha("media/shared/mote.css"), "f9fb20f328d399800603b6d9f6cb44496d2656aa1ce0a2da12e222f6808e99e2", "mote.css, byte for byte");
  assert.equal(sha("media/shared/voxel.css"), "688f31342f5c4dff524ee3067869fb1cbb8b0f5bc1e65b70a04548869b27f6ca", "voxel.css, byte for byte");
  // Work's page, ChatDGC's and the Library all take main.css, which brings both in (where blob.css is brought in).
  const main = read("media/main.css");
  assert.match(main, /@import url\("\.\/shared\/mote\.css"\);\n@import url\("\.\/shared\/voxel\.css"\);\n(?:@import url\("\.\/shared\/\w+\.css"\);\n)*@import url\("\.\/shared\/blob\.css"\);/);
  for (const page of [/function chatdgcDocument[\s\S]*?<\/html>`;/, /function libraryDocument[\s\S]*?<\/html>`;/]) {
    const html = page.exec(read("src/chatdgc.ts"))[0];
    assert.match(html, /media\/main\.css/); assert.match(html, /media\/shared\/marks\.js"\)\)}"><\/script><script src="\$\{attr\(asset\("media\/shared\/blob\.js/, "marks.js, then the menu that offers its colours");
  }
  assert.match(read("src/panel.ts"), /src="\$\{marksJs\}"><\/script><script nonce="\$\{nonce\}" src="\$\{blobJs\}">/);
  // The old liquid blob is gone: nothing draws it and nothing styles it.
  for (const file of ["media/main.js", "media/chatdgc.js", "media/shared/blob.js", "media/shared/dock.js", "media/shared/hub.js", "media/shared/blob.css", "media/main.css", "media/shared/dock.css", "media/shared/hub.css"]) {
    assert.doesNotMatch(read(file), /dgc-blob-fill|\.dgc-blob\b(?!-button)|dgc-blob-(?:wave|surface|shimmer)|data-pair="\$\{n\}"\$\{running/, `${file} has nothing of the old blob`);
  }
});

test("each list draws a Voxel for a Work session and a Mote for a chat, at its place's size, with nothing cut off", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 700]) {
    const x = await openDock(browser, { tab: "work", width, height: 700, answering: [CHATS[1].id] });
    try {
      // Work's list.
      let marks = await marksIn(x.page, "#sessions-list");
      assert.equal(marks.length, DOCK_SESSIONS.length, "one for every session");
      for (const m of marks) {
        assert.match(m.cls, /^voxel voxel--[a-z]+$/, "span.voxel.voxel--<palette>");
        assert.deepEqual([m.set, m.parts, m.hidden], ["voxel", "IIIIII", "true"], "six empty <i>; its name beside it says which session");
        assert.deepEqual([m.w, m.h], [24, 24], `24 px in a list, as its own preview shows it (${width})`);
        assert.ok(m.inside && m.clearOfWords && m.shown, `inside its row and clear of its name (${width})`);
        assert.equal(m.hue, String({ ember: 3, peach: 22, saffron: 39, fern: 133, mint: 158, lagoon: 177, ice: 195, azure: 213, iris: 247, lilac: 273, orchid: 294, rose: 331 }[m.palette]), "the maintainer's sheet's own hue for that palette");
      }
      // The dock: Voxels and a Mote, about seven tenths of a tile.
      const d = await dockNow(x.page);
      assert.deepEqual(d.items.filter((i) => i.mark).map((i) => [i.kind, i.mark.set]), [["work", "voxel"], ["work", "voxel"], ["chat", "mote"]]);
      marks = await marksIn(x.page, "#dgc-dock");
      for (const m of marks) assert.ok(m.inside && m.shown && m.w >= 20 && m.w === m.h, `a square mark inside its tile (${m.w})`);
      // A session wears the same palette in its row and on the dock.
      const rows = Object.fromEntries((await marksIn(x.page, "#sessions-list")).map((m) => [`work:${m.id}`, m.palette]));
      for (const m of marks.filter((m) => m.set === "voxel")) assert.equal(m.palette, rows[m.id], "the same in its row and on the dock");
      // Chat's list.
      await x.page.click("#side-tab-chat"); await x.settle();
      marks = await marksIn(x.page, "#chats-list > .chat-row");
      assert.equal(marks.length, CHATS.length);
      for (const m of marks) {
        assert.match(m.cls, /^mote mote--[a-z]+$/, "span.mote.mote--<palette>");
        assert.deepEqual([m.set, m.parts, m.w, m.h], ["mote", "III", 24, 24], "three empty <i>, 24 px");
        assert.ok(m.inside && m.clearOfWords && m.shown);
      }
      assert.equal(marks.find((m) => m.id === CHATS[0].id).palette, d.items.find((i) => i.kind === "chat").mark.palette, "the same on the dock");
      // Home's cards: a session that needs you or has something new wears its mark there too.
      await x.page.click("#side-tab-home"); await x.settle();
      marks = await marksIn(x.page, "#home-hub .hc-open");          // (Needs you opened whole: Home's cards as a list)
      assert.ok(marks.length >= 1, "a card from a session");
      for (const m of marks) { assert.equal(m.set, m.id.startsWith("chat:") ? "mote" : "voxel"); assert.deepEqual([m.w, m.h], [26, 26]); assert.ok(m.inside && m.shown); if (rows[m.id]) assert.equal(m.palette, rows[m.id], "the same as in its list"); }
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing wider than the side bar");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("twelve palettes and never citron or lime: in the lists, however many sessions, and in the menu of colours", async (t) => {
  if (skipOrFail(t)) return;
  // Thirty sessions, every one new (the marks arrived before any of them): the six listed, then all of them.
  const x = await openDock(browser, { tab: "work", width: 300, height: 760, since: 1, sessions: sessions(30), pins: [] });
  try {
    let marks = await marksIn(x.page, "#sessions-list");
    assert.deepEqual(marks.map((m) => m.palette), TWELVE.slice(0, 6), "the six in view: the first six palettes, none twice");
    await x.page.click("#sessions-all"); await x.settle();
    marks = await marksIn(x.page, "#sessions-list");
    assert.equal(marks.length, 30);
    assert.deepEqual([...new Set(marks.map((m) => m.palette))].sort(), [...TWELVE].sort(), "all twelve are worn, and nothing else");
    marks.forEach((m, i) => { for (let d = 1; d <= 5; d++) if (marks[i + d]) assert.notEqual(m.palette, marks[i + d].palette, `row ${i} and the row ${d} below never share a palette`); });
    assert.deepEqual(marks.slice(0, 6).map((m) => m.palette), TWELVE.slice(0, 6), "the six that were in view keep what they were given");
    await x.page.keyboard.press("Escape");
    // The menu of colours offers the twelve, as still Voxels.
    await x.page.hover("#sessions-list .session-row"); await x.page.click("#sessions-list .session-row .session-more"); await x.settle();
    await x.page.waitForFunction(() => document.querySelector(".dgc-pop").getAnimations().every((a) => a.playState === "finished"));   // (the menu has arrived)
    const menu = await marksIn(x.page, ".dgc-pop");
    assert.deepEqual(menu.map((m) => m.palette), TWELVE);
    for (const m of menu) assert.deepEqual([m.set, m.w, m.inside, m.state], ["voxel", 20, true, "paused"], "twelve still Voxels, each inside its button");
    const box = await x.page.evaluate(() => { const r = document.querySelector(".dgc-pop").getBoundingClientRect(), tops = new Set([...document.querySelectorAll(".dgc-pop .dgc-swatch")].map((s) => Math.round(s.getBoundingClientRect().top)));
      const edges = [...document.querySelectorAll(".dgc-pop .dgc-swatch")].map((s) => s.getBoundingClientRect()); return { left: r.left, right: r.right, lines: tops.size, inside: edges.every((e) => e.left >= r.left && e.right <= r.right), overlap: edges.some((a, i) => edges.some((b, j) => i < j && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5)) }; });
    assert.deepEqual([box.lines, box.inside, box.overlap], [2, true, false], "six to a line, inside the menu, none over another");
    assert.ok(box.left >= 5.5 && box.right <= 300 - 5.5, "the menu is inside the side bar");
    // Nowhere on the page is anything drawn in Citron or Lime.
    assert.equal(await x.page.evaluate(() => document.querySelectorAll('[class*="citron"], [class*="lime"], [data-palette="citron"], [data-palette="lime"]').length), 0);
    assert.deepEqual(Object.values(await x.page.evaluate(() => window.__dock.colours)).filter((p) => !TWELVE.includes(p)), [], "and the host keeps only the twelve");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("only the session at work moves; every other mark is paused at rest; under reduced motion none moves", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "work", width: 300, height: 700 });
  try {
    const marks = await marksIn(x.page, "#sessions-list");
    const moving = marks.filter((m) => m.state === "running");
    assert.deepEqual(moving.map((m) => m.id), [DOCK_SESSIONS[0].id], "one moves: the session that is running");
    assert.deepEqual([moving[0].name, moving[0].time, moving[0].bodyState, moving[0].moving], ["voxel-heart", "8s", "running", true], "on its eight-second cycle");
    for (const m of marks.filter((m) => m.id !== DOCK_SESSIONS[0].id)) assert.deepEqual([m.state, m.bodyState, m.moving], ["paused", "paused", false], `${m.id} is paused (--voxel-play: paused)`);
    const dock = await marksIn(x.page, "#dgc-dock");
    assert.deepEqual(dock.filter((m) => m.state === "running").map((m) => m.id), [`work:${DOCK_SESSIONS[0].id}`], "and on the dock, the same one");
    // It stops: its mark rests. A chat starts answering: its Mote moves.
    await x.send({ type: "sessions_list", items: DOCK_SESSIONS.map((s) => ({ ...s, running: false })) });
    await x.send({ type: "chatdgc_list", available: true, items: CHATS, open: [], answering: [CHATS[1].id] }); await x.settle();
    assert.deepEqual((await marksIn(x.page, "#sessions-list")).filter((m) => m.state !== "paused"), [], "nothing at work: nothing moves");
    await x.page.click("#side-tab-chat"); await x.settle();
    const chats = await marksIn(x.page, "#chats-list > .chat-row");
    assert.deepEqual(chats.map((m) => [m.id, m.state, m.bodyState]), [[CHATS[0].id, "paused", "paused"], [CHATS[1].id, "running", "running"]], "the chat that is answering moves (mote-heart, mote-breathe), the other rests");
    assert.deepEqual([chats[1].name, chats[1].bodyName, chats[1].time], ["mote-heart", "mote-breathe", "8s"]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  const still = await openDock(browser, { tab: "work", width: 300, height: 700, motion: "reduce", answering: [CHATS[1].id] });
  try {
    const names = async (sel) => still.page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-mark]`)].flatMap((m) => [...[...m.querySelectorAll("i")].map((i) => getComputedStyle(i).animationName), getComputedStyle(m, "::before").animationName, getComputedStyle(m, "::after").animationName]), sel);
    assert.deepEqual([...new Set(await names("#sessions-list"))], ["none"], "reduced motion: no Voxel moves, the running one too");
    assert.deepEqual([...new Set(await names("#dgc-dock"))], ["none"], "nor anything on the dock");
    await still.page.click("#side-tab-chat"); await still.settle();
    assert.deepEqual([...new Set(await names("#chats-list"))], ["none"], "nor a Mote");
  } finally { await still.close(); }
});

test("a new session's palette differs from its neighbours', and a reload and another order keep it", async (t) => {
  if (skipOrFail(t)) return;
  const first = sessions(5, 1);
  let kept;
  const x = await openDock(browser, { tab: "work", width: 300, height: 700, since: 1, sessions: first, pins: [] });
  try {
    const marks = await marksIn(x.page, "#sessions-list");
    assert.deepEqual(marks.map((m) => m.palette), TWELVE.slice(0, 5), "five new sessions: the first five palettes, in the list's order");
    assert.deepEqual((await x.posted("dockPalettes")).at(0), { type: "dockPalettes", kind: "work", list: first.map((s) => ({ id: s.id, born: new Date(2026, 10, Number(s.id.slice(6, 8)), 10, 15, 0).getTime() })) }, "the host is asked to keep them: the list in view, in order, and when each was made");
    kept = await x.page.evaluate(() => ({ ...window.__dock.colours }));
    assert.deepEqual(first.map((s) => kept[`work:${s.id}`]), TWELVE.slice(0, 5), "and it kept what the page drew");
    // A new session arrives at the top of the list.
    const fresh = sessions(1)[0];
    await x.send({ type: "sessions_list", items: [fresh, ...first] }); await x.settle();
    const now = await marksIn(x.page, "#sessions-list");
    assert.equal(now[0].palette, "lagoon", "the first palette none of the five in view wears");
    assert.deepEqual(now.slice(1).map((m) => m.palette), TWELVE.slice(0, 5), "the five keep theirs");
    kept = await x.page.evaluate(() => ({ ...window.__dock.colours }));
    assert.equal(kept[`work:${fresh.id}`], "lagoon");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  // "A reload": the page again, with what the host kept, and the list in another order (the oldest was just used).
  const again = [first[4], sessions(1)[0], first[2], first[0], first[3], first[1]];
  const y = await openDock(browser, { tab: "work", width: 300, height: 700, since: 1, sessions: again, colours: kept, pins: [] });
  try {
    const marks = await marksIn(y.page, "#sessions-list");
    assert.deepEqual(marks.map((m) => [m.id, m.palette]), again.map((s) => [s.id, kept[`work:${s.id}`]]), "every session wears what it was given, wherever it now is in the list");
    assert.deepEqual(await y.posted("dockPalettes"), [], "nothing more is asked for");
  } finally { await y.close(); }
});

test("a session from before the marks wears its old colour's palette; before the host has said what it keeps, nothing is asked", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "work", width: 300, height: 700, pins: [] });      // the marks arrive now: the scene's sessions are older
  try {
    const marks = await marksIn(x.page, "#sessions-list");
    const want = await x.page.evaluate((ids) => ids.map((id) => window.DgcMarks.fromOld(window.DgcMarks.oldPair(id))), marks.map((m) => m.id));
    assert.deepEqual(marks.map((m) => m.palette), want, "each keeps the palette nearest the colour its id gave it");
    for (const p of want) assert.ok(["azure", "ice", "fern", "saffron", "peach", "ember"].includes(p), `${p}: one of the six an id's old colour maps to`);
    assert.deepEqual(await x.page.evaluate((ids) => ids.map((id) => window.__dock.colours[`work:${id}`]), marks.map((m) => m.id)), want, "and the host keeps them");
  } finally { await x.close(); }
  // The side bar with no host answering its dock: each mark wears what its id alone gives, and nothing is asked.
  const y = await openHome(browser, { tab: "work", width: 300, height: 700 });
  try {
    const marks = await marksIn(y.page, "#sessions-list");
    assert.equal(marks.length, SESSIONS.length);
    assert.deepEqual(marks.map((m) => m.palette), await y.page.evaluate((ids) => ids.map((id) => window.DgcMarks.fallback("work", id)), marks.map((m) => m.id)));
    assert.deepEqual(await y.posted("dockPalettes"), []);
  } finally { await y.close(); }
});

test("the still pictures for editor tabs are what this CSS draws: 12 Motes and 12 Voxels at rest", async (t) => {
  if (skipOrFail(t)) return;
  const context = await browser.newContext({ deviceScaleFactor: 1 }), page = await context.newPage();
  try {
    for (const set of ["mote", "voxel"]) for (const palette of TWELVE) {
      const drawn = (await renderMark(page, set, palette)).toString("base64"), kept = readFileSync(iconFile(set, palette)).toString("base64");
      // Pixel by pixel (the bytes may differ with the browser's PNG writer; the picture may not, beyond a shade at an edge).
      const far = await page.evaluate(async ([a, b]) => {
        const px = async (b64) => { const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()), c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d"); g.drawImage(bmp, 0, 0); return { w: bmp.width, h: bmp.height, d: g.getImageData(0, 0, bmp.width, bmp.height).data }; };
        const p = await px(a), q = await px(b);
        if (p.w !== q.w || p.h !== q.h) return { size: [q.w, q.h], sum: Infinity, most: Infinity };
        let sum = 0, most = 0; for (let i = 0; i < p.d.length; i++) { const d = Math.abs(p.d[i] - q.d[i]); sum += d; if (d > most) most = d; }
        return { size: [q.w, q.h], mean: sum / p.d.length, most };
      }, [drawn, kept]);
      assert.deepEqual(far.size, [64, 64], `${set}-${palette}.png is 64 px`);
      assert.ok(far.mean < 1.5, `${set}-${palette}.png is the mark this CSS draws at rest (mean difference ${far.mean}, most ${far.most}): run scripts/render-session-icons.mjs after changing a sheet`);
    }
  } finally { await context.close(); }
});
