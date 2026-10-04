# Reviewed Patch and Pulse execution

This document covers handoff-based Patch and Pulse execution. API 21 also offers
[standalone reviewed Pulse plans](PIPS_PULSE_PLANS.md), which run exact commands
without a model and have a separate receipt/review contract.

Handoff-based Patch and Pulse use the existing DGC Agent and durable run queue. They do not
provide a second agent loop, a model shell, or an unattended permission upgrade.
An execution action must be part of an exact human-reviewed finding handoff.
Ordinary conversation with either Pip remains read-only. Direct run and schedule
entry points must not manufacture the action or bypass handoff approval.

## Action contract

Source-review Pips keep their existing policy and use only:

```json
{"kind":"read_only"}
```

A reviewed Patch action names exact editable files and optional verification
commands. Pulse has no editable files and requires at least one command:

```json
{"kind":"patch","write_paths":["src/parser.py"],"tests":[{"argv":["python3","-m","unittest","tests.test_parser"],"cwd":"."}]}
{"kind":"test","tests":[{"argv":["python3","-m","unittest","discover"],"cwd":"."}]}
```

`pip_execution.validate_action(pip_type, value)` returns a detached canonical
object. Patch/Pulse canonical objects additionally contain `network:false` and:

```json
{"wall_seconds":60,"cpu_seconds":30,"memory_bytes":536870912,"output_bytes":65536,"processes":32}
```

Those are `limits`, not user-selectable grants. Supplied values must match them
exactly. `action_digest(action)` hashes canonical JSON; the handoff pins the action
and digest together with its target job version. A digest binds bytes, not approval
or correctness. Approving a different job or action requires another review.

The action permits at most 32 distinct, exact normalized file paths and four
commands. Paths cannot traverse, name Git metadata, contain wildcard syntax or
use absolute paths. Each command has one to 32 nonempty argv strings, each at most
1,024 UTF-8 bytes; all command arguments together fit within 8,192 bytes. Control
characters and extra fields (environment, endpoints, extra permissions) are
rejected. The complete canonical action is at most 16 KiB. Command directories
are exact relative directories inside the private copy.

Arguments are passed directly as argv. A reviewed command can explicitly invoke
an interpreter; no command-name allowlist makes arbitrary code “safe.” Mandatory
OS isolation is the boundary. Commands are never inferred from project text,
model replies, a package manifest or the finding under review.

## Private copy and file changes

`prepare_isolated_repo(snapshot, run_dir)` requires the current run's private
`run_dir/source` snapshot. It makes an independent `run_dir/worktree` and a fresh
bare Git store in `run_dir/private-git`. This is a private baseline tree, not a
branch or worktree created in the user's repository. No source repository refs,
index, config, hooks or working files are modified.

Preparation rejects symlinks, hard links, special files, traversal and Git
metadata. It bounds traversal to 10,000 entries, each file to 4 MiB, and source
bytes to 64 MiB. Existing preparation paths are not reused. Copying checks opened
file identities and sizes before reading, bounds each read, and refuses growth or
truncation. A failed attempt only cleans up its exclusively-created worktree;
it never removes the source snapshot or a preexisting directory.

Private Git commands use no global/system configuration, templates, hooks,
fsmonitor, external diff or textconv. Ambient system/global attributes are
excluded. Repository `.gitattributes` can still affect Git's normal content
representation. The committed-source snapshot currently supplies content rather
than preserving executable mode metadata; tests should invoke scripts through
an explicitly reviewed interpreter when needed.

Patch uses the existing `write_file`, `edit_file`, `multi_edit` and `apply_patch`
tools, plus the existing read tools. The controller must call
`authorize_write(worktree, path, action)` before every write, in addition to the
normal permission engine. Only the reviewed exact paths are allowed. Git metadata
and artifact storage sit outside that edit boundary. There is no shell tool,
model-created test command, automatic Git commit, merge, apply or deployment.

`collect_artifacts(prepared, action)` checks the entire copy again, stages changes
only into the private Git store, and refuses any changed file outside the approved
paths. Pulse must have no source changes. It records a complete bounded binary
Git diff of at most 256 KiB in `artifacts/changes.patch`, with an 8 KiB text preview.
Larger diffs fail closed instead of being silently presented as complete. The
controller collects this artifact before running tests; tests cannot change it
or the worktree.

## Test confinement and guarantees

Execution is currently Linux-only. `capability()` performs a real probe;
`require_capability()` refuses if the required system bubblewrap, Python or Git,
namespace creation, read-only mounts or limits do not work. A binary merely being
installed is insufficient. There is no unsandboxed or platform-equivalent fallback.

Each exact reviewed test argv runs inside bubblewrap with:

- Separate user, PID, network, IPC and UTS namespaces; capabilities dropped and
  further user namespace creation disabled.
- Only standard system runtime trees mounted read-only. The isolated source is
  `/workspace` and is also read-only, including for Patch verification.
- No ambient home directory, source Git metadata, runner state, model key or
  startup-injection environment. The child receives a fixed small environment.
- Writable private `/tmp`, capped by a 64 MiB tmpfs. Root, `/dev` (including shared
  memory) and `/proc` are read-only. Device files such as `/dev/null` remain usable.
- A trusted Python wrapper sets resource limits inside the namespace and then
  `exec`s the reviewed argv. This avoids `preexec_fn` in a threaded controller.

The 512 MiB address-space limit and 30-second CPU limit are **per process**.
The 32-task limit is enforced for the sandbox namespace, not a claimed cgroup
memory/CPU budget. The parent also samples every descendant process's RSS,
including children forked by nonleader threads, and stops work above 512 MiB
sampled aggregate RSS. That watchdog can miss a spike between samples; shared
pages can be counted more than once. It is not a hard aggregate memory ceiling.
The parent enforces the 60-second wall limit, a 64 KiB combined stdout/stderr
ceiling, explicit cancellation and owned process-group termination. Additional
limits bound open files, individual output file size and core dumps. The root
controller retains its overall run deadline and stop checks across model work
and verification commands.

The model client can continue using its configured endpoint in the parent/model
worker. Test subprocesses do not receive that key or network access. Tests see
system-installed runtimes, not a user's home virtual environment. No dependency
installation is attempted. A missing package or a runtime requiring more virtual
address space (including some Node configurations) fails explicitly; it does not
trigger broader permissions or a different runtime.

## Result and artifact contract

`run_reviewed_tests(prepared, action, cancelled=...)` returns rows containing
`index`, exact `argv` and `cwd`, `status`, `exit_code`, an output preview,
`output_truncated`, and an artifact reference. Status is `passed`, `failed`,
`timed_out`, `cancelled`, `output_limit` or `resource_limit`. A command cancelled
before spawn has a null exit code and no output. Ordinary failures do not hide
later selected tests; cancellation and resource stops end the remaining list.
Output previews are at most 4 KiB. `artifacts/test-N.txt` retains at most 64 KiB.
Artifact references contain only a relative path, SHA-256 and byte count.
Artifacts remain private local files; this helper adds no download endpoint.

The controller assembles:

```text
summary, verification, tests_executed, usage?, tools_called?, snapshot?,
execution: {changes, tests, tests_not_run}
```

`validate_execution_result(result, action)` checks the exact commands and order,
write scope, statuses and exit codes, bounded counts, artifact references and
payload size before storage. It adds `tests_not_run`, counting commands that never
started (including cancellation before spawn), and limits the complete result to
64 KiB. The fixed verification line is:

> Isolated changes and reviewed command results; no automatic apply, merge or deployment.

A finished model response cannot invent successful tests or an audit checkpoint.
A failed test remains failed. Artifact bytes are local owner-private review data;
normal controller redaction still applies to previews sent to clients. No artifact
is automatically applied to the user's checkout.

## Verification scope

`tests/test_pip_execution.py` uses temporary files and registries, exact argv,
controlled clocks and injected failure points; it makes no network requests and
uses no sleeps. Linux integration cases run actual bubblewrap and Python to check
namespace separation, read-only source/root/shared memory, hidden home and
credentials, private scratch, the process cap, orphan cleanup, output bounds and
missing dependencies. These cases skip with an explicit unavailable-confinement
reason on unsupported runners. Mock-based tests cover schema limits, traversal,
link refusal, unchanged originals, reviewed scope, artifact integrity, process
monitoring from nonleader threads, deadlines, and result truthfulness. Passing
these tests does not mean arbitrary project dependencies or other operating
systems have been verified.
