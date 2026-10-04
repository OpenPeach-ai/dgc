# Per-message Pip conversation controls (local API 26)

The Pip composer can choose a context budget and requested reasoning effort for
its next message. Its existing model choice remains a reviewed Pip job setting.
The execution indicator stays **Read-only**: neither a reasoning level nor a
larger context grants commands, writes, connectors or autonomous job changes.

`send_pip_message` accepts optional `chat_options` with exactly these fields:

```json
{"context_size": 8192, "thinking": "medium"}
```

Context is an integer from 2,048 to 1,048,576 tokens (the largest main-chat preset).
Clients connected to API 24 retain their earlier 32,768 maximum. Thinking is `off`, `low`,
`medium`, `high` or `xhigh`, matching the native DGC effort vocabulary. Unknown
fields, null, empty objects, numeric strings and boolean context values are
refused. Omitting the object retains the old context-clamp/thinking-off behavior.
Explicit Off does not get raised by words such as “think” in the message.

CLI uses the same contract; supply both flags so retries have an explicit pair:

```text
dgc pips send PIP_ID "Explain the last finding" --context-size 8192 --thinking medium --idempotency-key reply-1
dgc pips messages PIP_ID --json
```

Without either flag, CLI sends the original legacy request. Partial flag pairs
are refused before contacting the supervisor or queueing work.

The request digest includes the exact normalized options, so retries cannot
quietly change inference settings. The options and model settings are pinned in
the immutable queued run. They do not change the approved job, future scheduled
audits, previously queued work, global configuration, model endpoint or credentials.
Last-used values are read from the most recent saved user-message run for that
Pip, including failed or cancelled runs. They are composer defaults, not a new
standing authority. Unsent local UI selections are the client's responsibility.

`list_pip_messages` adds `chat_controls`:

```json
{
  "version": 1,
  "mode": "read_only",
  "options": {"context_size": 8192, "thinking": "medium"},
  "options_source": "last_message",
  "inherited_context_size": 1048576,
  "effective_context_size": 8192,
  "context_min": 2048,
  "context_max": 1048576,
  "context_note": "Explanation of the bounded reply context and provider limits.",
  "thinking_levels": ["off", "low", "medium", "high", "xhigh"],
  "reasoning_control": "provider_dependent",
  "reasoning_note": "Explanation of provider mappings and inference limits."
}
```

With no selected message options, the default is the main configured context
clamped to the Pip range and reasoning Off; `options_source` is `default`.
`inherited_context_size` exposes the un-clamped main request. Despite its name,
`effective_context_size` is the selected configured Pip budget, not a promise of
the provider's actual token capacity. The provider may clamp it further. Saved
conversation history is retained separately. A bounded continuation brief plus
recent complete successful pairs now carries context between replies. Together
they fit half the selected window using an approximate four bytes per token,
with a 64 KiB serialized input ceiling. Larger windows also accommodate more
source/tool output within a reply; they do not raise the worker envelope,
source, tool-call, wall-time or output limits. This is not exact tokenization;
the provider-aware Agent still applies authoritative capacity and overflow recovery.

SQL reads identities and byte lengths before reading message bodies. Oversized
stored text fails closed. Failed or incomplete exchanges do not enter model
history. Older successful exchanges are represented by a lossy brief, with
coverage and fallback status inspectable; the original archive is retained.
See [the continuation contract](PIPS_CHAT_CONTINUITY.md) for thresholds, legacy
backfill, provenance, atomic persistence and remaining limits.

Reasoning reuses DGC's provider mappings. Some providers map levels together or
only support a toggle. When cached capabilities or an explicit configuration
indicate no native reasoning control, the UI reports `instructions`; the effort
then supplies instruction guidance rather than claiming native hidden reasoning.
Opening a conversation uses cached capability inspection only, without network
discovery. Actual execution retains the existing provider metadata/negotiation
path. Provider errors remain failures rather than silent model substitutions.

Effort-enabled replies retain the existing 4,096-token per-request output cap,
including reasoning. Their reasoning watchdog allows 512/1,024/1,536/2,048 tokens
for Low/Medium/High/Extra high. These are DGC guard budgets, not a guarantee that
every provider honors an exact reasoning-token split. Existing wall-time, turn,
tool-call, serialized-input and reply-output limits remain. Scheduled source
workers and reviewed Patch/Pulse execution keep their prior settings.
If a provider rejects the output cap, or its cached capabilities already mark
the cap unsupported, an options-enabled reply fails closed. It does not use the
ordinary interactive adapter's fallback that drops the output-cap field.

The original reply controls need no migration. API 26 adds registry schema 24
for durable continuation checkpoints, with no dependency, permission-mode or
normal configuration change. Older clients can omit options; controls require API 24, and budgets above 32,768 require API 25.
Remote transports that still advertise API 22 must not expose them yet.

## Verification

Deterministic tests exercise real queue persistence, idempotent retry conflicts,
per-Pip restoration, metadata without network calls, unchanged job/global config,
legacy audit settings, strict values and refusal without side effects. A real
Agent with a mocked provider checks selected context/effort and the read-tool
allowlist. Native provider payload construction checks the reasoning/output cap.
These tests do not establish model quality, performance or successful live-app
execution. No founder job, ordinary configuration or installed extension is
modified by the backend tests.


## Auto-compaction within and between replies

Pip replies reuse `Agent.run_turn` and `Agent.maybe_compact` for threshold checks,
tool-output pruning and overflow recovery within each reply. API 26 adds a
persisted, provenance-bound continuation checkpoint between successful replies.
A worker's within-reply compaction brief is included when generating the next
rolling summary. No summary is promoted into instructions or permission.

Open the context control and expand **Conversation continuity** to inspect the
summary and its covered message count. Model summaries and local fallback
summaries are labelled separately. Compaction is lossy; this does not promise
perfect recall or a byte-for-byte replay of the main-chat session. See
[PIPS_CHAT_CONTINUITY.md](PIPS_CHAT_CONTINUITY.md).
