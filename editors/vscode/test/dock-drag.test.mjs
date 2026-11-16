// Rearranging the dock by drag and drop (media/shared/dock.js and dock.css, media/main.js, src/dock.ts),
// measured in real Chromium on the side bar's real page with a real pointer (support/dock-scene.mjs). What is held here:
//   - press and drag a pinned icon along the dock: the others slide apart to open a gap where it would land, and
//     dropping puts it there; the host is told the place (dockPlace), and the order holds over a reload
//   - a short press is still a click; "+" stays last and cannot be moved or dropped past
//   - Escape during a drag puts it back; dropped outside the dock, it snaps back; nothing is ever removed by a drag
//   - Alt+Left and Alt+Right move the focused icon one place, and say so ("Moved to place 2 of 6")
//   - under reduced motion nothing slides: the gap just appears
// (The host's side, dockPlace kept with the pins, is in dock-host.test.mjs.)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, dockNow, PINS } from "./support/dock-scene.mjs";

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
const settle = (page, ms = 80) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);

const KEYS = PINS.map((p) => p.key);
const order = async (x) => (await dockNow(x.page)).items.map((i) => i.key);
/** Where each item is drawn now (its own box, moved or not), by key. */
const drawn = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#dgc-dock .dgc-dock-item")].map((b) => { const r = b.getBoundingClientRect(); return [b.dataset.key || "+", { x: r.left + r.width / 2, y: r.top + r.height / 2, moved: getComputedStyle(b).transform !== "none" && getComputedStyle(b).transform !== "matrix(1, 0, 0, 1, 0, 0)" }]; })));
/** The items left to right as they are drawn now (the tiles grow toward the pointer, so places are told by order). */
const across = (d, without = "") => Object.entries(d).filter(([key]) => key !== without).sort((a, b) => a[1].x - b[1].x).map(([key]) => key);
const dragging = (x) => x.page.evaluate(() => document.getElementById("dgc-dock").hasAttribute("data-dragging"));
const centre = async (x, key) => (await drawn(x.page))[key];
/** Press on `key` and move to `to` in steps, without letting go. */
async function dragTo(x, key, to, { steps = 8 } = {}) {
  const from = await centre(x, key);
  await x.page.mouse.move(from.x, from.y); await x.page.mouse.down();
  await x.page.mouse.move(to.x, to.y, { steps }); await settle(x.page, 320);
  return from;
}
const placed = (x) => x.posted("dockPlace");
/** A point a little past an item's middle, the way a hand carries one icon over another (`by`: 1 rightwards, -1 leftwards). */
const past = (at, by = 1) => ({ x: at.x + by * 9, y: at.y });

for (const width of [300, 700]) {
  test(`${width}px: dragging an icon along the dock opens a gap where it would land, and dropping puts it there and tells the host`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 600 });
    try {
      assert.deepEqual(await order(x), [...KEYS, "+"]);
      const rest = await drawn(x.page);
      // The first icon, dragged to where the third stands.
      await dragTo(x, KEYS[0], past(rest[KEYS[2]]));
      const mid = await drawn(x.page);
      assert.ok(Math.abs(mid[KEYS[0]].x - past(rest[KEYS[2]]).x) <= 1.5, `the icon is under the pointer (${mid[KEYS[0]].x} at ${past(rest[KEYS[2]]).x})`);
      assert.deepEqual(across(mid), [KEYS[1], KEYS[2], KEYS[0], ...KEYS.slice(3), "+"], "the two it passed slid one place left: the gap is where it would land, and + is last");
      assert.ok(mid[KEYS[1]].moved && mid[KEYS[2]].moved && !mid[KEYS[3]].moved && !mid["+"].moved, "only the two it passed moved aside");
      const gaps = across(mid).slice(0, -1).map((key, i, list) => (i ? mid[key].x - mid[list[i - 1]].x : 99));
      assert.ok(Math.min(...gaps) >= 20, `no two icons lie over one another (${gaps.map(Math.round)})`);
      assert.equal(await dragging(x), true);
      assert.deepEqual(await placed(x), [], "nothing is saved until it is dropped");
      await x.page.mouse.up(); await settle(x.page, 320);
      const next = [KEYS[1], KEYS[2], KEYS[0], ...KEYS.slice(3)];
      assert.deepEqual(await order(x), [...next, "+"], "dropped: it is third now, and + is still last");
      assert.deepEqual(await placed(x), [{ type: "dockPlace", key: KEYS[0], to: 2 }], "the host is told its new place, to keep it");
      assert.deepEqual(await x.posted("dockOpen"), [], "a drag opens nothing");
      assert.deepEqual(await x.posted("dockUnpin"), [], "and removes nothing");
      const after = await drawn(x.page);
      assert.ok(Object.values(after).every((i) => !i.moved), "every icon is at rest in its place");
      assert.equal(await dragging(x), false);
      // Back again, leftwards: the third to the first place.
      await dragTo(x, KEYS[0], past(after[next[0]], -1)); await x.page.mouse.up(); await settle(x.page, 320);
      assert.deepEqual(await order(x), [...KEYS, "+"]);
      assert.deepEqual((await placed(x)).at(-1), { type: "dockPlace", key: KEYS[0], to: 0 });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a short press is still a click: it opens the item and moves nothing", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 300, height: 600 });
  try {
    const at = await centre(x, KEYS[3]);
    await x.page.mouse.move(at.x, at.y); await x.page.mouse.down(); await x.page.mouse.move(at.x + 3, at.y + 1); await x.page.mouse.up(); await settle(x.page);
    assert.deepEqual((await x.posted("dockOpen")).map((m) => m.key), [KEYS[3]], "a press that moved three pixels is a click");
    assert.deepEqual(await placed(x), []);
    assert.deepEqual(await order(x), [...KEYS, "+"]);
    // And a real drag is not a click.
    const rest = await drawn(x.page);
    await dragTo(x, KEYS[3], past(rest[KEYS[4]])); await x.page.mouse.up(); await settle(x.page, 320);
    assert.equal((await x.posted("dockOpen")).length, 1, "dropping an icon opens nothing");
    assert.equal((await placed(x)).length, 1);
  } finally { await x.close(); }
});

test('"+" stays last: an icon dragged past it lands in the last pinned place, and "+" itself cannot be dragged', async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 300, height: 600 });
  try {
    const rest = await drawn(x.page);
    await dragTo(x, KEYS[0], { x: rest["+"].x + 30, y: rest["+"].y });
    const past = await drawn(x.page);
    assert.ok(!past["+"].moved && across(past, KEYS[0]).at(-1) === "+", "+ does not move aside");
    await x.page.mouse.up(); await settle(x.page, 320);
    assert.deepEqual(await order(x), [...KEYS.slice(1), KEYS[0], "+"], "it is the last pinned item; + is after it");
    assert.deepEqual(await placed(x), [{ type: "dockPlace", key: KEYS[0], to: KEYS.length - 1 }]);
    const now = await drawn(x.page);
    await dragTo(x, "+", now[KEYS[2]]);
    assert.deepEqual([await dragging(x), across(await drawn(x.page))], [false, [...KEYS.slice(1), KEYS[0], "+"]], "+ stays where it is under a drag");
    await x.page.mouse.up(); await settle(x.page, 320);
    assert.deepEqual(await order(x), [...KEYS.slice(1), KEYS[0], "+"]);
    assert.equal((await placed(x)).length, 1);
  } finally { await x.close(); }
});

test("Escape during a drag puts the icon back; dropped outside the dock it snaps back; neither saves or removes anything", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 300, height: 600 });
  try {
    const rest = await drawn(x.page);
    await dragTo(x, KEYS[1], past(rest[KEYS[4]]));
    await x.page.keyboard.press("Escape"); await settle(x.page, 320);
    assert.ok(Object.values(await drawn(x.page)).every((i) => !i.moved), "Escape: every icon is back at rest");
    await x.page.mouse.up(); await settle(x.page, 320);
    assert.deepEqual(await order(x), [...KEYS, "+"]);
    assert.deepEqual([await placed(x), await x.posted("dockOpen"), await x.posted("dockUnpin")], [[], [], []], "nothing saved, opened or removed");
    // Out of the dock, up into the page, and let go there.
    await dragTo(x, KEYS[1], { x: rest[KEYS[4]].x, y: rest[KEYS[4]].y - 200 });
    const out = await drawn(x.page);
    assert.deepEqual([across(out, KEYS[1]), KEYS.filter((key) => key !== KEYS[1] && out[key].moved)], [[...KEYS.filter((key) => key !== KEYS[1]), "+"], []], "out of the dock, the gap closes: it would go back");
    await x.page.mouse.up(); await settle(x.page, 320);
    assert.deepEqual(await order(x), [...KEYS, "+"], "it snapped back");
    assert.deepEqual([await placed(x), await x.posted("dockOpen"), await x.posted("dockUnpin")], [[], [], []], "a drag never removes a pin");
  } finally { await x.close(); }
});

test("Alt+Left and Alt+Right move the focused icon one place, keep the keyboard on it, and say where it is now", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 300, height: 600 });
  try {
    const said = () => x.page.evaluate(() => document.querySelector("#dgc-dock .dgc-dock-live")?.textContent || "");
    await x.page.focus(`#dgc-dock .dgc-dock-item[data-key="${KEYS[0]}"]`);
    await x.page.keyboard.press("Alt+ArrowRight"); await settle(x.page, 150);
    assert.deepEqual(await order(x), [KEYS[1], KEYS[0], ...KEYS.slice(2), "+"]);
    assert.equal((await dockNow(x.page)).focus, KEYS[0], "the keyboard stays on the icon that moved");
    assert.equal(await said(), `Moved to place 2 of ${KEYS.length}`);
    await x.page.keyboard.press("Alt+ArrowLeft"); await settle(x.page, 150);
    assert.deepEqual(await order(x), [...KEYS, "+"]);
    assert.equal(await said(), `Moved to place 1 of ${KEYS.length}`);
    await x.page.keyboard.press("Alt+ArrowLeft"); await settle(x.page, 150);
    assert.deepEqual(await order(x), [...KEYS, "+"], "the first cannot move left");
    assert.equal(await said(), `Already first of ${KEYS.length}`);
    // Plain Left and Right still move the keyboard, not the icon; + takes no Alt move.
    await x.page.keyboard.press("ArrowRight"); await settle(x.page);
    assert.equal((await dockNow(x.page)).focus, KEYS[1]);
    await x.page.keyboard.press("End"); await x.page.keyboard.press("Alt+ArrowLeft"); await settle(x.page, 150);
    assert.deepEqual(await order(x), [...KEYS, "+"], "+ stays last");
    assert.equal(await x.page.evaluate(() => { const live = document.querySelector("#dgc-dock .dgc-dock-live"); return !!live && live.getAttribute("aria-live") === "polite" && live.getBoundingClientRect().width <= 1; }), true, "said to a screen reader, not shown");
  } finally { await x.close(); }
});

test("the others slide on an ease; under reduced motion nothing slides, the gap just appears", async (t) => {
  if (skipOrFail(t)) return;
  for (const [motion, slides] of [["no-preference", true], ["reduce", false]]) {
    const x = await openDock(browser, { tab: "home", width: 300, height: 600, motion });
    try {
      const rest = await drawn(x.page);
      const from = rest[KEYS[0]];
      await x.page.mouse.move(from.x, from.y); await x.page.mouse.down();
      await x.page.mouse.move(past(rest[KEYS[2]]).x, from.y, { steps: 2 });
      // Read at once, with no wait: mid-slide, or already there.
      const now = await drawn(x.page), gone = across(now).indexOf(KEYS[1]) === 0 && now[KEYS[2]].x - now[KEYS[1]].x >= 20;
      const eased = await x.page.evaluate((key) => getComputedStyle(document.querySelector(`#dgc-dock .dgc-dock-item[data-key="${key}"]`)).transitionProperty.includes("transform"), KEYS[1]);
      assert.equal(eased, slides, `${motion}: a neighbour's move is ${slides ? "eased" : "not eased"}`);
      if (!slides) assert.equal(gone, true, "reduced motion: the gap is there at once");
      await settle(x.page, 320);
      assert.deepEqual(across(await drawn(x.page)).slice(0, 3), [KEYS[1], KEYS[2], KEYS[0]]);
      await x.page.mouse.up(); await settle(x.page, 320);
      assert.deepEqual(await order(x), [KEYS[1], KEYS[2], KEYS[0], ...KEYS.slice(3), "+"]);
    } finally { await x.close(); }
  }
});

test("the order holds over a reload: the dock opens in the order the host kept", async (t) => {
  if (skipOrFail(t)) return;
  let x = await openDock(browser, { tab: "home", width: 300, height: 600 });
  try {
    const rest = await drawn(x.page);
    await dragTo(x, KEYS[4], past(rest[KEYS[1]], -1)); await x.page.mouse.up(); await settle(x.page, 320);
    const kept = await x.page.evaluate(() => window.__dock.pins);
    assert.deepEqual(kept.map((p) => p.key), [KEYS[0], KEYS[4], KEYS[1], KEYS[2], KEYS[3], ...KEYS.slice(5)], "the host's pins are in the new order");
    await x.close();
    x = await openDock(browser, { tab: "home", width: 300, height: 600, pins: kept });
    assert.deepEqual(await order(x), [...kept.map((p) => p.key), "+"]);
  } finally { await x.close(); }
});
