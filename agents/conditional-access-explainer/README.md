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
  "byModifiedAge": { "not modified in 2y+": ["Legacy VPN MFA"], "not modified in 1y+": [] },
  "policies": [{ "name": "Require MFA for administrators", "state": "enabled", "modifiedDaysAgo": 40, "users": { "include": { "roles": ["Global Administrator"] }, "exclude": { "users": "2 users" } }, "apps": { "include": "All" }, "grant": { "controls": ["mfa"] } }],
  "llmModel": "llama3.1:8b"
}
```

The narrative lives in `summary`. It follows the report shape `Summary`,
`Recommended changes`, `Coverage`, `Gaps and conflicts`, and `What the
policies do`, naming at most three policies per bullet so the report fits its
answer budget.

## Prompt size

The model never sees the raw Graph policy objects. Each policy becomes one
compact record (`policies` above): scope as counts or `All`, built-in role
names, client app types, platforms, locations, risk levels, grant controls,
authentication strength and session controls. Age groups list names only.
A typical set of about 100 policies fits a 16k context local model with room for the answer. A larger or denser set stops before anything is sent, with the token numbers and the ways out.
When a tenant's policy set is larger than the selected model's context, the
run stops before sending and says how much context it needs. For Ollama that
limit is the `num_ctx` pinned in the model's Modelfile (16,384 for OpenAdmin
8B), or the model's maximum when none is pinned.

## Caveats

- The LLM is instructed not to invent policies; it only reads the
  records it is given.
- This is an *advisor*, not a *simulator*. It will not tell you whether
  a specific user can sign in tomorrow. For that, use the live "What
  if" tool in Entra. It will tell you which policies in your set are
  the ones that decision depends on.
- Report-only and disabled policies are treated as not enforcing
  protection. The report can still call them useful candidates for
  promotion.
- The report can only reason from the policy records. It does not know
  group membership, named location definitions, or real sign-in traffic.
- Best run on a tenant with a stable policy set. Re-running after every
  policy change is fine but probably overkill.
