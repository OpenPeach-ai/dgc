#!/usr/bin/env bash
# Run every harness on one controlled model/task/hardware configuration.
#
# Sequential by default. DGC_BENCH_PARALLEL=1 runs every harness at once, one language at a time,
# and starts the next language only when all have finished, so a provider that slows down or changes
# during a long league affects every harness alike. Each harness has its own accounting proxy.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PYTHON=${DGC_BENCH_PYTHON:-"$ROOT/.venv/bin/python"}
[ -x "$PYTHON" ] || PYTHON=python3
MODEL=${1:?usage: run_league.sh <model> [base-url] [tag]}
BASE_URL=${2:-http://localhost:11434/v1}
TAG=${3:-league}
OUT=${DGC_BENCH_OUT:-"$ROOT/bench/results"}
ENGINES=${DGC_BENCH_ENGINES:-"dgc aider codex goose opencode pi claude"}
LANGS=${DGC_BENCH_LANGS:-all}
LIMIT=${DGC_BENCH_LIMIT:-0}
EXERCISES=${DGC_BENCH_EXERCISES:-}
ROUNDS=${DGC_BENCH_ROUNDS:-2}
AGENT_TIMEOUT=${DGC_BENCH_AGENT_TIMEOUT:-1200}
TEST_TIMEOUT=${DGC_BENCH_TEST_TIMEOUT:-400}
CONTEXT_SIZE=${DGC_BENCH_CONTEXT_SIZE:-}
# baked: a local alias with a baked num_ctx. provider-fixed: an Ollama Cloud model at its full context.
CONTEXT_POLICY=${DGC_BENCH_CONTEXT_POLICY:-baked}
PARALLEL=${DGC_BENCH_PARALLEL:-0}

[ -n "${DGC_BENCH_MODEL_DIGEST:-}" ] || {
  echo "DGC_BENCH_MODEL_DIGEST is required for a publishable league" >&2; exit 2;
}
[ -n "${DGC_BENCH_HARDWARE:-}" ] || {
  echo "DGC_BENCH_HARDWARE is required for a publishable league" >&2; exit 2;
}
[ -n "$CONTEXT_SIZE" ] || {
  echo "DGC_BENCH_CONTEXT_SIZE is required: a baked alias's num_ctx, or a cloud model's full context" >&2
  exit 2
}
case "$CONTEXT_POLICY" in
  baked|provider-fixed) ;;
  *) echo "DGC_BENCH_CONTEXT_POLICY must be baked or provider-fixed" >&2; exit 2 ;;
esac
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
declare -A PROXY_PID=() PROXY_PORT=() USAGE_LOG=()
cleanup_proxies() {
  local engine
  for engine in "${!PROXY_PID[@]}"; do
    kill "${PROXY_PID[$engine]}" 2>/dev/null || true
    wait "${PROXY_PID[$engine]}" 2>/dev/null || true
  done
}
trap cleanup_proxies EXIT INT TERM

# The peers expose incompatible reasoning controls. Normalize at the actual provider transport,
# and record Ollama's usage independently of each harness's display/output format. One proxy per
# harness keeps usage attribution exact when harnesses run at the same time.
NORMALIZE=${DGC_BENCH_NORMALIZE_THINKING:-1}
if [ "$NORMALIZE" = 1 ]; then
  # A cloud model's context cannot be pinned per request; only a baked local alias is.
  proxy_context=$CONTEXT_SIZE
  [ "$CONTEXT_POLICY" = baked ] || proxy_context=0
  for engine in $ENGINES; do
    ready=$(mktemp)
    rm -f -- "$ready"
    USAGE_LOG[$engine]="$OUT/provider-usage-$TAG-$engine.jsonl"
    "$PYTHON" "$ROOT/bench/provider_proxy.py" \
      --upstream "$BASE_URL" --ready-file "$ready" --usage-log "${USAGE_LOG[$engine]}" \
      --context-size "$proxy_context" &
    PROXY_PID[$engine]=$!
    attempts=0
    while [ ! -s "$ready" ] && kill -0 "${PROXY_PID[$engine]}" 2>/dev/null; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 100 ] || { echo "provider proxy for $engine did not become ready" >&2; exit 2; }
      sleep 0.1
    done
    [ -s "$ready" ] || { echo "provider proxy for $engine exited before readiness" >&2; exit 2; }
    PROXY_PORT[$engine]=$(tr -d '[:space:]' < "$ready")
    rm -f -- "$ready"
    echo "provider normalization proxy ($engine): http://127.0.0.1:${PROXY_PORT[$engine]}/v1 -> $BASE_URL"
  done
  export DGC_BENCH_PROVIDER_IDENTITY="$BASE_URL"
  export DGC_BENCH_THINKING_POLICY=transport-reasoning-off
  export DGC_BENCH_USAGE_SOURCE=provider-proxy
  # A deadline-cancelled harness can disconnect while Ollama is still generating. The proxy drains
  # that upstream stream so its final usage event cannot leak across round/task attribution marks.
  # Match the proxy's 1,800-second upstream bound and fail closed if it never becomes quiescent.
  export DGC_BENCH_USAGE_SYNC_TIMEOUT=${DGC_BENCH_USAGE_SYNC_TIMEOUT:-1860}
else
  export DGC_BENCH_THINKING_POLICY=${DGC_BENCH_THINKING_POLICY:-harness-default}
  export DGC_BENCH_USAGE_SOURCE=${DGC_BENCH_USAGE_SOURCE:-harness-output-if-available}
fi

if [ "${DGC_BENCH_SKIP_REFERENCE_VALIDATION:-0}" != 1 ]; then
  "$PYTHON" "$ROOT/bench/validate_harness.py" all 999 \
    | tee "$OUT/reference-validation-$TAG.log"
fi

safe_model=$(printf '%s' "$MODEL" | sed 's/[^A-Za-z0-9._-]/_/g')
# One harness over the given language block (empty = every selected language).
run_engine() {
  local engine=$1 block=$2 base=$BASE_URL
  local run_env=()
  if [ "$NORMALIZE" = 1 ]; then
    base="http://127.0.0.1:${PROXY_PORT[$engine]}/v1"
    run_env=(DGC_BENCH_USAGE_LOG="${USAGE_LOG[$engine]}"
             DGC_BENCH_PROXY_CONTROL="http://127.0.0.1:${PROXY_PORT[$engine]}/__dgc_bench__/flush")
  fi
  local run_args=(
    "$PYTHON" "$ROOT/bench/run_bench.py"
    --engine "$engine" --model "$MODEL" --base-url "$base"
    --context-size "$CONTEXT_SIZE" --context-policy "$CONTEXT_POLICY"
    --langs "$LANGS" --rounds "$ROUNDS" --dgc-timeout "$AGENT_TIMEOUT"
    --test-timeout "$TEST_TIMEOUT" --out "$OUT" --tag "$TAG"
  )
  [ "$LIMIT" = 0 ] || run_args+=(--limit "$LIMIT")
  [ -z "$EXERCISES" ] || run_args+=(--exercises "$EXERCISES")
  [ -z "$block" ] || run_args+=(--block-langs "$block")
  env "${run_env[@]}" "${run_args[@]}"
}

result_files=()
for engine in $ENGINES; do
  result_files+=("$OUT/results-$engine-$safe_model-$TAG.jsonl")
done
if [ "$PARALLEL" = 1 ]; then
  if [ "$LANGS" = all ]; then blocks="cpp go java javascript python rust"; else blocks=${LANGS//,/ }; fi
  failed=()
  for block in $blocks; do
    echo "== $block: $ENGINES (in parallel)"
    declare -A job=()
    for engine in $ENGINES; do
      run_engine "$engine" "$block" >> "$OUT/log-$engine-$safe_model-$TAG.txt" 2>&1 &
      job[$engine]=$!
    done
    for engine in $ENGINES; do
      if ! wait "${job[$engine]}"; then
        failed+=("$engine/$block")
        echo "  $engine failed on $block (see $OUT/log-$engine-$safe_model-$TAG.txt)" >&2
      fi
    done
    unset job
  done
  [ ${#failed[@]} = 0 ] || { echo "league incomplete: ${failed[*]}" >&2; exit 1; }
else
  for engine in $ENGINES; do
    run_engine "$engine" ""
  done
fi

compare_args=("$PYTHON" "$ROOT/bench/compare.py" "${result_files[@]}"
              --json "$OUT/comparison-$safe_model-$TAG.json")
[ "${DGC_BENCH_ALLOW_PARTIAL:-0}" != 1 ] || compare_args+=(--allow-partial)
"${compare_args[@]}"
