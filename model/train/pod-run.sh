#!/usr/bin/env bash
# One pod pipeline for both tiers: train -> merge -> GGUF -> quantize.
#
# Replaces pod-run.sh, pod-run-r2.sh, pod-r5.sh and pipeline2.sh, which were
# copy-pasted per run. That lineage is how constants drifted between runs: r5
# pinned torch inside the env block, pipeline2 pinned a different version, and
# the two disagreed about which stages were restart-safe.
#
# Usage:
#   pod-run.sh <run-id> [--tier 8b|20b] [--from-adapter] [--skip-env]
#
#   <run-id>        names every artifact and log, e.g. r17, 8b-r17
#   --tier          8b  = Ministral 3 8B  -> train-mini.py, Q4_K_M   (default)
#                   20b = gpt-oss-20b     -> train.py,      mxfp4_moe
#   --from-adapter  skip training, merge an adapter already in /workspace/out
#   --skip-env      assume the environment is built (template or warm volume)
#
# Expects on the pod: /workspace/data/train.jsonl and the tier's train script.
# Restart-safe: stage markers land in /workspace/status-<run-id>, and each
# stage checks for its own output before redoing work.
set -uo pipefail

RUN=""
TIER="8b"
FROM_ADAPTER=0
SKIP_ENV=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tier) TIER="${2:-}"; shift 2 ;;
    --from-adapter) FROM_ADAPTER=1; shift ;;
    --skip-env) SKIP_ENV=1; shift ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) RUN="$1"; shift ;;
  esac
done
[ -n "$RUN" ] || { echo "usage: pod-run.sh <run-id> [--tier 8b|20b] [--from-adapter] [--skip-env]" >&2; exit 2; }

case "$TIER" in
  8b)  TRAIN_SCRIPT=train-mini.py; QUANTS="Q4_K_M" ;;
  # mxfp4 is the native format for gpt-oss; fall back rather than fail a run
  # that already spent its GPU hours on training.
  20b) TRAIN_SCRIPT=train.py;      QUANTS="mxfp4_moe mxfp4 Q4_K_M" ;;
  *) echo "unknown tier: $TIER (expected 8b or 20b)" >&2; exit 2 ;;
esac

# This runs on the pod, not the workstation. Failing here with a clear message
# beats emitting one redirect error per stage against a path that cannot exist.
[ -d /workspace ] || { echo "pod-run.sh must run on the pod: /workspace not found" >&2; exit 2; }

export HF_HOME=/workspace/hf
OUT=/workspace/out
STATUS="/workspace/status-$RUN"
LOG_ENV="/workspace/env-$RUN.log"
LOG_TRAIN="/workspace/train-$RUN.log"
LOG_CONVERT="/workspace/convert-$RUN.log"
F16="$OUT/oaos-ft-$RUN-f16.gguf"
FINAL="$OUT/oaos-ft-$RUN.gguf"

mark() { echo "$1 $(date -u +%H:%M:%S)" >> "$STATUS"; }
die()  { mark "$1"; echo "FAILED: $1 (see $2)" >&2; exit 1; }

mark "RUN_START tier=$TIER"

# ---------------------------------------------------------------- environment
# Order matters and is not negotiable: llama.cpp's convert requirements pull a
# CPU build of torch, so every pip dependency is installed FIRST and the CUDA
# torch pin comes LAST. Any pip install after that line can silently swap torch
# back to CPU, and the failure only shows up as "no CUDA" minutes into training.
if [ "$SKIP_ENV" -eq 0 ] && ! python -c "import torch,unsloth" >/dev/null 2>&1; then
  mark ENV_START
  pip install -q unsloth hf_transfer >> "$LOG_ENV" 2>&1
  [ -d /workspace/llama.cpp ] || git clone -q --depth 1 \
    https://github.com/ggml-org/llama.cpp /workspace/llama.cpp >> "$LOG_ENV" 2>&1
  pip install -q -r /workspace/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt \
    mistral-common gguf >> "$LOG_ENV" 2>&1
  pip install -q --force-reinstall torch==2.8.0 \
    --index-url https://download.pytorch.org/whl/cu128 >> "$LOG_ENV" 2>&1
  pip uninstall -q -y xformers >> "$LOG_ENV" 2>&1
  pip install -q --force-reinstall --no-deps --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cu128 "torchvision==0.23.0" >> "$LOG_ENV" 2>&1
  python -c "import torch,unsloth; assert torch.cuda.is_available()" >> "$LOG_ENV" 2>&1 \
    || die ENV_FAILED "$LOG_ENV"
  command -v cmake >/dev/null || {
    apt-get update -qq && apt-get install -y -qq cmake >> "$LOG_ENV" 2>&1; }
  mark ENV_DONE
else
  mark ENV_SKIPPED
fi

# -------------------------------------------------------------------- training
if [ "$FROM_ADAPTER" -eq 1 ]; then
  mark TRAIN_SKIPPED
  [ -d "$OUT/adapter" ] || die NO_ADAPTER "$OUT"
else
  mark TRAIN_START
  [ -f "/workspace/data/train.jsonl" ] || die NO_DATASET /workspace/data
  python "/workspace/$TRAIN_SCRIPT" > "$LOG_TRAIN" 2>&1
  # train.py aborts loudly if assistant-only loss masking fails; treat a
  # missing success line as failure rather than converting a broken merge.
  grep -q "merged bf16 saved" "$LOG_TRAIN" || die TRAIN_FAILED "$LOG_TRAIN"
  mark TRAIN_DONE
fi

# ------------------------------------------------------------------ conversion
if [ ! -f "$FINAL" ]; then
  # Ministral ships tokenizer_class="TokenizersBackend", which the converter
  # cannot resolve. Harmless on the 20B, so it runs unconditionally.
  [ -f "$OUT/merged/tokenizer_config.json" ] && sed -i \
    's/"tokenizer_class": "TokenizersBackend"/"tokenizer_class": "PreTrainedTokenizerFast"/' \
    "$OUT/merged/tokenizer_config.json"

  if [ ! -f "$F16" ]; then
    mark CONVERT_START
    python /workspace/llama.cpp/convert_hf_to_gguf.py "$OUT/merged" \
      --outfile "$F16" --outtype f16 > "$LOG_CONVERT" 2>&1 || die CONVERT_FAILED "$LOG_CONVERT"
    mark CONVERT_DONE
  fi
  rm -rf "$OUT/merged"

  mark QUANT_START
  Q=/workspace/llama.cpp/build/bin/llama-quantize
  if [ ! -x "$Q" ]; then
    cmake -B /workspace/llama.cpp/build /workspace/llama.cpp \
      -DGGML_CUDA=OFF -DLLAMA_CURL=OFF >> "$LOG_CONVERT" 2>&1
    cmake --build /workspace/llama.cpp/build --target llama-quantize -j 16 >> "$LOG_CONVERT" 2>&1
  fi
  QUANTIZED=0
  for FMT in $QUANTS; do
    if "$Q" "$F16" "$FINAL" "$FMT" >> "$LOG_CONVERT" 2>&1; then
      mark "QUANT_FORMAT=$FMT"; QUANTIZED=1; break
    fi
  done
  [ "$QUANTIZED" -eq 1 ] || die QUANT_FAILED "$LOG_CONVERT"
  rm -f "$F16"
  mark QUANT_DONE
fi

# The size is the thing to check before terminating the pod: a truncated
# download of r6 cost us the run, and a 269 MB "GGUF" looks fine in a log.
{ echo "--- artifacts for $RUN ---"; ls -lh "$FINAL"; ls -ld "$OUT/adapter"; } >> "$STATUS"
mark ALL_DONE
echo "DONE $RUN -> $FINAL"
echo "Verify the byte count after download BEFORE terminating the pod."
