// Delegated agents keep their places.
//
// When every agent had a row of its own, `placeAgentChip` called `group.after(chip)` on every
// update, and `after()` MOVES a node that is already in the document. So each agent's row was
// dragged down to its own newest tool group -- and with two agents working, every tool call yanked
// one below the other. They swapped places under the reader for the whole turn, which is exactly
// what the founder reported: "they keep switching their place... in codex, they maintain their place".
//
// The rows are now one line per batch, and the line holds the names in call order: the faces and
// the names never move, only the words between them change. What this file holds is that ORDER,
// across realistic interleavings, a reversed snapshot, an agent finishing, and agents that start
// before their spawn card is on screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const faceOrder = (doc) => [...doc.querySelectorAll(".agent-line .agent-line-faces .agent-mark")].map((n) => n.dataset.agentId);
const nameOrder = (doc) => [...doc.querySelectorAll(".agent-line .agent-name")].map((n) => n.dataset.agentId);
const names = (doc) => [...doc.querySelectorAll(".agent-line .agent-name")];

// A line only forms under a spawn card, and only a `task` call carries the agent's call_id. Without
// those the agents take the provisional path at the end of the turn, and a test built that way would
// pass with the ordering broken -- which is exactly what the first cut of the chip version did.
function threeAgents() {
  const h = makeDom({ clock: true });
  const event = (data) => h.send({ type: "event", event: data });
  event({ type: "ready", capabilities: { agents: true } });
  event({ type: "turn_start", turn_id: "t", prompt: "delegate three" });
  event({ type: "tool_call", call_id: "c1", name: "task", args: { description: "explorer" } });
  event({ type: "tool_call", call_id: "c2", name: "task", args: { description: "reviewer" } });
  event({ type: "tool_call", call_id: "c3", name: "task", args: { description: "writer" } });
  event({ type: "agent_started", id: "alpha", call_id: "c1", description: "explorer", state: "running", started_at: 1 });
  event({ type: "agent_started", id: "beta", call_id: "c2", description: "reviewer", state: "running", started_at: 2 });
  event({ type: "agent_started", id: "gamma", call_id: "c3", description: "writer", state: "running", started_at: 3 });
  h.advance(2000);
  return { h, event };
}

test("the batch forms one line under its first spawn, faces and names in call order", () => {
  const { h } = threeAgents();
  const lines = [...h.doc.querySelectorAll(".agent-line")];
  assert.equal(lines.length, 1, "three agents started together share one line");
  const first = h.doc.querySelector('.tool[data-call-id="c1"]').closest(".tool-group");
  assert.equal(lines[0].previousElementSibling, first,
    "the line sits after the first spawn's group -- not the provisional path, which would prove nothing");
  assert.deepEqual(faceOrder(h.doc), ["alpha", "beta", "gamma"]);
  assert.deepEqual(nameOrder(h.doc), ["alpha", "beta", "gamma"]);
  assert.deepEqual(h.errors, []);
});

test("interleaved updates never move a face or a name", () => {
  const { h, event } = threeAgents();
  const before = names(h.doc);
  // gamma works, then alpha, then beta, then gamma again -- the interleaving that caused the swapping.
  for (const [id, n] of [["gamma", 1], ["alpha", 1], ["beta", 1], ["gamma", 2], ["alpha", 2]]) {
    event({ type: "agent_updated", id, state: "running", tool_calls: n });
    assert.deepEqual(faceOrder(h.doc), ["alpha", "beta", "gamma"], `${id}'s update moved a face`);
    const after = names(h.doc);
    assert.equal(after.length, before.length);
    after.forEach((node, i) => assert.equal(node, before[i], `${id}'s update replaced or moved a name`));
  }
  assert.deepEqual(h.errors, []);
});

test("a snapshot listing them backwards does not reorder the line", () => {
  const { h, event } = threeAgents();
  const before = names(h.doc);
  event({ type: "agents", items: [
    { id: "gamma", call_id: "c3", description: "writer", state: "running", tool_calls: 3, started_at: 3 },
    { id: "beta", call_id: "c2", description: "reviewer", state: "running", tool_calls: 2, started_at: 2 },
    { id: "alpha", call_id: "c1", description: "explorer", state: "running", tool_calls: 1, started_at: 1 },
  ], total: 3, active: 3 });
  assert.deepEqual(faceOrder(h.doc), ["alpha", "beta", "gamma"]);
  const after = names(h.doc);
  after.forEach((node, i) => assert.equal(node, before[i], "a reversed snapshot moved a name"));
  assert.deepEqual(h.errors, []);
});

test("one member finishing changes only the words between the names", () => {
  const { h, event } = threeAgents();
  const before = names(h.doc);
  const line = h.doc.querySelector(".agent-line");
  event({ type: "agent_ended", id: "beta", state: "finished", tool_calls: 4 });
  event({ type: "agent_updated", id: "gamma", state: "running", tool_calls: 5 });
  event({ type: "agent_ended", id: "alpha", state: "finished", tool_calls: 6 });
  assert.equal(h.doc.querySelector(".agent-line"), line, "the same line, changed in place");
  assert.deepEqual(faceOrder(h.doc), ["alpha", "beta", "gamma"]);
  names(h.doc).forEach((node, i) => assert.equal(node, before[i], "a finish reshuffled a name"));
  assert.deepEqual(h.errors, []);
});

test("agents that start before their spawn card wait in start order, whatever order they arrive in", () => {
  const h = makeDom({ clock: true });
  const event = (data) => h.send({ type: "event", event: data });
  event({ type: "ready", capabilities: { agents: true } });
  event({ type: "turn_start", turn_id: "t", prompt: "delegate" });
  // The frames arrive late-starter first; started_at says who really started first.
  event({ type: "agent_started", id: "late", call_id: "c2", description: "late", state: "running", started_at: 20 });
  event({ type: "agent_started", id: "early", call_id: "c1", description: "early", state: "running", started_at: 10 });
  // No start time (a restored record began before anything this backend saw): it sorts first.
  event({ type: "agents", items: [
    { id: "late", call_id: "c2", description: "late", state: "running", started_at: 20 },
    { id: "early", call_id: "c1", description: "early", state: "running", started_at: 10 },
    { id: "old", call_id: "c0", description: "old", state: "running" },
  ], total: 3, active: 3 });
  const lines = [...h.doc.querySelectorAll(".agent-line")];
  assert.equal(lines.length, 1, "one provisional line at the end of the turn");
  assert.deepEqual(nameOrder(h.doc), ["old", "early", "late"]);
  // Two with the same start keep the order they were first seen in.
  const tie = makeDom({ clock: true });
  const ev2 = (data) => tie.send({ type: "event", event: data });
  ev2({ type: "turn_start", turn_id: "t", prompt: "delegate" });
  ev2({ type: "agent_started", id: "first-seen", call_id: "c1", description: "a", state: "running", started_at: 5 });
  ev2({ type: "agent_started", id: "second-seen", call_id: "c2", description: "b", state: "running", started_at: 5 });
  assert.deepEqual(nameOrder(tie.doc), ["first-seen", "second-seen"]);
  assert.deepEqual([...h.errors, ...tie.errors], []);
});
