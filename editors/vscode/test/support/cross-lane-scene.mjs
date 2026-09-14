// The real panel in Chromium with all five 0.40 features on screen at once: the agents pill, a
// reconnect line between two tool groups, an inline provider summary, a step with a viewed image,
// and a docked question. Shared by cross-lane.test.mjs (assertions) and ad hoc capture scripts.
// setContent only; no port is opened. Not a *.test.mjs file.
import { QUESTIONS, THEMES, panelHtml } from "./options-scene.mjs";

export { THEMES };
export const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
export const REF = "img_" + "0123456789abcdef".repeat(2);

// scenario "footer": a running turn with two agents, a docked question and the goal, tasks and
// monitors rails. scenario "transcript": the retry line, inline note and image step before the
// docked question (no rails, so the transcript has room).
export async function openCrossLane(browser, { width = 300, height = 620, theme = "dark-modern", scenario = "footer" } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const post = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const send = (event) => post({ type: "event", event });
  await send({ type: "ready", version: "0.40.0", protocol_version: 14,
    capabilities: { live_steering: true, agents: true, image_views: true, model_retry: true },
    model: "qwen3.8-coder-instruct-128k-q8_0-local-gguf-with-a-long-name", mode: "default", think: "off",
    base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true, commands: [], custom_commands: [],
    goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
  if (scenario === "footer") {
    await send({ type: "goal_changed", goal: "Ship settings sync with tests", status: "active", elapsed_seconds: 120, details: {} });
    await send({ type: "monitors", items: [{ id: "mon1", state: "running", description: "dev server", events: 3, command: "npm run dev" }],
      wake_paused: false, pending_events: 0 });
  }
  await send({ type: "turn_start", turn_id: "t1", prompt: "Add settings sync" });
  if (scenario === "footer") {
    await send({ type: "todos", todos: [{ content: "Pick storage", status: "in_progress" }, { content: "Write sync", status: "pending" }] });
  }
  for (const n of [1, 2]) {
    await send({ type: "tool_call", call_id: `call_task_${n}`, name: "task", args: { description: `survey part ${n}` }, summary: `survey part ${n}` });
    await send({ type: "agent_started", id: `sub-00000000000${n}`, parent_id: null, call_id: `call_task_${n}`,
      description: `survey part ${n}`, depth: 1, state: "running", started_at: n, isolated: true, parallel: true, turn_id: "t1" });
  }
  if (scenario === "transcript") {
    await send({ type: "model_retry", retry_id: "t1:retry1", state: "retrying", kind: "connect", layer: "request", attempt: 1,
      max_attempts: 3, summary: "connection refused by 127.0.0.1:11434", endpoint: "http://127.0.0.1:11434/v1", turn_id: "t1",
      model: "qwen3.8:27b", api_mode: "chat_completions", delay_ms: 500 });
    await send({ type: "tool_call", call_id: "call_view", name: "view_image", args: { path: "shot.png" }, summary: "shot.png" });
    await send({ type: "tool_result", call_id: "call_view", name: "view_image", output: "viewed shot.png (image/png, 1×1, 1 KB).",
      is_error: false, is_diff: false, diff: "" });
    await send({ type: "tool_images", call_id: "call_view", images: [PNG], caption: "viewed image",
      items: [{ ref: REF, name: "shot.png", mime: "image/png", width: 1, height: 1, bytes: 70, source: "view_image", host: "" }] });
    await send({ type: "thinking_delta", block: "t1:think1", source: "summarized", provider: "anthropic",
      text: "Checking which storage the settings already use." });
    await send({ type: "thinking_end", block: "t1:think1", source: "summarized", provider: "anthropic", placement: "inline", seconds: 1.2 });
  }
  await send({ type: "tool_call", call_id: "call_q", name: "propose_options", args: {}, summary: "2 questions · Storage, Extras" });
  await send({ type: "options_request", id: "r1", call_id: "call_q", questions: QUESTIONS });
  await page.waitForTimeout(450);          // past the question's arrival guard
  return { page, send, post, errors };
}
