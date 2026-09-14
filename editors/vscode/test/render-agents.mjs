// Renders the agents pill and its dialog in real Chromium for review. A developer tool, not part of
// `npm test` (the contract lives in agents-indicator.test.mjs and agents-pill.test.mjs).
//
//   node test/render-agents.mjs /tmp/pill.png [--width=460] [--light] [--narrow] [--menu] [--auto]
//                                             [--waiting] [--idle] [--forced]
//   node test/render-agents.mjs --all <dir>      every capture the review asks for, into <dir>
//
// --narrow is 300px. --menu opens the dialog (a nested child, ended rows, "+N more", the Stop note).
// --auto puts the composer in auto mode (the olive border) to check the green against it.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
const css = readFileSync(here + "/../media/main.css", "utf8");
const mainJs = readFileSync(here + "/../media/main.js", "utf8");
const markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
  format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
  .find((c) => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
const codicon = readFileSync(here + "/../media/codicon.css", "utf8")
  .replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${readFileSync(here + "/../media/codicon.ttf").toString("base64")}")`);
const html = skeleton.replace("</head>", `<style>${codicon}</style><style>${css}</style></head>`);
const LIGHT = `--vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF;
  --vscode-panel-border:#E5E5E5; --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
  --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#1F1F1F; --vscode-descriptionForeground:#616161;
  --vscode-disabledForeground:#6E6E6E; --vscode-list-activeSelectionBackground:#E8E8E8; --vscode-focusBorder:#005FB8;`;

async function capture(browser, out, options) {
  const width = options.width || (options.narrow ? 300 : 460);
  const height = options.menu ? 620 : 420;
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  if (options.forced) await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; }
    body { background: var(--bg); color: var(--text); }` });
  if (options.light) {
    await page.addStyleTag({ content: `:root { ${LIGHT} }` });
    await page.evaluate(() => document.body.classList.add("vscode-light"));
  } else {
    await page.evaluate(() => document.body.classList.add("vscode-dark"));
  }
  await page.evaluate(([mjs, mdjs, opts]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    const post = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
    const event = (data) => post({ type: "event", event: data });
    const mode = opts.auto ? "auto" : "default";
    post({ type: "session_ready", sessionId: "s1" });
    event({ type: "ready", version: "0.40.0", protocol_version: 14, capabilities: { live_steering: true, agents: true },
      model: "qwen3.8:27b", mode, think: "high", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true,
      commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
    post({ type: "state", state: { model: "qwen3.8:27b", mode, think: "high" } });
    event({ type: "turn_start", turn_id: "t1", prompt: "Review the auth module, check the tests and port the docs" });
    const tasks = [
      ["call_0", "review auth module", "reviewer"], ["call_1", "write migration", ""], ["call_2", "port docs", ""],
    ];
    for (const [callId, description] of tasks) {
      event({ type: "tool_call", call_id: callId, name: "task", args: { description }, summary: description });
    }
    const id = (n) => `sub-${String(n).padStart(12, "0")}`;
    if (opts.menu) {
      // A reopened chat's earlier agents (only the newest are itemised), then this turn's.
      const ended = Array.from({ length: 3 }, (_, i) => ({ id: id(90 + i), parent_id: null, call_id: `old_${i}`,
        description: `earlier task ${i + 1}`, depth: 1, state: "finished", tool_calls: 4, isolated: false,
        parallel: false, restored: true }));
      event({ type: "agents", request_id: "agents-restore-1", items: ended, total: 6, active: 0 });
    }
    event({ type: "agent_started", id: id(1), parent_id: null, call_id: "call_0", description: "review auth module",
      agent_type: "reviewer", depth: 1, state: "running", started_at: 1, isolated: true, parallel: true });
    event({ type: "agent_started", id: id(2), parent_id: null, call_id: "call_1", description: "write migration",
      depth: 1, state: "running", started_at: 2, isolated: true, parallel: true });
    event({ type: "agent_started", id: id(3), parent_id: null, call_id: "call_2", description: "port docs",
      depth: 1, state: "running", started_at: 3, isolated: true, parallel: true });
    event({ type: "agent_updated", id: id(1), state: "running", model: "qwen3.8:27b-q4km", tool_calls: 14, tokens: 18200 });
    if (opts.menu) {
      event({ type: "agent_started", id: id(4), parent_id: id(1), call_id: `${id(1)}:c1`, description: "check the tests",
        depth: 2, state: "running", started_at: 4, isolated: false, parallel: false });
      event({ type: "agent_updated", id: id(4), state: "waiting", waiting_for: "permission", tool_calls: 3 });
      event({ type: "agent_updated", id: id(4), state: "running" });
      event({ type: "agent_ended", id: id(3), state: "failed", duration_ms: 31000, tool_calls: 5,
        message: "the sub-agent stopped without a final summary" });
      event({ type: "agent_ended", id: id(2), state: "finished", duration_ms: 48000, tool_calls: 9, tokens: 6400 });
    }
    if (opts.waiting) event({ type: "agent_updated", id: id(2), state: "waiting", waiting_for: "permission" });
    if (opts.idle) for (const n of [1, 2, 3]) event({ type: "agent_ended", id: id(n), state: "finished", duration_ms: 20000 + n * 1000, tool_calls: n });
    if (!opts.idle) {
      const input = document.getElementById("input");
      input.value = "then update the changelog";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
    }
    // An old performance.now baseline so the elapsed times read like a real batch.
    const base = performance.now();
    performance.now = () => base + 72000;
  }, [mainJs, markdownJs, options]);
  await page.waitForTimeout(150);
  if (options.menu) {
    await page.click("#agents-pill");
    await page.waitForTimeout(120);
  }
  const facts = await page.evaluate(() => {
    const pill = document.getElementById("agents-pill"), footer = document.getElementById("cfooter");
    const menu = document.getElementById("agentsmenu").getBoundingClientRect();
    return { state: pill.dataset.state, aria: pill.getAttribute("aria-label"), text: pill.innerText.trim(),
      overflow: footer.scrollWidth - footer.clientWidth, menu: document.getElementById("agentsmenu").hidden ? null
        : { left: Math.round(menu.left), right: Math.round(menu.right), inner: window.innerWidth } };
  });
  await page.screenshot({ path: out, fullPage: false });
  await page.close();
  console.log(out, JSON.stringify(facts));
}

const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
try {
  const allAt = process.argv.indexOf("--all");
  if (allAt >= 0) {
    const dir = process.argv[allAt + 1];
    mkdirSync(dir, { recursive: true });
    const set = {
      "pill-running-dark-300.png": { width: 300 },
      "pill-running-light-300.png": { width: 300, light: true },
      "pill-waiting-dark-360.png": { width: 360, waiting: true },
      "pill-idle-light-460.png": { width: 460, light: true, idle: true },
      "dialog-dark-300.png": { width: 300, menu: true },
      "dialog-light-460.png": { width: 460, light: true, menu: true },
      "pill-auto-olive-dark-460.png": { width: 460, auto: true },
      "pill-forced-colors-300.png": { width: 300, forced: true, waiting: true },
      "pill-running-dark-900.png": { width: 900 },
      "pill-waiting-light-900.png": { width: 900, light: true, waiting: true },
      "dialog-dark-900.png": { width: 900, menu: true },
      "pill-idle-dark-300.png": { width: 300, idle: true },
    };
    for (const [name, options] of Object.entries(set)) await capture(browser, join(dir, name), options);
  } else {
    const flag = (name) => process.argv.includes(`--${name}`);
    const width = Number((process.argv.find((a) => a.startsWith("--width=")) || "").slice(8)) || 0;
    await capture(browser, process.argv[2] || "/tmp/agents.png", { width, light: flag("light"), narrow: flag("narrow"),
      menu: flag("menu"), auto: flag("auto"), waiting: flag("waiting"), idle: flag("idle"), forced: flag("forced") });
  }
} finally {
  await browser.close();
}
