// A Pip computer's tab: the screen gets the room (0.52, asked 12 Nov). A user: "the top section consumes too much space,
// making the actual computer screen small. Also when approval cards come on this screen, they take a lot of space above
// making computer screen small and shift down." The tab had a header row, then the screen's bar, then a panel (Files,
// Keyboard, Clipboard) and the held submits' cards, all above the screen and all pushing it down.
//
// Now: one slim bar (the Pip, the screen's tools, Full screen, Stop computer, and "…" for what a narrow tab cannot show),
// and everything else floats over the screen. The check here is the screen's own box: its top and height are the same
// with nothing open, with each panel open, with submits waiting, with their cards open, and after one is answered.
// (From the notification drawer, 12 Nov: what waits is a bell in the bar and cards in a drawer over the screen, where
// the "waiting" chip and its floating panel were; test/pip-computer-drawer*.test.mjs has the drawer itself.)
// Real Chromium, the real client and CSS, the real noVNC viewer on a fake RFB server (support/pip-computer-scene.mjs).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openComputer, PIP } from "./support/pip-computer-scene.mjs";
import { FILES, openFiles } from "./support/pip-computer-files-scene.mjs";

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

// A held submit as DGC says it (the shape pipComputerAction takes; test/pip-computer-tab.test.mjs has the same one).
const action = (letter, summary = {}) => ({ id: "compact_" + letter.repeat(32), pip_id: PIP.id, workspace_id: "ws", run_id: "run_" + "b".repeat(32),
  summary: { method: "POST", host: "shop.example", path: "/order", page: "https://shop.example/cart", fields: [], more_fields: 0, body_bytes: 14, ...summary },
  digest: letter.repeat(64), frame: null, status: "pending", created_at: "2026-11-12T09:00:00.000Z", expires_at: "2026-11-13T09:00:00.000Z", resolved_at: null, resolved_by: null, continuation_run_id: null });
const FORM = action("c"), PAY = action("d", { host: "pay.example", payment: true, fields: [{ name: "amount", value: "53.50" }] });
const SITE = action("e", { kind: "site", site: "news.example", shown: "news.example", method: "GET", host: "news.example", path: "/", page: "https://news.example/", body_bytes: 0 });
const TEXT = action("f", { kind: "text", host: "forum.example", text: "Dear team,\nthe figures are attached." });
const LOGIN = action("a", { kind: "login", site: "bank.example", shown: "bank.example", method: "GET", host: "bank.example", path: "/login", page: "https://bank.example/login", body_bytes: 0 });

// The window sizes asked for, and a narrow editor (a tab beside a wide side bar and two more groups).
const SIZES = [[1600, 1000], [900, 700], [420, 640]];
const PURPLE = /rgba?\((124, 92, 255|118, 84, 246|106, 75, 240|167, 139, 250)/;
const sent = (p, type) => p.evaluate((t) => window.__sent.filter((r) => r.type === t), type);
const posted = (p, type) => p.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
const room = (p) => p.evaluate(() => {
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const seen = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const bar = document.getElementById("pc-bar");
  return { view: [innerWidth, innerHeight], bar: box(bar), tier: bar?.dataset.tier, live: box(document.getElementById("pc-live")), canvas: box(document.querySelector("#pc-vnc canvas")),
    stage: box(document.getElementById("pc-stage")), above: [...document.getElementById("app").children].map((e) => e.id || e.className),
    parts: [...bar.querySelectorAll("button, h1, .pc-status, .pc-face, #pc-using")].filter(seen).filter((e) => e.getBoundingClientRect().width > 1.5 && !e.closest(".dgc-menu"))
      .map((e) => ({ id: e.id || e.className || e.tagName, ...box(e), ground: getComputedStyle(e).backgroundColor })),
    panel: box(document.querySelector("#pc-panel .pc-panel") ? document.getElementById("pc-panel") : null), wait: seen(document.getElementById("pc-drawer")) ? box(document.getElementById("pc-drawer")) : null,
    bell: seen(document.getElementById("pc-bell")) ? document.querySelector("#pc-bell .pc-bell-count").textContent : null, notes: box(document.querySelector("#pc-notes .pc-note")),
    scrolls: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1 };
});
const same = (now, was, what) => {
  for (const [name, a, b] of [["the screen's room", now.live, was.live], ["the screen", now.canvas, was.canvas]]) for (const side of ["top", "left", "width", "height"])
    assert.ok(Math.abs(a[side] - b[side]) < 0.5, `${what}: ${name} keeps its ${side} (${b[side]} before, ${a[side]} now)`);
  assert.equal(now.scrolls, false, `${what}: the page does not scroll`);
};
const inside = (a, b, what) => assert.ok(a && b && a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5, `${what}: ${JSON.stringify(a)} in ${JSON.stringify(b)}`);
const apart = (list, what) => { for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const a = list[i], b = list[j];
  if (a.id === "pc-fit" && b.id === "pc-actual") continue;   // they share one hairline
  assert.ok(!(a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5), `${what}: ${a.id} and ${b.id} overlap (${JSON.stringify(a)} ${JSON.stringify(b)})`); } };
// A tool in the bar, or the same thing in "…" when the tab is too narrow to show it.
const press = async (p, id) => {
  if (await p.isVisible(`#${id}`)) { await p.click(`#${id}`); return; }
  await p.click("#pc-more"); await p.click(`#pc-more-menu [data-more="${id.slice(3)}"]`);
};
const settled = (p) => p.waitForTimeout(120);

for (const [width, height] of SIZES) {
  test(`at ${width}x${height} the screen keeps its top and height: nothing open, each panel open, two submits waiting, their cards open, and one answered`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { width, height, api: 87, files: FILES });
    try {
      const idle = await room(x.p);
      // One slim bar, and the screen straight under it: nothing else is above the screen.
      assert.deepEqual(idle.above, ["pc-stage"], "the tab is the bar and the screen, nothing more");
      assert.ok(idle.bar.height <= 40 && idle.bar.height >= 30, `one slim bar, about 36 px: ${idle.bar.height}`);
      assert.ok(Math.abs(idle.bar.top) < 0.5 && Math.abs(idle.live.top - idle.bar.bottom) < 0.5, `the screen starts right under the bar: ${idle.live.top} vs ${idle.bar.bottom}`);
      assert.ok(Math.abs(idle.live.bottom - height) < 0.5 && Math.abs(idle.live.left) < 0.5 && Math.abs(idle.live.right - width) < 0.5, "and takes all the rest of the tab");
      assert.ok(idle.live.height >= height - 40, `the screen's room is the tab less the bar: ${idle.live.height} of ${height}`);
      for (const part of idle.parts) { inside(part, idle.bar, `${part.id} is inside the bar`); assert.doesNotMatch(part.ground, PURPLE, `${part.id} is not purple`); }
      apart(idle.parts, `the bar at ${width}px`);
      assert.ok(idle.parts.some((b) => b.id === "pc-full"), "Full screen is always in the bar");
      assert.equal(idle.scrolls, false);
      // Each panel floats over the screen.
      for (const [id, panel] of [["pc-files", "#pc-files-panel .pc-name"], ["pc-keys", "#pc-keys-panel"], ["pc-clip", "#pc-clip-panel"]]) {
        await press(x.p, id); await x.p.waitForSelector(panel); await settled(x.p);
        const open = await room(x.p);
        same(open, idle, `with ${id.slice(3)} open`);
        inside(open.panel, open.live, `the ${id.slice(3)} panel is over the screen, inside its room`);
        assert.ok(open.panel.height > 60, "and is really there");
        await x.p.click('#pc-panel [data-shut="panel"]'); await x.p.waitForFunction(() => !document.querySelector("#pc-panel .pc-panel"));
        same(await room(x.p), idle, `with ${id.slice(3)} closed again`);
      }
      // Two submits arrive: a bell in the bar, their cards in the drawer over the screen, and the screen does not move.
      await x.scene({ actions: [FORM, PAY] });
      await x.p.waitForSelector("#pc-bell", { timeout: 15000 }); await x.p.waitForSelector("#pc-drawer.pc-fan"); await settled(x.p);
      const cards = await room(x.p);
      same(cards, idle, "with two submits waiting, their cards open");
      assert.equal(cards.bell, "2");
      for (const part of cards.parts) inside(part, cards.bar, `${part.id} is inside the bar`);
      apart(cards.parts, `the bar with the bell at ${width}px`);
      inside(cards.wait, cards.live, "the cards are over the screen, inside its room");
      assert.equal(await x.p.locator("#pc-drawer .pc-hold").count(), 2);
      // The bell puts them away and brings them back.
      await x.p.click("#pc-bell"); await x.p.waitForSelector("#pc-drawer", { state: "hidden" }); await settled(x.p);
      const waiting = await room(x.p);
      same(waiting, idle, "with the cards collapsed into the bell"); assert.equal(waiting.wait, null); assert.equal(waiting.bell, "2");
      await x.p.click("#pc-bell"); await x.p.waitForSelector("#pc-drawer.pc-fan"); await settled(x.p);
      // One is answered: what the tab says floats too.
      await x.p.click(`#pc-drawer [data-send="${FORM.id}"]`);
      await x.p.waitForFunction(() => /Approved/.test(document.querySelector(".pc-notice")?.textContent || "")); await x.p.waitForFunction(() => document.querySelectorAll('#pc-drawer .pc-hold[data-state="waiting"]').length === 1); await settled(x.p);
      const answered = await room(x.p);
      same(answered, idle, "after one is answered");
      inside(answered.notes, answered.live, "what the tab says is over the screen");
      assert.equal(answered.bell, "1");
      await x.p.click('#pc-notes [data-dismiss="notice"]'); await x.p.waitForFunction(() => !document.querySelector(".pc-notice"));
      await x.p.click(`#pc-drawer [data-reject="${PAY.id}"]`);
      await x.p.waitForFunction(() => !document.getElementById("pc-bell") && !document.getElementById("pc-drawer"), null, { timeout: 8000 }); await settled(x.p);
      same(await room(x.p), idle, "with nothing waiting again");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the bell says how many wait and the first one's name; the drawer's cards answer as the old ones did: Send once, Always allow, Reject, and a payment without Always allow", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { width: 1600, height: 1000, actions: [FORM, PAY] });
  const cardsNow = () => x.p.evaluate(() => [...document.querySelectorAll("#pc-drawer .pc-hold")].map((c) => ({ title: c.querySelector(".pc-card-open").textContent, text: c.textContent, held: c.querySelector(".pc-held-text")?.textContent ?? null, buttons: [...c.querySelectorAll(".pc-card-actions button")].map((b) => b.textContent) })));
  try {
    await x.p.waitForSelector("#pc-bell");
    assert.equal(await x.p.textContent("#pc-bell .pc-bell-count"), "2");
    assert.equal(await x.p.getAttribute("#pc-bell", "aria-expanded"), "true", "the cards that arrived opened the drawer");
    assert.equal(await x.p.getAttribute("#pc-bell", "aria-label"), "2 waiting for you: Send a form to shop.example");
    assert.equal(await x.p.textContent(".pc-status"), "2 waiting for you", "the state still says it, for a screen reader");
    assert.ok((await x.p.evaluate(() => document.querySelector(".pc-status").getBoundingClientRect().width)) <= 1.5, "but the bell is the one in sight");
    const bell = await x.p.evaluate(() => { const c = document.getElementById("pc-bell"), s = getComputedStyle(c); return { shared: c.classList.contains("dgc-btn"), ground: s.backgroundColor, ink: s.color, height: c.getBoundingClientRect().height }; });
    assert.ok(bell.shared && !PURPLE.test(bell.ground) && !PURPLE.test(bell.ink), `the bell is the shared button, not purple: ${JSON.stringify(bell)}`);
    assert.ok(await x.p.isVisible("#pc-drawer"));
    const cards = await cardsNow();
    assert.deepEqual(cards.map((c) => [c.title, c.buttons]), [["Send a form to shop.example", ["Send once", "Always allow", "Reject"]], ["Pay on pay.example", ["Send once", "Reject"]]]);
    assert.match(cards[0].text, /Nothing has been sent\. Always allow covers POST \/order\./);
    assert.match(cards[1].text, /amount 53\.50/); assert.match(cards[1].text, /Sends payment card details\./);
    assert.equal(await x.p.textContent("#pc-drawer .pc-drawer-head h2"), "Waiting for you");
    // Always allow: the same command and digest as before.
    await x.p.click(`[data-always="${FORM.id}"]`);
    await x.p.waitForFunction(() => /Sent, and allowed from now on/.test(document.querySelector(".pc-notice")?.textContent || ""));
    assert.deepEqual(await sent(x.p, "always_allow_pip_computer_action"), [{ type: "always_allow_pip_computer_action", action_id: FORM.id, expected_digest: FORM.digest }]);
    await x.p.waitForFunction(() => document.querySelector("#pc-bell .pc-bell-count")?.textContent === "1");
    assert.equal(await x.p.getAttribute("#pc-bell", "aria-label"), "1 waiting for you: Pay on pay.example");
    assert.ok(await x.p.isVisible("#pc-drawer"), "the drawer stays open for the one that is left");
    // Send once on the payment.
    await x.p.click(`[data-send="${PAY.id}"]`);
    await x.p.waitForFunction(() => /Approved\. It is sent within a few seconds, exactly as shown\./.test(document.querySelector(".pc-notice")?.textContent || ""));
    assert.deepEqual(await sent(x.p, "decide_pip_computer_action"), [{ type: "decide_pip_computer_action", action_id: PAY.id, expected_digest: PAY.digest, approve: true }]);
    await x.p.waitForFunction(() => !document.getElementById("pc-bell") && !document.getElementById("pc-drawer"), null, { timeout: 8000 });
    assert.equal(await x.p.textContent(".pc-status"), "Idle");
    // Reject, on a new one: it opens the drawer by itself (it was the chip that had to be pressed).
    await x.scene({ actions: [FORM] });
    await x.p.waitForSelector("#pc-bell", { timeout: 15000 });
    assert.ok(await x.p.isVisible("#pc-drawer.pc-fan"), "a new one opens the drawer");
    await x.p.click(`[data-reject="${FORM.id}"]`);
    await x.p.waitForFunction(() => /Rejected\. Nothing was sent\./.test(document.querySelector(".pc-notice")?.textContent || ""));
    assert.deepEqual((await sent(x.p, "decide_pip_computer_action")).at(-1), { type: "decide_pip_computer_action", action_id: FORM.id, expected_digest: FORM.digest, approve: false });
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("careful mode and a login to save are cards in the drawer too: Allow this site, Allow once with the text, and a login's Not now only", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { width: 900, height: 700, actions: [SITE, TEXT, LOGIN] });
  try {
    await x.p.waitForSelector("#pc-bell");
    assert.equal(await x.p.textContent("#pc-bell .pc-bell-count"), "3");
    assert.equal(await x.p.getAttribute("#pc-bell", "aria-label"), "3 waiting for you: Let Mornings visit news.example?");
    const cards = await x.p.evaluate(() => [...document.querySelectorAll("#pc-drawer .pc-hold")].map((c) => ({ title: c.querySelector(".pc-card-open").textContent, text: c.textContent, held: c.querySelector(".pc-held-text")?.textContent ?? null, buttons: [...c.querySelectorAll(".pc-card-actions button")].map((b) => b.textContent) })));
    assert.deepEqual(cards.map((c) => [c.title, c.buttons]), [["Let Mornings visit news.example?", ["Allow this site", "Not now"]], ["Let Mornings put this on forum.example?", ["Allow once", "Not now"]],
      ["Save a login for bank.example so Mornings can sign in itself?", ["Not now"]]]);
    assert.equal(cards[1].held, "Dear team,\nthe figures are attached.", "the whole text it would put on the page (in the card's detail)");
    assert.match(cards[2].text, /Save it from the card in its chat\./);
    const box = await x.p.evaluate(() => { const f = document.getElementById("pc-drawer").getBoundingClientRect(), l = document.getElementById("pc-live").getBoundingClientRect();
      return { in: f.top >= l.top - 0.5 && f.bottom <= l.bottom + 0.5 && f.left >= l.left - 0.5 && f.right <= l.right + 0.5, buttons: [...document.querySelectorAll("#pc-drawer button")].every((b) => { const r = b.getBoundingClientRect(); return r.left >= f.left - 0.5 && r.right <= f.right + 0.5; }) }; });
    assert.ok(box.in && box.buttons, "three cards stay inside the screen's room, and their buttons inside the drawer");
    const waiting = (n) => x.p.waitForFunction((count) => document.querySelectorAll('#pc-drawer .pc-hold[data-state="waiting"]').length === count, n);
    await x.p.click(`[data-send="${SITE.id}"]`);
    await x.p.waitForFunction(() => /Allowed\. It opens the site and carries on\./.test(document.querySelector(".pc-notice")?.textContent || ""));
    assert.deepEqual(await sent(x.p, "decide_pip_computer_action"), [{ type: "decide_pip_computer_action", action_id: SITE.id, expected_digest: SITE.digest, approve: true }]);
    await waiting(2);
    await x.p.click(`[data-reject="${TEXT.id}"]`);
    await x.p.waitForFunction(() => /Not now\. It won’t do that\./.test(document.querySelector(".pc-notice")?.textContent || ""));
    await waiting(1);
    await x.p.click(`[data-reject="${LOGIN.id}"]`);
    await x.p.waitForFunction(() => !document.getElementById("pc-bell"));
    assert.deepEqual((await sent(x.p, "decide_pip_computer_action")).map((r) => [r.action_id, r.approve]), [[SITE.id, true], [TEXT.id, false], [LOGIN.id, false]]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// (A new submit pulsed the chip once, and never under reduced motion: the bell's wiggle and the card's spring are in
// test/pip-computer-drawer-browser.test.mjs, "the motion".)

test("a panel is a sheet from the bar, or sits at the right when the tab is wide; its close button and Escape put it away and give focus back", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, height] of SIZES) {
    const x = await openComputer(browser, { width, height, api: 87, files: FILES, actions: [FORM] });
    try {
      await x.p.waitForSelector("#pc-bell");
      await press(x.p, "pc-files"); await x.p.waitForSelector("#pc-files-panel .pc-name");
      const r = await room(x.p);
      if (width >= 900) { assert.ok(r.panel.right >= r.live.right - 12 && r.panel.left > r.live.width / 2 && r.panel.top > r.live.top, `at ${width}px it sits at the right: ${JSON.stringify(r.panel)}`); assert.ok(r.panel.width <= 400); }
      else { assert.ok(Math.abs(r.panel.top - r.bar.bottom) < 1 && r.panel.left <= 12 && r.panel.right >= width - 12, `at ${width}px it is a sheet from the bar: ${JSON.stringify(r.panel)}`); }
      assert.equal(await x.p.textContent("#pc-panel .pc-float-head strong"), "Files");
      assert.equal(await x.p.getAttribute('#pc-panel [data-shut="panel"]', "aria-label"), "Close");
      // Escape puts it away; focus goes back to what opened it.
      await x.p.focus("#pc-files-panel .pc-file");
      await x.p.keyboard.press("Escape");
      await x.p.waitForFunction(() => !document.querySelector("#pc-panel .pc-panel"));
      assert.equal(await x.p.evaluate(() => document.activeElement?.id), (await x.p.isVisible("#pc-files")) ? "pc-files" : "pc-more");
      // One thing has that corner at a time: the bell's drawer puts a panel away, and a panel the drawer (into the bell).
      await press(x.p, "pc-files"); await x.p.waitForSelector("#pc-files-panel");
      assert.ok(await x.p.isHidden("#pc-drawer")); assert.equal(await x.p.getAttribute("#pc-bell", "aria-expanded"), "false");
      await x.p.click("#pc-bell");
      assert.ok(await x.p.isVisible("#pc-drawer")); assert.equal(await x.p.$("#pc-panel .pc-panel"), null);
      await press(x.p, "pc-files"); await x.p.waitForSelector("#pc-files-panel");
      assert.ok(await x.p.isHidden("#pc-drawer"));
      await x.p.click("#pc-bell");
      // Escape closes the drawer too, and so does Collapse.
      await x.p.keyboard.press("Escape");
      assert.ok(await x.p.isHidden("#pc-drawer")); assert.equal(await x.p.evaluate(() => document.activeElement?.id), "pc-bell");
      await x.p.click("#pc-bell"); await x.p.click("#pc-drawer-collapse");
      assert.ok(await x.p.isHidden("#pc-drawer"));
      assert.equal((await sent(x.p, "decide_pip_computer_action")).length, 0, "closing answers nothing");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("wide, the bar shows every word; narrow, what has no room goes into the shared menu behind “…” and still works", async (t) => {
  if (skipOrFail(t)) return;
  const wide = await openComputer(browser, { width: 1600, height: 1000 });
  try {
    const r = await room(wide.p);
    assert.equal(r.tier, "0");
    assert.deepEqual(r.parts.map((b) => b.id), ["pc-face", "H1", "pc-status", "pc-fit", "pc-actual", "pc-size", "pc-keys", "pc-clip", "pc-files", "pc-full", "pc-stop"], "the Pip, the tools, then Full screen and Stop computer");
    assert.equal(await wide.p.textContent(".pc-title h1"), "Mornings · Computer"); assert.equal(await wide.p.textContent(".pc-status"), "Idle");
    assert.ok(await wide.p.evaluate(() => [...document.querySelectorAll("#pc-tools .pc-tool-label")].every((l) => l.getBoundingClientRect().width > 15)), "each tool's word shows");
    assert.ok(await wide.p.isHidden("#pc-more"), "no “…” when everything fits");
    assert.doesNotMatch(await wide.p.evaluate(() => getComputedStyle(document.querySelector(".pc-title h1")).color), PURPLE, "the name is plain text, not purple");
    const titles = r.parts.filter((b) => ["H1", "pc-status", "pc-fit", "pc-stop"].includes(b.id));
    assert.ok(Math.max(...titles.map((b) => b.top + b.height / 2)) - Math.min(...titles.map((b) => b.top + b.height / 2)) < 4, "name, state and buttons share one line");
    assert.deepEqual(wide.errors, []);
  } finally { await wide.close(); }
  const x = await openComputer(browser, { width: 300, height: 640 });
  try {
    const r = await room(x.p);
    assert.ok(r.bar.height <= 40, `still one row at 300 px: ${r.bar.height}`);
    for (const part of r.parts) inside(part, r.bar, `${part.id} is inside the bar`);
    apart(r.parts, "the bar at 300px");
    assert.ok(await x.p.isVisible("#pc-more") && await x.p.isVisible("#pc-full") && await x.p.isHidden("#pc-stop") && await x.p.isHidden("#pc-fit"));
    assert.equal(await x.p.getAttribute("#pc-more", "aria-expanded"), "false");
    await x.p.click("#pc-more");
    const menu = await x.p.evaluate(() => { const m = document.getElementById("pc-more-menu"), b = m.getBoundingClientRect(); return { shared: m.classList.contains("dgc-menu"), role: m.getAttribute("role"),
      rows: [...m.querySelectorAll(".dgc-menu-row")].map((e) => e.textContent), box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }, focus: document.activeElement?.dataset.more, expanded: document.getElementById("pc-more").getAttribute("aria-expanded") }; });
    assert.ok(menu.shared && menu.role === "menu" && menu.expanded === "true", "the shared menu");
    assert.deepEqual(menu.rows, ["Stop computer", "Fit the screen to this tab", "Real size (100%)"]);
    inside(menu.box, { left: 0, top: 0, right: 300, bottom: 640 }, "the menu is inside the tab"); assert.equal(menu.focus, "stop");
    // Escape closes it and nothing was pressed.
    await x.p.keyboard.press("Escape");
    assert.equal(await x.p.$("#pc-more-menu"), null); assert.equal(await x.p.evaluate(() => document.activeElement?.id), "pc-more");
    assert.equal((await sent(x.p, "stop_pip_computer")).length, 0);
    // A row is the bar's own button: 100% shows real pixels.
    await x.p.click("#pc-more"); await x.p.click('#pc-more-menu [data-more="actual"]');
    await x.p.waitForFunction(() => document.querySelector("#pc-vnc canvas").getBoundingClientRect().width === 1280);
    assert.equal(await x.p.$("#pc-more-menu"), null, "the menu closes");
    assert.equal(await x.p.getAttribute("#pc-actual", "aria-pressed"), "true");
    // And Stop computer stops it.
    await x.p.click("#pc-more"); await x.p.click('#pc-more-menu [data-more="stop"]');
    await x.p.waitForFunction(() => window.__sent.some((r) => r.type === "stop_pip_computer"));
    assert.deepEqual(await sent(x.p, "stop_pip_computer"), [{ type: "stop_pip_computer", pip_id: PIP.id }]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  // Narrower still: the other tools go in too, and each opens its panel from there.
  const tiny = await openComputer(browser, { width: 190, height: 640, api: 87, files: FILES });
  try {
    const r = await room(tiny.p);
    assert.ok(r.bar.height <= 40); for (const part of r.parts) inside(part, r.bar, `${part.id} is inside the bar`);
    await tiny.p.click("#pc-more");
    assert.deepEqual(await tiny.p.evaluate(() => [...document.querySelectorAll("#pc-more-menu .dgc-menu-row")].map((e) => e.textContent)), ["Stop computer", "Fit the screen to this tab", "Real size (100%)", "Screen size", "Keyboard", "Clipboard", "Files"]);
    await tiny.p.click('#pc-more-menu [data-more="files"]'); await tiny.p.waitForSelector("#pc-files-panel .pc-name");
    await tiny.p.click("#pc-more"); await tiny.p.click('#pc-more-menu [data-more="size"]'); await tiny.p.waitForSelector("#pc-size-menu .dgc-menu-row");
    const size = await tiny.p.evaluate(() => { const b = document.getElementById("pc-size-menu").getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; });
    inside(size, { left: 0, top: 0, right: 190, bottom: 640 }, "the size menu is inside the tab");
    assert.deepEqual(tiny.errors, []);
  } finally { await tiny.close(); }
});

test("the page tells its host each time Full screen goes on and off: the button, Escape, and the computer stopping", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { width: 900, height: 700 });
  try {
    // A VS Code webview's frame is refused the browser's full screen: the page fills its tab, and the host does the rest.
    await x.p.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new TypeError("Disallowed by permissions policy")); });
    const idle = await room(x.p);
    assert.deepEqual(await posted(x.p, "pipComputerFull"), []);
    await x.p.click("#pc-full"); await x.p.waitForFunction(() => document.body.classList.contains("pc-fill"));
    assert.deepEqual(await posted(x.p, "pipComputerFull"), [{ type: "pipComputerFull", on: true }]);
    same(await room(x.p), idle, "in the page's own full screen (the host gives it the window)");
    await x.p.click("#pc-full"); await x.p.waitForFunction(() => !document.body.classList.contains("pc-fill"));
    assert.deepEqual((await posted(x.p, "pipComputerFull")).map((m) => m.on), [true, false], "the button, both ways");
    // Escape: first it shuts an open panel and Full screen stays, then it leaves.
    await x.p.click("#pc-full"); await x.p.waitForFunction(() => document.body.classList.contains("pc-fill"));
    await x.p.click("#pc-keys"); await x.p.waitForSelector("#pc-keys-panel");
    await x.p.focus("#pc-keys-panel button"); await x.p.keyboard.press("Escape");
    await x.p.waitForFunction(() => !document.getElementById("pc-keys-panel"));
    assert.ok(await x.p.evaluate(() => document.body.classList.contains("pc-fill")), "the first Escape shut the panel only");
    assert.deepEqual((await posted(x.p, "pipComputerFull")).map((m) => m.on), [true, false, true]);
    await x.p.keyboard.press("Escape"); await x.p.waitForFunction(() => !document.body.classList.contains("pc-fill"));
    assert.deepEqual((await posted(x.p, "pipComputerFull")).map((m) => m.on), [true, false, true, false]);
    // The computer goes (its desktop is no longer there): Full screen ends, and the host hears.
    await x.p.click("#pc-full"); await x.p.waitForFunction(() => document.body.classList.contains("pc-fill"));
    await x.p.evaluate(() => window.postMessage({ type: "pipsConnection", generation: 8, apiVersion: 86, connected: false, supported: true, enabled: true }, "*"));
    await x.p.evaluate(() => window.postMessage({ type: "pipComputerInit", pip: { id: "pip_" + "c".repeat(32), name: "Mornings", pip_type: "core" }, desktop: false }, "*"));
    await x.p.waitForFunction(() => !document.body.classList.contains("pc-fill"));
    assert.deepEqual((await posted(x.p, "pipComputerFull")).map((m) => m.on), [true, false, true, false, true, false], "every way it ends is told, once each");
  } finally { await x.close(); }
});

test("a computer with no live screen has the same slim bar, and its desktop keeps its place while the cards are open", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [900, 300]) {
    const x = await openFiles(browser, { width, height: 640, actions: [FORM, PAY] });
    try {
      await x.p.waitForSelector("#pc-bell");
      const look = () => x.p.evaluate(() => { const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const float = document.getElementById("pc-drawer");
        return { bar: box(document.getElementById("pc-bar")), desk: box(document.querySelector(".pc-desktop")), float: float ? box(float) : null, bell: document.querySelector("#pc-bell .pc-bell-count").textContent,
          parts: [...document.querySelectorAll("#pc-bar button, #pc-bar h1")].filter((e) => e.getBoundingClientRect().width > 1.5).map((e) => ({ id: e.id || e.tagName, ...box(e) })),
          scrolls: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1 }; });
      // The cards that wait opened the drawer; the bell puts it away.
      const open = await look();
      inside(open.float, open.desk, "the cards are over the desktop"); assert.equal(open.scrolls, false);
      await x.p.click("#pc-bell");
      const shut = await look();
      assert.ok(shut.bar.height <= 40 && Math.abs(shut.desk.top - shut.bar.bottom) < 0.5, `one slim bar, the desktop right under it: ${JSON.stringify([shut.bar, shut.desk.top])}`);
      assert.equal(shut.bell, "2"); assert.equal(shut.float, null);
      for (const part of shut.parts) inside(part, shut.bar, `${part.id} is inside the bar`);
      apart(shut.parts, `the bar at ${width}px`);
      assert.deepEqual([open.desk.top, open.desk.height], [shut.desk.top, shut.desk.height], "the desktop does not move");
      await x.p.click("#pc-bell");
      await x.p.click(`[data-reject="${FORM.id}"]`);
      await x.p.waitForFunction(() => document.querySelectorAll('#pc-drawer .pc-hold[data-state="waiting"]').length === 1);
      assert.deepEqual(await x.sent("decide_pip_computer_action"), [{ type: "decide_pip_computer_action", action_id: FORM.id, expected_digest: FORM.digest, approve: false }]);
      await x.p.focus(`[data-card-open="${PAY.id}"]`); await x.p.keyboard.press("Escape");
      assert.ok(await x.p.isHidden("#pc-drawer"), "Escape closes the drawer");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});
