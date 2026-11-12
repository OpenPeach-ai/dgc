// Pictures of a Personal Pip's goal card (pips-15), dark and light, at 700 and 300 px: working, waiting for you, done
// with its evidence open, and blocked.
//   node test/render-pip-goal.mjs [OUT_DIR]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { GOAL_STATES, openGoal } from "./support/pip-goal-scene.mjs";

const out = process.argv[2] || "pip-goal-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
for (const theme of ["dark", "light"]) for (const width of [700, 300]) for (const state of Object.keys(GOAL_STATES)) {
  const x = await openGoal(browser, { theme, width, state });
  await x.p.mouse.move(2, 2);
  await x.p.screenshot({ path: `${out}/goal-${state}-${theme}-${width}.png` });
  console.log(`${out}/goal-${state}-${theme}-${width}.png`, x.errors.join("; "));
  await x.close();
}
await browser.close();
