// The real src/panel.ts, bundled against a stub `vscode`, with a backend that records every
// command instead of speaking to a `dgc serve`. Tests that care about WHAT the extension sends
// (rather than how the source is written) drive the provider through this.
//
// Not a *.test.mjs file, so `node --test "test/**/*.test.mjs"` never runs it on its own.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
export const extensionRoot = resolve(here, "..", "..");
export const repoRoot = resolve(extensionRoot, "..", "..");

export const notices = { info: [], warnings: [], errors: [], quickPick: [] };
export const workspaceFolders = [];
let quickPickAnswer;
export function answerQuickPick(value) { quickPickAnswer = value; }

const scratch = mkdtempSync(join(tmpdir(), "dgc-panel-bundle-"));
workspaceFolders.push({ uri: { fsPath: scratch, toString: () => `file://${scratch}` } });
const statusBar = { text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} };

globalThis.__DGC_TEST_VSCODE = {
  Uri: { joinPath: (...parts) => ({ toString: () => parts.join("/"), fsPath: parts.join("/") }),
    file: (p) => ({ fsPath: p, toString: () => `file://${p}` }) },
  env: { clipboard: { writeText: async () => {} } },
  commands: { executeCommand: async () => undefined },
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { WorkspaceFolder: 1, Workspace: 2, Global: 3 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    tabGroups: { all: [] },
    createStatusBarItem: () => statusBar,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    showWarningMessage: async (m) => { notices.warnings.push(String(m)); },
    showErrorMessage: async (m) => { notices.errors.push(String(m)); },
    showInformationMessage: async (m) => { notices.info.push(String(m)); },
    showQuickPick: async (items) => { notices.quickPick.push(items); return quickPickAnswer; },
  },
  workspace: {
    isTrusted: true,
    workspaceFile: undefined,
    workspaceFolders,
    getConfiguration: () => ({ get: (_k, fallback) => fallback, inspect: () => undefined, async update() {} }),
  },
};

const bundle = join(scratch, "panel.cjs");
await build({
  entryPoints: [join(extensionRoot, "src/panel.ts")],
  bundle: true, format: "cjs", platform: "node", target: "node18",
  outfile: bundle, logLevel: "silent",
  plugins: [{
    name: "test-vscode",
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
      builder.onLoad({ filter: /^vscode$/, namespace: "test" }, () => ({
        contents: "module.exports = globalThis.__DGC_TEST_VSCODE;", loader: "js",
      }));
    },
  }],
});

export const { DgcViewProvider } = createRequire(import.meta.url)(bundle);

export function cleanup() {
  delete globalThis.__DGC_TEST_VSCODE;
  rmSync(scratch, { recursive: true, force: true });
}

/** A backend that records every command and never spawns anything. */
export function recordingBackend() {
  return {
    ready: true, sent: [], setup: [], requested: [], disposed: "",
    send(command) { this.sent.push(command); return true; },
    sendSetup(command) { this.setup.push(command); this.sent.push(command); return true; },
    request(command) { this.requested.push(command); this.sent.push(command); return Promise.resolve({ type: "ok" }); },
    completeHandshake() {}, start() {},
    dispose(cause) { this.disposed = cause || "disposed"; },
  };
}

/**
 * A provider wired to one recording backend.
 * `capabilities` is what the CLI declared in its `ready` event — the whole point of the gating.
 */
export function makeProvider({ capabilities = {} } = {}) {
  const posted = [];
  const provider = new DgcViewProvider({
    extension: { packageJSON: JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8")) },
    secrets: { async get() {}, async store() {}, async delete() {} },
    subscriptions: [],
    globalState: { get() {}, async update() {} },
    workspaceState: { get() {}, async update() {} },
  });
  const backend = recordingBackend();
  provider.post = (message) => { posted.push(message); };
  provider.webviewReady = true;
  provider.backend = backend;
  provider.ensureBackend = () => backend;
  provider.scheduleWorkspaceChanges = () => {};
  provider.postState = () => {};
  provider.backendNote = () => {};
  provider.surfaceUnsentPrompts = () => {};
  provider.lastReadyEvent = { type: "ready", capabilities };
  return { provider, backend, posted };
}

/** The editor-protocol schema shipped with a given released CLI, or null if the tag is absent. */
export function schemaAtTag(tag) {
  try {
    return JSON.parse(execFileSync("git", ["show", `${tag}:schemas/editor-protocol-v14.schema.json`],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    return null;
  }
}

/** command name → the field names that schema declares for it. */
export function declaredFields(schema) {
  const out = new Map();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const props = node.properties;
    if (props && props.type && typeof props.type === "object" && props.type.const) {
      const set = out.get(props.type.const) || new Set();
      for (const key of Object.keys(props)) set.add(key);
      out.set(props.type.const, set);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  };
  walk(schema);
  return out;
}
