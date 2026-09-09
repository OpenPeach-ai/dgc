import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-mcp-auth-"));
const calls = [];
globalThis.__DGC_AUTH_VSCODE = { Uri: { parse: value => new URL(value) }, env: {} };
const api = globalThis.__DGC_AUTH_VSCODE;
const outfile = join(scratch, "auth.cjs");
await build({ entryPoints: [join(here, "../src/mcpAuth.ts")], bundle: true, outfile,
  platform: "node", format: "cjs", logLevel: "silent", plugins: [{ name: "vscode-fixture", setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
    builder.onLoad({ filter: /^vscode$/, namespace: "fixture" }, () => ({
      contents: "module.exports=globalThis.__DGC_AUTH_VSCODE", loader: "js" }));
  } }] });
const { openMcpBrowser } = createRequire(import.meta.url)(outfile);
after(() => { delete globalThis.__DGC_AUTH_VSCODE; rmSync(scratch, { recursive: true, force: true }); });
beforeEach(() => {
  calls.length = 0;
  api.env.remoteName = "ssh-remote";
  api.env.asExternalUri = async uri => { calls.push(["forward", uri.toString()]); return uri; };
  api.env.openExternal = async uri => { calls.push(["open", uri.toString()]); return true; };
});
const callbackUrl = "http://localhost:43123/oauth/callback";
const request = { callbackUrl, url: "https://auth.example.invalid/authorize?state=synthetic&redirect_uri="
  + encodeURIComponent(callbackUrl) };

test("SSH sign-in forwards the callback before opening the unchanged authorization URL", async () => {
  assert.equal(await openMcpBrowser(request, () => true), true);
  assert.deepEqual(calls, [["forward", callbackUrl], ["open", request.url]]);
});

test("unusable callback mappings fail before opening a broken authorization flow", async () => {
  for (const mapped of ["http://localhost:43124/oauth/callback", "https://proxy.example.invalid/oauth/callback",
    "http://localhost:43123/other", "http://localhost:43123/oauth/callback?access=required"]) {
    calls.length = 0;
    api.env.asExternalUri = async () => new URL(mapped);
    await assert.rejects(openMcpBrowser(request, () => true), /same local port/);
    assert.equal(calls.length, 0);
  }
});

test("generic URL requests cannot implicitly forward ports and cancellation suppresses late browser launch", async () => {
  await openMcpBrowser({ url: request.url }, () => true);
  assert.deepEqual(calls, [["open", request.url]]);
  calls.length = 0;
  let release, active = true;
  api.env.asExternalUri = () => new Promise(resolve => { release = resolve; });
  const pending = openMcpBrowser(request, () => active);
  active = false;
  release(new URL(callbackUrl));
  assert.equal(await pending, false);
  assert.deepEqual(calls, []);
});

test("callback authority and browser errors do not disclose authorization parameters", async () => {
  for (const bad of ["http://169.254.169.254:43123/oauth/callback", "http://localhost:0/oauth/callback",
    "http://localhost:43123/oauth/callback?x=1", "https://localhost:43123/oauth/callback"]) {
    await assert.rejects(openMcpBrowser({ callbackUrl: bad, url: "https://auth.example.invalid/?redirect_uri="
      + encodeURIComponent(bad) }, () => true), /callback does not match/);
  }
  await assert.rejects(openMcpBrowser({ ...request, url: request.url + "&redirect_uri=" + encodeURIComponent(callbackUrl) },
    () => true), /callback does not match/);
  assert.deepEqual(calls, []);
  api.env.remoteName = undefined;
  api.env.openExternal = async () => { throw new Error("AUTHORIZATION_SECRET_SENTINEL"); };
  await assert.rejects(openMcpBrowser(request, () => true), error => {
    assert.doesNotMatch(error.message, /AUTHORIZATION_SECRET_SENTINEL/);
    return /Reconnect/.test(error.message);
  });
});
