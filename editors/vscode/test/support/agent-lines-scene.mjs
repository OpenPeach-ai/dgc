// The real panel in Chromium with sub-agent lines on screen: what agent-lines-layout.test.mjs
// measures and what `node test/render-agents.mjs --transcript <dir>` captures. Not a *.test.mjs file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { THEMES as THINKING_THEMES } from "../render-thinking.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

// Dark Modern, Light Modern and High Contrast as render-thinking.mjs has them, and Light+ as VS Code
// injects it (settings-contrast.test.mjs reads the same values: its descriptionForeground is 4.4:1).
export const THEMES = {
  ...THINKING_THEMES,
  "light-plus": `--vscode-sideBar-background:#F3F3F3; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF;
    --vscode-panel-border:#E5E5E5; --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
    --vscode-foreground:#616161; --vscode-editor-foreground:#000000; --vscode-descriptionForeground:#717171;
    --vscode-disabledForeground:rgba(97,97,97,.5); --vscode-list-activeSelectionBackground:#E4E6F1; --vscode-focusBorder:#0090F1;`,
};
export const BODY_CLASS = { "dark-modern": "vscode-dark", "light-modern": "vscode-light", "light-plus": "vscode-light", hc: "vscode-high-contrast" };

export const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
export const LONG_NAME = "Audit every settings surface for keyboard reachability, contrast in all four themes and what the "
  + "screen reader announces";   // 120 characters

const call = (id, name, args = {}, summary = "") => ({ type: "tool_call", call_id: id, name, args, summary });
const result = (id, name, output = "ok") => ({ type: "tool_result", call_id: id, name, output, is_error: false, is_diff: false });
const say = (text, id, phase = "commentary") => [{ type: "text_delta", text }, { type: "stream_end", message_id: id, phase }];
const record = (n, description, state, extra = {}) => ({ id: sid(n), parent_id: null, call_id: `call_${n}`, description, depth: 1,
  state, tool_calls: 3, duration_ms: 42000, isolated: true, parallel: true, started_at: n, ...extra });

// Five batches in one finished turn, each its own step: a single agent; three mid-flight; a waiting and
// a failed member; six (four on one line, two on the next); one with a 120-character name. Drawn
// from a history and an agents snapshot, so every word is the record's own and no window is open.
const BATCHES = [
  [[1, "Count the lines in README.md", "running"]],
  [[2, "Durable rules review", "running"], [3, "Remote web", "finished"], [4, "Paper pip concept", "running"]],
  [[5, "Check the migrations", "waiting", { waiting_for: "permission" }],
    [6, "Port the docs", "failed", { message: "the sub-agent stopped without a final summary" }]],
  [[7, "Survey the parser", "running"], [8, "Survey the lexer", "running"], [9, "Survey the printer", "queued"],
    [10, "Survey the tests", "queued"], [11, "Survey the docs", "finished"], [12, "Survey the CLI", "running"]],
  [[13, LONG_NAME, "running"]],
];
export const LINES_EXPECTED = [
  "Count the lines in README.md running",
  "Durable rules review running · Remote web finished · Paper pip concept running",
  "Check the migrations waiting for your permission · Port the docs failed",
  "Survey the parser, Survey the lexer and 2 more · 2 running · 2 queued",
  "Survey the docs finished · Survey the CLI running",
  `${LONG_NAME} running`,
];
export function linesScene() {
  const items = [{ type: "turn_start", turn_id: "h1", prompt: "Split the review of the settings work", kind: "prompt" }];
  BATCHES.forEach((batch, i) => {
    items.push(...say(["Starting with one.", "Now three at once.", "Two that need care.", "Six surveys.", "And a long one."][i], `h1:${i + 1}`));
    for (const [n, description] of batch) items.push(call(`call_${n}`, "task", { description }));
    for (const [n] of batch) items.push(result(`call_${n}`, "task", "Sub-task started."));
  });
  items.push(...say("All of it is under way.", "h1:9", "answer"),
    { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:9" });
  const records = BATCHES.flat().map(([n, description, state, extra]) => record(n, description, state, extra));
  return [{ type: "history", items, complete: true },
    { type: "agents", items: records, total: records.length, active: records.filter((r) => ["running", "queued", "waiting"].includes(r.state)).length }];
}

let assets;
function loadAssets() {
  if (assets) return assets;
  const panelSrc = readFileSync(join(root, "src/panel.ts"), "utf8");
  const css = readFileSync(join(root, "media/main.css"), "utf8");
  const mainJs = readFileSync(join(root, "media/main.js"), "utf8");
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const codicon = readFileSync(join(root, "media/codicon.css"), "utf8")
    .replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${readFileSync(join(root, "media/codicon.ttf")).toString("base64")}")`);
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
    .find((candidate) => candidate.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  assets = { html: skeleton.replace("</head>", `<style>${codicon}</style><style>${css}</style></head>`), mainJs, markdownJs };
  return assets;
}

// The faces are the shipped SVGs, served from a made-up origin the page is told about.
const MARKS = "https://agent-marks.test";
export async function openAgentLines(browser, { width = 460, height = 900, theme = "dark-modern", events = [],
  forcedColors = false, reducedMotion = false, deviceScaleFactor = 1 } = {}) {
  const { html, mainJs, markdownJs } = loadAssets();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor });
  await page.route(`${MARKS}/**`, (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    if (!/^agent-0[1-8]-[a-z]+\.svg$/.test(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: readFileSync(join(root, "media/agents", file)) });
  });
  if (forcedColors || reducedMotion) {
    await page.emulateMedia({ ...(forcedColors ? { forcedColors: "active" } : {}), ...(reducedMotion ? { reducedMotion: "reduce" } : {}) });
  }
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme] || ""} }` });
  await page.evaluate(([cls, marks]) => { document.body.classList.add(cls); document.body.dataset.agentMarks = marks; },
    [BODY_CLASS[theme] || "vscode-dark", MARKS]);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    window.__post = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
    window.__event = (event) => window.__post({ type: "event", event });
    window.__post({ type: "session_ready", sessionId: "s1" });
    window.__event({ type: "ready", version: "0.47.0", protocol_version: 14, capabilities: { agents: true, history_snapshot: true },
      model: "qwen3.8:27b", mode: "auto", think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true,
      commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
  }, [mainJs, markdownJs]);
  await sendEvents(page, events);
  await settle(page);
  return page;
}
// Delivered one at a time with a tick between, the way a stream arrives.
export function sendEvents(page, events) {
  return page.evaluate(async (list) => {
    for (const event of list) {
      if (event && event.host) window.__post(event.host); else window.__event(event);
      await new Promise((done) => setTimeout(done, 2));
    }
  }, events);
}
export function settle(page) {
  return page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 150)))));
}

// Contrast of an element's text against the first opaque background behind it, in the page (the
// way settings-contrast.test.mjs reads it).
export const CONTRAST_SOURCE = `(node) => {
  const rgba = (value) => { const m = value.match(/[\\d.]+/g).map(Number); return [m[0], m[1], m[2], m[3] ?? 1]; };
  const lum = ([r, g, b]) => { const c = [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  let ground = [255, 255, 255, 1];
  for (let el = node; el; el = el.parentElement) { const bg = rgba(getComputedStyle(el).backgroundColor); if (bg[3] > 0.99) { ground = bg; break; } }
  const fg = rgba(getComputedStyle(node).color);
  const mixed = [0, 1, 2].map((i) => fg[i] * fg[3] + ground[i] * (1 - fg[3]));
  const a = lum(mixed), b = lum(ground);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}`;
