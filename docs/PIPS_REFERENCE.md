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
mode, an allow rule or the user's Allow), recorded as `chat-permission:<mode>`.
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
`auto`, `ollama`, `anthropic`, `chat_completions` or `responses`. A run pins its model and
endpoint when it is queued; if the endpoint or API mode changes before it starts, it fails
with `model_changed`. Rotating the key for the same endpoint is fine.

A Personal Pip may instead run on the user's own Claude Code or Codex (Pips API 55,
`dgc/pip_brain.py`): `model_choice` `{"mode": "subscription", "engine": "claude" |
"codex"}`, or `{"mode": "default"}` when DGC's `subscription_engine` is one of them (then
with DGC's `subscription_model` and `subscription_effort`; an explicit pick uses the CLI's
own default model). The run pins `model_settings.brain` `{engine, model, effort}` and
`model` (the engine, then `:model` when DGC chose one), and no endpoint. At its start the
CLI must still be installed and signed in (the CLI's own login marker, by existence only,
under `CLAUDE_CONFIG_DIR` or `CODEX_HOME` when set), or the run fails with `model_changed`
and the reason. The controller hands the worker `DGC_PIP_BRAIN`: the CLI's path, the
user's home, an environment of paths, locale and proxies only (no key or token, and the
worker gets no `api_key`), and the run's own folder `runs/<run>/brain` (0700), where the
CLI runs and which is emptied when its turn ends. The worker serves the run's Pip tools as
MCP on a private socket (`pip_computer.socket_dir()`, 0600) that only the run's token opens;
the CLI reaches it through `dgc/pip_brain_relay.py` (`python -I`). Each call is answered by
the worker's own handlers, one at a time, in the order the CLI's stream reports them, and a
screenshot comes back as MCP image content. `offer_choices` and the eyes card end the turn
by stopping the CLI. The Pip's instructions replace the CLI's own system prompt: Claude Code
gets them as `--system-prompt-file`, Codex as `model_instructions_file`; the conversation so
far arrives as text with the turn on stdin, and the user's photos as image input. A CLI
that reports a tool of its own is stopped, and the turn fails with one plain line. DGC
sends no model request of its own in such a run; a chat brief uses its mechanical form.
The engines and flags are in [PIPS.md](PIPS.md#your-own-claude-code-or-codex-personal-pips).
Kimi Code, Qwen Code and Copilot CLI are refused for Pips with one line each. Project Pips
refuse a subscription (`unsupported_model`: "Project Pips need a local or API model: their
source checks run only in DGC's own loop. Personal Pips can use your subscription."), at
creation for an explicit pick and at queue time when "Same as DGC" follows one.

`list_pip_models` (API 55) adds `subscriptions` `[{engine, name}]`, the CLIs a Personal Pip
can run on here, and, when DGC's default is a subscription, `default_engine` `{engine,
name, available, reason?}`; `default_model` is then `""`.

### Source

| Source policy | Used by | What the Pip reads |
| --- | --- | --- |
| `{"mode": "committed_only", "exclusions": "safe_source_v2"}` (default for new Scout, Lens, Rook, Lock and Quill Pips, API 50) | Reviewers and Quill | The committed tree at `source_ref`, minus what the source rules, the commit's `.dgcignore` files and the Pip's Excluded folders leave out |
| `{"mode": "committed_only"}` | Every project Pip before API 50; Patch and Pulse | The exact committed tree at `source_ref`, resolved to a commit when the run is queued (the original rules, `safe_source_v1`) |
| `{"mode": "current_tree", "exclusions": "safe_source_v2"}` | Scout, Lens, Rook, Lock, Quill; manual runs only | A checked copy of the project folder as it is now, taken when the run is queued, under the current rules |
| `{"mode": "current_tree", "exclusions": "safe_source_v1"}` | The same | The same copy under the original rules |
| `{"mode": "personal"}` | Personal Pips | Nothing: an empty source folder |

A `safe_source_v2` policy may add `"exclude": [...]`: the Pip's **Excluded folders**, 1 to 32 patterns in the
`.gitignore` format (`uploads/`, `docs/screenshots/`, `*.mp4`; at most 200 characters each, no leading `!` or `#`,
no `..` and no backslashes; listed once each, omitted when empty).

**The two rule sets.** `safe_source_v1` (the original) refuses the whole copy when it meets a file it can't copy: one
file over 4 MiB, a symbolic link or submodule (committed), a hard link or special file (current files), or more than
64 MiB or 10,000 entries in all. `safe_source_v2` leaves such files out instead and lists them, copies up to 256 MiB
and 10,000 files and folders, and doesn't count what a rule left out toward that (it looks through at most 100,000
entries). What still doesn't fit fails with `snapshot_limit` and a message that gives the size, the limit, the five
biggest folders (named as narrowly as is useful: `docs/screenshots`, not `docs`) and how much to leave out, and says
to use `.dgcignore` or the Pip's Excluded folders. The original rules' failure names the big files and says how to
switch. A repeated directory (a filesystem loop) still fails under both.

**What safe_source_v2 leaves out, and how it decides.** Ignore rules are matched by DGC itself in Python, the way Git
matches `.gitignore` (anchoring, trailing `/` for folders only, `*`, `?`, `[...]`, `**`, the last matching line
wins and a deeper file's lines come later). They only ever leave things out. A `!` line brings back only what an
earlier line of the same family left out: the `.gitignore` family (`.git/info/exclude` and every `.gitignore`), or
the `.dgcignore` family. It never brings back what DGC's fixed rules, the other family or the Pip's list leave out,
so `!.env` changes nothing. An ignore file over 256 KiB (2 MiB and 2,000 files in all) stops the copy rather than
being skipped; a symbolically linked one isn't read, as Git doesn't.

- **Committed source** reads the `.dgcignore` files in the commit (not uncommitted ones) and the Pip's list. The
  project's `.gitignore` doesn't apply: Git ignores it for files you committed, and so does DGC. No fixed exclusions
  apply, so a committed `.env` file is readable, as before. Skipped and listed: files over 4 MiB, symbolic links,
  submodules, other non-file entries and unsafe paths.
- **Current files** add the fixed exclusions below, the project's `.gitignore` files and `.git/info/exclude` (when
  `.git` is a folder). Skipped and listed: files over 4 MiB, symbolic links (never followed), hard-linked files,
  FIFOs, sockets and devices, other filesystems, folders deeper than 32, names DGC can't copy safely (control
  characters, `\`, `:`, invalid UTF-8, paths over 1 KiB) and files that contain a configured secret.

**What the Pip and the user are told.** A `safe_source_v2` copy keeps a bounded record (at most 6 KiB) of what it
skipped (path, reason and size) and what each rule left out (the folder or file and which rule; committed source
also counts the files and bytes under each excluded folder). What DGC's fixed rules leave out is counted, never
named. The record is pinned with a current-file run (`source_left_out` in its manifest), saved with every run as the
`pip_run_source_left_out` activity event, given to the worker, which tells the Pip that these paths exist, are not in
its copy and must not be reported as missing, and returned by `get_pip_run_source {run_id}` (API 50, local only):
`{run_id, rules, status, left_out}`, with `status` `recorded`, `not_copied_yet` (a committed copy is made when the
run starts), `not_copied` (it ended first), `original_rules`, `no_source` or `unavailable` (the event was trimmed).
`safe_source_v2` current-file receipts are `schema_version: 2` and add `skipped_files`.

**Checked up front.** `check_pip_source {pip_id, source_policy?}` (API 50, local only) uses the selection a run uses,
without copying, for the saved policy or an unsaved one: `{pip_id, check: {applies, fits, mode, rules, revision,
files, bytes, limits, left_out, biggest_folders, message}}`. The main chat's `pips_setup` result carries the same
check as `source_check`, and `run_pip_now` refuses a committed source that can't fit (nothing is queued) with the
message above. `dgc pips source PIP` prints it.

**Changing the rules.** A move to `safe_source_v2`, and any change of Excluded folders, is a job proposal reviewed like
any source change: the Pip page's Source **Save** (your own change), `dgc pips propose --source-rules v2 --exclude …`
then `dgc pips accept`, a setup card with `source_exclude`, or the main chat's `pips_propose` with `source_exclude`,
which the tool's permission approves as it does a new goal. The chat can't change where the source comes from
(committed or current files) and can't move a Pip back to the original rules. Checkpoints of any policy but
`{"mode": "committed_only"}` are version 2 and record the policy, so the first report after a change of rules or
Excluded folders is `source_policy_changed` and isn't compared; a new committed Pip's first report counts every
finding as new, as version 1 does.

**Committed source.** The workspace must be the repository root. DGC reads exact
blobs with `git ls-tree` and `git cat-file`, so checkout filters, hooks and LFS don't
apply and dirty or untracked files are excluded. `source_ref` is `HEAD`, a branch or a
full commit ID.

**Current tree.** The copy follows no links, never crosses into other mount points and is checked again after copying,
before the worker starts, inside the worker, and after it finishes. Under `safe_source_v1` it refuses hard links,
special files, nesting deeper than 32 and any file that contains a configured secret. Both rule sets leave out:

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
app, and the app may not be running the committed source recorded with the run. A plan
of local HTTP checks only runs no project code, so it needs no sandbox at all: it is
accepted, scheduled and run where bubblewrap can't start (stock Ubuntu 24.04), uses the
interpreter DGC itself runs on, and copies no source (its receipt's snapshot is 0 files,
0 bytes). Any other command, and every Patch, still requires the confinement probe.

**Specialists.** A Patch action may add
`"specialists": {"roles": ["explorer", "critic", "worker"], "max_calls": 1–3}`.
Specialists are synchronous child agents inside that one run: Explorer and Critic
read only; Worker has the parent's exact `write_paths`. They share the parent's
budget (12 model requests, 64 tool calls, 300 seconds) and can't run commands, use
the network or start further children.

### Live-data commands

A live-data Pip (API 60, `dgc/pip_live_data.py`) is a project Pulse whose job has a `live_plan` instead of a
verification plan: `{"schema_version": 1, "commands": [...]}`, one to six distinct command lines of up to 1,000
characters, each on one line. It is set and changed only by a reviewed job change (`changes.live_plan`, `null`
removes it) or a setup card (`work_kind` `live_data`); a model proposal or an adaptation can't change it, and an
adaptation carries it over. A Pulse has a verification plan or a live plan, not both, and runs on a schedule or when
asked, never on events.

- **Only the approved lines run.** Before each run the controller checks the job is still active at the queued
  version with the same lines (else `stale_grant`, and nothing more runs); each line runs once, in order. A line that
  isn't exactly one of the approved ones is refused and never reaches the box. A failed line doesn't stop the others.
- **The safety net.** `refusal(line)` turns a line down when it is approved (`write_command`, with the reason) and
  again before it runs: a redirection into a file (`>`, `>>`, `&>`, `<>`; `2>/dev/null` and `2>&1` are fine), `&`,
  a subshell, a here-document, `$(...)`, backticks or process substitution; programs that write (`rm`, `mv`, `cp`,
  `tee`, `dd`, `touch`, `chmod`, `kill`, archive tools, ...), `sudo` and friends, `eval`, `xargs`, `bash -c`;
  `sed -i`, `sort -o`, `find -delete`/`-exec`, `tar` other than `-t`; `git`, `docker`, `kubectl`, `systemctl` and
  package managers with a write subcommand; `curl` with a method other than GET/HEAD/OPTIONS, a body, a form, an
  upload or an output file, `wget` without `-O-`; Redis write commands; psql meta-commands and sqlite3
  dot-commands that write, run commands or open another file; SQL statements that change data (`INSERT INTO`,
  `UPDATE ... SET`, `DELETE FROM`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `MERGE`, `COPY ... FROM`,
  `SELECT ... INTO`, `PRAGMA x =`, `nextval()` and others); a URL off this computer, a loopback URL without a port,
  or a port below 1024; a password or key in the line (`secret_detected`). It is a net for obvious writes; the
  approved list is the guarantee, and a read-only database account is what keeps SQL read-only.
- **The box.** Each line runs as `/bin/bash -o pipefail -c LINE` in a Troupe checker's bubblewrap box
  (`checker_box`): every namespace unshared, capabilities dropped, the host read only, homes, `/root`, `/tmp` and
  `/run` replaced by empty ones, the project mounted read only at `/mnt` and at its own path with its credential files
  hidden, a private writable `/tmp`, and the working folder `/mnt`. Its network is its own loopback, where one
  forwarder per port relays to `127.0.0.1:PORT` on the host for each port the approved lines name
  (`localhost:PORT`, `127.0.0.1:PORT`, at most eight), and the project's read-only database
  (`dgc readonly-db set`) is reached as `$DGC_READONLY_DATABASE_URL`. The environment is the sandbox's small one
  (`PATH`, `LANG`, `TZ`, `HOME=/tmp/dgc-home`). Linux with working bubblewrap, or macOS (below); elsewhere
  `run_pip` and the schedule refuse it with `execution_unavailable` and the reason, and its status says so.
- **The box on macOS.** `/usr/bin/sandbox-exec` with a profile built per line (`checker_box._seatbelt_wrap`), run in
  the project's real path: `(allow default)`, then every write denied but a private folder made 0700 for the line
  (`HOME` and `TMPDIR` inside it; all of a run's are removed after it); reads denied for the user's homes, DGC's
  state, `/Users`, `/private/var/root`, `/private/tmp`, `/private/var/tmp`, `/private/var/folders` and
  `/private/var/run`, then the project and that folder re-allowed (with path-ancestor metadata, so a project in a
  hidden home is reachable), then the project's credential files and folders denied at their path and where a link
  points; `(deny network*)`, then outbound TCP to `localhost:PORT` (127.0.0.1 and ::1) for each port the lines name
  and the read-only database's, which `$DGC_READONLY_DATABASE_URL` names directly (no relay); Unix sockets denied;
  `(deny mach-lookup)`, then only the base services Apple's `system.sb` allows every sandboxed process (no Keychain,
  pasteboard, Apple Events, Launch Services or Spotlight); `(deny job-creation)`; signals and process information
  only for its own sandbox, and no `kern.procargs`. `PATH` gains the selected developer tools' `usr/bin` before
  `/usr/bin` (the `python3` and `git` shims can't use their cache in the box) and Homebrew's folders after it. The
  runner's process sampler (as for Patch and Pulse, with its 512 MB and 32-process limits, `resource_limit`) stops
  whatever a line leaves running. Weaker than Linux, as the Pip's card says: no PID namespace (`ps` and `pgrep`
  fail, but a line can still read other programs' names through `sysctl`), Seatbelt's `localhost` is any of the
  Mac's own addresses (the named ports only), stopping is by sampling, `/tmp` is closed (macOS bash 3.2 writes here-documents there, so `<<<`
  fails), and Apple marks `sandbox-exec` as deprecated. A Troupe checker's shell uses the same box, its commands
  stopped by their process group.
- **Limits.** 60 seconds and 64 KiB of output a line (`timed_out`, `output_limit`); 4 KiB of each output is kept,
  redacted for configured credentials. Statuses: `ok`, `failed`, `timed_out`, `output_limit`, `cancelled`,
  `refused`, `not_run`.
- **The summary.** The worker makes one tool-free request (up to 1,024 output tokens, 240 seconds) with the job's
  goal and each line's status, exit code and output as untrusted data, for `{"summary": "...", "attention": bool}`.
  Every number in the summary must appear in an output, the goal or a command line (counts up to the number of lines
  are DGC's own); otherwise, or when the reply isn't that object, it is asked once more, then left out, and the
  run's summary is DGC's own sentence ("All 3 commands ran and printed their output.", "2 of 3 commands ran. Not
  finished: ..."). The controller checks the numbers again before saving. A model error never fails the run.
  `attention` is the model's verdict, or true whenever a line didn't finish.
- **The result.** `result.live` is `{schema_version, commands: [{index, command, status, exit_code, output,
  output_truncated, seconds, note?}], summary, summary_by ("model" | "dgc"), attention, notes, verification}`, with
  `result.snapshot` `{files: 0, bytes: 0, scope: "live"}` (no source is copied) and the event `pip_run_live_reads`
  (each line's status and exit code). `pips_context` `report` reads it; `dgc pips report RUN` prints it.
- **Its chat.** A conversation run of a live-data Pip carries `live_plan` as reference, and `last_report` is the
  latest run (`classification` `live_data`: the summary and each line's output, at most 1,200 characters each, 8 KiB
  in all). It can't run the lines, or anything else, from its chat.

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
| `connector_call` on `app:<name>` (API 61; decided in the app too from API 62) | One change tool of your own app (see Your own app's tools, under Personal Pips) | Exact tool and arguments, checked against its schema when proposed and again before it runs; one signed POST with `action_id` and `action_digest`, 30 seconds; JSON answer up to 256 KB, kept as a digest and 1 KiB preview; a tool marked `moves_money` never gets Always allow and asks at every level | The app answered `ok` (`The app answered that it did this.`). Its own refusal, or no answer, is `unknown` with its words in the receipt (`The shop app said: …. DGC will not retry this action.`) |

A connector call can invoke any tool the connector exposes; DGC doesn't filter by
what a tool does. A workflow may keep running after DGC's deadline. A Pip itself
can't book, buy, pay, reserve or sign up for anything, and is told to gather the
details and say what you need to do instead.

## Review and approval

Every review is a saved, immutable record. Accepting it rechecks a pin, so a stale
decision never applies to a newer state.

| Review | Created by | Pinned by | Expires |
| --- | --- | --- | --- |
| Job proposal | A person, the main chat (`pips_propose`: name, goal, source ref and Excluded folders only), or a Pip's own chat (`draft_pip_change`, Personal) | `expected_version` | 7 days |
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
seconds, fires due schedules and triggers, and executes queued runs under the
`pips-runner` lease: up to `pips_parallel_runs` at once (default 4, at most 32), never two
of one Pip together (`claim_next` takes the oldest queued run of a Pip with none running). Only one supervisor can run per state folder. A
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
  `TimeoutStopSec=90` and `Restart=on-failure` (after 30 seconds). `serve --service`
  exits 0 when Pips are off, stopped or already running, so an emergency stop never
  turns into a restart loop.
- `install` writes the unit (0600) and reloads systemd but doesn't start or enable
  it. `start`, `stop`, `enable` (start at login) and `disable` are separate.
  `uninstall` needs the service stopped. DGC changes only a unit whose bytes match
  what it generated, and never configures lingering.
- The DGC home's `.dgc` folder, `config.json` and `secrets.json` must be owner-only.

### Pips on a server

A developer runs their app and the runner on a server with no VS Code and no desktop. The
app's SDK starts its own `dgc serve` with `inherit_user_state=True`, so the app and the
runner share one machine (or container) and one DGC home; there is no remote control
plane. Everything here is the CLI's: no command or Pips API version is added.

**Server mode.** `dgc pips serve --server` is the foreground supervisor with a server
profile:

- No desktop notifications, and no borrowing a signed-in Chrome: a chat reply isn't offered
  `borrow_chrome`, and nothing looks for a Chrome. Pip computers stay where their bubblewrap
  box runs headless; where it doesn't, the runner's first lines say why (in a container:
  the container's options), and so does each Pip computer.
- One plain line per event on stdout, for `docker logs` and journald:
  `<UTC time> <event>[ pip=…][ run=…][ by=…][: detail]`. It starts with `runner_started`
  and `pip_computers`, ends with `runner_stopped` (`reason=emergency_stop` after one),
  and has each event of the activity feed in between, except a run's progress steps. A
  failed or cancelled run's line carries its error's code and words. When the runner
  can't start, its one line is `runner_not_started reason=<code>: <why>` (`disabled`,
  `runtime_paused` or `runner_running`) and it exits with status 1, or 0 under
  `--service`.
- **The guardrail.** Pips run on an API key or a self-hosted model only. A run whose pinned
  model is the user's Claude Code or Codex plan (chosen for the Pip, or followed through
  "Same as DGC") is refused before anything starts: it fails with `server_subscription`
  and words that say why and how to change it (`dgc pips propose PIP --expected-version N
  --model MODEL`, or DGC's own model for a Pip that follows it). The Pip's model is never
  switched by itself.
- The supervisor record says `mode: server`, so `dgc pips health` reports `server_mode`, and
  accepting a schedule or routine through the SDK doesn't try to turn on Keep Pips running
  while a server runner is online. Without systemd (a container), Keep Pips running says
  it's unavailable here and writes no unit.

**systemd.** `dgc pips service install --server` writes this home's unit (the same
`dgc-pips-<24 hex digits>.service`) running `pips serve --service --server`, replacing
the desktop one if that was installed; `preview --server` shows it first. `install`
without `--server`, and Keep Pips running, keep whichever kind is installed. `start`,
`stop`, `enable`, `disable` and `uninstall` work on either, and `status` says which
(`server`). Its lines are in the journal: `journalctl --user -u <unit>`.

**Docker.** [deploy/docker](../deploy/docker/README.md) has the image recipe: Debian slim
with Python 3.12, DGC from its release archive (`install.sh`, version pinned by
`--build-arg DGC_VERSION`), the Python SDK, bubblewrap, `/data` as the DGC home on a
volume, `dgc pips serve --server` as its command and `dgc pips health` as its
`HEALTHCHECK`. Your app runs in the image beside the runner (`with-pips`, a small
supervisor), or in a second container on the same volume and user. A second runner on a
home that has one is refused by the supervisor lease (`runner_running`), across containers
too.

**Health.** `dgc pips health` exits 0 when the runner is online and running and holds its
lease; otherwise 1, with one line: `dgc pips health: unhealthy: <why>`. `--json` gives
`{healthy, state, message, status, online, paused, heartbeat_at, heartbeat_age_seconds,
started_at, server_mode, counts, lease_held}` (fewer when there is no state to read).

| `state` | When |
| --- | --- |
| `running` | Healthy: a fresh heartbeat and the lease held. |
| `off` | `pips_enabled` is off in this home's settings. |
| `stopped` | The emergency stop is on. |
| `no_runner` | No registry or no runner record yet, the last runner stopped, or a fresh heartbeat with no lease held (it stopped a moment ago). |
| `heartbeat_stale` | The heartbeat is older than 15 seconds, unreadable or in the future. |
| `state_unreadable` | The registry, a runner record or the lease can't be read. |

It only reads: the registry is opened read-only (`mode=ro`, never created, upgraded or
written, whichever DGC version made it), and the lease is looked at only while a fresh
heartbeat says a runner already holds it, so a probe never meets a runner that is
starting. A chat's shell may run it. Safe every 10 seconds.

**Secrets.** On a server they live in the DGC home: the model's key in DGC's secret store
(`.dgc/secrets.json`, 0600, saved with `dgc setup`), or `DGC_API_KEY` in the runner's and
the app's environment (the systemd unit passes no environment, so there use DGC's own
settings); your app's signing secret in DGC's credential store
(`.dgc/plugin-auth/_pipapp.<name>/credentials.json`, 0600, where there is no system
keychain). In the Docker image the home is the `/data` volume, owned by its one user.

**Platforms.** Queueing and running work needs a POSIX system, so Windows can't run
Pips work. Audits, Quill drafts, conversations and Personal tasks run on Linux and
macOS. Patch and Pulse commands need Linux with bubblewrap, or macOS with
Seatbelt and Xcode or the Command Line Tools, with weaker guarantees (see **macOS**
under Patch and Pulse commands). Live-data commands need Linux with bubblewrap, or
macOS with Seatbelt (see **The box on macOS** under Live-data commands). Current-tree source needs POSIX directory handles.
`export-run` and `capacity` need Linux `/proc` or macOS (which names the pinned registry folder's
path itself). The service needs Linux with user systemd.

## Run kinds

| `run_kind` | Pips | Started by | Model tools |
| --- | --- | --- | --- |
| `audit` | Scout, Lens, Rook, Lock | Manual, schedule, event, main chat, read-only handoff | `read_file`, `glob`, `grep`, `repo_map`, `todo` |
| `draft` | Quill | Manual, schedule, event, main chat | The same read tools |
| `conversation` | Any | A chat message | Project: the same read tools. Personal: the five drafting tools only. |
| `patch` | Patch | An accepted handoff | Read tools plus the four write tools on reviewed paths; `task` only with a specialists grant |
| `test` | Pulse | An accepted handoff, or a standing verification plan (manual or scheduled) | Read tools (handoff); none, and no model (plan) |
| `live` | Pulse with a `live_plan` (API 60) | Manual, schedule, main chat (`run_pip_now`), a setup card's first run | None: the controller runs the approved lines, then one tool-free request for the summary |
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
8 KiB, which you can inspect. The Pip's options: `context_size` 2,048 to 1,048,576
and `thinking` `off`, `low`, `medium`, `high` or `xhigh`, kept per Pip in registry
metadata (`pip_chat_options:<pip>`) by `set_pip_chat_options {pip_id, chat_options}` (API 47,
local only) or by a message sent with them, and applied to every run of that Pip
(scheduled, routine, trigger and handoff runs too). Without any, a run uses DGC's
`context_size` and thinking off. Every run requests DGC's `max_tokens` per response and
has no step or time limit (`max_turns` 0, `turn_budget_s` 0; the manifest's `limits` are 0,
meaning none), except a Patch with reviewed specialists, whose bounds stay as reviewed.

**Runs in the Pip's own chat (API 51).** When an `audit`, a Pulse plan's `test`, a `draft` or a
`personal_task` run succeeds or fails, `PipStore.finish` (and `recover`, for a run the runner lost)
writes one row in `pip_run_posts`, keyed by the run, in the same transaction: once per run, whether
or not an editor is open. The table is created on first use, so the registry schema stays 46.
Conversation replies, Patch work, a handoff's test run and cancelled runs post nothing. A post is
the Work chat card's report (`pip_report_delivery` builds both) plus:

| Field | Meaning |
| --- | --- |
| `kind` | `audit`, `checks`, `draft`, `result` (a Personal Pip's task) or `live` (a live-data Pip, API 60) |
| `outcome` | `findings`, `clear`, `failed`, `checks_failed`, `checks_passed`, `draft`, `result`, `live_clear` or `live_attention` |
| `trigger` | `schedule`, `event`, `you`, `chat` (the main chat ran it) or `handoff` |
| `total`, `counts`, `findings` | A review's findings: how many, by severity, the top three (`title`, `severity`, `path`, `line`) |
| `checks`, `failed_checks` | Pulse: `{passed, failed, total}` and up to three failed checks |
| `reason`, `detail` | A failure in plain words, and the saved message |
| `next_run_at` | A failed run of an active, scheduled Pip: when it runs next |
| `title`, `summary` | A Quill draft |
| `summary`, `summary_by`, `commands`, `failed_commands` | A live-data run: its grounded summary (`model`) or DGC's sentence (`dgc`), `{ok, failed, total}` and up to three lines that didn't finish |
| `preview`, `truncated` | A Personal Pip's result: its first 1,200 characters, cut at a paragraph |
| `text` | The post in one plain line, as the terminal says it |
| `posted_at` | When the run finished |

`list_pip_run_posts {pip_id, before_id?, limit?}` (a read, `limit` 1 to 50, default 20) returns
`{pip_id, workspace_id, posts, next_before_id}`, oldest first, the newest page first; `before_id`
is a post's `run_id`. The editor draws each post where it falls among the chat's messages, as the
Pip speaking: first-person words made from the post's own fields (never a model's), the details one
click away, and all-clear posts in a row (`clear`, `live_clear`, or `checks_passed` with the same number of
checks, no message between them) folded into one message. A live-data post's words are its `summary`: the model's,
held to the numbers its commands printed, or DGC's own. History (the Runs tab) says what each run found from
the same posts.

A post is not a chat message: it is not in `pip_chat_messages`, never queues a reply and never
pairs with a user message. A conversation run's context carries the five newest posts as
`run_posts` (each without the Pip's id and name, a Personal result's preview cut to 400
characters), and the worker puts them in the reference data beside `last_report`, with a note
that the user saw each as a short message from the Pip and that DGC wrote them, not the user.
`get_pip` returns `report_session`: the newest chat the Pip reports to (attached, or set up there),
where the editor's **Ask DGC to fix** fixes the report in the background (`start_pip_fix`, see
[PIPS.md](PIPS.md#ask-dgc-to-fix)).

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
  seconds, then 60, 120 and so on, doubling up to an hour, while the same time keeps
  failing to start (each `pip_schedule_deferred` event has `attempt` and
  `retry_after_seconds`; the third has `alert: true`). From the third failure the
  digest says so in its headline and is due as an alert once, a desktop notification is
  shown once, and the Pip's status in `pips_context` has `schedule_deferred` (and, for a
  Pulse or Patch whose commands can't run here, `cannot_run_here`). A run that starts,
  or a skipped time, ends the episode.

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

**Usage** (API 41). `get_pip_usage {pip_id}` returns `{usage: {pip_id,
today: {day, tokens, runs}, last_30_days: {tokens, runs}, days: [{day, tokens, runs}],
daily_cap, capped_today}}` over local days. A run's tokens are the input plus output tokens
the runner imported for it (`pip_usage_imports` in the usage ledger now keeps each run's
totals, all of its requests); a run not imported yet counts its result's `usage`, and a troupe
routine's tokens are added to the day it ran. Pips have no daily limit (2026-10-14): `daily_cap`
is always null and `capped_today` always false, kept because editors since API 41 read them, and
a limit an older DGC stored is ignored. `set_pip_daily_cap {pip_id, daily_tokens}` stays for older
editors and SDKs: `daily_tokens: null` answers with the usage, a number is refused
(`invalid_request`, "Pips have no daily token limit").

**Always allow** (API 41). `always_allow_pip_app_action {action_id, expected_digest}` (local
only) accepts one pending action like `accept_pip_app_action` and then saves a grant for its Pip:
`{id: grant_<32 hex>, kind, server, connection_digest, account, schema_digest, tool, label,
created_at, created_by}`, returned as `{action, grant}`. `list_pip_action_grants {pip_id}` and
`revoke_pip_action_grant {pip_id, grant_id}` (local only) return `{pip_id, grants}`. Grants live
in registry metadata (`pip_action_grant:<pip_id>:<grant_id>`, at most 20 per Pip), outside the
job, and record `pip_action_granted` / `pip_action_grant_revoked`.

**Terminal and robot checks** (API 43). A computer's Terminal (the tab's commands, the Pip's `run` and
the desktop's Terminal app) is online through the computer's egress proxy (public hosts, ports 80 and
443, CONNECT or plain HTTP) by an in-box relay on 127.0.0.1:8899 and `http(s)_proxy`; terminal history
entries may carry `reached` and `blocked` host lists (up to 12 each). A page read that is a robot check
(by address, title, text or challenge frame) returns a stop instruction to the model and sets
`get_pip_computer`'s `needs_you {host, at}` (registry metadata `computer_needs_you:<pip_id>`), cleared by a
later page past it or by `finish_pip_computer_check {pip_id}` (local only), which also queues the chat's
next turn under the reserved key `check_`.

**Choices** (API 43). A chat run offers `offer_choices {choices}` (2–4 distinct lines of up to 80
characters); the reply keeps them in `pip_chat_choices` and `list_pip_messages` returns them as the
assistant message's `choices`. The reply's text is everything the Pip said after the user's message,
up to its `offer_choices` call.

**A Pip's own apps** (API 43). A Personal Pip's chat and task runs offer `connect_app {app, why}`
and `read_app {app, tool, arguments}`, which reach the controller over a per-run Unix socket
(`pip_app_links.RunSocket`, token-checked, like the computer's). `connect_app` records a
`pip_app_links` row (`requested`; one open card per app; asking again refreshes its reason);
`read_app` reads an app whose card is `connected`, only with a tool from the closed read
vocabulary that belongs to that app, through `pip_app_access.execute` on the card's account.
Local-only commands, each `{pip_id, link_id}` except the list: `list_pip_app_links {pip_id}` →
`{pip_id, links, composio}`; `start_pip_app_link` calls `COMPOSIO_MANAGE_CONNECTIONS` with
`action: "list"` (an ACTIVE account connects at once) and otherwise `"add"`, and returns
`{link, redirect_url, sign_in_host}` with the card `authorizing` (the editor host opens the link
and never passes it to the webview); `check_pip_app_link` lists again and connects the first
ACTIVE account; `decline_pip_app_link` and `disconnect_pip_app_link` set `declined`. A card that
turns `connected` queues the Pip's next chat turn under the reserved key `apps_<link id>`.
Statuses: `requested`, `authorizing`, `connected`, `declined`, `failed` (with `error`).

**A Pip's plugins** (API 44; API 45 since 2026-10-09). The same socket serves `plugin_tools {plugin,
tool?}`, `call_plugin {plugin, tool, arguments}` and `plugin_answer {}` (`pip_plugins.Session`). A plugin
counts when it is installed and each of its servers is the vendor's hosted server, reached by DGC's own
remote client (`transport: remote`, saved as `npx -y mcp-remote <https url>`), saved exactly as the plugin registered it and not
in `disabled_mcp_servers`; the saved settings file is read, so a plugin added while the runner runs counts at
once. **Every plugin that counts is every Personal Pip's**: turning it on in Settings is the consent, and
there is no `use_plugin` or per-Pip card (API 44's `pip_plugin_grants` rows are kept but no longer
consulted, and Needs attention no longer lists them).

What runs at once is the plugin's level, `plugins.permission(name)`, kept in
`~/.dgc/plugins/installed.json` under `permissions` (ChatGPT's four; default `important`):
`always_ask` (every call is an Allow card, a read too), `any_changes` (reads run, every change asks),
`important` (reads run, and a change runs at once only when its vendor marks it `destructiveHint: false`
and `openWorldHint: false`; every other change asks) and `never_ask` (everything runs). A read is MCP
`readOnlyHint: true` and not `destructiveHint: true`, or one of DGC's reviewed reads for the package DGC
reviewed. A plugin with `risk: money` is never `never_ask` (refused when set, read back as `important`). In
a routine, schedule or event run every change asks, whatever the level. `plugin_tools` marks each tool
`[runs]` or `[asks]` accordingly; with `tool`, it returns that tool's description and input schema.

`call_plugin` runs a `[runs]` tool in the controller and returns its answer as untrusted data (40,000
characters at most); a change that ran says so. An `[asks]` tool returns an Allow card: a connector draft
`{server, connection_digest, schema_digest, call}` built by the controller from the discovered tool,
recorded in `pip_plugin_offers` for that run, and saved after the reply only if it matches that record
exactly. Allow prepares and accepts it as any connector action (`pip_app_actions`), after checking that the
plugin is still installed and turned on; then the plugin's answer (without any saved credential) is kept in
`pip_plugin_answers` for 30 minutes and the Pip's chat continues under `plugins_<action id>`. The same call
again within that time returns the kept answer and does not run again. A payment plugin never gets Always
allow: `always_allow_pip_app_action` refuses it with `asks_every_time` before the action runs, and a grant
never covers it.

**Used plugins.** A chat reply that took an answer from a plugin (a `[runs]` call that didn't come back as an
error, a kept answer, or `plugin_answer`) says so: the controller records each plugin once per run
(`Session.used`, up to 8) and saves them in the run's result as `plugins: [{plugin, name}]`, never taking the
worker's word for it. `list_pip_messages` returns them as the assistant message's `plugins`, and the editor
shows "Used [logo] Aave" under the reply. A run from before this has none.

Local-only commands: `list_pip_plugins {pip_id}` → `{pip_id, plugins: [], installed}`;
`list_pip_plugin_uses` → `{plugins: [{plugin, name, about, money, permission}], levels, installed}`;
`set_plugin_permission {plugin, level}` (API 45) → the same, after saving the level (refused for a device,
for an unknown level, and `never_ask` for a payment plugin). `allow_pip_plugin` and `decline_pip_plugin`
stay for API 44 callers.

**Web search** (API 45). The app socket also serves `web_search {query}`: 1–400 characters, run in the
controller with the one search set in Settings (`search_provider`, `search_api_key`, `search_url`, read
fresh from `~/.dgc/config.json` and `secrets.json`), results returned as untrusted data. Careful mode
refuses a query that carries what the Pip read from apps and the user didn't say this turn
(`Taint.carried`), before anything reaches a search engine. It returns results only; a page itself needs
the Pip's computer.

**Needs attention** (`pip_attention`, local only): `list_pip_attention {limit?}` (1–100, default 100) →
`{as_of, total, counts, by_pip, items, truncated}` over every Personal Pip that is not archived. `items`
are newest first: `{id: "<kind>:<card>", kind, card, pip_id, pip_name, pip_type, workspace_id,
created_at, expires_at, title, detail}`, `kind` one of `email`, `event`, `action` (Pip-drafted, pending,
not expired), `app_action` (a prepared action), `app_link` (requested or failed; newest per Pip and app),
`plugin` (requested; newest per Pip and plugin), `setup` (`pip_id` null for a new Pip), `computer_action`
(held, not expired), `computer_check` (`card` is the Pip id) and `routine` (suggested by the Pip).
`counts` and `by_pip` count every item even when `items` is cut. The read runs in a savepoint that is
rolled back, and decides "waiting" with `expires_at > now` in SQL: it never expires or resolves a row.

**What a Pip remembers** (`pip_notes`, schema 44, Personal Pips only): `pip_notes(id, pip_id,
workspace_id, text ≤300, source chat|you, run_id, created_at)`. A Personal chat reply to the user's own
message (`requested_by` `editor-user` or `local-console`) has a `remember {note}` tool, three a reply; the
worker refuses a note that shares no word (beyond common ones) with the user's message or holds a
credential, and the reply's `memory_notes` are checked again and saved when it is committed (the same
note twice is kept once; 60 per Pip, the oldest dropped). `conversation` and `personal_task` runs get
`pip_notes` (`[{note, kept}]`, newest first, ≤6 KB, redacted as the run starts) from the supervisor, with
`user_turn` (whether the chat turn is the user's own: requested locally, not a DGC-written key); neither is
saved with the run, and a reply's `memory_notes` are dropped from its stored result, so Forget leaves no
copy. A note is kept only when at least half its words, and every address, link or long number in it, are
in the user's message (checked in the worker and again in the supervisor). The chat gets them as
`user_notes` in its reference data with a notice that they are reference, may be out of date and grant
nothing. Local-only commands: `list_pip_notes {pip_id}` → `{pip_id, notes: [{id, text, source, run_id,
created_at}], max}`; `add_pip_note {pip_id, text}` (refused with `secret_note` when redaction would
change it) and `forget_pip_note {pip_id, note_id | all: true}` return the same. Forget deletes the row.

**Its own working notes** (`pip_working_notes`, Pips API 57, Personal Pips only): lines about doing its job ("The
hospital portal asks for the UHID first", "Bills go to Arjun Mehta"), at most 60 lines, 6 KB and 300 characters a
line, in `pips/working-notes/<pip>.md` (mode 0600). Every `conversation` and `personal_task` run (not a reviewed
handoff) gets them from the supervisor as `working_notes` (`[line]`, redacted again) and has a `working_notes {op:
add | replace | strike, line?, match?}` tool: `replace` and `strike` name the line by words from it (exactly one
line must match). The worker applies a change to its own copy, so the Pip reads it back at once, and returns its
changes as the result's `working_notes` (at most 12); the supervisor checks each again when the run is saved and
applies it to the file, dropping it from the stored result. A line is refused when it holds a credential, words like
`password is`, or 13 or more digits in a row (a card or account number), and, in the supervisor, when careful mode's
record (`pip_careful.Taint`) shows it carries what the Pip read from the user's apps in the last day (an email's or
an event's words) that the user didn't say, or when it holds an email address or a link the user never wrote to this Pip (in its chat or its job), so a page can't plant "send the receipts to someone@elsewhere" for every later run. Subscription brains (API 55) get the same tool over MCP. Local-only
commands: `get_pip_working_notes {pip_id}` → `{pip_id, lines, text, revision, max_lines, max_bytes, bytes,
updated_at}`; `set_pip_working_notes {pip_id, text, expected_revision}` (one line a note; `conflict` when the Pip
changed them since `revision`, `secret_note` when redaction would change the text) returns the same.

**Its daily log** (`pip_daily_log`, Pips API 57): DGC writes one line for each finished run of a Personal Pip's chat
reply, routine or task, in `pips/daily-log/<pip>/<YYYY-MM-DD>.md` (the computer's own days): the time, what it was
(`Chat: you asked "…"`, `Routine "…"`, `Task`, `Chat (DGC carried on)`) and how it ended (the reply's first words,
`Failed: …`, `Stopped`), redacted, at most 30 lines a day (the rest counted) and 30 days. No run is ever given it.
`list_pip_daily_log {pip_id, before?: YYYY-MM-DD, limit?: 1..14}` → `{pip_id, days: [{day, lines, more}],
next_before}`, newest first, local only.

**Its chat, looked back over for your memory** (`pip_memory_review`): after a reply to the user's own message
(requested locally, not a DGC-written key), once the user's words since the last look add up to a paragraph or so, or
once the chat has been quiet two minutes, the supervisor asks the Pip's own model (DGC's model for a subscription
Pip) once what to remember, and keeps at most three preferences, facts, decisions or outcomes in the user's one
memory by its rules (`memory_review.keep`: from the user's words only, no secret, nothing known), tagged with the
Pip and its latest reply's run, so that reply shows "Remembered" and its page lists them. Metadata
`memory_reviewed:<pip>` keeps the last message looked back over; with memory off it moves on without looking.

**Careful mode** (`pip_careful`, a Personal Pip with a computer; on unless metadata
`computer_careful_off:<pip>` exists): during a run, the supervisor's `Host` checks each step before it
runs. `open` to a site (registrable domain, from a built-in suffix list; a host under shared hosting such as
`amazonaws.com` or `github.io`, a user-content host such as `script.google.com`, an unlisted ccTLD's
`com`/`co` level and an IP are each their own site) not in `computer_sites:<pip>` or the user's own chat
messages (DGC's turns excluded), and not the home page's exact host (`www.google.com`, never all of
`google.com`), is recorded
as a pending `pip_computer_actions` row with `summary.kind: "site"` (`site`, `shown`: the host and its
`xn--` form), and the browser's gate holds a tab's own page load (`Document` in a frame that is an
attached target, a read method only; a write to it is held as an ordinary submit, with its fields; with
8 requests already held it fails) on such a site the same way. A Terminal command in a careful run reaches
only the Pip's sites (its egress proxy refuses others). `type`, `choose`, `open` and a Terminal `run`
whose text carries features (email addresses, 6+ digit runs, 16+ character tokens, 5-word runs) of what
the Pip read from apps in the last 24 hours (`read_app`, `call_plugin` and `plugin_answer` results,
`app_references`, a routine's turn; every run of the Pip, with or without its computer), less what the
user's own message says, are recorded with `summary.kind: "text"`, `read_from_apps: true`, the whole
`text` (up to 4,000 characters; longer is refused) and its `text_digest`. The record is per Pip, hashed
features only, in `<state>/careful/<pip>.json` (owner-only), the oldest dropped past 200,000. These holds
pause nothing in the browser (`request_ref` `careful:<id>`) and outlive a closed computer: approving a
site adds it to the Pip's sites, approving text allows exactly that text once for 30 minutes, and the
continuation tells the Pip to do it now.
`always_allow_pip_computer_action` refuses them (`asks_once`, `asks_every_time`). A routine, schedule or
event run (`local-routine`, `local-scheduler`, `local-event-trigger`) of a Pip with an `app_plan` or a
connected app gets no computer socket and `computer_paused: true`. Plugins are every Pip's since API 45, so
they don't decide it before the run: in such a run with a computer, `pip_careful.Lane` lets the Pip use its
computer or the user's plugins, whichever it reaches for first, and refuses the other for the rest of the
run. Local-only
commands: `list_pip_sites {pip_id}` → `{pip_id, careful, sites: [{site, at, by}]}`; `set_pip_careful
{pip_id, on}` and `forget_pip_site {pip_id, site}` return the same.

Sites the user gave count as named (Pips API 58): besides the user's own chat messages, a site written out
(`https://…`, `http://…` or `www.…`) in a file attached to one of them (`pip_chat_files`; a PDF's text through
`documents.extract_text`, a document's, or a text file's) is one of the Pip's sites. Each kept file is read once, by
its digest (metadata `computer_file_sites:<sha256>`, the sites it names, at most 50). Photos are left out: DGC has no
way of its own to read text in a picture (`photos` only converts and shrinks).

**How much it asks** (`pip_levels`, Pips API 58, Personal Pips only): metadata `pip_level:<pip>` = `{level, at,
by}`, `level` one of `ask` (the default, `pip_levels.DEFAULT`, for every Pip with none: as before), `approve` (Approve
for me) or `full` (Full access). A Project Pip is always `ask`. At the start of a `conversation` or `personal_task` run
the supervisor gives its `Host` the level and whether the run is unattended (`local-routine`, `local-scheduler`,
`local-event-trigger`), and the worker gets `approval_level {level, unattended}` (when not `ask`) only to word its
instructions; the worker never decides. In the run, each request the browser holds (from a browser step, a step by
position, a desktop step or a subscription brain's call: all end in `Host._record_held`) goes through
`pip_levels.decide_write` before it becomes a pending action:

- a card number in it (`payment`) asks at every level; so does `classify`'s `payment` verdict: `pay`, `purchase`,
  `buy`, `place order`, `order now`, `complete order`, `donate`, `transfer`, `subscribe`, `top up`, `recharge`,
  `billing` in what was pressed or the address, or a card or bank field name (`card`, `cvv`, `expiry`, `iban`, `upi`,
  `amount`, `payment method`, …);
- `consequential` (`send`, `message`, `email`, `post`, `share`, `comment`, `review`, `delete`, `remove`, `cancel`,
  `password`, `account`, `settings`, `profile`, `sign up`, `register`, `book`, `reserve`, `schedule`, `confirm`,
  `checkout`, `order`, `upload`, …, or the `DELETE` method) asks at `approve`;
- `routine` (a search field such as `q`; `search`, `filter`, `sort`, `add to cart`, `cart`, `quantity`, `draft`,
  `wishlist`, `cookies`, `consent`, `load more`, `check delivery`, `size`, …; an upload of a file from `Files/From chat`
  within five minutes) is let through at `approve`;
- a GraphQL request (its address has `graphql`, or it has an `operationName` field) is judged by its operation, never
  as a search by its `query` field: payment and consequential words in the operation's name as above, a `query` is
  `routine`, and a `mutation` is `routine` only by its own name (`AddToCart`), else `unsure`;
- `unsure` (none of these) asks at `approve`; `full` lets through everything but a payment.

Words are matched whole on the lower-cased text, split at anything but letters and digits and at camelCase. "What was
pressed" is the step's own target (the accessible name `click` returns, the option `choose` picked, the label
`check` set, a confirm's message, `element_at` for a click by position); with none (Enter in a field, a desktop step),
the submit buttons of the form the request goes to or the form holding focus, read in DGC's isolated world
(`BoxedBrowser.form_cues`). No model is asked. A request a level lets through is released at once (the same run goes
on; no continuation) and kept as a `pip_computer_actions` row already `sent`, `resolved_by: "pip-level:<level>"`,
whose summary has `what` ("Added to cart on shop.example"), `level` and `unattended`; the step's timeline label adds
"Approved by its level: Approve for me · Added to cart on shop.example" (and "· nobody at the keyboard"), the row's
`frame` is the step's picture, and the Pip's answer says "DGC approved that by the user's level (…): …". A careful
site hold becomes, at `approve` and `full`, such a row of `kind: "site"` (`request_ref` `level:<site>`) and the site
joins the run's sites (not `computer_sites:<pip>`, which stays the user's). A pending hold at those levels carries
`asks_because` (`payment`, `consequential` or `unsure`), and its card says why. `get_pip_computer` lists pending
actions first. An event `pip_level_approved` is recorded for each.

After a run (and its Always-allow grants), `pip_levels.dispatch_for_run` sends each pending draft of that run its
level lets through, as actor `pip-level:<level>` (`pip_app_actions._acting` re-checks it with `pip_levels.check`
against the Pip's level at that moment): at `full` every email, event and plugin or connector action except a payment
plugin's and a tool named for money (`charge`, `refund`, `payout`, `transfer`, `order`, …); at `approve` an email to
an address the user wrote in their own messages to this Pip or already sent to from it (an approved send), an event
whose guests are all such addresses (or none), and a plugin action named like a draft or a read. An email or event
goes through the Pip's own connected account (`pip_app_links.connected`, `pip_app_accounts.discover`, the adapter's
`inspect`). One that can't stays a draft for the user (event `pip_level_skipped`).

The safety floor (`pip_levels.floor`), at every level and with careful mode off too: a Terminal `run`, or
`desktop_type` text, that could wipe its Files (a recursive `rm` of `/`, `/home`, `~`, `$HOME`, `.`, `..`, `*` or
`Files` and their `/*`; `rm -f *`; `find` of such a root with `-delete` or `-exec rm`; `xargs rm -r`; `shred` of
one; `rsync --delete` into one; `git clean -f` with `-d` or `-x`; a fork bomb; `mkfs`, `wipefs`, `dd of=/dev/…`), seen
through `sudo`, `env`, `timeout`, `sh -c`, `$(…)` and backticks, is recorded with `summary.kind: "floor"` (`floor`:
what it could do, the command as `text` and `text_digest`). Approving it allows exactly that command once, within
30 minutes (metadata `pip_floor_allowed:<pip>`); `always_allow_pip_computer_action` refuses it
(`asks_every_time`). Words used as data (`echo`, a quoted message, a comment) are never a command; a command the shell
couldn't read runs as before (it fails there).

Local-only commands: `get_pip_level {pip_id}` → `{pip_id, level, default, levels: [{level, name, says}], on_its_own:
[{at, what, level, unattended, kind: site | computer | app}]}` (the newest 20, each line once); `set_pip_level {pip_id,
level}` returns the same and records `pip_level_changed`. The desktop notification (`pip_action_grants.ran_on_their_own`)
names app sends a level made and submits at `full`.

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
pip_type, scope, project, status, input_tokens, output_tokens, runs, daily_cap (always null)}], omitted,
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
restarts_after_failure, while_logged_out}`. `set_pips_keep_running` also records the user's choice
(`keep_running_choice` in the registry's metadata). When a local `accept_pip_setup`,
`accept_pip_update`, `add_pip_routine`, `update_pip_routine` or `decide_pip_routine` leaves a Pip with a
schedule, an event trigger or a routine that is on, and the switch is off, DGC turns it on as the switch
does, unless the recorded choice is off (or an earlier off left its trace: a Linux unit installed but not
enabled, a macOS agent in launchd's disabled list, which is then recorded as the choice), or `HOME` isn't
the account's own. The result then carries `keep_running_notice`: one plain sentence (turned on, left
off as chosen, or what to do when it couldn't, such as `sudo loginctl enable-linger USER`). The chat's
`pips_setup` result says the same, and the setup notice to the proposing chat repeats it. It never fails
the change. On Linux, on installs the managed user unit
(format 2: `Restart=on-failure`, `RestartSec=30`; an earlier DGC unit for the same home is
replaced, any other differing unit is refused), enables it, starts it unless a runner is
already online, and asks `loginctl enable-linger` when lingering is off. On macOS, on writes
`~/Library/LaunchAgents/com.vibedgc.pips.<home hash>.plist` (`RunAtLoad`,
`KeepAlive: {SuccessfulExit: false}`, `ThrottleInterval` 30), enables it and bootstraps it
into the GUI domain; an unchanged loaded agent is never reloaded, so a running runner is
not interrupted. In WSL (platform `wsl`), on writes `~/.dgc/pips-keep-running.sh` (0700: a
loop running the runner, restarting it 30 s after a failure, ending when it exits 0 or when
`~/.dgc/pips-keep-running.on` is gone), adds `DGC-Pips-<distro>-<home hash>` to the user's
own `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` running it through `wslg.exe`
(no window), and starts it unless a runner is online; `while_logged_out` is false; WSL 1, an
unnamed distro, interop off or no `wslg.exe` make it unsupported, with the reason. Off
disables (Linux), disables and removes the agent (macOS), or removes the Run value and the
script (WSL), and never stops the runner. All start `pips serve --service`, which exits 0 when Pips are off,
emergency-stopped or already running, so none of them restarts it in a loop. Writable
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
other, and its summary adds `payment: true` so the review can say so. From API 53 a payment asks
every time: `always_allow_pip_computer_action` refuses it (`asks_every_time`), and no
`computer_submit` grant approves one.

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

**Waiting, tabs, a page's dialogs and downloads** (2026-10-21; the `computer` tool's own, so no Pips API change).
Every computer's tool also has `forward`, `reload`, `wait {text?, gone?, ref?, selector?, url?, seconds?}` (checked
every quarter second for at most 30 s, 10 by default; with nothing to look for, until `document.readyState` is
complete and the tab's own Document, XHR and Fetch requests have answered; what the model gives is data in a fixed
script, never code), `check` and `uncheck {ref}` (a click as a person makes it, then a check that it took; a radio
button can't be unchecked), `hover {ref}`, `drag {ref, to}` (both refs, so a text-only Pip has it; `drag {x, y, to_x,
to_y}` stays for a Pip that sees), `type {…, submit: true}` (Enter after; Enter now carries its `"\r"`, so a field
submits its form as on a keyboard), `tabs {action: list | open {url} | switch {tab} | close {tab}}` (tabs are t1, t2…
until the browser restarts; careful mode asks before `open` on a new site; the last tab can't be closed; `op: "switch"`
with a tab, or `op: "action"`, the slips small models made in three runs out of three, are taken as `tabs`; each tab's
refs are its own, t1's from `e1` and tN's from `e{(N-1)*10000+1}`, and a ref from another tab's page answers which tab
it is from instead of acting on this one), `status`
(the tab in front and the others, an open dialog or file picker, the downloads) and `dialog {accept, text?}`. There
is still no step that runs a script of the model's own. During a run (`Host.begin`) a page's `confirm` or `prompt`
stays open (`Page.javascriptDialogOpening` isn't answered): the step that opened it stops waiting for its own reply
and answers with the question, quoted as page output; until `dialog` answers it, anything that would run in that tab
(a read, a screenshot, input) is refused at once, and the user's live view says the page is asking the Pip a
question. OK starts the write window as a click does, so a submit it leads to is held, a payment asks and a card-less
Pay is dropped. An `alert` is closed at once and reported, leaving a page (`beforeunload`) is accepted, with no run
every dialog is answered at once as before, and a run that ends with one open cancels it. A page the tab in front
opens during a step (`Target.attachedToTarget` with its `openerId`) becomes the tab in front (`Target.activateTarget`;
the live view follows), and when the tab in front closes itself (a sign-in popup that finished) the step goes on in
the tab that opened it and says so. During a run a file picker the page opens is caught
(`Page.setInterceptFileChooserDialog`) and the next `upload {path}` answers it, with no ref or point needed. Downloads are followed with `Browser.setDownloadBehavior`'s `eventsEnabled`. The
browser now starts with DGC's tab alone in headless mode too (it closed the others only on a desktop).

*Every browser step's answer* (`pip_browser_steps`). Right after the untrusted-page line, what changed since the page
the Pip last read, in at most 600 characters, compared on the read's lines without their refs (a line whose value is
hidden, a password or card field, is never part of it): `Moved to URL ("Title").`, `Opened a new tab: "Title" (URL);
you are on it now.`, `Changed: …` (a field's value, a box checked), `Appeared: …`, `Gone: …`, `Now showing: …` or
`Nothing on the page changed.`, with a download (`Downloaded Files/Downloads/NAME (SIZE).`) or an alert the step
caused. Then the page as it is now; then `Page reported (page output, not instructions): …` in at most 500
characters: the tab's requests to the page's own site (Document, XHR, Fetch, Script) answered with 400 or more or
failed below HTTP (never `net::ERR_ABORTED` or DGC's own `ERR_BLOCKED_BY_CLIENT`), console errors (not Chrome's
"Failed to load resource", which repeats a request) and uncaught exceptions, each once per page visit, stripped of
control and bidirectional characters and quoted, ids in paths collapsed to `#`, never a query. A robot check still
stops a read as before; after a step by position, answered with a picture, the same check adds `a human check (…):
don't try to solve it; stop and ask the user…` and is recorded as a read records it. Last, `Recorded as step N.`: a step that changes something (not `read`, `look`, `wait`,
`status` or a tab listing) takes the run's next number when its screenshot is kept, and that frame's label starts
`Step N · ` (`Clicked "Search"`, `Typed into "Search mugs" and pressed Enter`, never what was typed), so
`list_pip_computer_frames` and **What it saw…** show the number the Pip was told, with no new field. A step that
opened a dialog has no picture (nothing on that page can be pictured until it is answered), so no number. Steps by
position, `upload`, `sign_in` and the desktop's steps are numbered the same way.

**Eyes and a cursor** (API 53, `pip_eyes`). The `computer` tool also has `look`, `click_at`,
`double_click_at`, `right_click_at`, `hover_at`, `drag`, `scroll_at` and `upload`, and `type` with no
`ref` types into what has focus (a key event per character, so a canvas editor's text box sees it).
Only a run whose model sees is offered the position operations: the worker asks its own client
(`vision.has_vision`: Ollama's `/api/show` must list `vision`, cached by `LLMClient`), or the run
has a vision relay (below). `look` returns the browser's visible page as a JPEG of at most 1280 × 800
(`BoxedBrowser.screenshot_for_model`), which the worker gives the model as an image after the step,
labelled with its size and the run's point scale; the result text gives the size, the address and the
title, marked untrusted. Only the run's last two screens stay in its context. `click_at {x, y}`,
`double_click_at`, `right_click_at`, `hover_at {x, y}`, `drag {x, y, to_x, to_y}` (press, twelve
mouse moves, release; an HTML drag the page starts is caught with `Input.setInterceptDrags` and
finished with drag events at the same points) and `scroll_at {x, y, dy}` act in the latest
screenshot's space, converted to the page's CSS pixels; a point off the screen is refused. Each sets
the write window (`acted_at`) as a ref click does, so a submit it causes is held the same way; each
names what was under the point (role and name, never a field's value), records a timeline frame with
`pointer {kind, x, y, from_x?, from_y?}` (CSS pixels), and answers with a new screenshot on which a
red ring marks the mouse (drawn by DGC, said in the text). `upload {path, ref | x,y}` reads the path
as a regular file in the Pip's Files (no links followed, at most 64 MB), copies exactly those bytes
into `home/.dgc-uploads/TOKEN/NAME` (beside Files, where the Terminal box never reaches, so nothing can
swap it for a link to the browser's profile in between), and gives that copy to the page: a `ref` to an `<input type=file>` through `DOM.setFileInputFiles`, or a button (ref or
point) whose file chooser DGC answers itself (`Page.setInterceptFileChooserDialog`,
`Page.fileChooserOpened`). Choosing sends nothing; the page's upload is held like any write. A
chat's photos are copied into `Files/From chat` as `photo-SHA12.EXT` for a Pip with a computer.

*What the model never sees.* Before each screenshot, DGC's own isolated world (`Page.createIsolatedWorld`,
so page scripts neither see nor change what it uses) finds every `input`, `textarea` and `select`
that is a password (type), has an `autocomplete` token `cc-*`, `current-password`, `new-password` or
`one-time-code`, is named, labelled or placeholdered like a password, card number, expiry, CVC/CVV,
one-time code, PIN, IBAN or SSN, or holds 13-19 digits; and every frame whose address, name or title
is a payment provider's (Stripe, Braintree, Adyen, PayPal...). Each frame of the tab is asked the same
way in its own isolated world, and each frame from another site through its own target session; their
fields are placed by the box of the frame that holds them, and a frame DGC can't ask or place is
covered whole. The screenshot is then redrawn in an `OffscreenCanvas` in that world, fitted to 1280 ×
800, the boxes filled black (3 px wider each side), and re-encoded; if that fails, no screenshot is
sent. Timeline frames, the live view and approval cards are unchanged.

**Saved logins** (API 56, `pip_logins`, `pip_login_fill`, `pip_totp`). A login is `{id: login_HEX32, site, hosts,
exact, username, password, totp: {secret, algorithm, digits, period} | null, pips: "all" | [pip ids], sign_in_page,
source: "card" | "page", created_at, updated_at, last_used_at}`, at most 200, each field at most 512 characters.
`site` is the registrable domain of the address it was saved for (`pip_careful.site_of`), `hosts` the sign-in hosts
seen (the card's page host, or the typed address's), `sign_in_page` that page without its query. The same site and
username saved again replaces the password (and the key, when one is given), adds hosts and widens `pips`. They live
in `<pips>/logins/logins.sealed`: `DGC-LOGINS-SEALED-1\n`, a 16-byte nonce, the JSON XORed with
HMAC-SHA256(enc, nonce || counter) blocks, and HMAC-SHA256(mac, magic || nonce || ciphertext); enc and mac are
HMAC-SHA256 of the 32-byte key in `logins.key` (64 hex characters) with fixed labels. Both files are written
atomically, 0600, the folder 0700, with an `flock` on `logins/.lock`; the key is created once (a hard link, so two
processes never race to different keys). A file that fails its tag, has no key, or isn't a regular file opens as an
empty store (one line to stderr, never the contents). Every value a process saves or reads is kept in memory for
`redaction.secret_values`, which also reads this profile's sealed file when it changes (by its stat).
`pip_totp.parse_key` takes base32 (any case, spaces, dashes and padding ignored; at least 10 bytes) or an
`otpauth://totp/` URI (`secret`, `algorithm` SHA1 | SHA256 | SHA512, `digits` 6-8, `period` 10-300); `hotp` URIs are
refused. Codes are RFC 6238 with T0 = 0.

Requests, local user only (`local_only` otherwise), Personal Pips only: `list_pip_logins {pip_id?}` → `{logins:
[{id, site, hosts, username, has_code, pips, source, created_at, last_used_at, usable?}]}` (`usable` with `pip_id`);
`save_pip_login {pip_id, username, password, totp?, pips?: "only" | "all", site | action_id + expected_digest}` →
`{login, action?}`; `remove_pip_login {login_id}` → `{removed, login_id}`; `grant_pip_login {login_id, pips: "all" |
[pip ids]}` → `{login}`. No answer carries a password or a key. `handle_control` keeps a save's `username`,
`password` and `totp` as sent (redacting them would store a mask once DGC knows them) and passes them to the store
only. With `action_id`, the action must be this Pip's pending computer action of kind `login` with that digest; the
login takes the card's host and sign-in page, and the action is approved in the same request.

The `computer` tool has `sign_in {site?}` (every computer, eyes or not, so a subscription brain gets it too). On the
current page (https, or http to a loopback host; never plain http to another computer) DGC uses the most recently
used login this Pip may use whose site or hosts match the page's host; with `site` and the page elsewhere, or on a
page of its site with no username, email or password box, it opens the login's `sign_in_page` first (careful mode
checks it like `open`). With none, it records a computer action of
kind `login` (`request_ref` `careful:ID`, nothing paused; summary `{method: "SIGN IN", host, path, page, site, shown,
sign_in_page, fields: []}`), adds it to the run's held actions, and answers `No saved login for SITE…`; a second
`sign_in` while it is pending answers that it is there, and after a `Not now` (a rejected one in the last 24 hours)
that the user chose not to. `decide_pip_computer_action` approve on a `login` action is refused (`save_login`), as is
`always_allow_pip_computer_action`; the supervisor's tick turns an approved one `sent` and continues the chat with
"The user saved a login for SITE… Use sign_in there now", and a rejected one with "The user chose Not now…".

`SignIn` (pip_login_fill) runs in the supervisor on the Pip's `BoxedBrowser`, in a fresh isolated world for each
script. `FIND` marks this step's username, password and code boxes (`data-dgc-login="NONCE:STEP:NAME"`): visible,
enabled `input`s; a code box by `autocomplete=one-time-code`, a strong hint (otp, 2fa, mfa, two-factor, one-time,
authenticator) on a text, number or password box, or a weak one (verif, security code, passcode, "code") on a text or
number box, never a postal, promo, card (`cc-*`, cvv, cvc, csc) or gift box, and a group of 4+ one-character boxes
as one code; the password is a `type=password` box (`current-password` first, never `new-password`); the username
the user-like box before it in the same form. `FOCUS` marks a password or code box `data-dgc-secret` before
typing, focuses it and empties it with the native value setter and an `input` event; the value goes in with
`Input.insertText`. `CHECK` answers which marked boxes now hold something (booleans). Then `LoginPass {hosts, site,
exact, values, until: now + 15 s}` is set on the browser and Enter is pressed in the last box; if within 2 s nothing
was submitted (a `submit` or `beforeunload` listener writes `data-dgc-login-sent` on the document) and nothing
changed, the form's own submit control (or a button named sign in, log in, continue, next, submit, verify or confirm)
is clicked at its centre. The write gate (`BoxedBrowser._gate`) lets exactly one non-GET request through while the
pass is live: to a host in `hosts` (or on `site` unless `exact`), whose body carries one of `values` (a form field
equal to it, a JSON string equal to it, or the value raw, JSON-escaped or URL-encoded in the text), and that carries
no card number; it then clears the pass and `acted_at`. Anything else is held as before; a held request's shown
field values that a saved secret would be scrubbed from show `•••`. The step's outcome is read for up to 8 s (`STATE`:
the address changed, the marked boxes are gone, the page is leaving, a new alert, a robot check). The next step
waits up to 10 s for a password or code box (5 s for a code when the login has a key, 1.5 s otherwise). A code is
made at the moment it is typed, waiting for the next period when fewer than 3 s are left. A step that shows the box
already filled is a refusal (`The site did not accept the saved login…`, the boxes DGC filled are emptied, nothing
is sent twice). At most three steps and 40 s.

`Host.act` scrubs every answer (`Scrubber`): the store's passwords and keys (by the sealed file's stat), the
passwords typed on this computer, and each code for five minutes (not inside a longer number), in raw, JSON-escaped,
HTML-escaped and URL-encoded forms of four characters or more, as `••••••`. Timeline labels and addresses are
scrubbed too, and a sign-in step's timeline frame is the masked picture (`screenshot_for_model`, 1024 × 640). The
snapshot (`read`) and `_SECRET_BOXES_JS` treat a `data-dgc-secret` box as a secret, so `read` shows `value=(hidden)`
and every picture the Pip sees blacks it out. When a fill leaves a secret on a page (not sent), `secret_hold {url,
until: now + 60 s}` refuses `drag`, `desktop_drag`, `desktop_key` and `desktop_type` on that page until it changes,
and at the end DGC empties the boxes itself. `read` on a page with a password box, or a username or email box, adds
a line saying `sign_in` can sign it in (with a saved login, or a card). A Pip's Chrome profile has
`credentials_enable_service`, `profile.password_manager_enabled` and `profile.password_manager_leak_detection`
false, so Chrome never offers to save a password.

*Points.* Most models name a point in the image's pixels; Qwen3's vision models (qwen3-vl, qwen3.5,
qwen3.6, qwen3.8) answer on a 0-1000 scale across the image, even when asked for pixels.
`pip_eyes.convention_for` gives each model its own scale and the tool description says it plainly;
`pip_eyes.to_pixels` converts, and an answer that can only be the other scale (in pixels, a point past
the image's edge with both numbers within 1000; on 0-1000, a number over 1000 inside the image)
switches the run to it. Measured on a 23-target page (buttons, links, checkboxes, 16-32 px icons and
shapes on a canvas), one click each, hit = inside the target, through this path:

| Model | Scale | Hits | Median seconds a click |
| --- | --- | --- | --- |
| deepseek-v4.1-flash:cloud | pixels | 21/23 | 0.8 |
| qwen3.8:27b-q4km | 0-1000 | 23/23 (0/23 read as pixels) | 8.7 |
| qwen3-vl:8b | 0-1000 | 11/23 (1/23 read as pixels) | 109 (it thinks before every answer) |

*A model that reads text only.* At a Personal Pip's run start the supervisor pins `computer_eyes`:
the user's choice for this Pip (`ask`, `relay` or `off`, registry metadata `pip_eyes:PIP_ID`), the
model's scale, and, when the Pip's model can't see, the model that would see for it
(`pip_eyes.pick`: from the connection's catalog, the same kind first (`:cloud` with `:cloud`), then
the configured sub-agent model, then models Ollama has loaded, then smaller ones; it must list
`vision`, `tools` and `completion`; at most 32 checked, cached an hour). In `relay` the worker's
vision route is that model on the Pip's own connection: `look` sends it the screenshot and the Pip's
`question` (`vision.look`, one request, no tools) and it answers in words with points in its own
scale, which the tool then reads; photos sent in the chat are described the same way. In `ask`, a
conversation run whose model calls `look` ends its turn there, and a message with photos is not sent
to the model at all; the reply is one line, `**MODEL can't see images.**`, with three choices (an
options card, `choices`): "Use VISION to see, keep MODEL for the rest", "Switch this Pip to VISION",
"Not now" (shortened to fit 80 characters). A model that never asks to look gets the same card after
its own reply when its run read a page at least 15% drawn on canvases (`read` then also says so in its
text) or its reply says it can't see images, the screen, the canvas or the design; its words stay, and
the line follows them. The reply's `eyes` records the card
(`pip_eyes_asked:PIP_ID`). When the user's next message is exactly one of those choices and the card
is still the Pip's latest reply, `send_pip_message` applies it before queueing the run: `relay` and
`off` are saved, and a switch proposes and accepts the Pip's `model_choice` (checked against the
catalog), so that run already uses the model that sees. That run is told the answer (`decided`) and
gets the earlier message's photos again. In `off`, `look` says the user chose that it works without
seeing. A task run has no card: it says in its result that its model can't see images.

`get_pip_eyes {pip_id}` and `set_pip_eyes {pip_id, choice}` (API 53, local only, Personal Pips)
return `{eyes: {pip_id, model, sees, choice, vision_model}}`; `sees` is null when the connection
doesn't say. `list_pip_computer_frames` takes `pointers: true` (API 53), and then a row from a step
by position also has `pointer {kind, x, y, from_x?, from_y?}`; without it the rows are exactly as
before. `use_pip_computer_view` takes op `pointer` (API 53): `{view: {ok, watching, pointer}}`
without a frame, so a full screen that streams itself can draw the cursor, and a `frame` reply
carries `pointer` too. `pointer` is `{kind, x, y, from_x?, from_y?, at, seq}` in the page's CSS pixels,
plus `screen_x`, `screen_y`, `screen_width` and `screen_height` when the browser is a window on the
computer's desktop (its window position and toolbar height, read in an isolated world).

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

**The whole desktop** (API 54, `pip_desktop_eyes`, `pip_apps`; Linux). A run whose model sees (`own`
or `relay`, as in API 53) on a computer whose screen this machine shows (the computer pin's `desktop`)
also gets: `desktop_look` (the whole screen), `desktop_click`, `desktop_double_click`,
`desktop_right_click`, `desktop_hover`, `desktop_drag` (`x`, `y` to `to_x`, `to_y`, pressed, moved in
16 steps, released), `desktop_scroll` (`dy`, `dx` in pixels, about 40 a wheel notch), `desktop_type`
(`text`, at most 2,000 characters, into the window in front; any Unicode character types, as its X
key symbol), `desktop_key` (`key`: a name or a shortcut such as `ctrl+s`, `alt+tab`, `Enter`, `F5`;
with shift a letter is sent as its capital; up to 30 separated by spaces are pressed in turn), `windows` (the open windows, front first: id, app, title,
position, size; minimised ones listed apart), `focus_window` (`window`: its id; `_NET_ACTIVE_WINDOW` to
the window manager) and `launch_app` (`app`: `images`, `documents`, `pdf`, `files`, `terminal` or
`browser`, and for the first three an optional `path` in Files, walked like every Files path; with only
a `path`, the app that opens its kind). Points are in the latest `desktop_look` picture, in the model's
own scale (pixels, or 0-1000 for Qwen3 vision models, as in API 53). The hands are a VNC client
(`pip_rfb`, RFB 3.8, Raw pixels) on the desktop's own Unix socket, a connection of its own: never the
user's live view, whose input filter is unchanged. The windows are read from the desktop's X server
(`pip_x11`) on `<runtime>/x11/X1` only, never `$DISPLAY`. Each step answers with a new picture (a red
ring at the mouse after a step by position), is a timeline frame (the whole screen, blacked out the
same way, at most 90 KB), and sets the live view's `pointer` with `screen_x`/`screen_y` (its `kind` is
API 53's: `click_at`, `drag`... so an older editor draws it). A step on the browser's window (keys to
it in front, the mouse over it) stamps the browser's `acted_at`, so a submit or upload it causes is
held exactly as one from a browser step; a step on another app leaves the page's own background
requests alone.

*What the model never sees.* Before a desktop picture is encoded, DGC blacks out, window by window in
stacking order (a window in front, with its frame, is put back as it was): on the browser's own tab
every password, card number, expiry, security code and one-time code field (`secret_boxes`, as in API
53), placed through its window: the X window of a Chrome or Chromium class whose geometry matches
the window CDP reports for DGC's tab (`Browser.getWindowForTarget`, within 12 pixels), the page's
origin at the bottom of it (`innerWidth`/`innerHeight` times `devicePixelRatio`); every other browser
window, and the browser's window when another tab is showing in it, whole; and any window whose title
asks for a secret (`Enter Password`, `Unlock Keyring`, `Authentication required`...; never a browser
window). When DGC's tab is showing but its window can't be found on the screen, or the browser can't
say where its fields are, no picture is sent. A password typed in a desktop app's own field (not a
dialog) is drawn as dots by the app; DGC does not find such fields itself. The picture is a PNG made in
DGC's process (stdlib), then a JPEG at most 1280x800 by the computer's own image tools (`photos`:
Pillow, libvips, ImageMagick, ffmpeg or GdkPixbuf), or with none, by the Pip's browser in DGC's
isolated world.

*Its apps.* An image editor (LibreOffice Draw), a document editor (LibreOffice Writer) and a PDF viewer
(Evince), on the dock after the Terminal (each writes its name to the control FIFO, and the Host opens
it) and through `launch_app`. Each runs in a box of its own: `bwrap --unshare-all`, online only through
the computer's egress proxy (its socket and an in-box relay on 127.0.0.1:8899 with `http(s)_proxy`, as
the Terminal: public addresses on ports 80 and 443, never this computer, the local network, link-local or
cloud metadata; no per-site asking, and what an app sends needs no Allow card: only the browser holds
submits), `/usr` read-only, Files at `/home/pip/Files`, its settings in
`computers/PIP_ID/home/.apps` at `/home/pip/.config` (LibreOffice seeded without its first-run screens,
macros off, its dialogs starting in Files, and ctrl+shift+e for Export in Draw so a PNG is made with keys
alone), the desktop's X socket directory at `/tmp/.X11-unix`. The program runs from its own mount
(`/opt/apps/libreoffice`, `/opt/apps/evince`): Ubuntu's AppArmor profiles for both attach by path and
can't resolve a box's paths, which refused their X connection. Files and the Terminal are opened in the
desktop box through a second FIFO (`launch`), which runs one of two fixed commands. They come from the
system when it has them. Otherwise, on an apt system, `get_pip_computer_apps {}` (local) returns
`{apps: {apps: [{key, name, program, available}], missing, state, line, bytes}}`: `state` is `ready`,
`measuring` (the size is not known yet: the desktop setup's apt state works it out, `apt-get -s install
--no-install-recommends` and each package's `Size`, recorded in `~/.dgc/desktop/ARCH/apps.json`),
`offer` (`line` says what and how big, once), `downloading`, `declined` or `unavailable` (the system's
own LibreOffice lacks a part: `line` names the packages to install). `set_pip_computer_apps {choice:
"download" | "not_now"}` (local) answers it: a download joins the desktop's own (`pip_screen_setup`),
unpacked into the same root, and DGC's Evince gets its schemas compiled and `EV_BACKENDS_DIR`. Measured
for an Ubuntu 24.04 desktop without them: LibreOffice Draw and Writer with the GTK 3 plugin and Evince
are 22 packages, 83 MB to download and 291 MB unpacked.

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

**Photos and files through the spool** (API 52). Inline, the 4 MiB command frame caps a message's
images and files at four of each and 2 MB in all. From API 52, `send_pip_message` also takes them
the way the main chat's `prompt` takes `spooled_images`: the client writes each file into the
backend's image spool (`ready.capabilities.image_spool_dir`, created and owned by the backend,
files 0600) and sends only names.

| Field | Shape | Limits |
| --- | --- | --- |
| `spooled_images` | `[{name, media_type}]`: the file's bare name in the spool, and `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`, `image/heic` or `image/heif` | 1 to 64; 8 MiB a photo, 32 MiB in all (`attachments.MAX_SPOOLED_IMAGE_*`) |
| `spooled_files` | `[{name, spool}]`: your file's own name, and its bare name in the spool | 1 to 16; a document 16 MiB, a text or code file (CSV and TSV too) 1 MiB, 32 MiB in all (`attachments.MAX_DOCUMENT_*`, `MAX_TEXT_FILE_BYTES`) |

A name is a bare file name: no folder, no `..`, nothing absolute. The backend reads each one no
further than its limit, checks it exactly as an inline one (an image's bytes must be the type it
claims; a document must start the way its kind does) and removes it from the spool, whether the
send succeeds or is refused. Only this computer's own controllers (`editor-user`,
`local-console`) may name spool files; anyone else gets `local_only`. The names are bounded on
their own, outside the request's 256-item budget, and carry no data. Inline `images` and `files`
keep working as before, for an older client.

An iPhone photo (`image/heic`, `image/heif`, checked by its `ftyp` brand) is kept as the JPEG it
becomes (`photos.heic_to_jpeg`): at most 4,096 pixels on its long side, quality 92. DGC uses the
first converter the computer has: macOS's `sips`; Pillow with pillow-heif in DGC's own Python;
libvips (`vipsthumbnail`); ImageMagick; libheif's `heif-dec` or `heif-convert`; GdkPixbuf through
the system's `python3` (with heif-gdk-pixbuf, as on Ubuntu's desktop); then `ffmpeg`. With none
that reads HEIC, the send is refused with one sentence (`To send iPhone photos (HEIC) from this
computer, install heif-convert (the libheif-examples package) or send them as JPEG.`) and nothing
is kept.

The registry schema stays 46. A registry made earlier holds `pip_chat_images` and `pip_chat_files`
with the inline limits in their `CHECK`s (index 0–3, 2 MiB); the first message that brings images
or files rebuilds both, rows kept, in its own transaction, with the new bounds (images: index
0–63, 8 MiB; files: index 0–15, 16 MiB). An older DGC still opens the registry and reads them.

`get_pip_message_image` takes `as_file` (API 52): with `true` the result is `{pip_id, message_id,
index, path, mime, bytes}`, where the kept file is, instead of `image`. A photo of 8 MiB is more
than any protocol frame carries as a data URI, so the editor reads the kept file itself; the
backend checks it against its digest first, either way.

**Photos for the model.** Wherever DGC sends a prompt's images to a model (a Pip's chat, the main
chat, the terminal), one over 2,500 pixels on its long side is sent at 2,500 pixels
(`photos.for_model`), as a JPEG of quality 90 (a PNG stays a PNG), upright by its EXIF
orientation and lightly sharpened (Lanczos with an unsharp mask of radius 1.2 and amount 0.6, where
the converter has one). Nothing is upscaled, a GIF is left alone, and the chat keeps the original:
only the model's copy is smaller. The same converters do it, except that for shrinking ffmpeg comes
before GdkPixbuf, which can't sharpen; with none, the model gets the original. Measured with
`deepseek-v4.1-flash:cloud` on five phone photos of paperwork in one message (24 runs each), a
6.5-point claim reference on a bill read exactly 24/24 from the sharpened 2,500-pixel copy, 14–21/24
from an unsharpened GdkPixbuf shrink, and 22–24/24 from the 4,032-pixel original.

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

**Your own app's tools** (`pip_sdk_apps`, Pips API 61). An app your code registers with `register_app` (local only)
is one more connection, `app:<name>`. It is kept in `<Pips state>/apps/apps.json` (0600, its folder 0700): its name
(`[a-z0-9-]{1,40}`), its `url` (`https://`, or `http://` only for `localhost` and `127.0.0.1`; no user, password or
`#`), and 1 to 32 tools, each `{name ([A-Za-z][A-Za-z0-9_-]{0,63}), description (1–1,000 characters), input_schema,
kind (read | change), moves_money (a change only)}`, 30 KB together; the schema is the SDKs' subset (`type`,
`properties`, `required`, `items`, `enum`, `additionalProperties`, `minLength`, `maxLength`, `minimum`, `maximum`,
`minItems`, `maxItems`, `description`, `title`, `default`; no `$ref`, `$id` or `$schema`), an object at the top, 8 KiB
and six levels at most. Up to 16 apps. The request takes the SDKs' own bounds (2,048 values, 12 levels, 32 KiB).
Credentials DGC knows in the address or tools are refused (`secret_detected`).

- **The secret.** `register_app` makes 32 random bytes, `dgcapp_` and 64 hex digits, and answers it once with the
  app (`{app, secret, notice}`); `rotate_app_secret` makes a new one, answered once, and the old one stops working.
  DGC keeps its copy with `plugin_credentials` under the entry `_pipapp.<name>` (the system keychain, or
  `~/.dgc/plugin-auth/_pipapp.<name>/credentials.json`, 0600), never in the Pips database, the apps file, a note, a
  log, a Pip's prompt or a run record; `remove_app` forgets it.
- **Digests.** `connection_digest` = SHA-256 of `{schema_version: 1, kind: "sdk_app", name, url}`; a tool's
  `schema_digest` = SHA-256 of `{name, description, input_schema, kind, moves_money}` (canonical JSON). A review,
  an app plan or an Always allow pinned to an earlier address or tool stops matching.
- **Changing it.** `update_app {name, tools, url?}`: a pure removal applies at once and clears any pending update;
  anything else (a new tool, a changed one, a new address) is saved as the app's `pending` `{digest, url, url_changed,
  adds, changes, removes, summary, tools, created_at}`, and nothing changes until `accept_app_update {name,
  expected_digest}`. A newer `update_app` replaces a pending one.
- **Where it shows.** `list_pip_connections` has a row `app:<name>` in the connectors' shape (`provider` is its name,
  "Shop app"; `pip_read_adapter` when it has reads, `pip_action_adapter` when it has changes);
  `inspect_pip_connection` lists every tool with its `kind`, `moves_money` and `schema_digest`;
  `inspect_pip_connector_actions` lists its change tools; `list_pip_accounts` refuses it (the app manages its own).
  Activity records `pip_app_registered`, `pip_app_updated`, `pip_app_update_waiting`, `pip_app_removed` and
  `pip_app_secret_rotated` with names and counts only.
- **Reads.** An `app_plan` on `app:<name>` is version 1, `{schema_version: 1, server, connection_digest, calls: [{tool,
  schema_digest, arguments}]}`, one to four calls, arguments 4 KiB each. `propose_pip_update` checks it against the app
  as it is now (each call a read, its schema current, its arguments fitting); before each run DGC checks again and
  makes each read, and the run gets `{server, tool, text, untrusted: true}`, or `{server, tool, error, untrusted:
  true}` when the app failed (the run goes on and says so). A plan that no longer matches stops the run, as a changed
  connector's does. In its runs a Personal Pip also has each tool as a function, `<app>__<tool>` (64 characters at
  most), over the run's socket, while their definitions fit 32 KiB: a read answers at once, at every level, as
  untrusted data; a change becomes the reply's connector draft (`pip_plugins.offer`), one per reply, and
  `app_answer` reads what the app answered to the change the user last allowed (half an hour). Careful mode counts
  them as plugins (its lane, and what a read brings in).
- **Changes** are `connector_call` actions with `server` `app:<name>` and `account` `connection_managed`, proposed
  with `propose_pip_connector_action` or prepared from a connector draft, accepted once with `accept_pip_app_action`
  (or `always_allow_pip_app_action`; grants and levels as for any connector call). A read tool is refused there
  (`unsupported_app_action`).
- **The call.** `POST <url>` with `Content-Type: application/json`, `X-DGC-Timestamp` (Unix seconds), `X-DGC-Nonce`
  (32 hex digits) and `X-DGC-Signature` (`v1=` + hex HMAC-SHA256, keyed by the secret's UTF-8 text, of
  `<timestamp>.<nonce>.` + the body). The body is `{type: "tool_call", app, tool, arguments, pip_id, run_id, call_id}`,
  and for a change also `action_id` and `action_digest` (the accepted action's id and digest; `run_id` is the run
  that proposed it). 15 seconds for a read and 30 for a change, the answer read up to 256 KB; TLS verified; a redirect
  is never followed; no proxy for `localhost`, `127.0.0.1` or `::1`. The answer must be JSON `{ok: true, result}`;
  `{ok: false, error: {code, message}}` is the app's refusal. The text the Pip gets is the result as JSON, cleaned of
  credentials (the app's own secret too) and cut at 32 KiB.
- **Failures, in the run's words:** "the shop app didn't answer", "the shop app didn't answer in 15 seconds", "the shop
  app said: …", "the shop app's answer wasn't JSON", "the shop app's answer was over 256 KB", "the shop app answered
  with a redirect, which DGC doesn't follow", "the shop app's certificate couldn't be checked, so DGC didn't send the
  call", "the shop app answered with an error (HTTP 503)".

**Approvals in your app** (`pip_sdk_app_approvals`, Pips API 62). When a change on `app:<name>` waits for a person,
the app hears about it at its `url`, signed exactly as a tool call is, and can decide it; DGC's own card shows it too,
and whichever answers first wins, once.

- **What waits.** After a Personal Pip's run, once its Always allow grants and its level have had their say
  (`_run_granted_actions`), each connector draft on `app:<name>` still pending becomes a review DGC opens for the
  app: a `connector_call` action requested by `pip-app-review` with request key `draft_<draft id>`, tied to that
  draft (its Allow card). `pip-app-review` only proposes; it can never accept or reject (`local_only`). A review
  proposed with `propose_pip_connector_action` (or prepared from a draft by the user) waits too. Attention, the
  pending count and archiving count the draft, not its review again. Expiry is the action's 24 hours.
- **The events.** `{type: "approval_requested", app, action_id, action_digest, tool, arguments, pip_id, pip_name,
  run_id, summary, expires_at, moves_money}` when a review on the app opens, except one opened by a grant or a level
  (those are accepted at once); `{type: "approval_resolved", app, action_id, tool, decision, by, at}` when any action
  on the app closes, wherever: `decision` `accepted` (pending → dispatching), `rejected` or `expired`; `by` `app`
  (`resolved_by` `app:<name>`), `always_allow` (`pip-grant:…`), `level` (`pip-level:…`) or `dgc` (anything else,
  the expiry included). `summary` is "<Pip> asks to run <tool> (<first arguments>) in <App>." (300 characters at
  most); `moves_money` is the tool's mark, or true when DGC can't find the tool.
- **Delivery.** Each event is written to the Pips database's `metadata` (`pipapp_outbox:<action_id>:<requested |
  resolved>`), in the transaction that opens or closes the review, once per action and kind. The supervisor
  (`dgc pips serve`), each heartbeat, closes app actions past their expiry (so `expired` is heard) and, when something
  is due, sends on a thread of its own: each event claimed for 60 seconds, so two senders never send one at once;
  10 seconds a try; a first try, then up to three more 5 s, 30 s and 2 min after a failure. 2xx is delivered; 408,
  429, 5xx, a timeout or no answer is tried again; any other 4xx, a redirect or a certificate DGC can't check is
  final. Finished events move to `pipapp_sent:…` with `status` `delivered`, `failed` (with its words: "the shop app
  didn't answer (4 tries)", "the shop app refused it (HTTP 400)") or `skipped` (an `approval_requested` whose review
  closed before it was sent). Each try is `{at, outcome}`. `get_pip_app_action` of an app action carries
  `app_deliveries: [{type, status, tries, delivered_at, error, created_at}]`. A delivery never blocks, delays or
  rejects the action. A sender that dies mid-send can send an event again after its claim lapses: apps treat
  `(action_id, type)` as one event.
- **Deciding in the app.** `decide_app_approval {action_id, decision: "accept" | "reject", expected_digest}` (local
  only) is `accept_pip_app_action` / `reject_pip_app_action` with `resolved_by` `app:<name>`: the same checks
  (`_current`, the app's tool and schema, the money floor's attempt-once ledger). It answers `{approval, decided}`;
  an action already dispatching, succeeded, unknown, rejected or expired answers `decided: false` with that state and
  runs nothing. A wrong digest is `action_conflict`; an action not on an app is `not_an_app_action`. An accepted
  one is POSTed (`tool_call`) before the answer, and the Pip carries on as after a plugin action (`app_answer`).
  `list_app_approvals {app?}` (local only) lists pending, unexpired app actions, oldest first, at most 100: `action_id`,
  `action_digest`, `app`, `tool`, `arguments`, `pip_id`, `pip_name`, `run_id`, `summary`, `created_at`, `expires_at`,
  `moves_money`, `status`, `decision`, `by`, `decided_at`, `receipt`, `deliveries`.
- **The card and the review are one.** `prepare_pip_connector_draft` on a draft with an open review takes that review
  (the draft becomes `prepared` with it) when the call is the same, or when the review is already closed; with an
  edited call it rejects the review first (`by` `dgc`) and proposes the edited one. `dismiss_pip_connector_draft`
  rejects an open review. Closing the review any other way (the app, the expiry, `accept`/`reject_pip_app_action`)
  prepares its draft with it, in the same transaction. A refusal names the app's decision: "Shop app already accepted
  this: it ran once.", "Shop app declined this.", "This expired without an answer."
- **The money floor** is unchanged: a tool marked `moves_money` gets no Always allow and no level, so it always waits,
  and both the card and `approval_requested` say so.

**Events from your app** (`pip_sdk_app_events`, Pips API 63). Your app's own events start a Personal Pip's routine:
a third kind of "when" beside a schedule and a Gmail or Calendar event.

- **The routine.** Its `trigger` is `{kind: "app", app, event}` (`{app, event}` is read as that): `app` a registered
  app's name (refused `app_not_registered` otherwise, in `add_pip_routine`, a changed `trigger` in
  `update_pip_routine`, and when a suggestion is saved, where one for an app removed meanwhile is dropped and the reply
  kept), `event` `[a-z0-9_.-]{1,64}`. Its `label` is "when the shop app sends order.created"; its `next_due_at` is
  null until an event comes. The chat's `add_routine` offers it only when the run's pin names the user's own apps, and
  refuses an app that isn't one of them; its card waits for **Add routine** as any suggestion does. `list_pip_routines`
  lists routines of this kind only with `app_events: true` (an older editor refuses an unknown `trigger.kind`, and with
  it the whole list).
- **The event.** `trigger_app_event {app, event, payload?, idempotency_key}` (local only; no approval: it runs only
  routines a person added, and grants nothing). `payload` is plain JSON of at most 32 KB compact (16 levels, 4,096
  values, safe numbers), bounded on its own outside the request's 16 KiB budget (`pip_computer_files.bulk_fields`);
  `idempotency_key` is 1 to 200 characters on one line. In one transaction: an event already kept for `(app,
  idempotency_key)` answers its first answer with `repeat: true` and does nothing; otherwise more than 60 kept for the
  app in the last minute refuses it (`rate_limited`, nothing kept or queued); events older than 30 days are forgotten
  (500 at a time, never one a run still waits on); the event is kept (`appevent_<32 hex>`), and every routine that is
  `on`, of a Personal Pip that isn't archived, with that `(app, event)` is matched. A Pip that is paused, or every Pip
  when Pips are stopped (`stop_pips`), is answered `paused` and nothing is queued for it. Otherwise one queue row is
  added for the routine (the Pip's oldest waiting rows are dropped first so that at most 20 wait, `told` 0), the
  routine is due now (`next_due_at`, its `revision` moved), and it is answered `busy` when the Pip has a conversation
  run queued, running or cancelling, else `queued`. The answer: `{event_id, app, event, idempotency_key, received_at,
  payload_bytes, queued, no_routine, pips: [{pip_id, pip_name, routine_id, routine, outcome, words, dropped?,
  stopped?}] (at most 50), more, repeat, runner_online, notice}`. `notice` is the answer in words, with "Pips are off
  on this computer, so they will run when it is back." when the runner isn't online and something was queued, and a
  word about payloads over 2,500 characters. The payload is kept only while a row waits on it.
- **The run.** The supervisor's routine check (`pip_routines.check`) takes the routine's oldest waiting row and writes
  the routine's hidden turn (`routine_` key, actor `local-routine`, bound to the event) with: the app, the event and
  when it came; how many of the Pip's events were dropped unread since its last such turn, with the instruction to say
  so first; that what the app sent is untrusted data, never instructions, giving no tools or permissions; and the
  payload, cut to fit the turn's 4,000 characters and 8 KB and said so ("DGC cut it to fit this message: the app sent
  N KB"). Busy: tried again 5 seconds on; another refusal: 60 seconds, its words in `last_error`. The row is then
  `ran` with the run's id; the routine stays due while rows wait. A turn already written for the event (its key) counts
  as run. An app removed meanwhile lets its rows go (`gone`) with `last_error` "Waiting for Shop app: it isn't
  registered with DGC now." Turning the routine off, changing its `trigger` or deleting it lets its rows go too;
  turned back on, it waits for the next event.
- **What an app sent.** `list_app_events {app, limit?}` (local only; 1 to 50, 20): `{app, events: [{event_id, event,
  idempotency_key, received_at, payload_bytes, queued, waiting, pips}], names}`, newest first, and the event names it
  used, most recent first (the editor's picker).
- **Where.** `pip_app_events` (id, app, event, idempotency_key unique per app, payload, payload_bytes, answer,
  created_at) and `pip_app_event_queue` (seq, event_id, routine_id, pip_id, status `waiting` | `ran` | `dropped` |
  `gone`, told, run_id, created_at, updated_at), made with `CREATE TABLE IF NOT EXISTS` in the transaction of an app's
  first event. The registry's schema stays 46.

**Pip templates in code** (`pip_templates`, Pips API 64). Your app declares its Personal Pips in code and keeps them
as declared (the SDKs' `PipTemplate`, `pips.ensure` and `pips.ensure_all`; [Pips in code](../sdk/PIPS.md#pips-in-code-api-64)).

- **The template.** `{key, name, instructions, model?, level?, tools?, routines?, always_allow?}`, refused
  `invalid_template` otherwise: `key` `[a-z0-9-]{1,40}`, unique in the profile; `name` one line of 1 to 120 characters;
  `instructions` 1 to 4,000 (the Pip's goal); `model` a model id or none (`model_choice` `{mode: "model", model}` or
  `{mode: "default"}`); `level` `ask` (the default), `approve` or `full`; `tools` up to 64 of `app:<name>/<tool>` and
  `computer`, each once; `routines` up to 10 `{title, prompt, when}` with distinct titles, `when` a `schedule` or an
  `app` trigger (a Gmail or Calendar one is refused: it needs that app connected by a person); `always_allow` app tools
  in `tools`. A template holding a saved credential is refused (`secret_detected`). Requests carry 32 KiB.
- **Ensure.** `ensure_pip_template {template, accept_widening?, overwrite_user_changes?}` (local only). The model is
  checked before the transaction when it would be kept: offered by the model connection (`model_not_available`), and,
  when the supervisor record says the runner runs with `--server`, DGC's default not a personal plan
  (`server_subscription`). Then, in one transaction: no Pip has the key, so one is made in the Personal workspace
  (`pip_type` `rook`, a computer only with `computer`), at the template's level, with its routines on (one on an
  unregistered app is left out and said) and its available app tools; its Always allow waits. Otherwise each field is
  compared with what the last ensure applied and with the Pip now. A field the Pip has differently from what was
  applied was changed by a person: it is kept and reported (`conflicts`), unless `overwrite_user_changes`. Else it is
  brought to the template: name, instructions and model as a new job version (actor the caller, reason "From your code
  (template KEY)", older reviews superseded as an accept does); a lower level; a removed app tool, computer, routine (by
  title) or Always allow (the template's own grant revoked); a routine's title, prompt or schedule; a new schedule
  routine; a new read tool. Widening is one change in `pip_template_changes` (`tmplchange_<32 hex>`, `waiting`): a new
  change tool (pinned to its `schema_digest`), `computer`, a higher level, a new Always allow (pinned to the tool's
  `connection_digest` and `schema_digest`; refused `asks_every_time` for a tool that moves money, `invalid_template` for
  a read), and a routine whose `when` becomes an app event or is turned back on with one. Its digest covers the Pip,
  the key and the items: the same widening keeps the waiting change, another replaces it (`withdrawn`), none withdraws
  it, and one a person `declined` is not proposed again. `accept_widening` applies the items in the same transaction.
  A Pip that is archived changes nothing (a conflict says so); one that is paused stays paused unless the template
  paused it (prune), which ensure undoes. Answers `{pip_id, key, name, created, applied, waiting, declined, unchanged,
  conflicts, unavailable, notice}`.
- **What a template Pip may use.** `allowed_tools` reads the applied `tools`: a run's app tools (`pip_sdk_apps.pin`) are
  only those, and a call to another app tool answers that it isn't one of the Pip's tools, before the app is called. A
  Pip with no template record keeps every registered app. An app tool that no longer exists is kept in the record and
  said in `unavailable`; it is not given to runs while it is missing.
- **Decide.** `decide_pip_template_change {change_id, decision accept | reject, expected_digest}` (local only): a change
  that isn't `waiting` answers `decided: false`; a wrong digest is `template_conflict`; an item whose tool changed since
  is `template_changed` (ensure again). Accept applies every item in one transaction (an Always allow is a grant of kind
  `connector_call`, account `connection_managed`, `from_template` its key), the change `accepted`; reject makes it
  `declined`. Both record `decided_at` and `decided_by`.
- **Prune.** `prune_pip_templates {keep}` (local only, up to 100 keys) pauses each active template Pip whose key isn't in
  `keep` (`pruned`), never deletes one, and leaves alone one already paused or archived (`already`).
- **Reading.** `list_pip_templates {pip_id?}`: `{templates: [{key, pip_id, name, status, pruned, level, tools,
  always_allow, routines, created_at, updated_at, waiting, declined}]}`, each change with its items' `words`.
- **Where.** `pip_templates` (pip_id, key unique, applied: the last-applied name, instructions, model, level, tools,
  Always allow grant ids, routine ids by title and status; pruned, created_at, updated_at) and `pip_template_changes`
  (id, pip_id, key, items, digest, status `waiting` | `accepted` | `declined` | `withdrawn`, created_at, decided_at,
  decided_by), made with `CREATE TABLE IF NOT EXISTS` in the transaction of the first ensure. The registry's schema
  stays 46.

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

**Borrowing the user's own Chrome** (`pip_borrow`, Pips API 59, Personal Pips only). A card is metadata
`pip_borrow:<pip>:<id>` = `{id: pipborrow_HEX32, pip_id, workspace_id, run_id, sites, why, status, unattended,
unreachable, created_at, expires_at, allowed_at?, decided_at?, decided_by?, use_run_id?, claimed_at?, started_at?,
chrome?, ended?, ended_at?, sent?}` (no registry schema change; the newest 20 per Pip are kept). `sites` are origins as
Chrome spells them (`permissions._canonical`: scheme, IDNA host without a trailing dot, port unless the default; a
bare host is `https`, unless the user wrote that host and port with `http://` (and never `https://`) in one of their own
last 20 messages to the Pip; a backslash, user name, `%`-escape, space or control character is no site), 1 to 4; a site the
user's own rules deny for Work's signed-in Chrome (`Browser(signed-in:…)`, `Browser(signed-in:*)`, a site or path deny)
never reaches a card. `why` is one line of up to 200 characters, never a card number, redacted of saved secrets.

- **Asking.** Every `conversation` run of a Personal Pip has `borrow_chrome {sites, why}` on its app socket. It writes
  a `requested` card (expiring after a day; an older `requested` card of the Pip becomes `replaced`), notes whether
  the user's Chrome is reachable now (`unreachable`: `browser_user.find_route`'s reason in the user's words, read from
  DevToolsActivePort and a plain connection to its port, which Chrome asks nothing for), and tells the Pip a card is
  below its reply. In an unattended run (`local-routine`, `local-scheduler`, `local-event-trigger`) the card is
  `unattended` and the Pip is told it waits for the user.
- **Answering** (all three local only, in the editor's `dgc serve` or the CLI). `allow_pip_borrow {pip_id,
  borrow_id}` needs `requested`, checks `find_route` again (else `chrome_unreachable` with the reason; the card stays),
  sets `allowed` and queues the Pip's next turn under `pip_chat.BORROW_KEY + id` (`borrow_<id>`, a key only DGC writes:
  `send_pip_message` refuses it); a failed queue (the Pip busy) puts the card back. `decline_pip_borrow` sets
  `declined` and queues a turn under `borrow_no_<id>` telling the Pip it may not use it for that, and that the next
  thing needing the user's Chrome is asked for anew. `stop_pip_borrow` sets an
  `allowed` or `in_use` card `returned` with `ended: "stop"`. There is no Always allow.
- **Claiming.** As a `conversation` run starts, the runner reads its user message's request key; for `borrow_<id>`
  it moves that card from `allowed` to `in_use` with `use_run_id` (in one transaction, within 30 minutes of the
  Allow); any other run, or a second claim, gets nothing (`{missed: "used" | "expired" | "stopped"}` is told to the
  worker). Only that run's app socket pin has `borrow {id, sites, minutes}`, and only it offers `borrowed_chrome`.
- **The tab.** The runner connects at once (`browser_user.find_route`, `wsl` relay on WSL; Chrome's own "Allow
  remote debugging?" holds the upgrade; 403 is `chrome_no`, no answer in 90 s `no_answer`, nothing there
  `unreachable`), creates a target `{url: "about:blank", newWindow: true}`, attaches to it (flatten), enables
  Page, Runtime, Log and Network, then `Fetch.enable` on every request (`urlPattern: "*"`, request stage),
  `Network.setBlockedURLs` for `ws://*` and `wss://*`, and `Target.setAutoAttach` (paused, flatten) so its frames from
  other sites and its workers are gated the same way before they run. Only DGC's session and its children are read;
  `Target.getTargets` is called only after its page opened a tab (`Page.windowOpen`), to close the tabs whose opener
  chain leads to DGC's, and no field of any other tab is used. A link or form the Pip clicks that targets a new tab is
  set to `_self` first.
- **The gate**, for each paused request: the tab's own page (a `Document` in the top frame, each redirect hop) to an
  origin not on the card, or one the user's rules deny, fails with `Aborted` (Chrome commits no error page; the tab
  stays where it was); a read (`GET`, `HEAD`, `OPTIONS`) or telemetry continues; a page's own background request or an
  inner frame's form, with no step of the Pip's in the last 5 s (`ACTION_SECONDS`; a new top-level page resets it),
  continues; anything else is the Pip's: to an origin not on the card it fails, else `pip_levels.classify` and
  `decide_write` decide with the Pip's level: a `payment` verdict (a card number, payment words or fields) fails at
  every level, `None` (what its level asks about; everything at `ask`) fails, and what the level lets through
  continues and is listed in the card's `sent`. The Pip is told each refusal in its step's answer.
- **The tool.** `borrowed_chrome {op: open | read | find | wait | click | type | choose | press | back | done, url?, ref?,
  text?, option?, key?, seconds?}`: ops in any case or spacing; only `open` carries an address, which must be on the
  card and not denied; everything is read through `tools._browser_operation` with a guard that judges each read by
  the address it read (the card's origins, the user's deny rules). `click`, `type`, `choose` and `press` are refused on
  a page an ask or deny rule of the user's covers (`Browser(signed-in:…)` with `_page`). `type` refuses a card number,
  a box that is a password, code or card field (by type, `autocomplete`, name, id, label or placeholder), and, in
  careful mode, text carried from what the Pip read in the user's apps (what it read on the borrowed sites may go
  back there). Every answer is redacted of saved secrets and saved logins, and a card number written on a page is
  replaced by "•••• (a card number, hidden)"; what it read is added to careful mode's record for the Pip. An ordinary
  error keeps the tab; a lost connection or tab ends the borrow (`lost`).
- **Giving it back.** `done`, the run's end (`RunSocket.close`), the run no longer running, `stop_pip_borrow` (seen
  within 0.5 s, a step in flight unwinding within a second) or `BORROW_SECONDS` (600) after it was lent: the runner
  closes the tabs DGC's page opened, then DGC's tab (`Target.closeTarget`), drops the connection, and writes `returned`
  with `ended` (`done`, `run_end`, `stop`, `timeout`, `chrome_no`, `no_answer`, `unreachable`, `lost`, `error`).
  `list_pip_borrows` shows an `in_use` card whose run is over as `returned` (`run_end`), and an `allowed` card no run
  claimed within 30 minutes, or a `requested` one past `expires_at`, as `expired`.

`list_pip_borrows {pip_id}` answers `{pip_id, minutes, borrows: [{id, pip_id, workspace_id, status, sites (as shown),
origins, why, reachable, unreachable, unattended, minutes, chrome, ended, sent, created_at, expires_at, allowed_at,
started_at, ended_at}]}`, newest first; the other three answer `{borrow: …}` (and `decline_pip_borrow` may add
`continue_error`). Events: `pip_borrow_requested`, `pip_borrow_allowed`, `pip_borrow_declined`, `pip_borrow_started`,
`pip_borrow_stopped`, `pip_borrow_returned`.

**Personal handoffs** share an exact excerpt (up to 12,000 bytes) of a completed
Personal task result with a different Personal Pip, with a task of up to 4,000
bytes. The target keeps its own app and web plans; no history, tools or grants are
passed on. Personal Pips can't hand off to project Pips.

## Limits and sizes

| Item | Limit |
| --- | --- |
| Concurrent runs per runner | `pips_parallel_runs` (default 4, 1–32); one per Pip |
| Queued, running and cancelling runs | 20 |
| Run wall time | none |
| Model turns per run | none |
| Tool calls per run | none |
| Output tokens per model response | DGC's `max_tokens` |
| Specialist calls of a reviewed Patch | the reviewed `max_calls` (1–3); they share the run's lifetime, policy version 2 (version 1: 300 s, 12 requests, 64 tool calls, 4,096 tokens) |
| Reviewed commands of a run | 300 seconds from when they start |
| Worker input | 128 KiB |
| Source copy (`safe_source_v2`) | 256 MiB and 10,000 copied files and folders; files over 4 MiB are left out and listed; 100,000 entries looked at |
| Source copy (`safe_source_v1`) | 10,000 entries, 4 MiB per file, 64 MiB total; any file over the limit fails the run |
| Ignore files read | 256 KiB each, 2 MiB and 2,000 files in all |
| Left-out record | 6 KiB |
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
| Your app's events (API 63) | 60 a minute per app; payload 32 KB of JSON; 20 waiting per Pip; an idempotency key kept 30 days |
| Pip templates (API 64) | A key 1 to 40 characters; 64 tools and 10 routines a template; a request 32 KiB; one change waiting per Pip; 100 keys a prune |

## Main-chat tools

The main chat carries one small tool, `use_pips`, instead of the Pips tools on every
request. Calling it loads the other twelve tools below and their guidance for the
rest of the chat. A message that references a Pip with `@`, or a setup-approval
notice, loads them automatically. A new or resumed chat starts without them.

| Tool | Permission | Default mode | Does |
| --- | --- | --- | --- |
| `use_pips` | `UsePips` | Allowed | Loads the Pips tools |
| `pips_context` | `PipsContext` | Allowed | Reads Pips data (below) |
| `pips_setup` | `PipsSetup` | Allowed: outside auto mode it only saves a card the editor docks above the chat box, whose **Create Pip** is the approval | In auto mode (or on an allow rule, or your Allow on an ask rule) creates or updates the Pip; one with app reads or Pulse commands is always a card |
| `pips_propose` | `PipsPropose` | Asks | Applies a change to a project Pip's name, goal, source ref or Excluded folders (`source_exclude`, which moves it to `safe_source_v2`) |
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
| Runner | `enable`, `serve [--enable] [--server]`, `status`, `health [--json]`, `stop [--yes]`, `resume`, `execution` |
| Linux service | `service preview\|install [--server]`, `service status\|start\|stop\|enable\|disable\|uninstall` |
| Workspaces | `workspaces`, `workspace show\|sessions\|backfill\|rebind\|migrate-session`, `activity` |
| Pips | `types`, `models`, `list`, `create`, `show`, `pause`, `resume-job`, `archive`, `restore`, `starters`, `starter` |
| Digest | `digest [--keep]`, `notify PIP [--min-severity] [--alerts]`, `outcomes PIP` |
| Setup cards | `setup list\|show\|accept\|reject` |
| Changes | `propose`, `schedule`, `trigger`, `verification-plan`, `adaptation`, `adaptations`, `accept`, `reject`, `approvals`, `versions` |
| Runs | `run`, `runs`, `report`, `source`, `cancel`, `checkpoints`, `review-finding`, `review-execution`, `export-run` |
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
| 43 | A Pip's own apps (`connect_app`, `read_app`; `list_pip_app_links`, `start_pip_app_link`, `check_pip_app_link`, `decline_pip_app_link`, `disconnect_pip_app_link`); Simple Pips: `introduce_pip`; a Personal Pip with only a name; Core as the Primary Pip; `intro` on chat messages; images and files in a Personal Pip's chat (`send_pip_message` `images` and `files`, `get_pip_message_image`); a computer's Files and Terminal (`list_pip_computer_files`, `read_pip_computer_file`, `add_pip_computer_file`, `remove_pip_computer_file`, `run_pip_computer_command`, `list_pip_computer_terminal`), and the computer in a Pip's chat |
| 44 | A Pip's plugins (`use_plugin`, `plugin_tools`, `call_plugin`; `list_pip_plugins`, `allow_pip_plugin`, `decline_pip_plugin`, `list_pip_plugin_uses`); a plugin action is a connector draft on the plugin's server; payment plugins refuse Always allow; Needs attention (`list_pip_attention`); what a Pip remembers (`remember`; `list_pip_notes`, `add_pip_note`, `forget_pip_note`; schema 44); careful mode (`list_pip_sites`, `set_pip_careful`, `forget_pip_site`) |
| 45 | Every plugin turned on is every Pip's (no `use_plugin`, no card); `set_plugin_permission` and each plugin's level (`always_ask`, `any_changes`, `important`, `never_ask`); `web_search` on the app socket; careful mode's `Lane` for unattended runs |
| 49 | Additive, nothing to gate on: `list_pip_runs` rows carry a failed run's `error`; `get_pip_execution` has `local_http_checks` and, when DGC knows the one-time fix, `fix` (`dgc pips execution --fix`); a Pulse setup card's `runner_notice` says when it can't run on this computer |
| 50 | The `safe_source_v2` source rules (files DGC can't copy are left out and listed, `.dgcignore`, the project's ignore files for current files, a Pip's Excluded folders in `source_policy.exclude`, 256 MiB); `check_pip_source` and `get_pip_run_source`; new reviewer and Quill Pips start on `safe_source_v2` |
| 51 | A finished run posts its result in its Pip's own chat (`list_pip_run_posts {pip_id, before_id?, limit?}`, a read); the conversation context's `run_posts`; `get_pip` has `report_session` |
| 53 | A Pip's eyes and cursor (`pip_eyes`): a run whose model sees gets `look` and the position operations (`click_at`, `double_click_at`, `right_click_at`, `hover_at`, `drag`, `scroll_at`), screenshots with password and card fields blacked out, and `upload`; a text-only Pip says so in one line with a three-choice card, or a model that sees looks for it (relay); `get_pip_eyes`, `set_pip_eyes`; `list_pip_computer_frames` takes `pointers`; `use_pip_computer_view` takes op `pointer` and its frames carry `pointer`; a payment held in a Pip's browser never gets Always allow |
| 56 | Saved logins (`pip_logins`): `list_pip_logins`, `save_pip_login`, `remove_pip_login`, `grant_pip_login`; the `computer` tool's `sign_in`, with DGC typing the saved username, password and one-time code (`pip_totp`) and letting that one submit through; a computer action of kind `login` (the card to save one) |
| 61 | Your own app's tools (`pip_sdk_apps`): `register_app`, `update_app`, `accept_app_update`, `list_apps`, `remove_app`, `rotate_app_secret` (local only); the connection `app:<name>` in `list_pip_connections`, `inspect_pip_connection` and `inspect_pip_connector_actions`; version-1 `app_plan`s on it; `connector_call` actions on it, sent as one signed POST; `<app>__<tool>` functions and `app_answer` in a Personal Pip's runs (see Your own app's tools, under Personal Pips) |
| 62 | Approvals in your app (`pip_sdk_app_approvals`): `approval_requested` and `approval_resolved`, POSTed signed to the app's `url` by the supervisor and recorded on the action (`app_deliveries`); `list_app_approvals` and `decide_app_approval` (local only); the review `pip-app-review` opens for a Pip's change on `app:<name>`, tied to its connector draft (see Approvals in your app, under Personal Pips) |
| 64 | Pip templates in code (`pip_templates`): `ensure_pip_template`, `prune_pip_templates`, `list_pip_templates` and `decide_pip_template_change` (local only); a Pip made from a template is given only the app tools its template lists (see Pip templates in code, under Personal Pips) |
| 63 | Events from your app (`pip_sdk_app_events`): a routine's `trigger` `{kind: "app", app, event}`; `trigger_app_event` (no approval) and `list_app_events` (local only); `app_events` on `list_pip_routines`; the `add_routine` tool's app kind (see Events from your app, under Personal Pips) |
| 60 | A live-data Pip: a project Pulse's `live_plan` (`changes.live_plan`, a setup card's `work_kind` `live_data`), run kind `live`, `result.live`, run posts of kind `live` and report cards with outcomes `live_clear` and `live_attention`, `live_plan` on `get_pip` and `list_pips` (see [Live-data commands](#live-data-commands)) |
| 59 | Borrowing the user's own signed-in Chrome (`pip_borrow`): `borrow_chrome` and `borrowed_chrome`; `list_pip_borrows`, `allow_pip_borrow` (Allow once), `decline_pip_borrow` (Not now), `stop_pip_borrow`, all local only; the reserved chat keys `borrow_` and `borrow_no_`; no Always allow |
| 58 | How much a Personal Pip asks (`pip_levels`): `get_pip_level`, `set_pip_level` (`ask`, `approve`, `full`); what a level lets through is a computer action already `sent` by `pip-level:<level>` or an app action resolved by it; a pending hold's `asks_because`; the safety floor's computer action of kind `floor`; sites written out in an attached document count as named by the user |
| 57 | Memory that learns, for Pips: a Personal Pip's own working notes (`pip_working_notes`: the `working_notes` tool, `get_pip_working_notes`, `set_pip_working_notes`), its daily log (`pip_daily_log`: `list_pip_daily_log`), and its chat looked back over for the user's one memory (`pip_memory_review`) |
| 54 | Pips use the whole desktop (`pip_desktop_eyes`, `pip_apps`): a run whose model sees gets `desktop_look`, `desktop_click`, `desktop_double_click`, `desktop_right_click`, `desktop_hover`, `desktop_drag`, `desktop_scroll`, `desktop_type`, `desktop_key`, `windows`, `focus_window` and `launch_app`, with secrets blacked out of the whole screen; an image editor, a document editor and a PDF viewer, each in its own box, online through the computer's egress proxy like the Terminal; `get_pip_computer_apps`, `set_pip_computer_apps` |
| 52 | Photos and files in a Pip's chat through the backend's spool: `send_pip_message` takes `spooled_images` (8 MiB a photo, 32 MiB in all, up to 64; HEIC kept as JPEG) and `spooled_files` (a document 16 MiB, text 1 MiB, 32 MiB in all, up to 16), local only; `get_pip_message_image` takes `as_file` and answers with the kept file's `path`. A large photo goes to the model at 2,500 pixels |
