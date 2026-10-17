// Capture the agent map in real Chromium, open over its realistic chat, at side-bar widths 300 and 460
// and an editor's 900, dark and light; with the new panel, also an agent's card over the map, its
// transcript over the card, and a shell's output. Not part of `npm test`.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-agent-map.mjs <out-dir> [prefix] [root]
// `root` is another checkout's editors/vscode: the same chat drawn by that panel (the "before" shots).
import { mkdirSync } from "node:fs";
import { measureMap, openMapScene, sid } from "./support/agent-map-scene.mjs";

const out = process.argv[2] || "agent-map-shots";
const prefix = process.argv[3] || "after";
const root = process.argv[4] || undefined;
mkdirSync(out, { recursive: true });
const { chromium } = await import("@playwright/test");
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const report = [];
for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [300, 460, 900]) {
    const { page, errors } = await openMapScene(browser, { width, height: width === 900 ? 760 : 720, theme, root });
    const name = `${prefix}-${theme.split("-")[0]}-${width}`;
    await page.screenshot({ path: `${out}/${name}.png` });
    const facts = root ? {} : await measureMap(page);
    report.push({ name, layout: facts.layout, pageOverflow: facts.pageOverflow, errors });
    if (!root) {
      // An agent's card over the map, then its transcript over the card.
      await page.click(`.am-row[data-agent-id="${sid(1)}"]`);
      await page.waitForTimeout(80);
      await page.screenshot({ path: `${out}/${name}-agent-card.png` });
      await page.click("#agent-card-body .am-wide");
      await page.waitForTimeout(120);
      await page.screenshot({ path: `${out}/${name}-transcript.png` });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      // A shell's card, with its output.
      await page.click('.am-row[data-am-key="shell:bg3"]');
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: {
        type: "background_output", request_id: "r1", id: "bg3", total_bytes: 182000, truncated: true,
        output: Array.from({ length: 40 }, (_, i) => `[vite] page reload src/settings.ts (x${i + 1})`).join("\n") } } })));
      await page.waitForTimeout(80);
      await page.screenshot({ path: `${out}/${name}-shell-card.png` });
    }
    await page.close();
  }
}
await browser.close();
console.log(JSON.stringify(report, null, 2));
