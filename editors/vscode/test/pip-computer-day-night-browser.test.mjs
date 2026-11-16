// The computer tab's own desktop wears the one wallpaper the full desktop does (his calls, 16 Nov): the teal version
// from 07:00 to 19:00 and the dark grey one at night, by this computer's clock, and the dock's glass follows it (light
// by day, dark by night), whatever the editor's theme. It changes while the tab is open (each minute, and at once when
// the tab is looked at again). In real Chromium with the real client and its CSS (test/support/pip-computer-scene.mjs).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
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

const at = (hour, minute = 0) => new Date(2026, 10, 16, hour, minute, 0);
const look = (p) => p.evaluate(() => {
  const desk = getComputedStyle(document.querySelector(".pc-desktop")), dock = document.querySelector(".pc-dock");
  const glass = dock ? getComputedStyle(dock).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number) : null;
  return { night: document.body.classList.contains("pc-night"), picture: desk.backgroundImage.length + ":" + desk.backgroundImage.slice(0, 8) + desk.backgroundImage.slice(-80), glass: glass && glass.reduce((a, b) => a + b, 0) / 3 };
});

test("by day the teal wallpaper and a light glass dock; at night the dark grey one and a dark dock, in either editor theme", async (t) => {
  if (skipOrFail(t)) return;
  const seen = {};
  for (const theme of ["dark", "light"]) {
    for (const [name, hour] of [["day", 12], ["night", 22], ["early", 6], ["seven", 7], ["nineteen", 19]]) {
      const x = await openComputer(browser, { theme, now: at(hour), wait: false, flat: true });
      await x.p.waitForSelector(".pc-dock");
      try {
        seen[`${theme}-${name}`] = await look(x.p);
        assert.deepEqual(x.errors, [], "no page errors");
      } finally { await x.close(); }
    }
  }
  for (const theme of ["dark", "light"]) {
    const day = seen[`${theme}-day`], night = seen[`${theme}-night`];
    assert.equal(day.night, false, `${theme}: noon is day`);
    assert.equal(night.night, true, `${theme}: 22:00 is night`);
    assert.equal(seen[`${theme}-early`].night, true, "06:00 is still night");
    assert.equal(seen[`${theme}-seven`].night, false, "07:00 is day");
    assert.equal(seen[`${theme}-nineteen`].night, true, "19:00 is night");
    assert.notEqual(day.picture, night.picture, "two versions of the wallpaper");
    assert.match(day.picture, /^\d+:url\(/);
    assert.ok(day.glass > 200, `${theme}: a light glass by day (${day.glass})`);
    assert.ok(night.glass < 80, `${theme}: a dark glass at night (${night.glass})`);
  }
  assert.equal(seen["dark-day"].picture, seen["light-day"].picture, "the editor's theme doesn't choose the wallpaper");
});

test("it changes while the tab is open, at once when the tab is looked at again", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { now: at(18, 59), wait: false });
  try {
    assert.equal((await look(x.p)).night, false);
    await x.p.clock.setFixedTime(at(19, 1));
    await x.p.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal((await look(x.p)).night, true, "19:01: night");
    await x.p.clock.setFixedTime(at(7, 0));
    await x.p.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal((await look(x.p)).night, false, "07:00: day again");
  } finally { await x.close(); }
});

// One app, one picture (his rule, 16 Nov: "we need to keep things same"): the tab's own dock and its windows' title bars
// show Browser, Files and Terminal with the very pictures the full desktop's dock wears (dgc/desktop_assets), never
// drawings of their own.
test("the tab's dock wears the full desktop's own app pictures, byte for byte", async (t) => {
  if (skipOrFail(t)) return;
  const { readFileSync } = await import("node:fs");
  const assets = new URL("../../../dgc/desktop_assets/", import.meta.url);
  const x = await openComputer(browser, { now: at(12), wait: false, flat: true });
  try {
    await x.p.waitForSelector(".pc-dock");
    const picture = (el) => (el ? getComputedStyle(el).backgroundImage.replace(/^url\("?|"?\)$/g, "") : "");
    const shown = await x.p.evaluate((pic) => { const picture = new Function("return " + pic)();
      return [...document.querySelectorAll(".pc-dock-app")].map((b) => [b.dataset.app, picture(b.querySelector(".pc-app-picture")), !!b.querySelector("svg")]); }, picture.toString());
    assert.deepEqual(shown.map(([app]) => app), ["browser", "files", "terminal"]);
    for (const [app, src, drawn] of shown) {
      assert.equal(drawn, false, `${app}: a picture, not a drawing of its own`);
      const want = "data:image/png;base64," + readFileSync(new URL(`${app}.png`, assets)).toString("base64");
      assert.equal(src, want, `${app}: the same picture as the full desktop's dock`);
    }
  } finally { await x.close(); }
  // Where the tab opens apps in its own windows (a runtime without the live screen), a press on a picture opens its app,
  // and the window's title bar wears the same picture.
  const y = await openComputer(browser, { now: at(12), wait: false, api: 42 });
  try {
    await y.p.waitForSelector('.pc-dock-app[data-app="files"] .pc-app-picture');
    await y.p.click('.pc-dock-app[data-app="files"] .pc-app-picture', { force: true });
    await y.p.waitForSelector(".pc-window .pc-win-icon .pc-app-picture");
    const titled = await y.p.evaluate(() => getComputedStyle(document.querySelector(".pc-window .pc-win-icon .pc-app-picture")).backgroundImage.replace(/^url\("?|"?\)$/g, ""));
    assert.equal(titled, "data:image/png;base64," + readFileSync(new URL("files.png", assets)).toString("base64"), "its window's title bar too");
  } finally { await y.close(); }
});
