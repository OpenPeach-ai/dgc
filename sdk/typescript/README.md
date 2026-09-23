# @vibedgc/sdk

Node client for the DGC coding harness. It starts a managed `dgc serve` child with an isolated
HOME and speaks editor protocol v14. Version 0.6.5 pairs with DGC CLI 0.43.4. Node 22 or newer.

The package is on the npm registry. The identical tarball is also attached to the GitHub release
`sdk-v0.6.5` as `vibedgc-sdk-0.6.5.tgz`, for installs that pin a checksum.

```bash
npm install @vibedgc/sdk
```

```js
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DGC } from "@vibedgc/sdk";

const dgc = new DGC({
  stateDir: mkdtempSync(join(tmpdir(), "dgc-sdk-")),
  model: process.env.DGC_MODEL,          // for example "qwen3:8b"
  baseUrl: process.env.DGC_BASE_URL,     // for example "http://127.0.0.1:11434/v1"
});
try {
  const session = await dgc.session({
    cwd: process.cwd(),
    permissions: { mode: "plan", unhandled: "deny" },
  });
  const result = await session.run("Summarize this repository in two sentences.");
  console.log(result.status, result.finalText);
} finally {
  await dgc.close();
}
```

The SDK needs a DGC CLI (0.43.4 or newer). It uses `DGC_PYTHON` when set, else the installed
`dgc` launcher (on `PATH` or `~/.local/bin/dgc`, where `curl -fsSL https://vibedgc.com/install.sh | bash`
puts it), else `python3 -m dgc`. Pass `runtime: [...]` to choose explicitly.

Each session runs with a private, freshly written config: nothing left in `stateDir` is merged,
the workspace cannot grant itself capabilities (`trustWorkspace: true` opts in), the provider key
never enters the runtime's environment, and a `policy` (tool, path, network and shell limits) is
enforced by the runtime for that session only, in every permission mode. Every error is a `DGCError` subclass (`DGCConfigError`,
`DGCRuntimeError`, `DGCProtocolError`, `DGCCommandRejectedError`, `DGCTimeoutError`,
`DGCUnsupportedError`). Times are milliseconds: `run(prompt, { timeoutMs: null })` has no limit,
and `{ signal }` takes an `AbortSignal` that cancels the run.

The runtime child sees only basic variables (`PATH`, locale, terminal, temp and certificate
locations), the isolated HOME, `apiKey` and `extraEnv`. Pass `inheritEnv: ["NAME"]` (or `true`)
to hand it more of your environment.

Full reference: [docs/SDK.md](https://github.com/OpenPeach-ai/dgc/blob/sdk-v0.6.5/docs/SDK.md).
Licensed under Apache-2.0.
