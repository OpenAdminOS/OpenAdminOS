#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; BIN="$DIR/bin/llama-b10635"
pkill -x llama-server 2>/dev/null; sleep 3
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
[ "$avail" -lt 15000 ] && { echo "ABORT: only ${avail}MB available"; exit 1; }
echo "memory ok: ${avail}MB"
env LD_LIBRARY_PATH="$BIN" "$BIN/llama-server" --model "$DIR/models/nomic-embed-text-v1.5.Q8_0.gguf" \
  --embedding --host 127.0.0.1 --port 8091 --ctx-size 2048 -ub 2048 -b 2048 > "$DIR/logs/embed-server.log" 2>&1 &
env LD_LIBRARY_PATH="$BIN" "$BIN/llama-server" --model "$DIR/models/oaos-ft-r5.gguf" \
  --host 127.0.0.1 --port 8090 --ctx-size 16384 --n-gpu-layers 99 --jinja \
  --chat-template-file "$DIR/release/openadmin-template.jinja" \
  --log-file "$DIR/logs/llama-server-r5patched.log" >/dev/null 2>&1 &
pid=$!
for i in $(seq 1 36); do sleep 5; [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/health)" = "200" ] && break; done
(cd "$DIR" && node eval/run-eval.mjs --label r5patched-noret --no-retrieval --suite suite-200 | tail -2)
(cd "$DIR" && node eval/run-eval.mjs --label r5patched-ret --suite suite-200 | tail -2)
(cd "$DIR" && node eval/run-eval.mjs --label r5patched-traj2 --suite suite-248 --filter 95 | tail -2)
kill "$pid" 2>/dev/null; pkill -x llama-server 2>/dev/null
echo "PATCHED RUN DONE"
