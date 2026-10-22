// One line per stretch of work. A deepseek turn drew, between two sentences, "▸ Thought for 2s · raw",
// "Ran 1 command", "▸ Thought for 1s · raw", "Ran 1 command" ... six pairs, twelve rows: every thought
// ended the tool group (decision D7), so think, step, think, step never merged. Now everything between
// two pieces of prose is one group line, each thought is a small mark on the step it led to, and while
// the stretch works one row under the line says what runs now. The rendered checks (height, widths,
// keyboard) are in tool-rows-one-line-layout.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";
import { SECONDS, THOUGHTS, founderTurn } from "./support/tool-rows-scene.mjs";

function panel() {
  const h = makeDom();
  const event = (e) => h.send({ type: "event", event: e });
  return { ...h, event, turn: () => [...h.doc.querySelectorAll("#log .msg.dgc")].at(-1) };
}
const squash = (value) => String(value).replace(/\s+/g, " ").trim();
// What the turn shows at its own level, in order, with no sr-only role.
const rows = (turn) => [...turn.children].filter((n) => !n.matches(".role"))
  .map((n) => n.matches(".tool-group") ? "group" : n.matches(".tg-live") ? "live" : n.matches(".disclosure") ? "thought"
    : n.matches(".reasoning") ? "body" : n.matches(".text") ? "text" : n.matches(".thinking") ? "act"
    : n.matches(".answer") ? "answer" : n.matches(".card") ? "card" : n.className);

test("the founder's six think-and-run pairs between two sentences are one line, six steps, a thought mark on each", () => {
  const { event, doc, turn, errors } = panel();
  for (const frame of founderTurn()) event(frame);
  const groups = [...doc.querySelectorAll(".tool-group")];
  assert.equal(groups.length, 1, "one group for the stretch, not six");
  // The "Worked for" row heads the turn once it has answered: the sentence and the line fold under it
  // (work-fold.test.mjs), and nothing but the line is between the sentences.
  assert.deepEqual(rows(turn()), ["act", "text", "group", "answer"], "nothing but the line between the sentences");
  const group = groups[0];
  assert.equal(group.open, false, "folded once finished");
  assert.equal(squash(group.querySelector(".tool-group-label").textContent), "Ran 6 commands · thought 13s");
  const cards = [...group.querySelectorAll(":scope > .tool")];
  assert.equal(cards.length, 6, "six steps, not twelve rows");
  cards.forEach((card, i) => {
    const marks = [...card.querySelectorAll(".thought-mark")];
    assert.equal(marks.length, 1, `step ${i + 1} wears the thought that led to it`);
    const mark = marks[0];
    assert.equal(mark.tagName, "BUTTON");
    assert.equal(mark.parentElement, card.querySelector(".head"), "on the step's row, beside its name");
    assert.equal(squash(mark.querySelector(".thought-label").textContent), `thought ${SECONDS[i]}s`);
    assert.equal(mark.getAttribute("aria-expanded"), "false");
    assert.match(mark.title, /Raw reasoning from the model/, "the provenance stays in the tooltip");
    assert.match(squash(mark.textContent), /, raw$/, "and for a screen reader");
    // The same body as today: the thought's text, untouched, opened from the mark.
    const body = doc.getElementById(mark.getAttribute("aria-controls"));
    assert.equal(body.parentElement, card, "the thought opens under the step");
    assert.equal(body.textContent, THOUGHTS[i]);
    assert.equal(body.classList.contains("show"), false);
    mark.click();
    assert.equal(body.classList.contains("show"), true);
    assert.equal(mark.getAttribute("aria-expanded"), "true");
    assert.equal(card.classList.contains("open"), false, "reading the thought does not open the step's output");
  });
  assert.equal(doc.querySelectorAll(".tg-live").length, 0, "the live row went with the stretch");
  assert.deepEqual(errors, []);
});

test("while the stretch works one live row says what runs now, updated in place", () => {
  const { event, doc, turn } = panel();
  const frames = founderTurn("t1", { answer: false });
  for (const frame of frames.slice(0, 3)) event(frame);
  // The first thought, before the stretch has a step, is today's row.
  event(frames[3]);
  assert.deepEqual(rows(turn()).slice(0, 3), ["text", "thought", "body"]);
  assert.match(turn().querySelector(":scope > .disclosure").textContent, /Thinking…/);
  event(frames[4]); event(frames[5]);
  assert.deepEqual(rows(turn()), ["text", "group", "live", "act"], "the thought joined the step; the line and its live row");
  const live = doc.querySelector(".tg-live");
  const text = () => squash(live.textContent);
  assert.equal(live.dataset.state, "running");
  assert.match(text(), /^Running python -m erp\.gst\.export --date yesterday/);
  assert.ok(live.querySelector(".tg-live-spin"), "a spinner while it runs");
  assert.equal(squash(doc.querySelector(".tool-group-label").textContent), "Running a command · thought 2s");
  event(frames[6]);
  assert.equal(live.dataset.state, "done");
  assert.match(text(), /^Ran python -m erp\.gst\.export/, "the last step done, until the next one starts");
  event(frames[7]);
  assert.equal(doc.querySelector(".tg-live"), live, "the same row");
  assert.equal(live.dataset.state, "thinking");
  assert.equal(text(), "Thinking…", "the model thinking between steps");
  assert.equal(doc.querySelectorAll("#log .msg.dgc > .disclosure").length, 0, "no thought row of its own");
  event(frames[8]); event(frames[9]);
  assert.equal(doc.querySelector(".tg-live"), live, "still the same row");
  assert.equal(live.dataset.state, "running");
  assert.match(text(), /^Running grep -n "cess" erp\/gst\/totals\.py/, "it replaced the previous step");
  assert.equal(squash(doc.querySelector(".tool-group-label").textContent), "Running a command · thought 3s");
  assert.equal(doc.querySelectorAll(".tool-group").length, 1);
  assert.equal(live.previousElementSibling, doc.querySelector(".tool-group"), "always right under its line");
  // Prose closes the stretch: the live row goes, the line stays folded.
  event(frames[10]);
  event({ type: "text_delta", text: "The export drops cess." });
  assert.equal(doc.querySelectorAll(".tg-live").length, 0);
  assert.equal(doc.querySelector(".tool-group").open, false);
  assert.equal(squash(doc.querySelector(".tool-group-label").textContent), "Ran 2 commands · thought 3s");
});

test("an opened group shows the steps themselves and the thought still streaming at its end", () => {
  const { event, doc } = panel();
  const frames = founderTurn("t1", { answer: false });
  for (const frame of frames.slice(0, 7)) event(frame);
  event({ type: "thinking_delta", block: "t1:think2", source: "raw", text: "Still deciding" });
  const group = doc.querySelector(".tool-group");
  const trailing = group.lastElementChild.previousElementSibling;
  assert.ok(trailing.matches(".disclosure"), "the thought in progress is the group's last row");
  assert.match(trailing.textContent, /Thinking…/);
  assert.equal(trailing.classList.contains("thought-mark"), false, "a row until a step takes it");
  event({ type: "thinking_delta", block: "t1:think2", source: "raw", text: " which file to read." });
  assert.equal(group.lastElementChild.textContent, "Still deciding which file to read.", "it keeps streaming there");
});

test("thinking before prose stays: a row with no step around it, the group's last row after steps", () => {
  const { event, doc, turn } = panel();
  event({ type: "turn_start", turn_id: "t1", prompt: "q", kind: "prompt" });
  event({ type: "thinking_delta", block: "t1:a", source: "raw", text: "Just answer." });
  event({ type: "thinking_end", block: "t1:a", source: "raw", placement: "collapsed", seconds: 2 });
  event({ type: "text_delta", text: "Sure." });
  event({ type: "stream_end", message_id: "t1:1", phase: "commentary" });
  assert.deepEqual(rows(turn()).slice(0, 3), ["thought", "body", "text"], "no step, so today's row");
  event({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "ls" }, summary: "ls" });
  event({ type: "tool_result", call_id: "c1", name: "bash", output: "a", is_error: false });
  event({ type: "thinking_delta", block: "t1:b", source: "raw", text: "That is all I need." });
  event({ type: "thinking_end", block: "t1:b", source: "raw", placement: "collapsed", seconds: 4 });
  event({ type: "text_delta", text: "Done." });
  const group = doc.querySelector(".tool-group");
  assert.ok(group.lastElementChild.matches(".reasoning") && group.lastElementChild.previousElementSibling.matches(".disclosure"),
    "the thought that ended the stretch is the group's last row");
  assert.equal(squash(group.querySelector(".tool-group-label").textContent), "Ran 1 command · thought 4s", "counted on the line");
  assert.deepEqual(rows(turn()).slice(0, 5), ["thought", "body", "text", "group", "text"]);
});

test("an approval inside a stretch stays outside the folded line, visible", () => {
  const { event, doc, turn } = panel();
  const frames = founderTurn("t1", { answer: false });
  for (const frame of frames.slice(0, 6)) event(frame);
  event({ type: "permission_request", id: "p1", name: "bash", command: frames[5].summary, args: frames[5].args });
  const card = doc.querySelector(".card[data-request-id]");
  assert.equal(card.closest(".tool-group"), null, "never inside the group");
  assert.equal(card.parentElement, turn());
  assert.deepEqual(rows(turn()), ["text", "group", "live", "card", "act"]);
  card.querySelector('button[data-d="once"]').click();
  for (const frame of frames.slice(6, 10)) event(frame);
  assert.equal(doc.querySelectorAll(".tool-group").length, 1, "the stretch carries on in its one line");
  assert.equal(doc.querySelectorAll(".tool-group > .tool").length, 2);
  assert.equal(card.closest(".tool-group"), null, "and the approval is still on screen");
  assert.deepEqual(rows(turn()), ["text", "group", "live", "card", "act"]);
});

test("a withheld thought is a mark too, with nothing to open; an inline note still breaks the stretch", () => {
  const { event, doc } = panel();
  event({ type: "turn_start", turn_id: "t1", prompt: "q", kind: "prompt" });
  event({ type: "thinking_end", block: "t1:w1", source: "withheld", provider: "openai", placement: "collapsed", seconds: 6 });
  event({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "ls" }, summary: "ls" });
  event({ type: "tool_result", call_id: "c1", name: "bash", output: "a", is_error: false });
  event({ type: "thinking_end", block: "t1:w2", source: "withheld", provider: "openai", placement: "collapsed", seconds: 2 });
  event({ type: "tool_call", call_id: "c2", name: "bash", args: { command: "pwd" }, summary: "pwd" });
  event({ type: "tool_result", call_id: "c2", name: "bash", output: "/", is_error: false });
  let groups = [...doc.querySelectorAll(".tool-group")];
  assert.equal(groups.length, 1);
  const marks = [...groups[0].querySelectorAll(".thought-static.thought-mark")];
  assert.equal(marks.length, 2);
  assert.equal(marks[0].tagName, "DIV", "nothing to open, so not a button");
  assert.equal(squash(marks[0].querySelector(".thought-label").textContent), "thought 6s");
  assert.match(squash(marks[0].textContent), /hidden by OpenAI/);
  assert.equal(squash(groups[0].querySelector(".tool-group-label").textContent), "Ran 2 commands · thought 8s");
  event({ type: "thinking_delta", block: "t1:n", source: "summarized", provider: "anthropic", text: "Now the tests." });
  event({ type: "thinking_end", block: "t1:n", source: "summarized", provider: "anthropic", placement: "inline", seconds: 1 });
  const note = doc.querySelector(".thought-note");
  assert.equal(note.closest(".tool-group"), null, "a note is prose the reader sees");
  assert.equal(note.previousElementSibling, groups[0], "after the line it followed");
  event({ type: "tool_call", call_id: "c3", name: "bash", args: { command: "npm test" }, summary: "npm test" });
  groups = [...doc.querySelectorAll(".tool-group")];
  assert.equal(groups.length, 2, "and the step after it starts a new line");
  assert.equal(note.nextElementSibling, groups[1]);
});

test("a sub-agent's thinking still ends the parent's group (D7 holds for sub-agents)", () => {
  const { event, doc } = panel();
  event({ type: "turn_start", turn_id: "t1", prompt: "q", kind: "prompt" });
  event({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "ls" }, summary: "ls" });
  event({ type: "thinking_delta", block: "t1:x", source: "raw", agent: "sub-0123456789ab", text: "child" });
  event({ type: "thinking_end", block: "t1:x", source: "raw", agent: "sub-0123456789ab", placement: "collapsed", seconds: 1 });
  event({ type: "tool_call", call_id: "c2", name: "bash", args: { command: "pwd" }, summary: "pwd" });
  const groups = [...doc.querySelectorAll(".tool-group")];
  assert.equal(groups.length, 2);
  assert.equal(groups[0].querySelector(".disclosure"), null, "the child's thought is not in the parent's line");
  assert.equal(doc.querySelectorAll(".thought-mark").length, 0);
});

test("a thought before a delegation stays a row: the spawn's group hides once its agent starts", () => {
  const { event, doc } = panel();
  event({ type: "turn_start", turn_id: "t1", prompt: "q", kind: "prompt" });
  event({ type: "thinking_delta", block: "t1:a", source: "raw", text: "Hand it to a helper." });
  event({ type: "thinking_end", block: "t1:a", source: "raw", placement: "collapsed", seconds: 1 });
  event({ type: "tool_call", call_id: "call_1", name: "task", args: { description: "Explore", prompt: "map" }, summary: "" });
  assert.equal(doc.querySelectorAll(".thought-mark").length, 0);
  assert.ok(doc.querySelector("#log .msg.dgc > .disclosure"));
});

test("hide-reasoning hides the marks and the line's thinking words", () => {
  const { event, doc } = panel();
  event({ type: "config", model: "m", mode: "default", think: "off", base_url: "http://h", show_reasoning: false });
  for (const frame of founderTurn()) event(frame);
  assert.ok(doc.body.classList.contains("hide-reasoning"));
  assert.ok(doc.querySelector(".tool-group-label .tg-thought"), "the words are there for when it is shown again");
});

// Replay parity: the history of the same turn draws the same line, steps and marks.
test("a replayed stretch renders identically to the live one", () => {
  const live = panel();
  for (const frame of founderTurn("t1")) live.event(frame);
  const restored = makeDom();
  const items = founderTurn("h1").map((frame) => frame.type === "turn_end" ? { ...frame, token_estimate: 0 } : frame);
  restored.send({ type: "event", event: { type: "history", items } });
  const normalise = (html) => html
    .replace(/tool-output-\d+/g, "tool-output-N").replace(/reasoning-\d+/g, "reasoning-N")
    .replace(/\b[a-z]\d+:(\d+)\b/g, "m:$1").replace(/\b[a-z]\d+:think(\d+)\b/g, "m:think$1")
    .replace(/Worked for \d+s/g, "Worked")
    .replace(/<time class="msg-time"[^>]*>[^<]*<\/time>/g, "")
    .replace(/<span class="tool-time">[^<]*<\/span>/g, '<span class="tool-time"></span>')
    .replace(/ hist\b/g, "").replace(/ run\b/g, "")
    .replace(/\s+/g, " ").trim();
  const pages = restored.doc.querySelector(".history-pages").cloneNode(true);
  pages.querySelector(".history-older")?.remove();
  const shape = normalise(live.doc.getElementById("log").innerHTML);
  assert.ok(shape.includes("thought-mark") && shape.length > 2000);
  assert.equal(normalise(pages.innerHTML), shape);
  for (const doc of [live.doc, restored.doc]) {
    assert.equal(doc.querySelectorAll(".tool-group").length, 1);
    assert.equal(doc.querySelectorAll(".tool-group > .tool > .head > .thought-mark").length, 6);
    assert.equal(squash(doc.querySelector(".tool-group-label").textContent), "Ran 6 commands · thought 13s");
  }
  assert.deepEqual(live.errors, []);
  assert.deepEqual(restored.errors, []);
});

test("a webview reloaded mid-stretch draws the line and its live row again", () => {
  const { send, doc } = makeDom();
  const frames = founderTurn("t1", { answer: false }).slice(0, 10);   // c2 is running
  send({ type: "turn_active", turnId: "t1", kind: "prompt", prompt: frames[0].prompt, startedAt: Date.now() - 5000, history: true });
  send({ type: "event", event: { type: "history", items: frames } });
  assert.equal(doc.querySelectorAll(".tool-group").length, 1);
  const live = doc.querySelector(".tool-group + .tg-live");
  assert.ok(live, "the stretch the reload caught working has its live row");
  assert.equal(live.dataset.state, "running");
  assert.match(squash(live.textContent), /^Running grep -n "cess"/);
  send({ type: "event", event: { type: "tool_result", call_id: "c2", name: "bash", output: "88: total", is_error: false } });
  assert.equal(doc.querySelector(".tg-live"), live, "and the live events carry on in the same row");
  assert.equal(live.dataset.state, "done");
  send({ type: "event", event: { type: "text_delta", text: "Found it." } });
  assert.equal(doc.querySelector(".tg-live"), null);
});
