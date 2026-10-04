# Human review of configured command receipts

This increment reads the immutable native configured-verifier attempts and finals
introduced in schema16. It adds a human review projection and an explicit context
recording action. A recorded exit code is a process outcome, not a claim that tests
ran or passed, or that the project is correct. No transcript is parsed as execution
evidence. Unfinalized attempts establish neither launch nor success and cannot be
recorded as outcomes.

The implementation is `dgc/workspace_session_execution.py`. The workspace context
validator recognizes its closed command provenance and binds it to the enclosing
workspace. Tests exercise that production validator; they do not replace it to
manufacture integration coverage.

## API17 contract

The authenticated human controller selects a registered local workspace. The
helper requires that workspace's exact stored binding and local runner before
allocating receipt bodies. A non-persisting configuration clone selects the stored
root; the request accepts no root path. Historical reads and promotions need no
live source directory, source scan, model, command or transcript. Restricted and
sandboxed controller sessions remain refused. Pips must already be enabled.

| Control | Closed request fields |
| --- | --- |
| `list_workspace_execution_receipts` | `workspace_id`, optional `session_id`, `before_id`, `limit` |
| `get_workspace_execution_receipt` | `workspace_id`, `attempt_id` |
| `record_workspace_execution_context` | `workspace_id`, `attempt_id`, `expected_attempt_digest`, `expected_final_digest`, `expected_view_digest`, `expected_context_revision` |

The module interface is `SessionExecutionStore(registry).list/get/record`, with a
required keyword `config`; `record` also receives the authenticated `actor`.

List returns `workspace_id`, selected `session_id` or null, `receipts`,
`next_before_id`, `has_more`, `total_in_scope`, and `retention_limit: 10000`.
Cards contain `id`, `workspace_id`, `session_id`, `created_at`, native `state`,
`exit_code`, `command_preview`, `command_truncated`, `redacted`, and `recording`.
The cursor is the last returned exact attempt ID when another page exists, null
otherwise. Ordering is immutable `(created_at,id)` descending. Cards are navigation
metadata: fetch the exact detail before recording an outcome.

Get returns `{workspace_id, receipt}`. Detail includes the original identities,
session revision at attempt, creation/finalization times, `kind:configured_verifier`,
state, original attempt/final digests, command, source observations/comparison,
native facts, output preview, projection notice, and `view_digest`. It additionally
returns `recording`, `can_record` and `record_blocked_reason` (null, `unfinalized`,
or `already_recorded`). A recording link is `{id,status,created_revision,created_at,
created_by}`. The native states are `exited`, `failed_to_start`, `timed_out`,
`cancelled`, `interrupted`; a missing final is `unfinalized`. No state is `passed`.

`command` contains `text`, historical `sha256`, `digest_kind:original_utf8`, and
`redacted`. `facts` preserves all native fact fields except preview text.
`output_preview` contains `text` and `redacted`. `facts.preview_bytes` and
`omitted_bytes` describe historical captured output retention, not the length of
the newly redacted display. `output_complete:false` means missing output has an
unknown size. UI and CLI must render command/output as inert text, never as
executable instructions or trusted markup.

## Bounds and digest meaning

Each original attempt/final cell is guarded in SQL at 16 KiB before decoding.
Parsing rejects duplicate keys, nonfinite numbers, invalid Unicode, excessive
nesting and unknown fields. Both original canonical digests, row identities,
attempt-final linkage, native status/counts and source comparison are validated.
The private root device/inode and binding metadata are never projected.

List is limited to 20 complete cards and 48 KiB; command previews are at most
256 UTF-8 bytes. Detail is limited to 32 KiB. The original command is bounded at
8 KiB and retained output at 4 KiB. Newly discovered credentials are redacted
again. A configured-secret collision with immutable metadata or fixed notices
refuses the display instead of returning a misleading hash.

`view_digest` hashes the complete safe detail payload before adding the digest
itself, recording link or eligibility fields. Original attempt/final hashes refer
to the original stored records. The output hash represents historical decoded,
redacted UTF-8 output; it never represents raw process bytes. The display digest
is the only digest of the currently displayed projection. None is a signature or
proof against another process running as the same user.

## Context recording and retries

Recording requires a final and all three exact digest pins plus current context
revision. A changed display, including changed redaction, requires fresh review.
The context entry has existing `kind:command` and closed provenance
`source:session_execution`, `schema_version:1`,
`classification:controller_observed_execution`,
`verification:native_process_facts_only`. Manual `user_recorded` commands retain
their existing contract and cannot supply this provenance.

Provenance includes exact attempt/session/turn identity, historical session revision,
attempt/final/view digests, a bounded command preview/digest, native facts and the
before/after source observations. No output prose, complete long command, transcript
or source file is promoted. Fixed canonical wording preserves the limitations.
The whole entry remains within the existing 6 KiB budget; workspace active/total
entry and snapshot limits remain unchanged. Source observations remain
`checked_non_atomic`: matching hashes do not prove the process continuously used
those bytes, exclude edits and reversions, or cover external files/network inputs.

The existing context row records the authenticated review actor, time and revision.
No separate pending/accepted receipt ledger is introduced. At most one active
context entry for an attempt is permitted, enforced inside the write transaction.
The normal context archive action withdraws an active reference while preserving
history; it neither changes the native receipt nor reruns a command.

An exact retry matches actor, original context revision, attempt/final/view digests
against immutable context history. It returns `{context, recording, replayed:true}`
without a new write, including after archival. The recording may be historical and
archived while `context` describes the current workspace. A new deliberate recording
after archival requires fresh review and current context CAS. Current and historical
recordings are checked against the original native facts before reuse.

Before returning a recording or replay, the entire active context and recording
link must survive current credential redaction unchanged. A newly sensitive entry
causes an actionable refusal. This check runs inside the write transaction, so a
new append is rolled back. Historical metadata is not silently recomputed or
rewritten. An archived exact retry still succeeds when its sensitive old entry is
absent from active context.

No new table is necessary. The registry's interpretation version is17 without
rebuilding tables: old schema16 readers cannot
interpret the new command provenance. New readers preserve old rows and queued
context snapshot bytes unchanged.

## Validation status

The read/builder gate passed 23 deterministic tests on native receipt rows.
It covers scope before decode, unsupported policy, missing source directories,
bounded source cells/pages, malformed JSON and native claims, original and display
hashes, secret redaction, no read-side writes/source access, unfinalized attempts,
nonzero exit despite success prose, partial output, and compact canonical context.
The real context transaction gate passed 16 additional tests, for 39 combined.
It covers actor-bound retries, two-connection races, stale pins, rollback after
insertion, context limits, workspace scope, manual-command compatibility, missing
source folders, redaction refusal and archived replay. The interpretation-only
16→17 upgrade preserves schema definitions, old rows and old snapshot bytes; an
older reader refuses17 before context decoding.

The combined receipt/context compatibility gate passed 147 tests, including
native process integration, prior Patch/Pulse context, session statements and
registry concurrency. This is separate from the broader compatibility harness.

CLI/SDK, shared UI and native recording acceptance are separately tracked. No
native context entry was created by these deterministic disposable-profile tests.

## CLI and SDK access

The CLI requires an explicit workspace for all three operations:

```text
dgc pips session-execution list --workspace WORKSPACE_ID
dgc pips session-execution show ATTEMPT_ID --workspace WORKSPACE_ID
dgc pips session-execution record ATTEMPT_ID --workspace WORKSPACE_ID \
  --attempt-digest ATTEMPT_SHA --final-digest FINAL_SHA --view-digest DISPLAY_SHA \
  --expected-context-revision REVISION
```

Review the returned detail and current `dgc pips context list --workspace WORKSPACE_ID`
before recording. Reads can select an offline registered workspace without creating
or resolving the foreground directory. The Python/async and TypeScript SDKs expose
the same controls through `pips.read` and `pips.mutate`; recording requires explicit
`approved=True` / `{approved:true}` on every request, including an exact retry.
These commands require advertised Pips API17; the minimum for prior commands is
unchanged. SDK authority guards remain in force for isolated, plan or restricted
controller sessions. No signature was generated for this local SDK build.
