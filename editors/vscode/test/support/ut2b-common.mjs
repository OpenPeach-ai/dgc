// What the tests of the second user test's polish batch (ut2b-*.test.mjs) share: one Chromium, and the skip rule.
// Not a *.test.mjs file.
import assert from "node:assert/strict";
import { chromiumOrNull } from "./look-probe.mjs";

export const launchArgs = ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"];
export async function chromiumFor() {
  const chromium = await chromiumOrNull();
  const state = { browser: null };
  const start = async () => { if (!chromium) return; try { state.browser = await chromium.launch({ args: launchArgs }); } catch { state.browser = null; } };
  const stop = async () => { await state.browser?.close(); };
  const skipOrFail = (t) => {
    const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !state.browser ? "Chromium could not start" : "";
    if (!reason) return false;
    if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
    t.skip(reason);
    return true;
  };
  return { state, start, stop, skipOrFail };
}

/** A picture of what a test has on screen, when UT2B_SHOTS names a folder to keep them in (the pictures of this batch). */
export async function shot(page, name) {
  const dir = process.env.UT2B_SHOTS; if (!dir) return;
  const { mkdirSync } = await import("node:fs"); mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}
