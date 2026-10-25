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

### On Windows

DGC is a Linux and macOS program; on Windows it runs inside WSL (Windows Subsystem for Linux).

- **In VS Code or Cursor on Windows**, with your folders on `C:\\`: install the DGC extension and
  open DGC. The first time, it sets up a small Linux system of its own. If WSL is off, it asks to
  turn it on (Windows asks for administrator permission, then wants a restart). Then **Set up DGC
  on Windows?** downloads Ubuntu 24.04 as a WSL distro named `DGC`, prepares it and installs DGC
  in it, in a few minutes; your own distros are not touched. From then on every chat runs there:
  your Windows folders are `/mnt/c/...` to DGC, and the editor shows them as Windows paths. Pips,
  their computers and your signed-in Chrome work as they do in WSL (below). A model you serve on
  Windows itself (Ollama or LM Studio on `localhost`) is reached through Windows, since WSL's
  `localhost` isn't Windows' own. Settings:
  `dgc.windows.wslDistro` names the distro; `dgc.windows.useWsl` off, with `dgc.command` set to it,
  runs a DGC you installed on Windows yourself instead.
- **In WSL yourself** (a WSL terminal, or VS Code connected to WSL): install with the command
  above inside your distro, as on Linux.

## First launch

```
dgc
```

DGC starts on its defaults — a local Ollama at `http://localhost:11434/v1` — and
does not interrupt you with a questionnaire. If that is where your model lives,
the first run just works. If it is not, the first turn says so: the endpoint or
the model name comes back in the error, with the command that fixes it.

To choose deliberately instead:

- `dgc setup` — walk through providers and models once, before you start.
- `/connect` — pick a provider (Ollama, LM Studio, OpenAI, OpenRouter, …) or a
  custom LAN host, at any point.
- `/model` — switch the model on the current host.
- `dgc doctor` — check the endpoint is reachable and the model is offered. It
  exits non-zero when the endpoint cannot be reached, so a script can gate on
  it. A model the server does not list is a warning, not a failure: a proxy may
  serve one it does not advertise, so that exits 0 and says so.

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
- **Enter** — send · **Ctrl+J** — newline. Shift+Enter inserts one too, but only in a terminal that reports it separately (kitty's keyboard protocol, or `modifyOtherKeys`); most send the same byte for Enter and Shift+Enter, so there it sends the message.
- **Shift+Tab** — cycle permission mode (default → acceptEdits → plan → auto)
- **/** — command palette · **@path** — attach one exact bounded file (`@"path with spaces"`)
- **! command** — run a bounded direct shell command · **# note** — atomically save project memory
- **/memory add TEXT** — save project memory · **/memory add user TEXT** — save personal memory
- **Ctrl+R** — recall a past prompt · **Tab / →** — accept the ghost suggestion
- **Ctrl+Y** — copy the last reply to your clipboard (works mid-turn) · **/copy code** — its code block
- **Paste** — a tall paste folds to a chip, a lone URL becomes a pill, and characters you cannot
  see are counted. See **Pasted text**.

## This turn
- **Esc** — stop the turn · **Ctrl+C** — cancel · clear draft · quit
- **Enter** — steer native work at the next model/tool boundary; subscription follow-ups queue
- **Tab** — queue a separate turn while working, outside menus and completion
- **/skills** and **/skills show NAME** — browse the current catalog without stopping work
- **/mode MODE** — change native permission decisions during work; explicit ask/deny rules remain

Unconsumed terminal follow-ups remain queued after interruption; a new prompt continues the queue.
In the editor, Enter steers and **Alt+Enter** or **Queue** submits a later turn. Unapplied steering
can be restored to the draft. Subscription CLI mode changes apply to the next launched turn.
A queued message ("you · queued") has **Steer now**: it goes into the running turn the way Enter
does, and the model reads it at its next step instead of after the turn. **Steer all**, beside
"N queued", sends every one. A turn that can't take it says so, and the message stays queued.

In the editor, from five prompts a **prompt rail** sits in the transcript's right margin: a tick per
prompt, the one you're reading bright. Hover it for every prompt with its time and click one to go
there, or press **Alt+↑ / Alt+↓** for the prompt before or after, from the message box too.

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
**/mouse off** remembers that choice. **Shift+drag** (**Option+drag** on some terminals) selects
without leaving scroll mode at all, where the terminal passes the modifier through.

## Session
- **Ctrl+N** — new session · **/resume** — reopen a past one · **/name** — rename
- **/new DIR** — an agent in another folder (see *Multiple agents*)
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
  `dgc -p -` reads the whole prompt from stdin.

**What a one-shot run cannot do.** `-p` has nobody at the keyboard, so everything that waits for a
person is unavailable and the model is told so rather than left hanging: no plan-approval card
(plan mode still applies — the model writes the plan into its reply instead of calling
`present_plan`), no options picker, no background monitors, and `@path` in the prompt text is
ordinary text, not an attachment — the composer is what turns `@` into a bounded file, so pass the
file another way. Permission prompts do not appear either: a tool that would ask is denied, with
the `--allow-tool` rule that would have permitted it. A background sub-task started here is
waited for only if the model calls `wait_tasks`; one still running when the turn ends is stopped,
and the work in its own checkout is kept for `/tasks`. An artifact or document server started here
dies when the command exits, so its URL is only good while the run lasts. Only a pipe or a redirected file is read — a
  terminal, `/dev/null`, and an fd inherited from a launcher (a supervisor, an editor) are left
  alone, so `-p` never waits on input nobody is going to send. A `-p` run never waits on a menu: a tool
  that would ask is denied with the rule to pre-approve, a plan is reported, not executed.
- `--add-dir PATH` — let this run read and edit files under PATH too (repeatable).
- `--allow-tool RULE` — pre-approve a tool for this run, e.g. `"Bash(npm test)"` or `Edit`
  (repeatable; never saved).
- `--sandbox on|off|read-only` — confine shell commands for this run; `read-only` mounts
  the project read-only inside the sandbox and denies every file edit, for review runs. Any
  setting but `off` also denies the `python` tool: the persistent interpreter runs outside the OS
  sandbox, so leaving it available would keep exactly one tool that can write anywhere the
  sandbox just masked. `/sandbox` does the same thing inside a session.
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
- `dgc ps [--json]` — every DGC running on this computer: each editor window's backend, one
  running a session with no window (and for how long), a terminal DGC; what each is doing, its
  sessions and folders. See **In your editor → A session keeps running through a reload**.
- `dgc stop PID|SESSION|--windowless [--force]` — save and stop one: by pid from `dgc ps`, by
  session id, or every backend running with no window. It asks the process over its own socket
  (it saves first), then sends SIGTERM (it saves then too); `--force` ends one that will not stop,
  and loses what it had not saved.
- `dgc acp` — Agent Client Protocol JSON-RPC over stdio (Zed, Neovim, and other ACP
  clients). Prompt blocks, text and images are bounded; embedded resources are untrusted data.
- `dgc mcp ...` — the same MCP catalog as `/mcp`, outside a chat. See **MCP servers**.
- `dgc skills ...` — list, create, install, enable, disable, or show a skill package.
  See **Skills**.
- `dgc plugin list|search TEXT|install NAME|sign-in NAME|key NAME [--remove]|uninstall NAME|installed` — the
  plugin directory without the editor (`key` saves a plugin's key, typed at a hidden prompt or piped in); `dgc plugin marketplace list|add SOURCE|remove NAME|refresh NAME`
  manages catalogs. See **Plugins, apps and MCP**.
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

## Mode belongs to the chat

Each chat keeps its own mode, so a risky refactor can sit in **default** while a scratch chat
beside it runs **auto**. Choosing a mode also makes it the default for chats you start
afterwards; it never moves a chat that is already open, in this window or another one.
Reopening a session brings back the mode it ran in when that mode asks no less than the one you
are in: a chat that was planning comes back planning, and one that ran in **auto** comes back in
**auto** when **auto** is your mode. It is checked again rather than trusted from the file:
**acceptEdits** and **auto** only while that folder is still trusted. A mode you name for the run
wins (`dgc --mode plan --continue` runs in **plan**), and a new chat after a reopened one starts
in the mode the reopened chat replaced.

In a folder you have not trusted, **acceptEdits** and **auto** start as **default**, for that
session only — your stored default is left as it was. Approving a plan into **auto** there runs
it in **default** and says why. Trust the folder to change that; the editor asks when you pick a
mode that needs it.

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

    ("Produced files", "the agent shows you a file it made, as a chip you can click", """
# Produced files

When the agent makes something you asked to see — a screen recording, a screenshot,
an exported report, a zip — it shows you the file itself rather than describing it.
The file appears **as a chip under the step that produced it**. Click it and the file
opens in the editor.

- The chip carries the file's **name, size and kind mark** — the same mark a file
  named in an answer wears, so a produced `.py` and a mentioned `.py` read alike.
- **Nothing is copied into the conversation.** The chip carries a path, so a 300 MB
  recording costs exactly what a one-line report costs, and the file never passes
  through the model's context.
- There is **no download button**, because the file is already on your machine. The
  chip opens it where you would edit it.
- At most **8 chips per step**, so one turn cannot bury the transcript.

## How the agent does it

The agent calls `show_file` with a workspace path and an optional caption:

```
show_file(path="out/demo.mp4", caption="the recording")
```

It is a way to show YOU a file, not a way for the model to read one — `read_file`
and `view_image` do that. Because it never reads the file, size is irrelevant to it.

`show_file` refuses, with a reason the agent can act on, when the path does not
exist, names a directory, or sits outside the workspace — so you never get a chip
that opens nothing.

## In the terminal

The terminal has no chips, so it prints each file's path and size instead. The agent
is told the same thing either way: you can see the file.

## If you do not see chips

Chips need an extension new enough to render them; DGC negotiates this at startup
and simply omits them for an older panel rather than sending something it cannot
draw. Update the extension to get them back.
""" ),
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

    ("Plugins, apps and MCP",
     "install a plugin, connect an app, and what a connector brokers",
     """
# Plugins, apps and MCP

A **plugin** is a package you install into DGC: skills, an MCP server, or both. An **app** is a
third-party service one of those servers reaches — GitHub, Notion, Linear, Sentry, Supabase, Stripe.
**MCP** is the wire underneath: every tool a plugin adds arrives as `mcp__<server>__<tool>`, and
**MCP servers** covers the protocol, the remote bridge and the execution boundaries.

Nothing is installed until you install it, and nothing reaches a service until you sign in to it.
Two first-party packages — default templates and plugin management — ship inside DGC, so installing
those fetches nothing.

## Where they live

The editor owns the browsing surface. **Settings ▸ Plugins** has three lanes:

- **Plugins** — what is installed, with its state: *Installed*, *Setup required*, or *Connected*.
- **Apps** — the individual services those packages reach, each naming the plugin behind it.
- **MCPs** — the servers themselves, the same catalog as `/mcp`.

**Browse directory** opens the curated catalog. Every entry names its licence and, separately, what
DGC actually *verified* — which is often less than "it works": a package whose structure was checked
but whose authenticated tools were never exercised says exactly that. **Manage marketplaces** adds
another catalog, and the filter separates DGC curated from Personal and from anything you added.

Opening a package to read what it contains works while DGC is working, and so do installing it,
removing it, and adding or refreshing a marketplace. A plugin changes what DGC *can* do — tools
and skills, which a running turn picks up at its next model request — never what it is *allowed*
to do. Stop ends the turn, not an install you started beside it.

The terminal does the same work without a browser:

```text
dgc plugin list
dgc plugin search notion
dgc plugin install notion
dgc plugin sign-in notion
dgc plugin installed
dgc plugin uninstall notion
dgc plugin marketplace list
dgc plugin marketplace add SOURCE
```

## Installing one

A plugin's files are copied into `~/.dgc/plugins` at install. Its skills land in DGC's discovery
root and show up in `/skills` after a reload. They are not part of the DGC source tree and stay
under their own upstream licence, which is why an entry whose terms need your agreement asks for it
before anything is copied — `--accept-license ID` in the terminal.

Nothing in a package runs on install, and a file arrives without its executable bit. A package's
hooks, agents, commands, language servers and output styles are not imported at all, and the install
review names each one it is ignoring. A script that survives runs later only through the normal
approval you give any command. The package is bounded: at most 40 skills, 64 KiB per `SKILL.md`, and
8 MiB per file with 64 MiB and 4,000 files across the whole package.

DGC reads the `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` layouts, so a package
written for Claude Code or Codex installs here — but only the skills and the MCP servers inside it
come across.

Some catalog entries are **withdrawn rather than offered**, and you will not see them in the
directory at all. Figma's remote server requires a client it has approved and DGC is not one of
them; Google Workspace needs a project you register yourself. An offer DGC cannot honour is worse
than no offer, so it is taken out rather than left to fail at the sign-in. One you already installed,
or one that arrives from a marketplace you added yourself, does show — with the reason on its card.

**Installing is not connecting.** **Connect** starts whatever sign-in the plugin declares — a
browser handoff, or the key it takes. A plugin can sit
installed for as long as you like with its server disconnected, and the model is told exactly that
rather than left to infer it: *installed, MCP configured but not connected in this session*.

## App connectors

Five entries are **connectors** rather than single services: **Composio**, **Zapier**, **Arcade**
and **Make**, plus **n8n** for workflows on your own instance. You authorize your accounts inside
that service, and its one MCP server then reaches all of them. Composio's card says where: connect
and manage your apps in **Composio For You → Connect Apps**, then come back and ask DGC to use them.
App permissions, account selection and revocation stay there. Uninstalling the connector here
revokes nothing upstream.

A pasted connector token is kept in the editor's secret storage under DGC's own MCP bearer variable
and bound to the exact URL it was given for, never written to the config file. A URL carrying
credentials, a query or a fragment is refused outright.

## Asana, Docusign and Zoom: your own app

Asana's, Docusign's and Zoom's MCP servers admit only apps registered with them; Asana and Docusign also need a
secret, which an open-source app can't ship. So you create an app for DGC in your own account, as the vendors document
for coding tools. **Settings → Plugins → Apps → Connect** shows each step:

- **Asana:** in **My apps**, create an app named DGC of type **MCP app**; under **OAuth** add the redirect URL DGC
  shows (`http://localhost:3334/oauth/callback`, with a Copy button); under **Manage distribution** choose your
  workspace; then paste the **client ID** and **client secret**.
- **Docusign:** in **Apps and Keys**, add an app and integration key named DGC, choose **User Application: Yes**,
  add a **secret key**, and add the redirect URI DGC shows (`http://localhost:3335/oauth/callback`); then paste the
  **integration key** and **secret key**. A developer (demo) account works at once. A production account accepts the
  app only after Docusign's Go-Live review and your Docusign admin's approval for MCP.
- **Zoom:** in the Zoom App Marketplace, build a **General app** named DGC, **User-managed**; under **App
  Credentials** turn on **Use Public Client OAuth**; add the address DGC shows as the OAuth redirect URL and to the
  OAuth allow list (`http://127.0.0.1:3336/oauth/callback`: Zoom asks for `127.0.0.1` here, not `localhost`); add the
  scopes DGC lists (meetings, recordings, search and Docs); then paste the development **public client ID**. There is
  no secret. DGC asks Zoom for no scopes of its own: the ones you added to the app decide what it can do. You need to
  be the Zoom account's owner or an admin, or have the Zoom for developers role, and the app works for members of
  your own Zoom account.

The secret is kept in the editor's secret storage and handed to DGC in an owner-only file when it connects; the
sign-in that follows is kept in your system keychain like any other. Reopening the setup keeps the saved secret if
you leave it blank.

Two consequences, and DGC now states both rather than leaving you to discover them:

- **The work happens in their cloud.** A connector holds the app's credentials and runs the app
  request on its own servers — including when your model is running locally on this machine. Their
  terms govern that part, not DGC's.
- **A connected connector may reach a service that has no plugin of its own here.** The roster the
  model reads used to report per-plugin connectivity and nothing else. It read
  `Figma: MCP not connected` as *Figma is unreachable* — with a connected Composio one line below
  holding the very Figma account it needed — wrote that premise into its own sub-agent's brief, and
  offered to work from screenshots sent by hand. A connected connector now says that it brokers the
  accounts you authorized in its own service, and the model is told to search it with `mcp_search`
  before telling you a service needs credentials, or a screenshot it cannot obtain. A connector
  whose server is down advertises none of this.

A rate-limited call from one of these servers now says it was rate-limited. It used to arrive as the
same opaque payload as a missing credential, which is the other half of why a busy service read as a
locked one.

## Uninstalling

**Uninstall** removes the package, its skills, and the servers DGC created for it. A server you
edited by hand, or one another plugin also uses, is kept and named in the result — DGC created
neither and will not delete either. Plugins and connectors share one flat namespace, so a name
belongs to exactly one of them; two things can no longer both claim it and leave skill folders
behind that nothing owns and nothing can remove.

## What a plugin cannot do

A plugin's skills are instructions. They grant nothing: no permission, no account, no tool. Its
tools are ordinary MCP tools, and every call passes through permission requests, lifecycle hooks,
cancellation, redaction and output bounds like any other; plan mode does not execute them. Reference
text a server returns cannot activate a skill or hand itself a tool.

What does deserve care is the server process. Treat a configured server command as a trusted
executable: it starts unsandboxed in your workspace, and DGC cannot mediate that process's own
filesystem or network activity through tool permissions. See **MCP servers**.
"""),
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

DGC connects to remote (hosted) MCP servers itself, over Streamable HTTP or the older HTTP+SSE
transport, with nothing else to install (no Node or npm). When a server asks you to sign in, DGC
shows the sign-in link and opens it only after you agree; the service sends you back to DGC on
`http://localhost:<port>/oauth/callback`. Explicit reconnects allow a cancellable sign-in window.
Decline stops the connection; use Reconnect to retry an expired login or cold-start failure.

Each remote server's sign-in (its OAuth tokens and client registration) is kept in your system
keychain: the macOS Keychain, or the desktop keyring through `secret-tool` on Linux. Where there is
no keychain DGC can use (a Mac reached over SSH keeps it locked, or a Linux machine without
`secret-tool`), it goes in an owner-only file, `~/.dgc/plugin-auth/<server>/credentials.json`.
`plugin_credentials_store` in `~/.dgc/config.json` chooses: `auto` (the default), `keyring` (the
keychain or fail) or `file`. Tokens refresh before they expire. A tool that needs more access
than you gave says so, and the next Connect asks for it. Removing the server or uninstalling its
plugin asks the service to revoke the token (OAuth token revocation, where the service offers it)
and deletes the sign-in; DGC says which happened. Sign-ins other apps keep (such as
`~/.mcp-auth`) are never read or changed.

**Plugins that take a key.** GitHub (a personal access token), Brevo (an MCP server API key) and
Arize AX (an API key) connect with a key you create at the service. Paste it into the field on the
plugin's own page in Settings → Plugins and choose **Save**, then **Connect**; the page links to where
the key is made and says what permissions it needs. DGC keeps the key with your sign-ins (the system
keychain, or the owner-only file) and the page only ever shows **Saved**, never the key; **Remove**
deletes it, and so does uninstalling the plugin. `dgc plugin key NAME` does the same in a terminal.
A key in the environment DGC starts with (`GITHUB_PAT_TOKEN`, as Codex uses) still works; a saved
key is used instead of it. A key saved for a server is only ever sent to that server's address.

**Sign in with GitHub.** GitHub's sign-in server admits only apps registered with it and still
wants the app's secret for a browser sign-in, so DGC uses GitHub's device sign-in, which needs only
the app's public client id: DGC shows a short code, copies it and opens github.com/login/device, and
you approve DGC there. It is offered once DGC has a GitHub app to sign in with (the catalog's, or
`github_sign_in_client_id` in `~/.dgc/config.json`); until then, the token field is the way in.

**What DGC may do on GitHub.** Above the button, a checklist decides what the sign-in asks GitHub
for. Code, issues and pull requests (`repo`), your organisations (`read:org`) and your profile and
email (`read:user user:email`) are always on; Notifications, Gists, Projects and Packages (read,
write) are off until you turn them on. Signed in, the page says what the sign-in has. GitHub asks
you to approve any change, so a sign-in keeps what it has until you choose **Sign in again**. A
GitHub tool that needs a permission you didn't turn on says which one and where to turn it on; it
never widens the sign-in by itself. In a terminal: `dgc plugin show github`, and
`dgc plugin sign-in github --scopes notifications,gist` (or `none`).

For desktop SSH/remote editors, DGC requests callback forwarding before opening sign-in. If the
editor changes the callback port or address, forward the remote callback port to the same local
port in the Ports panel and reconnect. Browser-only remote editors that require another callback
origin are not supported. Terminal SSH needs equivalent forwarding. Device-code support belongs to
the provider. See [MCP authentication details](https://github.com/OpenPeach-ai/dgc/blob/main/docs/MCP_CONTEXT.md)
for verified flows and current limits.

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
and allow remote HTTPS or loopback HTTP only. Every frontend asks, the editor included, and
the card carries the requesting server, the host, the whole URL, and a warning when the host
contains Punycode. The one URL that still opens without a card is the sign-in you started
yourself by clicking **Connect**. Sampling has no tools, MCP context, or
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

A **plugin** is now the most common way a skill arrives: installing one copies its skills into the
same discovery root, where they behave like any other. See **Plugins, apps and MCP**.

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
per supporting file. `SKILL.md` is limited to 64 KiB and 48,000 instruction characters.
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
- **/new DIR** — an agent in another folder (below). The dashboard's
  `+ Agent in another folder…` asks for the folder and does the same.
- When a **background** agent finishes or needs a decision, the bottom bar shows
  **⧉ N · ◆ need you** — switch to it (Ctrl+O or the dashboard) to answer.

New agents use your current model by default; point one at a different model or
a cloud key with `/model` / `/connect` for true parallelism. Every agent this terminal opens
keeps what the launch was given for the run — an `--api-key-env` key, and `--sandbox` with the
tools it denies — but not its grants: `--allow-tool` and `--add-dir` stay with the launch project.
A permission rule or a trusted folder you save in one agent applies to all of them at once.

## Agents in other folders

**/new DIR** opens an agent in another folder, next to the ones you have, the way the editor opens
a chat in another folder. `~`, quotes and relative paths work; a relative path starts from the
project of the agent on screen. DGC opens the folder's project — it walks up to the nearest `.git`,
`DGC.md` or `.dgc` — and the agent works with that project's trust, permission rules, named agents,
skills and `DGC.md`, not the launch project's. Your MCP servers start for it in that folder, and it
has its own permission mode, as every agent does. Its chats are saved with that project, so
`/resume` inside it lists them, and so do `dgc --continue` and the editor opened there. Closing it
says how to come back: `/new` the folder, then `/resume`.

A folder you have not trusted shows the trust card first — **Trust it and open** or **Cancel** —
and nothing from it runs until you choose: no agent, no MCP server, no hook, not even git. Trusting
it covers everything under it, as at launch; for your home directory, `/` or a folder that contains
your home, **Cancel** is the row Enter picks. Esc builds nothing and writes nothing.

The first agent in a folder works in the folder itself. Another agent in a checkout an agent of
this terminal already works in gets its own `dgc/fleet-*` worktree, as Ctrl+N does in the launch
project; in a non-Git folder it shares the folder, and writes are serialized. Agents of this
terminal that share a folder are told about each other, as two windows are.

`/new`, Ctrl+N and `+ New agent` always mean the project you launched in; `/new .` is the project
of the agent on screen. `/new DIR` works while a turn runs. A DGC pinned to one project with
`DGC_PROJECT_ROOT` opens no other folder, and a folder inside DGC's own storage (`~/.dgc`, the
fleet and task worktrees) is refused. A path that reads as a command — `/new /plan`, or a short
absolute path the `/` menu completes to a command — needs quotes or a trailing slash:
`/new "/plan"`. The classic terminal (`dgc --classic`) holds one agent, so there `/new DIR` tells
you to start DGC in that folder instead.

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

Five specialists are always available as the `task` tool's `agent` argument:

- **explorer** — read-only search and map of the codebase (no writes).
- **researcher** — investigate and write one findings file, then stop.
- **critic** — review named files or a change; correct them or list blocking issues.
- **verifier** — try to prove a claim or a change wrong: it reads and runs the tests or commands that
  would show it, edits nothing, and starts its answer with CONFIRMED, REFUTED or UNSURE.
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
An interactive Ultra fan-out defaults its omitted `background` flags to true, so after launching
two or more independent children the parent remains available for your steering and for other
independent work. Set `background: false` explicitly when its next model step really needs the
result; a single task still defaults to foreground. The composer stays free. The agents pill remains while that specialist runs. When it
lands, DGC starts a wake turn with the child's summary in the editor, and in the terminal while
wake-ups are on; elsewhere the result reaches the model between tool calls or with your next
message. Either way you do not sit in a blocked turn polling it, and `wait_tasks` collects it the
moment you need it. A `dgc -p` run ends with its turn, so there a background child is for overlap
within the turn: one still running at the end is stopped. Foreground `task` (the default) still
waits.

One `task` call can also start several helpers at once: `tasks` lists 2 to 8 of them, each with
its own `description`, `prompt` and `agent`, and they start together (some models send one `task`
call per reply even when they mean several, so their helpers used to run one after another).
Without `background`, the call returns when every helper has ended, with each one's result under
its own description, in the order listed, a failed one included; with `background: true` it
returns at once with every helper's id. They run up to `max_parallel_tasks` at a time and the rest
wait for a free slot. Each has its own private checkout, and their changes land or are kept aside
exactly as several `task` calls in one reply would. Stopping the turn stops every helper the call
is waiting for; background helpers run on, as a single background task does, and stop from the
agent map.

A background child belongs to the chat that started it. Starting a new chat — `/new`, `/clear`, or
the editor's New Session — stops any that are still running and says how many, because the chat
that asked for the work is gone: a child left running would keep writing files and would fold its
worktree back in against a conversation that never asked for it, putting those edits inside the
reach of the new chat's `/rewind`. Switching between two open chats does **not** stop anything —
each chat has its own backend, and a background child running in the one you switched away from
is exactly the point.

Personal definitions in `~/.dgc/agents/` are available in any workspace and override a
built-in of the same name. A project's `.dgc/agents/` definitions load only after you trust
that project, because a definition can select its own model host and an environment key.
Trusting an already-open terminal or editor loads them without a restart. Isolated tasks and
fleet workspaces use the approved source project's definitions rather than loading new
definitions from their scratch checkout. An optional `tools:` frontmatter line is an
allow-list of built-in tool names.

## Watching, and waiting on purpose

A foreground `task` blocks until the child is done. A `background: true` one does not, and its
result arrives on its own (a wake turn in the editor and the terminal, otherwise with the next
message). Between those two the model was blind: it had started something detached and had no way
to ask about it.

Four tools close that. None is offered unless there is something to act on — a
background child still running, or one whose result nobody has read yet — so a pointless wait is not
possible. Neither is offered in a session whose host application set its own tool allowlist either:
that allowlist could not have named them, and a policy that could not have named a tool never
silently receives it.

- **`list_tasks`** — every sub-agent of this chat, from the same snapshot the agents pill and
  `/agents` read: its id, its state (queued, running, waiting on the user, finished, failed,
  stopped), how long it has run, its tool count, and a finished one's one-line summary. A child
  started by another child is indented under it. Instant, and it marks which results are still
  unread.
- **`wait_tasks`** — block until a background child reaches a final state, then hand back its whole
  result: the same text a foreground `task` would have returned, including which paths were
  integrated. `ids` takes the ids `list_tasks` gave; leave it out to mean every background child of
  this chat. Either way it returns as soon as the first of those has a result nobody has read.
  `timeout_s` is 30 seconds by default and is clamped to 5–600 rather than refused. Four results
  come back at once; the rest are announced and wait for the next call.
- **`message_task`** — one message into a child that is still working, of one of two kinds. By
  default a **correction**: a constraint that was left out, a narrowing of the brief, something the
  child is getting wrong. With `adds_work`, **more work**: what the child is already doing still
  stands, and this is added to it. The child is told which, in so many words — before, everything
  arrived as a correction, so a parent adding scope told the child the opposite of what it meant.
  Either way it is folded in at the child's next tool boundary: it starts no new task, restarts
  nothing and waits for nothing, and a child that has already finished cannot read it — the answer
  says so and points at `wait_tasks`. The two control tools need a child that is still RUNNING, not
  merely a result nobody has read. The transcript names the child by what it was asked to do:
  *Sent message to Write the parser*, in the editor (and again when the chat is reopened there)
  and in the terminal UI as it happens.
- **`close_task`** — stop a child whose work is no longer wanted. Its changes are **not**
  integrated: whatever it had written to its own checkout is preserved as retained work, so
  `/tasks` can apply or drop it, and nothing is silently thrown away. Stopping a child stops
  anything it started. It returns as soon as the child is signalled; the child's own account
  arrives the usual way.

The same two actions are available to the USER over the wire, as `agent_control` — so a background
child that is going wrong can be stopped on its own instead of ending the whole turn.

A wait ends early if you say something while it is running, and says so, so the model reads you
before it reads the child. A timeout reports what is still running and tells the model to get on
with something else meanwhile. Waiting on an id that ran in the foreground is an error that explains
itself — that `task` already returned its result — rather than a silent wait on nothing.

A result the model read inside its turn is not announced again afterwards. The wake-up that would
have repeated it is dropped, so one child is reported once instead of twice.

Neither tool reaches a sub-agent: a child's `background: true` runs inline, so a child has nothing
detached to supervise. Neither can be named in a permission rule, because neither changes anything —
`deny: Task` is the off switch, and with no children the pair never appears at all. Repeating the
same `wait_tasks` call is how waiting works, so it is exempt from the loop guard that stops a model
reissuing an identical call.

Both show their work as they run: **Checking sub-agents**, and **Waiting for a sub-agent** with a
line every five seconds — *waiting on 2 background sub-tasks · 15s of 30s*.

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

    ("Troupes", "many sub-agents on one fixed work order, in the background, under Ultra", """
# Troupes

A troupe is for a job too big for one agent to do reliably: reviewing forty files and checking every
finding, researching a list of questions, making the same change in many places, comparing several
options. One agent working through that by itself loses track, skips parts or stops early. With a
troupe, the model writes a work order and DGC runs it exactly as written: every item gets its own
agent, every finding gets its checkers, and nothing is skipped.

Troupes are offered under **Ultra** (the effort menu's Ultra, or `/ultra`). The model decides when a
job calls for one.

## What happens

1. The model starts a troupe with a title, the items to work through, and either a template or its
   own stages.
2. In **auto mode** it just runs. In other modes you see a card first, "Start a troupe?", with the
   plan in words, the items and what Allow does. Plan mode never starts one.
3. It runs in the background and the chat stays free. In the editor, a row above the prompt box
   shows the stage it is on, with **Stop**; its chevron opens every stage's progress. In the
   terminal, a line marks each stage as it finishes; `/troupes` lists them and `/troupes stop
   ID|all` stops one.
4. When it ends, the chat wakes and the model reports the results. In a one-shot `dgc -p` run, the
   troupe runs to its end inside the call, and the model answers with its results.

## Templates

- **review**: one explorer per item reports problems; then three verifiers each try to prove every
  problem wrong, and only the problems most of them agree are real are kept.
- **research**: a researcher per question answers it with sources; a critic checks each answer.
- **change**: a worker per place makes the change in its own isolated checkout, which is merged
  back as a sub-task's is; a verifier then checks each change.
- **compare**: an explorer works out each option; three judges compare them all and pick the best.

A work order can instead give up to four stages of its own. Each stage names its agent kind, a
prompt with `{item}`, the JSON every agent ends with (`returns`), and optionally `votes` (several
agents per item, independently), `keep` (only results whose field has a value; with votes, how many
must agree), `split` (a list in each result becomes the next stage's items) and `over: "all"` (one
agent sees every item at once).

## What its agents may do

- **explorer, researcher, critic** read only (files, search, the web), with no shell. They run beside
  your files, so a hundred of them cost no checkouts.
- **verifier** reads the same and also has a **read-only shell in a sealed box** (bubblewrap on
  Linux, Seatbelt on a Mac), to run the commands, tests and queries that would prove a finding wrong.
  In the box the project is read only (at `/mnt`; on a Mac at its own path), the only writable place
  is a private `/tmp` (on a Mac, a private `$TMPDIR`), credential files a Pip snapshot leaves out
  (`.env*`, keys, `.git`, `.ssh`, ...) are hidden, your home, `/run` and their sockets (Docker's
  included) are empty or closed, and there is no network, except the project's read-only database
  when one is set. On a Mac it is a little weaker: a command can see which other programs are
  running, and one it detaches can outlive it, still inside the box. Where the box can't run (stock
  Ubuntu 23.10+ AppArmor: `dgc pips execution --fix`), a verifier has no shell and is told so. A verifier that can't check something answers
  unsure, which counts neither way; what nobody could check is kept and marked unchecked.
- **A read-only database account**, for checks on live data: make a read-only role yourself
  (`dgc readonly-db guide` prints the Postgres SQL; DGC never creates or changes a role), then
  `dgc readonly-db set` in the project and paste its `postgresql://` address (it is kept as a
  plugin's sign-in is, the system keychain or an owner-only file, and never goes on a command line).
  It must be on this computer: a verifier's box reaches it through one forwarded port and nothing
  else, as `$DGC_READONLY_DATABASE_URL`. A worker gets the same variable, to prefer for reads.
  `dgc readonly-db show` and `clear` too. Without one, a verifier's box has no database at all.
- **worker** writes, always in an isolated checkout of its own, and its changes are merged back
  exactly as a sub-task's are. A named agent from `.dgc/agents` that may write is treated the same.
- They never ask you anything: a step that would ask is refused (in auto mode, everything their kind
  allows runs). A deny rule still applies, `Troupe` included: `"deny": ["Troupe"]` turns troupes off.

On a model served on this machine, one agent runs at a time; on a remote or cloud model, as many as
sub-agents may (Ultra: 8). The turn's token cap (Settings, General) counts every troupe agent, and a
troupe stops starting new agents when it is reached. A troupe starts at most 400 agents.

## Results, and resuming

Each run keeps a journal in `~/.dgc/troupes/<id>/`: its work order (`plan.json`), every agent's
result as it lands (`results.jsonl`), the last stage's results (`results.json`) and the report the
model was given (`report.md`). A stopped or interrupted troupe can be run again with its id: only
the agents that had not finished run again.

Troupes are one chat's work: a new chat, `/clear` or closing DGC stops them, and a troupe never
reports into a chat other than the one that started it.

## On a schedule

Ask for a troupe on a schedule ("every Monday at 9, review last week's changes for bugs and
double-check what you find") and the model schedules it instead of running it: it becomes a routine
of your Primary Pip, or of the Personal Pip you name. Outside auto mode you see **Schedule a
troupe?** first, with when it runs, what it works through each time and which Pip reports; Always
allow saves `Troupe(routine)`, which is separate from the rules that allow running one now.

When it is due, the troupe runs as a job of its own, with your model, on a snapshot of the project's
committed code: one troupe routine at a time, for at most an hour. Each time it works through the
files changed since it last ran (the first time, the last seven days), the tracked files matching a
pattern, or a fixed list. The Pip then tells you what it found in its chat; the full results are in
`~/.dgc/troupes/`. Its tokens show in the Pip's usage.

A scheduled troupe only reads: review, research, compare, or stages without a worker. Rename it,
change its time or turn it off in the Pip's Settings, Routines; to change what it does, ask for a
new one. Pips must be running on this computer for it to run.
"""),

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

- `task` — a sub-agent: `agent` picks explorer / researcher / critic / verifier / worker (or a named
  definition); `background: true` runs on after the turn, except in a one-shot `dgc -p` run (see
  **Sub-agents**).
- `list_tasks` · `wait_tasks` — what this chat's sub-agents are doing, and block for a background
  one's result. Read-only, and offered only while there is a background child or a result nobody
  has read (see **Sub-agents**).
- `todo` · `skill` · `add_skill` · `save_memory` · `update_goal` · `notes`
- `present_plan` — plan mode only, for approval.
- `propose_options` — ask you to decide, and wait (see **Questions**).
- `ask_user` — ask you something and keep working (see **Questions**).
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

## Rules survive a long file

A file over that bound keeps its beginning and its newest end, and the middle is left out. A
rule must never be the part that goes, so say which parts are rules. A section whose heading
starts with the word **Rule** or **Rules** (`## Rule: run the tests before committing`,
`### Rules`), or any section containing `<!-- dgc:rule -->`, is kept whole and placed first. A
section runs from its heading to the next one.

If the rules alone do not fit, DGC keeps as many as fit, in order, and names the ones it left
out, so you know the file needs consolidating — only you can choose what to cut. A file within
the bound loads exactly as written.

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

## What DGC remembers about you

Separately from these files, DGC keeps one memory about you that ChatDGC, Work sessions and Pips
share: short facts you told ChatDGC, a Work session or a Pip (each keeps what you state about
yourself, or ask it to remember, and says so) or added yourself, plus your projects, from your
Work sessions. A Work session reads those facts under **# Memory**. See, change or delete
everything in **Settings → Memory**, where one switch turns it off everywhere. A fact is kept
only when you said it yourself, never a password, key or account number, and temporary chats are
never remembered.

It also learns by itself: once a chat or a session has been quiet a couple of minutes, or a turn
ends after you've written a paragraph or so, DGC looks back over what you said and keeps at most
three preferences, facts, decisions or outcomes, by the same rules. The chat shows each once as
**Remembered: … · Forget**. **Settings → Memory → History** lists every change, who made it and
when, with **Undo**. Memory off means it never looks.

**/learn** (or `/learn what`) turns what was just done into a skill: DGC drafts a SKILL.md from
the session and shows it with **Save**, **Edit** and **Cancel**. Nothing is written until you
save; it goes to the project's `.dgc/skills` when the folder is trusted, otherwise to
`~/.dgc/skills`, and Undo in History deletes it again.

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
- Every message you send carries the day and the time of day, on its own line:
  `Local time: Sunday 2026-09-20 14:32 (Asia/Kolkata)`. It is on the message rather than in the
  session prompt so that two questions a minute apart still send a byte-identical prompt, which is
  what lets a provider charge cached-input rates for the second one. The date is on it too, so a
  chat picked up days later doesn't reuse the last date it saw. Resumed chats and `/export` show
  what you typed, without it.

A day boundary reaches the model on your next message, so an overnight session does not keep
calling it yesterday. A sub-agent is told the same two things. A turn DGC starts by itself on a
background monitor gets no clock line: the events it delivers are already timestamped.

The same rule keeps the start of every request the same from one turn to the next, which is what
lets a provider (OpenAI, DeepSeek, Anthropic, Ollama cloud) charge cached-input rates and a local
Ollama or llama.cpp skip re-reading the conversation. What one message needs for itself rides on that
message, just before the clock line, in a `<dgc-turn-notes>` block: the how-to for showing you a page
when you ask to see one, the note when you ask to choose between options and the picker is not
offered, a skill your words matched, the hand-back while an approved plan still has steps, and the
note after you cleared the checklist. The session prompt and the tool list stay as they were. A large
MCP catalog is cut to the tools a chat needs, and a tool offered once in a chat stays offered while its
budget lasts, so the tool list changes only when a new tool joins. Resumed chats and `/export` show what
you typed, without the notes. What still changes the start, by design: switching the mode, the
thinking level or the model, naming a skill with `$`, remembering or forgetting something, a goal,
plugins and skills installed mid-chat, a background job or sub-agent that adds the tools to manage it,
and, in Auto mode, the options picker on a message that asks to choose. The `adaptive` tool profile
still shapes its prompt and tool list from each message's words.
""".strip()),

    ("Sessions & rewind", "resume, jump, and undo whole turns", """
# Sessions & rewind

Every conversation is a session, saved as you go.

- **/resume** — reopen a past session (newest first); `dN` deletes one.
- **/new** (Ctrl+N) — start fresh; DGC auto-titles it from your first prompt.
- **/new DIR** — in the terminal, an agent in another folder beside this one, with that folder's
  trust, rules and saved chats (see *Multiple agents*). `/resume` in that agent lists the folder's
  chats.
- **/name** — rename the current session, while a turn is running too.
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

## Sessions, each in an editor tab

DGC opens on your project's **Sessions** in the side bar: every saved session of this project,
newest first, with when it was last used and how many messages it has. **Open in Editor**, a
double-click or Enter opens one in an editor tab of its own, the way Claude Code does; **New
session**, *DGC: New Session* and the **+** in a session's tab start a new one in a new tab. A
session already open says **Open in a tab**, and opening it again brings that tab forward. Each tab
is a full chat, named by its session's name or else its first prompt, with a `dgc serve` of its own
so a restart or a crash in one tab never ends a turn in another; tabs come back on their sessions
after a window reload. `/new` typed in a chat still starts afresh in that tab. Palette commands —
Add Selection, Add File, the model and the mode — act on the tab you used last, and the status bar
shows that tab; with none open, Add Selection and Add File start a new session's tab. *DGC: Resume*
shows the list. Deleting a session from the list asks first, and waits until its tab is closed.
The Pips stay in the side bar.

## A session keeps running through a reload

Reload the window, close it, or lose a Remote SSH connection and reload: a session that was working
keeps working. Its `dgc serve` carries on with no window, and when the window comes back the tab
picks the session up where it is: the reply still being written, the question still waiting for
you, its queue, its sub-agents and watchers, with nothing missing and nothing shown twice.

With no window a session never runs for ever. It saves and stops by itself:

- **2 minutes after its work finishes**, so a reload a moment later still finds it;
- **after 1 hour waiting on your answer** (an approval or a question, with nothing else running);
  opening it again shows the question, and **Continue** picks the turn up;
- **after 12 hours at most**, whatever it is doing; watchers come back when you open it again.

**Settings → Running sessions** lists each session running with no window, what it is doing and
for how long, with **Open** and **Stop**, and the Sessions list marks it **Running, no window**.
In a terminal, `dgc ps` shows every DGC on this computer and `dgc stop` stops one.

- **One window at a time.** A session shown in another window is never taken from it on its own.
  The new window shows it read-only with **Open here**; Open here moves it, and the other window
  then shows it read-only with its own Open here. Nothing stops when a session moves.
- **Closing a session's tab while it works asks once**: keep it running in the background, or stop
  it. Tick **Remember my choice** to be asked no more (`dgc.closingAWorkingTab`: `ask`,
  `keepRunning` or `stop`). Closing a tab with nothing running ends it, as before.
- **After an update**, a session still running in the older DGC is saved and stopped, and opens in
  the new one; what was running stops there, and its turn offers Continue.
- **A window that stopped answering** for 15 minutes (an editor left running by a reload, for
  example) no longer keeps a session to itself: the session runs on as if it had no window, under
  the rules above, and that window, if it is still there, shows it read-only with Open here.
- **Private to you.** A window reaches the running session through a socket only your user can
  open (a 0700 directory, a 0600 socket, the other process's user checked), never a network port.
  It works on Linux and macOS, and over Remote SSH. On Windows, DGC runs in WSL, and a session
  keeps running only while WSL keeps DGC's Linux system up.
- **What it is not.** It does not survive a restart of the computer: a session that was working
  then is opened from disk with Continue. Pips are separate: the Pips runner never stopped for a
  reload.
- **A ChatDGC reply too.** ChatDGC rides on the side bar's `dgc serve`, and a reply being written
  keeps it running with no window, under the same rules; the chat's tab shows the reply finished or
  still streaming when the window comes back. Closing a chat's tab mid-reply asks the same question,
  and **Settings → Running sessions** lists a chat a closed window left answering, with **Open**,
  which shows it in a ChatDGC tab here, still writing. With no reply running, that backend ends with
  its window as before.
- **One window writes to a ChatDGC chat.** A chat open in another window shows read-only, as it
  was last saved, under the same bar, with **Open here**. Open here moves that one chat, not the
  other window's DGC (its Pips, Sessions and Settings stay): mid-reply, the reply streams on here and
  the chat is this window's once it ends. Two windows opening one chat, or pressing Open here on it,
  at the same moment can't both have it: one does, and the other stays read-only and says so.

## Several chats, several folders, in one panel

*DGC: Open a Chat in Another Folder…* opens a chat in a different project beside the one you are
in. Every chat
has its own model context, session file, turn and permission mode — not a second view of the same
conversation — so the chat you switch away from keeps working. A chat in another folder also brings
that folder's project settings, trust, MCP servers, skills and permission rules with it. A rail
appears above the transcript with one tab per chat, naming the folder when it is not the window's;
a pulsing dot means that chat is mid-turn, a square amber dot means it is waiting on a decision
only you can make, and a number is how much it has said since you last looked. Click a tab to
switch, the **×** to close one. *DGC: Switch Chat* does the same from the command palette.

All of them run in one `dgc serve`, the way Codex runs its threads: one process, each chat in its
own folder. Each still starts the MCP servers its own folder configures. What one chat does stays
in that chat — a Stop ends only its own turn and its own approval cards, and a slow command in one
(a compaction, a rewind, reconnecting MCP servers) never holds another chat's Stop or approvals.
What is yours rather than a chat's — a permission rule, a trusted folder, an MCP server you add or
remove — reaches every open chat at once. `dgc.shareBackend` turns the sharing off and gives each
chat a process of its own. The extension needs DGC CLI 0.47.0 or newer.

While a chat's turn runs you can still:

- **switch** to another chat, or open a new one — the turn carries on;
- **rename** it (*DGC: Name Session*, or `/name`);
- **open a saved session** — it opens in a chat of its own beside the running one, instead of
  replacing the conversation that turn belongs to;
- **install or remove a plugin** — its tools and skills reach the running turn at its next request.

There is no built-in ceiling — open as many as your machine and your model budget allow. What
another chat really costs is another model context — tokens on a cloud endpoint, or a share of a
local model — and only you can judge that. Writes from several chats into one checkout are
serialised by the workspace write lease; chats in different checkouts write at the same time. If
you want DGC to stop you at a ceiling, set `dgc.maxLiveChats` in the editor's settings; 1 keeps it
single-chat.

A second chat is for parking long work — a migration, a long test run — while you carry on.
Delegation (*Sub-agents*) is still the right tool for fanning out one task across workers.

Switching does not replay anything the panel kept: the chat you arrive at is rebuilt from the
backend's snapshot of that chat, taken under its turn lock and followed by a fresh announcement of
whatever approval or question it is blocked on. So a chat you left mid-turn comes back exactly
where it is now, not where it was when you left it.

Closing the window stops every chat in it. Closing one chat stops only that chat; the backend
keeps running for the others, and the last one to close stops it. If a background chat's backend
dies while you are not watching, its tab says so and switching to it starts a new one on the same
session rather than an empty chat.

## When another DGC is working here

Two chats, two windows, or a window and a terminal are all two agents editing the same files. They
know about each other. Each leaves a note in `~/.dgc/peers/`, refreshed while it
runs, and every agent reads the others: you get one line when that changes — *"1 other DGC is
working in this folder."* — and the model is told the same thing, with the instruction that
matters: **do not revert or "fix" a change you did not make, and if their work conflicts with
yours, stop and say so rather than choosing for you.**

Two worktrees of one repository count as the same place, because they share branches and history.

A note is only trusted when the process behind it can be proved to be the one that wrote it —
process ids get reused, and a stale note whose id now belongs to something else must not read as a
live DGC. Where that cannot be proved, DGC says the agent *may* still be running rather than
claiming either way. A DGC that exits cleanly removes its note; one that crashes leaves it, and it
expires. A DGC that is idle with nothing saved in any of its chats — the editor's Sessions list keeps
one running — has changed nothing here, and is not counted.

## A rewind will not undo somebody else's work

Rewinding is DGC undoing DGC. If a file has changed since DGC last wrote it — another window,
another tool, or you in your editor — the rewind stops and names the files, and **nothing** is
restored. It is all-or-nothing on purpose: a partial rewind would leave the folder in a state
neither you nor DGC chose.

A rewind of DGC's own work is unaffected, and so is one where DGC has no record of what it left:
the guard fires on evidence that a file was changed, never on uncertainty.

## Delegated work can write outside its own checkout

A delegated task runs in its own disposable worktree, so edits there need no snapshot. A write
*outside* it — a file in your project, a script in `/tmp` — is an ordinary change to your files and
is captured by the parent chat, which is what can undo it. Until this release those writes were
refused outright: *"DGC could not capture its pre-edit state first"*.

## Two DGCs, one settings file

Every DGC on a machine reads and writes the same `~/.dgc/config.json`, so two editor windows are
two processes sharing it. A save writes only what **that** DGC actually changed, merged into
whatever is on disk at the moment it writes, under a lock: a model chosen in one window and a
thinking level chosen in the other both survive, and the one that saves second adopts the other's
change rather than reverting it.

Permission rules merge the same way, rule by rule. This matters most in the direction that
protects you: a **deny** added in one window used to be erased by an unrelated settings change in
another, because a save rewrote the whole file from one process's memory. A rule you revoke is
still revoked — the merge carries removals, not only additions. Rules a *workspace* brings
(`<project>/.dgc/permissions.json`) stay live-only and are never written into your own config,
and they stay in force for the whole session, whatever else is saved. Trusted folders merge
folder by folder, so a folder you revoke in one window is not trusted again by another's save.

What a running conversation is using is never changed underneath it. Its permission mode, its
model and endpoint with their key, and its sampling settings stay as they are when another
window or chat changes them; the change is saved, and it is what the next session starts with.
Keys in `~/.dgc/secrets.json` merge the same way as the settings, so switching endpoint and key
in one window no longer has the new key wiped by the other window's next save.

## One session, one chat at a time

A session is held by whichever DGC is running a turn in it, so a second window — or the second
chat in this panel — opening the same session is told it has *an active turn in another DGC
process*. That protects the transcript: two
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

Handing the session to a window that is *asking* for it is a faster, stricter question, and it is
answered by the chat panel rather than by the editor process. The panel itself says it is on screen
every twenty seconds. A window that reloaded takes its panel with it, so those statements stop at
once -- even in the case that started all of this, an editor host that outlives its own window and
goes on insisting, on a timer, that everything is fine. After about two minutes with no word from
any panel, the window that asked gets the session. Closing the chat view without closing the window
is the one case where a live window has no panel to speak for it: the editor says so, that buys a
bounded extra minute, and then the session goes to whoever is waiting.

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
the actual file state before each run — even when the file was already dirty. Edits DGC's own
file tools make are always recorded, however large the folder; a shell command's edits rely on
the workspace scan, which says when it stopped at its limits. A fresh chat starts
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

Current release: **dgc-sdk 0.7.0** on [PyPI](https://pypi.org/project/dgc-sdk/) and the Node
package `@vibedgc/sdk` 0.7.0, both tagged [`sdk-v0.7.0`](https://github.com/OpenPeach-ai/dgc/releases/tag/sdk-v0.7.0)
(not `v0.5.x`, which are historical CLI tags). They pair with CLI **0.48.0** over editor protocol
v14 and are proven on Linux. The full guide and API reference is
[docs/SDK.md](https://github.com/OpenPeach-ai/dgc/blob/sdk-v0.7.0/docs/SDK.md).

## Install

```
python3 -m pip install dgc-sdk==0.7.0
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

`@vibedgc/sdk` (Node 22+) is on the npm registry; the identical tarball is also attached to the
GitHub release.

```
npm install @vibedgc/sdk
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

## Pips and ChatDGC

With `inherit_user_state=True` the same client reaches the rest of your DGC profile.
`session.pips` lists its Pips, reads their runs and what each run posted in its own chat
(`run_posts`), and starts or changes one with `mutate`, which needs your code's `approved=True` on
that call. [sdk/PIPS.md](https://github.com/OpenPeach-ai/dgc/blob/main/sdk/PIPS.md) lists every call
and field with the Pips API it needs, such as a live-data Pip's `changes.live_plan` (API 60).
`DGC.chat()` is ChatDGC from your program: `ask`, `stream`, `research` and `answer`, with numbered
sources. TypeScript has the same API.

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
- A picked skill, template or file becomes a **pill** where you typed it, not a rewritten line: it
  carries its own sigil, you can remove it with Backspace or the mouse, and the model receives the
  text it stands for. Two pills of the same skill are two selections. Anything the pill does not
  already show sits in the attachment row underneath, and a pill you delete takes its attachment
  with it.
- Paste an image to attach it for a vision model. Its chip shows the image's file name, cut to fit,
  with its type, size and dimensions on hover; a screenshot copied straight to the clipboard has no
  name of its own and reads like "PNG · 1920×1080". Drag files in from the explorer. See
  **Pasted text** for a tall paste, a pasted link, and characters you cannot see.
- Tool calls collect into one folded group with a summary in its header. It opens by itself the
  first time something in it fails, and once you fold it by hand it stays folded — a later failure
  does not throw it open under you.
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

- **Worked for 43s ›** heads a turn that has answered. The work that led there folds into it: the
  one-line updates between tool calls, the tool rows, thinking, and sub-agents that have finished.
  Click it (or Enter) to see them again in place, under the row; it folds them again once your
  next prompt has its answer. What you still need stays on screen: a detailed message (a diagnosis,
  a plan), a message you sent mid-turn, question and approval cards, notices, and the answer with
  what it changed. A turn that was stopped or failed does not fold. A reload or a resumed chat
  draws the same fold. The terminal keeps every line on screen: a turn that used tools says
  **· Worked for 43s · 5 tools** above its answer, and any other turn ends with **· done · 3s**.
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

## Around the Work chat

- **The prompt rail.** From five prompts, a tick per prompt in the transcript's right margin; hover
  it for every prompt with its time, or press **Alt+↑ / Alt+↓**. See **Keyboard shortcuts**.
- **The context meter**, in the row under the message box, says how full the window is. For vLLM, SGLang and
  llama.cpp it reads **Set by the server: 32K**, with how to change it there; see **Connect your
  model**.
- **The prompt cache's clock** after the meter: the minutes left while Anthropic or a local Ollama
  keeps this conversation cached (**4m**), or the clock alone once the cache has gone. See **Token
  usage**.
- **Remembered: … · Forget** shows once when DGC keeps something from the session; `/learn` drafts a
  skill you **Save**, **Edit** or **Cancel**. See **Memory**.
- **Pip reports** arrive as cards, and **Ask DGC to fix** fixes one in the background while you keep
  chatting, with a **Pip fixes** chip on the chip line. While a Pip that reports to this chat runs, a
  chip says so (**Billing audit running · 0:42**, or **2 Pips running**) and opens its chat at the run.
  See **Pips**.

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
  write your own answer, and **Skip** leaves a question unanswered. With several questions, your
  pick stays marked for a moment and the next question streams in; the last answer doesn't send:
  the card reads "all answered" and focuses **Submit**, so you can page back and change any answer
  first. A single question still sends on one click.
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

The gear opens twelve pages: **General** (permission mode, thinking, context size, tool profile),
**Models** (a local host, a provider, or your own subscription CLI; for Anthropic, **Cache
lifetime**, and for a local Ollama, **Keep the model loaded**), **Agents** (the model, host and context
window sub-agents use, how many run at once, the fallback route, and the model for Pips), **Web search**, **ChatDGC**, **Memory** (what DGC
remembers, with its **History** and **Undo**), **Voice**, **Running sessions** (sessions working
with no window), **Token usage** (what this machine counted), **Security** (sandbox confinement and
plan-mode limits), **Plugins** (installed packages, the apps they reach, and the directory) and
**MCP servers**. Settings follows your VS Code theme. Everything is a row: what it is on the left,
the control on the right, a one-line hint beneath, and the rest behind the **?** beside its name.
Advanced settings fold away under **Advanced**. One **Save all** at the foot of every settings page
saves every page's changes and names the pages that have them. Each **Model** box lists the models at
its own card's host as you type it (Ollama's `:cloud` models included), and still takes any name; a
saved key only ever goes to the host it was saved for. An MCP server's **Forget saved sign-in** and
**Remove server** each ask first. Skills, lifecycle hooks, permission rules,
project memory and these docs each open as their own panel from the command menu.
See **Plugins, apps and MCP**.

## What the editor adds

- Files DGC changed carry a mark in the explorer, and the diff opens in your editor's own viewer.
- **Changes in this chat** on the composer is this chat's own deltas, not pending Git from before
  you opened it. **Workspace changes** is the separate repository review. See **Git changes**.
- **Add to DGC** in the explorer and editor-tab context menus attaches a file to the composer.
- The panel reads your selection and the file you are in as typed context, not as text glued into
  the prompt.
""".strip()),

    ("ChatDGC", "a chat for everything that isn't code, answered by your own model", """
# ChatDGC

ChatDGC is a chat app inside DGC for everything that isn't code: a question, a plan, a letter, a
spreadsheet to make sense of. Your own model answers (the one you set in DGC, or another you pick for
a chat), and your chats stay on your computer. It runs on its own engine, separate from Work (the
coding sessions) and from Pips. The full guide is
[docs/CHATDGC.md](https://github.com/OpenPeach-ai/dgc/blob/main/docs/CHATDGC.md).

## Using it

The DGC side bar has two tabs, **Chat** and **Work**. **New chat** opens a chat in an editor tab, as
does **DGC: New Chat (ChatDGC)** in the Command Palette. One search box finds a chat by its name or
anything said in it. Enter sends, Shift+Enter adds a line, Esc stops a reply. A message you send
while a reply is still being written waits above the box and goes when the reply finishes. A reply
keeps going through a window reload or a closed window, and its tab shows it again when the window
comes back; closing the tab mid-reply asks once whether to keep it running. A chat open in another
VS Code window shows read-only with **Open here**, which brings that chat to this window, its reply
still streaming if it is being written.

## What it does

- **Looks things up, and cites them.** When an answer depends on facts it searches first, with the
  web search set in **Settings → Web search** (the same one Work and your Pips use), and every claim
  carries a pill that names its site and opens the page. **Sources** lists what it read and used.
  Web search is on unless you turn it off there (**Search in ChatDGC**).
- **Deep research.** **Deep research** in the box shows a plan you can edit (it starts on its own
  after 15 seconds), reads its way through many pages as you watch, then writes a report whose every
  citation was checked against its source. **Open report** shows it full screen; **Export…** saves it.
- **Study mode.** **Study** makes the chat a tutor until you turn it off: it asks what you know,
  teaches a step at a time, has you try, and checks with quick quizzes you answer with a click.
- **Interactive answers.** Ask for a calculator, a converter, a timer or a quiz and it opens in a tab
  beside the chat, locked down (no network, nothing from your chats or VS Code), in the editor's
  colours. ChatDGC checks what it shows once it's open and fixes it if it's wrong. A card under the
  reply has **Open** and **Show code**; **Widgets N** in the chat's header lists that chat's widgets,
  and the Library's **Widgets** tab keeps them all.
- **Questions.** When what comes next depends on something only you know, a reply asks with a card:
  pick an answer or type your own; a card of up to four questions sends them all with one button.
- **Files, data and charts.** Attach documents, images and spreadsheets, or paste something long.
  Answers about a spreadsheet come from exact queries (**Analyzed the data** shows them), and replies
  draw bar, line, area, pie and scatter charts you can hover, copy and save. Formulas are typeset.
- **The canvas.** A longer piece you'll work on together opens in an editor beside the chat: edit it
  yourself and ChatDGC reads your version and changes it with small edits you can undo, with every
  version kept.
- **Files it makes.** Ask for a document, PDF, spreadsheet or slides and the reply comes with the file.
- **Projects and the Library.** A project keeps chats, files and instructions together. The Library
  holds every file you attached or ChatDGC made, and every widget.
- **Memory.** What you tell it about yourself is kept in your own words, in the one memory Work
  sessions and Pips share; **Settings → Memory** shows it all, to edit or delete.
- **Plugins.** Every plugin you turned on in **Settings → Plugins** works here: reads happen at once,
  and a change waits on a card you approve (or hand to a Pip), unless you told that plugin it never
  needs to ask. A reply that read from a plugin shows its logo.
- **Your voice.** Dictate into the box, have a reply read aloud, or talk with voice mode, which
  listens, answers aloud and listens again. The speech models run on your computer: install one in
  **Settings → Voice**.

## Where chats live

One file per chat in `~/.dgc/chat`, readable only by you. Tick **Temporary** before your first
message and the chat is never written down or listed. From your own program, the SDK's `dgc.chat()`
reaches the same chats; see **SDK**.
""".strip()),
    ("Pips", "standing agents with one job each, beside your main chat", """
# Pips

Pips are standing agents that work beside your main DGC chat. A Pip has one job, written in plain
words, and keeps it: reviewing a project's committed code every morning, running a fixed set of test
commands, drafting documentation, or helping you with your own day. Everything a Pip does that
matters is a proposal you review first. The full guide is
[docs/PIPS.md](https://github.com/OpenPeach-ai/dgc/blob/main/docs/PIPS.md).

## Project Pips and Personal Pips

A **Project Pip** belongs to one Git project and reads its committed source: Scout explores, Lens
researches a question, Rook reviews, Lock looks for security issues, Quill drafts documentation,
Patch prepares a fix in a private copy, Pulse runs the exact commands you reviewed. A **Personal
Pip** belongs to your DGC profile and helps with errands, plans and replies.

Open the Pips view with the Pips button in the DGC chat view's title bar, or ask the main chat:
"Review committed changes in this project every weekday at 9:00, and run once now." In the terminal,
`dgc pips` does the same (`dgc pips create`, `list`, `run`, `stop`, ...).

## They keep going

Pips run on your computer, in the **runner**, with no Pips account and no hosted service. **Keep Pips
running** (the Pips view's runner controls, or `dgc pips keep-running on`) starts the runner when you
log in, so a morning schedule still runs after a restart; DGC turns it on the first time a Pip gets a
schedule, a commit trigger or a routine. Up to four Pips work at once, with no daily token limit. On a
server with no desktop, run `dgc pips serve --server` (or the Docker image in `deploy/docker`) beside
your app, and `dgc pips health` says whether it is running; there, Pips use an API key or a
self-hosted model, never your Claude Code or Codex plan.

- **A Pip speaks for its runs.** Each finished run is a message from the Pip in its own chat, in
  short first-person words made from the run's report alone, so every number, file and title it says
  is the report's: "I found 4 issues, 3 of them serious." All-clear runs in a row fold into one
  message that updates itself. Reply to it there. After **Ask DGC to fix**, that message says how the
  fix is going: DGC is fixing this, Fixed · 3 files (a click opens its card in the Work chat, with
  Review and Undo), or that it didn't finish, with Ask DGC to fix again. While a run goes on, it is
  already there: one message with the Pip at work, what it is doing now, a clock, **Stop** and how it
  started (Started by you, On schedule · 9:00 AM, Asked by DGC, First run), which becomes its report
  in the same place when the run ends. A Project Pip's page is a
  Personal Pip's: its chat under a top bar with **Run now**, and History, Settings, Schedule, Handoffs,
  Changes, Memory, Context and Notifications in its **…** menu.
- **Reports reach your chat.** A project reviewer's finished run appears as a card in the chat it
  reports to: what it found and the worst of it, with **Open report**. A card never starts a turn.
  **Ask DGC to fix** starts a helper in the chat's session without starting a turn, so you keep
  chatting. It works in one copy of the project DGC keeps for fixes, with the project's own install,
  and runs the tests there when it can. The card is its live status (**Watch**, **Stop**, and a
  question it needs asked right on the card); then what it changed and whether the tests ran in the
  copy, with **Review** and **Undo**. A file you changed on the same lines meanwhile is held back. A
  **Pip fixes** chip on the chip line above the message box lists the fixes while they work.
- **Routines.** A Personal Pip does things on its own at a time, on a new email that matches a
  search, before a calendar event, or when your own app sends an event ("when the shop app sends
  order.created"): once for each event, with what the app sent as data, never as instructions. It
  suggests one as a card; nothing runs until you add it. Your app's code sends the event with the
  SDK's `pips.trigger`, which only starts what you set up.
- **Pips your code keeps.** Your own app's code can declare Personal Pips in code (the SDK's
  `PipTemplate` and `pips.ensure_all`) and keep them as declared on every deploy. Such a Pip says
  **From your code** on its page and uses only the app tools its template lists. Narrowing changes
  apply by themselves; anything that lets it do more (a new change tool, asking less, Always allow, a
  routine on your app's event) waits on its page as **Your code asks to let it do more**, with
  **Accept** and **Not now**. What you change on the Pip yourself stays as you set it.
- **Live data.** A Pulse can keep an eye on live data instead of running tests: a short list of exact
  read-only command lines you approve (a `SELECT` through a read-only database account, `df -h .`,
  `curl -s http://127.0.0.1:8000/health`). DGC runs only those lines, in a read-only box in your
  project folder, and its model sums up what they printed; every number in the summary comes from the
  output. The box reaches only the local addresses the lines name and the project's read-only
  database. A line with an obvious write is refused when you approve the list and again before a
  run, and changing the list is a reviewed change. The summary posts in the Pip's chat and reaches
  your Work chat as a report: "all clear", or "needs you" with **Ask DGC to fix**. Ask the main chat
  to set one up, or choose **Read-only commands on live data** in a Pulse's Plan & schedule. Use a
  read-only database account: `dgc readonly-db guide` shows how to make one. It runs on Linux with
  bubblewrap, on a Mac under Seatbelt (a little weaker, as its card says) and on Windows in DGC inside
  WSL 2; elsewhere the Pip says why its commands can't run.

## A Personal Pip's computer

Every new Personal Pip gets its own computer: a browser and files in a sandbox, apart from yours,
on Linux, in WSL 2 and on Apple-silicon Macs with macOS 26 or later. A Pip whose model can see uses
the whole desktop on Linux (browser, Files, Terminal, an image editor, Documents and a PDF viewer); on
a Mac it works in its browser.

- **How much it asks.** Each Personal Pip has a level you set on its page: **Ask** (every submit and
  send waits for you), **Approve for me** (routine steps such as a search, adding to a cart or saving a
  draft go by themselves; orders, posting, deleting and sending to someone new still ask) or **Full
  access**. New Pips start at Approve for me. Payments ask at every level.
- **Always allow** lets one exact kind of action through from then on, for the same account, tool or
  site; its page lists them, with **Stop allowing**. A payment never offers it.
- **Saved logins.** Save a site's login once, with its authenticator key if it has one, and DGC types
  it in, the one-time code too. The Pip never sees it.
- **Borrowing your Chrome.** For one task that needs a site you're signed in to, a Pip can ask to use
  your own Chrome. **Allow once** (Chrome asks too), and it works in a tab of its own, on the card's
  sites only, then gives your Chrome back. It asks every time; there is no Always allow.
- **You type the card.** Asked to pay, it fills in everything but the card and asks you to type it on
  its screen and press Pay. A card number sent in its chat isn't sent.

## Its brain, its memory, its tools

- **Your Claude Code or Codex.** A Personal Pip can think with the Claude Code or Codex you're signed
  in to, on your own plan. Their own tools stay off: the Pip's tools and rules come from DGC.
- **Working notes and a daily log.** It keeps short notes on how its job goes, which you can edit;
  DGC writes a daily log of its runs for you. What you tell it about yourself shows as
  **Remembered**, with **Forget**. `/learn` in its chat turns what it just did into a skill you save.
- **Apps and plugins.** Connect Gmail or a calendar from its chat; every plugin you turned on in
  Settings is every Pip's to use, and for each one you choose what it may do without asking, from
  Always ask to Never ask. A plugin that can move money always asks.

## Where Pips run

Linux and macOS, and Windows with DGC inside WSL 2: there, Windows starts the runner when you sign
in, notifications are Windows' own, and your signed-in Chrome is the one on Windows. Patch and Pulse
commands run under bubblewrap on Linux and Seatbelt on macOS, which DGC tells you is weaker; so do a
live-data Pip's commands and a Troupe checker's shell, in a read-only box that on a Mac is a little
weaker too: a command there can see which other programs are running, and Apple marks sandbox-exec as
deprecated. Pause one
Pip, or stop them all with `dgc pips stop`. From your own program, the SDK's `session.pips` manages
the Pips of your profile; see **SDK**.
""".strip()),
    ("Pasted text",
     "a tall paste, a pasted link, and characters you cannot see",
     """
# Pasted text

A paste is not typing. It can be forty lines of log, a bare URL, a whole file, or text carrying
characters that have no glyph at all. DGC handles each of those differently, and changes what you
pasted only when you ask it to.

## A tall paste folds

In the **terminal**, a paste of five lines or more — or over 600 characters — collapses to a chip in
the composer, `[Pasted text #1 +40 lines]`, so a forty-line paste no longer takes half the screen.
It expands back to the full text the moment you send. A shorter paste inserts as typed, and a field
prompt that wants one exact value (a URL, a session name) always takes the raw text.

In the **editor**, a paste of 5,000 characters or more becomes an attachment chip reading
**Pasted text · 12,480 chars** instead of filling the composer. Click it to read what it holds.
Whatever you had already typed stays where it was.

## A pasted link becomes a pill

In the editor, a clipboard holding exactly one URL and nothing else inserts a pill showing the host
and path — `github.com/OpenPeach-ai/dgc` — with the whole URL on its tooltip. What the model
receives is the URL itself, character for character: the pill shows the link, it does not replace
it. Nothing is fetched to draw it, not even a favicon, so pasting a link discloses it to nobody. A
paragraph that happens to contain a URL is prose, and is pasted as prose.

## Characters you cannot see are counted, never removed for you

Three kinds of invisible character can hide an instruction inside text that looks ordinary:

- **Bidirectional overrides** reorder how text *displays* without changing its bytes, so what you
  read and what the model reads can differ.
- **Tag characters** encode a whole line of ASCII inside something that renders as nothing at all.
- **Zero-width characters** pad text invisibly.

DGC hands your draft to a model and then acts on it, so this is a way in rather than untidiness. In
the editor a bar appears over the composer: **Remove 3 invisible characters — 2 can carry a hidden
instruction**, with **Keep** beside it. Click **Remove** and exactly those characters go, and
nothing else. Click **Keep** to say the text is deliberate, and the row goes until the draft changes
again. Ignore it and nothing changes either way: the count is a report, not an edit, because quietly
altering what you pasted would be its own bug. The bar watches the whole draft rather than only a
paste, so text you typed or dictated raises it the same way.

The bar is deliberately quiet about the harmless cases. Arabic, Persian and Hebrew carry directional
marks as a matter of course, every multi-person emoji is held together by zero-width joiners, and
the three subdivision flags are built from tag characters. None of them raise it, because a notice
that fires on ordinary text teaches you to dismiss it — which is worse than no notice. And "can
carry a hidden instruction" is said only for the two classes that actually can, so a stray
byte-order mark from a web page is not dressed up as an attack.

Two limits, stated rather than hidden. This is the editor's composer: the terminal does not show the
bar. And a paste large enough to fold into an attachment changes no composer text, so nothing counts
it yet — the text inside that chip still reaches the model.

## The editor never pastes markup

The composer is an editing host, which means the browser would otherwise insert your clipboard's
HTML into it rather than its text. DGC takes the plain text instead, on every path — so a copied web
page cannot bring an image that calls home the instant you paste, or an element laid over the Send
button.
"""),
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

When DGC asks several questions in one card, your pick stays marked for a moment, then the next
question streams in and its options appear one after another; for a moment after the card moves on,
a second click in the same spot or a held-down key can't answer the new question by accident.
Answering the last question doesn't send: the card reads "all answered" and focuses **Submit**, so
you can page back and check or change any answer first. A single question still sends on one click.
With reduced motion on, the next question simply appears.

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
and it opens again. Pointing at the card, or typing in it, stops it folding under you.

**The question outlives the turn.** The model finishing its reply does not close it: the card stays
where it is, with its options, and answering it a minute later works — the answer starts a new turn
with the question quoted above it, exactly as it reads when you answer while the turn is running.
The model also ends that reply by repeating the question and every option it offered, so the choice
is readable even in a reopened session where no card is drawn.

It closes when you move on. The next message you send that is not an answer retires the card — the
question and its options stay in the transcript as a record of what was offered — and the model is
told, in that same turn, that the card went unanswered and that your message may be the answer.
**Skip** closes it immediately instead, and says plainly that you declined.

Words you had started typing are yours, and retiring the card used to take them with it. In the
editor they come back: whatever was in the answer box is appended to the composer on its own line,
ready to send. Not on an explicit **Skip** — that is you deciding not to answer, and putting the
abandoned text back would undo the dismissal you just made.

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
install locations.

**With none, DGC fetches one**, once, and the first browser call waits for it:

- **Linux** (Debian, Ubuntu and their family): the same Google Chrome DGC downloads for Pip
  computers. It comes from Google's package repository, checked against Google's signing key, and is
  unpacked under `~/.dgc/desktop` with no admin password. Work runs it as a separate browser: it
  never shares a Pip's browser, cookies or tabs. It is re-checked for updates once a day.
- **macOS**: Google's own Chrome installer. It is opened read-only, and its app is kept under
  `~/.dgc/browser` only when macOS confirms it is intact and signed by Google LLC as Google Chrome.
  It is re-checked once a week. A Chrome in `/Applications` or `~/Applications` comes first.
- **Windows**: DGC runs inside WSL, so this is the Linux row above. A native DGC on Windows
  (experimental) uses Microsoft Edge, which every Windows 10 and 11 has, or Chrome; it downloads
  nothing.

A `browser_path` that is wrong is reported, never replaced by a download, and a download that failed
is tried again after an hour, not on every call.

Each session gets its own throwaway profile, so a page never sees your real cookies or logged-in
sessions, and the profile is deleted when the session ends.

## When Chrome can't use its own sandbox

On Ubuntu 23.10 and later, and on other distributions that restrict unprivileged user namespaces,
only a Chrome with an AppArmor profile (Google Chrome installed by its package) gets the namespaces
its sandbox needs. Any other Chrome or Chromium (Playwright's, the one DGC downloaded) is then
started inside a **bubblewrap box**, which lends them: Chrome's own sandbox runs in it and keeps
every page contained, as on any other Linux (`chrome://sandbox` says "adequately sandboxed"). The
box adds what a plain Chrome doesn't have: your home folder, with its keys and tokens, and DGC's
environment variables are not in it (not even in bubblewrap's own process). It holds the system
read-only, a fresh `/tmp`, the throwaway profile and Chrome's own files, and it ends with DGC.

bubblewrap has to be allowed to make user namespaces itself, and DGC checks that it is, not just that it
is installed: a stock Ubuntu 24.04 has bubblewrap but no AppArmor profile that lets it. There, only a
Chrome an admin installed can sandbox itself, so DGC downloads Google Chrome's package (apt checks it
against Google's signing key) and the model asks you to install it once:

    sudo apt update && sudo apt install ~/.dgc/browser/linux/google-chrome-stable_<version>_<arch>.deb

That puts Chrome in `/opt/google/chrome`, which Ubuntu's own AppArmor profile covers, and apt keeps it
updated. The model is told not to work around it: no browser with `--no-sandbox`, and no change to
`browser_allow_unsandboxed`. That setting stays yours: it runs the browser without a sandbox, so a page
exploit is no longer contained.

## Your own Chrome, signed in

For a task that needs your logins (your email, a dashboard you're signed in to), the browser can use the
Chrome you're running, with `signed_in: true`. DGC opens a window of its own there and works in that one
tab: it never reads or touches your other tabs, never reads cookies or storage, and closes its tab when
the session ends. Pips don't use it; they have computers of their own.

Turn it on once in Chrome 144 or later: open `chrome://inspect/#remote-debugging` and allow remote
debugging. Chrome then asks you every time DGC connects, and shows its "controlled by automated test
software" banner while it is. DGC finds it through the `DevToolsActivePort` file Chrome writes in its
profile folder (Google Chrome, Chrome Beta, Edge, Brave and Chromium, on Linux, macOS and Windows).

**DGC in WSL** uses the Chrome you run on Windows. It finds Chrome's profile on the Windows drive and
connects straight to it when WSL shares Windows' network (mirrored networking); otherwise Windows
PowerShell connects on the Windows side and passes the connection along. Chrome asks you the same way.
If WSL interop is turned off in the distro and the network isn't mirrored, DGC says so and how to fix it.

Opening a site asks you first, **in every mode, auto included**: "Use your signed-in Chrome on
mail.google.com?". Allow once is that visit; Always allow saves `Browser(signed-in:https://mail.google.com)`,
that site and nothing else. A site is its origin: scheme, host and port, written as Chrome writes it
(`http://bank.test:80/` and `http://BANK.test./` are `http://bank.test`). A rule written for the
throwaway browser never covers your signed-in one, but a deny does, checked against the page the tab is
on: `Browser(signed-in:*)` in `deny` turns it off, `Browser(signed-in:https://site/private*)` covers
that path, and an `ask` rule for a site makes clicks and typing there ask too.

Reading and acting happen only on a site you allowed. When a redirect, a click or the page itself takes
the tab to another site, DGC reads nothing of it (each read is judged by the page it actually read), and
opening that site asks you again. A click or keypress never carries an address. Password, card and
one-time-code fields are never read out, alerts are dismissed rather than left blocking the tab, the
console and network log start again with each page, and tabs DGC's page opened close with it. Plan mode
never uses it.

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
- `/sandbox on` · `/sandbox off` — turning it on also denies the `python` tool, which runs outside
  the sandbox; turning it off takes back only the rules `/sandbox` itself added.
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

## Sandboxed sub-agents

A delegated sub-agent works in a private Git worktree whose `.git` is a pointer into your
repository, so the repository directory is re-exposed **read-only** inside the sandbox — otherwise
the pointer dangles and the child cannot run one git command. It gets `.git` only, never the
repository's working tree: the ignored files its worktree deliberately does not have (`.env`,
`node_modules`) stay out of reach, and so does your own uncommitted work. A sandboxed sub-agent can
therefore read history, run `git status` and `git diff`, and **cannot commit** — which is
deliberate, because DGC integrates a sub-task by reading its working tree, never its commits.

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

The same rule holds in every folder an agent works in: an agent opened with `/new DIR` works in the
folder itself, and a second one in a checkout an agent already works in gets a `dgc/fleet-*`
worktree of that folder's project.

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

Delegation is refused outright in one case: a project that tracks two paths differing only in case
on a filesystem that stores them as one file (macOS and Windows by default). There, an isolated
checkout reports them as changed before anything touches them, and integrating its result would
write one file's content over the other's. DGC names both paths and suggests `git mv`; renaming one
makes delegation work again, as does keeping the project on a case-sensitive volume.

`subagent_worktree_root` (empty = `~/.dgc/worktrees`) must sit outside the source repository. A
delegated checkout has no `node_modules`, `.venv` or build output — the sub-agent is told what is
missing and provisions its own. `subagent_link_paths` shares named Git-ignored directories with it
instead, trading that isolation for the install time.

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

### The window the server was started with

vLLM, SGLang and llama.cpp set the context window when they start: vLLM with
`--max-model-len`, SGLang with `--context-length`, `llama-server` with `-c` (each of its
parallel slots gets its share unless they share one cache). Nothing DGC sends can change it, so
DGC reads it from the server (its model list, or an older `llama-server`'s `/props`) and uses
it from the first turn: the context meter reads **Set by the server: 32K** with how to change
it there, and `/context` says the same. A model you have not chosen a window for gets the
server's whole window; a window set above it can't apply, and a smaller one of your own only
makes DGC compact sooner (Settings → General → Context size). Restart the server with another
size and DGC sees it within a minute. Prompt caching on these servers is the server's own
(vLLM's prefix cache, llama.cpp's prompt cache) and works by itself: every request starts the
way the last one did. Thinking is switched with `/think`, as for any model. Any other
OpenAI-compatible server on this computer or network is asked the same way, so vLLM on a port
of its own is found too.

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
batch — one `task` call that lists them all in `tasks`, up to 8 at once under Ultra, or the
`max_parallel_tasks` width if you set one (default 4 outside Ultra, at most 32; concurrent in auto
mode) — then
integrates and runs the tests. A sub-agent starts cold, so it only saves time beside others: a
single part, parts that share files or one investigation, and edits the lead already knows stay
with the lead. Critic reviews a change when you ask for a review or when no test can check it.
Long work that does not block the rest of the turn can use `task` with `background: true`; in the
editor, and in the terminal while wake-ups are on, DGC starts a wake turn when that child lands.

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

## The prompt cache's clock

In the editor's Work chat, a small clock after the context meter says how long the provider keeps
this conversation cached, so the next message is read from the cache instead of at full price:

- **4m** beside the clock: the cache is warm, about four minutes left. It changes once a minute,
  never in seconds. Its tooltip says "Prompt cache warm, about 4 min left."
- **The clock alone, in the error colour:** the cache has gone. The tooltip says why: likely
  expired after so long idle, the conversation was compacted past it, or Ollama unloaded the model.
- **No clock:** DGC cannot know. It is shown only where the provider says so itself, and only
  after a reply used a cache: Anthropic's own cache report, and the lifetime its cache write used
  (`prompt_cache_ttl`, 5 minutes or 1 hour, counted from the start of the request), and a local
  Ollama's own unload time for the loaded model (`ollama_keep_alive`). OpenAI, DeepSeek, Ollama
  cloud models and subscription CLIs do not publish one, so no clock is shown for them, though their
  caches still work.

Reopening a chat whose cache has gone adds one line to it: "Idle 2h 5m. The prompt cache has likely
expired, so your next message will re-cache about 180k tokens." The clock is in Work only, not in
ChatDGC or Pips. `dgc serve` sends it as a `cache_clock` event.

## Privacy

Everything stays on this machine, in `~/.dgc/usage.sqlite` (readable only by you). No prompt or
reply text is stored, and an endpoint is recorded by host and port only, never its full address,
path or any credential. Rows older than 400 days are removed automatically. To start over, quit
DGC and your editor first (a running DGC keeps the file open and would go on counting into the
deleted copy), then delete `usage.sqlite` together with its `usage.sqlite-wal` and
`usage.sqlite-shm` companions; DGC creates a new one the next time it runs.
""".strip()),

    ("Web search", "DuckDuckGo by default; Brave, Tavily, Ollama or SearXNG if you set them", """
# Web search

The native agent gets a `web_search` tool when the request needs current information (versions,
docs, news, facts). It returns titles, URLs and snippets; `web_fetch` then reads a result URL as
text. A live page that has to run JavaScript is **Looking at a page**, not this.

DuckDuckGo is the keyless default. `dgc setup` or `/search` picks another backend.

- `/search` — show the current provider.
- `/search duckduckgo` — keyless, and tried three ways in order: the `ddgs` client DGC ships
  with, then DuckDuckGo's HTML endpoint, then its lite endpoint. The first one that returns
  results answers; only if all three come back empty do you see an error.
- `/search brave` · `/search tavily` — prompts (masked) for that provider's own API key. With a
  key already saved for it, Enter keeps that key and a single `-` removes it.
- `/search searxng <url>` — a self-hosted instance. `search_url` in config is that base URL.
- `/search ollama` — Ollama's web search. If Ollama on this computer is signed in (`ollama signin`,
  Ollama 0.18 or later), it searches with that sign-in and needs no key: DGC asks the Ollama at
  `OLLAMA_HOST` (default `http://127.0.0.1:11434`), which signs the request to ollama.com itself.
  Otherwise paste an ollama.com API key at the masked prompt (ollama.com → Settings → API keys);
  Enter leaves none. It is Ollama's own key, and is used only when the local Ollama can't search (not running,
  too old, not signed in, or its cloud features turned off). Results carry each page's text, and
  DGC keeps the start of it as the snippet. Ollama has no image search.

Brave, Tavily and Ollama each keep their own key, in `~/.dgc/secrets.json` (owner-only, never in
`config.json`) as `search_api_key_brave`, `search_api_key_tavily` and `search_api_key_ollama`.
A search sends only the key saved for the provider in use: switch from Brave to Tavily and your
Brave key stays Brave's. Switch back and it is used again.

In the TUI, `/settings` → **Web search** sets the provider, the selected provider's own key (typed
masked, never shown back; blank removes it) and the SearXNG address. The editor's **Settings → Web
search** sets the same: its key field says whether the chosen provider has a key saved ("Saved", or
empty), and **Remove** clears that provider's key, and only that one.

`DGC_SEARCH_API_KEY` is the key of the provider selected when DGC starts, for that launch only. It is
never saved, never carried over when you switch provider, and not used at all when DuckDuckGo or
SearXNG is selected at start.

Older releases kept one key for Brave, Tavily and Ollama together. The first time this release
starts, that key becomes the own key of the provider selected then. If DuckDuckGo or SearXNG was
selected, DGC can't tell whose key it was, so it keeps it in `secrets.json` as
`search_api_key_unassigned` and never sends it anywhere: enter the key again for its provider
(`/search brave`, `/settings`, or Settings → Web search).

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
  response storage is acceptable. On Anthropic Messages, `prompt_cache` (default on) marks where
  each request's cached prefix ends (the tool list, the system prompt, the newest message and the
  previous request's end), so the next request reads the conversation from Anthropic's cache instead
  of paying for it again; `prompt_cache: false` sends no marker.
- `prompt_cache_ttl` (default `5m`) — how long an Anthropic cache entry lives: `5m` (a write costs
  1.25x the input price; every read refreshes the five minutes) or `1h` (a write costs 2x; for replies
  usually more than five minutes apart). Settings → Models → Cache lifetime sets it too. A server
  that refuses the one-hour lifetime gets the five-minute one.
- `provider_capabilities`, `capability_cache_ttl_s` — explicit feature overrides and the bounded
  interval before DGC retries a capability that an endpoint/model rejected.
- `context_size` — requested operating window. The window you choose is remembered for that model
  (`model_context_sizes`, written by DGC), and switching back to the model restores it. A cloud model
  you have not chosen one for (an API, or an Ollama cloud model) starts at a moderate window: its
  family's usual one and at least 128K, never above the maximum its provider reports (Ollama's model
  details, Anthropic's Models API). Its maximum is one choice away in the context meter: a bigger window
  means more input on every turn before DGC compacts. On this machine a model gets a memory-conscious
  window for its family (Qwen3.8 64K, Qwen 32K, …) that never exceeds what the model holds. A provider that
  reports no maximum and refuses a request as too long ("maximum context length is 262144") teaches
  DGC that limit for that endpoint and model (kept in `~/.dgc/model-limits.json`); later requests,
  and later sessions, fit it. The meter then reads "256k · this model's max". vLLM, SGLang and
  llama.cpp set the window when they start (`--max-model-len`, `--context-length`, `-c`): DGC reads
  it from the server and never goes above it, a model you have not chosen a window for gets all of
  it, and the meter reads "Set by the server: 32K".
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
- `pips_model` — the model every Pip on Default uses, on DGC's own connection; empty (the default)
  follows DGC: its model, or its subscription CLI. Settings → Agents → Pips sets it in the editor, and
  the Pips runner picks a change up without a restart while its connection is unchanged.
- `subagent_context_size` — each sub-agent's context window in tokens, as `context_size` is the main
  model's (0, the default, uses the main window). A named agent's own `context_size:` frontmatter
  wins. `/subagent context 64k` sets it; so does Settings → Agents in the editor. The sub-agent
  route (`subagent_model`, host, transport, key, window) may change mid-turn: it applies from the
  next sub-agent, as a new main model applies from the next request.
- `subagent_worktree_root` — optional private storage for automatic delegated checkouts; empty uses
  `~/.dgc/worktrees`. It must be outside the source repository.
- `subagent_link_paths` — empty by default, and normally left that way. A delegated checkout holds
  tracked files only, so the project's ignored dependency and build directories are not in it; the
  sub-agent is told which ones are missing and installs what it needs into its own checkout, where
  the work is thrown away with the checkout. Listing a path here shares the project's real directory
  with every sub-agent instead, so an install runs once — and so a sub-agent's writes land in your
  own copy immediately, outside `/rewind` and outside the delta `/tasks apply` reviews. Only
  Git-ignored paths can be shared; anything else is refused, because a shared path must never reach
  the integrated result.
- `fleet_worktree_root` — optional private storage for automatically isolated TUI agents; empty uses
  `~/.dgc/fleet-worktrees`. Conversation resume state remains scoped to the source project, and
  changed managed checkouts are retained rather than force-removed.
- `max_parallel_tasks` — bounded `task` fan-out (default 4, maximum 32; set 1 to disable). Each
  sub-agent is its own checkout of the project and its own stream of model requests: a cloud API
  rate-limits a wide fan-out, and a local Ollama serves only `OLLAMA_NUM_PARALLEL` at once while the
  rest wait. In a
  Git-backed full-auto turn, two or more independent `task` calls emitted together are snapshotted
  from one parent baseline, run concurrently, and integrated in call order. One `task` call can also
  list 2-32 helpers in `tasks` (each with its own `description`, `prompt` and `agent`): they start
  together the same way, past this width the rest wait for a free worker, and the call returns every
  helper's result in the order listed (with `background: true`, at once with every helper's id;
  background helpers past the width wait queued for a slot). Hooks, interactive
  permission modes and non-Git projects keep the normal serial path. A batch may mix tools: the
  task calls fan out when they are the LAST calls in the response, so a `todo`, an edit or a bash
  command beside them runs first, in order, and nothing is reordered past a running child. A task
  call that is not part of that trailing run keeps the whole batch serial.
- `max_subagent_depth` — how deep `task` may nest (default 1, maximum 8). 1 keeps the tree flat:
  the agent you are talking to delegates, and its children do their work themselves. Raise it to 2
  when a lead should be able to delegate research that itself fans out; 0 turns delegation off
  entirely. Depth is counted from the real parent chain, so a sub-agent cannot talk its way past
  it: past the limit `task` is not offered, and a call to it is refused naming the depth it is at.
  Under DGC Ultra this is what keeps an aggressive lead from fanning out recursively.
- `language_servers`, `code_intel_timeout`, `code_intel_lsp_idle_s` — optional stdio LSP commands
  for definitions, references, symbols, and diagnostics. Key by language (`python`) or extension (`.py`):
  `{"language_servers":{"python":{"command":"pyright-langserver","args":["--stdio"]}}}`.
  The bounded dependency-free static analyzer works without LSP. Servers use a minimal environment,
  no shell, and serialized requests per project/server spec. At most four sessions stay warm
  (default 120 seconds); idle and failed sessions retire. Approved external-file queries always
  run one-shot. Set `code_intel_lsp_idle_s` to `0` for one-shot isolation everywhere.

## Credentials

The `api_key`, `subagent_api_key` and `fallback_api_key` values, and each web search provider's
own key (`search_api_key_brave`, `search_api_key_tavily`, `search_api_key_ollama`), never live in
`config.json`; they are written to `~/.dgc/secrets.json` with owner-only permissions, and each can
be supplied by environment variable instead (`DGC_API_KEY`, `DGC_SEARCH_API_KEY` for the web search
provider selected at start, …). On the
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
- `turn_token_budget` (default `0`, meaning no limit) — token budget for a turn, counting every
  sub-agent the turn started, however deep and whether or not it is still running in the background.
  A detached sub-agent is charged to the turn that asked for it, not to whichever turn is running
  when it finally reports. At 70% and 85% the model is told to converge; past 100% a new `task` is
  refused and the turn stops requesting model output. Nothing is rolled back: unlike the wall-clock
  limit, which restores the last test-passing state because a kill is coming, the tokens already
  spent bought the edits on disk and discarding them would pay for nothing. Use this, not
  `turn_budget_s`, to cap what a turn COSTS; `turn_budget_s` bounds a turn that HANGS.
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
- `ollama_keep_alive` (default `30m`) — how long a local Ollama keeps the model loaded after the last
  reply, so the next request starts at once and reuses the conversation Ollama already read. A
  duration (`5m`, `30m`, `1h`, `24h`), seconds, `-1` (until Ollama stops) or empty (send nothing:
  Ollama's own default, 5 minutes). Settings → Models → Keep the model loaded sets it for a local
  Ollama. Ollama cloud models are not loaded on your computer, so it does nothing for them.
- `prompt_cache_key` — an explicit cache key for providers that support prompt caching.

## Web search

- `search_provider` (default `duckduckgo`) — which backend answers the agent's web searches:
  `duckduckgo`, `brave`, `tavily`, `searxng` or `ollama`. DuckDuckGo needs no key: it uses the
  bundled `ddgs` client, falling back to DGC's own HTML and lite parsing. Ollama needs no key when
  Ollama on this computer is signed in; otherwise it uses its own key (an ollama.com API key).
- `search_url` — a custom endpoint for a self-hosted search backend; empty uses the provider's own.
- `search_api_key_brave`, `search_api_key_tavily`, `search_api_key_ollama` — each provider's own
  key, in `secrets.json` (above). A search sends only the key of the provider in use. A key an older
  release shared between them is moved once (**Web search** above). Web providers use bounded
  transport timeouts.

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
