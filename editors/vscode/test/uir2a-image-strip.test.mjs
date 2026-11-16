// 16 Nov call 65, in real Chromium on the real session page: a step's "Viewed N images" strip. A plain mouse wheel over
// it moves it sideways while it can still move that way; at its end the wheel scrolls the page on. A soft fade marks
// an edge where more pictures are hidden. The pictures stay inside the opened step.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openViewedImages } from "./support/uir2a-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const at = (page) => page.evaluate(() => { const s = document.querySelector(".tool-images"), log = document.getElementById("log"), c = getComputedStyle(s);
  return { left: Math.round(s.scrollLeft), max: Math.round(s.scrollWidth - s.clientWidth), log: Math.round(log.scrollTop), logMax: Math.round(log.scrollHeight - log.clientHeight),
    mask: c.maskImage || c.webkitMaskImage, start: s.classList.contains("fade-start"), end: s.classList.contains("fade-end") }; });
const overStrip = async (page) => { const box = await page.locator(".tool-images").boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); };

for (const width of [300, 440, 700]) {
  test(`65: a wheel moves the strip of 8 pictures sideways, then the page (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openViewedImages(browser, { width, count: 8, tail: 30 });
    try {
      await x.page.evaluate(() => { const log = document.getElementById("log"); log.scrollTop = 0; document.querySelector(".tool-images").scrollIntoView({ block: "center" }); });
      await x.page.waitForTimeout(150);
      let s = await at(x.page);
      assert.ok(s.max > 250, `premise: 8 pictures don't fit (${s.max}px hidden)`);
      assert.ok(s.logMax - s.log > 200, "premise: the page has further to go down");
      assert.deepEqual([s.left, s.start, s.end], [0, false, true], "at its start: more to the right, and a fade there");
      assert.match(s.mask, /gradient/, "the hidden edge fades");
      const top = s.log;
      await overStrip(x.page);
      await x.page.mouse.wheel(0, 240); await x.page.waitForTimeout(250);
      s = await at(x.page);
      assert.ok(s.left >= 100, `the wheel moved the strip sideways (${s.left}px)`);
      assert.equal(s.log, top, "and the page stayed where it was");
      assert.deepEqual([s.start, s.end], [true, true], "mid-way: pictures hidden on both sides");
      for (let i = 0; i < 12 && (await at(x.page)).left < s.max - 1; i++) { await x.page.mouse.wheel(0, 240); await x.page.waitForTimeout(120); }
      s = await at(x.page);
      assert.ok(s.max - s.left <= 1, "it reaches its end");
      assert.deepEqual([s.start, s.end, s.log], [true, false, top], "at its end: no fade on the right, the page still unmoved");
      await x.page.mouse.wheel(0, 240); await x.page.waitForTimeout(250);
      assert.ok((await at(x.page)).log >= top + 80, "at its end, the wheel scrolls the page on");
      // And back: up moves the strip to its start first, then the page.
      await x.page.evaluate(() => document.querySelector(".tool-images").scrollIntoView({ block: "center" })); await x.page.waitForTimeout(150);
      await overStrip(x.page);
      const top2 = (await at(x.page)).log;
      await x.page.mouse.wheel(0, -240); await x.page.waitForTimeout(250);
      s = await at(x.page);
      assert.ok(s.left <= s.max - 100, `wheel up moves it back (${s.left} of ${s.max})`); assert.equal(s.log, top2);
      // A sideways wheel (a trackpad's swipe, Shift+wheel) is the browser's own, as before.
      const before = s.left;
      await x.page.mouse.wheel(-120, 0); await x.page.waitForTimeout(250);
      assert.ok((await at(x.page)).left < before, "a sideways wheel still moves it");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("65: a strip that fits (one picture, three at 700px) has no fade and leaves the wheel to the page", async (t) => {
  if (skipOrFail(t)) return;
  for (const [count, width] of [[1, 440], [3, 700]]) {
    const x = await openViewedImages(browser, { width, count, tail: 30 });
    try {
      await x.page.evaluate(() => { document.getElementById("log").scrollTop = 0; }); await x.page.waitForTimeout(100);
      let s = await at(x.page);
      assert.equal(s.max, 0, `premise: ${count} fit at ${width}px`);
      assert.deepEqual([s.start, s.end, s.mask], [false, false, "none"]);
      await overStrip(x.page); await x.page.mouse.wheel(0, 240); await x.page.waitForTimeout(250);
      assert.ok((await at(x.page)).log >= 80, "the wheel scrolls the page");
      assert.equal(await x.page.evaluate(() => getComputedStyle(document.querySelector(".tool-images")).display !== "none" && !!document.querySelector(".tool.open .tool-images")), true, "the pictures are inside the opened step");
    } finally { await x.page.close(); }
  }
});
