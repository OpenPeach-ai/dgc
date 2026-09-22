// A finished checklist must fold when the turn ends, not on the next prompt.
//
// The Tasks row hides itself only when it renders with every item settled AND no turn live, and
// endTurn never re-rendered it. So "Tasks 4/4 · all done" sat above the composer for the whole
// idle gap — the most-looked-at strip of the panel saying work was in hand when nothing was.
// It cleared only when the next message was sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const TODOS = [
  { content: "read the file", status: "done" },
  { content: "make the edit", status: "done" },
  { content: "run the tests", status: "done" },
  { content: "report back", status: "done" },
];

function runTurn(send, { todos = TODOS, end = true } = {}) {
  send({ type: "event", event: { type: "turn_start", turn_id: "t1", kind: "prompt", prompt: "go" } });
  send({ type: "event", event: { type: "todos", todos } });
  if (end) send({ type: "event", event: { type: "turn_end", turn_id: "t1", reason: "done" } });
}

test("a completed checklist folds as soon as the turn ends", () => {
  const { doc, send } = makeDom();
  send({ type: "webviewReady" });
  runTurn(send);
  const bar = doc.getElementById("tasksbar");
  assert.ok(bar, "the tasks row exists");
  assert.equal(bar.hidden, true,
    "a finished list stayed on screen until the next message was sent");
});

test("it stays up while the turn is still running", () => {
  const { doc, send } = makeDom();
  send({ type: "webviewReady" });
  runTurn(send, { end: false });
  assert.equal(doc.getElementById("tasksbar").hidden, false,
    "the row must not vanish mid-turn just because every item is ticked");
});

test("unfinished work keeps the row after the turn ends", () => {
  const { doc, send } = makeDom();
  send({ type: "webviewReady" });
  runTurn(send, { todos: [
    { content: "read the file", status: "done" },
    { content: "make the edit", status: "pending" },
  ] });
  assert.equal(doc.getElementById("tasksbar").hidden, false,
    "an item left pending is still worth showing after the turn");
});

test("the row folds on the turn that finished, not on the next message", () => {
  // The previous version of this test asserted only that the element existed — it never sent a
  // turn, never ended one, and passed with the fix fully reverted. What matters is the ORDER:
  // the row must be gone before anything else happens, because the gap between turns is exactly
  // when a stale "Tasks 4/4 · all done" was sitting above the composer.
  const { doc, send } = makeDom();
  send({ type: "webviewReady" });
  const bar = () => doc.getElementById("tasksbar");

  send({ type: "event", event: { type: "turn_start", turn_id: "t1", kind: "prompt", prompt: "go" } });
  send({ type: "event", event: { type: "todos", todos: TODOS } });
  assert.equal(bar().hidden, false, "it belongs on screen while the turn runs");

  send({ type: "event", event: { type: "turn_end", turn_id: "t1", reason: "done" } });
  assert.equal(bar().hidden, true, "it must fold on turn_end itself");

  // …and stay folded through the idle gap, with no further events at all.
  assert.equal(bar().hidden, true);
});
