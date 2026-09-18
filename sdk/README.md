# DGC SDK

Embed the DGC coding agent in an application or a CI job. **0.5.3**, editor protocol **v14**,
pairs with CLI **0.41.6**. Proven on Linux; macOS and WSL are unproven; native Windows is
experimental. Release tag **`sdk-v0.5.3`** (not `v0.5.x`, which are historical CLI tags).

| Package | Install |
| --- | --- |
| Python `dgc-sdk` | `python3 -m pip install dgc-sdk==0.5.3` |
| Node `@vibedgc/sdk` | `npm install https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.3/vibedgc-sdk-0.5.3.tgz` |

Both drive `dgc serve` from a DGC CLI install, which they find on their own; `DGC_PYTHON` pins a
particular one (see [docs/SDK.md](../docs/SDK.md#install)). From a clone: `python3 -m pip install -e sdk/python`, and
for Node `npm ci && npm run build` in `sdk/typescript`.

```python
import os
import tempfile

from dgc_sdk import DGC

with DGC(
    state_dir=tempfile.mkdtemp(prefix="dgc-sdk-"),
    model=os.environ["DGC_MODEL"],          # for example "qwen3:8b"
    base_url=os.environ["DGC_BASE_URL"],    # for example "http://127.0.0.1:11434/v1"
    api_key=os.environ.get("DGC_API_KEY"),  # only when the endpoint needs a key
) as dgc:
    session = dgc.session(cwd=".", permissions={"mode": "plan", "unhandled": "deny"})
    result = session.run("Summarize this repository in two sentences. Do not edit files.")
    print(result.status, result.final_text)
    if result.error:
        print("error:", result.error)
```

The full guide and API reference is [docs/SDK.md](../docs/SDK.md).

| Concept | Python | TypeScript |
| --- | --- | --- |
| Client | `DGC` / `AsyncDGC` | `DGC` |
| Session | `client.session(...)` | `await client.session(...)` |
| Resume | `client.resume(session_id, ...)` or `latest=True` | `await client.resume({ sessionId } \| { latest: true })` |
| Fork | `session.fork(name)` | `await session.fork(name)` |
| Checkpoints | `session.list_checkpoints()` / `rewind(index)` | `session.listCheckpoints()` / `rewind(index)` |
| Run | `session.run(prompt)` | `await session.run(prompt)` |
| Stream | `session.stream(prompt)` | `for await (const event of session.stream(prompt))` |
| Cancel | `handle.cancel()` / `session.cancel()` | `handle.cancel()` |
| Decisions | `on_permission` / `on_plan` / `on_question` / `on_mcp_input` | `onPermission` / `onPlan` / `onQuestion` / `onMcpInput` |
| Tools | `define_tool(...)` then `session(tools=[...])` | `defineTool(...)` then `session({ tools })` |
| Schema | `session.run(..., output_schema={...})` | `session.run(prompt, { outputSchema })` |
| Usage / cost | `DGC(..., pricing=Pricing(...), department="erp")` then `dgc.usage_report()` | `dgc.usageReport(department)` |
| Policy | `DGC(..., policy=RuntimePolicy(...))` — tool, path and network limits the runtime enforces; shell commands in the OS sandbox | `policy` |
| Audit | `dgc.export_audit(session_id)` (redacted) | `dgc.exportAudit(sessionId)` |

## Layout

- `python/` — the `dgc-sdk` package (`dgc_sdk`).
- `typescript/` — the `@vibedgc/sdk` package; `npm run build` compiles `src/` to `dist/`.
- `scripts/` — `make_sbom.py` (checkout manifest and release manifest), `check_dist.py`
  (artifact checks), `release-sdk.sh` (local dry run of a release build),
  `requirements-release.txt` (pinned build tools).
- `sbom/` — the signed checkout manifest and the maintainer public key.
- `COMPATIBILITY.md`, `CHANGELOG.md`.

## Releasing

1. Bump `python/dgc_sdk/_version.py`, `python/pyproject.toml` (version and the tag-pinned URLs),
   `typescript/package.json`, `typescript/src/types.ts`, `COMPATIBILITY.md`, `CHANGELOG.md` and
   the docs; `tests/test_sdk_packaging.py` checks that they agree.
2. With the maintainer key in `sdk/.signing/`: `make -C sdk sbom` (writes and signs
   `sbom/SHA256SUMS`), then `bash sdk/scripts/release-sdk.sh` for a local build and test.
3. Commit, merge to `main`, and push an annotated tag `sdk-vX.Y.Z` on that commit. The tag runs
   `.github/workflows/publish-dgc-sdk.yml`, which is the only way a release is built: it tests the
   wheel, publishes to PyPI with Trusted Publishing, and attaches the same bytes to the GitHub
   release without taking the Latest badge from the CLI.
