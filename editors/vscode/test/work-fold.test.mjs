// A turn's work folds into "Worked for 43s ›" once its final answer is there (Codex collapses its
// commentary the same way). The one-line progress updates, the tool rows and their groups, thinking and
// sub-agent lines whose agents are done fold into the turn's "Worked for" row, which moves to the top of
// the turn; one click shows them again in place, and the row folds them again once the next turn has
// answered. A detailed message, a message sent mid-turn, question and approval cards, notices, a Pip's
// report and the answer with its "Edited N files" card stay. A turn that ends without its final answer
// (stopped, failed) does not fold. A reload, a reattach and a resume draw the same fold as the live turn.
// jsdom checks the DOM here; work-fold-layout.test.mjs checks what Chromium draws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";
import { ANSWER, ONE_LINE, detailTurn } from "./support/commentary-detail-scene.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
function panel(capabilities = {}) {
  const v = makeDom({ clock: true });
  const event = (data) => v.send({ type: "event", event: data });
  event({ type: "ready", capabilities, model: "m", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
    workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 });
  const blocks = () => [...v.doc.querySelectorAll("#log .msg.dgc")];
  const click = (node) => node.dispatchEvent(new v.dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
  const key = (node, k) => node.dispatchEvent(new v.dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  return { ...v, event, events: (list) => list.forEach(event), blocks, click, key };
}
const row = (block) => block.querySelector(":scope > .thinking");
// What the turn holds at its own level, in order: the row, then each block and whether it is folded.
const kind = (node) => node.matches(".thinking") ? "row" : node.matches(".text.commentary-detail") ? "detail"
  : node.matches(".text.commentary") ? "line" : node.matches(".tool-group") ? "tools" : node.matches(".answer") ? "answer"
    : node.matches(".msg.user") ? "you" : node.matches(".agent-line") ? "agent" : node.matches(".card") ? "card"
      : node.matches(".tool") ? `tool:${node.dataset.toolName}` : node.matches(".sys") ? "notice" : node.className;
const shape = (block) => [...block.children].filter((node) => !node.matches(".role"))
  .map((node) => `${kind(node)}${node.classList.contains("work-step") ? " (folded)" : ""}`);
const textOf = (block, words) => [...block.querySelectorAll(".text")].find((node) => node.textContent.includes(words));

test("an answered turn folds its progress lines and tool rows into its Worked for row, which heads the turn", () => {
  const p = panel();
  const frames = detailTurn("t1");
  p.events(frames.slice(0, -3));                         // the work, before the final answer
  const [block] = p.blocks();
  assert.equal(block.classList.contains("work-folded"), false, "nothing folds while the turn works");
  assert.equal(block.querySelectorAll(".work-step").length, 0);
  assert.equal(row(block).getAttribute("role"), null, "the live row is not a control");
  p.events(frames.slice(-3));                            // the answer, then turn_end
  assert.ok(block.classList.contains("has-work-fold") && block.classList.contains("work-folded"));
  assert.deepEqual(shape(block), ["row", "line (folded)", "tools (folded)", "detail", "tools (folded)", "line (folded)",
    "tools (folded)", "answer"]);
  const act = row(block);
  assert.match(act.textContent, /^Worked for \d+s$/, "the same Worked for row, not a second one");
  assert.equal(block.querySelectorAll(".thinking").length, 1);
  assert.ok(act.classList.contains("work-toggle"));
  assert.equal(act.getAttribute("role"), "button");
  assert.equal(act.getAttribute("aria-expanded"), "false");
  assert.equal(act.tabIndex, 0, "reachable with Tab");
  assert.ok(textOf(block, "Why the stock value is off").isConnected, "the detailed message stays");
  assert.match(block.querySelector(".answer .text.final").textContent, new RegExp(ANSWER.slice(0, 20)));
  assert.ok(block.querySelector(".answer > .turn-summary"), "and so does what the turn changed");
  assert.equal(block.querySelector(".answer").classList.contains("work-step"), false);
  assert.deepEqual(p.errors, []);
});

test("one click opens the work in place under the row and a second folds it; Enter and Space do the same", () => {
  const p = panel();
  p.events(detailTurn("t1"));
  const [block] = p.blocks();
  const act = row(block);
  p.click(act);
  assert.equal(block.classList.contains("work-folded"), false, "opened");
  assert.equal(act.getAttribute("aria-expanded"), "true");
  assert.equal(block.children[1], act, "the row stays at the top, the work under it");
  assert.equal(textOf(block, ONE_LINE).classList.contains("work-step"), true, "still a step of the fold, only shown");
  p.click(act);
  assert.equal(block.classList.contains("work-folded"), true, "folded again");
  assert.equal(act.getAttribute("aria-expanded"), "false");
  p.key(act, "Enter");
  assert.equal(act.getAttribute("aria-expanded"), "true");
  p.key(act, " ");
  assert.equal(act.getAttribute("aria-expanded"), "false");
  // A click inside the opened work (a tool group's own line) is the group's, not the fold's.
  p.click(act);
  p.click(block.querySelector(".tool-group > summary"));
  assert.equal(block.classList.contains("work-folded"), false);
  assert.deepEqual(p.errors, []);
});

test("an opened turn folds again once the next turn has answered, not while it works", () => {
  const p = panel();
  p.events(detailTurn("t1"));
  const [first] = p.blocks();
  p.click(row(first));
  const next = detailTurn("t2");
  p.events(next.slice(0, -3));
  assert.equal(first.classList.contains("work-folded"), false, "the next turn is still working: what you opened stays open");
  p.events(next.slice(-3));
  assert.equal(first.classList.contains("work-folded"), true, "the next turn's answer folds it again");
  assert.equal(row(first).getAttribute("aria-expanded"), "false");
  assert.equal(p.blocks()[1].classList.contains("work-folded"), true);
  // A next turn that answered with nothing to fold of its own still folds the one above it.
  p.click(row(first));
  p.events([{ type: "turn_start", turn_id: "t3", prompt: "and in one word?", kind: "prompt" },
    { type: "text_delta", text: "Fixed." }, { type: "stream_end", message_id: "t3:1", phase: "answer" },
    { type: "turn_end", turn_id: "t3", reason: "completed", token_estimate: 1, final_message_id: "t3:1" }]);
  assert.equal(first.classList.contains("work-folded"), true);
  const last = p.blocks().at(-1);
  assert.equal(last.classList.contains("has-work-fold"), false, "an answer alone has nothing to fold");
  assert.equal(row(last).getAttribute("role"), null, "and its row stays a plain line");
  assert.match(row(last).textContent, /^Worked for \d+s$/);
  assert.deepEqual(p.errors, []);
});

test("a turn that ends without its final answer does not fold", () => {
  for (const [reason, finalId, word] of [["cancelled", "t1:3", "Stopped"], ["error", "t1:3", "Failed"],
    ["paused", "t1:3", "Paused"], ["completed", null, "Worked"]]) {
    const p = panel();
    const frames = detailTurn("t1", { end: false });
    p.events([...frames, { type: "turn_end", turn_id: "t1", reason, token_estimate: 1, final_message_id: finalId }]);
    const [block] = p.blocks();
    assert.equal(block.classList.contains("has-work-fold"), false, `${reason}: no fold`);
    assert.equal(block.querySelectorAll(".work-step").length, 0, `${reason}: every step stays on screen`);
    assert.equal(row(block).getAttribute("role"), null);
    assert.match(row(block).textContent, new RegExp(`^${word}`));
    assert.deepEqual(p.errors, []);
  }
  // The control: the same work, answered, folds.
  const p = panel();
  p.events([...detailTurn("t1", { end: false }), { type: "text_delta", text: ANSWER },
    { type: "stream_end", message_id: "t1:4", phase: "answer" },
    { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 1, final_message_id: "t1:4" }]);
  assert.ok(p.blocks()[0].classList.contains("work-folded"));
});

test("what a reader still needs stays: a question, an approval, a notice, a message sent mid-turn, a Pip's report", () => {
  const p = panel({ pip_reports: 1, history_snapshot: true });
  const QUESTION = { id: "q1", header: "Storage", question: "Which storage backend?", multi_select: false,
    options: [{ label: "SQLite", description: "One file." }, { label: "JSON", description: "Readable." }] };
  const REPORT = { run_id: "run_" + "a".repeat(32), pip_id: "pip_" + "b".repeat(32), name: "ERP daily audit",
    pip_type: "scout", kind: "audit", outcome: "findings", finished_at: "2026-10-18T13:00:00.000Z", earlier: 0, total: 1,
    counts: { high: 1 }, findings: [{ title: "GST total skips cess", severity: "high", path: "app/gst.py", line: 88 }] };
  p.events([{ type: "turn_start", turn_id: "t1", prompt: "sync the settings", kind: "prompt" },
    { type: "text_delta", text: "I'll read the settings code first." }, { type: "stream_end", message_id: "t1:1", phase: "commentary" },
    { type: "tool_call", call_id: "c1", name: "read_file", args: { path: "settings.py" }, summary: "settings.py" },
    { type: "tool_result", call_id: "c1", name: "read_file", output: "x = 1", is_error: false },
    { type: "tool_call", call_id: "call_q", name: "propose_options", args: {}, summary: "1 question · Storage" },
    { type: "options_request", id: "r1", call_id: "call_q", questions: [QUESTION] },
    { type: "options_resolved", id: "r1", call_id: "call_q", outcome: "answered", questions: [QUESTION],
      answers: { q1: { selected: [0], other: "" } } },
    { type: "tool_result", call_id: "call_q", name: "propose_options", output: "The user answered: SQLite", is_error: false },
    { type: "permission_request", id: "p1", name: "bash", command: "rm -rf build", args: {}, summary: "rm -rf build" },
    { type: "permission_resolved", id: "p1", decision: "yes", message: "Allowed once" },
    { type: "tool_call", call_id: "c2", name: "bash", args: { command: "rm -rf build" }, summary: "rm -rf build" },
    { type: "tool_result", call_id: "c2", name: "bash", output: "", is_error: false },
    { type: "error", message: "transient: rate limited, retrying" },
    { type: "pip_report", report: REPORT },
    { type: "text_delta", text: "Done: settings sync uses SQLite." }, { type: "stream_end", message_id: "t1:2", phase: "answer" },
    { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 1, final_message_id: "t1:2" }]);
  const [block] = p.blocks();
  assert.ok(block.classList.contains("work-folded"));
  const kept = [...block.children].filter((node) => !node.matches(".role") && !node.classList.contains("work-step")).map(kind);
  assert.deepEqual(kept, ["row", "tool:propose_options", "card", "notice", "notice", "answer"], shape(block).join(" | "));
  assert.match(block.querySelector(".card").textContent, /rm -rf build/, "the approval card");
  assert.deepEqual(shape(block).filter((part) => part.endsWith("(folded)")), ["line (folded)", "tools (folded)", "tools (folded)"]);
  const report = p.doc.querySelector("#log .pip-report");
  assert.ok(report && !report.closest(".msg.dgc"), "a Pip's report is its own card in the transcript, never in a turn's fold");
  assert.equal(report.classList.contains("work-step"), false);
  // A message sent mid-turn, restored from the snapshot as it was drawn live: it stays, between the row and the answer.
  const r = panel({ history_snapshot: true });
  r.event({ type: "history", complete: true, items: [
    { type: "turn_start", turn_id: "h1", prompt: "sync the settings", kind: "prompt" },
    { type: "text_delta", text: "I'll read the settings code first." }, { type: "stream_end", message_id: "h1:1", phase: "commentary" },
    { type: "tool_call", call_id: "c1", name: "read_file", args: { path: "settings.py" }, summary: "settings.py" },
    { type: "tool_result", call_id: "c1", name: "read_file", output: "x = 1", is_error: false },
    { role: "steering", text: "keep the public API" },
    { type: "text_delta", text: "Done." }, { type: "stream_end", message_id: "h1:2", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 1, final_message_id: "h1:2" }] });
  assert.deepEqual(shape(r.blocks()[0]), ["row", "line (folded)", "tools (folded)", "you", "answer"]);
  assert.deepEqual([...p.errors, ...r.errors], []);
});

test("a background sub-agent still working keeps its line; done, it folds the next time the turn folds, and a reload draws it folded", () => {
  const frames = [{ type: "turn_start", turn_id: "bg", prompt: "survey the parser in the background", kind: "prompt" },
    { type: "text_delta", text: "Starting the survey in the background." }, { type: "stream_end", message_id: "bg:1", phase: "commentary" },
    { type: "tool_call", call_id: "call_1", name: "task", args: { description: "Survey the parser", background: true }, summary: "" },
    { type: "agent_started", id: sid(1), parent_id: null, call_id: "call_1", description: "Survey the parser", depth: 1,
      state: "running", started_at: 1, isolated: true, parallel: false, background: true },
    { type: "tool_result", call_id: "call_1", name: "task", output: `Sub-task 'Survey the parser' is running in the background (id ${sid(1)}).`, is_error: false },
    { type: "text_delta", text: "It is running in the background." }, { type: "stream_end", message_id: "bg:2", phase: "answer" },
    { type: "turn_end", turn_id: "bg", reason: "completed", token_estimate: 1, final_message_id: "bg:2" }];
  const p = panel({ agents: true });
  p.events(frames);
  const [block] = p.blocks();
  const line = block.querySelector(":scope > .agent-line");
  assert.ok(block.classList.contains("work-folded"));
  assert.equal(line.classList.contains("work-step"), false, "a sub-agent still working stays on screen");
  p.event({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 9000, tool_calls: 4, message: "done" });
  assert.equal(line.classList.contains("work-step"), false, "not pulled away the moment it finishes");
  p.events(detailTurn("t2"));
  assert.equal(line.classList.contains("work-step"), true, "the next answer folds it in");
  // A reload: the snapshot has no agent frames, and the agents snapshot that follows it draws the lines
  // into turns that have already folded. A finished agent's line folds; one still working stays.
  const record = (state) => ({ id: sid(1), parent_id: null, call_id: "call_1", description: "Survey the parser", depth: 1,
    state, tool_calls: 4, duration_ms: 9000, started_at: 1, isolated: true, parallel: false, background: true });
  const history = frames.filter((frame) => frame.type !== "agent_started");
  for (const [state, folded] of [["finished", true], ["running", false]]) {
    const r = panel({ agents: true, history_snapshot: true });
    r.event({ type: "history", complete: true, items: history });
    r.event({ type: "agents", items: [record(state)], total: 1, active: state === "running" ? 1 : 0 });
    r.advance(3000);
    const restored = r.blocks()[0];
    assert.ok(restored.classList.contains("work-folded"));
    const restoredLine = restored.querySelector(":scope > .agent-line");
    assert.ok(restoredLine, `${state}: the agents snapshot drew its line`);
    assert.equal(restoredLine.classList.contains("work-step"), folded, `${state}: ${folded ? "folded" : "on screen"} after a reload`);
    assert.deepEqual(r.errors, []);
  }
  assert.deepEqual(p.errors, []);
});

test("a reload, a reattach and a resume draw the same fold as the live turn", () => {
  const live = panel();
  live.events(detailTurn("t1"));
  const drawn = shape(live.blocks()[0]);
  // A reload or a resume: the backend's history snapshot.
  const reloaded = panel({ history_snapshot: true });
  reloaded.event({ type: "history", complete: true, items: detailTurn("h1") });
  assert.deepEqual(shape(reloaded.blocks()[0]), drawn);
  assert.ok(reloaded.blocks()[0].classList.contains("work-folded"));
  assert.equal(row(reloaded.blocks()[0]).getAttribute("aria-expanded"), "false");
  // A reattach mid-turn: the snapshot holds the open turn, and the live stream finishes it.
  const reattached = panel({ history_snapshot: true });
  reattached.send({ type: "session_ready", sessionId: "s1" });
  const frames = detailTurn("t1");
  reattached.send({ type: "turn_active", turnId: "t1", kind: "prompt", prompt: frames[0].prompt, startedAt: Date.now() - 4000,
    handoff: false, history: true });
  reattached.event({ type: "history", complete: true, seq: 9, items: frames.slice(0, 8) });
  frames.slice(8).forEach((frame, i) => reattached.event({ ...frame, seq: 10 + i }));
  const block = reattached.blocks().at(-1);
  assert.deepEqual(shape(block), drawn);
  assert.match(row(block).textContent, /^Worked for \d+s$/, "the live end gives it its clock");
  assert.equal(reattached.blocks().length, 1, "one turn, not a replayed one and a live one");
  // Opened in one window, a reload draws it folded again: the fold is how a finished turn reads.
  assert.deepEqual([...live.errors, ...reloaded.errors, ...reattached.errors], []);
});
