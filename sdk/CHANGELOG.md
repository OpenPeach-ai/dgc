# DGC SDK changelog

## 0.5.3 — 2026-09-19

Pairs with CLI 0.41.6 over editor protocol v14. A `RuntimePolicy` or a sandbox setting needs CLI
0.41.6; an older runtime is refused with `DGCUnsupportedError` instead of running without them.

### Check these when you upgrade

- `run()` and `stream()` report a run that hits its `timeout` as `status="failed"`,
  `reason="timeout"` (it used to say `cancelled`). `RunHandle.result(timeout=...)` now raises
  `DGCTimeoutError` when that wait lapses first, and its default is `None` (wait for the run).
- The runtime no longer inherits your environment. Pass what the agent needs with `extra_env` or
  `inherit_env=["NAME", ...]`, for example `inherit_env=["HTTPS_PROXY", "NO_PROXY"]` behind a proxy.
- `RetryPolicy(retry_on=...)` or `backoff_s=...` other than the defaults raise
  `DGCUnsupportedError`: the runtime's HTTP retry schedule is fixed.
- `deny_tools` and `allow_tools` take DGC tool names (`"bash"`, `"write_file"`) and MCP routes;
  display names such as `"Bash"` and unknown names raise `DGCConfigError`.
- A `RuntimePolicy` sandboxes the shell by default (`shell="sandboxed"`). With a write tool denied
  the workspace is read-only to the shell, and hosts without bubblewrap warn at `session()`. Pass
  `shell="screened"` or `network="allow"` to keep the 0.5.2 behaviour.
- **`RunStatus` no longer has `blocked`** (it was documented and used by an example but never
  emitted). A denied step is reported in the new `RunResult.denials` — a list of `Denial`
  (`name`, `reason`, `source`, `call_id`, `args`), where `source` is `policy`, `callback`, `hook`,
  `mode` or `runtime`. A denied step no longer flips the status; the run ends `completed` unless
  something else fails. `ci_review.py` and `ci_edit.py` use `denials`. Staff callbacks now see
  every `bash` request instead of some being denied by a pattern before they are asked.
- **The workspace can no longer grant an SDK session capabilities.** By default a session's
  `cwd` is untrusted: its own `.dgc/permissions.json` *allow* rules and its `.dgc/agents`
  definitions (which pick a model endpoint and a credential env var) are not loaded — the
  workspace can only *narrow* what runs. Set `DGC(trust_workspace=True)` to opt in; even then a
  project agent file keeps only its persona, never an endpoint or key, and no agent definition may
  read a `DGC_*_API_KEY`. This holds with no `RuntimePolicy` set and under `inherit_user_state`,
  where your own `~/.dgc` allow rules also stop pre-approving once a policy reviews permissions.
- **`RuntimePolicy(shell="sandboxed")` fails closed.** A host with no working OS sandbox now
  refuses to start a shell-capable session (`DGCUnsupportedError`) rather than run the shell
  unconfined; plan/no-shell sessions still start. Pass `sandbox={"requirement": "preferred"}` (or
  `shell="screened"`) to accept the weaker mode on purpose. `available()` now probes that
  bubblewrap actually confines (unprivileged user namespaces can be disabled), so `required` no
  longer passes on a bwrap that cannot run.
- The provider key never reaches a shell/`python`/`monitor`/hook subprocess environment, in any
  mode, and the SDK hands it to `dgc serve` through a private 0600 file the CLI reads and deletes
  before any tool runs (not the child's environment, whose initial block stays readable in
  `/proc`). `printf %s "$DGC_API_KEY" | rev` no longer recovers it. In `shell="screened"` the
  `python` tool is screened for network and (with writes denied) file writes, like the shell.
- `deny_tools`/`allow_tools` accept both the internal name and the display spelling (`"bash"` or
  `"Bash"`, `"write_file"` or `"Write"`); unknown names still raise `DGCConfigError`.
- `RetryPolicy(max_attempts=...)` outside 1–11 raises `DGCConfigError` (it is not clamped), and a
  `permissions=` mapping with a key other than `mode`/`unhandled` raises `DGCConfigError`.
- An unset `state_dir` (a temporary directory the SDK creates) is removed on `close()`, audit and
  usage logs included; pass `keep_state_dir=True`, or an explicit `state_dir`, to keep it.
  `rewind()` on an out-of-range index raises `DGCConfigError` instead of returning `{ok: False}`.
- Examples and the quickstart no longer seed a model into `state_dir`; pass `model` and
  `base_url` (or `extra_config`), since a `config.json` already in `state_dir` is not merged.

### Runtime and errors

- The SDK finds the installed CLI on its own: `DGC_PYTHON`, the application's Python when it can
  import `dgc`, then `dgc` on `PATH`, `~/.local/bin/dgc` and the installer's versions directory.
  Each candidate is probed for protocol v14, and the error lists what was skipped and why.
- The runtime child no longer inherits the application's environment: it gets basic variables,
  the isolated HOME, `api_key` and `extra_env`; `inherit_env` passes more on purpose. The
  application's site-packages are never put on the child's `PYTHONPATH`.
- Custom tools start in a clean install (the relay no longer shadows the standard `types`
  module), work with `runtime=["dgc", "serve"]`, and a tool server that does not connect fails
  `session()` instead of starting without its tools.
- The backend survives the thread that created the session exiting, so sessions can be created
  from request threads and thread pools.
- Every exception is a `DGCError`. A refused request raises `DGCCommandRejectedError` at once
  instead of a 15 s timeout; a protocol mismatch raises `DGCProtocolError` naming both versions;
  a failed setup stops its child. `start_timeout` and `request_timeout` are options on `DGC`.
- Run timeouts work at any length, `timeout=None` means no limit, and a timed-out run reports
  `status="failed"`, `reason="timeout"`. Event types newer than this SDK are skipped.
- When every DGC install found speaks another protocol, `DGC()` raises `DGCProtocolError` saying
  whether to update the CLI or dgc-sdk; an unusable `DGC_PYTHON` is logged when another install is
  used instead.
- `RetryPolicy` says what it controls (stall re-issues) and rejects settings the runtime cannot
  honour instead of ignoring them.

### Sessions, results and usage

- `state_dir` is created private and refused when others can write it; each session writes its
  config from scratch, so options no longer leak between runs or sessions, and a one-run limit
  (including an `output_schema` repair) no longer sticks. `state_dir` may be omitted.
- A new session keeps its own id and transcript; it never adopts another session's.
- `usage` is the provider's reported token counts for the run (output tokens included), or
  unknown when not reported; `usage_report()` counts unknown runs separately, and `requests`
  still counts their requests. Cached input is billed once, at `cached_input_per_million` (or the
  input price when that is 0).
- `fork()` points `session_path` at the fork's own transcript, and `clear_todos()` returns at
  once instead of timing out.
- Failed runs carry the runtime's error message. `result.changes` includes dot-directories and
  lockfiles, fills `before`, and gives each file a `git apply`-able `diff`.
  `result.verification` reports only the configured `verify_command`.
- `followup()` returns a handle for its own, audited turn; behind a run with its own `max_turns`
  or `output_schema` it is sent once that run is over, so it is not capped by it or run ahead of
  its schema repair. `steer()` needs an active run; leaving a `with` block early cancels the run
  and frees the session.
- `AsyncDGC` and `AsyncSession` have every sync method with real signatures, accept `async`
  callbacks, and cancelling the awaiting task cancels the run. `decision_timeout=None` means no
  limit.
- Audit and usage files are owner-only, and audit rows redact current credential formats, bare
  `API_KEY=...` / `api_key: ...` lines included.

### Policy and sandbox

- `RuntimePolicy` is enforced by the runtime per session, in `auto` mode too, and is never
  written to any config file (with `inherit_user_state=True` it no longer lands in `~/.dgc`).
  File tools stay inside the workspace and off `deny_path_prefixes`; `deny_tools` and
  `allow_tools` cover custom and MCP tools, and unknown names raise.
- Shell commands run in the OS sandbox by default (`shell="sandboxed"`); in `auto` mode the shell
  runs only there, and a host with no working sandbox refuses the session unless the app accepts
  the weaker mode (`sandbox={"requirement": "preferred"}` or `shell="screened"`). The sandbox
  masks the client's whole `state_dir` (audit and usage logs, not just the isolated HOME).
  `shell="screened"` keeps the older pattern screen — covering the `python` tool too — documented
  as best effort.
- Outside `auto` mode every shell command reaches `on_permission`. The workspace's own
  `.dgc/permissions.json` *allow* rules and `.dgc/agents` are not loaded unless
  `trust_workspace=True`; a `deny_path_prefixes` refusal now tells the model it was the
  application's policy, not "the user".
- Custom tools are served on a private, randomly named socket that answers only the session's
  own relay, which proves a per-session secret; on Linux the relay hides that secret from other
  processes of the same user.
- `sandbox={"requirement": ...}` is decided by the runtime, so it works from a PyPI install;
  `Session.sandbox` reports what was applied. `permissions=` and `sandbox=` accept
  `PermissionPolicy` and `SandboxPolicy`, and `unhandled="callback"` requires `on_permission`.

### TypeScript (`@vibedgc/sdk`)

The Node client now has the same correctness and security fixes as the Python one.

Check these when you upgrade:

- `policy` is enforced by the runtime per session (`DGC_SESSION_POLICY`), in `auto` mode too, and
  is never written into `config.json` or, with `inheritUserState`, into `~/.dgc`. `denyTools` and
  `allowTools` take DGC tool names and MCP routes; unknown names throw `DGCConfigError`. New
  fields: `allowTools`, `denyPathPrefixes`, `shell` (`"sandboxed"` by default: the shell runs
  in the OS sandbox, and in `auto` mode only there; `"screened"` keeps the pattern screen).
- A `config.json` already in `stateDir` is not merged, and `stateDir` must be private (a
  group- or world-writable one is refused). Pass extra DGC settings with `extraConfig`.
- Every error is a `DGCError` subclass instead of a plain `Error`. `steer()` throws without an
  active run, and `followup()` returns a `RunHandle` for its own turn.
- `result.usage.input_tokens` / `output_tokens` are the provider's counts or `null` (they were a
  context-size estimate and 0). `usageReport()` keeps `runs` and `rows` and adds totals.
- `session.close()` returns a promise. `decisionTimeoutMs: null` now means no limit.
- A workspace's own `.dgc/permissions.json` allow rules and `.dgc/agents` definitions no longer
  load in an isolated session, policy or not; pass `trustWorkspace: true` to allow them.
- A `policy` with the default `shell: "sandboxed"` throws `DGCUnsupportedError` at `session()`
  when the runtime has no OS sandbox, unless you pass `sandbox: "preferred"` or
  `shell: "screened"` (plan-mode sessions still start).
- `RunStatus` has no `blocked` (it was never produced); refused calls are in `result.denials`.
- The temporary `stateDir` the SDK creates when none is given is removed on `close()`, audit and
  usage logs included; pass `keepStateDir: true` to keep it.
- `rewind()` with an invalid index throws `DGCConfigError`.

Fixes:

- Per-session options (`model`, `maxTurns`, `verifyCommand`, trusted directories) no longer leak
  into later sessions, and a run's `maxTurns` or an `outputSchema` repair no longer caps later
  runs. `verifyCommand` is applied (it was ignored); `turnBudgetS` and `maxTokens` are new
  session options.
- `timeoutMs` works at any length (Node timers overflow past 24.8 days and fired at once);
  `null` means no limit; invalid values throw before the prompt is sent. `signal: AbortSignal`
  and leaving a `for await` loop early cancel the run and free the session.
- Control requests made while a run streams keep their replies; a refused command throws
  `DGCCommandRejectedError` at once instead of after 15 s; a protocol mismatch throws
  `DGCProtocolError` naming both versions; event types newer than the SDK are skipped; a runtime
  that exits, never becomes ready, or cannot be launched is an SDK error that carries its stderr,
  and no `dgc serve` child is left behind. `startTimeoutMs` and `requestTimeoutMs` are options.
- Failed runs carry the runtime's error. `result.changes` (new) lists added, modified and deleted
  files with `git apply`-able diffs; `result.verification` reports only the configured command.
- A session binds only its own transcript (`sessionPath`); follow-up and steered turns are
  observed, audited and billed as runs.
- Custom tools use a random socket in a fresh 0700 directory and a per-session secret the relay
  must present; a tool server that does not connect, authenticate or offer every tool fails
  `session()`. `defineTool` takes `{ timeoutMs }`.
- Decision callbacks, `onMcpInput` included, are bounded by `decisionTimeoutMs`; with
  `unhandled: "callback"` a failing callback stops the run (`reason: "decision_failed"`).
- Audit and usage files are owner-only and audit rows are redacted with the Python rules.
- The runtime is started with `python -P` where available, so a `dgc/` package in the workspace
  cannot replace it.
- The provider key reaches the runtime through a 0600 file in the private state directory that the
  CLI reads and deletes at startup, never through the child's environment (readable in
  `/proc/<pid>/environ`); the agent's shell and python tools never see it.
- `result.denials` lists refused calls with `name`, `reason`, `source`, `callId` and `args`; a
  denial made by the application's policy is reported to the model as such.
- `shell: "screened"` screens the `python` tool for network calls and file writes too, and
  `denyTools`/`allowTools` accept display names (`"Bash"`, `"Write"`).
- Reading a workspace path that became a FIFO no longer blocks the change scan.

### Packaging and release

- PyPI and the GitHub release now carry the same bytes. `publish-dgc-sdk.yml` builds only from
  the `sdk-vX.Y.Z` tag, runs the SDK suites against the built wheel, publishes through PyPI
  Trusted Publishing with PEP 740 attestations, and attaches the same wheel and sdist, the npm
  tarball, a CycloneDX SBOM and `SHA256SUMS` to the GitHub release with GitHub artifact
  attestations. SDK releases no longer take the Latest badge from the CLI.
- The wheel and sdist include the Apache-2.0 `LICENSE` (PEP 639 metadata), and the classifiers name
  the proven platform (Linux) and `Typing :: Typed`.
- The Node package `@vibedgc/sdk` is compiled to JavaScript with type declarations, so
  `npm install <tarball>` works; it needs Node 22 or newer.
- The maintainer public key for the checkout manifest is committed as `sdk/sbom/sdk.pub`; SBOMs use
  `pkg:pypi` package URLs.
- CI builds the wheel and runs the SDK suites against it in a clean, non-editable install, runs
  the TypeScript suites, and type-checks the public API with `mypy --strict`. Every GitHub Action
  is pinned to a commit.

### Examples and docs

- Every example runs from a pip install: model and endpoint come from `--model`/`--base-url` or
  `DGC_MODEL`/`DGC_BASE_URL`, state goes to a new temporary directory, and output says what
  happened. `ci_edit.py` writes a patch that `git apply` accepts, new files included.
- `workbench.py` binds 127.0.0.1, requires a per-run token, accepts only JSON from its own page
  and host, matches approvals to the pending request, and no longer names a LAN address.
- The README quickstart runs as written and is tested.
- `docs/SDK.md` is a full guide and API reference: every public name, the events, the defaults,
  the security model and how to verify a release.
