# Reviewed session continuity after a workspace move

A workspace UUID survives an explicit local rebind. Transcript storage remains the
ordinary private per-directory bucket; no Git remote, committed metadata, or
arbitrary transcript `workspace_id` can grant another directory's history.
This increment adds an explicit per-session migration, not a cross-root exception
in the normal resume loader.

## Local workflow and API

Before moving a directory, associate its ordinary sessions with the private
workspace registry (ordinary Pips-enabled chats do this automatically; historical
sessions use the existing reviewed backfill). Move the directory, then review and
apply `dgc pips workspace rebind` with the previous canonical root. Existing Pips
work must be finished/cancelled before rebind.

From the new directory, preview one exact session:

```sh
dgc pips workspace migrate-session WORKSPACE_ID SESSION_ID --source-root /previous/canonical/root
```

Read the returned source revision, byte/file counts and warnings. Apply that
reviewed generation explicitly:

```sh
dgc pips workspace migrate-session WORKSPACE_ID SESSION_ID --source-root /previous/canonical/root --expected-revision N --apply
dgc --resume SESSION_ID
```

`--continue`, normal session lists and exact-ID resume subsequently use the new
bucket. The session ID and private workspace/binding/runner identity stay the same.
The transcript revision advances once, and later ordinary saves keep using normal
CAS. The command does not move a whole workspace's sessions implicitly.

The Python API is:

```python
sessions.migrate_workspace_session(
    config, session_id, *, workspace_id, source_root,
    expected_revision=None, dry_run=True, registry=None,
) -> dict
```

`expected_revision=None` is allowed only in preview, to discover the existing
revision. Apply requires an explicit nonnegative integer. The feature flag must
be exactly `True`. The current canonical directory must match the existing private
workspace binding, and that registry must already associate the exact session ID
with this workspace/binding/runner. The previous directory must be absent; an
existing replacement directory, file or symlink is refused. A changed binding,
unknown association or mismatched transcript identity/project/revision is refused.
No permission configuration is copied or expanded.

The result contains `dry_run`, `status` (`ready`, `interrupted`, `migrated` or
`already_migrated`), `session_id`, `workspace_id`, `source_root`, `destination_root`,
`source_revision`, `destination_revision`, `session_path`, `archive_path`, `files`,
`bytes`, `warnings` and `resume`. Failures are actionable `RegistryError` values;
common codes include `disabled`, `workspace_mismatch`, `source_exists`, `conflict`,
`busy`, `invalid_record`, `invalid_checkpoint`, `unsafe_file`, `migration_limit`,
`destination_exists`, `migration_conflict`, `migration_io` and `invalid_journal`.

This is a local-console operation. It adds no Remote control or model tool and
never changes a machine's trusted filesystem roots.

## What moves and what is reset

The migrated copy keeps conversation messages, name, goal, checklist, counters,
agent display history, plan, recall and bounded image assets. Known live credentials
are redacted from the new transcript/plan/recall using the existing redaction code.
Exact original bytes remain owner-private archival evidence.

Checkpoint state must round-trip through the existing relative-path/hash validator
without losing state. Only its explicit project identity is rebound. File paths in
checkpoint data stay relative; conversation prose and tool arguments are not
rewritten. Rewind still applies the ordinary path, symlink and concurrent-edit
checks. A test proves a substituted parent symlink cannot turn a migrated recovery
point into a write outside the new workspace.

Vendor subscription-thread references are reset: their opaque state could retain
an old working directory or permission mode. The old `.workspace` sidecar stays in
the archive and is not activated as a managed/manual worktree. Both resets appear
in the preview. Existing agent metadata remains display-only and ordinary resume
settles previously running agents as stopped.

## Persistence and recovery boundaries

Preview does not create buckets, archives, leases or mappings. Apply acquires both
source and destination foreground-turn leases without waiting, then the existing
session-family locks. It rechecks authority while holding the registry transaction
so a concurrent rebind cannot change the selected workspace binding.

Each original family is retained below:

```text
OLD_SESSION_BUCKET/.session-migrations/SESSION_ID/
  journal.json
  original/
  prepared/
  retired
  complete
```

All prepared content is hashed and bounded before retirement. A durable retirement
marker blocks normal old-bucket reads/writes, including legacy saves lacking CAS.
Original files are then renamed into the private archive. Destination sidecars are
published before the new transcript, which is the visibility point. The ordinary
loader never follows the journal to read another directory.

An interrupted retirement or publication can be retried with the same roots,
identity and expected revision. The journal verifies original/prepared/published
bytes; nothing is overwritten or merged. A completed retry returns the existing
migration even after ordinary destination saves advance its revision. Tampered or
incomplete journals/staged files fail closed and retain originals for manual
inspection. Failure before a valid journal is persisted may leave an empty private
preparation directory; this is not guessed away as if it were an approved move.

Filesystem publication and the SQLite activity event are not one atomic
transaction. A filesystem error can leave a recoverable intermediate phase; an
event failure after publication can leave a completed move without its activity
entry. The private journal/markers and validated files determine recovery. No
claim of cross-filesystem/SQLite atomicity is made.

The old marker must stay in place: deleting it can allow obsolete writers to
recreate a second session. Archives are not ordinary session-picker entries.
They can contain old credentials and must remain private.

## Explicit limits and unsupported cases

- Transcript: 8 MiB; plan: 1 MiB; metrics: 64 KiB; recall: the existing roughly
  4 MiB read ceiling; worktree attachment: 64 KiB.
- At most 512 image files, 8 MiB each and 256 MiB combined; at most 517 files and
  280 MiB across the family. Images are copied as opaque retained assets; ordinary
  image loading keeps its existing format/content checks.
- Directory inspection stops at 4,096 entries. Reads check ownership, ordinary
  file type, link count, opened identity, size and modification time, use no-follow
  opens, and never allocate the whole image family in memory.
- Symlinks, shared hard links, special files, unknown/uncommitted sidecars,
  noncanonical checkpoints and any conflicting destination history are refused.
  A fork whose image store still uses hard links needs separate reviewed handling;
  this increment does not silently detach shared storage.
- Distinct roots colliding in the existing truncated directory slug are refused.
  Returning a session to a bucket already retaining its earlier migration is also
  refused; automatic reactivation/merging of retired histories is not implemented.
- This is explicit adoption of an already privately associated session after user
  review. It is not proof that a filesystem directory kept the same inode, nor a
  mechanism for linking arbitrary cloned repositories.

## Validation

Deterministic unittest coverage exercises ordinary Agent resume/save, identity and
revision continuity, full sidecar/checkpoint/image retention, redaction, disabled
mode, forged metadata, replaced old roots, stale rebind/revision, path traversal,
symlinks/hard links/FIFOs/oversize inputs, destination collisions, active leases,
interrupted retirement/publication, tampered journals and outside-workspace rewind
refusal. No network or sleeps are used. The real CLI tests exercise
preview/discover/review/apply and refusal without an apply revision. Tests were run
on this Linux host; macOS/Windows filesystem behavior is not claimed verified.
