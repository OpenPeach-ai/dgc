# Local Pips service lifecycle

This Linux-only layer runs the existing `dgc pips serve` supervisor under the
current user's systemd manager. It introduces no model loop and does not change
Pip execution permissions, schedules, model configuration, or the durable
emergency stop. macOS and Windows retain the foreground `pips serve` path.

## Python API

`dgc.pip_service` provides:

```python
preview(dgc_home=None, *, unit_directory=None, python_executable=None,
        package_root=None) -> dict
install(dgc_home=None, **options) -> dict
status(dgc_home=None, **options) -> dict
start(dgc_home=None, **options) -> dict
stop(dgc_home=None, **options) -> dict
enable(dgc_home=None, **options) -> dict
disable(dgc_home=None, **options) -> dict
uninstall(dgc_home=None, **options) -> dict
```

Each operation validates the same options as `preview`. `dgc_home` is the
**parent of `.dgc`**, consistent with `DGC_HOME`. The default is the environment's
DGC_HOME, or the current user's home. Its directory must already exist and
belong to the user. The source defaults to this imported DGC package root; the
interpreter defaults to `sys.executable`. A standard venv interpreter's final
symlink is supported without replacing its invoked path with system Python.

The default unit directory is `$XDG_CONFIG_HOME/systemd/user`, or
`~/.config/systemd/user`. A custom unit directory is useful for generating and
reviewing lab files. **It is not automatically added to systemd's search path.**
Actual lifecycle control requires the manager to load this exact unit path;
an unrecognized custom directory is refused at control time, not implicitly
linked into the user's real units directory.

Preview is read-only and returns `unit_name`, `unit_path`, `dgc_home`, `argv`,
`content`, `sha256`, `platform`, `supported`, and `notes`. The name is
`dgc-pips-<first 24 hex digits of SHA256(canonical DGC_HOME)>.service`. File content
also includes the complete identity digest. Different private homes get distinct
units. No credentials or config contents appear in the unit or returned preview.

Control results contain `unit_name`, `unit_path`, `dgc_home`, `sha256`, and
`installed`; observations additionally include `active_state`, `sub_state`, and
`enabled_state`. Install returns `changed` and `started:false`. An uninstalled
status is `active_state:not_installed`, `enabled_state:disabled`. State is an
observation of the user service manager, not evidence that a model is reachable
or that a run can succeed.

Errors are `workspace_registry.RegistryError`, with actionable `code` and
message. Codes include `service_unsupported`, `invalid_service_path`,
`service_path_missing`, `unsafe_service_path`, `unsafe_service_state`,
`invalid_service_python`, `invalid_service_source`, `unsafe_service_unit`,
`service_limit`, `service_conflict`, `service_not_installed`, `service_running`,
`service_busy`, `service_write_failed`, `service_manager_unavailable`, `service_manager_timeout`,
`service_manager_limit`, `service_manager_error`, and `service_manager_invalid`.
No raw manager stderr, private config, or credentials are placed in errors.

## Distinct actions

- **Install:** write the exact reviewed unit with mode 0600 and ask the manager
  to reload. Never start or enable it. Reinstalling identical bytes is idempotent.
  A failed manager reload leaves the reviewable unit in place and says so.
- **Start:** start this scoped unit. `pips serve` still refuses if Pips are
  disabled, the global emergency stop is set, or another supervisor owns the
  same private state's lease. Start never passes `--enable` or invokes resume.
- **Stop:** stop this scoped supervisor via systemd. Normal supervisor shutdown
  cancels/drains its owned worker. This is not `pips stop`: it does not change all
  jobs to paused or persist the global emergency stop.
- **Enable:** explicitly register startup with the user's default target, usually
  login. Does not start the process.
- **Disable:** remove that login registration. Does not stop a running process.
- **Uninstall:** require inactive/failed state, disable this exact unit, remove
  its exact file, reload the manager. Running units require a separate Stop.

DGC never configures lingering, system services, privilege escalation, or the
user's login/session policy. Without an available user manager use foreground
`dgc pips serve`. Background persistence after logout depends on the host's
existing user-manager lifecycle. `Restart=no` avoids silently restarting after
an emergency stop or repeatedly starting a misconfigured service; inspect and
start explicitly after fixing the underlying condition.

## Launch and trust boundaries

The systemd unit invokes `/usr/bin/env -i` with an explicit minimal environment:
HOME and DGC_HOME point at the chosen private home, PATH is `/usr/bin:/bin`,
LANG is `C.UTF-8`, and Python user-site/bytecode settings are fixed. Environment
credentials, proxy variables, PYTHONPATH, LD_PRELOAD, and unrelated shell state
are not forwarded. Configure supported credentials through DGC's existing
private settings path. This deliberately differs from an interactive shell's
environment-only authentication.

Python `-I` prevents cwd/PYTHONPATH/user-site imports, and explicit `-B` prevents bytecode writes (`-I` ignores Python environment flags). A fixed bootstrap inserts
only the explicitly selected trusted package root, changes cwd to the private
home, then calls the existing CLI with `pips serve`. A project or private home
containing `dgc.py` cannot shadow the trusted package. The unit uses
`WorkingDirectory=/`; paths are argv data, never shell commands. ExecStart
quotes, backslashes, dollar expansion, and percent specifiers are escaped using
systemd syntax. Config/secrets are read at runtime, not embedded in service files.

Existing `.dgc` must be owner-only; existing config.json and secrets.json must
be owner-only regular files with one link. Directory paths reject symlink
ancestors, foreign ownership, traversal, and other-user writability (system-owned
sticky temporary directories are allowed for private fixtures). The interpreter
and package entry points must be trusted regular files or the explicitly checked
venv executable link. This is local owner-level configuration hygiene, **not a
sandbox against malicious code already writable by the same account**.

Mutations require an exact byte match with the generated unit. Edited/foreign
units, local drop-in directories, aliases, manager-reported overrides, and a
loaded FragmentPath different from the reviewed file are refused. DGC does not
silently update a unit after its source/interpreter/template changes; the owner
must explicitly review that mismatch. Directory flock serializes cooperating
DGC mutations; it is not a defense against a hostile process using the same UID.

The unit uses UMask=0077 and NoNewPrivileges=yes. KillMode=mixed sends SIGTERM to
the supervisor first; after TimeoutStopSec=90 systemd kills remaining processes
in **that unit's cgroup**, not unrelated DGC instances. This avoids relying on
reusable saved PIDs. The supervisor retains its existing worker cancellation,
permission, and test-confinement mechanisms. This layer adds no claim that model
requests or arbitrary provider processes are fully sandboxed.

## Bounds and validation

Paths are at most 4,096 UTF-8 bytes and reject control characters and lone
surrogates. Generated/read unit files are capped at 16 KiB. Manager output is
capped at 16 KiB, operation waits at 15 seconds, and manager subprocesses are
owned process groups killed/reaped on failure or timeout. Output is parsed as
an exact small set of `systemctl show` properties. No arbitrary command or PID
is accepted from stored service data.

Deterministic tests use an isolated unit directory and mocked manager boundary;
they do not install real user units, call a network, or sleep. They cover scoped
identity, no-write preview, independent lifecycle actions, foreign units and
overrides, file types/links/permissions/limits, command/path injection, clear
partial-install status, disabled startup, and real bounded subprocess capture.
One real isolated Python process proves home import-shadow refusal and exits
because Pips are disabled. This does not claim full systemd lifecycle coverage.

Generated ordinary and special-character-path units were separately checked
with the host's real `systemd-analyze --user verify` (systemd 255), with
SYSTEMD_UNIT_PATH restricted to the lab unit directory and distribution user
units. Both passed. This parser check caught an initially quoted
WorkingDirectory that systemd rejected; the fixed unit uses `/` and handles
private paths solely as escaped argv. Real lifecycle smoke-test evidence is
recorded separately when run; mock tests are not described as platform proof.

## Real Linux lifecycle smoke check

An explicitly coordinated transient unit, `dgc-pips-service-review-empty.service`,
ran with the exact generated argv and service properties, using only
`state/pip-service-review/live-home`. Its private config was enabled during test
setup through `Config.set`, before launching the service; the service itself did
not enable it. There were zero workspaces with work, zero jobs, and zero runs.

The real manager reported `active/running` and the private registry recorded a
running supervisor heartbeat. Explicitly stopping only that transient unit
produced `inactive/dead` and a stopped heartbeat. Configuration hashes were
unchanged across the lifecycle; no emergency-stop record was created. No model
request occurred and no ordinary user-unit file, lingering setting, or existing
supervisor was changed. Evidence: `state/pip-service-review/live-evidence.json`.

This proves Linux startup and cooperative shutdown of the existing supervisor
with the service's actual environment and isolation settings. It does not test
workload cancellation, reboot/login persistence, different distributions,
Windows/macOS service management, or lifecycle through an installed persistent
unit. Those are separate from the deterministic controller and parser checks.
