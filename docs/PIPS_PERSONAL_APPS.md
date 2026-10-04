# Personal Pips and shared connections — local build, 2026-10-03

This work is in the isolated `dgc-pips-lab-20261001` checkout. It is not a public
release. The approved website snapshot and plush artwork remain preserved. The active
website preview is being extended under the subsequent overnight goal. Remote
work is tracked separately from the first CLI/extension release. Final SDK signing remains with the release agent.

## Implemented

- A profile has one **Personal** workspace, owned by the local registry, at
  `<DGC_HOME>/.dgc/pips/personal`. It is distinct from the current project and
  remains available when the editor changes directory. Different DGC profiles
  do not share it. Symlink substitution and rebinding are refused.
- Extension scope picker, personal creation, conversations, setup reviews,
  schedules and Results. Personal job views do not offer project handoffs or
  source-policy changes. Existing project Pips retain their project boundaries.
- Main-chat `pips_setup` accepts `scope: personal`, `work_kind: personal_task`.
  The originating chat must still be a registered local session. `target_root`
  is that chat's actual directory; only the controller chooses the private root.
  A saved proposal changes nothing until its exact digest is reviewed.
- `pips_context` accepts explicit `scope: personal` for list, definition and
  paginated report reads. Scope is not silently inferred from whichever
  directory happens to be open.
- Existing DGC settings supply connector configuration and credentials. No
  second Composio login, credential store or connector configuration file.
  Metadata discovery uses `pips_context` actions `connections` and `connection`.
- Per-Pip `app_plan` pins the saved connection digest, read-tool schema digest,
  exact arguments and, for Composio's generic executor, a stable connected-account
  ID. Only `GMAIL_FETCH_EMAILS` and `GOOGLECALENDAR_FIND_EVENT` are supported.
  Generic execution, account management, sending and remote compute cannot be
  granted to the model. The controller builds the generic execution envelope.
- Limits: four reviewed reads, 20 items per read, 8 KiB reviewed plan, 32 KiB
  aggregate accepted response, and a 30-second MCP cancellation deadline inside
  the run's overall deadline. These response limits are acceptance limits, not
  a claim that the MCP transport allocates at most 32 KiB.
- Every run checks current job/version, state and saved connector configuration
  before reads, between reads and before handing results to inference. Removing
  a connection, disabling Pips, changing the job, or withdrawing the grant refuses
  further consumption. A request already sent to a provider cannot be recalled.
- The worker receives bounded, redacted, untrusted reference text, not connector
  credentials or an MCP process. Its private source directory is empty. Personal
  workers use an explicit deny-all process policy and no external-action tools;
  fabricated file/command calls are refused, including parallel batches.
- Results are saved in the private run ledger, survive reopening and appear in
  the extension's Results tab. Copy result and CLI report work. Existing private
  JSONL evidence export now supports personal results and refuses overwrites.
  No result is automatically published on localhost or written into a project.
- The job page exposes the current app-read plan and a reviewed removal flow.
  Removing a grant does not delete results that were already saved.
- Personal controls remain local. Paired Remote access does not automatically
  inherit this new scope.

## Local usage

Use the existing clean lab launch, not the public checkout. Restart the lab
backend / F5 extension so it advertises Pips API 37.

In the extension, open Pips and choose **Personal · this computer**. Describe a
job to DGC, or choose a character yourself. The main chat prepares the review;
accepting a manual-only setup does not start a run. The existing runner must be
running to answer messages or process scheduled work.

CLI examples (with the lab wrapper):

```sh
DGC_PIPS_LAB_PROFILE=clean-review ../dgc-core-review pips list --personal
DGC_PIPS_LAB_PROFILE=clean-review ../dgc-core-review pips create 'Day planner' --personal --goal 'Help organize my day from details I share'
DGC_PIPS_LAB_PROFILE=clean-review ../dgc-core-review pips setup list --personal
DGC_PIPS_LAB_PROFILE=clean-review ../dgc-core-review pips connections
DGC_PIPS_LAB_PROFILE=clean-review ../dgc-core-review pips inspect-connection composio
```

`inspect-connection` connects only for public tool-schema discovery; it does not
read email or events. Do not invent the account ID or any digest in a setup plan.
Fixed calendar dates remain fixed. API 33 adds a separately reviewed calendar-day
window in an explicit timezone; see below. Live provider testing is still pending.

## Verification and limits

Verification: the 106-module Pips regression run passed **1,608 tests**. The
focused extension suite passed **282 tests**. Two additional scope tests passed
after that regression run. The final personal/app-specific suite passed **37
tests**. TypeScript compilation and `git diff --check` also passed.

Tests use offline provider/tool fixtures. The end-to-end app-read test runs the
real controller, subprocess worker entry, isolated configuration, process policy,
Agent loop and result persistence; only provider and connector responses are
replaced. It does not prove that a live Google account or Composio account works.
New tests use no `time.sleep()` and do not contact external services.

The real VS Code extension was opened with a separate `personal-review` profile.
Personal selection, the chat composer, review loading and accepting a manual
setup were exercised against the actual backend. That profile has no live app
connections and a working model endpoint copied through Config.set solely for this isolated test. It does not replace the
user's clean-review profile. Captures are in
`output/playwright/personal-pips-20261003/`.

Live Gmail/Calendar testing is explicitly **pending at the user's request**.
Earlier inspection fetched public Composio tool schemas only; it did not fetch
messages or calendar events. No live readiness claim is made.

Original eight-item backlog (status updated by the overnight continuation below):

1. **Implemented; live-provider verification pending:** an explicit connected-account
   picker using the documented Composio search contract. Offline tests cover
   stable IDs, cancellation, unsupported endpoints and the separate saved review.
2. **Personal conversation implemented and exercised:** an inert setup draft is returned
   to the controller and saved as an existing durable human review. Actual extension
   checks used the configured DeepSeek model. Project conversations still use main-chat setup.
3. **Implemented and verified:** explicit Personal main-chat run/lifecycle controls.
   See the continuation notes and real-extension evidence below.
4. **Implemented and exercised in CLI/extension:** reviewed Personal result excerpts
   shared through the existing durable handoff ledger. Separate Personal payloads
   cannot acquire project execution authority. See API 30 below.
5. **Implemented and verified:** Markdown document opening/native Save As in the
   extension and private CLI Markdown export; JSONL evidence remains available.
6. **Partially implemented:** conversational email drafts and separately reviewed,
   account-specific Gmail sends (APIs 31–32), plus single calendar events with a
   separate exact review (API 34), and conversational calendar drafts (API 35). Live provider verification is pending.
   Dedicated invitation, recurrence, purchase and booking flows remain unfinished.
   API 36 can invoke a configured connector tool after a separate human review,
   but does not verify domain-specific completion or grant unattended execution.
7. **Partially implemented:** API 36 adds exact human-reviewed tool calls on saved
   Zapier, Arcade, Make and n8n connectors. API 37 adds conversational drafts
   in main and own-Pip chat. Broader scoped unattended reads, browser capabilities and Remote access remain. Main DGC's existing connections do not imply
   that these are safe or supported for unattended personal Pips.
8. **Implemented and visually checked:** alpha-backed plush artwork and SVG eye
   expressions in the extension, including clipped Lens eyes. Light/dark rendering
   was inspected; exhaustive visual coverage of every character/state is pending.

Do not label this a completed launch handoff. The source is ready for continued
local testing of this foundation, with the outstanding items above explicit.


## Overnight continuation: controls, documents and SDK

Main chat now supports explicit `scope: personal` on `run_pip_now`, `pause_pip`,
`resume_pip` and `attach_pip_to_session`. Project requests retain their original
canonical envelopes. Personal run pins separately record the originating chat's
project and the private target workspace. Both identities and the local binding
are checked before queuing and inside the final queue transaction. Personal Patch
and Pulse characters still run text-only personal jobs: their role names never
confer command or source access. Attaching a personal Pip saves only a reference.

Saved personal results now have **Open Markdown** and **Save Markdown…** actions
in the extension. The host fetches the run itself; the webview cannot supply file
contents or destination paths. Markdown opens as text, not an HTML/image-loading
preview. Save As uses the editor's own dialog. CLI document export is:

```sh
dgc pips export-run <run-id> --format markdown --output /absolute/new/result.md
```

This reuses the evidence export's authorization, redaction, bounded validation,
private permissions and exclusive publication. Existing files and symlinks are
refused. It supports completed personal results and Quill drafts. Ordinary
`export-run` still defaults to JSONL evidence.

Python and TypeScript SDKs now expose `list_pip_connections` and
`inspect_pip_connection`, gated on Pips API 28. App-plan changes also require that
capability. Approved controller sessions use existing `list_workspaces` to locate
`kind: personal`, then normal Pip create/list/run/chat/review methods with that
workspace's ID. This does not enable Pips, start the runner, approve a proposal,
or grant connected-account reads implicitly.

Focused verification: 67 personal/run/lifecycle tests; 124 export/SDK Python tests;
56 TypeScript SDK tests; 244 editor tests. Actual extension testing also completed
a personal conversation on `deepseek-v4.1-flash:cloud`, with no apps configured in
the isolated personal-review profile. This is model execution evidence, not a live
mail/calendar verification. Further overnight work and evidence are tracked in
`../../OVERNIGHT_PERSONAL_PIPS.md` at the lab root.

## Own-personal-chat setup and task continuity

Personal conversations can prepare one `draft_pip_change` candidate per successful
reply. Its closed fields are name, goal, schedule and model choice. The worker
cannot choose a target Pip, actor, proposal ID, approval state or permissions. It
has no database mutation capability. After validating the reply, the controller
saves a proposal and its originating-run event in the same transaction. Settings
change only through the existing human accept/reject flow. Cancelled replies
publish nothing; stale job/lifecycle revisions do not rebase a draft. Locked
adaptation policies cannot propose changes. App grants are preserved unchanged.

The Pip chat shows a compact Review/Dismiss row. The full review displays the
exact proposed goal, schedule and model before acceptance. This is not an
additional automatic scheduling path, and accepting a manual-only change does
not start work. Project Pip conversation drafting remains a separate follow-up.

Standalone personal runs now pin a bounded snapshot of that Pip's successful
conversation and existing rolling brief. They can use shared preferences while
retaining the approved job as their task; historical text does not grant tools
or external actions. Other Pips' conversations are not included. The next reply
also accepts a bounded, explicitly model-authored personal result reference.
This fixes a real-extension failure in which a completed personal task prevented
the user from sending a subsequent chat message.

## API 29: explicit connected-account selection

A Personal Pip's **Job → Connected apps → Choose a connected account…** action
reuses a connection already configured in DGC Settings. It lists the active Gmail
and Google Calendar account identities returned by Composio's documented search
contract. Nothing is selected automatically, including an account marked default.
Choose one account, a bounded item count and a query. Calendar reads additionally
require an exact start/end date range in the displayed local time zone. These
absolute dates do not advance with recurring runs. API 33 adds relative calendar-day windows below.

**Prepare review** saves a job-change proposal. Only accepting that saved proposal
grants the exact reads. This replaces, rather than silently extends, an existing
app plan. App content still follows the Pip's selected model. A changed connection,
missing stable account ID, malformed response or unsupported search contract is
refused. Older endpoints can return no usable identities; the UI explains that
without guessing an account or opening another authentication flow. Cancelling
closes the dialog and ignores a late read response; it does not grant access.

The local controller and CLI expose `list_pip_accounts` and
`dgc pips accounts <saved-connection-name>`. Python/TypeScript SDKs gate this read
on Pips API 29. Discovery calls only `COMPOSIO_SEARCH_TOOLS`, never connection
management or email/calendar tools. Provider suggestions and raw user-info fields
are not forwarded. Identity discovery has a 30-second deadline, at most 64 account
records and a 256-KiB response acceptance limit; this is not an allocation guarantee
for the underlying MCP transport.

Verification uses documented public schemas and deterministic offline fixtures,
including cancellation, stale identity/schema rejection and an explicit choice
before proposal creation. **Live connected-account verification remains pending
at the user's request.** The isolated real-extension profile has no connected
accounts; its empty state can be checked without touching the user's connections.

## API 30: reviewed Personal result handoffs

Open a saved successful Personal result and choose **Share with another Pip…**.
Choose another Personal Pip, keep or select an exact excerpt (at most 12,000 UTF-8
bytes), and describe its follow-up task. Saving creates a pending review. Approval
queues one run through the existing durable handoff ledger; retries cannot create
another run. The review shows the excerpt, recipient model, job versions and the
recipient's existing app-read plan. It expires after seven days.

Only the selected excerpt is shared. The source's chat history, app permissions,
credentials, source files and model settings do not follow it. A target uses its
own approved job and app reads; Patch/Pulse characters in Personal scope still
receive no file or command tools. Personal-to-project and self-handoffs are
refused. Target/source changes invalidate stale reviews. Queued dispatch rechecks
both jobs, lifecycle state, the saved result digest, target model connection and
app plan before reads and again before model dispatch. Source text is explicitly
untrusted reference data. This authorizes one task, not autonomous recursive chains.

CLI example (all IDs must come from local saved records):

```sh
dgc pips handoff propose-personal <source-run-id> <target-pip-id> \
  --shared-text 'An exact excerpt of the saved result.' \
  --task 'Turn this plan into a checklist.' --idempotency-key checklist-1
dgc pips handoff review <handoff-id>
dgc pips handoff accept <handoff-id> --expected-revision 0
```

Local CLI/extension controls support this flow. Existing Remote project access
cannot inspect or approve Personal handoffs. Proposals and results remain local;
no live app tests or sends are implied by this implementation.

The main model can also save this review with `handoff_to_pip`:
`source_kind: personal_result`, explicit `scope: personal`, `source_run_id`,
`target_pip_id`, exact `shared_text`, `task`, and `request_key`. Personal requests
must omit `action` and `finding_index`. The normal tool permission authorizes
only saving a proposal. The controller checks the owning local chat and Personal
workspace before reading private records and rechecks that association inside
the proposal transaction. Selecting another directory never implicitly grants
Personal access. Existing project handoff envelopes retain their original scope.
Human approval in Pips or the CLI is still required; no recursive chains start.

Real-extension and CLI handoff checks completed on `deepseek-v4.1-flash:cloud`: each recipient preserved the selected walking/reading durations, saved its own result, and recorded zero tool calls, zero project files and no external actions. No connected apps were configured for these checks. Screenshots and exact run IDs are in the isolated lab evidence tracker.

## Separately reviewed Gmail messages (local API 31)

A completed Personal task or conversation reply can be the source of a separately saved email
review. In the extension, open its result and choose **Prepare email**. Choose an
existing Composio connection and an explicit active Gmail account, enter one
recipient, a subject and plain-text body, then **Save for review**. The next screen
shows the complete immutable message. Only **Send once** authorizes a send.
**Cancel** leaves the saved review pending; **Reject message** resolves it without
sending. Job → **Message reviews** retains pending reviews and attempt receipts.
There is no standing send permission, scheduler send, automatic retry or worker
credential access. Preparing a result or approving app reads never authorizes mail.

The controller supports only the documented `GMAIL_SEND_EMAIL` envelope through
an account-specific `COMPOSIO_MULTI_EXECUTE_TOOL` route. It validates the executor
and input schemas, pins their digest and the saved connection, then checks them
again at approval. Missing or ambiguous account/schema support refuses the flow.
No HTML, attachments, CC, BCC, arbitrary tool calls, calendar writes, purchases or
bookings are supported. The account ID remains visible because display labels are
not proof of account identity. Body limit is 12,000 UTF-8 bytes; subject 200;
recipient 254. Reviews expire after 24 hours and pin the source result, job version
and lifecycle revision. Pausing/changing the job, stopping all Pips or revoking the
connection prevents a new attempt. Pending unexpired reviews block archival.

Before contacting Gmail, the controller commits `dispatching` to the local
SQLite ledger. Concurrent approvals or a retry of the same action only observe
that attempt. Provider acceptance records **Accepted by Gmail**, not delivery.
A timeout, malformed response or crash after the claim leaves **Delivery
unconfirmed** and cannot be retried. Inspect Gmail Sent / the Composio execution
log before preparing a separate message; a separate proposal can otherwise create
a duplicate. This is at-most-one *local call attempt*, not an end-to-end exactly-once
provider guarantee. This follows Composio's warning that a timeout can occur after
Gmail accepted a message: https://docs.composio.dev/kb/guide/toolkits-gmail .

The CLI has `dgc pips app-action inspect|propose|show|list|accept|reject`. Prefer
`propose RUN --message-file message.json --server NAME --connection-digest HASH
--account ca_ID --schema-digest HASH --request-key KEY` to keep the body out of shell
history. The JSON has exactly `recipient_email`, `subject`, `body`. Acceptance
requires the saved `--expected-digest`; unattended acceptance additionally requires
`--yes`. The CLI displays the saved review first. All six controls are local only;
Remote/model-worker actors are refused. Models can prepare inert email drafts through the API 32 flow below. Choosing an
account and saving the final send review remain separate human controls.

Registry schema 26 adds an immutable, retained action ledger with one-way status
transitions. New deterministic offline checks cover concurrent approvals, crashes,
provider uncertainty, schema/connection changes, source revocation, expiry,
rejection, hostile headers, migration rollback, CLI confirmation, SDK capability
gates and UI cancellation/duplicate clicks. These prove the implemented contract
against offline provider fixtures. Live Gmail account testing remains pending by
user choice; no real send or provider compatibility claim is implied.


## Conversational email drafts (local API 32)

Ask a Personal Pip to draft an email, including the recipient. Its `draft_email`
tool prepares one plain-text draft per successful conversation reply. The saved
reply includes an **Email draft → Review** row. A cancelled, failed or stale-job
reply never commits a new draft. The draft itself has no account or send permission.

Main DGC can also use `draft_pip_email` with explicit Personal scope, a completed
Personal source run, the exact message and a retry key. Its normal tool permission
allows saving the draft only. The slim main-chat link fetches the authoritative
record and opens the owning Personal Pip, including from a project chat.

Review the draft, choose a connected Gmail account, edit the recipient/subject/body
if needed, then save the final review. **Send once** remains a separate decision.
Preparing the same draft twice returns the same saved review, even from different
local controllers. Dismissed drafts cannot prepare an action. Drafts expire in
24 hours and pin the source result, job and lifecycle. Historical drafts remain
visible under Job → Email drafts. No scheduler can send these messages.

CLI: `dgc pips email-draft list|show|prepare|dismiss`. Preparation requires
`--expected-digest`, `--server`, `--connection-digest`, `--account` and
`--schema-digest`. It defaults to the exact saved message; `--message-file` provides
an edited message without putting its body in shell history. This command only
saves a review. The separate `app-action accept` flow above authorizes one attempt.

Registry schema 27 adds a retained immutable draft ledger. Offline tests cover
transaction rollback, concurrent preparation, stale replies, session binding,
CLI digest checks, SDK gating and late UI replies. The real isolated extension
also saved and displayed a draft using `deepseek-v4.1-flash:cloud`, with a reserved
`.invalid` recipient and no connected account or send action. This is evidence of
draft creation and review only; live Gmail/Calendar tests remain pending.


## Recurring calendar reads (local API 33)

Choose **Move with each run** in the calendar account picker. Review the IANA
timezone, start day (0 = today, up to 30), length (1–31 calendar days), account,
calendar, search query and item limit. The resulting app plan is version 2; a
saved proposal and separate approval are still required. This grants calendar
reads only, never event creation, updates or deletion. Version 1 fixed dates
remain unchanged.

The controller samples its clock once as it begins the app-read phase. Every
relative window in that run resolves from that same instant in its reviewed
timezone, starting at midnight and ending at the following midnight after the
selected days. A late/coalesced run uses the actual read day, not the original
scheduled day. DST days may span 23 or 25 hours. Ambiguous midnight uses the first
occurrence; a nonexistent midnight or unavailable timezone fails before any app
connection is opened. The runner uses its installed IANA timezone data and never
downloads it or substitutes the machine's timezone silently.

The plan is immutable during execution. Exact UTC bounds are included with the
untrusted calendar reference and retained in the `pip_run_calendar_windows`
activity event, without calendar contents. No model receives credentials or a
way to expand the query or time window. Account-bearing plans require a route
that enforces the account; direct routes that would ignore it are refused.

Offline validation covers local date changes, DST, leap days/year rollover,
missing/hostile zones, nonexistent dates, whole-plan validation before reads,
account routing, reviewed updates, SDK/host version gates and legacy plans.
Live account testing remains pending. API 33 does not add calendar writes,
purchases, bookings, unrestricted workflows or Remote support.


## API 34: one reviewed calendar event

A completed Personal task result now offers **Prepare calendar event…**. Choose
an existing Composio connection and explicitly select a connected Google Calendar
account. Enter the title, description, exact start/end times including UTC offsets,
and IANA time zone. Saving creates an immutable review; a separate **Create once**
decision authorizes the provider call. This does not grant the Pip calendar-write
permission or allow unattended event creation. API 35 also accepts inert calendar drafts from Personal conversation replies and
main chat; the direct API 34 flow starts from a completed Personal task result.

The adapter creates one private, busy event in the selected account's primary
calendar, without guests, recurrence, notification emails or a Meet link. Existing
calendar reminders, sharing and administrator policies can still apply. Titles
are limited to 200 UTF-8 bytes, descriptions to 8,000 bytes, and duration to seven
days. Explicit offsets must match the named time zone at both endpoints. If the
start passes before approval, the review remains pending and no request is sent;
prepare a new event rather than silently moving it.

The durable action ledger is claimed before the provider call. Duplicate approval
observes that same attempt. A crash, timeout or mismatched receipt never triggers
an automatic retry. Check the calendar or Composio execution log before preparing
another event after an uncertain outcome. Job/lifecycle changes, connection
revocation, stale schemas and Remote/model actors retain the existing refusals.
Descriptions are HTML-escaped for the provider; the exact plain text remains in
review. No new runtime dependency or second credential store was introduced.

CLI: `dgc pips app-action inspect SERVER --kind calendar_create`, then
`app-action propose RUN --kind calendar_create --event-file /absolute/event.json`
with the discovered server, connection/schema digests, explicit account and retry
key. `app-action show`, `accept --expected-digest` and `reject` use the existing
ledger. Accept displays the exact action; noninteractive hosts need explicit
`--yes` after review. See `sdk/PIPS.md` for the closed event shape.

Registry schema 28 prevents older runtimes from interpreting the new version-2
action payloads. Restart all processes sharing this lab profile after migration;
older readers refuse the newer registry. Existing Gmail review rows remain intact.

Verification distinguishes three different claims: deterministic provider fixtures
exercise prepare/create, one-attempt concurrency, rejection during discovery,
invalid dates/DST/offsets, schema drift, unknown outcomes and old-reader refusal;
real Composio metadata confirms the current input schema only; the actual VS Code
extension confirms the Results entry and honest no-connection state. No live
Google event was created and no mail or calendar contents were read. Live account
testing remains pending by user choice. Current metadata uses string
`send_updates: "none"` and defaults Meet creation on, so the adapter explicitly
sets `create_meeting_room: false`. Older documentation's boolean notification
contract is refused. Evidence lives in the lab's calendar-action logs and screenshots.


## API 35: conversational calendar drafts

Personal Pip chat can use `draft_calendar_event` to prepare one event per reply.
Main chat has `draft_pip_calendar_event`, anchored to a completed Personal Pip
result or reply and its owning local session. Both require exact start/end dates,
UTC offsets and an IANA time zone. Missing details should be asked for, not guessed.
Neither tool selects an account, reads a calendar, grants access, creates an event,
or authorizes scheduling. Ordinary main-chat permission rules still apply; child,
monitor, plan and restricted execution cannot use the main draft tool.

Only a successful Personal conversation commits its draft. Cancelled/failed replies
save nothing; changed job/lifecycle pins suppress stale drafts. A saved draft is
immutable and lasts 24 hours. Editing happens before preparing its external-action
review. Separate `caldraft_` identities and a private calendar-draft ledger keep
email and calendar history distinct while sharing the review implementation.

In the extension a slim **Calendar draft · Review** row opens the exact saved
content. **Choose calendar account** opens the existing connection/account flow;
the editable form is prefilled from the saved draft. **Save for review** produces
an immutable API 34 action, and only the later **Create once** decision attempts
creation. Closing or dismissing a draft does nothing externally. Reopening an
already prepared draft opens its existing action instead of creating another.
The main-chat tool row links to the authoritative Personal draft across projects;
tool output cannot substitute text or bypass saved identity checks.

CLI adds `dgc pips calendar-draft list PIP`, `show DRAFT`, `dismiss DRAFT
--expected-digest DIGEST`, and `prepare DRAFT` with its digest, server, connection
fingerprint, explicit account and schema fingerprint. An optional `--event-file`
or `--event-json` supplies edited content; otherwise the exact saved event is
used. Preparation never calls accept. Both SDKs expose the same controls on API35.
Registry schema29 adds the retained calendar-draft table; existing email/action
rows are preserved, and old readers must be restarted on a compatible runtime.
No network, authentication or new dependencies are needed to create a draft.


The API35 local visual check used `deepseek-v4.1-flash:cloud` in the actual
VS Code extension: an own-chat draft and a separate main-chat draft both saved,
and the main-chat link opened the authoritative Personal review. Both remained
pending with no linked action; the external-action ledger stayed empty. The CLI
listed both and the Python SDK read them via the real NDJSON backend without
changing configuration. Screenshots: `conversational-calendar-review-real.png`,
`conversational-calendar-row-real.png`, `main-calendar-draft-row-real.png`, and
`main-calendar-opened-review-real.png`, under the existing local screenshot folder.
The account picker honestly showed no configured connection in this test profile.
The populated account/edit/prepare/create path is tested with offline fixtures,
not represented as a live Google test. Main chat initially asked for a task report
on a conversation reply, recovered through Personal listing, then saved correctly;
the refusal now explains that draft tools verify completed reply IDs themselves.

## API 36: reviewed calls on saved connectors

Personal results can now prepare one exact call through an existing Zapier,
Arcade, Make or n8n connection. Configure the connection once in DGC Settings.
In a completed Personal result, choose **Use a connected tool**, select the
connection, inspect its tool descriptions and enter the exact input object.
**Save for review** records an immutable pending action. **Run once** is a
separate human decision; rejecting or cancelling never invokes the tool.

The CLI and both SDKs expose the same inspect/propose/get/accept/reject sequence.
This increment is an advanced, manual tool-input flow. Conversational drafting
and ordinary form fields for these broader connector actions remain to be built;
it is not yet the finished basic-user setup experience.

These calls differ from the bounded Composio reads:

- No tool becomes a recurring read grant, including tools annotated read-only.
- The saved review binds the Personal result, job/lifecycle revision, saved
  connection configuration, exact tool descriptor digest and exact input object.
  Removed connections, changed descriptors and changed source jobs refuse dispatch.
- Account selection, hidden field defaults and workflow implementation remain
  provider-managed. A tool schema fingerprint cannot detect an edited workflow
  with the same schema. Check the provider's account/workflow configuration before
  approving; this feature does not promise an immutable remote workflow version.
- Only the local human controller can propose or accept these reviews. The worker
  gets no connector credentials, dynamic executor or approval authority. No implicit provisioning or tool calls happen during DGC's inspection.
  Interactive authorization requests are cancelled; finish sign-in in Settings.
- The durable ledger consumes one attempt before invocation. Timeout, crash,
  cancellation after dispatch and ambiguous responses are not retried. A remote
  workflow may continue after DGC's deadline. Check the provider log before
  proposing another action.
- A bounded response is retained as a digest and a 1 KiB text preview. The UI says
  **Response received**, not that downstream work completed. Error text is not
  retained. Configured credentials in metadata or responses are refused.

Registry schema 30 preserves existing rows and excludes older readers that do
not understand connector-call payloads. The wire capability is Pips API 36.
No new runtime dependencies. Remote review/dispatch remains excluded.

### Provider evidence and limits (checked October 4, 2026)

[Zapier's tool documentation](https://docs.zapier.com/mcp/overview/how-tools-work)
now describes agentic and managed modes. The former exposes discovery and
execution meta-tools; the latter exposes preselected dedicated tools. DGC lists
what this saved server actually advertises. It does not automatically enable
apps, choose a default connection, or infer read authority from a tool name.

[Arcade's client setup](https://docs.arcade.dev/en/get-started/quickstarts/call-tool-client)
uses a gateway containing selected tools; downstream service authorization can
still be required. Complete that setup in the existing connector flow before
using the Pip review. An authorization request is not proof an action completed.

[Make's MCP overview](https://developers.make.com/mcp-server) says a timed-out
scenario may continue running. Its [OAuth setup](https://developers.make.com/mcp-server/connect-using-oauth)
selects an organization and scopes. DGC reuses those choices and never turns a
single Pip action review into a broader organization grant.

[n8n's MCP setup](https://docs.n8n.io/connect/connect-to-n8n-mcp-server)
distinguishes exposed workflows from workflow search, and published execution
from manual execution. Review the exact workflow ID and mode in the inputs.
DGC cannot freeze the remote workflow's implementation through its MCP schema.

Offline tests cover all four saved-connection configurations and the shared
review/dispatch boundary. They are contract tests, not proof of real provider
execution. Live connector account testing is still pending by the user's choice.

### API 36 verification

The final isolated core regression passed **2,067 tests across 134 modules**;
the full editor suite passed **1,526 tests**. Both SDKs' API gates and explicit
approval controls passed. The real Python SDK connected to the NDJSON backend at
API 36, returned the actual empty connector list and refused an unconfigured Make
connection without changing the profile's config.

In the real VS Code development host, a fresh Personal run using
`deepseek-v4.1-flash:cloud` completed at job version 2. Its new connector-action
entry opened the honest no-connection state. No provider account was contacted
and no external-action ledger entry was created. This validates the local flow,
not live provider execution. Screenshots and logs are retained in the isolated
lab's `personal-pips-build-20261003` evidence directory and
`output/playwright/personal-pips-20261003`.

## Connector input forms (API 36 UI continuation)

The extension now builds ordinary labelled fields from the selected connector
tool's declared input schema. Text, numbers, choices, Yes/No inputs, nullable
values, nested objects and simple lists are supported. Optional inputs are
omitted until explicitly supplied; schema defaults are not silently inserted.
Each tool keeps its own draft while switching, and a failed save preserves the
inputs. Editing an already attempted save creates a new idempotency key.

Complex schemas (including references, unions and executable patterns) retain
an explicitly labelled Advanced JSON editor. No schema reference is fetched,
no vendor markup is rendered, and this form is not a full JSON Schema validator.
The connector still owns its schema validation and account defaults. Inputs are
limited to 10,000 UTF-8 bytes and unsafe/nonfinite numeric values are refused.
The saved review presents values as labelled rows, with the original JSON under
a disclosure. Saving still does not run anything; Run once remains separate.

These forms originally shipped against API 36. API 37 below adds conversational
drafting and prefills those same controls from the saved draft. Live provider
verification remains pending.

## API 37: conversational connector preparation

The main model and a Personal Pip's own chat can now prepare a connector action
for review. The parent discovers only the tool descriptors of enabled, supported
Zapier, Arcade, Make and n8n connections. Before each new Personal conversation,
metadata discovery has a shared 30-second cooperative deadline and a 16-KiB
snapshot cap. There is no metadata cache yet. An unavailable/oversized connection
is reported as unavailable; ordinary conversation can continue without its tools.
No external app data is read by this discovery. The worker gets only the bounded
snapshot, and `list_connector_tools` reads that snapshot without network access.

`draft_connector_action` accepts one discovered server/tool and exact arguments.
Only a successful, still-current reply commits an inert draft. In main chat,
`draft_pip_connector_action` requires explicit Personal scope, the completed source
and actual discovered fingerprints; a new draft rechecks the live descriptor.
Retries return the same saved identity without reconnecting. Model tools cannot
approve the draft, select new credentials or execute it.

The slim draft row opens saved inputs. **Edit and prepare review** rechecks the
saved descriptor and prefills the ordinary input form. **Save for review** creates
a separate exact action. Only **Run once** attempts it. Changes to connection or
tool metadata refuse preparation rather than silently rebasing the proposal.
Drafts are also available under Job and through CLI/SDK API 37. Cross-project main
chat links fetch the saved draft before switching to the registered Personal scope.

This closes conversational drafting for the four existing exact-call adapters.
It does not add unattended reads, browser capabilities, dedicated booking/payment
completion verification, or live provider-account evidence. Those broader goal
items remain pending. Provider-managed accounts and workflow behavior retain the
limitations described for API 36.

### API 37 verification

The final 135-module Pips/workspace/headless/SDK sweep passed 2,082 tests in
250.266 seconds. Focused editor/input/receipt tests passed 295 tests, plus one
connector-specific cross-project navigation test. Extension compilation, SDK
TypeScript build and generated protocol checks passed. Historical-schema fixtures
were corrected to remove the new additive table when constructing older schemas;
production migration logic was not weakened.

Actual isolated VS Code with `deepseek-v4.1-flash:cloud` completed two replies
against the clean profile's empty connector snapshot. No external action or
connector draft was created. The model correctly identified missing tools; its
first answer invented a manual pinning step, so the instructions now explicitly
explain automatic refresh on each reply. The follow-up corrected that step but
still repeated generic account/workspace authorization wording. Provider-specific
onboarding prose needs further grounding. This is not live provider verification.

## API 38: reviewed guests and finite calendar series

The main conversation and a Personal Pip's own conversation share the same
calendar draft schema. The original five fields remain supported. Guest/repeat
requests add **all three** fields below; partial options are refused:

```json
{
  "attendees": ["friend@example.invalid"],
  "repeat": {"frequency": "weekly", "interval": 1, "count": 4},
  "send_invitations": true
}
```

`repeat: null` means one event. Frequencies are `daily`, `weekly`, `monthly`,
interval 1–12, count 2–52 including the first occurrence. No raw/unbounded RRULE,
exclusions, all-day events, resource attendees or meeting links in this adapter.
Up to ten distinct exact email addresses; invitations must explicitly be true
with guests and false without guests. Missing addresses or repeat count must be
asked for, never inferred from app/reference content.

The extension draft and final review show guests, repetition, time zone and
invitation effects. The form has an explicit invitation checkbox. Save for review
still only prepares an action. **Create series and invite once**, **Create and
invite once**, or **Create series once** makes the scope clear. CLI prints the
same immutable payload before its separate confirmation; `--yes` still requires
its exact saved digest. No recurring DGC execution permission is created.

Composio receives one primary-calendar creation, with `send_updates: all` only
for the reviewed guest list, one finite RRULE, private/busy defaults, no Meet,
and guest invite/modify/guest-list visibility switches off. Private does not hide
the event from invited people; calendar sharing/admin policies still apply.
Google expands repeats in the named time zone. Invalid dates/local times can be
skipped, so a monthly event on the 31st is not promised in every calendar month.
See [Google's event contract](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert),
[recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents)
and [RFC 5545 section 3.3.10](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10).

The action is claimed before the call, with existing source/account/config/schema
pins and 24-hour review expiry. A positive receipt must match exact start/end,
summary, guests, recurrence and series time zone. Only the explicit self organizer
may be an extra guest in the response. Altered/missing/truncated details or an
ambiguous failure consume the attempt as **unknown**. There is no automatic retry.
Confirmation means event creation, never invitation delivery or attendee acceptance.
Provider-normalized RRULEs with extra clauses remain unconfirmed rather than being
loosely interpreted. Live provider compatibility is still pending the user's test
account authorization; offline fixtures are not evidence of live delivery.

Extended actions use payload schema 4; old five-field actions remain schema 2.
Registry schema 32 refuses old readers, including old draft renderers. Python and
TypeScript SDKs and the extension bridge require API 38 for extended preparation.
TypeScript exports `PipCalendarEvent`; Python retains bounded JSON parameters.
The command envelope is unchanged. Final SDK manifest signing stays with the
release agent. Broader reads/browser/booking/payment and the remaining main-chat
verification are still separate unfinished items in the full goal.

Revoking Pip access stops future DGC attempts. It does not remove an event/series
already created or retract an invitation. Change or cancel those in Calendar;
this milestone does not add a reviewed update/delete adapter. A provider event
can outlive DGC, its session and its Pip.

### API 38 verification

The selected 132-module Pips/workspace/headless/SDK regression suite passed
2,076 tests in 251.731 seconds. Focused editor/receipt checks passed 282 tests;
13 calendar checks include invitation consent, failed-save preservation, changed
idempotency keys and old-runtime refusal. Nine TypeScript API gate tests passed.
Build/typecheck and generated protocol checks passed.

Actual isolated VS Code with DeepSeek v4.1 Flash Cloud saved a four-week invitation
draft, displayed all fields, and reopened it unchanged after reload. CLI and the
real Python SDK read the same pending draft; API 38 was advertised, configuration
bytes stayed unchanged, and the external-action ledger remained empty. The clean
profile has no connected account, so preparation correctly requests Composio.
This verifies real model drafting/local persistence/UI, not live event creation.
Screenshots and exact evidence are in the lab handoff evidence directory.
