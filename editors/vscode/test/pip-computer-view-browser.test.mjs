// A Pip's computer fills its tab, and the screen has a bar of its own (pc-fills-tab, pc-fullscreen-viewer; 0.52), in real
// Chromium with the real client, its CSS and the real noVNC viewer on a fake RFB server (test/support/
// pip-computer-scene.mjs, fake-rfb-server.mjs), at a 700 px tab and a 300 px one.
//
// - Fit, the default: the screen is scaled to the tab with its shape kept, edge to edge (no editor gutter), and the band
//   left over is the page's own ground. It was letterboxed in a grey. 100% shows real pixels and scrolls.
// - Screen size: the sizes DGC offers, in the shared menu; picking one saves it and says "Restart its computer to use
//   it", with a Restart button (stop, then open again).
// - Full screen: the browser's own for the screen and its bar; when the editor refuses that, they fill the whole tab.
// - Keyboard: keys the editor would catch, sent as RFB KeyEvents, down then up.
// - Clipboard: "Paste in" sends ClientCutText and "Type it" sends the text as keys; "Copied there" shows the last
//   ServerCutText and Copy hands it to the host. Text only, at most 1 MB.
// - While a Pip run uses the computer the two panels are off.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
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
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const WIDTHS = [700, 300];
const GROUND = { dark: "rgb(31, 31, 31)", light: "rgb(255, 255, 255)" };
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const key = (keysym, down) => `040${down ? 1 : 0}0000${keysym.toString(16).padStart(8, "0")}`;
const press = (...syms) => [...syms.map((s) => key(s, true)), ...[...syms].reverse().map((s) => key(s, false))];
// Where things are, and what is painted behind the screen.
const layout = (p) => p.evaluate(() => {
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const canvas = document.querySelector("#pc-vnc canvas"), live = document.getElementById("pc-live"), screen = canvas?.parentElement;
  const paint = (e) => getComputedStyle(e).backgroundColor;
  return { view: [innerWidth, innerHeight], canvas: box(canvas), pixels: canvas ? [canvas.width, canvas.height] : null, live: box(live), stage: box(document.getElementById("pc-stage")),
    tools: box(document.getElementById("pc-tools")), panel: box(document.querySelector(".pc-panel")), header: box(document.querySelector(".pc-header")),
    ground: { body: paint(document.body), stage: paint(document.getElementById("pc-stage")), live: paint(live), image: getComputedStyle(live).backgroundImage, vnc: paint(document.getElementById("pc-vnc")), screen: screen ? paint(screen) : "" },
    scrolls: screen ? [screen.scrollWidth > screen.clientWidth + 1, screen.scrollHeight > screen.clientHeight + 1] : null,
    pageScrolls: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1,
    buttons: [...document.querySelectorAll("#pc-tools button, .pc-panel button, #pc-restart")].map((b) => ({ id: b.id || b.dataset.key, ...box(b), ground: paint(b) })) };
});
const inside = (b, view, name) => assert.ok(b.left >= -0.5 && b.right <= view[0] + 0.5 && b.top >= -0.5 && b.bottom <= view[1] + 0.5, `${name} is inside the tab: ${JSON.stringify(b)} in ${view}`);
const apart = (list, name) => { for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const a = list[i], b = list[j];
  assert.ok(!(a.left < b.right - 1.5 && b.left < a.right - 1.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5), `${name}: ${a.id} and ${b.id} overlap`); } };   // (Fit and 100% share one hairline)
const PURPLE = /rgba?\((124, 92, 255|118, 84, 246|106, 75, 240|167, 139, 250)/;
const sent = (p, type) => p.evaluate((t) => window.__sent.filter((r) => r.type === t), type);
const posted = (p, type) => p.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
const text = (p, selector) => p.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);

for (const width of WIDTHS) {
  test(`Fit is the default at ${width}px: the screen fills the tab with its shape kept, and the band left is the page's own ground`, async (t) => {
    if (skipOrFail(t)) return;
    for (const theme of ["dark", "light"]) {
      const x = await openComputer(browser, { width, theme });
      try {
        const l = await layout(x.p);
        assert.deepEqual(l.pixels, [1280, 800], "the viewer drew the computer's screen");
        assert.equal(await x.p.getAttribute("#pc-fit", "aria-pressed"), "true", "Fit is chosen");
        assert.equal(await x.p.getAttribute("#pc-actual", "aria-pressed"), "false");
        // Edge to edge: the editor's 20 px gutter is not a band beside the screen.
        assert.ok(Math.abs(l.live.left) < 0.5 && Math.abs(l.live.right - width) < 0.5, `the screen's room runs edge to edge: ${l.live.left}..${l.live.right}`);
        assert.ok(Math.abs(l.live.bottom - l.view[1]) < 0.5, "and down to the foot of the tab");
        assert.ok(Math.abs(l.canvas.width / l.canvas.height - 1.6) < 0.01, `its shape is kept: ${l.canvas.width} by ${l.canvas.height}`);
        const fills = Math.abs(l.canvas.width - l.live.width) < 1.5 || Math.abs(l.canvas.height - l.live.height) < 1.5;
        assert.ok(fills, `it is as large as its room allows: ${l.canvas.width}x${l.canvas.height} in ${l.live.width}x${l.live.height}`);
        assert.ok(l.canvas.left >= l.live.left - 0.5 && l.canvas.right <= l.live.right + 0.5 && l.canvas.top >= l.live.top - 0.5 && l.canvas.bottom <= l.live.bottom + 0.5, "and wholly inside it");
        assert.deepEqual(l.scrolls, [false, false], "nothing to scroll");
        // The band: the page's own ground, in either theme, and no picture or grey over it.
        assert.equal(l.ground.body, GROUND[theme]);
        assert.equal(l.ground.live, GROUND[theme], `${theme}: the band is the page's ground`);
        assert.equal(l.ground.stage, GROUND[theme]);
        assert.equal(l.ground.image, "none", "no wallpaper behind the real screen");
        assert.equal(l.ground.vnc, "rgba(0, 0, 0, 0)"); assert.equal(l.ground.screen, "rgba(0, 0, 0, 0)", "the viewer paints no ground of its own");
        assert.equal(l.pageScrolls, false, "the page itself does not scroll");
        inside(l.tools, l.view, "the bar");
        for (const b of l.buttons) { inside(b, l.view, b.id); assert.ok(b.height >= 22 && b.width >= 22, `${b.id} is large enough to press`); assert.doesNotMatch(b.ground, PURPLE, `${b.id} is not purple`); }
        apart(l.buttons, `the bar at ${width}px`);
        assert.deepEqual(l.buttons.map((b) => b.id), ["pc-fit", "pc-actual", "pc-size", "pc-keys", "pc-clip", "pc-full"]);
        assert.deepEqual(await x.p.evaluate(() => [...document.querySelectorAll("#pc-tools button")].map((b) => b.getAttribute("aria-label") || b.textContent)), ["Fit", "100%", "Screen size", "Keyboard", "Clipboard", "Full screen"]);
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });

  test(`100% at ${width}px shows real pixels and scrolls; Fit brings it back`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { width });
    try {
      await x.p.click("#pc-actual");
      await x.p.waitForFunction(() => document.querySelector("#pc-vnc canvas").getBoundingClientRect().width === 1280);
      const l = await layout(x.p);
      assert.equal(await x.p.getAttribute("#pc-actual", "aria-pressed"), "true");
      assert.deepEqual([l.canvas.width, l.canvas.height], [1280, 800], "one screen pixel is one pixel here");
      assert.deepEqual(l.scrolls, [true, true], "the rest is reached by scrolling the screen's room");
      assert.equal(l.pageScrolls, false, "not the page");
      assert.ok(Math.abs(l.canvas.left - l.live.left) < 0.5 && Math.abs(l.canvas.top - l.live.top) < 0.5, "it starts at the top left corner");
      // Scrolled to the end, the far corner shows.
      await x.p.evaluate(() => { const s = document.querySelector("#pc-vnc canvas").parentElement; s.scrollTo(s.scrollWidth, s.scrollHeight); });
      const end = await layout(x.p);
      assert.ok(end.canvas.right <= end.live.right + 0.5 && end.canvas.right >= end.live.right - 16, `the right edge is reachable: ${end.canvas.right} in ${end.live.right}`);
      assert.equal(await x.p.evaluate(() => window.__state?.fit), false, "the choice is kept for this tab");
      await x.p.click("#pc-fit");
      await x.p.waitForFunction(() => document.querySelector("#pc-vnc canvas").getBoundingClientRect().width < 1280);
      const back = await layout(x.p);
      assert.deepEqual(back.scrolls, [false, false]);
      assert.ok(Math.abs(back.canvas.width / back.canvas.height - 1.6) < 0.01);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Screen size at ${width}px: the sizes on offer, "Restart its computer to use it", and Restart opens it at the new size`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { width });
    try {
      assert.equal(await x.p.$("#pc-size-menu"), null, "closed until asked for");
      assert.equal(await x.p.$("#pc-restart-note"), null);
      await x.p.click("#pc-size");
      await x.p.waitForSelector("#pc-size-menu .dgc-menu-row");
      const menu = await x.p.evaluate(() => { const m = document.getElementById("pc-size-menu"), b = document.getElementById("pc-size"), r = (e) => { const v = e.getBoundingClientRect(); return { left: v.left, top: v.top, right: v.right, bottom: v.bottom, width: v.width, height: v.height }; };
        return { box: r(m), button: r(b), classes: m.className, role: m.getAttribute("role"), head: m.querySelector(".dgc-menu-head").textContent, focus: document.activeElement?.dataset.size,
          rows: [...m.querySelectorAll(".dgc-menu-row")].map((e) => [e.querySelector(".dgc-menu-label").textContent, e.getAttribute("aria-checked"), e.getAttribute("role"), r(e).height]), expanded: b.getAttribute("aria-expanded"), view: [innerWidth, innerHeight] }; });
      assert.match(menu.classes, /\bdgc-menu\b/, "the shared menu");
      assert.equal(menu.role, "menu"); assert.equal(menu.head, "Screen size"); assert.equal(menu.expanded, "true");
      assert.deepEqual(menu.rows.map((r) => r.slice(0, 3)), [["1280 × 800", "true", "menuitemradio"], ["1440 × 900", "false", "menuitemradio"], ["1920 × 1080", "false", "menuitemradio"]]);
      assert.ok(menu.rows.every((r) => r[3] >= 28), "rows are tall enough to press");
      assert.equal(menu.focus, "1280x800", "focus lands on the size it has");
      inside(menu.box, menu.view, "the menu");
      assert.ok(menu.box.top >= menu.button.bottom && menu.box.top <= menu.button.bottom + 10, `right under its button: ${menu.box.top} vs ${menu.button.bottom}`);
      if (width === 700) assert.ok(Math.abs(menu.box.left - menu.button.left) < 1.5, "and in line with it");
      // The keys: Down moves, Escape closes and gives focus back to the button; nothing is sent.
      await x.p.keyboard.press("ArrowDown");
      assert.equal(await x.p.evaluate(() => document.activeElement?.dataset.size), "1440x900");
      await x.p.keyboard.press("Escape");
      await x.p.waitForFunction(() => !document.getElementById("pc-size-menu"));
      assert.equal(await x.p.evaluate(() => document.activeElement?.id), "pc-size");
      assert.deepEqual(await sent(x.p, "set_pip_computer_screen"), []);
      // Pick one: it is saved, and the bar says what to do for it to take.
      await x.p.click("#pc-size");
      await x.p.click('#pc-size-menu [data-size="1440x900"]');
      await x.p.waitForSelector("#pc-restart-note");
      assert.deepEqual(await sent(x.p, "set_pip_computer_screen"), [{ type: "set_pip_computer_screen", pip_id: PIP.id, size: "1440x900" }]);
      assert.equal(await x.p.$("#pc-size-menu"), null, "the menu closes");
      assert.equal(await text(x.p, "#pc-restart-note span"), "Its screen is set to 1440 × 900. Restart its computer to use it.");
      assert.equal(await text(x.p, "#pc-restart"), "Restart");
      const l = await layout(x.p);
      const note = await x.p.evaluate(() => { const r = document.getElementById("pc-restart-note").getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
      inside(note, l.view, "the note"); inside(l.buttons.find((b) => b.id === "pc-restart"), l.view, "Restart");
      assert.equal(l.pageScrolls, false);
      assert.deepEqual(l.pixels, [1280, 800], "the screen on show is still the old size");
      assert.ok(l.live.height >= 150, "and still has room");
      await x.p.click("#pc-size");
      assert.equal(await x.p.getAttribute('#pc-size-menu [data-size="1440x900"]', "aria-checked"), "true", "the menu shows the size chosen");
      await x.p.keyboard.press("Escape");
      // Restart: stop, then open again. The screen comes back at the new size and the note goes.
      await x.p.click("#pc-restart");
      await x.p.waitForFunction(() => document.querySelector("#pc-vnc canvas")?.width === 1440, null, { timeout: 15000 });
      assert.equal((await sent(x.p, "stop_pip_computer")).length, 1);
      assert.deepEqual((await posted(x.p, "pipDesktop")).filter((m) => m.op === "open").length, 2, "opened again, once");
      await x.p.waitForFunction(() => !document.getElementById("pc-restart-note"));
      const now = await layout(x.p);
      assert.deepEqual(now.pixels, [1440, 900]);
      assert.ok(Math.abs(now.canvas.width / now.canvas.height - 1.6) < 0.01, "fitted, as before");
      assert.equal(x.servers.length, 2);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Full screen at ${width}px: the screen and its bar take the whole display, and leave it again`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { width });
    try {
      assert.equal(await x.p.getAttribute("#pc-full", "aria-label"), "Full screen");
      await x.p.click("#pc-full");
      await x.p.waitForFunction(() => document.fullscreenElement?.id === "pc-stage");
      await x.p.waitForFunction(() => document.getElementById("pc-full").getAttribute("aria-label") === "Leave full screen");
      await x.p.waitForTimeout(150);
      const l = await layout(x.p);
      assert.ok(Math.abs(l.stage.left) < 0.5 && Math.abs(l.stage.top) < 0.5 && Math.abs(l.stage.width - l.view[0]) < 0.5 && Math.abs(l.stage.height - l.view[1]) < 0.5, `the stage is the whole display: ${JSON.stringify(l.stage)} in ${l.view}`);
      assert.ok(l.tools.top < 1 && l.tools.height >= 22, "its bar stays at the top, for the keyboard panel and the way out");
      assert.ok(Math.abs(l.canvas.width / l.canvas.height - 1.6) < 0.01, "the screen keeps its shape");
      assert.ok(Math.abs(l.canvas.width - l.live.width) < 1.5 || Math.abs(l.canvas.height - l.live.height) < 1.5, "and fills what is left");
      assert.equal(l.ground.stage, GROUND.dark, "the band is still the page's ground");
      for (const b of l.buttons) inside(b, l.view, b.id);
      // The keyboard panel works in full screen: its Esc is a key for the computer, and does not leave.
      await x.p.click("#pc-keys");
      await x.p.click('[data-key="esc"]');
      await x.p.waitForTimeout(100);
      assert.deepEqual(x.rfb().keys.map((k) => hex(k.bytes)), press(0xff1b));
      assert.equal(await x.p.evaluate(() => document.fullscreenElement?.id), "pc-stage", "still full screen");
      await x.p.click("#pc-full");
      await x.p.waitForFunction(() => !document.fullscreenElement);
      await x.p.waitForFunction(() => document.getElementById("pc-full").getAttribute("aria-label") === "Full screen");
      const back = await layout(x.p);
      assert.ok(back.header && back.stage.top >= back.header.bottom - 0.5, "the header is back above it");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`where the editor refuses full screen, at ${width}px the screen and its bar fill the whole tab, and Escape leaves`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { width });
    try {
      // A VS Code webview's frame is not allowed the browser's full screen: the request is refused.
      await x.p.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new TypeError("Disallowed by permissions policy")); });
      const before = await layout(x.p);
      assert.ok(before.stage.top > 40, "the header is above the screen to begin with");
      await x.p.click("#pc-full");
      await x.p.waitForFunction(() => document.body.classList.contains("pc-fill"));
      await x.p.waitForTimeout(150);
      const l = await layout(x.p);
      assert.equal(await x.p.getAttribute("#pc-full", "aria-label"), "Leave full screen");
      assert.ok(Math.abs(l.stage.left) < 0.5 && Math.abs(l.stage.top) < 0.5 && Math.abs(l.stage.width - l.view[0]) < 0.5 && Math.abs(l.stage.height - l.view[1]) < 0.5, `the stage is the whole tab: ${JSON.stringify(l.stage)}`);
      assert.equal(await x.p.evaluate(() => { const e = document.elementFromPoint(40, 12); return !!e?.closest("#pc-stage"); }), true, "it covers the header");
      assert.ok(l.live.height > before.live.height + 40, "the screen has more room");
      assert.ok(Math.abs(l.canvas.width / l.canvas.height - 1.6) < 0.01);
      assert.equal(l.pageScrolls, false);
      await x.p.keyboard.press("Escape");
      await x.p.waitForFunction(() => !document.body.classList.contains("pc-fill"));
      assert.equal(await x.p.getAttribute("#pc-full", "aria-label"), "Full screen");
      assert.equal(await x.p.evaluate(() => document.activeElement?.id), "pc-full", "focus stays on the button");
      const back = await layout(x.p);
      assert.ok(Math.abs(back.stage.top - before.stage.top) < 0.5, "as it was");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`the keyboard panel at ${width}px: every key the editor would catch, sent as RFB KeyEvents, down then up`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { width });
    try {
      assert.equal(await x.p.$(".pc-panel"), null, "closed until asked for");
      assert.equal(await x.p.getAttribute("#pc-keys", "aria-expanded"), "false");
      await x.p.click("#pc-keys");
      await x.p.waitForSelector("#pc-keys-panel");
      assert.equal(await x.p.getAttribute("#pc-keys", "aria-expanded"), "true");
      const names = await x.p.evaluate(() => [...document.querySelectorAll("#pc-keys-panel button")].map((b) => b.textContent));
      assert.deepEqual(names, ["Esc", "Tab", "Ctrl+Alt+Del", "Ctrl+W", "Ctrl+T", "Ctrl+L", "Alt+Tab", "Super", ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
      await x.p.waitForTimeout(150);
      const l = await layout(x.p);
      inside(l.panel, l.view, "the panel");
      const keys = l.buttons.filter((b) => !String(b.id).startsWith("pc-"));
      assert.equal(keys.length, 20);
      for (const b of keys) { inside(b, l.view, b.id); assert.ok(b.height >= 22 && b.width >= 30, `${b.id} is large enough to press`); assert.doesNotMatch(b.ground, PURPLE);
        assert.ok(b.top >= l.panel.top - 0.5 && b.bottom <= l.panel.bottom + 0.5, `${b.id} is inside the panel, not cut off`); }
      apart(keys, `the keys at ${width}px`);
      assert.equal(await x.p.evaluate(() => [...document.querySelectorAll("#pc-keys-panel button")].every((b) => b.scrollWidth <= b.clientWidth + 1)), true, "no key's name is cut short");
      assert.equal(l.pageScrolls, false);
      assert.ok(l.live.height >= 120, `the screen keeps room under the panel: ${l.live.height}`);
      assert.ok(Math.abs(l.canvas.width / l.canvas.height - 1.6) < 0.01, "and is fitted to it");
      assert.ok(l.canvas.top >= l.panel.bottom - 0.5, "below the panel, not under it");
      // Each key: the exact bytes, in order. KeyEvent is 04, down or up, two spare bytes, the keysym.
      const CTRL = 0xffe3, ALT = 0xffe9, TAB = 0xff09;
      const want = { esc: press(0xff1b), tab: press(TAB), "ctrl-alt-del": press(CTRL, ALT, 0xffff), "ctrl-w": press(CTRL, 0x77), "ctrl-t": press(CTRL, 0x74), "ctrl-l": press(CTRL, 0x6c),
        "alt-tab": press(ALT, TAB), super: press(0xffeb), ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, press(0xffbe + i)])) };
      assert.deepEqual(want["ctrl-alt-del"], ["04010000" + "0000ffe3", "04010000" + "0000ffe9", "04010000" + "0000ffff", "04000000" + "0000ffff", "04000000" + "0000ffe9", "04000000" + "0000ffe3"]);
      assert.equal(Object.keys(want).length, 20);
      for (const [id, bytes] of Object.entries(want)) {
        const from = x.rfb().keys.length;
        await x.p.click(`[data-key="${id}"]`);
        for (let i = 0; i < 40 && x.rfb().keys.length < from + bytes.length; i++) await x.p.waitForTimeout(10);
        assert.deepEqual(x.rfb().keys.slice(from).map((k) => hex(k.bytes)), bytes, id);
      }
      assert.equal(x.rfb().cuts.length, 0);
      // Pressed again, the bar's button puts the panel away.
      await x.p.click("#pc-keys");
      await x.p.waitForFunction(() => !document.querySelector(".pc-panel"));
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`the clipboard panel at ${width}px: Paste in sends ClientCutText, Type it sends keys, Copied there shows ServerCutText and Copy goes through the host`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { width });
    try {
      await x.p.click("#pc-clip");
      await x.p.waitForSelector("#pc-clip-panel");
      assert.deepEqual(await x.p.evaluate(() => [...document.querySelectorAll("#pc-clip-panel .pc-clip-head")].map((e) => e.textContent)), ["Paste in", "Copied there"]);
      assert.deepEqual(await x.p.evaluate(() => [...document.querySelectorAll("#pc-clip-panel button")].map((b) => [b.textContent, b.disabled])), [["Paste in", false], ["Type it", false], ["Copy", true]]);
      assert.match(await text(x.p, "#pc-there"), /Nothing copied there yet/);
      await x.p.waitForTimeout(150);
      const l = await layout(x.p);
      inside(l.panel, l.view, "the panel");
      const mine = l.buttons.filter((b) => ["pc-paste", "pc-type", "pc-copy"].includes(b.id));
      for (const b of mine) { inside(b, l.view, b.id); assert.ok(b.top >= l.panel.top - 0.5 && b.bottom <= l.panel.bottom + 0.5, `${b.id} is inside the panel, not cut off`); }
      apart(mine, "the panel's buttons");
      const fields = await x.p.evaluate(() => [...document.querySelectorAll("#pc-paste-text, #pc-there")].map((e) => { const r = e.getBoundingClientRect(); return { id: e.id, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width }; }));
      for (const f of fields) { inside(f, l.view, f.id); assert.ok(f.width >= 200, `${f.id} is wide enough to read: ${f.width}`); }
      assert.equal(l.pageScrolls, false);
      assert.ok(l.live.height >= 120, `the screen keeps room under the panel: ${l.live.height}`);
      assert.ok(l.canvas.top >= l.panel.bottom - 0.5);
      assert.equal(mine.filter((b) => !/rgba\(0, 0, 0, 0\)/.test(b.ground)).length, 1, "one filled button");
      for (const b of mine) assert.doesNotMatch(b.ground, PURPLE);

      // Paste in: ClientCutText is 06, three spare bytes, the length, the text.
      await x.p.fill("#pc-paste-text", "Hello, Pip");
      await x.p.click("#pc-paste");
      for (let i = 0; i < 60 && !x.rfb().cuts.length; i++) await x.p.waitForTimeout(10);
      assert.deepEqual(x.rfb().cuts.map((c) => hex(c.bytes)), ["06000000" + "0000000a" + Buffer.from("Hello, Pip").toString("hex")]);
      assert.equal(x.rfb().keys.length, 0, "no keys: it is on its clipboard, for its own Ctrl+V");
      assert.equal(await text(x.p, "#pc-clip-note"), "On its clipboard. Press Ctrl+V there to paste it.");
      assert.equal(await x.p.inputValue("#pc-paste-text"), "Hello, Pip", "the text stays in the box");
      // Type it: the same text as keys, each down then up; a new line is Return.
      await x.p.fill("#pc-paste-text", "Hi\nπ");
      await x.p.click("#pc-type");
      await x.p.waitForFunction(() => document.getElementById("pc-clip-note").textContent === "Typed.");
      for (let i = 0; i < 60 && x.rfb().keys.length < 8; i++) await x.p.waitForTimeout(10);
      assert.deepEqual(x.rfb().keys.map((k) => hex(k.bytes)), [...press(0x48), ...press(0x69), ...press(0xff0d), ...press(0x010003c0)]);
      assert.equal(x.rfb().cuts.length, 1, "typing sends no clipboard");

      // Copied there: the computer's own copy arrives as ServerCutText.
      await x.cut("copied on the computer <b>&");
      await x.p.waitForFunction(() => document.getElementById("pc-there")?.tagName === "PRE");
      assert.equal(await text(x.p, "#pc-there"), "copied on the computer <b>&", "shown as text, never as markup");
      assert.equal(await x.p.inputValue("#pc-paste-text"), "Hi\nπ", "and the box you were typing in is left alone");
      assert.deepEqual(await posted(x.p, "pipComputerCopy"), [], "nothing is copied here until asked");
      await x.p.click("#pc-copy");
      await x.p.waitForFunction(() => document.getElementById("pc-clip-note").textContent === "Copied.");
      assert.deepEqual(await posted(x.p, "pipComputerCopy"), [{ type: "pipComputerCopy", text: "copied on the computer <b>&" }]);
      await x.cut("a second copy");
      await x.p.waitForFunction(() => document.getElementById("pc-there")?.textContent === "a second copy");
      const after = await layout(x.p);
      inside(after.panel, after.view, "the panel with a copy in it");
      assert.equal(after.pageScrolls, false);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the clipboard takes text up to 1 MB, whole, through every hop; more is refused with nothing sent", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { width: 700 });
  try {
    await x.p.click("#pc-clip");
    await x.p.waitForSelector("#pc-paste-text");
    const fill = (n) => x.p.evaluate((size) => { const box = document.getElementById("pc-paste-text"); box.value = "a".repeat(size - 1) + "Z"; box.dispatchEvent(new Event("input", { bubbles: true })); }, n);
    await fill(1_000_001);
    await x.p.click("#pc-paste");
    await x.p.waitForFunction(() => document.querySelector("#pc-clip-note[role=alert]")?.textContent === "That is over 1 MB. Send less.");
    await x.p.waitForTimeout(150);
    assert.equal(x.rfb().cuts.length, 0, "nothing was sent");
    // Characters that take more than a byte count as their bytes.
    await x.p.evaluate(() => { const box = document.getElementById("pc-paste-text"); box.value = "é".repeat(500_001); box.dispatchEvent(new Event("input", { bubbles: true })); });
    await x.p.click("#pc-paste");
    await x.p.waitForTimeout(150);
    assert.equal(x.rfb().cuts.length, 0, "over 1 MB in bytes");
    await fill(1_000_000);
    await x.p.click("#pc-paste");
    for (let i = 0; i < 300 && !x.rfb().cuts.length; i++) await x.p.waitForTimeout(20);
    assert.equal(x.rfb().cuts.length, 1, "exactly 1 MB goes");
    const sentBytes = x.rfb().cuts[0].bytes;
    assert.equal(sentBytes.length, 8 + 1_000_000);
    assert.equal(hex(sentBytes.slice(0, 8)), "06000000000f4240");
    assert.equal(sentBytes.at(-1), 0x5a, "to its last character");
    assert.equal(x.rfb().buffer.length, 0, "and the stream is still in step");
    // No one message is over what the host passes on (1,400,000 base64 characters; src/pipsView.ts).
    assert.ok(Math.max(...(await posted(x.p, "pipDesktop")).map((m) => m.size)) <= 1_400_000);
    // The other way: a copy of more than 1 MB on the computer is not brought here.
    await x.p.evaluate((data) => window.postMessage({ type: "pipDesktopData", data }, "*"), Buffer.from(x.rfb().cutText("b".repeat(1_000_001))).toString("base64"));
    await x.p.waitForFunction(() => /more than 1 MB/.test(document.getElementById("pc-there")?.textContent || ""));
    assert.equal(await x.p.evaluate(() => document.getElementById("pc-copy").disabled), true);
    await x.p.evaluate((data) => window.postMessage({ type: "pipDesktopData", data }, "*"), Buffer.from(x.rfb().cutText("c".repeat(999_999) + "!")).toString("base64"));
    await x.p.waitForFunction(() => document.getElementById("pc-there")?.tagName === "PRE");
    assert.equal((await text(x.p, "#pc-there")).length, 2000, "a long copy shows its start");
    assert.match(await text(x.p, ".pc-clip-more"), /Copy takes all of it/);
    await x.p.click("#pc-copy");
    await x.p.waitForFunction(() => window.__copied.length === 1);
    assert.equal(await x.p.evaluate(() => window.__copied[0].length + window.__copied[0].slice(-1)), "1000000!");
    // Type it is for short text.
    await fill(5001);
    await x.p.click("#pc-type");
    await x.p.waitForFunction(() => /Type it takes up to 5,000 characters/.test(document.querySelector("#pc-clip-note[role=alert]")?.textContent || ""));
    assert.equal(x.rfb().keys.length, 0);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("while a Pip run uses the computer the keyboard and clipboard panels are off, and they come back when it stops", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of WIDTHS) {
    const x = await openComputer(browser, { width, using: true });
    try {
      await x.p.waitForSelector("#pc-using");
      assert.equal(await text(x.p, "#pc-using"), "Mornings is using it");
      assert.deepEqual(await x.p.evaluate(() => ["pc-keys", "pc-clip"].map((id) => { const b = document.getElementById(id); return [b.disabled, b.title, b.getAttribute("aria-expanded")]; })),
        [[true, "Mornings is using it", "false"], [true, "Mornings is using it", "false"]]);
      await x.p.click("#pc-keys", { force: true });
      assert.equal(await x.p.$(".pc-panel"), null, "no panel opens");
      assert.deepEqual(await x.p.evaluate(() => ["pc-fit", "pc-actual", "pc-size", "pc-full"].map((id) => document.getElementById(id).disabled)), [false, false, false, false], "how you watch is still yours");
      const l = await layout(x.p);
      for (const b of l.buttons) inside(b, l.view, b.id);
      const using = await x.p.evaluate(() => { const r = document.getElementById("pc-using").getBoundingClientRect(); return { id: "pc-using", left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
      inside(using, l.view, "the line");
      apart([...l.buttons, using], `the bar at ${width}px with the line`);
      assert.equal(l.pageScrolls, false);
      assert.equal(x.rfb().keys.length + x.rfb().cuts.length, 0);
      // The run ends: the panels are yours, and the one you open stays open.
      await x.scene({ using: false });
      await x.p.waitForFunction(() => !document.getElementById("pc-keys").disabled, null, { timeout: 10000 });
      assert.equal(await x.p.$("#pc-using"), null);
      await x.p.click("#pc-clip");
      await x.p.waitForSelector("#pc-clip-panel");
      await x.p.fill("#pc-paste-text", "mine");
      // A run starts again while a panel is open: the panel goes, nothing can be sent, and it returns with its text.
      await x.scene({ using: true });
      await x.p.waitForFunction(() => !document.querySelector(".pc-panel"), null, { timeout: 10000 });
      assert.equal(await x.p.evaluate(() => document.getElementById("pc-clip").disabled), true);
      await x.scene({ using: false });
      await x.p.waitForSelector("#pc-clip-panel", { timeout: 10000 });
      assert.equal(await x.p.inputValue("#pc-paste-text"), "mine");
      assert.equal(x.rfb().cuts.length, 0);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("a new copy on the computer puts one small mark on Clipboard until the panel is opened; one size on offer, or an older DGC, has no size choice", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { width: 300 });
  try {
    assert.equal(await x.p.$("#pc-clip .pc-dot"), null);
    await x.cut("fresh");
    await x.p.waitForSelector("#pc-clip .pc-dot");
    assert.equal(await x.p.evaluate(() => document.body.textContent.includes("fresh")), false, "what it copied is not on the page while the panel is shut");
    await x.p.click("#pc-clip");
    await x.p.waitForSelector("#pc-there");
    assert.equal(await text(x.p, "#pc-there"), "fresh");
    assert.equal(await x.p.$("#pc-clip .pc-dot"), null);
  } finally { await x.close(); }
  for (const [name, opts] of [["a Mac's one size", { screens: ["1280x800"] }], ["API 85", { api: 85 }], ["no sizes said", { screens: null }]]) {
    const y = await openComputer(browser, { width: 700, ...opts });
    try {
      assert.equal(await y.p.$("#pc-size"), null, `${name}: no Screen size`);
      assert.deepEqual(await y.p.evaluate(() => [...document.querySelectorAll("#pc-tools button")].map((b) => b.id)), ["pc-fit", "pc-actual", "pc-keys", "pc-clip", "pc-full"]);
      assert.deepEqual(y.errors, []);
    } finally { await y.close(); }
  }
});

test("a tab opened while its screen is a size other than the one chosen says so, with no pick made here", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { width: 700, screen: "1280x800" });
  try {
    // Chosen elsewhere (its page, or another tab): DGC now says 1920x1080, and the screen on show is 1280x800.
    await x.scene({ screen: "1920x1080" });
    await x.p.waitForSelector("#pc-restart-note", { timeout: 10000 });
    assert.equal(await text(x.p, "#pc-restart-note span"), "Its screen is set to 1920 × 1080. Restart its computer to use it.");
    // While a Pip run uses it, Restart waits: stopping its computer would end what it is doing.
    await x.scene({ using: true });
    await x.p.waitForFunction(() => document.getElementById("pc-restart")?.disabled === true, null, { timeout: 10000 });
    assert.equal(await x.p.getAttribute("#pc-restart", "title"), "Mornings is using it");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
