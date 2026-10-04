# Changes since the pinned audit checkpoint

New audit manifests contain `changes_since_checkpoint`: a bounded reference comparing the prior checkpoint's exact committed source with the new run's pinned commit. The controller records it when queueing the run. Later commits, job reviews or completed checkpoints do not change an existing queue entry; exact retries return the same manifest.

This is committed-tree metadata, not an adaptation grant. It does not rewrite the stable goal, schedules, model route, tools, permissions or finding review state. It does not infer that an issue was fixed or that one commit is an ancestor of another. Both commits may be valid but from unrelated history. Dirty and untracked working-tree changes are excluded.

## Contract

`dgc.pip_source_changes.snapshot(root, source_revision, previous_checkpoint)` returns:

```text
{
  schema_version: 1,
  baseline_checkpoint_id: integer | null,
  baseline_revision: commit | null,
  source_revision: commit,
  comparison: "commit_trees",
  status: "compared" | "unavailable",
  reason: null | unavailable_reason,
  changes: [{path, status: "added" | "modified" | "deleted" | "type_changed"}],
  total_changes: integer | null,
  omitted_changes: integer | null,
  digest: sha256
}
```

The `previous_checkpoint` argument is the complete existing `audit_checkpoint` pin. The current commit must already have been resolved authoritatively by enqueue. The helper checks the prior checkpoint identity and commit format. `validate_snapshot(value, *, source_revision, previous_checkpoint)` is pure: it verifies the closed shape, scope, whole paths, counts, canonical digest and budget before the model is created.

A compared result has exact total and omitted counts for the complete metadata listing; only a whole prefix of paths enters the prompt. A zero count means the two pinned trees had no listed changes. An unavailable result has no paths and null counts, not zero. Reasons are `no_checkpoint`, `baseline_unavailable`, `comparison_unavailable`, `comparison_timeout`, `metadata_limit`, `unsupported_path`, and `invalid_metadata`.

There is no rename heuristic. A rename appears as a deletion and an addition. No patch contents, external document changes, semantic summaries or file contents are included. Legacy queued audits without this optional field remain supported. Conversation, draft, Patch and Pulse manifests do not acquire this audit-specific field.

## Bounds and Git behavior

The Git comparison uses exact commit IDs and NUL-delimited raw records. A bounded read consumes at most 1 MiB plus one overflow-detection byte. Record count is checked before splitting, with a ceiling of 10,000 changes. Each complete path is at most 1,024 UTF-8 bytes; the final reference includes at most 64 paths and occupies at most 8 KiB, including its digest. Newline, tab and Unicode filenames stay intact in JSON. Invalid UTF-8, traversal, Git metadata paths and ambiguous path spellings make the comparison unavailable.

Both Git calls share a ten-second deadline. The controller kills and reaps the owned Git process on timeout or excessive output. No stderr is returned to a model. Git is run without system/global configuration, hooks, filesystem monitoring, external diff, text conversion, rename detection, replacement objects, lazy remote object fetching or permitted transport protocols. The source checkout is never modified.

These are parent output/allocation and duration bounds, not a hard memory ceiling for Git's own process. Existing snapshot and audit worker limits remain separate. A repository with unavailable or excessively large comparison metadata still receives a truthful unavailable reference; that does not broaden the audit's source coverage.

## Model treatment and validation

The worker validates the reference before constructing the agent, then includes it as untrusted JSON reference data. The prompt explicitly requires source inspection and says omitted/unavailable metadata cannot be interpreted as unchanged source or verified fixes. The existing approved job and source report schema remain authoritative.

`tests/test_pip_source_changes.py` covers actual Git commit comparisons, dirty trees, rename-as-delete/add, unrelated history, missing baselines, exact omissions, hostile/truncated metadata, invalid Unicode and paths, bounded reads before splitting, deterministic timeout/reaping, disabled external diff/textconv, immutable queued source/job pins, pre-agent tamper rejection and legacy manifests. Tests use local Git and mocked model replies; they make no network calls and use no sleep synchronization. This is not a claim of live model quality, platform parity or goal-adaptive behavior.

## Queue transaction boundary

Audit enqueue reads its bounded checkpoint snapshot and computes the Git
comparison before taking the SQLite queue write lock. The queue transaction
then compares the current checkpoint (including included finding reviews), job
version, binding and prepared source identity. A change produces a conflict;
there is no run insertion or schedule/event cursor advance. Existing exact
idempotency retries return their original run without recomputing Git evidence.

A read-only handoff prepares the same reference before opening its atomic
approval/reservation transaction. It passes only that private preparation into
enqueue; all existing handoff authority checks remain. Invalid/stale preparation
rolls back the approval and reservation. This prevents the bounded but potentially
10-second Git comparison from monopolizing SQLite's write lock and blocking the
supervisor heartbeat. It is not a claim that all older source/model lookups in
handoff acceptance have been moved out of that transaction.

`tests/test_pip_enqueue_preparation.py` uses controlled thread Events and two
SQLite connections to prove a heartbeat write succeeds while Git preparation is
blocked. It also covers stale checkpoint/job inputs, unchanged event cursors,
exact retry behavior and rollback of stale handoff approval. No sleeps or
elapsed-time pass/fail assertions are used.
