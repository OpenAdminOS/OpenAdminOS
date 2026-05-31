# Sign-in failure explainer

Read-only investigator. Pulls the last 200 sign-in failures, groups
them by error code, app, user, client app, Conditional Access status,
and sign-in risk signals, then asks the LLM to cluster them by likely
root cause with a triage suggestion per cluster.

## Why this earns its keep

Sign-in logs are useful and overwhelming in equal measure. The
question isn't "what failed" — it's "what should I do about it." The
LLM clusters by *cause* (often combining several error codes into one
root cause like "CA policy requires compliant device") and recommends
the triage step. Two hundred raw entries become three actionable
clusters.

## Required Graph permissions

- `AuditLog.Read.All`

## Result shape

```jsonc
{
  "total": 187,
  "byError": { "50126": 92, "53003": 41, "50053": 28, ... },
  "byApp": { "Office 365": 88, "Teams": 41, ... },
  "byUser": { "<user-principal-name>": 12, ... },
  "byClientApp": { "Browser": 120, "Mobile Apps and Desktop clients": 41 },
  "byConditionalAccessStatus": { "failure": 77, "notApplied": 32 },
  "byRiskDuringSignIn": { "none": 150, "medium": 8 },
  "recentSample": [{ "userPrincipalName": "<user-principal-name>", "status": { "errorCode": 53003 } }],
  "llmModel": "llama3.1:8b"
}
```

## Caveats

- Window is the last 200 failures (the Graph `signIns` endpoint
  doesn't honour a clean time-window filter, so we cap by count).
- The LLM is conservative about claiming compromise. If you suspect
  account compromise, also run `risky-sign-in-triage`, which reads
  Entra risky-user records from Identity Protection.
- This is a *clustering* agent, not a *root-cause-by-user* agent. To
  investigate a specific user, file a follow-up that takes the UPN as
  a per-run input (deferred, needs a small UX change to support
  per-run prompts).
