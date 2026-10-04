# Runner summaries and pending review navigation

Pips API 10 adds three aggregate read-only endpoints for Remote Home, Projects,
Reviews and recent activity. They use the same authenticated, encrypted Remote
control path as individual Pip views. No summary is persisted by the relay.

These calls read one SQLite snapshot and do not resolve a project directory,
expire approvals, enqueue work, change settings or start the background runner.
Opening the registry still performs its normal local schema compatibility check.
A missing or moved launch directory does not prevent these reads.

## Workspace summaries

`list_workspace_overviews {after_id?: string, limit?: integer}` accepts 1–20
items (default 20), ordered by stable workspace ID ascending. It returns:

```text
{
  runner_id, as_of,
  workspaces: [{id, name, kind, counts: {
    pips_active, pips_paused, pips_archived,
    runs_active, runs_queued,
    reviews_job, reviews_schedule, reviews_handoff, reviews_total
  }}],
  next_after_id: string|null, has_more, total_workspaces
}
```

Active runs include `running` and `cancelling`. Pending reviews include saved
pending job/schedule approvals and handoffs whose expiry is after `as_of`.
Each handoff counts once, including when its source and target belong to the
same workspace. Only workspaces bound to this local runner are included.
Counts use grouped queries, independent of the number of Pips;
clients need not fetch every Pip or report. Paths, binding roots and model
connection settings are excluded.

## Pending review references

`list_pending_pip_reviews {workspace_id?: string, before_id?: string,
limit?: integer}` accepts 1–20 items (default 20). Omitting workspace scope reads
this runner's pending reviews across workspaces. Explicit null is invalid.
Rows are newest first by immutable creation time and ID. The response is:

```text
{
  runner_id, as_of, workspace_id: string|null,
  reviews: [{id, kind, workspace_id, pip_id, created_at, expires_at, reference}],
  next_before_id: string|null, has_more, total_pending
}
```

`id` is an opaque review cursor. For `kind: job_update|schedule_update`,
`reference` contains `approval_id`, `proposal_id` and `expected_version`.
For `kind: handoff`, it contains `handoff_id`, `expected_revision`,
`source_pip_id`, `source_run_id`, `target_pip_id`, `target_job_version` and
`source_kind` (`audit_finding.v1` or `patch_artifact.v1`). A handoff row's
`pip_id` is its target Pip.

These are navigation references, not complete approval envelopes. The client
must fetch the current Pip/handoff and open its existing detailed review before
accepting. A pending record may have stale source/model/job inputs; listing it
does not claim it can still be accepted. Expired records are filtered without
rewriting their stored status. Cursors remain usable if the referenced review
resolves between pages. A cursor from another workspace is refused for a scoped
request. Pagination is live rather than a snapshot across multiple requests:
new reviews above the cursor appear on refresh.

## Recent activity

`list_recent_workspace_activity {workspace_id?: string, before_seq?: integer,
limit?: integer}` accepts 1–50 items (default 50), newest sequence first. This
is distinct from the original forward `list_workspace_activity` API: fetching
that API with `after: 0` reads the oldest retained page, not recent activity.

```text
{
  runner_id, as_of, workspace_id: string|null,
  events: [{seq, event_id, workspace_id, event_type, pip_id, run_id, payload, created_at}],
  next_before_seq: integer|null, has_more,
  oldest_cursor, newest_cursor,
  retention_limit: 5000, retention_scope: "workspace",
  history_may_be_truncated: boolean
}
```

`pip_id` and `run_id` may be null. Cursors are exact nonnegative integers no
larger than 2^53−1 so they survive browser/JSON round trips. Events are returned
whole, with a 96 KiB page budget; a byte-limited page also sets `has_more` and a
usable next cursor. Configured secrets are redacted by the existing controller
response boundary. Clients should render allowlisted labels, never interpret
payloads as HTML or commands.

Retention is 5,000 events **per workspace**. Scoped oldest/newest values describe
that workspace's retained rows; unscoped values are the min/max across this
runner's retained rows. They do not establish an intact global archive. A
missing initial `workspace_resolved` event conservatively sets
`history_may_be_truncated`; sequence gaps alone do not, because another workspace
can own those sequence numbers. A late refresh cannot recover pruned events.

## Bounds and authorization

SQL checks UTF-8 byte lengths before allocating or decoding stored text in
Python. Workspace names are capped at 512 bytes; IDs at 128 (review cursors 160);
event payloads at 8 KiB. Handoff metadata is validated from its existing bounded,
digested 24 KiB payload. JSON depth and node budgets apply before returning event
payloads. Invalid/oversized local rows fail closed with no partial success.

No new schema or credentials are required by these three reads. They still
require locally enabled Pips and the existing authenticated controller boundary.
SDK calls require an explicitly inherited profile controller without a foreground
RuntimePolicy or requested sandbox, because independent Pip scope cannot inherit
those policies. API 10 is required for these three reads and
`list_pip_adaptations`; existing API 8/9 controls retain their older minima.

Tests use temporary private databases, mocked clocks and actual local SDK
transport with network entry points refused. They cover grouped counts, global
and scoped pagination, expiry without writes, resolved/stale cursor behavior,
newest-first events, retention, byte budgets, hostile storage, no workspace
resolution/runtime startup, redaction and additive SDK capability gating.

## Exact proposal preview

`get_pip_proposal {pip_id, proposal_id}` is an API 10 read for stable review links.
It returns `{runner_id, as_of, proposal}`. The proposal contains `id`, `pip_id`,
`workspace_id`, `expected_version`, the exact saved `definition`, `actor`,
`reason`, `status`, `created_at` and nested `approval`. The approval contains
`id`, `action_type`, `action_summary`, stored `status`, derived `effective_status`,
`created_at`, `expires_at`, nullable `resolved_by` and nullable `resolved_at`.

The definition is capped at 16 KiB and must match the approval's saved digest.
Pip membership and this runner's binding are checked before decoding it. No
legacy defaults are added to the saved definition. The originating private
session ID and digest are not exposed. Existing legacy resolver timestamps such
as `unrecorded` are retained rather than fabricated.

Proposal status is `proposed`, `accepted`, `rejected`, `superseded` or `expired`.
Approval status is `pending`, `approved`, `rejected`, `superseded` or `expired`.
When a saved pending review is past expiry, `effective_status` is `expired` while
stored status is returned unchanged. Reading never resolves or expires a review.
The existing accept/reject commands still revalidate current job version and
review authority; this read is a preview, not a grant or a lock.
