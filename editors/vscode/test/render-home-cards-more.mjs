// The pictures of the cards' second follow-up (not a test): Weather's and Clock's dropdowns, Token usage with its models,
// Notes in every form, Widgets and Artifacts, a Work folder pinned (the dropdown's pin, the Folders card's, the Work
// page's, the dock), and Recent before and after a reply is seen; dark and light, at 300 and 460 or 700 px.
// Usage: node test/render-home-cards-more.mjs <out folder>
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openGrid, LISBON, NOTES, FOLDERS } from "./support/home-grid-scene.mjs";
import { openDock, DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { CHATS, homeState } from "./support/home-scene.mjs";

const out = process.argv[2] || "/tmp/claude-1000/home-cards-more-pictures";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const shot = (x, name) => x.page.screenshot({ path: `${out}/${name}.png` });
const sel = (id, where = ".hc-grid") => `${where} .hc-card[data-card="${id}"]`;
const only = process.argv[3] || "";
const want = (name) => !only || only.split(",").includes(name);
for (const theme of ["dark-modern", "light-modern"]) {
  const t = theme.split("-")[0];
  // 1. Weather: the places found, the keys on one; then offline.
  if (want("weather")) for (const width of [300, 460]) {
    let x = await openGrid(browser, { width, theme, layout: ["weather", "clock", "token", "needs"], height: 620, scale: 2 });
    if (width < 380) { await x.page.click(sel("weather")); await x.rest(300); }
    const field = `${width < 380 ? ".hc-open" : ".hc-grid"} .hc-card[data-card="weather"] .hc-city`;
    await x.page.click(field); await x.page.keyboard.type("Lis"); await x.rest(500); await x.page.keyboard.press("ArrowDown"); await x.page.keyboard.press("ArrowDown"); await x.rest(150);
    await shot(x, `1-weather-places-${width}-${t}`);
    await x.page.keyboard.press("Enter"); await x.rest(200); await shot(x, `1-weather-chosen-${width}-${t}`);
    await x.close();
    x = await openGrid(browser, { width, theme, layout: ["weather", "clock"], height: 420, scale: 2, geo: "offline" });
    if (width < 380) { await x.page.click(sel("weather")); await x.rest(300); }
    await x.page.click(field); await x.page.keyboard.type("Lisbon"); await x.rest(500); await shot(x, `1-weather-offline-${width}-${t}`);
    await x.close();
  }
  // 2. Clock: every zone; then narrowed.
  if (want("clock")) for (const width of [300, 460]) {
    const x = await openGrid(browser, { width, theme, layout: ["clock", "weather", "token"], settings: { weather: { place: LISBON } }, height: 620, scale: 2 });
    if (width < 380) { await x.page.click(sel("clock")); await x.rest(300); }
    const field = `${width < 380 ? ".hc-open" : ".hc-grid"} .hc-card[data-card="clock"] input.hc-zone`;
    await x.page.click(field); await x.rest(300); await shot(x, `2-clock-all-zones-${width}-${t}`);
    await x.page.keyboard.type("ko"); await x.rest(200); await x.page.keyboard.press("ArrowDown"); await x.rest(100); await shot(x, `2-clock-search-${width}-${t}`);
    await x.page.keyboard.press("Enter"); await x.rest(300); await x.page.mouse.move(2, 500); await shot(x, `2-clock-chosen-${width}-${t}`);
    await x.close();
  }
  // 4. Token usage: the models under the chart; a day's tooltip; opened.
  if (want("token")) for (const width of [300, 460, 700]) {
    const x = await openGrid(browser, { width, theme, layout: ["token", "needs", "recent", "quick"], height: width === 700 ? 560 : 640, scale: 2 });
    await x.page.mouse.move(2, 500); await x.rest(300); await shot(x, `4-token-${width}-${t}`);
    if (width !== 300) { const plot = x.page.locator(`${sel("token")} .hc-plot`); await plot.focus(); await x.page.keyboard.press("ArrowLeft"); await x.rest(200); await shot(x, `4-token-day-models-${width}-${t}`); }
    else { await x.page.click(sel("token")); await x.rest(400); await x.page.mouse.move(2, 500); await shot(x, `4-token-opened-${width}-${t}`); }
    await x.close();
  }
  // 6. Notes: the notes app has its own pictures now (14 Nov: every card size, the opened app in both layouts, the
  // editor, the lock, Recently deleted): they are drawn from test/support/notes-sample.mjs by the notes build's harness.
  // 7. Widgets and Artifacts.
  if (want("made")) for (const width of [300, 460, 700]) {
    let x = await openGrid(browser, { width, theme, layout: ["widgets", "artifacts", "clock", "quick"], height: width === 700 ? 420 : 640, scale: 2 });
    await x.page.click(`${sel("widgets")} .hc-next`); await x.page.mouse.move(2, 600); await x.rest(400); await shot(x, `7-widgets-artifacts-${width}-${t}`);
    if (width === 300) { await x.page.click(sel("artifacts"), { position: { x: 60, y: 12 } }); await x.rest(400); await x.page.mouse.move(2, 600); await shot(x, `7-artifacts-opened-${width}-${t}`); }
    await x.close();
    if (width === 460) { x = await openGrid(browser, { width, theme, layout: ["widgets", "artifacts"], widgets: [], artifacts: [], height: 360, scale: 2 }); await x.rest(300); await shot(x, `7-none-yet-${width}-${t}`);
      await x.page.click(".hc-cards-btn"); await x.rest(400); await x.close();
      x = await openGrid(browser, { width, theme, height: 900, scale: 2 }); await x.page.click(".hc-cards-btn"); await x.rest(500); await x.page.locator('.hc-lib-item[data-card="widgets"]').scrollIntoViewIfNeeded(); await x.rest(200); await shot(x, `7-library-${width}-${t}`); await x.close(); }
  }
  // 3. A Work folder on the dock.
  if (want("folder")) for (const width of [300, 460]) {
    let x = await openDock(browser, { width, theme, pins: [], height: 620, scale: 2 });
    const p = x.page, id = (f) => p.evaluate((v) => window.DgcFolderPick.folderId(v), f);
    await x.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", folders: { ...FOLDERS, choice: "/home/me/garden-notes" } }); await x.settle();
    const pin = async (folder, title, more = {}) => ({ key: `folder:${await id(folder)}`, kind: "folder", id: await id(folder), title, sub: "", look: {}, ref: { folder }, ...more });
    const pins = [await pin("/home/me/garden-notes", "garden-notes"), await pin("/home/me/shop", "shop"), await pin("/home/me/old-site", "old-site", { gone: true }),
      { key: `work:${DOCK_SESSIONS[0].id}`, kind: "work", id: DOCK_SESSIONS[0].id, title: DOCK_SESSIONS[0].name, sub: "", look: {}, ref: {} }];
    await x.setting({ pins: pins.slice(0, 1) }); await x.settle();
    await p.click("#sessions-folder-pick"); await x.settle(); await p.waitForTimeout(700);
    await p.hover('.dgc-folder-menu .dgc-folder-row[data-folder="/home/me/rust_ire"]'); await p.waitForTimeout(300); await shot(x, `3-folder-dropdown-pin-${width}-${t}`);
    await p.mouse.move(2, 200); await p.waitForTimeout(300); await shot(x, `3-folder-menu-at-rest-${width}-${t}`);
    await p.keyboard.press("Escape"); await p.waitForTimeout(500);
    await x.setting({ pins }); await x.settle(); await p.mouse.move(2, 200); await p.waitForTimeout(300); await shot(x, `3-folder-work-page-and-dock-${width}-${t}`);
    const tile = p.locator(`#dgc-dock .dgc-dock-item[data-key="${pins[0].key}"]`);
    await tile.hover(); await p.waitForTimeout(1100); await shot(x, `3-folder-dock-hover-${width}-${t}`);
    await tile.click({ button: "right" }); await p.waitForTimeout(500); await shot(x, `3-folder-dock-menu-${width}-${t}`);
    await x.close();
    x = await openGrid(browser, { width, theme, layout: ["folders", "clock"], pins: pins.slice(0, 2), height: 520, scale: 2 });
    if (width >= 380) { await x.page.hover('.hc-card[data-card="folders"] .hc-tile[data-name="rust_ire"]'); await x.rest(300); }
    else { await x.page.click(sel("folders"), { position: { x: 60, y: 12 } }); await x.rest(300); await x.page.hover('.hc-open .hc-tile[data-name="rust_ire"]'); await x.rest(300); }
    await shot(x, `3-folder-card-pin-${width}-${t}`); await x.close();
  }
  // 5. "New" means not seen: a chat's reply in the background, then its tab watched.
  if (want("seen")) for (const width of [300, 460]) {
    const quiet = DOCK_SESSIONS.map(({ running, waiting, ...s }) => s);
    const x = await openGrid(browser, { width, theme, layout: ["recent", "clock"], sessions: quiet, state: homeState("quiet"), height: 480, scale: 2 });
    const chats = (more) => x.send({ type: "chatdgc_list", available: true, items: CHATS, open: ["chat_1", "chat_2"], answering: [], ...more });
    await chats({ answering: ["chat_1", "chat_2"], watched: ["chat_1"] }); await x.settle(); await chats({ watched: ["chat_1"] }); await x.settle(); await x.rest(300); await shot(x, `5-seen-new-in-background-${width}-${t}`);
    await chats({ watched: ["chat_2"] }); await x.settle(); await x.rest(300); await shot(x, `5-seen-read-on-return-${width}-${t}`);
    await x.close();
  }
}
await browser.close();
console.log(out);
