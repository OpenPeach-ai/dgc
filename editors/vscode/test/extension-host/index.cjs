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
  const primaryRoot = process.env.DGC_EXTENSION_TEST_PRIMARY_ROOT;
  const secondaryRoot = process.env.DGC_EXTENSION_TEST_SECONDARY_ROOT;
  assert.ok(backendPath && backendLogPath && primaryRoot && secondaryRoot,
    "the host runner must provide its fixture backend and workspace roots");
  assert.deepEqual((vscode.workspace.workspaceFolders || []).map((folder) => resolve(folder.uri.fsPath)),
    [resolve(primaryRoot), resolve(secondaryRoot)], "VS Code must open the two-folder fixture workspace");
  await config.update("command", backendPath, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("dgc.focus");
  const rootsCommands = () => backendCommands(backendLogPath)
    .filter((command) => command.type === "set_workspace_roots");
  await waitFor(() => rootsCommands().some((command) =>
    sameRoots(command.roots, [primaryRoot, secondaryRoot])));

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
    handshake: true, multiRootLifecycle: true }));
}

module.exports = { run };
