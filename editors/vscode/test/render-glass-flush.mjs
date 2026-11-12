// Captures the side bar's two glass bars with no line along their edges (0.52, 13 Nov): the Work page, dark and light,
// at 700 and 300 px, scrolled so that rows lie under the tab bar and under the dock's strip; each edge again enlarged;
// and the Pips list and a high contrast theme (which keeps a real line). Not a test: run it with
//   PLAYWRIGHT_BROWSERS_PATH=… node test/render-glass-flush.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { openDock } from "./support/dock-scene.mjs";
import { manySessions } from "./support/home-scene.mjs";

const out = process.argv[2] || join(tmpdir(), "dgc-glass-flush-screens");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const shots = [];
const shoot = async (x, name, clip) => { const path = join(out, `${name}.png`); await x.page.screenshot({ path, ...(clip ? { clip } : {}) }); shots.push(path); };
/** Scrolls the page part way, so a row lies across each bar's edge. */
const under = (x) => x.page.evaluate(() => { const pips = document.body.classList.contains("pips-active"), s = pips ? document.getElementById("pips-host").shadowRoot.querySelector(".pip-app-root") : document.getElementById("sessions-host");
  s.scrollTop = Math.min(46, s.scrollHeight - s.clientHeight); return s.scrollTop; });
for (const [tone, theme] of [["dark", "dark-modern"], ["light", "light-modern"], ["high-contrast", "hc"]]) for (const width of [700, 300]) {
  if (tone === "high-contrast" && width === 700) continue;
  for (const view of tone === "high-contrast" ? ["work"] : ["work", "pips"]) {
    // (A short side bar, so Work's few rows are longer than it and scroll under both bars.)
    const x = await openDock(browser, { height: view === "work" ? 400 : 620, width, theme, tab: "work", sessions: manySessions(40), scale: 2, pip: { many: true, rows: 9 } });
    if (view === "pips") { await x.page.click("#side-tab-pips"); await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot?.querySelector("[data-job]")); }
    await x.page.mouse.move(2, 200);
    await x.settle();
    await under(x);
    await x.settle();
    await shoot(x, `glass-${view}-${width}-${tone}`);
    const e = await x.page.evaluate(() => [document.getElementById("side-tabs").getBoundingClientRect().bottom, document.getElementById("dgc-dock").getBoundingClientRect().top]);
    await shoot(x, `glass-${view}-${width}-${tone}-tab-bar-edge`, { x: 0, y: e[0] - 24, width: Math.min(width, 300), height: 48 });
    await shoot(x, `glass-${view}-${width}-${tone}-dock-edge`, { x: 0, y: e[1] - 24, width: Math.min(width, 300), height: 48 });
    await x.close();
  }
}
await browser.close();
console.log(shots.join("\n"));
