"use strict";

// Runs inside a real VS Code extension host (invoked by run-extension-host-reconnect.mjs) against the
// real `dgc serve` and a model server that drops, cuts, and finally refuses connections.
const assert = require("node:assert/strict");
const { existsSync, writeFileSync } = require("node:fs");
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
  const closeFlag = process.env.DGC_RECONNECT_CLOSE_FLAG;
  assert.ok(token && resultPath && closeFlag, "the reconnect runner must provide its token, result path and close flag");
  const extension = vscode.extensions.getExtension("vibedgc.dgc");
  assert.ok(extension, "the DGC development extension must be discoverable");
  const testApi = await extension.activate();
  assert.equal(typeof testApi?.testOnlyPostedMessages, "function", "test activation exposes the bridge");
  await vscode.commands.executeCommand("dgc.focus");
  const posted = () => testApi.testOnlyPostedMessages(token);
  const events = () => posted().filter((item) => item.type === "event");
  const describe = () => JSON.stringify(posted().slice(-40));
  const failIfBroken = () => {
    const exit = posted().find((item) => item.type === "backend_exit");
    if (exit) throw new Error(`the backend exited (a protocol failure kills it): ${describe()}`);
  };
  const turnEnds = () => events().filter((item) => item.eventType === "turn_end").length;

  await waitFor(() => events().some((item) => item.eventType === "ready"), "the real backend's ready event", 60_000)
    .catch((error) => { throw new Error(`${error.message}: ${describe()}`); });
  await testApi.testOnlyWebviewMessage(token, { type: "webviewReady" });

  // The bridge keeps only the newest 256 records, so a turn's frames are told apart by what is new:
  // retry ids not seen before, and errors after the last turn_end.
  async function turn(text, what) {
    const known = new Set(events().filter((item) => item.eventType === "model_retry").map((item) => item.retryId));
    const lastEnd = events().filter((item) => item.eventType === "turn_end").length;
    await testApi.testOnlyWebviewMessage(token, { type: "prompt", text });
    await waitFor(() => { failIfBroken(); return turnEnds() > lastEnd; }, what, 60_000)
      .catch((error) => { throw new Error(`${error.message}: ${describe()}`); });
    const all = events();
    const startedAt = all.map((item) => item.eventType).lastIndexOf("turn_start");
    return all.filter((item, index) => (item.eventType === "model_retry" && !known.has(item.retryId))
      || (item.eventType === "error" && index > startedAt));
  }

  // 1. A dropped request, retried and answered.
  const first = (await turn("reconnect-first: say hello", "the first turn")).filter((item) => item.eventType === "model_retry");
  assert.ok(first.length >= 2, `retry frames for the dropped request: ${JSON.stringify(first)}`);
  assert.equal(first[0].state, "retrying");
  assert.equal(first.at(-1).state, "recovered");
  assert.equal(new Set(first.map((item) => item.retryId)).size, 1, "one retry id for one run");

  // 2. A stream cut after one delta, continued.
  const second = (await turn("reconnect-second: write two halves", "the second turn")).filter((item) => item.eventType === "model_retry");
  assert.deepEqual(second.map((item) => [item.state, item.kind]), [["retrying", "stream_cut"], ["recovered", "stream_cut"]],
    `continuation frames: ${JSON.stringify(second)}`);
  assert.equal(new Set(second.map((item) => item.retryId)).size, 1);
  assert.notEqual(second[0].retryId, first[0].retryId, "a new run for a new failure");

  // 3. The server is gone: every retry is refused and the error names the cause.
  writeFileSync(closeFlag, "close");
  await waitFor(() => existsSync(closeFlag + ".done"), "the model server to close", 10_000);
  const third = await turn("reconnect-third: anyone there?", "the refused turn");
  const refusedRetries = third.filter((item) => item.eventType === "model_retry");
  const error = third.filter((item) => item.eventType === "error").at(-1);
  assert.deepEqual(refusedRetries.map((item) => [item.state, item.kind, item.attempt]),
    [["retrying", "connect", 1], ["retrying", "connect", 2], ["retrying", "connect", 3], ["gave_up", "connect", 3]],
    `refused frames: ${JSON.stringify(third)}`);
  assert.ok(error, `an error ends the refused turn: ${JSON.stringify(third)}`);
  assert.equal(error.kind, "connect");
  assert.equal(error.retryId, refusedRetries[0].retryId);
  failIfBroken();

  writeFileSync(resultPath, JSON.stringify({
    vscodeVersion: vscode.version,
    appName: vscode.env.appName,
    summary: `dropped request -> ${first.map((item) => item.state).join(", ")}; `
      + `cut stream -> ${second.map((item) => item.state).join(", ")}; `
      + `closed server -> ${refusedRetries.map((item) => item.state).join(", ")} then error cause ${error.kind}`,
  }));
}

module.exports = { run };
