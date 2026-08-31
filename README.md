<div align="center">

<img src="docs/dgc-logo.png" alt="DGC" width="380">

# Vibe DGC

**A coding-agent CLI for the models *you* run** — the same `///` you see in the terminal.
Built by Mohit Kalra.

</div>

---

DGC is an interactive coding agent that lives in your terminal and points at **the model endpoint you choose**: local Ollama, llama.cpp, LM Studio, or vLLM; native Anthropic or OpenAI; and compatible clouds such as OpenRouter, Groq, DeepSeek, Together, and Mistral.

![Vibe DGC — the CLI welcome screen](docs/welcome.png)

<sub>The welcome screen, pointed at your own local model — the `///` mark, the session menu, and the **mode · model** status line.</sub>

Pure Python 3.10+, three dependencies (`rich`, `prompt_toolkit`, `requests`). Your code and your prompts never leave your machine unless the model you pick is a cloud one.

![DGC docked in your editor — VS Code and Cursor](docs/screenshot.png)

<sub>The same agent and local models inside a native editor side panel — streaming tool cards, inline diffs, session resume. Installs alongside the CLI ([VS Code · Cursor](https://vibedgc.com)).</sub>

## Install

One line — nothing needs root:

```bash
curl -fsSL https://vibedgc.com/install.sh | bash
```

Then point it at a model and go:

```bash
dgc setup     # pick a provider + model, interactively
dgc doctor    # check it can reach your model
dgc           # start the interactive agent
```

<sub>Prefer to do it by hand? See [Manual install](#manual-install). Want your own coding agent to set it up? See [Let your agent install it](#let-your-agent-install-it).</sub>

## Connect any model in one command

`dgc setup` walks you through these with **arrow-key menus** (↑/↓ or j/k · enter · esc to go back) — as do `/connect`, `/models`, `/search` and `/resume` inside the REPL:

| Preset | Endpoint | Notes |
|---|---|---|
| `ollama` | `localhost:11434/v1` | local, default |
| `llamacpp` | `localhost:8080/v1` | `llama-server` from llama.cpp |
| `lmstudio` | `localhost:1234/v1` | LM Studio |
| `vllm` | `localhost:8000/v1` | vLLM |
| `openai` | `api.openai.com` | prompts for API key |
| `openrouter` | `openrouter.ai` | 100s of models, one key |
| `groq` · `deepseek` · `together` · `mistral` | — | cloud, prompt for key |

```
/connect ollama
/connect openrouter        # securely prompts for the key
/models                 # list what the endpoint serves
/model qwen3.6:27b-q8_0
```

## Benchmarks

Same local model (`qwen3.8:27b-bf16`), measured two ways — full writeup + a one-command reproduction at **[vibedgc.com/benchmark](https://vibedgc.com/benchmark)**:

- **Aider polyglot** (225 problems across 6 languages): **98.9%** solved with the cap lifted to the time a local model actually needs — the marathon on your own hardware. On the leaderboards' strict 600&nbsp;s/problem sprint cap: 95.6% (level with OpenCode, a couple behind the leaders).
- **SWE-bench Lite** (300 real GitHub issues; each patch graded by that project's own unmodified test suite): **61.3%** (184/300) — a strong result for a 27B model you run yourself.

## Permission modes

Switch live with `/mode` (cycles) or `/mode <name>`, or launch with `--mode`:

| Mode | Behavior |
|---|---|
| `default` | structured reads auto-run; **every file write and shell command asks** |
| `acceptEdits` | **file edits auto-approved**; shell commands still ask |
| `plan` | **read-only** — the agent researches and proposes a plan you approve |
| `auto` | **full-auto** — everything approved, the agent works unattended until done |

Fine-grained rules on top (evaluated deny → ask → allow):

```
/permissions allow Bash(npm run *)
/permissions allow Edit(src/**)
/permissions deny  Bash(rm -rf *)
/permissions deny  Read(**/.env)
```

Approval prompts always offer **allow once / always allow (saves a rule) / deny**.

## What's in the box

- **Multiple agents at once** — run a **fleet**: `Ctrl+N` spawns a new agent (even while one is running), `Ctrl+O` cycles, `Ctrl+\` opens the **dashboard** — every agent with its live state (● on screen · ⋮ working · ◆ needs you · ○ idle), where you attach, close, pin, and rename. A background agent that finishes or needs a decision flags itself in the bottom bar. The launch agent stays in your selected checkout; every additional agent in a Git project automatically gets an owner-private `dgc/fleet-*` worktree containing the source checkout's exact tracked and non-ignored untracked baseline. Each owns its model/config/MCP runtime and can write concurrently under its own crash-safe lease. Closing an untouched managed checkout cleans it up; changed, committed, uncertain, or still-running work is retained with its branch/path, and reopening the saved conversation safely reattaches to it. Non-Git fleets fall back explicitly to serialized shared-checkout writes. `/worktree <name>` remains available for a deliberately named long-lived branch, while delegated `task` work uses separate automatic task worktrees.
- **Interactive REPL** — streaming output, live tool-call display, diffs, todos, a highlighted prompt band, collapsible thinking sections, a per-phase status timer (`Thinking… 0.4s`), a top-right context-window meter (click it for a usage breakdown), and centered dialogs. After a mutation, `verify_before_done` holds only the attempted final answer until its configured verifier passes: a rejected completion claim never reaches the terminal, editor, headless, or ACP output and is replaced in resumable history, while genuine tool commentary still appears before its tool card. In a timed autonomous turn, an edit-only batch runs that explicit verifier immediately: red evidence reaches the next model request directly, while green evidence closes locally without a test-request or summary generation. Untimed interactive cadence remains model-authored, and its no-tools final reuses an exact verifier pass until a later mutation-unknown MCP call invalidates it instead of rerunning the same command; configured PostToolUse hooks conservatively retain the final controller check. Completed generations are also journaled under fixed argument-free controller reasons, making tool continuation, verifier recovery, steering, compaction, and auxiliary work distinguishable in benchmark reports without retaining prompts or model text.
- **Plan mode** — read-only research → `present_plan` → reject with feedback or approve into acceptEdits/default/auto. Plans are saved beside the session, reopened with `/view-plan`, and rendered by default as a self-contained loopback-only preview. Full-auto approval has a separate warning gate.
- **Artifacts** — the agent can serve a page/app/chart it builds. Project artifacts share one configurable server and persisted dropdown; proposed plans use a separate private loopback server so a LAN setting can never expose them. `/artifact` lists, opens, and stops both kinds.
- **Standing goals** — `/goal <objective>` keeps a bounded objective active across turns and resume. `/goal complete`, `/goal blocked`, `/goal resume`, and `/goal clear` make its lifecycle explicit; the CLI, editor backend, and ACP adapter carry typed goal state.
- **Continuation handoffs** — `/handoff` snapshots one generation-stable session, asks the configured model for a bounded self-contained continuation document, redacts it, and saves a new owner-private `HANDOFF-*.md` through the workspace mutation lease and atomic no-follow writer. Concurrent turns fail visibly instead of producing a mixed transcript. VS Code/Cursor renders the same typed result; headless controllers can request output-only or an atomic save.
- **In-app docs** — `/docs` opens a searchable how-to library right in the terminal (getting started, shortcuts, plan mode, artifacts, MCP, skills, sessions…), each page a scrollable reader.
- **Next-prompt suggestions** — after each turn DGC predicts a sensible follow-up as ghost text; press **Tab / →** to accept it (toggle with the `suggest` config). Title and suggestion generations wait for fleet-wide idle time, run serially with small output/stall caps, and are canceled before the next real prompt so they never compete with foreground local-model work.
- **Runs tiny local models** — if the endpoint has no native tool-calling, DGC auto-switches to a text tool-call protocol and parses it.
- **Code intelligence without lock-in** — `repo_map` inventories a project and `code_intel` finds symbols, exact definitions/references, and syntax diagnostics with a bounded built-in fallback. Configure a stdio language server for richer results; DGC confines returned paths to the project and safely reuses up to four project/spec sessions with serialized queries and idle cleanup. Set `code_intel_lsp_idle_s: 0` for one-shot isolation.
- **Adaptive tool and skill catalog** — ordinary coding turns keep the complete core read/edit/search/shell surface while web, artifact, skill-install, memory, goal, delegation, and reusable-skill metadata appear only when the request needs them. `bash_output`/`bash_kill` appear automatically only while that agent owns retained output/a background process, and full-auto omits the blocking options prompt. The system prefix stays stable throughout the day for provider/local prefix reuse, and text-only endpoints receive the same schemas as compact JSON instead of repeated formatting whitespace. This removes repeated irrelevant prefill for small local models; set `tool_profile: full` to expose the full catalog allowed by the current permission mode.
- **Auto context compaction** — near ~85% of your model's context window (configurable via `compact_threshold`), official OpenAI Responses endpoints use bounded loss-aware native compaction and durably replay its opaque continuation state; unsupported providers use the bounded local summarizer. Cancellation, malformed/oversized output, or summarizer failure falls back to a deterministic head-and-tail evidence brief instead of dropping prior context. `/compact` forces it.
- **Thinking modes** — `/think off|low|medium|high`; `think` / `think hard` / `ultrathink` in a prompt bump it for that turn. `<think>` streams dim.
- **Memory** — `DGC.md` in your project (and `~/.dgc/DGC.md` personal) load into every session; `#a fact` quick-adds; `/init` writes a project guide.
- **Web search** — the model gets a `web_search` tool. DuckDuckGo works keyless out of the box; add Brave/Tavily (API key) or SearXNG (self-hosted URL) via `dgc setup` or `/search`.
- **Session persistence** — every conversation is saved per project; `dgc --continue` resumes the most recent, `dgc --resume` picks one.
- **Credential-safe history and UI** — live DGC/provider credentials plus high-confidence authorization, token, private-key, and password shapes are masked before model context, tool results, terminal/editor/ACP output, saved plans, and session conversation history. Masking survives arbitrary provider stream chunk boundaries and preserves opaque signed/encrypted continuation fields. A credential-bearing approval can run once but can never create a persistent permission rule. Exact file rewind snapshots stay byte-for-byte correct inside the owner-private session; they are not text-redacted.
- **Durable checkpoints & rewind** — `/rewind` restores the exact pre-turn conversation plus direct file-tool and integrated sub-agent changes, including binary files, executable modes, symlinks, deletions, and new files. Project-root snapshots live atomically inside the private session, so they survive `/resume` and transcript compaction; a direct edit is refused if its pre-edit state cannot be saved. Arbitrary shell writes cannot be enumerated reliably, and explicitly approved external-path snapshots remain current-process only rather than becoming restart-time authority outside the project.
- **Self-update** — `dgc` checks for a newer version and flags it in the banner; `dgc update` installs it.
- **Skills** — ships **16 built-in skills** (`batch`, `code-review`, `dataviz`, `debug`, `deep-research`, `dgc-design`, `handoff`, `loop`, `onboard`, `plan`, `refactor`, `security-review`, `setup`, `ship`, `verify`, `write-tests`) plus your own: drop a `SKILL.md` in `.dgc/skills/<name>/` or `~/.dgc/skills/`. Skill catalogs, files, metadata, bodies, and argument expansion are bounded; discovery and installation reject symlink redirection. Adaptive mode advertises only a narrowly matching or explicitly named skill, while `/skills`, `/skill NAME`, and `tool_profile: full` retain deliberate access (project overrides user overrides built-in). The typed headless/editor catalog reports that winning `project`/`user`/`builtin` layer without exposing host paths. `dgc-design` encodes DGC's frontend design language and stays off for normal coding — artifacts load it automatically.
- **Sub-agents** — the `task` tool hands a self-contained job to a fresh autonomous sub-agent with its own context, transient root-scoped config, MCP runtime, cancellation, and correlated tool UI. In a Git project DGC creates a private checkout containing the caller's tracked and non-ignored untracked baseline, then applies only the child's delta after a content-level conflict check. In full-auto mode, an all-`task` model response fans independent calls out concurrently (four workers by default, bounded to eight): every child receives the same leased baseline, completed UI traces replay without interleaving, and integration happens in model-call order. Set `max_parallel_tasks: 1` to disable this. A child never auto-overwrites a file that was already dirty; overlapping, conflicting, or incomplete work is retained with its path and branch, while successful changes join the parent checkpoint and usage/edit accounting. `/tasks` lists preserved work; `/tasks apply ID` revalidates and applies its conflict-free delta into `/rewind`, while `/tasks drop ID --confirm` explicitly discards it. The VS Code/Cursor command palette exposes the same typed recovery flow. Sub-agents can run on a *different* local model/host than the main loop — set `subagent_model` / `subagent_base_url` globally (with that host's key in `DGC_SUBAGENT_API_KEY`), or define named agents in `.dgc/agents/<name>.md` (frontmatter: name, description, model, base_url, `api_mode`, `api_key_env`, effort) and pick one with the task tool's `agent` argument. Another host never receives the main provider key and auto-detects its own transport; `subagent_api_mode` overrides it. `/agents` lists them; `/subagent` sets the defaults.
- **MCP servers** — connect stdio MCP servers (configured in `~/.dgc/config.json` → `mcp_servers`) and their tools join DGC's own. DGC negotiates the stateless MCP 2026 wire with a fresh-process fallback for handshake-era servers, exposes a deterministic bounded tool catalog, honors validated cache TTL/scope metadata, and consumes ID-correlated `tools/list_changed` subscriptions with legacy notification compatibility. Small catalogs retain direct zero-round-trip tools; oversized catalogs fit context-relevant definitions into a model-window budget and expose `mcp_search` plus approval-gated `mcp_call`, so hidden or individually oversized definitions remain discoverable and callable without resending megabytes of schema every turn. Schema construction and bounded lexical indexing happen once per catalog generation, including ordinary word inflections, rather than repeatedly serializing every parameter definition on each model round. It bounds inbound/outbound frames and stalled writes, and carries roots MRTR, cancellation, progress, severity-filtered logs, typed content, and visible process failures. Form/URL elicitation and tools-free sampling are capability-negotiated and always user-gated: forms reject credential/payment fields and are validated before disclosure, URLs are never fetched or opened without consent, and sampling uses no project transcript or tools and requires approval before generation and again before its result reaches the server. `/mcp` shows each server's negotiated era and catalog state. Headless controllers use the typed `list_mcp_tools` and `call_mcp_tool` commands; exact calls retain the same permission, hook, lease, progress/input, cancellation, redaction, and output boundaries as model-issued calls.
- **Lifecycle hooks** — run bounded shell commands on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, and `Stop` (config → `hooks`). Hooks share the checkout lease, honor `/sandbox`, and expose command-free lifecycle status across terminal, editor, ACP, and headless clients. `/hooks` and typed `list_hooks` report only bounded event counts and redacted exact matchers—never configured commands or environment values.
- **Vision and file input** — classic CLI and TUI share the same `@path/to/file` route. Text is
  redacted then bounded before entering context; images are byte-bounded and signature-checked.
  Quote paths containing spaces, for example `@"design references/home.png"`. An explicitly named
  external file is a one-file disclosure only—it does not grant the model access to its directory.
- **Model fallback** — set `fallback_model` (and optional `fallback_base_url`) and DGC retries there if the primary model errors. Put another host's credential in `DGC_FALLBACK_API_KEY`; DGC never forwards the main provider key there, auto-detects its transport, and honors a `fallback_api_mode` override.
- **Custom slash-commands** — drop a Markdown prompt template in `.dgc/commands/*.md` and call it as `/name`; project commands appear in the classic/TUI/editor/ACP catalogs. Names begin with a lowercase letter/digit, then use lowercase letters/digits or `._-` (1–64 characters). Built-in names and aliases are reserved, catalogs/templates are bounded, and symlinked command directories or files are rejected.
- **Editor & ACP integration** — `dgc serve` backs the VS Code / Cursor extension through a generated protocol-v3 command/event contract with bounded frames and strict wire ordering. Permission, plan, option, and MCP decisions are exactly ID-correlated and first-response-wins; control frames bypass prompt backpressure, while expired, duplicate, mismatched, and post-restart responses fail closed. Typed `/skills` and `/handoff` routes render inert bounded metadata/Markdown and never forward built-in slash text to the model. Pasted images are count/byte bounded in the webview and revalidated by media signature before provider use; remote image URLs are rejected. Live multi-root changes are acknowledged and coalesced across active turns so added folders gain access and removed folders lose their session grant; editor context and `@file` mentions keep visible labels separate from typed canonical paths across roots. `dgc acp` speaks bounded UTF-8 Agent Client Protocol JSON-RPC over stdio, limits prompt blocks/text/images, and frames embedded resources as untrusted data.
- **Mid-turn steering and queueing** — in the full-screen terminal, a follow-up typed while the model
  is working is injected at its next tool boundary. Once final response ownership has closed—or while
  a direct `!` shell command runs—the text is retained in a count/size-bounded per-session FIFO and
  starts as the next turn, including after cancellation or failure. The editor/headless backend
  separately executes up to 32 submitted turns in a count/aggregate-byte-bounded FIFO. Overflow is
  rejected visibly, and prompts submitted while a cancelled turn unwinds are not stranded.
  Editor, ACP, and terminal interrupts also remain effective during worker startup.
- **Tools** — `read_file` · `repo_map` · `code_intel` · `glob` · `grep` · `write_file` · `edit_file` · `multi_edit` · `apply_patch` · `bash` · `bash_output` · `bash_kill` · `web_fetch` · `web_search` · `todo` · `skill` · `add_skill` · `task` · `artifact` · `save_memory` · `present_plan` · `propose_options` · `update_goal`.
  Foreground command output is drained continuously through credential masking into a bounded,
  process-local result; oversized results can be searched literally or paged with `bash_output`
  without relying on a host `/tmp` path that may be invisible inside the sandbox. Background and
  retained-result handles are isolated to the originating agent session and expire after 30 minutes.
  An explicit terminal `!cmd` uses the same sandbox, bounded output, cancellation, checkout lease,
  and process-tree cleanup without asking the model to interpret the command.

## REPL conveniences

```
just type            ask DGC — it uses tools to act on your project
#fact                atomically quick-add project memory (`/memory add user TEXT` for personal)
!cmd                 run directly with DGC's shell boundary (Esc cancels in the TUI)
@path/to/file        attach one exact, bounded text or image file
Tab / →              accept the ghost-text next-prompt suggestion
/help                every command      ·  /keys  keyboard cheatsheet
/docs                in-app how-to guides
/artifact            open / stop localhost artifact previews
/view-plan           reopen the plan saved in plan mode
/goal <objective>    persistent objective · complete | blocked | resume | clear
/dashboard           session roster — open, switch, start, or delete sessions
```

## Commands

```
dgc                  interactive REPL
dgc setup            configure provider / model / context / web search
dgc doctor           verify the endpoint + model
dgc -c / --continue  resume the most recent session in this directory
dgc --resume         pick a past session to resume
dgc update           update DGC to the latest version
dgc serve            headless JSON backend (NDJSON over stdio) for editor extensions
dgc acp              Agent Client Protocol backend (stdio) for Zed / Neovim / …
dgc protocol describe --compact    inspect the installed protocol + slash surfaces as JSON
dgc -p "fix the bug in auth.py" --mode auto    one-shot, non-interactive
DGC_API_KEY=... dgc --model NAME --base-url URL  use an environment credential
```

For a configured MCP server, a `dgc serve` controller sends
`{"type":"list_mcp_tools","request_id":"catalog-1","offset":0,"limit":50}` and then
`{"type":"call_mcp_tool","request_id":"invoke-1","call_id":"call-1","name":"mcp__server__tool","arguments":{}}`.
Answer any emitted `permission_request` with its existing ID and a typed `permission_response`;
completion is the correlated `mcp_call_complete` event. The generated protocol-v3 JSON Schema is
`schemas/editor-protocol-v3.schema.json` and is also bundled in the installed Python package.
`dgc protocol describe --compact` reports its SHA-256, byte limits, required/optional fields, every
headless command/event, and the exact TUI/classic/editor slash catalogs without loading configuration
or contacting a model. `dgc protocol schema` prints the installed schema; validate fixture or captured
NDJSON with `dgc protocol validate command FILE` or `dgc protocol validate event FILE` (`-` reads
stdin). Validation emits one correlated JSON row per input line and exits nonzero if any frame fails.

Python controllers can use the dependency-free synchronous client instead of hand-rolling process
and NDJSON handling:

```python
from dgc.client import DGCClient

with DGCClient(cwd=".") as client:
    config = client.request(
        {"type": "get_config", "request_id": "config-1"},
        "config",
        request_id="config-1",
    )
    skills = client.request(
        {"type": "list_skills", "request_id": "skills-1"},
        "skill_catalog",
    )
```

`DGCClient` accepts a complete argv sequence (never a shell string), validates both wire directions,
retains unrelated events for `next_event()` / `wait_for()`, enforces decision-request IDs, bounds all
frames and buffers, and gracefully shuts down then reaps its child (including the isolated process
group on POSIX). A client instance is deliberately one-shot; create a new one after `close()` or any
protocol/transport failure.

The same controller can verify skill precedence with
`{"type":"list_skills","request_id":"skills-1"}` and receive a correlated `skill_catalog` whose
entries identify `project`, `user`, or `builtin` without absolute paths. It can generate a continuation
document with `{"type":"generate_handoff","request_id":"handoff-1","save":false}`; set `save` to
`true` to request a new atomic project-root file. `handoff_started` opens the cancellable foreground
lifecycle and the correlated `handoff` event closes it only after the worker slot is reusable.

## Manual install

```bash
git clone <your-repo-or-tarball> dgc && cd dgc
python3 -m venv .venv
.venv/bin/pip install -r requirements.lock
.venv/bin/pip install --no-deps -e .
.venv/bin/dgc setup
# optional: ln -sf "$PWD/.venv/bin/dgc" ~/.local/bin/dgc
```

## Let your agent install it

Paste this to any coding agent:

> Install DGC for me: run `curl -fsSL https://vibedgc.com/install.sh | bash`, then run `dgc setup` and connect it to my local Ollama (or ask me which provider). Verify with `dgc doctor`.

## Configuration

`~/.dgc/config.json` (created on first change; credentials are stored separately in owner-only
`~/.dgc/secrets.json`):

```json
{
  "base_url": "http://localhost:11434/v1",
  "model": "qwen3:8b",
  "api_mode": "auto",
  "provider_state": "stateless",
  "prompt_cache": true,
  "capability_cache_ttl_s": 300,
  "mode": "default",
  "thinking": "off",
  "context_size": 32768,
  "max_turns": 80,
  "max_parallel_tasks": 4,
  "fleet_worktree_root": "",
  "bash_timeout": 120,
  "sandbox": false,
  "sandbox_network": false,
  "plan_artifact": true,
  "artifact_in_plan": false,
  "compact_threshold": 0.85,
  "session_redaction": true,
  "search_provider": "duckduckgo",
  "permissions": {"allow": ["Bash(git status:*)"], "ask": [], "deny": ["Bash(rm -rf *)"]}
}
```

Set `context_size` to the operating window you want DGC to use — compaction timing and native
Ollama KV-cache allocation depend on it. Provider-reported hard limits clamp an oversized setting;
DGC never silently expands a local allocation to the model's trained maximum. `/model` applies a
memory-conscious recommendation for known model families (64K for Qwen3.8, whose native maximum is
256K); `/settings` or `/set context_size …` remains authoritative.
Set `subagent_worktree_root` only if private delegated checkouts should live somewhere other than
`~/.dgc/worktrees`; DGC rejects a task-worktree root inside the source repository.
Set `fleet_worktree_root` only to move automatically managed TUI checkouts from
`~/.dgc/fleet-worktrees`; DGC rejects storage inside the source repository. Conversation files stay
in the source project's private session scope so `/resume` can safely reconnect retained work.
`max_parallel_tasks` defaults to 4 (bounded to 8); set it to 1 when a local model server should
process delegated work strictly serially.
`session_redaction` defaults on and applies an additional credential pass whenever durable
conversation, checkpoint-message, goal, title, or plan state is written. Live model/tool/wire
credential masking and one-time-only sensitive approvals remain mandatory. Exact file rewind bytes
are intentionally unchanged and protected by the session directory's owner-only permissions.

With `api_mode: "auto"`, a directly detected Ollama endpoint uses its native `/api/chat`,
`/api/tags`, and `/api/show` contracts; DGC carries native thinking, tool history, `tool_name`, context/output
limits, sampling, keep-alive, multimodal data, and provider token counts without an OpenAI
translation layer. Set `api_mode` to `"ollama"` when Ollama sits behind a URL that cannot be
detected (for example, a loopback proxy), or to `"chat_completions"` to force compatibility mode.
Before the selected native model's first generation, DGC makes one bounded, short-lived metadata
request and caches the result by endpoint and model. Ollama's valid capability list selects native
tools, thinking, and vision before schemas are built; a text-only model therefore receives DGC's
text tool protocol on its first generation instead of spending a failed tool request. Anthropic's
Models API supplies the selected model's input/output limits and resolved ID, so impossible context
and output settings are clamped before use. Explicit capability and smaller operating limits still
win. Missing, malformed, oversized, or unavailable metadata is negative-cached briefly and falls
back to compatible behavior instead of blocking chat.
Context budgeting uses each adapter's provider-visible transcript and exact active tool schemas.
Validated base64 image transport is accounted through a bounded visual-dimension estimate rather
than misclassified as language text, so image compression does not cause premature compaction.
OpenAI-compatible tool streams preserve normal fragmented calls while also tolerating repeated or
cumulative ID/name/argument snapshots, string or omitted indices, and direct argument objects from
local gateways. Invalid non-object arguments are returned to the model for repair instead of
crashing the agent or executing a corrupted call.

A detected Anthropic endpoint uses the native `/v1/messages` contract and `x-api-key`
authentication rather than pretending Claude exposes Chat Completions. DGC maps canonical tool
schemas to `input_schema`, groups correlated `tool_result` blocks before following user content,
streams text/thinking/citations/tool JSON through the native event protocol, and replays valid
provider-signed thinking and server-owned continuation state exactly. Adaptive-capable Claude
generations receive adaptive thinking plus the selected effort control; older extended-thinking
models receive a bounded legacy budget below `max_tokens`. Unsupported
thinking is negotiated away once without abandoning the Messages transport. Anthropic model
discovery, cache-token accounting, cancellation, retry/backoff, base64 vision estimation, and error
responses use the same bounded lifecycle guarantees as the other native transports. Set
`api_mode` to `"anthropic"` only when a proxy hides the provider identity from its URL.

For OpenAI Responses, DGC defaults to `store: false`, locally preserves encrypted reasoning items
needed for tool-loop continuity, and uses a hashed cache-routing key when supported. Set
`provider_state` to `"server"` only if you intentionally want provider-side response storage and
`previous_response_id` continuation. `provider_capabilities` can explicitly override feature flags
for a compatible endpoint; rejected features are retried after `capability_cache_ttl_s` rather than
being disabled forever. Across Responses, Chat Completions, native Anthropic Messages, and native
Ollama, transient retries
honor bounded `Retry-After` values but stop immediately on cancellation or a turn deadline; abandoned
streamed responses are always released before retry or transport fallback.

## Development

```bash
.venv/bin/python tests/run_tests.py   # units + end-to-end against a mock LLM server
./scripts/generate-editor-protocol.py # regenerate source/package JSON + TypeScript protocol contracts
./scripts/preflight.sh                # complete local release gate
```

See [AGENTS.md](AGENTS.md) for the layout and conventions, and
[bench/README.md](bench/README.md) for the controlled six-harness protocol.

## Security

DGC is a coding agent that runs shell commands and edits files on your machine. Worth knowing:

- **Ask-by-default.** In the shipped `default` mode, reads are automatic but **every file write and shell command asks first**. Only `auto` mode runs unattended — and DGC warns you before entering it. Use `default` / `acceptEdits` for anything you care about.
- **Your model, your machine.** Code and prompts stay local unless you point DGC at a cloud model (then they go to that provider, with your key).
- **Deny-rules** apply in every mode, including auto — add your own hard blocks: `/permissions deny Bash(rm -rf *)`, `/permissions deny Read(**/.env)`.
- **Prompt injection.** Web content is marked as untrusted data and private/link-local fetch targets are blocked. A hostile page or repository can still influence a model, so use `default` mode for untrusted work.
- **Optional OS confinement.** `/sandbox on` gives Linux/bubblewrap commands private home/tmp/runtime and process namespaces; macOS/sandbox-exec instead uses policy enforcement with shared system temp paths. Both protect ambient home state and block network by default, normal approval prompts still apply, and unsupported platforms fail closed. `/sandbox` and `dgc doctor` report the exact active capability.
- **The installer** is non-root (touches only `~/.local/bin` and `~/dgc`) and requires a matching published SHA-256. Tagged GitHub builds also carry build-provenance attestations.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) © 2026 Mohit Kalra. Commercial licensing is available from the author.
