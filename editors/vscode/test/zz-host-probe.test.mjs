import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = "/tmp/claude-1000/phase2/editors/vscode/test";
const scratch = mkdtempSync(join(tmpdir(), "dgc-host-probe-"));
const bundle = join(scratch, "panel.cjs");
const statusBar = { text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} };
globalThis.__DGC_TEST_VSCODE = {
  Uri: { joinPath: (...p) => ({ toString: () => p.join("/"), fsPath: p.join("/") }) },
  env: {}, commands: { executeCommand: async () => undefined },
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { WorkspaceFolder: 1, Workspace: 2, Global: 3 },
  window: { activeTextEditor: undefined, tabGroups: { all: [] },
    createStatusBarItem: () => statusBar,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    showWarningMessage: async () => {}, showErrorMessage: async () => {},
    showInformationMessage: async (m) => { console.log("INFO MESSAGE:", m); },
    showQuickPick: async () => undefined },
  workspace: { isTrusted: true, workspaceFile: undefined,
    workspaceFolders: [{ uri: { fsPath: scratch, toString: () => `file://${scratch}` } }],
    getConfiguration: () => ({ get: (_k, f) => f, inspect: () => undefined, async update() {} }) },
};
await build({ entryPoints: [join(here, "../src/panel.ts")], bundle: true, format: "cjs",
  platform: "node", target: "node18", outfile: bundle, logLevel: "silent",
  plugins: [{ name: "v", setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "t" }));
    b.onLoad({ filter: /^vscode$/, namespace: "t" }, () => ({
      contents: "module.exports = globalThis.__DGC_TEST_VSCODE;", loader: "js" })); } }] });
const { DgcViewProvider } = createRequire(import.meta.url)(bundle);

test("onMessage newChat opens a slot", async () => {
  const posted = []; const spawned = [];
  const p = new DgcViewProvider({
    extension: { packageJSON: { version: "0.27.1", dgcCliVersion: "0.42.0" } },
    secrets: { async get() {}, async store() {}, async delete() {} },
    subscriptions: [], globalState: { get() {}, async update() {} },
    workspaceState: { get() {}, async update() {} } });
  p.post = (m) => posted.push(m);
  p.webviewReady = true;
  p.scheduleWorkspaceChanges = () => {};
  p.postState = () => {};
  p.backendNote = (l) => console.log("NOTE:", l);
  p.surfaceUnsentPrompts = () => {};
  p.ensureBackend = function () {
    if (this.backend) { this.activeSlot().backend = this.backend; return this.backend; }
    const be = { ready: true, sent: [], send() { return true; }, sendSetup() { return true; },
      request() { return Promise.resolve({ type: "ok" }); }, completeHandshake() {}, start() {},
      dispose() {} };
    spawned.push(be); this.backend = be; this.activeSlot().backend = be; return be;
  };
  p.ensureBackend();
  p.currentSessionId = "alpha"; p.sessionReady = true;
  p.lastReadyEvent = { type: "ready", capabilities: { history_snapshot: true } };
  posted.length = 0;
  try {
    await p.onMessage({ type: "newChat" });
  } catch (e) {
    console.log("onMessage THREW:", String(e && e.stack || e).slice(0, 400));
  }
  console.log("slots:", p.slots.length, "| spawned:", spawned.length);
  console.log("posted types:", JSON.stringify(posted.map(m => m.type)));
  const slotsMsg = posted.filter(m => m.type === "chat_slots").pop();
  console.log("chat_slots items:", slotsMsg ? slotsMsg.items.length : "(none posted)");
});
