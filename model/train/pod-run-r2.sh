#!/usr/bin/env bash
# r2 cycle: train -> merge -> patch tokenizer class -> convert -> quantize.
# Incorporates every fix learned in r1. Markers in /workspace/status-r2.
set -uo pipefail
export HF_HOME=/workspace/hf
mark() { echo "$1 $(date -u +%H:%M:%S)" >> /workspace/status-r2; }

rm -rf /workspace/out/adapter /workspace/out/merged /workspace/out/checkpoints
mark TRAIN_START
python /workspace/train.py > /workspace/train-r2.log 2>&1
grep -q "adapter saved" /workspace/train-r2.log || { mark TRAIN_FAILED; exit 1; }
mark TRAIN_DONE
grep -q "merged bf16 saved" /workspace/train-r2.log || { mark MERGE_FAILED; exit 1; }
mark MERGE_DONE

# r1 lesson: newer transformers writes a tokenizer_class the converter's
# pinned transformers doesn't know.
sed -i 's/"tokenizer_class": "TokenizersBackend"/"tokenizer_class": "PreTrainedTokenizerFast"/' /workspace/out/merged/tokenizer_config.json

mark CONVERT_START
python /workspace/llama.cpp/convert_hf_to_gguf.py /workspace/out/merged \
  --outfile /workspace/out/oaos-ft-r2-f16.gguf --outtype f16 > /workspace/convert-r2.log 2>&1 \
  || { mark CONVERT_FAILED; exit 1; }
rm -rf /workspace/out/merged
mark CONVERT_DONE

mark QUANT_START
Q=/workspace/llama.cpp/build/bin/llama-quantize
"$Q" /workspace/out/oaos-ft-r2-f16.gguf /workspace/out/oaos-ft-r2.gguf mxfp4_moe >> /workspace/convert-r2.log 2>&1 \
  || { mark QUANT_FAILED; exit 1; }
rm -f /workspace/out/oaos-ft-r2-f16.gguf
mark QUANT_DONE
ls -lh /workspace/out/*.gguf >> /workspace/status-r2
mark ALL_DONE
