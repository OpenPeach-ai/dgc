# Local Workspace Context Hub

This lab implementation stores explicit reference records for a stable local
workspace identity. It does not grant tool permissions, change a Pip's approved
job, or automatically promote transcripts, model output or project files into
trusted instructions. No model, network, scheduler or executable callback is
called by the context store.

## API and authority

`dgc.workspace_context.ContextStore(registry)` uses an existing
`WorkspaceRegistry` connection. Its methods are:

```python
get(workspace_id) -> dict
record(workspace_id, kind, title, content, expected_revision, actor) -> dict
archive(workspace_id, entry_id, expected_revision, actor) -> dict
accept_finding(workspace_id, run_id, finding_index, expected_revision, actor) -> dict
snapshot(workspace_id) -> dict
```

`get` and mutations return `{workspace_id, revision, entries}`. Entries contain
`id`, `kind`, `title`, `content`, `created_at`, `created_by`, `created_revision`,
`status: "active"` and `provenance`. They are ordered by creation revision.
The initial revision is zero. Every successful mutation increments it once.
`expected_revision` must be the exact integer revision the caller reviewed;
stale writers receive `RegistryError` with code `context_conflict`.

The authenticated controller supplies `actor` from the approved device or local
caller. This storage API does not authenticate a string passed by arbitrary
Python code. Remote authorization and command allowlisting remain at the
existing encrypted control boundary. A model does not receive these mutation
methods as tools.

User-recorded kinds are `decision`, `milestone`, `command`, `risk` and
`exception`. Their provenance is
`{"source":"user_recorded","classification":"user_record"}`.
Commands are reference text, never executable permissions. An exception record
does not waive native policy, approvals or other gates. Text whitespace is
preserved; over-budget input is refused rather than truncated.

`archive` removes an entry from the active view and retains its immutable body
and provenance with archive actor/time/revision in SQLite. There is no edit,
delete or restore API in this slice. Record a replacement explicitly. Database
triggers also reject changes to entry bodies/provenance, history deletion and
repeated/reversed archive transitions. These protect application integrity,
not against an operating-system user who can replace their own database.

## Explicit finding acceptance

`accept_finding` accepts a zero-based integer index from a successful run in the
same workspace. Queued, running, failed, cancelled, foreign or missing runs are
refused. Boolean, float and string indexes are refused. The entry copies the
stored finding title and exact checked source excerpt. It retains this
provenance:

```text
source: pip_finding
classification: model_assessment
verification: source_excerpt_only
run_id, pip_id, finding_index
source_revision (pinned commit), job_version, model
severity, path, line, evidence
```

Acceptance means a person selected the assessment for future reference. It
does not establish that the model's claim is correct. A matching source
excerpt proves where quoted text came from, not the correctness of an inferred
bug. Later changes to run status/results cannot rewrite the accepted copy.
The same finding cannot be accepted twice while active; after archival, a new
explicit acceptance creates a new immutable record. Source paths must be
relative snapshot paths; empty-root, absolute and traversal paths are refused.

## Pinned snapshots

`snapshot` adds a `digest` to the complete active view without stripping any
entry metadata. It returns a detached JSON value. The digest is SHA-256 of
`{workspace_id, revision, entries}` serialized with sorted keys, UTF-8,
`ensure_ascii=False`, compact separators and `allow_nan=False`. The entire
snapshot, including the digest field, must fit its byte budget.

`validate_snapshot(value, workspace_id=None) -> dict` is a pure worker-side
validator. It verifies exact schema, limits, classifications, ordering, optional
workspace identity and digest, returning another detached bounded value. It
opens no database or filesystem. The digest is a content-integrity check, not
an authentication signature or a claim of truth. Missing snapshots in legacy
run manifests must be handled explicitly by the caller; `None` is not a valid
new snapshot.

`snapshot` and `get` reuse an existing transaction without committing it.
Otherwise they open one consistent read transaction for both revision and
entries. The run queue can therefore pin context inside its existing enqueue
transaction. A later record or archive cannot change that run's snapshot.
Worker prompts must present context as reference data below the immutable
auditor policy, never as a new system instruction or permission grant.

## Bounds and errors

| Item | Bound |
| --- | ---: |
| Title | 240 UTF-8 bytes |
| Content / source excerpt | 4,096 UTF-8 bytes |
| Complete serialized entry | 6,144 bytes |
| Complete pinned snapshot, including digest | 16,384 bytes |
| Active entries per workspace | 32 |
| Retained entries per workspace, including archived | 512 |
| Source manifest / report inspected for acceptance | 131,072 bytes each |

Character lengths are checked before normalization and UTF-8 allocation.
Stored text and source-run byte lengths are checked before reading/decoding
their bodies. All prospective entry and aggregate budgets are checked before
writes. Revision/body/event changes are one transaction. A rejected record
leaves no partial entry, revision increment or event. An archived record frees
active snapshot space but does not free the retained-history budget. Export or
retention policy beyond that fixed cap is future work.

Expected failures use `RegistryError(code, message)`: `invalid_context` for
invalid schema/types or unsupported promotion, `context_limit` for byte/count
budgets, `context_conflict` for stale revision or duplicate active acceptance,
`context_mismatch` for a mismatching pin, and `not_found` for missing or foreign
records. Registry-level compatibility failures use `schema_version`.

## Migration and verification

Registry schema version 2 adds context tables, indexes and integrity triggers.
Opening a version-1 database runs the migration inside one write transaction;
individual complete SQL statements avoid `executescript`'s implicit commit.
An injected failure even after setting `user_version` rolls back the entire
upgrade. Existing workspace IDs, bindings, runner identity, jobs, versions,
runs, events and unrelated daemon metadata remain intact. Unknown schema
versions are refused. Restart an old lab daemon before reopening migrated
state: its cached version-1 code cannot operate a version-2 database. Back up
the private state before any future non-lab rollout.

Registry connections never raw-open and close an existing SQLite file. On
POSIX, that close can release this process's SQLite record locks even while
another connection is active. Initial exclusive file creation is serialized
within the process, and its creation descriptor closes before registry
connections can open. Existing files use metadata checks; SQLite owns their
descriptors. The SQLite URI uses `mode=rw` to refuse a file disappearing after
validation, followed by an ownership/type/inode recheck. Python's sqlite3 API
does not expose `SQLITE_OPEN_NOFOLLOW`: these checks and the private owned
directory do not claim to defeat a malicious process running under the same
operating-system account. They also do not substitute for SQLite's own locking.
Connection setup failures close the connection. Transaction/read cleanup
preserves the original error if SQLite has already rolled back or rollback
itself fails.

Focused deterministic tests live in `tests/test_workspace_context.py`. They
cover migration rollback and preservation, unknown versions, stale writers,
consistent reads, outer-transaction preservation, event-failure rollback,
immutable history/provenance, malicious or misclassified promotion, exact
finding indexes, snapshot tampering and bounds before writes. They use local
temporary databases only, no network, models or sleeps. Run using the lab's
isolated `DGC_HOME` and `TMPDIR`; `test_pips_local.py` additionally checks the
existing Pip runtime remains compatible. These tests establish storage and
pinning behavior, not the factual accuracy of model assessments.

`tests/test_workspace_registry_concurrency.py` adds nine deterministic
connection/error regressions. One starts an actual separate local process to
probe SQLite's shared-byte lock before, during and after another registry
connection opens. It catches the descriptor-close defect without depending on
a probabilistic corruption race. Other cases cover exclusive-creation races,
symlinks, post-connect inode changes, setup cleanup and preservation of primary
errors. No test uses sleeps or network calls.
