# Contributing to OpenAdminOS

Thanks for your interest. This project is community-built and contributions are how it grows.

## Before you start

1. Read [`docs/SPEC.md`](docs/SPEC.md) — it's the source of truth for product decisions and architecture.
2. Read [`CLAUDE.md`](CLAUDE.md) — even if you're a human, it explains the operating principles for the codebase.
3. Open an issue before starting non-trivial work. We'd rather discuss approach early than reject a PR after you've spent hours.

## What kinds of contributions we want

- **Agent contributions** — new agents in the registry are the most direct way to help. See `docs/agent-sdk.md` (coming soon).
- **Bug reports and reproductions** — please include OS, OpenAdminOS version, LLM provider, and a redacted log.
- **UX improvements** — referenced against the mockups in `docs/mockups/`.
- **Documentation** — especially scenarios we don't cover yet.
- **Translations** — German, Dutch, French are the priority languages after English.

## What we're cautious about

- **New external dependencies** — every dep is a supply-chain risk. Justify the addition.
- **Telemetry, analytics, "phone-home" features of any kind** — local-first is non-negotiable. Even opt-in telemetry needs a careful design discussion before it ships.
- **Wrappers around other AI products** — we provide an abstraction so users can swap providers. Don't lock in to one vendor.
- **"Smart" defaults that bypass the diff-confirmation flow** — every write operation gets human review. No exceptions.

## Agent contract

Every OpenAdminOS agent is **LLM-augmented by contract**. The manifest must include at least one `format: llm` step, and the run's `result.summary` must reference that step's output (e.g. `{{ summarize.output.text | default("Summary unavailable.") }}`). Deterministic templates that simply count records are not agents — they're queries. Reach for `Get-MgDeviceManagementManagedDevice | Group-Object` or similar PowerShell instead.

The runtime hard-fails any LLM step reached without a connected provider (no silent skips), and `npm run qa` includes a `uses-llm` check that fails any manifest without a `format: llm` step.

## Quality gate for agents

Every built-in agent declares its Graph contract in `manifest.json` under `graphOperations` (method, path, optional `select` fields). Before opening a PR for an agent change, run:

```
eval $(scripts/setup-qa.sh)
npm run qa
```

`scripts/setup-qa.sh` resolves the local Microsoft Graph knowledge index in this order:

1. `$MSGRAPH_SKILL_DIR` if it already points at a valid skill directory.
2. `~/.claude/skills/msgraph` if the skill is installed locally.
3. Otherwise, clones the skill into `.qa-cache/msgraph` (override via `$OPENAGENTS_QA_SKILL_REPO` and `$OPENAGENTS_QA_SKILL_REF`).

`npm run qa` then validates every agent manifest against the local Graph OpenAPI + docs indexes — no auth, no network. Failures block the gate; warnings are advisory. The gate covers:

- Every declared scope is a known Graph permission (catches typos).
- Every `graphOperations` entry resolves in the Graph OpenAPI index.
- Every declared scope is required by at least one declared operation (catches orphans), and every operation has a declared scope that satisfies its required permissions.
- Every `select` field exists on the operation's resource type.
- A best-effort lookup of curated samples backing each GET operation (warning when none found).
- Every agent includes at least one `format: llm` step (`uses-llm` check, hard fail).

The synthetic Graph fixture in `@openadminos/runtime` is also cross-checked against the real `managedDevice` schema. Adding a field to the fixture that doesn't exist on Graph fails the gate.

## Code of conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Short version: be the kind of person you'd want to work with.

## Licensing

By contributing, you agree your contribution is licensed under the MIT License (the project's license).
