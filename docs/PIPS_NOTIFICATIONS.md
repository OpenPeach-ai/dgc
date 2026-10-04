# Local Pip notifications

The notification inbox records local review links and failed-run links. It has shared unread/read state for this runner. It does not deliver operating-system, email, web-push or iOS notifications, and it does not store an account-level inbox on the relay.

## Sources and authority

`dgc/pip_notifications.py` materializes notifications from these registry events:

| Event | Notification reference |
| --- | --- |
| `pip_job_update_proposed` | Exact durable approval, job proposal and Pip IDs; job or schedule review category comes from the approval |
| `pip_handoff_proposed` | Exact handoff and target Pip IDs |
| `workspace_session_outcome_proposed` | Exact session-statement proposal ID |
| `pip_run_failed` | Exact failed run and Pip IDs |

An event is a candidate, not an authority grant. The module rereads the current source within its workspace and confirms the event's Pip identity. Reviews already resolved or expired when first observed do not create a new notification. Cancelled or successful runs do not become failure notifications. No notification is synthesized from a model's prose.

The cache contains IDs, fixed titles, source times and read receipts. It contains no job goals, proposal text, source evidence, handoff task, transcript, error body, endpoint, credentials or private filesystem paths. Session-statement creation time currently lives inside the immutable proposal envelope: that one bounded envelope is read to obtain its identity and time, but authored text is never copied into the inbox. Unrelated progress and transcript event payloads are not read.

Opening a review must still fetch its exact current proposal or handoff through the existing review API. A notification cannot supply approval authority. Marking it read changes only its own receipt, even if the source resolves concurrently. The operation does not accept a proposal, acknowledge a finding, cancel a run, start a supervisor, change settings, or grant tools.

## Storage and bounded catch-up

Schema 13 adds a notification cache, one durable event cursor, and a small seen-source identity archive. The visible cache retains the newest 500 notifications across this local runner. Read state is shared by the local extension and paired controllers; the first reader and timestamp are preserved. This is not separate read state for every paired phone or browser.

Each list call scans at most 100 event rows, including irrelevant events. It advances the cursor through all scanned rows. It performs no unbounded loop to find 100 matches. SQL byte checks precede Python allocation or JSON decoding of source metadata. A request can materialize only this cache; it never mutates the underlying work. A malformed or unavailable candidate is skipped, counted, and cannot permanently block cursor progress.

Catch-up starts at the oldest retained event. `sync_pending` explicitly reports remaining events, and `sync_scanned` reports work performed in this call. During catch-up, the page is only the observed portion of the inbox. A client may refresh bounded pages while showing that limitation; it should not describe the result as complete when `sync_pending` is true. New events can arrive after any response snapshot.

Retention reports:

- `retained_count`, `unread_count` and `oldest_seq`: the requested workspace view, or all workspaces bound to this runner.
- `evicted_total`: total cache entries pruned from this runner.
- `unavailable_sources_total`: candidate events skipped because their source metadata was missing, invalid, out of scope, or could not fit the identity archive.
- `history_may_be_incomplete`: latched event-history gaps, cache eviction or skipped candidates.
- `sync_pending`: events still awaiting the next bounded materialization.

Sequence gaps are checked across the global event scan, so ordinary interleaving of workspaces does not count as missing history. An event deleted before it was observed cannot be reconstructed. A notification deleted by retention cannot be marked read; the caller gets `not_found` and must refresh.

Deduplication uses source kind plus exact source ID. Immutable seen-source keys survive visible-cache eviction, so a later duplicate event cannot recreate a previously pruned notification as unread. This archive has a separate 20,000-key ceiling. At that ceiling, newly observed keys are omitted and counted; source jobs and reviews continue unaffected. No current inbox API deletes or resets this archive.

A source may resolve after notification creation. The entry remains historical and may remain unread, while its fresh `source_status` and `actionable` flag change. Missing or malformed sources become `unavailable` with `actionable: false`. A failure entry is actionable when its exact source still reports failed; its action is to inspect the run, not rerun it implicitly.

## Python helper contract

```python
list_notifications(registry, workspace_id=None, before_seq=None, limit=20)
mark_read(registry, notification_id, expected_revision, actor, workspace_id=None)
```

`list_notifications` returns:

```text
runner_id, workspace_id,
notifications[],
unread_count, retained_count, oldest_seq,
next_before_seq, has_more,
retention_limit, evicted_total, unavailable_sources_total,
history_may_be_incomplete, sync_pending, sync_scanned
```

Each notification has:

```text
id, seq, workspace_id, pip_id|null,
kind: needs_review|run_failed,
source_kind: job_update|schedule_update|handoff|session_outcome|run,
reference, title, occurred_at, created_at,
read_at|null, read_by|null, revision: 0|1,
source_status, actionable
```

References are closed objects:

```text
job_update/schedule_update: {approval_id, proposal_id, pip_id}
handoff: {handoff_id, target_pip_id}
session_outcome: {proposal_id}
run: {run_id, pip_id}
```

Pages are newest cache-sequence first, at most 20 entries. `before_seq` is an exact integer from 1 through `2**53 - 1`; booleans, floating-point numbers, zero and negative values are refused. `next_before_seq` is the last returned sequence only when another retained page exists; otherwise it is null. Cache sequence is observation order; `occurred_at` preserves the source's original timestamp.

`mark_read` returns `{notification, replayed}`. An unread entry requires expected revision 0 and changes once to revision 1. An already-read entry returns its original receipt for revision 0 or 1, with `replayed: true`; it never overwrites the original reader. Supplying revision 1 for an unread entry produces `conflict`. Unknown, evicted or foreign-scope IDs produce `not_found`. Optional workspace scope binds both the lookup and returned entry.

All errors are `RegistryError`; malformed request/cursor, corrupted metadata and stale read state remain explicit. No raw parser exception or private source body is returned.

## Validation

The deterministic notification suite uses temporary registries and local fixture repositories. It covers actual job/schedule, handoff and session-statement sources; failure-only classification; no source-state writes; exclusion of large private payloads; expired and resolved reviews; bounded event scanning; paging; retention and duplicate events after eviction; restart persistence; exact workspace/runner scope; poisoned metadata; transaction rollback; immutable cache references; and two-connection acknowledgement races. It uses no network calls or sleeps.

The core helper has 26 passing focused tests. The combined 175-test notification, migration, lifecycle, handoff, event, adaptation and session-statement gate passed in 23.985 seconds. It includes schema-12 upgrade failure/rollback and exact preservation of prior context and statement rows. Protocol/UI integration and real-runner acceptance are tracked by the parent build, separately from these deterministic tests.
