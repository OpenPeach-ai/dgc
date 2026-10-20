// The detailed mid-turn message scene for commentary-detail*.test.mjs: an opening line, a tool row, a
// formatted diagnosis (heading, list), a tool row, a one-line update, a tool row, then the answer.
export const ONE_LINE = "Baseline is green (11 tests). Starting change 1.";
export const DIAGNOSIS = [
  "## Why the stock value is off",
  "",
  "`get_price` gives the bulk discount only when `qty > BULK_QTY`, so exactly 10 units pay full price.",
  "",
  "- the paper reams (qty 10) are valued at $80.00 instead of $72.00",
  "- every other line is right",
  "",
  "Next: change the comparison to `>=` and run the whole suite.",
].join("\n");
export const ANSWER = "Fixed: 10 units now get the bulk discount, and the suite passes (11 tests).";

export function detailTurn(id = "t1", { end = true } = {}) {
  const frames = [
    { type: "turn_start", turn_id: id, prompt: "a test fails; find out why and fix it", kind: "prompt" },
    { type: "text_delta", text: "I'll run the suite and read the failing test first." },
    { type: "stream_end", message_id: `${id}:1`, phase: "commentary" },
    { type: "tool_call", call_id: `${id}c1`, name: "bash", args: { command: "python -m unittest" }, summary: "python -m unittest" },
    { type: "tool_result", call_id: `${id}c1`, name: "bash", output: "FAILED (failures=1)", is_error: false },
    { type: "text_delta", text: DIAGNOSIS },
    { type: "stream_end", message_id: `${id}:2`, phase: "commentary" },
    { type: "tool_call", call_id: `${id}c2`, name: "edit_file", args: { path: "shopkit/catalog.py" }, summary: "shopkit/catalog.py" },
    { type: "tool_result", call_id: `${id}c2`, name: "edit_file", output: "edited", is_error: false },
    { type: "text_delta", text: ONE_LINE },
    { type: "stream_end", message_id: `${id}:3`, phase: "commentary" },
    { type: "tool_call", call_id: `${id}c3`, name: "bash", args: { command: "python -m unittest" }, summary: "python -m unittest" },
    { type: "tool_result", call_id: `${id}c3`, name: "bash", output: "OK", is_error: false },
  ];
  if (end) frames.push(
    { type: "text_delta", text: ANSWER },
    { type: "stream_end", message_id: `${id}:4`, phase: "answer" },
    { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 10, final_message_id: `${id}:4` });
  return frames;
}
