// How much a Personal Pip asks (Pips API 58): the level chip in its prompt box (0.52: Ask me first, Approve for me, Do it
// all, a menu with a line each and "What it can do" last, the page following it), on its page the picker with the chosen
// level's one line, the short "What it did on its own" list right under it, one click back to Ask me first, the floor's
// card in its chat, and an older DGC asked for nothing. (Harness from pip-memory-learns.)
import { test, after } from "node:test";
import { readFileSync } from "node:fs";
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
const levels = load(await bundle("pipLevels.js"));
const careful = load(await bundle("pipCareful.js"));
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
const NAMES = { ask: "Ask me first", approve: "Approve for me", full: "Do it all" };
const level = (value, done = [], paying = undefined) => ({ pip_id: PIP, level: value, default: "ask",
  levels: ["ask", "approve", "full"].map((l) => ({ level: l, name: NAMES[l], says: SAYS[l] })), on_its_own: done,
  ...(paying ? { paying } : {}) });
const DONE = [{ at: now, what: "Added to cart on shop.teeforge.pip-test.example", level: "approve", unattended: false, kind: "computer" },
  { at: now, what: "Opened pip-test.example for the first time", level: "approve", unattended: true, kind: "site" }];
const floorHold = { id: "compact_" + "f".repeat(32), pip_id: PIP, workspace_id: PW, run_id: RUN, digest: "d".repeat(64), frame: null,
  status: "pending", created_at: now, expires_at: "2099-01-01T00:00:00.000Z", resolved_at: null, resolved_by: null, continuation_run_id: null,
  summary: { kind: "floor", method: "RUN", host: "Terminal", path: "/", page: "", fields: [{ name: "command", value: "rm -rf ~/*" }],
    more_fields: 0, body_bytes: 0, floor: "could delete everything in its Files", text: "rm -rf ~/*", text_digest: "e".repeat(64) } };
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function pipsPage({ apiVersion = 58, state = level("approve", DONE), actions = [], activeRun = null, pipPatch = {}, backupLine = "", models = [], fallback = { provider: "", model: "" }, fallbackOn = null, subscriptions = undefined } = {}) {
  const thePip = { ...pip, ...pipPatch };
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
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pips: () => ({ pips: [thePip] }), get_pip: () => ({ pip: thePip }),
    list_pip_runs: () => ({ runs: [] }), list_pip_starters: () => ({ starters: [] }), get_pip_runner: () => ({ runner }),
    get_workspace_context: () => ({ context: { workspace_id: PW, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models, connection: "configured", ...(subscriptions ? { subscriptions } : {}) }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: PW, messages: [
      { id: "message_" + "1".repeat(32), pip_id: PIP, workspace_id: PW, run_id: RUN, role: "user", text: "Tidy my files", model: "m", created_at: now, status: "succeeded" },
      { id: "message_" + "2".repeat(32), pip_id: PIP, workspace_id: PW, run_id: RUN, role: "assistant", text: "I want to clear the folder.", model: "m", created_at: now, status: "succeeded",
        ...(backupLine ? { backup: backupLine } : {}) }],
      next_before_id: null, active_run: activeRun, history_context_omitted_count: 0, chat_controls: controls, ...(fallbackOn ? { fallback_on: fallbackOn } : {}) }),
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
    get_pip_level: () => (typeof state === "function" ? state() : state),
    get_pip_backup: () => ({ backup: { pip_id: PIP, ...fallback } }),
    get_pips_backup: () => ({ backup: { provider: "", model: "" } }), get_pip_computers: () => null }[r.type]?.());
  async function drain() { for (let n = 0; n < 15; n++) { await flush(); for (const m of sent.filter((m) => m.type === "pipsRequest" && !answered.has(m.id))) { const result = defaults(m.request); if (result !== undefined) answer(m, result); } } }
  message({ type: "pipsConnection", apiVersion, generation: 1, connected: true, supported: true, enabled: true });
  const click = (s) => { const el = w.document.querySelector(s); assert.ok(el, "Missing " + s); el.click(); };
  return { w, d: w.document, sent, answer, requests, drain, click };
}
async function openInfo(x) { await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain(); x.click('[data-tab="job"]'); await x.drain(); }

test("a Pip's page shows how much it asks, the chosen level's line, and what it did on its own", async () => {
  const x = pipsPage(); await openInfo(x);
  const section = x.d.querySelector('[aria-label="How much it asks"]');
  assert.ok(section, "on its page");
  assert.deepEqual([...section.querySelectorAll("#pipLevel option")].map((o) => [o.value, o.textContent]),
    [["ask", "Ask me first"], ["approve", "Approve for me"], ["full", "Do it all"]]);
  assert.equal(section.querySelector("#pipLevel").value, "approve");
  assert.equal(section.querySelector("#pipLevelSays").textContent, SAYS.approve, "one plain line: what will and won't ask");
  const done = [...section.querySelectorAll("[data-on-its-own] li")].map((li) => li.textContent);
  assert.equal(done.length, 2);
  assert.match(done[0], /^Added to cart on shop\.teeforge\.pip-test\.example.*Approve for me$/);
  assert.match(done[1], /^Opened pip-test\.example for the first time.*Approve for me · nobody at the keyboard$/);
  assert.doesNotMatch(section.textContent, /\bAI\b/);
});

test("choosing a level is one change, and its line is said once as the notice; Ask is one click back", async () => {
  const x = pipsPage({ state: level("ask") }); await openInfo(x);
  assert.equal(x.d.querySelector("[data-on-its-own]"), null, "nothing done on its own yet: no list");
  const select = x.d.querySelector("#pipLevel");
  select.value = "full"; select.dispatchEvent(new x.w.Event("change", { bubbles: true })); await flush();
  const set = x.requests("set_pip_level").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(set.request)), { type: "set_pip_level", pip_id: PIP, level: "full" });
  x.answer(set, level("full", DONE)); await x.drain();
  assert.match(x.d.body.textContent, /Do it all: Does it all by itself, sends included\. Still asks before any payment\./);
  assert.equal(x.d.querySelector("#pipLevelSays").textContent, SAYS.full);
  x.click("[data-level-ask]"); await flush();
  assert.equal(x.requests("set_pip_level").at(-1).request.level, "ask");
});

// (The day's count, "at most 3 times a day across your Pips", was retired on 13 Nov: Let it pay now opens the Pip's own
// dollar limits under the rule. test/pip-pay-limits.test.mjs has them.)
test("at Do it all a Pip's page has its rule for payments: Ask by default, Let it pay, and then its limits (API 75)", async () => {
  const x = pipsPage({ apiVersion: 79, state: level("full", [], "ask") }); await openInfo(x);
  const select = x.d.querySelector("#pipPaying");
  assert.ok(select, "under its level");
  assert.deepEqual([...select.querySelectorAll("option")].map((o) => [o.value, o.textContent]), [["ask", "Ask me each time"], ["allow", "Let it pay"]]);
  assert.equal(select.value, "ask");
  assert.equal(select.getAttribute("aria-describedby"), "pipPayingSays");
  assert.equal(x.d.querySelector("#pipPayingSays").textContent, "Every payment waits for you on a card.");
  select.value = "allow"; select.dispatchEvent(new x.w.Event("change", { bubbles: true })); await flush();
  const set = x.requests("set_pip_paying").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(set.request)), { type: "set_pip_paying", pip_id: PIP, rule: "allow" });
  x.answer(set, level("full", [], "allow")); await x.drain();
  assert.equal(x.d.querySelector("#pipPaying").value, "allow");
  const says = "It pays by itself within the daily limit you set here. It never types a card number.";
  assert.equal(x.d.querySelector("#pipPayingSays").textContent, says, "no count: its own daily limit");
  assert.match(x.d.body.textContent, /Ava may now pay by itself, within its daily limit\./, "said once as the notice");
  assert.ok(x.d.querySelector("#pip-pay-form #payUsd"), "its limits open under the rule");
  assert.equal(x.requests("get_pips_payments").length, 0, "the count across all Pips is not read");
  for (const [api, state, why] of [[79, level("approve", [], "ask"), "below Do it all"], [74, level("full"), "an older DGC"]]) {
    const y = pipsPage({ apiVersion: api, state }); await openInfo(y);
    assert.ok(y.d.querySelector("#pipLevel"));
    assert.equal(y.d.querySelector("#pipPaying"), null, why + ": no rule to choose");
  }
  assert.throws(() => levels.levelPage(level("full", [], "maybe"), PIP), /didn’t load/);
});

// ---- the level chip in a Pip's prompt box (0.52, Pips package 5 and UI step 6)
const chip = (x) => x.d.querySelector("#chat-level");
const menuOf = (x) => x.d.querySelector(".composer-level-menu");
async function openChat(x) { await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain(); }
const press = (x, key) => { const at = x.d.activeElement; at.dispatchEvent(new x.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); };

test("a Pip's prompt box shows its level by name where Work's mode picker is, in place of the shield", async () => {
  const x = pipsPage({ state: level("ask") }); await openChat(x);
  const c = chip(x);
  assert.ok(c, "the level chip is in the prompt box");
  assert.ok(c.closest(".composer-left"), "at the left, as Work's mode picker");
  assert.equal(c.textContent.trim(), "Ask me first");
  assert.equal(c.getAttribute("aria-haspopup"), "menu");
  assert.equal(c.getAttribute("aria-label"), "Before Ava acts: Ask me first");
  assert.ok(c.querySelector("svg"), "with the shield");
  assert.equal(x.d.querySelector("#chat-permissions"), null, "one shield, not two: the chip replaces it");
});

test("its menu: a line for each level, the chosen one checked, and What this Pip can do last", async () => {
  const x = pipsPage({ state: level("ask") }); await openChat(x);
  const asked = x.requests("get_pip_level").length;
  x.click("#chat-level"); await x.drain();
  assert.ok(x.requests("get_pip_level").length > asked, "opening it reads the level again, so it is never stale");
  const menu = menuOf(x);
  assert.ok(menu && menu.classList.contains("dgc-menu"), "the shared menu");
  assert.equal(menu.getAttribute("role"), "menu");
  assert.equal(chip(x).getAttribute("aria-expanded"), "true");
  assert.equal(menu.querySelector(".dgc-menu-head").textContent.trim(), "Before Ava acts");
  const rows = [...menu.querySelectorAll("[data-pip-level-pick]")];
  assert.deepEqual(rows.map((r) => [r.dataset.pipLevelPick, r.querySelector(".dgc-menu-label").textContent, r.querySelector(".dgc-menu-sub").textContent]),
    ["ask", "approve", "full"].map((l) => [l, NAMES[l], SAYS[l]]));
  assert.deepEqual(rows.map((r) => [r.getAttribute("role"), r.getAttribute("aria-checked")]),
    [["menuitemradio", "true"], ["menuitemradio", "false"], ["menuitemradio", "false"]]);
  assert.ok(rows[0].querySelector(".dgc-menu-check"), "a check on the chosen level");
  const all = [...menu.querySelectorAll(".dgc-menu-row")];
  assert.equal(all.at(-1).textContent.trim(), "What Ava can do", "the last row");
  assert.equal(all.at(-1).getAttribute("role"), "menuitem");
  assert.equal(x.d.activeElement, rows[0], "focus on the chosen level");
  press(x, "ArrowDown"); assert.equal(x.d.activeElement, rows[1]);
  press(x, "End"); assert.equal(x.d.activeElement, all.at(-1));
  press(x, "Escape"); await flush();
  assert.equal(menuOf(x), null, "Escape closes it");
  assert.equal(x.d.activeElement, chip(x), "and puts focus back on the chip");
  x.click("#chat-level"); await x.drain();
  x.d.querySelector(".composer-level-menu [data-pip-level-what]").click(); await x.drain();
  assert.equal(menuOf(x), null);
  assert.match(x.d.body.textContent, /What Ava can do/, "the dialog the shield opened");
  assert.match(x.d.body.textContent, /Anything it would send, submit or change waits for your Allow/);
});

test("choosing a level in the chip changes it, says its line once, and the page follows; the page's change shows in the chip", async () => {
  let saved = level("ask");                    // what DGC keeps: every read after a change answers with it
  const x = pipsPage({ state: () => saved }); await openChat(x);
  x.click("#chat-level"); await x.drain();
  x.d.querySelector('[data-pip-level-pick="approve"]').click(); await flush();
  const set = x.requests("set_pip_level").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(set.request)), { type: "set_pip_level", pip_id: PIP, level: "approve" });
  assert.equal(menuOf(x), null, "the menu closes on a choice");
  saved = level("approve"); x.answer(set, saved); await x.drain();
  assert.equal(chip(x).textContent.trim(), "Approve for me");
  assert.match(x.d.body.textContent, new RegExp(`Approve for me: ${SAYS.approve.replace(/[.]/g, "\\.")}`), "its line, once, as the notice");
  assert.equal(x.d.activeElement, chip(x), "focus back on the chip");
  x.click('[data-tab="job"]'); await x.drain();
  assert.equal(x.d.querySelector("#pipLevel").value, "approve", "the page agrees");
  const select = x.d.querySelector("#pipLevel");
  select.value = "full"; select.dispatchEvent(new x.w.Event("change", { bubbles: true })); await flush();
  saved = level("full"); x.answer(x.requests("set_pip_level").at(-1), saved); await x.drain();
  x.click("#simple-to-chat"); await x.drain();               // back to its chat
  assert.equal(chip(x).textContent.trim(), "Do it all", "the chip agrees with the page");
  x.click("#chat-level"); await x.drain();
  assert.equal(x.d.querySelector('[data-pip-level-pick="full"]').getAttribute("aria-checked"), "true");
  x.d.querySelector('[data-pip-level-pick="full"]').click(); await flush();
  assert.equal(x.requests("set_pip_level").length, 2, "choosing the level it already has changes nothing");
});

test("while a reply runs the chip still works: the change applies from its next step", async () => {
  const x = pipsPage({ state: level("ask"), activeRun: { id: RUN, status: "running", run_kind: "conversation" } }); await openChat(x);
  assert.ok(x.d.querySelector("#chat-stop"), "a reply is running");
  assert.equal(chip(x).disabled, false, "not locked while it works");
  x.click("#chat-level"); await x.drain();
  x.d.querySelector('[data-pip-level-pick="approve"]').click(); await flush();
  assert.equal(x.requests("set_pip_level").at(-1).request.level, "approve");
});

test("a Project Pip, an older DGC and a remote one keep the shield: no level chip", async () => {
  const project = pipsPage({ pipPatch: { source_policy: { mode: "committed" }, computer_plan: null } }); await openChat(project);
  assert.equal(chip(project), null, "a Project Pip always asks: nothing to choose");
  assert.ok(project.d.querySelector("#chat-permissions"), "its shield still says what it can do");
  const older = pipsPage({ apiVersion: 57 }); await openChat(older);
  assert.equal(chip(older), null);
  assert.ok(older.d.querySelector("#chat-permissions"));
});

test("a Project Pip on Pips API 80 has the chip too: its lines are about handoffs, no payments, and what its level took is listed", async () => {
  const PROJECT_SAYS = { ask: "Waits for you before every handoff it is sent: a review, a check or a fix.",
    approve: "Runs reviews it is sent, and checks you approved once, by itself. A fix or a new command waits for you.",
    full: "Also writes a fix in its own copy by itself; the diff waits as a card for you. Never changes your files, commits or pushes." };
  const projectLevel = (value, done = []) => ({ pip_id: PIP, kind: "project", level: value, default: "ask",
    levels: ["ask", "approve", "full"].map((l) => ({ level: l, name: NAMES[l], says: PROJECT_SAYS[l] })), on_its_own: done });
  const took = [{ at: now, what: "Reviewed: Assess return value", level: "approve", unattended: false, kind: "handoff" }];
  const patchProject = { source_policy: { mode: "committed" }, computer_plan: null };
  const older = pipsPage({ apiVersion: 79, pipPatch: patchProject, state: projectLevel("approve", took) }); await openChat(older);
  assert.equal(chip(older), null, "a runtime before API 80: a Project Pip keeps its shield");
  const x = pipsPage({ apiVersion: 80, pipPatch: patchProject, state: projectLevel("full", took) }); await openChat(x);
  assert.ok(chip(x), "the chip on a Project Pip");
  assert.match(chip(x).textContent, /Do it all/);
  const page = pipsPage({ apiVersion: 80, pipPatch: patchProject, state: projectLevel("full", took) }); await openInfo(page);
  assert.match(page.d.getElementById("pipLevelSays")?.textContent || "", /Never changes your files, commits or pushes/);
  assert.equal(page.d.getElementById("pipPaying"), null, "no payments rule on a Project Pip");
  assert.match(page.d.querySelector("[data-on-its-own]")?.textContent || "", /Reviewed: Assess return value/);
});

// ---- a backup model for Pips (API 76, Pips package 6)
test("a fallback model: the ⋯ beside a model in its picker, Main and Fallback pills, and the chip says so while it answers", async () => {
  // D14 (9 Nov): chosen where the main model is, one provider and one model; the old rows in Pips settings and on its page went.
  const MODELS = [{ id: "m", name: "m" }, { id: "spare", name: "spare" }];
  const x = pipsPage({ apiVersion: 76, models: MODELS }); await x.drain();
  x.click(`[data-job="${PIP}"]`); await x.drain();
  x.click("#chat-model"); await x.drain();
  assert.equal(x.requests("get_pip_backup").length >= 1, true, "opening the menu reads its fallback");
  const dots = x.d.querySelector('[data-chat-model-more="model:spare"]');
  assert.ok(dots, "a model DGC runs has a ⋯");
  assert.equal(dots.getAttribute("aria-label"), "More for spare");
  assert.equal(x.d.querySelector('[data-chat-model-more="default"]'), null, "Default has none: it follows, it isn't one model");
  assert.equal(x.d.querySelector(".dgc-menu-pill"), null, "no fallback yet: the check alone marks the model");
  // Right from the row reaches its ⋯, Left goes back.
  const row = x.d.querySelector('[data-chat-model="model:spare"]');
  row.focus(); row.dispatchEvent(new x.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(x.d.activeElement, x.d.querySelector('[data-chat-model-more="model:spare"]'), "Right: its ⋯");
  x.d.activeElement.dispatchEvent(new x.w.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  assert.equal(x.d.activeElement?.dataset.chatModel, "model:spare", "Left: the row again");
  x.click('[data-chat-model-more="model:spare"]'); await x.drain();
  const choices = [...x.d.querySelectorAll(".dgc-menu-choices button")].map((b) => b.textContent);
  assert.deepEqual(choices, ["Use as main", "Use as fallback"]);
  assert.equal(x.d.querySelector('[data-chat-model-more="model:spare"]').getAttribute("aria-expanded"), "true");
  x.click('[data-chat-fallback="model:spare"]'); await flush();
  const set = x.requests("set_pip_backup").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(set.request)), { type: "set_pip_backup", pip_id: PIP, model: "spare", provider: "" });
  x.answer(set, { backup: { pip_id: PIP, provider: "", model: "spare" } }); await x.drain();
  assert.match(x.d.body.textContent, /Ava carries on with spare when its own model doesn’t answer\./);
  assert.equal(x.d.querySelector(".dgc-menu-choices"), null, "its choices close");
  const pills = (value) => [...(x.d.querySelector(`[data-chat-model="${value}"]`)?.querySelectorAll(".dgc-menu-pill") || [])].map((p) => p.textContent);
  assert.deepEqual(pills("model:spare"), ["Fallback"]);
  assert.deepEqual(pills("default"), ["Main"], "the main model says Main once a fallback is set");
  x.click('[data-chat-model-more="model:spare"]'); await x.drain();
  assert.deepEqual([...x.d.querySelectorAll(".dgc-menu-choices button")].map((b) => b.textContent), ["Use as main", "Stop using as fallback"]);
  x.click('.dgc-menu-choices [data-chat-fallback=""]'); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(x.requests("set_pip_backup").at(-1).request)), { type: "set_pip_backup", pip_id: PIP, model: "", provider: "" });
  // Its own model out and its fallback answering: the chip names the fallback, in olive, with the word.
  const y = pipsPage({ apiVersion: 76, models: MODELS, fallback: { provider: "", model: "spare" }, fallbackOn: { model: "spare", since: now } });
  await y.drain(); y.click(`[data-job="${PIP}"]`); await y.drain();
  const chip = y.d.getElementById("chat-model");
  assert.ok(chip.classList.contains("on-fallback"));
  assert.equal(chip.querySelector(".composer-model-name").textContent, "spare");
  assert.equal(chip.querySelector(".composer-fallback-word").textContent, "fallback");
  assert.match(chip.title, /didn’t answer, so its fallback spare is answering\. It tries .+ again with your next message\./);
  // The old places are gone: no Models tab in Pips settings, no row on its page.
  const home = pipsPage({ apiVersion: 76, models: MODELS }); await home.drain();
  home.click("#pips-settings-open"); await home.drain();
  assert.ok(home.d.querySelector('[data-pips-settings="apps"]'), "Pips settings opened");
  assert.equal(home.d.querySelector('[data-pips-settings="models"]'), null);
  const z = pipsPage({ apiVersion: 76, models: MODELS }); await openInfo(z);
  assert.equal(z.d.getElementById("pipBackup"), null);
  // An older DGC: no ⋯, asked for nothing.
  const old = pipsPage({ apiVersion: 75, models: MODELS }); await old.drain();
  old.click(`[data-job="${PIP}"]`); await old.drain(); old.click("#chat-model"); await old.drain();
  assert.equal(old.d.querySelector("[data-chat-model-more]"), null);
  assert.equal(old.requests("get_pip_backup").length, 0);
});

test("Claude Code or Codex can be a Pip's fallback too (9 Nov): its rows have the ⋯", async () => {
  const x = pipsPage({ apiVersion: 76, models: [{ id: "m", name: "m" }], subscriptions: [{ engine: "claude", name: "Claude Code" }, { engine: "codex", name: "Codex" }] });
  await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain();
  x.click("#chat-model"); await x.drain();
  x.click("#chat-model-providers"); await x.drain();
  x.click('[data-chat-provider="subscription:claude"]'); await x.drain();
  assert.ok(x.d.querySelector('[data-chat-model-more="subscription:claude"]'), "Claude Code's own default has a ⋯");
  x.click('[data-chat-model-more="subscription:claude"]'); await x.drain();
  x.click('[data-chat-fallback="subscription:claude"]'); await flush();
  const set = x.requests("set_pip_backup").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(set.request)), { type: "set_pip_backup", pip_id: PIP, model: "", provider: "", engine: "claude" });
  x.answer(set, { backup: { pip_id: PIP, provider: "", model: "", engine: "claude" } }); await x.drain();
  assert.match(x.d.body.textContent, /Ava carries on with Claude Code when its own model doesn’t answer\./);
  assert.deepEqual([...x.d.querySelectorAll('[data-chat-model="subscription:claude"] .dgc-menu-pill')].map((p) => p.textContent), ["Fallback"]);
});

test("a fallback on a saved provider: the host saves that provider first, as for a Pip's main model", async () => {
  const sent = [], posted = [], saved = [];
  const editor = new viewModule.PipsEditor({}, (m) => { sent.push(m); return true; }, () => {}); editor.attach((m) => posted.push(m));
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: 76 }, {});
  const SPARE = "provider_" + "c".repeat(32);
  editor.useSavedProviders(async () => [], async (id, model) => { saved.push([id, model]); });
  editor.receive({ type: "pipsRequest", id: "f", request: { type: "set_pip_backup", pip_id: PIP, model: "gpt-oss:120b", provider: SPARE } });
  await flush(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(saved, [[SPARE, "gpt-oss:120b"]]);
  assert.equal(sent.at(-1).request.type, "set_pip_backup", "then it goes");
  const before = saved.length;
  editor.receive({ type: "pipsRequest", id: "g", request: { type: "set_pip_backup", pip_id: PIP, model: "spare", provider: "" } });
  await flush();
  assert.equal(saved.length, before, "DGC's own connection needs nothing saved");
});

test("the reply its backup answered carries one line before its time", async () => {
  const x = pipsPage({ apiVersion: 76, backupLine: "Its own model didn't answer; backup-model did" }); await x.drain();
  x.click(`[data-job="${PIP}"]`); await x.drain();
  const reply = [...x.d.querySelectorAll(".pip-message.assistant")].at(-1);
  assert.ok(reply, "the reply");
  assert.match(reply.querySelector(".msg-time, time")?.parentElement?.textContent || reply.textContent, /Its own model didn't answer; backup-model did · /);
});

test("an older DGC shows no level and is asked for none; the host refuses the requests below API 58", async () => {
  const x = pipsPage({ apiVersion: 57 }); await openInfo(x);
  assert.equal(x.d.querySelector('[aria-label="How much it asks"]'), null);
  assert.equal(x.requests("get_pip_level").length, 0);
  for (const api of [57, 58]) {
    const posted = [], sent = [];
    const editor = new viewModule.PipsEditor({}, (m) => { sent.push(m); return true; }, () => {});
    editor.attach((m) => posted.push(m));
    editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
    editor.receive({ type: "pipsRequest", id: "g", request: { type: "get_pip_level", pip_id: PIP } });
    editor.receive({ type: "pipsRequest", id: "s", request: { type: "set_pip_level", pip_id: PIP, level: "full" } });
    if (api < 58) {
      assert.equal(sent.length, 0, `API ${api}`);
      assert.match(posted.find((m) => m.id === "s").error.message, /Update DGC to choose how much a Pip asks/);
    } else {
      assert.equal(sent.length, 2, `API ${api}`);
    }
  }
});

test("the safety floor's card under its reply: run this once, in plain words", async () => {
  const words = careful.carefulWords(floorHold.summary, "Ava");
  assert.deepEqual(words, ["Let Ava run this in its Terminal?",
    "This command could delete everything in its Files: rm -rf ~/*. Nothing has run yet; Allow lets it run this once.", "Allow once"]);
  const x = pipsPage({ actions: [floorHold] }); await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain();
  const card = x.d.querySelector(`[data-computer-card="${floorHold.id}"]`);
  assert.ok(card, "the card is under its reply");
  assert.match(card.textContent, /Let Ava run this in its Terminal\?/);
  assert.match(card.querySelector(".primary").textContent, /Allow once/);
});

test("a card its level still asks for says why: a saved card's payment, at Do it all", async () => {
  const hold = { ...floorHold, id: "compact_" + "9".repeat(32), summary: { method: "POST", host: "pay.metropower.pip-test.example",
    path: "/api/pay-saved", page: "", fields: [{ name: "consumer", value: "1100223344" }, { name: "saved_card", value: "tok_saved_visa_4242" }],
    more_fields: 0, body_bytes: 60, asks_because: "payment" } };
  const x = pipsPage({ state: level("full"), actions: [hold] }); await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain();
  const card = x.d.querySelector(`[data-computer-card="${hold.id}"]`);
  assert.match(card.querySelector("strong").textContent, /^Pay on pay\.metropower\.pip-test\.example\?$/);
  assert.match(card.textContent, /It looks like a payment, so it asks at every level\. Nothing has been sent\..*consumer: 1100223344/);
  assert.deepEqual([...card.querySelectorAll(".dgc-chip:not(.dgc-chip-more)")].map((c) => c.textContent), ["consumer: 1100223344", "saved_card: tok_saved_visa_4242"], "what it pays, a chip for each field");
  assert.match(card.querySelector(".primary").textContent, /Review…/, "reviewed as any payment");
});

test("an order press asks every time like a payment: Send once, never Always allow (agreed 10 Nov)", async () => {
  const hold = { ...floorHold, id: "compact_" + "8".repeat(32), summary: { method: "POST", host: "shop.teeforge.pip-test.example",
    path: "/items/42", page: "", fields: [{ name: "item", value: "tee" }], more_fields: 0, body_bytes: 9,
    asks_because: "maybe_payment", asks_word: "order", route: "/items/*" } };
  const x = pipsPage({ state: level("approve"), actions: [hold] }); await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain();
  const card = x.d.querySelector(`[data-computer-card="${hold.id}"]`);
  assert.match(card.querySelector("strong").textContent, /^Send a form to shop\.teeforge\.pip-test\.example\?$/, "not a payment by its title");
  assert.match(card.textContent, /It may place an order, so it asks every time\. Nothing has been sent\./);
  assert.ok(card.querySelector("[data-computer-decide][data-approve='1']"), "Send once");
  assert.equal(card.querySelector("[data-computer-always]"), null, "no Always allow");
  assert.doesNotMatch(card.textContent, /Always allow/);
  const billing = { ...hold.summary, asks_word: "billing" };
  assert.equal(careful.asksEveryTime(hold.summary), true);
  assert.equal(careful.asksEveryTime(billing), false, "one money word alone still offers Always allow");
});

test("a card the fuse holds says so: 25 things on its own in the last hour, and until when", async () => {
  const hold = { ...floorHold, id: "compact_" + "8".repeat(32), summary: { method: "POST", host: "shop.pip-test.example", path: "/cart/add",
    page: "", fields: [{ name: "item", value: "tee" }], more_fields: 0, body_bytes: 9, asks_because: "fuse", fuse_until: "2026-11-09T07:12:00.000Z" } };
  assert.match(careful.asksWords(hold.summary), /^It has done 25 things on its own in the last hour, so it asks before each one until .+\.$/);
  assert.equal(careful.asksWords({ asks_because: "fuse" }), "It has done 25 things on its own in the last hour, so it asks before each one for now.");
  const x = pipsPage({ state: level("full"), actions: [hold] }); await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain();
  const card = x.d.querySelector(`[data-computer-card="${hold.id}"]`);
  assert.ok(card, "its card is under the reply");
  assert.match(card.textContent, /It has done 25 things on its own in the last hour, so it asks before each one until/);
});

test("the page's level is checked before it is shown", () => {
  const good = level("approve", DONE);
  assert.equal(levels.levelPage(good, PIP).level, "approve");
  for (const bad of [{ ...good, pip_id: "x" }, { ...good, level: "yolo" }, { ...good, levels: good.levels.slice(0, 2) },
    { ...good, on_its_own: [{ ...DONE[0], level: "ask" }] }, { ...good, on_its_own: [{ ...DONE[0], kind: "other" }] }])
    assert.throws(() => levels.levelPage(bad, PIP));
  assert.equal(levels.levelNotice(levels.levelPage(good, PIP)), `Approve for me: ${SAYS.approve}`);
});

test("A Pip's prompt box: its model name, a fallback's word and its reasoning share one text baseline", () => {
  // Centred boxes of different sizes put the 11px reasoning a pixel below the 12px name (seen in Work, 9 Nov).
  const css = readFileSync(new URL("../src/pips.css", import.meta.url), "utf8");
  const rule = css.match(/(?:^|\})\s*\.model-copy\{([^}]*)\}/);
  assert.ok(rule, "the prompt box's text row has its rule");
  assert.match(rule[1], /align-items:baseline/);
  assert.match(css.match(/\.composer-fallback-word\{([^}]*)\}/)[1], /margin:0 2px;/, "the word has the same room on both sides");
  assert.match(css, /\.pip-composer \.model-control\.on-fallback \.composer-chevron\{color:var\(--err-text\);opacity:\.7\}/, "its chevron as Work's and ChatDGC's");
});

test("A Pip's model rows: a long name stays on one line, slides while pointed at, and its whole name is its tooltip (9 Nov)", async () => {
  const x = pipsPage({ apiVersion: 76, models: [{ id: "deepseek-v4.1-flash:cloud", name: "deepseek-v4.1-flash:cloud" }] });
  await x.drain(); x.click(`[data-job="${PIP}"]`); await x.drain();
  x.click("#chat-model"); await x.drain();
  const label = x.d.querySelector('[data-chat-model="model:deepseek-v4.1-flash:cloud"] .composer-model-row');
  assert.ok(label.classList.contains("dgc-menu-label"), "one line, its … at rest");
  assert.equal(label.getAttribute("title"), "deepseek-v4.1-flash:cloud");
});
