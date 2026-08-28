#!/usr/bin/env bash
# Merge adapter -> bf16, convert to GGUF, quantize. Restart-safe:
# HF cache lives on the volume, markers in /workspace/status2.
set -uo pipefail
export HF_HOME=/workspace/hf
mark() { echo "$1 $(date -u +%H:%M:%S)" >> /workspace/status2; }

mark ENV_START
python -c "import unsloth" 2>/dev/null || {
  pip install -q unsloth hf_transfer
  pip install -q --force-reinstall torch==2.8.0 --index-url https://download.pytorch.org/whl/cu128
  pip uninstall -q -y xformers
  pip install -q --force-reinstall --no-deps --no-cache-dir --index-url https://download.pytorch.org/whl/cu128 "torchvision==0.23.0"
}
python -c "import unsloth" || { mark ENV_FAILED; exit 1; }
mark ENV_DONE

mark MERGE_START
python - <<'PY' > /workspace/merge.log 2>&1
import os
os.environ.setdefault("HF_HOME", "/workspace/hf")
from unsloth import FastLanguageModel
model, tokenizer = FastLanguageModel.from_pretrained(
    "/workspace/out/adapter", max_seq_length=4096, load_in_4bit=True)
model.save_pretrained_merged("/workspace/out/merged", tokenizer, save_method="merged_16bit")
print("merged bf16 saved")
PY
grep -q "merged bf16 saved" /workspace/merge.log || { mark MERGE_FAILED; exit 1; }
mark MERGE_DONE

mark CONVERT_START
pip install -q -r /workspace/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt mistral-common gguf > /workspace/convert.log 2>&1
python /workspace/llama.cpp/convert_hf_to_gguf.py /workspace/out/merged \
  --outfile /workspace/out/oaos-ft-r1-f16.gguf --outtype f16 >> /workspace/convert.log 2>&1 \
  || { mark CONVERT_FAILED; exit 1; }
rm -rf /workspace/out/merged
mark CONVERT_DONE

mark QUANT_START
command -v cmake >/dev/null || { apt-get update -qq && apt-get install -y -qq cmake > /dev/null 2>&1; }
cmake -B /workspace/llama.cpp/build /workspace/llama.cpp -DGGML_CUDA=OFF -DLLAMA_CURL=OFF >> /workspace/convert.log 2>&1
cmake --build /workspace/llama.cpp/build --target llama-quantize -j 16 >> /workspace/convert.log 2>&1
Q=/workspace/llama.cpp/build/bin/llama-quantize
"$Q" /workspace/out/oaos-ft-r1-f16.gguf /workspace/out/oaos-ft-r1.gguf mxfp4_moe >> /workspace/convert.log 2>&1 \
  || "$Q" /workspace/out/oaos-ft-r1-f16.gguf /workspace/out/oaos-ft-r1.gguf mxfp4 >> /workspace/convert.log 2>&1 \
  || "$Q" /workspace/out/oaos-ft-r1-f16.gguf /workspace/out/oaos-ft-r1.gguf Q4_K_M >> /workspace/convert.log 2>&1 \
  || { mark QUANT_FAILED; exit 1; }
mark QUANT_DONE
ls -lh /workspace/out/*.gguf >> /workspace/status2
mark ALL_DONE
