// Tool groups start folded, including failures; only the reader changes expansion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

function panel() {
  const h = makeDom();
  const event = (d) => h.send({ type: "event", event: d });
  event({ type: "ready", capabilities: {} });
  event({ type: "turn_start", turn_id: "t", prompt: "do some work" });
  return { h, event, groups: () => [...h.doc.querySelectorAll(".tool-group")] };
}

const ran = (event, id, name = "bash", status = "ok") => {
  event({ type: "tool_call", call_id: id, name, args: { command: "ls" } });
  event({ type: "tool_result", call_id: id, name, output: "out",
          is_error: status === "failed" });
};

test("a group stays collapsed while its tools are still running", () => {
  const { event, groups } = panel();
  event({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "sleep 5" } });
  assert.equal(groups()[0].open, false, "running summary is visible without expanding output");
});

test("a finished group folds when the model moves on to prose", () => {
  const { event, groups } = panel();
  ran(event, "c1");
  assert.equal(groups()[0].open, false, "live group stays compact");
  event({ type: "text_delta", text: "Here is what I found." });
  assert.equal(groups()[0].open, false, "the model moved on, so the run folds to its summary");
});

test("the folded line still says what happened", () => {
  const { event, groups } = panel();
  ran(event, "c1");
  event({ type: "text_delta", text: "done" });
  const label = groups()[0].querySelector(".tool-group-label").textContent;
  assert.match(label, /\w/, "a folded group is only useful if its header names the work");
  assert.doesNotMatch(label, /^Working$/, "and not the placeholder it starts with");
});

test("a turn that ends on a tool call folds its last group too", () => {
  const { event, groups } = panel();
  ran(event, "c1");
  event({ type: "turn_end", turn_id: "t", reason: "completed" });
  assert.equal(groups()[0].open, false,
    "otherwise the final group reads differently from every group above it");
});

test("a failure stays collapsed with an issue in the summary", () => {
  const { event, groups } = panel();
  ran(event, "c1", "bash", "failed");
  event({ type: "text_delta", text: "that did not work" });
  assert.equal(groups()[0].open, false, "issue counts are on the summary");
});

test("a denied tool stays collapsed with its state visible", () => {
  const { event, groups } = panel();
  event({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "rm -rf dist" } });
  event({ type: "tool_denied", call_id: "c1", name: "bash", reason: "denied" });
  event({ type: "text_delta", text: "I will leave that alone." });
  assert.equal(groups()[0].open, false);
});

test("one group folding does not fold the next one's live work", () => {
  const { event, groups } = panel();
  ran(event, "c1");
  event({ type: "text_delta", text: "first" });
  event({ type: "tool_call", call_id: "c2", name: "bash", args: { command: "sleep 5" } });
  const all = groups();
  assert.equal(all.length, 2, "prose between runs starts a new group");
  assert.equal(all[0].open, false, "the finished one is folded");
  assert.equal(all[1].open, false, "the next running group is also compact");
});

test("the reader can still open a folded group by hand", () => {
  const { event, groups } = panel();
  ran(event, "c1");
  event({ type: "text_delta", text: "done" });
  const group = groups()[0];
  assert.equal(group.open, false);
  group.open = true;                       // what a click does
  event({ type: "turn_end", turn_id: "t", reason: "completed" });
  assert.equal(group.open, true, "a turn ending must not re-fold what the reader opened");
});

// A reload replays the turn into a detached fragment, and the fold used to be skipped for a group
// that was not in the document -- so a reopened chat showed every group open, the wall of cards the
// live turn had folded away. A failed step's group stays open there too.
test("a reloaded turn folds its finished groups the way the live one did", () => {
  const h = makeDom();
  const event = (d) => h.send({ type: "event", event: d });
  event({ type: "ready", capabilities: {} });
  event({ type: "history", complete: true, items: [
    { type: "turn_start", turn_id: "h1", prompt: "do some work", kind: "prompt" },
    { type: "tool_call", call_id: "c1", name: "bash", args: { command: "ls" } },
    { type: "tool_result", call_id: "c1", name: "bash", output: "out", is_error: false },
    { type: "text_delta", text: "Then the failing one." },
    { type: "stream_end", message_id: "h1:1", phase: "commentary" },
    { type: "tool_call", call_id: "c2", name: "bash", args: { command: "false" } },
    { type: "tool_result", call_id: "c2", name: "bash", output: "exit code: 1", is_error: true },
    { type: "text_delta", text: "It failed." },
    { type: "stream_end", message_id: "h1:2", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:2" },
  ] });
  const groups = [...h.doc.querySelectorAll(".tool-group")];
  assert.equal(groups.length, 2);
  assert.equal(groups[0].open, false, "a finished run folds on a reload too");
  assert.equal(groups[1].open, false, "failed history remains compact");
  assert.deepEqual(h.errors, []);
});

test("a reader-opened running group stays open across progress, errors and completion",()=>{
 const {event,groups}=panel();event({type:'tool_call',call_id:'c1',name:'bash',args:{command:'check'}});
 const group=groups()[0];group.open=true;
 event({type:'tool_result',call_id:'c1',name:'bash',output:'failed',is_error:true});
 event({type:'text_delta',text:'I will inspect the failure.'});event({type:'turn_end',reason:'completed'});
 assert.equal(group.open,true);assert.match(group.querySelector('summary').textContent,/issue/);
});
