# Configured-verifier execution receipt foundation

This local foundation records controller observations for an existing configured
foreground verifier. It does not add a model tool, launch another command, grant
permissions, publish context, or turn session prose into evidence. Public control,
CLI, SDK and review/promotion surfaces are a later increment.

The only eligible entry point is the owning main Agent's configured verifier.
Pips must be enabled exactly `true`; restricted/sandboxed sessions, child/Pip
workers and monitor turns do not receive the recorder. Ordinary model-issued
Bash, background jobs, monitors, MCP calls and Python kernels are excluded.

## Records and interpretation

Schema 16 adds two tables: immutable `session_execution_attempts` and immutable
`session_execution_finals`. An attempt is saved before launch; a final refers to
the exact attempt digest and is inserted once. Repeating the same final is a
read-only acknowledgement. Different facts cannot replace it. An attempt without
a final is **unfinalized**, including after a crash; it proves neither launch nor
success and is never replayed automatically. This foundation does not infer dead
processes from a stale PID.

Attempt fields identify the owning session, workspace, binding/revision, runner,
controller turn and root device/inode. The exact configured command is bounded
to 8 KiB UTF-8; its SHA-256 covers those original UTF-8 command bytes. A command
containing a configured credential cannot be recorded. Recording is unavailable
for that command while its existing authorization/execution behavior remains.
Configured-secret checks are not proof that arbitrary text contains no secrets.

Native terminal facts include actual exit code, process state, start/end times,
monotonic duration and a bounded output receipt. States are `exited`,
`failed_to_start`, `timed_out`, `cancelled` and `interrupted`. Exit zero records
the shell's status; it does not assert that tests ran, every test passed, or the
project is correct. Output strings such as “tests passed” or “exit code: 0” cannot
set native status. No parsing of transcript strings or heuristic notes occurs.

The output hash/count covers **decoded, redacted UTF-8 output**, before display
truncation, not the process's raw bytes. A valid UTF-8 prefix of at most 4 KiB is
retained with exact omitted-byte count. The redacted stream is hashed
incrementally, with its representation pinned as `decoded_redacted_utf8`. If
drainage or recording is incomplete, `output_complete` is false: counts describe
only observed output, and omissions describe only its retained-preview ceiling.
Unknown missing output is not assigned an invented byte count. A known process
exit still remains recorded even when its output is incomplete. Environment
variables, provider credentials, raw source contents
and transcript bodies are not copied into the receipt.

## Source observations and permissions

`source_before` and `source_after` are explicitly `checked_non_atomic` observations
of eligible current-tree bytes, never Git revisions or assertions that the command
continuously used those bytes. Matching before/after hashes cannot exclude edits
and reversions during execution, external files, network inputs, environment
changes or test side effects. This distinction remains true after human review.

Observation uses the reviewed current-tree scanner's limits and exclusions:
64 MiB total, 4 MiB per file, 10,000 inspected entries, bounded depth/path metadata,
no symlinks/hardlinks/special files, no cross-mount traversal, and repeated identity
checks. Files are streamed into a hash without making a source copy. There is no
hard I/O deadline on a stalled filesystem. Linux is the verified environment;
unsupported descriptor-relative access yields an unavailable observation.

Any effective Read/Glob/repo-map or wildcard ask/deny rule conservatively makes
the whole observation unavailable before inventory access. Per-file Read authority
is rechecked before streaming. The recorder never prompts or widens grants.
Excluded paths contribute counts only, never their names. Unsafe, changing, empty,
oversized or credential-bearing eligible source also yields an explicit unavailable
reason. An unavailable observation does not stop the already-authorized command.

Source I/O happens outside SQLite write transactions. Scope/binding checks precede
observation and are repeated when records are inserted. A rebind during execution
makes the final source comparison unavailable while retaining the actual process
facts. Database or finalization failure reports receipt unavailability separately;
it does not claim that the command failed to run, or manufacture a success record.

Each JSON body is limited to 16 KiB by application and SQLite byte guards. The
archive stops accepting new attempts at 10,000; this increment has no deletion,
retention or export workflow. These private records are controller provenance,
not signatures or tamper-proof evidence against another process of the same user.

For stronger execution/source binding, use the existing explicitly reviewed Pulse
path on an isolated source copy. Ordinary live-workspace observations are weaker.

## Validation in the isolated lab

The combined receipt, real-process integration, existing configured-verifier and
workspace execution-context gate passed **46 tests**. Cases include actual
nonzero exit despite forged success stdout, failed launch, cancellation, timeout,
redaction before hashing, recorder failure without command-result changes, source
and permission refusal, root replacement, immutable exact retries across two
connections, migration rollback and cancellation during observation before launch.
The broader compatibility harness is separately tracked; these tests do not
certify every DGC path or platform.

The native Linux check used the configured `qwen3.8:27b-q4km` through the existing
Agent, with an in-memory configuration clone and an exact print-only preflight
command. The controller then ran its configured print-only Python verifier.
Session `20261002-022244-22ad8d4f` produced receipt
`exec_2cc1b8a3728d401c93ed340ae21b949d`: actual exit 0, 50 ms, 37 bytes of complete
decoded/redacted UTF-8 output. Both eligible-source observations matched
`49b39b2ffbe63792e1bc8e625f6c29fa28e4e228c5e901cc83bd5886b89fdcb2`
(two files, 314 bytes, one excluded entry). The configuration file and all 25
existing Pip runs were unchanged. Canonical attempt/final hashes and the exact
session/attempt link were independently recomputed using read-only SQL.

Evidence: [native receipt metadata](../../output/pips-verifier-receipt-native-evidence.json),
created owner-only, and [explicit QA script](../../scripts/check-native-verifier-receipt.py).
No receipt was promoted into shared context, no Pip run was queued, and no source
edit was requested or authorized. A successful print-only verifier verifies the
recording path; it makes no claim about source correctness or passing project tests.
