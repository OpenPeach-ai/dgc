// Captures the side bar's search fields in the buttons' shape (0.52, 13 Nov): Work's top rows (the search box, New, the
// Library row with the Project Folder dropdown) at rest and with the keyboard in the search box, Chat's, View all's, and
// the Pips view's "Search your Pips"; dark and light, at 700 and 300 px. Not a test: run it with
//   PLAYWRIGHT_BROWSERS_PATH=… node test/render-search-shape.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { openHome } from "./support/home-scene.mjs";
import { openPips } from "./support/project-folder-pips-scene.mjs";
import { listOf } from "./support/folder-row-scene.mjs";

const out = process.argv[2] || join(tmpdir(), "dgc-search-shape-screens");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const shots = [];
const shoot = async (x, name, clip) => { const path = join(out, `${name}.png`); await x.page.screenshot({ path, ...(clip ? { clip } : {}) }); shots.push(path); };
for (const [tone, theme] of [["dark", "dark-modern"], ["light", "light-modern"]]) for (const width of [700, 300]) {
  const tag = `${width}-${tone}`, top = { x: 0, y: 0, width, height: 300 };
  let x = await openHome(browser, { theme, width, height: 620, tab: "work", scale: 2, motion: "reduce" });
  await x.send(listOf(""));
  await settle(x.page);
  await shoot(x, `search-work-${tag}`, top);
  await x.page.focus("#sessions-search");
  await x.page.keyboard.type("tomato");
  await settle(x.page);
  await shoot(x, `search-work-focused-${tag}`, top);
  await x.page.fill("#sessions-search", "");
  await x.page.click("#side-tab-chat");
  await x.page.mouse.move(2, 400);
  await settle(x.page);
  await shoot(x, `search-chat-${tag}`, top);
  await x.close();
  x = await openPips(browser, { theme, width, height: 620, scale: 2, tab: "personal" });
  await shoot(x, `search-pips-${tag}`, { x: 0, y: 0, width, height: 420 });
  await x.inPips((root) => root.querySelector("#pip-search").focus());
  await x.page.keyboard.type("bed");
  await settle(x.page);
  await shoot(x, `search-pips-focused-${tag}`, { x: 0, y: 0, width, height: 420 });
  await x.close();
}
await browser.close();
console.log(shots.join("\n"));
