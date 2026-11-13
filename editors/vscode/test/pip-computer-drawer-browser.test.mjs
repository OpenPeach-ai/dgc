// A Pip computer's notification drawer, in real Chromium (0.52, asked 12 Nov; test/pip-computer-drawer.test.mjs has what
// it does). Here: where it is and how big, at 1100, 700 and 300 px of tab; that the screen keeps its own size and place
// when it opens, folds, collapses and shows a banner; the folded stack (the newest in front, two peeking behind, each
// 10 px lower and 5% smaller); the motion (a card springs in, 460 ms; leaves to the right, 340 ms; the bell wiggles) and
// none of it under reduced motion; and that it is DGC's own page: a press, a scroll or a key on it never reaches the
// computer (the real noVNC viewer on a fake RFB server that counts what it is sent), and the screen's picture is the same
// with it open.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openComputer, PIP } from "./support/pip-computer-scene.mjs";
import { openFiles } from "./support/pip-computer-files-scene.mjs";

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

const action = (letter, summary = {}) => ({ id: "compact_" + letter.repeat(32), pip_id: PIP.id, workspace_id: "ws", run_id: "run_" + "b".repeat(32),
  summary: { method: "POST", host: "shop.example", path: "/order", page: "https://shop.example/cart", fields: [], more_fields: 0, body_bytes: 14, ...summary },
  digest: letter.repeat(64), frame: null, status: "pending", created_at: new Date(Date.now() - 20000).toISOString(), expires_at: "2099-11-13T09:00:00.000Z", resolved_at: null, resolved_by: null, continuation_run_id: null });
const FORM = action("c"), PAY = action("d", { host: "pay.example", payment: true, fields: [{ name: "amount", value: "53.50" }] });
const SITE = action("e", { kind: "site", site: "news.example", shown: "news.example", method: "GET", host: "news.example", path: "/", page: "https://news.example/", body_bytes: 0 });
const TEXT = action("f", { kind: "text", host: "forum.example", text: "Dear team,\nthe figures are attached." });
const LOGIN = action("a", { kind: "login", site: "bank.example", shown: "bank.example", method: "GET", host: "bank.example", path: "/login", page: "https://bank.example/login", body_bytes: 0 });

const PURPLE = /rgba?\((124, 92, 255|118, 84, 246|106, 75, 240|167, 139, 250)/;
const WIDTHS = [1100, 700, 300];
const look = (p) => p.evaluate(() => {
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const seen = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const drawer = document.getElementById("pc-drawer"), list = drawer?.querySelector(".pc-waiting"), bar = document.getElementById("pc-bar");
  return { view: [innerWidth, innerHeight], bar: box(bar), live: box(document.getElementById("pc-live") || document.querySelector(".pc-desktop")), canvas: box(document.querySelector("#pc-vnc canvas")),
    bell: seen(document.getElementById("pc-bell")) ? box(document.getElementById("pc-bell")) : null, full: box(document.getElementById("pc-full")),
    drawer: seen(drawer) ? box(drawer) : null, fan: !!drawer?.classList.contains("pc-fan"), banner: !!drawer?.classList.contains("pc-drawer-banner"),
    radius: drawer ? getComputedStyle(drawer).borderTopLeftRadius : null, ground: drawer ? getComputedStyle(drawer).backgroundColor : null,
    head: seen(drawer?.querySelector(".pc-drawer-head")) ? box(drawer.querySelector(".pc-drawer-head")) : null,
    list: list ? { ...box(list), scroll: list.scrollHeight, client: list.clientHeight, overflow: getComputedStyle(list).overflowY, mask: getComputedStyle(list).maskImage || getComputedStyle(list).webkitMaskImage } : null,
    cards: [...(drawer?.querySelectorAll(".pc-card") || [])].map((c) => ({ id: c.dataset.card, ...box(c), radius: getComputedStyle(c).borderTopLeftRadius, ground: getComputedStyle(c).backgroundColor,
      words: Number(getComputedStyle(c.querySelector(".pc-card-body")).opacity), opacity: Number(getComputedStyle(c).opacity), z: Number(getComputedStyle(c).zIndex) || 0 })),
    buttons: [...(drawer?.querySelectorAll("button") || [])].filter(seen).map((b) => ({ text: b.textContent, ...box(b), ground: getComputedStyle(b).backgroundColor, ink: getComputedStyle(b).color, radius: getComputedStyle(b).borderTopLeftRadius })),
    parts: [...bar.querySelectorAll("button, h1")].filter(seen).filter((e) => e.getBoundingClientRect().width > 1.5 && !e.closest(".dgc-menu")).map((e) => ({ id: e.id || e.tagName, ...box(e) })),
    scrolls: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1 };
});
const same = (now, was, what) => {
  for (const [name, a, b] of [["the screen's room", now.live, was.live], ["the screen", now.canvas, was.canvas]]) for (const side of ["top", "left", "width", "height"])
    assert.ok(Math.abs(a[side] - b[side]) < 0.5, `${what}: ${name} keeps its ${side} (${b[side]} before, ${a[side]} now)`);
  assert.equal(now.scrolls, false, `${what}: the page does not scroll`);
};
const inside = (a, b, what) => assert.ok(a && b && a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5, `${what}: ${JSON.stringify(a)} in ${JSON.stringify(b)}`);
const near = (a, b, what, by = 1) => assert.ok(Math.abs(a - b) <= by, `${what}: ${a} vs ${b}`);
const settled = (p) => p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running")).then(() => p.waitForTimeout(80));
const fanned = (p) => p.waitForSelector("#pc-drawer.pc-fan:not([hidden])", { timeout: 15000 });
// Away from the drawer: the foot of the screen, at the left.
const leave = async (p) => { const v = p.viewportSize(); await p.mouse.move(20, v.height - 20); await p.waitForSelector("#pc-drawer:not(.pc-fan)"); await settled(p); };

for (const width of WIDTHS) {
  test(`at ${width}px the drawer floats over the screen at its top right, the stack folds and fans, and the screen never moves or shrinks`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { width, height: 700 });
    try {
      const idle = await look(x.p);
      assert.equal(idle.bell, null, "no bell with nothing waiting"); assert.equal(idle.drawer, null);
      await x.scene({ actions: [PAY, TEXT, FORM] });
      await fanned(x.p); await settled(x.p);
      // Open: the drawer.
      const open = await look(x.p);
      same(open, idle, "with the drawer open");
      inside(open.drawer, open.live, "the drawer is over the screen, inside its room");
      near(open.drawer.width, Math.min(360, width - 16), "up to 360 px wide, or the tab's width less 16 px");
      near(open.drawer.right, open.live.right - 8, "at the right"); near(open.drawer.top, open.live.top + 8, "at the top");
      assert.ok(open.drawer.height <= open.live.height - 48 + 0.5, `no taller than the screen less 48 px: ${open.drawer.height} of ${open.live.height}`);
      assert.equal(open.radius, "28px"); assert.equal(open.cards.length, 3);
      assert.ok(open.head && open.head.height >= 28, "its header shows");
      for (const card of open.cards) { inside(card, open.drawer, `card ${card.id.slice(8, 9)} is inside the drawer`); assert.equal(card.radius, "16px"); assert.equal(card.words, 1); assert.doesNotMatch(card.ground, PURPLE); }
      for (let i = 1; i < open.cards.length; i++) near(open.cards[i].top - open.cards[i - 1].bottom, 8, "8 px between cards");
      for (const b of open.buttons) { inside(b, open.drawer, `“${b.text}” is inside the drawer`); assert.doesNotMatch(b.ground, PURPLE, `“${b.text}” is not purple`); assert.doesNotMatch(b.ink, PURPLE); }
      assert.doesNotMatch(open.ground, PURPLE);
      // The bell: in the bar, right before Full screen, nothing on top of anything.
      inside(open.bell, open.bar, "the bell is in the bar");
      const ids = open.parts.map((b) => b.id); assert.equal(ids.indexOf("pc-bell"), ids.indexOf("pc-full") - 1, `the bell is right before Full screen: ${ids.join()}`);
      for (const part of open.parts) inside(part, open.bar, `${part.id} is inside the bar`);
      for (let i = 0; i < open.parts.length; i++) for (let j = i + 1; j < open.parts.length; j++) { const a = open.parts[i], b = open.parts[j]; if (a.id === "pc-fit" && b.id === "pc-actual") continue;
        assert.ok(!(a.left < b.right - 0.5 && b.left < a.right - 0.5), `${a.id} and ${b.id} overlap in the bar at ${width}px`); }
      // Pointed at and left: it folds to the stack.
      const mid = { x: open.drawer.left + open.drawer.width / 2, y: open.drawer.top + 20 };
      await x.p.mouse.move(mid.x, mid.y); await leave(x.p);
      const stack = await look(x.p);
      same(stack, idle, "folded to the stack");
      assert.equal(stack.head, null, "the stack has no header");
      const [front, second, third] = stack.cards;
      near(front.right, stack.live.right - 16, "the stack is at the top right", 2); near(front.top, stack.live.top + 16, "under the bar", 2);
      near(front.width, Math.min(360, width - 16) - 16, "the front card is whole", 2);
      near(second.bottom - front.bottom, 10, "the second peeks 10 px lower"); near(third.bottom - front.bottom, 20, "the third 20 px lower");
      near(second.width / front.width, 0.95, "5% smaller", 0.006); near(third.width / front.width, 0.9, "10% smaller", 0.006);
      near((second.left + second.right) / 2, (front.left + front.right) / 2, "centred behind it");
      assert.deepEqual([front.words, second.words, third.words], [1, 0, 0], "only the front one is readable");
      assert.ok(front.z > second.z && second.z > third.z, "the newest is in front");
      assert.ok(stack.drawer.height <= front.height + 20 + 24, `the stack is one card tall and its peeks: ${stack.drawer.height} for a ${front.height} card`);
      inside(stack.drawer, stack.live, "the stack is inside the screen's room");
      // Pointing at the stack fans it out again; so does the keyboard reaching it.
      await x.p.mouse.move(front.left + 30, front.top + 20); await fanned(x.p); await settled(x.p);
      same(await look(x.p), idle, "fanned out again");
      await leave(x.p);
      await x.p.focus(`[data-card-open="${PAY.id}"]`); await fanned(x.p);
      await x.p.evaluate(() => document.activeElement.blur()); await x.p.waitForSelector("#pc-drawer:not(.pc-fan)");
      // Collapsed into the bell: nothing over the screen.
      await x.p.click("#pc-bell"); await x.p.waitForSelector("#pc-drawer", { state: "hidden" });
      const tucked = await look(x.p);
      same(tucked, idle, "collapsed into the bell"); assert.equal(tucked.drawer, null);
      assert.equal(await x.p.textContent("#pc-bell .pc-bell-count"), "3");
      // A fourth arrives while it is collapsed: a banner under the bell, alone, and the screen still has not moved.
      await x.scene({ actions: [SITE, PAY, TEXT, FORM] });
      await x.p.waitForSelector("#pc-drawer.pc-drawer-banner:not([hidden])", { timeout: 15000 }); await settled(x.p);
      const banner = await look(x.p);
      same(banner, idle, "with a banner");
      assert.deepEqual(banner.cards.map((c) => c.id), [SITE.id]); assert.equal(banner.head, null);
      inside(banner.drawer, banner.live, "the banner is inside the screen's room"); near(banner.drawer.right, banner.live.right - 8, "under the bell, at the right");
      assert.ok(banner.drawer.top - banner.bell.bottom < 24, "right under the bar");
      assert.equal(await x.p.textContent("#pc-bell .pc-bell-count"), "4");
      // Answered from the drawer: the quiet word, and the screen in its place.
      await x.p.click("#pc-bell"); await fanned(x.p);
      await x.p.click(`[data-send="${PAY.id}"]`); await x.p.waitForSelector(`.pc-card[data-card="${PAY.id}"] .pc-card-done`); await settled(x.p);
      const answered = await look(x.p);
      same(answered, idle, "with an answered card"); for (const b of answered.buttons) inside(b, answered.drawer, `“${b.text}” is inside the drawer`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("five cards in a short tab: the drawer stops 48 px short of the screen's height and its list scrolls, fading at the foot", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [700, 300]) {
    const x = await openComputer(browser, { width, height: 420, actions: [PAY, TEXT, FORM, SITE, LOGIN] });
    try {
      await fanned(x.p); await settled(x.p);
      const r = await look(x.p);
      near(r.drawer.height, r.live.height - 48, "as tall as the screen less 48 px", 1.5);
      inside(r.drawer, r.live, "inside the screen's room");
      assert.ok(r.list.scroll > r.list.client + 40 && r.list.overflow === "auto", `the list scrolls: ${JSON.stringify(r.list)}`);
      assert.match(r.list.mask, /linear-gradient/, "and fades out at its foot");
      inside(r.list, r.drawer, "the list is inside the drawer"); assert.equal(r.scrolls, false);
      // Its last card can be reached.
      await x.p.locator(`[data-reject="${LOGIN.id}"]`).scrollIntoViewIfNeeded();
      const b = await x.p.locator(`[data-reject="${LOGIN.id}"]`).boundingBox();
      assert.ok(b.y + b.height <= r.drawer.bottom + 0.5 && b.y >= r.drawer.top, "the last card's button scrolls into the drawer");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("the motion: a card springs in from above, an answered one leaves to the right, the bell wiggles; nothing moves under reduced motion", async (t) => {
  if (skipOrFail(t)) return;
  // Every animation the page starts, as it starts (a spring-in is over in half a second).
  const record = (p) => p.evaluate(() => { window.__moves = []; const real = Element.prototype.animate;
    Element.prototype.animate = function (frames, timing) { window.__moves.push({ id: timing?.id || "", on: this.id || this.className?.baseVal || String(this.className), duration: timing?.duration, easing: timing?.easing || "", first: frames[0], last: frames.at(-1) }); return real.call(this, frames, timing); }; });
  const moves = (p, id) => p.evaluate((name) => window.__moves.filter((m) => m.id === name), id);
  const moving = await openComputer(browser, { width: 900, height: 700, motion: "no-preference" });
  try {
    await record(moving.p);
    await moving.scene({ actions: [FORM] });
    await fanned(moving.p);
    const arrived = await moves(moving.p, "pc-card-in");
    assert.equal(arrived.length, 1, "one card, one spring");
    assert.deepEqual([arrived[0].duration, arrived[0].easing], [460, "cubic-bezier(0.2, 0.9, 0.25, 1.12)"]);
    assert.match(arrived[0].first.transform, /translateY\(-\d+px\) scale\(0\.9\d?\)/, "from above, a little smaller"); assert.equal(arrived[0].first.opacity, 0);
    assert.deepEqual((await moves(moving.p, "pc-bell-ring")).map((m) => m.duration), [720], "the bell wiggles once");
    // The same one, seen again at the next looks: nothing moves again.
    await moving.p.waitForFunction(() => window.__sent.filter((r) => r.type === "get_pip_computer").length >= 4, null, { timeout: 20000 });
    assert.equal((await moves(moving.p, "pc-card-in")).length, 1); assert.equal((await moves(moving.p, "pc-bell-ring")).length, 1);
    // Another arrives: it alone springs in, at the top.
    await moving.scene({ actions: [PAY, FORM] });
    await moving.p.waitForSelector(`.pc-card[data-card="${PAY.id}"]`, { timeout: 15000 });
    assert.equal((await moves(moving.p, "pc-card-in")).length, 2); assert.equal((await moves(moving.p, "pc-bell-ring")).length, 2);
    assert.equal(await moving.p.evaluate(() => document.querySelector("#pc-drawer .pc-card").dataset.card), PAY.id);
    // Folding and fanning: the cards move on the same spring.
    const card = await moving.p.evaluate(() => { const s = getComputedStyle(document.querySelector("#pc-drawer .pc-card:nth-child(2)")); return [s.transitionProperty, s.transitionDuration, s.transitionTimingFunction]; });
    assert.match(card[0], /transform/); assert.match(card[1], /0\.42s/); assert.match(card[2], /cubic-bezier\(0\.2, 0\.9, 0\.25, 1\.12\)/);
    // Answered: its moment, then it leaves sliding right, 340 ms.
    await moving.p.click(`[data-reject="${FORM.id}"]`);
    await moving.p.waitForSelector(`.pc-card[data-card="${FORM.id}"] .pc-card-done`);
    assert.equal((await moves(moving.p, "pc-card-out")).length, 0, "not yet");
    await moving.p.waitForFunction(() => window.__moves.some((m) => m.id === "pc-card-out"), null, { timeout: 5000 });
    const left = (await moves(moving.p, "pc-card-out"))[0];
    assert.deepEqual([left.duration, left.easing], [340, "cubic-bezier(0.4, 0, 0.2, 1)"]);
    assert.match(left.last.transform, /translateX\(18%\)/); assert.equal(left.last.opacity, 0);
    await moving.p.waitForFunction((id) => !document.querySelector(`.pc-card[data-card="${id}"]`), FORM.id, { timeout: 3000 });
    assert.deepEqual(moving.errors, []);
  } finally { await moving.close(); }
  const still = await openComputer(browser, { width: 900, height: 700, motion: "reduce" });
  try {
    await record(still.p);
    await still.scene({ actions: [PAY, FORM] });
    await fanned(still.p);
    await still.p.click(`[data-reject="${FORM.id}"]`);
    await still.p.waitForSelector(`.pc-card[data-card="${FORM.id}"] .pc-card-done`);
    await still.p.waitForFunction((id) => !document.querySelector(`.pc-card[data-card="${id}"]`), FORM.id, { timeout: 5000 });
    assert.deepEqual(await still.p.evaluate(() => window.__moves), [], "no animation when the user asked for less");
    const quiet = await still.p.evaluate(() => [...document.querySelectorAll("#pc-drawer, #pc-drawer .pc-card, #pc-drawer .pc-drawer-head, #pc-drawer .pc-waiting")].map((e) => getComputedStyle(e).transitionDuration));
    assert.ok(quiet.every((d) => d.split(", ").every((v) => parseFloat(v) === 0)), `and no transition: ${quiet.join(" | ")}`);
    assert.deepEqual(still.errors, []);
  } finally { await still.close(); }
});

test("a banner stays 6 seconds, then goes back into the bell; pointing at it holds it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { width: 900, height: 700, actions: [FORM] });
  try {
    await fanned(x.p);
    await x.p.click("#pc-drawer-collapse"); await x.p.waitForSelector("#pc-drawer", { state: "hidden" });
    assert.equal(await x.p.evaluate(() => document.activeElement?.id), "pc-bell", "Collapse hands the focus to the bell");
    await x.p.mouse.move(20, 680);
    await x.scene({ actions: [PAY, FORM] });
    await x.p.waitForSelector("#pc-drawer.pc-drawer-banner:not([hidden])", { timeout: 15000 });
    const at = Date.now();
    await x.p.waitForTimeout(4800);
    assert.ok(await x.p.isVisible(`.pc-card[data-card="${PAY.id}"]`), "still there near 5 s");
    await x.p.waitForSelector("#pc-drawer", { state: "hidden", timeout: 4000 });
    const took = Date.now() - at;
    assert.ok(took >= 5600 && took < 8200, `gone after about 6 s: ${took} ms`);
    assert.equal(await x.p.textContent("#pc-bell .pc-bell-count"), "2"); assert.equal(await x.p.getAttribute("#pc-bell", "aria-expanded"), "false");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the drawer is over the live screen, never in it: a press, a scroll or a key on it sends the computer nothing, and the screen's picture is the same", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { width: 1100, height: 700 });
  try {
    const picture = () => x.p.evaluate(() => document.querySelector("#pc-vnc canvas").toDataURL());
    // (Once the fake server's whole screen is drawn: its top left corner is red.)
    await x.p.waitForFunction(() => { const d = document.querySelector("#pc-vnc canvas").getContext("2d").getImageData(2, 2, 1, 1).data; return d[0] === 255 && d[1] === 0; });
    const before = await picture();
    const heard = () => ({ pointers: x.rfb().pointers, keys: x.rfb().keys.length });
    await x.scene({ actions: [PAY, TEXT, FORM] });
    await fanned(x.p); await settled(x.p);
    const r = await look(x.p);
    assert.ok(r.drawer.left > r.canvas.left && r.drawer.bottom < r.canvas.bottom && r.drawer.top >= r.canvas.top, "the drawer lies over the picture of the screen");
    assert.equal(await x.p.evaluate(() => !!document.getElementById("pc-drawer").closest("#pc-vnc") || !!document.querySelector("#pc-vnc .pc-card")), false, "beside the viewer in the page, not inside it");
    assert.equal(await picture(), before, "the screen's picture has nothing of the drawer in it");
    // The pointer comes straight onto the drawer (never across the screen), so what the computer hears is all the drawer's.
    const quiet = heard();
    // (Inside its rounded corners: outside their curve is the screen, and a press there is the screen's.)
    const points = [[r.drawer.left + 14, r.drawer.top + 14], [r.head.left + 80, r.head.top + r.head.height / 2], [r.cards[1].left + 20, r.cards[1].top + 30], [r.drawer.right - 14, r.drawer.bottom - 14], [r.list.left + 100, r.list.bottom - 6]];
    for (const [px, py] of points) { await x.p.mouse.move(px, py); await x.p.mouse.down(); await x.p.mouse.up(); await x.p.mouse.wheel(0, 240); }
    await x.p.mouse.move(r.cards[0].left + 60, r.cards[0].top + 12); await x.p.mouse.down(); await x.p.mouse.move(r.cards[0].left + 10, r.cards[0].top + 14, { steps: 4 }); await x.p.mouse.up();
    await x.p.focus(`[data-card-open="${TEXT.id}"]`);
    for (const key of ["a", "b", "ArrowDown", "Backspace", "Space"]) await x.p.keyboard.press(key);
    await x.p.waitForTimeout(300);
    assert.deepEqual(heard(), quiet, "the computer heard nothing");
    assert.equal(await picture(), before);
    assert.deepEqual(await x.p.evaluate(() => [...new Set(window.__sent.map((q) => q.type === "use_pip_computer_view" ? `${q.type}:${q.op}` : q.type))].sort()),
      ["get_pip_computer", "get_pip_computer_apps", "get_pip_computer_desktop", "use_pip_computer_view:pointer"], "and the page asked DGC only for its usual looks: no answer, nothing to do on the computer");
    assert.doesNotMatch(await x.p.evaluate(() => JSON.stringify(window.__sent) + JSON.stringify(window.__posted.filter((m) => m.type !== "pipDesktop"))), /Waiting for you|Pay on|Send a form/, "nothing it sends carries the drawer");
    // The same on the screen itself does reach the computer (so the check above could have failed).
    const spot = [r.canvas.left + 80, r.canvas.bottom - 80];
    await x.p.mouse.click(spot[0], spot[1]); await x.p.mouse.wheel(0, 240); await x.p.keyboard.press("a");
    await x.p.waitForFunction(() => true); await x.p.waitForTimeout(300);
    const loud = heard();
    assert.ok(loud.pointers > quiet.pointers && loud.keys > quiet.keys, `the screen itself is driven: ${JSON.stringify([quiet, loud])}`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("over the picture of its browser (a computer with no live screen): a press on the drawer is not a press on the page", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openFiles(browser, { width: 1100, height: 700, actions: [PAY, TEXT, FORM] });
  try {
    // A real picture, the size of its browser.
    const image = await x.p.evaluate(() => { const c = document.createElement("canvas"); c.width = 1280; c.height = 800; const g = c.getContext("2d"); g.fillStyle = "#e9edf3"; g.fillRect(0, 0, 1280, 800); return c.toDataURL("image/jpeg", 0.6); });
    await x.scene({ view: { ok: true, watching: false, url: "https://shop.example/", width: 1280, height: 800, image } });
    await x.p.click("[data-app=browser]");
    await x.p.waitForFunction(() => document.getElementById("pc-screen")?.naturalWidth === 1280);
    await x.p.click("#pc-bell"); await x.p.click("#pc-bell"); await fanned(x.p); await settled(x.p);
    const g = await x.p.evaluate(() => { const b = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      // (The picture as far as it shows: the part of it inside the screen's own box.)
      const d = document.getElementById("pc-drawer"), i = b(document.getElementById("pc-screen")), s = b(document.querySelector(".pc-screen"));
      return { drawer: b(d), img: { left: Math.max(i.left, s.left), top: Math.max(i.top, s.top), right: Math.min(i.right, s.right), bottom: Math.min(i.bottom, s.bottom) }, desk: b(document.querySelector(".pc-desktop")), inScreen: !!d.closest(".pc-screen, .pc-window") }; });
    assert.equal(g.inScreen, false);
    inside(g.drawer, g.desk, "the drawer floats over the desktop");
    const over = [Math.max(g.drawer.left, g.img.left) + 12, Math.min(g.drawer.bottom, g.img.bottom) - 12];
    assert.ok(over[0] > g.img.left && over[0] < g.img.right && over[1] > g.img.top && over[1] < g.drawer.bottom && over[0] < g.drawer.right, `a point on the drawer that is over the picture: ${JSON.stringify([over, g])}`);
    const drove = () => x.p.evaluate(() => window.__sent.filter((r) => r.type === "use_pip_computer_view" && ["click", "key", "type", "scroll"].includes(r.op)).map((r) => r.op));
    await x.p.mouse.click(over[0], over[1]); await x.p.mouse.wheel(0, 200);
    await x.p.focus(`[data-card-open="${TEXT.id}"]`); await x.p.keyboard.press("a"); await x.p.keyboard.press("ArrowDown");
    await x.p.waitForTimeout(500);
    assert.deepEqual(await drove(), [], "nothing done on the drawer drove its browser");
    // Off the drawer, on the picture: that does.
    await x.p.mouse.click(g.img.left + 40, g.img.bottom - 40);
    await x.p.waitForFunction(() => window.__sent.some((r) => r.type === "use_pip_computer_view" && r.op === "click"));
    assert.deepEqual(await drove(), ["click"]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("light and dark come from the editor's own colours: the panel is a frosted grey of the theme, the cards its ground, the first pill the text colour, and no purple fill", async (t) => {
  if (skipOrFail(t)) return;
  const seen = {};
  for (const theme of ["dark", "light"]) {
    const x = await openComputer(browser, { width: 900, height: 700, theme, actions: [PAY, FORM] });
    try {
      await fanned(x.p); await settled(x.p);
      const r = await look(x.p);
      const tone = (c) => { const m = c.match(/[\d.]+/g).map(Number); return (m[0] + m[1] + m[2]) / 3; };
      seen[theme] = { card: tone(r.cards[0].ground), solid: tone(r.buttons.find((b) => b.text === "Send once").ground), panel: r.ground };
      for (const b of r.buttons) { assert.doesNotMatch(b.ground, PURPLE, `${theme}: “${b.text}” is not purple`); assert.doesNotMatch(b.ink, PURPLE); }
      const pills = r.buttons.filter((b) => ["Send once", "Always allow", "Reject"].includes(b.text));
      // (They were pills until 13 Nov: one shape for every control, the button family's 6 px corner. test/one-shape-controls.test.mjs.)
      assert.ok(pills.length >= 5 && pills.every((b) => parseFloat(b.radius) === 6), `the answers have the button family's corner (${pills.map((b) => b.radius)})`);
      assert.match(r.panel ?? r.ground, /rgba|color\(/, `${theme}: the panel lets the screen through`);
      assert.match(await x.p.evaluate(() => { const s = getComputedStyle(document.getElementById("pc-drawer")); return s.backdropFilter || s.webkitBackdropFilter; }), /blur/, "frosted");
      const bell = await x.p.evaluate(() => { const s = getComputedStyle(document.querySelector("#pc-bell .pc-bell-count")); return [s.backgroundColor, s.color]; });
      assert.doesNotMatch(bell.join(), PURPLE, "the bell's count is not purple");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
  assert.ok(seen.dark.card < 80 && seen.light.card > 200, `the cards take the theme's ground: ${JSON.stringify(seen)}`);
  assert.ok(seen.dark.solid > 160 && seen.light.solid < 100, `the solid pill is the text colour: ${JSON.stringify(seen)}`);
});
