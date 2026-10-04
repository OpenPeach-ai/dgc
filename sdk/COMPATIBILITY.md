# DGC SDK compatibility

| SDK | Protocol | CLI | Python | Node | Host proven |
| --- | --- | --- | --- | --- | --- |
| **0.6.10** | **v14** | **0.47.0** | **≥ 3.10** | **≥ 22** | **Linux** |
| 0.6.9 | v14 | 0.46.0 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.8 | v14 | 0.44.1 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.7 | v14 | 0.43.4 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.6 | v14 | 0.43.4 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.5 | v14 | 0.43.4 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.4 | v14 | 0.43.4 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.3 | v14 | 0.43.2 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.2 | v14 | 0.43.1 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.1 | v14 | 0.43.0 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.0 | v14 | 0.42.0 | ≥ 3.10 | ≥ 22 | Linux |
| 0.5.3 | v14 | 0.41.6 | ≥ 3.10 | ≥ 22 | Linux |
| 0.5.2 | v14 | 0.41.5 | ≥ 3.10 | ≥ 22 (source only, strip-types) | Linux |

macOS and WSL are unproven. Native Windows is experimental: custom tools need Unix sockets.

The SDK launches `dgc serve` from a DGC CLI install: the `runtime=` you pass, the Python named by
`DGC_PYTHON`, its own interpreter when that can import `dgc`, or the installed CLI (`dgc` on
`PATH`, `~/.local/bin/dgc`, the installer's versions directory). A runtime that speaks another
protocol is skipped with the reason; when none speaks v14, `DGC()` raises `DGCProtocolError`
saying whether the CLI or dgc-sdk needs updating. It is not the unrelated PyPI package named
`dgc`.

0.5.2 on PyPI was built from a later commit than tag `sdk-v0.5.2` and differs from the wheel on
that GitHub release (one comment line and the README). From 0.5.3 the PyPI files and the GitHub
release assets are the same bytes, built by one workflow from the tag.

```bash
python3 -m pip install dgc-sdk==0.6.8
npm install @vibedgc/sdk
```

## Local Pips-lab goal-pause outcome

This unshipped branch adds `paused` to `turn_end.reason` and both SDK `RunStatus`
types. A run that stops at its goal token budget is neither completed nor failed.
It returns `status: paused`, `reason: paused`, retains generated text, and does
not attempt output-schema repair. Resume is a separate user/host decision.
Older backends continue emitting their original reasons; older SDKs may not
recognize the new enum value. Integrators must migrate the backend, generated
protocol and clients together. The SDK source manifest still needs the release
agent's existing signing key; this note does not assert release readiness.


## Local Pips API 34 and registry schema 28

Calendar metadata inspection and proposal creation require Pips API 34. Python
(sync/async) and TypeScript reject those commands on older runtimes before
transport. Existing API 31 action reads/accept/reject now understand both Gmail
and version-2 calendar payloads. Shared registry schema 28 intentionally prevents
older processes from reading new action kinds; restart all controllers and
supervisors using that profile together. Migration preserves earlier Gmail rows.
These are local lab changes, not a new published SDK version. Offline contract
and migration tests plus real metadata discovery do not establish live calendar
creation compatibility. Live account testing and release signing are pending.


API35 adds conversational calendar draft reads/preparation/dismissal. Both SDKs
gate them before transport and require separate approval for preparation and
creation. Registry29 adds a calendar-draft ledger without changing prior email
or external-action rows. Restart profile-sharing controllers/supervisors together;
older readers refuse the new schema. These remain unshipped lab changes.

Pips API 36 adds `inspect_pip_connector_actions` and
`propose_pip_connector_action` for exact, separately reviewed calls on saved
Zapier, Arcade, Make and n8n connections. Python and TypeScript gate both commands
at 36; mutations still require explicit host approval. Registry schema 30 excludes
older readers of the new connector-call review semantics. Runtime connector
responses do not prove downstream workflow completion. Final SDK source manifest
signing remains the release agent's task.

Pips API 37 adds retained conversational connector drafts and four closed local
controller commands (get/list/prepare/dismiss). It requires registry schema 31;
older registry readers refuse this schema. API 36 action preparation/execution
semantics are unchanged. Connector metadata remains in the controller's bounded
conversation snapshot; workers receive no credentials or MCP process. See PIPS.md.


### Optional native goal replacement capability

`ready.capabilities.live_goal_replace` permits a reviewed `start_goal` against an
already-running native goal. Send the current `expected_goal_id` and a unique
`request_id`. Acceptance uses `prompt_accepted.state = steered`; a later
`steering_update` reports applied or returned. Returned means no new goal was
committed, and the caller must retain the draft. It must not resubmit it as an
ordinary prompt. The existing start_goal wire schema is unchanged. This does not
permit arbitrary set_goal state changes during a turn, first-goal creation during
an ordinary active turn without live_goal_start, or delegated subscription goal steering. Final source
manifest signing is still release-agent work.


### Optional native goal editing capability

`ready.capabilities.live_goal_edit` permits an objective/budget edit of an
already-running native goal. Send `set_goal` with nonempty `text`, `status: active`,
`expected_goal_id`, a unique `request_id`, and optional `token_budget`. Do not set
`replace`. Omitted budget retains the existing limit; zero removes it. Commit is
reported as `goal_changed` with the request ID after persistence. Failure/cancel
returns a correlated `command_rejected`. Keep the draft pending until one of those
arrives or the transport closes; a short timeout is not evidence of refusal.

Unlike replacement, editing keeps identity, accumulated usage, current-cycle token
baseline, attachments and history. This capability does not authorize arbitrary
live state mutation or a second foreground turn. Pause/clear use existing controls.
The optional expected_goal_id field is also checked on idle set_goal calls. The
Python SDK's vendored protocol and generated extension/schema copies are in sync.


### Optional first-goal adoption capability

`ready.capabilities.live_goal_start` permits `start_goal` during an ordinary native
foreground turn. With no existing goal, send `expected_goal_id: ""` and a unique
request ID; when replacing an existing paused/completed goal, use its current ID
and the appropriate user review. The normal steered acceptance and applied/returned
receipt contract applies. No second foreground turn starts. The existing request
and tool batch settle before goal adoption; continuation, clocks, progress and
budget enforcement then use the ordinary goal lifecycle. Pre-adoption tokens do
not count toward the new goal. Limits cannot interrupt a model generation already
in flight. Ordinary work does not otherwise activate or charge a paused goal.

This does not grant monitor wakes, child agents or delegated subscription turns
permission to adopt a new goal. Missing/closed admission windows refuse and retain
the draft. Cancellation before adoption never queues an ordinary replacement prompt.
The existing start_goal schema and SDK transport remain unchanged.

### Pips API 38: explicit calendar invitations and finite series

`propose_pip_calendar_action` and `prepare_pip_calendar_draft` accept the original
five-field event, or those fields plus all of `attendees`, `repeat`, and
`send_invitations`. Extended preparation requires API 38; SDKs reject older
runtimes before sending. TypeScript exports `PipCalendarEvent`. Repeat is null
or `{frequency: "daily" | "weekly" | "monthly", interval: 1..12, count: 2..52}`.
Guests are up to ten exact distinct emails. Invitation boolean must match whether
there are guests. This prepares a review; the separate approved accept call and
exact digest remain mandatory. A successful event receipt never proves invitation
delivery or acceptance. Registry schema 32 prevents partial reviews by old clients.
