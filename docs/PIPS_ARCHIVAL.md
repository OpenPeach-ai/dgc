# Retained Pip archival

This isolated lab increment adds API 16 and registry schema 15. Archiving an idle
Pip prevents new work while retaining its job versions, conversations, runs,
checkpoints, reviews, memories, handoffs and workspace context. It does not delete
files or reclaim the existing per-workspace Pip or run-history limits.

## Human controls and exact retries

`archive_pip` and `restore_pip` take this closed request body in addition to their
control type and transport correlation:

```json
{
  "pip_id": "pip_<32 hex characters>",
  "expected_version": 3,
  "expected_lifecycle_revision": 0,
  "request_key": "reviewed-archive-1",
  "reason": "This review is complete; retain its evidence."
}
```

Both expected values are required. The reason is nonempty and limited to 1,000
UTF-8 bytes. Retry keys contain 1–128 ASCII letters, digits, underscores or
hyphens. The authenticated controller supplies the actor; a caller cannot grant
itself a different actor through this request.

The result is `{pip, receipt, replayed}`. `pip` is the current complete job
projection. The immutable receipt has `id`, `operation`, `pip_id`, `workspace_id`,
`job_version`, `lifecycle_revision_before`, `lifecycle_revision_after`,
`status_before`, `status_after`, `reason`, `actor` and `created_at`. An exact
actor/key/payload retry returns its original receipt and the current Pip without
repeating the change. Therefore a historical archive receipt can accompany a Pip
that has since been restored. A reused key with different arguments is refused.

CLI equivalents are `dgc pips archive PIP` and `dgc pips restore PIP`, with
`--expected-version`, `--expected-lifecycle-revision`, `--request-key` and
`--reason`. The extension and shared Remote client use the same controls. There
is no native model tool for archive or restore. SDK mutation access keeps its
existing explicit approval and unrestricted-controller requirements.

## Status and concurrency rules

Archive accepts `active` or `paused` and changes it to `archived`. Restore accepts
only `archived` and changes it to `paused`. Restore never resumes a Pip, launches
a worker or approves a saved request. Repeating the same desired state with a
new key is refused; use the original key to retry a decision.

Each actual status transition increments a separate `lifecycle_revision`. The
approved job version is unchanged. Revision tracking also covers ordinary
pause/resume transitions. Queue preparation records this revision before source
capture or Git comparison, then checks it again in the queue transaction. An
archive/restore/resume cycle cannot make old preparation look current merely
because the status and job version match again. Handoff preparation checks both
Pips in the same way.

Archive and restore refuse any nonterminal run, including queued, running,
cancelling or waiting work. They also refuse pending unexpired job approvals,
unresolved proposals without an approval record, and incoming or outgoing
pending unexpired handoffs. These controls never silently cancel or reject
anything. Expired, rejected and completed records remain readable.

Archived Pips cannot start runs or conversations, accept a job change, create a
new proposal, adapt their definition, or participate in a new executable
handoff. Existing saved exact retries may return historical receipts or runs;
they do not dispatch new work. Historical finding and execution-result reviews,
memory record/revoke controls and workspace-context promotions remain available.

Human pause/resume always refuses an archived Pip. Once a Pip has archival
history, resume also requires its current lifecycle revision. API 16 interfaces
send that revision for both pause and resume. New native `pause_pip`,
`resume_pip` and `attach_pip_to_session` calls require it for every Pip. Older
saved native requests can be replayed only as historical observations, not used
to make a new transition or attachment. The scoped native context projections
include the current revision so the model can obtain this required pin.

## Automation and retention

Archive and restore clear pending event-trigger backlog and reset committed-head
observations without generating a run. Due time-schedule occurrences are
consumed in the same transaction without changing the approved anchor or
schedule. A one-shot occurrence that elapsed while archived stays consumed.
Recurring occurrences resume from the next future due time. Both scheduler scans
and readiness probes exclude archived Pips, so an archived due cursor cannot
continually wake an empty scheduler task. A later explicit resume still follows
the existing paused-job scheduling semantics.

Schema 15 adds lifecycle state and an append-only archival receipt ledger. It
initializes existing Pips at revision zero and does not rewrite prior evidence.
The archival ledger is capped at 10,000 receipts. At the cap, a new transition
fails without changing state. This increment has no purge, deletion or archive
export workflow. Archival alone does not solve storage-cap recovery.

## Validation

The local deterministic gate passed 281 tests spanning archive transitions,
schema rollback, lifecycle authority, source preparation, handoffs, memories,
notifications, schedules, events, context and session outcomes. Archive-specific
cases cover two-connection compare-and-swap races, exact retry receipts, queued
and waiting work, unresolved reviews, source-preparation status cycles and
offline interval/one-shot backlog consumption.

The final archive/schedule/event regression passed 75 tests after the readiness
probe fix. The independent authority and lifecycle gate passed 35 tests and
additionally covers stale native lifecycle calls,
legacy receipt compatibility, revision discovery and archived scheduler
readiness. Native UI and private-runner migration acceptance are recorded by the
root agent separately; unit tests are not evidence of those platform checks.
