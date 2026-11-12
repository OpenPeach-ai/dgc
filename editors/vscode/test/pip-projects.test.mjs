// @ a project in a Personal Pip's chat (pips-21, Pips API 91), the page's side (src/pipsClient.js, src/pipProjects.js,
// media/mentions.js) in jsdom with the real client:
// - the @ list offers this computer's projects, each with a folder, only to a Personal Pip on a DGC that has them;
//   picking one puts a project mark in the message, and the message carries it as a display mention;
// - a Pip without a computer is told to get one first, with the button that opens the add-a-computer flow, and nothing
//   is sent; the same when DGC itself refuses the message for that;
// - what the Pip changed comes back as one card per project under its reply: the files with their counts, a link said
//   as one, each file's diff opening in place, and Apply (with the digest the card was drawn from), Discard (asked
//   first), Undo after Apply and Continue in Work, each sending exactly its command;
// - a change that moved since the card was drawn is read again and shown again, not applied;
// - DGC is asked what changed when the chat opens and when a reply lands, not on every look at the chat.
// (Harness from pip-borrow.)
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
const PW = "ws_" + "p".repeat(32), PIP = "pip_" + "a".repeat(32), RUN = "run_" + "c".repeat(32);
const SHOP = "ws_" + "5".repeat(32), SITE = "ws_" + "6".repeat(32);
const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index,
  name: id[0].toUpperCase() + id.slice(1), role: id, description: "Reads and reports", available: id !== "core",
  unavailable_reason: id === "core" ? "Core is the main chat." : null, default_name: id, default_goal: "Review",
  engine: id === "core" ? null : id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message",
  inherited_context_size: 1048576, effective_context_size: 8192, context_min: 2048, context_max: 32768,
  thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
const CHANGE = "pchange_" + "d".repeat(32);
const change = (over = {}) => ({ id: CHANGE, workspace_id: SHOP, name: "shop", status: "pending", files: [
  { path: "app.py", change: "modified", plus: 1, minus: 1 }, { path: "tests/test_app.py", change: "added", plus: 4, minus: 0 },
  { path: "README.md", change: "deleted", plus: 0, minus: 1 }], more: 0, digest: "digest-one", result: null, created_at: ago(30), updated_at: ago(30), ...over });
const DIFF = "--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,2 @@\n def total(items):\n-    return sum(items)\n+    return round(sum(items), 2)\n";

function pipsPage({ apiVersion = 91, computer = true, project = false, displayMentions = true, changes = [], choices = [{ workspace_id: SHOP, name: "shop" }, { workspace_id: SITE, name: "marketing site" }], activeRun = null } = {}) {
  const dom = new JSDOM(viewModule.pipsDocument(), { runScripts: "outside-only", pretendToBeVisual: true }), w = dom.window; windows.push(w);
  const sent = [], answered = new Set(), state = { changes, activeRun, messages: null };
  w.HTMLCanvasElement.prototype.getContext = () => null; w.TextEncoder = TextEncoder;
  w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m), getState: () => undefined, setState: () => {} });
  w.eval(client);
  const pip = { id: PIP, workspace_id: PW, pip_type: project ? "rook" : "scout", name: "Ava", goal: "Help with my shop.", source_policy: { mode: project ? "committed_only" : "personal" },
    source_ref: "HEAD", status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null,
    proposals: [], pending_review_count: 0, profile: { title: "", body: null, color: null, notify: true }, ...(computer ? { computer_plan: { schema_version: 1 } } : {}) };
  state.messages = [
    { id: "message_" + "1".repeat(32), pip_id: PIP, workspace_id: PW, run_id: RUN, role: "user", text: "Make total round to cents", model: "m", created_at: ago(90), status: "succeeded" },
    { id: "message_" + "2".repeat(32), pip_id: PIP, workspace_id: PW, run_id: RUN, role: "assistant", text: "Done in my copy: total rounds to cents now.", model: "m", created_at: ago(60), status: "succeeded" }];
  const message = (data) => w.dispatchEvent(new w.MessageEvent("message", { data }));
  const answer = (m, result, ok = true) => { answered.add(m.id); message({ type: "pipsReply", id: m.id, ok, ...(ok ? { result } : { error: typeof result === "string" ? { message: result } : result }) }); };
  const requests = (type) => sent.filter((m) => m.type === "pipsRequest" && m.request.type === type);
  const runner = { runner_id: "runner", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } };
  const held = new Set();     // commands a test answers by hand
  const defaults = (r) => ({ list_workspaces: () => ({ workspaces: [{ id: PW, name: project ? "garden" : "Personal", kind: project ? "project" : "personal" }], current_workspace_id: PW }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pips: () => ({ pips: [pip] }), get_pip: () => ({ pip }),
    list_pip_runs: () => ({ runs: [] }), list_pip_starters: () => ({ starters: [] }), get_pip_runner: () => ({ runner }),
    get_workspace_context: () => ({ context: { workspace_id: PW, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: PW, messages: state.messages, next_before_id: null, active_run: state.activeRun, history_context_omitted_count: 0, chat_controls: controls }),
    get_pip_computer: () => ({ computer: { pip_id: PIP, granted: computer, available: true, reason: "", pending: 0, actions: [] } }),
    list_pip_app_links: () => ({ pip_id: PIP, links: [], composio: true }), list_pip_message_drafts: () => ({ drafts: [], next_cursor: null }),
    list_pip_calendar_drafts: () => ({ drafts: [], next_cursor: null }), list_pip_connector_drafts: () => ({ drafts: [], next_cursor: null }),
    get_pip_digest: () => undefined, list_pip_routines: () => ({ pip_id: PIP, workspace_id: PW, routines: [] }),
    list_pip_shared: () => ({ pip_id: PIP, workspace_id: PW, kind: r.kind, items: [] }), get_pip_computers: () => null, list_pip_apps: () => ({ apps: [] }),
    list_pip_action_grants: () => ({ pip_id: PIP, grants: [] }), list_pip_plugins: () => ({ pip_id: PIP, plugins: [], installed: [] }),
    list_pip_notes: () => ({ pip_id: PIP, notes: [], max: 60 }), list_pip_sites: () => ({ pip_id: PIP, careful: true, sites: [] }),
    list_pip_logins: () => ({ logins: [] }), list_pip_keys: () => ({ pip_id: PIP, keys: [] }),
    get_pip_eyes: () => ({ eyes: { pip_id: PIP, model: "m", sees: true, choice: "ask", vision_model: null } }),
    list_pip_attention: () => ({ as_of: ago(0), total: 0, counts: {}, by_pip: {}, items: [], truncated: false }),
    get_pip_working_notes: () => ({ pip_id: PIP, lines: [], text: "", max_lines: 60, max_bytes: 6000, bytes: 0, revision: "r0", updated_at: null }),
    list_pip_daily_log: () => ({ pip_id: PIP, days: [], next_before: null }),
    get_pip_level: () => ({ pip_id: PIP, level: "approve", default: "ask", levels: [], on_its_own: [] }),
    list_pip_borrows: () => ({ pip_id: PIP, minutes: 10, borrows: [] }),
    list_pip_project_choices: () => ({ projects: choices }),
    list_pip_project_changes: () => ({ pip_id: PIP, changes: state.changes }) }[r.type]?.());
  async function drain() { for (let n = 0; n < 15; n++) { await flush(); for (const m of sent.filter((m) => m.type === "pipsRequest" && !answered.has(m.id) && !held.has(m.request.type))) { const result = defaults(m.request); if (result !== undefined) answer(m, result); } } }
  message({ type: "pipsConnection", apiVersion, generation: 1, connected: true, supported: true, enabled: true, displayMentions });
  const d = w.document;
  const click = (s) => { const el = d.querySelector(s); assert.ok(el, "Missing " + s); el.click(); };
  /** Type into the Pip's box, as its own value and caret say it (media/mentions.js answers as a <textarea> does). */
  const type = (text) => { const box = d.getElementById("chatText"); assert.ok(box, "the chat's box"); box.focus(); box.value = text; box.setSelectionRange(text.length, text.length);
    box.dispatchEvent(new w.Event("input", { bubbles: true })); return box; };
  const rows = () => [...d.querySelectorAll("#chat-pop .pi")];
  const submit = () => d.getElementById("chat-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  return { w, d, sent, state, held, answer, requests, drain, click, type, rows, submit, message };
}
async function openChat(x) { await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain(); }
const plain = (v) => JSON.parse(JSON.stringify(v));
const card = (x, id = CHANGE) => x.d.querySelector(`[data-project-change="${id}"]`);

// ---- the @ list -------------------------------------------------------------------------------------------------

test("@ in a Personal Pip's chat offers this computer's projects, each with a folder", async () => {
  const x = pipsPage(); await openChat(x);
  x.type("Fix the totals in @"); await x.drain();
  assert.ok(x.rows().some((r) => /Reference a Pip/.test(r.textContent)), "the list is open (its other kinds are still there)");
  assert.deepEqual(plain(x.requests("list_pip_project_choices").at(-1)?.request ?? null), { type: "list_pip_project_choices", pip_id: PIP });
  const projects = x.rows().filter((r) => r.querySelector(".pi-kind")?.textContent === "Project");
  assert.deepEqual(projects.map((r) => r.querySelector(".pi-label").textContent.trim()), ["shop", "marketing site"]);
  for (const row of projects) assert.ok(row.querySelector(".pi-label .pi-project-mark svg"), "a folder before its name");
  assert.match(projects[0].querySelector(".pd").textContent, /private copy/i, "what picking it does");
  x.type("Fix the totals in @mark"); await x.drain();
  assert.deepEqual(x.rows().filter((r) => r.querySelector(".pi-kind")?.textContent === "Project").map((r) => r.querySelector(".pi-label").textContent.trim()), ["marketing site"], "narrowed by what is typed");
});

test("projects are offered only by a DGC that has them, only to a Personal Pip, and only when DGC keeps a message's marks", async () => {
  const offered = async (opts) => { const x = pipsPage(opts); await openChat(x); x.type("Look at @"); await x.drain();
    return { x, projects: x.rows().filter((r) => r.querySelector(".pi-kind")?.textContent === "Project").length }; };
  assert.equal((await offered({})).projects, 2, "a Personal Pip on a DGC that has them is offered both");
  for (const [why, opts] of [["an older DGC", { apiVersion: 90 }], ["a project's Pip", { project: true }], ["a DGC that keeps no marks", { displayMentions: false }]]) {
    const x = pipsPage(opts); await openChat(x);
    x.type("Look at @"); await x.drain();
    assert.equal(x.requests("list_pip_project_choices").length, 0, `${why} is never asked for projects`);
    assert.equal(x.rows().filter((r) => r.querySelector(".pi-kind")?.textContent === "Project").length, 0, `${why} offers none`);
    if (opts.displayMentions !== false) assert.equal(x.requests("list_pip_project_changes").length, 0, `${why} is never asked what changed`);
  }
});

test("picking a project puts its mark in the message, and the message carries it as a display mention with its workspace", async () => {
  const x = pipsPage(); await openChat(x);
  const box = x.type("Fix the totals in @sh"); await x.drain();
  const row = x.rows().find((r) => r.querySelector(".pi-kind")?.textContent === "Project");
  assert.ok(row, "the project is offered");
  row.click(); await flush();
  const pill = box.querySelector(".composer-pill.pill-project");
  assert.ok(pill, "a project mark in the box");
  assert.equal(pill.textContent, "shop");
  assert.ok(pill.querySelector(".composer-project-mark svg"), "with its folder");
  assert.equal(box.value, "Fix the totals in shop", "its name is the words the Pip reads");
  assert.equal(x.d.querySelector("[data-project-needs-computer]"), null, "a Pip with a computer is asked nothing");
  x.submit(); await flush();
  const sent = x.requests("send_pip_message").at(-1);
  assert.ok(sent, "sent");
  assert.equal(sent.request.text, "Fix the totals in shop");
  assert.deepEqual(plain(sent.request.display_mentions), [{ start: 18, kind: "project", label: "shop", identity: SHOP, wired: true }]);
  assert.ok(x.d.querySelector(".pip-message.user .sent-mention.pill-project"), "the sent message keeps the mark where it was");
});

// ---- a Pip without a computer --------------------------------------------------------------------------------------

test("a Pip without a computer: picking a project says to give it one first, with the button that adds it, and sends nothing", async () => {
  const x = pipsPage({ computer: false }); await openChat(x);
  const box = x.type("Fix the totals in @sh"); await x.drain();
  const row = x.rows().find((r) => r.querySelector(".pi-kind")?.textContent === "Project");
  assert.ok(row, "the project is still offered");
  row.click(); await flush();
  assert.equal(box.querySelector(".pill-project"), null, "no mark goes in");
  const ask = x.d.querySelector("[data-project-needs-computer]");
  assert.ok(ask, "it says what is missing");
  assert.equal(ask.querySelector("strong").textContent, "Give Ava a computer first: the project’s copy goes there.");
  assert.deepEqual([...ask.querySelectorAll("button")].map((b) => b.textContent), ["Give it a computer", "Not now"]);
  assert.equal(x.requests("send_pip_message").length, 0, "nothing was sent");
  x.click("[data-project-computer]"); await flush();
  assert.match(x.d.getElementById("review-title")?.textContent || "", /^Give Ava a computer\?$/, "the same add-a-computer flow its page has");
  assert.equal(x.d.querySelector("[data-project-needs-computer]"), null, "the line goes once the flow is open");
});

test("DGC refusing a message because the Pip has no computer shows the same line, and the message comes back to the box", async () => {
  const x = pipsPage(); await openChat(x);
  x.type("Fix the totals in @sh"); await x.drain();
  const row = x.rows().find((r) => r.querySelector(".pi-kind")?.textContent === "Project");
  assert.ok(row, "the project is offered");
  row.click(); await flush();
  x.held.add("send_pip_message");
  x.submit(); await flush();
  x.answer(x.requests("send_pip_message").at(-1), { code: "needs_computer", message: "Give Ava a computer first: the project's copy goes in its Files." }, false); await x.drain();
  const ask = x.d.querySelector("[data-project-needs-computer]");
  assert.ok(ask, "the same line as picking one");
  assert.equal(ask.querySelector("strong").textContent, "Give Ava a computer first: the project’s copy goes there.");
  assert.equal(x.d.getElementById("chatText").value, "Fix the totals in shop", "the message is back in the box");
  x.click("[data-project-computer-no]"); await flush();
  assert.equal(x.d.querySelector("[data-project-needs-computer]"), null, "Not now puts the line away");
});

// ---- the card --------------------------------------------------------------------------------------------------------

test("what the Pip changed is one card per project under its reply: the files, their counts, and a link said as one", async () => {
  const other = "pchange_" + "e".repeat(32);
  const x = pipsPage({ changes: [
    change({ files: [...change().files, { path: "vendor/tools", change: "link", plus: 0, minus: 0 }] }),
    change({ id: other, workspace_id: SITE, name: "marketing site", files: [{ path: "index.html", change: "modified", plus: 2, minus: 2 }], digest: "digest-site", created_at: ago(20), updated_at: ago(20) }),
    change({ id: "pchange_" + "f".repeat(32), status: "discarded", result: { left: [] }, created_at: ago(9000), updated_at: ago(8000) })] });
  await openChat(x);
  assert.deepEqual(plain(x.requests("list_pip_project_changes")[0]?.request ?? null), { type: "list_pip_project_changes", pip_id: PIP });
  const cards = [...x.d.querySelectorAll(".conversation-log [data-project-change]")];
  assert.deepEqual(cards.map((c) => c.dataset.projectChange), [CHANGE, other], "one card for each project, and none for what was decided before your last message");
  const el = card(x);
  assert.equal(el.getAttribute("aria-label"), "Changes to shop");
  assert.equal(el.querySelector(".dgc-card-title").textContent, "Changes to shop");
  const reply = x.d.querySelector(".pip-message.assistant");
  assert.ok(reply.compareDocumentPosition(el) & x.w.Node.DOCUMENT_POSITION_FOLLOWING, "under the Pip's reply");
  const files = [...el.querySelectorAll(".pip-project-file")];
  assert.deepEqual(files.map((f) => f.dataset.projectPath), ["app.py", "tests/test_app.py", "README.md", "vendor/tools"]);
  assert.deepEqual(files.slice(0, 3).map((f) => [f.querySelector(".add-stat").textContent, f.querySelector(".del-stat").textContent]), [["+1", "−1"], ["+4", "−0"], ["+0", "−1"]]);
  assert.deepEqual(files.map((f) => f.querySelector(".pip-project-kind")?.textContent || ""), ["", "new", "removed", "a link, not applied"]);
  assert.equal(files[3].querySelector("button"), null, "a link the Pip made has no diff to open");
  assert.equal(el.querySelector(".pip-project-check").textContent, "Check the changes before you apply them.");
  assert.deepEqual([...el.querySelectorAll(".dgc-card-actions button")].map((b) => b.textContent), ["Apply", "Discard", "Continue in Work"]);
  assert.doesNotMatch(x.d.body.textContent, /\bAI\b/);
});

test("a file opens its diff in place, drawn as Work draws one, and is read once", async () => {
  const x = pipsPage({ changes: [change()] }); await openChat(x);
  x.held.add("get_pip_project_change");
  x.click(`[data-project-file="app.py"]`); await flush();
  const ask = x.requests("get_pip_project_change").at(-1);
  assert.deepEqual(plain(ask.request), { type: "get_pip_project_change", pip_id: PIP, change_id: CHANGE, path: "app.py" });
  assert.match(card(x).querySelector(".pip-project-file.open pre").textContent, /Loading/);
  x.answer(ask, { ...change(), path: "app.py", diff: DIFF }); await flush();
  const file = card(x).querySelector('.pip-project-file[data-project-path="app.py"]');
  assert.ok(file.classList.contains("diff") && file.classList.contains("open"), "Work's diff box, open");
  assert.equal(file.querySelector(".diff-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(file.querySelector("pre .add .dc").textContent, "+    return round(sum(items), 2)");
  assert.equal(file.querySelector("pre .del .dc").textContent, "-    return sum(items)");
  assert.equal(file.querySelector("pre .add .ln.new").textContent, "2", "with its line number");
  assert.equal(file.querySelector("pre .hh .dc").textContent, "--- a/app.py");
  x.click(`[data-project-file="app.py"]`); await flush();
  assert.equal(card(x).querySelector(".pip-project-file.open"), null, "a second click folds it");
  x.click(`[data-project-file="app.py"]`); await flush();
  assert.equal(x.requests("get_pip_project_change").length, 1, "what was read is kept while the change is the same");
  assert.ok(card(x).querySelector(".pip-project-file.open pre .add"));
});

test("Apply is your click, with the digest the card was drawn from; then what was applied, what was held back and why, and Undo", async () => {
  const x = pipsPage({ changes: [change()] }); await openChat(x);
  assert.equal(x.requests("apply_pip_project_change").length, 0, "nothing applies by itself");
  x.held.add("apply_pip_project_change"); x.held.add("undo_pip_project_change");
  x.click(`[data-project-apply="${CHANGE}"]`); await flush();
  const apply = x.requests("apply_pip_project_change").at(-1);
  assert.deepEqual(plain(apply.request), { type: "apply_pip_project_change", pip_id: PIP, change_id: CHANGE, expected_digest: "digest-one" });
  assert.equal(card(x).querySelector(`[data-project-apply="${CHANGE}"]`).textContent, "Applying…");
  assert.ok([...card(x).querySelectorAll(".dgc-card-actions button")].every((b) => b.disabled), "no second answer while it applies");
  const done = change({ status: "partial", updated_at: ago(0), result: { applied: ["app.py", "tests/test_app.py"], held_back: [{ path: "README.md", why: "You changed it in the meantime; yours is kept." }] } });
  x.state.changes = [done];
  x.answer(apply, done); await x.drain();
  const el = card(x);
  assert.equal(el.dataset.state, "partial");
  assert.equal(el.querySelector(".dgc-card-title").textContent, "Applied 2 files");
  assert.match(el.querySelector(".dgc-card-sub").textContent, /shop/);
  const held = [...el.querySelectorAll(".pip-project-held li")];
  assert.deepEqual(held.map((li) => [li.querySelector(".f").getAttribute("title"), li.querySelector(".pip-project-why").textContent]), [["README.md", "You changed it in the meantime; yours is kept."]]);
  assert.deepEqual([...el.querySelectorAll(".dgc-card-actions button")].map((b) => b.textContent), ["Undo"], "Undo beside it, and no second Apply");
  x.click(`[data-project-undo="${CHANGE}"]`); await flush();
  const undo = x.requests("undo_pip_project_change").at(-1);
  assert.deepEqual(plain(undo.request), { type: "undo_pip_project_change", pip_id: PIP, change_id: CHANGE });
  const undone = { ...done, status: "undone", updated_at: ago(0), result: { ...done.result, restored: ["app.py"], kept: [{ path: "tests/test_app.py", why: "You changed it after Apply; yours is kept." }] } };
  x.state.changes = [undone];
  x.answer(undo, undone); await x.drain();
  const after = card(x);
  assert.equal(after.dataset.state, "undone");
  assert.equal(after.querySelector(".dgc-card-title").textContent, "Undone");
  assert.match(after.querySelector(".dgc-card-sub").textContent, /1 file put back in shop/);
  assert.match(after.textContent, /tests\/test_app\.py.*You changed it after Apply; yours is kept\./s);
  assert.equal(after.querySelector("button"), null, "nothing left to answer");
});

test("Discard asks first, in the card; Keep leaves everything; Discard then sends its command and says Discarded", async () => {
  const x = pipsPage({ changes: [change()] }); await openChat(x);
  x.held.add("discard_pip_project_change");
  x.click(`[data-project-discard="${CHANGE}"]`); await flush();
  assert.equal(x.requests("discard_pip_project_change").length, 0, "asked first");
  assert.equal(card(x).querySelector(".pip-project-confirm").textContent, "The Pip’s changes in its copy go. Your project isn’t touched.");
  assert.deepEqual([...card(x).querySelectorAll(".dgc-card-actions button")].map((b) => b.textContent), ["Discard", "Keep"]);
  x.click(`[data-project-keep="${CHANGE}"]`); await flush();
  assert.equal(x.requests("discard_pip_project_change").length, 0);
  assert.deepEqual([...card(x).querySelectorAll(".dgc-card-actions button")].map((b) => b.textContent), ["Apply", "Discard", "Continue in Work"], "Keep puts the card back as it was");
  x.click(`[data-project-discard="${CHANGE}"]`); await flush();
  x.click(`[data-project-discard-yes="${CHANGE}"]`); await flush();
  const gone = x.requests("discard_pip_project_change").at(-1);
  assert.deepEqual(plain(gone.request), { type: "discard_pip_project_change", pip_id: PIP, change_id: CHANGE });
  const decided = change({ status: "discarded", updated_at: ago(0), result: { left: [] } });
  x.state.changes = [decided];
  x.answer(gone, decided); await x.drain();
  assert.equal(card(x).dataset.state, "discarded");
  assert.match(card(x).textContent, /^Discarded the changes to shop\.$/);
  assert.equal(card(x).querySelector("button"), null);
});

test("a change that moved since the card was drawn is not applied: it is read again and shown again, with why", async () => {
  const x = pipsPage({ changes: [change()] }); await openChat(x);
  x.held.add("apply_pip_project_change");
  const asked = x.requests("list_pip_project_changes").length;
  x.click(`[data-project-apply="${CHANGE}"]`); await flush();
  x.state.changes = [change({ digest: "digest-two", files: [...change().files, { path: "util.py", change: "added", plus: 1, minus: 0 }], updated_at: ago(0) })];
  x.answer(x.requests("apply_pip_project_change").at(-1), { code: "conflict", message: "The Pip changed more since you looked. Look at it again, then Apply." }, false); await x.drain();
  assert.equal(x.requests("list_pip_project_changes").length, asked + 1, "read again");
  const el = card(x);
  assert.equal(el.dataset.state, "pending");
  assert.deepEqual([...el.querySelectorAll(".pip-project-file")].map((f) => f.dataset.projectPath), ["app.py", "tests/test_app.py", "README.md", "util.py"], "shown again, as it is now");
  assert.equal(el.querySelector(".pip-project-moved").textContent, "The Pip changed more since you looked. Look at it again, then Apply.");
  assert.equal(el.querySelector(".dgc-card-error"), null, "said as what happened, not as a failure");
  x.click(`[data-project-apply="${CHANGE}"]`); await flush();
  assert.equal(x.requests("apply_pip_project_change").at(-1).request.expected_digest, "digest-two", "the next Apply carries the new digest");
});

test("Continue in Work asks the editor to open Work with this change, by its ids alone", async () => {
  const x = pipsPage({ changes: [change()] }); await openChat(x);
  x.held.add("open_pip_project_change_in_work");
  x.click(`[data-project-work="${CHANGE}"]`); await flush();
  const ask = x.requests("open_pip_project_change_in_work").at(-1);
  assert.ok(ask, "asked of the editor");
  assert.deepEqual(plain(ask.request), { type: "open_pip_project_change_in_work", pip_id: PIP, change_id: CHANGE });
  assert.equal(card(x).querySelector(`[data-project-work="${CHANGE}"]`).textContent, "Opening…");
  x.answer(ask, "Open shop in this window, then choose Continue in Work again.", false); await x.drain();
  assert.equal(card(x).querySelector(".dgc-card-error").textContent, "Open shop in this window, then choose Continue in Work again.", "why it didn't open, in the card");
  assert.equal(card(x).dataset.state, "pending", "and the change still waits");
});

test("DGC compares the copies when the chat opens and when a reply lands, not on every look at the chat", async () => {
  const x = pipsPage({ changes: [] }); await openChat(x);
  assert.equal(x.requests("list_pip_project_changes").length, 1, "when the chat opens");
  const look = async () => { const before = x.requests("list_pip_messages").length; x.message({ type: "pipsVisibility", visible: true }); await x.drain();
    assert.ok(x.requests("list_pip_messages").length > before, "(the chat was read again)"); };
  await look(); await look();
  assert.equal(x.requests("list_pip_project_changes").length, 1, "a look with nothing new asks nothing");
  // A reply is being written: nothing is compared while the Pip is still at work.
  x.state.messages = [...x.state.messages,
    { id: "message_" + "3".repeat(32), pip_id: PIP, workspace_id: PW, run_id: "run_" + "d".repeat(32), role: "user", text: "Also tidy util.py", model: "m", created_at: ago(5), status: "succeeded" }];
  x.state.activeRun = { id: "run_" + "d".repeat(32), pip_id: PIP, workspace_id: PW, status: "running", created_at: ago(5), started_at: ago(4) };
  await look();
  assert.equal(x.requests("list_pip_project_changes").length, 1, "not while its reply is being written");
  // The reply lands: a new message from the Pip, and no reply running.
  x.state.activeRun = null;
  x.state.messages = [...x.state.messages,
    { id: "message_" + "4".repeat(32), pip_id: PIP, workspace_id: PW, run_id: "run_" + "d".repeat(32), role: "assistant", text: "Tidied.", model: "m", created_at: ago(1), status: "succeeded" }];
  x.state.changes = [change({ created_at: ago(1), updated_at: ago(1) })];
  await look();
  assert.equal(x.requests("list_pip_project_changes").length, 2, "once more, for the reply that landed");
  assert.ok(card(x), "and its card is there");
});
