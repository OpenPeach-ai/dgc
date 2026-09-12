"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { basename, resolve } = require("node:path");
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

  const initialCount = rootsCommands().length;
  assert.ok(rootsCommands().some(command => command.question_forms === true),
    "the installed host must opt into grouped question events when supported");
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
  const answers = { storage: "Local", accent: "Custom lavender" };
  await testApi.testOnlyWebviewMessage(testToken,
    { type: "options_response", id: "host-questions", answers });
  await waitFor(() => backendCommands(backendLogPath).some((command) =>
    command.type === "options_response" && command.id === "host-questions"
      && command.answers?.storage === answers.storage && command.answers?.accent === answers.accent));
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
  await new Promise((resolve) => setTimeout(resolve, 200));
  const decisionCommands = backendCommands(backendLogPath);
  assert.equal(decisionCommands.filter((command) =>
    command.type === "permission_response" && command.id === "host-permission").length, 1,
  "one installed-host permission request must reach the backend at most once");
  assert.equal(decisionCommands.filter((command) =>
    command.type === "plan_response" && command.id === "host-plan").length, 1,
  "one installed-host plan request must reach the backend at most once");

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

  const resultPath = process.env.DGC_EXTENSION_TEST_RESULT;
  assert.ok(resultPath, "the host runner must provide a result path");
  writeFileSync(resultPath, JSON.stringify({ activated: true, commands: declared.length,
    handshake: true, multiRootLifecycle: true, secretStorageLifecycle: true,
    decisionLifecycle: true, vscodeVersion: vscode.version, appName: vscode.env.appName }));
}

module.exports = { run };
