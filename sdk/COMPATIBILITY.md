# DGC SDK compatibility

| SDK | Protocol | CLI | Python | Node | Host proven |
| --- | --- | --- | --- | --- | --- |
| **0.7.0** | **v14** | **0.48.0** | **≥ 3.10** | **≥ 22** | **Linux** |
| 0.6.10 | v14 | 0.47.0 | ≥ 3.10 | ≥ 22 | Linux |
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

## Paused runs

`turn_end.reason` and both SDKs' `RunStatus` include `paused`. A run that stops at its
goal's token budget is neither completed nor failed: it returns `status: paused`,
`reason: paused`, keeps the generated text, and does not attempt output-schema repair.
Resuming is a separate user or host decision. Older backends never send this reason,
and older SDKs may not recognize it, so update the CLI and the SDK together.

## Pips (SDK 0.7.0)

SDK 0.7.0 adds `session.pips` (Python sync and async, and TypeScript). It pairs with
CLI 0.48.0, which advertises **Pips API 40** inside `ready.capabilities` on editor
protocol v14. Each Pips control has a minimum Pips API (8 for the original controls,
up to 40 for reviewed web reads), and the SDK refuses a control before sending it when
the backend's `pips_api_version` is lower. The backend's Pips registry is schema 33;
an older CLI refuses to open a newer registry, so update every DGC process that shares
a profile together. See [PIPS.md](PIPS.md) for the per-command gates.

### Optional native goal replacement capability

`ready.capabilities.live_goal_replace` permits a reviewed `start_goal` against an
already-running native goal. Send the current `expected_goal_id` and a unique
`request_id`. Acceptance uses `prompt_accepted.state = steered`; a later
`steering_update` reports applied or returned. Returned means no new goal was
committed, and the caller must retain the draft. It must not resubmit it as an
ordinary prompt. The existing start_goal wire schema is unchanged. This does not
permit arbitrary set_goal state changes during a turn, first-goal creation during
an ordinary active turn without live_goal_start, or delegated subscription goal steering.


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
The optional expected_goal_id field is also checked on idle set_goal calls.


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
