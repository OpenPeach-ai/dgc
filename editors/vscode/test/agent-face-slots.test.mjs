// Sub-agents working at the same time never wear the same face.
//
// The face was a hash of the agent's id, so two at work matched one time in eight, and ids made of
// the same characters always matched (Math.imul(h, 33) ≡ h mod 8: the hash is the sum of the
// character codes mod 8, so sid(1) and sid(9) are both seafoam). The CLI now sends each agent's
// face slot -- the lowest one free when it started -- and the panel draws it in a contrast order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainJs } from "./support/webview-dom.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
const NAMES = ["seafoam", "lagoon", "coral", "violet", "amber", "slate", "lime", "rose"];

function view() {
  const v = makeDom();
  const event = (data) => v.send({ type: "event", event: data });
  event({ type: "turn_start", turn_id: "t1", prompt: "split the work" });
  return { ...v, event };
}
function startAgent(event, n, extra = {}) {
  event({ type: "tool_call", call_id: `call_${n}`, name: "task", args: { description: `part ${n}` }, summary: `part ${n}` });
  event({ type: "agent_started", id: sid(n), parent_id: null, call_id: `call_${n}`, description: `part ${n}`,
    depth: 1, state: "running", started_at: n, isolated: true, parallel: true, ...extra });
}
const face = (doc, n) => doc.querySelector(`.agent-chip[data-agent-id="${sid(n)}"] .agent-mark`)?.dataset.face;

test("two agents whose ids hash alike wear different faces once the CLI sends their slots", () => {
  const guard = view();
  startAgent(guard.event, 1);
  startAgent(guard.event, 9);
  assert.equal(face(guard.doc, 1), face(guard.doc, 9), "premise: their ids hash to the same face");
  const { doc, event, errors } = view();
  startAgent(event, 1, { face_slot: 0 });
  startAgent(event, 9, { face_slot: 1 });
  assert.equal(face(doc, 1), "seafoam");
  assert.equal(face(doc, 9), "coral");
  assert.deepEqual(errors, []);
});

test("slots are handed out in a contrast order: seafoam, coral, violet, amber first", () => {
  const { doc, event, errors } = view();
  [0, 1, 2, 3].forEach((slot) => startAgent(event, slot + 1, { face_slot: slot }));
  assert.deepEqual([1, 2, 3, 4].map((n) => face(doc, n)), ["seafoam", "coral", "violet", "amber"]);
  assert.deepEqual(errors, []);
});

test("the order is every face once, and a small batch never shows two look-alikes", () => {
  const order = JSON.parse(mainJs.match(/const AGENT_FACE_ORDER = (\[[^\]]*\])/)[1]);
  assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  const firstFive = new Set(order.slice(0, 5));
  for (const pair of [[0, 1], [2, 7], [3, 5]]) {        // seafoam~lagoon, coral~rose, violet~slate
    assert.ok(!(firstFive.has(pair[0]) && firstFive.has(pair[1])),
      `${NAMES[pair[0]]} and ${NAMES[pair[1]]} both among the first five`);
  }
});

test("a face never leaves an agent: a snapshot without its slot keeps the one it had", () => {
  const { doc, event, errors } = view();
  startAgent(event, 4, { face_slot: 3 });
  assert.equal(face(doc, 4), "amber");
  event({ type: "agents", total: 1, active: 1, items: [{ id: sid(4), parent_id: null, call_id: "call_4",
    description: "part 4", depth: 1, state: "running", tool_calls: 1, isolated: true, parallel: true }] });
  assert.equal(face(doc, 4), "amber");
  event({ type: "agents", total: 1, active: 1, items: [{ id: sid(4), parent_id: null, call_id: "call_4",
    description: "part 4", depth: 1, state: "running", tool_calls: 2, isolated: true, parallel: true,
    face_slot: "3" }] });
  assert.equal(face(doc, 4), "amber", "a malformed slot in a later snapshot took the agent's face away");
  assert.deepEqual(errors, []);
});

test("a snapshot alone carries the face, as after a reload", () => {
  const { doc, event, errors } = view();
  event({ type: "tool_call", call_id: "call_1", name: "task", args: { description: "part 1" }, summary: "part 1" });
  event({ type: "agents", total: 1, active: 1, items: [{ id: sid(1), parent_id: null, call_id: "call_1",
    description: "part 1", depth: 1, state: "running", tool_calls: 0, isolated: true, parallel: true,
    face_slot: 2 }] });
  assert.equal(face(doc, 1), "violet");
  assert.deepEqual(errors, []);
});

test("past eight the slots wrap, and a slot that is not one falls back to the id's own face", () => {
  const { doc, event, errors } = view();
  startAgent(event, 1, { face_slot: 8 });
  startAgent(event, 2, { face_slot: 9 });
  assert.equal(face(doc, 1), "seafoam");
  assert.equal(face(doc, 2), "coral");
  const plain = view();
  startAgent(plain.event, 4);
  const own = face(plain.doc, 4);
  for (const [n, bad] of [[5, "1"], [6, -1], [7, 1.5]]) {
    const v = view();
    startAgent(v.event, 4, { face_slot: bad });
    assert.equal(face(v.doc, 4), own, `face_slot ${JSON.stringify(bad)}`);
    assert.deepEqual(v.errors, []);
  }
  assert.deepEqual(errors, []);
});
