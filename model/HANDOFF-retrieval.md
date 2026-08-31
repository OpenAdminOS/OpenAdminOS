# Handoff: ship retrieval in the desktop app

This is a self-contained brief for a separate thread. The model-training thread
does not touch app code; this work does not touch the training pipeline.

## Why this matters

The published models answer from weights alone today. Retrieval is what makes
them current, and it is not shipped. Measured on our frozen 200-task suite,
same weights, retrieval on versus off:

| model | without retrieval | with retrieval |
|---|---|---|
| OpenAdmin 20B (r9) | 129 / 200 | 162 / 200 |
| OpenAdmin Lite 8B (r1) | 117 / 200 | 150 / 200 |

So a user who runs `ollama run openadminos/openadmin` today gets roughly 33
tasks' worth less than the model is capable of, and gets nothing about features
Microsoft shipped after the base model's cutoff.

**Retrieval is model-agnostic.** The index knows nothing about which model
consumes the prompt, so this work also improves the Anthropic, OpenAI and Azure
OpenAI provider paths, not only our own checkpoints. It is infrastructure.

## Embedding vs retrieval

They are often used interchangeably; they are not the same thing, and the
distinction matters when scoping this work.

**Embedding** turns text into a vector that captures its meaning, so similar
text lands near similar text. It happens twice here: once offline, to convert
55,193 documentation chunks into the index, and once per question at runtime,
to convert the question into a comparable vector.

**Retrieval** is the whole process that uses embedding: embed the question,
compare it against the index, take the closest chunks, prepend them to the
prompt. Embedding is one step inside it.

The task is "build retrieval". The embedding model is a component you need in
order to do that.

## What retrieval does, precisely

1. Embed the user's question into a 768-dimension vector.
2. Cosine-compare it against every chunk vector in the index.
3. Take the top k (we use k=12) and prepend those passages to the prompt.
4. Call the model as normal.

The model then answers from text placed in front of it rather than from memory.

## The three pieces to ship

| piece | size | where it is now |
|---|---|---|
| embedding model (`nomic-embed-text-v1.5`, Q8_0 GGUF, 768-dim) | 140 MB | Hugging Face |
| doc index (55,193 chunks: Intune, Entra, Defender, CC-BY-4.0) | 263 MB | rebuildable, see below |
| retrieval code | ~54 lines | `model/eval/retrieve.mjs` — port this |

**The index and the embedding model are a matched pair.** The index stores
vectors produced by one specific embedding model; a different model produces a
different vector space, and comparisons against it are meaningless. Changing
the embedding model means rebuilding the index. Version them together.

`model/eval/retrieve.mjs` is the reference implementation and is deliberately
small. Read it first; the app version should behave identically so that what
users get matches what we benchmark.

## Suggested approach

- **Serving the embedding model.** The app already manages a local model
  runtime for chat. The same runtime serves embeddings on a second port
  (`--embedding --port 8091`). Reuse it rather than adding a dependency.
- **Shipping the index.** 263 MB is too large to bundle in an installer that
  also carries a model. Prefer a first-run download with a progress state, and
  treat a missing index as a designed state, not an error: the app should still
  work, while saying plainly that answers are not documentation-grounded yet.
- **Refresh.** The index rebuilds from the public MicrosoftDocs repositories in
  about 35 minutes. Documentation changes monthly; a stale index is the whole
  problem we are trying to avoid. Ship a refresh path and show the index date
  in the UI.
- **Honesty in the UI.** When retrieval is unavailable or returns nothing
  relevant, say so rather than letting the model answer unaided. The
  abstention behaviour we trained ("I can't find that in the supplied
  documentation") only works if the app actually supplies documentation.

## Constraints that are not negotiable

- The index is built from public documentation only. No tenant data, ever.
- Retrieval runs locally. Embedding a user's question must not call a remote
  service when a local provider is selected — that would break the trust
  guarantee the product is built on.
- Chunk provenance (source file path) must survive into the prompt so answers
  can cite where a fact came from.

## Definition of done

- A question with a known documentation answer is answered correctly with a
  citation, on a machine with no network access after first-run setup.
- A question about a feature that does not exist is declined rather than
  answered.
- The index date is visible, and a refresh can be triggered from the UI.
- Both bundled model tiers and at least one hosted provider path work with the
  same retrieval layer.

## Open question for whoever picks this up

The eval harness passes k=12 chunks (~6k tokens). That is tuned for the 20B.
The 8B tier may do better with fewer, higher-quality chunks; a reranking step
would help both tiers and would reduce prompt cost for hosted providers. Worth
measuring, not assuming.
