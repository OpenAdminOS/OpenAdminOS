# Secure Score prioritizer

Read-only advisor. Reads the tenant's full Secure Score control
catalogue and asks the LLM to pick the top five controls to prioritise,
with reasoning and rough effort estimates.

## Why this earns its keep

The Secure Score portal lists every recommendation but leaves the
ranking to you. That ranking — what's actually worth doing this
quarter, given your tenant's shape and the effort each control needs —
is exactly the judgment call a senior consultant makes and a script
can't. The LLM reads the full catalogue, applies tenant-aware
weighting, and returns a prioritised list with one-line rationale.

## Required Graph permissions

- `SecurityEvents.Read.All`

## Result shape

```jsonc
{
  "total": 187,
  "byCategory": { "Identity": 64, "Apps": 41, "Data": 38, "Device": 44 },
  "llmModel": "llama3.1:8b"
}
```

The prioritised list lives in `summary`. The structured `data` block
shows the breakdown by category on the result page.

## Caveats

- This agent reads `secureScoreControlProfiles` (the catalogue), not
  `secureScores` (your point-in-time score). The catalogue contains
  the full set of controls and their max scores; tenant-specific
  implementation status is layered on by the LLM from the control
  metadata. A future variant could also pull `secureScores` to refine
  recommendations against the live posture.
- Pricing/effort guidance is qualitative. Treat it as a starting point,
  not a procurement decision.
