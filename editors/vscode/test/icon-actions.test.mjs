// A card's answers as icons that turn into buttons (asked 12 Nov; media/shared/iconactions.js and .css), on Home's
// cards and on the Pips page's Needs attention, and nowhere else. In real Chromium, on the real pages:
//   - at rest: 24 px icon buttons at the card's right, the main answer filled, each named by its word, the longer line
//     kept as its description and never a tooltip; three are no wider than the 76 px column they replace
//   - pointed at, or reached by Tab, a pill shows that answer's icon and word over the row, held at its right edge; the
//     ring is the pill's; moving along the row turns it into the next answer; every button's box stays where it was
//   - a click answers once; Home then holds the card for a moment ("Applied", with Undo as a plain word button), sends
//     nothing until the moment passes, and Needs attention does the same
//   - reduced motion (an instant swap), forced colours (edges drawn), a finger (a tap is a click)
//   - a card in a Work session, in a Pip's chat and in ChatDGC keeps its full buttons
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openCards, K } from "./support/home-cards-scene.mjs";
import { client, openChat, PIP } from "./support/pip-chat-scene.mjs";
import { openWork } from "./support/work-buttons-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
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
await client();   // built before the first test is registered (a pending top-level await would end the file early)
const settle = (page, ms = 320) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);
const here = new URL("..", import.meta.url).pathname;

/** A card's answers as they are drawn, read in the page: `sel` is the card (Home's, or Needs attention's item). */
const row = (sel) => {
  const r = window.__pipsRoot || document, card = r.querySelector(sel); if (!card) return null;
  const box = (n) => { const b = n.getBoundingClientRect(); return { left: Math.round(b.left * 10) / 10, right: Math.round(b.right * 10) / 10, top: Math.round(b.top * 10) / 10, bottom: Math.round(b.bottom * 10) / 10, width: Math.round(b.width * 10) / 10, height: Math.round(b.height * 10) / 10 }; };
  const probe = document.createElement("i"); document.body.append(probe); probe.style.backgroundColor = "var(--solid)"; const solid = getComputedStyle(probe).backgroundColor; probe.remove();
  const ia = card.querySelector(".dgc-ia"), pill = ia?.querySelector(".dgc-ia-pill"), ps = pill && getComputedStyle(pill);
  const icons = ia ? [...ia.querySelectorAll(".dgc-ia-btn")].map((b) => { const s = getComputedStyle(b), svg = b.querySelector("svg"), ss = getComputedStyle(svg);
    return { word: b.textContent.trim(), name: b.getAttribute("aria-label") || b.textContent.trim(), icon: b.dataset.iaIcon, primary: b.classList.contains("dgc-ia-main"), filled: s.backgroundColor === solid, tip: b.getAttribute("title"),
      says: b.getAttribute("aria-describedby") ? r.getElementById(b.getAttribute("aria-describedby"))?.textContent || "" : "", edge: `${s.borderTopWidth} ${s.borderTopStyle}`, line: s.borderTopColor, fill: s.backgroundColor,
      ring: s.outlineStyle, iconShown: Number(ss.opacity), iconAt: ss.transform, hot: b.classList.contains("dgc-ia-hot"), wordShown: b.querySelector(".dgc-ia-word").getBoundingClientRect().width > 2, ...box(b) }; }) : [];
  const words = [...card.querySelectorAll(".dgc-card-actions .dgc-card-btn, .attention-undo")].map((b) => ({ word: b.textContent.trim(), ...box(b) }));
  return { card: box(card), row: ia ? box(ia) : null, on: !!ia?.classList.contains("dgc-ia-on"), kbd: !!ia?.classList.contains("dgc-ia-kbd"), icons, words,
    pill: pill ? { shown: Number(ps.opacity) > 0.99 && ia.classList.contains("dgc-ia-on"), word: pill.querySelector(".dgc-ia-pill-word").textContent, primary: pill.classList.contains("dgc-ia-main"), ring: `${ps.outlineStyle} ${ps.outlineWidth}`, edge: `${ps.borderTopWidth} ${ps.borderTopStyle}`, line: ps.borderTopColor, fill: ps.backgroundColor,
      moving: ia.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length, ...box(pill) } : null,
    title: (card.querySelector(".dgc-card-title, .attention-copy strong")?.textContent || "").trim(), focus: (r.activeElement?.textContent || "").trim() };
};
const HOME = (key) => `.dgc-hub-card[data-key="${key}"]`;
const act = (key, id) => `${HOME(key)} [data-hub-act="${id}"]`;

// ---- Home ----------------------------------------------------------------------------------------------------------
for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`Home, ${theme} ${width}px: every card's answers rest as icons at its right, the main one filled, each named by its word`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openCards(browser, { theme, width });
    try {
      const keys = await x.page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-hub-card")].map((c) => c.dataset.key));
      assert.ok(keys.length >= 10, `every kind of card is on Home (${keys.length})`);
      for (const key of keys) {
        await x.see(key);          // (a card that is new shows in Recent opened, one that needs you in Needs you opened)
        const c = await x.page.evaluate(row, HOME(key));
        assert.ok(c.row && c.icons.length >= 1 && c.icons.length <= 3, `${key}: its answers are an icon row (${c.icons.length})`);
        assert.deepEqual(c.words, [], `${key}: and no word button beside it`);
        assert.deepEqual([...new Set(c.icons.map((i) => `${i.width}x${i.height}`))], ["24x24"], `${key}: every icon is one 24 px square`);
        assert.equal(c.icons.filter((i) => i.filled).length, 1, `${key}: exactly one is filled (${c.icons.map((i) => `${i.word}:${i.filled}`)})`);
        assert.deepEqual(c.icons.filter((i) => i.filled).map((i) => i.primary), [true], `${key}: the main answer`);
        assert.deepEqual(c.icons.filter((i) => !i.word || i.wordShown || i.tip !== null).map((i) => i.word), [], `${key}: each is named by its word, which is not drawn, and has no tooltip`);
        assert.ok(c.row.width <= 76, `${key}: the row is no wider than the 76 px column it replaces (${c.row.width})`);
        assert.ok(c.row.right <= c.card.right - 8 && c.row.right >= c.card.right - 14, `${key}: at the card's right (${c.card.right - c.row.right})`);
        assert.ok(c.row.top >= c.card.top + 3 && c.row.bottom <= c.card.bottom - 3, `${key}: inside the card`);
        assert.equal(c.on, false, `${key}: at rest`);
        assert.equal(c.pill.shown, false, `${key}: no pill at rest`);
      }
      await x.card("needs");
      const change = await x.page.evaluate(row, HOME(K.visit));
      assert.deepEqual(change.icons.map((i) => `${i.word}/${i.icon}${i.primary ? "*" : ""}`), ["Allow/check*", "Not now/x", "Review/eye"], "a visit to a new site: a tick, a cross, an eye");
      assert.equal(change.icons[2].says, "See all of it, in Pips", "the longer line is the button's description");
      assert.equal(change.row.width, 76, "three icons are 76 px");
      const run = await x.page.evaluate(row, HOME(K.run));
      assert.deepEqual(run.icons.map((i) => `${i.word}/${i.icon}${i.primary ? "*" : ""}`), ["Allow once/check*", "Deny/x", "Open/open"], "a command: a tick, a cross, an arrow");
      assert.deepEqual(run.icons.map((i) => i.says), ["Run it this once", "Don’t run it", "Open it in its editor tab"]);
      const all = (await Promise.all(keys.map((key) => x.page.evaluate(row, HOME(key))))).flatMap((c) => c.icons.map((i) => `${i.word}/${i.icon}`));
      assert.ok(all.includes("Mark read/read") && all.includes("Dismiss/x") && all.includes("Open/open") && all.includes("Review/eye"), `the plain answers have their icons too (${[...new Set(all)]})`);
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing runs off the side");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("Home at its narrowest (170 and 200 px): the icons stay at the card's right, never in a row under the words, and the sentence keeps room", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [170, 200]) {
    const x = await openCards(browser, { width });
    try {
      const keys = await x.page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-hub-card")].map((c) => c.dataset.key));
      const heights = new Set();
      for (const key of keys) {
        await x.see(key);
        const c = await x.page.evaluate(row, HOME(key)), title = await x.page.evaluate((s) => { const b = document.querySelector(`${s} .dgc-card-title`).getBoundingClientRect(); return { right: b.right, top: b.top, bottom: b.bottom, width: b.width }; }, HOME(key));
        assert.ok(c.row && c.row.right >= c.card.right - 14 && c.row.left >= c.card.left + 40, `${width}px ${key}: the icons are at the card's right`);
        assert.ok(c.row.bottom <= title.top + 1 || title.right <= c.row.left + 0.5, `${width}px ${key}: over or beside the sentence, never under it`);
        assert.ok(c.row.top >= c.card.top + 3 && c.row.bottom <= c.card.bottom - 3 && c.row.width <= 76, `${width}px ${key}: inside the card`);
        assert.ok(title.width >= 80, `${width}px ${key}: the sentence keeps room to be read (${title.width})`);
        if (!(await x.page.evaluate((s) => document.querySelector(s).classList.contains("dgc-hub-mono"), HOME(key)))) heights.add(c.card.height);
      }
      assert.deepEqual([...heights], [72], `${width}px: every card keeps the one height`);
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing runs off the side");
    } finally { await x.close(); }
  }
});

test("Home: pointing at an icon shows its pill with the word; moving along the row turns it into the next; the boxes never move", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCards(browser, { width: 300 });
  try {
    const rest = await x.page.evaluate(row, HOME(K.visit));
    await x.page.hover(act(K.visit, "yes")); await settle(x.page);
    const apply = await x.page.evaluate(row, HOME(K.visit));
    assert.deepEqual([apply.on, apply.pill.shown, apply.pill.word, apply.pill.primary, apply.kbd], [true, true, "Allow", true, false], "the pill says Allow, filled as the main answer is");
    assert.ok(Math.abs(apply.pill.right - rest.row.right) <= 0.5 && apply.pill.left <= rest.row.left + 0.5 && apply.pill.height === 24, `it covers the row, held at its right edge (${JSON.stringify(apply.pill)})`);
    assert.deepEqual(apply.icons.map((i) => i.iconShown), [0, 0, 0], "the icons are under it");
    assert.deepEqual(apply.icons.map((i) => [i.left, i.top, i.width, i.height]), rest.icons.map((i) => [i.left, i.top, i.width, i.height]), "every button's box is where it was: only the icons move");
    assert.ok(apply.icons.slice(1).every((i) => i.iconAt !== "none") && apply.icons[0].iconAt === "none", "the others slid toward it");
    assert.equal(apply.pill.moving, 0, "and it has come to rest");
    await x.page.hover(act(K.visit, "no")); await settle(x.page);
    const no = await x.page.evaluate(row, HOME(K.visit));
    assert.deepEqual([no.pill.shown, no.pill.word, no.pill.primary], [true, "Not now", false], "moved along: Not now, an outline");
    assert.ok(Math.abs(no.pill.right - rest.row.right) <= 0.5, "still held at the right edge");
    assert.notEqual(no.pill.line, "rgba(0, 0, 0, 0)", "an outline has its line");
    await x.page.hover(act(K.visit, "open")); await settle(x.page);
    assert.equal((await x.page.evaluate(row, HOME(K.visit))).pill.word, "Review");
    // A word wider than its row grows to the left, over the card's own ground.
    const mail = await x.page.evaluate(row, HOME(K.mail));
    await x.page.hover(act(K.mail, "read")); await settle(x.page);
    const read = await x.page.evaluate(row, HOME(K.mail));
    assert.deepEqual([read.pill.word, read.pill.shown], ["Mark read", true]);
    assert.ok(read.pill.width > mail.row.width && Math.abs(read.pill.right - mail.row.right) <= 0.5, `wider than its two icons, growing left (${read.pill.width} > ${mail.row.width})`);
    assert.equal((await x.page.evaluate(row, HOME(K.visit))).on, false, "the row the pointer left rests again");
    await x.page.mouse.move(2, 2); await settle(x.page);
    const left = await x.page.evaluate(row, HOME(K.mail));
    assert.deepEqual([left.on, left.pill.shown, left.icons.map((i) => i.iconShown)], [false, false, [1, 1]], "leaving the row: icons again");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Home: Tab shows the pill of the answer it reaches, with the ring on the pill, and goes along the row", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCards(browser, { width: 300 });
  try {
    await x.page.focus("#home-hub .hc-cards-btn");
    const seen = [];
    for (let i = 0; i < 40 && seen.length < 3; i++) {
      await x.page.keyboard.press("Tab"); await settle(x.page, 260);
      const at = await x.page.evaluate(() => document.activeElement?.closest?.(".dgc-hub-card")?.dataset.key || "");
      if (at) { const c = await x.page.evaluate(row, HOME(at)); seen.push({ at, focus: c.focus, word: c.pill.word, shown: c.pill.shown, kbd: c.kbd, ring: c.pill.ring, own: c.icons.find((k) => k.word === c.focus)?.ring }); }
    }
    assert.equal(seen.length, 3, "the answers are reached");
    for (const s of seen) {
      assert.deepEqual([s.shown, s.word, s.kbd], [true, s.focus, true], `${s.focus}: its pill shows, with its word`);
      assert.match(s.ring, /^solid [12]px$/, `${s.focus}: the ring is the pill's (${s.ring})`);
      assert.equal(s.own, "none", `${s.focus}: and not a second one on the square under it`);
    }
    const first = seen[0].at;
    await x.page.focus("#home-hub .hc-cards-btn"); await settle(x.page);
    assert.equal((await x.page.evaluate(row, HOME(first))).on, false, "Tab away: the row rests");
  } finally { await x.close(); }
});

test("Home: a click answers once; the card says what it will do with Undo as a word, sends nothing yet, then sends it and leaves", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCards(browser, { width: 300 });
  try {
    await x.page.evaluate(() => { const later = window.setTimeout.bind(window); window.__holds = [];
      window.setTimeout = (fn, ms, ...rest) => (ms === 6000 ? (window.__holds.push(fn), 900000 + window.__holds.length) : later(fn, ms, ...rest));
      const clear = window.clearTimeout.bind(window); window.clearTimeout = (id) => { if (id > 900000) window.__holds[id - 900001] = null; else clear(id); }; });
    const sent = () => x.page.evaluate(() => window.__requests.filter((r) => /^decide_pip_computer_action$/.test(r.type)));
    await x.page.hover(act(K.visit, "yes")); await settle(x.page);
    await x.page.click(act(K.visit, "yes")); await settle(x.page);
    const held = await x.page.evaluate(row, HOME(K.visit));
    assert.equal(held.title, "Allowed. Garden notes opens seeds.example.", "the card says what it will do");
    assert.deepEqual([held.row, held.words.map((w) => w.word)], [null, ["Undo"]], "its one answer, Undo, is a plain word button and not an icon");
    assert.ok(held.words[0].width >= 40 && held.words[0].right >= held.card.right - 14, "at the card's right");
    assert.deepEqual(await sent(), [], "nothing is sent while it can be undone");
    await x.page.click(act(K.visit, "undo")); await settle(x.page);
    const back = await x.page.evaluate(row, HOME(K.visit));
    assert.deepEqual([back.title, back.icons.map((i) => i.word)], ["Visit seeds.example?", ["Allow", "Not now", "Review"]], "Undo: the icons again");
    assert.deepEqual(await sent(), []);
    await x.page.click(act(K.visit, "yes")); await settle(x.page);
    assert.equal(await x.page.evaluate(() => { const due = window.__holds.filter(Boolean); window.__holds = []; due.forEach((fn) => fn()); return due.length; }), 1, "one answer is held");
    // The answered card leaves when its Undo moment passes (the held timer, fired above) and its answer goes out. What is
    // waited for is that: no Undo on it, and the answer sent. It used to wait for no card with this Pip's key at all,
    // and the same Pip's next card ("The tomatoes want water tomorrow.") takes that key about a frame later: a wait
    // that first looked after that frame never saw the key free, and timed out at 30 s (about one run in three).
    await x.page.waitForFunction(([undo]) => !document.querySelector(undo) && window.__requests.some((r) => r.type === "decide_pip_computer_action"), [act(K.visit, "undo")]);
    await settle(x.page);
    assert.notEqual((await x.page.evaluate(row, HOME(K.visit)))?.title, "Allowed. Garden notes opens seeds.example.", "the answered card has left");
    assert.deepEqual((await sent()).map((r) => r.type), ["decide_pip_computer_action"], "sent once when the moment passed");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Home, reduced motion: the pill is there at once and nothing moves", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCards(browser, { width: 300, motion: "reduce" });
  try {
    const rest = await x.page.evaluate(row, HOME(K.visit));
    await x.page.hover(act(K.visit, "yes"));
    const now = await x.page.evaluate(row, HOME(K.visit));
    assert.deepEqual([now.pill.shown, now.pill.word, now.pill.moving], [true, "Allow", 0], "shown whole in the same frame, with no move");
    // (On a Home card the row takes the widest answer's room while a pill is up, so no pill lies on the card's words:
    // 13 Nov, side-bar-ui13.test.mjs. The pill is the row as it is now; the row's right edge is where it was.)
    assert.ok(Math.abs(now.pill.left - now.row.left) <= 0.5 && Math.abs(now.pill.right - rest.row.right) <= 0.5 && now.row.left <= rest.row.left + 0.5, "already at its full size");
    assert.deepEqual(now.icons.map((i) => i.iconAt), ["none", "none", "none"], "no icon slides");
    await x.page.hover(act(K.visit, "no"));
    const next = await x.page.evaluate(row, HOME(K.visit));
    assert.deepEqual([next.pill.word, next.pill.moving], ["Not now", 0], "an instant swap");
  } finally { await x.close(); }
});

test("Home, forced colours: every icon button and the pill have a drawn edge", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCards(browser, { width: 300, theme: "hc", forced: true });
  try {
    const clear = (c) => /rgba\(.*, 0\)|transparent/.test(c);
    const c = await x.page.evaluate(row, HOME(K.visit));
    assert.deepEqual(c.icons.filter((i) => i.edge !== "1px solid" || clear(i.line)).map((i) => i.word), [], "each square has a 1 px edge in a system colour");
    assert.notEqual(c.icons[0].fill, c.icons[1].fill, "the main answer is still told apart");
    await x.page.hover(act(K.visit, "no")); await settle(x.page);
    const on = await x.page.evaluate(row, HOME(K.visit));
    assert.deepEqual([on.pill.shown, on.pill.word, on.pill.edge, clear(on.pill.line)], [true, "Not now", "1px solid", false], "the pill has its edge");
  } finally { await x.close(); }
});

test("Home, a finger: a tap is a click", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCards(browser, { width: 300, touch: true });
  try {
    await x.page.tap(act(K.visit, "no")); await settle(x.page);
    const held = await x.page.evaluate(row, HOME(K.visit));
    assert.deepEqual([held.title, held.words.map((w) => w.word)], ["Not now. Garden notes won’t open seeds.example.", ["Undo"]], "one tap answered");
  } finally { await x.close(); }
});

// ---- the Pips page's Needs attention -----------------------------------------------------------------------------------
const ITEM = (kind) => `.attention-item[data-attention-key^="${kind}:"]`;
async function attention(t, options = {}) {
  const x = await openChat(browser, { width: 300, height: 800, theme: "dark", motion: "no-preference", home: true, answers: true, waiting: 1, ...options });
  t.after(x.close);
  await x.p.waitForSelector(".attention-toggle");
  await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".attention-count")?.textContent === "3");
  // (What a card may answer by itself is read after the list: wait for the change's own answers.)
  const go = async (kind) => { for (const way of ["next", "prev"]) for (let i = 0; i < 4 && !(await x.p.locator(ITEM(kind)).count()) && await x.p.locator(`#attention-${way}:not(:disabled)`).count(); i++) { await x.p.click(`#attention-${way}`); await settle(x.p, 260); } await x.p.waitForSelector(`${ITEM(kind)} .dgc-ia`); await x.p.mouse.move(2, 2); await settle(x.p, 260); };
  const sent = () => x.p.evaluate(() => (window.__sent || []).filter((r) => /^(accept_pip_update|reject_pip_update|decide_pip_computer_action)$/.test(r.type)));
  return { ...x, go, sent };
}

for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
  test(`Needs attention, ${theme} ${width}px: a card's answers rest as icons at its right; the card itself still opens it`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await attention(t, { theme, width, where: width > 400 ? "tab" : "side" });
    await x.go("approval");
    await x.p.waitForFunction((s) => (window.__pipsRoot || document).querySelectorAll(`${s} .dgc-ia-btn`).length === 3, ITEM("approval"));
    const c = await x.p.evaluate(row, ITEM("approval"));
    assert.deepEqual(c.icons.map((i) => `${i.word}/${i.icon}${i.primary ? "*" : ""}`), ["Apply/check*", "Not now/x", "Review/eye"], "the answers Home offers for a Pip's change");
    assert.deepEqual([...new Set(c.icons.map((i) => `${i.width}x${i.height}`))], ["24x24"]);
    assert.deepEqual(c.icons.map((i) => i.filled), [true, false, false], "the main one filled");
    assert.deepEqual(c.icons.filter((i) => i.wordShown || i.tip !== null).map((i) => i.word), [], "named by their words, no tooltip");
    assert.equal(c.row.width, 76);
    const card = await x.p.evaluate((s) => { const r = window.__pipsRoot || document, b = r.querySelector(`${s} .attention-row`).getBoundingClientRect(), w = r.querySelector(`${s} .attention-copy`).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, words: w.right }; }, ITEM("approval"));
    assert.ok(c.row.right <= card.right - 6 && c.row.right >= card.right - 14 && c.row.top >= card.top + 3 && c.row.bottom <= card.bottom - 3, "inside the card, at its right");
    assert.ok(card.words <= c.row.left, "the words stop before them");
    assert.equal(await x.p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "nothing runs off the side");
    // What only opens has the one way in, as an icon.
    await x.go("app_link");
    assert.deepEqual((await x.p.evaluate(row, ITEM("app_link"))).icons.map((i) => `${i.word}/${i.icon}${i.primary ? "*" : ""}`), ["Review/eye*"], "a card with nothing to answer here: Review alone");
    await x.go("computer_action");
    await x.p.waitForFunction((s) => (window.__pipsRoot || document).querySelectorAll(`${s} .dgc-ia-btn`).length === 3, ITEM("computer_action"));
    assert.deepEqual((await x.p.evaluate(row, ITEM("computer_action"))).icons.map((i) => i.word), ["Allow", "Not now", "Review"], "a visit to a new site");
    // The card itself still opens it.
    await x.p.click(`${ITEM("computer_action")} .attention-row`);
    await x.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector(".attention"));
    assert.deepEqual(await x.sent(), [], "opening answered nothing");
    assert.deepEqual(x.errors, []);
  });
}

test("Needs attention: the pill on the pointer and on Tab, switching along the row; Review opens the card", async (t) => {
  if (skipOrFail(t)) return;
  const x = await attention(t);
  await x.go("approval");
  await x.p.waitForFunction((s) => (window.__pipsRoot || document).querySelectorAll(`${s} .dgc-ia-btn`).length === 3, ITEM("approval"));
  const rest = await x.p.evaluate(row, ITEM("approval"));
  await x.p.hover(`${ITEM("approval")} [data-attention-answer="yes"]`); await settle(x.p);
  const apply = await x.p.evaluate(row, ITEM("approval"));
  assert.deepEqual([apply.pill.shown, apply.pill.word, apply.pill.primary], [true, "Apply", true]);
  assert.deepEqual(apply.icons.map((i) => [i.left, i.top]), rest.icons.map((i) => [i.left, i.top]), "the boxes stay");
  await x.p.hover(`${ITEM("approval")} [data-attention-answer="no"]`); await settle(x.p);
  assert.equal((await x.p.evaluate(row, ITEM("approval"))).pill.word, "Not now");
  await x.p.mouse.move(2, 2); await settle(x.p);
  assert.equal((await x.p.evaluate(row, ITEM("approval"))).on, false);
  await x.p.focus(`${ITEM("approval")} .attention-row`);
  await x.p.keyboard.press("Tab"); await settle(x.p);
  const tab = await x.p.evaluate(row, ITEM("approval"));
  assert.deepEqual([tab.pill.shown, tab.pill.word, tab.kbd], [true, "Apply", true], "Tab from the card reaches its first answer");
  assert.match(tab.pill.ring, /^solid [12]px$/);
  await x.p.keyboard.press("Tab"); await settle(x.p);
  assert.equal((await x.p.evaluate(row, ITEM("approval"))).pill.word, "Not now");
  await x.p.keyboard.press("Tab"); await settle(x.p);
  assert.equal((await x.p.evaluate(row, ITEM("approval"))).pill.word, "Review");
  await x.p.keyboard.press("Enter");
  await x.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector(".attention"));
  assert.deepEqual(await x.sent(), [], "Review opened it and answered nothing");
});

test("Needs attention: a click answers once, after a moment to undo", async (t) => {
  if (skipOrFail(t)) return;
  const x = await attention(t);
  await x.p.evaluate(() => { const later = window.setTimeout.bind(window); window.__holds = [];
    window.setTimeout = (fn, ms, ...rest) => (ms === 6000 ? (window.__holds.push(fn), 900000 + window.__holds.length) : later(fn, ms, ...rest));
    const clear = window.clearTimeout.bind(window); window.clearTimeout = (id) => { if (id > 900000) window.__holds[id - 900001] = null; else clear(id); }; });
  await x.go("approval");
  await x.p.waitForFunction((s) => (window.__pipsRoot || document).querySelectorAll(`${s} .dgc-ia-btn`).length === 3, ITEM("approval"));
  await x.p.click(`${ITEM("approval")} [data-attention-answer="yes"]`); await settle(x.p);
  const held = await x.p.evaluate(row, ITEM("approval"));
  assert.equal(held.title, "Applied. Mornings is changed.", "the card says what it will do");
  assert.deepEqual([held.row, held.words.map((w) => w.word)], [null, ["Undo"]], "with Undo as a plain word button");
  assert.deepEqual(await x.sent(), [], "nothing is sent yet");
  await x.p.click(`${ITEM("approval")} .attention-undo`); await settle(x.p);
  assert.deepEqual((await x.p.evaluate(row, ITEM("approval"))).icons.map((i) => i.word), ["Apply", "Not now", "Review"], "Undo: the icons again");
  assert.deepEqual(await x.sent(), []);
  await x.p.click(`${ITEM("approval")} [data-attention-answer="yes"]`); await settle(x.p);
  assert.equal(await x.p.evaluate(() => { const due = window.__holds.filter(Boolean); window.__holds = []; due.forEach((fn) => fn()); return due.length; }), 1);
  await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".attention-count")?.textContent === "2");
  assert.deepEqual(await x.sent(), [{ type: "accept_pip_update", pip_id: PIP, proposal_id: "proposal_a1a1a1a1", expected_version: 2 }], "the Pips page's own command, once");
  assert.equal(await x.p.locator(ITEM("approval")).count(), 0, "answered: the card is gone");
  // A visit to a new site: its digest is read again before it is decided.
  await x.go("computer_action");
  await x.p.waitForFunction((s) => (window.__pipsRoot || document).querySelectorAll(`${s} .dgc-ia-btn`).length === 3, ITEM("computer_action"));
  await x.p.click(`${ITEM("computer_action")} [data-attention-answer="no"]`); await settle(x.p);
  assert.equal((await x.p.evaluate(row, ITEM("computer_action"))).title, "Not now. Mornings won’t open seeds.example.");
  await x.p.evaluate(() => { const due = window.__holds.filter(Boolean); window.__holds = []; due.forEach((fn) => fn()); });
  await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".attention-count")?.textContent === "1");
  assert.deepEqual((await x.sent()).slice(1), [{ type: "decide_pip_computer_action", action_id: "compact_" + "5".repeat(32), expected_digest: "d".repeat(64), approve: false }]);
  assert.deepEqual(x.errors, []);
});

test("Needs attention, reduced motion, forced colours and a finger", async (t) => {
  if (skipOrFail(t)) return;
  const still = await attention(t, { motion: "reduce" });
  await still.go("approval");
  await still.p.waitForFunction((s) => (window.__pipsRoot || document).querySelectorAll(`${s} .dgc-ia-btn`).length === 3, ITEM("approval"));
  await still.p.hover(`${ITEM("approval")} [data-attention-answer="no"]`);
  const now = await still.p.evaluate(row, ITEM("approval"));
  assert.deepEqual([now.pill.shown, now.pill.word, now.pill.moving, now.icons.map((i) => i.iconAt)], [true, "Not now", 0, ["none", "none", "none"]], "reduced motion: an instant swap");
  const hc = await attention(t, { forced: true });
  await hc.go("approval");
  await hc.p.waitForFunction((s) => (window.__pipsRoot || document).querySelectorAll(`${s} .dgc-ia-btn`).length === 3, ITEM("approval"));
  const clear = (c) => /rgba\(.*, 0\)|transparent/.test(c);
  const edges = await hc.p.evaluate(row, ITEM("approval"));
  assert.deepEqual(edges.icons.filter((i) => i.edge !== "1px solid" || clear(i.line)).map((i) => i.word), [], "forced colours: each square has its edge");
  const finger = await attention(t, { touch: true });
  await finger.go("approval");
  await finger.p.waitForFunction((s) => (window.__pipsRoot || document).querySelectorAll(`${s} .dgc-ia-btn`).length === 3, ITEM("approval"));
  await finger.p.tap(`${ITEM("approval")} [data-attention-answer="yes"]`); await settle(finger.p);
  assert.equal((await finger.p.evaluate(row, ITEM("approval"))).title, "Applied. Mornings is changed.", "a finger: one tap answered");
});

// ---- everywhere else: full buttons, as before ---------------------------------------------------------------------------
test("a card in a Work session keeps its full buttons", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openWork(browser, { part: "asks", width: 460 });
  try {
    const found = await page.evaluate(() => ({ icons: document.querySelectorAll(".dgc-ia, .dgc-ia-btn").length,
      buttons: [...document.querySelectorAll("#log .card button.act, .card button.act")].filter((b) => b.checkVisibility()).map((b) => ({ word: b.textContent.trim(), width: Math.round(b.getBoundingClientRect().width), svg: !!b.querySelector("svg") })) }));
    assert.equal(found.icons, 0, "no icon row in a session");
    const allow = found.buttons.filter((b) => ["Allow once", "Always allow", "Deny"].includes(b.word));
    assert.equal(allow.length, 3, `a command's three answers (${found.buttons.map((b) => b.word)})`);
    assert.deepEqual(allow.filter((b) => b.width < 60 || b.svg).map((b) => b.word), [], "each a full button with its word");
  } finally { await page.close(); }
});

test("a card in a Pip's chat keeps its full buttons", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { width: 300, changes: ["schedule"] });
  t.after(x.close);
  await x.p.waitForSelector("[data-change-card] .dgc-card-btn");
  const found = await x.p.evaluate(() => { const r = window.__pipsRoot || document; return { icons: r.querySelectorAll(".dgc-ia, .dgc-ia-btn").length,
    buttons: [...r.querySelectorAll("[data-change-card] .dgc-card-actions .dgc-card-btn")].map((b) => ({ word: b.textContent.trim(), width: Math.round(b.getBoundingClientRect().width), svg: !!b.querySelector("svg") })) }; });
  assert.equal(found.icons, 0, "no icon row in a Pip's chat");
  assert.ok(found.buttons.length >= 2, `its answers (${found.buttons.map((b) => b.word)})`);
  assert.deepEqual(found.buttons.filter((b) => !b.word || b.width < 60 || b.svg).map((b) => b.word), [], "each a full button with its word");
});

test("ChatDGC never loads the icon row, and the shared card draws full buttons unless a page hands it a row", () => {
  const page = readFileSync(`${here}src/chatdgc.ts`, "utf8"), script = readFileSync(`${here}media/chatdgc.js`, "utf8"), css = readFileSync(`${here}media/chatdgc.css`, "utf8");
  assert.doesNotMatch(page + script + css, /iconactions|DgcIconActions|dgc-ia/, "ChatDGC's page, script and stylesheet know nothing of it");
  assert.doesNotMatch(readFileSync(`${here}media/shared/card.css`, "utf8"), /dgc-ia/, "nor does the shared card's look");
  const work = readFileSync(`${here}media/main.js`, "utf8");
  assert.doesNotMatch(work, /DgcIconActions/, "Work's own script draws no icon row: only Home's hub does (media/shared/hub.js)");
});
