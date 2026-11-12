// Pictures of the surfaces whose marks moved to the middle: node test/render-marks-centred.mjs <out dir> <before|after>.
// (test/support/marks-centred-scene.mjs opens them; each picture is the mark's row, enlarged.)
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { eachSurface } from "./support/marks-centred-scene.mjs";

const [out, label] = process.argv.slice(2);
if (!out || !label) { console.error("usage: node test/render-marks-centred.mjs <out dir> <before|after>"); process.exit(2); }
mkdirSync(out, { recursive: true });
const WANTED = { "a Pip's computer menu": "computer-menu", "the computer tab's slim bar": "computer-bar", "“Showing <name> in another tab”": "showing-elsewhere" };
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  await eachSurface(browser, { width, theme }, async (name, page, scope) => {
    if (!WANTED[name] || (name === "a Pip's computer menu") !== (width === 300)) return;   // the menu in the side bar; the computer's tab wide
    const box = await page.evaluate((s) => { const r = (window.__pipsRoot || document).querySelector(s).getBoundingClientRect(); return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: Math.min(r.width + 16, 420), height: Math.min(r.height + 16, 260) }; }, scope);
    await page.screenshot({ path: `${out}/${WANTED[name]}-${theme}-${label}.png`, clip: box });
  });
}
await browser.close();
