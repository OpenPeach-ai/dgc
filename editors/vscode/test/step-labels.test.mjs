// Plain-words labels on each step (asked 11 Nov): a command may come with a short description of what it is for
// ("Run the upload tests"), in the tool_call's own args (DGC's bash and Claude Code's Bash both send args.description).
// The row shows the label in the quiet grey; the exact command is one click away, in a chip at the top of the row's
// detail, and Copy still copies the command. The label is the model's words: text only, one line, bounded, and never
// on the approval card, which goes by the exact command. Chromium measures it in step-labels-layout.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";
import { STEPS, MISLEADING, call, result, ask, labelledTurn, savedTurn } from "./support/step-labels-scene.mjs";

function panel() {
  const h = makeDom();
  const event = (e) => h.send({ type: "event", event: e });
  return { ...h, event };
}
const rowOf = (doc, id) => doc.querySelector(`#log .tool[data-call-id="${id}"]`);
const facts = (row) => ({ verb: row.querySelector(".verb").textContent, arg: row.querySelector(".arg").textContent,
  label: row.querySelector(".arg.step-label")?.textContent ?? null, title: row.querySelector(".arg").title,
  chip: row.querySelector(".body .step-command")?.textContent ?? null });
const start = (event) => event({ type: "turn_start", turn_id: "t1", prompt: "Go", kind: "prompt" });

test("a command with a description shows it as the row's label; the exact command is in the row's detail", () => {
  const { event, doc, posted, errors } = panel();
  for (const frame of labelledTurn()) event(frame);
  for (const step of STEPS.filter((s) => s.label)) {
    const row = rowOf(doc, step.id), f = facts(row);
    assert.equal(f.verb, "Ran");
    assert.equal(f.label, step.label, "the label is what the row says");
    assert.equal(f.title, step.label, "and its title, whole, for a row too narrow to show it");
    assert.equal(row.querySelector(".head").textContent.includes(step.command), false, "the command is not on the folded row");
    assert.equal(row.dataset.summary, step.command);
    assert.equal(f.chip, `$ ${step.command}`, "the exact command, in the detail");
    const body = row.querySelector(".body");
    assert.equal(body.firstElementChild, row.querySelector(".step-command"), "first in the detail, above the output");
    assert.equal(body.querySelector("pre").textContent, step.output);
    const toggle = row.querySelector(".tool-toggle");
    assert.equal(row.classList.contains("open"), false);
    toggle.click();
    assert.equal(row.classList.contains("open"), true, "one click opens it");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    row.querySelector(".tool-copy-cmd").click();
    assert.equal(posted.filter((m) => m.type === "copy").at(-1)?.text, step.command, "Copy copies the command, never the label");
  }
  assert.deepEqual(errors, []);
});

test("a command with no description is the row it always was", () => {
  const { event, doc } = panel();
  for (const frame of labelledTurn()) event(frame);
  const plain = STEPS.find((s) => !s.label), row = rowOf(doc, plain.id);
  assert.deepEqual(facts(row), { verb: "Ran", arg: plain.command, label: null, title: "", chip: null });
  assert.equal(row.hasAttribute("data-step-label"), false);
  // An empty, blank or non-text description is no label either, and one that only repeats the command adds nothing.
  for (const [i, description] of ["", "   \n ", 7, null, { text: "x" }, ["Run"], "npm test"].entries()) {
    event({ type: "tool_call", call_id: `n${i}`, name: "bash", args: { command: "npm test", description }, summary: "npm test" });
    assert.deepEqual(facts(rowOf(doc, `n${i}`)), { verb: "Running", arg: "npm test", label: null, title: "", chip: null }, `description ${JSON.stringify(description)}`);
  }
});

test("Claude Code's own Bash steps carry their description the same way", () => {
  const { event, doc } = panel();
  start(event);
  event(call(STEPS[1], "Bash")); event(result(STEPS[1], "Bash"));
  assert.equal(facts(rowOf(doc, STEPS[1].id)).label, STEPS[1].label);
  assert.equal(facts(rowOf(doc, STEPS[1].id)).chip, `$ ${STEPS[1].command}`);
});

test("only a command takes a label: another tool's description is not one, and a delegation keeps its name", () => {
  const { event, doc } = panel();
  start(event);
  event({ type: "tool_call", call_id: "r1", name: "read_file", args: { path: "a.py", description: "Totally harmless" }, summary: "a.py" });
  assert.equal(facts(rowOf(doc, "r1")).label, null);
  assert.equal(facts(rowOf(doc, "r1")).arg, "a.py");
  event({ type: "tool_call", call_id: "k1", name: "task", args: { description: "Review the rules", prompt: "do it" }, summary: "" });
  assert.equal(rowOf(doc, "k1").querySelector(".step-label"), null);
  assert.equal(rowOf(doc, "k1").querySelector(".step-command"), null);
});

test("the label is the model's text: no markup, one line, bounded", () => {
  const { event, doc } = panel();
  start(event);
  const hostile = "<img src=x onerror=alert(1)><b>Run</b>\n\nthe\ttests‮ \u0007now";
  event({ type: "tool_call", call_id: "x1", name: "bash", args: { command: "npm test", description: hostile }, summary: "npm test" });
  const row = rowOf(doc, "x1"), label = row.querySelector(".step-label");
  assert.equal(label.children.length, 0, "text only");
  assert.equal(row.querySelector("img, b"), null);
  assert.equal(label.textContent, "<img src=x onerror=alert(1)><b>Run</b> the tests now", "one line: breaks, tabs and direction marks are spaces");
  assert.equal(/[\n\r\t‮\u0007]/.test(label.title), false);
  const long = "Check every single file ".repeat(40);
  event({ type: "tool_call", call_id: "x2", name: "bash", args: { command: "ls", description: long }, summary: "ls" });
  const text = rowOf(doc, "x2").querySelector(".step-label").textContent;
  assert.ok(text.length <= 120, `bounded (${text.length})`);
  assert.ok(text.endsWith("…"), "and says it was cut");
  assert.ok(rowOf(doc, "x2").querySelector(".step-label").title.length <= 500, "its title is bounded too");
  // The command in the detail is text too.
  event({ type: "tool_call", call_id: "x3", name: "bash", args: { command: "echo '<b>hi</b>'", description: "Say hi" }, summary: "echo '<b>hi</b>'" });
  const chip = rowOf(doc, "x3").querySelector(".step-command");
  assert.equal(chip.querySelector("b"), null);
  assert.equal(chip.textContent, "$ echo '<b>hi</b>'");
});

test("a misleading label never reaches the approval card: the card shows the exact command, the row the label", () => {
  const { event, doc, posted } = panel();
  for (const frame of labelledTurn()) event(frame);
  const card = doc.querySelector(`.card[data-request-id="req-${MISLEADING.id}"]`);
  assert.ok(card, "the approval card is up");
  assert.equal(card.querySelector("pre").textContent, `$ ${MISLEADING.command}`);
  assert.equal(card.textContent.includes(MISLEADING.label), false, "the label is nowhere on the card");
  assert.equal(card.innerHTML.includes(MISLEADING.label), false, "not in a title or an attribute either");
  assert.equal(card.querySelector(".step-label, .step-command"), null);
  card.querySelector('button[data-d="once"]').click();
  assert.deepEqual(posted.filter((m) => m.type === "permission_response").map((m) => [m.id, m.decision]), [[`req-${MISLEADING.id}`, "once"]]);
  event(call(MISLEADING)); event(result({ ...MISLEADING, output: "" }));
  const row = rowOf(doc, MISLEADING.id);
  assert.equal(facts(row).label, MISLEADING.label, "the finished row wears the label");
  assert.equal(facts(row).chip, `$ ${MISLEADING.command}`, "with the command it ran one click away");
  assert.equal(card.textContent.includes(MISLEADING.label), false, "and the settled card still does not");
  assert.equal(card.innerHTML.includes(MISLEADING.label), false);
});

test("a reloaded session shows the same labels", () => {
  const live = panel();
  for (const frame of savedTurn("t1")) live.event(frame);
  const again = panel();
  again.event({ type: "history", items: savedTurn("h1"), complete: true });
  const read = (doc) => [...doc.querySelectorAll("#log .tool")].map((row) => facts(row));
  assert.equal(read(again.doc).length, 5);
  assert.deepEqual(read(again.doc), read(live.doc));
  assert.deepEqual(read(again.doc).map((f) => f.label), [...STEPS.map((s) => s.label || null), MISLEADING.label]);
  assert.deepEqual(again.errors, []);
});

test("while a labelled command runs, the live row under the folded line says the label", () => {
  const { event, doc } = panel();
  start(event);
  event(call(STEPS[1]));
  assert.equal(doc.querySelector(".tg-live .tg-live-arg").textContent, STEPS[1].label);
});
