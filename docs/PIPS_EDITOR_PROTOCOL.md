# Pips in the editor protocol

This page is for integrators who drive `dgc serve` over the editor protocol. Pips add
a few commands and events to **protocol v14**; the protocol version does not change.
The Pips controls themselves are versioned separately as the **Pips API** (currently
40). The authoritative declarations are in `dgc/editor_protocol.py`, which also
generates the JSON schemas and the extension's `protocol.generated.ts`.

The SDKs wrap the same controls as `session.pips`; see [sdk/PIPS.md](../sdk/PIPS.md).
For what each control does, see [PIPS_REFERENCE.md](PIPS_REFERENCE.md).

## Capabilities

`ready.capabilities` carries the Pips fields. They live inside the extensible
capabilities object, so strict older clients still accept the handshake.

```json
{
  "pips_supported": true,
  "pips_api_version": 42,
  "pips_enabled": true,
  "pips_setup_notifications": 1,
  "pip_references": 1,
  "workspace_identity": {"workspace_id": "ws_…", "workspace_binding_id": "binding_…", "runner_id": "…"}
}
```

- Check `pips_supported` and `pips_api_version` before sending any Pips command,
  and gate newer controls on the API version (the table at the end of
  [PIPS_REFERENCE.md](PIPS_REFERENCE.md#pips-api-history) lists what each version
  added). The backend never sends Pips events to a client that didn't ask.
- `pips_enabled` reflects the `pips_enabled` setting, which is on by default.
- `workspace_identity` is filled in only when Pips are on, the profile already uses
  Pips and the chat has a saved session; otherwise it is `{}`.
  The IDs come from the private registry, never from a transcript.
- `pips_setup_notifications: 1` means the backend accepts `notify_pip_setup` (below).
- `pip_references: 1` means the backend accepts `list_prompt_pips` and
  `pip_references` on `prompt`.
- `pip_reports: 1` means a finished Pip run that reports to this chat can arrive as a
  card in its transcript ([Reports reach the chat](PIPS.md#reports-reach-the-chat)). A
  client that draws them sends `{"type": "watch_pip_reports"}`; until one does, the chat
  is sent nothing and no report is taken. Then each arrives as
  `{"type": "pip_report", "report": {...}}` (an open object: `run_id`, `pip_id`, `name`,
  `pip_type`, `kind`, `outcome`, `finished_at`, `earlier`, and the findings, checks or
  failure reason), and history replays it as `{"role": "pip_report", "report": {...}}`
  after the turn it arrived in. `{"type": "pip_report_dismiss", "run_id": "run_…"}`
  removes one; it is saved with the chat. A report never starts a turn.

## Commands and events

### `pips_control`

Every Pips operation is one nested control request:

```json
{"type": "pips_control", "request": {"type": "list_workspaces", "request_id": "r1"}}
```

The reply is a `pips_result` event that carries the nested request ID:

```json
{"type": "pips_result", "request_id": "r1", "command": "list_workspaces", "ok": true, "result": {}}
{"type": "pips_result", "request_id": "r2", "command": "run_pip", "ok": false,
 "error": {"code": "runner_required", "message": "Start the Pips runner before requesting work. …"}}
```

- `request.type` is one of the backend's control commands (96 of them; the SDK
  documents each one's fields). Unknown commands and unknown fields are refused.
- `request.request_id` is required: 1 to 128 characters. The outer command has no
  `request_id` of its own.
- A request must be small, shallow JSON: at most 32 KiB on the wire, 8 levels deep,
  256 values, 64 fields per object and 64 items per list, with safe finite numbers.
  The controller then applies its own size limit: 16 KiB for most commands, 32 KiB
  for handoff and external-action proposals and draft preparation. Replies are at
  most 128 KiB.
- The editor can't supply filesystem roots, credentials, model routes or
  permissions. The actor is always `editor-user`. `list_workspaces` resolves the
  backend's own project folder and returns
  `{workspaces, current_workspace_id, runner_id}`.
- Controls run on their own worker thread, so they are allowed during a chat turn and
  never touch the chat's agent. At most 16 controls can be pending; more get a `busy`
  error.
- `check_pip_source {pip_id, source_policy?}` and `get_pip_run_source {run_id}` (API 50, local only)
  say whether a Pip's source fits a run (for its saved policy, or an unsaved one the Source form is
  editing) and what one run's copy left out; see **Source** in
  [PIPS_REFERENCE.md](PIPS_REFERENCE.md). The host refuses both before sending to a CLI below API 50,
  and the editor sends a `safe_source_v2` policy in `propose_pip_update` only from API 50.
- `list_pip_run_posts {pip_id, before_id?, limit?}` (API 51) reads what a Pip's runs posted in its own
  chat, oldest first, a page at a time; see **Runs in the Pip's own chat** in
  [PIPS_REFERENCE.md](PIPS_REFERENCE.md). The host refuses it before sending to a CLI below API 51; from
  API 51 the editor draws each post among the chat's messages, renames Runs to History and says what each
  run found there. **Ask DGC to fix** on a post goes to the Work chat: the side bar's Sessions home sends
  the extension `pipAskDgc {report, session}`, which opens that session's tab (`get_pip`'s
  `report_session`, or a new session) and hands it the report; once that chat is ready it starts the
  background fix (`start_pip_fix {run_id}`, offered as `ready.capabilities.pip_fix`), which shows the run's card
  there when the chat never had it, unless that report's fix is already working. Against a CLI without
  `pip_fix` it sends the Work chat card's prompt instead, unless the transcript already names the run.
- `list_pip_run_fixes {pip_id}` (API 65, local only) reads what Ask DGC to fix did for each of the Pip's runs; see
  **Runs in the Pip's own chat** in [PIPS_REFERENCE.md](PIPS_REFERENCE.md). The host refuses it before sending to a
  CLI below API 65. The editor reads it with the posts (opening the Pip, every 4 seconds while its chat or History is
  on screen, coming back into view) and draws each post's fix from it, never from the view's own memory. A click on a
  fix sends the extension `pipOpenFix {session, run_id}` (the Sessions home, or a session's tab when the fix ran in
  another), which opens that session's tab and sends it `pipShowFix {run_id}`: the chat shows the fix's card once it
  is drawn. In the chat the fix ran in, the Pips page closes and shows the card itself.
- `introduce_pip {pip_id}` (API 43, local only) queues a new Personal Pip's first message once and
  returns `{run, message}` like `send_pip_message`. That message has `intro: true` in
  `list_pip_messages`; the editor hides it and shows the Pip typing until its reply arrives.
- `send_pip_message` may carry `images` (API 43, Personal Pips): up to 4 image data URIs, 2 MB in
  all, and then `text` may be empty. A listed user message carries `images: [{index, mime, bytes}]`;
  `get_pip_message_image {pip_id, message_id, index}` (API 43) returns one as `{image}`. The host
  refuses both before sending to a CLI below API 43. The images are the one field outside the
  16 KiB request bound (32 KiB in `dgc serve` and the SDKs): they are bounded on their own, at
  every hop, to 4 data URIs and 2,800,000 characters in all, and the rest of the message keeps its
  bound.
- `send_pip_message` may also carry `files` (API 43): up to 4 `{name, data}` (text, code or the
  documents the main chat reads), 2 MB in all within the same 2,800,000-character budget as the
  images. A listed user message carries `files: [{index, name, bytes}]`. The host refuses `files`
  before sending to a CLI below API 43, and refuses images and files over the shared budget.
- From API 52 the host sends a message's photos and files the main chat's way: it writes each into
  the backend's image spool (`ready.capabilities.image_spool_dir`, mode 0600, a fresh random name)
  and sends `spooled_images: [{name, media_type}]` and `spooled_files: [{name, spool}]` instead of
  `images` and `files`, so the frame carries names, not megabytes. The view still hands the host data
  URIs; the host checks them against the API 52 limits first (8 MB a photo and 32 MB of photos, up to
  64; up to 16 files, a document 16 MB, a text or code file 1 MB, 32 MB in all) and removes what it
  wrote when the send never reaches DGC or DGC refuses it. An iPhone photo goes as `image/heic` or
  `image/heif`, and DGC keeps it as a JPEG; the view shows its chip by name, since Chromium can't draw
  one. A spool the host can't write falls back to the inline path when the message fits it. The host
  refuses `spooled_images`, `spooled_files` and `as_file` from the view (they are the host's), with
  "Update DGC…" below API 52; see **Photos and files through the spool** in
  [PIPS_REFERENCE.md](PIPS_REFERENCE.md).
- From API 52 the host reads a sent photo itself: it sends `get_pip_message_image` with
  `as_file: true`, checks the answer's `path` is a regular file named by its digest under the Pips
  state's `chat_images/<pip_id>/`, of the size and type DGC said, and gives the view the usual
  `{image}`. A big thumbnail is redrawn small in the view; clicking it posts
  `pipsOpenPhoto {pip_id, message_id, index}`, and the host opens the original in an editor tab under
  a readable name (`Photo 1.jpg`). Under hidden WSL the bridge translates that `path` like the main
  chat's image paths.
- `run_pip`, `send_pip_message` and `accept_pip_handoff` first check that the
  independent runner is live (a fresh heartbeat and a held lease). The backend never
  starts a worker of its own to run Pips work. If the runner stops after the check,
  accepted work stays queued.
- `list_pip_run_activity {run_id, after?}` pages a run's activity: at most 50 events
  or 96 KiB per page, with `next_cursor`, `oldest_cursor`, `has_more`,
  `retention_limit`, `retention_scope` and `history_may_be_truncated`. Each workspace keeps its latest 5,000 events.

`list_pip_starters {request_id}` and `propose_starter_pip {request_id, starter, params}`
(API 41) are nested controls handled by the chat backend, because a setup card belongs
to a chat. The first returns `{starters: [...]}`: each has `id`, `title`, `summary`,
`pip_type`, `scope`, `name`, `when` (`commit`, `daily`, `weekdays` or `weekly`),
`default_time`, the `params` it takes (`branch`, `time`, `timezone`, `web_reads`) and
`web_example`, an example of what to read (text, or null). The second saves one pending setup card for this chat
from the starter's fixed job and the checked choices, and returns `{setup}`; it creates
no Pip and starts nothing. A setup may carry `event_trigger`
(`{events: ["commit_changed"], minimum_minutes, missed_policy}`) with a null `schedule`:
the approved Pip reviews after each new commit to `source_ref`.

`always_allow_pip_app_action {action_id, expected_digest}` (API 41, local only) runs one pending
action and returns `{action, grant}`; `list_pip_action_grants {pip_id}` and
`revoke_pip_action_grant {pip_id, grant_id}` return `{pip_id, grants}`. The digest may carry
`pending_actions` (drafts and prepared actions waiting).

`set_pip_feedback {run_id, rating, note}` and `list_pip_feedback {pip_id}` (API 41, local
only) rate a succeeded Personal task, audit or Quill draft and list the newest 20 ratings
`{pip_id, feedback: [{run_id, rating, note, at}]}`. `rating` is `"up"`, `"down"` or null.

`export_pip {pip_id}` (API 41, local only) returns `{document, text}`, a shareable `dgc-pip`
file. `import_pip_document {request_id, document}` is a nested control handled by the chat
backend, like `propose_starter_pip`: it saves the file as a pending setup card for this chat
and returns `{setup, left_out}`. The extension host reads and writes the files itself
(`export_pip_file`, `import_pip_file` from the Pips view).

`get_pip_usage {pip_id}` (API 41, local only) returns `{usage: {pip_id, today,
last_30_days, days, daily_cap, capped_today}}`; the Job tab draws it as Usage. Pips have no
daily limit: `daily_cap` is always null and `capped_today` false, and `set_pip_daily_cap`
(kept for older editors) refuses a number.

`get_pips_desktop_notifications {}` and `set_pips_desktop_notifications {enabled}` (API 41,
local only) return `{desktop_notifications: {on, available, platform, last}}`; `last` is
`null` or `{shown, at}`, whether the runner's last desktop notification actually showed.
The extension host itself sends `get_pip_digest` (request ids `pips-host-…`) once a minute
for its own notification; those replies never reach a webview.

`get_pips_keep_running {}` and `set_pips_keep_running {enabled}` (API 41, local only)
return `{keep_running: {platform, supported, reason, on, starts_at_login,
restarts_after_failure, while_logged_out}}`. The Pips view shows them as one switch beside
the runner, and only the reason when `supported` is false.

The digest controls (API 41) are local only (`editor-user`):
`get_pip_digest {}` returns `{digest}`, or `{digest: null}` when the profile has never
used Pips (no registry is created). `mark_pip_digest_seen {until}` takes the digest's
own `until` and never moves backwards. `get_pip_notify_settings {pip_id}` and
`set_pip_notify_settings {pip_id, min_severity, alert_severity, expected_revision}`
read and change one Pip's display settings without a job review.
`get_pip_outcomes {pip_id}` returns `{outcomes}` counts. `propose_pip_update` accepts
`changes.github_plan` from API 41; the extension refuses to send it to an older backend
and shows the plan in the proposal review. The main chat's Pips bar polls
`get_pip_digest` every minute while connected and after each turn; see
[PIPS_REFERENCE.md](PIPS_REFERENCE.md#schedules-and-event-triggers) for what a
digest contains and when it is due.

From API 48, `mark_pip_news_seen {pip_ids, until}` (local only, 1–50 Pips) marks those
Pips' news seen up to the digest's own `until`: their runs, findings and skipped runs
until then leave the digest, and a run that ends later brings a Pip back. It answers
`{seen: [{pip_id, seen_until}]}` and never moves backwards. The side bar's home sends it
for a row's ✕ and for **Dismiss all**; the extension refuses it before API 48.

The computer controls (API 42) are local only (`editor-user`):
`get_pip_computer {pip_id}` returns `{computer: {pip_id, granted, available, reason, pending,
actions}}` with the newest five actions. `list_pip_computer_actions {pip_id, limit?}` returns
`{actions}`, each `{id, pip_id, workspace_id, run_id, summary, digest, frame, status,
created_at, expires_at, resolved_at, resolved_by, continuation_run_id}`; `summary` is
`{method, host, path, page, fields: [{name, value}], more_fields, body_bytes}` with
secret-named values already masked. `decide_pip_computer_action {action_id, expected_digest,
approve}` returns `{action}`; the supervisor sends or drops the request within seconds.
`always_allow_pip_computer_action {action_id, expected_digest}` approves it and saves a
`computer_submit` grant for the same method, host and path on that Pip, in one step; it returns
`{action, grant}` (a grant row as in `list_pip_action_grants`). `summary.payment` is `true` when
the request carries a card number.
`get_pip_computer_frame {run_id, frame}` returns `{run_id, frame, image}` (a JPEG data URL) and
`list_pip_computer_frames {run_id}` returns `{run_id, frames}`. `stop_pip_computer {pip_id}`
returns `{pip_id, stopping: true}`. `open_pip_computer {pip_id}` asks the supervisor to open the
live view and returns `{view: {pip_id, ready, host_id?}}`; `use_pip_computer_view {pip_id, op, x?, y?,
text?, key?, dy?, url?}` returns `{view}`: `{ok: true, watching, url, width, height, image}`,
or `{ok: false, error, ready?}` while it opens or after it closes. `propose_pip_update`
accepts `changes.computer_plan` from API 42; the extension refuses to send it, or any of these
commands, to an older backend.

**Eyes and a cursor** (API 53). A `frame` reply also carries `pointer` once the Pip has acted by
position: `{kind, x, y, from_x?, from_y?, at, seq}` (`kind` one of `click_at`, `double_click_at`,
`right_click_at`, `drag`, `scroll_at`, `hover_at`; `x`, `y` in the page's CSS pixels, the frame's
`width` × `height`), plus `screen_x`, `screen_y`, `screen_width` and `screen_height` when the browser
is a window on the computer's desktop. `use_pip_computer_view {pip_id, op: "pointer"}` returns
`{view: {ok: true, watching, pointer}}` with no frame (`pointer` may be null). `list_pip_computer_frames`
takes `pointers: true`; each row of a step by position then also has `pointer {kind, x, y, from_x?,
from_y?}` in that screenshot's pixels, and without it the rows are exactly `{frame, label, url, at}`.
`get_pip_eyes {pip_id}` and `set_pip_eyes {pip_id, choice: "ask" | "relay" | "off"}` return `{eyes:
{pip_id, model, sees, choice, vision_model}}` (`sees` true, false or null). The extension sends none of
these, nor `pointers` or op `pointer`, to an older backend. It draws the Pip's cursor (an arrow and its
name) over the frame, or over the full screen from the `screen_*` fields while it asks op `pointer`
every 700 ms; "What it saw…" draws each row's pointer, and a drag's path, over its screenshot; and a
Personal Pip's page shows **Seeing** with the choice. A text-only Pip's card in its chat is an
ordinary reply with `choices`; a tap sends the choice's words, and the backend recognises them.

**The whole desktop** (API 54). A Pip whose model sees also acts on its whole screen (other windows,
its apps); those steps reach the editor through the same fields: the live view's `pointer` is the API 53
shape with its `kind` one of the same six and `screen_x`/`screen_y` set, and a timeline row stays
`{frame, label, url, at}` plus `pointer` in that screenshot's pixels (the whole screen), so an older
editor draws both. `get_pip_computer_apps {}` returns `{apps: {apps: [{key, name, program, available}],
missing, state, line, bytes}}` (`key` `images` | `documents` | `pdf`; `state` `ready` | `measuring` |
`offer` | `downloading` | `declined` | `unavailable`; `bytes` the download's size or null) and
`set_pip_computer_apps {choice: "download" | "not_now"}` answers the offer and returns the same. The
computer tab asks it with `get_pip_computer` and shows `line` once: in `offer` with **Download** and
**Not now**, in `downloading` and `unavailable` as a plain line, otherwise nothing. Below API 54 the
extension sends neither request.

**Your own Claude Code or Codex** (API 55). A Personal Pip's `model_choice` may be `{mode:
"subscription", engine: "claude" | "codex"}` in `create_pip`, `propose_pip_update` and
`revise_pip_setup`, and "Same as DGC" follows DGC's subscription default. `list_pip_models`
adds `subscriptions` `[{engine, name}]` (installed and signed in here) and, when DGC's
default is a subscription, `default_engine` `{engine, name, available, reason?}`. The Pip's
chat box model list shows them under **Your subscriptions** for a Personal Pip only, names
the subscription beside **Same as DGC**, and says once, where one is chosen, "Its replies and
routines use your NAME plan's usage." No event changes: the run streams the same
`pip_run_progress` rows and its computer the same frames. The host refuses a subscription
`model_choice` before sending to a CLI below API 55 ("Update DGC to run a Pip on your own
Claude Code or Codex."); an older editor shows such a Pip's model as **Same as DGC**.

**Saved logins** (API 56). Four `pips_control` requests: `list_pip_logins {pip_id?}`,
`save_pip_login {pip_id, username, password, totp?, pips?: "only" | "all", site | action_id +
expected_digest}`, `remove_pip_login {login_id}` and `grant_pip_login {login_id, pips: "all" |
[pip ids]}`; no event and no event field changes. A Pip computer's `actions` may include one of
kind `login` (summary `{method: "SIGN IN", host, path, page, site, shown, sign_in_page, fields:
[]}`): the chat shows it under the reply as **Save a login for SITE so PIP can sign in itself?**
with **Save login…** and **Not now** (`decide_pip_computer_action` approve false); approving it
any other way is refused (`save_login`). **Save login…** opens a dialog of its own (site fixed
from the card; from the Pip's page, a site box), reads its boxes once on Save and sends
`save_pip_login` with the card's `action_id` and digest, then empties them; nothing of it goes
in the view's state, a draft or the chat. The Pip's page shows **Logins** (`list_pip_logins`
with its `pip_id`): each it may use with **All Pips** (`grant_pip_login` `"all"` or `[this
Pip]`) and **Remove** (asks once), the ones for other Pips with **Let PIP use it**, and **Save a
login…**. The computer tab shows a `login` action with **Not now** only. The host refuses all
four before API 56 ("Update DGC to save logins for your Pips.") and keeps only the request's
type while it waits for the answer.

**How much it asks** (API 58). Two `pips_control` requests, both local: `get_pip_level {pip_id}` and
`set_pip_level {pip_id, level: "ask" | "approve" | "full"}`, each answered with `{pip_id, level, default, levels:
[{level, name, says}], on_its_own: [{at, what, level: "approve" | "full", unattended, kind: "site" | "computer" |
"app"}]}`. No event and no event field changes. A Personal Pip's page shows **How much it asks**: a picker of the three
`levels` by `name`, the chosen one's `says` under it, and, when `on_its_own` has any, **What it did on its own** (the
newest five: `what`, when, the level's name, "nobody at the keyboard" for `unattended`) with **Ask me again from now
on** (`set_pip_level` `ask`). Choosing a level shows its `name: says` once as the notice. A Pip computer's `actions`
now include ones its level let through: `status: "sent"`, `resolved_by: "pip-level:approve" | "pip-level:full"`, and
`summary.what`, `summary.level`, `summary.unattended`; the extension shows them only through `on_its_own` and the run's
timeline, whose labels already name them. A pending action may carry `summary.asks_because` (`payment`,
`consequential`, `unsure`): its card under the reply adds one line saying why the level still asks, and one of
`payment` is titled **Pay on HOST?**. A pending action of kind `floor` (the safety floor: `summary.floor`, the command
as `fields[0].value`) is shown as **Let PIP run this in its Terminal?** with **Allow once** and **Not now**. `get_pip_computer`
lists pending actions first. The host refuses both requests before API 58 ("Update DGC to choose how much a Pip
asks.") and an older CLI is asked for neither.

**Borrowing your own Chrome** (API 59). Four `pips_control` requests, all local: `list_pip_borrows {pip_id}`
(answered `{pip_id, minutes, borrows: [{id, pip_id, workspace_id, status, sites, origins, why, reachable,
unreachable, unattended, minutes, chrome, ended, sent, created_at, expires_at, allowed_at, started_at, ended_at}]}`),
and `allow_pip_borrow`, `decline_pip_borrow` and `stop_pip_borrow`, each `{pip_id, borrow_id}` and answered
`{borrow: …}`. No event and no event field changes. A Personal Pip's chat shows, below its latest reply, a `requested`
card as **Let PIP use your Chrome?** with `why`, the `sites` and the time limit, `unreachable` when its Chrome can't be
reached, and **Allow once** and **Not now** (no Always allow; both wait while the Pip's reply is still being
written); an `allowed` or `in_use` one as **Using your Chrome · SITE** with **Stop**; a `returned` one, until the user
writes again, as one line: **Gave your Chrome back** (· you stopped it, · its N minutes ran out, · its tab closed), or
PIP didn't use your Chrome (Cancel in Chrome, nobody answered) or couldn't reach it. While one is `allowed` or
`in_use` the view asks again every 1.5 s. The host refuses all four before API 59 ("Update DGC to let a Pip borrow
your Chrome.") and an older CLI is asked for none.

**Live data** (API 60). A project Pulse may carry `live_plan` (`{schema_version: 1, commands: [...]}`, one to six
read-only command lines; null for other Pips) on `get_pip` and `list_pips`, and a setup card may carry it with
`work_kind` `live_data` instead of a `verification_plan`. `propose_pip_update` takes `changes.live_plan` (null removes
it); the backend refuses a line that writes (`write_command`, with the reason), which the view shows as is. The host
refuses `changes.live_plan` before API 60 ("Update DGC to keep an eye on live data."). Its runs have `run_kind` `live`
and start with `run_pip` without Pulse pins; `get_pip_run`'s `result.live` has the summary (`summary`, `summary_by`,
`attention`, `notes`) and each line's `command`, `status`, `exit_code`, `output` and `note`. Its run posts and its
`pip_report` cards have `kind` `live` and `outcome` `live_clear` or `live_attention`, with `summary`, `summary_by`,
`commands` `{ok, failed, total}` and `failed_commands`; an older editor leaves out a post or a card it can't read.
No event and no event field changes.

**Your own apps** (API 61). `list_apps` (a read) answers `{apps: [{name, server, display_name, url,
connection_digest, summary, reads, changes, tools: [{name, kind, description, input_schema, moves_money,
schema_digest}], created_at, updated_at, secret_rotated_at, pending}]}`, never a secret; `pending` is null or
`{digest, url, url_changed, adds, changes, removes, summary, tools, created_at}`, and `accept_app_update {name,
expected_digest}` applies it. The view lists them on Pips settings → Apps ("Shop app" with its `summary` and `url`,
and an update that waits with Accept). A connector draft or action whose `server` is `app:<name>` is the plugin-style
Allow card ("Run create_dispatch in Shop app?"), with no Always allow for a tool that `moves_money` or one the
listing doesn't name; its `succeeded` receipt's `meaning` is "The app answered that it did this." The host refuses
both requests before API 61 ("Update DGC to see your own apps.") and an older CLI is asked for neither. Registering,
changing and removing an app are SDK calls the view doesn't make. No event and no event field changes.

**Approvals in your app** (API 62). The app can decide a Pip's change too. When it does first, the change's connector
draft is `prepared` with the action the app decided; the view reads that action once (`get_pip_app_action`, its
`resolved_by` `app:<name>`) and shows one line in place of the card ("Shop app accepted create_dispatch", "Decided in
Shop app. It ran once."), until the user's next message. An Allow whose `prepare_pip_connector_draft` answers an action
the app already decided, or whose accept observes one, says so and runs nothing more. An app action's
`get_pip_app_action` also carries `app_deliveries`, which the view doesn't show. `list_app_approvals` and
`decide_app_approval` are SDK calls the view doesn't make. Before API 62 the view asks nothing new. No event and no
event field changes.

**Routines on your app's events** (API 63). The view sends `list_pip_routines` with `app_events: true`, so a routine
whose `trigger` is `{kind: "app", app, event}` is listed ("When the shop app sends order.created"); without that field
the CLI leaves such routines out, so an older view, which refuses a `trigger.kind` it doesn't know, still loads the
rest. The Routines form offers **When my app sends an event** when `list_apps` has an app (or the routine already
waits on one): an app select and an event field, with the names `list_app_events {app, limit: 20}` answers as its
suggestions. It saves with `add_pip_routine` and `update_pip_routine`, as other routines. `trigger_app_event` is an
SDK call the view doesn't make. Before API 63 the view asks nothing new and offers no such choice. No event and no
event field changes.

**Pips your code keeps** (API 64). On a Personal Pip's page the view sends `list_pip_templates {pip_id}`. With no
template, nothing more is shown. With one, a section **From your code** says "Your app keeps NAME from its template,
KEY. What you change here stays as you set it."; when its `waiting` change is set, the section holds one card, "Your
code asks to let NAME do more", each item's `words` as a row, with **Accept** and **Not now**, which send
`decide_pip_template_change {change_id, decision: "accept" | "reject", expected_digest}`. The answer's `notice` is the
notice; the Pip, its routines, its level and what it may do without asking are loaded again. The host refuses both
requests before API 64 ("Update DGC to see what your code keeps for a Pip.") and an older CLI is asked for neither.
`ensure_pip_template` and `prune_pip_templates` are SDK calls the view doesn't make. No event and no event field
changes.

**The computer tab** (API 43). The Pips view's computer button posts
`{type: 'pipsOpenComputer', pip: {id, name, pip_type}}` instead of opening an in-view browser.
The host checks it and opens one `dgc.pipComputer` editor tab per Pip, titled "NAME ·
Computer" (a second request brings it forward). It looks like a small desktop: the three apps sit
in a dock and open in windows. The tab is a separate webview with its own
script (`dist/pipComputer.js`) and the same CSP. It posts `pipsReady`, receives
`{type: 'pipComputerInit', pip}` and `pipsConnection`, and sends ordinary `pipsRequest`s with the
connection generation; the host answers them to that tab only. A tab may send only
`get_pip_computer`, `open_pip_computer`, `use_pip_computer_view`, `stop_pip_computer`,
`list_pip_computer_actions`, `decide_pip_computer_action`, `always_allow_pip_computer_action`
and the six Files and Terminal commands, and only with its own `pip_id`; anything else is
refused before it is sent. `{type: 'pipComputerSave', name, data | text}` asks the host to save a
file the tab read: the user picks the place, and the tab gets `{type: 'pipComputerSaved', ok,
name | error}`. The Files and Terminal commands (`list_pip_computer_files`,
`read_pip_computer_file`, `add_pip_computer_file`, `remove_pip_computer_file`,
`run_pip_computer_command`, `list_pip_computer_terminal`) need API 43; see PIPS_REFERENCE. A live
view frame (`use_pip_computer_view`) may be up to 1,400,000 characters.

**The full screen** (capability `pips_desktop: 1`). `pipComputerInit` carries `desktop: true` when
the CLI streams it. The tab asks `get_pip_computer_desktop`; when `available`, it runs noVNC (bundled,
MPL-2.0) on a WebSocket-like channel. The tab posts `{type: 'pipDesktop', op: 'open' | 'send' |
'close', data?}` (`data` is base64); the host sends the command `{type: 'pip_desktop', pip_id, op,
data?}` for that tab's own Pip only, and routes the events `pip_desktop_data {pip_id, data}` and
`pip_desktop_closed {pip_id, reason}` back to that tab as `pipDesktopData` and `pipDesktopClosed`.
Closing the tab closes its stream. `dgc serve` refuses the stream where it refuses Pips controls (a
closing chat, a model's own shell, a restricted session) and when Pips are off.

`notify_pip_setup {request_id, setup_id}` is a nested control for the chat that
proposed a setup card. After the user approves the card, send it to that chat; the
backend checks the session, workspace and accepted receipt, then delivers a
controller notice to the model at the next step boundary (or as a controller turn).
It creates no Pip or run, and repeating it is harmless. Delegated subscription chats
refuse it; the approved setup stays saved.

### `pips_enable`

```json
{"type": "pips_enable", "enabled": false, "request_id": "e1"}
{"type": "pips_status", "request_id": "e1", "enabled": false, "api_version": 42,
 "restart_required": true, "message": "Pips disabled. All jobs are paused and active runs are stopping."}
```

- Disabling first applies the global emergency stop (every Pip paused, queued and
  running work cancelled), then saves `pips_enabled: false`. If the stop fails, the
  setting is unchanged and an error is returned.
- Enabling saves `pips_enabled: true`. It starts nothing and keeps any emergency
  stop in place; `restart_required: true` then means the runtime must be resumed.
- Failures come back as `command_rejected` with `command: "pips_enable"`.
  `request_id` is optional.

### `pips_runtime`

```json
{"type": "pips_runtime", "action": "start", "request_id": "s1"}
{"type": "pips_result", "request_id": "s1", "command": "pips_runtime", "ok": true, "result": {"runner": {}}}
```

- `action` is `start` or `resume`; `request_id` is required.
- `start` launches an independent runner process from DGC's own package folder
  (never from the project folder) and waits up to eight seconds for it to report
  ready. The runner keeps running after the editor closes. It is refused on Windows
  and while an emergency stop is set.
- `resume` clears the emergency stop first and then starts the runner. Every Pip stays
  paused until it is resumed individually.
- `result.runner` is the runner status: `status`, `online`, `paused`,
  `heartbeat_at`, `started_at` and queue `counts`.

### Pip references in prompts

The composer can point a message at Pips in the chat's project workspace.

```json
{"type": "list_prompt_pips", "request_id": "q1", "query": "rook", "limit": 20}
{"type": "prompt_pips", "request_id": "q1", "workspace_id": "ws_…", "pips": [], "next_cursor": null}
```

- `query` is at most 128 UTF-8 bytes, `limit` 1 to 20, and `after` is the previous
  page's cursor. Each row has the Pip's ID, name, type, status, job version and
  lifecycle revision. The backend chooses the workspace from its own project folder
  and session; a client can't pick another.
- A `prompt` can carry `pip_references`: one to eight distinct
  `{pip_id, expected_version, expected_lifecycle_revision}` entries. The backend
  checks every pin before accepting the message; a stale or foreign reference
  refuses the whole prompt, and the client should keep the draft.
- The model receives the references as an inert, untrusted JSON frame. A turn that
  carries one loads the main chat's Pips tools. References start, attach and approve
  nothing.

## Policy and audience

- Pips use an independent runner, so a session with an SDK runtime policy or a
  requested sandbox refuses `pips_control`, `pips_enable` and `pips_runtime`, both
  when queued and again when executed, with `error.code: "session_policy"`.
- With `pips_enabled` off, controls fail with `disabled`.
- `pips_result` and `pips_status` go only to the editor that sent the command. They
  are not chat display events and are not added to the chat history, because they can
  contain other workspaces' data.
