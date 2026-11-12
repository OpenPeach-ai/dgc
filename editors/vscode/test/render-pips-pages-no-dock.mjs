// Pictures of the side bar's Pips view: node test/render-pips-pages-no-dock.mjs <out dir>.
// Dark and light, at 700 and 300 px: the list of Pips (with the dock and the tab bar), then Pips settings and Needs
// attention's View all, which have a back arrow and so neither. The side bar's real page (test/support/dock-scene.mjs).
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openDock } from "./support/dock-scene.mjs";

const [out] = process.argv.slice(2);
if (!out) { console.error("usage: node test/render-pips-pages-no-dock.mjs <out dir>"); process.exit(2); }
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const inRoot = (x, selector) => x.page.waitForFunction((s) => !!document.getElementById("pips-host").shadowRoot?.querySelector(s), selector);
const press = (x, selector) => x.page.evaluate((s) => document.getElementById("pips-host").shadowRoot.querySelector(s).click(), selector);
for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  const x = await openDock(browser, { width, height: 700, theme, pip: { setups: 2, waiting: 9, home: true } });
  const shot = async (name) => { await x.settle(); await x.page.mouse.move(2, 2); await x.page.waitForTimeout(250); await x.page.screenshot({ path: `${out}/pips-${name}-${theme.split("-")[0]}-${width}.png` }); };
  await x.page.click("#side-tab-pips"); await inRoot(x, "[data-job]"); await inRoot(x, "#attention-view-all");
  await shot("list");
  await press(x, "#pips-settings-open"); await inRoot(x, "#pips-settings-close");
  await shot("settings");
  await press(x, "#pips-settings-close"); await inRoot(x, "[data-job]");
  await press(x, "#attention-view-all"); await inRoot(x, ".attention-all");
  await shot("view-all");
  if (x.errors.length) console.error(theme, width, x.errors);
  await x.close();
}
await browser.close();
