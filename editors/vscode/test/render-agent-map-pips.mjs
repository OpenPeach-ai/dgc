// Pictures of the agent map's Pips section in real Chromium, dark and light, at 300 and 700 px (a side bar and a wide
// one), with the section open and hidden. Not part of `npm test`.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-agent-map-pips.mjs <out-dir>
import { mkdirSync } from "node:fs";
import { measurePips, openPipsMapScene } from "./support/agent-map-pips-scene.mjs";

const out = process.argv[2] || "agent-map-pips-shots";
mkdirSync(out, { recursive: true });
const { chromium } = await import("@playwright/test");
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const report = [];
for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [300, 700]) {
    const { page, errors } = await openPipsMapScene(browser, { width, height: 760, theme });
    const name = `${theme.split("-")[0]}-${width}`;
    await page.evaluate(() => document.getElementById("agent-map-pips").scrollIntoView({ block: "end" }));
    await page.screenshot({ path: `${out}/${name}.png` });
    const m = await measurePips(page);
    report.push({ name, pageOverflow: m.pageOverflow, bodyOverflow: m.bodyOverflow, rows: m.rows.length, errors });
    await page.click("#agent-map-pips-toggle");
    await page.waitForTimeout(60);
    await page.screenshot({ path: `${out}/${name}-hidden.png` });
    await page.close();
  }
}
await browser.close();
console.log(JSON.stringify(report, null, 2));
