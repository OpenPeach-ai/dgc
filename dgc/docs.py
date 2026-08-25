"""In-app documentation for `/docs` — a small library of how-to pages rendered
right in the TUI. Single source of truth: the DOCS list (title, description,
markdown). Kept concise and accurate to DGC's actual features."""
from __future__ import annotations

# Each entry: (title, one-line description, markdown body).
DOCS: list[tuple[str, str, str]] = [
    ("Getting started", "install, first launch, connect a model", """
# Getting started

DGC is a local-first coding agent for your terminal. It talks to **any
OpenAI-compatible endpoint** — Ollama, LM Studio, llama.cpp, vLLM, or a cloud
provider — so your code and your prompts stay on hardware you choose.

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

    ("Keyboard shortcuts", "every key binding in the composer + transcript", """
# Keyboard shortcuts

Press **Ctrl+G** any time for this cheatsheet as an overlay.

## Compose
- **Enter** — send · **Shift+Enter** — newline
- **Shift+Tab** — cycle permission mode (default → acceptEdits → plan → auto)
- **/** — command palette · **@ path** — attach a file
- **! command** — run a shell command · **# note** — save a memory
- **Ctrl+R** — recall a past prompt · **Tab / →** — accept the ghost suggestion

## This turn
- **Esc** — stop the turn · **Ctrl+C** — cancel · clear draft · quit

## Navigate
- **PageUp / PageDn** — scroll the transcript · **End** — jump to the latest
- click **◆ Thought** — expand the reasoning · click the token count — context details

## Session
- **Ctrl+N** — new session · **/resume** — reopen a past one · **/name** — rename
""".strip()),

    ("Slash commands", "the full / command reference", """
# Slash commands

Type **/** on an empty composer to open the live command palette; filter as you
type, ↑/↓ to select, Enter to run.

- **/help** — list every command · **/keys** — keyboard cheatsheet · **/docs** — this library
- **/new** — start a fresh session · **/resume** — reopen a past one (`dN` deletes one)
- **/history** — search & recall a past prompt · **/jump** — jump the transcript to a past turn
- **/rewind** — restore code + conversation to a past turn
- **/model**, **/connect**, **/subagent** — choose the model / host
- **/mode** — permission mode · **/think** — reasoning effort · **/thoughts** — show/hide thinking
- **/worktree** — isolate edits in a git worktree · **/sandbox** — confine bash
- **/bg**, **/theme** — appearance · **/context** — context-window usage · **/compact** — summarise older turns
- **/mcp**, **/agents**, **/skills**, **/memory**, **/permissions** — extend + configure
- **/artifact** — list / open / stop your running localhost previews
- **/status**, **/name**, **/bug**, **/update**, **/clear**, **/quit**
""".strip()),

    ("Permission modes", "default · acceptEdits · plan · auto", """
# Permission modes

DGC gates what the agent can do without asking. Cycle modes with **Shift+Tab**
or set one with `/mode`.

- **default** — reads run freely; every file write and shell command asks first.
- **acceptEdits** — file edits auto-apply; shell commands still ask.
- **plan** — read-only. The agent investigates and proposes a plan but changes
  nothing until you approve. See the *Plan mode* page.
- **auto** — full access, nothing asks. Use only in a sandbox or a throwaway repo.

You can also carve out standing rules with `/permissions` (allow / ask / deny).
`/sandbox on` makes only the project writable, hides the ambient user home and
secrets, uses private temporary/runtime directories, and blocks network access by
default. It does **not** skip normal permission prompts. Enable sandbox networking
only when needed with `/sandbox network on`.
""".strip()),

    ("Plan mode", "read-only planning, then one-tap approve", """
# Plan mode

Switch to **plan** mode (`/mode plan` or Shift+Tab) and the agent goes
read-only: it explores the code, reasons about an approach, and presents a
concrete plan — files it will touch, the steps, the risks — **without editing
anything**.

When the plan lands you get an approval prompt:

- **Approve** — DGC drops back to your previous edit mode and executes the plan.
- **Keep planning** — give feedback, stay read-only, and receive a revised plan.

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
  `b` in `/artifact`) and it binds `0.0.0.0` with a shareable `192.168.x.x` URL —
  open your artifact on your phone or another device. (LAN means anyone on the
  network can view it — there's no auth.)
- **It persists.** The list is saved, so after you restart `dgc` the server
  comes back up on the same port with your artifacts intact (set the port with
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
- **/mcp add** — connect one: give it a name, a command, args, and any env vars.
- **/mcp remove <name>** — disconnect it.

Servers are stored in your config under `mcp_servers`, so they reconnect on the
next launch.
""".strip()),

    ("Skills", "reusable instruction packages", """
# Skills

A **skill** is a folder with a `SKILL.md` that teaches the agent how to do a
particular kind of work — a house style, a workflow, a checklist. DGC ships a
few built in and you can add your own under `~/.dgc/skills/` or a project's
`.dgc/skills/`.

- **/skills** — browse installed skills (built-in + yours), toggle them on/off,
  or add one by URL.
- A skill that is **on** has its instructions injected for every turn.
- **dgc-design** ships by default but stays **off** for normal coding — it only
  switches on automatically when the agent builds an artifact frontend.
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
""".strip()),

    ("Sessions & rewind", "resume, jump, and undo whole turns", """
# Sessions & rewind

Every conversation is a session, saved as you go.

- **/resume** — reopen a past session (newest first); `dN` deletes one.
- **/new** (Ctrl+N) — start fresh; DGC auto-titles it from your first prompt.
- **/name** — rename the current session.
- **/history** (Ctrl+R) — search and recall any past prompt.
- **/jump** — scroll the transcript straight to a past turn.
- **/rewind** — restore both the code *and* the conversation to how they were at
  a chosen turn. DGC snapshots file state before each turn, so this genuinely
  undoes edits, not just chat.
""".strip()),

    ("Standing goals", "persistent objectives with an explicit lifecycle", """
# Standing goals

`/goal <objective>` records a bounded objective in the session and keeps it in
the model's instructions on every turn until it is completed, blocked, replaced,
or cleared. It survives `/resume`.

- `/goal` — inspect the full objective and status.
- `/goal complete` — retain the objective as an auditable completed record.
- `/goal blocked` — stop automatic progress while an external blocker exists.
- `/goal resume` — reactivate a completed or blocked goal.
- `/goal clear` — remove it.

The model can use the visible `update_goal` tool only for genuine whole-goal
completion or a real blocker. Ending one turn or finishing one milestone is not
goal completion.
""".strip()),

    ("Slash commands", "one command catalog plus project prompt templates", """
# Slash commands

Type `/` to open the searchable command palette. DGC advertises only commands
that the current surface can execute; core editor actions travel as typed backend
messages and are never passed to the model as literal slash text.

Add a custom prompt command at `.dgc/commands/<name>.md` (or
`~/.dgc/commands/<name>.md`). Use `$ARGUMENTS` or `{{args}}` in the template, then
run `/name optional arguments`. Project commands override personal commands and
appear in the terminal/editor palette automatically.
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
  by default** (a coding agent should act, not deliberate at length). DGC sends the
  correct reasoning switch **per provider** automatically — so `off` genuinely turns
  reasoning off on Ollama, vLLM, OpenAI, etc. **Reasoning models (o-series,
  DeepSeek-R1, qwen-thinking) do better on hard tasks with `/think high`.**
- `think_budget_tokens`, `max_tokens` — safety backstops: a reasoning phase that
  runs away with no output is aborted + retried with less reasoning
  (`think_budget_tokens`, 0=off); output is capped at `max_tokens` (length-truncation
  auto-continues, 0=don't send).
- `api_mode`, `provider_state`, `prompt_cache` — transport and continuity. `auto` selects native
  Ollama chat for detected Ollama endpoints, OpenAI Responses for OpenAI, and Chat Completions for
  compatible servers. Use `api_mode: ollama` for an Ollama proxy whose URL cannot be detected.
  Responses defaults to stateless (`store: false`) with local encrypted-reasoning replay and
  privacy-safe cache routing. Choose `provider_state: server` only when provider-side response
  storage is acceptable.
- `provider_capabilities`, `capability_cache_ttl_s` — explicit feature overrides and the bounded
  interval before DGC retries a capability that an endpoint/model rejected.
- `context_size` — auto-sized to the model; long sessions compact at
  `compact_threshold` of it.
- `theme`, `background` — appearance (`background` defaults to *inherit*, never
  repainting your terminal).
- `suggest` — ghost-text next-prompt suggestions (Tab/→ to accept).
- `mcp_servers`, `hooks`, `fallback_model`, `subagent_model` — extend the agent.
""".strip()),
]


def titles() -> list[str]:
    return [t for t, _, _ in DOCS]


def find(title: str) -> tuple[str, str, str] | None:
    for entry in DOCS:
        if entry[0].lower() == title.lower():
            return entry
    return None
