# Local run evidence export

`dgc pips export-run RUN_ID --output /absolute/new-file.pips.jsonl` writes a
private, projected historical evidence file. The run must be terminal and belong
to the currently registered local workspace. The command does not enable Pips,
start its supervisor, approve anything, import data, prune history or reclaim the
1,000-run limit. It can read retained history while Pips is disabled.

This is a local terminal command, not a model tool, Remote control or SDK API.
Invocation from an interactive chat command is refused. A restricted session
policy or requested sandbox also refuses the operation. No registry schema or
public protocol version changes are introduced.

## Included evidence and intentional omissions

The JSONL file includes the terminal run identity and times, a closed projection
of its approved job and source receipt, and its non-conversation result or
recorded failure. Audit exports include the immutable checkpoint, current
finding decisions and retained decision history. Execution exports include saved
outcome decisions and the exact reviewed handoff input, where applicable.

Reports retain their existing bounded source excerpts, model assessments, draft
Markdown and diff/test-output previews. This command does not read the original
source tree or any private artifact file, and does not repeat a source check or
test execution. Their source hashes and verification labels describe the original
recorded run, not a new verification during export.

Direct handoff, memory, context and session-statement relationships are exported
as references. At most 25 references of each kind are included. The omissions
record states exact totals where indexed and counts omitted references. Session
statements require inspecting their bounded stored source-reference envelope:
at most 1,000 same-workspace candidates are scanned, with matching, omitted and
unscanned counts reported separately. Referenced external records are not
recursively included, so this is not a complete backup of their provenance graph.

Conversation bodies, embedded chat history, ordinary session transcripts,
repository files, raw artifact bytes, connection settings, root inode data,
private request keys and activity payloads are excluded. The activity section
only describes the workspace's retained event range, whose history may already
be incomplete. Source exceptions, context entries and session statements are
references in this export; their full bodies remain in the local registry.

Configured secret values and existing high-confidence credential patterns are
redacted before encoding. Redaction is not a general personal-data detector.
Each JSONL record explicitly says it is a projection and whether redaction
changed its content. Historical result/source digests are retained as provenance;
they are not presented as matching hashes of the projected or redacted content.

## Format and limits

Format identifier: `dgc.pip-evidence.v1`.

Every line is one UTF-8 JSON object with `type`, `projection`, `redacted` and
`data`. A header describes the run, format, limits and exclusions. Typed evidence
and reference records follow. An omissions record precedes the final footer.

The footer's SHA-256 covers the exact bytes of every preceding line, including
its newline. It excludes the entire footer line. It also includes the hashed
byte count, record count, counts by type and count of redacted records. A file
without a valid completion footer is incomplete. This hash detects byte changes;
it is neither a signature nor permission to trust or execute the content.
`importable` and `restorable` are explicitly false.

Bounds are 4 MiB for the complete file, 2,000 total records including the footer,
256 KiB for an encoded record and a 30-second deadline. Source database cells are
guarded in SQL before allocation, at no more than 128 KiB each; smaller known
field contracts use smaller bounds. Whole-record output-budget overflow fails
the export. Required malformed evidence fails rather than being silently
relabelled as complete. Explicit reference paging is the only intentional
relationship truncation.

The deadline is checked between records, by SQLite's progress handler and before
publication. It is not a hard preemption guarantee for a stalled filesystem call.

## Filesystem and registry behavior

The existing registry is opened through a pinned directory as read-only SQLite,
with `query_only` enabled and one consistent read transaction. The exporter does
not use mutation-capable view helpers, resolve a new workspace, expire approvals,
materialize notifications, migrate a registry or append an event. An incompatible
schema must be opened separately by a compatible DGC first.

The destination must be an absolute, unused filename in an existing directory
owned by the current user and not writable by other users. Symlink path components
and existing destinations, including dangling symlinks, are refused. No directory
is created. An exclusive 0600 partial file is written in the pinned parent,
flushed, and published with an atomic hard link that cannot overwrite a late
collision. The absolute parent path is checked again immediately before
publication to detect a rename/replacement. Failure cleanup removes only a
partial file whose device and inode still match the exporter-owned file.

This implementation is currently Linux-only: it requires POSIX no-follow
directory descriptors and procfs for the pinned SQLite path. It does not claim
protection against a malicious process running as the same user swapping
filesystem names between checks. A rare failure after successful publication
may leave the complete footer-bearing output in place; it is never overwritten
or treated as permission to delete registry evidence.

## Validation

Deterministic tests cover private output mode, hash and count verification,
foreign/unregistered workspace refusal before prose decode, concurrent review
snapshot consistency, no approval-expiry materialization, secret redaction,
conversation and raw artifact exclusion, oversized/malformed cells, hostile
metadata, destination collisions and symlinks, directory replacement, interrupted
cleanup and unchanged registry contents. CLI tests cover disabled-Pips export
and refusal from an interactive chat invocation. Native platform acceptance is
recorded separately from these offline tests.

The exporter and related CLI regression gate passed 62 tests, including 26
export-specific cases. No private production profile was changed by this gate.
