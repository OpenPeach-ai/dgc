// Screenshots of the model reconnect line and the model error row in real Chromium, so the change is
// judged by looking at it. A developer tool, not part of `npm test` (reconnect-line.test.mjs holds
// the layout and contrast contract).
//
//   node test/render-reconnect.mjs <out-dir> [--theme=dark|light|light-modern|hc] [--narrow] [--width=460]
//   node test/render-reconnect.mjs <out-dir> --all        the named set the 0.40 review looks at
//
// Writes <scene>-<theme>-<width>.png for the live scene (collapsed and with a line open), the error
// row (hint visible, then opened), the replayed turn, and prints the measured facts.
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { errorScene, liveScene, measureInPage, openPanel, replayScene } from "./support/reconnect-scene.mjs";

const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "/tmp/reconnect-shots";
const option = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${fallback}`)
  .slice(name.length + 3);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });

async function shoot(name, { theme, width, scene, open = null, crop = null }) {
  const panel = await openPanel(browser, { width, theme, height: 1600 });
  try {
    await scene(panel);
    if (open) {
      await panel.page.locator(open).first().click();
      await panel.settle();
    }
    const facts = await panel.page.evaluate(measureInPage);
    const target = crop ? panel.page.locator(crop).first() : panel.page.locator("#log .msg.dgc").last();
    await target.scrollIntoViewIfNeeded();
    const path = `${out}/${name}.png`;
    await target.screenshot({ path });
    const worst = facts.texts.reduce((min, entry) => Math.min(min, entry.ratio), Infinity);
    console.log(`${path}  page ${facts.page.scrollWidth}/${facts.page.clientWidth}  toggles `
      + facts.toggles.map((t) => `${Math.round(t.height)}px "${t.label}"`).join(" | ")
      + `  lowest contrast ${Number.isFinite(worst) ? worst.toFixed(2) : "-"}:1`);
  } finally {
    await panel.page.close();
  }
}

const turn = "#log .msg.dgc";
if (process.argv.includes("--all")) {
  await shoot("retry-collapsed-dark-300", { theme: "dark", width: 300, scene: liveScene });
  await shoot("retry-open-light-460", { theme: "light", width: 460, scene: liveScene, open: ".model-retry-toggle" });
  await shoot("longest-label-dark-300", { theme: "dark", width: 300, scene: liveScene,
    crop: '.model-retry[data-retry-id="t1:sub-0123456789ab:retry1"]' });
  await shoot("longest-label-light-modern-300", { theme: "light-modern", width: 300, scene: liveScene,
    crop: '.model-retry[data-retry-id="t1:sub-0123456789ab:retry1"]' });
  await shoot("retry-hc-300", { theme: "hc", width: 300, scene: liveScene, open: ".model-retry-toggle" });
  await shoot("tool-group-split-dark-460", { theme: "dark", width: 460, scene: liveScene });
  await shoot("error-row-hint-light-300", { theme: "light", width: 300, scene: errorScene, crop: turn });
  await shoot("error-row-open-dark-460", { theme: "dark", width: 460, scene: errorScene, open: ".model-error-toggle", crop: turn });
  await shoot("replayed-did-not-finish-dark-460", { theme: "dark", width: 460, scene: replayScene, crop: "#log" });
  for (const theme of ["dark", "light"]) {
    for (const width of [300, 460, 900]) {
      await shoot(`live-${theme}-${width}`, { theme, width, scene: liveScene });
      await shoot(`live-open-${theme}-${width}`, { theme, width, scene: liveScene, open: ".model-retry-toggle" });
      await shoot(`error-${theme}-${width}`, { theme, width, scene: errorScene, open: ".model-error-toggle" });
      await shoot(`replay-${theme}-${width}`, { theme, width, scene: replayScene, crop: "#log" });
    }
  }
} else {
  const theme = option("theme", "dark");
  const width = process.argv.includes("--narrow") ? 300 : Number(option("width", "460"));
  await shoot(`live-${theme}-${width}`, { theme, width, scene: liveScene });
  await shoot(`live-open-${theme}-${width}`, { theme, width, scene: liveScene, open: ".model-retry-toggle" });
  await shoot(`error-${theme}-${width}`, { theme, width, scene: errorScene, open: ".model-error-toggle" });
  await shoot(`replay-${theme}-${width}`, { theme, width, scene: replayScene, crop: "#log" });
}
await browser.close();
