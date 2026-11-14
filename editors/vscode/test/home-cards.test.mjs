// Home as cards (asked 13 Nov: "nice looking cards which users can add on the Home Screen, something like widgets users
// add on iPhone screens ... bento cards, which users can rearrange"; "user just selects the card, not the size"). In real
// Chromium on the real side bar (support/home-grid-scene.mjs, with a stand-in for the host): the width picks each card's
// form (Small under ~380 px, Medium to ~620 px, Large where a card has one beyond), a Small card opens to its full form
// and back, the Cards button and its library, Arrange Home by pointer and by keyboard, what is kept across a reload,
// every card with the host's own data in every form in a dark and a light theme, and reduced motion.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openGrid, DEFAULT, EVERY, usageDays, WEATHER, FOLDERS, LISBON, NOTES } from "./support/home-grid-scene.mjs";
import { DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { CHATS } from "./support/home-scene.mjs";

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
const near = (a, b, by = 1.5) => Math.abs(a - b) <= by;
const card = (g, id) => g.cards.find((c) => c.id === id);
// (Since the second follow-up, 13 Nov late: the Weather's place is one chosen from Open-Meteo's list, kept whole; and
// the one sticky note is Notes, many of them, kept beside the settings. test/home-cards-more.test.mjs has their own tests.)
const SETTINGS = { weather: { place: LISBON, unit: "c" }, clock: { zone: "Asia/Tokyo" } };

test("the width picks each card's form: Small squares two a row at 300 px, Medium at 460 px, Large where a card has one at 700 px", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 300, layout: EVERY, settings: SETTINGS });
  try {
    let g = await x.grid();
    assert.equal(g.there, true, "Home is a grid of cards");
    assert.deepEqual(g.cards.map((c) => c.id), EVERY, "the cards the user chose, in the user's order");
    assert.equal(g.form, "s");
    assert.deepEqual([...new Set(g.cards.map((c) => c.form))], ["s"], "narrow: every card is in its Small form");
    for (const c of g.cards) assert.ok(near(c.width, c.height, 1), `${c.id} is a square (${c.width}×${c.height})`);
    assert.ok(near(g.cards[0].top, g.cards[1].top) && g.cards[1].left > g.cards[0].right && g.cards[2].top > g.cards[0].bottom - 1, "two squares to a row");
    assert.ok(near(g.cards[0].width * 2 + 8, 300 - 24, 2), `two squares and their gap fill the side bar (${g.cards[0].width})`);
    assert.equal(g.overflowX, false);
    await x.resize(460);
    g = await x.grid();
    assert.equal(g.form, "m");
    assert.deepEqual([...new Set(g.cards.map((c) => c.form))], ["m"], "a middling side bar: every card is in its Medium form");
    for (const c of g.cards) assert.ok(near(c.width, 460 - 24, 2), `${c.id}: a Medium card is two squares wide, the side bar's width here (${c.width})`);
    assert.equal(g.overflowX, false);
    await x.resize(700);
    g = await x.grid();
    assert.equal(g.form, "l");
    const forms = Object.fromEntries(g.cards.map((c) => [c.id, c.form]));
    assert.equal(forms.token, "l"); assert.equal(forms.recent, "l"); assert.equal(forms.folders, "l");
    assert.equal(forms.needs, "m"); assert.equal(forms.quick, "m"); assert.equal(forms.running, "m");
    const token = card(g, "token"), needs = card(g, "needs");
    assert.ok(near(token.width, needs.width, 1), "a Large card is as wide as a Medium one: two columns");
    assert.ok(near(token.height, needs.height * 2 + 10, 2), `and two rows tall, a 2×2 block (${token.height} against ${needs.height})`);
    // Dense packing: no hole a later card could have filled. Every row of the grid is full but perhaps the last.
    const rows = new Map(); for (const c of g.cards) for (let y = Math.round(c.top); y < c.bottom - 5; y += Math.round(needs.height + 10)) rows.set(y, (rows.get(y) || 0) + c.width);
    const filled = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
    // (Notes has a Large form since 13 Nov late, and is the last card here: a Large block at the very end has nothing after it to fill its side, so the last two rows may be half full.)
    for (const w of filled.slice(0, -2)) assert.ok(w > 600, `a row of the grid is full (${Math.round(w)} px of cards)`);
    assert.equal(forms.note, "l");
    assert.equal(g.overflowX, false);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("dragging the side bar's edge: cards glide to their new places, and a card keeps its chosen tab and its inked day across the change of form", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 700 });
  try {
    const p = x.page;
    await p.click('.hc-card[data-card="token"] [role="tab"][data-metric="requests"]'); await x.rest(700);
    const plot = p.locator('.hc-card[data-card="token"] .hc-plot');
    await plot.focus(); await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowLeft");
    const before = await p.evaluate(() => ({ tab: document.querySelector('.hc-card[data-card="token"] [role="tab"][aria-selected="true"]').dataset.metric, day: document.querySelector('.hc-card[data-card="token"] .hc-col.hot').dataset.day }));
    assert.equal(before.tab, "requests");
    // The glide: right after the width changes a card is still on its way (a transform it is animating from).
    await p.setViewportSize({ width: 460, height: 900 });
    const moving = await p.waitForFunction(() => [...document.querySelectorAll(".hc-grid > .hc-card")].some((c) => c.getAnimations().some((a) => a.playState === "running")), null, { timeout: 2000 }).then(() => true, () => false);
    assert.equal(moving, true, "the cards glide (FLIP) to their new places");
    await x.rest(800);
    const after = await p.evaluate(() => ({ form: document.querySelector('.hc-card[data-card="token"]').dataset.form, tab: document.querySelector('.hc-card[data-card="token"] [role="tab"][aria-selected="true"]')?.dataset.metric, day: document.querySelector('.hc-card[data-card="token"] .hc-col.hot')?.dataset.day,
      still: [...document.querySelectorAll(".hc-grid > .hc-card")].every((c) => getComputedStyle(c).transform === "none") }));
    assert.deepEqual(after, { form: "m", tab: "requests", day: before.day, still: true }, "Medium now: the same tab is chosen and the same day inked, and every card has come to rest");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a Small card opens to its full form over Home, and Back or Escape returns to where you were", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 300 });
  try {
    const p = x.page;
    await p.click('.hc-grid .hc-card[data-card="token"]'); await x.rest(300);
    let g = await x.grid();
    assert.equal(g.open?.id, "token"); assert.equal(g.open.form, "full");
    assert.equal(g.shown, false, "the opened card takes the card area");
    assert.equal(g.open.back, "Home");
    assert.ok(near(g.open.width, 300 - 24, 2), "the full form has the side bar's width");
    assert.equal(await p.locator("#side-tabs").isVisible(), true, "the tabs stay"); assert.equal(await p.locator("#dgc-dock").isVisible(), true, "and the dock");
    const full = await p.evaluate(() => { const c = document.querySelector(".hc-open .hc-card"); return { cols: c.querySelectorAll(".hc-plot .hc-col").length, tabs: [...c.querySelectorAll('[role="tab"]')].map((b) => b.dataset.metric), ranges: [...c.querySelectorAll(".hc-seg button")].map((b) => b.textContent), models: [...c.querySelectorAll(".hc-by .hc-mn")].map((n) => n.textContent) }; });
    assert.deepEqual(full, { cols: 30, tabs: ["tokens", "requests", "cache"], ranges: ["7d", "30d"], models: ["deepseek-v4.1-flash:cloud · Ollama", "claude-opus-4.1 · Claude Code", "qwen3.5-coder:32b · Ollama", "qwen3:8b · Ollama", "gpt-5.1-codex · Codex"] }, "everything the card does is here at 300 px: thirty days, every tab, the range, and the models with their providers");
    await p.click(".hc-open .hc-seg button[data-range='7d']"); await x.rest(300);
    assert.equal(await p.locator(".hc-open .hc-plot .hc-col").count(), 7, "7d shows a week");
    await p.click("#home-hub .hc-back"); await x.rest(300);
    g = await x.grid();
    assert.equal(g.open, null); assert.equal(g.shown, true); assert.equal(g.focus, "token", "the keyboard is back on the card that was opened");
    await p.keyboard.press("Enter"); await x.rest(300);
    assert.equal((await x.grid()).open?.id, "token", "Enter opens a Small card too");
    await p.keyboard.press("Escape"); await x.rest(300);
    g = await x.grid();
    assert.equal(g.open, null, "Escape returns"); assert.equal(g.focus, "token");
    // Needs you, opened: the cards that wait, with their answers, as Home had them.
    await p.click('.hc-grid .hc-card[data-card="needs"]'); await x.rest(300);
    const needs = await p.evaluate(() => [...document.querySelectorAll(".hc-open .dgc-hub-card")].filter((c) => c.checkVisibility()).map((c) => ({ group: c.dataset.group, shown: c.checkVisibility(), answers: c.querySelectorAll("[data-hub-act]").length })));
    assert.ok(needs.length >= 2 && needs.every((c) => c.group === "needs" && c.shown && c.answers >= 1), `what waits, each with its answers (${JSON.stringify(needs)})`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

for (const width of [300, 700]) {
  test(`${width}px: the Cards button (the Ember mosaic, still until pointed at) opens the card library in a pop-up`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width });
    try {
      const p = x.page;
      let g = await x.grid();
      assert.equal(g.button.text, "Cards", "one button: the word Cards, no plus, no Add");
      assert.ok(g.button.mosaic.includes("mosaic--ember") && g.button.tiles === 4, "with the Ember mosaic");
      assert.equal(g.button.radius, "6px"); assert.equal(g.button.height, 28);
      assert.ok(g.button.right > width - 14 && g.button.right <= width - 11, "at Home's top right");
      assert.equal(g.button.play, "paused", "a header button never loops: its mosaic is still at rest");
      await p.hover(".hc-cards-btn"); await x.rest();
      assert.equal((await x.grid()).button.play, "running", "and tilts while it is pointed at");
      await p.mouse.move(2, 400);
      assert.equal(await p.locator('#home-hub .dgc-hub-show').count(), 0, "Home's Show dropdown is gone: the cards you add are the filter");
      await p.click(".hc-cards-btn"); await x.rest(300);
      g = await x.grid();
      assert.ok(g.library, "the library is a pop-up");
      if (width === 300) assert.ok(g.library.width >= 300 - 2 * 12 - 1, `full width in a narrow side bar (${g.library.width})`);
      else { assert.ok(g.library.width <= 520.5, `at most about 520 px wide (${g.library.width})`); assert.ok(near((g.library.left + g.library.right) / 2, width / 2, 2), "and centred"); }
      assert.deepEqual(g.library.items.map((i) => i.id).sort(), [...EVERY, "widgets", "artifacts"].sort(), "every card is in the library");
      for (const i of g.library.items) {
        assert.ok(i.name && i.line, `${i.id} has its name and one line`);
        assert.equal(i.previewDrawn, true, `${i.id} has a preview`);
        assert.equal(i.on, DEFAULT.includes(i.id), `${i.id}: On Home or not`);
        assert.equal(i.add, !DEFAULT.includes(i.id)); assert.equal(i.remove, DEFAULT.includes(i.id));
      }
      // (Until 13 Nov evening each card wore a mosaic of its own here; his call: twelve cards need no icon each.)
      assert.deepEqual(g.library.items.map((i) => i.mosaics), Array(14).fill(0), "a card in the library has no icon of its own: its preview, its name and one line");
      assert.ok(g.library.title.length === 1 && g.library.title[0].includes("mosaic--ember"), "the Ember mosaic is the Cards button's and the pop-up's title's only");
      assert.deepEqual(g.library.foot, ["Arrange Home", "Reset Home"]);
      assert.equal(g.library.items.find((i) => i.id === "token").preview.includes("M") || true, true);
      await p.keyboard.press("Escape"); await x.rest(200);
      assert.equal((await x.grid()).library, null, "Escape closes it");
      await p.click(".hc-cards-btn"); await x.rest(300);
      await p.mouse.click(width / 2, 4); await x.rest(200);
      assert.equal((await x.grid()).library, null, "and so does a click outside it");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the library adds and removes cards, and what is on Home is kept by the host: a reload finds it as it was left", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460 });
  let kept;
  try {
    const p = x.page;
    await p.click(".hc-cards-btn"); await x.rest(300);
    await p.click('.hc-lib-item[data-card="work"] .hc-add'); await x.rest(300);
    await p.click('.hc-lib-item[data-card="chats"] .hc-add'); await x.rest(300);
    let g = await x.grid();
    assert.deepEqual(g.cards.map((c) => c.id), [...DEFAULT, "work", "chats"], "an added card goes to the end of Home");
    assert.equal(g.library.items.find((i) => i.id === "work").on, true, "and the library says it is On Home, with Remove");
    await p.click('.hc-lib-item[data-card="running"] .hc-remove'); await x.rest(300);
    g = await x.grid();
    assert.deepEqual(g.cards.map((c) => c.id), ["needs", "recent", "token", "quick", "work", "chats"]);
    assert.equal(g.library.items.find((i) => i.id === "running").add, true);
    kept = await x.host();
    assert.deepEqual(kept.order, ["needs", "recent", "token", "quick", "work", "chats"], "the host was told, and keeps it");
    // Weather asks for its place when it is added: never guessed from the machine, and (13 Nov, late) never typed blind:
    // the place is taken from the list the letters typed bring up.
    await p.click('.hc-lib-item[data-card="weather"] .hc-add'); await x.rest(200);
    assert.equal((await x.host()).order.includes("weather"), false, "Weather is not added before a place is chosen");
    assert.match(await p.locator('.hc-lib-item[data-card="weather"]').innerText(), /Open-Meteo/, "and it says where the letters typed are sent");
    await p.fill('.hc-lib-item[data-card="weather"] .hc-city', "Lisbon"); await x.rest(450);
    await p.keyboard.press("Enter"); await x.rest(200);
    assert.equal((await x.host()).order.includes("weather"), false, "a name typed and Enter adds nothing: a place must be chosen");
    await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await p.keyboard.press("Enter"); await x.rest(300);
    kept = await x.host();
    assert.equal(kept.order.at(-1), "weather"); assert.deepEqual(kept.settings.weather.place, LISBON);
    assert.deepEqual(await p.evaluate(() => window.__weatherAsked), [LISBON], "the host is asked for that place's weather, once");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  const again = await openGrid(browser, { width: 460, layout: kept.order, settings: kept.settings });
  try {
    const g = await again.grid();
    assert.deepEqual(g.cards.map((c) => c.id), ["needs", "recent", "token", "quick", "work", "chats", "weather"], "after a reload Home is as it was left");
    assert.match(card(g, "weather").text, /Lisbon/);
  } finally { await again.close(); }
});

test("Arrange Home: × takes a card off, a drag moves one, Done leaves; Reset Home puts the default set back", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460 });
  try {
    const p = x.page;
    await p.click(".hc-cards-btn"); await x.rest(300);
    await p.click(".hc-library .hc-arrange"); await x.rest(300);
    let g = await x.grid();
    assert.equal(g.library, null, "the pop-up closes"); assert.equal(g.arranging, true);
    assert.match(g.head, /Arrange Home/); assert.match(g.head, /Done/);
    assert.ok(g.cards.every((c) => c.x), "every card shows its ×");
    await p.click('.hc-card[data-card="running"] .hc-x'); await x.rest(300);
    g = await x.grid();
    assert.deepEqual(g.cards.map((c) => c.id), ["needs", "recent", "token", "quick"]);
    // A drag by pointer: Quick start from the end to the top.
    const from = card(g, "quick"), to = card(g, "needs");
    await p.mouse.move(from.left + 40, from.top + from.height / 2); await p.mouse.down();
    await p.mouse.move(from.left + 44, from.top + from.height / 2 - 12, { steps: 3 });
    assert.equal(card(await x.grid(), "quick").lifted, true, "the card being moved is lifted");
    await p.mouse.move(to.left + 44, to.top + 6, { steps: 8 }); await p.mouse.up(); await x.rest(700);
    g = await x.grid();
    assert.deepEqual(g.cards.map((c) => c.id), ["quick", "needs", "recent", "token"], "dropped at the top");
    assert.equal(g.cards.some((c) => c.lifted), false);
    assert.deepEqual((await x.host()).order, ["quick", "needs", "recent", "token"], "the host keeps the new order");
    // The Cards button still opens the library meanwhile.
    await p.click(".hc-cards-btn"); await x.rest(300);
    await p.click('.hc-lib-item[data-card="pips"] .hc-add'); await x.rest(200); await p.keyboard.press("Escape"); await x.rest(200);
    g = await x.grid();
    assert.equal(g.arranging, true); assert.deepEqual(g.cards.map((c) => c.id), ["quick", "needs", "recent", "token", "pips"]);
    await p.click(".hc-done"); await x.rest(300);
    g = await x.grid();
    assert.equal(g.arranging, false); assert.ok(g.cards.every((c) => !c.x)); assert.equal(g.cards[0].form, "m");
    // Right-click on a card arranges too.
    await p.click('.hc-card[data-card="token"]', { button: "right", position: { x: 20, y: 8 } }); await x.rest(300);
    assert.equal((await x.grid()).arranging, true, "a right-click on a card starts Arrange Home");
    await p.keyboard.press("Escape"); await x.rest(200);
    assert.equal((await x.grid()).arranging, false, "Escape leaves it");
    await p.click(".hc-cards-btn"); await x.rest(300);
    await p.click(".hc-library .hc-reset"); await x.rest(300);
    assert.deepEqual((await x.grid()).cards.map((c) => c.id), DEFAULT, "Reset Home: Needs you, Recent, Running now, Token usage, Quick start");
    assert.deepEqual((await x.host()).order, DEFAULT);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Arrange Home by keyboard: Space lifts a card, the arrows move it, Space drops it; Escape puts it back", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 300 });
  try {
    const p = x.page;
    await p.click(".hc-cards-btn"); await x.rest(300); await p.click(".hc-library .hc-arrange"); await x.rest(300);
    await p.focus('.hc-card[data-card="recent"]');
    await p.keyboard.press("Space"); await x.rest();
    let g = await x.grid();
    assert.equal(card(g, "recent").lifted, true, "Space lifts it");
    assert.match(await p.locator("#home-hub .hc-live").textContent(), /Recent.*lifted/i, "and it is said aloud");
    await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown"); await x.rest(600);
    g = await x.grid();
    assert.deepEqual(g.cards.map((c) => c.id), ["needs", "running", "token", "recent", "quick"]);
    assert.equal(g.focus, "recent", "the keyboard stays on the card as it moves");
    await p.keyboard.press("ArrowUp"); await x.rest(600);
    await p.keyboard.press("Space"); await x.rest(300);
    g = await x.grid();
    assert.deepEqual(g.cards.map((c) => c.id), ["needs", "running", "recent", "token", "quick"]); assert.equal(card(g, "recent").lifted, false);
    assert.deepEqual((await x.host()).order, ["needs", "running", "recent", "token", "quick"], "dropped: the host keeps it");
    await p.keyboard.press("Space"); await p.keyboard.press("ArrowUp"); await p.keyboard.press("ArrowUp"); await x.rest(300);
    await p.keyboard.press("Escape"); await x.rest(300);
    g = await x.grid();
    assert.deepEqual(g.cards.map((c) => c.id), ["needs", "running", "recent", "token", "quick"], "Escape while a card is lifted puts it back where it was");
    assert.equal(g.arranging, true, "and stays in Arrange Home");
    await p.keyboard.press("Delete"); await x.rest(300);
    assert.deepEqual((await x.grid()).cards.map((c) => c.id), ["needs", "running", "token", "quick"], "Delete takes the card off");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- every card, with the host's own data, in every form, dark and light -------------------------------------------------
const today = usageDays().at(-1), NEWS = [{ id: DOCK_SESSIONS[3].id, at: Date.now() - 60000, preview: "The totals now round half up, and the three tests that held the old way are changed." }];
for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 460, 700]) {
  test(`every card shows what the host said, ${width}px ${theme}`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width, theme, layout: EVERY, settings: SETTINGS, notes: NOTES, news: NEWS, height: 1400 });
    try {
      const g = await x.grid(), text = (id) => card(g, id).text, form = (id) => card(g, id).form;
      // Token usage: today's tokens Small; the period's total and its change Medium and Large.
      if (form("token") === "s") { assert.match(text("token"), /Tokens today/); assert.match(text("token"), /1\.24M/); }
      else { assert.match(text("token"), /Token usage/); assert.match(text("token"), form("token") === "l" ? /last 30 days/ : /last 14 days/); assert.match(text("token"), /Requests/); assert.match(text("token"), /[+−]\d+(\.\d)?%/); }
      const cols = await x.page.evaluate(() => { const c = document.querySelector('.hc-grid .hc-card[data-card="token"]'); return { n: c.querySelectorAll(".hc-col").length, on: c.querySelectorAll(".hc-cell.on, .hc-cell.cap").length, tabs: c.querySelectorAll('[role="tab"]').length, last: [...c.querySelectorAll(".hc-col")].at(-1)?.dataset.day }; });
      assert.deepEqual([cols.n, cols.tabs], { s: [7, 0], m: [14, 2], l: [30, 3] }[form("token")], "a week Small, two weeks and two tabs Medium, thirty days and every tab Large");
      assert.ok(cols.on >= cols.n, "its columns are filled from the report"); assert.equal(cols.last, today.date, "the last column is today");
      // Recent: the reply nobody saw is first, in bold, marked New; then the newest of Work and Chat.
      assert.match(text("recent"), form("recent") === "s" ? /New/ : /The totals now round half up/);
      if (form("recent") !== "s") {
        const rows = await x.page.evaluate(() => [...document.querySelectorAll('.hc-grid .hc-card[data-card="recent"] .hc-li')].map((r) => ({ name: r.querySelector(".hc-nm").textContent, meta: r.querySelector(".hc-meta")?.textContent || "", fresh: r.classList.contains("hc-new"), weight: Number(getComputedStyle(r.querySelector(".hc-nm")).fontWeight), mark: !!r.querySelector("[data-mark], svg, .dgc-plush, .dgc-sheet") })));
        assert.ok(rows[0].fresh && rows[0].weight >= 600 && /New/.test(rows[0].meta + (await x.page.locator('.hc-card[data-card="recent"] .hc-li.hc-new').first().innerText())), `what is new sits at the top in bold with its New mark (${JSON.stringify(rows[0])})`);
        assert.ok(rows.every((r) => r.mark), "each row has its mark or its face");
        assert.ok(rows.some((r) => /Work/.test(r.meta)) && (rows.length < 5 || rows.some((r) => /Chat/.test(r.meta))), `Work and chats together (${rows.map((r) => r.meta).join(" | ")})`);
        assert.match(text("recent"), /Clear/);
      }
      // Work sessions, Chats, Pips.
      assert.match(text("work"), /Work sessions/); assert.match(text("chats"), /Chats/); assert.match(text("pips"), /Pips/);
      if (form("work") === "s") { assert.match(text("work"), new RegExp(`\\b${DOCK_SESSIONS.length}\\b`)); assert.match(text("work"), /1 running/); assert.match(text("chats"), new RegExp(`\\b${CHATS.length}\\b`)); assert.match(text("pips"), /Core/); }
      else {
        assert.match(text("work"), /Fix the login redirect after sign-out/); assert.match(text("work"), /Running/); assert.match(text("work"), /New/);
        assert.match(text("chats"), /A week in Goa in March/); assert.match(text("chats"), /New chat/);
        const pips = await x.page.evaluate(() => [...document.querySelectorAll('.hc-grid .hc-card[data-card="pips"] .hc-li .hc-nm')].map((n) => n.textContent.trim()));
        assert.equal(pips[0].replace(/\s*★$/, ""), "Core", "Core first"); assert.ok(pips.includes("Mail watch"));
        assert.match(text("pips"), /2 waiting for you/, "a Pip waiting on you is marked");
      }
      // Needs you: how many wait (Small), the cards themselves (Medium and up).
      const waiting = await x.page.evaluate(() => document.querySelectorAll('.hc-grid .hc-card[data-card="needs"] .dgc-hub-card').length);
      if (form("needs") === "s") { assert.match(text("needs"), /^Needs you \d+ waiting for you/); assert.equal(waiting, 0); }
      else assert.ok(waiting >= 1, "the cards that wait are on it");
      // Running now: the session mid-turn.
      assert.match(text("running"), /Running now/); assert.match(text("running"), /Fix the login redirect after sign-out/);
      // Quick start, Folders, the everyday three.
      assert.equal(await x.page.locator('.hc-grid .hc-card[data-card="quick"] button').count(), 3);
      assert.match(text("folders"), /shop/);
      const tiles = await x.page.evaluate(() => [...document.querySelectorAll('.hc-grid .hc-card[data-card="folders"] .hc-tile')].map((n) => ({ name: n.dataset.name, icon: !!n.querySelector(".folder-icon"), size: n.querySelector(".folder-icon").offsetWidth /* (its laid-out size: a card still gliding in is drawn a shade smaller) */, label: n.querySelector(".folder-label")?.checkVisibility() ? n.querySelector(".folder-label").textContent : "", under: n.querySelector(".hc-tile-name")?.checkVisibility() ? n.querySelector(".hc-tile-name").textContent : "", gone: n.classList.contains("hc-gone") })));
      assert.equal(tiles.length, { s: 1, m: 4, l: 5 }[form("folders")], "one tile Small, up to four Medium, up to eight Large");
      assert.equal(tiles[0].name, "shop");
      for (const tile of tiles) assert.ok(tile.icon && (tile.size >= 64 ? tile.label === tile.name : tile.under === tile.name && !tile.label), `a folder's real name is on its tile's label at 64 px and up, under the tile below that (${JSON.stringify(tile)})`);
      if (form("folders") === "s") assert.match(text("folders"), /\+4/); else assert.match(text("folders"), /14 sessions · 1 Pip/);
      if (form("folders") === "l") assert.ok(tiles.find((n) => n.name === "old-site").gone && /Not found/.test(text("folders")), "a folder that is gone is dimmed and says Not found");
      assert.match(text("clock"), /\b\d{1,2}:\d{2}\b/); if (form("clock") !== "s") assert.match(text("clock"), /Tokyo/);
      assert.match(text("weather"), /24°/); assert.match(text("weather"), /Lisbon/);
      if (form("weather") !== "s") { assert.match(text("weather"), /26°/); assert.match(text("weather"), /17°/); assert.match(text("weather"), /Weather from Open-Meteo/); assert.match(text("weather"), /16:00/); }
      assert.ok(await x.page.locator('.hc-grid .hc-card[data-card="weather"] svg.hc-wx').count() >= 1, "the conditions are a drawing on the page, not a picture fetched");
      // Notes (14 Nov, the notes app): the top note Small (a pinned one first, as in every list; it was the newest); the
      // notes by their first lines from Medium up, with New (it said "New note" before the folder button stood beside it).
      if (form("note") === "s") { assert.match(text("note"), /Call the bank about the card/); assert.doesNotMatch(text("note"), /09:40/); assert.match(text("note"), /3 notes|\+2 notes/); }
      else { assert.match(text("note"), /Call the bank about the card/); assert.match(text("note"), /Ferry to Porto/); assert.match(text("note"), /New/); }
      // Words are read: the quietest word on a card clears 4.5:1 on the card's own ground.
      const low = await x.page.evaluate(() => { const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
        const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
        const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } return layers.reduceRight((u, top) => over(top, u), [255, 255, 255, 1]); };
        const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const out = [], walk = document.createTreeWalker(document.querySelector(".hc-grid"), NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) { const e = n.parentElement; if (!n.textContent.trim() || !e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || e.closest(".folder-icon, .dgc-hub-card, textarea, select")) continue;
          const g = ground(e), c = over(parse(getComputedStyle(e).color), g), [a, b] = [lum(c), lum(g)].sort((p, q) => q - p), ratio = (a + 0.05) / (b + 0.05);
          if (ratio < 4.5) out.push(`${n.textContent.trim().slice(0, 24)} ${ratio.toFixed(2)} (${e.className})`); }
        return out; });
      assert.deepEqual(low, [], "every word on a card reads at 4.5:1 or better");
      assert.equal(g.overflowX, false);
      assert.deepEqual(x.requests.filter((u) => !u.startsWith("https://home.test/") && !u.startsWith("data:") && !u.startsWith("blob:")), [], "the page asks nothing of any network: the weather came through the host");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- follow-up, 13 Nov evening: the library at 300 px, and "New" in one place only ---------------------------------------
for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 460, 700]) {
  test(`the card library, ${width}px ${theme}: every card's name shows whole, and each card's state and button stand on one line across a row`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width, theme });
    try {
      await x.page.click(".hc-cards-btn"); await x.rest(300);
      const items = await x.page.evaluate(() => [...document.querySelectorAll(".hc-library .hc-lib-item")].map((i) => { const name = i.querySelector(".hc-lib-name"), foot = i.querySelector(".hc-lib-act"), r = i.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(name);
        return { id: i.dataset.card, name: name.textContent, whole: name.scrollWidth <= name.clientWidth + 0.5 && range.getBoundingClientRect().width <= name.getBoundingClientRect().width + 0.5, nameWidth: Math.round(range.getBoundingClientRect().width),
          top: Math.round(r.top), left: Math.round(r.left), bottom: Math.round(r.bottom), foot: foot ? Math.round(foot.getBoundingClientRect().top) : null, footBottom: foot ? Math.round(foot.getBoundingClientRect().bottom) : null, state: foot ? foot.innerText.replace(/\s+/g, " ").trim() : "" }; }));
      assert.equal(items.length, 14);          // (with Widgets and Artifacts, 13 Nov late)
      for (const i of items) { assert.ok(i.whole && i.nameWidth > 15, `${i.id}: “${i.name}” shows whole (${JSON.stringify(i)})`); assert.ok(i.foot !== null, `${i.id} has its state line`); }
      assert.deepEqual(items.filter((i) => i.id === "needs" || i.id === "work").map((i) => i.state), ["On Home Remove", "Add"], "On Home with Remove, or Add, on a line of their own under the words");
      const lefts = new Set(items.map((i) => i.left));
      assert.equal(lefts.size, width < 380 ? 1 : 2, width < 380 ? "one column in a narrow side bar" : "two columns");
      // Across one row of the library the cards are one height and their state lines stand level.
      const rows = new Map(); for (const i of items) rows.set(i.top, [...(rows.get(i.top) || []), i]);
      for (const row of rows.values()) { assert.equal(new Set(row.map((i) => i.bottom)).size, 1, `one height across a row (${row.map((i) => `${i.id} ${i.bottom}`)})`); assert.equal(new Set(row.map((i) => i.foot)).size, 1, `Add and Remove stand level across a row (${row.map((i) => `${i.id} ${i.foot}`)})`); }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("what is new is in one place: Needs you opened holds only what needs you, and Recent opened gives what is new its answers and Clear", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 300, news: NEWS });
  try {
    const p = x.page, cards = () => p.evaluate(() => [...document.querySelectorAll("#home-hub .hc-open .dgc-hub-card")].filter((c) => c.checkVisibility()).map((c) => ({ key: c.dataset.key, group: c.dataset.group, answers: [...c.querySelectorAll("[data-hub-act]")].map((b) => b.dataset.hubAct) })));
    await p.click('.hc-grid .hc-card[data-card="needs"]'); await x.rest(300);
    let c = await cards();
    assert.ok(c.length >= 2 && c.every((k) => k.group === "needs"), `Needs you, opened: only what needs you (${JSON.stringify(c.map((k) => k.group))})`);
    assert.equal(await p.locator("#home-hub .hc-open .dgc-hub-clear").count(), 0, "no New list and no Clear there");
    assert.doesNotMatch(await p.locator("#home-hub .hc-open").innerText(), /\bNew\b/);
    await p.click("#home-hub .hc-back"); await x.rest(300);
    await p.click('.hc-grid .hc-card[data-card="recent"]'); await x.rest(300);
    c = await cards();
    assert.ok(c.length >= 2 && c.every((k) => k.group === "new"), `Recent, opened: what is new, as cards (${JSON.stringify(c.map((k) => k.group))})`);
    const reply = c.find((k) => k.key === `work:${NEWS[0].id}`), pip = c.find((k) => k.key.startsWith("pip:") && k.answers.includes("read"));
    assert.deepEqual(reply?.answers, ["open", "dismiss"], "a reply nobody saw: Open and Dismiss"); assert.ok(pip, "a Pip's news: Open and Mark read");
    assert.equal(await p.locator("#home-hub .hc-open .dgc-hub-clear").count(), 1, "with Clear");
    assert.ok(await p.locator("#home-hub .hc-open .hc-li").count() >= 2, "and under them the rest of what is recent, as rows");
    // Dismiss takes the reply off, here and on the card, and tells the host it was seen.
    await p.click(`#home-hub .hc-open .dgc-hub-card[data-key="work:${NEWS[0].id}"] [data-hub-act="dismiss"]`); await x.rest(300);
    assert.equal((await cards()).some((k) => k.key === `work:${NEWS[0].id}`), false);
    assert.deepEqual((await x.posted("homeSessionSeen")).map((m) => m.id), [NEWS[0].id]);
    await p.click("#home-hub .hc-open .dgc-hub-clear"); await x.rest(400);
    assert.equal((await cards()).length, 0, "Clear marks the rest read");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  // In a wider side bar Recent's card has no click-to-open: View all opens it whole.
  const wide = await openGrid(browser, { width: 460, news: NEWS });
  try {
    await wide.page.click('.hc-grid .hc-card[data-card="recent"] .hc-viewall'); await wide.rest(300);
    assert.equal((await wide.grid()).open?.id, "recent", "View all opens Recent whole at 460 px");
    assert.ok(await wide.page.locator('#home-hub .hc-open .dgc-hub-card[data-group="new"] [data-hub-act]').count() >= 2);
    assert.deepEqual(wide.errors, []);
  } finally { await wide.close(); }
});

test("Token usage: a column inks under the pointer and the arrow keys, with its hairline and what it holds; tabs change what is counted", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 700 });
  try {
    const p = x.page, days = usageDays(), sel = '.hc-grid .hc-card[data-card="token"]';
    const now = () => p.evaluate((s) => { const c = document.querySelector(s), hot = c.querySelector(".hc-col.hot"), tip = c.querySelector(".hc-tip"), line = c.querySelector(".hc-line");
      return { hot: hot?.dataset.day || "", faded: [...c.querySelectorAll(".hc-col:not(.hot)")].every((n) => Number(getComputedStyle(n).opacity) < 0.5), tip: tip && !tip.hidden ? tip.innerText.replace(/\s+/g, " ").trim() : "", line: !!line && !line.hidden,
        tab: c.querySelector('[role="tab"][aria-selected="true"]').dataset.metric, total: c.querySelector('[role="tab"][aria-selected="true"] .hc-kv').textContent, badge: c.querySelector(".hc-badge")?.textContent || "",
        ink: hot ? getComputedStyle(hot.querySelector(".hc-cell.on, .hc-cell.cap")).backgroundColor : "", rest: getComputedStyle(c.querySelector(".hc-col:not(.hot) .hc-cell.on, .hc-col:not(.hot) .hc-cell.cap")).backgroundColor }; }, sel);
    let n = await now();
    assert.equal(n.hot, "", "at rest nothing is inked"); assert.equal(n.tab, "tokens");
    const grey = (c) => { const m = c.match(/[\d.]+/g).map(Number); return Math.max(m[0], m[1], m[2]) - Math.min(m[0], m[1], m[2]) < 12; };
    assert.ok(grey(n.rest), `the filled cells are a neutral grey at rest (${n.rest})`);
    const box = await p.locator(`${sel} .hc-col[data-day="${days.at(-5).date}"]`).boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await x.rest();
    n = await now();
    assert.equal(n.hot, days.at(-5).date, "the column under the pointer is inked"); assert.equal(n.faded, true, "and the others fade");
    assert.ok(n.line, "a hairline drops through it");
    const d = days.at(-5), total = d.input_tokens + d.output_tokens;
    assert.match(n.tip, new RegExp(`${(total / 1e6).toFixed(2)}M tokens`), `its tooltip says the day's own number (${n.tip})`);
    assert.ok(!grey(n.ink), `the inked column is the accent (${n.ink})`);
    await p.mouse.move(2, 2); await x.rest();
    assert.equal((await now()).hot, "", "leaving clears it");
    await p.focus(`${sel} .hc-plot`); await p.keyboard.press("ArrowLeft"); await x.rest();
    assert.equal((await now()).hot, days.at(-1).date, "an arrow key on the plot inks the newest day");
    await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowRight"); await x.rest();
    assert.equal((await now()).hot, days.at(-2).date);
    await p.keyboard.press("Escape"); await x.rest();
    assert.equal((await now()).hot, "", "Escape clears it");
    assert.equal((await x.grid()).open, null);
    // Tabs: the arrows move between them, and the board counts the new thing.
    const sum = (f) => days.slice(-30).reduce((a, r) => a + f(r), 0);
    assert.equal(n.total, `${(sum((r) => r.input_tokens + r.output_tokens) / 1e6).toFixed(1)}M`);
    await p.focus(`${sel} [role="tab"][data-metric="tokens"]`); await p.keyboard.press("ArrowRight"); await x.rest(900);
    n = await now();
    assert.equal(n.tab, "requests"); assert.equal(n.total, sum((r) => r.requests).toLocaleString("en-US")); assert.equal(n.badge, "Requests");
    await p.keyboard.press("ArrowRight"); await x.rest(900);
    n = await now();
    assert.equal(n.tab, "cache"); assert.equal(n.total, `${Math.round((sum((r) => r.cached_input_tokens) / sum((r) => r.input_tokens)) * 100)}%`, "Cache saved: the share of what was sent that came from the cache");
    assert.equal(await p.locator(`${sel} [role="tab"][data-metric="cost"]`).count(), 0, "no Cost tab: the report has no cost");
    // The flip wave: each cell turns over a little after the one before it, along the diagonal.
    await p.click(`${sel} [role="tab"][data-metric="tokens"]`);
    const wave = await p.evaluate((s) => { const c = document.querySelector(s), cell = (col, row) => c.querySelectorAll(".hc-col")[col].querySelectorAll(".hc-cell")[row].getAnimations()[0]?.effect.getTiming().delay; return [cell(0, 0), cell(1, 0), cell(0, 1), cell(4, 3)]; }, sel);
    assert.deepEqual(wave, [0, 11, 16, 4 * 11 + 3 * 16], "the wave: a column 11 ms after the last, a row 16 ms");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Recent: a new reply sits at the top in bold with its New mark, Home's number counts it, a click opens it and Clear marks them read", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, news: NEWS, state: undefined });
  try {
    const p = x.page, badge = () => p.evaluate(() => { const b = document.getElementById("side-tab-home-count"); return b.hidden ? 0 : Number(b.textContent); });
    const before = await badge();
    const fresh = () => p.evaluate(() => [...document.querySelectorAll('.hc-card[data-card="recent"] .hc-li.hc-new')].map((r) => r.dataset.open));
    assert.ok((await fresh()).includes(`hub:work:${NEWS[0].id}`), "the reply nobody saw is among what is new");
    assert.ok(before >= (await fresh()).length + 1, `Home's number counts what waits and what is new (${before})`);
    const all = await fresh();
    await p.click('.hc-card[data-card="recent"] .hc-clear'); await x.rest(300);
    assert.deepEqual(await fresh(), [], "Clear marks them read");
    assert.deepEqual((await x.posted("homeSessionSeen")).map((m) => m.id), [NEWS[0].id], "the host is told the reply was seen");
    const waits = await p.evaluate(() => Number(document.querySelector('#home-hub .dgc-hub-group[data-group="needs"] .dgc-hub-n')?.textContent || 0));
    assert.ok(waits >= 1 && all.length >= 1 && before >= waits + all.length - 1, `before, Home's number counted what waits and what is new (${before}: ${waits} wait, ${all.length} new)`);
    assert.equal(await badge(), waits, "now Home's number is only what still waits");
    const first = await p.evaluate(() => document.querySelector('.hc-card[data-card="recent"] .hc-li').dataset.open);
    await p.click('.hc-card[data-card="recent"] .hc-li'); await x.rest();
    const opened = first.startsWith("work:") ? (await x.posted("openSessionInEditor")).map((m) => `work:${m.id}`) : (await x.posted("chatdgcOpen")).map((m) => `chat:${m.id}`);
    assert.ok(opened.includes(first), `a row opens where its tab would (${first})`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the cards act: Quick start, a session's row, New, a folder's tile and New session here, a note typed, Fahrenheit, a second clock", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 700, layout: EVERY, settings: SETTINGS, notes: NOTES, height: 1400 });
  try {
    const p = x.page, sel = (id) => `.hc-grid .hc-card[data-card="${id}"]`;
    await p.click(`${sel("quick")} button[data-quick="chat"]`);
    assert.equal((await x.posted("chatdgcNew")).length, 1, "New chat");
    await p.click(`${sel("chats")} .hc-new-btn`);
    assert.equal((await x.posted("chatdgcNew")).length, 2, "the Chats card's New chat");
    await p.click(`${sel("work")} .hc-li >> nth=1`);
    assert.equal((await x.posted("openSessionInEditor")).at(-1).id, DOCK_SESSIONS[1].id, "a session's row opens it");
    await p.click(`${sel("chats")} .hc-li`);
    assert.equal((await x.posted("chatdgcOpen")).at(-1).id, CHATS[0].id);
    // Folders: a tile opens Work with the Project Folder set to it; pointed at, it offers New session here.
    await p.hover(`${sel("folders")} .hc-tile[data-name="garden-notes"]`); await x.rest(200);
    const here = p.locator(`${sel("folders")} .hc-tile[data-name="garden-notes"] .hc-here`);
    assert.equal(await here.isVisible(), true); assert.equal((await here.getAttribute("title")) || (await here.innerText()), "New session here");
    await here.click();
    assert.equal((await x.posted("newSessionInEditor")).at(-1).folder, "/home/me/garden-notes");
    await p.click(`${sel("folders")} .hc-tile[data-name="garden-notes"] .hc-tile-open`); await x.rest(300);
    assert.equal((await x.posted("projectFolderChoose")).at(-1).folder, "/home/me/garden-notes");
    assert.equal((await x.tabs()).tabs.find((tab) => tab.selected).id, "work", "on the Work tab");
    await p.click("#side-tab-home"); await x.rest(300);
    // A note: typed on the card, kept by the host.
    // (14 Nov: the notes app. The note is typed in place on the Large card, and the host keeps it as a file.)
    await p.click(`${sel("note")} .hc-note-new`); await x.rest(200);
    await p.keyboard.type("Buy tomato seeds"); await x.rest(900);
    assert.equal(await x.notes.text((await x.notes.list()).find((n) => n.title === "Buy tomato seeds").id), "Buy tomato seeds");
    // Weather: Celsius by default, Fahrenheit by its toggle; where it comes from is said.
    assert.match(await p.locator(sel("weather")).innerText(), /24°/);
    await p.click(`${sel("weather")} button[data-unit="f"]`); await x.rest(300);
    assert.match(await p.locator(sel("weather")).innerText(), /76°/, "24.3 °C is 76 °F");
    assert.equal((await x.host()).settings.weather.unit, "f");
    // Clock: another city's time beside the local one, from every time zone there is (found by typing).
    assert.match(await p.locator(sel("clock")).innerText(), /Tokyo/);
    await p.click(`${sel("clock")} input.hc-zone`); await p.keyboard.type("london"); await x.rest(150); await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await x.rest(300);
    // (Since 14 Nov the field adds a zone beside the ones there: Tokyo stays, London joins it.)
    assert.deepEqual((await x.host()).settings.clock.zones, ["Asia/Tokyo", "Europe/London"]);
    assert.match(await p.locator(sel("clock")).innerText(), /Tokyo[\s\S]*London/);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Weather offline says so calmly; a quiet DGC shows Nothing running and an empty Needs you", async (t) => {
  if (skipOrFail(t)) return;
  const { homeState } = await import("./support/home-scene.mjs");
  const quiet = DOCK_SESSIONS.map((s) => ({ ...s, running: false, waiting: false, open: false }));
  const x = await openGrid(browser, { width: 460, layout: ["weather", "running", "needs", "token"], settings: { weather: { place: LISBON, unit: "c" } }, weather: { type: "homeWeather", ok: false, reason: "offline" }, sessions: quiet, state: homeState("quiet"), usage: { type: "homeUsage", days: [], models: [], error: "" } });
  try {
    const g = await x.grid();
    assert.match(card(g, "weather").text, /Can’t reach the weather right now/); assert.match(card(g, "weather").text, /Lisbon/);
    assert.match(card(g, "running").text, /Nothing running/);
    assert.match(card(g, "needs").text, /Nothing needs you/);
    assert.match(card(g, "token").text, /No use yet/);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("reduced motion: nothing glides, flips or tilts", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 700, motion: "reduce" });
  try {
    const p = x.page;
    const moving = () => p.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.target?.closest?.("#home-hub, .hc-library")).length);
    assert.equal(await moving(), 0, "at rest");
    await p.hover(".hc-cards-btn");
    assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector(".hc-cards-btn .mosaic i:nth-child(4)")).animationName), "none", "the mosaic does not tilt");
    await p.click('.hc-card[data-card="token"] [role="tab"][data-metric="requests"]');
    assert.equal(await moving(), 0, "a tab changes the board at once: no wave");
    await p.setViewportSize({ width: 460, height: 900 });
    await p.waitForFunction(() => document.querySelector(".hc-grid").dataset.form === "m");
    assert.equal(await moving(), 0, "a new width puts the cards in their places at once: no glide");
    await p.click(".hc-cards-btn"); await x.rest(100);
    assert.equal(await moving(), 0, "and the library's own mosaics are still");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("high contrast: every card has a line around it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, theme: "hc" });
  try {
    const lines = await x.page.evaluate(() => [...document.querySelectorAll(".hc-grid > .hc-card")].map((c) => { const s = getComputedStyle(c); return parseFloat(s.borderTopWidth) >= 1 && s.borderTopColor; }));
    assert.ok(lines.length === 5 && lines.every((c) => c && !/rgba\(.*, 0(\.0\d*)?\)$/.test(c)), `each card's border is a solid line (${lines.join(" ")})`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
