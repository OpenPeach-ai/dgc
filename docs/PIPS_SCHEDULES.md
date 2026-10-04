# Reviewed local Pip schedules

Schedules reuse the durable Pip queue, committed-source snapshot, model pinning,
read-only worker and existing approvals. Saving a schedule proposes a new job
version. Only accepting that exact proposal arms it. Scheduling grants no tools,
changes no permission mode, and does not start a supervisor or install a service.

API 20 extends this existing review path to committed-source Quill private drafts.
Quill occurrences retain `run_kind:draft` and carry an immutable reviewed
definition/occurrence grant; [Quill drafts](PIPS_QUILL_DRAFTS.md) specifies it.
Current-tree Quill, Patch and Pulse do not gain automatic scheduling authority.

## Canonical definitions

A manual-only job stores `schedule: null`. Existing interval and daily definitions
are unchanged:

```json
{"type":"interval","minutes":60,"missed_policy":"coalesce_latest"}
{"type":"daily","time":"02:00","timezone":"Asia/Kolkata","missed_policy":"coalesce_latest","dst_policy":"skip_gap_first_fold"}
```

The two additional definitions are:

```json
{"type":"cron","cron":"0 2 * * 1-5","timezone":"Asia/Kolkata","missed_policy":"coalesce_latest","dst_policy":"skip_gap_first_fold"}
{"type":"once","at":"2026-10-02T09:00:00.000Z","missed_policy":"coalesce_latest"}
```

Policy fields may be omitted on input; validation adds the shown values. Other
policies and unknown fields are refused. A one-time timestamp requires seconds,
`Z` or an explicit numeric UTC offset, and at most three fractional digits. It is
canonicalized to UTC milliseconds. There is no separate timezone field for this
unambiguous instant. For example, the two occurrences of `01:30` during a fall
clock change can be chosen explicitly using their different offsets. DGC does
not guess which local occurrence the user meant.

A one-time schedule must still be in the future **when approved**. If its time
passes while waiting for review, acceptance rolls back without creating a job
version, resolving its approval, or arming a cursor. A new time must be proposed
and reviewed. Validation does not reject a past timestamp in a saved draft; the
approval check is authoritative.

## Numeric cron subset

Fields are minute, hour, day of month, month, and weekday. Ranges are respectively
`0–59`, `0–23`, `1–31`, `1–12`, and `0–7`; both `0` and `7` mean Sunday. Supported
syntax is a number, `*`, a comma list, an ascending range, or a positive step on
`*` or a range. Use `5-59/10`, not `5/10`. Names, macros, seconds/year fields,
wrapping ranges, `?`, `L`, `W`, `#`, commands and environment assignments are not
supported. Only ASCII digits and the shown separators are accepted.

Month is always a filter. If day of month is the bare `*`, weekday decides. If
weekday is the bare `*`, day of month decides. Otherwise, either matching day
field is sufficient (OR). Only the **bare** `*` counts as unrestricted; an
expression such as `*/2` is constrained. This is an explicit subset, not a claim
of compatibility with every operating system's cron dialect.

Calendar schedules use installed IANA timezone data. Nonexistent local minutes
are skipped. Repeated local minutes use their first actual instant only. No
second run occurs when clocks fold back. One-time schedules use the explicit
instant instead of these calendar rules.

## Work bounds and refusals

- A cron expression is at most 256 characters, with five fields and at most 32
  comma items per field. Numeric tokens are at most two digits. Ranges are
  validated before expansion into their fixed natural domains.
- Times must be at least five nominal local minutes apart, including the cyclic
  midnight gap. This deliberately conservative check also applies when selected
  calendar dates are not consecutive. It limits a cron to 288 local times per
  matching date. Historical timezone offset changes mean this is a nominal
  local-time limit, not a universal promise about elapsed UTC spacing.
- Calendar validation checks at most the 146,097 dates of one Gregorian
  400-year cycle. It rejects impossible dates and calendars with gaps greater
  than 366 local dates, including leap-day-only schedules. Successful immutable
  plans have a bounded 64-entry cache. Invalid expressions cannot cause an
  unbounded future search or user-sized allocation.
- Finding the next or latest cron occurrence examines at most 370 local dates
  and at most 288 times on each matching date. It never enumerates an outage's
  occurrences. A timezone gap that removes a sparse annual occurrence can put
  the next valid occurrence beyond this bound; that case is refused explicitly,
  rather than searched indefinitely or shifted to another local time.
- One-time and interval planning use constant-time arithmetic. Daily planning
  retains its existing eight-local-date bound. Datetime range overflow is an
  actionable refusal. Timezone data is required; no third-party package is added
  or silently fetched when the operating system lacks it.

These limits are intentionally smaller than general-purpose cron. For a date
outside this recurring subset, propose one explicit future instant instead.

## Missed work and durable cursors

Intervals retain their approval-time anchor. Daily and cron schedules select the
first occurrence strictly after approval. Offline recurring work coalesces to
the **latest** due occurrence and queues at most one run. A one-time job that was
approved in time can run once when the runner returns online.

A cursor advances atomically with queue insertion, using the approved job version
and occurrence as its idempotency key. Canceling or failing the queued run does
not replay that occurrence. Paused jobs and jobs already queued, running or
cancelling consume and skip the occurrence; they do not accumulate a backlog.
Global emergency stop leaves cursors unchanged. Queue/source/model failures leave
an occurrence due and defer retries by the existing 30-second spacing. Each tick
examines at most eight jobs.

After a one-time occurrence is queued or skipped, `schedule_state.next_due_at`
is `null`; `last_due_at` and `last_checked_at` remain. This means **consumed**, not
necessarily successful. The run or skip event records what happened. An unchanged
schedule on a later text/model job revision preserves this exhausted cursor.
Rearming requires a different future instant and another reviewed version.
Switching to manual-only removes the cursor.

Schema 5 rebuilds the existing cursor table transactionally to allow this nullable
next instant while preserving its rows, foreign keys and due index. Existing
interval/daily cursors retain their times and anchors. There is no second scheduler
configuration file and no interpretation of project files as approved schedules.

## Local commands

```sh
dgc pips schedule PIP_ID --expected-version 1 --cron '0 2 * * 1-5' --timezone Asia/Kolkata
dgc pips schedule PIP_ID --expected-version 1 --once '2026-10-02T14:30:00+05:30'
dgc pips accept PIP_ID PROPOSAL_ID --expected-version 1
```

The first commands save proposals; the last accepts the reviewed proposal. Use
the isolated lab launcher when testing. A running local supervisor is needed to
consume due work; creating or approving a schedule does not start it.

## Verification scope

`tests/test_pip_calendar_schedules.py` covers grammar and allocation bounds,
impossible/leap-only dates, numeric calendar precedence, daylight-saving gaps and
first folds (including a half-hour transition), a date-line skip, centuries of
offline coalescing with bounded candidate counts, bad stored cursors, precise
one-time offsets, future-at-approval rollback, restart/idempotence, canceled and
paused/busy occurrences, global stop, error retry, reviewed rearming, and competing
writers. `tests/test_pip_schedules.py` retains the interval/daily and existing
scheduler race regressions. These use temporary registries and controlled clocks,
with no provider requests or sleeps. This is deterministic local verification,
not a claim that future DST rules or every operating system have been tested.
