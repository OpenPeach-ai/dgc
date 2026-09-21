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
        "Type **/** after a space anywhere in the composer to open the live command palette; filter as you",
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

Requires **Python 3.10+**. The installer builds each version in its own
directory with its own virtualenv under `~/.local/share/dgc/versions` and links
the launcher into `~/.local/bin`, so it never touches your system Python:

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

Two environment variables let you override where things land: `DGC_DATA_DIR`
(where versions live, default `~/.local/share/dgc`; the older name `DGC_DIR` still
works) and `DGC_BIN` (the launcher directory, default `~/.local/bin`). `dgc update`
remembers both: it updates the install it was started from.

An update builds the new version beside the current one and switches the `dgc`
launcher only once the build is complete, so a failed update leaves the version
you had running, and `dgc` exits non-zero. The active version and the two newest
others are kept: `dgc update --rollback` switches back, `dgc update --version X`
switches to a kept version, and `dgc update --list` shows them. An install made
by an older installer (under `~/dgc`) moves to the new layout on its next update;
the old directory is left in place for you to delete. `dgc doctor` shows which
install is running, where the launcher points and what `dgc update` would change.

If `cursor`, `code`, or `codium` is on `PATH`, the installer also verifies and
installs the self-hosted editor extension into each of them. Set
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

`/docs` opens this library in the terminal (searchable; the same pages as
docs.vibedgc.com). `#a fact` appends to project memory — see **Memory**. `@path`
attaches one file; `$skill` applies a workflow.

### Attaching a document

`@path` also takes a document, not only a text file: **.docx**, **.xlsx**, **.pptx**, **.odt**,
**.ods**, **.odp**, **.rtf** and **.pdf**. DGC reads the text out of it locally and hands that to
the model. Nothing is uploaded, no office application is launched, no macro runs, no embedded link
is followed, and the file is never written back.

What the model gets is **extracted text**, and the attachment says so: layout, images, charts and
anything the extractor could not reach are simply absent, so an answer about a document's
appearance is not something it can give you. Spreadsheets come through as their cell values,
slide decks as their text and speaker notes.

Limits are the point of the feature, not an afterthought. A document is read up to 16 MB off disk
and contributes the same bounded share of the prompt a text attachment does, so a long report is
truncated rather than allowed to swallow the context. Encrypted files are refused — including a
PDF with an empty user password — as are corrupt ones and archives whose structure looks unsafe;
each refusal names the problem and what to do about it, and the rest of your message still goes
through. Legacy **.doc/.xls/.ppt** are refused with the remedy: save them as the modern format.

PDFs need `pypdf`, which DGC installs with it. If it is missing, a PDF is refused by name instead
of being read as noise; every other format above needs nothing beyond DGC itself.

## How DGC writes back

Answers are plain professional text. DGC does not decorate them with emoji or
other ornamental symbols — not in headings, not as list markers, not as status
marks — unless you ask for them, or the file it is editing already uses them.
Files in your workspace are written as links that open at the right line, and
sources as ordinary links.

Ask for a different style in the prompt and you get it for that turn. To change
it for a project, say so in `DGC.md` — see **Memory**.
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
- **Ctrl+Y** — copy the last reply to your clipboard (works mid-turn) · **/copy code** — its code block

## This turn
- **Esc** — stop the turn · **Ctrl+C** — cancel · clear draft · quit
- **Enter** — steer native work at the next model/tool boundary; subscription follow-ups queue
- **Tab** — queue a separate turn while working, outside menus and completion
- **/skills** and **/skills show NAME** — browse the current catalog without stopping work
- **/mode MODE** — change native permission decisions during work; explicit ask/deny rules remain

Unconsumed terminal follow-ups remain queued after interruption; a new prompt continues the queue.
In the editor, Enter steers and **Alt+Enter** or **Queue** submits a later turn. Unapplied steering
can be restored to the draft. Subscription CLI mode changes apply to the next launched turn.

A message sent mid-turn says what became of it, on its own line under the bubble (under, not in:
what became of a message is not something you said):
*steering …* while the backend holds it, *queued for the next turn* if the turn would not take it,
and *steered — the model has read this* at the moment it actually reaches the model. Until then
the only sign was a screen-reader-only label, so a sighted user had none.

## Files pane (`/files`)
- **j / k · ↑ ↓** move · **h / l · ← →** parent / enter · **gg / G** top / bottom · **H / L** back / forward
- **Space** select · **v** visual select · **Ctrl+A** all · **Esc** clear selection, filter, or help
- **y / x / p** copy / cut / paste · **P** paste overwriting · **a** new (end with `/` for a folder) · **r** rename
- **d** trash · **D** delete permanently · **u** undo the last change
- **f** filter · **/** find, **n / N** next / previous · **.** hidden files · **s / S** sort / reverse
- **Enter** insert `@path` into the prompt · **c** insert the plain path · **i / Tab** inspect · **J / K** scroll the preview
- **?** all keys · **q** return to DGC · **Ctrl+C** still stops the agent

## Diff pane (`/diff`)
- **j / k · ↑ ↓** move · **Enter / l** open the diff under the cursor · **h / Esc** back to the file list
- **Space / v** start or end a line selection · **Enter** attach the selection to your prompt · **a** attach the whole hunk
- **J / K** next / previous file without leaving the diff · **g / G** top / bottom · **PgUp / PgDn** page
- **r** re-read git now · **Tab** list ⇄ diff on a narrow terminal · **?** all keys · **q** return to DGC

## Navigate
- **PageUp / PageDn** — scroll the transcript · **End** — jump to the latest
- click **◆ Thought** — expand the reasoning · click the token count — context details

## Copy text
DGC owns its screen, so it can copy without you selecting anything, from any position, even
while a turn is still running. The text goes to your system clipboard through the terminal
(OSC 52), which works over SSH and inside tmux with `set-clipboard on`.

- **Ctrl+Y** or **/copy** — the last reply · **/copy code** — its last fenced code block
- **/copy 2** — the reply before that · **/copy all** — the whole conversation as Markdown
- **/export** — save the conversation as Markdown (`~/.dgc/exports/`, or `/export PATH`)

If you would rather drag-select with the mouse: DGC captures the mouse so the wheel scrolls its
own transcript and rows stay clickable, and that capture is what stops your terminal's own
selection. **/select** hands the mouse back for this session (PageUp/PageDn still scroll), and
A paste of five lines or more (or a very long one) collapses in the composer to a chip such as
`[Pasted text #1 +40 lines]`, so a tall paste no longer fills the screen; it expands back to the
full text the moment you send. Short pastes insert as typed.

**/mouse off** remembers that choice. **Shift+drag** (**Option+drag** on some terminals) selects
without leaving scroll mode at all, where the terminal passes the modifier through.

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
- `--output-format json` — with `-p`: instead of text, the NDJSON event stream that
  `dgc serve` speaks (`turn_start`, `text_delta`, `tool_call`, `tool_result`, `turn_end`…),
  ending in one `result` object with `ok`, `text`, `session_id` and `usage`.
- `--output FILE` — with `-p`: also write the final answer to FILE.
- `--print-session-id` — with `-p`: print the session id on stderr, for `--resume ID`.
- Piped input: `git diff | dgc -p "review this"` appends stdin to the prompt (2 MB cap);
  `dgc -p -` reads the whole prompt from stdin. Only a pipe or a redirected file is read — a
  terminal, `/dev/null`, and an fd inherited from a launcher (a supervisor, an editor) are left
  alone, so `-p` never waits on input nobody is going to send. A `-p` run never waits on a menu: a tool
  that would ask is denied with the rule to pre-approve, a plan is reported, not executed.
- `--add-dir PATH` — let this run read and edit files under PATH too (repeatable).
- `--allow-tool RULE` — pre-approve a tool for this run, e.g. `"Bash(npm test)"` or `Edit`
  (repeatable; never saved).
- `--sandbox on|off|read-only` — confine shell commands for this run; `read-only` mounts
  the project read-only inside the sandbox and denies every file edit, for review runs.
- `--trust` — persist the canonical workspace in `trusted_dirs` (covering its
  subdirectories) before a non-interactive `acceptEdits`/`auto` run. Without it,
  an unattended run in an untrusted directory will not edit. `dgc trust` lists
  every grant and `dgc trust revoke N|PATH|here` (or `/trust` inside DGC) forgets
  one; the gate then asks again on the next launch there. The gate warns when the
  folder is your home directory or the filesystem root, because a grant covers
  everything under it — including every future clone.
- `--engine NAME` — with `dgc -p`, delegate that one-shot turn to a subscription
  CLI instead of the configured endpoint. See **Subscriptions**.
- `--ultra` / `--no-ultra` — turn the Ultra execution profile on or off for this
  session (extended reasoning plus bounded parallel agents). See **Thinking & reasoning**.

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
- `dgc doctor` — check that the endpoint and model are reachable, and show the installation.
- `dgc update` — install the latest DGC beside the current version; `--rollback`,
  `--version X` and `--list` switch between the versions kept on disk.
- `dgc export-training` — export sessions as scrubbed fine-tuning JSONL.
- `dgc usage [--range today|7d|30d|month|all] [--json]` — tokens and requests counted on this
  machine (`~/.dgc/usage.sqlite`), by model and by day, from what each provider reported. The
  same report is `/usage` inside DGC and Settings → Token Usage in the editor; nothing in it is
  sent anywhere.
- `dgc protocol describe` — print the installed headless/editor contract as JSON.
- `dgc serve` — the headless JSON backend the VS Code extension drives. Stdout is
  protocol-only.
- `dgc acp` — Agent Client Protocol JSON-RPC over stdio (Zed, Neovim, and other ACP
  clients). Prompt blocks, text and images are bounded; embedded resources are untrusted data.
- `dgc mcp ...` — the same MCP catalog as `/mcp`, outside a chat. See **MCP servers**.
- `dgc skills ...` — list, create, install, enable, disable, or show a skill package.
  See **Skills**.
- `dgc notes [QUERY]` — search this project's context notes. See **Context notes**.
- `dgc trust` — list workspace-trust grants; `dgc trust revoke N|PATH|here` forgets one.
- `dgc export [ID] [FILE]` — save a session as Markdown (default: most recent, to
  `~/.dgc/exports`).
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
The **Sandbox** page covers backends, what is confined, and what is not.

## In VS Code and Cursor

The approval card shows what the step will do — its summary and, for an edit, the diff it
would apply — so you approve against the change rather than raw arguments. **Deny** can carry
a note; the model reads it as the reason and adjusts.

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

## Read a plan in your browser, from any mode

Asking for a plan or design doc in Auto (or any other mode) also offers the native browser page
plus a Markdown download. You do not have to say "in the browser". The native `present_document`
tool creates a light page with section links, tables and a Markdown download, without an
execution-approval dialog. Use browser Print → Save as PDF to export a PDF. Links are local to
the machine running DGC and last while that process runs. General interactive HTML previews use
`artifact`; approving a plan to execute still uses `present_plan` in Plan mode.

## What read-only means

Plan mode is enforced in the permission layer, not by instruction. While it is
active the agent may use only the read-only tools — reading files, `grep`,
`glob`, code intelligence, web search — plus planning, checklist and document controls.
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

## Workflow commands

`/plan` enters read-only mode without starting a turn. `/plan TASK` inspects the
project and prepares a plan. It does not toggle back into execution; use `/mode`
or the mode selector when you want to change permissions.

`/review` enters read-only mode and reviews staged, working, and untracked changes
for concrete bugs. Use `/review --staged`, `/review --working`, `/review --base main`,
or `/review --commit HEAD~1` to choose the comparison, followed by optional focus
text. Native review uses the bounded `git_diff` tool without executing repository
filters or network transports. Partial coverage is explicit. Findings should name
the file/line, trigger, and impact; a source review must not claim tests were run.

`/init` inspects existing guidance and prepares or updates DGC.md using ordinary
edit permissions. In plan mode it proposes the guide before any write. It never
precreates a placeholder or bypasses approval to overwrite existing instructions.

These commands work in the interactive CLI, TUI, and editor. Selecting them after
other text prepares the draft until Send; skills and context stay attached. Pause
an active goal before starting a separate workflow. Unsupported subscription modes
and invalid selections are rejected before starting a model request.
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
  network can view it — there's no auth.) Every preview shares one browser
  origin, so a page you preview can read and stop your other previews: preview
  pages you trust.
- **It persists.** The list is saved, so after you restart `dgc` the server
  tries to reuse the same port with your artifacts intact (set the preferred port with
  `artifact_port`, turn off relaunch with `artifact_autostart`). Artifacts saved by
  an older DGC get new, unguessable ids the first time this version starts, so an
  old `?a=a1` link opens the newest preview, and they are served in the
  project-root way described below.
- **What gets served.** The agent serves a page: an `.html`/`.htm` file, an
  image, an `.svg` or a `.pdf`, or a folder holding one — not a `.md`, `.json`
  or `.txt` file on its own, and never a page inside a dot-folder. Dot-files and
  dot-folders (`.env`, `.git`, `.dgc`), key and credential files (`*.pem`,
  `id_rsa`, `credentials.json`, `token.json`, data files named like `secret` or
  `password`), and symlinks that point outside the artifact's folder are never
  served, and there are no folder listings.
- **A page in its own folder** (e.g. `artifacts/<name>/`) is served as a whole
  site, except server-side source, config, databases, logs and backups (`.py`,
  `.ts`, `.jsx`, `.yaml`, `.toml`, `.sqlite`, `.log`, `.bak`…): those load only
  when one of its pages links to them, so a PyScript `main.py` or a sql.js
  database works and an unlinked file does not.
- **A page in a project root** is served with only the web files it links to
  (HTML, CSS, JS, JSON, images, fonts, media), found through its HTML attributes,
  its CSS, and the quoted file names in its scripts — resolved from the script and
  from the page, as the browser does. A project root is the project folder, your
  home folder or a personal folder in it (Downloads, Documents…), or any folder
  holding a project file (`.git`, `package.json`, `pyproject.toml`, `Makefile`,
  `requirements.txt`, `AGENTS.md`…); a project nested inside a site folder is
  treated the same way. Manifests like `package.json`, build config like
  `vite.config.js`, other file types and the rest of the project never load, and
  neither do files whose names a script builds at runtime — put a multi-file site
  in its own folder.
- **Only your own addresses.** The server answers to `localhost`, `127.0.0.1`,
  this machine's LAN address and name in LAN mode, and `artifact_hostname` —
  any other Host is refused, so a web page cannot read artifacts through DNS
  rebinding. If you open previews through a forwarded or proxied name (a
  Codespaces `*.app.github.dev` URL, a reverse proxy, a MagicDNS name), set
  `artifact_hostname` to it. Stopping a preview from the browser needs a token
  that only the DGC artifacts page (the bar with the dropdown) carries, so another
  website cannot stop your previews.

Artifacts are built with DGC's own design language (the `dgc-design` skill) so
the frontend looks polished by default. They stay on this machine unless you
explicitly confirm LAN sharing; plan previews always stay private.
""".strip()),

    ("MCP servers", "connect external tools over MCP", """
# MCP servers

DGC speaks the **Model Context Protocol**: connect a stdio MCP server and its
tools become callable by the agent as `mcp__<server>__<tool>`.

- **/mcp** — browse connected servers and their tools, resources, templates and prompts.
- **/mcp add docs --url https://mcp.example.com/mcp** — connect a remote server. Add
  `--auth-env DOCS_TOKEN` to reference a bearer token by its environment variable name.
- **/mcp add local-docs --env DOCS_TOKEN -- python /path/to/server.py** — configure a local process.
  Set credential values in those variables before launching DGC; terminal commands accept names,
  never literal credential arguments. The editor stores the credentials it manages in SecretStorage.
- **/mcp edit NAME ...** — change an existing definition; add never overwrites a server.
- **/mcp disable NAME**, **/mcp enable NAME** — change availability without losing the definition.
- **/mcp reconnect NAME** — reconnect one server; omit the name to reconnect all enabled servers.
- **/mcp remove NAME** — disconnect and forget its DGC configuration.

The same commands work outside a chat as `dgc mcp ...`. CLI, TUI and editor share configuration;
SecretStorage-only values remain editor-owned, so use an ambient variable reference when a server
also needs to start from the terminal.

## Attach resources and prompts

Choose **Resources**, **Resource templates** or **Prompts** on a connected server, preview its text,
and choose **Attach to draft**. The snapshot stays in a removable chip; reopening management keeps
existing text and selections. Templates take a concrete server URI, and prompts accept only their
declared arguments.

Terminal examples:

```text
/mcp resources docs
/mcp templates docs
/mcp prompts docs
/mcp read docs docs://api/reference
/mcp prompt docs inspect topic="request validation"
/mcp context
/mcp clear-context
```

Interactive `read` and `prompt` stage a snapshot for the next prompt or goal. `dgc mcp read ...`
prints the result instead. Loading another chat clears terminal staging. Resource URIs belong to
the selected server: even a `file://` URI is fetched from that server, not opened as a local file.
Catalogs and text have explicit bounds; binary/media omissions are reported. Reference text cannot
activate skills or grant tool access. Native reads use normal permissions, hooks and redaction;
plan mode permits attached snapshots but does not execute live MCP tools.

## Remote browser sign-in

Remote entries use the pinned `mcp-remote@0.8.3` bridge and require Node/npm. Explicit reconnects
allow a cancellable browser sign-in window. Decline stops the connection; use Reconnect to retry
an expired login or cold-start failure. OAuth tokens live in the bridge's private user cache,
separate from bearer tokens managed by the editor.

For desktop SSH/remote editors, DGC requests callback forwarding before opening sign-in. If the
editor changes the callback port or address, forward the remote callback port to the same local
port in the Ports panel and reconnect. This bridge cannot use browser-only remote editors that
require another callback origin. Terminal SSH needs equivalent forwarding. Device-code support
belongs to the provider. See [MCP authentication details](https://github.com/OpenPeach-ai/dgc/blob/main/docs/MCP_CONTEXT.md)
for verified flows and current bridge limits.

## Protocol and execution boundaries

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
collection of 22 coding workflows. You can add project or personal packages, including
portable `.agents/skills` directories.

- **/skills** — browse instructions, source, diagnostics, and enabled state. The
  editor's **Create / install** action creates or copies a package; the terminal uses **a**.
- Type **$** or **/** after your draft text to choose skills. The editor attaches removable
  chips without replacing the draft; the terminal inserts an exact `$name` mention.
- Explicit selections load the full instructions for native and delegated subscription
  turns. Up to eight selections share a bounded context allowance. Disabled or removed
  selections are rejected before model execution. Scripts are never executed on install.
- The standard and full tool profiles advertise every enabled skill that permits implicit
  invocation; the adaptive profile advertises only skills that narrowly match the request.
  Explicit-only skills remain available through `$name`. The user request and normal
  permissions always take precedence.
- Project skills override personal skills, which override built-ins. Metadata refreshes
  at the next turn; use **Reload** to update the picker after external edits.
- **dgc-design** ships by default but stays dormant for normal coding — artifact
  frontend work activates it automatically. It preserves the requested brand and theme;
  DGC's purple palette is for DGC-branded or otherwise unbranded standalone DGC artifacts.

## Included workflows

- **browser-test** — real browser flows, failure recovery, responsive and keyboard checks.
- **fix-ci** — inspect the failed CI job and commit, reproduce the cause and verify a fix.
- **pr-feedback** — evaluate review comments against current code and address justified changes.
- **skill-author** — create focused, portable skill packages with meaningful validation.
- **mcp-builder** — implement and test the tools/resources/prompts an MCP server advertises.
- Also included: **batch**, **code-review**, **dataviz**, **debug**, **deep-research**,
  **dgc-design**, **handoff**, **loop**, **onboard**, **plan**, **refactor**,
  **security-review**, **setup**, **ship**, **ui-review**, **verify**, **write-tests**.

These packages provide instructions, not tools or account access. Browser work needs an
available browser harness; remote CI/PR work needs the appropriate client and account;
MCP development uses the project's SDK. Missing capabilities are reported. Skills do not
install dependencies, change permissions, publish or send messages merely by being selected.
For example: `Check failed-save recovery $browser-test` or
`Create a project API migration skill $skill-author`.

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

Read the staged diff with the native `git_diff` tool's staged view and write a single conventional
commit message for it. Focus (optional): $ARGUMENTS

Describe what changed and why, never how. No trailing period on the subject.
```

`name` is how you invoke it, `description` is what the agent matches against
when deciding whether the skill applies. `$ARGUMENTS` receives the invocation request.
Known metadata fields support plain, quoted, folded (`>`), and literal (`|`) scalar
values. DGC does not execute YAML tags, aliases, or objects. The `when` field is not used.

Discovery is project-first, so a repo can override a personal skill of the same
name:

- `<project>/.dgc/skills/<name>/SKILL.md`
- `<project>/.agents/skills/<name>/SKILL.md`
- `~/.dgc/skills/<name>/SKILL.md`
- `~/.agents/skills/<name>/SKILL.md`
- DGC's bundled skills

Optional `agents/openai.yaml` metadata can set `interface.display_name`,
`interface.short_description`, `interface.default_prompt`, and
`policy.allow_implicit_invocation: false`. Invalid optional metadata is diagnosed
and fails closed to explicit invocation. Supporting files resolve relative to the skill
directory and retain normal filesystem permissions.

## Manage packages

```
dgc skills list
dgc skills create review-api
dgc skills install ./team-skills/review-api
dgc skills disable review-api
dgc skills enable review-api
dgc skills show review-api
```

The same actions work through `/skills ACTION` in the terminal. Use `--user` with
create/install for a personal package. A source outside the project requires
`--allow-external`, or an explicit selection in the editor's folder dialog.
The editor also supports `/skills list|reload|show NAME|enable NAME|disable NAME`.
Creation produces an explicit-only scaffold; edit `SKILL.md` before using it.

Installation never overwrites or merges an existing destination. A local package can
contain up to 128 files/directories, 4 MiB total, eight directory levels, and 512 KiB
per supporting file. `SKILL.md` is limited to 64 KiB and 30,000 instruction characters.
Symlinks, special files, `.env` files, and generated dependency directories are rejected.
The terminal also supports raw-URL installation of a single `SKILL.md`; use local
package installation when supporting files are required. Installed scripts retain
private file permissions and can be run through their interpreter after normal approval.

Disablement is shared in DGC's configuration. The terminal's **x** disables a skill;
it does not delete source files. `/skills` lists the built-ins as examples you can copy.
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

The three checkout kinds — fleet, named `/worktree`, and delegated `task` — are on **Worktrees**.

Use `/tasks` to inspect retained work. `/tasks apply ID` recomputes its delta, rejects paths that were
dirty before delegation or changed in the parent, and adds an applied result to `/rewind`. `/tasks
drop ID --confirm` permanently removes the isolated checkout. Older recovery records created before
baseline fingerprints remain visible and droppable but deliberately require manual inspection instead
of unsafe auto-apply. VS Code/Cursor exposes the same operations through its command Quick Pick.
""".strip()),

    ("Sub-agents", "every sub-agent this chat started, and what each one is doing", """
# Sub-agents

The model can hand part of a job to a sub-agent with its `task` tool: a separate agent with its own
context that does the work and reports back. A delegated step can take minutes, so DGC shows every
sub-agent the chat has started and what each one is doing, instead of one spinner.

## Named agents and trust

Four specialists are always available as the `task` tool's `agent` argument:

- **explorer** — read-only search and map of the codebase (no writes).
- **researcher** — investigate and write one findings file, then stop.
- **critic** — review named files or a change; correct them or list blocking issues.
- **worker** — implement a bounded change (the default when `agent` is omitted).

The main agent is offered `task` when you ask it to delegate or to survey the codebase, and on
every turn under Ultra; a sub-agent is offered it only when its own brief asks, so work does not
fan out recursively. The roster above, plus your own definitions, is listed to the model only
while `task` is offered. After a researcher writes a design or plan file, the main agent should
spawn critic on that path before implementing, unless you asked it to skip review. When a
child finishes, the main agent reports in one or two sentences and names the files; the
child's logs stay on that agent. In the editor each specialist is a coloured identity chip in
the thread: the mark moves while it works and stills when it finishes. Click the chip (or its
row in the agents list) for that agent's own page — duration, answer, and files. Child greps
and edits do not dump into the parent chat.

`task` accepts `background: true` so the child keeps working after the current turn ends.
The composer stays free. The agents pill remains while that specialist runs. When it
lands, DGC starts a wake turn with the child's summary; you do not sit in a blocked turn
polling it. Foreground `task` (the default) still waits.

Personal definitions in `~/.dgc/agents/` are available in any workspace and override a
built-in of the same name. A project's `.dgc/agents/` definitions load only after you trust
that project, because a definition can select its own model host and an environment key.
Trusting an already-open terminal or editor loads them without a restart. Isolated tasks and
fleet workspaces use the approved source project's definitions rather than loading new
definitions from their scratch checkout. An optional `tools:` frontmatter line is an
allow-list of built-in tool names.

## Eyes for a model without vision

If the chat's model cannot read images (for Ollama, `vision` is missing from its capabilities in
`ollama show`), DGC finds a model that can and lets it do the looking:

1. the sub-agent model (`/subagent model NAME`, with `/subagent host URL` if it runs elsewhere),
   when its capabilities include vision;
2. otherwise a named agent whose `model` has vision: one named `viewer` first, then the others by
   name;
3. for a sub-agent whose own model cannot see, the chat's main model when it can.

A look is one request to that model with the image and a question. It uses no tools, no checkout
and no agent loop, so a vision model that cannot call tools (`qwen2.5vl`, `llava`) works too. The
answer comes back as text the chat's model works from:

- **An image you attach to a prompt** is looked at before the turn starts, with your prompt as
  the question. The chat shows a `view_image` step, *attached image · via qwen3-vl:8b (sub-agent
  model)*; open it to read what that model saw. The picture stays in the conversation, and the
  chat's model receives that report in its place on every later request too. If you switch to a
  model that can see, it gets the picture itself.
- **An image file in the workspace.** `view_image` is still offered, with a `question` argument:
  the chat's model asks what it needs to know ("which elements overlap, and what text do they
  show?"), and the step's output names the model that looked and gives its answer. `read_file` on
  an image works the same way, with a general describe-everything question. A browser screenshot
  says where it was saved so the model can ask `view_image` about it.

A model's capabilities are read once and cached (`capability_cache_ttl_s`, 5 minutes by default),
never checked on every request. Only positive evidence counts: an Ollama model has to list `vision`,
and an endpoint that turns out to refuse the image is dropped. With no vision model available, DGC
keeps the old behaviour: the image reaches no model, the model is told it exists, and you get one
line saying how to set up a vision sub-agent model.

## The count

The prompt area lists every sub-agent started in the current turn — queued, running, waiting,
finished, failed or stopped — so you can see the whole batch while work is happening. When the
turn ends the count clears, unless a specialist was started with `background` true: that one
stays in the prompt until it finishes, and DGC starts a new turn when it lands. Completed work
stays in the transcript; it does not inflate the count as a chat gets longer.

You can change the model while a turn is running. A round that is already answering keeps its
client; the next model round uses the new one. A round that has not produced anything yet (the
old model still loading, queued upstream or stalled) is sent again to the new model at once,
and the chat says so. The chat records `Switched to <model>`. Thinking works the same way:
Settings → General → Thinking is the composer dial. Changing it mid-turn keeps the current
request's level and uses the new level (and its guidance) from the next model round. The chat
records `Thinking → high`. If you stop a turn and pick a vision-capable model, the next
turn can view images. Viewed images always appear as a chip on the tool step that produced
them — click the chip to open the image, even when the model itself cannot see it.

A working specialist's identity mark **glows and breathes**; a finished one is still. That is
state, not decoration, so it survives a reduced-motion preference — the pulse stops, the glow
stays. If a mark's artwork cannot be loaded it falls back to its own coloured shape rather than a
broken-image placeholder.

The list keeps the order agents were **first seen** in. A new specialist joins at the end and
never pushes the others around, so a row you are reading does not move under you as the backend
reports.

A diamond (◆) means an agent needs you; a filled dot (●) means work is queued or running.
The editor uses an empty ring (○) when the turn still has agents but none is working any more.
Reopening a chat restores spawn cards and identity chips next to the `task` that started them.
Compaction summarises those turns for the model, but the chips stay in the human log after the
summary marker — they are not dumped under the last answer. Clicking a chip opens that agent's
page: its report, files, and any tool steps DGC kept for the person. Rewinding drops agents
started later.

## In the terminal

The status bar shows active work after the shortcut hints:

    ● 2 agents        ◆ 2 agents · 1 needs you

Under 80 columns it shortens to `●2` or `◆2`. With no active agents, the shortcut bar hides the count.

`/agents` lists the agents in this chat above the sub-agent settings, and works while a turn is
running. Each row has the agent's state, its task description, and what DGC knows about it: what it is
doing now, the agent type, the model when it is not the chat's own, how long it ran, its tool calls and
its tokens. An agent started by another agent is indented under it. The `/dashboard` entry of a busy
chat says how many of its agents are working. The classic `dgc` prompt prints the same list without
colour.

## In the editor

A pill at the start of the controls under the prompt shows `● 2 agents` (only the number in a narrow
panel). Hover it to read how many are working. Click it for the list:

- a summary such as **2 agents · 2 working**;
- one row per visible agent with the same facts the terminal shows, updated as it works;
- click a row or a coloured chip in the transcript to open that agent's page;
- **Sub-agent settings** opens Settings ▸ Agents, where the sub-agent model and host are chosen.

The list is for looking. **Stop** ends the whole turn, including every agent. When the chat is
reopened, saved tool steps retain earlier results without repopulating the prompt area with completed
work. If DGC's backend stops, the agents that were still running are marked stopped.

## Limits

- The list shows up to 64 agents, the working ones first; the count stays exact beyond that.
- Descriptions and failure messages are redacted the same way the transcript is. A row shows the first
  line of a failure message.
""".strip()),

    ("Handoff", "a continuation document from this session, for the next one", """
# Handoff

`/handoff` snapshots one generation-stable session, asks the configured model for a bounded
self-contained continuation document, redacts it, and saves a new owner-private `HANDOFF-*.md`
through the workspace mutation lease. Use it when you want the next session — or another person —
to pick up without rereading the whole transcript.

The file is a new write, not an overwrite of an existing handoff. An overlapping turn is rejected
instead of mixed into the file. If another process changed the saved session under you, DGC asks
you to resume it first.

## Surfaces

- Terminal and classic: `/handoff`.
- Editor: **DGC: Generate Handoff**, or `/handoff` in the composer.
- Headless: `generate_handoff` with `save: true` (atomic write) or `save: false` (markdown only).

The `$handoff` skill is the instruction package for *how* to write one when you ask the agent
to; `/handoff` is the command that always produces the file.

## What it holds

Objective, current work, checks already run, remaining steps. Credentials are redacted. It is
not a full transcript (`/export`) and not project memory (`DGC.md`).
""".strip()),

    ("Code intelligence", "symbols, definitions, references, and a repo map", """
# Code intelligence

Two native tools help the agent find its way around a project without a lock-in to one editor
language server.

## `repo_map`

A compact inventory of the workspace: source, docs, and other text files (including a
plain job directory that only has `notes.txt`), sizes, SHA-256 prefixes, and language-aware
symbol definitions. Git is not required; each call walks the tree live. The agent uses it
near the start of unfamiliar multi-file work. Optional `path` narrows the tree; `max_files`
defaults to 300 (at most 1,000).

## `code_intel`

Find symbols, exact definitions or references, or syntax diagnostics.

- `operation`: `symbols` · `definition` · `references` · `diagnostics`
- `path`: file or directory (default: project root)
- `symbol`, or `line` / `column` (1-based) when the symbol is omitted

A bounded built-in static analyzer is always available. Configure a stdio language server for
richer results; DGC confines returned paths to the project and reuses up to four project/spec
sessions with serialized queries and idle cleanup.

```
{
  "language_servers": {
    "python": {"command": "pyright-langserver", "args": ["--stdio"]}
  }
}
```

Key by language (`python`) or extension (`.py`). Servers get a minimal environment, no shell.
Default idle is 120 seconds; set `code_intel_lsp_idle_s` to `0` for one-shot isolation.
`code_intel_timeout` bounds a query. Approved external-file queries always run one-shot.

Prefer `code_intel` over a broad `grep` for navigation. Returned locations never escape the
project.
""".strip()),

    ("Built-in tools", "what the native agent can call", """
# Built-in tools

On native local/API routes the model calls DGC's own tools. Subscription turns use the vendor
CLI's tools instead. The standard `tool_profile` (the default) offers every product tool on every
request — web, image, artifact, skill-install, memory, delegation, monitor and the rest — and lets
the model choose; a tool with nothing to act on (no skills installed, no background process, no
active goal) still stays out. `tool_profile: adaptive` instead offers the core read / edit / search
/ shell surface and adds the others only when the request's wording asks for them, which keeps a
small local context clear at the cost of a differently worded ask being told the tool does not
exist. `tool_profile: full` offers every tool allowed by the current permission mode. Plan mode
denies mutations. Full-auto omits the blocking options prompt unless your request mentions
choosing.

## Files and code

- `read_file` · `write_file` · `edit_file` · `multi_edit` · `apply_patch` — read, overwrite,
  exact-string edit, several edits to one file, or an atomic unified diff.
- `read_file` on a **document** (.docx, .xlsx, .pptx, .odt, .ods, .odp, .rtf, .pdf) returns the
  text extracted from it, with a note saying so — layout, images and embedded objects are not
  there, and an answer about how a document looks cannot come from this. Line numbers, `offset`
  and `limit` behave as they do for any other file. See **Attaching a document**. Any other
  binary is still refused rather than decoded into noise.
- `view_image` — look at a PNG/JPEG/GIF/WebP in the workspace (see **Viewed images**). For a model
  without vision, a configured vision model looks and answers its `question` (see **Sub-agents**).
- `glob` · `grep` — find files; search contents.
- `repo_map` · `code_intel` — inventory and symbols (see **Code intelligence**).
- `git_diff` — local Git without a shell (see **Git changes**).

## Shell and Python

- `bash` — a command; `background: true` returns a task id at once (dev servers, watchers). It
  holds the workspace lease only while it starts. Do not use a background command to change files.
- `bash_output` · `bash_kill` — page or search retained output; stop a background task. Handles
  belong to the originating agent and expire after 30 minutes.
- `python` — persistent interpreter, off until `/code-action on` (see **Python code-action**).
- `!cmd` in the composer uses the same sandbox, bounds, cancellation, and lease without asking
  the model to interpret the command.

## Web, browser, artifacts

- `web_search` · `web_fetch` — search, then read a URL as text (see **Web search**).
- `browser` — a real page: open, snapshot, click, type (see **Looking at a page**).
- `artifact` · `present_document` — serve a page, or show Markdown in the browser
  (see **Artifacts** and **Plan mode**).

## Agent, memory, and control

- `task` — a sub-agent: `agent` picks explorer / researcher / critic / worker (or a named
  definition); `background: true` outlives the turn (see **Sub-agents**).
- `todo` · `skill` · `add_skill` · `save_memory` · `update_goal` · `notes`
- `present_plan` — plan mode only, for approval.
- `propose_options` — ask you to decide (see **Questions**).
- `monitor` · `monitor_stop` — watch a long-running command (see **Background monitors**).

MCP tools join this catalog as `mcp__<server>__<tool>` when a server is connected.
""".strip()),

    ("Context notes", "what the project already learned, across context windows", """
# Context notes

Compaction protects the model's context window. It also throws away what was already tried,
which is why an agent can cheerfully re-attempt a fix that failed an hour ago. DGC keeps the
durable half separately: short, typed notes about this project, written as the work happens.

They are **per project**, so a run spread over days accumulates one trace, and they are written
by the harness from tool results it already sees — no model cooperation required, so the same
behaviour holds on any local endpoint.

## What gets recorded

- **failure** — a command or an edit that failed, with its exit code and the tail of its output.
- **outcome** — a file that was written or patched; a test command that passed.
- **requirement** / **decision** — from your standing goal and from a compaction summary.

Every note is bounded, redacted with the same secrets a saved session is, and carries the file,
the tool and the date it came from, so a stale note can be judged rather than trusted.

## Reading them

- **`/notes`** — the most recent notes. **`/notes <query>`** searches the whole trace: an error
  string, a test name, a file path. `dgc notes [QUERY]` does the same from a shell, and
  **DGC: Show Context Notes** runs it from the editor.
- The agent has a **`notes`** tool with the same reach, so it can check whether something already
  failed before trying it again. It is read-only and allowed in plan mode.
- **After a compaction**, a bounded digest of requirements, decisions and recent failures is
  carried into the fresh context — the point at which this history would otherwise be lost.
- **While editing**, a file that has failed before carries that history into the result the agent
  reads, once per file per turn, so the next attempt is not the same one again.

## Turning it off

`/notes off` stops recording everywhere, and `notes: false` in the config does the same. The
store lives beside the session transcripts (`~/.dgc/sessions/<project>/notes.sqlite`), holds the
most recent `notes_max_rows` entries, and is never sent anywhere.

This is not the `/recall` archive. That is your raw scrollback, kept for you to read and never
put back into the model's context. Notes are a small curated projection that deliberately can
be — which is why they are bounded and redacted.

This is also not **Memory** (`DGC.md` / `#a fact` / `/memory`) — that file is guidance you write,
loaded into the native prompt every session.
""".strip()),

    ("Memory", "DGC.md, #fact, and /memory — guidance that loads every session", """
# Memory

Memory is a Markdown file the native agent reads at the start of a session: project conventions,
commands that actually work here, facts you asked it to keep. It is not the context-notes trace
(those are written from tool results — see **Context notes**), and delegated subscription turns
do not receive this DGC injection.

## Where it lives

- **Project** — `DGC.md` at the project root. Loaded into every native session in that repo.
- **Personal** — `~/.dgc/DGC.md`. Loaded in every project, after the project file.

Both are bounded (about 32k characters of prompt view, 1 MiB on disk) and redacted the same way
saved sessions are. Missing files are simply empty.

## Writing it

- **`#a fact`** in the composer — appends that line to project `DGC.md` atomically.
- **`/memory add TEXT`** — the same, for project memory.
- **`/memory add user TEXT`** — appends to personal `~/.dgc/DGC.md`.
- **`/memory`** — show what is loaded.
- The model's `save_memory` tool does the same write, with `scope` `project` (default) or `user`.
- **`/init`** inspects the repo and prepares or updates `DGC.md` using ordinary edit permissions.
  In plan mode it proposes the guide first. See **Plan mode**.

A `#` line is memory, not a comment: it is written to the file, then the prompt is not sent as a
normal question.

## What belongs in it

Stack, layout, build/test/lint commands, house style, durable facts. Not credentials, personal
details, private absolute paths, or a dump of the last session — use **Handoff** for a continuation
document, and `/export` for a transcript.

## The date and the clock

Memory is not the only thing DGC puts in front of the model. It also tells it what time it is,
because a model with no clock writes "what I completed tonight" in the middle of the afternoon.

- The session prompt carries the day and where this machine is:
  `Date: 2026-09-20 (Asia/Kolkata, UTC+05:30)`. The zone name comes from the machine itself —
  `TZ`, or the `/etc/localtime` link on Linux and macOS. A machine that records no name shows the
  offset alone (`UTC+05:30`), and one that records nothing shows `UTC`. Nothing is looked up
  online.
- Every message you send carries the time of day, on its own line:
  `Local time: 14:32 (Asia/Kolkata)`. It is on the message rather than in the session prompt so
  that two questions a minute apart still send a byte-identical prompt, which is what lets a
  provider charge cached-input rates for the second one. Resumed chats and `/export` show what you
  typed, without it.

A day boundary reaches the model on your next message, so an overnight session does not keep
calling it yesterday. A sub-agent is told the same two things. A turn DGC starts by itself on a
background monitor gets no clock line: the events it delivers are already timestamped.
""".strip()),

    ("Sessions & rewind", "resume, jump, and undo whole turns", """
# Sessions & rewind

Every conversation is a session, saved as you go.

- **/resume** — reopen a past session (newest first); `dN` deletes one.
- **/new** (Ctrl+N) — start fresh; DGC auto-titles it from your first prompt.
- **/name** — rename the current session.
- **/branch** (`/fork`) — continue in a new chat from here. Everything so far comes with you —
  the conversation, the standing goal, the todos, the recovery points — and the chat you branched
  from keeps exactly what it had, so a second approach costs you nothing. `/branch <name>` names
  it; otherwise it takes the parent's name with *(branch)* after it. The editor offers the same
  thing under a finished answer.
- **/history** (Ctrl+R) — search and recall any past prompt.
- **/jump** — scroll the transcript straight to a past turn.
- **/recall** — read the earlier conversation a compaction summarised away (see below).
- **/export** (`dgc export [ID] [FILE]`) — save a session as Markdown, archived turns included.
  Nothing the full-screen app shows survives in your terminal's scrollback; this does, and so
  does `dgc --classic`, the inline mode.
- **dgc export-training** / **/export-training** — export your sessions as scrubbed
  fine-tuning JSONL (see *Training export*); read-only, never modifies a session. The
  slash command runs the same export for the current project; the VS Code palette
  exposes it as *DGC: Export Training Data*.
- **/handoff** — create a bounded, redacted continuation document from one stable
  session generation. DGC saves it as a new private `HANDOFF-*.md` through the
  workspace lease; an overlapping turn is rejected instead of mixed into the file.
  The **Handoff** page covers the editor command, headless save, and what the file holds.
## Your earlier conversation after a compaction

When a session grows past `compact_threshold` of the context window, DGC replaces the older
turns with a summary. That is the **model's** limit, not yours: the turns themselves are kept
beside the session, so scrolling up shows *Your earlier conversation is still here* instead of a
bare summary. Click it, or run **/recall**, to read those turns back in place; click again to
hide them. `/recall` also works in `/copy` select mode, where the header is not clickable.

What is kept is a display copy — the text of your prompts and the model's replies, plus which
tools each turn used. It carries no tool results and nothing that could be fed back to a model,
and showing it never changes what the model sees or what the turn costs. Secrets are removed with
the same redaction that protects the saved session, including retroactively: a credential DGC
learns about later is scrubbed from turns archived earlier.

The archive is bounded (`recall_max_bytes`, 512 KB by default) and drops the oldest turns first
when it is full, saying so on the same line. Deleting a session deletes it too.

- **/rewind** — restore both the code *and* the conversation to how they were at a chosen
  turn. What a recovery point holds, what it cannot take back, and the editor's Undo are in
  *Checkpoints & rewind*.

## One session, one window at a time

A session is held by whichever DGC is running a turn in it, so a second window opening the same
session is told it has *an active turn in another DGC process*. That protects the transcript: two
backends writing one session would interleave their turns.

The lease is released when that turn ends, when its DGC exits, and if its DGC crashes — it is an
operating-system lock, not a file DGC has to remember to clean up.

It is also released when the editor that owned the backend goes away. An editor says it is still
there about once a minute; a backend that was hearing that and stops hearing it treats the window
as closed and lets the session go, within about fifteen minutes. That wait exists because a
backend cannot otherwise tell a closed window from a user who is thinking: its input stays open
for as long as the editor *process* lives, and an editor can leave that process behind when it
reloads. Nothing is dropped to make this happen — a backend with a turn running, a background
monitor armed, a detached sub-agent still working, or an open goal stays up regardless, however
long it has been quiet.

If you would rather not wait, start a new session, or close the other window.
""".strip()),

    ("Checkpoints & rewind", "what a recovery point holds, /rewind, the editor's Undo, and what cannot come back", """
# Checkpoints & rewind

Every turn DGC runs itself opens a recovery point. `/rewind` takes the code *and* the
conversation back to one of them.

## When DGC takes one

- **One per turn, before the model sees your message.** A standing goal that runs several work
  cycles from one prompt opens one per cycle. A follow-up typed while a turn is running joins
  that turn and does not open one of its own.
- **Sub-agents do not open their own.** Their edits are captured into the parent turn's point —
  as they happen in a shared checkout, or when an isolated worktree is integrated. `/tasks apply`
  opens a point of its own.
- **Turns delegated to a subscription CLI open none.** Claude Code, Codex, Qwen, Kimi and Copilot
  edit files outside DGC's file tools, so there is nothing for DGC to snapshot.
- **If the point cannot be saved, the turn does not start.** DGC refuses the prompt rather than
  run a turn it could not take back.

## What a point holds

- **The exact conversation** up to just before that prompt — not a summary, and not a message
  count that compaction can shift.
- **Each file's pre-edit state**, taken the first time the turn's file tools (`write_file`,
  `edit_file`, `multi_edit`, `apply_patch`) touch it: the exact bytes, the permission bits, a
  symlink's target, or the fact that the file did not exist yet.
- **Capture comes first.** The snapshot is saved to the session before the tool runs. If it
  cannot be — the file changed while being read, the snapshot budget is spent, the turn has
  already captured 4,096 files, the path is not a regular file, or the session could not be
  re-saved — the edit is refused and the file is untouched.

## Rewind in the terminal

`/rewind` lists every point, oldest first: the opening 70 characters of the prompt as DGC
received it (a point opened by `/tasks apply` reads *apply retained task ID*) and how many files
it captured. Pick one and confirm — *Reverts N file(s) and truncates the conversation. This
cannot be undone.* Files touched at that turn or any later one return to their earliest saved
state (a file the turn created is deleted; any new directories it was created in are left
behind), the conversation returns to just before that prompt, and that point and every later one
are consumed. If any step fails, the files and the point are rolled back and kept.

It always restores both — there is no code-only or conversation-only rewind, and no redo. It is
refused while a turn is running: stop the turn (**Esc**) or let it finish, then run `/rewind`
again. `dgc --classic` skips the confirmation. The standing goal, the todos and Context Notes
stay as they were.

## Undo in the editor

**Undo**, on the files-changed card under an answer that edited files, finds the recovery point
by the prompt that opened it, asks once, and performs the same rewind. A turn that changed no
files shows no card — use `/rewind`. If no remaining point was opened by that prompt, Undo
declines rather than guess; if the same prompt opened more than one point, it takes the most
recent one — `/rewind` lets you pick another. `/rewind` in the editor lists every point and
rewinds as soon as you pick one.

## Keep both with /branch

`/branch` (`/fork`) is the non-destructive alternative: a new chat that carries the conversation,
the standing goal, the todos and the recovery points, while the chat you came from stays as it
stands (its `/recall` archive of compacted turns stays with it). Nothing is reverted. The editor
offers it under a finished answer.

## What is not rewindable

- **Shell writes.** `bash`, the Python code-action, MCP tools, `save_memory` (your project's
  `DGC.md`) and `add_skill` are never snapshotted. A file a shell command changed comes back
  only to the state a file tool later found it in: if a file tool snapshotted it before the shell
  ran, the shell's change is undone; if the shell ran first, that change stays.
- **Files outside the project.** An approved external path is rewindable in the current process
  only; its snapshot is never saved with the session.
- **A moved project.** Points are bound to the directory they were saved from and do not load
  after a move or rename — and the first prompt in the moved directory saves over them, so they
  are gone for good. Move the project back before resuming if you need them.

## Where they live

Points are saved inside the session itself, re-saved the moment a point opens and the moment a
file is first captured, so they survive `/resume` and context compaction. There is no time
limit: the newest 512 points are kept, up to 4,096 files each, within 128 MB of snapshots in
total. Redaction rewrites the conversation each point holds; file snapshots stay byte-for-byte
as captured, because they are the rollback data.
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

`/goal <objective>` saves the objective and starts work in the terminal or editor.
DGC continues an active goal across work cycles on native local/API and delegated
subscription routes. Ordinary prompts do not create goals.

In the terminal, an active goal keeps a row directly above the composer: the objective, its
status, and the work time counted so far — so what DGC is holding you to, and how long it has
been at it, are visible without asking.

In VS Code/Cursor, entering `/goal <objective>` first saves the tagged goal and
then immediately starts that exact objective as an agent turn. Its status, active
time, review button, pause/resume button, and edit/delete controls stay above the composer.
Editing preserves the goal's identity and accumulated work time. Reopening a saved
session pauses its goal; time spent offline is not counted as work.

Picking `/goal` from the `/` menu attaches it to the composer as a chip and leaves the cursor
after it, so you type the objective and press Enter to send — the same way `$skills` attach. A
command that takes nothing, such as `/help`, still runs the moment you pick it.

- `/goal` or `/goal review` — inspect the objective, status, work time, cycles, and evidence.
- `/goal pause` — stop work and retain the goal for later.
- `/goal complete` — retain the objective as an auditable completed record.
- `/goal blocked` — stop automatic progress while an external blocker exists.
- `/goal resume` — reactivate the goal and continue work immediately.
- `/goal clear` — remove it.

## How long an objective may be

A standing goal is stated to the model in full once per context — and again after a compaction,
which starts a fresh one — while later turns only refer back to it. That keeps the recurring
cost of a goal to a few dozen tokens a turn rather than restating the whole objective every time.

Because the full statement has to fit the window it lives in, the limit is a share of your
context rather than a fixed number: a quarter of it, leaving three quarters for the work. A 32k
context allows about 32,000 characters, a 128k one about 131,000 — raise `context_size` and the
allowance rises with it. If an objective is still too long DGC says so, gives you the text back,
and keeps the goal you already had: nothing is truncated and nothing is lost.

Native models use `update_goal` with a summary and evidence. Delegated models submit
a structured closing report that DGC validates and removes from the displayed answer.
Completion is applied after the work cycle succeeds; failed or cancelled work cannot
complete a goal. Three consecutive cycles without distinct tool progress block the
goal for review. Cancellation or a runtime failure pauses it.

Use `/goal --tokens 100000 <objective>` for an optional token budget, or edit the
budget in the goal card. Budgets are checked between native requests or delegated
work cycles, so a request or concurrent/subagent work can take usage past the limit. A model route that
does not report usage cannot enforce a token budget; DGC pauses instead of continuing
with unknown usage. The goal review shows the reported usage and any budget pause.
Ending one work cycle or finishing one milestone is not whole-goal completion.

## When a turn stops on its own

A goal is the instruction to keep working without someone watching, so a turn that
stops on a recoverable fault does not end the goal. The most common one is the loop
guard: a model that calls the same tool with identical arguments six times without
using the result is looping, and DGC stops that turn. It then restarts the goal
itself, passing the reason forward so the next attempt takes a different step rather
than reissuing the call that failed.

Consecutive automatic restarts are capped at two. If changing approach twice does not
help, DGC stops and says so, because a third identical failure is a signal for a person
to look — usually a more capable model for that step, or a narrower instruction — not a
reason to spend the rest of the context window retrying. Any prompt you send resets the
budget, and cancelling a turn yourself is never overridden: that decision stands.

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

    ("Files pane", "a file explorer under the transcript while the agent works", """
# Files pane

`/files` opens a file explorer in the **focus pane** — the split under the transcript that the
agent keeps streaming above. Browse the project, pick files for your next prompt, watch the
model's edits land, and manage files without leaving DGC or stopping the turn.

## Open it

- `/files` opens at the project root · `/files src/auth` jumps to a folder or focuses a file.
- The pane folds away whenever DGC needs your answer (a permission, a prompt, a picker) and
  returns when you have answered. **q** or **Esc** closes it; **Ctrl+C** still stops the agent.
- It works during a turn: the header shows what the agent is doing (`DGC: USING TOOLS`), and
  files the model changed this turn carry a **✎** mark.

## Layout

Three columns like yazi and ranger: the parent folder, the current folder, and a preview of what
is under the cursor — the first lines of a text file with line numbers, a folder's entries, a
symlink's target, or a one-line summary for binaries. Narrow terminals drop the parent column,
then the preview. **i** or **Tab** swaps the preview for details (size, modified time, mode, Git
status). Git status letters (**M** modified · **A** added · **D** deleted · **?** untracked) come
from a read-only `git status` that never runs filters or transports.

## Move and select

- **j / k** or **↑ ↓** move · **h / l** or **← →** go to the parent / enter a folder · **gg / G** top / bottom
- **H / L** back / forward through folders you visited · **-** the previous folder · **~** home · **gr** the project root
- **Space** toggles the entry under the cursor · **v** starts a visual range · **Ctrl+A** selects everything · **Esc** clears
- **f** filters the list as you type (smart case) · **/** finds and **n / N** step through matches · **.** shows hidden files · **s** cycles name → modified → size → extension, **S** reverses

## Use a file in your prompt

- **Enter** (or **o**) on a file inserts `@path` into the composer — the same bounded file attachment as typing it — so you can browse, pick, and ask about exactly that file.
- **c** inserts the plain path instead.

## Change files

- **a** creates a file, or a folder when the name ends with `/` (`docs/notes/` creates both levels).
- **r** renames, with the cursor placed before the extension.
- **y** copies and **x** cuts the selection (or the entry under the cursor); **p** pastes into the current folder, keeping both on a name collision (`name (2).ext`); **P** overwrites instead.
- **d** sends entries to the trash — DGC's own `~/.dgc/trash` by default, kept for 30 days, or the OS trash when `trash_mode` is `os`.
- **D** deletes permanently and always asks first.
- **u** undoes the last change: renames move back, copies are removed unless you edited them, trashed entries return, and permanently deleted *files* (up to 8 MB) are restored from the snapshot taken before deletion. Deleted folders are not restorable.

## What it will not do

- It never runs a shell command and nothing it does enters the model's context unless you insert a path.
- Writes follow the permission mode: **plan** makes the pane read-only; **default** asks before trash, move, and overwrite; **acceptEdits** and **auto** act immediately with undo. Permanent deletion asks in every mode.
- Writes stay inside the project. Browsing above the root is read-only, except in **auto** mode, which asks first.
- The project root itself is never an operand. Trash, delete, rename, and move refuse it and every folder above it, in every mode, so browsing up to the parent and pressing **d** cannot throw the project away.
- Trees over 5,000 entries or 512 MB are refused rather than half-copied; use the shell for those.
""".strip()),
    ("Diff pane", "every changed file, its counts and its diff, live under the transcript", """
# Diff pane

`/diff` opens a live view of everything that has changed in the working tree, in the **focus
pane** under the transcript — the agent keeps streaming above it. It is the answer to "what has
DGC actually changed so far?" without leaving the conversation, and it turns any lines you pick
into part of your next prompt.

## Open it

- `/diff` lists every changed file · `/diff src/auth.py` opens straight into that file's diff.
- The pane folds away whenever DGC needs your answer (a permission, a prompt, a picker) and
  returns when you have answered. **q** or **Esc** closes it; **Ctrl+C** still stops the agent.
- It works during a turn. The list re-reads Git every two seconds while it is open, so the
  model's edits appear as they land; **r** re-reads immediately.

## What it shows

The data is Git's, read-only: the working tree against `HEAD`, plus staged and untracked files —
exactly what `git status` calls changed. Each file carries its added and removed line counts
(**+12 −3**), a flag for **?** untracked, **D** deleted and **S** staged, and the header sums
the whole change set. Wide terminals show the file list and the selected diff side by side; a
narrow terminal shows one at a time and **Tab** swaps them. The diff is a unified diff with three
lines of context, new-side line numbers in the gutter, and hunk headers you can jump between.

## Move

- **j / k** or **↑ ↓** move through files, then through diff lines · **Enter** or **l** opens the diff · **h** or **Esc** returns to the list
- **J / K** step to the next or previous file's diff without leaving the diff
- **g / G** top and bottom · **PgUp / PgDn** page · **Ctrl+D / Ctrl+U** half a page

## Put lines in your prompt

- **Space** (or **v**) starts a selection at the cursor; move to extend it; **Space** again or
  **Esc** drops it.
- **Enter** with a selection inserts it into the composer as a fenced `diff` block, headed by
  the file path and the new-side line range — so "why did you change these three lines?" can
  quote exactly those three lines. Nothing else about the file enters the model's context.
- **a** attaches the whole hunk under the cursor the same way.
- One insertion is capped at 120 lines; the header says when it was clipped.

## What it will not do

- It never writes, stages, commits or runs a shell command; it only reads Git.
- Diffs over 4,000 rows are clipped; binary files show as `bin` with no diff.
- It is not the review: `/review` and the editor's **Changes** view stay the place to approve or
  undo a turn. `/diff` is for looking and asking while the work is still moving.
""".strip()),

    ("Git changes", "git_diff, Changes in this chat, and Workspace changes", """
# Git changes

DGC inspects Git without running `git diff` through a shell, without clean/smudge filters, and
without talking to a remote. Three surfaces share that reader.

## The `git_diff` tool

Available in every permission mode, including plan. `/review` uses it. `GitDiff` permission rules
use the same deny → ask → allow policy as other tools.

| View | Comparison |
| --- | --- |
| `uncommitted` (default) | HEAD → index, then index → working files, including untracked files |
| `staged` | HEAD → index; also works before the first commit |
| `working` | Index → working files, including non-ignored untracked files |
| `base`, with `ref` | Merge base of a local branch/tag/commit and HEAD → HEAD |
| `commit`, optional `ref` | First parent → one commit (default HEAD); root commits use an empty tree |

`{"view":"base","ref":"main","path":"src"}` reviews committed branch changes under `src`. Base and
commit views do not include uncommitted edits. No view fetches. Working files are compared as raw
bytes, so checkout line-ending conversion can differ from the ordinary Git UI. Renames appear as
delete plus add. Symlinks, submodule contents, and conflicts need a separate look.

Inspection has a 20-second deadline, a 4,096-file cap, 1 MiB per file/list, a 64 MiB aggregate
read budget, and a 24,000-character diff budget. Partial coverage is explicit. "No changes" is
returned only when the selected scope was inspected completely and had none.

## In the editor: Changes in this chat

The composer card **Changes in this chat** records deltas observed while *this* chat ran, using
the actual file state before each run — even when the file was already dirty. A fresh chat starts
empty. Opening a chat and finishing a read-only turn produce no card. Saved previews survive
reload; later manual edits do not rewrite them. Older sessions have no retroactive baseline.

Snapshots are private session data. They never enter model context.

## In the editor: Workspace changes

**Workspace changes** is the separate Git review: HEAD against working files, plus staged-only
entries, including work that predates the chat. Tracking covers the currently acknowledged editor
folders. Line totals are the displayed working-file differences, so a staged-only entry can show
zero net lines; opening it previews the index as **DGC staged review**. Binary, conflict,
submodule, and oversized previews send you to Source Control.

The terminal's `/diff` pane is the live working-tree view while a turn runs; see **Diff pane**.
""".strip()),
    ("SDK", "embed DGC in an application or CI job", """
# SDK

The DGC SDK runs the same agent inside your own program: an application, a service or a CI job.
It is **free and local**. You do not pay DGC to use it; optional `Pricing` only attributes the
model-token spend your provider bills you.

Current release: **dgc-sdk 0.5.3** on [PyPI](https://pypi.org/project/dgc-sdk/) and the Node
package `@vibedgc/sdk` 0.5.3, both tagged [`sdk-v0.5.3`](https://github.com/OpenPeach-ai/dgc/releases/tag/sdk-v0.5.3)
(not `v0.5.x`, which are historical CLI tags). They pair with CLI **0.41.6** over editor protocol
v14 and are proven on Linux. The full guide and API reference is
[docs/SDK.md](https://github.com/OpenPeach-ai/dgc/blob/sdk-v0.5.3/docs/SDK.md).

## Install

```
python3 -m pip install dgc-sdk==0.5.3
```

That installs `import dgc_sdk`. Do **not** run `pip install dgc`: PyPI's package named `dgc` is a
different project. The SDK drives `dgc serve` from your DGC CLI install and finds it on its own
(`dgc` on `PATH`, `~/.local/bin/dgc`, the installer's versions). `DGC_PYTHON` or `runtime=[...]`
picks a different one.

## Quickstart

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

Each `DGC` owns one `state_dir`: an isolated HOME that holds its conversations, checkpoints and
logs. Your own `~/.dgc` is unused unless you pass `inherit_user_state=True`. Use a private
directory, never a shared fixed path.

## Stream and cancel

```python
with session.stream("Review the checkout flow", max_turns=12, timeout=600) as run:
    for event in run:
        if event.type == "text_delta":
            print(event.data["text"], end="")
    result = run.result()
# run.cancel() stops an in-flight turn, including during an approval wait.
```

Async: `AsyncDGC` / `await session.stream(...)` / `async for event in run`. Events are plain
dictionaries keyed by `event.type`; docs/SDK.md lists them.

## Policy and sandbox

`RuntimePolicy(network="deny", deny_tools=("write_file",))` is enforced by the runtime for that
session in every permission mode, including `auto`, and is never saved to a config file: denied
tools (custom and MCP tools too), file tools kept inside the workspace, no web or third-party MCP
access. Shell commands cannot be held by rules on their text, so by default the policy runs them
in the OS sandbox (`bwrap` or `sandbox-exec`): no network, no writes outside the workspace. In
`auto` mode the shell runs only there. `sandbox={"requirement": "required"}` refuses to start a
session that cannot be confined.

## TypeScript

`@vibedgc/sdk` (Node 22+) is attached to the GitHub release; it is not on the npm registry yet.

```
npm install https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.3/vibedgc-sdk-0.5.3.tgz
```

```
import { DGC } from "@vibedgc/sdk";

const dgc = new DGC({ stateDir, model: process.env.DGC_MODEL, baseUrl: process.env.DGC_BASE_URL });
const session = await dgc.session({
  cwd: "./checkout-app",
  permissions: { mode: "plan", unhandled: "deny" },
});
const result = await session.run("Explain the checkout flow. Do not edit files.");
console.log(result.status, result.finalText);
await dgc.close();
```

Product page: [vibedgc.com/sdk](https://vibedgc.com/sdk/). Source: [github.com/OpenPeach-ai/dgc](https://github.com/OpenPeach-ai/dgc) (`sdk/`).
""".strip()),
    ("In your editor", "the VS Code and Cursor panel, and what a finished turn gives you", """
# In your editor

DGC runs the same agent inside VS Code and Cursor. The extension drives your local `dgc` — the
model, the permission mode, the skills, the MCP servers and the session history are the ones you
already have, and nothing about your code leaves the machine that the terminal would not.

## Install

- **VS Code**: search the Marketplace for **Vibe DGC**, or `code --install-extension vibedgc.dgc`.
- **Cursor**: search its own extension gallery for **Vibe DGC**. Cursor updates extensions on its
  own schedule, so use **Extensions → Vibe DGC → Update** if you want a new version immediately.
- The panel opens in the activity bar, or in the secondary sidebar if you prefer it on the right.

Keep the CLI and the extension roughly in step. They speak a versioned protocol, and if one is
too old the panel says which side to update rather than failing quietly. `dgc update` moves the
CLI; the extension updates through your editor.

## The composer

- **@** attaches a file, **/** opens the command palette, **$** applies a skill.
- Paste an image to attach it for a vision model. Drag files in from the explorer.
- The send button fills with DGC purple as soon as there is something to send, and becomes a stop
  button while a turn is running.
- The row underneath holds the model, the reasoning effort and the permission mode. Every control
  says what it does when you hover or focus it.
- Scrolling back through a long run puts a **Latest** pill over the end of the transcript; it
  turns purple and reads **New** when the model has written something you have not seen.

## What an answer can show

- **Diagrams.** A ```mermaid fence renders as the diagram it describes, drawn in the panel's own
  colours and type. The source stays underneath behind **Show source**, so Copy still gives you
  the markup. A diagram DGC cannot parse keeps its code block rather than being replaced by an
  error, because a diagram that will not draw must not delete the text around it.
- **Code**, syntax-highlighted, with a Copy button. A fence longer than 24 lines folds, so one
  long file cannot push the answer off the screen.
- **Tables**, also with a Copy button, which gives you the model's Markdown rather than the
  rendered DOM.
- **Quoted blocks** — a drafted mail, a message to forward — drawn as a block of their own with
  room at the top and bottom, and a Copy button that gives you the text without the `>` markers
  running down its left edge. A quote nested inside another has no button of its own, because it
  is part of what the outer one already copies.
- **Commentary** — the short notes a model writes between tool calls — has its own Copy on hover,
  so the most quotable line in a turn is no longer the one line you could not lift.
- **Links**, marked with where they point — GitHub, the Marketplace, a docs site, a file in this
  workspace. A file link opens it at the right line. Nothing is fetched to work this out, so a
  URL a model mentions is never disclosed to anyone by the act of rendering it.

## When a turn finishes

DGC ends an answer with what it changed and what you can do about it.

- **A summary of the files this turn touched**, each with its additions and deletions, and each
  opening its own diff. **Review** opens every change this chat has made.
- **Undo** puts those files back as they were before the turn and rewinds the conversation with
  them. It finds the recovery point by the prompt that opened it and refuses if it can no longer
  identify it, because an undo that guesses loses work you did not ask it to.
- **Copy** takes the whole answer as Markdown. A tool row that ran a shell command (`bash`,
  its output, a monitor) carries its own Copy on hover, which gives you the command verbatim;
  copying does not open the card.
- **Tasks** — the checklist the model keeps sits above the composer and updates as it works:
  □ pending · ▶ in progress · ✓ done · ⊘ blocked. It comes back when you reopen the session;
  **Clear** drops it (the terminal's `/todo clear`). Finishing with open tasks is reported, not
  treated as a failed turn.
- **Rate** records a thumb up or down for this workspace. It is stored locally and sent nowhere.
- **Branch** continues in a new chat from this point. The conversation comes with you and the
  chat you branched from keeps everything it had, so you can try a second approach without
  losing the first. `/branch` does the same in the terminal.
- **Run again** re-sends the same prompt without disturbing whatever you were half-way through
  typing; **edit and resend** puts the prompt back in the composer instead.

## Approving work

When DGC needs permission, the card shows what will actually happen — the command, or the diff
the edit would apply — not the raw arguments. **Allow once**, **Always allow** (which writes a
permission rule) or **Deny**, and a denial can carry a note that reaches the model as the reason.

## When DGC asks you to decide

Some choices are yours: a trade-off with no safe default, or a requirement the request leaves open.
The model asks with a question card instead of a list of options in prose. The **Questions** page
covers the terminal, classic prompt, ACP, full-auto, and who cannot be asked. In the editor:

- **The card docks in the prompt box** in place of the text box. **Stop**, the mode and model pickers
  and the context meter stay where they are, and anything you had typed comes back when the question
  closes.
- **The recommended option is chosen for you but not sent.** It carries a **Recommended** badge and
  starts checked and highlighted, so **Enter**, a click on it or **Next** takes it. Nothing is sent
  until you act.
- Every option has a one-line description of what choosing it means. **Something else…** lets you
  write your own answer, and **Skip** leaves a question unanswered. With several questions, each
  answer moves on to the next and they are sent together at the end.
- **×** or **Esc** (with the text field empty) closes the question without answering. DGC does not
  choose for you: it tells the model you closed it, ends the turn, and pauses a standing goal that was
  waiting on the answer. Tool calls the model made after the question in the same step do not run.
- Answered questions stay in the step as **Asked 2 questions** (or **Asked · SQLite file**) with each
  question and your answer, after a reload or resume as well.

The full-screen terminal asks the same questions: one row per option with the cursor on the
recommended one, digits to pick, Space to toggle a multi-choice option, and ←/→ or Tab between
questions; the classic prompt uses an arrow menu that starts on the recommended option. Sub-agents
and `dgc -p` runs are not offered the question tool; a sub-agent hands the decision back to the main
agent with its recommendation.

Full-auto does not stop to ask, so it offers the question card only on a turn where you ask to choose
yourself ("propose me options to select from", "let me choose"), and withdraws it again once one round
has been asked, so the rest of the turn runs unattended. Where nobody can answer (a turn a background
event started, `dgc -p`, a sub-agent, a subscription CLI), asking to choose gets the options as a
numbered list instead.

## Settings

The gear opens five pages: **General** (permission mode, thinking, context size, tool profile),
**Models** (a local host, a provider, or your own subscription CLI), **Agents** (the model and
host that sub-agents and the fallback route use), **Security** (sandbox confinement and plan-mode
limits) and **Extensions** (skills, MCP servers, hooks, permission rules, memory and these docs).
Everything is a row: what it is on the left, the control on the right, the explanation beneath.

## What the editor adds

- Files DGC changed carry a mark in the explorer, and the diff opens in your editor's own viewer.
- **Changes in this chat** on the composer is this chat's own deltas, not pending Git from before
  you opened it. **Workspace changes** is the separate repository review. See **Git changes**.
- **Add to DGC** in the explorer and editor-tab context menus attaches a file to the composer.
- The panel reads your selection and the file you are in as typed context, not as text glued into
  the prompt.
""".strip()),

    ("Questions", "when the model needs you to pick, not guess", """
# Questions

Some choices have no safe default: a trade-off, or a requirement the request leaves open. The
model asks with `propose_options` instead of a numbered list in prose. It can ask 1–4 questions
at once, each with 2–6 options (2–4 is advised). The option it recommends comes first, with its
label ending `(Recommended)` and a one-sentence description. DGC never reorders the list. Every
client adds free text ("Something else…"); an "Other" option the model adds is dropped. Custom
answers are bounded to 4,096 characters.

Closing a question (× or Esc) is its own outcome: DGC saves whatever you already answered, ends
the turn with no further model request, keeps queued prompts and monitors, and pauses a standing
goal that was waiting on the answer. Stop still means stop. Answered questions stay in the
transcript as **Asked 2 questions** (or **Asked · SQLite file**) inside the step, after a reload
or resume as well.

## In the editor

The question docks inside the composer in place of the text box. Stop, the mode and model pickers
and the context meter stay; the unsent draft comes back when the question closes. Each option is
a stacked card. The recommended option is preselected — checked, highlighted, focused — so Enter,
a click on it, or Continue takes it. Skip sits beside Continue. Nothing is sent without your
action. Keys that arrive within 400 ms of the question opening are ignored. If the composer still
has focus on a draft, it says "Press Tab to answer" instead of stealing focus.

## In the terminal

The full-screen app shows one line per option, the focused option's description under the
question, and the cursor on the recommended option. Digits pick, Space toggles a multi-select
option, "Skip this question" skips, ←/→ or Tab change question.

The classic prompt uses an arrow menu per question starting on the recommended option, with
"Something else…" and "Skip this question" rows. Multi-select takes comma-separated numbers.
Several questions get a review list whose Submit skips anything unanswered.

## Who is not asked

Sub-agents and `dgc -p` are not offered the picker: a sub-agent returns the decision to the main
agent with its recommendation. Subscription CLI turns keep the vendor's own question interface.
A turn a background event started, and later wake turns after you have already answered a round,
are told to list the choices as a numbered list instead of claiming the picker is missing.

Full-auto auto-approves tool calls; it does not hide the options picker. It leaves
`propose_options` out of ordinary coding turns, except on a turn where you explicitly ask to
choose ("propose me options", "let me choose", "ask me to pick", "show me a test option picker").
That turn gets the native picker in every permission mode — the model must call `propose_options`,
not mock it in Markdown or ask you to reply with a number. In full-auto it is withdrawn again once
one round has been asked, so the rest of the turn (a whole goal run) goes on unattended. Only text
you type counts: attached files, editor context, and a goal's objective never re-open the picker. A
sentence that describes software ("the dropdown should let me choose a region") is not an ask.

## A question that does not stop the turn

The picker above is a decision: DGC stops and waits, because it cannot sensibly carry on without
your answer. An **open question** is the other case — the model needs a fact it has no way to
work out, like which of your machines you meant or what to call something, and there is plenty of
the task it can get on with meanwhile. So it asks, and keeps working.

It arrives as a card in the conversation rather than over the composer. Type an answer and press
Enter, take one of the suggested answers if any fit, or **Skip**. Your answer is quoted back with
the question above it, as an ordinary message, so a reopened session shows it the way it happened.

Leave it and it folds to a single line reading **Answer question**; click that whenever you like
and it opens again. Nothing is lost by ignoring it: a question still unanswered when the turn ends
is recorded as unanswered, and the model is told so it decides for itself and says what it
assumed. Skip does the same immediately.

The model may have at most two open at once, it is never offered in a sub-agent or in a
non-interactive `dgc -p` run, and asking a question never raises a permission prompt — nothing is
changed by asking.
""".strip()),
    ("Looking at a page", "drive a real browser to see a deployed or local site", """
# Looking at a page

`web_fetch` gets you an article's text. It cannot run JavaScript, log in, click anything, or tell
you whether a page actually *rendered*. For that DGC drives a real browser.

    you › open https://staging.example.com and tell me if the pricing table renders

The agent earns a `browser` tool when your prompt is about a page that has to run — a deployed or
locally served site, a screenshot, a console or network question, or clicking through a flow. It
stays out of the way the rest of the time.

## What it can do

| Operation | What you get |
| --- | --- |
| `open` | Navigates, waits for the page to settle, returns the page structure |
| `snapshot` | The current page as roles, names and refs — the model's main way of reading |
| `find` | Elements matching text, with their refs |
| `click` · `type` · `select` · `press` | Real input events, then a fresh snapshot |
| `wait` | Blocks until text appears, capped at 30 seconds |
| `console` | Console messages since load, with severity |
| `requests` | Network responses: status, type, and what failed |
| `screenshot` | A PNG saved under `.dgc/screenshots/` (given a url, it opens that page first), shown in the chat, and to the model if it has vision |
| `close` | Ends the browser session |

A snapshot looks like this, and every `[e12]` is a handle the model can act on:

    - heading level=1 "Sign in" [e1]
    - form [e2]
      - textbox "you@example.com" [e4]
      - button "Continue" [e8]

Refs change whenever the page does. After a click that navigates or re-renders, the tool hands
back a fresh snapshot, and stale refs fail with a message telling the model to take a new one.

## Screenshots and local models

A screenshot is only useful if something can look at it. In the editor panel the step that took it
shows an image count; open the step to see the image as a thumbnail, and click the thumbnail to open
it in a viewer. In the terminal, open the step and click `open` to hand it to your system's image
viewer. *Viewed images* has the details.

Whether the *model* can see it is a separate question, and DGC checks rather than guesses. With a
vision model the picture is attached for it to read. A model without vision never receives it. If a
vision sub-agent model is set, the result says where the screenshot was saved, and the model can ask
that vision model about it with `view_image` (see *Sub-agents*); either way it is nudged to use
`snapshot`, which is more precise for page structure. If an
endpoint turns out not to accept images, DGC caches the rejection for that endpoint/model pair
for up to one hour, shared across chats in the same process. Restarting DGC clears it. Check
with `ollama show <model>` — look for `vision` under Capabilities.

## Which browser

DGC uses a Chrome or Chromium you already have. It looks at `browser_path` in
`~/.dgc/config.json`, then `CHROME_PATH`, then Playwright's cache, then your PATH, then the usual
install locations. **It never downloads a browser** — if there is none, it says so and tells you
where to point it.

Each session gets its own throwaway profile, so a page never sees your real cookies or logged-in
sessions, and the profile is deleted when the session ends.

## If the browser refuses to start

On Ubuntu 23.10 and later, and on other distributions that restrict unprivileged user namespaces,
Chromium cannot build its sandbox and will not start:

    Chromium cannot start its sandbox on this system…

Install an AppArmor profile for the browser, or set `browser_allow_unsandboxed: true` in
`~/.dgc/config.json`. The second is a real trade: without the renderer sandbox, a page exploit is
no longer contained. DGC will not make that choice for you.

## Permissions

Every navigation goes through the same permission gate as any other tool, under the name
`Browser`. Rules are keyed on the URL, so you can allow a host and nothing else:

    "allow": ["Browser(https://staging.example.com/*)"]

There is deliberately no operation for running arbitrary JavaScript in the page. The snapshot is
built by a fixed first-party script; a model cannot supply its own.

## Untrusted by construction

Everything the browser returns is web page content, and it comes back labelled as untrusted — the
same treatment `web_fetch` gets. Text on a page is evidence about that page, never an instruction
to DGC.
"""),

    ("Viewed images", "screenshots and image files the model looked at, kept with the step that looked", """
# Viewed images

When the model looks at an image, you can see the same image, in the step that looked at it. That
covers a browser screenshot, an image file from your workspace, and an image an MCP tool returned.

## Where they come from

- **Screenshots.** The `browser` tool's `screenshot` (see *Looking at a page*).
- **Image files.** With a model that accepts images, the agent can use `view_image` on a PNG, JPEG, GIF
  or WebP file of up to 8 MB. It is offered when your prompt names an image file or asks about
  something only a picture shows. `read_file` on an image file views it the same way, in the read
  step. With a model that cannot read images, a configured vision model looks instead and answers in
  text; without one, the step says so. A BMP is shown to you but never sent to a model; convert it to
  PNG if a model needs to look at it.
- **MCP tools** that return images.

A step keeps up to eight images. More than that are counted, not kept.

## Attaching images to a prompt

Paste or drop images into the composer. The editor hands them to DGC as files in a directory DGC
owns, so what you may attach is bounded by what a model can be sent rather than by what fits in
one protocol message: **32 MB in total, with no limit on how many**. Each file is checked against
its declared type, read once and deleted — the directory is a hand-over, not a store, and a
refused batch is cleaned up too.

An older DGC that does not offer this receives them inside the message as before, and keeps the
old ceiling of four images and 2 MB; the editor notices which it is talking to and says the right
limit if you go over. The terminal's `@picture.png` and other clients (ACP, Zed) are unchanged:
four images, 8 MB each, 20 MB in total.

## In the editor

A step that produced images shows an image count on its row. Open the step and its images sit above
its output as thumbnails. Click one to open the viewer over the panel:

- the image's name, size and where it came from (browser screenshot, workspace image, MCP image);
- **←** and **→** move between the step's images, **Home** and **End** jump to the first and last;
- **Z** switches between fitting the panel and actual size, and **Shift+arrows** move around a large
  image;
- **Open file** opens DGC's stored copy in the editor;
- **Stop** (while DGC is working) stops the turn, since the viewer covers the prompt box's own Stop;
- **Esc** or **×** closes it and puts the focus back where you were.

If DGC needs you while the viewer is open (a permission, a plan, a question), the viewer says so and
**Show** takes you to it. Images come back when you reload the panel or reopen the chat. A thumbnail
marked **Unavailable** means the stored copy is gone or has changed since the model saw it; **Too
large** means the image is too big to show in the panel, so open the file instead.

## In the terminal

The step's row says how many images it produced. Click it, or use `/expand`, to list them with their
size, and click `open` to hand one to your system's image viewer. DGC never opens a web browser for
this; without a display it shows where the file is instead. The classic `dgc` prompt prints one
`↳ image:` line per image with its path.

## What the model receives

- A model that accepts images gets them after the batch of tool calls that produced them. Text inside
  an image is treated as data, never as instructions.
- A model without vision never receives the pixels. When a vision model is configured (the sub-agent
  model, or a named agent's model), that model looks for it and its answer comes back as text, in a
  step that names it; see *Sub-agents* ▸ *Eyes for a model without vision*. With none, the model is
  told that an image exists, `view_image` is not offered to it, and you are told how to set one up.
- If an endpoint refuses an image, DGC sends the request again without it and stops sending images to
  that endpoint/model pair until the rejection cache expires (up to one hour) or DGC restarts.
  The cache is shared across chats in the same process.

## Where they are kept

Each session keeps a private copy of its images beside its transcript, in
`~/.dgc/sessions/<project>/<session>.images/`, readable only by you. A session's images take at most
256 MB, oldest removed first. They are deleted with the session and copied when you branch it. The
editor receives an image's name, size and source, never its path on disk. Screenshots are also saved
under `.dgc/screenshots/` in the project; that folder carries its own `.gitignore`, so they never show
up in `git status` or in the chat's changed files.
""".strip()),
    ("Turn ETA & notifications", "how long the turn still needs, and a ping when it is done", """
# Turn ETA & notifications

While a native turn runs, the status line shows a calibrated range for how much longer it
should take — `1m12s · ~2–4 min left · 3/5 tasks` — so you can decide whether to wait or walk
away. `/eta` says the same in a sentence with its basis and confidence; `/eta stats` shows how
often the range has held on this project.

## How the estimate is made

- **Your history.** Every finished turn on this project is recorded by what it asked for
  (explain · test · fix · add · refactor) and how long the prompt was. The estimate starts from
  the middle and 80th-percentile durations of similar turns — or DGC's built-in priors on a new
  project — and shifts as time passes, because a turn that has already run past the typical
  length is likelier to keep going.
- **The turn's own plan.** Once the model keeps a task list, remaining tasks × the pace of the
  tasks already finished takes over as the main signal. This is where the range gets sharp.
- **Honesty rules.** The range appears only after 20 seconds, may shrink freely but only grows
  when there is a reason, and drops to `~a few min left` instead of a number when confidence is
  low. Predicted-vs-actual is logged for every turn; the site only ever quotes coverage that was
  measured.

The estimate is per-project and private (`~/.dgc/eta-stats.json`, bounded). Turn it off with
`eta: false` in `config.json` or `/settings`. Subscription turns delegated to a vendor CLI have no
estimate: DGC does not see their steps.

## Walk away

- `/notify` during a turn pings you once when it finishes: a terminal notification where the
  terminal supports one (iTerm2, WezTerm, kitty, Windows Terminal, ConEmu), a bell everywhere,
  and a flash in the status line. `/notify` before a turn arms the next one.
- `/notify on` keeps it on for every turn over 20 seconds; `/notify off` turns it back off.
- In the editor, enable **DGC: Notify On Turn End** to get a toast when a turn finishes while
  the DGC panel is not visible.
- For anything else — a phone push, a sound, a script — use the **Stop** lifecycle hook, which
  already fires at the end of every turn (see *Lifecycle hooks*).
""".strip()),
    ("Background monitors", "watch a long-running command and hear about each line it prints", """
# Background monitors

Some work is a wait: a build that takes minutes, a test watcher, a dev server, a deploy log. A
monitor lets the agent start that command, carry on with something else, and hear about each line
the command prints, instead of polling it or sitting idle until it finishes.

## How it works

The agent starts one with the `monitor` tool: a shell command and a short label. Every line the
command prints to standard output becomes an event, and lines that arrive close together are
delivered as one event.

The tool is offered on every request under the standard (default) and full tool profiles. Under
`tool_profile: adaptive` it appears only when the request asks DGC to watch or wait for something
("watch the build log", "set a watcher", "tell me when the tests finish", "check back every 30
minutes"). Plan mode never offers it.

- **While a turn runs,** events reach the model between its tool calls.
- **When the chat is idle,** an event starts a short turn so the model can read it and act. The
  transcript marks that turn as started by a monitor, never as something you typed.
- Standard error is kept but creates no events; the model can read it with `bash_output`.
- A monitor ends when its command exits, when it is stopped, or when its timeout runs out: 5
  minutes by default, at most 1 hour. A persistent monitor runs until it is stopped or the chat ends.

Only the terminal UI and the editor offer monitors, because only they can start a turn on their
own. One-shot `dgc -p` runs and sub-agents cannot start one.

## Background commands

A command the agent runs with `bash` in background mode is not a monitor, but in the terminal and
the editor the model is told once when it exits, with its exit code and the last lines it printed,
so it does not have to keep checking.

## Seeing and stopping them

- **Terminal:** the status line shows running monitors and waiting events. `/monitors` lists
  them, `/monitors stop ID` or `/monitors stop all` stops them, and `/monitors show ID` prints a
  monitor's kept output.
- **Editor:** a Monitors row above the prompt shows each running monitor with a Stop button, and
  each event appears in the transcript as a card.
- The model can stop one itself with `monitor_stop`.

Monitors belong to one chat. They stop when that chat is replaced or closed (`/clear`, resuming
another session, a rewind, closing an agent in the terminal's agent list) and when DGC exits,
including when it is killed. In the editor `/new` replaces the chat, so its monitors stop too. In
the terminal `/new` opens another agent beside the current one: the earlier chat keeps its
monitors, and they can still wake it, until you switch back and stop them with `/monitors stop` or
close that agent.

## Wake-ups

- **On or off.** `monitor_wake` is on by default. Change it with `/monitors wake on|off`, with
  Settings → **Wake on monitor events** in the editor, or in `config.json`. When it is off, events
  wait for your next message.
- **Timing.** A wake waits until the chat has been idle for `monitor_wake_delay_s` (2 seconds) and
  leaves `monitor_wake_cooldown_s` (5 seconds) between one wake turn and the next.
- **Pauses.** After `monitor_max_consecutive_wakes` (10) wake turns in a row with no message from
  you, wake-ups pause until you send one. Stopping a wake turn pauses them too. `/monitors wake on`
  resumes them.
- **Plan mode** starts no wake turns; events wait for your next message.

## Limits and safety

- **Permissions.** Starting a monitor needs the same permission as `bash` and runs in the same
  sandbox; plan mode refuses it. A wake turn has nobody at the keyboard, so outside auto mode any
  step that would need your approval is not run. The model says what it wanted to do, and you can
  approve it with your next message.
- **Untrusted output.** Events reach the model labelled as command output, never as instructions.
- **Floods.** A command that prints more than 1,000 lines or 1 MiB within a minute is stopped, and
  the model is told which limit it hit. Lines are cut at 2,000 characters and an event shows at
  most 40 lines; the rest stays readable with `bash_output`.
- **How many.** At most 4 monitors run per chat, and 16 across one DGC process.
- **Your checkout.** A monitor, like a background command, holds the workspace lock only while it
  starts, so it never blocks edits or other commands. That also means it is not a way to change
  files: use it to watch, not to edit.
""".strip()),

    ("Sandbox", "confine native shell commands to the project", """
# Sandbox

`/sandbox on` runs native-loop spawned shell commands and lifecycle hooks inside the strongest
supported host boundary. It does **not** skip permission prompts, does not wrap structured file
tools (`read_file`, `edit_file`, …), and does not wrap a delegated subscription CLI.

- `/sandbox` — report the backend and whether it is on.
- `/sandbox on` · `/sandbox off`
- `/sandbox read-only` — the project is mounted read-only inside the sandbox and every file edit
  is denied (for review runs). `--sandbox on|off|read-only` sets it for one `dgc` launch.
- `/sandbox network on` — allow network from sandboxed commands. Off by default.

## Backends

- **Linux** — bubblewrap (`bwrap`). The project is the only persistent writable host path for
  those commands. Ambient user state is masked. Home, temporary, runtime, process, and network
  namespaces are private.
- **macOS** — `sandbox-exec`. Ambient-home reads outside the project are denied; host writes
  except the project and shared system temporary paths are denied. Temporary and process
  namespaces are not private.
- **Anything else** — fail closed. DGC will not pretend a requested sandbox is on.

`sandbox_env_allow` in `config.json` is the list of extra environment variable names to pass
through. Other non-baseline host variables are withheld; DGC still supplies a small safe
baseline plus sandbox-specific home, temporary, and runtime paths.

The Python code-action is not covered by `/sandbox`. MCP server processes start unsandboxed in
the workspace — treat a configured server command as a trusted executable.
""".strip()),

    ("Worktrees", "fleet, named, and delegated checkouts", """
# Worktrees

In a Git project DGC can isolate concurrent work so two agents do not fight over the same files.
There are three kinds.

## Fleet

The launch agent stays in the checkout you selected. Every additional interactive agent
(Ctrl+N) gets an owner-private `dgc/fleet-*` worktree with the source checkout's exact tracked
and non-ignored untracked baseline. Each checkout has its own crash-safe mutation lease, so
fleet writes can proceed concurrently.

Closing an untouched managed checkout removes it. Changed, committed, uncertain, or still-running
work is retained with its visible branch and path. Reopening that saved conversation validates
and reattaches to the same checkout. Non-Git projects say when they fall back to serialized
shared-checkout writes.

`fleet_worktree_root` (empty = `~/.dgc/fleet-worktrees`) must sit outside the source repository.

## Named

`/worktree <name>` creates or switches to a deliberately named long-lived branch. Use it when
you want a checkout you will keep, not an automatic fleet one. `/worktree` with no name lists
them.

## Delegated `task`

A sub-agent in a Git project gets its own short-lived private checkout, populated with the
caller's tracked and non-ignored untracked state. DGC applies only a completed child's
conflict-free delta. It never auto-overwrites a path that was already dirty. Conflicting or
incomplete work is retained with a visible path and branch.

`/tasks` lists retained work. `/tasks apply ID` recomputes the delta, rejects paths that were
dirty before delegation or changed in the parent, and adds an applied result to `/rewind`.
`/tasks drop ID --confirm` permanently removes the isolated checkout. The editor's command
palette exposes the same typed recovery.

`subagent_worktree_root` (empty = `~/.dgc/worktrees`) must sit outside the source repository.

See **Multiple agents** for the dashboard, and **Sub-agents** for named specialists and
background tasks.
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

    ("Reconnecting", "what DGC does when a model request fails, is refused as busy, or is cut off", """
# Reconnecting

Local servers restart, laptops change networks, hosted APIs get busy. When a model request fails in a
way that is worth another try, DGC tries again, and says in one line of the conversation what went
wrong and whether trying again worked.

## What DGC tries again

- **The connection failed**: refused, a name that does not resolve, TLS, a proxy, a reset, or a
  timeout while connecting.
- **The server is busy or failed**: 429 and overloaded answers, and 5xx errors. A `Retry-After` the
  server sends is respected, up to 10 seconds.

These are sent again up to three more times, with a short backoff between tries.

- **The answer was cut off**: the stream ended before the provider's end-of-answer event. DGC keeps
  what already arrived and asks the model to continue exactly where it stopped, after a backoff that
  starts at 0.25 seconds and doubles up to 8 seconds, at most eight times in a turn. That request is
  marked in the transcript so it is never shown as something you typed.
- **The model went quiet**: the stall watcher keeps its own wording, *No response from the model*.

A wrong key, a model the server does not have, or another answer that will not change on a second
try is not retried. The error says what failed and what to check.

## In the editor

A muted line inside the turn follows each run of tries and changes in place:

- *Reconnecting 1/3 · connection refused by 127.0.0.1:11434*
- *Server is busy, retrying 2/3* or *Server error, retrying 1/3*
- then *Reconnected after 1 retry*, *Recovered after 2 retries*, *Reconnected · continued from the
  partial answer*, *Gave up after 3 retries* or *Stopped while reconnecting*.

Click the line for the details: the cause, the model and API, the endpoint, the HTTP status, each
attempt and how long DGC waited before it, the transport's own message, and a hint. **Copy details**
copies them. While DGC waits, the activity row says *Waiting to reconnect*, *Server is busy* or
*Server error*, with the host, the backoff and the try count. A line from a sub-agent starts with
*Sub-agent*, and one from a subscription engine with the engine's name.

If DGC gives up, the error row leads with what failed, for example *Could not reach the model ·
connection refused*, shows the hint underneath, and keeps the full message behind its chevron.

When the extension restarts DGC's own backend, the activity row says *Restarting the DGC backend*, so
it is never confused with a model reconnect.

## In the terminal

The same run is one collapsible block: `↻ ▸ Reconnecting 2/3 · connection refused by …`. Click it, or
use `/expand` (`/expandall` opens every one), to read the details. `dgc -p` and the classic prompt print
one line per try, such as `↻ HTTP 503 from 127.0.0.1:8080 — retrying (1/3) in 0.5s`, and one when it
works.

## Privacy

Causes, endpoints and details never carry credentials: DGC removes a `user:password@` part, the query
string and the fragment from every URL it shows or saves, and redacts known secret values.
""".strip()),

    ("Thinking & reasoning", "off · low · medium · high · xhigh, and preserving it", """
# Thinking & reasoning

DGC exposes one thinking dial, mapped to the correct wire format **per provider**.

## Levels

`off` · `low` · `medium` · `high` · `xhigh`. `off` is the default — a coding agent
uses model-specific controls and adds instructions appropriate to each profile. `xhigh` requests
the strongest supported tier; it cannot add a native tier a model does not offer.

- `/think` — cycle, or `/think high` to set a level (persisted across restarts).
- With thinking **Off**, a prompt containing `think`, `think hard`, `think harder` or
  `ultrathink` turns it on for that turn (Low, Medium, High, High). A level you set (Low through
  Extra high, or Ultra) is never changed by words in a prompt.
- `--think <level>` — set it for one `dgc -p` run.
- TUI: `/think` opens a picker; **Settings → General → Thinking**.
- Editor: the composer thinking control and Settings → General → Thinking are the same dial.
  You can change it while a turn runs; the next model round uses the new level.

Native controls differ:

- **Ollama thinking models** (native `/api/chat` and `/v1` alike): Off sends thinking off; Low,
  Medium and High are sent as Ollama's own levels and Extra High as Max. A model that grades its
  thinking follows them (GLM 5.3 on Ollama's cloud thinks far less at Low); one that does not
  treats every level as on. An older Ollama that takes only on/off for a model refuses a level
  once; DGC then sends on/off for that model (and High instead of Max where Max is refused)
  without losing the Off switch. The editor's reasoning note says which of these applies.
- **GPT-OSS on Ollama:** Low, Medium and High; Off uses Low and Extra High uses High (it has no
  tier above High).
- **GLM 5 on Ollama** (for example `glm-5.3:cloud`): it keeps reasoning with thinking off and
  writes that reasoning into the answer, so Off uses Low; Low, Medium and High are its levels and
  Extra High uses Max.
- **GLM 5.3 Flash on Ollama:** reasoning is always on. Off/Low use Low, Medium/High use High,
  and Extra High/Ultra use Max, on both native and compatible transports.
- Other providers use their supported effort fields or budgets. Unsupported controls are negotiated
  away after a precise rejection; a model without reasoning support gets DGC instructions only.

## Reasoning watchdog

A model that reasons without ever answering is stopped and asked again one level lower.
`think_budget_tokens` (default `auto`) sets how far it may go. `auto` scales with the level, and
every level allows at least the thinking budget DGC asks the provider for. Reasoning allowed
before any answer:

- Off and Low: 8,000 tokens.
- Medium: 16,000 tokens.
- High: 32,000 tokens.
- Extra high (and Ultra): 64,000 tokens.

A number applies to every level instead, and `0` turns the watchdog off. A stored `8000`, the
old default, is read as `auto`.

Reasoning counts against the output cap on most providers, so a request that asks for reasoning
may produce `max_tokens` (default 16384) of answer plus that level's allowance. The cap never
exceeds the model's reported output limit or half the context window, so a 32K window keeps the
16,384 cap and Extra high needs a window of about 160K to use its full 64,000.

## Ultra

`/ultra on` is an orchestration profile, not a sixth thinking level. It raises native effort to
`xhigh` (or leaves it if you already set that), tells delegated CLIs their strongest supported
effort, and makes the main agent a lead: it locates each part of the request, gives every part
that changes different files its own worker (or an explorer for an area to map) in one parallel
batch — up to `max_parallel_tasks` (default 4, at most 8; concurrent in auto mode) — then
integrates and runs the tests. A sub-agent starts cold, so it only saves time beside others: a
single part, parts that share files or one investigation, and edits the lead already knows stay
with the lead. Critic reviews a change when you ask for a review or when no test can check it.
Long work that does not block the rest of the turn can use `task` with `background: true`; DGC
starts a wake turn when that child lands.

- `/ultra` · `/ultra on|off` — toggle; the status line shows the profile while it is on.
- `--ultra` / `--no-ultra` — the same for one `dgc` launch.
- Settings → Behaviour (terminal) or General (editor).

Permission mode is unchanged: Ultra does not grant extra filesystem, shell, or network authority.
It does not invent a vendor enum named "ultra". Coupled edits stay serial; the parent still has
to reconcile child results. A stronger profile can take longer and use more tokens; it does not
guarantee better answers. The editor's picker and General settings explain the native control for
the selected model.

## Showing thinking

`show_reasoning` (`/thoughts show|hide`) controls whether the model's thinking is
shown, muted, in the transcript. It does **not** change how hard the model reasons —
that is `/think`.

## Where thinking came from

Not every provider hands back the model's own reasoning. Some return a summary written
from it, and some send nothing readable at all. Every block of thinking DGC shows says
which, in a muted label after its header:

| Label | What it is |
| --- | --- |
| `Thought for 4s · raw` | The model's own reasoning, as a runtime serving open weights streamed it (Ollama, or llama.cpp, vLLM or LM Studio on your machine or network) |
| `Thought for 4s · summarized by Anthropic` | The provider returned a summary; the full reasoning is not available. OpenAI's reasoning summaries read `summarized by OpenAI` |
| `Thought for 4s · hidden by OpenAI` | The provider kept the reasoning hidden and sent no readable text, so there is nothing to open |
| `Thought for 4s` | DGC cannot tell whether this is the model's own reasoning or a summary |

DGC decides from the endpoint's host, the API it speaks and the model, never from the name
of an event. A local or private host — `localhost`, a LAN address, a `.local` or Tailscale
name — is never labelled as summarized or hidden by a provider. Thinking from a sub-agent
is marked *Sub-agent* before its label. Hover a label in the editor for the same explanation
in a sentence.

## Short summaries inline

A short provider summary written between tool calls reads better as a line of the answer
than as another fold, so it is shown inline, muted and marked `· summarized`. Raw thinking,
thinking DGC cannot place, and anything from a sub-agent always stay collapsed.

- `/thoughts inline` (the default) shows short summaries inline; `/thoughts collapsed` folds
  every block. Both also turn thinking on. In the editor, **Settings → General → Show model
  thinking** offers inline, collapsed and hidden.
- `thinking_inline_max_chars` (default 280, at most 1000) is the longest summary shown inline;
  a summary with a code block or more than four lines stays collapsed, and `0` keeps every
  summary collapsed.

Thinking is saved with the session within fixed bounds, so a resumed chat shows the same
blocks and labels. A block that was cut to fit says so when you open it.

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

    ("Token usage", "tokens and requests counted on this machine, by model and day", """
# Token usage

DGC keeps a small local record of what every model request cost in tokens, so you can see which
models you lean on and how much, without trusting a dashboard somewhere else. It covers every
provider DGC talks to: a local Ollama or llama.cpp server, an OpenAI-compatible host, Anthropic,
and so on.

## Where to see it

- **In the editor:** Settings → **Token Usage**. Pick a range (Today, 7 days, 30 days, This month
  or All time) to see input, output and cached-input totals, the request count, a table by model
  with each one's share, and a day-by-day strip for input and output.
- **In the terminal:** `/usage` inside DGC, or `dgc usage` from the shell. Both take a range:
  `dgc usage --range 30d`. Add `--json` for a machine-readable report.

Days follow this computer's local time, and the report says which time zone it used.

## What is counted

One row is recorded for each model request that finished, with the numbers the provider itself
reported: input tokens, output tokens and cached input tokens. Each row notes which route sent it:
your conversation, a sub-agent, the fallback model, or context compaction. A sub-agent's requests
are counted once, as its own.

- **Unmetered requests.** A request the provider accepted but that ended without a usage report
  (you cancelled it, the stream broke, or a stalled attempt was retried) is still counted as a
  request, marked unmetered, because it may have cost tokens nobody reported. Its tokens are not in
  the totals, and the report says so when there are any.
- **Reported zero.** An explicit zero-token report is metered; it is distinct from a missing report.
- **Consistent views.** Totals, the top 100 model rows and daily bars use one database snapshot, even
  when another DGC process records usage at the same time.
- **OpenAI-compatible endpoints.** DGC asks these to include usage in the stream. An endpoint that
  rejects the request is asked again without it and is not asked again until DGC restarts (the
  editor's backend keeps that memory across every chat it runs).
  Its requests then show as unmetered rather than as zero tokens.
- **Not counted:** turns delegated to a subscription CLI (Claude Code, Codex and the others) run in
  the vendor's own tool, so DGC never sees their token counts.

## Privacy

Everything stays on this machine, in `~/.dgc/usage.sqlite` (readable only by you). No prompt or
reply text is stored, and an endpoint is recorded by host and port only, never its full address,
path or any credential. Rows older than 400 days are removed automatically. To start over, quit
DGC and your editor first (a running DGC keeps the file open and would go on counting into the
deleted copy), then delete `usage.sqlite` together with its `usage.sqlite-wal` and
`usage.sqlite-shm` companions; DGC creates a new one the next time it runs.
""".strip()),

    ("Web search", "DuckDuckGo by default; Brave, Tavily, or SearXNG if you set them", """
# Web search

The native agent gets a `web_search` tool when the request needs current information (versions,
docs, news, facts). It returns titles, URLs and snippets; `web_fetch` then reads a result URL as
text. A live page that has to run JavaScript is **Looking at a page**, not this.

DuckDuckGo is the keyless default. `dgc setup` or `/search` picks another backend.

- `/search` — show the current provider.
- `/search duckduckgo` — keyless, and tried three ways in order: the `ddgs` client DGC ships
  with, then DuckDuckGo's HTML endpoint, then its lite endpoint. The first one that returns
  results answers; only if all three come back empty do you see an error.
- `/search brave` · `/search tavily` — prompts for an API key (masked). The value lives in
  `~/.dgc/secrets.json` or `DGC_SEARCH_API_KEY`, never in `config.json`.
- `/search searxng <url>` — a self-hosted instance. `search_url` in config is that base URL.

`search_timeout` bounds the request (1–60 seconds). Queries leave this machine for the chosen
provider; treat that like any other web request.

The standard (default) and full tool profiles offer `web_search` every turn; `tool_profile:
adaptive` offers it when the prompt is about looking something up. Plan mode allows it.
Subscription CLIs use their own search, not DGC's.
""".strip()),
    ("Subscriptions", "bring your own Claude / Codex / Qwen / Kimi / Copilot plan", """
# Subscriptions

Instead of a raw model endpoint, DGC can drive a coding CLI you already pay for and
are logged into — from the full-screen app, the classic inline REPL (`dgc --classic`),
the editor/headless backend, or a one-shot `dgc -p --engine` run. Every route renders
the vendor's stream the same way: its tool steps as cards with their diffs, its
reasoning dimmed, and its answer as it arrives.

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
- `mode`, `thinking` — permission mode and reasoning effort. Thinking is **`off` by default**;
  accepts `off · low · medium · high · xhigh`. DGC maps levels to provider controls:
  reasoning-only models may use minimum effort for `off`, unsupported endpoints may ignore it,
  and Qwen3-family llama.cpp/unsloth templates receive `chat_template_kwargs`.
  **Reasoning models (o-series, DeepSeek-R1, qwen-thinking) may benefit from `/think high`
  on hard tasks.** See **Thinking & reasoning**.
- `show_reasoning`, `preserve_thinking` — `show_reasoning` (`/thoughts show|hide`)
  shows the model's thinking, muted, in the transcript. `preserve_thinking`
  (`/preserve-thinking on|off`, default off) re-embeds the prior turn's reasoning in
  the context sent back so a compatible/local model keeps its own thinking across
  turns (costs tokens; only the OpenAI-compatible/chat_completions path — Anthropic and
  Ollama already round-trip their reasoning natively).
- `thinking_inline`, `thinking_inline_max_chars` — show a short provider summary of the
  model's thinking inline instead of folded (default on, `/thoughts inline|collapsed`), up to
  `thinking_inline_max_chars` characters (default 280, 0-1000). See **Thinking & reasoning**.
- `think_budget_tokens`, `max_tokens` — safety backstops: a reasoning phase that
  runs away with no output is aborted + retried with less reasoning
  (`think_budget_tokens`, default `auto`: 8,000 tokens at Off/Low, 16,000 at Medium, 32,000 at
  High, 64,000 at Extra high/Ultra; a number applies to every level, 0=off); output is capped at
  `max_tokens` plus the level's reasoning allowance when reasoning is on, within the model's
  output limit and half the context window (length-truncation auto-continues, 0=don't send).
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
- `context_size` — requested operating window. Known models receive memory-conscious defaults;
  provider metadata clamps impossible values without silently expanding local Ollama allocations.
  Sessions compact at `compact_threshold` of the effective window. Changes apply to the next
  request, even during a turn. Editor settings saves wait only when changing an execution route:
  provider, model, sandbox, or delegation engine.
- `search_timeout` — bounded 1–60 second lifetime for internal `grep`/`glob` discovery. DGC uses
  ripgrep without a shell when available and a link-safe bounded fallback otherwise.
- `session_redaction` — on by default. Adds credential redaction to saved transcripts, checkpoint
  conversations, goals, titles, and plans. Live native-provider/tool and editor/headless/ACP
  masking is always enforced. TUI and one-shot subscription streams retain vendor output after
  terminal-control cleanup; treat it as sensitive. File rewind snapshots stay byte-for-byte
  intact in the owner-private session, preserving exact `/rewind` restoration.
- `tool_profile` — `standard` (default) offers every product tool on every request and lets the
  model decide (about 3,300 tokens of tool schema, cached by the provider between turns).
  `adaptive` offers core coding tools always and adds web, artifact, skill-install, memory,
  delegation and background-monitor tools only when the request's wording asks for them — about
  1,500 tokens of schema for a small local context window, at the cost of a differently worded ask
  being refused. `full` also drops the state-based filters and offers every tool on every model
  request. Releases through 0.41.7 wrote their `adaptive` default into every config, so the first
  load after upgrading reads a stored `adaptive` as `standard`, once. Choosing `adaptive` yourself
  afterwards — `/set tool_profile adaptive` in the terminal, or the editor's settings — is kept.
- `code_action` — **off by default.** Opt in to the `python` tool: arbitrary code in a
  **persistent per-session interpreter**, retaining variables/imports across calls. Approval follows
  `bash` (asked in default/acceptEdits, denied in plan). It has no `/sandbox`, checkpoints, or
  mutation tracking for verifier reuse. See **Python code-action**.
- `theme`, `background` — appearance. `background` defaults to **inherit**, keeping
  your terminal's own canvas. `/bg light` (also `/bg white`) sets a white canvas with
  dark text; `/bg dark` sets a dark canvas with light text. Both apply immediately
  in the TUI and classic CLI, and restore the terminal's defaults on exit.
  `/bg inherit` restores the host colors immediately. `/bg auto` takes effect on
  the next launch and darkens a light terminal. The same choices are in
  **Settings → Display → Background**. `/theme auto|dark|light` chooses the text
  palette; when a background is forced, it follows that choice to stay readable.
- `suggest` — ghost-text next-prompt suggestions (Tab/→ to accept). Auxiliary title/suggestion
  requests wait for fleet-wide idle time and are canceled before foreground work;
  `aux_idle_delay_ms` controls the grace period.
- `mcp_servers`, `hooks`, `fallback_model`, `subagent_model` — extend the agent. When a fallback or
  sub-agent uses another endpoint, its transport is inferred independently instead of inheriting a
  forced main-provider mode; set `fallback_api_mode` or `subagent_api_mode` only to override that.
  Lifecycle-hook batches are capped at 32 entries and one 20-second deadline, drain only a bounded
  redacted head/tail, own a process group and checkout mutation lease, and honor `/sandbox`.
- `subagent_context_size` — each sub-agent's context window in tokens, as `context_size` is the main
  model's (0, the default, uses the main window). A named agent's own `context_size:` frontmatter
  wins. `/subagent context 64k` sets it; so does Settings → Agents in the editor. The sub-agent
  route (`subagent_model`, host, transport, key, window) may change mid-turn: it applies from the
  next sub-agent, as a new main model applies from the next request.
- `subagent_worktree_root` — optional private storage for automatic delegated checkouts; empty uses
  `~/.dgc/worktrees`. It must be outside the source repository.
- `fleet_worktree_root` — optional private storage for automatically isolated TUI agents; empty uses
  `~/.dgc/fleet-worktrees`. Conversation resume state remains scoped to the source project, and
  changed managed checkouts are retained rather than force-removed.
- `max_parallel_tasks` — bounded `task` fan-out (default 4, maximum 8; set 1 to disable). In a
  Git-backed full-auto turn, two or more independent `task` calls emitted together are snapshotted
  from one parent baseline, run concurrently, and integrated in call order. Hooks, interactive
  permission modes, mixed tool batches, and non-Git projects keep the normal serial path.
- `language_servers`, `code_intel_timeout`, `code_intel_lsp_idle_s` — optional stdio LSP commands
  for definitions, references, symbols, and diagnostics. Key by language (`python`) or extension (`.py`):
  `{"language_servers":{"python":{"command":"pyright-langserver","args":["--stdio"]}}}`.
  The bounded dependency-free static analyzer works without LSP. Servers use a minimal environment,
  no shell, and serialized requests per project/server spec. At most four sessions stay warm
  (default 120 seconds); idle and failed sessions retire. Approved external-file queries always
  run one-shot. Set `code_intel_lsp_idle_s` to `0` for one-shot isolation everywhere.

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
- `request_timeout` (default `1800`) — hard ceiling on socket silence, including the wait for
  response headers; an active response can take longer overall. The stall watcher below
  normally acts first.
- `model_first_token_timeout_s` (default `auto`) — how long a request may produce nothing (no
  headers, a silent stream, or keep-alives with no tokens) before it counts as stalled. `auto` is
  `900` for a local endpoint (loopback, private or Tailscale addresses, `*.local`, or an
  Ollama/llama.cpp/LM Studio/vLLM server: room for a model load and a large prefill) and `300`
  for a remote one — including an Ollama cloud model (`…:cloud`, `…-cloud`) reached through a
  local Ollama, which is remote work. Streamed reasoning counts as progress. `0` turns it off.
- `model_idle_timeout_s` (default `300`) — how long a stream may go silent after it started.
  A stall after partial output continues from what already streamed. `0` turns it off.
- `model_stall_notice_s` (default `45`) — when to say "No response from the model" (with the model
  and host) in the status line and the editor. `0` never shows it.
- `model_stall_retries` (default `2`) — how many times a stalled request is re-issued. After that
  DGC switches to `fallback_model` when one is set, or fails the turn with a message naming the
  model and endpoint. Esc / Stop works in every phase, including before any response headers.
- `model_load_timeout_s` (default `900`, self-hosted Ollama only) — while `/api/ps` shows the
  model still loading, the first-token clock is paused ("Loading the model") for up to this long.
  Ollama cloud models never load locally and are never probed.
- `bash_timeout` (default `120`) — per-command shell timeout.
- `approval_timeout_s` (default `300`) — how long a permission prompt waits before giving up.
- `ollama_keep_alive` (default `30m`) — how long Ollama keeps the model resident between turns.
- `prompt_cache_key` — an explicit cache key for providers that support prompt caching.

## Web search

- `search_provider` (default `duckduckgo`) — which backend answers the agent's web searches.
  DuckDuckGo needs no key: it uses the bundled `ddgs` client, falling back to DGC's own HTML and
  lite parsing.
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
  bind address. The server also accepts requests addressed to this name (a reverse proxy, a
  Codespaces or other forwarded URL, or a Tailscale MagicDNS name); requests for any other unknown
  host are refused. A running server picks up a changed value the next time an artifact is served,
  the bind mode is switched, or `dgc` starts.
- `plan_artifact` (default `true`) — render proposed plans as an artifact page.
- `artifact_in_plan` (default `false`) — also serve artifacts while in plan mode.

## Native-route unattended runs

- `autonomous_gate` — a check command that must exit `0` before a native local/API agent may stop a turn.
- `autonomous_max_turns` (default `30`) — bound on failed gate retries.
- `verify_before_done` (default `false`) and `verify_command` — run a command and feed a failure
  back before allowing a native local/API turn to end. Passing a check normally returns its
  result to the model so it can finish other requested work and selected skill steps.
- `finish_on_verified` (default `false`) — opt in only when the configured verifier defines the
  entire task. In timed native `auto` runs with `verify_before_done` and `verify_command`, a green
  check can end the turn without another model request. Active goals, explicit skills and unfinished
  todos always retain normal completion. Leave this off for ordinary multi-step work.

Subscription turns are delegated to the selected vendor CLI and bypass these two native-loop gates.

The autonomous-gate pair has command-line equivalents; see **Command line**. The verifier pair is
configured in `config.json`.

## Subscriptions

- `subscription_engine` — which vendor CLI drives the turn.
- `subscription_model`, `subscription_effort` — model and effort passed through to that CLI.

## Turns

- `eta` (default `true`) — show the calibrated "~2–4 min left" range while a turn runs.
- `notify` (default `off`) — `on` pings after every turn over 20 seconds; `/notify` arms a single one.

## Files pane

- `mouse` (default `capture`) — `capture` lets the wheel scroll DGC and rows respond to clicks;
  `off` leaves the mouse to your terminal so drag-select works. `/select` toggles it for one
  session; `/mouse on|off` changes this setting.
- `recall_max_bytes` (default `524288`) — how much earlier conversation `/recall` keeps per
  session after compaction, oldest turns dropped first.
- `trash_mode` (default `dgc`) — where `/files` sends deleted entries: `dgc` keeps them in
  `~/.dgc/trash` for 30 days (undo with **u**), `os` uses the system trash (freedesktop layout on
  Linux, `~/.Trash` on macOS; other platforms fall back to `dgc`).

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
