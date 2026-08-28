#!/usr/bin/env bash
# Full pod-side pipeline: train -> merge -> convert to GGUF -> quantize.
# Writes progress markers to /workspace/status so the orchestrator can poll.
set -uo pipefail
cd /workspace
mark() { echo "$1 $(date -u +%H:%M:%S)" >> /workspace/status; }

mark TRAIN_START
python /workspace/train.py > /workspace/train.log 2>&1
grep -q "merged bf16 saved" /workspace/train.log || { mark TRAIN_FAILED; exit 1; }
mark TRAIN_DONE

# llama.cpp for conversion + quantization
if [ ! -d /workspace/llama.cpp ]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp /workspace/llama.cpp >> /workspace/convert.log 2>&1
fi
pip install -q -r /workspace/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt >> /workspace/convert.log 2>&1

mark CONVERT_START
python /workspace/llama.cpp/convert_hf_to_gguf.py /workspace/out/merged \
  --outfile /workspace/out/oaos-ft-v1-f16.gguf --outtype f16 >> /workspace/convert.log 2>&1 \
  || { mark CONVERT_FAILED; exit 1; }
mark CONVERT_DONE

mark QUANT_START
cmake -B /workspace/llama.cpp/build /workspace/llama.cpp -DGGML_CUDA=OFF >> /workspace/convert.log 2>&1
cmake --build /workspace/llama.cpp/build --target llama-quantize -j 8 >> /workspace/convert.log 2>&1
Q=/workspace/llama.cpp/build/bin/llama-quantize
# MXFP4 is the native gpt-oss format; fall back to Q4_K_M if unsupported.
"$Q" /workspace/out/oaos-ft-v1-f16.gguf /workspace/out/oaos-ft-v1.gguf mxfp4_moe >> /workspace/convert.log 2>&1 \
  || "$Q" /workspace/out/oaos-ft-v1-f16.gguf /workspace/out/oaos-ft-v1.gguf mxfp4 >> /workspace/convert.log 2>&1 \
  || "$Q" /workspace/out/oaos-ft-v1-f16.gguf /workspace/out/oaos-ft-v1.gguf Q4_K_M >> /workspace/convert.log 2>&1 \
  || { mark QUANT_FAILED; exit 1; }
mark QUANT_DONE
ls -lh /workspace/out/*.gguf >> /workspace/status
mark ALL_DONE
