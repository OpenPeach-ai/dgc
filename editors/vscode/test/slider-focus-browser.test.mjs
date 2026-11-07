// A slider dragged with the mouse draws no box (reported 2026-11-07 on Trace's timeline, in a theme whose focus colour is yellow). The
// page's own focus rule (main.css :focus-visible) is loaded, so a rule that loses to it fails here. The keyboard keeps a ring, on the thumb.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const UA = ":focus{outline:1px solid orange}";   // what a webview's own default sheet does
const SHEETS = { work: read("media/main.css"), pip: read("src/pips.css"), trace: read("media/trace.css") };
for (const [where, selector] of [["work", "effort-slider"], ["pip", "composer-effort-slider"], ["trace", "dgc-trace-scrub"]]) {
  test(`${where}: dragging ${selector} with the mouse draws no outline`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await browser.newPage({ viewport: { width: 700, height: 200 } });
    try {
      await page.setContent(`<!doctype html><style>${UA}</style><style>${SHEETS[where]}</style><body style="padding:40px"><div style="width:400px"><input class="${selector}" type="range" min="0" max="4" value="2" style="width:100%"></div></body>`);
      const box = await page.locator("input").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 3 });
      const seen = await page.evaluate(() => { const n = document.querySelector("input"); return { focused: document.activeElement === n, outline: getComputedStyle(n).outlineStyle }; });
      await page.mouse.up();
      assert.deepEqual(seen, { focused: true, outline: "none" });
    } finally { await page.close(); }
  });
}
