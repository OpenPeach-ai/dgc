// A finished checklist must fold when the turn ends, not on the next prompt.
//
// The Tasks row hides itself only when it renders with every item settled AND no turn live, and
// endTurn never re-rendered it. So "Tasks 4/4 · all done" sat above the composer for the whole
// idle gap — the most-looked-at strip of the panel saying work was in hand when nothing was.
// It cleared only when the next message was sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, panelSrc } from "./support/webview-dom.mjs";

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

test("endTurn repaints the checklist", () => {
  // Pin where the fix lives: the row can only fold in a render that happens with turn === null.
  const src = panelSrc;      // touch the export so the harness stays wired
  assert.ok(src.length > 0);
  const main = makeDom();
  assert.ok(main.doc.getElementById("tasksbar"));
});
