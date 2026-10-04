# Main-chat handoff proposals

`handoff_to_pip` saves a proposal in the existing durable handoff archive. It does
not accept a finding, approve a handoff, enqueue work, wake a runner, change a job,
or grant tools. The user reviews the saved task, source evidence, target version,
model and exact action through the existing Pips review UI or CLI. Existing
acceptance then rechecks the source, target, model, expiry and execution policy.

The closed tool request contains:

```json
{
  "source_kind": "finding",
  "source_run_id": "run_<32 hex digits>",
  "finding_index": 0,
  "target_pip_id": "pip_<32 hex digits>",
  "task": "Investigate this source finding.",
  "action": {"kind": "read_only"},
  "request_key": "follow-up-1"
}
```

`source_kind: artifact` omits `finding_index` and requires an accepted successful
Patch result, a Pulse target, and its exact test action. Finding inputs require a
successful source-checked audit checkpoint. A Patch action lists exact relative
write paths and zero to four commands; Pulse lists one to four commands. The
existing action validator fixes network access off and retains the existing
resource limits. There is no environment, endpoint, credential or permission
override. Current-tree snapshots and current-tree job policies are refused for
handoffs; these need separate manual read-only runs.

Only the owning main chat can call the tool. Both source and target must belong
to its authoritative registered workspace, and the target must differ from the
source Pip. Scope checks precede private report/definition parsing and repeat
inside the proposal transaction after source/model preparation. Session IDs come
from the controller callback, never model arguments. The public proposal actor
and private retry key use hashes rather than publishing the chat ID.

`PipsHandoff` is a separate mutating permission. Default and acceptEdits ask;
plan mode refuses. Auto mode and explicit permission rules retain their normal
meaning, including deny precedence. Disabled Pips, child agents, monitor turns,
RuntimePolicy sessions and requested sandboxes cannot use this tool. An
independent Pip worker's native policy also denies it. SDK permission tables know
both `PipsHandoff` and `PipsRun`; this does not make an SDK RuntimePolicy session
eligible to use an independent runner.

Retries are scoped to the owning session, source **run** and target Pip. The same
key and canonical task/action return the original proposal, including after a
separate human acceptance, rejection or expiry. Changed work under that same
scope/key conflicts. Changing source run or target is a different retry scope.
The existing immutable request digest and unique constraint provide this without
a new schema or second handoff archive. A replay may durably expire an old pending
proposal using the existing expiry path; it cannot dispatch work.

The response is a receipt under 4 KiB: handoff ID, source/target IDs and job
versions, payload digest, current review state/revision/expiry, and any already
existing target run ID/status. `review_required` means currently pending and
unexpired. `execution_started: false` describes this tool call, including a replay
whose handoff was previously approved by a person. It never claims that queued
work is complete. Source evidence, commands and native connection settings are
not repeated in the receipt.

Input is bounded before serialization: task at most 4,000 UTF-8 bytes, retry key
at most 64 ASCII characters, finding index 0–15, existing bounded exact action,
and complete request at most 24 KiB. Configured secrets are redacted from task
text and refused in identifiers, retry keys, write paths and command arguments.

Validation uses deterministic local Git/SQLite fixtures and a mocked provider
through the actual Agent tool loop. No tests send network requests, sleep, or
start a Pip worker. The artifact fixture constructs a private Patch diff locally;
actual confined execution remains covered by the separate execution acceptance
tests, not claimed by this tool's proposal tests.
