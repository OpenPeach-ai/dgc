// The pictures of the Home batch of 14 Nov (not a test): the Clock with four time zones at every size (and the × on an
// added zone), Weather's add flow (asked, with the saved place in the field) and Change place from a Small and a Medium
// card, and the Project Folder dropdown scrolled with 30 folders (its search field over the rows). Dark and light, at
// the side bar's 300 and 700 px (460 for a Medium card).
// Usage: node test/render-home-batch.mjs <out folder> [clock,weather,folder] [a prefix for the names: "before-"]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { tmpdir } from "node:os";
import { openGrid, LISBON, THIRTY_FOLDERS } from "./support/home-grid-scene.mjs";
import { openDock, DOCK_SESSIONS } from "./support/dock-scene.mjs";

const out = process.argv[2] || `${tmpdir()}/home-batch-pictures`;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const only = process.argv[3] || "", pre = process.argv[4] || "";
const want = (name) => !only || only.split(",").includes(name);
const shot = (x, name) => x.page.screenshot({ path: `${out}/${pre}${name}.png` });
const sel = (id, where = ".hc-grid") => `${where} .hc-card[data-card="${id}"]`;
const THIRTY = THIRTY_FOLDERS;
const ZONES4 = { zones: ["Asia/Tokyo", "America/Los_Angeles", "America/Buenos_Aires"] };
const BAD = { type: "homeWeather", ok: false, reason: "offline" };
for (const theme of ["dark-modern", "light-modern"]) {
  const t = theme.split("-")[0];
  // 1. Clock: four zones at every size; the × on a clock pointed at, and on the keyboard; the field with three.
  if (want("clock")) for (const width of [300, 460, 700]) {
    let x = await openGrid(browser, { width, theme, layout: ["clock", "weather", "token", "quick"], settings: { clock: ZONES4, weather: { place: LISBON } }, height: width === 700 ? 560 : 640, scale: 2 }), p = x.page;
    await p.mouse.move(2, 600); await x.rest(300); await shot(x, `clock-4-${width === 300 ? "small" : width === 460 ? "medium" : "large"}-${width}-${t}`);
    if (width === 300) { await p.click(sel("clock")); await x.rest(400); await p.mouse.move(2, 600); await shot(x, `clock-4-opened-${width}-${t}`); }
    const card = width === 300 ? ".hc-open .hc-card" : sel("clock");
    await p.locator(`${card} .hc-clock`).nth(2).hover(); await x.rest(350); await shot(x, `clock-4-x-hover-${width}-${t}`);
    await p.mouse.move(2, 600); await p.locator(`${card} .hc-clock`).nth(1).locator(".hc-zone-x").focus(); await p.keyboard.press("Tab"); await p.keyboard.press("Shift+Tab"); await x.rest(350); await shot(x, `clock-4-x-keyboard-${width}-${t}`);
    await p.keyboard.press("Enter"); await x.rest(700); await p.mouse.move(2, 600); await shot(x, `clock-3-after-remove-${width}-${t}`);
    await p.click(`${card} input.hc-zone`); await p.keyboard.type("ho chi"); await x.rest(300); await p.keyboard.press("ArrowDown"); await x.rest(150); await shot(x, `clock-add-field-${width}-${t}`);
    await x.close();
    // The longest names, and one zone alone.
    x = await openGrid(browser, { width, theme, layout: ["clock", "weather", "token"], settings: { clock: { zones: ["Asia/Ho_Chi_Minh", "Antarctica/DumontDUrville", "Pacific/Kiritimati"] }, weather: { place: LISBON } }, height: 520, scale: 2 }); p = x.page;
    if (width === 300) { await p.click(sel("clock")); await x.rest(400); }
    await p.mouse.move(2, 500); await x.rest(300); await shot(x, `clock-long-names-${width}-${t}`); await x.close();
    x = await openGrid(browser, { width, theme, layout: ["clock", "weather", "token"], settings: { clock: { zone: "Asia/Tokyo" }, weather: { place: LISBON } }, height: 420, scale: 2 }); p = x.page;
    if (width === 300) { await p.click(sel("clock")); await x.rest(400); }
    await p.mouse.move(2, 400); await x.rest(300); await shot(x, `clock-2-${width}-${t}`); await x.close();
  }
  // 2. Weather: the add flow (asked, with the saved place in the field); Change place from each size; out of reach.
  if (want("weather")) for (const width of [300, 460, 700]) {
    let x = await openGrid(browser, { width, theme, layout: ["clock", "quick"], settings: { weather: { place: LISBON, unit: "c" } }, height: 700, scale: 2 }), p = x.page;
    await p.click(".hc-cards-btn"); await x.rest(500); await p.locator('.hc-lib-item[data-card="weather"]').scrollIntoViewIfNeeded(); await p.click('.hc-lib-item[data-card="weather"] .hc-add'); await x.rest(400);
    await p.locator('.hc-lib-item[data-card="weather"]').scrollIntoViewIfNeeded(); await x.rest(200); await shot(x, `weather-add-asked-prefilled-${width}-${t}`);
    await p.keyboard.type("Port"); await x.rest(600); await p.keyboard.press("ArrowDown"); await x.rest(200); await shot(x, `weather-add-another-place-${width}-${t}`);
    await x.close();
    x = await openGrid(browser, { width, theme, layout: ["weather", "clock", "token", "quick"], settings: { weather: { place: LISBON, unit: "c" } }, height: width === 700 ? 480 : 640, scale: 2 }); p = x.page;
    await p.mouse.move(2, 600); await x.rest(300); await shot(x, `weather-card-${width}-${t}`);
    await p.locator(`${sel("weather")} .hc-city-edit`).hover(); await x.rest(300); await shot(x, `weather-change-place-hover-${width}-${t}`);
    await p.click(`${sel("weather")} .hc-city-edit`); await x.rest(500); await shot(x, `weather-change-place-pressed-${width}-${t}`);
    await p.keyboard.type("Port"); await x.rest(600); await p.keyboard.press("ArrowDown"); await x.rest(200); await shot(x, `weather-change-place-list-${width}-${t}`);
    await x.close();
    x = await openGrid(browser, { width, theme, layout: ["weather", "clock", "token"], settings: { weather: { place: LISBON, unit: "c" } }, weather: BAD, height: 420, scale: 2 }); p = x.page;
    await p.mouse.move(2, 400); await x.rest(300); await shot(x, `weather-out-of-reach-${width}-${t}`);
    if (width === 300) { await p.click(`${sel("weather")} .hc-mid`); await x.rest(400); await p.mouse.move(2, 400); await shot(x, `weather-out-of-reach-opened-${width}-${t}`); }
    await x.close();
  }
  if (want("folder")) for (const width of [300, 700]) {
    const x = await openDock(browser, { width, theme, pins: [], height: 620, scale: 2 }), p = x.page;
    await x.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", folders: { choice: THIRTY[3].folder, window: THIRTY[0], rows: THIRTY } }); await x.settle();
    await p.click("#sessions-folder-pick"); await x.settle(); await p.waitForTimeout(900);
    await p.mouse.move(2, 600); await shot(x, `folder-30-open-${width}-${t}`);
    await p.evaluate(() => { document.querySelector(".dgc-folder-list").scrollTop = 173; }); await p.waitForTimeout(300); await shot(x, `folder-30-scrolled-${width}-${t}`);
    await p.hover(`.dgc-folder-menu .dgc-folder-row[data-folder="${THIRTY[6].folder}"]`).catch(() => {}); await p.waitForTimeout(300); await shot(x, `folder-30-scrolled-hover-${width}-${t}`);
    await p.evaluate(() => { const l = document.querySelector(".dgc-folder-list"); l.scrollTop = l.scrollHeight; }); await p.waitForTimeout(300); await p.mouse.move(2, 600); await shot(x, `folder-30-end-${width}-${t}`);
    if (!pre) { await p.keyboard.press("Escape"); await p.waitForTimeout(600); await p.focus("#sessions-folder-pick"); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(900);
      const rows = '.dgc-folder-menu .dgc-folder-row'; await p.focus(`${rows}[data-folder="${THIRTY[3].folder}"]`); await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(300); await shot(x, `folder-pin-by-keyboard-${width}-${t}`);
      await p.keyboard.press("Enter"); await p.waitForTimeout(300); await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(300); await shot(x, `folder-pinned-${width}-${t}`); }
    await x.close();
  }
}
await browser.close();
