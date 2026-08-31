#!/usr/bin/env bash
# 1 AM launcher for the DGC polyglot benchmark. One model per night.
#   bash run_night.sh 1     # qwen3.8-bench-64k   (Ollama alias with baked num_ctx)
#   bash run_night.sh 2     # qwen122b-code-bench-64k (Ollama alias, 81GB)
# Free GPU/unified memory FIRST (stop other GPU services, idle other ollama
# models). This script only does a memory preflight + launch — it does NOT
# stop services (that's a deliberate step we do together).
set -euo pipefail
cd "$(dirname "$0")"

NIGHT="${1:?usage: run_night.sh <1|2|3>}"
case "$NIGHT" in
  # per-round WALL timeout — the only TOTAL bound in the stack; peers never wall-kill a
  # stream, so this must cover a full multi-turn agentic solve (not one request). Peer-
  # calibrated: 1200s (20m) balanced; slower models get more. LLM read-idle stays 1800s.
  1) MODEL="qwen3.8-bench-64k";          BASE="http://localhost:11434/v1"; KEY="ollama"; TIMEOUT=1200; NEED=25 ;;
  2) MODEL="qwen122b-code-bench-64k";    BASE="http://localhost:11434/v1"; KEY="ollama"; TIMEOUT=1800; NEED=85 ;;
  3) echo "night 3 used an unverifiable llama.cpp context and is no longer a controlled run"; exit 2 ;;
  *) echo "unknown night '$NIGHT' (use 1 or 2)"; exit 1 ;;
esac
TAG="night${NIGHT}"
CONTEXT_SIZE=${DGC_BENCH_CONTEXT_SIZE:-65536}

AVAIL=$(free -g | awk '/^Mem:/{print $7}')
echo "== night $NIGHT: $MODEL =="
echo "   base=$BASE  timeout=${TIMEOUT}s  tag=$TAG"
echo "   memory available: ${AVAIL} GiB  (this model wants ~${NEED} GiB)"
if [ "$AVAIL" -lt "$NEED" ]; then
  echo "   ⚠ NOT enough free memory — idle other GPU services and models, then re-run."
  echo "     ollama models can be idled with 'ollama stop <model>'."
  exit 2
fi

mkdir -p results
LOG="results/${TAG}.log"
echo "   launching → $LOG   (tail -f to watch; resumable if interrupted)"
DGC_BENCH_API_KEY="$KEY" nohup python3 run_bench.py \
  --model "$MODEL" --base-url "$BASE" --context-size "$CONTEXT_SIZE" \
  --langs all --rounds 2 --dgc-timeout "$TIMEOUT" --test-timeout 300 \
  --out results/ --tag "$TAG" > "$LOG" 2>&1 &
echo "   pid $!  — full 225 running in the background."
