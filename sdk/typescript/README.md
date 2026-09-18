# @vibedgc/sdk

Node client for the DGC coding harness. It starts a managed `dgc serve` child with an isolated
HOME and speaks editor protocol v14. Version 0.5.3 pairs with DGC CLI 0.41.6. Node 22 or newer.

The package is attached to the GitHub release `sdk-v0.5.3` as `vibedgc-sdk-0.5.3.tgz`. It is not
on the npm registry yet.

```bash
npm install https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.3/vibedgc-sdk-0.5.3.tgz
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

The SDK needs a DGC runtime: a Python that can run `python -m dgc serve`. For the CLI from
`curl -fsSL https://vibedgc.com/install.sh | bash`, point `DGC_PYTHON` at the Python beside the
`dgc` launcher, or pass `runtime: ["/path/to/python", "-m", "dgc", "serve"]`:

```bash
export DGC_PYTHON="$(dirname "$(readlink -f "$(command -v dgc)")")/python"
```

Full reference: [docs/SDK.md](https://github.com/OpenPeach-ai/dgc/blob/sdk-v0.5.3/docs/SDK.md).
Licensed under Apache-2.0.
