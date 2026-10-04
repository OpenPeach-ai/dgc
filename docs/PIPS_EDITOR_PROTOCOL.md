# Local editor Pips bridge

The lab editor can manage local Pip conversations, audits, reviewed Patch/Pulse
execution, drafts, schedules, handoffs and workspace context without a Remote account.
The backend advertises these additive protocol-v14 capabilities inside
`ready.capabilities`:

```json
{"pips_supported":true,"pips_api_version":9,"pips_enabled":false,"workspace_identity":{}}
```

Clients must check these capabilities before sending the new commands. No new
Pips event is emitted unsolicited to older clients. This remains a local lab
integration, not an SDK release; signed SDK manifests are not regenerated here.

When enabled and association succeeds, `workspace_identity` contains
`workspace_id`, `workspace_binding_id` and `runner_id` from the private registry.
It stays inside the extensible capabilities object so older strict event
validators still accept the handshake. Failure or disabled Pips yields `{}`;
the backend never imports these IDs from a transcript. Session-root identity is
used for a chat running in an isolated worktree.

## Commands and replies

```json
{"type":"pips_control","request":{"type":"list_workspaces","request_id":"r1"}}
{"type":"pips_result","request_id":"r1","command":"list_workspaces","ok":true,"result":{}}

{"type":"pips_enable","enabled":true,"request_id":"r2"}
{"type":"pips_status","request_id":"r2","enabled":true,"api_version":9,"restart_required":false,"message":"Pips enabled. Jobs run only when you request a run."}

{"type":"pips_runtime","action":"start","request_id":"r3"}
{"type":"pips_result","request_id":"r3","command":"pips_runtime","ok":true,"result":{"runner":{}}}
```

Events also carry the normal protocol `seq`. `pips_control` replies use the
nested request ID, which is required and contains 1–128 characters. `pips_enable`
accepts an optional request ID; `pips_runtime` requires one. Errors in a control
or runtime operation return `pips_result` with `ok:false` and
`error:{code,message}`. Enable/save failures return the standard correlated
`command_rejected`. Invalid outer protocol shapes are also rejected by the
standard protocol validator before dispatch.

API 8 added accepted Patch artifact inputs for Pulse. API 9 adds separately
reviewed historical execution receipts in workspace context; see
`PIPS-EXECUTION-CONTEXT.md`. Python/async and TypeScript control access is described
in `sdk/PIPS.md`. Their request correlation remains nested; the outer command
does not gain an undeclared `request_id`.

Any foreground runtime policy or requested sandbox refuses these independent
runner controls before queueing and again at execution. The main-chat Pips read
and proposal tools use the same boundary: cached evidence may contain data beyond
the foreground session's allowed paths. There is no silent policy inheritance or
SDK fallback to an unrestricted process.

The nested control uses the existing `dgc.pips.handle_control` allowlist and
result envelope, with actor fixed to `editor-user`. The editor cannot supply
filesystem roots, credentials, model routes, trust or permission grants.
`list_workspaces` resolves the backend's configured project directory and
returns `{workspaces,current_workspace_id,runner_id}`. There is no arbitrary
path-registration command.

`list_pip_run_activity` accepts `run_id` and optional `after` (an integer from
zero through 2^63−1). Run identity determines the workspace and Pip. The response
includes those IDs, `events`, `next_cursor`, `oldest_cursor`, `has_more`,
`retention_limit`, `retention_scope` and `history_may_be_truncated`. Pages contain
at most 50 events or 96 KiB before the final control-response budget is applied.
Retention is 5,000 events across a workspace. The ledger is not a permanent
audit archive, and missing initial run activity is reported explicitly.

Requests are detached before asynchronous execution, limited to 16 KiB of
serialized UTF-8 JSON, and bounded in depth and node count. One worker drains at
most 16 pending controls; overflow returns a correlated `busy` error. Slow
database and supervisor-start operations do not run on the chat input reader.
Pips controls are permitted during an active chat turn and do not mutate its
Agent or borrow its foreground worker. Shared settings snapshots and saves use
the existing dispatch guard.

## Enable, stop and independent execution

`pips_enable` persists only `pips_enabled` through the existing `Config.set`
path. The default remains false. Enable starts no worker, clears no persistent
stop, and changes no Remote trust or account state.

Disable first calls `stop_all`, persisting the global stop, pausing jobs and
requesting cancellation of queued/running work. Only then does it save the
disabled flag. A failed stop leaves the flag enabled and returns an error;
it does not claim work has stopped. Re-enabling preserves the stop and returns
`restart_required:true` until the user explicitly resumes it.

`pips_runtime` accepts only `action:"start"` or `action:"resume"`. Start calls
the local `pip_runtime.start_runtime` helper to launch an independent supervisor
and preserves the stop latch. Resume explicitly invokes the helper's resume
path before starting; individual jobs remain paused. Neither action is a
Remote command or a model tool.

All editor calls to `handle_control` set `start_worker=False`. Before accepting
`run_pip` or `send_pip_message`, the bridge additionally requires the independent supervisor's fresh
heartbeat and occupied operating-system lease. The editor never starts an
editor-owned audit worker. If the supervisor exits after the liveness check,
accepted work remains queued for the next explicit restart; a heartbeat cannot
guarantee future process liveness. The existing enqueue/claim transactions
still enforce the persistent stop.

## Separate audiences

Local `pips_result`, `pips_status` and related rejection events go to the editor
only. They are excluded from the shared chat's Remote stream, because they may
contain other workspaces' jobs or context. They are not display events and are
not added to the transient chat history. Web access continues to require the
separate approved-device, encrypted machine-control opt-in; sharing one chat
does not enable it.

The authoritative declarations remain `dgc/editor_protocol.py`. The existing
generator updates both v14 JSON schemas and the extension's
`protocol.generated.ts`. Focused verification is in
`tests/test_headless_pips_controls.py`, covering command/event shapes, current
workspace binding, busy-turn behavior, input/queue budgets, save/stop ordering,
failure recovery, local supervisor ownership and exclusion from Remote chat.
These tests use temporary local state and mocks at process/model boundaries;
they make no model requests or network calls and use no sleeps. The separate
runtime tests and live extension review cover real process/UI behavior.

## Reviewed scheduling increment (API 3)

The earlier dedicated Pips editor required capability version 3. `propose_pip_update`
accepts a human `changes.schedule` (null, interval or daily IANA-timezone spec).
The same saved proposal accept/reject controls perform durable one-use reviews.
`list_pip_approvals` accepts `pip_id`, optional `before_id` and `limit` (1–20),
returning `approvals` and `next_before_id`. Jobs include `schedule` and
`schedule_state`; proposals include `approval_id`, `approval_status`, `expires_at`.
Control request/response byte limits and authenticated actor derivation remain
unchanged. The main-model `pips_propose` tool is a separate restricted seam and
cannot propose schedules or resolve reviews. See the lab review/scheduling notes.


## Types and conversations (API 4–5)

API 4 adds the immutable eight-character catalog with four available source-review
presets. API 5 adds persistent per-Pip messages, genuine provisional model text,
per-Pip native model choices and schema-4 conversation storage. See
[PIPS_CONVERSATIONS.md](PIPS_CONVERSATIONS.md) for exact control
shapes, history/stream limits, cancellation, model pins and the deliberate 128 KiB
worker input envelope. These remain nested controls in protocol v14; no signed SDK
release or main-checkout migration is performed by this local build.

## Calendar schedules and audit continuity (API 6)

The current main-panel client requires API 6. Schema 5 adds one-time schedule
exhaustion and persistent audit checkpoints. The same reviewed schedule control
now accepts bounded numeric cron and explicit-offset one-time timestamps; see
[PIPS_SCHEDULES.md](PIPS_SCHEDULES.md).

`list_pip_checkpoints {pip_id,before_id?,limit?}` returns bounded checkpoint history.
`review_pip_finding {run_id,finding_index,status,expected_revision,reason}` records
an explicit local accept/dismiss/reopen decision and returns `{checkpoint}`.
`get_pip_run` includes `run.checkpoint`; subsequent audit manifests pin the prior
checkpoint and review states at enqueue time. These remain nested controls in
protocol v14. Finding acceptance never grants tools or starts another worker.
See [the checkpoint contract](../../docs/PIPS-CHECKPOINTS.md) for exact shapes,
bounds, immutable evidence and stale-review handling.
