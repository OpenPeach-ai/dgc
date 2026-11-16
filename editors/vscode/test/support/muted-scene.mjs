// The three places DGC's quiet text shows, each with its quiet things on screen, for the muted grey's tests and
// pictures: a Work session after one turn and into the next (steps, "Worked for", the time and Trace, a system line,
// the prompt box with its placeholder, the model and its think level, the footer), a ChatDGC chat, and a Pip's chat.
// Built on the 0.52 look's scenes. Not a *.test.mjs file.
import { openRunningTurn, openChatDgc as chatDgc, openPips as pips, READY } from "./dgc-look-scene.mjs";

export async function openWork(browser, { width = 700, height = 900, theme = "dark-modern" } = {}) {
  const x = await openRunningTurn(browser, { width, height, theme, queue: false });
  const event = x.event;
  await event({ ...READY, think: "high" });
  await event({ type: "tool_result", call_id: "c2", name: "bash", output: "3 passed in 0.41s", is_error: false, is_diff: false, diff: "" });
  await event({ type: "text_delta", text: "Done. The limit is a setting now: `UPLOAD_LIMIT`, 20 unless a plan says otherwise." }); await event({ type: "stream_end", message_id: "t1:2", phase: "final" });
  await event({ type: "turn_end", turn_id: "t1", reason: "done", final_message_id: "t1:2", elapsed_seconds: 42 });
  await event({ type: "info", message: "Context automatically compacted" });
  await x.page.fill("#input", "Now add a test for a plan with its own limit."); await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(60);
  const id = String((await x.posted("prompt")).pop()?.requestId || "");
  await event({ type: "prompt_accepted", request_id: id, state: "started" }); await event({ type: "turn_start", turn_id: "t2", prompt: "" });
  await event({ type: "tool_call", call_id: "d1", name: "read_file", args: { path: "tests/test_upload.py" }, summary: "tests/test_upload.py" });
  await event({ type: "tool_result", call_id: "d1", name: "read_file", output: "def test_default(): ...", is_error: false, is_diff: false, diff: "" });
  await event({ type: "tool_call", call_id: "d2", name: "bash", args: { command: "pytest -q" }, summary: "pytest -q" });
  await x.page.waitForTimeout(200);
  return x;
}
export const openChatDgc = (browser, { width = 700, height = 900, theme = "dark-modern" } = {}) => chatDgc(browser, { width, height, theme });
/** (A Pip's chat has the two default themes.) */
export const openPips = async (browser, { width = 700, height = 900, theme = "dark-modern" } = {}) => {
  if (theme === "hc") return null;
  const x = await pips(browser, { width, height, theme: theme.startsWith("dark") ? "dark" : "light" });
  await x.p.waitForTimeout(900);          // (a reply's quiet line fades in: measured once it is there)
  return { ...x, page: x.p };
};
