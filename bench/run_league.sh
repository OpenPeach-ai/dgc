#!/usr/bin/env bash
# Run every harness sequentially on one controlled model/task/hardware configuration.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PYTHON=${DGC_BENCH_PYTHON:-"$ROOT/.venv/bin/python"}
[ -x "$PYTHON" ] || PYTHON=python3
MODEL=${1:?usage: run_league.sh <model> [base-url] [tag]}
BASE_URL=${2:-http://localhost:11434/v1}
TAG=${3:-league}
OUT=${DGC_BENCH_OUT:-"$ROOT/bench/results"}
ENGINES=${DGC_BENCH_ENGINES:-"dgc aider codex goose opencode pi"}
LANGS=${DGC_BENCH_LANGS:-all}
LIMIT=${DGC_BENCH_LIMIT:-0}
EXERCISES=${DGC_BENCH_EXERCISES:-}
ROUNDS=${DGC_BENCH_ROUNDS:-2}
AGENT_TIMEOUT=${DGC_BENCH_AGENT_TIMEOUT:-1200}
TEST_TIMEOUT=${DGC_BENCH_TEST_TIMEOUT:-400}
CONTEXT_SIZE=${DGC_BENCH_CONTEXT_SIZE:-}

[ -n "${DGC_BENCH_MODEL_DIGEST:-}" ] || {
  echo "DGC_BENCH_MODEL_DIGEST is required for a publishable league" >&2; exit 2;
}
[ -n "${DGC_BENCH_HARDWARE:-}" ] || {
  echo "DGC_BENCH_HARDWARE is required for a publishable league" >&2; exit 2;
}
[ -n "$CONTEXT_SIZE" ] || {
  echo "DGC_BENCH_CONTEXT_SIZE is required; use a model alias with the same baked num_ctx" >&2
  exit 2
}
case "$CONTEXT_SIZE" in
  *[!0-9]*|'') echo "DGC_BENCH_CONTEXT_SIZE must be an integer" >&2; exit 2 ;;
esac
[ "$CONTEXT_SIZE" -ge 2048 ] && [ "$CONTEXT_SIZE" -le 10000000 ] || {
  echo "DGC_BENCH_CONTEXT_SIZE must be between 2048 and 10000000" >&2; exit 2
}
if [ "${DGC_BENCH_ALLOW_DIRTY:-0}" != 1 ]; then
  [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=normal)" ] || {
    echo "league runs require a clean reviewed DGC checkout (DGC_BENCH_ALLOW_DIRTY=1 for local trials)" >&2
    exit 2
  }
  [ -z "$(git -C "$ROOT/bench/data/polyglot-benchmark" status --porcelain --untracked-files=normal)" ] || {
    echo "league runs require a clean benchmark dataset checkout" >&2; exit 2;
  }
fi

mkdir -p "$OUT"
PROXY_PID=""
PROXY_READY=""
BENCH_BASE_URL=$BASE_URL
cleanup_proxy() {
  if [ -n "$PROXY_PID" ]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  if [ -n "$PROXY_READY" ]; then
    rm -f -- "$PROXY_READY"
  fi
}
trap cleanup_proxy EXIT INT TERM

# The peers expose incompatible reasoning controls. Normalize at the actual provider transport,
# and record Ollama's usage independently of each harness's display/output format.
if [ "${DGC_BENCH_NORMALIZE_THINKING:-1}" = 1 ]; then
  PROXY_READY=$(mktemp)
  rm -f -- "$PROXY_READY"
  usage_log="$OUT/provider-usage-$TAG.jsonl"
  "$PYTHON" "$ROOT/bench/provider_proxy.py" \
    --upstream "$BASE_URL" --ready-file "$PROXY_READY" --usage-log "$usage_log" \
    --context-size "$CONTEXT_SIZE" &
  PROXY_PID=$!
  attempts=0
  while [ ! -s "$PROXY_READY" ] && kill -0 "$PROXY_PID" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 100 ] || { echo "provider proxy did not become ready" >&2; exit 2; }
    sleep 0.1
  done
  [ -s "$PROXY_READY" ] || { echo "provider proxy exited before readiness" >&2; exit 2; }
  proxy_port=$(tr -d '[:space:]' < "$PROXY_READY")
  BENCH_BASE_URL="http://127.0.0.1:$proxy_port/v1"
  export DGC_BENCH_PROVIDER_IDENTITY="$BASE_URL"
  export DGC_BENCH_THINKING_POLICY=transport-reasoning-off
  export DGC_BENCH_USAGE_SOURCE=provider-proxy
  export DGC_BENCH_USAGE_LOG="$usage_log"
  export DGC_BENCH_PROXY_CONTROL="http://127.0.0.1:$proxy_port/__dgc_bench__/flush"
  # A deadline-cancelled harness can disconnect while Ollama is still generating. The proxy drains
  # that upstream stream so its final usage event cannot leak across round/task attribution marks.
  # Match the proxy's 1,800-second upstream bound and fail closed if it never becomes quiescent.
  export DGC_BENCH_USAGE_SYNC_TIMEOUT=${DGC_BENCH_USAGE_SYNC_TIMEOUT:-1860}
  echo "provider normalization proxy: $BENCH_BASE_URL -> $BASE_URL"
else
  export DGC_BENCH_THINKING_POLICY=${DGC_BENCH_THINKING_POLICY:-harness-default}
  export DGC_BENCH_USAGE_SOURCE=${DGC_BENCH_USAGE_SOURCE:-harness-output-if-available}
fi

if [ "${DGC_BENCH_SKIP_REFERENCE_VALIDATION:-0}" != 1 ]; then
  "$PYTHON" "$ROOT/bench/validate_harness.py" all 999 \
    | tee "$OUT/reference-validation-$TAG.log"
fi

safe_model=$(printf '%s' "$MODEL" | sed 's/[^A-Za-z0-9._-]/_/g')
result_files=()
for engine in $ENGINES; do
  run_args=(
    "$PYTHON" "$ROOT/bench/run_bench.py"
    --engine "$engine" --model "$MODEL" --base-url "$BENCH_BASE_URL"
    --context-size "$CONTEXT_SIZE"
    --langs "$LANGS" --rounds "$ROUNDS" --dgc-timeout "$AGENT_TIMEOUT"
    --test-timeout "$TEST_TIMEOUT" --out "$OUT" --tag "$TAG"
  )
  [ "$LIMIT" = 0 ] || run_args+=(--limit "$LIMIT")
  [ -z "$EXERCISES" ] || run_args+=(--exercises "$EXERCISES")
  "${run_args[@]}"
  result_files+=("$OUT/results-$engine-$safe_model-$TAG.jsonl")
done

compare_args=("$PYTHON" "$ROOT/bench/compare.py" "${result_files[@]}"
              --json "$OUT/comparison-$safe_model-$TAG.json")
[ "${DGC_BENCH_ALLOW_PARTIAL:-0}" != 1 ] || compare_args+=(--allow-partial)
"${compare_args[@]}"
