#!/usr/bin/env bash
# Start llama-server with the current candidate model on the Radeon 780M.
# Binds to localhost only.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/bin/llama-b10635"
MODEL="${MODEL:-$DIR/models/gpt-oss-20b-MXFP4.gguf}"
PORT="${PORT:-8090}"

exec env LD_LIBRARY_PATH="$BIN" "$BIN/llama-server" \
  --model "$MODEL" \
  --host 127.0.0.1 --port "$PORT" \
  --ctx-size 16384 \
  --n-gpu-layers 99 \
  --jinja \
  --log-file "$DIR/logs/llama-server.log"
