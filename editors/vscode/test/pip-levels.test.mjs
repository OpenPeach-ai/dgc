// How much a Personal Pip asks (Pips API 58): the level chip in its prompt box (0.52: Ask me first, Approve for me, Do it
// all, a menu with a line each and "What it can do" last, the page following it), on its page the picker with the chosen
// level's one line, the short "What it did on its own" list right under it, one click back to Ask me first, the floor's
// card in its chat, and an older DGC asked for nothing. (Harness from pip-memory-learns.)
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
const level = (value, done = []) => ({ pip_id: PIP, level: value, default: "ask",
  levels: ["ask", "approve", "full"].map((l) => ({ level: l, name: NAMES[l], says: SAYS[l] })), on_its_own: done });
const DONE = [{ at: now, what: "Added to cart on shop.teeforge.pip-test.example", level: "approve", unattended: false, kind: "computer" },
  { at: now, what: "Opened pip-test.example for the first time", level: "approve", unattended: true, kind: "site" }];
const floorHold = { id: "compact_" + "f".repeat(32), pip_id: PIP, workspace_id: PW, run_id: RUN, digest: "d".repeat(64), frame: null,
  status: "pending", created_at: now, expires_at: "2099-01-01T00:00:00.000Z", resolved_at: null, resolved_by: null, continuation_run_id: null,
  summary: { kind: "floor", method: "RUN", host: "Terminal", path: "/", page: "", fields: [{ name: "command", value: "rm -rf ~/*" }],
    more_fields: 0, body_bytes: 0, floor: "could delete everything in its Files", text: "rm -rf ~/*", text_digest: "e".repeat(64) } };
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function pipsPage({ apiVersion = 58, state = level("approve", DONE), actions = [], activeRun = null, pipPatch = {} } = {}) {
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
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: PW, messages: [
      { id: "message_" + "1".repeat(32), pip_id: PIP, workspace_id: PW, run_id: RUN, role: "user", text: "Tidy my files", model: "m", created_at: now, status: "succeeded" },
      { id: "message_" + "2".repeat(32), pip_id: PIP, workspace_id: PW, run_id: RUN, role: "assistant", text: "I want to clear the folder.", model: "m", created_at: now, status: "succeeded" }],
      next_before_id: null, active_run: activeRun, history_context_omitted_count: 0, chat_controls: controls }),
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
    get_pip_level: () => (typeof state === "function" ? state() : state) }[r.type]?.());
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
  assert.match(card.textContent, /consumer 1100223344.*It looks like a payment, so it asks at every level\. Nothing has been sent\./);
  assert.match(card.querySelector(".primary").textContent, /Review…/, "reviewed as any payment");
});

test("the page's level is checked before it is shown", () => {
  const good = level("approve", DONE);
  assert.equal(levels.levelPage(good, PIP).level, "approve");
  for (const bad of [{ ...good, pip_id: "x" }, { ...good, level: "yolo" }, { ...good, levels: good.levels.slice(0, 2) },
    { ...good, on_its_own: [{ ...DONE[0], level: "ask" }] }, { ...good, on_its_own: [{ ...DONE[0], kind: "other" }] }])
    assert.throws(() => levels.levelPage(bad, PIP));
  assert.equal(levels.levelNotice(levels.levelPage(good, PIP)), `Approve for me: ${SAYS.approve}`);
});
