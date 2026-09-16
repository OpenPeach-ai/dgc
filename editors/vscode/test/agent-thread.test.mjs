// Identity chips in the parent turn, an inner agent page, and child tools hidden from the
// parent transcript (they replay on the inner page, filtered by call-id prefix).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

function view() {
  const v = makeDom();
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  return { ...v, event, $ };
}

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;

test("the parent turn shows chips, not the child's greps", () => {
  const { doc, event, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "split the work" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: { description: "map auth" }, summary: "map auth" });
  event({ type: "agent_started", id: sid(1), parent_id: null, call_id: "call_0",
    description: "map auth", depth: 1, state: "running", started_at: 1, isolated: true, parallel: false });
  event({ type: "tool_call", call_id: `${sid(1)}:g1`, name: "grep", args: { pattern: "login" }, summary: "login" });
  event({ type: "tool_call", call_id: "call_1", name: "task", args: { description: "Safari logo fix" }, summary: "Safari logo fix" });
  event({ type: "agent_started", id: sid(2), parent_id: null, call_id: "call_1",
    description: "Safari logo fix", depth: 1, state: "running", started_at: 2, isolated: true, parallel: true });
  event({ type: "agent_ended", id: sid(2), state: "finished", duration_ms: 462000, tool_calls: 6,
    message: "Logo is aligned.\nFILES: app/logo.svg, app/hero.css" });

  const chips = [...doc.querySelectorAll(".agent-chip")];
  assert.equal(chips.length, 2);
  assert.match(chips[0].textContent, /map auth working/);
  assert.match(chips[1].textContent, /Safari logo fix finished/);
  assert.equal(chips[0].querySelector(".agent-mark").dataset.mark, chips[0].querySelector(".agent-mark").dataset.mark);
  assert.ok(chips[0].querySelector(".agent-mark").classList.contains("is-live"));
  assert.ok(!chips[1].querySelector(".agent-mark").classList.contains("is-live"));

  const grep = doc.querySelector('.tool[data-tool-name="grep"]');
  assert.ok(grep.classList.contains("agent-owned"));
  assert.equal(grep.dataset.agentId, sid(1));
  const visibleTools = [...doc.querySelectorAll("#log .tool")].filter((n) => !n.classList.contains("agent-owned"));
  assert.equal(visibleTools.length, 0, "parent task cards are claimed and owned; the chips are the spawn");
  assert.deepEqual(errors, []);
});

test("the same agent id keeps the same identity mark after a second paint", () => {
  const { doc, event } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "agent_started", id: sid(4), parent_id: null, call_id: "call_0",
    description: "one", depth: 1, state: "running", started_at: 1, isolated: false, parallel: false });
  const chip = doc.querySelector(`.agent-chip[data-agent-id="${sid(4)}"]`);
  const first = chip.querySelector(".agent-mark").dataset.mark;
  event({ type: "agent_updated", id: sid(4), state: "running", activity: "reading" });
  event({ type: "agent_ended", id: sid(4), state: "finished", duration_ms: 900, tool_calls: 1 });
  assert.equal(chip.querySelector(".agent-mark").dataset.mark, first);
  assert.ok(["seafoam", "lagoon", "coral", "violet", "amber", "slate", "lime", "rose"]
    .includes(chip.querySelector(".agent-mark").dataset.face));
});

test("clicking a chip opens the inner page with the child's tools, duration and FILES", () => {
  const { $, doc, event, posted, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "fix the logo" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: { description: "Safari logo fix" }, summary: "Safari logo fix" });
  event({ type: "agent_started", id: sid(2), parent_id: null, call_id: "call_0",
    description: "Safari logo fix", depth: 1, state: "running", started_at: 1, isolated: true, parallel: false });
  event({ type: "tool_call", call_id: `${sid(2)}:e1`, name: "edit_file", args: { path: "app/logo.svg" }, summary: "app/logo.svg" });
  event({ type: "agent_ended", id: sid(2), state: "finished", duration_ms: 462000, tool_calls: 3,
    message: "Aligned the mark.\nFILES: app/logo.svg, app/hero.css" });

  const chip = doc.querySelector(`.agent-chip[data-agent-id="${sid(2)}"]`);
  chip.click();
  assert.equal(doc.body.dataset.agentPage, sid(2));
  assert.equal($("agent-page").hidden, false);
  assert.equal($("agent-back").hidden, false);
  assert.equal($("thread-title").textContent, "Safari logo fix");
  assert.match($("agent-page-meta").textContent, /Worked for 7m 42s/);
  assert.match($("agent-log").textContent, /Aligned the mark/);
  assert.ok($("agent-log").querySelector('.tool[data-tool-name="edit_file"]'));
  assert.equal($("agent-log").querySelector('.tool[data-tool-name="task"]'), null, "the parent spawn card stays off the inner page");
  const files = [...$("agent-log").querySelectorAll(".agent-file")].map((n) => n.textContent);
  assert.deepEqual(files, ["app/logo.svg", "app/hero.css"]);
  $("agent-log").querySelector(".agent-file").click();
  assert.equal(posted.at(-1).type, "openFile");
  assert.equal(posted.at(-1).path, "app/logo.svg");

  $("agent-back").click();
  assert.equal($("agent-page").hidden, true);
  assert.ok(!doc.body.dataset.agentPage);
  assert.deepEqual(errors, []);
});

test("child tools after turn_end do not open a Working row on the parent", () => {
  const { $, doc, event, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "agent_started", id: sid(1), parent_id: null, call_id: "call_0",
    description: "map auth", depth: 1, state: "running", started_at: 1, isolated: true, parallel: false,
    background: true });
  event({ type: "text_delta", text: "Running in the background." });
  event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
  event({ type: "tool_call", call_id: `${sid(1)}:g1`, name: "grep", args: { pattern: "login" }, summary: "login" });
  assert.equal(doc.querySelectorAll(".msg.dgc").length, 1, "no second Working turn");
  assert.equal([...doc.querySelectorAll(".msg.dgc .act, .turn-meta")].some((n) => /Working/i.test(n.textContent)), false);
  assert.ok(doc.querySelector('.tool[data-tool-name="grep"]')?.classList.contains("agent-owned"));
  assert.equal($("agents-picker").hidden, false);
  assert.deepEqual(errors, []);
});

test("a background agent keeps the pill after the parent turn ends", () => {
  const { $, doc, event, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "agent_started", id: sid(1), parent_id: null, call_id: "call_0",
    description: "map auth", depth: 1, state: "running", started_at: 1, isolated: true, parallel: false,
    background: true });
  assert.equal($("agents-picker").hidden, false);
  event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
  assert.equal($("agents-picker").hidden, false, "detached children outlive the turn");
  assert.match(doc.querySelector(".agent-chip").textContent, /map auth working/);
  event({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 1200, tool_calls: 2,
    message: "done" });
  event({ type: "turn_start", turn_id: "t2", prompt: "map auth", kind: "wake" });
  assert.match(doc.querySelector(".resume-note").textContent, /Woke on agent/);
  assert.deepEqual(errors, []);
});
