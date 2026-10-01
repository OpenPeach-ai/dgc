// A parent steering a running sub-agent, the way Codex shows it: "Sent message to <agent>".
//
// The row was a wrench card reading "Used tool · message task" with no recipient, so a parent
// talking to one of the children it started looked like an unnamed tool. The backend resolves the
// child's description into the summary (dgc/agent.py _with_task_agent); the webview's job is the
// verb, and a mark that says "a message", not a face.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

function panel() {
  const { doc, send, errors } = makeDom();
  const event = (data) => send({ type: "event", event: data });
  event({ type: "turn_start", turn_id: "t1", prompt: "go", kind: "prompt" });
  return { doc, event, errors };
}
const card = (doc, id) => doc.querySelector(`.tool[data-call-id="${id}"]`);
const verb = (doc, id) => card(doc, id).querySelector(".verb").textContent;
const detail = (doc, id) => card(doc, id).querySelector(".arg").textContent;
const mark = (doc, id) => card(doc, id).querySelector(".glyph svg").dataset.icon;
const result = (event, name, id, output) => event({ type: "tool_result", call_id: id, name,
  is_error: false, is_diff: false, diff: "", output });
const groupLabel = (doc) => [...doc.querySelectorAll(".tool-group-label")].at(-1)?.textContent;

test("a message to a sub-agent names the agent it went to", () => {
  const { doc, event, errors } = panel();
  event({ type: "tool_call", call_id: "m1", name: "message_task",
          args: { id: "sub-0123456789ab", text: "use the new schema", agent: "Write the parser" },
          summary: "Write the parser" });
  assert.equal(verb(doc, "m1"), "Sending message to");
  assert.equal(detail(doc, "m1"), "Write the parser");
  assert.equal(mark(doc, "m1"), "message-square", "a message wears a message mark, not the wrench");
  result(event, "message_task", "m1", "Delivered to sub-0123456789ab.");
  assert.equal(verb(doc, "m1"), "Sent message to");
  assert.equal(detail(doc, "m1"), "Write the parser");
  assert.deepEqual(errors, []);
});

test("stopping a sub-agent names the agent that was stopped", () => {
  const { doc, event, errors } = panel();
  event({ type: "tool_call", call_id: "k1", name: "close_task",
          args: { id: "sub-0123456789ab", agent: "Write the parser" }, summary: "Write the parser" });
  assert.equal(verb(doc, "k1"), "Stopping");
  assert.equal(mark(doc, "k1"), "circle-slash");
  result(event, "close_task", "k1", "Signalled sub-0123456789ab to stop.");
  assert.equal(verb(doc, "k1"), "Stopped");
  assert.equal(detail(doc, "k1"), "Write the parser");
  assert.deepEqual(errors, []);
});

test("a lone message in its group says the whole thing, not a verb waiting for its object", () => {
  // The group sentence carries the running step's verb but not the card's detail, so "Sending
  // message to" would have been left hanging there.
  for (const [name, said] of [["message_task", "Messaging a sub-agent"], ["close_task", "Stopping a sub-agent"]]) {
    const { doc, event, errors } = panel();
    event({ type: "tool_call", call_id: "x1", name, args: { id: "sub-0123456789ab" },
            summary: "sub-0123456789ab" });
    assert.equal(groupLabel(doc), said, name);
    assert.deepEqual(errors, []);
  }
});

test("the other supervision tools wear the sub-agent mark, not the wrench", () => {
  const { doc, event, errors } = panel();
  event({ type: "tool_call", call_id: "l1", name: "list_tasks", args: {}, summary: "" });
  event({ type: "tool_call", call_id: "w1", name: "wait_tasks", args: {}, summary: "" });
  assert.equal(mark(doc, "l1"), "bot");
  assert.equal(mark(doc, "w1"), "bot");
  assert.deepEqual(errors, []);
});
