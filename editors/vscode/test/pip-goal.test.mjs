// A Personal Pip's goal, in its chat (pips-15; Pips API 92, dgc/pip_goals.py): "/goal for one Pip: 'Keep going until
// done', with a card showing turns and status, and a real ending: done, needs you or blocked."
//   - "/goal <what>" in its chat's box (or "Set a goal" in the box's + menu) sets the goal for that conversation
//   - a card above the box while it runs or waits: the objective, "Turn 3 of 20", the status in plain words, Stop
//   - done, blocked or stopped: the ending shown once, its reason and evidence behind Details, and Dismiss
//   - read again when the chat opens and after each reply lands
//   - never for a Project Pip, never below API 92: "/goal x" is then a message like any other
// (Harness from pip-memory-learns.)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const src = fileURLToPath(new URL("../src/", import.meta.url));
const windows = [];
after(() => windows.forEach((w) => w.close()));
const bundle = async (file) => (await build({ entryPoints: [src + file], bundle: true, write: false, platform: "node", format: "cjs",
  external: ["vscode"], loader: { ".css": "empty" } })).outputFiles[0].text;
const load = (code, req = require) => { const m = { exports: {} }; new Function("module", "exports", "require", code)(m, m.exports, req); return m.exports; };
const viewModule = load(await bundle("pipsView.ts"), (name) => (name === "vscode" ? {} : require(name)));
const client = (await build({ entryPoints: [src + "pipsClient.js"], bundle: true, write: false, format: "iife", loader: { ".css": "empty" } })).outputFiles[0].text;
const PW = "ws_" + "p".repeat(32), PIP = "pip_" + "a".repeat(32), GOAL = "pipgoal_" + "1".repeat(32), GOAL2 = "pipgoal_" + "2".repeat(32);
const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index,
  name: id[0].toUpperCase() + id.slice(1), role: id, description: "Reads and reports", available: id !== "core",
  unavailable_reason: id === "core" ? "Core is the main chat." : null, default_name: id, default_goal: "Review",
  engine: id === "core" ? null : id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message",
  inherited_context_size: 1048576, effective_context_size: 8192, context_min: 2048, context_max: 32768,
  thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
const now = new Date().toISOString();
const OBJECTIVE = "Plan my week: list my three priorities, block time for each, and draft the plan.";
const goal = (status = "active", extra = {}) => ({ id: GOAL, pip_id: PIP, conversation_id: null, objective: OBJECTIVE, status, turns: 0, max_turns: 20, reason: "", evidence: [],
  started_at: now, updated_at: now, ...extra });
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();

function pipsPage({ apiVersion = 92, project = false, goal: first = null, saved } = {}) {
  const dom = new JSDOM(viewModule.pipsDocument(), { runScripts: "outside-only", pretendToBeVisual: true }), w = dom.window; windows.push(w);
  const sent = [], answered = new Set(), hold = new Set();
  let kept = saved;
  w.HTMLCanvasElement.prototype.getContext = () => null; w.TextEncoder = TextEncoder;
  w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m), getState: () => kept, setState: (v) => { kept = JSON.parse(JSON.stringify(v)); } });
  w.eval(client);
  const pip = { id: PIP, workspace_id: PW, pip_type: project ? "rook" : "scout", name: "Ava", goal: "Plan with me.", source_policy: { mode: project ? "committed_only" : "personal" },
    source_ref: "HEAD", status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null,
    proposals: [], pending_review_count: 0, profile: { title: "", body: null, color: null, notify: true } };
  const message = (data) => w.dispatchEvent(new w.MessageEvent("message", { data }));
  const answer = (m, result, ok = true) => { answered.add(m.id); message({ type: "pipsReply", id: m.id, ok, ...(ok ? { result } : { error: { message: result } }) }); };
  const requests = (type) => JSON.parse(JSON.stringify(sent.filter((m) => m.type === "pipsRequest" && m.request.type === type).map((m) => m.request)));
  const asked = (type) => sent.filter((m) => m.type === "pipsRequest" && m.request.type === type);
  const runner = { runner_id: "runner", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } };
  const state = { goal: first, messages: [] };
  const defaults = (r) => ({ list_workspaces: () => ({ workspaces: [{ id: PW, name: project ? "shop" : "Personal", kind: project ? "git" : "personal" }], current_workspace_id: PW }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pips: () => ({ pips: [pip], total: 1, next_offset: null }), get_pip: () => ({ pip }),
    list_pip_runs: () => ({ runs: [] }), list_pip_starters: () => ({ starters: [] }), get_pip_runner: () => ({ runner }),
    get_workspace_context: () => ({ context: { workspace_id: PW, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: PW, messages: state.messages, next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_posts: () => ({ pip_id: PIP, workspace_id: PW, posts: [], next_before_id: null }), list_pip_run_fixes: () => ({ pip_id: PIP, workspace_id: PW, fixes: [] }),
    list_pip_reply_stats: () => ({ pip_id: PIP, stats: [] }), list_pip_handoffs: () => ({ pip_id: PIP, workspace_id: PW, handoffs: [], has_more: false, next_before_id: null }),
    get_pip_computer: () => ({ computer: { pip_id: PIP, granted: false, available: true, reason: "", pending: 0, actions: [] } }),
    list_pip_app_links: () => ({ pip_id: PIP, links: [], composio: true }), list_pip_message_drafts: () => ({ drafts: [], next_cursor: null }),
    list_pip_calendar_drafts: () => ({ drafts: [], next_cursor: null }), list_pip_connector_drafts: () => ({ drafts: [], next_cursor: null }),
    get_pip_digest: () => undefined, list_pip_routines: () => ({ pip_id: PIP, workspace_id: PW, routines: [] }),
    get_pip_computers: () => null, list_pip_apps: () => ({ apps: [] }), list_pip_plugins: () => ({ pip_id: PIP, plugins: [], installed: [] }),
    list_pip_notes: () => ({ pip_id: PIP, notes: [], max: 60 }), list_pip_attention: () => ({ as_of: now, total: 0, counts: {}, by_pip: {}, items: [], truncated: false }),
    get_pip_goal: () => ({ pip_id: PIP, goal: state.goal }),
    set_pip_goal: () => { state.goal = goal("active", { id: state.goal ? GOAL2 : GOAL, objective: r.objective }); return { goal: state.goal }; },
    stop_pip_goal: () => { state.goal = { ...state.goal, status: "stopped", reason: "Stopped by you." }; return { goal: state.goal }; },
    send_pip_message: () => { const run_id = "run_" + "c".repeat(32), m = { id: "message_" + "9".repeat(32), pip_id: PIP, workspace_id: PW, run_id, role: "user", text: r.text, model: "m", created_at: now, status: "succeeded" };
      state.messages = [m, { ...m, id: "message_" + "8".repeat(32), role: "assistant", text: "Here it is." }];
      return { message: { ...m, status: "queued" }, run: { id: run_id, pip_id: PIP, workspace_id: PW, status: "queued", created_at: now, manifest: { run_kind: "chat", job_version: 1, trigger: "chat" }, result: null } }; },
  }[r.type]?.());
  async function drain() { for (let n = 0; n < 15; n++) { await flush(); for (const m of sent.filter((m) => m.type === "pipsRequest" && !answered.has(m.id) && !hold.has(m.request.type))) { const result = defaults(m.request); if (result !== undefined) answer(m, result); } } }
  message({ type: "pipsConnection", apiVersion, generation: 1, connected: true, supported: true, enabled: true });
  const d = w.document;
  const click = async (s) => { const el = d.querySelector(s); assert.ok(el, "Missing " + s); el.click(); await drain(); };
  const type = (value) => { const el = d.querySelector("#chatText"); assert.ok(el, "the chat's box"); el.value = value; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const submit = async () => { d.querySelector("#chat-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await drain(); };
  const open = async () => { await drain(); if (!d.querySelector("#chat-form")) { d.querySelector(`[data-job="${PIP}"]`).click(); await drain(); } assert.ok(d.querySelector("#chat-form"), "its chat"); };
  const card = () => d.querySelector(".pip-goal-card");
  return { w, d, sent, answer, requests, asked, drain, click, type, submit, open, card, state, hold, savedState: () => kept };
}

test("a Personal Pip's chat asks for its goal when it opens; with none set there is no card", async () => {
  const x = pipsPage(); await x.open();
  assert.deepEqual(x.requests("get_pip_goal").map((r) => r.pip_id), [PIP], "asked once, for this Pip");
  assert.equal(x.card(), null);
});

test('"/goal <what>" sets the goal for this conversation: no message is sent, and its card says Turn 1 of 20, Working on it', async () => {
  const x = pipsPage(); await x.open();
  x.type(`/goal ${OBJECTIVE}`); await x.submit();
  const set = x.requests("set_pip_goal");
  assert.equal(set.length, 1);
  assert.deepEqual([set[0].pip_id, set[0].objective], [PIP, OBJECTIVE]);
  assert.equal(x.requests("send_pip_message").length, 0, "the goal is not a message to the Pip");
  assert.equal(x.d.querySelector("#chatText").value, "", "the box is clear");
  const card = x.card();
  assert.ok(card, "the goal's card, above the box");
  assert.ok(card.compareDocumentPosition(x.d.querySelector("#chat-form")) & x.w.Node.DOCUMENT_POSITION_FOLLOWING, "above the prompt box");
  assert.ok(card.closest(".pip-composer-shell"), "pinned with the box, not among the messages");
  assert.equal(text(card.querySelector(".pip-goal-objective")), OBJECTIVE);
  assert.equal(text(card.querySelector(".pip-goal-turn")), "Turn 1 of 20");
  assert.equal(text(card.querySelector(".pip-goal-status")), "Working on it");
  assert.deepEqual([...card.querySelectorAll("button")].map(text).filter((t) => t !== "more"), ["Stop"]);
});

test('"/goal" with nothing after it says what to write, and a goal DGC refuses stays in the box with its words', async () => {
  const x = pipsPage(); await x.open();
  x.type("/goal"); await x.submit();
  assert.equal(x.requests("set_pip_goal").length, 0);
  assert.equal(x.requests("send_pip_message").length, 0);
  assert.match(text(x.d.querySelector(".conversation-log")), /Say what the goal is after \/goal: what Ava should keep working on until it is done\./);
  x.hold.add("set_pip_goal");
  x.type("/goal Plan my week"); await x.submit();
  x.answer(x.asked("set_pip_goal")[0], "Wait for this reply to finish, then set the goal.", false); await x.drain();
  assert.match(text(x.d.querySelector(".conversation-log")), /Wait for this reply to finish, then set the goal\./);
  assert.equal(x.d.querySelector("#chatText").value, "/goal Plan my week", "what was written is still there");
  assert.equal(x.card(), null);
});

test("the card says the turn and the status in plain words; Stop stops it", async () => {
  const x = pipsPage({ goal: goal("active", { turns: 2 }) }); await x.open();
  assert.equal(text(x.card().querySelector(".pip-goal-turn")), "Turn 3 of 20", "two turns done: it is on its third");
  assert.equal(x.card().dataset.status, "active");
  const waits = pipsPage({ goal: goal("needs_you", { turns: 3, reason: "Waiting for your answer in the chat." }) }); await waits.open();
  assert.equal(text(waits.card().querySelector(".pip-goal-turn")), "Turn 3 of 20");
  assert.equal(text(waits.card().querySelector(".pip-goal-status")), "Waits for your answer");
  assert.ok(waits.card().querySelector("#pip-goal-stop"), "it can still be stopped while it waits");
  await x.click("#pip-goal-stop");
  assert.deepEqual(x.requests("stop_pip_goal"), [{ type: "stop_pip_goal", pip_id: PIP, goal_id: GOAL }]);
  assert.equal(text(x.card().querySelector(".pip-goal-status")), "Stopped");
  assert.equal(x.card().querySelector("#pip-goal-stop"), null, "nothing left to stop");
  assert.deepEqual([...x.card().querySelectorAll(".pip-goal-acts button")].map(text), ["Details", "Dismiss"]);
});

test("done: the ending is shown once, its reason and evidence behind Details, and Dismiss takes it away for good", async () => {
  const done = goal("done", { turns: 4, reason: "The plan is drafted and every priority has its time.", evidence: ["Three priorities are listed in the plan", "Each has a block on the calendar draft"] });
  const x = pipsPage({ goal: done }); await x.open();
  assert.equal(text(x.card().querySelector(".pip-goal-status")), "Done");
  assert.equal(text(x.card().querySelector(".pip-goal-turn")), "Turn 4 of 20");
  assert.equal(x.card().querySelector(".pip-goal-details"), null, "its details are closed until asked for");
  await x.click("#pip-goal-details");
  assert.equal(x.d.querySelector("#pip-goal-details").getAttribute("aria-expanded"), "true");
  assert.equal(text(x.card().querySelector(".pip-goal-reason")), "The plan is drafted and every priority has its time.");
  assert.deepEqual([...x.card().querySelectorAll(".pip-goal-evidence li")].map(text), done.evidence);
  await x.click("#pip-goal-dismiss");
  assert.equal(x.card(), null, "dismissed");
  // A reply lands and the goal is read again: the same ending does not come back.
  x.type("Thanks"); await x.submit();
  assert.ok(x.requests("get_pip_goal").length >= 2, "read again after the reply landed");
  assert.equal(x.card(), null, "shown once");
  // Not after a reload either: the page keeps which endings were dismissed.
  const again = pipsPage({ goal: done, saved: x.savedState() }); await again.open();
  assert.equal(again.card(), null);
  // A new goal has its own card.
  x.type("/goal Now plan next month"); await x.submit();
  assert.equal(text(x.card().querySelector(".pip-goal-objective")), "Now plan next month");
});

test("blocked says why; a long objective is two lines until more", async () => {
  const long = "Go through every invoice from this quarter, match each to its bank line, list the ones that do not match with the amounts, and draft a note to the accountant about them. ".repeat(2).trim();
  const x = pipsPage({ goal: goal("blocked", { turns: 20, objective: long, reason: "Stopped after 20 turns without finishing. Look at where it got to, then set it again." }) }); await x.open();
  assert.equal(text(x.card().querySelector(".pip-goal-status")), "Blocked: Stopped after 20 turns without finishing. Look at where it got to, then set it again.");
  assert.equal(text(x.card().querySelector(".pip-goal-turn")), "Turn 20 of 20");
  const objective = x.card().querySelector(".pip-goal-objective");
  assert.ok(objective.classList.contains("is-clamped"), "two lines");
  const more = x.card().querySelector("#pip-goal-more");
  assert.equal(text(more), "more");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  await x.click("#pip-goal-more");
  assert.ok(!x.card().querySelector(".pip-goal-objective").classList.contains("is-clamped"), "all of it");
  assert.equal(text(x.d.querySelector("#pip-goal-more")), "less");
  const short = pipsPage({ goal: goal("active") }); await short.open();
  assert.equal(short.card().querySelector("#pip-goal-more"), null, "a short objective needs no more");
});

test("the goal is read again after each reply lands, and the card follows it", async () => {
  const x = pipsPage({ goal: goal("needs_you", { turns: 1 }) }); await x.open();
  const before = x.requests("get_pip_goal").length;
  x.state.goal = goal("active", { turns: 1 });
  x.type("Monday to Friday, mornings"); await x.submit();
  assert.equal(x.requests("send_pip_message").length, 1, "an answer is a message like any other");
  assert.ok(x.requests("get_pip_goal").length > before, "read again once the reply landed");
  assert.equal(text(x.card().querySelector(".pip-goal-status")), "Working on it", "the answer carried it on");
  assert.equal(text(x.card().querySelector(".pip-goal-turn")), "Turn 2 of 20");
});

test('"Set a goal" in the box\'s + menu starts the box with /goal', async () => {
  const x = pipsPage(); await x.open();
  await x.click("#chat-attach");
  const row = x.d.querySelector('.composer-add-menu [data-pip-add="goal"]');
  assert.ok(row, "Set a goal, in the menu");
  assert.match(text(row), /^Set a goal/);
  row.click(); await x.drain();
  assert.equal(x.d.querySelector("#chatText").value, "/goal ");
  assert.equal(x.requests("set_pip_goal").length, 0, "nothing is set until it is sent");
});

test('never for a Project Pip, never below Pips API 92: "/goal x" is then a message like any other', async () => {
  const has = pipsPage(); await has.open();
  assert.equal(has.requests("get_pip_goal").length, 1, "a Personal Pip at API 92 is asked");
  for (const [name, options] of [["a DGC before API 92", { apiVersion: 91 }], ["a Project Pip", { project: true }]]) {
    const x = pipsPage({ ...options, goal: goal("active") }); await x.open();
    assert.equal(x.requests("get_pip_goal").length, 0, name);
    assert.equal(x.card(), null, name);
    x.type("/goal Plan my week"); await x.submit();
    assert.equal(x.requests("set_pip_goal").length, 0, name);
    assert.deepEqual(x.requests("send_pip_message").map((r) => r.text), ["/goal Plan my week"], name);
    if (x.d.querySelector("#chat-attach")) { await x.click("#chat-attach"); assert.equal(x.d.querySelector('[data-pip-add="goal"]'), null, name); }
  }
});
