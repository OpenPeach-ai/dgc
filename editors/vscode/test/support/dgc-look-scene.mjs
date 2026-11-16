// A Work session mid-turn, for the 0.52 look's tests and pictures: a sent prompt, a line of commentary, a step that ran,
// a step still running, a command waiting for your okay, and two prompts in the queue. Built on work-tab-scene.mjs.
// Not a *.test.mjs file.
import { readFileSync } from "node:fs";
import { openWorkTab } from "./work-tab-scene.mjs";

const media = (name) => readFileSync(new URL(`../../media/${name}`, import.meta.url), "utf8");
export const READY = { type: "ready", version: "0.52.0", protocol_version: 14, capabilities: { live_steering: true, steer_queued: true }, model: "qwen3.8:27b", mode: "default", think: "off",
  base_url: "http://localhost:11434/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" };

/** approval: also a command waiting for your okay (its card docks over the prompt box). queue: two prompts queued. */
export async function openRunningTurn(browser, { width = 700, height = 760, theme = "dark-modern", approval = false, queue = true } = {}) {
  const x = await openWorkTab(browser, { width, height, theme });
  const event = (e) => x.send({ type: "event", event: e });
  await x.send({ type: "session_ready", sessionId: "s1" }); await event(READY);
  await x.page.addScriptTag({ content: media("messagequeue.js") }); await x.page.addStyleTag({ content: media("messagequeue.css") });
  const say = async (text, alt) => { await x.page.fill("#input", text); await x.page.keyboard.press(alt ? "Alt+Enter" : "Enter"); await x.page.waitForTimeout(60);
    return String((await x.posted("prompt")).pop()?.requestId || ""); };
  const first = await say("Move the upload limit into settings so each plan can have its own, and keep 20 as the default.");
  await event({ type: "prompt_accepted", request_id: first, state: "started" }); await event({ type: "turn_start", turn_id: "t1", prompt: "" });
  await event({ type: "text_delta", text: "The limit lives in `src/upload.py`. I'll read it, then move it into settings." }); await event({ type: "stream_end", message_id: "t1:1", phase: "commentary" });
  await event({ type: "tool_call", call_id: "c1", name: "read_file", args: { path: "src/upload.py" }, summary: "src/upload.py" });
  await event({ type: "tool_result", call_id: "c1", name: "read_file", output: "LIMIT = 20", is_error: false, is_diff: false, diff: "" });
  await event({ type: "tool_call", call_id: "c2", name: "bash", args: { command: "pytest -q tests/test_upload.py" }, summary: "pytest -q tests/test_upload.py" });
  if (queue) for (const [k, text] of ["Also add a note to the changelog", "And run the whole suite at the end"].entries()) {
    const id = await say(text, true); await event({ type: "prompt_accepted", request_id: id, state: "queued" }); await event({ type: "queued", count: k + 1, text: "" }); }
  if (approval) await event({ type: "permission_request", id: "req-1", call_id: "c3", name: "bash", args: { command: "npm publish" }, command: "npm publish", summary: "npm publish", suggested_rule: "Bash(npm publish:*)" });
  await x.page.waitForTimeout(150);
  return { ...x, event };
}

/** ChatDGC with a short conversation: your prompt, an answer with a list and a link, and a second prompt. */
export async function openChatDgc(browser, { width = 700, height = 760, theme = "dark-modern" } = {}) {
  const chat = await import("./chat-scene.mjs"), at = "2026-11-10T09:30:00Z";
  const x = await chat.openChat(browser, { width, height, theme });
  await x.send({ type: "opened", conversation: chat.conversation({ title: "A week in Goa in March" }), earlier: 0, busy: false, messages: [
    { id: chat.M(1), role: "user", text: "Plan a week in Goa in March for two, not too packed.", created_at: at },
    { id: chat.M(2), role: "assistant", text: "Here is a calm week:\n\n- **Days 1 to 3, the north:** Ashwem and Mandrem for quiet beaches; one evening in Assagao for dinner.\n- **Day 4:** the Latin Quarter in Panjim, on foot, with [the heritage walk](https://example.com).\n- **Days 5 to 7, the south:** Palolem and Agonda; a morning boat to Butterfly Beach.\n\nMarch is warm (about 32 °C), so keep the middle of each day free.", created_at: at, finish: "stop", model: "qwen3.8:27b" },
    { id: chat.M(3), role: "user", text: "Where should we stay in the south?", created_at: at }] });
  await x.send({ type: "models", ids: ["qwen3.8:27b", "deepseek-v4.1-flash:cloud"], current: "qwen3.8:27b" });
  await x.page.waitForTimeout(200);
  return x;
}

/** A Pip's chat (test/support/pip-chat-scene.mjs), or with list: true the list of your Pips behind it. `p` is the page. */
export async function openPips(browser, { width = 700, height = 760, theme = "dark", list = false, scale = 1 } = {}) {
  const pips = await import("./pip-chat-scene.mjs");
  const x = await pips.openChat(browser, { width, height, theme, where: width > 400 ? "tab" : "side", scale });
  if (list) { await x.p.locator('button[aria-label="Your Pips"]').first().click({ timeout: 3000 }); await x.p.waitForTimeout(400); }
  return x;
}

/** Settings on its General page, with a config as a running DGC reports one. */
export async function openSettingsGeneral(browser, { width = 900, height = 760, theme = "dark", section = "general" } = {}) {
  const { openSettings } = await import("./mods-scene.mjs");
  const x = await openSettings(browser, { width, height, theme });
  await x.page.evaluate((s) => { window.postMessage({ type: "show", section: s }, "*"); window.postMessage({ type: "event", event: { type: "config", mode: "auto", think: "off", ultra_mode: false, max_parallel_tasks: 4,
    turn_token_budget: 0, context_size: 65536, suggest: true, monitor_wake: true, tool_profile: "standard", base_url: "http://127.0.0.1:11434/v1", model: "qwen3.8:27b" } }, "*"); }, section);
  await x.page.waitForTimeout(200);
  return x;
}
