// In the Pips view every page with a back arrow has the side bar to itself (asked 12 Nov, looking at Pips settings:
// "this page shows the bottom dock, I thought we had decided, in Pip's chat, all its internal pages will also not get
// bottom dock and top header"). The pages inside one Pip already showed neither the dock nor the tab bar (Home, Work,
// Chat, Pips): inside-pip.test.mjs. The same rule now holds for every page of the view that has a back arrow: Pips
// settings (each of its tabs), Needs attention's View all, a project's Workspace context and Notifications, and a
// describe-the-job page where a project shows one (its top bar is the same). The list of Pips itself (Personal and Project) keeps both, and so does what opens on the list
// with no page of its own (a Personal New Pip's dialog, the Teams menu). DGC's header stays everywhere.
// Measured in real Chromium on the side bar's real page (support/dock-scene.mjs). Held here, for each such page:
//   - no dock and no tab bar, DGC's header where it was, and the page from under the header to the foot of the side bar
//   - one back arrow, a named button; by a click and by the keyboard it returns to the list, where both are again
//   - nothing jumps: no frame shows a page with a back arrow with either bar, or the list without them, and they turn
//     once each way; the header never moves
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock } from "./support/dock-scene.mjs";

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

const BACK = ".pip-topbar > button.topbar-icon:first-child";
/** The side bar as it is on screen. */
const now = (page) => page.evaluate((BACK) => {
  const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, width: r.width }; };
  const dock = document.getElementById("dgc-dock"), tabs = document.getElementById("side-tabs"), head = document.getElementById("phead"), host = document.getElementById("pips-host");
  const root = host.shadowRoot, active = document.activeElement, inner = root?.activeElement;
  const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true });
  const focused = inner || active;
  return { dock: seen(dock), dockRect: rect(dock), tabs: seen(tabs), tabsRect: rect(tabs), head: seen(head), headRect: rect(head), host: rect(host),
    room: (() => { const area = root?.querySelector(".pip-app-root"); if (!area) return 0; const cs = getComputedStyle(area); return area.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom); })(),
    title: root?.querySelector(".pip-pill span")?.textContent.trim() || "", list: !!root?.querySelector("[data-job]"),
    backs: [...(root?.querySelectorAll(BACK) || [])].filter(seen).map((b) => ({ id: b.id, name: b.getAttribute("aria-label") || "", button: b.tagName === "BUTTON" && !b.disabled })),
    focusIn: active?.closest?.("#dgc-dock") ? "dock" : active?.closest?.("#side-tabs") ? "tabs" : active === host ? "pips" : active === document.body ? "body" : active?.id || active?.tagName || "",
    focusId: inner?.id || active?.id || "", focusSeen: focused === document.body || seen(focused), height: innerHeight,
    panel: ["home-hub", "work-home", "chats-home"].find((id) => seen(document.getElementById(id))) || (seen(host) ? "pips-host" : ""),
    overflowX: document.documentElement.scrollWidth > innerWidth };
}, BACK);
const inRoot = (x, selector) => x.page.waitForFunction((s) => !!document.getElementById("pips-host").shadowRoot?.querySelector(s), selector);
const gone = (x, selector) => x.page.waitForFunction((s) => !document.getElementById("pips-host").shadowRoot?.querySelector(s), selector);
const both = (s) => [s.dock, s.tabs];
async function toList(x) { await x.page.click("#side-tab-pips"); await inRoot(x, "[data-job]"); await x.settle(); return now(x.page); }
/** A click made in the page on something in the Pips view (Playwright's own click scrolls first). */
const press = (x, selector) => x.page.evaluate((s) => document.getElementById("pips-host").shadowRoot.querySelector(s).click(), selector);
/** A page with a back arrow: neither bar, DGC's header as it was, the Pips view from under the header to the foot. */
function alone(s, list, what) {
  assert.deepEqual(both(s), [false, false], `${what}: the dock and the tab bar are not shown`);
  assert.deepEqual([s.head, s.panel], [true, "pips-host"], `${what}: DGC's own header stays, over the Pips view`);
  assert.ok(Math.abs(s.headRect.height - list.headRect.height) < 0.6 && Math.abs(s.headRect.top - list.headRect.top) < 0.6, `${what}: the header is where and as it was`);
  assert.ok(Math.abs(s.host.top - s.headRect.bottom) < 0.6, `${what}: the page begins under the header (${s.host.top} against ${s.headRect.bottom})`);
  assert.ok(Math.abs(s.host.bottom - s.height) < 0.6, `${what}: and reaches the foot of the side bar (${s.host.bottom} of ${s.height})`);
  assert.ok(Math.abs(s.room - (list.room + list.dockRect.height + list.tabsRect.height)) < 0.6,
    `${what}: its room gains the dock's and the tab bar's height (${s.room} against ${list.room} + ${list.dockRect.height} + ${list.tabsRect.height})`);
  assert.equal(s.backs.length, 1, `${what}: one back arrow (${JSON.stringify(s.backs)})`);
  assert.ok(s.backs[0].button && s.backs[0].name, `${what}: a named button (${JSON.stringify(s.backs[0])})`);
  assert.equal(s.overflowX, false, `${what}: nothing scrolls sideways`);
  assert.equal(s.focusSeen, true, `${what}: focus is not left on a hidden thing (${s.focusIn} ${s.focusId})`);
}
function withBoth(s, list, what) {
  assert.deepEqual([...both(s), s.panel, s.backs.length], [true, true, "pips-host", 0], `${what}: the dock and the tab bar are shown, and there is no back arrow`);
  assert.ok(Math.abs(s.host.top - list.host.top) < 0.6 && Math.abs(s.host.bottom - list.host.bottom) < 0.6, `${what}: the Pips view has the room the list has (${s.host.top} to ${s.host.bottom})`);
  assert.ok(Math.abs(s.room - list.room) < 0.6, `${what}: and the same room inside`);
}
/** The page's back arrow, by a click or by the keyboard (Tab from the top until it has focus, then the key). */
async function back(x, id, how = "click") {
  if (how === "click") await x.page.locator(`#pips-host #${id}`).click();
  else {
    await x.page.evaluate(() => { document.getElementById("pips-host").shadowRoot.activeElement?.blur?.(); document.activeElement?.blur?.(); });
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) { await x.page.keyboard.press("Tab"); const s = await now(x.page); reached = s.focusId === id;
      assert.ok(!/^(dock|tabs)$/.test(s.focusIn), `Tab went to the hidden ${s.focusIn} on the way to the back arrow`); }
    assert.equal(reached, true, `Tab reaches the back arrow (#${id})`);
    await x.page.keyboard.press(how);
  }
  await gone(x, `#${id}`); await inRoot(x, "[data-job]"); await x.settle(); return now(x.page);
}
/** Notes every frame from now on: whether a page with a back arrow is drawn, the list, the two bars, and the header's place. */
const watchFrames = (page) => page.evaluate((BACK) => {
  const frames = window.__frames = []; window.__watching = true;
  const look = () => {
    if (!window.__watching) return;
    const root = document.getElementById("pips-host").shadowRoot, seen = (id) => !!document.getElementById(id)?.checkVisibility(), head = document.getElementById("phead").getBoundingClientRect();
    frames.push({ page: !!root?.querySelector(BACK), list: !!root?.querySelector("[data-job]"), dock: seen("dgc-dock"), tabs: seen("side-tabs"), head: `${Math.round(head.top)}:${Math.round(head.height)}` });
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}, BACK);
const frames = (page) => page.evaluate(() => { window.__watching = false; return window.__frames; });
// (Webhooks is a fourth tab where DGC offers it; the walk below goes through every tab that is there.)
const SETTINGS_TABS = ["Computer", "Apps", "Plugins"];

for (const [width, theme] of [[300, "dark-modern"], [700, "light-modern"]]) {
  test(`Pips settings, each of its tabs: no dock and no tab bar, and its back arrow returns to the list with both (${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { width, height: 700, theme, pip: { api: 90 } });
    try {
      const list = await toList(x);
      withBoth(list, list, "the list of Pips");
      for (const how of ["click", "Enter", "Space"]) {
        await press(x, "#pips-settings-open"); await inRoot(x, "#pips-settings-close"); await x.settle();
        const settings = await now(x.page);
        assert.equal(settings.title, "Pips settings");
        alone(settings, list, "Pips settings");
        const tabs = await x.page.evaluate(() => [...document.getElementById("pips-host").shadowRoot.querySelectorAll(".pip-page-tabs [data-pips-settings]")].map((b) => b.textContent.trim()));
        for (const name of SETTINGS_TABS) assert.ok(tabs.includes(name), `Pips settings has a ${name} tab (${tabs.join(", ")})`);
        for (const name of tabs) {
          await x.page.evaluate((n) => [...document.getElementById("pips-host").shadowRoot.querySelectorAll(".pip-page-tabs [data-pips-settings]")].find((b) => b.textContent.trim() === n).click(), name);
          await x.settle();
          alone(await now(x.page), list, `Pips settings, ${name}`);
        }
        withBoth(await back(x, "pips-settings-close", how), list, `the list, back from Pips settings by ${how}`);
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Needs attention's View all: no dock and no tab bar, and Back and Escape return to the list with both (${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { width, height: 700, theme, pip: { setups: 2, waiting: 9, home: true } });
    try {
      const list = await toList(x);
      withBoth(list, list, "the list of Pips");
      await inRoot(x, "#attention-view-all");
      for (const how of ["click", "Enter", "Escape"]) {
        await press(x, "#attention-view-all"); await inRoot(x, ".attention-all"); await x.settle();
        const all = await now(x.page);
        assert.equal(all.title, "Needs you");
        alone(all, list, "View all");
        assert.equal(all.focusId, "attention-all-back", "focus is on its back arrow");
        if (how === "Escape") { await x.page.keyboard.press("Escape"); await gone(x, ".attention-all"); await inRoot(x, "[data-job]"); await x.settle(); withBoth(await now(x.page), list, "the list, by Escape"); }
        else withBoth(await back(x, "attention-all-back", how), list, `the list, back from View all by ${how}`);
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a project's Workspace context and its Notifications: the same; a New Pip opens on the list, which keeps both", async (t) => {
  if (skipOrFail(t)) return;
  const p = await openDock(browser, { width: 300, height: 700, pip: { project: true } });
  try {
    const list = await toList(p);
    withBoth(list, list, "a project's list of Pips");
    for (const [id, title] of [["workspace-context", "Workspace context"], ["workspace-notifications", "Notifications"]]) {
      await press(p, `#${id}`); await inRoot(p, "#workspace-back"); await p.settle();
      const s = await now(p.page);
      assert.equal(s.title, title);
      alone(s, list, `the project's ${title}`);
      withBoth(await back(p, "workspace-back"), list, `the list, back from ${title}`);
    }
    // Its New Pip opens on the list, as a Personal one does: no page of its own, no back arrow, and both bars stay.
    await press(p, "#simple-new"); await p.settle(); await p.page.waitForTimeout(120);
    withBoth(await now(p.page), list, "a project's New Pip, on the list");
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    const list = await toList(x);
    // A Personal New Pip and the Teams menu open on the list itself: no page, no back arrow, and both bars stay.
    await press(x, "#simple-new"); await x.settle(); await x.page.waitForTimeout(120);
    withBoth(await now(x.page), list, "a Personal New Pip, on the list");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("nothing jumps between the list, Pips settings and View all: the bars go and come with the page, once each way, and the header never moves", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700, pip: { setups: 2, waiting: 9, home: true } });
  try {
    await toList(x); await inRoot(x, "#attention-view-all");
    await watchFrames(x.page);
    for (let i = 0; i < 3; i++) {
      await press(x, "#pips-settings-open"); await inRoot(x, "#pips-settings-close"); await x.settle();
      await back(x, "pips-settings-close");
      await press(x, "#attention-view-all"); await inRoot(x, ".attention-all"); await x.settle();
      await back(x, "attention-all-back");
    }
    const seen = await frames(x.page);
    assert.ok(seen.length > 30, `frames were watched (${seen.length})`);
    assert.ok(seen.some((f) => f.page) && seen.some((f) => f.list), "through the pages and the list");
    const wrong = seen.filter((f) => f.dock !== f.tabs || f.page === f.dock);
    assert.deepEqual(wrong.slice(0, 3), [], `${wrong.length} of ${seen.length} frames showed a page with a back arrow with the dock or the tab bar, or the list without`);
    // Six visits, each one stretch of frames without the bars and one with them: never a frame of the other in between.
    // (The watch may start a frame after the first page is drawn, so the list's first stretch may not be in it.)
    const runs = seen.map((f) => (f.dock ? "L" : "p")).join("").replace(/(.)\1+/g, "$1");
    assert.match(runs, /^L?(pL){6}$/, `the bars went and came once for each of six visits: ${runs}`);
    assert.deepEqual([...new Set(seen.map((f) => f.head))].length, 1, "DGC's header stayed where it was in every frame");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
