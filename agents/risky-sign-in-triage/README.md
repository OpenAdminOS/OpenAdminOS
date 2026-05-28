# Risky user triage

Read-only investigator. Reads Entra ID's risky-user list, builds a
batch-level risk breakdown, and classifies the most recently updated
records individually — one LLM call per user — as likely false-positive,
likely compromise, or unclear.

## Why this earns its keep

Identity Protection flags risky users; humans triage them. That triage
is the bottleneck. The agent is not replacing the analyst — it
pre-classifies obvious cases, separates active high-risk records from
dismissed/remediated ones, and calls out still-processing records that
should not be over-interpreted yet.

## Required Graph permissions

- `IdentityRiskyUser.Read.All`

This Microsoft Graph endpoint requires Microsoft Entra ID P2.

## Pipeline

1. **Load risky users** — `GET /identityProtection/riskyUsers` where `riskLevel ne 'none'`.
2. **Count by risk level** — low / medium / high.
3. **Count by risk state** — active, remediated, dismissed, confirmed compromised, and other returned states.
4. **Count by risk detail** — admin-confirmed, user-remediated, hidden, unknown, and other returned details.
5. **Count by processing status** — separates records still being processed by Identity Protection.
6. **Sort recent risky users** — takes the 20 most recently updated records for per-user LLM triage.
7. **Triage each user** — `map` runs one LLM call per selected record.
8. **Summarise** — compact report with main finding, highest-priority users, and next actions.

## Result shape

```jsonc
{
  "total": 14,
  "triaged": 14,
  "byRiskLevel": { "low": 2, "medium": 8, "high": 4 },
  "byRiskState": { "atRisk": 9, "remediated": 3, "dismissed": 2 },
  "byRiskDetail": { "none": 5, "adminConfirmedUserCompromised": 2, "userPassedMFADrivenByRiskBasedPolicy": 3 },
  "byProcessingStatus": { "false": 12, "true": 2 },
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

- Cost guard: the per-user LLM pass triages the 20 most recently
  updated risky users. The batch-level counts still cover up to the
  first 50 risky users returned by Graph.
- Conservative by default: the model is told to fall back to
  `unclear-needs-review` rather than over-classify as compromise.
- The agent reads risky users, not raw risky sign-in events. It should
  not claim a specific sign-in was malicious unless that evidence is
  supplied by a future risk-detection/sign-in correlation step.
