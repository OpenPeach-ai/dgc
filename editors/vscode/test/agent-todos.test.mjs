// Work's plan (0.52, decided 18 Nov): the Tasks pill stays where it is, says the step being worked on with its mark
// and "n/m"; it opens the plan's section (Tasks · n of m done, the plan's time, a collapse chevron, a progress bar and a
// row per step with its mark, its words, its time and the step's live sub-step); and inside the conversation a plan is
// ONE card per turn that updates in place as the plan changes, with the same marks and motion. Added steps are marked,
// removed ones are shown struck for a moment, and the change is said once ("Plan updated · 1 added · 1 removed") and to a
// screen reader. The counter is still the one the backend's completion gate reads: blocked is not done. Colours are
// DGC's own (nothing blue). Real geometry and motion are agent-todos-layout.test.mjs's, in Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss } from "./support/webview-dom.mjs";

const PLAN = [
  { content: "Read the settings store", status: "done" },
  { content: "Write the v2 to v3 migration", status: "in_progress" },
  { content: "Tests for both directions", status: "pending" },
  { content: "Update the changelog", status: "pending" },
  { content: "Publish to the marketplace", status: "blocked" },
];

function work(options = {}) {
  const v = makeDom(options);
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  event({ type: "ready", session_id: "s1", model: "m", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
    workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1,
    capabilities: { agents: true } });
  v.send({ type: "session_ready", sessionId: "s1" });
  const chip = () => v.doc.querySelector('#rail-chips .rail-chip[data-kind="tasks"]');
  const rows = (root) => [...root.querySelectorAll("li.todo:not(.todo-gone)")];
  const marks = (root) => rows(root).map((li) => li.querySelector(".todo-mark").dataset.mark);
  const labels = (root) => rows(root).map((li) => li.querySelector(".todo-label").textContent);
  const cards = () => [...v.doc.querySelectorAll("#log .todos-card")];
  let n = 0;
  // One plan update as the backend sends it: the call, the list it applied, and the call's result.
  const plan = (todos, { emit = true, output = "todo list updated" } = {}) => {
    const id = `td${++n}`;
    event({ type: "tool_call", call_id: id, name: "todo", args: { todos }, summary: "" });
    if (emit) event({ type: "todos", todos });
    event({ type: "tool_result", call_id: id, name: "todo", output, is_error: false, is_diff: false });
  };
  return { ...v, event, $, chip, rows, marks, labels, cards, plan };
}

test("the pill stays, and says the step being worked on: its mark, its words and n/m", () => {
  const w = work();
  w.event({ type: "turn_start", turn_id: "t1", prompt: "Ship the migration", kind: "prompt" });
  w.event({ type: "todos", todos: PLAN });
  const chip = w.chip();
  assert.ok(chip, "one pill on the bar, as today");
  const mark = chip.querySelector(".todo-mark");
  assert.equal(mark?.dataset.mark, "doing", "the mark of the step in progress");
  assert.ok(mark.hasAttribute("data-running"), "a turn is running: the ring spins");
  assert.ok(mark.querySelector("circle.todo-spin"), "the spinning arc");
  assert.equal(chip.querySelector(".codicon-checklist"), null, "no list icon in its place any more");
  assert.equal(chip.querySelector(".chip-word").textContent, "Write the v2 to v3 migration");
  assert.equal(chip.querySelector(".chip-num").textContent, "1/5");
  assert.equal(chip.getAttribute("aria-label"),
    "Write the v2 to v3 migration. 1 of 5 tasks done. Show tasks. Needs you: 1 blocked");
  assert.equal(chip.dataset.need, "error", "a blocked step still needs you, in the error colour");
  // Idle with a step still in progress: the mark stops turning and shows the step half done.
  w.event({ type: "turn_end", turn_id: "t1", reason: "completed" });
  const idle = w.chip().querySelector(".todo-mark");
  assert.equal(idle.dataset.mark, "doing");
  assert.equal(idle.hasAttribute("data-running"), false);
  assert.ok(idle.querySelector("path.todo-pie"), "the still half-disc");
  // Nothing in progress: the next step leads, with its plain circle.
  w.event({ type: "todos", todos: [{ content: "A", status: "done" }, { content: "B", status: "pending" }, { content: "C", status: "pending" }] });
  assert.equal(w.chip().querySelector(".todo-mark").dataset.mark, "next");
  assert.equal(w.chip().querySelector(".chip-word").textContent, "B");
  assert.equal(w.chip().querySelector(".chip-num").textContent, "1/3");
  // Only a blocked step left open: it leads, with its own mark.
  w.event({ type: "todos", todos: [{ content: "A", status: "done" }, { content: "Wait for the key", status: "blocked" }] });
  assert.equal(w.chip().querySelector(".todo-mark").dataset.mark, "blocked");
  assert.equal(w.chip().querySelector(".chip-word").textContent, "Wait for the key");
  // Every step done while a turn still runs: the pill says so, with the check and no count.
  w.event({ type: "turn_start", turn_id: "t2", prompt: "go on", kind: "prompt" });
  w.event({ type: "todos", todos: [{ content: "A", status: "done" }, { content: "B", status: "done" }] });
  assert.equal(w.chip().querySelector(".todo-mark").dataset.mark, "done");
  assert.equal(w.chip().querySelector(".chip-word").textContent, "All 2 tasks done");
  assert.equal(w.chip().querySelector(".chip-num"), null);
  // Finished with one cancelled: not "all done".
  w.event({ type: "todos", todos: [{ content: "A", status: "done" }, { content: "B", status: "cancelled" }] });
  assert.equal(w.chip().querySelector(".todo-mark").dataset.mark, "cancelled");
  assert.equal(w.chip().querySelector(".chip-word").textContent, "Finished · 1 of 2 done");
  // Idle and nothing open: the pill goes, as today.
  w.event({ type: "turn_end", turn_id: "t2", reason: "completed" });
  assert.equal(w.chip(), null);
  assert.equal(w.$("tasksbar").hidden, true);
  assert.deepEqual(w.errors, []);
});

test("clicking the pill opens the plan: Tasks, n of m done, a progress bar, and a row per step with its mark", () => {
  const w = work();
  w.event({ type: "turn_start", turn_id: "t1", prompt: "Ship the migration", kind: "prompt" });
  w.event({ type: "todos", todos: [...PLAN, { content: "Skipped step", status: "cancelled" },
    { content: "Hostile status", status: "constructor" }] });
  w.chip().click();
  const bar = w.$("tasksbar");
  assert.equal(w.$("rail-pop-body").contains(bar), true, "the pill opens the section in its popover");
  assert.equal(w.$("tasks-panel").hidden, false, "with its list open");
  assert.equal(bar.querySelector(".todos-title").textContent, "Tasks");
  assert.equal(w.$("tasks-count").textContent, "1 of 7 done");
  assert.equal(w.$("tasks-blocked").textContent, "1 blocked");
  assert.equal(w.$("tasks-blocked").hidden, false);
  const progress = bar.querySelector('[role="progressbar"]');
  assert.deepEqual([progress.getAttribute("aria-valuemin"), progress.getAttribute("aria-valuemax"), progress.getAttribute("aria-valuenow")],
    ["0", "7", "1"]);
  // The bar fills with the settled steps: done and cancelled.
  assert.equal(bar.querySelector(".todos-fill").style.width, "28.57%");
  assert.equal(w.$("tasks-list").tagName, "OL");
  assert.deepEqual(w.labels(bar), ["Read the settings store", "Write the v2 to v3 migration", "Tests for both directions",
    "Update the changelog", "Publish to the marketplace", "Skipped step", "Hostile status"]);
  // One mark to a state (user test 2, W4: a plain ring for the next step and a dashed one for those after it were two
  // looks for one state, "to do", with nothing to say which was which). Every step still to do is the plain ring (an
  // inherited key is not a status), and each mark says its state in words when pointed at.
  assert.deepEqual(w.marks(bar), ["done", "doing", "next", "next", "blocked", "cancelled", "next"]);
  assert.deepEqual(w.rows(bar).map((li) => li.querySelector(".todo-markbox").getAttribute("title")),
    ["Done", "In progress", "To do", "To do", "Blocked", "Cancelled", "To do"]);
  assert.equal(bar.querySelectorAll('.todo-ring[stroke-dasharray]').length, 0, "no dashed ring");
  assert.deepEqual(w.rows(bar).map((li) => li.dataset.status),
    ["done", "in_progress", "pending", "pending", "blocked", "cancelled", "pending"]);
  assert.deepEqual(w.rows(bar).map((li) => li.getAttribute("aria-label")), [
    "Read the settings store, Done", "Write the v2 to v3 migration, In progress", "Tests for both directions, To do",
    "Update the changelog, To do", "Publish to the marketplace, Blocked", "Skipped step, Cancelled", "Hostile status, To do"]);
  assert.ok(w.rows(bar).every((li) => li.querySelector(".todo-mark").getAttribute("aria-hidden") === "true"),
    "the marks are drawings; each row says its state in words");
  // The section's own trigger folds the list, with its chevron; no second button does the same.
  const main = w.$("tasks-main");
  assert.equal(main.getAttribute("aria-controls"), "tasks-panel");
  assert.equal(main.getAttribute("aria-expanded"), "true");
  assert.ok(main.querySelector(".todos-chev"), "the chevron is the trigger's own");
  assert.equal(w.$("tasks-toggle"), null, "one action, one control");
  assert.equal(main.getAttribute("aria-label"), "Tasks, 1 of 7 done, 1 blocked");
  main.click();
  assert.equal(w.$("tasks-panel").hidden, true, "folded: the header and the bar stay");
  assert.equal(main.getAttribute("aria-expanded"), "false");
  main.click();
  assert.equal(w.$("tasks-panel").hidden, false);
  assert.equal(bar.querySelector("script"), null);
  assert.doesNotMatch(bar.innerHTML, /undefined|NaN/);
  assert.deepEqual(w.errors, []);
});

test("the step in progress shows the step DGC is running now under it, in Work's own words", () => {
  const w = work();
  w.event({ type: "turn_start", turn_id: "t1", prompt: "Ship the migration", kind: "prompt" });
  w.plan(PLAN);
  const card = w.cards()[0];
  const sub = (root) => root.querySelector('li.todo[data-status="in_progress"] .todo-sub');
  assert.equal(sub(card), null, "nothing running yet");
  w.event({ type: "tool_call", call_id: "r1", name: "read_file", args: { path: "src/settings.ts" }, summary: "src/settings.ts" });
  assert.equal(sub(card)?.textContent, "Reading src/settings.ts");
  assert.equal(sub(w.$("tasksbar"))?.textContent, "Reading src/settings.ts", "the section says it too");
  w.event({ type: "tool_result", call_id: "r1", name: "read_file", output: "ok", is_error: false, is_diff: false });
  assert.equal(sub(card), null, "the step finished: the line goes");
  w.event({ type: "tool_call", call_id: "b1", name: "bash", args: { command: "npm test" }, summary: "npm test" });
  assert.equal(sub(card)?.textContent, "Running npm test");
  w.event({ type: "turn_end", turn_id: "t1", reason: "cancelled" });
  assert.equal(sub(card), null, "the turn is over: nothing is running");
  assert.deepEqual(w.errors, []);
});

test("a plan in the conversation is one card per turn, updated in place, never a row per update", () => {
  const w = work();
  w.event({ type: "turn_start", turn_id: "t1", prompt: "Ship the migration", kind: "prompt" });
  w.event({ type: "text_delta", text: "I'll keep this list updated as I go." });
  w.event({ type: "stream_end", message_id: "t1:0", phase: "commentary" });
  w.plan(PLAN);
  assert.equal(w.cards().length, 1);
  const card = w.cards()[0];
  assert.equal(w.doc.querySelector('#log .tool[data-tool-name="todo"]'), null, "no plan-update row any more");
  assert.equal(card.tagName, "SECTION");
  assert.equal(card.getAttribute("aria-label"), "Tasks");
  assert.equal(card.closest(".msg.dgc"), w.doc.querySelector("#log .msg.dgc"), "inside the turn");
  assert.equal(card.querySelector(".todos-sum").textContent, "1 of 5 done");
  assert.deepEqual(w.marks(card), ["done", "doing", "next", "next", "blocked"]);
  w.event({ type: "tool_call", call_id: "r1", name: "read_file", args: { path: "a.ts" }, summary: "a.ts" });
  w.event({ type: "tool_result", call_id: "r1", name: "read_file", output: "ok", is_error: false, is_diff: false });
  // The step finishes and the next starts: the same card changes.
  w.plan([{ ...PLAN[0] }, { ...PLAN[1], status: "done" }, { ...PLAN[2], status: "in_progress" }, PLAN[3], PLAN[4]]);
  assert.equal(w.cards().length, 1, "one card, however many updates");
  assert.equal(w.cards()[0], card, "the same element");
  assert.equal(card.querySelector(".todos-sum").textContent, "2 of 5 done");
  assert.deepEqual(w.marks(card), ["done", "done", "doing", "next", "blocked"]);
  assert.equal(card.querySelector('li.todo[data-status="in_progress"] .todo-label').textContent, "Tests for both directions");
  // The card stays where the plan first appeared; the work goes on below it.
  const order = [...card.parentElement.children];
  assert.ok(order.indexOf(card) < order.indexOf(w.doc.querySelector("#log .tool-group")), "the reading came after it");
  // A failed plan update is still there to inspect, as a row, and the card keeps its last plan.
  w.event({ type: "tool_call", call_id: "bad", name: "todo", args: { todos: [{ content: "", status: "pending" }] }, summary: "" });
  w.event({ type: "tool_result", call_id: "bad", name: "todo", output: "error: todo row 1 has empty content", is_error: true, is_diff: false });
  assert.ok(w.doc.querySelector('#log .tool[data-tool-name="todo"][data-status="failed"]'), "the failed call is a row of its own");
  assert.equal(card.querySelector(".todos-sum").textContent, "2 of 5 done");
  // A refused update (the person cleared the list meanwhile) changes nothing either.
  w.plan([{ content: "Something old", status: "pending" }], { emit: false,
    output: "todo not applied: the user cleared the checklist while this call was queued." });
  assert.deepEqual(w.labels(card), ["Read the settings store", "Write the v2 to v3 migration", "Tests for both directions",
    "Update the changelog", "Publish to the marketplace"]);
  w.event({ type: "turn_end", turn_id: "t1", reason: "completed" });
  assert.equal(card.querySelector(".todo-mark[data-running]"), null, "the turn ended: nothing spins in it any more");
  // The next turn's plan is that turn's card; the first one keeps what it said.
  w.event({ type: "turn_start", turn_id: "t2", prompt: "Now the docs", kind: "prompt" });
  w.plan([{ content: "Write the docs", status: "in_progress" }]);
  assert.equal(w.cards().length, 2);
  assert.equal(w.cards()[1].closest(".msg.dgc"), [...w.doc.querySelectorAll("#log .msg.dgc")].at(-1));
  assert.equal(card.querySelector(".todos-sum").textContent, "2 of 5 done");
  // A list the person cleared mid-turn takes the turn's card with it.
  w.event({ type: "todos", todos: [] });
  assert.equal(w.cards().length, 1);
  assert.deepEqual(w.errors, []);
});

test("an engine that sends no list of its own still gets its card, from the call (with its active words)", () => {
  const w = work();
  w.event({ type: "turn_start", turn_id: "t1", prompt: "Search lags", kind: "prompt" });
  w.event({ type: "tool_call", call_id: "tw1", name: "TodoWrite", summary: "", args: { todos: [
    { content: "Find where search fetches", activeForm: "Finding where search fetches", status: "in_progress" },
    { content: "Add a debounced value", activeForm: "Adding a debounced value", status: "pending" },
    { content: "Run the tests", status: "completed" }] } });
  assert.equal(w.cards().length, 0, "not before the engine says it took it");
  w.event({ type: "tool_result", call_id: "tw1", name: "TodoWrite", output: "Todos have been modified successfully", is_error: false, is_diff: false });
  const card = w.cards()[0];
  assert.ok(card);
  assert.deepEqual(w.labels(card), ["Finding where search fetches", "Add a debounced value", "Run the tests"],
    "a step in progress says what is happening now");
  assert.deepEqual(w.marks(card), ["doing", "next", "done"]);
  assert.equal(w.doc.querySelector('#log .tool[data-tool-name="TodoWrite"]'), null);
  assert.deepEqual(w.errors, []);
});

test("a reloaded chat draws each turn's card from its saved plan call, still", () => {
  const w = work();
  w.event({ type: "session", kind: "resumed", session_id: "s1" });
  w.event({ type: "history", complete: true, todos: [], items: [
    { type: "turn_start", turn_id: "h1", prompt: "Ship the migration", kind: "prompt" },
    { type: "tool_call", call_id: "td1", name: "todo", summary: "", args: { todos: PLAN } },
    { type: "tool_result", call_id: "td1", name: "todo", output: "todo list updated:\n[x] Read", is_error: false },
    { type: "tool_call", call_id: "td2", name: "todo", summary: "", args: { todos: PLAN.map((t) => ({ ...t, status: "done" })) } },
    { type: "tool_result", call_id: "td2", name: "todo", output: "todo list updated:\n[x] Read", is_error: false },
    { type: "text_delta", text: "Done." }, { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" },
  ] });
  assert.equal(w.cards().length, 1, "one card for the turn's two updates");
  const card = w.cards()[0];
  assert.deepEqual(w.marks(card), ["done", "done", "done", "done", "done"]);
  assert.equal(card.querySelector(".todos-sum").textContent, "5 tasks done");
  assert.equal(card.querySelector(".todo-mark[data-running]"), null, "a saved turn runs nothing");
  assert.equal(card.querySelector(".todos-time").textContent, "", "and makes up no time");
  assert.equal(w.doc.querySelector('#log .tool[data-tool-name="todo"]'), null);
  assert.equal(w.$("tasksbar").hidden, true, "the session's list is the snapshot's: empty");
  assert.deepEqual(w.errors, []);
});

test("a plan change is shown and said: added steps lit, removed ones struck for a moment, a note and a live region", () => {
  const w = work({ clock: true });
  w.event({ type: "turn_start", turn_id: "t1", prompt: "Search lags", kind: "prompt" });
  w.plan([{ content: "Find it", status: "in_progress" }, { content: "Add a hook", status: "pending" },
    { content: "Update the docs", status: "pending" }]);
  const card = w.cards()[0];
  const note = card.querySelector(".todos-note");
  assert.equal(note.getAttribute("aria-live"), "polite");
  assert.equal(note.textContent, "", "the first plan is not a change");
  w.plan([{ content: "Find it", status: "done" }, { content: "Add a hook", status: "in_progress" },
    { content: "Cancel stale requests", status: "pending" }]);
  assert.equal(note.textContent, "Plan updated · 1 added · 1 removed");
  const added = card.querySelector('li.todo[data-added]');
  assert.equal(added?.querySelector(".todo-label").textContent, "Cancel stale requests");
  const gone = card.querySelector("li.todo-gone");
  assert.equal(gone?.textContent, "Update the docs", "the removed step, struck, where it was");
  assert.equal(gone.getAttribute("aria-hidden"), "true");
  assert.equal([...card.querySelectorAll("li")].indexOf(gone), 2, "at its old place");
  assert.equal(card.querySelector(".todos-say").getAttribute("aria-live"), "polite");
  assert.equal(card.querySelector(".todos-say").textContent, "Started: Add a hook");
  w.advance(400);
  assert.equal(card.querySelector("li.todo-gone"), null, "the struck step leaves");
  assert.ok(card.querySelector("li.todo[data-added]"), "the new one is still lit");
  w.advance(2200);
  assert.equal(note.textContent, "");
  assert.equal(card.querySelector("li.todo[data-added]"), null);
  // The pill's own section says the same change.
  assert.equal(w.$("tasksbar").querySelector(".todos-note").textContent, "");
  w.plan([{ content: "Find it", status: "done" }, { content: "Add a hook", status: "done" },
    { content: "Cancel stale requests", status: "in_progress" }]);
  assert.equal(card.querySelector(".todos-say").textContent, "Started: Cancel stale requests");
  assert.equal(note.textContent, "", "a step moving on is not a change of plan");
  assert.deepEqual(w.errors, []);
});

test("a long plan folds the steps already done until you ask for them", () => {
  const w = work();
  w.event({ type: "turn_start", turn_id: "t1", prompt: "Big job", kind: "prompt" });
  w.plan(Array.from({ length: 8 }, (_, i) => ({ content: `Step ${i + 1}`, status: i < 3 ? "done" : i === 3 ? "in_progress" : "pending" })));
  const card = w.cards()[0];
  const fold = card.querySelector(".todos-fold");
  assert.ok(fold, "three done at the top of eight: folded");
  assert.equal(fold.textContent, "3 completed");
  assert.equal(fold.tagName, "BUTTON");
  assert.deepEqual(w.labels(card), ["Step 4", "Step 5", "Step 6", "Step 7", "Step 8"]);
  fold.click();
  assert.equal(card.querySelector(".todos-fold"), null);
  assert.equal(w.rows(card).length, 8);
  // The popover's section never folds them.
  assert.equal(w.rows(w.$("tasksbar")).length, 8);
  assert.deepEqual(w.errors, []);
});

test("the plan and its steps are timed while a turn works on them, never after", () => {
  const w = work({ clock: true });
  w.event({ type: "turn_start", turn_id: "t1", prompt: "Big job", kind: "prompt" });
  w.plan([{ content: "One", status: "in_progress" }, { content: "Two", status: "pending" }]);
  const card = w.cards()[0];
  const time = (root) => root.querySelector(".todos-time").textContent;
  const stepTime = (root, i) => w.rows(root)[i].querySelector(".todo-time")?.textContent || "";
  assert.equal(time(card), "");
  w.advance(1500);
  assert.equal(time(card), "1s");
  assert.equal(stepTime(card, 0), "1s");
  assert.equal(time(w.$("tasksbar")), "1s", "the section keeps the same clock");
  w.advance(1000);
  w.plan([{ content: "One", status: "done" }, { content: "Two", status: "in_progress" }]);
  assert.equal(stepTime(card, 0), "2s", "a done step keeps its time");
  assert.equal(stepTime(card, 1), "");
  w.advance(61000);
  assert.equal(time(card), "1m 3s");
  w.event({ type: "turn_end", turn_id: "t1", reason: "completed" });
  w.advance(5000);
  assert.equal(time(card), "1m 3s", "idle: the clock stops");
  assert.deepEqual(w.errors, []);
});

test("the plan's look is DGC's own: its tokens, its working shimmer, nothing blue, and still when motion is reduced", () => {
  const block = (selector) => {
    const at = mainCss.indexOf(selector);
    assert.ok(at >= 0, `missing ${selector}`);
    return mainCss.slice(at, mainCss.indexOf("}", at));
  };
  const todos = mainCss.slice(mainCss.indexOf("/* Work's plan"), mainCss.indexOf("/* Work's plan: end */"));
  assert.ok(todos.length > 200, "the plan's rules are one block");
  assert.doesNotMatch(todos, /blue|--info|#(?:3b82f6|2563eb|60a5fa|1d4ed8)|hsl\(2[0-4]\d/i, "never the reference's blue");
  assert.doesNotMatch(todos, /#[0-9a-f]{3,8}\b/i, "colours come from DGC's tokens only");
  assert.match(block(".todo-spin {"), /stroke:\s*var\(--text/, "the spinner in the text colour");
  assert.match(block(".todo-spin {"), /animation:\s*todo-spin 1s linear infinite/);
  assert.match(block(".todos-fill {"), /background:\s*var\(--solid\)/, "the bar fills in the text colour");
  assert.match(block(".todo-mark[data-mark=\"done\"] {"), /background:\s*var\(--solid\)/);
  assert.match(todos, /li\.todo\[data-status="in_progress"\] \.todo-label\s*\{[^}]*color:\s*var\(--text-strong\)/,
    "the step in progress in the strong text colour");
  assert.match(todos, /dgc-activity-shimmer/, "with Work's own working shimmer");
  const reduced = todos.slice(todos.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.todo-spin[^{]*\{[^}]*animation:\s*none/, "reduced motion: the ring stands still");
  assert.match(reduced, /\.todo-glyph[^{]*\{[^}]*animation:\s*none/, "and the check is simply there");
  assert.match(todos, /@media \(forced-colors: active\)/, "high contrast keeps every mark");
});
