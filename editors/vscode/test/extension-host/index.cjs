"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
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

  await extension.activate();
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
  assert.ok(backendPath && backendLogPath && settingsPath && primaryRoot && secondaryRoot
    && changedEndpoint, "the host runner must provide its fixture backend and workspace roots");
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
  const migratedCommand = modelCommands().find((command) => command.base_url === initialEndpoint);
  assert.ok(migratedCommand, "native settings must send the configured initial endpoint");
  assert.equal(migratedCommand.api_key === fixtureSecret, true,
    "legacy plaintext must migrate through SecretStorage into backend setup");
  await waitFor(() => !hasOwn(JSON.parse(readFileSync(settingsPath, "utf8")), "dgc.apiKey"));

  // The plaintext setting is gone. A fresh backend must still receive the sentinel,
  // proving that the value survived only through the extension host's SecretStorage.
  const migratedModelCount = modelCommands().filter((command) =>
    command.base_url === initialEndpoint && command.api_key === fixtureSecret).length;
  const migratedRootCount = rootsCommands().length;
  await vscode.commands.executeCommand("dgc.restart");
  await waitFor(() => rootsCommands().length > migratedRootCount);
  await waitFor(() => modelCommands().filter((command) =>
    command.base_url === initialEndpoint && command.api_key === fixtureSecret).length
      > migratedModelCount);

  // Endpoint binding is part of the credential boundary. Moving to another host
  // must delete the prior key and send no credential to the new endpoint.
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

  const initialCount = rootsCommands().length;
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

  const resultPath = process.env.DGC_EXTENSION_TEST_RESULT;
  assert.ok(resultPath, "the host runner must provide a result path");
  writeFileSync(resultPath, JSON.stringify({ activated: true, commands: declared.length,
    handshake: true, multiRootLifecycle: true, secretStorageLifecycle: true }));
}

module.exports = { run };
