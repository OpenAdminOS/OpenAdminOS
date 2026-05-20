# Dormant app registrations

Read-only advisor. Loads the tenant's app registrations and asks the
LLM to cluster them by likely purpose (production, leftover from
migrations, vendor-installed, dev experiments, etc.) with a
keep/review/disable/delete recommendation per cluster.

## Why this earns its keep

App registrations accumulate. Every dev experiment, every vendor
trial, every migration project leaves a row in `/applications`. The
question "which ones are still load-bearing" requires looking at the
whole set, comparing display names and publishers and creation dates,
and noticing patterns. That's pattern matching across the full list —
exactly the LLM's strength.

The agent recommends action *per cluster*, not per app. A cluster of
30 "test-app-XX" registrations is one decision, not thirty.

## Required Graph permissions

- `Application.Read.All`

## Result shape

```jsonc
{
  "total": 187,
  "byAudience": { "AzureADMyOrg": 142, "AzureADMultipleOrgs": 31, ... },
  "llmModel": "llama3.1:8b"
}
```

The cluster analysis with recommendations is in `summary`.

## Caveats

- This is an *advisory* read. There's no write step; cleanup is a
  follow-up that the admin runs manually after reviewing the
  recommendations. A future companion write agent could take a
  cluster id and disable the members after typed confirmation.
- The LLM is biased to *keep* — destructive defaults are wrong for
  app registrations because removing a load-bearing app breaks
  production.
- For richer signal (last sign-in per app, credential rotation), pair
  with `secure-score-prioritizer` which surfaces the related controls.
