# Local committed-source observation

The schema-10 commit observer supports the human-reviewed `commit_changed` event
trigger for Scout, Lens, Rook and Lock. It observes each Pip's approved local
`source_ref`; it does not watch files, run a model or enqueue anything itself.
The ordinary event controller separately checks the approved trigger, job state,
queue, cooldown and occurrence identity before enqueueing an audit.

The observer records a baseline silently on first observation, after a reviewed
reference change, after a binding change, and after a pause/resume backlog reset.
A changed committed hash emits `workspace_commit_changed` for that specific Pip,
containing only `job_version`, `source_ref`, `previous_revision` and `revision`.
The event controller filters these events to their target Pip, so one branch's
observer cannot start another branch's audit. No paths, file contents, diff text
or event-provided instructions enter the event pin.

This detects a changed committed identity, not ancestry or a complete commit
history. Force updates and resets count as changes. Several commits while offline
coalesce to the latest observed hash. A branch that changes and returns to the
same hash between samples is not observable. Dirty and untracked files do not
cause an event. The audit uses the current approved source at enqueue; a commit
event does not force a historical checkout or authorize a different source.

## Durable state and races

`pip_commit_observations` stores the Pip/job version, binding identity, binding
update time, a private digest of the binding identity and canonical root, approved
ref, last good commit, last check and a cumulative observed-change count for the
retained observation. Disabling the trigger deletes this observer bookkeeping;
it does not delete retained activity events. The root
digest prevents two rebinds sharing a timestamp from reusing an unrelated baseline.
The digest is local bookkeeping, never a global workspace identity.

`reset_observation(registry, pip_id, job_version, spec, approved_at)` runs inside
the approved job-version transaction. Text/model changes with the same ref and
binding retain the baseline and cooldown. Changed refs/bindings clear the
baseline; removing `commit_changed` deletes the observer. Automatic metadata
adaptation uses the same helper, without changing the event cursor/cooldown.

`tick(registry, config, *, now=None, limit=8, stop_event=None)` returns counts
`checked`, `baselined`, `changed`, `unavailable` and `skipped`. It probes at most
8 active armed Pips, at least 30 seconds apart per Pip, oldest check first. Each
write rechecks the exact saved state, current version/binding, active status,
global stop and shutdown signal under the registry write transaction. The
baseline update and event insertion commit together. Competing observations can
produce only one event for that transition. A failed ref lookup retains the last
good baseline and records its check time for backoff.

Pause/stop skips are not approval. Per-Pip pause/resume discards event backlog and
clears the observer baseline in the same status transaction. The event controller
owns equivalent global-stop semantics. Restart alone preserves the baseline and
counter, allowing one coalesced change notification after offline time.

## Probe boundaries

`observe_commit(root, source_ref)` permits only the existing approved ref grammar
(HEAD, local branch names or full commit identities). It verifies that Git's
repository root exactly matches the canonical registered directory. Subdirectory
and symlink aliases are refused. It then runs:

```text
git rev-parse --verify --end-of-options <source_ref>^{commit}
```

Both Git calls share a 3-second deadline. Root output is bounded at 4,097 bytes;
revision output at 128 bytes. The shared capture helper reads only limit+1 before
rejecting overflow and kills/reaps its process group on timeout. At most eight
probes give a 24-second Git deadline budget per tick, plus bounded local database
work. The owned event thread keeps this off the heartbeat thread. Cancellation
is checked between probes and before committing; shutdown can wait for the
current probe's bounded deadline.

The probe uses the existing source-change helper's sanitized environment: no
system/global Git config, optional locks, replace objects, lazy object fetch,
network protocols, hooks or filesystem monitor. It invokes no shell, external
diff, text conversion, checkout, helper, model or repository command. Git remains
an external native process: these limits bound output and elapsed work, not a
hard Git-process memory ceiling. A malicious same-UID actor replacing private
state concurrently is outside the registry's ownership boundary.

Tests use actual temporary Git repositories and controlled clocks, with no sleeps
or network. They cover baseline/change/restart, dirty/untracked silence, branch
switches, removed refs, pauses/stops, cancellation and competing connections,
rebinds including identical timestamps, strict refs, output/deadline failures,
corrupt stored bounds, fair capped probing and suppression of configured Git
helpers. Root's event tests separately cover review/enqueue/worker authority.
