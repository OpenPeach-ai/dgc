# Pip-local source-bound exceptions

This increment adds an explicit human-recorded exception to a checked audit
finding. It does not infer an exception from accepting or dismissing a finding,
does not suppress findings, and does not promote anything to Workspace Context.

The handoff's working-memory requirement is already partly implemented:
immutable checkpoints preserve the prior source, job, context and findings; exact
occurrence comparisons preserve `new`, `repeated` and `not_observed` without
claiming resolution. Finding reviews retain accepted/dismissed/open decisions and
their history. However, the next audit receives only the latest checkpoint. An
older explicit decision can therefore leave the working reference after another
audit completes. A finding dismissal is also not the same as accepting a risk.

`dgc/pip_memory.py` addresses that narrow gap. General facts, preferences,
automatically written memories and cross-Pip shared exceptions remain outside
this increment.

## Human operations

All functions accept the existing `PipStore`. The authenticated human controller
owns access checks; there is no model write tool or new worker permission.

```python
source_exception(store, pip_id, run_id, finding_index)
record_exception(store, pip_id, run_id, finding_index, expected_source_digest,
                 reason, expires_at, request_key, actor)
revoke_exception(store, pip_id, memory_id, expected_revision, reason, actor)
list_memories(store, pip_id, before_id=None, limit=20)
snapshot(store, pip_id, source, job_version, as_of)
validate_snapshot(value, *, pip_id=None, workspace_id=None, source=None,
                  job_version=None)
```

`source_exception` returns `{pip_id, workspace_id, source, digest}`. The source
contains the exact completed run/checkpoint/finding identities, original checked
finding, finding-review revision, job version, canonical source policy/revision/
snapshot and the original Workspace Context revision/digest. Source excerpts
remain checked model assessments, not verified bugs. The read does not record
anything. A user reviews this candidate and submits its exact digest with a
rationale to record the exception. A changed finding-review revision refuses a
stale create request.

Record and revoke return `{memory, replayed}`. Record retries are scoped by Pip
and a hashed request key, with an exact canonical request digest. A different
request using that key conflicts. A revoke has an explicit expected revision;
an identical already-completed revoke returns the original receipt. A different
actor or rationale cannot replace it. Existing active exceptions on the same
finding occurrence must be revoked before replacement. Revoked history is
retained, and exact creation retry never resurrects it.

The immutable memory body contains:

```text
schema_version: 1
id, pip_id, workspace_id
kind: finding_exception
source: the reviewed exact source reference
reason, created_at, created_by, expires_at
classification: user_recorded_exception
verification: not_execution_verified
effect: reference_only
```

The body digest is separate from the one-way lifecycle receipt:
`status: active|revoked`, `revision: 0|1`, `revoked_at`, `revoked_by`,
`revoke_reason`. Expiry is derived at read/queue time; it does not rewrite rows.
An unset expiry means no automatic expiry, never broader source applicability.

The list response is `{pip_id, workspace_id, memories, next_before_id}` with a
Pip-scoped, JavaScript-safe integer cursor. The new API14 controller commands are
`get_pip_exception_source`, `record_pip_exception`, `revoke_pip_exception` and
`list_pip_memories`. Their CLI and SDK adapters follow the same review pins.

## Main-chat read access

The existing read-only native tool accepts:

```json
{"action":"memory","pip_id":"pip_…","limit":20}
```

This is a `pips_context` call. Later pages pass the returned `next_before_id` as
`before_id`. The default page size is 3; the maximum is 20. The current chat's
private project root selects an existing binding. Pip membership in that exact
workspace is checked before any memory or source report is decoded. The model
cannot supply another workspace, mutate memory, grant permissions or approve
work. Disabled Pips, a runtime policy or a requested sandbox refuse the read.

The response adds `pip_id`, `memories`, `as_of`, `total_records`,
`returned_records`, `remaining_records`, `next_before_id`, `has_more`,
`page_reduced_for_budget` and a fixed `memory_notice` to the usual workspace
reference envelope. Counts/cursors share the same read snapshot. Total count
covers this Pip's complete retained exception ledger; remaining count covers records after
this page. Whole records are removed from the end of a page until its redacted
JSON fits 24 KiB. Their cursor remains available; prose/evidence are never sliced.

This is a reference projection, not a byte-identical ledger export. Credentials
are redacted. Memory/body digests, finding-content identity hashes and the
context-content digest are omitted to avoid claiming integrity for changed text.
Original source identifiers remain historical provenance. Each record adds
`effective_status: active|expired|revoked` derived at `as_of`; expiry does not
change a stored `status: active`. The notice explicitly rejects treating an
exception as instructions, suppression, current correctness or execution
authority. Existing `PipsContext` permission handling is unchanged; no additional
SDK mutation or controller command is introduced.

Human-recorded claims and preferences use the separate `pips_context`
`action:"statements"` described in [Reviewed Pip statements](PIPS_MEMORY_STATEMENTS.md#main-chat-reference-reads).
That action has its own statement-ledger cursor and counts. Existing `memory`
requests and exception cursors remain unchanged.

## Audit and conversation reference semantics

New audit and conversation queues pin an optional `manifest.pip_memory` alongside
their existing Workspace Context and report/checkpoint references. Older queued
runs without this field keep their original behavior and bytes. Documentation
draft, Patch and Pulse execution runs do not receive this reference. Patch/Pulse
conversations remain read-only; an exception reference grants no execution power.

The pin records its own Pip/workspace/source/job identity, queue-time `as_of`,
complete retained/eligible/revoked/expired counts, whole included records and an
explicit omitted count. At most 16 unrevoked, unexpired records are included,
newest first, subject to the aggregate byte budget. Eligible older records that
do not fit remain in the ledger. An absent or omitted exception does not prove
that a risk was resolved or that the source was inspected.

Each included record has exactly one applicability label:

| Label | Meaning |
| --- | --- |
| `exact_source_and_job` | The exact source pin and job version match. |
| `historical_source` | The source differs; the job version matches. |
| `historical_job` | The job version differs; the source matches. |
| `historical_source_and_job` | Both differ. |

A matching source and job do **not** establish agreement with current Workspace
Context. Its recorded context revision/digest remain visible historical
provenance. Current-tree receipts retain a null Git revision; their snapshot hash
is never called a commit. A different complete receipt or a source-policy switch
is a different source.

The worker validates the closed pin, both inner and outer digests, all identities,
counts, lifecycle states, expiry and applicability before creating the Agent. It
passes the pin as untrusted reference data. Audits retain fixed instructions to
report all substantiated findings using the unchanged report schema. Conversations
include the same whole pin in their own reference object, so an older exception
remains discussable even when the most recent audit found nothing. Their fixed
notice separates queue-time eligibility from current status, source/job
applicability from agreement with Workspace Context, and historical hashes from
redacted display text. No count/filter logic, permission, tool, schedule or job
authority is derived from exceptions.

Revocation affects newly queued references. It does not rewrite an existing run
manifest or secretly cancel/replan an audit or reply. A queued pin can therefore contain a
decision revoked later; the worker explicitly identifies it as queue-time history.
It is never a permission grant, so this is not delayed permission revocation.

The conversation extension adds no request field, public capability or schema.
The existing shared UI memory-pin reader accepts the identical shape and scope.
An older worker that supports only audit memory explicitly refuses a newly pinned
conversation before constructing an Agent; it does not silently omit the pin.
Update the local runtime before executing newly queued conversations. Existing
conversations without the optional pin remain valid. The worker's 128 KiB input
envelope and existing history/context limits are unchanged; memory adds at most
8 KiB and oversized complete inputs are refused before queue insertion/spawn.

## Bounds and persistence

- Additive SQLite schema14: one `pip_memories` table and history index. Existing
  checkpoints, finding reviews, shared context, statements and notices are not
  rewritten. Database triggers make source/body/retry identity immutable, retain
  history and permit only one active-to-revoked transition.
- API19 uses a combined budget of 1,000 retained exceptions/claims/preferences
  on the runner and 32 unrevoked/unexpired records per Pip across both ledgers.
  Archive management is not added by this increment.
- Rationale/revocation rationale: 1,000 UTF-8 bytes; actor/request key: 128 bytes.
  Complete immutable body: 6 KiB. A source finding too large for this body is
  refused rather than slicing its evidence; the original report remains available.
- Worker reference: 8 KiB, at most 16 whole records, explicit omission counts.
  List page: at most 20 whole records and 64 KiB. No unbounded archive scan is used
  to build the worker pin.
- Source IDs/workspace membership are checked before source decoding. SQL reads
  bound payload and scalar sizes before allocating Python values. Stored sources
  are checked against their original successful audit checkpoint on read.
- Creation/revocation and their metadata-only events commit atomically. These
  operations use only local database records: no filesystem, provider, shell,
  connector or network work runs in their transactions.
- Existing credential redaction applies before persistence. The authenticated
  controller additionally refuses configured secrets in authored rationales.

## Verification scope

Deterministic tests cover explicit-vs-inferred decisions, persistence beyond empty
checkpoints, no finding suppression or shared-context promotion, exact/historical
source/job labels, current-tree identity, expiry boundaries, retry conflicts,
revocation CAS, two database connections, rollback, source tampering, malformed
and oversized values, credential redaction, page/cursor bounds, whole-record
omissions, immutable queued pins and transactional schema13-to-14 upgrade.

The queue/worker integration tests run the real local subprocess and native Agent
with mocked model I/O and a network refusal guard. They confirm that the same
finding is still returned and its next occurrence remains open. These tests are
not evidence that an actual model will always follow the reference instructions;
the controller never performs automatic suppression regardless of model output.
Native configured-model acceptance is a separate root-owned QA step.

`tests/test_pip_chat_memory.py` adds real-Agent/mocked-provider conversation
coverage: older exceptions beyond an empty audit, exact body digests, current
versus historical context, queue-time expiry/revocation and exact retry, Pip/source/
job scope, whole-record omissions, malformed pins refused before Agent creation,
legacy no-pin chats, current-tree provenance, denied injected shell/memory writes,
new credential redaction without rewriting history, and unchanged input bounds.
No memory creation/revocation tool or model permission is added to conversation.


## API19 typed records

Explicit claims and advisory preferences have a separate immutable ledger and
review flow; see [PIPS_MEMORY_STATEMENTS.md](PIPS_MEMORY_STATEMENTS.md). Pips with
no statement history keep the exact version1 pin. Pips with any statement history
use a closed version2 typed pin with independent source/job/context applicability,
whole-record round-robin selection and per-kind omission counts. Revoked history
still selects v2. The 8KiB/16-entry/32-eligible bounds and total worker envelope
remain unchanged. A source-less claim never gains a matching-source label.
Old queued v1 pins remain valid; old workers refuse v2 before Agent construction.
