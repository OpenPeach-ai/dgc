// The agents indicator in the webview: the "● 2 agents" pill (Claude Code's counting rule: the
// agents working now, for the whole chat, and beside them the background tasks running now, "1 agent
// · 2 tasks"), the agent map it opens, rows that open each agent's card and page, announcements,
// chat boundaries and backend exits. The map itself is agent-map.test.mjs's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, mainCss, makeDom, panelSrc } from "./support/webview-dom.mjs";

const PILL_HINT = "Click to open the agent map";
// What the pill reads where the footer has room: its words, without the narrow footer's total and
// without "· needs you" (a span of its own, shown only while an agent waits).
const pillWords = (button) => [...button.querySelector(".agents-label").children]
  .filter((node) => !node.matches(".agents-short, .agents-need")).map((node) => node.textContent).join("");

function view(options = {}) {
  const v = makeDom(options);
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  let n = 0;
  const start = (id, fields = {}) => event({ type: "agent_started", id, parent_id: null, call_id: `call_${n++}`,
    description: `agent ${id}`, depth: 1, state: "running", started_at: 1000 + n, isolated: false, parallel: false,
    ...fields });
  const update = (id, fields) => event({ type: "agent_updated", id, state: "running", ...fields });
  const end = (id, state = "finished", fields = {}) => event({ type: "agent_ended", id, state, duration_ms: 1200,
    tool_calls: 2, ...fields });
  const pill = () => ({
    hidden: $("agents-picker").hidden, state: $("agents-pill").dataset.state,
    label: pillWords($("agents-pill")),
    title: $("agents-pill").title, aria: $("agents-pill").getAttribute("aria-label"),
    need: !$("agents-pill").querySelector(".agents-need").hidden,
  });
  const mapOpen = () => !$("agent-map").hidden;
  // The map's agent rows, root excluded, in the order they are drawn.
  const agentRows = () => [...v.doc.querySelectorAll("#agent-map-tree .am-agent")];
  // A row opens its agent's card; the card's "Open transcript" opens the window over it.
  const openTranscript = (id) => {
    v.doc.querySelector(`#agent-map .am-row[data-agent-id="${id}"]`).click();
    [...$("agent-card-body").querySelectorAll("button")].find((b) => b.textContent === "Open transcript").click();
  };
  // An agent's page opens from its name in the chat.
  const openPage = (id) => v.doc.querySelector(`#log .agent-name[data-agent-id="${id}"]`).click();
  const frame = () => new Promise((resolve) => v.dom.window.requestAnimationFrame(() => resolve()));
  return { ...v, event, $, start, update, end, pill, mapOpen, agentRows, openTranscript, openPage, frame };
}

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;

test("the pill counts the agents working now and stays for the whole chat once it has one", () => {
  const { event, start, update, end, pill, errors } = view();
  assert.equal(pill().hidden, true, "hidden while the chat has no agents");
  start(sid(1));
  assert.deepEqual(pill(), { hidden: false, state: "running", label: "1 agent", need: false,
    title: `Agents are working · ${PILL_HINT}`, aria: `1 agent · Agents are working · ${PILL_HINT}` });
  start(sid(2));
  assert.equal(pill().label, "2 agents");
  update(sid(2), { state: "waiting", waiting_for: "permission" });
  assert.equal(pill().state, "waiting");
  assert.equal(pill().need, true);
  assert.equal(pill().title, `An agent is waiting for your permission · ${PILL_HINT}`);
  assert.equal(pill().aria, `2 agents · An agent is waiting for your permission · ${PILL_HINT}`);
  update(sid(2), { state: "running" });
  end(sid(1));
  assert.equal(pill().label, "1 agent", "a finished agent no longer counts");
  end(sid(2));
  assert.equal(pill().hidden, false, "every agent ended: the pill stays");
  assert.equal(pill().label, "0 agents");
  assert.equal(pill().state, "idle");
  assert.equal(pill().title, `No agents working · ${PILL_HINT}`);
  event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
  assert.deepEqual([pill().hidden, pill().label], [false, "0 agents"], "and stays after the turn ends");
  start(sid(3));
  assert.equal(pill().label, "1 agent");
  assert.equal(pill().state, "running");
  assert.equal(pill().title, `Agents are working · ${PILL_HINT}`);
  assert.deepEqual(errors, []);
});

test("waiting for an answer has its own tooltip; unknown ids and duplicates change nothing", () => {
  const { start, update, end, pill, errors } = view();
  start(sid(1));
  update(sid(1), { state: "waiting", waiting_for: "answer" });
  assert.equal(pill().title, `An agent is waiting for your answer · ${PILL_HINT}`);
  start(sid(1), { description: "duplicate" });
  update(sid(9), { state: "waiting", waiting_for: "permission" });
  end(sid(9), "failed");
  assert.equal(pill().label, "1 agent");
  assert.equal(pill().title, `An agent is waiting for your answer · ${PILL_HINT}`);
  assert.deepEqual(errors, []);
});

test("a new chat hides the pill and closes the map; a fork keeps it; a big snapshot counts past its items", () => {
  const { $, doc, event, start, pill, mapOpen, errors } = view();
  start(sid(1));
  $("agents-pill").click();
  assert.equal(mapOpen(), true);
  event({ type: "session", kind: "new", message_count: 0, session_id: "s2" });
  assert.equal(pill().hidden, true, "the wrapper carries hidden");
  assert.equal(mapOpen(), false);
  assert.equal(doc.activeElement, $("input"), "focus goes back to the prompt");

  const items = Array.from({ length: 64 }, (_, i) => ({ id: sid(100 + i), parent_id: null, call_id: `c${i}`,
    description: `a${i}`, depth: 1, state: "finished", tool_calls: 1, isolated: false, parallel: false,
    restored: false, duration_ms: 1000 }));
  event({ type: "agents", items, total: 70, active: 0 });
  assert.deepEqual([pill().hidden, pill().label, pill().state], [false, "0 agents", "idle"],
    "a chat whose agents all ended shows the pill at 0: the map is still worth opening");
  event({ type: "session", kind: "forked", message_count: 3, session_id: "s3" });
  assert.equal(pill().label, "0 agents", "a fork keeps the chat's agents");
  event({ type: "agents", items, total: 73, active: 3 });
  assert.equal(pill().label, "3 agents", "active agents omitted from a bounded snapshot still count");
  $("agents-pill").click();
  assert.equal($("agent-map-subtitle").textContent, "73 agents · click an agent for details");
  assert.equal($("agent-map-more").textContent, "9 more agents not listed, 3 of them working.");
  event({ type: "session", kind: "cleared", message_count: 0, session_id: "s4" });
  assert.equal(pill().hidden, true);
  assert.equal(mapOpen(), false);
  assert.deepEqual(errors, []);
});

test("the pill is the first control of the right cluster and the markup follows the design", () => {
  const { doc, $ } = view();
  const right = doc.querySelector(".cf-right");
  assert.equal(right.firstElementChild, $("agents-picker"));
  assert.equal($("agents-picker").nextElementSibling.querySelector("#btn-model") !== null, true);
  assert.ok($("agents-picker").classList.contains("picker") && $("agents-picker").classList.contains("agents-picker"));
  const button = $("agents-pill");
  assert.equal(button.getAttribute("aria-haspopup"), "dialog");
  assert.equal(button.getAttribute("aria-controls"), "agent-map");
  assert.equal($("agent-map").getAttribute("role"), "dialog");
  assert.equal($("agent-map").getAttribute("aria-modal"), "true");
  assert.equal($("agent-map").getAttribute("aria-labelledby"), "agent-map-title");
  assert.equal($("agents-picker").querySelector("[role=dialog]"), null, "no dropdown inside the picker any more");
  const rail = [...$("composer-rail").children].map((node) => node.id);
  assert.ok(!rail.includes("agents-picker"), "not a composer-rail row");
});

test("the map nests agents under their parents, is keyboard driven, and Esc never stops the turn", async () => {
  const { $, doc, dom, event, start, update, posted, frame, agentRows, errors } = view();
  doc.getElementById("send").dataset.mode = "default";
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  start(sid(1), { description: "review auth module", agent_type: "reviewer" });
  start(sid(2), { description: "<img src=x onerror=alert(1)>", parent_id: sid(1), depth: 2, call_id: `${sid(1)}:c1` });
  start(sid(3), { description: "write migration" });
  $("agents-pill").click();
  assert.equal($("agents-pill").getAttribute("aria-expanded"), "true");
  assert.equal($("agent-map-subtitle").textContent, "3 agents · click an agent for details");
  const rows = agentRows();
  assert.equal(rows.length, 3);
  assert.equal(doc.activeElement, rows[0], "focus moves to the first agent");
  const nested = doc.querySelector(".am-root-node > .am-children > li > .am-children > li > .am-self > .am-row");
  assert.equal(nested.dataset.agentId, sid(2), "a child sits in a list nested inside its parent's item");
  assert.equal(nested.querySelector(".am-desc").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(doc.querySelector("#agent-map img"), null, "descriptions are text");
  assert.match(rows[0].querySelector(".am-meta").textContent, /^(Working|\d+s)$/);

  const key = (target, name) => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  key(doc.activeElement, "ArrowDown");
  assert.equal(doc.activeElement.dataset.agentId, sid(2));
  key(doc.activeElement, "End");
  assert.equal(doc.activeElement.dataset.agentId, sid(3));
  key(doc.activeElement, "Home");
  assert.equal(doc.activeElement.dataset.amKey, "root", "the main agent is the first row");
  key(doc.activeElement, "ArrowDown");
  assert.equal(doc.activeElement.dataset.agentId, sid(1));
  update(sid(3), { state: "waiting", waiting_for: "permission" });
  await frame();
  assert.equal(doc.activeElement.dataset.agentId, sid(1), "a live re-render keeps the focused row");

  // A foreground agent's card says what its Stop does: there is no Stop for one agent in a turn here.
  doc.activeElement.click();
  assert.match($("agent-card-body").textContent, /Stop ends the whole turn, including every agent\./);
  key(doc.activeElement, "Escape");
  assert.equal(doc.activeElement.dataset.agentId, sid(1), "Esc on the card goes back to its row");

  // Esc with a turn running: the map closes and focus returns to the pill; nothing is posted.
  const before = posted.length;
  const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  doc.activeElement.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal($("agent-map").hidden, true);
  assert.equal(doc.activeElement, $("agents-pill"));
  assert.deepEqual(posted.slice(before), [], "no cancel, no stop");

  // Tab cannot leave the dialog: focus that goes elsewhere while it is open is handed back.
  $("agents-pill").click();
  $("agent-map-settings").focus();
  $("input").focus();
  assert.equal($("agent-map").hidden, false);
  assert.ok($("agent-map").contains(doc.activeElement));
  assert.deepEqual(errors, []);
});

test("a finished agent's row stays a status line: no report text, no file links", () => {
  const { $, doc, start, end, errors } = view();
  start(sid(1), { description: "Triage the rerun", agent_type: "critic" });
  end(sid(1), "finished", { duration_ms: 533000, tool_calls: 44, tokens: 972064,
    message: "## Frontend authenticated rerun: 37 failures\nFILES: reports/frontend-auth.log, "
      + "frontend/test-results/ (40 × error-context.md), frontend/tests/customer-360.spec.ts" });
  $("agents-pill").click();
  const row = doc.querySelector(`.am-row[data-agent-id="${sid(1)}"]`);
  assert.equal(row.querySelector(".am-meta").textContent, "Finished · 8m 53s · 972.1k tokens");
  assert.equal($("agent-map-body").querySelector(".agent-file, .agent-files"), null, "files live on the agent's card and page");
  assert.ok(!/##|FILES/.test($("agent-map-body").textContent), $("agent-map-body").textContent);
  assert.deepEqual(errors, []);
});

test("a failure reason on a row's label drops a markdown heading marker", () => {
  const { $, doc, start, end, errors } = view();
  start(sid(1));
  end(sid(1), "failed", { message: "## Could not reach the model\nHTTP 502", duration_ms: 1000, tool_calls: 0 });
  $("agents-pill").click();
  const row = doc.querySelector(`.am-row[data-agent-id="${sid(1)}"]`);
  assert.equal(row.querySelector(".am-meta").textContent, "Failed · 1s");
  assert.equal(row.title, `agent ${sid(1)}\nCould not reach the model`);
  assert.deepEqual(errors, []);
});

test("opening the map closes the menus; a click inside keeps it, the backdrop closes it, Sub-agent settings leaves it", () => {
  const { $, dom, start, posted, mapOpen, errors } = view();
  start(sid(1));
  $("btn-model").click();
  assert.equal($("modelmenu").hidden, false);
  $("agents-pill").click();
  assert.equal(mapOpen(), true);
  assert.equal($("modelmenu").hidden, true, "the model menu closed");
  $("agent-map-subtitle").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(mapOpen(), true, "a click inside the dialog keeps it open");
  $("agent-map").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(mapOpen(), false, "the backdrop closes it");
  $("agents-pill").click();
  $("agent-map-settings").click();
  assert.equal(mapOpen(), false);
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "slash" && m.action === "subagent"))),
    [{ type: "slash", action: "subagent" }],
    "it opens Settings ▸ Agents, as the dropdown's link did");
  assert.deepEqual(errors, []);
});

test("a row opens the agent's card and its transcript inside the map; the page still opens from the chat; Back and Escape return to the chat", () => {
  const { $, doc, dom, event, start, openTranscript, openPage, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: { description: "one" }, summary: "one" });
  start(sid(1), { call_id: "call_0", description: "one" });
  start(sid(2), { call_id: "never_on_screen", description: "two" });
  $("agents-pill").click();
  const first = doc.querySelector(`.am-row[data-agent-id="${sid(1)}"]`);
  assert.equal(first.getAttribute("aria-disabled"), null);
  assert.equal(doc.querySelector(`.am-row[data-agent-id="${sid(2)}"]`).getAttribute("aria-disabled"), null,
    "an agent without a task card opens too");
  first.click();
  assert.equal($("agent-card-title").textContent, "one", "the card first");
  $("agent-card-back").click();
  openTranscript(sid(2));
  assert.equal($("agent-transcript-title").textContent, "two", "and its transcript, without a task card");
  assert.ok(!doc.body.dataset.agentPage, "the map never navigates away");
  for (let i = 0; i < 3; i++) doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal($("agent-map").hidden, true, "three Escapes: transcript, card, map");
  openPage(sid(1));
  assert.equal(doc.body.dataset.agentPage, sid(1));
  assert.equal($("agent-page").hidden, false);
  assert.equal($("thread-title").textContent, "one");
  assert.equal($("agent-back").hidden, false);
  $("agent-back").click();
  assert.ok(!doc.body.dataset.agentPage);
  assert.equal($("agent-page").hidden, true);
  openPage(sid(2));
  assert.equal(doc.body.dataset.agentPage, sid(2));
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal($("agent-page").hidden, true);
  assert.deepEqual(errors, []);
});

test("Escape in Pips does not close the hidden ordinary specialist page", () => {
  const { $, doc, dom, send, start, openPage, errors } = view();
  start(sid(1));
  openPage(sid(1));
  assert.equal(doc.body.dataset.agentPage, sid(1));
  dom.window.DgcPips = {mount: () => ({setVisible() {}})};
  send({type:"pipsOpen"});
  const target = doc.createElement("button");
  $("pips-host").shadowRoot.append(target);
  let reachedPips = false;
  target.addEventListener("keydown", () => { reachedPips = true; });
  target.dispatchEvent(new dom.window.KeyboardEvent("keydown", {key:"Escape", bubbles:true, composed:true, cancelable:true}));
  assert.equal(reachedPips, true);
  assert.equal(doc.body.dataset.agentPage, sid(1));
  $("btn-pips-back").click();
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", {key:"Escape", bubbles:true, cancelable:true}));
  assert.equal($("agent-page").hidden, true);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test("an Escape that closes the map over an agent's page leaves the page open", () => {
  const { $, doc, dom, start, openPage, errors } = view();
  start(sid(1));
  openPage(sid(1));
  $("agents-pill").click();
  assert.equal($("agent-map").hidden, false);
  doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal($("agent-map").hidden, true);
  assert.equal(doc.body.dataset.agentPage, sid(1), "one Escape, one layer");
  assert.deepEqual(errors, []);
});

test("call_0 in two turns opens the right agent, and a nested card that arrives later still opens its agent", async () => {
  const { $, doc, event, start, openTranscript, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "first" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: {}, summary: "first" });
  start(sid(1), { call_id: "call_0", description: "first turn" });
  event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
  event({ type: "turn_start", turn_id: "t2", prompt: "second" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: {}, summary: "second" });
  start(sid(2), { call_id: "call_0", description: "second turn" });
  const cards = [...doc.querySelectorAll('.tool[data-tool-name="task"]')];
  assert.deepEqual(cards.map((card) => card.dataset.agentId), [sid(1), sid(2)]);

  // A parallel child's own task card replays after its agent already started.
  start(sid(3), { call_id: `${sid(2)}:c1`, parent_id: sid(2), depth: 2, description: "nested" });
  $("agents-pill").click();
  const nested = () => doc.querySelector(`.am-row[data-agent-id="${sid(3)}"]`);
  assert.equal(nested().getAttribute("aria-disabled"), null);
  event({ type: "tool_call", call_id: `${sid(2)}:c1`, name: "task", args: {}, summary: "nested" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  openTranscript(sid(2));
  assert.equal($("agent-transcript-title").textContent, "second turn");
  assert.ok($("agent-transcript-log").querySelector(`.agent-name[data-agent-id="${sid(3)}"]`),
    "the nested agent, its card claimed late, is on its parent's transcript");
  assert.deepEqual(errors, []);
});

test("restored records claim replayed cards newest to newest; history alone never shows the pill", async () => {
  const { doc, event, pill, errors } = view();
  const turn = (id, callId) => [
    { type: "turn_start", turn_id: id, prompt: "p", kind: "prompt" },
    { type: "tool_call", call_id: callId, name: "task", args: { description: id }, summary: id },
    { type: "tool_result", call_id: callId, name: "task", output: "Sub-task done", is_error: false },
    { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0 },
  ];
  event({ type: "history", items: [...turn("h1", "call_0"), ...turn("h2", "call_0")] });
  await Promise.resolve();
  assert.equal(pill().hidden, true, "task cards in history do not make agents");
  const restored = (n, state) => ({ id: sid(n), parent_id: null, call_id: "call_0", description: `r${n}`, depth: 1,
    state, tool_calls: 0, isolated: false, parallel: false, restored: true });
  event({ type: "agents", request_id: "agents-restore-1", items: [restored(1, "finished"), restored(2, "failed")],
    total: 2, active: 0 });
  const cards = [...doc.querySelectorAll('.tool[data-tool-name="task"]')];
  assert.deepEqual(cards.map((card) => card.dataset.agentId), [sid(1), sid(2)]);
  assert.deepEqual([pill().hidden, pill().label, pill().state], [false, "0 agents", "idle"],
    "the restored agents are the chat's: the pill is back, counting none working");
  assert.deepEqual(errors, []);
});

test("announcements: a batch speaks once when it starts and once when it ends; waiting and restores stay quiet", () => {
  const { doc, event, start, update, end, advance, errors } = view({ clock: true });
  const said = () => doc.getElementById("announcer").textContent;
  start(sid(1)); advance(200); start(sid(2)); advance(200); start(sid(3));
  assert.equal(said(), "", "debounced");
  advance(760);
  assert.equal(said(), "3 agents working");
  doc.getElementById("announcer").textContent = "";
  update(sid(1), { state: "waiting", waiting_for: "permission" });
  advance(800);
  assert.equal(said(), "", "waiting is announced by the approval card, not here");
  update(sid(1), { state: "running" });
  end(sid(1)); end(sid(2), "failed"); end(sid(3));
  advance(800);
  assert.equal(said(), "Agents finished: 2 finished, 1 failed");
  doc.getElementById("announcer").textContent = "";
  const running = (n) => ({ id: sid(n), parent_id: null, call_id: "c", description: "d", depth: 1, state: "running",
    tool_calls: 0, isolated: false, parallel: false, restored: false, elapsed_ms: 1000 });
  event({ type: "agents", request_id: "agents-restore-7", items: [running(4)], total: 4, active: 1 });
  advance(800);
  assert.equal(said(), "", "a restore snapshot does not speak");
  assert.deepEqual(errors, []);
});

test("a backend exit marks working agents stopped without a word; the new backend's snapshot wins", () => {
  const { $, dom, doc, send, event, start, pill, advance, mapOpen, agentRows, errors } = view({ clock: true });
  start(sid(1)); start(sid(2));
  advance(800);
  doc.getElementById("announcer").textContent = "";
  $("agents-pill").click();
  // A busy machine: the wall clock moves between any two reads. The agents stopped together all the same.
  const wallNow = dom.window.Date.now;
  let wall = wallNow.call(dom.window.Date);
  dom.window.Date.now = () => (wall += 3);
  try {
    send({ type: "backend_exit", code: 1, recovering: true, resumes: "offer" });
  } finally {
    dom.window.Date.now = wallNow;
  }
  assert.equal(pill().state, "idle");
  assert.equal(pill().label, "0 agents", "none working");
  assert.equal(mapOpen(), false, "the map closes");
  $("agents-pill").click();
  assert.deepEqual(agentRows().map((row) => [row.querySelector(".am-meta").textContent, row.title]),
    [["Stopped", `agent ${sid(1)}\nDGC's backend stopped`], ["Stopped", `agent ${sid(2)}\nDGC's backend stopped`]]);
  advance(1000);
  const said = doc.getElementById("announcer").textContent;
  assert.ok(!/agent/i.test(said), `no agents announcement (${said})`);
  event({ type: "agents", request_id: "agents-restore-2", items: [], total: 0, active: 0 });
  assert.equal(pill().hidden, true);
  assert.deepEqual(errors, []);
});

test("elapsed time counts from receipt, never from the backend's clock", () => {
  const { dom, doc, event, errors } = view();
  let now = 5000;
  dom.window.performance.now = () => now;
  event({ type: "agents", items: [{ id: sid(1), parent_id: null, call_id: "c", description: "slow", depth: 1,
    state: "running", tool_calls: 0, isolated: false, parallel: false, restored: false,
    started_at: 1, elapsed_ms: 61000 }], total: 1, active: 1 });
  doc.getElementById("agents-pill").click();
  const meta = () => doc.querySelector(`.am-row[data-agent-id="${sid(1)}"] .am-meta`).textContent;
  assert.equal(meta(), "1m 1s");
  now += 5000;
  event({ type: "agent_updated", id: sid(1), state: "running", tool_calls: 3 });
  assert.equal(meta(), "1m 6s");
  doc.querySelector(`.am-row[data-agent-id="${sid(1)}"]`).click();
  assert.match(doc.getElementById("agent-card-body").textContent, /1m 6s/);
  assert.match(doc.getElementById("agent-card-body").textContent, /Tool calls \(3\)/);
  assert.deepEqual(errors, []);
});

test("a queued agent that starts running restarts its clock; ended rows lead with their state", () => {
  const { dom, doc, start, update, end, agentRows, errors } = view();
  let now = 1;
  dom.window.performance.now = () => now;
  start(sid(1), { state: "queued", parallel: true, isolated: true });
  now = 9000;
  update(sid(1), { state: "running", model: "qwen3.8:27b" });
  start(sid(2));
  end(sid(2), "failed", { message: "the sub-agent stopped without a final summary", duration_ms: 48000, tool_calls: 9, tokens: 18200 });
  doc.getElementById("agents-pill").click();
  const rows = agentRows();
  assert.equal(rows[0].querySelector(".am-meta").textContent, "qwen3.8:27b", "0s is not said");
  assert.equal(rows[1].querySelector(".am-meta").textContent, "Failed · 48s · 18.2k tokens");
  assert.equal(rows[1].title, `agent ${sid(2)}\nthe sub-agent stopped without a final summary`, "the reason is on the row's label");
  assert.deepEqual(errors, []);
});

test("panel.ts restores the list on reload and after a backend handshake, with no opt-in field", () => {
  // A reloaded webview and a switch to another chat both repaint through one routine, so that is
  // where the restore lives; webviewReady must still reach it.
  const ready = panelSrc.slice(panelSrc.indexOf('case "webviewReady": {'));
  const readyBlock = ready.slice(0, ready.indexOf("break;"));
  assert.match(readyBlock, /this\.repaintFromBackend\(\);/);
  const repaint = panelSrc.slice(panelSrc.indexOf("private repaintFromBackend("));
  const repaintBlock = repaint.slice(0, repaint.indexOf("\n  }\n"));
  assert.match(repaintBlock, /capabilities\?\.agents\)\s*\{\s*be\.send\(\{ type: "list_agents", request_id: this\.nextRequestId\("agents-restore"\) \}\);/);
  const handshake = panelSrc.slice(panelSrc.indexOf("private finishSessionHandshake("));
  const handshakeBlock = handshake.slice(0, handshake.indexOf("\n  }\n"));
  assert.match(handshakeBlock, /capabilities\?\.agents\)\s*\{\s*be\.send\(\{ type: "list_agents", request_id: this\.nextRequestId\("agents-restore"\) \}\);/);
  // The CLI pushes background shells only to a client that has asked for them once: the pill
  // counts them, so the handshake asks, not the map's first opening.
  assert.match(handshakeBlock, /if \(this\.backgroundTasks\(\)\) \{\s*be\.send\(\{ type: "list_background_shells", request_id: this\.nextRequestId\("shells-restore"\) \} as any\);/);
  const roots = [...panelSrc.matchAll(/type: "set_workspace_roots"[^}]*\}/g)].map((m) => m[0]);
  assert.ok(roots.length > 0);
  for (const command of roots) assert.doesNotMatch(command, /\bagents\s*:/);
  assert.doesNotMatch(panelSrc, /agents:\s*true/);
});

test("the palette clears 3:1 and forced colours keep each state distinct", () => {
  const section = mainCss.slice(mainCss.indexOf("/* ---- 0.40 agents -"), mainCss.indexOf("/* ---- end 0.40 agents -"));
  const hex = (block, name) => block.match(new RegExp(`${name}:\\s*(#[0-9A-F]{6})`, "i"))?.[1];
  const dark = section.match(/:root \{([^}]*)\}/)[1], light = section.match(/body\.vscode-light[^{]*\{([^}]*)\}/)[1];
  const root = mainCss.match(/:root\s*\{([\s\S]*?)\}/)[1];
  for (const token of ["--agent-run", "--agent-wait"]) {
    for (const bg of ["--fallback-bg", "--fallback-surface"]) {
      assert.ok(contrastRatio(hex(dark, token), hex(root, bg)) >= 3, `${token} on ${bg}`);
    }
    for (const bg of ["#FFFFFF", "#F3F3F3"]) assert.ok(contrastRatio(hex(light, token), bg) >= 3, `light ${token} on ${bg}`);
  }
  const forced = section.slice(section.indexOf("@media (forced-colors: active)"));
  for (const state of ["running", "waiting", "idle"]) assert.match(forced, new RegExp(`\\.agents-pill\\[data-state="${state}"\\] \\.agents-dot`));
  assert.match(forced, /\.agents-need \{[^}]*text-decoration: underline/);
  assert.match(section, /\.cf-right > \.picker\.agents-picker \{ flex: 0 0 auto; min-width: auto; \}/);
  assert.match(mainCss, /@media \(max-width: 420px\) \{[\s\S]*?\.agents-text, \.agents-need \{ display: none; \}\s*\.agents-pill \.agents-short \{ display: inline; \}/);
  assert.match(section, /\.agents-short \{ display: none; \}/, "the total is the narrow footer's alone");
  assert.match(section, /prefers-reduced-motion: reduce\) \{ \.tool\.flash \{ animation: none; \} \}/);
});

// ---- review fixes -----------------------------------------------------------------------------
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

test("after a rewind in a chat whose task calls all share call_0, each row jumps to its own card (one task per frame)", async () => {
  const { $, doc, event, errors } = view();
  const liveTurn = (n) => [
    { type: "turn_start", turn_id: `t${n}`, prompt: `p${n}` },
    { type: "tool_call", call_id: "call_0", name: "task", args: { description: `turn${n}` }, summary: `turn${n}` },
    { type: "agent_started", id: sid(n + 1), parent_id: null, call_id: "call_0", description: `turn${n}`, depth: 1,
      state: "running", started_at: 100 + n, isolated: false, parallel: false },
    { type: "agent_ended", id: sid(n + 1), state: "finished", duration_ms: 500, tool_calls: 1 },
    { type: "tool_result", call_id: "call_0", name: "task", output: `Sub-task 'turn${n}' completed.`, is_error: false },
    { type: "turn_end", turn_id: `t${n}`, reason: "completed", token_estimate: 0 },
  ];
  for (const frame of [0, 1, 2].flatMap(liveTurn)) { event(frame); await nextTask(); }
  assert.deepEqual([...doc.querySelectorAll('.tool[data-tool-name="task"]')].map((card) => card.dataset.agentId),
    [sid(1), sid(2), sid(3)], "live: each turn's record holds its own card");

  // Rewind to before turn 2: the rewound frame, the history of turns 0 and 1, then the snapshot —
  // each delivered in its own task, as VS Code does, so the history's microtasks run in between.
  event({ type: "rewound", ok: true, message_count: 9 });
  await nextTask();
  event({ type: "history", items: [0, 1].flatMap((n) => liveTurn(n).filter((f) => !f.type.startsWith("agent_"))) });
  await nextTask();
  const kept = (n) => ({ id: sid(n + 1), parent_id: null, call_id: "call_0", description: `turn${n}`, depth: 1,
    state: "finished", tool_calls: 1, duration_ms: 500, started_at: 100 + n, isolated: false, parallel: false, restored: false });
  event({ type: "agents", items: [kept(0), kept(1)], total: 2, active: 0 });
  await nextTask();

  const cards = [...doc.querySelectorAll('.tool[data-tool-name="task"]')];
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((card) => card.dataset.agentId), [sid(1), sid(2)]);
  assert.equal(pillWords($("agents-pill")), "0 agents", "the kept agents are the chat's; none is working");
  for (const [index, card] of cards.entries()) {
    card.querySelector(".tool-toggle").click();
    assert.match(card.textContent, new RegExp(`turn${index}`));
  }
  assert.deepEqual(errors, []);
});

test("a rewind in a chat with no agents holds nothing back, so a later agent still claims its card", async () => {
  const { doc, event, start, errors } = view();
  event({ type: "rewound", ok: true, message_count: 0 });
  await nextTask();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: {}, summary: "one" });
  start(sid(1), { call_id: "call_0" });
  assert.equal(doc.querySelector('.tool[data-tool-name="task"]').dataset.agentId, sid(1));
  assert.deepEqual(errors, []);
});

test("the map updates rows in place: a live render keeps the focused node, its label and its click", async () => {
  const { $, doc, dom, start, update, end, frame, agentRows, errors } = view();
  start(sid(1), { description: "one" });
  start(sid(2), { description: "two" });
  $("agents-pill").click();
  const rows = agentRows();
  rows[1].focus();
  let focusins = 0, removed = 0;
  doc.addEventListener("focusin", () => { focusins += 1; });
  new dom.window.MutationObserver((records) => {
    for (const r of records) removed += [...r.removedNodes].filter((n) => n.nodeType === 1).length;
  })
    .observe($("agent-map-tree"), { childList: true, subtree: true });
  update(sid(2), { state: "running", activity: "reading files" });
  update(sid(1), { state: "waiting", waiting_for: "permission" });
  await frame();
  end(sid(2), "failed", { message: "boom" });
  await frame();
  start(sid(3), { description: "three" });
  await frame();
  const after = agentRows();
  assert.equal(after[0], rows[0], "the same row node");
  assert.equal(after[2], rows[1], "the same row node, below the new working agent");
  assert.equal(doc.activeElement, rows[1], "focus never left the row");
  assert.equal(focusins, 0, "no focus event re-fired");
  assert.equal(removed, 0, "no row or item element was removed (only text changed)");
  assert.equal(after.length, 3);
  assert.equal(rows[0].querySelector(".am-meta").textContent.split(" · ")[0], "Waiting for your permission");
  assert.equal(rows[1].querySelector(".agent-dot").dataset.state, "failed");
  assert.deepEqual([...doc.querySelectorAll("#agent-map-tree .am-row")].map((row) => row.tabIndex), [-1, -1, -1, 0],
    "one tab stop, on the focused row");
  assert.deepEqual(errors, []);
});

test("a snapshot mid-batch keeps agents that already ended in the batch's 'finished' announcement", () => {
  const { doc, event, start, end, advance, errors } = view({ clock: true });
  const said = () => doc.getElementById("announcer").textContent;
  start(sid(1)); start(sid(2));
  advance(800);
  assert.equal(said(), "2 agents working");
  end(sid(1), "failed", { message: "x" });
  const item = (n, state) => ({ id: sid(n), parent_id: null, call_id: `call_${n}`, description: `agent ${n}`, depth: 1,
    state, tool_calls: 0, isolated: false, parallel: false, restored: false, ...(state === "running" ? { elapsed_ms: 10 } : {}) });
  event({ type: "agents", request_id: "agents-7", items: [item(1, "failed"), item(2, "running")], total: 2, active: 1 });
  end(sid(2), "stopped");
  advance(800);
  assert.equal(said(), "Agents finished: 1 failed, 1 stopped");
  assert.deepEqual(errors, []);
});

test("a long multi-line failure message: one bounded line on the row's label, all of it on the card", () => {
  const { $, doc, start, end, errors } = view();
  start(sid(1), { description: "one" });
  const first = `HTTP 401 from http://127.0.0.1:5101/v1/chat/completions: {"error": {"message": "denied ${"x".repeat(200)}"}}`;
  end(sid(1), "failed", { message: `${first}\n  → the endpoint rejected the key`, duration_ms: 1000, tool_calls: 0 });
  start(sid(2), { description: "two" });
  end(sid(2), "failed", { message: `${"y".repeat(110)} [REDACTED] tail`, duration_ms: 1000, tool_calls: 0 });
  $("agents-pill").click();
  const row = doc.querySelector(`.am-row[data-agent-id="${sid(1)}"]`);
  const marked = doc.querySelector(`.am-row[data-agent-id="${sid(2)}"]`);
  assert.equal(row.querySelector(".am-meta").textContent, "Failed · 1s", "the row says the state, never the reason");
  const [name, reason] = row.title.split("\n");
  assert.equal(name, "one");
  assert.ok(reason.startsWith("HTTP 401 from http://127.0.0.1:5101/v1/chat/completions: "), reason);
  assert.ok(reason.endsWith("…"), reason);
  assert.ok(!row.title.includes("rejected the key"), "only the first line");
  assert.ok(reason.length <= 120, `bounded (${reason.length})`);
  assert.ok(!/\[REDA(?!CTED\])/.test(marked.title), "never half a redaction marker");
  row.click();
  assert.equal(doc.querySelector("#agent-card-body .am-failure").textContent, `${first}\n  → the endpoint rejected the key`,
    "the card has the whole message");
  assert.match(mainCss, /\.am-desc, \.am-meta \{[^}]*text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.deepEqual(errors, []);
});

test("the pill's probe answers only the host bridge's nonce, and panel.ts keeps it out of the message switch", () => {
  const { send, posted, start, errors } = view();
  start(sid(1));
  send({ type: "agentsProbe" });
  send({ type: "agentsProbe", probe: "not-a-nonce" });
  assert.deepEqual(posted.filter((m) => m.type === "agentsProbeResult"), []);
  const probe = "0123456789abcdef0123456789abcdef";
  send({ type: "agentsProbe", probe });
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "agentsProbeResult"))),
    [{ type: "agentsProbeResult", probe, hidden: false, state: "running", label: "1 agent" }]);
  const onMessage = panelSrc.slice(panelSrc.indexOf("private async onMessage("));
  assert.doesNotMatch(onMessage.slice(0, onMessage.indexOf("\n  }\n")), /agentsProbe/);
  const reply = panelSrc.slice(panelSrc.indexOf("private testOnlyWebviewReply("));
  assert.match(reply.slice(0, reply.indexOf("\n  }\n")), /if \(!process\.env\.DGC_EXTENSION_TEST_TOKEN \|\| msg\?\.type !== "agentsProbeResult"\) return false;/);
  // The ordering is the invariant, not the exact adjacency: the probe reply must be intercepted
  // before anything dispatches into the switch. Asserting positions rather than "these two lines
  // touch" lets an unrelated early return (the liveness heartbeat) be added without loosening it.
  const listener = panelSrc.slice(panelSrc.indexOf("onDidReceiveMessage((msg) => {"));
  const body = listener.slice(0, listener.indexOf("\n      });"));
  assert.ok(body.includes("if (this.testOnlyWebviewReply(msg)) return;"),
    "the listener must intercept the probe reply itself");
  assert.ok(body.indexOf("this.testOnlyWebviewReply(msg)") < body.indexOf("this.onMessage("),
    "and it must do so before the message reaches the switch");
  assert.deepEqual(errors, []);
});


test("failed and finished agents stay on the map for the whole chat, across turns", () => {
  const { $, event, start, end, advance, pill, agentRows, errors } = view({ clock: true });
  start(sid(1)); start(sid(2)); end(sid(1)); end(sid(2), "failed");
  assert.equal(pill().label, "0 agents");
  advance(60000);
  assert.equal(pill().hidden, false, "a clock tick does not drop them");
  event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
  assert.equal(pill().hidden, false, "nor does the turn ending");
  start(sid(3));
  assert.equal(pill().label, "1 agent", "the next turn counts its working agent");
  $("agents-pill").click();
  assert.deepEqual(agentRows().map((row) => row.dataset.agentId), [sid(3), sid(2), sid(1)],
    "and the map still lists the earlier turn's agents");
  assert.deepEqual(errors, []);
});

// ---- background tasks on the pill ------------------------------------------------------------
// The pill says what runs now: the agents working and the background tasks the map lists, counted
// from the map's own list -- "2 agents", "2 tasks", "1 agent · 2 tasks". Where the footer is narrow
// only the total running is left (`.agents-short`); the label says it in words.
const TASKS_READY = { type: "ready", model: "m", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1,
  capabilities: { agents: true, agent_control: true, monitors: true, troupe: true, background_tasks: { version: 1 } } };
const secondsAgo = (s) => Date.now() / 1000 - s;
const monitor = (id, state = "running") => ({ id, description: `watch ${id}`, command: "tail -f log", state, events: 0,
  pending_events: 0, persistent: true, timeout_ms: 0, started_at: Math.floor(secondsAgo(60)),
  ...(state === "running" ? {} : { end_reason: "exited", exit_code: 0 }) });
const shell = (id, state = "running") => ({ id, command: `npm run ${id}`, state, started_at: secondsAgo(30),
  ended_at: state === "running" ? null : secondsAgo(1), exit_code: state === "exited" ? 0 : null, agent_id: null });
const troupe = (state) => ({ type: state === "running" ? "troupe_started" : "troupe_finished", run_id: "tr-0123456789",
  title: "Review every handler", state, reason: "", stages: [{ name: "review", total: 2, done: state === "running" ? 0 : 2,
    failed: 0, kept: 0 }], agents_planned: 2, reused: 0, journal: ".dgc/troupes/tr-0123456789" });
const preview = (id) => ({ type: "artifact_ready", id, name: `${id} preview`, url: `http://127.0.0.1:8765/?a=${id}`, rel: id });
function tasksView(options, ready = TASKS_READY) {
  const v = view(options);
  v.event(ready);
  const monitors = (...items) => v.event({ type: "monitors", wake_paused: false, pending_events: 0, items });
  const shells = (...items) => v.event({ type: "background_shells", items });
  const short = () => v.$("agents-pill").querySelector(".agents-short")?.textContent ?? null;
  // Pip runs come from the Pips bundle's run cards; this stands in for them the way agent-map.test.mjs does.
  const runs = [];
  let pipOptions = null;
  v.dom.window.DgcPips = { mountSetupCards: (o) => { pipOptions = o; return { toolResult() { o.onRunsChange(); }, finish() {},
    reset() { runs.length = 0; }, receive() {}, runs: () => runs, openRun() {} }; } };
  v.doc.documentElement.dataset.pipsDocumentId = "doc1";
  const pipRun = (n) => {
    runs.push({ id: `run_${String(n).repeat(32)}`, pipId: `pip_${"a".repeat(32)}`, name: `Pip ${n}`, status: "running",
      label: "Working", detail: "", active: true });
    v.event({ type: "tool_call", call_id: `pip_${n}`, name: "run_pip_now", args: {}, summary: "" });
    v.event({ type: "tool_result", call_id: `pip_${n}`, name: "run_pip_now", output: "{}", is_error: false });
  };
  const pipRunsChanged = () => pipOptions.onRunsChange();
  return { ...v, monitors, shells, short, runs, pipRun, pipRunsChanged };
}

test("a chat that never had an agent shows the pill while a task runs, in words, and hides it when the last one ends", () => {
  const { monitors, shells, pill, short, errors } = tasksView();
  assert.equal(pill().hidden, true, "nothing has run");
  monitors(monitor("mon1"), monitor("mon2"));
  assert.deepEqual(pill(), { hidden: false, state: "running", label: "2 tasks", need: false,
    title: `2 background tasks running · ${PILL_HINT}`, aria: `2 tasks · 2 background tasks running · ${PILL_HINT}` });
  assert.equal(short(), "2");
  monitors(monitor("mon1"), monitor("mon2", "ended"));
  assert.deepEqual([pill().label, pill().title], ["1 task", `1 background task running · ${PILL_HINT}`]);
  shells(shell("bg3"));
  assert.equal(pill().label, "2 tasks", "a background shell counts like a monitor");
  shells(shell("bg3", "exited"));
  monitors();
  assert.equal(pill().hidden, true, "no agent ever and nothing running: no pill");
  assert.deepEqual(errors, []);
});

test("agents and tasks together read \"1 agent · 2 tasks\"; waiting beats running; once nothing runs it is \"0 agents\"", () => {
  const { start, update, end, monitors, shells, pill, short, errors } = tasksView();
  start(sid(1));
  monitors(monitor("mon1"));
  shells(shell("bg3"));
  assert.deepEqual(pill(), { hidden: false, state: "running", label: "1 agent · 2 tasks", need: false,
    title: `1 agent working and 2 background tasks running · ${PILL_HINT}`,
    aria: `1 agent · 2 tasks · 1 agent working and 2 background tasks running · ${PILL_HINT}` });
  assert.equal(short(), "3", "the narrow footer's total is everything running");
  update(sid(1), { state: "waiting", waiting_for: "permission" });
  assert.deepEqual([pill().state, pill().need, pill().label], ["waiting", true, "1 agent · 2 tasks"]);
  assert.equal(pill().title, `An agent is waiting for your permission · 2 background tasks running · ${PILL_HINT}`);
  assert.equal(pill().aria, `1 agent · 2 tasks · An agent is waiting for your permission · 2 background tasks running · ${PILL_HINT}`);
  update(sid(1), { state: "waiting", waiting_for: "answer" });
  assert.equal(pill().title, `An agent is waiting for your answer · 2 background tasks running · ${PILL_HINT}`);
  update(sid(1), { state: "running" });
  end(sid(1));
  assert.deepEqual([pill().state, pill().label, pill().title], ["running", "2 tasks", `2 background tasks running · ${PILL_HINT}`],
    "the agent ended; the tasks keep the dot green");
  assert.equal(short(), "2");
  shells(shell("bg3", "killed"));
  monitors();
  assert.deepEqual(pill(), { hidden: false, state: "idle", label: "0 agents", need: false,
    title: `No agents working · ${PILL_HINT}`, aria: `0 agents · No agents working · ${PILL_HINT}` }, "the chat had an agent: the pill stays");
  assert.equal(short(), "0");
  assert.deepEqual(errors, []);
});

test("every kind of task changes the pill as it starts and as it ends: monitors, shells, troupes, previews, Pip runs", () => {
  const { event, send, monitors, shells, pill, runs, pipRun, pipRunsChanged, errors } = tasksView();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  const kinds = [
    ["a monitor", () => monitors(monitor("mon1")), () => monitors(monitor("mon1", "ended"))],
    ["a background shell", () => shells(shell("bg3")), () => shells(shell("bg3", "exited"))],
    ["a troupe", () => event(troupe("running")), () => event(troupe("done"))],
    ["a preview", () => event(preview("art1")), () => send({ type: "artifact_stop_state", id: "art1", state: "stopped" })],
    ["a listed preview", () => event({ type: "artifacts", request_id: "artifacts-1", items: [{ id: "art2", name: "p",
      url: "http://127.0.0.1:8765/?a=art2", rel: "p", uptime: "1s" }] }), () => event({ type: "artifacts", request_id: "artifacts-2", items: [] })],
    ["a Pip run", () => pipRun(1), () => { runs[0].active = false; pipRunsChanged(); }],
  ];
  for (const [kind, startTask, endTask] of kinds) {
    startTask();
    assert.deepEqual([pill().hidden, pill().state, pill().label], [false, "running", "1 task"], `${kind} started`);
    endTask();
    assert.equal(pill().hidden, true, `${kind} ended`);
  }
  // A rewind takes the Pip runs' lines with the transcript, and the pill stops counting them.
  pipRun(2);
  assert.equal(pill().label, "1 task");
  event({ type: "rewound", ok: true, message_count: 0 });
  assert.equal(pill().hidden, true, "the rewound chat's Pip run is gone");
  assert.deepEqual(errors, []);
});

test("the pill and the map count the same tasks, live while the map is open; so does the main agent's card", () => {
  const { $, doc, event, send, start, end, monitors, shells, pill, errors } = tasksView();
  const pillTasks = () => Number(/(\d+) tasks?$/.exec(pill().label)?.[1] || 0);
  start(sid(1));
  $("agents-pill").click();
  const agree = (n, why) => {
    assert.equal(pillTasks(), n, `the pill: ${why}`);
    assert.equal($("agent-map-task-list").querySelectorAll(".am-row").length, n, `the map: ${why}`);
    assert.equal($("agent-map-tasks").hidden, n === 0);
    if (n) assert.equal($("agent-map-tasks-title").textContent, `${n} background task${n === 1 ? "" : "s"} · click a task for details`);
  };
  agree(0, "nothing in the background");
  monitors(monitor("mon1"), monitor("mon2", "ended")); agree(1, "the running monitor, not the ended one");
  shells(shell("bg3"), shell("bg4", "exited")); agree(2, "and the running shell");
  event(troupe("running")); agree(3, "and the troupe");
  event(preview("art1")); agree(4, "and the preview");
  doc.querySelector('#agent-map .am-row[data-am-key="root"]').click();
  assert.match($("agent-card-body").textContent, /4 background tasks running/, "the main agent's card says the same number");
  $("agent-card-back").click();
  end(sid(1)); agree(4, "an agent ending changes no task");
  assert.equal(pill().label, "4 tasks");
  send({ type: "artifact_stop_state", id: "art1", state: "stopped" }); agree(3, "the preview stopped");
  event(troupe("done")); agree(2, "the troupe finished");
  shells(); agree(1, "the shell is gone");
  monitors(); agree(0, "the monitor is gone");
  assert.equal(pill().label, "0 agents");
  assert.deepEqual(errors, []);
});

test("a CLI without background_tasks: its shells are on neither the pill nor the map", () => {
  const { $, monitors, shells, pill, errors } = tasksView({}, { ...TASKS_READY, capabilities: { agents: true, monitors: true } });
  shells(shell("bg3"));
  assert.equal(pill().hidden, true, "an older CLI's shells event is ignored");
  monitors(monitor("mon1"));
  assert.equal(pill().label, "1 task");
  $("agents-pill").click();
  assert.equal($("agent-map-task-list").querySelectorAll(".am-row").length, 1);
  assert.deepEqual(errors, []);
});

test("a new chat, a cleared one and a chat switch take the old chat's running tasks off the pill", () => {
  for (const reset of [
    (p) => p.event({ type: "session", kind: "new", message_count: 0, session_id: "s2" }),
    (p) => p.event({ type: "session", kind: "cleared", message_count: 0, session_id: "s3" }),
    (p) => p.send({ type: "chat_switched", slotId: "slot-2", label: "Other chat" }),
  ]) {
    const p = tasksView();
    p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
    p.monitors(monitor("mon1"));
    p.shells(shell("bg3"));
    p.event(troupe("running"));
    p.event(preview("art1"));
    p.pipRun(1);
    assert.equal(p.pill().label, "5 tasks");
    reset(p);
    assert.equal(p.pill().hidden, true, "none of them is this chat's");
    assert.deepEqual(p.errors, []);
  }
});
