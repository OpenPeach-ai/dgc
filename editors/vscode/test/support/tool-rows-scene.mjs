// The founder's turn for the one-line tool rows tests (tool-rows-one-line*.test.mjs): a sentence, six
// times (think, run a command), then the answer -- what a real deepseek turn drew as twelve rows.
export const COMMANDS = ["python -m erp.gst.export --date yesterday", "grep -n \"cess\" erp/gst/totals.py",
  "pytest tests/gst/test_totals.py -q", "git log --oneline -5 -- erp/gst", "python scripts/compare_tally.py",
  "pytest tests/gst -q"];
export const SECONDS = [2, 1, 3, 1, 2, 4];
export const THOUGHTS = ["Start with the export for yesterday.", "The export drops a column. Look at the totals.",
  "Line 88 leaves cess out of the total. Check whether the tests cover a mixed-rate invoice at all.",
  "When did the split change?", "Compare with Tally's numbers.", "Run the whole GST suite once more."];

// `id` prefixes the turn's ids, so a replay can carry h-prefixed ones.
export function founderTurn(id = "t1", { answer = true } = {}) {
  const frames = [
    { type: "turn_start", turn_id: id, prompt: "The GST export doesn't match Tally for yesterday. Find out why.", kind: "prompt" },
    { type: "text_delta", text: "I'll check the GST export against Tally one step at a time before I touch any code." },
    { type: "stream_end", message_id: `${id}:1`, phase: "commentary" },
  ];
  COMMANDS.forEach((command, i) => frames.push(
    { type: "thinking_delta", block: `${id}:think${i + 1}`, source: "raw", text: THOUGHTS[i] },
    { type: "thinking_end", block: `${id}:think${i + 1}`, source: "raw", placement: "collapsed", seconds: SECONDS[i] },
    { type: "tool_call", call_id: `c${i + 1}`, name: "bash", args: { command }, summary: command },
    { type: "tool_result", call_id: `c${i + 1}`, name: "bash", output: `out ${i + 1}`, is_error: false }));
  if (answer) frames.push(
    { type: "text_delta", text: "Found it: `erp/gst/totals.py:88` adds CGST, SGST and IGST but not cess." },
    { type: "stream_end", message_id: `${id}:2`, phase: "answer" },
    { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 10, final_message_id: `${id}:2` });
  return frames;
}
