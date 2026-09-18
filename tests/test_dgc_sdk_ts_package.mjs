#!/usr/bin/env node
/** The packed @vibedgc/sdk tarball works as an ordinary npm dependency.
 *
 * Run: node --test tests/test_dgc_sdk_ts_package.mjs
 * Needs `npm ci` in sdk/typescript (the build uses its pinned TypeScript). Without it the test
 * skips, unless DGC_REQUIRE_TS_PACKAGE=1 (CI), where a missing toolchain is a failure.
 *
 * Before 0.5.3 the tarball's main/exports pointed at src/index.ts, and Node refuses to strip
 * types under node_modules, so `npm install <tgz>` produced a package nobody could import.
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PKG = join(ROOT, "sdk", "typescript");
const TSC = join(PKG, "node_modules", "typescript", "bin", "tsc");
const REQUIRED = process.env.DGC_REQUIRE_TS_PACKAGE === "1";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  } catch (error) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${error.stdout || ""}${error.stderr || ""}`);
  }
}

function sse(delta, finish = null) {
  return "data: " + JSON.stringify({
    id: "mock", object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + "\n\n";
}

function startModel() {
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "sdk-model" }] }));
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const messages = body.messages || [];
      const last = messages.at(-1) || {};
      let payload;
      if (last.role === "tool") {
        payload = sse({ content: "Widget is in stock." }) + sse({}, "stop");
      } else {
        payload = sse({ tool_calls: [{ index: 0, id: "call_1", type: "function",
          function: { name: "mcp__app__sku_lookup", arguments: JSON.stringify({ sku: "A-1" }) } }] })
          + sse({}, "tool_calls");
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(payload + "data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  }));
}

test("npm install <packed tarball> gives an importable, typed package", async (t) => {
  if (!existsSync(TSC)) {
    if (REQUIRED) assert.fail("sdk/typescript has no node_modules; run npm ci there first");
    t.skip("run `npm ci` in sdk/typescript to build the package");
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-pack-"));
  const npmEnv = { ...process.env, npm_config_audit: "false", npm_config_fund: "false",
                   npm_config_update_notifier: "false" };
  const { server, baseUrl } = await startModel();
  try {
    const packed = JSON.parse(run(NPM, ["pack", "--json", "--pack-destination", scratch],
                                  { cwd: PKG, env: npmEnv }));
    const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    const tarball = join(scratch, packed[0].filename);
    const files = new Set(packed[0].files.map((row) => row.path));
    for (const needed of ["package.json", "LICENSE", "README.md", "dist/index.js", "dist/index.d.ts",
                          "dist/client.js", "dist/mcp-bridge.mjs"]) {
      assert.ok(files.has(needed), `${needed} is missing from the tarball`);
    }
    assert.ok(![...files].some((path) => path.endsWith(".ts") && !path.endsWith(".d.ts")),
      "the tarball must not rely on TypeScript sources");
    assert.equal(manifest.exports["."].import, "./dist/index.js");
    assert.equal(manifest.exports["."].types, "./dist/index.d.ts");

    const app = join(scratch, "app");
    run("mkdir", ["-p", app]);
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "sdk-consumer", private: true, type: "module" }));
    run(NPM, ["install", "--offline", "--no-save", tarball], { cwd: app, env: npmEnv });
    assert.ok(existsSync(join(app, "node_modules", "@vibedgc", "sdk", "dist", "index.js")));

    // Types resolve for a Node consumer (with @types/node) compiled with the package's own TypeScript.
    writeFileSync(join(app, "consumer.ts"), [
      'import { DGC, VERSION, defineTool, type RunResult } from "@vibedgc/sdk";',
      "const version: string = VERSION;",
      'const tool = defineTool("sku_lookup", "Look up a SKU", { type: "object" }, () => "ok");',
      "export async function main(dgc: DGC): Promise<RunResult> {",
      '  const session = await dgc.session({ cwd: ".", tools: [tool] });',
      '  return session.run(version);',
      "}",
      "",
    ].join("\n"));
    writeFileSync(join(app, "tsconfig.json"), JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022",
                         strict: true, noEmit: true, types: ["node"], skipLibCheck: false,
                         typeRoots: [join(PKG, "node_modules", "@types")] },
      files: ["consumer.ts"],
    }));
    run(process.execPath, [TSC, "-p", join(app, "tsconfig.json")], { cwd: app });

    // Plain `node` (no --experimental-strip-types) imports it and runs a real session, including
    // a host tool over the packaged dist/mcp-bridge.mjs relay.
    const work = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-pack-work-"));
    writeFileSync(join(work, "README.md"), "catalog\n");
    writeFileSync(join(app, "smoke.mjs"), `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DGC, VERSION, defineTool } from "@vibedgc/sdk";
const seen = [];
const tool = defineTool("sku_lookup", "Look up a SKU", { type: "object", properties: { sku: { type: "string" } } },
  (args) => { seen.push(args.sku); return { name: "Widget" }; });
const dgc = new DGC({
  stateDir: mkdtempSync(join(tmpdir(), "dgc-sdk-ts-pack-state-")),
  model: "sdk-model", baseUrl: process.env.MODEL_URL, apiKey: "sk-local",
  runtime: [process.env.DGC_PYTHON || "python3", "-m", "dgc", "serve"],
});
try {
  const session = await dgc.session({ cwd: process.env.WORK, permissions: { mode: "auto", unhandled: "deny" }, tools: [tool] });
  const result = await session.run("look up sku A-1", { timeoutMs: 60000 });
  console.log(JSON.stringify({ version: VERSION, status: result.status, text: result.finalText, seen }));
} finally {
  await dgc.close();
}
`);
    const childEnv = { ...process.env, MODEL_URL: baseUrl, WORK: work, NODE_OPTIONS: "" };
    // The installed package is not a checkout, so the runtime must find dgc on its own path.
    childEnv.PYTHONPATH = [ROOT, process.env.PYTHONPATH].filter(Boolean).join(":");
    const out = await new Promise((resolve, reject) => {
      import("node:child_process").then(({ execFile }) => {
        execFile(process.execPath, ["smoke.mjs"], { cwd: app, env: childEnv, timeout: 120_000 },
          (error, stdout, stderr) => (error ? reject(new Error(stderr || String(error))) : resolve(stdout)));
      });
    });
    const report = JSON.parse(out.trim().split("\n").at(-1));
    assert.equal(report.version, manifest.version);
    assert.equal(report.status, "completed", out);
    assert.deepEqual(report.seen, ["A-1"], "the host tool must run through the packaged relay");
    assert.match(report.text, /Widget/);
    rmSync(work, { recursive: true, force: true });
    assert.deepEqual(readdirSync(scratch).filter((name) => name.endsWith(".tgz")), [packed[0].filename]);
  } finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
