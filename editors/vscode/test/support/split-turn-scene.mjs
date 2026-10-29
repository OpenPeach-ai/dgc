// A turn split by a message sent mid-turn, as a reopened chat replays it (reported 28 Oct: an hour-long turn with a
// message sent 18 minutes in read "Worked for 3837s", then the message, then the answer). Saved turns carry their
// times as {role: "time"} history markers, seconds since 1970, as the session file keeps them.
export const SENT = 1_760_715_000;
export const READY = { type: "ready", capabilities: { history_snapshot: true }, model: "m", mode: "auto", think: "off",
  base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [],
  goal: { text: "", status: "none" }, context_size: 1 };
export const splitTurn = ({ steeredAt = SENT + 1092, timed = true } = {}) => [
  { type: "turn_start", turn_id: "h1", prompt: "why are the bags locked?", kind: "prompt" },
  { role: "time", of: "prompt", at: SENT },
  { type: "text_delta", text: "I'll check the dispatch payload." }, { type: "stream_end", message_id: "h1:1", phase: "commentary" },
  { type: "tool_call", call_id: "c1", name: "read_file", args: { path: "dispatch.py" }, summary: "dispatch.py" },
  { type: "tool_result", call_id: "c1", name: "read_file", output: "x = 1", is_error: false },
  ...(timed ? [{ role: "time", of: "steering", at: steeredAt }] : []),
  { role: "steering", text: "also: the order-entry clerk can't add a customer" },
  { type: "text_delta", text: "Now the staff gates." }, { type: "stream_end", message_id: "h1:2", phase: "commentary" },
  { type: "tool_call", call_id: "c2", name: "bash", args: { command: "pytest" }, summary: "pytest" },
  { type: "tool_result", call_id: "c2", name: "bash", output: "ok", is_error: false },
  { type: "text_delta", text: "Both are fixed." }, { type: "stream_end", message_id: "h1:3", phase: "answer" },
  { role: "time", of: "reply", at: SENT + 3837 },
  { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 1, final_message_id: "h1:3" }];
