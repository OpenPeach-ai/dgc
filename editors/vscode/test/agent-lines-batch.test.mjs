// One `task` call that starts several helpers (its `tasks` form) draws exactly what several task
// calls of one reply draw: an agent line per batch of at most four, a node per helper in the agent
// map, each helper's prompt on its own card -- live, and again from a reloaded chat.
//
// The frames are the backend's (dgc/agent.py _run_task_batch, dgc/headless.py _history): the batch
// call's own card, then one spawn card per helper under `<call id>#<place>`, which is the call id
// each helper's agent record carries. Nothing in the panel keys on one task per tool call, so a
// helper is an ordinary child here; the batch's own card stays as the step that started them,
// named "Delegated 5 helpers · …", with the combined result the model read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
const NAMES = ["", "Map auth", "Map billing", "Map search", "Map ui", "Map jobs"];
const HELPERS = [1, 2, 3, 4, 5];
const ARGS = { tasks: HELPERS.map((n) => ({ description: NAMES[n], prompt: `look at area ${n}` })), background: false };
const SUMMARY = `5 helpers · ${HELPERS.map((n) => NAMES[n]).join(", ")}`;

const call = (id, name, args = {}, summary = "") => ({ type: "tool_call", call_id: id, name, args, summary });
const result = (id, name, output = "ok") => ({ type: "tool_result", call_id: id, name, output, is_error: false, is_diff: false });
const child = (n) => call(`call_1#${n}`, "task", { description: NAMES[n], prompt: `look at area ${n}` });
const outcome = (n) => `Sub-task '${NAMES[n]}' completed with no file changes.\nSummary:\nfinding ${n}`;
const combined = "All 5 helpers ran at the same time. Their results, in the order you listed them:\n\n"
  + HELPERS.map((n) => `[${n}] ${NAMES[n]}\n${outcome(n)}`).join("\n\n");
const started = (n, extra = {}) => ({ type: "agent_started", id: sid(n), parent_id: null, call_id: `call_1#${n}`,
  description: NAMES[n], depth: 1, state: "queued", started_at: n, isolated: true, parallel: true, ...extra });
const record = (n) => ({ id: sid(n), parent_id: null, call_id: `call_1#${n}`, description: NAMES[n], depth: 1,
  state: "finished", tool_calls: 1, duration_ms: 1000, isolated: true, parallel: true, started_at: n });
const say = (text, id, phase) => [{ type: "text_delta", text }, { type: "stream_end", message_id: id, phase }];
const READY = { type: "ready", capabilities: { agents: true, history_snapshot: true }, model: "m", mode: "auto", think: "off",
  base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [],
  goal: { text: "", status: "none" }, context_size: 1 };

const LIVE = [
  { type: "turn_start", turn_id: "t1", prompt: "investigate these five modules in parallel", kind: "prompt" },
  call("call_1", "task", ARGS, SUMMARY),
  ...HELPERS.map(child),
  { type: "info", message: "↯ running 5 isolated sub-tasks in parallel (max 4)" },
  ...HELPERS.flatMap((n) => [{ type: "info", message: `⟳ sub-task: ${NAMES[n]}` }, started(n)]),
  ...[1, 2, 3, 4].map((n) => ({ type: "agent_updated", id: sid(n), state: "running" })), "wait",
  { type: "agent_ended", id: sid(1), state: "finished", duration_ms: 900, tool_calls: 1 }, result("call_1#1", "task", outcome(1)),
  { type: "agent_updated", id: sid(5), state: "running" }, "wait",
  ...[2, 3, 4, 5].flatMap((n) => [{ type: "agent_ended", id: sid(n), state: "finished", duration_ms: 1000, tool_calls: 1 },
    result(`call_1#${n}`, "task", outcome(n))]),
  result("call_1", "task", combined),
  ...say("Five findings.", "t1:1", "answer"),
  { type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: "t1:1" },
];
// What dgc/headless.py replays: the batch call, its helpers' calls, their results, the batch's result.
const HISTORY = [
  { type: "turn_start", turn_id: "t1", prompt: "investigate these five modules in parallel", kind: "prompt" },
  call("call_1", "task", ARGS, SUMMARY), ...HELPERS.map(child),
  ...HELPERS.map((n) => result(`call_1#${n}`, "task", outcome(n))), result("call_1", "task", combined),
  ...say("Five findings.", "t1:1", "answer"),
  { type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: "t1:1" },
];

function live() {
  const v = makeDom({ clock: true });
  const event = (data) => v.send({ type: "event", event: data });
  event(READY);
  for (const frame of LIVE) {
    if (frame === "wait") v.advance(2000);
    else event(frame);
  }
  v.advance(5000);
  return v;
}
function replayed() {
  const v = makeDom({ clock: true });
  const event = (data) => v.send({ type: "event", event: data });
  event(READY);
  event({ type: "history", items: HISTORY, complete: true });
  event({ type: "agents", items: HELPERS.map(record), total: HELPERS.length, active: 0 });
  v.advance(5000);
  return v;
}
const shown = (line) => {
  const copy = line.querySelector(".agent-line-text").cloneNode(true);
  copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return copy.textContent.replace(/ /g, " ");
};
const linesOf = (doc) => [...doc.querySelectorAll("#log .agent-line")].map((line) => ({ ids: line.dataset.agentIds, text: shown(line) }));
const groupsOf = (doc) => [...doc.querySelectorAll("#log .tool-group:not(.agent-owned)")]
  .map((group) => group.querySelector(".tool-group-label").textContent);
const EXPECT = [
  { ids: [1, 2, 3, 4].map(sid).join(" "), text: "Map auth, Map billing and 2 more finished" },
  { ids: sid(5), text: "Map jobs finished" },
];

for (const [name, draw] of [["live", live], ["reloaded", replayed]]) {
  test(`a batch call's helpers are agent lines, at most four to a line (${name})`, () => {
    const v = draw();
    assert.deepEqual(linesOf(v.doc), EXPECT);
    // Each helper's spawn card is claimed by its own agent; the batch's own card is the one step left.
    for (const n of HELPERS) {
      const card = v.doc.querySelector(`#log .tool[data-call-id="call_1#${n}"]`);
      assert.equal(card?.dataset.agentId, sid(n), `helper ${n}'s card belongs to its agent`);
    }
    assert.deepEqual(groupsOf(v.doc), [`Delegated ${SUMMARY}`]);
    const batch = v.doc.querySelector('#log .tool[data-call-id="call_1"]');
    assert.equal(batch.dataset.agentId, undefined, "no agent claims the batch's own card");
    assert.ok(batch.querySelector(".body pre").textContent.startsWith("All 5 helpers ran at the same time."));
    // The lines sit right after the batch's step, before the answer.
    const block = v.doc.querySelector("#log .msg.dgc");
    const kids = [...block.children];
    const lineAt = kids.findIndex((node) => node.matches(".agent-line"));
    const answerAt = kids.findIndex((node) => node.matches(".answer"));
    assert.ok(lineAt > kids.indexOf(batch.closest(".tool-group")) && lineAt < answerAt);
    assert.deepEqual(v.errors, []);
  });

  test(`a batch call's helpers are nodes of the agent map, each with its own prompt (${name})`, () => {
    const v = draw();
    v.doc.getElementById("agents-pill").click();
    assert.equal(v.doc.getElementById("agent-map-subtitle").textContent, "5 agents · click an agent for details");
    const keys = [...v.doc.querySelectorAll("#agent-map-tree .am-row")].map((row) => row.dataset.amKey);
    assert.deepEqual(keys.filter((key) => key !== "root").sort(), HELPERS.map((n) => `agent:${sid(n)}`).sort());
    v.doc.querySelector(`#agent-map .am-row[data-am-key="agent:${sid(3)}"]`).click();
    assert.match(v.doc.getElementById("agent-card-body").textContent, /look at area 3/);
    assert.deepEqual(v.errors, []);
  });
}
