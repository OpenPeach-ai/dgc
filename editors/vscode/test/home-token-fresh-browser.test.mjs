// Home's token card stays near the ledger (finding 73, 16 Nov): it read a million tokens low in a busy goal because it
// asked at most every five minutes. Now: once a minute while Home shows, soon after a turn ends (the host's
// homeUsageStale, at most once in 15 s), never while Home is out of sight, and at once when Home comes back after 30 s.
// In real Chromium with the page's clock under the test's hand.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openGrid } from "./support/home-grid-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch(); } catch { browser = null; } });
after(async () => { await browser?.close(); });

test("the token card asks once a minute while Home shows, soon after a turn ends, never out of sight, and at once on coming back", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 440, layout: ["token"], clock: {} });
  try {
    const asks = () => x.page.evaluate(() => window.__posted.filter((m) => m.type === "homeUsageGet").length);
    await x.page.clock.runFor(1000);
    const first = await asks();
    assert.ok(first >= 1, "asked as Home opens");
    await x.page.clock.runFor(45_000);
    assert.equal(await asks(), first, "not again within the minute");
    await x.page.clock.runFor(35_000);       // (the card looks every 20 s: the minute is up by 80 s at the latest)
    assert.equal(await asks(), first + 1, "again once the minute is up, while Home shows");
    // A turn ended: asked again within 15 s, once, even if several end together.
    await x.send({ type: "homeUsageStale" }); await x.send({ type: "homeUsageStale" });
    await x.page.clock.runFor(16_000);
    assert.equal(await asks(), first + 2, "a turn's end: asked again soon, once");
    // Out of sight: nothing is asked, not even after a turn ends.
    await x.page.evaluate(() => document.getElementById("side-tab-work").click());
    await x.page.clock.runFor(1000);
    const hidden = await asks();
    await x.send({ type: "homeUsageStale" });
    await x.page.clock.runFor(90_000);
    assert.equal(await asks(), hidden, "nothing asked while Home is out of sight");
    // Back on Home after more than 30 s: asked at once.
    await x.page.evaluate(() => document.getElementById("side-tab-home").click());
    await x.page.clock.runFor(500);
    assert.equal(await asks(), hidden + 1, "asked at once on coming back");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});
