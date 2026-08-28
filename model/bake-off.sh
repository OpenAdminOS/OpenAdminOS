#!/usr/bin/env bash
# Run the eval suite (with and without retrieval) for each model given as
# "label=modelfile" arguments. Assumes the embedding server is running on 8091.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/bin/llama-b10635"

# Memory guard: this box has 27GB and each checkpoint is ~12GB resident.
# Never run two model servers at once, and refuse to start if the machine is
# already low (the t3 app was OOM-killed once by exactly this).
require_memory() {
  pkill -x llama-server 2>/dev/null
  sleep 3
  local avail_mb
  avail_mb=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  if [ "$avail_mb" -lt 15000 ]; then
    echo "ABORT: only ${avail_mb}MB available, need >=15000MB for a 12GB checkpoint"
    exit 1
  fi
  echo "memory ok: ${avail_mb}MB available"
}

start_embed() {
  pgrep -f "llama-server.*8091" >/dev/null && return 0
  env LD_LIBRARY_PATH="$BIN" "$BIN/llama-server" \
    --model "$DIR/models/nomic-embed-text-v1.5.Q8_0.gguf" --embedding \
    --host 127.0.0.1 --port 8091 --ctx-size 2048 -ub 2048 -b 2048 \
    > "$DIR/logs/embed-server.log" 2>&1 &
  sleep 6
}

for spec in "$@"; do
  label="${spec%%=*}"
  file="${spec#*=}"
  echo "=== $label ($file) ==="
  require_memory
  start_embed
  env LD_LIBRARY_PATH="$BIN" "$BIN/llama-server" \
    --model "$DIR/models/$file" \
    --host 127.0.0.1 --port 8090 \
    --ctx-size 16384 --n-gpu-layers 99 --jinja \
    --log-file "$DIR/logs/llama-server-$label.log" >/dev/null 2>&1 &
  pid=$!
  ready=0
  for i in $(seq 1 36); do
    sleep 5
    if [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/health)" = "200" ]; then ready=1; break; fi
    kill -0 "$pid" 2>/dev/null || break
  done
  if [ "$ready" != "1" ]; then
    echo "SERVER FAILED for $label; skipping"
    kill "$pid" 2>/dev/null
    continue
  fi
  SUITE_ARG=""
  [ -n "${SUITE:-}" ] && SUITE_ARG="--suite $SUITE"
  (cd "$DIR" && node eval/run-eval.mjs --label "$label-noret" --no-retrieval $SUITE_ARG | tail -2)
  (cd "$DIR" && node eval/run-eval.mjs --label "$label-ret" $SUITE_ARG | tail -2)
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  sleep 5
done
pkill -x llama-server 2>/dev/null
echo "BAKE-OFF DONE"
