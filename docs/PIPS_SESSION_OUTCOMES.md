# Reviewed session statements

This increment fills the explicit session-to-workspace promotion path. It deliberately does not infer verified tests from transcript prose. Ordinary foreground Bash has a real process return code, but its durable transcript representation is text. Its structured retained output is process-local, expires, and does not pin exact source bytes. Context notes additionally use command-name/output heuristics. Neither is an appropriate execution attestation.

The user selects a local, privately associated session and an exact source reference, writes a bounded statement, reviews the saved proposal, and accepts it into Workspace Context. A statement remains `classification: user_reviewed_statement` and `verification: not_execution_verified`. Its source relation is always `selected_for_statement`. Even selecting the source from a successful Pip run does not prove that an ordinary session command ran on those bytes, or that the statement is correct. Patch/Pulse's separate controller-recorded historical receipts retain their existing classification.

No model tool can accept, reject, or automatically promote these statements. No transcript text, tool output, note, model summary, path or credential is automatically copied into shared context. This feature grants no permissions, schedules, tools or execution. Historical references remain data in downstream prompts.

## Python contract

`SessionOutcomeStore(registry)` lives in `dgc/workspace_session_outcomes.py`:

```python
inspect(workspace_id, session_id, *, config) -> dict
propose(workspace_id, session_id, title, statement, source,
        expected_session_revision, request_key, actor, *, config) -> dict
get(workspace_id, proposal_id) -> dict
list(workspace_id, *, before_id=None, limit=20) -> dict
accept(workspace_id, proposal_id, expected_digest,
       expected_context_revision, actor, *, config) -> dict
reject(workspace_id, proposal_id, expected_digest, actor) -> dict
```

The authenticated controller owns actor and read/workspace authorization; direct read/reject methods are internal controller APIs. Inspect/propose/accept also require Pips enabled, an unrestricted foreground context, exact local workspace binding, and authoritative private session association. A transcript's own workspace fields cannot grant that association. Unknown/cross-workspace identities fail before transcript reads; accept authorizes before parsing the private statement payload.

For human machine controls, selecting an existing registered workspace explicitly resolves that binding and creates a nonpersisting `Config.clone_for_root` view. This permits Remote's workspace picker to inspect or review the chosen workspace even when the ordinary foreground chat was launched elsewhere. The original configuration, permission containers and project selection are not modified. Requests cannot supply a filesystem root, and model tools do not use this adapter. The private session association must still match the selected workspace exactly.

Source input has one of two closed shapes:

```json
{"kind":"commit","revision":"exact 40- or 64-character lowercase Git object ID"}
{"kind":"pip_run","run_id":"run_…"}
```

A commit is resolved by the existing safe Git path against this workspace root, without branch-name inference. A run must have succeeded in the same workspace and binding and preserve matching immutable manifest/source/result metadata. Current-tree references retain a null commit revision and the complete separately identified snapshot receipt. No new source capture or run is started by recording a statement.

Inspect returns `{workspace_id, session: {id, revision, sha256, bytes}}`. Propose/get/reject return `{workspace_id, proposal}`. Accept adds the current `context` view and a `replayed` boolean. List returns `{workspace_id, proposals, next_before_id}`; cursors are decreasing private ledger sequence numbers, not filesystem paths.

The immutable proposal payload contains `id`, `workspace_id`, `session`, `title`, `statement`, `source_reference`, `classification`, `verification`, `created_at`, and `created_by`. Its SHA-256 digest covers exactly that bounded canonical payload. Source reference contains the validated selection, canonical `source_policy`, `source_revision`, `source_snapshot`, and `relation: selected_for_statement`. Public review fields add `digest`, `status` (`pending`, `accepted`, `rejected`), `reviewed_at`, `reviewed_by`, and `entry_id`; the latter three are null before review.

An accepted context entry has kind `session_outcome`, the exact reviewed title, a fixed not-verified disclaimer followed by the statement, and provenance `{source: session_statement, proposal: <immutable payload>, proposal_digest}`. Reads verify the digest, classification, title and content relationship. Accepted proposal reads also validate the linked immutable context entry, including after that entry was archived.

## Bounds and concurrency

- Title: 240 UTF-8 bytes. Statement: 1,536 UTF-8 bytes. Retry key/actor: 128 bytes each. Configured or recognizable credentials in statement/title/retry key cause refusal.
- Transcript: 8 MiB, checked before open/read; 64 KiB read chunks. The reader hashes the complete bytes and validates complete JSON, including skipped messages and trailing data. Only top-level identity/project/revision metadata is retained. It does not allocate the entire transcript or a list of messages.
- JSON: depth 64, 200,000 values, object keys at most 1 KiB each/1,024 per object, 64 KiB retained key bytes across active objects, numeric scalar at most 128 characters. Duplicate keys, bad escapes/UTF-8, unpaired surrogates, invalid message shapes and ambiguous identity/revision fail closed.
- Proposal payload: 8 KiB. Pages: at most 20 records and 64 KiB of encoded results, with a cursor that advances over exactly the returned records. The existing 6 KiB context-entry and 16 KiB active-context budgets still apply.
- At most 1,000 retained proposals and 32 pending proposals per workspace. Rejected/accepted history is retained; archive management for proposal history is not implemented.

The private file is opened through POSIX no-follow directory descriptors, rejects symlinks/hardlinks/special files, and uses the existing session lease. File identity, mode, link count, size, timestamps and the private bucket's current identity are checked before and after reading and immediately before storing. Root device/inode plus the private binding revision are pinned, so replacing/rebinding the root invalidates a pending proposal. A moved transcript must first use the explicit session migration flow. Unsupported non-POSIX platforms refuse this inspection path.

Source resolution and complete transcript validation occur outside a SQLite write transaction. Accept rechecks exact transcript generation/hash, source reference and binding, then under one transaction checks proposal digest/status and expected context revision, appends context, and records acceptance. The ordinary session lease stays held across this metadata-only transaction. Rollback cannot leave an accepted proposal without its context entry. Hash/metadata checks detect ordinary concurrent changes; they are not an adversarial same-user or atomic-filesystem guarantee. Byte bounds also do not provide a hard I/O deadline on a stalled filesystem.

Exact proposal retries return the saved proposal without re-reading source or transcript. A different request using the same session/workspace retry key is refused. Accepted retries return the historical acceptance and present context without recreating an archived entry. A pending proposal whose session has progressed requires a new explicit proposal; it is never silently refreshed.

The runner-wide review index includes pending statements as kind `session_outcome`, with `pip_id: null`, `expires_at: null`, a fixed summary and only the exact proposal ID in `reference`. It never exposes the title, statement, transcript metadata or source reference. The caller opens the saved proposal in its explicit workspace before any decision. Workspace counts add `reviews_session_outcome` and include it in `reviews_total`; older approval/handoff rows keep their existing fields unchanged. Mixed pages retain the existing descending `(created_at, id)` cursor order, including continuation after a statement cursor is accepted or rejected. The statement ledger's bounded timestamp extraction reads at most 1,000 payloads, one at a time, and retains only small index records; it requires neither a new database schema nor SQLite's optional JSON extension. Counts use grouped queries without loading those bodies.

Schema 12 adds the immutable proposal ledger and extends the context kind constraint. It preserves all old context rows, provenance and snapshot digests byte-for-byte. There is no ordinary session schema change and no model/tool-loop hook.

## Verification scope

Tests use disposable Linux files, Git repositories and SQLite registries. They cover full-stream hostile JSON, bounds before read, symlink/hardlink/FIFO refusal, generation/hash changes, path and private-identity mismatches, root replacement, stale context/digest, exact retries, review rollback, migration rollback/restart, classification preservation and scoped read-before-decode. No provider calls, sleeps or network are used. Real UI/native acceptance is recorded separately; this document does not claim macOS or Windows runtime verification.

The initial combined session/context/lifecycle/adaptation/event/chat/handoff gate passed 179 tests. A separate controller test exercises actual inspect → propose → accept from a different foreground directory using only the explicitly selected registered workspace, plus foreign-session and root-injection refusal. These are real local Python/Git/SQLite controller tests; they do not require a model or execute project test commands.
