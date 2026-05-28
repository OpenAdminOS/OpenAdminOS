# Conditional Access explainer

Read-only advisor. Loads every Conditional Access policy in the tenant
and produces a posture readout: what is covered, what is only
partially covered, where policies interact in surprising ways, and
which disabled/report-only controls or exclusions need review.

## Why this earns its keep

CA policy interaction is the #1 thing that breaks unexpectedly in
Entra. Twenty policies with overlapping conditions, exclusions in one
not mirrored in another, the long-tail "what does my posture actually
look like" question that requires reading every JSON blob. This is the
exact shape of work an LLM is good at and a PowerShell script can't
express.

The output is not a formal simulator (we don't enumerate user × app ×
device permutations). It's a senior consultant reading the policy set
and telling you what to look at: admin MFA, all-user MFA, legacy auth,
device compliance, guest access, risky sign-ins/users, session
controls, stale policies, and broad exclusions.

## Required Graph permissions

- `Policy.Read.All`

## Result shape

```jsonc
{
  "total": 14,
  "byState": { "enabled": 11, "enabledForReportingButNotEnforced": 2, "disabled": 1 },
  "byGrantOperator": { "OR": 7, "AND": 2, "(no grant controls)": 1 },
  "byClientApps": { "all": 8, "browser,mobileAppsAndDesktopClients": 3 },
  "bySignInRisk": { "(none)": 11, "high,medium": 2 },
  "byUserRisk": { "(none)": 12, "high": 1 },
  "byModifiedAge": { "not modified in 2y+": [...], "not modified in 1y+": [...] },
  "llmModel": "llama3.1:8b"
}
```

The narrative lives in `summary`. It follows the report shape `Main
finding`, `Coverage map`, `Interactions to watch`, `Gaps and stale
controls`, and `Next action`.

## Caveats

- The LLM is instructed not to invent policies; it only reads the JSON
  it is given.
- This is an *advisor*, not a *simulator*. It will not tell you whether
  a specific user can sign in tomorrow — for that, use the live "What
  if" tool in Entra. It will tell you which policies in your set are
  the ones that decision depends on.
- Report-only and disabled policies are treated as not enforcing
  protection. The report can still call them useful candidates for
  promotion.
- The report can only reason from policy JSON. It does not know group
  membership, named location definitions, or real sign-in traffic.
- Best run on a tenant with a stable policy set. Re-running after every
  policy change is fine but probably overkill.
