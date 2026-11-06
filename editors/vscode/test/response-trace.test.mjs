import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss } from "./support/webview-dom.mjs";

// History carries saved times as markers beside the events, so no event gains a field. These tests write the time on
// each event and saved() turns it into the markers the backend sends.
const saved = (list) => list.flatMap(({ trace_at_ms: at, trace_tokens: tokens, ...event }) => {
  if (at === undefined) return [event];
  const seconds = at / 1000;
  if (event.type === "turn_start") return [event, { role: "time", of: "prompt", at: seconds }];
  if (event.type === "turn_end") return [{ role: "time", of: "reply", at: seconds }, event];
  return [{ role: "time", of: "trace", at: seconds, ...(tokens === undefined ? {} : { tokens }) }, event];
});
const events = [
  { type: "turn_start", turn_id: "h1", prompt: "Check the tests", kind: "prompt", trace_at_ms: 1000 },
  { type: "tool_call", call_id: "c1", name: "run_shell", args: {}, summary: "rg failed tests", trace_at_ms: 1500, trace_tokens: 1240 },
  { type: "tool_result", call_id: "c1", name: "run_shell", output: "one\ntwo\n", is_error: false, trace_at_ms: 1800 },
  { type: "text_delta", text: "Two tests matched. The result is ready." },
  { type: "stream_end", message_id: "h1:1", phase: "answer", trace_at_ms: 2500, trace_tokens: 940 },
  { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1", trace_at_ms: 2500 },
];

test("a saved answer replays measured model and tool spans with their own details", () => {
  const view = makeDom();
  view.send({ type: "event", event: { type: "history", items: saved(events) } });
  const trace = view.doc.querySelector(".response-actions .ract-trace");
  assert.ok(trace, "Trace follows the existing answer actions");
  assert.equal(trace.previousElementSibling?.dataset.act, "edit");
  trace.click();
  const dialog = view.doc.querySelector(".dgc-trace-dialog");
  assert.ok(dialog);
  assert.deepEqual([...dialog.querySelectorAll(".dgc-trace-label > span:last-child")].map(n => n.textContent),
    ["model.response", "grep", "model.response"]);
  assert.match(dialog.textContent, /1,240 tk/);
  assert.match(dialog.textContent, /2 hits/);
  assert.match(dialog.textContent, /940 tk/);
  assert.equal(dialog.querySelector(".dgc-trace-scrub").max, "1500");
  dialog.querySelector(".dgc-trace-close").click();
  assert.equal(view.doc.querySelector(".dgc-trace-dialog"), null);
  assert.deepEqual(view.errors, []);
});

test("live model usage lands on the completed model span, including a tool-only round", () => {
  const view = makeDom();
  const trace = view.dom.window.DgcTrace.create(1000, "live", "model", false);
  view.dom.window.DgcTrace.modelUsage(trace, 812);
  view.dom.window.DgcTrace.toolStart(trace, { call_id: "live-tool", name: "bash", summary: "rg todo", trace_at_ms: 1300 });
  view.dom.window.DgcTrace.toolEnd(trace, { call_id: "live-tool", name: "bash", output: "one", trace_at_ms: 1600 });
  view.dom.window.DgcTrace.modelEnd(trace, { trace_at_ms: 2200 });
  view.dom.window.DgcTrace.modelUsage(trace, 205);
  view.dom.window.DgcTrace.open(view.dom.window.DgcTrace.finish(trace, 2200));
  assert.match(view.doc.querySelector(".dgc-trace-dialog")?.textContent || "", /812 tk/);
  assert.match(view.doc.querySelector(".dgc-trace-dialog")?.textContent || "", /205 tk/);
  assert.deepEqual(view.errors, []);
});

test("old history without measured timestamps does not invent a trace", () => {
  const view = makeDom();
  const old = events.map(({ trace_at_ms, trace_tokens, ...event }) => event);
  view.send({ type: "event", event: { type: "history", items: old } });
  assert.equal(view.doc.querySelector(".ract-trace"), null);
  assert.deepEqual(view.errors, []);
});

test("partly timed history does not invent a tool duration", () => {
  const view = makeDom();
  const partial = events.map((event) => event.call_id === "c1" && event.type === "tool_result"
    ? { ...event, trace_at_ms: undefined } : event);
  view.send({ type: "event", event: { type: "history", items: saved(partial) } });
  assert.equal(view.doc.querySelector(".ract-trace"), null);
  assert.deepEqual(view.errors, []);
});

test("an interrupted tool with no result does not borrow the turn end", () => {
  const view = makeDom();
  const interrupted = events.filter((event) => event.type !== "tool_result");
  view.send({ type: "event", event: { type: "history", items: saved(interrupted) } });
  assert.equal(view.doc.querySelector(".ract-trace"), null);
  assert.deepEqual(view.errors, []);
});

test("a model span without its own end is not filled to the turn boundary", () => {
  const view = makeDom();
  const trace = view.dom.window.DgcTrace.create(1000, "incomplete", "model", false);
  assert.equal(view.dom.window.DgcTrace.finish(trace, 2000), null);
});

test("a timed denial closes its own span without claiming a failure", () => {
  const view = makeDom();
  const denied = events.map((event) => event.type === "tool_result"
    ? { type: "tool_denied", call_id: "c1", name: "run_shell", args: {},
      reason: "Not allowed", trace_at_ms: 1800 } : event);
  view.send({ type: "event", event: { type: "history", items: saved(denied) } });
  view.doc.querySelector(".ract-trace")?.click();
  const tool = view.doc.querySelector(".dgc-trace-row.tool");
  assert.ok(tool);
  assert.match(tool.textContent, /Denied/);
  assert.equal(tool.classList.contains("error"), false);
  assert.deepEqual(view.errors, []);
});

test("Trace failures use DGC's tool-failure olive token", () => {
  assert.match(mainCss, /\.dgc-trace-row\.error \.dgc-trace-bar \{ background: var\(--err, #768A00\)/);
});

test("parallel tools keep overlapping measured spans and the failed step", () => {
  const view = makeDom();
  const trace = view.dom.window.DgcTrace.create(1000, "parallel", "model", false);
  view.dom.window.DgcTrace.toolStart(trace, { call_id: "a", name: "bash", summary: "test a", trace_at_ms: 1500 });
  view.dom.window.DgcTrace.toolStart(trace, { call_id: "b", name: "bash", summary: "test b", trace_at_ms: 1500 });
  view.dom.window.DgcTrace.toolEnd(trace, { call_id: "b", output: "failed", is_error: true, trace_at_ms: 2100 });
  view.dom.window.DgcTrace.toolEnd(trace, { call_id: "a", output: "passed", is_error: false, trace_at_ms: 2500 });
  view.dom.window.DgcTrace.modelEnd(trace, { trace_at_ms: 3000, trace_tokens: 210 });
  assert.ok(view.dom.window.DgcTrace.finish(trace, 3000));
  assert.equal(trace.rows[1].start, trace.rows[2].start);
  assert.equal(trace.rows[2].error, true);
  assert.equal(trace.rows[1].end, 2500);
  assert.equal(trace.rows[3].start, 2500);
});

test("saved task batch display cards do not fabricate child durations", () => {
  const view = makeDom();
  const batch = [
    { type: "turn_start", turn_id: "h1", prompt: "Use two helpers", kind: "prompt", trace_at_ms: 1000 },
    { type: "tool_call", call_id: "batch", name: "task", args: { tasks: [] }, summary: "Two helpers", trace_at_ms: 1500 },
    { type: "tool_call", call_id: "batch#1", name: "task", args: {}, summary: "First" },
    { type: "tool_call", call_id: "batch#2", name: "task", args: {}, summary: "Second" },
    { type: "tool_result", call_id: "batch#1", name: "task", output: "Done", is_error: false, is_diff: false },
    { type: "tool_result", call_id: "batch#2", name: "task", output: "Done", is_error: false, is_diff: false },
    { type: "tool_result", call_id: "batch", name: "task", output: "Both done", is_error: false, is_diff: false, trace_at_ms: 2400 },
    { type: "text_delta", text: "Both helpers finished." },
    { type: "stream_end", message_id: "h1:1", phase: "answer", trace_at_ms: 3000 },
    { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1", trace_at_ms: 3000 },
  ];
  view.send({ type: "event", event: { type: "history", items: saved(batch) } });
  view.doc.querySelector(".ract-trace")?.click();
  const rows = [...view.doc.querySelectorAll(".dgc-trace-row")];
  assert.equal(rows.length, 3, "model, measured parent task, model");
  assert.deepEqual(view.errors, []);
});
