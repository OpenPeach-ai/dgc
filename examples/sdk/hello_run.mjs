#!/usr/bin/env node
/** Ask one read-only question about a workspace and print the answer. Node 22 or newer.
 *
 *   npm install https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.3/vibedgc-sdk-0.5.3.tgz
 *   export DGC_MODEL=qwen3:8b DGC_BASE_URL=http://127.0.0.1:11434/v1
 *   node hello_run.mjs /path/to/workspace
 *
 * From a DGC checkout without installing: node --experimental-strip-types examples/sdk/hello_run.mjs .
 * DGC_API_KEY is passed through when the endpoint needs one; DGC_PYTHON selects the Python that
 * runs `dgc serve`.
 */
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The installed package, or this checkout's sources when it is not installed.
const { DGC } = await import("@vibedgc/sdk").catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return import("../../sdk/typescript/src/index.ts");
});

const workspace = process.argv[2];
const model = process.env.DGC_MODEL;
const baseUrl = process.env.DGC_BASE_URL;
if (!workspace || !model || !baseUrl) {
  process.stderr.write("usage: DGC_MODEL=<model> DGC_BASE_URL=<url> node hello_run.mjs WORKSPACE\n");
  process.exit(2);
}
if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
  process.stderr.write(`${workspace} is not a directory\n`);
  process.exit(2);
}

const dgc = new DGC({
  stateDir: mkdtempSync(join(tmpdir(), "dgc-sdk-hello-")),
  model,
  baseUrl,
  apiKey: process.env.DGC_API_KEY,
});
let code = 1;
try {
  // Plan mode: the agent may read and search, but it cannot edit or run commands.
  const session = await dgc.session({ cwd: workspace, permissions: { mode: "plan", unhandled: "deny" } });
  const result = await session.run("Summarize this repository in two sentences. Do not edit files.");
  console.log(`status: ${result.status} (${result.reason || "no reason"})`);
  if (result.error) console.log(`error: ${result.error}`);
  console.log(result.finalText);
  code = result.status === "completed" ? 0 : 1;
} finally {
  await dgc.close();
}
process.exit(code);
