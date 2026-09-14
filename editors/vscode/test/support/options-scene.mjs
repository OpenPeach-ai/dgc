// The real panel in Chromium with a docked question card: the goal, tasks and monitors rails showing,
// a running turn, and a propose_options request. Shared by options-card-layout.test.mjs (assertions)
// and render-options.mjs (the capture matrix). setContent only; no port is opened.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url)) + "/../..";

export const THEMES = {
  "dark-modern": `--vscode-sideBar-background:#181818; --vscode-editor-background:#1F1F1F; --vscode-input-background:#313131;
    --vscode-panel-border:#2B2B2B; --vscode-widget-border:#313131; --vscode-input-border:#3C3C3C;
    --vscode-foreground:#CCCCCC; --vscode-editor-foreground:#CCCCCC; --vscode-descriptionForeground:#9D9D9D;
    --vscode-disabledForeground:rgba(204,204,204,.5); --vscode-list-activeSelectionBackground:#04395E; --vscode-focusBorder:#0078D4;`,
  "light-modern": `--vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF;
    --vscode-panel-border:#E5E5E5; --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
    --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#3B3B3B; --vscode-descriptionForeground:#3B3B3B;
    --vscode-disabledForeground:rgba(97,97,97,.5); --vscode-list-activeSelectionBackground:#E8E8E8; --vscode-focusBorder:#005FB8;`,
  hc: `--vscode-sideBar-background:#000000; --vscode-editor-background:#000000; --vscode-input-background:#000000;
    --vscode-panel-border:#6FC3DF; --vscode-widget-border:#6FC3DF; --vscode-input-border:#6FC3DF;
    --vscode-foreground:#FFFFFF; --vscode-editor-foreground:#FFFFFF; --vscode-descriptionForeground:#FFFFFF;
    --vscode-disabledForeground:#A5A5A5; --vscode-list-activeSelectionBackground:#000000; --vscode-focusBorder:#F38518;`,
};

export const QUESTIONS = [
  { id: "storage", header: "Storage", question: "Which storage backend should settings sync use?", multi_select: false, options: [
    { label: "SQLite file", description: "One local file with transactions; nothing extra to run.", recommended: true },
    { label: "JSON on disk", description: "Easy to read by hand; no safe concurrent writes.", recommended: false },
    { label: "Postgres table", description: "Reuses the app database; adds a network dependency.", recommended: false }] },
  { id: "extras", header: "Extras", question: "Which extras ship in the first version?", multi_select: true, options: [
    { label: "Conflict prompt", description: "Ask when two machines edited the same key.", recommended: true },
    { label: "Sync history", description: "Keep the last 20 versions of each key.", recommended: false },
    { label: "Export button", description: "Download all settings as one JSON file.", recommended: false }] },
];

let cached;
export function panelHtml() {
  if (cached) return cached;
  const panelSrc = readFileSync(here + "/src/panel.ts", "utf8");
  const css = readFileSync(here + "/media/main.css", "utf8");
  const codicon = readFileSync(here + "/media/codicon.css", "utf8").replace(/url\([^)]*codicon\.ttf[^)]*\)/,
    `url("data:font/ttf;base64,${readFileSync(here + "/media/codicon.ttf").toString("base64")}")`);
  const mainJs = readFileSync(here + "/media/main.js", "utf8");
  const markdownJs = buildSync({ entryPoints: [here + "/src/markdown.ts"], bundle: true, format: "iife",
    globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
    .find((c) => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  cached = { html: skeleton.replace("</head>", `<style>${codicon}</style><style>${css}</style></head>`), mainJs, markdownJs };
  return cached;
}

// Opens a page at width x height in `theme`, runs the scenario, and returns helpers.
// scenario: "docked" (question 1), "multi" (question 2 with checks), "other" (typing free text),
// "short" (docked at a short height), "answered" (resolved rows in the transcript), "rejected".
export async function openScene(browser, { width, height, theme = "dark-modern", scenario = "docked",
  reducedMotion = false, rails = true } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2,
    reducedMotion: reducedMotion ? "reduce" : "no-preference" });
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
  const send = (event) => page.evaluate((e) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: e } })), event);
  await send({ type: "ready", version: "0.40.0", protocol_version: 14, capabilities: { live_steering: true }, model: "qwen3.8:27b",
    mode: "default", think: "off", base_url: "http://localhost:11434/v1", workspace_trusted: true, commands: [],
    custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
  if (rails) {
    await send({ type: "goal_changed", goal: "Ship settings sync with tests", status: "active", elapsed_seconds: 120, details: {} });
    await send({ type: "monitors", items: [{ id: "mon1", state: "running", description: "dev server", events: 3, command: "npm run dev" }],
      wake_paused: false, pending_events: 0 });
  }
  await send({ type: "turn_start", turn_id: "t1", prompt: "Add settings sync" });
  if (rails) {
    await send({ type: "todos", todos: [{ content: "Pick storage", status: "in_progress" }, { content: "Write sync", status: "pending" },
      { content: "Tests", status: "pending" }] });
  }
  await send({ type: "text_delta", text: "Two choices change what I build, so they are yours." });
  await send({ type: "stream_end", message_id: "t1:1", phase: "commentary" });
  await send({ type: "tool_call", call_id: "call_q", name: "propose_options", args: {}, summary: "2 questions · Storage, Extras" });
  if (scenario === "answered") {
    await send({ type: "options_request", id: "r1", call_id: "call_q", questions: QUESTIONS });
    await send({ type: "options_resolved", id: "r1", call_id: "call_q", outcome: "answered", questions: QUESTIONS,
      answers: { storage: { selected: [0], other: "" }, extras: { selected: [0, 2], other: "also a size cap" } } });
    await send({ type: "tool_result", call_id: "call_q", name: "propose_options", output: "The user answered…", is_error: false, is_diff: false, diff: "" });
    await send({ type: "tool_call", call_id: "call_s", name: "propose_options", args: {}, summary: "1 question · Scope" });
    await send({ type: "options_resolved", id: null, call_id: "call_s", outcome: "dismissed",
      questions: [{ ...QUESTIONS[0], id: "scope", question: "Which scope?" }] });
    await send({ type: "tool_result", call_id: "call_s", name: "propose_options", output: "The user closed…", is_error: false, is_diff: false, diff: "" });
    await page.evaluate(() => document.querySelectorAll(".tool.asked-card .tool-toggle")[0].click());
  } else {
    await send({ type: "options_request", id: "r1", call_id: "call_q", questions: QUESTIONS });
  }
  await page.waitForTimeout(450);          // past the arrival guard
  if (scenario === "multi") {
    await page.evaluate(() => {
      const click = (node) => node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      click(document.querySelector('.ask-page[data-step="1"]'));
      const rows = document.querySelectorAll(".ask-opt");
      click(rows[0]); click(rows[2]);
      rows[2].focus();
    });
  }
  if (scenario === "other") {
    await page.focus(".ask-field");
    await page.keyboard.type("Keep it in the workspace settings file, no new database");
  }
  if (scenario === "rejected") {
    await page.evaluate(() => {
      document.querySelectorAll(".ask-opt")[1].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => {              // Skip the second question: the batch is sent
      document.querySelector(".ask-act").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    await send({ type: "command_rejected", command: "options_response", request_id: "r1", reason: "invalid_response",
      message: "DGC could not use that answer. Pick an option, write an answer, skip, or dismiss the question." });
  }
  await page.waitForTimeout(150);
  return { page, send, errors };
}
