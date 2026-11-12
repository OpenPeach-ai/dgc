// Captures the fold of "Needs attention" in the Pips view (0.52, 13 Nov: it was blank in the side bar): the side bar's
// real page, dark and light, at 700 and 300 px, on the Personal and the Project tab, open and folded, each with a close
// look at the heading line; and the view as an editor tab and in forced colours. Not a test: run it with
//   PLAYWRIGHT_BROWSERS_PATH=… node test/render-pips-icons.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { openPips } from "./support/project-folder-pips-scene.mjs";
import { openChat } from "./support/pip-chat-scene.mjs";

const out = process.argv[2] || join(tmpdir(), "dgc-pips-icons-screens");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const ROOT = '(window.__pipsRoot || document.getElementById("pips-host")?.shadowRoot || document)';
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60)))));
const shots = [], problems = [];
/** The whole view, and the heading line by itself. */
async function shoot(page, name) {
  await settle(page);
  await page.screenshot({ path: join(out, `${name}.png`) }); shots.push(`${name}.png`);
  const line = await page.evaluate((root) => { const t = (0, eval)(root).querySelector(".attention-toggle:not(.attention-toggle-none)").getBoundingClientRect();
    return { x: Math.max(0, Math.floor(t.left) - 6), y: Math.floor(t.top) - 4, width: innerWidth - Math.max(0, Math.floor(t.left) - 6), height: Math.ceil(t.height) + 8 }; }, ROOT);
  await page.screenshot({ path: join(out, `${name}-line.png`), clip: line, scale: "device" }); shots.push(`${name}-line.png`);
}
const press = async (page, to) => { await page.evaluate((root) => (0, eval)(root).querySelector(".attention-toggle:not(.attention-toggle-none)").click(), ROOT);
  await page.waitForFunction(([root, v]) => (0, eval)(root).querySelector(".attention-toggle:not(.attention-toggle-none)")?.getAttribute("aria-expanded") === v, [ROOT, to]); };

for (const [tone, theme] of [["dark", "dark-modern"], ["light", "light-modern"]]) for (const width of [700, 300]) for (const tab of ["personal", "project"]) {
  const x = await openPips(browser, { theme, width, height: 520, tab, scale: 2 });
  await x.page.mouse.move(2, 2);
  await shoot(x.page, `side-${tab}-${width}-${tone}-open`);
  await press(x.page, "false");
  await shoot(x.page, `side-${tab}-${width}-${tone}-folded`);
  if (x.errors.length) problems.push(`side-${tab}-${width}-${tone}: ${x.errors.join("; ")}`);
  await x.close();
}
for (const tone of ["dark", "light"]) for (const [where, width, forced] of [["tab", 700, false], ["side", 300, true], ["tab", 700, true]]) {
  const x = await openChat(browser, { width, height: 520, theme: tone, where, home: true, waiting: 3, scale: 2, forced });
  await x.p.waitForSelector(".attention-toggle"); await x.p.mouse.move(2, 2);
  const name = `${forced ? "forced-" : ""}${where}-${width}-${tone}`;
  await shoot(x.p, `${name}-open`);
  await press(x.p, "false");
  await shoot(x.p, `${name}-folded`);
  if (x.errors.length) problems.push(`${name}: ${x.errors.join("; ")}`);
  await x.close();
}
await browser.close();
console.log(`${shots.length} pictures in ${out}`);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
