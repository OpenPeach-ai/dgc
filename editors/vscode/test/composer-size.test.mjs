import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// The prompt box grows with its text, and that measurement needs a real layout. A turn that stopped
// while the founder was on another view restarted the backend, which restores the draft and resizes
// the box — measured while the panel was hidden, it came back 160px tall and empty (collapsed to zero
// width) or 0px (display:none). Only a real browser lays text out, so these run in Chromium.
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, page;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");
const WIDTH = 460;

before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  const mainJs = readFileSync(here + "/../media/main.js", "utf8");
  const markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map(m => m[0])
    .find(c => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
  await page.setContent(skeleton.replace("</head>", `<style>${css}</style></head>`), { waitUntil: "load" });
  await page.evaluate(([mjs, mdjs]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    window.postMessage({ type: "session_ready", sessionId: "s1" }, "*");
  }, [mainJs, markdownJs]);
  await page.waitForTimeout(150);
});
after(async () => { await browser?.close(); });

const height = () => page.evaluate(() => Math.round(document.getElementById("input").getBoundingClientRect().height));
const settle = () => page.waitForTimeout(250);
// What a stopped turn delivers while the panel is not on screen: the turn ends, the restarted
// backend announces the session again, and the draft is restored into the box.
const stopAndRestart = () => page.evaluate(() => {
  window.postMessage({ type: "event", event: { type: "turn_end", turn_id: "t1", reason: "cancelled", final_message_id: null } }, "*");
  window.postMessage({ type: "session_ready", sessionId: "s1" }, "*");
});
const hiddenWays = {
  "collapsed to zero width": [() => page.setViewportSize({ width: 1, height: 800 }), () => page.setViewportSize({ width: WIDTH, height: 800 })],
  "display:none": [() => page.evaluate(() => { document.body.style.display = "none"; }), () => page.evaluate(() => { document.body.style.display = ""; })],
};

for (const [way, [hide, show]] of Object.entries(hiddenWays)) {
  test(`an empty prompt box keeps its one-line height after a stop while the panel was ${way}`, async (t) => {
    if (skipReason()) return t.skip(skipReason());
    const normal = await height();
    assert.ok(normal > 0 && normal < 40, `one line to begin with (${normal}px)`);
    await hide(); await stopAndRestart(); await settle(); await show(); await settle();
    assert.equal(await height(), normal);
  });
}

test("a multi-line draft comes back at its real height, not collapsed or maxed out", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await page.click("#input");
  await page.keyboard.type("line one");
  for (const line of ["line two", "line three", "line four"]) { await page.keyboard.press("Shift+Enter"); await page.keyboard.type(line); }
  await settle();
  const drafted = await height();
  assert.ok(drafted > 40 && drafted < 160, `four lines sit between one line and the cap (${drafted}px)`);
  const [hide, show] = hiddenWays["collapsed to zero width"];
  await hide(); await stopAndRestart(); await settle(); await show(); await settle();
  assert.equal(await height(), drafted);
  await page.evaluate(() => { const box = document.getElementById("input"); box.select(); document.execCommand("delete"); });
  await settle();
});

test("typing still grows the box up to its 160px cap", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await page.click("#input");
  for (let i = 0; i < 14; i += 1) { await page.keyboard.type(`row ${i}`); await page.keyboard.press("Shift+Enter"); }
  await settle();
  assert.equal(await height(), 160);
  await page.evaluate(() => { const box = document.getElementById("input"); box.select(); document.execCommand("delete"); });
});
