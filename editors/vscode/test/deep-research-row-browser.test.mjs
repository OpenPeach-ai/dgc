// Deep research's tool row in Work (live round 1, finding 43; 15 Nov). While deep_research ran, the row read "Using a
// tool", then "Using tool <its progress in monospace>", the turn's line said "Running deep_research", and the time
// estimate said "~1–3 min left" on an 8-minute research. Now:
//   - it is named "Deep research", in plain words like the other tools' labels, in the group's line, on its step and
//     on the turn's own line (never "deep_research", never "a tool");
//   - its progress ("Round 9 of 16: choosing what to search", a page's title, "Writing the report from 127 sources",
//     "Checking the citations…") is in the body font, not monospace;
//   - no "~1–3 min left" from the generic estimate while it runs: the depth's own budget instead, or nothing.
// On the real Work page in real Chromium; the Pip's own words for the step are checked without a browser.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openResearch, researchTurn, rowNow, send, PROGRESS } from "./support/deep-research-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

for (const width of [300, 700]) {
  test(`while it runs (${width} px): “Deep research” in the group's line, on the live row and on the turn's line; never the tool's id`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openResearch(browser, { width });
    try {
      const r = await rowNow(page);
      assert.equal(r.sentence, "Deep research", "the group's line");
      assert.equal(r.liveVerb, "Deep research", "the live row");
      assert.equal(r.cardVerb, "Deep research", "its step");
      assert.match(r.turnVerb, /^Deep research/, "the turn's own line");
      assert.doesNotMatch(r.all, /deep_research|Using a tool|Using tool|Running deep/);
      assert.equal(r.sideways, false);
    } finally { await page.close(); }
  });
}

test("its progress lines are body text, not monospace, each as DGC said it", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openResearch(browser, { width: 700, step: 2 });
  try {
    let r = await rowNow(page);
    assert.equal(r.liveArg, "Round 9 of 16: choosing what to search");
    assert.equal(r.liveArgFont, r.bodyFont, "the body font");
    assert.ok(!r.liveArgFont.includes("monospace") || r.bodyFont.includes("monospace"), `not monospace: ${r.liveArgFont}`);
    for (const message of PROGRESS.slice(2)) {
      await send(page, [{ type: "tool_progress", call_id: "r1", name: "deep_research", message }]); await page.waitForTimeout(300);
      r = await rowNow(page);
      assert.equal(r.liveArg, message); assert.equal(r.liveArgFont, r.bodyFont);
    }
    // Another tool's argument (a command) stays monospace.
    await send(page, [{ type: "tool_result", call_id: "r1", name: "deep_research", output: "report", is_error: false }, { type: "tool_call", call_id: "c2", name: "bash", args: { command: "ls -la" }, summary: "ls -la" }]); await page.waitForTimeout(350);
    r = await rowNow(page);
    assert.equal(r.liveArg, "ls -la"); assert.notEqual(r.liveArgFont, r.bodyFont, "a command is still monospace");
  } finally { await page.close(); }
});

const BUDGET = { quick: /reads for up to 5 min/, standard: /reads for up to 15–25 min/, thorough: /reads for up to 30–50 min/ };
for (const [depth, says] of Object.entries(BUDGET)) {
  test(`${depth}: no generic “min left” while it runs; the depth's own budget instead`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openResearch(browser, { width: 700, depth });
    try {
      const r = await rowNow(page);
      assert.doesNotMatch(r.turnMeta, /min left|~1–3/, r.turnMeta);
      assert.match(r.turnMeta, says, r.turnMeta);
      // A later estimate from the backend is not shown either, while the research runs.
      await send(page, [{ type: "turn_eta", turn_id: "t1", label: "~2–4 min left" }]); await page.waitForTimeout(300);
      assert.doesNotMatch((await rowNow(page)).turnMeta, /min left/);
    } finally { await page.close(); }
  });
}
test("no depth said is the tool's own default, quick; in a narrow side bar nothing is said; once the research is done, the turn's own estimate is back", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openResearch(browser, { width: 700, depth: "" });
  try {
    let r = await rowNow(page);
    assert.match(r.turnMeta, /reads for up to 5 min/, "the tool's own default is quick");
    const slim = await openResearch(browser, { width: 300, depth: "standard" });
    try { const m = (await rowNow(slim)).turnMeta; assert.doesNotMatch(m, /min left|reads for/, `nothing, at 300 px: ${m}`); } finally { await slim.close(); }
    await send(page, [{ type: "tool_result", call_id: "r1", name: "deep_research", output: "report", is_error: false }, { type: "turn_activity", turn_id: "t1", state: "thinking", label: "Thinking", detail: "" },
      { type: "turn_eta", turn_id: "t1", label: "~1 min left" }]); await page.waitForTimeout(350);
    r = await rowNow(page);
    assert.match(r.turnMeta, /~1 min left/, "another step's estimate shows as before");
    assert.doesNotMatch(r.turnMeta, /reads for up to/);
  } finally { await page.close(); }
});

test("finished: the folded work says “Deep research”, not “Used 1 tool”", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openResearch(browser, { width: 700, step: 5, done: true });
  try {
    await page.evaluate(() => document.querySelectorAll("#log .msg.dgc.work-folded > .work-toggle").forEach((row) => row.click())); await page.waitForTimeout(200);
    const r = await rowNow(page);
    assert.equal(r.sentence, "Deep research");
    assert.doesNotMatch(r.all, /Used 1 tool|deep_research/);
  } finally { await page.close(); }
});

test("a Pip's chat names the step “Deep research” too, and shows its progress lines as its words", async () => {
  const { activityParts, activityText } = await import("../src/pipRunActivity.js");
  const ev = (payload) => ({ event_type: "pip_run_progress", payload });
  assert.equal(activityText(activityParts(ev({ kind: "tool_call", tool: "deep_research" }))), "Deep research");
  assert.equal(activityText(activityParts(ev({ kind: "progress", message: "Round 2 of 3: choosing what to search" }))), "Round 2 of 3: choosing what to search");
});
