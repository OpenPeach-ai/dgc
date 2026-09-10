// Does the transcript hold its place? Build a long chat in a real browser, scroll up mid-turn,
// let the turn finish, and fail if the viewport moved or if the scrollbar is describing a
// different transcript from the one on screen.
//
//   npm run scroll-check
//
// This needs layout, so it cannot live in the jsdom suite. The bug it pins: `#log` is a column
// flex container, so a block whose rendering the browser skips has no content, an automatic
// minimum size of zero, and `flex-shrink: 1` — it collapsed to nothing, the page got shorter,
// and scrolling up threw you to the top.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildSync } from "esbuild";
const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
const css = readFileSync(here + "/../media/main.css", "utf8");
const mainJs = readFileSync(here + "/../media/main.js", "utf8");
const markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
  format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
const candidates = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map(m => m[0]);
const skeleton = candidates.find(c => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
const html = skeleton.replace("</head>", `<style>${css}</style></head>`);
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 460, height: 700 } });
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(([mjs, mdjs]) => {
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
  eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
  eval(mjs);
}, [mainJs, markdownJs]);
const send = (e) => page.evaluate(ev => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: ev } })), e);
await send({ type: "ready", capabilities: {}, model: "m", mode: "default", think: "off", commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
const para = "The bounds were swapped and every value came back pinned to the wrong end. ".repeat(14);
for (let i = 0; i < 8; i++) {
  await send({ type: "turn_start", turn_id: "t" + i, prompt: "Turn " + i + " please" });
  await send({ type: "text_delta", text: para + "\n" });
  await send({ type: "turn_end", turn_id: "t" + i, reason: "completed", token_estimate: 10 });
}
// One more turn, still running, long enough that its own top scrolls out of view.
await send({ type: "turn_start", turn_id: "live", prompt: "The live turn" });
await send({ type: "text_delta", text: para + para + "\n" });
await page.waitForTimeout(300);
const read = () => page.evaluate(() => {
  const log = document.getElementById("log");
  return { top: Math.round(log.scrollTop), height: Math.round(log.scrollHeight), client: log.clientHeight };
});
await page.evaluate(() => { const l = document.getElementById("log"); l.scrollTop = l.scrollHeight; });
await page.waitForTimeout(150);
const atEnd = await read();
await page.evaluate(() => { document.getElementById("log").scrollTop -= 200; });   // "slightly scroll up"
await page.waitForTimeout(250);
const scrolledUp = await read();
await send({ type: "turn_end", turn_id: "live", reason: "completed", token_estimate: 10 });
await page.waitForTimeout(400);
const afterEnd = await read();
console.log("at bottom      ", JSON.stringify(atEnd));
console.log("scrolled up 200", JSON.stringify(scrolledUp));
console.log("after turn_end ", JSON.stringify(afterEnd));
const drift = Math.abs(scrolledUp.top - afterEnd.top);
const blocks = await page.evaluate(() => {
  const log = document.getElementById("log");
  const rows = [...log.querySelectorAll(":scope > *")].map(n => ({
    cls: n.className || n.tagName, pin: n.style?.containIntrinsicSize || "-",
    rect: Math.round(n.getBoundingClientRect().height),
    cv: getComputedStyle(n).contentVisibility,
    cis: getComputedStyle(n).containIntrinsicSize,
    contain: getComputedStyle(n).contain, disp: getComputedStyle(n).display }));
  const cs = getComputedStyle(log);
  const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    + parseFloat(cs.rowGap || 0) * Math.max(0, rows.length - 1);
  return { sum: rows.reduce((a, r) => a + r.rect, 0), chrome: Math.round(chrome),
           scrollHeight: Math.round(log.scrollHeight), rows };
});
console.log("sum of block rects", blocks.sum, "scrollHeight", blocks.scrollHeight);
if (process.argv.includes("--verbose")) blocks.rows.forEach((r, i) =>
  console.log(String(i).padStart(2), r.cls.padEnd(24), "rect", String(r.rect).padStart(4), "pin", r.pin));
const honest = Math.abs(blocks.sum + blocks.chrome - blocks.scrollHeight) < 24;
console.log(`drift ${drift}px \u00b7 block heights sum to ${blocks.sum} of ${blocks.scrollHeight}`);
await browser.close();
if (drift > 8) { console.error(`FAIL: the transcript moved ${drift}px when the turn ended`); process.exit(1); }
if (!honest) { console.error("FAIL: the scrollbar describes a different length from the blocks on screen"); process.exit(1); }
console.log("ok: the transcript holds its place and reports its real length");
