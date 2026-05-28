# user-license-overview

A read-mode dashboard agent for Microsoft 365 licensing hygiene. It
does not calculate product entitlement or cost. It checks user-level
readiness signals that commonly block clean licensing work: usage
location, account state, user type, and assigned-license presence.

## Pipeline

1. **Load users** — `GET /users` with usage location, account state,
   user type, and assigned-license fields.
2. **Group by usage location** — includes an `(unset)` bucket.
3. **Count account state and user type** — separates disabled accounts
   and guest/member populations.
4. **Summarise** — compact licensing-readiness report with practical
   cleanup steps.

## Result

```json
{
  "total": 250,
  "byAccountEnabled": { "true": 220, "false": 30 },
  "byUserType": { "Member": 190, "Guest": 60 },
  "usageLocationBuckets": { "DE": [{ "userPrincipalName": "..." }], "(unset)": [] },
  "llmSummary": "...",
  "llmModel": "llama3.1:8b"
}
```

## Scopes

- `User.Read.All`

## Caveats

- This agent does not name license SKUs or optimize spend. That needs
  `/subscribedSkus` and license assignment details in a future agent.
- Usage location is the main readiness signal here; unset locations
  should be corrected before assigning many Microsoft 365 licenses.
