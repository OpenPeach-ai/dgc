// Pictures of a turn whose commands carry plain-words labels, in real Chromium.
//   node test/render-step-labels.mjs --out <dir> [--tag after]
// writes steplabels-<tag>-{dark,light}-{700,300}.png: three labelled steps, one without a label, one opened (its exact
// command in a chip, then its output), and an approval card. Importing this module runs nothing.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openThinkingPage } from "./render-thinking.mjs";
import { labelledTurn } from "./support/step-labels-scene.mjs";

export async function openLabelledTurn(browser, { width = 700, height = width <= 300 ? 860 : 620, theme = "dark-modern", events = labelledTurn(), expand = 1 } = {}) {
  const page = await openThinkingPage(browser, { width, height, theme, events });
  await page.evaluate((index) => {
    document.querySelectorAll("#log .tool-group").forEach((group) => { group.open = true; });
    if (index != null) document.querySelectorAll("#log .tool .tool-toggle")[index]?.click();
  }, expand);
  await page.waitForTimeout(80);
  return page;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
  const out = arg("--out", "."), tag = arg("--tag", "after");
  mkdirSync(out, { recursive: true });
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] });
  try {
    for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
      const page = await openLabelledTurn(browser, { width, theme });
      await page.screenshot({ path: join(out, `steplabels-${tag}-${theme.split("-")[0]}-${width}.png`) });
      await page.close();
    }
  } finally { await browser.close(); }
}
