# Durable Pip conversation continuity — local API 26, schema 24

This isolated lab adds rolling summaries between Pip replies. The normal
within-reply Agent compaction remains. Original conversation messages stay in
the per-Pip archive; no main checkout, installed extension or global config is
modified by this build.

## Queue, summarize, commit

At enqueue, pin the latest checkpoint digest and successful archive head inside
the normal send transaction. Include the brief and as many complete recent
user/assistant pairs as fit the selected approximate history budget (half the
context at four bytes per token, at most 64 KiB serialized). Failed and incomplete
exchanges are excluded. Body byte sizes and pair ownership/order are checked
before loading text. Corrupt archive coverage fails closed.

After a successful reply, generate a new summary when the brief plus pairs exceed
48 KiB (or the smaller selected half-window), or when the native Agent compacted
within that reply. Its source includes the prior brief, every pinned recent pair,
the current exchange and the within-reply brief. The existing auxiliary provider
and usage ledger are reused, with no tools, reasoning off, at most 2,048 requested
output tokens, and a 30-second maximum bounded further by the remaining worker
deadline. Native provider cap rejection falls back locally; it never sends an
uncapped summary request. No model or network request runs under a database writer lock.

The brief is at most 8 KiB; a checkpoint record is at most 16 KiB. The fixed
128 KiB worker envelope, 64 KiB output line, source, turn and time limits remain.
If the prompt will not fit, the provider fails, the response is malformed, or
there is no time, an explicitly labelled mechanical fallback preserves bounded
excerpts. Legacy history and context reductions also use incremental mechanical
backfill rather than silently dropping all earlier exchanges. This fallback and
model summarization are lossy. Neither guarantees that every detail is retained.

Only the controller can commit a checkpoint, atomically with the assistant
message and successful run. It derives the exact message coverage from the archive;
the worker supplies prose and strategy, never identity, coverage or authority.
A stale parent, changed archive or invalid candidate rolls the transaction back.
Failed/cancelled runs and duplicate completion cannot replace the saved checkpoint.
A pre-upgrade queued worker keeps its old result contract; subsequent enqueue
backfills any missing continuity. Checkpoints are immutable and retained locally.

## Provenance and inspection

Each checkpoint records its Pip/workspace/run, parent digest, covered message
sequence/count/hash, job version, source identity, model and selected options,
and workspace-context revision/digest. Changing model does not erase a historical
brief, nor does its old model/source become current authority. Subsequent workers
receive freshly pinned job/permission/source data plus a clearly labelled,
untrusted reference summary. Configured secrets are redacted before model summary
requests and before reusing a brief; this is not a promise to discover unknown secrets.

`list_pip_messages` adds optional `continuity` with the summary, coverage, strategy,
notice and provenance. In the extension: context control → **Conversation continuity**.
The CLI `dgc pips messages PIP_ID` shows a nonempty brief and its strategy; `--json`
exposes the full projection. No checkpoint or another Pip's checkpoint is fabricated
by the client. The UI distinguishes mechanical fallback from model summary and
escapes the displayed text.

This is conversation continuity, separate from audit checkpoints and reviewed
Pip-local exceptions. It cannot change a job, approve a proposal, claim a test ran,
or grant shell/network/write access. The archive is still bounded at 20,000 messages;
this change does not implement indefinite retention management or autonomous Pip chat.

## Approval cards and handoffs

Pending main-chat setup cards expose **Approve**, **Reject**, and **Review** while
collapsed. Review expands details; the same actions remain visible when expanded.
Approval queues the verified receipt automatically into the owning main chat,
without stopping its running turn or borrowing its composer/draft/attachments.
There is no continuation checkbox. A failed notification has an explicit retry;
restored historical cards do not auto-notify again. Approval never claims the job ran.

Reviewed same-workspace finding handoffs, Patch work and Patch-to-Pulse artifact
handoffs already exist. They preserve source/target/version checks and require
human review. They do not give Pip workers an unrestricted messaging bus, access
to another Pip's private transcript, or autonomous delegation permission. See
PIPS_HANDOFF_TOOL.md, PIPS_EXECUTION.md and PIPS_SPECIALISTS.md.

## Verification scope

Offline tests cover restart into the real Agent, complete summary input (including
middle constraints), model changes, failed/cancelled/duplicate completion, stale
parents, corrupt archive hashes, transactional rollback, retries/concurrent sends,
byte limits before body fetch, legacy backfill, native output-cap refusal, redaction,
within-reply brief reuse and deadline/provider fallback. Client tests cover scope,
escaped summary rendering, direct collapsed-card actions, automatic approval
notification during streaming, and draft preservation. Actual Electron screenshots
use the production extension with a separate offline QA registry and clearly
fabricated saved conversations. They establish UI rendering, not live model quality.
