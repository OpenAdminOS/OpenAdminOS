# Conditional Access explainer

Read-only advisor. Loads every Conditional Access policy in the tenant
and produces a three-section readout: what each group of policies
protects, where policies interact in ways that may be surprising, and
the most prominent gaps relative to the Microsoft Zero Trust baseline.

## Why this earns its keep

CA policy interaction is the #1 thing that breaks unexpectedly in
Entra. Twenty policies with overlapping conditions, exclusions in one
not mirrored in another, the long-tail "what does my posture actually
look like" question that requires reading every JSON blob. This is the
exact shape of work an LLM is good at and a PowerShell script can't
express.

The output is not a formal simulator (we don't enumerate user × app ×
device permutations). It's a senior consultant reading the policy set
and telling you what to look at.

## Required Graph permissions

- `Policy.Read.All`

## Result shape

```jsonc
{
  "total": 14,
  "byState": { "enabled": 11, "enabledForReportingButNotEnforced": 2, "disabled": 1 },
  "llmModel": "llama3.1:8b"
}
```

The narrative lives in `summary`. The structured `data` block backs the
per-state pill row on the result page.

## Caveats

- The LLM is instructed not to invent policies; it only reads the JSON
  it is given.
- This is an *advisor*, not a *simulator*. It will not tell you whether
  a specific user can sign in tomorrow — for that, use the live "What
  if" tool in Entra. It will tell you which policies in your set are
  the ones that decision depends on.
- Best run on a tenant with a stable policy set. Re-running after every
  policy change is fine but probably overkill.
