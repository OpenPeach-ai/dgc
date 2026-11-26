// A goal looks started the moment it is sent (27 Nov): an idle prompt's turn shows its time and "Working" / "Loading
// model" at once, but a goal's came ~5 s later, after the backend had saved the goal ("as a user it seems broken").
// Now the goal's bubble gets its time at Send and a starting row stands under it, in the turn's own markup; its
// turn_start takes the row's place (no second entrance, the clock and time kept). A refused goal takes the row away;
// a goal that would replace a standing one (the editor asks first) and a plain prompt draw none.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromiumFor } from "./support/ut2b-common.mjs";
import * as S from "./support/uir2a-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const MSGTIME = readFileSync(new URL("../media/msgtime.js", import.meta.url), "utf8");

async function open(opts = {}) {
  const x = await S.openWork(C.state.browser, { width: 440, turns: 1, ...opts });
  if (!(await x.page.evaluate(() => !!window.DgcTime))) await x.page.addScriptTag({ content: MSGTIME });
  return x;
}
// (The goal's own row, its starting row and turn blocks, read at once.)
const read = (x) => x.page.evaluate(() => {
  const goal = [...document.querySelectorAll("#log .msg.user.goal-prompt")].pop();
  const starting = [...document.querySelectorAll("#log .msg.dgc.starting")];
  const next = goal?.nextElementSibling;
  return {
    goal: !!goal, time: goal?.querySelector(":scope > .msg-time")?.textContent.replace(/\s+/g, " ").trim() || "",
    starting: starting.length, startingVerb: starting[0]?.querySelector(".verb")?.textContent || "",
    startingMeta: starting[0]?.querySelector(".meta")?.textContent || "", underGoal: !!next && next.classList.contains("starting"),
    turns: document.querySelectorAll("#log .msg.dgc:not(.starting):not(.hist)").length,
  };
});
const sendGoal = async (x, text) => {
  await x.page.fill("#input", `/goal ${text}`); await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(60);
  return String((await x.posted("startGoal")).pop()?.requestId || "");
};

test("sent while nothing runs: the goal shows its time and a starting row at once, and its clock runs", async (t) => {
  if (C.skipOrFail(t)) return;
  const x = await open();
  try {
    const before = await read(x);
    const id = await sendGoal(x, "make the billing tests pass, then stop");
    assert.ok(id, "the goal was sent (startGoal)");
    const now = await read(x);
    assert.ok(now.goal, "the goal's bubble is in the chat");
    assert.match(now.time, /^Goal\D{0,3}\d{1,2}:\d\d/, `its time at once, after the Goal mark (${JSON.stringify(now.time)})`);
    assert.equal(now.starting, 1, "a starting row");
    assert.ok(now.underGoal, "right under the goal's bubble");
    assert.equal(now.startingVerb, "Working", "it says what a turn's row says before the backend's first word");
    assert.match(now.startingMeta, /^\(0s · ↓ 0 tok\)$/, `its clock from Send (${now.startingMeta})`);
    assert.equal(now.turns, before.turns, "no turn of the backend's yet");
    await x.page.waitForTimeout(1300);
    assert.match((await read(x)).startingMeta, /^\(1s · ↓ 0 tok\)$/, "the clock runs while the backend saves the goal");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("its turn_start takes the starting row's place: one row, no second entrance, the same time, the clock goes on", async (t) => {
  if (C.skipOrFail(t)) return;
  const x = await open();
  try {
    const before = await read(x);
    const id = await sendGoal(x, "make the billing tests pass, then stop");
    const sent = await read(x);
    await x.page.waitForTimeout(1300);
    await x.event({ type: "goal_changed", goal: "make the billing tests pass, then stop", status: "active", elapsed_seconds: 0, details: { id: "goal1", tokens_used: 0, history: [] } });
    await x.event({ type: "prompt_accepted", request_id: id, state: "started" });
    await x.event({ type: "turn_start", turn_id: "g1", prompt: "make the billing tests pass, then stop", kind: "prompt", request_id: id });
    await x.page.waitForTimeout(80);
    const now = await read(x);
    const block = await x.page.evaluate(() => {
      const b = [...document.querySelectorAll("#log .msg.dgc:not(.hist)")].pop(), goal = [...document.querySelectorAll("#log .msg.user.goal-prompt")].pop();
      return { arrive: b?.classList.contains("motion-arrive"), meta: b?.querySelector(".thinking .meta")?.textContent || "",
        sameTurn: !!goal && !!b && goal.parentElement === b.parentElement && goal.parentElement.classList.contains("turn"),
        after: !!goal && !!b && !!(goal.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    assert.equal(now.starting, 0, "the starting row is gone");
    assert.equal(now.turns, before.turns + 1, "one turn row: the turn's own, where the starting row was");
    assert.equal(block.arrive, false, "it doesn't come in a second time");
    assert.ok(block.sameTurn && block.after, "under the goal's bubble, in its turn");
    assert.match(block.meta, /^\(1s/, `the clock goes on from Send, not from 0 (${block.meta})`);
    assert.equal(now.time, sent.time, "the time stays the one drawn at Send");
    await x.event({ type: "turn_activity", turn_id: "g1", state: "model", label: "Loading model", detail: "" });
    await x.page.waitForTimeout(60);
    assert.equal(await x.page.evaluate(() => [...document.querySelectorAll("#log .msg.dgc .thinking .verb")].pop()?.textContent), "Loading model",
      "then it says what the backend says, as any turn does");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("a refused goal takes its starting row away; one that would replace a standing goal, and a plain prompt, draw none", async (t) => {
  if (C.skipOrFail(t)) return;
  const x = await open();
  try {
    const id = await sendGoal(x, "make the billing tests pass, then stop");
    assert.equal((await read(x)).starting, 1);
    await x.send({ type: "prompt_rejected", requestId: id });
    await x.send({ type: "goal_start_state", state: "error", error: "DGC could not start the goal." });
    await x.page.waitForTimeout(60);
    assert.equal((await read(x)).starting, 0, "refused: no row says it is starting");

    // A goal standing: the editor first asks "Replace the current goal?", so nothing is starting yet.
    await x.event({ type: "goal_changed", goal: "keep the docs in step", status: "paused", elapsed_seconds: 3, details: { id: "goal0", tokens_used: 10, history: [] } });
    await x.page.waitForTimeout(60);
    await sendGoal(x, "a new objective");
    const standing = await read(x);
    assert.equal(standing.starting, 0, "replacing a standing goal: no starting row while the editor asks");
    assert.equal(standing.time, "", "and no time yet: its turn's start draws it");

    // A plain prompt, idle: its turn_start comes at once and draws everything, as before.
    const y = await open();
    try {
      await y.say("Where is the upload limit read?");
      assert.equal(await y.page.evaluate(() => document.querySelectorAll("#log .msg.dgc.starting").length), 0, "a prompt draws no starting row");
      assert.deepEqual(y.errors, []);
    } finally { await y.page.close(); }
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("a goal queued instead of started (a turn running on the backend) loses its starting row", async (t) => {
  if (C.skipOrFail(t)) return;
  const x = await open();
  try {
    const id = await sendGoal(x, "make the billing tests pass, then stop");
    assert.equal((await read(x)).starting, 1);
    await x.event({ type: "prompt_accepted", request_id: id, state: "steered" });
    await x.page.waitForTimeout(60);
    assert.equal((await read(x)).starting, 0, "steered into a running turn: not starting");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("an older backend's goal turn_start carries no id: it still takes the starting row's place under the goal", async (t) => {
  if (C.skipOrFail(t)) return;
  const x = await open();
  try {
    const before = await read(x);
    const id = await sendGoal(x, "make the billing tests pass, then stop");
    await x.event({ type: "prompt_accepted", request_id: id, state: "started" });
    await x.event({ type: "turn_start", turn_id: "g1", prompt: "make the billing tests pass, then stop", kind: "prompt" });
    await x.page.waitForTimeout(60);
    const now = await read(x);
    assert.deepEqual([now.starting, now.turns], [0, before.turns + 1], "one turn row, the starting row's place taken");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});
