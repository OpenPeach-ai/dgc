import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The Stop buttons in the /monitors and /artifact listing cards, in a real browser. Every .abtn rule
// was scoped to `.artifact`, and these rows live in a plain `.card`, so their buttons fell back to
// the browser's own light grey button with an outset border in the dark panel, and the rows were not
// even laid out as rows.
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, page;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");

before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  const mainJs = readFileSync(here + "/../media/main.js", "utf8");
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map(m => m[0])
    .find(c => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  page = await browser.newPage({ viewport: { width: 460, height: 800 } });
  await page.setContent(skeleton.replace("</head>", `<style>${css}</style></head>`), { waitUntil: "load" });
  await page.evaluate((mjs) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    window.DgcMarkdown = { render: (s) => String(s), linkTarget: () => null };
    eval(mjs);
    window.postMessage({ type: "session_ready", sessionId: "s1" }, "*");
    const event = (data) => window.postMessage({ type: "event", event: data }, "*");
    event({ type: "monitors", request_id: "monitors-list-1-1", wake_paused: false, pending_events: 0, items: [
      { id: "mon1", description: "ticker", command: "./tick.sh 4", state: "running", events: 75 },
      { id: "mon2", description: "build", command: "make", state: "ended", events: 1, end_reason: "exited" }] });
    event({ type: "artifacts", items: [{ id: "a1", name: "preview", url: "http://127.0.0.1:5173/" }] });
  }, mainJs);
  await page.waitForTimeout(200);
});
after(async () => { await browser?.close(); });

for (const [name, selector] of [["/monitors", ".monitor-list-row"], ["/artifact", ".artifact-list-row"]]) {
  test(`the ${name} listing card's buttons use the panel's button style, in a row`, async (t) => {
    if (skipReason()) return t.skip(skipReason());
    const style = await page.evaluate((rowSelector) => {
      const row = document.querySelector(rowSelector);
      const stop = [...row.querySelectorAll("button")].find((b) => b.textContent === "Stop");
      const cs = getComputedStyle(stop), panel = getComputedStyle(document.body);
      return { background: cs.backgroundColor, color: cs.color, border: cs.borderTopStyle,
               text: panel.color, row: getComputedStyle(row).display };
    }, selector);
    if (process.env.DGC_SHOT_DIR) {
      const card = await page.evaluate((rowSelector) => { const r = document.querySelector(rowSelector).closest(".card").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, selector);
      await page.screenshot({ path: `${process.env.DGC_SHOT_DIR}/card-buttons-${name.slice(1)}.png`, clip: card });
    }
    assert.notEqual(style.background, "rgb(239, 239, 239)", `not the browser's default button (${JSON.stringify(style)})`);
    assert.notEqual(style.border, "outset", `no outset border (${JSON.stringify(style)})`);
    assert.equal(style.row, "flex", "the text and its buttons sit in one row");
  });
}
