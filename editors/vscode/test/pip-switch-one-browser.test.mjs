// A Pip's on/off switch in the one list (Pips API 94 and up: what every 0.52 DGC shows), in real Chromium on the stand-in
// DGC (test/support/one-pips-scene.mjs). His live report, 14 Nov: the switch "flickers, does not react and takes multiple
// times, then works". The one list draws its rows from its own copy of the Pips; the switch looked the Pip up in the
// folder list (often without it, or out of date), sent DGC a revision it no longer held, and wrote DGC's answer only
// there, so the row flipped back. Here: one press is one switch, it stays, the next press carries DGC's new revision, and
// a list read that lands while DGC is told never flips it back.
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
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const BEDS = "pip_" + "e".repeat(32);            // a Pip of another folder than the window's (the folder list never holds it)
const sw = `.pips-one-list [data-pip-switch="${BEDS}"]`;
const checked = (x) => x.inPips((root, s) => root.querySelector(s)?.getAttribute("aria-checked") ?? null, sw);
const press = (x) => x.inPips((root, s) => root.querySelector(s).click(), sw);
const settle = (x, ms = 250) => x.page.waitForTimeout(ms);

test("one press switches a Pip off and it stays off; the next press switches it on with DGC's new revision", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOnePips(browser, { api: 97 });
  try {
    assert.equal(await checked(x), "true", "Bed planner runs: its switch is on");
    await press(x); await settle(x);
    assert.deepEqual((await x.requests("pause_pip")).map(({ type, ...r }) => r), [{ pip_id: BEDS, expected_lifecycle_revision: 0 }], "one press, one pause");
    assert.equal(await checked(x), "false", "off");
    await x.send({ type: "pipsProfileChanged" }); await settle(x, 400);           // the list is read again
    assert.equal(await checked(x), "false", "still off after the list is read again");
    await press(x); await settle(x);
    assert.deepEqual((await x.requests("resume_pip")).map(({ type, ...r }) => r), [{ pip_id: BEDS, expected_lifecycle_revision: 1 }], "the revision DGC answered");
    assert.equal(await checked(x), "true");
    assert.equal(await x.inPips((root) => root.querySelector("[role=alert]")?.textContent.trim() || ""), "", "never refused");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a list read that lands while DGC is told never flips the switch back", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOnePips(browser, { api: 97, scene: { holdSwitch: true } });
  try {
    await press(x); await settle(x);
    assert.equal(await checked(x), "false", "off at once");
    await x.send({ type: "pipsProfileChanged" }); await settle(x, 400);           // read while DGC hasn't answered
    assert.equal(await checked(x), "false", "still off while DGC is told");
    await x.page.evaluate(() => {                                                    // DGC answers now
      const m = window.__posted.find((p) => p.type === "pipsRequest" && p.request.type === "pause_pip");
      const result = window.__backend.turn(m.request, false);
      window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsReply", id: m.id, ok: true, result } }));
    });
    await settle(x, 400);
    assert.equal(await checked(x), "false", "off once DGC answered: the earlier read doesn't flip it back");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
