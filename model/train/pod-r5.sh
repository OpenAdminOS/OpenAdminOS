#!/usr/bin/env bash
# r5 (v1.1 candidate) full pipeline. Every lesson from r1-r4 is baked in.
set -uo pipefail
export HF_HOME=/workspace/hf
mark() { echo "$1 $(date -u +%H:%M:%S)" >> /workspace/status-r5; }

mark ENV_START
# Order matters: llama.cpp's convert requirements pull CPU torch, so install
# every pip dependency FIRST, then pin CUDA torch last and never pip again.
pip install -q unsloth hf_transfer >> /workspace/env.log 2>&1
[ -d /workspace/llama.cpp ] || git clone -q --depth 1 https://github.com/ggml-org/llama.cpp /workspace/llama.cpp >> /workspace/env.log 2>&1
pip install -q -r /workspace/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt mistral-common gguf >> /workspace/env.log 2>&1
pip install -q --force-reinstall torch==2.8.0 --index-url https://download.pytorch.org/whl/cu128 >> /workspace/env.log 2>&1
pip uninstall -q -y xformers >> /workspace/env.log 2>&1
pip install -q --force-reinstall --no-deps --no-cache-dir --index-url https://download.pytorch.org/whl/cu128 "torchvision==0.23.0" >> /workspace/env.log 2>&1
python -c "import torch,unsloth; assert torch.cuda.is_available()" >> /workspace/env.log 2>&1 || { mark ENV_FAILED; exit 1; }
command -v cmake >/dev/null || { apt-get update -qq && apt-get install -y -qq cmake >> /workspace/env.log 2>&1; }
mark ENV_DONE

mark TRAIN_START
python /workspace/train.py > /workspace/train-r5.log 2>&1
grep -q "merged bf16 saved" /workspace/train-r5.log || { mark TRAIN_FAILED; exit 1; }
mark TRAIN_DONE

sed -i 's/"tokenizer_class": "TokenizersBackend"/"tokenizer_class": "PreTrainedTokenizerFast"/' /workspace/out/merged/tokenizer_config.json
mark CONVERT_START
python /workspace/llama.cpp/convert_hf_to_gguf.py /workspace/out/merged \
  --outfile /workspace/out/oaos-ft-r5-f16.gguf --outtype f16 > /workspace/convert-r5.log 2>&1 \
  || { mark CONVERT_FAILED; exit 1; }
rm -rf /workspace/out/merged
mark CONVERT_DONE

mark QUANT_START
cmake -B /workspace/llama.cpp/build /workspace/llama.cpp -DGGML_CUDA=OFF -DLLAMA_CURL=OFF >> /workspace/convert-r5.log 2>&1
cmake --build /workspace/llama.cpp/build --target llama-quantize -j 16 >> /workspace/convert-r5.log 2>&1
/workspace/llama.cpp/build/bin/llama-quantize /workspace/out/oaos-ft-r5-f16.gguf /workspace/out/oaos-ft-r5.gguf mxfp4_moe >> /workspace/convert-r5.log 2>&1 \
  || { mark QUANT_FAILED; exit 1; }
rm -f /workspace/out/oaos-ft-r5-f16.gguf
mark QUANT_DONE
ls -lh /workspace/out/*.gguf /workspace/out/adapter >> /workspace/status-r5
mark ALL_DONE
