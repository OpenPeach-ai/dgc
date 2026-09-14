// The agents indicator in the webview: the "● 2 agents" pill (Claude Code's counting rule), its
// dialog, row jumps to each agent's task card, announcements, chat boundaries and backend exits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, mainCss, makeDom, panelSrc } from "./support/webview-dom.mjs";

const PILL_HINT = "Click to see the agents";

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
    label: $("agents-pill").querySelector(".agents-label").textContent.replace(/ · needs you$/, ""),
    title: $("agents-pill").title, aria: $("agents-pill").getAttribute("aria-label"),
    need: !$("agents-pill").querySelector(".agents-need").hidden,
  });
  const frame = () => new Promise((resolve) => v.dom.window.requestAnimationFrame(() => resolve()));
  return { ...v, event, $, start, update, end, pill, frame };
}

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;

test("the pill counts every agent of the chat and its dot says whether any is working", () => {
  const { start, update, end, pill, errors } = view();
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
  end(sid(1)); end(sid(2));
  assert.deepEqual(pill(), { hidden: false, state: "idle", label: "2 agents", need: false,
    title: `No agents working · ${PILL_HINT}`, aria: `2 agents · No agents working · ${PILL_HINT}` });
  start(sid(3));
  assert.equal(pill().label, "3 agents");
  assert.equal(pill().state, "running");
  assert.equal(pill().title, `Agents are working (1 of 3 working) · ${PILL_HINT}`);
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

test("a new chat hides the pill and closes its dialog; a fork keeps it; a big snapshot counts past its items", () => {
  const { $, doc, event, start, pill, errors } = view();
  start(sid(1));
  $("agents-pill").click();
  assert.equal($("agentsmenu").hidden, false);
  event({ type: "session", kind: "new", message_count: 0, session_id: "s2" });
  assert.equal(pill().hidden, true, "the wrapper carries hidden");
  assert.equal($("agentsmenu").hidden, true);
  assert.equal(doc.activeElement, $("input"), "focus goes back to the prompt");

  const items = Array.from({ length: 64 }, (_, i) => ({ id: sid(100 + i), parent_id: null, call_id: `c${i}`,
    description: `a${i}`, depth: 1, state: "finished", tool_calls: 1, isolated: false, parallel: false,
    restored: false, duration_ms: 1000 }));
  event({ type: "agents", items, total: 70, active: 0 });
  assert.equal(pill().label, "70 agents");
  $("agents-pill").click();
  assert.equal($("agents-more").hidden, false);
  assert.equal($("agents-more").textContent, "+6 more not listed");
  event({ type: "session", kind: "forked", message_count: 3, session_id: "s3" });
  assert.equal(pill().label, "70 agents", "a branch is the same conversation");
  event({ type: "session", kind: "cleared", message_count: 0, session_id: "s4" });
  assert.equal(pill().hidden, true);
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
  assert.equal(button.getAttribute("aria-controls"), "agentsmenu");
  assert.equal($("agentsmenu").getAttribute("role"), "dialog");
  assert.equal($("agentsmenu").getAttribute("aria-labelledby"), "agents-title");
  const rail = [...$("composer-rail").children].map((node) => node.id);
  assert.ok(!rail.includes("agents-picker"), "not a composer-rail row");
});

test("the dialog lists agents as a nested list, is keyboard driven, and Esc never stops the turn", async () => {
  const { $, doc, dom, start, update, posted, frame, errors } = view();
  start(sid(1), { description: "review auth module", agent_type: "reviewer" });
  start(sid(2), { description: "<img src=x onerror=alert(1)>", parent_id: sid(1), depth: 2, call_id: `${sid(1)}:c1` });
  start(sid(3), { description: "write migration" });
  $("agents-pill").click();
  assert.equal($("agents-pill").getAttribute("aria-expanded"), "true");
  assert.match($("agents-summary").textContent, /^3 agents · 3 working/);
  const rows = [...doc.querySelectorAll("#agents-tree .agent-row")];
  assert.equal(rows.length, 3);
  assert.equal(doc.activeElement, rows[0], "focus moves to the first row");
  const nested = doc.querySelector("#agents-tree > li > ul > li > .agent-row");
  assert.equal(nested.dataset.agentId, sid(2), "a child sits in a list nested inside its parent's item");
  assert.equal(nested.querySelector(".agent-desc").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(doc.querySelector("#agents-tree img"), null, "descriptions are text");
  assert.match(rows[0].querySelector(".agent-meta").textContent, /^reviewer · \d+s$/);
  assert.equal($("agents-stop-note").hidden, false);

  const key = (target, name) => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  key(doc.activeElement, "ArrowDown");
  assert.equal(doc.activeElement.dataset.agentId, sid(2));
  key(doc.activeElement, "End");
  assert.equal(doc.activeElement.dataset.agentId, sid(3));
  key(doc.activeElement, "Home");
  assert.equal(doc.activeElement.dataset.agentId, sid(1));
  key(doc.activeElement, "ArrowUp");
  assert.equal(doc.activeElement.dataset.agentId, sid(1), "stays on the first row");
  update(sid(3), { state: "waiting", waiting_for: "permission" });
  await frame();
  assert.equal(doc.activeElement.dataset.agentId, sid(1), "a live re-render keeps the focused row");

  // Esc with a turn running: the dialog closes and focus returns to the pill; nothing is posted.
  $("input").focus();
  doc.getElementById("send").dataset.mode = "default";
  $("agents-pill").click();
  const before = posted.length;
  const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  doc.activeElement.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal($("agentsmenu").hidden, true);
  assert.equal(doc.activeElement, $("agents-pill"));
  assert.deepEqual(posted.slice(before), [], "no cancel, no stop");

  // Tab out of the dialog closes it; moving between its own controls does not.
  $("agents-pill").click();
  $("agents-settings").focus();
  assert.equal($("agentsmenu").hidden, false);
  $("input").focus();
  assert.equal($("agentsmenu").hidden, true);
  assert.deepEqual(errors, []);
});

test("the model menu and the agents dialog close each other, and an outside click closes it", () => {
  const { $, doc, dom, start, errors } = view();
  start(sid(1));
  $("agents-pill").click();
  $("btn-model").click();
  assert.equal($("agentsmenu").hidden, true);
  assert.equal($("modelmenu").hidden, false);
  $("agents-pill").click();
  assert.equal($("agentsmenu").hidden, false);
  assert.equal($("modelmenu").hidden, true);
  $("agents-summary").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal($("agentsmenu").hidden, false, "a click inside the dialog keeps it open");
  $("log").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal($("agentsmenu").hidden, true);
  $("agents-pill").click();
  $("agents-settings").click();
  assert.equal($("agentsmenu").hidden, true);
  void doc;
  assert.deepEqual(errors, []);
});

test("a row jumps to its task card, opening a folded group; a missing card disables the row", () => {
  const { $, doc, event, start, errors, advance } = view({ clock: true });
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: { description: "one" }, summary: "one" });
  start(sid(1), { call_id: "call_0" });
  start(sid(2), { call_id: "never_on_screen" });
  const card = doc.querySelector('.tool[data-tool-name="task"]');
  assert.equal(card.dataset.agentId, sid(1), "the card is claimed when its agent starts");
  card.closest(".tool-group").open = false;
  $("agents-pill").click();
  const [first, second] = doc.querySelectorAll("#agents-tree .agent-row");
  assert.equal(first.getAttribute("aria-disabled"), null);
  assert.equal(second.getAttribute("aria-disabled"), "true");
  assert.equal(second.title, "This agent's task is not on screen");
  second.click();
  assert.equal($("agentsmenu").hidden, false, "a disabled row does nothing");
  first.click();
  assert.equal($("agentsmenu").hidden, true);
  assert.equal(card.closest(".tool-group").open, true);
  assert.ok(card.classList.contains("flash"));
  assert.equal(doc.activeElement, card.querySelector(".tool-toggle"));
  advance(1300);
  assert.ok(!card.classList.contains("flash"), "the flash lasts 1.2 s");
  assert.deepEqual(errors, []);
});

test("call_0 in two turns jumps to the right card, and a nested card that arrives later enables its row", async () => {
  const { $, doc, event, start, errors } = view();
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
  const nested = () => doc.querySelector(`.agent-row[data-agent-id="${sid(3)}"]`);
  assert.equal(nested().getAttribute("aria-disabled"), "true");
  event({ type: "tool_call", call_id: `${sid(2)}:c1`, name: "task", args: {}, summary: "nested" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(nested().getAttribute("aria-disabled"), null, "the replayed card enables the row");
  doc.querySelector(`.agent-row[data-agent-id="${sid(2)}"]`).click();
  assert.equal(doc.activeElement, cards[1].querySelector(".tool-toggle"));
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
  assert.equal(pill().label, "2 agents");
  assert.equal(pill().state, "idle");
  doc.getElementById("agents-pill").click();
  assert.deepEqual([...doc.querySelectorAll(".agent-meta")].map((node) => node.textContent), ["Finished", "Failed"],
    "restored rows show only their state");
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
  const { $, doc, send, event, start, pill, advance, errors } = view({ clock: true });
  start(sid(1)); start(sid(2));
  advance(800);
  doc.getElementById("announcer").textContent = "";
  $("agents-pill").click();
  send({ type: "backend_exit", code: 1, recovering: true, resumes: "offer" });
  assert.equal(pill().state, "idle");
  assert.equal(pill().label, "2 agents");
  assert.equal($("agentsmenu").hidden, true, "the dialog closes");
  $("agents-pill").click();
  assert.deepEqual([...doc.querySelectorAll(".agent-meta")].map((node) => node.textContent),
    ["Stopped · DGC's backend stopped", "Stopped · DGC's backend stopped"]);
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
  assert.equal(doc.querySelector(".agent-meta").textContent, "1m 1s");
  now += 5000;
  event({ type: "agent_updated", id: sid(1), state: "running", tool_calls: 3 });
  return new Promise((resolve) => dom.window.requestAnimationFrame(() => {
    assert.equal(doc.querySelector(".agent-meta").textContent, "1m 6s · 3 tools");
    assert.deepEqual(errors, []);
    resolve();
  }));
});

test("a queued agent that starts running restarts its clock; ended rows lead with their state", () => {
  const { dom, doc, event, start, update, end, errors } = view();
  let now = 0;
  dom.window.performance.now = () => now;
  start(sid(1), { state: "queued", parallel: true, isolated: true });
  now = 9000;
  update(sid(1), { state: "running", model: "qwen3.8:27b" });
  start(sid(2));
  end(sid(2), "failed", { message: "the sub-agent stopped without a final summary", duration_ms: 48000, tool_calls: 9, tokens: 18200 });
  doc.getElementById("agents-pill").click();
  const metas = [...doc.querySelectorAll(".agent-meta")].map((node) => node.textContent);
  assert.equal(metas[0], "qwen3.8:27b · 0s");
  assert.equal(metas[1], "Failed · the sub-agent stopped without a final summary · 48s · 9 tools · 18,200 tokens");
  void event;
  assert.deepEqual(errors, []);
});

test("panel.ts restores the list on reload and after a backend handshake, with no opt-in field", () => {
  const ready = panelSrc.slice(panelSrc.indexOf('case "webviewReady": {'));
  const readyBlock = ready.slice(0, ready.indexOf("break;"));
  assert.match(readyBlock, /capabilities\?\.agents\)\s*\{\s*be\.send\(\{ type: "list_agents", request_id: this\.nextRequestId\("agents-restore"\) \}\);/);
  const handshake = panelSrc.slice(panelSrc.indexOf("private finishSessionHandshake("));
  const handshakeBlock = handshake.slice(0, handshake.indexOf("\n  }\n"));
  assert.match(handshakeBlock, /capabilities\?\.agents\)\s*\{\s*be\.send\(\{ type: "list_agents", request_id: this\.nextRequestId\("agents-restore"\) \}\);/);
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
  assert.match(section, /@media \(max-width: 360px\) \{\s*\.agents-word, \.agents-need \{ display: none; \}/);
  assert.match(section, /prefers-reduced-motion: reduce\) \{ \.tool\.flash \{ animation: none; \} \}/);
});
