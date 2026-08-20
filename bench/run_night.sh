#!/usr/bin/env bash
# 1 AM launcher for the DGC polyglot benchmark. One model per night.
#   bash run_night.sh 1     # qwen3.8:27b-q4km   (ollama)
#   bash run_night.sh 2     # qwen122b-code      (ollama, 81GB — free others first)
#   bash run_night.sh 3     # DS4                (llama.cpp on-demand, ~96GB)
# Free GPU/unified memory FIRST (stop Chatterbox TTS :5126 / STT :5127, idle other
# ollama models). This script only does a memory preflight + launch — it does NOT
# stop services (that's a deliberate step we do together).
set -euo pipefail
cd "$(dirname "$0")"

NIGHT="${1:?usage: run_night.sh <1|2|3>}"
case "$NIGHT" in
  # per-round WALL timeout — the only TOTAL bound in the stack; peers never wall-kill a
  # stream, so this must cover a full multi-turn agentic solve (not one request). Peer-
  # calibrated: 1200s (20m) balanced; slower models get more. LLM read-idle stays 1800s.
  1) MODEL="qwen3.8:27b-q4km";     BASE="http://localhost:11434/v1"; KEY="ollama";   TIMEOUT=1200; NEED=25 ;;
  2) MODEL="qwen122b-code:latest"; BASE="http://localhost:11434/v1"; KEY="ollama";   TIMEOUT=1800; NEED=85 ;;
  3) MODEL="ds4";                  BASE="http://127.0.0.1:11440/v1"; KEY="sk-local"; TIMEOUT=2400; NEED=96 ;;
  *) echo "unknown night '$NIGHT' (use 1, 2, or 3)"; exit 1 ;;
esac
TAG="night${NIGHT}"

AVAIL=$(free -g | awk '/^Mem:/{print $7}')
echo "== night $NIGHT: $MODEL =="
echo "   base=$BASE  timeout=${TIMEOUT}s  tag=$TAG"
echo "   memory available: ${AVAIL} GiB  (this model wants ~${NEED} GiB)"
if [ "$AVAIL" -lt "$NEED" ]; then
  echo "   ⚠ NOT enough free memory — stop TTS/STT + idle other models, then re-run."
  echo "     Chatterbox TTS :5126, Whisper STT :5127; ollama models can be idled with 'ollama stop <m>'."
  [ "$NIGHT" = "3" ] && echo "     DS4 also needs: systemctl --user reset-failed openpeach-ds4.service ds4-proxy.{service,socket}; then prewarm :11440."
  exit 2
fi

mkdir -p results
LOG="results/${TAG}.log"
echo "   launching → $LOG   (tail -f to watch; resumable if interrupted)"
nohup python3 run_bench.py \
  --model "$MODEL" --base-url "$BASE" --api-key "$KEY" \
  --langs all --rounds 2 --dgc-timeout "$TIMEOUT" --test-timeout 300 \
  --out results/ --tag "$TAG" > "$LOG" 2>&1 &
echo "   pid $!  — full 225 running in the background."
