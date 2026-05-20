# Sign-in failure explainer

Read-only investigator. Pulls the last 200 sign-in failures, groups
them by error code, app, and user, and asks the LLM to cluster them by
likely root cause with a triage suggestion per cluster.

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
  "byUser": { "user1@tenant.com": 12, ... },
  "llmModel": "llama3.1:8b"
}
```

## Caveats

- Window is the last 200 failures (the Graph `signIns` endpoint
  doesn't honour a clean time-window filter, so we cap by count).
- The LLM is conservative about claiming compromise. If you suspect
  attack, also run `risky-sign-in-triage`, which looks at
  `signIn.riskLevelDuringSignIn` specifically.
- This is a *clustering* agent, not a *root-cause-by-user* agent. To
  investigate a specific user, file a follow-up that takes the UPN as
  a per-run input (deferred, needs a small UX change to support
  per-run prompts).
