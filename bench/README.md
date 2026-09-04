# DGC polyglot benchmark

Measure **DGC running a model** on the [Aider polyglot benchmark][pg] — 225
Exercism problems across **C++, Go, Java, JavaScript, Python, Rust** — by having
DGC implement each stub and then running the exercise's **real test suite**.

This is the exact harness behind the numbers we publish, so you can reproduce
them on your own machine and models.

## How it works

For each exercise, DGC runs headless (`dgc -p "…" --mode auto`) under a
throwaway `$HOME` (it never touches your real `~/.dgc`), implements the solution
file(s), and we score by running the official tests:

- **round 1** — a fresh DGC session implements the stub (it may read + run the
  tests itself within a turn budget), then we run the official test suite.
- **round 2** — only if round 1's official tests fail: the session continues
  (`dgc -c`), fed the exact failing output; we re-test.
- **pass@1** = solved after round 1 · **pass@2** = solved by end of round 2.

We also record wall-time, tool-call/turn counts, `edit_file` failure counts, provider-reported
input/output/reasoning tokens, provider request/wall latency, and DGC built-in tool time. Aggregate
comparisons retain a trace-free row for every engine/task and can print bounded slow/request outliers.
Each exercise gets its own private HOME; round two reuses only that exercise's real harness session.

## Setup

```bash
# 1. exercises
mkdir -p data && git clone https://github.com/Aider-AI/polyglot-benchmark data/polyglot-benchmark

# 2. language toolchains (to compile + run the tests)
#    Python(pytest), Go, Rust(cargo), JDK 17+(for gradle); C++(g++/cmake) + Node/npm.
#    run_bench.py checks ~/bench-tools/ and PATH. Set BENCH_TOOLS to use another
#    hermetic toolchain directory.
#    For C++ `gigasecond`/`meetup`, install Boost date-time development files or
#    extract them under $BENCH_TOOLS/boost/usr/{include,lib}; the runner discovers that prefix.

# 3. install the pinned peer harnesses into ~/bench-tools/harnesses
bash install_harnesses.sh

# 4. validate the grader against all 225 reference solutions
python3 validate_harness.py all 999
```

## Endpoint-free edit-primitive gate

Before spending model time, run the frozen 19,591-case edit corpus against DGC's exact and tolerant
match tiers. The release preflight verifies its SHA-256; when the ignored local corpus is absent, it
regenerates it from the exact pinned upstream benchmark commit in a temporary checkout:

```bash
python3 edit_micro.py edit_corpus/all.jsonl
```

The local candidate accepts 19,560 cases (99.84%), up from 17,443 (89.04%), with zero wrong applies.
The remaining 31 cases are safe refusals: DGC cannot uniquely corroborate their normalized target.
`WRONG` is the release-gate number. The scorer counts any application to an expected ambiguous/miss
case as wrong, regardless of the resulting text, and exits nonzero whenever that count is nonzero.
The same command also constructs 14,197 in-memory duplicate-target transformations across every
positive exact and tolerant case. All 14,197 currently refuse safely (14,174 explicit ambiguities
plus 23 clean refusals); any application is a gate failure. This benchmark is deterministic and
contacts no model endpoint.

## Run

All harnesses must use a dedicated Ollama model alias with the same baked context. OpenAI-compatible
requests cannot set Ollama's `num_ctx`, so a raw model tag is not a controlled comparison. Create a
small Modelfile such as:

```dockerfile
FROM qwen3.8:27b-q4_K_M
PARAMETER num_ctx 65536
```

Then run `ollama create qwen3.8-bench-64k -f Modelfile.bench`. The runner verifies that exact
`num_ctx` through bounded `/api/show` metadata before any scored task, and the accounting proxy pins
native DGC/Goose requests to it as well. A missing or mismatched value fails before model generation.

```bash
# a quick taste — 3 python exercises on a local ollama model
python3 run_bench.py --model qwen3.8-bench-64k --context-size 65536 \
  --base-url http://localhost:11434/v1 --langs python -n 3 --out results/

# the full 225, two-round protocol
python3 run_bench.py --model <baked-context-model-alias> --context-size 65536 \
  --base-url <openai-compatible-url> \
  --langs all --rounds 2 --out results/ --tag run1

# publishable same-model league (validates references, then runs all six harnesses)
export DGC_BENCH_MODEL_DIGEST=<immutable-model-digest>
export DGC_BENCH_HARDWARE=<stable-machine-label>
export DGC_BENCH_ACCELERATOR=<gpu-or-accelerator-description>
export DGC_BENCH_CONTEXT_SIZE=65536
bash run_league.sh <baked-context-model-alias> <openai-compatible-url> run1

# one-task protocol canary (explicitly non-publishable)
export DGC_BENCH_ALLOW_DIRTY=1 DGC_BENCH_ALLOW_PARTIAL=1
export DGC_BENCH_SKIP_REFERENCE_VALIDATION=1
export DGC_BENCH_LANGS=python DGC_BENCH_EXERCISES=proverb DGC_BENCH_ROUNDS=1
export DGC_BENCH_CONTEXT_SIZE=65536
bash run_league.sh <baked-context-model-alias> <openai-compatible-url> canary1
```

For a keyed endpoint, set `DGC_BENCH_API_KEY` in the environment. To use a
different variable, pass its name with `--api-key-env NAME`. DGC deliberately
does not accept a literal key on the command line, keeping it out of process listings.

Results append to `results/results-<engine>-<model>-<tag>.jsonl` as each exercise
finishes, so a run is **resumable** — re-run the same command and it skips
exercises already recorded (`--redo` forces a re-run).

DGC tool calls, successful/failed file-edit counts, and completed-request reasons come from monotonic
counters persisted in the session plus an atomic lightweight `.metrics` journal updated after every
completed model request and tool call. They remain valid across context compaction, `--continue`, and
an external wall-time SIGKILL that bypasses the full-transcript finalizer. Request reasons use a
fixed controller-owned vocabulary such as `user_turn`, `tool_result`, `verifier_evidence`,
`steering`, and `compaction`; they never contain prompts, tool arguments, paths, model output, or
errors. Pre-metrics-schema-v3 requests appear explicitly as `unattributed`. Schema-v4 and older DGC
sessions use a transcript-derived activity compatibility fallback and must not be mixed into a newly
published controlled run.

Performance attribution uses two independent clocks. The loopback provider proxy records monotonic
duration for every normalized request; each round stores both request-seconds (the sum of all request
durations) and provider wall time (the union of overlapping request intervals), plus the longest
request. DGC records microsecond elapsed time and sample counts for built-in execution, both in total
and by bounded tool name. Tool arguments, commands, paths, prompts, and results are never included in
timing records. The timer updates only in-memory counters; the already-required activity/request
journal save persists them, so instrumentation does not add a disk write to each tool call.
Request-reason counters use that same save boundary and likewise add no persistence write per
generation. The per-round `by_request_reason` map is an additive request count, not a duration.

The report shows `other_s = max(agent_s - prov_s, 0)` only as outside-provider wall time—not as a
claim that all of it is DGC overhead. Built-in tool-seconds can overlap when DGC runs independent
reads in parallel, and provider work may continue after a timed-out client disconnects. Compare
`avg_s`, `prov_s`, `other_s`, the DGC-only `tool_s`, request count, and the raw
`by_tool_us`/`by_tool_samples` maps together. A high `prov_s` points at model/endpoint latency; a high
named tool total points at execution, sandbox, or filesystem cost; `other_s` includes orchestration,
permission/lease waits, external tools, process startup, and unmeasured frontend work. Legacy or
incompletely synchronized records render affected metrics as `?`, never a misleading zero.
The bounded `completed-request reasons` line explains DGC's journaled generations; it does not
manufacture equivalent controller semantics for peer harnesses.

## Endpoint-free runtime overhead probe

Use the deterministic local microbenchmark when a safety change is suspected of slowing the harness:

```bash
python3 runtime_micro.py
# compact machine-readable output with fewer samples
python3 runtime_micro.py --quick --json
```

The probe never contacts a model and confines fixture, session, and lock writes to one disposable
temporary directory. It reports median/p95/mean milliseconds for the crash-safe workspace lease,
an exact 768-byte read, an approximately 800-byte atomic write, one crash-safe activity-journal
update, an ordinary `true` shell, sandbox-policy construction, and a confined `true` shell when a
backend exists. These are fixed local costs, not task-quality or league evidence. Compare their
scale with provider request-seconds and generations per task before weakening a permission,
filesystem, process, or sandbox boundary; a few dozen milliseconds of process startup cannot by
itself explain a multi-minute model trajectory.

Measure the model-request surface separately from runtime boundaries:

```bash
python3 prompt_surface.py
python3 prompt_surface.py --json
```

This endpoint-free probe constructs the same timed auto/native-Ollama profile and canonical exercise
prompt as the controlled DGC runner in an isolated temporary project. It reports system-prompt and
compact tool-schema characters, the four-characters-per-token wire estimate, section sizes, active
bundled skills, and per-tool schema sizes. User-installed skills and model endpoints are excluded.
Use it to catch accidental prompt/schema expansion; it does not measure generation latency or coding
quality.

Round-two compiler/test diagnostics are path-normalized before they are returned to a harness. The
official grader runs in a disposable clean fixture, so absolute paths from that deleted fixture are
mapped to `./...` in the still-live exercise worktree; diagnostic text and line numbers are otherwise
unchanged. This prevents a recovery turn from chasing files that no longer exist.

Each run first preflights the selected harness, language toolchains, dataset, and C++ Boost
dependency. It then writes a schema-v3 manifest with executable/toolchain hashes and versions,
exact settings, runner/dataset commits, hardware, the engine's expected provider transport, and a
deterministic run ID. Set
`DGC_BENCH_MODEL_DIGEST`, `DGC_BENCH_CAPABILITIES`, `DGC_BENCH_HARDWARE`, and
`DGC_BENCH_ACCELERATOR` to make controlled-run provenance complete. Bounded,
credential-redacted stdout/stderr traces survive non-zero exits and wall timeouts. Official tests
run in a fresh fixture containing only the agent's submitted solution files, so edits to tests,
build manifests, or added files cannot weaken grading.

DGC's internal turn deadline is set 15 seconds before the external process-group timeout (scaled
down for very short diagnostics). This reserves time for cancellation, snapshot restoration, and
atomic session persistence; the `.metrics` journal remains the crash-safe fallback if hard
termination still wins the race. Once that deadline is set, a response-header timeout is terminal:
DGC does not retry the already-abandoned request and multiply provider work after the turn has ended.

`run_league.sh` requires clean DGC and dataset checkouts, runs DGC, Aider, Codex, Goose, OpenCode,
and Pi sequentially, then writes a task-set/provenance-checked comparison with Wilson 95% confidence
intervals. By default it starts a loopback provider proxy that enforces reasoning off at the actual
Ollama/OpenAI transport, drains final usage events, and records request metadata/usage without
prompts or responses. `DGC_BENCH_NORMALIZE_THINKING=0` disables it only for a documented diagnostic.
The isolated DGC profile explicitly selects native Ollama because the accounting proxy's URL hides
the upstream family; otherwise `api_mode: auto` would measure generic Chat Completions instead of
DGC's native local-model path. The proxy labels every generation as `ollama_chat`,
`chat_completions`, or `responses`, and the publication gate requires every recorded request to match
the transport declared for that harness.
If a deadline-cancelled harness disconnects while the provider is still generating, the runner waits
for the proxy to drain that request before taking the next round's log offset. It aborts fail-closed
if quiescence cannot be proven. DGC rows independently reconcile provider requests with the
crash-safe session journal: an exact match is accepted, and a provider surplus is accepted only when
every extra request is explained by a proxy-observed client disconnect. All provider-only cancelled
compute remains charged and visible in the row. Any unexplained difference is unsynchronized, so
late usage can never silently leak into the next task.

Without `DGC_BENCH_ALLOW_PARTIAL=1`, comparison rejects anything except all six engines, all 225
tasks, a clean runner and dataset revision, immutable model digest, hardware label, transport
normalization, and synchronized provider usage for every model round. `DGC_BENCH_ENGINES`,
`DGC_BENCH_LANGS`, `DGC_BENCH_LIMIT`, and `DGC_BENCH_EXERCISES` are trial controls, not shortcuts to
a publishable claim. `install_harnesses.sh` pins Aider, Codex, Goose, OpenCode, and Pi in the
user-owned benchmark toolchain; explicit `AIDER`, `CODEX`, `GOOSE`, `OPENCODE`, or `PI` environment
variables still override those binaries.

## Read the results

```bash
python3 report.py results/results-<engine>-<model>-<tag>.jsonl

# compare controlled engines, using DGC as the paired task baseline, and show the top five outliers
python3 compare.py --baseline-engine dgc --top-tasks 5 \
  --json results/comparison-<model>-<tag>.json \
  results/results-<engine>-<model>-<tag>.jsonl ...
```

```
lang           n         pass@1         pass@2   avg_s  prov_s other_s  tool_s  req/t   avg_out  out/req editfail  t/o
python        34   19 ( 55.9%)   24 ( 70.6%)      92      71      21     8.4    6.2      1234      199        3    0
...
TOTAL        225  ...
```

`tool_s` is available only for instrumented DGC rounds. The report also prints the eight largest
built-in tool totals with sample counts; the JSONL remains authoritative for every per-round and
per-tool value. Comparison JSON schema v5 adds a bounded, trace-free `tasks` array with pass state,
rounds, timeouts, attributed requests/tokens/timings, outside-provider time, and available activity
counters for every engine/exercise. It also emits `paired_summaries` and `paired_task_deltas` for
each peer on the exact shared task set selected by `--baseline-engine`. Pass@1, pass@2, and a
three-tier first-round/second-round/fail comparison keep quality differences explicit. Delta values
are baseline minus peer, so positive time, request, token, timeout, tool, or edit values mean the
baseline used more. `--top-tasks` prints a bounded union of both per-engine outliers and paired
baseline quality regressions; latency and request regressions are selected only between equally
successful quality tiers, never by rewarding an earlier failure. A task with incomplete or
unsynchronized provider attribution uses JSON `null` for affected totals; paired sums carry an
explicit coverage count and never mix partial work into a seemingly exact number.

Key flags: `--langs` (subset), `-n/--limit` (cap per language), `--rounds`,
`--context-size` (required baked model context), `--dgc-timeout`, `--test-timeout`, `--tag`,
`--keep-work`, `--dry-run`.

[pg]: https://github.com/Aider-AI/polyglot-benchmark
