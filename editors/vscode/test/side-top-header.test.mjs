// The header row at the top of DGC's side bar, above the tab bar (src/panel.ts `#phead`, media/main.css): DGC's
// wordmark with its three slashes breathing in turn and its cursor, and nothing else, because the buttons it once held
// are the tab bar's now (Pips is a tab; Pips' "back" is the tabs themselves). Measured in real Chromium on the side
// bar's real page (support/dock-scene.mjs). What is held here:
//   - the header is the first thing in the side bar, then the tab bar, centred as before, on every tab
//   - the wordmark: the mark in the accent, "DGC", the cursor; the slashes are animated, and still under reduced motion
//   - no button shows in it: nothing is offered twice
//   - it fits at 240, 300 and 700 px with nothing cut
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock } from "./support/dock-scene.mjs";

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
const settle = (page, ms = 60) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);

/** The header as it is on screen. */
const headNow = (page) => page.evaluate(() => {
  const head = document.getElementById("phead"), rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const pm = head.querySelector(".pm"), mark = pm.querySelector("svg.mk"), cur = pm.querySelector(".cur"), bar = document.querySelector("#side-tabs .dgc-tabs-bar");
  const probe = document.createElement("span"); probe.style.color = "var(--accent)"; document.body.append(probe); const accent = getComputedStyle(probe).color; probe.remove();
  return { shown: head.checkVisibility(), box: rect(head), mark: rect(pm), word: pm.textContent.trim(), cut: pm.scrollWidth > pm.clientWidth + 0.5 || rect(pm).right > rect(head).right + 0.5,
    markColour: getComputedStyle(mark).color, accent, slashes: [...mark.querySelectorAll("path")].map((p) => [getComputedStyle(p).animationName, getComputedStyle(p).animationDelay]),
    cursor: cur.checkVisibility() && rect(cur).width > 0, buttons: [...head.querySelectorAll("button")].filter((b) => b.checkVisibility()).map((b) => b.id),
    bar: rect(bar), tabs: [...bar.querySelectorAll('[role="tab"]')].filter((t) => t.checkVisibility()).map((t) => t.dataset.tab),
    clipped: [...bar.querySelectorAll('[role="tab"]')].filter((t) => { const f = t.querySelector(".dgc-tab-flip").getBoundingClientRect(), r = t.getBoundingClientRect(); return f.left < r.left - 0.5 || f.right > r.right + 0.5; }).map((t) => t.dataset.tab),
    overflowX: document.documentElement.scrollWidth > innerWidth, width: innerWidth };
});

for (const width of [240, 300, 700]) {
  test(`${width}px: the header with DGC's animated wordmark is the first thing in the side bar, and the tab bar is under it`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 700 });
    try {
      const h = await headNow(x.page);
      assert.equal(h.shown, true, "the side bar has its header row");
      assert.ok(h.box.top < 1, "it is the first thing in the side bar");
      assert.equal(h.word, "DGC", "the wordmark");
      assert.ok(h.mark.left >= 11.5, `it starts at the side bar's 12 px gutter (${h.mark.left})`);
      assert.equal(h.markColour, h.accent, "the mark is in DGC's accent");
      assert.deepEqual(h.slashes.map(([name]) => name), ["brand-slash-pulse", "brand-slash-pulse", "brand-slash-pulse"], "its three slashes breathe");
      assert.deepEqual(h.slashes.map(([, delay]) => delay), ["0s", "0.22s", "0.44s"], "one after another");
      assert.equal(h.cursor, true, "and its cursor");
      assert.equal(h.cut, false, "the wordmark is whole");
      assert.deepEqual(h.buttons, [], "no button in it: Pips is a tab now, and nothing is offered twice");
      assert.ok(h.bar.top >= h.box.bottom - 0.5, `the tab bar is under the header (${h.box.bottom} then ${h.bar.top})`);
      assert.ok(h.bar.top - h.box.bottom <= 8, `and close under it (${h.bar.top - h.box.bottom})`);
      assert.ok(h.box.bottom <= 44, `the header is one short row (${h.box.bottom})`);
      assert.ok(Math.abs((h.bar.left + h.bar.right) / 2 - width / 2) < 0.6, "the tab bar is centred, as before");
      assert.deepEqual(h.tabs, ["home", "work", "chat", "pips"]);
      assert.deepEqual(h.clipped, [], "no tab's name is cut");
      assert.equal(h.overflowX, false, "nothing runs off the side");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the header stays on every tab, the Pips page too, still with no button of its own", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 300, height: 700 });
  try {
    const first = await headNow(x.page);
    for (const tab of ["work", "chat", "pips", "home"]) {
      await x.page.click(`#side-tab-${tab}`); await settle(x.page, 150);
      const h = await headNow(x.page);
      assert.deepEqual([h.shown, h.word, h.buttons, Math.round(h.box.bottom), Math.round(h.bar.top)], [true, "DGC", [], Math.round(first.box.bottom), Math.round(first.bar.top)], `on ${tab}: the same header, and the tab bar where it was`);
    }
  } finally { await x.close(); }
});

test("under reduced motion the slashes and the cursor keep still", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 300, height: 700, motion: "reduce" });
  try {
    const h = await headNow(x.page);
    assert.equal(h.shown, true);
    assert.deepEqual(h.slashes.map(([name]) => name), ["none", "none", "none"]);
    assert.equal(await x.page.evaluate(() => getComputedStyle(document.querySelector("#phead .pm .cur")).animationName), "none");
  } finally { await x.close(); }
});
