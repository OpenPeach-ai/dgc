// Pictures of the Pip report cards in a Work chat: node test/render-pip-cards.mjs <folder> [tag]
// Every sheet of test/support/pip-cards-polish-scene.mjs, dark and light at 300 and 700 px, and high contrast once.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { SHEETS, openSheet } from "./support/pip-cards-polish-scene.mjs";

const out = process.argv[2]; if (!out) { console.error("usage: node test/render-pip-cards.mjs <folder>"); process.exit(2); }
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const looks = [["dark-modern", "dark"], ["light-modern", "light"]].flatMap(([theme, word]) => [300, 700].map((width) => ({ theme, word, width })));
for (const name of Object.keys(SHEETS)) for (const look of [...looks, ...(["cards", "opened", "two-opened"].includes(name) ? [{ theme: "hc", word: "hc", width: 300 }, { theme: "hc", word: "hc", width: 700 }] : [])]) {
  const page = await openSheet(browser, name, { ...look, deviceScaleFactor: 2 });
  // The chat as far as its last block, not the empty page under it.
  const clip = await page.evaluate(() => { const log = document.getElementById("log").getBoundingClientRect(), last = [...document.getElementById("log").children].filter((n) => n.getBoundingClientRect().height > 0).at(-1).getBoundingClientRect();
    return { x: 0, y: Math.max(0, log.top), width: innerWidth, height: Math.ceil(last.bottom - Math.max(0, log.top)) + 12 }; });
  await page.screenshot({ path: join(out, `${name}-${look.word}-${look.width}.png`), clip });
  await page.close();
}
await browser.close();
