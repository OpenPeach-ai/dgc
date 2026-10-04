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
  "pips_api_version": 40,
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
- `run_pip`, `send_pip_message` and `accept_pip_handoff` first check that the
  independent runner is live (a fresh heartbeat and a held lease). The backend never
  starts a worker of its own to run Pips work. If the runner stops after the check,
  accepted work stays queued.
- `list_pip_run_activity {run_id, after?}` pages a run's activity: at most 50 events
  or 96 KiB per page, with `next_cursor`, `oldest_cursor`, `has_more`,
  `retention_limit`, `retention_scope` and `history_may_be_truncated`. Each workspace keeps its latest 5,000 events.

`notify_pip_setup {request_id, setup_id}` is a nested control for the chat that
proposed a setup card. After the user approves the card, send it to that chat; the
backend checks the session, workspace and accepted receipt, then delivers a
controller notice to the model at the next step boundary (or as a controller turn).
It creates no Pip or run, and repeating it is harmless. Delegated subscription chats
refuse it; the approved setup stays saved.

### `pips_enable`

```json
{"type": "pips_enable", "enabled": false, "request_id": "e1"}
{"type": "pips_status", "request_id": "e1", "enabled": false, "api_version": 40,
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
