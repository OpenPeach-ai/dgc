// A finished run of tools folds to the one line that already describes it (founder, 2026-09-24).
//
// This revisits a documented decision, so the reasoning matters. The group used to collapse the
// moment it was created, and that was reversed with the note "work you cannot see is work you
// cannot check": a run of twenty commands showed one grey line and the reader had no idea what
// had been done to their project. Folding only once the model has MOVED ON keeps that -- the work
// is open while it happens, and the transcript afterwards reads as a sequence of steps rather
// than a wall of cards, which is what Codex does and what was asked for.
//
// The exception is trouble. A failed, denied or stopped card keeps its group open: an error is
// the one thing a reader must never have to expand to find.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

function panel() {
  const h = makeDom();
  const event = (d) => h.send({ type: "event", event: d });
  event({ type: "ready", capabilities: {} });
  event({ type: "turn_start", turn_id: "t", prompt: "do some work" });
  return { h, event, groups: () => [...h.doc.querySelectorAll(".tool-group")] };
}

const ran = (event, id, name = "bash", status = "ok") => {
  event({ type: "tool_call", call_id: id, name, args: { command: "ls" } });
  event({ type: "tool_result", call_id: id, name, output: "out",
          is_error: status === "failed" });
};

test("a group stays open while its tools are still running", () => {
  const { event, groups } = panel();
  event({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "sleep 5" } });
  assert.equal(groups()[0].open, true, "work in flight must be visible");
});

test("a finished group folds when the model moves on to prose", () => {
  const { event, groups } = panel();
  ran(event, "c1");
  assert.equal(groups()[0].open, true, "still the live group");
  event({ type: "text_delta", text: "Here is what I found." });
  assert.equal(groups()[0].open, false, "the model moved on, so the run folds to its summary");
});

test("the folded line still says what happened", () => {
  const { event, groups } = panel();
  ran(event, "c1");
  event({ type: "text_delta", text: "done" });
  const label = groups()[0].querySelector(".tool-group-label").textContent;
  assert.match(label, /\w/, "a folded group is only useful if its header names the work");
  assert.doesNotMatch(label, /^Working$/, "and not the placeholder it starts with");
});

test("a turn that ends on a tool call folds its last group too", () => {
  const { event, groups } = panel();
  ran(event, "c1");
  event({ type: "turn_end", turn_id: "t", reason: "completed" });
  assert.equal(groups()[0].open, false,
    "otherwise the final group reads differently from every group above it");
});

test("a failure keeps its group open", () => {
  const { event, groups } = panel();
  ran(event, "c1", "bash", "failed");
  event({ type: "text_delta", text: "that did not work" });
  assert.equal(groups()[0].open, true, "an error must never need expanding to find");
});

test("a denied tool keeps its group open", () => {
  const { event, groups } = panel();
  event({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "rm -rf dist" } });
  event({ type: "tool_denied", call_id: "c1", name: "bash", reason: "denied" });
  event({ type: "text_delta", text: "I will leave that alone." });
  assert.equal(groups()[0].open, true);
});

test("one group folding does not fold the next one's live work", () => {
  const { event, groups } = panel();
  ran(event, "c1");
  event({ type: "text_delta", text: "first" });
  event({ type: "tool_call", call_id: "c2", name: "bash", args: { command: "sleep 5" } });
  const all = groups();
  assert.equal(all.length, 2, "prose between runs starts a new group");
  assert.equal(all[0].open, false, "the finished one is folded");
  assert.equal(all[1].open, true, "the running one is not");
});

test("the reader can still open a folded group by hand", () => {
  const { event, groups } = panel();
  ran(event, "c1");
  event({ type: "text_delta", text: "done" });
  const group = groups()[0];
  assert.equal(group.open, false);
  group.open = true;                       // what a click does
  event({ type: "turn_end", turn_id: "t", reason: "completed" });
  assert.equal(group.open, true, "a turn ending must not re-fold what the reader opened");
});
