// Memory that learns on a Personal Pip's page (Pips API 57): its own working notes, which you can edit; the log of
// what it did each day; and /learn in its chat, a personal skill written only on Save. (Harness from pip-notes.)
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

// ---- A Personal Pip's page: working notes, daily log, /learn -----------------------------------

const bundle = async (file) => (await build({ entryPoints: [src + file], bundle: true, write: false, platform: "node", format: "cjs",
  external: ["vscode"], loader: { ".css": "empty" } })).outputFiles[0].text;
const load = (code, req = require) => { const m = { exports: {} }; new Function("module", "exports", "require", code)(m, m.exports, req); return m.exports; };
const viewModule = load(await bundle("pipsView.ts"), (name) => (name === "vscode" ? {} : require(name)));
const client = (await build({ entryPoints: [src + "pipsClient.js"], bundle: true, write: false, format: "iife", loader: { ".css": "empty" } })).outputFiles[0].text;
const PW = "ws_" + "p".repeat(32), PIP = "pip_" + "a".repeat(32), RUN = "run_" + "b".repeat(32);
const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index,
  name: id[0].toUpperCase() + id.slice(1), role: id, description: "Reads and reports", available: id !== "core",
  unavailable_reason: id === "core" ? "Core is the main chat." : null, default_name: id, default_goal: "Review",
  engine: id === "core" ? null : id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
const pip = { id: PIP, workspace_id: PW, pip_type: "scout", name: "Ava", goal: "Pay my hospital bills.", source_policy: { mode: "personal" },
  source_ref: "HEAD", status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null,
  proposals: [], pending_review_count: 0, profile: { title: "", body: null, color: null, notify: true } };
const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message",
  inherited_context_size: 1048576, effective_context_size: 8192, context_min: 2048, context_max: 32768,
  thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
const now = new Date().toISOString();
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function pipsPage({ apiVersion = 57, lines = ["The hospital portal asks for the UHID first", "Bills go to Arjun Mehta"] } = {}) {
  const dom = new JSDOM(viewModule.pipsDocument(), { runScripts: "outside-only", pretendToBeVisual: true }), w = dom.window; windows.push(w);
  const sent = [], answered = new Set();
  w.HTMLCanvasElement.prototype.getContext = () => null; w.TextEncoder = TextEncoder;
  w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m), getState: () => undefined, setState: () => {} });
  w.eval(client);
  const message = (data) => w.dispatchEvent(new w.MessageEvent("message", { data }));
  const answer = (m, result, ok = true) => { answered.add(m.id); message({ type: "pipsReply", id: m.id, ok, ...(ok ? { result } : { error: { message: result } }) }); };
  const requests = (type) => sent.filter((m) => m.type === "pipsRequest" && m.request.type === type);
  const runner = { runner_id: "runner", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } };
  const state = { lines };
  const notes = () => ({ pip_id: PIP, lines: state.lines, text: state.lines.join("\n"), max_lines: 60, max_bytes: 6000,
    bytes: state.lines.join("\n").length, revision: "rev" + state.lines.length, updated_at: now });
  const defaults = (r) => ({ list_workspaces: () => ({ workspaces: [{ id: PW, name: "Personal", kind: "personal" }], current_workspace_id: PW }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pips: () => ({ pips: [pip] }), get_pip: () => ({ pip }),
    list_pip_runs: () => ({ runs: [] }), list_pip_starters: () => ({ starters: [] }), get_pip_runner: () => ({ runner }),
    get_workspace_context: () => ({ context: { workspace_id: PW, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: PW, messages: [
      { id: "message_" + "1".repeat(32), pip_id: PIP, workspace_id: PW, run_id: "run_" + "c".repeat(32), role: "user", text: "Pay the bill", model: "m", created_at: now, status: "succeeded" },
      { id: "message_" + "2".repeat(32), pip_id: PIP, workspace_id: PW, run_id: "run_" + "c".repeat(32), role: "assistant", text: "Paid.", model: "m", created_at: now, status: "succeeded" }],
      next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
    get_pip_computer: () => ({ computer: { pip_id: PIP, granted: false, available: true, reason: "", pending: 0, actions: [] } }),
    list_pip_app_links: () => ({ pip_id: PIP, links: [], composio: true }), list_pip_message_drafts: () => ({ drafts: [], next_cursor: null }),
    list_pip_calendar_drafts: () => ({ drafts: [], next_cursor: null }), list_pip_connector_drafts: () => ({ drafts: [], next_cursor: null }),
    get_pip_digest: () => undefined, list_pip_routines: () => ({ pip_id: PIP, workspace_id: PW, routines: [] }),
    list_pip_shared: () => ({ pip_id: PIP, workspace_id: PW, kind: r.kind, items: [] }), get_pip_computers: () => null, list_pip_apps: () => ({ apps: [] }),
    list_pip_action_grants: () => ({ pip_id: PIP, grants: [] }), list_pip_plugins: () => ({ pip_id: PIP, plugins: [], installed: [] }),
    list_pip_notes: () => ({ pip_id: PIP, notes: [], max: 60 }),
    list_pip_attention: () => ({ as_of: now, total: 0, counts: {}, by_pip: {}, items: [], truncated: false }),
    get_pip_working_notes: () => notes(),
    list_pip_daily_log: () => ({ pip_id: PIP, days: [{ day: today, lines: ["09:05 · Chat: you asked “Pay the bill” · “Paid.”"], more: 0 },
      { day: "2026-10-20", lines: ["15:00 · Routine “Check bills” · “Two bills due.”"], more: 2 }], next_before: null }) }[r.type]?.());
  async function drain() { for (let n = 0; n < 15; n++) { await flush(); for (const m of sent.filter((m) => m.type === "pipsRequest" && !answered.has(m.id))) { const result = defaults(m.request); if (result !== undefined) answer(m, result); } } }
  message({ type: "pipsConnection", apiVersion, generation: 1, connected: true, supported: true, enabled: true });
  const click = (s) => { const el = w.document.querySelector(s); assert.ok(el, "Missing " + s); el.click(); };
  const type = (s, value) => { const el = w.document.querySelector(s); assert.ok(el, "Missing " + s); el.value = value; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  return { w, d: w.document, sent, answer, requests, drain, click, type, state, notes };
}
async function openInfo(x) { await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain(); x.click('[data-tab="job"]'); await x.drain(); }

test("a Pip's page shows its working notes, which you can edit, and what it did each day", async () => {
  const x = pipsPage(); await openInfo(x);
  const notes = x.d.querySelector('[aria-label="Working notes"]');
  assert.ok(notes, "on its page");
  assert.match(notes.textContent, /The hospital portal asks for the UHID first.*Bills go to Arjun Mehta/);
  assert.match(notes.textContent, /Ava keeps these about how it does its job, and starts every run with them\. 2 of 60 lines\./);
  const log = x.d.querySelector('[aria-label="Daily log"]');
  assert.match(log.textContent, /Today · 1 run.*Pay the bill.*2026-10-20 · 3 runs/);
  assert.equal(log.querySelectorAll("details[open]").length, 1, "today open, other days a click away");
  assert.match(log.textContent, /and 2 more/);
  x.click('[data-working-notes="edit"]');
  assert.equal(x.d.querySelector("#workingNotesText").value, "The hospital portal asks for the UHID first\nBills go to Arjun Mehta");
  x.type("#workingNotesText", "The hospital portal asks for the UHID first\nBills go to Arjun Mehta in accounts");
  x.d.querySelector("#working-notes-form").dispatchEvent(new x.w.Event("submit", { bubbles: true, cancelable: true })); await flush();
  const set = x.requests("set_pip_working_notes").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(set.request)), { type: "set_pip_working_notes", pip_id: PIP,
    text: "The hospital portal asks for the UHID first\nBills go to Arjun Mehta in accounts", expected_revision: "rev2" });
  x.state.lines = ["The hospital portal asks for the UHID first", "Bills go to Arjun Mehta in accounts"];
  x.answer(set, x.notes()); await x.drain();
  assert.match(x.d.querySelector('[aria-label="Working notes"]').textContent, /Arjun Mehta in accounts/);
  assert.match(x.d.body.textContent, /Saved\. Its next run starts with these notes\./);
});

test("an older CLI shows neither, and asks for neither", async () => {
  const x = pipsPage({ apiVersion: 56 }); await openInfo(x);
  assert.equal(x.d.querySelector('[aria-label="Working notes"]'), null);
  assert.equal(x.d.querySelector('[aria-label="Daily log"]'), null);
  assert.equal(x.requests("get_pip_working_notes").length + x.requests("list_pip_daily_log").length, 0);
});

test("/learn in a Pip's chat drafts a personal skill, shown with Save, Edit and Cancel, never a message to the Pip", async () => {
  const x = pipsPage(); await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain();
  x.type("#chatText", "/learn how to pay the hospital bill");
  x.d.querySelector("#chat-form").dispatchEvent(new x.w.Event("submit", { bubbles: true, cancelable: true })); await flush();
  assert.equal(x.requests("send_pip_message").length, 0, "not sent to the Pip");
  const learn = x.requests("learn_skill").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(learn.request)), { type: "learn_skill", pip_id: PIP, request: "how to pay the hospital bill" });
  assert.match(x.d.querySelector(".pip-learn-card").textContent, /Writing a skill from this chat: how to pay the hospital bill…/);
  const markdown = "---\nname: pay-hospital-bill\ndescription: \"Pay a hospital bill on its portal.\"\n---\n\n# Pay a hospital bill\n\n1. Enter the UHID first.";
  x.answer(learn, { type: "skill_draft", ok: true, name: "pay-hospital-bill", description: "Pay a hospital bill on its portal.", markdown, scope: "user" });
  await x.drain();
  const card = x.d.querySelector(".pip-learn-card");
  assert.match(card.textContent, /New skill: pay-hospital-bill.*Pay a hospital bill on its portal\..*Nothing is written until you save\./);
  assert.match(card.querySelector(".pip-learn-body").textContent, /Enter the UHID first/);
  x.click('[data-pip-learn="edit"]');
  x.type("#pipLearnText", markdown + "\n2. Pay by UPI.");
  x.click('[data-pip-learn="save"]'); await flush();
  const save = x.requests("save_skill").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(save.request)), { type: "save_skill", pip_id: PIP, markdown: markdown + "\n2. Pay by UPI." });
  x.answer(save, { type: "skill_saved", ok: true, name: "pay-hospital-bill", path: "/home/u/.dgc/skills/pay-hospital-bill/SKILL.md", scope: "user" });
  await x.drain();
  assert.match(x.d.querySelector(".pip-learn-card").textContent, /Saved the skill pay-hospital-bill to your skills\..*Undo is in Settings → Memory\./);
});

test("the host bridges a Pip's /learn to the editor's command, and only for a CLI that offers it", () => {
  const sent = [];
  const editor = new viewModule.PipsEditor({}, (m) => { sent.push(m); return true; }, () => {}, false);
  const posted = []; editor.attach((m) => posted.push(m));
  editor.ready({ pips_supported: true, pips_api_version: 57, pips_enabled: true }, {});
  editor.receive({ type: "pipsRequest", id: "v1", request: { type: "learn_skill", pip_id: PIP, request: "x" } });
  assert.match(posted.at(-1).error.message, /Update DGC to turn a Pip’s work into a skill/);
  editor.ready({ pips_supported: true, pips_api_version: 57, pips_enabled: true, learn: { version: 1 } }, {});
  editor.receive({ type: "pipsRequest", id: "v2", request: { type: "learn_skill", pip_id: PIP, request: "x" } });
  const command = sent.at(-1);
  assert.equal(command.type, "learn_skill");
  assert.equal(command.pip_id, PIP);
  assert.equal(editor.event({ type: "skill_draft", request_id: command.request_id, ok: true, name: "x", markdown: "m" }), true);
  assert.equal(posted.at(-1).id, "v2");
  assert.equal(posted.at(-1).ok, true);
  editor.receive({ type: "pipsRequest", id: "v3", request: { type: "save_skill", pip_id: PIP, markdown: "---\nname: x\n---\nx" } });
  assert.deepEqual({ ...sent.at(-1), request_id: "" }, { type: "save_skill", request_id: "", pip_id: PIP, markdown: "---\nname: x\n---\nx", scope: "user" },
    "a Pip's skill is always a personal one");
  editor.receive({ type: "pipsRequest", id: "v4", request: { type: "save_skill", pip_id: PIP, markdown: "m", scope: "project" } });
  assert.match(posted.at(-1).error.message, /malformed/);
});
