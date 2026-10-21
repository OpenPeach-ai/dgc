# Pips

Pips are standing agents that work beside your main DGC chat. A Pip has one job,
written in plain words, and keeps it: reviewing a project's committed code every
morning, drafting documentation when a folder changes, running a fixed set of test
commands on a schedule, or helping you plan your week.

Pips are careful by design. Everything a Pip does that matters, from its own setup
to a file fix or an email, is a proposal that you review first. The model drafts;
you approve.

Pips ship in DGC CLI 0.48.0 (`dgc pips …` and the main chat's Pips tools), the VS
Code extension 0.33.0 (the Pips view, setup cards and review dialogs) and SDK 0.7.0
(`session.pips`). For contracts and limits in detail, see
[PIPS_REFERENCE.md](PIPS_REFERENCE.md).

## The characters

Each Pip is one of eight characters. A character is a look and a role, not a
permission: what a Pip may do is fixed by its reviewed job and by the rules on this
page.

| Character | Role | What it does in a project |
| --- | --- | --- |
| Core | Main chat | Core is your main DGC chat. It coordinates the conversation and cannot be created as a Pip. |
| Scout | Repository exploration | Reads the approved source to orient a review: layout, entry points, component boundaries. It runs no commands. |
| Lens | Repository research | Investigates one question using the approved source files. It does no web research. |
| Patch | File fixes | Edits only reviewed paths in a private copy of the project. Every fix needs its own approved handoff. |
| Rook | Code review | Reviews the approved source for correctness and maintainability. |
| Pulse | Test execution | Runs exact commands, either through a reviewed handoff or from a separately approved verification plan. |
| Lock | Security review | Reviews the approved source for potential security issues. It runs no exploits. |
| Quill | Documentation drafts | Writes a private Markdown draft from the approved source, with checked citations. It does not change project files. |

Scout, Lens, Rook and Lock save a **report**: a summary, findings with exact source
excerpts, and the limits of what was inspected. DGC checks every quoted excerpt
against the source, but a finding is still the model's assessment, not a verified
bug. No Pip claims that tests passed unless DGC itself recorded the result.

## Project Pips and Personal Pips

A **Project Pip** belongs to one project folder, which must be the root of a Git
repository. It reads the project's **committed** source at a Git ref you choose
(`HEAD` by default). Uncommitted and untracked changes are not included. For a
manual review of work in progress you can propose a separately reviewed
"current tree" source; that Pip then runs only when you ask, never on a schedule
or trigger.

### What a Pip's copy leaves out

Each run reads a private copy of the source. Under the current source rules
(`safe_source_v2`, what new Pips use) a big working project doesn't stop it:

- **Files it can't copy are left out and listed**, never fatal: files over 4 MiB
  (videos, dumps, big images), links and submodules, and in a copy of your current
  files also hard links, special files and files holding one of your configured
  secrets. A run copies up to 256 MiB.
- **You choose what else to leave out**: a `.dgcignore` file (written like
  `.gitignore`, in any folder; committed, for a Pip on committed code) or the Pip's
  **Excluded folders** on its page under Source, such as `uploads/`,
  `docs/screenshots/` or `*.mp4`. A Pip on your current files also follows the
  project's `.gitignore`. These only ever leave things out: no `!` line brings
  back `.env` files, keys or the other files DGC never copies.
- **The Pip is told** what its copy left out and why, so it doesn't report those
  files as missing, and each run's report lists them.
- **Check size** on the Pip's page (or `dgc pips source PIP`) says whether the source
  fits before anything runs. When it doesn't, the message names the biggest folders
  and how much to leave out.

A Pip set up before these rules keeps the original ones (`safe_source_v1`): one file
over 4 MiB, a link, or more than 64 MiB of code fails every run, and the failure says
which files and folders. Move it to the current rules once: on its page, under
Source, choose any Excluded folders and **Save**, or run
`dgc pips propose PIP --expected-version N --source-rules v2` and accept it. Its first
report after the change isn't compared with the earlier ones.

A **Personal Pip** belongs to your DGC profile rather than a project. It is
available from any project on this computer and is meant for your own tasks:
planning, summaries, reminders drafted for you to send, research from a few fixed
pages. A Personal Pip has no project files, no shell and no browsing. It can use:

- app reads and web reads that you approve as part of its job;
- drafts of emails, calendar events and connector actions, which you review and
  send yourself.

Any character can be a Personal Pip, but in Personal scope the character is only a
look: the job is whatever its approved goal says.

In the Pips view, switch between the current project and **Personal** with the
scope picker. In the CLI, add `--personal` to a command.

## Creating a Pip

Pips are on by default. Open the Pips view with the Pips button in the DGC chat
view's title bar or the **DGC: Open Pips** command.

**From the Pips view.** Choose **Describe a job**, say what the Pip should look
after and when, then choose **Describe to DGC**. This prepares a message in the main
chat; nothing is sent until you send it. If you'd rather pick the character and
fields yourself, choose **Advanced: choose a Pip** (or **Choose a Pip myself** for a
Personal Pip).

**From a starter.** The Pips view's **New** lists starter Pips for common jobs:

| Starter | Pip | Runs |
| --- | --- | --- |
| Review each commit | Rook, this project | After each new commit to the branch, at most every 5 minutes |
| Nightly security review | Lock, this project | Daily at 02:00 in your time zone |
| Morning brief | Personal | Weekdays at 07:30, from up to four pages and searches you name |
| Watch a page for changes | Personal | Daily at 09:00: what changed on the page since last time |
| Market brief | Personal | Weekdays at 08:30: news on the companies you name, with sources; never trades or advises |
| Weekly research digest | Personal | Mondays at 09:00: what is new on your topics, no repeats |
| Release watch | Personal | Daily at 10:00: new releases of tools you depend on, breaking changes first |
| News on a topic | Personal | Daily at 08:00: at most five items, each with its source |

The Personal starters read only the pages and searches you name, so they need no
connected account; all but the morning brief need at least one. Each run sees its own
previous result, so a watch says what changed and a digest doesn't repeat itself.

Choose one, adjust the branch, time or reads, and choose **Prepare setup card**. The
card opens in its review straight away; approving it is still your decision. From the
CLI, `dgc pips starters` lists them and `dgc pips starter commit-review` (or
`nightly-security`, `morning-brief`, `page-watch`, `market-brief`, `research-digest`,
`release-watch`, `daily-news`) shows the exact job and asks before creating it.
`--branch`, `--time`, `--timezone`, `--web-page` and `--web-search` change the
choices; `--yes` approves the job shown without the question.

**From an answer.** Each answer in the chat has **Make this a Pip** (the calendar
button). It drafts the ask in your composer, "make this a Pip that does it on a
schedule", with your original request; adjust it and send. Nothing is created until
you allow it. And when you start a chat with work you have started
chats with before, the chat may offer once to make it a Pip; say no and it won't ask
again in that chat.

**From the main chat.** Just ask, for example: "Review committed changes in this
project every weekday at 9:00 Europe/London, and run once now." The main chat loads
its Pips tools and proposes the Pip with a tool call. In auto mode the Pip is created
and on at once, and the reply shows one line: "Morning review is on", with when it
first runs and **Open in Pips**. In the default and accept-edits modes the Pip docks
above the chat box, where questions dock: its face and name, what it will do, and
chips for when it runs, what it reads and its model. Choose **Create Pip** (or
**Create & run**, or **Update Pip** for a change to a Pip you have), **Details** for
the project folder, the source, the next run time, the exact reads and the model, or
**Not now**. The **×** puts it aside: it waits in the reply, where **Review** docks it
again. Plan mode refuses it. Pause, change or delete it any time in the Pips view.

Two kinds of Pip always dock for your choice, even in auto mode: one that reads your
connected accounts (mail, calendar, files), and a Pulse that runs commands. Those run
with nobody watching, long after the chat ends. A card expires after seven days, or
sooner if the next run time it shows has already passed.

The main chat can set up Scout, Lens, Rook and Lock reviews, Quill drafts, Pulse
command plans and Personal Pips. A new Scout, Lens, Rook, Lock or Quill can run after
each new commit instead of on a schedule. The main chat cannot set up Patch or the
other event triggers; use the Pips view or the CLI for those.

**From the CLI.**

```sh
dgc pips create "Code reviewer" --type rook --goal "Review committed changes for correctness risks"
dgc pips create "Week planner" --personal --goal "Help me plan my week from what I tell you"
dgc pips list
```

`--type` defaults to `rook`. `--model` picks a model from `dgc pips models`; without
it the Pip uses your DGC default model. A Project Patch or Pulse Pip needs
`--reviewed-execution`, which acknowledges that creating it grants no standing
permission to edit or run anything. Setup cards prepared in the chat can also be
reviewed here:

```sh
dgc pips setup list
dgc pips setup show SETUP_ID
dgc pips setup accept SETUP_ID --expected-digest DIGEST
```

## Your own Claude Code or Codex (Personal Pips)

A Personal Pip can think with the Claude Code or Codex you are already signed in to, on
your own plan. Open its chat, choose the model under the chat box, and pick **Claude
Code** or **Codex** under **Your subscriptions**. Only the ones installed and signed in on
this computer are listed. **Same as DGC** follows DGC: when DGC's own default is Claude Code
or Codex, the Pip uses it too, with DGC's model and effort for it. The Pip's thinking
setting in its chat box becomes the CLI's effort.

Its replies and its routines use your plan's usage, as your own chats in that app do; the
picker says so once when you choose it. Nothing else changes: there are no new settings. From
the CLI: `dgc pips models` lists them, and `dgc pips create --personal --subscription codex`
(or `dgc pips propose PIP --subscription claude`) chooses one.

The CLI is only the Pip's model. Its own tools are switched off, and the Pip's tools (its
computer, its connected apps and drafts, its choices and cards, its routines and notes,
web search) reach it from DGC for that one run. So every Pip rule still holds: its
computer holds every submit and every payment for you, careful mode, the card rule (a
Pip never types a card; one typed in its chat is refused), screenshot masking, Allow
cards and routines work exactly as with a local model, and its chat and computer show
the run the same way. DGC never reads, copies or refreshes the CLI's login; the CLI uses
its own.

How each CLI is held to DGC's tools (checked by trying, with Claude Code 2.1.266 and
Codex 0.153.4):

- **Claude Code** runs `claude -p --input-format stream-json --output-format stream-json
  --tools "" --restricted --setting-sources project --strict-mcp-config --mcp-config
  <run file> --allowedTools mcp__dgc --permission-mode dontAsk --disable-slash-commands
  --no-session-persistence --no-chrome --system-prompt-file <run file>`, with
  `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
  `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`, `CLAUDE_CODE_DISABLE_ATTACHMENTS`,
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` and `ENABLE_TOOL_SEARCH=false`. Its model is
  offered exactly `mcp__dgc__*`: no Bash, Read, Edit, Write, WebFetch, WebSearch or Task,
  none of your MCP servers, hooks, skills, plugins or CLAUDE.md.
- **Codex** runs `codex exec --json --skip-git-repo-check --ephemeral
  --ignore-user-config --ignore-rules --sandbox read-only` with `approval_policy="never"`,
  `web_search="disabled"`, its shell, unified exec, view_image, apps, plugins,
  sub-agents, image generation, browser and computer use, hooks and memories features off,
  no skills, project docs, permission or environment notes, and a copy of its own model
  catalog (`codex debug models`) with each model's `apply_patch_tool_type` null,
  `shell_type` disabled, tool search, sub-agents and code mode off. Its model is offered
  DGC's tools, Codex's MCP-resource readers (they reach only DGC's server, which has no
  resources) and `request_user_input`, which Codex offers only in plan mode.
  Codex still reads your global `~/.codex/AGENTS.md`, instructions only, with no tool to
  act on them.

Each runs in the run's own private folder, never a project, with an environment that has
no DGC key or token (only paths, locale, proxies and the CLI's own `CLAUDE_CONFIG_DIR` or
`CODEX_HOME`), inside the run's process group, so stopping the run stops it. The Pip's tools
come from a socket in a private folder that only the token minted for that run opens. If
the CLI ever reached for a tool of its own, DGC stops the turn and says so in one line.

Not offered for Pips: **Kimi Code** (it always starts your own MCP servers, from
`~/.kimi-code/mcp.json`, and approves every tool in prompt mode), and **Qwen Code** and
**Copilot CLI** (neither could be checked by trying here, so neither is offered).
**Project Pips** (audits, Pulse, Quill, Patch) still need a local or API model: their
source checks run only in DGC's own loop. Choosing a subscription for one is refused with
that line.

## The runner

A Pip's work runs in the **runner**, a local process separate from your chats.
Without it, runs and Pip replies wait in the queue and schedules don't fire.

**Keep Pips running** (in the Pips view's runner controls, or `dgc pips keep-running on`)
is the one switch most people want. The runner then starts when you log in and after a
restart, and is restarted if it fails, so a morning schedule still runs after a reboot.
On Linux it also keeps running while you are logged out, where the system allows it
(systemd "lingering"); `dgc pips keep-running` says whether yours does. In WSL, Windows
starts it when you sign in (see **Windows** below). Turning it off
stops the runner starting on its own; the runner running now keeps going until you stop
it. It never turns Pips on and never clears an emergency stop.

**DGC turns it on for you** the first time a Pip gets a schedule, a commit trigger or a
routine, so the schedule doesn't depend on VS Code being open, and says so: "Your scheduled
Pips now run even when VS Code is closed." Once you turn the switch off yourself, DGC leaves
it off and says the schedule runs only while Pips are running. When it can't turn it on
(the system refuses, or lingering on Linux needs `sudo loginctl enable-linger $USER`), it
says what to do; the Pip is created either way.

Otherwise:

- **Start runner** in the Pips view. The runner keeps going when the editor
  closes, until you log out, restart or stop all Pips.
- `dgc pips serve` in a terminal you leave open. Ctrl+C stops it; queued work
  stays queued.
- On Linux, the systemd user service behind the switch, step by step:

  ```sh
  dgc pips service preview    # show the exact unit first
  dgc pips service install
  dgc pips service start
  dgc pips service enable     # start it when you log in
  ```

  Installing, starting and enabling are separate steps, and none of them turns
  Pips on or clears an emergency stop. The service doesn't see your shell's
  environment variables, so keep your model key in DGC's settings rather than in
  an environment variable.

`dgc pips status` shows whether the runner is online and how much work is queued.
The runner does one run at a time.

**Platforms.**

| | Linux | macOS | Windows (DGC inside WSL 2) |
| --- | --- | --- | --- |
| Pips view, Pip chats, audits, Quill drafts, Personal tasks | Yes | Yes | Yes |
| Patch fixes and Pulse commands | With bubblewrap (`/usr/bin/bwrap`, `python3`, `git`) | Under Seatbelt, with Xcode or the Command Line Tools; weaker, see below | As on Linux (`sudo apt install bubblewrap`) |
| Keep Pips running | systemd user service; also while logged out, where the system allows lingering | LaunchAgent, while you are logged in | Windows starts the runner when you sign in (`wslg.exe`, from your own Run list), which keeps WSL running |
| Desktop notifications | `notify-send`, when a notification service is running | Notification Center | Windows notifications |

`dgc pips execution` shows whether this runner passed its confinement check. A Pulse of
local page checks only (`dgc-http-check`) needs no sandbox and runs anywhere Pips run.

**Stock Ubuntu 23.10 and later (24.04 included)** let only programs with an AppArmor
profile make user namespaces, so bubblewrap is installed but can't start the sandbox.
`dgc pips execution --fix` says so and shows the one-time fix (Ubuntu's own
`bwrap-userns-restrict` profile, as for a Pip's computer); in a terminal it asks, then
runs it with your own sudo password. DGC never runs sudo by itself, and the model's shell
can't run `--fix`. `dgc doctor` and the end of `dgc setup` mention it once. A Pulse set up
on such a computer says on its card that it can't run here yet; if its schedule keeps
failing to start, DGC tries again after 30 seconds, then twice as long each time (at most
an hour), and from the third time tells you once: in the Pips digest and as a desktop
notification. The Pip's status (`dgc pips list`, and what the chat reads) says why.

**Windows means DGC inside WSL 2.** DGC installs into WSL (the installer is a shell script),
and VS Code or Cursor connects to it there, so Pips are the Linux ones. Three things differ,
and DGC handles each:

- **WSL stops a distro when nothing on Windows holds it open**, soon after you close the
  editor, systemd services included. So *Keep Pips running* doesn't use systemd there: Windows
  starts the runner when you sign in, through WSL's own launcher that opens no window, and while
  it runs WSL keeps the distro running. Without it, Pips run while the editor is open.
- **WSL 1 has no Linux kernel of its own**, so Pips can't box commands or have a computer there.
  Switch the distro to WSL 2 in Windows: `wsl --set-version <distro> 2`.
- **Notifications** are Windows' own, shown through Windows PowerShell.

This needs WSL interop (on unless `/etc/wsl.conf` turns it off).

On Windows outside WSL (a native DGC, experimental) the Pips view says Pips are not available,
the main chat has no Pips tools and `dgc pips` explains the same, so nothing can be created that
would never run.

**macOS is weaker than Linux, and says so.** On macOS commands run under Seatbelt
rather than in a private namespace. The project copy is still read-only, the network
is still off (loopback included, so a test that starts a local server fails), and
home folders, DGC state and other runs stay unreadable. But there is no process
namespace: memory, the number of processes and the scratch folder are checked by
sampling about every 50 ms rather than enforced by the kernel, and a process that
detaches faster than one sample can outlive its command (still inside the sandbox).
System folders such as `/usr` and `/Library` stay readable, and Apple marks
`sandbox-exec` as deprecated. The editor and `dgc pips execution` list these
limitations. See [PIPS_REFERENCE.md](PIPS_REFERENCE.md) for the exact policy.

## Schedules and event triggers

A Pip can run by hand, on a schedule, or when something happens in the project.
Adding either is a job change that you review like any other.

**Schedules** (one per Pip):

| Kind | Example | Notes |
| --- | --- | --- |
| Every N minutes | `--every 60` | 5 to 10,080 minutes, counted from when the schedule was set |
| Daily | `--daily 09:00 --timezone Europe/London` | Needs an IANA time zone |
| Cron | `--cron '0 9 * * 1-5' --timezone Europe/London` | Five numeric fields; runs at least five minutes apart |
| Once | `--once 2026-11-01T09:00:00+00:00` | Seconds and an explicit offset; must still be in the future when approved |

```sh
dgc pips schedule PIP_ID --expected-version 1 --daily 09:00 --timezone Europe/London
dgc pips show PIP_ID                      # read the saved proposal
dgc pips accept PIP_ID PROPOSAL_ID --expected-version 1
```

Schedules fire only while the runner is running. If it was off, or the computer
was asleep, the Pip runs once for the latest missed time rather than catching up
on each one. If the Pip is paused or already busy at a scheduled time, that time
is skipped. A scheduled or triggered review is also skipped when nothing has
changed since its last report: the same commit, job version, model and workspace
context could only repeat it. The digest counts these skips; **Run now** always
runs. On a daylight-saving change, a local time that doesn't exist is
skipped and a repeated one runs once.

Scout, Lens, Rook, Lock and Quill can have schedules. Pulse can run on a schedule
only with a reviewed verification plan. Patch never runs on a schedule. Personal
Pips use [routines](#routines) instead: several per Pip, at a time, on a new email or
before a calendar event.

**Event triggers** start a run when one of these happens:

| Event | Fires when |
| --- | --- |
| `commit_changed` | This Pip's Git ref moves to a different commit |
| `committed_paths_changed` | That change touches files or folders you listed (`--path`, `--directory`) |
| `finding_accepted` | Someone accepts a finding of any Pip in the workspace |
| `context_updated` | Workspace context is recorded, archived or promoted |
| `session_turn_completed` | A main-chat turn in this workspace finishes and is saved |

```sh
dgc pips trigger PIP_ID --expected-version 2 --events commit_changed --minimum-minutes 30
```

You choose a minimum gap between event runs (5 to 10,080 minutes); events in the
gap are merged into one run. Turning a trigger on never replays old events. Event
triggers are for Scout, Lens, Rook, Lock and Quill on committed source, and a Pip
can't have both a schedule and a trigger. Commit events only see committed work,
and the run reviews the ref's commit at the moment it is queued.

## The daily digest

Pips don't message you after every run. Once a day, when there is something to
say, the **Pips bar** above the main chat's composer shows a one-line digest: new
findings, failed runs, reviews waiting, and earlier findings that went away after
their file changed. Expand it for each Pip's details; select a finding to open its
report. **Dismiss** marks the digest seen until the next day.

A new finding at a Pip's alert level brings the bar back straight away. Each
project reviewer (Scout, Lens, Rook, Lock) has two settings in its **Job** tab
under **Notifications**:

| Setting | Default | Meaning |
| --- | --- | --- |
| Show new findings that are | medium or worse | Less severe new findings stay in the Pip's reports and out of the digest |
| Bring the digest back straight away for | high or worse | Or nothing, to wait for the next day |

These are your display settings, not part of the job: changing them needs no
review, and no model can change them. A finding that a later run reports again is
"repeated", not new, so it never brings the digest back. The digest matches findings by
file and quoted source lines, so one the model words differently next time is still the
same finding.

In the terminal, the welcome screen's tip says when the digest has something new,
and `/pips` shows it. From any shell:

```sh
dgc pips digest                                      # show it and mark it seen
dgc pips digest --keep                               # show it, leave it unseen
dgc pips notify PIP_ID --min-severity high --alerts critical
dgc pips outcomes PIP_ID                             # what became of its findings
```

**When you are not looking.** Two notices make sure a new alert or a waiting review
reaches you once:

- **In the editor.** While VS Code (or Cursor) is open, DGC checks every minute and shows
  one notification, with **Open Pips**, whether or not the DGC panel is on screen. This is
  the one to rely on when you work on a remote machine. `dgc.notifyPips` turns it off.
- **On the desktop.** The runner shows a desktop notification (Notification Center on
  macOS, `notify-send` on Linux) even with the editor closed. Each alert and review is
  announced once, at most one a minute, and never as a backlog when you turn it back on.
  Turn it off in the Pips view's runner controls or with
  `dgc pips desktop-notifications off`. A computer with no notification service (a
  server you reach remotely) cannot show them; the switch says so after the first one
  fails.

**What became of its findings.** A project reviewer's **Job** tab (or
`dgc pips outcomes`) counts what it reported, what you accepted or dismissed, what
it still reports, and what went away: after its file changed, or without a change.
"Gone after its file changed" suggests a fix; it doesn't prove one, because the
run simply stopped reporting it.

## Sharing a Pip

A Pip's **Job** tab has **Share this Pip → Export…**, which saves its job as a small file
someone else can import: name, goal, type, schedule or trigger, the pages and searches it
reads, a Pulse's reviewed commands, and its model if you chose one. The file never carries
your connected accounts, memory, history, findings or results, and it says what it left out.

To use one, choose **Import a shared Pip…** under **New**. It becomes an ordinary setup
card that opens for your review; nothing runs until you approve it. In the terminal:

```sh
dgc pips export PIP --output brief.pip.json
dgc pips import brief.pip.json        # shows the job, asks, then creates it
```

Patch Pips can't be shared yet, and a Pulse Pip is imported in the Pips view, where its
commands are reviewed on the card.

## A Pip's runs in its own chat

Each run a Pip finishes is posted in its own chat, as a short message from the Pip, the way
Grok Bots and OpenAI Dots post a scheduled run in the bot's conversation. Reply to it there:
"is the e-way one the same as last week?" The full list is the Pip's **History** tab (it was
Runs; for a Personal Pip, Results).

| Run | What its chat shows |
| --- | --- |
| A review with findings (Scout, Lens, Rook, Lock) | "Today's audit found 5 things, 2 of them high", the top three with severity, title and file:line, how many more are in the report, **Open full report** and **Ask DGC to fix** |
| Pulse checks that failed | "Today's checks: 2 of 5 failed", the failed checks, the same two buttons |
| A failed run | "Today's audit didn't finish." What stopped it in plain words, "Nothing in your project was changed", and when it runs next; **See what happened**, **Run again now** when it can, **Ask DGC to fix** |
| A clean run | One quiet line between the messages: "✓ 12:58 PM · Audit: nothing found · Open" |
| A Quill draft | "Today's draft is ready:" and its title |
| A Personal Pip's scheduled task (Core and the others) | Its result, in its own words (the first 1,200 characters), and **Open full result** |

**Open full report** opens that run under History, at its report. **Ask DGC to fix** sends
the prompt the Work chat's report card sends, naming the run, to the chat the Pip reports to
(the newest one it was set up in or attached to), in that chat's tab; a Pip that reports to no
chat starts a new one. It is sent once: the button then reads "Asked DGC". The status under the
Pip's name says what its last run found ("Today's audit: 5 findings") and goes to its post.

**Once, even with the editor closed.** The post is written when the run finishes, by the
runner, so a run that ends overnight is in the chat in the morning. Chat replies, Patch work
and cancelled runs post nothing.

**Not a message from you.** A post never starts a reply and is never sent to the Pip's model as
something you said. When you next write to the Pip, its model reads its five latest posts as
reference data, with the full report a tool call away.

**Long chats.** Each run is one post. Runs nobody replied to that are more than a day old fold
into one line, "12 earlier runs · 3 with findings", which opens in place; the newest of them and
any run you replied to stay as they are.

## Reports reach the chat

What a Pip finds comes to the chat that should act on it, as an item, not a new turn.
When a Pip's run finishes, a card appears in the transcript of every chat it reports to:

- the chat it was **set up in**;
- any chat it is **attached to** (ask DGC there: "attach ERP daily audit to this chat");
- the chat that **ran it** with `run_pip_now`, for that run.

A Pip that reports to no chat keeps reporting where it always has: its Pips page, Needs
attention and the Pips strip on the Sessions home, and its own chat. Its **History** page says
which it is, and how to attach it.

The card shows the Pip's face and name, what happened and when: "finished · 5 findings (2 high,
3 medium)", "finished · 1 of 2 checks failed", or "failed:" and the reason in plain words (the
saved error below it), with the worst findings, file and line. It has three buttons:

| Button | What it does |
| --- | --- |
| **Ask DGC to fix** | Sends a prompt about this report, once, and leaves the message box alone. If a turn is running, it waits in the queue (**Steer now** moves it into the turn). The button then reads "Asked DGC", also after a reload. The prompt names the run, so DGC reads the whole report with `pips_context`, and it asks DGC to check before changing live data or services. |
| **Open report** | Opens the Pips view at that run. |
| **Dismiss** | Removes the card. The report stays in Pips. Saved with the chat. |

**Which runs.** A finished source review (Scout, Lens, Rook, Lock), a Pulse's checks, and a
failed run of either. They are said when something changes: the first report, new or different
findings, a failure, or the all clear after one. A clean run after a clean one, the same findings
again or the same failure again are not shown again. A clean run is one quiet line. A run you
asked a chat to start is always shown there. Runs that finished while the chat was closed arrive
when you open it, the newest per Pip, with how many earlier ones it folds. Runs more than a week
old don't arrive. Chat replies, Quill drafts and Patch work stay in Pips.

**Never a turn.** A card doesn't wake the chat, start a turn, interrupt one or reach the model:
it is saved with the chat for you to see. If a turn is running when a report arrives, the card
appears below it and the turn carries on. DGC acts on a report only when you send it a message
that asks it to. That is why a chat never needs a monitor or a script that polls Pips: DGC's
models are told so, and told that a report is not a request to change anything.

**Once per chat.** Each chat gets each report once, open or closed, in the editor or the
terminal. In the terminal (`dgc`) a report is one line in the open chat, such as
`Pip 'ERP daily audit' finished: 5 findings (2 high, 3 medium) · /pips to open`, and the
editor shows its card when you open that chat there.

## Rating results

Under a finished result, report or Quill draft, **Was this result useful?** takes a thumbs
up or down and an optional note: "Too long, lead with the three biggest movers", "Perfect,
keep this format". The Pip's later runs read your five newest ratings and notes as
guidance that fits its approved job. A rating never changes the job, and a note is not a
new task: to change what a Pip does, edit its job. In the terminal:

```sh
dgc pips feedback RUN_ID down --note "Lead with the three biggest movers"
dgc pips feedback RUN_ID clear
```

Only you can rate, on this computer; a Pip and the main chat cannot.

## Usage

Every Pip's **Job** tab shows what its runs cost in tokens, today and over the last 30
days, with a chart of the last two weeks. `dgc pips usage PIP` says the same in the
terminal. It counts every model request a run made, including a run that failed or ran
out of time.

For every Pip at once, open **Settings → Token usage** and choose **Pips**: each Pip's
input and output tokens and runs for the range you pick, its share of the Pips' total,
and what all of the Pips used out of everything DGC counted. It is a breakdown of the
**Everything** totals, not an addition to them, and includes replies in each Pip's chat.

Pips have no daily token limit: a Pip runs until its work is done. Usage is there for you
to see, never to stop it. (A limit an older DGC let you set is ignored.)

## Reviewing what Pips propose

Every consequential change waits for you. You can review in the Pips view or with
the CLI; the two show the same saved records.

**Job changes.** A change to a Pip's name, goal, source, model, schedule, trigger,
command plan, app reads, web reads or adaptation policy is saved as a **proposal**. The proposal shows
the complete new definition. Accepting it checks that the Pip hasn't changed since
(`--expected-version`); a stale proposal must be reviewed again. Proposals expire
after seven days. The main chat's own proposals are limited to a new name, goal,
source ref or Excluded folders; for other changes it prepares a new setup card, which you review the
same way.

```sh
dgc pips propose PIP_ID --expected-version 3 --goal "Focus on the payment module" --reason "Narrow the review"
dgc pips accept PIP_ID PROPOSAL_ID --expected-version 3
dgc pips reject PIP_ID PROPOSAL_ID --expected-version 3
dgc pips versions PIP_ID
```

A Pip's **adaptation policy** decides how far it may change itself. The default,
`suggest_changes`, lets the model propose changes for your review. `locked` and
`context_adaptive` allow no model proposals. `bounded_adaptive` and `autonomous` also
let the main chat change the Pip's display name or source ref without a review
(`bounded_adaptive` only the fields you chose). The goal, schedule, triggers, model and permissions always
need your review. You change the policy itself with `dgc pips adaptation`.

**Runs and findings.** Open a run to read its report. For each finding you can
record **accepted**, **dismissed** or **open**, with a reason. A review records your
decision; it grants nothing. A finding can also be handed to another Pip.

```sh
dgc pips runs PIP_ID
dgc pips report RUN_ID
dgc pips review-finding RUN_ID 0 --status accepted --expected-revision 0 --reason "Confirmed in staging"
```

**Handoffs.** A handoff asks one Pip to act on another's result. It names the target
Pip, the task, and an exact action:

- a finding to Patch, with the exact files it may edit and up to four test
  commands;
- a finding to Pulse, with one to four exact commands;
- an accepted Patch result to Pulse, to test the change;
- a finding to another reviewer, read-only;
- an excerpt of a Personal result to another Personal Pip.

Commands are argument lists, never shell strings. Accepting a handoff queues
exactly one run. Handoffs expire after seven days.

```sh
dgc pips handoff list PIP_ID
dgc pips handoff review HANDOFF_ID
dgc pips handoff accept HANDOFF_ID --expected-revision 0
```

**Patch and Pulse results.** Patch edits a private copy of the project and saves a
diff for you to read; it is never applied to your files. Pulse records each
command's exit status and output. A run can finish while a command fails, and an
exit code of zero does not prove the project is correct. Record your decision with
`dgc pips review-execution`.

**Quill drafts and Personal results** are private Markdown documents. Open, copy or
save them from the Pips view, or export one:

```sh
dgc pips export-run RUN_ID --format markdown --output /absolute/path/new-file.md
```

**Notifications.** The Pips view keeps a local list of reviews waiting for you and
failed runs. Marking one read approves, rejects or starts nothing.

## Working with a Pip

**Chat with a Pip.** Each Pip has its own conversation. A project Pip can read its
approved source while it answers, but it can't edit files, run commands or change
its own job. In its message box you choose its **context window** and how much it
**thinks**, as in DGC's own chat; they are that Pip's own, saved as you change them,
and apply to its replies and to everything it does on its own (schedules, routines,
triggers, handoffs). A new Pip starts with DGC's context window. They don't change the
Pip's job. A Pip answers only while the runner is running.

You can send a Personal Pip photos and files with a message, as in the main chat: use the attach
button, paste, or drop them on the message box. Images (PNG, JPEG, GIF, WebP, BMP), text and code
files, and PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV and TSV files are accepted. The
Pip sees the photos and reads the files' text; a Pip with a computer also finds the files in its
Files, under **From chat**.

- **How much:** a photo can be up to 8 MB and one message up to 32 MB of photos, with no limit on
  how many beyond that (64 at most). Files can be up to 16 at a time: a document up to 16 MB, a text
  or code file up to 1 MB, 32 MB in all. The editor hands them to DGC the way the main chat does, so
  a phone photo of a bill goes as it is. (With a DGC CLI before Pips API 52, the old limit stays:
  4 images and 4 files, 2 MB in all.)
- **iPhone photos:** a HEIC or HEIF photo is turned into a JPEG automatically, and the chat keeps the
  JPEG. On a Mac this always works. On Linux DGC uses what the computer has (libheif's
  `heif-convert`, ImageMagick, libvips, or the GNOME image loader that Ubuntu's desktop includes); if
  there is nothing, the message says to install `libheif-examples` or send the photo as a JPEG, and
  nothing is sent.
- **Big photos:** a photo over 2,500 pixels on its long side is sent to the model at 2,500 pixels as
  a high-quality, lightly sharpened JPEG, so small print stays readable. The chat keeps your original: its thumbnail
  shows it, and clicking the thumbnail opens it in an editor tab at full size.

**Skills.** A Personal Pip has your DGC skills that fit everyday work: your own skills, plugin
skills, and the built-in **deep-research**, **dataviz** and **plan** (the code-only built-ins stay
with project work). It loads one when it fits the task. Skills you turn off in DGC Settings are off
for Pips too, and a skill is only instructions: it never gives a Pip new access. **Manage skills…**
in a Pip's Settings opens them.

```sh
dgc pips send PIP_ID "Explain the second finding"
dgc pips messages PIP_ID
```

**From the main chat.** Ask the main chat about your Pips and it loads its Pips
tools when it needs them. It can read Pip definitions, reports and drafts; prepare
setup cards and proposals; queue a run of Scout, Lens, Rook, Lock, Quill or a
Personal Pip; pause, resume or attach a Pip to the chat; propose handoffs; and draft
emails, events and connector actions from a Personal result. In the editor, type `@` and choose
**Reference a Pip…** to point a message at a Pip in this project.

Each of these tools has a permission name, so you can control it with the usual
rules: `PipsContext`, `PipsSetup`, `PipsPropose`, `PipsAdapt`, `PipsRun`,
`PipsHandoff`, `PipsEmailDraft`, `PipsCalendarDraft`, `PipsConnectorDraft`,
`PipsPause`, `PipsResume` and `PipsAttach`. Setting a Pip up (`PipsSetup`) and
changing one (`PipsPropose`) ask in the default mode, like the rest, and allowing
them is the approval; **Always allow** saves an ordinary allow rule. A setup that
reads connected accounts or runs Pulse commands doesn't ask twice: it saves a card
you approve instead. Reading never asks, auto mode allows everything, and plan mode
denies every change.

**Memory and context.** You can record facts for future runs:

- **Workspace context** is shared reference for every Pip in a project: decisions,
  milestones, commands, risks and exceptions, plus findings or results you promote.
  Use `dgc pips context`.
- **Exceptions** mark one finding as a known, accepted risk for one Pip. They never
  hide the finding. Use `dgc pips memory`.
- **Claims and preferences** are short notes for one Pip. A claim is shown as a
  recorded claim, never as a verified fact, and a preference is advice. Use
  `dgc pips memory statements`.

None of these are instructions or permissions; Pips receive them as reference.

## GitHub reads for project reviewers

A project reviewer (Scout, Lens, Rook, Lock) or Quill can read a few things from
GitHub before each run: open issues (optionally with given labels), open pull
requests, the CI checks for the exact commit the run reviews, and recent failed
workflow runs. They help a reviewer link a finding to a known issue, notice a
failing check on the commit it reviews, or (for Quill) draft notes from open pull
requests.

DGC makes the reads, with your own GitHub login: the `gh` CLI's, or `GH_TOKEN` /
`GITHUB_TOKEN`. Without one, public repositories still work. The reads are GET
requests only, so nothing can comment, label, merge or push, whatever your login
allows. The model never chooses what to read, and the credential never reaches it.
Adding or changing the reads is a job change you review.

In the Pips view, open the Pip's **Job** tab and fill in **GitHub reads**. From the
CLI:

```sh
dgc pips propose PIP_ID --expected-version 2 --github-issues --github-labels bug \
  --github-checks --reason "Use issues and CI as context"
dgc pips propose PIP_ID --expected-version 3 --no-github-reads --reason "Stop reading GitHub"
```

`--github-repo OWNER/NAME` names the repository; by default it is the project's
GitHub `origin`. The review shows the repository and each read. An issue or a
failing check is context for the model, not evidence: every finding still needs
exact source lines.

## A Personal Pip's page

A Personal Pip's **Settings** (the **…** menu in its chat) is one simple page, like a Grok bot's:
its face, its name and an optional title at the top, then four tabs.

- **Info**: **Instructions** (what it is for and how it should work; it reads them before every
  reply), its **Routines**, a **Notifications** switch, and **Share as template**.
- **Links**: every link you or it shared in the chat, newest first. A link opens in your browser.
- **Media**: the images sent in the chat.
- **Files**: the files sent in the chat, and the ones in its computer's Files folder.

**Edit** under its face changes its look: one of the eight Pip faces and a colour. **Reset to
default** puts back the face its type gives it. A look never changes what a Pip can do. Its
model is chosen in the chat (the model button by the message box). The **…** menu has **Copy ID**,
**Pause** and **Archive**. When you have chosen **Always allow** for something the Pip does, Info
also lists it under **Allowed without asking**, with **Stop allowing**.

With **Notifications** on (the default), the runner tells you, as a desktop notification, when the
Pip finishes a routine on its own or needs you: a routine or an app it asks you to say yes to, or a
robot check on its computer. Turn it off for a Pip that is chatty; its chat still has everything.

### Routines

A routine is something a Personal Pip does on its own. It has a name, what to do, and when:

| When | Example | Notes |
| --- | --- | --- |
| A time | Every day at 08:00, weekdays, every Monday, every 3 hours, once | Times are in your time zone |
| A new email | `from:alerts@bank.com` | A Gmail search; it looks every 10 minutes. Needs Gmail connected to this Pip |
| A calendar event | 15 minutes before each event | 5 to 120 minutes before. Needs Google Calendar connected to this Pip |

Add one with **+ Add routine** on its page, or ask the Pip ("every morning, tell me what my day
looks like"): it suggests a routine as a card under its reply, and nothing runs until you choose
**Add routine** (**Not now** puts it away). Each routine has an on/off switch; tap one to edit or
delete it.

When a routine is due, DGC writes a turn in the Pip's chat (you see only its reply) and the Pip does
the work with whatever it already has: its computer, its apps, its drafts that wait for your
**Allow**. A routine never gives a Pip anything new. An email routine's first look only notes the
emails already there; each new matching email after that starts one run (up to five emails at once),
and an email is never handled twice. The emails and events reach the model as untrusted data. A
routine whose app is not connected waits and says so ("Waiting for Gmail: ask Ava to connect it").

A routine can also run a **troupe** (many read-only agents on one work order; see the DGC docs,
Troupes) on a project. Ask for it in a DGC chat with Ultra on ("every Monday at 9, review last
week's changes for bugs and double-check what you find"); the chat schedules it as a routine of your
Primary Pip (or the Pip you name) after you allow **Schedule a troupe?**. When it is due, the troupe
runs as a job of its own on the project's committed code (never your unsaved changes), one troupe
routine at a time and for at most an hour. Each time it works through the files changed since it
last ran (the first time, the last seven days), the files matching a pattern, or a fixed list. Then
the Pip tells you what it found in its chat. Its tokens show in the Pip's usage. You can
rename it, change its time or turn it off in the Pip's Settings; to change what it does, ask for a
new one in a chat. It only reads: a troupe that writes can't be scheduled.

A Pip has at most ten routines. While the Pip is busy, a due routine waits for it; while it is
paused, the routine's time is skipped. Routines run while Pips are
running on this computer. A Pip made before routines that has a schedule shows it as **Its task**,
with **Change**.

## Pips settings

The gear on **Your Pips** opens settings for all of them:

- **Computer**: **Update computer** checks now for newer programs (Google Chrome, the desktop),
  instead of waiting for the daily check. **Reset** starts one Pip's computer fresh: signed out of
  every site, no browser history; its Files stay. DGC asks first, and refuses while that Pip is
  working. **Disk space** shows what the computers use and what is free.
- **Apps**: every app account your Pips use, and which Pips use each one. **Remove** stops one Pip
  using it; the account stays connected for the others. Accounts themselves are signed in and out
  in DGC **Settings → Plugins**, and so are the skills your Pips use.
- **Plugins**: every plugin you turned on in DGC **Settings → Plugins**. Each one is every Pip's to
  use; turning it on is your consent, so a Pip never asks "use this plugin?". For each plugin, choose
  what it may do without asking you (the same four choices as ChatGPT):
  - **Always ask**: it asks before it reads or changes anything.
  - **Ask before any change**: it reads at once, and asks before it changes anything.
  - **Ask before important actions** (the default): it reads at once, and asks before it sends,
    creates, edits, deletes, shares or pays.
  - **Never ask**: it reads and acts without asking. A plugin that can move money (Aave, 1inch,
    Airwallex) can't be set to this; it always asks before a change.

  In a run you aren't watching (a routine or a schedule), a Pip always asks before it changes
  anything, whatever you chose.

Each Pip still has its own computer: a separate home, browser profile and sign-ins, so one Pip's
sites never see another's. Settings are shared; computers are not.

## Personal Pips: apps and the web

### Searching the web

Every Personal Pip can search the web with the search you set in DGC **Settings** (the same one
your main chat uses). It gets titles, links and snippets; to read a page itself, it uses its own
computer. A search never carries what the Pip read from your apps (careful mode): a Pip that read
your parcel number in an email can't send that number to a search engine unless you said it
yourself.

### Connecting an app from a Pip's chat

Ask a Personal Pip to do something with an app it doesn't have yet, for example "set up
my Gmail so you can check my inbox every morning". The Pip puts a **Connect Gmail**
card in its chat, with one line on what it will do with it. Choose **Connect Gmail**:
DGC asks Composio (your connection in **Settings → Plugins**) for the account. If
Composio already has a Gmail account, that one is used. Otherwise your browser opens
Composio's sign-in page; sign in there, and the card turns into **Gmail connected**
by itself (or choose **I've signed in**). The Pip is told and carries on. **Not now**
puts the card away; the Pip can ask again later. When another of your Pips already uses
a Gmail account, the card asks **Let Ava use your Gmail?** with that account, and
**Allow** gives this Pip the same account with no sign-in.

A connected app is that Pip's: it reads it when you ask, like Grok's connectors
(Gmail messages, Calendar events, Drive and Notion search results, Contacts), and the
results reach the model as untrusted text. Anything it would send or change, such as
an email or a calendar event, is a draft that waits for your **Allow** (or your
**Always allow** for that exact kind of action). A Pip can have a computer and
connected apps at once. The Pip never sees your credentials, the Composio connection
or the sign-in link: DGC makes those calls, and the editor opens the link.

**Pips settings → Apps** (the gear on **Your Pips**) lists every account your Pips use
and which Pips use it; **Remove** stops one Pip using the account, which stays connected
in Composio. Without Composio in Settings, the card says to add it first.

### App reads

A Personal Pip can read from apps you've connected through Composio (see
[App connectors](APP_CONNECTORS.md)). You grant reads per Pip, as part of its
reviewed job:

| App | What the Pip receives |
| --- | --- |
| Gmail | Results of one reviewed message search |
| Google Calendar | Events from one calendar, for fixed dates or for a window of days that moves with each run |
| Google Drive | File names, types, edit dates and links from one search. No file contents. |
| Notion | Page titles, edit dates and links from one search. No page bodies. |
| Google Contacts | Names and email addresses from one search |

In the Pips view, open the Personal Pip's job, choose **Choose a connected
account…**, pick the account explicitly, and save the review. DGC never picks an
account for you, not even a default one. Each Pip can have up to four reads on one
connection, each returning up to 20 items. DGC performs the reads itself before
each run and hands the results to the model as untrusted reference text. The model
never gets your credentials or the connection itself.

### Web reads

A Personal Pip can also have up to four reviewed **web reads**: exact `https` pages
on public sites, or fixed search queries run through your configured search
provider. DGC reads them before each run and hands the text to the model as
untrusted reference. The Pip can't open other pages, follow links, sign in or fill
in forms. If a page redirects, DGC follows up to five redirects, each only to a
public `https` address. Page text is cut at 8,000 characters. A page that can't be read is
reported, and the run continues.

### A computer of its own (Linux and macOS)

Every new Personal Pip gets its own computer: a web browser and a home folder in a sandbox,
separate from your browser and your files. That holds wherever this machine can run one (Linux,
and Macs with Apple silicon on macOS 26 or later). It starts the first time the Pip uses it and
closes when it has been idle for 15 minutes. Remove it with **Remove computer…** in its **Job** tab,
or `dgc pips computer remove PIP`. A Pip made before computers were
the default gets one with **Give this Pip a computer…**, or `dgc pips computer give PIP`. Either is
a job change like any other. Ask the main chat for a Pip without a computer and it makes one
without.

- **Reading is free.** During a run the Pip opens, reads, scrolls and clicks through public
  websites on its own.
- **It copes with how pages behave.** It waits for results a page is still loading, follows a link that opens a new
  tab (and can go back to the first one), answers a page's own "Are you sure?" or question box, checks boxes, and
  knows what it downloaded (into its Files, under **Downloads**). After each step it is told what changed on the page,
  and any error the page's own site reported, so it doesn't guess. What a page's OK then sends still waits for you.
- **Its report points to what it did.** Each step that changes something is numbered, and its picture in **What it
  saw…** carries the same number, so "step 4" in its reply is one click away.
- **It pays, orders and books when you ask; you type the card.** "Pay these medical bills" with photos of the
  bills: it finds each bill on its site and fills in everything but the card, asking once for what it can't find (a
  delivery address, a phone number). Card numbers, expiry dates and security codes are like passwords: a Pip never
  asks for them or types them. When the form is ready it says, in one line, "Everything's filled in on my screen.
  Open my computer, type your card into the payment form, and press Pay." You type it on its screen and press Pay:
  that is your approval, so it is sent at once, and the Pip is told and goes on (the next bill). A Pip that presses
  Pay on an empty card form is stopped and told to hand over. Only when a site already has a card saved from your
  own sign-in does the Pip press Pay itself, and then the payment waits for you as below, every time.
- **Card numbers stay out of the chat.** A message with a card number (13 to 19 digits that pass the card check;
  a bill, UHID, phone or account number doesn't count) is not sent: DGC keeps nothing of it and says, in one line,
  to type it on the Pip's screen instead, with **Open its computer**. DGC's own chat warns once before sending one,
  since whatever you send there goes to the model.
- **Anything it would send waits for you** (at Ask; see [How much it asks](#how-much-it-asks)). When a page would
  submit a form or send any other data, DGC holds that exact request, unsent, and the run ends with it waiting. It appears under
  **Waiting for you** in the Pip's **Job** tab, and the Pips bar above the chat says so at once. It also waits
  as a card under the Pip's reply in its chat: a new site with **Allow this site** and **Not now**; a form or a
  payment with what it sends (a bill number and amount, never a card field), **Review…** and **Reject**.
  **Review…** shows a screenshot of the page, where the request would go and its form fields.
  Fields named like passwords, codes or card details are hidden in the review but are sent as
  entered. **Send once** sends exactly that request, once, and starts a follow-up run so the Pip
  carries on from the result. **Reject** drops it, and the Pip is told: it says what wasn't done and goes on with
  the rest of what you asked (the next bill). A held request expires after 24 hours. It is
  also lost, unsent, if the computer stops or the runner restarts, because the browser is what
  holds it.
- **What you submit is yours, right away.** With no Pip run using the computer, a submit within
  three seconds of your own click or key is sent, because you made it. Anything a page sends on
  its own, with nobody at the keyboard, waits for your approval like a Pip's.
- **It signs in with a login you saved; it never sees it.** When a site needs a sign-in, the Pip asks its computer
  to sign it in, and DGC types the login you saved for that site into the page, then the one-time code, and sends
  it (see [Saved logins](#saved-logins)). With none saved, its chat asks you once to save one. You can also sign in
  yourself: **Open browser** shows the Pip's screen. Click on it, type and go to an address to sign in to the sites
  the Pip needs; it keeps those sign-ins in its own profile. What you submit in the open browser is sent at once,
  because you did it. While a run is using the computer, the view only watches.
- **Fenced in.** The browser reaches only public web addresses on ports 80 and 443. Your home
  network, this computer's own services and cloud metadata addresses are refused. A request
  that carries a payment card number waits for you every time: its review says it sends payment
  card details, it never offers **Always allow**, and no Always allow you gave for that site sends
  one. A Pip with
  a computer can't also have app reads, so private data from your accounts never sits in a
  browser that could send it on.
- **Stop it any time.** **Stop computer**, or `dgc pips computer stop PIP`, closes the browser at
  once and cancels anything waiting, unsent. A computer with nothing waiting closes itself after 15 minutes idle.
  **Remove computer…** takes it away; the Pip's saved sign-ins stay in its folder (see
  [Privacy](#privacy-and-where-state-lives)) until you delete it.

### How much it asks

Each Personal Pip has a level, on its page under **How much it asks** (Pips API 58), the way OpenMausBot's bots do.
Only you change it, on this computer. Every Pip starts at **Ask**, old and new, so nothing changes until you choose.

| Level | What goes by itself | What still asks |
|---|---|---|
| **Ask** | Reading | A new site (careful mode), every submit and every send, as above |
| **Approve for me** | A new site's first visit, a search, a filter or sort, adding to a cart, saving a draft, an upload of a file you sent it in its chat, an email to someone you named in its chat or already wrote to from it, a calendar event with no guests | Placing an order or checking out, any payment, sending to someone new, posting, deleting, changing an account's settings or password, anything the page calls pay, purchase, subscribe, transfer or book, and anything DGC can't place |
| **Full access** | Every new site, submit and send, connected-app sends included | Any payment |

- **One line says what each level means.** It shows under the picker, and once more when you choose a level.
- **How DGC tells routine from consequential.** From the request itself and the page's own words, never the model's
  say-so: the method and address it goes to, its field names (a card or bank field, an amount), and what the Pip
  pressed (the button's words and accessible name, or the form's submit buttons, read in DGC's own isolated world of
  the page). "Add to cart" is routine; "Place order", "Pay", "Use saved card" or a form with a card field is a
  payment; "Post", "Send", "Delete" or a password field is consequential; a plain "Continue" DGC can't place, so it
  asks at Approve for me. A page could mislabel its own button: that is why payments, card numbers and what it read
  from your apps ask at every level.
- **Payments always ask.** At every level: a request carrying a card number, a payment's words, or card and bank
  fields (a saved card's token too). The card rule is the same: the Pip never types a card, and your own Pay on its
  screen is your approval. A saved login is still sent only to its own site, and careful mode still asks before
  anything it read from your apps goes onto a website.
- **The safety floor.** At every level, a command in its Terminal (or typed on its desktop) that could wipe its Files,
  like `rm -rf ~` or `find . -delete`, waits as a card: **Let PIP run this in its Terminal?** with **Allow once**,
  which lets exactly that command run once. It never gets Always allow. Ordinary commands run as before.
- **What it did on its own is one click away.** Each thing its level let through goes at once, in the same run, and
  is kept: the step's picture in **What it saw…** says "Approved by its level: Approve for me · Added to cart on
  shop.example", and its page lists the newest under **What it did on its own**, right under the picker, with **Ask
  me again from now on**. A desktop notification says what it sent (an email, a submit at Full access). Its drafts
  (an email, an event, a plugin's action) go after the reply, re-checked against the level when they run.
- **Routines run at its level.** With nobody at the keyboard, what its level let through says so ("nobody at the
  keyboard"). Careful mode still keeps a routine that can read your apps off its computer.
- **Sites you gave it count as yours.** A site you wrote in its chat already never asked; now a site written out
  (`https://…` or `www.…`) in a document you attach to your message counts too: a PDF's text, a Word, OpenDocument or
  text file's, read by DGC itself. Photos don't count yet: DGC has no way of its own to read the text in a picture, so
  the site on a photographed bill still asks once at Ask.
- **Subscription brains and the whole desktop.** The same level applies to a Pip on your own Claude Code or Codex and
  to the desktop's steps: only DGC's tools act, and they all go through the same gate.

### Working notes, a daily log, and /learn

A Personal Pip learns its job as it goes (Pips API 57), the way OpenMausBot's bots keep a `MEMORY.md`:

- **Its working notes.** It keeps short lines on how the job goes, like "The hospital portal asks for the UHID first"
  or "Bills go to Arjun Mehta", with a small tool of its own (add a line, replace one, strike one), up to 60 lines or
  6 KB. Every run of it, a chat reply or a routine, starts with them. They're its notes, not your memory: a line is
  refused when it holds a password, a code, a card or account number, what it read in your apps in the last day
  (what an email or an event said), or an email address or a link you never gave it. Its page shows them under **Working notes**; **Edit** changes them, one line a
  note, and its next run starts with your version. They're in `working-notes/PIP_ID.md` in the `pips` folder.
- **Its daily log.** DGC writes one line for each run: when, what it was (a chat, a routine by its title, a task) and
  how it ended. Its page shows the last days under **Daily log**, today open. It's for you to read: no run of the Pip
  is ever given it. It's in `daily-log/PIP_ID/` in the `pips` folder, a file a day, the last 30 days.
- **Your memory, from its chat.** What you tell a Pip about yourself is looked back over the way a ChatDGC chat is,
  once your messages add up or the chat goes quiet, and what's kept shows under its latest reply as **Remembered: …**
  with **Forget**, in the one memory DGC keeps for you (Settings → Memory). Its own hellos, routines' turns and posts
  are never looked at.
- **/learn** in its chat (`/learn` or `/learn what`) turns what it just did into a skill and shows it with **Save**,
  **Edit** and **Cancel**. Saved, it's one of your own skills (`~/.dgc/skills`), which every Pip and session can use.
  Nothing is written until you save.

### Saved logins

A Personal Pip with a computer can sign in by itself (Pips API 56), the way OpenMausBot's bots do: you save a
site's login once, and DGC types it in whenever the Pip needs it. The Pip never sees the username, the password or
the code; it is told only what was filled.

- **Saving one is one click away.** When the Pip meets a sign-in page with no saved login, its chat shows **Save a
  login for SITE so PIP can sign in itself?** with **Save login…** and **Not now**. **Save login…** opens a small
  form: the username or email, the password, and, if the site uses an authenticator app, its key (the setup key the
  site shows under "can't scan the code?", or an `otpauth://totp/` link). Save, and the Pip is told and signs in by
  itself, the code included. **Not now** tells the Pip to ask you to sign in on its screen instead, and it doesn't ask
  for that site again for a day. The same form is on the Pip's page, under **Logins**, with **Save a login…**.
- **What you type there goes to DGC only.** It is never in the chat, its draft, the model's context, a run's
  timeline or an export; the form keeps nothing once it is sent. A password you type into a Pip's chat anyway is
  redacted like any credential DGC knows.
- **One Pip, or all of them.** A login is for the Pip you saved it from unless you tick **Let all my Pips use it**.
  Its page lists the logins it may use (site, username, "Fills its code too" when it has a key, and who may use it),
  each with **All Pips** and **Remove**, and the ones saved for your other Pips, each with **Let PIP use it**. The
  key itself is never shown back.
- **How it signs in.** The Pip's `sign_in` step works on the page it has open, or on the sign-in page the login was
  saved from. DGC finds the username, password and code boxes as a person would see them (visible, enabled inputs,
  their type, `autocomplete`, names, labels), focuses each, and types the value as real keyboard input over the
  browser's private DevTools pipe; no page script ever carries a value. It presses Enter, or the form's own sign-in
  button, then reads what the page did: a code page next (it makes the code itself, from the key, at that moment),
  the account page, or the site saying no. Up to three steps.
- **That one submit is let through.** Every other submit a Pip's computer makes still waits for your Allow. The
  sign-in form DGC filled is the exception: the request that carries a value it just typed, to the login's own
  site, within seconds, once. A sign-in sent anywhere else (another site's single sign-on page) waits for you as
  before, with the password hidden on its card.
- **Where it fills.** On the site you saved it for (its registrable domain, so `www.` and `login.` of the same site
  both count), on secure pages only: never over plain http to another computer.
- **What the Pip hears.** "Signed in to SITE: DGC filled the username, the password and the one-time code", "No saved
  login for SITE" (and the card), "The page asks for a one-time code, and the login saved for SITE has no
  authenticator key", "The site did not accept the saved login" (the password is cleared from the page and nothing
  is sent twice), or a robot check it leaves to you. Every answer its computer gives it is scrubbed of saved
  secrets and of the code it just typed, as typed, URL-encoded or escaped.
- **Masked everywhere it looks.** A box DGC typed a password or code into is marked, so every screenshot the Pip
  sees blacks it out (even a box a site simply calls `code`) and its page read shows `(hidden)` for it. A run's
  timeline pictures of a sign-in step are blacked out the same way. While a typed secret may still be on a page
  (DGC filled it but couldn't send it), the steps that could copy it from there (drag, and the desktop's keys and
  typing) wait, and DGC empties the boxes itself after a minute.
- **Chrome keeps no passwords.** A Pip's browser has Chrome's own "Save password?" and its breach check turned off,
  so a password lives in one place: DGC's sealed store.
- **What it can't do (yet).** A sign-in form inside a frame, a code sent by text message or email, a security
  question, or a robot check: the Pip says so and asks you to finish on its screen. 1Password isn't connected (see
  below).

Where and how they are kept: `logins/logins.sealed` in the `pips` folder, sealed under a 256-bit key of its own in
`logins/logins.key` beside it (both readable only by you, the folder too). Python's standard library has no AES,
so the seal is built from what it has: HMAC-SHA256 in counter mode as the keystream, and HMAC-SHA256 over the nonce
and the ciphertext to authenticate it (encrypt-then-MAC), the two keys derived from the one in `logins.key`. A file
that fails its check, or has no key beside it, opens as empty and is never half-read. Saved logins are not in the
Pips database, so no export, shared Pip or run record holds them, and nothing copies or backs up that folder.
**1Password** (a service account token) isn't offered yet: its official Python SDK (`onepassword-sdk` 0.4.1) is a
compiled core of about 7 MB for each Python version and platform (manylinux 2.32 or later on Linux), still 0.x, which
DGC would have to install for everyone, with a hash pinned per platform, for a feature most people won't use.

On a Mac, a Pip's browser runs in its own VM and DGC reaches it the same way (the DevTools pipe over the VM's
console), so saved logins work the same; this release was tested live on Linux only.

**Eyes and a cursor.** A Pip whose model can see (its capabilities say so: deepseek-v4.1-flash:cloud, Qwen3.8, Qwen3-VL and
others) uses its browser two ways, and picks: by the page's text (it reads the page and clicks
things by name), and by eyes and a cursor. It **looks** at its screen (a picture of the browser,
about 1280 × 800) and clicks, double-clicks, right-clicks, hovers, drags and scrolls where it points.
That is what a drawing canvas or a drag-and-drop editor needs, such as a T-shirt designer. Every step
by position comes back with a new picture of the screen, with a red ring where the mouse now is, so
it sees what happened.

- **It never sees a password or a card.** Before a picture goes to its model, DGC blacks out every
  password, card number, expiry, security-code and one-time-code field: on the page, in its frames,
  and the whole of any frame a payment provider puts on it. If one can't be blacked out, the picture
  isn't sent. Your own view of its screen, and the approval card, show the page as it is.
- **What it sends still waits for you.** A click by position holds a submit exactly as any other
  click: anything that would send, buy, pay, post or book waits for your **Allow**, careful mode still
  asks before a new site, and a payment asks every time.
- **You see its cursor.** In its computer tab an arrow with its name shows where it last acted,
  while it works. **What it saw…** shows each step with its cursor, and a drag with its path.
- **Uploads.** It can put a file from its Files into a website's file field or upload button. The
  photos and files you send in its chat are in its Files, under **From chat**. Choosing a file sends
  nothing; when the page uploads it, that waits for your **Allow** like any submit.

A Pip whose model reads text only (glm-5.3:cloud or deepseek-v4-pro:cloud, for example) still uses
the page's text. When it needs to see (a canvas, a picture, or photos you sent it), it says so in one
line, **glm-5.3:cloud can't see images.**, with three choices. If it worked on a page drawn on a canvas
from the page's text alone, or said it couldn't see, its reply stays and the line and choices follow it:

- **Use deepseek-v4.1-flash:cloud to see, keep glm-5.3:cloud for the rest**: a model that can see
  looks at the screen or the photos for it and answers in words, naming the points it can click.
- **Switch this Pip to deepseek-v4.1-flash:cloud**: the Pip's model changes, and it sees for itself.
- **Not now**: it works from the page's text and says what it couldn't do.

DGC picks the model that sees from the ones you already have, the same kind first (a `:cloud` model
for a `:cloud` Pip); it also has to use tools, so switching to it works. It asks once. Change the
answer on its page under **Seeing**, which also offers **Switch to …**.

**The whole desktop** (Linux). A Pip that can see uses its whole computer, like a person at a desk: it
looks at the whole screen, clicks, drags, scrolls and types in any window, presses keys and shortcuts
(ctrl+s, alt+tab), lists its windows, brings one to the front and opens its apps. Ask it to "design me
my birthday shirts and order 20 in large" and it makes the design itself in the image editor (your
words as big text, a shape or two), exports a PNG into its Files, uploads it to the shop, sets 20 in
Large and fills in the checkout; then it asks you to type your card on its screen.

- **Its apps.** Besides the browser, Files and Terminal, its dock has an **image editor** (LibreOffice
  Draw), **Documents** (LibreOffice Writer) and a **PDF viewer** (Evince). Each opens in a box of its
  own that sees only its Files. When this computer doesn't have LibreOffice or Evince, its computer tab
  asks you once, in one line saying what and how big, to download them from your system's own package
  servers into DGC's folder (about 83 MB on an Ubuntu desktop, nothing installed system-wide); **Not
  now** and it doesn't ask again.
- **What waits for your Allow, and what doesn't.** Its apps and its Terminal are online like a normal
  computer's, through DGC: they reach public websites and never this computer or your network (nor
  link-local or cloud metadata addresses). **They can send to a public website without an Allow card.**
  Only the browser holds what it would submit, send, pay or order for your **Allow**; careful mode still
  asks before the browser opens a new site, and a payment always asks.
- **Still nothing secret.** In a picture of the whole screen DGC blacks out the browser's password and
  card fields wherever its window is, any other browser window, and any window that asks for a
  password. If it can't find the browser's window on the screen, the picture isn't sent. (A password a
  desktop app draws as dots stays dots; DGC can't find those fields itself.)
- **You watch, and it's yours when it stops.** Its cursor shows on its screen in the tab, every step is
  in **What it saw…**, and while it works your keyboard and mouse wait, as before.

**Its screen in an editor tab.** The computer button in a Pip's chat (or **Open its computer**
in Settings) opens "NAME · Computer" as an editor tab.

The tab is the Pip's real screen, like Grok's bots: a small Linux desktop on DGC's own wallpaper,
with a dock at the bottom holding **Browser** (Google Chrome), **Files** (a file manager),
**Terminal**, and its image editor, **Documents** and PDF viewer when this computer has them. It opens
with nothing open. Click, type and move windows as on any computer. While a
Pip run is using it you watch, and your keyboard and mouse wait until it is done. The browser is the
Pip's own: closing its window and clicking Browser in the dock brings it back.

**Setting it up takes nothing from you.** The first time you open a computer, DGC fetches what this
machine lacks (the desktop's programs and Google Chrome, about 135 MB on an Ubuntu machine with none
of them) from the machine's own package sources and Google's, into its own folder
(`~/.dgc/desktop`). No password, and nothing is installed on your system: the packages are unpacked,
not installed, and only the computer's box uses them. Apt checks every package against its source's
signing key; Google's repository is trusted only with Google's key, whose fingerprint DGC pins. The
tab shows how far it has got, and the screen opens when it is done. DGC checks for a newer Chrome
once a day and switches to it in one step. This works on Linux with apt (Ubuntu, Debian and their
family). Elsewhere, or if the download fails, the tab says why and what to install yourself:

```sh
sudo apt install tigervnc-standalone-server openbox tint2 xterm pcmanfm
# Google Chrome, from Google's repository (https://www.google.com/linuxrepositories/):
sudo apt install google-chrome-stable
```

Until then the tab shows a simpler desktop DGC draws itself: a dock of three apps at the bottom,
each in a window you can minimise or close; when the Pip starts using its browser, the browser
window comes up so you can watch.

**Websites that check for robots.** The Pip's Chrome tells sites that software can drive it
(`navigator.webdriver`), as every browser an agent drives does, so a site like Google's search may
ask "I'm not a robot". A Pip never tries to pass one. When a page it reads is a robot check
(Google's "unusual traffic" page, reCAPTCHA, hCaptcha, Cloudflare's check), it stops and its chat
shows **<Pip> needs you**: choose **Open its computer**, finish the check on its screen as you would
on any computer, then **I've done it**, and the Pip looks again and carries on. The computer keeps its
cookies, so a site usually trusts it for a while afterwards.

- **Browser**: the live screen. Click, type, scroll and go to an address; anything the Pip would
  submit shows at the top with **Send once**, **Always allow** and **Reject** (a payment has no
  **Always allow**). While the Pip works, its cursor shows where it last acted.
- **Files**: the computer's own folder, never yours. Downloads from its browser land in
  **Downloads**. Open a file to see it, **Save to…** to copy it where you choose, **Add files…**
  (or drop them) to give the Pip something to work on, and **Remove**. It holds 1 GB.
- **Terminal**: run a command in the computer's Files. Yours and the Pip's commands show
  together. It is online like Grok's bots: commands reach public websites on ports 80 and 443
  through DGC, the same way out as the browser (curl, pip, npm and git over https work), and
  never this computer or your local network. Under each command DGC lists the sites it reached,
  and anything it refused. It sees nothing but those Files and stops a command after 60 seconds.
  The desktop's own Terminal app, and its apps, are online the same way. What they send doesn't
  wait for an Allow card: only the browser holds submits.

The Pip uses all three from its chat too, so you can watch it work while you talk to it. If it
holds a submit there, the chat continues once you send it: the Pip reads what happened and
tells you.

The terminal has the same steps: `dgc pips computer status PIP`, `pending PIP`,
`approve ACTION_ID`, `reject ACTION_ID`, `stop PIP` and `frames RUN_ID` (a run's screenshots).
`give`, `remove` and `approve` ask once; add `--yes` in a script.

On Linux a computer needs bubblewrap (`bwrap`); DGC fetches the desktop's programs and Google
Chrome itself the first time ("Setting up your Pip…"), with no admin password.

On a Mac (Apple silicon, macOS 26 or later) each computer is a small Linux VM made with Apple's
`container` tool, which you install once from
[github.com/apple/container](https://github.com/apple/container/releases). The first time, DGC
starts its service and builds the computer's image (Debian with the same desktop, Google Chrome
from Google's repository checked against its signing key, and the Terminal's usual tools); after
that a computer starts in a few seconds. The VM has no network of its own: like on Linux, the
browser and the Terminal reach public websites only through DGC's egress proxy on your Mac, and
nothing on your Mac or your network. Chrome runs with its own sandbox there. The VM gets 4 GB of
memory and 4 CPUs, its Files are a folder on your Mac, and it is deleted when the computer closes.
On a Mac a Pip doesn't use the whole desktop yet: its eyes and cursor work in the browser, and its
image editor, Documents and PDF viewer are not on the Mac's computer.

On Windows, a Pip's computer is the Linux one, in DGC inside WSL 2: it needs bubblewrap there
(`sudo apt install bubblewrap`), and DGC sets the desktop and Chrome up as on Linux.

If something is missing, the **Job** tab says what.

### Drafts and reviewed sends

Ask a Personal Pip, in its own chat, to draft an email, a calendar event or a
connector action, or give it a job that calls for one: its scheduled runs can draft
them too. The main chat can also draft them from a completed Personal result or
reply. A draft is only text: it can't choose an account or send anything.

Sending takes two separate decisions:

1. **Prepare the review.** Open the draft, edit it if you like, choose the account
   (for email and calendar) and save it for review. This saves the exact action.
2. **Approve once.** Read the saved action and choose **Send once**, **Create once**
   or **Run once**. DGC makes exactly one attempt and saves a receipt.

| Action | What it does | What the receipt means |
| --- | --- | --- |
| Email | One plain-text message to one recipient, from the Gmail account you chose. No CC, BCC or attachments. | Gmail accepted it. Delivery is not confirmed. |
| Calendar event | One event, or a finite daily, weekly or monthly series of up to 52, in that account's primary calendar. Private, no meeting link. Up to ten guests; with guests, invitations are sent, and the review says so. | The calendar confirmed creation. Invitation delivery and acceptance are not confirmed. |
| Connector action | One exact tool call on a saved Zapier, Make, n8n or Arcade connection | The connector returned a response. This does not confirm the downstream work finished. |

Drafts and saved reviews expire after 24 hours. DGC never retries an attempt. If
the outcome is unknown, check Gmail's Sent folder, the calendar, or the connector's
own log before preparing another.

The CLI has the same steps: `dgc pips email-draft`, `calendar-draft` and
`connector-draft` (`list`, `show`, `prepare`, `dismiss`), then `dgc pips app-action
show` and `dgc pips app-action accept ACTION_ID --expected-digest DIGEST`.

### Always allow

Beside **Send once**, **Create once** and **Run once** is **Always allow**: it runs
this action and lets the Pip do the same kind of action again without asking, with
the same connection, account and tool. After a later run, the Pip drafts it and DGC
runs it straight away, then tells you: a desktop notification says what the Pip did,
and the action is in its reviews like any other. Anything the Pip drafts that no
Always allow covers still waits for you.

Always allow is pinned to what you approved. If the connection, account, tool or the
tool's inputs change, it no longer matches, and the action waits for you again.
Nothing else grants it: not the chat, not auto mode, not a Pip. Money is not special:
a trade or a payment through a connected app is an action like any other, so allow
it only for a tool you trust to act on its own.

See and take back what a Pip may do in its **Job** tab, under **Allowed without
asking** (**Stop allowing**), or in the terminal:

```sh
dgc pips app-action accept ACTION_ID --expected-digest DIGEST --always
dgc pips allowed PIP                      # what runs without asking
dgc pips allowed PIP --revoke GRANT_ID
```

A Pip's computer has **Always allow** too, in the review of a waiting submit (or `dgc pips
computer approve ACTION_ID --always`): the Pip may then send the same kind of submit, to the same
site, method and path, from its own browser without asking, and you are told after. Anything
else it would submit still waits for you.

## What Pips never do

- **Change your project.** No Pip edits your working files, commits, merges,
  pushes or deploys. Patch edits only a private copy; you decide what to do with
  its diff.
- **Run anything you didn't approve.** Pulse and Patch run only the exact command
  lists you reviewed, in a confined copy with the network off, apart from fixed checks of
  local `http://127.0.0.1` addresses you approved. No Pip has a shell, installs
  dependencies or picks its own commands.
- **Approve themselves.** No Pip can accept a setup, proposal, handoff or external
  action. The main chat sets up and changes Pips only through tool calls your
  permission mode decides (auto mode creates a Pip directly, including one that reads
  connected accounts); a Pulse that runs commands, a handoff and an external action
  still wait for you in the Pips view or the CLI.
  When the chat runs `dgc pips` in its own shell, the CLI only reads (and can make
  the emergency stop); anything that changes a Pip is refused there.
- **Act outside their reviewed reads.** Project Pips read only their approved
  source. Personal Pips see only the app and web reads you approved, and the public
  websites their own computer opens.
- **Send, create or call without you.** Every email, event and connector call is a
  single attempt you approved on its exact content, or one you chose to **Always
  allow** for that Pip, connection, account and tool. So is every form a Pip's computer
  would submit.
- **Buy, pay or book on their own,** unless you allowed it. A Pip has no tool of its
  own for this; a Pip's computer holds every submit, a payment included, for you or for an Always
  allow that covers it; a connector action runs the exact tool call you reviewed, or one you
  always allow, so check what that tool does before you allow it.
- **Use a cloud service of DGC's.** There is no Pips account or hosted runner.

## Privacy and where state lives

Pips state stays on your computer, in the `pips` folder of your DGC profile:
`.dgc/pips` in your home directory, or `$DGC_HOME/.dgc/pips` when `DGC_HOME` is set.
It holds a private SQLite registry (`registry.sqlite3`), each run's private files
(source copy, artifacts and a private home for the run), the runner's lock files
and `supervisor.log`. Folders are readable only by you. DGC creates the registry the
first time a chat or command uses Pips; until then an ordinary chat leaves no Pips
state behind.

What leaves your computer is what you'd expect:

- each Pip's model requests go to the model connection you configured;
- approved app reads and actions go through the connector you chose, which runs
  them in its own service;
- approved web reads fetch those pages and searches;
- a Pip's computer reaches the public websites it opens, and the sites you sign in to
  from it.

A Pip's computer keeps its browser profile, with your sign-ins to the sites you used
in it, in `computers/PIP_ID` in the same `pips` folder, readable only by you. Removing
the computer leaves that folder; delete it to forget the sign-ins. Each run's
screenshots are kept with the run's artifacts. Saved logins are sealed in `logins/`
in the same folder (see [Saved logins](#saved-logins)); remove one on its Pip's page,
under **Logins**, or delete that folder to forget them all.

Each run gets its own private home, with no access to your MCP servers, hooks or
credentials. The model key reaches the run only for its own model requests.
Configured secrets are redacted from reports and previews. Saved artifact files
(Patch diffs and Pulse output) are kept as written, readable only by you.

## Turning Pips off

- **Stop all work now:** `dgc pips stop` pauses every Pip and cancels queued and
  running work. `dgc pips resume` clears the stop; each Pip stays paused until you
  resume it with `dgc pips resume-job PIP_ID`.
- **Pause one Pip:** `dgc pips pause PIP_ID`. A paused Pip can still chat.
- **Archive a Pip** you no longer need: `dgc pips archive` keeps its history and
  stops it from running. `dgc pips restore` brings it back, paused.
- **Turn Pips off:** choose **Disable local Pips…** in the Pips view, which first
  stops all Pips work. Or set `pips_enabled` to `false` (`/set pips_enabled false`
  in the terminal, or in `.dgc/config.json` in your home directory). With Pips off, the main chat has no
  Pips tools and the runner won't start.
- **Keep Pips but keep the main chat out of them:** a `deny: UsePips` permission
  rule keeps the Pips tools out of the main chat, including a message that
  references a Pip with `@`. The Pips view and `dgc pips` still work.

Pips are not available in a session that runs under an SDK runtime policy or a
sandbox: the runner can't inherit that session's limits, so DGC refuses rather
than run unconfined.

## Limits

- A run keeps going until its work is done: no step limit, no time limit, and DGC's own
  output budget per model response, in the Pip's own context window. It compacts as a DGC
  chat does when the window fills. It ends when it finishes, when you press **Stop**, or
  when it repeats itself without progress (the same call over and over, or a page that a
  click never changes). A Patch with reviewed specialists (helpers) works the same way: the
  helpers share its lifetime with no limit on requests, tool calls, output or time, and the
  number of helper calls you approved (1 to 3) is their only bound.
- Up to four Pips run at once (`pips_parallel_runs`, 1 to 32), each one run at a time; at
  most 20 runs queued or running.
- Source copies: up to 256 MiB and 10,000 files and folders; files over 4 MiB, links
  and submodules are left out and listed (see What a Pip's copy leaves out). Under the
  original rules: 64 MiB, and a file over 4 MiB, a committed symbolic link or a
  submodule fails the run.
- Pulse and Patch commands: up to four per run, each with 60 seconds, 30 CPU
  seconds, 512 MiB of memory per process, 32 processes and 64 KiB of output. The
  project copy is read-only to the commands; only a 64 MiB temporary folder is
  writable. On macOS, memory (512 MiB across all of a command's processes), the
  process count and the temporary folder's size are sampled, not hard limits.
- Up to 100 Pips per project and 256 projects.
- **Finished runs clean up after themselves.** Once a run finishes, DGC removes its
  private copy of the source, its private worktree and, after its token usage is
  recorded, its private home. Reports, findings, artifacts and history stay.
- **Retained history has fixed ceilings.** A profile keeps up to 20,000 project
  runs, 20,000 Personal runs and replies, and 20,000 chat messages. When a ceiling
  is reached, new work is refused; run records are not deleted yet.
  `dgc pips capacity` shows how close your project runs are.
- Audit checkpoints keep up to 20,000 per runner, one per project audit run. A
  digest looks back at most a week and counts at most 400 reports.
  Setup cards, handoffs and memory records each have a ceiling of 1,000 per
  runner. The notification list keeps the newest 500.
- Personal app reads: one connection, four reads, 20 items per read. Web reads:
  four per Pip.
- A Pip's computer: up to eight requests waiting at once (more are dropped, unsent),
  each for at most 24 hours; up to 200 screenshots per run, each at most 90 KiB.
- `dgc pips export-run` and `dgc pips capacity` currently need Linux.

## More

- [PIPS_REFERENCE.md](PIPS_REFERENCE.md): the security model, state, run kinds,
  limits, main-chat tools, CLI commands and API history.
- [PIPS_EDITOR_PROTOCOL.md](PIPS_EDITOR_PROTOCOL.md): the editor protocol commands.
- [sdk/PIPS.md](../sdk/PIPS.md): `session.pips` in the Python and TypeScript SDKs.
- [APP_CONNECTORS.md](APP_CONNECTORS.md): connecting Composio, Zapier, Make, n8n and
  Arcade.
