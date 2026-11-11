// The dock at the foot of DGC's side bar (media/shared/dock.js and dock.css) and a session's liquid blob
// (media/shared/blob.js and blob.css), measured in real Chromium on the side bar's real page (support/dock-scene.mjs,
// which answers the dock's messages the way src/dock.ts does). What is held here:
//   - the dock is on every screen of the side bar (its Work tab here, the Pips view; side-tabs-home.test.mjs has it under
//     each of the four tabs) and nothing hides behind it. A Pip's chat alone has none (dock-pip-chat.test.mjs)
//   - a pin on every session and chat row, and on every Pip's row in the Pips view, pins and unpins; the dock's own menu
//     unpins and moves
//   - "+" is always last and offers a new Work session, ChatDGC chat, Personal Pip, and Settings
//   - pointed at, the tiles grow toward the pointer and the one under it is named, with what it is doing
//   - tiles shrink as items are added, down to 24 px; when 24 px tiles cannot fit, the dock steps aside and keeps its pins
//   - Settings' three choices: Always, When I point at the bottom, Never
//   - the keyboard: Tab into the dock, arrows between items, Enter opens, the menu by Shift+F10
//   - a blob is round for Work and a rounded square for ChatDGC, always full, glows only while its session runs, pauses
//     off screen and under reduced motion, and its colour can be changed among seven from a row, the dock and its header
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDock, dockNow, dockContrast, manyPins, PINS, LIBRARY_PINS, DOCK_SESSIONS, pipId } from "./support/dock-scene.mjs";
import { CHATS } from "./support/home-scene.mjs";
import { openWorkTab } from "./support/work-tab-scene.mjs";
import { openChat, openLibrary, conversation, M } from "./support/chat-scene.mjs";

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
const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
const WORK_A = `work:${DOCK_SESSIONS[0].id}`, WORK_B = `work:${DOCK_SESSIONS[1].id}`, CHAT_A = `chat:${CHATS[0].id}`, PIP_B = `pip:${pipId("b")}`;
const keys = (d) => d.items.map((i) => i.key);
/** Point at a dock item and wait for the tiles to come to rest. */
async function pointAt(x, key) {
  const d = await dockNow(x.page), item = d.items.find((i) => i.key === key);
  await x.page.mouse.move(...centre(item), { steps: 4 });
  // Until the tiles are at rest: the same sizes two looks running.
  let last = "";
  for (let i = 0; i < 40; i++) {
    await x.page.waitForTimeout(120);
    const now = await x.page.evaluate(() => [...document.querySelectorAll("#dgc-dock .dgc-dock-item")].map((b) => b.getBoundingClientRect().width.toFixed(2)).join());
    if (now === last && i >= 2) break;
    last = now;
  }
  return dockNow(x.page);
}
const posted = (x, type) => x.posted(type);

// ---- where it is ---------------------------------------------------------------------------------------------------
for (const width of [300, 700]) {
  test(`${width}px: the dock is at the foot of the home and the Pips view, nothing hides behind it, and a Pip's chat has the foot to itself`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { width, height: 700 });
    try {
      const under = async (said) => {
        const d = await dockNow(x.page);
        assert.equal(d.shown, true, `${said}: the dock is there`);
        assert.equal(d.state, "shown");
        assert.ok(Math.abs(d.host.bottom - d.height) < 0.6, `${said}: it is at the foot of the side bar (${d.host.bottom} of ${d.height})`);
        assert.ok(Math.abs((d.bar.left + d.bar.right) / 2 - d.width / 2) < 0.6, `${said}: the bar is centred`);
        assert.ok(d.bar.left >= 7.5 && d.bar.right <= d.width - 7.5, `${said}: the bar keeps 8 px from each edge`);
        assert.ok(d.page, `${said}: a screen is showing above it`);
        assert.ok(d.page.bottom <= d.host.top + 0.6, `${said}: the screen ends where the dock begins (${d.page.bottom} > ${d.host.top})`);
        assert.equal(d.overflowX, false, `${said}: nothing scrolls sideways`);
        assert.deepEqual(keys(d), [...PINS.map((p) => p.key), "+"], `${said}: the same six, then "+"`);
        return d;
      };
      const home = await under("the home");
      assert.equal(home.page.id, "sessions-host");
      // The home scrolls inside its own room: its last thing can be scrolled wholly above the dock.
      const last = await x.page.evaluate(() => { const host = document.getElementById("sessions-host"); host.scrollTop = host.scrollHeight;
        const all = [...host.querySelectorAll(".session-row, .sessions-all")].filter((n) => n.checkVisibility()); return all.at(-1).getBoundingClientRect().bottom; });
      assert.ok(last <= home.host.top + 0.6, `the home's last row is above the dock (${last} > ${home.host.top})`);

      await x.page.click("#side-tab-pips");
      await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot?.querySelector("[data-job]"));
      const pips = await under("the Pips view");
      assert.equal(pips.page.id, "pips-host");

      await x.page.locator("#pips-host [data-job]").first().click();
      await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot?.querySelector("#chat-form"));
      // A Pip's chat has no dock (asked 11 Nov; dock-pip-chat.test.mjs holds the rest): its prompt box is at the foot.
      await x.settle();
      const chat = await dockNow(x.page);
      assert.equal(chat.shown, false, "a Pip's chat: no dock");
      const box = await x.page.evaluate(() => { const form = document.getElementById("pips-host").shadowRoot.querySelector("#chat-form"), r = form.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.bottom - 6);
        return { bottom: r.bottom, top: r.top, covered: at?.id !== "pips-host" }; });
      assert.ok(box.bottom <= chat.height && box.bottom > pips.host.top, `the prompt box is at the foot, in the room the dock had (${box.bottom} of ${chat.height}, the dock began at ${pips.host.top})`);
      assert.equal(box.covered, false, "and nothing covers it");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- pin and unpin -------------------------------------------------------------------------------------------------
test("a pin on every session and chat row: it pins, stays filled while pinned, and a click unpins", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { pins: [], width: 300, height: 760 });
  try {
    let d = await dockNow(x.page);
    assert.deepEqual(keys(d), ["+"], 'nothing pinned: only "+"');
    const pinOf = (row) => x.page.evaluate((sel) => { const b = document.querySelector(sel).querySelector(".dgc-pin"); const s = getComputedStyle(b);
      return { pressed: b.getAttribute("aria-pressed"), label: b.getAttribute("aria-label"), fill: b.querySelector("svg").getAttribute("fill"), shown: b.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && Number(s.opacity) > 0.9 }; }, row);

    // A session's row: the pin is with Open in Editor and Delete, seen when the row is pointed at.
    const session = `#sessions-list .session-row[data-id="${DOCK_SESSIONS[1].id}"]`;
    await x.page.hover(session);
    const order = await x.page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll(".session-actions > button")].map((b) => b.className.split(" ")[0]), session);
    assert.deepEqual(order, ["session-open", "dgc-pin", "session-more", "session-delete"], "Open in Editor, the pin, …, Delete");
    let pin = await pinOf(session);
    assert.deepEqual([pin.pressed, pin.fill, pin.shown], ["false", "none", true], "an outline until it is pinned");
    assert.match(pin.label, /^Pin to the dock: /);
    await x.page.click(`${session} .dgc-pin`); await x.settle();
    d = await dockNow(x.page);
    assert.deepEqual(keys(d), [WORK_B, "+"], "the session is on the dock");
    assert.equal(d.items[0].holds, "blob"); assert.equal(d.items[0].blob.shape, "round", "a Work session is a round blob");
    pin = await pinOf(session);
    assert.deepEqual([pin.pressed, pin.fill], ["true", "currentColor"], "filled while it is pinned");
    assert.match(pin.label, /^Unpin from the dock: /);

    // A chat's row (the Chat tab).
    await x.page.click("#side-tab-chat");
    const chat = `#chats-list .chat-row[data-id="${CHATS[1].id}"]`;
    await x.page.hover(chat);
    assert.equal((await pinOf(chat)).shown, true, "a chat's pin shows when its row is pointed at");
    await x.page.click(`${chat} .dgc-pin`); await x.settle();
    d = await dockNow(x.page);
    assert.equal(d.items[1].key, `chat:${CHATS[1].id}`);
    assert.equal(d.items[1].blob.shape, "square", "a ChatDGC chat is a rounded square");
    await x.page.mouse.move(150, 20);
    assert.equal((await pinOf(chat)).shown, true, "a pinned chat's pin stays, filled, with the pointer away");

    assert.equal(d.items.at(-1).key, "+", '"+" stays last');
    // (A Pip is pinned from its row in the Pips view, the next test: Home's cards answer what a Pip asks and have no pin.)

    // The same pins unpin.
    await x.page.click(`${chat} .dgc-pin`); await x.settle();
    d = await dockNow(x.page);
    assert.deepEqual(keys(d), [WORK_B, "+"], "a click on a filled pin unpins");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the Pips view: each Pip's row has the same pin", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { pins: [], width: 300, height: 700 });
  try {
    await x.page.click("#side-tab-pips");
    const row = x.page.locator("#pips-host [data-job]").first();
    await row.waitFor();
    const id = await row.getAttribute("data-job");
    const pin = x.page.locator(`#pips-host [data-pin-pip="${id}"]`);
    assert.equal(await pin.getAttribute("aria-pressed"), "false");
    assert.equal(await pin.evaluate((b) => !b.closest("[data-job]")), true, "beside its row, not inside it (a row is a button)");
    await row.hover();
    await x.page.waitForFunction((b) => Number(getComputedStyle(b).opacity) > 0.9, await pin.elementHandle());
    await pin.click(); await x.settle();
    const d = await dockNow(x.page);
    assert.deepEqual(keys(d), [`pip:${id}`, "+"]);
    assert.equal(await x.page.locator(`#pips-host [data-pin-pip="${id}"]`).getAttribute("aria-pressed"), "true", "filled once pinned");
    await x.page.locator(`#pips-host [data-pin-pip="${id}"]`).click(); await x.settle();
    assert.deepEqual(keys(await dockNow(x.page)), ["+"]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the Library: a file, an artifact and a widget each have a pin beside their actions", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibrary(browser, { width: 900 });
  try {
    await x.send({ type: "artifactsOffered", on: true });
    await x.send({ type: "library", files: [{ id: "att_" + "a".repeat(32), name: "Budget.xlsx", type: "spreadsheet", size: 2048, source: "chat", chat_id: "chat_" + "b".repeat(32), chat_title: "Goa", created_at: "2026-11-06T09:00:00Z" }], total: 1 });
    const pin = x.page.locator("#lib-list .lib-row .lib-pin").first();
    await pin.waitFor();
    assert.equal(await pin.getAttribute("aria-pressed"), "false");
    assert.match(await pin.getAttribute("aria-label"), /^Pin to the dock: Budget\.xlsx/);
    assert.equal(await pin.evaluate((b) => b.nextElementSibling?.getAttribute("aria-label")), "Delete from your Library", "beside Delete");
    await pin.click();
    const [sent] = await x.posted("dockToggle");
    assert.deepEqual([sent.item.kind, sent.item.id, sent.item.title, sent.item.look.type, sent.item.ref.chat_id], ["file", "att_" + "a".repeat(32), "Budget.xlsx", "spreadsheet", "chat_" + "b".repeat(32)]);
    await x.send({ type: "dock", pins: [{ key: `file:${"att_" + "a".repeat(32)}` }], colours: {}, show: "always", most: 8, size: 34 });
    assert.equal(await pin.getAttribute("aria-pressed"), "true", "the host says it is pinned: the pin is filled");
    assert.equal(await pin.evaluate((b) => b.querySelector("svg").getAttribute("fill")), "currentColor");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("what a pinned thing looks like: a Pip's face, a session's blob, a file's small sheet, a widget's cube", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { pins: [PINS[0], PINS[3], PINS[5], ...LIBRARY_PINS], most: 16, width: 360 });
  try {
    const d = await dockNow(x.page);
    assert.deepEqual(d.items.map((i) => i.holds), ["face", "blob", "blob", "sheet", "sheet", "sheet", "cube", "plus"]);
    const sheet = await x.page.evaluate(() => [...document.querySelectorAll("#dgc-dock .dgc-sheet")].map((s) => { const r = s.getBoundingClientRect(), tile = s.closest(".dgc-dock-item").getBoundingClientRect();
      return { kind: s.dataset.kind, h: r.height, tile: tile.height, inside: r.top >= tile.top - 0.5 && r.bottom <= tile.bottom + 0.5 }; }));
    assert.deepEqual(sheet.map((s) => s.kind), ["page", "sheet", "pdf"], "the output cards' sheet, by kind");
    for (const s of sheet) {
      assert.ok(s.h < 56 * 0.6, `the sheet is smaller in a tile (${s.h}px of 56)`);
      assert.ok(s.h >= s.tile * 0.55 && s.h <= s.tile * 0.8 && s.inside, `about a blob's size, inside its tile (${s.h} in ${s.tile})`);
    }
    const blob = await x.page.evaluate(() => { const b = document.querySelector('#dgc-dock [data-kind="work"] .dgc-blob').getBoundingClientRect(), tile = document.querySelector('#dgc-dock [data-kind="work"]').getBoundingClientRect(); return b.height / tile.height; });
    assert.ok(blob > 0.6 && blob < 0.72, `a blob is about two thirds of its tile (${blob})`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- the dock's own menu, and "+" ------------------------------------------------------------------------------------
test("right-click on a dock item: Open, Unpin, Move left, Move right, and a session's seven colours", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    const open = async (key) => { const d = await dockNow(x.page); await x.page.mouse.click(...centre(d.items.find((i) => i.key === key)), { button: "right" }); await x.settle(); return dockNow(x.page); };
    let d = await open(PIP_B);
    assert.deepEqual(d.menu, ["Open", "Unpin", "Move left (off)", "Move right"], "the first item cannot move left");
    assert.deepEqual(d.swatches, [], "a Pip has no colours to pick");
    const menu = await x.page.evaluate(() => { const r = document.querySelector(".dgc-pop").getBoundingClientRect(), dock = document.querySelector("#dgc-dock .dgc-dock-bar").getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, top: r.top, dockTop: dock.top }; });
    assert.ok(menu.left >= 5.5 && menu.right <= 300 - 5.5 && menu.top >= 5.5, "the menu stays inside the side bar");
    assert.ok(menu.bottom <= menu.dockTop + 0.5, "and opens above the dock");
    await x.page.keyboard.press("Escape");
    assert.deepEqual((await dockNow(x.page)).menu, [], "Escape closes it");

    d = await open(WORK_B);
    assert.deepEqual(d.menu, ["Open", "Unpin", "Move left", "Move right", "Back to its own colour (off)"]);
    assert.equal(d.swatches.length, 7, "seven colours");
    assert.deepEqual(d.swatches.map((s) => s.shape), Array(7).fill("round"), "round, as a Work session's blob is");
    const own = d.items.find((i) => i.key === WORK_B).blob.pair;
    assert.deepEqual(d.swatches.filter((s) => s.on).map((s) => s.pair), [own], "its own colour is the one marked");
    assert.ok(own >= 2 && own <= 7, "a colour from an id is never the pair led by purple");
    // Move right, then left again.
    await x.page.click('.dgc-pop [data-id="right"]'); await x.settle();
    assert.deepEqual(keys(await dockNow(x.page)).slice(3, 6), [WORK_A, CHAT_A, WORK_B]);
    d = await open(WORK_B);
    assert.deepEqual(d.menu.slice(2, 4), ["Move left", "Move right (off)"], "the last item cannot move right");
    await x.page.click('.dgc-pop [data-id="left"]'); await x.settle();
    assert.deepEqual(keys(await dockNow(x.page)), [...PINS.map((p) => p.key), "+"]);
    // A colour: the blob takes it at once, and "Back to its own colour" returns.
    await open(WORK_B);
    const other = own === 6 ? 4 : 6;
    await x.page.click(`.dgc-pop .dgc-swatch[data-colour="${other}"]`); await x.settle();
    assert.equal((await dockNow(x.page)).items.find((i) => i.key === WORK_B).blob.pair, other);
    assert.deepEqual((await posted(x, "dockColour")).at(-1), { type: "dockColour", key: WORK_B, colour: other });
    d = await open(WORK_B);
    assert.deepEqual(d.swatches.filter((s) => s.on).map((s) => s.pair), [other]);
    assert.equal(d.menu.at(-1), "Back to its own colour");
    await x.page.click('.dgc-pop [data-colour="own"]'); await x.settle();
    assert.equal((await dockNow(x.page)).items.find((i) => i.key === WORK_B).blob.pair, own);
    assert.equal((await posted(x, "dockColour")).at(-1).colour, null);
    // A chat's colours are rounded squares.
    d = await open(CHAT_A);
    assert.deepEqual(d.swatches.map((s) => s.shape), Array(7).fill("square"));
    await x.page.keyboard.press("Escape");
    // Unpin.
    await open(PIP_B);
    await x.page.click('.dgc-pop [data-id="unpin"]'); await x.settle();
    assert.deepEqual(keys(await dockNow(x.page)), [...PINS.slice(1).map((p) => p.key), "+"]);
    // Open.
    await open(WORK_A);
    await x.page.click('.dgc-pop [data-id="open"]');
    assert.deepEqual((await posted(x, "dockOpen")).at(-1), { type: "dockOpen", key: WORK_A });
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test('"+" is always the last item and offers a new Work session, ChatDGC chat, Personal Pip, and Settings', async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    for (const pins of [[], PINS.slice(0, 1), PINS, manyPins(8)]) {
      await x.setting({ pins }); await x.settle();
      assert.equal(keys(await dockNow(x.page)).at(-1), "+", `${pins.length} pinned: "+" is last`);
    }
    await x.setting({ pins: PINS }); await x.settle();
    const plus = async () => { const d = await dockNow(x.page); await x.page.mouse.click(...centre(d.items.at(-1))); await x.settle(); return dockNow(x.page); };
    let d = await plus();
    assert.deepEqual(d.menu, ["New Work session", "New ChatDGC chat", "New Personal Pip", "Settings"]);
    assert.equal(await x.page.evaluate(() => document.querySelector("#dgc-dock .dgc-dock-add").getAttribute("aria-expanded")), "true");
    await x.page.click('.dgc-pop [data-id="work"]');
    assert.deepEqual((await posted(x, "dockNew")).at(-1), { type: "dockNew", what: "work" }, "a new Work session, at once");
    assert.deepEqual((await dockNow(x.page)).menu, [], "the menu closes");
    await plus(); await x.page.click('.dgc-pop [data-id="chat"]');
    assert.deepEqual((await posted(x, "dockNew")).at(-1), { type: "dockNew", what: "chat" });
    await plus(); await x.page.click('.dgc-pop [data-id="settings"]');
    assert.deepEqual((await posted(x, "dockNew")).at(-1), { type: "dockNew", what: "settings" });
    // A new Personal Pip: the Pips view opens on Your Pips with New Pip asking for a name.
    await plus(); await x.page.click('.dgc-pop [data-id="pip"]');
    await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot?.querySelector("#newPipName"));
    assert.equal(await x.page.evaluate(() => document.body.classList.contains("pips-active")), true);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- magnify and names -----------------------------------------------------------------------------------------------
for (const width of [300, 700]) {
  test(`${width}px: pointed at, the tiles grow toward the pointer and the one under it is named, with what it is doing`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { width, height: 700 });
    try {
      const rest = await dockNow(x.page), base = rest.items[0].width;
      assert.ok(rest.items.every((i) => Math.abs(i.width - base) < 0.1 && Math.abs(i.height - base) < 0.1), "at rest every tile is one size, and square");
      assert.equal(rest.tip, null, "and nothing is named");
      const d = await pointAt(x, WORK_A), at = d.items.findIndex((i) => i.key === WORK_A);
      const size = d.items.map((i) => i.width);
      assert.ok(size[at] >= base * 1.25, `the tile under the pointer grows (${base} to ${size[at]})`);
      assert.equal(Math.max(...size), size[at], "it is the largest");
      assert.ok(size[at - 1] < size[at] && size[at + 1] < size[at] && size[at - 1] > size[at - 3] && size[at + 1] >= size.at(-1), "its neighbours grow less, the far ones least");
      assert.ok(d.items.every((i) => Math.abs(i.width - i.height) < 0.1), "every tile stays square");
      assert.ok(d.items.every((i) => Math.abs(i.bottom - d.items[0].bottom) < 0.6), "they stand on one line: they grow upward");
      assert.ok(d.items[at].top < rest.bar.top + 5, "the grown tile rises toward the bar's top edge and past it");
      assert.ok(Math.abs(d.bar.height - rest.bar.height) < 0.1 && Math.abs(d.bar.bottom - rest.bar.bottom) < 0.1, "the bar keeps its height and its place");
      assert.ok(d.bar.left >= 5.5 && d.bar.right <= width - 5.5, `the grown bar stays inside the side bar (${d.bar.left} to ${d.bar.right})`);
      assert.ok(Math.abs(d.page.bottom - rest.page.bottom) < 0.1, "the page above does not move");
      for (let i = 1; i < d.items.length; i++) assert.ok(d.items[i].left >= d.items[i - 1].right - 0.5, "no tile overlaps the next");
      // Its name: the session's full title and what it is doing.
      assert.deepEqual([d.tip.title, d.tip.state], [DOCK_SESSIONS[0].name, "Running"]);
      assert.ok(d.tip.bottom <= d.items[at].top - 4, "the name is just above its tile");
      assert.ok(d.tip.left >= 5.5 && d.tip.right <= width - 5.5, "and inside the side bar");
      assert.ok(Math.abs((d.tip.left + d.tip.right) / 2 - (d.items[at].left + d.items[at].right) / 2) < Math.max(1, d.tip.width / 2), "over its tile");
      // A Pip: its name and what it waits on. A chat, an open session.
      let n = await pointAt(x, PIP_B);
      assert.deepEqual([n.tip.title, n.tip.state], ["Mail watch", "2 waiting for you"]);
      n = await pointAt(x, WORK_B);
      assert.deepEqual([n.tip.title, n.tip.state], [DOCK_SESSIONS[1].name, "Open in a tab"]);
      n = await pointAt(x, CHAT_A);
      assert.equal(n.tip.title, CHATS[0].title); assert.equal(n.tip.state, "Open in a tab");
      n = await pointAt(x, "+");
      assert.equal(n.tip.title, "New");
      // The pointer leaves: every tile back to rest, nothing named.
      await x.page.mouse.move(width / 2, 200, { steps: 3 });
      await x.page.waitForFunction((size) => [...document.querySelectorAll("#dgc-dock .dgc-dock-item")].every((b) => Math.abs(b.getBoundingClientRect().width - size) < 0.1), base);
      const back = await dockNow(x.page);
      assert.ok(back.items.every((i) => Math.abs(i.width - base) < 0.1), "the pointer leaves: every tile is back to its size");
      assert.equal(back.tip, null);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a click opens what is pinned, and a press nudges its tile up", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700, pins: [...PINS, LIBRARY_PINS[0]] });
  try {
    const click = async (key) => { const d = await dockNow(x.page); await x.page.mouse.click(...centre(d.items.find((i) => i.key === key))); };
    await click(WORK_A);
    assert.deepEqual((await posted(x, "dockOpen")).at(-1), { type: "dockOpen", key: WORK_A });
    await click(LIBRARY_PINS[0].key);
    assert.deepEqual((await posted(x, "dockOpen")).at(-1), { type: "dockOpen", key: LIBRARY_PINS[0].key });
    const d = await dockNow(x.page), item = d.items.find((i) => i.key === CHAT_A);
    await x.page.mouse.move(...centre(item)); await x.page.waitForTimeout(400);
    const before = (await dockNow(x.page)).items.find((i) => i.key === CHAT_A).top;
    await x.page.mouse.down(); await x.page.waitForTimeout(250);
    const pressed = (await dockNow(x.page)).items.find((i) => i.key === CHAT_A).top;
    await x.page.mouse.up();
    assert.ok(pressed <= before - 1.5, `pressed, the tile is nudged up (${before} to ${pressed})`);
    // A Pip opens in the Pips view on this page.
    await click(PIP_B);
    await x.page.waitForFunction(() => document.body.classList.contains("pips-active"));
    assert.equal((await dockNow(x.page)).shown, true, "and the dock is still there");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("reduced motion: nothing grows, and the name still shows", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700, motion: "reduce" });
  try {
    const base = (await dockNow(x.page)).items[0].width;
    const d = await pointAt(x, WORK_A);
    assert.ok(d.items.every((i) => Math.abs(i.width - base) < 0.1), "no tile changes size");
    assert.equal(d.tip.title, DOCK_SESSIONS[0].name);
  } finally { await x.close(); }
});

// ---- sizes ---------------------------------------------------------------------------------------------------------
test("tiles shrink as items are added, down to 24 px; then the dock steps aside until the side bar is wider, and nothing is unpinned", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { pins: [], most: 16, width: 300, height: 700 });
  try {
    const sizes = [];
    for (let n = 0; n <= 16; n++) {
      await x.setting({ pins: manyPins(n) }); await x.settle();
      const d = await dockNow(x.page);
      sizes.push(d.shown ? d.items[0].width : 0);
      if (!d.shown) { assert.equal(d.state, "aside", `${n} pinned at 300 px: it steps aside`); continue; }
      assert.equal(d.items.length, n + 1);
      assert.ok(d.items[0].width >= 24 && d.items[0].width <= 34, `${n} pinned: tiles are ${d.items[0].width}px, between 24 and the icon size`);
      assert.ok(d.bar.left >= 7.5 && d.bar.right <= 300 - 7.5, `${n} pinned: the bar fits the side bar (${d.bar.left} to ${d.bar.right})`);
    }
    assert.equal(sizes[0], 34, "few items: the icon size from Settings");
    for (let n = 1; n < sizes.length; n++) assert.ok(sizes[n] <= sizes[n - 1], `adding an item never makes tiles larger (${sizes.join(", ")})`);
    assert.ok(sizes[8] >= 24 && sizes[8] <= 26, `eight fit a 300 px side bar at about 25 px (${sizes[8]})`);
    assert.ok(Math.min(...sizes.filter(Boolean)) >= 24, "no tile is ever under 24 px");
    // Where 24 px is what fits (eight in a 285 px side bar), that is the size; a pixel less room and the dock is aside.
    await x.setting({ pins: manyPins(8) });
    await x.page.setViewportSize({ width: 285, height: 700 }); await x.settle();
    assert.equal((await dockNow(x.page)).items[0].width, 24, "the smallest tile is 24 px");
    await x.page.setViewportSize({ width: 282, height: 700 }); await x.settle();
    assert.equal((await dockNow(x.page)).shown, false);
    await x.page.setViewportSize({ width: 300, height: 700 }); await x.settle();
    assert.ok(sizes.indexOf(0) > 8, `past what fits at 24 px the dock steps aside (${sizes.join(", ")})`);
    assert.equal(sizes.at(-1), 0);

    // The same eight in a 230 px side bar: aside. Wider again: back, with all eight.
    await x.setting({ pins: manyPins(8) });
    await x.page.setViewportSize({ width: 230, height: 700 }); await x.settle();
    let d = await dockNow(x.page);
    assert.equal(d.shown, false, "eight at 230 px would need tiles under 24 px: the dock steps aside");
    assert.equal(d.state, "aside");
    assert.equal(d.items.length, 9, "nothing is unpinned");
    assert.ok(d.page.bottom >= 700 - 0.6, "and the page takes the room");
    assert.deepEqual(await posted(x, "dockUnpin"), [], "no unpin is asked for");
    await x.page.setViewportSize({ width: 300, height: 700 }); await x.settle();
    d = await dockNow(x.page);
    assert.equal(d.shown, true); assert.equal(d.items.length, 9);
    // Sixteen in a wide side bar.
    await x.setting({ pins: manyPins(16) });
    await x.page.setViewportSize({ width: 700, height: 700 }); await x.settle();
    d = await dockNow(x.page);
    assert.equal(d.items.length, 17, "sixteen and + in a 700 px side bar");
    assert.ok(d.items[0].width >= 32 && d.bar.left >= 7.5 && d.bar.right <= 700 - 7.5, `at nearly their full size, inside the side bar (${d.items[0].width}px)`);
    // Settings' icon size: the largest the tiles get.
    await x.setting({ pins: PINS, size: 44 }); await x.settle();
    assert.equal((await dockNow(x.page)).items[0].width, 44);
    await x.setting({ size: 24 }); await x.settle();
    assert.equal((await dockNow(x.page)).items[0].width, 24);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("past the most, pinning one more asks which to take off (here: the scene's host notes the question)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { pins: manyPins(8), most: 8, width: 300, height: 760 });
  try {
    const session = `#sessions-list .session-row[data-id="${DOCK_SESSIONS[2].id}"]`;
    await x.page.hover(session); await x.page.click(`${session} .dgc-pin`); await x.settle();
    const asked = await x.page.evaluate(() => window.__asked);
    assert.equal(asked.length, 1); assert.equal(asked[0].most, 8); assert.equal(asked[0].offered.length, 8);
    assert.equal((await dockNow(x.page)).items.length, 9, "still eight and +");
  } finally { await x.close(); }
});

// ---- Settings' three choices -------------------------------------------------------------------------------------------
test("Always: the dock has its own room. When I point at the bottom: it rises over the page and drops a second after the pointer leaves. Never: no dock", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    const always = await dockNow(x.page);
    assert.equal(always.show, "always");
    assert.ok(always.page.bottom <= always.host.top + 0.6 && always.host.height > 40, "Always: the page ends above the dock");

    await x.setting({ show: "hover" }); await x.settle(); await x.page.waitForTimeout(300);
    let d = await dockNow(x.page);
    assert.equal(d.show, "hover"); assert.equal(d.up, false);
    assert.ok(d.page.bottom >= 700 - 0.6, `the page has its full height (${d.page.bottom})`);
    assert.ok(d.bar.top >= 700 - 0.5 || d.barOpacity < 0.05, "the dock is away");
    const hint = await x.page.evaluate(() => { const h = document.querySelector("#dgc-dock .dgc-dock-hint"), r = h.getBoundingClientRect(); return { shown: h.checkVisibility(), width: r.width, height: r.height, bottom: r.bottom, mid: r.left + r.width / 2 }; });
    assert.ok(hint.shown && hint.width >= 24 && hint.height <= 4 && hint.bottom <= 700 && Math.abs(hint.mid - 150) < 1, "only a short line at the bottom edge");
    // Its covered row still takes a click while the dock is away.
    assert.equal(await x.page.evaluate(() => document.elementFromPoint(150, 660)?.closest("#dgc-dock") === null), true, "away, it takes no clicks from the page");

    // The pointer reaches the bottom edge: it rises over the page.
    await x.page.mouse.move(150, 400); await x.page.mouse.move(150, 697, { steps: 4 });
    await x.page.waitForTimeout(450);
    d = await dockNow(x.page);
    assert.equal(d.up, true, "it rises");
    assert.ok(d.bar.bottom <= 700 - 7.5 && d.bar.top > 600 && d.barOpacity > 0.95, `it stands where the Always dock stands (${d.bar.top} to ${d.bar.bottom})`);
    assert.ok(d.page.bottom >= 700 - 0.6, "over the page: the page keeps its height");
    assert.deepEqual(keys(d), [...PINS.map((p) => p.key), "+"]);
    // On the dock, it stays, magnifies and names.
    d = await pointAt(x, WORK_A);
    assert.equal(d.up, true); assert.equal(d.tip.title, DOCK_SESSIONS[0].name);
    assert.ok(d.items.find((i) => i.key === WORK_A).width > d.items.at(-1).width);
    // The pointer leaves: still there for most of a second, then gone.
    await x.page.mouse.move(150, 300, { steps: 4 });
    await x.page.waitForTimeout(600);
    assert.equal((await dockNow(x.page)).up, true, "0.6 s after the pointer left it is still up");
    await x.page.waitForTimeout(900);
    d = await dockNow(x.page);
    assert.equal(d.up, false, "about a second after, it drops away");
    assert.equal(d.tip, null);
    // Coming back before the second is up keeps it.
    await x.page.mouse.move(150, 698, { steps: 3 }); await x.page.waitForTimeout(300);
    await x.page.mouse.move(150, 300, { steps: 3 }); await x.page.waitForTimeout(500);
    await x.page.mouse.move(150, 670, { steps: 3 }); await x.page.waitForTimeout(900);
    assert.equal((await dockNow(x.page)).up, true, "back on the dock within the second: it stays");
    // A menu it opened holds it up too.
    await x.page.mouse.click(...centre((await dockNow(x.page)).items.at(-1))); await x.settle();
    await x.page.mouse.move(150, 500, { steps: 3 }); await x.page.waitForTimeout(1300);
    d = await dockNow(x.page);
    assert.equal(d.up, true, "while its menu is open it stays up");
    assert.equal(d.menu.length, 4);
    await x.page.keyboard.press("Escape");

    await x.setting({ show: "never" }); await x.settle();
    d = await dockNow(x.page);
    assert.equal(d.shown, false, "Never: no dock");
    assert.ok(d.page.bottom >= 700 - 0.6);
    assert.equal(d.items.length, 7, "what was pinned is kept");
    await x.page.mouse.move(150, 698, { steps: 3 }); await x.page.waitForTimeout(300);
    assert.equal((await dockNow(x.page)).shown, false, "and the bottom edge brings nothing");
    await x.setting({ show: "always" }); await x.settle();
    assert.equal((await dockNow(x.page)).shown, true);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- the keyboard ------------------------------------------------------------------------------------------------------
test("the keyboard: Tab into the dock, arrows between items, Home and End, Enter opens, Shift+F10 opens its menu, Escape goes back", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    // From the page's last control, Tab lands on the dock: one stop for all of it.
    await x.page.evaluate(() => { const host = document.getElementById("sessions-host"); const all = [...host.querySelectorAll("button, [tabindex='0'], input")].filter((n) => n.checkVisibility() && !n.disabled && n.tabIndex >= 0); all.at(-1).focus(); });
    // (The last row shows its own buttons once it holds the keyboard: Tab passes through them, then leaves the page.)
    for (let i = 0; i < 8; i++) { await x.page.keyboard.press("Tab"); if (await x.page.evaluate(() => !document.getElementById("sessions-host").contains(document.activeElement))) break; }
    let d = await dockNow(x.page);
    assert.equal(d.focus, PIP_B, "Tab from the page reaches the dock's first item");
    assert.deepEqual(d.items.filter((i) => i.tab === 0).map((i) => i.key), [PIP_B], "the dock is one Tab stop");
    assert.deepEqual([d.tip?.title, d.tip?.state], ["Mail watch", "2 waiting for you"], "focused from the keyboard, it is named as for the pointer");
    const ring = await x.page.evaluate(() => { const s = getComputedStyle(document.activeElement.querySelector(".dgc-dock-tile")); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
    assert.ok(ring.style === "solid" && ring.width >= 1, "with a focus ring on its tile");
    await x.page.keyboard.press("ArrowRight");
    assert.equal((await dockNow(x.page)).focus, PINS[1].key);
    await x.page.keyboard.press("End");
    d = await dockNow(x.page);
    assert.equal(d.focus, "+"); assert.equal(d.tip.title, "New");
    await x.page.keyboard.press("ArrowRight");
    assert.equal((await dockNow(x.page)).focus, PIP_B, "Right from + wraps to the first");
    await x.page.keyboard.press("ArrowLeft");
    assert.equal((await dockNow(x.page)).focus, "+");
    await x.page.keyboard.press("Home");
    await x.page.keyboard.press("ArrowRight"); await x.page.keyboard.press("ArrowRight"); await x.page.keyboard.press("ArrowRight");
    assert.equal((await dockNow(x.page)).focus, WORK_A);
    // Enter opens.
    await x.page.keyboard.press("Enter");
    assert.deepEqual((await posted(x, "dockOpen")).at(-1), { type: "dockOpen", key: WORK_A });
    // The menu, by the keyboard: its first row has the focus.
    await x.page.keyboard.press("Shift+F10"); await x.settle();
    d = await dockNow(x.page);
    assert.equal(d.menu.length, 5);
    assert.equal(d.focus, "open", "the menu opens with its first row focused");
    await x.page.keyboard.press("ArrowDown");
    assert.equal((await dockNow(x.page)).focus, "unpin");
    await x.page.keyboard.press("ArrowDown"); await x.page.keyboard.press("ArrowDown"); await x.page.keyboard.press("ArrowDown");
    const own = (await dockNow(x.page)).items.find((i) => i.key === WORK_A).blob.pair;
    assert.equal((await dockNow(x.page)).focus, String(own), "Down reaches the colours, on the one chosen");
    await x.page.keyboard.press("ArrowRight");
    assert.equal((await dockNow(x.page)).focus, String(own % 7 + 1), "Right moves along the colours");
    await x.page.keyboard.press("Escape");
    d = await dockNow(x.page);
    assert.deepEqual(d.menu, []); assert.equal(d.focus, WORK_A, "Escape closes the menu and returns to its item");
    // Unpin by the keyboard: the focus stays in the dock.
    await x.page.keyboard.press("Shift+F10"); await x.settle();
    await x.page.keyboard.press("ArrowDown"); await x.page.keyboard.press("Enter"); await x.settle();
    d = await dockNow(x.page);
    assert.ok(!keys(d).includes(WORK_A), "Enter on Unpin unpins");
    assert.ok(keys(d).includes(d.focus), `the focus stays on the dock (${d.focus})`);
    // "+" by the keyboard.
    await x.page.keyboard.press("End"); await x.page.keyboard.press("Enter"); await x.settle();
    d = await dockNow(x.page);
    assert.deepEqual(d.menu, ["New Work session", "New ChatDGC chat", "New Personal Pip", "Settings"]);
    assert.equal(d.focus, "work");
    await x.page.keyboard.press("End"); await x.page.keyboard.press("Enter");
    assert.deepEqual((await posted(x, "dockNew")).at(-1), { type: "dockNew", what: "settings" });
    // Shift+Tab leaves the dock for the page.
    await x.page.keyboard.press("Shift+Tab");
    assert.equal(await x.page.evaluate(() => !!document.activeElement.closest("#sessions-host")), true, "Shift+Tab goes back to the page");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("When I point at the bottom: the keyboard brings the dock up too, and it drops once the focus has left", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700, show: "hover" });
  try {
    assert.equal((await dockNow(x.page)).up, false);
    await x.page.evaluate(() => { const host = document.getElementById("sessions-host"); const all = [...host.querySelectorAll("button, [tabindex='0'], input")].filter((n) => n.checkVisibility() && !n.disabled && n.tabIndex >= 0); all.at(-1).focus(); });
    // (The last row shows its own buttons once it holds the keyboard: Tab passes through them, then leaves the page.)
    for (let i = 0; i < 8; i++) { await x.page.keyboard.press("Tab"); if (await x.page.evaluate(() => !document.getElementById("sessions-host").contains(document.activeElement))) break; } await x.page.waitForTimeout(400);
    let d = await dockNow(x.page);
    assert.equal(d.focus, PIP_B); assert.equal(d.up, true, "Tab into the dock raises it");
    assert.ok(d.barOpacity > 0.95 && d.bar.bottom <= 700 - 7.5);
    await x.page.keyboard.press("Shift+Tab"); await x.page.waitForTimeout(1400);
    d = await dockNow(x.page);
    assert.equal(d.up, false, "a second after the focus left, it drops");
  } finally { await x.close(); }
});

// ---- states ------------------------------------------------------------------------------------------------------------
test("on an item: a quiet dot while it is open in an editor, the accent's dot while it runs, a number when it needs you", async (t) => {
  if (skipOrFail(t)) return;
  const waiting = { key: `work:${DOCK_SESSIONS[2].id}`, kind: "work", id: DOCK_SESSIONS[2].id, title: DOCK_SESSIONS[2].name, sub: "", look: {}, ref: {} };
  const x = await openDock(browser, { width: 360, height: 700, pins: [...PINS, waiting], answering: [] });
  try {
    let d = await dockNow(x.page);
    const of = (key) => d.items.find((i) => i.key === key);
    assert.deepEqual([of(WORK_A).dot, of(WORK_A).blob.running], ["live", true], "running: the live dot, and its blob glows");
    assert.deepEqual([of(WORK_B).dot, of(WORK_B).blob.running], ["open", false], "open in a tab: a quiet dot, no glow");
    assert.deepEqual([of(CHAT_A).dot, of(CHAT_A).blob.running], ["open", false]);
    assert.deepEqual([of(PIP_B).badge, of(PIP_B).dot], ["2", ""], "a Pip that needs you: its number");
    assert.deepEqual([of(waiting.key).badge, of(waiting.key).dot], ["1", ""], "a session that wants your okay: a number");
    assert.match(of(waiting.key).label, /Wants your okay/);
    assert.equal(of(PINS[1].key).badge, "", "nothing waiting: no number");
    const look = await x.page.evaluate(([live, open]) => { const q = (key, sel) => getComputedStyle(document.querySelector(`#dgc-dock [data-key="${key}"] ${sel}`));
      const accent = (() => { const i = document.createElement("i"); i.style.color = "var(--accent)"; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; })();
      return { live: q(live, ".dgc-dock-dot").backgroundColor, quiet: q(open, ".dgc-dock-dot").backgroundColor, accent, glow: q(live, ".dgc-blob").boxShadow, rest: q(open, ".dgc-blob").boxShadow,
        badge: q(`pip:${"pip_" + "b".repeat(32)}`, ".dgc-dock-badge").backgroundColor }; }, [WORK_A, WORK_B]);
    assert.equal(look.live, look.accent, "the running dot is the accent");
    assert.notEqual(look.quiet, look.accent, "the open dot is not");
    assert.notEqual(look.badge, look.accent, "a number is never purple");
    assert.notEqual(look.glow, "none", "a running blob glows"); assert.equal(look.rest, "none", "a blob at rest has no glow");
    // A chat that is answering runs too.
    await x.send({ type: "chatdgc_list", available: true, items: CHATS, open: ["chat_1"], answering: ["chat_1"] }); await x.settle();
    d = await dockNow(x.page);
    assert.deepEqual([of(CHAT_A).dot, of(CHAT_A).blob.running], ["live", true]);
    assert.match(of(CHAT_A).label, /Answering/);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- the blob ----------------------------------------------------------------------------------------------------------
test("a blob: our own markup and CSS, always full, moving on the loader's timing; paused off screen, still under reduced motion", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 700 });
  try {
    const probe = () => x.page.evaluate((key) => {
      const blob = document.querySelector(`#dgc-dock [data-key="${key}"] .dgc-blob`), fill = blob.querySelector(".dgc-blob-fill");
      const part = (sel, pseudo) => { const s = getComputedStyle(fill.querySelector(sel), pseudo); return { names: s.animationName, state: s.animationPlayState, time: s.animationDuration }; };
      const r = blob.getBoundingClientRect(), f = fill.getBoundingClientRect(), s = getComputedStyle(fill);
      return { full: Math.abs(f.height - r.height) < 0.1 && Math.abs(f.width - r.width) < 0.1, bg: s.backgroundImage, blur: s.filter, radius: getComputedStyle(blob).borderRadius, paused: blob.classList.contains("is-paused"),
        wave: part(".w"), surface: part(".s"), shimmer: part(".h"), bubble: part(".b"), dot: part(".b", "::before"),
        canvas: document.querySelectorAll("#dgc-dock canvas").length, marks: blob.querySelectorAll("svg, img").length };
    }, WORK_A);
    let b = await probe();
    assert.equal(b.full, true, "always full: the liquid fills the whole blob");
    assert.match(b.bg, /^linear-gradient\(to top, /, "the pair's gradient, bottom to top");
    assert.match(b.blur, /blur\(0\.3px\)/, "under a 0.3 px blur");
    assert.equal(b.radius, "50%", "a Work session's is round");
    assert.equal(b.marks, 0, "no mark on it"); assert.equal(b.canvas, 0, "no canvas, no shader");
    assert.match(b.surface.names, /dgc-blob-surface/); assert.match(b.wave.names, /dgc-blob-wave/); assert.match(b.shimmer.names, /dgc-blob-shimmer/); assert.match(b.bubble.names, /dgc-blob-drift/);
    assert.match(b.surface.time, /^6\.283s/, "the surface rides the main wave (2π seconds), with its bounce and ripple in the same keyframes");
    for (const part of [b.wave, b.surface, b.shimmer, b.bubble, b.dot]) assert.ok(part.state.split(", ").every((s) => s === "running"), "on screen it moves");
    assert.equal(b.paused, false);
    // Off screen (the side bar scrolled it away, here: moved out of view): it pauses.
    await x.page.evaluate(() => { document.getElementById("dgc-dock").style.transform = "translateY(400px)"; });
    await x.page.waitForFunction((key) => document.querySelector(`#dgc-dock [data-key="${key}"] .dgc-blob`).classList.contains("is-paused"), WORK_A);
    b = await probe();
    for (const part of [b.wave, b.surface, b.shimmer, b.bubble, b.dot]) assert.ok(part.state.split(", ").every((s) => s === "paused"), "off screen every part is paused");
    await x.page.evaluate(() => { document.getElementById("dgc-dock").style.transform = ""; });
    await x.page.waitForFunction((key) => !document.querySelector(`#dgc-dock [data-key="${key}"] .dgc-blob`).classList.contains("is-paused"), WORK_A);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  const still = await openDock(browser, { width: 300, height: 700, motion: "reduce" });
  try {
    const names = await still.page.evaluate((key) => { const fill = document.querySelector(`#dgc-dock [data-key="${key}"] .dgc-blob-fill`);
      return [...fill.querySelectorAll("i")].map((i) => getComputedStyle(i).animationName).concat(getComputedStyle(fill.querySelector(".b"), "::before").animationName); }, WORK_A);
    assert.deepEqual([...new Set(names)], ["none"], "reduced motion: nothing in a blob moves");
  } finally { await still.close(); }
});

test("the keyframes carry the loader's timing: a main wave, a bounce four times as fast at 0.15, a ripple eight times as fast at 0.05", () => {
  const css = read("media/shared/blob.css");
  const frames = css.match(/@keyframes dgc-blob-surface \{([^@]*)\}\s*@keyframes/)[1];
  const stops = [...frames.matchAll(/([\d.]+)% \{ translate: 0 (-?[\d.]+)%; \}/g)].map((m) => [Number(m[1]) / 100, Number(m[2])]);
  assert.ok(stops.length >= 24, "enough stops to carry the ripple");
  const amp = 9;
  for (const [at, y] of stops) {
    const tt = at * 2 * Math.PI, want = amp * (Math.sin(tt) + 0.15 * Math.sin(4 * tt) + 0.05 * Math.sin(8 * tt));
    assert.ok(Math.abs(y - want) < 0.02, `at ${at}: ${y} for ${want.toFixed(2)}`);
  }
  assert.match(css, /--blob-i, 0\) \* -\.8s/, "each blob starts 0.8 s further along than the one before");
});

test("our own code: no third-party shader or library, nothing to credit, and the seven pairs are the only colours", () => {
  for (const file of ["media/shared/blob.js", "media/shared/dock.js", "media/shared/blob.css", "media/shared/dock.css", "src/dock.ts"]) {
    const text = read(file);
    assert.doesNotMatch(text, /paper|shader|webgl|getContext|<canvas/i, `${file} draws with nothing but its own code`);
    const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.filter((name) => !["vscode", "fs", "zlib"].includes(name)), [], `${file} brings in no library`);
    assert.doesNotMatch(text, /require\(|import\(/, `${file} loads nothing at run time`);
    assert.doesNotMatch(text, /https?:\/\//, `${file} links to nothing`);
  }
  assert.doesNotMatch(read("THIRD_PARTY_NOTICES.md"), /blob|liquid|dock/i, "nothing to credit");
  const tokens = read("media/shared/tokens.css");
  const pairs = [["a855f7", "ec4899"], ["3b82f6", "a855f7"], ["22d3ee", "3b82f6"], ["4ade80", "22d3ee"], ["facc15", "4ade80"], ["fb923c", "facc15"], ["ef4444", "fb923c"]];
  pairs.forEach(([from, to], i) => { assert.match(tokens, new RegExp(`--blob-${i + 1}a:#${from}; --blob-${i + 1}b:#${to};`), `pair ${i + 1}`); });
  assert.doesNotMatch(read("media/shared/blob.css") + read("media/shared/dock.css"), /#[0-9a-f]{6}\b/i, "the blob and the dock take every colour from the tokens");
});

// ---- a session's colour, from its three places -------------------------------------------------------------------------
test("a session's colour from its row's …: Open in editor, Pin to the dock, seven colours, and Back to its own colour", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { pins: [], width: 300, height: 760 });
  try {
    const id = DOCK_SESSIONS[1].id, row = `#sessions-list .session-row[data-id="${id}"]`;
    await x.page.hover(row); await x.page.click(`${row} .session-more`); await x.settle();
    let d = await dockNow(x.page);
    assert.deepEqual(d.menu, ["Open in editor", "Pin to the dock", "Back to its own colour (off)"]);
    assert.equal(d.swatches.length, 7);
    assert.equal(await x.page.evaluate((sel) => document.querySelector(sel).querySelector(".session-actions").checkVisibility(), row), true, "the row keeps its actions while its menu is open");
    const menu = await x.page.evaluate(() => { const r = document.querySelector(".dgc-pop").getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; });
    assert.ok(menu[0] >= 5.5 && menu[1] <= 300 - 5.5 && menu[2] >= 5.5 && menu[3] <= 760 - 5.5, "the menu is inside the side bar");
    const own = d.swatches.find((s) => s.on).pair, other = own === 3 ? 5 : 3;
    await x.page.click(`.dgc-pop .dgc-swatch[data-colour="${other}"]`);
    assert.deepEqual((await posted(x, "dockColour")).at(-1), { type: "dockColour", key: `work:${id}`, colour: other });
    await x.page.hover(row); await x.page.click(`${row} .session-more`); await x.settle();
    d = await dockNow(x.page);
    assert.deepEqual(d.swatches.filter((s) => s.on).map((s) => s.pair), [other], "the chosen colour is kept and marked");
    await x.page.click('.dgc-pop [data-id="pin"]'); await x.settle();
    d = await dockNow(x.page);
    assert.equal(d.items[0].blob.pair, other, "pinned, its blob is the colour chosen");
    await x.page.hover(row); await x.page.click(`${row} .session-more`); await x.settle();
    assert.equal((await dockNow(x.page)).menu[1], "Unpin from the dock");
    await x.page.click('.dgc-pop [data-colour="own"]'); await x.settle();
    assert.equal((await dockNow(x.page)).items[0].blob.pair, own, "Back to its own colour");
    // By the keyboard: the … opens with its first row focused, and Escape returns to it.
    await x.page.focus(row); for (let i = 0; i < 3; i++) await x.page.keyboard.press("Tab");
    assert.equal(await x.page.evaluate(() => document.activeElement.className), "session-more", "Tab from the row: Open in Editor, the pin, then …");
    await x.page.keyboard.press("Enter"); await x.settle();
    assert.equal((await dockNow(x.page)).focus, "open");
    await x.page.keyboard.press("Escape");
    assert.equal(await x.page.evaluate(() => document.activeElement.className), "session-more");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a Work session's tab: its blob is in its header, and a click offers the seven colours", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWorkTab(browser, { width: 700 });
  try {
    assert.equal(await x.page.evaluate(() => document.getElementById("session-blob")?.hidden ?? true), true, "a new session with nothing saved has no blob yet");
    await x.send({ type: "chat_tab", session: "20261106-101500-a1" });
    const blob = () => x.page.evaluate(() => { const b = document.getElementById("session-blob"), inner = b.querySelector(".dgc-blob"), r = b.getBoundingClientRect(), title = document.getElementById("thread-title").getBoundingClientRect();
      return { hidden: b.hidden, shape: inner.dataset.shape, pair: Number(inner.dataset.pair), label: b.getAttribute("aria-label"), beforeTitle: r.right <= title.left + 0.5, mid: Math.abs((r.top + r.bottom) / 2 - (title.top + title.bottom) / 2) }; });
    let b = await blob();
    assert.equal(b.hidden, false); assert.equal(b.shape, "round");
    assert.ok(b.beforeTitle && b.mid < 1.5, "before the session's name, on its line");
    assert.match(b.label, /^This session's colour: .+\. Change it$/);
    const own = b.pair;
    await x.page.click("#session-blob");
    const d = await x.page.evaluate(() => ({ rows: [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].map((r) => r.textContent.trim()), dots: [...document.querySelectorAll(".dgc-pop .dgc-swatch")].map((s) => [Number(s.dataset.colour), s.getAttribute("aria-checked")]),
      below: document.querySelector(".dgc-pop").getBoundingClientRect().top >= document.getElementById("session-blob").getBoundingClientRect().bottom }));
    assert.deepEqual(d.rows, ["Back to its own colour"]); assert.equal(d.dots.length, 7); assert.equal(d.below, true, "the colours open under the blob");
    assert.deepEqual(d.dots.filter(([, on]) => on === "true").map(([n]) => n), [own]);
    const other = own === 7 ? 5 : 7;
    await x.page.click(`.dgc-pop .dgc-swatch[data-colour="${other}"]`);
    assert.deepEqual((await x.posted("dockColour")).at(-1), { type: "dockColour", key: "work:20261106-101500-a1", colour: other });
    await x.send({ type: "dock", pins: [], colours: { "work:20261106-101500-a1": other }, show: "always", most: 8, size: 34 });
    b = await blob();
    assert.equal(b.pair, other, "the host says the colour: the header's blob takes it");
    assert.equal(await x.page.evaluate(() => !!document.getElementById("dgc-dock")), false, "a session's tab has no dock: it belongs to the side bar");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("a ChatDGC chat's tab: its blob is a rounded square in its header, with the same seven colours", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { width: 700 });
  try {
    const chat = conversation({ title: "A week in Goa in March" });
    await x.send({ type: "opened", conversation: chat, earlier: 0, busy: false, messages: [{ id: M(1), role: "user", text: "Plan a week in Goa.", created_at: "2026-11-10T09:30:00Z" }] });
    await x.page.waitForSelector("#cd-blob:not([hidden])");
    const b = await x.page.evaluate(() => { const b = document.getElementById("cd-blob"), inner = b.querySelector(".dgc-blob"), r = b.getBoundingClientRect(), title = document.getElementById("cd-title").getBoundingClientRect();
      return { shape: inner.dataset.shape, pair: Number(inner.dataset.pair), radius: getComputedStyle(inner).borderRadius, beforeTitle: r.right <= title.left + 0.5, label: b.getAttribute("aria-label") }; });
    assert.equal(b.shape, "square"); assert.equal(b.radius, "30%"); assert.equal(b.beforeTitle, true);
    assert.match(b.label, /^This chat's colour: /);
    await x.page.click("#cd-blob");
    assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll(".dgc-pop .dgc-swatch")].map((s) => s.dataset.shape)), Array(7).fill("square"));
    await x.page.click('.dgc-pop .dgc-swatch[data-colour="1"]');
    assert.deepEqual((await x.posted("dockColour")).at(-1), { type: "dockColour", key: `chat:${chat.id}`, colour: 1 }, "pair 1 (purple to pink) is there to pick by hand");
    await x.send({ type: "dock", pins: [], colours: { [`chat:${chat.id}`]: 1 }, show: "always", most: 8, size: 34 });
    assert.equal(await x.page.evaluate(() => Number(document.querySelector("#cd-blob .dgc-blob").dataset.pair)), 1);
    // An Incognito chat is never listed, so it has no blob.
    await x.send({ type: "opened", conversation: conversation({ id: "chat_" + "9".repeat(32), temporary: true, title: "" }), earlier: 0, busy: false, messages: [] });
    assert.equal(await x.page.evaluate(() => document.getElementById("cd-blob").hidden), true);
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

// ---- contrast and the purple share ----------------------------------------------------------------------------------------
const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
for (const theme of ["dark-modern", "light-modern"]) {
  test(`${theme}: the dock's words clear 4.5:1 and its marks 3:1`, async (t) => {
    if (skipOrFail(t)) return;
    for (const show of ["always", "hover"]) {
      const x = await openDock(browser, { width: 300, height: 700, theme, show });
      try {
        const seen = [];
        const check = async (said) => { for (const m of await dockContrast(x.page)) { const r = ratio(m.ink, m.ground); seen.push(`${said} ${m.what} ${r.toFixed(2)}`);
          assert.ok(r >= (m.kind === "words" ? 4.5 : 3), `${theme}, ${said}: ${m.what} is ${r.toFixed(2)}:1 (${m.ink.map(Math.round)} on ${m.ground.map(Math.round)})`); } };
        if (show === "hover") { await check("the dock away"); await x.page.mouse.move(150, 698, { steps: 3 }); await x.page.waitForTimeout(400); }
        await pointAt(x, WORK_A); await check("an item named");
        const d = await dockNow(x.page);
        await x.page.mouse.click(...centre(d.items.find((i) => i.key === WORK_B)), { button: "right" }); await x.settle(); await check("its menu");
        await x.page.keyboard.press("Escape");
        await x.page.mouse.click(...centre((await dockNow(x.page)).items.at(-1))); await x.settle(); await check("the + menu");
        await x.page.keyboard.press("Escape");
        if (show === "always") {
          await x.page.hover(`#sessions-list .session-row[data-id="${DOCK_SESSIONS[1].id}"]`); await check("a pinned session's row");
          await x.page.hover(`#sessions-list .session-row[data-id="${DOCK_SESSIONS[2].id}"]`); await check("an unpinned session's row");
          await x.setting({ pins: [] }); await x.settle(); await check("nothing pinned");
        }
        assert.ok(seen.length > 12, "words and marks were measured");
      } finally { await x.close(); }
    }
  });
}
