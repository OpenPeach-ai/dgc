# Quill documentation drafts

Quill is now an available character with engine `documentation_draft`. It uses
the same native DGC Agent, approved-source snapshot, fixed read-only tools,
model routing, queue, cancellation and resource limits as source review Pips.
There is no second model loop and no model file-write authority.

A Quill run produces a **private Markdown draft for review**. It does not update
project documentation, publish a page, install anything, or execute commands.
The controller creates an artifact only after validating the returned text and
its source citations. The model cannot choose an artifact path.

## Product and API contract

Manual drafts were introduced in API 9. API 20 adds explicitly reviewed recurring
drafts from committed source. Existing `list_pip_types`, `create_pip`, `run_pip`,
`get_pip_run`, `list_pip_runs`, cancellation, model choice and per-Pip conversation
controls are reused. Schema 20 advances the interpretation version without new
tables or historical row rewrites, so older runtimes refuse unsupported records.

The catalog entry is `id:quill`, `name:Quill`, `role:Documentation drafts`,
`engine:documentation_draft`, `available:true`, `character_index:7`, and
`default_name:Documentation writer`. Its goal is to draft from committed source,
cite inspected excerpts, and distinguish assumptions from established behavior.
The immutable type and trusted role text/digest are pinned with each run.

- Quill manual runs have `manifest.run_kind: draft` and `policy:read_only`.
- Conversations retain `run_kind:conversation`, including while the job is paused.
- Model choice uses the existing configured native connection and reviewed,
  versioned model-selection flow. No new endpoint, credential or fallback fields.
- A human may review an interval, daily, one-shot or numeric cron schedule, or
  one existing event policy, for a committed-source Quill. Schedule and event
  policy cannot be combined. No existing manual job is automatically armed.
- Current-tree Quill remains manual/conversation only. Switching an automated
  Quill to current-tree requires a reviewed change clearing both automation fields.
- Reviewed finding and Patch-artifact handoffs cannot target Quill. Quill has no
  Patch write tools or reviewed command-execution path.
- Drafts are not findings, audit checkpoints or execution outcomes. They cannot
  enter those review/promotion flows merely because the run succeeded.

## Reviewed automation (API 20)

The existing schedule/trigger proposal and separate acceptance flow provides the
authority. Pending, rejected, expired or stale proposals never arm a job. A
calendar occurrence or event is only the reason to run; it does not expand tools,
select arbitrary source or authorize publication. Supported events are
`context_updated`, `finding_accepted`, `commit_changed` and
`session_turn_completed`. A saved foreground turn event conveys no transcript
access or test claim. Every automatic draft pins the approved ref's local commit
at queue time, which may differ from the commit that caused an event and excludes
uncommitted changes. No remote fetch or dirty-tree watcher is added.

Automatic draft manifests alone contain this closed grant, at most 4 KiB UTF-8:

```text
draft_automation: {
  schema_version: 1, pip_id, workspace_id, job_version,
  definition_digest, job_digest,
  trigger: "schedule" | "event",
  policy: canonical saved schedule | canonical saved event policy,
  occurrence,
  digest
}
```

Calendar occurrence fields are exactly `job_version`, `expected_next_due`,
`scheduled_at`, `next_due_at`, `checked_at`, and `anchor_at`; timestamps are
canonical UTC milliseconds and only `next_due_at` may be null. Event occurrence
fields are exactly `job_version`, `expected_after_seq`, `checked_at`, `event`,
and `history_may_be_incomplete`, equal to the corresponding saved event pin.
The policy retains its existing interval/calendar or event bounds.

`definition_digest` hashes the original immutable version's UTF-8 definition;
`job_digest` hashes the canonical compact job. `digest` hashes canonical grant
JSON excluding itself. These are historical hashes, not signatures. Before
dispatch, the parent compares both identity and policy with the actual original
version, using a 24 KiB predecode bound. The worker independently checks the exact
role, source, tool, policy and occurrence envelope before constructing Agent.
Calendar validation verifies that the first occurrence is on the approved
calendar, including interval alignment and DST first-fold rules, then recomputes
coalescing and the next cursor. Successful result admission and historical draft
projection also check the grant against the immutable version; historical reads
do not require the source directory or current job version to remain unchanged.

Queue insertion and schedule/event cursor advance are one transaction. Git work
stays outside that write transaction. Exact retries compare all original
occurrence fields at both queue lookup boundaries and return the original run,
including terminal runs. Paused/busy work, stop/resume, archival and retention
reuse the existing scheduler/event semantics. Missed work coalesces; no new
unbounded backlog is created. Manual legacy manifests and results retain their
previous bytes and have no grant. Drafts receive existing Workspace Context;
they gain no audit checkpoint, exception/statement-memory pin, handoff,
specialist or command-execution authority.

Example (the last command is the separate human approval):

```console
dgc pips schedule PIP_ID --expected-version 1 --every 60
dgc pips show PIP_ID
dgc pips accept PIP_ID PROPOSAL_ID --expected-version 1
```

The same supervisor must be running to service occurrences. A successful run
creates only the private Markdown artifact described below; no project file or
external application is changed.

The model returns exactly this JSON shape, without a wrapper or extra keys:

```json
{
  "title": "Documentation title",
  "summary": "What this draft covers and leaves uncertain.",
  "markdown": "# Draft\n\nReviewable documentation text.\n",
  "citations": [{"path": "relative/source.py", "line": 1, "excerpt": "Exact source text"}]
}
```

The completed run's result is:

```text
{
  title, summary,
  verification: "Draft text; cited excerpts checked against pinned source. Prose remains model-authored and is not verified documentation.",
  tests_executed: false,
  draft: {
    markdown,
    citations: [{path, line, excerpt, verification: "source_excerpt_only"}],
    artifact: {path: "artifacts/documentation.md", sha256, bytes}
  },
  usage, tools_called, snapshot: {sha256, files, bytes}
}
```

The artifact path is relative to the private run directory. It is a receipt,
**not a browser URL or download endpoint**. Clients can copy/download the
Markdown already carried through the authenticated encrypted result. Render it
as untrusted escaped text or through the existing safe Markdown renderer; never
execute embedded HTML or fetch arbitrary embedded resources. A model's request
inside this text grants no permissions.

CLI example:

```console
dgc pips create "Project documentation" --type quill --goal "Draft an overview of the repository's request handling, citing inspected source."
dgc pips run PIP_ID --idempotency-key reviewed-draft-1
dgc pips report RUN_ID
```

The existing foreground/service supervisor must be running for a CLI queue
request. Reusing the same request key retries the same run; it does not generate
a second draft. The report formatter distinguishes a draft from an audit and
prints its historical commit, source citations, private relative artifact path,
SHA256 and byte count. It does not apply anything.

## Validation and storage

`dgc.pip_drafts.parse_reply(text, snapshot, *, read_calls)` validates a model
response without writing files. A successful text-file read is required. The
controller calls `publish(result, snapshot, run_dir, *, secrets=())`, rechecks
redacted citations against the corresponding redacted source excerpts, and then
creates the fixed private artifact. `validate_saved(result, run_dir)` verifies
its owner-only regular file and exact Markdown bytes before a successful run is
persisted. Errors are bounded `RegistryError` messages and do not include raw
model responses or mismatching source text.

Malformed final JSON is reported as `invalid_draft` with a fixed error category,
JSON line/column when available, and the bounded response's UTF-8 byte count.
Duplicate fields, non-finite values, excessive nesting and other unsupported
values have distinct fixed refusals. Source-read and input-size checks still
precede decoding. Diagnostics retain no reply excerpt, raw decoder message,
response hash or inferred provider finish reason. They do not repair JSON,
retry the model, accept a partial draft or change cancellation precedence.

Limits are explicit:

| Input | Limit |
| --- | --- |
| Model JSON response | 60 KiB UTF-8, checked before JSON decoding |
| Title | 160 UTF-8 bytes, single line |
| Summary | 2,000 UTF-8 bytes |
| Markdown | 24 KiB UTF-8 |
| Citations | 1–16 |
| Citation path | 1,024 UTF-8 bytes, canonical relative path |
| Citation excerpt | 1,000 UTF-8 bytes, at most eight lines |
| Citation line | Integer 1–100,000 |
| Source file | 4 MiB |
| Individual source line read | 64 KiB |
| Complete persisted result | 60 KiB |

Duplicate JSON keys, extra schema fields, non-finite values, invalid Unicode,
control characters, unbounded nesting, missing source reads, forged citation
markers, mismatched excerpts and unsupported paths fail closed. Source path
components are opened without following links; files must be regular, singly
linked and within the input budget before reading. Source scanning uses bounded
line reads and checks file identity/size/mtime afterward. It never splits an
entire multi-million-line file into an unbounded list. The quoted source may be
malicious; validation establishes an excerpt match, not the truth of the prose.

The full result, including its future artifact receipt, is validated before any
artifact write. The run directory is owner-only; artifacts use a fresh private
directory, an exclusive fixed filename, mode 0600 and fsync. Existing directories
or artifacts, links, unexpected permissions and changed bytes are refused.
Nothing is overwritten or merged into the project. A disk failure or cancellation
may leave a private unaccepted artifact; a cancelled/failed run never exposes it
as a completed draft. Archive cleanup remains a separate explicit feature.

Configured secrets are redacted before parent publication. The artifact digest
covers those persisted UTF-8 Markdown bytes. Redaction can reduce the literal
content available to the reader; it does not create independent verification of
that content. The source commit and job version remain visible as historical
provenance, not proof that the current working tree matches.

## Reading drafts in conversations

The main chat's read-only `pips_context` tool adds `action:"draft"`, with `run_id`
and optional `offset` (page index). It accepts no `limit` argument for this
specific action. Each page contains up to 4 KiB of Markdown, split only at Unicode
character boundaries, and one complete citation. `markdown_total_pages`,
`total_citations`, and `next_offset` make omissions explicit. Concatenating the
Markdown pages restores the exact stored text. All pages are authorized to the
current workspace and bounded by the existing 24 KiB tool-output budget.

The draft projection bounds stored manifest/result bytes before decoding, checks
run/manifest ownership and kind, and verifies the recorded artifact digest
against the archived Markdown. It reads stored result bytes rather than following
an arbitrary stored filesystem path. Existing runtime-policy/sandbox exclusions
for independent Pips data also apply to this read action.

Quill's own next conversation gets a bounded historical draft preview, at most
one complete citation, explicit truncated/omitted counts, and classification
`model_authored_draft`. That reference stays within the existing 8 KiB previous
result budget. It does not inject a new instruction or file-write ability.

This increment also fixes an existing Patch/Pulse continuity bug: the previous
result loader selected any successful non-chat run, then required an audit
schema. After a successful execution, a conversation could therefore fail with
`invalid_history`. It now carries a separately classified `historical_execution`
reference: recorded statuses/exit codes, exact small argv or an explicit omission
plus digest, private change receipt, and bounded model interpretation. This does
not convert test evidence into source findings or imply changes were applied.

## Validation evidence and limits

Deterministic tests cover hostile JSON/Unicode/size limits, source path traversal,
symlinks/FIFOs, overlong source lines, mismatching excerpts, private artifact
ownership/digests, no-overwrite publication, cancellation, stored-record identity,
main-chat paging, post-draft/post-execution conversations, current-tree automation
and handoff refusal,
and native Agent policy denial even with broad foreground allow rules. Provider
calls are mocked; no test sleeps or network are used.

API 20 deterministic coverage adds all four calendar forms and event categories,
exact immutable definition/occurrence binding, malformed grants before Agent,
recomputed-digest policy forgery, both duplicate-key boundaries (including a
second SQLite connection), rollback, restart, busy/cancelled retries, real local
Git commit observation, lifecycle suppression and private draft publication.
The real native Agent is exercised with a mocked provider; this alone does not
claim configured-model recurring acceptance or platform-wide service acceptance.

Actual local console subprocesses list Quill, create it, queue a manual draft and
read its status. The native Agent test executes real read tools with scripted
provider responses. The controller test uses a bounded worker fixture, validates
citations, saves the artifact and persists completion. These establish distinct
layers; they are not a claim that an actual model produced useful documentation.
Any real configured-model acceptance evidence is recorded separately by the
root review agent.
