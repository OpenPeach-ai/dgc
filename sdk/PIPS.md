# Pips in the SDK

SDK 0.7.0 adds `session.pips` to the Python (sync and async) and TypeScript SDKs. It
lets trusted host code read and manage the Pips of an existing DGC profile through
`dgc serve`: list workspaces and Pips, read runs and reports, review proposals,
setups and handoffs, queue runs, chat with a Pip, and review Personal app actions. From Pips API 61 it also
gives your own app's tools to Personal Pips ([Your own app's tools](#your-own-apps-tools-api-61)), from API 62
your app can show and decide their changes ([Approvals in your app](#approvals-in-your-app-api-62)), and from API 63
your app's own events start Pips' routines ([Events from your app](#events-from-your-app-api-63)).

It pairs with DGC CLI 0.48.0, which advertises **Pips API 63** over editor protocol
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
- **Plan mode** allows reads and refuses mutations, and your app's events (`trigger`).

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
| `trigger(app, event, payload=None, *, idempotency_key)` | `trigger(app, event, payload, { idempotencyKey })` | `trigger_app_event` (API 63; no `approved`) |
| `events(app, *, limit=None)` | `events(app, { limit })` | `list_app_events` (API 63) |

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
a Pip's own reviewed permissions. Your app's events (`pips.trigger`, API 63) are the one exception: they only run
routines a person already added, so they take no `approved` ([Events from your app](#events-from-your-app-api-63)).

Several flows have two separate decisions, and approval of one never carries over
to the other:

- saving a proposal, and accepting it;
- proposing a handoff, and accepting it;
- preparing an external action from a draft, and accepting that action.

Show the saved record to the user before asking for the second decision.

### Commands and parameters

Commands form closed sets: 94 reads, 101 mutations and one event (`trigger_app_event`, your app's event,
API 63), with a closed field set for each. There is no generic passthrough. `pips_enable` and `pips_runtime` are not
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
needs a newer API, before sending it. CLI 0.48.0 is API 63; Pip computers need API 42. Starter Pips (API
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
| 59 | Borrowing your own signed-in Chrome, with your consent each time: `list_pip_borrows {pip_id}` (R: `{pip_id, minutes, borrows}`, each card's `status` requested, allowed, declined, replaced, in_use, returned or expired, its `sites`, `why`, whether your Chrome is `reachable`, and `ended`), `allow_pip_borrow`, `decline_pip_borrow` and `stop_pip_borrow` (M, each `{pip_id, borrow_id}`, local only). Allow once lets only the one turn it starts use your Chrome, on the card's sites, in a tab of DGC's own; there is no Always allow. |
| 60 | A live-data Pip: `changes.live_plan` on `propose_pip_update`, `{schema_version: 1, commands: [...]}` with one to six distinct read-only command lines (or `null` to remove them). Both SDKs refuse it before API 60 and check its shape; the backend refuses a line that writes (`write_command`) or holds a password (`secret_detected`). Its runs (`run_kind` `live`) start with `run_pip` and no Pulse pins; `get_pip_run`'s `result.live` has each line's `status`, `exit_code` and `output`, and the `summary` (`summary_by` `model` or `dgc`) with `attention`. Its run posts have `kind` `live` and `outcome` `live_clear` or `live_attention`. |
| 61 | Your own app's tools ([below](#your-own-apps-tools-api-61)): `register_app`, `update_app`, `accept_app_update`, `remove_app` and `rotate_app_secret` (M) and `list_apps` (R), all local only; an `app_plan` on `app:<name>`. Both SDKs refuse them before API 61 and check a name, an address and each tool before anything is sent. `define_pip_tool` / `definePipTool` and `AppToolHandler` need no runtime. |
| 62 | Approvals in your app ([below](#approvals-in-your-app-api-62)): `list_app_approvals` (R) and `decide_app_approval` (M), local only; `pips.pending()` and `pips.decide()` in both SDKs, refused before API 62 and checked before anything is sent. `AppToolHandler`'s approval callbacks need no runtime. `get_pip_app_action` of an app action carries `app_deliveries`. |
| 63 | Events from your app ([below](#events-from-your-app-api-63)): `trigger_app_event` (an event, sent with `pips.trigger()`: no `approved`, refused in plan mode) and `list_app_events` (R), local only; a routine's trigger `{kind: "app", app, event}` in `add_pip_routine` and `update_pip_routine`; `app_events` on `list_pip_routines`. Both SDKs refuse them before API 63 and check the app, the event's name, the idempotency key and the payload (32 KB of JSON, sent outside the 32 KiB request budget) before anything is sent. |
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
`app_plan`, `web_plan`, `github_plan` (project reviewers and Quill: one repository and
up to four read-only reads that DGC makes before each run with the user's GitHub login) and
`live_plan` (a project Pulse, API 60: the exact read-only command lines DGC runs each time, for a
live-data Pip; see [PIPS.md](../docs/PIPS.md#a-pip-for-live-data)). A proposal changes nothing until it is accepted, and
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

### Your own app's tools (API 61)

A developer whose own app (a shop, an ERP, a SaaS backend) uses this SDK can give its tools to the profile's Personal
Pips. Each tool has a name, a description, a JSON schema in the SDK's schema subset (no `$ref`) and a kind: **read**
(a Pip uses it freely in its runs, at every level, or as an exact read you approve before each run) or **change** (a
proposal the user accepts once, or always allows for that Pip). A change that pays, refunds or transfers is marked
`moves_money`: it asks every time and never gets Always allow. Every Personal Pip of the profile may use a
registered app, as every plugin turned on in DGC is every Pip's.

```python
import os
from dgc_sdk import DGC, define_pip_tool

unpaid = define_pip_tool("find_unpaid_orders", "Orders unpaid after N days",
                         {"type": "object", "properties": {"days": {"type": "integer"}}, "required": ["days"]},
                         kind="read")
dispatch = define_pip_tool("create_dispatch", "Create a dispatch for one order",
                           {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]},
                           kind="change")

with DGC(inherit_user_state=True, sandbox="off") as dgc, dgc.session(cwd=".") as s:
    app = s.pips.register_app("shop", url="https://shop.example.com/dgc/pips", tools=[unpaid, dispatch], approved=True)
    secret = app["secret"]          # shown this once: give it to the app
```

```typescript
import { DGC, definePipTool } from "@vibedgc/sdk";

const unpaid = definePipTool("find_unpaid_orders", "Orders unpaid after N days",
  { type: "object", properties: { days: { type: "integer" } }, required: ["days"] }, "read");
const app = await session.pips.registerApp("shop", { url: "https://shop.example.com/dgc/pips", tools: [unpaid] },
  { approved: true });
```

| Command | | Fields |
| --- | --- | --- |
| `register_app` | M | `name` (1 to 40 of `a-z`, `0-9`, `-`), `url` (`https://`, or `http://` only for `localhost` or `127.0.0.1`), `tools` (1 to 32: `{name, description, input_schema, kind, moves_money?}`, 30 KB together). Answers `{app, secret, notice}`. |
| `update_app` | M | `name`, `tools`, `url?`. Removing tools applies at once (`applied: true`); a new tool, a changed one or a new address widens what Pips may do, so it waits as the app's `pending` update (`applied: false`). |
| `accept_app_update` | M | `name`, `expected_digest` (the pending update's `digest`) |
| `list_apps` | R | none. Each app: `name`, `server` (`app:<name>`), `display_name`, `url`, `connection_digest`, `summary` ("2 read tools, 1 change tool"), `reads`, `changes`, `tools` (each with its `kind`, `moves_money` and `schema_digest`), `pending`. Never the secret. |
| `remove_app` | M | `name`. Its secret is forgotten too. |
| `rotate_app_secret` | M | `name`. Answers a new `secret`, shown that once; the old one stops working. |

Python's `Pips` has `register_app(name, *, url, tools, approved)`, `update_app(name, *, tools, url=None, approved)`,
`accept_app_update(name, expected_digest, *, approved)` and `list_apps()` (awaitable on `AsyncPips`); TypeScript's has
`registerApp`, `updateApp`, `acceptAppUpdate` and `listApps`. `tools` takes `define_pip_tool` / `definePipTool`
values, or the same shape as plain objects.

**The secret** is 32 random bytes (`dgcapp_` and 64 hex digits). DGC keeps its copy where it keeps a plugin's key
(the system keychain, or a file only you can read), never in the Pips state, a note, a log, a Pip's prompt or a run
record. Keep yours as you keep any API key, such as in an environment variable.

**The connection.** The app is `app:<name>` in `list_pip_connections`, `inspect_pip_connection` (every tool, with its
`kind` and `schema_digest`) and `inspect_pip_connector_actions` (its change tools). Its `connection_digest` covers
its name and address; a tool's `schema_digest` covers its whole definition. A review, a plan or an Always allow made
for an earlier tool or address stops matching.

- A read in a Pip's reviewed job: `changes.app_plan` `{"schema_version": 1, "server": "app:shop",
  "connection_digest", "calls": [{"tool", "schema_digest", "arguments"}]}`, one to four reads, each checked against
  the app as it is now when it is proposed and when it runs.
- A change: `propose_pip_connector_action` with `server: "app:shop"`, the tool's `schema_digest` and `call: {tool,
  arguments}`, or the connector draft a Pip's run leaves (`prepare_pip_connector_draft`); then
  `accept_pip_app_action` (or `always_allow_pip_app_action`) with its digest. One attempt, never retried.

**Serving the calls.** DGC POSTs each call to the app's `url`:

```json
{"type": "tool_call", "app": "shop", "tool": "create_dispatch", "arguments": {"order_id": "ord_17"},
 "pip_id": "pip_…", "run_id": "run_…", "call_id": "call_…", "action_id": "appaction_…", "action_digest": "…"}
```

`action_id` and `action_digest` come only with a change, the action the user accepted. The headers are
`X-DGC-Timestamp` (Unix seconds), `X-DGC-Nonce` (32 hex digits) and `X-DGC-Signature`: `v1=` and the hex
HMAC-SHA256, keyed by the secret's text, of `<timestamp>.<nonce>.` followed by the body's bytes. DGC waits 15
seconds for a read and 30 for a change, reads at most 256 KB, checks TLS, never follows a redirect and uses no proxy
for this computer. The app answers JSON: `{"ok": true, "result": …}`, or `{"ok": false, "error": {"code",
"message"}}`, whose message the Pip is told ("the shop app said: …"). What the app answers is data to the Pip,
never instructions.

`AppToolHandler` does all of this in your app. It checks the signature, refuses a timestamp more than five minutes off
and a nonce it has seen (kept in memory, bounded), checks the arguments against the tool's schema, runs a change only
for a call that carries an accepted action, and answers for you. A tool function is `fn(args, ctx)`: `ctx` has `app`,
`tool`, `kind`, `pip_id`, `run_id`, `call_id` and, for a change, `action_id` and `action_digest` (`approval_id` is
`action_id`). Return any JSON value; raise `PipToolError("…")` to refuse in your own words. Any other error answers
"The tool failed." and stays in your app's log.

```python
from dgc_sdk.pips_app import AppToolHandler, PipToolError

handler = AppToolHandler(os.environ["DGC_PIPS_SECRET"], tools={
    unpaid: lambda args, ctx: db.unpaid(args["days"]),
    dispatch: lambda args, ctx: shipping.create(args["order_id"], receipt=ctx.approval_id),
})

@app.post("/dgc/pips")                      # Flask
def pips():
    return handler.flask(request)

# FastAPI or Starlette: app.mount("/dgc/pips", handler.asgi). Any WSGI server: handler.wsgi.
# Anything else: status, headers, body = handler.handle(request_headers, raw_body)
```

```typescript
import { AppToolHandler } from "@vibedgc/sdk";

const handler = new AppToolHandler(process.env.DGC_PIPS_SECRET!, {
  find_unpaid_orders: (args) => db.unpaid(args.days as number),
}, { definitions: [unpaid] });
app.post("/dgc/pips", express.raw({ type: "application/json" }), handler.express());   // Express
// A web Request: return handler.fetch(request). Anything else: await handler.handle({ headers, body }).
```

Python keys `tools` by each tool's `define_pip_tool` value (or by name, with those values in `definitions=`);
TypeScript keys them by name, with the `definePipTool` values in `{ definitions }`. Python imports Flask only in
`flask()`; `wsgi`, `asgi` and `handle` need no framework. An async tool needs `asgi` (or `handle_async`). In Express,
mount the handler before any JSON body parser (or with `express.raw`), so it reads the bytes DGC signed.

### Approvals in your app (API 62)

When a Pip's change on your app waits for a person, your app hears about it at the same address, so its own admin
screen can show it and decide it. DGC's Allow card shows it too. Whichever answers first wins, once: the other side
sees what was decided, and the change is never called twice.

What waits for a person: a change a Pip proposed in its run that still asks after the run (its Always allow and its
level had their say first), or a review proposed with `propose_pip_connector_action`. A change marked `moves_money`
always asks a person, at every level, and never gets Always allow.

DGC POSTs two kinds of event, signed exactly as tool calls are (the same headers and HMAC):

```json
{"type": "approval_requested", "app": "shop", "action_id": "appaction_…", "action_digest": "…",
 "tool": "create_dispatch", "arguments": {"order_id": "ord_17"}, "pip_id": "pip_…", "pip_name": "Payment chaser",
 "run_id": "run_…", "summary": "Payment chaser asks to run create_dispatch (order_id ord_17) in Shop app.",
 "expires_at": "2026-10-25T09:00:00.000Z", "moves_money": false}
```

```json
{"type": "approval_resolved", "app": "shop", "action_id": "appaction_…", "tool": "create_dispatch",
 "decision": "accepted", "by": "app", "at": "2026-10-24T09:05:00.000Z"}
```

`decision` is `accepted`, `rejected` or `expired`. `by` is `dgc` (DGC's own card, the CLI, or the 24-hour expiry),
`app` (your app, through `decide`), `always_allow` (the Pip's Always allow) or `level` (the Pip's level, Approve for
me or Full access). An Always allow-ed change was never waiting, so it has no `approval_requested`, only its
`approval_resolved`: your audit sees it either way. An accepted change then arrives as its own `tool_call`, carrying
the same `action_id`.

**Delivery.** The Pips runner sends events (it looks every couple of seconds): a first try, then up to three more 5 s,
30 s and 2 minutes after a failure. An HTTP 4xx other than 408 and 429, a redirect or a certificate DGC can't check
is not tried again. Any 2xx is delivered. Every try is recorded on the action: `app_deliveries` in
`get_pip_app_action`, `deliveries` in `pending()` and `decide()`. A request for something decided before DGC could
send it is skipped; your app hears only how it was decided. A failed delivery never blocks or rejects the change:
DGC's card still shows it. Treat a repeat of the same `action_id` and `type` as one event.

**Showing them.** Give `AppToolHandler` the callbacks; each gets the event once its signature, time and nonce check
out. With no callback the handler answers 204, so an app that doesn't care loses nothing.

```python
from dgc_sdk.pips_app import AppToolHandler

waiting = {}
handler = AppToolHandler(os.environ["DGC_PIPS_SECRET"], tools={unpaid: find_unpaid, dispatch: create_dispatch},
                         on_approval_requested=lambda e: waiting.__setitem__(e.action_id, e),
                         on_approval_resolved=lambda e: waiting.pop(e.action_id, None))
```

```typescript
const handler = new AppToolHandler(process.env.DGC_PIPS_SECRET!, tools, { definitions,
  onApprovalRequested: (e) => waiting.set(e.actionId, e), onApprovalResolved: (e) => waiting.delete(e.actionId) });
```

Python's events are `PipApprovalRequested` and `PipApprovalResolved` (fields as on the wire); TypeScript's have the
same fields in camelCase (`actionId`, `actionDigest`, `pipName`, `expiresAt`, `movesMoney`). A callback that raises
answers 500, and DGC tries again. An async callback needs `asgi` (or `handle_async`) in Python.

**Deciding.** A person on your admin screen decides; your app passes it on:

```python
s.pips.decide(event.action_id, "accept", expected_digest=event.action_digest, approved=True)
# what waits now, with digests (one app's with app="shop"):
for approval in s.pips.pending()["approvals"]:
    print(approval["summary"], approval["action_digest"])
```

```typescript
await session.pips.decide(event.actionId, "reject", event.actionDigest, { approved: true });
const { approvals } = await session.pips.pending("shop");
```

| Command | | Fields |
| --- | --- | --- |
| `list_app_approvals` | R | `app?` (one app's). Answers `{approvals}`, oldest first: each `action_id`, `action_digest`, `app`, `tool`, `arguments`, `pip_id`, `pip_name`, `run_id`, `summary`, `created_at`, `expires_at`, `moves_money`, `status`, `decision`, `by`, `decided_at`, `receipt`, `deliveries`. |
| `decide_app_approval` | M | `action_id`, `decision` (`accept` or `reject`), `expected_digest` (its `action_digest`). Answers `{approval, decided}`. |

`decide` is `accept_pip_app_action` / `reject_pip_app_action` decided by your app: its `by` is `app`. An accepted
change is called once, at your address, before `decide` returns (your web server must answer other requests
meanwhile, as Flask's own server does). Exactly once: an approval already decided, by your app or in DGC, answers
`decided: false` with what was decided, and nothing runs again. A wrong `expected_digest` is refused
(`action_conflict`). Your app decides as you, on this computer: call `decide` from a person's choice on your screen,
never from code alone, above all for a change that moves money.

On DGC's side the card and your app decide one thing. Allow takes the same approval; Edit withdraws it (your app hears
`rejected`, by `dgc`) and runs the edited change under a new `action_id`; Don't rejects it. When your app decides
first, the card settles with one line: "Shop app accepted create_dispatch".

### Events from your app (API 63)

Your app's own events can start a Personal Pip's routine: "when the shop sends `order.created`, check the order and
propose a dispatch". A person adds the routine once; then your app tells DGC each time it happens.

**The routine.** A routine's `trigger` may be `{"kind": "app", "app": "shop", "event": "order.created"}` (`{"app":
"shop", "event": "order.created"}` is read the same way). An event's name is 1 to 64 lowercase letters, digits, dots,
hyphens or underscores, and the app must be registered with `register_app`. It is added like any routine: in the Pip's
Settings, Routines, **When my app sends an event** (choose the app, then type the event or pick one it sent lately);
from the Pip's chat, where its suggestion waits for the user's **Add routine**; or with `add_pip_routine` (approved).
Its list says it in words: "When the shop app sends order.created". `list_pip_routines` lists such routines only with
`app_events: true`, because an older editor refuses a "when" it doesn't know.

**Sending an event.**

```python
answer = s.pips.trigger("shop", "order.created", {"order_id": order.id, "total": order.total},
                        idempotency_key=order.id)
print(answer["notice"])        # Queued for Asha.
```

```typescript
const answer = await session.pips.trigger("shop", "order.created", { order_id: order.id, total: order.total },
  { idempotencyKey: order.id });
```

`trigger` needs no `approved=True`, unlike every other change. It only runs routines a person already added; it can't
add, change or turn one on; and it grants no tools or permissions. In the run, the Pip may do what it may always do: a
read of your app runs, and a change waits as an Allow card (and, from API 62, as an approval in your app).

- **Once.** DGC records an event once per `(app, idempotency_key)` and remembers the key for 30 days. The same key
  again is a no-op that says so (`repeat: true`, with what the first one queued). Use your own id for what happened,
  such as the order's id, not a new random one each call.
- **Who runs it.** Every routine that is on and waits on `(app, event)`, across Personal Pips, gets one run. The
  answer's `pips` says, Pip by Pip: `queued`; `busy` (it is answering something now and keeps this for its next
  check); or `paused` (the Pip is paused, or Pips are stopped on this computer: not run, and not kept). `no_routine`
  is true when no routine waits on it. `notice` says it all in words. With the runner off, events wait and run when it
  is back: "Pips are off on this computer, so they will run when it is back."
- **Limits.** The payload is JSON of at most 32 KB. At most 60 events a minute per app: beyond that `trigger` is
  refused (`DGCCommandRejectedError`, reason `rate_limited`) and nothing is queued; send it again a minute later. A Pip
  keeps at most 20 of your apps' events waiting: a 21st drops the oldest, the answer says so (`dropped`), and the
  Pip's next run tells the user in its chat.

**In the run.** One event is one run, oldest first: a hidden turn in the Pip's chat, as an email routine's is. It names
your app and the event, and carries the payload as untrusted data from your app, never instructions. A chat turn holds
4,000 characters, so a Pip sees about the first 2,500 to 3,000 characters of a payload (less with a long routine); a
larger one is cut, and the turn says so. Send ids and a few fields: the Pip reads the rest through your app's read
tools. The Pip's reply appears in its chat as its own message.

| Command | | Fields |
| --- | --- | --- |
| `trigger_app_event` | E | `app`, `event`, `payload?` (JSON, at most 32 KB), `idempotency_key` (1 to 200 characters on one line). Answers `{event_id, app, event, idempotency_key, received_at, payload_bytes, queued, no_routine, pips: [{pip_id, pip_name, routine_id, routine, outcome, words, dropped?}], more, repeat, runner_online, notice}`. |
| `list_app_events` | R | `app`, `limit?` (1 to 50; 20). Answers `{app, events, names}`: what the app sent lately, newest first (each `event_id`, `event`, `idempotency_key`, `received_at`, `payload_bytes`, `queued`, `waiting`, `pips`), and the event names it used, most recent first. |

E is an event: neither a read nor an approved mutation. Send it with `pips.trigger(app, event, payload=None, *,
idempotency_key)` (TypeScript: `pips.trigger(app, event, payload, { idempotencyKey })`); read with `pips.events(app,
limit=None)` (`pips.events(app, { limit })`). `AsyncPips` has both.

## Pips on a server

Your app and DGC's Pips can run on a server with no VS Code and no desktop. The SDK starts its own `dgc serve` with
`inherit_user_state=True`, so your app and the runner share one machine or container and one DGC home. Nothing in the
SDK changes for it: no new command, and no new Pips API version.

**The runner.** Run `dgc pips serve --server` beside your app. It is the same runner without the desktop: no desktop
notifications, no borrowing a signed-in Chrome, and one plain line per event on stdout for `docker logs` and journald.
A second runner on the same home is refused: it stops at once and says why.

- **systemd:** `dgc pips service install --server`, then `dgc pips service start` and `dgc pips service enable`
  (`preview --server` shows the unit first). The unit passes no environment variables, so keep the model's key in
  DGC's own settings.
- **Docker:** [deploy/docker](../deploy/docker/README.md) has the image recipe: Debian slim with Python 3.12, DGC from
  its release archive at a pinned version, this SDK, the DGC home on a `/data` volume, `dgc pips serve --server` as its
  command and `dgc pips health` as its health check. Your app runs in the image beside the runner (`with-pips`), or in
  a second container on the same volume.

**Health.** `dgc pips health` exits 0 when the runner is online and running, and 1 with one line saying why when it
isn't: Pips are off, Pips are stopped, no runner runs, its heartbeat is stale, or the state can't be read.
`dgc pips health --json` is the same as one object (`healthy`, `state`, `message`, `heartbeat_age_seconds`,
`server_mode`, ...) for your own probes. It only reads, so every 10 seconds is fine.

**The guardrail.** On a server, Pips run on an API key or a self-hosted model only. A Pip whose model is a personal
Claude Code or Codex plan, chosen for it or followed through "Same as DGC", is refused when it runs under `--server`:
its run fails with `server_subscription` and words that say why and how to change it, and its model is never switched
by itself. Give such a Pip an API-key or self-hosted model (`propose_pip_update` with a `model_choice`, or its
Settings).

**Where secrets live.** In the DGC home, owner-only: the model's key in DGC's secret store (`.dgc/secrets.json`, 0600)
or `DGC_API_KEY` in the runner's and your app's environment; your app's signing secret, DGC's copy, in its credential
store (`.dgc/plugin-auth/_pipapp.<name>/credentials.json`, 0600) where there is no system keychain. In the Docker image
the home is the `/data` volume. Your app keeps its own copy of the signing secret, which `register_app` gives once.

## Parameters that pin a review

The SDK passes these through unchanged. Read them from the record the user saw.

| Field | Used by |
| --- | --- |
| `idempotency_key` | `run_pip`, `send_pip_message`, `propose_pip_handoff`, `propose_pip_artifact_handoff`, `propose_pip_personal_handoff`, `trigger_app_event` (an event runs once per key) |
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
