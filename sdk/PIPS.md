# Pips in the SDK

SDK 0.7.0 adds `session.pips` to the Python (sync and async) and TypeScript SDKs. It
lets trusted host code read and manage the Pips of an existing DGC profile through
`dgc serve`: list workspaces and Pips, read runs and reports, review proposals,
setups and handoffs, queue runs, chat with a Pip, and review Personal app actions. From Pips API 61 it also
gives your own app's tools to Personal Pips ([Your own app's tools](#your-own-apps-tools-api-61)), from API 62
your app can show and decide their changes ([Approvals in your app](#approvals-in-your-app-api-62)), from API 63
your app's own events start Pips' routines ([Events from your app](#events-from-your-app-api-63)), from API 64 your
app declares its Pips in code and keeps them as declared on each deploy ([Pips in code](#pips-in-code-api-64)), and
from API 65 it can read what Ask DGC to fix did for each of a Pip's runs (`pips.run_fixes()`), and from API 66
`list_pip_models` says each model's context window and the Pips default model. API 69 adds
`pips.unread(workspace_id)` and `pips.mark_read(pip_id, message_id=..., post_id=..., approved=True)`;
TypeScript calls these `unread(workspaceId)` and `markRead(pipId, cursors, { approved: true })`.
Mark only the message and run-result IDs the user actually saw, so later arrivals stay unread.
API 70 lets a Pip run on DGC Router: `model_choice` takes `{"mode": "router"}` (any of the user's systems with the
Pips job) or `{"mode": "router", "system": "nas", "model": "qwen3.5:9b"}` (that one), and `list_pip_models` names
those systems while the Router is on. A run on the Router waits in the Pip queue while every worker that could take it
is busy; see `session.router` in [docs/SDK.md](../docs/SDK.md). From API 71 a Personal Pip's chat reply that
started a video carries `videos`, each video's job as DGC last saw it. API 72 adds Pip workflows (`list_pip_flows`,
`get_pip_flow`, `create_pip_flow`, `set_pip_flow`), and from API 73 a text message sent during a running Personal Pip
conversation joins that reply. API 74 lets a Pip run on a provider saved in the editor's Settings → Models:
`model_choice` takes `{"mode": "provider", "provider": "provider_<32 hex>", "model": id}`, refused before it is sent by a
runtime below API 74. The saved list belongs to the editor, so an SDK app can't list or add one; it reuses an id it reads
from a Pip's own `model_choice`. For a Pip on your app's own endpoint, use a model on the profile's connection or DGC
Router.

`send_pip_message` takes `display_mentions` when `ready.capabilities.pip_display_mentions` is 1: where your box drew its
`@` marks, for the sent bubble. They are for display only; the model reads `text`. A Pip's reply keeps what it did for
Trace: `list_pip_reply_stats {pip_id, run_ids}` says `has_trace` for each run, and asked about one run it brings the
steps as `trace` (`{v, ms, steps}`, each step a model round with its reported tokens or a tool with its hits, in
milliseconds from the first step). A reply that stopped or failed has none. A Pip's reply lists the plugin cards it
showed as `apps`; `session.cards.get(card_id)` reads one, and `session.cards.watch("pip")` asks for them live.

It pairs with DGC CLI 0.52.0, which advertises **Pips API 113** over editor protocol
v14. For what Pips are and how they behave, see [docs/PIPS.md](../docs/PIPS.md); for
the security model and limits, see [docs/PIPS_REFERENCE.md](../docs/PIPS_REFERENCE.md).

When a person asks their Primary Core Pip to set up other Personal Pips, its reply may leave up to three pending setup cards. SDK apps can list them with `list_pip_setups` for the Personal workspace, show each card with `get_pip_setup`, and use the existing `accept_pip_setup` or `reject_pip_setup` controls after the person decides. Core cannot accept its own proposals.

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
| `run_fixes(pip_id)` | `runFixes(pipId)` | `list_pip_run_fixes` (API 65) |
| `trigger(app, event, payload=None, *, idempotency_key)` | `trigger(app, event, payload, { idempotencyKey })` | `trigger_app_event` (API 63; no `approved`) |
| `events(app, *, limit=None)` | `events(app, { limit })` | `list_app_events` (API 63) |
| `ensure(template, *, approved, accept_widening=False, overwrite_user_changes=False)` | `ensure(template, { approved, acceptWidening, overwriteUserChanges })` | `ensure_pip_template` (API 64) |
| `ensure_all(templates, *, prune=False, approved, accept_widening=False, overwrite_user_changes=False)` | `ensureAll(templates, { approved, prune, acceptWidening, overwriteUserChanges })` | `ensure_pip_template` for each, then `prune_pip_templates` (API 64) |
| `templates(pip_id=None)` | `templates(pipId)` | `list_pip_templates` (API 64) |
| `decide_template_change(change_id, decision, *, expected_digest, approved)` | `decideTemplateChange(changeId, decision, expectedDigest, { approved })` | `decide_pip_template_change` (API 64) |

Python exports `Pips`, `AsyncPips`, `PipReadCommand`, `PipMutationCommand` and `PipTemplate`; TypeScript also exports
`definePipTemplate` and the `PipTemplate` types.
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

Commands form closed sets: 100 reads, 109 mutations and one event (`trigger_app_event`, your app's event,
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
needs a newer API, before sending it. CLI 0.52.0 is API 113; Pip computers need API 42. Starter Pips (API
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
| 68 | `delete_archived_pip`: local human control to erase an archived Pip and its private data permanently |
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
| 64 | Pip templates in code ([below](#pips-in-code-api-64)): `ensure_pip_template`, `prune_pip_templates` and `decide_pip_template_change` (M) and `list_pip_templates` (R), local only; `pips.ensure()`, `pips.ensure_all()`, `pips.templates()` and `pips.decide_template_change()` in both SDKs, refused before API 64. `PipTemplate` / `definePipTemplate` check a template before anything is sent and need no runtime. |
| 65 | `list_pip_run_fixes {pip_id}` (R, local only): what Ask DGC to fix did for each of a Pip's runs, `{pip_id, workspace_id, fixes}`, the latest fix of each run, newest first: `fix_id`, `run_id`, `state` (`queued`, `preparing`, `running` or `applying` while it works; `applied`, `partial`, `unchanged`, `not_applied`, `failed`, `stopped`, `interrupted` or `undone`), `created_at`, `started_at?`, `ended_at?`, `files?` (`[{path, kind, additions, deletions, counted}]`), `held?`, `tests?`, `summary?`, `message?`, `undo?` and `session_id?` (the Work chat it ran in). A Personal Pip has none. `pips.run_fixes()` / `pips.runFixes()`, refused before API 65. |
| 66 | No new command. `list_pip_models` also returns `pips_model`, the Pips default as set (`""` when Pips follow DGC; `default_model` stays what Default runs), and each model may carry `context_window`: the window DGC starts that model with (the one the user chose for it, else DGC's recommendation for its family), never a provider's maximum; a model without one has none known. Read the new fields only from a runtime advertising 66. The main chat reads the same list and changes models with its own tools (docs/PIPS.md, Models from the main chat). |
| 70 | DGC Router: `model_choice` `{"mode": "router"}` (any of the user's systems with the Pips job) or `{"mode": "router", "system": id, "model": name}`, as a command's `model_choice` or `changes.model_choice`. Both SDKs refuse it before API 70. While the Router is on, `list_pip_models` also carries `router` (its systems and their models). |
| 71 | No new command. A Personal Pip's chat reply that started a video carries `videos`: each video's job as DGC last saw it (its state, price and, once it is made, its file). Read it only from a runtime advertising 71. |
| 72 | Local Pip workflow controls: `list_pip_flows {workspace_id}` and `get_pip_flow {flow_id}` (R); `create_pip_flow {name, pip_ids, tasks, mode}` and `set_pip_flow {flow_id, expected_revision, status}` (M). `list_pip_flows` also returns `core_suggestions`: ordered Pips created from one Core reply, for prefilling a separate human review; suggestions never authorize routing. Mode is `reviewed` or `unattended`; status is `on`, `paused` or `retired`. Exactly two to four distinct Pips of one workspace and kind, one bounded task per handoff, at most three starts per day. Personal workflows share the exact prior result. Project workflows hand the first source checked finding to a read only Pip on committed source. Unattended only accepts the route; each Pip keeps its own action approvals. |
| 73 | A new text message can join one running Personal Pip conversation as a mid-turn update; it stays in that run's history and does not start a competing reply. |
| 74 | A provider saved in the editor's Settings → Models: `model_choice` `{"mode": "provider", "provider": "provider_<32 hex>", "model": id}`. The Pip keeps only those; the key stays with the CLI. |
| 75 | Paying by itself (local only in DGC): `set_pip_paying {pip_id, rule}`, one Pip's rule, `ask` (the default) or `allow` (only at Do it all; `get_pip_level` says `paying`), and `get_pips_payments` / `set_pips_payments {limit}`: how many payments your Pips may make by themselves in a day, 1 to 20 (3 unless you change it) |
| 76 | `get_pip_backup {pip_id}`, `set_pip_backup {pip_id, model, provider?, engine?, router?}`: a Pip's fallback model, one provider ("" DGC's own connection, or `provider_<32 hex>`) and one model ("" none), or Claude Code or Codex (`engine`) or DGC Router (`router: true`); `get_pips_backup`, `set_pips_backup {model, provider?, engine?, router?}`: the one new Pips start with (local only in DGC) |
| 77 | `undo_pip_change {pip_id, change_id}`: Undo on a change a Personal Pip made about itself at once in a turn the user started (local only in DGC); a reply's `changes` lists them |
| 78 | No new command. A run's post may carry `artifact` `{id, type, title, version}` (`type` `doc` or `sheet`): the review it kept as the Pip's document or sheet, or the Quill draft that became its document. Read it only from a runtime advertising 78 |
| 79 | Several conversations per Pip: `list_pip_conversations {pip_id, archived?}`, `create_pip_conversation {pip_id, title?}`, `rename_pip_conversation {pip_id, conversation_id, title}`, `archive_pip_conversation {pip_id, conversation_id, archived?}` (local only in DGC); `send_pip_message`, `list_pip_messages`, `mark_pip_read` and `get_pip_chat_context` take an optional `conversation_id` (none: the Pip's first conversation, as before). Messages carry their `conversation_id`. `add_pip_computer {pip_id}`: another computer for the Pip; `get_pip_computer` gains `computers` and `computers_limit`. |
| 80 | No new command. A Project Pip has a level too: `get_pip_level` and `set_pip_level` take a Project Pip's id, the answer carries `kind` (`personal` or `project`; a Project Pip has no `paying`), and `on_its_own` may list kind `handoff`. At Approve for me a read-only handoff, and a check whose exact commands you approved once, run by themselves; at Do it all a fix too, in its own copy. Read the new fields only from a runtime advertising 80. |
| 81 | A plugin that needs a key it doesn't have raises one card in the Pip's chat: `list_pip_plugins` also answers `key_requests` [{id, plugin, name, reason, status, needs_key [{name, label, server}]}], and `allow_pip_plugin` takes `keys` {variable name: text} (up to 8, each 16,384 characters at most), kept where DGC keeps a plugin's key, bound to its server, and never answered. Every key it lacks must be given, or nothing is saved. Both SDKs send `keys` only to a runtime advertising 81. |
| 82 | A Personal Pip's own API keys, each bound to one site (local only): `list_pip_keys {pip_id}` (R: its cards, `kind` `site` or `generator`, `status` requested, saved or declined; never a value), `save_pip_key {pip_id, key_id, value}`, `decline_pip_key {pip_id, key_id}` (Not now: no new card for that site for a day) and `remove_pip_key {pip_id, key_id}` (M). A key id is `pipkey_<32 hex>`. DGC adds a saved key to the Pip's reads from that site alone; a `generator` card's key is a picture or video generator's own, kept for all of DGC. |
| 83 | `send_pip_message`'s `reply_to`: the id of one of that Pip's own messages in the same conversation (`message_<32 hex>`). The user's message quotes it; its row carries `reply_to` {id, text} (the quote, read from the store, up to 600 characters), and a reply's row carries `answers`, the id of the message it answers. |
| 84 | No new command or field. `send_pip_message`'s photos and files are also taken while a reply is running (a runtime before 84 answers `steer_attachments`), and by a Project Pip, as reference beside the code it reads: never instructions, never run. A client gates on 84 before sending either. |
| 85 | `save_pip_key`'s `terminal` (true or false): also let the Pip's computer Terminal use that site's key, as a variable (`list_pip_keys` rows say `terminal` and `terminal_name`). Refused below Do it all, and the level is read again at each command. The key reaches the computer through a file only it sees, never a command line, and what the Terminal prints is masked of it. |
| 86 | A name for each of a Pip's computers, and its screen size (local only): `get_pip_computer`'s `computer` carries `names` [{number, name, named, state, doing?}] (state `closed`, `open`, `working` or `needs_you`), `screen` and `screens`; `rename_pip_computer {pip_id, number, name}` (up to 30 characters; "" gives back its first name) and `set_pip_computer_screen {pip_id, size}` (`1280x800`, `1440x900` or `1920x1080`, taken when its screen next starts) (M); `open_pip_computer` and `use_pip_computer_view` take an optional `number` (1 for the first). |
| 87 | Big files between this computer and a Pip computer's Files, streamed, up to the Files folder's 1 GB (more if raised in Dev Mode): `copy_pip_computer_file_in {pip_id, path, source}` and `copy_pip_computer_file_out {pip_id, path, target}` (M), by absolute path on this computer. Host only: DGC takes them from its own user on this computer (the editor sends them after its file dialogs) and refuses them from an app built on the SDK. |
| 88 | "Apps it can use", skills and team files (local only): `get_pip_apps {pip_id}` (R: `apps` [{id, name, kind `plugin` or `app`, on, accounts?}]), `set_pip_app {pip_id, app, on}` and `add_pip_app_account {pip_id, app}` (M: a Connect card for one more address of an app the Pip has; the card carries `another: true`); `get_pip_skills {pip_id}` (R: `skills` [{name, description, source, on}]) and `set_pip_skill {pip_id, skill, on}` (M); `export_pip_team {pip_ids, name}` (R: one `dgc-team` file for up to 20 Pips); `set_pip_profile`'s `changes.group` (the Pip's folder in the Personal list, one line of up to 40 characters, "" for none; **removed before release (0.52)**: the Pips page is one list, a profile has no `group`, and a runtime refuses the change as one it doesn't know); `use_pip_computer_view`'s `op` `close` (its tab closed, so the computer reads closed at once). Every app and skill is on until switched off; a switched-off app is refused on every path, and a switched-off skill is never offered to the Pip's model. Both SDKs refuse `op` `close` before 88 (their gating of `changes.group` went with it, 0.52). |
| 89 | (Never released; removed in 96, when no session owns a Pip any more.) A Project Pip's one owner session, the Work chat its cards (run reports) reach: `get_pip_owner {pip_id}` (R: `session_id`, null for none, and `chosen`), `set_pip_owner {pip_id, session_id}` (M: a session of the Pip's own project, or null for none; its reports then wait in the Pips view) and `list_session_pips {session_id}` (R: the Project Pips that session owns, what archiving or deleting it asks about). By default the owner is the chat the Pip was set up in; `attach_pip_to_session` makes that chat its owner. Local only; a Personal Pip has none. |
| 90 | Webhooks in, fully local (pips-22): a Personal Pip's routine with `trigger` `{kind: "webhook"}` runs when a service calls its own secret address. `list_pip_routines {pip_id, webhooks: true}` lists those routines (left out otherwise). `get_pip_webhook {pip_id, routine_id}` (R: `path`, `addresses` on this computer, the home network and the internet, null where none reaches it; `signing`; its latest `calls`), `replace_pip_webhook_address {pip_id, routine_id}` (M: the old address is refused from then on), `set_pip_webhook_signing {pip_id, routine_id, secret}` (M: GitHub's, Stripe's or GitLab's secret, or null; never answered), `send_pip_webhook_test {pip_id, routine_id}` (M: a test call that runs it once), `get_webhook_reach` (R) and `set_webhook_reach {local_network, tunnel, own_base}` (M: the home network switch; `tunnel` `tailscale`, `own` with your own https address, or null). Local only; a Pip never makes one. |
| 91 | @ a project in a Personal Pip's chat (pips-21): a `send_pip_message` mention `{kind: "project", identity: <workspace id>}` makes a private copy of that project on the Pip's computer, in its Files under `projects/<name>/` (refused: `needs_computer`, `project_too_big`). `list_pip_project_choices {pip_id}` (R: the projects on this computer), `list_pip_project_changes {pip_id}` (R: one change per copy, `pending` until decided, with its files and `digest`), `get_pip_project_change {pip_id, change_id, path}` (R: a file's `diff`, or without `path` the whole `patch`), `apply_pip_project_change {pip_id, change_id, expected_digest}` (M: writes what the Pip changed, holding back a file you changed meanwhile, an ignored one, anything in `.git` or a link), `discard_pip_project_change` and `undo_pip_project_change {pip_id, change_id}` (M). Local only; applying is always your call. |
| 92 | A goal for a Personal Pip's conversation, "keep going until done" (pips-15): `set_pip_goal {pip_id, objective, conversation_id}` (M: up to 4,000 characters; its first turn starts now, and a new goal replaces the one there), `get_pip_goal {pip_id, conversation_id}` (R: `goal` null or {id, objective, `status`, turns, max_turns, reason, evidence, started_at, updated_at}) and `stop_pip_goal {pip_id, goal_id}` (M). Each turn is DGC's, in that conversation, with Work's continuation prompt; the Pip ends it with `update_goal` (completed: `done`; blocked: `blocked`). A turn that asks you something or leaves a card waits for you (`needs_you`); after `max_turns` (20) it is `blocked`. Local only. |
| 93 | The Project Folder dropdown: `list_project_folders {}` (R: `folders` [{folder, name, here, exists, git, sessions, pips, workspace_id, updated_at}], the folders with a Work session or a Project Pip, newest first; never DGC's own; `git` (19 Nov, 0.52): true for a Git project with a commit at its top folder, false for a folder its Pips read as it is), `add_project_folder {folder}` (M: a folder you picked, by its full path, as a project: its `workspace`; refused for a missing folder, a file, `/`, your home folder or DGC's own), `list_pips`'s `scope` `projects` (every project's Pips, each with its `workspace_id`) and `list_pip_attention`'s `projects` (`all` or one project's workspace id: its Project Pips' cards too, and `in_projects` counts only the folders left out). Local only. |
| 94 | One Pips (13 Nov): `list_pips`'s `scope` `all` (R: every Pip in one list, the Personal ones and every project's, temporary and DGC-owned folders left out; Core first, then the latest activity: its newest chat message, run post or change; each with its `workspace_id`). A Pip in a project folder may be created with no `goal` (it starts with "help with what I ask in this chat", as a Personal Pip does), chats as a Personal Pip does (short messages, `offer_choices` buttons) and, in a turn the user started, changes its own `name`, `goal`, `schedule` and `model_choice` at once with Undo (`draft_pip_change`, as a Personal Pip; never web reads or a computer). Local only. |
| 95 | Every Pip has its own box (13 Nov, steps 1 and 2): no new command. A folder Pip on a machine that runs boxes has its own computer in its chat: `get_pip_computer` (R: `granted` true), its Files, Terminal and live view open as a Personal Pip's, and a copy of its folder is in its Files at the start of each turn (Git-listed files without ignored ones, never `.git`; a folder that isn't a Git project with a commit, 19 Nov: its files as they are, never `.env` or `.env.*`, keys, certificates and credential files, or dependency, virtual environment, build and cache folders; only what changed is copied again; kept while a change waits; past the copy limit the biggest files are left out and said). What it changed shows in `list_pip_project_changes`, applied, discarded and undone as an @-copy's. Its level (`set_pip_level`) governs its computer when chosen while it has the box (`get_pip_level`'s `says` lines say so; one chosen before keeps its handoff meaning and its computer reads Ask); at Do it all what it changed is applied when its turn ends, never over a file you changed meanwhile (a change's `result.by` is `pip-level:full`, listed in `on_its_own`). `set_pip_careful` works for it. |
| 96 | The Pips flow (14 Nov): a Pip's chat is its home. `list_pip_fixes {pip_id}` (R: `folder`, `fixes` oldest first [{id, run_id (the check that found them), state (ask, declined, queued, running, ready, applied, held, unchanged, failed, stopped, interrupted, undone, discarded), count, digest, asked_at, decided_at, by (you, pip-level:approve, pip-level:full), fix_run_id, started_at, helpers, steps, change_id, tests (passed, failed), tokens (what its turn used), message, findings [{id, title, path, line, severity, state (new, still, back), verdict (open, fixed, already_fixed, not_a_defect, needs_you), why}]}], `waiting` [{id, title, blocks, since, state (waiting, later, done, dismissed), remind_at, can_undo}]); `decide_pip_fix {pip_id, fix_id, expected_digest, allow}` (M: Allow starts the fix as the Pip's own turn in its own copy; Not now, and it is not asked again); `answer_pip_waiting {pip_id, waiting_id, answer}` (M: done, later (back tomorrow), not_a_problem, undo (within ten minutes)); `commit_pip_project_change {pip_id, change_id}` (M: commits exactly the files that change put in your folder, as you); `start_pip_work_helper {pip_id, fix_id}` (M: not ready in this build, refused as unsupported); `get_pips_welcome {}` (R: `had_pips`, true only when this database came from 0.51 or before with a Pip other than Core; `folders` [{workspace_id, folder, pips [{id, name}]}], `personal` [{id, name}], `do_it_all` [{id, name}]: what the Pips tab's one-time welcome names); `list_pip_sent {pip_id}` (R: `sites` [{host, times, sent_bytes, received_bytes, blocked, first_at, last_at}] newest first, every connection out of its computers' boxes, and `note`: an HTTPS connection is a sealed tunnel, so only its site and size are known; plain HTTP carrying a secret DGC knows is blocked); `set_pip_knows_you {pip_id, on}` (M: whether what DGC remembers about you reaches this Pip; on by default, and `get_pip` says `knows_you`). `list_related_pips {session_id}` (R: `pips` [{id, name, pip_type, workspace_id, why (asked: it gave the Pip a job in the last 30 days; set_up: set up there; folder: works on its folder), running, needs_you}], strongest first; it orders and shows, it never routes anything). `get_pip_runner`'s runner gains `boxes` {available, why}: whether this machine gives Pips their own computer (the Mac dialog's cue). Paying by itself (agreed 13 Nov): `set_pip_pay_limits {pip_id, usd_per_day (a number, or no_limit), max_count?, sites?}` (M: required before a Pip at Do it all, allowed to pay, pays by itself; the TOTAL of its payments in the last day, an optional count and site list); `get_pip_level` answers its `pay_limits` and `spent_today` (and `paying` for a folder Pip with its own computer); `get_pips_payments` / `set_pips_payments {usd_per_day}` are now all Pips together, up to $Y a day (null for none), with `spent_today`: the 3-a-day count is retired. DGC reads each payment's amount and currency and converts with a daily reference rate it reads itself; anything it can't read for certain, or the same site and amount twice in a day, asks. Every Pip, not only a Personal one, keeps what you told it (notes), its working notes, routines, a goal for its chat and skills. A check that finds something becomes a fix by the Pip's level: Ask me first asks (Allow), Approve for me fixes new findings by itself and its change waits at Apply, Do it all fixes and applies by itself with Undo, never over a file you changed (no size, delete or test fuse). A finding fixed once that comes back is asked about at every level. `list_pip_attention` items gain the kinds `fix_ask` (card: the fix), `fix_ready` and `fix_held` (card: its change) and `waiting` (card: the waiting item). A run post gains `said` (the Pip's own words about what it found), `found` {new, back, still} and `findings[].state`, with up to eight findings; a project change gains `tests` and, in a Git folder once applied, `git` {committed}. A Work session or chat is sent a Pip's report card only for a run it started (`run_pip_now`); attaching a Pip no longer brings its reports there, and `get_pip`'s `report_chats` is 0 and `report_session` null. `get_pip_owner`, `set_pip_owner` and `list_session_pips` (API 89, never released) are gone. Local only. |
| 97 | A Pip's sub-agents (14 Nov). A fix is a sub-agent's job: it works in a copy of its own made from the Pip's copy when it starts, with the Pip's tools and level; its turns are runs with no chat rows that run beside the Pip's chat, at most the Pip's slots at once (1; 4 at most, Dev Mode lifts it); when it ends the Pip checks its work in its own chat (a message from DGC), and PASS puts the change into the Pip's copy, three-way (a file the Pip's copy changed meanwhile is held, never overwritten), after which it is the Pip's change as before (Apply, or applied at Do it all); RETRY sends it back with the Pip's notes, three tries at most. `list_pip_agents {pip_id}` (R: `agents` newest first [{id, pip_id, kind (fix), fix_id, title, state (queued, working, check_due, checking, retry_due, merged, held, asked, failed, stopped, left), try, tries, run_id, run_status, started_at, ended_at, model, held [paths], notes (what the Pip told it to do differently), said (the Pip's own words when it sent the work back), check_run_id (the Pip's check turn), created_at, updated_at}], `slots`); `stop_pip_agent {pip_id, agent_id}` (M: its run stops, nothing of its copy reaches the Pip's); `set_pip_agents {pip_id, slots}` (M); `retry_pip_fix {pip_id, fix_id, again}` (M, after a fix's sub-agent ended asked, held, failed or stopped: `again` true starts a fresh sub-agent in a copy of the Pip's copy as it is now, for what isn't fixed, with the Pip's last notes; false leaves it, never asked again; R: `fix`). `list_pip_fixes`'s fixes gain `agent` (that view) while it has one, and an asking fix's `message` is the Pip's own question ("Want me to fix these three?"); a fix reads `asked` after the last try and `left` after Leave it. In `list_pip_chat_messages`, the Pip's reply to its check carries `check: true` and its text without the lines meant for DGC (FINDING, TESTS, RESULT). `start_pip_work_helper` is still refused in this build. Local only. |
| 98 | The code card (15 Nov). A site asks a Pip's computer for a one-time code its saved login has no authenticator key for: DGC holds a computer action of kind `code` (its card in the Pip's chat; it expires in 10 minutes) and the Pip stops. `fill_pip_code` {pip_id, action_id, expected_digest, code} types the user's code into that page through the computer's own view and sends it once; it is never stored, logged or answered, and the Pip is told only that it was filled. Not now is `decide_pip_computer_action` with approve false; a page that moved on is `lost`. Local only. |
| 99 | Where a message sent while a Pip worked was read (15 Nov). A reply that read such messages carries `steers`, `[{id, at}]`: each message's id and a place in the reply's own `text` (0 to its length), in the reply's order, so a client draws the reply in pieces with each message between them, as Work shows a message where it was read. A reply that read none has no `steers`; the messages themselves are listed as before (`steered: true`). A read field: no new command. |
| 100 | `@` outputs in a Pip's chat, as Work's Output menu (16 Nov). `send_pip_message` takes `output`: `document`, `slides`, `spreadsheet`, `page` or `dashboard` (`auto` or none asks for nothing); the reply is asked, in Work's words, to make that one with `make_artifact`. A message sent while the Pip works keeps its own `output` (read on the way, or as its own turn). A reply that didn't make or change one carries `output_missing`, the line to show under it ("The model didn't make a page. Try again, or pick another model for this reply."). The same key with another `output` is another message. |
| 101 | A Pip sends files in its chat (16 Nov), as a person does: its computer's `send_to_chat` shows one of its files with its reply. A reply carries `images` (pictures, by their bytes) and now `files` `[{index, name, bytes, mime}]` (a video, a sheet, a zip...); a user message's `files` gain `mime`. `get_pip_message_file {pip_id, message_id, index}` (R: `{pip_id, message_id, index, name, mime, bytes, path}`) gives where any message's file is kept on this computer, checked against its digest; local only (`local_only` elsewhere). |
| 102 | What a Pip's reply made (16 Nov). A reply that made or changed a page, doc, sheet, deck or dashboard carries `artifacts` `[{id, type, title, op}]` (`type` doc, slides, sheet, page or dashboard; `op` made or changed; at most 8, one per artifact), counted by DGC, so a client shows each as a card that opens it. A read field: no new command. |
| 103 | One kind of Pip, the backend half (16 Nov). No new command or field. A Pip with a folder has what a Personal Pip has: its chat hears the Personal chat's instructions and has its tools, plus its project reads, and drafts an email, an event or an app action (its drafts and external-action reviews list for its id; what you always allow for it runs; its level decides the rest). `get_pip_eyes` / `set_pip_eyes`, the keys (`list_pip_keys`, `save_pip_key`, `decline_pip_key`, `remove_pip_key`), borrowing your Chrome (`list_pip_borrows`, `allow_pip_borrow`, `decline_pip_borrow`, `stop_pip_borrow`), app links (`list_pip_app_links` and its cards) and plugins (`list_pip_plugins`, `allow_pip_plugin`, `decline_pip_plugin`) take its id; before 103 they answered `invalid_request`. `web_plan`, `app_plan` and `computer_plan` are any Pip's (`create_pip`'s `computer`, `propose_pip_update`, a setup card, the Pip's own `draft_pip_change`), read before each of its chats, checks and drafts. A Pip with a folder has its box where this machine runs boxes without a plan; Remove computer (`computer_plan: null`, kept as `null` in that proposal's `definition`) takes it away, and Give a computer gives it back. An `@` project's copy goes in any Pip's box. Paired and remote devices still can't reach Personal Pips. A client gates on 103 before showing these for a Pip with a folder. |
| 104 | A Pip's own sub-agents model (17 Nov). `set_pip_agents {pip_id, slots?, model_choice?, thinking?, context_size?, fallback?}` (M; at least one field; a field not given keeps its value) also sets what the Pip's sub-agents run on: `model_choice` (`{mode: "default"}` is "This Pip's model", the default; `{mode: "model", model}` a model on DGC's own connection; `{mode: "provider", provider, model}` a saved provider's; a subscription CLI and DGC Router are refused with `invalid_model_choice`), `thinking` (`""` the Pip's own, or `off`, `low`, `medium`, `high`, `xhigh`), `context_size` (0 the Pip's own, or 2,048 to 16,777,216 tokens) and `fallback` (`{provider, model}` as `set_pip_backup` keeps it: `provider` `""` DGC's own connection or a saved provider's id, `model` `""` none; never an engine or the Router). R: `{slots, model_choice, thinking, context_size, fallback}`, the values kept after the change. `list_pip_agents` carries the same four beside `agents` and `slots`. A sub-agent job's run runs on that model, with that thinking and window, and carries on with that fallback in place of the Pip's; every run of the Pip gives DGC's own helpers inside it the same settings (a saved provider's address and key are read when the run starts, never kept with it). A provider removed since it was chosen refuses the sub-agent's run in plain words, never another provider. Local only. Both SDKs refuse the new fields before 104. |
| 105 | Your Browser, the model and the API (17 Nov). One shared browser on this computer, Google Chrome with DGC's own profile, where you sign in to your accounts once (in Chrome, with its sign-in and sync; DGC never reads or copies another browser's cookies or passwords); each Pip works in its own tab of it, only on the sites you let it use. `get_your_browser {}` (R: `kind` `host_profile`, `weaker` true (Chrome's own sandbox keeps sites apart there, not a box), `available`, `reason`, `chrome` (`installed`, `dgc_copy` or ""), `sites` [{site, shown, mode (`all` or `chosen`), money, pips [{pip_id, name}], sso_hosts, added_by, added_at, used_at}] most recently used first, `signing_out` (sites still waiting to be cleared), `yours` {open, tabs} and `lanes` (empty until its window exists)). Sites are noticed from your own sign-ins there, never added by a Pip; a new bank or payment site starts at `chosen` with no Pips ("Ask me which Pips"), every other at `all`. `set_your_browser_site {site, mode, pips}` (M: `all`, or `chosen` with the Pip ids; none chosen asks; answers `site`), `sign_out_your_browser_site {site}` (M: no Pip uses it from now on and it leaves the list; `sign_out` is `waiting` until Your Browser clears its sign-in). `open_your_browser {url, pip_id}` and `use_your_browser_view {op, x, y, text, key, dy, url, pip_id}` (M) are declared now and answer `not_ready` until its window exists. All five are local only. `list_pip_sent`'s sites gain `your_browser` (how many of the lines came from the Pip's tab there) and `not_allowed` (pages or writes there DGC refused because the site isn't one of the Pip's). A Pip deleted for good takes its rows with it. |
| 106 | A question card in a Pip's chat, as Work has it (18 Nov). `send_pip_message` takes `questions` (true: this client draws the card under a reply; never part of the retry key). A conversation whose client wrote so last is offered Work's own `propose_options` beside `offer_choices` (Work's schema and validator: 1 to 4 questions, 2 to 6 options each, a recommended one, `multi_select`; the client adds the free-text Other), DGC's own turns there too; without it (an older client), only `offer_choices`. A reply that asked carries `questions` `{questions [{id, header, question, multi_select, options [{label, description, recommended}]}], state, answers}`: `state` `open`, `answered` (with `answers` `{question id: {selected [0-based indices], other}}`), `dismissed`, or `closed` (the chat moved on without an answer); such a reply has no `choices`. `answer_pip_questions {pip_id, message_id, idempotency_key, answers, chat_options?}` (M) sends the answers as the user's own next message in that conversation, each question and its answer one a line, a normal turn of theirs (R: `questions`, `run`, `message`; the same key again is the same message); `answer_pip_questions {pip_id, message_id, dismissed: true}` (M) closes the card with nothing sent (R: `questions`). Both only while the card is open and its reply is the conversation's last message (refused: `questions_closed`); answers that don't fit its questions are refused `invalid_answers`. Both SDKs refuse the command and the field before 106. |
| 107 | Your Browser's window (18 Nov). `open_your_browser {url?, pip_id?, editor_bounds?}` (M) opens Your Browser's window, or brings it forward, through the Pips runner (it answers `runner_required` when the runner isn't running): full Google Chrome with DGC's own profile, placed to the right of the editor (`editor_bounds` {x, y, width, height, screen?} in screen pixels, as the editor measured its window and the work area of its screen; over a full-screen editor, the screen's right part). `url` is what was typed: an address opens as itself, anything else is a Google search, in a new tab of yours; `pip_id` brings that Pip's own tab forward. It answers `{ok, kind, weaker, url, open}`, and `view` (`window`, or `tab` where the computer DGC runs on has no screen, as over Remote-SSH: Chrome runs headless (`--headless=new`, full Chrome, its sandbox on) with DGC's own profile, and the editor opens a tab streaming your own current tab), or `unavailable` with the reason where it can't run here (Your Browser never starts Chrome without its sandbox). With no Pip tab and no window of yours for 15 minutes it closes (its profile stays). `use_your_browser_view {op, pip_id, x?, y?, text?, key?, dy?, url?}` (M) streams one Pip's own tab: op `frame` (new) answers `{ok, pip_id, url, title, width, height, image, lanes}` (at most four pictures a second); `go` stays on the sites that Pip may use; your own click or key there sends what it causes, and nothing else that tab sends goes. With `own: true` instead of `pip_id` it streams YOUR OWN current tab, only where the computer has no screen and only for the editor's own actor (never the command line, a Pip, a model or a tool): ops `frame` {seq} (every screencast frame, JPEG, sized to the editor tab, up to 30 a second; a frame newer than `seq` waited for a moment; `{ok, own, seq, image?, width, height, url, title, current, tabs [{id, title, url, current}]}`), `input` {events: up to 20 of `{t: down|up|move|wheel|key|text, x, y, button, buttons, clicks, dx, dy, key, code, text, mods}`, in order}, `go` {url}, `back`, `forward`, `reload`, `new_tab` {url?}, `tab` {tab}, `close_tab` {tab?}, `size` {width, height} and `close`; your tabs only, never a Pip's; its frames are never written or kept. Without either it is refused. `get_your_browser_recent {}` (R) answers `{links [{url, title, host, at}], open, available, reason, lanes, install, view}`: the newest three links from your own tabs there, never a Pip's tab, for Home's Browser card, and the Pips' tabs (`lanes`, as `get_your_browser` gives them) to watch. `get_your_browser`'s `yours` gains `error`, and `yours.tabs` [{title, url}] and `lanes` [{pip_id, name, title, url}] are filled while it runs. Where no Google Chrome is installed and Chrome's sandbox can't run from DGC's downloaded copy, `get_your_browser` and `get_your_browser_recent` carry `install` `{how, state, error, line}` (else null): `how` `password` offers Install Google Chrome, and `install_google_chrome {}` (M) installs it as you would yourself, through the system's own password prompt (pkexec; DGC never sees the password) for one root step: Google's signing key checked against the fingerprint DGC pins, Google's apt source, then `apt-get install -y google-chrome-stable`; it answers at once `{available, install}` and `install.state` says `running`, then `failed` with `error`, or Chrome is there. `how` `terminal` (no screen, as over Remote-SSH, or no pkexec), and a closed or refused prompt, give `line`: the same steps as one terminal line for sudo, to copy. apt systems only; elsewhere the reason says to install Google Chrome from google.com/chrome. No sudo command to paste and no AppArmor profile from DGC. A site signed out of is cleared (its cookies and its sign-in hosts') as soon as Your Browser runs. All local only. Both SDKs refuse `get_your_browser_recent`, `install_google_chrome`, `editor_bounds`, `own` and op `frame` before 107. |
| 108 | Save to Library on a picture in a Pip's chat (18 Nov). `library_pip_message_image {pip_id, message_id, index, keep?}` (M, local only; `keep` true or false, false when not given): whether the picture is in the Library already (a picture the Pip generated is, from the start; one kept before is, found by its bytes) and, with `keep`, keeps it there through DGC's one image keeper, kept by you with this Pip's chat as where it came from; never twice. R: `{pip_id, message_id, index, in_library, kept, title}` (`kept` true only when this request kept it). A picture that isn't a PNG, JPEG, WebP or GIF, or is over 15 MB, is refused in words. A Pip's own `keep_image` also takes a picture in its computer's Files (read by DGC inside Files, never through a link) or one it sent in its chat by name. A client gates Save to Library on 106. |
| 109 | A Pip's sub-agent with Work tools (18 Nov). For a fix its copy can't do (a file Git ignores, like .env, or a service to run), a sub-agent that is a real Work run on the Pip's REAL folder, on the Pip's Sub-agents model (never a subscription app or DGC Router), in auto mode with its safety check on (DGC's brief is DGC's words; only the user's own words it quotes count as theirs), its session in the job's own folder so it never shows in Work's sessions list. It takes one of the Pip's sub-agent slots, the Pip checks what it changed in the folder (PASS ends it done, already in the folder, with Undo; RETRY continues the same session, three tries), Stop ends it and everything it started, and a runner restart reads it stopped, never running it again. `start_pip_work_helper {pip_id, fix_id}` (M: the fix menu's "Start a sub-agent with Work tools"; the press is the yes at every level, on a fix that asks or one that ended; R: `fix`). `list_pip_agents` rows of kind `work` carry `changed` [{path, status, additions, deletions, counted, command}], `changed_more`, `can_undo` and, once undone, `undo` {restored, merged, left [{path, why}], at}. `undo_pip_agent_job {pip_id, job_id}` (M: puts back what it changed, Work's rule: a file you changed since keeps your edits, or is named and left; R: `agent`, `undo`). A fix it came from reads `applied` (then `undone`). At Do it all a folder Pip's own chat turn may start one itself (its tool `start_work_subagent`); a reply that did carries `work_subagents`. Local only. |
| 110 | Give a Pip a folder later, and Remove its folder (19 Nov). `give_pip_folder {pip_id, folder, dry_run?}` (M, local only) makes a Pip for anything a folder Pip for `folder` (a full path to any folder DGC opens as a project, listed among your projects, never a temporary one; never Core, never a Pip that already has a folder. 19 Nov, 0.52: a Pip works in any folder. One that isn't a Git project with a commit at its top folder, a Git project with no commit yet among them, is read as it is, and DGC keeps its own Git of it on its side for the commits a run, a check and its "what changed since" pin; the folder is never written but by what you apply, and Apply's Undo is DGC's own record. `give_pip_folder` and a new Pip's first chat no longer answer `unsupported_source` for such a folder); `remove_pip_folder {pip_id, dry_run?}` (M, local only) makes a folder Pip a Pip for anything again. The Pip moves into the folder's workspace (or back to the personal one) with the next version of its job, written as a Pip made there from the start has it, and keeps its chat, notes, routines, computer and Files, level, model and sub-agents; its runs, chat rows and what it learned about a folder's code stay where they were made (what it learned comes back when it is given that folder again). Refused (`busy`) while it or a sub-agent of its works. A change waiting at Apply, an applied change's Undo and its copy in its Files carry over both ways; a reviewed change waiting for you is carried to the new version where it fits; a handoff waiting for it or from it and a message it prepared for you to send close; on Remove, a fix that asks, what only you can do for the folder and a sub-agent's question about it close; a schedule stops (its run would quietly become the other kind of work; its routines go on), and an event trigger or command plan a Pip for anything can't have goes. Both answer `{pip, folder: {name, folder, workspace_id}, keeps: [line], changes: [line], done}`; with `dry_run` they say the same lines and change nothing. Events `pip_folder_given` and `pip_folder_removed` in both workspaces. |
| 111 | @ a Pip hands it a job, from Work, ChatDGC and a Pip's chat (19 Nov). A chat's model hands one of your Pips a job with its `ask_pip` tool (offered whenever Pips are on, never because of a message's words; an `@` mark makes the named Pip known to it). The job is DGC's turn in the Pip's first chat, run at the Pip's own level on a copy of the asking chat's folder (a folder Pip of that folder uses its own copy; any other Pip gets the `@` project copy in its computer's Files); a Pip busy with a reply starts it after that reply; Ask me first waits for your Start in the Pip's chat; a paused or archived Pip is refused in plain words. `get_pip_job {job_id}` (R) answers `{job}`: `{id, pip {id, name, pip_type, status}, words, about, asked_from {kind (`work`, `chatdgc` or `pip`), id, title}, state (`asking`, `queued`, `working`, `done`, `failed`, `declined` or `stopped`), state_words, folder {name, own, copy?, note?} or null, answer?, answer_more?, error?, run_id?, conversation_id?, change_id?, change, created_at, updated_at, ended_at?}`, where `change` is read afresh: `{id, status, name, digest, files [{path, change, plus, minus}], more, plus, minus, result}` or null, the SAME change id the Pip's chat shows, so `apply_pip_project_change`, `discard_pip_project_change` and `undo_pip_project_change` from either place are one change. `list_pip_jobs {pip_id}` (R) answers `{pip_id, jobs}` (newest first, without `change`). `start_pip_job {pip_id, job_id}` and `decline_pip_job {pip_id, job_id}` (M) are your Start and Not now on a job waiting at Ask me first (R `{job}`). `list_pip_messages` carries `asking_jobs` (those waiting for you) and, on the job's own turn (a user message with `intro`), `job`; a reply that handed other Pips jobs carries `pip_jobs`. The answer is told back once: a Work session and a ChatDGC chat get a turn DGC starts with a notice in its own words, a Pip's chat a DGC turn in the conversation that asked. The older reviewed `handoff_to_pip` proposal tool is no longer offered (the handoff ledger and its reads stay). All local only. Both SDKs refuse the four commands before 111. |
| 112 | Clear browsing data in Your Browser (22 Nov). `clear_your_browser {history?, sign_ins?, passwords?}` (M, local only; each true or false, at least one true) clears what was ticked from DGC's own profile for Your Browser, never your own Chrome profile: `history` (pages visited, the downloads list and Home's last visited links), `sign_ins` (cookies and site data: you are signed out of sites) and `passwords` (the passwords Chrome saved there). Chrome's files are cleared only with Chrome stopped: with the Pips runner on, the supervisor closes Your Browser, clears and opens it again if it was open; with the runner off it is cleared at once (`busy` while a Chrome still holds the profile). Answers `{ok, cleared: [kind], reopened, chrome_account}`. `get_your_browser` and `get_your_browser_recent` gain `chrome_account` (Chrome is signed in to a Google account there: with Chrome sync on, the account keeps its own copy of what is cleared). Also in 0.52 (editor capability `your_browser_screen`): where the computer has no screen, Your Browser's own tab streams Chrome's real window on a VNC screen of its own over `your_browser_screen` / `your_browser_screen_data`, as a Pip computer's screen streams; a Pip's lane there opens in a window off that screen. Both SDKs refuse `clear_your_browser` before 112. |
| 113 | The sites Pips may use in Your Browser, in one panel (23 Nov). `seen_your_browser_sites {}` (M, local only) says the person opened it: the sites noticed from their own sign-ins until now are no longer new. A site the person signs in to in Your Browser (a password they typed and sent from their own tab) joins the list by itself: a bank or payment site at "Ask me which Pips" (no Pip until chosen), every other at All Pips; never one on this computer or the local network. `get_your_browser`'s sites carry `new`, it lists `pips` (every Pip the person may choose, never an archived one), and `get_your_browser_recent` carries `new_sites` (how many are new). `get_your_browser_lanes {}` (R, local only) is the dock's quick look at the Pips working there: each Pip with a tab in Your Browser (`pip_id`, `name`, `title`, `url`, and `working`: its run is on its tab now) and `runs_live` (any Pip's run waiting or running on this computer); every lane list (`get_your_browser`, `get_your_browser_recent`) carries `working`, and a watched tab's row of Pips names each one. |
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
| `delete_archived_pip` | M, local only | `pip_id`, `expected_name`, `expected_version`, `expected_lifecycle_revision` |
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
Personal Pip from Pips API 55, `{"mode": "subscription", "engine": "claude" | "codex"}`, from API 74 with an optional `model` of that CLI: the user's
own Claude Code or Codex, held to DGC's Pip tools (docs/PIPS.md). Both SDKs refuse a subscription choice before API 55,
a `model` on it before API 74, and check its shape; `list_pip_models` then also returns `subscriptions` `[{engine, name}]` and, when DGC's default is a
subscription, `default_engine` `{engine, name, available, reason?}`. A project Pip refuses it. From Pips API 66 each
listed model may carry `context_window` (tokens) and the list says the Pips default as set, `pips_model`.
Archiving keeps all history and refuses while a run or review is unfinished;
restoring leaves the Pip paused. An exact retry with the same `request_key`
returns the original receipt without applying it again.
`delete_archived_pip` requires an archived, idle Pip and its exact name and current
version/revision. It removes the Pip's private DGC chat, runs, receipts, linked
history in other Pips, computer,
exclusive saved logins, and Pip-owned Artifacts. Shared sign-ins used by other Pips,
user exports, and files changed in project directories remain. The operation is
irreversible and is refused over a paired remote SDK connection.

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
| `list_pip_messages` | R | `pip_id`, `before_id?`, `limit?` Replies also list `waiting` (API 74): messages sent as a reply ended, in the order they'll be answered. |
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
| `get_pips_backup` | R | none; from API 76 |
| `set_pips_backup` | M | `model` (string, "" none), `provider?` ("" or a saved provider's id), `engine?` (`claude` or `codex`: Claude Code or Codex, `model` its model or ""), `router?` (`true`: DGC Router, `model` "" or `<system>/<model>`): the fallback new Pips start with; from API 76 |
| `get_pip_backup` | R | `pip_id`; from API 76 |
| `set_pip_backup` | M | `pip_id`, `model` (string; "" or null none), `provider?` ("" DGC's own connection, or a saved provider's id), `engine?` (`claude` or `codex`), `router?` (`true`), as `set_pips_backup`; from API 76 |
| `undo_pip_change` | M | `pip_id`, `change_id` (`own_<32 hex>`, from a reply's `changes`); from API 77 |
| `list_pip_conversations` | R | `pip_id`, `archived?` (bool: archived ones too); from API 79 |
| `create_pip_conversation` | M | `pip_id`, `title?` (one line, 120 characters at most); from API 79 |
| `rename_pip_conversation` | M | `pip_id`, `conversation_id` (`conv_<32 hex>`), `title`; from API 79 |
| `archive_pip_conversation` | M | `pip_id`, `conversation_id`, `archived?` (default true; false restores; never the first); from API 79 |
| `add_pip_computer` | M | `pip_id`: one more computer for the Pip, shared by its conversations (up to 3 unless raised); from API 79 |
| `get_pips_payments` | R | none; from API 75. From API 96 it answers `usd_per_day` (all Pips together, or null) and `spent_today` (in dollars) |
| `set_pips_payments` | M | from API 96, `usd_per_day` (dollars above 0, up to 1,000,000, or null for none): all Pips together, up to this a day. API 75 to 95 took `limit` (whole number, 1 to 20), a count of payments a day, retired in 96 |
| `set_pip_paying` | M | `pip_id`, `rule` (`ask` or `allow`): one Pip's rule for a payment; `allow` only at Do it all; from API 75 |
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
| `open_pip_computer` | M | `pip_id`, `number?` (API 86: which of its computers, 1 for the first; none: the one at work, else the first) |
| `use_pip_computer_view` | M | `pip_id`, `op` (`frame`, `click`, `type`, `key`, `scroll`, `go`, `back`; `pointer` from API 53: where the Pip last acted by position, no frame; `close` from API 88: its tab closed, so the computer reads closed at once), `x?`, `y?`, `text?`, `key?`, `dy?`, `url?`, `number?` (API 86) |
| `list_pip_computer_files` | R | `pip_id`, `path?`; the computer's own Files folder (API 43) |
| `read_pip_computer_file` | R | `pip_id`, `path`; `text` (first 64 KiB), or `data` up to 2 MB (API 43) |
| `list_pip_computer_terminal` | R | `pip_id`; the last 200 commands and the one running (API 43) |
| `get_pip_computer_desktop` | R | `pip_id`; whether the full screen can show here, which browser, what to install (API 43) |
| `add_pip_computer_file` | M | `pip_id`, `path?`, `name`, `data` (one data URI, 2 MB at most; outside the 32 KiB budget) (API 43) |
| `remove_pip_computer_file` | M | `pip_id`, `path` (API 43) |
| `run_pip_computer_command` | M | `pip_id`, `command`; starts it in the computer's Terminal (no internet) and returns at once (API 43) |
| `rename_pip_computer` | M | `pip_id`, `number` (1 for the first), `name` (up to 30 characters; "" gives back its first name) (API 86) |
| `set_pip_computer_screen` | M | `pip_id`, `size` (`1280x800`, `1440x900` or `1920x1080`): taken when its screen next starts (API 86) |
| `copy_pip_computer_file_in` | M | `pip_id`, `path` (its folder in Files), `source` (an absolute path on this computer): host only, refused from an app built on the SDK; up to the Files folder's 1 GB, or what Dev Mode sets (API 87) |
| `copy_pip_computer_file_out` | M | `pip_id`, `path` (a file in Files), `target` (an absolute path on this computer, where the user chose to save it): host only, as above (API 87) |
| `finish_pip_computer_check` | M | `pip_id`: the user finished a check on its screen that only a person can pass, and the Pip carries on (API 43) |
| `get_pip_computers` | R | none; every Pip computer here: its name, the disk it and its Files use, whether a reply is using it or it is being reset (API 43) |
| `update_pip_computers` | M | none; looks for newer programs for the computers (its browser, the desktop) now, not at the next daily check (API 43) |
| `reset_pip_computer` | M | `pip_id`: its computer starts afresh, signed out and with no history; its Files stay (API 43) |

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

### A Personal Pip's page: its look, apps, keys, skills and routines

All of these are local only in DGC: the user changes them on this computer, and none of them grants a Pip anything it
couldn't do before, except a switch turned back on.

| Command | | Fields |
| --- | --- | --- |
| `set_pip_profile` | M | `pip_id`, `changes`: any of `title` (60 characters at most), `body` (one of the eight Pip faces), `color`, `notify` (bool) and `group` (API 88: its folder in the Personal list, one line of up to 40 characters, "" for none) (API 43) |
| `list_pip_shared` | R | `pip_id`, `kind` (`links`, `media` or `files`): what was shared in its chat, newest first (API 43) |
| `list_pip_unread` | R | `workspace_id`: `{pips, total}`, the Pips with unread messages or run posts and how many (API 69) |
| `set_pip_chat_options` | M | `pip_id`, `chat_options`: its prompt box's context window and thinking, for its replies and all its runs (API 47) |
| `list_pip_sites` | R | `pip_id`: `{careful, sites}`, Careful mode's switch and the sites it may visit without asking (API 44) |
| `get_pip_artifacts` | R | `pip_id`: `report_as` (`chat`, `doc` or `sheet`), `dashboards` (ids), and its own document and sheet with their titles and versions (API 67) |
| `set_pip_artifacts` | M | `pip_id`, `report_as?`, `dashboards?`: with `doc` or `sheet` each finished review is also the newest version of its own document or sheet, and after every run it finishes it refreshes those dashboards (API 67) |
| `list_pip_apps` | R | none; every app your Pips use (API 43) |
| `list_pip_app_links` | R | `pip_id`: its own apps, every connected account of each, and at most one open card; a card asking for one more account of an app it has carries `another: true` (API 43) |
| `start_pip_app_link` | M | `pip_id`, `link_id`, `account?` (one of the accounts it answered with; none is linked until one is named), `another?` (true: sign in to one more account; API 74) (API 43) |
| `check_pip_app_link`, `decline_pip_app_link` | M | `pip_id`, `link_id`: whether its sign-in finished; Not now on its card (API 43) |
| `disconnect_pip_app_link` | M | `pip_id`, `link_id`: the Pip stops using that account, and any Always allow it was given on it ends with it; the plugin stays connected for other uses (API 43) |
| `get_pip_apps` | R | `pip_id`: `apps` [{id, name, kind (`plugin`: turned on in Settings; `app`: reached through Composio), on, accounts?}] (API 88) |
| `set_pip_app` | M | `pip_id`, `app` (an id from `get_pip_apps`), `on` (bool): for that Pip alone; its link stays while it is off (API 88) |
| `add_pip_app_account` | M | `pip_id`, `app`: `{link}`, a Connect card for one more address of an app it has, then the usual `start_pip_app_link` and `check_pip_app_link` (API 88) |
| `list_pip_keys` | R | `pip_id`: its key cards, never a value (API 82) |
| `save_pip_key` | M | `pip_id`, `key_id`, `value` (16,384 characters at most; never answered), `terminal?` (API 85) (API 82) |
| `decline_pip_key`, `remove_pip_key` | M | `pip_id`, `key_id`: Not now (no new card for that site for a day); forget a saved key (API 82) |
| `get_pip_skills` | R | `pip_id`: `skills` [{name, description, source, on}] (API 88) |
| `set_pip_skill` | M | `pip_id`, `skill`, `on` (bool): a skill switched off is never offered to its model (API 88) |
| `export_pip_team` | R | `pip_ids` (1 to 20), `name`: `{document, text}`, one `dgc-team` file holding each Pip's shareable file (no accounts, IDs, memory or history) (API 88) |
| `get_pip_webhook`, `replace_pip_webhook_address`, `set_pip_webhook_signing`, `send_pip_webhook_test` | R, M, M, M | `pip_id`, `routine_id`, `secret` (signing: text or null): a routine's own webhook address (API 90) |
| `get_webhook_reach`, `set_webhook_reach` | R, M | `local_network`, `tunnel` (`tailscale`, `own` or null), `own_base`: how calls reach this computer (API 90) |
| `list_pip_project_choices`, `list_pip_project_changes`, `get_pip_project_change` | R | `pip_id`, `change_id`, `path`: a Pip's project copies (a Personal Pip's @ copies; from API 95 a folder Pip's own copy too) and what changed in them (API 91) |
| `apply_pip_project_change`, `discard_pip_project_change`, `undo_pip_project_change` | M | `pip_id`, `change_id`, `expected_digest` (apply): what you decide about a change (API 91) |
| `list_project_folders`, `add_project_folder` | R, M | `folder`: the folders with a session or a Project Pip; a folder added as a project (API 93) |
| `set_pip_goal`, `get_pip_goal`, `stop_pip_goal` | M, R, M | `pip_id`, `objective`, `conversation_id`, `goal_id`: a goal for a Pip's conversation (every Pip's from API 96) (API 92) |
| `delete_pip_routine` | M | `pip_id`, `routine_id` (API 43) |
| `decide_pip_routine` | M | `pip_id`, `routine_id`, `add` (bool): the user's Add routine, or Not now, on a routine the Pip suggested in its chat (API 43) |

A Pip can hold several accounts of one app. With one, DGC uses it on every call; with several, the Pip's model names one
on each call, and nothing picks a default for the user: a host that shows an Allow card for a Pip with several accounts
of that app lets the user choose which one sends it. Every app is on until it is switched off; an app switched off is
refused on every path (its plugin isn't listed or callable, its reads and sends are refused, and the Pip can't ask for
it), and switching it back on needs no new sign-in.

A team file is imported in the editor, which makes one pending setup card per Pip (`list_pip_setups`); the SDK has no
import command.

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

# FastAPI or Starlette: app.add_route("/dgc/pips", handler.asgi, methods=["POST"]). (app.mount answers the bare
# address with a 307 to "/dgc/pips/", which DGC never follows: register a mounted handler with the trailing slash.)
# Any WSGI server: handler.wsgi.
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
me or Do it all). An Always allow-ed change was never waiting, so it has no `approval_requested`, only its
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

### Pips in code (API 64)

Your app can declare its Personal Pips in code, one `PipTemplate` each, and make the real Pips match on every deploy:
`ensure_all` creates the ones that don't exist yet and brings the others up to date, safely. A template says what the
Pip is (its name and instructions), what it may use (your app's tools), how much it asks, and what it does on its own
(its routines).

**A worked example: the shop.** The shop's own web app registers its tools once, serves DGC's calls and approvals at
`/dgc/pips`, tells DGC when an order is placed, and keeps two Pips: **Dunning**, which lists unpaid orders every weekday
morning, and **Dispatch**, which reads each new order and proposes its dispatch.

```python
import os
from flask import Flask, jsonify, request
from dgc_sdk import DGC, DGCCommandRejectedError, PipTemplate, define_pip_tool
from dgc_sdk.pips_app import AppToolHandler

# 1. The app's tools: two reads, two changes.
UNPAID = define_pip_tool("find_unpaid_orders", "Orders still unpaid after N days: id, customer, total, days unpaid",
                         {"type": "object", "properties": {"days": {"type": "integer", "minimum": 1}},
                          "required": ["days"], "additionalProperties": False}, kind="read")
ORDER = define_pip_tool("get_order", "One order by its id: customer, items, total, address and whether it is paid",
                        {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"],
                         "additionalProperties": False}, kind="read")
DISPATCH = define_pip_tool("create_dispatch", "Create the dispatch (a courier pickup) for one paid order",
                           {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"],
                            "additionalProperties": False}, kind="change")
REMIND = define_pip_tool("send_reminder", "Email the customer one polite payment reminder for an unpaid order",
                         {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"],
                          "additionalProperties": False}, kind="change")
TOOLS = [UNPAID, ORDER, DISPATCH, REMIND]

# 2. The app's Pips, in code.
WEEKDAYS_9_30 = {"schedule": {"type": "cron", "cron": "30 9 * * 1-5", "timezone": "Asia/Kolkata"}}
TEMPLATES = [
    PipTemplate(key="dunning", name="Dunning", model="deepseek-v4.1-flash:cloud",
                instructions="Chase unpaid orders. List each one with its customer and total; never promise a refund.",
                tools=["app:shop/find_unpaid_orders"],
                routines=[{"title": "Unpaid orders", "when": WEEKDAYS_9_30,
                           "prompt": "Find the orders unpaid for 7 days or more and list them for me."}]),
    PipTemplate(key="dispatch", name="Dispatch", model="deepseek-v4.1-flash:cloud",
                instructions="Get paid orders dispatched. Read the order first; a dispatch always waits for my Allow.",
                tools=["app:shop/get_order", "app:shop/create_dispatch"],
                routines=[{"title": "New orders", "when": {"app": "shop", "event": "order.created"},
                           "prompt": "Read the new order with get_order. If it is paid, propose one create_dispatch."}]),
]

dgc = DGC(inherit_user_state=True, sandbox="off")
s = dgc.session(cwd=".")

# 3. The deploy step: the app's tools, then its Pips.
def deploy():
    try:
        app = s.pips.register_app("shop", url="http://127.0.0.1:5005/dgc/pips", tools=TOOLS, approved=True)
        print("Keep this secret for DGC_PIPS_SECRET:", app["secret"])        # shown this once
    except DGCCommandRejectedError as exc:
        if exc.reason != "app_exists":
            raise
        s.pips.update_app("shop", tools=TOOLS, approved=True)   # a new tool waits for a person
    done = s.pips.ensure_all(TEMPLATES, prune=True, approved=True)
    for pip in done["pips"]:
        print(pip["notice"])       # "Made Dunning from its template." / "Dispatch already matches its template."

# 4. DGC's calls, the approvals it sends, and the shop's own pages.
waiting = {}
handler = AppToolHandler(os.environ["DGC_PIPS_SECRET"], tools={
    UNPAID: lambda args, ctx: db.unpaid(args["days"]),
    ORDER: lambda args, ctx: db.order(args["order_id"]),
    DISPATCH: lambda args, ctx: shipping.dispatch(args["order_id"], receipt=ctx.approval_id),
    REMIND: lambda args, ctx: mail.reminder(args["order_id"], receipt=ctx.approval_id),
}, on_approval_requested=lambda e: waiting.__setitem__(e.action_id, e),
   on_approval_resolved=lambda e: waiting.pop(e.action_id, None))

web = Flask(__name__)

@web.post("/dgc/pips")
def pips():
    return handler.flask(request)

@web.post("/orders")
def place_order():
    order = db.add(request.get_json())
    s.pips.trigger("shop", "order.created", {"order_id": order.id, "total": order.total}, idempotency_key=order.id)
    return jsonify(id=order.id)

@web.post("/admin/approvals/<action_id>")
def decide(action_id):      # a person's choice on the shop's admin screen
    event = waiting[action_id]
    s.pips.decide(action_id, request.form["decision"], expected_digest=event.action_digest, approved=True)
    return "", 204
```

`deploy()` runs at every start. The first time it makes both Pips (`created: true`); after that it answers `unchanged:
true` until the code changes. Move Dunning's routine to 10:00 and the next deploy applies it. Add
`"app:shop/send_reminder"`, a change, to Dunning's `tools` and the next deploy saves it as a change that waits for a
person on Dunning's page in DGC (`waiting`); once accepted there, Dunning may propose reminders, each one an Allow card. When a customer orders, `trigger` runs Dispatch's routine: it reads the order and
proposes `create_dispatch`, which waits as an Allow card in DGC and as an approval on the shop's admin screen.

The same templates in TypeScript:

```typescript
import { definePipTemplate } from "@vibedgc/sdk";

const templates = [
  definePipTemplate({ key: "dunning", name: "Dunning", model: "deepseek-v4.1-flash:cloud",
    instructions: "Chase unpaid orders. List each one with its customer and total; never promise a refund.",
    tools: ["app:shop/find_unpaid_orders"],
    routines: [{ title: "Unpaid orders", when: { schedule: { type: "cron", cron: "30 9 * * 1-5", timezone: "Asia/Kolkata" } },
      prompt: "Find the orders unpaid for 7 days or more and list them for me." }] }),
  definePipTemplate({ key: "dispatch", name: "Dispatch", model: "deepseek-v4.1-flash:cloud",
    instructions: "Get paid orders dispatched. Read the order first; a dispatch always waits for my Allow.",
    tools: ["app:shop/get_order", "app:shop/create_dispatch"],
    routines: [{ title: "New orders", when: { app: "shop", event: "order.created" },
      prompt: "Read the new order with get_order. If it is paid, propose one create_dispatch." }] }),
];
const done = await session.pips.ensureAll(templates, { approved: true, prune: true });
```

**A template.**

| Field | |
| --- | --- |
| `key` | Its stable id: 1 to 40 of `a-z`, `0-9`, `-`, unique in the profile. DGC keeps it on the Pip, so the same key is always the same Pip, whatever its name. |
| `name`, `instructions` | Its name (one line, up to 120 characters) and its job (up to 4,000). |
| `model` | A model id from `list_pip_models`, or none for DGC's own default. Never a personal Claude Code or Codex plan; and when the runner runs with `--server`, DGC's default may not be one either ([Pips on a server](#pips-on-a-server)). |
| `level` | How much it asks: `ask` (the default for a template), `approve` or `full`. A payment asks at every level. |
| `tools` | Up to 64: your apps' tools as `app:<name>/<tool>`, and `computer` for its own computer. A Pip's other connections (Gmail, Calendar, plugins, connectors) need a person's own sign-in or consent: a template can't name them. |
| `routines` | Up to 10 `{title, prompt, when}`: `when` is a schedule (`{"schedule": {...}}`, the schedule shapes of [PIPS_REFERENCE.md](../docs/PIPS_REFERENCE.md#schedules-and-event-triggers)) or one of your app's events (`{"app": "shop", "event": "order.created"}`). A routine is known by its title. |
| `always_allow` | Change tools in `tools` it may run without asking (`alwaysAllow` in TypeScript). Never a read, and never a tool marked `moves_money`: DGC refuses the template (`asks_every_time`), with `accept_widening` too. |

`PipTemplate` (Python) and `definePipTemplate` (TypeScript) check all of this where the template is made. DGC checks
it again, against your apps as they are now.

**What `tools` means.** Every Personal Pip may use every registered app ([Your own app's tools](#your-own-apps-tools-api-61)). A Pip made from a template
may use only the app tools its template lists: its runs are given those, and a call to another is refused before your
app is called. That way your code decides exactly what each of its Pips may call, and a new change tool is a decision
someone sees. Every other Pip keeps every registered app, as before. A listed tool your app doesn't have now (not
registered, or its update still waits in Pips settings → Apps) is left out and said in `unavailable`; the first ensure
after it exists adds it, as the rules below say.

**Bringing a Pip to its template.** Each difference is applied, or it waits:

- **Applied at once** (narrowing or neutral): its name, instructions and model; a tool, a routine or an Always allow
  taken away; a lower level; a routine's prompt, or its time; a new routine on a schedule; a new read tool.
- **Waits for a person** (widening): a new change tool, its own computer, a higher level, a new Always allow, and a
  routine that newly runs on your app's event. They wait together as one change on the Pip's page in DGC, **Your code
  asks to let Dunning do more**, with **Accept** and **Not now**; its id is in `waiting`. The same template again keeps
  the same change; a template that asks for something else replaces it; one that no longer asks withdraws it. A change
  a person turned down isn't asked again while the template asks for exactly it (its id is in `declined`).
- **`accept_widening=True`** applies the widening in the same call, without a person. Your app then takes
  responsibility for what the Pip may do: use it for a Pip whose growth you have already agreed with its owner, not to
  get past the card. A tool that moves money is never Always allowed, either way.

A new Pip is made as its template says, with one exception: its Always allow, which only a person has given so far,
waits like any widening (unless `accept_widening`).

**Changes a person made in DGC are kept.** DGC remembers what ensure last applied. A field that differs from it now was
changed by a person in DGC (its name, its level, a routine, an Always allow they stopped, its computer): ensure leaves
it as they set it and lists it in `conflicts`, `{field, item?, pip, template, words}`, every time, until the template
agrees or `overwrite_user_changes=True`. Overwriting still never widens on its own: giving back more than the person
left waits for them like any widening. A Pip someone paused or archived stays so: ensure never resumes a Pip a person
paused.

**The answer.** `{pip_id, key, name, created, applied: [{field, item?, words}], waiting: [change ids], declined: [change
ids], unchanged, conflicts, unavailable: [{tool or routine, words}], notice}`. `unchanged` is true when this call made,
applied, saved and withdrew nothing. `notice` says it all in words.

**Deploys.** `ensure_all(templates, prune=False)` checks every template first (each key once), ensures each in order,
and answers `{pips: [each answer], pruned, waiting, unchanged}`. DGC refusing one stops there, before anything is
pruned. With `prune=True`, every Pip made from a template whose key is no longer listed is paused, never deleted, and
listed in `pruned`; a key that comes back resumes its Pip.

| Command | | Fields |
| --- | --- | --- |
| `ensure_pip_template` | M | `template`, `accept_widening?`, `overwrite_user_changes?`. Answers as above. Refused `invalid_template`, `asks_every_time`, `model_not_available` or `server_subscription` before anything changes. |
| `prune_pip_templates` | M | `keep` (the keys to keep, up to 100). Answers `{pruned: [{pip_id, key, name, status, words}], already, kept, notice}`. |
| `list_pip_templates` | R | `pip_id?`. Answers `{templates: [{key, pip_id, name, status, pruned, level, tools, always_allow, routines, created_at, updated_at, waiting, declined}]}`; `waiting` and `declined` are a change `{id, pip_id, key, status, digest, items: [{kind, ..., words}], words, created_at, decided_at, decided_by}` or null. |
| `decide_pip_template_change` | M | `change_id`, `decision` (`accept` or `reject`), `expected_digest` (its `digest`). Exactly once: a change already answered, or withdrawn, answers `decided: false`. Answers `{change, decided, applied, notice}`. |

`decide_template_change` is the same decision as DGC's card. Call it from a person's choice on your own screen, never
from code alone: `accept_widening` is how code decides, and says so.

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
