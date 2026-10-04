# Local Pips controls in the SDK

This lab adds `session.pips` to the Python, async Python and TypeScript SDKs. It accesses the existing local Pips registry through `dgc serve`. It does not enable Pips, start or resume the supervisor, install a service, or change a model connection. Work requests still require an already-running local supervisor and the normal backend review and permission checks.

## Choose a controller explicitly

The supported controller uses an existing profile: `inherit_user_state=True` in Python or `inheritUserState: true` in TypeScript, with no `RuntimePolicy` and sandbox `off`. Pips must already be enabled locally. Default isolated SDK sessions are deliberately unsupported: they carry a session trust policy which cannot govern an independent background runner.

A foreground policy or sandbox is never silently removed or weakened. Any requested or active sandbox, or any `RuntimePolicy`, refuses both read and mutation access. The backend also refuses raw Pips controls while a session policy or configured sandbox is active. This includes a malformed policy. A plan-mode SDK controller may read, but cannot mutate.

An inherited controller has access to the chosen local profile's workspaces, not just its foreground working directory. Give this controller to trusted host application code. Do not expose `mutate` to a model as an unattended tool, and do not use inheritance merely to bypass an application's required policy. A future restricted Pips API needs an explicit policy that the independent runner itself enforces.

```python
from dgc_sdk import DGC

with DGC(inherit_user_state=True, sandbox="off") as dgc:
    with dgc.session(cwd="/path/to/project") as session:
        workspaces = session.pips.read("list_workspaces")
        jobs = session.pips.list(workspaces["current_workspace_id"])
        # After the host application obtains a decision for this exact action:
        session.pips.mutate("pause_pip", {"pip_id": "pip_..."}, approved=True)
```

```typescript
import { DGC } from "@vibedgc/sdk";

const dgc = new DGC({ inheritUserState: true, sandbox: "off" });
try {
  const session = await dgc.session({ cwd: "/path/to/project" });
  const workspaces = await session.pips.read("list_workspaces", {});
  const jobs = await session.pips.list(String(workspaces.current_workspace_id));
  // After the host application obtains a decision for this exact action:
  await session.pips.mutate("pause_pip", { pip_id: "pip_..." }, { approved: true });
  await session.close();
} finally {
  await dgc.close();
}
```

`AsyncDGC` exposes the same `session.pips` methods; await `read`, `mutate`, `list`, `get`, `runs` and `get_run`. Waits use the same worker-thread mechanism as the other async session controls.

## Public API

Python exports `Pips`, `AsyncPips`, `PipReadCommand` and `PipMutationCommand`. `read(command, params=None)` and `mutate(command, params, *, approved=False)` return the backend's result object. The read conveniences are `list(workspace_id)`, `get(pip_id)`, `runs(pip_id)` and `get_run(run_id)`.

TypeScript exports `Pips`, the two command-name types, `PipReadParams`, `PipMutationParams`, `PipResult` and `PipJson`. `read(command, params)` has a command-specific parameter type. `mutate(command, params, options={approved:false})` requires `options.approved === true`. Its conveniences are `list`, `get`, `runs` and `getRun`. Results retain their wire field names. The SDK checks the response envelope and returns JSON; it does not claim that a model report establishes correctness or that an accepted report means every test passed.

Read controls cover workspace/job/type/model lists, chats, runs, activity, version/proposal/checkpoint/handoff history, runner/execution capability and workspace context. A model-list read may contact the already configured model endpoint; execution-capability inspection may probe local confinement support. Read access means no requested job mutation, not that every read performs no I/O.

Mutations use a closed allowlist: create/update/review jobs, pause/resume/stop, request/cancel runs, send a Pip chat message, record/archive reviewed context, review findings and execution outcomes, and propose/accept/reject finding or artifact handoffs. There is no generic passthrough for future controls. `pips_enable` and `pips_runtime` are not exposed. An exact boolean `approved=True` / `approved:true` authorizes one host request only; missing, false, numeric or string values refuse before transport. It never changes the job's own reviewed permissions.

Every operation requires handshake capabilities `pips_supported: true`, `pips_enabled: true`, and an integer `pips_api_version >= 8`. `accept_pip_execution_context` additionally requires API 9 and both `expected_revision` and `expected_review_revision`. Open a fresh controller after changing the local enable flag; the initial handshake is not a live status subscription.

Parameters are plain JSON with a closed top-level field set, at most 32 KiB, 2,048 visited values and 12 nested levels. Unknown fields, caller request IDs, endpoint/credential overrides, cycles, invalid Unicode, non-finite numbers and integers outside JSON's safe range are refused before transport. Backend-specific validation remains authoritative. SDK clients intentionally cannot represent SQLite cursors above JavaScript's safe-integer range, although Python itself has wider integers.

## Correlation and failures

The wire shape is exactly `{type: "pips_control", request: {type, request_id, ...params}}`. Correlation is passed separately to the transport. No outer `request_id` is added to this strict command. Concurrent requests for the same operation can complete in any order without sharing a reply. Existing non-Pips request correlation is unchanged.

A negative `pips_result` raises `DGCCommandRejectedError`, with `reason` set to the backend code and `command` to the requested control. Bad parameters raise `DGCConfigError`; unsupported capabilities/policies raise `DGCUnsupportedError`; mismatched/malformed envelopes raise `DGCProtocolError`. Existing transport timeout and failure types remain unchanged.

A timeout or cancelled async waiter is not proof that a mutation did not commit. There are no automatic retries. Preserve the original idempotency key where that operation supports one and inspect the saved run/proposal/handoff before deciding what to retry. Review revisions remain backend compare-and-swap guards; the SDK does not manufacture or advance them.

## Validation and release status

Offline tests cover Python sync/async access, TypeScript access, authority/capability gates, hostile JSON, strict nested correlation, reverse-order concurrent replies and both structured and transport failures. Both languages also read through the actual local backend using a fresh private profile with all network connection attempts trapped. Those checks confirm unchanged config bytes and an offline runner with no run directory; they do not test live provider execution.

The TypeScript package builds with the existing locked dev dependencies. Existing Python SDK policy/protocol regression tests and new Pips tests are recorded in the lab's `output/pips-sdk-*.log` files. The broader suite may contain historical network fixtures or waits; the new Pips tests have no network calls or sleep-based synchronization.

This is an additive lab source change, not a published SDK release. Checkout checksums and SBOM can be regenerated without authenticating them. A matching maintainer signature must be produced by the release owner before the signed checkout verification and publishing gate can pass. No replacement key or fabricated signature is appropriate.

Current validation: 15 new Python Pips tests and 11 new TypeScript Pips tests pass; the combined Python Pips/protocol/controller gate passes 24 tests. The broader Python policy/protocol check passes 72 tests, and all 61 existing TypeScript SDK regression tests pass. TypeScript build and Python bytecode compilation pass. The TS harness now honors `DGC_TEST_PYTHON`; its unknown-event fixture uses `fixture_future_status` because `remote_status` is a supported event.

Unsigned `sdk/sbom/SHA256SUMS` and `cyclonedx.json` were regenerated through the existing generator. Verification now reports only `SHA256SUMS.sig does not verify`. The existing signature and public key were left byte-for-byte unchanged; the matching maintainer private key is absent from this checkout. The release owner must regenerate/sign after reviewing the final source. This is a remaining release gate, not a passed signature check.

## API 10 summary reads

An API 10 runtime adds `list_workspace_overviews`, `list_pending_pip_reviews`,
`list_recent_workspace_activity` and `list_pip_adaptations`. Both SDKs expose
these through `pips.read`; API 8/9 runtimes refuse them locally before transport.
Existing controls retain their earlier capability minimums.

Workspace summaries use `after_id` and a maximum page size of 20. Pending reviews
use `before_id` and a maximum of 20; omitting `workspace_id` requests this runner's
reviews across workspaces. Recent activity uses `before_seq`, newest first, with
a maximum of 50 whole events and an explicit retention disclaimer. Never use the
older forward activity call with `after: 0` as a newest-activity query. Review
rows contain routing references: fetch the original detailed Pip/handoff before
asking the host to authorize a mutation. No aggregate read enables Pips or starts
the background runner. See `docs/PIPS_OVERVIEWS.md` for exact result shapes.

API 10 also adds `get_pip_proposal` with `pip_id` and `proposal_id`. It reads an
exact immutable proposal and nested durable approval metadata for a review link,
without expiring it or changing state. Check `approval.effective_status` and use
the existing explicit mutation flow only after showing the full saved definition.

## API 11 reviewed source policies

`propose_pip_update` containing `changes.source_policy` requires API 11. Both SDKs
refuse it before transport on older runtimes, while ordinary metadata proposals
retain their previous minimum. The host still explicitly approves the proposal
mutation; a separate saved-definition acceptance changes the job. No create-time
shortcut or model-origin source-policy change is added.

Canonical policies are `{mode: "committed_only"}` and
`{mode: "current_tree", exclusions: "safe_source_v1"}`. Current-tree source is
manual-only for read-only auditors and Quill. Its proposal must also remove any
schedule or event trigger; it cannot enable Patch/Pulse or bypass handoff review.
Results distinguish `source_revision` (Git commit or null) from `source_snapshot`
(the exact bounded copy receipt or null). New checkpoint metadata carries explicit
unavailable comparison reasons and null occurrence-comparison counts when source
policies differ. Keep these distinctions in host UI; never coerce a snapshot hash
into a Git revision or null counts into zero. Existing version 1 history remains
valid. See `docs/PIPS_CHECKPOINT_SOURCES.md` and
`docs/PIPS_CURRENT_TREE_SNAPSHOTS.md` for guarantees and limits.

Permission rule maps also include `PipsRun` and `PipsHandoff` for the main chat's
native tools. These labels do not make an isolated SDK controller inherit Pips
state. Raw SDK controls retain explicit host approval, inherited-profile and
independent-supervisor requirements.

## API 12 reviewed session statements

The session-outcome controls require API 12 in both SDKs. Read an exact proposal
with `get_workspace_session_outcome`, or page `list_workspace_session_outcomes`
with `workspace_id`, optional numeric `before_id`, and `limit` (maximum 20).
Use the original proposal's digest for a subsequent review, not a digest computed
from shortened display text.

First call `inspect_workspace_session_outcome` with `workspace_id` and `session_id`
to discover the bounded private transcript's generation and hash. This returns
metadata only, never its contents. The matching CLI is
`dgc pips session-outcome inspect SESSION_ID`.

To populate a session selector, API 12 also offers `list_workspace_sessions` with
`workspace_id`, optional `after` (session ID), and `limit` (maximum 20). It pages
registry association metadata only, never transcript text or filesystem paths.
Use its `next_cursor` only when `has_more` is true. Inspect the selected session
before proposing; an association alone does not prove the transcript still exists.

`propose_workspace_session_outcome` accepts `workspace_id`, `session_id`, `title`,
`statement`, `source`, `expected_session_revision` and `request_key`. A source is
either `{kind: "commit", revision: "exact commit ID"}` or
`{kind: "pip_run", run_id: "completed run ID"}`. The controller resolves these
identities; callers cannot supply a transcript path, arbitrary source receipt or
verification classification. Creating a proposal does not add shared context.

After displaying the saved statement, source reference and verification limits,
the host can approve `accept_workspace_session_outcome` with `workspace_id`,
`proposal_id`, `expected_digest`, and `expected_context_revision`. Reject through
`reject_workspace_session_outcome` with the same identities and digest. All three
mutations still require `approved=True` in Python or `{approved: true}` in
TypeScript, including an exact retry. Host approval of a proposal request does
not also approve its acceptance.

The accepted record is a **user-reviewed statement**, with
`verification: "not_execution_verified"`. Its source was selected for the
statement; it does not establish where a command ran or that a test passed.
The private transcript's bounded identity/revision/hash is pinned, but transcript
text is never included in shared context or these control replies. This path is
separate from the existing controller-recorded Patch/Pulse execution receipts.

Native main-chat permission labels now also include `PipsPause`, `PipsResume`
and `PipsAttach`. Attachments are references, never consent to share transcripts.
Pause does not cancel an in-flight turn; resume allows already approved queued
or scheduled work on the existing independent supervisor. Exact lifecycle retries
return historical receipts and separately labelled current state without
reapplying the original mutation.

## API 13 local notifications

`list_pip_notifications` is a read control with optional `workspace_id`,
`before_seq` and `limit` (1–20). Omit the workspace to see this runner's retained
notifications across its bindings. It scans at most 100 local events per call;
`sync_pending` means a later explicit refresh can continue. The read materializes
a local cache but never changes the source proposal, approval or run.

`mark_pip_notification_read` is a mutation with `notification_id`,
`expected_revision` (0 or 1), and optional `workspace_id`. It requires explicit
per-call SDK approval, including retries. An already-read notification returns
its original reader/time with `replayed: true`. This is an acknowledgement, not
a review acceptance or permission grant. Read state is shared by controllers
of this local runner, not an account-level cloud inbox.

Both controls require API 13 before transport. Pages contain fixed titles and
record references, never transcript text, provider secrets, error bodies or
model prose. Fetch the referenced source through its existing detail control
for any separately reviewed action. Retained notifications are capped at 500;
`history_may_be_incomplete`, `evicted_total` and `unavailable_sources_total`
expose omissions. There is no email, push or OS notification delivery.

## API 14 explicit Pip memory

`get_pip_exception_source` reads a checked source candidate for `pip_id`, `run_id`
and `finding_index`. Present its full source and digest before offering a separate
`record_pip_exception` mutation with the same IDs, `expected_source_digest`,
`reason`, optional `expires_at` (timezone required, or null) and `request_key`.
The source is rechecked atomically; a changed finding review requires fresh review.
No caller-supplied finding body, path, workspace or authority is accepted.

`list_pip_memories` pages by `pip_id`, optional integer `before_id`, and `limit`
(1–20). `revoke_pip_exception` requires `pip_id`, `memory_id`,
`expected_revision` and `reason`. Both mutations require explicit SDK approval
for each request. All four controls require an API 14 runtime before transport.

An exception is a user-recorded reference, not verified execution or permission.
It never suppresses findings, marks them fixed, changes their review status or
promotes itself to workspace context. Exact applicability requires the same source
and job; the original context revision is provenance, not proof the current
context agrees. Future audit and Pip-chat queues pin at most 16 whole records / 8 KiB with omission
counts. Revocation/expiry affects later queues, not historical queued pins.
The existing private ledger retains immutable creation and revocation receipts.
See `docs/PIPS_LOCAL_MEMORY.md` for bounds, historical states and migration limits.

## API 15 reviewed Patch specialists

A Patch handoff action may optionally include
`specialists: {roles: ["explorer", "critic", "worker"], max_calls: 3}`.
Choose only needed roles and a call cap from 1 through 3. Omission retains the
previous action and keeps delegation denied. Both SDKs refuse a handoff proposal
containing this field unless the runtime advertises API 15; the ordinary handoff
minimum stays unchanged. Every proposal and acceptance remains a separately
approved mutation. This is not permission to invoke arbitrary personal agents.

Explorer and Critic inspect only; Worker has exactly the parent's reviewed write
paths in the private copy. Calls are synchronous with no background or nested
delegation. The parent and children share one deadline and request/tool budgets.
Their model prose and specialist receipts remain assessments. Reviewed test
execution still belongs to the controller; delegation cannot add test commands,
provider routes, writes, network, merge, publication or deployment authority.

Show the full canonical action, selected roles and call cap and limits before acceptance.
Do not auto-upgrade existing actions to include specialists. Consult the runtime
receipt for actual calls, stop states and separately labeled token reservations
versus reported usage; the optional grant does not promise that a model uses it.

### Archive and restore (API 16)

`archive_pip` and `restore_pip` are human-controller mutations. Both require
`pip_id`, `expected_version`, `expected_lifecycle_revision`, `request_key` and
`reason`, plus the SDK's explicit per-request approval. Read the exact current
job and lifecycle revisions from `get_pip` before reviewing either action.

Archival retains history and refuses unfinished runs or pending work reviews;
it does not cancel them. An archived Pip cannot run, chat, resume or receive
job/handoff changes. Evidence remains readable and reviewable. Restore returns
the Pip to **paused**, requiring a separate explicit resume before automated work.

The response contains the current `pip`, the immutable transition `receipt` and
`replayed`. Reusing the exact actor-scoped request key returns the original receipt
without applying its transition again, even if the Pip has since been restored.
Do not mistake the receipt's historical status for the current Pip status.
No deletion, archive export, cross-machine migration or model lifecycle tool is
introduced by these commands. API 15 and earlier refuse them before transport.

API16 also accepts `expected_lifecycle_revision` on `pause_pip` / `resume_pip`.
Supplying it requires API16; it is never silently discarded on older runtimes.
Legacy unpinned controls continue for never-archived Pips. After archival, resume
requires an exact current lifecycle pin, including after restoration to paused.
This prevents a delayed pre-archive resume request from reactivating the Pip.
## Saved foreground turn triggers (API18)

`propose_pip_update` with `changes.event_trigger.events` containing
`session_turn_completed` requires a runtime advertising API18. Older event choices
keep their existing compatibility gates. Mutation calls still require explicit
host approval, and the saved proposal needs ordinary human review before its
trigger is active. The SDK cannot manufacture completion events.

This event means one native foreground turn completed and its final session save
succeeded. It contains no transcript and makes no test, project-completion or
source claim. Any resulting audit uses its approved committed source at enqueue.
Cancelled/failed turns, automatic goal resumes, monitor/child/Pip work and delegated
vendor turns do not qualify. Session-file save and the event transaction are
separate; a crash between them leaves an unobserved completion, not reconstructed
or replayed work.

## Reviewed Pip-local statements (API19)

These four commands require an enabled runtime advertising **Pips API19**. Python
`Session.pips`, `AsyncSession.pips`, and TypeScript `Session.pips` use the same
read/mutation distinction. API18 refuses them before transport. Existing inherited
profile, RuntimePolicy, sandbox and plan-mode restrictions still apply.

- Read `get_pip_statement_anchor` with `pip_id` and optional `source_run_id`.
  It returns `{anchor, digest}` for the exact job/lifecycle/binding/context metadata.
  Omit the source to state explicitly that no source was observed; a selected run
  must be a completed checked audit of the same Pip. The audit does not verify the
  authored statement. No transcript or source files are read by this operation.
- After presenting that anchor and the full authored text for human review, mutate
  `record_pip_statement` with `pip_id`, `kind` (`fact` or `preference`), `title`,
  `statement`, `reason`, **required** `expires_at` (null or a timezone-aware date),
  `expected_anchor_digest`, `request_key`, and the same optional `source_run_id`.
  Display `fact` as **Recorded claim**, not verified fact. Preferences are advisory.
- Read `list_pip_statements` with `pip_id`, optional safe-integer `before_id`, and
  `limit` from 1 to 20. Whole records, effective expired/revoked state and omission
  metadata are returned; the page is bounded to 64 KiB.
- Mutate `revoke_pip_statement` with `pip_id`, `memory_id`, `expected_revision:0`
  and `reason`. Revocation has no restore/edit operation. Exact same-actor/reason
  retries preserve the original receipt.

Both mutations require explicit `approved=True` / `{approved: true}` on **every**
call, including retries. The actor comes from the controller, not SDK parameters.
The backend validates field bounds, selected source, exact anchor and review CAS;
SDK approval does not override a stale anchor, archive, quota or policy refusal.

```python
candidate = session.pips.read("get_pip_statement_anchor", {"pip_id": pip_id})
# Present candidate and these authored fields for human review before this call.
saved = session.pips.mutate("record_pip_statement", {
    "pip_id": pip_id, "kind": "preference", "title": "Review style",
    "statement": "Prefer concise explanations with source references.",
    "reason": "Explicit maintainer preference", "expires_at": None,
    "expected_anchor_digest": candidate["digest"], "request_key": review_request_key,
}, approved=True)
```

Async Python uses `await` on the same `read` and `mutate` calls. In TypeScript the
record parameter type requires `expires_at`; optional source/cursor fields are
omitted rather than sent as null. Responses retain the generic `PipResult` shape;
applications should validate the runtime's closed record contract before rendering.

Claims/preferences remain private reference data for that Pip's future audit/chat
pins. They do not change jobs, permissions, findings or Workspace Context and never
verify execution or tests. Exact create retries return the original immutable
record after expiry, revocation or archival without reactivating it. Future queues
use at most 16 whole records / 8 KiB with explicit omissions; queued pins stay historical.
Statement-free Pips retain the original v1 exception envelope. The combined ledgers
retain at most 1,000 records per runner and 32 active/unexpired records per Pip.

## Reviewed Quill automation (API20)

An API20 runtime adds reviewed schedules and event triggers for committed-source
Quill documentation drafts. These use the existing `propose_pip_update`,
`get_pip_proposal`, and `accept_pip_update` controls and parameter fields. There is
no new SDK method, wire field, capability flag, implicit job lookup or role cache.
Current-tree Quill remains manual-only; a recurring draft never gains project
write, command, publication, or connector authority.

Before offering this feature, a host must read `get_pip` for the exact selected
Pip and validate the returned ID, `pip_type`, `current_version`, and source policy.
For Quill, require an integer `session.capabilities["pips_api_version"] >= 20`
(TypeScript: `Number.isSafeInteger(session.capabilities.pips_api_version)` and the
same comparison), alongside the existing supported/enabled checks. Do not offer
Quill automation when the type, source policy or capability is unknown. The SDK's
generic proposal call cannot infer a role from `pip_id` alone.

The host then presents the exact proposed schedule or event trigger for review,
passes the fetched version as `expected_version`, and explicitly approves that
single proposal mutation. Fetch and present the saved proposal before a separate,
explicitly approved acceptance using its expected version. A proposal is not
activation. The backend validates role, source, policy and version again; if the
job changed, show the conflict and start a fresh review. Do not advance the
version, clear a trigger, substitute a role or downgrade a request automatically.

Audit schedule updates keep their existing API requirements. In particular,
ordinary schedule updates remain usable on API19; `session_turn_completed`
retains its API18 event gate. Because the schedule syntax is shared and the
generic SDK does not fetch a job implicitly, a direct Quill automation request
to an older runtime reaches that runtime's authoritative rejection. It surfaces
as `DGCCommandRejectedError` with the original `reason` (for example,
`manual_only` or `invalid_event_trigger`) and command. There is no hidden query,
retry, fallback or automatic acceptance. Explicit `approved=True` /
`approved:true` remains required for every mutation on every API version and
does not bypass inherited-state, policy, sandbox, plan-mode or disabled guards.

The API20 SDK compatibility tests use deterministic transport fixtures to check
unchanged API19 audit forwarding, structured older-Quill refusal, exact stale
version forwarding, no extra requests, and separate proposal/acceptance approval.
They are not a claim that an actual scheduled draft or event worker executed;
that is covered separately by core and native acceptance.

## Reviewed standalone Pulse verification (API21)

API21 adds a separately reviewed standing command plan for committed-source Pulse
jobs. This is independent of existing finding/artifact handoffs. The SDK requires
API21 before sending `changes.verification_plan`, including removal with null, or
any new `run_pip` pin. It performs no hidden job lookup, role inference, rebase,
retry or acceptance. Generic legacy auditor/Quill schedule requests keep their
existing capability gates.

Use the existing proposal → saved-proposal read → separate acceptance flow. A plan
has exactly `schema_version:1` and `action`, where the action contains `kind:test`,
one to four ordered `{argv:[...],cwd:"."}` commands, `network:false` and the fixed
runner limits. Present every literal argument and directory, the committed source
choice, calendar (if any), and confinement limits for human review. Do not infer
commands from a goal or a model response. Plan creation/removal belongs to the
human-control surface, not an unattended model proposal tool. A schedule requires
a plan; removing both can be reviewed in one proposal. Current-tree/event-triggered
standalone verification is refused in this increment.

For a new manual run, read `get_pip` and validate the returned exact job identity,
Pulse type, version, lifecycle revision, canonical `verification_plan`, and
controller-computed `verification_plan_digest`. After human confirmation, pass
all three pins together without refreshing them silently:

```python
session.pips.mutate("run_pip", {
    "pip_id": pip_id,
    "idempotency_key": reviewed_run_request_key,
    "expected_version": reviewed_job["current_version"],
    "expected_lifecycle_revision": reviewed_job["lifecycle_revision"],
    "expected_plan_digest": reviewed_job["verification_plan_digest"],
}, approved=True)
```

Async Python awaits the same call; TypeScript forwards the same snake-case fields
with `{approved:true}`. They are optional in the generic SDK type because ordinary
auditors/drafts retain the old request, but the backend requires all three for a
new standalone Pulse run. Mixing them with another authorization path is refused.
Separate explicit approval is required for proposal, acceptance and manual run.
Existing inherited-profile, RuntimePolicy, sandbox, disabled and plan-mode guards
remain in force. A conflict is returned as a structured `DGCCommandRejectedError`;
the host must start a new review rather than substituting current values.

This branch invokes no model: the manifest has null model/provider fields and the
grant records the unused configured model choice. The controller runs only the
approved arguments through Linux/bubblewrap with read-only source, private scratch,
no network and the existing process/output/time limits. Missing capability means
refusal, not an unrestricted fallback or automatic dependency installation.

Treat the new versioned progress/result as recorded command outcomes. A run can
complete while an invocation exits nonzero. Exit0 alone does not prove that a test
framework ran or that the project is correct. Finished outcomes survive cancellation
and interruption; a reserved launch without a durable final outcome is **unknown**.
Never turn a partial receipt into an all-passed badge or automatically replay it.
This increment does not accept these receipts as findings, handoffs or Workspace
Context promotion. Raw artifact access and project apply/merge/deploy authority do
not expand. See [the implementation contract](../docs/PIPS_PULSE_PLANS.md)
in the isolated handoff for the bounded receipt schema and acceptance status.

## Reviewed committed-path triggers (API22)

API22 adds `committed_paths_changed` to the existing reviewed event policy. Both
SDKs require API22 before forwarding that event or the presence of `commit_paths`
(including null). They do not query the job, guess its role, strip the filter,
retry a stale version or substitute broad `commit_changed`. Existing event and
calendar requests retain their previous capability requirements.

```python
saved = session.pips.mutate("propose_pip_update", {
    "pip_id": pip_id,
    "expected_version": reviewed_version,
    "reason": "Review committed changes in source and the package definition",
    "changes": {"event_trigger": {
        "events": ["committed_paths_changed"],
        "minimum_minutes": 5,
        "missed_policy": "coalesce_latest",
        "commit_paths": [
            {"kind": "directory", "path": "src"},
            {"kind": "exact", "path": "pyproject.toml"}
        ]
    }}
}, approved=True)
# Present the exact saved proposal to the human. Acceptance is a separate
# approved mutation naming the saved proposal and unchanged expected version.
```

The backend canonicalizes 1–32 literal, case-sensitive relative rules within a
2KiB total budget. Each path has a256 UTF-8-byte bound. A directory rule matches
descendants separated by `/`; `src` does not match `src2` or an entry named exactly
`src`. No globs, regex, pathspec expansion, symlink traversal or file-body reads
are implied. The new event cannot be combined with broad `commit_changed`.
Other selected events are independent OR conditions, shown in the saved review.

This applies to committed-source Scout, Lens, Rook, Lock and Quill. It grants no
execution authority to Patch/Pulse and does not observe dirty or untracked files.
The initial observation and lifecycle/ref/filter/binding resets are silent.
Incomplete or unavailable comparisons never wake the job. Source is selected
separately when a retained matching event is enqueued: the observed commit pair
can differ from the actual run source revision.

The selected match is bounded metadata in `manifest.event_trigger.commit_path_match`.
It identifies the original reviewed rules by indices and records the observed
commit pair; it contains no discovered path list or file contents. Other event
selections, including other events on a filtered job, omit this field. Digests
bind saved representations; they do not independently attest that Git work occurred
or defend against arbitrary local database writes. No Remote trust or SDK
permission boundary changes accompany this policy.

## Per-message reply controls (API24)

`send_pip_message` accepts optional `chat_options` with exactly two fields:
`context_size` (integer 2048–32768) and `thinking` (`off`, `low`, `medium`, `high`
or `xhigh`). Both SDKs require API24 before forwarding a request that includes
the field, including null or an empty object. At API24 those malformed values,
partial objects, extra keys and invalid choices are refused before transport.
Omitting the field retains the original API8 send behavior and retry identity.

```python
reply = session.pips.mutate("send_pip_message", {
    "pip_id": pip_id,
    "text": "Explain the source references in the latest report.",
    "idempotency_key": "review-reply-1",
    "chat_options": {"context_size": 8192, "thinking": "medium"},
}, approved=True)
```

TypeScript exports `PipChatOptions` and includes it on
`PipMutationParams["send_pip_message"]`. The equivalent call still requires
`{approved: true}`. Both languages detach the supplied options before transport;
SDK isolation, policy, sandbox and plan-mode guards remain unchanged. Options
cannot carry a mode, permission, model, endpoint, credential or output-limit
override. They apply to one immutable read-only conversation run, not a standing
job or schedule. An explicit `off` choice is not raised by prompt keywords.

`list_pip_messages` retains its original capability minimum and returns additive
`chat_controls` metadata on API24 runtimes. It includes the available choices,
the selected context budget, the inherited main context size, last-message
defaults and the provider's reasoning limitation. Hosts must handle its absence
on older runtimes. Provider effort mappings vary; instruction guidance does not
promise native reasoning support. The existing worker time, output and tool
budgets still apply. A connection that rejects the reply's output-token cap is
refused; the worker does not retry that request without its cap.

The backend binds the selected options into the message's idempotency digest.
Changing options under an existing key is a conflict. The SDK never removes the
options, changes the key, retries automatically or converts a refusal into a
legacy send. Inspect the saved run after an ambiguous timeout before retrying
the exact original request.


## API 28: Personal Pips and existing app connections (local lab)

A Personal Pip belongs to the local DGC profile, not to the editor directory.
An explicitly authorized inherited controller can locate it using:

```python
workspaces = session.pips.read("list_workspaces")["workspaces"]
personal = next(w for w in workspaces if w["kind"] == "personal")
jobs = session.pips.list(personal["id"])
connections = session.pips.read("list_pip_connections")
# Only after choosing a saved connection; public tool-schema metadata, no email:
metadata = session.pips.read("inspect_pip_connection", {"server": "composio"})
```

```typescript
const workspaces = await session.pips.read("list_workspaces", {});
const connections = await session.pips.read("list_pip_connections", {});
const metadata = await session.pips.read("inspect_pip_connection", {server: "composio"});
```

Use the returned Personal workspace ID with existing create/list controls; use
Pip/run IDs with existing conversation, lifecycle, results and review controls.
Mutations still require `approved=True` / `{approved: true}` for that exact request.
A proposal mutation never implies approval of its contents. There is no separate
SDK login or credential store. Both clients reject app-plan mutations and the two
new metadata reads on runtimes older than API 28.

An app plan pins the saved connection, read schemas, exact arguments and connected
account ID. Never invent IDs or digests. Granting access requires a separate saved
job review. Revocation is checked before provider reads and before their contents
reach the worker. Current supported reads are bounded Gmail and Calendar reads;
external actions and other adapters remain under construction. Live Google-account
verification is pending, not implied by SDK unit tests.

Saved personal documents are `get_pip_run` results with `run_kind: personal_task`
and `result.text`. Hosts choose where to display/save them; the SDK does not write
files or publish localhost pages. The local CLI offers private exclusive Markdown
export, and the extension offers Open Markdown and native Save As.

These changes are additive local source work. The release agent must regenerate
and sign the final SDK manifest after reviewing all changes. No SDK version or
signature has been published from this lab.

### Personal conversation drafts

`send_pip_message` can now produce a proposed change to that personal Pip's
name, goal, schedule or model choice. A returned chat reply is never approval.
Poll `get_pip` for its pending proposals and use the existing explicit
`accept_pip_update` / `reject_pip_update` human-control flow with the exact saved
proposal ID and expected job version. The proposal actor records `pip_chat:`
followed by the producing run ID. No additional SDK credentials or mutation
API is introduced. Locked Pips cannot produce these drafts. App permissions,
source policy, tools, account selection and endpoints are not draftable here.

Personal manual/scheduled runs also carry a bounded reference snapshot of that
Pip's successful chat and rolling brief. This does not share another Pip's
history or authorize actions mentioned in old messages.

## API 29: discover connected accounts for human review (local lab)

```python
identities = session.pips.read("list_pip_accounts", {"server": "composio"})
```

```typescript
const identities = await session.pips.read("list_pip_accounts", {server: "composio"});
```

The result contains `server`, `connection_digest`, bounded `accounts` entries
(`toolkit`, stable `id`, display `label`), per-toolkit availability and a notice.
The exact request field is `server`; this read accepts no account, arbitrary tool
or authentication parameters. Both SDKs refuse it below Pips API 29. It is a local
controller read, not a model-worker grant or Remote authorization.

Present all available accounts and require a human choice. Do not infer a choice
from the first result, a label, an email address or a provider's default. Older
Composio endpoints may not expose stable account identities. An empty/unsupported
result is not permission to use an unpinned default account. Combine the chosen ID
with `inspect_pip_connection` metadata from the same connection digest, prepare an
exact `app_plan` proposal and obtain human acceptance through the existing durable
review path. Listing identities reads no email/events and approves nothing.

The current picker supports bounded Gmail and Google Calendar reads only. A
calendar window is absolute on API 29; API 33 adds reviewed recurring windows. Public-contract and
offline validation are distinct from live-provider verification, which is pending.

## API 30: Personal result handoffs (local lab)

Python and TypeScript expose `propose_pip_personal_handoff` as an explicitly
approved mutation. Its exact fields are `source_run_id`, `target_pip_id`,
`shared_text`, `task` and `idempotency_key`. The backend derives all permission,
source-result, model and job pins; the caller cannot supply an action contract.

```python
proposal = session.pips.mutate("propose_pip_personal_handoff", {
    "source_run_id": source_run_id,
    "target_pip_id": target_pip_id,
    "shared_text": reviewed_excerpt,
    "task": "Turn this plan into a checklist.",
    "idempotency_key": "checklist-1",
}, approved=True)
```

```typescript
const proposal = await session.pips.mutate("propose_pip_personal_handoff", {
  source_run_id: sourceRunId, target_pip_id: targetPipId,
  shared_text: reviewedExcerpt, task: "Turn this plan into a checklist.",
  idempotency_key: "checklist-1",
}, {approved: true});
```

Proposal approval here means permission to save that proposal, **not** acceptance
of the handoff. Show its saved `personal_result.v1` payload to the user and call
the existing `accept_pip_handoff` only after separate approval, with the exact
`handoff_id` and `expected_revision`. `get_pip_handoff`, `list_pip_handoffs`,
`reject_pip_handoff` and the existing run/result controls retain their contracts.
The backend pins the verbatim excerpt, source result digest, job/lifecycle
revisions, recipient model connection and recipient's existing app plan. It does
not copy source permissions. Changed pins fail closed rather than silently
rebasing. SDKs require API 30 before sending the new proposal command.

## API 31: reviewed external messages

Python (sync/async) and TypeScript expose three additional reads:
`inspect_pip_send_connection {server}`, `get_pip_app_action {action_id}` and
`list_pip_app_actions {pip_id, before_id?, limit?}` (1–20 rows).
Three mutations require explicit host approval:

- `propose_pip_app_action {source_run_id, server, connection_digest, account,
  schema_digest, message: {recipient_email, subject, body}, request_key}`.
- `accept_pip_app_action {action_id, expected_digest}`.
- `reject_pip_app_action {action_id, expected_digest}`.

Proposal approval is permission to save a review only. Fetch the saved action and
show its exact account, recipient, subject and body before separately authorizing
acceptance. Use `approved=True` / `{approved: true}` only for that human decision.
An accepted action is one local attempt. `succeeded` means Gmail accepted it, not
that the recipient received it. `dispatching` or `unknown` means delivery is
unconfirmed; repeating accept observes the saved attempt without retrying it.
Pending reviews expire after 24 hours. Job/source/connection changes can invalidate
approval. These commands use the local controller, not an isolated model worker
or Remote; they do not require or start the background supervisor.

API 31 supports exact, account-specific Composio Gmail plain-text sends. API 34
adds separately reviewed single Google Calendar events, described below.
This is source code in the isolated lab; live provider verification and release
signing are still pending. See `docs/PIPS_PERSONAL_APPS.md` for guarantees and limits.


## API 32: conversational email drafts

Reads (Python sync/async and TypeScript):

- `get_pip_message_draft {draft_id}` returns the authoritative saved draft.
- `list_pip_message_drafts {pip_id, before_id?, limit?}` returns up to 20 summaries.

Mutations require explicit host approval:

- `prepare_pip_message_draft {draft_id, expected_digest, server,
  connection_digest, account, schema_digest, message: {recipient_email, subject, body}}`
  saves a separate immutable API 31 send review. It does not send.
- `dismiss_pip_message_draft {draft_id, expected_digest}` dismisses an inert draft.

The model's `draft_email` / `draft_pip_email` tools produce drafts; SDK clients
review existing drafts through these closed commands. Show the exact message and
require an explicit account choice before preparing. Fetch the returned action
and obtain separate human approval before `accept_pip_app_action`. Approval of
preparation must never be reused as approval to send. Remote and worker actors
cannot use these controls. API 31 runtimes refuse API 32 calls before transport.
Drafts expire after 24 hours; already prepared drafts refer to their retained send
review and cannot create a second action. The local controller validates current
source/job/connection pins before any send attempt.


## API 33: recurring calendar-day read plans

Use the existing `propose_pip_update` mutation with human host approval and
`changes.app_plan.schema_version: 2`. Review and separately accept the saved
proposal; proposal permission does not authorize access by itself. Python and
TypeScript refuse version 2 plan updates against a backend older than API 33.

A `GOOGLECALENDAR_FIND_EVENT` call can carry:

```json
{
  "window": {
    "kind": "calendar_days",
    "timezone": "Asia/Kolkata",
    "start_day": 0,
    "days": 7
  }
}
```

Keep the existing exact `account`, `schema_digest`, `tool` and bounded `arguments`.
The arguments must omit `time_min` and `time_max`; the controller resolves these
once per run at the start of app reads. Midnight boundaries use the reviewed
IANA timezone, including DST. Start day is 0–30, length 1–31; missing timezone data
or a nonexistent midnight is an actionable refusal before connecting. The worker
receives exact resolved UTC bounds with its references. Version 1 fixed-date
plans retain their behavior. No new SDK command, database migration or dependency
is needed. This is a read permission, not approval for calendar writes or sending.


## API 34: reviewed single calendar events (local lab)

Python sync/async and TypeScript expose:

- Read: `inspect_pip_calendar_connection {server}`. This fetches tool metadata,
  not account contents, and returns connection/schema digests.
- Mutation: `propose_pip_calendar_action {source_run_id, server,
  connection_digest, account, schema_digest, event, request_key}`. Requires
  explicit host approval (`approved=True` / `{approved: true}`) to save a review.

Both SDKs refuse these two commands below Pips API 34 before transport. `event`
has exactly five fields, all strings:

```json
{
  "summary": "Read one chapter",
  "description": "A quiet half hour.",
  "start_datetime": "2026-12-01T11:00:00+05:30",
  "end_datetime": "2026-12-01T11:30:00+05:30",
  "timezone": "Asia/Kolkata"
}
```

Example dates are illustrative: the chosen start must still be future when
accepted. Inspect the saved version-2 `calendar_create` payload via
`get_pip_app_action`, display the account, primary calendar, full event text and
exact times, then obtain a separate human decision before
`accept_pip_app_action {action_id, expected_digest}`. Proposal approval must never
be reused as creation approval. Existing list/get/reject controls support both
Gmail and calendar actions; list summaries include `kind`. No model or Remote
actor may use these mutation controls.

The event is private/busy with no guests, recurrence, notification emails or Meet
link. Calendar reminders and sharing policies can still apply. Explicit offsets
must agree with the IANA zone; duration is at most seven days. A passed start,
stale job or changed connector refuses before dispatch. Success carries exactly
`{provider: "Google Calendar", event_id, meaning: "Provider confirmed creation of
this calendar event."}`. Unknown or dispatching means creation is unconfirmed;
repeating acceptance observes the same attempt without retrying. Investigate the
provider before preparing a new action. Reviews expire after 24 hours.

Registry schema 28 retains earlier Gmail actions and refuses older readers. Stop
and restart older processes sharing the profile for migration. This is an
unreleased local implementation. Provider metadata was checked; actual account
creation remains untested by user choice. Final SDK source signing belongs to
the release agent.


## API 35: conversational calendar drafts (local lab)

Python sync/async and TypeScript require API 35 before transport for:

- `get_pip_calendar_draft {draft_id}` and
  `list_pip_calendar_drafts {pip_id, before_id?, limit?}` (1–20 summaries).
- `prepare_pip_calendar_draft {draft_id, expected_digest, server,
  connection_digest, account, schema_digest, event}`.
- `dismiss_pip_calendar_draft {draft_id, expected_digest}`.

The two mutations require explicit host approval. `event` has the same five exact
string fields as API34. Fetch the saved draft, let the human edit its contents
and choose an account, then prepare the review. Preparation is not acceptance:
fetch the returned action and obtain a separate decision before calling
`accept_pip_app_action`. Never transfer approval between those two decisions.

Calendar drafts use `caldraft_` IDs and a version1 payload with exactly
`schema_version`, `source` and `event`. Email drafts keep their existing payloads
and commands. Repeated preparation returns the same action only when account,
connection/schema pins and event still match; a changed request is refused.
Concurrent controllers link one action atomically. Cancelled or stale replies
cannot commit a draft. Dismissal, expiry and old-runtime refusal are explicit.
The additive registry29 migration preserves previous email/action records.
Live calendar-account creation remains pending; an inert real-model draft is not
proof of provider execution. SDK publication/signing remains release-agent work.

### Reviewed connector calls (API 36)

`inspect_pip_connector_actions {server}` returns the existing connector's tools,
input schemas and descriptor digests without calling a tool. The supported saved
connector names are `zapier`, `arcade`, `make`, `n8n`.

`propose_pip_connector_action {source_run_id, server, connection_digest,
schema_digest, call: {tool, arguments}, request_key}` prepares one action from a
completed Personal result. It requires explicit host approval, even though it is
inert. There is no `account` parameter: these connectors manage account/default
selection themselves. Review any account/workflow fields present in the tool's
inputs and its provider dashboard. A metadata fingerprint is not an immutable
remote workflow version.

Then use the existing `get_pip_app_action`, and separately human-approved
`accept_pip_app_action {action_id, expected_digest}` or `reject_pip_app_action`.
Do not automatically accept after preparation. Success means a connector response
was received, not downstream workflow completion. The receipt provides `provider`,
`tool`, `response_digest`, a bounded `response_preview`, and an explicit `meaning`.
Unknown or interrupted attempts never retry. Older runtimes refuse the new
controls. Registry schema 30 prevents older implementations reading new payloads.

CLI equivalent:

```sh
dgc pips app-action inspect make --kind connector_call
dgc pips app-action propose RUN_ID --kind connector_call --server make \
  --connection-digest CONNECTION_DIGEST --schema-digest TOOL_DIGEST \
  --request-key MY_REVIEW_KEY --call-file /absolute/path/reviewed-call.json
dgc pips app-action show ACTION_ID
# Only after a human has reviewed the saved action:
dgc pips app-action accept ACTION_ID --expected-digest REVIEW_DIGEST
```

`reviewed-call.json` contains `{"tool":"actual_tool_name","arguments":{...}}`.
Tool names and inputs come from the saved connector, not a hardcoded example.
No network/service execution was used in the deterministic contract tests. Live
provider verification remains pending; do not interpret a green SDK test as
verified account authorization or successful external work.

## API 37: conversational connector drafts

Personal Pip conversations can use `list_connector_tools` to inspect metadata
pinned by the local controller, then `draft_connector_action` to propose exact
inputs. The worker receives no connector credentials or MCP process and cannot
execute the proposed action. A successful reply saves one inert draft; cancelled,
failed or stale replies do not publish it. The main chat offers
`draft_pip_connector_action` with explicit `scope: personal` and a completed
Personal source. `pips_context` action `connector_tools` discovers real tool names,
input schemas and fingerprints; guessed or changed descriptors are refused.

Local Python sync/async and TypeScript clients expose:

- `get_pip_connector_draft {draft_id}`.
- `list_pip_connector_drafts {pip_id, before_id?, limit?}` (1–20 summaries).
- `prepare_pip_connector_draft {draft_id, expected_digest, call?}`. Omit `call`
  to keep the draft inputs. An override can edit arguments for the same tool;
  the saved connection and descriptor fingerprints cannot be replaced.
- `dismiss_pip_connector_draft {draft_id, expected_digest}`.

Preparation and dismissal require the SDK's explicit host approval. Preparation
returns a pending API 36 external-action review. It does not run anything;
`accept_pip_app_action` is a separate human decision. Requests need an existing,
local, unrestricted controller; Remote and restricted sessions are refused.

CLI equivalents:

```sh
dgc pips connector-draft list <pip-id>
dgc pips connector-draft show <draft-id>
dgc pips connector-draft prepare <draft-id> --expected-digest <digest>
dgc pips app-action show <action-id>
# Review the exact action before this separate, interactive approval:
dgc pips app-action accept <action-id> --expected-digest <action-digest>
```

Drafts expire after 24 hours and use the retained schema-31 ledger. Retrying the
same prepared draft cannot produce another action. Connector accounts and workflow
contents remain provider-managed; a returned response does not prove downstream
completion. Final source-manifest signing remains the release agent's step.
