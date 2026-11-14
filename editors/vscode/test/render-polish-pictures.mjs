// The visual polish pass's before and after pictures (0.52, 14 Nov; not a test): each thing the pass fixed, on the real
// page, in the state that shows it. Run in a tree; it pictures that tree.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-polish-pictures.mjs <out folder> <a suffix: "before" | "after">
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openGrid, LISBON, THIRTY_FOLDERS } from "./support/home-grid-scene.mjs";
import { openDock, DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { sample } from "./support/notes-sample.mjs";
import { cleanup } from "./support/notes-host.mjs";
import { openChat as openPipChat } from "./support/pip-chat-scene.mjs";
import { openOnePips, GST } from "./support/one-pips-scene.mjs";
import { openRunningTurn, openChatDgc } from "./support/codex-look-scene.mjs";
import { openMapScene } from "./support/agent-map-scene.mjs";
import { openLibrary, ITEMS } from "./support/chat-scene.mjs";
import { eachSurface } from "./support/marks-centred-scene.mjs";

const out = process.argv[2], tag = process.argv[3] || "after";
if (!out) throw new Error("say where the pictures go");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const touch = new Proxy(browser, { get(target, key) {
  if (key === "newContext") return (o = {}) => target.newContext({ ...o, hasTouch: true });
  if (key === "newPage") return (o = {}) => target.newPage({ ...o, hasTouch: true });
  const v = target[key]; return typeof v === "function" ? v.bind(target) : v; } });
const shot = async (page, name, clip) => { await page.screenshot({ path: `${out}/${name}-${tag}.png`, ...(clip ? { clip } : {}) }); console.log(`${name}-${tag}`); };
const boxOf = async (page, selector, pad = 10) => { const b = await page.locator(selector).first().boundingBox(); const v = page.viewportSize(); const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad); return { x, y, width: Math.min(v.width - x, b.width + 2 * pad), height: Math.min(v.height - y, b.height + 2 * pad) }; };
const step = async (name, fn) => { try { await fn(); } catch (error) { console.log(`! ${name}: ${String(error).slice(0, 200)}`); } };
const CARD = '.hc-grid .hc-card[data-card="note"]';

for (const theme of ["dark", "light"]) {
  const modern = `${theme}-modern`;
  // Notes: Choose a PIN on a Large card; the pad's ring; a note's tick boxes.
  await step("notes", async () => {
    const x = await openGrid(browser, { width: 700, theme: modern, layout: ["note", "clock", "weather"], seed: sample(), notesOptions: { iterations: 1500 }, settings: { weather: { place: LISBON } }, scale: 2 });
    try { await x.page.click(`${CARD} .hc-note-row[data-note="wifi01"]`); await x.rest(350); await x.page.click(`${CARD} .nt-lock`); await x.rest(400); await x.page.mouse.move(2, 600);
      await shot(x.page, `notes-large-choose-a-pin-${theme}`, await boxOf(x.page, CARD));
      await x.page.keyboard.press("4"); await x.rest(200); await shot(x.page, `notes-pin-pad-ring-${theme}`, await boxOf(x.page, `${CARD} .nt-lockbox`, 6));
    } finally { await x.close(); }
  });
  // Home: the Small Recent card; a folder's name on its tile; the folder tiles on a touch screen.
  await step("home", async () => {
    let x = await openGrid(browser, { width: 300, theme: modern, layout: ["needs", "recent", "running", "token"], scale: 2, news: [{ id: DOCK_SESSIONS[1].id, at: Date.now() - 60000, preview: "Done: the tide pools piece is 118 words." }] });
    try { await x.rest(400); await x.page.mouse.move(2, 700); await shot(x.page, `home-recent-small-${theme}`, await boxOf(x.page, '.hc-grid .hc-card[data-card="recent"]')); } finally { await x.close(); }
    for (const [name, b] of [["home-folders", browser], ["home-folders-touch", touch]]) {
      x = await openGrid(b, { width: 440, theme: modern, layout: ["folders", "clock"], scale: 2, touch: b === touch, folders: { choice: "", window: THIRTY_FOLDERS[0], rows: THIRTY_FOLDERS.slice(0, 9) } });
      try { await x.rest(400); if (b !== touch) await x.page.mouse.move(2, 700); await shot(x.page, `${name}-${theme}`, await boxOf(x.page, '.hc-grid .hc-card[data-card="folders"]')); } finally { await x.close(); }
    }
  });
  // Work: the Project Folder dropdown at 300px; the model menu's quiet lines; Open in browser; a command waiting.
  await step("work", async () => {
    let x = await openDock(browser, { width: 300, theme: modern, pins: [], height: 620, scale: 2 });
    try { await x.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", folders: { choice: THIRTY_FOLDERS[3].folder, window: THIRTY_FOLDERS[0], rows: THIRTY_FOLDERS } }); await x.settle();
      await x.page.click("#sessions-folder-pick"); await x.settle(); await x.page.waitForTimeout(900); await x.page.mouse.move(2, 600);
      await shot(x.page, `work-folder-dropdown-300-${theme}`, { x: 0, y: 110, width: 300, height: 260 }); } finally { await x.close(); }
    const scene = await openMapScene(browser, { width: 440, height: 760, theme: modern, open: false, capabilities: { agents_model: 1, model_fallback: 1 } });
    try { const ROUTES = [{ key: `provider_${"a".repeat(32)}`, label: "Ollama", kind: "native", base_url: "http://127.0.0.1:11434/v1", model: "qwen3.8:27b" }];
      await scene.page.click("#btn-model"); await scene.post({ type: "models", ids: ["qwen3.8:27b", "qwen3-coder"], current: "qwen3.8:27b", routes: ROUTES, currentRouteKey: ROUTES[0].key, supportsEffort: true, fallback: { offered: true, model: "", base_url: "", engine: "", route_base: "http://127.0.0.1:11434/v1" },
        agents: { offered: true, own: false, model: "qwen3-coder", base_url: "", settings_model: "qwen3-coder", settings_base_url: "", router: false } });
      await scene.page.waitForSelector("#modelmenu [data-agents-open]"); await scene.page.waitForTimeout(250); await shot(scene.page, `work-model-menu-quiet-lines-${theme}`, await boxOf(scene.page, "#modelmenu", 6));
      await scene.page.keyboard.press("Escape"); await scene.page.waitForTimeout(200);
      const card = scene.page.locator(".artifact .abtns").first(); if (await card.count()) { await card.scrollIntoViewIfNeeded(); await shot(scene.page, `work-open-in-browser-${theme}`, await boxOf(scene.page, ".artifact", 6)); }
    } finally { await scene.page.close(); }
    x = await openRunningTurn(browser, { width: 440, height: 760, theme: modern, approval: true });
    try { await x.page.mouse.move(2, 2); await shot(x.page, `work-command-waiting-${theme}`, await boxOf(x.page, ".card.perm-card", 6)); } finally { await x.page.close(); }
    x = await openRunningTurn(touch, { width: 440, height: 760, theme: modern, approval: false });
    try { await shot(x.page, `work-commentary-copy-touch-${theme}`, await boxOf(x.page, ".text.commentary", 8)); } finally { await x.page.close(); }
  });
  // The shared document card, pointed at.
  await step("doc card", async () => {
    await eachSurface(browser, { width: 460, theme }, async (name, page) => {
      if (!/card in a Work chat/.test(name)) return;
      await page.locator(".dgc-doc-card").first().hover({ position: { x: 30, y: 8 } }); await page.waitForTimeout(350);
      await shot(page, `doc-card-pointed-at-${theme}`, await boxOf(page, ".dgc-doc-card", 8));
    }).catch(() => {});
  });
  // ChatDGC: your own message on a touch screen; the Library's search and its chosen kind.
  await step("chatdgc", async () => {
    const c = await openChatDgc(touch, { width: 440, height: 760, theme: modern });
    try { await shot(c.page, `chatdgc-own-message-touch-${theme}`, await boxOf(c.page, ".cd-user", 8)); } finally { await c.page.close(); }
    const t = await openChatDgc(browser, { width: 300, height: 760, theme: modern });
    try { const sel = await t.page.evaluate(() => { const all = [...document.querySelectorAll("[title]")].filter((n) => n.checkVisibility() && n.getAttribute("title").trim().length > 8 && n.getBoundingClientRect().width > 4); all.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right); all[0].dataset.polishTip = "1"; return '[data-polish-tip="1"]'; });
      await t.page.hover(sel); await t.page.waitForTimeout(1200); await shot(t.page, `chatdgc-label-at-the-edge-${theme}`, { x: 0, y: 0, width: 300, height: 140 }); } finally { await t.page.close(); }
    const l = await openLibrary(browser, { width: 440, height: 500, theme: modern });
    try { await l.send({ type: "library", files: [], total: 0, next: null, counts: {} }); await l.send({ type: "widgetsOffered", on: true }); await l.send({ type: "artifactsOffered", on: true }); await l.send({ type: "view", view: "artifacts" }); await l.send({ type: "artifacts", items: [...ITEMS] });
      await l.page.waitForTimeout(300); await shot(l.page, `library-search-and-kinds-${theme}`, { x: 0, y: 0, width: 440, height: 170 }); } finally { await l.page.close(); }
  });
  // Pips: "Mark as read" at the window's edge; New Pip's field; a Pip's page; its chat's focus ring; its actions on touch.
  await step("pips", async () => {
    const INBOX = "pip_" + "3".repeat(32), read = `[data-pip-read="${INBOX}"]`;
    for (const width of [300, 700]) { const m = await openPipChat(browser, { width, height: 600, theme, where: width > 400 ? "tab" : "side", many: true, home: true });
      try { await m.p.waitForSelector(read); await m.p.hover(read); await m.p.waitForTimeout(1200); const b = await m.p.locator(read).boundingBox();
        await shot(m.p, `pips-mark-as-read-label-${width}-${theme}`, { x: Math.max(0, width - 300), y: Math.max(0, b.y - 70), width: Math.min(300, width), height: 130 }); } finally { await m.close(); } }
    let x = await openOnePips(browser, { width: 300, theme: modern, height: 760, scale: 2 });
    try { await x.click("#simple-new"); await x.waitIn("#review-root .dialog"); await x.page.waitForTimeout(350); await shot(x.page, `pips-new-pip-placeholder-${theme}`, { x: 0, y: 60, width: 300, height: 330 }); } finally { await x.close(); }
    x = await openOnePips(browser, { width: 440, theme: modern, height: 760, scale: 2, scene: { fix: "ready" } });
    try { await x.openPip(GST); await x.waitIn("[data-project-change]"); await x.page.waitForTimeout(300); await x.inPips((root) => root.querySelector(".diff-stat")?.scrollIntoView({ block: "center" })); await x.page.waitForTimeout(250);
      const b = await x.page.locator("#pips-host .diff-toggle").first().boundingBox(); if (b) await shot(x.page, `pips-diff-numbers-${theme}`, { x: 0, y: Math.max(0, b.y - 50), width: 440, height: 110 }); } finally { await x.close(); }
    let p = await openPipChat(browser, { settings: true, width: 440, height: 900, where: "side", theme, api: 96 });
    try { await p.p.waitForTimeout(300); await p.p.keyboard.press("Shift"); await p.p.evaluate(() => (window.__pipsRoot || document).querySelector(".msg-choice, .own-change-undo")?.focus()); await p.p.waitForTimeout(200);
      const f = await p.p.evaluate(() => { const n = (window.__pipsRoot || document).activeElement, r = n?.getBoundingClientRect(); return r ? { x: 0, y: Math.max(0, r.top - 30), width: 440, height: r.height + 60 } : null; }); if (f) await shot(p.p, `pips-chat-focus-ring-${theme}`, f);
      await p.p.evaluate(() => { const root = window.__pipsRoot || document; (root.querySelector('.pip-topbar .pip-menu [data-tab="job"]') || root.querySelector('[data-tab="job"]')).click(); }); await p.p.waitForTimeout(450);
      await p.p.mouse.move(2, 2); await shot(p.p, `pips-page-${theme}`);
      await p.p.keyboard.press("Shift"); await p.p.evaluate(() => (window.__pipsRoot || document).querySelector(".pip-page-group > button.pip-page-row")?.focus()); await p.p.waitForTimeout(200);
      const g = await p.p.evaluate(() => { const n = (window.__pipsRoot || document).activeElement, r = n?.getBoundingClientRect(); return r ? { x: 0, y: Math.max(0, r.top - 20), width: 440, height: r.height + 40 } : null; }); if (g) await shot(p.p, `pips-page-row-focus-ring-${theme}`, g);
    } finally { await p.close(); }
    p = await openPipChat(touch, { settings: true, width: 440, height: 700, where: "side", theme, api: 96, touch: true });
    try { await p.p.waitForTimeout(300); await shot(p.p, `pips-chat-actions-touch-${theme}`, { x: 0, y: 60, width: 440, height: 360 }); } finally { await p.close(); }
  });
}
await browser.close(); cleanup();
