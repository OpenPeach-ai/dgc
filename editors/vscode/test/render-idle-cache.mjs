// Pictures of an idle Work chat with its line (0.52), dark and light, at 700 and 300 px: a long last reply and, at
// the end, "Idle 1d 17h. The prompt cache has likely expired, so your next message will re-cache about 524k tokens."
//   node test/render-idle-cache.mjs [OUT_DIR]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openIdle } from "./support/idle-cache-scene.mjs";

const out = process.argv[2] || "idle-cache-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
for (const [label, theme] of [["dark", "dark-modern"], ["light", "light-modern"]]) for (const width of [700, 300]) {
  const x = await openIdle(browser, { theme, width, height: 760 });
  await x.page.mouse.move(2, 2);
  await x.page.waitForTimeout(250);
  await x.page.screenshot({ path: `${out}/idle-${label}-${width}.png` });
  console.log(`${out}/idle-${label}-${width}.png`);
  await x.close();
}
await browser.close();
