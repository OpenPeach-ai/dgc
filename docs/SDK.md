# DGC SDK

The DGC SDK runs the DGC coding agent inside your own program: an application, a service or a CI
job. Your code starts a session in a workspace, sends a prompt, watches events as the agent works,
answers its permission and question requests, and gets a structured result back.

| Package | Version | Pairs with | Protocol | Runtime |
| --- | --- | --- | --- | --- |
| `dgc-sdk` (Python, PyPI) | **0.5.3** | CLI **0.41.6** | editor protocol v14 | Python 3.10+ |
| `@vibedgc/sdk` (Node, GitHub release tarball) | **0.5.3** | CLI **0.41.6** | editor protocol v14 | Node 22+ |

Proven on Linux. macOS and WSL are unproven, and native Windows is experimental (custom tools need
Unix sockets). The SDK is free: there is no DGC fee for embedding it. `Pricing` only lets your
application attribute the model-token spend your provider bills you.

- [Install](#install)
- [Quickstart](#quickstart)
- [How a session works](#how-a-session-works)
- [Security model](#security-model)
- [API reference](#api-reference)
- [Events](#events)
- [Defaults](#defaults)
- [TypeScript](#typescript)
- [Verifying a release](#verifying-a-release)

## Install

```bash
python3 -m pip install dgc-sdk==0.5.3
```

That installs `import dgc_sdk`. Do not `pip install dgc`: the PyPI project named `dgc` is an
unrelated library.

The SDK does not contain the agent. It starts `python -m dgc serve` from a DGC CLI install, so you
also need the CLI (0.41.6 or newer with protocol v14):

```bash
curl -fsSL https://vibedgc.com/install.sh | bash
export DGC_PYTHON="$(dirname "$(readlink -f "$(command -v dgc)")")/python"
```

`DGC_PYTHON` names the Python that runs `dgc serve`: the installer keeps each CLI version in its
own virtual environment and links the `dgc` launcher to it, so the Python beside that launcher is
the right one. You can instead pass `runtime=["/path/to/python", "-m", "dgc", "serve"]` to `DGC`.
Without either, the SDK uses its own interpreter when that interpreter can import `dgc`.

## Quickstart

Point `DGC_MODEL` and `DGC_BASE_URL` at an OpenAI-compatible endpoint (for example a local Ollama
at `http://127.0.0.1:11434/v1`), then run this from the repository you want summarized:

```python
import os
import tempfile

from dgc_sdk import DGC

with DGC(
    state_dir=tempfile.mkdtemp(prefix="dgc-sdk-"),
    model=os.environ["DGC_MODEL"],          # for example "qwen3:8b"
    base_url=os.environ["DGC_BASE_URL"],    # for example "http://127.0.0.1:11434/v1"
    api_key=os.environ.get("DGC_API_KEY"),  # only when the endpoint needs a key
) as dgc:
    session = dgc.session(cwd=".", permissions={"mode": "plan", "unhandled": "deny"})
    result = session.run("Summarize this repository in two sentences. Do not edit files.")
    print(result.status, result.final_text)
    if result.error:
        print("error:", result.error)
```

It prints `completed` and the summary. Plan mode lets the agent read and search the workspace but
not edit it or run commands. `examples/sdk/` has runnable scripts for streaming, resume, CI review,
CI edits with a `git apply`-able patch, and a local browser workbench.

## How a session works

- **`DGC`** is a client. It owns one *state directory*: an isolated HOME for the agent (config,
  transcripts, checkpoints, goals, memory), plus the SDK's usage and audit logs. Your real
  `~/.dgc` is neither read nor written unless you pass `inherit_user_state=True`. Every session of
  one client shares that state, which is what makes `resume` and `fork` work after a restart.
  Use a private directory per application or tenant; never a shared, predictable path such as
  `/tmp/dgc`.
- **`Session`** is one conversation in one workspace (`cwd`), backed by its own `dgc serve` child
  process. A session runs one prompt at a time.
- **`run()`** sends a prompt and blocks until the turn ends. **`stream()`** returns a `RunHandle`
  you iterate for events, then call `.result()`. Both return a `RunResult`.
- **Decisions.** In `default` mode the agent asks before edits and commands. Your
  `on_permission` callback answers `"once"`, `"always"` or `"deny"`. With no callback, requests are
  denied (`unhandled: "deny"`). `on_question` answers the agent's multiple-choice questions,
  `on_plan` answers a proposed plan, and `on_mcp_input` answers MCP elicitation and sampling.
- **Permission modes:** `plan` (read-only), `default` (asks before edits and commands),
  `acceptEdits` (file edits allowed, commands ask), `auto` (no asks; only deny rules and
  `RuntimePolicy` stop a step). Choosing `acceptEdits` or `auto` acknowledges workspace trust for
  that workspace on your behalf.

## Security model

Run untrusted prompts (issue text, pull requests, user input) in `plan` mode, or in `default` mode
with an `on_permission` callback that approves only what you expect. `auto` mode executes whatever
the model decides within the rules below.

- **Isolation.** The child gets an isolated HOME under `state_dir`, empty MCP server and hook
  lists, and only the workspace as a trusted directory.
- **`RuntimePolicy`** turns your restrictions into deny rules that the agent enforces in every
  mode, including `auto`: denied tools, denied path prefixes, and network or write screening for
  shell commands. Shell screening matches command patterns. It stops ordinary commands such as
  `curl` or `echo > file`, but a determined program can reach the network or write files in ways a
  pattern does not recognise. It is a guard rail, not a boundary.
- **The sandbox** is the boundary: `sandbox={"requirement": "required"}` runs commands under
  `bwrap` (Linux) or `sandbox-exec` (macOS), with the network off unless the policy allows it, and
  fails the session if the runtime has no sandbox.
- **Secrets.** Pass the provider key as `api_key`; the SDK hands it to the child in `DGC_API_KEY`
  and strips any `DGC_*_API_KEY` it inherited. DGC masks known secret values in tool output, but
  anything else in your process environment is visible to the agent's shell. Start embeds with a
  minimal environment, and keep cloud credentials out of it.

## API reference

Everything below is importable from `dgc_sdk`. Keyword-only parameters are marked with `*`.

### `DGC`

```python
DGC(*, state_dir, runtime=None, inherit_user_state=False, model=None, base_url=None,
    api_key=None, mode="default", thinking="off", extra_env=None, sandbox=None,
    instructions="", pricing=None, department="", policy=None, retry=None)
```

| Parameter | Meaning |
| --- | --- |
| `state_dir` | Directory for this client's isolated HOME, usage log and audit log. Created if missing. |
| `runtime` | Command that starts the agent, for example `["/opt/dgc/.venv/bin/python", "-m", "dgc", "serve"]`. Default: see [Install](#install). |
| `inherit_user_state` | `True` runs against the real `~/.dgc` (your model, rules, MCP servers). Development only. |
| `model`, `base_url`, `api_key` | Model name, OpenAI-compatible endpoint and key for every session. Without them the CLI's own defaults apply. |
| `mode` | Default permission mode: `"plan"`, `"default"`, `"acceptEdits"` or `"auto"`. |
| `thinking` | Reasoning effort passed to the model: `"off"` or a level the CLI accepts. |
| `extra_env` | Extra environment variables for the child. |
| `sandbox` | `{"requirement": "required" \| "preferred" \| "off"}` (a `SandboxPolicy` value). |
| `instructions` | Application instructions added to every prompt of every session. |
| `pricing` | A `Pricing` used to cost each run in the usage log. |
| `department` | Label written on every usage row, for chargeback. |
| `policy` | A `RuntimePolicy` applied to every session. |
| `retry` | A `RetryPolicy`. |

Members:

- `version` — the SDK version string.
- `raw_runtime` — the runtime command as a list.
- `session(...)` → `Session` — see below.
- `resume(session_id=None, *, latest=False, **session_options)` → `Session` — reopen a persisted
  conversation of this client, by id (or transcript path), or the newest with `latest=True`.
  `session_options` are the same keywords as `session()`. Raises `DGCConfigError` for an unknown id.
- `usage_report(*, department=None)` → `dict` — totals (`runs`, `input_tokens`,
  `output_tokens`, `cached_input_tokens`, `cost_usd`), `by_department`, and the last 500 `rows`.
- `export_audit(session_id=None, *, redact=True)` → `list[dict]` — the audit rows (tool calls,
  results, decisions) of one session, or of all sessions, with secrets redacted.
- `close()` — close every session and stop their children. `DGC` is a context manager.

### `DGC.session`

```python
dgc.session(*, cwd, permissions=None, on_permission=None, on_plan=None, on_question=None,
            on_mcp_input=None, model=None, base_url=None, api_key=None, mode=None,
            thinking=None, tools=(), instructions=None, max_turns=None, sandbox=None,
            verify_command=None, decision_timeout=30.0, turn_budget_s=None, max_tokens=None)
```

| Parameter | Meaning |
| --- | --- |
| `cwd` | Workspace directory. Must exist. |
| `permissions` | `{"mode": ..., "unhandled": "deny" \| "callback"}` (a `PermissionPolicy` value). `mode` here is used when the `mode` argument is not given. |
| `on_permission` | `(PermissionRequest) -> "once" \| "always" \| "deny"`. `"always"` adds a rule to the isolated config. |
| `on_plan` | `(PlanRequest) -> "auto" \| "acceptEdits" \| "default" \| "reject"`. |
| `on_question` | `(QuestionRequest) -> {question_id: QuestionAnswer} \| "dismiss"`. |
| `on_mcp_input` | `(McpInputRequest) -> McpInputResponse`. |
| `model`, `base_url`, `api_key`, `mode`, `thinking`, `instructions`, `sandbox` | Per-session overrides of the client values. |
| `tools` | `ToolSpec`s from `define_tool`, served from your process. |
| `max_turns` | Cap on model rounds per prompt (tool iterations). |
| `turn_budget_s` | Wall-clock budget per turn, in seconds. |
| `max_tokens` | Output token cap per model request. |
| `verify_command` | Shell command the agent must pass before it may report completion. |
| `decision_timeout` | Seconds a callback may take before the request is denied. |

### `Session`

Attributes: `session_id`, `session_path` (the transcript file once one exists),
`protocol_version`, `capabilities` (from the runtime handshake), `raw` (the low-level transport;
prefer the methods below).

Running:

- `run(prompt, *, timeout=180.0, max_turns=None, output_schema=None, skills=None, workflow=None, repair_attempts=1)`
  → `RunResult`. `timeout` is in seconds. `output_schema` asks for a JSON answer checked against a
  schema (see [Structured output](#structured-output)). `skills` names skills to apply to this
  prompt; `workflow` is `"plan"`, `"review"` or `"init"`.
- `stream(prompt, **same options)` → `RunHandle`.
- `cancel()` — stop the run in flight, including one waiting for a decision.
- `steer(text)` — add guidance to the run in flight.
- `followup(text)` — queue a prompt to run after the current one.
- `close()` — stop this session's child. `Session` is a context manager.

Conversations and checkpoints:

- `list_sessions()` → `list[SessionInfo]` — persisted conversations in this client's state.
- `delete_session(path)` → `list[SessionInfo]`.
- `history()` → `dict` — the current conversation's replayable items.
- `list_checkpoints()` → `list[Checkpoint]`; `rewind(index)` → `dict` — restore files and
  conversation to a checkpoint.
- `fork(name=None)` → `dict` — continue in a new conversation that shares the history so far.
- `new_session()` → `dict`; `name_session(name)` → `dict`.
- `bind_identity()` — refresh `session_path` from the runtime's listing.
- `generate_handoff(*, save=False)` → `dict` — a continuation document for the conversation.

Agent state:

- `get_goal()` → `Goal`; `set_goal(text, *, status="active", token_budget=None, replace=False)` → `Goal`.
- `list_skills()` → `list[SkillInfo]`; `get_skill(name)` → `dict`; `set_skill_enabled(name, enabled)` → `dict`.
- `list_hooks()` → `list[HookInfo]`.
- `get_memory()` → `dict[str, str]`; `add_memory(text, *, scope="project")` → `dict[str, str]`.
- `list_permissions()` → `list[PermissionRule]`; `add_permission_rule(action, rule)` and
  `remove_permission_rule(action, rule)` → `list[PermissionRule]`. `action` is `"allow"`, `"ask"` or
  `"deny"`; `rule` uses DGC's rule syntax, for example `"Bash(npm test)"` or `"Write(src/**)"`.
- `add_mcp_server(name, command, args=None)` → `list[McpServerInfo]` — a stdio MCP server;
  `list_mcp_servers()` → `list[McpServerInfo]`.
- `list_monitors()` → `list[Monitor]`; `stop_monitor(monitor_id="all")` → `list[Monitor]`.
- `list_artifacts()` → `list[Artifact]`; `list_agents()` → `list[AgentInfo]`.
- `clear_todos()` → `list[TaskItem]`.
- `get_config()` → `dict`; `get_plan()` → `dict`; `get_usage(range="today")` → `dict` — the
  runtime's own token ledger.

Control requests raise `DGCRuntimeError` when the runtime rejects them, and `DGCTimeoutError`
when no answer arrives.

### `RunHandle`

Returned by `stream()`. Iterate it for `RunEvent`s. `result(timeout=180.0)` → `RunResult` waits
for the end of the run (draining remaining events when called on the iterating thread).
`cancel()` stops the run. Use it as a context manager: leaving the block before the run ended
cancels it.

### Async: `AsyncDGC`, `AsyncSession`, `AsyncRunHandle`

`AsyncDGC` takes the same arguments as `DGC`. `await dgc.session(...)` returns an `AsyncSession`
whose methods mirror `Session` as coroutines (`await session.run(...)`,
`await session.stream(...)` → `AsyncRunHandle`). Iterate a handle with `async for`, then
`await handle.result()`. All three are async context managers. The pipe to the child is served on
worker threads, so the event loop is never blocked.

```python
async with AsyncDGC(state_dir=state, model=model, base_url=base_url) as dgc:
    session = await dgc.session(cwd=".", permissions={"mode": "plan", "unhandled": "deny"})
    handle = await session.stream("Explain the checkout flow.")
    async for event in handle:
        if event.type == "text_delta":
            print(event.data["text"], end="")
    result = await handle.result()
```

### Decisions

| Type | Fields |
| --- | --- |
| `PermissionRequest` | `id`, `name` (tool), `args`, `summary`, `suggested_rule`, `call_id`, `diff`, `command` |
| `PlanRequest` | `id`, `plan` (markdown), `choices` |
| `QuestionRequest` | `id`, `questions: tuple[Question, ...]`, `call_id` |
| `Question` | `id`, `question`, `options: tuple[QuestionOption, ...]`, `header`, `multi_select` |
| `QuestionOption` | `label`, `description`, `recommended` |
| `QuestionAnswer` | `selected` (0-based option indexes), `other` (free text) |
| `McpInputRequest` | `id`, `server`, `kind` (`elicitation`, `sampling_request`, `sampling_response`), `payload` |
| `McpInputResponse` | `action` (`accept`, `decline`, `cancel`), `content` |
| `PermissionPolicy` | `mode: PermissionMode`, `unhandled: UnhandledPolicy` — the shape of `permissions=` |
| `SandboxPolicy` | `requirement: SandboxRequirement` — the shape of `sandbox=` |

Callback types: `OnPermission`, `OnPlan`, `OnQuestion`, `OnMcpInput`. Literal types:
`PermissionMode`, `PermissionAction` (`once`, `always`, `deny`), `PlanAction`, `UnhandledPolicy`
(`deny`, `callback`), `SandboxRequirement` (`required`, `preferred`, `off`), `RunStatus`,
`TaskStatus` (`pending`, `in_progress`, `completed`, `blocked`, `cancelled`).

A callback that raises, or does not answer within `decision_timeout`, is treated as `"deny"`.

### Custom tools

```python
from dgc_sdk import define_tool

lookup = define_tool(
    "sku_lookup", "Look up a product SKU in the catalog",
    {"type": "object", "properties": {"sku": {"type": "string"}}, "required": ["sku"]},
    lambda args: {"sku": args["sku"], "stock": 3},
    timeout=10.0,
)
session = dgc.session(cwd=".", tools=[lookup])
```

`define_tool(name, description, input_schema, handler, timeout=30.0)` → `ToolSpec`. The handler
runs in your process; its return value (text, or anything JSON-serialisable) goes back to the
model. The model sees the tool as `mcp__app__<name>`. A handler that raises or exceeds `timeout`
returns an error to the model. `ToolSpec` has `name`, `description`, `input_schema`, `handler`,
`timeout`. Tools are served over a private Unix socket, so they need Linux or macOS.

### Structured output

`run(..., output_schema=schema)` asks for a JSON answer, parses it, validates it, and asks the
model for a corrected answer up to `repair_attempts` times. The parsed value is in
`result.output`; validation errors are in `result.error`. The schema is a subset of JSON Schema:
`type`, `properties`, `required`, `items`, `enum`, `additionalProperties`, `minLength`,
`maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, `description`, `title`, `default`. Any
other keyword, and `$ref`, raise `DGCConfigError` before the run starts.

### `RuntimePolicy`

```python
RuntimePolicy(network="deny", extra_read_dirs=(), deny_path_prefixes=(), deny_tools=(),
              allow_tools=None, redact_events=True)
```

| Field | Meaning |
| --- | --- |
| `network` | `"deny"` blocks the web tools and screens shell commands for network use; `"allow"` also lets the sandbox reach the network. |
| `extra_read_dirs` | Directories outside `cwd` the agent may read. |
| `deny_path_prefixes` | Paths the agent may neither read nor write. |
| `deny_tools` | Tool names to deny, for example `("write_file", "bash")`. Denying any write tool also screens shell commands for file writes. |
| `allow_tools` | When set, only these tools are allowed. |
| `redact_events` | Redact secrets in audit rows. |

See [Security model](#security-model) for what the screening does and does not stop.

### `RetryPolicy`

`RetryPolicy(max_attempts=4, retry_on=(429, 500, 502, 503, 504), backoff_s=0.5)`. The runtime
retries rate limits and server errors itself; `max_attempts` bounds how often a stalled model
stream is re-issued.

### Usage, cost and audit

- `Pricing(input_per_million=0.0, output_per_million=0.0, cached_input_per_million=0.0)` — USD
  per million tokens, set by you. DGC does not know your provider's prices.
- `cost_usd(input_tokens, output_tokens, cached_input_tokens, pricing)` → `float | None`.
- `DGC.usage_report()` and `DGC.export_audit()` read the logs in `state_dir`.
- `redact(value)` and `redact_text(text)` apply the SDK's secret redaction to any value or string.

### Results

`RunResult` fields:

| Field | Meaning |
| --- | --- |
| `session_id`, `run_id` | Identity of the conversation and of this run. |
| `status` | `RunStatus`: `completed`, `failed`, `cancelled`, `blocked` (a step was denied and the run could not finish), or while streaming `running` / `waiting_for_approval`. |
| `reason` | Why it ended, for example `completed`, `error`, `timeout`, `cancelled`, `permission_denied`, `transport`. |
| `final_text` | The agent's final answer. `partial_text` holds text streamed before a stop. |
| `output` | Parsed JSON when `output_schema` was given. |
| `error` | The runtime's error message when the run failed, else `None`. |
| `usage` | Token counts and `cost_usd` for this run. |
| `tools` | `list[ToolRecord]` — `ToolRecord`: `name`, `call_id`, `summary`, `output`, `is_error`, `is_diff`, `diff`, `args`. |
| `changes` | `list[FileChange]` — `FileChange`: `path`, `kind` (`added`, `modified`, `deleted`), `before`, `after`, `root`. |
| `artifacts`, `documents` | `list[Artifact]` — `Artifact`: `id`, `name`, `url`, `rel`. |
| `tasks` | `list[TaskItem]` — `TaskItem`: `id`, `content`, `status`, `revision`. |
| `agents` | `list[AgentInfo]` — `AgentInfo`: `id`, `state`, `description`, `parent_id`, `model`. |
| `verification` | `VerificationResult` (`ok`, `command`, `output`, `exit_code`) when a `verify_command` was set. |

Other result types: `SessionInfo` (`id`, `path`, `name`, `preview`, `message_count`, `when`),
`Checkpoint` (`index`, `preview`, `files`), `SkillInfo` (`name`, `description`, `source`,
`enabled`), `HookInfo` (`event`, `configured`, `matchers`, `valid`, `truncated`),
`PermissionRule` (`action`, `rule`), `McpServerInfo` (`name`, `state`, `enabled`, `tool_count`,
`error`), `Goal` (`text`, `status`, `elapsed_seconds`, `details`), `Monitor` (`id`,
`description`, `command`, `state`, `events`, `persistent`).

### Errors

| Exception | Raised when |
| --- | --- |
| `DGCError` | Base class of every SDK exception. |
| `DGCConfigError` | An option is invalid (also a `ValueError`). |
| `DGCUnsupportedError` | A requested capability is unavailable, such as a required sandbox. |
| `DGCRuntimeError` | The child could not start, stay alive, or rejected a request. |
| `DGCProtocolError` | The runtime speaks another protocol version; the message names the CLI you need. |
| `DGCTimeoutError` | A control request or startup did not answer in time (also a `TimeoutError`). |

A run that fails does not raise: its `RunResult` has `status="failed"` and the reason in `error`.

### Constants

`__version__` (`"0.5.3"`), `PROTOCOL` (`14`), `REQUIRES_CLI` (`"0.41.6"`).

## Events

`RunEvent` has `type`, `data` (the event's fields), `session_id`, `run_id` and `request_id`. The
event types and every field are defined by editor protocol v14 in
[`schemas/editor-protocol-v14.schema.json`](../schemas/editor-protocol-v14.schema.json). The ones
most applications use:

| `type` | `data` fields |
| --- | --- |
| `turn_start` | `turn_id`, `prompt`, `kind` |
| `text_delta` | `text` — the next piece of the answer |
| `thinking_delta` | `text` — reasoning text, when the model streams it |
| `tool_call` | `call_id`, `name`, `args`, `summary` |
| `tool_result` | `call_id`, `name`, `output`, `is_error`, `is_diff`, `diff` |
| `tool_denied` | `call_id`, `name`, `args`, `reason` |
| `permission_request` | `id`, `name`, `args`, `command`, `summary`, `diff`, `suggested_rule`, `choices` |
| `options_request` | `id`, `questions` |
| `plan_proposal` | `id`, `plan`, `choices` |
| `todos` | `todos` |
| `model_retry` | `state`, `kind`, `attempt`, `summary`, `http_status` |
| `context` | `used`, `size`, `input_tokens`, `output_tokens`, `cached_input_tokens` |
| `error` | `message` |
| `turn_end` | `turn_id`, `reason` (`completed`, `cancelled`, `error`) |

Events are plain dictionaries, not typed classes; check `event.type` before reading `event.data`.

## Defaults

| Setting | Default |
| --- | --- |
| Run timeout (`run`, `stream`) | 180 seconds |
| Decision timeout | 30 seconds, then deny |
| Custom tool timeout | 30 seconds |
| Permission mode | `default` |
| Unhandled permission requests | denied |
| Model and endpoint | the CLI's defaults unless you pass `model` / `base_url` |
| Sandbox | off |
| Output-schema repair attempts | 1 |

## TypeScript

`@vibedgc/sdk` is the same client for Node 22+, attached to each GitHub release as
`vibedgc-sdk-<version>.tgz` (it is not on the npm registry yet):

```bash
npm install https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.3/vibedgc-sdk-0.5.3.tgz
```

```js
import { DGC } from "@vibedgc/sdk";

const dgc = new DGC({ stateDir, model: process.env.DGC_MODEL, baseUrl: process.env.DGC_BASE_URL });
const session = await dgc.session({ cwd: ".", permissions: { mode: "plan", unhandled: "deny" } });
const result = await session.run("Explain the checkout flow. Do not edit files.");
console.log(result.status, result.finalText);
await dgc.close();
```

Names are camelCase versions of the Python ones (`stateDir`, `onPermission`, `outputSchema`,
`finalText`, `defineTool`, `usageReport`, `exportAudit`). The package ships compiled JavaScript
and type declarations.

## Verifying a release

`.github/workflows/publish-dgc-sdk.yml` builds each release from its `sdk-vX.Y.Z` tag only. It
uploads the wheel and sdist to PyPI through Trusted Publishing, which records a PEP 740
attestation naming this repository and workflow, and attaches the same bytes, the npm tarball, a
CycloneDX SBOM and `SHA256SUMS` to the GitHub release, each with a GitHub artifact attestation.

```bash
# The PyPI file matches the GitHub release, and the workflow built it from the tag:
python3 -m pip download --no-deps dgc-sdk==0.5.3 -d dl
curl -fsSLO https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.3/SHA256SUMS
(cd dl && sha256sum -c ../SHA256SUMS --ignore-missing)
gh attestation verify dl/dgc_sdk-0.5.3-py3-none-any.whl --repo OpenPeach-ai/dgc \
  --signer-workflow OpenPeach-ai/dgc/.github/workflows/publish-dgc-sdk.yml
```

PyPI shows the same provenance on the file's page, and
`pypi-attestations verify pypi --repository https://github.com/OpenPeach-ai/dgc pypi:dgc_sdk-0.5.3-py3-none-any.whl`
checks it from the command line.

The source tree also carries a checkout manifest: `sdk/sbom/SHA256SUMS` lists every SDK source
file and is signed by the maintainer key committed as `sdk/sbom/sdk.pub` (SHA-256 of the DER key
`beab49d20fdb70382fdc60098d10988dd45e7ab25a1e930f4e4879de068808a0`):

```bash
openssl dgst -sha256 -verify sdk/sbom/sdk.pub -signature sdk/sbom/SHA256SUMS.sig sdk/sbom/SHA256SUMS
sha256sum -c sdk/sbom/SHA256SUMS
```

Compatibility across versions is in [`sdk/COMPATIBILITY.md`](../sdk/COMPATIBILITY.md) and changes
are in [`sdk/CHANGELOG.md`](../sdk/CHANGELOG.md).
