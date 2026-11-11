// A Pip's chat in the side bar has the room to itself (asked 11 Nov): while a Pip's conversation is open, where its
// prompt box shows, neither the dock at the foot (media/shared/dock.js) nor the tab bar (Home, Work, Chat, Pips) is
// shown, and the chat takes their space. DGC's own header stays. Both come back on the list of Pips and on the Home,
// Work and Chat tabs; the chat's own back arrow is the way back, by mouse and by keyboard. (Since 12 Nov a Pip's
// Settings, History and its other pages have neither as well: inside-pip.test.mjs.) Measured in real Chromium on the side bar's real page (support/dock-scene.mjs). Held here:
//   - no dock and no tab bar in a Pip's chat: not visible, and the keyboard never lands on either
//   - the chat gains exactly their height: its log has the height it has with the dock set to Never, plus the tab bar's
//   - the prompt box keeps its usual margin from the foot of the side bar
//   - both come back on the list, and on Home, Work and Chat; a Pip's Settings and History stay without them
//   - the back arrow brings them back, by a click and by the keyboard, and focus is never left on a hidden thing
//   - nothing flickers: no frame shows the chat with the dock or the tab bar, or the list without them
//   - "When I point at the bottom" and a pinned Pip opened from the dock follow the same rule
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, dockNow, PINS, PIP } from "./support/dock-scene.mjs";

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

/** The side bar as it is on screen: what shows, where the Pips view, its log and its prompt box are, and where focus is. */
const now = (page) => page.evaluate(() => {
  const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width }; };
  const dock = document.getElementById("dgc-dock"), tabs = document.getElementById("side-tabs"), head = document.getElementById("phead"), host = document.getElementById("pips-host");
  const root = host.shadowRoot, active = document.activeElement, inner = root?.activeElement;
  const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true });
  return { dock: seen(dock), dockRect: rect(dock), tabs: seen(tabs), tabsRect: rect(tabs), head: seen(head), headRect: rect(head),
    hint: seen(dock?.querySelector(".dgc-dock-hint")),
    pips: seen(host), host: rect(host), form: rect(root?.querySelector("#chat-form")), log: rect(root?.querySelector(".conversation-log")),
    list: !!root?.querySelector("[data-job]"), back: !!root?.querySelector("#simple-back"),
    focusIn: active?.closest?.("#dgc-dock") ? "dock" : active?.closest?.("#side-tabs") ? "tabs" : active === host ? "pips" : active === document.body ? "body" : active?.id || active?.tagName || "",
    focusId: inner?.id || active?.id || "", height: innerHeight, width: innerWidth,
    panel: ["home-hub", "work-home", "chats-home"].find((id) => seen(document.getElementById(id))) || (seen(host) ? "pips-host" : ""),
    overflowX: document.documentElement.scrollWidth > innerWidth };
});
const pipsRoot = (x, selector) => x.page.waitForFunction((s) => !!document.getElementById("pips-host").shadowRoot?.querySelector(s), selector);
const gone = (x, selector) => x.page.waitForFunction((s) => !document.getElementById("pips-host").shadowRoot?.querySelector(s), selector);
async function toList(x) { await x.page.click("#side-tab-pips"); await pipsRoot(x, "[data-job]"); await x.settle(); return now(x.page); }
async function toChat(x) { await x.page.locator("#pips-host [data-job]").first().click(); await pipsRoot(x, "#chat-form"); await x.settle(); return now(x.page); }
/** A row of the Pip's own menu ("..."), clicked in the page. (Playwright's own click first scrolls the row into view, and
 *  in a Pip's chat that moves the whole page: screen-reader words inside the log reach below the side bar. Not this change's.) */
const menu = (x, tab) => x.page.evaluate((t) => { const root = document.getElementById("pips-host").shadowRoot;
  root.querySelector("details.pip-menu > summary").click(); root.querySelector(`details.pip-menu [data-tab="${t}"]`).click(); }, tab);
const both = (s) => [s.dock, s.tabs];
/** Tab `n` times, forward or back: where focus was after each press. */
async function walk(x, n, key = "Tab") {
  const seen = [];
  for (let i = 0; i < n; i++) { await x.page.keyboard.press(key); const s = await now(x.page); seen.push(`${s.focusIn}${s.focusId ? `:${s.focusId}` : ""}`); }
  return seen;
}
/** Notes every frame from now on: whether the chat's prompt box is there, and whether the dock and the tab bar show. */
const watchFrames = (page) => page.evaluate(() => {
  const frames = window.__frames = []; window.__watching = true;
  const look = () => {
    if (!window.__watching) return;
    const root = document.getElementById("pips-host").shadowRoot, seen = (id) => !!document.getElementById(id)?.checkVisibility();
    frames.push({ chat: !!root?.querySelector("#chat-form"), list: !!root?.querySelector("[data-job]"), pips: seen("pips-host"), dock: seen("dgc-dock"), tabs: seen("side-tabs") });
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
});
const frames = (page) => page.evaluate(() => { window.__watching = false; return window.__frames; });

for (const width of [300, 700]) {
  test(`${width}px: a Pip's chat shows no dock and no tab bar, and takes their space`, async (t) => {
    if (skipOrFail(t)) return;
    // The same chat with the dock set to Never: how tall the log is when no dock takes room, and the box's usual margin.
    const plain = await openDock(browser, { width, height: 700, show: "never" });
    let never;
    try { await toList(plain); never = await toChat(plain); } finally { await plain.close(); }
    const x = await openDock(browser, { width, height: 700 });
    try {
      const list = await toList(x);
      assert.deepEqual(both(list), [true, true], "the list of Pips has the dock and the tab bar");
      assert.ok(list.dockRect.height > 30 && list.tabsRect.height > 30, "and each takes real room there");
      const chat = await toChat(x);
      assert.deepEqual(both(chat), [false, false], "a Pip's chat: the dock and the tab bar are not shown");
      assert.equal(chat.head, true, "DGC's own header stays");
      assert.ok(Math.abs(chat.headRect.height - list.headRect.height) < 0.6 && Math.abs(chat.headRect.top - list.headRect.top) < 0.6, "where and as it was");
      assert.ok(Math.abs(chat.host.top - chat.headRect.bottom) < 0.6, `the chat begins under the header (${chat.host.top} against ${chat.headRect.bottom})`);
      assert.ok(Math.abs(chat.host.bottom - chat.height) < 0.6, `and reaches the foot of the side bar (${chat.host.bottom} of ${chat.height})`);
      assert.ok(Math.abs(chat.host.height - (list.host.height + list.dockRect.height + list.tabsRect.height)) < 0.6,
        `the Pips view gains the dock's and the tab bar's height (${chat.host.height} against ${list.host.height} + ${list.dockRect.height} + ${list.tabsRect.height})`);
      // The log is what grows: as tall as with the dock set to Never (which still has its tab bar), plus the tab bar.
      assert.ok(never.tabs === false || Math.abs(chat.log.height - (never.log.height + list.tabsRect.height)) < 0.6,
        `the log gains the tab bar's height over the dock-less chat (${chat.log.height} against ${never.log.height} + ${list.tabsRect.height})`);
      assert.ok(chat.log.height >= 371 + list.dockRect.height + list.tabsRect.height - 0.6 || width !== 300, `at 300 px the log is the dock and the tab bar taller than it was (${chat.log.height})`);
      // The prompt box: the same size, at the bottom with the margin it has when there is no dock.
      assert.ok(Math.abs((chat.height - chat.form.bottom) - (never.height - never.form.bottom)) < 0.6,
        `the prompt box keeps its usual margin at the foot (${chat.height - chat.form.bottom} against ${never.height - never.form.bottom})`);
      assert.ok(Math.abs(chat.form.height - never.form.height) < 0.6 && Math.abs(chat.form.left - never.form.left) < 0.6 && Math.abs(chat.form.width - never.form.width) < 0.6, "and its size and place across");
      assert.ok(Math.abs((chat.form.top - chat.log.bottom) - (never.form.top - never.log.bottom)) < 0.6, "and its gap under the log");
      assert.equal(chat.overflowX, false, "nothing scrolls sideways");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a Pip's chat: the keyboard never lands on the hidden dock or the hidden tab bar", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    await toList(x);
    // On the list both are reached by Tab (the control: this walk does find them when they are there).
    const onList = [...await walk(x, 40), ...await walk(x, 40, "Shift+Tab")];
    assert.ok(onList.some((f) => f.startsWith("dock")) && onList.some((f) => f.startsWith("tabs")), `on the list Tab reaches the dock and the tab bar (${[...new Set(onList)].join(" ")})`);
    const chat = await toChat(x);
    assert.deepEqual(both(chat), [false, false]);
    const forward = await walk(x, 60), backward = await walk(x, 60, "Shift+Tab");
    for (const at of [...forward, ...backward]) assert.ok(!/^(dock|tabs)/.test(at), `focus reached ${at} in a Pip's chat`);
    assert.ok(forward.some((f) => f.startsWith("pips")), `the walk did go through the chat (${[...new Set(forward)].join(" ")})`);
    // Nothing in either can take focus at all.
    const can = await x.page.evaluate(() => [...document.querySelectorAll("#dgc-dock button, #side-tabs button")].map((b) => { b.focus(); return document.activeElement === b; }));
    assert.ok(can.length >= PINS.length + 5 && can.every((took) => took === false), `no dock item and no tab takes focus (${can.join()})`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the dock and the tab bar come back on the list, and on Home, Work and Chat; not on a Pip's Settings or History", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    const list = await toList(x);
    assert.deepEqual(both(await toChat(x)), [false, false], "the chat");
    // A Pip's Settings, from its menu: its own page, not its conversation.
    await menu(x, "job");
    await gone(x, "#chat-form"); await x.settle();
    const settings = await now(x.page);
    assert.deepEqual([...both(settings), settings.panel], [false, false, "pips-host"], "a Pip's Settings has neither (12 Nov: every page inside a Pip)");
    assert.ok(Math.abs(settings.host.top - settings.headRect.bottom) < 0.6 && Math.abs(settings.host.bottom - settings.height) < 0.6 && settings.host.height > list.host.height + 60,
      `and the room they took (${settings.host.top} to ${settings.host.bottom} against the list's ${list.host.top} to ${list.host.bottom})`);
    // Back to the chat from there, and away again.
    await x.page.locator("#pips-host #simple-to-chat").click(); await pipsRoot(x, "#chat-form"); await x.settle();
    assert.deepEqual(both(await now(x.page)), [false, false], "back in the chat");
    await menu(x, "runs");
    await gone(x, "#chat-form"); await x.settle();
    assert.deepEqual(both(await now(x.page)), [false, false], "a Pip's History has neither");
    // (The loop below starts from the Pips tab, which History no longer shows: back by the page's arrow, then the chat's.)
    await x.page.locator("#pips-host #simple-to-chat").click(); await pipsRoot(x, "#chat-form"); await x.settle();
    await x.page.locator("#pips-host #simple-back").click(); await pipsRoot(x, "[data-job]"); await x.settle();
    // Each other tab, reached the only way there is from a chat: back to the list, then the tab.
    for (const [tab, panel] of [["home", "home-hub"], ["work", "work-home"], ["chat", "chats-home"]]) {
      await toList(x); await toChat(x);
      await x.page.locator("#pips-host #simple-back").click(); await pipsRoot(x, "[data-job]"); await x.settle();
      await x.page.click(`#side-tab-${tab}`); await x.settle();
      const s = await now(x.page), d = await dockNow(x.page);
      assert.deepEqual([...both(s), s.panel], [true, true, panel], `the ${tab} tab has both`);
      assert.ok(Math.abs(d.host.bottom - d.height) < 0.6 && d.items.length === PINS.length + 1, `the dock is whole at the foot of ${tab}`);
    }
    // The view is closed from outside while a chat is open (the host shows the sessions): both are there at once.
    await toList(x); await toChat(x);
    await x.page.evaluate(() => document.getElementById("side-tab-work").click()); await x.settle();
    const away = await now(x.page);
    assert.deepEqual([...both(away), away.panel], [true, true, "work-home"], "left for Work from a chat");
    // And the Pips tab after that opens the list with both, never a moment of the old chat without them.
    await watchFrames(x.page);
    await x.page.click("#side-tab-pips"); await pipsRoot(x, "[data-job]"); await x.settle();
    const seen = await frames(x.page);
    assert.ok(seen.length > 2 && seen.every((f) => f.dock && f.tabs), `the Pips tab never hides the tab bar or the dock (${JSON.stringify(seen.filter((f) => !f.dock || !f.tabs).slice(0, 3))})`);
    const again = await now(x.page);
    assert.deepEqual([...both(again), again.focusIn], [true, true, "tabs"], "and the tab that was clicked keeps focus");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the back arrow brings the tab bar and the dock back, by a click and by the keyboard", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    const list = await toList(x);
    const chat = await toChat(x);
    assert.deepEqual([...both(chat), chat.back], [false, false, true], "the chat: no dock, no tab bar, and its back arrow");
    await x.page.locator("#pips-host #simple-back").click(); await pipsRoot(x, "[data-job]"); await x.settle();
    const clicked = await now(x.page), d = await dockNow(x.page);
    assert.deepEqual([...both(clicked), clicked.list], [true, true, true], "a click on the back arrow: the list, with both");
    assert.deepEqual([clicked.host.top, clicked.host.bottom, clicked.tabsRect.top, clicked.dockRect.top], [list.host.top, list.host.bottom, list.tabsRect.top, list.dockRect.top], "everything where it was");
    assert.deepEqual(d.items.map((i) => i.key), [...PINS.map((p) => p.key), "+"], "the dock as it was: the same six, then +");
    assert.equal((await x.tabs()).tabs.filter((tab) => tab.selected).map((tab) => tab.id).join(), "pips", "Pips is still the tab that is lit");
    // By the keyboard: Tab to the arrow from the top of the chat, Enter.
    await toChat(x);
    await x.page.evaluate(() => { document.activeElement?.blur?.(); document.getElementById("pips-host").shadowRoot.activeElement?.blur?.(); });
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) { await x.page.keyboard.press("Tab"); reached = (await now(x.page)).focusId === "simple-back"; }
    assert.equal(reached, true, "Tab reaches the back arrow");
    assert.equal(await x.page.evaluate(() => { const b = document.getElementById("pips-host").shadowRoot.querySelector("#simple-back"); return b.tagName === "BUTTON" && !b.disabled && !!b.getAttribute("aria-label") && b.checkVisibility(); }), true, "a named button");
    await x.page.keyboard.press("Enter"); await pipsRoot(x, "[data-job]"); await gone(x, "#chat-form"); await x.settle();
    const keyed = await now(x.page);
    assert.deepEqual([...both(keyed), keyed.list], [true, true, true], "Enter on the back arrow: the list, with both");
    // From there the keyboard reaches the tab bar and the dock again.
    const after = [...await walk(x, 40), ...await walk(x, 40, "Shift+Tab")];
    assert.ok(after.some((f) => f.startsWith("dock")) && after.some((f) => f.startsWith("tabs")), `Tab reaches both again (${[...new Set(after)].join(" ")})`);
    // Space as well.
    await toChat(x);
    await x.page.evaluate(() => document.getElementById("pips-host").shadowRoot.querySelector("#simple-back").focus());
    await x.page.keyboard.press("Space"); await gone(x, "#chat-form"); await x.settle();
    assert.deepEqual(both(await now(x.page)), [true, true], "Space on the back arrow");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("nothing flickers between the list and a Pip's chat", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    await toList(x);
    await watchFrames(x.page);
    for (let i = 0; i < 3; i++) {
      await x.page.locator("#pips-host [data-job]").first().click(); await pipsRoot(x, "#chat-form"); await x.settle();
      await x.page.locator("#pips-host #simple-back").click(); await gone(x, "#chat-form"); await x.settle();
    }
    const seen = await frames(x.page);
    assert.ok(seen.length > 12, `frames were watched (${seen.length})`);
    assert.ok(seen.some((f) => f.chat) && seen.some((f) => !f.chat), "through the chat and the list");
    // In every frame the two go together, and with the prompt box: there with the list, away with the chat.
    const wrong = seen.filter((f) => f.dock !== f.tabs || f.chat === f.dock);
    assert.deepEqual(wrong.slice(0, 3), [], `${wrong.length} of ${seen.length} frames showed the chat with the dock or the tab bar, or the list without`);
    // Each way is one change: three times away, three times back.
    const turns = seen.filter((f, i) => i > 0 && f.dock !== seen[i - 1].dock).length;
    assert.equal(turns, 6, `the dock changed ${turns} times over three visits`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a pinned Pip opened from the dock: its chat has no dock and no tab bar, and focus is in the chat", async (t) => {
  if (skipOrFail(t)) return;
  // (The Pip the Pips view on this page knows, pinned first.)
  const key = `pip:${PIP}`;
  const x = await openDock(browser, { width: 300, height: 700, pins: [{ key, kind: "pip", id: PIP, title: "Mornings", sub: "", look: { body: "lens" }, ref: {} }, ...PINS.slice(3)] });
  try {
    // From the Work tab, by the keyboard: focus is on the dock's item when its chat opens.
    await x.page.evaluate((k) => document.querySelector(`#dgc-dock .dgc-dock-item[data-key="${k}"]`).focus(), key);
    assert.equal((await now(x.page)).focusIn, "dock");
    await x.page.keyboard.press("Enter"); await pipsRoot(x, "#chat-form"); await x.settle();
    const chat = await now(x.page);
    assert.deepEqual(both(chat), [false, false], "its chat: no dock, no tab bar");
    assert.equal(chat.focusIn, "pips", `focus is in the Pip's chat, not left on the hidden dock (${chat.focusIn})`);
    // The first Tab from there stays in the chat.
    const next = await walk(x, 3);
    for (const at of next) assert.ok(at.startsWith("pips"), `Tab went to ${at}`);
    // The back arrow leads to the list of Pips, with both.
    await x.page.locator("#pips-host #simple-back").click(); await gone(x, "#chat-form"); await x.settle();
    const back = await now(x.page);
    assert.deepEqual([...both(back), back.panel], [true, true, "pips-host"]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("\"When I point at the bottom\": no dock and no short line in a Pip's chat; Never stays never", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700, show: "hover" });
  try {
    const list = await toList(x);
    assert.deepEqual([list.dock, list.hint, list.tabs], [true, true, true], "on the list: the short line that marks the dock, and the tab bar");
    const chat = await toChat(x);
    assert.deepEqual([chat.dock, chat.hint, chat.tabs], [false, false, false], "in a Pip's chat: none of them");
    // The pointer at the bottom edge brings nothing up over the prompt box.
    await x.page.mouse.move(150, 698, { steps: 4 }); await x.page.waitForTimeout(400);
    const pointed = await dockNow(x.page);
    assert.equal(pointed.shown, false, "the pointer at the bottom edge raises no dock over the prompt box");
    await x.page.mouse.move(150, 300);
    await x.page.locator("#pips-host #simple-back").click(); await gone(x, "#chat-form"); await x.settle();
    const back = await now(x.page);
    assert.deepEqual([back.dock, back.hint, back.tabs], [true, true, true], "back on the list");
    await x.setting({ show: "never" }); await x.settle();
    assert.deepEqual(both(await now(x.page)), [false, true], "Never: no dock on the list, the tab bar as ever");
    assert.deepEqual(both(await toChat(x)), [false, false]);
    await x.page.locator("#pips-host #simple-back").click(); await gone(x, "#chat-form"); await x.settle();
    assert.deepEqual(both(await now(x.page)), [false, true], "Never: still no dock back on the list");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
