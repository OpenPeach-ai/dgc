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

We also record wall-time, tool-call/turn counts, `edit_file` failure counts, and provider-reported
input/output/reasoning tokens. Each exercise gets its own private HOME; round two reuses only that
exercise's real harness session.

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

## Run

```bash
# a quick taste — 3 python exercises on a local ollama model
python3 run_bench.py --model qwen3.8:27b-q4km \
  --base-url http://localhost:11434/v1 --langs python -n 3 --out results/

# the full 225, two-round protocol
python3 run_bench.py --model <model> --base-url <openai-compatible-url> \
  --langs all --rounds 2 --out results/ --tag run1

# publishable same-model league (validates references, then runs all six harnesses)
export DGC_BENCH_MODEL_DIGEST=<immutable-model-digest>
export DGC_BENCH_HARDWARE=<stable-machine-label>
export DGC_BENCH_ACCELERATOR=<gpu-or-accelerator-description>
bash run_league.sh <model> <openai-compatible-url> run1

# one-task protocol canary (explicitly non-publishable)
export DGC_BENCH_ALLOW_DIRTY=1 DGC_BENCH_ALLOW_PARTIAL=1
export DGC_BENCH_SKIP_REFERENCE_VALIDATION=1
export DGC_BENCH_LANGS=python DGC_BENCH_EXERCISES=proverb DGC_BENCH_ROUNDS=1
bash run_league.sh <model> <openai-compatible-url> canary1
```

For a keyed endpoint, set `DGC_BENCH_API_KEY` in the environment. To use a
different variable, pass its name with `--api-key-env NAME`. DGC deliberately
does not accept a literal key on the command line, keeping it out of process listings.

Results append to `results/results-<engine>-<model>-<tag>.jsonl` as each exercise
finishes, so a run is **resumable** — re-run the same command and it skips
exercises already recorded (`--redo` forces a re-run).

DGC tool calls and successful/failed file-edit counts come from monotonic counters persisted in
the session plus an atomic lightweight `.metrics` journal updated after every completed model
request and tool call. They remain valid across context compaction, `--continue`, and an external
wall-time SIGKILL that bypasses the full-transcript finalizer. Schema-v4 and older DGC sessions use
a transcript-derived compatibility fallback and must not be mixed into a newly published controlled
run.

Round-two compiler/test diagnostics are path-normalized before they are returned to a harness. The
official grader runs in a disposable clean fixture, so absolute paths from that deleted fixture are
mapped to `./...` in the still-live exercise worktree; diagnostic text and line numbers are otherwise
unchanged. This prevents a recovery turn from chasing files that no longer exist.

Each run first preflights the selected harness, language toolchains, dataset, and C++ Boost
dependency. It then writes a schema-v3 manifest with executable/toolchain hashes and versions,
exact settings, runner/dataset commits, hardware, and a deterministic run ID. Set
`DGC_BENCH_MODEL_DIGEST`, `DGC_BENCH_CAPABILITIES`, `DGC_BENCH_HARDWARE`, and
`DGC_BENCH_ACCELERATOR` to make controlled-run provenance complete. Bounded,
credential-redacted stdout/stderr traces survive non-zero exits and wall timeouts. Official tests
run in a fresh fixture containing only the agent's submitted solution files, so edits to tests,
build manifests, or added files cannot weaken grading.

DGC's internal turn deadline is set 15 seconds before the external process-group timeout (scaled
down for very short diagnostics). This reserves time for cancellation, snapshot restoration, and
atomic session persistence; the `.metrics` journal remains the crash-safe fallback if hard
termination still wins the race.

`run_league.sh` requires clean DGC and dataset checkouts, runs DGC, Aider, Codex, Goose, OpenCode,
and Pi sequentially, then writes a task-set/provenance-checked comparison with Wilson 95% confidence
intervals. By default it starts a loopback provider proxy that enforces reasoning off at the actual
Ollama/OpenAI transport, drains final usage events, and records request metadata/usage without
prompts or responses. `DGC_BENCH_NORMALIZE_THINKING=0` disables it only for a documented diagnostic.
If a deadline-cancelled harness disconnects while the provider is still generating, the runner waits
for the proxy to drain that request before taking the next round's log offset. It aborts fail-closed
if quiescence cannot be proven, and DGC rows independently require provider request counts to match
the crash-safe session journal. Late usage can therefore never leak into the next task.

Without `DGC_BENCH_ALLOW_PARTIAL=1`, comparison rejects anything except all six engines, all 225
tasks, a clean runner and dataset revision, immutable model digest, hardware label, transport
normalization, and synchronized provider usage for every model round. `DGC_BENCH_ENGINES`,
`DGC_BENCH_LANGS`, `DGC_BENCH_LIMIT`, and `DGC_BENCH_EXERCISES` are trial controls, not shortcuts to
a publishable claim. `install_harnesses.sh` pins Aider, Codex, Goose, OpenCode, and Pi in the
user-owned benchmark toolchain; explicit `AIDER`, `CODEX`, `GOOSE`, `OPENCODE`, or `PI` environment
variables still override those binaries.

## Read the results

```bash
python3 report.py results/results-<model>-<tag>.jsonl
```

```
lang           n         pass@1         pass@2   avg_s editfail  t/o
python        34   19 ( 55.9%)   24 ( 70.6%)      92        3    0
...
TOTAL        225  ...
```

Key flags: `--langs` (subset), `-n/--limit` (cap per language), `--rounds`,
`--dgc-timeout`, `--test-timeout`, `--tag`, `--keep-work`, `--dry-run`.

[pg]: https://github.com/Aider-AI/polyglot-benchmark
