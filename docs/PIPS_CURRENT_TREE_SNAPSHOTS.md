# Explicit current-tree snapshots

The isolated lab now has controller and native-worker integration for explicitly reviewed current-tree source. Existing and newly created Pips remain committed-source only by default. No existing job, live configuration, public repository or installed extension was changed to enable this mode.

## Source contract

A job's source policy is immutable reviewed data:

- `{"mode":"committed_only"}` remains the default for old and new jobs.
- `{"mode":"current_tree","exclusions":"safe_source_v1"}` requires a human-reviewed job proposal.

The scope is manual Scout/Lens/Rook/Lock audits, Quill documentation drafts and those Pips' conversations. Patch, Pulse, reviewed handoffs, time schedules and all event triggers remain committed-Git only. Automatic metadata adaptation cannot change this policy. An authorized automatic display-name update preserves it; automatic `source_ref` edits are refused while that Git ref is dormant under current-tree source.

Capture happens before a run is queued, outside a database write transaction. A delayed worker consumes the captured copy. Its manifest uses `source_revision: null` and a separate `source_snapshot` receipt. A snapshot SHA256 is a content identity, not a Git commit. The parent and worker both verify the captured receipt before model execution, and recheck the copy before accepting a result. Result `snapshot` keeps the existing exact `{sha256,files,bytes}` shape and must equal the corresponding receipt fields.

The controller rechecks job version, workspace binding, capture-time root filesystem identity, runner stop state and queue/archive limits before inserting the run. An exact saved retry returns the existing run without another copy. A concurrent loser or failed transaction removes only its own provisional copy. A replaced source directory is left as a private orphan instead of deleting another directory; no failed provisional copy is attached to a run. Captures are not allowed inside an existing database transaction. Captured file bytes are not read under the queue lock; the final root-identity check performs bounded descriptor/stat operations there.

The root identity proves continuity from the start of this capture through queue/claim. It does not retrospectively prove that a pathname still denotes the directory that was originally registered months earlier. A queued current-tree run refuses a different directory at claim, even though it still has a private captured copy. The workspace registry's explicit rebind contract remains separate.

Use the existing proposal/review path:

```text
dgc pips propose PIP_ID --expected-version N --source-policy current_tree --reason "Inspect eligible uncommitted source"
dgc pips accept PIP_ID PROPOSAL_ID --expected-version N
```

The CLI's current-tree proposal also explicitly removes the schedule and event trigger in the saved definition. Review shows these fields before acceptance. Selecting committed-only later restores no prior automation. The source choice has no create shortcut and no model-callable mutation path. `run_pip_now` remains a separately permissioned manual request with its existing private session/workspace pin and independent supervisor requirement; it acquires no new permissions from this source choice.

## Central validators and source projections

`dgc.pip_sources` performs no filesystem, database, network or Git I/O:

```python
validate_policy(value=omitted) -> dict
validate_job(policy, *, pip_type, schedule=None, event_trigger=None) -> dict
pin(policy, *, source_revision, source_snapshot=None) -> dict
validate_pin(value) -> dict
from_record(record) -> dict
validate_manifest(manifest) -> dict
projection(record) -> dict
```

Missing legacy policy and the legacy string `committed_only` read as the committed default. Explicit null, unknown modes, extra fields and a bare `current_tree` string are refused. New policies are canonical objects. New source pins contain exactly `source_policy`, `source_revision` and `source_snapshot`. A committed pin has a real commit-shaped revision and null snapshot; a tree pin has null revision and an exact bounded receipt. Parsing an identifier proves neither Git object existence nor filesystem provenance; the controller still resolves Git and verifies private captures.

`projection` adds a source label, `identity_kind` (`git_commit` or `snapshot_sha256`) and the corresponding identity. It never returns a filesystem path. CLI reports, historical Quill drafts, conversation references and main-chat Pip context expose source-kind metadata. A current-tree finding accepted into shared workspace context retains the existing model-assessment classification and gains versioned source provenance (`schema_version:2`, the canonical policy and receipt, null commit revision). Existing committed provenance and stored context digests are preserved.

## Checkpoint and comparison compatibility

Historical checkpoint rows are immutable and are not rewritten. Pure committed-source Pips keep the original checkpoint payload/envelope v1 and its original new/repeated occurrence semantics. Existing queued v1 digests are validated against their original representation.

Current-tree checkpoints, or transitions involving a previous v2 checkpoint, use explicit source-aware payload/envelope v2. A completed audit still records all checked findings and their local review rows. No checkpoint is silently omitted to accommodate a snapshot hash. Compatible source domains compare exact finding occurrences: committed to committed, or current-tree to current-tree with the same exclusion policy. This remains an observation comparison, never proof of a fix.

When no baseline exists or the source policy changes, v2 comparison is explicitly unavailable. It retains the previous checkpoint identity when there is one, uses `uncompared` for finding occurrences and null new/repeated/not-observed counts. It cannot turn a policy switch or excluded file into apparent improvement. Checkpoint history and saved source receipts remain available.

Git path-change metadata is separate from finding comparison. `pip_source_changes.snapshot_for_source` and `validate_for_source` preserve the original v1 comparison whenever both operands are committed source. Any current-tree operand yields a closed v2 unavailable receipt, reason `current_tree_source`, with the exact current and baseline source pins, no changed paths and null counts. No Git command receives a null revision or a snapshot digest, and unavailable never means no changes.

## Helper API

`dgc.pip_tree_snapshot` contains no model loop, subprocess, network call or dependency:

```python
validate_policy(value: dict) -> dict
validate_receipt(value: dict) -> dict
capture(root, destination, *, secrets=(), expected_root=None) -> dict
verify(destination, receipt) -> None
```

`root` and `destination` are absolute paths. Destination must not exist, must be outside the source workspace, and must have an existing owner-only private parent. `expected_root`, when supplied by the controller, has exactly `device` and `inode` integer fields. It detects a different directory occupying the expected root.

Successful receipt:

```json
{
  "schema_version": 1,
  "kind": "current_tree",
  "sha256": "64 lowercase hexadecimal characters",
  "files": 2,
  "bytes": 123,
  "exclusions": "safe_source_v1",
  "excluded_entries": 3,
  "excluded_directories": 1,
  "consistency": "checked_non_atomic"
}
```

The counts above illustrate the schema, not measured performance. Exclusion counts describe encountered excluded entries and directories; descendants of excluded directories are never enumerated, so these are not counts of all omitted files. The receipt never includes absolute source paths or secret-bearing filenames. The named policy defines the fixed generic exclusion set.

`RegistryError` codes distinguish invalid policy/receipt, unsupported platform, unsafe or changed source, snapshot limits, empty eligible copy, configured secret detected, unavailable storage and changed snapshot contents. Messages do not reflect raw source filenames, credentials or operating-system errors.

## Bounds and filesystem handling

Before creating a destination or opening a source file for content, the complete selected inventory is checked against:

- 64 MiB aggregate file bytes; 4 MiB per regular file.
- 10,000 inspected entries, including excluded directory entries themselves.
- 32 nested directory levels, 1 KiB UTF-8 relative path bytes, 4 MiB combined inventory path bytes.
- Fixed 64 KiB streaming reads; no whole-file allocation.
- At most 64 configured secrets, 8 KiB per secret and 32 KiB combined, with matching across read boundaries.

Sparse file sizes count in full before copying. Empty regular files are valid; a tree with no eligible regular files is refused with an actionable message.

Every traversed path uses held directory descriptors and no-follow opens. Unexcluded symlinks, hard-linked files, FIFOs, sockets, devices, cross-device mounts, repeated directory identities, traversal spelling, invalid UTF-8 and unsupported control/punctuation filenames are refused. Excluded entries are never opened or traversed. Existing project ignore files are not executed or trusted as policy. A mount that stays on the same filesystem device is still constrained by recorded file identities, no-follow traversal and reinventory; this helper is not a mount namespace.

All source files have identity, size and modification/change timestamps checked before open, immediately after open, after reading and in the final complete inventory. The absolute root ancestor chain is reopened too, so a renamed/replaced ancestor cannot hide behind an old live descriptor. All captured file paths, bytes, lengths and included empty directories enter the digest. Directory and file records use distinct type tags and fixed-width path/content length prefixes, so crafted filenames or file bytes cannot produce an ambiguous record stream.

The exclusively created copy uses files `0400` and directories `0500`. `verify` checks ownership, modes, links, the full inventory and digest without applying exclusions again. An added `.env` inside a private copy therefore fails verification rather than disappearing from the check. The caller must verify again before the worker uses the copy.

Failures clean up only the newly created descriptor tree, with bounded traversal and no symlink following. A concurrently changed or inaccessible partial directory may remain private; it has no valid returned receipt and must never become a queued source. The helper never modifies or restores the original workspace. It never overwrites an existing destination.

## Exclusions and honest limits

`safe_source_v1` excludes VCS and DGC state, common cloud/SSH credential directories, `.env*`, common credential configuration files, private-key/certificate container suffixes, dependency directories, virtual environments, caches, and common build/coverage outputs. The complete fixed set is in the helper. A source file whose contents match a configured secret causes refusal of the entire capture; it is not silently rewritten into different source.

Exclusions and configured-secret matching are precautionary filters, not proof that all credentials have been found. Unknown secrets can exist in ordinary source files. Binary source files are copied within the same byte limits; copying does not execute or deserialize them. This source choice needs explicit review precisely because it can include uncommitted and untracked material.

Filesystem checks detect ordinary concurrent changes, but do **not** produce an atomic filesystem snapshot. A malicious process with the same user identity can modify files, permissions or mounts; this is not a protection boundary against that user. Read-only modes plus re-verification provide tamper detection between capture and use, not kernel immutability. Blocking filesystem calls also do not acquire a hard wall-clock bound from these byte limits. The controller should not hold database locks during capture.

The implementation requires POSIX descriptor-relative no-follow APIs and refuses platforms without them. Tests use real local Linux filesystem behavior; no macOS or Windows execution has been claimed. Source capture happens before the five-minute worker execution budget begins; the byte/entry budgets do not promise an enqueue wall-clock bound on a slow filesystem. The existing 1,000-run archive cap also bounds the number of retained copies, not their total disk footprint; a storage quota/retention management UI is not implemented.

## Verification

Deterministic tests use real regular files, symlinks, hardlinks, FIFOs, sparse oversized files and exact-budget fixtures. Explicit hooks inject same-size changes, growth, truncation, file-open symlink swaps, directory replacement, root and ancestor replacement, disk-write failure, tampered copies, unexpected excluded-name files, empty directory additions and configured secrets split across chunk boundaries. No sleeps, network, model providers, Git commands or subprocesses are required.

Controller tests additionally cover proposal-only activation, ordinary metadata updates preserving source policy, rejected automatic modes, actual non-Git captures, queue-time data surviving later workspace edits, two-connection exact retry, stale version/rebind/root replacement, transaction rollback, replaced-directory cleanup and result-receipt mismatch. Real worker subprocess fixtures exercise the existing Agent and read-file tools for audits, Quill drafts and a paused Pip's conversation; only the provider adapter is replaced, with network calls forbidden. These are Linux integration checks with a mocked model, not evidence of real-model acceptance or macOS/Windows execution. Root's separate native/UI acceptance record must state its own scope.

The combined Pip and workspace-context gate passed 751 tests. The first native non-Git attempt then exposed an ordinary project-root detector issue: redirecting `DGC_HOME` caused the account's original `~/.dgc` to count as a project marker, widening an unmarked child folder to the account home. Capture correctly refused because its private storage was then inside that incorrectly selected root; no source was copied or queued. `Config.find_project_root` now excludes both the redirected global state directory and the account's original global `.dgc`, including aliases, while preserving genuine project markers and explicit root pins. Five deterministic regressions include a real CLI subprocess with this nested directory layout; the root-isolation/config/source gate passed 37 tests. Existing registry bindings are not silently changed by this correction.
