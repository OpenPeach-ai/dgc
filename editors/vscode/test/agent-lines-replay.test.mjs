// A reloaded chat draws the sub-agent lines the live turn drew.
//
// Live, a turn is a stream of frames in the order things happened; a reload replays the saved
// transcript (dgc/headless.py), which differs in three ways that matter here: a message's tool calls
// all come before any of their results, a permission decision follows its step's result instead of
// preceding its call, and only the model's own output is kept -- no notices, no request-layer
// retries, no file chips or artifacts, none of a child's hidden steps. Agent frames are never
// replayed: the backend sends a snapshot of its records after the history.
//
// Each scenario runs once live (frame by frame, past every "started working" window) and once as
// history plus snapshot, and the two must agree on every line's members and words and on what each
// turn shows around them. Two backend orderings differ on purpose and are pinned as exceptions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
const NAMES = ["", "Durable rules review", "Remote web", "Paper pip concept"];

const call = (id, name, args = {}, summary = "") => ({ type: "tool_call", call_id: id, name, args, summary });
const result = (id, name, output = "ok", extra = {}) =>
  ({ type: "tool_result", call_id: id, name, output, is_error: false, is_diff: false, ...extra });
const task = (n, extra = {}) => call(`call_${n}`, "task", { description: NAMES[n], prompt: "do it", ...extra });
const outcome = (n) => `Sub-task '${NAMES[n]}' completed with no file changes.\nSummary:\ndone`;
const taskResult = (n, extra = {}) => result(`call_${n}`, "task", outcome(n), extra);
const started = (n, extra = {}) => ({ type: "agent_started", id: sid(n), parent_id: null, call_id: `call_${n}`,
  description: NAMES[n], depth: 1, state: "running", started_at: n, isolated: true, parallel: false, ...extra });
const updated = (n, extra = {}) => ({ type: "agent_updated", id: sid(n), state: "running", ...extra });
const ended = (n, state = "finished", extra = {}) => ({ type: "agent_ended", id: sid(n), state, duration_ms: 1000,
  tool_calls: 2, message: state === "failed" ? "the sub-agent stopped without a final summary" : "done", ...extra });
const record = (n, state = "finished", extra = {}) => ({ id: sid(n), parent_id: null, call_id: `call_${n}`, description: NAMES[n],
  depth: 1, state, tool_calls: 2, duration_ms: 1000, isolated: true, parallel: false, started_at: n, ...extra });
const say = (text, id, phase = "commentary") => [{ type: "text_delta", text }, { type: "stream_end", message_id: id, phase }];
const think = (block, text) => [{ type: "thinking_delta", block, source: "raw", text },
  { type: "thinking_end", block, source: "raw", placement: "collapsed", seconds: 3 }];
// A child's own steps: live only, hidden in the chat, never in the parent's saved transcript.
const childSteps = (n) => [call(`${sid(n)}:g1`, "grep", { pattern: "TODO" }, "TODO"), result(`${sid(n)}:g1`, "grep", "a.py:3")];
const open = (id, prompt = "split the work") => ({ type: "turn_start", turn_id: id, prompt, kind: "prompt" });
const close = (id, finalId) => ({ type: "turn_end", turn_id: id, reason: "completed", final_message_id: finalId });
const snapshot = (records) => ({ type: "agents", items: records, total: records.length,
  active: records.filter((r) => ["queued", "running", "waiting"].includes(r.state)).length });

const READY = { type: "ready", capabilities: { agents: true, history_snapshot: true }, model: "m", mode: "auto", think: "off",
  base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [],
  goal: { text: "", status: "none" }, context_size: 1 };

function live(frames) {
  const v = makeDom({ clock: true });
  const event = (data) => v.send({ type: "event", event: data });
  event(READY);
  for (const frame of frames) {
    if (frame === "wait") v.advance(2000);
    else if (frame.host) v.send(frame.host);
    else event(frame);
  }
  v.advance(5000);
  return v;
}
function replayed(items, records) {
  const v = makeDom({ clock: true });
  const event = (data) => v.send({ type: "event", event: data });
  event(READY);
  event({ type: "history", items, complete: true });
  event(snapshot(records));
  v.advance(5000);
  return v;
}

const shown = (line) => {
  const copy = line.querySelector(".agent-line-text").cloneNode(true);
  copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return copy.textContent.replace(/\u00a0/g, " ");   // a count keeps its word with a no-break space
};
const linesOf = (doc) => [...doc.querySelectorAll("#log .agent-line")].map((line) => ({ ids: line.dataset.agentIds, text: shown(line) }));
// What each turn shows, top to bottom: lines, visible tool groups (what they say, whether folded),
// prose, reasoning headers and steering bubbles. Rows that exist in only one stream are left out.
function turnsOf(doc) {
  return [...doc.querySelectorAll("#log .msg.dgc")].map((block) => [...block.children].flatMap((node) => {
    if (node.matches(".agent-line")) return [`line ${node.dataset.agentIds}: ${shown(node)}`];
    if (node.matches(".tool-group:not(.agent-owned)")) {
      return [`group: ${node.querySelector(".tool-group-label").textContent} (${node.open ? "open" : "folded"})`];
    }
    if (node.matches(".text")) return [`text: ${node.textContent.trim()}`];
    if (node.matches(".answer")) return [`answer: ${node.querySelector(":scope > .text").textContent.trim()}`];
    if (node.matches(".disclosure:not(.agent-owned)")) return ["reasoning"];
    if (node.matches(".msg.user")) return [`steer: ${node.querySelector(".bubble").textContent.trim()}`];
    return [];
  }));
}

const SCENARIOS = {
  // The parallel path (auto mode): every spawn's call, then the batch banner, then each child's
  // notices and its queued start; workers take them; one fails.
  "S1 three in parallel, one failing": {
    live: [open("t1"), ...say("Splitting it three ways.", "t1:1"), task(1), task(2), task(3),
      { type: "info", message: "↯ running 3 isolated sub-tasks in parallel (max 4)" },
      ...[1, 2, 3].flatMap((n) => [{ type: "info", message: `⟳ sub-task: ${NAMES[n]}` },
        { type: "info", message: `↳ isolated checkout: /tmp/wt${n}` }, started(n, { state: "queued", parallel: true })]),
      updated(1), updated(2), updated(3), "wait", ...childSteps(1), ...childSteps(3),
      ended(1), ended(2, "failed"), ended(3),
      taskResult(1), result("call_2", "task", "Sub-task 'Remote web' failed: the sub-agent stopped without a final summary", { is_error: true }),
      taskResult(3), ...say("Two of three landed.", "t1:2", "answer"), close("t1", "t1:2")],
    history: [open("t1"), ...say("Splitting it three ways.", "t1:1"), task(1), task(2), task(3),
      taskResult(1), result("call_2", "task", "Sub-task 'Remote web' failed: the sub-agent stopped without a final summary", { is_error: true }),
      taskResult(3), ...say("Two of three landed.", "t1:2", "answer"), close("t1", "t1:2")],
    records: [record(1), record(2, "failed", { message: "the sub-agent stopped without a final summary" }), record(3)],
    expect: [{ ids: `${sid(1)} ${sid(2)} ${sid(3)}`, text: "Durable rules review finished · Remote web failed · Paper pip concept finished" }],
  },
  // The serial path: a read between two delegations in one message splits them.
  "S2 serial A, a read, then B": {
    live: [open("t1"), task(1), started(1), ...childSteps(1), ended(1), taskResult(1),
      call("r1", "read_file", { path: "README.md" }, "README.md"), result("r1", "read_file", "# readme"),
      task(2), started(2), ended(2), taskResult(2), ...say("Done.", "t1:1", "answer"), close("t1", "t1:1")],
    history: [open("t1"), task(1), call("r1", "read_file", { path: "README.md" }, "README.md"), task(2),
      taskResult(1), result("r1", "read_file", "# readme"), taskResult(2), ...say("Done.", "t1:1", "answer"), close("t1", "t1:1")],
    records: [record(1), record(2)],
    expect: [{ ids: sid(1), text: "Durable rules review finished" }, { ids: sid(2), text: "Remote web finished" }],
  },
  // Background delegations return at once; the agents finish after the turn ended.
  "S3 two background agents, then prose": {
    live: [open("t1"), task(1, { background: true }), started(1, { background: true }),
      result("call_1", "task", `Sub-task '${NAMES[1]}' is running in the background (id ${sid(1)}). `),
      task(2, { background: true }), started(2, { background: true }),
      result("call_2", "task", `Sub-task '${NAMES[2]}' is running in the background (id ${sid(2)}). `),
      ...say("Both are running in the background.", "t1:1", "answer"), close("t1", "t1:1"),
      ...childSteps(1), ended(1), ended(2)],
    history: [open("t1"), task(1, { background: true }), task(2, { background: true }),
      result("call_1", "task", `Sub-task '${NAMES[1]}' is running in the background (id ${sid(1)}). `),
      result("call_2", "task", `Sub-task '${NAMES[2]}' is running in the background (id ${sid(2)}). `),
      ...say("Both are running in the background.", "t1:1", "answer"), close("t1", "t1:1")],
    records: [record(1, "finished", { background: true }), record(2, "finished", { background: true })],
    expect: [{ ids: `${sid(1)} ${sid(2)}`, text: "Durable rules review and Remote web finished" }],
  },
  // Prose between two steps, then reasoning between the next two: three lines.
  "S4 prose, then reasoning, between steps": {
    live: [open("t1"), task(1), started(1), ended(1), taskResult(1), ...say("Now the web part.", "t1:1"),
      task(2), started(2), ended(2), taskResult(2), ...think("t1:th1", "The concept needs its own agent."),
      task(3), started(3), ended(3), taskResult(3), ...say("All three done.", "t1:2", "answer"), close("t1", "t1:2")],
    history: [open("t1"), task(1), taskResult(1), ...say("Now the web part.", "t1:1"), task(2), taskResult(2),
      ...think("t1:th1", "The concept needs its own agent."), task(3), taskResult(3),
      ...say("All three done.", "t1:2", "answer"), close("t1", "t1:2")],
    records: [record(1), record(2), record(3)],
    expect: [{ ids: sid(1), text: "Durable rules review finished" }, { ids: sid(2), text: "Remote web finished" },
      { ids: sid(3), text: "Paper pip concept finished" }],
  },
  // Default mode: delegating needs approval, so the step runs serially and each spawn's approval
  // card comes BEFORE its call live (dgc/agent.py), while a replay draws every call first and each
  // recorded decision after its result.
  "S5 default mode: three tasks behind approvals": {
    live: [open("t1"), ...[1, 2, 3].flatMap((n) => [
      { type: "permission_request", id: `p${n}`, call_id: `call_${n}`, name: "task", args: { description: NAMES[n] },
        summary: NAMES[n], suggested_rule: "task", choices: ["once", "always", "deny"] },
      { type: "permission_resolved", id: `p${n}`, decision: "once", message: "Allowed once" },
      task(n), started(n), ...childSteps(n), ended(n), taskResult(n)]),
      ...say("All three done.", "t1:1", "answer"), close("t1", "t1:1")],
    history: [open("t1"), task(1), task(2), task(3), ...[1, 2, 3].flatMap((n) => [taskResult(n),
      { type: "permission_decision", call_id: `call_${n}`, name: "task", args: { description: NAMES[n] }, message: "Allowed once" }]),
      ...say("All three done.", "t1:1", "answer"), close("t1", "t1:1")],
    records: [record(1), record(2), record(3)],
    expect: [{ ids: `${sid(1)} ${sid(2)} ${sid(3)}`, text: "Durable rules review, Remote web and Paper pip concept finished" }],
  },
  // Why a spawn opens its own group: a replay puts every call of the step before any result, and
  // without the split the bash card joined A's group and the line landed below "Ran 1 command".
  "S6 a delegation, then a command, in one message": {
    live: [open("t1"), task(1), started(1), ended(1), taskResult(1),
      call("b1", "bash", { command: "npm test" }, "npm test"), result("b1", "bash", "ok"),
      ...say("Tests pass.", "t1:1", "answer"), close("t1", "t1:1")],
    history: [open("t1"), task(1), call("b1", "bash", { command: "npm test" }, "npm test"), taskResult(1),
      result("b1", "bash", "ok"), ...say("Tests pass.", "t1:1", "answer"), close("t1", "t1:1")],
    records: [record(1)],
    expect: [{ ids: sid(1), text: "Durable rules review finished" }],
  },
  // Rows that exist only live, between two serial spawns: a child's file chip (its raw call id) and
  // artifact, a sub-agent's retry line, the parent's own request-layer retry.
  "S7 live-only rows between two spawns": {
    live: [open("t1"), task(1), started(1),
      { type: "files_ready", call_id: "c3", items: [{ name: "report.md", rel: "report.md", bytes: 12 }] },
      { type: "artifact_ready", id: "a1", name: "preview", url: "http://127.0.0.1:5173/" },
      { type: "model_retry", retry_id: `t1:${sid(1)}:retry1`, state: "retrying", kind: "connect", layer: "request", attempt: 1,
        max_attempts: 3, summary: "connection refused", delay_ms: 500, origin: "subagent", agent: sid(1), turn_id: "t1" },
      ended(1), taskResult(1),
      { type: "model_retry", retry_id: "t1:retry1", state: "retrying", kind: "connect", layer: "request", attempt: 1,
        max_attempts: 3, summary: "connection refused", delay_ms: 500, origin: "agent", turn_id: "t1" },
      { type: "model_retry", retry_id: "t1:retry1", state: "recovered", kind: "connect", layer: "request", attempt: 1,
        max_attempts: 3, summary: "connection refused", delay_ms: 0, origin: "agent", turn_id: "t1" },
      task(2), started(2), ended(2), taskResult(2), ...say("Both done.", "t1:1", "answer"), close("t1", "t1:1")],
    history: [open("t1"), task(1), task(2), taskResult(1), taskResult(2), ...say("Both done.", "t1:1", "answer"), close("t1", "t1:1")],
    records: [record(1), record(2)],
    expect: [{ ids: `${sid(1)} ${sid(2)}`, text: "Durable rules review and Remote web finished" }],
  },
  // A plan update between two delegations is bookkeeping: it does not split them.
  "S8 a delegation, a plan update, a delegation": {
    live: [open("t1"), task(1), started(1), ended(1), taskResult(1),
      call("td1", "todo", { todos: [] }), result("td1", "todo", "ok"),
      task(2), started(2), ended(2), taskResult(2), ...say("Both done.", "t1:1", "answer"), close("t1", "t1:1")],
    history: [open("t1"), task(1), call("td1", "todo", { todos: [] }), task(2), taskResult(1), result("td1", "todo", "ok"),
      taskResult(2), ...say("Both done.", "t1:1", "answer"), close("t1", "t1:1")],
    records: [record(1), record(2)],
    expect: [{ ids: `${sid(1)} ${sid(2)}`, text: "Durable rules review and Remote web finished" }],
  },
};

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`live and reloaded agree: ${name}`, () => {
    const a = live(scenario.live), b = replayed(scenario.history, scenario.records);
    assert.deepEqual(linesOf(a.doc), scenario.expect, "live");
    assert.deepEqual(linesOf(b.doc), scenario.expect, "reloaded");
    assert.deepEqual(turnsOf(b.doc), turnsOf(a.doc));
    assert.deepEqual([...a.errors, ...b.errors], []);
  });
}

test("a reloaded agent that is still running reads 'running', never 'started working'", () => {
  const b = replayed([open("t1"), task(1)], [record(1, "running")]);
  assert.deepEqual(linesOf(b.doc), [{ ids: sid(1), text: "Durable rules review running" }]);
  // ...even as it keeps working once the live turn resumes: only a live start opens the window.
  b.send({ type: "event", event: updated(1, { tool_calls: 5 }) });
  assert.deepEqual(linesOf(b.doc), [{ ids: sid(1), text: "Durable rules review running" }]);
  assert.deepEqual(b.errors, []);
});

// Where the backend itself emits a step's calls out of message order, live and reload cannot agree
// on position, only on who shares the line (dgc/agent.py runs a todo before a parallel batch, and
// deferred background calls, after the batch's spawns). The fix is in the backend: emit every call
// of a step in call order before running the batch.
const membership = (doc) => [...doc.querySelectorAll("#log .agent-line")].map((line) => line.dataset.agentIds.split(" ").sort().join(" "));

test("exception S9: a plan update before a parallel batch moves, but the batch is one line in both", () => {
  const a = live([open("t1"), task(1), task(2), { type: "info", message: "↯ running 2 isolated sub-tasks in parallel (max 4)" },
    started(1, { state: "queued", parallel: true }), started(2, { state: "queued", parallel: true }),
    call("td1", "todo", { todos: [] }), result("td1", "todo", "ok"), updated(1), updated(2), ended(1), ended(2),
    taskResult(1), taskResult(2), ...say("Both done.", "t1:1", "answer"), close("t1", "t1:1")]);
  const b = replayed([open("t1"), call("td1", "todo", { todos: [] }), task(1), task(2), result("td1", "todo", "ok"),
    taskResult(1), taskResult(2), ...say("Both done.", "t1:1", "answer"), close("t1", "t1:1")], [record(1), record(2)]);
  assert.deepEqual(membership(a.doc), [`${sid(1)} ${sid(2)}`]);
  assert.deepEqual(membership(b.doc), membership(a.doc));
  // A plan update alone reads "Used 1 tool" once finished (transcript-icons.test.mjs).
  const plan = (doc) => turnsOf(doc)[0].findIndex((row) => row.startsWith("group: Used 1 tool"));
  const line = (doc) => turnsOf(doc)[0].findIndex((row) => row.startsWith("line"));
  assert.ok(plan(a.doc) > line(a.doc) && plan(b.doc) < line(b.doc), "the documented divergence: the plan group's side of the line");
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("exception S10: a deferred background spawn is named last live and first on reload, in one line both times", () => {
  const a = live([open("t1"), task(2), task(3), { type: "info", message: "↯ running 2 isolated sub-tasks in parallel (max 4)" },
    started(2, { state: "queued", parallel: true }), started(3, { state: "queued", parallel: true }),
    task(1, { background: true }), started(1, { background: true }),
    result("call_1", "task", `Sub-task '${NAMES[1]}' is running in the background (id ${sid(1)}). `),
    updated(2), updated(3), ended(2), ended(3), ended(1), taskResult(2), taskResult(3),
    ...say("Done.", "t1:1", "answer"), close("t1", "t1:1")]);
  const b = replayed([open("t1"), task(1, { background: true }), task(2), task(3),
    result("call_1", "task", `Sub-task '${NAMES[1]}' is running in the background (id ${sid(1)}). `),
    taskResult(2), taskResult(3), ...say("Done.", "t1:1", "answer"), close("t1", "t1:1")],
  [record(1, "finished", { background: true, started_at: 9 }), record(2), record(3)]);
  assert.deepEqual(membership(a.doc), [`${sid(1)} ${sid(2)} ${sid(3)}`]);
  assert.deepEqual(membership(b.doc), membership(a.doc));
  assert.deepEqual(linesOf(a.doc).map((l) => l.text), ["Remote web, Paper pip concept and Durable rules review finished"]);
  assert.deepEqual(linesOf(b.doc).map((l) => l.text), ["Durable rules review, Remote web and Paper pip concept finished"]);
  assert.deepEqual([...a.errors, ...b.errors], []);
});
