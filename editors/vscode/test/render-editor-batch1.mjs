// The pictures of editor batch 1 (not a test): the stuck row in Settings › Running sessions and the bar's "Stop it and
// open here"; Dev Mode's "Let DGC change Dev Mode settings" (the switch, and the warning's tick box); the "Open" pop-up
// (a stand-in: the editor draws the real one itself); and "What's new in 0.52", every slide. Dark and light, at 300 and
// 700 px (What's new also in high contrast). Usage: node test/render-editor-batch1.mjs <out folder>
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openRunning, openSettings, DEV_TABLE } from "./support/settings-scene.mjs";
import { openWorkTab } from "./support/work-tab-scene.mjs";
import { openHome } from "./support/home-scene.mjs";
import { artifactsModule } from "./support/artifact-scene.mjs";

const out = process.argv[2] || "/tmp/claude-1000/editor-batch1-pictures";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const WIDTHS = [300, 700];
const at = (h, m, s = 0) => Date.UTC(2026, 10, 13, h, m, s);

// ---- 1. the stuck holder -------------------------------------------------------------------------------------------
const live = { pid: 4242, instance: "c0ffee", session: "20261113-101500-a1", name: "Fix the narrow settings layout", cwd: "/home/me/notes-app", windowless_s: 400, working: true, work: "running the tests", version: "0.52.0" };
const held = { pid: 2142044, instance: "ab12cd34", session: "20260930-050447-c62af3b6", name: "toni_fabrics audit", cwd: "/home/me/toni_fabrics", windowless_s: 4600, working: true,
  work: "running the nightly audit", version: "0.51.0", stuck: true, since: at(12, 0, 13) };
for (const theme of ["dark", "light"]) for (const width of WIDTHS) {
  const x = await openRunning(browser, { items: [live, held], width, theme, height: 620, scale: 2 });
  await x.rest(200);
  await x.page.screenshot({ path: `${out}/1-running-sessions-${width}-${theme}.png` });
  await x.close();
}
// (The bar says times on the reader's clock; these pages are drawn in this computer's own zone.)
const here = (h, m, sec) => new Date(2026, 10, 13, h, m, sec).getTime();
const FACTS = { place: "a DGC with no window", since: here(11, 53, 29), working: true, heartbeat: here(12, 0, 13) };
for (const theme of ["dark-modern", "light-modern"]) for (const width of WIDTHS) {
  const t = theme.split("-")[0];
  for (const [name, bar] of [["stop-and-open-here", { stuck: FACTS, stop: true }], ["live-holder", { note: { head: "Open in Cursor · ~/toni_fabrics · idle 6 min.", detail: "" } }],
                             ["not-stopped", { stuck: FACTS, stop: true, stopNote: "It was not stopped: this computer cannot confirm that process is still the DGC that left the note." }]]) {
    if (name === "not-stopped" && width !== 300) continue;
    const x = await openWorkTab(browser, { width, height: 420, theme });
    await x.send({ type: "event", event: { type: "ready", version: "0.52.0", protocol_version: 14, capabilities: {}, model: "qwen3.5-coder:32b", mode: "default", think: "off" } });
    await x.send({ type: "session_ready", sessionId: held.session });
    await x.send({ type: "session_elsewhere", state: "elsewhere", ...bar });
    await x.page.waitForTimeout(250);
    await x.page.screenshot({ path: `${out}/1-open-here-${name}-${width}-${t}.png` });
    await x.page.close();
  }
}

// ---- 2. Dev Mode: Let DGC change Dev Mode settings ----------------------------------------------------------------
const DEV = { dev_limits_table: DEV_TABLE, dev_tools_capable: true };
for (const theme of ["dark", "light"]) for (const width of WIDTHS) {
  let x = await openSettings(browser, { extra: { ...DEV, dev_mode: true, dev_mode_warned: true, dev_mode_tools: true, dev_limits: { pips_parallel_runs: 8 } }, section: "dev", theme, width, height: width === 300 ? 860 : 620, scale: 2 });
  await x.page.waitForSelector("#dev_mode_tools"); await x.rest(200);
  await x.page.screenshot({ path: `${out}/2-dev-mode-switch-${width}-${theme}.png` });
  await x.close();
  x = await openSettings(browser, { extra: { ...DEV, dev_mode: true }, section: "dev", theme, width, height: width === 300 ? 980 : 660, scale: 2 });
  await x.page.waitForSelector("#dev-warning-tools"); await x.page.check("#dev-warning-tools"); await x.rest(200);
  await x.page.screenshot({ path: `${out}/2-dev-mode-turn-on-${width}-${theme}.png` });
  await x.close();
}

// ---- 3. the "Open" pop-up: a stand-in ------------------------------------------------------------------------------
// The editor draws its own notifications, and no editor window is opened here: this is a drawing of one, with the words
// the extension really sends (madeWords) and its one button. It shows the words, not the editor's pixels.
globalThis.__DGC_ART_VSCODE = {};
const { madeWords } = artifactsModule();
const toast = (theme, lines) => `<!doctype html><meta charset="utf-8"><body style="margin:0;font:13px/1.4 system-ui,sans-serif;background:${theme === "dark" ? "#1f1f1f" : "#ffffff"};color:${theme === "dark" ? "#cccccc" : "#3b3b3b"}">
<p style="margin:10px 12px 0;font-size:11px;opacity:.75">Stand-in drawing (the editor draws the real notification): the words and the button are the extension's own.</p>
<div style="display:flex;flex-direction:column;gap:10px;padding:12px">${lines.map((l) => `<div style="box-sizing:border-box;max-width:450px;padding:10px 12px;border:1px solid ${theme === "dark" ? "#454545" : "#d4d4d4"};border-radius:4px;background:${theme === "dark" ? "#252526" : "#f8f8f8"};box-shadow:0 2px 8px rgba(0,0,0,.25)">
<div style="display:flex;gap:8px;align-items:flex-start"><span style="flex:none;width:16px;height:16px;border-radius:50%;background:#3794ff;color:#fff;font:700 11px/16px system-ui;text-align:center">i</span><span style="flex:1;min-width:0;overflow-wrap:anywhere">${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span></div>
<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:8px"><span style="font-size:11px;opacity:.7">Source: Vibe DGC</span><span style="padding:3px 12px;border-radius:2px;background:#0e639c;color:#fff">Open</span></div></div>`).join("")}</div></body>`;
for (const theme of ["dark", "light"]) for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 260 }, deviceScaleFactor: 2 });
  await page.setContent(toast(theme, [madeWords("Q3 plan", false), madeWords("Rent or buy, in one page, with every number the bank sent and the two that it did not, for the Saturday call", true)]));
  await page.screenshot({ path: `${out}/3-open-popup-stand-in-${width}-${theme}.png` });
  await page.close();
}

// ---- 4. What's new in 0.52 -----------------------------------------------------------------------------------------
for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of WIDTHS) {
  const t = theme === "hc" ? "hc" : theme.split("-")[0];
  const x = await openHome(browser, { width, height: width === 300 ? 640 : 760, theme, scale: 2, grid: true });
  await x.send({ type: "whatsNew", auto: true, release: "0.52" });
  await x.page.waitForSelector("#whats-new:not([hidden])");
  for (let i = 1; i <= 6; i++) {
    if (theme === "hc" && ![1, 3].includes(i)) { await x.page.click("#whats-new .wn-next").catch(() => {}); continue; }
    await x.page.mouse.move(2, 2); await x.page.waitForTimeout(350);
    await x.page.screenshot({ path: `${out}/4-whats-new-slide-${i}-${width}-${t}.png` });
    if (i < 6) await x.page.click("#whats-new .wn-next");
  }
  await x.close();
}
await browser.close();
console.log(out);
