// The agent map in the webview: the composer's agents pill and /agents open it; every agent of the
// chat in a tree from parent_id, sorted working -> failed -> ended; three windows stacked over the
// chat (the map, a card, an agent's transcript or a task's output), each going back one level at a
// time; Stop per agent and per task kind, as the backend's capabilities allow; what runs in the
// background; live output; keyboard and focus. Real geometry (the two layouts, the connectors, text
// that is never crushed, the windows' sizes) is agent-map-layout.test.mjs's, in Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, panelSrc } from "./support/webview-dom.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
const READY = { type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 };

function view(options = {}, capabilities = { agents: true, agent_control: true }) {
  const v = makeDom(options);
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  event({ ...READY, capabilities });
  v.send({ type: "state", state: { model: "qwen3.8:27b", mode: "default", think: "off" } });
  v.send({ type: "session_ready", sessionId: "s1" });
  let n = 0;
  const start = (id, fields = {}) => event({ type: "agent_started", id, parent_id: null, call_id: `call_${n++}`,
    description: `agent ${id.slice(-2)}`, depth: 1, state: "running", started_at: 1000 + n, isolated: false, parallel: false, ...fields });
  const update = (id, fields) => event({ type: "agent_updated", id, state: "running", ...fields });
  const end = (id, state = "finished", fields = {}) => event({ type: "agent_ended", id, state, duration_ms: 1200, tool_calls: 2, ...fields });
  const open = () => $("agents-pill").click();
  const isOpen = () => !$("agent-map").hidden;
  const rows = () => [...v.doc.querySelectorAll("#agent-map-tree .am-row")];
  const keys = () => rows().map((row) => row.dataset.amKey);
  const row = (key) => v.doc.querySelector(`#agent-map .am-row[data-am-key="${key}"]`);
  const tasks = () => [...v.doc.querySelectorAll("#agent-map-task-list .am-row")].map((r) => [r.dataset.amKey, r.textContent]);
  const card = () => $("agent-card-body");
  const visible = () => ["agent-map", "agent-card", "agent-transcript"].filter((id) => !$(id).hidden);
  const button = (host, label) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  const key = (target, name, extra = {}) => {
    const e = new v.dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(e);
    return e;
  };
  const posts = (type) => v.posted.filter((m) => m.type === type).map((m) => JSON.parse(JSON.stringify(m)));
  // The pill's words where the footer has room (not the narrow footer's total, not "· needs you").
  const pill = () => ({ hidden: $("agents-picker").hidden, state: $("agents-pill").dataset.state,
    label: [...$("agents-pill").querySelector(".agents-label").children]
      .filter((node) => !node.matches(".agents-short, .agents-need")).map((node) => node.textContent).join("") });
  return { ...v, event, $, start, update, end, open, isOpen, rows, keys, row, tasks, card, visible, button, key, posts, pill };
}

test("the pill opens the map itself: no dropdown is left, and the dialog is labelled and modal", () => {
  const p = view();
  assert.equal(p.$("agentsmenu"), null, "the 340px dropdown is gone");
  p.start(sid(1), { description: "Review the auth module" });
  assert.equal(p.$("agents-pill").getAttribute("aria-controls"), "agent-map");
  assert.equal(p.$("agents-pill").getAttribute("aria-haspopup"), "dialog");
  assert.equal(p.$("agents-pill").getAttribute("aria-expanded"), "false");
  p.open();
  assert.equal(p.isOpen(), true);
  assert.equal(p.$("agents-pill").getAttribute("aria-expanded"), "true");
  const layer = p.$("agent-map");
  assert.equal(layer.getAttribute("role"), "dialog");
  assert.equal(layer.getAttribute("aria-modal"), "true");
  assert.equal(layer.getAttribute("aria-labelledby"), "agent-map-title");
  assert.equal(p.$("agent-map-title").textContent, "Agent map");
  assert.equal(p.$("agent-map-subtitle").textContent, "1 agent · click an agent for details");
  assert.equal(p.doc.activeElement, p.row(`agent:${sid(1)}`), "focus starts on the first agent");
  assert.ok(p.rows().every((r) => r.tagName === "BUTTON"), "every row is a real button");
  assert.deepEqual(p.errors, []);
});

test("/agents opens the map from the composer, typed or picked; focus goes back to the prompt box; /tasks still goes to the CLI", () => {
  const p = view();
  const input = p.$("input");
  input.focus();
  input.value = "/agents";
  p.key(input, "Enter");
  assert.equal(p.isOpen(), true, "typed and sent");
  assert.equal(input.value, "", "the command does not stay in the box");
  assert.deepEqual(p.posts("slashText"), [], "nothing goes to the CLI, whose /agents opened settings");
  assert.equal(p.$("agent-map-subtitle").textContent, "No agents in this chat yet");
  assert.deepEqual(p.keys(), ["root"], "a chat with no agent shows the main agent alone");
  p.key(p.doc.activeElement, "Escape");
  assert.equal(p.isOpen(), false);
  assert.equal(p.doc.activeElement, input, "a map opened by command gives focus to the prompt box");

  // The CLI lists /agents as its settings command: the popup offers the map under that name instead.
  p.event({ ...READY, capabilities: { agents: true }, commands: [
    { name: "agents", description: "sub-agent configuration", action: "subagent" },
    { name: "tasks", description: "list, show, apply, or drop retained sub-agent work", action: "tasks" }] });
  input.value = "/agen";
  input.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  assert.match(p.$("pop").textContent, /agents\s*command\s*open the agent map: every agent and background task in this chat/);
  assert.doesNotMatch(p.$("pop").textContent, /sub-agent configuration/);
  p.key(input, "Enter");
  assert.equal(p.isOpen(), true, "picked from the popup");
  assert.deepEqual(p.posts("slash"), [], "the settings action is not sent");
  p.$("agent-map-close").click();
  input.value = "/tasks";
  p.key(input, "Enter");
  assert.equal(p.isOpen(), false);
  assert.deepEqual(p.posts("slashText"), [{ type: "slashText", text: "/tasks" }], "/tasks keeps its meaning");
  assert.deepEqual(p.errors, []);
});

test("the pill counts the agents working now and stays for the whole chat; a new chat hides it", () => {
  const p = view();
  assert.equal(p.pill().hidden, true, "no agent, no pill");
  p.start(sid(1)); p.start(sid(2)); p.start(sid(3));
  p.end(sid(3), "failed", { message: "boom" });
  assert.deepEqual(p.pill(), { hidden: false, state: "running", label: "2 agents" }, "2 of 3 working");
  assert.equal(p.$("agents-pill").title, "Agents are working · Click to open the agent map");
  p.update(sid(2), { state: "waiting", waiting_for: "permission" });
  assert.equal(p.pill().state, "waiting");
  assert.equal(p.$("agents-pill").getAttribute("aria-label"), "2 agents · An agent is waiting for your permission · Click to open the agent map");
  p.update(sid(2), { state: "running" });
  p.end(sid(1)); p.end(sid(2));
  p.event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
  assert.deepEqual(p.pill(), { hidden: false, state: "idle", label: "0 agents" }, "after the turn: 0 agents, still there");
  p.open();
  assert.equal(p.$("agent-map-subtitle").textContent, "3 agents · click an agent for details", "the map counts every agent");
  p.$("agent-map-close").click();
  p.event({ type: "session", kind: "new", message_count: 0, session_id: "s2" });
  assert.equal(p.pill().hidden, true);
  // A reloaded chat whose agents all ended: the backend's snapshot brings the pill back at 0.
  p.event({ type: "agents", items: [{ id: sid(7), parent_id: null, call_id: "c", description: "old", depth: 1, state: "finished",
    tool_calls: 1, isolated: false, parallel: false, restored: true }], total: 1, active: 0 });
  assert.deepEqual(p.pill(), { hidden: false, state: "idle", label: "0 agents" });
  assert.deepEqual(p.errors, []);
});

test("the tree: three levels deep from parent_id, an orphan and a loop under the root, a count past the snapshot's items", () => {
  const p = view();
  p.start(sid(1), { description: "A" });
  p.start(sid(2), { description: "B", parent_id: sid(1), depth: 2 });
  p.start(sid(3), { description: "C", parent_id: sid(2), depth: 3 });
  p.start(sid(4), { description: "orphan", parent_id: sid(99), depth: 2 });
  p.open();
  const item = (id) => p.row(`agent:${id}`).closest("li");
  assert.equal(item(sid(1)).parentElement, p.doc.querySelector(".am-root-node > .am-children"), "A under the root");
  assert.equal(item(sid(2)).parentElement.parentElement, item(sid(1)), "B in A's list");
  assert.equal(item(sid(3)).parentElement.parentElement, item(sid(2)), "C in B's list");
  assert.equal(item(sid(2)).parentElement.getAttribute("aria-label"), "Started by A");
  assert.equal(item(sid(4)).parentElement, p.doc.querySelector(".am-root-node > .am-children"), "a parent the map lacks: under the root");
  p.$("agent-map-close").click();

  // Two records naming each other: neither may become its own ancestor.
  const loop = (n, parent) => ({ id: sid(n), parent_id: sid(parent), call_id: `l${n}`, description: `loop ${n}`, depth: 2,
    state: "running", tool_calls: 0, isolated: false, parallel: false, restored: false, elapsed_ms: 0 });
  p.event({ type: "agents", items: [loop(5, 6), loop(6, 5)], total: 70, active: 5 });
  p.open();
  const top = [...p.doc.querySelectorAll(".am-root-node > .am-children > li > .am-self > .am-row")].map((r) => r.dataset.amKey);
  assert.deepEqual(top.sort(), [`agent:${sid(5)}`, `agent:${sid(6)}`]);
  assert.equal(p.$("agent-map-subtitle").textContent, "70 agents · click an agent for details", "every agent of the chat");
  assert.equal(p.$("agent-map-more").hidden, false);
  assert.equal(p.$("agent-map-more").textContent, "68 more agents not listed, 3 of them working.");
  assert.deepEqual(p.errors, []);
});

test("order in a column: working oldest first, then failed, then ended newest end first", () => {
  const p = view();
  const item = (n, state, extra = {}) => ({ id: sid(n), parent_id: null, call_id: `c${n}`, description: `a${n}`, depth: 1, state,
    tool_calls: 1, isolated: false, parallel: false, restored: false, ...extra });
  p.event({ type: "agents", total: 6, active: 2, items: [
    item(1, "finished", { started_at: 100, duration_ms: 1000 }),       // ended at 101 s
    item(2, "running", { started_at: 300, elapsed_ms: 5000 }),
    item(3, "failed", { started_at: 50, duration_ms: 2000 }),
    item(4, "stopped", { started_at: 60, duration_ms: 100000 }),       // ended at 160 s: after a1, though it began first
    item(5, "running", { started_at: 200, elapsed_ms: 9000 }),
    item(6, "waiting", { started_at: 250, elapsed_ms: 1000, waiting_for: "answer" }),
  ] });
  p.open();
  assert.deepEqual(p.keys().slice(1), [5, 6, 2, 3, 4, 1].map((n) => `agent:${sid(n)}`));
  const metas = p.rows().slice(1).map((r) => r.querySelector(".am-meta").textContent);
  assert.deepEqual(metas, ["9s", "Waiting for your answer · 1s", "5s", "Failed · 2s", "Stopped · 1m 40s", "Finished · 1s"]);
  assert.equal(p.rows()[1].querySelector(".agent-dot").dataset.state, "running");
  assert.equal(p.rows()[4].querySelector(".agent-dot").dataset.state, "failed");
  assert.deepEqual(p.errors, []);
});

test("rows tick in place once a second: the same nodes, the focus kept, durations under 1s and 0 tokens not said", () => {
  const p = view({ clock: true });
  p.advance(5);                     // the manual clock starts at 0, which reads as "no receipt time"
  p.start(sid(1), { description: "one" });
  p.start(sid(2), { description: "two" });
  p.open();
  const meta = (n) => p.row(`agent:${sid(n)}`).querySelector(".am-meta").textContent;
  assert.equal(meta(1), "Working", "0s and 0 tokens are not said");
  const before = p.rows();
  before[2].focus();
  let focusins = 0, removed = 0;
  p.doc.addEventListener("focusin", () => { focusins += 1; });
  new p.dom.window.MutationObserver((records) => {
    for (const r of records) removed += [...r.removedNodes].filter((node) => node.nodeType === 1).length;
  }).observe(p.$("agent-map-tree"), { childList: true, subtree: true });
  p.advance(1500);
  assert.equal(meta(1), "1s");
  p.update(sid(1), { tokens: 142600, tool_calls: 3 });
  p.advance(1000);
  assert.equal(meta(1), "2s · 142.6k tokens");
  p.update(sid(2), { tokens: 950 });
  p.advance(1000);
  assert.equal(meta(2), "3s · 950 tokens");
  assert.deepEqual(p.rows(), before, "the same row nodes");
  assert.equal(p.doc.activeElement, before[2], "focus never left");
  assert.equal(focusins, 0);
  assert.equal(removed, 0, "only text changed");
  // An agent that ends moves down its column; the focused row moves with it and keeps the focus.
  p.start(sid(3), { description: "three" });
  p.end(sid(2), "finished", { duration_ms: 3000, tokens: 1_250_000 });
  assert.deepEqual(p.keys().slice(1), [`agent:${sid(1)}`, `agent:${sid(3)}`, `agent:${sid(2)}`]);
  assert.equal(p.doc.activeElement, before[2], "the moved row still has the focus");
  assert.equal(meta(2), "Finished · 3s · 1.3M tokens");
  assert.deepEqual(p.rows().map((r) => r.tabIndex).filter((t) => t === 0).length, 1, "one tab stop in the tree");
  assert.deepEqual(p.errors, []);
});

test("arrow keys, Home and End move between rows; Tab stays in the dialog", () => {
  const p = view();
  p.start(sid(1)); p.start(sid(2)); p.start(sid(3));
  p.open();
  p.key(p.doc.activeElement, "ArrowDown");
  assert.equal(p.doc.activeElement.dataset.amKey, `agent:${sid(2)}`);
  p.key(p.doc.activeElement, "End");
  assert.equal(p.doc.activeElement.dataset.amKey, `agent:${sid(3)}`);
  p.key(p.doc.activeElement, "Home");
  assert.equal(p.doc.activeElement.dataset.amKey, "root");
  p.key(p.doc.activeElement, "ArrowUp");
  assert.equal(p.doc.activeElement.dataset.amKey, "root", "stays on the first row");
  // Tab from the last control wraps to the first, and Shift+Tab back.
  p.$("agent-map-settings").focus();
  const tab = p.key(p.doc.activeElement, "Tab");
  assert.equal(tab.defaultPrevented, true);
  assert.equal(p.doc.activeElement, p.$("agent-map-close"));
  p.key(p.doc.activeElement, "Tab", { shiftKey: true });
  assert.equal(p.doc.activeElement, p.$("agent-map-settings"));
  // Focus that wanders out while it is open is handed back.
  p.$("input").focus();
  assert.ok(p.$("agent-map").contains(p.doc.activeElement));
  assert.deepEqual(p.errors, []);
});

// An agent with a prompt, one step of its own (read_file, with its output) and, once it ends, a reply.
function agentWithWork(p, { end = true } = {}) {
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.event({ type: "tool_call", call_id: "call_a", name: "task", summary: "",
    args: { description: "Review the auth module", prompt: "Read src/auth/ and list every token leak." } });
  p.start(sid(1), { call_id: "call_a", description: "Review the auth module", started_at: Date.now() / 1000 - 30 });
  p.event({ type: "tool_call", call_id: `${sid(1)}:call_1`, name: "read_file", args: { path: "src/auth/session.ts" }, summary: "src/auth/session.ts" });
  p.event({ type: "tool_result", call_id: `${sid(1)}:call_1`, name: "read_file", output: "export const refresh = token;", is_error: false });
  if (end) p.end(sid(1), "finished", { duration_ms: 31000, tokens: 52000, message: "Found one leak: session.ts logs the refresh token." });
}

test("three windows stacked: the map, a card over it, the transcript over that; ← goes back one level, focus to what opened it", () => {
  const p = view();
  agentWithWork(p);
  const pill = p.$("agents-pill");
  pill.focus();
  p.open();
  assert.deepEqual(p.visible(), ["agent-map"]);
  const row = p.row(`agent:${sid(1)}`);
  row.click();
  assert.deepEqual(p.visible(), ["agent-map", "agent-card"], "the card is its own window over the map");
  assert.equal(p.$("agent-map").getAttribute("aria-hidden"), "true", "the map underneath is covered");
  assert.equal(p.$("agent-map").hasAttribute("inert"), true);
  assert.equal(p.$("agent-card").getAttribute("role"), "dialog");
  assert.equal(p.$("agent-card").getAttribute("aria-modal"), "true");
  assert.equal(p.$("agent-card").getAttribute("aria-labelledby"), "agent-card-title");
  assert.equal(p.doc.activeElement, p.$("agent-card-back"));
  assert.equal(p.$("agent-card-title").textContent, "Review the auth module");
  assert.equal(p.$("agent-card-meta").textContent, "Finished · qwen3.8:27b · foreground");
  assert.match(p.card().textContent, /^Spawned by the main agent31s · 52k tokens/);
  assert.match(p.card().textContent, /Found one leak: session\.ts logs the refresh token\./, "its result");
  const [prompt, calls] = p.card().querySelectorAll("details.am-fold");
  assert.deepEqual([prompt.querySelector("summary").textContent, prompt.open], ["Prompt", false], "the prompt folded once it ended");
  assert.equal(calls.querySelector("summary").textContent, "Tool calls (2)");
  const openTx = p.button(p.card(), "Open transcript");
  openTx.click();
  assert.deepEqual(p.visible(), ["agent-map", "agent-card", "agent-transcript"]);
  assert.equal(p.$("agent-card").hasAttribute("inert"), true, "the card underneath is covered");
  assert.equal(p.doc.activeElement, p.$("agent-transcript-back"));
  assert.equal(p.$("agent-transcript-back").getAttribute("aria-label"), "Back to the agent");
  p.$("agent-transcript-back").click();
  assert.deepEqual(p.visible(), ["agent-map", "agent-card"]);
  assert.equal(p.$("agent-card").hasAttribute("inert"), false);
  assert.equal(p.doc.activeElement, openTx, "back on Open transcript");
  p.$("agent-card-back").click();
  assert.deepEqual(p.visible(), ["agent-map"]);
  assert.equal(p.$("agent-map").hasAttribute("inert"), false);
  assert.equal(p.doc.activeElement, row, "back on the agent's row");
  p.$("agent-map-close").click();
  assert.deepEqual(p.visible(), []);
  assert.equal(p.doc.activeElement, pill, "back on the pill");
  assert.deepEqual(p.errors, []);
});

test("Esc goes back exactly one level at a time, and never stops the turn", () => {
  const p = view();
  agentWithWork(p, { end: false });
  p.open();
  const row = p.row(`agent:${sid(1)}`);
  row.click();
  const openTx = p.button(p.card(), "Open transcript");
  openTx.click();
  const before = p.posted.length;
  const esc = () => p.key(p.doc.activeElement, "Escape");
  assert.equal(esc().defaultPrevented, true);
  assert.deepEqual(p.visible(), ["agent-map", "agent-card"]);
  assert.equal(p.doc.activeElement, openTx);
  esc();
  assert.deepEqual(p.visible(), ["agent-map"]);
  assert.equal(p.doc.activeElement, row);
  esc();
  assert.deepEqual(p.visible(), []);
  assert.deepEqual(p.posted.slice(before).filter((m) => m.type === "cancel"), [], "no cancel");
  assert.deepEqual(p.errors, []);
});

test("a click on the dimmed space around the window on top goes back one level; one inside it, or on a covered window, does not", () => {
  const p = view();
  agentWithWork(p);
  const click = (node) => node.dispatchEvent(new p.dom.window.MouseEvent("click", { bubbles: true }));
  p.open();
  const row = p.row(`agent:${sid(1)}`);
  row.click();
  const openTx = p.button(p.card(), "Open transcript");
  openTx.click();
  click(p.$("agent-transcript-box"));
  click(p.$("agent-transcript-log"));
  assert.deepEqual(p.visible(), ["agent-map", "agent-card", "agent-transcript"], "inside the window: nothing");
  click(p.$("agent-card"));
  click(p.$("agent-map"));
  assert.deepEqual(p.visible(), ["agent-map", "agent-card", "agent-transcript"], "a covered window's backdrop is not the reader's to click");
  click(p.$("agent-transcript"));
  assert.deepEqual(p.visible(), ["agent-map", "agent-card"]);
  assert.equal(p.doc.activeElement, openTx);
  click(p.$("agent-card-box"));
  assert.deepEqual(p.visible(), ["agent-map", "agent-card"]);
  click(p.$("agent-card"));
  assert.deepEqual(p.visible(), ["agent-map"]);
  assert.equal(p.doc.activeElement, row);
  click(p.$("agent-map"));
  assert.deepEqual(p.visible(), [], "the map's own backdrop closes it");
  assert.deepEqual(p.errors, []);
});

test("Tab stays in the window on top, and focus sent to a covered one comes back", () => {
  const p = view();
  agentWithWork(p);
  p.open();
  const row = p.row(`agent:${sid(1)}`);
  row.click();
  const openTx = p.button(p.card(), "Open transcript");
  openTx.focus();
  const tab = p.key(openTx, "Tab");
  assert.equal(tab.defaultPrevented, true, "the last control wraps to the first");
  assert.equal(p.doc.activeElement, p.$("agent-card-back"));
  row.focus();
  assert.ok(p.$("agent-card").contains(p.doc.activeElement), "the map's row is out of reach under the card");
  p.$("input").focus();
  assert.ok(p.$("agent-card").contains(p.doc.activeElement));
  assert.deepEqual(p.errors, []);
});

test("the transcript: the prompt it was given with its time, a tool call with its input and output, its reply; live while it works", () => {
  const p = view({ clock: true });
  p.advance(5);
  agentWithWork(p, { end: false });
  p.open();
  p.row(`agent:${sid(1)}`).click();
  p.button(p.card(), "Open transcript").click();
  const txLog = p.$("agent-transcript-log");
  assert.equal(p.$("agent-transcript-title").textContent, "Review the auth module");
  assert.equal(p.$("agent-transcript-meta").textContent, "Working · qwen3.8:27b · foreground", "the card's meta line");
  assert.equal(p.$("agent-transcript-sub").textContent, "Spawned by the main agent");
  const prompt = txLog.querySelector(".msg.user.agent-prompt");
  assert.ok(prompt, "the prompt opens the conversation");
  assert.equal(txLog.firstElementChild, prompt);
  assert.equal(prompt.querySelector(".bubble").textContent, "Read src/auth/ and list every token leak.");
  const time = prompt.querySelector(":scope > time.msg-time");
  assert.ok(time && time.dateTime, "with the time the agent started");
  const call = () => txLog.querySelector(`.tool[data-call-id="${sid(1)}:call_1"]`);
  assert.ok(call(), "its own tool call, drawn by the chat's tool card");
  assert.match(call().querySelector(".arg").textContent, /src\/auth\/session\.ts/, "with its input");
  assert.equal(call().querySelector(".body pre").textContent, "export const refresh = token;", "and its output");
  // The reader opens the call; a new step arrives; the transcript follows it and the call stays open.
  call().querySelector(".tool-toggle").click();
  assert.equal(call().classList.contains("open"), true);
  p.event({ type: "tool_call", call_id: `${sid(1)}:call_2`, name: "grep", args: { pattern: "refresh" }, summary: "refresh" });
  p.advance(1000);
  assert.ok(txLog.querySelector(`.tool[data-call-id="${sid(1)}:call_2"]`), "a new step appears within a second");
  assert.equal(call().classList.contains("open"), true, "the call the reader opened stays open");
  assert.match(p.$("agent-transcript-sub").textContent, /^Spawned by the main agent · 1s$/, "its time ticks");
  // Its reply, last, as soon as it ends.
  p.end(sid(1), "finished", { duration_ms: 31000, tokens: 52000, message: "Found one leak: session.ts logs the refresh token." });
  const answer = txLog.querySelector(".agent-answer");
  assert.match(answer.textContent, /Found one leak/);
  const order = [...txLog.children];
  assert.ok(order.indexOf(prompt) < order.indexOf(call()) && order.indexOf(call()) < order.indexOf(answer), "prompt, work, reply");
  assert.equal(p.$("agent-transcript-meta").textContent, "Finished · qwen3.8:27b · foreground");
  assert.equal(p.$("agent-transcript-sub").textContent, "Spawned by the main agent · 31s · 52k tokens");
  assert.deepEqual(p.errors, []);
});

test("one builder draws an agent's work on its page and in the transcript", () => {
  const p = view();
  agentWithWork(p);
  // The page, opened from the agent's name in the chat.
  p.doc.querySelector(`#log .agent-name[data-agent-id="${sid(1)}"]`).click();
  const pageCalls = [...p.$("agent-log").querySelectorAll(".tool")].map((card) => card.textContent);
  assert.ok(pageCalls.length > 0);
  p.$("agent-back").click();
  p.open();
  p.row(`agent:${sid(1)}`).click();
  p.button(p.card(), "Open transcript").click();
  const txCalls = [...p.$("agent-transcript-log").querySelectorAll(".tool")].map((card) => card.textContent);
  assert.deepEqual(txCalls, pageCalls, "the same steps, drawn the same way");
  assert.equal(p.$("agent-log").querySelector(".agent-answer") === null, true, "the page was emptied when it closed");
  assert.match(panelSrc, /id="agent-transcript-log"/);
  assert.deepEqual(p.errors, []);
});

test("a nested agent's name in a transcript opens its transcript; Back steps out one at a time", () => {
  const p = view();
  agentWithWork(p, { end: false });
  p.event({ type: "tool_call", call_id: `${sid(1)}:call_2`, name: "task", summary: "",
    args: { description: "Trace refresh tokens", prompt: "Find every write of a refresh token." } });
  p.start(sid(2), { call_id: `${sid(1)}:call_2`, parent_id: sid(1), depth: 2, description: "Trace refresh tokens" });
  p.open();
  p.row(`agent:${sid(1)}`).click();
  const openTx = p.button(p.card(), "Open transcript");
  openTx.click();
  const name = p.$("agent-transcript-log").querySelector(`.agent-name[data-agent-id="${sid(2)}"]`);
  assert.ok(name, "the nested agent's line, as on the page");
  name.click();
  assert.equal(p.$("agent-transcript-title").textContent, "Trace refresh tokens");
  assert.equal(p.$("agent-transcript-sub").textContent, "Spawned by Review the auth module");
  assert.equal(p.$("agent-transcript-log").querySelector(".agent-prompt .bubble").textContent, "Find every write of a refresh token.");
  assert.equal(p.$("agent-transcript-back").getAttribute("aria-label"), "Back to the parent agent's transcript");
  p.key(p.doc.activeElement, "Escape");
  assert.equal(p.$("agent-transcript-title").textContent, "Review the auth module", "back to the parent's transcript");
  assert.equal(p.doc.activeElement.dataset.agentId, sid(2), "on the name that was used");
  p.key(p.doc.activeElement, "Escape");
  assert.deepEqual(p.visible(), ["agent-map", "agent-card"]);
  assert.equal(p.doc.activeElement, openTx);
  assert.deepEqual(p.errors, []);
});

test("a task's card opens its output in the large window, live, and Back returns to the card", () => {
  const p = view({}, { agents: true, monitors: true, background_tasks: { version: 1 } });
  p.event({ type: "background_shells", items: [{ id: "bg3", command: "npm run dev", state: "running", started_at: Date.now() / 1000 - 5,
    ended_at: null, exit_code: null, agent_id: null }] });
  p.open();
  p.row("shell:bg3").click();
  const openOut = p.button(p.card(), "Open output");
  assert.ok(openOut.classList.contains("am-wide"));
  openOut.click();
  assert.deepEqual(p.visible(), ["agent-map", "agent-card", "agent-transcript"]);
  assert.equal(p.$("agent-transcript-title").textContent, "npm run dev");
  assert.match(p.$("agent-transcript-meta").textContent, /^Running · shell · \d+s$/);
  assert.equal(p.$("agent-transcript-back").getAttribute("aria-label"), "Back to the task");
  assert.equal(p.posts("getBackgroundOutput").length, 1, "one request for the card and its window");
  p.event({ type: "background_output", request_id: "r1", id: "bg3", output: "ready on :5173\n", total_bytes: 15, truncated: false });
  assert.equal(p.$("agent-transcript-log").querySelector(".am-output-full").textContent, "ready on :5173\n");
  assert.equal(p.card().querySelector(".am-output").textContent, "ready on :5173\n", "the card underneath follows too");
  p.key(p.doc.activeElement, "Escape");
  assert.deepEqual(p.visible(), ["agent-map", "agent-card"]);
  assert.equal(p.doc.activeElement, openOut);
  assert.deepEqual(p.errors, []);
});

test("a chat reset, a rewind, a chat switch and a backend exit each close the map", () => {
  const p = view();
  p.start(sid(1));
  for (const reset of [
    () => p.event({ type: "session", kind: "cleared", message_count: 0, session_id: "s3" }),
    () => p.event({ type: "rewound", ok: true, message_count: 0 }),
    () => p.send({ type: "backend_exit", code: 1, recovering: true, resumes: "offer" }),
  ]) {
    p.start(sid(1));
    p.open();
    assert.equal(p.isOpen(), true);
    reset();
    assert.equal(p.isOpen(), false);
    assert.equal(p.$("agents-pill").getAttribute("aria-expanded"), "false");
  }
  // After a backend exit the agents read stopped; the pill keeps them, none working.
  assert.deepEqual(p.pill(), { hidden: false, state: "idle", label: "0 agents" });
  p.open();
  assert.equal(p.rows()[1].querySelector(".am-meta").textContent, "Stopped");
  assert.equal(p.rows()[1].title, "agent 01\nDGC's backend stopped");
  assert.deepEqual(p.errors, []);
});

test("the main agent's row and card: the chat's name, its model and what is in context", () => {
  const p = view();
  p.event({ type: "session_named", name: "Harden the auth flow" });
  p.event({ type: "context", used: 464400, size: 1048576 });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.start(sid(1)); p.start(sid(2));
  p.end(sid(2), "failed", { message: "x" });
  p.update(sid(1), { state: "waiting", waiting_for: "permission" });
  p.open();
  const root = p.row("root");
  assert.equal(root.querySelector(".am-desc").textContent, "Harden the auth flow");
  assert.equal(root.querySelector(".am-meta").textContent, "qwen3.8:27b · 464.4k tokens in context");
  assert.equal(root.querySelector(".agent-dot").dataset.state, "running", "green while the turn runs");
  root.click();
  assert.equal(p.$("agent-card-title").textContent, "Harden the auth flow");
  assert.equal(p.$("agent-card-meta").textContent, "Working · qwen3.8:27b · 464.4k tokens in context");
  assert.match(p.card().textContent, /2 agents in this chat/);
  assert.deepEqual([...p.card().querySelectorAll(".am-states li")].map((li) => li.textContent),
    ["1 waiting for your permission", "1 failed"]);
  assert.match(p.card().textContent, /464,400 of 1,048,576 tokens in its context window/);
  p.event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
  assert.match(p.$("agent-card-meta").textContent, /^Idle · /);
  p.$("agent-card-back").click();
  // A chat with no name yet is "This chat".
  p.event({ type: "session", kind: "new", message_count: 0, session_id: "s9" });
  p.open();
  assert.equal(p.row("root").querySelector(".am-desc").textContent, "This chat");
  assert.deepEqual(p.errors, []);
});

test("an agent's card: meta, spawned by, live numbers, activity, prompt and its tool calls; Open transcript", () => {
  const p = view({ clock: true });
  p.advance(5);
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.event({ type: "tool_call", call_id: "call_a", name: "task", summary: "",
    args: { description: "Review the auth module", prompt: "Read src/auth/ and list every token leak." } });
  p.start(sid(1), { call_id: "call_a", description: "Review the auth module", agent_type: "reviewer", isolated: true, background: false });
  p.event({ type: "tool_call", call_id: `${sid(1)}:call_1`, name: "read_file", args: { path: "src/auth/session.ts" }, summary: "src/auth/session.ts" });
  p.event({ type: "tool_result", call_id: `${sid(1)}:call_1`, name: "read_file", output: "x", is_error: false });
  p.event({ type: "tool_call", call_id: `${sid(1)}:call_2`, name: "task", summary: "",
    args: { description: "Trace refresh tokens", prompt: "Find every write of a refresh token." } });
  p.start(sid(2), { call_id: `${sid(1)}:call_2`, parent_id: sid(1), depth: 2, description: "Trace refresh tokens", model: "deepseek-v4.1-flash" });
  p.update(sid(1), { activity: "reading src/auth/token.ts", tokens: 142600, tool_calls: 2 });
  p.advance(2000);
  p.open();
  p.row(`agent:${sid(1)}`).click();
  const text = () => p.card().textContent;
  assert.equal(p.$("agent-card-meta").textContent, "Working · reviewer · qwen3.8:27b · foreground", "state · type · model · foreground");
  assert.match(text(), /Spawned by the main agent/);
  assert.match(text(), /2s · 142\.6k tokens/);
  assert.match(text(), /Now: reading src\/auth\/token\.ts/);
  const [prompt, calls] = p.card().querySelectorAll("details.am-fold");
  assert.equal(prompt.open, true, "open while it works");
  assert.equal(prompt.querySelector("pre").textContent, "Read src/auth/ and list every token leak.");
  assert.equal(calls.open, true);
  assert.equal(calls.querySelector("summary").textContent, "Tool calls (2)");
  assert.deepEqual([...calls.querySelectorAll(".am-call")].map((li) => li.querySelector(".am-call-text").textContent),
    ["Read src/auth/session.ts", "Delegating Trace refresh tokens"]);
  p.advance(1000);
  assert.match(text(), /3s · 142\.6k tokens/, "the numbers tick while the card is open");
  p.update(sid(1), { state: "waiting", waiting_for: "permission" });
  assert.match(text(), /Waiting for your permission\. Answer it in the chat's permission card\./);
  // The nested agent's card names its parent, which opens the parent's card.
  p.$("agent-card-back").click();
  p.row(`agent:${sid(2)}`).click();
  assert.equal(p.$("agent-card-meta").textContent, "Working · deepseek-v4.1-flash · foreground");
  assert.equal(p.card().querySelector(".am-spawned").textContent, "Spawned by Review the auth module");
  assert.equal(p.card().querySelector("details pre").textContent, "Find every write of a refresh token.");
  p.card().querySelector(".am-spawned button").click();
  assert.equal(p.$("agent-card-title").textContent, "Review the auth module");
  // Open transcript opens the third level inside the map; nothing navigates away.
  assert.equal(p.button(p.card(), "Open transcript").classList.contains("am-wide"), true, "full width");
  p.button(p.card(), "Open transcript").click();
  assert.deepEqual(p.visible(), ["agent-map", "agent-card", "agent-transcript"]);
  assert.equal(p.$("agent-transcript-title").textContent, "Review the auth module");
  assert.equal(p.doc.body.dataset.agentPage, undefined, "the agent page is not opened");
  assert.deepEqual(p.errors, []);
});

test("an ended agent's card: the failure in its own words, the report with Files to open, the prompt folded", () => {
  const p = view();
  p.event({ type: "tool_call", call_id: "call_f", name: "task", args: { description: "bench", prompt: "Time the cold start." }, summary: "" });
  p.start(sid(1), { call_id: "call_f", description: "bench" });
  p.start(sid(2), { description: "migrate" });
  p.end(sid(1), "failed", { message: "HTTP 502 from the model provider\nupstream timed out", duration_ms: 48000, tokens: 18200 });
  p.end(sid(2), "finished", { duration_ms: 212000, tokens: 97200, tool_calls: 44,
    message: "Migrated the settings store.\nFILES: src/settings.ts, test/ (3 files)" });
  p.open();
  p.row(`agent:${sid(1)}`).click();
  assert.equal(p.$("agent-card-meta").textContent, "Failed · qwen3.8:27b · foreground");
  assert.equal(p.card().querySelector(".am-failure").textContent, "HTTP 502 from the model provider\nupstream timed out");
  assert.equal(p.card().querySelector("details.am-fold").open, false, "the prompt is folded once it has ended");
  assert.equal(p.card().querySelector(".am-stop-note, .am-actions button:nth-child(2)")?.hidden ?? true, true, "no Stop once it ended");
  p.$("agent-card-back").click();
  p.row(`agent:${sid(2)}`).click();
  assert.match(p.card().querySelector(".agent-answer").textContent, /Migrated the settings store\./);
  assert.doesNotMatch(p.card().querySelector(".agent-answer").textContent, /FILES/);
  assert.deepEqual([...p.card().querySelectorAll(".agent-file")].map((b) => b.textContent), ["src/settings.ts"]);
  assert.match(p.card().textContent, /3m 32s · 97\.2k tokens/);
  assert.equal(p.card().querySelectorAll("details summary")[1].textContent, "Tool calls (44)", "the count is in the disclosure");
  assert.match(p.card().textContent, /This agent's prompt was not kept in the chat\./);
  assert.match(p.card().textContent, /Its steps were not kept in this chat\. Its transcript has its report\./);
  assert.deepEqual(p.errors, []);
});

test("Stop agent: one agent through agent_control when allowed; otherwise the turn's own Stop, and the card says so", () => {
  const stopButton = (p) => [...p.card().querySelectorAll(".am-actions button")].find((b) => /^Stop/.test(b.textContent));
  // A background agent, with agent_control: the command, Stopping…, and a refusal said plainly.
  let p = view({}, { agents: true, agent_control: true });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.start(sid(1), { background: true });
  p.open();
  p.row(`agent:${sid(1)}`).click();
  assert.equal(stopButton(p).textContent, "Stop agent");
  stopButton(p).click();
  assert.deepEqual(p.posts("stopAgent"), [{ type: "stopAgent", id: sid(1) }]);
  assert.deepEqual(p.posts("cancel"), []);
  assert.equal(stopButton(p).textContent, "Stopping…");
  assert.equal(stopButton(p).disabled, true);
  stopButton(p).click();
  assert.equal(p.posts("stopAgent").length, 1, "once");
  p.send({ type: "agent_stop_state", id: sid(1), state: "error", error: "already finished" });
  assert.equal(stopButton(p).textContent, "Stop agent");
  assert.match(p.card().textContent, /The agent could not be stopped\. It may have finished already\./);
  stopButton(p).click();
  p.end(sid(1), "stopped", { message: "stopped by the user" });
  assert.equal(stopButton(p).hidden, true, "no Stop once it has ended");

  // A foreground agent, with agent_control_foreground: the same one-agent command.
  p = view({}, { agents: true, agent_control: true, agent_control_foreground: true });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.start(sid(2));
  p.open();
  p.row(`agent:${sid(2)}`).click();
  assert.equal(stopButton(p).textContent, "Stop agent");
  assert.doesNotMatch(p.card().textContent, /ends the whole turn/);
  stopButton(p).click();
  assert.deepEqual(p.posts("stopAgent"), [{ type: "stopAgent", id: sid(2) }]);
  assert.deepEqual(p.posts("cancel"), []);

  // A foreground agent without it: Stop ends the turn, and says so; agent_control is never sent.
  p = view({}, { agents: true, agent_control: true });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.start(sid(3));
  p.open();
  p.row(`agent:${sid(3)}`).click();
  assert.equal(stopButton(p).textContent, "Stop the turn");
  assert.match(p.card().textContent, /Stop ends the whole turn, including every agent\./);
  stopButton(p).click();
  assert.deepEqual(p.posts("cancel"), [{ type: "cancel" }]);
  assert.deepEqual(p.posts("stopAgent"), []);

  // A CLI with no agent_control at all: a background agent offers no Stop, and says why.
  p = view({}, { agents: true });
  p.start(sid(4), { background: true });
  p.open();
  p.row(`agent:${sid(4)}`).click();
  assert.equal(stopButton(p).hidden, true);
  assert.match(p.card().textContent, /This DGC CLI cannot stop one agent\./);
  assert.deepEqual(p.errors, []);
});

const BG = { agents: true, agent_control: true, monitors: true, troupe: true, background_tasks: { version: 1 } };
const now = () => Date.now() / 1000;
function background(p) {
  p.event({ type: "monitors", wake_paused: false, pending_events: 0, items: [
    { id: "mon1", description: "Watch the dev server log", command: "tail -f logs/dev.log", state: "running", events: 14,
      pending_events: 0, persistent: true, timeout_ms: 0, started_at: Math.floor(now() - 3725) },
    { id: "mon2", description: "an ended one", command: "true", state: "ended", events: 1, pending_events: 0, persistent: false,
      timeout_ms: 1000, started_at: Math.floor(now() - 50), end_reason: "exited", exit_code: 0 }] });
  p.event({ type: "background_shells", items: [
    { id: "bg3", command: "npm run dev", state: "running", started_at: now() - 187, ended_at: null, exit_code: null, agent_id: sid(1) },
    { id: "bg4", command: "make test", state: "exited", started_at: now() - 90, ended_at: now() - 30, exit_code: 0, agent_id: null }] });
  p.event({ type: "troupe_started", run_id: "tr-0123456789", title: "Review every API handler", state: "running", reason: "",
    stages: [{ name: "review", total: 8, done: 5, failed: 0, kept: 0 }], agents_planned: 11, reused: 0, journal: ".dgc/troupes/tr-0123456789" });
  p.event({ type: "artifact_ready", id: "art1", name: "settings preview", url: "http://127.0.0.1:8765/?a=art1", rel: "settings" });
}

test("background tasks: running monitors, shells, troupes and previews, each with its kind; ended ones drop out", () => {
  const p = view({}, BG);
  p.start(sid(1), { description: "dev server agent" });
  background(p);
  p.open();
  assert.equal(p.$("agent-map-tasks").hidden, false);
  assert.equal(p.$("agent-map-tasks-title").textContent, "4 background tasks · click a task for details");
  const rows = p.tasks();
  assert.deepEqual(rows.map(([key]) => key), ["monitor:mon1", "shell:bg3", "troupe:tr-0123456789", "preview:art1"]);
  assert.match(rows[0][1], /^Watch the dev server logmonitor · 1h 2m · 14 events$/);
  assert.match(rows[1][1], /^npm run devshell · 3m \d+s$/);
  assert.equal(rows[2][1], "Review every API handlertroupe · review 5/8");
  assert.match(rows[3][1], /^settings previewpreview · up 0s$/);
  assert.ok(p.doc.querySelectorAll("#agent-map-task-list .agent-dot[data-state=running]").length === 4, "green while they run");
  // The troupe finishes, the shell exits, the preview is stopped: each leaves the list.
  p.event({ type: "troupe_finished", run_id: "tr-0123456789", title: "Review every API handler", state: "done", reason: "",
    stages: [{ name: "review", total: 8, done: 8, failed: 0, kept: 3 }], agents_planned: 11, reused: 0, journal: ".dgc/troupes/tr-0123456789" });
  p.event({ type: "background_shells", items: [{ id: "bg3", command: "npm run dev", state: "killed", started_at: now() - 187,
    ended_at: now(), exit_code: null, agent_id: null }] });
  p.send({ type: "artifact_stop_state", id: "art1", state: "stopped" });
  assert.deepEqual(p.tasks().map(([key]) => key), ["monitor:mon1"]);
  assert.equal(p.$("agent-map-tasks-title").textContent, "1 background task · click a task for details");
  p.event({ type: "monitors", wake_paused: false, pending_events: 0, items: [] });
  assert.equal(p.$("agent-map-tasks").hidden, true, "no section with nothing running");
  assert.deepEqual(p.errors, []);
});

test("a CLI without background_tasks: no shells, no output fetch; a monitor's card shows the lines its events brought", () => {
  const p = view({ clock: true }, { agents: true, monitors: true });
  p.event({ type: "monitors", wake_paused: false, pending_events: 0, items: [{ id: "mon1", description: "dev log", command: "tail -f x",
    state: "running", events: 2, pending_events: 0, persistent: true, timeout_ms: 0, started_at: Math.floor(now()) }] });
  p.event({ type: "background_shells", items: [{ id: "bg3", command: "npm run dev", state: "running", started_at: now(), ended_at: null,
    exit_code: null, agent_id: null }] });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.event({ type: "monitor_event", id: "mon1", description: "dev log", event_index: 1, lines: ["ready on :5173", "GET / 200"], kind: "output", delivery: "inline" });
  p.$("input").textContent = "/agents";
  p.key(p.$("input"), "Enter");
  assert.deepEqual(p.tasks().map(([key]) => key), ["monitor:mon1"], "a shells event from an older CLI is ignored");
  assert.deepEqual(p.posts("listBackgroundShells"), []);
  p.row("monitor:mon1").click();
  p.advance(3000);
  assert.deepEqual(p.posts("getBackgroundOutput"), [], "never asked for");
  assert.equal(p.card().querySelector(".am-output").textContent, "ready on :5173\nGET / 200");
  assert.match(p.card().textContent, /The lines this monitor reported to the chat\./);
  assert.deepEqual(p.errors, []);
});

test("a shell's card polls its output every second while open and on screen, pinned to the end, and stops when it closes", () => {
  const p = view({ clock: true }, BG);
  p.start(sid(1), { description: "dev server agent" });
  background(p);
  p.open();
  assert.deepEqual(p.posts("listBackgroundShells"), [{ type: "listBackgroundShells" }], "the list is asked for on open");
  p.row("shell:bg3").click();
  assert.equal(p.$("agent-card-title").textContent, "npm run dev");
  assert.match(p.$("agent-card-meta").textContent, /^Running · shell · 3m \d+s$/);
  const facts = [...p.card().querySelectorAll(".am-facts dt, .am-facts dd")].map((n) => n.textContent);
  assert.deepEqual(facts, ["Command", "npm run dev", "Started by", "dev server agent", "Id", "bg3"]);
  assert.deepEqual(p.posts("getBackgroundOutput"), [{ type: "getBackgroundOutput", id: "bg3" }], "asked at once");
  assert.match(p.card().textContent, /No output yet\./);
  p.advance(1000);
  assert.equal(p.posts("getBackgroundOutput").length, 1, "never a second request while one is unanswered");
  p.event({ type: "background_output", request_id: "r1", id: "bg3", output: "ready\n", total_bytes: 6, truncated: false });
  assert.equal(p.card().querySelector(".am-output").textContent, "ready\n");
  p.advance(1000);
  assert.equal(p.posts("getBackgroundOutput").length, 2, "then once a second");
  p.event({ type: "background_output", request_id: "r2", id: "bg3", output: "x".repeat(2048), total_bytes: 182000, truncated: true });
  assert.match(p.card().textContent, /Showing the last 2 KB of 178 KB of output\./);
  // Hidden panel: no requests; on screen again: they resume.
  Object.defineProperty(p.doc, "hidden", { configurable: true, get: () => true });
  p.advance(3000);
  assert.equal(p.posts("getBackgroundOutput").length, 2, "nothing while the panel is out of sight");
  Object.defineProperty(p.doc, "hidden", { configurable: true, get: () => false });
  p.doc.dispatchEvent(new p.dom.window.Event("visibilitychange"));
  assert.equal(p.posts("getBackgroundOutput").length, 3);
  p.send({ type: "background_output_failed", id: "bg3" });
  // Back to the map: no more requests.
  p.$("agent-card-back").click();
  p.advance(5000);
  assert.equal(p.posts("getBackgroundOutput").length, 3, "stops when the card closes");
  // A refused fetch says so, in the card, never as a line in the chat.
  p.row("shell:bg3").click();
  p.event({ type: "command_rejected", command: "get_background_output", request_id: "task-output-1", reason: "unknown", message: "no such task" });
  p.send({ type: "background_output_failed", id: "bg3" });
  assert.match(p.card().textContent, /Output is not available\./);
  assert.equal(p.doc.querySelector("#log .sys.err"), null, "no error line in the transcript");
  assert.deepEqual(p.errors, []);
});

test("Stop on a task sends its kind's own command; a refusal is said in the card", () => {
  const p = view({}, BG);
  background(p);
  p.open();
  const stop = () => [...p.card().querySelectorAll(".am-actions button")].find((b) => /^Stop/.test(b.textContent));
  const run = (key) => { p.row(key).click(); stop().click(); const label = stop().textContent; p.$("agent-card-back").click(); return label; };
  assert.equal(run("monitor:mon1"), "Stopping…");
  assert.equal(run("shell:bg3"), "Stopping…");
  assert.equal(run("troupe:tr-0123456789"), "Stopping…");
  assert.equal(run("preview:art1"), "Stopping…");
  assert.deepEqual(p.posts("stopMonitor"), [{ type: "stopMonitor", id: "mon1" }]);
  assert.deepEqual(p.posts("stopBackgroundShell"), [{ type: "stopBackgroundShell", id: "bg3" }]);
  assert.deepEqual(p.posts("stopTroupe"), [{ type: "stopTroupe", run_id: "tr-0123456789" }]);
  assert.deepEqual(p.posts("stopArtifact"), [{ type: "stopArtifact", id: "art1" }]);
  p.send({ type: "background_stop_state", kind: "shell", id: "bg3", state: "error", error: "no" });
  p.row("shell:bg3").click();
  assert.equal(stop().textContent, "Stop");
  assert.match(p.card().textContent, /It could not be stopped\. It may have finished already\./);
  // A preview's card opens it in the browser.
  p.$("agent-card-back").click();
  p.row("preview:art1").click();
  [...p.card().querySelectorAll("button")].find((b) => b.textContent === "Open in browser").click();
  assert.deepEqual(p.posts("openExternal"), [{ type: "openExternal", url: "http://127.0.0.1:8765/?a=art1" }]);
  // The troupe's card shows its stages.
  p.$("agent-card-back").click();
  p.row("troupe:tr-0123456789").click();
  assert.match(p.card().querySelector(".am-stages").textContent, /review/);
  assert.match(p.card().textContent, /About 11/);
  assert.deepEqual(p.errors, []);
});

test("a task's card stays open on its last snapshot after it ends, with its time frozen", () => {
  const p = view({ clock: true }, BG);
  background(p);
  p.open();
  p.row("shell:bg3").click();
  p.event({ type: "background_output", request_id: "r0", id: "bg3", output: "", total_bytes: 0, truncated: false });
  p.event({ type: "background_shells", items: [{ id: "bg3", command: "npm run dev", state: "exited", started_at: now() - 187,
    ended_at: now() - 7, exit_code: 1, agent_id: null }] });
  assert.match(p.$("agent-card-meta").textContent, /^Exited · code 1 · shell · 3m 0s$/);
  const stop = [...p.card().querySelectorAll(".am-actions button")].find((b) => b.textContent === "Stop");
  assert.equal(stop.hidden, true);
  assert.equal(p.posts("getBackgroundOutput").length, 2, "one last look at its output once it ended");
  p.event({ type: "background_output", request_id: "r9", id: "bg3", output: "", total_bytes: 0, truncated: false });
  p.advance(4000);
  assert.equal(p.posts("getBackgroundOutput").length, 2, "and no polling after that");
  assert.match(p.card().textContent, /No output\./);
  // A preview stopped elsewhere is gone from every list; its card keeps what it was.
  p.$("agent-card-back").click();
  p.row("preview:art1").click();
  p.event({ type: "artifacts", request_id: "artifacts-3", items: [] });
  assert.match(p.$("agent-card-meta").textContent, /^Stopped · preview/);
  assert.deepEqual(p.errors, []);
});

test("Pip runs started from this chat are background tasks, opened in Pips", () => {
  const p = view({}, BG);
  let options = null, opened = [];
  const runs = [{ id: "run_" + "b".repeat(32), pipId: "pip_" + "a".repeat(32), name: "Review changes", status: "running",
    label: "Working", detail: "Working on its own. You can keep chatting.", active: true },
  { id: "run_" + "c".repeat(32), pipId: "pip_" + "a".repeat(32), name: "Old run", status: "succeeded", label: "Report ready", detail: "", active: false }];
  p.dom.window.DgcPips = { mountSetupCards: (o) => { options = o; return { toolResult() {}, finish() {}, reset() {}, receive() {},
    runs: () => runs, openRun: (id) => opened.push(id) }; } };
  p.doc.documentElement.dataset.pipsDocumentId = "doc1";
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.event({ type: "tool_call", call_id: "c1", name: "run_pip_now", args: {}, summary: "" });
  p.event({ type: "tool_result", call_id: "c1", name: "run_pip_now", output: "{}", is_error: false });
  assert.ok(options?.onRunsChange, "the map listens for its runs");
  p.open();
  assert.deepEqual(p.tasks(), [[`pip:run_${"b".repeat(32)}`, "Review changesPip run · Working"]], "only the one at work");
  runs[0].label = "Stopping";
  options.onRunsChange();
  assert.equal(p.tasks()[0][1], "Review changesPip run · Stopping", "a change repaints the open map");
  p.row(`pip:run_${"b".repeat(32)}`).click();
  assert.equal([...p.card().querySelectorAll(".am-actions button")].filter((b) => !b.hidden).map((b) => b.textContent).join(), "Open in Pips,Stopping…",
    "a run that is stopping says so, and its Stop waits");
  assert.equal([...p.card().querySelectorAll(".am-actions button")].find((b) => b.textContent === "Stopping…").disabled, true);
  p.card().querySelector(".am-actions button").click();
  assert.deepEqual(opened, [`run_${"b".repeat(32)}`]);
  assert.equal(p.isOpen(), false);
  assert.deepEqual(p.errors, []);
});

test("a Pip run's row stays live while it works: what it is doing, its clock, and Stop", () => {
  const p = view({}, BG);
  let options = null; const stopped = [];
  const started = Date.now() - 42_000;
  const runs = [{ id: "run_" + "b".repeat(32), pipId: "pip_" + "a".repeat(32), name: "Billing audit", status: "running",
    label: "Working", detail: "Working on its own. You can keep chatting.", active: true, activity: "Reading billing.py",
    startedAt: started, stoppable: true }];
  p.dom.window.DgcPips = { mountSetupCards: (o) => { options = o; return { toolResult() {}, finish() {}, reset() {}, receive() {},
    runs: () => runs, openRun() {}, stopRun: (id) => { stopped.push(id); return Promise.resolve(true); } }; } };
  p.doc.documentElement.dataset.pipsDocumentId = "doc1";
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.event({ type: "tool_call", call_id: "c1", name: "run_pip_now", args: {}, summary: "" });
  p.event({ type: "tool_result", call_id: "c1", name: "run_pip_now", output: "{}", is_error: false });
  p.open();
  const key = `pip:run_${"b".repeat(32)}`;
  assert.match(p.tasks()[0][1], /^Billing auditPip run · Reading billing\.py · 4[2-3]s$/, "what it is doing now, and since when");
  runs[0].activity = "Waiting for the model";
  options.onRunsChange();
  assert.match(p.tasks()[0][1], /^Billing auditPip run · Waiting for the model · 4\ds$/, "it moves on as the Pip does");
  p.row(key).click();
  assert.match(p.$("agent-card-meta").textContent, /^Waiting for the model · Pip run · 4\ds$/);
  const stop = [...p.card().querySelectorAll(".am-actions button")].find((b) => b.textContent === "Stop");
  assert.ok(stop && !stop.hidden && !stop.disabled, "Stop, as a monitor or a shell has");
  stop.click();
  assert.deepEqual(stopped, [`run_${"b".repeat(32)}`]);
  assert.equal(stop.textContent, "Stopping…");
  assert.equal(stop.disabled, true);
  runs[0] = { ...runs[0], status: "succeeded", label: "Report ready", active: false, activity: "", stoppable: false };
  options.onRunsChange();
  assert.deepEqual(p.tasks(), [], "ended: off the list of what runs now");
  assert.deepEqual(p.errors, []);
});

test("the layout follows the dialog's measured width: side by side when the columns fit, on end when they do not", () => {
  const p = view({ resizeObservers: true });
  p.start(sid(1)); p.start(sid(2), { parent_id: sid(1), depth: 2 });
  p.open();
  const box = p.$("agent-map-box"), tree = p.$("agent-map-tree");
  assert.equal(box.dataset.layout, "vertical", "unmeasured, it stands on end");
  p.resize(tree, { contentRect: { width: 836 } });
  assert.equal(box.dataset.layout, "horizontal");
  // 836 - (220 + 2 x (32 + 200)) = 152 to share three ways: 50 more each.
  assert.equal(tree.style.getPropertyValue("--am-root-w"), "270px");
  assert.equal(tree.style.getPropertyValue("--am-row-w"), "250px", "an equal share of what is left");
  p.resize(tree, { contentRect: { width: 683 } });
  assert.equal(box.dataset.layout, "vertical", "one pixel short of root + two columns at their narrowest");
  p.resize(tree, { contentRect: { width: 684 } });
  assert.equal(box.dataset.layout, "horizontal");
  p.resize(tree, { contentRect: { width: 242 } });
  assert.equal(box.dataset.layout, "vertical");
  assert.equal(tree.style.getPropertyValue("--am-indent"), "20px");
  // A third level at the same width: the indent gives way so the deepest row keeps its width.
  p.start(sid(3), { parent_id: sid(2), depth: 3 });
  p.start(sid(4), { parent_id: sid(3), depth: 4 });
  assert.equal(tree.style.getPropertyValue("--am-indent"), "14px");
  assert.deepEqual(p.errors, []);
});

test("panel.ts relays the map's commands, each behind the capability that says the CLI takes it", () => {
  const method = (name) => { const s = panelSrc.slice(panelSrc.indexOf(`private async ${name}(`)); return s.slice(0, s.indexOf("\n  }\n")); };
  assert.match(method("stopAgent"), /capabilities as any\)\?\.agent_control\) \{ return; \}/);
  assert.match(method("stopAgent"), /type: "agent_control", action: "close", id: agentId,\s*request_id: this\.nextRequestId\("agent-stop"\)/);
  assert.match(method("stopAgent"), /type: "agent_stop_state", id: agentId, state: "error"/);
  assert.match(method("stopBackgroundShell"), /!this\.backgroundTasks\(\)/);
  assert.match(method("stopBackgroundShell"), /type: "stop_background_shell", id: shellId/);
  assert.match(method("getBackgroundOutput"), /!this\.backgroundTasks\(\)/);
  assert.match(method("getBackgroundOutput"), /type: "get_background_output", id: taskId, max_bytes: 65536/);
  assert.match(method("getBackgroundOutput"), /type: "background_output_failed", id: taskId/);
  assert.match(panelSrc, /private backgroundTasks\(\): boolean \{\s*return Number\(\(this\.lastReadyEvent\?\.capabilities as any\)\?\.background_tasks\?\.version\) >= 1;/);
  const onMessage = panelSrc.slice(panelSrc.indexOf("private async onMessage("));
  for (const [type, call] of [["stopAgent", "this.stopAgent"], ["stopBackgroundShell", "this.stopBackgroundShell"],
    ["getBackgroundOutput", "this.getBackgroundOutput"], ["listBackgroundShells", "list_background_shells"]]) {
    const at = onMessage.indexOf(`case "${type}":`);
    assert.ok(at > 0, type);
    assert.ok(onMessage.slice(at, at + 300).includes(call), `${type} -> ${call}`);
  }
  const repaint = panelSrc.slice(panelSrc.indexOf("private repaintFromBackend("));
  assert.match(repaint.slice(0, repaint.indexOf("\n  }\n")), /this\.backgroundTasks\(\)\) \{\s*be\.send\(\{ type: "list_background_shells"/,
    "a reloaded webview asks for the shells again");
});
