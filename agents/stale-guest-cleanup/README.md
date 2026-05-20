# Stale guest cleanup

Write-mode investigator + cleaner. Loads every guest user, filters to
those that haven't signed in for 90+ days, asks the LLM for a one-line
disable rationale per guest, and disables them after typed
confirmation.

Supersedes `disable-inactive-guests` (deleted in the v0.2 cleanup) —
the new version adds the per-guest rationale, which makes the diff
modal something an admin can actually read and approve.

## Why this earns its keep

A script can find guests that haven't signed in. The judgment call
"should we disable this one or check first" is what makes the diff
worth a typed confirmation. The LLM produces a one-line rationale per
guest (or a "check this first" caveat) that the admin reads alongside
the proposed action.

## Required Graph permissions

- `User.Read.All` — read the guest list
- `AuditLog.Read.All` — read `signInActivity` on each user
- `User.ReadWrite.All` — apply the disable

## Pipeline

1. Load all guests (up to 500).
2. Filter to those whose `signInActivity.lastSignInDateTime` is 90+
   days ago (or absent, which usually means "never signed in").
3. For each candidate (up to 50 per run, cost-capped), the LLM
   produces a one-sentence rationale.
4. Plan + typed confirmation: `DISABLE N GUESTS`.
5. Apply: `PATCH /users/{id}` with `accountEnabled: false` per guest.

## Caveats

- The cleanup is *disable*, not *delete*. Reversible via the same
  endpoint with `accountEnabled: true`.
- `signInActivity` requires Entra ID P1 or higher. On tenants without
  P1, the field will be absent for all guests and the filter will
  match everyone — in that case, swap to filtering on
  `createdDateTime` instead.
- Cost cap of 50 LLM calls per run; remaining candidates are still in
  the disable plan, they just don't get a per-guest rationale.
