// A parallel sub-agent's own page shows its work WHILE it works.
//
// Reported from the founder's 192.168.1.111 box: a delegated agent ran for 27 minutes and its page
// showed nothing but a running timer. Not a rendering bug — a parallel child buffers its whole
// trace (`_SubUI(buffered=True)`) so the PARENT transcript can replay each child atomically
// instead of interleaving four of them. Right for the parent, wrong for the child's own page,
// which shows one agent and cannot interleave with anything.
//
// So the buffering stays and a live per-agent step rides alongside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

function delegated() {
  const h = makeDom();
  const event = (d) => h.send({ type: "event", event: d });
  event({ type: "ready", capabilities: { agent_steps: true } });
  event({ type: "turn_start", turn_id: "t", prompt: "delegate" });
  event({ type: "tool_call", call_id: "c1", name: "task", args: { description: "responsive flows" } });
  event({ type: "agent_started", id: "sub-1", call_id: "c1", description: "responsive flows", state: "running" });
  return { h, event };
}
const openPage = (h) => h.doc.querySelector(".agent-chip")?.click();
const pageText = (h) => h.doc.getElementById("agent-log")?.textContent || "";
// Repaints are coalesced to one per frame — rebuilding the whole page per step is quadratic and
// ran the panel out of memory at 600 steps. So a test must let that frame pass.
const painted = () => new Promise((r) => setTimeout(r, 120));
// What the page actually renders per step is a tool card carrying the call id — the path lives in
// the card's summary, which the backend fills in and a bare step does not.
const cardIds = (h) => [...h.doc.querySelectorAll("#agent-log .tool")].map((n) => n.dataset.callId);

test("a step arriving mid-run reaches the agent's page", async () => {
  const { h, event } = delegated();
  openPage(h);
  assert.deepEqual(cardIds(h), [], "nothing yet, correctly");
  event({ type: "agent_step", agent_id: "sub-1", seq_in_agent: 1,
          step: { type: "tool_call", name: "read_file", call_id: "sub-1:a", args: { path: "src/clamp.py" } } });
  await painted();
  assert.deepEqual(cardIds(h), ["sub-1:a"],
    "the page must show the step while the child is still working");
  const card = h.doc.querySelector("#agent-log .tool");
  assert.equal(card.dataset.toolName, "read_file", "and say which tool it was");
  assert.match(pageText(h), /Reading/, "in the reader's words, not the tool's");
});

test("steps accumulate in order", async () => {
  const { h, event } = delegated();
  openPage(h);
  for (const [i, path] of ["a.py", "b.py", "c.py"].entries()) {
    event({ type: "agent_step", agent_id: "sub-1", seq_in_agent: i + 1,
            step: { type: "tool_call", name: "read_file", call_id: `sub-1:${i}`, args: { path } } });
  }
  await painted();
  assert.deepEqual(cardIds(h), ["sub-1:0", "sub-1:1", "sub-1:2"],
    "the page shows the child's steps in the order it took them");
});

test("the PARENT transcript still shows nothing until replay", () => {
  // The whole reason buffering exists. A live step must not leak into the main log, or four
  // parallel children interleave there and it becomes unreadable.
  const { h, event } = delegated();
  event({ type: "agent_step", agent_id: "sub-1", seq_in_agent: 1,
          step: { type: "tool_call", name: "read_file", call_id: "sub-1:a", args: { path: "secret.py" } } });
  const main = h.doc.getElementById("log")?.textContent || "";
  assert.equal(main.includes("secret.py"), false,
    "a child's live step belongs to its own page, never to the parent transcript");
});

test("a step for an agent this panel never saw is ignored", () => {
  const { h, event } = delegated();
  const before = pageText(h);
  event({ type: "agent_step", agent_id: "ghost", seq_in_agent: 1,
          step: { type: "tool_call", name: "read_file", args: { path: "x.py" } } });
  assert.equal(pageText(h), before, "an unknown agent id must not create a page or throw");
  assert.deepEqual(h.errors, []);
});

test("a malformed step never breaks the panel", () => {
  const { h, event } = delegated();
  openPage(h);
  for (const bad of [null, "nope", 42, []]) {
    event({ type: "agent_step", agent_id: "sub-1", seq_in_agent: 1, step: bad });
  }
  assert.deepEqual(h.errors, [], "a bad step is dropped, not thrown");
});

test("one runaway child cannot grow the page without bound", async () => {
  const { h, event } = delegated();
  openPage(h);
  for (let i = 0; i < 600; i++) {
    event({ type: "agent_step", agent_id: "sub-1", seq_in_agent: i,
            step: { type: "tool_call", name: "read_file", call_id: `sub-1:${i}`, args: { path: `f${i}.py` } } });
  }
  await painted();
  const cards = h.doc.querySelectorAll("#agent-log .tool").length;
  assert.ok(cards > 0 && cards <= 400, `a page is not an archive; got ${cards} cards`);
});
