# Contributing to Open Agents

Thanks for your interest. This project is community-built and contributions are how it grows.

## Before you start

1. Read [`docs/SPEC.md`](docs/SPEC.md) — it's the source of truth for product decisions and architecture.
2. Read [`CLAUDE.md`](CLAUDE.md) — even if you're a human, it explains the operating principles for the codebase.
3. Open an issue before starting non-trivial work. We'd rather discuss approach early than reject a PR after you've spent hours.

## What kinds of contributions we want

- **Agent contributions** — new agents in the registry are the most direct way to help. See `docs/agent-sdk.md` (coming soon).
- **Bug reports and reproductions** — please include OS, Open Agents version, LLM provider, and a redacted log.
- **UX improvements** — referenced against the mockups in `docs/mockups/`.
- **Documentation** — especially scenarios we don't cover yet.
- **Translations** — German, Dutch, French are the priority languages after English.

## What we're cautious about

- **New external dependencies** — every dep is a supply-chain risk. Justify the addition.
- **Telemetry, analytics, "phone-home" features of any kind** — local-first is non-negotiable. Even opt-in telemetry needs a careful design discussion before it ships.
- **Wrappers around other AI products** — we provide an abstraction so users can swap providers. Don't lock in to one vendor.
- **"Smart" defaults that bypass the diff-confirmation flow** — every write operation gets human review. No exceptions.

## Code of conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Short version: be the kind of person you'd want to work with.

## Licensing

By contributing, you agree your contribution is licensed under the MIT License (the project's license).
