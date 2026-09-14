// A real-Chromium page of the shipped panel showing model reconnect lines and the model error row,
// shared by test/reconnect-line.test.mjs (the layout and contrast contract) and
// test/render-reconnect.mjs (the screenshots). Not a *.test.mjs file.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = here + "/../..";

export const HOST = "127.0.0.1:11434";

// VS Code's own theme tokens for the themes a panel is judged in. "dark" is Dark Modern (with its
// translucent disabledForeground); "hc" also runs with forced colours emulated.
export const THEMES = {
  dark: `--vscode-sideBar-background:#181818; --vscode-editor-background:#1F1F1F; --vscode-input-background:#313131;
    --vscode-panel-border:#2B2B2B; --vscode-widget-border:#313131; --vscode-input-border:#3C3C3C;
    --vscode-foreground:#CCCCCC; --vscode-editor-foreground:#CCCCCC; --vscode-descriptionForeground:#9D9D9D;
    --vscode-disabledForeground:rgba(204,204,204,.5); --vscode-list-activeSelectionBackground:#04395E;
    --vscode-focusBorder:#0078D4; --vscode-textCodeBlock-background:#2B2B2B;`,
  light: `--vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF;
    --vscode-panel-border:#E5E5E5; --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
    --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#1F1F1F; --vscode-descriptionForeground:#616161;
    --vscode-disabledForeground:#6E6E6E; --vscode-list-activeSelectionBackground:#E8E8E8; --vscode-focusBorder:#005FB8;
    --vscode-textCodeBlock-background:#F2F2F2;`,
  "light-modern": `--vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF;
    --vscode-panel-border:#E5E5E5; --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
    --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#3B3B3B; --vscode-descriptionForeground:#3B3B3B;
    --vscode-disabledForeground:rgba(97,97,97,.5); --vscode-list-activeSelectionBackground:#E8E8E8;
    --vscode-focusBorder:#005FB8; --vscode-textCodeBlock-background:#F2F2F2;`,
  hc: `--vscode-sideBar-background:#000000; --vscode-editor-background:#000000; --vscode-input-background:#000000;
    --vscode-panel-border:#6FC3DF; --vscode-widget-border:#6FC3DF; --vscode-input-border:#6FC3DF;
    --vscode-foreground:#FFFFFF; --vscode-editor-foreground:#FFFFFF; --vscode-descriptionForeground:#FFFFFF;
    --vscode-disabledForeground:#A5A5A5; --vscode-list-activeSelectionBackground:#000000; --vscode-focusBorder:#F38518;`,
};

let assets;
function load() {
  if (assets) return assets;
  const panelSrc = readFileSync(root + "/src/panel.ts", "utf8");
  const css = readFileSync(root + "/media/main.css", "utf8");
  const mainJs = readFileSync(root + "/media/main.js", "utf8");
  const markdownJs = buildSync({ entryPoints: [root + "/src/markdown.ts"], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
    .find((c) => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  const codicon = readFileSync(root + "/media/codicon.css", "utf8")
    .replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${readFileSync(root + "/media/codicon.ttf").toString("base64")}")`);
  assets = { mainJs, markdownJs, html: skeleton.replace("</head>", `<style>${codicon}</style><style>${css}</style></head>`) };
  return assets;
}

export async function openPanel(browser, { width = 460, height = 1400, theme = "dark" } = {}) {
  const { html, mainJs, markdownJs } = load();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  if (theme === "hc") await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
  else await page.emulateMedia({ colorScheme: theme.startsWith("light") ? "light" : "dark" });
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif;
    --vscode-editor-font-family: ui-monospace, monospace; --vscode-font-size: 13px; ${THEMES[theme] || ""} }
    body { background: var(--bg); color: var(--text); }` });
  await page.evaluate((t) => document.body.classList.add(
    t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posts = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posts.push(m); }, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const panel = {
    page,
    events: (list) => page.evaluate(async (items) => {
      for (const event of items) {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } }));
        await new Promise((done) => setTimeout(done, 2));
      }
    }, list),
    settle: () => page.evaluate(() => new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 80))))),
  };
  await panel.events([{ type: "ready", capabilities: { model_retry: true }, model: "qwen3-coder:30b", mode: "default",
    think: "off", base_url: `http://${HOST}/v1`, commands: [], custom_commands: [],
    goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" }]);
  return panel;
}

const DETAIL = `HTTPConnectionPool(host='127.0.0.1', port=11434): Max retries exceeded with url: /v1/chat/completions (Caused by NewConnectionError("HTTPConnection(host='127.0.0.1', port=11434): Failed to establish a new connection: [Errno 111] Connection refused"))`;
const HINT = "the endpoint http://127.0.0.1:11434/v1 is not answering — start your server (ollama serve / llama-server / LM Studio) or fix the URL; `dgc doctor` checks both";

export const retry = (fields) => ({ type: "model_retry", state: "retrying", kind: "connect", layer: "request",
  attempt: 1, max_attempts: 3, summary: `connection refused by ${HOST}`, endpoint: `http://${HOST}/v1/chat/completions`,
  model: "qwen3-coder:30b", api_mode: "chat_completions", detail: DETAIL, hint: HINT, delay_ms: 500,
  origin: "agent", turn_id: "t1", ...fields });

const tool = (id, command) => [
  { type: "tool_call", call_id: id, name: "bash", args: { command }, summary: command },
  { type: "tool_result", call_id: id, name: "bash", output: "exit code: 0\nok", is_error: false, is_diff: false, diff: "" },
];

// A running turn with every line state a reader meets: a reconnect that recovered between two tool
// rounds (splitting the tool group), a line still reconnecting, the longest label a sub-agent can
// show, and a stream cut under its partial answer.
export async function liveScene(panel) {
  await panel.events([
    { type: "turn_start", turn_id: "t1", prompt: "Run the test suite and fix what fails", kind: "prompt" },
    { type: "text_delta", text: "Running the suite first." },
    { type: "stream_end", message_id: "t1:1", phase: "commentary" },
    ...tool("c1", "pytest -q"),
    retry({ retry_id: "t1:retry1" }),
    retry({ retry_id: "t1:retry1", attempt: 2, delay_ms: 1000 }),
    retry({ retry_id: "t1:retry1", state: "recovered", attempt: 2 }),
    ...tool("c2", "pytest -q tests/test_api.py"),
    retry({ retry_id: "t1:sub-0123456789ab:retry1", kind: "overloaded", http_status: 503, attempt: 10, max_attempts: 10,
            summary: `HTTP 503 from ${HOST}`, detail: "HTTP 503 Service Unavailable · server busy, maximum pending requests exceeded",
            hint: "the server failed on its side — check its logs; `dgc doctor` shows what it offers",
            origin: "subagent", agent: "sub-0123456789ab", delay_ms: 1500 }),
    { type: "text_delta", text: "The failing test expects a 404 for a missing user, and the handler" },
    { type: "stream_end", message_id: "t1:2", phase: "commentary" },
    retry({ retry_id: "t1:retry2", kind: "stream_cut", layer: "continuation", attempt: 1, max_attempts: 8,
            summary: `stream from ${HOST} ended before [DONE]`, detail: "stream closed before its terminal event ([DONE])",
            delay_ms: 250 }),
    retry({ retry_id: "t1:retry3", attempt: 2 }),
    { type: "turn_activity", turn_id: "t1", state: "waiting", label: "Waiting to reconnect",
      detail: `connection refused · ${HOST} · backoff 1s · retry 2/3` },
  ]);
  await panel.settle();
}

export async function errorScene(panel) {
  await panel.events([
    { type: "turn_start", turn_id: "t1", prompt: "hello", kind: "prompt" },
    retry({ retry_id: "t1:retry1" }),
    retry({ retry_id: "t1:retry1", attempt: 2 }),
    retry({ retry_id: "t1:retry1", attempt: 3 }),
    retry({ retry_id: "t1:retry1", state: "gave_up", attempt: 3 }),
    { type: "error", message: `cannot connect to http://${HOST}/v1 — is your local LLM server running? (/connect <url> to change it)\n${DETAIL}\n  → ${HINT}`,
      cause: { kind: "connect", summary: `connection refused by ${HOST}`, endpoint: `http://${HOST}/v1`, model: "qwen3-coder:30b",
               api_mode: "chat_completions", attempts: 4, retry_id: "t1:retry1", detail: DETAIL, hint: HINT } },
    { type: "turn_end", turn_id: "t1", reason: "error", final_message_id: null },
  ]);
  await panel.settle();
}

export async function replayScene(panel) {
  await panel.events([{ type: "history", todos: [], items: [
    { type: "turn_start", turn_id: "h1", prompt: "Write the migration", kind: "prompt" },
    { type: "text_delta", text: "Here is the first half of the migration: it adds the `status` column" },
    { type: "stream_end", message_id: "h1:1", phase: "commentary" },
    { type: "model_retry", retry_id: "h1:retry1", state: "recovered", kind: "stream_cut", layer: "continuation", attempt: 1,
      max_attempts: 8, summary: `stream from ${HOST} ended before [DONE]`, endpoint: HOST, turn_id: "h1" },
    { type: "text_delta", text: " and backfills it from the audit table." },
    { type: "stream_end", message_id: "h1:2", phase: "commentary" },
    { type: "model_retry", retry_id: "h1:retry2", state: "retrying", kind: "stream_cut", layer: "continuation", attempt: 2,
      max_attempts: 8, summary: `stream from ${HOST} ended before [DONE]`, endpoint: HOST, turn_id: "h1" },
    { type: "turn_end", turn_id: "h1", reason: "cancelled", final_message_id: null },
    { type: "turn_start", turn_id: "h2", prompt: "Finish it", kind: "prompt" },
    { type: "text_delta", text: "Partial answer" },
    { type: "stream_end", message_id: "h2:1", phase: "answer" },
    { type: "model_retry", retry_id: "h2:retry1", state: "retrying", kind: "stream_cut", layer: "continuation", attempt: 1,
      max_attempts: 8, summary: "the stream ended before its terminal event", turn_id: "h2" },
    { type: "turn_end", turn_id: "h2", reason: "completed", final_message_id: "h2:1" },
  ] }]);
  await panel.settle();
}

// Layout and contrast facts, measured in the page.
export function measureInPage() {
  const parse = (value) => {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const background = (node) => {
    const layers = [];
    for (let el = node; el; el = el.parentElement) {
      const c = parse(getComputedStyle(el).backgroundColor);
      if (c && c.a > 0) layers.push(c);
      if (c && c.a >= 1) break;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) base = over(layer, base);
    return base;
  };
  const lum = ({ r, g, b }) => {
    const ch = [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; };
  const texts = [];
  for (const line of document.querySelectorAll(".model-retry, .model-error")) {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!node.textContent.trim() || !visible(el) || el.closest("[hidden]")) continue;
      const fg = parse(getComputedStyle(el).color);
      const bg = background(el);
      texts.push({ text: node.textContent.trim().slice(0, 60), ratio: ratio(over(fg, bg), bg),
        row: line.classList.contains("model-error") ? "error" : "retry" });
    }
  }
  const html = document.documentElement;
  return {
    page: { scrollWidth: html.scrollWidth, clientWidth: html.clientWidth,
            logScroll: document.getElementById("log").scrollWidth, logClient: document.getElementById("log").clientWidth },
    toggles: [...document.querySelectorAll(".model-retry-toggle")].map((t) => ({
      scrollWidth: t.scrollWidth, clientWidth: t.clientWidth, height: t.getBoundingClientRect().height,
      label: t.querySelector(".model-retry-label").textContent,
      labelScroll: t.querySelector(".model-retry-label").scrollWidth, labelClient: t.querySelector(".model-retry-label").clientWidth,
      labelRight: t.querySelector(".model-retry-label").getBoundingClientRect().right,
      toggleRight: t.getBoundingClientRect().right,
      causeDisplay: getComputedStyle(t.querySelector(".model-retry-cause")).display })),
    texts,
  };
}
