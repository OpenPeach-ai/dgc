# Reviewed Pip claims and preferences — API19

Implemented in the isolated lab at API19/schema19. Storage and controller/CLI,
Python/async/TypeScript SDKs, canonical editor/Remote UI, and bounded audit/chat
references are integrated. The original exception ledger remains separate. No
model write tool, inferred memory, permission grant or Workspace Context promotion
is provided. Native acceptance evidence belongs in the lab tracker; fixture tests
and schema migration alone do not prove configured-model or physical-device use.

Linux native acceptance now covers actual editor review/record, full-window reload,
one configured local qwen3.8 conversation, separate revocation reviews, and reload
again. The original queued pin remains unchanged, while a future snapshot omits
both revoked records. Root checked source/config and all25 earlier runs unchanged.
See lab `output/pips-statements-native-root-check.json` and
`output/pips-memory-statements-native-ui-evidence.json`. This does not certify
other models/platforms or authenticated web/physicaliOS. The broad API19 gate passes
1,376 tests with all413 frozen source hashes unchanged; release signing remains
separate.

Production modules are `dgc/pip_memory_statements.py`, `pip_memory_references.py`
and the existing `pip_memory.py` wrapper. The original staging contract is retained
under the lab's staging/pip-statements/ for review history. See
[PIPS_MEMORY_REFERENCE_V2.md](PIPS_MEMORY_REFERENCE_V2.md) for queue references.

## Human operations and controls

The module accepts an existing `PipStore`; `config` is optional for explicit
configured-secret checking. Actor identity is supplied by the authenticated
controller, never taken from an authored payload. No operation resolves a source
path, opens a transcript, starts a runner, approves a job or executes a model.

```python
anchor(store, pip_id, source_run_id=None, *, config=None)
record(store, pip_id, kind, title, statement, reason, expires_at,
       expected_anchor_digest, request_key, actor,
       *, source_run_id=None, config=None)
revoke(store, pip_id, memory_id, expected_revision, reason, actor, *, config=None)
get(store, pip_id, memory_id, *, config=None)
history(store, pip_id, before_id=None, limit=20, *, config=None)
check_capacity(store, pip_id, now)
validate_anchor(value)
validate_memory(value)
```

Public controls map anchor/record/revoke/history to
`get_pip_statement_anchor`, `record_pip_statement`, `revoke_pip_statement`, and
`list_pip_statements`. The controller record fields are exactly
`pip_id,kind,title,statement,reason,expires_at,expected_anchor_digest,request_key`
plus optional `source_run_id`. `expires_at` must be explicitly provided as null
or a timezone-aware timestamp; normalize to UTC milliseconds. Optional source and
cursor fields are omitted, not sent as null. Common protocol fields are unchanged.
No public `get` control is required for the initial UI; list rows contain whole
records. SDK mutations require explicit approval and API19; API18 fails before transport.

Create requires a fresh anchor and an explicit human review. `fact` is displayed
as **Recorded claim**, not as a verified fact. `preference` is advisory reference,
not an instruction that can override the approved job. Both are local to one Pip.

## Anchor response

Exact top-level shape: `{anchor: A, digest: sha256(canonical_json(A))}`.
Canonical JSON is sorted keys, compact separators, unescaped valid UTF-8 and no
NaN/Infinity. `A` is at most 3,072 encoded bytes:

```text
A = {
 schema_version: 1,
 pip_id, workspace_id,
 job_version: integer 1..999999,
 job_digest: lowercase SHA256 of original UTF-8 pip_versions.definition bytes,
 lifecycle_revision: integer 0..2^53-1,
 binding: {
   binding_id, runner_id,
   updated_at: canonical UTC timestamp,
   root_digest: lowercase SHA256 of the stored binding-root UTF-8 text
 },
 context_reference: {revision: integer 0..2147483647, digest: lowercase SHA256},
 source_reference: null | S,
 source_semantics: "not_observed" | "selected_audit_reference"
}
S = {
 run_id, checkpoint_id: integer 1..2^53-1,
 checkpoint_digest: lowercase SHA256 of original stored checkpoint payload UTF-8,
 checkpoint_digest_kind: "stored_checkpoint_utf8",
 job_version: integer 1..999999,
 source_policy, source_revision, source_snapshot,
 context_reference: {revision, digest}
}
```

`source_reference:null` requires `source_semantics:not_observed`. A selected
source is a successful checked audit of this same Pip/workspace and requires
`selected_audit_reference`. Its checkpoint payload excludes mutable finding
reviews, so changing a finding's disposition does not change this source anchor.
The source does not attest the authored statement or prove its relevance. No
source is silently inferred. Source policy/snapshot shapes are the existing
committed/current-tree contract; current-tree keeps a null Git revision.

Current job/context/binding anchors are metadata observations. Root digests do
not identify source content, and job/context digests do not verify the claim.
Only the optional selected audit contains a historical source identity. No raw
binding path, report body, excerpt, transcript or source file is returned.

## Immutable record and review state

Record and revoke return exactly `{memory: M, replayed: boolean}`. `M` has exactly:

```text
schema_version: 1
id: memory_<32 lowercase hex>
pip_id: pip_<32 lowercase hex>
workspace_id: ws_<32 lowercase hex>
kind: "fact" | "preference"
title: nonempty single-line text <=200 UTF-8 bytes
statement: nonempty multiline text <=2000 UTF-8 bytes
reason: nonempty multiline text <=1000 UTF-8 bytes
anchor: A
anchor_digest: SHA256 of canonical A
created_at: canonical UTC milliseconds
created_by: nonempty single-line actor <=128 UTF-8 bytes
expires_at: null | canonical UTC milliseconds, strictly after creation
classification: "user_recorded_claim" | "user_recorded_preference" (matches kind)
verification: "not_execution_verified"
effect: "reference_only"
digest: SHA256 of the canonical immutable body
status: "active" | "revoked"
revision: 0 | 1
revoked_at: null | canonical UTC milliseconds
revoked_by: null | nonempty single-line actor <=128 UTF-8 bytes
revoke_reason: null | nonempty multiline text <=1000 UTF-8 bytes
```

The immutable body consists of all fields before `digest`, limited to 6,144
encoded bytes. Digest and five lifecycle fields are excluded from its hash.
The complete body plus review receipt is bounded to 7,680 bytes. Single-line
fields reject controls; multiline permits only newline, carriage return and tab.
All strings reject invalid Unicode and NUL. Unknown fields and bool-as-integer
values are refused.

Active is exactly revision0 and all revoke fields null. Revoked is exactly
revision1 and nonnull revoke fields; revocation cannot precede creation. Revoke
requires `expected_revision:0`, including exact retry of the same actor/reason.
A changed actor/reason conflicts; revision1 is not a new revoke authority.
No restore/edit operation exists. The immutable body and digest never change.

Create retries use a per-Pip hashed key namespaced to `record_statement`, and a
canonical request digest including actor, kind, authored fields, normalized
expiry, source-run selection and reviewed anchor digest. The same exact request
returns its original record, even after version/context changes, expiry,
revocation or archival. It does not reactivate it. Changed request/key content
conflicts. A new request rechecks the anchor atomically and refuses archived
Pips; paused Pips remain paused. Read and revoke remain available while archived.

Current configured secrets are refused in authored fields and full returned
views. Reads do not silently redact text while retaining its body hash. A newly
configured secret that overlaps a historical view causes `secret_detected`; the
model read projection separately redacts and omits content-integrity
claims. The main-chat statements action implements a separate bounded, redacted projection.

## Detail and list responses

Module `get` returns exactly:

```text
{pip_id, workspace_id, as_of, memory: M,
 effective_status: "active" | "expired" | "revoked"}
```

`history` returns exactly:

```text
{
 pip_id, workspace_id, as_of,
 entries: [{memory: M, effective_status: "active" | "expired" | "revoked"}],
 counts: {retained, active, expired, revoked},
 returned_records, remaining_records,
 next_before_id: null | positive safe integer,
 has_more: boolean,
 page_reduced_for_budget: boolean
}
```

Counts cover this Pip's **statement ledger only**, across all retained rows.
`retained = active + expired + revoked`; active means active and unexpired at
`as_of`. Stored active status remains unchanged after expiry. Revoked takes
precedence over expired. `returned_records` is page length, `remaining_records`
counts rows strictly after the final returned sequence, and `has_more` equals
`remaining_records > 0`. Cursor is the last returned row's sequence when more
remain, otherwise null. A cursor must belong to this same Pip/workspace. Order
is statement sequence descending, not wall-clock order. There is no invented
global chronology with the independent exception ledger.

Default/max page size is20. Rows are whole and the complete response is <=64 KiB.
A page shortened by that budget explicitly sets `page_reduced_for_budget`.
Scope, counts, source revalidation and page contents share one read snapshot.
Reads never mutate expired records, approvals, jobs, context or runner state.

## Storage and migration

Schema19 adds `pip_memory_statements`, its sequence index and three
immutable-body/one-way-revoke/no-delete triggers. The additive migration preserves
all old table rows and fails atomically. Older runtimes refuse schema19.

`check_capacity` runs inside both statement and exception write transactions,
after exact replay and before a new insertion: at most1,000 total retained records
and32 active/unexpired records per Pip across both ledgers. Expiry and revocation
release active capacity only. There is no prune or deletion path.

Events are atomic metadata-only `pip_statement_recorded` and
`pip_statement_revoked`, containing memory ID/kind/actor as appropriate. Existing
event triggers do not automatically consume them. Event failure rolls back the
record or review. No new event-origin authority is created.

Error codes include `invalid_statement`, `statement_limit`, `statement_mismatch`,
`conflict`, `not_found`, `checkpoint_unavailable`, `archived`, `memory_limit`,
`invalid_cursor`, `transaction_required`, `secret_detected`, and bounded-source
errors propagated from the existing checkpoint/context readers. Do not assume all
corrupt-source errors share one code. No error response includes authored prose,
credentials, a transcript or raw binding path.

## Main-chat reference reads

The existing read-only `pips_context` tool adds `action:"statements"` with required
`pip_id`, optional `before_id` and optional `limit` (default3, maximum20). It uses
the current chat workspace and existing `PipsContext` permission. Runtime-policy,
sandbox and disabled-feature refusals still apply. There are no authored-text,
workspace-selection, source-selection, write, revoke or sharing arguments.

The existing `action:"memory"` continues to page finding exceptions unchanged.
Its cursor and the statement cursor belong to independent ledgers; callers must
continue with the same action/Pip that returned a cursor.

Statement responses add the following to the usual registered-workspace envelope:

```text
{
 pip_id, statements: [projected M + effective_status], statement_notice, as_of,
 counts: {retained, active, expired, revoked}, total_records,
 returned_records, remaining_records, next_before_id,
 has_more, page_reduced_for_budget
}
```

Counts cover only this Pip's statement ledger at `as_of`. `total_records` equals
`counts.retained`. Sequence order, cursor membership and exact remaining counts
follow human history. Expiry is a read-time label and never rewrites stored
status. Historical timestamps may be later than `as_of` after a wall-clock
rollback; the view does not invent chronology.

One read transaction covers current workspace binding, Pip membership, validated
source records, counts and page contents. Membership is checked before loading
any foreign statement or job. Every returned record is first validated against
its immutable body, original job and optional selected audit. The projection then
removes `digest`, `anchor_digest`, anchor `job_digest`, binding `root_digest`,
both context-reference digests and the selected audit's `checkpoint_digest` and
`checkpoint_digest_kind`. Private request digests are never projected. It does
not invoke human history's configured-secret refusal; final tool redaction is
applied after these content-integrity claims are removed.

Commit and source-snapshot identifiers remain labelled historical selected audit
identities. They do not attest the displayed, potentially redacted text, the
authored claim or the current checkout. Claims may be wrong and preferences are
advisory; neither becomes an instruction, grant, suppression rule, execution
proof or shared context. Original source bodies and transcripts are omitted.

The complete redacted tool response is at most24 KiB, including notices and any
redaction expansion. Pages retain whole records and shorten with an explicit
budget flag and exact continuation counts. A single record that cannot fit is
refused rather than clipped. Reads make no registry changes, model calls or
background work. No new SDK control, schema or permission label is needed.

Focused validation passed91 broader context/storage tests, followed by29 old/new
projection tests including concurrent revocation, actor redaction and whole-record
budget refusal. These are deterministic disposable-registry checks, not a native
configured-model acceptance claim.

```sh
PYTHONDONTWRITEBYTECODE=1 /home/fungigb10/dgc/.venv/bin/python -m unittest tests.test_pip_context_statements tests.test_pip_context_memory tests.test_pips_context_bridge -v
```

## CLI review sequence

`dgc pips memory statements anchor PIP_ID [--source-run RUN_ID]` reads the exact
recording anchor. Review its provenance and the authored statement before using
`record PIP_ID --kind fact|preference --title TEXT --statement TEXT --reason TEXT
--anchor-digest DIGEST --request-key KEY` with either `--no-expiry` or
`--expires-at TIMESTAMP`. Repeat the optional `--source-run` only when selected
in that anchor. A changed job/lifecycle/binding/context requires a fresh review.

`list PIP_ID [--before-id N] [--limit N]` reads whole historical statements.
`revoke PIP_ID MEMORY_ID --expected-revision 0 --reason TEXT` records a one-way
revocation. These commands have `--json`; no command runs a model or source scan.

## Verification and limitations

Storage promotion97 and historical migration21 checks passed. Root controller,
CLI, typed references, native-Agent-with-mocked-provider and chat regressions45
passed. Independent storage review found and fixed source-manifest/checkpoint
agreement, oversized scalar reads and ambiguous binding bounds before promotion.
The native schema18→19 migration preserved all old records and configuration.
Full API18 baseline was3310 unittest tests with one maintainer-signature failure
and20 skips; that result is not a full API19 release certification.

The recorded title/statement/reason are user claims, even when an audit was
selected. The selection records provenance only. No truth inference, confidence
score, automatic renewal, cross-Pip sharing, editing or external provider authority
exists. The native platform checks and maintainer SDK signature remain separate.
