"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { basename, join, resolve } = require("node:path");
const vscode = require("vscode");

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for the DGC webview/backend handshake");
}

function backendCommands(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; }
    catch { return []; }
  });
}

function sameRoots(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const left = actual.map((path) => resolve(path)).sort();
  const right = expected.map((path) => resolve(path)).sort();
  return left.every((path, index) => path === right[index]);
}

/** The extension's own backend.log, wherever VS Code put this window's log directory. */
function findBackendLog(dir) {
  let found = "";
  let newest = 0;
  const walk = (current, depth) => {
    if (depth > 8) return;
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.name === "backend.log") {
        const mtime = statSync(path).mtimeMs;
        if (mtime >= newest) { newest = mtime; found = path; }
      }
    }
  };
  walk(dir, 0);
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Run inside a real VS Code extension host (invoked by run-extension-host.mjs). */
async function run() {
  const extension = vscode.extensions.getExtension("vibedgc.dgc");
  assert.ok(extension, "the DGC development extension must be discoverable");

  const declared = (extension.packageJSON.contributes?.commands || [])
    .map((entry) => entry.command)
    .filter((name) => typeof name === "string");
  assert.ok(declared.length > 0, "DGC must declare editor commands");

  const testApi = await extension.activate();
  assert.equal(extension.isActive, true, "DGC must activate successfully in VS Code");

  const registered = new Set(await vscode.commands.getCommands(true));
  assert.deepEqual(
    declared.filter((name) => !registered.has(name)),
    [],
    "every declared DGC command must be registered after activation",
  );

  const config = vscode.workspace.getConfiguration("dgc");
  assert.equal(typeof config.get("command", ""), "string");
  assert.equal(typeof config.get("checkForUpdates", false), "boolean");

  const backendPath = process.env.DGC_EXTENSION_TEST_BACKEND;
  const backendLogPath = process.env.DGC_EXTENSION_TEST_BACKEND_LOG;
  const settingsPath = process.env.DGC_EXTENSION_TEST_SETTINGS;
  const primaryRoot = process.env.DGC_EXTENSION_TEST_PRIMARY_ROOT;
  const secondaryRoot = process.env.DGC_EXTENSION_TEST_SECONDARY_ROOT;
  const changedEndpoint = process.env.DGC_EXTENSION_TEST_CHANGED_ENDPOINT;
  const workspaceEndpoint = process.env.DGC_EXTENSION_TEST_WORKSPACE_ENDPOINT;
  const workspaceGate = process.env.DGC_EXTENSION_TEST_WORKSPACE_GATE;
  const testToken = process.env.DGC_EXTENSION_TEST_TOKEN;
  assert.ok(backendPath && backendLogPath && settingsPath && primaryRoot && secondaryRoot
    && changedEndpoint && workspaceEndpoint && workspaceGate && testToken,
  "the host runner must provide its fixture backend, workspace roots, and bridge token");
  assert.equal(typeof testApi?.testOnlyWebviewMessage, "function",
    "test activation must expose the isolated webview-message bridge");
  assert.equal(typeof testApi?.testOnlyPostedMessages, "function",
    "test activation must expose bounded webview delivery evidence");
  const seededSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const fixtureSecret = seededSettings["dgc.apiKey"];
  const initialEndpoint = seededSettings["dgc.baseUrl"];
  assert.equal(typeof fixtureSecret, "string", "the disposable profile must contain a secret sentinel");
  assert.equal(typeof initialEndpoint, "string", "the disposable profile must contain its initial endpoint");
  assert.deepEqual((vscode.workspace.workspaceFolders || []).map((folder) => resolve(folder.uri.fsPath)),
    [resolve(primaryRoot), resolve(secondaryRoot)], "VS Code must open the two-folder fixture workspace");
  assert.equal(config.get("command", ""), backendPath,
    "the disposable user profile must select the fixture backend before activation");
  assert.equal(config.get("apiKey", ""), fixtureSecret,
    "the disposable user profile must expose the legacy plaintext setting for migration");
  await vscode.commands.executeCommand("dgc.focus");
  const rootsCommands = () => backendCommands(backendLogPath)
    .filter((command) => command.type === "set_workspace_roots");
  const modelCommands = () => backendCommands(backendLogPath)
    .filter((command) => command.type === "set_model");
  await waitFor(() => rootsCommands().some((command) =>
    sameRoots(command.roots, [primaryRoot, secondaryRoot])));
  await waitFor(() => modelCommands().length > 0);
  assert.ok(rootsCommands().every((command) =>
    typeof command.request_id === "string" && command.request_id.length > 0
      && command.request_id.length <= 128),
  "every negotiated workspace-root update must carry a bounded request ID");
  assert.ok(modelCommands().every((command) =>
    typeof command.request_id === "string" && command.request_id.length > 0
      && command.request_id.length <= 128),
  "every negotiated editor model update must carry a bounded request ID");

  // The fixture emits a forged workspace_roots event before the exact correlated reply. A prompt
  // submitted in that window must remain behind the handshake until the matching acknowledgement.
  await testApi.testOnlyWebviewMessage(testToken,
    { type: "prompt", text: "correlated handshake probe" });
  await waitFor(() => backendCommands(backendLogPath).some((command) =>
    command.type === "prompt" && command.text === "correlated handshake probe"));
  await waitFor(() => testApi.testOnlyPostedMessages(testToken).some((item) =>
    item.type === "event" && item.eventType === "turn_end"));
  assert.equal(testApi.testOnlyPostedMessages(testToken).some((item) =>
    item.type === "event" && item.eventType === "error"), false,
  "a mismatched workspace-root acknowledgement must not release queued user commands");
  const migratedCommand = modelCommands().find((command) => command.base_url === initialEndpoint);
  assert.ok(migratedCommand, "native settings must send the configured initial endpoint");
  // The repository's workspace file names its own endpoint and gate command. Both settings
  // are machine-scoped, so the installed host must resolve the user's values and the backend
  // must never see the repository's endpoint or be told to run its command.
  assert.equal(config.get("baseUrl", ""), initialEndpoint,
    "a workspace value for the machine-scoped endpoint must not resolve");
  assert.notEqual(config.get("autonomousGate", ""), workspaceGate,
    "a workspace value for the machine-scoped autonomous gate must not resolve");
  assert.ok(modelCommands().every((command) => command.base_url !== workspaceEndpoint
    && command.autonomous_gate !== workspaceGate),
  "a repository's endpoint or gate command must never reach the backend");
  assert.equal(migratedCommand.api_key === fixtureSecret, true,
    "legacy plaintext must migrate through SecretStorage into backend setup");
  await waitFor(() => !hasOwn(JSON.parse(readFileSync(settingsPath, "utf8")), "dgc.apiKey"));

  // The plaintext setting is gone. A fresh backend must still receive the sentinel,
  // proving that the value survived only through the extension host's SecretStorage.
  const migratedModelCount = modelCommands().filter((command) =>
    command.base_url === initialEndpoint && command.api_key === fixtureSecret).length;
  const migratedRootCount = rootsCommands().length;
  const beforeResumeCount = backendCommands(backendLogPath).filter(command => command.type === "resume_session").length;
  await vscode.commands.executeCommand("dgc.restart");
  await waitFor(() => rootsCommands().length > migratedRootCount);
  await waitFor(() => modelCommands().filter((command) =>
    command.base_url === initialEndpoint && command.api_key === fixtureSecret).length
      > migratedModelCount);
  await waitFor(() => backendCommands(backendLogPath).filter(command => command.type === "resume_session").length > beforeResumeCount);
  const restored = backendCommands(backendLogPath).filter(command => command.type === "resume_session").at(-1);
  assert.match(restored.path, /^host-\d+\.json$/,
    "a restarted host must restore its saved chat after native settings and root setup");
  assert.equal(typeof restored.request_id, "string");

  // Endpoint binding is part of the credential boundary. When the user moves to another host
  // (the endpoint is machine-scoped, so only the user can), no credential may be sent there, and
  // the move must not erase the user-owned key.
  const beforeEndpointChange = modelCommands().length;
  await config.update("baseUrl", changedEndpoint, vscode.ConfigurationTarget.Global);
  await waitFor(() => modelCommands().slice(beforeEndpointChange).some((command) =>
    command.base_url === changedEndpoint && !hasOwn(command, "api_key")));
  const changedRootCount = rootsCommands().length;
  const changedModelCount = modelCommands().length;
  await vscode.commands.executeCommand("dgc.restart");
  await waitFor(() => rootsCommands().length > changedRootCount);
  await waitFor(() => modelCommands().slice(changedModelCount).some((command) =>
    command.base_url === changedEndpoint && !hasOwn(command, "api_key")));
  const beforeEndpointRestore = modelCommands().length;
  await config.update("baseUrl", initialEndpoint, vscode.ConfigurationTarget.Global);
  await waitFor(() => modelCommands().slice(beforeEndpointRestore).some((command) =>
    command.base_url === initialEndpoint && command.api_key === fixtureSecret));

  const userData = process.env.DGC_EXTENSION_TEST_USER_DATA;
  assert.ok(userData, "the host runner must provide its user-data directory");
  const backendLogText = () => {
    const path = findBackendLog(join(userData, "logs"));
    return path ? readFileSync(path, "utf8") : "";
  };
  const logCount = (pattern) => (backendLogText().match(new RegExp(pattern.source, "g")) || []).length;
  const startedCount = () => logCount(/\[dgc serve started: pid \d+/);
  const startedBeforeFolders = startedCount();
  assert.ok(startedBeforeFolders >= 1, "backend.log records every child the extension starts");

  const initialCount = rootsCommands().length;
  assert.ok(rootsCommands().length > 0 && rootsCommands().every(command => !("question_forms" in command)),
    "v14: every client takes structured questions, so the installed host no longer sends question_forms");
  assert.equal(vscode.workspace.updateWorkspaceFolders(1, 1), true,
    "the installed host must allow removing the secondary workspace folder");
  await waitFor(() => (vscode.workspace.workspaceFolders || []).length === 1);
  await waitFor(() => rootsCommands().slice(initialCount).some((command) =>
    sameRoots(command.roots, [primaryRoot])));

  const removedCount = rootsCommands().length;
  assert.equal(vscode.workspace.updateWorkspaceFolders(1, 0,
    { uri: vscode.Uri.file(secondaryRoot), name: "secondary-workspace" }), true,
    "the installed host must allow restoring the secondary workspace folder");
  await waitFor(() => (vscode.workspace.workspaceFolders || []).length === 2);
  await waitFor(() => rootsCommands().slice(removedCount).some((command) =>
    sameRoots(command.roots, [primaryRoot, secondaryRoot])));
  assert.equal(startedCount(), startedBeforeFolders,
    "adding or removing a workspace folder updates the roots and never restarts the backend");

  // Cross the real extension-host/webview boundary in both directions. The jsdom suite proves the
  // actual buttons emit these messages; this installed-host layer proves that correlated permission
  // and plan requests reach the live webview and that each response reaches the child exactly once.
  const posted = () => testApi.testOnlyPostedMessages(testToken);
  const beforeChanges = posted().filter(item => item.type === "workspace_changes" && item.fileCount === 1).length;
  await testApi.testOnlyWebviewMessage(testToken, { type: "webviewReady" });
  try {
    await waitFor(() => posted().filter(item => item.type === "workspace_changes" && item.fileCount === 1).length > beforeChanges
      && backendCommands(backendLogPath).some(command => command.type === "get_workspace_changes"));
  } catch {
    throw new Error("Change inspection did not complete: " + JSON.stringify({ beforeChanges,
      changes: posted().filter(item => item.type === "workspace_changes").length,
      posted: posted().slice(-25), commands: backendCommands(backendLogPath).slice(-25).map(command => command.type) }));
  }
  await waitFor(() => posted().some(item => item.type === "chat_changes" && item.fileCount === 0));
  assert.ok(backendCommands(backendLogPath).some(command => command.type === "get_chat_changes"));
  await testApi.testOnlyWebviewMessage(testToken, { type: "reviewChange", path: `${basename(primaryRoot)}/host-change.ts` });
  await waitFor(() => backendCommands(backendLogPath).some(command =>
    command.type === "get_workspace_change" && command.root === primaryRoot && command.path === "host-change.ts"));
  await waitFor(() => vscode.window.visibleTextEditors.some(editor =>
    editor.document.uri.scheme === "dgc-review" && editor.document.getText() === "export const changed = true;\n"));
  assert.equal(posted().some(item => ["workspace_changes", "workspace_change"].includes(item.eventType)), false,
    "raw roots and preview bodies must not be forwarded as webview chat events");
  assert.throws(() => testApi.testOnlyPostedMessages("wrong-token"), /unavailable/,
    "the installed-host bridge must reject a caller outside its isolated test token");
  await assert.rejects(() => testApi.testOnlyWebviewMessage("wrong-token", { type: "cancel" }),
    /unavailable/, "the installed-host bridge must not accept an unauthenticated message");
  await testApi.testOnlyWebviewMessage(testToken,
    { type: "prompt", text: "installed-host decision lifecycle" });
  await waitFor(() => posted().some((item) =>
    item.type === "event" && item.eventType === "permission_request"
      && item.id === "host-permission"));
  await testApi.testOnlyWebviewMessage(testToken,
    { type: "permission_response", id: "host-permission", decision: "once" });
  await waitFor(() => backendCommands(backendLogPath).some((command) =>
    command.type === "permission_response" && command.id === "host-permission"
      && command.decision === "once"));
  await waitFor(() => posted().some((item) =>
    item.type === "event" && item.eventType === "plan_proposal" && item.id === "host-plan"));
  const feedback = "Keep the public API stable.";
  await testApi.testOnlyWebviewMessage(testToken,
    { type: "plan_response", id: "host-plan", decision: "reject", feedback });
  await waitFor(() => backendCommands(backendLogPath).some((command) =>
    command.type === "plan_response" && command.id === "host-plan"
      && command.decision === "reject" && command.feedback === feedback));
  await waitFor(() => posted().some((item) =>
    item.type === "event" && item.eventType === "options_request" && item.id === "host-questions"));
  const answers = { storage: { selected: [0], other: "" }, accent: { selected: [], other: "Custom lavender" } };
  await testApi.testOnlyWebviewMessage(testToken,
    { type: "options_response", id: "host-questions", answers });
  await waitFor(() => backendCommands(backendLogPath).some((command) =>
    command.type === "options_response" && command.id === "host-questions"));
  assert.deepEqual(backendCommands(backendLogPath).filter((command) =>
    command.type === "options_response" && command.id === "host-questions").map((command) => ({
    answers: command.answers, dismissed: command.dismissed, choice: command.choice })),
  [{ answers, dismissed: undefined, choice: undefined }], "the structured answers reach the backend exactly once, as sent");
  await waitFor(() => posted().some((item) =>
    item.type === "event" && item.eventType === "turn_end"));
  assert.ok(posted().some((item) => item.eventType === "request_expired"
    && item.id === "host-permission"), "permission resolution must retire its exact webview card");
  assert.ok(posted().some((item) => item.eventType === "request_expired" && item.id === "host-plan"),
    "plan resolution must retire its exact webview card");

  // A late replay crosses the same extension API but must be rejected by the backend correlator.
  await testApi.testOnlyWebviewMessage(testToken,
    { type: "permission_response", id: "host-permission", decision: "once" });
  await testApi.testOnlyWebviewMessage(testToken,
    { type: "plan_response", id: "host-plan", decision: "reject", feedback: "late" });
  await testApi.testOnlyWebviewMessage(testToken,
    { type: "options_response", id: "host-questions", answers });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const decisionCommands = backendCommands(backendLogPath);
  assert.equal(decisionCommands.filter((command) =>
    command.type === "permission_response" && command.id === "host-permission").length, 1,
  "one installed-host permission request must reach the backend at most once");
  assert.equal(decisionCommands.filter((command) =>
    command.type === "plan_response" && command.id === "host-plan").length, 1,
  "one installed-host plan request must reach the backend at most once");
  assert.equal(decisionCommands.filter((command) =>
    command.type === "options_response" && command.id === "host-questions").length, 1,
  "a late question answer is rejected by the correlator");

  const beforeWorkflow = posted().filter(item => item.eventType === "turn_end").length;
  await testApi.testOnlyWebviewMessage(testToken, { type: "prompt", text: "/review --staged host workflow",
    requestId: "host-workflow", skills: ["verify"],
    context: [{ type: "mcp_context", server: "docs", uri: "docs://workflow", text: "Workflow snapshot" }] });
  await waitFor(() => posted().filter(item => item.eventType === "turn_end").length > beforeWorkflow);
  const workflowCommand = backendCommands(backendLogPath).find(command => command.request_id === "host-workflow");
  assert.equal(workflowCommand?.workflow, "review");
  assert.equal(workflowCommand?.text, "--staged host workflow");
  assert.deepEqual(workflowCommand?.skills, ["verify"]);
  assert.ok(workflowCommand?.context.some(item => item.text === "Workflow snapshot"));

  // Exercise both awaited and fire-and-forget editor state routes. The installed backend advertises
  // correlation, so every optional query/mutation must carry a unique bounded request ID.
  const turnsBeforeGoal = posted().filter((item) => item.type === "event"
    && item.eventType === "turn_end").length;
  await testApi.testOnlyWebviewMessage(testToken, { type: "setMode", mode: "plan" });
  await testApi.testOnlyWebviewMessage(testToken, { type: "setThink", level: "high" });
  await testApi.testOnlyWebviewMessage(testToken, { type: "startGoal", text: "host matrix", requestId: "host-goal-input",
    skills: ["verify"], context: [{ type: "mcp_context", server: "docs", uri: "docs://fixture", text: "Selected fixture context" }] });
  await testApi.testOnlyWebviewMessage(testToken, { type: "slashText", text: "/view-plan" });
  await testApi.testOnlyWebviewMessage(testToken, { type: "slashText", text: "/status" });
  const correlatedTypes = new Set(["set_mode", "set_think", "start_goal", "get_plan", "status"]);
  await waitFor(() => {
    const commands = backendCommands(backendLogPath);
    const seen = new Set(commands
      .filter((command) => correlatedTypes.has(command.type)).map((command) => command.type));
    return [...correlatedTypes].every((type) => seen.has(type))
      && commands.some((command) => command.type === "start_goal" && command.text === "host matrix");
  });
  const goalStartCommands = backendCommands(backendLogPath);
  const startGoal = goalStartCommands.find(command => command.type === "start_goal" && command.text === "host matrix");
  assert.ok(startGoal, "the host must submit the complete goal as one backend command");
  assert.equal(startGoal.request_id, "host-goal-input");
  assert.deepEqual(startGoal.skills, ["verify"]);
  assert.ok(startGoal.context.some(item => item.type === "mcp_context" && item.text === "Selected fixture context"));
  assert.equal(goalStartCommands.some(command => command.type === "set_goal" && command.text === "host matrix"), false);
  await waitFor(() => posted().some((item) => item.type === "event"
    && item.eventType === "turn_start"));
  // Clear pressed while the goal's turn runs: the webview never disables it now, so the host must
  // relay it at once, correlated, and pass an older CLI's refusal back to the webview (which shows
  // it beside the Tasks row -- webview.test.mjs covers that note).
  await testApi.testOnlyWebviewMessage(testToken, { type: "clear_todos" });
  await waitFor(() => backendCommands(backendLogPath).some((command) => command.type === "clear_todos"));
  const clearCommand = backendCommands(backendLogPath).find((command) => command.type === "clear_todos");
  assert.match(String(clearCommand.request_id || ""), /^clear-todos-/,
    "the mid-turn Clear must reach the backend with its own correlation id");
  await waitFor(() => posted().some((item) => item.type === "event"
    && item.eventType === "command_rejected" && item.command === "clear_todos"));
  const initialGoalPrompts = goalStartCommands.filter((command) => command.type === "prompt"
    && command.text === "host matrix").length;
  await testApi.testOnlyWebviewMessage(testToken, { type: "pauseGoal" });
  await waitFor(() => backendCommands(backendLogPath).some((command) =>
    command.type === "set_goal" && command.status === "paused"));
  const pausedCommands = backendCommands(backendLogPath);
  const pauseCancelIndex = pausedCommands.findIndex((command) => command.type === "cancel");
  const pauseSetIndex = pausedCommands.findIndex((command) => command.type === "set_goal"
    && command.status === "paused");
  assert.ok(pauseCancelIndex !== -1 && pauseSetIndex > pauseCancelIndex,
    "pausing an active goal must stop its turn before crossing the backend's busy mutation gate");
  assert.equal(posted().filter((item) => item.eventType === "command_rejected"
    && item.command === "set_goal").length, 0,
  "the installed-host pause lifecycle must not race a goal mutation into an active turn");
  await waitFor(() => posted().filter((item) => item.type === "event"
    && item.eventType === "turn_end").length > turnsBeforeGoal);
  const turnsBeforeResume = posted().filter((item) => item.type === "event"
    && item.eventType === "turn_end").length;
  // Resuming used to re-send the objective as a fresh prompt, so text written days earlier
  // reappeared in the chat and the model read it as a new request. The backend owns resuming now.
  const promptsBeforeResume = backendCommands(backendLogPath).filter((command) =>
    command.type === "prompt" && command.text === "host matrix").length;
  await testApi.testOnlyWebviewMessage(testToken, { type: "resumeGoal" });
  await waitFor(() => backendCommands(backendLogPath).some((command) =>
    command.type === "resume_goal"));
  assert.equal(backendCommands(backendLogPath).filter((command) =>
    command.type === "prompt" && command.text === "host matrix").length, promptsBeforeResume,
  "resuming a goal must not replay the objective as a user prompt");
  // Editing an active goal saves the revised objective and carries on with it. The revision is
  // in the system prompt from the moment set_goal lands, so replaying it as a user message would
  // duplicate it -- the same reason resuming no longer does.
  const promptsBeforeEdit = backendCommands(backendLogPath)
    .filter((command) => command.type === "prompt").length;
  const resumesBeforeEdit = backendCommands(backendLogPath)
    .filter((command) => command.type === "resume_goal").length;
  await testApi.testOnlyWebviewMessage(testToken,
    { type: "updateGoal", text: "host matrix refined" });
  await waitFor(() => backendCommands(backendLogPath).some((command) =>
    command.type === "set_goal" && command.text === "host matrix refined"));
  await waitFor(() => backendCommands(backendLogPath)
    .filter((command) => command.type === "resume_goal").length > resumesBeforeEdit);
  const edited = backendCommands(backendLogPath);
  const editSetIndex = edited.findLastIndex((command) => command.type === "set_goal"
    && command.text === "host matrix refined");
  const editResumeIndex = edited.findLastIndex((command) => command.type === "resume_goal");
  assert.ok(editResumeIndex > editSetIndex,
    "editing an active goal must save the revision before continuing the run");
  assert.equal(edited.filter((command) => command.type === "prompt").length, promptsBeforeEdit,
    "editing an active goal must not replay the objective as a user prompt");
  await testApi.testOnlyWebviewMessage(testToken, { type: "clearGoal" });
  await waitFor(() => backendCommands(backendLogPath).some((command) =>
    command.type === "set_goal" && command.text === "" && command.status === "none"));
  const correlated = backendCommands(backendLogPath)
    .filter((command) => correlatedTypes.has(command.type));
  assert.ok(correlated.every((command) =>
    typeof command.request_id === "string" && command.request_id.length > 0
      && command.request_id.length <= 128),
  "negotiated editor state/query commands must carry bounded request IDs");
  assert.equal(new Set(correlated.map((command) => command.request_id)).size, correlated.length,
    "editor state/query request IDs must remain unique across concurrent UI paths");

  // Activate a delegated route through the real config event, then cross the installed extension
  // boundary for every model/thinking surface. Vendor model discovery must stay local to the
  // engine metadata instead of touching the native endpoint.
  const settingsPosts = posted().filter((item) => item.type === "settings_open").length;
  await testApi.testOnlyWebviewMessage(testToken, { type: "openSettings" });
  await waitFor(() => posted().filter((item) => item.type === "settings_open").length > settingsPosts);
  const nativeListCount = backendCommands(backendLogPath)
    .filter((command) => command.type === "list_models").length;
  await testApi.testOnlyWebviewMessage(testToken, { type: "listModels" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(backendCommands(backendLogPath)
    .filter((command) => command.type === "list_models").length, nativeListCount,
  "the active subscription picker must not query the native model endpoint");

  await testApi.testOnlyWebviewMessage(testToken, { type: "setModel", model: "vendor-direct" });
  await testApi.testOnlyWebviewMessage(testToken, { type: "setThink", level: "high" });
  await testApi.testOnlyWebviewMessage(testToken, { type: "slashText", text: "/model vendor-slash" });
  await testApi.testOnlyWebviewMessage(testToken, { type: "slashText", text: "/think xhigh" });
  await waitFor(() => {
    const changes = backendCommands(backendLogPath).filter((command) => command.type === "set_config");
    return changes.some((command) => command.values?.subscription_model === "vendor-direct")
      && changes.some((command) => command.values?.subscription_model === "vendor-slash")
      && changes.some((command) => command.values?.subscription_effort === "high")
      && changes.some((command) => command.values?.subscription_effort === "xhigh");
  });
  const delegatedChanges = backendCommands(backendLogPath)
    .filter((command) => command.type === "set_config"
      && (hasOwn(command.values || {}, "subscription_model")
        || hasOwn(command.values || {}, "subscription_effort")));
  assert.ok(delegatedChanges.every((command) =>
    typeof command.request_id === "string" && command.request_id.length > 0),
  "delegated editor controls must retain correlated state acknowledgements");

  // ---- background monitors: an unsolicited monitor turn, a user action racing it, and Stop ----
  // Evidence is a bounded window, so order is read relative to the newest monitor_event.
  const afterMonitorEvent = () => {
    const items = posted();
    const at = items.map((item) => item.eventType).lastIndexOf("monitor_event");
    return at === -1 ? [] : items.slice(at + 1).map((item) => item.eventType);
  };
  const compactsBefore = backendCommands(backendLogPath).filter((command) => command.type === "compact").length;
  await testApi.testOnlyWebviewMessage(testToken, { type: "prompt", text: "host monitor probe" });
  await waitFor(() => afterMonitorEvent().includes("monitors"));
  assert.ok(posted().some((item) => item.type === "event" && item.eventType === "monitor_started"),
    "monitor_started reaches the webview");
  assert.equal(afterMonitorEvent().includes("turn_end"), false, "the wake turn is still running");
  // Compact while only a monitor turn runs: the panel sends it (the backend yields) instead of
  // answering "waits until the current turn is complete".
  await testApi.testOnlyWebviewMessage(testToken, { type: "slash", action: "compact" });
  await waitFor(() => backendCommands(backendLogPath).filter((command) => command.type === "compact").length > compactsBefore);
  await waitFor(() => afterMonitorEvent().includes("turn_end"));
  await waitFor(() => posted().some((item) => item.type === "event" && item.eventType === "compacted"));
  await testApi.testOnlyWebviewMessage(testToken, { type: "stopMonitor", id: "mon1" });
  await waitFor(() => backendCommands(backendLogPath).some((command) =>
    command.type === "stop_monitor" && command.id === "mon1"));
  const stopCommand = backendCommands(backendLogPath).find((command) => command.type === "stop_monitor");
  assert.match(String(stopCommand.request_id || ""), /^monitor-stop-/,
    "Stop on a monitor chip is a correlated stop_monitor command");
  await waitFor(() => posted().some((item) => item.type === "event" && item.eventType === "monitor_ended"));
  await testApi.testOnlyWebviewMessage(testToken, { type: "slashText", text: "/monitors" });
  await waitFor(() => backendCommands(backendLogPath).some((command) =>
    command.type === "list_monitors" && /^monitors-list-/.test(String(command.request_id || ""))));

  // ---- 0.40 agents (installed-host checks; run before the backend-exit paths below) ----
  {
    // What the live pill shows, read through the test-only probe (the webview answers, the host
    // records it with the delivery evidence).
    const probe = async () => {
      const before = posted().filter((item) => item.type === "agentsProbeResult").length;
      await testApi.testOnlyWebviewMessage(testToken, { type: "agentsProbeRequest" });
      await waitFor(() => posted().filter((item) => item.type === "agentsProbeResult").length > before);
      return posted().filter((item) => item.type === "agentsProbeResult").at(-1);
    };
    const protocolStops = () => logCount(/\[extension: stopping the backend — protocol:/);
    const stopsBefore = protocolStops();

    // A turn with two task sub-agents, one waiting on a permission card: every frame is accepted.
    await testApi.testOnlyWebviewMessage(testToken, { type: "prompt", text: "host agents probe" });
    await waitFor(() => posted().some((item) => item.eventType === "permission_request" && item.id === "agents-permission"));
    const waitingProbe = await probe();
    assert.deepEqual([waitingProbe.state, waitingProbe.label], ["waiting", "2 agents"],
      "an agent waiting on a permission card turns the pill blue");
    await testApi.testOnlyWebviewMessage(testToken, { type: "permission_response", id: "agents-permission", decision: "once" });
    await waitFor(() => {
      const items = posted();
      const ended = items.map((item) => item.eventType).lastIndexOf("agent_ended");
      return ended !== -1 && items.slice(ended).some((item) => item.eventType === "turn_end");
    });
    const agentFrames = posted().filter((item) => ["agent_started", "agent_updated", "agent_ended"].includes(item.eventType));
    assert.ok(agentFrames.filter((item) => item.eventType === "agent_started").length >= 2, "agent_started reaches the webview");
    assert.ok(agentFrames.filter((item) => item.eventType === "agent_ended").length >= 2, "agent_ended reaches the webview");
    assert.equal(protocolStops(), stopsBefore, "the extension accepts every agents frame");
    const idleProbe = await probe();
    assert.equal(idleProbe.state, "hidden", "successful agents leave the composer when they finish");

    // A reloaded webview asks the backend for the list again.
    const restores = () => backendCommands(backendLogPath).filter((command) => command.type === "list_agents"
      && /^agents-restore-/.test(String(command.request_id || ""))).length;
    const restoresBefore = restores();
    await testApi.testOnlyWebviewMessage(testToken, { type: "webviewReady" });
    await waitFor(() => restores() > restoresBefore);
    await waitFor(() => posted().some((item) => item.eventType === "agents"));
    const restoredProbe = await probe();
    assert.equal(restoredProbe.state, "hidden", "restoring finished history does not revive the composer count");

    // A new chat hides it.
    await testApi.testOnlyWebviewMessage(testToken, { type: "slash", action: "new" });
    await waitFor(() => backendCommands(backendLogPath).some((command) => command.type === "new_session"));
    await waitFor(() => posted().some((item) => item.eventType === "session"));
    await sleep(100);
    assert.equal((await probe()).state, "hidden", "/new hides the pill");

    // The backend exits with two agents running: the pill turns idle, and once the new backend has
    // answered list_agents with an empty chat, it is hidden.
    const exitsBefore = posted().filter((item) => item.type === "backend_exit").length;
    await testApi.testOnlyWebviewMessage(testToken, { type: "prompt", text: "host agents exit probe" });
    await waitFor(() => posted().filter((item) => item.type === "backend_exit").length > exitsBefore, 15_000);
    const stoppedProbe = await probe();
    assert.deepEqual([stoppedProbe.state, stoppedProbe.label], ["idle", "2 agents"],
      "agents of a backend that exited are stopped, not working");
    const restoresBeforeRestart = restores();
    await waitFor(() => restores() > restoresBeforeRestart, 15_000);
    await waitFor(() => rootsCommands().length > 0);
    await sleep(1500);
    assert.equal((await probe()).state, "hidden", "the new backend's empty list hides the pill");
    assert.equal(protocolStops(), stopsBefore);

    // A frame with a field the contract does not name stops the backend with the malformed-frame
    // message, like any other protocol violation. A fresh backend is started for the checks below.
    await sleep(1500);
    await testApi.testOnlyWebviewMessage(testToken, { type: "prompt", text: "host agents stray field" });
    await waitFor(() => /\[extension: stopping the backend — protocol: dgc backend violated protocol v14: agent_started has undeclared field "foo"/
      .test(backendLogText()), 15_000);
    const startedAfterStray = startedCount();
    await vscode.commands.executeCommand("dgc.restart");
    await waitFor(() => startedCount() > startedAfterStray, 15_000);
    await sleep(1500);
  }
  // ---- end 0.40 agents ----

  // ---- 0.40 images (installed-host checks) ----
  {
    const hostImages = JSON.parse(process.env.DGC_EXTENSION_TEST_IMAGES || "{}");
    const [good, outside, symlink, notImage] = Object.keys(hostImages);
    assert.ok(good && outside && symlink && notImage, "the host runner must prepare the stored images");
    const { realpathSync } = require("node:fs");
    const shown = [];
    const showInformationMessage = vscode.window.showInformationMessage;
    vscode.window.showInformationMessage = (message, ...rest) => {
      shown.push(String(message));
      return showInformationMessage.call(vscode.window, message, ...rest);
    };
    const tabPaths = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .map((tab) => tab.input && tab.input.uri && tab.input.uri.fsPath).filter(Boolean);
    try {
      await testApi.testOnlyWebviewMessage(testToken, { type: "prompt", text: "host images probe" });
      await waitFor(() => posted().some((item) => item.type === "event" && item.eventType === "tool_images"));
      await testApi.testOnlyWebviewMessage(testToken, { type: "getImage", requestId: "host-image-1", ref: good });
      await waitFor(() => backendCommands(backendLogPath).some((command) =>
        command.type === "get_image" && command.request_id === "host-image-1" && command.ref === good));
      await waitFor(() => posted().some((item) => item.type === "event" && item.eventType === "image"));

      await testApi.testOnlyWebviewMessage(testToken, { type: "openImage", ref: good });
      await waitFor(() => tabPaths().includes(realpathSync(hostImages[good])));
      for (const ref of [outside, symlink, notImage]) {
        const before = shown.length;
        const tabsBefore = tabPaths().length;
        await testApi.testOnlyWebviewMessage(testToken, { type: "openImage", ref });
        await waitFor(() => shown.length > before);
        assert.equal(shown.at(-1), "That image is no longer available.", `${hostImages[ref]} is refused`);
        assert.ok(!shown.at(-1).includes(hostImages[ref]), "the path is never echoed");
        assert.equal(tabPaths().length, tabsBefore, "and nothing opens");
      }
      // Open file asked the backend itself for the refs the panel had no path for yet: those answers
      // (full data URIs from a real backend) stay in the host.
      await waitFor(() => backendCommands(backendLogPath).filter((command) =>
        command.type === "get_image" && /^open-image-/.test(String(command.request_id || ""))).length >= 3);
      const relayed = posted().filter((item) => item.eventType === "image").map((item) => item.id);
      assert.ok(relayed.includes("host-image-1"), "the webview's own get_image answer reaches the webview");
      assert.deepEqual(relayed.filter((id) => /^open-image-/.test(id)), [],
        "Open file's answers stay in the host");
      const refused = shown.length;
      await testApi.testOnlyWebviewMessage(testToken, { type: "openImage", ref: "img_" + "9".repeat(32) });
      await waitFor(() => shown.length > refused);
      assert.equal(shown.at(-1), "That image is no longer available.", "a ref the panel was never shown");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    } finally {
      vscode.window.showInformationMessage = showInformationMessage;
    }
  }
  // ---- end 0.40 images ----

  // ---- 0.40 options (installed-host checks) ----
  {
    const turnEnds = () => posted().filter((item) => item.eventType === "turn_end").length;
    const before = turnEnds();
    await testApi.testOnlyWebviewMessage(testToken, { type: "prompt", text: "installed-host question dismissal" });
    await waitFor(() => posted().some((item) =>
      item.type === "event" && item.eventType === "options_request" && item.id === "host-dismiss"));
    await testApi.testOnlyWebviewMessage(testToken, { type: "options_response", id: "host-dismiss", dismissed: true });
    await waitFor(() => turnEnds() > before);
    await testApi.testOnlyWebviewMessage(testToken, { type: "options_response", id: "host-dismiss", dismissed: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const dismissals = backendCommands(backendLogPath).filter((command) =>
      command.type === "options_response" && command.id === "host-dismiss");
    assert.deepEqual(dismissals.map((command) => ({ dismissed: command.dismissed, answers: command.answers })),
      [{ dismissed: true, answers: undefined }], "a dismissal arrives as sent, once");
    assert.ok(posted().some((item) => item.eventType === "options_resolved" && item.id === "host-dismiss"),
      "options_resolved reaches the webview");
  }
  // ---- end 0.40 options ----

  // ---- backend exits in the installed host: every path names its cause in backend.log ----------
  const control = process.env.DGC_EXTENSION_TEST_CONTROL;
  const altBackend = process.env.DGC_EXTENSION_TEST_BACKEND_ALT;
  assert.ok(control && altBackend, "the host runner must provide the exit-path control file");
  assert.match(backendLogText(), /\[extension: restarting the backend — command DGC: Restart Backend\]/,
    "DGC: Restart Backend names itself");
  assert.match(backendLogText(), /extension asked for it: yes \(restart: command DGC: Restart Backend\)/);
  const unassisted = () => logCount(/extension asked for it: no/);
  const resumes = () => backendCommands(backendLogPath).filter((command) => command.type === "resume_session").length;

  // 1. The backend dies on its own: logged "no" with its own cause, recovered, session restored.
  let started = startedCount();
  let noCount = unassisted();
  const resumesBeforeDeath = resumes();
  writeFileSync(control, "die-on-own");
  await testApi.testOnlyWebviewMessage(testToken, { type: "prompt", text: "host death probe" });
  await waitFor(() => unassisted() > noCount, 15_000);
  assert.match(backendLogText(), /serve loop ended: fixture died on its own/,
    "the backend's own stderr cause lands next to the exit line");
  await waitFor(() => startedCount() > started, 15_000);
  await waitFor(() => resumes() > resumesBeforeDeath, 15_000);
  assert.ok(posted().some((item) => item.type === "backend_exit"), "the webview is told the backend stopped");

  // 2. A protocol failure is asked-for with its cause, is not auto-recovered, and the NEXT child's
  //    own death is still "no" and recovered (the stale-intentional regression).
  await waitFor(() => backendCommands(backendLogPath).filter((command) => command.type === "set_workspace_roots").length > 0);
  await sleep(1500);
  started = startedCount();
  writeFileSync(control, "malformed-then-ok");
  await testApi.testOnlyWebviewMessage(testToken, { type: "prompt", text: "host malformed probe" });
  await waitFor(() => /\[extension: stopping the backend — protocol: dgc backend emitted malformed NDJSON/.test(backendLogText()), 15_000);
  await waitFor(() => /extension asked for it: yes \(protocol: dgc backend emitted malformed NDJSON/.test(backendLogText()), 15_000);
  await sleep(1500);
  assert.equal(startedCount(), started, "a protocol failure is not respawned behind the user's back");
  noCount = unassisted();
  writeFileSync(control, "die-on-own");
  await testApi.testOnlyWebviewMessage(testToken, { type: "prompt", text: "host fresh generation" });
  await waitFor(() => startedCount() > started, 15_000);
  await waitFor(() => unassisted() > noCount, 15_000);
  await waitFor(() => startedCount() > started + 1, 15_000);

  // 3. A child that closes its stdin and lingers while the host keeps writing: its exit is still
  //    reported (the EPIPE path used to swallow it) and the panel recovers.
  await sleep(2500);
  started = startedCount();
  noCount = unassisted();
  writeFileSync(control, "close-stdin-and-linger");
  await testApi.testOnlyWebviewMessage(testToken, { type: "prompt", text: "host linger probe" });
  for (let i = 0; i < 8; i += 1) {
    await sleep(60);
    await testApi.testOnlyWebviewMessage(testToken, { type: "slashText", text: "/status" }).catch(() => {});
  }
  await waitFor(() => unassisted() > noCount, 15_000);
  await waitFor(() => startedCount() > started, 15_000);

  // 4. dgc.command: a workspace-scope value DGC ignores changes nothing; a user-scope change
  //    restarts with its reason.
  await sleep(2500);
  started = startedCount();
  const commandRestart = /\[extension: restarting the backend — setting dgc\.command changed\]/;
  const commandRestarts = logCount(commandRestart);
  let workspaceWrite = "applied";
  try {
    await config.update("command", altBackend, vscode.ConfigurationTarget.Workspace);
  } catch {
    workspaceWrite = "refused";                // a machine-scoped setting may not be writable there
  }
  await sleep(1500);
  assert.equal(logCount(commandRestart), commandRestarts,
    `a workspace-scope dgc.command edit (${workspaceWrite}) must not restart the backend`);
  assert.equal(startedCount(), started);
  if (workspaceWrite === "applied") {
    await config.update("command", undefined, vscode.ConfigurationTarget.Workspace);
  }
  await config.update("command", altBackend, vscode.ConfigurationTarget.Global);
  await waitFor(() => logCount(commandRestart) > commandRestarts, 15_000);
  await waitFor(() => startedCount() > started, 15_000);
  await config.update("command", backendPath, vscode.ConfigurationTarget.Global);
  await waitFor(() => logCount(commandRestart) > commandRestarts + 1, 15_000);

  // 5. DGC: Add File to DGC from the palette with an image open in VS Code's image preview. That
  //    editor is a custom editor with no activeTextEditor, and the command used to answer "Open or
  //    select a file to add it to DGC." with the image in front of you.
  const imagePath = join(primaryRoot, "host-add-file.png");
  writeFileSync(imagePath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
  const imageUri = vscode.Uri.file(imagePath);
  await vscode.commands.executeCommand("vscode.openWith", imageUri, "imagePreview.previewEditor");
  await waitFor(() => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom && input.uri.fsPath === imageUri.fsPath;
  }, 15_000);
  assert.equal(vscode.window.activeTextEditor, undefined, "the image preview is not a text editor");
  const attachesBefore = testApi.testOnlyPostedMessages(testToken).filter((m) => m.type === "attach").length;
  await vscode.commands.executeCommand("dgc.addFile");
  await waitFor(() => testApi.testOnlyPostedMessages(testToken)
    .filter((m) => m.type === "attach").slice(attachesBefore)
    .some((m) => /host-add-file\.png$/.test(m.label || "")), 15_000);
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  const resultPath = process.env.DGC_EXTENSION_TEST_RESULT;
  assert.ok(resultPath, "the host runner must provide a result path");
  writeFileSync(resultPath, JSON.stringify({ activated: true, commands: declared.length,
    handshake: true, multiRootLifecycle: true, secretStorageLifecycle: true,
    decisionLifecycle: true, backendExitLifecycle: true, monitorLifecycle: true, addFileFromImagePreview: true, vscodeVersion: vscode.version, appName: vscode.env.appName }));
}

module.exports = { run };
