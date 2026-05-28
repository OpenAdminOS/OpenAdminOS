# Secure Score prioritizer

Read-only advisor. Reads Microsoft Secure Score control profiles,
breaks them down by category, action type, implementation cost, user
impact, and max-score upside, then asks the LLM to pick the first
controls an admin should review.

## Why this earns its keep

The Secure Score portal lists controls but does not automatically tell
you which ones are low-friction, high-upside review targets for this
tenant. The agent keeps the deterministic parts visible, then uses the
LLM to turn profile metadata into a practical review order.

## Required Graph permissions

- `SecurityEvents.Read.All`

## Result shape

```jsonc
{
  "total": 187,
  "byCategory": { "Identity": 64, "Apps": 41, "Data": 38, "Device": 44 },
  "byImplementationCost": { "low": 73, "moderate": 62, "high": 18 },
  "byUserImpact": { "low": 80, "moderate": 38, "high": 16 },
  "topScoreUpside": [{ "title": "Require MFA for admins", "maxScore": 10 }],
  "llmModel": "llama3.1:8b"
}
```

The prioritised list lives in `summary`. The structured `data` block
shows the breakdown by category on the result page.

## Caveats

- This agent reads `secureScoreControlProfiles` (control metadata), not
  `secureScores` (point-in-time tenant score). It recommends what to
  review first; it does not claim a control is unimplemented unless
  that evidence is added by a future live-score step.
- Pricing/effort guidance is qualitative. Treat it as a starting point,
  not a procurement decision.
