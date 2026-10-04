# Local Pip capacity inspection

```sh
dgc pips capacity
dgc pips capacity --json
```

This local terminal command reports retained capacity across the local runner and
the current registered workspace's contribution. It changes no quotas and reclaims
no storage. Exporting a run does not free a slot.

## Four retained counters

| Counter | Records included | Current shared ceiling |
| --- | --- | --- |
| Runs | All `pip_runs` | 1,000 |
| Audit checkpoints | All `pip_checkpoints` | 1,000 |
| Pip exceptions and statements | `pip_memories` plus `pip_memory_statements` | 1,000 combined |
| Session statements | All `workspace_session_outcomes` proposals | 1,000 |

The ceilings come from the existing authoritative writers. They apply across
workspaces in this local registry. Archived Pips, failed/cancelled runs,
revoked/expired memory and rejected session statements remain retained. Malformed
payloads still occupy rows; counting does not validate their contents. Active-memory
and pending-proposal limits are separate and are not included in this report.

Each counter includes a global retained count and the selected workspace's count.
No other workspace's names, identities or authored content are returned. This is
a local-owner view, not a Remote API or model tool.

## Meaning of the result

Each count has one of these shapes:

```json
{"value":820,"relation":"exact","reason":null}
{"value":1001,"relation":"at_least","reason":null}
{"value":null,"relation":"unknown","reason":"deadline"}
```

`exact` includes a count of exactly 1,000. `at_least` means the query reached the
1,001-row sentinel and stopped counting. `unknown` means the bounded query did
not complete or the stored metadata could not be read. Its closed reasons are
`query_budget`, `vm_budget`, `deadline` and `invalid_stored_metadata`. An unknown
count is never displayed as zero.

Remaining slots are calculated only from an exact global count. Pressure is
`normal`, `near_limit` at 80%, `full`, `over_limit` or `unknown`. The 80% warning
does not change a scheduler, writer or quota. Later writes still perform their
own authoritative checks; this read snapshot reserves nothing.

The JSON response has one `capacity_inspection` object with:

- `schema_version: 1`, `registry_schema_version: 22` and `as_of`;
- `scope: {kind: "local_runner_with_workspace", workspace_id}`;
- exactly four `capacity` rows, ordered as `runs`, `checkpoints`, `pip_memory`
  and `session_statements`;
- each row's `kind`, `ceiling_scope: "local_runner"`, `ceiling`, `retained`,
  `workspace_retained`, `remaining_slots` and `pressure`;
- `partial`, true whenever a count is `at_least` or `unknown`;
- `dependency_closure: "not_established"`,
  `reclamation_assessment: "not_performed"`,
  `filesystem_usage: "not_inspected"`,
  `other_capacity_limits: "not_inspected"` and a fixed explanatory `notice`.

Completed counts remain visible when a later query exhausts the shared budget.
Failure to establish the schema or workspace scope refuses the whole request
before any global totals are exposed.

## Read authority and bounds

Use a separate local terminal. Invocation inside chat, an inherited runtime
policy or a requested sandbox refuses. Disabled Pips may be inspected without
enabling them, using the same local read authority as evidence export.

The configured project root is compared lexically with its stored binding for
the stored local runner. It must already be registered and unambiguous. The
source directory is never opened or resolved, so an offline bound folder remains
readable. There is no workspace, root or registry override argument.

The existing pinned read-only export opener requires owner-only local storage,
POSIX no-follow support and Linux procfs. This contract explicitly requires
schema22. It never creates a registry, migrates it, expires approvals, syncs
notifications, starts a runner or changes configuration. Unsupported platforms
and schemas refuse without a weaker fallback.

One SQLite read transaction covers scope and all counts. Fixed queries select
bounded identity metadata and at most 1,001 rows for each count. Combined memory
uses one limited `UNION ALL`; each table does not get a separate allowance.
No body column, transcript, session file, source file or artifact is read or
decoded. No model, provider or network operation is involved.

Application queries share a 32-query ceiling, a conservative 2,000,000-instruction
accounting budget and a three-second monotonic deadline. Each query reserves
1,000 instructions for its unsampled tail, in addition to SQLite progress
callbacks every 1,000 instructions. This overestimate is not measured instruction
usage. Checks after execution and after fetching reject data returned after the
deadline, including schema and binding metadata. The progress handler is removed
before transaction cleanup, including on refusal.

The deadline starts before opening. The opener's fixed setup queries precede
installing the progress handler. This is not a hard preemption guarantee for
filesystem calls, connection setup or arbitrary native blocking. Row limits do
not bound filtered scan work; the shared instruction/deadline budgets cover that
work. The complete pretty-printed JSON plus newline must fit 32 KiB. Metadata
that overlaps a configured secret refuses instead of silently altering identities.

## Preservation and limits

No existing rows, manifests, source receipts, review state or hashes are changed.
Normal SQLite shared-memory locking may still occur; this is not a zero-sidecar
activity claim. The existing opener's same-UID replacement qualifications remain.

Capacity visibility does not solve cold storage or indefinite retained history.
The command performs no dependency scan, disk-usage estimate, deletion, move,
restore, import or safe-to-prune assessment. There is no `--run`, `--apply` or
output-file option. No schema, public API, SDK, Remote or shared UI change is
introduced by this command.

## Verification

`tests/test_pip_capacity.py` uses disposable registries and production imports.
It covers combined/global/workspace counts, retained states, saturation, offline
scope, malformed metadata, policy refusals, SQL snapshot consistency, no writes
or payload/source reads, late fetches, conservative short-query accounting, real
SQLite interruption and cleanup, secret/output limits, and CLI behavior.

Focused CLI, evidence-export and controller-policy regressions accompany it.
These deterministic tests do not establish native acceptance on another platform
or authorize changes to an existing local profile.
