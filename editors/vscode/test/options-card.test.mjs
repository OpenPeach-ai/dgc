// The v14 question card (propose_options): docked in the composer frame, keyboard and pointer
// behaviour, the arrival guard, sending and rejection, retirement, and the answered state inside the
// step's tool card, identical live and on replay. jsdom; the clock is manual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mainCss, makeDom } from "./support/webview-dom.mjs";

const opt = (label, description = "", recommended = false) => ({ label, description, recommended });
const q = (id, question, options, extra = {}) => ({ id, header: id, question, multi_select: false, options, ...extra });
const STORAGE = q("q1", "Which storage backend should settings sync use?", [
  opt("SQLite file", "One local file with transactions; nothing extra to run.", true),
  opt("JSON on disk", "Easy to read by hand; no safe concurrent writes.")]);
const EXTRAS = q("q2", "Which extras ship in the first version?", [
  opt("Conflict prompt", "Ask when two machines edited the same key.", true),
  opt("Sync history", "Keep the last 20 versions."), opt("Export button", "Download all settings.")],
{ multi_select: true });

function panel() {
  const view = makeDom({ clock: true });
  const event = (value) => view.send({ type: "event", event: value });
  const responses = () => view.posted.filter((m) => m.type === "options_response").map((m) => JSON.parse(JSON.stringify(m)));
  const card = () => view.doc.querySelector("#cbox > .ask");
  const rows = () => [...(card()?.querySelectorAll(".ask-opt") || [])];
  const key = (node, k, extra = {}) => node.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
  const click = (node) => node.dispatchEvent(new view.dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
  const verb = () => view.doc.querySelector(".thinking .verb")?.textContent;
  return { ...view, event, responses, card, rows, key, click, verb };
}

function ask(p, questions, id = "r1", callId = "call_q") {
  p.event({ type: "tool_call", call_id: callId, name: "propose_options", args: {},
    summary: `${questions.length} question${questions.length === 1 ? "" : "s"} · x` });
  p.event({ type: "options_request", id, call_id: callId, questions });
}

test("the card docks inside #cbox in place of the text box; Stop, mode and model stay", () => {
  const p = panel();
  p.event({ type: "ready", version: "x", protocol_version: 14, capabilities: { live_steering: true }, model: "m",
    mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [],
    custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "Add settings sync" });
  const input = p.doc.getElementById("input");
  input.value = "an unsent follow-up";
  input.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  assert.equal(p.doc.getElementById("queue-send").hidden, false);
  ask(p, [STORAGE, EXTRAS]);
  const cbox = p.doc.getElementById("cbox");
  assert.equal(p.card().parentElement, cbox);
  assert.equal(cbox.firstElementChild, p.card());
  assert.equal(cbox.querySelector(".cinput").hidden, true);
  assert.equal(p.doc.getElementById("attachments").hidden, true);
  assert.equal(p.doc.getElementById("cfooter").hidden, false);
  assert.ok(p.doc.getElementById("cfooter").isConnected && cbox.contains(p.doc.getElementById("send")));
  assert.equal(p.doc.getElementById("send").getAttribute("aria-label"), "Stop generation");
  assert.equal(p.doc.getElementById("queue-send").hidden, true);
  assert.equal(p.doc.getElementById("followup-hint").hidden, true);
  assert.equal(p.doc.getElementById("composer-rail").nextElementSibling, cbox, "the rail stays attached to the frame");
  assert.equal(input.value, "an unsent follow-up");
  const tool = p.doc.querySelector('.tool[data-call-id="call_q"]');
  assert.equal(tool.querySelector(".verb").textContent, "Asking");
  assert.equal(tool.querySelector(".arg").textContent, "2 questions…");
  assert.equal(p.verb(), "waiting for your input");
  assert.match(p.doc.getElementById("announcer").textContent, /^DGC asks: Which storage backend/);
  p.event({ type: "turn_activity", turn_id: "t1", state: "waiting", label: "Waiting for your answer" });
  assert.equal(p.verb(), "waiting for your input", "a docked card outranks the backend's activity");
  p.event({ type: "options_resolved", id: "r1", call_id: "call_q", outcome: "dismissed", questions: [STORAGE, EXTRAS] });
  assert.equal(p.card(), null);
  assert.equal(cbox.querySelector(".cinput").hidden, false);
  assert.equal(input.value, "an unsent follow-up", "the draft is restored with the text box");
  assert.equal(p.verb(), "Waiting for your answer", "the backend's activity comes back");
  assert.equal(p.doc.getElementById("send").getAttribute("aria-label"), "Steer current run");
  assert.deepEqual(p.errors, []);
});

test("arrival never turns typing into a choice", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  const input = p.doc.getElementById("input");
  input.value = "I was typing 2";
  input.focus();
  ask(p, [STORAGE]);
  assert.equal(p.doc.activeElement.classList.contains("ask-opt"), false, "no option takes focus from a busy composer");
  assert.equal(p.card().querySelector(".ask-hint").hidden, false);
  assert.equal(p.card().querySelector(".ask-hint").textContent, "Press Tab to answer");
  p.key(p.doc.activeElement, "2");
  p.key(p.rows()[1], "2");
  p.key(p.rows()[1], "Enter");
  p.key(p.rows()[1], "Escape");
  p.advance(200);
  assert.deepEqual(p.responses(), [], "keys within 400 ms post nothing");
  p.advance(250);
  p.key(p.card(), "2");
  p.advance(200);
  assert.deepEqual(p.responses(), [], "a key at the card itself is not a choice");
  p.key(p.card(), "Tab");
  assert.equal(p.doc.activeElement, p.rows()[0], "Tab reaches the preselected option");
  assert.equal(p.card().querySelector(".ask-hint").hidden, true);
  // A pointer is never delayed.
  const fresh = panel();
  fresh.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(fresh, [STORAGE]);
  assert.equal(fresh.doc.activeElement, fresh.rows()[0], "an idle composer hands focus to the preselected row");
  fresh.click(fresh.rows()[1]);
  fresh.advance(150);
  assert.deepEqual(fresh.responses(), [{ type: "options_response", id: "r1", answers: { q1: { selected: [1], other: "" } } }]);
  assert.deepEqual(p.errors, []);
});

test("the recommended option is badged and preselected wherever it sits; labels are escaped", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(p, [q("q1", "Pick <img src=x onerror=alert(1)>", [
    opt("Plain <b>bold</b>", "<img src=y>"), opt("Local (Recommended)", "Kept here"), opt("Cloud")])]);
  const rows = p.rows();
  assert.equal(p.card().querySelector("img"), null);
  assert.equal(p.card().querySelector("b"), null);
  assert.equal(rows[0].querySelector(".ask-label").textContent, "Plain <b>bold</b>");
  assert.equal(p.card().querySelector(".ask-q").textContent, "Pick <img src=x onerror=alert(1)>");
  assert.equal(rows[1].querySelector(".ask-label").textContent, "Local", "the model's suffix becomes the badge");
  assert.equal(rows[1].querySelector(".ask-badge").textContent, "Recommended");
  assert.equal(p.card().querySelectorAll(".ask-badge").length, 1);
  assert.ok(rows[1].classList.contains("hot"));
  assert.equal(rows[1].tabIndex, 0);
  assert.deepEqual(rows.map((row) => row.tabIndex), [-1, 0, -1], "one roving stop");
  assert.match(rows[1].getAttribute("aria-label"), /recommended/);
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-checked")), ["false", "true", "false"], "the recommendation is preselected");
  assert.ok(rows[1].classList.contains("checked"));
  assert.equal(p.doc.activeElement, rows[1]);
  assert.equal(p.card().querySelector(".ask-act").textContent, "Continue", "the pill takes the preselected pick");
  assert.ok(p.card().querySelector(".ask-act").classList.contains("primary"));
  assert.equal(p.card().querySelector(".ask-skip").hidden, false, "Skip stays, as its own button");
  assert.deepEqual(p.responses(), [], "nothing is sent until the reader acts");
  p.advance(400);
  p.key(rows[1], "ArrowUp");
  assert.deepEqual(p.rows().map((row) => row.getAttribute("aria-checked")), ["false", "true", "false"], "arrows move focus, not the pick");
  p.key(p.rows()[0], "ArrowDown");
  p.key(rows[1], "Enter");
  p.advance(150);
  assert.deepEqual(p.responses(), [{ type: "options_response", id: "r1", answers: { q1: { selected: [1], other: "" } } }]);
  // A click on the pill of an untouched question takes the recommendation.
  const pill = panel();
  pill.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(pill, [STORAGE, q("q2", "Second?", [opt("A", "", true), opt("B")])]);
  assert.equal(pill.card().querySelector(".ask-act").textContent, "Next");
  pill.click(pill.card().querySelector(".ask-act"));
  assert.equal(pill.card().querySelector(".ask-q").textContent, "Second?");
  // Skip beside it clears the preselection and settles the question as skipped.
  pill.click(pill.card().querySelector(".ask-skip"));
  assert.deepEqual(pill.responses(), [{ type: "options_response", id: "r1", answers: {
    q1: { selected: [0], other: "" }, q2: { selected: [], other: "" } } }]);
  // Words replace the pick in a single choice: the check clears while there is text and returns without it.
  const words = panel();
  words.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(words, [STORAGE]);
  const field = words.card().querySelector(".ask-field");
  field.value = "Keep it in the settings file";
  field.dispatchEvent(new words.dom.window.Event("input", { bubbles: true }));
  assert.deepEqual(words.rows().map((row) => row.getAttribute("aria-checked")), ["false", "false"]);
  field.value = "";
  field.dispatchEvent(new words.dom.window.Event("input", { bubbles: true }));
  assert.deepEqual(words.rows().map((row) => row.getAttribute("aria-checked")), ["true", "false"]);
  field.value = "Keep it in the settings file";
  field.dispatchEvent(new words.dom.window.Event("input", { bubbles: true }));
  words.click(words.card().querySelector(".ask-act"));
  assert.deepEqual(words.responses(), [{ type: "options_response", id: "r1", answers: { q1: { selected: [], other: "Keep it in the settings file" } } }]);
  // A marker the model left in the description is the recommendation too, and is not shown as text.
  const marked = panel();
  marked.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(marked, [q("q1", "Database?", [opt("Postgres", "Feature rich, good for large scale"),
    opt("SQLite", "Easy to deploy, best for small apps (Recommended)")])]);
  assert.equal(marked.rows()[1].querySelector(".ask-desc").textContent, "Easy to deploy, best for small apps");
  assert.equal(marked.rows()[1].querySelector(".ask-badge").textContent, "Recommended");
  assert.equal(marked.rows()[1].getAttribute("aria-checked"), "true");
  const trailing = panel();
  trailing.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(trailing, [q("q1", "Database?", [opt("SQLite", "Easy to set up; recommended."), opt("JSON", "Quick to try, not recommended")])]);
  assert.equal(trailing.rows()[0].querySelector(".ask-desc").textContent, "Easy to set up");
  assert.deepEqual(trailing.rows().map((row) => !!row.querySelector(".ask-badge")), [true, false]);
  // A leading "Recommended:" goes, and the description left starts with a capital (as questions._unmark).
  const leading = panel();
  leading.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(leading, [q("q1", "Database?", [opt("Mongo", "Recommended: flexible schema"), opt("Recommended: pnpm", "strict installs"),
    opt("uv", "fast resolver")])]);
  assert.deepEqual(leading.rows().map((row) => [row.querySelector(".ask-label").textContent, row.querySelector(".ask-desc")?.textContent]),
    [["Mongo", "Flexible schema"], ["pnpm", "strict installs"], ["uv", "fast resolver"]]);
  // Only a plain lowercase first word takes the capital: a name keeps its case (as questions._SENTENCE_WORD).
  const names = panel();
  names.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(names, [q("q1", "Target?", [opt("Mobile", "Recommended: iOS first"), opt("Kernel", "Recommended - eBPF probes"),
    opt("Node", "Recommended: package.json scripts"), opt("Text", "Recommended: \ufb01le based")])]);
  assert.deepEqual(names.rows().map((row) => row.querySelector(".ask-desc")?.textContent),
    ["iOS first", "eBPF probes", "package.json scripts", "\ufb01le based"]);
  // Multi-select preselects nothing: row 1 holds the highlight, no box is checked.
  const m = panel();
  m.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(m, [q("q1", "Extras?", [opt("A"), opt("B", "", true)], { multi_select: true })]);
  assert.ok(m.rows()[0].classList.contains("hot"));
  assert.equal(m.rows()[0].getAttribute("role"), "checkbox");
  assert.deepEqual(m.rows().map((row) => row.getAttribute("aria-checked")), ["false", "false"]);
  assert.deepEqual(p.errors, []);
});

test("keyboard: digits, arrows into and out of the field, pages, Home/End, Escape and Tab order", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(p, [STORAGE, q("q2", "Second?", [opt("A"), opt("B"), opt("C")])]);
  p.advance(400);
  const card = p.card();
  const focusables = [...card.querySelectorAll("button, textarea")].filter((node) => node.tabIndex >= 0 && !node.disabled && !node.hidden);
  assert.ok(focusables[0].classList.contains("ask-x"), "× comes first in the Tab order");
  assert.deepEqual(focusables.slice(1).map((node) => node.className.split(" ")[0]).filter((c) => c !== "ask-page"),
    ["ask-opt", "ask-field", "ask-skip", "ask-act"]);
  // → and ← page without answering; Home/End move within the list.
  p.key(p.rows()[0], "ArrowRight");
  assert.equal(p.card().querySelector(".ask-q").textContent, "Second?");
  assert.equal(p.card().querySelector(".ask-pg").textContent, "Question 2 of 2");
  p.key(p.rows()[0], "End");
  assert.equal(p.doc.activeElement, p.rows()[2]);
  p.key(p.rows()[2], "Home");
  assert.equal(p.doc.activeElement, p.rows()[0]);
  p.key(p.rows()[0], "ArrowLeft");
  assert.equal(p.card().querySelector(".ask-q").textContent, STORAGE.question);
  assert.deepEqual(p.responses(), []);
  // ↓ from the last option enters the field; ↑ leaves only from its first line.
  p.key(p.rows()[0], "ArrowDown");
  assert.equal(p.doc.activeElement, p.rows()[1]);
  p.key(p.rows()[1], "ArrowDown");
  const field = p.card().querySelector(".ask-field");
  assert.equal(p.doc.activeElement, field);
  field.value = "first line\nsecond line";
  field.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  field.setSelectionRange(field.value.length, field.value.length);
  p.key(field, "ArrowUp");
  assert.equal(p.doc.activeElement, field, "↑ on the second line moves the caret, not the focus");
  field.setSelectionRange(3, 3);
  p.key(field, "ArrowUp");
  assert.equal(p.doc.activeElement, p.rows()[1]);
  // Escape in a non-empty field only moves focus; it never posts, and never cancels the turn.
  p.rows()[1].blur(); field.focus();
  p.key(field, "Escape");
  assert.equal(p.doc.activeElement.classList.contains("ask-opt"), true);
  assert.deepEqual(p.responses(), []);
  field.value = ""; field.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  field.focus();
  const escape = new p.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  let reachedComposer = false;
  p.doc.addEventListener("keydown", () => { reachedComposer = true; }, { once: true });
  field.dispatchEvent(escape);
  assert.equal(reachedComposer, false, "Escape stops at the card");
  assert.deepEqual(p.responses(), [{ type: "options_response", id: "r1", dismissed: true }]);
  assert.equal(p.posted.some((m) => m.type === "cancel"), false);
  // Digit 2 after the guard posts exactly one answer (single question).
  const d = panel();
  d.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(d, [STORAGE]);
  d.advance(400);
  d.key(d.doc.activeElement, "2");
  d.key(d.doc.activeElement, "2");
  d.advance(150);
  assert.deepEqual(d.responses(), [{ type: "options_response", id: "r1", answers: { q1: { selected: [1], other: "" } } }]);
  assert.deepEqual(p.errors, []);
});

test("pointer: a pick shows for 150 ms, then advances; the batch is sent once every question is settled", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  const third = q("q3", "Third?", [opt("X"), opt("Y")]);
  ask(p, [STORAGE, q("q2", "Second?", [opt("A"), opt("B")]), third]);
  p.click(p.rows()[0]);
  assert.equal(p.rows()[0].getAttribute("aria-checked"), "true", "the chosen state shows first");
  assert.equal(p.card().querySelector(".ask-q").textContent, STORAGE.question);
  p.advance(149);
  assert.equal(p.card().querySelector(".ask-q").textContent, STORAGE.question);
  p.advance(1);
  assert.equal(p.card().querySelector(".ask-q").textContent, "Second?");
  // Out of order: page to the third, answer it, and the card jumps back to the unanswered second.
  p.click(p.card().querySelector('.ask-page[data-step="1"]'));
  assert.equal(p.card().querySelector(".ask-q").textContent, "Third?");
  p.click(p.rows()[1]);
  p.advance(150);
  assert.equal(p.card().querySelector(".ask-q").textContent, "Second?");
  assert.deepEqual(p.responses(), []);
  assert.equal(p.card().querySelector(".ask-act").textContent, "Skip");
  p.click(p.card().querySelector(".ask-act"));
  assert.deepEqual(p.responses(), [{ type: "options_response", id: "r1", answers: {
    q1: { selected: [0], other: "" }, q2: { selected: [], other: "" }, q3: { selected: [1], other: "" } } }],
  "Skip settles with an empty selection");
  assert.deepEqual(p.errors, []);
});

test("free text, multi-select with a note, Enter submits", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(p, [EXTRAS, q("q3", "Where should the sync server run?", [opt("Laptop"), opt("NAS")])]);
  p.advance(400);
  const action = () => p.card().querySelector(".ask-act");
  assert.equal(action().textContent, "Skip");
  p.click(p.rows()[0]);
  p.key(p.rows()[2], " ");
  assert.deepEqual(p.rows().map((row) => row.getAttribute("aria-checked")), ["true", "false", "true"]);
  assert.equal(action().textContent, "Next");
  assert.ok(action().classList.contains("primary"));
  const field = p.card().querySelector(".ask-field");
  field.value = "also a size cap";
  field.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  p.click(action());
  assert.equal(p.card().querySelector(".ask-q").textContent, "Where should the sync server run?");
  const second = p.card().querySelector(".ask-field");
  assert.equal(p.card().querySelector(".ask-act").textContent, "Skip");
  second.value = "On the NAS, not the laptop";
  second.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  assert.equal(p.card().querySelector(".ask-act").textContent, "Continue", "text flips Skip to Continue on the last question");
  p.key(second, "Enter", { shiftKey: true });
  assert.deepEqual(p.responses(), [], "Shift+Enter is a newline");
  p.key(second, "Enter");
  assert.deepEqual(p.responses(), [{ type: "options_response", id: "r1", answers: {
    q2: { selected: [0, 2], other: "also a size cap" }, q3: { selected: [], other: "On the NAS, not the laptop" } } }]);
  assert.deepEqual(p.errors, []);
});

test("Sending… keeps the card; a rejection re-enables it; options_resolved removes it", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(p, [STORAGE]);
  p.click(p.rows()[0]);
  p.advance(150);
  assert.equal(p.responses().length, 1);
  const card = p.card();
  assert.ok(card.classList.contains("sending"));
  assert.equal(card.querySelector(".ask-sending").textContent, "Sending…");
  assert.equal(p.doc.getElementById("announcer").textContent, "Sending your answers", "announced through the one live region");
  assert.equal(card.querySelectorAll("[role=status], [role=alert], [aria-live]").length, 0, "the card adds no live region of its own");
  assert.ok([...card.querySelectorAll("button, textarea")].every((node) => node.disabled));
  p.click(p.rows()[1]);
  p.advance(150);
  assert.equal(p.responses().length, 1, "no second response while sending");
  p.event({ type: "command_rejected", command: "options_response", request_id: "other", message: "x" });
  assert.ok(p.card().classList.contains("sending"), "a rejection for another id changes nothing");
  const transcriptErrors = p.doc.querySelectorAll("#log .sys.err").length;
  p.event({ type: "command_rejected", command: "options_response", request_id: "r1", reason: "invalid_response",
    message: "DGC could not use that answer." });
  assert.equal(p.card().classList.contains("sending"), false);
  assert.equal(p.card().querySelector(".ask-error").hidden, false);
  assert.equal(p.card().querySelector(".ask-error").textContent, "DGC could not use that answer.");
  assert.equal(p.card().getAttribute("aria-describedby"), p.card().querySelector(".ask-error").id);
  assert.equal(p.doc.getElementById("announcer").textContent, "DGC could not use that answer.");
  assert.ok([...p.card().querySelectorAll(".ask-opt")].every((node) => !node.disabled));
  assert.equal(p.doc.querySelectorAll("#log .sys.err").length, transcriptErrors, "the reason shows on the card, not in the transcript");
  assert.equal(p.rows()[0].getAttribute("aria-checked"), "true", "the answer is kept");
  assert.equal(p.doc.activeElement, p.rows()[0]);
  assert.equal(p.card().querySelector(".ask-act").textContent, "Continue", "one click resends");
  p.advance(400);
  p.click(p.rows()[1]);
  p.advance(150);
  assert.equal(p.responses().length, 2);
  p.event({ type: "options_resolved", id: "r1", call_id: "call_q", outcome: "answered", questions: [STORAGE],
    answers: { q1: { selected: [1], other: "" } } });
  assert.equal(p.card(), null);
  assert.deepEqual(p.errors, []);
});

test("request_expired, backend_exit and a replacing request each retire the card for good", () => {
  for (const retire of ["expired", "exit", "replaced", "session"]) {
    const p = panel();
    p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
    ask(p, [STORAGE]);
    const card = p.card(), row = p.rows()[0];
    if (retire === "expired") p.event({ type: "request_expired", id: "r1" });
    if (retire === "exit") p.send({ type: "backend_exit", code: 1, recovering: true, resumes: "offer" });
    if (retire === "replaced") ask(p, [EXTRAS], "r2", "call_2");
    if (retire === "session") p.event({ type: "session", kind: "new", message_count: 0, session_id: "s" });
    assert.equal(card.isConnected, false, retire);
    assert.ok(card.classList.contains("expired"), retire);
    p.click(row);
    p.advance(200);
    assert.deepEqual(p.responses(), [], retire);
    if (retire === "replaced") {
      assert.equal(p.card().dataset.requestId, "r2");
      assert.equal(p.doc.getElementById("cbox").querySelectorAll(".ask").length, 1);
    } else {
      assert.equal(p.doc.querySelector("#cbox .cinput").hidden, false, retire);
    }
    assert.deepEqual(p.errors, [], retire);
  }
});

function transcript(events) {
  const p = panel();
  for (const e of events) p.event(e);
  return p;
}
const RESULT = { type: "tool_result", call_id: "call_q", name: "propose_options", is_error: false, is_diff: false, diff: "",
  output: "The user answered your 2 questions:\n- x\nContinue with these decisions." };
const RESOLVED = { type: "options_resolved", id: "r1", call_id: "call_q", outcome: "answered", questions: [STORAGE, EXTRAS],
  answers: { q1: { selected: [0], other: "" }, q2: { selected: [], other: "also a size cap" } } };

test("the answered state renders inside the tool card, identical live, replayed and in either order", () => {
  const call = { type: "tool_call", call_id: "call_q", name: "propose_options", args: {}, summary: "2 questions · Storage, Extras" };
  const live = transcript([{ type: "turn_start", turn_id: "t1", prompt: "go" }, call,
    { type: "options_request", id: "r1", call_id: "call_q", questions: [STORAGE, EXTRAS] }, RESOLVED, RESULT]);
  const reversed = transcript([{ type: "turn_start", turn_id: "t1", prompt: "go" }, call, RESULT, RESOLVED]);
  const replayed = panel();
  replayed.send({ type: "event", event: { type: "history", items: [
    { type: "turn_start", turn_id: "h1", prompt: "go", kind: "prompt" }, call, { ...RESOLVED, id: null }, RESULT,
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: null }] } });
  const shape = (p) => {
    const card = p.doc.querySelector('.tool[data-call-id="call_q"]');
    return { verb: card.querySelector(".verb").textContent, arg: card.querySelector(".arg").textContent,
      glyph: card.querySelector(".glyph svg").dataset.icon, body: card.querySelector(".body").innerHTML,
      classes: [...card.classList].filter((c) => c !== "open").sort().join(" "), badge: card.querySelector(".badge").textContent,
      open: card.classList.contains("open") };
  };
  const expected = shape(live);
  assert.equal(expected.verb, "Asked");
  assert.equal(expected.arg, "2 questions");
  assert.equal(expected.glyph, "circle-help");
  assert.equal(expected.open, false, "collapsed by default");
  assert.equal(expected.badge, "");
  assert.deepEqual(shape(reversed), expected);
  assert.deepEqual(shape(replayed), expected);
  for (const p of [live, reversed, replayed]) {
    const card = p.doc.querySelector('.tool[data-call-id="call_q"]');
    assert.equal(card.querySelector(".body pre"), null, "the raw model-facing result is not shown");
    const items = [...card.querySelectorAll(".asked-list li")];
    assert.equal(items.length, 2);
    assert.equal(items[0].querySelector(".asked-q").textContent, STORAGE.question);
    assert.equal(items[0].querySelector(".asked-a").textContent, "SQLite fileRecommended");
    assert.ok(items[0].querySelector(".ask-badge"));
    assert.equal(items[1].querySelector(".asked-words-label").textContent, "Your words");
    assert.match(items[1].querySelector(".asked-a").textContent, /“also a size cap”/);
    assert.deepEqual(p.errors, []);
  }
  // The open state is remembered per turn and call when the card is drawn again (a history reload)...
  const page = [{ type: "turn_start", turn_id: "h1", prompt: "go", kind: "prompt" }, call, { ...RESOLVED, id: null }, RESULT,
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: null }];
  replayed.doc.querySelector('.tool[data-call-id="call_q"] .tool-toggle').click();
  replayed.send({ type: "event", event: { type: "session", kind: "resumed", message_count: 3, session_id: "s1" } });
  replayed.send({ type: "event", event: { type: "history", items: page } });
  const reloaded = replayed.doc.querySelectorAll('.tool[data-call-id="call_q"]');
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].classList.contains("open"), true);
  // ...but a later turn that reuses the call id (call_0 style) starts collapsed.
  live.doc.querySelector('.tool[data-call-id="call_q"] .tool-toggle').click();
  live.event({ type: "turn_start", turn_id: "t2", prompt: "again" });
  live.event(call);
  live.event(RESOLVED);
  const opens = [...live.doc.querySelectorAll('.tool[data-call-id="call_q"]')].map((card) => card.classList.contains("open"));
  assert.deepEqual(opens, [true, false]);
});

test("keyboard focus returns to the composer when the answered card closes", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  ask(p, [STORAGE]);
  p.advance(400);
  assert.equal(p.doc.activeElement, p.rows()[0]);
  p.key(p.rows()[0], "Enter");
  p.advance(150);
  assert.equal(p.responses().length, 1);
  assert.equal(p.doc.activeElement, p.card(), "the card holds focus while its controls are disabled");
  p.event({ type: "options_resolved", id: "r1", call_id: "call_q", outcome: "answered", questions: [STORAGE],
    answers: { q1: { selected: [0], other: "" } } });
  assert.equal(p.card(), null);
  assert.equal(p.doc.activeElement, p.doc.getElementById("input"));
  assert.deepEqual(p.errors, []);
});

test("answered variants: one question, skipped, dismissed, cancelled, text protocol with no call id", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.event({ type: "tool_call", call_id: "a", name: "propose_options", args: {}, summary: "1 question · Storage" });
  p.event({ type: "options_resolved", id: null, call_id: "a", outcome: "answered", questions: [STORAGE],
    answers: { q1: { selected: [1], other: "" } } });
  const one = p.doc.querySelector('.tool[data-call-id="a"]');
  assert.equal(`${one.querySelector(".verb").textContent} ${one.querySelector(".arg").textContent}`, "Asking · JSON on disk");
  p.event({ type: "tool_result", call_id: "a", name: "propose_options", output: "ok", is_error: false, is_diff: false, diff: "" });
  assert.equal(`${one.querySelector(".verb").textContent} ${one.querySelector(".arg").textContent}`, "Asked · JSON on disk");
  assert.equal(one.querySelector(".ask-badge"), null, "no badge when the pick was not the recommendation");
  p.event({ type: "tool_call", call_id: "b", name: "propose_options", args: {}, summary: "" });
  p.event({ type: "options_resolved", id: null, call_id: "b", outcome: "answered", questions: [STORAGE],
    answers: { q1: { selected: [], other: "" } } });
  assert.equal(p.doc.querySelector('.tool[data-call-id="b"] .asked-skipped').textContent, "Skipped");
  p.event({ type: "tool_call", call_id: "c", name: "propose_options", args: {}, summary: "" });
  p.event({ type: "options_resolved", id: null, call_id: "c", outcome: "dismissed", questions: [STORAGE] });
  assert.equal(p.doc.querySelector('.tool[data-call-id="c"] .asked-outcome').textContent, "Dismissed without an answer");
  p.event({ type: "tool_call", call_id: "d", name: "propose_options", args: {}, summary: "" });
  p.event({ type: "options_resolved", id: null, call_id: "d", outcome: "cancelled", questions: [] });
  assert.equal(p.doc.querySelector('.tool[data-call-id="d"] .asked-outcome').textContent, "Not answered: the turn stopped");
  p.event({ type: "options_resolved", id: null, call_id: null, outcome: "answered", questions: [STORAGE],
    answers: { q1: { selected: [0], other: "" } } });
  const orphan = [...p.doc.querySelectorAll('.tool[data-tool-name="propose_options"]')].at(-1);
  assert.equal(orphan.dataset.callId, "");
  assert.equal(orphan.querySelector(".verb").textContent, "Asked");
  assert.ok(orphan.querySelector(".asked-list .ask-badge"));
  assert.deepEqual(p.errors, []);
});

test("the card's CSS: stacked tiles, quiet recommended badge, forced colours for the highlight, badge and radio", () => {
  const section = mainCss.slice(mainCss.indexOf("/* ---- 0.40 options -"), mainCss.indexOf("/* ---- end 0.40 options -"));
  const rule = (selector) => section.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] || "";
  assert.match(rule(".ask-badge"), /color: var\(--text-strong\)/);
  assert.match(rule(".ask-badge"), /color-mix\(in srgb, var\(--accent-fill\) 14%, transparent\)/);
  assert.match(rule(".ask-foot"), /color: var\(--muted\)/);
  assert.doesNotMatch(section.match(/\.ask-foot[^{]*\{[^}]*\}/g).join(""), /--faint/);
  assert.match(section, /\.ask-opt:hover, \.ask-opt\.hot \{ background: color-mix\(in srgb, var\(--text\) 6%, transparent\);/);
  assert.match(rule(".ask-n"), /border: 1\.5px solid color-mix\(in srgb, var\(--text\) 40%, transparent\)/);
  assert.match(rule(".ask-opts"), /gap: 6px/);
  assert.match(rule(".ask-act"), /min-height: var\(--control\)/);
  const forced = section.slice(section.indexOf("@media (forced-colors: active)"));
  for (const selector of [".ask-opt.hot", ".ask-badge", ".ask-n"]) assert.ok(forced.includes(selector), selector);
  assert.match(forced, /\.ask-opt\.hot \{[^}]*Highlight/);
  assert.doesNotMatch(mainCss, /button\.opt|\.question-(tab|form|other|hint|progress|summary)/, "the v13 question form CSS is gone");
  assert.match(section, /#cbox\.asking > \.cinput, #cbox\.asking > #attachments \{ display: none; \}/);
});
