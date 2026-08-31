# OpenAdmin model pipeline

Part of the OpenAdminOS monorepo. The eval harness validates agent manifests
against `../schemas/agent-template.schema.json`, the same canonical schema the
desktop app enforces, so the benchmark cannot drift from the product.

The training and evaluation pipeline behind [OpenAdmin](https://huggingface.co/OpenAdminOS/openadmin-20b),
an open-source model for Microsoft 365 administrators, built by
[OpenAdminOS](https://openadminos.com).

Everything here is public on purpose: the data generator, the eval suite, the
scored results, and the run log including the runs that failed. If you want to
check our benchmark numbers, you can rebuild the index and rerun them.

## How the model works

Two separate mechanisms, deliberately:

- **Facts come from retrieval.** A local index over Microsoft Learn
  documentation (Intune, Entra, Defender — CC-BY-4.0) is searched at query
  time and the relevant passages are put in the prompt. Documentation changes
  monthly; weights do not. This is why the model can answer about features
  released after its training cutoff.
- **Skills come from fine-tuning.** The LoRA teaches formats, tool use,
  fleet reasoning, abstention and safety behaviour — the things that do not
  change when Microsoft ships a new feature.

Both matter. On our frozen 200-task suite the base model scores 141 with
retrieval and 115 without; our checkpoints move the retrieval number, not the
architecture.

## Training data policy

All training data is **synthetic and machine-validated before admission**:

- agent manifests are validated against the product's canonical JSON schema
- Graph call plans come from a curated endpoint table
- fleet-reasoning examples carry reasoning traces computed by the generator,
  so the arithmetic is correct by construction
- retrieval QA is checked against the source passage

No tenant data. No scraped conversations. No distillation from proprietary
model APIs. The full dataset is published at
[OpenAdminOS/openadmin-sft](https://huggingface.co/datasets/OpenAdminOS/openadmin-sft).

## Evaluation

Tasks are scored **mechanically** — schema validation, exact match, regex
constraints, tool-call verification. No LLM judges.

Suites are frozen and hashed (`eval/suites/`) because scores from different
suites are not comparable; we learned that the hard way when an 89% headline
on a narrow 108-task suite became a tie on a broader 200-task one. A sealed
holdout (`eval/holdout/`) is scored only at release.

Agentic tasks give the model a `graph_get` tool and serve fixture tenant data;
a task answered without a successful tool call fails even if the words look
right.

```
node eval/run-eval.mjs --suite suite-200 --label my-run     # score a model
node eval/rescore.mjs my-run                                 # re-score saved responses
node eval/build-dashboard.mjs                                # regenerate dashboard.html
node data/generator/generate.mjs --tracks abdefgh            # regenerate training data
```

## Layout

| Path | What |
|---|---|
| `data/generator/` | synthetic training-data generator (8 tracks) |
| `eval/` | harness, scorers, 248 tasks, frozen suites, sealed holdout, results |
| `train/` | QLoRA training script and pod pipeline scripts |
| `PLAN-next.md` | roadmap, revised after adversarial review |
| `eval/runs.json` | what every training run contained, its outcome, and the lesson |

Large artifacts are not in git: models come from Hugging Face, and the
retrieval index rebuilds from the public doc repositories in ~35 minutes.

## Licence

Apache 2.0, matching the base model. Microsoft, Intune, Entra and Defender are
trademarks of Microsoft Corporation; this project is not affiliated with or
endorsed by Microsoft or OpenAI.
