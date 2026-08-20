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

We also record wall-time, tool-call/turn counts, and `edit_file` failure counts.

## Setup

```bash
# 1. exercises
mkdir -p data && git clone https://github.com/Aider-AI/polyglot-benchmark data/polyglot-benchmark

# 2. language toolchains (to compile + run the tests)
#    Python(pytest), Go, Rust(cargo), JDK 17+(for gradle); C++(g++/cmake) + Node/npm.
#    run_bench.py expects them under /home/fungigb10/bench-tools/ (edit the paths at
#    the top of run_bench.py for your machine), or on PATH.

# 3. sanity-check the grader: reference solutions must all PASS
python3 validate_harness.py all 1
```

## Run

```bash
# a quick taste — 3 python exercises on a local ollama model
python3 run_bench.py --model qwen3.8:27b-q4km \
  --base-url http://localhost:11434/v1 --langs python -n 3 --out results/

# the full 225, two-round protocol
python3 run_bench.py --model <model> --base-url <openai-compatible-url> \
  --api-key <key> --langs all --rounds 2 --out results/ --tag run1
```

Results append to `results/results-<model>-<tag>.jsonl` as each exercise
finishes, so a run is **resumable** — re-run the same command and it skips
exercises already recorded (`--redo` forces a re-run).

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
