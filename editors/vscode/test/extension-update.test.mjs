import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const scratch = mkdtempSync(join(tmpdir(), "dgc-extension-update-test-"));
const originalFetch = globalThis.fetch;
const state = { actions: [], installed: [], errors: [], requests: [], settings: {}, messages: [], stored: new Map() };
globalThis.__DGC_EXTENSION_UPDATE_TEST = {
  workspace: { getConfiguration: () => ({ inspect: () => state.settings }) },
  ProgressLocation: { Notification: 15 },
  Uri: { file: (path) => ({ fsPath: path }) },
  window: {
    withProgress: (_options, work) => Promise.resolve(work()),
    showInformationMessage: async (message) => { state.messages.push(message); return state.actions.shift(); },
    showErrorMessage: async (message) => { state.errors.push(message); },
  },
  commands: { executeCommand: async (name, uri) => {
    if (name === "workbench.extensions.installExtension") {
      state.installed.push({ name, path: uri.fsPath, bytes: readFileSync(uri.fsPath) });
    } else state.installed.push({ name });
  } },
};
const outfile = join(scratch, "update.cjs");
await build({ entryPoints: [new URL("../src/extensionupdate.ts", import.meta.url).pathname],
  bundle: true, outfile, platform: "node", format: "cjs", logLevel: "silent",
  plugins: [{ name: "editor", setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "editor" }));
    b.onLoad({ filter: /.*/, namespace: "editor" }, () => ({ contents: "module.exports=globalThis.__DGC_EXTENSION_UPDATE_TEST", loader: "js" }));
  } }],
});
const { extensionRelease, newer, verifyExtensionDownload, downloadBounded,
  checkForExtensionUpdates } = createRequire(import.meta.url)(outfile);
const ctx = { extension: { packageJSON: { version: "0.25.0" } }, globalState: {
  get: (key, fallback) => state.stored.get(key) ?? fallback,
  update: async (key, value) => state.stored.set(key, value),
} };
const packageBytes = Buffer.from("verified fixture package");
const checksum = createHash("sha256").update(packageBytes).digest("hex") + "  dgc.vsix\n";
beforeEach(() => {
  state.actions = []; state.installed = []; state.errors = []; state.requests = []; state.messages = [];
  state.settings = {}; state.stored.clear();
  globalThis.fetch = async (url, options) => {
    state.requests.push({ url, options });
    return new Response(url.endsWith("version.json") ? JSON.stringify({ version: "0.25.1" })
      : url.endsWith(".sha256") ? checksum : packageBytes);
  };
});
after(() => { globalThis.fetch = originalFetch; delete globalThis.__DGC_EXTENSION_UPDATE_TEST;
  rmSync(scratch, { recursive: true, force: true }); });

test("manifest URLs cannot redirect the installer to a different origin", () => {
  assert.deepEqual(extensionRelease({ version: "0.25.1", vsix: "https://attacker.invalid/file" }),
    { version: "0.25.1", url: "https://vibedgc.com/vscode/dgc-0.25.1.vsix" });
  for (const version of ["../evil", "0.25.1/evil", "1", "01.2.3", 25, null]) {
    assert.throws(() => extensionRelease({ version }));
  }
});
test("versions compare numerically and never downgrade", () => {
  assert.ok(newer("0.25.1", "0.25.0")); assert.ok(newer("0.100.0", "0.99.0"));
  assert.equal(newer("0.24.0", "0.25.0"), false); assert.equal(newer("bad", "0.25.0"), false);
});
test("checksum failures reject before any installation", () => {
  verifyExtensionDownload(packageBytes, checksum);
  assert.throws(() => verifyExtensionDownload(Buffer.from("corrupt"), checksum));
  assert.throws(() => verifyExtensionDownload(packageBytes, checksum + "extra"));
});
test("registry installs also see updates and install only after the user selects it", async () => {
  state.actions.push("Install Update", undefined);
  await checkForExtensionUpdates(ctx);
  assert.equal(state.installed.length, 1);
  assert.deepEqual(state.installed[0].bytes, packageBytes);
  assert.equal(existsSync(state.installed[0].path), false, "temporary VSIX is cleaned after installation");
  assert.equal(state.requests.length, 3);
  assert.ok(state.requests.every(r => r.options.redirect === "error"));
  assert.deepEqual(state.errors, []);
});
test("a dismissed notification never downloads or installs a package", async () => {
  await checkForExtensionUpdates(ctx);
  assert.equal(state.requests.length, 1); assert.equal(state.installed.length, 0);
});
test("the manifest binds its immutable VSIX even if the latest alias moves", async () => {
  state.actions.push("Install Update");
  globalThis.fetch = async (url) => {
    state.requests.push({ url });
    assert.ok(!url.endsWith(".sha256"), "a bound manifest must not fetch the moving alias checksum");
    return new Response(url.endsWith("version.json")
      ? JSON.stringify({ version: "0.25.1", sha256: checksum.slice(0, 64) }) : packageBytes);
  };
  await checkForExtensionUpdates(ctx);
  assert.equal(state.installed.length, 1);
  assert.equal(state.requests.length, 2);
  assert.deepEqual(state.errors, []);
  assert.throws(() => extensionRelease({ version: "0.25.1", sha256: "bad" }));
});
test("the user's setting disables background checks, but workspace settings cannot", async () => {
  state.settings = { globalValue: false, workspaceValue: true };
  await checkForExtensionUpdates(ctx); assert.equal(state.requests.length, 0);
  state.settings = { defaultValue: true, workspaceValue: false };
  await checkForExtensionUpdates(ctx); assert.equal(state.requests.length, 1);
});
test("manual compatibility recovery bypasses the daily notification gate", async () => {
  state.stored.set("dgc.updateCheckedAt", Date.now());
  await checkForExtensionUpdates(ctx); assert.equal(state.requests.length, 0);
  await checkForExtensionUpdates(ctx, true); assert.equal(state.requests.length, 1);
});
test("failed selected installs are visible and preserve the current extension", async () => {
  state.actions.push("Install Update");
  globalThis.fetch = async (url) => new Response(url.endsWith("version.json")
    ? JSON.stringify({ version: "0.25.1" }) : url.endsWith(".sha256") ? "0".repeat(64) : packageBytes);
  await checkForExtensionUpdates(ctx);
  assert.equal(state.installed.length, 0); assert.equal(state.errors.length, 1);
  assert.match(state.errors[0], /checksum/);
});
test("downloads are bounded and HTTP errors are refused", async () => {
  globalThis.fetch = async () => new Response("long response");
  await assert.rejects(downloadBounded("https://vibedgc.com/test", 3), /size limit/);
  globalThis.fetch = async () => new Response("missing", { status: 404 });
  await assert.rejects(downloadBounded("https://vibedgc.com/test", 100), /HTTP 404/);
});
