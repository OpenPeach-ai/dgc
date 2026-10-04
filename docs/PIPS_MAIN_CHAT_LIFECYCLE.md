# Main-chat Pip lifecycle and attachments

This isolated build adds `pause_pip`, `resume_pip`, and
`attach_pip_to_session` to the ordinary DGC tool loop. Each accepts exactly:

```json
{
  "pip_id": "pip_<32 hex digits>",
  "expected_version": 1,
  "expected_lifecycle_revision": 0,
  "reason": "Why this change belongs to the current task",
  "request_key": "unique-key-in-this-chat"
}
```

The model supplies neither session nor workspace identity. The main Agent's
private origin callback and the local session/workspace registry establish both.
The project root, owning session binding, and Pip workspace must agree before
reading job state. These checks repeat inside the mutation transaction. Reopening
the same saved chat preserves its links; a reviewed identity-preserving workspace
rebind preserves them at its new root. A different chat or a different workspace
does not inherit those links. Transcript migration remains a separate operation.

## Permissions and effects

The native permission labels are `PipsPause`, `PipsResume`, and `PipsAttach`, each
scoped by `pip_id`. They are mutations, not read-only tools or file edits.
Default and acceptEdits modes ask; plan mode denies; auto mode still honors deny
rules. Child agents, monitors, disabled Pips sessions, RuntimePolicy-controlled
sessions and requested sandboxes cannot use them. Python/TypeScript SDK permission
maps recognize the labels without bypassing the independent-runner restriction.

Pause uses the existing job status transition and trigger backlog handling. It
holds future background work. It does not cancel a running turn or disable the
Pip's conversation. Resume permits existing approved queued and scheduled work;
it refuses a stopped runner and requires an already running independent
supervisor. Neither tool changes configuration, starts a runtime, clears global
stop, creates a run, changes a job definition, or bypasses handoff approval.

Attach stores a reference only. It does not copy or authorize raw transcripts,
read a report, expand tools, change source policy, or start work. Names, stable Pip
IDs, lifecycle state and attached/current job versions appear as explicitly
untrusted reference JSON in the main prompt after rebuild/resume/compaction.
`pips_context` with `action: "attachments"` reads the same session-scoped metadata.
The model must inspect the current definition before asking a Pip to run.

## Durable retries and receipts

Schema 11 adds `pip_lifecycle_requests` and `session_pip_attachments`; the migration
is transactional. Status/backlog updates and an immutable operation receipt
commit together. Attachment insertion and its receipt do likewise.

A request key is unique across all three operations **within one owning chat**.
The digest covers the operation and exact normalized arguments. Reusing the key
for a different Pip, operation, version or reason fails. Identical retries return
the historical receipt and do not reapply an action after a user overrides it.
An old pause retry therefore cannot pause a job that the user subsequently
resumed. A successful resume retry remains readable after the runner stops.

The response separates `receipt` from `current`, plus `replayed` and
`state_changed_by_this_call`. `receipt.changed` describes the original committed
operation, not a replay. `run_queued_by_this_call` and
`runtime_started_by_this_call` are always false. The existing supervisor can
independently dispatch previously authorized work after a resume.

Job-version and lifecycle-revision checks protect new operations. Schema 15
tracks every status transition separately from the immutable job version, so an
archive/restore cycle cannot make an old unsent resume or attachment current
again. The model reads both values from the current Pip definition. The revision
must be an integer from zero through 9,007,199,254,740,991. New receipts retain
`lifecycle_revision_before` and `lifecycle_revision_after`; `current` reports the
present revision. Checks repeat after supervisor inspection, inside the write
transaction. A no-op status or attachment request does not increment it.

Exact saved legacy requests that lacked the lifecycle field remain readable;
they may not create a new receipt or mutation. Removing the field from a new
request does not make it a legacy retry because the exact request digest differs.
Exact saved retries remain readable
after a later job version, provided the authoritative owning workspace still
matches. Present status and attachment state are separately re-read. Definitions,
stored receipts and scalar metadata are bounded and validated before projection;
configured credentials are redacted before persistence and refused in IDs/keys.

## Bounds and remaining limits

- Reasons: 1,000 UTF-8 bytes; keys: 1–64 ASCII letters, digits, `_` or `-`.
- At most 16 links per session and 10,000 links across this private registry.
- At most 10,000 immutable lifecycle operation receipts. A full archive refuses
  new operations while preserving exact retries.
- Prompt references fit 8 KiB, retaining whole references and counting omissions.
  Attachment reads use the existing bounded `pips_context` response limit.
- No detach UI or receipt archive management is implemented yet. At the link cap,
  use workspace Pips reads for other references. Do not manually delete durable
  request receipts to retry an action.
- Attachment references do not automatically promote findings into shared
  workspace context, transfer chat history, or grant an execution source.

These are native main-chat tools. API 16 human pause/resume controls accept an
optional lifecycle pin; once a Pip has archival history, resuming it requires the
current pin. This preserves ordinary never-archived controls while refusing a
delayed prearchive resume packet. Restoring a Pip always leaves it paused and
does not itself resume work. Current-tree source restrictions remain unchanged.

## Validation

Deterministic tests cover cross-workspace refusal, owning binding and rebind,
exact retries after overrides, cross-operation key conflicts, concurrent retry,
global stop/offline supervisor, in-flight versus queued work, atomic rollback,
attachment prompt rebuild, malformed stored records, credential redaction,
schema migration rollback, permission denial and the real Agent tool loop with a
stubbed provider. No model/network calls or sleep-based assertions are needed.

The 24 lifecycle tests passed. A combined 211-test Python gate passed before the
last two lifecycle regressions; five SDK permission tests and the TypeScript SDK
build also passed. These counts overlap and are not a single additive total.

The archival increment adds eleven independent authority regressions:
stale unsent resume/attach across restore, an archive cycle during supervisor
inspection, exact current and legacy historical retries, missing/invalid pins,
required native-schema discovery and scoped revision reads, offline schedule consumption,
and exclusion of archived jobs from supervisor readiness checks. These execute no provider calls.

Actual configured-model acceptance used the isolated CLI in default mode with
only `PipsAttach(pip_b8a5d0926cff487cafcfd3c54cf8ac47)` and the matching
`PipsPause` scope pre-approved. The model called attach then pause, saved both
receipts, and completed in 65.44 seconds. The test Pip had no recurring schedule
or event trigger. Its prior active status was restored through ordinary CLI
`pips resume-job`; a model-driven resume was not part of this acceptance. No Pip
run was created, no active run remained, and the sample Git source stayed clean.
Evidence: [native receipt record](../../output/pips-lifecycle-native-evidence.json)
and [native event log](../../output/pips-lifecycle-native-events.log), both in the
lab's `output/` directory outside the repository. Schema at acceptance: 11.
