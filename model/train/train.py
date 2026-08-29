# QLoRA fine-tune of gpt-oss-20b on the OpenAdminOS SFT dataset.
# Runs on a single 24GB+ GPU via Unsloth. Expects /workspace/data/train.jsonl
# (one {"messages":[...], "tools": [...]?} per line). Produces
# /workspace/out/adapter and /workspace/out/merged (bf16, for GGUF).

import json

MAX_SEQ = 4096
BASE = "unsloth/gpt-oss-20b"
MODEL_IDENTITY = ("You are OpenAdmin, an open-source model for Microsoft 365 administration, "
                  "fine-tuned from gpt-oss-20b by the OpenAdminOS community.")

rows = [json.loads(l) for l in open("/workspace/data/train.jsonl") if l.strip()]
import hashlib, subprocess
data_hash = hashlib.sha256(open("/workspace/data/train.jsonl", "rb").read()).hexdigest()[:16]
print(f"dataset: {len(rows)} examples | sha256:{data_hash}", flush=True)
try:
    import transformers, trl, torch
    print(f"versions: torch={torch.__version__} transformers={transformers.__version__} trl={trl.__version__}", flush=True)
except Exception:
    pass

# ---- Render the whole dataset BEFORE loading the model. A chat-template
# error must fail in seconds, not after minutes of model download. ----
from transformers import AutoTokenizer
tokenizer = AutoTokenizer.from_pretrained(BASE)


def to_text(ex):
    thinking = None
    msgs = []
    for m in ex["messages"]:
        # HF datasets unifies the schema across rows, so messages inherit
        # keys they never had with value None (e.g. every message gets
        # tool_calls=None once any example has tool calls). The harmony
        # template tests key presence, not value, so those Nones crash it.
        m = {k: v for k, v in dict(m).items() if v is not None}
        t = m.pop("thinking", None)
        if t:
            thinking = t
        msgs.append(m)
    # The harmony template injects a model_identity line that defaults to
    # "You are ChatGPT...". r5 inherited that in all 2,267 examples, so 74
    # identity examples were arguing with the system prompt and losing.
    # Train under the identity we actually ship in the GGUF's template.
    text = tokenizer.apply_chat_template(
        msgs, tools=ex.get("tools") or None, tokenize=False, add_generation_prompt=False,
        model_identity=MODEL_IDENTITY,
    )
    # Safety net: ensure assistant turns carry a channel marker. Training
    # without it teaches the model to skip <|channel|>final, which breaks the
    # output parser in stock llama.cpp/Ollama (r1 lesson).
    text = text.replace("<|start|>assistant<|message|>", "<|start|>assistant<|channel|>final<|message|>")
    # Mechanically-verified reasoning traces train the analysis channel too
    # (r2 lesson: final-answer-only SFT suppresses the reasoning channel).
    if thinking and "<|channel|>analysis<|message|>" not in text:
        text = text.replace(
            "<|start|>assistant<|channel|>final<|message|>",
            f"<|start|>assistant<|channel|>analysis<|message|>{thinking}<|end|>"
            "<|start|>assistant<|channel|>final<|message|>",
            1,
        )
    return text


texts = []
for i, ex in enumerate(rows):
    try:
        texts.append(to_text(ex))
    except Exception as e:
        raise SystemExit(f"RENDER FAILED at example {i}: {type(e).__name__}: {e}\n{json.dumps(ex)[:600]}")

tool_samples = [t for t in texts if "functions.graph_get" in t]
think_samples = [t for t in texts if "<|channel|>analysis<|message|>" in t]
print(f"rendered {len(texts)} examples | {len(tool_samples)} with tool calls | {len(think_samples)} with reasoning", flush=True)
if tool_samples:
    print("TOOL SAMPLE:", tool_samples[0][:500].replace("\n", " | "), flush=True)

# ---- Now load the model. ----
from datasets import Dataset
from unsloth import FastLanguageModel

model, tokenizer = FastLanguageModel.from_pretrained(BASE, max_seq_length=MAX_SEQ, load_in_4bit=True)
model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    lora_alpha=32,
    lora_dropout=0.0,
    bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth",
    random_state=42,
)

ds = Dataset.from_dict({"text": texts}).shuffle(seed=42)

from trl import SFTConfig, SFTTrainer

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=ds,
    args=SFTConfig(
        dataset_text_field="text",
        max_seq_length=MAX_SEQ,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        num_train_epochs=1.5,
        learning_rate=1e-4,
        lr_scheduler_type="cosine",
        warmup_steps=10,
        logging_steps=10,
        optim="adamw_8bit",
        weight_decay=0.01,
        seed=42,
        output_dir="/workspace/out/checkpoints",
        save_strategy="steps",
        save_steps=150,
        save_total_limit=3,
        report_to="none",
        bf16=True,
    ),
)

try:
    from unsloth.chat_templates import train_on_responses_only
    trainer = train_on_responses_only(
        trainer,
        instruction_part="<|start|>user<|message|>",
        response_part="<|start|>assistant",
    )
    print("loss masked to assistant turns", flush=True)
except Exception as e:
    # Silently training on full sequences wastes the whole run learning user
    # prompts and tool outputs. Fail loudly instead of burning GPU hours.
    raise SystemExit(f"ABORT: assistant-only loss masking failed ({e}). Fix before spending GPU.")

# Live-board heartbeat for training.openadminos.com. Inert unless the pod
# sets TRAINING_STATE_TOKEN and TRAINING_RUN_ID. Stdlib only, 5s timeout,
# every exception swallowed: reporting can never touch the run itself.
import os

if os.environ.get("TRAINING_STATE_TOKEN") and os.environ.get("TRAINING_RUN_ID"):
    import time as _hb_time
    import urllib.request as _hb_rq
    from transformers import TrainerCallback as _HbBase

    class _Heartbeat(_HbBase):
        def __init__(self):
            self._last = 0.0

        def on_log(self, args, state, control, logs=None, **kwargs):
            now = _hb_time.time()
            if now - self._last < 300:
                return
            self._last = now
            try:
                detail = f"step {state.global_step:,}/{state.max_steps:,}"
                loss = (logs or {}).get("loss")
                if loss is not None:
                    detail += f" · loss {loss:.2f}"
                body = json.dumps({
                    "run": os.environ["TRAINING_RUN_ID"],
                    "stage": "train",
                    "detail": detail,
                }).encode()
                req = _hb_rq.Request(
                    os.environ.get(
                        "TRAINING_STATE_URL",
                        "https://training.openadminos.com/api/training/run-state",
                    ),
                    data=body,
                    method="POST",
                    headers={
                        "Authorization": "Bearer " + os.environ["TRAINING_STATE_TOKEN"],
                        "Content-Type": "application/json",
                    },
                )
                _hb_rq.urlopen(req, timeout=5).close()
            except Exception:
                pass

    trainer.add_callback(_Heartbeat())
    print("live heartbeat enabled", flush=True)

print(trainer.train(), flush=True)

model.save_pretrained("/workspace/out/adapter")
tokenizer.save_pretrained("/workspace/out/adapter")
print("adapter saved", flush=True)

model.save_pretrained_merged("/workspace/out/merged", tokenizer, save_method="merged_16bit")
print("merged bf16 saved", flush=True)
