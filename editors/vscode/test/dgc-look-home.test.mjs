// The side bar in the 0.52 look, in real Chromium with the real panel page and Pips bundle (test/support/home-scene.mjs).
// Since the tabs (Home, Work, Chat, Pips) each list has its own page: Work opens with its search box and New, then the
// Library and the sessions; Home holds what the Pips block and the headings' counts said (side-tabs-home.test.mjs). The
// Work list shows six, or every session that needs you, those first, then "View all (N)". A row is its blob, its name in
// 12 px words over a quiet line, and nothing wider than a dot is purple. Dark and light, 300 and 700 px.
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
  test(`Work: its header row, the search box and New, then the sessions (no Library row: 14 Nov); a row is a blob and 12px words (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab: "work", sessions: manySessions(20), motion: "reduce" });
    try {
      await x.page.waitForSelector("#sessions-list .session-row");
      const order = await tops(x.page, ["#side-tabs", "#work-home .dgc-pagehead", "#sessions-search", "#sessions-list", "#sessions-all"]);
      assert.deepEqual(order, [...order].sort((a, b) => a - b), `top to bottom: the tabs, the header row, the search box, the list, View all: ${order}`);
      const look = await x.page.evaluate(() => {
        const css = (s) => getComputedStyle(document.querySelector(s)), probe = document.createElement("i"); document.body.append(probe);
        probe.style.color = "var(--text-2)"; const quiet = getComputedStyle(probe).color; probe.remove();
        const row = document.querySelector("#sessions-list .session-row"), r = row.getBoundingClientRect();
        const big = [...document.querySelectorAll("#sessions-host *")].filter((n) => n.checkVisibility({ visibilityProperty: true }) && !n.closest("[data-mark], svg")).map((n) => { const b = n.getBoundingClientRect(); return { n: n.id || String(n.className), c: getComputedStyle(n).backgroundColor, w: b.width }; }).filter((m) => m.w > 10);
        const search = document.getElementById("sessions-search").getBoundingClientRect(), fresh = document.getElementById("sessions-new").getBoundingClientRect();
        return { quiet, row: [Math.round(r.height), css("#sessions-list .session-name").fontSize, css("#sessions-list .session-sub").fontSize, css("#sessions-list .session-sub").color],
          heights: [...new Set([...document.querySelectorAll("#sessions-list .session-row")].map((n) => Math.round(n.getBoundingClientRect().height)))],
          search: [css("#sessions-search").borderTopColor, Math.round(search.height)], fresh: [Math.round(fresh.height), Math.abs((search.top + search.bottom) / 2 - (fresh.top + fresh.bottom) / 2) < 1, search.right <= fresh.left], big };
      });
      assert.deepEqual(look.row, [44, "12px", "11px", look.quiet], "a session: its name in 12px words over a quiet 11px line");
      assert.deepEqual(look.heights, [44], "every row is one height");
      // (13 Nov: the search box takes the New button's height, 28px, and the shared button's corner: test/search-shape.test.mjs.)
      assert.deepEqual(look.search, ["rgba(0, 0, 0, 0)", 28], "the search box: a field with no line round it");
      assert.deepEqual(look.fresh, [28, true, true], "New: a 28px pill on the search box's row, after it");
      assert.deepEqual(look.big.filter((m) => purple(m.c)).map((m) => m.n), [], "nothing wider than a dot is filled purple");
      assert.deepEqual(await shown(x.page, "#sessions-new"), [true]);
      assert.deepEqual(await shown(x.page, "#chats-new"), [false], "a new chat is on the Chat tab");
      await x.page.click("#sessions-new");
      assert.equal((await x.posted("newSessionInEditor")).length, 1, "New starts a session");
      // The Tab key goes from the search box to New, then on into the list.
      await x.page.focus("#sessions-search"); await x.page.keyboard.press("Tab");
      assert.equal(await x.page.evaluate(() => document.activeElement.id), "sessions-new");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Home says what the headings' counts said: how many need you and how many are new, and the Home tab's number (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, sessions: manySessions(20) });
    try {
      const hub = await x.hub(), bar = await x.tabs();
      assert.deepEqual(hub.groups.map((g) => [g.name, g.count]), [["Needs you", "2"], ["New", "3"]], "Mail watch needs you for two things (the number counts the things, as the Pips tab does); Morning brief, Garden notes and Billing review have news");
      // (Home's number is what needs you; the three with news are in its words, never in the number: 16 Nov.)
      assert.equal(bar.tabs.find((b) => b.id === "home").count, "2");
      assert.equal(bar.tabs.find((b) => b.id === "home").label, "Home: 2 need you, 3 new");
      const heads = await x.page.evaluate(() => { const probe = document.createElement("i"); document.body.append(probe); probe.style.color = "var(--text)"; const text = getComputedStyle(probe).color; probe.remove();
        return { text, heads: [...document.querySelectorAll("#home-hub .dgc-hub-head h2")].map((h) => { const s = getComputedStyle(h); return [s.fontSize, s.fontWeight, s.color, s.textTransform]; }) }; });
      for (const head of heads.heads) assert.deepEqual(head, ["12px", "500", heads.text, "none"], "a group's name: 12px medium, sentence case");
      // The old folds are gone, and nothing is told to the host about them.
      assert.deepEqual(await x.page.evaluate(() => ["#sessions-fold", ".home-pips-toggle", "#sessions-fold-count"].filter((sel) => document.querySelector(sel))), []);
      assert.deepEqual([...(await x.posted("sessionsHomeCollapsed")), ...(await x.posted("pipHomeCollapsed"))], []);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("six, or every session that needs you: those come first, and one waiting for you says so", async (t) => {
  if (skipOrFail(t)) return;
  const needy = [3, 5, 6, 9, 12, 15, 17], sessions = manySessions(20).map((s, k) => ({ ...s, open: false, ...(needy.includes(k) ? { windowless: "running the tests" } : {}), ...(k === 4 ? { waiting: true } : {}) }));
  const x = await openHome(browser, { sessions, width: 300, tab: "work" });
  try {
    await x.page.waitForSelector("#sessions-list .session-row");
    const rows = await x.page.evaluate(() => [...document.querySelectorAll("#sessions-list .session-row")].map((r) => [r.dataset.id, r.querySelector(".session-sub").textContent, !!r.querySelector(".session-live")]));
    assert.deepEqual(rows.map((r) => r[0]), ["2026-s03", "2026-s04", "2026-s05", "2026-s06", "2026-s09", "2026-s12", "2026-s15", "2026-s17"], "eight need you, so eight are listed, in the list's own order");
    assert.deepEqual(rows[1].slice(1), ["Wants your okay", false], "under its name, in words");
    assert.equal(await x.page.evaluate(() => { const sub = document.querySelector('#sessions-list .session-row[data-id="2026-s04"] .session-sub'), probe = document.createElement("i"); document.body.append(probe); probe.style.color = "var(--need-text)";
      const need = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(sub).color === need; }), true, "in the tone of something that needs you");
    assert.deepEqual(rows.filter((r) => r[0] !== "2026-s04").map((r) => [/^Running, no window · /.test(r[1]), r[2]]), Array(7).fill([true, true]), "the others run with no window: the words and the dot");
    assert.equal(await x.page.textContent("#sessions-all"), "View all (20)");
    // One needs you: it comes first, and the list is still six.
    await x.send({ type: "sessions_list", items: sessions.map((s) => ({ ...s, windowless: undefined, waiting: s.id === "2026-s04" })), error: "" });
    assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll("#sessions-list .session-row")].map((r) => r.dataset.id)), ["2026-s04", "2026-s00", "2026-s01", "2026-s02", "2026-s03", "2026-s05"]);
    // And Home has its card, so it is seen without opening Work.
    await x.page.click("#side-tab-home");
    assert.ok((await x.hub()).cards.some((c) => c.key === "work:2026-s04" && c.group === "needs" && c.title === "Wants your okay to go on"));
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("on the Chat tab, New starts a chat; on Work, a session", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { tab: "chat" });
  try {
    await x.page.waitForSelector("#chats-list .session-row");
    assert.deepEqual([await shown(x.page, "#chats-new"), await shown(x.page, "#sessions-new")], [[true], [false]]);
    await x.page.click("#chats-new");
    assert.equal((await x.posted("chatdgcNew")).length, 1);
    await x.page.click("#side-tab-work");
    assert.deepEqual([await shown(x.page, "#chats-new"), await shown(x.page, "#sessions-new")], [[false], [true]]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
