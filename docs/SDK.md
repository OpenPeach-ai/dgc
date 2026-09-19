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

The SDK does not contain the agent. It drives `dgc serve` from a DGC CLI install, so you also need
the CLI (0.41.6 or newer, protocol v14):

```bash
curl -fsSL https://vibedgc.com/install.sh | bash
```

The SDK finds that install itself. It uses the first of these that imports DGC and speaks
protocol v14: the Python named by `DGC_PYTHON`; the Python running your application, when it can
import `dgc`; `dgc` on `PATH`; `~/.local/bin/dgc`; the newest complete version in the installer's
data directory. If none qualifies, `DGC()` raises `DGCConfigError` listing what it tried and
why each was skipped. To pin a particular install, set `DGC_PYTHON` to the Python beside its
launcher, or pass `runtime=[...]`:

```bash
export DGC_PYTHON="$(dirname "$(readlink -f "$(command -v dgc)")")/python"
```

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

- **`DGC`** is a client. It owns one *state directory*: an isolated HOME for the agent
  (transcripts, checkpoints, goals, memory), plus the SDK's usage and audit logs. Your real
  `~/.dgc` is neither read nor written unless you pass `inherit_user_state=True`. Every session of
  one client shares that state, which is what makes `resume` and `fork` work after a restart.
  The directory is created private (0700); one owned by another user or writable by others is
  refused, and without `state_dir` the client uses a fresh private temporary directory. Each
  session writes the agent's config from scratch, so one session's options never leak into the
  next and nothing planted in the directory is merged.
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
the model decides within the limits below.

- **Isolation.** The child gets an isolated HOME under `state_dir`, empty MCP server and hook
  lists, and no configuration from the workspace.
- **The workspace cannot grant itself capabilities.** By default (`trust_workspace=False`) a
  session treats its `cwd` as untrusted input: the repo's own `.dgc/permissions.json` *allow*
  rules are not loaded (so a planted file cannot pre-approve a shell command — even with no
  `RuntimePolicy`), and its `.dgc/agents/*.md` are not loaded (they can choose a model endpoint
  and a credential env var). The workspace can still *narrow* the run with ask/deny rules. Set
  `trust_workspace=True` to opt in; even then a project agent definition keeps only its persona,
  its `base_url`/`api_key_env`/`api_mode`/`model` are ignored, and no agent definition may read a
  `DGC_*_API_KEY`. Project hooks and MCP servers never load in an isolated session (its config is
  written from scratch). Skills, commands and `DGC.md`/`AGENTS.md` are still read as instructions
  (untrusted input the model sees), but grant no permissions and run no code on their own.
- **Environment.** The child does not inherit your process environment. It gets only locale,
  `PATH`, terminal, temp and certificate variables, the isolated HOME, and `extra_env`.
  `inherit_env=["NAME", ...]` passes more by name; `inherit_env=True` passes everything. The
  provider key you pass as `api_key` is handed to the runtime through a private 0600 file that the
  CLI reads and deletes before any tool runs — never the child's environment — and it is stripped
  from every shell/`python`/`monitor`/hook subprocess, so a command like
  `printf %s "$DGC_API_KEY" | rev` cannot recover it. What *does* remain reachable by an
  **unsandboxed** shell (same-user process): anything you pass through `inherit_env`/`extra_env`,
  and other of your processes' environments via `/proc/<pid>/environ`. Run untrusted input under
  the OS sandbox (below), which gives the shell a private `/proc` and drops those.
- **`RuntimePolicy`** limits are enforced by the runtime for that session in every permission
  mode, including `auto`, and are never written to any config file: which tools may run
  (including MCP routes and your custom tools), which paths the file tools may reach (the
  workspace, `extra_read_dirs`, never `deny_path_prefixes`), and whether web, skill-download and
  third-party MCP access is allowed.
- **Shell commands** run arbitrary programs, so no rule on command text can hold them. With the
  default `RuntimePolicy(shell="sandboxed")` the session asks for the OS sandbox (`bwrap` on
  Linux, `sandbox-exec` on macOS): no network unless the policy allows it, no writes outside the
  workspace (none at all when a write tool is denied), no home directory, no access to the client's
  `state_dir`. In `auto` mode the shell runs only inside it and the `python` tool is refused. In
  the other modes every command is a permission request for your `on_permission` callback.
  `shell="screened"` runs the shell **and** the `python` tool unconfined and refuses those whose
  text looks like a network call or file write; that is best effort, not a boundary.
- **A sandboxed-shell policy fails closed.** If the runtime has no working OS sandbox (no
  bubblewrap, or unprivileged user namespaces are disabled), `RuntimePolicy(shell="sandboxed")`
  refuses to start a shell-capable session with `DGCUnsupportedError` rather than run the shell
  unconfined. A `plan` (no-shell) session still starts. To accept the weaker mode on purpose,
  pass `sandbox={"requirement": "preferred"}` (starts, warns, and reports why in
  `Session.sandbox`; in `auto` mode the shell is still refused) or `shell="screened"`.
- **Sandbox requirement.** `sandbox={"requirement": "required"}` refuses to start a session whose
  runtime cannot confine shell commands; `"preferred"` starts anyway, warns, and reports why in
  `Session.sandbox`. DGC verifies bubblewrap actually confines before reporting it available.
- **Logs.** Audit and usage files are created owner-only (0600 in 0700 directories), and audit
  rows are redacted for common credential formats and the key you passed.

## API reference

Everything below is importable from `dgc_sdk`. Parameters after `*` are keyword-only.

### `DGC`

```python
DGC(*, state_dir=None, runtime=None, inherit_user_state=False, model=None, base_url=None,
    api_key=None, mode="default", thinking="off", extra_env=None, inherit_env=False,
    trust_workspace=False, keep_state_dir=False, sandbox=None, instructions="", pricing=None,
    department="", policy=None, retry=None, extra_config=None, start_timeout=30.0,
    request_timeout=15.0)
```

| Parameter | Meaning |
| --- | --- |
| `state_dir` | Private directory for this client's isolated HOME, usage log and audit log. Created 0700 if missing, and an existing one you own is made 0700; refused when owned by another user or writable by others. Use a dedicated directory, not your project. Default: a new private temporary directory, which is removed on `close()` unless `keep_state_dir=True`. |
| `trust_workspace` | `False` (default): a session's workspace is untrusted — its own `.dgc/permissions.json` *allow* rules and its `.dgc/agents` definitions are not loaded, so the checkout cannot grant the run capabilities (it can still *narrow* them with ask/deny rules). `True` opts in; even then a project agent file keeps only its persona, never an endpoint or credential. |
| `keep_state_dir` | Keep an SDK-created temporary `state_dir` after `close()` (an explicit `state_dir` is always kept). |
| `runtime` | Command that starts the agent, for example `["/opt/dgc/.venv/bin/python", "-m", "dgc", "serve"]` or `["dgc", "serve"]`. Default: discovered (see [Install](#install)). |
| `inherit_user_state` | `True` runs against your real `~/.dgc` (your model, rules, MCP servers). Options DGC would have to save there (a different model, `max_turns`, `verify_command`, and so on) raise `DGCConfigError`. Development only. |
| `model`, `base_url`, `api_key` | Model name, OpenAI-compatible endpoint and key for every session. Without them the CLI's own defaults apply. |
| `mode` | Default permission mode: `"plan"`, `"default"`, `"acceptEdits"` or `"auto"`. |
| `thinking` | Reasoning effort passed to the model: `"off"` or a level the CLI accepts. |
| `extra_env` | Environment variables to set in the child. |
| `inherit_env` | Host variables the child may see besides the basic ones: `False`, a list of names, or `True` for all. |
| `sandbox` | A `SandboxPolicy` or `{"requirement": "required" \| "preferred" \| "off"}`. |
| `instructions` | Application instructions added to every prompt of every session. |
| `pricing` | A `Pricing` used to cost each run in the usage log. |
| `department` | Label written on every usage row, for chargeback. |
| `policy` | A `RuntimePolicy` applied to every session. |
| `retry` | A `RetryPolicy`. |
| `extra_config` | Additional DGC settings written into every isolated session's config. |
| `start_timeout` | Seconds to wait for a session's runtime to start and hand-shake. |
| `request_timeout` | Seconds to wait for each control request (`list_sessions`, `set_goal`, and so on). |

Members:

- `version` — the SDK version string. `state_dir` — the state directory as a `Path`.
  `raw_runtime` — the runtime command as a list.
- `session(...)` → `Session` — see below.
- `resume(session_id=None, *, latest=False, cwd, ...)` → `Session` — reopen a persisted
  conversation of this client by id (or transcript path), or the newest with `latest=True`. It
  takes the same keywords as `session()`. An unknown id raises `DGCConfigError` at once.
- `usage_report(*, department=None)` → `dict` — `runs`, `input_tokens`, `output_tokens`,
  `cached_input_tokens`, `cost_usd`, `unknown_usage_runs` (runs whose provider reported no
  tokens; they are excluded from the sums), `by_department`, and the last 500 `rows`.
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
| `permissions` | A `PermissionPolicy` or `{"mode": ..., "unhandled": "deny" \| "callback"}`. `mode` here applies when the `mode` argument is not given. `"callback"` requires `on_permission`. |
| `on_permission` | `(PermissionRequest) -> "once" \| "always" \| "deny"`. `"always"` adds a rule for this session's isolated config. |
| `on_plan` | `(PlanRequest) -> "auto" \| "acceptEdits" \| "default" \| "reject"`. |
| `on_question` | `(QuestionRequest) -> {question_id: QuestionAnswer} \| "dismiss"`. |
| `on_mcp_input` | `(McpInputRequest) -> McpInputResponse`. |
| `model`, `base_url`, `api_key`, `mode`, `thinking`, `instructions`, `sandbox` | Per-session overrides of the client values. |
| `tools` | `ToolSpec`s from `define_tool`, served from your process. |
| `max_turns` | Default cap on model rounds (tool iterations) per prompt in this session. |
| `turn_budget_s` | Wall-clock budget per turn, in seconds. |
| `max_tokens` | Output token cap per model request. |
| `verify_command` | Shell command the agent must pass before it may report completion. |
| `decision_timeout` | Seconds a callback may take before the request is denied; `None` waits for as long as the callback takes. |

Callbacks may be plain functions or `async def` functions; under `AsyncDGC` they are awaited on
your event loop.

### `Session`

Attributes: `session_id`, `session_path` (the transcript file once one exists),
`protocol_version`, `capabilities` (from the runtime handshake), `sandbox` (a `SandboxStatus`:
`requirement`, `active`, `backend`, `reason`), `raw` (the low-level transport; prefer the methods
below).

Running:

- `run(prompt, *, timeout=180.0, max_turns=None, output_schema=None, skills=None, workflow=None, repair_attempts=1)`
  → `RunResult`. `timeout` is in seconds (`None`: no limit); a run that reaches it ends with
  `status="failed"`, `reason="timeout"`. `max_turns` applies to this run only. `output_schema`
  asks for a JSON answer checked against a schema (see [Structured output](#structured-output)).
  `skills` names skills to apply to this prompt; `workflow` is `"plan"`, `"review"` or `"init"`.
- `stream(prompt, **same options)` → `RunHandle`.
- `followup(text, *, timeout=180.0, output_schema=None, skills=None, repair_attempts=1)` →
  `RunHandle` — queue a prompt behind the run in flight (or start it now when idle). Its turn is
  observed, audited and billed like any run. Behind a run with its own `max_turns` or
  `output_schema` it is sent once that run is over, so it runs under the session's settings; it
  does not run when the run in front of it is cancelled or times out.
- `steer(text)` — add guidance to the run in flight; raises `DGCConfigError` when no run is active.
- `cancel()` — stop the run in flight, including one waiting for a decision.
- `close()` — stop this session's child. `Session` is a context manager.

Conversations and checkpoints:

- `list_sessions()` → `list[SessionInfo]` — persisted conversations in this client's state.
- `delete_session(path)` → `list[SessionInfo]`.
- `history()` → `dict` — the current conversation's replayable items.
- `list_checkpoints()` → `list[Checkpoint]`; `rewind(index)` → `dict` — restore files and
  conversation to a checkpoint.
- `fork(name=None)` → `dict` — continue in a new conversation that shares the history so far.
- `new_session()` → `dict`; `name_session(name)` → `dict`.
- `bind_identity()` — refresh `session_path` once this session's transcript exists.
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

A control request the runtime refuses raises `DGCCommandRejectedError` with its `reason`; one that
gets no answer within `request_timeout` raises `DGCTimeoutError`.

### `RunHandle`

Returned by `stream()` and `followup()`. `run_id` identifies the run. Iterate the handle for
`RunEvent`s. `result(timeout=None)` → `RunResult` drains events nobody iterated and returns
when the run ends. `timeout` (seconds) bounds this wait, not the run: when it lapses first,
`DGCTimeoutError` is raised and the run keeps going. With `None` the run's own timeout bounds it.
`cancel()` stops the run. Use it as a context manager: leaving the block before the run ended
cancels it and frees the session.

### Async: `AsyncDGC`, `AsyncSession`, `AsyncRunHandle`

`AsyncDGC` takes the same arguments as `DGC` and has the same members; `await dgc.session(...)`
returns an `AsyncSession` whose methods are the `Session` methods as coroutines
(`await session.run(...)`, `await session.stream(...)` → `AsyncRunHandle`). Iterate a handle with
`async for`, then `await handle.result()`. Cancelling the task that awaits a run cancels the run.
All three are async context managers, and `sync` on `AsyncDGC` and `AsyncSession` returns the
underlying `DGC` or `Session`. The pipe to the child is served on worker threads, so the event
loop is never blocked.

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
| `PermissionPolicy` | `mode: PermissionMode`, `unhandled: UnhandledPolicy` — for `permissions=` |
| `SandboxPolicy` | `requirement: SandboxRequirement` — for `sandbox=` |
| `SandboxStatus` | `requirement`, `active`, `backend`, `reason` — `Session.sandbox` |

Callback types: `OnPermission`, `OnPlan`, `OnQuestion`, `OnMcpInput`. Literal types:
`PermissionMode`, `PermissionAction` (`once`, `always`, `deny`), `PlanAction`, `UnhandledPolicy`
(`deny`, `callback`), `SandboxRequirement` (`required`, `preferred`, `off`), `RunStatus`,
`TaskStatus` (`pending`, `in_progress`, `completed`, `blocked`, `cancelled`).

A callback that raises, returns something else, or does not answer within `decision_timeout` is
treated as `"deny"`, and the failure is logged on the `dgc_sdk` logger.

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
model, which sees the tool as `mcp__app__<name>`. A handler that raises or exceeds `timeout`
returns an error to the model; a timed-out handler's thread is not stopped, so keep handlers
idempotent. `session()` raises `DGCRuntimeError` when the tool server does not connect with every
tool. Tools are served over a private Unix socket that only accepts the session's own relay, so
they need Linux or macOS. `ToolSpec` has `name`, `description`, `input_schema`, `handler`,
`timeout`.

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
              allow_tools=None, redact_events=True, shell="sandboxed")
```

| Field | Meaning |
| --- | --- |
| `network` | `"deny"` refuses web fetch, web search, the browser, skill downloads and MCP servers other than your own tools, and keeps the shell sandbox offline; `"allow"` permits them. |
| `extra_read_dirs` | Directories outside `cwd` the file tools may read. |
| `deny_tools` | Tool names to refuse: DGC tools by internal name (`"write_file"`, `"bash"`, ...) or display name (`"Write"`, `"Bash"`), a custom tool as `"mcp__app__<name>"`, or `"mcp__app__*"`. Unknown names raise `DGCConfigError`. |
| `allow_tools` | When set, every other tool is refused. Same name forms as `deny_tools`. |
| `deny_path_prefixes` | Paths the file tools may neither read nor write; relative ones resolve against `cwd`. A denied prefix *inside* `cwd` turns root-level `glob`/`grep`/`repo_map`/`code_intel`/`git_diff` into permission requests (a search cannot say "this hit is a denied path"), refused in `plan` and `auto` mode; scope a search under a subdirectory to avoid the ask. |
| `shell` | `"sandboxed"` (default) or `"screened"`; see [Security model](#security-model). |
| `redact_events` | Redact secrets in audit rows. |

### `RetryPolicy`

`RetryPolicy(max_attempts=4, retry_on=(429, 500, 502, 503, 504), backoff_s=0.5)`.
`max_attempts` (1 to 11) is how many times a model request whose stream stalls is sent;
`RetryPolicy(max_attempts=1)` turns stall re-issues off. The runtime also retries HTTP 429 and
5xx answers (and 408 from the Anthropic Messages API) and dropped connections on a fixed schedule,
up to 4 tries; `retry_on` and `backoff_s` describe that schedule and cannot be changed (another
value raises `DGCUnsupportedError`). Tool calls are never retried.

### Usage, cost and audit

- `Pricing(input_per_million=0.0, output_per_million=0.0, cached_input_per_million=0.0)` — USD
  per million tokens, set by you. DGC does not know your provider's prices. Input tokens include
  cached ones; the cached part is billed at `cached_input_per_million` (left at 0, at the input
  price).
- `cost_usd(input_tokens, output_tokens, cached_input_tokens, pricing)` → `float | None`.
- A run's `usage` holds the provider's token counts for that run (input, output, cached input),
  or `None` values when the provider did not report them, and `cost_usd` when you set `pricing`.
- `DGC.usage_report()` and `DGC.export_audit()` read the logs in `state_dir`.
- `redact(value)` and `redact_text(text)` apply the SDK's secret redaction to any value or string.

### Results

`RunResult` fields:

| Field | Meaning |
| --- | --- |
| `session_id`, `run_id` | Identity of the conversation and of this run. |
| `status` | `RunStatus`: `completed`, `failed`, `cancelled`, or while in progress `queued`, `running`, `waiting_for_approval`. A denied step does not change the status (see `denials`). |
| `reason` | Why it ended, for example `completed`, `error`, `timeout`, `cancelled`, `transport`. |
| `denials` | `list[Denial]` — every tool call the run refused. `Denial`: `name`, `reason`, `source` (`policy`, `callback`, `hook`, `mode`, `runtime`), `call_id`, `args`. A CI gate can key on this to tell "did nothing / passed" from "was blocked from acting". |
| `final_text` | The agent's final answer. `partial_text` holds text streamed before a stop. |
| `output` | Parsed JSON when `output_schema` was given. |
| `error` | The runtime's error message when the run failed (a missing model, a rejected key), else `None`. |
| `usage` | Token counts and `cost_usd` for this run. |
| `tools` | `list[ToolRecord]` — `ToolRecord`: `name`, `call_id`, `summary`, `output`, `is_error`, `is_diff`, `diff`, `args`. |
| `changes` | `list[FileChange]` — `FileChange`: `path`, `kind` (`added`, `modified`, `deleted`), `before`, `after`, `root`, `diff` (a `git apply`-able patch for that file). |
| `artifacts`, `documents` | `list[Artifact]` — `Artifact`: `id`, `name`, `url`, `rel`. |
| `tasks` | `list[TaskItem]` — `TaskItem`: `id`, `content`, `status`, `revision`. |
| `agents` | `list[AgentInfo]` — `AgentInfo`: `id`, `state`, `description`, `parent_id`, `model`. |
| `verification` | `VerificationResult` (`ok`, `command`, `output`, `exit_code`) for the configured `verify_command` only, else `None`. |

Other result types: `Denial` (`name`, `reason`, `source`, `call_id`, `args`),
`SessionInfo` (`id`, `path`, `name`, `preview`, `message_count`, `when`),
`Checkpoint` (`index`, `preview`, `files`), `SkillInfo` (`name`, `description`, `source`,
`enabled`), `HookInfo` (`event`, `configured`, `matchers`, `valid`, `truncated`),
`PermissionRule` (`action`, `rule`), `McpServerInfo` (`name`, `state`, `enabled`, `tool_count`,
`error`), `Goal` (`text`, `status`, `elapsed_seconds`, `details`), `Monitor` (`id`,
`description`, `command`, `state`, `events`, `persistent`).

### Errors

| Exception | Raised when |
| --- | --- |
| `DGCError` | Base class of every exception the SDK raises. |
| `DGCConfigError` | An option is invalid, or no runtime was found (also a `ValueError`). |
| `DGCUnsupportedError` | A requested capability is unavailable, such as a required sandbox. |
| `DGCRuntimeError` | The runtime could not start, stay alive, or carry out a request. |
| `DGCCommandRejectedError` | The runtime refused a request; `reason` and `command` say which and why. |
| `DGCProtocolError` | The runtime, or every runtime discovery found, speaks another protocol version; the message says whether to update the CLI or dgc-sdk. |
| `DGCTimeoutError` | Startup, a control request, or a `RunHandle.result(timeout)` wait ran out of time (also a `TimeoutError`). |

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
The startup handshake is not a run event, and event types newer than this SDK's copy of the protocol
are skipped rather than ending the session.

## Defaults

| Setting | Default |
| --- | --- |
| `state_dir` | a new private temporary directory |
| Runtime | discovered (see [Install](#install)) |
| Run timeout (`run`, `stream`) | 180 seconds per turn |
| Decision timeout | 30 seconds, then deny |
| Custom tool timeout | 30 seconds |
| Runtime start / control request | 30 / 15 seconds |
| Permission mode | `default` |
| Unhandled permission requests | denied |
| Model and endpoint | the CLI's defaults unless you pass `model` / `base_url` |
| Child environment | basic variables only (`inherit_env=False`) |
| Sandbox | off, unless a `RuntimePolicy` with `shell="sandboxed"` asks for it |
| Output-schema repair attempts | 1 |

## TypeScript

`@vibedgc/sdk` is the same client for Node 22+, attached to each GitHub release as
`vibedgc-sdk-<version>.tgz` (it is not on the npm registry yet):

```bash
npm install https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.3/vibedgc-sdk-0.5.3.tgz
```

```js
import { DGC } from "@vibedgc/sdk";

const dgc = new DGC({ model: process.env.DGC_MODEL, baseUrl: process.env.DGC_BASE_URL });
try {
  const session = await dgc.session({ cwd: ".", permissions: { mode: "plan", unhandled: "deny" } });
  const result = await session.run("Explain the checkout flow. Do not edit files.");
  console.log(result.status, result.finalText, result.error ?? "");
} finally {
  await dgc.close();
}
```

Names are camelCase versions of the Python ones (`stateDir`, `onPermission`, `outputSchema`,
`finalText`, `defineTool`, `usageReport`, `exportAudit`), and every time is in milliseconds
(`timeoutMs`, `decisionTimeoutMs`, `startTimeoutMs`, `requestTimeoutMs`) where Python uses
seconds. The package ships compiled JavaScript and type declarations. It behaves like the Python
client in everything this guide describes:

- **State and isolation.** `stateDir` is optional (a fresh private temporary directory; see
  `dgc.stateDir`), must be private, and each session writes its isolated `config.json` from
  scratch, so a planted or stale file is never merged and per-session options (`model`,
  `maxTurns`, `verifyCommand`, `turnBudgetS`, `maxTokens`) never reach a later session. Extra DGC
  settings go through `extraConfig`. The runtime child gets basic variables only
  (`inheritEnv: false`), and a `dgc/` package in the workspace cannot replace the runtime.
- **Policy and sandbox.** `policy: { network, denyTools, allowTools, extraReadDirs,
  denyPathPrefixes, shell, redactEvents }` is the `RuntimePolicy` above, compiled to the same
  per-session policy the Python client sends (`DGC_SESSION_POLICY`), enforced by the runtime in
  every mode and never written to a config file. `sandbox: "required" | "preferred" | "off"` (or
  `{ requirement }`) works as in Python; `session.sandbox` reports what was applied.
- **Runs.** `stream()` returns a `RunHandle` (`for await` over its events, `result(timeoutMs?)`,
  `cancel()`). `timeoutMs: null` means no limit, and a run that hits its timeout ends
  `status: "failed"`, `reason: "timeout"`. `signal: AbortSignal` cancels a run; so does leaving a
  `for await` loop early. A per-run `maxTurns` and an `outputSchema` repair are restored after
  the run. `followup()` returns a handle for its own observed, audited turn; `steer()` throws
  unless a run is active.
- **Results.** `result.usage` has the provider's token counts (`input_tokens`, `output_tokens`,
  `cached_input_tokens`, `reasoning_tokens`, `requests`; `null` when not reported) and `cost_usd`
  from `pricing`; `usageReport(department?)` returns totals, `unknownUsageRuns`, `byDepartment`
  and the rows. `result.changes` lists `{ path, kind, before, after, root, diff }` with a
  `git apply`-able diff, and `result.verification` reports only the configured `verifyCommand`.
  Failed runs carry the runtime's error in `result.error`.
- **Decisions.** `decisionTimeoutMs` (default 30 000; `null` for no limit) bounds every
  callback, `onMcpInput` included, and a cancel always wins. `permissions.unhandled: "callback"`
  requires `onPermission` and fails the run (`reason: "decision_failed"`) when it throws, times
  out or answers something invalid.
- **Errors.** Every error is a `DGCError`: `DGCConfigError`, `DGCUnsupportedError`,
  `DGCRuntimeError`, `DGCProtocolError` (with `offeredProtocol`, `backendVersion`),
  `DGCCommandRejectedError` (with `reason`, `command`; thrown at once) and `DGCTimeoutError`. A
  failed setup never leaves `dgc serve` or the tool socket behind. Event types newer than the
  SDK are skipped (`session.transport.ignoredEventTypes` counts them).
- **Custom tools.** `defineTool(name, description, inputSchema, handler, { timeoutMs })`. Tools
  are served from a private, randomly named socket in a fresh 0700 directory; the relay proves a
  per-session secret on its first line, and one relay connection is served at a time.
- **Audit.** Audit and usage files are owner-only, and `exportAudit(sessionId?, { redact })`
  redacts with the same rules as Python (`redact` and `redactText` are exported).

Where the Node client differs: there is no separate async class (every call is already async)
and no `RetryPolicy`; the stateDir lock is per process (Python also takes a file lock across
processes), so give each process its own `stateDir`. The Node tool relay cannot mark itself
non-dumpable the way the Python relay does on Linux, so with the OS sandbox off another process
of the same user could read its secret from `/proc`. The secret is refused while the relay is
connected, but such a process could stop the relay and take its place before DGC restarts it.
The OS sandbox (the default for a `RuntimePolicy`) hides both the relay and the socket from the
agent's shell.

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
