#!/usr/bin/env node
/** Small Node probe. Requires Node 22+ (strip-types).
 *
 *   node --experimental-strip-types examples/sdk/hello_run.mjs /path/to/workspace
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DGC } from "../../sdk/typescript/src/index.ts";

const workspace = process.argv[2];
if (!workspace) {
  process.stderr.write("usage: hello_run.mjs WORKSPACE\n");
  process.exit(2);
}

const dgc = new DGC({ stateDir: mkdtempSync(join(tmpdir(), "dgc-sdk-hello-")) });
try {
  const session = await dgc.session({
    cwd: workspace,
    permissions: { mode: "default", unhandled: "deny" },
    onPermission: () => "deny",
  });
  const result = await session.run("Summarize this repository in two sentences. Do not edit files.");
  console.log(result.status, result.reason);
  console.log(result.finalText);
  process.exit(result.status === "completed" ? 0 : 1);
} finally {
  await dgc.close();
}
