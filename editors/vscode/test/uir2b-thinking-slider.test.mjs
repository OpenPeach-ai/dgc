// User test W15 (15 Nov), in real Chromium on Work's real page: moving the thinking slider a few steps took about two
// seconds a step to land, the button showed the level before (then every step on the way) meanwhile, and each step
// left its own "Thinking → x" line in the session. Every step was its own request to DGC. Now the level is chosen when
// the hand lets go: the button says it at once, DGC is told once, and what DGC says on the way is not shown.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openThinking } from "./support/uir2b-scene.mjs";

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
// (The button and the slider write one level's name with different capitals, "Extra High" and "Extra high": not this test's.)
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

test("W15: arrow keys along the slider are one choice: the button follows at once, and DGC is told once, when they rest", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openThinking(browser, { think: "low" });
  try {
    const start = await x.now();
    assert.equal(start.value, "low"); assert.equal(start.button, "Low");
    await x.page.focus("#modelmenu .effort-slider");
    const seen = [];
    for (let i = 0; i < 3; i++) { await x.page.keyboard.press("ArrowRight"); await x.page.waitForTimeout(150); const n = await x.now(); seen.push([n.value, same(n.button, n.word)]); }
    assert.deepEqual(seen.map(([v]) => v), start.levels.slice(start.levels.indexOf("low") + 1, start.levels.indexOf("low") + 4), "each key is one stop");
    assert.ok(seen.every(([, same]) => same), "the button says the slider's level at every step, at once");
    assert.deepEqual(await x.sent(), [], "nothing is sent while the keys are still moving");
    assert.equal((await x.now()).menu, true, "the menu stays open for the next step");
    // DGC says the level it had (an answer on its way): the button keeps the level just chosen.
    await x.state("low");
    { const n = await x.now(); assert.ok(same(n.button, n.word), `the button still says ${n.word} (${n.button})`); }
    await x.page.waitForTimeout(900);
    const sent = await x.sent();
    assert.deepEqual(sent.map((m) => m.level), [seen.at(-1)[0]], "one request, for where the keys came to rest");
    await x.state(sent[0].level);
    const end = await x.now();
    assert.ok(same(end.button, end.word)); assert.equal(end.value, sent[0].level);
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("W15: back where it started sends nothing; leaving the slider sends at once; a drag's release is one request and closes the menu", async (t) => {
  if (skipOrFail(t)) return;
  const back = await openThinking(browser, { think: "medium" });
  try {
    await back.page.focus("#modelmenu .effort-slider");
    await back.page.keyboard.press("ArrowRight"); await back.page.waitForTimeout(120); await back.page.keyboard.press("ArrowLeft"); await back.page.waitForTimeout(900);
    assert.deepEqual(await back.sent(), [], "the level it already had is not asked for again: no line in the session");
    assert.equal((await back.now()).button, "Medium");
    // Tab away right after a key: the choice is sent then, not after the wait.
    await back.page.focus("#modelmenu .effort-slider"); await back.page.keyboard.press("ArrowRight"); await back.page.keyboard.press("Tab"); await back.page.waitForTimeout(80);
    assert.deepEqual((await back.sent()).map((m) => m.level), ["high"]);
  } finally { await back.page.close(); }
  const drag = await openThinking(browser, { think: "off" });
  try {
    const box = await drag.page.evaluate(() => { const b = document.querySelector("#modelmenu .effort-slider").getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width }; });
    await drag.page.mouse.move(box.x + 4, box.y); await drag.page.mouse.down();
    for (const at of [0.2, 0.4, 0.6, 0.8]) { await drag.page.mouse.move(box.x + box.w * at, box.y, { steps: 3 }); await drag.page.waitForTimeout(60); }
    assert.deepEqual(await drag.sent(), [], "nothing is sent while the hand still holds it");
    const held = await drag.now();
    await drag.page.mouse.up(); await drag.page.waitForTimeout(120);
    const sent = await drag.sent(), after = await drag.now();
    assert.equal(sent.length, 1, "letting go is the one request"); assert.equal(sent[0].level, held.value);
    assert.equal(after.menu, false, "and closes the menu"); assert.ok(same(after.button, held.word), "the button says it at once");
    // What DGC says on the way (the level before, then a step between) never shows; its own answer settles it.
    await drag.state("off"); assert.ok(same((await drag.now()).button, held.word));
    await drag.state(sent[0].level === "ultra" ? "off" : sent[0].level, sent[0].level === "ultra"); assert.ok(same((await drag.now()).button, held.word));
  } finally { await drag.page.close(); }
});

test("W15: a level DGC never takes goes back to what DGC last said", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openThinking(browser, { think: "low" });
  try {
    await x.page.evaluate(() => { const real = window.setTimeout; window.setTimeout = (fn, ms, ...a) => real(fn, ms >= 5000 ? 300 : ms, ...a); });   // (the six seconds DGC is given, shortened)
    await x.page.focus("#modelmenu .effort-slider"); await x.page.keyboard.press("ArrowRight"); await x.page.keyboard.press("Tab"); await x.page.waitForTimeout(60);
    assert.equal((await x.now()).button, "Medium");
    await x.page.waitForTimeout(500);
    assert.equal((await x.now()).button, "Low", "DGC said nothing: the button says the level it is really at");
  } finally { await x.page.close(); }
});
