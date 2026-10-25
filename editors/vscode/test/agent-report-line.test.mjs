// A finished background agent's report in the Work chat (ready.capabilities.agent_reports, 0.48).
//
// In Claude Code a background sub-agent's final report arrives as one muted line with a › that opens
// the whole report. DGC drew "Woke on agent · <label>" and nothing more: the report reached the model,
// never the chat, and only the agent's page in the agent map showed it. Now the wake note is that line,
// one per finished agent, folded; a click or Enter/Space opens the report the way the agent page draws
// it (what became of its changes, what it said, the files it named) with "Open in agent map". A reload
// replays the same `agent_report` events, so it draws the same lines. An older CLI sends none and the
// note stays as it was. Real geometry and colours are agent-report-line-layout.test.mjs's, in Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDom, mainCss, panelSrc } from "./support/webview-dom.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
const INTEGRATED = "Sub-task 'Review billing.py' completed and integrated 2 path(s): billing.py, test_billing.py.\n"
  + "Summary:\nThe rounding bug is in `total()`: it rounded each line.\n\n- Fixed it to round once.\n- Added a test.\n"
  + "FILES: billing.py, test_billing.py";
const HELD = "Sub-task 'Port the CLI' completed but its changes were NOT integrated: conflict. Conflicts: cli.py. "
  + "The isolated worktree is preserved at /work/.dgc/worktrees/sub-2 on branch dgc/sub-2.\nSummary:\nPorted the argument parser.";
const READY = { type: "ready", model: "m", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1,
  capabilities: { agents: true, agent_control: true, agent_reports: 1 } };

function view() {
  const v = makeDom();
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  event(READY);
  v.send({ type: "session_ready", sessionId: "s1" });
  const lines = () => [...v.doc.querySelectorAll("#log .handback-line")];
  const toggle = (line) => line.querySelector(":scope > .handback-toggle");
  const body = (line) => line.querySelector(":scope > .handback-body");
  return { ...v, event, $, lines, toggle, body };
}
// The background spawn, as a live chat has it: the agent starts in the parent's turn and outlives it.
function spawn(p, n, description) {
  p.event({ type: "tool_call", call_id: `call_${n}`, name: "task", args: { description, background: true }, summary: description });
  p.event({ type: "agent_started", id: sid(n), parent_id: null, call_id: `call_${n}`, description, depth: 1,
    state: "running", started_at: 1000 + n, isolated: true, parallel: false, background: true });
  p.event({ type: "tool_result", call_id: `call_${n}`, name: "task", is_error: false, is_diff: false,
    output: `Sub-task '${description}' is running in the background (id ${sid(n)}). I will continue when it finishes.` });
}
const wake = (turnId, n, description, report, integrated = true) => [
  { type: "turn_start", turn_id: turnId, prompt: description, kind: "wake" },
  { type: "agent_report", turn_id: turnId, id: sid(n), description, report, integrated },
  { type: "text_delta", text: `${description} is done.` },
  { type: "stream_end", message_id: `${turnId}:1`, phase: "answer" },
  { type: "turn_end", turn_id: turnId, reason: "completed", token_estimate: 0, final_message_id: `${turnId}:1` },
];
function parentTurn(p) {
  p.event({ type: "turn_start", turn_id: "t1", prompt: "Review billing and port the CLI in the background", kind: "prompt" });
  spawn(p, 1, "Review billing.py");
  spawn(p, 2, "Port the CLI");
  p.event({ type: "text_delta", text: "Two helpers are on it." });
  p.event({ type: "stream_end", message_id: "t1:1", phase: "answer" });
  p.event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:1" });
}
const shape = (p) => p.lines().map((line) => ({
  text: p.toggle(line).textContent, expanded: p.toggle(line).getAttribute("aria-expanded"), hidden: p.body(line).hidden }));

test("a finished agent is one muted line in place of the wake note, folded, and never a you bubble", () => {
  const p = view();
  parentTurn(p);
  for (const ev of wake("t2", 1, "Review billing.py", INTEGRATED)) p.event(ev);
  const [line] = p.lines();
  assert.ok(line, "the line is drawn");
  assert.equal(p.doc.querySelectorAll("#log .resume-note.monitor-note").length, 1, "the note became the line: not a second marker");
  assert.ok(line.matches(".resume-note.monitor-note"), "quiet, like the note it replaces");
  assert.deepEqual(shape(p), [{ text: "Woke on agent · Review billing.py", expanded: "false", hidden: true }]);
  assert.equal(p.doc.querySelectorAll("#log .msg.user").length, 1, "only the prompt somebody typed");
  assert.equal(line.closest(".turn").querySelector(".turn-head").textContent.includes("Review billing and port"), true,
    "the wake continues the box of the prompt above it, which stays the one pinned");
  assert.equal(line.classList.contains("turn-head"), false);
  assert.ok(!/rounding/.test(line.textContent), "folded: the report is not on screen (nor drawn) until it is opened");
  assert.deepEqual(p.errors, []);
});

test("a click opens the full report as the agent page draws it, with the integration note and Open in agent map", () => {
  const p = view();
  parentTurn(p);
  for (const ev of wake("t2", 1, "Review billing.py", INTEGRATED)) p.event(ev);
  const [line] = p.lines();
  const toggle = p.toggle(line), body = p.body(line);
  assert.equal(toggle.tagName, "BUTTON", "a real button: Enter and Space work as on any button");
  assert.equal(toggle.type, "button");
  assert.equal(toggle.getAttribute("aria-controls"), body.id);
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(body.hidden, false);
  assert.equal(body.getAttribute("role"), "region");
  assert.equal(body.getAttribute("aria-label"), "Report from Review billing.py");
  const note = body.querySelector(".agent-page-outcome");
  assert.equal(note.textContent, "Sub-task 'Review billing.py' completed and integrated 2 path(s): billing.py, test_billing.py.");
  assert.equal(note.dataset.held, undefined, "integrated work is not called out");
  const answer = body.querySelector(".handback-answer");
  assert.match(answer.innerHTML, /<code>total\(\)<\/code>/, "Markdown, rendered");
  assert.deepEqual([...answer.querySelectorAll("li")].map((li) => li.textContent), ["Fixed it to round once.", "Added a test."]);
  assert.ok(!/FILES:/.test(answer.textContent), "the FILES line is the files card, not prose");
  assert.deepEqual([...body.querySelectorAll(".agent-file")].map((b) => b.textContent), ["billing.py", "test_billing.py"]);
  const map = body.querySelector(".handback-map");
  assert.equal(map.tagName, "BUTTON");
  assert.equal(map.textContent, "Open in agent map");
  assert.ok(!body.querySelector(".text"), "never a .text block: a turn's answer is found by that class");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(body.hidden, true, "and folds again");
  assert.deepEqual(p.errors, []);
});

test("work held back says so in the transcript's colour, with where the worktree is kept", () => {
  const p = view();
  parentTurn(p);
  for (const ev of wake("t2", 2, "Port the CLI", HELD, false)) p.event(ev);
  const [line] = p.lines();
  p.toggle(line).click();
  const note = p.body(line).querySelector(".agent-page-outcome");
  assert.equal(note.dataset.held, "1");
  assert.match(note.textContent, /NOT integrated/);
  assert.match(note.textContent, /preserved at \/work\/\.dgc\/worktrees\/sub-2 on branch dgc\/sub-2/);
  assert.match(mainCss, /\.agent-page-outcome\[data-held\] \{ color: var\(--text\); \}/);
  // A failure is all note: no "error: " the model reads, and nothing made up for a report.
  for (const ev of wake("t3", 1, "Review billing.py", "error: Sub-task 'Review billing.py' did not complete: the model timed out.", false)) p.event(ev);
  const failed = p.lines().at(-1);
  p.toggle(failed).click();
  assert.equal(p.body(failed).querySelector(".agent-page-outcome").textContent,
    "Sub-task 'Review billing.py' did not complete: the model timed out.");
  assert.equal(p.body(failed).querySelector(".handback-answer"), null);
  // One that ran in the shared checkout (no Git): DGC's sentence, then what it said.
  for (const ev of wake("t4", 1, "Review billing.py", "Sub-task 'Review billing.py' completed in the shared checkout. This task "
    + "ran sequentially because an isolated Git checkout was unavailable. Summary:\nThe rounding bug is in total().", false)) p.event(ev);
  const shared = p.lines().at(-1);
  p.toggle(shared).click();
  assert.match(p.body(shared).querySelector(".agent-page-outcome").textContent, /was unavailable\.$/);
  assert.equal(p.body(shared).querySelector(".handback-answer").textContent.trim(), "The rounding bug is in total().");
  assert.deepEqual(p.errors, []);
});

test("Open in agent map opens the map at that agent's card, and closing it comes back to the link", () => {
  const p = view();
  parentTurn(p);
  p.event({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 4000, tool_calls: 3, message: "The rounding bug is in total()." });
  for (const ev of wake("t2", 1, "Review billing.py", INTEGRATED)) p.event(ev);
  const [line] = p.lines();
  p.toggle(line).click();
  const link = p.body(line).querySelector(".handback-map");
  link.click();
  assert.equal(p.$("agent-map").hidden, false, "the map is open");
  assert.equal(p.$("agent-card").hidden, false, "at the agent's own card");
  assert.equal(p.$("agent-card-title").textContent, "Review billing.py");
  p.$("agent-card-back").click();
  p.$("agent-map-close").click();
  assert.equal(p.$("agent-map").hidden, true);
  assert.equal(p.doc.activeElement, link, "focus comes back where the reader left");
  assert.deepEqual(p.errors, []);
});

test("several finished agents get one line each: in their own wake turns, or in one", () => {
  const p = view();
  parentTurn(p);
  for (const ev of wake("t2", 1, "Review billing.py", INTEGRATED)) p.event(ev);
  for (const ev of wake("t3", 2, "Port the CLI", HELD, false)) p.event(ev);
  assert.deepEqual(shape(p).map((s) => s.text), ["Woke on agent · Review billing.py", "Woke on agent · Port the CLI"]);
  // One wake that delivers two: two lines, in order, both above the turn's reply.
  p.event({ type: "turn_start", turn_id: "t4", prompt: "Review billing.py", kind: "wake" });
  p.event({ type: "agent_report", turn_id: "t4", id: sid(1), description: "Review billing.py", report: INTEGRATED, integrated: true });
  p.event({ type: "agent_report", turn_id: "t4", id: sid(2), description: "Port the CLI", report: HELD, integrated: false });
  p.event({ type: "agent_report", turn_id: "t4", id: sid(2), description: "Port the CLI", report: HELD, integrated: false });
  p.event({ type: "text_delta", text: "Both are done." });
  p.event({ type: "turn_end", turn_id: "t4", reason: "completed", token_estimate: 0 });
  const box = p.lines().at(-1).closest(".turn");
  const t4 = [...box.children].slice(-3);
  assert.deepEqual(t4.map((n) => n.matches(".handback-line") ? p.toggle(n).textContent : n.matches(".msg.dgc") ? "DGC" : n.className),
    ["Woke on agent · Review billing.py", "Woke on agent · Port the CLI", "DGC"], "one line per agent, never a repeat");
  assert.equal(new Set(p.lines().map((line) => p.toggle(line).getAttribute("aria-controls"))).size, p.lines().length,
    "each line controls its own report");
  assert.deepEqual(p.errors, []);
});

test("a reload replays the same lines with the same reports, folded", () => {
  const live = view();
  parentTurn(live);
  for (const ev of [...wake("t2", 1, "Review billing.py", INTEGRATED), ...wake("t3", 2, "Port the CLI", HELD, false)]) live.event(ev);
  const items = [
    { type: "turn_start", turn_id: "h1", prompt: "Review billing and port the CLI in the background", kind: "prompt" },
    { type: "text_delta", text: "Two helpers are on it." },
    { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: "h1:1" },
    ...wake("h2", 1, "Review billing.py", INTEGRATED), ...wake("h3", 2, "Port the CLI", HELD, false),
  ];
  const p = view();
  p.event({ type: "history", items });
  // Every marker in the chat, in order: the reload draws exactly what live drew, no bare note beside a line.
  const notes = (v) => [...v.doc.querySelectorAll("#log .resume-note")].map((n) => n.className.replace(/\s*\bhist\b/, "") + ": " + n.textContent);
  assert.deepEqual(notes(p), notes(live));
  assert.equal(p.doc.querySelectorAll("#log .resume-note.monitor-note:not(.handback-line)").length, 0, "the note became the line");
  assert.deepEqual(shape(p), shape(live));
  assert.deepEqual(shape(p).map((s) => [s.expanded, s.hidden]), [["false", true], ["false", true]]);
  for (const [a, b] of p.lines().map((line, i) => [line, live.lines()[i]])) {
    p.toggle(a).click(); live.toggle(b).click();
    assert.equal(p.body(a).textContent, live.body(b).textContent, "the same report");
  }
  assert.equal(p.doc.querySelectorAll("#log .msg.user").length, 1, "DGC's notice is never a prompt bubble");
  // The live event a reload held while its snapshot landed draws nothing twice.
  p.event({ type: "turn_start", turn_id: "t9", prompt: "Port the CLI", kind: "wake" });
  p.event({ type: "agent_report", turn_id: "t9", id: sid(2), description: "Port the CLI", report: HELD, integrated: false });
  p.event({ type: "agent_report", turn_id: "t9", id: sid(2), description: "Port the CLI", report: HELD, integrated: false });
  assert.equal(p.lines().length, 3);
  assert.deepEqual([...p.errors, ...live.errors], []);
});

test("after a reload Open in agent map finds the agent under the id its chat now gives it", () => {
  const p = view();
  // A reopened chat numbers its agents afresh (sub-<digest>); the spawn's result still names the old id.
  p.event({ type: "history", items: [
    { type: "turn_start", turn_id: "h1", prompt: "review billing in the background", kind: "prompt" },
    { type: "tool_call", call_id: "call_0", name: "task", args: { description: "Review billing.py", background: true }, summary: "Review billing.py" },
    { type: "tool_result", call_id: "call_0", name: "task", is_error: false, is_diff: false,
      output: `Sub-task 'Review billing.py' is running in the background (id ${sid(1)}). I will continue when it finishes.` },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: null },
    ...wake("h2", 1, "Review billing.py", INTEGRATED),
  ] });
  p.event({ type: "agents", total: 1, active: 0, items: [{ id: "sub-aaaaaaaaaaaa", parent_id: null, call_id: "call_0",
    description: "Review billing.py", depth: 1, state: "finished", tool_calls: 0, isolated: false, parallel: false, restored: true }] });
  const [line] = p.lines();
  p.toggle(line).click();
  p.body(line).querySelector(".handback-map").click();
  assert.equal(p.$("agent-card").hidden, false);
  assert.equal(p.$("agent-card-title").textContent, "Review billing.py");
  assert.deepEqual(p.errors, []);
});

test("an older CLI keeps today's note: no agent_report, no line", () => {
  const v = makeDom();
  const event = (data) => v.send({ type: "event", event: data });
  event({ ...READY, capabilities: { agents: true } });
  v.send({ type: "session_ready", sessionId: "s1" });
  event({ type: "turn_start", turn_id: "t1", prompt: "go", kind: "prompt" });
  event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
  event({ type: "turn_start", turn_id: "t2", prompt: "Review billing.py", kind: "wake" });
  event({ type: "text_delta", text: "The helper is done." });
  event({ type: "turn_end", turn_id: "t2", reason: "completed", token_estimate: 0 });
  const note = v.doc.querySelector("#log .resume-note.monitor-note");
  assert.equal(note.textContent, "Woke on agent · Review billing.py");
  assert.equal(note.querySelector("button"), null);
  assert.equal(v.doc.querySelectorAll("#log .handback-line").length, 0);
  assert.deepEqual(v.errors, []);
});

test("the panel asks for reports with the handshake, only from a CLI that offers them", () => {
  assert.match(panelSrc, /Number\(\(ev\.capabilities as any\)\?\.agent_reports\) >= 1\) \{\s*this\.backend\?\.sendSetup\(\{ type: "watch_agent_reports" \}\);/);
  // Before the session is restored: the ask comes ahead of everything the ready handler sends after it.
  const ask = panelSrc.indexOf('type: "watch_agent_reports"');
  const ready = panelSrc.lastIndexOf("this.lastReadyEvent = ev;", ask);
  assert.ok(ready > 0 && ask - ready < 600, "in the ready handler, right after the capabilities are known");
  assert.ok(ask < panelSrc.indexOf("this.syncWorkspaceRoots(backend, true);", ask), "ahead of the handshake's roots and the restore");
  const protocol = readFileSync(new URL("../src/protocol.generated.ts", import.meta.url), "utf8");
  assert.match(protocol, /"watch_agent_reports": \{/);
  assert.match(protocol, /"agent_report": \{/);
});
