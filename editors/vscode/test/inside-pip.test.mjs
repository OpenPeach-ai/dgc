// Inside one Pip the page has the side bar to itself (asked 12 Nov, looking at a Pip's settings: "even this does not need
// to have the dock at the bottom, even the top header tabs do not need to come on this page"). A Pip's chat already
// showed neither the dock (media/shared/dock.js) nor the tab bar (Home, Work, Chat, Pips): dock-pip-chat.test.mjs. Now
// every page of one Pip is the same: its Settings (with Instructions and Face), History, Changes, Notifications, Memory
// and the rest of its menu, and "Change in chat". The list of Pips, Pips settings (for all Pips), a new Pip's page and a
// project's own Context and Notifications keep both. Measured in real Chromium on the side bar's real page
// (support/dock-scene.mjs), with a Personal Pip and a Project Pip. Held here:
//   - each page inside a Pip: no dock, no tab bar, DGC's header stays, and the page takes their room down to the foot
//   - each has one back arrow, a named button, that works by a click and by Tab then Enter: to the chat (or the page
//     above), and from the chat to the list, where both are again
//   - the keyboard never lands on the hidden dock or tab bar, and focus is never left on a hidden thing
//   - nothing flickers: no frame shows a Pip's page with either, or the list without them, and they turn once each way
//   - the list, Pips settings, New Pip and a project's Context and Notifications show both
//   - the list's Controls menu ("…" beside Start) closes on Escape and focus returns to its button (found in a live check)
//   - "When I point at the bottom": nothing rises over a Pip's Settings; leaving for another tab brings both back
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, dockNow } from "./support/dock-scene.mjs";

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

/** The side bar as it is on screen: what shows, where the Pips view is, which page of it, its back arrow, and focus. */
const now = (page) => page.evaluate(() => {
  const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width }; };
  const dock = document.getElementById("dgc-dock"), tabs = document.getElementById("side-tabs"), head = document.getElementById("phead"), host = document.getElementById("pips-host");
  const root = host.shadowRoot, active = document.activeElement, inner = root?.activeElement;
  const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true });
  const backs = [...(root?.querySelectorAll(".pip-topbar > button.topbar-icon:first-child") || [])].filter(seen);
  const focused = inner || active;
  return { dock: seen(dock), dockRect: rect(dock), tabs: seen(tabs), tabsRect: rect(tabs), head: seen(head), headRect: rect(head), host: rect(host),
    view: root?.querySelector(".simple-content")?.dataset.view || "", under: root?.querySelector(".pip-pill small")?.textContent.trim() || "", title: root?.querySelector(".pip-pill span")?.textContent.trim() || "",
    list: !!root?.querySelector("[data-job]"), chat: !!root?.querySelector("#chat-form"),
    backs: backs.map((b) => ({ id: b.id, name: b.getAttribute("aria-label") || "", button: b.tagName === "BUTTON" && !b.disabled })),
    focusIn: active?.closest?.("#dgc-dock") ? "dock" : active?.closest?.("#side-tabs") ? "tabs" : active === host ? "pips" : active === document.body ? "body" : active?.id || active?.tagName || "",
    focusId: inner?.id || active?.id || "", focusSeen: focused === document.body || seen(focused), height: innerHeight, width: innerWidth,
    panel: ["home-hub", "work-home", "chats-home"].find((id) => seen(document.getElementById(id))) || (seen(host) ? "pips-host" : ""),
    overflowX: document.documentElement.scrollWidth > innerWidth };
});
const inRoot = (x, selector) => x.page.waitForFunction((s) => !!document.getElementById("pips-host").shadowRoot?.querySelector(s), selector);
const gone = (x, selector) => x.page.waitForFunction((s) => !document.getElementById("pips-host").shadowRoot?.querySelector(s), selector);
const both = (s) => [s.dock, s.tabs];
async function toList(x) { await x.page.click("#side-tab-pips"); await inRoot(x, "[data-job]"); await x.settle(); return now(x.page); }
async function toChat(x) { await x.page.locator("#pips-host [data-job]").first().click(); await inRoot(x, "#chat-form"); await x.settle(); return now(x.page); }
/** A click made in the page on something in the Pips view (Playwright's own click scrolls first; see dock-pip-chat.test.mjs). */
const press = (x, selector) => x.page.evaluate((s) => document.getElementById("pips-host").shadowRoot.querySelector(s).click(), selector);
/** A page of the open Pip, from its "..." menu. */
async function toPage(x, tab) {
  await x.page.evaluate((t) => { const root = document.getElementById("pips-host").shadowRoot;
    root.querySelector("details.pip-menu > summary").click(); root.querySelector(`details.pip-menu [data-tab="${t}"]`).click(); }, tab);
  await inRoot(x, `.simple-content[data-view="${tab}"]`); await x.settle(); return now(x.page);
}
/** The page's back arrow, by a click or by the keyboard (Tab from the top of the page until it has focus, then the key). */
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
  await gone(x, `#${id}`); await x.settle(); return now(x.page);
}
/** Tab `n` times, forward or back: where focus was after each press. */
async function walk(x, n, key = "Tab") {
  const seen = [];
  for (let i = 0; i < n; i++) { await x.page.keyboard.press(key); const s = await now(x.page); seen.push(`${s.focusIn}${s.focusId ? `:${s.focusId}` : ""}`); }
  return seen;
}
/** What a page inside a Pip must be: neither bar, DGC's header, the Pips view from under the header to the foot. */
function alone(s, list, what) {
  assert.deepEqual(both(s), [false, false], `${what}: the dock and the tab bar are not shown`);
  assert.deepEqual([s.head, s.panel], [true, "pips-host"], `${what}: DGC's own header stays, over the Pips view`);
  assert.ok(Math.abs(s.headRect.height - list.headRect.height) < 0.6 && Math.abs(s.headRect.top - list.headRect.top) < 0.6, `${what}: the header is where and as it was`);
  assert.ok(Math.abs(s.host.top - s.headRect.bottom) < 0.6, `${what}: the page begins under the header (${s.host.top} against ${s.headRect.bottom})`);
  assert.ok(Math.abs(s.host.bottom - s.height) < 0.6, `${what}: and reaches the foot of the side bar (${s.host.bottom} of ${s.height})`);
  assert.ok(Math.abs(s.host.height - (list.host.height + list.dockRect.height + list.tabsRect.height)) < 0.6,
    `${what}: it gains the dock's and the tab bar's height (${s.host.height} against ${list.host.height} + ${list.dockRect.height} + ${list.tabsRect.height})`);
  assert.equal(s.backs.length, 1, `${what}: one back arrow (${JSON.stringify(s.backs)})`);
  assert.ok(s.backs[0].button && s.backs[0].name, `${what}: a named button (${JSON.stringify(s.backs[0])})`);
  assert.equal(s.overflowX, false, `${what}: nothing scrolls sideways`);
}
const withBoth = (s, list, what) => {
  assert.deepEqual([...both(s), s.panel], [true, true, "pips-host"], `${what}: the dock and the tab bar are shown`);
  assert.ok(Math.abs(s.host.top - list.host.top) < 0.6 && Math.abs(s.host.bottom - list.host.bottom) < 0.6, `${what}: the Pips view has the room the list has (${s.host.top} to ${s.host.bottom})`);
};
/** Notes every frame from now on: whether a page inside a Pip is drawn (its back arrow), the list, and the two bars. */
const watchFrames = (page) => page.evaluate(() => {
  const frames = window.__frames = []; window.__watching = true;
  const look = () => {
    if (!window.__watching) return;
    const root = document.getElementById("pips-host").shadowRoot, seen = (id) => !!document.getElementById(id)?.checkVisibility();
    frames.push({ inside: !!root?.querySelector("#simple-back, #simple-to-chat, #pip-page-back"), view: root?.querySelector(".simple-content")?.dataset.view || "", list: !!root?.querySelector("[data-job]"), dock: seen("dgc-dock"), tabs: seen("side-tabs") });
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
});
const frames = (page) => page.evaluate(() => { window.__watching = false; return window.__frames; });

// Each kind of Pip, and every page its "..." menu leads to: [the menu's key, the words under its name].
const KINDS = [
  { kind: "a Personal Pip", pip: {}, pages: [["job", "Settings"], ["runs", "History"], ["revisions", "Versions"], ["notifications", "Notifications"]] },
  { kind: "a Project Pip", pip: { project: true }, pages: [["job", "Settings"], ["runs", "History"], ["revisions", "Changes"], ["notifications", "Notifications"], ["memory", "Memory"], ["schedule", "Schedule"], ["handoffs", "Handoffs"], ["context", "Context"]] },
];

for (const { kind, pip, pages } of KINDS) {
  test(`${kind}: each of its pages shows no dock and no tab bar, takes their room, and its back arrow leads to the chat and the list`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { width: 300, height: 700, pip });
    try {
      const list = await toList(x);
      assert.deepEqual(both(list), [true, true], "the list of Pips has the dock and the tab bar");
      assert.ok(list.dockRect.height > 30 && list.tabsRect.height > 30, "and each takes real room there");
      await toChat(x);
      for (const [tab, under] of pages) {
        for (const how of ["click", "Enter"]) {
          const s = await toPage(x, tab);
          assert.deepEqual([s.view, s.under], [tab, under], `${kind}'s ${under} is open`);
          alone(s, list, `${kind}'s ${under}`);
          assert.deepEqual([s.backs[0].id, s.backs[0].name], ["simple-to-chat", "Back to the chat"], `${under}: its arrow says where it leads`);
          // The arrow: to the Pip's chat, still without either; then the chat's arrow, to the list with both.
          const chat = await back(x, "simple-to-chat", how);
          assert.deepEqual([chat.chat, ...both(chat)], [true, false, false], `${under}, the arrow by ${how}: the Pip's chat, still with neither`);
          assert.equal(chat.focusSeen, true, `${under}, the arrow by ${how}: focus is on something shown (${chat.focusIn} ${chat.focusId})`);
          const home = await back(x, "simple-back", how);
          assert.equal(home.list, true, `${under}, the chat's arrow by ${how}: the list`);
          withBoth(home, list, `${under}, back on the list`);
          assert.deepEqual([home.tabsRect.top, home.dockRect.top], [list.tabsRect.top, list.dockRect.top], "each where it was");
          assert.equal(home.focusSeen, true, `back on the list, focus is on something shown (${home.focusIn} ${home.focusId})`);
          await toChat(x);
        }
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const width of [300, 700]) {
  test(`${width}px: a Pip's Settings and History reach the foot of the side bar`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { width, height: 700 });
    try {
      const list = await toList(x); await toChat(x);
      for (const [tab, under] of [["job", "Settings"], ["runs", "History"]]) {
        const s = await toPage(x, tab);
        alone(s, list, `${width}px ${under}`);
        // Nothing of the dock or the tab bar is painted where they stood.
        const at = await x.page.evaluate(([dockY, tabsY]) => [dockY, tabsY].map((y) => { const hit = document.elementFromPoint(innerWidth / 2, y); return hit?.closest("#dgc-dock, #side-tabs")?.id || hit?.id || hit?.tagName; }),
          [list.dockRect.top + list.dockRect.height / 2, list.tabsRect.top + list.tabsRect.height / 2]);
        assert.deepEqual(at, ["pips-host", "pips-host"], `${width}px ${under}: the Pip's page is what is there now`);
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a Personal Pip's Instructions and Face, under its Settings: neither bar, and Back leads to Settings", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    const list = await toList(x); await toChat(x);
    for (const [page, under] of [["instructions", "Instructions"], ["character", "Face"]]) {
      for (const how of ["click", "Enter"]) {
        await toPage(x, "job");
        await press(x, `.simple-content [data-pip-page="${page}"]`); await inRoot(x, "#pip-page-back"); await x.settle();
        const s = await now(x.page);
        assert.equal(s.under, under, `${under} is open`);
        alone(s, list, `a Pip's ${under}`);
        assert.deepEqual([s.backs[0].id, s.backs[0].name], ["pip-page-back", "Back"]);
        const settings = await back(x, "pip-page-back", how);
        assert.deepEqual([settings.view, settings.under, ...both(settings)], ["job", "Settings", false, false], `${under}, Back by ${how}: its Settings, still with neither`);
        assert.equal(settings.focusSeen, true, "focus is on something shown");
        await back(x, "simple-to-chat");
      }
    }
    // Links, Media and Files are Settings still.
    await toPage(x, "job");
    for (const tab of ["links", "media", "files", "info"]) {
      await press(x, `.simple-content [data-pip-page-tab="${tab}"]`); await x.settle();
      alone(await now(x.page), list, `Settings, ${tab}`);
    }
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a Project Pip's \"Change in chat\": neither bar, and its arrow leads back to the Pip", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700, pip: { project: true } });
  try {
    const list = await toList(x); await toChat(x);
    for (const how of ["click", "Enter"]) {
      await toPage(x, "job");
      await press(x, "#setup-in-chat"); await inRoot(x, "#create-back"); await x.settle();
      const s = await now(x.page);
      assert.equal(s.title, "Change Billing review", "the page that changes this Pip");
      alone(s, list, "Change in chat");
      assert.deepEqual([s.backs[0].id, s.backs[0].name], ["create-back", "Back to Billing review"]);
      const pip = await back(x, "create-back", how);
      assert.deepEqual([pip.backs.length, ...both(pip)], [1, false, false], `its arrow by ${how}: the Pip, still with neither`);
      assert.equal(pip.focusSeen, true, "focus is on something shown");
      if (!pip.chat) await back(x, "simple-to-chat");
    }
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the list of Pips, Pips settings and New Pip keep the dock and the tab bar", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    const list = await toList(x);
    withBoth(list, list, "the list of Pips");
    // Pips settings, for all Pips: from the list's own button, and back.
    await press(x, "#pips-settings-open"); await gone(x, "[data-job]"); await x.settle();
    const settings = await now(x.page);
    withBoth(settings, list, "Pips settings");
    assert.equal(settings.list, false, "(the settings page, not the list)");
    const d = await dockNow(x.page);
    assert.ok(d.shown && Math.abs(d.host.bottom - d.height) < 0.6, "the dock is whole at the foot of Pips settings");
    // After a Pip's own Settings were open, Pips settings still has both (it is not inside a Pip).
    await press(x, "#pips-settings-close"); await inRoot(x, "[data-job]"); await x.settle();
    await toChat(x); await toPage(x, "job");
    await back(x, "simple-to-chat"); await back(x, "simple-back");
    await press(x, "#pips-settings-open"); await gone(x, "[data-job]"); await x.settle();
    withBoth(await now(x.page), list, "Pips settings, after a Pip's Settings");
    await press(x, "#pips-settings-close"); await inRoot(x, "[data-job]"); await x.settle();
    // New Pip.
    await press(x, "#simple-new"); await x.settle(); await x.page.waitForTimeout(120);
    withBoth(await now(x.page), list, "New Pip");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  // A project's list, its own Context and Notifications, and its New Pip.
  const p = await openDock(browser, { width: 300, height: 700, pip: { project: true } });
  try {
    const list = await toList(p);
    withBoth(list, list, "a project's list of Pips");
    for (const [id, title] of [["workspace-context", "Workspace context"], ["workspace-notifications", "Notifications"]]) {
      await press(p, `#${id}`); await inRoot(p, "#workspace-back"); await p.settle();
      const s = await now(p.page);
      assert.equal(s.title, title);
      withBoth(s, list, `the project's ${title}`);
      await p.page.locator("#pips-host #workspace-back").click(); await inRoot(p, "[data-job]"); await p.settle();
    }
    await press(p, "#simple-new"); await p.settle(); await p.page.waitForTimeout(120);
    withBoth(await now(p.page), list, "a project's New Pip");
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test("a Pip's Settings and History: the keyboard never lands on the hidden dock or the hidden tab bar", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    await toList(x);
    // On the list both are reached by Tab (the control: this walk does find them when they are there).
    const onList = [...await walk(x, 40), ...await walk(x, 40, "Shift+Tab")];
    assert.ok(onList.some((f) => f.startsWith("dock")) && onList.some((f) => f.startsWith("tabs")), `on the list Tab reaches the dock and the tab bar (${[...new Set(onList)].join(" ")})`);
    await toChat(x);
    for (const [tab, under] of [["job", "Settings"], ["runs", "History"]]) {
      await toPage(x, tab);
      const forward = await walk(x, 70), backward = await walk(x, 70, "Shift+Tab");
      for (const at of [...forward, ...backward]) assert.ok(!/^(dock|tabs)/.test(at), `focus reached ${at} on a Pip's ${under}`);
      assert.ok(forward.some((f) => f.startsWith("pips")), `the walk did go through ${under} (${[...new Set(forward)].join(" ")})`);
      // Nothing in either can take focus at all.
      const can = await x.page.evaluate(() => [...document.querySelectorAll("#dgc-dock button, #side-tabs button")].map((b) => { b.focus(); return document.activeElement === b; }));
      assert.ok(can.length >= 9 && can.every((took) => took === false), `${under}: no dock item and no tab takes focus (${can.join()})`);
    }
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("nothing flickers between the list, a Pip's chat, its Settings and its History", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    await toList(x);
    await watchFrames(x.page);
    for (let i = 0; i < 3; i++) {
      await toChat(x); await toPage(x, "job"); await toPage(x, "runs"); await toPage(x, "job");
      await back(x, "simple-to-chat"); await back(x, "simple-back");
    }
    const seen = await frames(x.page);
    assert.ok(seen.length > 30, `frames were watched (${seen.length})`);
    for (const view of ["chat", "job", "runs"]) assert.ok(seen.some((f) => f.view === view), `through ${view}`);
    assert.ok(seen.some((f) => f.list), "and the list");
    // In every frame the two go together, and against a Pip's page: there with the list, away inside a Pip.
    const wrong = seen.filter((f) => f.dock !== f.tabs || f.inside === f.dock);
    assert.deepEqual(wrong.slice(0, 3), [], `${wrong.length} of ${seen.length} frames showed a Pip's page with the dock or the tab bar, or the list without`);
    // Each visit is one change each way, however many of its pages were opened: three times away, three times back.
    const turns = seen.filter((f, i) => i > 0 && f.dock !== seen[i - 1].dock).length;
    assert.equal(turns, 6, `the dock changed ${turns} times over three visits`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("\"When I point at the bottom\": nothing rises over a Pip's Settings; another tab from there has both at once", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700, show: "hover" });
  try {
    const list = await toList(x);
    await toChat(x);
    const settings = await toPage(x, "job");
    assert.deepEqual(both(settings), [false, false], "a Pip's Settings: no short line for the dock, no tab bar");
    await x.page.mouse.move(150, 698, { steps: 4 }); await x.page.waitForTimeout(400);
    assert.equal((await dockNow(x.page)).shown, false, "the pointer at the bottom edge raises no dock over the page");
    await x.page.mouse.move(150, 300);
    // The view is closed from outside while a Pip's Settings are open (the host shows Work): both are there at once.
    await x.page.evaluate(() => document.getElementById("side-tab-work").click()); await x.settle();
    const away = await now(x.page);
    assert.deepEqual([...both(away), away.panel], [true, true, "work-home"], "left for Work from a Pip's Settings");
    // And the Pips tab after that opens the list with both, never a moment of the old page without them.
    await watchFrames(x.page);
    await x.page.click("#side-tab-pips"); await inRoot(x, "[data-job]"); await x.settle();
    const seen = await frames(x.page);
    assert.ok(seen.length > 2 && seen.every((f) => f.dock && f.tabs), `the Pips tab never hides the tab bar or the dock (${JSON.stringify(seen.filter((f) => !f.dock || !f.tabs).slice(0, 3))})`);
    withBoth(await now(x.page), list, "the list again");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the list's Controls menu closes on Escape, and focus returns to its button", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    await toList(x);
    const controls = () => x.page.evaluate(() => { const root = document.getElementById("pips-host").shadowRoot, d = root.querySelector("details.runner-controls");
      return { open: d.open, menu: !!d.querySelector(".runner-menu")?.checkVisibility(), focus: root.activeElement?.id || "", inMenu: !!root.activeElement?.closest?.(".runner-menu"), list: !!root.querySelector("[data-job]") }; });
    // Opened by the keyboard, Escape with focus on the button itself.
    await x.page.evaluate(() => document.getElementById("pips-host").shadowRoot.querySelector("#runner-controls-toggle").focus());
    await x.page.keyboard.press("Enter"); await x.settle();
    assert.deepEqual(await controls(), { open: true, menu: true, focus: "runner-controls-toggle", inMenu: false, list: true }, "Enter on the button opens Controls");
    await x.page.keyboard.press("Escape"); await x.settle();
    assert.deepEqual(await controls(), { open: false, menu: false, focus: "runner-controls-toggle", inMenu: false, list: true }, "Escape closes it, and focus is on its button");
    // Opened by a click, focus moved into the menu by Tab, then Escape.
    await x.page.locator("#pips-host #runner-controls-toggle").click(); await x.settle();
    await x.page.keyboard.press("Tab");
    const inside = await controls();
    assert.deepEqual([inside.open, inside.inMenu], [true, true], `Tab goes into the open menu (${inside.focus})`);
    await x.page.keyboard.press("Escape"); await x.settle();
    assert.deepEqual(await controls(), { open: false, menu: false, focus: "runner-controls-toggle", inMenu: false, list: true }, "Escape from inside the menu closes it, and focus is on its button");
    // It stays closed over the page's next redraw, and a click on the button still opens and closes it.
    await x.page.waitForTimeout(300);
    assert.equal((await controls()).open, false, "still closed");
    await x.page.locator("#pips-host #runner-controls-toggle").click(); await x.settle();
    assert.equal((await controls()).open, true, "a click opens it");
    await x.page.locator("#pips-host #runner-controls-toggle").click(); await x.settle();
    assert.equal((await controls()).open, false, "and a click closes it");
    assert.deepEqual(both(await now(x.page)), [true, true], "the list keeps the dock and the tab bar throughout");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
