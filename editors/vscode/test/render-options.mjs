// Capture the question card in real Chromium: the full matrix (300/460 x 480/620/900 x
// dark-modern/light-modern/hc) plus the named states, as PNGs to look at. Not part of `npm test`.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-options.mjs <out-dir>
import { mkdirSync } from "node:fs";
import { HEAVY_QUESTIONS, openScene } from "./support/options-scene.mjs";

const out = process.argv[2] || "options-shots";
mkdirSync(out, { recursive: true });
const { chromium } = await import("@playwright/test");
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const report = [];

const only = process.argv[3] || "";          // optional substring: capture only matching names
async function capture(name, options) {
  if (only && !name.includes(only)) return;
  const { page, errors } = await openScene(browser, options);
  const geometry = await page.evaluate(() => {
    const box = (selector) => { const node = document.querySelector(selector); if (!node) return null;
      const r = node.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height) }; };
    return { log: box("#log"), card: box("#cbox > .ask"), send: box("#send"), overflowX: document.documentElement.scrollWidth > innerWidth };
  });
  await page.screenshot({ path: `${out}/${name}.png` });
  report.push({ name, ...geometry, errors });
  await page.close();
}

for (const width of [300, 460]) {
  for (const height of [480, 620, 900]) {
    for (const theme of ["dark-modern", "light-modern", "hc"]) {
      await capture(`matrix-${theme}-${width}x${height}`, { width, height, theme });
    }
  }
}
await capture("docked-q1-dark-300x620", { width: 300, height: 620, theme: "dark-modern" });
await capture("docked-q1-light-460x620", { width: 460, height: 620, theme: "light-modern" });
await capture("docked-short-dark-300x480", { width: 300, height: 480, theme: "dark-modern" });
await capture("docked-multi-dark-300x620", { width: 300, height: 620, theme: "dark-modern", scenario: "multi" });
await capture("docked-other-typing-dark-300x620", { width: 300, height: 620, theme: "dark-modern", scenario: "other" });
await capture("docked-hc-460x900", { width: 460, height: 900, theme: "hc" });
await capture("answered-row-dark-300", { width: 300, height: 620, theme: "dark-modern", scenario: "answered", rails: false });
await capture("answered-row-light-460", { width: 460, height: 620, theme: "light-modern", scenario: "answered", rails: false });
await capture("sending-rejected-dark-460", { width: 460, height: 620, theme: "dark-modern", scenario: "rejected" });
await capture("heavy-dark-300x480", { width: 300, height: 480, theme: "dark-modern", questions: HEAVY_QUESTIONS });
await capture("heavy-dark-300x620", { width: 300, height: 620, theme: "dark-modern", questions: HEAVY_QUESTIONS });
await capture("heavy-light-460x620", { width: 460, height: 620, theme: "light-modern", questions: HEAVY_QUESTIONS });
await capture("forced-hc-460x900", { width: 460, height: 900, theme: "hc", forcedColors: true });
await capture("sending-rejected-light-300x620", { width: 300, height: 620, theme: "light-modern", scenario: "rejected" });
await capture("docked-q1-dark-900w", { width: 900, height: 700, theme: "dark-modern" });
await capture("docked-q1-light-900w", { width: 900, height: 700, theme: "light-modern" });
await capture("answered-row-dark-900w", { width: 900, height: 700, theme: "dark-modern", scenario: "answered", rails: false });
await browser.close();
for (const row of report) console.log(JSON.stringify(row));
