"use strict";

// Runs inside a real VS Code extension host (invoked by run-extension-host-stall.mjs) against the
// real `dgc serve` and a model server that never answers.
const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");
const vscode = require("vscode");

async function waitFor(predicate, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function run() {
  const token = process.env.DGC_EXTENSION_TEST_TOKEN;
  const resultPath = process.env.DGC_EXTENSION_TEST_RESULT;
  assert.ok(token && resultPath, "the stall runner must provide its bridge token and result path");
  const extension = vscode.extensions.getExtension("vibedgc.dgc");
  assert.ok(extension, "the DGC development extension must be discoverable");
  const testApi = await extension.activate();
  assert.equal(typeof testApi?.testOnlyPostedMessages, "function", "test activation exposes the bridge");
  await vscode.commands.executeCommand("dgc.focus");
  const posted = () => testApi.testOnlyPostedMessages(token);
  const events = () => posted().filter((item) => item.type === "event");
  const describe = () => JSON.stringify(events().slice(-30));

  // Python start-up plus the editor handshake.
  await waitFor(() => events().some((item) => item.eventType === "ready"), "the real backend's ready event", 60_000)
    .catch((error) => { throw new Error(`${error.message}: ${describe()}`); });
  await testApi.testOnlyWebviewMessage(token, { type: "webviewReady" });
  await testApi.testOnlyWebviewMessage(token, { type: "prompt", text: "hello" });

  const isNotice = (item) => item.eventType === "turn_activity" && item.label === "No response from the model";
  await waitFor(() => events().some(isNotice), "the waiting notice", 30_000)
    .catch((error) => { throw new Error(`${error.message}: ${describe()}`); });
  await waitFor(() => events().some((item) => item.eventType === "turn_end"), "the turn to end", 30_000)
    .catch((error) => { throw new Error(`${error.message}: ${describe()}`); });

  const all = events();
  const noticeIndex = all.findIndex(isNotice);
  const notice = all[noticeIndex];
  writeFileSync(resultPath, JSON.stringify({
    activated: extension.isActive === true,
    vscodeVersion: vscode.version,
    appName: vscode.env.appName,
    notice: { state: notice.state, label: notice.label, detail: notice.detail },
    errorAfterNotice: all.slice(noticeIndex).some((item) => item.eventType === "error"),
    turnEnded: all.slice(noticeIndex).some((item) => item.eventType === "turn_end"),
  }));
}

module.exports = { run };
