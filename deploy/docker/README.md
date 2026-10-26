# DGC's Pips on a server, in Docker

This image runs DGC's Pips runner with no VS Code and no desktop, beside your own app. Your app uses DGC's SDK to give
Personal Pips its tools, to hear about and decide their changes, and to send its events
([sdk/PIPS.md](../../sdk/PIPS.md)). The runner does the work, and `dgc pips health` tells Docker whether it is healthy.

What's in it:

- Debian slim with Python 3.12 (`python:3.12-slim`).
- DGC, installed from its release archive by `install.sh` at the version you pin.
- The Python SDK (`dgc_sdk`), bubblewrap, git and tini.
- A user `dgc` (uid 10001) that owns `/data`, the volume that holds DGC's home: its settings, secrets and Pips state.
- `dgc pips serve --server` as the container's command, and `dgc pips health` as its health check.
- `with-pips`, a small supervisor that runs your app with the runner beside it.

## Build it

From the repository root, at the tag of the release you install:

```sh
docker build -f deploy/docker/Dockerfile --build-arg DGC_VERSION=0.48.1 -t dgc-pips .
```

`install.sh` downloads that release from vibedgc.com, checks its SHA-256 and refuses any other version. To build from
a release archive you built yourself, add `--build-context release=dist/release` after running
`scripts/build-release.sh`. To install the SDK from PyPI rather than from this checkout, add
`--build-arg DGC_SDK_VERSION=0.7.0`. Nothing here pushes an image anywhere.

## Set it up once

DGC's home is the volume. Give it a model and turn Pips on. On a server, Pips run only on an API key or a self-hosted
model (see [The guardrail](#the-guardrail)). A self-hosted model, such as Ollama on the Docker host, needs no key:

```sh
docker volume create dgc-data
docker run --rm -v dgc-data:/data dgc-pips sh -c 'umask 077; mkdir -p /data/.dgc; cat > /data/.dgc/config.json <<EOF
{"model": "qwen3:32b", "base_url": "http://172.17.0.1:11434/v1", "pips_enabled": true}
EOF'
```

`172.17.0.1` is the Docker host on Docker's default network; Ollama there must listen beyond localhost
(`OLLAMA_HOST=0.0.0.0`). For a model behind an API key, either:

- run `docker run --rm -it -v dgc-data:/data dgc-pips dgc setup` once and choose the provider (not a Claude Code or
  Codex subscription). DGC saves the key in its own secret store on the volume (`/data/.dgc/secrets.json`, readable by
  its owner only), as it does on a laptop; or
- pass it to each container as `DGC_API_KEY`, from a file only you can read: `--env-file dgc.env`.

## Run the runner

```sh
docker run -d --name pips --restart on-failure --stop-timeout 90 -v dgc-data:/data dgc-pips
docker inspect -f '{{.State.Health.Status}}' pips      # starting, then healthy
docker logs -f pips
```

With `on-failure`, Docker restarts a runner that failed, and leaves one alone that you stopped on purpose (`docker
stop`, or the emergency stop below). A runner that can't start says why on one line and exits with status 1: Pips are
off, Pips are stopped, or this home already has a runner. Docker then tries again, with longer pauses each time, and
the log repeats the reason.

It is healthy within seconds. The log has one plain line for each event, with its time in UTC:

```
2026-10-24T01:25:00.953Z runner_started: server mode, DGC 0.48.1, Pips state /data/.dgc/pips
2026-10-24T01:28:46.111Z pip_run_queued pip=pip_5faa… run=run_b9ec… by=local-routine
2026-10-24T01:28:54.894Z pip_run_succeeded pip=pip_5faa… run=run_b9ec…
2026-10-24T01:29:24.292Z runner_stopped reason=emergency_stop
```

A failed run says why in its own words, after its error's code. A run's steps stay in its chat and report.

## Your app beside it

There are two ways. Either way, the app and the runner share one DGC home, and never two runners: a runner started on a
home that already has one stops at once ("A Pips supervisor is already running for this local state directory") and
exits with status 1.

### 1. Your app in this image

Build on the image and start your app through `with-pips`:

```dockerfile
FROM dgc-pips
USER root
RUN pip install flask gunicorn
COPY shop/ /app/
USER dgc
CMD ["with-pips", "gunicorn", "--bind", "0.0.0.0:8000", "--chdir", "/app", "shop:app"]
```

```sh
docker run -d --name shop --restart unless-stopped --stop-timeout 90 -v dgc-data:/data my-shop-image
```

Your app is the main process. When it exits, `with-pips` stops the runner and exits with your app's status, so the
restart policy brings both back. When the runner stops, whether it failed, Pips were turned off, or someone used the
emergency stop, `with-pips` starts it again 30 seconds later, and `dgc pips health` says why it isn't running meanwhile.
Docker's stop reaches both; `with-pips` gives the runner up to 90 seconds to finish, so start the container with
`--stop-timeout 90` (Docker's own default is 10 seconds).

In the app, the SDK finds DGC by itself, and its session is this home's:

```python
from dgc_sdk import DGC
dgc = DGC(inherit_user_state=True, sandbox="off")
session = dgc.session(cwd="/data/shop-ws")
```

Register the app at an address the runner can reach: `http://127.0.0.1:8000/dgc/pips` when both run in one container.

### 2. Your app in a second container

Run the runner as above, and your app from the same image in its own container, with the same volume and the same user
(Pips state is readable by its owner only):

```sh
docker network create pips-net
docker run -d --name pips --network pips-net --restart on-failure --stop-timeout 90 -v dgc-data:/data dgc-pips
docker run -d --name shop --network pips-net -v dgc-data:/data my-shop-image gunicorn --bind 0.0.0.0:8000 shop:app
```

Don't start a runner in the app's container: it would be refused. Register the app at an address both containers
reach, such as `http://shop:8000/dgc/pips` on the shared network. The runner calls your app's tools there, and the
app's own `dgc serve` does too when your app accepts a change.

## Health

`dgc pips health` exits 0 when the runner is online and running and holds its lease. Otherwise it exits 1 with one line
saying why:

| State | When |
| --- | --- |
| `off` | Pips are off in this home's settings. |
| `stopped` | The emergency stop is on (`dgc pips stop`). `dgc pips resume` clears it; each Pip stays paused until you resume it. |
| `no_runner` | No runner has started yet, the last one stopped, or one stopped a moment ago without saying so. |
| `heartbeat_stale` | The runner's heartbeat (every 2 seconds) is more than 15 seconds old: it is stuck. |
| `state_unreadable` | The state on the volume can't be read. |

`dgc pips health --json` gives the same as one object (`healthy`, `state`, `message`, `heartbeat_age_seconds`,
`server_mode`, `lease_held`, the run counts) for your own probes. It opens the state read-only and never writes it, so
running it every 10 seconds is fine. The image's `HEALTHCHECK` runs it every 10 seconds; three failures in a row make
the container unhealthy.

## The guardrail

On a server, Pips run on an API key or a self-hosted model only. A Personal Pip whose model is a personal Claude Code
or Codex plan, chosen for it or followed through "Same as DGC", is refused when it runs under `--server`. Its run is
marked failed (`server_subscription`), with words that say why and how to change it, and its model is never switched
by itself:

```
Not run: this Pip's model is your Claude Code plan, and Pips on a server run only on an API key or a self-hosted model. …
```

## Where secrets live

- Your model's API key: DGC's own secret store on the volume, `/data/.dgc/secrets.json` (0600), or `DGC_API_KEY` in the
  container's environment.
- Your app's signing secret: DGC's copy is in its credential store on the volume,
  `/data/.dgc/plugin-auth/_pipapp.<name>/credentials.json` (0600), since a container has no system keychain. Your
  app's copy is wherever your app keeps its secrets; `register_app` gives it once.
- Everything on `/data` belongs to the `dgc` user, and DGC keeps its folders and files there owner-only. Back the volume
  up as you would a database.

## Without bubblewrap

Docker's default confinement doesn't let bubblewrap make the namespaces it needs. Without it, these still work: Personal
Pips with your app's tools, approvals and events, their routines, schedules and chats, project audits and Quill
drafts, and DGC's local page checks. These need bubblewrap: Pip computers (which also need a Chromium in the image),
Pulse and Patch commands, and live-data commands. Each says so, and the runner's first lines say whether Pip computers
can run here.

Docker allows the namespaces only for a container started with
`--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined`. That
loosens the container's own confinement, so weigh it, or run the runner on the host with systemd instead:
`dgc pips service install --server`, then `dgc pips service start` and `dgc pips service enable`.

## Stopping, and the emergency stop

`docker stop` stops the runner cleanly: its runs are cancelled, queued work stays queued, and nothing is replayed
(`--stop-timeout 90` above gives it the time).

`dgc pips stop --yes` is the emergency stop: every Pip is paused, their work is cancelled, and the runner exits and
won't start again until the stop is cleared. With the runner on its own (`docker exec pips dgc pips stop --yes`),
its container exits too; clear the stop and start it again with:

```sh
docker run --rm -v dgc-data:/data dgc-pips dgc pips resume
docker start pips
docker run --rm -v dgc-data:/data dgc-pips dgc pips resume-job PIP_ID     # each Pip stays paused until you resume it
```

Under `with-pips` the container keeps running with your app and health says `stopped`. After
`docker exec shop dgc pips resume` (and `dgc pips resume-job PIP_ID` for each Pip), the runner is back within 30
seconds.
