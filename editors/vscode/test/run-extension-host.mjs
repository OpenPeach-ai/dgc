import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..");
const testsPath = join(here, "extension-host", "index.cjs");
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-host-"));
const resultPath = join(scratch, "result.json");
const backendPath = join(scratch, "dgc-fixture");
const backendLogPath = join(scratch, "backend.ndjson");
const workspacePath = join(scratch, "primary-workspace");
const secondaryWorkspace = join(scratch, "secondary-workspace");
const workspaceFile = join(scratch, "multi-root.code-workspace");
const userDataDir = join(scratch, "user-data");
const settingsPath = join(userDataDir, "User", "settings.json");
const fixtureSecret = "dgc-extension-secret-sentinel";
const initialEndpoint = "https://provider-a.invalid/v1";
const changedEndpoint = "https://provider-b.invalid/v1";
const testToken = randomUUID();

mkdirSync(workspacePath);
mkdirSync(secondaryWorkspace);
writeFileSync(workspaceFile, JSON.stringify({ folders: [
  { path: workspacePath },
  { path: secondaryWorkspace },
] }));
mkdirSync(join(userDataDir, "User"), { recursive: true });
// Simulate a pre-SecretStorage extension install. The sentinel exists only in this
// disposable user-data directory and the fixture log, both removed in finally.
writeFileSync(settingsPath, JSON.stringify({
  "dgc.command": backendPath,
  "dgc.baseUrl": initialEndpoint,
  "dgc.apiKey": fixtureSecret,
  "dgc.checkForUpdates": false,
}));

writeFileSync(backendPath, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
let seq = 0;
let rootsAcknowledged = false;
let subscriptionModel = "";
let subscriptionEffort = "";
const send = (value) => process.stdout.write(JSON.stringify({ seq: seq++, ...value }) + "\\n");
const sendConfig = (requestId) => send({ type: "config", request_id: requestId,
  model: "fixture", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  project_root: process.cwd(), goal: { text: "", status: "none" },
  subscription_engine: "codex", subscription_model: subscriptionModel,
  subscription_effort: subscriptionEffort,
  subscription_engines: [{ key: "codex", label: "Codex (ChatGPT subscription)",
    model_hints: [], supports_effort: true }] });
send({ type: "ready", version: "fixture", protocol_version: 5,
  capabilities: { correlated_state_requests: true },
  model: "fixture", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [],
  goal: { text: "", status: "none" }, context_size: 32768 });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  fs.appendFileSync(process.env.DGC_EXTENSION_TEST_BACKEND_LOG, line + "\\n");
  const cmd = JSON.parse(line);
  if (cmd.type === "set_workspace_roots") {
    rootsAcknowledged = false;
    send({ type: "workspace_roots", request_id: "stale-workspace-request", roots: [] });
    setTimeout(() => {
      rootsAcknowledged = true;
      send({ type: "workspace_roots", request_id: cmd.request_id, roots: cmd.roots });
    }, 1000);
  }
  if (cmd.type === "set_mode") send({ type: "mode_changed", request_id: cmd.request_id,
    mode: cmd.mode, workspace_trusted: true });
  if (cmd.type === "set_think") send({ type: "think_changed", request_id: cmd.request_id,
    think: cmd.level });
  if (cmd.type === "get_config") sendConfig(cmd.request_id);
  if (cmd.type === "list_models") send({ type: "models", request_id: cmd.request_id,
    ids: ["native-fixture"], base_url: "http://127.0.0.1:1/v1", api_mode: "auto" });
  if (cmd.type === "set_config") {
    if (Object.prototype.hasOwnProperty.call(cmd.values || {}, "subscription_model")) {
      subscriptionModel = String(cmd.values.subscription_model || "");
    }
    if (Object.prototype.hasOwnProperty.call(cmd.values || {}, "subscription_effort")) {
      subscriptionEffort = String(cmd.values.subscription_effort || "");
    }
    sendConfig(cmd.request_id);
  }
  if (cmd.type === "set_goal") send({ type: "goal_changed", request_id: cmd.request_id,
    goal: cmd.text || "installed-host goal", status: cmd.status || "active" });
  if (cmd.type === "get_plan") send({ type: "saved_plan", request_id: cmd.request_id,
    plan: "1. Inspect\\n2. Verify", exists: true });
  if (cmd.type === "status") send({ type: "status", request_id: cmd.request_id,
    model: "fixture", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
    context_used: 0, context_size: 32768, goal: { text: "", status: "none" } });
  if (cmd.type === "prompt" && cmd.text === "correlated handshake probe") {
    if (!rootsAcknowledged) send({ type: "error",
      message: "prompt released before exact workspace-root acknowledgement", fatal: true });
    else {
      send({ type: "turn_start", turn_id: "handshake-turn", prompt: cmd.text });
      send({ type: "turn_end", turn_id: "handshake-turn", reason: "completed", token_estimate: 0 });
    }
  }
  if (cmd.type === "prompt" && cmd.text === "installed-host decision lifecycle") {
    send({ type: "turn_start", turn_id: "decision-turn", prompt: cmd.text });
    send({ type: "permission_request", id: "host-permission", call_id: "host-call",
      name: "bash", args: { command: "npm test" }, command: "npm test",
      suggested_rule: "Bash(npm test)", choices: ["once", "always", "deny"] });
  }
  if (cmd.type === "permission_response" && cmd.id === "host-permission") {
    send({ type: "request_expired", id: "host-permission" });
    send({ type: "plan_proposal", id: "host-plan", plan: "1. Inspect\\n2. Verify",
      choices: ["auto", "acceptEdits", "default", "reject"] });
  }
  if (cmd.type === "plan_response" && cmd.id === "host-plan") {
    send({ type: "request_expired", id: "host-plan" });
    send({ type: "turn_end", turn_id: "decision-turn", reason: "completed", token_estimate: 17 });
  }
  if (cmd.type === "shutdown") process.exit(0);
});
`);
chmodSync(backendPath, 0o700);

// This runner intentionally never downloads VS Code. CI or a developer supplies an installed
// executable; the explicit environment variable also makes Insiders/Cursor-compatible runs easy.
const configured = process.env.DGC_VSCODE_EXECUTABLE;
const systemExecutable = "/usr/share/code/code";
const executable = configured || (existsSync(systemExecutable) ? systemExecutable : "code");
const args = [
  `--extensionDevelopmentPath=${extensionRoot}`,
  `--extensionTestsPath=${testsPath}`,
  `--user-data-dir=${userDataDir}`,
  `--extensions-dir=${join(scratch, "extensions")}`,
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--disable-updates",
  "--disable-telemetry",
  "--disable-crash-reporter",
  "--disable-extension-gallery",
  "--disable-extensions",
  // Exercise VS Code's real SecretStorage API without consulting or mutating the
  // developer machine's desktop keychain from this disposable host process.
  "--use-inmemory-secretstorage",
  "--no-sandbox",
  "--disable-chromium-sandbox",
  "--skip-welcome",
  "--skip-release-notes",
  "--disable-workspace-trust",
];
if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  args.push("--ozone-platform=headless");
}
args.push(workspaceFile);

try {
  if (configured && !existsSync(configured)) {
    throw new Error(`DGC_VSCODE_EXECUTABLE does not exist: ${configured}`);
  }
  const env = { ...process.env };
  // A shell launched from VS Code/Cursor inherits extension-host and remote-CLI bootstrap state.
  // The test must create an isolated desktop instance instead of reusing that process or running
  // the Electron binary in Node compatibility mode.
  for (const key of Object.keys(env)) {
    if (key.startsWith("VSCODE_")) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  env.DGC_SELF_HOSTED = "false";
  env.DGC_EXTENSION_TEST_RESULT = resultPath;
  env.DGC_EXTENSION_TEST_BACKEND = backendPath;
  env.DGC_EXTENSION_TEST_BACKEND_LOG = backendLogPath;
  env.DGC_EXTENSION_TEST_SETTINGS = settingsPath;
  env.DGC_EXTENSION_TEST_PRIMARY_ROOT = workspacePath;
  env.DGC_EXTENSION_TEST_SECONDARY_ROOT = secondaryWorkspace;
  env.DGC_EXTENSION_TEST_CHANGED_ENDPOINT = changedEndpoint;
  env.DGC_EXTENSION_TEST_TOKEN = testToken;
  const result = spawnSync(executable, args, {
    cwd: extensionRoot,
    env,
    encoding: "utf8",
    timeout: 90_000,
  });
  if (result.error) throw result.error;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`VS Code extension-host tests exited with ${result.status ?? "no status"}`);
  }
  if (!existsSync(resultPath)) {
    throw new Error("VS Code exited without executing the DGC extension-host test module");
  }
  const evidence = JSON.parse(readFileSync(resultPath, "utf8"));
  if (evidence.activated !== true || evidence.handshake !== true
      || evidence.multiRootLifecycle !== true
      || evidence.secretStorageLifecycle !== true
      || evidence.decisionLifecycle !== true
      || !Number.isInteger(evidence.commands) || evidence.commands < 1
      || typeof evidence.vscodeVersion !== "string"
      || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(evidence.vscodeVersion)
      || typeof evidence.appName !== "string" || !evidence.appName.trim()) {
    throw new Error("VS Code extension-host test evidence was incomplete");
  }
  const expectedVersion = process.env.DGC_EXPECT_VSCODE_VERSION;
  if (expectedVersion && evidence.vscodeVersion !== expectedVersion) {
    throw new Error(`expected VS Code ${expectedVersion}, host reported ${evidence.vscodeVersion}`);
  }
  process.stdout.write(`DGC extension-host smoke passed in ${evidence.appName} ${evidence.vscodeVersion} (${evidence.commands} commands + handshake + live multi-root + SecretStorage + permission/plan lifecycles)\n`);
} finally {
  if (process.env.DGC_KEEP_EXTENSION_TEST === "true") {
    process.stderr.write(`DGC extension-host scratch retained at ${scratch}\n`);
  } else {
    rmSync(scratch, { recursive: true, force: true });
  }
}
