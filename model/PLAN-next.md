# OpenAdmin model roadmap (rev 2, after adversarial review)

Rev 1 was reviewed by GPT-5.6 (Codex). It found five substantive problems with
that plan; this revision incorporates them. Where the reviewer and the original
plan disagreed, the reviewer's position is adopted unless noted.

## 1. Versioning

Three-part semver, matching the desktop app. Numbers are earned, not spent.

| Level | Moves when | Example |
|---|---|---|
| **patch** `v1.1.1` | same capabilities, better execution | cleaner data, better hyperparameters, a fixed defect |
| **minor** `v1.2` | a capability the previous version did not have | agentic tool use; **write-confirmation behaviour**; a second domain |
| **major** `v2` | new base model or breaking change | moving off gpt-oss-20b |

Internal runs keep their own counter (`r5`, `r6`, …). A run is called by its
`r` number until it passes the gate; only then does it receive a version.
(Review note taken: r5 is a *candidate*, not "v1.1", until it clears the bar.)

## 2. What the review changed

1. **Our agentic eval mostly measures template interpolation.** 60 trajectory
   tasks are generated from 4 semantic templates, 3 of which mirror the
   training templates. Different device names are not a distribution shift, so
   the effective eval size is closer to 4 than 60. Eval families must be
   authored independently of training families.
2. **Some "model problems" belong in runtime code, not in weights.** Retrying a
   429, honouring `Retry-After`, and walking `@odata.nextLink` are the Graph
   client's job. The model's job is to judge whether the data it got supports
   an answer, and to stop honestly when it does not. Rev 1 wanted to train all
   of that into the model: wasteful and fragile.
3. **"Machine-validated" is currently mostly *syntactic*.** The manifest scorer
   accepts any schema-valid manifest, even one ignoring the request; track C
   picks a number from a doc, has an LLM invent a question, and emits the number
   as truth without checking entailment. That is synthetic label noise, and it
   is unusable as an RLVR reward.
4. **The data mix is skewed.** By assistant-loss tokens, manifests are ~72% of
   the training budget while manifest accuracy has been flat at ~75% since r1.
   Rebalance rather than pile on.
5. **The pipeline has silent failure modes.** `train.py` falls back to
   full-sequence loss if masking fails (it should abort), keeps no per-epoch
   checkpoints (free model selection discarded), and pins no dependency or data
   hashes.

## 3. Order of work, by gain per GPU dollar

### Phase 0 — zero GPU cost (do first)
1. **Freeze and hash the eval suite**; record task-content, schema, and
   generator hashes in run provenance. Re-score base, r4, r5 on the frozen set.
2. **Repair the scorers so they check semantics, not tokens.** Manifests must
   match the *requested* slug, endpoint, scope, and pipeline shape. Trajectory
   scoring must consider all calls made, not just that one resolved.
3. **Define the production `graph_get` tool contract** (status codes, headers,
   query params, opaque nextLink) *before* generating any data against it, so
   training and the product speak the same protocol.
4. **Move pagination, retry/backoff and routine counting into the runtime.**
5. **Design a sealed holdout** (~50 tasks) authored from independent families,
   never inspected during development, scored only at release.

### Phase 1 — data diversity (v1.1.1)
6. **25-40 genuinely distinct scenario families**, not renamed fixtures:
   multi-turn follow-ups, missing evidence, partial errors, over-fetching,
   premature answers, prompt injection in tenant data, relational fixtures with
   real join keys. Paraphrase families and fixture families held out separately.
7. **Rebalance by assistant-loss tokens**, capping manifest dominance.
8. **Per-epoch checkpoints + a development split**, then pick the best epoch.
   (r3→r4 gained ten tasks from hyperparameters alone; checkpoint selection is
   likely cheaper than changing optimization families.)

### Phase 2 — one controlled run (v1.1.2)
9. Change exactly one variable (learning rate or track weights) based on
   development-split failures.
10. **Validator-selected SFT / rejection sampling**: sample several completions
    on *training-only* prompts, keep the semantically valid ones. Simpler than
    RL and uses the infrastructure we already have.

### Phase 3 — capability additions (v1.2)
11. **Write-mode agents with confirmation semantics** — new capability, so it
    earns a minor bump: typed confirmation, blast-radius statements, dry runs,
    irreversible-action warnings, refusal to self-approve.
12. **DPO**, only if needed, and only from training-only preference pairs.
    (Rev 1 proposed harvesting pairs from eval runs: rejected, it contaminates
    the benchmark.)

### Deferred, with reasons
- **RLVR/GRPO** — premature while manifest and safety rewards are gameable;
  sparse exact-match rewards would optimise scorer quirks.
- **Continued pretraining on the Learn corpus** — defer until a closed-book
  eval shows a product need; raw-doc CPT does not specifically teach *use* of
  retrieved passages and risks baking in stale documentation.
- **Bigger track C harvest** — r4 missed only one of 38 harvested fact tasks;
  retrieval use is not the bottleneck.
- **Repeated seeds at temperature 0** — measure prompt/fixture robustness and
  paired bootstrap across families instead.
- **Auto-correcting after `resourceNotFound`** — teaching the model to guess
  another endpoint is dangerous; it should read the structured error and stop.

## 4. Release gate (unchanged in spirit, stricter in practice)

A run ships only if it beats the incumbent on the frozen suite, regresses no
category (macro-average by category and scenario family, not just overall),
passes identity and safety checks, works in stock llama.cpp/Ollama with no
custom template, and clears the sealed holdout.

## 5. Identity: root cause found (r5)

r5 still answers "I'm ChatGPT" despite 74 identity training examples. The cause
is structural, not a shortage of examples: the harmony chat template injects a
system line that defaults to

    "You are ChatGPT, a large language model trained by OpenAI."

(chat_template.jinja line 199). Every one of the 2,267 training examples was
rendered with that string in the system position, so the model saw "you are
ChatGPT" 2,267 times and "I am OpenAdmin" 74 times. The identity examples were
arguing with the system prompt and losing.

The template exposes a `model_identity` variable. The fix for the next run is
to make training and inference agree:

1. Render training with `model_identity="You are OpenAdmin, an open-source
   model for Microsoft 365 administration, fine-tuned from gpt-oss-20b."`
2. Patch the same default into the chat template embedded in the released GGUF,
   so inference uses the identity the model was trained under.

Both are one-line changes and cost no extra GPU time. Worth testing on the
existing r5 GGUF first (patch the embedded template only) to see how much of
the identity gap closes without retraining.

## 6. r5 verdict: HELD (2026-08-27)

Reviewed by GPT-5.6 and held. r5 is the best model we have on the product's
real configuration (suite-200 with retrieval: 153, vs v1 142 and base 141) and
it repaired the agentic collapse that made v1 a tie. It is still not
release-ready:

- Regressions vs v1: doc facts -4, Graph planning -2, abstention -1.
- 15 points worse without retrieval (robustness warning, not a blocker, since
  the product always runs retrieval).
- On 48 independently-authored trajectory families it scores 34/48, with two
  specific holes: **cross-resource joins 1/6** and **wrong-resource/error
  handling 0/6**. Both are core agentic behaviours.
- No sealed holdout exists yet.

Already fixed since the review: identity, which reached 11/12 by patching the
shipped chat template's `model_identity` default (no retraining).

r6 must therefore add: join trajectories, error/wrong-resource trajectories,
the existing but unused safety track (G), the identity template baked in, and
a rebalanced token mix that caps manifest dominance. The sealed holdout must
exist before r6 is judged.
