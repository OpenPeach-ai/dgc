// The side bar's tabs and Home, the hub (media/shared/tabs.css, media/shared/hub.js and hub.css, media/main.js), measured
// in real Chromium on the side bar's real page (support/home-scene.mjs and dock-scene.mjs). What is held here:
//   - one centred tab bar at the top, under the header row: Home, Work, Chat, Pips, as names only; it replaces the header's Pips button and the Pips block
//   - the tab you are on is lit in the accent; pointing at another only changes its name to the text colour (13 Nov)
//   - the keyboard: Left and Right move and choose (wrapping), Home and End jump, and the bar is one tab stop
//   - the five names fit at 292 px; under 292 px the tabs are icons (side-tabs-icons.test.mjs), down to 170 px
//   - Home: everything that needs you or is new is one card of one size and style, from a session (its blob) or a Pip
//     (its face), in two groups, "Needs you" then "New"; each card's answers work; an empty Home says so in one line
//   - Show: All, Work, Chat, Personal Pips, Project Pips, each with its count; kept until changed; Home's number counts all
//   - Work and Chat list their sessions with blobs (a running one: the accent's dot), each with its own search and New
//   - Pips is the Pips page, with its Personal and Project tabs; the dock is under every tab
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { openDock, dockNow, DOCK_SESSIONS, pipId } from "./support/dock-scene.mjs";
import { openHome, homeState, CHATS, SESSIONS, P, Q } from "./support/home-scene.mjs";

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
const names = (t) => t.tabs.filter((x) => x.shown).map((x) => x.name);
const chosen = (t) => t.tabs.filter((x) => x.selected).map((x) => x.id);
const settle = (page, ms = 60) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);
const tone = (page, token) => page.evaluate((name) => { const probe = document.createElement("span"); probe.style.color = `var(${name})`; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; }, token);
const tab = (t, id) => t.tabs.find((x) => x.id === id);
const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];

// ---- every source, on one page ---------------------------------------------------------------------------------------
const SETUP = "setup_" + "7".repeat(32);
/** Two Pips wait for you (one of them a new Pip to review), three have news, one of those in the project. */
function everything() {
  const state = homeState("busy");
  state.attention.items.push({ id: `setup:${SETUP}`, kind: "setup", card: SETUP, pip_id: null, pip_name: "Receipts", pip_type: "rook", workspace_id: P,
    title: "Create the Pip Receipts?", detail: "Gmail · Mondays 9:00", created_at: "2026-11-03T09:00:00.000Z", expires_at: null });
  state.attention.total = 3; state.attention.counts.setup = 1;
  return state;
}
const WINDOWLESS = { id: "20261103-120000-e5", path: "/s/e5.json", name: "Nightly export, second try", preview: "", when: "2026-11-03 12:00", count: 9, open: false, windowless: "Running the export" };
const HUB_SESSIONS = [...DOCK_SESSIONS, WINDOWLESS];
/** Opens Home with every source on it: a session that wants your okay, one running with no window, one that has just
 *  finished, a chat that has just answered, a Pip with things waiting, a new Pip, Pips with messages and a failed run. */
async function openEverything(options = {}) {
  const x = await openDock(browser, { tab: "home", state: everything(), sessions: HUB_SESSIONS, answering: ["chat_2"], height: 900, ...options });
  // The running session stops, and the chat finishes answering: both are news now.
  await x.send({ type: "sessions_list", items: HUB_SESSIONS.map((s) => (s.running ? { ...s, running: false } : s)), error: "" });
  await x.send({ type: "chatdgc_list", available: true, items: CHATS, open: ["chat_1"], answering: [] });
  await settle(x.page);
  return x;
}
const WORK_WAITS = `work:${DOCK_SESSIONS[2].id}`, WORK_NO_WINDOW = `work:${WINDOWLESS.id}`, WORK_DONE = `work:${DOCK_SESSIONS[0].id}`, CHAT_DONE = "chat:chat_2";
const PIP_WAITS = `pip:${pipId("b")}`, PIP_NEW = `setup:${SETUP}`, PIP_READ_1 = `pip:${pipId("c")}`, PIP_READ_2 = `pip:${pipId("d")}`, PIP_FAILED = `pip:${pipId("e")}`;

// ---- the tab bar -----------------------------------------------------------------------------------------------------
for (const width of [300, 700]) {
  test(`${width}px: one centred tab bar at the top of the side bar, names only: Home, Work, Chat, Library, Pips`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 700 });
    try {
      const bar = await x.tabs();
      assert.equal(bar.shown, true, "the side bar has a tab bar");
      assert.equal(bar.role, "tablist");
      assert.deepEqual(names(bar), ["Home", "Work", "Chat", "Library", "Pips"], "five tabs, in this order (Library before Pips since 15 Nov: Pips stays last)");
      assert.deepEqual(bar.tabs.map((x) => x.icons), [0, 0, 0, 1, 1], "names: no line icon in any tab; Library wears his books (library-iris-browser.test.mjs) and Pips the Core Pip's face (side-tab-pips-face.test.mjs)");
      assert.deepEqual(chosen(bar), ["home"], "it opens on Home");
      assert.ok(Math.abs((bar.bar.left + bar.bar.right) / 2 - width / 2) < 0.6, `the bar is centred (${bar.bar.left} to ${bar.bar.right} of ${width})`);
      assert.ok(bar.bar.left >= 11.5 && bar.bar.right <= width - 11.5, "it keeps the side bar's 12 px gutter");
      // (The header row with DGC's wordmark is above it again, alone: side-top-header.test.mjs.)
      assert.ok(bar.nav.top <= 36 && bar.bar.top <= 40, `it is right under the header row (${bar.bar.top})`);
      assert.equal(bar.header, true, "the header row is above it");
      assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll("#phead button")].filter((b) => b.checkVisibility()).map((b) => b.id)), [], "the Pips button it replaced is not in the header");
      const widths = bar.tabs.map((x) => Math.round(x.width));
      // (Five tabs of one width from 370 px; under it each is as wide as its name needs, or Home's name and number would not fit.)
      if (width >= 370) assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `the five tabs are one width (${widths})`);
      assert.ok(bar.tabs.every((x) => !x.clipped), "no name is cut");
      // What it replaced is not on the page: the Pips block over the sessions, and the Work | Chat pair inside the list.
      const old = await x.page.evaluate(() => ["#sessions-pips", "#home-tabs", "#sessions-fold", ".home-pips-head"].filter((sel) => document.querySelector(sel)));
      assert.deepEqual(old, [], "the Pips block and the Work | Chat pair are gone");
      // Each tab names the panel it shows, and that panel says which tab it belongs to.
      assert.deepEqual(bar.tabs.map((x) => x.controls), ["home-hub", "work-home", "chats-home", "library-home", "pips-host"]);
      assert.deepEqual([bar.panel, bar.panelRole, bar.panelLabelledBy], ["home-hub", "tabpanel", "side-tab-home"]);
      // Home shows its count: every card on it.
      const hub = await x.hub();
      assert.ok(hub.cards.length >= 4, "Home has its cards");
      assert.equal(tab(bar, "home").count, String(hub.cards.length), "Home's number is how many cards wait or are new");
      assert.match(tab(bar, "home").label, new RegExp(`^Home: ${hub.cards.length} things need you or are new$`), "and a screen reader hears it");
      assert.equal(bar.overflowX, false);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the tab you are on is lit in the accent; pointing at another only changes its name from the quiet grey to the text colour (13 Nov)", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern"]) {
    const x = await openDock(browser, { tab: "home", theme, width: 300, height: 500 });
    try {
      const accent = await tone(x.page, "--accent-text"), quiet = await tone(x.page, "--text-2"), text = await tone(x.page, "--text");
      let bar = await x.tabs();
      assert.equal(names(bar).length, 5, `${theme}: five tabs`);
      assert.equal(tab(bar, "home").color, accent, `${theme}: the tab you are on is in the accent's text tone`);
      assert.ok(tab(bar, "home").glow > 0.95, `${theme}: with the glow behind it`);
      for (const id of ["work", "chat", "pips"]) {
        assert.equal(tab(bar, id).color, quiet, `${theme}: ${id} is quiet at rest`);
        assert.equal(tab(bar, id).glow, 0, `${theme}: ${id} has no glow at rest`);
        assert.deepEqual([tab(bar, id).front, tab(bar, id).frontOpacity, tab(bar, id).copies], ["none", 1, 1], `${theme}: ${id}'s name faces you, and is in the tab once`);
      }
      // Each tab pointed at in turn takes the text colour: no accent, no glow, no turn (it lit up and turned its name
      // over until 13 Nov; side-bar-ui13.test.mjs holds that nothing moves on the way either).
      for (const id of ["work", "chat", "pips"]) {
        await x.page.mouse.move(...centre(tab(bar, id)), { steps: 3 });
        await x.page.waitForTimeout(900);
        const now = tab(await x.tabs(), id);
        assert.equal(now.color, text, `${theme}: ${id} pointed at is in the text colour`);
        assert.equal(now.glow, 0, `${theme}: with no glow`);
        assert.deepEqual([now.front, now.frontOpacity], ["none", 1], `${theme}: its name stays facing you`);
        assert.equal(now.selected, false, "pointing chooses nothing");
      }
      await x.page.mouse.move(150, 300); await x.page.waitForTimeout(900);
      bar = await x.tabs();
      assert.deepEqual([tab(bar, "work").color, tab(bar, "work").frontOpacity], [quiet, 1], `${theme}: the pointer gone, it is as it was`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("reduced motion: a tab pointed at takes the text colour at once", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 300, height: 500, motion: "reduce" });
  try {
    const text = await tone(x.page, "--text");
    const bar = await x.tabs();
    assert.equal(names(bar).length, 5);
    await x.page.mouse.move(...centre(tab(bar, "chat")), { steps: 3 });
    await settle(x.page);
    const now = tab(await x.tabs(), "chat");
    assert.equal(now.color, text, "in the text colour at once");
    assert.deepEqual([now.front, now.frontOpacity], ["none", 1], "its name stays facing you");
  } finally { await x.close(); }
});

test("the keyboard: Left and Right move between the tabs and choose, Home and End jump, and the bar is one tab stop", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 300, height: 700 });
  try {
    let bar = await x.tabs();
    assert.deepEqual(bar.tabs.map((x) => x.tab), [0, -1, -1, -1, -1], "one tab stop: the tab you are on");
    await x.page.focus("#side-tab-home");
    const press = async (key) => { await x.page.keyboard.press(key); await settle(x.page, 120); return x.tabs(); };
    bar = await press("ArrowRight");
    assert.deepEqual([chosen(bar), bar.focus, bar.panel], [["work"], "work", "work-home"], "Right: Work, chosen and focused, its list showing");
    bar = await press("ArrowRight");
    assert.deepEqual([chosen(bar), bar.focus, bar.panel], [["chat"], "chat", "chats-home"]);
    bar = await press("ArrowRight");
    assert.deepEqual([chosen(bar), bar.focus, bar.panel], [["library"], "library", "library-home"], "Right again: Library");
    bar = await press("ArrowRight");
    assert.deepEqual([chosen(bar), bar.focus, bar.panel], [["pips"], "pips", "pips-host"], "Right again: Pips, the last tab, and the Pips page");
    assert.equal(bar.shown, true, "the tab bar stays over the Pips page");
    bar = await press("ArrowRight");
    assert.deepEqual([chosen(bar), bar.focus, bar.panel], [["home"], "home", "home-hub"], "Right from the last wraps to the first");
    bar = await press("ArrowLeft");
    assert.deepEqual([chosen(bar), bar.focus], [["pips"], "pips"], "Left from the first wraps to the last");
    bar = await press("Home");
    assert.deepEqual([chosen(bar), bar.focus, bar.panel], [["home"], "home", "home-hub"], "Home: the first tab");
    bar = await press("End");
    assert.deepEqual([chosen(bar), bar.focus], [["pips"], "pips"], "End: the last tab");
    bar = await press("ArrowLeft");
    assert.deepEqual([chosen(bar), bar.focus], [["library"], "library"]);
    bar = await press("ArrowLeft");
    assert.deepEqual([chosen(bar), bar.focus, bar.panel], [["chat"], "chat", "chats-home"]);
    assert.deepEqual(bar.tabs.map((x) => x.tab), [-1, -1, 0, -1, -1], "the tab stop moved with the choice");
    // Tab leaves the bar for what the tab shows; Shift+Tab comes back to the chosen tab.
    await x.page.keyboard.press("Tab");
    assert.equal(await x.page.evaluate(() => document.activeElement.id), "chats-more-menu", "Tab goes on into the tab's own page: its header row's ⋯ comes first (14 Nov), then its search box");
    await x.page.keyboard.press("Shift+Tab");
    assert.equal((await x.tabs()).focus, "chat", "and back to the tab you are on, not the first");
    // A click chooses as well.
    await x.page.click("#side-tab-work"); await settle(x.page);
    assert.deepEqual(chosen(await x.tabs()), ["work"]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the tab you were on is kept: a reload comes back to it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 300, height: 600 });
  let kept;
  try {
    assert.equal(names(await x.tabs()).length, 5);
    await x.page.click("#side-tab-work"); await settle(x.page);
    kept = await x.kept();
    assert.equal(kept.sideTab, "work", "the page's state holds the tab");
  } finally { await x.close(); }
  const again = await openDock(browser, { saved: kept, width: 300, height: 600 });
  try {
    const bar = await again.tabs();
    assert.deepEqual([chosen(bar), bar.panel], [["work"], "work-home"], "opened again, it is on Work");
  } finally { await again.close(); }
});

test("a narrow side bar: the five names fit at 292 px; under 292 px the tabs are icons, down to 170 px", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [292, 199, 170]) {
    const x = await openDock(browser, { tab: "home", width, height: 600 });
    try {
      const bar = await x.tabs();
      assert.deepEqual(names(bar), ["Home", "Work", "Chat", "Library", "Pips"], `${width}px: five names`);
      assert.ok(bar.bar.left >= 0 && bar.bar.right <= width, `${width}px: the bar is inside the side bar (${bar.bar.left} to ${bar.bar.right})`);
      assert.ok(tab(bar, "home").countBox, `${width}px: Home still says something waits`);
      const count = tab(bar, "home").countBox;
      if (width >= 292) {
        assert.deepEqual(bar.tabs.map((x) => x.icons), [0, 0, 0, 1, 1], `${width}px: words, and no icon but his books on Library and the face on Pips`);
        assert.ok(bar.tabs.every((x) => !x.clipped), `${width}px: no name is cut`);
        for (let i = 1; i < bar.tabs.length; i++) assert.ok(bar.tabs[i].words.left >= bar.tabs[i - 1].words.right + 3, `${width}px: ${bar.tabs[i].name} does not touch ${bar.tabs[i - 1].name}`);
        assert.ok(count.left >= tab(bar, "home").words.right + 2 && count.right <= tab(bar, "home").right, `${width}px: the number is beside Home's name, inside its tab`);
        assert.ok(count.width >= 15, `${width}px: the number is read (${count.width})`);
      } else {
        // Icons, each alone in its tab, and Home's number still a number (all of it: side-tabs-icons.test.mjs).
        assert.deepEqual(bar.tabs.map((x) => x.icons), [1, 1, 1, 1, 1], `${width}px: one icon in each tab`);
        assert.ok(count.width >= 12 && count.height >= 12 && tab(bar, "home").count, `${width}px: the number is read, not a dot (${count.width})`);
      }
      assert.equal(bar.overflowX, false, `${width}px: nothing scrolls sideways`);
      // Home's cards still hold everything they have: no answer is pushed out of its card.
      // (Read where each card shows: what needs you in Needs you opened, then what is new in Recent opened.)
      const outNow = () => x.page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-hub-card")].filter((c) => c.checkVisibility()).flatMap((c) => { const box = c.getBoundingClientRect();
        return [...c.querySelectorAll(".dgc-card-btn, .dgc-ia-btn, .dgc-card-title")].filter((b) => { const r = b.getBoundingClientRect(); return r.bottom > box.bottom - 4 || r.right > box.right - 4 || r.left < box.left + 4; }).map((b) => `${c.dataset.key}: ${b.textContent}`); }));
      const out = await outNow(); await x.card("recent"); out.push(...(await outNow()));
      assert.deepEqual(out, [], `${width}px: every card's sentence and answers are inside it`);
    } finally { await x.close(); }
  }
});

test("a DGC with no ChatDGC has no Chat tab, and the arrows pass over it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", tabs: false, width: 300, height: 600 });
  try {
    assert.deepEqual(names(await x.tabs()), ["Home", "Work", "Library", "Pips"]);
    await x.page.focus("#side-tab-work"); await x.page.keyboard.press("ArrowRight"); await x.page.keyboard.press("ArrowRight"); await settle(x.page, 150);
    assert.deepEqual(chosen(await x.tabs()), ["library"], "Home, then Right twice: Work, then Library (Chat is passed over)");
    await x.page.keyboard.press("ArrowRight"); await settle(x.page, 150);
    assert.deepEqual(chosen(await x.tabs()), ["pips"], "then Pips");
  } finally { await x.close(); }
});

// ---- Home, the hub ---------------------------------------------------------------------------------------------------
for (const width of [300, 700]) {
  test(`${width}px: every source arrives on Home as one card, every card the same size and style`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openEverything({ width });
    try {
      const hub = await x.hub();
      // (Each card measured where it shows: what needs you in Needs you opened, what is new in Recent opened.)
      hub.cards = await x.everyCard(async () => (await x.hub()).cards);
      assert.deepEqual(hub.groups.map((g) => [g.id, g.name]), [["needs", "Needs you"], ["new", "New"]], "two groups, what needs you first");
      const by = Object.fromEntries(hub.cards.map((c) => [c.key, c]));
      // What needs you: a session's approval, a session running with no window, a Pip with things waiting, a new Pip.
      assert.deepEqual(hub.groups[0].cards.map((c) => c.key), [WORK_WAITS, WORK_NO_WINDOW, PIP_WAITS, PIP_NEW]);
      // What is new: a finished session, a chat's answer, Pips' messages, a Pip's failed run.
      assert.deepEqual(hub.groups[1].cards.map((c) => c.key).sort(), [CHAT_DONE, PIP_FAILED, PIP_READ_1, PIP_READ_2, WORK_DONE].sort());
      assert.deepEqual([hub.groups[0].count, hub.groups[1].count], ["4", "5"], "each group says how many");
      // Each says where it is from, and what it wants in a sentence.
      assert.match(by[WORK_WAITS].from, /^Plan the 0\.52 release notes · Work · /); assert.equal(by[WORK_WAITS].title, "Wants your okay to go on");
      assert.match(by[WORK_NO_WINDOW].from, /^Nightly export, second try · Work · /); assert.match(by[WORK_NO_WINDOW].title, /running, with no window/); assert.ok(by[WORK_NO_WINDOW].chips.includes("Running the export"));
      assert.match(by[WORK_DONE].from, /^Fix the login redirect after sign-out · Work · now$/); assert.equal(by[WORK_DONE].title, "Finished its work");
      assert.match(by[CHAT_DONE].from, /^Rent or buy: the numbers · Chat · now$/); assert.equal(by[CHAT_DONE].title, "At 8.5% the two cross in year nine.", "a chat's answer, in its own first words");
      assert.match(by[PIP_WAITS].from, /^Mail watch · Pip/); assert.equal(by[PIP_WAITS].title, "2 things are waiting for you"); assert.deepEqual(by[PIP_WAITS].chips, ["Email · 2", "3 new"]);
      assert.match(by[PIP_NEW].from, /^Receipts · New Pip/); assert.equal(by[PIP_NEW].title, "Create the Pip Receipts?"); assert.deepEqual(by[PIP_NEW].chips, ["Gmail · Mondays 9:00"]);
      assert.match(by[PIP_READ_1].from, /^Morning brief · Pip/); assert.equal(by[PIP_READ_1].title, "Five bullets for this morning, each with its link.");
      assert.match(by[PIP_FAILED].from, /^Billing review · Project Pip/); assert.equal(by[PIP_FAILED].title, "1 run failed");
      // Where each is from: a Pip's face, a session's mark (a Voxel for Work, a Mote for Chat).
      assert.deepEqual([WORK_WAITS, WORK_NO_WINDOW, WORK_DONE].map((k) => by[k].who), ["mark:voxel", "mark:voxel", "mark:voxel"], "a Work session's card has its Voxel");
      assert.equal(by[CHAT_DONE].who, "mark:mote", "a chat's card has its Mote");
      assert.deepEqual([PIP_WAITS, PIP_NEW, PIP_READ_1, PIP_READ_2, PIP_FAILED].map((k) => by[k].who), ["face", "face", "face", "face", "face"], "a Pip's card has its face");
      assert.deepEqual(hub.cards.map((c) => c.source).sort(), ["chat", "personal", "personal", "personal", "personal", "project", "work", "work", "work"]);
      // One size and one style, whatever a card holds: the shared card, thin.
      assert.ok(hub.cards.every((c) => c.shared && c.thin), "every card is the shared card, in its thin form");
      const sizes = new Set(hub.cards.map((c) => `${Math.round(c.width * 2) / 2}x${Math.round(c.height * 2) / 2}`));
      assert.equal(sizes.size, 1, `every card is one size (${[...sizes]})`);
      assert.equal(new Set(hub.cards.map((c) => `${c.radius}|${c.ground}`)).size, 1, "and one corner and ground");
      // One filled answer, at most one quiet one.
      for (const c of hub.cards) {
        assert.equal(c.actions.filter((a) => a.endsWith("*")).length, 1, `${c.key}: one filled answer (${c.actions})`);
        assert.ok(c.actions.length <= 2, `${c.key}: at most one quiet answer`);
      }
      assert.deepEqual(by[PIP_WAITS].actions, ["Review*", "Mark read"]); assert.deepEqual(by[PIP_NEW].actions, ["Review*"]);
      assert.deepEqual(by[WORK_WAITS].actions, ["Open*"]); assert.deepEqual(by[WORK_DONE].actions, ["Open*", "Dismiss"]);
      assert.deepEqual(by[PIP_FAILED].actions, ["Open*", "Dismiss"]); assert.deepEqual(by[PIP_READ_1].actions, ["Open*", "Mark read"]);
      // No card runs into another, and none runs under the dock when scrolled to.
      const cards = hub.cards;
      for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
        const [a, b] = [cards[i], cards[j]];
        if (a.group !== b.group) continue;          // (they are on two pages of Home)
        assert.ok(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5, `${a.key} and ${b.key} do not overlap`);
      }
      assert.equal(new Set(cards.map((c) => Math.round(c.left))).size, width === 300 ? 1 : 2, width === 300 ? "one column in a narrow side bar" : "two columns in a wide one");
      // Home's number counts every card.
      assert.equal(tab(await x.tabs(), "home").count, "9");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a card's answers: Open, Review, Mark read and Dismiss each do their one thing, and the keyboard stays where it was", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openEverything({ width: 300 });
  try {
    const keys = async () => (await x.hub()).cards.map((c) => c.key);
    assert.equal((await keys()).length, 9);
    const act = async (key, what) => { await x.see(key); return x.page.click(`.dgc-hub-card[data-key="${key}"] [data-hub-act="${what}"]`); };
    // A finished session: Dismiss takes it off Home, and the keyboard goes to the card that took its place.
    const order = (await x.hub()).groups[1].cards.map((c) => c.key), at = order.indexOf(WORK_DONE);
    await x.see(WORK_DONE);
    await x.page.focus(`.dgc-hub-card[data-key="${WORK_DONE}"] [data-hub-act="dismiss"]`);
    await x.page.keyboard.press("Enter"); await settle(x.page);
    assert.ok(!(await keys()).includes(WORK_DONE), "dismissed: gone from Home");
    assert.match((await x.hub()).focus, new RegExp(`^${order[at + 1] ?? order[at - 1]}/`), "the keyboard is on the card that took its place");
    // A chat's answer: Open opens the chat, and it is no longer news.
    await act(CHAT_DONE, "open"); await settle(x.page);
    assert.deepEqual((await x.posted("chatdgcOpen")).map((m) => m.id), ["chat_2"]);
    assert.ok(!(await keys()).includes(CHAT_DONE));
    // A session that wants your okay: Open opens its tab; it still needs you until it is answered there.
    await act(WORK_WAITS, "open"); await settle(x.page);
    assert.deepEqual((await x.posted("openSessionInEditor")).map((m) => m.id), [DOCK_SESSIONS[2].id]);
    assert.ok((await keys()).includes(WORK_WAITS), "what needs you stays until it is answered");
    // A Pip's messages: Mark read marks them read without opening anything, and the card goes.
    await act(PIP_READ_1, "read");
    await x.page.waitForFunction((key) => !document.querySelector(`.dgc-hub-card[data-key="${key}"]`), PIP_READ_1);
    const reads = (await x.posted("pipsRequest")).filter((m) => m.request.type === "mark_pip_read");
    assert.deepEqual(reads.map((m) => m.request.pip_id), [pipId("c")]);
    assert.deepEqual(chosen(await x.tabs()), ["home"], "nothing opened");
    // A Pip's failed run: Dismiss marks its news seen.
    await act(PIP_FAILED, "dismiss");
    await x.page.waitForFunction((key) => !document.querySelector(`.dgc-hub-card[data-key="${key}"]`), PIP_FAILED);
    const seen = (await x.posted("pipsRequest")).filter((m) => m.request.type === "mark_pip_news_seen");
    assert.deepEqual(seen.map((m) => m.request.pip_ids), [[pipId("e")]]);
    assert.equal(tab(await x.tabs(), "home").count, String((await keys()).length), "Home's number follows");
    // A Pip with things waiting: Review opens it in Pips, on the Pips tab.
    await act(PIP_WAITS, "open");
    await x.page.waitForFunction(() => document.getElementById("pips-host").checkVisibility());
    const bar = await x.tabs();
    assert.deepEqual([chosen(bar), bar.panel], [["pips"], "pips-host"], "Review leads to the Pip, and the Pips tab is lit");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Clear, beside New, clears everything new and leaves what needs you", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openEverything({ width: 300 });
  try {
    let hub = await x.hub();
    assert.deepEqual(hub.groups.map((g) => g.clear), [false, true], "Clear is beside New only");
    await x.card("recent");          // (what is new, and its Clear, are in Recent)
    await x.page.click("#home-hub .dgc-hub-clear");
    await x.page.waitForFunction(() => !document.querySelector('#home-hub .dgc-hub-group[data-group="new"]'));
    hub = await x.hub();
    assert.deepEqual(hub.groups.map((g) => g.id), ["needs"], "New is gone");
    assert.deepEqual(hub.cards.map((c) => c.key), [WORK_WAITS, WORK_NO_WINDOW, PIP_WAITS, PIP_NEW], "what needs you is all still here");
    assert.deepEqual(hub.cards.find((c) => c.key === PIP_WAITS).chips, ["Email · 2"], "its new messages were read too");
    const asked = (await x.posted("pipsRequest")).map((m) => m.request.type);
    assert.ok(asked.includes("mark_pip_news_seen") && asked.filter((a) => a === "mark_pip_read").length === 3, "the Pips' news is dismissed and their messages marked read");
    assert.equal(tab(await x.tabs(), "home").count, "4");
  } finally { await x.close(); }
});

// (Home's Show filter went on 13 Nov, when Home became cards: the cards you add are the filter. Its test went with it; test/home-cards.test.mjs holds that Show is gone.)

// (Home's Show filter went on 13 Nov, when Home became cards: the cards you add are the filter. Its test went with it; test/home-cards.test.mjs holds that Show is gone.)

test("the host keeps Home's Show filter on this computer, and hands it to the page", async () => {
  const code = (await build({ entryPoints: [new URL("../src/pipHomeDismiss.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm", external: ["vscode"] })).outputFiles[0].text;
  const store = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const value = {}, context = { globalState: { value, get: (k) => value[k], update: async (k, v) => { if (v === undefined) delete value[k]; else value[k] = v; } } };
  assert.equal(typeof store.rememberHomeShow, "function", "the host has a keeper for Home's Show filter");
  assert.equal(store.homeShowAttr(context), "", "nothing kept: Home shows all");
  assert.equal(store.rememberHomeShow(context, { type: "homeShow", show: "personal" }), true);
  await Promise.resolve();
  assert.equal(store.homeShowAttr(context), ' data-home-show="personal"', "kept, and stamped on the page");
  assert.equal(store.rememberHomeShow(context, { type: "pipHomeDismissed", set: {}, drop: [] }), false, "not its message");
  store.rememberHomeShow(context, { type: "homeShow", show: '"><script>' }); await Promise.resolve();
  assert.equal(store.homeShowAttr(context), "", "only its five words are kept");
  store.rememberHomeShow(context, { type: "homeShow", show: "chat" }); await Promise.resolve();
  store.rememberHomeShow(context, { type: "homeShow", show: "all" }); await Promise.resolve();
  assert.deepEqual(value, {}, "All is the default: nothing is kept for it");
});

// (Home's Show filter went on 13 Nov, when Home became cards: the cards you add are the filter. Its test went with it; test/home-cards.test.mjs holds that Show is gone.)

test("an empty Home says so in one line", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 700]) {
    const x = await openDock(browser, { tab: "home", state: homeState("quiet"), sessions: SESSIONS.map((s) => ({ ...s, open: false })), width, height: 600 });
    try {
      const bar = await x.tabs(), hub = await x.hub();
      assert.deepEqual(chosen(bar), ["home"], `${width}px: on Home`);
      assert.deepEqual([hub.cards.length, hub.groups.length], [0, 0], "no card and no group");
      assert.equal(hub.empty, "Nothing needs you.");
      const line = await x.page.evaluate(() => { const p = document.querySelector("#home-hub .dgc-hub-empty"), s = getComputedStyle(p); return { height: p.getBoundingClientRect().height, lineHeight: parseFloat(s.lineHeight) }; });
      assert.ok(line.height <= line.lineHeight * 1.2, `one line, in a narrow side bar too (${line.height} of ${line.lineHeight})`);
      assert.equal(tab(bar, "home").count, "", "Home has no number");
      assert.equal(tab(bar, "home").label, "Home");
      assert.equal(hub.show, null, "and no Show filter: the cards on Home are the filter");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

// ---- Work, Chat, Pips, and the dock under each ------------------------------------------------------------------------
test("Work lists this project's sessions with their marks, a running one with the accent's dot, under its own search and New", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "work", width: 300, height: 700, sessions: [...DOCK_SESSIONS, WINDOWLESS] });
  try {
    assert.deepEqual(chosen(await x.tabs()), ["work"], "on the Work tab");
    const accent = await tone(x.page, "--accent-text");
    const rows = await x.page.evaluate(() => [...document.querySelectorAll("#sessions-list .session-row")].map((r) => { const blob = r.querySelector(".session-blob [data-mark]"), live = r.querySelector(".session-live");
      return { id: r.dataset.id, name: r.querySelector(".session-name").textContent, sub: r.querySelector(".session-sub")?.textContent || "", blob: blob ? { set: blob.dataset.mark, palette: blob.dataset.palette, running: blob.hasAttribute("data-moving"), size: blob.getBoundingClientRect().width } : null,
        live: live ? { color: getComputedStyle(live).backgroundColor, size: live.getBoundingClientRect().width, words: live.textContent } : null, age: r.querySelector(".session-age").checkVisibility() ? r.querySelector(".session-age").textContent : "",
        blobLeft: blob?.getBoundingClientRect().left, nameLeft: r.querySelector(".session-name").getBoundingClientRect().left, height: r.getBoundingClientRect().height }; }));
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.blob?.set === "voxel" && r.blob.size >= 18), "every session has its Voxel");
    assert.ok(rows.every((r) => r.blobLeft < r.nameLeft), "the mark is before the name");
    assert.equal(new Set(rows.map((r) => r.height)).size, 1, "every row is one height");
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    const running = by[DOCK_SESSIONS[0].id], open = by[DOCK_SESSIONS[1].id], waits = by[DOCK_SESSIONS[2].id], rest = by[DOCK_SESSIONS[3].id], noWindow = by[WINDOWLESS.id];
    assert.deepEqual([running.live?.color, running.live?.words, running.age, running.blob.running], [accent, "Running", "", true], "the running one has the accent's dot where its age was, and its mark moves");
    assert.match(running.sub, /^Running · 5 messages$/);
    assert.deepEqual([noWindow.live?.words, noWindow.sub], ["Running, no window", "Running, no window · 9 messages"]);
    for (const r of [open, waits, rest]) assert.equal(r.live, null, `${r.name}: not running, no dot`);
    assert.equal(open.sub, "Open in a tab · 12 messages"); assert.equal(waits.sub, "Wants your okay"); assert.equal(rest.sub, "31 messages");
    assert.ok(open.age && rest.age, "a resting session says its age");
    // What needs you is listed first.
    assert.deepEqual(rows.slice(0, 2).map((r) => r.id).sort(), [DOCK_SESSIONS[2].id, WINDOWLESS.id].sort());
    // A session's mark is the colour chosen for it, here as on the dock.
    await x.setting({ colours: { ...(await x.page.evaluate(() => window.__dock.colours)), [`work:${DOCK_SESSIONS[3].id}`]: "rose" } }); await x.settle();
    assert.equal(await x.page.evaluate((id) => document.querySelector(`#sessions-list .session-row[data-id="${id}"] [data-mark]`).dataset.palette, DOCK_SESSIONS[3].id), "rose");
    // Its own search, and New.
    const bar = await x.page.evaluate(() => { const s = document.getElementById("sessions-search"), n = document.getElementById("sessions-new"), a = s.getBoundingClientRect(), b = n.getBoundingClientRect();
      return { search: s.checkVisibility(), placeholder: s.placeholder, fresh: n.checkVisibility(), word: n.textContent.trim(), sameRow: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 1, searchFirst: a.right <= b.left, top: a.top, list: document.getElementById("sessions-list").getBoundingClientRect().top }; });
    assert.deepEqual([bar.search, bar.placeholder, bar.fresh, bar.word, bar.sameRow, bar.searchFirst], [true, "Search Work sessions", true, "New", true, true]);
    assert.ok(bar.top < bar.list, "over the list");
    await x.page.click("#sessions-new");
    assert.equal((await x.posted("newSessionInEditor")).length, 1, "New starts a session");
    await x.page.fill("#sessions-search", "invoice"); await settle(x.page, 350);
    assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll("#sessions-list .session-row .session-name")].map((n) => n.textContent)), ["Invoice totals round the wrong way"], "the search narrows the list");
    assert.deepEqual(await x.posted("chatdgcSearch"), [], "Work's search does not search your chats");
    // A DGC that searches itself is asked.
    await x.page.fill("#sessions-search", "");
    await x.send({ type: "sessions_list", items: DOCK_SESSIONS, searchable: true, error: "" });
    await x.page.fill("#sessions-search", "login"); await settle(x.page, 400);
    assert.deepEqual((await x.posted("sessionsSearch")).map((m) => m.query), ["login"]);
    // A click on a row opens it.
    await x.page.click(`#sessions-list .session-row[data-id="${DOCK_SESSIONS[1].id}"] .session-name`);
    assert.deepEqual((await x.posted("openSessionInEditor")).map((m) => m.id), [DOCK_SESSIONS[1].id]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Chat lists your chats the same way: their Motes, the dot while one answers, its own search and New, projects and the Library", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "chat", width: 300, height: 760, answering: ["chat_2"] });
  try {
    assert.deepEqual(chosen(await x.tabs()), ["chat"], "on the Chat tab");
    const accent = await tone(x.page, "--accent-text");
    const rows = await x.page.evaluate(() => [...document.querySelectorAll("#chats-list > .chat-row")].map((r) => { const blob = r.querySelector(".session-blob [data-mark]"), live = r.querySelector(".session-live");
      return { id: r.dataset.id, name: r.querySelector(".session-name").textContent, sub: [...(r.querySelector(".session-sub")?.children || [])].map((s) => s.textContent), shape: blob?.dataset.mark || "", running: !!blob?.hasAttribute("data-moving"),
        live: live ? getComputedStyle(live).backgroundColor : "", age: r.querySelector(".session-age").checkVisibility() ? r.querySelector(".session-age").textContent : "", height: r.getBoundingClientRect().height }; }));
    assert.deepEqual(rows.map((r) => [r.id, r.name, r.shape]), [["chat_1", "A week in Goa in March", "mote"], ["chat_2", "Rent or buy: the numbers", "mote"]], "each chat has its Mote");
    assert.deepEqual(rows[0].sub, ["Pinned", "Open in a tab", "Three beaches, two day trips and where to eat."], "Pinned, where it is open, and its last words");
    assert.deepEqual([rows[1].live, rows[1].running, rows[1].age, rows[1].sub[0]], [accent, true, "", "Answering"], "the chat that is answering has the accent's dot");
    assert.deepEqual([rows[0].live, !!rows[0].age], ["", true], "one at rest says its age");
    assert.equal(rows[0].height, rows[1].height);
    const work = await x.page.evaluate(() => document.getElementById("sessions-list").checkVisibility());
    assert.equal(work, false, "this project's sessions are on their own tab");
    const bar = await x.page.evaluate(() => ({ search: document.getElementById("chats-search").checkVisibility(), placeholder: document.getElementById("chats-search").placeholder, word: document.getElementById("chats-new").textContent.trim(),
      library: !!document.getElementById("chats-library"), projects: [...document.querySelectorAll("#projects-list .project-name")].map((n) => n.textContent), nested: [...document.querySelectorAll("#projects-list .chat-row-nested .session-name")].map((n) => n.textContent) }));
    assert.deepEqual(bar, { search: true, placeholder: "Search chats", word: "New", library: false, projects: ["Goa trip", "House hunt"], nested: ["Packing list", "Flights and the ferry"] });
    await x.page.click("#chats-new");
    assert.equal((await x.posted("chatdgcNew")).length, 1, "New starts a chat");
    await x.page.fill("#chats-search", "goa"); await settle(x.page, 400);
    assert.deepEqual((await x.posted("chatdgcSearch")).map((m) => m.query), ["goa"], "its search looks through your chats");
    assert.deepEqual(await x.posted("sessionsSearch"), [], "and not this project's sessions");
    await x.page.click('#chats-list .chat-row[data-id="chat_1"] .session-name');
    assert.deepEqual((await x.posted("chatdgcOpen")).map((m) => m.id), ["chat_1"]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

for (const width of [300, 700]) {
  test(`${width}px: Pips is the Pips page with its Personal and Project tabs, and the dock sits under every tab`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 700 });
    try {
      assert.equal(names(await x.tabs()).length, 5, "five tabs");
      const under = async (id, panel) => {
        await x.page.click(`#side-tab-${id}`);
        if (id === "pips") await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot?.querySelector("[data-job]"));
        await x.settle();
        const bar = await x.tabs(), d = await dockNow(x.page);
        assert.deepEqual([chosen(bar), bar.panel], [[id], panel], `${id}: its page shows`);
        assert.equal(d.shown, true, `${id}: the dock is there`);
        assert.ok(Math.abs(d.host.bottom - d.height) < 0.6, `${id}: at the foot of the side bar`);
        assert.ok(Math.abs((d.bar.left + d.bar.right) / 2 - d.width / 2) < 0.6, `${id}: centred`);
        assert.ok(d.items.length >= 2, `${id}: with what is pinned`);
        // (The page itself runs under both bars, which are glass: dock-glass.test.mjs. Its room for its own things is between them.)
        const page = { top: d.page.roomTop, bottom: d.page.roomBottom };
        assert.ok(bar.bar.bottom <= page.top + 0.6, `${id}: the page's room starts under the tab bar (${bar.bar.bottom} > ${page.top})`);
        assert.ok(page.bottom <= d.host.top + 0.6, `${id}: and it ends where the dock begins (${page.bottom} > ${d.host.top})`);
        assert.equal(bar.overflowX, false);
      };
      await under("home", "home-hub");
      await under("work", "work-home");
      await under("chat", "chats-home");
      await under("pips", "pips-host");
      // The Pips page as it is: its own two tabs, its search and New Pip, its Pips.
      const pips = await x.page.evaluate(() => { const root = document.getElementById("pips-host").shadowRoot;
        return { scopes: [...root.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim().replace(/\s*\d+$/, "")), rows: root.querySelectorAll("[data-job]").length, search: !!root.querySelector('input[type="search"], input[placeholder*="Search"]'),
          fresh: [...root.querySelectorAll("button")].some((b) => /New Pip/.test(b.textContent)) }; });
      assert.deepEqual(pips.scopes.slice(0, 2), ["Personal", "Project"], "its Personal and Project tabs");
      assert.ok(pips.rows >= 1 && pips.search && pips.fresh, "its Pips, its search and New Pip");
      // A Pip's chat has the side bar to itself (asked 11 Nov; dock-pip-chat.test.mjs): no tab bar and no dock there.
      await x.page.locator("#pips-host [data-job]").first().click();
      await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot?.querySelector("#chat-form"));
      await x.settle();
      assert.deepEqual([(await x.tabs()).shown, (await dockNow(x.page)).shown], [false, false]);
      // Its own back arrow leads back to the list of Pips, with both and with Pips still the tab that is lit; another tab, to its page.
      await x.page.locator("#pips-host #simple-back").click();
      await x.page.waitForFunction(() => !document.getElementById("pips-host").shadowRoot?.querySelector("#chat-form"));
      await x.settle();
      const bar = await x.tabs(), d = await dockNow(x.page);
      assert.deepEqual([bar.shown, chosen(bar), d.shown], [true, ["pips"], true]);
      await x.page.click("#side-tab-home"); await x.settle();
      assert.equal((await x.tabs()).panel, "home-hub");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- what the files hold ---------------------------------------------------------------------------------------------
test("the tabs and the hub take every colour from the tokens, and say nothing they should not", () => {
  const files = ["media/shared/tabs.css", "media/shared/hub.css", "media/shared/hub.js"];
  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b(?![^{]*\{)/i, `${file}: no colour of its own`);
    assert.doesNotMatch(text, /\bAI\b|founder|\/home\/|192\.168\./, `${file}: plain words only`);
  }
  assert.match(read("media/main.css"), /@import url\("\.\/shared\/tabs\.css"\);\s*@import url\("\.\/shared\/hub\.css"\);/, "the side bar's page loads both");
  assert.match(read("src/panel.ts"), /"shared", "hub\.js"/, "and the hub's script");
  // The glow is the accent's, from the tokens: one colour for all four tabs.
  assert.match(read("media/shared/tokens.css"), /--tabs-glow:\s*color-mix\(in srgb, var\(--accent\)/);
  assert.equal((read("media/shared/tabs.css").match(/var\(--accent-text\)/g) || []).length, 1, "one rule lights a tab, whichever it is");
});
