# Checkpoints across source policies

API 11 distinguishes a Git commit from a reviewed current-tree snapshot. A snapshot
SHA-256 is never written into `source_revision` as though it were a commit. For
current-tree runs that field is null and `source_snapshot` carries the validated
receipt, including exclusions and the `checked_non_atomic` consistency statement.

Pure committed-source histories retain their existing immutable payloads, version
1 checkpoint envelopes, counts and digests. An existing queued version 1 envelope
continues to validate byte-for-byte. It is not silently normalized or rewritten.

A currently reviewed current-tree policy or an existing version 2 checkpoint makes
the next checkpoint envelope version 2. That envelope can contain an unchanged
legacy checkpoint. New current-tree checkpoints, and subsequent checkpoints in a
history that has crossed source policies, add:

```text
schema_version: 2
source_policy: {mode: "committed_only"}
            | {mode: "current_tree", exclusions: "safe_source_v1"}
source_snapshot: null | <exact snapshot receipt>
comparison: {
  status: "compared" | "unavailable",
  reason: null | "no_checkpoint" | "source_policy_changed",
  previous_checkpoint_id: integer | null
}
```

With no prior checkpoint, or when the source policies differ, comparison is
unavailable. `baseline_checkpoint_id` is null, each finding says `uncompared`, and
the `new`, `repeated` and `not_observed` counts are null. The total finding count
remains an integer. `previous_checkpoint_id` preserves the preceding pinned
checkpoint's identity even when it cannot serve as a comparison baseline. No older
same-policy checkpoint is silently substituted for the actual pinned predecessor.

When policies match, exact path/title/evidence identities use the existing
occurrence comparison. Different snapshot hashes do not themselves make two
current-tree observations incomparable: they are different source observations
under the same reviewed exclusion policy. Line/severity changes retain the existing
identity rules. Missing findings still mean not observed, never fixed. Duplicate
prior occurrences remain counted; review dispositions do not carry authority to a
new occurrence.

All successful checked audits retain their findings and per-occurrence review
controls, including those whose comparison is unavailable. History and main report
views preserve source metadata and comparison status. New UI readers must retain
null counts and show the unavailable reason; they must not coerce null to zero.

Validation is bounded and closed. A version 1 envelope cannot carry version 2
source metadata. Pure queued-pin validation checks included occurrence labels
against declared counts, exactly when the full list fits and as upper bounds when
whole findings were omitted. Readback ties checkpoint source identity to the
immutable successful audit manifest; a locally corrupted checkpoint cannot relabel
a Git run as a snapshot, or substitute another snapshot digest. Neither an envelope
digest nor a user review establishes the truth of a model conclusion.

Deterministic tests cover legacy payload/digest retention, current-tree first runs,
same-policy comparisons, switches in both directions, queued predecessor stability,
whole-finding omission, reviews, history projection and hostile source/count data.
They establish persistence/validation behavior using local fixtures. Actual source
capture and real-model execution have separate integration evidence.
