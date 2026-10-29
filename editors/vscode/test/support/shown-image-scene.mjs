// A turn whose show_file step put images (and a report) in front of the user, in real Chromium, with the host's
// picture answers drawn on a canvas so nothing is read from disk. Shared by shown-image-layout.test.mjs and capture
// scripts. setContent only; no port is opened. Not a *.test.mjs file.
import { THEMES, panelHtml } from "./options-scene.mjs";

export const ONE = [{ name: "login.png", rel: "shots/login.png", bytes: 48_213, caption: "The login page after the fix: the error now sits under the password box" }];
export const TWO = [
  { name: "before.png", rel: "shots/before.png", bytes: 40_000, caption: "Before" },
  { name: "after.png", rel: "shots/after.png", bytes: 41_000, caption: "After: the button is back in the row" },
  { name: "report.md", rel: "notes/report.md", bytes: 2_310, caption: "What changed and how it was checked, in full" },
];

export async function openShownImages(browser, { width = 460, height = 820, theme = "dark-modern", items = ONE, scale = 1 } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const post = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const send = (event) => post({ type: "event", event });
  await post({ type: "session_ready", sessionId: "s1" });
  await send({ type: "ready", version: "0.50.0", protocol_version: 14, session_id: "s1", capabilities: { produced_files: true },
    model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true,
    commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1048576 });
  await send({ type: "turn_start", turn_id: "t1", prompt: "Fix the login error and show me the page", kind: "prompt" });
  await send({ type: "tool_call", call_id: "c1", name: "show_file", args: { path: items[0].rel } });
  await send({ type: "tool_result", call_id: "c1", name: "show_file", is_error: false, output: "Showing it to the user as a chip" });
  await send({ type: "files_ready", call_id: "c1", items });
  await send({ type: "text_delta", text: "Fixed: the error message now sits under the password box. The screenshot shows it." });
  await send({ type: "stream_end", message_id: "t1:1", phase: "answer" });
  await send({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:1" });
  // The host's answers: a wide screenshot and a tall one, drawn here so nothing is read from disk.
  await page.evaluate(() => {
    const picture = (w, h, hue) => {
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const g = c.getContext("2d");
      g.fillStyle = `hsl(${hue} 30% 92%)`; g.fillRect(0, 0, w, h);
      g.fillStyle = `hsl(${hue} 40% 40%)`; g.fillRect(w * 0.1, h * 0.12, w * 0.8, h * 0.1);
      g.fillStyle = "#fff"; g.fillRect(w * 0.25, h * 0.35, w * 0.5, h * 0.08); g.fillRect(w * 0.25, h * 0.5, w * 0.5, h * 0.08);
      g.fillStyle = "#c0392b"; g.fillRect(w * 0.25, h * 0.6, w * 0.32, h * 0.03);
      return c.toDataURL("image/png");
    };
    const asks = window.__posted.filter((m) => m.type === "fileThumb");
    asks.forEach((ask, n) => window.dispatchEvent(new MessageEvent("message",
      { data: { type: "fileThumb", requestId: ask.requestId, src: n % 2 ? picture(600, 900, 150) : picture(1280, 800, 210) } })));
  });
  await page.waitForFunction(() => [...document.querySelectorAll(".made-image img")].every((img) => img.complete && img.naturalWidth));
  return { page, errors };
}
