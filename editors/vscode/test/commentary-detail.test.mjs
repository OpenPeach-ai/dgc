// A detailed mid-turn message: the Work prompt now lets the model write out, with formatting, something
// the user should read in full before it goes on (a diagnosis, a plan before substantial work), in the
// message with its next tool call. The wire phase stays "commentary", so the webview reads the shape:
// a one-line update stays a progress line, a structured or long message is laid out like an answer
// (.commentary-detail) and stays in the transcript after the turn ends. jsdom checks the DOM here;
// commentary-detail-layout.test.mjs checks what Chromium lays out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainJs } from "./support/webview-dom.mjs";
import { ONE_LINE, detailTurn } from "./support/commentary-detail-scene.mjs";

function panel() {
  const { doc, send, errors } = makeDom();
  return { doc, event: (data) => send({ type: "event", event: data }), errors };
}
const blockWith = (doc, words) => [...doc.querySelectorAll(".text")].find((n) => n.textContent.includes(words));

test("a formatted diagnosis is a detailed message; a one-line update stays a line", () => {
  const { doc, event, errors } = panel();
  for (const frame of detailTurn()) event(frame);
  assert.deepEqual(errors, []);
  const diagnosis = blockWith(doc, "Why the stock value is off");
  const line = blockWith(doc, ONE_LINE);
  assert.ok(diagnosis.classList.contains("commentary") && diagnosis.classList.contains("commentary-detail"));
  assert.ok(diagnosis.querySelector("h2") && diagnosis.querySelector("ul"), "its formatting is rendered");
  assert.ok(line.classList.contains("commentary"));
  assert.equal(line.classList.contains("commentary-detail"), false, "a progress line is not promoted");
  const opener = blockWith(doc, "I'll run the suite");
  assert.equal(opener.classList.contains("commentary-detail"), false);
  const answer = blockWith(doc, "Fixed: 10 units");
  assert.equal(answer.classList.contains("commentary-detail"), false, "the answer is the answer");
  assert.ok(answer.closest(".answer.complete"));
});

test("it is told apart while the turn runs, with its copy, and stays in the transcript after", () => {
  const { doc, event } = panel();
  const frames = detailTurn("t1", { end: false });
  for (const frame of frames.slice(0, 7)) event(frame);          // up to the diagnosis's stream_end
  const diagnosis = blockWith(doc, "Why the stock value is off");
  assert.ok(diagnosis.classList.contains("commentary-detail"), "marked as soon as it closes, not at turn end");
  const copy = diagnosis.querySelector(":scope > .commentary-actions button");
  assert.ok(copy, "its copy is there live (the last render used to wipe it until the turn ended)");
  assert.equal(copy.getAttribute("aria-label"), "Copy this message");
  for (const frame of detailTurn().slice(7)) event(frame);
  const after = blockWith(doc, "Why the stock value is off");
  assert.ok(after && after.isConnected, "kept after the final answer");
  assert.ok(after.classList.contains("commentary-detail"));
  assert.equal(after.querySelectorAll(":scope > .commentary-actions").length, 1, "one copy, not two");
});

test("two paragraphs, or one long one, are detailed too; a heading alone is enough", () => {
  const { doc, event } = panel();
  const long = "The export drops the cess column. ".repeat(12).trim();
  const cases = [["Found the cause.\n\nIt is the comparison on line 21.", true], [long, true],
                 ["### Plan\nEdit three files.", true], ["Short and sweet, one sentence.", false]];
  event({ type: "turn_start", turn_id: "t2", prompt: "go", kind: "prompt" });
  cases.forEach(([text], i) => {
    event({ type: "text_delta", text });
    event({ type: "stream_end", message_id: `t2:${i}`, phase: "commentary" });
    event({ type: "tool_call", call_id: `t2c${i}`, name: "bash", args: { command: "true" }, summary: "true" });
    event({ type: "tool_result", call_id: `t2c${i}`, name: "bash", output: "", is_error: false });
  });
  const blocks = [...doc.querySelectorAll(".text.commentary")];
  assert.deepEqual(blocks.map((n) => n.classList.contains("commentary-detail")), cases.map(([, detailed]) => detailed));
});

test("a reloaded chat draws the same detailed message", () => {
  const { doc, event } = panel();
  event({ type: "history", items: detailTurn("h1"), complete: true });
  const diagnosis = blockWith(doc, "Why the stock value is off");
  assert.ok(diagnosis, "the history drew it");
  assert.ok(diagnosis.classList.contains("commentary-detail"), "and laid it out as a detailed message again");
});

test("the wire keeps its two phases: the shape is read in the webview", () => {
  assert.doesNotMatch(mainJs, /phase === "detail"|phase: "detail"|"partial_answer"/,
    "no third phase on the wire: older SDKs refuse an unknown value");
  assert.match(mainJs, /function isDetailedCommentary\(/);
});
