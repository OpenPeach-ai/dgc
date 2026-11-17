// Seen live (17 Nov): a Pip row's menu faded out and stayed invisible, still taking clicks, while a Pip's computer sent
// news: each redraw made the menu anew and its fade-in started over. A menu open before a redraw is the same menu after
// it, at full strength, with nothing replaying. In real Chromium on the Pips list.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openOnePips } from "./support/one-pips-scene.mjs";

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

test("a Pip row's menu stays open and solid through a redraw: its fade-in doesn't replay", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOnePips(browser, { where: "side", width: 360, api: 103, motion: "no-preference" });   // (its fade-in runs)
  try {
    const ids = await x.inPips((root) => [...root.querySelectorAll(".pips-one-list [data-job]")].map((n) => n.dataset.job));
    assert.ok(ids.length >= 2, "premise: two Pips in the list");
    await x.inPips((root) => root.querySelector(".job-more").click());
    await x.page.waitForTimeout(500);
    const read = () => x.inPips((root) => { const m = root.getElementById("pip-row-menu"); return m ? { op: getComputedStyle(m).opacity, running: m.getAnimations().length } : null; });
    assert.deepEqual(await read(), { op: "1", running: 0 }, "premise: open, its fade-in done");
    // Something else on the list changes (another Pip is pinned to the dock): the list is drawn again.
    await x.inPips((root) => { root.getElementById("pip-row-menu").__before = true; });
    await x.send({ type: "dock", pinned: [`pip:${ids[1]}`] });
    await x.page.waitForTimeout(20);
    assert.equal(await x.inPips((root) => !root.getElementById("pip-row-menu")?.__before), true, "premise: the list was drawn again (the menu is a new node)");
    assert.deepEqual(await read(), { op: "1", running: 0 }, "the same menu, at full strength, nothing replaying");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
