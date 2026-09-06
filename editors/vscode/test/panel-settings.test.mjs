import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
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
  commands: {},
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { WorkspaceFolder: 1, Workspace: 2, Global: 3 },
  window: {
    createStatusBarItem: () => statusBar,
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
  const context = { secrets, subscriptions: [], globalState: { get() {}, async update() {} } };
  const provider = new DgcViewProvider(context);
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
    completeHandshake() { released++; }, dispose() { disposed++; },
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
  return { provider: new DgcViewProvider(context), updates };
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
