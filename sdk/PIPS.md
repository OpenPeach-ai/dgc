# Pips in the SDK

SDK 0.7.0 adds `session.pips` to the Python (sync and async) and TypeScript SDKs. It
lets trusted host code read and manage the Pips of an existing DGC profile through
`dgc serve`: list workspaces and Pips, read runs and reports, review proposals,
setups and handoffs, queue runs, chat with a Pip, and review Personal app actions.

It pairs with DGC CLI 0.48.0, which advertises **Pips API 46** over editor protocol
v14. For what Pips are and how they behave, see [docs/PIPS.md](../docs/PIPS.md); for
the security model and limits, see [docs/PIPS_REFERENCE.md](../docs/PIPS_REFERENCE.md).

`session.pips` never turns Pips on, starts or resumes the runner, installs a service,
or changes a model connection. Runs and Pip chat messages still need a running local
runner, and every backend review and permission check still applies.

## Requirements

- **An inherited profile.** Open the client with `inherit_user_state=True` (Python)
  or `inheritUserState: true` (TypeScript). Default isolated SDK sessions refuse
  Pips controls: they carry a session trust policy that cannot govern an
  independent background runner.
- **No policy or sandbox.** A session with a `RuntimePolicy`, a requested sandbox
  other than `"off"`, or an active sandbox refuses every Pips control, read or
  mutation. The backend refuses them too. Nothing is silently weakened.
- **Pips enabled.** The handshake must advertise `pips_supported: true`,
  `pips_enabled: true` and an integer `pips_api_version`. Pips are on by default.
  The handshake is not a live subscription: open a new session after the enable
  flag changes.
- **Plan mode** allows reads and refuses mutations.

An inherited controller can reach every workspace of the chosen profile, not just
its own working directory, and the profile's Personal workspace. Give it only to
trusted host code. Do not expose `mutate` to a model as an unattended tool.

## Quick start

```python
from dgc_sdk import DGC

with DGC(inherit_user_state=True, sandbox="off") as dgc:
    with dgc.session(cwd="/path/to/project") as session:
        workspaces = session.pips.read("list_workspaces")
        jobs = session.pips.list(workspaces["current_workspace_id"])
        # Only after the host application has a user decision for this exact action:
        session.pips.mutate("pause_pip", {"pip_id": "pip_..."}, approved=True)
```

```typescript
import { DGC } from "@vibedgc/sdk";

const dgc = new DGC({ inheritUserState: true, sandbox: "off" });
try {
  const session = await dgc.session({ cwd: "/path/to/project" });
  const workspaces = await session.pips.read("list_workspaces", {});
  const jobs = await session.pips.list(String(workspaces.current_workspace_id));
  // Only after the host application has a user decision for this exact action:
  await session.pips.mutate("pause_pip", { pip_id: "pip_..." }, { approved: true });
  await session.close();
} finally {
  await dgc.close();
}
```

`AsyncDGC` sessions expose `AsyncPips` with the same methods; await each call.

## API

| Python (`Pips` / `AsyncPips`) | TypeScript (`Pips`) | Sends |
| --- | --- | --- |
| `read(command, params=None)` | `read(command, params)` | Any read command |
| `mutate(command, params, *, approved=False)` | `mutate(command, params, { approved })` | Any mutation command |
| `list(workspace_id)` | `list(workspaceId)` | `list_pips` |
| `get(pip_id)` | `get(pipId)` | `get_pip` |
| `runs(pip_id)` | `runs(pipId)` | `list_pip_runs` |
| `get_run(run_id)` | `getRun(runId)` | `get_pip_run` |

Python exports `Pips`, `AsyncPips`, `PipReadCommand` and `PipMutationCommand`.
TypeScript exports `Pips`, `PipReadCommand`, `PipMutationCommand`, `PipReadParams`,
`PipMutationParams`, `PipResult`, `PipJson`, `PipChatOptions` and
`PipCalendarEvent`. In TypeScript, `read` always takes a params object (use `{}`
when there are none).

Both methods return the backend's result object with its wire field names. A
model report, draft or command outcome in that result is evidence to show a
person, not proof that the code is correct or that tests passed.

### Approval

`mutate` requires the exact boolean `approved=True` (Python) or `{ approved: true }`
(TypeScript) on every call, including retries. Anything else is refused before the
request leaves the process. It authorizes that one request only and never changes
a Pip's own reviewed permissions.

Several flows have two separate decisions, and approval of one never carries over
to the other:

- saving a proposal, and accepting it;
- proposing a handoff, and accepting it;
- preparing an external action from a draft, and accepting that action.

Show the saved record to the user before asking for the second decision.

### Commands and parameters

Commands form two closed sets: 50 reads and 46 mutations, with a closed field set
for each. There is no generic passthrough. `pips_enable` and `pips_runtime` are not
exposed. Parameters are plain JSON:

- at most 32 KiB in total, 2,048 values and 12 nested levels;
- at most 128 fields per object, field names up to 128 characters, lists up to
  2,048 items;
- integers within JavaScript's safe range; no non-finite numbers, invalid Unicode
  or cycles;
- no unknown fields, no caller `request_id`, and no endpoint or credential fields.

The backend's own validation is authoritative; it also checks required fields.

### Capability gates

Each command has a minimum Pips API. The SDK refuses a command, or a parameter that
needs a newer API, before sending it. CLI 0.48.0 is API 46; Pip computers need API 42. Starter Pips (API
41) are a Pips view and CLI convenience the SDK does not wrap: a host creates the same
job with `create_pip` and a reviewed update.

| API | Commands or parameters |
| --- | --- |
| 8 | Workspaces, Pips, runs, chat, versions, approvals, checkpoints, handoffs, run activity, models, types, runner and execution status, workspace context, findings, execution reviews, `stop_pips` |
| 9 | `accept_pip_execution_context` |
| 10 | `get_pip_proposal`, `list_workspace_overviews`, `list_pending_pip_reviews`, `list_recent_workspace_activity`, `list_pip_adaptations` |
| 11 | `changes.source_policy` |
| 12 | Session statements: `list_workspace_sessions` and `*_workspace_session_outcome` |
| 13 | `list_pip_notifications`, `mark_pip_notification_read` |
| 14 | Exceptions: `get_pip_exception_source`, `list_pip_memories`, `record_pip_exception`, `revoke_pip_exception` |
| 15 | `action.specialists` on a handoff |
| 16 | `archive_pip`, `restore_pip`; `expected_lifecycle_revision` on `pause_pip` and `resume_pip` |
| 17 | Command receipts: `list_workspace_execution_receipts`, `get_workspace_execution_receipt`, `record_workspace_execution_context` |
| 18 | The `session_turn_completed` event |
| 19 | Claims and preferences: `get_pip_statement_anchor`, `list_pip_statements`, `record_pip_statement`, `revoke_pip_statement` |
| 21 | `changes.verification_plan`; the three Pulse pins on `run_pip` |
| 22 | The `committed_paths_changed` event and `commit_paths` |
| 23 | Setups: `list_pip_setups`, `get_pip_setup`, `accept_pip_setup`, `reject_pip_setup` |
| 24 | `chat_options` on `send_pip_message` |
| 25 | `revise_pip_setup`; `chat_options.context_size` above 32,768 |
| 28 | `list_pip_connections`, `inspect_pip_connection`; `changes.app_plan` |
| 29 | `list_pip_accounts` |
| 30 | `propose_pip_personal_handoff` |
| 31 | `inspect_pip_send_connection`, `get_pip_app_action`, `list_pip_app_actions`, `propose_pip_app_action`, `accept_pip_app_action`, `reject_pip_app_action` |
| 32 | Email drafts: `get_`/`list_pip_message_draft(s)`, `prepare_`/`dismiss_pip_message_draft` |
| 33 | `app_plan` version 2 (calendar-day windows) |
| 34 | `inspect_pip_calendar_connection`, `propose_pip_calendar_action` |
| 35 | Calendar drafts: `get_`/`list_pip_calendar_draft(s)`, `prepare_`/`dismiss_pip_calendar_draft` |
| 36 | `inspect_pip_connector_actions`, `propose_pip_connector_action` |
| 37 | Connector drafts: `get_`/`list_pip_connector_draft(s)`, `prepare_`/`dismiss_pip_connector_draft` |
| 38 | `attendees`, `repeat` and `send_invitations` in a calendar `event` |
| 39 | `app_plan` version 3 (Drive, Notion and Contacts searches) |
| 40 | `changes.web_plan` |
| 41 | `get_pip_digest`, `mark_pip_digest_seen`, `get_pip_notify_settings`, `set_pip_notify_settings`, `get_pip_outcomes`, `get_pips_keep_running`, `set_pips_keep_running`, `get_pips_desktop_notifications`, `set_pips_desktop_notifications`, `get_pip_usage`, `set_pip_daily_cap`, `export_pip`, `list_pip_feedback`, `set_pip_feedback`, `always_allow_pip_app_action`, `list_pip_action_grants`, `revoke_pip_action_grant`; `changes.github_plan` |
| 42 | Pip computers: `get_pip_computer`, `list_pip_computer_actions`, `get_pip_computer_frame`, `list_pip_computer_frames`, `decide_pip_computer_action`, `always_allow_pip_computer_action`, `stop_pip_computer`, `open_pip_computer`, `use_pip_computer_view`; `changes.computer_plan` |
| 43 | `introduce_pip`; `create_pip` with an empty `goal`, `pip_type` `core` and `source_ref` `HEAD` (what the editor sends) for Personal Pips; `images` and `files` on `send_pip_message`; `get_pip_message_image`; a computer's Files and Terminal (`list_pip_computer_files`, `read_pip_computer_file`, `list_pip_computer_terminal`, `add_pip_computer_file`, `remove_pip_computer_file`, `run_pip_computer_command`) |
| 44 | Personal Pips' plugins: `list_pip_plugins`, `allow_pip_plugin`, `decline_pip_plugin`, `list_pip_plugin_uses`, `list_pip_attention`; notes (`list_pip_notes`, `add_pip_note`, `forget_pip_note`), sites, `get_pip_chat_context`, `list_pip_reply_stats`, `get_pips_limit`/`set_pips_limit`, `set_pip_careful`, `forget_pip_site` |
| 45 | `set_plugin_permission`: what each plugin may do without asking (`always_ask`, `any_changes`, `important`, `never_ask`), for every Pip. A read at `important` runs without a card. |
| 46 | `shared: true` on `list_pip_notes`, `add_pip_note` and `forget_pip_note`: a Pip's notes are kept in the one memory DGC keeps for you (ids `mem_…`). |
| 47 | A Pip's `chat_options` are its own and apply to all its runs; runs have no step or time limit, reviewed specialist Patches included (specialist policy version 2); several Pips run at once |
| 48 | `mark_pip_news_seen`: one Pip's news (failed runs, new findings) dismissed until it does something new |
| 50 | The `safe_source_v2` source rules in `changes.source_policy` (with an optional `exclude` list); `check_pip_source {pip_id, source_policy?}` and `get_pip_run_source {run_id}`, local only |
| 51 | `list_pip_run_posts {pip_id, before_id?, limit?}`: what a Pip's runs posted in its own chat (`pips.run_posts()` / `pips.runPosts()`) |
| 52 | `send_pip_message`'s `spooled_images` [{name, media_type}] and `spooled_files` [{name, spool}]: photos and files through the image spool (`pips.spool(data, suffix=)` writes one and returns its name); `get_pip_message_image`'s `as_file` |
| 53 | `get_pip_eyes` (R) and `set_pip_eyes` (M, `choice` ask, relay or off): how a Personal Pip whose model reads text only sees; `list_pip_computer_frames`' `pointers`; `use_pip_computer_view`'s op `pointer`. A payment held in a Pip's browser is refused Always allow |
| 54 | `get_pip_computer_apps` (R) and `set_pip_computer_apps` (M, `choice` download or not_now): a Pip computer's image editor, document editor and PDF viewer, and the one offer to download the ones this computer lacks. Pips use the whole desktop: its steps reach the timeline and the live view as API 53's pointers. |
| 58 | How much a Personal Pip asks: `get_pip_level {pip_id}` (R: `level`, `default`, `levels` [{level, name, says}], `on_its_own` [{at, what, level, unattended, kind}]) and `set_pip_level {pip_id, level}` (M, local only; `ask`, `approve` or `full`). What a level let through is a computer action already `sent` by `pip-level:<level>` or an app action resolved by it; a payment asks at every level. |
| 57 | A Personal Pip's own working notes: `get_pip_working_notes {pip_id}` (R: `lines`, `text`, `revision`, `max_lines`, `max_bytes`, `bytes`, `updated_at`) and `set_pip_working_notes {pip_id, text, expected_revision}` (M, local only, never a secret); `list_pip_daily_log {pip_id, before?, limit?}` (R): what it did each day, `{days: [{day, lines, more}], next_before}`. The Pip keeps its notes itself with a `working_notes` tool and starts every run with them; the log is never given to a run. |

API 20 (scheduled Quill drafts) and API 26/27 (conversation continuity,
conversational Pulse setup) add no SDK command. A request to an older backend
reaches that backend and is refused there.

## Errors

| Error | When |
| --- | --- |
| `DGCConfigError` | Unknown command, a read sent as a mutation (or the reverse), missing `approved`, unknown or oversized parameters |
| `DGCUnsupportedError` | Isolated session, policy or sandbox, mutation in plan mode, Pips not supported or not enabled, API too old. It is a subclass of `DGCConfigError`. |
| `DGCCommandRejectedError` | The backend refused the request. `reason` is the backend error code and `command` the control name. |
| `DGCProtocolError` | A malformed or mismatched reply |
| `DGCTimeoutError` | The transport timed out |

The wire shape is `{type: "pips_control", request: {type, request_id, ...params}}`,
answered by `pips_result`. The SDK generates the nested `request_id`; concurrent
requests can complete in any order without sharing a reply.

A timeout or a cancelled async wait does not prove that a mutation did not commit.
The SDK never retries. Keep the original idempotency or request key, read the saved
run, proposal, handoff or action, and only then decide whether to retry the exact
same request. Expected versions, revisions and digests are compare-and-swap guards
you pass through; the SDK never computes or advances them.

## Commands by area

R = read, M = mutation. Optional fields are marked `?`.

### Workspaces and Pips

| Command | | Fields |
| --- | --- | --- |
| `list_workspaces` | R | none. Returns `workspaces`, `current_workspace_id`, `runner_id`. The Personal workspace has `kind: "personal"`. |
| `list_workspace_overviews` | R | `after_id?`, `limit?` (1–20) |
| `list_pips` | R | `workspace_id` |
| `get_pip` | R | `pip_id` |
| `list_pip_types` | R | none |
| `list_pip_models` | R | none. May contact the configured model endpoint. |
| `get_pip_runner`, `get_pip_execution` | R | none. Execution inspection may probe local confinement support. |
| `create_pip` | M | `workspace_id`, `name`, `goal`, `pip_type`, `source_ref`, `model_choice?` |
| `pause_pip`, `resume_pip` | M | `pip_id`, `expected_lifecycle_revision?` (required to resume a Pip that was ever archived) |
| `archive_pip`, `restore_pip` | M | `pip_id`, `expected_version`, `expected_lifecycle_revision`, `request_key`, `reason` |
| `stop_pips` | M | none. Emergency stop: pauses every Pip and cancels queued and running work. |

Saved logins (Pips API 56): `list_pip_logins` (R, `pip_id?`) answers `{logins: [{id, site, hosts, username,
has_code, pips, source, created_at, last_used_at, usable?}]}`, never a password or a key; `save_pip_login` (M,
`pip_id`, `username`, `password`, `totp?` (a base32 key or an `otpauth://totp/` link), `pips?` `"only"` | `"all"`,
and `site`, or `action_id` + `expected_digest` of the Pip's `login` computer action), `remove_pip_login` (M,
`login_id`) and `grant_pip_login` (M, `login_id`, `pips` `"all"` | a list of Pip ids). Both SDKs refuse them before
API 56 and check a save's shape with errors that never repeat what it carries; the password and key go in that one
request only (the SDKs keep no request log). DGC keeps them sealed on this computer and types them into the Pip's
page itself (docs/PIPS.md, Saved logins).

`model_choice` is `{"mode": "default"}` or `{"mode": "model", "model": "<id from list_pip_models>"}`, or, for a
Personal Pip from Pips API 55, `{"mode": "subscription", "engine": "claude" | "codex"}`: the user's own Claude Code
or Codex, held to DGC's Pip tools (docs/PIPS.md). Both SDKs refuse a subscription choice before API 55 and check its
shape; `list_pip_models` then also returns `subscriptions` `[{engine, name}]` and, when DGC's default is a
subscription, `default_engine` `{engine, name, available, reason?}`. A project Pip refuses it.
Archiving keeps all history and refuses while a run or review is unfinished;
restoring leaves the Pip paused. An exact retry with the same `request_key`
returns the original receipt without applying it again.

### Changing a Pip

| Command | | Fields |
| --- | --- | --- |
| `propose_pip_update` | M | `pip_id`, `expected_version`, `changes`, `reason?` |
| `get_pip_proposal` | R | `pip_id`, `proposal_id` |
| `accept_pip_update`, `reject_pip_update` | M | `pip_id`, `proposal_id`, `expected_version` |
| `list_pip_versions` | R | `pip_id`, `before_version?`, `limit?` |
| `list_pip_approvals` | R | `pip_id`, `before_id?`, `limit?` |
| `list_pending_pip_reviews` | R | `workspace_id?`, `before_id?`, `limit?` (1–20) |
| `list_pip_adaptations` | R | `pip_id`, `before_id?`, `limit?` |

`changes` may contain `name`, `goal`, `source_ref`, `model_choice`, `schedule`,
`event_trigger`, `adaptation_policy`, `source_policy`, `verification_plan`,
`app_plan`, `web_plan` and `github_plan` (project reviewers and Quill: one repository and
up to four read-only reads that DGC makes before each run with the user's GitHub login). A proposal changes nothing until it is accepted, and
accepting checks the expected version again. The shapes of each field are in
[PIPS_REFERENCE.md](../docs/PIPS_REFERENCE.md#schedules-and-event-triggers).

```python
saved = session.pips.mutate("propose_pip_update", {
    "pip_id": pip_id,
    "expected_version": job["current_version"],
    "reason": "Review committed changes to the parser",
    "changes": {"event_trigger": {
        "events": ["committed_paths_changed"],
        "minimum_minutes": 5,
        "commit_paths": [{"kind": "directory", "path": "src"},
                         {"kind": "exact", "path": "pyproject.toml"}],
    }},
}, approved=True)
# Show the saved proposal to the user. Accepting it is a separate, approved call.
```

### Setups

Setups are review cards that the main chat prepares with its `pips_setup` tool.

| Command | | Fields |
| --- | --- | --- |
| `list_pip_setups` | R | `workspace_id?` |
| `get_pip_setup` | R | `setup_id` |
| `accept_pip_setup`, `reject_pip_setup` | M | `setup_id`, `expected_digest` |
| `revise_pip_setup` | M | `setup_id`, `expected_digest`, `model_choice` |

Accepting saves the Pip exactly as shown and, if the card says so, queues one run.
Revising replaces the card with a new pending card that uses another model.

### Runs and conversations

| Command | | Fields |
| --- | --- | --- |
| `run_pip` | M | `pip_id`, `idempotency_key`, and for a standing Pulse plan all of `expected_version`, `expected_lifecycle_revision`, `expected_plan_digest` |
| `cancel_pip_run` | M | `run_id` |
| `list_pip_runs` | R | `pip_id` |
| `get_pip_run` | R | `run_id` |
| `list_pip_run_activity` | R | `run_id`, `after?` |
| `list_pip_checkpoints` | R | `pip_id`, `before_id?`, `limit?` |
| `list_pip_messages` | R | `pip_id`, `before_id?`, `limit?` |
| `send_pip_message` | M | `pip_id`, `text`, `idempotency_key`, `chat_options?`, `images?` (API 43: up to 4 image data URIs, 2 MB in all; `text` may then be empty), `files?` (API 43: up to 4 `{name, data}`, sharing the 2 MB budget with the images), `spooled_images?` (API 52: up to 64 `{name, media_type}` naming files in the image spool; 8 MB a photo, 32 MB in all; `image/heic` and `image/heif` are kept as JPEG), `spooled_files?` (API 52: up to 16 `{name, spool}`; a document 16 MB, a text or code file 1 MB, 32 MB in all) |
| `introduce_pip` | M | `pip_id`; a Personal Pip's first message, queued once (API 43) |
| `get_pip_message_image` | R | `pip_id`, `message_id`, `index`, `as_file?`; one image from a chat message as `image`, a data URI (API 43), or with `as_file: true` where its kept file is, `{path, mime, bytes}` (API 52) |

`run_pip` and `send_pip_message` need a running local runner. Queueing is not
completion: read the run until it reaches a terminal status. Reusing an
`idempotency_key` with the same content returns the original run.

Photos and files bigger than the inline 2 MB go through the runtime's image spool (API 52), as the
editor sends them. `pips.spool(data, suffix=".jpg")` (TypeScript: `await pips.spool(bytes, { suffix:
".jpg" })`) writes the bytes into `ready.capabilities.image_spool_dir` under a fresh name, readable
only by you, and returns that name; send it in `spooled_images` (with its `media_type`) or
`spooled_files` (with your file's own `name`). The runtime reads it, checks it and removes it.

```python
name = pips.spool(open("bill.jpg", "rb").read(), suffix=".jpg")
pips.mutate("send_pip_message", {"pip_id": pip_id, "text": "What do I owe?", "idempotency_key": key,
                                 "spooled_images": [{"name": name, "media_type": "image/jpeg"}]}, approved=True)
```

`chat_options` sets the Pip's context window and reasoning effort:
`{"context_size": 2048–1048576, "thinking": "off" | "low" | "medium" | "high" | "xhigh"}`.
Both fields are required when the object is present. Since Pips API 47 a message sent with
them keeps them as that Pip's own, for its replies and every run it starts on its own
(before, one reply only). It cannot change a mode, permission, model or endpoint, and it
does not change the Pip's job.

A standing Pulse plan runs only with the exact reviewed pins:

```python
session.pips.mutate("run_pip", {
    "pip_id": pip_id,
    "idempotency_key": run_key,
    "expected_version": job["current_version"],
    "expected_lifecycle_revision": job["lifecycle_revision"],
    "expected_plan_digest": job["verification_plan_digest"],
}, approved=True)
```

### Findings, execution results and workspace context

| Command | | Fields |
| --- | --- | --- |
| `review_pip_finding` | M | `run_id`, `finding_index`, `status` (`accepted`, `dismissed`, `open`), `expected_revision`, `reason` |
| `review_pip_execution` | M | `run_id`, `status`, `expected_revision`, `reason` |
| `get_workspace_context` | R | `workspace_id` |
| `record_workspace_context` | M | `workspace_id`, `kind`, `title`, `content`, `expected_revision` |
| `archive_workspace_context` | M | `workspace_id`, `entry_id`, `expected_revision` |
| `accept_pip_finding` | M | `workspace_id`, `run_id`, `finding_index`, `expected_revision` |
| `accept_pip_execution_context` | M | `workspace_id`, `run_id`, `expected_revision`, `expected_review_revision` |
| `list_workspace_activity` | R | `workspace_id`, `after?` |
| `list_recent_workspace_activity` | R | `workspace_id?`, `before_seq?`, `limit?` (up to 50) |

Context `kind` is one of `decision`, `milestone`, `command`, `risk`, `exception`.
Accepting a finding records a person's choice to keep a model assessment for
reference; it does not make the finding true. `list_workspace_activity` reads
forward from a cursor; use `list_recent_workspace_activity` for the newest events.

### Handoffs

| Command | | Fields |
| --- | --- | --- |
| `propose_pip_handoff` | M | `source_run_id`, `finding_index`, `target_pip_id`, `task`, `action`, `idempotency_key` |
| `propose_pip_artifact_handoff` | M | `source_run_id`, `target_pip_id`, `task`, `action`, `idempotency_key` |
| `propose_pip_personal_handoff` | M | `source_run_id`, `target_pip_id`, `shared_text`, `task`, `idempotency_key` |
| `get_pip_handoff` | R | `handoff_id` |
| `list_pip_handoffs` | R | `pip_id`, `before_id?`, `limit?` |
| `accept_pip_handoff` | M | `handoff_id`, `expected_revision` |
| `reject_pip_handoff` | M | `handoff_id`, `expected_revision`, `reason` |

`action` is an exact JSON action, never a shell command: `{"kind": "read_only"}`,
a Patch action with `write_paths` and up to four `tests`, or a Pulse action with
one to four `tests`, each `{"argv": [...], "cwd": "."}`. A Patch action may also
carry `specialists: {"roles": [...], "max_calls": 1–3}`. Accepting a handoff
queues one run and needs a running runner. `shared_text` must be an exact excerpt
(up to 12,000 bytes) of a completed Personal result.

### Pip memory

| Command | | Fields |
| --- | --- | --- |
| `get_pip_exception_source` | R | `pip_id`, `run_id`, `finding_index` |
| `record_pip_exception` | M | `pip_id`, `run_id`, `finding_index`, `expected_source_digest`, `reason`, `request_key`, `expires_at?` |
| `revoke_pip_exception` | M | `pip_id`, `memory_id`, `expected_revision`, `reason` |
| `list_pip_memories` | R | `pip_id`, `before_id?`, `limit?` (1–20) |
| `get_pip_statement_anchor` | R | `pip_id`, `source_run_id?` |
| `record_pip_statement` | M | `pip_id`, `kind` (`fact` or `preference`), `title`, `statement`, `reason`, `expires_at`, `expected_anchor_digest`, `request_key`, `source_run_id?` |
| `revoke_pip_statement` | M | `pip_id`, `memory_id`, `expected_revision`, `reason` |
| `list_pip_statements` | R | `pip_id`, `before_id?`, `limit?` (1–20) |

`record_pip_statement` requires `expires_at`: `null` or a timestamp with a time zone
(for `record_pip_exception` it is optional). Show a `fact` as
a **recorded claim**, never as a verified fact; preferences are advisory. Neither
hides findings, changes a job or grants permissions.

### Sessions and command receipts

| Command | | Fields |
| --- | --- | --- |
| `list_workspace_sessions` | R | `workspace_id`, `after?`, `limit?` |
| `inspect_workspace_session_outcome` | R | `workspace_id`, `session_id` |
| `propose_workspace_session_outcome` | M | `workspace_id`, `session_id`, `title`, `statement`, `source`, `expected_session_revision`, `request_key` |
| `get_workspace_session_outcome` | R | `workspace_id`, `proposal_id` |
| `list_workspace_session_outcomes` | R | `workspace_id`, `before_id?`, `limit?` |
| `accept_workspace_session_outcome` | M | `workspace_id`, `proposal_id`, `expected_digest`, `expected_context_revision` |
| `reject_workspace_session_outcome` | M | `workspace_id`, `proposal_id`, `expected_digest` |
| `list_workspace_execution_receipts` | R | `workspace_id`, `session_id?`, `before_id?`, `limit?` |
| `get_workspace_execution_receipt` | R | `workspace_id`, `attempt_id` |
| `record_workspace_execution_context` | M | `workspace_id`, `attempt_id`, `expected_attempt_digest`, `expected_final_digest`, `expected_view_digest`, `expected_context_revision` |

`source` is `{"kind": "commit", "revision": "<full commit>"}` or
`{"kind": "pip_run", "run_id": "<completed run>"}`. A session statement is the
user's own statement and is stored as not execution-verified. A recorded command
receipt is a process outcome, not proof that tests ran or passed.

### Notifications

| Command | | Fields |
| --- | --- | --- |
| `list_pip_notifications` | R | `workspace_id?`, `before_seq?`, `limit?` (1–20) |
| `mark_pip_notification_read` | M | `notification_id`, `expected_revision` (0 or 1), `workspace_id?` |

Notifications are references to a review or a failed run. Marking one read
approves, rejects or starts nothing. Open the referenced record before acting.

### Digest, notification settings and outcomes (API 41)

| Command | | Fields |
| --- | --- | --- |
| `get_pip_digest` | R | none |
| `mark_pip_digest_seen` | M | `until` (the digest's own `until`) |
| `mark_pip_news_seen` | M | `pip_ids` (1–50), `until` (the digest's own `until`); API 48 |
| `get_pip_notify_settings` | R | `pip_id` |
| `set_pip_notify_settings` | M | `pip_id`, `min_severity`, `alert_severity` (or null), `expected_revision` |
| `get_pip_outcomes` | R | `pip_id` |
| `get_pips_keep_running` | R | none |
| `set_pips_keep_running` | M | `enabled` (bool) |
| `get_pips_desktop_notifications` | R | none |
| `set_pips_desktop_notifications` | M | `enabled` (bool) |
| `get_pip_usage` | R | `pip_id` |
| `export_pip` | R | `pip_id`; returns a shareable `dgc-pip` file (no accounts, IDs, memory or history) |
| `set_pip_daily_cap` | M | `pip_id`, `daily_tokens`: only null since 2026-10-14 (Pips have no daily limit; a number is refused) |
| `list_pip_feedback` | R | `pip_id`; the newest 20 ratings |
| `always_allow_pip_app_action` | M | `action_id`, `expected_digest`; runs it and lets its Pip run the same kind without asking |
| `list_pip_action_grants` | R | `pip_id`; what the Pip runs without asking |
| `revoke_pip_action_grant` | M | `pip_id`, `grant_id` |
| `set_pip_feedback` | M | `run_id`, `rating` (`"up"`, `"down"` or null), `note` (500 characters at most) |

The digest is what the Pips bar and `dgc pips digest` show: what the profile's Pips did
since the user last looked, and whether it is due. Marking it seen hides it for the user
everywhere, so a host should do that only when the user has seen it. Notification
settings are display preferences outside the reviewed job; changing them grants nothing.

### Pip computers (API 42)

| Command | | Fields |
| --- | --- | --- |
| `get_pip_computer` | R | `pip_id` |
| `list_pip_computer_actions` | R | `pip_id`, `limit?` (1–50) |
| `get_pip_computer_frame` | R | `run_id`, `frame` (`0001.jpg` style) |
| `list_pip_computer_frames` | R | `run_id`, `pointers?` (API 53: each step by position also has `pointer {kind, x, y, from_x?, from_y?}`) |
| `get_pip_computer_apps` | R | no fields; a Pip computer's apps: `{apps: {apps: [{key, name, program, available}], missing, state, line, bytes}}` (API 54) |
| `set_pip_computer_apps` | M | `choice` download or not_now: answers the one offer to download the apps this computer lacks; returns the same as `get_pip_computer_apps` (API 54) |
| `get_pip_eyes` | R | `pip_id`; how a Personal Pip sees: `{eyes: {pip_id, model, sees, choice, vision_model}}` (API 53) |
| `set_pip_eyes` | M | `pip_id`, `choice` (`ask`: it asks in its chat when it needs to see; `relay`: a model that sees looks for it; `off`); returns `{eyes}` (API 53) |
| `decide_pip_computer_action` | M | `action_id`, `expected_digest`, `approve` (bool) |
| `always_allow_pip_computer_action` | M | `action_id`, `expected_digest`; sends it and lets its Pip send the same submit (method, site, path) without asking |
| `stop_pip_computer` | M | `pip_id` |
| `open_pip_computer` | M | `pip_id` |
| `use_pip_computer_view` | M | `pip_id`, `op` (`frame`, `click`, `type`, `key`, `scroll`, `go`, `back`; `pointer` from API 53: where the Pip last acted by position, no frame), `x?`, `y?`, `text?`, `key?`, `dy?`, `url?` |
| `list_pip_computer_files` | R | `pip_id`, `path?`; the computer's own Files folder (API 43) |
| `read_pip_computer_file` | R | `pip_id`, `path`; `text` (first 64 KiB), or `data` up to 2 MB (API 43) |
| `list_pip_computer_terminal` | R | `pip_id`; the last 200 commands and the one running (API 43) |
| `get_pip_computer_desktop` | R | `pip_id`; whether the full screen can show here, which browser, what to install (API 43) |
| `add_pip_computer_file` | M | `pip_id`, `path?`, `name`, `data` (one data URI, 2 MB at most; outside the 32 KiB budget) (API 43) |
| `remove_pip_computer_file` | M | `pip_id`, `path` (API 43) |
| `run_pip_computer_command` | M | `pip_id`, `command`; starts it in the computer's Terminal (no internet) and returns at once (API 43) |

A Personal Pip's computer is its own sandboxed browser (Linux only for now). It reads public
websites freely; anything it would submit is held as a pending action until the user decides.
Approving one sends that exact request once, so show the user the action's `summary` and
screenshot first and pass its `digest` as `expected_digest`. `use_pip_computer_view` drives
the Pip's browser as the user: while no run is using the computer, what it submits is sent
at once. That is why it is a mutation, even for `op: "frame"`. Give a Pip a computer with
`changes.computer_plan: {schema_version: 1}` on a reviewed update. See
[docs/PIPS.md](../docs/PIPS.md#a-computer-of-its-own-linux).

### Personal Pips: connections, reads and external actions

Find the Personal workspace in `list_workspaces` (`kind: "personal"`) and use its
ID with `list_pips` and `create_pip`.

| Command | | Fields |
| --- | --- | --- |
| `list_pip_connections` | R | none |
| `inspect_pip_connection` | R | `server`. Reads tool schemas only, never mail or events. |
| `list_pip_accounts` | R | `server`. Lists connected account identities only. |
| `inspect_pip_send_connection` | R | `server` |
| `inspect_pip_calendar_connection` | R | `server` |
| `inspect_pip_connector_actions` | R | `server` |
| `propose_pip_app_action` | M | `source_run_id`, `server`, `connection_digest`, `account`, `schema_digest`, `message`, `request_key` |
| `propose_pip_calendar_action` | M | `source_run_id`, `server`, `connection_digest`, `account`, `schema_digest`, `event`, `request_key` |
| `propose_pip_connector_action` | M | `source_run_id`, `server`, `connection_digest`, `schema_digest`, `call`, `request_key` |
| `get_pip_app_action` | R | `action_id` |
| `list_pip_app_actions` | R | `pip_id`, `before_id?`, `limit?` (1–20) |
| `accept_pip_app_action`, `reject_pip_app_action` | M | `action_id`, `expected_digest` |
| `get_pip_message_draft`, `get_pip_calendar_draft`, `get_pip_connector_draft` | R | `draft_id` |
| `list_pip_message_drafts`, `list_pip_calendar_drafts`, `list_pip_connector_drafts` | R | `pip_id`, `before_id?`, `limit?` (1–20) |
| `prepare_pip_message_draft` | M | `draft_id`, `expected_digest`, `server`, `connection_digest`, `account`, `schema_digest`, `message` |
| `prepare_pip_calendar_draft` | M | `draft_id`, `expected_digest`, `server`, `connection_digest`, `account`, `schema_digest`, `event` |
| `prepare_pip_connector_draft` | M | `draft_id`, `expected_digest`, `call?` |
| `dismiss_pip_message_draft`, `dismiss_pip_calendar_draft`, `dismiss_pip_connector_draft` | M | `draft_id`, `expected_digest` |

Never invent an account ID or a digest: take them from the inspection and account
reads of the same connection, and let the user choose the account. Nothing is
selected for them, not even a default account.

Payload shapes:

- `message`: exactly `recipient_email`, `subject` (up to 200 bytes) and `body`
  (plain text, up to 12,000 bytes). One recipient, no CC, BCC, HTML or attachments.
- `event`: `summary`, `description`, `start_datetime`, `end_datetime` (with seconds
  and an explicit UTC offset that matches the zone) and `timezone` (IANA). To add
  guests or a series, include all three of `attendees` (up to ten exact emails),
  `repeat` (`null` or `{"frequency": "daily" | "weekly" | "monthly", "interval": 1–12, "count": 2–52}`)
  and `send_invitations` (true exactly when there are guests). The start must
  still be in the future when the action runs; the duration is at most seven days.
- `call`: `{"tool": "<tool name from inspect_pip_connector_actions>", "arguments": {...}}`
  on a saved `zapier`, `arcade`, `make` or `n8n` connection. There is no `account`
  field: the connector manages its own accounts.

Proposing or preparing only saves a pending review, which expires after 24 hours.
`accept_pip_app_action` with the saved digest makes exactly one attempt. Repeating
it observes that attempt and never retries it. Read the receipt carefully:

- A Gmail `succeeded` means the provider accepted the message, not that it was
  delivered.
- A calendar `succeeded` means the provider confirmed creation; invitation
  delivery and acceptance are not confirmed.
- A connector `succeeded` means the connector returned a response, not that the
  downstream work completed.
- `dispatching` or `unknown` means the outcome is unconfirmed. Check the provider
  before preparing another action.

App and web reads are granted through `propose_pip_update` with `changes.app_plan`
or `changes.web_plan`, and only take effect after acceptance:

```json
{"web_plan": {"schema_version": 1, "reads": [
  {"kind": "page", "url": "https://example.com/timetable"},
  {"kind": "search", "query": "library opening hours"}
]}}
```

An `app_plan` names one connection and one to four exact read calls:
`{"schema_version": 1 | 2 | 3, "server", "connection_digest", "calls": [{"tool", "schema_digest", "arguments", "account"?, "window"?}]}`.
See [PIPS_REFERENCE.md](../docs/PIPS_REFERENCE.md#personal-pips) for the supported
tools, their fixed arguments and the calendar-day window.

`propose_pip_personal_handoff` shares an exact excerpt of one completed Personal
result with another Personal Pip. Saving the proposal is not accepting it.

```python
proposal = session.pips.mutate("propose_pip_personal_handoff", {
    "source_run_id": source_run_id,
    "target_pip_id": target_pip_id,
    "shared_text": reviewed_excerpt,
    "task": "Turn this plan into a checklist.",
    "idempotency_key": "checklist-1",
}, approved=True)
```

Personal results are `get_pip_run` results with `run_kind: "personal_task"` and the
document in `result.text`. The SDK writes no files; the host decides where to show
or save them.

## Parameters that pin a review

The SDK passes these through unchanged. Read them from the record the user saw.

| Field | Used by |
| --- | --- |
| `idempotency_key` | `run_pip`, `send_pip_message`, `propose_pip_handoff`, `propose_pip_artifact_handoff`, `propose_pip_personal_handoff` |
| `request_key` | `propose_pip_app_action`, `propose_pip_calendar_action`, `propose_pip_connector_action`, `record_pip_exception`, `record_pip_statement`, `archive_pip`, `restore_pip`, `propose_workspace_session_outcome` |
| `expected_version` | `propose_pip_update`, `accept_pip_update`, `reject_pip_update`, `archive_pip`, `restore_pip`, `run_pip` |
| `expected_lifecycle_revision` | `archive_pip`, `restore_pip`, `pause_pip`, `resume_pip`, `run_pip` |
| `expected_revision` | Finding and execution reviews, context records, handoff accept/reject, memory revocation, notification read |
| `expected_digest` | Setup accept/reject/revise, draft prepare/dismiss, action accept/reject, session statement accept/reject |
| `expected_plan_digest` | `run_pip` for a standing Pulse plan |
| `expected_anchor_digest`, `expected_source_digest` | `record_pip_statement`, `record_pip_exception` |
| `expected_session_revision`, `expected_context_revision` | Session statements and command receipts |
| `connection_digest`, `schema_digest` | External actions and draft preparation |

A conflict comes back as `DGCCommandRejectedError`. Start a fresh review rather
than substituting current values.

## Permission names

The SDK's permission tables include the main chat's Pips tools: `UsePips`,
`PipsContext`, `PipsSetup`, `PipsPropose`, `PipsAdapt`, `PipsRun`, `PipsHandoff`,
`PipsEmailDraft`, `PipsCalendarDraft`, `PipsConnectorDraft`, `PipsPause`,
`PipsResume` and `PipsAttach`. These govern the agent's tools inside a session.
They do not make a policy-bound SDK session eligible to use `session.pips`.
