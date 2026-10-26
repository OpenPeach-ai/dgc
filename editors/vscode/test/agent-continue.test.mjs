// A finished helper asked to do more, with its memory (ready.capabilities.continue_agent, dgc/helper_memory.py).
// "Ask it to do more" on its card in the agent map and on its report line in the chat; the same row, marked
// "Continued · 2 runs"; its transcript divided by run ("Continued 18:42 · asked by you"), from its steps in the chat
// (a run's call ids say which: "sub-…:r2-…") or from its saved step log; an older CLI shows no box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, panelSrc } from "./support/webview-dom.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
const READY = { type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 };
const CAPS = { agents: true, agent_control: true, agent_reports: 1, continue_agent: 1 };
// Today at 18:42, local: a fixed calendar day reads "Yesterday 6:42 PM" the day after it was written (26 Oct).
const AT = (() => { const d = new Date(); d.setHours(18, 42, 0, 0); return d.getTime() / 1000; })();
const FINDING = "FINDING-1: total() rounds each line instead of rounding the sum once.";

function view(capabilities = CAPS) {
  const v = makeDom({});
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  event({ ...READY, capabilities });
  v.send({ type: "state", state: { model: "qwen3.8:27b", mode: "default", think: "off" } });
  v.send({ type: "session_ready", sessionId: "s1" });
  const posts = (type) => v.posted.filter((m) => m.type === type).map((m) => JSON.parse(JSON.stringify(m)));
  const open = () => $("agents-pill").click();
  const row = (key) => v.doc.querySelector(`#agent-map .am-row[data-am-key="${key}"]`);
  const card = () => $("agent-card-body");
  const box = (host = card()) => host.querySelector(".agent-more");
  const button = (host, label) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  return { ...v, event, $, posts, open, row, card, box, button };
}

// A helper that reviewed billing.py: its spawn, one step, its end; then, from the CLI, that it can be continued.
function reviewed(p, { runs = null } = {}) {
  p.event({ type: "turn_start", turn_id: "t1", prompt: "Review billing.py" });
  p.event({ type: "tool_call", call_id: "call_1", name: "task", args: { description: "Review billing.py",
    prompt: "REVIEWER: review billing.py for bugs" }, summary: "" });
  p.event({ type: "agent_started", id: sid(1), parent_id: null, call_id: "call_1", description: "Review billing.py",
    depth: 1, state: "running", started_at: AT - 120, isolated: true, parallel: false });
  p.event({ type: "tool_call", call_id: `${sid(1)}:r1`, name: "read_file", args: { path: "billing.py" }, summary: "billing.py" });
  p.event({ type: "tool_result", call_id: `${sid(1)}:r1`, name: "read_file", output: "def total(lines): ...", is_error: false });
  p.event({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 9000, tool_calls: 1, message: FINDING });
  p.event({ type: "tool_result", call_id: "call_1", name: "task", is_error: false,
    output: `Sub-task 'Review billing.py' completed with no file changes.\nSummary:\n${FINDING}` });
  p.event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
  p.event({ type: "agent_runs", items: [runs || { id: sid(1), runs: 1, continuable: true,
    history: [{ run: 1, by: "model", held: false, note: "Sub-task 'Review billing.py' completed with no file changes.", report: FINDING }] }] });
}

const TWO_RUNS = { id: sid(1), runs: 2, continuable: true, history: [
  { run: 1, by: "model", held: false, note: "Sub-task 'Review billing.py' completed with no file changes.", report: FINDING },
  { run: 2, by: "you", at: AT, held: false, request: "Fix what you found.",
    note: "Sub-task 'Review billing.py' completed and integrated 1 path(s): billing.py.", report: "Fixed FINDING-1." }] };

test("a finished helper's card has the box; Continue sends continue_agent's request and the box says it is starting", () => {
  const p = view();
  reviewed(p);
  p.open();
  p.row(`agent:${sid(1)}`).click();
  const box = p.box();
  assert.ok(box && !box.hidden, "Ask it to do more is on its card");
  const field = box.querySelector("textarea");
  assert.equal(field.getAttribute("aria-label"), "Ask it to do more");
  assert.equal(field.placeholder, "Ask it to do more…");
  const send = p.button(box, "Continue");
  assert.equal(send.disabled, true, "nothing to send yet");
  assert.match(box.textContent, /It remembers its work and picks up where it left off\./);
  field.value = "Fix what you found.";
  field.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  assert.equal(send.disabled, false);
  send.click();
  assert.deepEqual(p.posts("continueAgent"), [{ type: "continueAgent", id: sid(1), text: "Fix what you found." }]);
  assert.equal(field.value, "", "the request left the box");
  assert.equal(p.button(box, "Starting…").disabled, true);
  assert.equal(field.disabled, true);
  send.click();
  assert.equal(p.posts("continueAgent").length, 1, "once");
  // The CLI says no: the box says why, and can be used again.
  p.send({ type: "agent_continue_state", id: sid(1), state: "error", error: "This chat is in Plan mode, where DGC changes nothing." });
  assert.match(p.box().textContent, /This chat is in Plan mode, where DGC changes nothing\./);
  assert.ok(p.box().querySelector(".agent-more-note").classList.contains("am-failure"));
  assert.equal(p.box().querySelector("textarea").disabled, false);
  assert.deepEqual(p.errors, []);
});

test("Enter sends, Shift+Enter is a new line; a working helper, a nested one and one the CLI can't continue have no box", () => {
  const p = view();
  reviewed(p);
  p.open();
  p.row(`agent:${sid(1)}`).click();
  const field = p.box().querySelector("textarea");
  field.value = "Fix it.";
  field.dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual(p.posts("continueAgent"), []);
  field.dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert.deepEqual(p.posts("continueAgent"), [{ type: "continueAgent", id: sid(1), text: "Fix it." }]);
  // Working again (the snapshot says so before its new run's steps): no box while it works.
  p.event({ type: "agents", total: 1, active: 1, items: [{ id: sid(1), parent_id: null, call_id: "call_1",
    description: "Review billing.py", depth: 1, state: "running", tool_calls: 1, isolated: true, parallel: false,
    restored: false, background: true }] });
  p.event({ type: "agent_runs", items: [{ ...TWO_RUNS, continuable: false,
    history: [TWO_RUNS.history[0], { run: 2, by: "you", at: AT, held: false, request: "Fix it." }] }] });
  assert.equal(p.box().hidden, true, "no box while it works");
  assert.match(p.row(`agent:${sid(1)}`).textContent, /Continued · 2 runs/, "its own row, continued");
  assert.equal(p.doc.querySelectorAll(`#agent-map .am-row[data-am-key^="agent:"]`).length, 1, "never a second row");
  // A CLI that says it can't be continued (its conversation wasn't kept): no box.
  p.event({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 4000, tool_calls: 2, message: "Fixed it." });
  p.event({ type: "agent_runs", items: [{ ...TWO_RUNS, continuable: false }] });
  assert.equal(p.box().hidden, true);
  p.event({ type: "agent_runs", items: [TWO_RUNS] });
  assert.equal(p.box().hidden, false);
  // A helper's own helper is its parent's to continue: no box on its card.
  p.event({ type: "agent_started", id: sid(2), parent_id: sid(1), call_id: `${sid(1)}:r2-t9`, description: "Check the tests",
    depth: 2, state: "running", started_at: AT, isolated: true, parallel: false });
  p.event({ type: "agent_ended", id: sid(2), state: "finished", duration_ms: 1000, tool_calls: 0, message: "ok" });
  p.event({ type: "agent_runs", items: [{ id: sid(2), runs: 1, continuable: true, history: [{ run: 1, by: "model", held: false }] }] });
  p.$("agent-card-back").click();
  p.row(`agent:${sid(2)}`).click();
  assert.equal(p.box().hidden, true, "nested: no box");
  assert.deepEqual(p.errors, []);
});

test("an older CLI shows no box, whatever it is sent, and the host only sends continue_agent to a CLI that has it", () => {
  const p = view({ agents: true, agent_control: true, agent_reports: 1 });
  reviewed(p);
  p.open();
  p.row(`agent:${sid(1)}`).click();
  assert.equal(p.box().hidden, true, "no continue_agent, no box");
  // The host: watch_agent_runs and continue_agent are both gated on the capability.
  assert.match(panelSrc, /if \(Number\(\(ev\.capabilities as any\)\?\.continue_agent\) >= 1\) \{\s*this\.backend\?\.sendSetup\(\{ type: "watch_agent_runs" \}\);/);
  const method = panelSrc.slice(panelSrc.indexOf("private async continueAgent("), panelSrc.indexOf("private backgroundTasks("));
  assert.match(method, /Number\(\(this\.lastReadyEvent\?\.capabilities as any\)\?\.continue_agent\) < 1\) \{ return; \}/);
  assert.match(method, /type: "continue_agent", id: agentId, text: request/);
  assert.match(panelSrc, /WORK_READ_ONLY_REFUSES = new Set\(\[[^\]]*"continueAgent"[^\]]*\]\)/,
    "read-only while the session is open elsewhere");
  assert.deepEqual(p.errors, []);
});

test("its transcript draws each run after a divider: what the run before said, when, who asked, and what it was asked", () => {
  const p = view();
  reviewed(p);
  // Its second run, live: the snapshot says it works, agent_runs says the run, its steps carry r2.
  p.event({ type: "agents", total: 1, active: 1, items: [{ id: sid(1), parent_id: null, call_id: "call_1",
    description: "Review billing.py", depth: 1, state: "running", tool_calls: 1, isolated: true, parallel: false,
    restored: false, background: true }] });
  p.event({ type: "agent_runs", items: [{ ...TWO_RUNS, runs: 2, continuable: false,
    history: [TWO_RUNS.history[0], { run: 2, by: "you", at: AT, held: false, request: "Fix what you found." }] }] });
  p.event({ type: "tool_call", call_id: `${sid(1)}:r2-w1`, name: "edit_file", args: { path: "billing.py" }, summary: "billing.py" });
  p.event({ type: "tool_result", call_id: `${sid(1)}:r2-w1`, name: "edit_file", output: "edited billing.py", is_error: false });
  p.event({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 4000, tool_calls: 2, message: "Fixed FINDING-1." });
  p.event({ type: "agent_runs", items: [TWO_RUNS] });
  p.open();
  p.row(`agent:${sid(1)}`).click();
  p.button(p.card(), "Open transcript").click();
  const tx = p.$("agent-transcript-log");
  const order = [...tx.children].map((node) => node.classList.contains("agent-run-divider") ? "divider"
    : node.classList.contains("tool") ? `step:${node.dataset.callId}` : node.classList.contains("agent-prompt") ? "prompt" : "");
  assert.deepEqual(order.filter(Boolean).slice(0, 4), ["prompt", `step:${sid(1)}:r1`, "divider", `step:${sid(1)}:r2-w1`],
    "run 1's step, the divider, run 2's step");
  const divider = tx.querySelector(".agent-run-divider");
  const mark = divider.querySelector(".agent-run-mark");
  assert.equal(mark.getAttribute("role"), "separator");
  assert.match(mark.textContent, /^Continued \d{1,2}:42(?:\s?[AP]M)? · asked by you$/);
  assert.match(divider.querySelector(".agent-run-report").textContent, /FINDING-1: total\(\) rounds each line/,
    "what its first run reported");
  assert.equal(divider.querySelector(".agent-run-request .role").textContent, "you");
  assert.match(divider.querySelector(".agent-run-request .bubble").textContent, /Fix what you found\./);
  // Its card says what became of its LATEST run's changes.
  p.$("agent-transcript-back").click();
  assert.match(p.card().textContent, /completed and integrated 1 path\(s\): billing\.py/);
  assert.match(p.row(`agent:${sid(1)}`).textContent, /Finished · Continued · 2 runs/);
  assert.match(p.$("agent-card-meta").textContent, /^Finished · Continued · 2 runs · /, "and its card's meta line");
  assert.deepEqual(p.errors, []);
});

test("a reopened chat divides the runs from the saved step log, by the run each step's call id names", () => {
  const p = view();
  p.event({ type: "agents", total: 1, active: 0, items: [{ id: sid(1), parent_id: null, call_id: "call_1",
    description: "Review billing.py", depth: 1, state: "finished", tool_calls: 2, isolated: true, parallel: false,
    restored: true, message: "Fixed FINDING-1.", log: [
      { type: "tool_call", call_id: `${sid(1)}:r1`, name: "read_file", summary: "billing.py", args: {} },
      { type: "tool_result", call_id: `${sid(1)}:r1`, name: "read_file", output: "def total", is_error: false, is_diff: false },
      { type: "tool_call", call_id: `${sid(1)}:r2-w1`, name: "edit_file", summary: "billing.py", args: {} },
      { type: "tool_result", call_id: `${sid(1)}:r2-w1`, name: "edit_file", output: "edited", is_error: false, is_diff: false }] }] });
  p.event({ type: "agent_runs", items: [{ ...TWO_RUNS, history: TWO_RUNS.history.map((run) => ({ ...run, by: "model" })) }] });
  p.open();
  p.row(`agent:${sid(1)}`).click();
  p.button(p.card(), "Open transcript").click();
  const tx = p.$("agent-transcript-log");
  const nodes = [...tx.children].filter((node) => node.classList.contains("tool") || node.classList.contains("agent-run-divider"));
  assert.deepEqual(nodes.map((node) => node.classList.contains("agent-run-divider") ? "divider" : `step:${node.dataset.callId}`),
    [`step:${sid(1)}:r1`, "divider", `step:${sid(1)}:r2-w1`]);
  assert.match(tx.querySelector(".agent-run-mark").textContent, / · asked by DGC$/);
  assert.equal(tx.querySelector(".agent-run-request .role").textContent, "the main agent");
  assert.deepEqual(p.errors, []);
});

test("its report line in the chat opens to the same box", () => {
  const p = view();
  reviewed(p);
  p.event({ type: "turn_start", turn_id: "t2", kind: "wake", prompt: "" });
  p.event({ type: "agent_report", id: sid(1), description: "Review billing.py", integrated: false,
    report: `Sub-task 'Review billing.py' completed with no file changes.\nSummary:\n${FINDING}` });
  p.event({ type: "turn_end", turn_id: "t2", reason: "completed", token_estimate: 0 });
  const line = p.doc.querySelector(".handback-line");
  line.querySelector(".handback-toggle").click();
  const box = line.querySelector(".agent-more");
  assert.ok(box && !box.hidden, "Ask it to do more under its report");
  box.querySelector("textarea").value = "Now fix it.";
  box.querySelector("textarea").dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  p.button(box, "Continue").click();
  assert.deepEqual(p.posts("continueAgent"), [{ type: "continueAgent", id: sid(1), text: "Now fix it." }]);
  assert.equal(p.button(box, "Starting…").disabled, true);
  assert.deepEqual(p.errors, []);
});

test("a later run's steps drawn above an earlier run's in the chat still read in run order, on its page and its card", () => {
  const p = view();
  reviewed(p);
  // Run 2: the model's continuation, in its turn.
  p.event({ type: "turn_start", turn_id: "t2", prompt: "Have it fix total()." });
  p.event({ type: "tool_call", call_id: "call_2", name: "continue_task", args: { id: sid(1), text: "Fix total().", agent: "Review billing.py" }, summary: "" });
  p.event({ type: "agents", total: 1, active: 1, items: [{ id: sid(1), parent_id: null, call_id: "call_1",
    description: "Review billing.py", depth: 1, state: "running", tool_calls: 1, isolated: true, parallel: false, restored: false }] });
  p.event({ type: "tool_call", call_id: `${sid(1)}:r2-w1`, name: "edit_file", args: { path: "billing.py" }, summary: "billing.py" });
  p.event({ type: "tool_result", call_id: `${sid(1)}:r2-w1`, name: "edit_file", output: "edited", is_error: false });
  p.event({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 3000, tool_calls: 2, message: "Fixed total()." });
  p.event({ type: "tool_result", call_id: "call_2", name: "continue_task", output: "Sub-task 'Review billing.py' completed and integrated 1 path(s): billing.py.\nSummary:\nFixed total().", is_error: false });
  p.event({ type: "turn_end", turn_id: "t2", reason: "completed", token_estimate: 0 });
  // Run 3, asked by you, in the background: its steps arrive with no turn, and the chat may draw them by its spawn.
  const R3 = { ...TWO_RUNS, runs: 3, continuable: false, history: [TWO_RUNS.history[0], { ...TWO_RUNS.history[1], by: "model" },
    { run: 3, by: "you", at: AT + 60, held: false, request: "Now fix discount() too." }] };
  p.event({ type: "agents", total: 1, active: 1, items: [{ id: sid(1), parent_id: null, call_id: "call_1",
    description: "Review billing.py", depth: 1, state: "running", tool_calls: 2, isolated: true, parallel: false, restored: false, background: true }] });
  p.event({ type: "agent_runs", items: [R3] });
  // Drawn where the chat put them: here, ahead of run 2's in the document, as a background run's can be.
  p.event({ type: "tool_call", call_id: `${sid(1)}:r3-w2`, name: "edit_file", args: { path: "billing.py" }, summary: "billing.py" });
  p.event({ type: "tool_result", call_id: `${sid(1)}:r3-w2`, name: "edit_file", output: "edited", is_error: false });
  const r3 = p.doc.querySelector(`.tool[data-call-id="${sid(1)}:r3-w2"]`), r1 = p.doc.querySelector(`.tool[data-call-id="${sid(1)}:r1"]`);
  r1.after(r3);
  p.event({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 3000, tool_calls: 3, message: "Fixed discount()." });
  p.event({ type: "agent_runs", items: [{ ...R3, continuable: true, history: R3.history.map((run) => ({ ...run, note: run.note || "Sub-task 'Review billing.py' completed and integrated 1 path(s): billing.py." })) }] });
  p.open();
  p.row(`agent:${sid(1)}`).click();
  const calls = [...p.card().querySelectorAll(".am-calls > li")].map((li) => li.classList.contains("am-call-run") ? li.textContent : "call");
  assert.deepEqual(calls, ["call", "Continued · asked by DGC", "call", "Continued · asked by you", "call"]);
  p.button(p.card(), "Open transcript").click();
  const order = [...p.$("agent-transcript-log").children]
    .filter((n) => n.classList.contains("tool") || n.classList.contains("agent-run-divider"))
    .map((n) => n.classList.contains("agent-run-divider") ? `divider ${n.dataset.run}` : n.dataset.callId);
  assert.deepEqual(order, [`${sid(1)}:r1`, "divider 2", `${sid(1)}:r2-w1`, "divider 3", `${sid(1)}:r3-w2`]);
  assert.deepEqual(p.errors, []);
});
