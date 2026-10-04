# Merged queue-time memory envelope — version2

Implemented at API19/schema19. The statement storage contract is in
PIPS_MEMORY_STATEMENTS.md. Preserve exact v1 pins
and responses for Pips with no statement history. An old worker must reject v2
before constructing Agent. This stays in the single `manifest.pip_memory` key.

V2 has exactly the v1 top-level fields plus `context_reference` and
`counts_by_kind`; `schema_version` is 2. Fields are:

```
schema_version, pip_id, workspace_id, source, job_version, as_of,
context_reference: {revision, digest},
total_records, revoked_records, expired_records, eligible_records,
omitted_records, counts_by_kind, entries, digest
```

`source` is the existing closed committed/current-tree source pin.
`context_reference` matches the run's immutable workspace_context revision and
digest, not a live read at worker execution. `job_version` is the queued version.
`as_of` is canonical UTC milliseconds. Digest covers all other fields with the
existing canonical sorted JSON SHA256. Entire envelope including digest <=8192
UTF-8 bytes, <=16 whole entries, <=32 eligible and <=1000 retained records across
both ledgers. The complete worker input ceiling remains128KiB.

`counts_by_kind` has exactly `finding_exception`, `fact`, `preference`. Each is
`{total_records,revoked_records,expired_records,eligible_records,omitted_records}`.
For each kind, total=revoked+expired+eligible and eligible=included+omitted.
Top-level counts equal corresponding sums. Revoked takes precedence over expired.
No per-kind count or ID discloses another Pip's data.

An entry is exactly `{memory,applicability}`. The memory is an unchanged validated
v1 exception record or a validated v1 statement record. It must belong to this
Pip/workspace, be active/unrevoked and unexpired at as_of, and have creation <=as_of.
IDs cannot repeat, including across kinds. Applicability is exactly:

```
{
 source: "not_observed" | "same_pinned_source" | "historical_source",
 job: "same_pinned_job" | "historical_job",
 context: "not_recorded" | "same_pinned_context" | "historical_context"
}
```

For exceptions, compare their original `source` pin, source job version and
nullable source.context_reference. For statements, compare the optional
anchor.source_reference pin (otherwise not_observed), anchor.job_version and
anchor.context_reference. Statement context is the reviewed recording context;
the optional selected audit's separate historical context stays provenance only.
Equality describes identities, not correctness, relevance, or proof that a live
tree is unchanged. A source-less statement can never acquire same_pinned_source.

Selection is deterministic round-robin kinds in the order exception, fact,
preference, with descending ledger sequence within each kind. Consider at most32
eligible candidates. Include whole records only; if one cannot fit, skip it,
retain its omitted count and continue to a smaller candidate. Stop including
after16 entries. This is a bounded selection policy, not causal chronology or
truth/importance ranking. V1's existing selection behavior remains unchanged.

Only audit and the Pip's own conversation receive these references. Prompts label
claims as possibly wrong, preferences as advisory, exceptions as nonsuppressing,
and all content as untrusted reference. None changes the approved goal, tools,
permissions, source policy, output contract or Workspace Context. Pins remain
historical after revocation/expiry; omission is not resolution or completeness.
