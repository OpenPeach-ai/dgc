// The real extension side of the chat -- src/panel.ts bundled against a small stub `vscode` -- driving
// a real `dgc serve` from this checkout through its own DgcBackend, with media/main.js in Chromium as
// the webview. Three kinds of reload are modelled the way VS Code performs them:
//   - webview reload: the page closes and a fresh one opens (it posts webviewReady); the provider,
//     its backend and the webview's saved state (getState/setState) survive;
//   - DGC: Restart Backend: provider.restart();
//   - Developer: Reload Window: the extension host goes away (its backend is killed with it), and a
//     new provider starts over the same workspaceState and the same webview state.
// Needs Chromium (Playwright) and a Python that can import this checkout's dgc (DGC_TEST_PYTHON, else
// the interpreter behind `dgc` on PATH, else python3). Model servers listen on port 0. Not a *.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { THEMES, panelHtml } from "./options-scene.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..", "..");
export const repoRoot = resolve(extensionRoot, "..", "..");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, what, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

export function pickPython() {
  const candidates = [process.env.DGC_TEST_PYTHON];
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    const launcher = join(dir, "dgc");
    if (!dir || !existsSync(launcher)) continue;
    const first = readFileSync(launcher, "utf8").split("\n", 1)[0];
    if (first.startsWith("#!") && /python/.test(first)) candidates.push(first.slice(2).trim().split(/\s+/)[0]);
    break;
  }
  candidates.push("python3");
  for (const python of candidates.filter(Boolean)) {
    const probe = spawnSync(python, ["-c", "import requests, prompt_toolkit, rich"], { stdio: "ignore" });
    if (probe.status === 0) return python;
  }
  return "";
}

// ---- the stub vscode module the bundled panel sees --------------------------------------------------
const anything = new Proxy(function () {}, {
  get: (_t, key) => (key === "then" || typeof key === "symbol") ? undefined : key === "dispose" ? () => {} : anything,
  apply: () => anything,
});
function soft(base) {
  return new Proxy(base, { get: (t, key) => (key in t ? t[key] : (key === "then" || typeof key === "symbol") ? undefined : anything) });
}
export const notices = [];
const stubState = { command: "dgc", workspace: tmpdir() };
globalThis.__DGC_PANEL_LIVE_VSCODE = {
  Uri: soft({ file: (p) => ({ fsPath: p, path: p, scheme: "file", toString: () => `file://${p}` }),
    joinPath: (u, ...parts) => ({ fsPath: join(u.fsPath, ...parts), toString: () => `file://${join(u.fsPath, ...parts)}` }),
    parse: (s) => ({ fsPath: s, toString: () => s }) }),
  env: soft({ clipboard: { writeText: async () => {} }, openExternal: async () => true, appName: "Code", uiKind: 1 }),
  commands: soft({ executeCommand: async () => undefined, registerCommand: anything }),
  languages: soft({ getDiagnostics: () => [] }),
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { WorkspaceFolder: 3, Workspace: 2, Global: 1 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ProgressLocation: { Notification: 15, Window: 10 },
  TextEditorRevealType: { InCenter: 2 },
  Selection: class {}, Range: class {}, Position: class {},
  EventEmitter: class { constructor() { this.event = anything; } fire() {} dispose() {} },
  window: soft({
    activeTextEditor: undefined, visibleTextEditors: [], tabGroups: { all: [], onDidChangeTabs: anything },
    createStatusBarItem: () => soft({ show() {}, hide() {}, dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {}, clear() {} }),
    showWarningMessage: async (m) => { notices.push(["warn", String(m)]); },
    showErrorMessage: async (m) => { notices.push(["error", String(m)]); },
    showInformationMessage: async (m) => { notices.push(["info", String(m)]); },
  }),
  workspace: soft({
    isTrusted: true, workspaceFile: undefined, name: "work", textDocuments: [],
    get workspaceFolders() {
      return [{ uri: { fsPath: stubState.workspace, toString: () => `file://${stubState.workspace}` }, name: "work", index: 0 }];
    },
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
      inspect: (key) => (key === "command" ? { globalValue: stubState.command } : undefined),
      update: async () => {},
    }),
    asRelativePath: (p) => String(p?.fsPath || p),
    findFiles: async () => [],
  }),
};

let providerClass;
async function DgcViewProvider() {
  if (providerClass) return providerClass;
  const out = mkdtempSync(join(tmpdir(), "dgc-panel-live-build-"));
  await build({
    entryPoints: [join(extensionRoot, "src/panel.ts")], bundle: true, format: "cjs", platform: "node", target: "node18",
    outfile: join(out, "panel.cjs"), logLevel: "silent",
    plugins: [{ name: "stub-vscode", setup(b) {
      b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
      b.onLoad({ filter: /^vscode$/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.__DGC_PANEL_LIVE_VSCODE;", loader: "js" }));
    } }],
  });
  providerClass = createRequire(import.meta.url)(join(out, "panel.cjs")).DgcViewProvider;
  rmSync(out, { recursive: true, force: true });
  return providerClass;
}

// ---- a scripted OpenAI-compatible model ---------------------------------------------------------------
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
export const chunk = (delta, finish = null) => sse({ id: "m", object: "chat.completion.chunk", model: "mock-model",
  choices: [{ index: 0, delta, finish_reason: finish }] });
export const answer = (text) => chunk({ content: text }) + chunk({}, "stop") + "data: [DONE]\n\n";
export const toolCalls = (calls) => chunk({ tool_calls: calls.map(([id, name, args], index) => ({
  index, id, type: "function", function: { name, arguments: JSON.stringify(args) } })) }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";

/** `respond({ body, messages, lastUser, res })` returns an SSE string, or writes `res` itself and returns null. */
export function modelServer(respond) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", async () => {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
        return;
      }
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!body.tools) {                      // a title or a summary: never part of a scripted turn
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
        res.end(answer("Title"));
        return;
      }
      const users = messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content
        : (m.content || []).map((p) => p?.text || "").join(""));
      const payload = await respond({ body, messages, lastUser: users.at(-1) || "", users, res });
      if (payload === null) return;
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      res.end(payload);
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// ---- the browser and the session --------------------------------------------------------------------
export async function launch() {
  let chromium = null, browser = null;
  try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
  if (chromium) {
    try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
  }
  const python = pickPython();
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)"
    : !browser ? "Chromium could not start" : !python ? "no Python with DGC's dependencies (set DGC_TEST_PYTHON)" : "";
  return {
    browser, python, reason,
    skipOrFail(t) {
      if (!reason) return false;
      if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
      t.skip(reason);
      return true;
    },
  };
}

/**
 * One chat: a throwaway HOME and workspace, a wrapper that runs this checkout's dgc, and a provider.
 * `config` is merged into the DGC config (base_url points at `model`).
 */
export async function panelSession({ browser, python, model, name, config = {}, files = {} }) {
  const Provider = await DgcViewProvider();
  const base = mkdtempSync(join(tmpdir(), `dgc-panel-live-${name}-`));
  const home = join(base, "home"), work = join(base, "work");
  mkdirSync(join(home, ".dgc"), { recursive: true }); mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README.md"), "fixture\n");
  for (const [file, text] of Object.entries(files)) writeFileSync(join(work, file), text);
  writeFileSync(join(home, ".dgc", "config.json"), JSON.stringify({
    base_url: `http://127.0.0.1:${model.address().port}/v1`, model: "mock-model", api_key: "sk-fixture-0123456789abcdef",
    api_mode: "chat_completions", suggest: false, notes: false, mode: "auto", artifact_autostart: false, eta: false,
    trusted_dirs: [work], ...config }));
  const wrapper = join(base, "dgc-real");
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  writeFileSync(wrapper, ["#!/bin/sh", `export HOME=${q(home)} XDG_CONFIG_HOME=${q(home)} XDG_DATA_HOME=${q(home)} XDG_STATE_HOME=${q(home)} XDG_CACHE_HOME=${q(home)}`,
    `export PYTHONPATH=${q(repoRoot)} PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1`, "unset OPENAI_API_KEY ANTHROPIC_API_KEY",
    `exec ${q(python)} -m dgc "$@"`].join("\n") + "\n");
  chmodSync(wrapper, 0o700);
  stubState.command = wrapper; stubState.workspace = work;

  const workspaceState = new Map();          // survives a window reload, like VS Code's Memento
  let webviewState;                          // survives webview and window reloads, like getState()
  const s = { base, home, work, events: [], posted: [], page: null, errors: [], provider: null };
  let generation = 0;

  function newProvider() {
    const mine = ++generation;
    const provider = new Provider({
      extensionUri: { fsPath: extensionRoot }, extensionPath: extensionRoot, subscriptions: [],
      globalState: { get() {}, async update() {}, keys: () => [], setKeysForSync() {} },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: anything },
      globalStorageUri: { fsPath: base }, storageUri: { fsPath: base }, logUri: { fsPath: base },
      workspaceState: { get: (k) => workspaceState.get(k), async update(k, v) { if (v === undefined) workspaceState.delete(k); else workspaceState.set(k, JSON.parse(JSON.stringify(v))); }, keys: () => [...workspaceState.keys()] },
    });
    provider.view = { visible: true, show() {}, webview: { postMessage: (m) => {
      if (mine !== generation) return Promise.resolve(false);           // a host that is gone posts nothing
      s.posted.push(m);
      const page = s.page;
      if (page && !page.isClosed()) page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), m).catch(() => {});
      return Promise.resolve(true);
    } } };
    const originalEnsure = provider.ensureBackend.bind(provider);
    provider.ensureBackend = () => {
      const had = provider.backend;
      const be = originalEnsure();
      if (be && be !== had && !be.__recorded) {
        be.__recorded = true;
        be.on("event", (ev) => { if (mine === generation) s.events.push(ev); });
      }
      return be;
    };
    s.provider = provider;
    provider.ensureBackend();
    return provider;
  }

  s.openWebview = async ({ width = 460, height = 760, theme = "dark-modern" } = {}) => {
    const { html, mainJs, markdownJs } = panelHtml();
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const provider = s.provider;
    await page.exposeFunction("__hostPost", (m) => { if (provider === s.provider) provider.onMessage(m).catch((e) => errors.push("host: " + e.message)); });
    await page.exposeFunction("__saveState", (value) => { webviewState = value; });
    await page.setContent(html.replace('data-draft-scope=""', `data-draft-scope="${provider.draftScope()}"`), { waitUntil: "load" });
    await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
    await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
    s.page = page; s.errors = errors;
    await page.evaluate(([mjs, mdjs, saved]) => {
      let state = saved;
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__hostPost(m), getState: () => state,
        setState(value) { state = JSON.parse(JSON.stringify(value)); window.__saveState(state); } });
      eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
      eval(mjs);
    }, [mainJs, markdownJs, webviewState]);
    return page;
  };
  /** Developer: Reload Webviews -- the same provider and backend, a fresh page. */
  s.reloadWebview = async (options) => {
    await s.page?.close();
    s.page = null;
    return s.openWebview(options);
  };
  /** Developer: Reload Window -- the extension host and its backend die; a new host starts over. */
  s.reloadWindow = async (options) => {
    const old = s.provider;
    await s.page?.close();
    s.page = null;
    generation += 1;                                   // the old host posts nothing from here on
    const child = old.backend?.proc;
    old.intentionalShutdown = true;
    if (child?.pid) { try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ } }
    await until(() => child?.exitCode !== null || child?.signalCode, "the old backend to die", 10_000).catch(() => {});
    newProvider();
    return s.openWebview(options);
  };
  s.ready = () => until(() => s.provider.sessionReady, "the session to be ready", 30_000);
  s.typePrompt = async (text, { queue = false } = {}) => {
    await s.page.locator("#input").click();
    await s.page.locator("#input").fill(text);
    await s.page.keyboard.press(queue ? "Alt+Enter" : "Enter");
  };
  s.close = async () => {
    await s.page?.close().catch(() => {});
    generation += 1;
    try { s.provider.backend?.dispose("test finished"); } catch { /* already gone */ }
    await sleep(400);
    rmSync(base, { recursive: true, force: true });
  };
  newProvider();
  return s;
}

/** What the transcript shows, in order: users (with their role label), DGC blocks, system lines. */
export const transcript = (page) => page.evaluate(() => [...document.querySelectorAll("#log .msg.user, #log .msg.dgc, #log > .sys, #log .hist > .sys")]
  .map((node) => node.matches(".msg.user")
    ? `${node.querySelector(".role")?.textContent}: ${node.querySelector(".bubble")?.textContent}`
      + ([...node.querySelectorAll("button")].map((b) => ` [${b.textContent}]`).join(""))
    : node.matches(".msg.dgc") ? `DGC: ${node.querySelector(".thinking")?.textContent.trim()}`
      : `sys: ${node.textContent.trim()}`));
