# Reviewed local HTTP checks (lab API 27)

This is a bounded status smoke check, not browser automation or a login test.
It checks the live local server; the source commit recorded alongside the run
is context, **not evidence of which build the server is running**.

```json
{
  "schema_version": 1,
  "action": {
    "kind": "test",
    "network": "loopback_http_v1",
    "tests": [
      {"argv": ["dgc-http-check", "http://127.0.0.1:3090/healthz", "200"], "cwd": "."},
      {"argv": ["dgc-http-check", "http://127.0.0.1:3090/login", "200"], "cwd": "."}
    ]
  }
}
```

These are example addresses, not a claim that Bearbloom runs on port 3090.
The frontend and backend health URLs must be discovered and reviewed explicitly.
One to four checks, one expected HTTP status per check. GET only. Literal
127.0.0.1 with an explicit port 1024–65535. No DNS names, userinfo, query strings,
fragments, encoded paths, traversal, redirect following, cookies, credentials,
proxy environment, request bodies, custom headers or shell execution. No HTTPS
or remote hosts in this first profile. No retries.

`dgc-http-check` is a reserved protocol marker, **never resolved on PATH**.
The controller launches a fixed, isolated-mode system Python program. Only the
reviewed URL/status are arguments. It does not load project code. Headers are
bounded by Python's HTTP parser; the body is capped at 64 KiB and discarded.
Oversized declared lengths and truncated declared bodies are refused.
Only status, byte count and a fixed outcome message are retained. A login page
returning 200 proves only that response, not that sign-in works or renders well.

The helper has a 10-second parent wall limit, 3-second socket operation timeout,
5 CPU seconds, 512 MiB address-space limit, core/file output disabled, and the
existing parent process monitor/cancellation. Slow response/header streams are
ultimately stopped by the parent deadline. Linux only, retaining the existing
execution capability gate. The generic action resource envelope remains the
existing 60/30/512 MiB bounds; the HTTP helper is strictly narrower.

Unlike shell commands (bubblewrap with networking off), the fixed probe must
reach the host's loopback network. Its URL restriction is an **application-level
allowlist**, not a kernel network firewall. It runs trusted stdlib HTTP code;
it does not grant a model or project command host networking. GET handlers may
have server-side effects despite HTTP semantics: review only known read-only
health/login endpoints. Patch and Pip-to-Pip handoffs reject this profile.

Immutable plan digests include the network profile and exact URLs. Existing
review, source binding, lifecycle, cancellation, launch reservation, durable
outcome, recovery and schedule deduplication checks remain in force. An interrupted
probe with no final record is unknown; it is never assumed passed or retried.
HTTP failure is recorded as a failed invocation even when the controller finishes
its sequence successfully. Read the per-check counts, not only `run.status`.

No new dependencies. No existing user configuration, schedule or Pip is silently
upgraded. Local source snapshots and read-only user-project boundaries remain.
