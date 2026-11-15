// The dock's new-message dot (0.52, his words of 15 Nov: "on the tabs we have docked or pinned sessions, if they have
// a new message, should we show like a new message dot on the right of the docked icon box of that session? … just a
// purple dot?"). A docked session, chat or Pip with a new message you haven't read shows a small purple dot at its
// tile's TOP-RIGHT corner, where the waiting count sits; never a number. The "waiting for your okay" count wins the
// corner when both apply. The dot UNDER the tile keeps its meaning (grey: open in an editor; purple: running). What is
// unread is what the lists already know: Work's and Chat's "new" (a turn that finished unseen), a Pip's unread
// (list_pip_unread). On the real side bar, in real Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, PINS, DOCK_SESSIONS, dockNow, dockContrast, pipId } from "./support/dock-scene.mjs";
import { CHATS, homeState } from "./support/home-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

/** Each dock tile: its corner (a number, the new-message dot, or nothing), the dot under it, and its name as read out. */
const tiles = (page) => page.evaluate(() => [...document.querySelectorAll("#dgc-dock .dgc-dock-item[data-key]")].map((b) => {
  const tile = b.querySelector(".dgc-dock-tile").getBoundingClientRect(), fresh = b.querySelector(".dgc-dock-new"), badge = b.querySelector(".dgc-dock-badge"), under = b.querySelector(".dgc-dock-dot");
  const f = fresh?.getBoundingClientRect(), cs = fresh ? getComputedStyle(fresh) : null;
  return { key: b.dataset.key, label: b.getAttribute("aria-label"), badge: badge?.textContent || "", under: under?.dataset.dot || "",
    fresh: fresh ? { w: f.width, h: f.height, dx: f.left + f.width / 2 - tile.right, dy: f.top + f.height / 2 - tile.top, text: fresh.textContent, colour: cs.backgroundColor, radius: cs.borderTopLeftRadius, hidden: fresh.getAttribute("aria-hidden"), seen: fresh.checkVisibility({ opacityProperty: true }) } : null };
}));
// The scene's lists: session 4 (at rest) has a reply nobody saw; chat 1 finished answering unseen; Mail watch has 3
// unread and 2 cards waiting (the number wins); Morning brief has 2 unread; Garden notes 1.
const NEWS = [{ id: DOCK_SESSIONS[3].id, at: Date.now() - 60000, preview: "Done: the totals round half up now." }];
const pins = [...PINS, { key: `work:${DOCK_SESSIONS[3].id}`, kind: "work", id: DOCK_SESSIONS[3].id, title: "Invoice totals", sub: "", look: {}, ref: {} }];
// (Seven tiles do not fit a 170 px side bar: the dock steps aside. There, the three it has room for: a Pip, a chat and
// a session, each with something new.)
const few = [PINS[1], PINS[5], pins.at(-1)];
async function open(opts = {}) {
  const x = await openDock(browser, { pins: opts.width < 240 ? few : pins, most: 12, state: homeState("busy"), saved: { sideTab: "work", hubNews: { work: {}, chat: { [CHATS[0].id]: Date.now() - 30000 }, ran: { work: [], chat: [] } } }, ...opts });
  await x.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", news: NEWS });
  await x.settle(); await x.page.waitForTimeout(150);
  return x;
}

for (const theme of ["dark-modern", "light-modern"]) for (const width of [170, 300]) {
  test(`${width} px (${theme}): a docked session, chat and Pip with something new show a small purple dot at the tile's top-right corner, never a number`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme });
    try {
      const all = await tiles(x.page), by = (key) => all.find((b) => b.key === key);
      const session = by(`work:${DOCK_SESSIONS[3].id}`), chat = by(`chat:${CHATS[0].id}`), brief = by(`pip:${pipId("c")}`), garden = by(`pip:${pipId("d")}`);
      assert.equal((await dockNow(x.page)).shown, true, "the dock is on screen");
      for (const [name, tile] of [["the session", session], ["the chat", chat], ["Morning brief", brief], ...(garden ? [["Garden notes", garden]] : [])]) {
        assert.ok(tile?.fresh, `${name}: a new-message dot`);
        assert.equal(tile.fresh.text, "", `${name}: never a number`); assert.equal(tile.badge, "", `${name}: no count`);
        assert.ok(tile.fresh.seen && tile.fresh.w >= 6 && tile.fresh.w <= 9 && Math.abs(tile.fresh.w - tile.fresh.h) < 0.6, `${name}: a small round dot (${tile.fresh.w})`);
        assert.ok(Math.abs(tile.fresh.dx) <= 3.5 && Math.abs(tile.fresh.dy) <= 3.5, `${name}: on the tile's top-right corner (${tile.fresh.dx.toFixed(1)}, ${tile.fresh.dy.toFixed(1)})`);
        assert.equal(tile.fresh.hidden, "true"); assert.match(tile.label, /New message/, `${name}: said in words too`);
      }
      // Purple: the accent, at 3:1 or more on the dock's ground.
      const rgb = session.fresh.colour.match(/[\d.]+/g).map(Number), lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const [r, g, b] = session.fresh.colour.startsWith("color(srgb") ? rgb.map((v) => v * 255) : rgb;
      assert.ok(b > r && b > g && r > g, `purple (${session.fresh.colour})`);
      const ground = (await dockContrast(x.page)).find((c) => c.kind === "mark")?.ground || (theme.startsWith("light") ? [255, 255, 255] : [30, 30, 30]);
      const ratio = (Math.max(lum([r, g, b]), lum(ground)) + 0.05) / (Math.min(lum([r, g, b]), lum(ground)) + 0.05);
      assert.ok(ratio >= 3, `it reads on the dock: ${ratio.toFixed(2)}:1`);
      // Waiting for your okay wins the corner.
      if (width >= 240) {
        const mail = by(`pip:${pipId("b")}`);
        assert.equal(mail.badge, "2", "Mail watch waits for you: its number"); assert.equal(mail.fresh, null, "and no dot beside the number");
        // What has nothing new has no dot; the dot under a tile is as it was.
        const running = by(`work:${DOCK_SESSIONS[0].id}`), open2 = by(`work:${DOCK_SESSIONS[1].id}`);
        assert.equal(running.fresh, null); assert.equal(running.under, "live"); assert.equal(open2.fresh, null); assert.equal(open2.under, "open");
      }
      assert.equal((await dockNow(x.page)).overflowX, false);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
test("the dot goes when it is read: the session's reply seen, the Pip's messages read", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 300 });
  try {
    const key = `work:${DOCK_SESSIONS[3].id}`;
    assert.ok((await tiles(x.page)).find((b) => b.key === key).fresh);
    // Its tab is watched now (the host says so in the list): the reply is seen.
    await x.send({ type: "sessions_list", items: DOCK_SESSIONS.map((s, i) => (i === 3 ? { ...s, open: true, watched: true } : s)), error: "", news: NEWS });
    await x.settle(); await x.page.waitForTimeout(150);
    assert.equal((await tiles(x.page)).find((b) => b.key === key).fresh, null, "seen: no dot");
    // A Pip read somewhere: the next poll has no unread for it.
    await x.page.evaluate((id) => { for (const w of Object.keys(window.__state.unread)) window.__state.unread[w] = window.__state.unread[w].filter((p) => p.pip_id !== id); }, pipId("c"));
    await x.refresh(); await x.settle();
    assert.equal((await tiles(x.page)).find((b) => b.key === `pip:${pipId("c")}`).fresh, null);
    assert.ok((await tiles(x.page)).find((b) => b.key === `pip:${pipId("d")}`).fresh, "the other Pip keeps its own");
  } finally { await x.close(); }
});
test("forced colours: the dot is still there, in a system colour", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 170, forced: true });
  try {
    const tile = (await tiles(x.page)).find((b) => b.key === `work:${DOCK_SESSIONS[3].id}`);
    assert.ok(tile.fresh?.seen && tile.fresh.w >= 6, "seen at 170 px");
    assert.notEqual(tile.fresh.colour, "rgba(0, 0, 0, 0)", "it has a colour of its own");
    assert.equal(await x.page.evaluate(() => getComputedStyle(document.querySelector("#dgc-dock .dgc-dock-new")).forcedColorAdjust), "none");
  } finally { await x.close(); }
});
