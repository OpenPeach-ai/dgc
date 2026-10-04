# Reviewed standalone Pulse plans

API 21 / registry interpretation version 21 adds a human-reviewed standing verification plan to Pulse. A plan runs exact commands in a private copy of an approved committed Git revision. This path does not construct an Agent, resolve a provider or invoke a model. Pulse conversations remain read-only model conversations, and existing reviewed handoff execution retains its separate contract.

A manually created Pulse has no plan. An API 27 conversational setup can create it with an explicitly approved plan. Use `dgc pips verification-plan PIP --expected-version N --plan-file /absolute/plan.json` to save a proposal, inspect its complete saved definition, then use the existing explicit proposal acceptance flow. `--plan-json` accepts the same object inline. `--remove` proposes removing both the plan and its calendar; it does not accept the proposal automatically. These are local human controls. Generic `pips_propose` cannot add or modify commands, and automatic adaptation refuses plan-bearing Pulse definitions. `pips_setup` can draft exact commands for human approval; it cannot approve them.

The original network-free command profile below remains unchanged. API 27 additionally supports fixed loopback HTTP probes, with the separate guarantees in `PIPS_LOCAL_HTTP_CHECKS.md`.

The plan is a closed object:

```json
{"schema_version":1,"action":{"kind":"test","tests":[{"argv":["python3","-m","unittest","discover"],"cwd":"."}],"network":false,"limits":{"wall_seconds":60,"cpu_seconds":30,"memory_bytes":536870912,"output_bytes":65536,"processes":32}}}
```

The action uses the existing reviewed command validator. It permits one to four exact argv/cwd pairs, with no shell interpolation, package installation grant, network, additional write paths or specialist delegation. The canonical action includes fixed limits. The plan is at most 12 KiB and its full reviewed definition at most 16 KiB. Omission or null means no plan; old immutable definitions that omitted the field remain byte-identical. `get_pip` and list projections add canonical `verification_plan` and controller-computed `verification_plan_digest`, both null when absent.

Manual launch requires all three current pins explicitly:

```text
dgc pips run PIP --expected-version N --expected-lifecycle-revision R --expected-plan-digest SHA256 --idempotency-key REQUEST
```

Clients obtain the digest from a fresh reviewed Pip response. They do not silently look up, infer or retry changed pins. An exact saved request returns its historical run. Reusing its key with different actor, version, lifecycle revision or plan digest refuses. A plan does not authorize `run_pip_now`, a handoff, or any new model tool.

Existing interval, daily, one-shot and cron calendars can run a plan after review. Existing active/paused/archive/global-stop semantics apply. The immutable run grant records the exact original definition and approval, job/source/binding/lifecycle identities, plan and action digests, and either the manual pins or the exact calendar policy and occurrence. Calendar membership, coalescing and the actual durable cursor are checked before queueing. A consumed occurrence is not replayed after failure, cancellation or recovery. Event triggers and current-tree sources are excluded from this increment.

The controller revalidates original approval lineage and current job, plan, lifecycle, runner and binding before source preparation and each command reservation. Pause, removal, a new job version, lifecycle change or binding change stops the active plan and prevents further invocations. Exact command outcomes already received may still be recorded after withdrawal. A late cancellation can race process launch; reservations distinguish unknown outcomes from known not-started commands.

Execution requires the existing Linux bubblewrap capability probe. The original workspace is unchanged; tests see the private source read-only with bounded private scratch space. Per-command wall time is 60 seconds; CPU and address-space limits are per process, while aggregate RSS/process observations are sampled by the existing executor. The shared controller deadline is 300 seconds. Output artifacts are bounded at 64 KiB and receipt previews at 4 KiB per command. These are platform-specific confinement guarantees, not claims of equivalent support on every operating system.

## Receipts and recovery

A standalone manifest has `run_kind:"test"`, `pip_type:"pulse"`, `model:null`, `model_settings:null`, `policy:"review_required"`, `tools:[]`, and `pulse_verification`. It carries no handoff, model prompt/context, memory, checkpoint, event or specialist grant. Its compact job includes the canonical verification plan. Parent dispatch refuses routing it through the model worker.

The run result is the direct closed `reviewed_command_outcomes` receipt, which may appear while running. It binds grant/plan digests and the captured snapshot, states `model_invoked:false`, and has one ordered entry per reviewed command:

- `not_started` with no outcome: no launch reservation was recorded.
- `launch_reserved` with no outcome: launch was durably reserved; after interruption the actual outcome is unknown.
- `finished` with a native outcome: its exact command, exit/status, bounded preview and artifact reference were durably recorded. A pre-spawn cancellation with null exit code is known unexecuted.

A reservation commits before launch. A completion commits before the next reservation. Failure to save completion leaves an unknown reservation and stops the sequence. Recovery seals existing progress; it never reruns a reserved command. Preparation failure or queued cancellation can produce a snapshot-null, entirely unexecuted receipt. Corrupt grants/progress still permit failed/cancelled terminal state, but the controller discards untrustworthy evidence and historical evidence readers refuse it rather than inventing replacement outcomes.

A controller run may succeed with failed command invocations: success means the reviewed sequence finished and its outcomes were recorded. `passed` means the invocation exited zero. Neither means tests passed, coverage was complete, or project correctness was verified. Public runs expose `execution_mode:"standalone_plan"` and `command_progress` counts of passed, failed, stopped, unexecuted and unknown invocations, plus phase/reason/total. The active/latest/list projections use the same validated receipt.

Detailed run reads, main-chat execution references, subsequent Pulse chat references and local sanitized evidence export understand this distinct receipt. Output is untrusted reference text. Newly configured secrets may redact display previews; an overlap with exact argv/cwd/grant metadata causes display refusal instead of silently changing reviewed evidence. Original stored receipts are unchanged. Outcome acceptance, artifact handoff creation and shared-context promotion are deliberately unavailable for standalone results in this increment.

## Validation and limits

Deterministic disposable-registry tests cover original approval binding, pin/retry/lifecycle conflicts, all existing calendar forms, corruption bounds, durable reservation/completion/rollback, cancellation and recovery. Integration tests execute actual isolated commands with provider/Agent construction forbidden, preserve nonzero exits, verify source immutability, and exercise read/chat/export refusal boundaries. SDK/CLI/UI gates are tracked separately from native release acceptance. No private user profile or recurring live schedule is created by these tests.


### API 27 conversational setup

The main model can now draft the same exact plan through `pips_setup`, for human
review. Generic model `pips_propose` remains restricted; it cannot self-authorize
commands. See `PIPS_CONVERSATIONAL_SETUP.md`. A second network profile is
`loopback_http_v1`, reserved for the fixed local HTTP probe, never arbitrary
network-enabled shell commands. See `PIPS_LOCAL_HTTP_CHECKS.md`.
