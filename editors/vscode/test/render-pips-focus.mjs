// Captures the fold of "Needs attention" with the keyboard on it after it redraws (0.52, 13 Nov: Enter or Space on it
// dropped the focus): the side bar's real page at 300 px, dark and light, on the Personal tab; folded by Enter, then
// opened by Space, each with a close look at the heading line. Keyboard only. Not a test: run it with
//   PLAYWRIGHT_BROWSERS_PATH=… node test/render-pips-focus.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { openPips } from "./support/project-folder-pips-scene.mjs";

const out = process.argv[2] || join(tmpdir(), "dgc-pips-focus-screens");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const ROOT = 'document.getElementById("pips-host").shadowRoot', FOLD = ".attention-toggle:not(.attention-toggle-none)";
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60)))));
const shots = [], problems = [];
async function shoot(page, name, expanded) {
  await page.waitForFunction(([root, s, v]) => (0, eval)(root).querySelector(s)?.getAttribute("aria-expanded") === v, [ROOT, FOLD, expanded]);
  await settle(page);
  const on = await page.evaluate(([root, s]) => { const r = (0, eval)(root), a = r.activeElement; return { fold: !!a && a === r.querySelector(s), ring: !!a && a.matches(":focus-visible"), expanded: a?.getAttribute("aria-expanded") }; }, [ROOT, FOLD]);
  if (!on.fold || !on.ring || on.expanded !== expanded) problems.push(`${name}: the keyboard is not on the fold: ${JSON.stringify(on)}`);
  await page.screenshot({ path: join(out, `${name}.png`) }); shots.push(`${name}.png`);
  const line = await page.evaluate(([root, s]) => { const t = (0, eval)(root).querySelector(s).getBoundingClientRect();
    return { x: 0, y: Math.max(0, Math.floor(t.top) - 8), width: innerWidth, height: Math.ceil(t.height) + 16 }; }, [ROOT, FOLD]);
  await page.screenshot({ path: join(out, `${name}-line.png`), clip: line, scale: "device" }); shots.push(`${name}-line.png`);
}
for (const [tone, theme] of [["dark", "dark-modern"], ["light", "light-modern"]]) {
  const x = await openPips(browser, { theme, width: 300, height: 520, tab: "personal", scale: 2 });
  await x.page.mouse.move(2, 2);
  // By Tab alone to the fold.
  for (let i = 0; i < 60; i++) { if (await x.page.evaluate(([root, s]) => { const r = (0, eval)(root); return !!r.activeElement && r.activeElement === r.querySelector(s); }, [ROOT, FOLD])) break; await x.page.keyboard.press("Tab"); }
  await x.page.keyboard.press("Enter");
  await shoot(x.page, `fold-focus-300-${tone}-folded-after-enter`, "false");
  await x.page.keyboard.press("Space");
  await shoot(x.page, `fold-focus-300-${tone}-open-after-space`, "true");
  if (x.errors.length) problems.push(`${tone}: ${x.errors.join("; ")}`);
  await x.close();
}
await browser.close();
console.log(`${shots.length} pictures in ${out}`);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
