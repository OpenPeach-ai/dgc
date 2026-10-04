# Reviewed event triggers

API 10/schema 10 adds event-triggered read-only source audits. This is an
alternative to a time schedule, not a new permission tier. Scout, Lens, Rook and
Lock support it. API 20 also supports committed-source Quill private drafts,
with a separately validated immutable automation grant; see
[Quill drafts](PIPS_QUILL_DRAFTS.md). Patch and Pulse refuse event triggers. Ordinary manual
runs remain available. There is no automatic handoff, fix, test execution, merge,
deployment or external write.

The immutable job field is `event_trigger`, initially `null`:

```json
{
  "events": ["context_updated", "finding_accepted", "commit_changed"],
  "minimum_minutes": 5,
  "missed_policy": "coalesce_latest"
}
```

API 18 also supports `session_turn_completed`, a saved foreground turn notice,
not a completed-session or testing claim. Choose one to four distinct events.
The minimum interval is an integer from 5
to 10,080 minutes; the default is 5. A job cannot combine a schedule and event
triggers in this version. Changing either requires the saved proposal/review
flow, and the complete canonical definition is covered by the review digest.
The main model cannot add or change triggers through `pips_propose` or
`pips_adapt`. A human can review them through CLI/extension/paired controls.

```console
dgc pips trigger PIP_ID --expected-version 1 --events context_updated finding_accepted --minimum-minutes 30
dgc pips show PIP_ID
dgc pips accept PIP_ID PROPOSAL_ID --expected-version 1
```

`trigger` only creates the proposal. Disabling uses `trigger PIP_ID
--expected-version N --off`, followed by the same review. To switch to a time
schedule, first review removal of the event trigger, or submit one reviewed
definition change explicitly setting both fields. An event trigger's approval
summary says "Change event trigger for …".

## Event meanings

- `context_updated`: an explicitly recorded, archived or promoted workspace
  context entry. An audit merely completing does not create this event.
- `finding_accepted`: a user changes a local finding's review to accepted.
  Findings being generated, dismissed or reopened do not qualify. The event is
  a reason to inspect again, not proof that the finding is true or a grant to fix
  it. This does not replace separately reviewed finding/artifact handoffs.
- `commit_changed`: this Pip's approved committed source reference resolves to
  a different commit than the runner last observed. First observation and a
  changed source reference/binding establish a baseline silently. The detector
  does not watch dirty files, fetch remotes, install hooks or change the checkout.
  Multiple commits between observations coalesce to the latest observed identity.

Commit observations target a specific Pip. Two jobs watching different branches
in one workspace do not trigger each other. Source resolution is local-only,
bounded in time/output and runs away from the supervisor heartbeat thread.

## Queue and recovery guarantees

The same existing supervisor and immutable run queue execute audits and Quill
drafts. There
is no second model loop. A tick examines at most eight eligible jobs. Event checks
and commit observations have a 30-second minimum polling/retry interval; probes
are bounded individually and cancellation is checked between jobs. The user
chooses a minimum interval between enqueued event runs, not an exact run time.
Supervisor downtime and a busy queue can delay work.

Approving a new/different trigger records the current workspace event cursor. It
does not replay existing history. An unchanged trigger preserves its cursor and
cooldown when a reviewed or policy-authorized metadata version changes. Pausing
and resuming consume the old backlog, including events received while the daemon
was offline. A busy Pip skips the latest qualifying event rather than running
overlapping audits. A source/configuration/queue error leaves the event pending
and retries after the polling interval; disabling/global stop prevents new work.

The queue insertion and cursor advance share one SQLite transaction. A repeated
exact `(job version, event sequence)` request returns the same run before reading
mutable source/model settings. Changed retry data is refused. Stale job versions,
removed retained events, changed policies and future timestamps are refused.
No source revision is chosen by an event: the run pins the job's approved
committed source at enqueue time, which can be newer than the triggering event.

Only the bounded event ID, sequence, type and timestamp enter the immutable
manifest. The payload is neither selected nor sent to the model. The worker
checks this closed event envelope before constructing the native Agent.

Workspace activity retains at most 5,000 events. After sufficiently long
downtime, historical events may be gone. The pin conservatively reports
`history_may_be_incomplete`; it does not claim a count of lost events. Global
sequence gaps from other workspaces can also set this flag. This is bounded
coalescing over retained history, not durable delivery of every event.

## Scope still outstanding

File-system, session-completion and external-integration events are not added by
this increment. OS push notifications, email delivery and multi-runner routing
remain separate work. The commit detector does not turn a Git remote URL into
workspace identity or synchronize two machines.

Tests use controlled clocks, bounded subprocess fixtures and real temporary Git
repositories. They make no model/provider network calls and use no sleeps.
Native configured-model/editor acceptance is recorded separately from these
contract tests; neither establishes accuracy of model findings.
