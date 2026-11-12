// A Work chat left open and idle past its prompt cache's window (0.52): your prompt, a long last reply, and the one
// quiet line at its end, "Idle 1d 17h. The prompt cache has likely expired, so your next message will re-cache about
// 524k tokens." Shared by cache-clock-layout.test.mjs and render-idle-cache.mjs. Not a *.test.mjs file.
import { THEMES, panelHtml } from "./options-scene.mjs";

export const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
export const IDLE_LINE = "Idle 1d 17h. The prompt cache has likely expired, so your next message will re-cache about 524k tokens.";
const PARAGRAPH = "The upload limit now lives in settings, so each plan can carry its own. The default stays at 20 a minute, the tests cover a plan with no limit of its own, and the changelog has a line for it.";
export const REPLY = Array.from({ length: 9 }, (_, k) => (k === 3 ? "- `src/settings.py`: the new `UPLOAD_LIMIT` table\n- `src/upload.py`: reads the plan's limit\n- `tests/test_upload.py`: three new cases" : PARAGRAPH)).join("\n\n");

/** The Work panel at `width`, a finished turn with a long reply in it, and (idle: true) the chat left idle past its
 *  cache window. `event` sends a backend event; `advance(ms)` moves the page's wall clock. */
export async function openIdle(browser, { width = 700, height = 760, theme = "dark-modern", idle = true } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate(([t, mjs, mdjs, now]) => {
    document.body.classList.add(t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark");
    window.__wall = now; Date.now = () => window.__wall;
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [theme, mainJs, markdownJs, NOW]);
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const event = async (ev) => { await page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: d } })), ev); };
  const advance = (ms) => page.evaluate((d) => { window.__wall += d; }, ms);
  const shown = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await event({ type: "ready", capabilities: {} });
  await event({ type: "config", model: "claude-sonnet-4-5", mode: "default", think: "off", base_url: "https://api.anthropic.com/v1", api_mode: "auto", prompt_cache: true, project_root: "/p", goal: {} });
  await event({ type: "session", kind: "new", session_id: "s1" });
  await event({ type: "turn_start", turn_id: "t1", prompt: "Move the upload limit into settings so each plan can have its own." });
  await event({ type: "text_delta", text: REPLY });
  await event({ type: "stream_end", message_id: "t1:1", phase: "final_answer" });
  await event({ type: "cache_clock", state: "warm", source: "anthropic", anchor_ms: NOW - 20000, expires_ms: NOW + 280000, ttl_s: 300, tokens: 524000, session_id: "s1" });
  await event({ type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: "t1:1", elapsed_seconds: 20 });
  await settle();
  if (idle) {
    // Left for a day and seventeen hours: the window comes back and finds the cache cold.
    await advance(41 * 3600000);
    await shown();
    await settle();
  }
  return { page, errors, event, advance, shown, settle, close: () => page.close() };
}
