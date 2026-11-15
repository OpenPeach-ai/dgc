// A held request offers the same answers in the Pip's chat and in its computer's notifications (his call of 15 Nov; what
// it does: test/pip-held-answers.test.mjs). Here, in real Chromium: the two real pages side by side for each kind of
// request, button for button; and the notification's own dialog ("Save login…", "Review…") at 440 and 1100 px, dark and
// light: inside the page, in the shared button's shape, and DGC's own (nothing typed in it reaches the computer).
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

const action = (letter, summary = {}) => ({ id: "compact_" + letter.repeat(32), pip_id: PIP.id, workspace_id: "ws", run_id: "run_" + "b".repeat(32),
  summary: { method: "POST", host: "shop.example", path: "/order", page: "https://shop.example/cart", fields: [], more_fields: 0, body_bytes: 14, ...summary },
  digest: letter.repeat(64), frame: null, status: "pending", created_at: new Date(Date.now() - 20000).toISOString(), expires_at: "2099-11-13T09:00:00.000Z", resolved_at: null, resolved_by: null, continuation_run_id: null });
const KINDS = {
  "a login": { kind: "login", site: "cloudflare.com", shown: "dash.cloudflare.com", method: "GET", host: "dash.cloudflare.com", path: "/login", page: "https://dash.cloudflare.com/login", body_bytes: 0 },
  "a new site": { kind: "site", site: "news.example", shown: "news.example", method: "GET", host: "news.example", path: "/", page: "https://news.example/", body_bytes: 0 },
  "app data for a page": { kind: "text", host: "forum.example", text: "Dear team,\nthe figures are attached." },
  "a Terminal command": { kind: "floor", host: "terminal", floor: "could delete everything in its Files", fields: [{ name: "command", value: "rm -rf ~/Files" }] },
  "a form": { host: "shop.example" },
  "a payment": { host: "pay.example", payment: true, fields: [{ name: "billno", value: "INV-2026-1187" }, { name: "amount", value: "53.50" }] },
};
const WANT = { "a login": ["Save login…", "Not now"], "a new site": ["Allow this site", "Not now"], "app data for a page": ["Allow once", "Always allow", "Not now"],
  "a Terminal command": ["Allow once", "Always allow", "Not now"], "a form": ["Send once", "Always allow", "Reject"], "a payment": ["Review…", "Always allow", "Reject"] };
const LOGIN = action("a", KINDS["a login"]), PAY = action("d", KINDS["a payment"]);

for (const [what, summary] of Object.entries(KINDS)) test(`${what}: its notification in the computer view offers what its card in the chat offers, in the same order and words`, async (t) => {
  if (skipOrFail(t)) return;
  const chat = await openChat(browser, { where: "side", width: 440, height: 700, api: 97, hold: summary });
  const tab = await openComputer(browser, { width: 1100, height: 700, actions: [action("c", summary)] });
  try {
    const inChat = await chat.p.evaluate(() => [...(window.__pipsRoot || document).querySelectorAll("[data-computer-card] .dgc-card-actions button")].filter((b) => b.checkVisibility()).map((b) => [b.textContent, b.classList.contains("primary")]));
    await tab.p.waitForSelector("#pc-drawer .pc-card-actions button");
    const inTab = await tab.p.evaluate(() => [...document.querySelectorAll("#pc-drawer .pc-card-actions button")].filter((b) => b.checkVisibility()).map((b) => [b.textContent, b.classList.contains("solid")]));
    assert.deepEqual(inChat.map((b) => b[0]), WANT[what], "the chat's card");
    assert.deepEqual(inTab, inChat, "the notification: the same answers, the same order, the same solid one");
    assert.deepEqual([chat.errors, tab.errors], [[], []]);
  } finally { await chat.close(); await tab.close(); }
});

const dialog = (p) => p.evaluate(() => {
  const g = document.querySelector("#pc-dialog-root [role=dialog]"); if (!g) return null;
  const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 }; };
  const live = document.getElementById("pc-live") || document.querySelector(".pc-desktop");
  return { box: box(g), view: [innerWidth, innerHeight], radius: getComputedStyle(g).borderTopLeftRadius, ground: getComputedStyle(g).backgroundColor, cut: g.scrollWidth > g.clientWidth + 1,
    buttons: [...g.querySelectorAll("button")].map((b) => ({ text: b.textContent, ...box(b), radius: getComputedStyle(b).borderTopLeftRadius, clipped: b.scrollWidth > b.clientWidth + 1 })),
    boxes: [...g.querySelectorAll("input:not([type=checkbox])")].map((b) => ({ id: b.id, ...box(b), radius: getComputedStyle(b).borderTopLeftRadius })),
    focus: document.activeElement?.id || "", over: live ? document.elementFromPoint((live.getBoundingClientRect().left + live.getBoundingClientRect().right) / 2, live.getBoundingClientRect().bottom - 30)?.closest("#pc-dialog-root") !== null : null,
    scrolls: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1 };
});
const shape = (d, width, why) => {
  assert.ok(d.box.left >= 0 && d.box.right <= width + 0.5 && d.box.top >= 0 && d.box.bottom <= d.view[1] + 0.5, `${why}: the dialog is inside the page (${JSON.stringify(d.box)})`);
  assert.equal(d.scrolls, false, `${why}: the page does not scroll`); assert.equal(d.cut, false, `${why}: nothing in it runs off sideways`);
  assert.equal(d.over, true, `${why}: it is over the screen (a press there is the dialog's, never the computer's)`);
  for (const b of d.buttons) { assert.equal(b.radius, "6px", `${why}: “${b.text}” has the button corner, never a pill`); assert.equal(b.height, 28, `${why}: “${b.text}” is the standard height`);
    assert.equal(b.clipped, false, `${why}: “${b.text}” reads whole`); assert.ok(b.left >= d.box.left && b.right <= d.box.right, `${why}: “${b.text}” is inside the dialog`); }
  for (const i of d.boxes) { assert.equal(i.radius, "6px", `${why}: ${i.id} has the same corner`); assert.equal(i.height, 28, `${why}: ${i.id} is the button's height`); }
};

for (const theme of ["dark", "light"]) for (const width of [440, 1100]) {
  test(`Save login… on the notification opens the login's form over the screen, and saves it (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { width, height: 700, theme, actions: [LOGIN] });
    try {
      await x.p.waitForSelector(`[data-login="${LOGIN.id}"]`);
      const keysBefore = x.rfb().keys.length, pointersBefore = x.rfb().pointers;
      await x.p.click(`[data-login="${LOGIN.id}"]`); await x.p.waitForSelector("#pc-dialog-root [role=dialog]"); await x.p.waitForTimeout(250);
      const d = await dialog(x.p);
      shape(d, width, "the login's form");
      assert.deepEqual(d.buttons.map((b) => b.text), ["Cancel", "Save login"]);
      assert.equal(d.focus, "loginUser", "the keyboard is in its first box");
      await x.p.keyboard.type("arjun@mail.example"); await x.p.keyboard.press("Tab"); await x.p.keyboard.type("correct horse battery staple");
      assert.equal(await x.p.inputValue("#loginPassword"), "correct horse battery staple");
      await x.p.mouse.click(d.box.left + 8, d.box.top + 8);
      await x.p.waitForTimeout(150);
      assert.deepEqual([x.rfb().keys.length, x.rfb().pointers], [keysBefore, pointersBefore], "nothing typed or pressed in the dialog reached the computer");
      await x.p.click("#login-save");
      await x.p.waitForSelector(`.pc-card[data-card="${LOGIN.id}"] .pc-card-done`);
      assert.equal(await x.p.textContent(`.pc-card[data-card="${LOGIN.id}"] .pc-card-done`), "Saved");
      assert.equal(await x.p.locator("#pc-dialog-root").count(), 0, "the dialog is gone");
      const sent = (await x.p.evaluate(() => window.__sent)).filter((r) => r.type === "save_pip_login");
      assert.deepEqual(sent.map((r) => [r.action_id, r.expected_digest, r.username, r.pips, "site" in r]), [[LOGIN.id, LOGIN.digest, "arjun@mail.example", "only", false]]);
      assert.equal(await x.p.evaluate(() => document.documentElement.innerHTML.includes("correct horse battery staple")), false, "the password is nowhere in the page");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
  test(`Review… on a payment's notification shows what it sends before it is sent (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { width, height: 700, theme, actions: [PAY] });
    try {
      await x.p.waitForSelector(`[data-review="${PAY.id}"]`);
      await x.p.click(`[data-review="${PAY.id}"]`); await x.p.waitForSelector("#pc-dialog-root [role=dialog]"); await x.p.waitForTimeout(250);
      const d = await dialog(x.p);
      shape(d, width, "the payment's review");
      assert.deepEqual(d.buttons.map((b) => b.text), ["Reject", "Cancel", "Always allow", "Send once"]);
      if (width >= 700) assert.equal(new Set(d.buttons.map((b) => Math.round(b.top))).size, 1, "its four answers are on one row");
      assert.ok(d.buttons[0].left - d.box.left < 30 && d.box.right - d.buttons[3].right < 30, "Reject at the left, Send once at the right");
      await x.p.keyboard.press("Escape");
      assert.equal(await x.p.locator("#pc-dialog-root").count(), 0, "Escape closes it");
      assert.ok(await x.p.isVisible(`[data-review="${PAY.id}"]`), "and its card still waits");
      assert.equal((await x.p.evaluate(() => window.__sent)).filter((r) => /decide|always/.test(r.type)).length, 0, "nothing was answered");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
