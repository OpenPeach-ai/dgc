# Starting a reviewed Pip from the main chat

`run_pip_now` is an opt-in main-chat tool. It starts one existing read-only audit
(Scout, Lens, Rook or Lock) or one Quill documentation draft. It uses the existing
Pip queue, immutable run manifest, native Agent, pinned model connection, read-only
tool policy, source limits and cancellation path. There is no second model loop.

The request has exactly four fields:

```json
{
  "pip_id": "pip_<existing identity>",
  "expected_version": 3,
  "reason": "Review the source for the current task.",
  "request_key": "review-once"
}
```

The caller must first inspect the job with `pips_context` and use its exact current
version. The reason records the caller's explanation; it does not replace the
approved goal or become additional worker instructions. Identifiers are bounded,
the reason is at most 1,000 UTF-8 bytes, and configured secrets are redacted before
persistence. A private server-owned origin callback supplies the session and
workspace. Model arguments cannot supply or override them.

The separate permission is `PipsRun`, optionally scoped as `PipsRun(pip_id)`.
Default and acceptEdits ask, plan denies, and auto mode or an explicit matching
allow rule may authorize the call. Explicit deny still takes precedence over ask
and allow. It is not a read-only tool merely because the resulting worker reads
source: running it consumes compute and creates durable work. Child agents,
monitor turns, disabled Pips, foreground RuntimePolicy and requested sandbox
sessions do not receive this capability and cannot invoke it through an invented
tool call. Pip workers' native policies deny it too.

Only Pips in the owning session's registered workspace can be addressed. Both the
session association and job version are checked again inside queue insertion,
after source preparation. Moving or changing that association during preparation
refuses dispatch. Preparation does not hold the SQLite write lock. A changed job
requires a fresh inspection; the tool cannot silently run the replacement goal.

The retry key is scoped to **session and Pip**. Repeating identical content returns
the saved run even after its job is edited, paused or stopped. It never starts a
second run or resolves a new source revision. Changing the reason or version under
the same key is refused. Another Pip or another session has its own key namespace.
The stored row and private request envelope must agree. Other dispatch kinds cannot
reuse a main-chat run's key. Existing larger conversation manifests retain the
shared worker input budget on retry.

For new work, an individual pause or global stop remains authoritative. This tool
cannot resume anything, create jobs, approve proposals, change models, add schedules,
write to the project or execute Patch/Pulse. Those roles still require their exact,
separately reviewed handoff. Existing automatic schedule/event state is not changed.

New work requires a live independent supervisor, checked through its heartbeat
and process lease. The tool never starts a supervisor or a foreground drainer.
This matters for a one-shot CLI: its exit must not interrupt the Pip it just
queued. If the supervisor stops after the check, durable queued work remains
pending until the user restarts it. Exact saved retries remain readable offline.

The compact response reports the saved run ID, status, version, source identity,
kind and policy. Queueing is not completion. Read `pips_context` for progress and
later use its report or draft action. The full private origin/retry envelope is
retained in local run storage and stripped from the public run projection. Normal
runner status and restart controls diagnose asynchronous failures. A queued or
failed receipt is never automatically replaced by a fresh execution on retry.

Tests use temporary private registries, actual Git fixtures, deterministic mutation
hooks, a scripted model through the existing Agent and no network or sleeps. These
tests establish routing and authority, not real-model judgment or output quality.
Native configured-model acceptance is recorded separately in the lab evidence.
