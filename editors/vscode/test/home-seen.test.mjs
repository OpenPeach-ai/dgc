// "New" means not seen (asked 13 Nov, after midnight: "shouldn't when user is actually on that chat's editor tab, or
// comes back to its tab, the Recent card should remove its 'New' tag, considering user must have read that message?").
// The host says which sessions and chats are watched (their editor tab in front AND the window focused: src/panel.ts,
// src/sessionTabs.ts, src/chatdgc.ts; their own tests are in session-tabs.test.mjs and chatdgc-tabs.test.mjs); here,
// Home's page in real Chromium: a reply into a watched tab is never New, one into a tab in the background is, and it
// clears when that tab is watched; Recent's mark and the Home tab's number follow.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openGrid } from "./support/home-grid-scene.mjs";
import { DOCK_SESSIONS } from "./support/dock-scene.mjs";
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
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const QUIET = DOCK_SESSIONS.map(({ running, waiting, ...s }) => s);
/** Recent's rows marked New (each by what it opens: "hub:chat:<id>", "hub:work:<id>"), its New marks, and the Home tab's number. */
const now = (p) => p.evaluate(() => ({ fresh: [...document.querySelectorAll('.hc-grid .hc-card[data-card="recent"] .hc-li.hc-new')].map((r) => r.dataset.open),
  marks: document.querySelectorAll('.hc-grid .hc-card[data-card="recent"] .hc-newmark').length, badge: document.getElementById("side-tab-home-count").hidden ? 0 : Number(document.getElementById("side-tab-home-count").textContent) }));
const chats = (x, more) => x.send({ type: "chatdgc_list", available: true, items: CHATS, open: ["chat_1", "chat_2"], answering: [], ...more });

test("a chat's reply: into its tab in front in the focused window it is never New; into a background tab it is New until that tab is watched", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, layout: ["recent"], sessions: QUIET, state: homeState("quiet") });
  try {
    const p = x.page;
    await chats(x, {}); await x.settle();
    const base = (await now(p)).badge;
    assert.deepEqual((await now(p)).fresh, []);
    // Both answer; the user is on chat_1's tab.
    await chats(x, { answering: ["chat_1", "chat_2"], watched: ["chat_1"] }); await x.settle();
    await chats(x, { answering: [], watched: ["chat_1"] }); await x.settle();
    let n = await now(p);
    assert.deepEqual(n.fresh, ["hub:chat:chat_2"], "the reply the user watched arrive is not New; the one in the background is");
    assert.equal(n.marks, 1); assert.equal(n.badge, base + 1, "Home's number counts the one");
    // The window is elsewhere: nothing is watched, and New stays.
    await chats(x, { watched: [] }); await x.settle();
    assert.deepEqual((await now(p)).fresh, ["hub:chat:chat_2"], "a list that watches nothing clears nothing");
    // The user opens chat_2's tab (or comes back to it): read.
    await chats(x, { watched: ["chat_2"] }); await x.settle();
    n = await now(p);
    assert.deepEqual(n.fresh, [], "its tab is in front now: the New mark goes"); assert.equal(n.marks, 0); assert.equal(n.badge, base, "and Home's number drops");
    // It stays read across the next list.
    await chats(x, { watched: [] }); await x.settle();
    assert.deepEqual((await now(p)).fresh, []);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a chat that answers in a tab shown in a window that is not focused keeps New until the user is back", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, layout: ["recent"], sessions: QUIET, state: homeState("quiet") });
  try {
    const p = x.page;
    await chats(x, {}); await x.settle();
    const base = (await now(p)).badge;
    // Its tab is in front, but the window is not focused: the host watches nothing.
    await chats(x, { answering: ["chat_1"], watched: [] }); await x.settle();
    await chats(x, { answering: [], watched: [] }); await x.settle();
    assert.deepEqual((await now(p)).fresh, ["hub:chat:chat_1"]); assert.equal((await now(p)).badge, base + 1);
    // The window has the focus again, with that tab still in front.
    await chats(x, { watched: ["chat_1"] }); await x.settle();
    assert.deepEqual(await now(p), { fresh: [], marks: 0, badge: base });
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a Work session's reply: New while its tab is in the background, read the moment the list says its tab is watched", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, layout: ["recent"], sessions: QUIET, state: homeState("quiet") });
  try {
    const p = x.page, id = QUIET[1].id, news = [{ id, at: Date.now(), preview: "Tide pools matter because they are small, rough nurseries." }];
    const base = (await now(p)).badge;
    await x.send({ type: "sessions_list", items: QUIET, error: "", news }); await x.settle();
    let n = await now(p);
    assert.deepEqual(n.fresh, [`hub:work:${id}`]); assert.equal(n.badge, base + 1);
    // Still not watched (the window lost its focus with the tab in front): New stays.
    await x.send({ type: "sessions_list", items: QUIET, error: "", news }); await x.settle();
    assert.deepEqual((await now(p)).fresh, [`hub:work:${id}`]);
    await x.send({ type: "sessions_list", items: QUIET.map((s) => (s.id === id ? { ...s, watched: true } : s)), error: "", news }); await x.settle();
    n = await now(p);
    assert.deepEqual(n, { fresh: [], marks: 0, badge: base }, "watched: the mark goes and the number drops");
    assert.ok((await x.posted("homeSessionSeen")).length <= 1, "the host is not told again and again");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
