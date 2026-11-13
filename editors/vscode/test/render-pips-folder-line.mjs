// Pictures of the Pips view's Project tab with the Project Folder dropdown on its own line, and of the Needs attention
// heading with its Hide / Show word (0.52, 13 Nov), in real Chromium: the side bar's real page
// (test/support/project-folder-pips-scene.mjs) at 700 and 300 px, dark and light. Not a test.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-pips-folder-line.mjs <folder to write into>
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { HERE, openPips } from "./support/project-folder-pips-scene.mjs";

const out = process.argv[2];
if (!out) throw new Error("say where the pictures go");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const shot = async (x, name) => { await x.page.mouse.move(2, 2); await settle(x.page); await x.page.screenshot({ path: `${out}/${name}.png` }); console.log(name); };
for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  const tag = `${theme}-${width}`, opts = { theme: `${theme}-modern`, width, height: 620, scale: 2 };
  // The Project tab with cards (two wait: View all, then Hide), then folded, then the dropdown open.
  let x = await openPips(browser, { ...opts, stray: true });
  await shot(x, `project-cards-${tag}`);
  await x.inPips((root) => root.querySelector("#attention-toggle").click());
  await x.page.waitForFunction(() => document.getElementById("pips-host").shadowRoot.querySelector("#attention-toggle")?.getAttribute("aria-expanded") === "false");
  await shot(x, `project-folded-${tag}`);
  await x.inPips((root) => root.querySelector("#attention-toggle").click());
  await x.page.waitForFunction(() => document.getElementById("pips-host").shadowRoot.querySelector("#attention-toggle")?.getAttribute("aria-expanded") === "true");
  await x.inPips((root) => root.querySelector("#pips-folder-pick").click());
  await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot.querySelector(".dgc-folder-menu"));
  await x.page.waitForTimeout(500);
  await shot(x, `project-menu-open-${tag}`);
  await x.close();
  // One card (no View all): the heading line with Hide alone.
  x = await openPips(browser, opts);
  await shot(x, `project-one-card-${tag}`);
  await x.close();
  // Nothing waits in the folder chosen: the dropdown's line, then the list.
  x = await openPips(browser, { ...opts, choice: HERE });
  await shot(x, `project-none-${tag}`);
  await x.close();
  // The Personal tab: no dropdown; the heading with its word.
  x = await openPips(browser, { ...opts, tab: "personal" });
  await shot(x, `personal-heading-${tag}`);
  await x.close();
}
await browser.close();
