// The side bar's home in the 0.52 look, in real Chromium with the real panel page and Pips bundle
// (test/support/home-scene.mjs): the search box on top, then two quiet headings that fold, "Pips" and "Sessions". Open,
// a heading's end holds what it offers (Open Pips; "+" for a new session or chat); folded, its count. The Sessions list
// shows three, or every session that needs you, those first, then "View all (N)". Rows are 29 px pills in 12 px words,
// and nothing wider than a dot is purple. Dark and light, 300 and 700 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { homeState, manySessions, openHome } from "./support/home-scene.mjs";

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

const shown = (page, selector) => page.evaluate((s) => [...document.querySelectorAll(s)].map((n) => n.checkVisibility({ visibilityProperty: true }) && n.getBoundingClientRect().height > 1), selector);
const tops = (page, selectors) => page.evaluate((list) => list.map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top)), selectors);
const purple = (c) => { const m = String(c).match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; const [r, g, b, a = 1] = String(c).startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3]] : m;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (a < 0.04 || mx - mn < 18) return false; const h = mx === b ? 240 + 60 * (r - g) / (mx - mn) : mx === r ? (360 + 60 * (g - b) / (mx - mn)) % 360 : 120 + 60 * (b - r) / (mx - mn); return h > 235 && h < 290; };
const settle = (page) => page.waitForTimeout(260);

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`search on top, then Pips and Sessions under quiet headings; rows are 29px pills in 12px words (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, sessions: manySessions(20), motion: "reduce" });
    try {
      await x.page.waitForSelector("#sessions-pips .home-pip-row");
      const order = await tops(x.page, ["#sessions-search", "#sessions-pips", "#sessions-fold", "#home-tabs", "#sessions-list"]);
      assert.deepEqual(order, [...order].sort((a, b) => a - b), `top to bottom: the search box, Pips, the Sessions heading, Work | Chat, the list: ${order}`);
      const look = await x.page.evaluate(() => {
        const css = (s) => getComputedStyle(document.querySelector(s)), probe = document.createElement("i"); document.body.append(probe);
        probe.style.color = "var(--muted)"; const muted = getComputedStyle(probe).color; probe.remove();
        const row = document.querySelector("#sessions-list .session-row"), r = row.getBoundingClientRect();
        const big = [...document.querySelectorAll("#sessions-host *")].filter((n) => n.checkVisibility({ visibilityProperty: true }) && !n.closest(".home-pip-face, svg")).map((n) => { const b = n.getBoundingClientRect(); return { n: n.id || String(n.className), c: getComputedStyle(n).backgroundColor, w: b.width }; }).filter((m) => m.w > 10);
        return { muted, heads: [".home-pips-head h2", ".home-fold-h"].map((s) => [css(s).fontSize, css(s).fontWeight, css(s).color, css(s).textTransform]),
          titles: [document.querySelector(".home-pips-title").firstChild.textContent, document.querySelector(".home-fold-title").textContent],
          row: [Math.round(r.height), css("#sessions-list .session-name").fontSize, parseFloat(css("#sessions-list .session-row").borderTopLeftRadius) >= r.height / 2],
          search: [css("#sessions-search").borderTopColor, Math.round(document.querySelector("#sessions-search").getBoundingClientRect().height)], big };
      });
      assert.deepEqual(look.titles, ["Pips", "Sessions"]);
      for (const head of look.heads) assert.deepEqual(head, ["12px", "500", look.muted, "none"], "a quiet heading: 12px medium, the quiet tone, sentence case");
      assert.deepEqual(look.row, [29, "12px", true], "a session: a 29px pill in 12px words");
      assert.deepEqual(look.search, ["rgba(0, 0, 0, 0)", 29], "the search box: a field with no line round it");
      assert.deepEqual(look.big.filter((m) => purple(m.c)).map((m) => m.n), [], "nothing wider than a dot is filled purple");
      // Open: Open Pips at the Pips heading's end and no count; "+" at the Sessions heading's end.
      assert.deepEqual([await shown(x.page, ".home-pips-open"), await shown(x.page, ".home-pips-count"), await shown(x.page, "#sessions-new"), await shown(x.page, "#sessions-fold-count")], [[true], [false], [true], [false]]);
      assert.equal(await x.head(), "Pips · 2 need you · 6 new", "a screen reader still hears the count in the heading");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`each heading folds its list and then says its count; the host keeps the Sessions fold (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, sessions: manySessions(20) });
    try {
      await x.page.waitForSelector("#sessions-pips .home-pip-row");
      await x.page.click(".home-pips-toggle"); await settle(x.page);
      assert.deepEqual([await shown(x.page, ".home-pips-open"), await shown(x.page, ".home-pips-count")], [[false], [true]], "folded, the count takes Open Pips' place");
      assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll(".home-pips-count > *")].map((n) => n.textContent)), ["2 need you", "6 new"]);
      const before = (await tops(x.page, ["#sessions-fold"]))[0];
      await x.page.click("#sessions-fold"); await settle(x.page);
      assert.equal(await x.page.getAttribute("#sessions-fold", "aria-expanded"), "false");
      assert.deepEqual(await shown(x.page, "#home-tabs, #sessions-list .session-row, #sessions-all, #work-library"), Array(6).fill(false), "folded: no tabs, no rows, no View all");
      assert.deepEqual([await x.page.textContent("#sessions-fold-count"), await shown(x.page, "#sessions-fold-count"), await shown(x.page, "#sessions-new")], ["20", [true], [true]], "the heading says how many, and + stays");
      assert.equal((await tops(x.page, ["#sessions-fold"]))[0], before, "the heading itself does not move");
      assert.deepEqual(await x.posted("sessionsHomeCollapsed"), [{ type: "sessionsHomeCollapsed", collapsed: true }]);
      // Folded, the keyboard goes from the heading to + and on out of the list.
      await x.page.focus("#sessions-fold"); await x.page.keyboard.press("Tab");
      assert.equal(await x.page.evaluate(() => document.activeElement.id), "sessions-new");
      await x.page.click("#sessions-new");
      assert.equal((await x.posted("newSessionInEditor")).length, 1, "+ starts a session, folded or not");
      await x.page.click("#sessions-fold"); await settle(x.page);
      assert.deepEqual(await shown(x.page, "#sessions-list .session-row"), [true, true, true]);
      assert.deepEqual((await x.posted("sessionsHomeCollapsed")).map((m) => m.collapsed), [true, false]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a home whose Sessions were folded on this computer opens folded", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { sessions: manySessions(20) });
  try {
    // What the host stamps on the page (src/pipHomeDismiss.ts) is there before the page's script runs.
    const y = await openHome(browser, { sessions: manySessions(20), sessionsCollapsed: true });
    try {
      await y.page.waitForSelector("#sessions-pips .home-pips-head");
      assert.equal(await y.page.getAttribute("#sessions-fold", "aria-expanded"), "false");
      assert.deepEqual(await shown(y.page, "#sessions-list .session-row"), [false, false, false]);
      assert.equal(await y.page.textContent("#sessions-fold-count"), "20");
      assert.deepEqual(await y.posted("sessionsHomeCollapsed"), [], "nothing to keep: the host said so");
    } finally { await y.close(); }
  } finally { await x.close(); }
});

test("three, or every session that needs you: those come first, and one waiting for you says so", async (t) => {
  if (skipOrFail(t)) return;
  const sessions = manySessions(20).map((s, k) => ({ ...s, open: false, ...(k === 6 || k === 9 || k === 12 || k === 15 ? { windowless: "running the tests" } : {}), ...(k === 4 ? { waiting: true } : {}) }));
  const x = await openHome(browser, { sessions, width: 300 });
  try {
    await x.page.waitForSelector("#sessions-list .session-row");
    const rows = await x.page.evaluate(() => [...document.querySelectorAll("#sessions-list .session-row")].map((r) => [r.dataset.id, r.querySelector(".session-age").textContent, !!r.querySelector(".session-windowless")]));
    assert.deepEqual(rows.map((r) => r[0]), ["2026-s04", "2026-s06", "2026-s09", "2026-s12", "2026-s15"], "five need you, so five are listed, in the list's own order");
    assert.deepEqual(rows[0].slice(1), ["wants your okay", false], "where its age was");
    assert.deepEqual(rows.slice(1).map((r) => r[2]), [true, true, true, true], "the others run with no window");
    assert.equal(await x.page.textContent("#sessions-all"), "View all (20)");
    // One needs you: it comes first, and the list is still three.
    await x.send({ type: "sessions_list", items: sessions.map((s) => ({ ...s, windowless: undefined, waiting: s.id === "2026-s04" })), error: "" });
    assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll("#sessions-list .session-row")].map((r) => r.dataset.id)), ["2026-s04", "2026-s00", "2026-s01"]);
    // Folded, a dot beside the count says one of them needs you.
    await x.page.click("#sessions-fold");
    assert.equal(await x.page.evaluate(() => !!document.querySelector("#sessions-fold-count .home-fold-dot")), true);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("on the Chat tab, + starts a chat", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { tab: "chat" });
  try {
    await x.page.waitForSelector("#chats-list .session-row");
    assert.deepEqual([await shown(x.page, "#chats-new"), await shown(x.page, "#sessions-new")], [[true], [false]]);
    await x.page.click("#chats-new");
    assert.equal((await x.posted("chatdgcNew")).length, 1);
    await x.page.click("#home-tab-work");
    assert.deepEqual([await shown(x.page, "#chats-new"), await shown(x.page, "#sessions-new")], [[false], [true]]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
