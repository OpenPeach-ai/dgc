# DGC SDK

Frozen **0.5.2**. Protocol **v14**, CLI **0.41.5**, Linux. GitHub tag **`sdk-v0.5.2`**
(not `v0.5.2` — that is a historical CLI tag).

Install the wheel from the GitHub release, or from this repository:

```bash
python3 -m pip install \
  "https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.2/dgc_sdk-0.5.2-py3-none-any.whl"
# from a clone:
python3 -m pip install -e sdk/python
# TypeScript: import sdk/typescript (Node 22+, strip-types). Not on npm yet.
#   node --experimental-strip-types examples/sdk/hello_run.mjs .
```

The SDK is **free**. There is no DGC subscription fee to embed it. Optional `Pricing` /
`department` exist so **your application** can record **model-token** spend (what an LLM
provider would charge for tokens), not a charge for this library.

The SDK launches a managed `dgc serve` child with an **isolated HOME** (`DGC_HOME`). The host
process `~/.dgc` is not read or written unless you pass `inherit_user_state=True`.

Requires a DGC runtime that speaks editor protocol v14 (CLI 0.41.3 or this checkout). Set
`DGC_PYTHON` if `python3` cannot import `dgc`.

## Public surface (0.5.2)

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
| Skills / hooks / memory | `list_skills` / `list_hooks` / `get_memory` / `add_memory` | `listSkills` / `listHooks` / `getMemory` / `addMemory` |
| Permissions | `list_permissions` / `add_permission_rule` | `listPermissions` / `addPermissionRule` |
| Unattended | `permissions={"mode": "...", "unhandled": "deny"}` | `permissions: { unhandled: "deny" }` |
| Usage / cost | `DGC(..., pricing=Pricing(...), department="erp")` then `dgc.usage_report()` | — |
| Policy | `DGC(..., policy=RuntimePolicy(network="deny", deny_tools=(...)))` — write-tool denies also inspect bash file-writes | — |
| Audit | `dgc.export_audit(session_id)` (redacted JSONL) | — |
| Retry | `RetryPolicy(max_attempts=4)` — 429/5xx retried by `dgc serve` | — |

Do not `pip install dgc`. Public PyPI `dgc` is an unrelated clustering package.
The SDK package names are `dgc-sdk` / `@vibedgc/sdk`. This cut is the GitHub release
and the in-tree sources; it is not on PyPI or npm yet. The SDK still needs a DGC
runtime that can `python -m dgc serve` (this checkout or CLI 0.41.3).

## Isolation

Each `DGC` client owns one isolated HOME under `state_dir`. Every session from that client
shares it, so transcripts, checkpoints and goals survive `resume` / `fork` after the child
exits. The child sees `HOME`/`DGC_HOME` there, empty `mcp_servers`/`hooks`,
`artifact_autostart=false`, `monitor_wake=false`, and `trusted_dirs` limited to the workspace
you passed. `on_permission` returning `always` only writes rules into that isolated home.

Two `DGC` clients with different `state_dir` values do not share state. Per-session directories
would wipe resume/fork persistence.

## Examples

`examples/sdk/hello_run.py`, `app_session.py`, `resume_run.py`, `ci_review.py`, `ci_edit.py`,
`hello_run.mjs`, and `workbench.py` (loopback UI on port 8765). CI recipes print JSON, write a
patch file, and use exit codes 0/1/2/3/4/5.

## Release

Channel tag: `sdk-v0.5.2`. Proven on Linux. macOS and WSL are unproven. Native Windows is
experimental. TypeScript covers the embed client; usage, audit, and retry helpers are Python-first.
