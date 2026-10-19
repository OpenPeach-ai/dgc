// The chip line (B2): with two or more kinds of work showing above the prompt box -- the goal, a troupe, monitors,
// the checklist, this chat's changes, the Pips digest -- each is one chip on a single line, and a chip opens its
// kind's REAL row (the same element, with every control it has) in a popover above the box. One kind alone keeps its
// full row. Whatever needs you turns its chip amber and says why. Real geometry (the 36px line, the popover's place,
// wrapping at 300px, reduced motion) is rail-chips-layout.test.mjs's, in Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const READY = { type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1,
  capabilities: { agents: true, agent_control: true } };
const TROUPE = { run_id: "tr-0123456789", title: "Review every API handler", state: "running", reason: "", agents_planned: 11,
  reused: 0, journal: "/home/me/.dgc/troupes/tr-0123456789",
  stages: [{ name: "review", total: 8, done: 5, failed: 0, kept: 0 }, { name: "verify", total: 0, done: 0, failed: 0, kept: 0 }] };
const TODOS = [{ content: "Read the settings store", status: "done" }, { content: "Write the migration", status: "done" },
  { content: "Migrate back down", status: "done" }, { content: "Tests for both directions", status: "done" },
  { content: "Fix the save handler", status: "in_progress" }, { content: "Run lint", status: "pending" },
  { content: "Update the changelog", status: "pending" }];
const MONITORS = (extra = {}) => ({ type: "monitors", wake_paused: false, pending_events: 0, items: [
  { id: "mon1", description: "Watch the dev server log", command: "tail -f logs/dev.log", state: "running", events: 14 },
  { id: "mon2", description: "CI on PR #482", command: "gh pr checks 482 --watch", state: "running", events: 3 }], ...extra });

function chat(options = {}) {
  const v = makeDom(options);
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  event(READY);
  v.send({ type: "session_ready", sessionId: "s1" });
  const chips = () => [...v.doc.querySelectorAll("#rail-chips .rail-chip")];
  const chip = (kind) => v.doc.querySelector(`#rail-chips .rail-chip[data-kind="${kind}"]`);
  const face = (kind) => [...chip(kind).querySelectorAll(".chip-word, .chip-num, .chip-extra, .chip-need")].map((n) => n.textContent).join(" ");
  const key = (target, name, extra = {}) => {
    const e = new v.dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(e);
    return e;
  };
  const press = (target) => target.dispatchEvent(new v.dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
  const posts = (type) => v.posted.filter((m) => m.type === type).map((m) => JSON.parse(JSON.stringify(m)));
  const pile = ({ goal = true, troupe = true, monitors = true, tasks = true, changes = true } = {}) => {
    event({ type: "turn_start", turn_id: "t1", prompt: "Ship the settings migration", kind: "prompt" });
    if (goal) event({ type: "goal_changed", goal: "Ship the settings migration and harden the auth flow", status: "active", elapsed_seconds: 4320, details: {} });
    if (troupe) event({ type: "troupe_started", ...TROUPE });
    if (monitors) event(MONITORS());
    if (tasks) event({ type: "todos", todos: TODOS });
    if (changes) v.send({ type: "chat_changes", sessionId: "", total: 6, additions: 214, deletions: 37,
      files: [{ path: "src/settings.ts" }, { path: "test/settings.test.ts" }] });
  };
  const open = () => !$("rail-pop").hidden;
  const inPop = (id) => $("rail-pop-body").contains($(id));
  return { ...v, event, $, chips, chip, face, key, press, posts, pile, open, inPop };
}

test("one kind keeps its full row; a second folds both into one line of chips, in a fixed order", () => {
  const c = chat();
  c.pile({ goal: false, monitors: false, tasks: false, changes: false });
  assert.equal(c.$("composer-rail").hidden, false, "a troupe alone: today's full row");
  assert.equal(c.$("composer-rail").classList.contains("as-chips"), false);
  assert.equal(c.$("rail-chips").hidden, true, "and no chip line");
  assert.equal(c.chips().length, 0);

  c.event({ type: "todos", todos: TODOS });
  assert.equal(c.$("rail-chips").hidden, false, "two kinds: chips");
  assert.equal(c.$("composer-rail").classList.contains("as-chips"), true);
  assert.equal(c.$("composer-rail").hidden, true, "the rail holds nothing else");
  assert.equal(c.$("troupebar").hidden, false, "the rows are still there, folded into their chips");
  assert.equal(c.$("troupebar").parentElement, c.$("composer-rail"));

  c.event({ type: "goal_changed", goal: "Ship it", status: "active", elapsed_seconds: 4320, details: {} });
  c.event(MONITORS());
  c.send({ type: "chat_changes", sessionId: "", total: 6, additions: 214, deletions: 37, files: [{ path: "a.ts" }] });
  assert.deepEqual(c.chips().map((n) => n.dataset.kind), ["goal", "troupe", "monitors", "tasks", "changes"]);
  assert.equal(c.face("goal"), "Goal 1:12:00");
  assert.equal(c.face("troupe"), "Troupe 5/8");
  assert.equal(c.face("monitors"), "2 monitors");
  assert.equal(c.face("tasks"), "Tasks 4/7");
  assert.equal(c.face("changes"), "6 files +214 −37");
  assert.ok(c.chip("troupe").querySelector(".chip-mark svg .tm-part"), "the troupe's own mark");
  assert.equal(c.chip("troupe").querySelector(".chip-mini > span").style.width, "63%");
  assert.equal(c.chip("goal").getAttribute("aria-label"), "Goal, pursuing: Ship it");
  assert.equal(c.chip("changes").getAttribute("aria-label"), "6 files changed in this chat, 214 lines added, 37 lines removed");
  for (const node of c.chips()) {
    assert.equal(node.getAttribute("aria-haspopup"), "dialog");
    assert.equal(node.getAttribute("aria-expanded"), "false");
    assert.equal(node.getAttribute("aria-controls"), "rail-pop");
  }
  // Gradient ids are found by id: the chip's copy of the mark has its own, or it draws as flat tiles.
  const ids = [...c.doc.querySelectorAll("[id]")].map((n) => n.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "no id twice in the page");
  assert.equal(c.$("rail-chips").getAttribute("role"), "toolbar");
  assert.deepEqual(c.errors, []);
});

test("a chip opens its kind's real row in the popover: the stages come open, Stop works, Esc puts it all back", () => {
  const c = chat();
  c.pile();
  const before = [...c.$("composer-rail").children].map((n) => n.id);
  c.chip("troupe").focus();
  c.chip("troupe").click();
  assert.equal(c.open(), true);
  assert.equal(c.$("troupebar").parentElement, c.$("rail-pop-body"), "the row itself, not a copy");
  assert.equal(c.$("rail-pop-title").textContent, "Troupe");
  assert.equal(c.chip("troupe").getAttribute("aria-expanded"), "true");
  assert.equal(c.$("troupe-panel").hidden, false, "the stages come open");
  assert.equal(c.$("troupe-main").getAttribute("aria-expanded"), "true");
  assert.equal(c.doc.activeElement, c.$("troupe-main"), "focus moves into the popover, to the row's own main control");
  assert.deepEqual([...c.$("rail-pop-links").querySelectorAll("button")].map((b) => b.textContent),
    ["Open the journal", "Show in the agent map"]);

  // The row keeps updating while it is in the popover.
  c.event({ type: "troupe_progress", ...TROUPE, stages: [{ name: "review", total: 8, done: 7, failed: 0, kept: 0 }, TROUPE.stages[1]] });
  assert.equal(c.$("troupe-count").textContent, "review 7/8");
  assert.equal(c.face("troupe"), "Troupe 7/8", "and so does its chip");

  c.$("troupe-stop").click();
  assert.deepEqual(c.posts("stopTroupe"), [{ type: "stopTroupe", run_id: "tr-0123456789" }]);

  const esc = c.key(c.doc.activeElement, "Escape");
  assert.equal(esc.defaultPrevented, true, "Esc here is not the composer's Stop");
  assert.deepEqual(c.posts("cancel"), [], "and never reaches it");
  assert.equal(c.open(), false);
  assert.equal(c.doc.activeElement, c.chip("troupe"), "focus is back on the chip");
  assert.equal(c.chip("troupe").getAttribute("aria-expanded"), "false");
  assert.deepEqual([...c.$("composer-rail").children].map((n) => n.id), before, "the row is back in its own place");
  assert.equal(c.$("troupe-panel").hidden, true, "and folded again");
  assert.deepEqual(c.errors, []);
});

test("one popover at a time; the checklist, Clear, the goal's buttons and Review changes all work from theirs", () => {
  const c = chat();
  c.pile();
  c.chip("tasks").click();
  assert.equal(c.inPop("tasksbar"), true);
  assert.equal(c.$("tasks-panel").hidden, false, "the checklist comes open");
  assert.equal(c.$("tasks-list").querySelectorAll(".t").length, 7);
  c.chip("goal").click();
  assert.equal(c.inPop("tasksbar"), false, "opening another puts the first back");
  assert.equal(c.$("tasks-panel").hidden, true);
  assert.equal(c.$("tasksbar").parentElement, c.$("composer-rail"));
  assert.equal(c.inPop("goalbar"), true);
  assert.equal(c.chip("tasks").getAttribute("aria-expanded"), "false");
  assert.equal(c.chip("goal").getAttribute("aria-expanded"), "true");
  c.$("goal-toggle").click();
  assert.deepEqual(c.posts("pauseGoal"), [{ type: "pauseGoal" }]);
  c.$("goal-edit").click();
  assert.equal(c.$("goal-editor").hidden, false, "Edit opens the goal editor over the popover");
  c.press(c.$("goal-editor-text"));
  assert.equal(c.open(), true, "working in that dialog is not a click elsewhere");
  c.$("goal-editor-cancel").click();
  assert.equal(c.doc.activeElement, c.$("goal-main"), "and closing it comes back into the popover");

  c.chip("changes").click();
  assert.equal(c.inPop("changesbar"), true);
  c.$("changes-review-button").click();
  assert.equal(c.$("changes-review").hidden, false, "Review opens the changed files");
  assert.match(c.$("changes-review-description").textContent + c.$("changes-review-summary").textContent, /6|changed/);

  c.chip("tasks").click();
  c.$("tasks-clear").click();
  assert.deepEqual(c.posts("clear_todos"), [{ type: "clear_todos" }]);
  c.event({ type: "todos", todos: [] });
  assert.equal(c.open(), false, "its kind ended: the popover closes");
  assert.equal(c.chip("tasks"), null);
  assert.ok(c.doc.activeElement?.classList.contains("rail-chip") || c.doc.activeElement === c.$("input"),
    "and the focus lands on the line or the prompt, never on nothing");
  assert.deepEqual(c.errors, []);
});

test("Esc, ×, the chip again, a click elsewhere or Tab out close it; a click inside does not", () => {
  const c = chat();
  c.pile();
  c.chip("goal").click();
  c.press(c.$("goal-time"));
  assert.equal(c.open(), true, "a click inside");
  c.chip("goal").click();
  assert.equal(c.open(), false, "the chip again");
  c.chip("goal").click();
  c.$("rail-pop-close").click();
  assert.equal(c.open(), false, "×");
  assert.equal(c.doc.activeElement, c.chip("goal"));
  c.chip("goal").click();
  c.press(c.$("log"));
  assert.equal(c.open(), false, "a click on the transcript");
  assert.equal(c.$("goalbar").parentElement, c.$("composer-rail"));
  c.chip("monitors").click();
  assert.equal(c.doc.activeElement, c.$("rail-pop"), "no main control to land on (only Stops): the popover itself");
  c.$("monitor-chips").querySelector(".monitor-stop").focus();
  c.$("monitor-chips").querySelector(".monitor-stop").dispatchEvent(new c.dom.window.FocusEvent("focusout", { bubbles: true, relatedTarget: c.$("input") }));
  assert.equal(c.open(), false, "Tab out of it");
  // Stop goes away once its troupe has stopped, and the focus with it: Esc still closes the popover.
  c.chip("troupe").click();
  c.$("troupe-stop").click();
  c.event({ type: "troupe_finished", ...TROUPE, state: "stopped", reason: "stopped by the user" });
  c.doc.activeElement.blur();
  assert.equal(c.doc.activeElement, c.doc.body);
  assert.equal(c.open(), true);
  c.key(c.doc.body, "Escape");
  assert.equal(c.open(), false, "Esc with the focus on the page");
  assert.equal(c.doc.activeElement, c.chip("troupe"), "and the focus goes back to the chip");
  assert.deepEqual(c.posts("cancel"), [], "never the composer's Stop");
  assert.deepEqual(c.errors, []);
});

test("the chips are one toolbar: one Tab stop, the arrows, Home and End move along it", () => {
  const c = chat();
  c.pile();
  const stops = () => c.chips().filter((n) => n.tabIndex === 0).map((n) => n.dataset.kind);
  assert.deepEqual(stops(), ["goal"]);
  c.chip("goal").focus();
  c.key(c.chip("goal"), "ArrowRight");
  assert.equal(c.doc.activeElement, c.chip("troupe"));
  assert.deepEqual(stops(), ["troupe"]);
  c.key(c.chip("troupe"), "End");
  assert.equal(c.doc.activeElement, c.chip("changes"));
  c.key(c.chip("changes"), "ArrowRight");
  assert.equal(c.doc.activeElement, c.chip("goal"), "wraps");
  c.key(c.chip("goal"), "ArrowLeft");
  assert.equal(c.doc.activeElement, c.chip("changes"));
  c.key(c.chip("changes"), "Home");
  assert.equal(c.doc.activeElement, c.chip("goal"));
  // Keys the composer owns are never swallowed by the line.
  const undo = c.key(c.chip("goal"), "z", { ctrlKey: true });
  assert.equal(undo.defaultPrevented, false);
  assert.deepEqual(c.errors, []);
});

test("whatever needs you turns its chip amber and says why, to the eye and to a screen reader", () => {
  const c = chat();
  c.pile();
  for (const kind of ["goal", "troupe", "monitors", "tasks", "changes"]) assert.equal(c.chip(kind).hasAttribute("data-need"), false, kind);
  c.event({ type: "todos", todos: [...TODOS, { content: "Publish (needs your token)", status: "blocked" }] });
  assert.ok(c.chip("tasks").hasAttribute("data-need"));
  assert.equal(c.face("tasks"), "Tasks 4/8 1 blocked");
  assert.equal(c.chip("tasks").dataset.need, "error", "blocked is the Tasks row's red, as before the chip line");
  assert.equal(c.chip("tasks").querySelector(".chip-dot"), null, "no dot");
  assert.match(c.chip("tasks").getAttribute("aria-label"), /1 blocked\. Needs you: 1 blocked$/);

  c.event(MONITORS({ wake_paused: true, pending_events: 3 }));
  assert.ok(c.chip("monitors").hasAttribute("data-need"), "events held for your next message");
  assert.equal(c.face("monitors"), "2 monitors 3 waiting");
  assert.match(c.chip("monitors").getAttribute("aria-label"), /3 events waiting for your next message, wake-ups paused\. Needs you: 3 waiting/);
  c.event(MONITORS({ wake_paused: true, pending_events: 3, items: [] }));
  assert.equal(c.face("monitors"), "3 waiting", "every monitor ended, its events still wait");
  assert.ok(c.chip("monitors").hasAttribute("data-need"));
  c.event(MONITORS({ wake_paused: true, pending_events: 3 }));

  c.event({ type: "goal_changed", goal: "Ship it", status: "blocked", reason: "Which region?", elapsed_seconds: 60, details: {} });
  assert.ok(c.chip("goal").hasAttribute("data-need"), "a blocked goal needs a decision");
  assert.match(c.chip("goal").getAttribute("aria-label"), /^Goal, blocked: Ship it\. Needs you: blocked$/);

  c.event({ type: "troupe_finished", ...TROUPE, state: "failed", reason: "the model stopped answering" });
  assert.ok(c.chip("troupe").hasAttribute("data-need"));
  assert.equal(c.face("troupe"), "Troupe Failed", "the number says it once");
  assert.match(c.chip("troupe").getAttribute("aria-label"), /^Troupe Review every API handler: Failed\. Needs you$/);
  c.event({ type: "troupe_started", ...TROUPE, run_id: "tr-aaaaaaaaaa", title: "Second" });
  assert.equal(c.face("troupe"), "2 troupes 5/8 1 failed", "one that failed behind a running one says so beside it");

  // The Pips digest is a chip too; an alert-level finding needs you.
  c.$("pipsbar").hidden = false;
  c.$("pipsbar").dataset.reason = "alert";
  c.$("pips-digest-text").textContent = "1 new finding from Commit reviewer (worst: high)";
  c.event({ type: "todos", todos: TODOS });            // anything that repaints the rail
  assert.ok(c.chip("pips").hasAttribute("data-need"));
  assert.equal(c.face("pips"), "Pips alert");
  assert.equal(c.chip("pips").getAttribute("aria-label"), "Pips: 1 new finding from Commit reviewer (worst: high). Needs you: alert");
  assert.equal(c.chip("tasks").hasAttribute("data-need"), false, "unblocked: the amber goes");
  assert.deepEqual(c.errors, []);
});

test("the last kind left gets its full row back, focus and all", () => {
  const c = chat();
  c.pile({ monitors: false, tasks: false, changes: false });
  c.chip("goal").click();
  assert.equal(c.doc.activeElement, c.$("goal-main"));
  c.event({ type: "troupe_finished", ...TROUPE, state: "done" });
  c.event({ type: "turn_start", turn_id: "t2", prompt: "next", kind: "prompt" });   // your next message moves on
  assert.equal(c.$("troupebar").hidden, true);
  assert.equal(c.$("rail-chips").hidden, true, "one kind: no chips");
  assert.equal(c.open(), false);
  assert.equal(c.$("goalbar").parentElement, c.$("composer-rail"));
  assert.equal(c.$("composer-rail").hidden, false, "the goal's full row");
  assert.equal(c.doc.activeElement, c.$("goal-main"), "the focus stays on the control it was on");
  assert.deepEqual(c.errors, []);
});

test("the goal's chip keeps the row's time; the paste notice and N queued never become chips", () => {
  const c = chat();
  c.pile();
  c.event({ type: "goal_changed", goal: "Ship it", status: "active", elapsed_seconds: 59, running: true, details: {} });
  assert.equal(c.face("goal"), "Goal 0:59");
  assert.equal(c.chip("goal").querySelector(".chip-num").textContent, c.$("goal-time").textContent);

  c.event({ type: "queued", count: 2 });
  assert.equal(c.$("queued").textContent, "2 queued");
  assert.equal(c.$("queued").parentElement, c.$("rail-line"), "on the chip line, as words");
  assert.equal(c.chip("queued"), null);

  const input = c.$("input");
  input.textContent = "hello‮world";
  input.dispatchEvent(new c.dom.window.Event("input", { bubbles: true }));
  assert.equal(c.$("pastebar").hidden, false);
  assert.equal(c.$("composer-rail").hidden, false, "the notice is about the message being typed: its own row");
  assert.equal(c.$("pastebar").parentElement, c.$("composer-rail"));
  assert.equal(c.chip("paste"), null);
  assert.deepEqual(c.errors, []);
});

test("Open the journal names the run; Show in the agent map opens the map at it", () => {
  const c = chat();
  c.pile();
  c.chip("troupe").click();
  const [journal, map] = c.$("rail-pop-links").querySelectorAll("button");
  journal.click();
  assert.deepEqual(c.posts("openTroupeJournal"), [{ type: "openTroupeJournal", runId: "tr-0123456789" }]);
  map.click();
  assert.equal(c.open(), false);
  assert.equal(c.$("agent-map").hidden, false);
  assert.equal(c.doc.activeElement?.dataset.amKey, "troupe:tr-0123456789");
  c.key(c.doc.activeElement, "Escape");
  assert.equal(c.$("agent-map").hidden, true);
  assert.equal(c.doc.activeElement, c.chip("troupe"), "closing the map comes back to the chip");

  c.chip("monitors").click();
  assert.deepEqual([...c.$("rail-pop-links").querySelectorAll("button")].map((b) => b.textContent), ["Show in the agent map"]);
  c.$("rail-pop-links").querySelector("button").click();
  assert.equal(c.doc.activeElement?.dataset.amKey, "monitor:mon1");
  c.key(c.doc.activeElement, "Escape");

  // The map lists what runs now: once the troupe has ended, its popover no longer offers it (the journal stays).
  c.chip("troupe").click();
  c.event({ type: "troupe_finished", ...TROUPE, state: "done" });
  assert.deepEqual([...c.$("rail-pop-links").querySelectorAll("button")].map((b) => b.textContent), ["Open the journal"]);
  assert.deepEqual(c.errors, []);
});
