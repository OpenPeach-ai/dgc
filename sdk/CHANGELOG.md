# DGC SDK changelog

## Unreleased

- Editor protocol: commands `set_detach`, `detach`, `list_live_sessions` and `stop_live_session`; events
  `session_live`, `session_moved`, `live_sessions` and `turn_interrupted` are in the vendored protocol and the
  TypeScript SDK's known events, so neither SDK drops them. An SDK session is never offered `detach` (it is isolated,
  or pinned to one project), never sends `set_detach`, and so behaves exactly as before: its process ends with it.

- Pips API 59: `list_pip_borrows` (read) and `allow_pip_borrow`, `decline_pip_borrow` and `stop_pip_borrow`
  (mutations, each `{pip_id, borrow_id}`), in both SDKs; each is refused before API 59, and the card's id is checked
  before anything is sent. A Personal Pip borrowing your own signed-in Chrome: its cards, Allow once, Not now and Stop.
  There is no Always allow.

- Pips API 58: `get_pip_level` (read) and `set_pip_level` (mutation; `level` is `ask`, `approve` or `full`), in both
  SDKs; each is refused before API 58, and the level is checked before anything is sent. How much a Personal Pip asks.

- Pips API 57: `get_pip_working_notes` and `list_pip_daily_log` (reads) and `set_pip_working_notes` (mutation), in
  both SDKs; each is refused before API 57. A Personal Pip's own working notes, and the log of what it did each day.
- Editor protocol: commands `memory_history`, `memory_undo`, `memory_watch`, `learn_skill` and `save_skill`; events
  `memory_history`, `memory_learned`, `skill_draft` and `skill_saved` are in the vendored protocol and the TypeScript
  SDK's known events, so neither SDK drops them. An SDK session never gets `memory_learned` (it never sends
  `memory_watch`), and a Work session learns nothing without a screen that shows it.

- Pips API 56: `list_pip_logins` (read), and `save_pip_login`, `remove_pip_login` and `grant_pip_login` (mutations), in
  both SDKs; each is refused before API 56, and a save's shape is checked with errors that never repeat its password
  or key. A Personal Pip's saved logins.
- Pips API 54: `get_pip_computer_apps` (read) and `set_pip_computer_apps` (mutation, `choice` download or not_now), in
  both SDKs; each is refused before API 54. Pips use the whole desktop.
- Pips API 53: `get_pip_eyes` (read) and `set_pip_eyes` (mutation, `choice` ask, relay or off), `list_pip_computer_frames`'
  `pointers` and `use_pip_computer_view`'s op `pointer`, in both SDKs; each is refused before API 53.
- Editor protocol: new command `steer_queued {request_ids}` (capability `steer_queued`).
- Editor protocol: new command `set_plugin_sign_in_scopes {request_id, name, scopes, sign_in_again?}` (capability
  `plugin_sign_in_scopes`): what a plugin's sign-in may do, such as Sign in with GitHub's permissions.

Monitors restarted when a session is reopened (backend `ready.capabilities.monitor_restart`): the event
`monitor_restart` (`key`, `id`, `state` restarted|stopped|expired|failed, `message`, `stopped_at`, `at`, `restart`,
`by_user`) is part of the vendored protocol and the TypeScript SDK's known events, so neither SDK drops it, and the
command `restart_monitor {key}` restarts one a resume left stopped. A resume sends these after its other events.
Likewise `task_interrupted` (`kind` shell|agent|troupe, `state` stopped|started|resumed|failed, `actions`) with
`ready.capabilities.task_interrupted`, and the command `rerun_task {key, how?}` (`how` again|resume).

Pips API 52: `send_pip_message` takes `spooled_images` [{name, media_type}] and `spooled_files` [{name, spool}],
photos and files handed over through the runtime's image spool (8 MB a photo and 32 MB of photos, up to 64; up to 16
files, a document 16 MB, a text file 1 MB; `image/heic` and `image/heif` are kept as JPEG), and
`get_pip_message_image` takes `as_file` (the kept file's `path` instead of a data URI). Both SDKs know the fields,
check their shape and refuse them before API 52; `pips.spool(data, suffix=)` (`await pips.spool(bytes, { suffix })`
in TypeScript) writes a file into `ready.capabilities.image_spool_dir` and returns the name to send. No editor event
changed.

Pips API 51: `list_pip_run_posts {pip_id, before_id?, limit?}` (a read) returns what a Pip's runs posted in its own
chat, oldest first (`pips.run_posts()` in Python, `pips.runPosts()` in TypeScript); both SDKs refuse it before API 51.
No editor event changed.

Pips API 48: `mark_pip_news_seen {pip_ids, until}` (a mutation, local only) marks 1–50 Pips' news (failed runs, new
findings) seen up to a digest's `until`, until they do something new; both SDKs know it and refuse it before API 48.

The vendored protocol has the event `pip_report` (a finished Pip run that reports to the chat, `{report}`: an open
object) and the commands `watch_pip_reports` (none is sent until a client asks) and `pip_report_dismiss {run_id}`, with
`ready.capabilities.pip_reports`; the TypeScript SDK's known events include `pip_report`, so neither SDK drops it.
History may carry `{role: "pip_report", report}` items.

ChatDGC's outline: the command `chatdgc_outline` (offered as `ready.capabilities.chatdgc.outline`) and its answer, the
event `chatdgc_outline` (every prompt of a chat, oldest first, with the widgets its replies made), are in the vendored
protocol and the TypeScript SDK's known events, so neither SDK drops it.
Pips API 50: `check_pip_source {pip_id, source_policy?}` (whether a Pip's source fits a run now, and what its copy
leaves out) and `get_pip_run_source {run_id}` (what one run's copy left out) are reads in both SDKs, local only. A
`propose_pip_update` whose `changes.source_policy` uses the `safe_source_v2` rules
(`{"mode": "committed_only" | "current_tree", "exclusions": "safe_source_v2", "exclude"?: [...]}`) needs API 50; both
SDKs refuse it against an older runtime.

The editor's agent map added two events, `background_shells` and `background_output`, to the vendored protocol and
the TypeScript SDK's known events, so neither SDK drops them; and the commands `list_background_shells`,
`stop_background_shell` and `get_background_output` (with `ready.capabilities.background_tasks`). With
`ready.capabilities.agent_control_foreground`, `agent_control` close stops a foreground sub-agent without ending
the turn.

Pips have no daily token limit any more (backend 2026-10-14): `set_pip_daily_cap` accepts only `daily_tokens: null`
(answered with the usage) and refuses a number; `get_pip_usage` keeps `daily_cap` (always null) and `capped_today`
(always false).

The ChatDGC events (`chatdgc_chats`, `chatdgc_opened`, `chatdgc_earlier`, `chatdgc_turn`, `chatdgc_activity`,
`chatdgc_delta`, `chatdgc_message`, `chatdgc_changed`, `chatdgc_error`) are part of the vendored
protocol and the TypeScript SDK's known events, so neither SDK drops them.

`DGC.chat()` (Python, and `AsyncDGC.chat()`) and `dgc.chat()` (TypeScript): ChatDGC from your program. `Chats`
lists, opens and starts chats (`ask`, `list`, `new`, `open`); a `Chat` sends (`send`, `stream`), runs deep research
(`research`, with a plan you may edit), stops a reply (`cancel`) and is renamed, pinned, archived, deleted or
exported. Replies carry their numbered `sources`. It runs on a backend of its own in a private empty folder, in plan
mode (on an inherited profile, in your own mode: it runs no prompt); a CLI without ChatDGC raises
`DGCUnsupportedError`.

- **`dgc.chat()` on your own profile works.** With `inherit_user_state=True` (`inheritUserState: true`) -- the guide's
  own example -- it asked for plan mode, which an inherited client refuses unless that is already your mode, so it
  raised `DGCConfigError` for anyone in `default` or `auto` (and for `DGC(mode="auto")`). Its backend runs in default
  there, never `auto`, so nothing is acknowledged in your `~/.dgc`.
- **Study mode and question cards, as the editor has them:** `chat.send`/`stream` take `study` (`True` on, `False`
  off, for the chat from that message), and `chat.answer(message_id, choice)` answers a reply's question card --
  `choices=[...]`, one per question, for a card of several (`ready.capabilities.chatdgc.question_forms`; an older CLI
  raises `DGCUnsupportedError`), on `AsyncChat` too. Answers must be text, are trimmed and counted in characters
  alike in both SDKs, and a card the chat knows must get one answer per question. TypeScript:
  `chat.answer(messageId, choice, { choices })`.
- **Pips API 46:** `list_pip_notes`, `add_pip_note` and `forget_pip_note` take `shared: true` (a Pip's notes in the
  one memory DGC keeps for you); the SDK refuses it before sending to a runtime below API 46.

More Pips API 44, all local only and refused before sending to a runtime below API 44:
`list_pip_attention` (`limit`) reads everything your Personal Pips wait on you for; `list_pip_notes`
(`pip_id`), `add_pip_note` (`pip_id`, `text`) and `forget_pip_note` (`pip_id`, `note_id` or `all`) read
and change what a Personal Pip remembers; `list_pip_sites` (`pip_id`), `set_pip_careful` (`pip_id`,
`on`) and `forget_pip_site` (`pip_id`, `site`) read and change careful mode. `list_pip_plugin_uses`
items gain `money` and `count`, and the reply adds `installed`.

A Personal Pip's plugins (Pips API 44, local only): a Pip asks to use one of the plugins you added
to DGC, and `list_pip_plugins` (`pip_id`) reads its cards and the plugins it could ask for;
`allow_pip_plugin` and `decline_pip_plugin` (`pip_id`, `grant_id`) answer a card, and
`decline_pip_plugin` also takes an allowed plugin back. `list_pip_plugin_uses` lists the plugins
your Pips may use, and which Pips. A plugin action a Pip prepares is a connector draft whose
`server` is the plugin's server; a payment plugin's actions refuse `always_allow_pip_app_action`.
`get_pip_chat_context` (`pip_id`, optional `context_size`) estimates how much of the context window a
Personal Pip's chat takes in its next reply (`used_tokens`, `brief_tokens`, `recent_messages`,
`summarized_messages`). `list_pip_reply_stats` (`pip_id`, `run_ids`: 1–50) says what each reply took: `seconds`, `input_tokens`,
`output_tokens`, `requests`. `get_pips_limit` and `set_pips_limit` (`max_pips`, 1–100,000) read and set how many live Pips a workspace may
have (100 unless chosen). All eight are refused before sending to a runtime below API 44. `list_pips` takes
`limit` (1–100), `offset`, `query` (name or title) and `order` (`created`, the default, or `recent`), and
returns `total` and `next_offset`; a runtime below API 44 refuses those fields, so send them only to API 44.

Simple Pips (Pips API 43): `introduce_pip` queues a new Personal Pip's first message once. A
Personal Pip can be created with an empty `goal`, and with `pip_type` `core` (the Primary Pip).
`send_pip_message` takes `images` (up to 4 image data URIs) and `files` (up to 4 `{name, data}`),
2 MB in all, and `get_pip_message_image` reads an image back. Both are refused before sending to a runtime below API 43. A Pip computer's Files and
Terminal: `list_pip_computer_files`, `read_pip_computer_file` and `list_pip_computer_terminal`
(reads), and `add_pip_computer_file`, `remove_pip_computer_file` and `run_pip_computer_command`
(mutations), all API 43; `add_pip_computer_file`'s `data` (2 MB) travels outside the 32 KiB budget.
`get_pip_computer_desktop` (API 43) says whether a computer's full screen can show, and which
browser it runs. The vendored editor protocol adds `pip_desktop` and its two events.
A Personal Pip's own apps (API 43): `list_pip_app_links` (read), and `start_pip_app_link`,
`check_pip_app_link`, `decline_pip_app_link` and `disconnect_pip_app_link` (mutations, `pip_id` and
`link_id`); `finish_pip_computer_check` (`pip_id`) says a robot check on its computer is done.
A Personal Pip's routines (API 43, local only): `list_pip_routines` (read), and `add_pip_routine`
(`title`, `prompt`, `trigger`), `update_pip_routine` (`routine_id`, `changes`), `delete_pip_routine`
and `decide_pip_routine` (`routine_id`, `add`: take or turn down a routine the Pip suggested). A
trigger is a schedule, new email matching a query, or an upcoming calendar event.
A Personal Pip's page (API 43, local only): `set_pip_profile` (`changes`: `title`, `body`, `color`,
`notify`), and `list_pip_shared` (`kind`: `links`, `media` or `files`); `get_pip` and `list_pips` items
carry its `profile`. Pip computers: `get_pip_computers` and `update_pip_computers`, and
`reset_pip_computer` (`pip_id`). `list_pip_apps` lists the app accounts your Pips use.

Pip computers (Pips API 42). `session.pips` gains `get_pip_computer`,
`list_pip_computer_actions`, `get_pip_computer_frame` and `list_pip_computer_frames`, and the
mutations `decide_pip_computer_action`, `always_allow_pip_computer_action`, `stop_pip_computer`,
`open_pip_computer` and `use_pip_computer_view`; `changes.computer_plan` is accepted on a reviewed update. All of them
are refused before sending to a runtime below API 42. See [PIPS.md](PIPS.md#pip-computers-api-42).

## 0.7.0 — 2026-10-04

Pairs with CLI 0.48.0. `session.pips` (Python, sync and async) and `session.pips` (TypeScript)
read and manage the Pips of the session's DGC profile: list, inspect and run Pips, read reports,
and save proposals, setups and handoffs for review. Every mutation needs the host's explicit
`approved=True`, and each command is refused before it is sent when the runtime's Pips API is too
old for it. The CLI advertises Pips API 41, which adds the daily digest, notification
settings, finding outcomes and reviewed GitHub reads (`changes.github_plan`). See [PIPS.md](PIPS.md).

`get_pip_usage` and `set_pip_daily_cap` read a Pip's token usage and set its daily limit. `export_pip` returns a Pip's
job as a shareable file. `set_pip_feedback` rates a finished result up or down with a note that the Pip's later runs
read; `list_pip_feedback` lists the ratings. `always_allow_pip_app_action`, `list_pip_action_grants` and
`revoke_pip_action_grant` let a Personal Pip run one kind of action without asking, and take it back.
`get_pips_desktop_notifications` and `set_pips_desktop_notifications` read and set the
runner's desktop notifications. `get_pips_keep_running` and `set_pips_keep_running` read and set the "keep Pips running"
switch (local mutation; it never enables Pips or clears an emergency stop).

`turn_end.reason` and both `RunStatus` types gain `paused`: a run that stops at its goal's token
budget is neither completed nor failed. The vendored editor protocol gains the Pips control,
result and status messages and `pip_references` on a prompt.

## 0.6.10 — 2026-10-02

Pairs with CLI 0.47.0. The vendored copy of the editor protocol gains the commands that open a
chat in another directory and close one -- `open_chat` and `close_chat` -- with their replies
`chat_opened` and `chat_closed`, and the `chat_id` envelope a client opts into with its first
`open_chat`. An SDK session never sends `open_chat`, so it never sees `chat_id`. The two events
join the TypeScript client's known-event set, so it does not discard them as unrecognised.

The vendored protocol also declares the optional `agent_started.face_slot` and
`set_workspace_roots.agent_faces`. An SDK session never sends `agent_faces`, so it never receives
`face_slot`.

`resume()` runs in the mode it asked for. CLI 0.47.0 reopens a transcript in the mode it last ran
in, when that asks no less than the mode it replaces, so a session saved in `plan` and resumed
with `mode="auto"` ran in `plan`. An isolated session now sends `set_mode` with its own mode right
after `resume_session`, and the resume fails if DGC refuses it; an `inherit_user_state` session
keeps the mode your own DGC reopens it in. The `mode_changed` a resume can send is drained with
the rest of the resume's replay: it used to stop the drain, and the first run then received the
whole history, agents, context and goal replay as its own events.

## 0.6.9 — 2026-09-28

Pairs with CLI 0.46.0. The vendored copy of the editor protocol gains the `editor_state` command --
so a backend can be told what is actually on screen, which is how a takeover stops being decided on
whether a process is alive -- and `ask_request.options` and
`set_workspace_roots.ask_options`, both optional: an open question can now carry the picker's
choices without stopping the turn. A client that does not declare `ask_options` receives the
question exactly as before, because a field it has not declared would make it drop the whole
event.

`ShowFile` joins the tools a path rule applies to: it names a file, so a policy that restricts
paths has to cover it, and it did not. The plugin, connector and marketplace events are added to
the TypeScript client's known-event set, so it stops discarding them as unrecognised.

## 0.6.8 — 2026-09-23

0.6.7 published to PyPI and failed on npm: `npm publish "artifacts/…tgz"` contains a slash and no
leading dot, so npm read it as GitHub shorthand and refused with
`EALLOWGIT — Refusing to fetch "github:artifacts/vibedgc-sdk-0.6.7.tgz"`. The path now starts
`./`, and the workflow test asserts it does.

## 0.6.7 — 2026-09-23

Same contents as 0.6.6. Its tag failed because `tests/test_sdk_packaging.py` pins the publish
workflow's exact job graph, and adding the npm job changed it — a good test doing its job. That
test skips unless PyYAML and mypy are installed, which they were not locally, so it passed here
and failed in CI where `DGC_REQUIRE_RELEASE_TOOLS=1` turns those skips into runs. The test now
also asserts what the npm job must do: verify SHA256SUMS, publish the tarball rather than the
directory, `--access public`, `--provenance`, and no stored token.

## 0.6.6 — 2026-09-23

Same contents as 0.6.5, which was tagged and built nothing: the signed checkout manifest was
regenerated and then `npm install --package-lock-only` rewrote `sdk/typescript/package-lock.json`,
a file the manifest covers, so the publish workflow's first step refused the tagged tree. That is
the third release lost to a stale manifest. `tests/test_sdk_checkout_manifest.py` now runs the
workflow's own verification locally, so it fails in a second rather than after a tag is public.

## 0.6.5 — 2026-09-23

`@vibedgc/sdk` is on the npm registry: `npm install @vibedgc/sdk`. It was previously installable
only from the tarball attached to each GitHub release, which meant no version ranges, no
discoverability and no dependency updates for anyone embedding it.

Every install line in the docs now names the registry. The tarball is still attached to each
release and is byte-identical to what npm serves, for installs that want to pin a checksum.

Releases publish to npm automatically from the `sdk-v*` tag, using npm's trusted publishing
(OIDC) rather than a stored token -- the same mechanism the PyPI upload already used -- and
publish the verified tarball rather than rebuilding, so all three places describe identical bytes.

## 0.6.4 — 2026-09-23

Pairs with CLI 0.43.4 over editor protocol v14.

**The vendored protocol contract had fallen a release behind while still declaring v14.**
`dgc_sdk/wire/editor_protocol.py` is a verbatim copy of the CLI's module, and it is the only
contract an installed SDK can validate against — the CLI's own module is not importable from a
released package. The copy was missing everything CLI 0.42.0 added: the `ask_request` and
`ask_resolved` events, the `answers` and `spooled_images` fields on `prompt`, `open_asks` on
`set_workspace_roots`, and the `ask_skip` and `ping` commands.

So an SDK client rejected events the CLI legitimately sent, and could not send those fields at
all, while both sides reported the same protocol version. If you use open questions, out-of-band
images, or the editor liveness ping through the SDK, this is the release that makes them work.

Nothing kept the copy in step. `tests/test_sdk_vendored_protocol.py` now fails when it drifts.

## 0.6.3 — 2026-09-22

Pairs with CLI 0.43.2 over editor protocol v14.

**The TypeScript SDK's tables had fallen behind the runtime.** `ask_request` and `ask_resolved`
were missing from the known event types, and `ask_user` — the tool behind them — was missing from
the permission display table and from the always-offered set that mirrors the runtime's
`READ_ONLY_TOOLS`. A client using `allowTools` was told it "cannot refuse the runtime's tool
ask_user, which this SDK does not know". All three have been true of the CLI since 0.42.0; the
guard test caught them, but it had never run, because the publish workflow failed earlier on a
stale checkout manifest and CI failed earlier on `pip check`.

## 0.6.2 — 2026-09-22

Pairs with CLI 0.43.1 over editor protocol v14. The SDK's own API is unchanged.

0.6.0 and 0.6.1 were tagged but never reached PyPI or npm: the publish workflow verifies every SDK
file against the signed checkout manifest in `sdk/sbom/`, and that manifest still recorded 0.5.3,
so the build refused before it started. The manifest is regenerated here, as
`sdk/scripts/make_sbom.py` has always said it must be — "after every SDK source change, as the
last step before tagging".

## 0.6.1 — 2026-09-22

Pairs with CLI 0.43.0 over editor protocol v14. The protocol is unchanged and the SDK's own API is
unchanged; this release exists so the version the SDK names as its runtime is the one it was
released beside, which is what `REQUIRES_CLI` records.

### Check these when you upgrade

- **`max_subagent_depth` bounds delegation.** How deep a `task` may nest is now a setting, counted
  from the real parent chain, rather than something inferred from the wording of a brief. It
  defaults to 1, which is the flat tree DGC has effectively always had: a session you drive can
  delegate, and its sub-agents do their own work. If you relied on a sub-agent delegating further,
  set `max_subagent_depth` to 2 or more in the session's config.
- **A background `task` reports back on more frontends.** A detached sub-task's result now reaches
  a host that has no callback of its own, arriving with the next turn. An SDK session that starts
  background work and then sends another prompt will see that result in the transcript.

## 0.6.0 — 2026-09-21

Pairs with CLI 0.42.0 over editor protocol v14. The protocol is unchanged: everything new in this
CLI is announced through `ready.capabilities`, which an SDK client may ignore.

### Check these when you upgrade

- Nothing in the SDK's own surface changed. The version moves with the CLI line it was released
  beside, which is what `REQUIRES_CLI` records.
- A backend of this line reads `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, `.rtf` and
  `.pdf` through `read_file`, returning extracted text with a note saying so. A session that
  passes files to a model should expect text where it previously got
  `error: … looks like a binary file`.
- `ready.capabilities` gained `image_spool` (with `image_spool_dir`), `open_asks` and
  `editor_liveness`. New keys in that object are additive by design; a client that does not read
  them is unaffected.

## 0.5.3 — 2026-09-19

Pairs with CLI 0.41.6 over editor protocol v14. A `RuntimePolicy` or a sandbox setting needs CLI
0.41.6; an older runtime is refused with `DGCUnsupportedError` instead of running without them.

### Check these when you upgrade

- `run()` and `stream()` report a run that hits its `timeout` as `status="failed"`,
  `reason="timeout"` (it used to say `cancelled`). `RunHandle.result(timeout=...)` now raises
  `DGCTimeoutError` when that wait lapses first, and its default is `None` (wait for the run).
- The runtime no longer inherits your environment. Pass what the agent needs with `extra_env` or
  `inherit_env=["NAME", ...]`, for example `inherit_env=["HTTPS_PROXY", "NO_PROXY"]` behind a proxy.
- `RetryPolicy(retry_on=...)` or `backoff_s=...` other than the defaults raise
  `DGCUnsupportedError`: the runtime's HTTP retry schedule is fixed.
- `deny_tools` and `allow_tools` take DGC tool names (`"bash"`, `"write_file"`) and MCP routes;
  display names such as `"Bash"` and unknown names raise `DGCConfigError`.
- A `RuntimePolicy` sandboxes the shell by default (`shell="sandboxed"`). With a write tool denied
  the workspace is read-only to the shell, and hosts without bubblewrap warn at `session()`. Pass
  `shell="screened"` or `network="allow"` to keep the 0.5.2 behaviour.
- **`RunStatus` no longer has `blocked`** (it was documented and used by an example but never
  emitted). A denied step is reported in the new `RunResult.denials` — a list of `Denial`
  (`name`, `reason`, `source`, `call_id`, `args`), where `source` is `policy`, `callback`, `hook`,
  `mode` or `runtime`. A denied step no longer flips the status; the run ends `completed` unless
  something else fails. `ci_review.py` and `ci_edit.py` use `denials`. Staff callbacks now see
  every `bash` request instead of some being denied by a pattern before they are asked.
- **The workspace can no longer grant an SDK session capabilities.** By default a session's
  `cwd` is untrusted: its own `.dgc/permissions.json` *allow* rules and its `.dgc/agents`
  definitions (which pick a model endpoint and a credential env var) are not loaded — the
  workspace can only *narrow* what runs. Set `DGC(trust_workspace=True)` to opt in; even then a
  project agent file keeps only its persona, never an endpoint or key, and no agent definition may
  read a `DGC_*_API_KEY`. This holds with no `RuntimePolicy` set and under `inherit_user_state`,
  where your own `~/.dgc` allow rules also stop pre-approving once a policy reviews permissions.
- **`RuntimePolicy(shell="sandboxed")` fails closed.** A host with no working OS sandbox now
  refuses to start a shell-capable session (`DGCUnsupportedError`) rather than run the shell
  unconfined; plan/no-shell sessions still start. Pass `sandbox={"requirement": "preferred"}` (or
  `shell="screened"`) to accept the weaker mode on purpose. `available()` now probes that
  bubblewrap actually confines (unprivileged user namespaces can be disabled), so `required` no
  longer passes on a bwrap that cannot run.
- The provider key never reaches a shell/`python`/`monitor`/hook subprocess environment, in any
  mode, and the SDK hands it to `dgc serve` through a private 0600 file the CLI reads and deletes
  before any tool runs (not the child's environment, whose initial block stays readable in
  `/proc`). `printf %s "$DGC_API_KEY" | rev` no longer recovers it. In `shell="screened"` the
  `python` tool is screened for network and (with writes denied) file writes, like the shell.
- `deny_tools`/`allow_tools` accept both the internal name and the display spelling (`"bash"` or
  `"Bash"`, `"write_file"` or `"Write"`); unknown names still raise `DGCConfigError`.
- `RetryPolicy(max_attempts=...)` outside 1–11 raises `DGCConfigError` (it is not clamped), and a
  `permissions=` mapping with a key other than `mode`/`unhandled` raises `DGCConfigError`.
- An unset `state_dir` (a temporary directory the SDK creates) is removed on `close()`, audit and
  usage logs included; pass `keep_state_dir=True`, or an explicit `state_dir`, to keep it.
  `rewind()` on an out-of-range index raises `DGCConfigError` instead of returning `{ok: False}`.
- Examples and the quickstart no longer seed a model into `state_dir`; pass `model` and
  `base_url` (or `extra_config`), since a `config.json` already in `state_dir` is not merged.

### Runtime and errors

- The SDK finds the installed CLI on its own: `DGC_PYTHON`, the application's Python when it can
  import `dgc`, then `dgc` on `PATH`, `~/.local/bin/dgc` and the installer's versions directory.
  Each candidate is probed for protocol v14, and the error lists what was skipped and why.
- The runtime child no longer inherits the application's environment: it gets basic variables,
  the isolated HOME, `api_key` and `extra_env`; `inherit_env` passes more on purpose. The
  application's site-packages are never put on the child's `PYTHONPATH`.
- Custom tools start in a clean install (the relay no longer shadows the standard `types`
  module), work with `runtime=["dgc", "serve"]`, and a tool server that does not connect fails
  `session()` instead of starting without its tools.
- The backend survives the thread that created the session exiting, so sessions can be created
  from request threads and thread pools.
- Every exception is a `DGCError`. A refused request raises `DGCCommandRejectedError` at once
  instead of a 15 s timeout; a protocol mismatch raises `DGCProtocolError` naming both versions;
  a failed setup stops its child. `start_timeout` and `request_timeout` are options on `DGC`.
- Run timeouts work at any length, `timeout=None` means no limit, and a timed-out run reports
  `status="failed"`, `reason="timeout"`. Event types newer than this SDK are skipped.
- When every DGC install found speaks another protocol, `DGC()` raises `DGCProtocolError` saying
  whether to update the CLI or dgc-sdk; an unusable `DGC_PYTHON` is logged when another install is
  used instead.
- `RetryPolicy` says what it controls (stall re-issues) and rejects settings the runtime cannot
  honour instead of ignoring them.

### Sessions, results and usage

- `state_dir` is created private and refused when others can write it; each session writes its
  config from scratch, so options no longer leak between runs or sessions, and a one-run limit
  (including an `output_schema` repair) no longer sticks. `state_dir` may be omitted.
- A new session keeps its own id and transcript; it never adopts another session's.
- `usage` is the provider's reported token counts for the run (output tokens included), or
  unknown when not reported; `usage_report()` counts unknown runs separately, and `requests`
  still counts their requests. Cached input is billed once, at `cached_input_per_million` (or the
  input price when that is 0).
- `fork()` points `session_path` at the fork's own transcript, and `clear_todos()` returns at
  once instead of timing out.
- Failed runs carry the runtime's error message. `result.changes` includes dot-directories and
  lockfiles, fills `before`, and gives each file a `git apply`-able `diff`.
  `result.verification` reports only the configured `verify_command`.
- `followup()` returns a handle for its own, audited turn; behind a run with its own `max_turns`
  or `output_schema` it is sent once that run is over, so it is not capped by it or run ahead of
  its schema repair. `steer()` needs an active run; leaving a `with` block early cancels the run
  and frees the session.
- `AsyncDGC` and `AsyncSession` have every sync method with real signatures, accept `async`
  callbacks, and cancelling the awaiting task cancels the run. `decision_timeout=None` means no
  limit.
- Audit and usage files are owner-only, and audit rows redact current credential formats, bare
  `API_KEY=...` / `api_key: ...` lines included.

### Policy and sandbox

- `RuntimePolicy` is enforced by the runtime per session, in `auto` mode too, and is never
  written to any config file (with `inherit_user_state=True` it no longer lands in `~/.dgc`).
  File tools stay inside the workspace and off `deny_path_prefixes`; `deny_tools` and
  `allow_tools` cover custom and MCP tools, and unknown names raise.
- Shell commands run in the OS sandbox by default (`shell="sandboxed"`); in `auto` mode the shell
  runs only there, and a host with no working sandbox refuses the session unless the app accepts
  the weaker mode (`sandbox={"requirement": "preferred"}` or `shell="screened"`). The sandbox
  masks the client's whole `state_dir` (audit and usage logs, not just the isolated HOME).
  `shell="screened"` keeps the older pattern screen — covering the `python` tool too — documented
  as best effort.
- Outside `auto` mode every shell command reaches `on_permission`. The workspace's own
  `.dgc/permissions.json` *allow* rules and `.dgc/agents` are not loaded unless
  `trust_workspace=True`; a `deny_path_prefixes` refusal now tells the model it was the
  application's policy, not "the user".
- Custom tools are served on a private, randomly named socket that answers only the session's
  own relay, which proves a per-session secret; on Linux the relay hides that secret from other
  processes of the same user.
- `sandbox={"requirement": ...}` is decided by the runtime, so it works from a PyPI install;
  `Session.sandbox` reports what was applied. `permissions=` and `sandbox=` accept
  `PermissionPolicy` and `SandboxPolicy`, and `unhandled="callback"` requires `on_permission`.

### TypeScript (`@vibedgc/sdk`)

The Node client now has the same correctness and security fixes as the Python one.

Check these when you upgrade:

- `policy` is enforced by the runtime per session (`DGC_SESSION_POLICY`), in `auto` mode too, and
  is never written into `config.json` or, with `inheritUserState`, into `~/.dgc`. `denyTools` and
  `allowTools` take DGC tool names and MCP routes; unknown names throw `DGCConfigError`. New
  fields: `allowTools`, `denyPathPrefixes`, `shell` (`"sandboxed"` by default: the shell runs
  in the OS sandbox, and in `auto` mode only there; `"screened"` keeps the pattern screen).
- A `config.json` already in `stateDir` is not merged, and `stateDir` must be private (a
  group- or world-writable one is refused). Pass extra DGC settings with `extraConfig`.
- Every error is a `DGCError` subclass instead of a plain `Error`. `steer()` throws without an
  active run, and `followup()` returns a `RunHandle` for its own turn.
- `result.usage.input_tokens` / `output_tokens` are the provider's counts or `null` (they were a
  context-size estimate and 0). `usageReport()` keeps `runs` and `rows` and adds totals.
- `session.close()` returns a promise. `decisionTimeoutMs: null` now means no limit.
- A workspace's own `.dgc/permissions.json` allow rules and `.dgc/agents` definitions no longer
  load in an isolated session, policy or not; pass `trustWorkspace: true` to allow them.
- A `policy` with the default `shell: "sandboxed"` throws `DGCUnsupportedError` at `session()`
  when the runtime has no OS sandbox, unless you pass `sandbox: "preferred"` or
  `shell: "screened"` (plan-mode sessions still start).
- `RunStatus` has no `blocked` (it was never produced); refused calls are in `result.denials`.
- The temporary `stateDir` the SDK creates when none is given is removed on `close()`, audit and
  usage logs included; pass `keepStateDir: true` to keep it.
- `rewind()` with an invalid index throws `DGCConfigError`.

Fixes:

- Per-session options (`model`, `maxTurns`, `verifyCommand`, trusted directories) no longer leak
  into later sessions, and a run's `maxTurns` or an `outputSchema` repair no longer caps later
  runs. `verifyCommand` is applied (it was ignored); `turnBudgetS` and `maxTokens` are new
  session options.
- `timeoutMs` works at any length (Node timers overflow past 24.8 days and fired at once);
  `null` means no limit; invalid values throw before the prompt is sent. `signal: AbortSignal`
  and leaving a `for await` loop early cancel the run and free the session.
- Control requests made while a run streams keep their replies; a refused command throws
  `DGCCommandRejectedError` at once instead of after 15 s; a protocol mismatch throws
  `DGCProtocolError` naming both versions; event types newer than the SDK are skipped; a runtime
  that exits, never becomes ready, or cannot be launched is an SDK error that carries its stderr,
  and no `dgc serve` child is left behind. `startTimeoutMs` and `requestTimeoutMs` are options.
- Failed runs carry the runtime's error. `result.changes` (new) lists added, modified and deleted
  files with `git apply`-able diffs; `result.verification` reports only the configured command.
- A session binds only its own transcript (`sessionPath`); follow-up and steered turns are
  observed, audited and billed as runs.
- Custom tools use a random socket in a fresh 0700 directory and a per-session secret the relay
  must present; a tool server that does not connect, authenticate or offer every tool fails
  `session()`. `defineTool` takes `{ timeoutMs }`.
- Decision callbacks, `onMcpInput` included, are bounded by `decisionTimeoutMs`; with
  `unhandled: "callback"` a failing callback stops the run (`reason: "decision_failed"`).
- Audit and usage files are owner-only and audit rows are redacted with the Python rules.
- The runtime is started with `python -P` where available, so a `dgc/` package in the workspace
  cannot replace it.
- The provider key reaches the runtime through a 0600 file in the private state directory that the
  CLI reads and deletes at startup, never through the child's environment (readable in
  `/proc/<pid>/environ`); the agent's shell and python tools never see it.
- `result.denials` lists refused calls with `name`, `reason`, `source`, `callId` and `args`; a
  denial made by the application's policy is reported to the model as such.
- `shell: "screened"` screens the `python` tool for network calls and file writes too, and
  `denyTools`/`allowTools` accept display names (`"Bash"`, `"Write"`).
- Reading a workspace path that became a FIFO no longer blocks the change scan.

### Packaging and release

- PyPI and the GitHub release now carry the same bytes. `publish-dgc-sdk.yml` builds only from
  the `sdk-vX.Y.Z` tag, runs the SDK suites against the built wheel, publishes through PyPI
  Trusted Publishing with PEP 740 attestations, and attaches the same wheel and sdist, the npm
  tarball, a CycloneDX SBOM and `SHA256SUMS` to the GitHub release with GitHub artifact
  attestations. SDK releases no longer take the Latest badge from the CLI.
- The wheel and sdist include the Apache-2.0 `LICENSE` (PEP 639 metadata), and the classifiers name
  the proven platform (Linux) and `Typing :: Typed`.
- The Node package `@vibedgc/sdk` is compiled to JavaScript with type declarations, so
  `npm install <tarball>` works; it needs Node 22 or newer.
- The maintainer public key for the checkout manifest is committed as `sdk/sbom/sdk.pub`; SBOMs use
  `pkg:pypi` package URLs.
- CI builds the wheel and runs the SDK suites against it in a clean, non-editable install, runs
  the TypeScript suites, and type-checks the public API with `mypy --strict`. Every GitHub Action
  is pinned to a commit.

### Examples and docs

- Every example runs from a pip install: model and endpoint come from `--model`/`--base-url` or
  `DGC_MODEL`/`DGC_BASE_URL`, state goes to a new temporary directory, and output says what
  happened. `ci_edit.py` writes a patch that `git apply` accepts, new files included.
- `workbench.py` binds 127.0.0.1, requires a per-run token, accepts only JSON from its own page
  and host, matches approvals to the pending request, and no longer names a LAN address.
- The README quickstart runs as written and is tested.
- `docs/SDK.md` is a full guide and API reference: every public name, the events, the defaults,
  the security model and how to verify a release.
