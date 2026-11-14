// Pictures of the settings change line in a Work chat (0.52), dark and light, at 700 and 300 px: the three lines as
// they arrive (each with Undo), and answered (one still offered, one Undone, one that couldn't be undone).
//   node test/render-settings-undo.mjs [OUT_DIR]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openSettingsChanges } from "./support/settings-undo-scene.mjs";

const out = process.argv[2] || "settings-undo-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
for (const [label, theme] of [["dark", "dark-modern"], ["light", "light-modern"]]) for (const width of [700, 300]) {
  for (const [name, fresh] of [["arrived", true], ["answered", false]]) {
    const x = await openSettingsChanges(browser, { theme, width, fresh });
    await x.page.screenshot({ path: `${out}/${name}-${label}-${width}.png` });
    if (fresh) {
      // Close up, and Undo pointed at and focused.
      const line = x.page.locator("#log .setting-change").first();
      await line.scrollIntoViewIfNeeded();
      const clip = await x.page.evaluate(() => { const a = document.querySelector("#log .setting-change").getBoundingClientRect(), b = [...document.querySelectorAll("#log .setting-change")].at(-1).getBoundingClientRect();
        return { x: 0, y: Math.max(0, a.top - 12), width: document.documentElement.clientWidth, height: b.bottom - a.top + 24 }; });
      await x.page.screenshot({ path: `${out}/close-${label}-${width}.png`, clip });
      await line.locator("button").hover();
      await x.page.waitForTimeout(260);
      await x.page.locator("#log .setting-change button").nth(1).focus();
      await x.page.keyboard.press("Shift+Tab"); await x.page.keyboard.press("Tab");
      await x.page.screenshot({ path: `${out}/close-hover-focus-${label}-${width}.png`, clip });
    }
    console.log(`${out}/${name}-${label}-${width}.png`, x.errors.join("; "));
    await x.close();
  }
}
await browser.close();
