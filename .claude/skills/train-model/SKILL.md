---
name: train-model
description: Run a fine-tuning run for the OpenAdmin model tiers (8B Ministral, 20B gpt-oss) on a rented RunPod GPU, from renting the pod through evaluation and the release decision. Invoke when starting, resuming, or deciding the outcome of a training run, when adding training data for these models, or when choosing whether a checkpoint ships. Not for the desktop app, retrieval, or the benchmark page.
---

# Train an OpenAdmin model tier

The commands live in `model/train/`. This file carries the things that are not
in the code: the ordering constraints, the gates, and the decisions that are
counter-intuitive and were each paid for with a wasted run.

Read `model/eval/runs.json` before starting. It records what every run
contained, its outcome, and its lesson.

## Before spending a cent on GPU

Run the consistency gate on the dataset:

```
node model/train/check-consistency.mjs <dataset.jsonl>
```

It checks tool-call shape uniformity, JSON plan key sets, held-out endpoint
contamination, base-model identity leaks, and a write-safety example floor. It
exists because these failures are invisible in a loss curve and only surface
after training, when the money is gone.

**Every one of these has actually happened:**

- **Two tool-call shapes in one dataset.** `{function, type}` and
  `{function, id, type}` both appeared; 51 of 60 trajectories failed to parse.
  One shape, enforced.
- **A contradictory key between tracks.** One track emitted `"scope"` where
  every other track emitted `"scopes"`. The model learned neither. When a
  category collapses, suspect contradictory supervision before concluding the
  capability belongs somewhere else.
- **A uniform string teaching a shortcut.** 159 examples all emitting
  "NOT IN DOCS" taught the model to say it everywhere; trajectories fell 49 to
  39. Vary the wording, and pair every abstention example with a matched
  counterfactual where the answer *is* present.
- **Replacing varied phrasings with identical copies.** Substituting 32
  identical identity examples for the varied set produced 12/30 on identity and
  answers like "I am a product of your imagination". Identity data must be
  additive: canonical *plus* varied, never canonical instead of varied.

## Running it

Rent an A40 (about $0.44/hr). Then, on the pod:

```
model/train/pod-run.sh <run-id> [--tier 8b|20b] [--from-adapter] [--skip-env]
```

One script for both tiers. `--tier 8b` uses `train-mini.py` and quantizes to
Q4_K_M; `--tier 20b` uses `train.py` and prefers `mxfp4_moe`. Stage markers go
to `/workspace/status-<run-id>`, and each stage skips work whose output already
exists, so a disconnected pod can be resumed rather than restarted.

**Constraints the script encodes, which you must not "simplify":**

- **Install every pip dependency first, pin CUDA torch last, then never pip
  again.** llama.cpp's convert requirements pull a CPU torch. A later pip
  silently swaps it back and the failure appears minutes into training as a
  missing CUDA.
- **Patch `tokenizer_class` before conversion.** Ministral ships
  `TokenizersBackend`, which `convert_hf_to_gguf.py` cannot resolve.
- **Assistant-only loss masking must succeed.** `train.py` aborts if it fails,
  deliberately: training on full sequences spends the whole run learning user
  prompts and tool output.
- **Mask `[TOOL_RESULTS]` spans out of the loss.** Mistral does not wrap tool
  results in `[INST]`, so without masking the model is trained to invent tool
  output, and emits tool calls without end.

## Before terminating the pod

**Verify the downloaded byte count against the pod.** A truncated GGUF looks
fine in a log; a 269 MB "GGUF" from an aborted transfer cost us r6 entirely.
Check the size, then terminate.

Terminating destroys the volume. Anything not downloaded is gone: r13, r14 and
r15 adapters were lost this way. Acceptable for rejected checkpoints, not for
a candidate.

## Evaluating

Score locally against a frozen suite. Do not re-score with a changed harness
and compare to an old number.

**Do not read the frozen suite at item level, repeatedly.** A suite you inspect
per-item after every run becomes a development set, and the score stops meaning
anything. Look at the aggregate; open individual items only when deciding a
release, and prefer a fresh generated suite when you need to look closely.

When a scorer disagrees with a correct answer, fix the scorer, not the model.
Several of ours only matched our own model's vocabulary: a regex expecting
`can't` failed on `can’t`, and a Graph scorer penalised a correct `/beta/`
path. Repairing those raised competitors' scores and was still right.

## The release decision

**A higher score does not win.** We shipped r16 at 150/162 over r14 at 154/162,
because three of r14's abstention answers invented default values and licence
requirements. Fabrication disqualifies a checkpoint regardless of score.

Hard gates, all of which must pass:

- zero fabrications on the invented-feature probes
- safety refusals intact, and refusing *for the right reason* — a refusal that
  says "I can't find that in the supplied data" to a request to wipe 200
  devices is safe and incoherent, and it failed the gate
- no knowledge-category collapse relative to the previous release
- beats the previous release on the frozen suite

Residual wobble that only appears without a system prompt is a deployment
problem, not a training problem. The shipped system prompt is part of the
release; fix it there before spending another run.

## After a release

Publish the GGUF, the model card and the system prompt; update
`model/eval/runs.json` with the run's outcome and its lesson; regenerate the
public benchmark contract with
`node model/site-benchmarks/export-benchmark-data.mjs` so the site reflects the
new numbers.

**Terminate the pod.** An idle A40 cost $11.78 doing nothing for 26 hours
because nobody checked. There is no notification.
