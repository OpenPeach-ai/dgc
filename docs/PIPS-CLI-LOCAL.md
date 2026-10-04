# Local Pips command workflow

This is the manual, read-only MVP. It runs on the computer without Remote, an
account, an editor or a cloud scheduler. Use the lab launcher below, not an
installed public DGC command. All examples should run from the project directory.
The launcher selects this isolated checkout and its isolated configuration.

```sh
alias dgc-lab=/home/fungigb10/dgc-pips-lab-20261001/dgc-local
dgc-lab pips enable
dgc-lab pips create "Source auditor" --goal "Inspect committed source for correctness risks"
dgc-lab pips list
```

The create result includes a `pip_…` identity. The current directory resolves to a
stable local workspace identity. `pips workspaces` lists registered workspaces;
`--workspace ID` explicitly selects one for create, list, activity and context
commands. Explicit job/run IDs can address other local workspaces on this runner.
No filesystem path, provider URL or permission policy is accepted in a job.

Open a second terminal and keep its supervisor running:

```sh
dgc-lab pips serve
```

Back in the first terminal:

```sh
dgc-lab pips run PIP_ID
dgc-lab pips runs PIP_ID
dgc-lab pips report RUN_ID
dgc-lab pips cancel RUN_ID
```

`run` checks both a fresh running heartbeat and the supervisor's held OS lease.
It refuses before queueing if the supervisor is offline, stopped or cannot be
checked. It enqueues through `handle_control(..., start_worker=False)`; a short
CLI invocation never starts a daemon thread and abandons it on exit. If the
supervisor stops just after that check, a successfully accepted run remains
visibly queued for the next explicit supervisor start. There is no automatic
retry, transient worker, hidden service or `--wait` mode in this version.

For a deliberate request retry, pass the same `--idempotency-key KEY`. Each normal
`run` generates a new key. Queueing is not a claim that the model is reachable or
the audit succeeded. Read `report RUN_ID` to distinguish queued, running,
cancelled, failed and succeeded.

The selected source ref defaults to `HEAD` and is resolved to a committed Git
revision when enqueued. Dirty/untracked changes are excluded. Existing local
native-model configuration is pinned into the private run manifest; public
output does not expose provider routes or credentials. Codex/Claude delegated
routes are not supported for this native audit. Workers use the real DGC Agent
with read-only tools and bounded work. Findings are model assessments with source
excerpts checked; tests are not executed. Windows execution remains refused by
the current worker boundary.

## Review changes explicitly

```sh
dgc-lab pips show PIP_ID
dgc-lab pips propose PIP_ID --goal "Inspect authorization checks" --expected-version 1 --reason "Narrow the review"
dgc-lab pips show PIP_ID
dgc-lab pips accept PIP_ID PROPOSAL_ID --expected-version 1
dgc-lab pips versions PIP_ID
```

`propose` records a pending proposal; it does not update the job. Read its full
definition with `show` before choosing `accept` or `reject`. Both commands require
the expected current version. Stale review decisions fail, rather than applying
to a newer job. `versions --limit N --before-version N` pages immutable history.
Only name, goal and source ref can change. Policy stays `read_only`, trigger stays
`manual`, and this interface cannot introduce schedules or broaden permissions.

`pause PIP_ID` prevents new claims. Cancel an existing run explicitly with
`cancel RUN_ID`. `resume-job PIP_ID` resumes only that job; it does not start a
worker or clear a global emergency stop.

## Workspace context

Workspace identity and saved-session association are also available locally:

```sh
dgc-lab pips workspace show
dgc-lab pips workspace sessions --limit 50
dgc-lab pips workspace backfill            # read-only preview
dgc-lab pips workspace backfill --apply    # revalidate and associate
```

`show` and `sessions` accept `--workspace ID`. `sessions` and `backfill` return
an `--after` cursor when another page remains. Backfill is scoped to the current
canonical root, refuses ambiguous or unsafe records, bounds its reads and never
rewrites transcripts. Pips-enabled chats now associate during normal save/resume;
Remote is not required. Saved IDs are descriptive copies of private registry
state, never identity grants.

After physically moving a directory, `workspace rebind WORKSPACE_ID NEW_ROOT
--expected-root OLD_ROOT` previews a binding repair; repeat with `--apply` to
save it. Existing old roots, conflicting destinations, stale expected roots and
active Pip work are refused. This retains Pips and identities, but **does not
migrate old transcript files or make them resumable from the new root**. Those
path-changing operations are deliberately local CLI commands, not Remote or
model controls.

```sh
dgc-lab pips context list
dgc-lab pips context record decision --title "Source policy" --content "Review committed source" --expected-revision 0
dgc-lab pips context list
dgc-lab pips context accept-finding RUN_ID 0 --expected-revision 1
dgc-lab pips context archive ENTRY_ID --expected-revision 2
dgc-lab pips activity
```

Context records are explicit reference data, not instructions that override
permissions. Record kinds are decision, milestone, command, risk and exception.
Read the current revision before mutating; a concurrent update requires review
and a retry against the new revision. The finding index is zero-based, matching
the numbered findings in `report`. Accepting a completed finding preserves its
run, commit, job version, model and `model_assessment` provenance. It does not
turn that assessment into a verified fact. Archive removes a record from active
context while retaining its audit record. No run writes findings into context
automatically.

## Lifecycle and output

```sh
dgc-lab pips status
dgc-lab pips stop            # interactive global confirmation
dgc-lab pips stop --yes      # explicit noninteractive global confirmation
dgc-lab pips resume          # local only; leaves individual jobs paused
dgc-lab pips resume-job PIP_ID
dgc-lab pips serve
```

Emergency stop persists independently of an old in-memory configuration and
cancels Pips work only. Resume cannot race past a live supervisor/worker lease.
Ordinary Ctrl+C in the supervisor cancels its owned active worker, leaves queued
work queued, and does not globally pause jobs. See
[PIPS-SUPERVISOR-LOCAL.md](PIPS-SUPERVISOR-LOCAL.md) for failure and shutdown
semantics.

Use `--json` on any command for structured output. `status` retains JSON by
default for existing clients. Errors exit 1 and print to stderr; argument errors
exit 2. Known credentials and terminal control sequences are removed from output.
`dgc-lab pips COMMAND --help` provides command-specific fields before loading
configuration or constructing an Agent. Plain `pips` lists current-workspace jobs.
Classic chat also supports `/pips …`; `/pips serve` directs the user to a separate
terminal so it cannot block the chat. Fullscreen/editor interfaces use their own
local controls.

## Verification

`tests/test_pip_cli.py` uses temporary homes/state and denies network calls. Its
subprocess roundtrip invokes the actual CLI, real foreground supervisor, real
queue/leases, isolated worker process, native Agent and `read_file` tool. Only
the provider response adapter and supervisor wait progression are scripted.
stdin events and completed queue drains drive transitions; there are no sleeps
or speed assertions. Unit coverage checks offline/failed-lease refusal,
idempotency, explicit proposal/context acceptance, revision conflicts,
confirmation, global stop persistence, non-starting resume and redaction. This
does not claim live model/provider validation.
