# Reviewed specialists inside Patch

This increment lets a human-reviewed Patch handoff authorize named DGC builtin
specialists. It reuses the native Agent loop with the Pip's constrained subclass;
it does not invoke the general Task/worktree dispatcher. The original checkout
is never a specialist's working directory. No output is automatically applied,
merged or deployed.

## Review and compatibility

API 15 adds this optional field to the existing Patch action:

```json
{
  "kind": "patch",
  "write_paths": ["source.py"],
  "tests": [],
  "specialists": {
    "roles": ["explorer", "critic", "worker"],
    "max_calls": 3
  }
}
```

Choose one to three unique roles and a total call cap from one to three. Calls may
reuse a reviewed role, but the total cap remains shared. Omitting `specialists`
keeps the old canonical action, digest and result shape; Task remains denied.
An empty or null grant is invalid. Pulse and read-only actions cannot carry this
grant. The usual saved handoff review, source/target version, source commit,
model connection, run reservation and execution capability checks still apply.
Main-chat handoff tools only propose this action; they cannot approve it.

The enqueue manifest pins the canonical grant, the SHA-256 of each selected
builtin persona plus fixed Pip restrictions, version 1, and fixed run limits.
Queued execution refuses if those persona instructions change. Historical
results validate their saved policy digest and remain readable after a later
persona update; reading old evidence does not authorize new execution.

## Child authority

- Explorer and Critic have the existing confined Pip read tools.
- Worker has those tools plus the parent's exact reviewed file-write paths.
  Each native write call is checked before dispatch, including `apply_patch` and
  `multi_edit`. Final collection independently checks the resulting changed paths.
- Every child shares the same private snapshot, pinned model/endpoint/API mode,
  cancellation event and recovery-point manager as its parent. The shared
  recovery manager preserves pre-edit capture for synchronous child writes.
- Task arguments must contain exactly `agent`, `description` and `prompt`.
  Custom or omitted roles, background flags, nested Task calls and route options
  are refused. Personal/project agent definitions and skills are not loaded into
  these child instructions.
- Shell, Python execution, MCP/network tools, monitors and integration commands
  remain unavailable. Only the separate controller executes the exact commands
  already present in the reviewed action, after all model work has stopped.

Ordinary DGC agents and their general delegation behavior are unchanged.

## Shared budgets and receipts

Parent and children share at most 64 executed native tool calls, 12 reserved
model request/attempt slots and the original 300-second run deadline. A child
does not receive a fresh outer budget. Each model request is configured for at
most 4,096 output tokens. A native retry reserves another slot before transport;
auxiliary model clients use the same reservation wrapper. Optional native
Responses compaction, advisory provider metadata fetches and Ollama load polling
are disabled for this path because they bypass that inference-attempt wrapper.
The parent controller's deadline and process-group cancellation remain the outer
termination mechanism, including blocked provider calls.

An optional `result.specialists` receipt records version, saved policy digest,
calls and whole-run counters. Each call records its generated ID, approved role,
terminal status, pinned model, counters, provider-reported usage and an assessment
preview of at most 1,200 UTF-8 bytes. At most 32 KiB of streamed prose is accepted
per child; empty deltas do not grow a buffer. The complete execution result still
has its existing 64 KiB limit. No child transcript is persisted in this receipt.

Counter meanings are deliberately distinct:

| Field | Meaning |
| --- | --- |
| `requests` | Reserved inference request/attempt slots, including native retries |
| `model_calls` | Entries into the wrapped native `chat` method |
| `transport_attempts` | Native inference transport attempts started |
| `output_token_reservations` | Sum of configured maximum output-token allocations; not measured tokens |
| `usage` | Native provider-reported usage counters |
| `tool_calls` | Executed native tool calls, including parent Task dispatch |

Per-call counts must fit within the whole-run counts. Reported usage remains
separate from reservations; tests using a mocked provider can correctly show
zero transport attempts. A completed specialist assessment is not test evidence.
Actual changes and reviewed command outcomes remain in `result.execution` and
retain the existing explicit outcome-review workflow.

## Platform and acceptance scope

Patch execution retains the existing Linux/bubblewrap capability gate and
committed-source restriction. This bridge adds no macOS, Windows, current-tree,
external app, background or cross-machine execution support. Reviewed commands
retain their documented filesystem, network and resource restrictions from
[PIPS_EXECUTION.md](PIPS_EXECUTION.md).

Deterministic tests exercise real native Agent dispatch with a mocked provider:
all three roles, private reviewed writes, refused extra writes/shell/nesting,
shared request/tool/deadline limits, retry counting, bounded output, immutable
policy pins and historical result compatibility. Existing real Linux bubblewrap
execution tests cover the controller confinement separately. Live configured-
model acceptance and frontend/API advertisement are recorded by the parent
build audit; these fixtures alone do not establish a live model or UI pass.
