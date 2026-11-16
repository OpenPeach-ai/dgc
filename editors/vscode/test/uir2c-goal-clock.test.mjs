// The goal clock never jumps back (finding 71): the host stamps the goal's snapshot with when it arrived
// (observed_at), and the page counts from that moment, so the same state sent again (a mode change, a thinking change,
// a reload) never moves the clock. In real Chromium on Work's real page, and the real host code.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openWork } from "./support/uir2a-scene.mjs";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); cleanup(); });

const GOAL = { id: "goal-1", running: true, cycles: 1 };
const seconds = (page) => page.evaluate(() => { const [m, s] = document.getElementById("goal-time").textContent.trim().split(":").map(Number); return m * 60 + s; });
const state = (goal, more = {}) => ({ type: "state", state: { model: "deepseek-v4-pro:cloud", think: "off", mode: "default", ...more, goal } });

test("a running goal at 0:54 still reads 0:54 or more after a mode change and a thinking change, and keeps counting", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWork(browser, { width: 440, turns: 1 });
  try {
    // What the host does (below): it keeps the snapshot with the moment it arrived.
    const arrived = await x.page.evaluate(() => Date.now());
    await x.event({ type: "goal_changed", goal: "Ship the release", status: "active", elapsed_seconds: 54, details: GOAL });
    const kept = { ...GOAL, text: "Ship the release", status: "active", elapsed_seconds: 54, observed_at: arrived };
    assert.equal(await seconds(x.page), 54, "premise: the clock reads 0:54");
    await x.page.waitForTimeout(2800);
    assert.ok(await seconds(x.page) >= 56, "premise: it counts");
    await x.send(state(kept, { mode: "auto" }));                      // Auto turned on: the host sends its state again
    const afterMode = await seconds(x.page);
    assert.ok(afterMode >= 56, `a mode change never moves the clock back (it reads ${afterMode}s)`);
    await x.page.waitForTimeout(1200);
    await x.send(state(kept, { mode: "auto", think: "high" }));       // and a thinking change
    const afterThink = await seconds(x.page);
    assert.ok(afterThink >= 57 && afterThink <= 62, `nor a thinking change (it reads ${afterThink}s)`);
    await x.page.waitForTimeout(1700);
    assert.ok(await seconds(x.page) > afterThink, "and it keeps counting");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("a reload with the same host state shows the true time: the snapshot's seconds plus the time since it arrived", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWork(browser, { width: 440, turns: 1 });
  try {
    const now = await x.page.evaluate(() => Date.now());
    await x.send(state({ ...GOAL, text: "Ship the release", status: "active", elapsed_seconds: 54, observed_at: now - 10000 }));
    const got = await seconds(x.page);
    assert.ok(got >= 64 && got <= 66, `0:54 ten seconds ago reads about 1:04 (it reads ${got}s)`);
    // A host clock ahead of this page's never counts back from the future.
    await x.send(state({ ...GOAL, id: "goal-2", text: "Another goal", status: "active", elapsed_seconds: 30, observed_at: now + 60000 }));
    assert.ok(await seconds(x.page) >= 30);
  } finally { await x.page.close(); }
});

test("a paused goal stays still, however often its state is sent", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWork(browser, { width: 440, turns: 1 });
  try {
    const now = await x.page.evaluate(() => Date.now());
    const paused = { ...GOAL, running: false, text: "Ship the release", status: "paused", elapsed_seconds: 54, observed_at: now - 30000 };
    await x.send(state(paused)); assert.equal(await seconds(x.page), 54);
    await x.page.waitForTimeout(1200); await x.send(state(paused, { mode: "auto" }));
    assert.equal(await seconds(x.page), 54, "paused: 0:54 stays 0:54");
    // An active goal that is not running now (between turns) stands still too.
    await x.send(state({ ...paused, status: "active" })); await x.page.waitForTimeout(1100);
    assert.equal(await seconds(x.page), 54);
  } finally { await x.page.close(); }
});

test("host: the goal's snapshot is stamped with when it arrived, on goal_changed and on ready, and a state sent again carries the same stamp", () => {
  const { provider } = makeProvider();
  const t0 = Date.now();
  provider.onEvent({ type: "goal_changed", goal: "Ship the release", status: "active", elapsed_seconds: 54, details: { id: "goal-1", running: true } });
  const first = provider.state.goal.observed_at;
  assert.ok(Number.isFinite(first) && first >= t0 && first <= Date.now(), "goal_changed: stamped now");
  assert.equal(provider.state.goal.elapsed_seconds, 54);
  // (The test provider's postState is a stand-in; this is the real one's one line: the state as it is kept.)
  const states = [];
  provider.postState = () => states.push({ type: "state", state: JSON.parse(JSON.stringify(provider.state)) });
  provider.onEvent({ type: "mode_changed", mode: "auto" });
  provider.onEvent({ type: "think_changed", level: "high" });
  assert.ok(states.length >= 1, "the state goes to the page again");
  assert.equal(states.at(-1).state.mode, "auto");
  for (const m of states) assert.equal(m.state.goal.observed_at, first, "with the stamp of the moment the snapshot arrived, not of the resend");
  provider.onEvent({ type: "ready", model: "m", mode: "default", think: "off", capabilities: {}, goal: { id: "goal-1", text: "Ship the release", status: "active", elapsed_seconds: 120, running: true } });
  assert.ok(provider.state.goal.observed_at >= first && provider.state.goal.elapsed_seconds === 120, "ready's goal is stamped too");
});
