"use strict";

// Runs inside a real VS Code extension host (invoked by run-extension-host-images.mjs) against the
// real `dgc serve`, a scripted model and a local page for the browser tool.
const assert = require("node:assert/strict");
const { readdirSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const vscode = require("vscode");

async function waitFor(predicate, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function sessionImages(home) {
  const root = join(home, ".dgc", "sessions");
  for (const slug of readdirSync(root)) {
    for (const file of readdirSync(join(root, slug)).filter((name) => name.endsWith(".json"))) {
      const record = JSON.parse(readFileSync(join(root, slug, file), "utf8"));
      if (Array.isArray(record.images) && record.images.length) return { records: record.images, store: join(root, slug, file.replace(/\.json$/, ".images")) };
    }
  }
  return { records: [], store: "" };
}

async function run() {
  const token = process.env.DGC_EXTENSION_TEST_TOKEN;
  const resultPath = process.env.DGC_EXTENSION_TEST_RESULT;
  const pageUrl = process.env.DGC_IMAGES_PAGE;
  const home = process.env.DGC_IMAGES_HOME;
  assert.ok(token && resultPath && pageUrl && home, "the images runner must provide its bridge token, page and HOME");
  const extension = vscode.extensions.getExtension("vibedgc.dgc");
  assert.ok(extension, "the DGC development extension must be discoverable");
  const testApi = await extension.activate();
  await vscode.commands.executeCommand("dgc.focus");
  const posted = () => testApi.testOnlyPostedMessages(token);
  const events = (type) => posted().filter((item) => item.type === "event" && (!type || item.eventType === type));
  const describe = () => JSON.stringify(events().slice(-40));
  const step = (promise) => promise.catch((error) => { throw new Error(`${error.message}: ${describe()}`); });

  await step(waitFor(() => events("ready").length > 0, "the real backend's ready event", 90_000));
  await testApi.testOnlyWebviewMessage(token, { type: "webviewReady" });
  await testApi.testOnlyWebviewMessage(token, { type: "prompt", text: `Open ${pageUrl} in the browser and take a screenshot of the page.` });
  await step(waitFor(() => events("tool_images").length > 0, "tool_images from the screenshot", 120_000));
  await step(waitFor(() => events("turn_end").length > 0, "the first turn to end", 90_000));
  await testApi.testOnlyWebviewMessage(token, { type: "prompt", text: "thanks, anything else on it?" });
  await step(waitFor(() => events("turn_end").length > 1, "the second turn to end", 90_000));

  // The stored copy comes back by ref, and Open file opens it (the host resolves the path itself).
  await step(waitFor(() => sessionImages(home).records.length > 0, "the session's image index", 20_000));
  const { records, store } = sessionImages(home);
  const ref = records[0].ref;
  await testApi.testOnlyWebviewMessage(token, { type: "getImage", requestId: "host-images-1", ref });
  await step(waitFor(() => events("image").length > 0, "the image answer", 20_000));
  await testApi.testOnlyWebviewMessage(token, { type: "openImage", ref });
  const stored = realpathSync(join(store, `${ref.slice(4)}.png`));
  const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
    .map((tab) => tab.input && tab.input.uri && tab.input.uri.fsPath).filter(Boolean);
  let opened = true;
  await waitFor(() => tabs().includes(stored), "the stored screenshot tab", 20_000).catch(() => { opened = false; });

  writeFileSync(resultPath, JSON.stringify({
    activated: extension.isActive === true,
    vscodeVersion: vscode.version,
    appName: vscode.env.appName,
    toolImages: events("tool_images").length,
    turnEnds: events("turn_end").length,
    imageAnswered: events("image").length > 0,
    opened,
  }));
}

module.exports = { run };
