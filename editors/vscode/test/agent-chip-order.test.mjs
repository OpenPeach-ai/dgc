// Two delegated agents keep their places.
//
// `placeAgentChip` called `group.after(chip)` on every update, and `after()` MOVES a node that is
// already in the document. So each agent's chip was dragged down to its own newest tool group —
// and with two agents working, every tool call yanked one below the other. They swapped places
// under the reader for the whole turn, which is exactly what the founder reported: "they keep
// switching their place... in codex, they maintain their place".
//
// The fix is that a chip anchored to its own work is never relocated again. What this file holds
// is the ORDER, across a realistic interleaving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

function chipOrder(doc) {
  return [...doc.querySelectorAll(".agent-chip")].map((c) => c.dataset.agentId);
}

// A chip only ANCHORS to a tool card, and only a `task` call carries the agent's call_id. Without
// those the chip takes the plain append path, `group.after()` is never reached, and a test built
// that way passes with the fix deleted — which is exactly what the first cut of this file did.
function twoAgents() {
  const h = makeDom();
  const event = (data) => h.send({ type: "event", event: data });
  event({ type: "ready", capabilities: {} });
  event({ type: "turn_start", turn_id: "t", prompt: "delegate two" });
  event({ type: "tool_call", call_id: "c1", name: "task", args: { description: "explorer" } });
  event({ type: "tool_call", call_id: "c2", name: "task", args: { description: "reviewer" } });
  event({ type: "agent_started", id: "alpha", call_id: "c1", description: "explorer", state: "running" });
  event({ type: "agent_started", id: "beta", call_id: "c2", description: "reviewer", state: "running" });
  return { h, event };
}

test("both agents anchor to their own task card", () => {
  // Which one sits first depends on where its card landed, and that is fine — what must never
  // happen is the two trading places later. This assertion exists so the rest of the file is
  // known to exercise the `group.after()` path, which is the one that used to move them.
  const { h } = twoAgents();
  const chips = [...h.doc.querySelectorAll(".agent-chip")];
  assert.equal(chips.length, 2, "both agents should have a chip");
  for (const chip of chips) {
    assert.equal(chip.dataset.anchored, "1",
      `${chip.dataset.agentId} never anchored — then this file would test the append path only, `
      + "pass with the fix deleted, and prove nothing");
  }
});

test("a tool call does not move an agent below the other", () => {
  const { h, event } = twoAgents();
  const before = chipOrder(h.doc);
  // beta works, then alpha, then beta again — the interleaving that caused the swapping.
  event({ type: "agent_updated", id: "beta", state: "running", tool_calls: 1 });
  assert.deepEqual(chipOrder(h.doc), before, "beta's own tool call must not move beta");
  event({ type: "agent_updated", id: "alpha", state: "running", tool_calls: 1 });
  assert.deepEqual(chipOrder(h.doc), before, "alpha's tool call must not move alpha past beta");
  event({ type: "agent_updated", id: "beta", state: "running", tool_calls: 2 });
  assert.deepEqual(chipOrder(h.doc), before, "and beta's second call must not move it either");
});

test("order survives a full snapshot from the backend", () => {
  const { h, event } = twoAgents();
  const before = chipOrder(h.doc);
  // The backend may list them in any order; the panel's own order is what the reader sees.
  event({ type: "agents", items: [
    { id: "beta", description: "reviewer", state: "running", tool_calls: 3 },
    { id: "alpha", description: "explorer", state: "running", tool_calls: 1 },
  ], total: 2, active: 2 });
  assert.deepEqual(chipOrder(h.doc), before,
    "a snapshot listing them backwards must not reorder the transcript");
});

test("an agent finishing does not reshuffle the one still working", () => {
  const { h, event } = twoAgents();
  const before = chipOrder(h.doc);
  event({ type: "agent_ended", id: "alpha", state: "finished", tool_calls: 4 });
  event({ type: "agent_updated", id: "beta", state: "running", tool_calls: 5 });
  const after = chipOrder(h.doc);
  assert.equal(after.indexOf("beta") > -1, true, "beta is still shown");
  assert.deepEqual(after.filter((id) => before.includes(id)), before.filter((id) => after.includes(id)),
    "the agents that remain keep their relative order");
});
