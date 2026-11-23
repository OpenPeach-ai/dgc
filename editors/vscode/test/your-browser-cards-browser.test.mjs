// Your Browser, phase 4 (0.52), in real Chromium: what a Pip's own tab there asks you, as its chat really draws it (words:
// your-browser-cards.test.mjs). A sign-in card's Open Your Browser opens the site in YOUR OWN tab there (DGC's
// open_your_browser, with nothing else: no answer is given for you), and where the computer DGC runs on has no screen it
// opens your own tab in an editor tab. A site card has Allow and Not now; a payment there has no Always allow. And what a
// lane waits for is never among its own computer's notifications.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat } from "./support/pip-chat-scene.mjs";
import { openComputer, PIP } from "./support/pip-computer-scene.mjs";

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

const LANE = { host: "shop.lanestore.com", method: "GET", path: "/", page: "https://shop.lanestore.com/account", fields: [], more_fields: 0, body_bytes: 0, your_browser: true };
const SIGN_IN = { ...LANE, kind: "yb_sign_in", site: "lanestore.com", shown: "lanestore.com" };
const SITE = { ...LANE, kind: "yb_site", site: "otherplace.net", shown: "otherplace.net", host: "reviews.otherplace.net", page: "https://reviews.otherplace.net/kettle" };
const PAY = { ...LANE, method: "POST", path: "/checkout/pay", payment: true, body_bytes: 40, fields: [{ name: "amount", value: "42.00" }] };
const buttons = (p) => p.evaluate(() => [...(window.__pipsRoot || document).querySelectorAll("[data-computer-card] .dgc-card-actions button")]
  .filter((b) => b.checkVisibility()).map((b) => [b.textContent, b.classList.contains("primary")]));

for (const theme of ["dark", "light"]) test(`a sign-in card opens the site in your own tab of Your Browser and answers nothing for you (${theme})`, async (t) => {
  if (skipOrFail(t)) return;
  const chat = await openChat(browser, { where: "side", width: 440, height: 700, api: 112, theme, hold: SIGN_IN,
    stubs: { open_your_browser: { ok: true, kind: "host_profile", weaker: true, url: SIGN_IN.page, open: true, view: "tab" } } });
  try {
    await chat.p.waitForSelector("[data-computer-card] [data-yb-open]");
    assert.deepEqual(await buttons(chat.p), [["Open Your Browser", true], ["I’ve signed in", false], ["Not now", false]]);
    const words = await chat.p.evaluate(() => (window.__pipsRoot || document).querySelector("[data-computer-card]").textContent);
    assert.match(words, /Sign in to lanestore\.com in Your Browser\?/);
    assert.match(words, /never sees or types your password/);
    await chat.p.click("[data-computer-card] [data-yb-open]");
    await chat.p.waitForFunction(() => (window.__sent || []).some((r) => r.type === "open_your_browser"));
    const sent = await chat.p.evaluate(() => window.__sent.filter((r) => /open_your_browser|decide|always/.test(r.type)));
    assert.deepEqual(sent.map((r) => [r.type, r.url, Object.keys(r).filter((k) => !["type", "url"].includes(k))]),
      [["open_your_browser", SIGN_IN.page, []]], "your own tab at the site, and no answer given for you");
    await chat.p.waitForFunction(() => (window.__posted || []).some((m) => m.type === "pipsOpenYourBrowser"));
    const posted = await chat.p.evaluate(() => window.__posted.filter((m) => m.type === "pipsOpenYourBrowser"));
    assert.deepEqual(posted.map((m) => [m.own, m.pip]), [[true, undefined]], "no screen here: your own tab in an editor tab, never the Pip's");
    assert.ok(await chat.p.isVisible("[data-computer-card] [data-yb-open]"), "the card still waits for your I've signed in");
    assert.deepEqual(chat.errors, []);
  } finally { await chat.close(); }
});

test("a site card asks to let it use the site there: Allow or Not now, no Always allow", async (t) => {
  if (skipOrFail(t)) return;
  const chat = await openChat(browser, { where: "side", width: 440, height: 700, api: 112, hold: SITE });
  try {
    await chat.p.waitForSelector("[data-computer-card] .dgc-card-actions button");
    assert.deepEqual(await buttons(chat.p), [["Allow", true], ["Not now", false]]);
    assert.match(await chat.p.evaluate(() => (window.__pipsRoot || document).querySelector("[data-computer-card]").textContent),
      /use otherplace\.net in Your Browser\?/);
    assert.deepEqual(chat.errors, []);
  } finally { await chat.close(); }
});

test("a payment in Your Browser is reviewed and sent once or rejected: never always allowed", async (t) => {
  if (skipOrFail(t)) return;
  const chat = await openChat(browser, { where: "side", width: 440, height: 700, api: 112, hold: PAY });
  try {
    await chat.p.waitForSelector("[data-computer-card] .dgc-card-actions button");
    assert.deepEqual((await buttons(chat.p)).map((b) => b[0]), ["Review…", "Reject"]);
    assert.deepEqual(chat.errors, []);
  } finally { await chat.close(); }
});

test("what its tab in Your Browser waits for is never among its own computer's notifications", async (t) => {
  if (skipOrFail(t)) return;
  const mk = (letter, summary) => ({ id: "compact_" + letter.repeat(32), pip_id: PIP.id, workspace_id: "ws", run_id: "run_" + "b".repeat(32),
    summary: { method: "POST", host: "shop.example", path: "/order", page: "https://shop.example/cart", fields: [], more_fields: 0, body_bytes: 14, ...summary },
    digest: letter.repeat(64), frame: null, status: "pending", created_at: new Date(Date.now() - 20000).toISOString(), expires_at: "2099-11-13T09:00:00.000Z",
    resolved_at: null, resolved_by: null, continuation_run_id: null });
  const own = mk("c", {});
  const tab = await openComputer(browser, { width: 1100, height: 700, actions: [mk("a", SIGN_IN), mk("d", PAY), own] });
  try {
    await tab.p.waitForSelector("#pc-drawer .pc-card");
    const cards = await tab.p.evaluate(() => [...document.querySelectorAll("#pc-drawer .pc-card")].map((c) => c.dataset.card));
    assert.deepEqual(cards, [own.id], "only its own computer's submit");
    assert.deepEqual(tab.errors, []);
  } finally { await tab.close(); }
});
