// From your code (Pips API 64): a Personal Pip your app's code keeps from a template says so on its page in one line,
// and the change its template asks for is one card there: what it asks, in DGC's words, Accept and Not now. A Pip no
// template keeps shows nothing new, and an older DGC is asked for nothing. (Harness from pip-levels.)
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
const templates = load(await bundle("pipTemplates.js"));
const client = (await build({ entryPoints: [src + "pipsClient.js"], bundle: true, write: false, format: "iife", loader: { ".css": "empty" } })).outputFiles[0].text;
const PW = "ws_" + "p".repeat(32), PIP = "pip_" + "a".repeat(32), RUN = "run_" + "c".repeat(32);
const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index,
  name: id[0].toUpperCase() + id.slice(1), role: id, description: "Reads and reports", available: id !== "core",
  unavailable_reason: id === "core" ? "Core is the main chat." : null, default_name: id, default_goal: "Review",
  engine: id === "core" ? null : id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
const pip = { id: PIP, workspace_id: PW, pip_type: "scout", name: "Ava", goal: "Pay my hospital bills.", source_policy: { mode: "personal" },
  source_ref: "HEAD", status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null,
  proposals: [], pending_review_count: 0, profile: { title: "", body: null, color: null, notify: true }, computer_plan: { schema_version: 1 } };
const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message",
  inherited_context_size: 1048576, effective_context_size: 8192, context_min: 2048, context_max: 32768,
  thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
const now = new Date().toISOString();
const SAYS = { ask: "Asks before every new site, every submit and every send.",
  approve: "Opens new sites, searches, adds to carts and saves drafts by itself. Asks before it orders, pays, sends to someone new, posts, deletes or changes an account.",
  full: "Does it all by itself, sends included. Still asks before any payment." };
const NAMES = { ask: "Ask", approve: "Approve for me", full: "Full access" };
const level = (value, done = []) => ({ pip_id: PIP, level: value, default: "ask",
  levels: ["ask", "approve", "full"].map((l) => ({ level: l, name: NAMES[l], says: SAYS[l] })), on_its_own: done });
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function pipsPage({ apiVersion = 64, state = level("ask"), actions = [], kept = [TEMPLATE()] } = {}) {
  const dom = new JSDOM(viewModule.pipsDocument(), { runScripts: "outside-only", pretendToBeVisual: true }), w = dom.window; windows.push(w);
  const sent = [], answered = new Set();
  w.HTMLCanvasElement.prototype.getContext = () => null; w.TextEncoder = TextEncoder;
  w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m), getState: () => undefined, setState: () => {} });
  w.eval(client);
  const message = (data) => w.dispatchEvent(new w.MessageEvent("message", { data }));
  const answer = (m, result, ok = true) => { answered.add(m.id); message({ type: "pipsReply", id: m.id, ok, ...(ok ? { result } : { error: { message: result } }) }); };
  const requests = (type) => sent.filter((m) => m.type === "pipsRequest" && m.request.type === type);
  const runner = { runner_id: "runner", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } };
  const defaults = (r) => ({ list_workspaces: () => ({ workspaces: [{ id: PW, name: "Personal", kind: "personal" }], current_workspace_id: PW }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pips: () => ({ pips: [pip] }), get_pip: () => ({ pip }),
    list_pip_runs: () => ({ runs: [] }), list_pip_starters: () => ({ starters: [] }), get_pip_runner: () => ({ runner }),
    get_workspace_context: () => ({ context: { workspace_id: PW, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: PW, messages: [
      { id: "message_" + "1".repeat(32), pip_id: PIP, workspace_id: PW, run_id: RUN, role: "user", text: "Tidy my files", model: "m", created_at: now, status: "succeeded" },
      { id: "message_" + "2".repeat(32), pip_id: PIP, workspace_id: PW, run_id: RUN, role: "assistant", text: "I want to clear the folder.", model: "m", created_at: now, status: "succeeded" }],
      next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
    get_pip_computer: () => ({ computer: { pip_id: PIP, granted: true, available: true, reason: "", pending: actions.length, actions } }),
    list_pip_app_links: () => ({ pip_id: PIP, links: [], composio: true }), list_pip_message_drafts: () => ({ drafts: [], next_cursor: null }),
    list_pip_calendar_drafts: () => ({ drafts: [], next_cursor: null }), list_pip_connector_drafts: () => ({ drafts: [], next_cursor: null }),
    get_pip_digest: () => undefined, list_pip_routines: () => ({ pip_id: PIP, workspace_id: PW, routines: [] }),
    list_pip_shared: () => ({ pip_id: PIP, workspace_id: PW, kind: r.kind, items: [] }), get_pip_computers: () => null, list_pip_apps: () => ({ apps: [] }),
    list_pip_action_grants: () => ({ pip_id: PIP, grants: [] }), list_pip_plugins: () => ({ pip_id: PIP, plugins: [], installed: [] }),
    list_pip_notes: () => ({ pip_id: PIP, notes: [], max: 60 }), list_pip_sites: () => ({ pip_id: PIP, careful: true, sites: [] }),
    list_pip_logins: () => ({ logins: [] }),
    get_pip_eyes: () => ({ eyes: { pip_id: PIP, model: "m", sees: true, choice: "ask", vision_model: null } }),
    list_pip_attention: () => ({ as_of: now, total: 0, counts: {}, by_pip: {}, items: [], truncated: false }),
    get_pip_working_notes: () => ({ pip_id: PIP, lines: [], text: "", max_lines: 60, max_bytes: 6000, bytes: 0, revision: "r0", updated_at: null }),
    list_pip_daily_log: () => ({ pip_id: PIP, days: [], next_before: null }),
    get_pip_level: () => state, list_pip_templates: () => ({ templates: kept }),
    decide_pip_template_change: () => undefined }[r.type]?.());
  async function drain() { for (let n = 0; n < 15; n++) { await flush(); for (const m of sent.filter((m) => m.type === "pipsRequest" && !answered.has(m.id))) { const result = defaults(m.request); if (result !== undefined) answer(m, result); } } }
  message({ type: "pipsConnection", apiVersion, generation: 1, connected: true, supported: true, enabled: true });
  const click = (s) => { const el = w.document.querySelector(s); assert.ok(el, "Missing " + s); el.click(); };
  return { w, d: w.document, sent, answer, requests, drain, click };
}
async function openInfo(x) { await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain(); x.click('[data-tab="job"]'); await x.drain(); }

const CHANGE = "tmplchange_" + "c".repeat(32), DIGEST = "d".repeat(64);
const ITEMS = [{ kind: "tool", tool: "app:shop/create_dispatch", schema_digest: "e".repeat(64), words: "Use create_dispatch in Shop app, a change" },
  { kind: "always_allow", tool: "app:shop/create_dispatch", connection_digest: "a".repeat(64), schema_digest: "e".repeat(64), words: "Run create_dispatch in Shop app without asking" },
  { kind: "routine", title: "New orders", prompt: "Check it.", when: { kind: "app", app: "shop", event: "order.created" }, routine_id: null, words: "A routine, New orders: when the shop app sends order.created" }];
const WAITING = { id: CHANGE, pip_id: "pip_" + "a".repeat(32), key: "dispatch", status: "waiting", digest: DIGEST, items: ITEMS,
  words: "Your code asks to let Ava do more: …", created_at: "2026-10-24T09:00:00.000Z", decided_at: null, decided_by: null };
const TEMPLATE = (waiting = null) => ({ key: "dispatch", pip_id: "pip_" + "a".repeat(32), name: "Ava", status: "active", pruned: false, level: "ask",
  tools: ["app:shop/get_order"], always_allow: [], routines: [], created_at: "2026-10-24T09:00:00.000Z", updated_at: "2026-10-24T09:00:00.000Z",
  waiting, declined: null });

test("a Pip its code keeps says so in one line, and nothing waits: no card", async () => {
  const x = pipsPage(); await openInfo(x);
  const section = x.d.querySelector('[aria-label="From your code"]');
  assert.ok(section, "on its page");
  assert.equal(section.textContent.trim(), "From your codeYour app keeps Ava from its template, dispatch. What you change here stays as you set it.");
  assert.equal(section.querySelector("[data-template-accept]"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(x.requests("list_pip_templates").at(-1).request)), { type: "list_pip_templates", pip_id: PIP });
  assert.doesNotMatch(section.textContent, /\bAI\b/);
});

test("the change its template asks for is one card: its words, Accept, and Not now", async () => {
  const x = pipsPage({ kept: [TEMPLATE(WAITING)] }); await openInfo(x);
  const card = x.d.querySelector(`[data-template-change="${CHANGE}"]`);
  assert.ok(card, "the card");
  assert.equal(card.querySelector("h3").textContent, "Your code asks to let Ava do more");
  assert.deepEqual([...card.querySelectorAll("li")].map((li) => li.textContent), ITEMS.map((i) => i.words));
  assert.match(card.textContent, /Nothing of this applies until you accept it\. Not now keeps Ava as it is/);
  x.click("[data-template-accept]"); await flush();
  const decided = x.requests("decide_pip_template_change").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(decided.request)),
    { type: "decide_pip_template_change", change_id: CHANGE, decision: "accept", expected_digest: DIGEST });
  const before = x.requests("list_pip_templates").length;
  x.answer(decided, { change: { ...WAITING, status: "accepted" }, decided: true, applied: [],
    notice: "Ava can do more now: Use create_dispatch in Shop app, a change." });
  await x.drain();
  assert.match(x.d.body.textContent, /Ava can do more now: Use create_dispatch in Shop app, a change\./, "said once, as the notice");
  assert.ok(x.requests("list_pip_templates").length > before, "the section loads again");
  assert.ok(x.requests("get_pip").length >= 2, "and the Pip itself");
});

test("Not now turns it down", async () => {
  const x = pipsPage({ kept: [TEMPLATE(WAITING)] }); await openInfo(x);
  x.click("[data-template-decline]"); await flush();
  const decided = x.requests("decide_pip_template_change").at(-1);
  assert.equal(decided.request.decision, "reject");
  assert.equal(decided.request.expected_digest, DIGEST);
});

test("a Pip no template keeps shows nothing new, and an older DGC is asked for nothing", async () => {
  const none = pipsPage({ kept: [] }); await openInfo(none);
  assert.equal(none.d.querySelector('[aria-label="From your code"]'), null);
  const old = pipsPage({ apiVersion: 63 }); await openInfo(old);
  assert.equal(old.d.querySelector('[aria-label="From your code"]'), null);
  assert.equal(old.requests("list_pip_templates").length, 0);
});

test("the host sends them from API 64, and the events your app sent from API 63", () => {
  for (const api of [62, 63, 64]) {
    const posted = [], sent = [];
    const editor = new viewModule.PipsEditor({}, (m) => { sent.push(m); return true; }, () => {});
    editor.attach((m) => posted.push(m));
    editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
    editor.receive({ type: "pipsRequest", id: "l", request: { type: "list_pip_templates", pip_id: PIP } });
    editor.receive({ type: "pipsRequest", id: "d", request: { type: "decide_pip_template_change", change_id: CHANGE, decision: "accept", expected_digest: DIGEST } });
    editor.receive({ type: "pipsRequest", id: "e", request: { type: "list_app_events", app: "shop", limit: 20 } });
    const kinds = sent.map((m) => m.request?.type);
    assert.equal(kinds.includes("list_pip_templates"), api >= 64, `API ${api}`);
    assert.equal(kinds.includes("decide_pip_template_change"), api >= 64, `API ${api}`);
    assert.equal(kinds.includes("list_app_events"), api >= 63, `API ${api}: the Routines form's suggestions`);
    if (api < 64) assert.match(posted.find((m) => m.id === "l").error.message, /Update DGC to see what your code keeps for a Pip/);
  }
});

test("what the page shows is checked first", () => {
  assert.equal(templates.templatePage({ templates: [] }, PIP), null);
  assert.deepEqual(templates.templatePage({ templates: [TEMPLATE(WAITING)] }, PIP).waiting.items.map((i) => i.kind), ["tool", "always_allow", "routine"]);
  for (const bad of [{ templates: [TEMPLATE(), TEMPLATE()] }, { templates: [{ ...TEMPLATE(), pip_id: "pip_" + "b".repeat(32) }] },
    { templates: [{ ...TEMPLATE(), key: "Bad Key" }] }, { templates: [TEMPLATE({ ...WAITING, id: "x" })] },
    { templates: [TEMPLATE({ ...WAITING, items: [] })] }, { templates: [TEMPLATE({ ...WAITING, items: [{ kind: "secret", words: "x" }] })] },
    { templates: [TEMPLATE({ ...WAITING, status: "accepted" })] }, {}])
    assert.throws(() => templates.templatePage(bad, PIP));
  const markup = templates.templateMarkup(templates.templatePage({ templates: [TEMPLATE(WAITING)] }, PIP),
    { esc: (v) => String(v).replace(/</g, "&lt;"), pipName: "<b>Ava</b>" });
  assert.doesNotMatch(markup, /<b>/, "words are text");
});
