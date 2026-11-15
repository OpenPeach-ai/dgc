// The pictures of the Library's item menu, the Routines pop-up's close button and a working Pip's row (0.52, 15 Nov;
// not a test): each on the real pages in real Chromium, dark and light, at 300, 440 and 700 px (the Library's editor
// tab at 1100 px too). Each picture is its own PNG; sheets/ holds them side by side. Run in a tree; it pictures that tree.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-library-actions.mjs <out folder> <prefix> [which, ...]
// prefix: a word put before each name ("before", "after"). which: menus keys routines dots
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openLibraryTab, openLibraryPage, LIB_IMAGES, LIB_VIDEOS, LIB_FILES, ar } from "./support/library-scene.mjs";
import { PIP, openChat } from "./support/pip-chat-scene.mjs";

const out = process.argv[2], prefix = process.argv[3] || "after", only = process.argv.slice(4);
if (!out) throw new Error("say where the pictures go");
mkdirSync(`${out}/sheets`, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const WIDTHS = [300, 440, 700], THEMES = ["dark", "light"];
const shot = async (page, name, clip) => { await page.screenshot({ path: `${out}/${prefix}-${name}.png`, ...(clip ? { clip } : {}) }); return `${prefix}-${name}`; };
async function sheet(name, rows, ground = "#777") {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const cell = (n) => `<figure><figcaption>${n}</figcaption><img src="data:image/png;base64,${readFileSync(`${out}/${n}.png`).toString("base64")}"></figure>`;
  await page.setContent(`<style>body{margin:0;padding:8px;background:${ground};font:11px system-ui;color:#fff;width:max-content}div{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px}figure{margin:0}figcaption{padding:0 0 2px}img{display:block}</style>`
    + rows.map((row) => `<div>${row.map(cell).join("")}</div>`).join(""));
  await page.screenshot({ path: `${out}/sheets/${prefix}-${name}.png`, fullPage: true });
  await page.close();
  console.log(`sheets/${prefix}-${name}`);
}
const step = async (name, fn) => { if (only.length && !only.includes(name)) return; try { await fn(); } catch (error) { console.log(`! ${name}: ${String(error.stack || error).slice(0, 700)}`); } };
// One of each kind the brief names: an artifact (a doc, which can do all eight, and a page), an image, a video, a file.
const KINDS = [["artifact-doc", "artifacts", `artifact:${ar(3)}`], ["artifact-page", "artifacts", `artifact:${ar(1)}`], ["image", "images", `image:${LIB_IMAGES[1].path}`], ["video", "videos", `video:${LIB_VIDEOS[0].path}`], ["file", "files", `file:${LIB_FILES[0].id}`]];

// ---- the item menu: open on each kind, in the side bar (300/440/700) and in the editor tab (700/1100), by right-click --------------
await step("menus", async () => {
  for (const theme of THEMES) {
    const rows = Object.fromEntries(KINDS.map((k) => [k[0], []]));
    const places = [...WIDTHS.map((w) => ["side", w]), ["tab", 700], ["tab", 1100]];
    for (const [place, width] of places) {
      const x = place === "side" ? await openLibraryTab(browser, { width, theme: `${theme}-modern` }) : await openLibraryPage(browser, { width, theme: `${theme}-modern` });
      try {
        for (const [name, tab, key] of KINDS) {
          await x.libTab(tab); await x.rest(150);
          const row = x.page.locator(`#library-list .lib-row[data-key="${key}"]`);
          await row.click({ button: "right", position: { x: 70, y: 14 } }); await x.page.waitForTimeout(450);
          rows[name].push(await shot(x.page, `menu-${name}-${place}-${width}-${theme}`, { x: 0, y: 0, width, height: 640 }));
          await x.page.keyboard.press("Escape"); await x.rest(150);
        }
      } finally { await x.close(); }
    }
    for (const [name] of KINDS) await sheet(`menu-${name}-${theme}`, [rows[name].slice(0, 3), rows[name].slice(3)], theme === "dark" ? "#555" : "#999");
  }
});
// ---- the same menu from the row's ⋯ and from the keyboard, a row that is off under the pointer (its reason), and the words said ----
await step("keys", async () => {
  for (const theme of THEMES) {
    const row = [];
    for (const [place, width] of [["side", 300], ["side", 440], ["tab", 700]]) {
      const x = place === "side" ? await openLibraryTab(browser, { width, theme: `${theme}-modern` }) : await openLibraryPage(browser, { width, theme: `${theme}-modern` });
      try {
        await x.libTab("images"); await x.rest(150);
        const li = x.page.locator(`#library-list .lib-row[data-key="image:${LIB_IMAGES[1].path}"]`);
        await li.hover({ position: { x: 70, y: 14 } }); await li.locator(".lib-row-more").click(); await x.page.waitForTimeout(450);
        row.push(await shot(x.page, `dots-image-${place}-${width}-${theme}`, { x: 0, y: 0, width, height: 640 }));
        await x.page.keyboard.press("Escape"); await x.rest(150);
        await li.focus(); await x.page.keyboard.press("Shift+F10"); await x.page.waitForTimeout(450);
        for (let i = 0; i < 6; i++) await x.page.keyboard.press("ArrowDown");
        await x.page.waitForTimeout(900);
        row.push(await shot(x.page, `keys-image-off-row-${place}-${width}-${theme}`, { x: 0, y: 0, width, height: 640 }));
        await x.page.keyboard.press("Escape"); await x.rest(150);
        await x.page.evaluate(() => { const say = (message) => window.dispatchEvent(new MessageEvent("message", { data: document.querySelector('.dgc-lib[data-place="side"]') ? { type: "sideLibrary", message } : message })); say({ type: "itemSaid", words: "Path copied" }); });
        await x.page.waitForTimeout(350);
        row.push(await shot(x.page, `said-${place}-${width}-${theme}`, { x: 0, y: 0, width, height: 640 }));
      } finally { await x.close(); }
    }
    await sheet(`keys-${theme}`, [row.slice(0, 3), row.slice(3, 6), row.slice(6)], theme === "dark" ? "#555" : "#999");
  }
});
// ---- the Routines pop-up in a Pip's chat ---------------------------------------------------------------------------------------------
await step("routines", async () => {
  for (const theme of THEMES) {
    const row = [];
    for (const [where, width] of [["side", 300], ["side", 440], ["side", 700], ["tab", 700]]) {
      const x = await openChat(browser, { width, height: 640, theme, where });
      try {
        await x.p.click("#chat-routines"); await x.p.waitForSelector(".pip-routines-popover"); await x.p.waitForTimeout(350);
        row.push(await shot(x.p, `routines-${where}-${width}-${theme}`));
        await x.p.hover("#chat-routines-close"); await x.p.waitForTimeout(250);
        const b = await x.p.evaluate(() => { const r = (window.__pipsRoot || document).querySelector(".pip-routines-head").getBoundingClientRect(); return { x: Math.max(0, r.left - 12), y: Math.max(0, r.top - 12), width: r.width + 24, height: r.height + 24 }; });
        row.push(await shot(x.p, `routines-head-hover-${where}-${width}-${theme}`, b));
      } finally { await x.close(); }
    }
    await sheet(`routines-${theme}`, [row.filter((_, i) => i % 2 === 0), row.filter((_, i) => i % 2 === 1)], theme === "dark" ? "#555" : "#999");
  }
});
// ---- the Pips list with working Pips: at rest, each working row pointed at, one reached by Tab, and with a finger -----------------
await step("dots", async () => {
  const id = (c) => "pip_" + c.repeat(32), ROWS = [[PIP, "plain"], [id("2"), "number"], [id("3"), "new"], [id("4"), "both"]];
  for (const theme of THEMES) {
    const sheets = [];
    for (const width of WIDTHS) {
      const row = [];
      const x = await openChat(browser, { width, height: 560, theme, where: width >= 700 ? "tab" : "side", api: 97, convs: true, switches: true, many: true, home: true, working: "9234" });
      try {
        await x.p.waitForSelector(`[data-job="${PIP}"][data-state="working"]`);
        await x.p.evaluate((a) => window.postMessage({ type: "dock", pinned: [`pip:${a}`] }, "*"), id("3")); await x.p.waitForTimeout(300);
        await x.p.mouse.move(1, 1); await x.p.waitForTimeout(200);
        row.push(await shot(x.p, `pips-working-rest-${width}-${theme}`));
        for (const [pip, name] of ROWS) {
          await x.p.hover(`[data-job="${pip}"]`, { position: { x: 30, y: 12 } }); await x.p.waitForTimeout(300);
          const b = await x.p.evaluate((p) => { const r = (window.__pipsRoot || document).querySelector(`[data-job="${p}"]`).closest(".pip-row-line, .pip-row-slot").getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top - 6), width: innerWidth, height: r.height + 12 }; }, pip);
          row.push(await shot(x.p, `pips-working-hover-${name}-${width}-${theme}`, b));
        }
        await x.p.mouse.move(1, 1); await x.p.locator(`[data-job="${PIP}"]`).focus(); await x.p.waitForTimeout(300);
        const b = await x.p.evaluate((p) => { const r = (window.__pipsRoot || document).querySelector(`[data-job="${p}"]`).closest(".pip-row-line, .pip-row-slot").getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top - 6), width: innerWidth, height: r.height + 12 }; }, PIP);
        row.push(await shot(x.p, `pips-working-focus-plain-${width}-${theme}`, b));
      } finally { await x.close(); }
      const t = await openChat(browser, { width, height: 560, theme, where: width >= 700 ? "tab" : "side", api: 97, convs: true, switches: true, many: true, home: true, working: "9234", touch: true });
      try { await t.p.waitForSelector(`[data-job="${PIP}"][data-state="working"]`); await t.p.evaluate((a) => window.postMessage({ type: "dock", pinned: [`pip:${a}`] }, "*"), id("3")); await t.p.waitForTimeout(400); row.push(await shot(t.p, `pips-working-touch-${width}-${theme}`)); } finally { await t.close(); }
      sheets.push(row);
    }
    await sheet(`pips-working-${theme}`, sheets.flatMap((r) => [[r[0], r[6]], r.slice(1, 6)]), theme === "dark" ? "#555" : "#999");
  }
});
await browser.close();
