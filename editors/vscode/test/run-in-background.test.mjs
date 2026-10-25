// Run in background (ready.capabilities.background_now): the person moves what the turn is waiting on
// -- a foreground agent of the main agent, or a running `bash` command -- to the background. On the
// agent's line in the chat (one agent: one button; several: the same words ask which, with All), on
// its card in the agent map, and on the command's row. An older CLI never shows any of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
const LIVE = { agents: true, agent_control: true, agent_control_foreground: true, background_now: { version: 1 } };

function panel(capabilities = LIVE) {
  const v = makeDom({ clock: true });
  const event = (data) => v.send({ type: "event", event: data });
  event({ type: "ready", capabilities, model: "m", mode: "auto", think: "off", base_url: "http://127.0.0.1:1/v1",
    workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 });
  v.send({ type: "session_ready", sessionId: "s1" });
  const $ = (id) => v.doc.getElementById(id);
  const posts = (type) => v.posted.filter((m) => m.type === type).map((m) => JSON.parse(JSON.stringify(m)));
  const click = (node) => node.dispatchEvent(new node.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
  const spawn = (n, description) => event({ type: "tool_call", call_id: `call_${n}`, name: "task", args: { description }, summary: "" });
  const start = (n, description, extra = {}) => event({ type: "agent_started", id: sid(n), parent_id: null, call_id: `call_${n}`,
    description, depth: 1, state: "running", started_at: n, isolated: true, parallel: false, ...extra });
  const moveButtons = () => [...v.doc.querySelectorAll("#log .agent-line .agent-line-move button")];
  return { ...v, event, $, posts, click, spawn, start, moveButtons };
}

test("a foreground agent the turn waits on gets Run in background on its line; it moves that agent", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.spawn(1, "Map the auth module");
  p.start(1, "Map the auth module");
  const [button] = p.moveButtons();
  assert.ok(button, "the line offers it");
  assert.equal(button.textContent, "Run in background");
  assert.equal(button.getAttribute("aria-label"), "Run Map the auth module in the background");
  assert.equal(button.type, "button", "a real, keyboard-reachable button");
  p.click(button);
  assert.deepEqual(p.posts("backgroundNow"), [{ type: "backgroundNow", agentId: sid(1) }]);
  assert.deepEqual(p.moveButtons(), [], "gone while the CLI moves it, never pressed twice");
  // The CLI's answer, then its snapshot: a background agent now, still working, and no button.
  p.event({ type: "moved_to_background", request_id: "r1", kind: "agent", agent_id: sid(1), call_id: "call_1" });
  p.event({ type: "agents", total: 1, active: 1, items: [{ id: sid(1), parent_id: null, call_id: "call_1",
    description: "Map the auth module", depth: 1, state: "running", tool_calls: 1, isolated: true, parallel: false,
    restored: false, background: true }] });
  assert.deepEqual(p.moveButtons(), []);
  assert.match(p.doc.querySelector("#log .agent-line .agent-line-text").textContent, /Map the auth module/);
  assert.deepEqual(p.errors, []);
});

test("an older CLI (no background_now) shows no Run in background anywhere; this one shows it on all three", () => {
  const offered = (capabilities) => {
    const p = panel(capabilities);
    p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
    p.spawn(1, "Map the auth module");
    p.start(1, "Map the auth module");
    p.event({ type: "tool_call", call_id: "b1", name: "bash", args: { command: "sleep 30" }, summary: "sleep 30" });
    p.advance(3000);
    const where = [];
    if (p.doc.querySelector(".agent-line-move button")) where.push("line");
    if (p.doc.querySelector("button.run-bg:not([hidden])")) where.push("command");
    p.$("agents-pill").click();
    p.doc.querySelector(`#agent-map .am-row[data-am-key="agent:${sid(1)}"]`).click();
    if ([...p.$("agent-card-body").querySelectorAll("button")].some((b) => !b.hidden && b.textContent === "Run in background")) {
      where.push("card");
    }
    assert.deepEqual(p.posts("backgroundNow"), []);
    assert.deepEqual(p.errors, []);
    return where;
  };
  assert.deepEqual(offered({ agents: true, agent_control: true, agent_control_foreground: true }), []);
  assert.deepEqual(offered(LIVE), ["line", "command", "card"]);
});

test("not for a background agent, a nested one, or once the turn is over", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.spawn(1, "Already in the background");
  p.start(1, "Already in the background", { background: true });
  assert.deepEqual(p.moveButtons(), [], "a background agent is not waited on");
  p.spawn(2, "Waited on");
  p.start(2, "Waited on");
  p.event({ type: "agent_started", id: sid(3), parent_id: sid(2), call_id: `${sid(2)}:call_0`, description: "nested",
    depth: 2, state: "running", started_at: 3, isolated: true, parallel: false });
  assert.equal(p.moveButtons().length, 1);
  p.event({ type: "agent_ended", id: sid(2), state: "finished", duration_ms: 10, tool_calls: 1 });
  assert.deepEqual(p.moveButtons(), [], "an agent that ended has nothing to move");
  assert.deepEqual(p.errors, []);
});

test("a batch line with several waiting asks which: each name, All, or Cancel (Escape too)", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "split" });
  ["Parser", "Docs"].forEach((name, i) => p.spawn(i + 1, name));
  ["Parser", "Docs"].forEach((name, i) => p.start(i + 1, name, { parallel: true }));
  p.advance(2500);
  let buttons = p.moveButtons();
  assert.deepEqual(buttons.map((b) => b.textContent), ["Run in background"], "one control on the line");
  assert.equal(buttons[0].getAttribute("aria-label"), "Run in background: choose which of 2 agents");
  p.click(buttons[0]);
  buttons = p.moveButtons();
  assert.deepEqual(buttons.map((b) => b.textContent), ["Parser", "Docs", "All", "Cancel"]);
  assert.equal(p.doc.activeElement, buttons[0], "focus goes to the first choice");
  assert.equal(p.doc.querySelector(".agent-line-move-ask").textContent, "Run in background:");
  // Escape steps back without moving anything.
  buttons[0].dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.deepEqual(p.moveButtons().map((b) => b.textContent), ["Run in background"]);
  assert.deepEqual(p.posts("backgroundNow"), []);
  // One of them: only that one moves, and the line then offers the other alone.
  p.click(p.moveButtons()[0]);
  p.click(p.moveButtons().find((b) => b.textContent === "Docs"));
  assert.deepEqual(p.posts("backgroundNow"), [{ type: "backgroundNow", agentId: sid(2) }]);
  assert.deepEqual(p.moveButtons().map((b) => b.getAttribute("aria-label")), ["Run Parser in the background"]);
  assert.deepEqual(p.errors, []);
});

test("All moves every agent of the line the turn waits on", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "split" });
  ["A", "B", "C"].forEach((name, i) => p.spawn(i + 1, name));
  ["A", "B", "C"].forEach((name, i) => p.start(i + 1, name, { parallel: true }));
  p.click(p.moveButtons()[0]);
  p.click(p.moveButtons().find((b) => b.textContent === "All"));
  assert.deepEqual(p.posts("backgroundNow").map((m) => m.agentId), [sid(1), sid(2), sid(3)]);
  assert.deepEqual(p.moveButtons(), []);
  assert.deepEqual(p.errors, []);
});

test("the agent's card in the map has Run in background while the turn waits on it", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.spawn(1, "Map the auth module");
  p.start(1, "Map the auth module");
  p.$("agents-pill").click();
  p.doc.querySelector(`#agent-map .am-row[data-am-key="agent:${sid(1)}"]`).click();
  const card = p.$("agent-card-body");
  const move = [...card.querySelectorAll("button")].find((b) => b.textContent === "Run in background");
  assert.ok(move && !move.hidden, "offered on the card");
  p.click(move);
  assert.deepEqual(p.posts("backgroundNow"), [{ type: "backgroundNow", agentId: sid(1) }]);
  assert.equal(move.textContent, "Moving…");
  assert.equal(move.disabled, true);
  p.event({ type: "moved_to_background", request_id: "r1", kind: "agent", agent_id: sid(1), call_id: "call_1" });
  assert.equal(move.hidden, true, "a background agent now: nothing left to move");
  assert.match(p.$("agent-card").textContent, /background/);
  assert.deepEqual(p.errors, []);
});

test("a move the CLI refused gives the button back, quietly when it had just finished", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.spawn(1, "Map the auth module");
  p.start(1, "Map the auth module");
  p.click(p.moveButtons()[0]);
  assert.deepEqual(p.moveButtons(), []);
  p.send({ type: "background_now_state", agentId: sid(1), callId: "", state: "error",
    error: "the turn is no longer waiting on that: it has already finished" });
  assert.equal(p.moveButtons().length, 1);
  assert.equal([...p.doc.querySelectorAll("#log .sys")].filter((n) => /finished/.test(n.textContent)).length, 0);
  assert.deepEqual(p.errors, []);
});

test("a running command's row offers Run in background once it has run a moment; its result reads moved", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "build" });
  p.event({ type: "tool_call", call_id: "b1", name: "bash", args: { command: "sleep 30 && echo done" }, summary: "sleep 30 && echo done" });
  const card = p.doc.querySelector('.tool[data-call-id="b1"]');
  const button = card.querySelector("button.run-bg");
  assert.ok(button, "the row has it");
  assert.equal(button.hidden, true, "not for the first moment: a quick command never flashes it");
  p.advance(1600);
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, "Run in background");
  assert.equal(button.getAttribute("aria-label"), "Run this command in the background");
  p.click(button);
  assert.deepEqual(p.posts("backgroundNow"), [{ type: "backgroundNow", callId: "b1" }]);
  assert.equal(button.textContent, "Moving…");
  assert.equal(card.classList.contains("open"), false, "the click does not open the row");
  p.event({ type: "moved_to_background", request_id: "r1", kind: "command", call_id: "b1" });
  p.event({ type: "tool_result", call_id: "b1", name: "bash", is_error: false, is_diff: false,
    output: "The person moved `sleep 30 && echo done` to the background (bg3); its exit will wake this chat. Carry on without it: don't wait for it, and don't start it again." });
  assert.equal(card.dataset.status, "moved");
  assert.equal(card.querySelector(".verb").textContent, "Moved to the background");
  assert.equal(card.querySelector("button.run-bg"), null, "gone once the row has its result");
  assert.deepEqual(p.errors, []);
});

test("only on the main agent's foreground command still running: not a background one, a sub-agent's, or a finished one", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "build" });
  p.event({ type: "tool_call", call_id: "b1", name: "bash", args: { command: "npm run dev", background: true }, summary: "npm run dev" });
  p.event({ type: "tool_call", call_id: `${sid(1)}:c1`, name: "bash", args: { command: "make" }, summary: "make" });
  p.event({ type: "tool_call", call_id: "b2", name: "bash", args: { command: "echo hi" }, summary: "echo hi" });
  p.event({ type: "tool_result", call_id: "b2", name: "bash", is_error: false, is_diff: false, output: "exit code: 0\nhi" });
  p.event({ type: "tool_call", call_id: "b3", name: "bash", args: { command: "npm test" }, summary: "npm test" });
  p.advance(3000);
  assert.deepEqual([...p.doc.querySelectorAll("button.run-bg:not([hidden])")].map((b) => b.closest(".tool").dataset.callId), ["b3"]);
  assert.deepEqual(p.errors, []);
});
