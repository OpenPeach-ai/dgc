// Pictures of a goal's end and a session's goal history in Work (0.52), dark and light, at 700 and 300 px: the one
// quiet line under the goal's last turn, the "Goals" pill "/goal-history" adds to the bar, and its list open.
//   node test/render-goal-history.mjs [OUT_DIR]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openGoals } from "./support/goal-history-scene.mjs";

const out = process.argv[2] || "goal-history-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
for (const [label, theme] of [["dark", "dark-modern"], ["light", "light-modern"]]) for (const width of [700, 300]) {
  const line = await openGoals(browser, { theme, width });
  await line.page.mouse.move(2, 2);
  await line.page.screenshot({ path: `${out}/end-line-${label}-${width}.png` });
  await line.close();
  const list = await openGoals(browser, { theme, width, list: true });
  await list.page.mouse.move(2, 2);
  await list.page.screenshot({ path: `${out}/goals-list-${label}-${width}.png` });
  // The pill by itself: the list closed (Esc), the pill still on the bar.
  await list.page.keyboard.press("Escape");
  await list.settle();
  await list.page.screenshot({ path: `${out}/goals-pill-${label}-${width}.png` });
  console.log(`${out}/*-${label}-${width}.png`, [...line.errors, ...list.errors].join("; "));
  await list.close();
}
await browser.close();
