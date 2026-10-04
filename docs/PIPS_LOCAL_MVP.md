# Manual workspace Pips: local development slice

This documents the first Remote-oriented slice. For the subsequent independent
supervisor, dedicated editor tab, ordinary session association and CLI backfill,
see [the current core build](../../docs/PIPS-CORE-BUILD.md) and
[workspace increment](../../docs/PIPS-WORKSPACE-BUILD.md). In the local CLI/editor
flow the supervisor, not the editor process, owns audit execution.

This is an opt-in local implementation in the isolated Pips lab. Nothing here
deploys a service or modifies the original DGC installation. Pips are disabled by
default. Remote additionally requires explicit `dgc remote login --pips` or
`dgc remote connect --pips` and an individually approved encrypted client connection.

For a new machine, enable `pips_enabled` locally, then run `dgc remote login --pips`.
This signs in through the browser and keeps the Pips Remote connection in that
terminal. `--email ADDRESS` selects the existing email-code flow instead. Keep the
terminal open; Ctrl+C disconnects Remote, without stopping the independent Pips
supervisor or cancelling its work. An already signed-in machine retains its login
identity and goes directly to the explicit connection. Normal login and the editor's
sign-in flow still start generic Remote presence, without Pips controls.

The opt-in commands reject a disabled feature or a restricted session/sandbox before
reading Remote credentials or starting authentication. Malformed arguments are
refused first. If another connection holds the lock, the opt-in exits unsuccessfully
and does not claim that Pips is available. Stop the existing connection from its
owning terminal or service, then retry; the opt-in never signals a PID from the
presence file, replaces that connection, or falls back to generic presence.
Successful startup may resume already queued Pip work, so check the local queue
before a read-only acceptance session. These commands do not start another supervisor.

## Implemented

- Private SQLite registry with stable workspace and runner UUIDs, local path
  bindings, explicit local rebinding, and additive session associations.
- Workspace Pip creation, inspection, pause/resume, proposed job changes and
  explicit acceptance into a new immutable version.
- Manual durable queue with per-Pip idempotency keys. A queued run pins its job,
  source commit, native model route and fixed read-only tool policy.
- A separate process invokes the existing `Agent.run_turn`; there is no second
  agent loop. A dedicated auditor system prompt defines the JSON report contract
  without normal chat's prose/document instructions. Progress comes from real
  tool/lifecycle callbacks.
- A clean bounded Git object snapshot excludes dirty/untracked working files. A report
  must include a successful text source read; a directory listing does not count.
  Finding excerpts are checked against
  the reported line of the committed snapshot.
- Cancellation, wall/tool/request limits, parent-death exit and restart recovery.
  An interrupted running audit is marked failed and is never silently replayed.
- Local activity with bounded retention, redaction and correlated encrypted
  control requests. No plaintext cloud Pips/context API.

## Exact security boundary

The current auditor uses **native DGC tool confinement, not an OS sandbox**.
Only `read_file`, `glob`, `grep`, `repo_map` and `todo` are offered. The immutable
process policy denies all other tools and external-directory access, including
in auto mode. The model cannot launch shell/Python, MCP calls, web requests,
skills, artifacts or subagents. Native search implementations may invoke their
fixed bounded search helpers; the model does not receive arbitrary execution.

The worker receives a fresh private HOME/DGC_HOME and a disconnected MCP manager.
It does not load the host's hooks/connectors, and committed `.dgc/config.json`
does not become worker configuration. Project permission grants and agent routing
are disabled. The selected model endpoint still receives normal model requests;
`network denied` here refers to agent tools, not the model API itself.
Project DGC.md and AGENTS.md are not automatically loaded as auditor system
instructions. The model can encounter them only as untrusted snapshot evidence.

Structured filesystem tools resolve against the snapshot. Absolute/relative
escapes, symlink escapes and forged private approval arguments are tested through
the actual Agent dispatch. Trees containing links/special entries are refused.
Raw committed blob reads bypass export-ignore/export-subst and checkout filters,
and ignore local Git replace refs, so repository attributes and replacement refs
cannot silently omit or rewrite the audited source. Windows drive and alternate
stream paths are refused even when preparing a snapshot on another platform.
This is not a claim of kernel-level isolation against a vulnerability in DGC,
Python or a document parser. A future Pip that executes tests or arbitrary code
must require a suitable OS sandbox; a command name such as `npm test` is never a
safe read-only classification.

Only the parent process supplies the approved endpoint/model. Provider keys
travel once over a private stdin pipe, not argv or a persisted run manifest.
The worker validates the exact policy digest before model execution. Delegated
subscription CLI routes are currently refused because their inner tool loops do
not provide this boundary.

Remote command data cannot supply paths, endpoints, credentials, permissions or
new triggers. A user accepting a job change can change the goal/name/source ref,
but cannot expand this release's fixed read-only policy. There are no model-side
tools that accept their own proposed changes.

## State and lifecycle

State is under `$DGC_HOME/.dgc/pips/` when DGC_HOME is set, otherwise the existing
private DGC state directory. The database directory is owner-private; credentials
are not part of its records. Existing session files are not moved or rewritten.

Workspace resolution creates a new binding for a new canonical directory. It
never merges copies based on a Git remote. `WorkspaceRegistry.rebind(...)` is an
explicit local operation requiring the expected old path and no live runs.

Job versions and run manifests are immutable in SQLite. Run status and terminal
results are lifecycle projections; terminal results cannot be overwritten by
late controller completion. Pause prevents queued/new execution; cancel stops
one queued or running audit. Expected worker termination leaves a cancelled run
without a misleading failure error. Resume of a Pip permits its previously queued runs.

The queue is serviced while an explicitly enabled control process is running.
This is not an installed background daemon or a scheduler. The machine cannot
execute while asleep/offline. The remote connector restarts retained queued work
on its next explicit startup; interrupted running work requires a new run.

## Local review without browser authentication

Use a dedicated home and an existing committed Git repository root. Configure a
native local/API model in that isolated home's DGC settings first; the launcher
does not copy the host's provider credentials or select an arbitrary model.

```bash
export DGC_HOME=/home/fungigb10/dgc-pips-lab-20261001/state/runner-home
export PYTHONPATH=/home/fungigb10/dgc-pips-lab-20261001/dgc
cd /home/fungigb10/dgc-pips-lab-20261001/dgc

# --enable uses the existing Config.set save path in this isolated home only.
printf '%s\n' '{"type":"list_workspaces"}' | \
  /home/fungigb10/dgc/.venv/bin/python scripts/pips-local-control.py \
  --workspace /absolute/path/to/committed/repository --enable

printf '%s\n' '{"type":"create_pip","name":"Backend Auditor","goal":"Inspect backend correctness and report source-backed findings.","source_ref":"HEAD"}' | \
  /home/fungigb10/dgc/.venv/bin/python scripts/pips-local-control.py \
  --workspace /absolute/path/to/committed/repository

# Substitute the returned Pip ID. --wait keeps the actual runner process alive.
printf '%s\n' '{"type":"run_pip","pip_id":"pip_RETURNED_ID","idempotency_key":"review-1"}' | \
  /home/fungigb10/dgc/.venv/bin/python scripts/pips-local-control.py \
  --workspace /absolute/path/to/committed/repository --wait
```

Running or resuming through this one-shot launcher requires `--wait`; the
persistent Remote connector services its queue without that option. A real model run
may consume the configured provider's resources. Automated tests use a scripted
provider adapter, never a real account or network connection.

## Control contract

`handle_control(config, request, device_id)` assumes the transport has already
authenticated and approved `device_id`. It returns:

```json
{"type":"pips_result","request_id":"...","command":"list_pips","ok":true,"result":{"pips":[]}}
```

Errors use `ok:false,error:{code,message}`. `CONTROL_COMMANDS` exports the accepted
command names. Requests are bounded to 16 KiB, responses to 128 KiB. Unknown
fields/commands fail closed. Listing and public run manifests omit credentials,
local roots and model endpoint settings. IDs remain runner-local UUIDs.

## Current limits and intentional exclusions

- Manual read-only workspace audits only. No schedules, autonomous fixers,
  account/team scope, remote session creation, external writes or handoffs.
- One active execution per local runner, at most 20 queued/running runs and
  1,000 retained runs. No automatic deletion of results or user data.
- Source must be a committed Git repository root. Nested monorepo workspaces,
  non-Git folders, submodules, symlinks and special files are unsupported.
- Snapshots: 10,000 file/directory entries, 4 MiB per file, 64 MiB of file data.
- Execution: five-minute worker wall budget, 12 model iterations, 64 tool calls,
  4,096 requested output tokens per model response, bounded IPC/report sizes.
  These are not a monetary budget or a hard kernel memory ceiling.
- Findings are model assessments. The validator proves excerpt provenance, not
  that a reported bug is real or an empty report means the repository is safe.
  No test suite is executed; every report says so.
- Event history retains the latest 5,000 events per workspace and returns cursor
  bounds. It is not an unlimited compliance audit archive.
- Pending job proposals require acceptance but are not generic durable tool
  approvals. This release never asks to execute tools outside its fixed policy.
- A real local model run completed against the sample workspace. Its report
  also exposed incorrect model claims, so semantic review quality remains an
  acceptance concern. See [PIPS_RUNTIME_REVIEW.md](PIPS_RUNTIME_REVIEW.md).
- The isolated worker and process supervision are verified on Linux only.
  Windows execution is refused until a parent-process handle watcher exists:
  its `getppid()` can retain the exited parent's identifier. macOS runtime
  acceptance remains open; mocked APIs are not platform verification.

## Verification

```bash
DGC_HOME=/home/fungigb10/dgc-pips-lab-20261001/state/test-home \
PYTHONPATH=. /home/fungigb10/dgc/.venv/bin/python -m unittest discover \
  -s tests -p test_pips_local.py -v
```

The suite uses temporary directories, local Git fixtures and a scripted provider
adapter. It includes a real isolated worker subprocess and actual Agent file
reads, while asserting no network request is made. No sleep-based test assertions.

### Full harness evidence

The initial deterministic focused suite passed 41 tests on the Linux lab; after
the real-model review fixes, all 44 pass. The initial
full harness run with its own isolated HOME completed 1,783/1,785 top-level
checks; its discovered suite ran 2,060 tests with seven failures and 20 skips.
Two failures concern SDK signed-manifest/SBOM drift already present in the source
copy. The other failures identify Remote integration follow-ups: SDK protocol
copies/event retention, a ready-capability test coupled to method source text,
and an advertised editor action without a route. A subsequent focused check
passed 39 SDK/protocol/produced-files/TUI tests after those Remote regressions
were fixed; the advertised editor-action routing assertion also passed.
The signed release manifests remain untouched. These are separate from the
passing Pip tests; the full harness is not claimed green. See
`output/full-cli-tests-clean-env.log` relative to the lab root for the complete
run. The inherited optional Ollama smoke made one small real local model call
(35 input tokens and two output tokens). That was not an actual Pip audit, and
the broad suite was not wholly offline. Only the focused Pip suite is claimed
to run without a real model or network.
