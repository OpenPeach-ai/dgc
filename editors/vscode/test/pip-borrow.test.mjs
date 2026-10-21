// Borrowing your own signed-in Chrome (Pips API 59), in a Personal Pip's chat: the card it asks with (the sites and why,
// Allow once and Not now, never Always allow), "Using your Chrome · site" with Stop while lent, the line it leaves when
// it gives it back, and an older DGC asked for nothing. (Harness from pip-levels.)
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
const borrow = load(await bundle("pipBorrow.js"));
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
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function pipsPage({ apiVersion = 59, borrows = [], activeRun = null } = {}) {
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
      next_before_id: null, active_run: activeRun, history_context_omitted_count: 0, chat_controls: controls }),
    get_pip_computer: () => ({ computer: { pip_id: PIP, granted: true, available: true, reason: "", pending: 0, actions: [] } }),
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
    get_pip_level: () => ({ pip_id: PIP, level: "approve", default: "ask", levels: [], on_its_own: [] }),
    list_pip_borrows: () => ({ pip_id: PIP, minutes: 10, borrows }) }[r.type]?.());
  async function drain() { for (let n = 0; n < 15; n++) { await flush(); for (const m of sent.filter((m) => m.type === "pipsRequest" && !answered.has(m.id))) { const result = defaults(m.request); if (result !== undefined) answer(m, result); } } }
  message({ type: "pipsConnection", apiVersion, generation: 1, connected: true, supported: true, enabled: true });
  const click = (s) => { const el = w.document.querySelector(s); assert.ok(el, "Missing " + s); el.click(); };
  return { w, d: w.document, sent, answer, requests, drain, click };
}
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const BORROW = "pipborrow_" + "b".repeat(32);
const card = (over = {}) => ({ id: BORROW, pip_id: PIP, workspace_id: PW, status: "requested", sites: ["shop.example"],
  origins: ["https://shop.example"], why: "Read your order history to find the mug order.", reachable: true, unreachable: "",
  unattended: false, minutes: 10, chrome: "", ended: "", sent: [], created_at: ago(5), expires_at: "2099-01-01T00:00:00.000Z",
  allowed_at: null, started_at: null, ended_at: null, ...over });
async function openChat(x) { await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain(); }

test("the card says who wants your Chrome, where and why, once: Allow once and Not now, never Always allow", async () => {
  const x = pipsPage({ borrows: [card()] }); await openChat(x);
  const el = x.d.querySelector(`[data-borrow-card="${BORROW}"]`);
  assert.ok(el, "under its reply");
  assert.equal(el.getAttribute("aria-label"), "Let Ava use your Chrome?");
  assert.equal(el.querySelector("strong").textContent, "Let Ava use your Chrome?");
  assert.match(el.textContent, /Read your order history to find the mug order\./);
  assert.match(el.textContent, /Only on shop\.example, in a new tab of its own, for this one task \(10 minutes at most\)\. It never sees your other tabs, and you can stop it any time\. Chrome asks you too\./);
  assert.deepEqual([...el.querySelectorAll("button")].map((b) => b.textContent), ["Allow once", "Not now"]);
  assert.doesNotMatch(x.d.body.textContent, /Always allow/);
  assert.doesNotMatch(el.textContent, /\bAI\b/);
  x.click(`[data-borrow-allow="${BORROW}"]`); await flush();
  const allow = x.requests("allow_pip_borrow").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(allow.request)), { type: "allow_pip_borrow", pip_id: PIP, borrow_id: BORROW });
  x.answer(allow, { borrow: card({ status: "allowed", allowed_at: ago(0) }) }); await flush();
  assert.match(x.d.body.textContent, /Ava can use your Chrome once now\. Chrome asks you too: choose Allow there\./);
  const lent = x.d.querySelector(`[data-borrow-card="${BORROW}"]`);
  assert.equal(lent.dataset.state, "allowed");
  assert.match(lent.querySelector("strong").textContent, /^Using your Chrome · shop\.example$/);
  assert.equal(lent.querySelector(`[data-borrow-stop="${BORROW}"]`).textContent, "Stop");
});

test("while lent: Using your Chrome · site, with Stop, and the line it leaves when you stop it", async () => {
  const x = pipsPage({ borrows: [card({ status: "in_use", allowed_at: ago(4), started_at: ago(3), chrome: "Google Chrome" })] }); await openChat(x);
  const el = x.d.querySelector(`[data-borrow-card="${BORROW}"]`);
  assert.equal(el.dataset.state, "in_use");
  assert.equal(el.querySelector("strong").textContent, "Using your Chrome · shop.example");
  assert.match(el.textContent, /In a tab of its own\. It gives your Chrome back when it’s done, or after 10 minutes\./);
  x.click(`[data-borrow-stop="${BORROW}"]`); await flush();
  const stop = x.requests("stop_pip_borrow").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(stop.request)), { type: "stop_pip_borrow", pip_id: PIP, borrow_id: BORROW });
  x.answer(stop, { borrow: card({ status: "returned", ended: "stop", ended_at: ago(0), started_at: ago(3) }) }); await flush();
  const line = x.d.querySelector(`[data-borrow-card="${BORROW}"]`);
  assert.equal(line.tagName, "P");
  assert.equal(line.textContent, "Gave your Chrome back · you stopped it");
  assert.match(x.d.body.textContent, /Ava gave your Chrome back\./);
});

test("the line a borrow leaves: given back, or never used, in plain words, until you write again", async () => {
  const lines = (c) => { const m = borrow.borrowMarkup(c, { esc: (s) => String(s), pipName: "Ava" }); return m.replace(/<[^>]+>/g, ""); };
  assert.equal(lines(card({ status: "returned", ended: "done", ended_at: ago(1) })), "Gave your Chrome back");
  assert.equal(lines(card({ status: "returned", ended: "run_end", ended_at: ago(1) })), "Gave your Chrome back");
  assert.equal(lines(card({ status: "returned", ended: "timeout", ended_at: ago(1) })), "Gave your Chrome back · its 10 minutes ran out");
  assert.equal(lines(card({ status: "returned", ended: "chrome_no", ended_at: ago(1) })), "Ava didn’t use your Chrome: you chose Cancel when Chrome asked.");
  assert.equal(lines(card({ status: "returned", ended: "no_answer", ended_at: ago(1) })), "Ava didn’t use your Chrome: nobody answered Chrome in time.");
  assert.equal(lines(card({ status: "returned", ended: "done", ended_at: ago(1), sent: ["Searched on shop.example"] })),
    "Gave your Chrome back · sent at its level: Searched on shop.example");
  const shown = borrow.shownBorrows([card({ status: "returned", ended: "done", ended_at: ago(60) }), card({ id: "pipborrow_" + "c".repeat(32), status: "declined" }),
    card({ id: "pipborrow_" + "d".repeat(32), status: "expired" }), card({ id: "pipborrow_" + "e".repeat(32), status: "replaced" })],
    { lastUserAt: Date.now() - 120000 });
  assert.deepEqual(shown.map((c) => c.status), ["returned"], "Not now, a card that ran out and a replaced one go away");
  assert.deepEqual(borrow.shownBorrows([card({ status: "returned", ended: "done", ended_at: ago(60) })], { lastUserAt: Date.now() }), [],
    "once you write again, its reply follows instead");
  const x = pipsPage({ borrows: [card({ status: "returned", ended: "done", ended_at: ago(0), started_at: ago(20) })] }); await openChat(x);
  assert.equal(x.d.querySelector(`[data-borrow-card="${BORROW}"]`).textContent, "Gave your Chrome back");
});

test("Not now is one click; a card that can't reach your Chrome says how to turn it on; a reply still running waits", async () => {
  const x = pipsPage({ borrows: [card({ reachable: false, unreachable: "DGC can't reach your Chrome yet. Turn on remote debugging in the Chrome you use, once: open chrome://inspect/#remote-debugging in it (Chrome 144 or later) and allow it." })] });
  await openChat(x);
  assert.match(x.d.querySelector(".borrow-unreachable").textContent, /chrome:\/\/inspect\/#remote-debugging/);
  x.click(`[data-borrow-decline="${BORROW}"]`); await flush();
  const no = x.requests("decline_pip_borrow").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(no.request)), { type: "decline_pip_borrow", pip_id: PIP, borrow_id: BORROW });
  x.answer(no, { borrow: card({ status: "declined" }) }); await flush();
  assert.equal(x.d.querySelector(`[data-borrow-card="${BORROW}"]`), null);
  const busy = pipsPage({ borrows: [card()], activeRun: { id: RUN, status: "running", created_at: now } }); await openChat(busy);
  const el = busy.d.querySelector(`[data-borrow-card="${BORROW}"]`);
  assert.ok(el.querySelector(`[data-borrow-allow="${BORROW}"]`).disabled, "answered once its reply is done");
  assert.match(el.textContent, /You can answer once its reply is done\./);
});

test("an older DGC shows no card and is asked for none; the host refuses the requests below API 59", async () => {
  const x = pipsPage({ apiVersion: 58, borrows: [card()] }); await openChat(x);
  assert.equal(x.requests("list_pip_borrows").length, 0);
  assert.equal(x.d.querySelector("[data-borrow-card]"), null);
  for (const api of [58, 59]) {
    const posted = [], sent = [];
    const editor = new viewModule.PipsEditor({}, (m) => { sent.push(m); return true; }, () => {});
    editor.attach((m) => posted.push(m));
    editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
    for (const type of ["list_pip_borrows", "allow_pip_borrow", "decline_pip_borrow", "stop_pip_borrow"]) {
      editor.receive({ type: "pipsRequest", id: type, request: { type, pip_id: PIP, ...(type === "list_pip_borrows" ? {} : { borrow_id: BORROW }) } });
    }
    if (api < 59) {
      assert.equal(sent.length, 0, `API ${api}`);
      assert.match(posted.find((m) => m.id === "allow_pip_borrow").error.message, /Update DGC to let a Pip borrow your Chrome/);
    } else {
      assert.equal(sent.length, 4, `API ${api}`);
    }
  }
});

test("a card that doesn't read as one is refused, never half shown", () => {
  assert.throws(() => borrow.borrowCard({ ...card(), status: "always" }, PIP));
  assert.throws(() => borrow.borrowCard({ ...card(), pip_id: "pip_" + "z".repeat(32) }, PIP));
  assert.throws(() => borrow.borrowCard({ ...card(), sites: [] }, PIP));
  assert.throws(() => borrow.borrowCard({ ...card(), origins: [] }, PIP));
  assert.deepEqual(borrow.borrowsPage({ pip_id: PIP, minutes: 10, borrows: [card()] }, PIP).map((c) => c.id), [BORROW]);
});
