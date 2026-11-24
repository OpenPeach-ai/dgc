// A turn whose start isn't in the history the panel was sent (an older backend's cut, or a payload that starts inside a
// turn) is still one turn: its leftover steps are one unit that paging never splits, drawn into one block that folds
// under its "Worked" row once its answer is shown. Found 24 Nov on a goal session: each leftover step was a unit of its
// own, so a 316-step turn came back 25 steps a page, every page ending "Worked" with its steps open and no answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const savedTurn = (n) => [
  { type: "turn_start", turn_id: `h${n}`, prompt: `Saved prompt ${n}`, kind: "prompt" },
  { type: "text_delta", text: `Checking ${n}` },
  { type: "stream_end", message_id: `h${n}:1`, phase: "commentary" },
  { type: "tool_call", call_id: `h${n}c1`, name: "bash", args: { command: "npm test" }, summary: "npm test" },
  { type: "tool_result", call_id: `h${n}c1`, name: "bash", output: "ok", is_error: false },
  { type: "text_delta", text: `Answer ${n}` },
  { type: "stream_end", message_id: `h${n}:2`, phase: "answer" },
  { type: "turn_end", turn_id: `h${n}`, reason: "completed", token_estimate: 0, final_message_id: `h${n}:2` },
];
// The last 80 steps of a long turn, with the saved time markers between them, then its answer and its end.
function cutTurnTail(steps = 80) {
  const items = [{ role: "notice", text: "Showing the most recent saved context. Earlier messages remain in the session file." }];
  for (let i = 0; i < steps; i++) {
    items.push({ role: "time", of: "trace", at: 1763000000 + i });
    if (i % 10 === 0) items.push({ type: "text_delta", text: `Checking part ${i}.` }, { type: "stream_end", message_id: `h9:${i + 1}`, phase: "commentary" });
    items.push({ type: "tool_call", call_id: `c${i}`, name: "bash", args: { command: `npm run check -- ${i}` }, summary: `npm run check ${i}` });
    items.push({ type: "tool_result", call_id: `c${i}`, name: "bash", output: "ok", is_error: false });
  }
  items.push({ type: "text_delta", text: "The dashboard is rebuilt." }, { type: "stream_end", message_id: "h9:999", phase: "answer" });
  items.push({ type: "turn_end", turn_id: "h9", reason: "completed", token_estimate: 0, final_message_id: "h9:999" });
  return items;
}
// Steps on screen outside any fold.
const openSteps = (doc) => [...doc.querySelectorAll("#log .tool, #log .tool-group")].filter((n) => !n.closest(".work-step"));

test("a turn's leftover steps are one turn: one block, folded, its answer shown", async () => {
  const { doc, send, errors, dom } = makeDom();
  const items = cutTurnTail();
  for (let n = 10; n < 40; n++) items.push(...savedTurn(n));      // more than a page of whole turns after it
  send({ type: "event", event: { type: "history", items, complete: true } });
  const pages = doc.querySelector(".history-pages");
  for (let i = 0; i < 6 && !doc.querySelector(".history-older").hidden; i++) doc.querySelector(".history-older").click();
  const blocks = [...pages.querySelectorAll(".msg.dgc")];
  assert.equal(blocks.length, 31, "30 whole turns and the cut one: its steps never became turns of their own");
  const cut = blocks.find((b) => b.textContent.includes("The dashboard is rebuilt."));
  assert.ok(cut.classList.contains("has-work-fold") && cut.classList.contains("work-folded"), "its work is folded");
  assert.equal(cut.querySelectorAll(":scope > .work-toggle").length, 1, "under one row");
  assert.equal(cut.querySelector(".answer > .text.final").textContent.trim(), "The dashboard is rebuilt.");
  assert.equal(cut.querySelectorAll(".tool").length, 80, "every step it was sent is in it");
  assert.deepEqual(openSteps(doc).map((n) => n.textContent.trim().slice(0, 40)), [], "no step left open anywhere");
  assert.equal([...pages.querySelectorAll(".thinking.done")].filter((r) => r.textContent === "Worked" && !r.classList.contains("work-toggle")).length, 0,
    "no \"Worked\" row with nothing under it");
  assert.deepEqual(errors, []);
  dom.window.close();
});

test("paging still cuts between whole turns, 25 a page", () => {
  const { doc, send, errors, dom } = makeDom();
  const items = [];
  for (let n = 1; n <= 30; n++) items.push(...savedTurn(n));
  send({ type: "event", event: { type: "history", items, complete: true } });
  const pages = doc.querySelector(".history-pages");
  assert.equal(pages.querySelectorAll(".msg.dgc").length, 25);
  doc.querySelector(".history-older").click();
  assert.equal(pages.querySelectorAll(".msg.dgc").length, 30);
  assert.deepEqual(errors, []);
  dom.window.close();
});
