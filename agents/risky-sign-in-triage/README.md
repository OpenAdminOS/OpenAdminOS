# Risky sign-in triage

Read-only investigator. Reads Entra ID's risky-user list and classifies
each entry individually — one LLM call per user — as likely
false-positive, likely compromise, or unclear. The new `map` step
makes this possible: per-item reasoning with shared context.

## Why this earns its keep

Identity Protection flags risky users; humans triage them. That triage
is the bottleneck. The agent isn't replacing the analyst — it's
pre-classifying the obvious cases so the analyst spends their time on
the unclear ones. The structured per-item output (classification +
reasoning + recommended next step) can drive a queue in the Activity
page.

## Required Graph permissions

- `IdentityRiskyUser.Read.All`

## What's new under the hood

This agent uses the `map` step kind that landed alongside it. Each
risky user goes through its own LLM call inside the `do:` sub-pipeline.
The map step collects each call's output into an array, which the
summarising LLM step rolls up at the end.

## Result shape

```jsonc
{
  "total": 14,
  "byItem": [
    { "text": "classification: likely-false-positive\nreasoning: ...\nnext-step: dismiss", "model": "llama3.1:8b" },
    ...
  ],
  "llmModel": "llama3.1:8b"
}
```

The per-item LLM output is stored as a free-form text block today.
Structured parsing into `{ classification, reasoning, nextStep }` is a
follow-up — a small JSON-mode wrapper around the LLM step.

## Caveats

- Cost guard: `limit: 20` per run. Tenants with hundreds of risky
  events should consider raising the limit or scheduling smaller
  windows.
- Conservative by default: the model is told to fall back to
  `unclear-needs-review` rather than over-classify as compromise.
- The summary step rolls up the per-item outputs; if the LLM is
  unavailable, the structured `byItem` array is still populated by the
  graph + map steps (which short-circuit the inner LLM gracefully).
