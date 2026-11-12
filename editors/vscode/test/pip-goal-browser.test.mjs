// A Personal Pip's goal card, in real Chromium in the side bar's Pip chat, dark and light, at 700 and 300 px: pinned
// above the prompt box inside the chat's column, the objective cut to two lines, the turn and status on one line that
// is never cut, Stop (or Details and Dismiss) whole, the evidence inside the card, and every word at 4.5:1.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GOAL_STATES, measureGoal, openGoal } from "./support/pip-goal-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

for (const theme of ["dark", "light"]) for (const width of [700, 300]) for (const state of Object.keys(GOAL_STATES)) {
  test(`${theme} ${width}px, ${state}: the goal card sits above the prompt box, whole and readable`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGoal(browser, { width, theme, state });
    try {
      const m = await measureGoal(x.p);
      assert.ok(m.card, "the goal card is drawn");
      assert.ok(m.card.left >= 0 && m.card.right <= width, `inside the window (${m.card.left}..${m.card.right})`);
      assert.ok(m.card.bottom <= m.form.top + 0.5, "above the prompt box");
      assert.ok(Math.abs(m.card.left - m.form.left) <= 1 && Math.abs(m.card.right - m.form.right) <= 1, `as wide as the prompt box (${m.card.left}..${m.card.right} against ${m.form.left}..${m.form.right})`);
      assert.ok(m.objective.lines <= 2, `the objective is two lines at most (${m.objective.lines})`);
      assert.equal(m.turn.text, GOAL_STATES[state].turn);
      assert.equal(m.status.text, GOAL_STATES[state].status);
      assert.ok(!m.turn.cut, "the turn count is whole");
      assert.deepEqual(m.buttons.map((b) => b.word).filter((w) => w !== "more"), GOAL_STATES[state].buttons);
      for (const b of m.buttons) assert.ok(!b.cut && b.inside, `“${b.word}” is whole, inside the card`);
      assert.equal(m.overlaps.length, 0, `nothing overlaps: ${m.overlaps.join("; ")}`);
      for (const w of m.words) assert.ok(w.ratio >= 4.5, `“${w.text}” reads at ${w.ratio}:1`);
      if (GOAL_STATES[state].evidence) {
        assert.equal(m.evidence.length, GOAL_STATES[state].evidence, "its evidence lines, open");
        for (const e of m.evidence) assert.ok(e.inside, "each inside the card");
      }
      assert.equal(m.sideways, 0, "nothing scrolls sideways");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
