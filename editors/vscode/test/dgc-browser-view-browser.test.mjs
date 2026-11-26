// DGC Browser's own screen looks and behaves exactly like a Pip computer's (24 Nov), in real Chromium with the real tab,
// its CSS and the real noVNC viewer on a fake RFB server that takes the size it is asked for (test/support/
// dgc-browser-scene.mjs), inside VS Code's webview defaults:
//   - one screen pixel per tab pixel: the screen is never scaled, up or down, unless Fit is chosen; edge to edge, no
//     editor gutter beside it;
//   - Chrome's window follows the tab where it can (the screen is the tab's room, nothing to scroll), but Chrome's window
//     is never narrower than its own minimum: in a narrower tab the screen stays that wide, at one to one, and the tab
//     scrolls sideways (and down, in a tab shorter than DGC's least height) to its far edge;
//   - Fit / 100%: the Pip computer's own control, the same words, titles and look, in the bar above the screen; Fit
//     scales the screen into the tab as a Pip computer's Fit does; the choice is kept for the tab;
//   - the viewer is set up exactly as a Pip computer's (src/screenView.js): scaling, clipping, quality, compression, size,
//     focus and ground;
//   - whatever scale DGC says Chrome draws at, the picture is never scaled unless Fit is chosen.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDgcBrowser, viewOf, CHROME_MIN_WIDTH } from "./support/dgc-browser-scene.mjs";
import { openComputer } from "./support/pip-computer-scene.mjs";

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
const PICTURES = process.env.DGC_YB_PICTURES || "";

/** The screen has the size the tab asked for (the fake screen took it and the viewer drew it). */
const settled = (p, w, h, ms = 8000) => p.waitForFunction(([w, h]) => { const c = document.querySelector(".yb-vnc canvas"); return !!c && c.width === w && (h === undefined || c.height === h); }, [w, h], { timeout: ms })
  .catch(async (error) => { error.message += `\nThe screen: ${JSON.stringify(await viewOf(p))}`; throw error; });
const one = (v) => Math.abs(v.canvas.width - v.pixels[0]) < 0.5 && Math.abs(v.canvas.height - v.pixels[1]) < 0.5;

for (const width of [1200, 700]) {
  test(`at ${width} px the screen is the tab's room, drawn one to one, edge to edge, with nothing to scroll`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDgcBrowser(browser, { width, height: 700 });
    try {
      await x.p.waitForFunction(() => document.querySelector(".yb-vnc canvas")?.width > 0, null, { timeout: 10000 });
      await x.p.waitForFunction(() => { const c = document.querySelector(".yb-vnc canvas"), r = c?.parentElement; return !!r && c.width === r.clientWidth && c.height === r.clientHeight; }, null, { timeout: 8000 })
        .catch(async (error) => { error.message += `\nThe screen: ${JSON.stringify(await viewOf(x.p))}`; throw error; });
      const v = await viewOf(x.p);
      assert.ok(one(v), `one screen pixel per tab pixel: ${JSON.stringify(v)}`);
      assert.ok(Math.abs(v.outer.left) < 0.5 && Math.abs(v.outer.right - width) < 0.5, `edge to edge, no editor gutter: ${v.outer.left}..${v.outer.right}`);
      assert.deepEqual(v.room, v.pixels, "the screen is the tab's room");
      assert.deepEqual(v.scrolls, [false, false], "nothing to scroll");
      assert.equal(v.pageScrolls, false);
      const asked = await x.p.evaluate(() => window.__sent.filter((r) => r.op === "size").at(-1));
      assert.deepEqual([asked.width, asked.height], v.room, "Chrome's window at the tab's room");
      if (PICTURES) await x.p.screenshot({ path: `${PICTURES}/view-${width}.png` });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("at 300 px Chrome's window can't be that narrow: the screen stays as wide as it, one to one, and the tab scrolls sideways to its far edge", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDgcBrowser(browser, { width: 300, height: 600 });
  try {
    await settled(x.p, CHROME_MIN_WIDTH);
    // (The room loses the sideways scroll bar's height: the screen is asked for what is left, so nothing scrolls down.)
    await x.p.waitForFunction(() => { const c = document.querySelector(".yb-vnc canvas"), r = c.parentElement; return c.height === r.clientHeight; }, null, { timeout: 8000 })
      .catch(async (error) => { error.message += `\nThe screen: ${JSON.stringify(await viewOf(x.p))}`; throw error; });
    const v = await viewOf(x.p);
    assert.ok(one(v), `never scaled down to fit: ${JSON.stringify(v)}`);
    assert.equal(v.pixels[0], CHROME_MIN_WIDTH, "Chrome's whole window is on the screen");
    assert.deepEqual(v.scrolls, [true, false], "the rest is reached by scrolling sideways");
    assert.equal(v.pageScrolls, false, "the tab's room scrolls, never the page");
    assert.ok(Math.abs(v.canvas.left - v.outer.left) < 0.5, "it starts at its left edge");
    await x.p.evaluate(() => { const r = document.querySelector(".yb-vnc canvas").parentElement; r.scrollTo(r.scrollWidth, 0); });
    const end = await viewOf(x.p);
    assert.ok(end.canvas.right <= end.outer.right + 0.5 && end.canvas.right >= end.outer.right - 12, `its far edge is reachable: ${end.canvas.right} in ${end.outer.right}`);
    if (PICTURES) await x.p.screenshot({ path: `${PICTURES}/view-300-scrolled.png` });
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a tab narrower than Chrome's window and shorter than DGC's least height scrolls both ways, still one to one", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDgcBrowser(browser, { width: 300, height: 200 });
  try {
    await settled(x.p, CHROME_MIN_WIDTH, 240);
    const v = await viewOf(x.p);
    assert.ok(one(v), JSON.stringify(v));
    assert.deepEqual(v.scrolls, [true, true]);
    assert.equal(v.pageScrolls, false);
    await x.p.evaluate(() => { const r = document.querySelector(".yb-vnc canvas").parentElement; r.scrollTo(r.scrollWidth, r.scrollHeight); });
    const end = await viewOf(x.p);
    assert.ok(end.canvas.bottom <= end.outer.bottom + 0.5 && end.canvas.bottom >= end.outer.bottom - 12, `its foot is reachable: ${end.canvas.bottom} in ${end.outer.bottom}`);
  } finally { await x.close(); }
});

test("Fit, as on a Pip computer: chosen, the screen is scaled into the tab and nothing scrolls; 100% brings one to one back; the tab keeps the choice", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDgcBrowser(browser, { width: 300, height: 600 });
  try {
    await settled(x.p, CHROME_MIN_WIDTH);
    assert.deepEqual(await x.p.evaluate(() => ["yb-fit", "yb-actual"].map((id) => document.getElementById(id)?.getAttribute("aria-pressed") ?? null)), ["false", "true"], "100% to begin with");
    await x.p.click("#yb-fit");
    await x.p.waitForFunction(() => { const c = document.querySelector(".yb-vnc canvas"); return c.getBoundingClientRect().width < c.width - 1; }, null, { timeout: 5000 });
    let v = await viewOf(x.p);
    assert.deepEqual(v.scrolls, [false, false], "Fit: nothing to scroll");
    assert.ok(Math.abs(v.canvas.width / v.canvas.height - v.pixels[0] / v.pixels[1]) < 0.01, "its shape kept");
    assert.ok(Math.abs(v.canvas.width - v.room[0]) < 1.5 || Math.abs(v.canvas.height - v.room[1]) < 1.5, `as large as the room allows: ${JSON.stringify(v)}`);
    assert.deepEqual(await x.p.evaluate(() => ["yb-fit", "yb-actual"].map((id) => document.getElementById(id).getAttribute("aria-pressed"))), ["true", "false"]);
    assert.equal(await x.p.evaluate(() => window.__state?.fit), true, "the choice is kept for this tab");
    await x.p.click("#yb-actual");
    await x.p.waitForFunction(() => { const c = document.querySelector(".yb-vnc canvas"); return Math.abs(c.getBoundingClientRect().width - c.width) < 0.5; }, null, { timeout: 5000 });
    v = await viewOf(x.p);
    assert.ok(one(v));
    assert.deepEqual(v.scrolls, [true, false]);
    assert.equal(await x.p.evaluate(() => window.__state?.fit), false);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  // A tab that kept Fit opens with it.
  const y = await openDgcBrowser(browser, { width: 300, height: 600, state: { fit: true } });
  try {
    await settled(y.p, CHROME_MIN_WIDTH);
    await y.p.waitForFunction(() => { const c = document.querySelector(".yb-vnc canvas"); return c.getBoundingClientRect().width < c.width - 1; }, null, { timeout: 5000 });
    assert.equal(await y.p.getAttribute("#yb-fit", "aria-pressed"), "true");
  } finally { await y.close(); }
});

test("the Fit / 100% control is the Pip computer's own: the same words, titles, group and look, above the screen", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDgcBrowser(browser, { width: 900, height: 600 });
  const pc = await openComputer(browser, { width: 900, height: 600 });
  try {
    await settled(x.p, await x.p.evaluate(() => document.querySelector(".yb-vnc canvas").parentElement.clientWidth));
    const read = (p, fit, actual) => p.evaluate(([fit, actual]) => {
      const seg = document.getElementById(fit).parentElement, s = (e) => getComputedStyle(e);
      const one = (id) => { const b = document.getElementById(id), r = b.getBoundingClientRect();
        return { words: b.textContent.trim(), title: b.title, type: b.type, pressed: b.getAttribute("aria-pressed"), height: Math.round(r.height), font: s(b).fontSize,
          radius: [s(b).borderTopLeftRadius, s(b).borderTopRightRadius], line: s(b).borderTopWidth }; };
      return { group: [seg.getAttribute("role"), seg.getAttribute("aria-label")], fit: one(fit), actual: one(actual),
        apart: Math.round(document.getElementById(actual).getBoundingClientRect().left - document.getElementById(fit).getBoundingClientRect().right) };
    }, [fit, actual]);
    const yb = await read(x.p, "yb-fit", "yb-actual"), mine = await read(pc.p, "pc-fit", "pc-actual");
    // (Only which one is chosen differs: a Pip computer opens at Fit, DGC Browser at 100%.)
    const same = (o) => ({ ...o, fit: { ...o.fit, pressed: undefined }, actual: { ...o.actual, pressed: undefined } });
    assert.deepEqual(same(yb), same(mine));
    assert.deepEqual(yb.group, ["group", "Zoom"]);
    assert.deepEqual([yb.fit.words, yb.actual.words], ["Fit", "100%"]);
    assert.deepEqual(yb.fit.radius, ["6px", "0px"], "the one corner, never a pill");
    // Above the screen, never over it.
    const at = await x.p.evaluate(() => { const b = document.getElementById("yb-fit").getBoundingClientRect(), v = document.querySelector(".yb-vnc").getBoundingClientRect(); return [b.bottom, v.top, b.left]; });
    assert.ok(at[0] <= at[1] + 0.5, `the bar is above the screen: ${at}`);
    assert.ok(at[2] >= 0);
    if (PICTURES) await x.p.screenshot({ path: `${PICTURES}/view-control-900.png`, clip: { x: 0, y: 0, width: 900, height: 80 } });
  } finally { await x.close(); await pc.close(); }
});

// A stand-in viewer that writes down what each tab sets on it.
const RECORDER = `window.__dgcTestRFB = class { constructor(target, channel, options) { this.options = options; this.listeners = {}; const set = {};
  const c = document.createElement("canvas"); c.width = 640; c.height = 400; target.appendChild(c); (window.__viewers ||= []).push(set);
  return new Proxy(this, { set(o, k, v) { o[k] = v; if (typeof k === "string" && !k.startsWith("_") && k !== "listeners" && k !== "options") set[k] = v; return true; } }); }
  addEventListener(kind, fn) { this.listeners[kind] = fn; } }`;
test("the viewer is set up exactly as a Pip computer's: scaling, clipping, quality, compression, size, focus and ground", async (t) => {
  if (skipOrFail(t)) return;
  for (const fit of [false, true]) {
    const x = await openDgcBrowser(browser, { width: 700, height: 500, init: RECORDER, state: { fit } });
    const pc = await openComputer(browser, { width: 700, height: 500, wait: false, init: `${RECORDER}; window.__state = { fit: ${fit} };` });
    try {
      await x.p.waitForFunction(() => window.__viewers?.length > 0, null, { timeout: 10000 });
      await pc.p.waitForFunction(() => window.__viewers?.length > 0, null, { timeout: 10000 });
      const yb = await x.p.evaluate(() => window.__viewers[0]), mine = await pc.p.evaluate(() => window.__viewers[0]);
      assert.deepEqual(yb, mine, `the same settings (Fit ${fit})`);
      assert.equal(yb.scaleViewport, fit);
      assert.equal(yb.resizeSession, false, "the viewer never resizes the screen by itself");
      assert.equal(yb.clipViewport, false);
      assert.equal(yb.qualityLevel, 6); assert.equal(yb.compressionLevel, 2);
    } finally { await x.close(); await pc.close(); }
  }
});

test("whatever scale DGC says Chrome draws at, the picture is never scaled unless Fit is chosen", async (t) => {
  if (skipOrFail(t)) return;
  // An older DGC that answers only its scale: the screen is asked for the tab's size in Chrome's pixels, and shown as it is.
  const x = await openDgcBrowser(browser, { width: 700, height: 500, scale: 2, screen: false });
  try {
    await x.p.waitForFunction(() => { const c = document.querySelector(".yb-vnc canvas"), r = c?.parentElement; return !!r && c.width >= 2 * (r.clientWidth - 12); }, null, { timeout: 10000 })
      .catch(async (error) => { error.message += `\nThe screen: ${JSON.stringify(await viewOf(x.p))}`; throw error; });
    const v = await viewOf(x.p);
    assert.ok(one(v), `one screen pixel per tab pixel at scale 2: ${JSON.stringify(v)}`);
    assert.deepEqual(v.scrolls, [true, true]);
  } finally { await x.close(); }
});
