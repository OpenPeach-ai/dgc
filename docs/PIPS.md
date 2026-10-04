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

**From the main chat.** Just ask, for example: "Review committed changes in this
project every weekday at 9:00 Europe/London, and run once now." The main chat loads
its Pips tools and prepares a **setup card**. The card shows the project folder,
the job, the character, the source, the schedule with its next run time, whether
it will run once on approval, the model, and exactly what the Pip may do. Choose
**Approve** (or **Approve & run**), **Reject** or **Review**. Nothing is saved or run
until you approve the exact card. A card expires after seven days, or sooner if the
next run time it shows has already passed.

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

## The runner

A Pip's work runs in the **runner**, a local process separate from your chats.
Without it, runs and Pip replies wait in the queue and schedules don't fire.

**Keep Pips running** (in the Pips view's runner controls, or `dgc pips keep-running on`)
is the one switch most people want. The runner then starts when you log in and after a
restart, and is restarted if it fails, so a morning schedule still runs after a reboot.
On Linux it also keeps running while you are logged out, where the system allows it
(systemd "lingering"); `dgc pips keep-running` says whether yours does. Turning it off
stops the runner starting on its own; the runner running now keeps going until you stop
it. It never turns Pips on and never clears an emergency stop.

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

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Pips view, Pip chats, audits, Quill drafts, Personal tasks | Yes | Yes | Not yet |
| Patch fixes and Pulse commands | With bubblewrap (`/usr/bin/bwrap`, `python3`, `git`) | Under Seatbelt, with Xcode or the Command Line Tools; weaker, see below | Not yet |
| Keep Pips running | systemd user service; also while logged out, where the system allows lingering | LaunchAgent, while you are logged in | Not yet |
| Desktop notifications | `notify-send`, when a notification service is running | Notification Center | Not yet |

`dgc pips execution` shows whether this runner passed its confinement check. On Windows
the Pips view says Pips are not available, the main chat has no Pips tools and
`dgc pips` explains the same, so nothing can be created that would never run. A DGC
installed inside WSL is a Linux install.

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
Pips can have schedules.

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

## Usage and daily limits

Every Pip's **Job** tab shows what its runs cost in tokens, today and over the last 30
days, with a chart of the last two weeks. `dgc pips usage PIP` says the same in the
terminal. It counts every model request a run made, including a run that failed or ran
out of time.

To keep a scheduled Pip from running up a bill, give it a **daily limit**:

```sh
dgc pips usage PIP --daily-limit 200k     # or 1.5m, 250000; off removes it
```

Once its runs today reach the limit, its schedules and event triggers are skipped until
the next day, and the skip says why. A run you start yourself, a chat reply and a handoff
you approve still run. The limit is your setting, not part of the job: it needs no review
and no model can change it.

## Reviewing what Pips propose

Every consequential change waits for you. You can review in the Pips view or with
the CLI; the two show the same saved records.

**Job changes.** A change to a Pip's name, goal, source, model, schedule, trigger,
command plan, app reads, web reads or adaptation policy is saved as a **proposal**. The proposal shows
the complete new definition. Accepting it checks that the Pip hasn't changed since
(`--expected-version`); a stale proposal must be reviewed again. Proposals expire
after seven days. The main chat's own proposals are limited to a new name, goal or
source ref; for other changes it prepares a new setup card, which you review the
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
its own job. For one reply you can choose a context size and a reasoning level;
these don't change the Pip's job. A Pip answers only while the runner is running.

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
`PipsPause`, `PipsResume` and `PipsAttach`. Reading and preparing setup cards or
proposals don't ask, because nothing happens until you approve the card or
proposal. The others ask in the default mode, and plan mode denies them.

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

## Personal Pips: apps and the web

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

### Drafts and reviewed sends

Ask a Personal Pip, in its own chat, to draft an email, a calendar event or a
connector action. The main chat can also draft them from a completed Personal
result or reply. A draft is only text: it can't choose an account or send anything.

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

## What Pips never do

- **Change your project.** No Pip edits your working files, commits, merges,
  pushes or deploys. Patch edits only a private copy; you decide what to do with
  its diff.
- **Run anything you didn't approve.** Pulse and Patch run only the exact command
  lists you reviewed, in a confined copy with the network off, apart from fixed checks of
  local `http://127.0.0.1` addresses you approved. No Pip has a shell, installs
  dependencies or picks its own commands.
- **Approve themselves.** No Pip, and not the main chat, can accept a setup,
  proposal, handoff or external action. Only you can, in the Pips view or the CLI.
  When the chat runs `dgc pips` in its own shell, the CLI only reads (and can make
  the emergency stop); anything that changes a Pip is refused there, and the chat
  prepares it as a setup card for you instead.
- **Act outside their reviewed reads.** Project Pips read only their approved
  source. Personal Pips see only the app and web reads you approved.
- **Send, create or call without you.** Every email, event and connector call is a
  single attempt you approved on its exact content.
- **Buy, pay or book on their own.** A Pip has no tool that can do this. A connector
  action you approve runs the exact tool call you reviewed, so check what that
  tool does before you approve it.
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
- approved web reads fetch those pages and searches.

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

- One run at a time per runner, at most 20 queued or running.
- A run has five minutes in total, up to 12 model turns and 64 tool calls, and up
  to 4,096 output tokens per model response.
- Source copies: up to 10,000 files and folders, 4 MiB per file, 64 MiB in total.
  A committed symbolic link or submodule fails the run.
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
- `dgc pips export-run` and `dgc pips capacity` currently need Linux.

## More

- [PIPS_REFERENCE.md](PIPS_REFERENCE.md): the security model, state, run kinds,
  limits, main-chat tools, CLI commands and API history.
- [PIPS_EDITOR_PROTOCOL.md](PIPS_EDITOR_PROTOCOL.md): the editor protocol commands.
- [sdk/PIPS.md](../sdk/PIPS.md): `session.pips` in the Python and TypeScript SDKs.
- [APP_CONNECTORS.md](APP_CONNECTORS.md): connecting Composio, Zapier, Make, n8n and
  Arcade.
