# Pips reference

This is the technical reference for Pips: the security and review model, local
state, run kinds, formats, limits, the main chat's Pips tools, the CLI, and the
Pips API history. For a guided introduction, start with [PIPS.md](PIPS.md).

| Component | Version |
| --- | --- |
| DGC CLI | 0.48.0 |
| VS Code extension | 0.33.0 |
| SDK (Python and TypeScript) | 0.7.0 |
| Pips API | 43 (CLI 0.48.0 advertises 41) |
| Editor protocol | v14 |
| Pips registry schema | 37 (34 in CLI 0.48.0) |

## Security model

### Who can do what

Pips separate four kinds of actor. Every control request carries the actor that
made it, and the controller decides what that actor may do.

| Actor | Who | May |
| --- | --- | --- |
| Local user | The Pips view (`editor-user`) and `dgc pips` (`local-console`) | Everything a person decides: create, accept and reject proposals, setups and handoffs, prepare and accept external actions, archive, stop |
| Main chat | The main DGC chat's model, through its Pips tools | Read Pips data; set up and change Pips when the permission engine allows the call (accepted as `chat-permission:<mode>`), except setups with app reads or Pulse commands, which stay cards; save handoffs and drafts for review; queue runs of read-only Pips; pause, resume and attach Pips. Each call passes DGC's permission engine. |
| Automation | The runner's scheduler (`local-scheduler`) and event trigger (`local-event-trigger`) | Queue runs that a reviewed schedule or trigger already authorizes |
| Pip worker | The model inside a run | Only its run kind's tools, listed under [Run kinds](#run-kinds) |

Accepting a handoff or an external action, and a setup with app reads or Pulse
commands, is a local-user decision. Another setup or a name, goal or source-ref
proposal from the main chat is accepted by the call's own permission decision (auto
mode, an allow rule or the user's Allow), recorded as `chat-permission:<mode>`; a new
Pip created that way gets a 200,000-token daily limit (`pip_spend.DEFAULT_CHAT_CAP`).
No main-chat tool, scheduler, trigger or Pip worker can accept one. Personal Pips,
external actions, connections and setup reviews are available only to the local
user's own controllers.

The `dgc pips` CLI acts as the local user, so a chat that ran it in its shell (in auto
mode, without asking) could approve its own Pips. Every shell DGC runs for the model
(`bash`, `python`, monitors) carries `DGC_AGENT_SHELL=1`, and so does a subscription
engine's CLI (Claude Code, Codex), whose own shell is the model's too. A command you type
yourself (`!cmd`) and your own hooks and gate command do not. With the marker, `dgc pips`
allows only reading commands and the emergency stop, never marks the digest seen, and
refuses the rest with exit status 2. Memory statements can be listed (and anchored for
reading), never recorded or revoked. A DGC started from a marked shell inherits the
marker: its `/pips` is refused the same way, and its `dgc serve` (the backend an SDK
script starts) serves `get_`, `list_` and `inspect_` controls, `export_pip`, `stop_pips`
and turning Pips off, and refuses everything else with `agent_shell`. The guard is in the CLI,
so on Linux and macOS the model's shells (and a subscription engine's) find this build's own `dgc`
first on `PATH`: a launcher in a private temporary directory that starts the same Python on the
same package, whatever older `dgc` you have installed or whatever `dgc` folder the project holds.
On Windows the shell keeps your `PATH`. This is a guard against a chat taking the wrong path, not a
security boundary: an unsandboxed shell runs as you and could edit the registry
directly, like any other process of yours.

### An independent runner

Pip work runs in a separate supervisor process, not inside a chat. Because it can't
inherit a chat's limits, Pips refuse to work from a restricted session: if a session
has an SDK runtime policy or a requested sandbox, the main chat gets no Pips tools,
and the editor bridge, `handle_control` and the SDK refuse Pips controls. Nothing is
silently run with weaker limits.

Every control request also requires `pips_enabled` to be exactly `true`.

### Run isolation

Each run executes in a fresh worker subprocess:

- Its `HOME` and `DGC_HOME` are a private, owner-only folder inside the run
  directory. Its working directory is DGC's own package location, never the
  project.
- It inherits only `PATH`, `LANG` and the minimum platform variables. The model API
  key is passed once over a private pipe, never in arguments, the environment or a
  saved manifest.
- Its configuration has no MCP servers, hooks, skills, fallback models, delegated
  subscription engine, code-action interpreter or verifier. Project permission
  files and project agent definitions are not loaded.
- A fixed policy denies every tool outside the run kind's allowlist, in every mode,
  and the worker can't approve anything. The policy's digest is checked before the
  model starts.
- Project `DGC.md` and `AGENTS.md` are not loaded as instructions. A Pip can read
  them as files in its source copy, where they are untrusted evidence.
- The worker exits if its parent process goes away. All its output is redacted for
  configured secrets.

The model worker has no operating-system sandbox; its boundary is DGC's tool
allowlist and deny policy. Commands that Patch and Pulse run are the exception:
they always run under OS confinement, bubblewrap on Linux and Seatbelt on macOS
(below). None of this defends against a malicious process already running as your
user.

Model routes: a Pip uses DGC's configured native model connection, with API mode
`auto`, `ollama`, `anthropic`, `chat_completions` or `responses`. Delegated subscription engines are
refused. A run pins its model and endpoint when it is queued; if the endpoint or
API mode changes before it starts, it fails with `model_changed`. Rotating the key
for the same endpoint is fine.

### Source

| Source policy | Used by | What the Pip reads |
| --- | --- | --- |
| `{"mode": "committed_only"}` (default) | Project Pips | The exact committed tree at `source_ref`, resolved to a commit when the run is queued |
| `{"mode": "current_tree", "exclusions": "safe_source_v1"}` | Scout, Lens, Rook, Lock, Quill; manual runs only | A checked copy of the project folder as it is now, taken when the run is queued |
| `{"mode": "personal"}` | Personal Pips | Nothing: an empty source folder |

**Committed source.** The workspace must be the repository root. DGC reads exact
blobs with `git ls-tree` and `git cat-file`, so checkout filters, hooks and LFS don't
apply and dirty or untracked files are excluded. Only regular and executable files
are accepted; a committed symbolic link or submodule fails the run. No exclusions
apply, so a committed `.env` file is readable. `source_ref` is `HEAD`, a branch or a
full commit ID.

**Current tree.** The copy follows no links and refuses hard links, special files,
other mount points, nesting deeper than 32 and any file that contains a configured
secret. It is checked again after copying, before the worker starts, inside the
worker, and after it finishes. `safe_source_v1` leaves out:

- names starting with `.env`;
- `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.DS_Store`, SSH private keys
  (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`), `credentials`, `secrets` and
  `kubeconfig` (with their `.json`, `.yaml` and `.yml` forms);
- files ending `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.tfstate` or
  `.tfstate.backup`;
- the folders `.git`, `.hg`, `.svn`, `.dgc`, `.ssh`, `.aws`, `.azure`, `.gcloud`,
  `.config`, `node_modules`, `vendor`, `.venv`, `venv`, `__pycache__`, `.cache`,
  `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.next`, `.nuxt`, `.turbo`,
  `.gradle`, `build`, `dist`, `target` and `coverage`.

A current-tree Pip can't have a schedule, an event trigger or a handoff; proposing
the policy also proposes removing them. Its runs have `source_revision: null` and a
separate `source_snapshot` receipt. A snapshot hash is never a Git commit.

**Changes since the last checkpoint.** A committed audit also receives a bounded
list of paths that changed between the previous checkpoint's commit and its own (up
to 64 paths). This is reference data, not a claim that anything was fixed.

### Patch and Pulse commands

Patch and Pulse execute only an exact, reviewed action. Execution needs either Linux
with working bubblewrap (`/usr/bin/bwrap`, `/usr/bin/python3` and `/usr/bin/git`), or
macOS with `/usr/bin/sandbox-exec` and Xcode or the Command Line Tools (see **macOS**
below). A real confinement probe must pass; there is no unconfined fallback.
`dgc pips execution` shows the result, including the backend (`bwrap` or `seatbelt`)
and, on macOS, the runner's `limitations`.

- **Private copy.** The committed source is copied into the run's `worktree`, with
  its own private Git store outside the edit root. Your repository's refs, index,
  config, hooks and files are never touched.
- **Patch edits.** Patch gets `write_file`, `edit_file`, `multi_edit` and
  `apply_patch`. Every write is checked against the action's exact `write_paths`.
  After the model finishes, DGC diffs the whole copy and fails the run if any other
  path changed. The diff is saved as `artifacts/changes.patch` (at most 256 KiB). It
  is never applied, committed, merged or deployed.
- **Commands (Linux).** Each reviewed `argv` runs in bubblewrap with every namespace
  unshared (so no network), capabilities dropped, standard system folders mounted
  read-only, the project copy mounted read-only at `/workspace`, a 64 MiB writable
  `/tmp`, and a fixed small environment. Inside, rlimits cap address space at
  512 MiB, CPU at 30 seconds, file size at 64 MiB, open files at 64 and processes
  at 32. The parent enforces a 60-second wall limit, a 64 KiB output limit and
  cancellation, and samples total memory. Output is saved as `artifacts/test-N.txt`.
- **Statuses.** `passed`, `failed`, `timed_out`, `cancelled`, `output_limit`,
  `resource_limit`. A failure doesn't stop later commands; the other stop states do.
- **No model in plan runs.** A standing Pulse verification plan runs its commands
  in the controller without constructing a model at all.

Commands see only system-installed runtimes. Nothing is installed, and a suite that
writes into the project folder fails because the copy is read-only.

**macOS.** Each reviewed `argv` runs as `sandbox-exec -p <profile> python3 -I -c
<limits> <argv>`: no shell, absolute helper paths, and the real `python3` of the
selected Xcode or Command Line Tools folder (found with `xcode-select -p`). The
`/usr/bin` shims are never run, so a Mac without developer tools reports execution
unavailable instead of opening an install prompt. The environment is fixed: `PATH`,
`LANG`, `PYTHONDONTWRITEBYTECODE`, `PYTHONNOUSERSITE`, and `HOME` and `TMPDIR` inside a
private scratch folder in the run folder, created for each command and removed after
it. The generated profile:

- denies every write except that scratch folder and the standard output devices, so
  writing the project copy fails with `EPERM`;
- hides home folders (`HOME`, the account's home, `/Users`), DGC state, the run folder
  (its private Git, source snapshot and the other runs) and the shared temporary
  folders (`/private/tmp`, `/private/var/tmp`, `/private/var/folders`); only the copy
  and the scratch folder are readable inside them;
- denies all network access, including loopback;
- lets a command signal or inspect only processes in its own sandbox, so it can't read
  another process's arguments or environment, and blocks the keychain, clipboard and
  Apple Events services;
- denies setting ACLs, so the scratch folder can always be removed.

Kernel rlimits on macOS are CPU 30 seconds, file size 64 MiB, open files 64 and no
core dumps. DGC never sets `RLIMIT_NPROC` there (macOS counts it per user across the
whole system) or `RLIMIT_AS`/`RLIMIT_DATA` (macOS rejects finite values). Commands run
in the copy's real path, not `/workspace`, so use relative paths. `PATH` is
`/usr/local/bin`, `/opt/homebrew/bin`, the developer tools' `usr/bin`, then the system
folders, so `python3` and `git` are the real tools rather than the `/usr/bin` shims.

The macOS guarantees are weaker than Linux, and the runner reports each of these as a
limitation:

- **No PID namespace.** The runner samples the command's process tree about every
  50 ms through libproc (children, plus the process groups its processes created) and
  kills whatever the command left running when it exits. A process that detaches into
  a new session faster than one sample can outlive the command. It stays inside the
  profile and its rlimits.
- **Sampled caps.** Memory (512 MiB, the summed footprint of the whole tree), the
  process count (32) and the scratch folder (64 MiB) are checked by sampling, not
  enforced by the kernel. A spike can exceed them between samples; the command then
  stops with `resource_limit`.
- **No private loopback.** All network is denied, so a test that starts or contacts a
  local server fails.
- **System paths stay readable.** Folders outside home folders, such as `/usr`,
  `/Library`, `/Applications` and `/opt`, are readable.
- **Deprecated helper.** Apple marks `sandbox-exec` as deprecated; a future macOS
  release may change or remove it, and the probe then reports execution unavailable.

**Local HTTP checks** (`network: "loopback_http_v1"`, standalone Pulse plans only).
Each check is exactly `["dgc-http-check", "http://127.0.0.1:PORT/path", "STATUS"]` with
`cwd: "."`, a port from 1024 to 65535 and one expected status. A fixed, isolated
Python helper sends one GET with no redirects, cookies, credentials, proxy, query or
body; it reads at most 64 KiB and discards it. Limits: 10 seconds, 5 CPU seconds,
512 MiB (address space on Linux; sampled on macOS), 3-second socket timeout. The
helper runs outside the sandbox because it must reach your loopback interface; the
URL rules are an application-level allowlist, not a firewall. Pulse doesn't start your
app, and the app may not be running the committed source recorded with the run.

**Specialists.** A Patch action may add
`"specialists": {"roles": ["explorer", "critic", "worker"], "max_calls": 1–3}`.
Specialists are synchronous child agents inside that one run: Explorer and Critic
read only; Worker has the parent's exact `write_paths`. They share the parent's
budget (12 model requests, 64 tool calls, 300 seconds) and can't run commands, use
the network or start further children.

### Personal scope

A Personal Pip's run has no tools. It receives its approved goal, its chat history,
and the results of its approved app reads and web reads, all as reference data.
In its own conversation it can call only five inert drafting tools:
`draft_pip_change` (name, goal, schedule or model of itself), `draft_email`,
`draft_calendar_event`, `list_connector_tools` and `draft_connector_action`. Each
saves at most one draft per reply, and only if the reply succeeds and the Pip
hasn't changed meanwhile. Any other call is refused.

App reads, web reads and external actions run in the controller, never in the
worker. The worker gets no credentials, MCP process or connection.

### External actions

An email, calendar event or connector call is an **external action**:

1. A draft (from a Personal Pip's chat or the main chat) or a direct proposal saves
   a pending review that pins the source result, the Pip's job version and
   lifecycle revision, the saved connection, the tool schema and the exact
   payload. Reviews expire after 24 hours.
2. The local user accepts it with the exact review digest.
3. DGC rechecks that Pips are on, the runner isn't stopped, the Pip is active and
   every pin is current, then commits `dispatching` before calling the provider.
4. The action ends as `succeeded` with a receipt, or `unknown`. Accepting again only
   shows the saved attempt. DGC never retries.

| Kind | Route | Fixed rules | `succeeded` means |
| --- | --- | --- | --- |
| `gmail_send` | Composio `GMAIL_SEND_EMAIL` with the chosen account | One recipient (up to 254 bytes, plain address), subject up to 200 bytes, plain-text body up to 12,000 bytes; no CC, BCC, HTML or attachments | The provider accepted the message; delivery is not confirmed |
| `calendar_create` | Composio `GOOGLECALENDAR_CREATE_EVENT` with the chosen account | Primary calendar, private, busy, no meeting link; guests can't modify, invite or see the guest list; title up to 200 bytes, description up to 8,000; at most seven days long; offsets must match the IANA zone; start still in the future | The provider confirmed creation, checked against the reviewed times, title, guests and series. Invitation delivery and acceptance are not confirmed. |
| `connector_call` | One tool on a saved `zapier`, `arcade`, `make` or `n8n` connection | Exact tool and arguments (up to 10,000 bytes); the connector manages its own accounts; response up to 32 KiB, kept as a digest and 1 KiB preview | The connector returned a response; downstream completion is not confirmed |

A connector call can invoke any tool the connector exposes; DGC doesn't filter by
what a tool does. A workflow may keep running after DGC's deadline. A Pip itself
can't book, buy, pay, reserve or sign up for anything, and is told to gather the
details and say what you need to do instead.

## Review and approval

Every review is a saved, immutable record. Accepting it rechecks a pin, so a stale
decision never applies to a newer state.

| Review | Created by | Pinned by | Expires |
| --- | --- | --- | --- |
| Job proposal | A person, the main chat (`pips_propose`: name, goal, source ref only), or a Pip's own chat (`draft_pip_change`, Personal) | `expected_version` | 7 days |
| Setup card | The main chat (`pips_setup`) | Digest of the card | 7 days, or once its next run time passes |
| Handoff | A person or the main chat (`handoff_to_pip`) | `expected_revision` | 7 days |
| Draft (email, calendar, connector) | A Personal Pip's chat or the main chat | Draft digest | 24 hours |
| External action | Preparing a draft, or a person directly | Action digest | 24 hours |
| Finding or execution review | A person | `expected_revision` | Never |
| Workspace context change | A person | Context `expected_revision` | Never |

- A job can have up to 20 pending proposals; accepting one supersedes the others.
  Accepting rechecks the version and refuses to change the Pip's type or broaden
  its policy.
- A setup card is accepted only if its project folder, binding, runner and
  directory identity are unchanged, it holds no secrets, and its displayed next run
  is still in the future. For an existing Pip it also needs no queued or active
  runs and no pending reviews. Accepting a card makes the Pip active (a paused Pip
  is resumed). A Pulse card's approval is also its execution review. A card with
  "run once" queues one run and needs a live runner.
- Accepting a handoff rechecks the source finding or result, the target job and the
  target's model connection, then queues exactly one run.
- Retries are safe: the same request key or idempotency key with the same content
  returns the original record; different content under the same key is refused.

### Adaptation policies

| Mode | Model may propose changes | Changed without review |
| --- | --- | --- |
| `locked` | No | Nothing |
| `context_adaptive` | No | Nothing |
| `suggest_changes` (default) | Yes, for your review | Nothing |
| `bounded_adaptive` | Yes, for your review | The chosen subset of `name` and `source_ref` |
| `autonomous` | Yes, for your review | `name` and `source_ref` |

Automatic changes come only through the main chat's `pips_adapt` tool (permission
`PipsAdapt`), only within a policy a person approved. They create a new job
version but never start work, resume a Pip or change permissions. A Pulse Pip with
a verification plan is never adapted. Goal, schedule, triggers, model, tools and
permissions always need review.

## Registry and state

State lives in `.dgc/pips` under your home directory, or `$DGC_HOME/.dgc/pips` when
`DGC_HOME` is set. The folder is owner-only and may not be a symbolic link.

| Path | Contents |
| --- | --- |
| `registry.sqlite3` | The registry (mode 0600, WAL, so `-wal` and `-shm` files sit beside it). Schema 33; a newer schema is refused by older DGC. |
| `supervisor.log` | Output of a runner started from the editor (0600) |
| `locks/` | The `pips-supervisor` and `pips-runner` leases |
| `personal/` | The Personal workspace's empty root |
| `runs/<run id>/` | `source/` (read-only copy), `worktree/` and `private-git/` (Patch and Pulse), `artifacts/`, `worker-home/` |

The registry is created on first use. With Pips on, per-turn bookkeeping (session
association, turn records, verifier receipts) starts only once the registry exists,
so a profile that never uses Pips gets no Pips state.

**Workspaces.** A project workspace is a stable ID bound to a canonical folder.
There is one Personal workspace per profile. Once the profile uses Pips, saved chats
are associated with their workspace as they are saved, and
`dgc pips workspace backfill` associates older ones. If you move a project,
`dgc pips workspace rebind` points its workspace at the new folder, and
`dgc pips workspace migrate-session` moves one saved chat to it. All three show a
read-only preview unless you pass `--apply`.

**Pip definition.** Each Pip has immutable numbered versions. A version holds
`name` (up to 120 characters), `goal` (up to 4,000), `source_ref`, `pip_type`,
`policy` (`read_only`, or `review_required` for project Patch and Pulse), `trigger`,
`schedule`, `event_trigger`, `model_choice`, `adaptation_policy`, `source_policy`,
and optionally `verification_plan`, `app_plan` and `web_plan`. A definition is at
most 16 KiB.

**Lifecycle.** A Pip is `active`, `paused` or `archived`. Every status change
increments `lifecycle_revision`, separately from the job version. Archiving needs
an idle Pip (no unfinished runs, pending proposals, handoffs or external actions),
keeps all history and consumes due schedule times. Restoring returns the Pip to
`paused`. Resuming a Pip that was ever archived requires its current lifecycle
revision. A global emergency stop pauses every Pip, cancels queued and running work
and discards trigger backlogs; resuming the runtime leaves every Pip paused.

**Workspace context.** Shared reference records for a workspace:

| Item | Limit |
| --- | --- |
| Kinds you record | `decision`, `milestone`, `command`, `risk`, `exception` |
| Promoted kinds | accepted findings, accepted Patch/Pulse outcomes, accepted session statements, recorded command receipts |
| Title / content | 240 / 4,096 UTF-8 bytes |
| Active entries | 32 per workspace |
| Retained entries | 512 per workspace, including archived ones |
| Pinned snapshot | 16 KiB |

Records are immutable; archiving removes one from the active view. Every change
needs the current revision. A run pins the context snapshot when it is queued.

**Pip memory.** *Exceptions* bind a reason to one checked finding of one Pip. They
never hide the finding or change its review. *Claims and preferences* are short
records for one Pip (title 200, statement 2,000, reason 1,000 bytes); a claim is a
recorded claim, not a verified fact, and each one needs an explicit expiry or an
explicit "no expiry". An exception's expiry is optional. Exceptions and statements
share a limit of 32 active records per Pip and 1,000 retained per runner. Audits and
Pip chats receive up to 16 whole records (8 KiB) as reference, labelled with whether
their source and job version still match.

**Session records.** *Session statements* let you promote your own statement about
a saved chat into workspace context, pinned to an exact commit or a completed run
(statement up to 1,536 bytes). They are stored as not execution-verified. *Command
receipts* record the outcome of the main chat's configured verifier command; you
can review one and record it in context. An exit code is a process outcome, not
proof that tests passed.

**Activity and notifications.** Each workspace keeps its latest 5,000 activity
events. The notification list is built from those events: reviews waiting for you
and failed runs. It keeps the newest 500 across the runner, and marking one read
changes nothing else.

**Run cleanup.** When a run reaches a final state, the runner removes its `source/`
copy and, for Patch and Pulse, its `worktree/` and `private-git/`; it removes the
run's `worker-home/` once the run's token usage is in the ledger. `artifacts/` and
the run record stay. A runner also sweeps up to 200 older finished runs when it
starts. Links are removed, never followed.

**Retention ceilings.** Run records are not deleted automatically, and archiving or
exporting frees nothing. Per runner:

| Record | Ceiling |
| --- | --- |
| Project runs, including conversation replies | 20,000 |
| Personal runs and replies | 20,000 |
| Pip chat messages | 20,000 |
| Audit checkpoints | 20,000 |
| Exceptions plus claims and preferences | 1,000 |
| Session statements | 1,000 |
| Setup cards | 1,000 (20 pending per workspace) |
| Handoffs | 1,000 (20 pending per workspace) |
| Job proposals | 10,000 |
| External actions | 10,000 |
| Lifecycle operations and attachments | 10,000 each |
| Workspaces | 256 |
| Pips per workspace | 100, including archived ones |

When the run ceiling is reached, no new run, reply, schedule or trigger work is
queued. `dgc pips capacity` reports the retained count, this workspace's share and
the remaining room for runs, checkpoints, memory and session statements, marking a
counter `near_limit` at 80%. It reads only; it changes and frees nothing.

**Exports.** `dgc pips export-run RUN_ID --output PATH` writes one terminal run of the
current workspace (or the Personal workspace) to a new file. `PATH` must be absolute,
must not exist, and its folder must be yours and not writable by others; the file is
written with mode 0600. Both export forms need Linux.

- `--format jsonl` (the default) writes evidence in the `dgc.pip-evidence.v1` format:
  one JSON record per line, from a header to a footer whose SHA-256 covers every
  earlier line. It includes the run, a projection of its job and source receipt, its
  result or error, checkpoint and review history, and up to 25 references to related
  handoffs, memory, context and session statements. It leaves out conversation
  bodies, source files, artifact files, transcripts and activity payloads, and
  redacts configured secrets. It is marked as neither importable nor restorable.
- `--format markdown` writes the document from a succeeded Personal task or Quill
  draft, up to 128 KiB.

## The runner

The runner (supervisor) is a separate local process. It writes a heartbeat every two
seconds, fires due schedules and triggers, and executes queued runs one at a time
under the `pips-runner` lease. Only one supervisor can run per state folder. A
heartbeat older than 15 seconds reads as offline. Queueing a run, a chat reply or a
handoff needs a live supervisor: a fresh heartbeat and a held lease.

| Start it with | Behaviour |
| --- | --- |
| `dgc pips serve` | Runs in the foreground. Ctrl+C or SIGTERM cancels only its own active run; queued work stays queued, and no global stop is set. `--enable` also turns Pips on. |
| **Start runner** in the Pips view | Launches the same supervisor as a detached process from DGC's own package folder. It outlives the editor, but not a logout or restart. Its output goes to `supervisor.log`. |
| `dgc pips service …` | Linux only, through the user's systemd. See below. |

**Emergency stop.** `dgc pips stop` (or `stop_pips`, or disabling Pips in the editor)
saves a stop record first, then pauses every active Pip, cancels queued and running
work and discards trigger backlogs. The supervisor exits at its next check and won't
start again until `dgc pips resume`. Resume waits until no supervisor or worker holds
its lease, marks interrupted runs as failed or cancelled (they are never replayed),
clears the stop and leaves every Pip paused.

**Linux service.** `dgc pips service preview` shows the exact unit before anything is
written. The unit is named `dgc-pips-<24 hex digits>.service`, derived from the DGC
home, and lives in the systemd user unit folder (`$XDG_CONFIG_HOME/systemd/user`, by
default `.config/systemd/user`).

- It runs `dgc pips serve` through `env -i` with only `HOME`, `DGC_HOME`,
  `PATH=/usr/bin:/bin`, `LANG` and fixed Python flags. Environment variables from
  your shell, including API keys, are not passed on: save credentials in DGC's own
  settings.
- It sets `UMask=0077`, `NoNewPrivileges=yes`, `KillMode=mixed`,
  `TimeoutStopSec=90` and `Restart=no`, so it never restarts itself after an
  emergency stop.
- `install` writes the unit (0600) and reloads systemd but doesn't start or enable
  it. `start`, `stop`, `enable` (start at login) and `disable` are separate.
  `uninstall` needs the service stopped. DGC changes only a unit whose bytes match
  what it generated, and never configures lingering.
- The DGC home's `.dgc` folder, `config.json` and `secrets.json` must be owner-only.

**Platforms.** Queueing and running work needs a POSIX system, so Windows can't run
Pips work. Audits, Quill drafts, conversations and Personal tasks run on Linux and
macOS. Patch, Pulse and local HTTP checks need Linux with bubblewrap, or macOS with
Seatbelt and Xcode or the Command Line Tools, with weaker guarantees (see **macOS**
under Patch and Pulse commands). Current-tree source needs POSIX directory handles.
`export-run` and `capacity` need Linux `/proc`. The service needs Linux with user
systemd.

## Run kinds

| `run_kind` | Pips | Started by | Model tools |
| --- | --- | --- | --- |
| `audit` | Scout, Lens, Rook, Lock | Manual, schedule, event, main chat, read-only handoff | `read_file`, `glob`, `grep`, `repo_map`, `todo` |
| `draft` | Quill | Manual, schedule, event, main chat | The same read tools |
| `conversation` | Any | A chat message | Project: the same read tools. Personal: the five drafting tools only. |
| `patch` | Patch | An accepted handoff | Read tools plus the four write tools on reviewed paths; `task` only with a specialists grant |
| `test` | Pulse | An accepted handoff, or a standing verification plan (manual or scheduled) | Read tools (handoff); none, and no model (plan) |
| `personal_task` | Any Personal Pip | Manual, schedule, main chat, Personal handoff, an approved computer action | None; `computer` when the job has a computer (API 42) |

Conversations work while a Pip is paused, and are always read-only, including for
Patch and Pulse. One reply per Pip can be queued at a time.

**Reports.** An audit must read at least one file. Its report has a summary, up to
16 findings and up to 12 limitations, in at most 32,000 bytes. Every finding's
excerpt is checked against the source copy. If the model's report is malformed,
DGC makes one tool-free reformatting attempt and checks again. Each successful audit
saves an immutable checkpoint; the next audit compares findings with it (`new`,
`repeated`, `not_observed`) and receives the previous findings and your reviews as
reference.

**Quill drafts** return a title, a summary, Markdown (up to 24 KiB) and 1 to 16
citations, each checked against the source. The controller saves the draft as a
private `artifacts/documentation.md`.

**Conversations.** A message is up to 4,000 characters (8 KiB); a reply up to 24 KiB.
Recent complete exchanges are sent with the next message, up to half the reply's
context budget (at most 64 KiB); older exchanges are folded into a summary of at most
8 KiB, which you can inspect. Per-reply options: `context_size` 2,048 to 1,048,576
and `thinking` `off`, `low`, `medium`, `high` or `xhigh`. Scheduled and handoff runs
use at most a 32K context, 4,096 output tokens and no extra reasoning.

## Schedules and event triggers

A job has a `schedule` or an `event_trigger`, never both. Both only fire while the
runner is running, and both are checked every two seconds, at most eight Pips per
check.

**Schedules** (`missed_policy` is always `coalesce_latest`):

```json
{"type": "interval", "minutes": 60}
{"type": "daily", "time": "09:00", "timezone": "Europe/London"}
{"type": "cron", "cron": "0 9 * * 1-5", "timezone": "Europe/London"}
{"type": "once", "at": "2026-11-01T09:00:00.000Z"}
```

- `interval`: 5 to 10,080 minutes from the moment the schedule was set (approval,
  or the setup card's creation).
- `daily` and `cron` need an installed IANA zone. DST policy is
  `skip_gap_first_fold`: a missing local time is skipped, a repeated one runs at its
  first instant.
- `cron`: five numeric fields (minute, hour, day of month, month, weekday 0–7),
  numbers, `*`, lists (up to 32 items), ascending ranges and steps on `*` or a
  range (`5-59/10`, not `5/10`). No names, macros, `?`, `L`, `W` or `#`. At most 256
  characters, runs at least five minutes apart (288 a day at most), and it must
  recur within 366 days. If both day fields are restricted, either may match.
- `once`: seconds and `Z` or an explicit offset are required. It must be in the
  future when approved, and runs once.
- Missed times collapse into one run for the latest. A paused or busy Pip skips the
  time. A failed or cancelled run is not replayed. A queue error retries after 30
  seconds.

**Event triggers:**

```json
{"events": ["committed_paths_changed"], "minimum_minutes": 5,
 "commit_paths": [{"kind": "directory", "path": "src"}, {"kind": "exact", "path": "pyproject.toml"}]}
```

| Event | Source | Scope |
| --- | --- | --- |
| `commit_changed` | The Pip's `source_ref` resolves to a different commit | This Pip |
| `committed_paths_changed` | A commit change touches a listed path | This Pip |
| `finding_accepted` | A finding review is set to accepted | Any Pip in the workspace |
| `context_updated` | Context recorded, archived or promoted | The workspace |
| `session_turn_completed` | A top-level main-chat turn finishes and is saved | Chats in the workspace |

- Only Scout, Lens, Rook, Lock and Quill on committed source. One to four distinct
  events. `minimum_minutes` is 5 to 10,080 (default 5); events inside the gap merge.
- Enabling a trigger records the current position: nothing older is replayed. Only
  the latest pending event is used, and a busy or paused Pip skips it. Pausing,
  resuming and the emergency stop discard backlogs.
- Commit watching runs `git rev-parse` on the bound repository at most every 30
  seconds per Pip. The first observation and any change of ref or binding set a
  silent baseline. Intermediate commits merge.
- `commit_paths`: 1 to 32 literal rules (`exact` or `directory`), each up to 256
  bytes, 2 KiB in total; no globs, `.`, `..` or `.git`. A directory rule matches
  paths under it, not a sibling with the same prefix. Can't be combined with
  `commit_changed`. Comparisons use the net tree difference between the two commits.
- The run gets only the event's ID, sequence, type and time, and reviews the ref's
  commit at the moment it is queued. The workspace keeps 5,000 events, so after a
  long outage older events may be gone.
- `session_turn_completed` counts only foreground turns that end with a successful
  save: not goal resumes, monitor wake-ups, sub-agents, Pip runs or delegated
  subscription turns.
- A scheduled or triggered audit is skipped (`source_unchanged`) when its last
  checkpoint has the same job version, model and workspace context digest and the
  committed tree comparison reports no changes. Current-tree sources never compare,
  so they never skip. The occurrence is recorded as `pip_schedule_skipped` or
  `pip_event_trigger_skipped` with that reason. Manual, chat, handoff and setup runs
  always run.

**GitHub reads** (API 41). `github_plan` is
`{schema_version: 1, repository: "owner/name", reads: [...]}` with one to four reads, each
kind at most once: `open_issues` (`limit` 1–20, default 20; optional `labels`, one to five,
no commas), `open_pulls` (`limit` 1–20), `commit_checks` (check runs and commit statuses for
the run's pinned commit) and `failed_runs` (`limit` 1–10). It is allowed on project Scout,
Lens, Rook, Lock and Quill jobs, is pinned on audit and draft runs, and is read by the
controller before the worker starts: GET requests to `api.github.com` only, no redirects,
1 MiB per answer, 60 seconds in all, authorized again before each read. The credential is
`GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`; it is added to the redaction list and never
reaches the worker. Each read gives the worker at most 8,000 characters of JSON, dropping
whole items rather than cutting text; a failed read is reported with its error. The run
records `pip_run_github_reads` with each read's kind and item count or error, not the text.

**Sharing** (API 41). `export_pip {pip_id}` (local only) returns `{document, text}`: a
`dgc-pip` version 1 document `{format, version, pip: {name, goal, pip_type, scope,
schedule, event_trigger?, model_choice?, web_plan?, source_ref?, verification_plan?},
left_out}`. App plans, GitHub plans, IDs, memory, history, findings and results are never
included; a default model choice is left to the importer. Patch cannot be exported. Files
are at most 24 KiB. The editor's `import_pip_document {document}` (chat backend, like a
starter) checks the document and saves it as a pending setup card for that chat; the CLI's
`dgc pips import` shows the job and what was left out, asks, then creates it (not Pulse).

**Offering a Pip** (API 41). On a chat's first prompt the main chat compares it with how
the newest 40 chats of the last 30 days in this project began (word overlap of at least
0.6, at least four significant words, files above 2 MB skipped). Two or more alike add one
line to the system prompt: offer once to make it a Pip, prepare a setup card only if the
user agrees. It is guidance, not a gate; no tool appears or disappears on it, and plan mode
and sub-agents never get it. The `use_pips` description says the same for any recurring
request, and that no Pip buys, sells, trades or pays. The editor's Make this a Pip only
drafts the request in the composer.

**Previous result** (API 41). A `personal_task` run pins `manifest.previous_result`
`{run_id, finished_at, text}`: the Pip's latest succeeded Personal task result, redacted
with the current secrets and cut to 6,000 characters. The worker shows it as reference
"for comparison only", so a watch reports what changed and a digest leaves out what it
already said. A conversation does not get it (its history is the chat).

**Ratings** (API 41). `set_pip_feedback {run_id, rating, note}` (local only) rates a
succeeded `personal_task`, `audit` or `draft` run: `rating` is `"up"`, `"down"` or null to
clear, `note` at most 500 characters of plain text. It returns `{pip_id, feedback}`, the
newest 20 `{run_id, rating, note, at}`; `list_pip_feedback {pip_id}` returns the same. The
newest 50 per Pip are kept in registry metadata, outside the job, and each rating records
`pip_feedback_recorded`. Those three run kinds pin `manifest.user_feedback`, the newest five
ratings with notes redacted by the current secrets, and the worker shows them as reference
"where it fits the approved goal", never as a new task, a job change or a permission.

**Usage and daily limits** (API 41). `get_pip_usage {pip_id}` returns `{usage: {pip_id,
today: {day, tokens, runs}, last_30_days: {tokens, runs}, days: [{day, tokens, runs}],
daily_cap, capped_today}}` over local days. A run's tokens are the input plus output tokens
the runner imported for it (`pip_usage_imports` in the usage ledger now keeps each run's
totals, all of its requests); a run not imported yet counts its result's `usage`.
`set_pip_daily_cap {pip_id, daily_tokens}` (local only; 1,000 to 1,000,000,000, or null)
is kept in registry metadata, outside the job definition, and records
`pip_daily_cap_changed`. While today's tokens are at or over the limit, `enqueue` refuses
schedule and event occurrences with `daily_cap_reached`, which the scheduler and the
trigger controller record as an ordinary skip (a skipped occurrence does not run later);
manual, chat, handoff and main-chat runs are not limited, and neither is a standalone
Pulse schedule, which runs its reviewed commands without a model.

**Always allow** (API 41). `always_allow_pip_app_action {action_id, expected_digest}` (local
only) accepts one pending action like `accept_pip_app_action` and then saves a grant for its Pip:
`{id: grant_<32 hex>, kind, server, connection_digest, account, schema_digest, tool, label,
created_at, created_by}`, returned as `{action, grant}`. `list_pip_action_grants {pip_id}` and
`revoke_pip_action_grant {pip_id, grant_id}` (local only) return `{pip_id, grants}`. Grants live
in registry metadata (`pip_action_grant:<pip_id>:<grant_id>`, at most 20 per Pip), outside the
job, and record `pip_action_granted` / `pip_action_grant_revoked`.

A Personal task now pins `email_draft`, `calendar_draft`, `action_grants` (a summary) and, only
when the Pip has a connector grant, a `connector_draft` snapshot; a handoff run pins none. Its
worker may return `message_draft`, `calendar_draft` and `connector_action_draft`, which `finish`
saves as drafts (actor `pip-<kind>:<run_id>`). After each finished run the runner calls
`pip_action_grants.dispatch_for_run`: a draft whose kind, connection, account, tool and schema a
grant matches (for connectors, the draft's own pinned digests too) is prepared and accepted as
`pip-grant:<grant_id>`; `pip_app_actions` checks that grant against the exact payload, and only
the runner uses that actor. Anything else stays a draft, and a failed match records
`pip_action_grant_skipped`. The digest counts waiting drafts and actions as `pending_actions`,
and the desktop notifier names each action a grant ran.

**Token usage by Pip** (editor protocol, capability `pip_usage_report`). `get_pip_usage_report
{request_id, range}` is answered by one `pip_usage_report {request_id, range, generated_at,
timezone, all_tokens, totals: {input_tokens, output_tokens, runs}, by_pip: [{pip_id, name,
pip_type, scope, project, status, input_tokens, output_tokens, runs, daily_cap}], omitted,
error?}` (`dgc/pip_usage_report.py`). Runs that finished in the range count on that local day,
with the imported totals or the run's own reported usage; `all_tokens` is the same range's
ledger total, so the Pips are shown as a part of it, never added to it. It reads the registry
even with Pips off and creates none for a profile that never used them.

**Desktop notifications** (API 41). The runner checks once a minute (`pip_desktop.Notifier`)
for alert findings in the digest and for pending reviews and setup cards, and shows one
notification for what is new: the digest headline, or "N reviews waiting". What it has
announced is kept in registry metadata (`desktop_notifications_seen`, 400 ids per kind), so a
restart does not repeat it; while the setting is off it still marks what arrives as seen.
Delivery is `notify-send` (with the session bus at `/run/user/UID/bus` when the service has
none) or `osascript` with the text as script arguments; failure is never an error and is
recorded as `last.shown: false`. `get_pips_desktop_notifications` /
`set_pips_desktop_notifications {enabled}` (local only) return `{on, available, platform,
last}`. The editor's own notice reads `get_pip_digest` from the extension host every minute
(`pipsAttention.ts`, remembered in the host's global state) and is turned off by
`dgc.notifyPips`.

**Keep Pips running** (API 41). `get_pips_keep_running` and `set_pips_keep_running
{enabled}` (local user only) return `{platform, supported, reason, on, starts_at_login,
restarts_after_failure, while_logged_out}`. On Linux, on installs the managed user unit
(format 2: `Restart=on-failure`, `RestartSec=30`; an earlier DGC unit for the same home is
replaced, any other differing unit is refused), enables it, starts it unless a runner is
already online, and asks `loginctl enable-linger` when lingering is off. On macOS, on writes
`~/Library/LaunchAgents/com.vibedgc.pips.<home hash>.plist` (`RunAtLoad`,
`KeepAlive: {SuccessfulExit: false}`, `ThrottleInterval` 30), enables it and bootstraps it
into the GUI domain; an unchanged loaded agent is never reloaded, so a running runner is
not interrupted. Off disables (Linux) or disables and removes the agent (macOS) and never
stops the runner. Both start `pips serve --service`, which exits 0 when Pips are off,
emergency-stopped or already running, so neither manager restarts it in a loop. Writable
parents of the unit directory are refused unless the group is the user's own with no other
member (OpenSSH's rule, so Ubuntu's 775 `~/.config` is accepted).

**Digest and notification settings** (API 41). `pip_notify_settings` holds one row
per Pip that has left the defaults (`min_severity` medium, `alert_severity` high or
null for no alerts, never below `min_severity`); only `editor-user` and
`local-console` can change it, and it is not part of the job definition.
`pip_digest_state` holds when the digest was last seen and on which local day. The
digest is built from runs, checkpoints and reviews finished since then (first time:
the last day; at most a week; at most 400 checkpoints, 20 Pips and 5 findings per
Pip, titles cut to 200 characters and redacted). It is due when a new finding
reaches a Pip's alert level, or when the local day changed and there is anything to
report. The digest and outcomes match findings by path and whitespace-normalized evidence,
not by checkpoint identity (which hashes the title too), so a reworded finding is neither
new nor gone. "Gone after a change" counts baseline findings a compared checkpoint no longer
reports whose path is in that run's changed paths. Outcomes walk the latest
200 checkpoints of one Pip.

**Pip computers** (API 42). `computer_plan` is exactly `{schema_version: 1}`. It is allowed
only on Personal Pips, never together with `app_plan`, and only the local user can propose or
accept it. A `personal_task` run of a job with a computer pins it (`manifest.computer`) and its
worker gets one tool, `computer`, with the operations `open`, `read`, `click`, `type`, `press`,
`choose` and `back`, and from API 43 `files`, `open_file` and `run` (below). From API 43 a
`conversation` run of that Pip gets the same tool, so it uses its computer from its chat. The browser belongs to the supervisor, not the worker: one Chromium per Pip
in `bwrap --unshare-all`, its profile in `computers/PIP_ID/home`, launched with
`--die-with-parent` from a keeper thread. The worker reaches it through a per-run Unix socket
that checks a token. The box has no network except a Unix socket to an egress proxy in the
supervisor, which allows `CONNECT` to port 443 and plain HTTP to port 80 of names that resolve
only to global addresses, and connects to the address it checked. WebSockets are blocked.
Every request from every page and popup is paused in the browser (CDP `Fetch`, Request stage).
GET, HEAD and OPTIONS continue. The rest are held, at most eight at a time; more fail. A held
request whose body carries a Luhn-valid card number (also when form-encoded) is held like any
other, and its summary adds `payment: true` so the review can say so.

A held request becomes a `pip_computer_actions` row: `pending` for 24 hours, with a summary
(method, host, path, page, up to 24 fields with secret-named values masked), the digest of that
summary and a screenshot. `decide_pip_computer_action` with the expected digest records
`approved` or `rejected`. `always_allow_pip_computer_action {action_id, expected_digest}`
approves it and, in the same transaction, saves an Always-allow grant of kind `computer_submit`
for its Pip, pinned to the method, host and path (`server` = host, `account` = `browser`,
`tool` = `METHOD /path`, `connection_digest` binds the Pip's computer, `schema_digest` the
endpoint); if the grant cannot be saved, nothing is approved. Later, a held request of that Pip
that matches a grant is recorded `approved` at once with `resolved_by` `pip-grant:GRANT_ID`, and
the desktop notifier says so after it is sent. Grants are listed and revoked like app-action grants. The supervisor's next tick then continues or fails the paused
request, and after a send queues one continuation run (actor `local-computer`, request key
`computer-ACTION_ID`) carrying `manifest.computer_continuation`. Status moves one way:
`pending` to `approved`, `rejected`, `expired` or `lost`; `approved` to `sent` or `lost`. Every
other column is immutable. Stopping the computer, a runner restart or a closed browser marks
what it held `lost`; nothing is resent. A computer with nothing held closes after 15 idle minutes.

The live view (`open_pip_computer`, `use_pip_computer_view`, operations `frame`, `click`,
`type`, `key`, `scroll`, `go` and `back`) is served by the supervisor over its own socket.
Its token stays in the controller and is never sent to the editor. While no run is active,
requests the user submits in it are released at once, because the user made them. During a
run the view only watches. All nine computer commands are for the local user only. Screenshots
are JPEG, at most 90 KiB each and 200 per run, under the run's `artifacts/computer`. A live
view frame is taken at JPEG quality 55, and again at 30 if it is over 700 KiB (a busy page).

**The full screen** (API 43, capability `pips_desktop`). When the machine has the desktop programs
(TigerVNC's `Xtigervnc`, `openbox`, `tint2`, `pcmanfm`, `xterm`; `pip_screen.availability()`), a
computer gets a desktop box: `bwrap --unshare-all` with no network, the display on a Unix socket
only (`-rfbunixpath`, `-rfbport -1`, `-nolisten tcp`; GLX off, because a GPU driver can crash it in
the box), the window manager, the wallpaper (`pcmanfm --desktop`) and a dock of three launchers. Files
is bound at `/home/pip/Files`; the rest of home is a tmpfs. The browser then runs headful in its own
box with the desktop's X socket directory bound at `/tmp/.X11-unix`, 1280×724 above the dock, no
startup window and only DGC's page restored; it is still driven over its devtools pipe and gated
the same way. The dock's Browser launcher only writes `browser` to a control FIFO, and the Host
starts or reopens the Pip's own browser; Files and Terminal open `pcmanfm` and `xterm` in the desktop
box. The Pip's own `run` commands stay in the Terminal box, which has no display. With a desktop,
a thread keeps the browser's gate answering between runs.

The editor's viewer reaches the screen through the view socket (op `desktop`, token-checked, the
token never leaves the controller), which splices it to the VNC socket through a filter that frames
every viewer message (RFB) and drops key, pointer and clipboard input while a run is active; input
it passes stamps `user_input_at`. Outside a run, a held submit within `USER_WRITE_SECONDS` (3) of
the user's input is released; any other is recorded as a pending action (with no run) for approval,
and an approved one has no continuation. `get_pip_computer_desktop {pip_id}` (local) returns
`{pip_id, available, reason, install, using, browser, chrome_install, setup}`; `browser` is
`"Google Chrome"` (a real binary at `/opt/google/chrome/chrome`, or the one DGC downloaded),
`"Chromium"` or null. `setup` is DGC's own download of the desktop and Chrome
(`pip_screen_setup`): `{state: none|running|ready|failed|unsupported, step, done, total, error}`,
`done`/`total` in bytes while downloading (packages while unpacking). Reading the status starts the
download when one is due (nothing set up yet, a day since the last check, or an hour after a
failure): a private apt state under `~/.dgc/desktop/ARCH/apt` with the distribution's own sources
and Google's (`signed-by` a key checked against the pinned fingerprint
`EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796`), `apt-get -s install` to learn what the system lacks,
`apt-get download` of what changed, `dpkg-deb -x` (no maintainer scripts) into `v-STAMP/root`, and
an atomic `current` link. The desktop box mounts that root read-only at `/opt/desk`; the browser box
mounts its `usr` there too when it runs the downloaded Chrome.

**A computer's Files and Terminal** (API 43). Beside the browser, a computer has **Files**:
`computers/PIP_ID/home/Files`, which the browser sees as `/home/pip/Files`; its downloads go to
`Files/Downloads` (CDP `Browser.setDownloadBehavior`). The browser's profile beside it is never
listed or read. Every path is walked one name at a time with `O_NOFOLLOW`: no `..`, `.`, empty
or over-long names, at most 8 deep. Links, sockets and devices are not listed and never
followed, so a link made in the Terminal cannot point DGC anywhere. The folder holds 1 GB at
most. The **Terminal** runs one command at a time (a lock file across the runner and
`dgc serve`) in its own `bwrap --unshare-all --clearenv` box: `/usr` read-only, a 256 MiB
`/tmp`, Files as `/home/pip` (also the working directory), no network at all, 60 seconds of
CPU and wall time, output cut at 64 KiB, and a process limit just above the user's current
count. The last 200 commands, yours and the Pip's, are kept in `computers/PIP_ID/terminal.jsonl`.

The Pip's operations: `files {path?}` lists a folder, `open_file {path}` returns a text file
(marked untrusted, like a page) and `run {command}` runs a command and returns its output.
They never wait for the browser, and stop like the rest when a change is waiting for the user.
The user's commands, all local only, and only for a Pip with a computer:
`list_pip_computer_files {pip_id, path?}` returns `{path, entries: [{name, kind: file|folder,
bytes, modified}], more, total_bytes}`; `read_pip_computer_file {pip_id, path}` returns
`{path, name, mime, bytes}` plus `text` and `truncated` (a text file, first 64 KiB), `data` (a
data URI, up to 2 MB: a PNG, JPEG, GIF, WebP or BMP image, or any other file) or
`too_large: true`; `add_pip_computer_file {pip_id, path?, name, data}` saves a data URI of up
to 2 MB as a new file (never overwriting: `name (1).ext`) and returns `{path, name, bytes}`;
`remove_pip_computer_file {pip_id, path}` removes a file or folder (a link itself, never what it
points at); `run_pip_computer_command {pip_id, command}` starts a command and returns
`{running: {by, command, at}}` at once, because Pips controls share one worker in `dgc serve`;
`list_pip_computer_terminal {pip_id}` returns `{entries: [{by: you|pip, command, exit, output,
timed_out, seconds, at}], running}`. `add_pip_computer_file`'s `data` is, with a message's
`images`, the only field outside a Pips request's 16–32 KiB bound; every hop bounds it on its
own (one data URI, 2,800,000 characters).

**From the chat.** A submit held during a chat turn continues in that chat: once it is sent,
the supervisor sends the Pip a turn under the reserved request key `computer_ACTION_ID` (shown
with `intro: true`, like an introduction) asking it to read the page and tell the user what
happened. A held submit from a task run still queues a continuation run. A chat reply may
carry `computer: {calls, held}`, only when its run had the computer.

**Pulse verification plans** give a Pulse Pip a standing command list:

```json
{"schema_version": 1, "action": {"kind": "test", "network": false,
  "tests": [{"argv": ["python3", "-m", "unittest", "discover"], "cwd": "."}]}}
```

One to four commands; each `argv` has 1 to 32 non-empty items of up to 1,024 bytes
(8,192 in total); `cwd` is `.` or a clean relative path. `limits`, if present, must
equal the fixed limits. A plan is at most 12 KiB. It requires committed source and
no event trigger, and can be scheduled. Running it by hand needs the current
`expected_version`, `expected_lifecycle_revision` and `expected_plan_digest`
together. Before each command, DGC checks that the job, plan, lifecycle and binding
are unchanged. A run can succeed while a command fails, and a launch with no
recorded outcome is reported as unknown, never as passed.

## Personal Pips

**Meeting a Pip** (API 43). A Personal Pip can be created with just a character and a name:
`create_pip` with an empty `goal` stores a default goal ("Help with what I ask in this chat. Your
name says what I want you for…") and the Pip's own chat sets it up from there. `pip_type` `core`
is allowed only for Personal Pips: Core is the Primary Pip (default goal: everyday tasks, looking
after the other Pips, checking in), and its runs get Primary-Pip instructions. The type catalog
still marks Core unavailable, so project pickers never offer it.
`introduce_pip {pip_id}` (local only) queues the Pip's first message once, as a conversation turn
DGC writes under the reserved request key `intro_<id>`: it asks the Pip to say hello, guess from
its name what the user wants, and offer the next step. Asking again returns the same run and
message. In `list_pip_messages` that user message carries `intro: true`, and the editor does not
show it as the user's. `send_pip_message` refuses keys that start with `intro_`.

**Images in a chat** (API 43). `send_pip_message` to a Personal Pip takes `images`: up to 4
`data:image/png|jpeg|gif|webp;base64,…` URIs, 2 MB in all, checked like the main chat's (the bytes
must be the type they claim). `text` may then be empty; the message reads "(sent an image)". Each
image is kept once by its SHA-256 under the registry's `chat_images/<pip_id>/` (files 0600), and the
retry key binds the images as well as the text. Listed user messages carry
`images: [{index, mime, bytes}]`, never the bytes; `get_pip_message_image {pip_id, message_id,
index}` returns one as `image` (a data URI), only from that Pip's own chat and only if the kept file
still has its digest. The worker never receives the bytes in its 128 KiB input: the runner hands it
the kept paths, and it re-checks each name and digest before the model sees the image (as image
parts, or described by a vision model for one that cannot see). The images are the only field
that travels outside a Pips request's 16–32 KiB bound: the extension host, `dgc serve`, the
control handler and both SDKs bound them on their own (4 data URIs, 2,800,000 characters in all)
and hold the rest of the message to its usual limit. Registry schema 36 adds the
`pip_chat_images` table.

**Skills** (API 43). A Personal Pip's task and chat runs get the skills `discover_skills` finds
outside any project (user, portable user and plugin skills, and the built-ins `deep-research`,
`dataviz` and `plan`), minus the user's `disabled_skills`. The prompt lists each name and
description (up to 40), and the run gets the main chat's `skill` tool, which returns a skill's
rendered instructions; an unknown or disabled name returns an error. Project Pips get no skills.
A skill grants no tool, access or permission.

**Files in a chat** (API 43). `send_pip_message` also takes `files`: up to 4 `{name, data}`,
`data` a data URI, 2 MB in all and within one 2,800,000-character budget together with any
images. A name has no folders, quotes or control characters. Text and code files (by extension,
with no NUL bytes) and the documents the main chat reads (PDF, Word, Excel, PowerPoint,
OpenDocument, RTF, CSV, TSV) are accepted; a document must start the way its kind does (`%PDF-`,
`{\rtf`, or a ZIP). `text` may then be empty; the message reads "(sent a file)". Each file is kept
once by its SHA-256 under `chat_files/<pip_id>/` (0600), the retry key binds the names and
contents, and listed user messages carry `files: [{index, name, bytes}]`, never the bytes. The
runner hands the worker the kept paths; it re-checks each digest, copies the files under their
names into a private folder and reads them with the main chat's `expand_attachments` (documents
to text, the same per-file and total limits, known credentials redacted), then adds them to the
prompt as untrusted reference data. A Pip with a computer also gets each file in its Files, under
`From chat` (never through a link). Registry schema 37 adds the `pip_chat_files` table.

**App plans** (`app_plan`) name one connection and one to four read calls:

```json
{"schema_version": 3, "server": "composio", "connection_digest": "<64 hex>",
 "calls": [{"tool": "GOOGLECALENDAR_FIND_EVENT", "schema_digest": "<64 hex>",
            "account": "ca_…", "arguments": {"calendar_id": "primary", "max_results": 10},
            "window": {"kind": "calendar_days", "timezone": "Europe/London", "start_day": 0, "days": 7}}]}
```

| Tool | Plan version | Arguments |
| --- | --- | --- |
| `GMAIL_FETCH_EMAILS` | 1+ | `query`, `max_results` (1–20), and optionally `user_id` (must be `me`), `label_ids` (up to 10), `include_payload`, `include_spam_trash`, `verbose`, `ids_only` |
| `GOOGLECALENDAR_FIND_EVENT` | 1+ | `calendar_id` (required), `max_results` (1–20), and optionally `query`, `time_min`, `time_max`, `single_events`, `show_deleted`, `order_by` |
| `GOOGLEDRIVE_FIND_FILE` | 3 | A file-name search: `q` and `pageSize` (1–20); the other fields are fixed. Returns IDs, names, types, edit dates and links only. |
| `NOTION_SEARCH_NOTION_PAGE` | 3 | A page search: `query` and `page_size` (1–20); the rest fixed. Returns IDs, titles, edit dates and links only. |
| `GOOGLECONTACTS_SEARCH_CONTACTS` | 3 | `query` and `page_size` (1–20); `read_mask` fixed to names and emails |

- The connection is any saved, enabled MCP server that connects over HTTPS to
  `composio.dev` and exposes Composio's multi-execute, tool-schema and tool-search
  tools. `connection_digest` hashes the saved server entry; `schema_digest` hashes
  the tool's input schema. Both are checked before any provider call.
- `account` must be a connected-account ID (`ca_…` or `coup_…`), chosen explicitly;
  it is required for Drive, Notion and Contacts and whenever the call goes through
  Composio's multi-execute tool.
- `window` (plan version 2 or 3, calendar only, without `time_min`/`time_max`)
  resolves once per run from midnight in the given zone: `start_day` 0–30, `days`
  1–31. A nonexistent midnight or unknown zone refuses before connecting.
- Limits: plan 8 KiB, arguments 4 KiB per call, accepted results 32 KiB across the
  run, 30-second deadline. No pagination. Account discovery lists at most 64 active
  accounts.
- Before each read DGC rechecks that the run is live, the Pip is active, the job and
  plan are unchanged, Pips are on and the connection is still saved.

**Web plans** (`web_plan`):

```json
{"schema_version": 1, "reads": [{"kind": "page", "url": "https://example.com/hours"},
                                {"kind": "search", "query": "museum opening hours"}]}
```

One to four distinct reads. A page URL is `https`, up to 2,048 characters, with a
host name (no IP address or `localhost`) and no credentials. A search is one line of
up to 300 characters, run through the configured search provider. DGC fetches with
GET only, follows up to five redirects (each must stay `https` and resolve to a public
address), accepts text, JSON and XML up to
1 MB, and keeps 8,000 characters per read. All reads share 90 seconds. A failed read
is reported with a short error.

**Personal handoffs** share an exact excerpt (up to 12,000 bytes) of a completed
Personal task result with a different Personal Pip, with a task of up to 4,000
bytes. The target keeps its own app and web plans; no history, tools or grants are
passed on. Personal Pips can't hand off to project Pips.

## Limits and sizes

| Item | Limit |
| --- | --- |
| Concurrent runs per runner | 1 |
| Queued, running and cancelling runs | 20 |
| Run wall time | 300 seconds, including commands |
| Model turns per run | 12 |
| Tool calls per run | 64 |
| Output tokens per model response | 4,096 |
| Worker input | 128 KiB |
| Source copy | 10,000 entries, 4 MiB per file, 64 MiB total |
| Commands per action | 4 (Pulse 1–4, Patch 0–4) |
| Write paths per Patch action | 32 |
| Action JSON | 16 KiB |
| Per command | 60 s wall, 30 s CPU, 512 MiB address space, 32 processes, 64 KiB output (macOS: memory across all processes and the process count are sampled) |
| Command scratch space | 64 MiB (sampled on macOS) |
| Patch diff | 256 KiB |
| Execution result | 64 KiB |
| Audit report | 32,000 bytes, 16 findings, 12 limitations |
| Quill draft | 24 KiB Markdown, 16 citations |
| Chat message / reply | 8 KiB / 24 KiB |
| Job definition | 16 KiB |
| Handoff tool request | 24 KiB |
| Control request | 16 KiB; 32 KiB for handoff and external-action proposals and draft preparation |
| Control response | 128 KiB |
| Activity page | 50 events, 96 KiB |
| Run evidence export | 4 MiB, 2,000 records, 30 seconds (Linux) |
| Markdown export | 128 KiB |
| Runner heartbeat | Every 2 seconds; offline after 15 seconds |

## Main-chat tools

The main chat carries one small tool, `use_pips`, instead of the Pips tools on every
request. Calling it loads the other twelve tools below and their guidance for the
rest of the chat. A message that references a Pip with `@`, or a setup-approval
notice, loads them automatically. A new or resumed chat starts without them.

| Tool | Permission | Default mode | Does |
| --- | --- | --- | --- |
| `use_pips` | `UsePips` | Allowed | Loads the Pips tools |
| `pips_context` | `PipsContext` | Allowed | Reads Pips data (below) |
| `pips_setup` | `PipsSetup` | Asks (allowed without asking when it saves a card) | Creates or updates a Pip; one with app reads or Pulse commands is saved as a setup card instead |
| `pips_propose` | `PipsPropose` | Asks | Applies a change to a project Pip's name, goal or source ref |
| `pips_adapt` | `PipsAdapt` | Asks | Applies a name or source-ref change that the Pip's adaptation policy allows |
| `run_pip_now` | `PipsRun` | Asks | Queues one run of a Scout, Lens, Rook, Lock or Quill Pip, or a Personal Pip |
| `handoff_to_pip` | `PipsHandoff` | Asks | Saves a handoff proposal |
| `draft_pip_email` | `PipsEmailDraft` | Asks | Saves an email draft from a Personal result |
| `draft_pip_calendar_event` | `PipsCalendarDraft` | Asks | Saves a calendar draft from a Personal result |
| `draft_pip_connector_action` | `PipsConnectorDraft` | Asks | Saves a connector-call draft from a Personal result |
| `pause_pip` | `PipsPause` | Asks | Pauses a Pip's background work |
| `resume_pip` | `PipsResume` | Asks | Resumes a paused Pip (needs a live runner) |
| `attach_pip_to_session` | `PipsAttach` | Asks | Adds a Pip reference to this chat's prompt |

- Plan mode allows only `use_pips` and `pips_context`. Auto mode allows the rest.
  Explicit rules apply in every mode, and a deny rule always wins.
- `deny: UsePips` keeps the tools out of the main chat entirely: the model cannot load
  them, and an `@` reference or a setup notice does not load them either.
- Sub-agents and monitor wake-up turns can load and use `pips_context` only.
- With Pips off, or in a session with an SDK runtime policy or sandbox, none of
  these tools are offered.
- `run_pip_now` needs a live runner and the Pip's current version, and never starts
  the runner. It is a queue receipt, not a result.
- `pause_pip`, `resume_pip` and `attach_pip_to_session` need the current version and
  lifecycle revision. A chat can attach up to 16 Pips; attachments appear in the
  prompt as untrusted references, and there is no detach.
- Setup cards can't create Patch Pips or add event triggers. The drafting tools need
  `scope: "personal"` and a completed Personal result or reply as their source.

`pips_context` actions: `list`, `definition`, `report`, `execution` and `draft` read
Pips and runs (`list`, `definition` and `report` accept `scope: "personal"`);
`context`, `attachments`, `memory`, `statements` and `activity` read workspace
records; `connections`, `connection` and `connector_tools` read connection metadata
and tool schemas, never app data. Output is capped at 24 KiB per call.

`@` references (editor only) carry one to eight Pips from the chat's project
workspace, each pinned to its version and lifecycle revision. The model receives
only their IDs, names, types, status and versions, as untrusted reference data.
A reference starts and approves nothing.

## CLI commands

`dgc pips COMMAND --help` shows each command's options. `--json` gives structured
output. Commands that act on a workspace take `--workspace ID` or `--personal`;
the default is the current folder. Plain `dgc pips` lists the current workspace's
Pips. In the chat, `/pips …` runs the same commands, except `serve`, `capacity`,
`export-run` and service changes, which need a separate terminal; bare `/pips`
shows the digest. The full-screen view asks no questions, so commands that would
ask need `--yes` there.

| Area | Commands |
| --- | --- |
| Runner | `enable`, `serve [--enable]`, `status`, `stop [--yes]`, `resume`, `execution` |
| Linux service | `service preview\|install\|status\|start\|stop\|enable\|disable\|uninstall` |
| Workspaces | `workspaces`, `workspace show\|sessions\|backfill\|rebind\|migrate-session`, `activity` |
| Pips | `types`, `models`, `list`, `create`, `show`, `pause`, `resume-job`, `archive`, `restore`, `starters`, `starter` |
| Digest | `digest [--keep]`, `notify PIP [--min-severity] [--alerts]`, `outcomes PIP` |
| Setup cards | `setup list\|show\|accept\|reject` |
| Changes | `propose`, `schedule`, `trigger`, `verification-plan`, `adaptation`, `adaptations`, `accept`, `reject`, `approvals`, `versions` |
| Runs | `run`, `runs`, `report`, `cancel`, `checkpoints`, `review-finding`, `review-execution`, `export-run` |
| Conversations | `messages`, `send` |
| Handoffs | `handoff propose\|propose-artifact\|propose-personal\|review\|accept\|reject\|list` |
| Context and memory | `context list\|record\|archive\|accept-finding\|accept-execution`, `memory source\|record\|revoke\|list`, `memory statements anchor\|record\|revoke\|list` |
| Sessions | `session-outcome inspect\|propose\|review\|list\|accept\|reject`, `session-execution list\|show\|record` |
| Notifications | `notifications list\|read` |
| Personal apps | `connections`, `accounts SERVER`, `inspect-connection SERVER` |
| Drafts and actions | `email-draft`, `calendar-draft`, `connector-draft` (`list\|show\|prepare\|dismiss`), `app-action inspect\|propose\|show\|list\|accept\|reject` |
| Capacity | `capacity` |

`stop`, `setup accept`, `handoff accept` and `app-action accept` ask for
confirmation, and the last three show the saved record first. Without a terminal
they need `--yes`. Errors exit with status 1, argument errors with status 2. Known
credentials and terminal control sequences are removed from output.

## Editor and SDK

- The editor talks to Pips through `pips_control`, `pips_enable` and `pips_runtime`;
  see [PIPS_EDITOR_PROTOCOL.md](PIPS_EDITOR_PROTOCOL.md).
- The SDK exposes the same controls as `session.pips`; see
  [sdk/PIPS.md](../sdk/PIPS.md).

## Pips API history

The backend advertises `pips_api_version` in `ready.capabilities` and `pips_status`.
Clients check it before using a newer control.

| API | Added |
| --- | --- |
| 8 and earlier | Reviewed interval and daily schedules, the character catalog, per-Pip conversations and model choice, cron and one-time schedules, audit checkpoints and finding reviews, finding handoffs with Patch and Pulse execution, and Patch-to-Pulse artifact handoffs. 8 is the oldest version the SDK accepts. |
| 9 | Accepted Patch and Pulse outcomes in workspace context; Quill drafts |
| 10 | Workspace overviews, pending reviews, recent activity, proposal reads; event triggers; adaptation policies |
| 11 | Reviewed current-tree source |
| 12 | Session statements |
| 13 | Notifications |
| 14 | Pip exceptions |
| 15 | Patch specialists |
| 16 | Archive and restore; lifecycle revisions |
| 17 | Configured-verifier command receipts |
| 18 | The `session_turn_completed` trigger |
| 19 | Claims and preferences |
| 20 | Schedules and triggers for Quill |
| 21 | Standing Pulse verification plans |
| 22 | Committed-path triggers |
| 23 | Setup cards from the main chat |
| 24 | Per-reply context and reasoning options |
| 25 | Model choice on setup cards; reply context above 32,768 |
| 26 | Conversation continuity summaries |
| 27 | Pulse setup cards; local HTTP checks |
| 28 | Personal Pips; app connections and Gmail and Calendar reads |
| 29 | Connected-account selection |
| 30 | Personal result handoffs |
| 31 | Reviewed Gmail sends |
| 32 | Email drafts |
| 33 | Calendar-day windows |
| 34 | Reviewed calendar events |
| 35 | Calendar drafts |
| 36 | Reviewed connector calls (Zapier, Arcade, Make, n8n) |
| 37 | Connector drafts |
| 38 | Calendar guests, invitations and finite series |
| 39 | Drive, Notion and Contacts reads |
| 40 | Reviewed web reads |
| 41 | Starter Pips; setup cards that run after each new commit; the digest, notification settings and finding outcomes; reviewed GitHub reads (`github_plan`) |
| 42 | Pip computers (`computer_plan`): `get_pip_computer`, `list_pip_computer_actions`, `decide_pip_computer_action`, `always_allow_pip_computer_action`, `get_pip_computer_frame`, `list_pip_computer_frames`, `stop_pip_computer`, `open_pip_computer`, `use_pip_computer_view` |
| 43 | Simple Pips: `introduce_pip`; a Personal Pip with only a name; Core as the Primary Pip; `intro` on chat messages; images and files in a Personal Pip's chat (`send_pip_message` `images` and `files`, `get_pip_message_image`); a computer's Files and Terminal (`list_pip_computer_files`, `read_pip_computer_file`, `add_pip_computer_file`, `remove_pip_computer_file`, `run_pip_computer_command`, `list_pip_computer_terminal`), and the computer in a Pip's chat |
