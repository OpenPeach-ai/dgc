import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-panel-settings-"));
const bundle = join(scratch, "panel.cjs");

const notices = { warnings: [], errors: [], info: [], warningResponses: [] };
let configurationInspections = {};
const statusBar = { text: "", tooltip: "", command: "", show() {}, dispose() {} };
globalThis.__DGC_TEST_VSCODE = {
  Uri: {},
  env: {},
  commands: {},
  // The bundle sees this object through live getters created at require time, so a key that is
  // absent here can never be added by a test. Everything the panel touches has to exist now.
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3,
                        0: "Error", 1: "Warning", 2: "Information", 3: "Hint" },
  StatusBarAlignment: { Left: 1 },
  ViewColumn: { Beside: 2 },
  ConfigurationTarget: { WorkspaceFolder: 1, Workspace: 2, Global: 3 },
  window: {
    activeTextEditor: undefined,
    tabGroups: { all: [] },
    createStatusBarItem: () => statusBar,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    showWarningMessage: async (message) => {
      notices.warnings.push(String(message));
      return notices.warningResponses.shift();
    },
    showErrorMessage: async (message) => { notices.errors.push(String(message)); },
    showInformationMessage: async (message) => { notices.info.push(String(message)); },
  },
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: scratch } }],
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
      inspect: (key) => configurationInspections[key],
      update: async (key, value, target) => {
        const field = target === 1 ? "workspaceFolderValue"
          : target === 2 ? "workspaceValue" : "globalValue";
        const next = { ...(configurationInspections[key] || {}) };
        if (value === undefined) { delete next[field]; } else { next[field] = value; }
        configurationInspections[key] = next;
      },
    }),
  },
};

await build({
  entryPoints: [join(here, "../src/panel.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundle,
  logLevel: "silent",
  plugins: [{
    name: "test-vscode",
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
      builder.onLoad({ filter: /^vscode$/, namespace: "test" }, () => ({
        contents: "module.exports = globalThis.__DGC_TEST_VSCODE;",
        loader: "js",
      }));
    },
  }],
});

const { DgcViewProvider } = createRequire(import.meta.url)(bundle);
after(() => {
  delete globalThis.__DGC_TEST_VSCODE;
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  notices.warnings.length = 0;
  notices.errors.length = 0;
  notices.info.length = 0;
  notices.warningResponses.length = 0;
  configurationInspections = {};
});

function settings(overrides = {}) {
  return {
    mode: "default", think: "off", ultra_mode: false, subscription_engine: "",
    subscription_model: "", subscription_effort: "",
    api_mode: "auto", provider_state: "stateless", prompt_cache: true,
    sandbox: false, sandbox_network: false, show_reasoning: true, suggest: true,
    plan_artifact: true, artifact_autostart: true, artifact_in_plan: false,
    tool_profile: "adaptive", max_parallel_tasks: 4,
    subagent_model: "", subagent_base_url: "", subagent_api_mode: "",
    fallback_model: "", fallback_base_url: "", fallback_api_mode: "",
    ...overrides,
  };
}

function harness({ mode = "default", engine = "", trusted = true, rejectType = "",
                   rejectSandbox = false, initialSecrets = {}, failSecretStoreOnce = "" } = {}) {
  const timeline = [];
  const commands = [];
  const secretValues = new Map(Object.entries(initialSecrets));
  let failedStore = false;
  let backendMode = mode;
  let backendEngine = engine;
  let backendTrusted = trusted;
  const secrets = {
    async get(key) { timeline.push(`secret:get:${key}`); return secretValues.get(key); },
    async store(key, value) {
      timeline.push(`secret:store:${key}`);
      if (!failedStore && key === failSecretStoreOnce) {
        failedStore = true;
        throw new Error("synthetic SecretStorage failure");
      }
      secretValues.set(key, value);
    },
    async delete(key) { timeline.push(`secret:delete:${key}`); secretValues.delete(key); },
  };
  const backend = {
    ready: true,
    async request(command, responseType) {
      commands.push(JSON.parse(JSON.stringify(command)));
      timeline.push(`request:${command.type}`);
      await Promise.resolve();
      if (command.type === rejectType) {
        timeline.push(`reject:${command.type}`);
        throw new Error(`synthetic ${command.type} rejection`);
      }
      if (rejectSandbox && command.type === "set_config" && command.values?.sandbox === true) {
        timeline.push(`reject:${command.type}`);
        throw new Error("sandbox remains off because no confinement backend was found");
      }
      if (command.type === "set_mode" && backendEngine === "kimi" && command.mode !== "auto") {
        timeline.push(`reject:${command.type}`);
        throw new Error("Kimi prompt mode requires DGC auto mode; disconnect it first");
      }
      if (command.type === "set_mode") {
        backendMode = command.mode;
        if (command.acknowledge_workspace_trust === true) { backendTrusted = true; }
      }
      if (command.type === "set_config"
          && Object.prototype.hasOwnProperty.call(command.values || {}, "subscription_engine")) {
        const selected = String(command.values.subscription_engine || "");
        if (selected === "kimi" && backendMode !== "auto") {
          timeline.push(`reject:${command.type}`);
          throw new Error("Kimi prompt mode requires DGC auto mode");
        }
        backendEngine = selected;
      }
      timeline.push(`ack:${command.type}`);
      return { type: responseType, seq: timeline.length, request_id: command.request_id };
    },
  };
  const context = { extension: { packageJSON: { version: "0.25.1", dgcCliVersion: "0.40.1" } }, secrets, subscriptions: [], globalState: { get() {}, async update() {} } };
  const provider = new DgcViewProvider(context);
  provider.lastReadyEvent={capabilities:{plugin_management:true,app_connectors:true}};
  provider.backend = backend;
  provider.correlatedStateRequests = true;
  provider.state = {
    model: "native-model", mode, think: "off", ultra: false, baseUrl: "https://old.invalid/v1",
    workspaceTrusted: trusted, subscriptionEngine: engine,
    goal: { text: "", status: "none", elapsed_seconds: 0 },
  };
  provider.routeState = {
    subagentBaseUrl: "", fallbackBaseUrl: "", nativeModel: "native-model", nativeThink: "off",
    subscriptionEngine: engine, subscriptionModel: "", subscriptionEffort: "",
    subscriptionEngines: [],
  };
  return { provider, timeline, commands, secretValues,
    backendState: () => ({ mode: backendMode, engine: backendEngine, trusted: backendTrusted }) };
}

function requestTypes(timeline) {
  return timeline.filter((item) => item.startsWith("request:"))
    .map((item) => item.slice("request:".length));
}

function restorationHarness() {
  const saved = new Map(), posted = [], calls = [];
  let resolve, reject, released = 0, disposed = 0;
  const provider = new DgcViewProvider({ subscriptions: [], globalState: { get() {} },
    workspaceState: { get: key => saved.get(key), async update(key, value) { saved.set(key, value); } },
  });
  provider.post = message => posted.push(message);
  const backend = { ready: true,
    request(command, response, timeout, setup) {
      calls.push({ command, response, timeout, setup });
      return new Promise((yes, no) => { resolve = yes; reject = no; });
    },
    completeHandshake() { released++; }, dispose() { disposed++; }, close() { disposed++; },
  };
  Object.assign(provider, { backend, initializingBackend: backend, nativeSettingsReady: true,
    workspaceRootsDirty: false, currentSessionId: "new-chat", sessionRestoreCandidate: "saved-chat",
    correlatedStateRequests: true });
  return { provider, backend, saved, posted, calls, released: () => released, disposed: () => disposed,
    complete() {
      const event = { type: "session", kind: "resumed", session_id: "saved-chat", name: "Saved",
        message_count: 1, request_id: calls[0].command.request_id };
      provider.onEvent(event); resolve(event);
    }, reject: message => reject(new Error(message)),
  };
}

test("session restoration keeps setup closed through crossed replies and changing root grants", async () => {
  const h = restorationHarness();
  h.provider.workspaceRootsInFlight = { revision: 1, requestId: "roots-1" };
  h.provider.maybeCompleteHandshake(h.backend);
  assert.equal(h.calls.length, 0);
  h.provider.workspaceRootsInFlight = undefined;
  h.provider.maybeCompleteHandshake(h.backend);
  h.provider.maybeCompleteHandshake(h.backend);
  assert.equal(h.calls.length, 1, "only one restore may run during the handshake");
  assert.equal(h.calls[0].setup, true);
  assert.equal(h.calls[0].command.path, "saved-chat.json");
  h.provider.onEvent({ type: "session", kind: "resumed", session_id: "wrong", request_id: "stale" });
  assert.equal(h.provider.currentSessionId, "new-chat");
  assert.equal(h.posted.some(message => message.event?.session_id === "wrong"), false);
  h.provider.workspaceRootsInFlight = { revision: 2, requestId: "roots-2" };
  h.complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.released(), 0, "restoration cannot bypass a newer root grant");
  h.provider.workspaceRootsInFlight = undefined;
  h.provider.maybeCompleteHandshake(h.backend);
  assert.equal(h.released(), 1);
  assert.equal(h.provider.sessionReady, true);
  assert.equal(h.saved.get("dgc.activeSession.v1").id, "saved-chat");
  assert.ok(h.posted.some(message => message.type === "session_ready" && message.sessionId === "saved-chat"));
});

test("missing saved chats adopt the draft, while timed-out or stale restores release no prompts", async () => {
  const missing = restorationHarness();
  missing.provider.maybeCompleteHandshake(missing.backend);
  missing.reject("no such session");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(missing.released(), 1);
  assert.ok(missing.posted.some(message => message.type === "session_ready"
    && message.sessionId === "new-chat" && message.adoptDraftFrom === "saved-chat"));
  const timeout = restorationHarness();
  timeout.provider.maybeCompleteHandshake(timeout.backend);
  timeout.reject("DGC timed out waiting for session");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timeout.released(), 0);
  assert.equal(timeout.disposed(), 1);
  assert.equal(timeout.saved.size, 0);
  const stale = restorationHarness();
  stale.provider.maybeCompleteHandshake(stale.backend);
  stale.provider.sessionHandshakeGeneration++;
  stale.reject("DGC backend exited while waiting for session");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stale.released(), 0);
  assert.equal(stale.disposed(), 0, "an old callback cannot dispose the new backend generation");
});

test("goal startup sends one validated-payload command and older backends reject attachments intact", async () => {
  const h = harness(), posted = [], commands = [];
  h.provider.post = message => posted.push(message);
  h.provider.editorContext = () => [{ type: "active_file", path: "app.ts" }];
  h.provider.goalInputs = true;
  h.provider.backend.send = command => { commands.push(command); return true; };
  const payload = { requestId: "goal-input-1", skills: ["verify"], templates: ["check"],
    images: ["data:image/png;base64,iVBORw0KGgo="],
    context: [{ type: "mcp_context", server: "docs", uri: "docs://one", text: "Snapshot" }] };
  await h.provider.startGoal("--tokens 900 Verify release", payload);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "start_goal");
  assert.equal(commands[0].text, "Verify release");
  assert.equal(commands[0].token_budget, 900);
  assert.equal(commands[0].request_id, payload.requestId);
  assert.deepEqual(commands[0].skills, payload.skills);
  assert.deepEqual(commands[0].templates, payload.templates);
  assert.deepEqual(commands[0].images, payload.images);
  assert.deepEqual(commands[0].context, [...payload.context, { type: "active_file", path: "app.ts" }]);
  assert.equal(h.commands.length, 0, "no separate goal mutation can precede input validation");
  h.provider.turnActive = false; // The previous accepted turn has finished.
  h.provider.goalInputs = false;
  await h.provider.startGoal("Verify release", payload);
  assert.equal(commands.length, 1);
  assert.ok(posted.some(message => message.type === "prompt_rejected" && message.requestId === payload.requestId));
  assert.ok(posted.some(message => message.type === "goal_start_state" && /Update the DGC CLI/.test(message.error)));
  await h.provider.startGoal("--tokens nope Verify", { requestId: "invalid-budget" });
  assert.ok(posted.some(message => message.type === "prompt_rejected" && message.requestId === "invalid-budget"));
  h.provider.goalInputs = true;
  await h.provider.startGoal("Verify", { requestId: "too-many", context: Array.from({ length: 65 }, () => ({ type: "file_mention", path: "app.ts" })) });
  assert.equal(commands.length, 1, "selected context must never be silently truncated before backend validation");
  assert.ok(posted.some(message => message.type === "prompt_rejected" && message.requestId === "too-many"));
});

test("workflow host routing carries selections and context without an independent permission mutation", async () => {
  const h = harness(), posted = [], commands = [];
  h.provider.post = message => posted.push(message);
  h.provider.editorContext = () => [{ type: "active_file", path: "app.ts" }];
  h.provider.lastReadyEvent = { capabilities: { workflows: true } };
  h.provider.composerSelections = true;
  h.provider.backend.send = command => { commands.push(command); return true; };
  const context = [{ type: "mcp_context", server: "docs", uri: "docs://retry", text: "Snapshot" }];
  for (const text of ["/review --base main Retry handling", "Retry handling /review"]) {
    await h.provider.onMessage({ type: "prompt", text, requestId: text, skills: ["verify"], context });
    const command = commands.at(-1);
    assert.equal(command.workflow, "review");
    assert.equal(command.type, "prompt");
    assert.deepEqual(command.skills, ["verify"]);
    assert.deepEqual(command.context, [...context, { type: "active_file", path: "app.ts" }]);
    assert.equal(command.request_id, text);
  }
  assert.equal(commands.length, 2);
  h.provider.lastReadyEvent = { capabilities: {} };
  await h.provider.onMessage({ type: "prompt", text: "/init", requestId: "old-cli" });
  assert.equal(commands.length, 2);
  assert.ok(posted.some(message => message.type === "prompt_rejected" && message.requestId === "old-cli"));
});

function secretMutations(timeline) {
  return timeline.filter((item) => item.startsWith("secret:store:")
    || item.startsWith("secret:delete:"));
}

function catalogHarness(catalog) {
  const updates = [];
  const context = {
    secrets: { async get() {}, async store() {}, async delete() {} },
    subscriptions: [],
    globalState: {
      get: () => catalog,
      async update(key, value) { updates.push({ key, value }); },
    },
  };
  const provider = new DgcViewProvider(context);
  provider.lastReadyEvent = {capabilities:{plugin_management:true,app_connectors:true,usage_ledger:true}};
  return { provider, updates };
}

function changesHarness() {
  const harness = catalogHarness([]);
  const program = `import json, sys
from pathlib import Path
from dgc.workspace_changes import collect_changes, read_change
command = json.loads(sys.argv[1])
if command["type"] == "get_workspace_changes":
    result = {"type": "workspace_changes", "roots": [collect_changes(Path(root).resolve()) for root in command["roots"]]}
else:
    result = {"type": "workspace_change", **read_change(Path(command["root"]).resolve(), command["path"])}
print(json.dumps({"request_id": command["request_id"], **result}))`;
  harness.provider.lastReadyEvent = { capabilities: { workspace_inspection: true } };
  harness.provider.workspaceRootsDirty = false;
  harness.provider.backend = { ready: true, request: async command => JSON.parse(execFileSync(
    process.env.DGC_TEST_PYTHON || "python3", ["-c", program, JSON.stringify({ ...command,
      roots: globalThis.__DGC_TEST_VSCODE.workspace.workspaceFolders.map(folder => folder.uri.fsPath) })],
    { cwd: resolve(here, "../../.."), encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 })) };
  return harness;
}

test("workspace changes include initial staged files and literal subfolder scopes", async () => {
  const root = mkdtempSync(join(scratch, "changes-"));
  const nested = join(root, "[app]");
  mkdirSync(nested);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(nested, "new.ts"), "export const first = 1;\n");
  git("add", ".");
  const workspace = globalThis.__DGC_TEST_VSCODE.workspace;
  const original = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ name: "fixture", uri: { fsPath: nested } }];
  try {
    const { provider } = changesHarness();
    const { files: initial } = await provider.collectWorkspaceChanges();
    assert.equal(initial.length, 1, "a staged file in an unborn repository is a real change");
    assert.equal(initial[0].displayPath, "new.ts");
    assert.equal(initial[0].additions, 1);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial");
    writeFileSync(join(nested, "new.ts"), "export const first = 2;\nexport const second = 3;\n");
    writeFileSync(join(root, "outside.ts"), "outside scoped folder\n");
    const { files: changed } = await provider.collectWorkspaceChanges();
    assert.equal(changed.length, 1);
    assert.equal(changed[0].displayPath, "new.ts");
    assert.equal(changed[0].additions, 2);
    assert.equal(changed[0].deletions, 1);
  } finally { workspace.workspaceFolders = original; }
});

test("change review shows new staged content and never follows an external symlink", async () => {
  const root = mkdtempSync(join(scratch, "review-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "initial");
  writeFileSync(join(root, "[new].ts"), "export const value = 42;\n");
  git("add", ".");
  const api = globalThis.__DGC_TEST_VSCODE;
  const original = { folders: api.workspace.workspaceFolders, Uri: api.Uri, commands: api.commands };
  const opened = [];
  api.workspace.workspaceFolders = [{ name: "fixture", uri: { fsPath: root } }];
  api.Uri = { from: value => ({ ...value, toString: () => `${value.scheme}://${value.authority}${value.path}` }) };
  api.commands = { executeCommand: async (...args) => opened.push(args) };
  try {
    const { provider } = changesHarness();
    provider.workspaceChanges = (await provider.collectWorkspaceChanges()).files;
    await provider.reviewWorkspaceChange("[new].ts");
    assert.equal(opened[0]?.[0], "vscode.diff");
    assert.equal(provider.reviewDocuments.get(opened[0][1].toString()), "");
    assert.equal(provider.reviewDocuments.get(opened[0][2].toString()), "export const value = 42;\n");
    const external = join(scratch, "private-fixture.txt");
    writeFileSync(external, "external content must never appear in a diff");
    symlinkSync(external, join(root, "link.txt"));
    provider.workspaceChanges = (await provider.collectWorkspaceChanges()).files;
    await provider.reviewWorkspaceChange("link.txt");
    assert.equal(opened[1]?.[0], "vscode.diff");
    assert.equal(provider.reviewDocuments.get(opened[1][2].toString()), `${external}\n`);
    assert.equal(notices.info.length, 0);
    api.workspace.workspaceFolders = [];
    await provider.reviewWorkspaceChange("[new].ts");
    assert.equal(opened.length, 2, "removing the folder revokes review access");
  } finally {
    api.workspace.workspaceFolders = original.folders;
    api.Uri = original.Uri;
    api.commands = original.commands;
  }
});

test("change review handles the first commit and reads a literal committed blob", async () => {
  const root = mkdtempSync(join(scratch, "review-unborn-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(root, "[literal].ts"), "export const value = 1;\n");
  git("add", ".");
  const api = globalThis.__DGC_TEST_VSCODE;
  const original = { folders: api.workspace.workspaceFolders, Uri: api.Uri, commands: api.commands };
  const opened = [];
  api.workspace.workspaceFolders = [{ name: "fixture", uri: { fsPath: root } }];
  api.Uri = { from: value => ({ ...value, toString: () => `${value.scheme}://${value.authority}${value.path}` }) };
  api.commands = { executeCommand: async (...args) => opened.push(args) };
  try {
    const { provider } = changesHarness();
    provider.workspaceChanges = (await provider.collectWorkspaceChanges()).files;
    await provider.reviewWorkspaceChange("[literal].ts");
    assert.equal(opened[0]?.[0], "vscode.diff");
    assert.equal(provider.reviewDocuments.get(opened[0][1].toString()), "");
    assert.equal(provider.reviewDocuments.get(opened[0][2].toString()), "export const value = 1;\n");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial");
    writeFileSync(join(root, "[literal].ts"), "export const value = 2;\n");
    provider.workspaceChanges = (await provider.collectWorkspaceChanges()).files;
    await provider.reviewWorkspaceChange("[literal].ts");
    assert.equal(opened[1]?.[0], "vscode.diff");
    assert.equal(provider.reviewDocuments.get(opened[1][1].toString()), "export const value = 1;\n");
    assert.equal(provider.reviewDocuments.get(opened[1][2].toString()), "export const value = 2;\n");
    assert.equal(notices.info.length, 0);
  } finally {
    api.workspace.workspaceFolders = original.folders;
    api.Uri = original.Uri;
    api.commands = original.commands;
  }
});

test("large change scans expose true totals, bounded line reads, and unavailable folders", async () => {
  const root = mkdtempSync(join(scratch, "large-changes-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (let i = 0; i < 505; i++) writeFileSync(join(root, `file-${i}.txt`), "new line\n");
  const workspace = globalThis.__DGC_TEST_VSCODE.workspace, original = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ name: "fixture", uri: { fsPath: root } }];
  try {
    const { provider } = changesHarness(), result = await provider.collectWorkspaceChanges();
    assert.equal(result.total, 505); assert.equal(result.files.length, 500);
    assert.ok(result.files.every(file => file.additions === 1));
    assert.match(result.notices.join(" "), /500 of 505/);
    workspace.workspaceFolders = [{ name: "missing", uri: { fsPath: join(root, "absent") } }];
    const missing = await provider.collectWorkspaceChanges();
    assert.equal(missing.total, 0); assert.match(missing.notices.join(" "), /unavailable/);
  } finally { workspace.workspaceFolders = original; }
});

test("change previews use distinct identities for same-named workspace folders", async () => {
  const roots = ["one-", "two-"].map(prefix => mkdtempSync(join(scratch, prefix)));
  for (const [index, root] of roots.entries()) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "same.ts"), `workspace ${index}\n`);
  }
  const api = globalThis.__DGC_TEST_VSCODE;
  const original = { folders: api.workspace.workspaceFolders, Uri: api.Uri, commands: api.commands };
  const opened = [];
  api.workspace.workspaceFolders = roots.map(root => ({ name: "same", uri: { fsPath: root } }));
  api.Uri = { from: value => ({ ...value, toString: () => `${value.scheme}://${value.authority}${value.path}` }) };
  api.commands = { executeCommand: async (...args) => opened.push(args) };
  try {
    const { provider } = changesHarness();
    provider.workspaceChanges = (await provider.collectWorkspaceChanges()).files;
    assert.equal(provider.workspaceChanges.length, 2);
    assert.notEqual(provider.workspaceChanges[0].id, provider.workspaceChanges[1].id);
    await provider.reviewWorkspaceChange("same/same.ts");
    assert.equal(opened.length, 0, "ambiguous display names must never select a different workspace");
    await provider.reviewWorkspaceChange(provider.workspaceChanges[1].id);
    assert.equal(provider.reviewDocuments.get(opened[0][2].toString()), "workspace 1\n");
    if (provider.changesRefreshTimer) clearTimeout(provider.changesRefreshTimer);
    provider.backend.request = async () => ({ type: "workspace_changes", roots: [] });
    assert.match((await provider.collectWorkspaceChanges()).notices.join(" "), /no change report/);
    provider.lastReadyEvent.capabilities.workspace_inspection = false;
    assert.match((await provider.collectWorkspaceChanges()).notices.join(" "), /Update the DGC CLI/);
  } finally {
    api.workspace.workspaceFolders = original.folders;
    api.Uri = original.Uri;
    api.commands = original.commands;
  }
});

test("MCP sign-in ignores duplicate acceptance and cannot open after cancellation during forwarding", async () => {
  const api = globalThis.__DGC_TEST_VSCODE;
  const original = { Uri: api.Uri, env: api.env };
  const sent = [], opened = [];
  let release;
  api.Uri = { parse: value => new URL(value) };
  api.env = { remoteName: "ssh-remote",
    asExternalUri: () => new Promise(resolve => { release = resolve; }),
    openExternal: async uri => { opened.push(uri.toString()); return true; } };
  const { provider } = catalogHarness([]);
  provider.backend = { ready: true, send: command => { sent.push(command); return true; } };
  const callback = "http://localhost:43123/oauth/callback";
  const url = "https://auth.example.invalid/authorize?redirect_uri=" + encodeURIComponent(callback);
  const event = id => ({ type: "mcp_input_request", id, server: "fixture", kind: "elicitation",
    payload: { mode: "url", url, _dgc_bridge_callback: callback } });
  try {
    provider.onEvent(event("cancelled"));
    const pending = provider.onMessage({ type: "mcp_input_response", id: "cancelled", action: "accept" });
    await provider.onMessage({ type: "mcp_input_response", id: "cancelled", action: "accept" });
    assert.equal(sent.length, 0, "duplicate acceptance must not acknowledge before the browser opens");
    await provider.onMessage({ type: "mcp_input_response", id: "cancelled", action: "cancel" });
    release(new URL(callback));
    await pending;
    assert.deepEqual(sent.map(command => command.action), ["cancel"]);
    assert.deepEqual(opened, []);
    provider.onEvent(event("expired"));
    const expired = provider.onMessage({ type: "mcp_input_response", id: "expired", action: "accept" });
    provider.onEvent({ type: "request_expired", id: "expired" });
    release(new URL(callback));
    await expired;
    assert.equal(sent.length, 1);
    assert.deepEqual(opened, []);
    api.env.asExternalUri = async uri => uri;
    provider.onEvent(event("current"));
    await provider.onMessage({ type: "mcp_input_response", id: "current", action: "accept" });
    // The URL is opened immediately on the event, without a second acceptance surface.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, [url]);
    assert.deepEqual(sent.map(command => command.action), ["cancel", "accept"]);
  } finally { api.Uri = original.Uri; api.env = original.env; }
});

test("Cancel on a sign-in opened in the browser cancels that sign-in, never the chat's turn", async () => {
  // It sent the turn's Stop. Installs run beside a turn now and that Stop never reaches one: the
  // plugin went on connecting, and a running turn was ended instead -- its queued messages handed
  // back, its approval cards expired. The backend maps a cancel for the sign-in's own id onto the
  // install (tests/test_plugins_mid_turn.py).
  const api = globalThis.__DGC_TEST_VSCODE;
  const original = { Uri: api.Uri, env: api.env };
  const sent = [];
  api.Uri = { parse: value => new URL(value) };
  api.env = { remoteName: undefined, asExternalUri: async uri => uri, openExternal: async () => true };
  const { provider } = catalogHarness([]);
  provider.backend = { ready: true, send: command => { sent.push(command); return true; } };
  const callback = "http://localhost:43124/oauth/callback";
  const url = "https://auth.example.invalid/authorize?redirect_uri=" + encodeURIComponent(callback);
  const signIn = id => ({ type: "mcp_input_request", id, server: "make", kind: "elicitation",
    payload: { mode: "url", url, _dgc_bridge_callback: callback } });
  try {
    provider.onEvent(signIn("opened"));
    await provider.onMessage({ type: "mcp_input_response", id: "opened", action: "accept" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent.map(command => [command.type, command.action]), [["mcp_input_response", "accept"]],
      "premise: the browser opened and the request was answered");
    await provider.onSettingsMessage({ type: "cancelSignIn" });
    assert.ok(!sent.some(command => command.type === "cancel"), "Cancel sent the turn's Stop");
    assert.deepEqual(sent.at(-1), { type: "mcp_input_response", id: "opened", action: "cancel" });
    sent.length = 0;
    await provider.onSettingsMessage({ type: "cancelSignIn" });
    assert.deepEqual(sent, [], "a second Cancel has nothing left to cancel");
  } finally { api.Uri = original.Uri; api.env = original.env; }
});

test("a server-sent url elicitation is asked about, not opened", async () => {
  // Only the local sign-in bridge carries _dgc_bridge_callback, and only because the user clicked
  // Connect. A url elicitation without it can come from any connected server, unprompted, while it
  // services a tools/call the model just made -- so it has to reach the consent card in the
  // webview, which names the server, shows the host and the full URL, and warns about punycode.
  const api = globalThis.__DGC_TEST_VSCODE;
  const original = { Uri: api.Uri, env: api.env };
  const opened = [], posted = [];
  api.Uri = { parse: value => new URL(value) };
  api.env = { remoteName: undefined, asExternalUri: async uri => uri,
    openExternal: async uri => { opened.push(uri.toString()); return true; } };
  const { provider } = catalogHarness([]);
  provider.backend = { ready: true, send: () => true };
  provider.post = message => { posted.push(message); };
  try {
    const url = "https://xn--80ak6aa92e.example.invalid/grant";
    provider.onEvent({ type: "mcp_input_request", id: "server-sent", server: "marketplace-server",
      kind: "elicitation", payload: { mode: "url", url, host: "xn--80ak6aa92e.example.invalid",
        suspicious_host: true, message: "Authorize this integration" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, [], "no browser opens until the user accepts the card");
    const forwarded = posted.filter(m => m.type === "event" && m.event?.type === "mcp_input_request");
    assert.equal(forwarded.length, 1, "the event must reach the webview so the card can be drawn");
    assert.equal(forwarded[0].event.payload.url, url, "the card shows the full URL it will open");
    assert.equal(forwarded[0].event.payload.suspicious_host, true,
      "the punycode warning survives the trip to the card");
    // Accepting from the card opens it, through the same guarded path as before.
    await provider.onMessage({ type: "mcp_input_response", id: "server-sent", action: "accept" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, [url], "accepting on the card still opens the URL");
  } finally { api.Uri = original.Uri; api.env = original.env; }
});

test("a plugin's key goes to dgc serve once, only to a CLI that keeps keys, and only its page hears back", async () => {
  // The key field on GitHub's page. The extension stores nothing: the key goes to dgc serve, which keeps it in the
  // system keychain, and the answer the page gets says THAT it was saved, never the key.
  const settings = [], chat = [], commands = [];
  const { provider } = catalogHarness([]);
  provider.lastReadyEvent = { capabilities: { plugin_management: true, plugin_keys: true } };
  provider.settingsEditor = { webview: { postMessage: m => settings.push(m) } };
  provider.post = m => chat.push(m);
  provider.ensureBackend = () => ({ send: m => { commands.push(m); return true; } });
  await provider.onSettingsMessage({ type: "savePluginKey", name: "github", server: "github", env: "GITHUB_PAT_TOKEN", key: " github_pat_fixture " });
  assert.equal(commands.length, 1);
  assert.deepEqual({ ...commands[0], request_id: "" },
    { type: "set_plugin_key", request_id: "", name: "github", server: "github", env: "GITHUB_PAT_TOKEN", key: "github_pat_fixture" });
  provider.onEvent({ type: "plugin_operation", request_id: commands[0].request_id, action: "set_plugin_key",
    name: "github", message: "Saved your GitHub personal access token in your system keychain." });
  assert.deepEqual(settings.at(-1), { type: "pluginKeyResult", name: "github", server: "github",
    message: "Saved your GitHub personal access token in your system keychain." });
  assert.equal(chat.length, 0, "the chat never hears about a key");
  await provider.onSettingsMessage({ type: "removePluginKey", name: "github", server: "github" });
  assert.deepEqual({ ...commands[1], request_id: "" }, { type: "remove_plugin_key", request_id: "", name: "github", server: "github" });
  provider.onEvent({ type: "command_rejected", request_id: commands[1].request_id, command: "remove_plugin_key",
    reason: "plugin", message: "github is not installed." });
  assert.deepEqual(settings.at(-1), { type: "pluginKeyResult", name: "github", server: "github", error: "github is not installed." });
  assert.equal(JSON.stringify(settings).includes("github_pat_fixture"), false, "the page never gets the key back");
  provider.lastReadyEvent = { capabilities: { plugin_management: true } };
  await provider.onSettingsMessage({ type: "savePluginKey", name: "github", server: "github", key: "github_pat_fixture" });
  assert.equal(commands.length, 2, "a CLI without plugin_keys is never sent a key");
  assert.match(settings.at(-1).error, /can't keep a plugin's key yet\. Update it/);
});

test("What DGC may do on GitHub: the choice and Sign in again go to dgc serve, only one that offers them, answered on the page", async () => {
  const settings = [], chat = [], commands = [];
  const { provider } = catalogHarness([]);
  provider.lastReadyEvent = { capabilities: { plugin_management: true, plugin_keys: true, plugin_sign_in_scopes: true } };
  provider.settingsEditor = { webview: { postMessage: m => settings.push(m) } };
  provider.post = m => chat.push(m);
  provider.pluginLogo = () => "";
  provider.backend = { send: () => true };
  provider.ensureBackend = () => ({ send: m => { commands.push(m); return true; } });
  await provider.onSettingsMessage({ type: "setPluginSignInScopes", name: "github", scopes: ["notifications", "../x", 7] });
  assert.deepEqual({ ...commands[0], request_id: "" },
    { type: "set_plugin_sign_in_scopes", request_id: "", name: "github", scopes: ["notifications"] });
  provider.onEvent({ type: "plugin_operation", request_id: commands[0].request_id, action: "set_plugin_sign_in_scopes",
    name: "github", message: "Saved. Signing in asks GitHub for: code, issues, pull requests, organisations, profile, notifications." });
  assert.deepEqual(settings.at(-1), { type: "pluginKeyResult", name: "github", server: "", kind: "scopes",
    message: "Saved. Signing in asks GitHub for: code, issues, pull requests, organisations, profile, notifications." });
  await provider.onSettingsMessage({ type: "setPluginSignInScopes", name: "github", scopes: ["admin"] });
  provider.onEvent({ type: "command_rejected", request_id: commands[1].request_id, command: "set_plugin_sign_in_scopes",
    reason: "plugin", message: "GitHub has no permission called 'admin'." });
  assert.deepEqual(settings.at(-1), { type: "pluginKeyResult", name: "github", server: "", kind: "scopes",
    error: "GitHub has no permission called 'admin'." });
  // Sign in again: answered like a Connect from the page, its failure said there and not in the chat.
  await provider.onSettingsMessage({ type: "signInAgain", name: "github", scopes: ["notifications", "gists"] });
  assert.deepEqual({ ...commands[2], request_id: "" }, { type: "set_plugin_sign_in_scopes", request_id: "", name: "github",
    scopes: ["notifications", "gists"], sign_in_again: true });
  provider.onEvent({ type: "command_rejected", request_id: commands[2].request_id, command: "set_plugin_sign_in_scopes",
    reason: "plugin", message: "Sign-in cancelled." });
  assert.deepEqual(settings.at(-1), { type: "pluginResult", name: "github", error: "Sign-in cancelled." });
  await provider.onSettingsMessage({ type: "signInAgain", name: "github", scopes: [] });
  provider.onEvent({ type: "plugin_catalog", request_id: commands[3].request_id, items: [{ name: "github", installed: true, opening: true }] });
  assert.equal(settings.some(m => m.type === "pluginResult" && !m.error && settings.indexOf(m) > settings.length - 3), false,
    "still signing in while the plugin is opening");
  provider.onEvent({ type: "plugin_catalog", request_id: commands[3].request_id, items: [{ name: "github", installed: true, connected: true }] });
  assert.ok(settings.some(m => m.type === "pluginResult" && m.name === "github" && !m.error), "then it is done");
  assert.equal(chat.filter(m => m.event?.type === "command_rejected").length, 0, "the chat never hears about it");
  provider.lastReadyEvent = { capabilities: { plugin_management: true, plugin_keys: true } };
  const sent = commands.length;
  await provider.onSettingsMessage({ type: "setPluginSignInScopes", name: "github", scopes: ["gists"] });
  await provider.onSettingsMessage({ type: "signInAgain", name: "github", scopes: ["gists"] });
  assert.equal(commands.length, sent, "a CLI without plugin_sign_in_scopes is never sent the command");
  assert.match(settings.at(-1).error, /can't choose what a sign-in may do yet\. Update it/);
});

test("Sign in with GitHub shows its code, copies it and opens GitHub only after the user agrees", async () => {
  // A device sign-in: dgc serve's own client sets the code (as it sets the loopback callback), so the editor opens
  // the page at once -- after saying the code, copying it, and the user choosing to go on.
  const api = globalThis.__DGC_TEST_VSCODE;
  const original = { Uri: api.Uri, env: api.env, info: api.window.showInformationMessage };
  const sent = [], opened = [], copied = [], asked = [], settings = [];
  let answer = "Copy code and open";
  api.Uri = { parse: value => new URL(value) };
  api.env = { remoteName: "ssh-remote", asExternalUri: async uri => uri, clipboard: { writeText: async text => { copied.push(text); } },
    openExternal: async uri => { opened.push(uri.toString()); return true; } };
  api.window.showInformationMessage = async (message, options, ...items) => { asked.push({ message, options, items }); return answer; };
  const { provider } = catalogHarness([]);
  provider.settingsCatalog = [{ name: "github", display_name: "GitHub", server_names: ["github"] }];
  provider.settingsEditor = { webview: { postMessage: m => settings.push(m) } };
  provider.backend = { ready: true, send: command => { sent.push(command); return true; } };
  const signIn = id => ({ type: "mcp_input_request", id, server: "github", kind: "elicitation",
    payload: { mode: "url", url: "https://github.com/login/device", message: "Enter the code WDJB-MJHT on the page that opens to sign in, then come back.",
      _dgc_device_code: "WDJB-MJHT" } });
  try {
    provider.onEvent(signIn("device"));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(asked[0].message, "Sign in to GitHub: enter the code WDJB-MJHT");
    assert.equal(asked[0].options.modal, true);
    assert.deepEqual(copied, ["WDJB-MJHT"]);
    assert.deepEqual(opened, ["https://github.com/login/device"], "no loopback to forward: it works over Remote SSH too");
    assert.deepEqual(settings[0], { type: "signin", title: "GitHub", host: "github.com", server: "github", id: "device", code: "WDJB-MJHT" });
    assert.deepEqual(sent.map(c => [c.type, c.action]), [["mcp_input_response", "accept"]]);
    answer = undefined;                                       // the user closed the dialog
    provider.onEvent(signIn("closed"));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(opened.length, 1, "nothing opens when the user doesn't go on");
    assert.deepEqual(sent.at(-1), { type: "mcp_input_response", id: "closed", action: "cancel" });
  } finally { api.Uri = original.Uri; api.env = original.env; api.window.showInformationMessage = original.info; }
});

test("a settings-side MCP save does not swallow a /mcp typed in chat", async () => {
  // The counter alone could not say which webview started the command, and it is held across a
  // request that may run for three minutes -- so a /mcp typed in chat during that window was
  // redirected to the settings tab and vanished entirely: no bubble, no Stop, no output, and no
  // error either, because a timeout is reported as this same event and main.js discards a result
  // whose request id it never recorded. The request id says who asked.
  const chat = [], settings = [];
  const { provider } = catalogHarness([]);
  provider.view = { webview: { postMessage: m => chat.push(m) } };
  provider.settingsEditor = { webview: { postMessage: m => settings.push(m) } };
  provider.settingsMcpOperation = 1;
  provider.post({ type: "mcp_command_started", requestId: "mcp-command-7", view: "context" });
  assert.deepEqual(settings, [], "a /mcp typed in chat is not the settings tab's business");
  assert.equal(chat.at(-1).requestId, "mcp-command-7", "it belongs to the chat that asked");
  chat.length = 0;
  provider.post({ type: "mcp_command_started", requestId: "mcp-config-3", view: "servers" });
  assert.equal(chat.some(m => m.type === "mcp_command_started"), false,
    "and the settings tab's own write does not flip the chat to the MCP surface");
  assert.equal(settings.at(-1).requestId, "mcp-config-3");
});

test("a new backend refreshes the settings tab without navigating it", async () => {
  // settingsSelection is written only when the USER opens settings, so re-posting it on a
  // handshake -- Restart Backend, crash recovery, or opening a second chat, none of which the user
  // aimed at this tab -- sent the page back to wherever settings was opened and took a half-typed
  // MCP server with it: navTo clears mcpEditing, and none of the mcp-* fields are in the snapshot
  // the other sections are restored from. The refresh a new backend genuinely owes must survive.
  const settings = [], commands = [];
  const h = restorationHarness();
  h.provider.settingsEditor = { reveal() {}, webview: { postMessage: m => settings.push(m) } };
  h.provider.ensureBackend = () => ({ send: m => { commands.push(m); return true; } });
  h.provider.lastReadyEvent = { capabilities: { plugin_management: true } };
  h.provider.openEditorSettings("mcp");
  settings.length = 0; commands.length = 0;
  h.provider.sessionRestoreSaved = false;
  h.provider.maybeCompleteHandshake(h.backend);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settings.some(m => m.type === "show"), false, "a handshake is not a navigation");
  assert.ok(commands.some(c => c.type === "get_config"), "but the new backend still refreshes it");
  assert.ok(commands.some(c => c.type === "list_mcp_servers"));
});

test("a rejection from the chat is not painted over the settings page", async () => {
  // The client's chain ends in a bare `section === 'mcp'`, so any forwarded rejection became a red
  // MCP-server banner -- over a page that was working, and it outlived leaving the section. Plugin
  // failures also arrived twice, once raw and once as pluginOperationError.
  const messages = [];
  const { provider } = catalogHarness([]);
  provider.settingsEditor = { webview: { postMessage: m => messages.push(m) } };
  provider.onEvent({ type: "command_rejected", command: "prompt", reason: "prompt_too_large",
                     message: "prompt exceeds the 1000000-character limit" });
  assert.deepEqual(messages, [], "a refused prompt is the chat's business");
  provider.onEvent({ type: "command_rejected", command: "upsert_mcp_server", message: "no" });
  assert.equal(messages.filter(m => m.type === "event").length, 1,
    "its own MCP write still reaches it");
  assert.equal(messages.at(-1).event.command, "upsert_mcp_server");
});

function mcpTransactionHarness(initialCatalog = []) {
  let catalog = JSON.parse(JSON.stringify(initialCatalog));
  const rawSecrets = new Map();
  const timeline = [];
  const commands = [];
  let requestHandler = async () => undefined;
  let globalFailures = 0;
  let secretFailure = undefined;
  const context = {
    subscriptions: [],
    globalState: {
      get: () => catalog,
      async update(_key, value) {
        timeline.push("global:update");
        if (globalFailures > 0) {
          globalFailures -= 1;
          throw new Error("synthetic GlobalState failure");
        }
        catalog = JSON.parse(JSON.stringify(value));
      },
    },
    secrets: {
      async get(key) { timeline.push(`secret:get:${key}`); return rawSecrets.get(key); },
      async store(key, value) {
        timeline.push(`secret:store:${key}`);
        if (secretFailure?.key === key && secretFailure?.action === "store") {
          secretFailure = undefined;
          throw new Error("synthetic MCP SecretStorage failure");
        }
        rawSecrets.set(key, value);
      },
      async delete(key) {
        timeline.push(`secret:delete:${key}`);
        if (secretFailure?.key === key && secretFailure?.action === "delete") {
          secretFailure = undefined;
          throw new Error("synthetic MCP SecretStorage failure");
        }
        rawSecrets.delete(key);
      },
    },
  };
  const backend = {
    ready: true,
    async request(command, responseType) {
      commands.push(JSON.parse(JSON.stringify(command)));
      timeline.push(`request:${command.type}:${command.name || ""}`);
      await requestHandler(command);
      timeline.push(`ack:${command.type}:${command.name || ""}`);
      return { type: responseType, seq: timeline.length, request_id: command.request_id };
    },
  };
  const provider = new DgcViewProvider(context);
  provider.lastReadyEvent={capabilities:{plugin_management:true,app_connectors:true}};
  provider.backend = backend;
  provider.correlatedStateRequests = true;
  return {
    provider, timeline, commands, rawSecrets,
    catalog: () => JSON.parse(JSON.stringify(catalog)),
    onRequest(handler) { requestHandler = handler; },
    failGlobal(count = 1) { globalFailures = count; },
    failSecret(action, key) { secretFailure = { action, key }; },
    clearEvidence() { timeline.length = 0; commands.length = 0; },
  };
}

function stdioMcp(name, target = "/usr/bin/example-mcp", args = ["--safe"], envNames = []) {
  return { name, transport: "stdio", target, args, envNames, logLevel: "warning" };
}

test("settings disconnect Kimi before lowering mode and persist secrets only after every ack", async () => {
  const { provider, timeline, commands, secretValues } = harness({ mode: "auto", engine: "kimi" });
  await provider.saveSettings(settings({
    mode: "default", subscription_engine: "", model: "new-native",
    base_url: "https://new.invalid/v1", api_key: "new-primary-secret",
    subagent_base_url: "https://worker.invalid/v1", subagent_api_key: "new-worker-secret",
  }));

  assert.deepEqual(requestTypes(timeline), ["set_config", "set_mode", "set_config", "set_model"]);
  assert.equal(commands[0].values.subscription_engine, "",
    "the acknowledged config command must disconnect Kimi before set_mode");
  const finalAck = timeline.lastIndexOf("ack:set_mode");
  const firstSecretMutation = timeline.findIndex((item) =>
    item.startsWith("secret:store:") || item.startsWith("secret:delete:"));
  assert.ok(finalAck !== -1 && firstSecretMutation > finalAck,
    "SecretStorage must remain unchanged until all backend settings are acknowledged");
  assert.equal(secretValues.get("dgc.apiKey"), "new-primary-secret");
  assert.equal(secretValues.get("dgc.apiKey.endpoint"), "https://new.invalid/v1");
  assert.equal(secretValues.get("dgc.subagentApiKey"), "new-worker-secret");
  assert.deepEqual(notices.info, ["DGC settings saved."]);
  assert.deepEqual(notices.errors, []);
});

test("the token cap goes only to a CLI that answered it, as a whole number of tokens", async () => {
  const older = harness();
  await older.provider.saveSettings(settings({ turn_token_budget: "2000000" }));
  assert.equal(older.commands.some((c) => c.type === "set_config" && "turn_token_budget" in (c.values || {})), false,
    "an older CLI refuses an unknown key, and the whole save with it");
  for (const [typed, sent] of [["2000000", 2000000], ["", 0], ["0", 0], ["-5", 0], ["1500.7", 1500], ["9e12", 1000000000]]) {
    const { provider, commands } = harness();
    provider.onEvent({ type: "config", model: "m", mode: "default", turn_token_budget: 0 });
    await provider.saveSettings(settings({ turn_token_budget: typed }));
    const config = commands.find((c) => c.type === "set_config" && "turn_token_budget" in (c.values || {}));
    assert.equal(config?.values.turn_token_budget, sent, typed);
  }
});

test("the cache lifetime and keep-loaded time go only to a CLI that answered cache_settings", async () => {
  const sent = (commands, key) => commands.filter((c) => c.type === "set_config" && key in (c.values || {}));
  const older = harness();
  await older.provider.saveSettings(settings({ prompt_cache_ttl: "1h", ollama_keep_alive: "4h" }));
  assert.deepEqual(sent(older.commands, "prompt_cache_ttl"), [], "an older CLI refuses an unknown key, and the whole save with it");
  assert.deepEqual(sent(older.commands, "ollama_keep_alive"), []);
  const { provider, commands } = harness();
  provider.onEvent({ type: "cache_settings", prompt_cache: true, prompt_cache_ttl: "5m", ollama_keep_alive: "30m" });
  await provider.saveSettings(settings({ prompt_cache_ttl: "1h", ollama_keep_alive: "4h" }));
  assert.equal(sent(commands, "prompt_cache_ttl")[0]?.values.prompt_cache_ttl, "1h");
  assert.equal(sent(commands, "ollama_keep_alive")[0]?.values.ollama_keep_alive, "4h");
  const bad = harness();
  bad.provider.onEvent({ type: "cache_settings", prompt_cache: true, prompt_cache_ttl: "5m", ollama_keep_alive: "30m" });
  await bad.provider.saveSettings(settings({ prompt_cache_ttl: "2 days", ollama_keep_alive: "forever" }));
  assert.deepEqual(sent(bad.commands, "prompt_cache_ttl"), [], "only a lifetime the CLI takes");
  assert.deepEqual(sent(bad.commands, "ollama_keep_alive"), [], "only a duration Ollama takes");
});

test("settings cancellation happens before backend or SecretStorage mutation", async () => {
  const { provider, timeline } = harness({ mode: "default", engine: "codex" });
  notices.warningResponses.push(undefined);
  await provider.saveSettings(settings({
    mode: "auto", subscription_engine: "codex", api_key: "must-not-store",
    base_url: "https://new.invalid/v1", model: "must-not-apply",
  }));

  assert.deepEqual(requestTypes(timeline), []);
  assert.deepEqual(secretMutations(timeline), []);
  assert.deepEqual(notices.info, []);
  assert.equal(notices.warnings.length, 1);
});

test("Ultra profile is acknowledged independently from permission mode and normal effort", async () => {
  const { provider, timeline, commands } = harness({ mode: "default", engine: "codex" });
  await provider.setReasoningProfile("ultra");
  assert.deepEqual(requestTypes(timeline), ["set_config"]);
  assert.deepEqual(commands[0].values, { ultra_mode: true });
  assert.equal(commands.some((command) => command.type === "set_mode"), false,
    "Ultra must never elevate the permission mode");

  timeline.length = 0; commands.length = 0;
  provider.state.ultra = true;
  await provider.setReasoningProfile("high");
  assert.deepEqual(requestTypes(timeline), ["set_config", "set_config"]);
  assert.deepEqual(commands[0].values, { ultra_mode: false });
  assert.deepEqual(commands[1].values, { subscription_effort: "high" });
});

test("context compaction waits for a correlated outcome and reports busy/failure state", async () => {
  const ok = harness();
  const posted = [];
  ok.provider.post = (message) => posted.push(message);
  await ok.provider.compactContext();
  assert.deepEqual(requestTypes(ok.timeline), ["compact"]);
  assert.equal(ok.commands[0].request_id.startsWith("compact-"), true);
  assert.deepEqual(posted.map((message) => [message.type, message.state]), [
    ["compact_state", "working"], ["compact_state", "idle"],
  ]);

  const rejected = harness({ rejectType: "compact" });
  const rejectedPosts = [];
  rejected.provider.post = (message) => rejectedPosts.push(message);
  await rejected.provider.compactContext();
  assert.match(rejectedPosts.at(-1).error, /synthetic compact rejection/);

  const busy = harness();
  const busyPosts = [];
  busy.provider.post = (message) => busyPosts.push(message);
  busy.provider.turnActive = true;
  await busy.provider.compactContext();
  assert.deepEqual(requestTypes(busy.timeline), []);
  assert.match(busyPosts.at(-1).error, /current turn is complete/);
});

test("a rejected elevation reports the already-applied config and never claims success", async () => {
  const { provider, timeline } = harness({ mode: "default", engine: "codex",
                                          rejectType: "set_mode" });
  await provider.saveSettings(settings({
    mode: "acceptEdits", subscription_engine: "codex",
  }));

  assert.deepEqual(requestTypes(timeline), ["set_config", "set_mode"]);
  assert.deepEqual(secretMutations(timeline), []);
  assert.deepEqual(notices.info, []);
  assert.match(notices.errors.at(-1) || "", /synthetic set_mode rejection/);
  assert.match(notices.warnings.at(-1) || "", /applied configuration/);
});

test("settings enter auto before connecting Kimi", async () => {
  const { provider, timeline } = harness({ mode: "default", engine: "codex", trusted: true });
  notices.warningResponses.push("Enable auto");
  await provider.saveSettings(settings({ mode: "auto", subscription_engine: "kimi" }));

  assert.deepEqual(requestTypes(timeline), ["set_config", "set_mode", "set_config"]);
  assert.deepEqual(notices.info, ["DGC settings saved."]);
  assert.deepEqual(notices.errors, []);
});

test("sandbox rejection cannot elevate mode or persist workspace trust", async () => {
  const { provider, timeline, commands, backendState } = harness({ mode: "default", engine: "codex",
    trusted: false, rejectSandbox: true });
  notices.warningResponses.push("Trust and enable");
  await provider.saveSettings(settings({
    mode: "auto", subscription_engine: "codex", sandbox: true,
    model: "must-not-apply", base_url: "https://new.invalid/v1", api_key: "must-not-store",
  }));

  assert.deepEqual(requestTypes(timeline), ["set_config"]);
  assert.equal(commands.some((command) => command.type === "set_mode"), false,
    "set_mode and acknowledge_workspace_trust must remain unsent after config rejection");
  assert.deepEqual(backendState(), { mode: "default", engine: "codex", trusted: false });
  assert.deepEqual(secretMutations(timeline), []);
  assert.deepEqual(notices.info, []);
  assert.match(notices.errors.at(-1) || "", /sandbox remains off/);
});

test("a restrictive mode takes effect before later fallible config", async () => {
  const { provider, timeline, backendState } = harness({ mode: "auto", engine: "codex",
    trusted: true, rejectSandbox: true });
  await provider.saveSettings(settings({
    mode: "plan", subscription_engine: "codex", sandbox: true,
  }));

  assert.deepEqual(requestTypes(timeline), ["set_mode", "set_config"]);
  assert.equal(backendState().mode, "plan",
    "a failed secondary setting must not strand the user in the more permissive prior mode");
  assert.deepEqual(notices.info, []);
  assert.match(notices.errors.at(-1) || "", /permission mode.*sandbox remains off/s);
});

test("a config rejection leaves provider secrets untouched", async () => {
  const initial = {
    "dgc.apiKey": "old-secret",
    "dgc.apiKey.endpoint": "https://old.invalid/v1",
  };
  const { provider, timeline, secretValues } = harness({ rejectType: "set_config",
                                                         initialSecrets: initial });
  await provider.saveSettings(settings({
    model: "new-native", base_url: "https://new.invalid/v1", api_key: "new-secret",
  }));

  assert.deepEqual(requestTypes(timeline), ["set_config"]);
  assert.deepEqual(secretMutations(timeline), []);
  assert.equal(secretValues.get("dgc.apiKey"), "old-secret");
  assert.equal(secretValues.get("dgc.apiKey.endpoint"), "https://old.invalid/v1");
  assert.deepEqual(notices.info, []);
  assert.match(notices.errors.at(-1) || "", /synthetic set_config rejection/);
});

test("a partial SecretStorage failure restores its exact prior bindings", async () => {
  const initial = {
    "dgc.apiKey": "old-secret",
    "dgc.apiKey.endpoint": "https://old.invalid/v1",
  };
  const { provider, secretValues } = harness({ initialSecrets: initial,
    failSecretStoreOnce: "dgc.apiKey.endpoint" });
  await provider.saveSettings(settings({
    model: "new-native", base_url: "https://new.invalid/v1", api_key: "new-secret",
  }));

  assert.equal(secretValues.get("dgc.apiKey"), "old-secret");
  assert.equal(secretValues.get("dgc.apiKey.endpoint"), "https://old.invalid/v1");
  assert.deepEqual(notices.info, []);
  assert.match(notices.errors.at(-1) || "", /synthetic SecretStorage failure/);
});

test("a provider endpoint mismatch fails closed without erasing the prior bound secret", async () => {
  const initial = {
    "dgc.apiKey": "old-secret",
    "dgc.apiKey.endpoint": "https://old.invalid/v1",
  };
  const { provider, secretValues, timeline } = harness({ initialSecrets: initial });

  assert.equal(await provider.storedSecret("apiKey", "https://new.invalid/v1"), "");
  assert.equal(secretValues.get("dgc.apiKey"), "old-secret");
  assert.equal(secretValues.get("dgc.apiKey.endpoint"), "https://old.invalid/v1");
  assert.deepEqual(secretMutations(timeline), []);
  assert.equal(await provider.storedSecret("apiKey", "https://old.invalid/v1"), "old-secret");
});

test("legacy user credentials bind to the user endpoint, never a workspace override", async () => {
  configurationInspections = {
    apiKey: { globalValue: "legacy-user-secret" },
    baseUrl: {
      globalValue: "https://user.invalid/v1",
      workspaceValue: "https://repository.invalid/v1",
    },
  };
  const { provider, secretValues } = harness();

  assert.equal(await provider.storedSecret("apiKey", "https://repository.invalid/v1"), "");
  assert.equal(secretValues.get("dgc.apiKey"), "legacy-user-secret");
  assert.equal(secretValues.get("dgc.apiKey.endpoint"), "https://user.invalid/v1");
  assert.equal(await provider.storedSecret("apiKey", "https://user.invalid/v1"),
    "legacy-user-secret");
});

test("persisted MCP migration keeps only credential-free canonical remote bridge entries", () => {
  const remote = (name, target, extras = {}) => ({
    name, transport: "remote", target, args: [], envNames: [], logLevel: "warning", ...extras,
  });
  const catalog = [
    remote("secure", "https://mcp.example.invalid/rpc"),
    remote("loopback", "http://127.0.0.1:7331/rpc"),
    remote("plain-http", "http://mcp.example.invalid/rpc"),
    remote("userinfo", "https://user:password@mcp.example.invalid/rpc"),
    remote("query-secret", "https://mcp.example.invalid/rpc?api-key=sentinel"),
    remote("prefixed-query-secret", "https://mcp.example.invalid/rpc?x-api-key=sentinel"),
    remote("client-query-secret", "https://mcp.example.invalid/rpc?client_secret=sentinel"),
    remote("auth-query-token", "https://mcp.example.invalid/rpc?auth_token=sentinel"),
    remote("bearer-query-token", "https://mcp.example.invalid/rpc?bearer_token=sentinel"),
    remote("fragment-token", "https://mcp.example.invalid/rpc#access_token=sentinel"),
    remote("fragment-client-secret",
      "https://mcp.example.invalid/rpc#/callback?client_secret=sentinel"),
    remote("custom-argv", "https://mcp.example.invalid/rpc", { args: ["--header"] }),
    remote("persisted-env", "https://mcp.example.invalid/rpc", { envNames: ["TOKEN"] }),
    { name: "compact-env", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["-eTOKEN=value"], envNames: [], logLevel: "warning" },
    { name: "ambient-compact-env", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["-eTOKEN"], envNames: [], logLevel: "warning" },
    { name: "env-file", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["--env-file=private.env"], envNames: [], logLevel: "warning" },
    { name: "compact-user", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["-uuser:password"], envNames: [], logLevel: "warning" },
    { name: "long-user", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["--user=user:password"], envNames: [], logLevel: "warning" },
    { name: "client-secret", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["--client-secret=value"], envNames: [], logLevel: "warning" },
    { name: "normalized-secret-flag", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["--client.secret=value"], envNames: [], logLevel: "warning" },
    { name: "refresh-token", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["--refresh_token", "value"], envNames: [], logLevel: "warning" },
    { name: "prefixed-api-key", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["--x-api-key=value"], envNames: [], logLevel: "warning" },
    { name: "auth-token", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["--auth_token", "value"], envNames: [], logLevel: "warning" },
    { name: "bearer-token", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["--bearer_token=value"], envNames: [], logLevel: "warning" },
    { name: "fragment-token-argument", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["--endpoint=https://mcp.example.invalid/rpc#access_token=sentinel"],
      envNames: [], logLevel: "warning" },
    { name: "secret-assignment", transport: "stdio", target: "/usr/bin/example-mcp",
      args: ["DGC_TOKEN=value"], envNames: [], logLevel: "warning" },
    { name: "stdio", transport: "stdio", target: "/usr/bin/example-mcp", args: ["--safe"],
      envNames: ["SAFE_NAME"], logLevel: "info" },
  ];
  const { provider, updates } = catalogHarness(catalog);
  const safe = provider.managedMcpServers();

  assert.deepEqual(safe.map((entry) => entry.name), ["secure", "loopback", "stdio"]);
  assert.deepEqual(safe[0].args, []);
  assert.deepEqual(safe[0].envNames, []);
  assert.equal(updates.length, 1, "an unsafe persisted catalog must be rewritten durably");
  assert.deepEqual(updates[0].value, safe);
});

test("persisted MCP migration durably prunes a valid tail beyond 64 entries", () => {
  const catalog = Array.from({ length: 65 }, (_unused, index) => ({
    name: `server-${index}`, transport: "stdio", target: "/usr/bin/example-mcp",
    args: [], envNames: [], logLevel: "warning",
  }));
  const { provider, updates } = catalogHarness(catalog);
  const safe = provider.managedMcpServers();

  assert.equal(safe.length, 64);
  assert.equal(safe.at(-1).name, "server-63");
  assert.equal(updates.length, 1,
    "the full stored catalog, not merely its first 64 entries, must participate in migration");
  assert.equal(updates[0].value.length, 64);
  assert.equal(updates[0].value.some((entry) => entry.name === "server-64"), false);
});

test("managed MCP secrets replay only across an exact public identity", async () => {
  const item = {
    name: "remote", transport: "remote", target: "https://one.example.invalid/rpc",
    args: [], envNames: [], logLevel: "warning",
  };
  const h = mcpTransactionHarness([item]);
  await h.provider.storeMcpSecrets(item, { token: "private-token" });
  h.clearEvidence();
  await h.provider.sendManagedMcp(h.provider.backend, item, false, undefined, true);
  assert.equal(h.commands[0].runtime.auth_env, "DGC_MCP_BEARER_TOKEN");
  assert.equal(h.commands[0].runtime.env.DGC_MCP_BEARER_TOKEN, "private-token");

  const changed = { ...item, target: "https://two.example.invalid/rpc" };
  await h.provider.sendManagedMcp(h.provider.backend, changed, false, undefined, true);
  const changedCommand = h.commands.at(-1);
  assert.equal("auth_env" in changedCommand.runtime, false);
  assert.deepEqual(changedCommand.runtime.env, {});
  assert.equal(changedCommand.runtime.args.includes("--header"), false);
  assert.equal(h.rawSecrets.has("dgc.mcp.remote"), false,
    "a same-name target change must delete rather than replay the old token");

  h.rawSecrets.set("dgc.mcp.remote", JSON.stringify({ token: "legacy-token", env: {} }));
  await h.provider.sendManagedMcp(h.provider.backend, item, false, undefined, true);
  assert.equal("auth_env" in h.commands.at(-1).runtime, false);
  assert.equal(h.rawSecrets.has("dgc.mcp.remote"), false,
    "legacy name-only records must fail closed instead of gaining an identity implicitly");

  h.rawSecrets.set("dgc.mcp.remote", "{malformed-json");
  await h.provider.sendManagedMcp(h.provider.backend, item, false, undefined, true);
  assert.equal("auth_env" in h.commands.at(-1).runtime, false);
  assert.equal(h.rawSecrets.has("dgc.mcp.remote"), false,
    "malformed SecretStorage records must be purged rather than repeatedly retained");
});

test("your own OAuth app: the client file is owner-only, the secret stays out of argv and settings, and blank keeps it", async () => {
  const home = mkdtempSync(join(scratch, "oauth-home-")), priorHome = process.env.HOME;
  process.env.HOME = home;
  const dir = join(home, ".dgc", "mcp-oauth"), fsm = await import("node:fs");
  const files = () => { try { return fsm.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; } };
  const only = () => { const list = files(); assert.equal(list.length, 1, `one file: ${list}`); return join(dir, list[0]); };
  const save = (h, extra) => h.provider.saveMcpServer({ name: "asana", transport: "remote", target: "https://mcp.asana.com/v2/mcp",
    log_level: "warning", oauth_port: "3334", ...extra });
  try {
    const h = mcpTransactionHarness([]);
    await save(h, { oauth_client_id: "1209876543210", oauth_client_secret: "s3cr3t-value" });
    const file = only();
    const upsert = h.commands.find((c) => c.type === "upsert_mcp_server");
    assert.deepEqual(upsert.persisted.args, ["-y", "mcp-remote", "https://mcp.asana.com/v2/mcp", "3334", "--static-oauth-client-info", "@" + file]);
    assert.equal(JSON.stringify(upsert).includes("s3cr3t-value"), false, "the secret never travels in argv or the saved spec");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { client_id: "1209876543210", client_secret: "s3cr3t-value",
      redirect_uris: ["http://localhost:3334/oauth/callback"] });
    assert.equal(fsm.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(h.catalog()[0].oauth, { clientId: "1209876543210", port: 3334 });
    assert.equal(JSON.stringify(h.catalog()).includes("s3cr3t"), false, "settings keep the public client id only");
    assert.match(h.rawSecrets.get("dgc.mcp.asana") || "", /s3cr3t-value/, "the secret is in SecretStorage");
    await save(h, { original_name: "asana", oauth_client_id: "1209876543210", oauth_client_secret: "" });
    assert.equal(JSON.parse(readFileSync(only(), "utf8")).client_secret, "s3cr3t-value", "blank keeps the saved secret");
    await save(h, { original_name: "asana", oauth_client_id: "999", oauth_client_secret: "" });
    assert.equal("client_secret" in JSON.parse(readFileSync(only(), "utf8")), false, "another app never inherits the secret");
    await save(h, { original_name: "asana", oauth_client_id: "999", oauth_client_secret: "second" });
    await h.provider.saveMcpServer({ original_name: "asana", name: "asana", transport: "remote", target: "https://other.example.com/mcp",
      log_level: "warning", oauth_client_id: "999", oauth_client_secret: "", oauth_port: "3334" });
    assert.equal("client_secret" in JSON.parse(readFileSync(only(), "utf8")), false, "a new server URL never gets the old secret");
    await h.provider.saveMcpServer({ original_name: "asana", name: "asana", transport: "remote", target: "https://other.example.com/mcp",
      log_level: "warning", oauth_client_id: "", oauth_port: "" });
    assert.deepEqual(files(), [], "clearing the client id removes its file");
    await save(h, { name: "bad", oauth_client_id: "abc", oauth_port: "80" });
    assert.match(notices.errors.at(-1) || "", /callback port from 1024 to 65535/);
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  }
});

test("busy MCP removal leaves GlobalState and SecretStorage untouched", async () => {
  const item = stdioMcp("old", "/usr/bin/old-mcp", ["--safe"], ["TOKEN"]);
  const h = mcpTransactionHarness([item]);
  await h.provider.storeMcpSecrets(item, { env: { TOKEN: "old-value" } });
  const priorRaw = h.rawSecrets.get("dgc.mcp.old");
  h.clearEvidence();
  h.onRequest(async (command) => {
    if (command.type === "remove_mcp_server") { throw new Error("server mutation is busy"); }
  });
  notices.warningResponses.push("Remove server");
  await h.provider.removeMcpServer("old");

  assert.deepEqual(h.commands.map((command) => command.type), ["remove_mcp_server"]);
  assert.deepEqual(h.catalog(), [item]);
  assert.equal(h.rawSecrets.get("dgc.mcp.old"), priorRaw);
  assert.equal(h.timeline.includes("global:update"), false);
  assert.match(notices.errors.at(-1) || "", /mutation is busy/);
});

test("MCP removal SecretStorage failure restores the acknowledged backend removal", async () => {
  const item = stdioMcp("old", "/usr/bin/old-mcp", ["--safe"], ["TOKEN"]);
  const h = mcpTransactionHarness([item]);
  await h.provider.storeMcpSecrets(item, { env: { TOKEN: "old-value" } });
  const priorRaw = h.rawSecrets.get("dgc.mcp.old");
  h.clearEvidence();
  h.failSecret("delete", "dgc.mcp.old");
  notices.warningResponses.push("Remove server");
  await h.provider.removeMcpServer("old");

  assert.deepEqual(h.commands.map((command) => [command.type, command.name]), [
    ["remove_mcp_server", "old"], ["upsert_mcp_server", "old"],
  ]);
  assert.deepEqual(h.catalog(), [item]);
  assert.equal(h.rawSecrets.get("dgc.mcp.old"), priorRaw);
  assert.match(notices.errors.at(-1) || "", /server and its prior local settings were restored/);
});

test("rejected MCP rename removes its staged backend name before touching local storage", async () => {
  const oldItem = stdioMcp("old", "/usr/bin/old-mcp");
  const h = mcpTransactionHarness([oldItem]);
  h.clearEvidence();
  let rejectedOld = false;
  h.onRequest(async (command) => {
    if (command.type === "remove_mcp_server" && command.name === "old" && !rejectedOld) {
      rejectedOld = true;
      throw new Error("server mutation is busy");
    }
  });
  await h.provider.saveMcpServer({
    original_name: "old", name: "new", transport: "stdio",
    target: "/usr/bin/new-mcp", args: "--safe", log_level: "warning",
  });

  assert.deepEqual(h.commands.map((command) => [command.type, command.name]), [
    ["upsert_mcp_server", "new"], ["remove_mcp_server", "old"],
    ["remove_mcp_server", "new"],
  ]);
  assert.deepEqual(h.catalog(), [oldItem]);
  assert.equal(h.timeline.includes("global:update"), false);
  assert.match(notices.errors.at(-1) || "", /local settings were not changed/);
});

test("MCP rename refuses to overwrite another managed server name", async () => {
  const oldItem = stdioMcp("old", "/usr/bin/old-mcp");
  const destination = stdioMcp("destination", "/usr/bin/destination-mcp");
  const h = mcpTransactionHarness([oldItem, destination]);
  await h.provider.saveMcpServer({
    original_name: "old", name: "destination", transport: "stdio",
    target: "/usr/bin/replacement-mcp", args: "--safe", log_level: "warning",
  });

  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.catalog(), [oldItem, destination]);
  assert.equal(h.timeline.includes("global:update"), false);
  assert.match(notices.errors.at(-1) || "", /already exists/);
});

test("MCP rename cleanup failure restores both names and exact local secrets", async () => {
  const oldItem = stdioMcp("old", "/usr/bin/old-mcp", ["--safe"], ["TOKEN"]);
  const h = mcpTransactionHarness([oldItem]);
  await h.provider.storeMcpSecrets(oldItem, { env: { TOKEN: "old-value" } });
  const priorRaw = h.rawSecrets.get("dgc.mcp.old");
  h.clearEvidence();
  h.failSecret("delete", "dgc.mcp.old");
  await h.provider.saveMcpServer({
    original_name: "old", name: "new", transport: "stdio", target: "/usr/bin/old-mcp",
    args: "--safe", env_names: ["TOKEN"], log_level: "warning",
  });

  assert.deepEqual(h.commands.map((command) => [command.type, command.name]), [
    ["upsert_mcp_server", "new"], ["remove_mcp_server", "old"],
    ["remove_mcp_server", "new"], ["upsert_mcp_server", "old"],
  ]);
  assert.deepEqual(h.catalog(), [oldItem]);
  assert.equal(h.rawSecrets.get("dgc.mcp.old"), priorRaw);
  assert.equal(h.rawSecrets.has("dgc.mcp.new"), false);
  assert.match(notices.errors.at(-1) || "", /prior MCP settings were restored/);
});

test("MCP GlobalState failure compensates the acknowledged backend upsert", async () => {
  const h = mcpTransactionHarness([]);
  h.failGlobal();
  await h.provider.saveMcpServer({
    name: "fresh", transport: "stdio", target: "/usr/bin/fresh-mcp",
    args: "--safe", log_level: "warning",
  });

  assert.deepEqual(h.commands.map((command) => [command.type, command.name]), [
    ["upsert_mcp_server", "fresh"], ["remove_mcp_server", "fresh"],
  ]);
  assert.deepEqual(h.catalog(), []);
  assert.match(notices.errors.at(-1) || "", /prior MCP settings were restored/);
});

test("MCP SecretStorage failure restores local records and the prior backend definition", async () => {
  const item = stdioMcp("old", "/usr/bin/old-mcp", ["--safe"], ["TOKEN"]);
  const h = mcpTransactionHarness([item]);
  await h.provider.storeMcpSecrets(item, { env: { TOKEN: "old-value" } });
  const priorRaw = h.rawSecrets.get("dgc.mcp.old");
  h.clearEvidence();
  h.failSecret("store", "dgc.mcp.old");
  await h.provider.saveMcpServer({
    original_name: "old", name: "old", transport: "stdio", target: "/usr/bin/old-mcp",
    args: "--safe", env: "TOKEN=new-value", log_level: "warning",
  });

  assert.deepEqual(h.commands.map((command) => [command.type, command.name]), [
    ["upsert_mcp_server", "old"], ["upsert_mcp_server", "old"],
  ]);
  assert.deepEqual(h.catalog(), [item]);
  assert.equal(h.rawSecrets.get("dgc.mcp.old"), priorRaw);
  assert.match(notices.errors.at(-1) || "", /prior MCP settings were restored/);
});

test("the prompt carries diagnostics for every file this chat touched, not only the focused one", () => {
  // After editing five files the agent could not see the errors it had just created: only the
  // active editor's diagnostics were ever sent. This drives the real collector.
  const vs = globalThis.__DGC_TEST_VSCODE;
  const uriFor = (p) => ({fsPath: p, scheme: "file", toString: () => `file://${p}`});
  const range = {start: {line: 3, character: 2}, end: {line: 3, character: 9}};
  const diag = (message, severity) => ({message, severity, source: "ts", code: "1", range});
  const perFile = {
    [`file://${scratch}/active.ts`]: [diag("active is broken", 0)],
    [`file://${scratch}/edited-one.ts`]: [diag("the agent broke this", 0), diag("and warned here", 1)],
    [`file://${scratch}/edited-two.ts`]: [diag("only a hint", 3)],
  };
  const saved = {Uri: vs.Uri, languages: vs.languages, DiagnosticSeverity: vs.DiagnosticSeverity,
                 activeTextEditor: vs.window.activeTextEditor, tabGroups: vs.window.tabGroups,
                 getWorkspaceFolder: vs.workspace.getWorkspaceFolder, asRelativePath: vs.workspace.asRelativePath};
  try {
    vs.Uri = {file: uriFor, parse: uriFor};
    vs.DiagnosticSeverity = {Error: 0, Warning: 1, Information: 2, Hint: 3,
                             0: "Error", 1: "Warning", 2: "Information", 3: "Hint"};
    vs.languages = {getDiagnostics: (uri) => perFile[uri.toString()] || []};
    vs.window.activeTextEditor = {
      document: {uri: uriFor(`${scratch}/active.ts`), languageId: "typescript", getText: () => ""},
      selection: {isEmpty: true, start: {line: 0}, end: {line: 0}},
    };
    vs.window.tabGroups = {all: []};
    vs.workspace.getWorkspaceFolder = () => ({name: "fixture"});
    vs.workspace.asRelativePath = (uri) => String(uri.fsPath).replace(`${scratch}/`, "");
    const provider = new DgcViewProvider({subscriptions: [], globalState: {get() {}, update() {}},
                                          workspaceState: {get() {}, update() {}}, secrets: {get: async () => undefined}});
    provider.chatChanges = [
      {path: "edited-one.ts", root: scratch}, {path: "edited-two.ts", root: scratch},
      {path: "untouched-by-errors.ts", root: scratch},
    ];
    const diagnostics = provider.editorContext().filter((r) => r.type === "diagnostics");
    const files = diagnostics.map((d) => d.relative_path).sort();
    assert.deepEqual(files, ["active.ts", "edited-one.ts"],
      "the focused file plus the touched files that actually have errors or warnings");
    const edited = diagnostics.find((d) => d.relative_path === "edited-one.ts");
    assert.equal(edited.diagnostics.length, 2);
    assert.equal(edited.diagnostics[0].message, "the agent broke this");
    assert.equal(edited.diagnostics[0].severity, "Error");
    assert.ok(!diagnostics.some((d) => d.relative_path === "edited-two.ts"),
      "a hint is not an error the agent made");
  } finally {
    vs.Uri = saved.Uri; vs.languages = saved.languages; vs.DiagnosticSeverity = saved.DiagnosticSeverity;
    vs.window.activeTextEditor = saved.activeTextEditor; vs.window.tabGroups = saved.tabGroups;
    vs.workspace.getWorkspaceFolder = saved.getWorkspaceFolder;
    vs.workspace.asRelativePath = saved.asRelativePath;
  }
});

test("files dropped into the chat attach as mentions, and non-file drops are ignored", () => {
  const vs = globalThis.__DGC_TEST_VSCODE;
  const saved = {Uri: vs.Uri, workspace: vs.workspace, commands: vs.commands};
  try {
    vs.Uri = {parse: (raw) => {
      const text = String(raw);
      if (!text.startsWith("file://") && !text.startsWith("untitled:")) { throw new Error("bad uri"); }
      return {fsPath: text.replace(/^file:\/\//, ""), scheme: text.split(":")[0], toString: () => text};
    }};
    vs.workspace = {...saved.workspace, getWorkspaceFolder: () => ({name: "fixture"}),
                    asRelativePath: (uri) => String(uri.fsPath).replace(`${scratch}/`, "")};
    vs.commands = {executeCommand: () => Promise.resolve()};
    const provider = new DgcViewProvider({subscriptions: [], globalState: {get() {}, update() {}},
                                          workspaceState: {get() {}, update() {}}, secrets: {get: async () => undefined}});
    const posted = [];
    provider.post = (msg) => posted.push(msg);
    provider.webviewReady = true;
    provider.focus = () => {};
    // onMessage resolves a backend first. Without this stub the test spawned the real `dgc` on
    // PATH (with the real HOME), and a well-behaved `dgc serve` that waits on its stdin kept the
    // test process alive after the last assertion.
    provider.ensureBackend = () => ({ ready: true, send: () => true });
    provider.onMessage({type: "drop_uris", uris: [
      `file://${scratch}/dropped.ts`, "untitled:Untitled-1", "not a uri at all",
    ]});
    const attachments = posted.filter((m) => m.type === "attach");
    assert.equal(attachments.length, 1, "only the real file attaches");
    assert.equal(attachments[0].resource.type, "file_mention");
    assert.equal(attachments[0].label, "dropped.ts");
    assert.equal(attachments[0].resource.path, `${scratch}/dropped.ts`);
  } finally {
    Object.assign(vs, saved);
  }
});

test("saving an unrelated setting does not ask to move the model route", async () => {
  // The settings form posts every field, so base_url/api_key/model arrive on every Save whether or
  // not they were touched. Sending set_model on presence meant raising the context window during a
  // run was refused by the backend -- set_model is a busy mutation, and rightly so.
  const { provider, timeline, commands } = harness();
  await provider.saveSettings(settings({
    model: "native-model", base_url: "https://old.invalid/v1", context_size: 1048576,
  }));

  assert.deepEqual(requestTypes(timeline), ["set_config"],
    "an unchanged route must not be re-sent");
  assert.equal(commands[0].values.context_size, 1048576,
    "and the setting the user actually moved is applied");
  assert.deepEqual(notices.errors, []);
});

test("a model the user really changed still moves the route", async () => {
  const { provider, timeline, commands } = harness();
  await provider.saveSettings(settings({
    model: "a-different-model", base_url: "https://old.invalid/v1",
  }));

  assert.deepEqual(requestTypes(timeline), ["set_config", "set_model"]);
  assert.equal(commands.at(-1).model, "a-different-model");
  assert.deepEqual(notices.errors, []);
});

test("a new endpoint or a new key still moves the route", async () => {
  const moved = harness();
  await moved.provider.saveSettings(settings({
    model: "native-model", base_url: "https://elsewhere.invalid/v1",
  }));
  assert.ok(requestTypes(moved.timeline).includes("set_model"), "a changed host is a route change");

  const rekeyed = harness();
  await rekeyed.provider.saveSettings(settings({
    model: "native-model", base_url: "https://old.invalid/v1", api_key: "a-new-secret",
  }));
  assert.ok(requestTypes(rekeyed.timeline).includes("set_model"), "a new key is a route change");
});

test("returning to the other copy of the chat adopts it instead of leaving a dead notice", () => {
  // VS Code keeps both copies alive and resolves a view only once, so the twin stamped with the
  // "moved" notice used to sit on that dead end forever -- including when it was the only chat on
  // screen. Whichever copy the user looks at has to become the live one.
  const vs = globalThis.__DGC_TEST_VSCODE;
  const savedUri = vs.Uri;
  try {
    vs.Uri = { joinPath: (...parts) => ({ fsPath: parts.map(String).join("/") }),
      file: value => ({ fsPath: value }) };
    const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.25.1", dgcCliVersion: "0.40.1" } },
      extensionUri: { fsPath: "/ext" }, subscriptions: [],
      globalState: { get() {}, async update() {} },
      workspaceState: { get() {}, async update() {} },
    });
    provider.ensureBackend = () => ({ ready: true, request: async () => ({}) });
    const makeView = (viewType) => {
      const onVisible = [];
      const onDispose = [];
      return {
        viewType, visible: true, show() {},
        webview: {
          options: {}, html: "", cspSource: "vscode-webview:",
          asWebviewUri: (uri) => ({ toString: () => String(uri.fsPath) }),
          onDidReceiveMessage() {},
        },
        onDidChangeVisibility(fn) { onVisible.push(fn); },
        // Real: WebviewView.onDidDispose fires when the user UNCHECKS the view. Provided here
        // rather than called optionally in the panel, so a genuinely missing API still throws.
        onDidDispose(fn) { onDispose.push(fn); },
        dispose() { onDispose.forEach((fn) => fn()); },
        becomeVisible() { this.visible = true; onVisible.forEach((fn) => fn()); },
      };
    };
    const activity = makeView("dgc.chat");
    const secondary = makeView("dgc.chatSecondary");

    provider.resolveWebviewView(activity);
    assert.match(activity.webview.html, /id="input"/, "the first copy is the real chat");

    provider.resolveWebviewView(secondary);
    assert.match(activity.webview.html, /stays out of the way/,
      "the copy left behind says where the conversation went");

    secondary.visible = false;
    activity.becomeVisible();
    assert.match(activity.webview.html, /id="input"/,
      "coming back to it makes it the chat again");
    assert.match(secondary.webview.html, /stays out of the way/,
      "and the one now left behind carries the notice");
  } finally {
    vs.Uri = savedUri;
  }
});

test("unchecking the chat view tells every backend the panel is gone, and stops none of them", () => {
  // The backend decides a takeover from what the CHAT PANEL says is on screen, because an extension
  // host left behind by a window reload keeps insisting all is well and nothing in the VS Code API
  // tells it otherwise. Unchecking the view is the one case where a live window legitimately has no
  // panel, so it is also the one honest statement the host can make -- and it must not be mistaken
  // for the window closing: closing the view has never stopped the backend and still must not.
  const vs = globalThis.__DGC_TEST_VSCODE;
  const savedUri = vs.Uri;
  try {
    vs.Uri = { joinPath: (...parts) => ({ fsPath: parts.map(String).join("/") }),
      file: value => ({ fsPath: value }) };
    const provider = new DgcViewProvider({
      extension: { packageJSON: { version: "0.25.1", dgcCliVersion: "0.40.1" } },
      extensionUri: { fsPath: "/ext" }, subscriptions: [],
      globalState: { get() {}, async update() {} },
      workspaceState: { get() {}, async update() {} },
    });
    const recorder = (name) => ({
      name, states: [], stopped: 0,
      editorState(source, view) { this.states.push(`${source}/${view}`); },
      stop() { this.stopped += 1; },
      dispose() { this.stopped += 1; },
    });
    const active = recorder("active");
    const parked = recorder("parked");
    provider.backend = active;
    provider.slots = [{ id: "parked", backend: parked }];
    provider.ensureBackend = () => active;

    const onDispose = [];
    const view = {
      viewType: "dgc.chat", visible: true, show() {},
      webview: {
        options: {}, html: "", cspSource: "vscode-webview:",
        asWebviewUri: (uri) => ({ toString: () => String(uri.fsPath) }),
        onDidReceiveMessage() {},
      },
      onDidChangeVisibility() {},
      onDidDispose(fn) { onDispose.push(fn); },
    };
    provider.resolveWebviewView(view);
    assert.equal(onDispose.length, 1, "the panel must listen for the view being unchecked");

    onDispose.forEach((fn) => fn());
    assert.deepEqual(active.states, ["host/closed"],
      "exactly one statement, and it says which of the two went away");
    assert.deepEqual(parked.states, ["host/closed"],
      "one webview serves every chat, so a parked chat's backend hears it too");
    assert.equal(active.stopped + parked.stopped, 0,
      "closing the view has never stopped the backend and must not start now");
  } finally {
    vs.Uri = savedUri;
  }
});

test("a backend that dies is replaced, and the corpse is never handed out again", () => {
  // ensureBackend() returns this.backend whenever it is set, so leaving the dead child there made
  // every later command write to a closed pipe: the panel could not recover without the user
  // finding "DGC: Restart Backend". dgc serve is a plain child of the extension host, so an
  // extension update or a window reload takes it down -- recovery has to be automatic.
  const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.25.1", dgcCliVersion: "0.40.1" } },
    extensionUri: { fsPath: "/ext" }, subscriptions: [],
    globalState: { get() {}, async update() {} },
    workspaceState: { get() {}, async update() {} },
  });
  provider.post = () => {};
  provider.view = { visible: true };

  const handlers = {};
  const be = { ready: true, on(name, fn) { handlers[name] = fn; }, start() {}, dispose() {} };
  provider.backend = be;
  be.on("exit", (code) => {
    if (provider.backend === be) { provider.backend = undefined; provider.recoverBackend(); }
  });

  handlers.exit(0);
  assert.equal(provider.backend, undefined, "the dead backend is cleared immediately");
  assert.notEqual(provider.recoveryTimer, undefined, "and a replacement is scheduled unprompted");
  provider.dispose();
  assert.equal(provider.recoveryTimer, undefined, "disposing cancels the pending restart");
});

test("a backend that cannot stay up is not respawned forever", async () => {
  const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.25.1", dgcCliVersion: "0.40.1" } },
    extensionUri: { fsPath: "/ext" }, subscriptions: [],
    globalState: { get() {}, async update() {} },
    workspaceState: { get() {}, async update() {} },
  });
  const posted = [];
  provider.post = (m) => posted.push(m);
  provider.view = { visible: true };
  provider.backendRecoveries = [Date.now(), Date.now(), Date.now()];   // three already, in-window
  provider.recoverBackend();
  assert.equal(provider.recoveryTimer, undefined, "no fourth restart is scheduled");
  const told = posted.find((m) => /could not keep its backend running/.test(m?.event?.message || ""));
  assert.ok(told, "and the user is told, with the command that fixes it");
  assert.match(told.event.message, /DGC: Restart Backend/);
  provider.dispose();
});

test("a deliberate restart does not spend the crash-recovery budget", () => {
  const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.25.1", dgcCliVersion: "0.40.1" } },
    extensionUri: { fsPath: "/ext" }, subscriptions: [],
    globalState: { get() {}, async update() {} },
    workspaceState: { get() {}, async update() {} },
  });
  provider.post = () => {};
  provider.backendRecoveries = [Date.now(), Date.now()];
  provider.intentionalShutdown = true;
  provider.recoverBackend();
  assert.equal(provider.recoveryTimer, undefined, "an intentional teardown schedules nothing");
  provider.dispose();
});

function recoveryProvider({ mark, goal } = {}) {
  const stored = new Map();
  const sent = [];
  const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.25.1", dgcCliVersion: "0.40.1" } },
    extensionUri: { fsPath: "/ext" }, subscriptions: [],
    globalState: { get() {}, async update() {} },
    workspaceState: {
      get: (key) => stored.get(key),
      async update(key, value) { if (value === undefined) { stored.delete(key); } else { stored.set(key, value); } },
    },
  });
  provider.post = () => {};
  provider.currentSessionId = "chat-alpha";
  provider.state = { model: "m", mode: "default", think: "off", ultra: false, baseUrl: "",
                     goal: { text: "", status: "none", elapsed_seconds: 0 } };
  const be = { ready: true, send: (c) => { sent.push(c); return true; }, dispose() {} };
  provider.backend = be;
  provider.ensureBackend = () => be;
  provider.requestState = async () => ({ type: "status", goal });
  // The marker is scoped to the workspace, so build it from the provider's own scope rather than
  // guessing one -- a wrong scope would make every assertion below pass for the wrong reason.
  if (mark) {
    stored.set("dgc.goalPursuit.v1", { scope: provider.draftScope(), ...mark });
  }
  return { provider, be, sent, stored };
}

test("a reloaded webview asks for the monitors list, so its rail and monitor ids come back", async () => {
  for (const monitors of [true, false]) {
    const h = recoveryProvider();
    h.provider.sessionReady = true;
    h.provider.scheduleWorkspaceChanges = () => {};
    h.provider.lastReadyEvent = { type: "ready", capabilities: { monitors, history_snapshot: true } };
    await h.provider.onMessage({ type: "webviewReady" });
    const listed = h.sent.filter((c) => c.type === "list_monitors");
    if (!monitors) { assert.deepEqual(listed, [], "a backend without monitors is not asked"); continue; }
    assert.equal(listed.length, 1);
    assert.match(listed[0].request_id, /^monitors-restore-/, "not the /monitors card's request id");
    assert.ok(h.sent.some((c) => c.type === "get_history"));
  }
});

test("a backend handshake asks for the background shells once, so the agents pill hears every start and end", async () => {
  // The CLI pushes a shell's start and end only to a client that has asked for the list; before
  // this, the pill said "0 agents" over two running shells until the agent map was first opened.
  for (const version of [1, 0]) {
    const h = recoveryProvider();
    h.provider.scheduleWorkspaceChanges = () => {};
    h.provider.startPipsAttention = () => {};
    h.provider.resumeInterruptedWork = async () => {};
    h.be.completeHandshake = () => {};
    h.provider.lastReadyEvent = { type: "ready", capabilities: { agents: true, ...(version ? { background_tasks: { version } } : {}) } };
    h.provider.finishSessionHandshake(h.be);
    const listed = h.sent.filter((c) => c.type === "list_background_shells");
    if (!version) { assert.deepEqual(listed, [], "a CLI without background_tasks is not asked"); continue; }
    assert.equal(listed.length, 1);
    assert.match(listed[0].request_id, /^shells-restore-/);
  }
});

test("a webview reloaded while a turn runs is told about that turn before its history arrives", async () => {
  for (const running of [true, false]) {
    const h = recoveryProvider();
    const posts = [];
    h.provider.post = (m) => posts.push(m);
    h.provider.sessionReady = true;
    h.provider.scheduleWorkspaceChanges = () => {};
    h.provider.lastReadyEvent = { type: "ready", capabilities: { history_snapshot: true } };
    h.provider.onEvent({ type: "turn_start", turn_id: "t7", prompt: "pick a database", kind: "prompt" });
    if (!running) h.provider.onEvent({ type: "turn_end", turn_id: "t7", reason: "completed" });
    posts.length = 0;
    await h.provider.onMessage({ type: "webviewReady" });
    const told = posts.filter((m) => m.type === "turn_active");
    if (!running) { assert.deepEqual(told, [], "a finished turn is not announced"); continue; }
    assert.equal(told.length, 1);
    assert.deepEqual({ ...told[0], startedAt: typeof told[0].startedAt },
      { type: "turn_active", turnId: "t7", kind: "prompt", prompt: "pick a database", startedAt: "number",
        handoff: false, history: true });
    assert.ok(h.sent.some((c) => c.type === "get_history"), "the snapshot is still requested");
    assert.ok(posts.findIndex((m) => m.type === "session_ready") < posts.indexOf(told[0]),
      "after session_ready, so the webview's reset does not undo it");
  }
});

test("a goal interrupted by a dead backend picks itself back up", async () => {
  // load_session demotes a restored active goal to paused, which is right when a person opens an
  // old chat and wrong when the runner was killed under it seconds ago. The marker tells the two
  // apart -- it exists only while a goal is genuinely being pursued.
  const h = recoveryProvider({
    mark: { id: "chat-alpha", at: Date.now() - 5000 },
    goal: { text: "ship the release", status: "paused" },
  });
  await h.provider.resumeInterruptedGoal(h.be);
  assert.deepEqual(h.sent, [{ type: "resume_goal" }], "the goal continues without a human click");
  assert.equal(h.stored.get("dgc.goalPursuit.v1"), undefined, "the marker is one-shot");
});

test("reopening an old chat still waits for a human", async () => {
  const h = recoveryProvider({
    mark: { id: "chat-alpha", at: Date.now() - 60 * 60 * 1000 },   // an hour old
    goal: { text: "ship the release", status: "paused" },
  });
  await h.provider.resumeInterruptedGoal(h.be);
  assert.deepEqual(h.sent, [], "a stale marker is not an interruption");
});

test("a goal the user paused is never revived behind their back", async () => {
  const h = recoveryProvider({ goal: { text: "ship the release", status: "paused" } });
  await h.provider.resumeInterruptedGoal(h.be);          // no marker at all
  assert.deepEqual(h.sent, [], "without a marker there is nothing to resume");

  // And the marker is cleared the moment the goal stops being pursued.
  const live = recoveryProvider({ mark: { id: "chat-alpha", at: Date.now() } });
  live.provider.noteGoalPursuit(false);
  await new Promise((r) => setImmediate(r));
  assert.equal(live.stored.get("dgc.goalPursuit.v1"), undefined);
});

test("a marker from a different chat does not resume this one", async () => {
  const h = recoveryProvider({
    mark: { id: "some-other-chat", at: Date.now() - 5000 },
    goal: { text: "ship the release", status: "paused" },
  });
  await h.provider.resumeInterruptedGoal(h.be);
  assert.deepEqual(h.sent, []);
});

test("the backend's own words are kept where they can be read", async () => {
  // stderr was posted to the webview, which has no handler for it, so every traceback dgc serve
  // wrote was dropped. A backend could die repeatedly and leave no evidence anywhere.
  const lines = [];
  const vs = globalThis.__DGC_TEST_VSCODE;
  const savedChannel = vs.window.createOutputChannel;
  try {
    vs.window.createOutputChannel = () => ({
      appendLine: (l) => lines.push(l), append() {}, show() {}, dispose() {},
    });
    const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.25.1", dgcCliVersion: "0.40.1" } },
      extensionUri: { fsPath: "/ext" }, subscriptions: [],
      globalState: { get() {}, async update() {} },
      workspaceState: { get() {}, async update() {} },
    });
    provider.post = () => {};
    const handlers = {};
    const be = { ready: true, on(n, f) { handlers[n] = f; }, start() {}, dispose() {} };
    provider.backend = be;
    be.on("stderr", (line) => { provider.backendLog.appendLine(line); });
    be.on("exit", () => { provider.backendLog.appendLine("[dgc serve exited: code 0]"); });

    handlers.stderr('Traceback (most recent call last):\n  ValueError: invalid protocol event');
    handlers.exit(0);
    assert.ok(lines.some((l) => /ValueError: invalid protocol event/.test(l)),
      "a backend traceback is retained");
    assert.ok(lines.some((l) => /dgc serve exited/.test(l)),
      "and the exit itself is recorded next to it");
    provider.dispose();
  } finally {
    vs.window.createOutputChannel = savedChannel;
  }
});

test("a backend that dies unattended still leaves its traceback on disk", async () => {
  // An output channel only reaches disk once somebody opens one. The crash we needed evidence for
  // happened while nobody was looking — which is the normal case for an unattended goal.
  const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
  const logDir = mkdtempSync(join(tmpdir(), "dgc-backend-log-"));
  const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.25.1", dgcCliVersion: "0.40.1" } },
    extensionUri: { fsPath: "/ext" }, subscriptions: [],
    logUri: { fsPath: logDir },
    globalState: { get() {}, async update() {} },
    workspaceState: { get() {}, async update() {} },
  });
  provider.post = () => {};

  provider.backendNote('Traceback (most recent call last):');
  provider.backendNote('ValueError: invalid protocol event');
  provider.backendNote('[dgc serve exited: killed by SIGKILL]');

  const file = join(logDir, "backend.log");
  assert.ok(existsSync(file), "the backend log is written without anyone opening a panel");
  const body = readFileSync(file, "utf8");
  assert.match(body, /ValueError: invalid protocol event/);
  assert.match(body, /killed by SIGKILL/);
  assert.match(body, /^\d{4}-\d\d-\d\dT/m, "each line is timestamped");
  provider.dispose();
});

// ---- backend exits: who asked, what the backend said, and what a reconnect picks back up ------

function lifecycleProvider(extra = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "dgc-exit-log-"));
  const stored = new Map();
  const posted = [];
  const sent = [];
  const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.25.1", dgcCliVersion: "0.40.1" } },
    extensionUri: { fsPath: "/ext" }, subscriptions: [], logUri: { fsPath: logDir },
    globalState: { get() {}, async update() {} },
    workspaceState: {
      get: (key) => stored.get(key),
      async update(key, value) { if (value === undefined) { stored.delete(key); } else { stored.set(key, value); } },
    },
    ...extra,
  });
  provider.post = (message) => posted.push(message);
  provider.view = { visible: true };
  const logText = () => {
    try { return readFileSync(join(logDir, "backend.log"), "utf8"); } catch { return ""; }
  };
  return { provider, stored, posted, sent, logDir, logText };
}

function nodeFixture(name, body) {
  const path = join(scratch, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(path, 0o700);
  return path;
}

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("an unassisted exit logs no and recovers even after an earlier protocol failure", async () => {
  // Before: the protocol failure set an instance-wide `intentional`, this.backend kept the disposed
  // instance, and the next child's own exit was logged "asked for it: yes", skipped recovery and
  // never told the webview -- the turn spun forever.
  const counter = join(scratch, "panel-generation");
  writeFileSync(counter, "0");
  const fixture = nodeFixture("panel-malformed-then-dies", `
const fs = require("node:fs");
const generation = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(generation));
if (generation === 1) { process.stdout.write("{not json\\n"); setTimeout(() => {}, 5000); }
else {
  process.stderr.write("[dgc serve] serve loop ended: stdin closed while the parent (1) is still alive; up 1s, 3 commands\\n");
  setTimeout(() => process.exit(0), 100);
}`);
  configurationInspections = { command: { defaultValue: "dgc", globalValue: fixture } };
  const h = lifecycleProvider();
  const first = h.provider.ensureBackend();
  assert.ok(await until(() => /stopping the backend — protocol: dgc backend emitted malformed NDJSON/.test(h.logText())));
  assert.equal(h.provider.backend, undefined, "a protocol failure retires the instance at once");
  assert.ok(h.posted.some((m) => m.type === "backend_exit" && /^protocol: /.test(m.cause || "") && m.recovering === false),
    "and the webview is told, so a turn ends instead of spinning");
  assert.ok(await until(() => /extension asked for it: yes \(protocol: dgc backend emitted malformed NDJSON/.test(h.logText())));

  const second = h.provider.ensureBackend();
  assert.notEqual(second, first, "the next command gets a fresh instance, not the retired one");
  assert.ok(await until(() => h.posted.some((m) => m.type === "backend_exit" && m.recovering === true)));
  const log = h.logText();
  assert.match(log, /\[dgc serve exited: code 0 · extension asked for it: no · up \d+s · pid \d+ · frames sent \d+/);
  assert.notEqual(h.provider.recoveryTimer, undefined, "recovery is scheduled");
  const exit = h.posted.find((m) => m.type === "backend_exit" && m.recovering === true);
  assert.match(exit.cause, /^stdin closed while the parent/, "the backend's own cause travels with the exit");
  const exits = h.stored.get("dgc.unassistedExits.v1");
  assert.equal(exits.length, 1, "only the unassisted exit counts toward the breaker");
  h.provider.dispose();
});

test("a third unassisted exit during a goal tells the webview the goal is held, not picked up", async () => {
  const fixture = nodeFixture("panel-dies-third-time", `
process.stderr.write("[dgc serve] serve loop ended: stdin closed while the parent (1) is still alive; up 1s, 2 commands\\n");
setTimeout(() => process.exit(0), 100);`);
  configurationInspections = { command: { defaultValue: "dgc", globalValue: fixture } };
  const h = lifecycleProvider();
  h.provider.currentSessionId = "chat-alpha";
  const now = Date.now();
  h.stored.set("dgc.goalPursuit.v1", { scope: h.provider.draftScope(), id: "chat-alpha", at: now - 5000 });
  h.stored.set("dgc.unassistedExits.v1", [{ at: now - 20 * 60_000, cause: "a", last: "" },
                                          { at: now - 60_000, cause: "a", last: "" }]);
  h.provider.ensureBackend();
  assert.ok(await until(() => h.posted.some((m) => m.type === "backend_exit")));
  const exit = h.posted.find((m) => m.type === "backend_exit");
  assert.equal(exit.resumes, "held", "the exit line matches the goal_resume_held card that follows");
  assert.equal(h.stored.get("dgc.unassistedExits.v1").length, 3);
  h.provider.dispose();
});

test("restore timeout names its cause and clears the backend", async () => {
  const panelSource = readFileSync(join(here, "../src/panel.ts"), "utf8");
  assert.match(panelSource, /timed out"\)\) \{\s*be\.close\("chat restoration timed out"\)/,
    "the restore-timeout path passes its cause");
  const fixture = nodeFixture("panel-lingers", `setTimeout(() => {}, 10000);
process.stdin.on("data", (chunk) => { if (String(chunk).includes("shutdown")) process.exit(0); });`);
  configurationInspections = { command: { defaultValue: "dgc", globalValue: fixture } };
  const h = lifecycleProvider();
  const be = h.provider.ensureBackend();
  be.dispose("chat restoration timed out");
  assert.equal(h.provider.backend, undefined, "the timed-out instance is not handed out again");
  assert.ok(h.posted.some((m) => m.type === "backend_exit" && m.cause === "chat restoration timed out"));
  assert.ok(await until(() => /extension asked for it: yes \(chat restoration timed out\)/.test(h.logText())));
  assert.equal(h.provider.recoveryTimer, undefined, "an asked-for stop is not a crash to recover from");
  h.provider.dispose();
});

test("a restart names its reason and is not recovered or offered back", async () => {
  const fixture = nodeFixture("panel-restart-lingers", `setTimeout(() => {}, 10000);
process.stdin.on("data", (chunk) => { if (String(chunk).includes("shutdown")) process.exit(0); });`);
  configurationInspections = { command: { defaultValue: "dgc", globalValue: fixture } };
  const h = lifecycleProvider();
  h.provider.ensureBackend();
  h.provider.restart("setting dgc.command changed");
  assert.ok(await until(() => /extension asked for it: yes \(restart: setting dgc\.command changed\)/.test(h.logText())));
  assert.match(h.logText(), /\[extension: restarting the backend — setting dgc\.command changed\]/);
  assert.equal(h.posted.filter((m) => m.type === "backend_exit").length, 0);
  h.provider.dispose();
  assert.ok(await until(() => /asked for it: yes \(panel disposed/.test(h.logText())),
    "the panel's own teardown still reaches backend.log after its channel is gone");
});

test("backendNote writes the file after the output channel is disposed", () => {
  const vs = globalThis.__DGC_TEST_VSCODE;
  const savedChannel = vs.window.createOutputChannel;
  try {
    vs.window.createOutputChannel = () => ({
      appendLine() { throw new Error("Channel has been closed"); }, append() {}, show() {}, dispose() {},
    });
    const h = lifecycleProvider();
    h.provider.backendNote("[dgc serve exited: code 0 · extension asked for it: yes (panel disposed)]");
    assert.match(h.logText(), /extension asked for it: yes \(panel disposed\)/);
    h.provider.dispose();
  } finally {
    vs.window.createOutputChannel = savedChannel;
  }
});

function interruptedProvider({ turn, goalMark, goal, exits, capability = true } = {}) {
  const h = recoveryProvider({ mark: goalMark, goal });
  h.posted = [];
  h.provider.post = (message) => h.posted.push(message);
  h.provider.webviewReady = true;
  h.provider.lastReadyEvent = { capabilities: { resume_turn: capability } };
  if (turn) {
    h.stored.set("dgc.interruptedTurn.v1", { scope: h.provider.draftScope(), id: "chat-alpha", ...turn });
  }
  if (exits) { h.stored.set("dgc.unassistedExits.v1", exits); }
  return h;
}

test("an interrupted plain turn offers Continue, a goal auto-resumes", async () => {
  const plain = interruptedProvider({
    turn: { turnId: "t3", at: Date.now() - 60_000, exitedAt: Date.now() - 2000,
            cause: "stdin closed while the parent (9) is still alive" },
  });
  await plain.provider.resumeInterruptedWork(plain.be);
  const offer = plain.posted.find((m) => m.type === "continue_offer");
  assert.ok(offer, "the plain turn is offered, not re-run");
  assert.match(offer.cause, /stdin closed while the parent/);
  assert.deepEqual(plain.sent, [], "nothing is sent until the user clicks Continue");
  assert.equal(plain.stored.get("dgc.interruptedTurn.v1"), undefined, "the offer is one-shot");

  await plain.provider.onMessage({ type: "resumeTurn" });
  assert.equal(plain.sent.length, 1);
  assert.equal(plain.sent[0].type, "resume_turn", "Continue is a DGC continuation, not typed words");
  assert.equal(plain.sent[0].text, undefined);

  const goal = interruptedProvider({
    turn: { turnId: "t3", at: Date.now() - 60_000, exitedAt: Date.now() - 2000, cause: "x" },
    goalMark: { id: "chat-alpha", at: Date.now() - 5000 },
    goal: { text: "ship the release", status: "paused" },
  });
  await goal.provider.resumeInterruptedWork(goal.be);
  assert.deepEqual(goal.sent, [{ type: "resume_goal" }], "a goal keeps its automatic resume");
  assert.equal(goal.posted.some((m) => m.type === "continue_offer"), false);

  const failedOnItsOwn = interruptedProvider({ turn: { turnId: "t4", at: Date.now() - 5000, endedAt: Date.now() - 4000 } });
  await failedOnItsOwn.provider.resumeInterruptedWork(failedOnItsOwn.be);
  assert.equal(failedOnItsOwn.posted.some((m) => m.type === "continue_offer"), false,
    "a turn that failed with no backend death behind it is not offered back");

  const stale = interruptedProvider({ turn: { turnId: "t5", at: Date.now() - 3_600_000, exitedAt: Date.now() - 3_600_000 } });
  await stale.provider.resumeInterruptedWork(stale.be);
  assert.equal(stale.posted.some((m) => m.type === "continue_offer"), false, "an hour-old interruption is not offered");
});

test("an exit mid-turn is marked for a Continue offer and the webview is told what will happen", () => {
  const h = interruptedProvider();
  h.provider.onEvent({ type: "turn_start", seq: 1, turn_id: "t1", prompt: "run npm install", kind: "prompt" });
  const mark = h.stored.get("dgc.interruptedTurn.v1");
  assert.equal(mark.turnId, "t1");
  assert.equal(h.provider.markInterruptedWork("stdin closed"), "offer");
  assert.equal(h.stored.get("dgc.interruptedTurn.v1").cause, "stdin closed");

  // The backend's shutdown ends the turn "error" a moment before the process exits.
  const late = interruptedProvider();
  late.provider.onEvent({ type: "turn_start", seq: 1, turn_id: "t2", prompt: "p", kind: "prompt" });
  late.provider.onEvent({ type: "turn_end", seq: 2, turn_id: "t2", reason: "error", token_estimate: 0 });
  assert.equal(late.provider.markInterruptedWork("stdin closed"), "offer");

  const finished = interruptedProvider();
  finished.provider.onEvent({ type: "turn_start", seq: 1, turn_id: "t3", prompt: "p", kind: "prompt" });
  finished.provider.onEvent({ type: "turn_end", seq: 2, turn_id: "t3", reason: "completed", token_estimate: 0 });
  assert.equal(finished.stored.get("dgc.interruptedTurn.v1"), undefined);
  assert.equal(finished.provider.markInterruptedWork("stdin closed"), "none", "an idle chat promises nothing");

  const goalCycle = interruptedProvider();
  goalCycle.provider.onEvent({ type: "turn_start", seq: 1, turn_id: "t4", prompt: "", kind: "resume" });
  assert.equal(goalCycle.stored.get("dgc.interruptedTurn.v1"), undefined, "goal cycles are the goal's to resume");
});

test("three unassisted exits in 30 minutes stop goal auto-resume and say why", async () => {
  const now = Date.now();
  const h = interruptedProvider({
    goalMark: { id: "chat-alpha", at: now - 5000 },
    goal: { text: "ship the release", status: "paused" },
    exits: [
      { at: now - 20 * 60_000, cause: "stdin closed while the parent (7) is still alive", last: "get_workspace_changes" },
      { at: now - 9 * 60_000, cause: "stdin closed while the parent (7) is still alive", last: "get_workspace_changes" },
      { at: now - 60_000, cause: "stdin closed while the parent (7) is still alive", last: "get_chat_changes" },
    ],
  });
  await h.provider.resumeInterruptedWork(h.be);
  assert.deepEqual(h.sent, [], "the goal is not resumed behind a repeating cause");
  const held = h.posted.find((m) => m.type === "goal_resume_held");
  assert.ok(held, "the user is told, with a Resume goal action in the webview");
  assert.equal(held.exits, 3);
  assert.match(held.cause, /stdin closed while the parent/);
  assert.equal(held.lastCommand, "get_chat_changes");

  const old = interruptedProvider({
    goalMark: { id: "chat-alpha", at: now - 5000 },
    goal: { text: "ship the release", status: "paused" },
    exits: [{ at: now - 50 * 60_000, cause: "a", last: "" }, { at: now - 45 * 60_000, cause: "a", last: "" },
            { at: now - 60_000, cause: "a", last: "" }],
  });
  await old.provider.resumeInterruptedWork(old.be);
  assert.deepEqual(old.sent, [{ type: "resume_goal" }], "exits older than the window do not count");
});

test("dgc.command changing during a turn restarts only after the turn ends", async () => {
  const h = interruptedProvider();
  const restarts = [];
  h.provider.restart = (reason) => restarts.push(reason);
  h.provider.turnActive = true;
  h.provider.commandPathChanged();
  assert.deepEqual(restarts, [], "the running turn is not killed");
  assert.ok(notices.info.some((m) => /restart with the new command path when the current turn ends/.test(m)));
  h.provider.onEvent({ type: "turn_end", seq: 3, turn_id: "t1", reason: "completed", token_estimate: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(restarts, ["setting dgc.command changed"]);

  // A prompt sent optimistically and then refused never produces a turn_end; the restart must not
  // wait forever for one.
  const refused = interruptedProvider();
  const refusedRestarts = [];
  refused.provider.restart = (reason) => refusedRestarts.push(reason);
  refused.provider.turnActive = true;
  refused.provider.commandPathChanged();
  refused.provider.onEvent({ type: "command_rejected", seq: 4, command: "prompt", message: "busy" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(refusedRestarts, ["setting dgc.command changed"]);

  const idle = interruptedProvider();
  const now = [];
  idle.provider.restart = (reason) => now.push(reason);
  idle.provider.commandPathChanged();
  assert.deepEqual(now, ["setting dgc.command changed"], "an idle panel restarts at once");
});

test("a deferred dgc.command restart waits for a queued prompt the backend already holds", async () => {
  // Before: the restart fired on the first turn_end, although the worker had the queued prompt in
  // hand. The shutdown cancelled it, the old child's "returned" was dropped, and the message was lost.
  const h = interruptedProvider();
  const restarts = [];
  h.provider.restart = (reason) => restarts.push(reason);
  let busy = true;
  const asked = [];
  h.provider.requestState = async (_be, _prefix, command) => { asked.push(command.type); return { type: "status", busy }; };
  h.provider.onEvent({ type: "turn_start", seq: 1, turn_id: "t1", prompt: "a", kind: "prompt" });
  h.provider.onEvent({ type: "prompt_accepted", seq: 2, request_id: "web-q", state: "queued" });
  h.provider.onEvent({ type: "queued", seq: 3, count: 1, text: "" });
  h.provider.commandPathChanged();
  h.provider.onEvent({ type: "turn_end", seq: 4, turn_id: "t1", reason: "completed", token_estimate: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(asked, ["status"], "the panel asks the backend before restarting");
  assert.deepEqual(restarts, [], "a backend with queued work is not restarted under it");
  assert.equal(h.provider.pendingCommandRestart, true, "the restart stays pending");

  h.provider.onEvent({ type: "turn_start", seq: 5, turn_id: "t2", prompt: "b", kind: "prompt", request_id: "web-q" });
  busy = false;
  h.provider.onEvent({ type: "turn_end", seq: 6, turn_id: "t2", reason: "completed", token_estimate: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(restarts, ["setting dgc.command changed"], "the restart follows the last queued turn");

  // A prompt sent while the status check is out keeps the restart waiting for that turn too.
  const racing = interruptedProvider();
  const racingRestarts = [];
  racing.provider.restart = (reason) => racingRestarts.push(reason);
  let answer;
  racing.provider.requestState = () => new Promise((resolve) => { answer = resolve; });
  racing.provider.turnActive = true;
  racing.provider.commandPathChanged();
  racing.provider.onEvent({ type: "turn_end", seq: 7, turn_id: "t3", reason: "completed", token_estimate: 0 });
  racing.provider.turnActive = true;                   // what sending a prompt does
  answer({ type: "status", busy: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(racingRestarts, [], "a turn the user just started is not cut off");
  assert.equal(racing.provider.pendingCommandRestart, true);
});

test("the exit line does not promise a goal pickup the repeat-cause breaker will hold", () => {
  const now = Date.now();
  const twoBefore = [{ at: now - 20 * 60_000, cause: "a", last: "" }, { at: now - 60_000, cause: "a", last: "" }];
  const held = interruptedProvider({ goalMark: { id: "chat-alpha", at: now - 5000 }, exits: twoBefore });
  assert.equal(held.provider.markInterruptedWork("stdin closed", 3), "held",
    "the third exit in the window holds the goal, so the line must say so");
  const first = interruptedProvider({ goalMark: { id: "chat-alpha", at: now - 5000 } });
  assert.equal(first.provider.markInterruptedWork("stdin closed", 1), "goal");
});

test("Clear and a typed /todo clear reach the backend as one correlated clear_todos", async () => {
  const h = harness(), posted = [], sent = [];
  h.provider.post = message => posted.push(message);
  h.provider.backend.send = command => { sent.push(command); return true; };
  // The row's Clear, relayed from the webview: correlated so its answer can be traced.
  await h.provider.onMessage({ type: "clear_todos" });
  // A /todo clear that reaches the host (the webview intercepts the typed one itself).
  await h.provider.slashText("/todo clear");
  await h.provider.slashText("/TODO   Clear");
  assert.deepEqual(sent.map(command => command.type), ["clear_todos", "clear_todos", "clear_todos"]);
  for (const command of sent) {
    assert.match(command.request_id, /^clear-todos-/);
    assert.deepEqual(Object.keys(command).sort(), ["request_id", "type"]);
  }
  await h.provider.slashText("/todo everything");
  assert.equal(sent.length, 3, "anything but clear is not sent on as an unknown custom command");
  assert.equal(sent.some(command => command.type === "slash_command"), false);
  assert.deepEqual(posted.at(-1), { type: "event", event: { type: "error", message: "usage: /todo clear" } });
  // An older backend that never advertised correlation gets the bare command.
  h.provider.correlatedStateRequests = false;
  await h.provider.onMessage({ type: "clear_todos" });
  assert.deepEqual(sent.at(-1), { type: "clear_todos" });
});

test("the Token Usage tab's request reaches get_usage, and an older CLI is told to update", async () => {
  // Re-pointed from the chat webview's getUsage, which went with the in-panel settings dialog, to
  // the standalone Settings tab's own branch -- the one that ships. Same four invariants: the
  // request id travels, an unknown range falls back rather than reaching the backend, a CLI with no
  // usage ledger is never sent a command it would reject, and a send that fails says so.
  const h = harness(), posted = [], sent = [];
  h.provider.settingsEditor = { webview: { postMessage: m => posted.push(m) } };
  h.provider.backend.send = command => { sent.push(command); return true; };
  h.provider.lastReadyEvent = { capabilities: { usage_ledger: true } };
  await h.provider.onSettingsMessage({ type: "getUsage", range: "30d", requestId: "usage-abc-1" });
  assert.deepEqual(sent, [{ type: "get_usage", request_id: "usage-abc-1", range: "30d" }]);
  await h.provider.onSettingsMessage({ type: "getUsage", range: "year; drop", requestId: "usage-abc-2" });
  assert.deepEqual(sent.at(-1), { type: "get_usage", request_id: "usage-abc-2", range: "7d" },
    "an unknown range falls back to the default instead of reaching the backend");
  h.provider.lastReadyEvent = { capabilities: {} };
  await h.provider.onSettingsMessage({ type: "getUsage", range: "today", requestId: "usage-old" });
  assert.equal(sent.length, 2, "an older CLI is never sent a command it would reject");
  assert.deepEqual(posted.at(-1), { type: "usage_unavailable", requestId: "usage-old",
    message: "Update the DGC CLI to see token usage in the editor." });
  h.provider.lastReadyEvent = { capabilities: { usage_ledger: true } };
  h.provider.backend.send = () => false;
  await h.provider.onSettingsMessage({ type: "getUsage", range: "all", requestId: "usage-full" });
  assert.equal(posted.at(-1).type, "usage_unavailable");
  assert.equal(posted.at(-1).requestId, "usage-full");
});

test("Token Usage's Pips view reaches get_pip_usage_report, and an older CLI is told to update", async () => {
  const h = harness(), posted = [], sent = [];
  h.provider.settingsEditor = { webview: { postMessage: m => posted.push(m) } };
  h.provider.backend.send = command => { sent.push(command); return true; };
  h.provider.lastReadyEvent = { capabilities: { usage_ledger: true, pip_usage_report: true } };
  await h.provider.onSettingsMessage({ type: "getPipUsage", range: "month", requestId: "pip-usage-1" });
  await h.provider.onSettingsMessage({ type: "getPipUsage", range: "forever", requestId: "pip-usage-2" });
  assert.deepEqual(sent, [{ type: "get_pip_usage_report", request_id: "pip-usage-1", range: "month" },
                          { type: "get_pip_usage_report", request_id: "pip-usage-2", range: "7d" }]);
  h.provider.lastReadyEvent = { capabilities: { usage_ledger: true } };
  await h.provider.onSettingsMessage({ type: "getPipUsage", range: "today", requestId: "pip-usage-old" });
  assert.equal(sent.length, 2, "a CLI without the report is never sent the command");
  assert.deepEqual(posted.at(-1), { type: "pip_usage_unavailable", requestId: "pip-usage-old",
    message: "Update the DGC CLI to see token usage by Pip." });
});

test("/usage typed in the editor opens Token Usage, with the range it names", async () => {
  // Before: slashText had no /usage route, so the command the slash menu offers went on as a
  // custom command and the backend answered "unknown command: /usage".
  const h = harness(), posted = [], sent = [], opened = [];
  h.provider.post = message => posted.push(message);
  h.provider.backend.send = command => { sent.push(command); return true; };
  h.provider.openSettings = (section, range) => opened.push([section, range]);
  await h.provider.slashText("/usage");
  await h.provider.slashText("/usage 30d");
  await h.provider.slashText("/USAGE  all-time");
  await h.provider.slashText("/usage week");
  assert.deepEqual(opened, [["usage", undefined], ["usage", "30d"], ["usage", "all"], ["usage", "7d"]]);
  await h.provider.slashText("/usage fortnight");
  assert.equal(opened.length, 4, "an unknown range opens nothing");
  assert.deepEqual(posted.at(-1), { type: "event", event: { type: "error",
    message: "usage: /usage [today|7d|30d|month|all]" } });
  assert.equal(sent.some(command => command.type === "slash_command"), false,
    "never sent on as an unknown custom command");
});

test("an exit with no word from the backend names its signal or status once", async () => {
  // Before: with no "serve loop ended" line the cause fell back to `exited with ${how}`, and how was
  // already "killed by SIGKILL": the Continue card read "(exited with killed by SIGKILL)".
  const counter = join(scratch, "panel-silent-generation");
  writeFileSync(counter, "0");
  const fixture = nodeFixture("panel-dies-silently", `
const fs = require("node:fs");
const generation = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(generation));
setTimeout(() => { if (generation === 1) process.kill(process.pid, "SIGKILL"); else process.exit(3); }, 100);`);
  configurationInspections = { command: { defaultValue: "dgc", globalValue: fixture } };
  const h = lifecycleProvider();
  h.provider.ensureBackend();
  assert.ok(await until(() => h.posted.filter((m) => m.type === "backend_exit").length >= 2, 8000));
  const [killed, failed] = h.posted.filter((m) => m.type === "backend_exit");
  assert.equal(killed.cause, "killed by SIGKILL");
  assert.equal(failed.cause, "exited with code 3");
  h.provider.dispose();
});

test("a chat that never had a message is not restored on reopen, and nothing says it is unavailable", async () => {
  // Before: the ready event's session id was remembered even though the backend writes a session
  // file only once the chat has content, so reopening VS Code asked to resume a file that never
  // existed and showed "no such session" and "The previous chat is unavailable".
  const fresh = restorationHarness();
  fresh.provider.currentSessionSaved = false;
  fresh.provider.rememberSession();
  assert.deepEqual(fresh.saved.get("dgc.activeSession.v1"), { scope: fresh.provider.draftScope(), id: "new-chat", saved: false });
  // The next window: the remembered chat was never saved.
  const reopened = restorationHarness();
  reopened.saved.set("dgc.activeSession.v1", { scope: reopened.provider.draftScope(), id: "saved-chat", saved: false });
  reopened.provider.sessionRestoreSaved = false;
  reopened.provider.maybeCompleteHandshake(reopened.backend);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reopened.calls.length, 0, "no resume_session for a chat with no file");
  assert.equal(reopened.released(), 1);
  assert.equal(reopened.posted.some(message => message.type === "event"), false, "no error and no 'unavailable' notice");
  assert.ok(reopened.posted.some(message => message.type === "session_ready"
    && message.sessionId === "new-chat" && message.adoptDraftFrom === "saved-chat"), "its unsent draft still comes along");
  // A chat becomes worth restoring as soon as it has a turn, a name or a resumed file.
  const used = restorationHarness();
  used.provider.currentSessionSaved = false;
  used.provider.onEvent({ type: "turn_start", turn_id: "t1", prompt: "hello", kind: "prompt" });
  assert.equal(used.saved.get("dgc.activeSession.v1").saved, true);
  const named = restorationHarness();
  named.provider.currentSessionSaved = false;
  named.provider.onEvent({ type: "session_named", name: "Kiwi" });
  assert.equal(named.saved.get("dgc.activeSession.v1").saved, true);
});

test("settings gear reveals only the editor, and ready restores the selected page", async () => {
  const {provider} = catalogHarness([]);
  const messages = [], commands = [], chat = [];
  provider.settingsEditor = {reveal() {}, webview: {postMessage: m => messages.push(m)}};
  provider.ensureBackend = () => ({send: m => {commands.push(m);return true;}});
  provider.post = m => chat.push(m);
  provider.openSettings();
  assert.equal(messages.find(m => m.type === "show").section, "general");
  assert.deepEqual(chat, []);
  messages.length = 0;
  await provider.onSettingsMessage({type:"ready"});
  assert.equal(messages.find(m => m.type === "show").section, "general");
  assert.ok(commands.some(c => c.type === "list_mcp_servers"));
});

test("Pips opens the main panel and correlates controls without creating an editor tab", async()=>{
 const {provider}=catalogHarness([]);const messages=[],commands=[];
 const backend={send:m=>{commands.push(m);return true;}};
 provider.ensureBackend=()=>backend;
 provider.post=m=>messages.push(m);
 provider.inVisiblePanel=action=>action();
 provider.sessionReady=true;provider.backend=backend;
 provider.lastReadyEvent={capabilities:{pips_supported:true,pips_api_version:9,pips_enabled:true}};
 provider.openPips();provider.openPips();
 assert.equal(messages.filter(m=>m.type==='pipsOpen').length,2);
 assert.equal(provider.pipsEditor.panel,undefined);
 await provider.onMessage({type:'pipsRequest',documentId:provider.pipsDocumentId,generation:provider.pipsEditor.generation,id:'client-1',request:{type:'list_pips'}});
 assert.equal(commands.at(-1).type,'pips_control');
 const request=commands.at(-1).request;
 assert.notEqual(request.request_id,'client-1');
 provider.pipsEditor.event({type:'pips_result',command:'list_pips',request_id:request.request_id,ok:true,result:{pips:[]}});
 assert.equal(messages.at(-1).type,'pipsReply');assert.equal(messages.at(-1).id,'client-1');
 provider.pipsEditor.dispose();
});

function pipsDocumentHarness() {
 const vs=globalThis.__DGC_TEST_VSCODE,savedUri=vs.Uri;
 vs.Uri={joinPath:(...parts)=>({fsPath:parts.map(String).join('/')}),file:value=>({fsPath:value})};
 const {provider}=catalogHarness([]),commands=[],messages=[];
 const backend={ready:true,send:message=>{commands.push(message);return true;}};
 provider.ensureBackend=()=>backend;provider.backend=backend;provider.sessionReady=true;
 provider.lastReadyEvent={capabilities:{pips_supported:true,pips_api_version:9,pips_enabled:true}};
 provider.post=message=>messages.push(message);provider.inVisiblePanel=action=>action();
 provider.html=()=>'<html><body>Mounted DGC</body></html>';
 const makeView=viewType=>{
  let receive;
  return {viewType,visible:true,show(){},onDidChangeVisibility(){},onDidDispose(){},
   webview:{options:{},html:'',onDidReceiveMessage(listener){receive=listener;}},
   message(value){receive(value);}};
 };
 const first=makeView('dgc.chat');provider.resolveWebviewView(first);provider.openPips();
 return {provider,commands,messages,first,makeView,
  request:(id='view-1',documentId=provider.pipsDocumentId)=>({type:'pipsRequest',documentId,generation:provider.pipsEditor.generation,id,request:{type:'list_pips'}}),
  dispose(){provider.pipsEditor?.dispose();vs.Uri=savedUri;}};
}

for(const boundary of ['same document replacement','sidebar adoption']) {
 test(`Pips discards prior document replies at ${boundary}, even with a reused client ID`,async()=>{
  const h=pipsDocumentHarness();
  try {
   await h.provider.onMessage(h.request());const old=h.commands.at(-1).request;
   const generation=h.provider.pipsEditor.generation;
   h.provider.resolveWebviewView(boundary==='sidebar adoption'?h.makeView('dgc.chatSecondary'):h.first);
   assert.ok(h.provider.pipsEditor.generation>generation,'new webview document invalidates the bridge generation');
   await h.provider.onMessage(h.request());const current=h.commands.at(-1).request;
   assert.notEqual(old.request_id,current.request_id);
   const before=h.messages.filter(m=>m.type==='pipsReply').length;
   h.provider.pipsEditor.event({type:'pips_result',command:'list_pips',request_id:old.request_id,ok:true,result:{pips:[{id:'stale'}]}});
   assert.equal(h.messages.filter(m=>m.type==='pipsReply').length,before,'the old document cannot satisfy a new document request');
   h.provider.pipsEditor.event({type:'pips_result',command:'list_pips',request_id:current.request_id,ok:true,result:{pips:[{id:'current'}]}});
   assert.deepEqual(h.messages.at(-1),{type:'pipsReply',id:'view-1',ok:true,result:{pips:[{id:'current'}]},error:undefined});
  } finally {h.dispose();}
 });
}

test('Pips rejects queued messages carrying the old document nonce after a same-view replacement',async()=>{
 const h=pipsDocumentHarness();
 try {
  const oldDocument=h.provider.pipsDocumentId;
  assert.equal(typeof oldDocument,'string');assert.ok(oldDocument.length>=16);
  h.provider.resolveWebviewView(h.first);assert.notEqual(h.provider.pipsDocumentId,oldDocument);
  const count=h.commands.length;
  for(const message of [h.request('old-request',oldDocument),{type:'pipsReconnect',documentId:oldDocument},{type:'pipsReady',documentId:oldDocument},h.request('missing-document',null)]) {
   await h.provider.onMessage(message);
  }
  assert.equal(h.commands.length,count,'stale documents must not enqueue a backend control');
  await h.provider.onMessage(h.request('fresh-request'));
  assert.equal(h.commands.length,count+1);assert.equal(h.commands.at(-1).type,'pips_control');
 } finally {h.dispose();}
});

test('the abandoned twin cannot send controls into the adopted main panel',()=>{
 const h=pipsDocumentHarness();
 try {
  const next=h.makeView('dgc.chatSecondary');h.provider.resolveWebviewView(next);
  const accepted=[];h.provider.onMessage=async message=>accepted.push(message);
  h.first.message({type:'pipsRequest',documentId:h.provider.pipsDocumentId,id:'old-twin',request:{type:'pause_pip',pip_id:'pip-old'}});
  assert.deepEqual(accepted,[],'message source view must match, even if it has a current-looking document ID');
  next.message({type:'pipsReady',documentId:h.provider.pipsDocumentId});
  assert.equal(accepted.length,1);
 } finally {h.dispose();}
});

test('Pips controls stay on their originating chat channel and reject stale view generations',async()=>{
 const h=pipsDocumentHarness();
 try {
  const old=h.request('old');await h.provider.onMessage(old);const oldWire=h.commands.at(-1).request;
  const secondary=[];const channel={send:command=>{secondary.push({...command,chat_id:'chat-other'});return true;}};
  h.provider.backend=channel;h.provider.ensureBackend=()=>channel;
  h.provider.pipsEditor.ready(h.provider.lastReadyEvent.capabilities,channel);
  await h.provider.onMessage({...old,id:'late-ui'});assert.equal(secondary.length,0);
  assert.match(h.messages.at(-1).error.message,/from an earlier connection/);
  await h.provider.onMessage(h.request('current'));assert.equal(secondary.length,1);
  assert.equal(secondary[0].chat_id,'chat-other');assert.equal(secondary[0].request.chat_id,undefined);
  const replies=h.messages.filter(m=>m.type==='pipsReply').length;
  h.provider.pipsEditor.event({type:'pips_result',command:'list_pips',request_id:oldWire.request_id,ok:true,result:{pips:[{id:'old'}]}});
  assert.equal(h.messages.filter(m=>m.type==='pipsReply').length,replies);
 }finally{h.dispose();}
});

test("editor usage preserves its request id and MCP switches do not open chat surfaces", async () => {
  const {provider} = catalogHarness([]);
  const commands = [], messages = [];
  provider.ensureBackend = () => ({send: m => {commands.push(m);return true;}});
  provider.post = m => messages.push(m);
  await provider.onSettingsMessage({type:"getUsage", range:"30d", requestId:"editor-ledger-1"});
  assert.deepEqual(commands.pop(), {type:"get_usage", range:"30d", request_id:"editor-ledger-1"});
  await provider.onSettingsMessage({type:"mcpToggle", name:"fixture", enabled:false});
  assert.equal(commands.at(-1).type, "set_mcp_enabled");
  assert.equal(commands.at(-1).enabled, false);
  assert.deepEqual(messages, []);
});

test("publisher terms are accepted in the host, never trusted from a webview flag", async () => {
  const {provider} = catalogHarness([]);
  const commands = [], messages = [];
  provider.ensureBackend = () => ({send: m => {commands.push(m);return true;}});
  provider.settingsEditor = {webview: {postMessage:m=>messages.push(m)}};
  provider.settingsCatalog = [{name:"fixture", display_name:"Fixture", install:"accept", license:"Publisher-Terms", terms_url:"https://publisher.example/terms"}];
  provider.settingsPreviews.set("fixture", provider.settingsCatalog[0]);
  await provider.onSettingsMessage({type:"installPlugin", name:"fixture", acceptLicense:"Publisher-Terms"});
  assert.deepEqual(commands, []);
  assert.equal(messages.at(-1).type,"pluginResult");
  notices.warningResponses.push("Accept and install");
  await provider.onSettingsMessage({type:"installPlugin", name:"fixture"});
  assert.equal(commands.at(-1).type,"install_plugin");
  assert.equal(commands.at(-1).accept_license,"Publisher-Terms");
});


test("unreviewed settings messages cannot install executable packages", async () => {
  const {provider} = catalogHarness([]);
  const commands=[], messages=[];
  provider.ensureBackend=()=>({send:m=>{commands.push(m);return true;}});
  provider.settingsEditor={webview:{postMessage:m=>messages.push(m)}};
  provider.settingsCatalog=[{name:"unreviewed",installed:false,install:"allow"}];
  await provider.onSettingsMessage({type:"installPlugin",name:"unreviewed"});
  assert.deepEqual(commands,[]);
  assert.match(messages.at(-1).error,/review/);
});

test("only selected reviewed stdio commands require native execution confirmation", async () => {
  const {provider} = catalogHarness([]);
  const commands=[],messages=[];
  provider.ensureBackend=()=>({send:m=>{commands.push(m);return true;}});
  provider.settingsEditor={webview:{postMessage:m=>messages.push(m)}};
  provider.settingsPreviews.set("fixture",{name:"fixture",display_name:"Fixture",install:"allow",server_specs:{
    local:{transport:"stdio",command:"node",args:["server.js"]},remote:{url:"https://example.com/mcp"}}});
  await provider.onSettingsMessage({type:"installPlugin",name:"fixture",selectedServers:["local"]});
  assert.equal(commands.length,0);assert.match(notices.warnings.at(-1),/run its MCP commands/);
  notices.warningResponses.push("Install and run");
  await provider.onSettingsMessage({type:"installPlugin",name:"fixture",selectedServers:["local"]});
  assert.equal(commands.at(-1).type,"install_plugin");
  const count=notices.warnings.length;
  await provider.onSettingsMessage({type:"installPlugin",name:"fixture",selectedServers:["remote"]});
  assert.equal(notices.warnings.length,count);
});

test("uninstall clears editor server records and secrets without dropping unrelated records", async () => {
  const {provider,secretValues}=harness({initialSecrets:{"dgc.mcp.owned":"secret", "dgc.mcp.keep":"keep"}});
  let records=["owned","keep"].map(name=>({name,transport:"stdio",target:"node",args:["server.js"],envNames:[],logLevel:"warning"}));
  provider.context.globalState={get:()=>records,update:async(key,value)=>{assert.equal(key,"dgc.managedMcpServers.v1");records=value;}};
  await provider.clearUninstalledPluginServers(["owned"]);
  assert.deepEqual(records.map(r=>r.name),["keep"]);
  assert.equal(secretValues.has("dgc.mcp.owned"),false);
  assert.equal(secretValues.get("dgc.mcp.keep"),"keep");
});

test("link install completion tracks the resolved plugin name",async()=>{
 const {provider}=catalogHarness([]);const commands=[];
 provider.ensureBackend=()=>({send:m=>{commands.push(m);return true;}});
 provider.settingsEditor={webview:{postMessage(){}}};
 provider.settingsPreviews.set("https://github.com/owner/package",{name:"resolved-package",install:"allow",server_specs:{}});
 await provider.onSettingsMessage({type:"installPlugin",name:"https://github.com/owner/package"});
 const command=commands.at(-1);assert.equal(command.name,"https://github.com/owner/package");
 assert.equal(provider.settingsInstalls.get(command.request_id),"resolved-package");
});

function composioHarness() {
 const {provider}=catalogHarness([]);const messages=[],opened=[],commands=[];
 provider.settingsEditor={webview:{postMessage:m=>messages.push(m)}};
 provider.ensureBackend=()=>({send:c=>{commands.push(c);return true;},request:async c=>{commands.push(c);throw Error('No app setup RPC expected');}});
 globalThis.__DGC_TEST_VSCODE.Uri.parse=s=>({toString:()=>s});
 globalThis.__DGC_TEST_VSCODE.env.openExternal=async uri=>{opened.push(uri.toString());return true;};
 return{provider,messages,opened,commands};
}
test('Composio management opens the fixed dashboard URL with no setup RPC',async()=>{
 const x=composioHarness();await x.provider.onSettingsMessage({type:'composioCatalog',url:'https://evil.invalid'});
 assert.deepEqual(x.opened,['https://dashboard.composio.dev/~/org/connect']);assert.deepEqual(x.commands,[]);
});
test('retired Composio controls cannot start setup, open an auth link or cancel chat',async()=>{
 const x=composioHarness();
 for(const type of ['composioConnection','composioBrowser','composioCancel']) await x.provider.onSettingsMessage({type,action:'connect',toolkit:'gmail',url:'https://connect.composio.dev/link/old'});
 assert.deepEqual(x.commands,[]);assert.deepEqual(x.opened,[]);assert.match(x.messages.at(-1).message,/Manage apps in Composio/);
 const chat=[];x.provider.post=m=>chat.push(m);
 x.provider.onEvent({type:'composio_connection',toolkit:'gmail',status:'pending',url:'https://connect.composio.dev/link/old'});
 assert.deepEqual(chat,[]);
});
test('cancelled or failed dashboard opening offers a retry without an auth request',async()=>{
 const x=composioHarness();globalThis.__DGC_TEST_VSCODE.env.openExternal=async()=>false;
 await x.provider.onSettingsMessage({type:'composioCatalog'});assert.match(x.messages.at(-1).message,/try again/);
 globalThis.__DGC_TEST_VSCODE.env.openExternal=async()=>{throw Error('native failure')};
 await x.provider.onSettingsMessage({type:'composioCatalog'});assert.match(x.messages.at(-1).message,/Could not open/);assert.deepEqual(x.commands,[]);
});

function connectorHarness(...args){
 const h=mcpTransactionHarness(...args);h.provider.ensureBackend=()=>h.provider.backend;
 h.provider.backend.send=()=>true;h.provider.post=()=>{};h.provider.settingsCatalog=[];
 h.posted=[];h.provider.settingsEditor={webview:{postMessage:m=>h.posted.push(m)}};
 return h;
}
test('connector requires native terms consent and stores only runtime tokens in SecretStorage',async()=>{
 const h=connectorHarness();await h.provider.saveConnector({name:'zapier',token:'fixture-token',auth:'token'});assert.equal(h.commands.length,0);
 notices.warningResponses.push('Accept and connect');await h.provider.saveConnector({name:'zapier',token:'fixture-token',auth:'token'});
 const cmd=h.commands[0];assert.equal(cmd.connector,'zapier');assert.equal(cmd.accept_license,'Zapier service terms');assert.equal(cmd.runtime.env.DGC_MCP_BEARER_TOKEN,'fixture-token');assert.doesNotMatch(JSON.stringify(cmd.persisted),/fixture-token/);assert.equal(cmd.persisted.defer_until_setup,true);
 assert.equal(h.catalog()[0].connector,'zapier');assert.doesNotMatch(JSON.stringify(h.catalog()),/fixture-token/);assert.match(h.rawSecrets.get('dgc.mcp.zapier'),/fixture-token/);
 h.provider.settingsCatalog=[{name:'zapier',installed:true}];h.clearEvidence();await h.provider.saveConnector({name:'zapier',token:'',auth:'token'});assert.equal(h.commands[0].runtime.env.DGC_MCP_BEARER_TOKEN,'fixture-token');
});
test('own-app connector: the Asana app ID and port go into its server, the secret only to SecretStorage and the owner-only file',async()=>{
 const home=mkdtempSync(join(scratch,'own-app-home-')),priorHome=process.env.HOME;process.env.HOME=home;
 const fsm=await import('node:fs');
 try{
  const h=connectorHarness();
  await h.provider.saveConnector({name:'asana',auth:'own-app',url:'https://mcp.asana.com/v2/mcp',client_id:'1209876543210',client_secret:''});
  assert.match(h.posted.findLast(m=>m.type==='connectorError').message,/client secret from Asana/);
  await h.provider.saveConnector({name:'asana',auth:'own-app',url:'https://mcp.asana.com/v2/mcp',client_id:'',client_secret:'x'});
  assert.match(h.posted.findLast(m=>m.type==='connectorError').message,/client ID from Asana/);
  assert.equal(h.commands.length,0,'nothing is sent without the app');
  notices.warningResponses.push('Accept and connect');
  await h.provider.saveConnector({name:'asana',auth:'own-app',url:'https://mcp.asana.com/v2/mcp',client_id:'1209876543210',client_secret:'fixture-secret'});
  const cmd=h.commands.find(c=>c.type==='upsert_mcp_server');
  assert.equal(cmd.connector,'asana');assert.equal(cmd.accept_license,'Asana service terms');
  assert.deepEqual(cmd.persisted.args.slice(0,5),['-y','mcp-remote','https://mcp.asana.com/v2/mcp','3334','--static-oauth-client-info']);
  const file=cmd.persisted.args[5].slice(1);
  assert.match(file,/mcp-oauth\/asana-[0-9a-f]{8}-[0-9a-f]{16}\.json$/);
  assert.deepEqual(JSON.parse(fsm.readFileSync(file,'utf8')),{client_id:'1209876543210',client_secret:'fixture-secret',redirect_uris:['http://localhost:3334/oauth/callback']});
  assert.equal(fsm.statSync(file).mode&0o777,0o600);
  assert.doesNotMatch(JSON.stringify(cmd.persisted),/fixture-secret/);assert.doesNotMatch(JSON.stringify(h.catalog()),/fixture-secret/);
  assert.match(h.rawSecrets.get('dgc.mcp.asana'),/fixture-secret/);
  // Reopened with the same app: a blank secret keeps the saved one.
  h.provider.settingsCatalog=[{name:'asana',installed:true}];h.clearEvidence();
  await h.provider.saveConnector({name:'asana',auth:'own-app',url:'https://mcp.asana.com/v2/mcp',client_id:'1209876543210',client_secret:''});
  assert.equal(h.posted.filter(m=>m.type==='connectorError').length,2,'no new error');
  assert.equal(JSON.parse(fsm.readFileSync(h.commands.find(c=>c.type==='upsert_mcp_server').persisted.args[5].slice(1),'utf8')).client_secret,'fixture-secret');
 }finally{process.env.HOME=priorHome;}
});
test('own-app connector: Zoom\'s public client needs only its ID, and no secret reaches SecretStorage or the file',async()=>{
 const home=mkdtempSync(join(scratch,'zoom-app-home-')),priorHome=process.env.HOME;process.env.HOME=home;
 const fsm=await import('node:fs');
 try{
  const h=connectorHarness();
  await h.provider.saveConnector({name:'zoom',auth:'own-app',url:'https://mcp.zoom.us/mcp/zoom/streamable',client_id:''});
  assert.match(h.posted.findLast(m=>m.type==='connectorError').message,/public client ID from Zoom/);
  notices.warningResponses.push('Accept and connect');
  // No secret field exists for Zoom; even a stray one in the message is dropped, never stored or written.
  await h.provider.saveConnector({name:'zoom',auth:'own-app',url:'https://mcp.zoom.us/mcp/zoom/streamable',client_id:'zPublicClientId42',client_secret:'stray-value'});
  assert.equal(h.posted.filter(m=>m.type==='connectorError').length,1,'no secret is asked for');
  const cmd=h.commands.find(c=>c.type==='upsert_mcp_server');
  assert.equal(cmd.connector,'zoom');assert.equal(cmd.accept_license,'Zoom service terms');
  assert.deepEqual(cmd.persisted.args.slice(0,5),['-y','mcp-remote','https://mcp.zoom.us/mcp/zoom/streamable','3336','--static-oauth-client-info']);
  const file=cmd.persisted.args[5].slice(1);
  assert.match(file,/mcp-oauth\/zoom-[0-9a-f]{8}-[0-9a-f]{16}\.json$/);
  // As the setup had you register it: 127.0.0.1 (Zoom's loopback rule), no secret, and an empty scope (the scopes
  // you added to the app decide; DGC asks for none of its own).
  assert.deepEqual(JSON.parse(fsm.readFileSync(file,'utf8')),{client_id:'zPublicClientId42',redirect_uris:['http://127.0.0.1:3336/oauth/callback'],scope:''});
  assert.equal(fsm.statSync(file).mode&0o777,0o600);
  assert.equal(h.rawSecrets.has('dgc.mcp.zoom'),false,'nothing for Zoom in SecretStorage');
  assert.doesNotMatch(JSON.stringify([cmd,h.catalog()]),/stray-value/);
 }finally{process.env.HOME=priorHome;}
});
test('generic MCP save cannot forge connector license acceptance',async()=>{
 const h=connectorHarness();await h.provider.saveMcpServer({name:'zapier',transport:'remote',target:'https://mcp.zapier.com/api/v1/connect',token:'fixture-token',connector:'zapier',connectorLicense:'Zapier service terms'});
 assert.equal(h.commands[0].connector,undefined);assert.equal(h.catalog()[0].connector,undefined);
});
test('connector SecretStorage failure compensates backend and ownership and leaves no local record',async()=>{
 const h=connectorHarness();h.failSecret('store','dgc.mcp.zapier');notices.warningResponses.push('Accept and connect');
 await h.provider.saveConnector({name:'zapier',token:'fixture-token',auth:'token'});
 assert.deepEqual(h.commands.map(c=>c.type),['upsert_mcp_server','remove_mcp_server']);assert.deepEqual(h.catalog(),[]);assert.equal(h.rawSecrets.size,0);assert.equal(h.posted.some(m=>m.type==='mcpSaved'),false);
});
test('connector rejects missing tokens, wrong endpoints and a release backend without connector support',async()=>{
 const h=connectorHarness();for(const msg of [{name:'zapier',auth:'token'},{name:'make',auth:'token',token:'fixture'},{name:'arcade',url:'https://evil.example/mcp/id',auth:'oauth'}])await h.provider.saveConnector(msg);
 assert.equal(h.commands.length,0);assert.equal(h.posted.filter(m=>m.type==='connectorError').length,3);
 h.provider.lastReadyEvent={capabilities:{}};await h.provider.saveConnector({name:'make',auth:'oauth'});assert.match(h.posted.findLast(m=>m.type==='connectorError').message,/local connector build/);assert.equal(h.commands.length,0);
});

test('released or not-yet-ready CLI never receives private plugin commands',()=>{
 const h=connectorHarness();const sent=[];h.provider.backend.send=c=>{sent.push(c);return true;};
 for(const ready of [undefined,{capabilities:{}}]){
  h.provider.lastReadyEvent=ready;for(const type of ['list_plugins','list_plugin_marketplaces','install_plugin','inspect_plugin','uninstall_plugin','create_plugin'])assert.equal(h.provider.sendPluginCommand({type}),false);
 }
 assert.deepEqual(sent,[]);assert.match(h.posted.at(-1).message,/local connector build/);
 h.provider.lastReadyEvent={capabilities:{plugin_management:true}};assert.equal(h.provider.sendPluginCommand({type:'list_plugins'}),true);assert.equal(sent[0].type,'list_plugins');
});

test('saved connector tokens are not replayed to a release CLI during startup',async()=>{
 const h=connectorHarness();const item={name:'zapier',connector:'zapier',connectorLicense:'Zapier service terms',transport:'remote',target:'https://mcp.zapier.com/api/v1/connect',args:[],envNames:[],logLevel:'warning'};
 await h.provider.storeMcpSecrets(item,{token:'private-token'});h.clearEvidence();h.provider.lastReadyEvent={capabilities:{}};
 assert.equal(await h.provider.sendManagedMcp(h.provider.backend,item,true),true);
 assert.deepEqual(h.commands,[]);assert.equal(h.timeline.some(s=>s.startsWith('secret:get:')),false);
 await assert.rejects(h.provider.sendManagedMcp(h.provider.backend,item,false),/local connector build/);
 assert.match(h.rawSecrets.get('dgc.mcp.zapier'),/private-token/);
});

test("Pip references are capability-gated and forwarded as exact pins with draft recovery", async () => {
 const h=harness(),sent=[],posted=[];h.provider.post=m=>posted.push(m);h.provider.ensureBackend=()=>h.provider.backend;h.provider.backend.send=m=>(sent.push(m),true);h.provider.editorContext=()=>[];h.provider.spoolImages=async()=>undefined;
 const pin={pip_id:'pip_'+'a'.repeat(32),expected_version:2,expected_lifecycle_revision:4};
 const message={type:'prompt',text:'Explain this Pip',requestId:'pip-ref-prompt',pip_references:[pin],restore:{text:'Explain this Pip',attachments:[{label:'Pip',pipReference:{pip_id:pin.pip_id}}]}};
 await h.provider.onMessage(message);assert.equal(sent.length,0);assert.ok(posted.some(m=>m.type==='prompt_rejected'&&m.requestId===message.requestId));
 h.provider.lastReadyEvent.capabilities.pip_references=1;await h.provider.onMessage(message);assert.deepEqual(sent[0].pip_references,[pin]);assert.deepEqual(h.provider.unstartedPrompts.get(message.requestId).draft,message.restore);
 for(const refs of [[pin,pin],[{...pin,workspace_id:'other'}],[{...pin,pip_id:pin.pip_id+'\n'}],[{...pin,expected_lifecycle_revision:-1}]])await h.provider.onMessage({...message,pip_references:refs});assert.equal(sent.length,1);
});
test("Pip search refuses caller scope and drops stale session replies", async () => {
 const h=harness(),sent=[],posted=[];h.provider.post=m=>posted.push(m);h.provider.ensureBackend=()=>h.provider.backend;h.provider.backend.send=m=>(sent.push(m),true);h.provider.lastReadyEvent.capabilities.pip_references=1;
 h.provider.currentSessionId='chat-a';await h.provider.onMessage({type:'list_prompt_pips',request_id:'ref-a',query:'Rook',limit:20});assert.equal(sent[0].type,'list_prompt_pips');
 h.provider.currentSessionId='chat-b';h.provider.onEvent({type:'prompt_pips',request_id:'ref-a',workspace_id:'ws-a',pips:[],next_cursor:null});assert.equal(posted.length,0);
 await h.provider.onMessage({type:'list_prompt_pips',request_id:'ref-b',workspace_id:'other'});assert.equal(sent.length,1);assert.equal(posted.at(-1).event.command,'list_prompt_pips');
 await h.provider.onMessage({type:'list_prompt_pips',request_id:'ref-c',limit:20});h.provider.onEvent({type:'prompt_pips',request_id:'ref-c',workspace_id:'ws-a',pips:[],next_cursor:null});assert.equal(posted.at(-1).event.type,'prompt_pips');
});
test("Pip reference prompt cannot cross a session change while images spool", async () => {
 const h=harness(),sent=[],posted=[];h.provider.post=m=>posted.push(m);h.provider.ensureBackend=()=>h.provider.backend;h.provider.backend.send=m=>(sent.push(m),true);h.provider.lastReadyEvent.capabilities.pip_references=1;
 let finish;h.provider.spoolImages=()=>new Promise(r=>{finish=r;});h.provider.currentSessionId='a';const pending=h.provider.onMessage({type:'prompt',text:'Inspect',requestId:'pin-await',pip_references:[{pip_id:'pip_'+'a'.repeat(32),expected_version:1,expected_lifecycle_revision:0}]});h.provider.currentSessionId='b';finish(undefined);await pending;assert.equal(sent.length,0);assert.ok(posted.some(m=>m.type==='prompt_rejected'));
});

// A `session` frame is where a chat's identity changes. The handler CLEARS the chat change set,
// because the previous chat's files must not be attributed to this one, and `onEvent`'s refresh
// list re-asks the backend what the NEW chat changed. Both halves are load-bearing and only the
// first was covered: clearing without re-asking leaves the set empty while the transcript repaints
// that session's finished-turn file lists from history, so clicking any of those rows reaches
// `reviewWorkspaceChange`'s empty-set branch and answers "That file is no longer in the workspace
// change set." for files the chat really did change.
//
// Written while hunting exactly that report (the cause turned out to be the diff header's path --
// tests/test_diff_header_path.py). The behaviour here was already right; nothing pinned it. Drop
// "session" from the refresh list in panel.ts and this test fails.
//
// The assertion is the request reaching the backend, not the timer that schedules it.
function sessionSwitchHarness() {
  const posted = [], asked = [];
  const provider = new DgcViewProvider({ subscriptions: [], globalState: { get() {} },
    workspaceState: { get() {}, async update() {} } });
  provider.post = message => posted.push(message);
  const backend = { ready: true, send() { return true; },
    request(command) {
      asked.push(command.type);
      if (command.type === "get_chat_changes") {
        return Promise.resolve({ type: "chat_changes", session_id: provider.currentSessionId, roots: [] });
      }
      return Promise.resolve({ type: "workspace_changes", roots: [] });
    },
  };
  Object.assign(provider, { backend, initializingBackend: undefined, currentSessionId: "first-chat",
    workspaceRootsDirty: false, workspaceRootsInFlight: undefined,
    lastReadyEvent: { capabilities: { workspace_inspection: true, chat_inspection: true } } });
  provider.chatChanges = [{ id: "stale", root: scratch, folder: "fixture", path: "old.ts",
                           displayPath: "old.ts", additions: 1, deletions: 0 }];
  // Capture the scheduling boundary, then await the real refresh. A fixed 60 ms
  // wait races its filesystem realpath calls when browser tests run in parallel.
  const scheduled = [];
  provider.scheduleWorkspaceChanges = delay => scheduled.push(delay);
  return { provider, posted, asked, async flushChanges() {
    assert.ok(scheduled.length > 0, "the session event must schedule a refresh");
    scheduled.length = 0;
    await provider.refreshWorkspaceChanges();
  } };
}

test("a resumed chat asks what IT changed, instead of keeping the previous chat's empty set", async () => {
  const h = sessionSwitchHarness();
  h.provider.onEvent({ type: "session", kind: "resumed", session_id: "second-chat", name: "Saved",
                       message_count: 4 });
  assert.equal(h.provider.currentSessionId, "second-chat");
  assert.deepEqual(h.provider.chatChanges, [],
    "the previous chat's files must never be attributed to this one");
  assert.ok(h.posted.some(message => message.type === "chat_changes"
    && message.sessionId === "second-chat" && message.files.length === 0),
    "the webview is told the set is empty for the new chat");
  await h.flushChanges();
  assert.ok(h.asked.includes("get_chat_changes"),
    "clearing without re-asking is the bug: the transcript's restored file rows then resolve "
    + "against an empty set and report the file is no longer in the change set");
  // A brand-new chat takes the same path, and its answer is legitimately empty -- the point is
  // that the question is asked, so the set matches the chat the user is looking at.
  const fresh = sessionSwitchHarness();
  fresh.provider.onEvent({ type: "session", kind: "new", session_id: "third-chat" });
  await fresh.flushChanges();
  assert.ok(fresh.asked.includes("get_chat_changes"));
});
test('replacing an unfinished goal needs review, preserves cancellation, and pins its identity',async()=>{
 const h=harness(),posted=[],commands=[];h.provider.post=v=>posted.push(v);h.provider.editorContext=()=>[];h.provider.goalInputs=true;h.provider.backend.send=v=>{commands.push(v);return true;};h.provider.lastReadyEvent={capabilities:{goal_replace_guard:true}};
 h.provider.state.goal={id:'a'.repeat(32),text:'Keep original work',status:'paused',elapsed_seconds:12};
 await h.provider.startGoal('Replacement',{requestId:'cancel'});assert.equal(commands.length,0);assert.equal(h.provider.state.goal.text,'Keep original work');assert.ok(posted.some(v=>v.type==='prompt_rejected'&&v.requestId==='cancel'));assert.ok(posted.some(v=>v.type==='goal_start_state'&&v.state==='cancelled'));
 notices.warningResponses.push('Replace goal');await h.provider.startGoal('Replacement',{requestId:'replace'});assert.equal(commands.length,1);assert.equal(commands[0].expected_goal_id,'a'.repeat(32));assert.equal(commands[0].text,'Replacement');
});
test('running turn rejects goal replacement without pretending to stop it',async()=>{
 const h=harness(),posted=[],commands=[];h.provider.post=v=>posted.push(v);h.provider.turnActive=true;h.provider.backend.send=v=>{commands.push(v);return true;};await h.provider.startGoal('Replace',{requestId:'busy'});assert.equal(commands.length,0);assert.equal(h.provider.turnActive,true);assert.ok(posted.some(v=>v.type==='prompt_rejected'&&v.requestId==='busy'));assert.match(posted.find(v=>v.type==='goal_start_state').error,/current turn/);
});
test('native active goal replacement reviews then steers without stopping the foreground turn',async()=>{
 const h=harness(),posted=[],commands=[];h.provider.post=v=>posted.push(v);h.provider.editorContext=()=>[];h.provider.goalInputs=true;h.provider.turnActive=true;h.provider.backend.send=v=>{commands.push(v);return true;};h.provider.lastReadyEvent={capabilities:{goal_replace_guard:true,live_goal_replace:true}};
 h.provider.state.goal={id:'a'.repeat(32),text:'Original work',status:'active',token_budget:500,elapsed_seconds:12};
 await h.provider.startGoal('New work',{requestId:'cancel-live'});assert.equal(commands.length,0);assert.equal(h.provider.turnActive,true);assert.ok(posted.some(v=>v.type==='goal_start_state'&&v.state==='cancelled'));
 notices.warningResponses.push('Replace goal');await h.provider.startGoal('--tokens 1000 New work',{requestId:'live'});
 assert.equal(commands.length,1);assert.equal(commands[0].type,'start_goal');assert.equal(commands[0].expected_goal_id,'a'.repeat(32));assert.equal(commands[0].token_budget,1000);assert.equal(commands[0].text,'New work');assert.equal(h.provider.turnActive,true);assert.equal(commands.some(v=>v.type==='cancel'),false);
});

test('live goal edit waits for correlated commit without cancellation or a second turn', async()=>{
 const h=harness(),posted=[],commands=[];h.provider.post=v=>posted.push(v);
 h.provider.turnActive=true;h.provider.lastReadyEvent={capabilities:{live_goal_edit:true}};
 h.provider.state.goal={id:'a'.repeat(32),text:'Original',status:'active'};
 h.provider.backend.send=v=>{commands.push(v);return true;};
 await h.provider.updateGoal('Edited',3000);
 assert.equal(commands.length,1);assert.equal(commands[0].type,'set_goal');
 assert.equal(commands[0].expected_goal_id,'a'.repeat(32));assert.equal(commands[0].token_budget,3000);
 assert.equal(h.provider.turnActive,true);assert.equal(posted.at(-1).state,'pending');
 await h.provider.updateGoal('Duplicate',8000);assert.equal(commands.length,1);
 // Reject a different request: it must not close the pending editor.
 h.provider.onEvent({type:'command_rejected',command:'set_goal',request_id:'other',message:'other'});
 assert.equal(h.provider.pendingGoalEdit,commands[0].request_id);
 h.provider.onEvent({type:'command_rejected',command:'set_goal',request_id:commands[0].request_id,message:'The turn ended'});
 assert.equal(h.provider.pendingGoalEdit,undefined);assert.equal(posted.at(-1).state,'error');
 assert.equal(posted.some(v=>v.type==='goal_edit_state'&&v.state==='saved'),false);
});
test('live goal edit reports a failed send and retains the editor draft',async()=>{
 const h=harness(),posted=[];h.provider.post=v=>posted.push(v);h.provider.turnActive=true;
 h.provider.lastReadyEvent={capabilities:{live_goal_edit:true}};
 h.provider.backend.send=()=>false;await h.provider.updateGoal('Edited',1000);
 assert.equal(h.provider.pendingGoalEdit,undefined);assert.equal(posted.at(-1).state,'error');
});

test('a first goal can steer an ordinary active turn on a capable native backend',async()=>{
 const h=harness(),posted=[],commands=[];h.provider.post=v=>posted.push(v);h.provider.editorContext=()=>[];
 h.provider.goalInputs=true;h.provider.turnActive=true;h.provider.state.goal={text:'',status:'none',elapsed_seconds:0};
 h.provider.lastReadyEvent={capabilities:{goal_replace_guard:true,live_goal_start:true}};
 h.provider.backend.send=v=>{commands.push(v);return true;};
 await h.provider.startGoal('--tokens 2000 Finish this objective',{requestId:'first-live'});
 assert.equal(commands.length,1);assert.equal(commands[0].type,'start_goal');
 assert.equal(commands[0].expected_goal_id,'');assert.equal(commands[0].token_budget,2000);
 assert.equal(commands[0].text,'Finish this objective');assert.equal(h.provider.turnActive,true);
 assert.equal(notices.warnings.length,0);assert.equal(commands.some(v=>v.type==='cancel'),false);
 assert.ok(posted.some(v=>v.type==='goal_start_state'&&v.state==='submitted'));
});

test("the web search is saved only to a CLI that can take it, and a blank key keeps the saved one", async () => {
  // A CLI that never answered search_api_key_set would refuse the whole save on an unknown key.
  const older = harness();
  await older.provider.saveSettings(settings({ search_provider: "brave", search_api_key: "brave-key-1", search_url: "" }));
  const first = older.commands.find((c) => c.type === "set_config");
  assert.ok(first, "the rest of the settings still save");
  assert.deepEqual(Object.keys(first.values).filter((k) => k.startsWith("search")), [], "no search keys to an older CLI");

  const { provider, commands, secretValues } = harness();
  provider.searchSettable = true;
  await provider.saveSettings(settings({ search_provider: "brave", search_api_key: "  brave-key-1  ", search_url: " " }));
  const saved = commands.find((c) => c.type === "set_config").values;
  assert.deepEqual([saved.search_provider, saved.search_api_key, saved.search_url], ["brave", "brave-key-1", ""]);
  assert.equal([...secretValues.keys()].some((k) => /search/i.test(k)), false,
    "kept by the CLI in its own secrets.json, where its Pips read it, not in the editor's SecretStorage");
  commands.length = 0;
  await provider.saveSettings(settings({ search_provider: "tavily", search_api_key: "", search_url: "" }));
  assert.equal("search_api_key" in commands.find((c) => c.type === "set_config").values, false, "blank keeps it");
  commands.length = 0;
  await provider.saveSettings(settings({ search_provider: "google" }));
  assert.equal("search_provider" in commands.find((c) => c.type === "set_config").values, false, "only the four it knows");
});

test("Ollama is saved as the web search only to a CLI whose handshake lists it, its key by the same path", async () => {
  const { provider, commands, secretValues } = harness();
  provider.searchSettable = true;
  await provider.saveSettings(settings({ search_provider: "ollama", search_api_key: "ollama-key-1", search_url: "" }));
  let values = commands.find((c) => c.type === "set_config").values;
  assert.equal("search_provider" in values, false, "an older CLI refuses the whole save on a provider it doesn't know");
  assert.equal("search_api_key" in values, false, "nor is its key kept as the key of the provider that CLI has");
  commands.length = 0;
  provider.lastReadyEvent = { capabilities: { search_providers: ["duckduckgo", "brave", "tavily", "searxng", "ollama", "later"] } };
  await provider.saveSettings(settings({ search_provider: "ollama", search_api_key: "  ollama-key-1  ", search_url: "" }));
  values = commands.find((c) => c.type === "set_config").values;
  assert.deepEqual([values.search_provider, values.search_api_key], ["ollama", "ollama-key-1"]);
  assert.equal([...secretValues.keys()].some((k) => /search|ollama/i.test(k)), false,
    "kept by the CLI in its own secrets.json, as Brave's and Tavily's are, not in the editor's SecretStorage");
  commands.length = 0;
  await provider.saveSettings(settings({ search_provider: "later", search_api_key: "" }));
  assert.equal("search_provider" in commands.find((c) => c.type === "set_config").values, false,
    "only providers this editor knows how to offer");
  // The settings page hears which ones the CLI takes with its config, from the handshake.
  const posted = [];
  provider.settingsEditor = { webview: { postMessage: (m) => posted.push(m) } };
  provider.onEvent({ type: "config", seq: 9, model: "m", mode: "default", think: "off", base_url: "", project_root: "/p",
                     goal: {}, search: "ollama", search_api_key_set: true });
  const forwarded = posted.find((m) => m.type === "event" && m.event.type === "config");
  assert.deepEqual(forwarded.event.search_providers, ["duckduckgo", "brave", "tavily", "searxng", "ollama"]);
  assert.equal(JSON.stringify(posted).includes("ollama-key-1"), false, "the page never gets the key back");
});

test("to a CLI that keeps a key per provider, a key goes by its provider's own name and Remove clears only that one", async () => {
  // One shared key went with every switch of provider: a Brave key was sent to Tavily or ollama.com.
  const { provider, commands } = harness();
  provider.searchSettable = true;
  provider.lastReadyEvent = { capabilities: { search_providers: ["duckduckgo", "brave", "tavily", "searxng", "ollama"],
    search_keys: { version: 1, providers: ["brave", "tavily", "ollama", "later"], saved: ["tavily"] } } };
  await provider.saveSettings(settings({ search_provider: "brave", search_api_key: "  brave-key-1  ", search_url: "" }));
  let values = commands.find((c) => c.type === "set_config").values;
  assert.equal(values.search_provider, "brave");
  assert.equal(values.search_api_key_brave, "brave-key-1", "Brave's own key");
  assert.equal("search_api_key" in values, false, "never the one shared name");
  assert.deepEqual(Object.keys(values).filter((k) => k.startsWith("search_api_key")), ["search_api_key_brave"]);
  commands.length = 0;
  await provider.saveSettings(settings({ search_provider: "searxng", search_api_key: "stray-1", search_url: "http://127.0.0.1:8888" }));
  values = commands.find((c) => c.type === "set_config").values;
  assert.deepEqual(Object.keys(values).filter((k) => k.startsWith("search_api_key")), [], "a provider that takes no key gets none");

  // The page hears which providers have a key of their own with each config, never a key.
  const posted = [];
  provider.settingsEditor = { webview: { postMessage: (m) => posted.push(m) } };
  const config = (extra) => provider.onEvent({ type: "config", seq: 9, model: "m", mode: "default", think: "off", base_url: "",
                                               project_root: "/p", goal: {}, ...extra });
  config({ search: "brave", search_api_key_set: true });
  let forwarded = posted.filter((m) => m.type === "event" && m.event.type === "config").pop();
  assert.deepEqual(forwarded.event.search_keys, { brave: true, tavily: true, ollama: false },
    "from the handshake, and the selected provider's from its config");
  assert.equal(JSON.stringify(posted).includes("brave-key-1"), false, "the page never gets a key back");

  // Remove: Tavily's own key, at once, by its own name, though Brave is the one selected.
  commands.length = 0;
  await provider.onSettingsMessage({ type: "removeSearchKey", provider: "tavily" });
  assert.deepEqual(commands.map((c) => [c.type, c.values]), [["set_config", { search_api_key_tavily: "" }]]);
  assert.deepEqual(posted.at(-1), { type: "searchKeyRemoved", provider: "tavily", ok: true });
  config({ search: "brave", search_api_key_set: true });
  forwarded = posted.filter((m) => m.type === "event" && m.event.type === "config").pop();
  assert.deepEqual(forwarded.event.search_keys, { brave: true, tavily: false, ollama: false });
  commands.length = 0;
  await provider.onSettingsMessage({ type: "removeSearchKey", provider: "searxng" });
  assert.equal(commands.length, 0, "only a provider that keeps a key");
  assert.equal(posted.at(-1).ok, false);

  // A new backend's handshake is read again.
  provider.lastReadyEvent = { capabilities: { search_keys: { version: 1, providers: ["brave", "tavily", "ollama"], saved: ["ollama"] } } };
  config({ search: "duckduckgo", search_api_key_set: false });
  forwarded = posted.filter((m) => m.type === "event" && m.event.type === "config").pop();
  assert.deepEqual(forwarded.event.search_keys, { brave: false, tavily: false, ollama: true });
});

test("a Remove the CLI refuses leaves the key shown as saved and says why", async () => {
  const { provider, commands } = harness({ rejectType: "set_config" });
  provider.lastReadyEvent = { capabilities: { search_keys: { version: 1, providers: ["brave", "tavily", "ollama"], saved: ["brave"] } } };
  const posted = [];
  provider.settingsEditor = { webview: { postMessage: (m) => posted.push(m) } };
  await provider.onSettingsMessage({ type: "removeSearchKey", provider: "brave" });
  assert.deepEqual(commands.map((c) => c.values), [{ search_api_key_brave: "" }]);
  assert.equal(posted.at(-1).ok, false);
  assert.match(posted.at(-1).message, /synthetic set_config rejection/);
  provider.onEvent({ type: "config", seq: 9, model: "m", mode: "default", think: "off", base_url: "", project_root: "/p", goal: {},
                     search: "tavily", search_api_key_set: false });
  const forwarded = posted.filter((m) => m.type === "event" && m.event.type === "config").pop();
  assert.equal(forwarded.event.search_keys.brave, true, "still saved");
});

test("an older CLI keeps its one key: the editor saves it as before and offers no per-provider state or Remove", async () => {
  const { provider, commands } = harness();
  provider.searchSettable = true;
  provider.lastReadyEvent = { capabilities: { search_providers: ["duckduckgo", "brave", "tavily", "searxng", "ollama"] } };
  await provider.saveSettings(settings({ search_provider: "brave", search_api_key: "brave-key-1", search_url: "" }));
  const values = commands.find((c) => c.type === "set_config").values;
  assert.deepEqual([values.search_provider, values.search_api_key], ["brave", "brave-key-1"], "today's one key field");
  assert.equal(Object.keys(values).some((k) => /^search_api_key_/.test(k)), false, "names an older CLI would refuse");
  const posted = [];
  provider.settingsEditor = { webview: { postMessage: (m) => posted.push(m) } };
  provider.onEvent({ type: "config", seq: 9, model: "m", mode: "default", think: "off", base_url: "", project_root: "/p", goal: {},
                     search: "brave", search_api_key_set: true });
  const forwarded = posted.find((m) => m.type === "event" && m.event.type === "config");
  assert.equal("search_keys" in forwarded.event, false);
  commands.length = 0;
  await provider.onSettingsMessage({ type: "removeSearchKey", provider: "brave" });
  assert.equal(commands.length, 0, "nothing sent to a CLI that can't take it");
  assert.equal(posted.at(-1).ok, false);
});

test("ChatDGC's instructions and personality are saved only to a CLI that takes them", async () => {
  const older = harness();
  await older.provider.saveSettings(settings({ chatdgc_about: "x", chatdgc_personality: "warm" }));
  assert.equal(Object.keys(older.commands.find((c) => c.type === "set_config").values).some((k) => k.startsWith("chatdgc")), false);
  const { provider, commands } = harness();
  provider.chatdgcSettable = true;
  await provider.saveSettings(settings({ chatdgc_about: "a".repeat(1600), chatdgc_style: "", chatdgc_personality: "rude" }));
  const values = commands.find((c) => c.type === "set_config").values;
  assert.equal(values.chatdgc_about.length, 1500);
  assert.equal(values.chatdgc_style, "", "cleared");
  assert.equal("chatdgc_personality" in values, false, "only the five it knows");
});
