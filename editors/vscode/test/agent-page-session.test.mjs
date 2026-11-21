// A sub-agent's own page reads like a Work session (his call, 20 Nov: "completely match the UI of sessions"): the prompt
// it was given as the session draws a prompt; its steps grouped as the session groups them ("Read 1 file, ran 1
// command"); while it works, the session's activity row ("Working (12s · isolated checkout)") under its steps; once it
// ends, its steps fold under "Worked for 41s · isolated checkout ›" at the top, with its answer and files below. Where it
// worked is said on that row, not on a line under the header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
const A = sid(1);
const call = (id, name, args = {}, summary = "") => ({ type: "tool_call", call_id: id, name, args, summary });
const done = (id, name, output = "ok") => ({ type: "tool_result", call_id: id, name, output, is_error: false, is_diff: false });
function view() {
  const v = makeDom({ clock: true });
  const event = (data) => v.send({ type: "event", event: data });
  return { ...v, event, $: (id) => v.doc.getElementById(id) };
}
function start(v) {
  v.event({ type: "turn_start", turn_id: "t1", prompt: "Review billing.py and fix the rounding" });
  v.event(call("call_1", "task", { description: "Write tests for billing rounding",
    prompt: "Write unit tests for total() in billing.py: rounding must happen once, on the sum." }, "Write tests for billing rounding"));
  v.event({ type: "agent_started", id: A, parent_id: null, call_id: "call_1", description: "Write tests for billing rounding",
    depth: 1, state: "running", started_at: 1, isolated: true, parallel: false });
  v.event(call(`${A}:a1`, "read_file", { path: "billing.py" }, "billing.py"));
  v.event(done(`${A}:a1`, "read_file"));
  v.event(call(`${A}:a2`, "bash", { command: "python -m pytest -q" }, "python -m pytest -q"));
}
const open = (v) => v.doc.querySelector(`.agent-name[data-agent-id="${A}"]`).click();
const log = (v) => v.$("agent-log");

test("a working sub-agent's page: its prompt, its steps grouped, the activity row under them", () => {
  const v = view();
  start(v);
  open(v);
  const kids = [...log(v).children];
  assert.ok(kids[0].matches(".msg.user.agent-prompt"), "its prompt first, as the session draws a prompt");
  assert.match(kids[0].textContent, /rounding must happen once/);
  const turn = kids[1];
  assert.ok(turn.matches(".msg.dgc"), "then its turn, as the session draws a turn");
  const groups = [...turn.querySelectorAll(":scope > details.tool-group")];
  assert.equal(groups.length, 1, "consecutive steps are one group, as in the session");
  assert.equal(groups[0].querySelectorAll(":scope > .tool").length, 2);
  assert.match(groups[0].querySelector(".tool-group-label").textContent, /^Running a command/);
  const act = turn.lastElementChild;
  assert.ok(act.matches(".thinking.agent-act"), "the activity row closes the turn while it works");
  assert.equal(act.querySelector(".verb").textContent, "Working");
  assert.match(act.querySelector(".meta").textContent, /^\(\d+s · isolated checkout\)$/);
  assert.equal(v.$("agent-page-meta").hidden, true, "no separate line under the header");
  assert.deepEqual(v.errors, []);
});

test("a finished sub-agent's page folds its steps under Worked for, with its answer below", () => {
  const v = view();
  start(v);
  v.event(done(`${A}:a2`, "bash", "2 passed"));
  v.event(done("call_1", "task", "Sub-task finished."));
  v.event({ type: "agent_ended", id: A, state: "finished", duration_ms: 41000, tool_calls: 2,
    message: "Added tests/test_billing.py with two tests. Both pass.\nFILES: tests/test_billing.py" });
  open(v);
  const turn = log(v).children[1];
  const row = turn.querySelector(":scope > .work-toggle");
  assert.ok(row, "its work folds into one row");
  assert.equal(row, [...turn.children].find((n) => !n.matches(".role")), "at the top of its turn");
  assert.equal(row.textContent, "Worked for 41s · isolated checkout");
  assert.equal(row.getAttribute("aria-expanded"), "false");
  const group = turn.querySelector(":scope > details.tool-group");
  assert.ok(group.classList.contains("work-step"), "its steps are in the fold");
  assert.match(group.querySelector(".tool-group-label").textContent, /^Read 1 file and ran 1 command/);
  const answer = turn.querySelector(":scope > .answer.complete > .text.final.agent-answer");
  assert.match(answer.textContent, /Both pass/);
  assert.ok(group.compareDocumentPosition(answer) & v.dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "the answer after the work");
  assert.ok(turn.querySelector(":scope > .agent-change-card"), "and the files it named");
  row.click();
  assert.equal(row.getAttribute("aria-expanded"), "true", "a click opens it");
  assert.equal(group.classList.contains("work-step") && !group.classList.contains("wf-open") && turn.classList.contains("work-folded"), false);
  row.click();
  assert.equal(row.getAttribute("aria-expanded"), "false", "and folds it again");
  assert.deepEqual(v.errors, []);
});

test("an opened fold and group stay open while the page is drawn again", () => {
  const v = view();
  start(v);
  open(v);
  const group = () => log(v).querySelector("details.tool-group");
  group().open = true;
  v.event(done(`${A}:a2`, "bash", "2 passed"));
  assert.equal(group().open, true, "the group you opened stays open");
  assert.deepEqual(v.errors, []);
});
