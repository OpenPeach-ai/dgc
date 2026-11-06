# DGC SDK

The DGC SDK runs the DGC coding agent inside your own program: an application, a service or a CI
job. Your code starts a session in a workspace, sends a prompt, watches events as the agent works,
answers its permission and question requests, and gets a structured result back.

| Package | Version | Pairs with | Protocol | Runtime |
| --- | --- | --- | --- | --- |
| `dgc-sdk` (Python, PyPI) | **0.9.0** | CLI **0.51.0** | editor protocol v14 | Python 3.10+ |
| `@vibedgc/sdk` (Node, GitHub release tarball) | **0.9.0** | CLI **0.51.0** | editor protocol v14 | Node 22+ |

SDK 0.9.0 has been tested on Linux only. Its suites passed on macOS and on Windows 11 through WSL 2
for an earlier candidate; [sdk/COMPATIBILITY.md](../sdk/COMPATIBILITY.md) records the scope of the
host checks.
Native Windows is experimental (custom tools need Unix sockets).
The SDK is free: there is no DGC fee for embedding it. `Pricing` only lets your
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

### Pips (SDK 0.9.0)

SDK 0.7.0 introduced `session.pips` (`Pips`, and `AsyncPips` on `AsyncDGC` sessions) for
managing the Pips of an existing DGC profile: standing agents that review, test and
draft beside the main chat. SDK 0.9.0 pairs with DGC CLI 0.51.0, which advertises Pips API
74; each control checks the minimum Pips API it needs before sending anything. See
[sdk/PIPS.md](../sdk/PIPS.md) for the full command list and capability gates.

| API | Purpose |
| --- | --- |
| `read(command, params)` | Run one read control, after checking the backend's Pips capabilities. |
| `mutate(command, params, *, approved=False)` | Run one mutation. Refused unless the host passes `approved=True` (TypeScript: `{ approved: true }`) for that call; retries need it again. |
| `list(workspace_id)`, `get(pip_id)`, `runs(pip_id)`, `get_run(run_id)` | Shortcuts for common reads (`getRun` in TypeScript). |
| `run_posts(pip_id, *, before_id=None, limit=None)` | What the Pip's runs posted in its own chat, oldest first, paged by `before_id` (`runPosts` in TypeScript). Needs Pips API 51. |
| `unread(workspace_id)`, `mark_read(pip_id, *, message_id=None, post_id=None, approved=False)` | Read unread Pip reply and run-result counts, then mark only IDs already displayed as read (`unread`, `markRead` in TypeScript). Marking requires explicit host approval; later arrivals remain unread. Needs Pips API 69. |
| `run_fixes(pip_id)` | What Ask DGC to fix did for each of a Pip's runs: the latest fix of each run, newest first, with its `state` (working, or how it ended: `applied`, `partial`, `unchanged`, `failed`, `undone` and so on), the files it changed and the Work chat it ran in, where its Review and Undo are. A Personal Pip has none (`runFixes` in TypeScript). Needs Pips API 65. |
| `register_app(name, *, url, tools, approved)`, `update_app`, `accept_app_update`, `list_apps()` | Your own app's tools for Personal Pips (`registerApp`, `updateApp`, `acceptAppUpdate`, `listApps` in TypeScript). `register_app` answers the app's signing secret, shown that once. Needs Pips API 61; see [Your own app's tools](../sdk/PIPS.md#your-own-apps-tools-api-61). |
| `pending(app=None)`, `decide(action_id, decision, *, expected_digest, approved)` | Approvals in your app: the changes on your own apps that wait for a person, with their digests, and your app's own `"accept"` or `"reject"`, exactly once (`pending`, `decide(actionId, decision, expectedDigest, { approved })` in TypeScript). Needs Pips API 62; see [Approvals in your app](../sdk/PIPS.md#approvals-in-your-app-api-62). |
| `trigger(app, event, payload=None, *, idempotency_key)`, `events(app, *, limit=None)` | Events from your app: tell DGC your app's event happened, and every Personal Pip routine waiting on it runs once, with the payload (JSON, at most 32 KB) as untrusted data; the same `idempotency_key` again runs nothing. No `approved`: it only runs routines a person added. `events` reads what the app sent lately (`trigger(app, event, payload, { idempotencyKey })`, `events(app, { limit })` in TypeScript). Needs Pips API 63; see [Events from your app](../sdk/PIPS.md#events-from-your-app-api-63). |
| `PipTemplate(key, name, instructions, *, model=None, level="ask", tools=(), routines=(), always_allow=())`, `ensure(template, *, approved, accept_widening=False, overwrite_user_changes=False)`, `ensure_all(templates, *, prune=False, approved, ...)`, `templates(pip_id=None)`, `decide_template_change(change_id, decision, *, expected_digest, approved)` | Pip templates in code: your app declares its Personal Pips and makes the real ones match on each deploy. A new key makes its Pip; a known key brings that Pip to the template: narrowing applies, widening (a new change tool, its own computer, a higher level, a new Always allow, a routine newly on your app's event) waits for a person in DGC unless `accept_widening`, and what a person changed in DGC is kept and reported (`conflicts`) unless `overwrite_user_changes`. `ensure_all(..., prune=True)` also pauses, never deletes, the Pips whose key is gone. A Pip made from a template uses only the app tools it lists (`definePipTemplate`, `ensure(template, { approved, acceptWidening, overwriteUserChanges })`, `ensureAll`, `templates`, `decideTemplateChange` in TypeScript). Needs Pips API 64; see [Pips in code](../sdk/PIPS.md#pips-in-code-api-64). |
| `define_pip_tool(name, description, schema, kind, moves_money=False)`, `AppToolHandler(secret, tools)`, `PipToolError` | Describe a tool of your app (`definePipTool`; a `PipTool`) and serve DGC's signed calls to it in your own web framework: `handle`, `handle_async(headers, body)` (an async tool), `flask`, `wsgi` and `asgi` in Python; `handle`, `express` and `fetch` in TypeScript. A tool function gets the call's `PipCallContext` (the Pip, its run, and for a change the accepted action). From Pips API 62, `on_approval_requested` and `on_approval_resolved` (`onApprovalRequested`, `onApprovalResolved`) get a `PipApprovalRequested` or `PipApprovalResolved` when a change waits for a person or is decided; without them the handler answers 204. They need no runtime. |
| `spool(data, *, suffix="")` | Write a photo or file into the runtime's image spool (`ready.capabilities.image_spool_dir`) under a fresh name only you can read, and return the name to send in `send_pip_message`'s `spooled_images` or `spooled_files` (TypeScript: `await spool(bytes, { suffix })`). Needs Pips API 52; see [sdk/PIPS.md](../sdk/PIPS.md). |
| `PipReadCommand`, `PipMutationCommand` | The closed sets of read and mutation command names `read` and `mutate` accept. From Pips API 53 they include `get_pip_eyes` and `set_pip_eyes` (how a Personal Pip whose model reads text only sees); `list_pip_computer_frames` takes `pointers` and `use_pip_computer_view` takes op `pointer`, each refused before API 53. From Pips API 54 they include `get_pip_computer_apps` and `set_pip_computer_apps` (a Pip computer's image editor, document editor and PDF viewer, and the one offer to download the ones it lacks), refused before API 54. From Pips API 55 a Personal Pip's `model_choice` may be `{"mode": "subscription", "engine": "claude" \| "codex"}` (the user's own Claude Code or Codex, held to DGC's Pip tools) in `create_pip`, `propose_pip_update` and `revise_pip_setup`, refused before API 55. From Pips API 56 they include `list_pip_logins`, `save_pip_login`, `remove_pip_login` and `grant_pip_login` (a Personal Pip's saved logins, kept sealed by DGC and typed into its computer's page by DGC; no answer carries a password or a key), refused before API 56. From Pips API 57 they include `get_pip_working_notes`, `set_pip_working_notes` (a Personal Pip's own working notes, which every run of it starts with) and `list_pip_daily_log` (what it did each day), refused before API 57. From Pips API 58 they include `get_pip_level` and `set_pip_level` (how much a Personal Pip asks: `ask`, `approve` or `full`), refused before API 58. From Pips API 59 they include `list_pip_borrows`, `allow_pip_borrow`, `decline_pip_borrow` and `stop_pip_borrow` (a Personal Pip borrowing your own signed-in Chrome: its cards, Allow once, Not now and Stop; no Always allow), refused before API 59. From Pips API 61 they include `register_app`, `update_app`, `accept_app_update`, `list_apps`, `remove_app` and `rotate_app_secret` (your own app's tools, the connection `app:<name>`), and an `app_plan` on `app:<name>`, refused before API 61. From Pips API 62 they include `list_app_approvals` and `decide_app_approval` (approvals in your app), refused before API 62. From Pips API 63 the reads include `list_app_events` and `list_pip_routines` takes `app_events`; `trigger_app_event` is sent with `trigger`, not `mutate`; all refused before API 63. From Pips API 64 they include `list_pip_templates`, `ensure_pip_template`, `prune_pip_templates` and `decide_pip_template_change` (Pip templates in code), refused before API 64. From Pips API 65 the reads include `list_pip_run_fixes` (what Ask DGC to fix did for each of a Pip's runs), refused before API 65. From Pips API 66 `list_pip_models` also says the Pips default as set (`pips_model`) and each model's `context_window` when DGC knows one; no command is added. |

Pips controls need a client opened with `inherit_user_state=True` (TypeScript:
`inheritUserState: true`). Isolated profiles, sessions with a `RuntimePolicy` and
sandboxed sessions refuse them, and plan mode refuses mutations. The SDK never turns
Pips on or starts the runner. Never expose `mutate` to a model as an unattended tool.

`read("get_pip_chat_context", {"pip_id": ..., "context_size": ...})` (a Personal Pip, on this computer) says how
much of the window its next reply takes. From this release its result also carries `breakdown`, a plain dict in
the wire shape behind `context_breakdown()` (`window`, `used`, `source`, `compact_at`, `categories`, `buffer`, `free`;
`ContextBreakdown` calls `categories` `parts`):
what its last reply measured besides the chat (`system_prompt`, `tools` with each tool, `instructions` for its
job, `memory`, `skills`, `plugins` for its connected apps, `data` for its references), then `summary` (its
conversation brief) and `messages`, as the next reply sends them. A Pip that hasn't replied since shows those last
two only, and an older CLI sends no `breakdown`.

### ChatDGC (`DGC.chat()`)

`DGC.chat()` puts ChatDGC, DGC's chat app, in your program: your model answers, searching the web when an answer
depends on it, with every source numbered. It runs on a backend of its own that never opens a workspace (a
private, empty folder in the client's state). With `inherit_user_state=True` (`inheritUserState: true`) these are
your chats, the ones the editor's Chat tab and `dgc chat` list; otherwise the client's own.

```python
from dgc_sdk import DGC

with DGC(inherit_user_state=True) as dgc, dgc.chat() as chats:
    reply = chats.ask("How does compound interest work?")
    print(reply.text)                      # Markdown, with [n] citations
    for source in reply.sources:
        print(source.n, source.title, source.url)

    chat = chats.new()
    for event in chat.stream("And with monthly deposits?"):
        if event.kind == "text":
            print(event.text, end="", flush=True)
```

```typescript
import { DGC } from "@vibedgc/sdk";

const dgc = new DGC({ inheritUserState: true });
try {
  const chats = await dgc.chat();
  const reply = await chats.ask("How does compound interest work?");
  console.log(reply.text, reply.sources);
  const chat = await chats.new();
  for await (const event of chat.stream("And with monthly deposits?")) {
    if (event.kind === "text") process.stdout.write(event.text);
  }
} finally {
  await dgc.close();
}
```

| API | Purpose |
| --- | --- |
| `dgc.chat(model=, thinking=, reply_timeout=)` | `Chats` on its own backend. `model` and `thinking` (`off` to `xhigh`) apply to every message unless one says otherwise; `reply_timeout` (TypeScript `replyTimeoutMs`) bounds each reply; by default there is no limit. A CLI without ChatDGC raises `DGCUnsupportedError`. |
| `chats.ask(text, **options)` | One question in a new chat: its `ChatReply`. Takes `temporary=True` for a chat that's never saved or listed. |
| `chats.list(query=None, limit=, offset=, archived=)` | `ChatSummary` rows, newest first; `query` finds a chat by its title or anything said in it. |
| `chats.new(temporary=)`, `chats.open(chat_id)` | A `Chat`: a new one (saved from its first message) or an existing one with its latest `messages`. |
| `chat.send(text, model=, thinking=, search=, files=, study=, timeout=)` | Send and wait for the whole reply. `search`: `auto` (default), `on` or `off`; `files`: up to ten local files; `study`: `True` turns Study mode on for the chat (it teaches instead of answering), `False` turns it off. |
| `chat.answer(message_id, choice, question=0, choices=None, ...)` | Answer the question card a reply asked (a `question` event), as a click on it does: `choice` for a one-question card, `choices` (one per question, in order) for a card of several. The message the model wrote for it is sent with your answers, and its reply comes back. TypeScript: `chat.answer(messageId, choice, { choices })`. |
| `chat.stream(...)` | The same, as `ChatEvent`s while it's written: `text`, `thinking`, `waiting` (CLI 0.51+: the model was asked and hasn't started; `data` has `model` and `usual_s`), `activity` (searching, looking), `card`, `question`, `research`, and last `reply`. |
| `chat.research(question, edit_plan=, on_event=, timeout=)` | Deep research: a plan you may change, then the research, then a report whose citations are checked. `timeout` bounds each of its two turns (default: the client's `reply_timeout`, no limit unless you gave one). |
| `chat.cancel()`, `rename(title)`, `pin()`, `archive()`, `delete()`, `export(path, format=)`, `refresh()` | Stop a reply (what it wrote is kept), manage the chat, save it as Markdown or JSON. |

A `ChatReply` has `chat_id`, `message_id`, `text`, `sources` (each a `ChatSource`: `n`, `title`, `url`, `snippet`),
`searches`, `files`, `model`, `finish`, `usage` and `trace`. `trace` (CLI 0.51+) is what the reply did, as DGC's Trace
draws it: `{"v": 1, "ms": total, "steps": [...]}`, each step a model round with its reported `tokens`, or a tool with
its `hits` when it searched, and `start` and `end` in milliseconds. A reply that stopped or failed has none. One reply
at a time per chat; any number of chats at once.

`model` also takes `subscription:<engine>` or `subscription:<engine>:<model>` (`claude`, `codex`), a signed-in Claude
Code or Codex on this computer. To use another provider, give the client its address and key:
`DGC(model=, base_url=, api_key=).chat()`. The `provider` field on `chatdgc_*` commands is not exposed: it is how the
editor brings a key from its own store for one turn, and a chat saved that way can't go on without that store.

`@` marks (CLI 0.51+, `capabilities["chatdgc"]["mentions"]`): `chats.mentions()` says what a message can name, for your
own picker: `plugins` [{id, name}], `pips` [{id, name, pip_type, goal}], and `error` when the Pips can't be listed.
`chat.send(text, display_mentions=[...])` (TypeScript `displayMentions`) says where your box drew them, each
`{start, kind, label, identity}`; the sent message has them as `display_mentions` when it is read back. They are for
display only: the model reads `text`, so write the names there too.

Plugin cards in a chat (CLI 0.51+): the first use of `chats.cards`, a [`Cards`](#session), tells the CLI this app draws
them. A reply that shows one then yields a `card` event, and `reply.raw["apps"]` lists its cards.
`AsyncDGC.chat()` returns `AsyncChats`, whose `AsyncChat` has the same API to `await`, with `stream()` an async
iterator. TypeScript uses camelCase (`chatId`, `messageId`,
`timeoutMs`, `editPlan`, `onEvent`) and milliseconds.

### Published packages

```bash
python3 -m pip install dgc-sdk==0.9.0
```

That installs `import dgc_sdk`. Do not `pip install dgc`: the PyPI project named `dgc` is an
unrelated library.

The SDK does not contain the agent. It drives `dgc serve` from a DGC CLI install, so you also need
the CLI (0.51.0 or newer, protocol v14):

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
| `cwd` | Workspace directory. Must exist. An isolated session keeps it as its project root. With `inherit_user_state=True` a folder inside a project resolves to that project's root (its git root, or the folder holding `DGC.md` or `.dgc/`), as the editor and the `dgc` CLI do, so relative paths are written there. |
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

- `run(prompt, *, timeout=None, max_turns=None, output_schema=None, skills=None, workflow=None, repair_attempts=1)`
  → `RunResult`. `timeout` is in seconds per turn; the default, `None`, is no limit, because a big
  model on your own machine can take tens of minutes before its first word and DGC never gives up on
  a model that is still working. A run that reaches a `timeout` you set ends with
  `status="failed"`, `reason="timeout"`. `max_turns` applies to this run only. `output_schema`
  asks for a JSON answer checked against a schema (see [Structured output](#structured-output)).
  `skills` names skills to apply to this prompt; `workflow` is `"plan"`, `"review"` or `"init"`.
- `stream(prompt, **same options)` → `RunHandle`.
- `followup(text, *, timeout=None, output_schema=None, skills=None, repair_attempts=1)` →
  `RunHandle` — queue a prompt behind the run in flight (or start it now when idle). Its turn is
  observed, audited and billed like any run. Behind a run with its own `max_turns` or
  `output_schema` it is sent once that run is over, so it runs under the session's settings; it
  does not run when the run in front of it is cancelled or times out. `cancel()` on a follow-up
  still waiting takes it out of DGC's queue (`capabilities["queue_edit"]`, CLI 0.51+), so it never
  starts and the follow-ups behind it still run; its result is `status="cancelled"` once the run in
  front of it is over. Follow-ups run in the order they were made: each handle reports its own turn
  because it reads after the one in front, so `queue_reorder` is not exposed. An app that wants another
  order keeps its own list and calls `followup` when it is ready.
- `steer(text)` — add guidance to the run in flight; raises `DGCConfigError` when no run is active.
- `cancel()` — stop the run in flight, including one waiting for a decision.
- `set_model(model=None, *, base_url=None, api_key=None, api_mode=None)` → `{"model", "base_url"}` (TypeScript
  `setModel(model, { baseUrl, apiKey, apiMode })`), CLI 0.51+, `capabilities["session_model_route"]`: move this session
  to another model or provider from its next model request, also mid-run. It stays this session's and comes back when
  the session is reopened; the user's settings and other sessions don't change, with `inherit_user_state=True` too. A
  key belongs to its address: moving with `base_url` and no `api_key` sends none to the new one, and the key is kept in
  this process only, so give it again after a reopen. `api_mode` is `auto`, `ollama`, `anthropic`, `chat_completions` or
  `responses`.
- `set_thinking(level)` → the level in use (TypeScript `setThinking`), CLI 0.51+: `off`, `low`, `medium`, `high` or
  `xhigh`, for this session only, as `set_model`.
- `close()` — stop this session's child. `Session` is a context manager.

Conversations and checkpoints:

- `list_sessions()` → `list[SessionInfo]` — persisted conversations in this client's state.
- `delete_session(path)` → `list[SessionInfo]`.
- `history()` → `dict` — the current conversation's replayable items.
- `list_checkpoints()` → `list[Checkpoint]`; `rewind(index)` → `dict` — restore files and
  conversation to a checkpoint.
- `context_breakdown()` → `ContextBreakdown` — what fills the context window, part by part, as DGC's meter shows it:
  `window`, `used`, `source` (`"reported"` by the model, else `"estimated"`), `compact_at`, `parts` biggest first
  (`ContextPart`: `id`, `label`, `tokens`, `items` of `ContextItem` `name`/`tokens`: each tool, MCP tools as
  `server · tool`, each skill, memory by file), `buffer` (the room kept before compaction), `free`, and `deferred`
  (MCP tools found by a search when needed: they take no room yet). Part ids: `messages`, `tool_results`,
  `system_prompt`, `system_tools`, `mcp_tools`, `memory`, `skills`, `plugins`. A CLI without
  `capabilities["context_breakdown"]` raises `DGCUnsupportedError`. TypeScript: `session.contextBreakdown()`
  (`compactAt`).
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
- `list_artifacts()` → `list[Artifact]` (the page previews this session serves); `list_agents()` → `list[AgentInfo]`.

Artifacts (CLI 0.50+, `capabilities["artifacts"]`; without it `session.artifacts` raises `DGCUnsupportedError`):
everything DGC made that the user keeps, in every part of DGC, each with every version. `session.artifacts` is an
`Artifacts`; each call is one request:

- `list(*, type=None, surface=None)` → `list[ArtifactInfo]`, newest first. `type`: `doc`, `slides`, `sheet`,
  `dashboard` or `page`; `surface`: where it was made, `chat`, `work`, `pip`, `sdk` or `cli`.
- `get(artifact_id)` → `ArtifactInfo` with every version; `content(artifact_id, version=None)` → a document's text, or a
  deck's, sheet's or dashboard's data.
- `update(artifact_id, content, *, base_version, note=None)` → `ArtifactInfo`: a new version by "you".
  `DGCCommandRejectedError` with reason `conflict` if it moved on since `base_version`.
- `restore(artifact_id, version)` → `ArtifactInfo`: that version again, as a new one.
- `compare(artifact_id, before, after=None)` → a read-only comparison of saved versions (the current version
  when `after` is omitted). Documents return a text diff; slides, sheets, pages and dashboards return labelled
  changes. `truncated` says when the bounded result omits or shortens content. Requires the CLI's
  `artifacts.compare` capability; otherwise raises `DGCUnsupportedError`.
- `export(artifact_id, format, *, version=None)` → the file's path (`exports` on the artifact lists its formats:
  Word, PDF, Markdown, PowerPoint, Excel, CSV, HTML, zip).
- `open(artifact_id)` → a URL on this computer, the artifact at an address of its own.
- `remove(artifact_id)`: into DGC's trash, where it can be put back.
- `refresh(artifact_id)` → a dashboard's numbers now (its read-only queries, no model);
  `allow_source(artifact_id, source, allowed=True, *, base_version=None)` → `ArtifactInfo`: only an allowed
  source runs. Pass the version whose source settings you showed the user; a stale version is refused with
  reason `conflict`. Version-checked consent requires `artifacts.source_consent_version`; an older CLI raises
  `DGCUnsupportedError` rather than silently dropping that check.

`ArtifactInfo`: `id`, `type`, `title`, `version`, `label`, `created`, `updated`, `origin`, `exports`, `file` (the file a
document is edited in), `versions` (`ArtifactVersion`: `n`, `author`, `at`, `summary`, `size`). `run()` and `stream()`
take `output` (`"document"`, `"slides"`, `"spreadsheet"`, `"page"` or `"dashboard"`, as DGC's Artifact chip): the
result's `made_artifacts` holds what the run made. `AsyncSession.artifacts` is `AsyncArtifacts`, the same calls
awaited. TypeScript: `session.artifacts.list({ type })`, `.update(id, content, { baseVersion })`,
`.compare(id, before, after?)`, `.allowSource(id, source, allowed, baseVersion?)`, and `output` in run options.

DGC Router (CLI 0.51+, `capabilities["router"]`; without it `session.router` raises `DGCUnsupportedError`): the
user's other computers that run models, for sub-agents and Pips. `session.router` (the `router` property) is a `Router`; each call is one
request, and the answers are the CLI's status dicts (`{enabled, when_busy, workers, systems: [...], line}`):

- `status(*, refresh=False)` → every system with its jobs, models, workers busy and free, health and measured speed;
  `refresh` checks every system and re-reads it first.
- `update(action, **fields)` → `{"change", "status"}`: `turn_on`, `turn_off`, `add_system`, `edit_system`,
  `remove_system`, `enable_system`, `disable_system`, `set_model`, `set_jobs`, `set_when_busy`, `apply_suggestion`
  (`system`, `context`), with the fields the model's `router_update` tool takes. `add_system(base_url, *, name=None, system=None, jobs=None, models=None,
  workers=None, one_model_at_a_time=None, memory_gb=None)` is `update("add_system", ...)`.
- `set_key(system, key)`: the only way a system's key travels; DGC keeps it in the user's `secrets.json`, bound to
  the system's address, and never sends it back (a system says `has_key`).
- `probe(system, *, model=None, checks=None)` → the speed, parallel and tool-call tests (and `models`), saved by DGC.
- `find()` → the model servers on this computer's own network, the known ports only.
- `prefer(system=None, model=None)`: where the next turn's helpers run. `run(..., system=, system_model=)` and
  `stream(...)` do this for you: that run's sub-agents go to that system.
- `set_hardware(system, url=None, *, token=None)` (needs `router_hardware` in `capabilities["router"]["commands"]`):
  a system's hardware readout. `url` is an exporter's (node_exporter, NVIDIA DCGM, AMD's device-metrics exporter,
  Glances, Netdata) or a dgc node's address, which the CLI detects; `""` stops it. `token` is a dgc node's pairing
  token, kept in `secrets.json` bound to that address and never sent back (`hardware.has_token`). With neither it
  reads the hardware now. A system's `hardware` in the status has its `line` ("GB10 · 92 of 128 GB · 34% · 61°C").
- `set_thinking(system, model, thinking)` (needs `router_thinking`, TypeScript `setThinking`) → `{"change", "status"}`:
  how hard a helper on that model of that system thinks: `off`, `low`, `medium` or `high`, or `""` for the helper's own
  level. The status's model row says `thinking`, and `thinks` says whether its server reports the model can think.
- `suggest(system, *, context=None)` (needs `router_suggest`) → workers per model from its memory, what the server
  reports and what `probe` measured: `{workers, memory, models: [{name, context, workers, basis, line}], notes,
  applicable}`. A model's `workers` is `None` when nothing backs a number. `update("apply_suggestion", system=...)`
  makes it the settings.

`AsyncSession.router` is `AsyncRouter`, the same calls awaited. TypeScript: `session.router.status()`, `.update(action,
fields)`, `.addSystem(baseUrl, fields)`, `.setKey(system, key)`, `.probe(system, { model, checks })`, `.find()`,
`.prefer(system, model)` (await it before `run`), `.setHardware(system, url, { token })` and
`.suggest(system, { context })`. A Pip runs on DGC Router with the Pips API 70 `model_choice`
`{"mode": "router"}` or `{"mode": "router", "system": id, "model": name}` ([sdk/PIPS.md](../sdk/PIPS.md)).

Plugin cards (MCP Apps; CLI 0.51+, `capabilities["mcp_apps"]`; without it `session.cards` raises
`DGCUnsupportedError`): a plugin's own small app, which DGC's editor draws under the step that used it. An SDK app that
wants to draw them opts in with `session.cards.watch()` (`session.cards`, the `cards` property, is a `Cards`); from then on a tool whose server gave it a card shows it as an
`mcp_app_card` event in the run (and `history()` replays it). Each one carries `card_id`, `plugin`, `tool`,
`tool_input`, the tool's whole `tool_result`, `url` (where the CLI serves the page on loopback, behind the card's own
token, with a CSP built only from the domains it declared) and `html` when it fits one frame.

- `get(card_id)` → the card with its `html`, its whole result and `csp_header`, the exact Content-Security-Policy to
  serve the page with if you serve it yourself.
- `call(card_id, method, params)` → what the card asked of its own server (`tools/call` or `resources/read`):
  `{"result": ...}`, `{"error": {...}}`, or `{"ask": {...}, "request_id": ...}` for a change DGC asks about first.
  Show the user `ask` (the tool, its arguments, and whether `always` may be offered) and pass their choice to
  `answer(asked, "once" | "always" | "deny")`, which returns the outcome.
- `context(card_id, content, structured)` → the card's `ui/update-model-context`: the next turn in that chat gets it
  once, as untrusted plugin content.
- `message_text(card, text)` → a card's `ui/message` as the user's prompt, labelled as the editor labels it; send it
  with `run` as any prompt.

Draw the card in a sandboxed iframe (`allow-scripts allow-same-origin allow-forms`) at `url`, and answer its JSON-RPC
over `postMessage` (`ui/initialize`, then `ui/notifications/tool-input` and `tool-result` from the event), checking
`event.source` on every message. `AsyncSession.cards` is `AsyncCards`, the same calls awaited. TypeScript:
`session.cards.watch()`, `.get(id)`, `.call(id, method, params)`, `.answer(asked, choice)`, `.context(id, content,
structured)` and `Cards.messageText(card, text)`.

Image generation (CLI 0.51+, `capabilities["images"]`; without it `session.images` raises `DGCUnsupportedError`):
the user's image generators (ComfyUI, Automatic1111, OpenAI-compatible, Gemini, Black Forest Labs, fal.ai, Replicate).
`session.images` (the `images` property) is an `Images`; each call is one request:

- `generate(prompt, *, size=None, aspect=None, count=1, images=None, mask=None, generator=None, model=None, seed=None,
  negative_prompt=None, save_to=None, approve=False)` → `{ok, text, images: [{path, rel, sidecar, width, height, seed,
  mime, bytes}], generator, model, cost_usd?, error?, card?}`. Each image is saved with a sidecar in DGC's own folder
  (`.dgc/images/sessions/sdk/` in the home the client runs with: its `state_dir`, or yours with
  `inherit_user_state=True`), or in the project with `save_to` or a save folder the user set in the Images settings.
  A generator that asks before each image (a paid one) runs only with `approve=True`; without it `ok` is false,
  `error["kind"]` is `"needs_approval"` and `card` has its provider, model, size, count and price. `error["kind"]`
  is otherwise one of `needs_credit`, `rate_limited`, `bad_key`, `server_down`, `refused` (by the provider's
  policy), `bad_request` or `failed`.
- `generators(*, refresh=False)` → every generator with what it can do, its price, whether it works now, and this
  project's choice; `refresh` tests each one (no image is made).
- `add(provider, *, base_url=None, key=None, **fields)`, `update(action, **fields)` (`add_generator`,
  `edit_generator`, `remove_generator`, `set_default`, `set_project_choice`, `set_auto_fallback`, `set_save_dir`,
  `set_key`, `test`), `set_key(generator, key)` (the only way a key travels; never sent back), `remove(generator)`,
  `set_default(generator)`, `test(generator=None)`. A ComfyUI `workflow` (API format) comes back first as `pending`
  with the inputs DGC found; add it again with `confirm=True` or a `mapping`.
- `library(*, query=None, surface=None, limit=60, offset=0)` → every image DGC made, newest first.
- After any of these, the session's runs also carry `images_made` events (`{call_id, images, generator, model,
  cost_usd}`) when the model's `generate_image` made pictures; `watch()` asks for them without doing anything else.

`AsyncSession.images` is `AsyncImages`, the same calls awaited. TypeScript: `session.images.generate(prompt, { size,
aspect, count, images, mask, generator, model, seed, negativePrompt, saveTo, approve })`, `.generators({ refresh })`,
`.add(provider, fields)`, `.update(action, fields)`, `.setKey(generator, key)`, `.remove()`, `.setDefault()`,
`.test()` and `.library()`.

Video generation (CLI 0.51+, `capabilities["videos"]`; without it `session.videos` raises `DGCUnsupportedError`): a
video is a long job on one of the user's video generators (the image generators whose `makes` is `videos` or `both`).
`session.videos` is a `Videos`:

- `generate(prompt, *, duration_s=None, aspect=None, resolution=None, image=None, audio=None, generator=None,
  model=None, seed=None, negative_prompt=None, save_to=None, approve=False, wait=True, timeout=1800, poll_s=5)` →
  `{ok, text, job?, card?, error?}`. Every video runs only with `approve=True` (or a generator the user set to make
  videos without asking); without it `ok` is false, `error["kind"]` is `"needs_approval"` (`"over_limit"` when it
  would pass the monthly limit, and it is never sent) and `card` has its length, resolution and price. With `wait`,
  `job` is the ended job; its `result` has `path`, `sidecar`, `poster`, `seconds`, `width`, `height` and `bytes`.
- `generators(*, refresh=False)` → the generators that make videos, each with `video` (lengths, resolutions, shapes,
  sound, start image, price per second, minutes).
- `jobs(job=None)`, `job(id)`, `wait(id, *, timeout, poll_s)`, `stop(id)` (at the provider where it can; `charged`
  says what it cost) and `library(*, query=None, surface=None, limit=60, offset=0)`.
- On the wire: `videos_jobs`, `videos_stop`, `videos_generate` and `videos_library`, answered by `video_jobs` and
  `videos_library`; once a client has sent one, `video_job {job}` events follow its jobs.

`AsyncSession.videos` is `AsyncVideos`, the same calls awaited. TypeScript: `session.videos.generate(prompt, {
durationS, aspect, resolution, image, audio, generator, model, seed, negativePrompt, saveTo, approve, wait, timeoutMs,
pollMs })`, `.generators()`, `.jobs()`, `.job()`, `.wait()`, `.stop()` and `.library()`.

Generative UI is an optional presentation format in a reply. `extract_generative_ui` is the Python
reader and `extractGenerativeUi` is its TypeScript counterpart. Work, ChatDGC and Pips may include a
bounded `dgc-ui` v1 JSON fence alongside ordinary prose. The SDK exposes validated card data without
rendering model HTML or running a choice:

```python
from dgc_sdk import extract_generative_ui

for card in extract_generative_ui(result.final_text):
    print(card["title"], [block["type"] for block in card["blocks"]])
    # Render in your own app. Send a choice's reply via session.run() only after a user click.
```

TypeScript: `import { extractGenerativeUi } from "@vibedgc/sdk";` then
`extractGenerativeUi(result.finalText)`. The same helper accepts text returned from a ChatDGC or
Pip conversation. Cards contain metrics, steps, bars, tables and up to four reply choices. The
normal SDK session, ChatDGC or Pip send method keeps all existing permission decisions; parsing a
card never grants one. Malformed, unknown and oversized card data is ignored. Text fields come back as strings: a
number or true/false the model wrote in one (a metric's value, a table cell) is given as its text, as the editor
draws it; only a bar's value is a number.

Mods (CLI 0.50+, `capabilities["mods"]`; without it `session.mods` raises `DGCUnsupportedError`): small programs that
add panels, status lines, commands and guards to DGC, each in its own sandbox, each able only to watch a step, ask the
user first or stop it, never to approve one. `session(mods=[folder, ...])` runs the folders named (each holds a
`dgc-mod.json`) in that session only; named in your code, they need no other Allow. A folder without a manifest raises
`DGCConfigError` before anything starts. The session's `mods` is a `Mods`:

- `list()` → every mod the session knows: `name`, `title`, `state` (`running`, `stopped`, `crashed`, `off`,
  `needs_allow`), `error`, `asks` (what it can do, in plain words), `commands`.
- `run(name, args="")` → `{mod, text?, tree?, error?}`: one of a mod's own commands, at once, with no model turn.

Writing one: `dgc_sdk.mods` is the library a Python mod imports (inside a running mod it is `dgc_mod`, the same code):
`Mod()` with `@mod.on(event)`, `@mod.command(name)`, `@mod.render(slot)`, `ask()`, `deny()`, `rewrite()` and the
elements (`Box`, `Row`, `Column`, `Text`, `Markdown`, `Button`, `Input`, `Select`, `Bar`, `Table`, `Sparkline`).
TypeScript: `import { Mod, ask, Text } from "@vibedgc/sdk/mods"`. `dgc mods validate`, `dgc mods test` and
`dgc mods dev` check, exercise and live-reload one.
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
| `PermissionRequest` | `id`, `name` (tool), `args`, `summary`, `suggested_rule`, `call_id`, `diff`, `command`, `choices` (the answers it takes, CLI 0.51+: a DGC Router change offers `once` and `deny` only) |
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
| `made_artifacts` | `list[ArtifactInfo]` — the artifacts the run made or changed (CLI 0.50+), as they were when it ended. |
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

`__version__` (`"0.9.0"`), `PROTOCOL` (`14`), `REQUIRES_CLI` (`"0.51.0"`).

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
| `trace_usage` | `tokens` — one finished model request's measured tokens, for a live Trace (CLI 0.51+) |
| `queued` | `count`, `text` — how many prompts are waiting |
| `queue_changed` | `order` (the request ids still waiting, in the order they will run), `removed`, `count` (CLI 0.51+) |

Events are plain dictionaries, not typed classes; check `event.type` before reading `event.data`.
A saved turn's Trace is in `history()`: beside an event, a marker `{"role": "time", "of": "trace", "at": when, "tokens"?: n}`
says when it happened, and a `turn_start` carries `display_mentions` when an editor sent marks.
The startup handshake is not a run event, and event types newer than this SDK's copy of the protocol
are skipped rather than ending the session.

### What the SDK leaves out

Some commands of protocol v14 are for an editor's own screens, and have no method here. `session.raw` still reaches them.

- `set_model_defaults`, `set_subscription_default`, `save_model_provider`: they write the person's own defaults and saved
  providers, for future chats. An SDK client never writes those (`inherit_user_state=True` refuses `model=` for the same
  reason), and the list of saved providers belongs to the editor. Use `set_model` for one session, or `DGC(model=, ...)`
  for a client.
- `resume_session`'s `saved_mode`: it brings a reopened chat back in a mode that may ask less. An app's `resume` keeps the
  mode the app asked for.
- `prompt`'s `display_mentions`: a run's prompt is what the model reads, and your app draws its own transcript.
- `get_pip_usage_report`: `pips.read("get_pip_usage", ...)` reads one Pip, and `session.get_usage(system=)` one system.
- `subagent_thinking` has no method: give it with `extra_config={"subagent_thinking": "low"}` on an isolated client.

## Defaults

| Setting | Default |
| --- | --- |
| `state_dir` | a new private temporary directory |
| Runtime | discovered (see [Install](#install)) |
| Run timeout (`run`, `stream`, `followup`) | none: a run takes as long as the model works |
| Chat reply timeout (`reply_timeout`, `research`) | none |
| Decision timeout | 30 seconds, then deny |
| Custom tool timeout | 30 seconds |
| Runtime start / control request | 30 / 15 seconds (neither applies to a run: a long wait for the model never trips them) |
| Permission mode | `default` |
| Unhandled permission requests | denied |
| Model and endpoint | the CLI's defaults unless you pass `model` / `base_url` |
| Child environment | basic variables only (`inherit_env=False`) |
| Sandbox | off, unless a `RuntimePolicy` with `shell="sandboxed"` asks for it |
| Output-schema repair attempts | 1 |

## TypeScript

`@vibedgc/sdk` is the same client for Node 22+, attached to each GitHub release as
`vibedgc-sdk-<version>.tgz`, which is the same tarball the registry serves:

```bash
npm install @vibedgc/sdk
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
  `dgc.stateDir`, removed on `close()` unless `keepStateDir: true`), must be private, and each
  session writes its isolated `config.json` from scratch, so a planted or stale file is never
  merged and per-session options (`model`, `maxTurns`, `verifyCommand`, `turnBudgetS`,
  `maxTokens`) never reach a later session. Extra DGC settings go through `extraConfig`. The
  runtime child gets basic variables only (`inheritEnv: false`), the provider key reaches it
  through a 0600 file in the state directory that the CLI reads and deletes (never through its
  environment, and never into a tool's), and a `dgc/` package in the workspace cannot replace the
  runtime.
- **Workspace trust.** A workspace cannot grant itself capabilities: its own
  `.dgc/permissions.json` allow rules and `.dgc/agents` definitions are not loaded unless you pass
  `trustWorkspace: true` (its deny rules still narrow what runs).
- **Policy and sandbox.** `policy: { network, denyTools, allowTools, extraReadDirs,
  denyPathPrefixes, shell, redactEvents }` is the `RuntimePolicy` above, compiled to the same
  per-session policy the Python client sends (`DGC_SESSION_POLICY`), enforced by the runtime in
  every mode and never written to a config file. `denyTools`/`allowTools` accept internal or
  display names (`"bash"` or `"Bash"`). `sandbox: "required" | "preferred" | "off"` (or
  `{ requirement }`) works as in Python; `session.sandbox` reports what was applied. The default
  `shell: "sandboxed"` fails closed: with no OS sandbox the session throws `DGCUnsupportedError`
  unless you accept a fallback (`sandbox: "preferred"` or `shell: "screened"`); plan-mode sessions
  still start. `shell: "screened"` screens the `python` tool as well as the shell.
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
  Failed runs carry the runtime's error in `result.error`. `result.denials` lists the calls that
  were refused (`name`, `reason`, `source`: `policy`, `callback`, `hook`, `mode` or `runtime`,
  `callId`, `args`); a refused step does not fail the run, and there is no `blocked` status. A
  refusal by your policy reaches the model as the application's decision, not the user's.
- **Decisions.** `decisionTimeoutMs` (default 30 000; `null` for no limit) bounds every
  callback, `onMcpInput` included, and a cancel always wins. `permissions.unhandled: "callback"`
  requires `onPermission` and fails the run (`reason: "decision_failed"`) when it throws, times
  out or answers something invalid.
- **Errors.** Every error is a `DGCError`: `DGCConfigError`, `DGCUnsupportedError`,
  `DGCRuntimeError`, `DGCProtocolError` (with `offeredProtocol`, `backendVersion`),
  `DGCCommandRejectedError` (with `reason`, `command`; thrown at once) and `DGCTimeoutError`. A
  failed setup never leaves `dgc serve` or the tool socket behind. Event types newer than the
  SDK are skipped (`session.transport.ignoredEventTypes` counts them). `rewind()` with an index
  `listCheckpoints()` does not show throws `DGCConfigError`.
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
python3 -m pip download --no-deps dgc-sdk==0.9.0 -d dl
curl -fsSLO https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.9.0/SHA256SUMS
(cd dl && sha256sum -c ../SHA256SUMS --ignore-missing)
gh attestation verify dl/dgc_sdk-0.9.0-py3-none-any.whl --repo OpenPeach-ai/dgc \
  --signer-workflow OpenPeach-ai/dgc/.github/workflows/publish-dgc-sdk.yml
```

PyPI shows the same provenance on the file's page, and
`pypi-attestations verify pypi --repository https://github.com/OpenPeach-ai/dgc pypi:dgc_sdk-0.9.0-py3-none-any.whl`
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
