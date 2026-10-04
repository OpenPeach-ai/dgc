# Local Pips supervisor

This isolated prototype runs existing manual Pips without a chat session or editor.
It supervises `pips.start_queued`; each audit still uses the existing DGC Agent,
committed-source snapshot, read-only tool policy, bounded worker and exclusive
`pips-runner` lease. It introduces no second agent loop or runtime dependency.

From the lab, use its `dgc-local` launcher, which selects only the lab code and
`state/runner-home` configuration:

```sh
/home/fungigb10/dgc-pips-lab-20261001/dgc-local pips serve --enable
```

This command stays in the foreground. `--enable` persists `pips_enabled=true`
through `Config.set`. Subsequent starts can omit `--enable`. No service is
installed, no schedule is created, and starting the supervisor does not create a
job or enqueue a run. An already queued, explicitly requested run can start.

In another terminal:

```sh
/home/fungigb10/dgc-pips-lab-20261001/dgc-local pips status
/home/fungigb10/dgc-pips-lab-20261001/dgc-local pips stop
```

`status` prints JSON: runner identity, supervisor state, heartbeat/start times,
whether global stop is active, and queued/running/cancelling counts. It contains
neither private workspace paths nor a PID. A fresh heartbeat means the supervisor
is running, not that a model is reachable or that a run succeeded. Heartbeats
update every two seconds; an absent, invalid, future or older-than-15-second
heartbeat reports the supervisor offline. Runs can still be executing in another
explicit Remote/controller process, so queue counts remain separate from the
supervisor status.

A controller failure (for example, opening or saving the queue fails) is latched
in the owning process. It is not treated as an empty queue and is not retried on
every heartbeat. The supervisor joins its controller and exits nonzero. When
metadata is writable, status becomes `stopped` with an optional
`error: {code: "runner_failed", message: ...}`; otherwise the process still exits
and its last heartbeat becomes stale. The public error includes the exception
class, never raw SQL, local paths or credentials. An explicit new `pips serve`
attempt clears the process-local fault. An ordinary failed audit remains a run
result and does not stop an otherwise healthy supervisor.

`stop` first commits a global stop in the registry's `metadata` table, then pauses
all active jobs and cancels queued/running Pips through `PipStore`. Worker claim,
enqueue, pre-execution and cancellation checks consult this persisted stop; an
old in-memory Config cannot bypass it. Even if a later job mutation fails, the
stop remains committed. Running work moves through `cancelling` until its owned
worker exits. The supervisor exits at its next check. Other ordinary DGC chat
sessions and their processes are unaffected.

Interactive `stop` asks for confirmation. Automation must explicitly pass
`pips stop --yes`; a noninteractive call without this flag refuses before any
mutation. See [PIPS-CLI-LOCAL.md](PIPS-CLI-LOCAL.md) for the complete local job,
report, proposal and context workflow.

Only an explicit local command can clear emergency stop:

```sh
/home/fungigb10/dgc-pips-lab-20261001/dgc-local pips resume
/home/fungigb10/dgc-pips-lab-20261001/dgc-local pips serve
```

Resume refuses while a supervisor or worker still holds its lease. Once both
leases are free it resolves interrupted run records without replaying work, then
clears the global stop. A concurrent newer stop wins over an older resume. Resume
does not start a supervisor, resume individual jobs, retry runs or enqueue work.
Review and resume each Pip separately. `serve --enable` cannot clear emergency
stop, and Remote exposes stop/status but no global-resume operation.

Ctrl+C or SIGTERM is an ordinary supervisor shutdown: disable its non-persisting
configuration clone, request cancellation only for this process's owned run, and
join its controller before releasing the supervisor lease. It does not set global
emergency stop or pause other jobs. Queued jobs stay queued for an explicit later
start. A metadata write failure does not skip joining the owned controller. No
PID from metadata is ever used as a signal target; the existing worker controller
alone terminates its own subprocess.

The control and heartbeat records are versioned JSON inside SQLite metadata under
`pips_runtime_control` and `pips_supervisor`. Malformed control records fail closed
as paused. A distinct crash-released `pips-supervisor` process lock prevents two
supervisors; actual worker exclusion remains the existing `pips-runner` lock.

Both Pips leases now live under the selected runner state's `locks/` directory,
including an isolated `DGC_HOME`. Ordinary DGC workspace/other named leases keep
their existing location. The same runner state therefore cannot gain a second
Pips supervisor just because a launcher has a different `HOME`. Unsafe or
inaccessible lease storage fails closed. Existing supervisors from the earlier
prototype must be stopped before loading this lease-location change; do not run
the old and new locking schemes concurrently.

The editor's local Start runner action launches an independent child from DGC's
trusted package directory and passes the project path explicitly to `Config`.
It does not run `python -m dgc` in the project directory, where project files
could otherwise shadow DGC or its dependencies. Startup readiness requires a
new supervisor identity, fresh heartbeat and a held, readable lease. A lock I/O
failure cannot stand in for evidence of a running supervisor.

Tests in `tests/test_pip_daemon.py` use temporary state, controlled clocks and
scripted `Event.wait` steps. They exercise persistence, lock exclusion, shutdown
ownership, failed writes, stop/resume races, CLI routing and no-network lifecycle
paths. They make no model/provider calls and use no sleeps. These are local
lifecycle tests, not a claim that a model endpoint has been tested or an OS
service installed.
