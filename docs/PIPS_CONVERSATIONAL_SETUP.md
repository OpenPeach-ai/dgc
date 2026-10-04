# Conversational setup (local lab, API 27)

In the extension, open **Pips → New**, describe the project, task, schedule/timezone
and whether to run once now, then choose **Describe to DGC**. This prepares an
unsent message in the main chat. It refuses to replace an existing draft or
attachments. Users can also ask the main chat directly. **Advanced** retains the
manual character/configuration flow. Existing jobs offer **Change setup in chat**.

The model uses `pips_setup` to save a pending proposal. That tool never creates,
resumes, reschedules or runs a job. A single review card shows the canonical
project folder, responsibility, role, committed source, schedule/timezone, exact
next occurrence, run-once choice and permissions. Only an explicit human review
applies it. Saving activates the reviewed Pip; it does not start or resume the
global runner. A selected immediate run additionally requires a live supervisor.

## Model selection and immutable revisions

API 25 adds human model selection on a setup card. The model-facing `pips_setup`
tool accepts an optional `model_choice`: `{"mode":"default"}` or
`{"mode":"model","model":"a-real-model-id"}`. Omitting it preserves the
existing Pip's choice, or inherits the main DGC model for a new Pip. It cannot
set a provider, endpoint, key or permission. Projections include the effective
choice; older stored setup bodies and their digests remain unchanged.

The local human control `revise_pip_setup` accepts only `setup_id`,
`expected_digest` and `model_choice`. It checks the current workspace, source
identity, owning session and expiry, then atomically rejects the original card
and saves a new immutable pending card with refreshed schedule previews. It does
not create a Pip, modify its job or queue work. Review and approval are still
required. The original rejected receipt retains `replacement_setup_id`; clients
can follow it after a window reload. An identical retry returns that replacement,
including its current accepted/rejected state. A normal rejection cannot be
reopened by this operation. Revising again requires the replacement's own ID and
digest. Failed revision rolls back both changes.

Explicit models must be offered by the configured connection. Catalog discovery
runs outside SQLite write transactions. For immediate model-based setup runs, the resolved
model and request limits are prepared once and checked again during the atomic
job/queue write, without another provider request. A changed model connection or
request budget aborts acceptance without leaving a partial job or run.

Both SDKs classify revision as an explicitly approved mutation, require API 25,
and preserve the existing isolation, policy, plan-mode and correlation checks.
The editor wire protocol remains 14, and the database is schema 24. The SDK
source manifest reflects these local changes; the maintained public key and
signature are untouched. A maintainer signature is still required for release.

Context and thinking controls remain per-reply inference choices. API 25 permits
reply context requests above 32,768, up to 1,048,576, when the selected model can
support them. This setup card does not pretend those choices are saved scheduled
job settings. See `PIPS_CONVERSATION_CONTROLS.md` for the separate history and
auto-compaction guarantees.

## SQLite refresh concurrency

The reported red `database is locked` error while a reply succeeded was reproduced
with two real WAL connections. A lazy Pip-list cursor retained a read snapshot,
then review expiry tried to turn it into a write after the runner had committed.
SQLite reports `SQLITE_BUSY_SNAPSHOT`; increasing a timeout cannot make that
snapshot current. The list now materializes its bounded 100 IDs before projecting
rows. Opening a current-schema registry, resolving an existing workspace and
checking reviews with no due expiry also remain reads instead of taking needless
write locks. Actual expiry retains an atomic write transaction and rechecks the
due rows; genuine storage errors are not suppressed.

Regression tests force the conflicting commit synchronously, prove refreshes can
read during a held writer transaction, verify expiry is recorded exactly once,
and verify real write failures remain errors. Tests use no sleeps or network.

## Local commands

```text
dgc pips setup list
dgc pips setup show <setup-id>
dgc pips setup accept <setup-id> --expected-digest <displayed-digest>
dgc pips setup reject <setup-id> --expected-digest <displayed-digest>
```

Acceptance prints the complete card, then asks for confirmation. Automation must
provide `--yes` after reviewing the exact digest. `--json` works on all four
commands. Exact retries return the original receipt, including any queued run ID.
The receipt is evidence of acceptance/queuing, not evidence of successful work.

## Boundaries

- Conversational setup supports Scout, Lens, Rook and Lock source reviews, Quill
  documentation drafts, and exact reviewed Pulse verification plans.
- It does **not** turn a request to smoke-test a running app into a source review.
  Pulse supports fixed local HTTP status checks after review of the exact URLs.
  Patch setup remains a separate reviewed handoff.
- `target_root` must be the current canonical chat project. A Pip from the demo
  workspace cannot be repurposed for Bearbloom by changing a label. Open the
  correct project and prepare a new proposal there.
- Existing job updates preserve model choice unless explicitly reviewed, and
  preserve adaptation policy. Event-trigger
  and current-tree jobs require their existing dedicated review controls.
- Daily scheduling with “run once now” counts that immediate run as today's
  occurrence. The next calendar run is on the next local date, preventing two
  runs around the scheduled time. If the date or reviewed next occurrence passes
  before acceptance, request a fresh card.
- Source, job/lifecycle version, root identity, workspace binding, origin session,
  expiry and review digest are checked again on acceptance. Job changes, schedule
  changes, receipt and optional queue insertion share one SQLite transaction.
  Failed queue preparation/acceptance leaves the job unchanged.
- The inbox shows the oldest five complete cards; resolving them reveals later
  drafts. Limits: 16 KiB per stored body, 20 pending per workspace, 1,000 retained
  locally, seven-day review expiry. History is immutable; no cleanup UI added.
- Schema 23 is additive. Older binaries refuse newer registries. The test profile
  is separate from the founder's active profile. Local setup controls are
  not exposed over the current Remote API 22 transport.

No new dependencies, hosted service, model credentials, automatic permission
grants, public release or signed SDK artifact are introduced.

## Character glow

The shared orb renderer now has three colored, silhouette-following shadows and
a gentle 4.8-second pulse. Pausing the character pauses the halo. Reduced motion
keeps a steady halo. The accepted body shader, colors, expressions and dimensions
are unchanged. The extension, character study and Remote asset copy share this
renderer; the normal installed DGC extension is untouched.

## Verification

Backend and integration tests use disposable projects, fake clocks and offline
model responses. They cover wrong projects, stale reviews, source changes,
expired dates, retries, malicious/oversize arguments and rollback after queue
insertion. UI tests cover draft preservation, API gates, response correlation,
review projection integrity and narrow layouts. Native visual review uses the
actual development extension with a separate offline DGC profile; no founder job
is accepted, paused, resumed or run by these checks.

This is not a claim that an arbitrary model always chooses the correct tool.
The controller enforces the review boundaries when the tool is used. Arbitrary
shell access granted elsewhere remains governed by DGC's normal permissions.

Historical API 23 validation on 2026-10-02: 1,815 Python tests across 123 modules (zero failures,
errors, skips or source changes during the gate), 268 extension tests, 43 shared
web/orb tests, extension build and web/SDK type checks. Native VS Code evidence is
in the lab's `output/pips-setup-native-review.json`; the final regression result
is `output/pips-conversational-setup-verified-result.json`. The disposable native
profile ended with one accepted setup, one rejected setup, one job and zero runs.
The founder's running profile was not migrated or restarted for these checks.
Stop and restart **DGC Pips lab (isolated backend)** in Run and Debug to load the
new extension/backend together. Open the actual project before requesting setup.


## Current card behavior (API 26 pass)

Main-chat cards now expose Approve, Reject and Review while collapsed. Approval
automatically queues a verified receipt to the owning chat without interrupting
its running reply or clearing its draft. There is no continuation checkbox.
The setup remains pending until a person approves; the model turn need not wait.
See [PIPS_CHAT_CONTINUITY.md](PIPS_CHAT_CONTINUITY.md) for the current contract.

## Conversational Pulse (API 27)

`pips_setup` accepts `pip_type: "pulse"` and a required `verification_plan`.
`work_kind: "command_verification"` requires the existing network-free command
plan. `work_kind: "app_smoke_test"` requires the fixed `loopback_http_v1` profile.
The model must inspect the real project and confirm targets; a prose goal never
confers execution authority. A Pulse card displays each exact argument, working
directory, schedule and limits. The main conversation continues while it is
pending. Approve/Reject remain available on its collapsed card.

Approval creates the job version, exact proposal/approval lineage, schedule and
optional queued run atomically. New jobs use version 1 and a human review of the
creation (expected version 0); existing jobs pin their current version and
lifecycle. Rejection creates no execution grant. Queue failure rolls back the
whole approval. This reuses the existing Pulse grant validator unchanged.

Pulse plan execution invokes no model and does not resolve a provider. Its model
choice applies to its separate chat. Scheduled commands still have their own
fixed resource limits. The model selector is omitted on the execution review to
avoid implying that a different model runs the checks.

The SDK setup controls already transport these projections as dictionaries;
API 27 advertises the new setup capability. API 26 and older runners fail closed
on the new request/network profile. The extension requires API 27 for approving
Pulse setup. Remote integration is not updated in this local core milestone.

See `PIPS_LOCAL_HTTP_CHECKS.md` for the narrower HTTP guarantee.

## Approval and live-run repair — CLI 0.47.2 / extension 0.32.1

The isolated lab includes the verified upstream v0.47.2 changes (commit
`40fcec283f0dbdbb1fa35341e01094c75081f564`) alongside its existing Pips work.
Public installations, the founder's project and active session are unchanged.

Approval no longer posts a generated user prompt. The editor sends
`notify_pip_setup` with only a saved setup ID. The backend checks the current
workspace, original proposing session and accepted receipt. Native sessions
receive a controller notice at the next steering boundary; if that boundary
has closed, a controller turn follows. Real queued user prompts go first.
Controller receipts are excluded from the displayed user queue count, do not
expire unanswered questions, and are labelled as generated context during
compaction. Inline receipts do not create extra turns when history is restored.
Stopped undelivered receipts can be retried. Repeated delivery does not create
another job or run. Delegated subscription sessions explicitly report that
background setup notifications are unsupported; the approved setup stays saved.

The additive ready capability is `pips_setup_notifications: 1`. Older backends
leave a saved setup with a restart/retry message rather than reverting to a fake
user prompt. The editor and backend must be restarted together to adopt it.

Main-chat approval cards occupy one compact row with a 20px character, name,
Create/Modify/Saved state, and immediate Approve/Reject/Review controls. Review
expands the complete permissions, model, schedule and execution plan. The same
saved proposal moves to the final response instead of appearing twice. Replayed
legacy generated approval prompts are displayed as controller receipts only
when their saved receipt and owning session verify; session files are not rewritten.

`run_pip_now` receipts select run IDs, never provide trusted status. Chat cards
read the stored run, Pip and runner, poll active visible runs, and link to the
exact run. Offline and disconnected states never imply ongoing execution.
The Pips overview now uses compact character cards and a collapsed review inbox.

The founder's three original failures were not all scheduling failures: one
had an unverifiable source citation, one reached its tool-iteration budget, and
one returned prose instead of JSON. New modification proposals switched models;
they were not the original approvals reopening. Report formatting now gets one
bounded tool-free conversion attempt, then the existing JSON and citation checks
run again. This does not repair bad citations, grant more tools, increase an
iteration budget, or establish that an arbitrary model will complete an audit.

SDK protocol copies and source hashes were refreshed. The checkout signing gate
still requires the maintainer key; this local build is not a signed release.


Final local evidence is `output/pips-0472-review-evidence.json` from the lab
root (or `../../output/` relative to this document). The extension suite passed
1,464 tests; the Pips backend suite passed 1,555. After final backend edits, a
230-test pass covered image-spool wiring, notifications, history, editor controls
and open questions. The repository runner completed 1,786/1,787 outer checks:
its 4,639-test discovery suite reported the unsigned SDK manifest and one
`inspect.getsource` failure caused by disk edits after that process imported the
module. The latter passed in the final-source rerun. Do not present this as a
fully green signed release. The new notification/formatting tests use offline
fixtures and synchronization events, without sleeps or external network calls.
