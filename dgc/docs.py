"""In-app documentation for `/docs` — a small library of how-to pages rendered
right in the TUI. Single source of truth: the DOCS list (title, description,
markdown). Kept concise and accurate to DGC's actual features."""
from __future__ import annotations

import re

from .commands import command_specs


def _slash_command_doc() -> str:
    """Build the TUI reference from the same registry that drives its live palette."""
    lines = [
        "# Slash commands",
        "",
        "Type **/** on an empty composer to open the live command palette; filter as you",
        "type, ↑/↓ to select, Enter to run. This is the complete discoverable full-screen TUI surface;",
        "classic and editor clients advertise only the commands they can execute.",
        "",
    ]
    for spec in command_specs("tui"):
        aliases = (" Aliases: " + ", ".join(f"`/{alias}`" for alias in spec.aliases) + "."
                   if spec.aliases else "")
        lines.append(f"- **/{spec.usage or spec.name}** — {spec.description}.{aliases}")
    lines.extend([
        "",
        "## Project commands",
        "",
        "Add a custom prompt command at `.dgc/commands/<name>.md` (or",
        "`~/.dgc/commands/<name>.md`). Use `$ARGUMENTS` or `{{args}}` in the template, then",
        "run `/name optional arguments`. Project commands override personal commands and",
        "appear in the classic/TUI/editor/ACP catalogs automatically. Names begin with a",
        "lowercase letter or digit, then use lowercase letters, digits, `.`, `_`, or `-`",
        "(1–64 characters). Built-in names and aliases are reserved. DGC bounds the catalog",
        "and each template, and rejects symlinked command directories or files.",
    ])
    return "\n".join(lines)


# Each entry: (title, one-line description, markdown body).
DOCS: list[tuple[str, str, str]] = [
    ("Getting started", "install, first launch, connect a model", """
# Getting started

DGC is a local-first coding agent for your terminal. It talks to **supported
native and compatible endpoints** — Ollama, Anthropic Messages, OpenAI Responses,
LM Studio, llama.cpp, vLLM, and cloud providers. The selected model receives the
conversation context it needs; optional remote integrations receive the requests
or tool arguments you direct to them. A configured language server receives workspace
metadata and the full text of documents queried through code intelligence.

## Install

Requires **Python 3.10+**. The installer creates its own virtualenv under
`~/dgc` and links the launcher into `~/.local/bin`, so it never touches your
system Python:

```
curl -fsSL https://vibedgc.com/install.sh | bash
```

Then confirm it is on your PATH:

```
dgc --version
```

If that reports `command not found`, add the bin directory to your PATH:

```
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

Two environment variables let you override where things land: `DGC_DIR` (the
install directory, default `~/dgc`) and `DGC_BIN` (the launcher directory,
default `~/.local/bin`).

If `cursor`, `code`, or `codium` is already on `PATH`, the installer also verifies
and installs the self-hosted editor extension into the first one it finds. Set
`DGC_SKIP_EXTENSION=1` before the install command to leave editor-managed state
untouched and install an extension later from the editor page.

## First launch

```
dgc
```

On the very first run DGC asks you to pick a provider and a model. You can
change either at any time:

- `/connect` — pick a provider (Ollama, LM Studio, OpenAI, OpenRouter, …) or a
  custom LAN host.
- `/model` — switch the model on the current host.

## Talking to the agent

Type a request and press **Enter**. DGC plans, reads files, runs tools, edits
code, and streams its thinking and its answer back live. Press **Esc** to stop
the current turn; press **Enter** again on a new prompt to queue it.
""".strip()),

    ("Keyboard shortcuts", "essential key bindings in the composer + transcript", """
# Keyboard shortcuts

Press **Ctrl+G** any time for this cheatsheet as an overlay.

## Compose
- **Enter** — send · **Shift+Enter** — newline
- **Shift+Tab** — cycle permission mode (default → acceptEdits → plan → auto)
- **/** — command palette · **@path** — attach one exact bounded file (`@"path with spaces"`)
- **! command** — run a bounded direct shell command · **# note** — atomically save project memory
- **/memory add TEXT** — save project memory · **/memory add user TEXT** — save personal memory
- **Ctrl+R** — recall a past prompt · **Tab / →** — accept the ghost suggestion

## This turn
- **Esc** — stop the turn · **Ctrl+C** — cancel · clear draft · quit

## Navigate
- **PageUp / PageDn** — scroll the transcript · **End** — jump to the latest
- click **◆ Thought** — expand the reasoning · click the token count — context details

## Session
- **Ctrl+N** — new session · **/resume** — reopen a past one · **/name** — rename
""".strip()),

    ("Slash commands", "the full / command reference", _slash_command_doc()),

    ("Command line", "flags, subcommands, and one-shot runs", """
# Command line

`dgc help` prints a short version of this page in the terminal.

## Starting a session

- `dgc` — the full-screen app, rooted at the current directory.
- `dgc --classic` — the classic inline REPL instead of the full-screen app.
- `dgc -p "fix the failing test"` — run one prompt non-interactively and exit.
  Add `--mode auto` for a hands-off run.
- `dgc -c` (`--continue`) — resume the most recent session in this directory.
- `dgc --resume <id>` — resume a past session by id; `dgc --resume` with no id
  opens a picker.

## Per-session flags

- `--mode MODE` — permission mode for this session: `default`, `acceptEdits`,
  `plan`, or `auto`. See **Permission modes**.
- `--think LEVEL` — thinking level for this session: `off`, `low`, `medium`,
  `high`, or `xhigh`. With `dgc -p --engine`, it applies only to that delegated
  turn and does not change the native fallback. See **Thinking & reasoning**.
- `--trust` — persist the canonical workspace in `trusted_dirs` (covering its
  subdirectories) before a non-interactive `acceptEdits`/`auto` run. Without it,
  an unattended run in an untrusted directory will not edit. Remove that exact
  entry from `~/.dgc/config.json` to revoke the grant.
- `--engine NAME` — with `dgc -p`, delegate that one-shot turn to a subscription
  CLI instead of the configured endpoint. See **Subscriptions**.

## Model and endpoint

The model and base URL persist to `config.json`, so you only pass them once. The
API-key environment reference is process-only:

- `--model NAME` — the model to use. It persists for native runs; with
  `dgc -p --engine`, it is a one-turn vendor override and leaves the native model unchanged.
- `--base-url URL` — an OpenAI-compatible endpoint.
- `--api-key-env NAME` — read the endpoint key from environment variable `NAME`
  **without persisting it**. Prefer this to pasting a key anywhere.

## Native-route unattended runs

- `--autonomous-gate "CMD"` — on a native local/API route, a check command that must exit `0` before the
  agent is allowed to stop a turn. A failing check is fed back and the agent
  keeps going. Delegated subscription turns do not execute this gate.
- `--autonomous-max-turns N` — bound on failed gate retries before the turn
  stops anyway (default `30`).

## Subcommands

- `dgc setup` — configure provider / model / context.
- `dgc doctor` — check that the endpoint and model are reachable.
- `dgc update` — update DGC to the latest version.
- `dgc export-training` — export sessions as scrubbed fine-tuning JSONL.
- `dgc protocol describe` — print the installed headless/editor contract as JSON.
- `dgc serve` — the headless JSON backend the VS Code extension drives. Stdout is
  protocol-only.
- `dgc acp` — the agent-client-protocol surface.
- `dgc bug` — print the issue tracker URL.
- `dgc help`, `dgc --version`.

## dgc export-training

- `--out PATH` — output path (default `./dgc-training.jsonl`).
- `--all` — every project, not just the current one.
- `--session ID` — a single session; a unique id prefix is accepted.
- `--successful-only` — apply DGC's outcome heuristic: keep a session when an edit
  landed with no edit-tool failure, or its goal was marked complete. This is a
  curation aid, not proof that tests passed or the result is correct.
- `--min-turns N` — drop sessions with fewer than N user turns (default `1`).

Secrets are scrubbed on the way out. See **Training export**.
"""),

    ("Permission modes", "native default · acceptEdits · plan · auto", """
# Native local/API permission modes

DGC gates what the agent can do without asking. Cycle modes with **Shift+Tab**
or set one with `/mode`.

- **default** — reads run freely; model-requested file writes and shell commands ask by baseline.
- **acceptEdits** — file edits auto-apply by baseline; shell commands ask by baseline.
- **plan** — prevents model-requested project mutations while the agent investigates
  and proposes a plan for approval. See the *Plan mode* page.
- **auto** — model-requested tool actions are approved. Some integration consent
  prompts remain user-gated. Use only in a sandbox or a throwaway repo.

Explicit `/permissions` rules are evaluated deny → ask → allow before those baseline decisions.
Subscription turns map the mode into the selected vendor CLI's own flags and policy instead.
`/sandbox on` uses the strongest supported host boundary for native-loop spawned shell commands
and hooks; it does not confine parent-process structured file tools or delegated vendor CLIs, and
does **not** skip normal permission prompts. Linux/bubblewrap makes the project the only persistent
writable host path for those commands, masks ambient user state, and provides private home, temporary,
runtime, process, and network namespaces. macOS/sandbox-exec denies ambient-home
reads outside the project and host writes except the project and shared system
temporary paths; its temporary and process namespaces are not private. Network is
blocked by default on both. Unsupported platforms fail closed instead of running a
requested sandbox without confinement. Use `/sandbox network on` only when needed.
""".strip()),

    ("Plan mode", "read-only planning, then one-tap approve", """
# Plan mode

The DGC workflow below applies to native local/API routes. Switch to **plan** mode
(`/mode plan` or Shift+Tab) and the native agent goes read-only: it explores the
code, reasons about an approach, and presents a concrete plan — files it will
touch, the steps, the risks — without model-requested project mutations.

A delegated subscription turn instead maps `plan` to the vendor CLI's supported
planning/read-only flag. That CLI owns its behavior; DGC does not inject
`present_plan`, create the approval dialog, or save a native `plan.md` from it.

When the plan lands you get an approval prompt:

- **Approve** — DGC drops back to your previous edit mode and executes the plan.
- **Keep planning** — give feedback, stay read-only, and receive a revised plan.

## What read-only means

Plan mode is enforced in the permission layer, not by instruction. While it is
active the agent may use only the read-only tools — reading files, `grep`,
`glob`, code intelligence, web search — plus the one tool that presents a plan.
Every model-requested mutation tool is denied outright: no file writes, no edits,
no shell commands.
Two further limits apply only in this mode: paths outside the project are
refused, and MCP discovery and execution are not exposed at all.

Plan mode therefore prevents model-requested project mutations before you have read
what the agent intends to do. Configured lifecycle hooks still run at their normal
events, DGC still writes private session and plan state, and the selected model or
remote integrations may receive inspected content, so review those settings before
opening unfamiliar or sensitive code.

DGC keeps the plan inline in the transcript, saves a `plan.md` beside the session,
and (by default) renders a self-contained preview on loopback. `/view-plan` reopens
the saved copy. The preview never inherits LAN sharing; arbitrary project previews
remain disabled in plan mode unless `artifact_in_plan` is explicitly enabled.
""".strip()),

    ("Artifacts", "preview what the agent builds on a localhost URL", """
# Artifacts

An artifact is how the agent **proposes something visual** on a local URL — most
often a **plan**. In plan mode, DGC renders the plan (`plan.md`) as a clean page
and serves it, as a rendered page — so you read the steps,
files and approach in your browser instead of raw markdown scrolling past. The
agent can also serve any page/app/chart it builds the same way.

- **Project previews share one server and port** (`http://127.0.0.1:45000` by
  default), with a top-left dropdown. Proposed plans use a separate transient
  loopback server so a LAN setting can never expose them.
- DGC prints the URL in the terminal; open it in your browser.
- Run **/artifact** to see them, open one, **stop** one, or toggle **localhost ⇄
  LAN** with `b`.
- **Localhost or your LAN.** By default the server binds `127.0.0.1` (only this
  machine). Switch it to your **local network** (`artifact_bind: lan`, or press
  `b` in `/artifact`) and it binds `0.0.0.0` with a shareable LAN URL —
  open your artifact on your phone or another device. (LAN means anyone on the
  network can view it — there's no auth.)
- **It persists.** The list is saved, so after you restart `dgc` the server
  tries to reuse the same port with your artifacts intact (set the preferred port with
  `artifact_port`, turn off relaunch with `artifact_autostart`).

Artifacts are built with DGC's own design language (the `dgc-design` skill) so
the frontend looks polished by default. They stay on this machine unless you
explicitly confirm LAN sharing; plan previews always stay private.
""".strip()),

    ("MCP servers", "connect external tools over MCP", """
# MCP servers

DGC speaks the **Model Context Protocol**: connect a stdio MCP server and its
tools become callable by the agent as `mcp__<server>__<tool>`.

- **/mcp** — list connected servers and their tools.
- **/mcp add** — connect one: give it a name, a command or remote URL, and the names of any
  environment variables to pass. Set credential values in those variables before launching DGC;
  the TUI never accepts or persists their literal values.
- **/mcp remove <name>** — disconnect it.

DGC probes the stateless MCP 2026 protocol (`server/discover` plus self-describing
requests). If a handshake-era server rejects that probe, DGC discards the probe
process and reconnects cleanly with the legacy `initialize` lifecycle. Long-running
tools update the same tool card with correlated progress and warning/error logs;
`/mcp` reports the negotiated era and connection failures. Per-server config may
set `log_level` to `debug`, `info`, `notice`, `warning` (default), `error`,
`critical`, `alert`, `emergency`, or `off`.

Inbound and outbound stdio frames are bounded. If a server stops reading its pipe,
the request write remains cancellable, the poisoned process is reaped, and `/mcp`
reports the disconnected state instead of freezing the agent.

Modern roots, elicitation, and tools-free sampling inputs are answered through
bounded multi-round-trip requests; legacy elicitation/sampling callbacks are accepted
only while exactly one originating tool request is active. Every frontend makes the requesting server
visible. Forms reject credential/payment fields and are type-checked again before
sharing. URL requests show the exact host and URL, never prefetch, require consent,
and allow remote HTTPS or loopback HTTP only. Sampling has no tools, MCP context, or
project transcript and requires approval before generation and again before its
response is disclosed. Unsupported modes are not advertised and fail closed.

Servers are stored in your config under `mcp_servers`, so they reconnect on the
next launch. Treat every configured server command as a trusted executable: its
process starts unsandboxed in the workspace, and DGC cannot mediate that process's
own filesystem or network activity through tool permissions or the workspace lease.

Headless controllers can enumerate them with the typed `list_mcp_tools` command and invoke one
exact returned route with `call_mcp_tool`. Calls still pass through permission requests, lifecycle
hooks, the workspace lease, cancellation, progress/input consent, redaction, and output bounds.
""".strip()),

    ("Lifecycle hooks", "run observable commands at agent boundaries", """
# Lifecycle hooks

Configure hook commands under `hooks` in `~/.dgc/config.json`. Native local/API turns can call six
lifecycle events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, and
`Stop`. Delegated subscription turns call `SessionStart` and `Stop`; their vendor-owned prompt and
internal tool loop is not visible to DGC's prompt/tool hook events.

- **/hooks** — show every supported event, its bounded configured count, redacted exact tool
  matchers, and invalid configuration state. Shell commands and environment values are never shown.
- `PreToolUse` and `UserPromptSubmit` can block an action with a non-zero exit. `PostToolUse`
  output is returned to the model as bounded feedback.
- Hook batches share the workspace mutation lease, own a process group, have one bounded deadline,
  drain a bounded redacted head/tail, and honor `/sandbox`.
- Headless controllers use `{"type":"list_hooks","request_id":"hooks-1"}` and receive
  `hook_catalog`. Natural execution emits `hook_activity` with `started` and exactly one terminal
  status; there is deliberately no command that executes a hook outside its lifecycle boundary.
- ACP represents configured hook runs as ordinary command-free tool-call lifecycle updates.

## Configuring one

Each event takes a list of entries. `command` is required; `matcher` is optional
and narrows a tool event to one tool:

```
{
  "hooks": {
    "PreToolUse":       [{"matcher": "bash", "command": "./scripts/guard.sh"}],
    "PostToolUse":      [{"command": "./scripts/format.sh"}],
    "UserPromptSubmit": [{"command": "./scripts/log-prompt.sh"}]
  }
}
```

The event payload arrives on **stdin as JSON**, so a hook reads it rather than
taking arguments:

```
#!/usr/bin/env bash
# ./scripts/guard.sh — refuse a bash command that touches the release directory
payload=$(cat)
case "$payload" in
  *dist/release*) echo "release artifacts are off limits to the agent"; exit 1 ;;
esac
```

Exit status is the control surface:

- a **`PreToolUse`** or **`UserPromptSubmit`** hook that exits non-zero **blocks
  the action**, and its output becomes the reason the agent is shown;
- a **`PostToolUse`** hook's output is appended to the tool result as feedback,
  so the agent reads it and can react;
- every other event ignores the exit status.

Use `/hooks` to confirm what DGC actually loaded — it reports the configured
count and redacted matchers per event without echoing your commands.
""".strip()),

    ("Skills", "reusable instruction packages", """
# Skills

A **skill** is a folder with a `SKILL.md` that teaches the agent how to do a
particular kind of work — a house style, a workflow, a checklist. DGC ships a
few built in and you can add your own under `~/.dgc/skills/` or a project's
`.dgc/skills/`.

- **/skills** — browse installed skills (built-in + yours), add one by URL,
  remove a personal copy, or reload the catalog.
- Adaptive mode injects only an explicitly named or narrowly matching skill for
  the current turn. `tool_profile: full` exposes the whole loaded catalog.
- Project skills override personal skills, which override built-in skills. Typed
  headless/editor listings report that source layer without exposing host paths.
- **dgc-design** ships by default but stays dormant for normal coding — artifact
  frontend work activates it automatically.

## Writing one

A skill is a directory containing a `SKILL.md`: YAML frontmatter, then the
instructions themselves.

```
~/.dgc/skills/commit/SKILL.md
```

```
---
name: commit
description: Write a conventional commit message for the staged changes
---

Read the staged diff with `git diff --staged` and write a single conventional
commit message for it. Focus (optional): $ARGUMENTS

Describe what changed and why, never how. No trailing period on the subject.
```

`name` is how you invoke it, `description` is what the agent matches against
when deciding whether the skill applies, and the optional `when` field narrows
that further. `$ARGUMENTS` is replaced with whatever you pass at invocation.

Discovery is project-first, so a repo can override a personal skill of the same
name:

- `<project>/.dgc/skills/<name>/SKILL.md`
- `~/.dgc/skills/<name>/SKILL.md`

The sixteen built-in skills are worth reading as examples — `/skills` lists them,
and each is a plain directory you can copy and edit.
""".strip()),

    ("Multiple agents", "run a fleet of agents at once + the dashboard", """
# Multiple agents

DGC runs a **fleet** — several agents working at the same time, each with its own
conversation. Kick off a long task on one, spawn another, and keep going.

- **Ctrl+N** — spawn a new agent (even while one is running). The old one keeps
  working in the background; the new one is a clean slate.
- **Ctrl+O** — cycle to the next agent. **Ctrl+\\** — open the **dashboard**.
- **Dashboard** — every agent with its live state: **●** on screen · **⋮**
  working · **◆** needs you · **○** idle. `Enter` attaches · `x` closes · `p`
  pins · `r` renames. `+ New agent` spawns one; saved sessions are listed to reopen.
- When a **background** agent finishes or needs a decision, the bottom bar shows
  **⧉ N · ◆ need you** — switch to it (Ctrl+O or the dashboard) to answer.

New agents use your current model by default; point one at a different model or
a cloud key with `/model` / `/connect` for true parallelism.

The launch agent stays in the checkout you selected. Every additional agent in a Git project gets
an owner-private `dgc/fleet-*` worktree containing the source checkout's exact tracked and
non-ignored untracked baseline. Each checkout has its own crash-safe mutation lease, so fleet writes
can proceed concurrently. Closing an untouched managed checkout removes it; changed, committed,
uncertain, or still-running work is retained with its visible branch/path. Reopening that saved
conversation validates and reattaches to the same checkout. Non-Git projects say when they fall back
to serialized shared-checkout writes. `/worktree <name>` creates a deliberately named long-lived
manual branch.

The model's `task` delegation tool isolates itself automatically in Git projects. Its private
checkout starts with the caller's tracked and non-ignored untracked state. DGC applies only a
completed child's conflict-free delta; it never overwrites paths that were already dirty, and it
retains conflicting or incomplete work with a visible worktree path and branch. Integrated edits
remain part of the parent turn's `/rewind` checkpoint and usage/edit totals.

Use `/tasks` to inspect retained work. `/tasks apply ID` recomputes its delta, rejects paths that were
dirty before delegation or changed in the parent, and adds an applied result to `/rewind`. `/tasks
drop ID --confirm` permanently removes the isolated checkout. Older recovery records created before
baseline fingerprints remain visible and droppable but deliberately require manual inspection instead
of unsafe auto-apply. VS Code/Cursor exposes the same operations through its command Quick Pick.
""".strip()),

    ("Sessions & rewind", "resume, jump, and undo whole turns", """
# Sessions & rewind

Every conversation is a session, saved as you go.

- **/resume** — reopen a past session (newest first); `dN` deletes one.
- **/new** (Ctrl+N) — start fresh; DGC auto-titles it from your first prompt.
- **/name** — rename the current session.
- **/history** (Ctrl+R) — search and recall any past prompt.
- **/jump** — scroll the transcript straight to a past turn.
- **dgc export-training** / **/export-training** — export your sessions as scrubbed
  fine-tuning JSONL (see *Training export*); read-only, never modifies a session. The
  slash command runs the same export for the current project; the VS Code palette
  exposes it as *DGC: Export Training Data*.
- **/handoff** — create a bounded, redacted continuation document from one stable
  session generation. DGC saves it as a new private `HANDOFF-*.md` through the
  workspace lease; an overlapping turn is rejected instead of mixed into the file.
- **/rewind** — restore both the code *and* the conversation to how they were at
  a chosen turn. Exact conversation prefixes and project-root file snapshots are
  saved with the private session, so rewind survives resume and context compaction.
  Direct file-tool and integrated sub-agent changes are captured before mutation;
  the edit is refused if that durable capture fails. Arbitrary shell writes are not
  guaranteed rewindable, and approved external-path snapshots last only for the
  current process so resume never gains ambient authority outside the project.
""".strip()),

    ("Training export", "your real sessions → scrubbed fine-tuning JSONL", """
# Training export

Turn the sessions DGC already keeps into a training set for a local model. Run
it non-interactively — there is nothing to configure:

```
dgc export-training
```

Inside a session, `/export-training` runs the same read-only export for the current
project to `./dgc-training.jsonl` (pass a path to change it), and the VS Code command
palette offers *DGC: Export Training Data*.

Each session becomes one line of JSONL: the conversation as a standard
OpenAI-style `messages` array — `system` / `user` / `assistant`-with-`tool_calls`
/ `tool` results — plus a small `meta` object (model, project, turn and tool
counts, edits, and an outcome flag). That is the shape common SFT and
tool-calling fine-tuning tooling expects, so it drops straight into a training
run for the model you run locally.

## Flags

- `--out <file>` — where to write (default `./dgc-training.jsonl`).
- `--all` — export every project's sessions (default: just this project's).
- `--session <id>` — export a single session (a unique id prefix works).
- `--successful-only` — apply DGC's outcome heuristic: an edit landed with no
  edit-tool failure, or a `/goal` was marked complete. It does not prove test
  success or correctness; review exported records before training.
- `--min-turns N` — drop trivial sessions with fewer than N user turns.

## Secrets are stripped

Every field of every record is deep-scrubbed through DGC's redaction layer
before it is written: configured credentials (API keys, MCP/language-server
secrets) and high-confidence credential shapes (`sk-…` tokens, JWTs, auth
headers, private keys) are replaced with `[REDACTED]`. The export is read-only —
it never modifies a session. Reasoning traces and provider continuation blobs
are dropped so each record is a clean, portable conversation.
""".strip()),

    ("Standing goals", "persistent objectives with an explicit lifecycle", """
# Standing goals

`/goal <objective>` records a bounded objective in the session. Native local/API
turns keep it in the model's instructions until it is completed, blocked,
replaced, or cleared. The local record survives `/resume`; delegated vendor turns
do not receive the DGC goal instruction.

In VS Code/Cursor, entering `/goal <objective>` first saves the tagged goal and
then immediately starts that exact objective as an agent turn. Its status, active
time, pause/resume button, and edit/clear controls stay above the composer. In the
terminal, the slash command records the standing objective for the current session;
send a normal prompt to begin or continue work toward it.

- `/goal` — inspect the full objective and status.
- `/goal complete` — retain the objective as an auditable completed record.
- `/goal blocked` — stop automatic progress while an external blocker exists.
- `/goal resume` — reactivate a completed or blocked goal.
- `/goal clear` — remove it.

On native routes, the model can use the visible `update_goal` tool only for genuine
whole-goal completion or a real blocker. Ending one turn or finishing one milestone
is not goal completion. Subscription vendors do not receive that DGC tool.

## Autonomous gate

On native local/API routes, `--autonomous-gate "<cmd>"` bounds an autonomous run by a real check command: the
agent may not end a turn until that command exits 0. When the model tries to stop
and the gate fails, DGC feeds the command's output back and keeps working; when it
exits 0, the stop is allowed. Bounded by `--autonomous-max-turns` (default 30)
failed attempts, so a persistently red gate can never loop forever. Unset (the
default) leaves turn completion unchanged. e.g. `--autonomous-gate "npm run check"`.

Set it live without restarting: `/autonomous-gate "npm run check"` in the classic
or full-screen TUI (`/autonomous-gate off` clears it, no argument reports the current
gate and retry bound). The gate command and its max-retry bound are also editable in
the TUI settings screen (Behaviour). In the VS Code extension, set `dgc.autonomousGate`
and `dgc.autonomousMaxTurns` in Settings. Delegated subscription turns bypass this
native controller gate; selecting a vendor engine does not make the configured command run.
""".strip()),

    ("Connect your model", "point DGC at Ollama, llama.cpp, vLLM, or a cloud host", """
# Connect your model

DGC talks to any supported native or OpenAI-compatible endpoint. Pick one with
`/connect` (or `dgc setup` on first run), then `/model` to choose the served model.

## Local runtimes

- **Ollama** — `/connect ollama` uses `http://localhost:11434/v1`. DGC auto-detects
  Ollama and speaks its native chat API (which round-trips the model's own thinking).
- **llama.cpp** — run `llama-server`, then `/connect llamacpp`
  (`http://localhost:8080/v1`, no real key needed). This is the OpenAI-compatible
  `/v1` server built into `llama.cpp`.
- **vLLM / SGLang** — `/connect vllm` (`http://localhost:8000/v1`). The server
  renders the chat template, so DGC sends the reasoning switch it understands.
- **LM Studio** — `/connect lmstudio` (`http://localhost:1234/v1`).

## unsloth GGUFs

unsloth is not a serving runtime — its GGUF/quantized models are served **through**
llama.cpp (`llama-server`), vLLM, or Ollama. Start one of those with your unsloth
model, then pick that runtime's preset. `/think <level>` reaches Qwen3-family
templates (which read the effort from inside `chat_template_kwargs`) automatically.

## Custom / LAN hosts

`/connect http://<host>:<port>` points DGC at any other OpenAI-compatible server.
If you enter a bare host, DGC appends the `/v1` chat-completions path for you and
prints a notice (Anthropic and native Ollama URLs are left as-is). Models are
auto-discovered from the endpoint's `/v1/models`, so `/model` lists what the host
actually serves.

## Cloud providers

`/connect openai | anthropic | openrouter | groq | deepseek | together | mistral`
prompt for the provider's key and use its native auth contract. See **Subscriptions**
to instead run your own Claude/Codex/Qwen/Kimi/Copilot plan through its official CLI.
""".strip()),

    ("Thinking & reasoning", "off · low · medium · high · xhigh, and preserving it", """
# Thinking & reasoning

DGC exposes one thinking dial, mapped to the correct wire format **per provider**.

## Levels

`off` · `low` · `medium` · `high` · `xhigh`. `off` is the default — a coding agent
should act, not deliberate at length. `xhigh` is the deepest budget, for genuinely
hard problems on reasoning-capable models.

- `/think` — cycle, or `/think high` to set a level (persisted across restarts).
- `--think <level>` — set it for one `dgc -p` run.
- TUI: `/think` opens a picker; **Settings → Model & sampling → Thinking effort**.

Reasoning models (o-series, DeepSeek-R1, qwen-thinking) tend to do better on hard
tasks with `/think high` (or `xhigh`); non-reasoning models often ignore the dial.

## Showing thinking

`show_reasoning` (`/thoughts show|hide`) controls whether the model's thinking is
shown, muted, in the transcript. It does **not** change how hard the model reasons —
that is `/think`.

## Preserving thinking across turns

Backends differ in whether prior-turn reasoning is carried back into context:

- **Anthropic** (signed thinking blocks) and **Ollama** (native thinking field)
  round-trip their own reasoning automatically.
- The **OpenAI-compatible / llama.cpp** chat-completions transport **strips** the
  model's reasoning every turn.

`preserve_thinking` (`/preserve-thinking on|off`, default off) re-embeds the last
turn's reasoning as a `<think>…</think>` block in the assistant message sent back,
so a compatible/local model can build on its own earlier thinking. It helps
multi-turn coherence but costs context tokens, and only affects the
chat-completions path (the Anthropic/Ollama paths are untouched).
""".strip()),

    ("Subscriptions", "bring your own Claude / Codex / Qwen / Kimi / Copilot plan", """
# Subscriptions

Instead of a raw model endpoint, DGC can drive a coding CLI you already pay for and
are logged into through the full-screen TUI, editor/headless backend, or a one-shot
`dgc -p --engine` run. The legacy `--classic` REPL uses the configured native endpoint.

## Engines

- **Claude Code** — your Anthropic Pro / Max plan (`claude`).
- **Codex** — your ChatGPT Plus / Pro plan (`codex`).
- **Qwen Code** — your Qwen OAuth plan (`qwen`).
- **Kimi for Coding** — your Moonshot plan (`kimi`); its prompt mode is auto-only, so DGC must be
  in `auto` and the vendor controls its automatically approved internal tool actions.
- **GitHub Copilot CLI** — your Copilot plan (`copilot`).

## How it works (orchestration, not a token proxy)

This is orchestration, not credential replay. DGC never reads, stores, refreshes,
or replays the vendor's tokens and never sends vendor-private headers. Each engine
authenticates through the vendor's **own** login command, which opens the vendor's
own browser / device flow and keeps the token in its own store. When you run a turn,
DGC shells out to the official binary in your workspace and streams its output into
DGC's UI. DGC saves the prompt and normalized final assistant response in its own
session; vendor tool and thinking events remain display-only. Authentication, model
execution, and internal tools remain owned by the selected vendor CLI, while DGC
wraps the turn with its own prompt, mode, session mapping, timeout, and cleanup.
The vendor process is not wrapped by DGC's OS sandbox and inherits DGC's ambient
environment, including unrelated credentials. Use a trusted vendor CLI and launch
DGC with only the environment secrets that turn needs.

## Select and sign in

- `dgc setup` lists subscription engines first, with each one's detected login marker. The vendor
  performs the actual authentication check when its CLI launches.
- `/connect claude|codex|qwen|kimi|copilot` selects an engine (a direct `/connect`
  to a provider or URL turns delegation back off).
- Sign in once with the vendor's own command, e.g. `claude auth login`, `codex login`,
  `qwen` (device code), `kimi login`, `copilot login`. `dgc doctor` reports status.

## Model + reasoning effort

- `/model` steers the vendor's own model (e.g. opus/sonnet/haiku for Claude).
- `/think low|medium|high|xhigh|max` sets the reasoning effort for engines that take one
  (Claude, Codex, Copilot); engines without an effort flag steer it via `/model`.
- The editor's composer controls, `/model` and `/think`, and the corresponding
  command-palette pickers all follow the active route. Subscription model pickers
  use vendor aliases when known and otherwise accept a vendor model id directly;
  they never query the configured native endpoint.
- In one-shot automation, `--model` and `--think` override only that delegated
  `dgc -p --engine` turn. They do not rewrite the saved native model or thinking level.
""".strip()),

    ("Python code-action (power mode)", "a persistent Python interpreter for token-efficient work", """
# Python code-action (power mode)

An **optional** power tool, **off by default**. Turn it on with `code_action: true` in
`~/.dgc/config.json` (or a project `.dgc/`), with `/code-action on` in the classic or
full-screen TUI (a row in the TUI settings screen and a toggle in the VS Code panel do
the same), or `/code-action off` to disable it. When on, DGC advertises a **`python`** tool.

## What it is

`python` runs code in a **persistent interpreter tied to your session**. Variables, imports, and
function definitions **persist across tool calls** — the model can load data into a variable **once**
and then run computations over it across many turns.

## Why it saves tokens

The usual loop re-reads data into the context on every step. With a persistent interpreter the model
loads a file/dataset into a variable one time, then each later call is just a small snippet of code
that operates on the already-loaded state. The bulky data never re-enters the prompt — only the code
and its (bounded) output do. This is the "code action" / CodeAct pattern.

## Behavior

- The last statement, if it is a bare expression, has its `repr()` shown (REPL-style).
- `stdout`/`stderr` printed during a call are captured and returned, redacted and length-bounded like
  `bash`.
- An exception returns a clean traceback and the interpreter **stays alive** for the next call.
- Pass `reset: true` to restart with a fresh, empty namespace.
- State also resets when the session ends (or on `/new`).

## Safety

It executes arbitrary code on your machine and inherits DGC's environment, so treat it with the same
trust as an unsandboxed shell. It uses the **same permission path**: it asks in
`default`/`acceptEdits` mode and is **denied in plan mode**. The persistent interpreter is not wrapped
by `/sandbox`, does not use the workspace mutation lease, and its filesystem changes are not captured
by `/rewind` or treated as verifier-invalidating mutations. Review its effects and run verification
explicitly. Because it is off by default, ordinary users never see it until they opt in.
""".strip()),
    ("Configuration", "config.json, models, context, providers", """
# Configuration

Global settings live in `~/.dgc/config.json`; per-project overrides live in a
project's `.dgc/`. Most settings have a slash command, so you rarely edit the
file by hand.

Useful keys:

- `base_url`, `model` — the endpoint and model (`/connect`, `/model`). Credentials live in
  owner-only `~/.dgc/secrets.json`, VS Code SecretStorage, or `DGC_API_KEY` / the other
  `DGC_*_API_KEY` environment references; they are not written into normal config.
- `mode`, `thinking` — permission mode and reasoning effort. `thinking` is **`off`
  by default** (a coding agent should act, not deliberate at length) and accepts
  `off · low · medium · high · xhigh`. DGC maps the requested level to each provider's
  supported control. Some reasoning-only models translate `off` to their minimum effort,
  and endpoints that do not expose a compatible control may ignore it; a set level reaches
  Qwen3-family llama.cpp/unsloth templates through `chat_template_kwargs`. **Reasoning models (o-series,
  DeepSeek-R1, qwen-thinking) may do better on hard tasks with `/think high`.** See the
  **Thinking & reasoning** guide.
- `show_reasoning`, `preserve_thinking` — `show_reasoning` (`/thoughts show|hide`)
  shows the model's thinking, muted, in the transcript. `preserve_thinking`
  (`/preserve-thinking on|off`, default off) re-embeds the prior turn's reasoning in
  the context sent back so a compatible/local model keeps its own thinking across
  turns (costs tokens; only the OpenAI-compatible/chat_completions path — Anthropic and
  Ollama already round-trip their reasoning natively).
- `think_budget_tokens`, `max_tokens` — safety backstops: a reasoning phase that
  runs away with no output is aborted + retried with less reasoning
  (`think_budget_tokens`, 0=off); output is capped at `max_tokens` (length-truncation
  auto-continues, 0=don't send).
- `api_mode`, `provider_state`, `prompt_cache` — transport and continuity. `auto` selects native
  Ollama chat for detected Ollama endpoints, Anthropic Messages for Anthropic, OpenAI Responses for
  OpenAI, and Chat Completions for compatible servers. Use `api_mode: ollama` or `api_mode:
  anthropic` only when a proxy hides its provider identity. Anthropic Messages preserves signed
  thinking and grouped tool-result continuation blocks locally; it never sends the key as Bearer
  authentication.
  Responses defaults to stateless (`store: false`) with local encrypted-reasoning replay and
  a hashed cache-routing key when DGC derives the key. An explicit `prompt_cache_key` of up to
  64 characters is sent verbatim. Choose `provider_state: server` only when provider-side
  response storage is acceptable.
- `provider_capabilities`, `capability_cache_ttl_s` — explicit feature overrides and the bounded
  interval before DGC retries a capability that an endpoint/model rejected.
- `context_size` — the requested operating window. Known model selections apply a
  memory-conscious recommendation; authoritative provider metadata clamps impossible values but
  never silently expands a local Ollama allocation. Long sessions compact at
  `compact_threshold` of the effective value.
- `search_timeout` — bounded 1–60 second lifetime for internal `grep`/`glob` discovery. DGC uses
  ripgrep without a shell when available and a link-safe bounded fallback otherwise.
- `session_redaction` — on by default. Durable transcripts, checkpoint conversation blobs, goals,
  titles, and plans receive an additional credential-redaction pass. Live native-provider/tool and
  editor/headless/ACP masking remains enforced. Delegated vendor-CLI streams in the full-screen TUI
  or subscription one-shot CLI are shown as the vendor emits them after terminal-control cleanup,
  so treat vendor output as sensitive. Exact file rewind snapshots remain byte-for-byte unchanged
  inside the owner-private session so `/rewind` cannot corrupt a file.
- `tool_profile` — `adaptive` (default) keeps all core coding tools while activating web, artifact,
  skill-install, memory, goal, and delegation tools from explicit turn/standing-goal intent. Use
  `full` to expose the whole execution catalog on every model request.
- `code_action` — **off by default.** When `true`, DGC advertises a `python` power tool that runs
  code in a **persistent per-session interpreter** (variables/imports survive across calls). See the
  **Python code-action** guide. It executes arbitrary code and is gated by the same approval path as
  `bash` (asked in default/acceptEdits, denied in plan), but is not wrapped by `/sandbox`,
  checkpointed, or mutation-tracked for verifier reuse. It is never shown until you opt in.
- `theme`, `background` — appearance (`background` defaults to *inherit*, never
  repainting your terminal).
- `suggest` — ghost-text next-prompt suggestions (Tab/→ to accept). Auxiliary title/suggestion
  requests wait for fleet-wide idle time and are canceled before foreground work;
  `aux_idle_delay_ms` controls the grace period.
- `mcp_servers`, `hooks`, `fallback_model`, `subagent_model` — extend the agent. When a fallback or
  sub-agent uses another endpoint, its transport is inferred independently instead of inheriting a
  forced main-provider mode; set `fallback_api_mode` or `subagent_api_mode` only to override that.
  Lifecycle-hook batches are capped at 32 entries and one 20-second deadline, drain only a bounded
  redacted head/tail, own a process group and checkout mutation lease, and honor `/sandbox`.
- `subagent_worktree_root` — optional private storage for automatic delegated checkouts; empty uses
  `~/.dgc/worktrees`. It must be outside the source repository.
- `fleet_worktree_root` — optional private storage for automatically isolated TUI agents; empty uses
  `~/.dgc/fleet-worktrees`. Conversation resume state remains scoped to the source project, and
  changed managed checkouts are retained rather than force-removed.
- `max_parallel_tasks` — bounded `task` fan-out (default 4, maximum 8; set 1 to disable). In a
  Git-backed full-auto turn, two or more independent `task` calls emitted together are snapshotted
  from one parent baseline, run concurrently, and integrated in call order. Hooks, interactive
  permission modes, mixed tool batches, and non-Git projects keep the normal serial path.
- `language_servers`, `code_intel_timeout`, `code_intel_lsp_idle_s` — optional stdio LSP
  commands for richer definitions,
  references, symbols, and diagnostics. Keys may be a language (`python`) or extension (`.py`):
  `{"language_servers":{"python":{"command":"pyright-langserver","args":["--stdio"]}}}`.
  Without one, the bounded dependency-free static analyzer remains available. Configured servers
  receive a minimal environment, run without a shell, and are serialized per project/server spec.
  DGC keeps at most four configured sessions warm for 120 seconds by default, reaps them when idle,
  and retires failed sessions. Explicitly approved external-file queries always stay one-shot; set
  `code_intel_lsp_idle_s` to `0` for one-shot isolation everywhere.

## Credentials

The `api_key`, `search_api_key`, `subagent_api_key`, and `fallback_api_key` values never live in
`config.json`; they are written to `~/.dgc/secrets.json` with owner-only permissions, and each can
be supplied by environment variable instead (`DGC_API_KEY`, `DGC_SEARCH_API_KEY`, …). On the
command line, `--api-key-env NAME` reads a key from the environment **without persisting it at
all**. `fallback_base_url` and `subagent_base_url` point the fallback and sub-agent at their own
endpoints.

## Sampling and limits

Sampling keys are empty by default, which means *use the endpoint's own defaults* — set one only
when you want to override it.

- `temperature`, `top_p`, `top_k`, `min_p` — sampling parameters, passed through when set.
- `max_turns` (default `0`) — optional emergency tool-iteration backstop. `0` lets a progressing
  turn continue until it completes, is cancelled, or reaches an explicitly configured time budget;
  repeated-call and no-progress guards remain active independently.
- `turn_budget_s` (default `0`, meaning no limit) — wall-clock budget for a turn. The agent
  reserves the tail of this budget to converge and persist rather than being cut off mid-edit.
- `request_timeout` (default `1800`) — maximum seconds of provider-stream inactivity between
  response chunks; an active response can take longer overall.
- `bash_timeout` (default `120`) — per-command shell timeout.
- `approval_timeout_s` (default `300`) — how long a permission prompt waits before giving up.
- `ollama_keep_alive` (default `30m`) — how long Ollama keeps the model resident between turns.
- `prompt_cache_key` — an explicit cache key for providers that support prompt caching.

## Web search

- `search_provider` (default `duckduckgo`) — which backend answers the agent's web searches.
- `search_url` — a custom endpoint for a self-hosted search backend; empty uses the provider's own.
- `search_api_key` lives in `secrets.json` (above). Web providers use bounded transport timeouts.

## Sandbox

- `sandbox` (default `false`) — run shell commands inside the sandbox.
- `sandbox_network` (default `false`) — allow network access from sandboxed commands.
- `sandbox_env_allow` (default `[]`) — environment variable names to pass through to sandboxed
  commands. Other non-baseline host variables are withheld; DGC still supplies a small safe
  baseline plus sandbox-specific home, temporary, and runtime paths.

## Artifacts

- `artifact_autostart` (default `true`) — serve artifacts automatically as they are produced.
- `artifact_port` (default `45000`) — the shared port for project artifacts. Plan previews use a
  separate transient loopback server and port.
- `artifact_bind` (default `localhost`) — the bind mode. Set it to `lan` to preview
  from another device on your own network.
- `artifact_hostname` — the hostname used when building the printed URL, if it differs from the
  bind address.
- `plan_artifact` (default `true`) — render proposed plans as an artifact page.
- `artifact_in_plan` (default `false`) — also serve artifacts while in plan mode.

## Native-route unattended runs

- `autonomous_gate` — a check command that must exit `0` before a native local/API agent may stop a turn.
- `autonomous_max_turns` (default `30`) — bound on failed gate retries.
- `verify_before_done` (default `false`) and `verify_command` — run a command and feed a failure
  back before allowing a native local/API turn to end.

Subscription turns are delegated to the selected vendor CLI and bypass these two native-loop gates.

The autonomous-gate pair has command-line equivalents; see **Command line**. The verifier pair is
configured in `config.json`.

## Subscriptions

- `subscription_engine` — which vendor CLI drives the turn.
- `subscription_model`, `subscription_effort` — model and effort passed through to that CLI.

## Appearance

- `logo_animation` (default `true`) — the animated mark on the welcome screen. Turn it off for a
  static logo.
""".strip()),
]


def titles() -> list[str]:
    return [t for t, _, _ in DOCS]


def slug(title: str) -> str:
    """Stable public identifier for a bundled documentation page."""
    return re.sub(r"[^a-z0-9]+", "-", str(title or "").lower()).strip("-")[:80]


def catalog() -> list[dict[str, str]]:
    """Return editor-safe metadata without duplicating the documentation source of truth."""
    return [{"id": slug(title), "title": title, "description": description}
            for title, description, _markdown in DOCS]


def find_id(identifier: str) -> tuple[str, str, str] | None:
    wanted = str(identifier or "").strip().lower()
    for entry in DOCS:
        if wanted in (entry[0].lower(), slug(entry[0])):
            return entry
    return None


def find(title: str) -> tuple[str, str, str] | None:
    for entry in DOCS:
        if entry[0].lower() == title.lower():
            return entry
    return None
