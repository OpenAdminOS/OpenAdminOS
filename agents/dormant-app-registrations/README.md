# Dormant app registrations

Read-only advisor. Loads the tenant's app registrations with
security-relevant metadata and asks the LLM to identify likely stale,
risky, or unclear review clusters. The report separates cleanup
candidates from apps that should not be deleted without owner
confirmation.

## Why this earns its keep

App registrations accumulate. Every dev experiment, every vendor
trial, every migration project leaves a row in `/applications`. The
question "which ones are still load-bearing" requires looking at the
whole set, comparing display names and publishers and creation dates,
and noticing patterns. That's pattern matching across the full list —
exactly the LLM's strength.

The agent recommends action *per cluster*, not per app. A cluster of
30 "test-app-XX" registrations is one decision, not thirty. It also
flags the evidence that matters before cleanup: external sign-in
audience, missing publisher domain, old creation date, credentials,
Graph permissions, redirect URIs, app roles, and exposed API scopes.

## Required Graph permissions

- `Application.Read.All`

## Result shape

```jsonc
{
  "total": 187,
  "byAudience": { "AzureADMyOrg": 142, "AzureADMultipleOrgs": 31, ... },
  "byPublisherDomain": { "contoso.com": 150, "(no publisher domain)": 12, ... },
  "byCreatedAge": { "created 3y+ ago": [...], "created 1y+ ago": [...] },
  "oldestApps": [{ "displayName": "legacy-sync", "createdDateTime": "..." }],
  "llmModel": "llama3.1:8b"
}
```

The cluster analysis with recommendations is in `summary`. It follows
the report shape `Main finding`, `Review first`, `Do not delete yet`,
`Missing data`, and `Next action`.

## Caveats

- This is an *advisory* read. There's no write step; cleanup is a
  follow-up that the admin runs manually after reviewing the
  recommendations. A future companion write agent could take a
  cluster id and disable the members after typed confirmation.
- The LLM is biased to *review* or *keep* — destructive defaults are
  wrong for app registrations because removing a load-bearing app
  breaks production.
- This run does not include app owners or service principal sign-in
  activity yet. Treat "delete" as "delete after owner confirmation",
  not as an automatic action.
