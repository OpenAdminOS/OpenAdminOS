#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; BIN="$DIR/bin/llama-b10635"
pkill -x llama-server 2>/dev/null; sleep 3
env LD_LIBRARY_PATH="$BIN" "$BIN/llama-server" --model "$DIR/models/nomic-embed-text-v1.5.Q8_0.gguf" \
  --embedding --host 127.0.0.1 --port 8091 --ctx-size 2048 -ub 2048 -b 2048 > "$DIR/logs/embed-server.log" 2>&1 &
sleep 10
curl -s -o /dev/null -w 'embed: %{http_code}\n' http://127.0.0.1:8091/health
for spec in "qwen35-4b:qwen35-4b.gguf" "granite41-3b:granite41-3b.gguf"; do
  label="${spec%%:*}"; f="${spec#*:}"
  echo "=== $label"
  env LD_LIBRARY_PATH="$BIN" "$BIN/llama-server" --model "$DIR/models/$f" --host 127.0.0.1 --port 8090 \
    --ctx-size 32768 --n-gpu-layers 99 --jinja > "$DIR/logs/srv-$label.log" 2>&1 &
  pid=$!
  ok=0; for i in $(seq 1 36); do sleep 5; [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/health)" = "200" ] && ok=1 && break; done
  [ "$ok" = "1" ] || { echo "$label FAILED to start"; kill $pid 2>/dev/null; continue; }
  # fail fast if retrieval is unreachable (the mistake that invalidated the first granite run)
  curl -s -o /dev/null -w '' http://127.0.0.1:8091/health || { echo "EMBED DOWN"; exit 1; }
  (cd "$DIR" && node eval/run-eval.mjs --label "$label-base-ret" --suite suite-200 | tail -1)
  kill $pid 2>/dev/null; wait $pid 2>/dev/null; sleep 3
done
pkill -x llama-server 2>/dev/null
echo "SMALL BAKEOFF DONE"
