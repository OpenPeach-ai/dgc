// A turn whose commands carry plain-words labels (bash's optional `description`, in the tool_call's own args): three
// labelled steps, one without a label, and a command waiting on its approval card whose label lies about it. Shared by
// step-labels.test.mjs (jsdom), step-labels-layout.test.mjs (Chromium) and render-step-labels.mjs (the pictures).
// Not a *.test.mjs file.
export const STEPS = [
  { id: "s1", command: "git status --short && git log --oneline -5", label: "Check what changed in the project", output: " M src/upload.py\n3f2a1c9 Raise the upload limit" },
  { id: "s2", command: "PYTHONPATH=. python -m pytest tests/test_upload.py -q --maxfail=1", label: "Run the upload tests", output: "3 passed in 0.41s" },
  { id: "s3", command: "grep -rn \"UPLOAD_LIMIT\" src/ tests/ --include=*.py | head -20", label: "Find every place the upload limit is read, so the change reaches each of them", output: "src/upload.py:12:UPLOAD_LIMIT = 20" },
  { id: "s4", command: "ls -la build", label: "", output: "total 0" },
];
// The label says one thing and the command does another: the approval card goes by the command.
export const MISLEADING = { id: "s5", command: "rm -rf build", label: "List the files" };

export const call = (step, name = "bash") => ({ type: "tool_call", call_id: step.id, name,
  args: step.label ? { command: step.command, description: step.label } : { command: step.command }, summary: step.command });
export const result = (step, name = "bash") => ({ type: "tool_result", call_id: step.id, name, output: step.output || "",
  is_error: false, is_diff: false, diff: "" });
export const ask = (step = MISLEADING) => ({ type: "permission_request", id: `req-${step.id}`, call_id: step.id, name: "bash",
  args: { command: step.command, description: step.label }, command: step.command, summary: step.command,
  suggested_rule: "Bash(rm:*)" });

/** The turn up to the approval card: four finished steps, then the ask. */
export function labelledTurn(id = "t1") {
  return [
    { type: "turn_start", turn_id: id, prompt: "Make the upload limit a setting and clean the build folder.", kind: "prompt" },
    { type: "text_delta", text: "I'll look at what changed, run the tests, then clear the old build." },
    { type: "stream_end", message_id: `${id}:1`, phase: "commentary" },
    ...STEPS.flatMap((step) => [call(step), result(step)]),
    ask(),
  ];
}
/** What a reload replays: the saved turn, finished, the last command run after its approval. */
export function savedTurn(id = "h1") {
  return [
    { type: "turn_start", turn_id: id, prompt: "Make the upload limit a setting and clean the build folder.", kind: "prompt" },
    ...STEPS.flatMap((step) => [call(step), result(step)]),
    call(MISLEADING), result({ ...MISLEADING, output: "" }),
    { type: "text_delta", text: "Done: the limit is a setting now." },
    { type: "stream_end", message_id: `${id}:2`, phase: "answer" },
    { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 10, final_message_id: `${id}:2` },
  ];
}
