// Pictures of a Pip's computer tab after Stop computer (user test P12), in real Chromium on the real client and viewer
// (test/support/pip-computer-scene.mjs), with the closing stream saying what DGC's really says ("[Errno 2] No such
// file or directory"): dark and light, at 300, 440 and 700 px. With DGC_PIPS_SRC set to another tree's src folder the
// pictures are of that tree: the tab as it was. Not a test.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-pip-computer-stop.mjs <folder to write into>
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openComputer } from "./support/pip-computer-scene.mjs";

const out = process.argv[2];
if (!out) throw new Error("say where the pictures go");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
for (const theme of ["dark", "light"]) for (const width of [700, 440, 300]) {
  const x = await openComputer(browser, { theme, width, height: 560, stopReason: "[Errno 2] No such file or directory" });
  await x.p.evaluate(() => { const b = document.getElementById("pc-stop"); if (b?.checkVisibility()) b.click(); else document.getElementById("pc-more")?.click(); });
  if (await x.p.evaluate(() => !window.__sent.some((r) => r.type === "stop_pip_computer"))) { await x.p.waitForTimeout(150); await x.p.evaluate(() => [...document.querySelectorAll("button, [role=menuitem]")].find((b) => /Stop computer/.test(b.textContent) && b.checkVisibility())?.click()); }
  await x.p.waitForFunction(() => !!document.querySelector("#pc-overlay .pc-overlay-card")); await x.p.waitForTimeout(400);
  await x.p.mouse.move(2, 2);
  await x.p.screenshot({ path: `${out}/stop-computer-${theme}-${width}.png` }); console.log(`stop-computer-${theme}-${width}`);
  await x.close();
}
await browser.close();
