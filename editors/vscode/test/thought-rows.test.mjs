// One thought is one row. On a machine running seven background explorers, the main model's long
// thought streamed as twenty "Thought · raw" rows: every hidden explorer step closed the open
// thought, and the next chunk of the same thought opened a new row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
const READY = { type: "ready", capabilities: { agents: true, history_snapshot: true }, model: "m", mode: "auto", think: "off",
  base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 };
const explorers = []; for (let n = 1; n <= 7; n++) explorers.push(
  { type: "tool_call", call_id: `call_${n}`, name: "task", args: { description: "Explorer " + n, prompt: "map", background: true }, summary: "" },
  { type: "agent_started", id: sid(n), parent_id: null, call_id: `call_${n}`, description: "Explorer " + n, depth: 1, state: "running", started_at: n, isolated: true, parallel: true, background: true },
  { type: "tool_result", call_id: `call_${n}`, name: "task", output: "started in the background", is_error: false, is_diff: false });
function replay(frames) {
  const v = makeDom({ clock: true }); const ev = (d) => v.send({ type: "event", event: d });
  ev(READY); ev({ type: "turn_start", turn_id: "t1", prompt: "fix it", kind: "prompt" });
  for (const f of frames) ev(f);
  v.advance(5000);
  const rows = [...v.doc.querySelectorAll("button.disclosure")].filter((b) => !b.classList.contains("agent-owned"));
  return { v, rows, bodies: [...v.doc.querySelectorAll(".reasoning")].filter((b) => !b.classList.contains("agent-owned")) };
}

test("a long thought stays one row while background explorers take hidden steps", () => {
  const frames = [...explorers];
  for (let i = 0; i < 20; i++) { const n = 1 + i % 7;
    frames.push({ type: "thinking_delta", block: "t1:long", source: "raw", text: `part ${i}. ` },
      { type: "tool_call", call_id: `${sid(n)}:g${i}`, name: "grep", args: { pattern: "x" }, summary: "x" },
      { type: "tool_result", call_id: `${sid(n)}:g${i}`, name: "grep", output: "a.py:1", is_error: false, is_diff: false }); }
  frames.push({ type: "thinking_end", block: "t1:long", source: "raw", placement: "collapsed", seconds: 40 });
  const { v, rows, bodies } = replay(frames);
  assert.equal(rows.length, 1, `one row, not ${rows.length}`);
  assert.match(rows[0].textContent, /Thought for 40s/);
  assert.match(bodies[0].textContent, /part 0\. part 1\.[\s\S]*part 19\./, "every part, in order, in that one row");
  v.dom.window.close();
});

test("an explorer's own thoughts in between do not split the main thought either", () => {
  const frames = [...explorers];
  for (let i = 0; i < 6; i++) { const n = 1 + i % 7;
    frames.push({ type: "thinking_delta", block: "t1:long", source: "raw", text: `main ${i}. ` },
      { type: "thinking_delta", block: `${sid(n)}:th${i}`, source: "raw", agent: sid(n), text: "explorer thinking" },
      { type: "thinking_end", block: `${sid(n)}:th${i}`, source: "raw", agent: sid(n), placement: "collapsed", seconds: 1 }); }
  frames.push({ type: "thinking_end", block: "t1:long", source: "raw", placement: "collapsed", seconds: 12 });
  const { v, rows, bodies } = replay(frames);
  assert.equal(rows.length, 1, `one row, not ${rows.length}`);
  assert.match(bodies[0].textContent, /main 0\.[\s\S]*main 5\./);
  assert.doesNotMatch(bodies[0].textContent, /explorer thinking/, "the explorer's thought stays on its own line");
  v.dom.window.close();
});

test("the main model's own step still ends its thought: the next thought is a new row", () => {
  const frames = [{ type: "thinking_delta", block: "t1:a", source: "raw", text: "first" },
    { type: "thinking_end", block: "t1:a", source: "raw", placement: "collapsed", seconds: 2 },
    { type: "tool_call", call_id: "call_r", name: "read_file", args: { path: "a.py" }, summary: "a.py" },
    { type: "tool_result", call_id: "call_r", name: "read_file", output: "x", is_error: false, is_diff: false },
    { type: "thinking_delta", block: "t1:b", source: "raw", text: "second" },
    { type: "thinking_end", block: "t1:b", source: "raw", placement: "collapsed", seconds: 3 }];
  const { v, rows } = replay(frames);
  assert.equal(rows.length, 2);
  v.dom.window.close();
});
