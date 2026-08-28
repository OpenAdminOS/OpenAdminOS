# Brief: training.openadminos.com

Hand this file to the thread building the site. It is the complete context;
that thread does not need to read the training pipeline's code.

## What this site is

A public, honest record of how the OpenAdmin model is built and how well it
performs. The pitch is "trained in public": the dataset, the eval suite, the
scores and the failures are all visible. It is a trust artifact first and a
marketing page second, so **it must never overstate**.

## The one integration point

The pipeline emits **`site/public-data.json`** (schemaVersion 1). The site
reads that file and renders it. Nothing else. Regenerate it with
`node site/export-public-data.mjs` from `~/oaos-model-pipeline`.

Publish flow (suggested): the pipeline copies `public-data.json` into the
web project's `public/` (or posts it to an API route) whenever an eval run
finishes; the site is otherwise static.

## What is in public-data.json

| Key | Contents |
|---|---|
| `model` | name, base model, license, HF/Ollama URLs, released version, file size |
| `hardware` | measured tokens/sec and RAM guidance, and the exact machine measured on |
| `retrieval` | doc-index chunk count, corpora, build time, source + licence |
| `trainingData` | per-track example counts, total, and the data policy statement |
| `evalSuites` | frozen suites with task counts and sha256 hashes |
| `taskCategories` | the nine categories and what each one tests |
| `trainingRuns` | per-run log: what it trained on, outcome, lesson learned |
| `scores` | every scored run: label, passed/total, per-category breakdown, retrieval on/off, suite |

## Pages worth building

1. **Overview** — what OpenAdmin is, current released version, install one-liners
   (`ollama run openadminos/openadmin`, HF links), hardware requirements.
2. **Benchmarks** — the per-category comparison across checkpoints. Grouped bars
   per category, one series per model. Must state the suite name and hash, and
   whether retrieval was on.
3. **Training runs** — a timeline of r1, r2, ... with what each trained on, the
   outcome, and the lesson. The failures are the most interesting content here;
   keep them.
4. **How it is built** — the retrieval-first architecture (facts from the docs
   index at query time, the fine-tune only for behaviour/format/tool use), the
   synthetic machine-validated data policy, the mechanical scoring.
5. **Downloads** — links to the HF model, GGUF, dataset and eval repos.

## Hard rules (these are trust claims, not copy)

- **Never quote a score without its suite.** Scores from different suites are not
  comparable; every score in the JSON carries its `suite`. An early 108-task
  headline of 89% became a tie on a broader 200-task suite, which is exactly the
  kind of thing this site exists to be honest about.
- **State the retrieval condition.** "With retrieval" is the product
  configuration; "without" is a different number.
- **Do not imply a version exists before it ships.** Only `model.releasedVersion`
  is public. Internal runs (r5, r6, ...) are experiments and may be shown as
  history, but must not be presented as available downloads.
- **Voice**: plain, factual, slightly dry. No exclamation marks, no hype
  adjectives, no "revolutionary". Admins are professionals.
- **No tenant data, ever.** Everything published is synthetic or public docs.

## Design reference

`~/oaos-model-pipeline/dashboard.html` is a working internal prototype of the
benchmark and run-log views (dark theme, grouped bars, colourblind-validated
palette). Treat it as a reference for *content structure*, not final visual
design; the public site should follow the OpenAdminOS design system in
`docs/mockups/_design.css`.

## Status at time of writing (2026-08-28)

- **v1 is published** (HF + Ollama) and is checkpoint r4.
- r5 and r6 are internal experiments; r5 was **held** on review rather than
  shipped, and that decision is documented in `trainingRuns`.
- A small-model tier for 8GB machines is under evaluation and **not decided**.
