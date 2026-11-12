// The tab bar and the strip behind the dock are frosted glass (asked 12 Nov: "the bottom section where the dock sits,
// behind it we have a solid section, so everything on the main screen scrolls behind that solid section. Instead can we
// make that section kind of blurred ... it goes under that blurred section and it kind of looks like glass morphism",
// then "the same glass on the top bar too"). The page (Home, Work, Chat, the Pips list) now begins under DGC's header
// and runs to the foot of the side bar; the tab bar (#side-tabs) lies over its top and the dock's strip (#dgc-dock)
// over its foot, each a translucent, blurred tint of the page's own ground, and the page keeps room for both
// (--glass-top, --glass-bottom; media/main.css "Frosted glass", media/main.js glassRoom, src/pips.css). Measured in
// real Chromium on the side bar's real page (support/dock-scene.mjs). Held here:
//   - the page's scroll area starts under the header and reaches the foot; both bars lie over it
//   - both bars are translucent and blur what is behind them, in dark and in light; the tab bar's pill and the dock's
//     raised bar keep their own look
//   - a row really does pass under each bar, and the first and the last row scroll fully clear of them, at 700 and 300 px
//   - what takes focus under a bar scrolls into view clear of it
//   - the wheel over either bar scrolls the page under it, and a click on the glass never reaches a row under it
//   - the tab bar sits under the header whatever the header's height; a resize and the Dock setting are followed
//   - inside a Pip: no room is kept and the page is where it was; nothing jumps on the way in or out
//   - forced colours, a high contrast theme, "reduce transparency" and no backdrop-filter: solid
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, PIP } from "./support/dock-scene.mjs";
import { homeState, manySessions, pipId, P } from "./support/home-scene.mjs";

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

/** A Home longer than the side bar: sixteen Pips, nine things waiting, fifteen new. */
function longHome() {
  const s = homeState("busy"), types = ["core", "scout", "quill", "lens", "rook", "pulse", "lock", "patch"], ids = "abcdef0123456789".split("");
  const names = ["Core", "Mail watch", "Morning brief", "Garden notes", "City power", "Desk", "Pitch", "Receipts", "Renewals", "Inbox", "Travel", "Bills", "Weekly", "Reading list", "School notes", "Bank"];
  s.list[P] = names.map((name, i) => ({ id: pipId(ids[i]), name, pip_type: types[i % 8], workspace_id: P, status: "active", pending_review_count: 0, version: 1 }));
  s.unread[P] = names.slice(1).map((name, i) => ({ pip_id: pipId(ids[i + 1]), workspace_id: P, name, pip_type: types[(i + 1) % 8], count: 1, messages: 1, posts: 0,
    latest: "Five bullets for this morning, each with its link.", latest_at: `2026-11-03T10:${String(50 - i).padStart(2, "0")}:00Z`, latest_message_id: "message_" + ids[i + 1].repeat(32), latest_post_id: null }));
  const card = (n) => "maildraft_" + String(n).repeat(32);
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: `email:${card(n)}`, kind: "email", card: card(n), pip_id: pipId(ids[n]), pip_name: names[n], pip_type: types[n % 8],
    workspace_id: P, title: "A reply to send", detail: "", created_at: "2026-11-03T08:00:00.000Z", expires_at: null }));
  s.attention = { ...s.attention, items, total: 9, counts: { email: 9 }, by_pip: Object.fromEntries(items.map((i) => [i.pip_id, 1])) };
  return s;
}
/** The side bar on `view` ("home" | "work" | "chat" | "pips"), each longer than the side bar where it can be. */
async function open(view, more = {}) {
  const x = await openDock(browser, { height: 700, tab: view === "pips" ? "work" : view, state: longHome(), sessions: manySessions(40), pip: { many: true, rows: 9 }, ...more });
  if (view === "pips") await toList(x);
  return x;
}
const inRoot = (x, selector) => x.page.waitForFunction((s) => !!document.getElementById("pips-host").shadowRoot?.querySelector(s), selector);
const gone = (x, selector) => x.page.waitForFunction((s) => !document.getElementById("pips-host").shadowRoot?.querySelector(s), selector);
async function toList(x) { await x.page.click("#side-tab-pips"); await inRoot(x, "[data-job]"); await x.page.mouse.move(2, 2); await x.settle(); }

/** Runs in the page: the page's scroll area, what it holds, and its rows (the Pips view is a shadow root). */
const PARTS = `(() => {
  const host = document.getElementById("pips-host"), root = host.shadowRoot, pips = document.body.classList.contains("pips-active");
  const scroller = pips ? root.querySelector(".pip-app-root") : document.getElementById("sessions-host");
  const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true });
  const holds = pips ? [root.querySelector("#app")] : [...scroller.children].filter(seen);
  const rows = [...(pips ? root.querySelectorAll("[data-job]") : scroller.querySelectorAll(".session-row, .dgc-hub-card"))].filter(seen);
  return { host: pips ? host : scroller, root, pips, scroller, holds, rows, seen, dock: document.getElementById("dgc-dock"), tabs: document.getElementById("side-tabs"), head: document.getElementById("phead") };
})()`;
/** The side bar as it is on screen: the header, both bars, the page under them, what the page holds, and how each bar is painted. */
const now = (page) => page.evaluate((PARTS) => {
  const p = (0, eval)(PARTS), rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width }; };
  const alpha = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || []; return c === "transparent" ? 0 : /\/|rgba|color\(/.test(c) ? (m.length > 3 ? m[3] : 1) : 1; };
  const paint = (n) => { const cs = getComputedStyle(n); return { filter: cs.backdropFilter || cs.webkitBackdropFilter || "none", blur: Number(/blur\(([\d.]+)px\)/.exec(cs.backdropFilter || "")?.[1] || 0),
    ground: cs.backgroundColor, alpha: alpha(cs.backgroundColor), position: cs.position, shadow: cs.boxShadow, events: cs.pointerEvents }; };
  const bar = p.dock.querySelector(".dgc-dock-bar"), pill = p.tabs.querySelector(".dgc-tabs-bar"), cs = getComputedStyle(p.scroller);
  const tops = p.holds.map((n) => n.getBoundingClientRect().top), bottoms = p.holds.map((n) => n.getBoundingClientRect().bottom);
  return { pips: p.pips, inside: document.body.classList.contains("inside-pip"), height: innerHeight, width: innerWidth,
    head: rect(p.head), tabs: p.seen(p.tabs) ? rect(p.tabs) : null, dock: p.seen(p.dock) ? rect(p.dock) : null, host: rect(p.host), scroller: rect(p.scroller),
    top: p.scroller.scrollTop, max: p.scroller.scrollHeight - p.scroller.clientHeight,
    // (What the page holds: from the top of its first thing to the foot of its last.)
    first: Math.min(...tops), last: Math.max(...bottoms), rows: p.rows.map(rect),
    room: { top: parseFloat(getComputedStyle(p.host).getPropertyValue("--glass-top")) || 0, bottom: parseFloat(getComputedStyle(p.host).getPropertyValue("--glass-bottom")) || 0,
      padTop: parseFloat(cs.paddingTop), padBottom: parseFloat(cs.paddingBottom), scrollTop: parseFloat(cs.scrollPaddingTop) || 0, scrollBottom: parseFloat(cs.scrollPaddingBottom) || 0 },
    tabsPaint: paint(p.tabs), dockPaint: paint(p.dock),
    pill: { image: getComputedStyle(pill).backgroundImage, shadow: getComputedStyle(pill).boxShadow, filter: getComputedStyle(pill).backdropFilter },
    bar: { alpha: alpha(getComputedStyle(bar).backgroundColor), ground: getComputedStyle(bar).backgroundColor, shadow: getComputedStyle(bar).boxShadow, filter: getComputedStyle(bar).backdropFilter },
    overflowX: document.documentElement.scrollWidth > innerWidth };
}, PARTS);
/** Scrolls the page: "top", "end", or so that a row's middle lies on the tab bar's lower edge ("tabs") or the strip's upper edge ("dock"). The row's place among the rows. */
const scrollTo = (x, where) => x.page.evaluate(([PARTS, where]) => {
  const p = (0, eval)(PARTS);
  if (where === "top") { p.scroller.scrollTop = 0; return -1; }
  if (where === "end") { p.scroller.scrollTop = p.scroller.scrollHeight; return -1; }
  p.scroller.scrollTop = Math.round((p.scroller.scrollHeight - p.scroller.clientHeight) / 2);
  const edge = where === "tabs" ? p.tabs.getBoundingClientRect().bottom : p.dock.getBoundingClientRect().top;
  const mid = (r) => { const b = r.getBoundingClientRect(); return (b.top + b.bottom) / 2; };
  const row = p.rows.reduce((best, r) => (Math.abs(mid(r) - edge) < Math.abs(mid(best) - edge) ? r : best), p.rows[0]);
  p.scroller.scrollTop += Math.round(mid(row) - edge);
  return p.rows.indexOf(row);
}, [PARTS, where]).then(async (at) => { await x.settle(); return at; });
const near = (a, b, by = 0.6) => Math.abs(a - b) < by;
const THEMES = [["dark", "dark-modern"], ["light", "light-modern"]];
const VIEWS = ["home", "work", "chat", "pips"];

for (const width of [300, 700]) {
  test(`${width}px: the page starts under the header and reaches the foot, with the tab bar and the dock's strip lying over it`, async (t) => {
    if (skipOrFail(t)) return;
    for (const view of VIEWS) {
      const x = await open(view, { width });
      try {
        const s = await now(x.page);
        assert.ok(s.tabs && s.dock, `${view}: the tab bar and the dock are shown`);
        assert.ok(near(s.host.top, s.head.bottom), `${view}: the page starts under DGC's header (${s.host.top} against ${s.head.bottom})`);
        assert.ok(near(s.host.bottom, s.height), `${view}: and reaches the foot of the side bar (${s.host.bottom} of ${s.height})`);
        assert.ok(near(s.tabs.top, s.head.bottom) && s.tabs.height > 30, `${view}: the tab bar sits under the header (${s.tabs.top} against ${s.head.bottom})`);
        assert.ok(near(s.dock.bottom, s.height) && s.dock.height > 30, `${view}: the dock's strip is at the foot (${s.dock.bottom} of ${s.height})`);
        assert.ok(near(s.tabs.left, 0) && near(s.tabs.right, s.width) && near(s.dock.left, 0) && near(s.dock.right, s.width), `${view}: both are as wide as the side bar`);
        // The room the page keeps is each bar's own height, measured.
        assert.ok(near(s.room.top, s.tabs.height) && near(s.room.bottom, s.dock.height), `${view}: the room kept is the bars' own height (${s.room.top}, ${s.room.bottom} against ${s.tabs.height}, ${s.dock.height})`);
        assert.equal(s.overflowX, false, `${view}: nothing scrolls sideways`);
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });

  test(`${width}px: a row passes under each bar, and the first and the last row scroll fully clear of them`, async (t) => {
    if (skipOrFail(t)) return;
    // (Home and the Pips list are the long pages; Work and Chat show a few rows and "View all".)
    for (const view of ["home", "pips"]) {
      const x = await open(view, { width });
      try {
        const top = await now(x.page);
        assert.ok(top.max > 120, `${view}: the page is longer than the side bar (${top.max}px to scroll)`);
        assert.ok(top.first >= top.tabs.bottom - 0.6, `${view}: at the top, the first thing is clear below the tab bar (${top.first} against ${top.tabs.bottom})`);
        assert.ok(top.first < top.tabs.bottom + 24, `${view}: and close under it, with no more than the page's own margin (${top.first - top.tabs.bottom}px)`);
        // Part way down: a row lies half under the strip, and it is drawn there (the scroll area reaches past it).
        const under = await scrollTo(x, "dock"), mid = await now(x.page), row = mid.rows[under];
        assert.ok(row.top < mid.dock.top - 4 && row.bottom > mid.dock.top + 4, `${view}: a row lies across the strip's upper edge (${row.top} to ${row.bottom}, the edge at ${mid.dock.top})`);
        assert.ok(mid.scroller.bottom >= Math.min(row.bottom, mid.height) - 0.6, `${view}: and the scroll area holds all of it (${mid.scroller.bottom})`);
        const over = await scrollTo(x, "tabs"), high = await now(x.page), upper = high.rows[over];
        assert.ok(upper.top < high.tabs.bottom - 4 && upper.bottom > high.tabs.bottom + 4, `${view}: a row lies across the tab bar's lower edge (${upper.top} to ${upper.bottom}, the edge at ${high.tabs.bottom})`);
        assert.ok(high.scroller.top <= Math.max(upper.top, high.head.bottom) + 0.6, `${view}: and the scroll area holds all of it (${high.scroller.top})`);
        await scrollTo(x, "end");
        const end = await now(x.page);
        assert.ok(near(end.top, end.max, 1.1), `${view}: scrolled to the end`);
        assert.ok(end.last <= end.dock.top + 0.6, `${view}: at the end, the last thing is clear above the strip (${end.last} against ${end.dock.top})`);
        assert.ok(end.rows.at(-1).bottom <= end.dock.top + 0.6, `${view}: its last row too (${end.rows.at(-1).bottom})`);
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });
}

test("both bars are translucent and blur what is behind them, in dark and in light; the pill and the dock's bar keep their look", async (t) => {
  if (skipOrFail(t)) return;
  for (const [name, theme] of THEMES) for (const view of ["work", "pips"]) {
    const x = await open(view, { width: 300, theme });
    try {
      const s = await now(x.page);
      for (const [what, paint] of [["the tab bar", s.tabsPaint], ["the dock's strip", s.dockPaint]]) {
        assert.ok(paint.blur >= 12 && paint.blur <= 30, `${name}, ${view}: ${what} blurs what is behind it (${paint.filter})`);
        assert.ok(paint.alpha >= 0.45 && paint.alpha <= 0.85, `${name}, ${view}: ${what} is a translucent tint (${paint.ground})`);
        // (Asked 13 Nov: no hairline along either bar's edge; each is flush with the page under it. test/glass-flush.test.mjs holds that.)
        assert.equal(paint.shadow, "none", `${name}, ${view}: ${what} draws no line along its edge`);
      }
      // The pill and the raised bar are not glass: the same grounds and shadows as ever, with no filter of their own.
      assert.match(s.pill.image, /gradient/, `${name}: the tab bar's pill keeps its gradient`);
      assert.ok(s.pill.shadow !== "none" && s.pill.filter === "none", `${name}: and its lift`);
      assert.ok(s.bar.alpha === 1 && s.bar.shadow !== "none" && s.bar.filter === "none", `${name}: the dock's raised bar stays solid and lifted (${s.bar.ground})`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("what takes focus under either bar scrolls into view, clear of it", async (t) => {
  if (skipOrFail(t)) return;
  for (const view of ["home", "pips"]) {
    const x = await open(view, { width: 300 });
    try {
      // Everything in the page that takes focus (a Pip's row, a card's buttons), in order. One is moved half under a bar, then focused.
      const KEYS = `(() => { const p = ${PARTS}; return { ...p, keys: [...(p.pips ? p.root : p.scroller).querySelectorAll("button, [tabindex='0'], input, summary")].filter((n) => p.seen(n) && !n.disabled && n.getBoundingClientRect().height >= 20) }; })()`;
      const half = (where) => x.page.evaluate(([KEYS, where]) => {
        const p = (0, eval)(KEYS), edge = where === "tabs" ? p.tabs.getBoundingClientRect().bottom : p.dock.getBoundingClientRect().top;
        // (One the page can bring to the edge: not so near the page's top or end that the scroll stops short.)
        const move = (k) => Math.round((k.getBoundingClientRect().top + k.getBoundingClientRect().bottom) / 2 - edge), max = p.scroller.scrollHeight - p.scroller.clientHeight;
        const can = p.keys.filter((k) => p.scroller.scrollTop + move(k) > 8 && p.scroller.scrollTop + move(k) < max - 8), n = can[Math.floor(can.length / 2)], b = () => n.getBoundingClientRect();
        p.scroller.scrollTop += move(n);
        return { at: p.keys.indexOf(n), top: b().top, bottom: b().bottom, edge };
      }, [KEYS, where]);
      const focus = (at) => x.page.evaluate(([KEYS, at]) => { const p = (0, eval)(KEYS), n = p.keys[at]; n.focus(); const b = n.getBoundingClientRect();
        return { took: (p.pips ? p.root.activeElement : document.activeElement) === n, top: b.top, bottom: b.bottom, tabs: p.tabs.getBoundingClientRect().bottom, dock: p.dock.getBoundingClientRect().top }; }, [KEYS, at]);
      const low = await half("dock");
      assert.ok(low.top < low.edge - 4 && low.bottom > low.edge + 4, `${view}: it is half under the strip (${low.top} to ${low.bottom}, the edge at ${low.edge})`);
      const up = await focus(low.at);
      assert.ok(up.took && up.bottom <= up.dock + 0.6 && up.top >= up.tabs - 0.6, `${view}: focused, it is whole above the strip (${up.top} to ${up.bottom} against ${up.dock})`);
      const high = await half("tabs");
      assert.ok(high.top < high.edge - 4 && high.bottom > high.edge + 4, `${view}: it is half under the tab bar (${high.top} to ${high.bottom}, the edge at ${high.edge})`);
      await x.page.evaluate(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; a?.blur?.(); });
      const down = await focus(high.at);
      assert.ok(down.took && down.top >= down.tabs - 0.6 && down.bottom <= down.dock + 0.6, `${view}: focused, it is whole below the tab bar (${down.top} to ${down.bottom} against ${down.tabs})`);
      // The keyboard, down the page from its top: what has focus is never under either bar.
      await scrollTo(x, "top");
      await focus(0);
      let walked = 0;
      for (let i = 0; i < 45; i++) {
        await x.page.keyboard.press("Tab");
        const spot = await x.page.evaluate(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
          const r = a.getBoundingClientRect(); return { inPage: !a.closest("#dgc-dock, #side-tabs") && a !== document.body, top: r.top, bottom: r.bottom, what: String(a.className || a.id || a.tagName).slice(0, 40) }; });
        if (!spot.inPage) break;
        walked++;
        const s = await now(x.page);
        assert.ok(spot.top >= s.tabs.bottom - 0.6 && spot.bottom <= s.dock.top + 0.6, `${view}: Tab ${i + 1} put focus on "${spot.what}" at ${spot.top} to ${spot.bottom}, under a bar (${s.tabs.bottom} to ${s.dock.top})`);
      }
      assert.ok(walked >= 12 && (await now(x.page)).top > 40, `${view}: the walk went down the page (${walked} stops)`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("the wheel over either bar scrolls the page under it", async (t) => {
  if (skipOrFail(t)) return;
  for (const view of ["home", "pips"]) {
    const x = await open(view, { width: 300 });
    try {
      const s = await now(x.page);
      // Beside the pill, on the tab bar's own glass; then beside the dock's bar, on the strip.
      await x.page.mouse.move(5, s.tabs.top + s.tabs.height / 2);
      await x.page.mouse.wheel(0, 90); await x.page.waitForFunction((PARTS) => (0, eval)(PARTS).scroller.scrollTop > 60, PARTS, { timeout: 5000 });
      const one = (await now(x.page)).top;
      await x.page.mouse.move(5, s.dock.top + s.dock.height / 2);
      await x.page.mouse.wheel(0, 90); await x.page.waitForFunction(([PARTS, was]) => (0, eval)(PARTS).scroller.scrollTop > was + 60, [PARTS, one], { timeout: 5000 });
      // A click on either bar's glass lands on the bar, never on a row that is blurred under it.
      const hit = await x.page.evaluate(([a, b]) => [a, b].map((y) => { const n = document.elementFromPoint(5, y); return n?.closest("#side-tabs, #dgc-dock")?.id || n?.id || n?.tagName; }),
        [s.tabs.top + s.tabs.height / 2, s.dock.top + s.dock.height / 2]);
      assert.deepEqual(hit, ["side-tabs", "dgc-dock"], `${view}: the pointer on the glass is on the bar`);
      // And the tabs themselves still take a click.
      await x.page.click("#side-tab-work"); await x.settle();
      assert.equal(await x.page.evaluate(() => document.getElementById("side-tab-work").getAttribute("aria-selected")), "true", `${view}: a tab still answers a click`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("the tab bar sits under the header whatever the header's height; a resize and the Dock setting are followed", async (t) => {
  if (skipOrFail(t)) return;
  for (const view of ["work", "pips"]) {
    const x = await open(view, { width: 300 });
    try {
      const was = await now(x.page);
      // A taller header (a larger font, another build's header): no offset is written down anywhere.
      await x.page.evaluate(() => { document.getElementById("phead").style.minHeight = "83px"; }); await x.settle();
      const tall = await now(x.page);
      assert.ok(near(tall.head.height, 83) && near(tall.tabs.top, tall.head.bottom) && near(tall.host.top, tall.head.bottom), `${view}: under an 83px header the tab bar and the page start at ${tall.tabs.top} and ${tall.host.top}`);
      assert.ok(tall.first >= tall.tabs.bottom - 0.6 && near(tall.first - tall.tabs.bottom, was.first - was.tabs.bottom), `${view}: and the first thing keeps its place under the bar`);
      await x.page.evaluate(() => { document.getElementById("phead").style.minHeight = ""; });
      // Wider, and shorter.
      await x.page.setViewportSize({ width: 700, height: 520 }); await x.settle();
      const wide = await now(x.page);
      assert.ok(near(wide.tabs.top, wide.head.bottom) && near(wide.dock.bottom, 520) && near(wide.host.bottom, 520), `${view}: resized, the bars are at the header and the foot`);
      assert.ok(wide.first >= wide.tabs.bottom - 0.6 && near(wide.room.top, wide.tabs.height) && near(wide.room.bottom, wide.dock.height), `${view}: and the room is theirs`);
      // A bigger dock (Settings, Dock, Size): more room; "When I point at the bottom" and Never: none at the foot.
      await x.setting({ size: 48 }); await x.settle();
      const big = await now(x.page);
      assert.ok(big.dock.height > wide.dock.height + 10 && near(big.room.bottom, big.dock.height), `${view}: a bigger dock gets its room (${big.room.bottom} against ${big.dock.height})`);
      await scrollTo(x, "end");
      const bigEnd = await now(x.page);
      assert.ok(bigEnd.last <= bigEnd.dock.top + 0.6, `${view}: and the last thing still scrolls clear of it`);
      for (const show of ["hover", "never"]) {
        await x.setting({ show }); await x.settle();
        const s = await now(x.page);
        assert.equal(s.room.bottom, 0, `${view}: ${show}: no room is kept at the foot`);
        assert.ok(near(s.host.bottom, 520) && near(s.room.top, s.tabs.height), `${view}: ${show}: the page reaches the foot, and the tab bar keeps its room`);
        assert.ok(show === "never" ? !s.dock : s.dockPaint.blur === 0 && s.dockPaint.alpha === 0, `${view}: ${show}: no glass strip (${s.dockPaint.filter}, ${s.dockPaint.ground})`);
      }
      await x.setting({ show: "always", size: 34 }); await x.settle();
      const back = await now(x.page);
      assert.ok(near(back.room.bottom, back.dock.height) && back.dockPaint.blur >= 12, `${view}: Always again: the strip and its room are back`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("inside a Pip no room is kept and the page is where it was; nothing jumps on the way in or out", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 700]) {
    // The same chat with the dock set to Never: where the log and the prompt box are when nothing takes room at the foot.
    const plain = await open("pips", { width, show: "never" });
    let never;
    const chatNow = (x) => x.page.evaluate(() => { const root = document.getElementById("pips-host").shadowRoot, r = (n) => { const b = n.getBoundingClientRect(); return [b.top, b.bottom, b.left, b.right]; };
      const app = root.querySelector(".pip-app-root"), cs = getComputedStyle(app);
      return { host: r(document.getElementById("pips-host")), log: r(root.querySelector(".conversation-log")), form: r(root.querySelector("#chat-form")), back: r(root.querySelector("#simple-back")),
        pad: [cs.paddingTop, cs.paddingBottom, cs.scrollPaddingTop, cs.scrollPaddingBottom], room: [getComputedStyle(app).getPropertyValue("--glass-top").trim(), getComputedStyle(app).getPropertyValue("--glass-bottom").trim()] }; });
    const toChat = async (x) => { await x.page.locator(`#pips-host [data-job="${PIP}"]`).click(); await inRoot(x, "#chat-form"); await x.page.mouse.move(2, 2); await x.settle(); };
    try { await toChat(plain); never = await chatNow(plain); } finally { await plain.close(); }
    const x = await open("pips", { width });
    try {
      const list = await now(x.page);
      // Every frame from here: where the page's first thing is against the tab bar, and the room kept.
      await x.page.evaluate(() => {
        const frames = window.__glassFrames = []; window.__glassWatch = true;
        const look = () => {
          if (!window.__glassWatch) return;
          const root = document.getElementById("pips-host").shadowRoot, tabs = document.getElementById("side-tabs"), dock = document.getElementById("dgc-dock"), app = root.querySelector(".pip-app-root");
          const row = root.querySelector("[data-job]"), first = root.querySelector("#app"), form = root.querySelector("#chat-form");
          frames.push({ list: !!row, chat: !!form, tabs: tabs.checkVisibility(), dock: dock.checkVisibility(), tabsBottom: tabs.getBoundingClientRect().bottom, dockTop: dock.getBoundingClientRect().top,
            first: first.getBoundingClientRect().top, row: row ? row.getBoundingClientRect().top : null, pad: parseFloat(getComputedStyle(app).paddingTop), foot: parseFloat(getComputedStyle(app).paddingBottom),
            formBottom: form ? form.getBoundingClientRect().bottom : null });
          requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      });
      for (let i = 0; i < 2; i++) {
        await toChat(x);
        const chat = await chatNow(x);
        assert.deepEqual(chat.room, ["0px", "0px"], `${width}px: in a Pip's chat no room is kept for either bar`);
        assert.deepEqual(chat.pad, ["0px", "0px", "0px", "0px"], `${width}px: and its scroll area has no padding for them`);
        assert.deepEqual([chat.host[1], chat.form, chat.back[2], chat.log[1], chat.log[2], chat.log[3]], [never.host[1], never.form, never.back[2], never.log[1], never.log[2], never.log[3]],
          `${width}px: the chat's prompt box, its log's foot and sides and its back arrow are where they are with no dock at all`);
        const s = await now(x.page);
        assert.ok(!s.tabs && !s.dock && near(s.host.top, s.head.bottom) && near(s.host.bottom, s.height), `${width}px: the chat has the side bar from the header to the foot`);
        await x.page.locator("#pips-host #simple-back").click(); await gone(x, "#chat-form"); await inRoot(x, "[data-job]"); await x.settle();
        const back = await now(x.page);
        assert.deepEqual([back.first, back.rows[0].top, back.tabs.top, back.dock.top, back.room], [list.first, list.rows[0].top, list.tabs.top, list.dock.top, list.room], `${width}px: back on the list, everything is where it was`);
      }
      const frames = await x.page.evaluate(() => { window.__glassWatch = false; return window.__glassFrames; });
      assert.ok(frames.length > 12 && frames.some((f) => f.chat) && frames.some((f) => f.list), `${width}px: frames were watched through the chat and the list (${frames.length})`);
      // No frame draws the list's top under the tab bar (room late), or the chat pushed down or up by room it should not have (room kept).
      const listWrong = frames.filter((f) => f.list && f.tabs && (f.first < f.tabsBottom - 0.6 || !near(f.row, list.rows[0].top)));
      assert.deepEqual(listWrong.slice(0, 3), [], `${width}px: ${listWrong.length} of ${frames.length} frames drew the list out of place`);
      const chatWrong = frames.filter((f) => f.chat && (f.pad !== 0 || f.foot !== 0 || f.tabs || f.dock || !near(f.formBottom, never.form[1])));
      assert.deepEqual(chatWrong.slice(0, 3), [], `${width}px: ${chatWrong.length} of ${frames.length} frames drew the chat out of place`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("forced colours, a high contrast theme and \"reduce transparency\": both bars are solid, and the page still clears them", async (t) => {
  if (skipOrFail(t)) return;
  const solid = async (x, what) => {
    const s = await now(x.page);
    for (const [bar, paint] of [["the tab bar", s.tabsPaint], ["the dock's strip", s.dockPaint]]) {
      assert.equal(paint.blur, 0, `${what}: ${bar} has no blur (${paint.filter})`);
      assert.equal(paint.filter, "none", `${what}: ${bar} has no backdrop filter`);
      assert.equal(paint.alpha, 1, `${what}: ${bar} is solid (${paint.ground})`);
    }
    // The layout is the same one: the page under both, with their room.
    assert.ok(near(s.host.bottom, s.height) && near(s.host.top, s.head.bottom) && s.first >= s.tabs.bottom - 0.6 && near(s.room.bottom, s.dock.height), `${what}: the page keeps its room for both`);
    await scrollTo(x, "end");
    const end = await now(x.page);
    assert.ok(end.last <= end.dock.top + 0.6, `${what}: the last thing scrolls clear of the strip`);
    await scrollTo(x, "top");
  };
  for (const view of ["work", "pips"]) {
    const x = await open(view, { width: 300 });
    try {
      // (The control: with none of these the bars are glass, so each check below can fail.)
      assert.ok((await now(x.page)).tabsPaint.blur >= 12 && (await now(x.page)).dockPaint.alpha < 0.9, `${view}: glass to begin with`);
      await x.page.emulateMedia({ forcedColors: "active" }); await x.settle();
      await solid(x, `${view}, forced colours`);
      await x.page.emulateMedia({ forcedColors: "none" }); await x.settle();
      assert.ok((await now(x.page)).tabsPaint.blur >= 12, `${view}: glass again`);
      const cdp = await x.page.context().newCDPSession(x.page);
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] }); await x.settle();
      assert.equal(await x.page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches), true, "reduce transparency is on");
      await solid(x, `${view}, reduce transparency`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
    const hc = await open(view, { width: 300, theme: "hc" });
    try { await solid(hc, `${view}, a high contrast theme`); assert.deepEqual(hc.errors, []); } finally { await hc.close(); }
  }
});

test("no backdrop-filter: the glass is only declared where the browser can blur", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("work", { width: 300 });
  try {
    // Every rule that gives either bar a backdrop filter, and what it stands inside.
    const found = await x.page.evaluate(() => {
      const out = [], walk = (rules, inside) => { for (const rule of rules) {
        if (rule.cssRules && !(rule instanceof CSSStyleRule)) { walk(rule.cssRules, [...inside, rule instanceof CSSSupportsRule ? `@supports ${rule.conditionText}` : rule.constructor.name]); continue; }
        if (!(rule instanceof CSSStyleRule) || !/#side-tabs|#dgc-dock/.test(rule.selectorText)) continue;
        const filter = rule.style.getPropertyValue("backdrop-filter") || rule.style.getPropertyValue("-webkit-backdrop-filter");
        if (filter && filter !== "none") out.push({ selector: rule.selectorText, filter, ground: rule.style.getPropertyValue("background") || rule.style.getPropertyValue("background-color"), inside });
      } };
      for (const sheet of document.styleSheets) { try { walk(sheet.cssRules, []); } catch { /* another origin's */ } }
      return out;
    });
    assert.ok(found.length >= 1, "the glass is declared");
    for (const rule of found) {
      assert.ok(rule.inside.some((w) => /^@supports .*backdrop-filter/.test(w)), `"${rule.selector}" blurs only inside @supports (backdrop-filter) (${rule.inside.join(" > ") || "at the top level"})`);
      assert.ok(rule.ground, `"${rule.selector}": the translucent ground is declared with the blur, so without the blur the ground stays solid`);
    }
    // Outside it, the bars' ground is the page's own, solid: what a browser with no backdrop filter paints.
    const base = await x.page.evaluate(() => {
      const sheet = new CSSStyleSheet(), kept = [];
      const walk = (rules) => { for (const rule of rules) { if (rule instanceof CSSSupportsRule && /backdrop-filter/.test(rule.conditionText)) continue;
        if (rule.cssRules && !(rule instanceof CSSStyleRule)) { walk(rule.cssRules); continue; }
        if (rule instanceof CSSStyleRule && /#side-tabs|#dgc-dock/.test(rule.selectorText) && rule.style.getPropertyValue("background")) kept.push(`${rule.selectorText} => ${rule.style.getPropertyValue("background")}`); } };
      for (const s of document.styleSheets) { try { walk(s.cssRules); } catch { /* another origin's */ } }
      void sheet; return kept;
    });
    assert.ok(base.some((r) => /#side-tabs/.test(r) && /var\(--glass-ground/.test(r)) && base.some((r) => /#dgc-dock/.test(r) && /var\(--glass-ground/.test(r)),
      `without @supports each bar has the page's own solid ground (${base.join(" | ")})`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
