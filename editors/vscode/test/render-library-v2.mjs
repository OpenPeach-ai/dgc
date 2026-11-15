// The pictures of Library v2 and the one header row (0.52, 15 Nov; not a test): each thing the pass built, on the real
// pages, dark and light, at 170, 300, 440 and 700 px in the side bar and at 1100 px in the Library's editor tab, with a
// mouse and with a finger. Each picture is its own PNG; sheets/ holds the same pictures side by side, a row of widths
// at a time, for looking through them. Run in a tree; it pictures that tree.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-library-v2.mjs <out folder> [which, ...]
// which: library editor heads home dock menus states forced
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { cleanup } from "./support/notes-host.mjs";
import { openLibraryTab, openLibraryPage, LIB_ARTIFACTS } from "./support/library-scene.mjs";
import { openDock, PINS, DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { openGrid } from "./support/home-grid-scene.mjs";
import { CHATS, homeState } from "./support/home-scene.mjs";

const out = process.argv[2], only = process.argv.slice(3);
if (!out) throw new Error("say where the pictures go");
mkdirSync(`${out}/sheets`, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const WIDTHS = [170, 300, 440, 700], THEMES = ["dark", "light"], INPUTS = ["mouse", "touch"], TABS = ["artifacts", "widgets", "images", "videos", "files"];
const shot = async (page, name, clip) => { await page.screenshot({ path: `${out}/${name}.png`, ...(clip ? { clip } : {}) }); return name; };
/** The pictures named in `rows` ([[name, ...], ...]) side by side, each under its name, as sheets/<name>.png. */
async function sheet(name, rows, ground = "#777") {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const { readFileSync } = await import("node:fs");
  const cell = (n) => `<figure><figcaption>${n}</figcaption><img src="data:image/png;base64,${readFileSync(`${out}/${n}.png`).toString("base64")}"></figure>`;
  await page.setContent(`<style>body{margin:0;padding:8px;background:${ground};font:11px system-ui;color:#fff;width:max-content}div{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px}figure{margin:0}figcaption{padding:0 0 2px}img{display:block}</style>`
    + rows.map((row) => `<div>${row.map(cell).join("")}</div>`).join(""));
  await page.screenshot({ path: `${out}/sheets/${name}.png`, fullPage: true });
  await page.close();
  console.log(`sheets/${name}`);
}
const step = async (name, fn) => { if (only.length && !only.includes(name)) return; try { await fn(); } catch (error) { console.log(`! ${name}: ${String(error.stack || error).slice(0, 600)}`); } };
const many = Array.from({ length: 40 }, (_, k) => ({ ...LIB_ARTIFACTS[k % 5], id: "ar_" + String(k).padStart(16, "a"), title: k % 2 ? `A report with a name so long that no side bar will ever show the whole of it (${k})` : `Item ${k}`, made_as: "",
  ...(k % 3 ? {} : { made_by: { kind: "pip", id: "pip_" + "9".repeat(32), name: "Checkout smoke tests, every night at two" } }) }));

// ---- the Library in the side bar: each of its five tabs ----------------------------------------------------------------------
await step("library", async () => {
  for (const theme of THEMES) for (const input of INPUTS) {
    const names = Object.fromEntries(TABS.map((t) => [t, []]));
    for (const width of WIDTHS) {
      const x = await openLibraryTab(browser, { width, theme: `${theme}-modern`, touch: input === "touch" });
      try { for (const tab of TABS) { await x.libTab(tab); await x.rest(200); if (input === "mouse") await x.page.locator("#library-list .lib-row").nth(1).hover().catch(() => {}); await x.rest(120);
        names[tab].push(await shot(x.page, `library-${tab}-${width}-${theme}-${input}`)); } } finally { await x.close(); }
    }
    for (const tab of TABS) await sheet(`library-${tab}-${theme}-${input}`, [names[tab]]);
  }
});
// ---- the Library in its editor tab, 1100 px ------------------------------------------------------------------------------------
await step("editor", async () => {
  for (const theme of THEMES) for (const input of INPUTS) {
    const names = [];
    const x = await openLibraryPage(browser, { width: 1100, theme: `${theme}-modern`, touch: input === "touch" });
    try { for (const tab of TABS) { await x.libTab(tab); await x.rest(200); if (input === "mouse") await x.page.locator("#library-list .lib-row").nth(1).hover().catch(() => {}); await x.rest(120);
      names.push(await shot(x.page, `editor-${tab}-1100-${theme}-${input}`)); } } finally { await x.close(); }
    await sheet(`editor-${theme}-${input}-a`, [[names[0]], [names[1]]]); await sheet(`editor-${theme}-${input}-b`, [[names[2]], [names[3]]]); await sheet(`editor-${theme}-${input}-c`, [[names[4]]]);
  }
});
// ---- the one header row: Work, Chat, Library, Pips ---------------------------------------------------------------------------
await step("heads", async () => {
  for (const theme of THEMES) for (const input of INPUTS) {
    const rows = { work: [], chat: [], library: [], pips: [] };
    for (const width of WIDTHS) {
      const x = await openLibraryTab(browser, { tab: "work", width, theme: `${theme}-modern`, touch: input === "touch" });
      try { for (const id of Object.keys(rows)) { await x.page.click(`#side-tab-${id}`);
        if (id === "pips") await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot?.querySelector("[data-job]"), null, { timeout: 20000 });
        await x.settle(); await x.rest(200);
        rows[id].push(await shot(x.page, `head-${id}-${width}-${theme}-${input}`, { x: 0, y: 0, width, height: 240 })); } } finally { await x.close(); }
    }
    await sheet(`heads-${theme}-${input}`, Object.values(rows));
  }
});
// ---- Home: the tab order, his Library icon on the tab and on the button beside Cards -----------------------------------------
await step("home", async () => {
  for (const theme of THEMES) for (const input of INPUTS) {
    const row = [];
    for (const width of WIDTHS) {
      const x = await openGrid(browser, { width, theme: `${theme}-modern`, touch: input === "touch", height: 500 });
      try { await x.page.waitForTimeout(300); row.push(await shot(x.page, `home-${width}-${theme}-${input}`, { x: 0, y: 0, width, height: 200 })); } finally { await x.close(); }
    }
    await sheet(`home-${theme}-${input}`, [row]);
  }
});
// ---- the dock's new-message dot ---------------------------------------------------------------------------------------------
await step("dock", async () => {
  const pins = [...PINS, { key: `work:${DOCK_SESSIONS[3].id}`, kind: "work", id: DOCK_SESSIONS[3].id, title: "Invoice totals", sub: "", look: {}, ref: {} }], few = [PINS[1], PINS[5], pins.at(-1)];
  for (const theme of THEMES) for (const input of INPUTS) {
    const row = [];
    for (const width of WIDTHS) {
      const x = await openDock(browser, { pins: width < 240 ? few : pins, most: 12, width, height: 420, theme: `${theme}-modern`, touch: input === "touch", state: homeState("busy"),
        saved: { sideTab: "work", hubNews: { work: {}, chat: { [CHATS[0].id]: Date.now() - 30000 }, ran: { work: [], chat: [] } } } });
      try { await x.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", news: [{ id: DOCK_SESSIONS[3].id, at: Date.now() - 60000, preview: "Done: the totals round half up now." }] });
        await x.settle(); await x.page.waitForTimeout(250);
        row.push(await shot(x.page, `dock-dot-${width}-${theme}-${input}`, { x: 0, y: 300, width, height: 120 }));
        if (width === 300 && input === "mouse") { await x.page.locator("#dgc-dock .dgc-dock-item").last().hover(); await x.page.locator(`#dgc-dock .dgc-dock-item[data-key="work:${DOCK_SESSIONS[3].id}"]`).hover(); await x.page.waitForTimeout(900);
          await shot(x.page, `dock-dot-name-${theme}`, { x: 0, y: 240, width, height: 180 }); }
      } finally { await x.close(); }
    }
    await sheet(`dock-dot-${theme}-${input}`, [row]);
    // (Twice as large, to see the dot itself.)
    const z = await openDock(browser, { pins, most: 12, width: 300, height: 420, scale: 3, theme: `${theme}-modern`, touch: input === "touch", state: homeState("busy"), saved: { sideTab: "work", hubNews: { work: {}, chat: { [CHATS[0].id]: Date.now() - 30000 }, ran: { work: [], chat: [] } } } });
    try { await z.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", news: [{ id: DOCK_SESSIONS[3].id, at: Date.now() - 60000, preview: "Done." }] }); await z.settle(); await z.page.waitForTimeout(250);
      await shot(z.page, `dock-dot-close-up-${theme}-${input}`, { x: 0, y: 350, width: 300, height: 70 }); } finally { await z.close(); }
  }
  await sheet("dock-dot-close-ups", THEMES.map((t) => INPUTS.map((i) => `dock-dot-close-up-${t}-${i}`)));
});
// ---- the menus: a tab's filters, a row's ⋯, the page's ⋯ ---------------------------------------------------------------------
await step("menus", async () => {
  for (const theme of THEMES) {
    const rows = [];
    for (const width of [170, 300]) {
      const row = [], x = await openLibraryTab(browser, { width, theme: `${theme}-modern` });
      try {
        await x.menu("kind"); row.push(await shot(x.page, `menu-kind-${width}-${theme}`)); await x.page.keyboard.press("Escape"); await x.rest(200);
        await x.menu("maker"); row.push(await shot(x.page, `menu-maker-${width}-${theme}`)); await x.page.keyboard.press("Escape"); await x.rest(200);
        const r = x.page.locator("#library-list .lib-row").nth(1); await r.hover(); await r.locator(".lib-row-more").click(); await x.page.waitForTimeout(350); row.push(await shot(x.page, `menu-row-${width}-${theme}`)); await x.page.keyboard.press("Escape"); await x.rest(200);
        await x.page.click("#library-more"); await x.page.waitForTimeout(350); row.push(await shot(x.page, `menu-more-${width}-${theme}`)); await x.page.keyboard.press("Escape"); await x.rest(200);
        await x.libTab("files"); await x.menu("origin"); row.push(await shot(x.page, `menu-origin-${width}-${theme}`)); await x.page.keyboard.press("Escape");
      } finally { await x.close(); }
      rows.push(row);
    }
    await sheet(`menus-${theme}`, rows);
    const y = await openLibraryPage(browser, { width: 1100, theme: `${theme}-modern` });
    try { await y.page.locator("#library-list .lib-row").nth(1).locator(".lib-row-more").click(); await y.page.waitForTimeout(350); await shot(y.page, `menu-editor-download-${theme}`);
      await y.page.keyboard.press("Escape"); await y.rest(200); await y.menu("maker"); await shot(y.page, `menu-editor-maker-${theme}`); } finally { await y.close(); }
    await sheet(`menus-editor-${theme}`, [[`menu-editor-download-${theme}`], [`menu-editor-maker-${theme}`]]);
  }
});
// ---- what else it can look like: long names, long filters that find nothing, an empty Library, a video playing --------------------
await step("states", async () => {
  for (const theme of THEMES) {
    const long = [], none = [], empty = [], found = [];
    for (const width of WIDTHS) {
      let x = await openLibraryTab(browser, { width, theme: `${theme}-modern`, artifacts: many });
      try { long.push(await shot(x.page, `state-long-names-${width}-${theme}`));
        await x.pick("maker", "Checkout smoke tests"); await x.pick("kind", "Dashboards"); none.push(await shot(x.page, `state-long-filters-${width}-${theme}`)); } finally { await x.close(); }
      x = await openLibraryTab(browser, { width, theme: `${theme}-modern`, artifacts: [], files: [], images: [], videos: [], widgets: [] });
      try { empty.push(await shot(x.page, `state-empty-${width}-${theme}`)); } finally { await x.close(); }
      x = await openLibraryTab(browser, { width, theme: `${theme}-modern` });
      try { await x.libTab("images"); await x.search("beach"); found.push(await shot(x.page, `state-search-images-${width}-${theme}`)); } finally { await x.close(); }
    }
    await sheet(`states-long-${theme}`, [long]); await sheet(`states-nothing-found-${theme}`, [none]); await sheet(`states-empty-${theme}`, [empty]); await sheet(`states-search-${theme}`, [found]);
    const y = await openLibraryPage(browser, { width: 1100, theme: `${theme}-modern`, artifacts: many });
    try { await shot(y.page, `state-editor-long-names-${theme}`); } finally { await y.close(); }
    const z = await openLibraryPage(browser, { width: 1100, theme: `${theme}-modern`, artifacts: [], files: [], images: [], videos: [], widgets: [] });
    try { await shot(z.page, `state-editor-empty-${theme}`); } finally { await z.close(); }
    await sheet(`states-editor-${theme}`, [[`state-editor-long-names-${theme}`], [`state-editor-empty-${theme}`]]);
  }
});
// ---- forced colours (Windows High Contrast) ----------------------------------------------------------------------------------
await step("forced", async () => {
  const row = [];
  for (const width of [170, 300]) {
    const x = await openLibraryTab(browser, { width, theme: "hc", forced: true, pins: [PINS[1], PINS[5]] });
    try { row.push(await shot(x.page, `forced-library-${width}`)); await x.libTab("images"); row.push(await shot(x.page, `forced-library-images-${width}`));
      await x.page.click("#side-tab-home"); await x.settle(); await x.rest(300); row.push(await shot(x.page, `forced-home-${width}`)); } finally { await x.close(); }
  }
  const y = await openLibraryPage(browser, { width: 1100, theme: "hc", forced: true });
  try { await shot(y.page, "forced-editor-1100"); } finally { await y.close(); }
  await sheet("forced-side", [row]); await sheet("forced-editor", [["forced-editor-1100"]]);
});
await browser.close(); cleanup();
