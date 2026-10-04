# Per-Pip conversations and model choices (local API 5)

This isolated build adds real model-backed conversations to existing source-review
Pips. It does not widen their permissions. Scout, Lens, Rook and Lock use DGC's
native Agent loop and the same five read-only tools as their audits. Core remains
the main chat; the write/test roles remain unavailable.

Each Pip has a private persistent archive in registry schema 4. A user message and
its queued run are committed in one transaction. Exact retries return the original
run; changed content or a different requesting device with the same key is refused.
Only one reply can be queued/running/cancelling per Pip. Replies share the existing
single-runner queue with audits; sending is not live steering of an existing run.
Pausing a job's schedule does not disable its conversation. The global runner stop
does disable new work and cancels work already in progress.

A successful reply is saved once by the parent controller, atomically with the
run's successful completion. Cancelled/failed/interrupted replies retain the user
message and terminal status, but no completed assistant message. Provisional text
comes from real model output, is redacted across provider chunk boundaries, and is
never treated as the final archived answer. Conversation replies cannot be accepted
as audited findings or returned by `pips_context(action="report")`.

## Controls

All commands use the existing authenticated `pips_control` transport and exact-true
`pips_enabled` gate. These are user controls, not tools exposed to Pip models.

- `list_pip_messages {pip_id,before_id?,limit?}` returns `pip_id`, `workspace_id`,
  `messages`, `next_before_id`, `active_run` and `history_context_omitted_count`.
  Messages are oldest-first within the newest requested page. Each has `id`,
  `pip_id`, `workspace_id`, `role`, `text`, `run_id`, `status`, `model`, `created_at`.
  Status is the authoritative run status. A cursor from another Pip is refused.
- `send_pip_message {pip_id,text,idempotency_key}` returns `{run,message}`. Message:
  1–4,000 characters and at most 8 KiB. Retry key: 1–128 ASCII letters, digits,
  underscores or hyphens. Sending never changes a job, schedule or permissions.
- `list_pip_models {}` returns `{default_model,models:[{id,name}],connection,error?}`;
  `truncated:true` means the displayed catalog exceeded 256 entries/64 KiB.
- `create_pip` accepts `model_choice`; a human `propose_pip_update` can propose it.
  Apply through the existing explicit, version-checked approval. Choices are
  `{"mode":"default"}` or `{"mode":"model","model":"catalog-id"}`. Explicit null,
  unknown fields, keys/endpoints and malformed IDs are refused. Main-chat model
  proposals remain restricted to name/goal/source, and Pip workers cannot propose.

`run.manifest.run_kind` is `audit` or `conversation`; old manifests mean `audit`.
Conversation results contain `text`, `usage`, `tools_called` and snapshot metadata.
Activity events use `pip_run_progress` with `{kind:"text_delta",text}` for genuine
provisional text. Refresh messages when a run reaches its terminal status.

## Model and context pins

Default model means the configured model at enqueue time, not whatever the main
chat selects later. Explicit models must appear in successful native discovery;
a listing failure does not silently fall back. The configured default can still
be used without discovery. Both forms pin the model and existing endpoint/API-mode
setting. Changing the main selected model does not invalidate a queued run;
changing endpoint or API mode does. Same-endpoint credential rotation is allowed.
`auto` retains DGC's existing provider negotiation; it is not a claim of a pinned
concrete wire protocol. Workers disable fallback models/endpoints and subscription
CLI delegation. Catalog entries are provider-listed IDs, not a promise that every
ID supports chat, tools or local inference. Provider errors remain failures.

Conversation context includes the last six complete successful user/assistant
pairs, up to 32 KiB, without splitting messages. The full archive is preserved.
`history_context_omitted_count` counts older completed messages omitted from that
model context; failed/cancelled user messages are not completed pairs. It also pins
the approved job, committed source revision, workspace context and the last source
audit summary plus up to five complete findings under 8 KiB. Report references carry
their own source revision/job version, total/omitted finding counts, and remain
model assessments with checked source excerpts only. Older report evidence may
refer to a different commit. None of these references grant instructions/authority.

Only committed Git source is available, including in conversations. No dirty files,
web access, shell, file edits, autonomous job changes or cross-Pip history. The
existing native tools remain defense in depth, not a claim of kernel sandboxing.

## Bounds and CLI

Reply text/stream is capped at 24 KiB, request at 16 KiB, history page at 96 KiB and
complete control response at 128 KiB. The worker input envelope deliberately grew
from 64 to 128 KiB: the parent preflights the **entire serialized payload**, including
credentials/path/manifest, before spawning the worker; the worker reads the same
limit plus one byte. Output remains capped at 512 KiB, with individual events capped
at 2 KiB. Each run retains the existing five-minute/64-tool/12-turn limits. The
existing 1,000-run archive limit across audits and replies applies before the
additional 20,000-message archive guard. Full archives fail clearly, not by silently
removing history. Archive management is not implemented in this lab build; hitting
either limit stops accepting new work.

```sh
dgc pips models
dgc pips create "Reviewer" --type rook --goal "Review committed source" --model MODEL_ID
dgc pips send PIP_ID "Explain the last finding" --idempotency-key reply-1
dgc pips messages PIP_ID
dgc pips messages PIP_ID --before-id MESSAGE_ID
dgc pips propose PIP_ID --expected-version 1 --default-model
dgc pips cancel RUN_ID
```

Keep the local supervisor running as with audits. Schema 3 upgrades atomically to 4;
restart the old supervisor before exercising API 5. No transcript migration or
modification of the main DGC checkout is part of this increment.
