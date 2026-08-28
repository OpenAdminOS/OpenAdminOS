# QLoRA fine-tune of Ministral 3 8B on the OpenAdminOS SFT dataset.
# Mistral format, not harmony: no channel markers, no analysis channel.
# Small models need more passes than the 20B to internalise a format, so this
# runs more epochs at a lower rank-to-parameter ratio.

import json, hashlib

MAX_SEQ = 4096
# Mistral ships FP8 weights, which Unsloth refuses below compute capability 8.9
# (our A40 is 8.6). Unsloth mirrors the same model unquantized.
BASE = "unsloth/Ministral-3-8B-Instruct-2512"
IDENTITY = ("You are OpenAdmin Lite, an open-source model for Microsoft 365 administration, "
            "fine-tuned from Ministral 3 8B by the OpenAdminOS community.")

rows = [json.loads(l) for l in open("/workspace/data/train.jsonl") if l.strip()]
data_hash = hashlib.sha256(open("/workspace/data/train.jsonl", "rb").read()).hexdigest()[:16]
print(f"dataset: {len(rows)} examples | sha256:{data_hash}", flush=True)

from transformers import AutoTokenizer
from huggingface_hub import snapshot_download
import os, json as _json

# Ministral ships tokenizer_class="TokenizersBackend", which older transformers
# cannot resolve (same failure we hit packaging the 20B). Pull the repo once,
# rewrite that one field, and work from the local copy everywhere after.
LOCAL = snapshot_download(BASE, local_dir="/workspace/base-mini")
_tc = os.path.join(LOCAL, "tokenizer_config.json")
_cfg = _json.load(open(_tc))
# transformers 4.57 predates this Dec-2025 model and rejects two fields as
# shipped. Both must be fixed together or the tokenizer will not load:
#   extra_special_tokens: list -> mapping
#   additional_special_tokens: list of serialized dicts -> list of strings
_patched = []
if isinstance(_cfg.get("extra_special_tokens"), list):
    _cfg["extra_special_tokens"] = {t: t for t in _cfg["extra_special_tokens"]}
    _patched.append("extra_special_tokens")
_add = _cfg.get("additional_special_tokens")
if isinstance(_add, list) and _add and isinstance(_add[0], dict):
    _cfg["additional_special_tokens"] = [x.get("content") for x in _add if isinstance(x, dict) and x.get("content")]
    _patched.append("additional_special_tokens")
if _cfg.get("tokenizer_class") == "TokenizersBackend":
    _cfg["tokenizer_class"] = "PreTrainedTokenizerFast"
    _patched.append("tokenizer_class")
if _patched:
    _json.dump(_cfg, open(_tc, "w"), indent=2)
    print("patched tokenizer config:", ", ".join(_patched), flush=True)
BASE = LOCAL
# Mistral ships a tokenizer regex that mis-splits text without this flag;
# training on wrongly-tokenized text would corrupt the run silently.
tokenizer = AutoTokenizer.from_pretrained(BASE, fix_mistral_regex=True)


def to_text(ex):
    msgs = []
    for m in ex["messages"]:
        m = {k: v for k, v in dict(m).items() if v is not None}
        m.pop("thinking", None)          # Mistral has no analysis channel
        if m.get("role") == "system":
            # Keep one honest identity line; the small model must not claim to
            # be the 20B (that was the r5 identity failure, in reverse).
            m["content"] = IDENTITY + " " + m.get("content", "")
        msgs.append(m)
    return tokenizer.apply_chat_template(
        msgs, tools=ex.get("tools") or None, tokenize=False, add_generation_prompt=False,
    )


texts = []
for i, ex in enumerate(rows):
    try:
        texts.append(to_text(ex))
    except Exception as e:
        raise SystemExit(f"RENDER FAILED at {i}: {type(e).__name__}: {e}\n{json.dumps(ex)[:600]}")
tool_n = sum("graph_get" in t for t in texts)
print(f"rendered {len(texts)} examples | {tool_n} with tool calls", flush=True)
print("SAMPLE:", texts[0][:400].replace("\n", " | "), flush=True)

from datasets import Dataset
from unsloth import FastLanguageModel

model, tokenizer = FastLanguageModel.from_pretrained(BASE, max_seq_length=MAX_SEQ, load_in_4bit=True)
model = FastLanguageModel.get_peft_model(
    model, r=32, lora_alpha=64, lora_dropout=0.0, bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth", random_state=42,
)

ds = Dataset.from_dict({"text": texts}).shuffle(seed=42)
from trl import SFTConfig, SFTTrainer

trainer = SFTTrainer(
    model=model, tokenizer=tokenizer, train_dataset=ds,
    args=SFTConfig(
        dataset_text_field="text", max_seq_length=MAX_SEQ,
        per_device_train_batch_size=2, gradient_accumulation_steps=4,
        num_train_epochs=4, learning_rate=1e-4, lr_scheduler_type="cosine",
        warmup_steps=20, logging_steps=10, optim="adamw_8bit", weight_decay=0.01,
        seed=42, output_dir="/workspace/out/checkpoints",
        save_strategy="steps", save_steps=300, save_total_limit=3,
        report_to="none", bf16=True,
    ),
)

# Mistral wire format: instructions are wrapped in [INST]...[/INST] and the
# response follows. Masking to the response keeps the model from spending
# capacity learning to predict user turns and tool output.
from unsloth.chat_templates import train_on_responses_only
trainer = train_on_responses_only(trainer, instruction_part="[INST]", response_part="[/INST]")
print("loss masked to assistant turns", flush=True)

print(trainer.train(), flush=True)
model.save_pretrained("/workspace/out/adapter")
tokenizer.save_pretrained("/workspace/out/adapter")
print("adapter saved", flush=True)
model.save_pretrained_merged("/workspace/out/merged", tokenizer, save_method="merged_16bit")
print("merged bf16 saved", flush=True)
