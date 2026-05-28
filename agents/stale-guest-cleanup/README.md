# Stale guest cleanup

Write-mode investigator + cleaner. Loads enabled guest users, filters
to those whose last sign-in is older than the configured threshold,
caps the action list, asks the LLM for a one-line disable rationale per
guest, and disables them after typed confirmation.

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

1. Load enabled guests (up to 500).
2. Filter to those whose `signInActivity.lastSignInDateTime` is older
   than `inactiveDays` (default 90).
3. Sort by oldest sign-in and cap the write plan at 50 candidates.
4. For each candidate, the LLM
   produces a one-sentence rationale.
5. Plan + typed confirmation: `DISABLE N GUESTS`.
6. Apply: `PATCH /users/{id}` with `accountEnabled: false` per guest.

## Caveats

- The cleanup is *disable*, not *delete*. Reversible via the same
  endpoint with `accountEnabled: true`.
- `signInActivity` requires Entra ID P1 or higher. If Graph does not
  return sign-in timestamps, the age filter does not match those users;
  the agent will not disable them based on missing evidence.
- Cost and blast-radius cap: 50 disable actions per run, and every
  planned action gets a matching rationale.
